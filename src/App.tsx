import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
  type PointerEvent as ReactPointerEvent,
} from 'react';
import { invoke } from '@tauri-apps/api/core';
import { listen } from '@tauri-apps/api/event';
import { openUrl } from '@tauri-apps/plugin-opener';
import { Globe2, PanelRight, TerminalSquare } from 'lucide-react';
import './App.css';
import { cancelRun, ensureStreamListenersAttached, prewarmRun } from './lib/grok';
import { hasTauriRuntime } from './lib/runtime';
import { streamStore } from './lib/streamStore';
import { playCompletionSound, primeCompletionSound } from './lib/completionSound';
import { showCompletionPopup } from './lib/completionPopup';
import { isBackgroundSessionRun } from './lib/completionNotification';
import { mergeStreamIntoMessages } from './lib/mergeStreamMessages';
import { shouldShowPlan } from './components/PlanTodoList';
import { MessageList, type MessageRef } from './components/MessageList';
import type { ComposerFolder, ComposerHandle } from './components/Composer';
import { QueueDock } from './components/QueueDock';
import { CommandPalette, type PaletteAction } from './components/CommandPalette';
import { ToolsPage } from './components/ToolsPage';
import { CustomizePage } from './components/CustomizePage';
import { ContextMenu, type ContextMenuState, type ContextMenuItem } from './components/ContextMenu';
import { InspectorDrawer } from './components/InspectorDrawer';
import { Sidebar } from './components/Sidebar';
import { EmptyState } from './components/EmptyState';
import { PreviewPanel } from './components/PreviewPanel';
import { AttachmentPreviewPanel } from './components/AttachmentPreviewPanel';
import { TerminalDock } from './components/TerminalDock';
import { Toolbelt } from './components/Toolbelt';
import { TitleBar } from './components/TitleBar';
import { ComposerSection } from './components/ComposerSection';
import { SettingsHost } from './components/SettingsHost';
import type { SettingsSection } from './components/SettingsPage';
import { UndoToast } from './components/UndoToast';
import { useActiveRunKey } from './hooks/useActiveRun';
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
  type DockPosition,
  type InspectorTab,
  type Mode,
  type ChatMessage,
} from './app/types';
import { defaultDrafts, storageKeys, tabsActiveKey, tabsStorageKey } from './app/constants';
import { t } from './i18n';
import { makeId } from './app/format';
import { buildConversationReplayBlock, buildGrokArgs } from './app/grokArgs';
import {
  toPersistedAttachmentRef,
  type ComposerAttachment,
  type PersistedAttachmentRef,
} from './lib/attachments';
import {
  dropUndoneUserTurn,
  exportFingerprint,
  importedHasNewTurns,
  messagesFromGrokExport,
  noteCliHandoff,
  noteLiveSession,
  peekCliHandoff,
  peekLiveSession,
} from './lib/sessionHandoff';

const SIDEBAR_WIDTH_KEY = 'grok-desktop-sidebar-width';
// Keep the default comfortably wide enough for history titles and the larger
// sidebar type ramp. A drag is still the user's preferred default and is
// persisted below.
const SIDEBAR_DEFAULT_WIDTH = 336;
const SIDEBAR_MIN_WIDTH = 220;
const SIDEBAR_MAX_WIDTH = 440;

type DesktopHandoff = {
  sessionId: string;
  cwd?: string | null;
  requestedAt: number;
  tabId: string;
};

function storedSidebarWidth(): number {
  const parsed = Number.parseInt(window.localStorage.getItem(SIDEBAR_WIDTH_KEY) ?? '', 10);
  // 260, 272, and 304 were shipped defaults in earlier builds. Treat them as
  // migrations rather than an intentional preference so existing installs get
  // the new baseline once; every other dragged width remains untouched.
  if (!Number.isFinite(parsed) || parsed === 260 || parsed === 272 || parsed === 304) {
    return SIDEBAR_DEFAULT_WIDTH;
  }
  return Math.min(SIDEBAR_MAX_WIDTH, Math.max(SIDEBAR_MIN_WIDTH, parsed));
}

function mergeRebasedTranscript(base: ChatMessage[], imported: ChatMessage[]): ChatMessage[] {
  const sameTurn = (left: ChatMessage, right: ChatMessage) =>
    left.role === right.role && left.content.trim() === right.content.trim();
  const maxOverlap = Math.min(base.length, imported.length);
  for (let overlap = maxOverlap; overlap > 0; overlap -= 1) {
    const baseStart = base.length - overlap;
    if (
      imported
        .slice(0, overlap)
        .every((message, index) => sameTurn(base[baseStart + index]!, message))
    ) {
      return [...base, ...imported.slice(overlap)];
    }
  }
  return [...base, ...imported];
}

