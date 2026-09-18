import { useEffect, useMemo, useState, useSyncExternalStore } from 'react';
import type { ChatMessage } from '../app/types';
import { collectActiveTaskItems, type SessionTask } from '../lib/sessionTasks';
import { streamStore } from '../lib/streamStore';

function liveTracesForMessages(messages: readonly ChatMessage[]) {
  return new Map(
    messages.map((message) => [
      message.runId ?? `msg:${message.id}`,
      streamStore.getRunSnapshot(message.runId ?? '')?.traces ?? [],
    ]),
  );
}

/** Shared Tasks HUD items so the rail header count matches the list. */
export function useSessionTaskItems(messages: readonly ChatMessage[]): {
  items: SessionTask[];
  now: number;
} {
  const fingerprint = useSyncExternalStore(
    streamStore.subscribe,
    () =>
      JSON.stringify(
        messages.map((message) => {
          const snap = streamStore.getRunSnapshot(message.runId ?? '');
          return {
            watching: snap?.watching ?? false,
            watchingLabel: snap?.watchingLabel ?? null,
            watchingStartedAt: snap?.watchingStartedAt ?? null,
            traces: (snap?.traces ?? []).map(
              ({ key, kind, label, command, detail, progress, status, startedAt, endedAt }) => ({
                key,
                kind,
                label,
                command,
                detail,
                progress,
                status,
                startedAt,
                endedAt,
              }),
            ),
          };
        }),
      ),
    () => '[]',
  );
  const [now, setNow] = useState(Date.now);
  const live = useMemo(() => {
    void fingerprint;
    return liveTracesForMessages(messages);
  }, [messages, fingerprint]);
  const running =
    messages.some((message) => streamStore.getRunSnapshot(message.runId ?? '')?.watching) ||
    [...live.values()].some((traces) => traces.some((trace) => trace.status === 'running'));
  useEffect(() => {
    if (!running) return;
    const timer = window.setInterval(() => setNow(Date.now()), 1_000);
    return () => window.clearInterval(timer);
  }, [running]);
  const items = useMemo(
    () => collectActiveTaskItems(messages, live, now),
    [messages, live, now],
  );
  return { items, now };
}
