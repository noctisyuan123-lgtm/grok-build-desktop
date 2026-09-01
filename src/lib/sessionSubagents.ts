import type { TraceEvent } from './traceParser';

export type SessionSubagent = TraceEvent & { runId: string };

export type MessageTraceSource = {
  runId?: string;
  traces?: readonly TraceEvent[];
};

/**
 * All subagents belonging to this UI session. Live streamStore traces win
 * over persisted message traces so a running child stays current.
 */
export function collectSessionSubagents(
  sessionRunIds: readonly string[],
  messageTraces: readonly MessageTraceSource[],
  liveTraces: ReadonlyMap<string, readonly TraceEvent[]>,
): SessionSubagent[] {
  const seen = new Set<string>();
  const items: SessionSubagent[] = [];

  const add = (runId: string, traces: readonly TraceEvent[]) => {
    for (const trace of traces) {
      if (trace.kind !== 'subagent' || seen.has(trace.key)) continue;
      seen.add(trace.key);
      items.push({ ...trace, runId });
    }
  };

  for (const runId of sessionRunIds) {
    if (!runId) continue;
    add(runId, liveTraces.get(runId) ?? []);
  }
  for (const message of messageTraces) {
    if (!message.runId || !message.traces?.length) continue;
    add(message.runId, message.traces);
  }
  return items;
}

export function partitionSessionSubagents(items: readonly SessionSubagent[]): {
  active: SessionSubagent[];
  done: SessionSubagent[];
} {
  const active: SessionSubagent[] = [];
  const done: SessionSubagent[] = [];
  for (const item of items) {
    if (item.status === 'running') active.push(item);
    else done.push(item);
  }
  return { active, done };
}
