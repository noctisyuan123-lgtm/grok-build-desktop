// Zero-message workspace row, with a daily greeting above the shared
// composer. It renders in ComposerSection's same column, so workspace context
// and the input never drift apart when an auxiliary panel reserves width.
import { useEffect, useState } from 'react';
import { Bot, ChevronDown, FolderGit2, Laptop, Loader2 } from 'lucide-react';
import { t } from '../i18n';
import { emptyGreeting, millisecondsUntilNextGreetingChange } from '../lib/emptyGreeting';

export interface EmptyStateProps {
  codingCwd: string;
  folderPickerBusy: boolean;
  onPickWorkspace: () => void;
}

function folderName(path: string): string {
  const normalized = path.trim().replace(/\/+$/, '');
  if (!normalized) return t('emptyState.chooseWorkspace');
  return normalized.split('/').filter(Boolean).at(-1) ?? normalized;
}

function useDailyGreeting(): string {
  const [now, setNow] = useState(() => new Date());

  useEffect(() => {
    const timer = window.setTimeout(
      () => setNow(new Date()),
      millisecondsUntilNextGreetingChange(now),
    );
    return () => window.clearTimeout(timer);
  }, [now]);

  return emptyGreeting(now);
}

export function EmptyState({
  codingCwd,
  folderPickerBusy,
  onPickWorkspace,
}: EmptyStateProps) {
  const label = folderName(codingCwd);
  const greeting = useDailyGreeting();
  return (
    <div className="empty-state">
      <div className="empty-greeting">
        <div className="empty-greeting-lockup">
          <Bot className="empty-greeting-logo" size={38} aria-hidden="true" />
          <h1 className="empty-greeting-text">{greeting}</h1>
        </div>
      </div>
      <div className="new-session-context">
        <button
          className="new-session-workspace"
          type="button"
          disabled={folderPickerBusy}
          aria-label={t('emptyState.workspaceAria')}
          title={codingCwd.trim() || t('emptyState.chooseWorkspace')}
          onClick={onPickWorkspace}
        >
          {folderPickerBusy ? (
            <Loader2 className="spin" size={14} aria-hidden="true" />
          ) : (
            <FolderGit2 size={14} aria-hidden="true" />
          )}
          <span>{label}</span>
          <ChevronDown size={13} aria-hidden="true" />
        </button>
        <span className="new-session-runtime">
          <Laptop size={14} aria-hidden="true" />
          {t('emptyState.thisMac')}
        </span>
      </div>
    </div>
  );
}
