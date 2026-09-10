// The minimal in-app toolbar: a draggable spacer, session usage, and panels
// menu. Run cancellation lives in the composer's send-button position.
import { ChevronDown, PanelRight } from 'lucide-react';
import type { ChatMessage } from '../app/types';
import { t } from '../i18n';
import { ContextUsageRing } from './ContextUsageRing';

export interface TitleBarProps {
  messages: readonly ChatMessage[];
  codingCwd: string;
  anyPanelOpen: boolean;
  openPanelMenu: (e: React.MouseEvent) => void;
}

export function TitleBar({ messages, codingCwd, anyPanelOpen, openPanelMenu }: TitleBarProps) {
  return (
    <header className="window-titlebar minimal" data-tauri-drag-region>
      <div className="titlebar-spacer" data-tauri-drag-region />
      <div className="titlebar-right">
        <ContextUsageRing
          messages={messages}
          cwd={codingCwd}
          compact
          className="context-usage-titlebar"
        />
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
