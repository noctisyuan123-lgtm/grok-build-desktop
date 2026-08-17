import { useEffect, useRef, useState } from 'react';
import { Check, Copy, Undo2 } from 'lucide-react';
import { t } from '../i18n';

interface Props {
  sourceText: string;
  canUndo: boolean;
  onUndo?: () => void;
  showUndo?: boolean;
  toolbarLabel?: string;
  copyLabel?: string;
  undoLabel?: string;
  undoDisabledLabel?: string;
}

export function MessageActions({
  sourceText,
  canUndo,
  onUndo,
  showUndo = true,
  toolbarLabel = t('message.actions'),
  copyLabel = t('message.copy'),
  undoLabel = t('message.undoResponse'),
  undoDisabledLabel = t('message.undoLatestOnly'),
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

  return (
    <div className="message-actions" role="toolbar" aria-label={toolbarLabel}>
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
    </div>
  );
}
