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
 * Active run that belongs to the given message run ids (current UI session).
 * With concurrent multi-lane execution the global queue head may belong to
 * another tab — callers that render session-scoped UI must use this instead.
 */
export function useSessionActiveRun(runIds: readonly string[]): RunSnapshot | undefined {
  const key = runIds.join('\0');
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
  // `key` documents that getSnapshot closes over runIds identity.
  void key;
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
