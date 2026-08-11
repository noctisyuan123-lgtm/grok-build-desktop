import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type PointerEvent as ReactPointerEvent,
} from 'react';
import { openUrl } from '@tauri-apps/plugin-opener';
import { Globe2, PanelRight, TerminalSquare } from 'lucide-react';
import './App.css';
import { cancelRun, ensureStreamListenersAttached } from './lib/grok';
import { hasTauriRuntime } from './lib/runtime';
import { streamStore } from './lib/streamStore';
import { MessageList, type MessageRef } from './components/MessageList';
import type { ComposerHandle } from './components/Composer';
import { QueueDock } from './components/QueueDock';
import { CommandPalette, type PaletteAction } from './components/CommandPalette';
import { ToolsPage } from './components/ToolsPage';
import { CustomizePage } from './components/CustomizePage';
import { ContextMenu, type ContextMenuState, type ContextMenuItem } from './components/ContextMenu';
import { InspectorDrawer } from './components/InspectorDrawer';
import { Sidebar } from './components/Sidebar';
import { EmptyState } from './components/EmptyState';
import { PreviewPanel } from './components/PreviewPanel';
import { TerminalDock } from './components/TerminalDock';
import { Toolbelt } from './components/Toolbelt';
import { TitleBar } from './components/TitleBar';
import { ComposerSection } from './components/ComposerSection';
import { SettingsHost } from './components/SettingsHost';
import { UndoToast } from './components/UndoToast';
import { useActiveRun } from './hooks/useActiveRun';
import { useGrokRunners } from './hooks/useGrokRunners';
import { useUndoToast } from './hooks/useUndoToast';
import { useSessionPersistence } from './hooks/useSessionPersistence';
import { useModelConfig } from './hooks/useModelConfig';
import { useSessionTabs } from './hooks/useSessionTabs';
import { useAppShortcuts } from './hooks/useAppShortcuts';
import { useHistoryOrganization } from './hooks/useHistoryOrganization';

import {
  isDockPosition,
  isInspectorTab,
  type ChatMessageStatus,
  type DockPosition,
  type InspectorTab,
  type Mode,
} from './app/types';
import { codingPresets, defaultDrafts, storageKeys } from './app/constants';
import { t } from './i18n';
import { makeId } from './app/format';
import { buildGrokArgs } from './app/grokArgs';
import type { ComposerAttachment } from './lib/attachments';

const SIDEBAR_WIDTH_KEY = 'grok-desktop-sidebar-width';
const SIDEBAR_DEFAULT_WIDTH = 272;
const SIDEBAR_MIN_WIDTH = 220;
const SIDEBAR_MAX_WIDTH = 440;

function storedSidebarWidth(): number {
  const parsed = Number.parseInt(window.localStorage.getItem(SIDEBAR_WIDTH_KEY) ?? '', 10);
  if (!Number.isFinite(parsed) || parsed === 260) return SIDEBAR_DEFAULT_WIDTH;
  return Math.min(SIDEBAR_MAX_WIDTH, Math.max(SIDEBAR_MIN_WIDTH, parsed));
}

