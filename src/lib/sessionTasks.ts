import type { ChatMessage } from '../app/types';
import { streamStore } from './streamStore';
import {
  commandFromRaw,
  displayToolLabel,
  unwrapExecuteBody,
  type TraceEvent,
} from './traceParser';

export type SessionTask = TraceEvent & { runId: string; source?: 'tool' | 'monitor' };

/** Wait/download-class work is a HUD task immediately; everything else waits 5s. */
const IMMEDIATE_TASK = /\b(sleep|wait|download|curl|wget)\b/i;

export function taskCommand(trace: TraceEvent): string | undefined {
  return trace.command ?? commandFromRaw(trace.raw) ?? unwrapExecuteBody(trace.label);
}

export function taskTitle(trace: TraceEvent): string {
  return displayToolLabel(trace.label, taskCommand(trace));
}

export function isLongTask(trace: TraceEvent, now: number): boolean {
  if (trace.kind === 'subagent' || /^\[subagent[:\]]/i.test(trace.label)) return false;
  // Plans have their own floating panel — never the Tasks HUD.
  if (trace.kind === 'task') return false;
  const text = `${trace.label} ${taskCommand(trace) ?? ''}`;
  return IMMEDIATE_TASK.test(text) || (trace.endedAt ?? now) - trace.startedAt >= 5_000;
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

/** Idle-watch monitors are not traces; surface them in the Tasks HUD. */
export function collectWatchingMonitors(
  messages: readonly ChatMessage[],
  now: number,
): SessionTask[] {
  const seen = new Set<string>();
  const items: SessionTask[] = [];
  for (const message of messages) {
    const runId = message.runId;
    if (!runId || seen.has(runId)) continue;
    seen.add(runId);
    const snap = streamStore.getRunSnapshot(runId);
    if (!snap?.watching) continue;
    const title = snap.watchingLabel?.trim();
    items.push({
      key: `monitor:${runId}`,
      kind: 'other',
      label: title || 'Monitor',
      status: 'running',
      startedAt: snap.watchingStartedAt ?? snap.endedAt ?? now,
      endedAt: null,
      runId,
      source: 'monitor',
      detail: title || 'Background monitor',
    });
  }
  return items;
}
