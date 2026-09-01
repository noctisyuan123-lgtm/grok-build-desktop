// The app sidebar: brand + command-palette chevron, primary navigation,
// the organized conversations list (pinned / groups / recent / archived)
// with its rename/menu machinery, tool health, and the account strip.
// Extracted from App.tsx unchanged; history state rides in as the grouped
// useHistoryOrganization result.
import {
  Archive,
  ArchiveRestore,
  BookmarkPlus,
  Blocks,
  ChevronDown,
  ChevronRight,
  PanelLeftClose,
  PanelLeftOpen,
  ClipboardCheck,
  Copy,
  CornerUpLeft,
  FolderInput,
  Folder,
  FolderOpen,
  FolderPlus,
  History,
  Loader2,
  MoreHorizontal,
  Pencil,
  Pin,
  PinOff,
  Plus,
  RefreshCcw,
  Search,
  Trash2,
  X,
  Zap,
} from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import { BrandGlyph } from './BrandGlyph';
import type { ContextMenuItem, ContextMenuState } from './ContextMenu';
import type { useHistoryOrganization } from '../hooks/useHistoryOrganization';
import type { HistoryPreview, HistoryRow, Mode, ToolStatus } from '../app/types';
import { modeCopy, primaryNavItems } from '../app/constants';
import { statusTone } from '../app/format';
import { t } from '../i18n';

const PROJECT_LIST_COLLAPSED_KEY = 'grok-desktop-project-list-collapsed-v3';

export interface SidebarProps {
  history: ReturnType<typeof useHistoryOrganization>;
  sessionFirstPrompt: (id: string) => string | null;
  switchToSession: (id: string) => void;
  deleteSession: (id: string) => void;
  handleTabCreate: () => void;
  focusComposer: () => void;
  contextMenu: ContextMenuState | null;
  setContextMenu: (menu: ContextMenuState | null) => void;
  paletteOpen: boolean;
  setPaletteOpen: (open: boolean) => void;
  setSettingsOpen: (open: boolean) => void;
  customizeOpen: boolean;
  setCustomizeOpen: (open: boolean) => void;
  /** Session/tab ids with a queued or running Grok turn. */
  workingSessionIds?: ReadonlySet<string>;
  busyRunner: string | null;
  refreshStatuses: () => void;
  runDoctor: () => void;
  grokToolStatus: ToolStatus | undefined;
  isGrokReady: boolean;
  sidebarCollapsed: boolean;
  setSidebarCollapsed: (collapsed: boolean) => void;
  /** Active interaction mode; the Chat/Code segment lives in the brand block. */
  mode: Mode;
  switchMode: (mode: Mode) => void;
  /** Current workspace path; used to tint the matching project folder. */
  codingCwd?: string;
}

