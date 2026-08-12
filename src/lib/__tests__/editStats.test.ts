import { describe, expect, it } from 'vitest';
import { displayEdit, isEditTrace, sumEditStats } from '../editStats';
import type { TraceEvent } from '../traceParser';

function makeTrace(overrides: Partial<TraceEvent> = {}): TraceEvent {
  return {
    key: 'tool:1',
    kind: 'tool',
    label: 'Edit src/a.ts',
    status: 'done',
    startedAt: 1_000,
    endedAt: 2_000,
    ...overrides,
  };
}

describe('sumEditStats', () => {
  it('sums two edits into phase totals (+2/-1 then +3/-4 => +5/-5)', () => {
    const traces = [
      makeTrace({ key: 'edit:1', additions: 2, deletions: 1 }),
      makeTrace({ key: 'edit:2', additions: 3, deletions: 4 }),
    ];
    expect(sumEditStats(traces)).toEqual({ additions: 5, deletions: 5 });
  });

  it('returns zeros when there are no edit stats', () => {
    const traces = [
      makeTrace({ key: 'read:1', label: 'Read src/a.ts' }),
      makeTrace({ key: 'search:1', label: 'Search MessageItem' }),
    ];
    expect(sumEditStats(traces)).toEqual({ additions: 0, deletions: 0 });
    expect(sumEditStats([])).toEqual({ additions: 0, deletions: 0 });
  });

  it('scopes totals to the provided traces only (phase isolation)', () => {
    const phaseA = [
      makeTrace({ key: 'edit:a1', additions: 2, deletions: 1 }),
      makeTrace({ key: 'edit:a2', additions: 3, deletions: 4 }),
    ];
    const phaseB = [makeTrace({ key: 'edit:b1', additions: 10, deletions: 7 })];
    expect(sumEditStats(phaseA)).toEqual({ additions: 5, deletions: 5 });
    expect(sumEditStats(phaseB)).toEqual({ additions: 10, deletions: 7 });
    // Mixing would be wrong for a phase heading; callers must pass phase-local traces.
    expect(sumEditStats([...phaseA, ...phaseB])).toEqual({ additions: 15, deletions: 12 });
  });

  it('ignores non-edit tools mixed into the same list', () => {
    const traces = [
      makeTrace({ key: 'read:1', label: 'Read src/a.ts' }),
      makeTrace({ key: 'edit:1', additions: 2, deletions: 1 }),
      makeTrace({ key: 'search:1', label: 'Search foo' }),
    ];
    expect(sumEditStats(traces)).toEqual({ additions: 2, deletions: 1 });
  });
});

describe('displayEdit', () => {
  it('prefers explicit additions/deletions over diff line counts', () => {
    expect(
      displayEdit(
        makeTrace({
          diff: '+a\n+b\n-c',
          additions: 9,
          deletions: 3,
        }),
      ),
    ).toEqual({ diff: '+a\n+b\n-c', additions: 9, deletions: 3 });
  });

  it('counts unified-diff lines when numeric stats are absent', () => {
    expect(displayEdit(makeTrace({ diff: '+a\n+b\n-c\n context' }))).toEqual({
      diff: '+a\n+b\n-c\n context',
      additions: 2,
      deletions: 1,
    });
  });
});

describe('isEditTrace', () => {
  it('detects edits by diff or line-count fields', () => {
    expect(isEditTrace(makeTrace({ additions: 1 }))).toBe(true);
    expect(isEditTrace(makeTrace({ deletions: 1 }))).toBe(true);
    expect(isEditTrace(makeTrace({ diff: '+x' }))).toBe(true);
    expect(isEditTrace(makeTrace({ label: 'Read a.ts' }))).toBe(false);
  });
});
