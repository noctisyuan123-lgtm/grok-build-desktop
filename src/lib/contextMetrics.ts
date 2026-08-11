// Pure helpers + Tauri wrapper for live Grok session context occupancy.
// Occupancy comes from signals.json (not RunSnapshot.usage billing totals).
// Category breakdown is approximate (no local Grok 4.5 tokenizer).
import { invoke } from '@tauri-apps/api/core';
import type { ChatMessage } from '../app/types';
import { hasTauriRuntime } from './runtime';

/** Approximate category split; sums exactly to contextTokensUsed when present. */
export type ContextUsageBreakdown = {
  systemPrompt: number;
  rules: number;
  conversation: number;
  /** Residual: tool schemas / skills / MCP / subagents / protocol / estimate error. */
  toolsRuntime: number;
};

/** Wire shape returned by `get_session_context_metrics`. */
export type SessionContextMetrics = {
  available: boolean;
  sessionId: string;
  contextTokensUsed: number | null;
  contextWindowTokens: number | null;
  /** Percent 0–100 when known. */
  contextWindowUsage: number | null;
  compactionCount: number | null;
  totalTokensBeforeCompaction: number | null;
  turnCount: number | null;
  primaryModelId: string | null;
  autoCompactThresholdPercent: number | null;
  breakdown: ContextUsageBreakdown | null;
  /** True whenever breakdown is present — category values are estimates. */
  breakdownApproximate: boolean;
  detail: string | null;
};

export type ContextUsageTone = 'neutral' | 'amber' | 'orange' | 'red' | 'empty';

export type ContextUsageViewState =
  | { kind: 'empty'; reason: 'no-session' | 'unavailable'; detail?: string }
  | { kind: 'error'; message: string }
  | { kind: 'ready'; metrics: SessionContextMetrics; percent: number; tone: ContextUsageTone }
  | { kind: 'loading'; sessionId: string | null };

/** Threshold bands for the ring stroke (product requirement). */
export const USAGE_THRESHOLDS = {
  amber: 60,
  orange: 80,
  red: 90,
} as const;

/** Poll cadence while a run is active (ms). Modest — not per-token. */
export const ACTIVE_RUN_POLL_MS = 2000;

/** Row / bar segment order shown in the Cursor-style panel. */
export const BREAKDOWN_SEGMENTS = [
  { key: 'systemPrompt', labelKey: 'context.systemPrompt', color: 'system' },
  { key: 'rules', labelKey: 'context.rules', color: 'rules' },
  { key: 'toolsRuntime', labelKey: 'context.toolsRuntime', color: 'tools' },
  { key: 'conversation', labelKey: 'context.conversation', color: 'conversation' },
] as const;

export type BreakdownSegmentKey = (typeof BREAKDOWN_SEGMENTS)[number]['key'];

/** Strict UUID shape — same contract as the Rust reader (no free-form paths). */
const SESSION_ID_RE =
  /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/;

export function isValidSessionId(id: string | null | undefined): boolean {
  if (!id) return false;
  const trimmed = id.trim();
  return trimmed.length === 36 && SESSION_ID_RE.test(trimmed);
}

/**
 * Authoritative Grok session head for the open conversation: last assistant
 * message that persisted `meta.sessionId`. Does not use RunSnapshot.usage.
 * Only UUID-shaped ids are accepted (matches the Rust reader).
 */
export function selectMessageSessionId(messages: readonly ChatMessage[]): string | null {
  for (let i = messages.length - 1; i >= 0; i -= 1) {
    const message = messages[i];
    if (message.role === 'assistant' && message.meta?.sessionId) {
      const id = message.meta.sessionId.trim();
      if (isValidSessionId(id)) return id;
    }
  }
  return null;
}

/** Prefer the persisted message head; fall back to a live run session id. */
export function resolveActiveSessionId(
  messages: readonly ChatMessage[],
  runSessionId: string | null | undefined,
): string | null {
  const fromMessages = selectMessageSessionId(messages);
  if (fromMessages) return fromMessages;
  const fromRun = runSessionId?.trim() || null;
  return isValidSessionId(fromRun) ? fromRun : null;
}

export function usagePercentFromMetrics(metrics: SessionContextMetrics): number | null {
  if (
    typeof metrics.contextWindowUsage === 'number' &&
    Number.isFinite(metrics.contextWindowUsage)
  ) {
    return clampPercent(metrics.contextWindowUsage);
  }
  const used = metrics.contextTokensUsed;
  const window = metrics.contextWindowTokens;
  if (typeof used === 'number' && typeof window === 'number' && window > 0) {
    return clampPercent((used * 100) / window);
  }
  return null;
}

export function clampPercent(n: number): number {
  if (!Number.isFinite(n) || n < 0) return 0;
  if (n > 100) return 100;
  return n;
}

/** Color band for a 0–100 occupancy percent. */
export function usageTone(percent: number | null | undefined): ContextUsageTone {
  if (percent == null || !Number.isFinite(percent)) return 'empty';
  if (percent >= USAGE_THRESHOLDS.red) return 'red';
  if (percent >= USAGE_THRESHOLDS.orange) return 'orange';
  if (percent >= USAGE_THRESHOLDS.amber) return 'amber';
  return 'neutral';
}

