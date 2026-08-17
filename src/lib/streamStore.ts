import { listen, type UnlistenFn } from '@tauri-apps/api/event';
import {
  classifyEvent,
  extractRunError,
  extractUsage,
  type RunUsage,
  type TraceEvent,
  type TraceStatus,
} from './traceParser';
import { hasTauriRuntime } from './runtime';

export type GrokEvent =
  | { type: 'thought'; data: string }
  | { type: 'text'; data: string }
  | { type: 'end'; stopReason: string; sessionId: string; requestId: string }
  | { type: string; [k: string]: unknown };

export type RunState = 'queued' | 'running' | 'done' | 'cancelled' | 'failed';

export type RunCompletionState = Extract<RunState, 'done' | 'failed'>;

export interface RunCompletion {
  runId: string;
  state: RunCompletionState;
  endedAt: number | null;
}

export type TranscriptSegment =
  | {
      key: string;
      kind: 'thought';
      text: string;
      startedAt: number;
      endedAt: number | null;
    }
  | { key: string; kind: 'response'; text: string }
  | { key: string; kind: 'tools'; traceKeys: string[] };

export interface RunSnapshot {
  id: string;
  state: RunState;
  startedAt: number | null;
  endedAt: number | null;
  thoughtChars: number;
  textChars: number;
  lastEventType: 'thought' | 'text' | 'activity' | 'end' | null;
  text: string;
  htmlVersion: number;
  stopReason: string | null;
  /** Grok conversation head produced by this run. Used to fork follow-ups. */
  sessionId: string | null;
  error: string | null;
  /** Authoritative token totals emitted by Grok; null until the first usage line. */
  usage: RunUsage | null;
  /** Tool / subagent / task trace cards, in order of first appearance. */
  traces: TraceEvent[];
  /** Ordered ACP transcript. This keeps Thought -> Respond -> Tool -> Respond intact. */
  transcript: TranscriptSegment[];
}

export interface QueuedRunMeta {
  id: string;
  prompt: string;
  cwd?: string;
  state: 'Queued' | 'Running' | 'Done' | 'Cancelled' | 'Failed';
  enqueuedAt: number;
  laneId?: string;
}

interface QueueSnapshot {
  /** First concurrent active for backward compatibility. Prefer `activeIds`. */
  active: string | null;
  /** Every run currently executing (one per busy lane). */
  activeIds: string[];
  items: QueuedRunMeta[];
}

type Listener = () => void;
type CompletionListener = (completion: RunCompletion) => void;

class StreamStore {
  private runs = new Map<string, RunSnapshot>();
  private html = new Map<string, string>();
  private queue: QueueSnapshot = { active: null, activeIds: [], items: [] };
  private listeners = new Set<Listener>();
  private completionListeners = new Set<CompletionListener>();
  private completedRunIds = new Set<string>();

  subscribe = (l: Listener): (() => void) => {
    this.listeners.add(l);
    return () => this.listeners.delete(l);
  };

  subscribeCompletions = (l: CompletionListener): (() => void) => {
    this.completionListeners.add(l);
    return () => this.completionListeners.delete(l);
  };

  private notify() {
    this.listeners.forEach((l) => l());
  }

  markCompletion = (runId: string, state: RunCompletionState, endedAt: number | null): void => {
    if (this.completedRunIds.has(runId)) return;
    this.completedRunIds.add(runId);
    const completion = { runId, state, endedAt } satisfies RunCompletion;
    this.completionListeners.forEach((listener) => listener(completion));
  };

