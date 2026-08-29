import {
  useEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
  type PointerEvent as ReactPointerEvent,
} from 'react';
import { createPortal } from 'react-dom';
import { Bot, X } from 'lucide-react';
import { useElapsed } from '../hooks/useElapsed';
import { useRunSnapshot } from '../hooks/useRunSnapshot';
import { useModalFocus } from '../hooks/useModalFocus';
import { streamStore } from '../lib/streamStore';
import type { TraceEvent, TraceStatus } from '../lib/traceParser';
import { PlanTodoList, resolvePlanEntriesFromTraces } from './PlanTodoList';
import { TranscriptMessage } from './MessageItem';
import { t } from '../i18n';

const SUBAGENT_DRAWER_WIDTH_KEY = 'grok-desktop-subagent-drawer-width';
const SUBAGENT_DRAWER_DEFAULT_WIDTH = 420;
const SUBAGENT_DRAWER_MIN_WIDTH = 320;
const SUBAGENT_DRAWER_MAX_WIDTH = 720;

/**
 * Compact floating cards above the composer for every subagent on the current
 * session's latest assistant run. Each card opens the same right-side drawer
 * with that child session's own workflow transcript and responses.
 */
export function SubagentFloat({ sessionRunIds = [] }: { sessionRunIds?: readonly string[] }) {
  const focusRunId = useLatestSessionRunId(sessionRunIds);
  const snapshot = useRunSnapshot(focusRunId ?? '');
  const subagents = useMemo(
    () => pickSubagents(snapshot?.traces ?? [], focusRunId),
    [snapshot?.traces, focusRunId],
  );
  const [openKey, setOpenKey] = useState<string | null>(null);
  const [drawerWidth, setDrawerWidth] = useState(readSubagentDrawerWidth);
  const resizingCleanupRef = useRef<(() => void) | null>(null);
  const drawerRef = useRef<HTMLDivElement | null>(null);
  const closeRef = useRef<HTMLButtonElement | null>(null);

  useEffect(() => {
    window.localStorage.setItem(SUBAGENT_DRAWER_WIDTH_KEY, String(drawerWidth));
  }, [drawerWidth]);

  useEffect(
    () => () => {
      resizingCleanupRef.current?.();
    },
    [],
  );

  useEffect(() => {
    if (!subagents.some((item) => item.key === openKey)) setOpenKey(null);
  }, [openKey, subagents]);

  const selected = subagents.find((item) => item.key === openKey) ?? null;
  useModalFocus(selected != null, drawerRef, {
    initialFocus: closeRef,
    onEscape: () => setOpenKey(null),
  });

  function startDrawerResize(event: ReactPointerEvent<HTMLDivElement>) {
    if (event.button !== 0) return;
    event.preventDefault();
    const startX = event.clientX;
    const startWidth = drawerWidth;
    document.body.classList.add('subagent-drawer-resizing');

    const move = (moveEvent: PointerEvent) => {
      const next = clampSubagentDrawerWidth(startWidth + startX - moveEvent.clientX);
      setDrawerWidth(next);
    };
    const stop = () => {
      document.body.classList.remove('subagent-drawer-resizing');
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', stop);
      window.removeEventListener('pointercancel', stop);
      resizingCleanupRef.current = null;
    };
    resizingCleanupRef.current?.();
    resizingCleanupRef.current = stop;
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', stop);
    window.addEventListener('pointercancel', stop);
  }

  function nudgeDrawerWidth(delta: number) {
    setDrawerWidth((current) => clampSubagentDrawerWidth(current + delta));
  }

  if (!focusRunId || subagents.length === 0) return null;

  return (
    <>
      <div className="subagent-float-list">
        {subagents.map((subagent) => {
          const live = subagent.status === 'running';
          const drawerOpen = selected?.key === subagent.key;
          return (
            <div
              key={subagent.key}
              className={`subagent-float${live ? ' is-live' : ''}${drawerOpen ? ' is-open' : ''}`}
            >
              <button
                type="button"
                className="subagent-float-card"
                aria-label={t('subagent.floatOpen', { label: subagent.label })}
                aria-expanded={drawerOpen}
                aria-controls={`subagent-session-drawer-${subagent.key.replace(/[^a-zA-Z0-9_-]/g, '-')}`}
                onClick={() => setOpenKey(subagent.key)}
              >
                <Bot size={14} aria-hidden />
                <span className="subagent-float-label">{subagent.label}</span>
                <span className={`subagent-float-status status-${subagent.status}`}>
                  {statusLabelFor(subagent.status)}
                </span>
                {subagent.progress ? (
                  <span className="subagent-float-progress">{subagent.progress}</span>
                ) : null}
              </button>
            </div>
          );
        })}
      </div>
      {selected
        ? createPortal(
            <div
              className="subagent-drawer-overlay"
              role="presentation"
              onClick={() => setOpenKey(null)}
            >
              <aside
                id={`subagent-session-drawer-${selected.key.replace(/[^a-zA-Z0-9_-]/g, '-')}`}
                className="subagent-drawer"
                ref={drawerRef}
                role="dialog"
                aria-modal="true"
                aria-label={t('subagent.drawerTitle', { label: selected.label })}
                style={{ width: `${drawerWidth}px` }}
                tabIndex={-1}
                onClick={(event) => event.stopPropagation()}
              >
                <div
                  aria-label={t('subagent.resize')}
                  aria-orientation="vertical"
                  aria-valuemax={SUBAGENT_DRAWER_MAX_WIDTH}
                  aria-valuemin={SUBAGENT_DRAWER_MIN_WIDTH}
                  aria-valuenow={drawerWidth}
                  className="subagent-drawer-resizer"
                  onKeyDown={(event) => {
                    if (event.key === 'ArrowLeft') {
                      event.preventDefault();
                      nudgeDrawerWidth(16);
                    } else if (event.key === 'ArrowRight') {
                      event.preventDefault();
                      nudgeDrawerWidth(-16);
                    }
                  }}
                  onPointerDown={startDrawerResize}
                  role="separator"
                  tabIndex={0}
                />
                <header className="subagent-drawer-head">
                  <div className="subagent-drawer-title">
                    <Bot size={15} aria-hidden />
                    <strong>{selected.label}</strong>
                    <span className={`subagent-drawer-status status-${selected.status}`}>
                      {statusLabelFor(selected.status)}
                    </span>
                  </div>
                  <button
                    ref={closeRef}
                    type="button"
                    className="subagent-drawer-close"
                    aria-label={t('subagent.drawerClose')}
                    onClick={() => setOpenKey(null)}
                  >
                    <X size={16} aria-hidden />
                  </button>
                </header>
                <SubagentDrawerBody runId={focusRunId} subagent={selected} />
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
  const transcript = subagent.transcript ?? [];
  const live = subagent.status === 'running';
  const transcriptRunId = `${runId}:subagent:${subagent.key}`;
  const planEntries = useMemo(() => resolvePlanEntriesFromTraces(children), [children]);
  const planNode = planEntries?.length ? <PlanTodoList entries={planEntries} /> : null;

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
      {transcript.length > 0 ? (
        <div className="subagent-drawer-transcript">
          <TranscriptMessage
            runId={transcriptRunId}
            transcript={transcript}
            traces={children}
            workedLabel={
              !live && elapsed != null
                ? t('message.workedFor', { duration: formatDuration(elapsed) })
                : undefined
            }
            live={live}
            responseTerminalReady={!live}
            startedAt={subagent.startedAt}
            autoExpandWork={live}
            canUndo={false}
            showUndo={false}
          />
          {planNode}
        </div>
      ) : (
        planNode
      )}
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

function pickSubagents(
  traces: readonly TraceEvent[],
  runId: string | null | undefined,
): TraceEvent[] {
  if (!runId) return [];
  return traces.filter((trace) => trace.kind === 'subagent');
}

/**
 * Latest assistant run id that belongs to this UI session. Never falls back
 * to the global queue head (another tab may be actively running).
 */
export function useLatestSessionRunId(sessionRunIds: readonly string[]): string | null {
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

function readSubagentDrawerWidth(): number {
  try {
    const stored = Number.parseInt(
      window.localStorage.getItem(SUBAGENT_DRAWER_WIDTH_KEY) ?? '',
      10,
    );
    return Number.isFinite(stored)
      ? clampSubagentDrawerWidth(stored)
      : SUBAGENT_DRAWER_DEFAULT_WIDTH;
  } catch {
    return SUBAGENT_DRAWER_DEFAULT_WIDTH;
  }
}

function clampSubagentDrawerWidth(width: number): number {
  return Math.round(
    Math.min(SUBAGENT_DRAWER_MAX_WIDTH, Math.max(SUBAGENT_DRAWER_MIN_WIDTH, width)),
  );
}