function App() {
  // The textarea lives inside Composer (uncontrolled ref). We hold a
  // ComposerHandle so starter cards / history clicks / drafts can seed it.
  const composerRef = useRef<ComposerHandle | null>(null);
  const setComposerValue = useCallback((value: string) => {
    composerRef.current?.setValue(value);
  }, []);
  const [sessionNotice, setSessionNotice] = useState<string | null>(null);
  // Full attachment data is intentionally transient: persisting multi-MB data
  // URLs in localStorage would exceed its quota. It remains available for the
  // current app lifetime and is keyed by the stable user-message id.
  const [messageAttachments, setMessageAttachments] = useState<
    Record<string, ComposerAttachment[]>
  >({});
  // Session state (mode/drafts/cwd/theme/history/messages) + localStorage and
  // session_state.json persistence live in hooks/useSessionPersistence.ts.
  const {
    mode,
    setMode,
    drafts,
    setDrafts,
    codingCwd,
    setCodingCwd,
    shellCommand,
    actionPolicy,
    setActionPolicy,
    codingWorkflow,
    setCodingWorkflow,
    themeMode,
    setThemeMode,
    lastRun,
    setLastRun,
    history,
    setHistory,
    totalRuns,
    setTotalRuns,
    messages,
    setMessages,
    recordRun,
    appendMessage,
  } = useSessionPersistence({ setComposerValue, setSessionNotice });
  // Multi-session tabs (persistence, create/switch/delete, active-tab mirror)
  // live in hooks/useSessionTabs.ts. removeConversationMeta and setContextMenu
  // are declared later; the callback only runs from event handlers, after
  // every hook has initialized.
  const { tabs, activeTabId, handleTabCreate, switchToSession, deleteSession, sessionFirstPrompt } =
    useSessionTabs({
      messages,
      setMessages,
      codingCwd,
      setCodingCwd,
      setDrafts,
      setLastRun,
      setSessionNotice,
      setComposerValue,
      focusComposer: () => composerRef.current?.focus(),
      closePalette: () => setPaletteOpen(false),
      onConversationDeleted: () => {
        // Metadata cleanup is deferred to the undo-toast expiry (see
        // deleteConversation below) so undo restores pin/group/label too.
        setContextMenu(null);
      },
    });
  // Undo window for destructive actions (delete conversation, clear history).
  const { undoToast, showUndoToast, undoNow } = useUndoToast();
  const [previewOpen, setPreviewOpen] = useState(false);
  const [contextOpen, setContextOpen] = useState(false);
  const [terminalOpen, setTerminalOpen] = useState(false);
  const [toolsOpen, setToolsOpen] = useState(false);
  // Developer-utilities <details> (Browser / Absorb Repo).
  // Independent from `toolsOpen` so the inspector and the toolbelt don't both
  // pop open at once and stack on top of each other in the right column.
  const [toolbeltOpen, setToolbeltOpen] = useState(false);
  // ⌘K command palette — global, lives outside the panel-toggle group above.
  const [paletteOpen, setPaletteOpen] = useState(false);
  // Dedicated Settings page (Claude-Desktop-style modal). settingsSection
  // selects which left-nav panel is shown.
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [settingsSection, setSettingsSection] = useState<
    'general' | 'model' | 'permissions' | 'integrations' | 'about'
  >('general');
  // Dedicated Tools / MCP hub (community-tool integration).
  const [toolsPageOpen, setToolsPageOpen] = useState(false);
  const [customizeOpen, setCustomizeOpen] = useState(false);
  // App-owned right-click menu (replaces the suppressed WebView menu).
  const [contextMenu, setContextMenu] = useState<ContextMenuState | null>(null);
  // History organization (pin/rename/group/archive metadata, filter, derived
  // row views) lives in hooks/useHistoryOrganization.ts; the Sidebar consumes
  // the whole API object, App only needs these three.
  const historyApi = useHistoryOrganization({
    tabs,
    activeTabId,
    messages,
    sessionFirstPrompt,
    closeContextMenu: () => setContextMenu(null),
  });
  const { recentPrompts, removeConversationMeta } = historyApi;
  // Sidebar collapse for ⌘B — defaults to expanded.
  const [sidebarCollapsed, setSidebarCollapsed] = useState<boolean>(() => {
    return window.localStorage.getItem('grok-desktop-sidebar-collapsed') === '1';
  });
  const sidebarWidthRef = useRef(storedSidebarWidth());
  const [dockPosition, setDockPosition] = useState<DockPosition>(() => {
    const stored = window.localStorage.getItem(storageKeys.dockPosition);
    return isDockPosition(stored) ? stored : 'right';
  });
  const [inspectorTab, setInspectorTab] = useState<InspectorTab>(() => {
    const stored = window.localStorage.getItem(storageKeys.inspectorTab);
    return isInspectorTab(stored) ? stored : 'skills';
  });
  // Session notices (folder pick, restore/save failures, …) show as a
  // transient toast over the conversation — previously they rendered only
  // inside the collapsed Terminal dock, where nobody saw them. Auto-dismiss
  // like the history toast, with a longer window so errors are readable.
  useEffect(() => {
    if (!sessionNotice) return;
    const t = window.setTimeout(() => setSessionNotice(null), 6000);
    return () => window.clearTimeout(t);
  }, [sessionNotice]);

  // Stop a run, surfacing failures. A bare `void cancelRun(...)` swallowed
  // backend rejections (queue lock, run already gone, IPC error) as unhandled
  // promise rejections — Stop could silently do nothing while the run kept
  // streaming.
  function stopRun(runId: string) {
    cancelRun(runId).catch((error) => {
      setSessionNotice(
        t('notices.stopFailed', { error: error instanceof Error ? error.message : String(error) }),
      );
    });
  }

  // External-command runners + inspector data (statuses, preview, models,
  // MCP/plugins/sessions, shell/browser/absorb/doctor) live in
  // hooks/useGrokRunners.ts; recordRun below is hoisted, so passing it here
  // is safe.
  const runners = useGrokRunners({
    codingCwd,
    shellCommand,
    lastRun,
    recordRun,
    setLastRun,
    setCodingCwd,
    setSessionNotice,
    onPreviewAvailable: () => setPreviewOpen(true),
  });
  const {
    statuses,
    grokStatus,
    staticPreview,
    previewBusy,
    availableModels,
    busyRunner,
    terminalLines,
    setTerminalLines,
    refreshStatuses,
    refreshStaticPreview,
    runDoctor,
    folderPickerBusy,
    pickFolder,
  } = runners;

  const statusMap = useMemo(
    () => Object.fromEntries(statuses.map((status) => [status.id, status])),
    [statuses],
  );

  // Model + run-configuration state (preset, efforts, permission, toggles,
  // CLI-verified options, coding auto-snap) lives in hooks/useModelConfig.ts.
  const modelConfig = useModelConfig({ mode, availableModels });
  const {
    effortLevel,
    reasoningEffort,
    permissionMode,
    bestOfN,
    experimentalMemory,
    webSearchEnabled,
    subagentsEnabled,
    selfCheck,
    activeModel,
  } = modelConfig;
  // Clear conversation + run history + terminal — destructive, so it offers
  // an undo window instead of firing blind. The snapshot is cheap (immutable
  // arrays) and restoring it re-mirrors into the active tab automatically.
  function clearRunHistory() {
    const snapshot = { lastRun, history, messages, terminalLines, totalRuns };
    setLastRun(null);
    setHistory([]);
    setMessages([]);
    setTerminalLines([]);
    setTotalRuns(0);
    window.localStorage.setItem('grok-desktop-run-count-total', '0');
    showUndoToast({
      text: t('notices.cleared'),
      undo: () => {
        setLastRun(snapshot.lastRun);
        setHistory(snapshot.history);
        setMessages(snapshot.messages);
        setTerminalLines(snapshot.terminalLines);
        setTotalRuns(snapshot.totalRuns);
        window.localStorage.setItem('grok-desktop-run-count-total', String(snapshot.totalRuns));
      },
    });
  }

  // Delete a conversation with an undo window. The tab restore comes from
  // useSessionTabs; its pin/label/group/archive metadata is only dropped once
  // the window lapses, so undo brings the row back fully organized.
  function deleteConversation(id: string) {
    const undo = deleteSession(id);
    if (!undo) return;
    showUndoToast({
      text: t('notices.conversationDeleted'),
      undo,
      onExpire: () => removeConversationMeta(id),
    });
  }

  // Write the streamed assistant text back into `messages` when a run reaches
  // a terminal state. Live rendering reads the in-memory streamStore snapshot
  // directly (MessageItem), but that store is not persisted — without this
  // write-back every persistence layer (localStorage, the tabs mirror,
  // session_state.json) stores assistant messages with content:"" and restored
  // conversations lose all replies after a restart.
  useEffect(() => {
    const finalizeEndedRuns = () => {
      setMessages((current) => {
        let changed = false;
        const next = current.map((message) => {
          if (message.role !== 'assistant' || !message.runId) {
            return message;
          }
          const snap = streamStore.getRunSnapshot(message.runId);
          // The backend's terminal state and streaming `end` event travel on
          // separate channels. If Done wins the race, a later end event must
          // still be allowed to attach its session id to the already-finalized
          // message, otherwise the next turn could not resume the right head.
          if (message.status !== 'streaming') {
            if (snap?.sessionId && message.meta?.sessionId !== snap.sessionId) {
              changed = true;
              return { ...message, meta: { ...message.meta, sessionId: snap.sessionId } };
            }
            return message;
          }
          if (!snap || snap.state === 'queued' || snap.state === 'running') return message;
          changed = true;
          const status: ChatMessageStatus =
            snap.state === 'done' ? 'done' : snap.state === 'cancelled' ? 'stopped' : 'error';
          const durationMs =
            snap.startedAt != null && snap.endedAt != null
              ? Math.max(0, snap.endedAt - snap.startedAt)
              : message.meta?.durationMs;
          // Persist the compact tool list, not potentially huge raw payloads.
          const traces = snap.traces.map(({ raw: _raw, ...trace }) => trace).slice(-100);
          const transcript = snap.transcript
            .slice(-100)
            .map((segment) =>
              segment.kind === 'thought'
                ? { ...segment, text: segment.text.slice(-20_000) }
                : segment,
            );
          return {
            ...message,
            content: snap.text || message.content,
            status,
            meta: {
              ...message.meta,
              ...(durationMs == null ? {} : { durationMs }),
              ...(traces.length === 0 ? {} : { traces }),
              ...(transcript.length === 0 ? {} : { transcript }),
              ...(snap.sessionId ? { sessionId: snap.sessionId } : {}),
            },
          };
        });
        return changed ? next : current;
      });
    };
    finalizeEndedRuns();
    return streamStore.subscribe(finalizeEndedRuns);
  }, [setMessages]);

  function updatePrompt(value: string) {
    setComposerValue(value);
    setDrafts((current) => ({ ...current, [mode]: value }));
  }
  // Right-click menu for the conversation area — real, clickable actions
  // (replaces the suppressed WebView menu). Selection-aware.
  function openConversationMenu(e: React.MouseEvent) {
    e.preventDefault();
    const selection = window.getSelection()?.toString().trim() ?? '';
    const items: ContextMenuItem[] = [];
    if (selection) {
      items.push({
        label: 'Copy',
        onClick: () => void navigator.clipboard?.writeText(selection),
      });
    }
    items.push(
      {
        label: 'New session',
        separator: selection.length > 0,
        onClick: () => {
          handleTabCreate();
          composerRef.current?.focus();
        },
      },
      {
        label: 'Clear conversation',
        disabled: messages.length === 0,
        onClick: () => clearRunHistory(),
      },
      ...(grokIsRunning && activeRunId
        ? [{ label: 'Stop current run', danger: true, onClick: () => stopRun(activeRunId) }]
        : []),
      { label: 'Settings…', separator: true, onClick: () => setSettingsOpen(true) },
    );
    setContextMenu({ x: e.clientX, y: e.clientY, items });
  }

  function applyCodingPreset(preset: (typeof codingPresets)[number]) {
    setCodingWorkflow(preset.id);
    updatePrompt(preset.prompt);
  }

  function switchMode(nextMode: Mode) {
    if (nextMode === mode || busyRunner !== null) return;
    setMode(nextMode);
    setComposerValue(drafts[nextMode] || defaultDrafts[nextMode]);
  }

  // buildGrokArgs/buildGrokRules are pure functions in app/grokArgs.ts; this
  // closure snapshots the current run config for the Composer's submit path.
  function buildRunArgs(): string[] {
    const resumeSessionId = [...messages]
      .reverse()
      .find((message) => message.role === 'assistant' && message.meta?.sessionId)?.meta?.sessionId;
    return buildGrokArgs({
      mode,
      activeModel,
      effortLevel,
      reasoningEffort,
      actionPolicy,
      permissionMode,
      bestOfN,
      experimentalMemory,
      webSearchEnabled,
      subagentsEnabled,
      selfCheck,
      codingCwd,
      resumeSessionId,
      // Never guess with cwd-global `-c`: on legacy conversations (or a
      // queued turn whose parent has not ended) it could select an undone or
      // entirely different tab's session. A missing explicit head starts a
      // clean branch; once this release records a head, follow-ups are exact.
      continueLatestSession: false,
    });
  }

  function handleEnqueued(info: {
    runId: string;
    position: number;
    prompt: string;
    rawText?: string;
    attachments: ComposerAttachment[];
  }) {
    const now = Date.now();
    const userMessageId = makeId('u');
    const assistantMessageId = makeId('a');
    if (info.attachments.length > 0) {
      setMessageAttachments((current) => ({
        ...current,
        [userMessageId]: info.attachments,
      }));
    }
    appendMessage({
      id: userMessageId,
      role: 'user',
      // Show what the user ACTUALLY typed, not the sent prompt. The Composer
      // appends expanded @-mention file contents for grok's benefit — that
      // belongs in the request, not in the chat bubble. rawText is the clean
      // original; fall back to prompt only for callers that don't pass it.
      content: info.rawText ?? info.prompt,
      ts: now,
      meta: { workflow: mode === 'coding' ? codingWorkflow : 'chat' },
    });
    appendMessage({
      id: assistantMessageId,
      role: 'assistant',
      content: '',
      ts: now,
      runId: info.runId,
      status: 'streaming',
      meta: { model: activeModel, workflow: mode === 'coding' ? codingWorkflow : 'chat' },
    });
    setTotalRuns((current) => {
      const next = current + 1;
      window.localStorage.setItem('grok-desktop-run-count-total', String(next));
      return next;
    });
  }

  function togglePanel(target: 'preview' | 'context' | 'terminal' | 'tools') {
    const next = !(target === 'preview'
      ? previewOpen
      : target === 'context'
        ? contextOpen
        : target === 'terminal'
          ? terminalOpen
          : toolsOpen);
    setPreviewOpen(target === 'preview' ? next : false);
    setContextOpen(target === 'context' ? next : false);
    setTerminalOpen(target === 'terminal' ? next : false);
    setToolsOpen(target === 'tools' ? next : false);
    if (next && target === 'preview') void refreshStaticPreview();
  }

  // Top-right "panels" menu — Preview / Context / Terminal / Tools, each opens
  // its panel (Claude-style). A ✓ marks the currently-open panel. Anchored
  // under the button.
  function openPanelMenu(e: React.MouseEvent) {
    e.preventDefault();
    const b = (e.currentTarget as HTMLElement).getBoundingClientRect();
    setContextMenu({
      x: Math.round(b.right),
      y: Math.round(b.bottom + 6),
      items: [
        {
          label: 'Preview',
          icon: <Globe2 size={15} />,
          shortcut: previewOpen ? '✓' : undefined,
          onClick: () => togglePanel('preview'),
        },
        {
          label: 'Context inspector',
          icon: <PanelRight size={15} />,
          shortcut: contextOpen ? '✓' : undefined,
          onClick: () => togglePanel('context'),
        },
        {
          label: 'Terminal',
          icon: <TerminalSquare size={15} />,
          shortcut: terminalOpen ? '✓' : undefined,
          onClick: () => togglePanel('terminal'),
        },
      ],
    });
  }

  // Subscribe to the run-event / run-state / queue Tauri events. Retries with
  // backoff inside ensureStreamListenersAttached; if every attempt fails the
  // app would look alive but never render a streamed reply, so tell the user
  // instead of logging into the void.
  useEffect(() => {
    if (!hasTauriRuntime()) return;
    let cancelled = false;
    ensureStreamListenersAttached().catch((error) => {
      if (cancelled) return;
      setSessionNotice(
        t('notices.liveUpdatesUnavailable', {
          error: error instanceof Error ? error.message : String(error),
        }),
      );
    });
    return () => {
      cancelled = true;
    };
  }, []);

  // Open external links in the system browser. Assistant markdown renders raw
  // <a href> tags; in a Tauri webview a plain click would navigate the app
  // window itself to the remote site, replacing the whole UI with no way back.
  // Delegate at document level (capture) so every injected anchor is covered.
  useEffect(() => {
    const onClick = (e: MouseEvent) => {
      const target = e.target instanceof Element ? e.target : null;
      const anchor = target?.closest('a[href]');
      if (!anchor) return;
      const href = anchor.getAttribute('href') ?? '';
      if (!/^https?:\/\//i.test(href)) return;
      e.preventDefault();
      if (hasTauriRuntime()) {
        void openUrl(href).catch(() => {});
      } else {
        window.open(href, '_blank', 'noopener');
      }
    };
    document.addEventListener('click', onClick, true);
    return () => document.removeEventListener('click', onClick, true);
  }, []);

  // Persist sidebar-collapsed state so ⌘B is sticky across reloads.
  useEffect(() => {
    window.localStorage.setItem('grok-desktop-sidebar-collapsed', sidebarCollapsed ? '1' : '0');
  }, [sidebarCollapsed]);

  useEffect(() => {
    document.documentElement.style.setProperty('--sidebar-width', `${sidebarWidthRef.current}px`);
    return () => {
      document.documentElement.style.removeProperty('--sidebar-width');
    };
  }, []);

  function startSidebarResize(event: ReactPointerEvent<HTMLDivElement>) {
    if (sidebarCollapsed || event.button !== 0) return;
    event.preventDefault();
    const startX = event.clientX;
    const startWidth = sidebarWidthRef.current;
    document.body.classList.add('sidebar-resizing');

    const move = (moveEvent: PointerEvent) => {
      const next = Math.min(
        SIDEBAR_MAX_WIDTH,
        Math.max(SIDEBAR_MIN_WIDTH, startWidth + moveEvent.clientX - startX),
      );
      sidebarWidthRef.current = Math.round(next);
      document.documentElement.style.setProperty('--sidebar-width', `${Math.round(next)}px`);
    };
    const finish = () => {
      document.body.classList.remove('sidebar-resizing');
      window.localStorage.setItem(SIDEBAR_WIDTH_KEY, String(sidebarWidthRef.current));
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', finish);
      window.removeEventListener('pointercancel', finish);
    };
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', finish);
    window.addEventListener('pointercancel', finish);
  }
  // ⌘K palette catalogue + global keyboard shortcuts live in
  // hooks/useAppShortcuts.ts.
  const { paletteActions } = useAppShortcuts({
    paletteOpen,
    setPaletteOpen,
    sidebarCollapsed,
    setSidebarCollapsed,
    previewOpen,
    setPreviewOpen,
    contextOpen,
    setContextOpen,
    terminalOpen,
    setTerminalOpen,
    toolsOpen,
    setToolsOpen,
    setToolsPageOpen,
    setSettingsOpen,
    setInspectorTab,
    themeMode,
    setThemeMode,
    togglePanel,
    handleTabCreate,
    clearRunHistory,
    focusComposer: () => composerRef.current?.focus(),
    stopRun,
    switchMode,
    busyRunner,
    drafts,
    mode,
  });
  useEffect(() => {
    window.localStorage.setItem(storageKeys.dockPosition, dockPosition);
  }, [dockPosition]);

  useEffect(() => {
    window.localStorage.setItem(storageKeys.inspectorTab, inspectorTab);
  }, [inspectorTab]);

  // Make ⌘K Search actually search the user's WORK, not just commands: each
  // recent prompt becomes a searchable palette entry that restores it to the
  // composer. (Search previously only filtered the command list, so typing a
  // topic keyword found nothing — "search doesn't work".)
  const historyPaletteActions = useMemo<PaletteAction[]>(
    () =>
      recentPrompts.slice(0, 50).map((p) => ({
        id: `history-${p.id}`,
        label: p.title,
        hint: p.detail ? `History · ${p.detail}` : 'History',
        group: 'History',
        run: () => switchToSession(p.id),
      })),
    [recentPrompts, switchToSession],
  );
  const allPaletteActions = useMemo(
    () => [...paletteActions, ...historyPaletteActions],
    [paletteActions, historyPaletteActions],
  );
  const grokToolStatus = statusMap.grok;
  const isGrokReady = Boolean(grokStatus?.authenticated);
  const workspacePath = codingCwd.trim() || 'No project selected';
  const activeRun = useActiveRun();
  const grokIsRunning = Boolean(activeRun && activeRun.state === 'running');
  const activeRunId = activeRun?.id ?? null;

  // Refresh the static preview when a streaming grok run finishes. The main
  // chat path (enqueue_run) never touches lastRun, so keying only on it left
  // the Preview panel stale after exactly the runs it exists to showcase
  // ("ask Grok to create index.html…"). Watch the running→not-running edge.
  const wasRunningRef = useRef(false);
  useEffect(() => {
    if (wasRunningRef.current && !grokIsRunning) void refreshStaticPreview();
    wasRunningRef.current = grokIsRunning;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [grokIsRunning]);

  // "Undo response" is deliberately limited to the latest completed turn.
  // Removing an older pair would leave later answers backed by context that is
  // no longer visible. The prompt is restored verbatim to the composer, and
  // the existing undo toast makes this destructive operation recoverable.
  function undoAssistantResponse(messageId: string) {
    if (grokIsRunning) return;
    const assistantIndex = messages.findIndex((message) => message.id === messageId);
    if (assistantIndex !== messages.length - 1) return;
    const assistant = messages[assistantIndex];
    const user = messages[assistantIndex - 1];
    if (
      !assistant ||
      assistant.role !== 'assistant' ||
      assistant.status === 'streaming' ||
      !user ||
      user.role !== 'user'
    ) {
      return;
    }

    const snapshot = messages;
    const previousDraft = composerRef.current?.getValue() ?? '';
    setMessages(messages.slice(0, assistantIndex - 1));
    updatePrompt(user.content);
    composerRef.current?.focus();
    showUndoToast({
      text: t('message.turnUndone'),
      undo: () => {
        setMessages(snapshot);
        updatePrompt(previousDraft);
      },
    });
  }

  const messageRefs: MessageRef[] = useMemo(() => {
    const latestIndex = messages.length - 1;
    return messages.map((m, index) =>
      m.role === 'user'
        ? {
            runId: '',
            role: 'user' as const,
            // Older builds embedded `📎 filename` into the bubble. The
            // original bytes were never persisted, so we cannot recover a
            // thumbnail after restart, but we can stop exposing that legacy
            // pseudo-link. New attachments use the preview strip above.
            userText: m.content.replace(/\n\n📎[^\n]*$/, ''),
            id: m.id,
            attachments: messageAttachments[m.id],
          }
        : {
            // Live runs keep their real id; restored/legacy assistant
            // messages get a STABLE synthetic id (msg:<id>) so MessageItem
            // can key their worker-rendered markdown HTML and they don't all
            // collide on "". fallbackText still feeds the worker + the
            // plain-text fallback while parsing.
            runId: m.runId || `msg:${m.id}`,
            role: 'assistant' as const,
            fallbackText: m.content,
            durationMs: m.meta?.durationMs,
            traces: m.meta?.traces,
            transcript: m.meta?.transcript,
            autoExpandWork: m.status === 'streaming',
            id: m.id,
            canUndo: index === latestIndex && m.status !== 'streaming' && !grokIsRunning,
          },
    );
  }, [grokIsRunning, messageAttachments, messages]);
  return (
    <main className={`app-shell theme-${themeMode}${sidebarCollapsed ? ' sidebar-collapsed' : ''}`}>
      <CommandPalette
        open={paletteOpen}
        actions={allPaletteActions}
        onClose={() => setPaletteOpen(false)}
      />
      <SettingsHost
        open={settingsOpen}
        section={settingsSection}
        onSection={setSettingsSection}
        onClose={() => setSettingsOpen(false)}
        themeMode={themeMode}
        setThemeMode={setThemeMode}
        dockPosition={dockPosition}
        setDockPosition={(d) => {
          setDockPosition(d);
          window.localStorage.setItem(storageKeys.dockPosition, d);
        }}
        sidebarCollapsed={sidebarCollapsed}
        setSidebarCollapsed={setSidebarCollapsed}
        modelConfig={modelConfig}
        actionPolicy={actionPolicy}
        setActionPolicy={setActionPolicy}
        codingCwd={codingCwd}
        setCodingCwd={setCodingCwd}
        onPickFolder={() => void pickFolder()}
        grokVersionLine={`Grok CLI ${grokStatus?.version ?? 'unknown'}`}
      />
      <ToolsPage open={toolsPageOpen} onClose={() => setToolsPageOpen(false)} cwd={codingCwd} />
      <CustomizePage
        open={customizeOpen}
        onClose={() => setCustomizeOpen(false)}
        cwd={codingCwd}
        onOpenCatalog={() => {
          setCustomizeOpen(false);
          setToolsPageOpen(true);
        }}
      />
      <ContextMenu menu={contextMenu} onClose={() => setContextMenu(null)} />
      <Sidebar
        history={historyApi}
        sessionFirstPrompt={sessionFirstPrompt}
        switchToSession={switchToSession}
        deleteSession={deleteConversation}
        handleTabCreate={handleTabCreate}
        focusComposer={() => composerRef.current?.focus()}
        setContextMenu={setContextMenu}
        paletteOpen={paletteOpen}
        setPaletteOpen={setPaletteOpen}
        setSettingsOpen={setSettingsOpen}
        customizeOpen={customizeOpen}
        setCustomizeOpen={setCustomizeOpen}
        busyRunner={busyRunner}
        refreshStatuses={refreshStatuses}
        runDoctor={runDoctor}
        grokToolStatus={grokToolStatus}
        isGrokReady={isGrokReady}
        sidebarCollapsed={sidebarCollapsed}
        setSidebarCollapsed={setSidebarCollapsed}
        mode={mode}
        switchMode={switchMode}
      />
      <div
        className="sidebar-resizer"
        role="separator"
        aria-label="Resize sidebar"
        aria-orientation="vertical"
        onPointerDown={startSidebarResize}
      />
      <section className={`workspace dock-${dockPosition}${terminalOpen ? ' terminal-open' : ''}`}>
        {/* Minimal, Claude-Desktop-style top bar. The old toolbar row (Repo
            input, model chip, Preview/Context/Terminal/Tools/Settings, status
            pill) is gone — those all live in the sidebar, ⌘K palette, the
            bottom status bar, and Settings now. What stays here is just the
            project chip (click → folder picker), a draggable spacer, theme,
            and panels. Stop replaces the composer send button while running. */}
        <TitleBar
          themeMode={themeMode}
          setThemeMode={setThemeMode}
          anyPanelOpen={contextOpen || previewOpen || terminalOpen || toolsOpen}
          openPanelMenu={openPanelMenu}
        />
        <section className="workbench">
          <div
            className={`conversation-panel${messages.length === 0 ? ' is-empty' : ''}`}
            onContextMenu={openConversationMenu}
          >
            {/* Session tabs removed per request — Claude-Desktop-style single
                conversation. New Session starts fresh; earlier conversations
                stay reachable from the HISTORY sidebar (which aggregates
                across sessions). The tabs state machinery is retained purely
                as the per-session history store. */}
            {/* Scroll position is owned by MessageList's Virtuoso instance —
                this div only provides the flex sizing for it. */}
            <div className="conversation-scroll">
              {messages.length === 0 ? (
                <EmptyState
                  codingCwd={codingCwd}
                  folderPickerBusy={folderPickerBusy}
                  onPickWorkspace={() => {
                    void pickFolder();
                  }}
                />
              ) : (
                <MessageList messages={messageRefs} onUndoAssistant={undoAssistantResponse} />
              )}
            </div>

            {sessionNotice ? (
              <div className="session-toast" role="status">
                {sessionNotice}
              </div>
            ) : null}
            <UndoToast toast={undoToast} onUndo={undoNow} />

            <QueueDock
              onError={(message) =>
                setSessionNotice(t('notices.queueActionFailed', { error: message }))
              }
            />
            <ComposerSection
              composerRef={composerRef}
              codingCwd={codingCwd}
              buildRunArgs={buildRunArgs}
              drafts={drafts}
              mode={mode}
              setDrafts={setDrafts}
              handleEnqueued={handleEnqueued}
              setSessionNotice={setSessionNotice}
              modelConfig={modelConfig}
              availableModels={availableModels}
              actionPolicy={actionPolicy}
              setActionPolicy={setActionPolicy}
              codingWorkflow={codingWorkflow}
              applyCodingPreset={applyCodingPreset}
              grokIsRunning={grokIsRunning}
              activeRunId={activeRunId}
              stopRun={stopRun}
            />
          </div>
          <PreviewPanel
            open={previewOpen}
            onClose={() => setPreviewOpen(false)}
            staticPreview={staticPreview}
            previewBusy={previewBusy}
            onRefresh={() => refreshStaticPreview()}
          />
          <InspectorDrawer
            open={contextOpen}
            onOpenPanel={() => togglePanel('context')}
            onClose={() => setContextOpen(false)}
            inspectorTab={inspectorTab}
            setInspectorTab={setInspectorTab}
            dockPosition={dockPosition}
            onDockPositionChange={(next) => {
              setDockPosition(next);
              window.localStorage.setItem(storageKeys.dockPosition, next);
            }}
            runners={runners}
            modelConfig={modelConfig}
            actionPolicy={actionPolicy}
            setActionPolicy={setActionPolicy}
            history={history}
            lastRun={lastRun}
            setLastRun={setLastRun}
            clearRunHistory={clearRunHistory}
            workspacePath={workspacePath}
            onInsertDesktopContext={(text) => {
              // Append into the active mode's draft so it lands in Composer
              // on next render.
              const next = (drafts[mode] ?? '') + text;
              setDrafts((current) => ({ ...current, [mode]: next }));
              composerRef.current?.setValue(next);
              setSessionNotice(t('notices.desktopContextAppended'));
            }}
          />
        </section>

        <TerminalDock
          open={terminalOpen}
          onClose={() => setTerminalOpen(false)}
          cwd={codingCwd}
          workingDirectory={codingCwd.trim() || '~'}
        />
        <Toolbelt open={toolbeltOpen} onToggle={setToolbeltOpen} runners={runners} />
      </section>
    </main>
  );
}

export default App;
