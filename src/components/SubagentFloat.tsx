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
import { streamStore } from '../lib/streamStore';
import { resolveSubagentPrompt, type TraceEvent, type TraceStatus } from '../lib/traceParser';
import type { SessionSubagent } from '../lib/sessionSubagents';
import { useSubagentUi } from './subagentUiContext';
import { PlanTodoList, resolvePlanEntriesFromTraces } from './PlanTodoList';
import { LongTextMessage } from './LongTextMessage';
import { TranscriptMessage } from './MessageItem';
import { isLongUserText } from '../lib/longText';
import { t } from '../i18n';

const SUBAGENT_DRAWER_WIDTH_KEY = 'grok-desktop-subagent-drawer-width';
const SUBAGENT_DRAWER_DEFAULT_WIDTH = 520;
const SUBAGENT_DRAWER_MIN_WIDTH = 360;
const SUBAGENT_DRAWER_MAX_WIDTH = 760;

/**
 * Compact capsules above the composer for every subagent on the current
 * session's latest assistant run. A capsule opens the right-side inspector
 * with that child session's workflow transcript.
 */
export function SubagentFloat({ sessionRunIds = [] }: { sessionRunIds?: readonly string[] }) {
  const ui = useSubagentUi();
  const focusRunId = useLatestSessionRunId(sessionRunIds);
  const snapshot = useRunSnapshot(focusRunId ?? '');
  const subagents = useMemo(
    () => pickSubagents(snapshot?.traces ?? [], focusRunId),
    [snapshot?.traces, focusRunId],
  );
  const [localOpenKey, setLocalOpenKey] = useState<string | null>(null);
  const dockRef = useRef<HTMLDivElement | null>(null);
  const openKey = ui ? (ui.open?.key ?? null) : localOpenKey;
  const setOpenKey = (key: string | null) => {
    if (ui) {
      if (!key || !focusRunId) {
        ui.setOpen(null);
        return;
      }
      ui.setOpen({ runId: focusRunId, key });
      return;
    }
    setLocalOpenKey(key);
  };

  useEffect(() => {
    if (ui) ui.registerIgnoreNode('capsules', dockRef.current);
    return () => {
      ui?.registerIgnoreNode('capsules', null);
    };
  }, [ui]);

  useEffect(() => {
    if (ui) return;
    if (!subagents.some((item) => item.key === localOpenKey)) setLocalOpenKey(null);
  }, [localOpenKey, subagents, ui]);

  const selected = subagents.find((item) => item.key === openKey) ?? null;
  const standalonePeers: SessionSubagent[] = focusRunId
    ? subagents.map((item) => ({ ...item, runId: focusRunId }))
    : [];

  if (!focusRunId || subagents.length === 0) return null;

  return (
    <>
      <div className="subagent-float-list" ref={dockRef} aria-label={t('subagent.dockTitle')}>
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
                title={
                  subagent.progress
                    ? `${subagent.label} · ${statusLabelFor(subagent.status)} · ${subagent.progress}`
                    : `${subagent.label} · ${statusLabelFor(subagent.status)}`
                }
                aria-label={t('subagent.floatOpen', { label: subagent.label })}
                aria-expanded={drawerOpen}
                aria-controls={
                  drawerOpen ? `subagent-session-drawer-${sanitizeKey(subagent.key)}` : undefined
                }
                onClick={() => setOpenKey(drawerOpen ? null : subagent.key)}
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
      {!ui && selected && focusRunId ? (
        <SubagentInspector
          selected={{ ...selected, runId: focusRunId }}
          peers={standalonePeers}
          ignoreRefs={[dockRef]}
          onSelect={(item) => setOpenKey(item.key)}
          onClose={() => setOpenKey(null)}
        />
      ) : null}
    </>
  );
}

