import type { TranscriptSegment } from './streamStore';

/**
 * Normalises Grok's `streaming-json` activity events into one stable shape.
 *
 * Grok 0.2.118 follows the ACP field names (`toolCallId`, `rawInput`,
 * `rawOutput`). Older releases and a few extensions use snake_case, so the
 * reader intentionally accepts both. The important invariant is that every
 * update for one tool/subagent resolves to the same key and is upserted.
 */

export type TraceKind = 'tool' | 'subagent' | 'task' | 'other';
export type TraceStatus = 'running' | 'done' | 'error' | 'cancelled';

export interface TraceEvent {
  key: string;
  kind: TraceKind;
  label: string;
  status: TraceStatus;
  startedAt: number;
  endedAt: number | null;
  /** ACP child session that owns this subagent's workflow transcript. */
  sessionId?: string;
  /** Ordered thought/respond/tool transcript for an individual subagent. */
  transcript?: TranscriptSegment[];
  /** Full prompt the parent agent sent this subagent. Preserved across updates. */
  prompt?: string;
  detail?: string;
  parentKey?: string;
  progress?: string;
  path?: string;
  /** Compact unified diff retained after raw ACP payloads are discarded. */
  diff?: string;
  additions?: number;
  deletions?: number;
  raw?: unknown;
}

export type TraceParseResult = { kind: 'upsert'; event: TraceEvent } | { kind: 'ignore' };

export interface RunUsage {
  inputTokens: number;
  outputTokens: number;
  thoughtTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  totalTokens: number;
  turns?: number;
}

function asString(value: unknown): string | undefined {
  if (typeof value === 'string') return value;
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  return undefined;
}

function asNumber(value: unknown): number | undefined {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value === 'string' && value.trim() !== '') {
    const parsed = Number(value);
    if (Number.isFinite(parsed)) return parsed;
  }
  return undefined;
}

function readField(obj: Record<string, unknown>, ...names: string[]): string | undefined {
  for (const name of names) {
    const value = asString(obj[name]);
    if (value !== undefined && value !== '') return value;
  }
  return undefined;
}

function readNumber(obj: Record<string, unknown>, ...names: string[]): number | undefined {
  for (const name of names) {
    const value = asNumber(obj[name]);
    if (value !== undefined) return value;
  }
  return undefined;
}

function readObj(
  obj: Record<string, unknown>,
  ...names: string[]
): Record<string, unknown> | undefined {
  for (const name of names) {
    const value = obj[name];
    if (value && typeof value === 'object' && !Array.isArray(value)) {
      return value as Record<string, unknown>;
    }
  }
  return undefined;
}

/** Pull the parent agent's task text off a spawn / Task-tool payload. */
export function extractSubagentPrompt(value: unknown, depth = 0): string | undefined {
  if (depth > 3 || value == null) return undefined;
  if (typeof value === 'string') {
    const text = value.trim();
    if (!text) return undefined;
    if (text.startsWith('{') || text.startsWith('[')) {
      try {
        return extractSubagentPrompt(JSON.parse(text) as unknown, depth + 1) ?? undefined;
      } catch {
        return text;
      }
    }
    return text;
  }
  if (typeof value !== 'object' || Array.isArray(value)) return undefined;
  const obj = value as Record<string, unknown>;
  const direct = readField(obj, 'prompt', 'task', 'instruction', 'query');
  if (direct) return direct;
  for (const key of ['rawInput', 'raw_input', 'input', 'arguments', 'args', 'params', 'data']) {
    const nested = extractSubagentPrompt(obj[key], depth + 1);
    if (nested) return nested;
  }
  const description = readField(obj, 'description');
  if (description && (description.includes('\n') || description.length > 80)) return description;
  return undefined;
}