/** Compact token labels for the popover (e.g. 17.8k). */
export function formatTokenCount(n: number | null | undefined): string {
  if (n == null || !Number.isFinite(n)) return '—';
  const abs = Math.abs(n);
  if (abs < 1000) return String(Math.round(n));
  if (abs < 10_000) return `${(n / 1000).toFixed(1).replace(/\.0$/, '')}k`;
  if (abs < 1_000_000) return `${Math.round(n / 1000)}k`;
  return `${(n / 1_000_000).toFixed(2).replace(/\.?0+$/, '')}M`;
}

/** Approximate token label with a leading tilde (honest estimation cue). */
export function formatApproxTokenCount(n: number | null | undefined): string {
  const base = formatTokenCount(n);
  if (base === '—') return base;
  return `~${base}`;
}

export function formatPercent(n: number | null | undefined): string {
  if (n == null || !Number.isFinite(n)) return '—';
  if (n > 0 && n < 0.1) return '<0.1%';
  if (n < 10) return `${n.toFixed(1)}%`;
  return `${Math.round(n)}%`;
}

/** Segment widths against the full context window, leaving unused capacity gray. */
export function breakdownSegmentPercents(
  breakdown: ContextUsageBreakdown | null | undefined,
  contextWindow: number | null | undefined,
): Record<BreakdownSegmentKey, number> {
  const empty: Record<BreakdownSegmentKey, number> = {
    systemPrompt: 0,
    rules: 0,
    toolsRuntime: 0,
    conversation: 0,
  };
  if (!breakdown) return empty;
  const used =
    breakdown.systemPrompt + breakdown.rules + breakdown.toolsRuntime + breakdown.conversation;
  const denom = typeof contextWindow === 'number' && contextWindow > 0 ? contextWindow : used;
  if (denom <= 0) return empty;
  return {
    systemPrompt: (breakdown.systemPrompt / denom) * 100,
    rules: (breakdown.rules / denom) * 100,
    toolsRuntime: (breakdown.toolsRuntime / denom) * 100,
    conversation: (breakdown.conversation / denom) * 100,
  };
}

/**
 * Collapse fetch inputs + metrics into a single view model the ring/popover
 * can render without re-deriving threshold logic.
 */
export function selectContextUsageView(input: {
  cwd: string;
  sessionId: string | null;
  loading: boolean;
  error: string | null;
  metrics: SessionContextMetrics | null;
}): ContextUsageViewState {
  if (!input.sessionId) {
    return {
      kind: 'empty',
      reason: 'no-session',
      detail: 'Context usage appears after the first Grok reply.',
    };
  }
  if (input.error) {
    return { kind: 'error', message: input.error };
  }
  if (input.loading && !input.metrics) {
    return { kind: 'loading', sessionId: input.sessionId };
  }
  if (!input.metrics || !input.metrics.available) {
    return {
      kind: 'empty',
      reason: 'unavailable',
      detail: input.metrics?.detail ?? 'Context metrics unavailable for this session.',
    };
  }
  const percent = usagePercentFromMetrics(input.metrics) ?? 0;
  return {
    kind: 'ready',
    metrics: input.metrics,
    percent,
    tone: usageTone(percent),
  };
}

function normalizeBreakdown(
  raw: ContextUsageBreakdown | null | undefined,
): ContextUsageBreakdown | null {
  if (!raw || typeof raw !== 'object') return null;
  const systemPrompt = Math.max(0, Math.floor(Number(raw.systemPrompt) || 0));
  const rules = Math.max(0, Math.floor(Number(raw.rules) || 0));
  const conversation = Math.max(0, Math.floor(Number(raw.conversation) || 0));
  const toolsRuntime = Math.max(0, Math.floor(Number(raw.toolsRuntime) || 0));
  return { systemPrompt, rules, conversation, toolsRuntime };
}

/** Normalize IPC nulls (serde Option → null | undefined). */
function normalizeMetrics(raw: SessionContextMetrics): SessionContextMetrics {
  const breakdown = normalizeBreakdown(raw.breakdown);
  return {
    available: Boolean(raw.available),
    sessionId: raw.sessionId ?? '',
    contextTokensUsed: raw.contextTokensUsed ?? null,
    contextWindowTokens: raw.contextWindowTokens ?? null,
    contextWindowUsage: typeof raw.contextWindowUsage === 'number' ? raw.contextWindowUsage : null,
    compactionCount: raw.compactionCount ?? null,
    totalTokensBeforeCompaction: raw.totalTokensBeforeCompaction ?? null,
    turnCount: raw.turnCount ?? null,
    primaryModelId: raw.primaryModelId ?? null,
    autoCompactThresholdPercent: raw.autoCompactThresholdPercent ?? null,
    breakdown,
    breakdownApproximate: breakdown != null ? Boolean(raw.breakdownApproximate ?? true) : false,
    detail: raw.detail ?? null,
  };
}

export async function fetchSessionContextMetrics(
  cwd: string,
  sessionId: string,
): Promise<SessionContextMetrics> {
  if (!hasTauriRuntime()) {
    return {
      available: false,
      sessionId,
      contextTokensUsed: null,
      contextWindowTokens: null,
      contextWindowUsage: null,
      compactionCount: null,
      totalTokensBeforeCompaction: null,
      turnCount: null,
      primaryModelId: null,
      autoCompactThresholdPercent: null,
      breakdown: null,
      breakdownApproximate: false,
      detail: 'Desktop runtime unavailable',
    };
  }
  const raw = await invoke<SessionContextMetrics>('get_session_context_metrics', {
    cwd,
    sessionId,
  });
  return normalizeMetrics(raw);
}
