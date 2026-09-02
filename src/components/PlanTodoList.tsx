import { useEffect, useMemo, useState } from 'react';
import { Check } from 'lucide-react';
import { extractPlanEntries, type PlanEntry } from '../lib/traceParser';
import { useRunSnapshot } from '../hooks/useRunSnapshot';
import { t } from '../i18n';

/**
 * Sparse plan checklist. Marks are dots / a check — never markdown task-list
 * squares, which read as model output. The list itself has no chrome; the
 * floating window around it is {@link PlanFloat}.
 */
export function PlanTodoList({ entries }: { entries: readonly PlanEntry[] }) {
  if (!entries.length) return null;

  return (
    <ul className="plan-todo-list" aria-label={t('plan.aria')}>
      {entries.map((entry, index) => {
        const statusClass =
          entry.status === 'in_progress'
            ? 'is-active'
            : entry.status === 'completed'
              ? 'is-completed'
              : 'is-pending';
        return (
          <li
            key={`${index}:${entry.text}`}
            className={`plan-todo-item ${statusClass}`}
            aria-current={entry.status === 'in_progress' ? 'step' : undefined}
          >
            <span className="plan-todo-mark" aria-hidden="true">
              {entry.status === 'completed' ? (
                <Check size={12} strokeWidth={2.25} />
              ) : entry.status === 'in_progress' ? (
                <span className="plan-todo-dot" />
              ) : (
                <span className="plan-todo-ring" />
              )}
            </span>
            <span className="plan-todo-text">{entry.text}</span>
          </li>
        );
      })}
    </ul>
  );
}

/**
 * Compact plan chip docked above the composer (in-flow, not over the
 * transcript). Session-scoped: one visible plan at a time.
 */
export function PlanFloat({
  messages,
  activeRunId = null,
}: {
  messages: readonly PlanMessageLike[];
  activeRunId?: string | null;
}) {
  const persisted = useMemo(() => findVisiblePlan(messages), [messages]);
  const runId = activeRunId || persisted?.runId || '';
  const snap = useRunSnapshot(runId);
  const liveEntries = useMemo(() => resolvePlanEntriesFromTraces(snap?.traces), [snap?.traces]);
  // Incomplete live plans always win. A completed live plan still has to pass
  // the next-turn hide gate — otherwise the old run's traces keep the HUD up
  // after the user has already started the following prompt.
  const liveIncomplete = Boolean(liveEntries && !isPlanAllCompleted(liveEntries));
  const entries = liveIncomplete
    ? liveEntries
    : persisted
      ? (liveEntries ?? persisted.entries)
      : null;
  const allDone = entries ? isPlanAllCompleted(entries) : false;
  const signature = entries?.map((entry) => `${entry.status}:${entry.text}`).join('\n') ?? '';
  const [collapsed, setCollapsed] = useState(allDone);

  useEffect(() => {
    if (!signature) return;
    setCollapsed(allDone);
  }, [allDone, signature]);

  if (!entries?.length) return null;

  const done = entries.filter((entry) => entry.status === 'completed').length;

  return (
    <div className="plan-float-dock">
      <aside
        className={`plan-float${allDone ? ' is-complete' : ''}${collapsed ? ' is-collapsed' : ''}`}
      >
        <button
          type="button"
          className="plan-float-toggle"
          aria-expanded={!collapsed}
          aria-label={t('plan.toggle', { done, total: entries.length })}
          onClick={() => setCollapsed((current) => !current)}
        >
          <span className="plan-float-title">{t('plan.title')}</span>
          <span className="plan-float-count">
            {t('plan.progress', { done, total: entries.length })}
          </span>
        </button>
        {collapsed ? null : <PlanTodoList entries={entries} />}
      </aside>
    </div>
  );
}

/** Latest structured plan entries from tool/task traces (most recent plan wins). */
export function resolvePlanEntriesFromTraces(
  traces: ReadonlyArray<{ kind: string; raw?: unknown }> | undefined | null,
): PlanEntry[] | null {
  if (!traces?.length) return null;
  for (let index = traces.length - 1; index >= 0; index -= 1) {
    const trace = traces[index];
    if (!trace || trace.kind !== 'task' || trace.raw == null) continue;
    const entries = extractPlanEntries(trace.raw);
    if (entries?.length) return entries;
  }
  return null;
}

/**
 * @deprecated Prefer {@link resolvePlanEntriesFromTraces}. Kept for older tests
 * that passed a live active-run snapshot shape.
 */
export function resolveActivePlanEntries(
  active:
    | {
        state: string;
        traces: ReadonlyArray<{ kind: string; raw?: unknown }>;
      }
    | undefined
    | null,
): PlanEntry[] | null {
  if (!active || (active.state !== 'running' && active.state !== 'queued')) return null;
  return resolvePlanEntriesFromTraces(active.traces);
}

export function isPlanAllCompleted(entries: readonly PlanEntry[]): boolean {
  return entries.length > 0 && entries.every((entry) => entry.status === 'completed');
}

export type PlanMessageLike = {
  role: 'user' | 'assistant';
  runId?: string;
  meta?: { planEntries?: PlanEntry[] } | null;
};

/**
 * Lifecycle for a plan attached to `messageIndex`:
 * - Incomplete plans stay visible across later turns until a later plan
 *   supersedes them or an update marks every step complete.
 * - Fully completed plans stay until the *next* user turn begins
 *   (全部划掉后下一轮对话开始时消失).
 * - A later assistant message with its own plan supersedes earlier plans.
 * Callers must only pass messages from the visible UI session/tab.
 */
export function shouldShowPlan(
  messages: readonly PlanMessageLike[],
  messageIndex: number,
): boolean {
  const message = messages[messageIndex];
  const entries = message?.meta?.planEntries;
  if (message?.role !== 'assistant' || !entries?.length) return false;

  for (let index = messageIndex + 1; index < messages.length; index += 1) {
    const later = messages[index];
    if (later?.role === 'assistant' && later.meta?.planEntries?.length) {
      return false;
    }
  }

  if (!isPlanAllCompleted(entries)) return true;

  let userTurnsAfter = 0;
  for (let index = messageIndex + 1; index < messages.length; index += 1) {
    if (messages[index]?.role === 'user') userTurnsAfter += 1;
  }
  // 0: plan's turn just finished — keep. 1+: the next user turn has begun — hide.
  return userTurnsAfter < 1;
}

/** The single plan the HUD should show, or null when none is in lifecycle. */
export function findVisiblePlan(
  messages: readonly PlanMessageLike[],
): { runId?: string; entries: PlanEntry[] } | null {
  for (let index = 0; index < messages.length; index += 1) {
    if (!shouldShowPlan(messages, index)) continue;
    const message = messages[index]!;
    return { runId: message.runId, entries: message.meta!.planEntries! };
  }
  return null;
}