  getRunSnapshot = (id: string): RunSnapshot | undefined => this.runs.get(id);
  getHtml = (id: string): string | undefined => this.html.get(id);
  getQueueSnapshot = (): QueueSnapshot => this.queue;
  /**
   * Stable primitive snapshot for sidebar/session indicators. The queue event
   * covers queued work while run patches cover the running -> finished edge;
   * returning a string lets useSyncExternalStore detect activity changes
   * without allocating a fresh Set on every render.
   */
  getInflightRunIdsSnapshot = (): string => {
    const ids = new Set<string>();
    for (const id of this.queue.activeIds) ids.add(id);
    for (const item of this.queue.items) {
      if (item.state === 'Queued' || item.state === 'Running') ids.add(item.id);
    }
    for (const [id, run] of this.runs) {
      if (run.state === 'queued' || run.state === 'running') ids.add(id);
    }
    return Array.from(ids).sort().join('\0');
  };
  /**
   * Snapshot for a single concurrent active. Prefers `activeIds[0]`, then the
   * legacy `active` field. Session-scoped UI should look up runs by message
   * `runId` instead of this global head.
   */
  getActiveRunSnapshot = (): RunSnapshot | undefined => {
    for (const id of this.queue.activeIds) {
      const snap = this.runs.get(id);
      if (snap) return snap;
    }
    return this.queue.active ? this.runs.get(this.queue.active) : undefined;
  };

  patchRun = (id: string, patch: Partial<RunSnapshot>): void => {
    const cur = this.runs.get(id) ?? this.makeEmpty(id);
    this.runs.set(id, { ...cur, ...patch });
    this.notify();
  };

  setHtml = (id: string, html: string): void => {
    this.html.set(id, html);
    const cur = this.runs.get(id);
    if (cur) {
      this.runs.set(id, { ...cur, htmlVersion: cur.htmlVersion + 1 });
    }
    this.notify();
  };

  setQueue = (q: {
    active?: string | null;
    activeIds?: string[];
    items?: QueuedRunMeta[];
  }): void => {
    const activeIds =
      q.activeIds ??
      (q.active ? [q.active] : []);
    this.queue = {
      active: q.active ?? activeIds[0] ?? null,
      activeIds,
      items: q.items ?? [],
    };
    this.notify();
  };

  private makeEmpty(id: string): RunSnapshot {
    return {
      id,
      state: 'queued',
      startedAt: null,
      endedAt: null,
      thoughtChars: 0,
      textChars: 0,
      lastEventType: null,
      text: '',
      htmlVersion: 0,
      stopReason: null,
      sessionId: null,
      error: null,
      usage: null,
      traces: [],
      transcript: [],
    };
  }

  /** Test helper. */
  __reset = (): void => {
    this.runs.clear();
    this.html.clear();
    this.queue = { active: null, activeIds: [], items: [] };
    this.completedRunIds.clear();
    this.listeners.clear();
    this.completionListeners.clear();
  };
}

export const streamStore = new StreamStore();

