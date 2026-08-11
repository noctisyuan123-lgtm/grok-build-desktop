// Cursor-style zero-message workspace row. The composer remains the real,
// shared ComposerSection directly below it; only the empty-session layout
// changes, so drafts, attachments and submit behavior never fork.
import { ChevronDown, FolderGit2, Laptop, Loader2 } from 'lucide-react';
import { t } from '../i18n';

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

export function EmptyState({ codingCwd, folderPickerBusy, onPickWorkspace }: EmptyStateProps) {
  const label = folderName(codingCwd);
  return (
    <div className="empty-state">
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