/** Prompt shown as the user bubble inside a subagent inspector. */
export function resolveSubagentPrompt(
  subagent: TraceEvent,
  traces: readonly TraceEvent[] = [],
): string {
  const own = subagent.prompt?.trim() || extractSubagentPrompt(subagent.raw)?.trim();
  if (own) return own;
  const label = subagent.label.trim().toLowerCase();
  for (const trace of traces) {
    if (trace.key === subagent.key) continue;
    const prompt = (trace.prompt || extractSubagentPrompt(trace.raw))?.trim();
    if (!prompt) continue;
    const toolLabel = trace.label.trim().toLowerCase();
    if (toolLabel === label || toolLabel === 'task' || toolLabel === 'subagent') return prompt;
  }
  return '';
}

function shorten(value: unknown, max = 180): string | undefined {
  if (value == null) return undefined;
  try {
    const text = typeof value === 'string' ? value : JSON.stringify(value);
    const compact = text.replace(/\s+/g, ' ').trim();
    if (!compact) return undefined;
    return compact.length <= max ? compact : `${compact.slice(0, max - 1)}…`;
  } catch {
    return undefined;
  }
}

function normaliseStatus(type: string, value: string | undefined): TraceStatus {
  const status = (value ?? '').toLowerCase();
  if (status === 'failed' || status === 'error' || type.endsWith('_failed')) return 'error';
  if (status === 'cancelled' || status === 'canceled' || type.endsWith('_cancelled')) {
    return 'cancelled';
  }
  if (
    status === 'completed' ||
    status === 'done' ||
    status === 'success' ||
    type.endsWith('_finished') ||
    type.endsWith('_complete') ||
    type.endsWith('_completed') ||
    type.endsWith('_done') ||
    type.endsWith('_result') ||
    type.endsWith('_end')
  ) {
    return 'done';
  }
  return 'running';
}

function typeOf(obj: Record<string, unknown>): string {
  return (readField(obj, 'type', 'sessionUpdate', 'session_update', 'event', 'kind') ?? '')
    .toLowerCase()
    .trim();
}

export type PlanEntryStatus = 'completed' | 'in_progress' | 'pending';

export interface PlanEntry {
  text: string;
  status: PlanEntryStatus;
}

function planEntryStatus(value: string | undefined): PlanEntryStatus {
  const status = (value ?? '').toLowerCase();
  if (status === 'completed' || status === 'done') return 'completed';
  if (status === 'in_progress' || status === 'running') return 'in_progress';
  return 'pending';
}

/**
 * Parse structured ACP/Grok plan steps from a raw plan / plan_update event.
 * Returns null when the payload is not a plan event or has no usable entries.
 * Does not infer steps from prose.
 */
export function extractPlanEntries(raw: unknown): PlanEntry[] | null {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const obj = raw as Record<string, unknown>;
  const type = typeOf(obj);
  if (type !== 'plan' && type !== 'plan_update') return null;
  const entries = obj.entries;
  if (!Array.isArray(entries) || entries.length === 0) return null;
  const parsed: PlanEntry[] = [];
  for (const item of entries) {
    if (!item || typeof item !== 'object' || Array.isArray(item)) continue;
    const entry = item as Record<string, unknown>;
    const text = readField(entry, 'content', 'title', 'description', 'label')?.trim();
    if (!text) continue;
    parsed.push({
      text,
      status: planEntryStatus(readField(entry, 'status')),
    });
  }
  return parsed.length > 0 ? parsed : null;
}

function planSummary(entries: unknown): string | undefined {
  if (!Array.isArray(entries)) return shorten(entries);
  let completed = 0;
  let active: string | undefined;
  for (const item of entries) {
    if (!item || typeof item !== 'object') continue;
    const entry = item as Record<string, unknown>;
    const status = readField(entry, 'status')?.toLowerCase();
    if (status === 'completed' || status === 'done') completed += 1;
    if (status === 'in_progress' || status === 'running') {
      active = readField(entry, 'content', 'title', 'description', 'label');
    }
  }
  const progress = entries.length > 0 ? `${completed}/${entries.length}` : undefined;
  return [progress, active].filter(Boolean).join(' · ') || undefined;
}