export function applyRunEvent(runId: string, event: GrokEvent, raw?: unknown): void {
  const cur = streamStore.getRunSnapshot(runId);
  const usage = extractUsage(raw);
  if (event.type === 'thought') {
    const { data } = event as Extract<GrokEvent, { type: 'thought' }>;
    const now = Date.now();
    streamStore.patchRun(runId, {
      thoughtChars: (cur?.thoughtChars ?? 0) + data.length,
      transcript: appendThought(cur?.transcript ?? [], data, now),
      lastEventType: 'thought',
      state: cur?.state === 'queued' ? 'running' : (cur?.state ?? 'running'),
    });
  } else if (event.type === 'text') {
    const { data } = event as Extract<GrokEvent, { type: 'text' }>;
    const nextText = (cur?.text ?? '') + data;
    const nextTranscript = appendResponse(cur?.transcript ?? [], data);
    streamStore.patchRun(runId, {
      text: nextText,
      textChars: (cur?.textChars ?? 0) + data.length,
      transcript: nextTranscript,
      lastEventType: 'text',
      state: cur?.state === 'queued' ? 'running' : (cur?.state ?? 'running'),
    });
    // Lazy-import to keep the worker out of unit-test bundles (vitest jsdom).
    import('./markdownWorker')
      .then(({ scheduleMarkdownParse }) => {
        // Full accumulated text under bare runId (legacy / non-transcript paths).
        scheduleMarkdownParse(runId, nextText);
        // Exterior final body is only the trailing response segment — never mid
        // + final stitched together. MessageItem reads `${runId}:exterior:i`.
        const last = nextTranscript.at(-1);
        if (last?.kind === 'response') {
          scheduleMarkdownParse(
            exteriorMarkdownKey(runId, nextTranscript.length - 1),
            last.text,
          );
        }
      })
      .catch(() => {
        /* worker unavailable; MessageItem will render raw text */
      });
  } else if (event.type === 'end') {
    // Final parse: bare runId keeps full text; exterior key is last respond only.
    const lastResponseIndex = (() => {
      const transcript = cur?.transcript ?? [];
      for (let i = transcript.length - 1; i >= 0; i -= 1) {
        if (transcript[i]?.kind === 'response') return i;
      }
      return -1;
    })();
    const lastResponse =
      lastResponseIndex >= 0 ? cur?.transcript[lastResponseIndex] : null;
    if (cur?.text || (lastResponse?.kind === 'response' && lastResponse.text)) {
      import('./markdownWorker')
        .then(({ scheduleMarkdownParse }) => {
          if (cur?.text) scheduleMarkdownParse(runId, cur.text);
          if (lastResponse?.kind === 'response') {
            scheduleMarkdownParse(
              exteriorMarkdownKey(runId, lastResponseIndex),
              lastResponse.text,
            );
          }
        })
        .catch(() => {});
    }
    const e = event as Extract<GrokEvent, { type: 'end' }>;
    const endedAt = Date.now();
    streamStore.patchRun(runId, {
      state: 'done',
      lastEventType: 'end',
      stopReason: e.stopReason,
      sessionId: e.sessionId,
      endedAt,
      usage: usage ?? cur?.usage ?? null,
      traces: reconcileOpenTraces(cur?.traces ?? [], 'done'),
      transcript: closeThought(cur?.transcript ?? [], endedAt),
    });
    streamStore.markCompletion(runId, 'done', endedAt);
  } else if (raw) {
    const runError = extractRunError(raw);
    if (runError) {
      const endedAt = Date.now();
      streamStore.patchRun(runId, {
        state: 'failed',
        endedAt,
        error: runError,
        usage: usage ?? cur?.usage ?? null,
        traces: reconcileOpenTraces(cur?.traces ?? [], 'error'),
        transcript: closeThought(cur?.transcript ?? [], endedAt),
      });
      streamStore.markCompletion(runId, 'failed', endedAt);
      return;
    }

    if (usage) {
      streamStore.patchRun(runId, { usage });
    }

    // Unknown typed event — normalise official ACP and legacy activity shapes.
    const result = classifyEvent(raw);
    if (result.kind === 'upsert') {
      const existing = cur?.traces ?? [];
      const idx = existing.findIndex((trace) => trace.key === result.event.key);
      if (idx >= 0) {
        const updated = [...existing];
        updated[idx] = {
          ...updated[idx]!,
          ...result.event,
          // Updates should not reset elapsed time, and missing optional fields
          // must not erase useful data captured by the start event.
          startedAt: updated[idx]!.startedAt,
          label:
            result.event.label === 'Tool' || result.event.label === 'Subagent'
              ? updated[idx]!.label
              : result.event.label,
          detail: result.event.detail ?? updated[idx]!.detail,
          parentKey: result.event.parentKey ?? updated[idx]!.parentKey,
          progress: result.event.progress ?? updated[idx]!.progress,
          path: result.event.path ?? updated[idx]!.path,
          diff: result.event.diff ?? updated[idx]!.diff,
          additions: result.event.additions ?? updated[idx]!.additions,
          deletions: result.event.deletions ?? updated[idx]!.deletions,
        };
        streamStore.patchRun(runId, {
          traces: updated,
          lastEventType: result.event.status === 'running' ? 'activity' : cur?.lastEventType,
          state: cur?.state === 'queued' ? 'running' : (cur?.state ?? 'running'),
        });
      } else {
        streamStore.patchRun(runId, {
          traces: [...existing, result.event],
          transcript: appendTool(cur?.transcript ?? [], result.event.key),
          lastEventType: result.event.status === 'running' ? 'activity' : cur?.lastEventType,
          state: cur?.state === 'queued' ? 'running' : (cur?.state ?? 'running'),
        });
      }
    }
  }
  // Unknown events without raw payload: ignore (forward-compat).
}

