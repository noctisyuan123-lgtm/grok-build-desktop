import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { MessageSquare } from 'lucide-react';
import { t } from '../i18n';
import { isLongUserText } from '../lib/longText';
import {
  hasCollapsibleQuote,
  quoteBlockPlainText,
  splitUserTextSegments,
} from '../lib/quoteCollapse';
import { LongTextMessage } from './LongTextMessage';
import { MarkdownSegment } from './MessageItem';

type FloatPos = { top: number; left: number; maxWidth: number };

/**
 * User prompt renderer: Quote-selection blockquotes collapse to a Codex-style
 * annotation pill above the right-aligned prose bubble. Expanding floats the
 * Selected-text card(s) in the right margin, top-aligned with the pill
 * (fixed portal, out of flow) so the transcript never reflows or flickers.
 */
export function UserMessageText({ text, cacheKey }: { text: string; cacheKey: string }) {
  const segments = useMemo(() => splitUserTextSegments(text), [text]);
  const collapseQuotes = useMemo(() => hasCollapsibleQuote(text), [text]);
  const [open, setOpen] = useState(false);
  const [pos, setPos] = useState<FloatPos | null>(null);
  const pillRef = useRef<HTMLButtonElement | null>(null);
  const floatRef = useRef<HTMLDivElement | null>(null);

  useLayoutEffect(() => {
    if (!open) {
      setPos(null);
      return;
    }
    const update = () => {
      const pill = pillRef.current;
      if (!pill) return;
      const rect = pill.getBoundingClientRect();
      const vv = window.visualViewport;
      const offsetLeft = vv?.offsetLeft ?? 0;
      const offsetTop = vv?.offsetTop ?? 0;
      const viewW = vv?.width ?? window.innerWidth;
      const viewH = vv?.height ?? window.innerHeight;
      const gap = 8;
      const floatEl = floatRef.current;
      const floatHeight = floatEl?.offsetHeight ?? 0;
      // Always sit to the RIGHT of the pill (右边空位), top-aligned. Never
      // fall back to the left — shrink width if the gutter is tight.
      const viewRight = offsetLeft + viewW;
      const rail = document.querySelector('.subagent-rail:not(.is-collapsed)');
      const railLeft =
        rail instanceof HTMLElement ? rail.getBoundingClientRect().left : viewRight;
      const rightLimit = Math.min(viewRight - 8, railLeft - 8);
      const left = rect.right + gap;
      const roomRight = Math.max(0, rightLimit - left);
      const maxWidth = Math.min(420, Math.max(140, roomRight));
      // Top-align with the pill (上边缘对齐). Clamp into the viewport only.
      let top = rect.top;
      if (top + floatHeight > offsetTop + viewH - 8) {
        top = Math.max(offsetTop + 8, offsetTop + viewH - Math.max(floatHeight, 1) - 8);
      }
      if (top < offsetTop + 8) top = offsetTop + 8;
      setPos({ top, left, maxWidth });
    };
    update();
    const raf = window.requestAnimationFrame(update);
    window.addEventListener('resize', update);
    window.visualViewport?.addEventListener('resize', update);
    window.visualViewport?.addEventListener('scroll', update);
    document.addEventListener('scroll', update, true);
    return () => {
      window.cancelAnimationFrame(raf);
      window.removeEventListener('resize', update);
      window.visualViewport?.removeEventListener('resize', update);
      window.visualViewport?.removeEventListener('scroll', update);
      document.removeEventListener('scroll', update, true);
    };
  }, [open]);

  useEffect(() => {
    if (!open) return;
    const onPointerDown = (event: MouseEvent) => {
      const target = event.target;
      if (!(target instanceof Node)) return;
      if (pillRef.current?.contains(target)) return;
      if (floatRef.current?.contains(target)) return;
      setOpen(false);
    };
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.isComposing || event.keyCode === 229) return;
      if (event.key === 'Escape') {
        event.preventDefault();
        setOpen(false);
      }
    };
    document.addEventListener('mousedown', onPointerDown);
    document.addEventListener('keydown', onKeyDown);
    return () => {
      document.removeEventListener('mousedown', onPointerDown);
      document.removeEventListener('keydown', onKeyDown);
    };
  }, [open]);

  if (collapseQuotes) {
    const quotes = segments.filter((segment) => segment.type === 'quote' && segment.collapse);
    const count = quotes.length;
    const pillLabel =
      count === 1
        ? t('message.annotation', { count })
        : t('message.annotations', { count });

    const prose = segments.map((segment, index) => {
      if (segment.type !== 'prose') return null;
      const trimmed = segment.text.trim();
      if (!trimmed) return null;
      return (
        <MarkdownSegment
          key={`seg-${index}`}
          cacheKey={`${cacheKey}:${index}`}
          text={trimmed}
        />
      );
    });

    return (
      <>
        <div className="user-quote-annotations">
          <button
            ref={pillRef}
            type="button"
            className="user-quote-annotation-pill"
            aria-expanded={open}
            aria-haspopup="dialog"
            aria-label={pillLabel}
            onClick={() => setOpen((value) => !value)}
          >
            <MessageSquare size={14} aria-hidden="true" />
            <span>{pillLabel}</span>
          </button>
        </div>
        {prose}
        {open
          ? createPortal(
              <div
                ref={floatRef}
                className="user-quote-float"
                role="dialog"
                aria-label={pillLabel}
                style={
                  pos
                    ? {
                        top: pos.top,
                        left: pos.left,
                        maxWidth: pos.maxWidth,
                      }
                    : {
                        top: 0,
                        left: 0,
                        visibility: 'hidden',
                      }
                }
              >
                {quotes.map((quote, index) => (
                  <div key={`quote-card-${index}`} className="user-quote-selected-card">
                    <div className="user-quote-selected-label">
                      {t('message.selectedText', { n: index + 1 })}
                    </div>
                    <div className="user-quote-selected-body">
                      {quoteBlockPlainText(quote.text)}
                    </div>
                  </div>
                ))}
              </div>,
              document.body,
            )
          : null}
      </>
    );
  }

  if (isLongUserText(text)) {
    return <LongTextMessage text={text} />;
  }

  return <MarkdownSegment cacheKey={cacheKey} text={text} />;
}
