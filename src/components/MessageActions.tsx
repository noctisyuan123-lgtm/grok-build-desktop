import { useEffect, useRef, useState } from 'react';
import { Check, Copy, GitFork, Pencil, Undo2 } from 'lucide-react';
import { t } from '../i18n';

interface Props {
  sourceText: string;
  canUndo: boolean;
  onUndo?: () => void;
  showUndo?: boolean;
  canEdit?: boolean;
  onEdit?: () => void;
  showEdit?: boolean;
  showCopy?: boolean;
  canFork?: boolean;
  onFork?: () => void;
  showFork?: boolean;
  toolbarLabel?: string;
  copyLabel?: string;
  undoLabel?: string;
  undoDisabledLabel?: string;
  editLabel?: string;
  editDisabledLabel?: string;
  forkLabel?: string;
  forkDisabledLabel?: string;
}

export function MessageActions({
  sourceText,
  canUndo,
  onUndo,
  showUndo = true,
  canEdit = false,
  onEdit,
  showEdit = false,
  showCopy = true,
  canFork = false,
  onFork,
  showFork = false,
  toolbarLabel = t('message.actions'),
  copyLabel = t('message.copy'),
  undoLabel = t('message.undoResponse'),
  undoDisabledLabel = t('message.undoLatestOnly'),
  editLabel = t('message.editPrompt'),
  editDisabledLabel = t('message.editPromptLatestOnly'),
  forkLabel = t('message.fork'),
  forkDisabledLabel = t('message.forkDisabled'),
}: Props) {
  const [copied, setCopied] = useState(false);
  const resetTimer = useRef<number | null>(null);

  useEffect(
    () => () => {
      if (resetTimer.current !== null) window.clearTimeout(resetTimer.current);
    },
    [],
  );

  async function copySource() {
    if (!sourceText || !navigator.clipboard) return;
    try {
      await navigator.clipboard.writeText(sourceText);
      setCopied(true);
      if (resetTimer.current !== null) window.clearTimeout(resetTimer.current);
      resetTimer.current = window.setTimeout(() => setCopied(false), 1500);
    } catch {
      // Clipboard permissions can be denied by the host. Leave the button in
      // its normal state rather than claiming the copy succeeded.
    }
  }

  if (!showCopy && !showEdit && !showUndo && !showFork) return null;

  return (
    <div className="message-actions" role="toolbar" aria-label={toolbarLabel}>
      {showCopy ? (
        <button
          className="message-action"
          type="button"
          onClick={() => void copySource()}
          disabled={!sourceText || !navigator.clipboard}
          aria-label={copied ? t('message.copied') : copyLabel}
          title={copied ? t('message.copied') : copyLabel}
        >
          {copied ? <Check size={13} /> : <Copy size={13} />}
        </button>
      ) : null}
      {showEdit ? (
        <button
          className="message-action"
          type="button"
          onClick={onEdit}
          disabled={!canEdit || !onEdit}
          aria-label={editLabel}
          title={canEdit ? editLabel : editDisabledLabel}
        >
          <Pencil size={13} />
        </button>
      ) : null}
      {showUndo ? (
        <button
          className="message-action"
          type="button"
          onClick={onUndo}
          disabled={!canUndo || !onUndo}
          aria-label={undoLabel}
          title={canUndo ? undoLabel : undoDisabledLabel}
        >
          <Undo2 size={13} />
        </button>
      ) : null}
      {showFork ? (
        <button
          className="message-action"
          type="button"
          onClick={onFork}
          disabled={!canFork || !onFork}
          aria-label={forkLabel}
          title={canFork ? forkLabel : forkDisabledLabel}
        >
          <GitFork size={13} />
        </button>
      ) : null}
    </div>
  );
}
