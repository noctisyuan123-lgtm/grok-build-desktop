import type { ChatMessage } from '../app/types';
import type { TraceEvent } from './traceParser';

export type SessionTask = TraceEvent & { runId: string };
export function isLongTask(trace: TraceEvent, now: number): boolean {
  if (trace.kind === 'subagent' || /^\[subagent[:\]]/i.test(trace.label)) return false;
  if (trace.kind === 'task') return true;
  const text = `${trace.label} ${trace.command ?? ''}`;
  return (
    /\b(sleep|wait|exec|execute|shell|bash|zsh|process|spawn|download|build|test|install)\b/i.test(
      text,
    ) || (trace.endedAt ?? now) - trace.startedAt >= 5_000
  );
}

/** Active work only. Completed calls belong in the transcript, never this HUD. */
export function collectSessionTasks(
  messages: readonly ChatMessage[],
  live: ReadonlyMap<string, readonly TraceEvent[]>,
  now: number,
): SessionTask[] {
  const all = new Map<string, SessionTask>();
  for (const message of messages) {
    const runId = message.runId ?? `msg:${message.id}`;
    for (const trace of [...(message.meta?.traces ?? []), ...(live.get(runId) ?? [])]) {
      all.set(`${runId}:${trace.key}`, { ...trace, runId });
    }
  }
  return [...all.values()].filter((trace) => trace.status === 'running' && isLongTask(trace, now));
}
