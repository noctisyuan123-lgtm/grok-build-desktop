import { Clock3, Eye, Square, Terminal } from 'lucide-react';
import { taskCommand, taskTitle, type SessionTask } from '../lib/sessionTasks';
import { t } from '../i18n';

export function LongTaskList({
  items,
  now,
  onStop,
}: {
  items: readonly SessionTask[];
  now: number;
  onStop: (runId: string) => void;
}) {
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
