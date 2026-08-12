import { extractPlanEntries, type PlanEntry } from '../lib/traceParser';

/**
 * Sparse plan checklist for one assistant run. Renders at the bottom of that
 * response (session-scoped message data) — not as a live-only composer dock.
 *
 * Visual language matches rendered markdown task lists: disabled checkboxes
 * (same convention as `@mdit/plugin-tasklist`) with completed strike-through
 * and a subtle active state for in-progress — never raw `- [ ]` source syntax.
 * Returns null when there are no entries (occupies no layout space).
 */
export function PlanTodoList({ entries }: { entries: readonly PlanEntry[] }) {
  if (!entries.length) return null;

  return (
    <ul className="plan-todo-list task-list-container" aria-label="Plan">
      {entries.map((entry, index) => {
        const statusClass =
          entry.status === 'in_progress'
            ? 'is-active'
            : entry.status === 'completed'
              ? 'is-completed'
              : 'is-pending';
        const checked = entry.status === 'completed';
        return (
          <li
            key={`${index}:${entry.text}`}
            className={`plan-todo-item task-list-item ${statusClass}`}
          >
            <input
              type="checkbox"
              className="task-list-item-checkbox plan-todo-checkbox"
              checked={checked}
              disabled
              tabIndex={-1}
              aria-hidden="true"
              onChange={() => {
                /* read-only status indicator */
              }}
            />
            <span className="plan-todo-text">{entry.text}</span>
          </li>
        );
      })}
    </ul>
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
  meta?: { planEntries?: PlanEntry[] } | null;
};

/**
 * Lifecycle for a plan attached to `messageIndex`:
 * - Incomplete plans stay visible across later turns until a later plan
 *   supersedes them or an update marks every step complete.
 * - Fully completed plans stay through the *next* user/assistant turn and are
 *   removed only once a second following user turn has begun
 *   (下下轮对话开始时再消失).
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
  // 0: plan's turn just finished — keep. 1: one follow-up turn in flight/done
  // — keep. 2+: the turn after that has begun — hide.
  return userTurnsAfter < 2;
}