export function applyStateChange(
  runId: string,
  payload: {
    state: 'Queued' | 'Running' | 'Done' | 'Cancelled' | 'Failed';
    startedAt?: number | null;
    endedAt?: number | null;
    error?: string | null;
  },
): void {
  const current = streamStore.getRunSnapshot(runId);
  const state = payload.state.toLowerCase() as RunState;
  const terminalStatus: TraceStatus | null =
    state === 'done'
      ? 'done'
      : state === 'failed'
        ? 'error'
        : state === 'cancelled'
          ? 'cancelled'
          : null;
  const endedAt = payload.endedAt ?? current?.endedAt ?? (terminalStatus ? Date.now() : null);
  streamStore.patchRun(runId, {
    state,
    startedAt: payload.startedAt ?? current?.startedAt ?? null,
    endedAt,
    error: payload.error ?? current?.error ?? null,
    traces: terminalStatus
      ? reconcileOpenTraces(current?.traces ?? [], terminalStatus)
      : (current?.traces ?? []),
    transcript: terminalStatus
      ? closeThought(current?.transcript ?? [], payload.endedAt ?? Date.now())
      : (current?.transcript ?? []),
  });
  if (state === 'done' || state === 'failed') {
    streamStore.markCompletion(runId, state, endedAt);
  }
}

/** Markdown cache key for the exterior final body (last respond segment only). */
export function exteriorMarkdownKey(runId: string, responseIndex: number): string {
  return `${runId}:exterior:${responseIndex}`;
}

const MAX_THOUGHT_CHARS = 20_000;

function closeThought(segments: TranscriptSegment[], endedAt: number): TranscriptSegment[] {
  const last = segments.at(-1);
  if (!last || last.kind !== 'thought' || last.endedAt != null) return segments;
  return [...segments.slice(0, -1), { ...last, endedAt }];
}

function appendThought(
  segments: TranscriptSegment[],
  text: string,
  now: number,
): TranscriptSegment[] {
  const closed = closeThought(segments, now);
  const last = segments.at(-1);
  if (last?.kind === 'thought' && last.endedAt == null) {
    return [
      ...segments.slice(0, -1),
      { ...last, text: (last.text + text).slice(-MAX_THOUGHT_CHARS) },
    ];
  }
  return [
    ...closed,
    {
      key: `thought:${segments.length}`,
      kind: 'thought',
      text: text.slice(-MAX_THOUGHT_CHARS),
      startedAt: now,
      endedAt: null,
    },
  ];
}

function appendResponse(segments: TranscriptSegment[], text: string): TranscriptSegment[] {
  const closed = closeThought(segments, Date.now());
  const last = closed.at(-1);
  if (last?.kind === 'response') {
    return [...closed.slice(0, -1), { ...last, text: last.text + text }];
  }
  return [...closed, { key: `response:${closed.length}`, kind: 'response', text }];
}

function appendTool(segments: TranscriptSegment[], traceKey: string): TranscriptSegment[] {
  const closed = closeThought(segments, Date.now());
  const last = closed.at(-1);
  if (last?.kind === 'tools') {
    return last.traceKeys.includes(traceKey)
      ? closed
      : [...closed.slice(0, -1), { ...last, traceKeys: [...last.traceKeys, traceKey] }];
  }
  return [...closed, { key: `tools:${closed.length}`, kind: 'tools', traceKeys: [traceKey] }];
}

