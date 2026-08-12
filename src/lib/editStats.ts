import type { TraceEvent } from './traceParser';

export type EditStats = {
  additions: number;
  deletions: number;
};

/** True when a trace carries edit/diff payload (path changes, line counts, or unified diff). */
export function isEditTrace(trace: TraceEvent): boolean {
  return trace.diff != null || trace.additions != null || trace.deletions != null;
}

/**
 * Resolve display-facing edit stats for a single trace.
 * Prefer numeric additions/deletions when present; fall back to counting
 * unified-diff lines. Includes a display-time repair for early transcript
 * builds that duplicated created-file content.
 */
export function displayEdit(trace: TraceEvent): {
  diff?: string;
  additions: number;
  deletions: number;
} {
  if (!trace.diff) {
    return { additions: trace.additions ?? 0, deletions: trace.deletions ?? 0 };
  }
  const lines = trace.diff.split('\n');
  const additions = lines.filter((line) => line.startsWith('+'));
  const deletions = lines.filter((line) => line.startsWith('-'));
  // Migration for the first transcript build: Grok repeated created-file
  // content in direct + nested fields, while numeric new_line=1 was treated as
  // deleted source. Repair those already-persisted traces at display time.
  if (
    additions.length > 0 &&
    additions.length % 2 === 0 &&
    deletions.length > 0 &&
    deletions.every((line) => /^-\d+$/u.test(line))
  ) {
    const half = additions.length / 2;
    const first = additions.slice(0, half);
    const second = additions.slice(half);
    if (first.every((line, index) => line === second[index])) {
      return { diff: first.join('\n'), additions: half, deletions: 0 };
    }
  }
  return {
    diff: trace.diff,
    additions: trace.additions ?? additions.length,
    deletions: trace.deletions ?? deletions.length,
  };
}

/** Sum additions/deletions across traces (non-edit traces contribute 0). */
export function sumEditStats(traces: readonly TraceEvent[]): EditStats {
  return traces.reduce<EditStats>(
    (totals, trace) => {
      const edit = displayEdit(trace);
      totals.additions += edit.additions;
      totals.deletions += edit.deletions;
      return totals;
    },
    { additions: 0, deletions: 0 },
  );
}
