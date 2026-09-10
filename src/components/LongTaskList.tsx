import { useEffect, useMemo, useState, useSyncExternalStore } from 'react';
import { Clock3, Eye, Square, Terminal } from 'lucide-react';
import type { ChatMessage } from '../app/types';
import { streamStore } from '../lib/streamStore';
import {
  collectSessionTasks,
  collectWatchingMonitors,
  taskCommand,
  taskTitle,
} from '../lib/sessionTasks';
import { t } from '../i18n';

export function LongTaskList({
  messages,
  onStop,
}: {
  messages: readonly ChatMessage[];
  onStop: (runId: string) => void;
}) {
  const fingerprint = useSyncExternalStore(
    streamStore.subscribe,
    () =>
      JSON.stringify(
        messages.map((message) =>
          (() => {
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
          })(),
        ),
      ),
    () => '[]',
  );
  const [now, setNow] = useState(Date.now);
  const live = useMemo(() => {
    void fingerprint;
    return new Map(
      messages.map((message) => [
        message.runId ?? `msg:${message.id}`,
        streamStore.getRunSnapshot(message.runId ?? '')?.traces ?? [],
      ]),
    );
  }, [messages, fingerprint]);
  const watching = messages.some(
    (message) => streamStore.getRunSnapshot(message.runId ?? '')?.watching,
  );
  const running =
    watching ||
    [...live.values()].some((traces) => traces.some((trace) => trace.status === 'running'));
  useEffect(() => {
    if (!running) return;
    const timer = window.setInterval(() => setNow(Date.now()), 1_000);
    return () => window.clearInterval(timer);
  }, [running]);
  const items = [
    ...collectWatchingMonitors(messages, now),
    ...collectSessionTasks(messages, live, now),
  ].sort(
    (a, b) =>
      Number(b.status === 'running') - Number(a.status === 'running') || b.startedAt - a.startedAt,
  );
  if (items.length === 0) return null;
  return (
    <section className="subagent-rail-section long-task-section">
      <h3>
        Tasks <span>{items.length}</span>
      </h3>
      <ul>
        {items.map((item) => {
          const monitor = item.source === 'monitor';
          const title = monitor ? item.label || t('tasks.monitorFallback') : taskTitle(item);
          const command = taskCommand(item);
          const preview = command?.replace(/\s+/g, ' ').trim();
          const showPreview = Boolean(preview && preview !== title);
          return (
            <li key={`${item.runId}:${item.key}`} className="task-rail-row">
              <details className={`task-rail-entry status-${item.status}`}>
                <summary>
                  {monitor ? (
                    <Eye size={14} aria-hidden />
                  ) : /\b(sleep|wait)\b/i.test(`${title} ${command ?? ''}`) ? (
                    <Clock3 size={14} aria-hidden />
                  ) : (
                    <Terminal size={14} aria-hidden />
                  )}
                  <span className="task-rail-copy">
                    <strong>{title}</strong>
                    {showPreview ? <code>{preview}</code> : null}
                  </span>
                  <span className="task-rail-state">
                    {monitor ? t('tasks.watching') : 'Running'}
                    <small>
                      {Math.max(0, Math.floor(((item.endedAt ?? now) - item.startedAt) / 1000))}s
                    </small>
                  </span>
                </summary>
                <pre>
                  {command ? `$ ${command}\n\n` : ''}
                  {item.detail || item.progress || 'No additional output.'}
                </pre>
              </details>
              <button
                className="task-rail-stop"
                type="button"
                aria-label={`Stop ${title}`}
                title="Stop task"
                onClick={() => onStop(item.runId)}
              >
                <Square size={11} fill="currentColor" aria-hidden />
              </button>
            </li>
          );
        })}
      </ul>
    </section>
  );
}
