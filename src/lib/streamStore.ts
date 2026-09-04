import { listen, type UnlistenFn } from '@tauri-apps/api/event';
import {
  classifyEvent,
  extractCompaction,
  extractRunError,
  extractUsage,
  type RunCompaction,
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
  /** ACP session that owns the parent turn; child sessions are kept on traces. */
  rootSessionId?: string | null;
  error: string | null;
  /** Authoritative token totals emitted by Grok; null until the first usage line. */
  usage: RunUsage | null;
  /** Auto-compaction status for the current turn, if any. */
  compaction: RunCompaction | null;
  /** Tool / subagent / task trace cards, in order of first appearance. */
  traces: TraceEvent[];
  /** Ordered ACP transcript. This keeps Thought -> Respond -> Tool -> Respond intact. */
  transcript: TranscriptSegment[];
  /** Background monitors still running after this turn ended. */
  watching?: boolean;
  watchingStartedAt?: number | null;
  watchingLabel?: string | null;
}

/** A watcher is attached after the visible turn has finished. It must not
 * keep the composer, history marker, or Undo controls in the ordinary live
 * state even if the terminal state event is still crossing the IPC boundary. */
export function isRunInFlight(run: Pick<RunSnapshot, 'state' | 'watching'> | undefined): boolean {
  return Boolean(run && (run.state === 'queued' || run.state === 'running') && !run.watching);
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
  private notifyScheduled = false;
  private cancelScheduledNotify: (() => void) | null = null;

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

  /**
   * Publish text deltas at most once per animation frame. The run map is
   * updated synchronously, so event handlers can still read the latest state;
   * only React subscribers wait for the coalesced notification.
   */
  scheduleNotify = (): void => {
    if (this.notifyScheduled) return;
    this.notifyScheduled = true;
    const flush = () => {
      this.notifyScheduled = false;
      this.cancelScheduledNotify = null;
      this.notify();
    };
    if (typeof requestAnimationFrame === 'function') {
      const frame = requestAnimationFrame(flush);
      this.cancelScheduledNotify = () => cancelAnimationFrame(frame);
    } else {
      const timer = setTimeout(flush, 16);
      this.cancelScheduledNotify = () => clearTimeout(timer);
    }
  };

  private notifyNow(): void {
    this.cancelScheduledNotify?.();
    this.cancelScheduledNotify = null;
    this.notifyScheduled = false;
    this.notify();
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
    for (const id of this.queue.activeIds) {
      const run = this.runs.get(id);
      if (!run || isRunInFlight(run)) ids.add(id);
    }
    for (const item of this.queue.items) {
      if (item.state === 'Queued' || item.state === 'Running') ids.add(item.id);
    }
    for (const [id, run] of this.runs) {
      if (isRunInFlight(run)) ids.add(id);
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
      if (snap && isRunInFlight(snap)) return snap;
    }
    const active = this.queue.active ? this.runs.get(this.queue.active) : undefined;
    return active && isRunInFlight(active) ? active : undefined;
  };

  patchRun = (id: string, patch: Partial<RunSnapshot>, options?: { notify?: boolean }): void => {
    const cur = this.runs.get(id) ?? this.makeEmpty(id);
    this.runs.set(id, { ...cur, ...patch });
    if (options?.notify !== false) this.notifyNow();
  };

  setHtml = (id: string, html: string): void => {
    this.html.set(id, html);
    const cur = this.runs.get(id);
    if (cur) {
      this.runs.set(id, { ...cur, htmlVersion: cur.htmlVersion + 1 });
    }
    this.notifyNow();
  };

  setQueue = (q: {
    active?: string | null;
    activeIds?: string[];
    items?: QueuedRunMeta[];
  }): void => {
    const activeIds = q.activeIds ?? (q.active ? [q.active] : []);
    this.queue = {
      active: q.active ?? activeIds[0] ?? null,
      activeIds,
      items: q.items ?? [],
    };
    this.notifyNow();
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
      rootSessionId: null,
      error: null,
      usage: null,
      compaction: null,
      traces: [],
      transcript: [],
      watching: false,
      watchingStartedAt: null,
      watchingLabel: null,
    };
  }

  /** Test helper. */
  __reset = (): void => {
    this.runs.clear();
    this.html.clear();
    this.queue = { active: null, activeIds: [], items: [] };
    this.completedRunIds.clear();
    this.cancelScheduledNotify?.();
    this.cancelScheduledNotify = null;
    this.notifyScheduled = false;
    this.listeners.clear();
    this.completionListeners.clear();
  };
}

