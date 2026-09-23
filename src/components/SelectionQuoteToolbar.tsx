import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { Quote } from 'lucide-react';
import { t } from '../i18n';
import {
  formatQuoteMarkdown,
  resolveAssistantQuoteSelection,
  type QuoteSelectionInfo,
} from '../lib/quoteSelection';

interface Props {
  /** Insert the formatted quote into the composer and focus it. */
  onQuote: (markdown: string, source: QuoteSelectionInfo) => void;
}

interface ToolbarState {
  source: QuoteSelectionInfo;
  x: number;
  y: number;
}

/**
 * Codex-style floating “Quote” action that appears when the user selects text
 * inside an assistant message. Portaled to document.body so Virtuoso overflow
 * clipping cannot hide it.
 */
export function SelectionQuoteToolbar({ onQuote }: Props) {
  const [toolbar, setToolbar] = useState<ToolbarState | null>(null);
  const rootRef = useRef<HTMLDivElement | null>(null);
  // Ignore the next selectionchange after we clear the range ourselves.
  const suppressRef = useRef(false);

  useEffect(() => {
    let frame = 0;
    // While the primary button is down the user is still dragging a native
    // selection. Showing a fixed toolbar mid-drag can sit over earlier lines
    // and disturb hit-testing (LTR grabs lines above). Wait for pointer up.
    const pointerDownRef = { current: false };

    const refresh = () => {
      cancelAnimationFrame(frame);
      frame = requestAnimationFrame(() => {
        if (suppressRef.current) {
          suppressRef.current = false;
          setToolbar(null);
          return;
        }
        if (pointerDownRef.current) {
          setToolbar(null);
          return;
        }
        const source = resolveAssistantQuoteSelection();
        if (!source) {
          setToolbar(null);
          return;
        }
        const vv = window.visualViewport;
        const offsetLeft = vv?.offsetLeft ?? 0;
        const offsetTop = vv?.offsetTop ?? 0;
        const viewW = vv?.width ?? window.innerWidth;
        // Prefer above the selection; fall below when near the top edge.
        const above = source.rect.top - 8;
        const y = above < 36 + offsetTop ? source.rect.bottom + 8 : above;
        const x = Math.min(
          Math.max(source.rect.left + source.rect.width / 2, offsetLeft + 48),
          offsetLeft + viewW - 48,
        );
        setToolbar({ source, x, y });
      });
    };

    const onPointerDown = (event: PointerEvent) => {
      if (event.button === 0) pointerDownRef.current = true;
    };
    const onPointerUp = () => {
      pointerDownRef.current = false;
      refresh();
    };

    const onScroll = () => setToolbar(null);

    document.addEventListener('pointerdown', onPointerDown, true);
    document.addEventListener('pointerup', onPointerUp, true);
    document.addEventListener('pointercancel', onPointerUp, true);
    document.addEventListener('selectionchange', refresh);
    document.addEventListener('mouseup', onPointerUp);
    document.addEventListener('keyup', refresh);
    // Capture scroll from the Virtuoso scroller (does not bubble).
    document.addEventListener('scroll', onScroll, true);
    window.addEventListener('resize', onScroll);
    window.visualViewport?.addEventListener('resize', onScroll);
    window.visualViewport?.addEventListener('scroll', onScroll);

    return () => {
      cancelAnimationFrame(frame);
      document.removeEventListener('pointerdown', onPointerDown, true);
      document.removeEventListener('pointerup', onPointerUp, true);
      document.removeEventListener('pointercancel', onPointerUp, true);
      document.removeEventListener('selectionchange', refresh);
      document.removeEventListener('mouseup', onPointerUp);
      document.removeEventListener('keyup', refresh);
      document.removeEventListener('scroll', onScroll, true);
      window.removeEventListener('resize', onScroll);
      window.visualViewport?.removeEventListener('resize', onScroll);
      window.visualViewport?.removeEventListener('scroll', onScroll);
    };
  }, []);

  useLayoutEffect(() => {
    const el = rootRef.current;
    if (!el || !toolbar) return;
    const { width, height } = el.getBoundingClientRect();
    const vv = window.visualViewport;
    const offsetLeft = vv?.offsetLeft ?? 0;
    const offsetTop = vv?.offsetTop ?? 0;
    const viewW = vv?.width ?? window.innerWidth;
    const viewH = vv?.height ?? window.innerHeight;
    const left = Math.min(
      Math.max(toolbar.x - width / 2, offsetLeft + 8),
      offsetLeft + viewW - width - 8,
    );
    const preferAbove = toolbar.y <= toolbar.source.rect.top;
    const top = preferAbove
      ? Math.max(offsetTop + 8, toolbar.y - height)
      : Math.min(toolbar.y, offsetTop + viewH - height - 8);
    el.style.left = `${left}px`;
    el.style.top = `${top}px`;
  }, [toolbar]);

  if (!toolbar) return null;

  const label = t('message.quote');

  return createPortal(
    <div
      ref={rootRef}
      className="selection-quote-toolbar"
      role="toolbar"
      aria-label={label}
      // Keep the selection alive through the click (mousedown would clear it).
      onMouseDown={(event) => event.preventDefault()}
    >
      <button
        type="button"
        className="selection-quote-toolbar-btn"
        aria-label={label}
        title={label}
        onClick={() => {
          const markdown = formatQuoteMarkdown(toolbar.source.text, {
            role: 'assistant',
            messageId: toolbar.source.messageId,
          });
          if (!markdown) return;
          suppressRef.current = true;
          onQuote(markdown, toolbar.source);
          window.getSelection()?.removeAllRanges();
          setToolbar(null);
        }}
      >
        <Quote size={13} strokeWidth={2} aria-hidden="true" />
        <span>{label}</span>
      </button>
    </div>,
    document.body,
  );
}