export function SubagentInspector({
  selected,
  peers,
  ignoreRefs = [],
  onSelect,
  onClose,
}: {
  selected: SessionSubagent;
  peers: readonly SessionSubagent[];
  ignoreRefs?: Array<{ current: HTMLElement | null }>;
  onSelect: (item: SessionSubagent) => void;
  onClose: () => void;
}) {
  const [drawerWidth, setDrawerWidth] = useState(readSubagentDrawerWidth);
  const resizingCleanupRef = useRef<(() => void) | null>(null);
  const drawerRef = useRef<HTMLDivElement | null>(null);
  const closeRef = useRef<HTMLButtonElement | null>(null);
  const now = useTickingNow(selected.status === 'running');
  const selectedElapsed = elapsedMs(selected.startedAt, selected.endedAt, now);

  useEffect(() => {
    window.localStorage.setItem(SUBAGENT_DRAWER_WIDTH_KEY, String(drawerWidth));
    document.documentElement.style.setProperty('--subagent-drawer-open-width', `${drawerWidth}px`);
    return () => {
      document.documentElement.style.removeProperty('--subagent-drawer-open-width');
    };
  }, [drawerWidth]);

  useEffect(
    () => () => {
      resizingCleanupRef.current?.();
    },
    [],
  );

  useEffect(() => {
    drawerRef.current?.focus();
    const onPointerDown = (event: PointerEvent) => {
      const target = event.target as Node | null;
      if (!target) return;
      if (drawerRef.current?.contains(target)) return;
      if (ignoreRefs.some((ref) => ref.current?.contains(target))) return;
      onClose();
    };
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.isComposing || event.keyCode === 229) return;
      if (event.key !== 'Escape') return;
      event.preventDefault();
      onClose();
    };
    document.addEventListener('pointerdown', onPointerDown);
    document.addEventListener('keydown', onKeyDown, true);
    return () => {
      document.removeEventListener('pointerdown', onPointerDown);
      document.removeEventListener('keydown', onKeyDown, true);
    };
  }, [ignoreRefs, onClose, selected.key]);

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

  return createPortal(
    <aside
      id={`subagent-session-drawer-${sanitizeKey(selected.key)}`}
      className="subagent-drawer"
      ref={drawerRef}
      role="dialog"
      aria-modal="false"
      aria-label={t('subagent.drawerTitle', { label: selected.label })}
      style={{ width: `${drawerWidth}px` }}
      tabIndex={-1}
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
          {peers.length > 1 ? (
            <label className="subagent-drawer-switcher">
              <span className="subagent-drawer-switcher-label">{t('subagent.switch')}</span>
              <select
                value={selected.key}
                aria-label={t('subagent.switch')}
                onChange={(event) => {
                  const next = peers.find((item) => item.key === event.target.value);
                  if (next) onSelect(next);
                }}
              >
                {peers.map((item) => (
                  <option key={item.key} value={item.key}>
                    {item.label}
                  </option>
                ))}
              </select>
            </label>
          ) : (
            <strong>{selected.label}</strong>
          )}
          <span
            className={`subagent-drawer-meta-inline status-${selected.status}`}
            aria-label={statusLabelFor(selected.status)}
          >
            <span className={`subagent-status-dot status-${selected.status}`} aria-hidden />
            <span className="subagent-drawer-meta-text">
              {selectedElapsed != null
                ? formatDuration(selectedElapsed)
                : statusLabelFor(selected.status)}
            </span>
          </span>
        </div>
        <button
          ref={closeRef}
          type="button"
          className="subagent-drawer-close"
          aria-label={t('subagent.drawerClose')}
          onClick={onClose}
        >
          <X size={16} aria-hidden />
        </button>
      </header>
      <SubagentDrawerBody key={selected.key} runId={selected.runId} subagent={selected} />
    </aside>,
    document.body,
  );
}

function SubagentDrawerBody({ runId, subagent }: { runId: string; subagent: TraceEvent }) {
  const snapshot = useRunSnapshot(runId);
  const elapsed = useElapsed(subagent.startedAt, subagent.endedAt);
  const children = useMemo(() => {
    const traces = snapshot?.traces ?? [];
    return traces.filter((trace) => trace.parentKey === subagent.key);
  }, [snapshot?.traces, subagent.key]);
  const transcript = subagent.transcript ?? [];
  const live = subagent.status === 'running';
  const transcriptRunId = `${runId}:subagent:${subagent.key}`;
  const planEntries = useMemo(() => resolvePlanEntriesFromTraces(children), [children]);
  const hasTranscript = transcript.length > 0;
  const prompt = resolveSubagentPrompt(subagent, snapshot?.traces ?? []);
  const emptyLabel = live ? t('subagent.emptyLive') : t('subagent.emptyDone');

  return (
    <div className="subagent-drawer-body">
      {prompt ? (
        <div className="message message-user subagent-drawer-prompt">
          {isLongUserText(prompt) ? (
            <LongTextMessage text={prompt} />
          ) : (
            <pre className="message-body">{prompt}</pre>
          )}
        </div>
      ) : null}
      {planEntries?.length ? <PlanTodoList entries={planEntries} /> : null}
      {hasTranscript ? (
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
        </div>
      ) : children.length > 0 ? (
        <ul className="subagent-drawer-tools" aria-label={t('message.traceAriaLabel')}>
          {children.map((child) => (
            <li key={child.key}>
              <span className={`subagent-status-dot status-${child.status}`} aria-hidden />
              <span>{child.label}</span>
            </li>
          ))}
        </ul>
      ) : planEntries?.length || prompt ? null : (
        <p className="subagent-drawer-empty">{emptyLabel}</p>
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

function elapsedMs(
  startedAt: number | null | undefined,
  endedAt: number | null | undefined,
  now: number,
): number | null {
  if (!startedAt) return null;
  return (endedAt ?? now) - startedAt;
}

function useTickingNow(active: boolean): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!active) return;
    const handle = window.setInterval(() => setNow(Date.now()), 200);
    return () => window.clearInterval(handle);
  }, [active]);
  return now;
}

function sanitizeKey(key: string): string {
  return key.replace(/[^a-zA-Z0-9_-]/g, '-');
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
