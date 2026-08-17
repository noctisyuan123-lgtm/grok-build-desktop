// Merge live streamStore snapshots into persisted ChatMessage rows.
//
// Live UI reads streamStore directly, but only `messages` is written to
// localStorage / tabs / session_state.json. Without mid-stream checkpoints,
// quitting while a run is still "running" leaves assistant content:"" and the
// reply vanishes after restart (streamStore is in-memory only).
import type { ChatMessage, ChatMessageStatus } from '../app/types';
import { resolvePlanEntriesFromTraces } from '../components/PlanTodoList';
import { streamStore, type RunSnapshot, type TranscriptSegment } from './streamStore';
import type { TraceEvent } from './traceParser';

export type MergeStreamMode = 'terminal' | 'checkpoint' | 'all';

function compactTraces(traces: TraceEvent[]): TraceEvent[] {
  return traces.map(({ raw: _raw, ...trace }) => trace).slice(-100);
}

function compactTranscript(transcript: TranscriptSegment[]): TranscriptSegment[] {
  return transcript.slice(-100).map((segment) =>
    segment.kind === 'thought' ? { ...segment, text: segment.text.slice(-20_000) } : segment,
  );
}

function terminalStatus(state: RunSnapshot['state']): ChatMessageStatus {
  if (state === 'done') return 'done';
  if (state === 'cancelled') return 'stopped';
  return 'error';
}

function isLiveState(state: RunSnapshot['state']): boolean {
  return state === 'queued' || state === 'running';
}

/** Cheap change detector so debounced checkpoints do not thrash React state. */
export function streamPersistFingerprint(snap: RunSnapshot): string {
  return [
    snap.state,
    snap.textChars,
    snap.thoughtChars,
    snap.transcript.length,
    snap.traces.length,
    snap.sessionId ?? '',
    snap.lastEventType ?? '',
  ].join('|');
}

function sameCheckpoint(
  message: ChatMessage,
  content: string,
  traces: TraceEvent[],
  transcript: TranscriptSegment[],
  sessionId: string | null,
): boolean {
  if ((message.content || '') !== (content || '')) return false;
  if ((message.meta?.sessionId ?? null) !== (sessionId ?? null)) return false;
  const prevTraces = message.meta?.traces ?? [];
  if (prevTraces.length !== traces.length) return false;
  if (JSON.stringify(prevTraces) !== JSON.stringify(traces)) return false;
  const prevTranscript = message.meta?.transcript ?? [];
  if (prevTranscript.length !== transcript.length) return false;
  const prevLast = prevTranscript.at(-1);
  const nextLast = transcript.at(-1);
  if (!prevLast && !nextLast) return true;
  if (!prevLast || !nextLast || prevLast.kind !== nextLast.kind) return false;
  if (prevLast.kind === 'thought' && nextLast.kind === 'thought') {
    return prevLast.text === nextLast.text && prevLast.endedAt === nextLast.endedAt;
  }
  if (prevLast.kind === 'response' && nextLast.kind === 'response') {
    return prevLast.text === nextLast.text;
  }
  if (prevLast.kind === 'tools' && nextLast.kind === 'tools') {
    return prevLast.traceKeys.join('\0') === nextLast.traceKeys.join('\0');
  }
  return false;
}

/**
 * Apply streamStore state onto assistant messages.
 *
 * - `terminal`: only finalize ended runs (+ late sessionId attach)
 * - `checkpoint`: only write partial content/transcript while still live
 * - `all`: both
 */
export function mergeStreamIntoMessages(
  current: ChatMessage[],
  mode: MergeStreamMode = 'all',
  getSnapshot: (runId: string) => RunSnapshot | undefined = streamStore.getRunSnapshot,
): { next: ChatMessage[]; changed: boolean } {
  let changed = false;
  const allowTerminal = mode === 'terminal' || mode === 'all';
  const allowCheckpoint = mode === 'checkpoint' || mode === 'all';

  const next = current.map((message) => {
    if (message.role !== 'assistant' || !message.runId) {
      return message;
    }
    const snap = getSnapshot(message.runId);

    // Already finalized: still allow a late session id from the end event.
    if (message.status !== 'streaming') {
      if (
        allowTerminal &&
        snap?.sessionId &&
        message.meta?.sessionId !== snap.sessionId
      ) {
        changed = true;
        return { ...message, meta: { ...message.meta, sessionId: snap.sessionId } };
      }
      return message;
    }

    if (!snap) return message;

    const traces = compactTraces(snap.traces);
    const transcript = compactTranscript(snap.transcript);
    const planEntries = resolvePlanEntriesFromTraces(snap.traces) ?? message.meta?.planEntries;
    const content = snap.text || message.content;

    if (isLiveState(snap.state)) {
      if (!allowCheckpoint) return message;
      if (sameCheckpoint(message, content, traces, transcript, snap.sessionId)) {
        return message;
      }
      // Nothing useful yet — avoid rewriting empty shells every tick.
      if (!content && traces.length === 0 && transcript.length === 0 && !snap.sessionId) {
        return message;
      }
      changed = true;
      return {
        ...message,
        content,
        status: 'streaming' as const,
        meta: {
          ...message.meta,
          ...(traces.length === 0 ? {} : { traces }),
          ...(transcript.length === 0 ? {} : { transcript }),
          ...(planEntries?.length ? { planEntries } : {}),
          ...(snap.sessionId ? { sessionId: snap.sessionId } : {}),
        },
      };
    }

    if (!allowTerminal) return message;

    changed = true;
    const status = terminalStatus(snap.state);
    const durationMs =
      snap.startedAt != null && snap.endedAt != null
        ? Math.max(0, snap.endedAt - snap.startedAt)
        : message.meta?.durationMs;
    return {
      ...message,
      content,
      status,
      meta: {
        ...message.meta,
        ...(durationMs == null ? {} : { durationMs }),
        ...(traces.length === 0 ? {} : { traces }),
        ...(transcript.length === 0 ? {} : { transcript }),
        ...(planEntries?.length ? { planEntries } : {}),
        ...(snap.sessionId ? { sessionId: snap.sessionId } : {}),
      },
    };
  });

  return { next: changed ? next : current, changed };
}

/** Coerce orphaned in-flight rows after a process restart (cannot resume). */
export function coerceStreamingMessagesStopped(messages: ChatMessage[]): ChatMessage[] {
  let changed = false;
  const next = messages.map((message) => {
    if (message.role === 'assistant' && message.status === 'streaming') {
      changed = true;
      return { ...message, status: 'stopped' as ChatMessageStatus };
    }
    return message;
  });
  return changed ? next : messages;
}
