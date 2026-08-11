import { describe, expect, it, vi, beforeEach } from 'vitest';
import {
  breakdownSegmentPercents,
  clampPercent,
  formatApproxTokenCount,
  formatPercent,
  formatTokenCount,
  resolveActiveSessionId,
  selectContextUsageView,
  selectMessageSessionId,
  usagePercentFromMetrics,
  usageTone,
  USAGE_THRESHOLDS,
  type SessionContextMetrics,
} from '../contextMetrics';
import type { ChatMessage } from '../../app/types';

function metrics(partial: Partial<SessionContextMetrics> = {}): SessionContextMetrics {
  return {
    available: true,
    sessionId: '019fe74c-9daf-7b03-9387-36b35cf1eb63',
    contextTokensUsed: 60_000,
    contextWindowTokens: 500_000,
    contextWindowUsage: 12,
    compactionCount: 0,
    totalTokensBeforeCompaction: 0,
    turnCount: 2,
    primaryModelId: 'grok-4.5',
    autoCompactThresholdPercent: 80,
    breakdown: {
      systemPrompt: 5_000,
      rules: 2_000,
      conversation: 20_000,
      toolsRuntime: 33_000,
    },
    breakdownApproximate: true,
    detail: null,
    ...partial,
  };
}

function assistant(sessionId?: string): ChatMessage {
  return {
    id: 'a1',
    role: 'assistant',
    content: 'hi',
    ts: 1,
    meta: sessionId ? { sessionId } : undefined,
  };
}

const SID_OLD = '019fe74c-9daf-7b03-9387-36b35cf1eb63';
const SID_NEW = '550e8400-e29b-41d4-a716-446655440000';
const SID_RUN = '11111111-2222-3333-4444-555555555555';

describe('selectMessageSessionId / resolveActiveSessionId', () => {
  it('returns the latest assistant session head', () => {
    const messages: ChatMessage[] = [
      { id: 'u1', role: 'user', content: 'a', ts: 1 },
      assistant(SID_OLD),
      { id: 'u2', role: 'user', content: 'b', ts: 2 },
      assistant(SID_NEW),
    ];
    expect(selectMessageSessionId(messages)).toBe(SID_NEW);
  });

  it('returns null for a new conversation with no session yet', () => {
    const messages: ChatMessage[] = [{ id: 'u1', role: 'user', content: 'a', ts: 1 }];
    expect(selectMessageSessionId(messages)).toBeNull();
    expect(resolveActiveSessionId(messages, null)).toBeNull();
  });

  it('falls back to the live run session id when messages lack a head', () => {
    expect(resolveActiveSessionId([], SID_RUN)).toBe(SID_RUN);
    expect(resolveActiveSessionId([assistant(SID_NEW)], SID_RUN)).toBe(SID_NEW);
  });

  it('rejects non-UUID session ids (path traversal / free-form)', () => {
    expect(selectMessageSessionId([assistant('../etc/passwd')])).toBeNull();
    expect(selectMessageSessionId([assistant('not-a-uuid')])).toBeNull();
    expect(resolveActiveSessionId([], '../secret')).toBeNull();
    expect(resolveActiveSessionId([], 'run-sid')).toBeNull();
  });
});

describe('usage thresholds and percent', () => {
  it('bands occupancy into neutral / amber / orange / red', () => {
    expect(usageTone(0)).toBe('neutral');
    expect(usageTone(59.9)).toBe('neutral');
    expect(usageTone(USAGE_THRESHOLDS.amber)).toBe('amber');
    expect(usageTone(79.9)).toBe('amber');
    expect(usageTone(USAGE_THRESHOLDS.orange)).toBe('orange');
    expect(usageTone(89.9)).toBe('orange');
    expect(usageTone(USAGE_THRESHOLDS.red)).toBe('red');
    expect(usageTone(100)).toBe('red');
    expect(usageTone(null)).toBe('empty');
  });

  it('reads percent from metrics and clamps', () => {
    expect(usagePercentFromMetrics(metrics({ contextWindowUsage: 12 }))).toBe(12);
    expect(usagePercentFromMetrics(metrics({ contextWindowUsage: null }))).toBeCloseTo(12, 5);
    expect(clampPercent(-5)).toBe(0);
    expect(clampPercent(140)).toBe(100);
  });
});