/** Parse one official or legacy activity line. */
export function classifyEvent(raw: unknown, now = Date.now()): TraceParseResult {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return { kind: 'ignore' };
  const obj = raw as Record<string, unknown>;
  const type = typeOf(obj);
  if (!type) return { kind: 'ignore' };

  // Text/thought/usage/end/error are handled by streamStore, not the rail.
  if (
    type === 'thought' ||
    type === 'text' ||
    type === 'end' ||
    type === 'error' ||
    type === 'usage' ||
    type === 'usage_update' ||
    type === 'agent_thought_chunk' ||
    type === 'agent_message_chunk' ||
    type === 'user_message_chunk' ||
    type === 'available_commands' ||
    type === 'available_commands_update'
  ) {
    return { kind: 'ignore' };
  }

  if (
    type === 'plan' ||
    type === 'plan_update' ||
    (type.includes('task') && Array.isArray(obj.entries))
  ) {
    const id = readField(obj, 'id', 'taskId', 'task_id', 'planId', 'plan_id') ?? 'current-plan';
    const entries = obj.entries;
    const status = normaliseStatus(type, readField(obj, 'status'));
    return {
      kind: 'upsert',
      event: {
        key: `task:${id}`,
        kind: 'task',
        label: readField(obj, 'title', 'name', 'plan') ?? 'Plan',
        status,
        startedAt: now,
        endedAt: status === 'running' ? null : now,
        detail: planSummary(entries) ?? shorten(obj.detail),
        raw,
      },
    };
  }

  const isSubagent = type.includes('subagent') || type.includes('sub_agent');
  const isTool =
    type === 'tool_call' ||
    type === 'tool_call_update' ||
    type === 'tool_use' ||
    type === 'tool_result' ||
    type.startsWith('tool_') ||
    obj.toolCallId != null ||
    obj.tool_call_id != null;
  if (!isSubagent && !isTool) return { kind: 'ignore' };

  const id = isSubagent
    ? readField(obj, 'subagentId', 'subagent_id', 'childSessionId', 'child_session_id', 'id')
    : readField(
        obj,
        'toolCallId',
        'tool_call_id',
        'tool_use_id',
        'toolId',
        'tool_id',
        'call_id',
        'invocation_id',
        'id',
      );
  const name = isSubagent
    ? readField(obj, 'description', 'title', 'name', 'role', 'subagent_type', 'subagent')
    : readField(obj, 'title', 'toolName', 'tool_name', 'name', 'tool', 'function_name');
  // ID-less legacy pairs still share a deterministic key. Official events
  // always carry toolCallId/subagent_id, so concurrent calls remain distinct.
  const keyName = name ?? (isSubagent ? 'agent' : 'tool');
  const key = `${isSubagent ? 'subagent' : 'tool'}:${id ?? keyName}`;
  const sessionId = isSubagent
    ? readField(obj, 'childSessionId', 'child_session_id', 'sessionId', 'session_id')
    : readField(obj, 'sessionId', 'session_id');
  const status = normaliseStatus(type, readField(obj, 'status'));
  const input =
    obj.rawInput ?? obj.raw_input ?? obj.input ?? obj.arguments ?? obj.args ?? obj.params;
  const output = obj.rawOutput ?? obj.raw_output ?? obj.output ?? obj.result ?? obj.response;
  const error = readField(obj, 'error', 'message', 'stderr');
  // ACP can emit bookkeeping-only tool updates without an id, title, input,
  // output, or error. They used to become a misleading extra “Tool” row.
  if (!id && !name && input == null && output == null && !error) return { kind: 'ignore' };
  const detail =
    status === 'error' ? (error ?? shorten(output)) : (shorten(output) ?? shorten(input));
  const prompt = extractSubagentPrompt(obj) ?? extractSubagentPrompt(input);
  const parent = readField(obj, 'parentSessionId', 'parent_session_id', 'parentId', 'parent_id');
  const duration = readNumber(obj, 'durationMs', 'duration_ms');
  const toolCalls = readNumber(obj, 'toolCalls', 'tool_calls');
  const turns = readNumber(obj, 'turns');
  const progress =
    isSubagent && status !== 'running'
      ? [toolCalls != null ? `${toolCalls} tools` : '', turns != null ? `${turns} turns` : '']
          .filter(Boolean)
          .join(' · ') || undefined
      : readField(obj, 'progress', 'activity', 'current_activity');
  const inputObj =
    input && typeof input === 'object' && !Array.isArray(input)
      ? (input as Record<string, unknown>)
      : undefined;
  const outputObj =
    output && typeof output === 'object' && !Array.isArray(output)
      ? (output as Record<string, unknown>)
      : undefined;
  const locations = Array.isArray(obj.locations) ? obj.locations : [];
  const locationPath = locations
    .map((location) =>
      location && typeof location === 'object' && !Array.isArray(location)
        ? readField(location as Record<string, unknown>, 'path')
        : undefined,
    )
    .find(Boolean);
  const path =
    locationPath ??
    (inputObj
      ? readField(inputObj, 'file_path', 'path', 'target_file', 'filename', 'absolute_path')
      : undefined) ??
    (outputObj ? readField(outputObj, 'absolute_path', 'path', 'file_path') : undefined);
  const edit = extractEdit(outputObj);

  return {
    kind: 'upsert',
    event: {
      key,
      kind: isSubagent ? 'subagent' : 'tool',
      label: name ?? (isSubagent ? 'Subagent' : 'Tool'),
      status,
      startedAt: duration != null && status !== 'running' ? Math.max(0, now - duration) : now,
      endedAt: status === 'running' ? null : now,
      sessionId,
      prompt,
      detail,
      parentKey: parent ? `subagent:${parent}` : undefined,
      progress,
      path,
      diff: edit?.diff,
      additions: edit?.additions,
      deletions: edit?.deletions,
      raw,
    },
  };
}

