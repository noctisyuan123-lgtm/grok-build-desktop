import { useEffect, useMemo, useState, useSyncExternalStore } from 'react';
import { Clock3, Square, Terminal } from 'lucide-react';
import type { ChatMessage } from '../app/types';
import { streamStore } from '../lib/streamStore';
import { collectSessionTasks } from '../lib/sessionTasks';

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
          (streamStore.getRunSnapshot(message.runId ?? '')?.traces ?? []).map(
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
  const running = [...live.values()].some((traces) =>
    traces.some((trace) => trace.status === 'running'),
  );
  useEffect(() => {
    if (!running) return;
    const timer = window.setInterval(() => setNow(Date.now()), 1_000);
    return () => window.clearInterval(timer);
  }, [running]);
  const items = collectSessionTasks(messages, live, now).sort(
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
        {items.map((item) => (
          <li key={`${item.runId}:${item.key}`}>
            <details className={`task-rail-entry status-${item.status}`}>
              <summary>
                {/\b(sleep|wait)\b/i.test(`${item.label} ${item.command ?? ''}`) ? (
                  <Clock3 size={14} aria-hidden />
                ) : (
                  <Terminal size={14} aria-hidden />
                )}
                <span className="task-rail-copy">
                  <strong>{item.label}</strong>
                  {item.command ? <code>{item.command}</code> : null}
                </span>
                <span className="task-rail-state">
                  Running
                  <small>
                    {Math.max(0, Math.floor(((item.endedAt ?? now) - item.startedAt) / 1000))}s
                  </small>
                </span>
                <button
                  className="task-rail-stop"
                  type="button"
                  aria-label={`Stop ${item.label}`}
                  title="Stop task"
                  onClick={(event) => {
                    event.preventDefault();
                    event.stopPropagation();
                    onStop(item.runId);
                  }}
                >
                  <Square size={11} fill="currentColor" aria-hidden />
                </button>
              </summary>
              <pre>
                {item.command ? `$ ${item.command}\n\n` : ''}
                {item.detail || item.progress || 'No additional output.'}
              </pre>
            </details>
          </li>
        ))}
      </ul>
    </section>
  );
}
