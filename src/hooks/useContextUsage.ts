// Live context-occupancy for the open conversation.
//
// Refresh triggers:
//   - active session id or cwd change
//   - run lifecycle (inflight → idle does one final fetch)
//   - modest interval ONLY while a run is inflight (not per streamed token)
//
// Subscriptions deliberately return primitives so useSyncExternalStore can
// bail out when only token text changed.
import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react';
import type { ChatMessage } from '../app/types';
import {
  ACTIVE_RUN_POLL_MS,
  fetchSessionContextMetrics,
  resolveActiveSessionId,
  selectContextUsageView,
  type ContextUsageViewState,
  type SessionContextMetrics,
} from '../lib/contextMetrics';
import { streamStore } from '../lib/streamStore';
import { useHasInflight } from './useActiveRun';

/** Session id on the active run snapshot only — stable across token patches. */
function useActiveRunSessionId(): string | null {
  return useSyncExternalStore(
    streamStore.subscribe,
    () => streamStore.getActiveRunSnapshot()?.sessionId ?? null,
    () => null,
  );
}

export interface UseContextUsageResult {
  sessionId: string | null;
  view: ContextUsageViewState;
  metrics: SessionContextMetrics | null;
  /** True while a network/IPC refresh is in flight. */
  refreshing: boolean;
  refresh: () => void;
  /** True when a Grok run is active (ring may show a subtle live cue). */
  streaming: boolean;
}

export function useContextUsage(
  messages: readonly ChatMessage[],
  cwd: string,
): UseContextUsageResult {
  const hasInflight = useHasInflight();
  const runSessionId = useActiveRunSessionId();
  const sessionId = useMemo(
    () => resolveActiveSessionId(messages, runSessionId),
    [messages, runSessionId],
  );

  const [metrics, setMetrics] = useState<SessionContextMetrics | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [refreshing, setRefreshing] = useState(false);

  // Ignore out-of-order responses when the user switches conversations quickly.
  const requestGen = useRef(0);
  const cwdTrimmed = cwd.trim();

  const refresh = useCallback(() => {
    if (!sessionId) {
      setMetrics(null);
      setError(null);
      setLoading(false);
      setRefreshing(false);
      return;
    }
    const gen = ++requestGen.current;
    setRefreshing(true);
    setLoading((prev) => prev || metrics == null);
    void fetchSessionContextMetrics(cwdTrimmed, sessionId)
      .then((next) => {
        if (gen !== requestGen.current) return;
        setMetrics(next);
        setError(null);
      })
      .catch((err: unknown) => {
        if (gen !== requestGen.current) return;
        const message = err instanceof Error ? err.message : String(err);
        setError(message || 'Could not load context usage');
      })
      .finally(() => {
        if (gen !== requestGen.current) return;
        setLoading(false);
        setRefreshing(false);
      });
    // metrics omitted from deps on purpose — only gate the initial loading flag.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [cwdTrimmed, sessionId]);

  // Primary refresh: session / cwd identity.
  useEffect(() => {
    // Clear stale numbers immediately on switch so the ring never shows
    // conversation A's occupancy while B is loading.
    setMetrics(null);
    setError(null);
    refresh();
  }, [refresh]);

  // Modest poll only while a run is active.
  useEffect(() => {
    if (!hasInflight || !sessionId) return;
    const timer = window.setInterval(() => {
      refresh();
    }, ACTIVE_RUN_POLL_MS);
    return () => window.clearInterval(timer);
  }, [hasInflight, sessionId, cwdTrimmed, refresh]);

  // One final refresh when the run drains (captures end-of-turn signals write).
  const wasInflight = useRef(hasInflight);
  useEffect(() => {
    if (wasInflight.current && !hasInflight) {
      refresh();
    }
    wasInflight.current = hasInflight;
  }, [hasInflight, refresh]);

  const view = useMemo(
    () =>
      selectContextUsageView({
        cwd: cwdTrimmed,
        sessionId,
        loading,
        error,
        metrics,
      }),
    [cwdTrimmed, sessionId, loading, error, metrics],
  );

  return {
    sessionId,
    view,
    metrics,
    refreshing,
    refresh,
    streaming: hasInflight,
  };
}
