import { useSyncExternalStore } from 'react';
import { streamStore, type RunSnapshot } from '../lib/streamStore';

export function useActiveRun(): RunSnapshot | undefined {
  return useSyncExternalStore(
    streamStore.subscribe,
    () => streamStore.getActiveRunSnapshot(),
    () => undefined,
  );
}

/**
 * Narrow subscription for components that only need the active run identity
 * and lifecycle state. The full snapshot changes for every streamed chunk;
 * this primitive stays stable while the same run is producing text.
 */
export function useActiveRunKey(): string {
  return useSyncExternalStore(
    streamStore.subscribe,
    () => {
      const snap = streamStore.getActiveRunSnapshot();
      return snap ? `${snap.id}\0${snap.state}` : '';
    },
    () => '',
  );
}

/**
 * Active run that belongs to the given message run ids (current UI session).
 * With concurrent multi-lane execution the global queue head may belong to
 * another tab — callers that render session-scoped UI must use this instead.
 */
export function useSessionActiveRun(runIds: readonly string[]): RunSnapshot | undefined {
  return useSyncExternalStore(
    streamStore.subscribe,
    () => {
      for (let i = runIds.length - 1; i >= 0; i -= 1) {
        const id = runIds[i];
        if (!id) continue;
        const snap = streamStore.getRunSnapshot(id);
        if (snap && (snap.state === 'running' || snap.state === 'queued')) {
          return snap;
        }
      }
      return undefined;
    },
    () => undefined,
  );
}

/**
 * Primitive progress key for the run currently owned by a message list.
 * It preserves the list's auto-follow behavior without handing the whole
 * mutable snapshot to the parent on every event.
 */
export function useSessionActiveRunProgress(runIds: readonly string[]): string {
  return useSyncExternalStore(
    streamStore.subscribe,
    () => {
      for (let i = runIds.length - 1; i >= 0; i -= 1) {
        const id = runIds[i];
        if (!id) continue;
        const snap = streamStore.getRunSnapshot(id);
        if (snap && (snap.state === 'running' || snap.state === 'queued')) {
          return [snap.id, snap.state, snap.textChars, snap.thoughtChars, snap.htmlVersion].join(
            '\0',
          );
        }
      }
      return '';
    },
    () => '',
  );
}

/**
 * "Is anything running or queued?" as a primitive selector. Subscribing to
 * whole run snapshots re-renders on EVERY streamed token (patchRun makes a new
 * snapshot object per event); a boolean lets useSyncExternalStore bail when
 * nothing actually changed. Use this when a component only needs the flag —
 * e.g. the Composer, where per-token re-renders risk dropping IME input.
 *
 * When `sessionRunIds` is provided, only those runs (plus same-lane queue
 * items if `laneId` is set) count as inflight — other tabs running concurrently
 * must not flip this session's Send → Enqueue label.
 */
export function useHasInflight(opts?: {
  sessionRunIds?: readonly string[];
  laneId?: string;
}): boolean {
  const sessionRunIds = opts?.sessionRunIds;
  const laneId = opts?.laneId;
  return useSyncExternalStore(
    streamStore.subscribe,
    () => {
      if (sessionRunIds) {
        for (const id of sessionRunIds) {
          const state = streamStore.getRunSnapshot(id)?.state;
          if (state === 'running' || state === 'queued') return true;
        }
        const q = streamStore.getQueueSnapshot();
        if (laneId != null && laneId !== '') {
          return q.items.some((item) => item.laneId === laneId);
        }
        // Without a lane id, only session run snapshots count (not global queue).
        return false;
      }
      const activeIds = streamStore.getQueueSnapshot().activeIds;
      if (activeIds.some((id) => streamStore.getRunSnapshot(id)?.state === 'running')) {
        return true;
      }
      if (streamStore.getActiveRunSnapshot()?.state === 'running') return true;
      return streamStore.getQueueSnapshot().items.length > 0;
    },
    () => false,
  );
}
