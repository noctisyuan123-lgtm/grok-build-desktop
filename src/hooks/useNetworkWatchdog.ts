import { useEffect, useRef } from 'react';
import {
  hasRunningTool,
  isInFlightState,
  networkGiveUpError,
  shouldGiveUp,
} from '../lib/connectionHealth';
import { streamStore } from '../lib/streamStore';

/**
 * If a live run stays silent past the give-up window, cancel it and mark a
 * network failure so the UI can offer Retry / Continue instead of spinning.
 */
export function useNetworkWatchdog(
  online: boolean,
  cancelRun: (runId: string) => Promise<boolean>,
): void {
  const cancelRef = useRef(cancelRun);
  cancelRef.current = cancelRun;
  const firedRef = useRef(new Set<string>());

  useEffect(() => {
    const tick = () => {
      const now = Date.now();
      for (const id of streamStore.getInflightRunIdsSnapshot().split('\0')) {
        if (!id) continue;
        const snap = streamStore.getRunSnapshot(id);
        if (!snap || !isInFlightState(snap.state) || snap.watching) {
          firedRef.current.delete(id);
          continue;
        }
        if (firedRef.current.has(id)) continue;
        // A run that has already emitted model/tool activity is not safe to
        // classify as a dead connection from renderer silence alone. ACP can
        // spend several minutes inside inference or a tool while the actual
        // task is still progressing (and may already have changed files).
        // Keep the run stoppable via Escape/Stop and let the backend's own
        // transport watchdog decide when an active request is truly dead.
        if (
          snap.firstOutputAt != null ||
          snap.thoughtChars > 0 ||
          snap.textChars > 0 ||
          snap.traces.length > 0
        ) {
          continue;
        }
        if (
          !shouldGiveUp({
            now,
            online,
            inFlight: true,
            lastEventAt: snap.lastEventAt,
            startedAt: snap.startedAt,
            hasRunningTool: hasRunningTool(snap.traces),
          })
        ) {
          continue;
        }
        firedRef.current.add(id);
        const endedAt = Date.now();
        streamStore.patchRun(id, {
          state: 'failed',
          error: networkGiveUpError(),
          endedAt,
        });
        streamStore.markCompletion(id, 'failed', endedAt);
        void cancelRef.current(id).catch(() => {
          /* process may already be gone */
        });
      }
    };
    tick();
    const timer = window.setInterval(tick, 1_000);
    return () => window.clearInterval(timer);
  }, [online]);
}
