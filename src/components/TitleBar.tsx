// The minimal in-app toolbar: a draggable spacer, theme toggle, and panels
// menu. Run cancellation lives in the composer's send-button position.
import { ChevronDown, Moon, PanelRight, Sun } from 'lucide-react';
import type { ThemeMode } from '../app/types';
import { t } from '../i18n';

export interface TitleBarProps {
  themeMode: ThemeMode;
  setThemeMode: (mode: ThemeMode) => void;
  anyPanelOpen: boolean;
  openPanelMenu: (e: React.MouseEvent) => void;
}

export function TitleBar({
  themeMode,
  setThemeMode,
  anyPanelOpen,
  openPanelMenu,
}: TitleBarProps) {
  return (
    <header className="window-titlebar minimal" data-tauri-drag-region>
      <div className="titlebar-spacer" data-tauri-drag-region />
      <div className="titlebar-right">
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
