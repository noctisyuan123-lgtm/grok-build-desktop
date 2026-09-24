import { useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { FileText, Quote, X } from 'lucide-react';
import { useModalFocus } from '../hooks/useModalFocus';
import { t } from '../i18n';
import { quoteBlockLabel } from '../lib/quoteCollapse';
import { MarkdownSegment } from './MessageItem';

function firstReadableLine(text: string, fallback: string): string {
  return (
    text
      .split(/\r?\n/)
      .find((line) => line.trim())
      ?.trim() || fallback
  );
}

function contentCacheKey(prefix: string, text: string): string {
  let hash = 2166136261;
  for (let i = 0; i < text.length; i++) {
    hash ^= text.charCodeAt(i);
    hash = Math.imul(hash, 16777619);
  }
  return `${prefix}:${(hash >>> 0).toString(16)}:${text.length}`;
}

export function LongTextMessage({
  text,
  variant = 'paste',
  label,
}: {
  text: string;
  /** `quote` uses Quote icon + quote i18n; default matches long pasted prompts. */
  variant?: 'paste' | 'quote';
  /** Optional pill label; quote variant falls back to the first body line. */
  label?: string;
}) {
  const [open, setOpen] = useState(false);
  const modalRef = useRef<HTMLDivElement | null>(null);
  const closeRef = useRef<HTMLButtonElement | null>(null);
  const isQuote = variant === 'quote';
  const Icon = isQuote ? Quote : FileText;
  const nameKey = isQuote ? 'message.quoteName' : 'message.longTextName';
  const openKey = isQuote ? 'message.quoteOpen' : 'message.longTextOpen';
  const closeKey = isQuote ? 'message.quoteClose' : 'message.longTextClose';
  const dialogKey = isQuote ? 'message.quoteDialog' : 'message.longTextDialog';
  const lineCount = useMemo(() => text.replace(/\r\n/g, '\n').split('\n').length, [text]);
  const cacheKey = useMemo(
    () => contentCacheKey(isQuote ? 'quote' : 'pasted', text),
    [isQuote, text],
  );
  const pillLabel = useMemo(() => {
    const explicit = label?.trim();
    if (explicit) return explicit;
    if (isQuote) {
      return quoteBlockLabel(text) || t(nameKey);
    }
    return firstReadableLine(text, t(nameKey));
  }, [isQuote, label, nameKey, text]);
  useModalFocus(open, modalRef, { initialFocus: closeRef, onEscape: () => setOpen(false) });

  return (
    <>
      <button
        className="long-text-pill"
        type="button"
        aria-label={t(openKey)}
        aria-expanded={open}
        onClick={() => setOpen(true)}
      >
        <Icon size={15} aria-hidden="true" />
        <span>{pillLabel}</span>
      </button>
      {open
        ? createPortal(
            <div
              className="long-text-overlay"
              role="dialog"
              aria-modal="true"
              aria-label={t(dialogKey)}
              onClick={() => setOpen(false)}
            >
              <div
                className="long-text-viewer"
                ref={modalRef}
                tabIndex={-1}
                onClick={(event) => event.stopPropagation()}
              >
                <header className="long-text-head">
                  <div className="long-text-tab">
                    <Icon size={15} aria-hidden="true" />
                    <span>{t(nameKey)}</span>
                  </div>
                  <span className="long-text-count">
                    {t('message.longTextLines', { count: lineCount })}
                  </span>
                  <button
                    className="long-text-close"
                    ref={closeRef}
                    type="button"
                    aria-label={t(closeKey)}
                    onClick={() => setOpen(false)}
                  >
                    <X size={17} aria-hidden="true" />
                  </button>
                </header>
                <div className="long-text-markdown" tabIndex={0}>
                  <MarkdownSegment
                    cacheKey={cacheKey}
                    text={text}
                    className="composer-markdown-preview"
                    immediate
                  />
                </div>
              </div>
            </div>,
            document.body,
          )
        : null}
    </>
  );
}