export const streamStore = new StreamStore();

export function applyRunEvent(
  runId: string,
  event: GrokEvent,
  raw?: unknown,
  protocolSessionId?: string,
): void {
  const cur = streamStore.getRunSnapshot(runId);
  const sessionId = protocolSessionId ?? readSessionId(raw);
  const usage = extractUsage(raw);
  if (event.type === 'thought') {
    const { data } = event as Extract<GrokEvent, { type: 'thought' }>;
    const now = Date.now();
    const owner = findSubagentOwner(cur?.traces ?? [], sessionId, cur?.rootSessionId);
    if (owner) {
      streamStore.patchRun(runId, {
        traces: updateSubagentTranscript(cur?.traces ?? [], owner.key, (transcript) =>
          appendThought(transcript, data, now),
        ),
        lastEventType: 'activity',
        state: cur?.state === 'queued' ? 'running' : (cur?.state ?? 'running'),
      });
      return;
    }
    streamStore.patchRun(runId, {
      thoughtChars: (cur?.thoughtChars ?? 0) + data.length,
      transcript: appendThought(cur?.transcript ?? [], data, now),
      lastEventType: 'thought',
      sessionId: cur?.sessionId ?? sessionId ?? null,
      rootSessionId: cur?.rootSessionId ?? sessionId ?? null,
      state: cur?.state === 'queued' ? 'running' : (cur?.state ?? 'running'),
    });
  } else if (event.type === 'text') {
    const { data } = event as Extract<GrokEvent, { type: 'text' }>;
    const owner = findSubagentOwner(cur?.traces ?? [], sessionId, cur?.rootSessionId);
    if (owner) {
      const ownerTranscript = owner.transcript ?? [];
      const startsResponse = ownerTranscript.at(-1)?.kind !== 'response';
      streamStore.patchRun(
        runId,
        {
          traces: updateSubagentTranscript(cur?.traces ?? [], owner.key, (transcript) =>
            appendResponse(transcript, data),
          ),
          lastEventType: 'activity',
          state: cur?.state === 'queued' ? 'running' : (cur?.state ?? 'running'),
        },
        { notify: startsResponse },
      );
      if (!startsResponse) streamStore.scheduleNotify();
      return;
    }
    const nextText = (cur?.text ?? '') + data;
    const nextTranscript = appendResponse(cur?.transcript ?? [], data);
    const startsResponse = cur?.transcript.at(-1)?.kind !== 'response';
    streamStore.patchRun(
      runId,
      {
        text: nextText,
        textChars: (cur?.textChars ?? 0) + data.length,
        transcript: nextTranscript,
        lastEventType: 'text',
        sessionId: cur?.sessionId ?? sessionId ?? null,
        rootSessionId: cur?.rootSessionId ?? sessionId ?? null,
        state: cur?.state === 'queued' ? 'running' : (cur?.state ?? 'running'),
      },
      { notify: startsResponse },
    );
    if (!startsResponse) streamStore.scheduleNotify();
    // Lazy-import to keep the worker out of unit-test bundles (vitest jsdom).
    import('./markdownWorker')
      .then(({ scheduleMarkdownParse }) => {
        // Full accumulated text under bare runId (legacy / non-transcript paths).
        scheduleMarkdownParse(runId, nextText);
        // Exterior final body is only the trailing response segment — never mid
        // + final stitched together. MessageItem reads `${runId}:exterior:i`.
        const last = nextTranscript.at(-1);
        if (last?.kind === 'response') {
          scheduleMarkdownParse(exteriorMarkdownKey(runId, nextTranscript.length - 1), last.text);
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
    const lastResponse = lastResponseIndex >= 0 ? cur?.transcript[lastResponseIndex] : null;
    if (cur?.text || (lastResponse?.kind === 'response' && lastResponse.text)) {
      import('./markdownWorker')
        .then(({ scheduleMarkdownParse }) => {
          if (cur?.text) scheduleMarkdownParse(runId, cur.text, { immediate: true });
          if (lastResponse?.kind === 'response') {
            scheduleMarkdownParse(
              exteriorMarkdownKey(runId, lastResponseIndex),
              lastResponse.text,
              { immediate: true },
            );
          }
        })
        .catch(() => {});
    }
    const e = event as Extract<GrokEvent, { type: 'end' }>;
    const endedAt = Date.now();
    const cancelled = /cancel/i.test(e.stopReason);
    streamStore.patchRun(runId, {
      state: cancelled ? 'cancelled' : 'done',
      lastEventType: 'end',
      stopReason: e.stopReason,
      sessionId: cur?.sessionId ?? e.sessionId,
      rootSessionId: cur?.rootSessionId ?? sessionId ?? e.sessionId,
      endedAt,
      usage: usage ?? cur?.usage ?? null,
      traces: reconcileOpenTraces(cur?.traces ?? [], cancelled ? 'cancelled' : 'done'),
      transcript: closeThought(cur?.transcript ?? [], endedAt),
    });
    if (!cancelled) streamStore.markCompletion(runId, 'done', endedAt);
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

    const compaction = extractCompaction(raw);
    if (compaction) {
      streamStore.patchRun(runId, {
        compaction: mergeCompaction(cur?.compaction, compaction),
        sessionId: cur?.sessionId ?? sessionId ?? null,
        rootSessionId: cur?.rootSessionId ?? sessionId ?? null,
        state: cur?.state === 'queued' ? 'running' : (cur?.state ?? 'running'),
      });
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
      const eventSessionId = result.event.sessionId ?? sessionId;
      const owner =
        result.event.kind === 'subagent'
          ? null
          : findSubagentOwner(existing, eventSessionId, cur?.rootSessionId);
      const normalizedEvent = owner
        ? {
            ...result.event,
            parentKey: result.event.parentKey ?? owner.key,
            sessionId: result.event.sessionId ?? eventSessionId,
          }
        : result.event;
      if (idx >= 0) {
        const updated = [...existing];
        updated[idx] = {
          ...updated[idx]!,
          ...normalizedEvent,
          // Updates should not reset elapsed time, and missing optional fields
          // must not erase useful data captured by the start event.
          startedAt: updated[idx]!.startedAt,
          label:
            normalizedEvent.label === 'Tool' || normalizedEvent.label === 'Subagent'
              ? updated[idx]!.label
              : normalizedEvent.label,
          detail: normalizedEvent.detail ?? updated[idx]!.detail,
          prompt: updated[idx]!.prompt || normalizedEvent.prompt,
          parentKey: normalizedEvent.parentKey ?? updated[idx]!.parentKey,
          progress: normalizedEvent.progress ?? updated[idx]!.progress,
          path: normalizedEvent.path ?? updated[idx]!.path,
          diff: normalizedEvent.diff ?? updated[idx]!.diff,
          additions: normalizedEvent.additions ?? updated[idx]!.additions,
          deletions: normalizedEvent.deletions ?? updated[idx]!.deletions,
          sessionId: normalizedEvent.sessionId ?? updated[idx]!.sessionId,
          transcript: updated[idx]!.transcript,
        };
        streamStore.patchRun(runId, {
          traces: inheritSubagentPrompts(updated),
          lastEventType: normalizedEvent.status === 'running' ? 'activity' : cur?.lastEventType,
          rootSessionId: cur?.rootSessionId ?? (owner ? null : sessionId) ?? null,
          state: cur?.state === 'queued' ? 'running' : (cur?.state ?? 'running'),
        });
      } else {
        streamStore.patchRun(runId, {
          traces: inheritSubagentPrompts([...existing, normalizedEvent]),
          transcript: owner
            ? (cur?.transcript ?? [])
            : appendTool(cur?.transcript ?? [], normalizedEvent.key),
          lastEventType: normalizedEvent.status === 'running' ? 'activity' : cur?.lastEventType,
          rootSessionId: cur?.rootSessionId ?? (owner ? null : sessionId) ?? null,
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

export function applyWatching(
  runId: string,
  payload: {
    active: boolean;
    startedAt?: number | null;
    label?: string | null;
  },
): void {
  const current = streamStore.getRunSnapshot(runId);
  streamStore.patchRun(runId, {
    watching: payload.active,
    watchingStartedAt: payload.active
      ? (payload.startedAt ?? current?.watchingStartedAt ?? Date.now())
      : null,
    watchingLabel: payload.active ? (payload.label ?? current?.watchingLabel ?? null) : null,
  });
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

function mergeCompaction(
  prev: RunCompaction | null | undefined,
  next: RunCompaction,
): RunCompaction {
  return {
    status: next.status,
    percentage: next.percentage ?? prev?.percentage ?? null,
    tokensBefore: next.tokensBefore ?? prev?.tokensBefore ?? null,
    tokensAfter: next.tokensAfter ?? prev?.tokensAfter ?? null,
  };
}

function readSessionId(raw: unknown): string | undefined {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return undefined;
  const obj = raw as Record<string, unknown>;
  for (const key of ['sessionId', 'session_id', 'childSessionId', 'child_session_id']) {
    const value = obj[key];
    if (typeof value === 'string' && value) return value;
  }
  return undefined;
}

/** Copy a Task-tool prompt onto the matching subagent spawn (either order). */
function inheritSubagentPrompts(traces: TraceEvent[]): TraceEvent[] {
  const byLabel = new Map<string, string>();
  let lastToolPrompt: string | undefined;
  for (const trace of traces) {
    if (!trace.prompt || trace.kind === 'subagent') continue;
    lastToolPrompt = trace.prompt;
    byLabel.set(trace.label.trim().toLowerCase(), trace.prompt);
  }
  let changed = false;
  const next = traces.map((trace) => {
    if (trace.kind !== 'subagent' || trace.prompt) return trace;
    const inherited = byLabel.get(trace.label.trim().toLowerCase()) ?? lastToolPrompt;
    if (!inherited) return trace;
    changed = true;
    return { ...trace, prompt: inherited };
  });
  return changed ? next : traces;
}

function findSubagentOwner(
  traces: TraceEvent[],
  sessionId: string | undefined,
  rootSessionId: string | null | undefined,
): TraceEvent | null {
  if (!sessionId || sessionId === rootSessionId) return null;
  return (
    traces.find(
      (trace) =>
        trace.kind === 'subagent' &&
        (trace.sessionId === sessionId || trace.key === `subagent:${sessionId}`),
    ) ?? null
  );
}

function updateSubagentTranscript(
  traces: TraceEvent[],
  key: string,
  update: (transcript: TranscriptSegment[]) => TranscriptSegment[],
): TraceEvent[] {
  return traces.map((trace) =>
    trace.key === key ? { ...trace, transcript: update(trace.transcript ?? []) } : trace,
  );
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
    trace.status === 'running'
      ? {
          ...trace,
          status,
          endedAt,
          transcript: trace.transcript ? closeThought(trace.transcript, endedAt) : undefined,
        }
      : trace,
  );
}

export function replaceQueue(q: Partial<QueueSnapshot> & { items: QueuedRunMeta[] }): void {
  const activeIds =
    q.activeIds ?? (q.active ? [q.active] : streamStore.getQueueSnapshot().activeIds);
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
        await listen<{
          runId: string;
          event: GrokEvent;
          raw?: unknown;
          sessionId?: string | null;
        }>('grok-desktop://run-event', (e) =>
          applyRunEvent(
            e.payload.runId,
            e.payload.event,
            e.payload.raw,
            e.payload.sessionId ?? undefined,
          ),
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
          runId: string;
          active: boolean;
          startedAt?: number | null;
          label?: string | null;
        }>('grok-desktop://run-watching', (e) =>
          applyWatching(e.payload.runId, {
            active: e.payload.active,
            startedAt: e.payload.startedAt,
            label: e.payload.label,
          }),
        ),
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
