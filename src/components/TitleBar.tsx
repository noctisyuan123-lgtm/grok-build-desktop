// The minimal in-app toolbar: a draggable spacer, Stop/connection state,
// theme toggle, and panels menu. Project selection lives in Settings/sidebar.
import { ChevronDown, Moon, PanelRight, Sun, X } from 'lucide-react';
import type { ThemeMode } from '../app/types';
import { t } from '../i18n';

export interface TitleBarProps {
  grokIsRunning: boolean;
  activeRunId: string | null;
  stopRun: (runId: string) => void;
  isGrokReady: boolean;
  statusLabel: string;
  themeMode: ThemeMode;
  setThemeMode: (mode: ThemeMode) => void;
  anyPanelOpen: boolean;
  openPanelMenu: (e: React.MouseEvent) => void;
}

export function TitleBar({
  grokIsRunning,
  activeRunId,
  stopRun,
  isGrokReady,
  statusLabel,
  themeMode,
  setThemeMode,
  anyPanelOpen,
  openPanelMenu,
}: TitleBarProps) {
  return (
    <header className="window-titlebar minimal" data-tauri-drag-region>
      <div className="titlebar-spacer" data-tauri-drag-region />
      <div className="titlebar-right">
        {grokIsRunning && activeRunId ? (
          <button
            className="primary-run"
            onClick={() => stopRun(activeRunId)}
            type="button"
            title={t('titleBar.stopTitle')}
          >
            <X size={15} />
            <span>{t('titleBar.stop')}</span>
          </button>
        ) : (
          <span
            className={`conn-pill ${isGrokReady ? 'ready' : 'blocked'}`}
            title={
              isGrokReady
                ? t('titleBar.connectedTitle')
                : t('titleBar.offlineTitle', { status: statusLabel.toLowerCase() })
            }
            aria-label={isGrokReady ? t('titleBar.connectedAria') : t('titleBar.notConnectedAria')}
          >
            <span className="conn-dot-mini" aria-hidden />
            {isGrokReady ? t('titleBar.grok') : t('titleBar.offline')}
          </span>
        )}
        {/* Day / night theme toggle (also ⌘⇧L). Bordered + full-contrast
                sun/moon so it reads as a control, not a stray dot. */}
        <button
          className="titlebar-icon-btn theme-toggle"
          type="button"
          aria-label={themeMode === 'dark' ? t('titleBar.toLight') : t('titleBar.toDark')}
          title={themeMode === 'dark' ? t('titleBar.toLightTitle') : t('titleBar.toDarkTitle')}
          onClick={() => setThemeMode(themeMode === 'dark' ? 'light' : 'dark')}
        >
          {themeMode === 'dark' ? (
            <Sun size={17} strokeWidth={2.25} />
          ) : (
            <Moon size={17} strokeWidth={2.25} />
          )}
        </button>
        {/* Panels menu — Preview / Context / Terminal / Tools, each opens
                its panel (Claude-Desktop-style). */}
        <button
          className={`detail-toggle${anyPanelOpen ? ' active' : ''}`}
          type="button"
          aria-label={t('titleBar.panelsAria')}
          title={t('titleBar.panelsTitle')}
          onClick={openPanelMenu}
        >
          <PanelRight size={16} />
          <ChevronDown size={11} className="detail-caret" />
        </button>
      </div>
    </header>
  );
}