function extractEdit(
  output: Record<string, unknown> | undefined,
): { diff: string; additions: number; deletions: number } | undefined {
  if (!output) return undefined;
  const applied = readObj(output, 'EditsApplied', 'editsApplied', 'edits_applied');
  if (!applied) return undefined;
  const pairs: Array<{ oldText: string; newText: string }> = [];
  const directOld = asString(applied.old_string) ?? '';
  const directNew = asString(applied.new_string) ?? '';
  if (directOld || directNew) pairs.push({ oldText: directOld, newText: directNew });
  // Grok can repeat the same edit in both the direct fields and
  // edits.details. Prefer the direct form; otherwise a created file is counted
  // twice. `new_line` / `old_line` are numeric locations, never code text.
  if (pairs.length === 0) {
    const edits = readObj(applied, 'edits');
    const details = edits && Array.isArray(edits.details) ? edits.details : [];
    for (const value of details) {
      if (!value || typeof value !== 'object' || Array.isArray(value)) continue;
      const detail = value as Record<string, unknown>;
      const oldText = readField(detail, 'old_string') ?? '';
      const newText = readField(detail, 'new_string') ?? '';
      if (oldText || newText) pairs.push({ oldText, newText });
    }
  }
  if (pairs.length === 0) return undefined;
  const lines: string[] = [];
  let additions = 0;
  let deletions = 0;
  for (const pair of pairs) {
    for (const line of pair.oldText.split('\n')) {
      if (!pair.oldText && line === '') continue;
      lines.push(`-${line}`);
      deletions += 1;
    }
    for (const line of pair.newText.split('\n')) {
      if (!pair.newText && line === '') continue;
      lines.push(`+${line}`);
      additions += 1;
    }
  }
  return lines.length ? { diff: lines.join('\n'), additions, deletions } : undefined;
}