function App() {
  // The textarea lives inside Composer (uncontrolled ref). We hold a
  // ComposerHandle so starter cards / history clicks / drafts can seed it.
  const composerRef = useRef<ComposerHandle | null>(null);
  // After Undo, ACP cannot rewind the loaded session (session/load keeps the
  // undone turn). The next submit starts a fresh session and re-seeds only
  // the still-visible pre-undo messages as model context.
  const undoSessionPlanRef = useRef<{
    replayMessages: Array<{ role: 'user' | 'assistant'; content: string }>;
  } | null>(null);
  // Older responses cannot safely use the session-level Grok id because it
  // may also contain later turns. Keep their exact visible branch as replay
  // context until the first new prompt.
  const forkSessionPlanRef = useRef<{
    tabId: string;
    replayMessages: Array<{ role: 'user' | 'assistant'; content: string }>;
  } | null>(null);
  const setComposerValue = useCallback((value: string) => {
    composerRef.current?.setValue(value);
  }, []);
  const [sessionNotice, setSessionNotice] = useState<string | null>(null);
  const [turnMutationBusy, setTurnMutationBusy] = useState(false);
  // Live CLI↔Desktop link is opt-in via /cli or /desktop only — never restore
  // from localStorage on boot (that was resuming the old head into New Session).
  const [liveSessionId, setLiveSessionId] = useState<string | null>(null);
  // Only apply poll updates to the tab that established the link.
  const liveTabIdRef = useRef<string | null>(null);
  const liveExportFingerprintRef = useRef<string>('');
  const livePollInFlightRef = useRef(false);
  const desktopHandoffBusyRef = useRef(false);
  const [desktopHandoff, setDesktopHandoff] = useState<DesktopHandoff | null>(null);
  const suppressLiveRehydrateRef = useRef(false);
  const undoneUserContentRef = useRef<string | null>(null);
  // During the async rewind/export handoff, never let a partial export replace
  // the visible pre-Undo history. Some session backends briefly expose only
  // the newest retained turn while their transcript catches up.
  const pendingUndoVisibleMessagesRef = useRef<{
    sessionId: string;
    messages: ChatMessage[];
  } | null>(null);
  // Edit rewinds the current ACP head in place. The replacement prompt must
  // continue that same head instead of taking the normal Desktop fork.
  const editResumeSessionInPlaceRef = useRef<string | null>(null);
  // A rebase can leave no retained assistant bubble to carry sessionId (undo
  // of the only turn). Keep that new head scoped to its tab until the next
  // assistant event can persist it in message metadata.
  const rebasedSessionHeadRef = useRef<{
    sessionId: string;
    tabId: string | null;
    retainedMessages: ChatMessage[];
  } | null>(null);
  // Full attachment data is intentionally transient: persisting multi-MB data
  // URLs in localStorage would exceed its quota. It remains available for the
  // current app lifetime and is keyed by the stable user-message id.
  const [messageAttachments, setMessageAttachments] = useState<
    Record<string, ComposerAttachment[]>
  >({});
  const [messageFolders, setMessageFolders] = useState<Record<string, ComposerFolder>>({});
  const attachmentLoadKeyRef = useRef('');
  const prewarmKeyRef = useRef('');
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
    sessionLoaded,
    recordRun,
    appendMessage,
  } = useSessionPersistence({ setComposerValue, setSessionNotice });
  // Multi-session tabs (persistence, create/switch/delete, active-tab mirror)
  // live in hooks/useSessionTabs.ts. removeConversationMeta and setContextMenu
  // are declared later; the callback only runs from event handlers, after
  // every hook has initialized.
  const {
    tabs,
    activeTabId,
    handleTabCreate: createSessionTab,
    forkSession,
    switchToSession,
    openGrokSessionTab,
    deleteSession,
    sessionFirstPrompt,
  } = useSessionTabs({
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
  // Completion events can arrive while another session is visible. Keep the
  // full tab map in a ref so the event handler always compares against the
  // current conversation instead of the render that first subscribed.
  const completionSessionRef = useRef({ activeTabId, messages, tabs });
  completionSessionRef.current = { activeTabId, messages, tabs };
  const completionRunOwnerRef = useRef(new Map<string, string>());
  const completionNavigationRef = useRef(switchToSession);
  completionNavigationRef.current = switchToSession;
  const inflightRunKey = useSyncExternalStore(
    streamStore.subscribe,
    streamStore.getInflightRunIdsSnapshot,
    () => '',
  );
  const workingSessionIds = useMemo(() => {
    const inflightRunIds = new Set(inflightRunKey ? inflightRunKey.split('\0') : []);
    const working = new Set<string>();
    for (const tab of tabs) {
      if (
        tab.messages.some(
          (message) => typeof message.runId === 'string' && inflightRunIds.has(message.runId),
        )
      ) {
        working.add(tab.id);
      }
    }
    // The active tab is mirrored into flat App state one effect later; include
    // it directly so the indicator appears in the same render as a new run.
    if (
      tabs.some((tab) => tab.id === activeTabId) &&
      messages.some(
        (message) => typeof message.runId === 'string' && inflightRunIds.has(message.runId),
      )
    ) {
      working.add(activeTabId);
    }
    return working;
  }, [activeTabId, inflightRunKey, messages, tabs]);
  // New session must break any CLI live link — otherwise the next send resumes
  // the previous grok session head and the poll paints the old transcript here.
  function handleTabCreate() {
    rebasedSessionHeadRef.current = null;
    linkLiveSession(null);
    createSessionTab();
  }
  // Undo window for destructive actions (delete conversation, clear history).
  const { undoToast, showUndoToast, undoNow } = useUndoToast();
  const [previewOpen, setPreviewOpen] = useState(false);
  const [attachmentPreview, setAttachmentPreview] = useState<ComposerAttachment | null>(null);
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
  const [settingsSection, setSettingsSection] = useState<SettingsSection>('general');
  // Dedicated Tools / MCP hub (community-tool integration).
  const [toolsPageOpen, setToolsPageOpen] = useState(false);
  const [customizeOpen, setCustomizeOpen] = useState(false);

  useEffect(() => {
    setAttachmentPreview(null);
  }, [activeTabId]);
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
  // WebKit paints the CSS fallback before passive effects restore the saved
  // width. Keep the grid transition off for that one hydration frame so the
  // sidebar doesn't visibly shrink on every app launch.
  const [sidebarTransitionReady, setSidebarTransitionReady] = useState(false);
  const [dockPosition, setDockPosition] = useState<DockPosition>(() => {
    const stored = window.localStorage.getItem(storageKeys.dockPosition);
    return isDockPosition(stored) ? stored : 'right';
  });
  const [completionSoundEnabled, setCompletionSoundEnabled] = useState<boolean>(() => {
    return window.localStorage.getItem(storageKeys.completionSoundEnabled) !== '0';
  });
  const [inspectorTab, setInspectorTab] = useState<InspectorTab>(() => {
    const stored = window.localStorage.getItem(storageKeys.inspectorTab);
    return isInspectorTab(stored) ? stored : 'skills';
  });

  useEffect(() => {
    window.localStorage.setItem(
      storageKeys.completionSoundEnabled,
      completionSoundEnabled ? '1' : '0',
    );
  }, [completionSoundEnabled]);

  useEffect(() => {
    const onUserGesture = () => {
      primeCompletionSound();
      window.removeEventListener('pointerdown', onUserGesture);
      window.removeEventListener('keydown', onUserGesture);
    };
    window.addEventListener('pointerdown', onUserGesture);
    window.addEventListener('keydown', onUserGesture);
    return () => {
      window.removeEventListener('pointerdown', onUserGesture);
      window.removeEventListener('keydown', onUserGesture);
    };
  }, []);

  useEffect(() => {
    return streamStore.subscribeCompletions(({ runId }) => {
      const foreground = document.visibilityState === 'visible' && document.hasFocus();
      const { activeTabId, messages, tabs } = completionSessionRef.current;
      const otherSessionFinished = isBackgroundSessionRun(runId, activeTabId, messages, tabs);
      const activeOwnsRun = messages.some((message) => message.runId === runId);
      const ownerTabId =
        completionRunOwnerRef.current.get(runId) ??
        (activeOwnsRun
          ? activeTabId
          : tabs.find((tab) => tab.messages.some((message) => message.runId === runId))?.id);
      completionRunOwnerRef.current.delete(runId);
      if (ownerTabId && foreground && otherSessionFinished) {
        void showCompletionPopup(ownerTabId);
      }
      if (completionSoundEnabled && (!foreground || otherSessionFinished)) {
        playCompletionSound();
      }
    });
  }, [completionSoundEnabled]);

  useEffect(() => {
    if (!hasTauriRuntime()) return;
    let unlisten: (() => void) | undefined;
    void listen<{ tabId?: string }>(
      'grok-desktop://completion-popup-clicked',
      (event) => {
        const tabId = event.payload?.tabId;
        if (tabId) completionNavigationRef.current(tabId);
      },
    ).then((cleanup) => {
      unlisten = cleanup;
    });
    return () => unlisten?.();
  }, []);
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
  const { reasoningEffort, permissionMode, experimentalMemory, webSearchEnabled, activeModel } =
    modelConfig;
  // Clear conversation + run history + terminal — destructive, so it offers
  // an undo window instead of firing blind. The snapshot is cheap (immutable
  // arrays) and restoring it re-mirrors into the active tab automatically.
  function clearRunHistory() {
    const snapshot = { lastRun, history, messages, terminalLines, totalRuns };
    const priorUndoPlan = undoSessionPlanRef.current;
    const priorLive = liveSessionId;
    const priorLiveTab = liveTabIdRef.current;
    undoSessionPlanRef.current = null;
    rebasedSessionHeadRef.current = null;
    linkLiveSession(null);
    setLastRun(null);
    setHistory([]);
    setMessages([]);
    setTerminalLines([]);
    setTotalRuns(0);
    window.localStorage.setItem('grok-desktop-run-count-total', '0');
    showUndoToast({
      text: t('notices.cleared'),
      undo: () => {
        undoSessionPlanRef.current = priorUndoPlan;
        setLastRun(snapshot.lastRun);
        setHistory(snapshot.history);
        setMessages(snapshot.messages);
        setTerminalLines(snapshot.terminalLines);
        setTotalRuns(snapshot.totalRuns);
        window.localStorage.setItem('grok-desktop-run-count-total', String(snapshot.totalRuns));
        if (priorLive) {
          linkLiveSession(priorLive, priorLiveTab);
        }
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

  // Write streamed assistant text back into `messages` for persistence.
  // Live rendering still reads streamStore (MessageItem); that store is not
  // durable. Terminal runs finalize immediately; in-flight runs are
  // checkpointed on a short debounce so quitting mid-reply keeps partial
  // content in localStorage / tabs / session_state.json. pagehide/hide also
  // flush synchronously — the normal 300ms messages debounce has no quit path.
  const messagesRef = useRef(messages);
  messagesRef.current = messages;

  useEffect(() => {
    let checkpointTimer: ReturnType<typeof setTimeout> | null = null;

    const applyMerge = (mode: 'terminal' | 'checkpoint' | 'all') => {
      setMessages((current) => {
        const { next, changed } = mergeStreamIntoMessages(current, mode);
        if (changed) messagesRef.current = next;
        return changed ? next : current;
      });
    };

    const flushPersistence = () => {
      if (checkpointTimer != null) {
        clearTimeout(checkpointTimer);
        checkpointTimer = null;
      }
      const { next, changed } = mergeStreamIntoMessages(messagesRef.current, 'all');
      if (changed) {
        messagesRef.current = next;
        setMessages(next);
      }
      // Synchronous disk write — React effects may not run before the webview dies.
      try {
        const snapshot = messagesRef.current;
        window.localStorage.setItem(storageKeys.messages, JSON.stringify(snapshot));
        const tabsRaw = window.localStorage.getItem(tabsStorageKey);
        if (tabsRaw) {
          const tabs = JSON.parse(tabsRaw) as Array<{ id: string; messages?: unknown }>;
          if (Array.isArray(tabs)) {
            const activeId = window.localStorage.getItem(tabsActiveKey);
            const updated = tabs.map((tab) =>
              tab && tab.id === activeId ? { ...tab, messages: snapshot } : tab,
            );
            window.localStorage.setItem(tabsStorageKey, JSON.stringify(updated));
          }
        }
      } catch {
        // quota / serialization — non-fatal
      }
    };

    const onStoreChange = () => {
      // Always finalize ended runs immediately (sessionId + status).
      applyMerge('terminal');
      // Debounce mid-stream content so every text chunk does not re-render App.
      if (checkpointTimer != null) clearTimeout(checkpointTimer);
      checkpointTimer = setTimeout(() => {
        checkpointTimer = null;
        applyMerge('checkpoint');
      }, 300);
    };

    onStoreChange();
    const unsub = streamStore.subscribe(onStoreChange);

    const onHide = () => {
      if (document.visibilityState === 'hidden') flushPersistence();
    };
    document.addEventListener('visibilitychange', onHide);
    window.addEventListener('pagehide', flushPersistence);

    return () => {
      unsub();
      if (checkpointTimer != null) clearTimeout(checkpointTimer);
      document.removeEventListener('visibilitychange', onHide);
      window.removeEventListener('pagehide', flushPersistence);
    };
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
      ...(activeSessionIsRunning && activeSessionRunId
        ? [
            {
              label: 'Stop current run',
              danger: true,
              onClick: () => stopRun(activeSessionRunId),
            },
          ]
        : []),
      { label: 'Settings…', separator: true, onClick: () => setSettingsOpen(true) },
    );
    setContextMenu({ x: e.clientX, y: e.clientY, items });
  }

  function currentSessionId(list: typeof messages = messagesRef.current): string | null {
    const visible =
      [...list].reverse().find((message) => message.role === 'assistant' && message.meta?.sessionId)
        ?.meta?.sessionId ?? null;
    if (visible) return visible;
    const rebased = rebasedSessionHeadRef.current;
    return rebased && rebased.tabId === activeTabId ? rebased.sessionId : null;
  }

  function linkLiveSession(sessionId: string | null, tabId?: string | null) {
    if (sessionId !== liveSessionId) liveExportFingerprintRef.current = '';
    setLiveSessionId(sessionId);
    noteLiveSession(sessionId);
    noteCliHandoff(sessionId);
    liveTabIdRef.current = sessionId ? (tabId ?? activeTabId) : null;
    if (!sessionId) liveExportFingerprintRef.current = '';
  }

  function sessionHasInflightDesktopRun(list: typeof messages = messagesRef.current): boolean {
    return list.some((message) => {
      if (message.role !== 'assistant' || !message.runId) return false;
      const state = streamStore.getRunSnapshot(message.runId)?.state;
      return state === 'queued' || state === 'running';
    });
  }

  /** True when this tab is the one that owns the current CLI live link. */
  function isLiveOwnerTab(): boolean {
    return Boolean(
      liveSessionId && liveTabIdRef.current && activeTabId && liveTabIdRef.current === activeTabId,
    );
  }

  /**
   * Re-import transcript from grok's on-disk session (CLI ↔ Desktop share it).
   * Skips while a Desktop run is streaming so we do not clobber live ACP output.
   * Quiet polls only write into the tab that established the live link, and
   * never overwrite a conversation whose head is a different session id.
   */
  async function rehydrateFromGrokSession(
    sessionId: string,
    options?: { quiet?: boolean },
  ): Promise<boolean> {
    if (sessionHasInflightDesktopRun()) return false;
    if (suppressLiveRehydrateRef.current || undoSessionPlanRef.current) return false;
    if (options?.quiet && !isLiveOwnerTab()) return false;
    const visibleHead = currentSessionId();
    // Never paint a foreign export over a Desktop conversation that already
    // belongs to another grok session (e.g. New Session after a linked one).
    if (visibleHead && visibleHead !== sessionId) return false;
    const markdown = await invoke<string>('export_grok_session', { sessionId });
    const fingerprint = exportFingerprint(markdown);
    let imported = messagesFromGrokExport(markdown, sessionId);
    const pendingUndo =
      pendingUndoVisibleMessagesRef.current?.sessionId === sessionId
        ? pendingUndoVisibleMessagesRef.current.messages
        : null;
    const rebased = rebasedSessionHeadRef.current;
    const rebasedBase =
      rebased?.sessionId === sessionId && rebased.tabId === activeTabId
        ? rebased.retainedMessages
        : null;
    if (rebasedBase) {
      imported = mergeRebasedTranscript(rebasedBase, imported);
      // An export started before the replacement session was created can
      // finish afterward with the old head. Only remove the undone target
      // when it appears beyond the retained replay baseline; if the prompt
      // was an older repeated turn already in the baseline, leave that copy.
      if (undoneUserContentRef.current && imported.length > rebasedBase.length) {
        imported = dropUndoneUserTurn(imported, undoneUserContentRef.current);
      }
    } else if (undoneUserContentRef.current) {
      imported = dropUndoneUserTurn(imported, undoneUserContentRef.current);
    }
    // A successful rewind can briefly produce a short export while the
    // session's durable transcript is still being rewritten. Keep the
    // already-visible baseline until the export contains at least that whole
    // baseline; otherwise one incomplete poll looks like a full `/clear`.
    if (pendingUndo && !rebasedBase && imported.length < pendingUndo.length) return false;
    if (imported.length === 0) return false;
    const sameExport = fingerprint === liveExportFingerprintRef.current;
    if (sameExport && !importedHasNewTurns(messagesRef.current, imported)) return false;
    // Re-check: a Desktop turn may have started while export was in flight.
    if (sessionHasInflightDesktopRun()) return false;
    if (options?.quiet && !isLiveOwnerTab()) return false;
    const visibleAfter = currentSessionId();
    if (visibleAfter && visibleAfter !== sessionId) return false;
    liveExportFingerprintRef.current = fingerprint;
    setMessages(imported);
    if (pendingUndo && !rebasedBase) pendingUndoVisibleMessagesRef.current = null;
    return true;
  }

  async function handleHostSlash(raw: string): Promise<boolean> {
    // Allow "/desktop", "/desktop ", and accidental fullwidth slash.
    const normalized = raw.trim().replace(/^／/, '/');
    const token = normalized.split(/\s+/)[0]?.toLowerCase() ?? '';
    if (token !== '/cli' && token !== '/desktop') return false;
    if (!hasTauriRuntime()) {
      setSessionNotice(t('notices.hostSlashUnavailable', { command: token }));
      return true;
    }
    try {
      // Prefer the visible Desktop head. Never fall back to a stale localStorage
      // handoff on an empty New Session tab — that rehydrated the old transcript
      // (and system prompt) into the blank UI.
      const visible = currentSessionId();
      const sessionId = visible
        ? visible
        : isLiveOwnerTab() && liveSessionId
          ? liveSessionId
          : messages.length === 0
            ? null
            : (peekCliHandoff() ?? peekLiveSession());
      if (token === '/desktop') {
        // Claude-style: re-import shared grok session into this chat UI + keep listening.
        if (!sessionId) {
          setSessionNotice(t('notices.noSessionToSync'));
          return true;
        }
        try {
          linkLiveSession(sessionId);
          const ok = await rehydrateFromGrokSession(sessionId);
          setSessionNotice(
            ok
              ? t('notices.syncedDesktopSession')
              : t('notices.liveListening', { id: sessionId.slice(0, 8) }),
          );
        } catch (error) {
          setSessionNotice(
            t('notices.hostSlashFailed', {
              command: token,
              error: error instanceof Error ? error.message : String(error),
            }),
          );
        }
        // Focus this window (already in Desktop); still try open as fallback.
        try {
          const { getCurrentWindow } = await import('@tauri-apps/api/window');
          await getCurrentWindow().unminimize();
          await getCurrentWindow().setFocus();
        } catch {
          await invoke('open_grok_desktop');
        }
        return true;
      }
      // /cli — open interactive TUI on the same session head (no fork), iTerm first.
      // Link BEFORE open so a fast focus return can already poll; if open fails
      // we still keep the link so /desktop can rehydrate.
      if (sessionId) linkLiveSession(sessionId);
      else {
        noteCliHandoff(null);
        noteLiveSession(null);
      }
      await invoke('open_grok_cli', {
        cwd: codingCwd.trim() || null,
        sessionId,
      });
      setSessionNotice(
        sessionId
          ? t('notices.openedCliSessionLive', { id: sessionId.slice(0, 8) })
          : t('notices.openedCli'),
      );
      return true;
    } catch (error) {
      setSessionNotice(
        t('notices.hostSlashFailed', {
          command: token,
          error: error instanceof Error ? error.message : String(error),
        }),
      );
      return true;
    }
  }

  // `/desktop` in Grok CLI writes a one-shot request before opening/focusing
  // this app. Polling is intentional: macOS `open` only focuses an existing
  // bundle and does not deliver the new session id to the already-running
  // Tauri window.
  useEffect(() => {
    if (!hasTauriRuntime() || !sessionLoaded) return;
    let cancelled = false;
    const consume = async () => {
      if (cancelled || desktopHandoffBusyRef.current || desktopHandoff) return;
      desktopHandoffBusyRef.current = true;
      try {
        const request = await invoke<{
          sessionId: string;
          cwd?: string | null;
          requestedAt: number;
        } | null>('consume_desktop_handoff');
        if (!cancelled && request?.sessionId) {
          const tabId = openGrokSessionTab(request.sessionId, request.cwd ?? '');
          setDesktopHandoff({ ...request, tabId });
        } else {
          desktopHandoffBusyRef.current = false;
        }
      } catch {
        desktopHandoffBusyRef.current = false;
      }
    };
    void consume();
    const timer = window.setInterval(() => void consume(), 500);
    return () => {
      cancelled = true;
      window.clearInterval(timer);
    };
    // openGrokSessionTab reads the latest tab/message state through its ref;
    // this listener must remain mounted instead of restarting each render.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sessionLoaded]);

  useEffect(() => {
    if (!desktopHandoff || desktopHandoff.tabId !== activeTabId) return;
    let cancelled = false;
    const { sessionId, tabId } = desktopHandoff;
    linkLiveSession(sessionId, tabId);
    void rehydrateFromGrokSession(sessionId)
      .then((ok) => {
        if (!cancelled) {
          setSessionNotice(
            ok
              ? t('notices.syncedDesktopSession')
              : t('notices.liveListening', { id: sessionId.slice(0, 8) }),
          );
        }
      })
      .catch((error) => {
        if (!cancelled) {
          setSessionNotice(
            t('notices.hostSlashFailed', {
              command: '/desktop',
              error: error instanceof Error ? error.message : String(error),
            }),
          );
        }
      })
      .finally(() => {
        if (!cancelled) {
          desktopHandoffBusyRef.current = false;
          setDesktopHandoff(null);
        }
      });
    return () => {
      cancelled = true;
    };
    // The handoff request is intentionally processed against the committed
    // tab selected above; including these render-scoped helpers would restart
    // the import whenever the transcript changes.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeTabId, desktopHandoff]);

  function switchMode(nextMode: Mode) {
    if (nextMode === mode || busyRunner !== null) return;
    setMode(nextMode);
    setComposerValue(drafts[nextMode] || defaultDrafts[nextMode]);
  }

  // buildGrokArgs/buildGrokRules are pure functions in app/grokArgs.ts; this
  // closure snapshots the current run config for the Composer's submit path.
  function buildRunArgs(): string[] {
    // Run state is global because the Rust queue is global, but session
    // continuation is not. Only the assistant turn in the currently visible
    // session may parent a queued follow-up. A script in another session must
    // not force a new session through `-c`, nor make its reply look like it
    // belongs to the current tab.
    const activeSessionHasInflightRun = sessionHasInflightDesktopRun();
    const visibleSessionId = [...messages]
      .reverse()
      .find((message) => message.role === 'assistant' && message.meta?.sessionId)?.meta?.sessionId;
    const rebased = rebasedSessionHeadRef.current;
    const inPlaceEditSessionId = editResumeSessionInPlaceRef.current;
    const previousSessionId =
      inPlaceEditSessionId ??
      visibleSessionId ??
      (rebased?.tabId === activeTabId ? rebased.sessionId : undefined);
    // A turn currently running is the parent of anything newly queued. Its
    // session id does not exist yet, so do not accidentally fork from the
    // older completed turn found above.
    const undoPlan = undoSessionPlanRef.current;
    // Resume ONLY the visible conversation head. Never inject a stale live-
    // link id here — that sent New Session messages into the previous grok
    // session and rehydrated its system/transcript into the empty tab.
    // After Undo: never resume the old ACP head (it still holds the undone
    // turn).
    const resumeSessionId = undoPlan
      ? null
      : forkSessionPlanRef.current?.tabId === activeTabId
        ? null
        : activeSessionHasInflightRun
          ? null
          : previousSessionId;
    const forkPlan =
      forkSessionPlanRef.current?.tabId === activeTabId ? forkSessionPlanRef.current : null;
    const forceNewSession = Boolean(undoPlan || forkPlan);
    // Share (no fork) only when this tab still owns the live link AND the
    // visible head is that same session.
    const shareSession = Boolean(
      isLiveOwnerTab() && liveSessionId && resumeSessionId && resumeSessionId === liveSessionId,
    );
    return buildGrokArgs({
      mode,
      activeModel,
      reasoningEffort,
      actionPolicy,
      permissionMode,
      experimentalMemory,
      webSearchEnabled,
      codingCwd,
      resumeSessionId,
      // ACP intentionally does not interpret the CLI's cwd-global `-c`.
      // Composer sends the active run id separately; the queue resolves that
      // exact run's emitted session id just before launching this follow-up.
      continueLatestSession: false,
      forceNewSession,
      replayMessages: undoPlan?.replayMessages ?? forkPlan?.replayMessages,
      shareSession,
      resumeSessionInPlace:
        resumeSessionId != null && editResumeSessionInPlaceRef.current === resumeSessionId,
    });
  }

  // Grok Core needs roughly a process + ACP initialize before it can accept
  // the first prompt. Warm the active lane while the user is looking at the
  // app so Send only waits for the actual session/prompt request. The queue
  // keeps this host alive and reuses it for subsequent turns.
  useEffect(() => {
    if (!hasTauriRuntime() || !sessionLoaded || !activeTabId) return;
    const args = buildRunArgs();
    const key = `${activeTabId}\0${codingCwd}\0${args.join('\0')}`;
    if (prewarmKeyRef.current === key) return;
    prewarmKeyRef.current = key;
    let cancelled = false;
    void prewarmRun({ cwd: codingCwd, args, laneId: activeTabId }).catch((error) => {
      if (cancelled || prewarmKeyRef.current !== key) return;
      // Prewarm is best-effort; the normal enqueue path remains authoritative.
      prewarmKeyRef.current = '';
      console.debug('[grok-desktop] ACP prewarm unavailable', error);
    });
    return () => {
      cancelled = true;
    };
    // buildRunArgs intentionally snapshots the current run configuration;
    // the explicit dependencies below trigger a new warm host when it changes.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [
    sessionLoaded,
    activeTabId,
    codingCwd,
    mode,
    activeModel,
    reasoningEffort,
    actionPolicy,
    permissionMode,
    experimentalMemory,
    webSearchEnabled,
    liveSessionId,
  ]);

  function handleEnqueued(info: {
    runId: string;
    position: number;
    prompt: string;
    rawText?: string;
    attachments: ComposerAttachment[];
    attachedFolder?: ComposerFolder;
  }) {
    completionRunOwnerRef.current.set(info.runId, activeTabId);
    // Post-Undo re-seed has been consumed. Later turns resume the new session.
    undoSessionPlanRef.current = null;
    if (forkSessionPlanRef.current?.tabId === activeTabId) {
      forkSessionPlanRef.current = null;
    }
    undoneUserContentRef.current = null;
    pendingUndoVisibleMessagesRef.current = null;
    editResumeSessionInPlaceRef.current = null;
    const now = Date.now();
    const userMessageId = makeId('u');
    const assistantMessageId = makeId('a');
    if (info.attachments.length > 0) {
      setMessageAttachments((current) => ({
        ...current,
        [userMessageId]: info.attachments,
      }));
    }
    if (info.attachedFolder) {
      setMessageFolders((current) => ({
        ...current,
        [userMessageId]: info.attachedFolder!,
      }));
    }
    const persistedAttachments = info.attachments.map(toPersistedAttachmentRef);
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
      attachments: persistedAttachments.length > 0 ? persistedAttachments : undefined,
    });
    if (persistedAttachments.length > 0 && hasTauriRuntime()) {
      void Promise.all(
        info.attachments.map((attachment) =>
          invoke<void>('save_attachment', {
            sessionId: activeTabId,
            assetId: attachment.id,
            dataUrl: attachment.dataUrl,
          }),
        ),
      ).catch((error) => {
        setSessionNotice(
          t('notices.saveFailed', {
            error: error instanceof Error ? error.message : String(error),
          }),
        );
      });
    }
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

  // Attachment bytes live outside the transcript. Rehydrate only the active
  // tab's references after boot or a conversation switch; transient data from
  // a just-sent message remains visible if the first disk read races its save.
  useEffect(() => {
    setMessageAttachments({});
    setMessageFolders({});
    attachmentLoadKeyRef.current = '';
  }, [activeTabId]);

  useEffect(() => {
    if (!sessionLoaded || !hasTauriRuntime() || !activeTabId) return;
    const references: Array<{ messageId: string; attachment: PersistedAttachmentRef }> = [];
    for (const message of messages) {
      for (const attachment of message.attachments ?? []) {
        references.push({ messageId: message.id, attachment });
      }
    }
    const loadKey = `${activeTabId}:${references
      .map(({ messageId, attachment }) => `${messageId}:${attachment.assetId}`)
      .join('|')}`;
    if (!references.length || loadKey === attachmentLoadKeyRef.current) return;
    attachmentLoadKeyRef.current = loadKey;
    let cancelled = false;
    void Promise.all(
      references.map(async ({ messageId, attachment }) => {
        try {
          const dataUrl = await invoke<string>('load_attachment', {
            sessionId: activeTabId,
            assetId: attachment.assetId,
            mimeType: attachment.mimeType,
          });
          return {
            messageId,
            attachment: { ...attachment, dataUrl },
          } satisfies { messageId: string; attachment: ComposerAttachment };
        } catch {
          return null;
        }
      }),
    ).then((loaded) => {
      if (cancelled) return;
      setMessageAttachments((current) => {
        const next = { ...current };
        for (const item of loaded) {
          if (!item) continue;
          // A just-sent attachment has the authoritative in-memory data URL;
          // disk hydration should only fill a missing entry.
          if (!next[item.messageId]) next[item.messageId] = [item.attachment];
        }
        return next;
      });
    });
    return () => {
      cancelled = true;
    };
  }, [activeTabId, messages, sessionLoaded]);

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

  // Persist the active live link for /cli session id hints only — poll itself
  // is in-memory and requires an explicit /cli or /desktop in this process.
  useEffect(() => {
    if (!liveSessionId) {
      noteLiveSession(null);
      return;
    }
    noteLiveSession(liveSessionId);
    noteCliHandoff(liveSessionId);
  }, [liveSessionId]);

  // Live mutual listen: poll `grok export` while linked and this tab owns it.
  // Switching away only pauses the poll (isLiveOwnerTab); it does NOT clear
  // the link — only New Session / Clear conversation do that. Clearing on
  // every tab switch made /desktop feel broken after a quick history glance.
  useEffect(() => {
    if (!hasTauriRuntime()) return;
    if (!liveSessionId) return;
    let cancelled = false;
    const tick = () => {
      if (cancelled || livePollInFlightRef.current) return;
      if (!isLiveOwnerTab()) return;
      if (sessionHasInflightDesktopRun()) return;
      livePollInFlightRef.current = true;
      void rehydrateFromGrokSession(liveSessionId, { quiet: true })
        .catch(() => {
          // Transient export failures are fine; next poll retries.
        })
        .finally(() => {
          livePollInFlightRef.current = false;
        });
    };
    const onFocus = () => tick();
    window.addEventListener('focus', onFocus);
    // 2s is enough for mutual display and lighter on `grok export`.
    const timer = window.setInterval(tick, 2000);
    tick();
    return () => {
      cancelled = true;
      window.removeEventListener('focus', onFocus);
      window.clearInterval(timer);
    };
    // These helpers intentionally read messagesRef.current so message chunks
    // do not tear down/recreate the poll interval. liveSessionId/activeTabId
    // are the only ownership values captured by this effect.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [liveSessionId, activeTabId]);

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

  useEffect(() => {
    const frame = window.requestAnimationFrame(() => setSidebarTransitionReady(true));
    return () => window.cancelAnimationFrame(frame);
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
  // App only needs the active run lifecycle. Subscribing to the full snapshot
  // made this large component re-render for every streamed text chunk.
  const activeRunKey = useActiveRunKey();
  const grokIsRunning = activeRunKey.endsWith('\0running');
  const activeSessionRunId = useMemo(() => {
    for (let index = messages.length - 1; index >= 0; index -= 1) {
      const message = messages[index];
      if (message?.role !== 'assistant' || !message.runId) continue;
      const state = streamStore.getRunSnapshot(message.runId)?.state;
      if (state === 'queued' || state === 'running') return message.runId;
    }
    return null;
    // activeRunKey intentionally invalidates this store-backed lookup when the
    // active run lifecycle changes, even though the callback reads the store.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [messages, activeRunKey]);
  const activeSessionIsRunning = activeSessionRunId != null;

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

  // Undo is deliberately limited to the latest completed prompt/response
  // pair. Both the user-prompt and response controls enter here, so UI,
  // persisted transcript, and the ACP session are always rewound together.
  // Removing an older pair would leave later answers backed by context that is
  // no longer visible. The prompt is restored verbatim to the composer, and
  // the existing undo toast makes this destructive operation recoverable.
  function undoLatestTurn(messageId: string) {
    if (activeSessionIsRunning) return;
    const selectedIndex = messages.findIndex((message) => message.id === messageId);
    if (selectedIndex < 0) return;
    const selected = messages[selectedIndex];
    const selectedUser = selected?.role === 'user' ? selected : null;
    const assistantIndex = selectedUser ? selectedIndex + 1 : selectedIndex;
    const assistant =
      messages[assistantIndex]?.role === 'assistant' ? messages[assistantIndex] : null;
    const user = selectedUser ?? messages[assistantIndex - 1];
    const isUserOnlyTail = Boolean(
      selectedUser && assistant == null && selectedIndex === messages.length - 1,
    );
    if (assistantIndex !== messages.length - 1 && !isUserOnlyTail) return;
    if ((assistant != null && assistant.status === 'streaming') || !user || user.role !== 'user') {
      return;
    }

    const snapshot = messages;
    const previousDraft = composerRef.current?.getValue() ?? '';
    const previousFolder = composerRef.current?.getAttachedFolder() ?? null;
    const restoredFolder = messageFolders[user.id] ?? null;
    const preserved = messages.slice(0, assistant ? assistantIndex - 1 : selectedIndex);
    // Keep still-visible turns as replay context; exclude the undone pair.
    // If ACP rewind fails, the next submit starts fresh and re-seeds these.
    undoSessionPlanRef.current = {
      replayMessages: preserved
        .filter((message) => message.role === 'user' || message.role === 'assistant')
        .map((message) => ({
          role: message.role as 'user' | 'assistant',
          content: message.content,
        })),
    };
    undoneUserContentRef.current = user.content;
    suppressLiveRehydrateRef.current = true;
    const grokSessionId = assistant?.meta?.sessionId ?? currentSessionId() ?? liveSessionId;
    if (grokSessionId) {
      pendingUndoVisibleMessagesRef.current = {
        sessionId: grokSessionId,
        messages: preserved,
      };
    }
    messagesRef.current = preserved;
    setMessages(preserved);
    updatePrompt(user.content);
    composerRef.current?.setAttachedFolder(restoredFolder);
    composerRef.current?.focus();
    showUndoToast({
      text: t('message.turnUndone'),
      undo: () => {
        undoSessionPlanRef.current = null;
        undoneUserContentRef.current = null;
        pendingUndoVisibleMessagesRef.current = null;
        suppressLiveRehydrateRef.current = false;
        messagesRef.current = snapshot;
        setMessages(snapshot);
        updatePrompt(previousDraft);
        composerRef.current?.setAttachedFolder(previousFolder);
      },
    });
    if (hasTauriRuntime() && grokSessionId) {
      void persistUndoToGrokSession(grokSessionId);
    } else {
      suppressLiveRehydrateRef.current = false;
    }
  }

  function forkAssistantResponse(messageId: string) {
    const selectedIndex = messages.findIndex((message) => message.id === messageId);
    if (selectedIndex < 0) return;
    const selected = messages[selectedIndex];
    if (
      selected?.role !== 'assistant' ||
      selected.status === 'streaming' ||
      !selected.content.trim()
    ) {
      return;
    }
    const branch = messages.slice(0, selectedIndex + 1);
    const tabId = forkSession(branch);
    if (!tabId) return;

    // Only the current session tail can use native resume+fork. A session id
    // is session-scoped, so older responses would otherwise fork from a head
    // that includes turns after the clicked response.
    if (selectedIndex !== messages.length - 1 || !selected.meta?.sessionId) {
      forkSessionPlanRef.current = {
        tabId,
        replayMessages: branch.map((message) => ({
          role: message.role,
          content: message.content,
        })),
      };
    }
  }

  async function editLatestTurn(messageId: string, nextText: string) {
    if (activeSessionIsRunning || !nextText.trim()) return;
    if (turnMutationBusy) return;
    const selectedIndex = messages.findIndex((message) => message.id === messageId);
    if (selectedIndex < 0) return;
    const selected = messages[selectedIndex];
    if (selected?.role !== 'user') return;
    const assistantIndex = selectedIndex + 1;
    const assistant =
      messages[assistantIndex]?.role === 'assistant' ? messages[assistantIndex] : null;
    const isUserOnlyTail = assistant == null && selectedIndex === messages.length - 1;
    if (!isUserOnlyTail && assistantIndex !== messages.length - 1) return;
    if (assistant?.status === 'streaming') return;
    setTurnMutationBusy(true);

    const snapshot = messages;
    const previousDraft = composerRef.current?.getValue() ?? '';
    const previousFolder = composerRef.current?.getAttachedFolder() ?? null;
    const restoredFolder = messageFolders[selected.id] ?? null;
    const preserved = messages.slice(0, assistant ? assistantIndex - 1 : selectedIndex);
    const sessionId = assistant?.meta?.sessionId ?? currentSessionId() ?? liveSessionId;

    // Do not enqueue the replacement until the old pair has been removed from
    // the ACP/JSONL head. replayContext contains only the retained turns.
    undoSessionPlanRef.current = {
      replayMessages: preserved
        .filter((message) => message.role === 'user' || message.role === 'assistant')
        .map((message) => ({
          role: message.role as 'user' | 'assistant',
          content: message.content,
        })),
    };
    undoneUserContentRef.current = selected.content;
    suppressLiveRehydrateRef.current = true;
    if (sessionId) {
      pendingUndoVisibleMessagesRef.current = { sessionId, messages: preserved };
    }
    // Mirror Undo: remove the old pair from the visible transcript before the
    // replacement is enqueued. The backend rewind is still authoritative for
    // model context; this optimistic UI update prevents appendMessage from
    // appending the edited turn after the stale pair. `restore` below puts the
    // exact snapshot back if rewind fails.
    messagesRef.current = preserved;
    setMessages(preserved);

    const restore = () => {
      undoSessionPlanRef.current = null;
      undoneUserContentRef.current = null;
      pendingUndoVisibleMessagesRef.current = null;
      editResumeSessionInPlaceRef.current = null;
      suppressLiveRehydrateRef.current = false;
      messagesRef.current = snapshot;
      setMessages(snapshot);
      composerRef.current?.setValue(previousDraft);
      composerRef.current?.setAttachedFolder(previousFolder);
      setSessionNotice(t('message.editFailed'));
      setTurnMutationBusy(false);
    };

    if (!hasTauriRuntime() && !sessionId) {
      suppressLiveRehydrateRef.current = false;
      composerRef.current?.setValue(nextText.trim());
      await composerRef.current?.submit();
      setTurnMutationBusy(false);
      return;
    }
    if (!sessionId) {
      restore();
      return;
    }
    const rewound = await persistUndoToGrokSession(sessionId, { resumeInPlace: true });
    if (!rewound) {
      restore();
      return;
    }
    composerRef.current?.setValue(nextText.trim());
    composerRef.current?.setAttachedFolder(restoredFolder);
    await composerRef.current?.submit();
    setTurnMutationBusy(false);
  }

  async function persistUndoToGrokSession(
    sessionId: string,
    options: { resumeInPlace?: boolean } = {},
  ): Promise<boolean> {
    try {
      const undoPlan = undoSessionPlanRef.current;
      const wasLive = liveSessionId === sessionId;
      const result = await invoke<{
        rewound: boolean;
        sessionId: string;
        rebased: boolean;
      }>('rewind_grok_session', {
        sessionId,
        cwd: codingCwd.trim() || null,
        undoPrompt: undoneUserContentRef.current,
        replayContext: buildConversationReplayBlock(undoPlan?.replayMessages ?? []) ?? '',
      });
      if (result.rewound || result.rebased) {
        // Shared grok session matches the UI. Stay on this head (CLI too).
        undoSessionPlanRef.current = null;
        suppressLiveRehydrateRef.current = false;
        const nextSessionId = result.sessionId || sessionId;
        const rebased = result.rebased || nextSessionId !== sessionId;
        editResumeSessionInPlaceRef.current =
          options.resumeInPlace && !rebased ? nextSessionId : null;
        if (rebased) {
          // The fallback creates a fresh session containing only the retained
          // context. Point the visible head and live owner at it immediately;
          // its export may still be empty until the next real prompt.
          const retainedMessages = (() => {
            const current = messagesRef.current;
            let lastAssistantIndex = -1;
            for (let index = current.length - 1; index >= 0; index -= 1) {
              if (current[index]?.role === 'assistant') {
                lastAssistantIndex = index;
                break;
              }
            }
            if (lastAssistantIndex < 0) return current;
            return current.map((message, index) =>
              index === lastAssistantIndex
                ? {
                    ...message,
                    meta: { ...message.meta, sessionId: nextSessionId },
                  }
                : message,
            );
          })();
          rebasedSessionHeadRef.current = {
            sessionId: nextSessionId,
            tabId: activeTabId,
            retainedMessages,
          };
          messagesRef.current = retainedMessages;
          setMessages(retainedMessages);
          // A replacement session is only shared when the undone turn was
          // actually connected to `/cli`. Ordinary Desktop runs must resume
          // the new isolated head without inventing a shared leader; doing
          // otherwise makes the next prewarm call session/load on a leader
          // that does not exist and resurrects the old failure.
          if (wasLive) linkLiveSession(nextSessionId);
          else linkLiveSession(null);
        } else {
          try {
            await rehydrateFromGrokSession(nextSessionId);
          } catch {
            liveExportFingerprintRef.current = '';
          }
        }
        if (wasLive) {
          // A second ACP session/load during rewind can leave the existing
          // TUI unable to paint the next assistant turn. Reopen a clean CLI.
          try {
            await invoke('open_grok_cli', {
              cwd: codingCwd.trim() || null,
              sessionId: nextSessionId,
            });
          } catch {
            // Desktop transcript is already synced; CLI reopen is best-effort.
          }
        }
        return true;
      } else {
        // Cannot truncate to empty via ACP. Stop poll so CLI cannot restore.
        linkLiveSession(null);
        return false;
      }
    } catch {
      linkLiveSession(null);
      return false;
    } finally {
      suppressLiveRehydrateRef.current = false;
    }
  }

  const messageRefs: MessageRef[] = useMemo(() => {
    const latestIndex = messages.length - 1;
    const latestMessage = messages[latestIndex];
    const latestTurnCanUndo = Boolean(
      latestMessage &&
      !activeSessionIsRunning &&
      (latestMessage?.role === 'user' || latestMessage?.status !== 'streaming'),
    );
    const latestUserIndex =
      latestMessage?.role === 'assistant' && latestMessage.status !== 'streaming'
        ? latestIndex - 1
        : latestMessage?.role === 'user'
          ? latestIndex
          : -1;
    const latestTurnCanEdit = Boolean(
      !activeSessionIsRunning &&
      latestUserIndex >= 0 &&
      messages[latestUserIndex]?.role === 'user' &&
      messages[latestUserIndex]?.content.trim(),
    );
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
            canUndo: index === latestIndex && latestTurnCanUndo,
            showUndo: index === latestIndex && latestTurnCanUndo,
            canEdit: index === latestUserIndex && latestTurnCanEdit,
            showEdit: index === latestUserIndex,
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
            planEntries: m.meta?.planEntries,
            showPlan: shouldShowPlan(messages, index),
            autoExpandWork: m.status === 'streaming',
            id: m.id,
            canUndo: index === latestIndex && latestTurnCanUndo,
            showUndo: index === latestIndex && latestTurnCanUndo,
            canFork: m.status !== 'streaming' && Boolean(m.content.trim()),
            showFork: m.status !== 'streaming' && Boolean(m.content.trim()),
          },
    );
  }, [activeSessionIsRunning, messageAttachments, messages]);
  return (
    <main
      className={`app-shell theme-${themeMode}${sidebarCollapsed ? ' sidebar-collapsed' : ''}${sidebarTransitionReady ? ' sidebar-transition-ready' : ''}`}
    >
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
        completionSoundEnabled={completionSoundEnabled}
        setCompletionSoundEnabled={setCompletionSoundEnabled}
        modelConfig={modelConfig}
        actionPolicy={actionPolicy}
        setActionPolicy={setActionPolicy}
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
        contextMenu={contextMenu}
        setContextMenu={setContextMenu}
        paletteOpen={paletteOpen}
        setPaletteOpen={setPaletteOpen}
        setSettingsOpen={setSettingsOpen}
        customizeOpen={customizeOpen}
        setCustomizeOpen={setCustomizeOpen}
        workingSessionIds={workingSessionIds}
        busyRunner={busyRunner}
        refreshStatuses={refreshStatuses}
        runDoctor={runDoctor}
        grokToolStatus={grokToolStatus}
        isGrokReady={isGrokReady}
        sidebarCollapsed={sidebarCollapsed}
        setSidebarCollapsed={setSidebarCollapsed}
        mode={mode}
        switchMode={switchMode}
        codingCwd={codingCwd}
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
                <MessageList
                  messages={messageRefs}
                  onAttachmentClick={setAttachmentPreview}
                  onUndoAssistant={undoLatestTurn}
                  onUndoUser={undoLatestTurn}
                  onForkAssistant={forkAssistantResponse}
                  onEditUser={(messageId, text) => {
                    void editLatestTurn(messageId, text);
                  }}
                />
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
              messages={messages}
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
              onHostSlash={handleHostSlash}
              locked={turnMutationBusy}
              grokIsRunning={activeSessionIsRunning}
              activeRunId={activeSessionRunId}
              laneId={activeTabId}
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
          <AttachmentPreviewPanel
            attachment={attachmentPreview}
            onClose={() => setAttachmentPreview(null)}
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
