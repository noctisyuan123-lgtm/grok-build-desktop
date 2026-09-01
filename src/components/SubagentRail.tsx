import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
  type ReactNode,
} from 'react';
import { ChevronRight } from 'lucide-react';
import type { ChatMessage } from '../app/types';
import { streamStore } from '../lib/streamStore';
import type { TraceEvent } from '../lib/traceParser';
import {
  collectSessionSubagents,
  partitionSessionSubagents,
  type SessionSubagent,
} from '../lib/sessionSubagents';
import { t } from '../i18n';
import { SubagentInspector } from './SubagentFloat';
import { SubagentUiContext, useSubagentUi, type SubagentOpenTarget } from './subagentUiContext';

const RAIL_COLLAPSED_KEY = 'grok-desktop-subagent-rail-collapsed';
const RAIL_COLORS = ['#6f9f7b', '#7a8fa8', '#b89bc4', '#c49978', '#8aa3c0', '#c26c6c'];

export function SubagentUiProvider({
  messages,
  children,
}: {
  messages: readonly ChatMessage[];
  children: ReactNode;
}) {
  const sessionRunIds = useMemo(
    () => messages.map((message) => message.runId).filter((id): id is string => Boolean(id)),
    [messages],
  );
  const items = useSessionSubagents(sessionRunIds, messages);
  const [open, setOpen] = useState<SubagentOpenTarget | null>(null);
  const [collapsed, setCollapsed] = useState(() => {
    try {
      return window.localStorage.getItem(RAIL_COLLAPSED_KEY) === '1';
    } catch {
      return false;
    }
  });
  const ignoreNodes = useRef(new Map<string, HTMLElement>());
  const registerIgnoreNode = useCallback((id: string, node: HTMLElement | null) => {
    if (node) ignoreNodes.current.set(id, node);
    else ignoreNodes.current.delete(id);
  }, []);

  useEffect(() => {
    window.localStorage.setItem(RAIL_COLLAPSED_KEY, collapsed ? '1' : '0');
  }, [collapsed]);

  useEffect(() => {
    if (!open) return;
    if (!items.some((item) => item.key === open.key && item.runId === open.runId)) {
      const fallback = items.find((item) => item.key === open.key);
      setOpen(fallback ? { runId: fallback.runId, key: fallback.key } : null);
    }
  }, [items, open]);

  const selected =
    items.find((item) => item.key === open?.key && item.runId === open.runId) ?? null;
  const ignoreRefs = useMemo(
    () => [
      {
        get current() {
          return ignoreNodes.current.get('capsules') ?? null;
        },
      },
      {
        get current() {
          return ignoreNodes.current.get('rail') ?? null;
        },
      },
    ],
    [],
  );

  const value = useMemo(
    () => ({
      open,
      setOpen,
      items,
      collapsed,
      setCollapsed,
      registerIgnoreNode,
    }),
    [collapsed, items, open, registerIgnoreNode],
  );

  return (
    <SubagentUiContext.Provider value={value}>
      {children}
      {selected ? (
        <SubagentInspector
          selected={selected}
          peers={items}
          ignoreRefs={ignoreRefs}
          onSelect={(item) => setOpen({ runId: item.runId, key: item.key })}
          onClose={() => setOpen(null)}
        />
      ) : null}
    </SubagentUiContext.Provider>
  );
}