/** Extract authoritative usage from `usage` and final `end` lines. */
export function extractUsage(raw: unknown): RunUsage | undefined {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return undefined;
  const obj = raw as Record<string, unknown>;
  const usage = readObj(obj, 'usage');
  if (!usage) return undefined;
  const inputTokens = readNumber(usage, 'input_tokens', 'inputTokens') ?? 0;
  const outputTokens = readNumber(usage, 'output_tokens', 'outputTokens') ?? 0;
  const thoughtTokens = readNumber(usage, 'reasoning_tokens', 'thoughtTokens') ?? 0;
  const cacheReadTokens =
    readNumber(usage, 'cache_read_input_tokens', 'cacheReadInputTokens', 'cachedReadTokens') ?? 0;
  const cacheWriteTokens =
    readNumber(
      usage,
      'cache_creation_input_tokens',
      'cacheWriteInputTokens',
      'cachedWriteTokens',
    ) ?? 0;
  const totalTokens =
    readNumber(usage, 'total_tokens', 'totalTokens') ??
    inputTokens + outputTokens + cacheReadTokens + cacheWriteTokens;
  return {
    inputTokens,
    outputTokens,
    thoughtTokens,
    cacheReadTokens,
    cacheWriteTokens,
    totalTokens,
    turns: readNumber(obj, 'num_turns', 'numTurns', 'turns'),
  };
}

export type CompactionStatus = 'running' | 'done' | 'failed' | 'cancelled';

/** Live / completed auto-compaction hint for the transcript. */
export interface RunCompaction {
  status: CompactionStatus;
  percentage: number | null;
  tokensBefore: number | null;
  tokensAfter: number | null;
}

function compactionKind(obj: Record<string, unknown>): string {
  const candidates = [
    readField(obj, 'sessionUpdate', 'session_update'),
    readField(obj, 'type'),
    readField(obj, 'event', 'kind', 'subtype'),
  ];
  for (const candidate of candidates) {
    const value = (candidate ?? '').toLowerCase();
    if (
      value.includes('auto_compact') ||
      value === 'compact_boundary' ||
      value.includes('compact_boundary')
    ) {
      return value;
    }
  }
  const nested = readObj(obj, 'update');
  return nested ? compactionKind(nested) : '';
}

function compactionPercent(obj: Record<string, unknown>): number | null {
  const direct = readNumber(obj, 'percentage');
  if (direct != null) {
    const pct = direct > 0 && direct <= 1 ? direct * 100 : direct;
    return Number.isFinite(pct) ? Math.max(0, Math.min(100, pct)) : null;
  }
  const used = readNumber(obj, 'tokens_used', 'tokensUsed');
  const window = readNumber(obj, 'context_window', 'contextWindow');
  if (used != null && window != null && window > 0) {
    return Math.max(0, Math.min(100, (used / window) * 100));
  }
  return null;
}

function compactionSource(raw: unknown): Record<string, unknown> | undefined {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return undefined;
  const obj = raw as Record<string, unknown>;
  const nested = readObj(obj, 'update');
  const kind = compactionKind(obj);
  if (kind) return nested && compactionKind(nested) ? nested : obj;
  return nested && compactionKind(nested) ? nested : undefined;
}

/**
 * Parse streaming-json `auto_compact_*` and ACP `sessionUpdate` compaction
 * notifications. Returns undefined for unrelated payloads.
 */
export function extractCompaction(raw: unknown): RunCompaction | undefined {
  const obj = compactionSource(raw);
  if (!obj) return undefined;
  const kind = compactionKind(obj);
  if (!kind) return undefined;

  const percentage = compactionPercent(obj);
  const tokensBefore = readNumber(obj, 'tokens_before', 'tokensBefore') ?? null;
  const tokensAfter = readNumber(obj, 'tokens_after', 'tokensAfter') ?? null;
  const fields = { percentage, tokensBefore, tokensAfter };

  if (kind.includes('auto_compact_started')) return { status: 'running', ...fields };
  if (kind.includes('auto_compact_completed') || kind.includes('compact_boundary')) {
    return { status: 'done', ...fields };
  }
  if (kind.includes('auto_compact_failed')) return { status: 'failed', ...fields };
  if (kind.includes('auto_compact_cancelled') || kind.includes('auto_compact_canceled')) {
    return { status: 'cancelled', ...fields };
  }
  return undefined;
}

export function extractRunError(raw: unknown): string | undefined {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return undefined;
  const obj = raw as Record<string, unknown>;
  if (typeOf(obj) !== 'error') return undefined;
  return readField(obj, 'message', 'error', 'stderr') ?? 'Grok reported an error';
}