describe('formatting', () => {
  it('formats token counts compactly', () => {
    expect(formatTokenCount(null)).toBe('—');
    expect(formatTokenCount(420)).toBe('420');
    expect(formatTokenCount(17831)).toBe('18k');
    expect(formatTokenCount(1500)).toBe('1.5k');
    expect(formatTokenCount(500_000)).toBe('500k');
  });

  it('formats approximate token counts with a tilde', () => {
    expect(formatApproxTokenCount(null)).toBe('—');
    expect(formatApproxTokenCount(90_000)).toBe('~90k');
    expect(formatApproxTokenCount(1500)).toBe('~1.5k');
  });

  it('formats percentages', () => {
    expect(formatPercent(null)).toBe('—');
    expect(formatPercent(0.05)).toBe('<0.1%');
    expect(formatPercent(3.4)).toBe('3.4%');
    expect(formatPercent(12.2)).toBe('12%');
  });
});

describe('breakdownSegmentPercents', () => {
  it('proportions segments against the full context window', () => {
    const pct = breakdownSegmentPercents(
      {
        systemPrompt: 10_000,
        rules: 5_000,
        toolsRuntime: 25_000,
        conversation: 60_000,
      },
      500_000,
    );
    expect(pct.systemPrompt).toBeCloseTo(2);
    expect(pct.rules).toBeCloseTo(1);
    expect(pct.toolsRuntime).toBeCloseTo(5);
    expect(pct.conversation).toBeCloseTo(12);
    expect(pct.systemPrompt + pct.rules + pct.toolsRuntime + pct.conversation).toBeCloseTo(20);
  });

  it('returns zeros without a breakdown', () => {
    expect(breakdownSegmentPercents(null, 100)).toEqual({
      systemPrompt: 0,
      rules: 0,
      toolsRuntime: 0,
      conversation: 0,
    });
  });
});

describe('selectContextUsageView', () => {
  it('handles empty / error / loading / ready states', () => {
    expect(
      selectContextUsageView({
        cwd: '',
        sessionId: null,
        loading: false,
        error: null,
        metrics: null,
      }).kind,
    ).toBe('empty');
    expect(
      selectContextUsageView({
        cwd: '/proj',
        sessionId: null,
        loading: false,
        error: null,
        metrics: null,
      }),
    ).toMatchObject({ kind: 'empty', reason: 'no-session' });
    expect(
      selectContextUsageView({
        cwd: '/proj',
        sessionId: 'sid',
        loading: true,
        error: null,
        metrics: null,
      }).kind,
    ).toBe('loading');
    expect(
      selectContextUsageView({
        cwd: '/proj',
        sessionId: 'sid',
        loading: false,
        error: 'boom',
        metrics: null,
      }),
    ).toMatchObject({ kind: 'error', message: 'boom' });
    expect(
      selectContextUsageView({
        cwd: '/proj',
        sessionId: 'sid',
        loading: false,
        error: null,
        metrics: metrics({ available: false, detail: 'gone' }),
      }),
    ).toMatchObject({ kind: 'empty', reason: 'unavailable' });
    const ready = selectContextUsageView({
      cwd: '/proj',
      sessionId: 'sid',
      loading: false,
      error: null,
      metrics: metrics({ contextWindowUsage: 85 }),
    });
    expect(ready).toMatchObject({ kind: 'ready', percent: 85, tone: 'orange' });
    if (ready.kind === 'ready') {
      expect(ready.metrics.breakdownApproximate).toBe(true);
      expect(ready.metrics.breakdown).toBeTruthy();
    }
  });
});

describe('fetchSessionContextMetrics without Tauri', () => {
  beforeEach(() => {
    vi.resetModules();
  });

  it('returns an unavailable payload when the desktop runtime is absent', async () => {
    const { fetchSessionContextMetrics } = await import('../contextMetrics');
    const result = await fetchSessionContextMetrics('/proj', 'sid');
    expect(result.available).toBe(false);
    expect(result.detail).toMatch(/unavailable/i);
    expect(result.breakdown).toBeNull();
  });
});