export function SubagentRail() {
  const ui = useSubagentUi();
  const railRef = useRef<HTMLElement | null>(null);

  useEffect(() => {
    if (!ui) return;
    ui.registerIgnoreNode('rail', railRef.current);
    return () => ui.registerIgnoreNode('rail', null);
  }, [ui]);

  if (!ui || ui.items.length === 0) return null;

  const { active, done } = partitionSessionSubagents(ui.items);
  const collapsed = ui.collapsed;
  const summary =
    collapsed && active.length > 0
      ? t('subagent.railWorkingCount', { count: active.length })
      : String(ui.items.length);

  return (
    <aside
      ref={railRef}
      className={`subagent-rail${collapsed ? ' is-collapsed' : ''}${active.length ? ' is-live' : ''}`}
      aria-label={t('subagent.railTitle')}
    >
      <button
        type="button"
        className="subagent-rail-toggle"
        aria-expanded={!collapsed}
        aria-label={collapsed ? t('subagent.railExpand') : t('subagent.railCollapse')}
        onClick={() => ui.setCollapsed(!collapsed)}
      >
        <span className="subagent-rail-title">{t('subagent.railTitle')}</span>
        <span className="subagent-rail-count">{summary}</span>
      </button>
      {collapsed ? null : (
        <div className="subagent-rail-body">
          {active.length > 0 ? (
            <RailSection
              title={t('subagent.railActive')}
              count={active.length}
              items={active}
              openKey={ui.open?.key ?? null}
              onOpen={ui.setOpen}
            />
          ) : null}
          {done.length > 0 ? (
            <RailSection
              title={t('subagent.railDone')}
              count={done.length}
              items={done}
              openKey={ui.open?.key ?? null}
              onOpen={ui.setOpen}
            />
          ) : null}
        </div>
      )}
    </aside>
  );
}

function RailSection({
  title,
  count,
  items,
  openKey,
  onOpen,
}: {
  title: string;
  count: number;
  items: readonly SessionSubagent[];
  openKey: string | null;
  onOpen: (next: SubagentOpenTarget | null) => void;
}) {
  return (
    <section className="subagent-rail-section">
      <h3>
        {title}
        <span>{count}</span>
      </h3>
      <ul>
        {items.map((item) => {
          const live = item.status === 'running';
          const selected = openKey === item.key;
          return (
            <li key={`${item.runId}:${item.key}`}>
              <button
                type="button"
                className={`subagent-rail-row${live ? ' is-live' : ''}${selected ? ' is-open' : ''}`}
                aria-current={selected ? 'true' : undefined}
                aria-label={t('subagent.floatOpen', { label: item.label })}
                onClick={() => onOpen(selected ? null : { runId: item.runId, key: item.key })}
              >
                <span
                  className="subagent-rail-swatch"
                  style={{ background: colorForKey(item.key) }}
                  aria-hidden
                />
                <span className="subagent-rail-label">{item.label}</span>
                <span className="subagent-rail-meta">
                  {live ? t('subagent.statusWorking') : compactDuration(item)}
                </span>
                {selected ? <ChevronRight size={12} aria-hidden /> : null}
              </button>
            </li>
          );
        })}
      </ul>
    </section>
  );
}

function useSessionSubagents(
  sessionRunIds: readonly string[],
  messages: readonly ChatMessage[],
): SessionSubagent[] {
  const liveKey = useSyncExternalStore(
    streamStore.subscribe,
    () =>
      sessionRunIds
        .map((id) => {
          const traces = streamStore.getRunSnapshot(id)?.traces ?? [];
          return traces
            .filter((trace) => trace.kind === 'subagent')
            .map((trace) => `${id}:${trace.key}:${trace.status}:${trace.progress ?? ''}`)
            .join(',');
        })
        .join('|'),
    () => '',
  );
  return useMemo(() => {
    void liveKey;
    const liveTraces = new Map<string, readonly TraceEvent[]>(
      sessionRunIds.map((id) => [id, streamStore.getRunSnapshot(id)?.traces ?? []]),
    );
    return collectSessionSubagents(
      sessionRunIds,
      messages.map((message) => ({ runId: message.runId, traces: message.meta?.traces })),
      liveTraces,
    );
  }, [liveKey, messages, sessionRunIds]);
}

function colorForKey(key: string): string {
  let hash = 0;
  for (let index = 0; index < key.length; index += 1) {
    hash = (hash * 31 + key.charCodeAt(index)) | 0;
  }
  return RAIL_COLORS[Math.abs(hash) % RAIL_COLORS.length] ?? RAIL_COLORS[0]!;
}

function compactDuration(item: SessionSubagent): string {
  if (item.startedAt == null || item.endedAt == null) return '';
  const ms = item.endedAt - item.startedAt;
  if (ms < 60_000) return `${Math.max(1, Math.round(ms / 1000))}s`;
  return `${Math.round(ms / 60_000)}m`;
}
