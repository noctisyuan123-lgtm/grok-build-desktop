import { useEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react';
import { createPortal } from 'react-dom';
import { Bot, X } from 'lucide-react';
import { useElapsed } from '../hooks/useElapsed';
import { useRunSnapshot } from '../hooks/useRunSnapshot';
import { useModalFocus } from '../hooks/useModalFocus';
import { streamStore } from '../lib/streamStore';
import type { TraceEvent, TraceStatus } from '../lib/traceParser';
import { t } from '../i18n';

/**
 * Compact floating card above the composer for the newest subagent on the
 * current session's latest assistant run. Click opens a session-scoped
 * inspector drawer (visual only — no backend child chat navigation).
 */
export function SubagentFloat({ sessionRunIds = [] }: { sessionRunIds?: readonly string[] }) {
  const focusRunId = useLatestSessionRunId(sessionRunIds);
  const snapshot = useRunSnapshot(focusRunId ?? '');
  const subagent = useMemo(
    () => pickCurrentSubagent(snapshot?.traces ?? [], focusRunId),
    [snapshot?.traces, focusRunId],
  );
  const [drawerOpen, setDrawerOpen] = useState(false);
  const drawerRef = useRef<HTMLDivElement | null>(null);
  const closeRef = useRef<HTMLButtonElement | null>(null);

  useEffect(() => {
    if (!subagent) setDrawerOpen(false);
  }, [subagent?.key]);

  useModalFocus(drawerOpen, drawerRef, {
    initialFocus: closeRef,
    onEscape: () => setDrawerOpen(false),
  });

  if (!focusRunId || !subagent) return null;

  const live = subagent.status === 'running';
  const statusLabel = statusLabelFor(subagent.status);

  return (
    <>
      <div className={`subagent-float${live ? ' is-live' : ''}${drawerOpen ? ' is-open' : ''}`}>
        <button
          type="button"
          className="subagent-float-card"
          aria-label={t('subagent.floatOpen', { label: subagent.label })}
          aria-expanded={drawerOpen}
          aria-controls="subagent-session-drawer"
          onClick={() => setDrawerOpen(true)}
        >
          <Bot size={14} aria-hidden />
          <span className="subagent-float-label">{subagent.label}</span>
          <span className={`subagent-float-status status-${subagent.status}`}>{statusLabel}</span>
          {subagent.progress ? (
            <span className="subagent-float-progress">{subagent.progress}</span>
          ) : null}
        </button>
      </div>
      {drawerOpen
        ? createPortal(
            <div
              className="subagent-drawer-overlay"
              role="presentation"
              onClick={() => setDrawerOpen(false)}
            >
              <aside
                id="subagent-session-drawer"
                className="subagent-drawer"
                ref={drawerRef}
                role="dialog"
                aria-modal="true"
                aria-label={t('subagent.drawerTitle', { label: subagent.label })}
                tabIndex={-1}
                onClick={(event) => event.stopPropagation()}
              >
                <header className="subagent-drawer-head">
                  <div className="subagent-drawer-title">
                    <Bot size={15} aria-hidden />
                    <strong>{subagent.label}</strong>
                    <span className={`subagent-drawer-status status-${subagent.status}`}>
                      {statusLabel}
                    </span>
                  </div>
                  <button
                    ref={closeRef}
                    type="button"
                    className="subagent-drawer-close"
                    aria-label={t('subagent.drawerClose')}
                    onClick={() => setDrawerOpen(false)}
                  >
                    <X size={16} aria-hidden />
                  </button>
                </header>
                <SubagentDrawerBody runId={focusRunId} subagent={subagent} />
              </aside>
            </div>,
            document.body,
          )
        : null}
    </>
  );
}

function SubagentDrawerBody({ runId, subagent }: { runId: string; subagent: TraceEvent }) {
  const snapshot = useRunSnapshot(runId);
  const elapsed = useElapsed(subagent.startedAt, subagent.endedAt);
  const children = useMemo(() => {
    const traces = snapshot?.traces ?? [];
    return traces.filter(
      (trace) =>
        trace.parentKey === subagent.key ||
        (trace.kind !== 'subagent' &&
          trace.key !== subagent.key &&
          Boolean(trace.parentKey) &&
          trace.parentKey === subagent.key),
    );
  }, [snapshot?.traces, subagent.key]);

  return (
    <div className="subagent-drawer-body">
      <dl className="subagent-drawer-meta">
        <div>
          <dt>{t('subagent.metaStatus')}</dt>
          <dd>{statusLabelFor(subagent.status)}</dd>
        </div>
        {elapsed != null ? (
          <div>
            <dt>{t('subagent.metaElapsed')}</dt>
            <dd>{formatDuration(elapsed)}</dd>
          </div>
        ) : null}
        {subagent.progress ? (
          <div>
            <dt>{t('subagent.metaProgress')}</dt>
            <dd>{subagent.progress}</dd>
          </div>
        ) : null}
      </dl>
      {subagent.detail ? (
        <pre className="subagent-drawer-detail">
          <code>{subagent.detail}</code>
        </pre>
      ) : null}
      {children.length > 0 ? (
        <section className="subagent-drawer-children" aria-label={t('subagent.childTraces')}>
          <h3>{t('subagent.childTraces')}</h3>
          <ul>
            {children.map((child) => (
              <li key={child.key}>
                <span className={`subagent-child-status status-${child.status}`} aria-hidden>
                  {child.status === 'done' ? '✓' : child.status === 'error' ? '×' : '·'}
                </span>
                <span>{child.label}</span>
                {child.detail ? <small>{child.detail}</small> : null}
              </li>
            ))}
          </ul>
        </section>
      ) : (
        <p className="subagent-drawer-empty">{t('subagent.noChildTraces')}</p>
      )}
    </div>
  );
}

/** Newest live subagent, else most recent subagent on this run. */
export function pickCurrentSubagent(
  traces: readonly TraceEvent[],
  runId: string | null | undefined,
): TraceEvent | null {
  if (!runId) return null;
  const subagents = traces.filter((trace) => trace.kind === 'subagent');
  if (subagents.length === 0) return null;
  const live = [...subagents].reverse().find((trace) => trace.status === 'running');
  if (live) return live;
  return subagents[subagents.length - 1] ?? null;
}

/**
 * Latest assistant run id that belongs to this UI session. Never falls back
 * to the global queue head (another tab may be actively running).
 */
export function useLatestSessionRunId(sessionRunIds: readonly string[]): string | null {
  const key = sessionRunIds.join('\0');
  return useSyncExternalStore(
    streamStore.subscribe,
    () => {
      for (let index = sessionRunIds.length - 1; index >= 0; index -= 1) {
        const id = sessionRunIds[index];
        if (!id) continue;
        if (streamStore.getRunSnapshot(id)) return id;
      }
      return null;
    },
    () => null,
  );
  void key;
}

function statusLabelFor(status: TraceStatus): string {
  if (status === 'running') return t('subagent.statusRunning');
  if (status === 'done') return t('subagent.statusDone');
  if (status === 'error') return t('subagent.statusError');
  if (status === 'cancelled') return t('subagent.statusCancelled');
  return status;
}

function formatDuration(ms: number): string {
  if (ms < 1000) return `${Math.round(ms)}ms`;
  if (ms < 60_000) return `${(ms / 1000).toFixed(ms < 10_000 ? 1 : 0)}s`;
  const minutes = Math.floor(ms / 60_000);
  const seconds = Math.round((ms % 60_000) / 1000);
  return `${minutes}m ${seconds}s`;
}
