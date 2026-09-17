import { useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { FileText, X } from 'lucide-react';
import { useModalFocus } from '../hooks/useModalFocus';
import { t } from '../i18n';
import { MarkdownSegment } from './MessageItem';

function firstReadableLine(text: string): string {
  return (
    text
      .split(/\r?\n/)
      .find((line) => line.trim())
      ?.trim() || t('message.longTextName')
  );
}

function pastedCacheKey(text: string): string {
  let hash = 2166136261;
  for (let i = 0; i < text.length; i++) {
    hash ^= text.charCodeAt(i);
    hash = Math.imul(hash, 16777619);
  }
  return `pasted:${(hash >>> 0).toString(16)}:${text.length}`;
}

export function LongTextMessage({ text }: { text: string }) {
  const [open, setOpen] = useState(false);
  const modalRef = useRef<HTMLDivElement | null>(null);
  const closeRef = useRef<HTMLButtonElement | null>(null);
  const lineCount = useMemo(() => text.replace(/\r\n/g, '\n').split('\n').length, [text]);
  const cacheKey = useMemo(() => pastedCacheKey(text), [text]);
  useModalFocus(open, modalRef, { initialFocus: closeRef, onEscape: () => setOpen(false) });

  return (
    <>
      <button
        className="long-text-pill"
        type="button"
        aria-label={t('message.longTextOpen')}
        aria-expanded={open}
        onClick={() => setOpen(true)}
      >
        <FileText size={15} aria-hidden="true" />
        <span>{firstReadableLine(text)}</span>
      </button>
      {open
        ? createPortal(
            <div
              className="long-text-overlay"
              role="dialog"
              aria-modal="true"
              aria-label={t('message.longTextDialog')}
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
                    <FileText size={15} aria-hidden="true" />
                    <span>{t('message.longTextName')}</span>
                  </div>
                  <span className="long-text-count">
                    {t('message.longTextLines', { count: lineCount })}
                  </span>
                  <button
                    className="long-text-close"
                    ref={closeRef}
                    type="button"
                    aria-label={t('message.longTextClose')}
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