export function Sidebar({
  history,
  sessionFirstPrompt,
  switchToSession,
  deleteSession,
  handleTabCreate,
  focusComposer,
  contextMenu,
  setContextMenu,
  paletteOpen,
  setPaletteOpen,
  setSettingsOpen,
  customizeOpen,
  setCustomizeOpen,
  workingSessionIds,
  busyRunner,
  refreshStatuses,
  runDoctor,
  grokToolStatus,
  isGrokReady,
  sidebarCollapsed,
  setSidebarCollapsed,
  mode,
  switchMode,
  codingCwd = '',
}: SidebarProps) {
  const {
    pinnedPromptIds,
    promptGroups,
    archivedPromptIds,
    showArchived,
    setShowArchived,
    rowEdit,
    setRowEdit,
    historyNote,
    setHistoryNote,
    recentPrompts,
    historyView,
    togglePinPrompt,
    toggleArchivePrompt,
    setPromptGroupId,
    startRename,
    startNewGroup,
    commitRowEdit,
    savePromptToLibrary,
  } = history;
  const [collapsedProjects, setCollapsedProjects] = useState<Set<string>>(
    () => new Set(historyView.projectGroups.map(([path]) => path)),
  );
  const [projectsCollapsed, setProjectsCollapsed] = useState(
    () => window.localStorage.getItem(PROJECT_LIST_COLLAPSED_KEY) !== 'expanded',
  );
  const seenProjectPaths = useRef(new Set(historyView.projectGroups.map(([path]) => path)));
  const [sidebarPeek, setSidebarPeek] = useState(false);
  const peekHoverRef = useRef(false);
  const peekLeaveTimerRef = useRef<number | null>(null);
  const contextMenuRef = useRef(contextMenu);
  contextMenuRef.current = contextMenu;
  useEffect(() => {
    const newPaths = historyView.projectGroups
      .map(([path]) => path)
      .filter((path) => !seenProjectPaths.current.has(path));
    if (newPaths.length === 0) return;
    newPaths.forEach((path) => seenProjectPaths.current.add(path));
    setCollapsedProjects((current) => new Set([...current, ...newPaths]));
  }, [historyView.projectGroups]);

  function cancelPeekLeave() {
    if (peekLeaveTimerRef.current == null) return;
    window.clearTimeout(peekLeaveTimerRef.current);
    peekLeaveTimerRef.current = null;
  }

  function openSidebarPeek() {
    if (!sidebarCollapsed) return;
    peekHoverRef.current = true;
    cancelPeekLeave();
    setSidebarPeek(true);
  }

  function scheduleCloseSidebarPeek() {
    peekHoverRef.current = false;
    cancelPeekLeave();
    peekLeaveTimerRef.current = window.setTimeout(() => {
      peekLeaveTimerRef.current = null;
      if (peekHoverRef.current || contextMenuRef.current) return;
      setSidebarPeek(false);
    }, 160);
  }

  useEffect(() => {
    if (!sidebarCollapsed) {
      peekHoverRef.current = false;
      cancelPeekLeave();
      setSidebarPeek(false);
    }
  }, [sidebarCollapsed]);

  useEffect(() => {
    if (contextMenu) {
      cancelPeekLeave();
      return;
    }
    if (peekHoverRef.current) return;
    setSidebarPeek(false);
  }, [contextMenu]);

  useEffect(() => () => cancelPeekLeave(), []);

  function normalizePath(path: string): string {
    return path.replace(/\/+$/, '');
  }

  function projectName(path: string): string {
    const trimmed = normalizePath(path);
    return trimmed.split('/').filter(Boolean).pop() ?? path;
  }

  function toggleProject(path: string) {
    setCollapsedProjects((current) => {
      const next = new Set(current);
      if (next.has(path)) next.delete(path);
      else next.add(path);
      return next;
    });
  }

  function toggleProjects() {
    setProjectsCollapsed((current) => {
      const next = !current;
      window.localStorage.setItem(PROJECT_LIST_COLLAPSED_KEY, next ? 'collapsed' : 'expanded');
      return next;
    });
  }

  // Segment labels need static keys — t() is typed via keyof typeof en, so a
  // computed `sidebar.mode.${item}` key would not type-check.
  const modeSegmentLabels: Record<Mode, string> = {
    standard: t('sidebar.mode.standard'),
    coding: t('sidebar.mode.coding'),
  };

  // Claude-class management menu for a history row. Section header, icons,
  // shortcut accelerators, two flyout submenus (Open with / Move to group).
  // Primary trigger is the row ⋯ button; right-click and the keyboard
  // (Shift+F10 / ContextMenu) still open the same menu at a caller-supplied
  // anchor point.
  function openHistoryMenu(item: HistoryPreview, at: { x: number; y: number }) {
    const id = item.id; // tab/session id
    const text = sessionFirstPrompt(id) ?? item.title;
    const pinned = pinnedPromptIds.has(id);
    const archived = archivedPromptIds.has(id);
    const currentGroup = promptGroups[id] ?? null;
    const groupNames = Array.from(new Set(Object.values(promptGroups))).sort((a, b) =>
      a.localeCompare(b),
    );

    const groupSubmenu: ContextMenuItem[] = [
      {
        label: t('sidebar.menu.newGroup'),
        icon: <FolderPlus size={15} />,
        onClick: () => startNewGroup(id),
      },
      ...(groupNames.length
        ? [{ label: t('sidebar.menu.moveTo'), header: true } as ContextMenuItem]
        : []),
      ...groupNames.map((g) => ({
        label: currentGroup === g ? t('sidebar.menu.groupChecked', { name: g }) : g,
        icon: <FolderInput size={15} />,
        onClick: () => setPromptGroupId(id, currentGroup === g ? null : g),
      })),
      ...(currentGroup
        ? [
            {
              label: t('sidebar.menu.removeFromGroup'),
              separator: true,
              icon: <X size={15} />,
              onClick: () => setPromptGroupId(id, null),
            },
          ]
        : []),
    ];

    const items: ContextMenuItem[] = [
      { label: item.title.length > 34 ? `${item.title.slice(0, 34)}…` : item.title, header: true },
      {
        label: t('sidebar.menu.openConversation'),
        icon: <CornerUpLeft size={15} />,
        shortcut: '↵',
        onClick: () => switchToSession(id),
      },
      {
        label: t('sidebar.menu.copyFirstPrompt'),
        icon: <Copy size={15} />,
        shortcut: '⌘C',
        onClick: () => {
          void navigator.clipboard?.writeText(text);
          setHistoryNote(t('sidebar.copied'));
        },
      },
      {
        label: t('sidebar.menu.saveToLibrary'),
        icon: <BookmarkPlus size={15} />,
        onClick: () => void savePromptToLibrary(id),
      },
      {
        label: pinned ? t('sidebar.menu.unpin') : t('sidebar.menu.pinToTop'),
        icon: pinned ? <PinOff size={15} /> : <Pin size={15} />,
        shortcut: 'P',
        separator: true,
        onClick: () => togglePinPrompt(id),
      },
      {
        label: t('sidebar.menu.rename'),
        icon: <Pencil size={15} />,
        shortcut: 'R',
        onClick: () => startRename(id),
      },
      {
        label: t('sidebar.menu.moveToGroup'),
        icon: <FolderInput size={15} />,
        shortcut: 'G',
        submenu: groupSubmenu,
      },
      {
        label: archived ? t('sidebar.menu.unarchive') : t('sidebar.menu.archive'),
        icon: archived ? <ArchiveRestore size={15} /> : <Archive size={15} />,
        shortcut: 'A',
        onClick: () => toggleArchivePrompt(id),
      },
      {
        label: t('sidebar.menu.deleteConversation'),
        icon: <Trash2 size={15} />,
        shortcut: '⌫',
        danger: true,
        separator: true,
        onClick: () => deleteSession(id),
      },
    ];
    setContextMenu({ x: at.x, y: at.y, items, id: item.id });
  }

  function openHistoryMenuFromPointer(
    item: HistoryPreview,
    at: { x: number; y: number },
    alreadyOpen: boolean,
  ) {
    if (alreadyOpen) {
      setContextMenu(null);
      return;
    }
    openHistoryMenu(item, at);
  }

  // One history row — inline rename/new-group input when being edited,
  // otherwise a click-to-open row with a ⋯ actions button.
  function renderHistoryRow(item: HistoryRow) {
    if (rowEdit?.id === item.id) {
      return (
        <div className="history-rename" key={item.id}>
          <input
            // Callback ref instead of autoFocus: React's autoFocus doesn't
            // reliably grab focus in the production WebView when the input
            // appears via a state change (the composer kept focus, so typed
            // text went there instead of here). Focusing on mount is robust.
            ref={(el) => {
              if (el) {
                el.focus();
                el.select();
              }
            }}
            defaultValue={rowEdit.mode === 'rename' ? item.title : ''}
            placeholder={
              rowEdit.mode === 'rename' ? t('sidebar.renamePrompt') : t('sidebar.newGroupName')
            }
            aria-label={
              rowEdit.mode === 'rename' ? t('sidebar.renamePrompt') : t('sidebar.newGroupName')
            }
            onKeyDown={(e) => {
              if (e.key === 'Enter') {
                e.preventDefault();
                commitRowEdit(e.currentTarget.value);
              } else if (e.key === 'Escape') {
                e.preventDefault();
                setRowEdit(null);
              }
            }}
            onBlur={(e) => commitRowEdit(e.currentTarget.value)}
          />
        </div>
      );
    }
    const menuOpen = contextMenu?.id === item.id;
    return (
      <div
        className={`history-row${item.pinned ? ' pinned' : ''}${item.active ? ' active' : ''}${menuOpen ? ' menu-open' : ''}`}
        key={item.id}
        onContextMenu={(e) => {
          e.preventDefault();
          openHistoryMenu(item, { x: e.clientX, y: e.clientY });
        }}
      >
        <button
          className="history-row-open"
          onClick={() => switchToSession(item.id)}
          onDoubleClick={() => startRename(item.id)}
          onKeyDown={(e) => {
            // Keyboard route to the same management menu: Shift+F10 or the
            // dedicated ContextMenu key, as if the pointer were on the ⋯.
            if (e.key === 'ContextMenu' || (e.shiftKey && e.key === 'F10')) {
              e.preventDefault();
              const more = e.currentTarget.parentElement?.querySelector('.history-row-more');
              const rect = ((more as HTMLElement | null) ?? e.currentTarget).getBoundingClientRect();
              openHistoryMenuFromPointer(item, { x: rect.left, y: rect.top }, menuOpen);
            }
          }}
          title={item.title}
          type="button"
          aria-current={item.active ? 'true' : undefined}
        >
          <span className="history-row-main">
            <span className="history-activity-slot" aria-hidden="true">
              {workingSessionIds?.has(item.id) ? <span className="history-activity-dot" /> : null}
            </span>
            <strong>
              {item.pinned ? <Pin size={11} className="pin-dot" /> : null}
              {item.title}
            </strong>
          </span>
        </button>
        <button
          className="history-row-more"
          type="button"
          aria-label={t('sidebar.menu.moreActions')}
          aria-haspopup="menu"
          aria-expanded={menuOpen}
          title={t('sidebar.menu.moreActions')}
          onClick={(e) => {
            e.preventDefault();
            e.stopPropagation();
            openHistoryMenuFromPointer(item, { x: e.clientX, y: e.clientY }, menuOpen);
          }}
        >
          <MoreHorizontal size={14} />
        </button>
      </div>
    );
  }

  return (
    <>
      <button
        className="sidebar-collapse-button sidebar-titlebar-toggle"
        type="button"
        aria-label={
          sidebarCollapsed ? t('palette.action.expandSidebar') : t('palette.action.collapseSidebar')
        }
        title={`${sidebarCollapsed ? t('palette.action.expandSidebar') : t('palette.action.collapseSidebar')} (⌘B)`}
        aria-pressed={sidebarCollapsed}
        onClick={() => setSidebarCollapsed(!sidebarCollapsed)}
      >
        {sidebarCollapsed ? <PanelLeftOpen size={16} /> : <PanelLeftClose size={16} />}
      </button>
      {sidebarCollapsed ? (
        <div
          className="sidebar-peek-hotspot"
          aria-hidden="true"
          onPointerEnter={openSidebarPeek}
          onPointerLeave={scheduleCloseSidebarPeek}
        />
      ) : null}
      <aside
        className={`app-sidebar${sidebarPeek ? ' sidebar-peeking' : ''}`}
        aria-hidden={sidebarCollapsed && !sidebarPeek ? true : undefined}
        inert={sidebarCollapsed && !sidebarPeek ? true : undefined}
        onPointerEnter={openSidebarPeek}
        onPointerLeave={scheduleCloseSidebarPeek}
      >
        <div className="brand">
          {/* Chat/Code switch, moved up from the composer footer so the input
            card stays clean. Same state, same ⌘1/⌘2 shortcuts. */}
          <div className="mode-segment" role="group" aria-label={t('sidebar.modeSwitchAria')}>
            {(Object.keys(modeCopy) as Mode[]).map((item) => (
              <button
                aria-pressed={mode === item}
                className={mode === item ? 'active' : ''}
                key={item}
                onClick={() => switchMode(item)}
                title={`${modeSegmentLabels[item]} (${modeCopy[item].shortcut})`}
                type="button"
              >
                {modeSegmentLabels[item]}
              </button>
            ))}
          </div>
        </div>

        <section className="nav-section primary-nav" aria-label={t('sidebar.primaryNav')}>
          <div className="nav-list">
            {primaryNavItems.map((item) => {
              // Each nav item maps to a single, deterministic action — no
              // "this kinda does X" semantics. If the action isn't obvious
              // from the label, the meta line below it explains.
              const handle = () => {
                if (item.id === 'new-session') {
                  // CREATES a fresh tab (empty messages, clean cwd) and
                  // switches to it. handleTabCreate already wipes drafts,
                  // notices, and last-run card — Claude-Desktop-style
                  // "clean slate". Then put the cursor in the composer.
                  handleTabCreate();
                  focusComposer();
                } else if (item.id === 'search') {
                  // Open the ⌘K command palette pre-focused. The host of
                  // visible "search-y" things (recent prompts, palette,
                  // files) is unified here.
                  setPaletteOpen(true);
                } else if (item.id === 'customize') {
                  setCustomizeOpen(true);
                }
              };
              // The active highlight should follow what's *actually* open,
              // not hardcoded to "New Session". Otherwise every button looks
              // selected and the user can't tell which panel is current.
              const isActive =
                (item.id === 'customize' && customizeOpen) || (item.id === 'search' && paletteOpen);
              return (
                <button
                  className={isActive ? 'active' : ''}
                  key={item.id}
                  type="button"
                  onClick={handle}
                >
                  {item.id === 'new-session' ? (
                    <Plus size={16} />
                  ) : item.id === 'search' ? (
                    <Search size={16} />
                  ) : (
                    <Blocks size={16} />
                  )}
                  <span>{item.label}</span>
                  <small>{item.meta}</small>
                </button>
              );
            })}
          </div>
        </section>

        <section className="nav-section history-nav">
          <div className="nav-head">
            <span>{t('sidebar.conversations')}</span>
          </div>
          <div className="history-list">
            {recentPrompts.length === 0 ? (
              // No fake "Try: …" placeholders. An empty state is honest and
              // less misleading than disabled-looking rows that look real.
              <div className="history-empty">
                <span>{t('sidebar.emptyHistory')}</span>
              </div>
            ) : (
              <>
                {historyView.pinned.length > 0 ? (
                  <div className="history-group">
                    <div className="history-section-head">
                      <Pin size={12} /> {t('sidebar.pinned')}
                    </div>
                    {historyView.pinned.map(renderHistoryRow)}
                  </div>
                ) : null}

                {historyView.groups.map(([name, rows]) => (
                  <div className="history-group" key={`hg-${name}`}>
                    <div className="history-section-head">
                      <FolderInput size={12} /> {name}
                    </div>
                    {rows.map(renderHistoryRow)}
                  </div>
                ))}

                {historyView.projectGroups.length > 0 ? (
                  <div className="project-list">
                    <button
                      type="button"
                      className="history-section-head toggle project-list-label"
                      aria-controls="project-list-content"
                      aria-expanded={!projectsCollapsed}
                      onClick={toggleProjects}
                    >
                      <span>{t('sidebar.projects')}</span>
                      <span className="project-list-count" aria-hidden="true">
                        {historyView.projectGroups.length}
                      </span>
                      <ChevronDown
                        size={13}
                        className={`chev${projectsCollapsed ? '' : ' open'}`}
                      />
                    </button>
                    {!projectsCollapsed ? (
                      <div id="project-list-content">
                        {historyView.projectGroups.map(([path, rows]) => {
                          const collapsed = collapsedProjects.has(path);
                          const projectWorking = rows.some((row) => workingSessionIds?.has(row.id));
                          const current =
                            codingCwd.length > 0 &&
                            normalizePath(path) === normalizePath(codingCwd);
                          const FolderIcon = collapsed ? Folder : FolderOpen;
                          return (
                            <div className="history-group project-history-group" key={`hp-${path}`}>
                              <button
                                type="button"
                                className={`history-section-head project-section-head${current ? ' current' : ''}`}
                                title={path}
                                aria-expanded={!collapsed}
                                onClick={() => toggleProject(path)}
                              >
                                <span className="history-activity-slot" aria-hidden="true">
                                  {collapsed && projectWorking ? (
                                    <span className="history-activity-dot" />
                                  ) : null}
                                </span>
                                <ChevronRight
                                  size={12}
                                  className={`project-chev${collapsed ? '' : ' open'}`}
                                  aria-hidden="true"
                                />
                                <FolderIcon
                                  size={14}
                                  className="project-folder-icon"
                                  aria-hidden="true"
                                />
                                <span className="project-name">{projectName(path)}</span>
                                <span className="project-count" aria-hidden="true">
                                  {rows.length}
                                </span>
                              </button>
                              {!collapsed ? rows.map(renderHistoryRow) : null}
                            </div>
                          );
                        })}
                      </div>
                    ) : null}
                  </div>
                ) : null}

                {historyView.ungrouped.length > 0 ? (
                  <div className="history-group">
                    {historyView.pinned.length > 0 ||
                    historyView.groups.length > 0 ||
                    historyView.projectGroups.length > 0 ? (
                      <div className="history-section-head">
                        <History size={12} /> {t('sidebar.recent')}
                      </div>
                    ) : null}
                    {historyView.ungrouped.map(renderHistoryRow)}
                  </div>
                ) : null}

                {historyView.archived.length > 0 ? (
                  <div className="history-group archived">
                    <button
                      type="button"
                      className="history-section-head toggle"
                      onClick={() => setShowArchived((v) => !v)}
                    >
                      <Archive size={12} />{' '}
                      {t('sidebar.archivedCount', { count: historyView.archived.length })}
                      <ChevronDown size={13} className={`chev${showArchived ? ' open' : ''}`} />
                    </button>
                    {showArchived ? historyView.archived.map(renderHistoryRow) : null}
                  </div>
                ) : null}
              </>
            )}
          </div>
          {historyNote ? <div className="history-toast">{historyNote}</div> : null}
        </section>

        <section className="sidebar-health" aria-label={t('sidebar.toolHealth')}>
          <div className="nav-head">
            <span>{t('sidebar.health')}</span>
            <button
              aria-label={t('sidebar.refreshStatus')}
              className="sidebar-icon"
              disabled={busyRunner !== null}
              onClick={refreshStatuses}
              type="button"
            >
              {busyRunner === 'status' ? (
                <Loader2 className="spin" size={15} />
              ) : (
                <RefreshCcw size={15} />
              )}
            </button>
          </div>
          <div className={`health-pill ${statusTone(grokToolStatus)}`}>
            <Zap size={15} />
            <span>
              {grokToolStatus?.installed ? t('sidebar.grokReady') : t('sidebar.grokMissing')}
            </span>
          </div>
          <button
            className="doctor-button"
            disabled={busyRunner !== null}
            onClick={runDoctor}
            type="button"
          >
            {busyRunner === 'doctor' ? (
              <Loader2 className="spin" size={16} />
            ) : (
              <ClipboardCheck size={16} />
            )}
            <span>{t('common.doctor')}</span>
          </button>
        </section>

        <button
          className="account-strip account-icon-button"
          type="button"
          aria-label={t('sidebar.openSettings')}
          title={t('sidebar.settingsTitle')}
          onClick={() => setSettingsOpen(true)}
        >
          <div className={`avatar${isGrokReady ? ' ready' : ''}`}>
            <BrandGlyph size={17} />
          </div>
        </button>
      </aside>
    </>
  );
}
