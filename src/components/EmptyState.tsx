// Cursor-style zero-message workspace row, with a time-of-day greeting above
// the shared composer. The composer itself stays the real ComposerSection
// below this block so drafts/attachments never fork.
import { useEffect, useState } from 'react';
import { ChevronDown, FolderGit2, Laptop, Loader2 } from 'lucide-react';
import { t } from '../i18n';
import { emptyGreetingKey } from '../lib/emptyGreeting';

export interface EmptyStateProps {
  codingCwd: string;
  folderPickerBusy: boolean;
  onPickWorkspace: () => void;
  /** Test seam. Production ticks from the local clock. */
  now?: Date;
}

function folderName(path: string): string {
  const normalized = path.trim().replace(/\/+$/, '');
  if (!normalized) return t('emptyState.chooseWorkspace');
  return normalized.split('/').filter(Boolean).at(-1) ?? normalized;
}

export function EmptyState({
  codingCwd,
  folderPickerBusy,
  onPickWorkspace,
  now: nowProp,
}: EmptyStateProps) {
  const [clock, setClock] = useState(() => nowProp ?? new Date());
  useEffect(() => {
    if (nowProp) {
      setClock(nowProp);
      return;
    }
    const id = window.setInterval(() => setClock(new Date()), 60_000);
    return () => window.clearInterval(id);
  }, [nowProp]);

  const label = folderName(codingCwd);
  const greeting = t(emptyGreetingKey(clock));
  return (
    <div className="empty-state">
      <div className="empty-greeting">
        <h1 className="empty-greeting-text">{greeting}</h1>
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
