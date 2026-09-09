import { useEffect, useState } from 'react';
import { hasTauriRuntime } from '../lib/runtime';

/** Native zoom and macOS full screen both reserve the task rail. */
export function useExpandedWindow(): boolean {
  const [expanded, setExpanded] = useState(false);
  useEffect(() => {
    let disposed = false;
    let revision = 0;
    let stateTimer: ReturnType<typeof setInterval> | undefined;
    let settleTimer: ReturnType<typeof setTimeout> | undefined;
    let unlisten: (() => void) | undefined;
    const browserRefresh = () => setExpanded(Boolean(document.fullscreenElement));
    if (!hasTauriRuntime()) {
      browserRefresh();
      document.addEventListener('fullscreenchange', browserRefresh);
      return () => document.removeEventListener('fullscreenchange', browserRefresh);
    }
    void import('@tauri-apps/api/window')
      .then(async ({ getCurrentWindow }) => {
        const win = getCurrentWindow();
        const refresh = async () => {
          const current = ++revision;
          try {
            const [maximized, fullscreen] = await Promise.all([
              win.isMaximized(),
              win.isFullscreen(),
            ]);
            if (!disposed && current === revision) setExpanded(maximized || fullscreen);
          } catch {
            /* Keep the last confirmed native state. */
          }
        };
        const cleanup = await win.onResized(() => {
          void refresh();
          // AppKit can emit resize before updating its zoom/fullscreen flags.
          clearTimeout(settleTimer);
          settleTimer = setTimeout(() => void refresh(), 400);
        });
        if (disposed) {
          cleanup();
          return;
        }
        unlisten = cleanup;
        // Zoom may change native state without resizing an already screen-sized
        // restored window. Keep that case in sync as well.
        stateTimer = setInterval(() => void refresh(), 1_000);
        await refresh();
      })
      .catch(() => {});
    return () => {
      disposed = true;
      clearTimeout(settleTimer);
      clearInterval(stateTimer);
      unlisten?.();
    };
  }, []);
  return expanded;
}