function reconcileOpenTraces(traces: TraceEvent[], status: TraceStatus): TraceEvent[] {
  const endedAt = Date.now();
  return traces.map((trace) =>
    trace.status === 'running' ? { ...trace, status, endedAt } : trace,
  );
}

export function replaceQueue(
  q: Partial<QueueSnapshot> & { items: QueuedRunMeta[] },
): void {
  const activeIds =
    q.activeIds ??
    (q.active ? [q.active] : streamStore.getQueueSnapshot().activeIds);
  streamStore.setQueue({
    active: q.active ?? activeIds[0] ?? null,
    activeIds,
    items: q.items,
  });
}

/**
 * Counter of pending `enqueue_run` invocations. The Composer increments this
 * before calling invoke() and decrements after the run-id is returned (or
 * the call fails). StatusBar reads it via a hook to render "preparing…" in
 * the gap between Enter and the first run-state-changed event.
 */
let pendingSubmitCount = 0;
const pendingSubmitListeners = new Set<() => void>();

export function getPendingSubmitCount(): number {
  return pendingSubmitCount;
}
export function subscribePendingSubmit(cb: () => void): () => void {
  pendingSubmitListeners.add(cb);
  return () => pendingSubmitListeners.delete(cb);
}
export function notePendingSubmitStart(): void {
  pendingSubmitCount += 1;
  pendingSubmitListeners.forEach((cb) => cb());
}
export function notePendingSubmitEnd(): void {
  pendingSubmitCount = Math.max(0, pendingSubmitCount - 1);
  pendingSubmitListeners.forEach((cb) => cb());
}

let unlistenFns: UnlistenFn[] = [];
let attachInflight: Promise<void> | null = null;
let attachUnavailable = false;

export async function attachTauriListeners(): Promise<void> {
  if (unlistenFns.length > 0 || attachUnavailable) return;
  if (!hasTauriRuntime()) {
    // Running in vite browser preview without the Tauri shell: skip silently.
    // This is the only permanent latch — a failed listen() below must NOT
    // latch, otherwise one transient IPC hiccup at startup leaves the app
    // permanently deaf to run events with no way to retry.
    attachUnavailable = true;
    return;
  }
  // De-dupe parallel callers and StrictMode double-mounts.
  if (attachInflight) return attachInflight;
  attachInflight = (async () => {
    // Collect as we go so a mid-sequence failure can detach the listeners
    // that DID attach — a later retry must not stack duplicate handlers.
    const attached: UnlistenFn[] = [];
    try {
      attached.push(
        await listen<{ runId: string; event: GrokEvent; raw?: unknown }>(
          'grok-desktop://run-event',
          (e) => applyRunEvent(e.payload.runId, e.payload.event, e.payload.raw),
        ),
      );
      attached.push(
        await listen<{
          runId: string;
          state: 'Queued' | 'Running' | 'Done' | 'Cancelled' | 'Failed';
          startedAt?: number;
          endedAt?: number;
          error?: string;
        }>('grok-desktop://run-state-changed', (e) => applyStateChange(e.payload.runId, e.payload)),
      );
      attached.push(
        await listen<{
          active: string | null;
          activeIds?: string[];
          queue: QueuedRunMeta[];
        }>('grok-desktop://queue-changed', (e) =>
          replaceQueue({
            active: e.payload.active,
            activeIds: e.payload.activeIds,
            items: e.payload.queue,
          }),
        ),
      );
      unlistenFns = attached;
    } catch (err) {
      attached.forEach((fn) => fn());
      throw err;
    } finally {
      attachInflight = null;
    }
  })();
  return attachInflight;
}

export function detachTauriListeners(): void {
  unlistenFns.forEach((fn) => fn());
  unlistenFns = [];
}
