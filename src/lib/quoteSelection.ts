/**
 * Codex-style quote helpers: turn a browser text selection into markdown
 * blockquote content for the composer.
 *
 * Product default (Codex-like):
 * - Insert plain markdown blockquotes (`> …`) into the composer text.
 * - Include a short “Assistant” attribution line so the turn role is visible
 *   in the draft (the surrounding transcript already supplies full context).
 * - No separate citation chip / metadata channel in v1 — the model sees the
 *   same blockquote the user edits.
 */

export const ASSISTANT_MESSAGE_SELECTOR = '.message.message-assistant';

export interface QuoteSelectionInfo {
  text: string;
  messageId: string | null;
  /** Viewport rect used to position the floating toolbar. */
  rect: {
    top: number;
    left: number;
    bottom: number;
    right: number;
    width: number;
    height: number;
  };
}

function nodeElement(node: Node | null): Element | null {
  if (!node) return null;
  return node.nodeType === Node.ELEMENT_NODE ? (node as Element) : node.parentElement;
}

/** True when the selection is entirely inside a single assistant message body. */
export function resolveAssistantQuoteSelection(
  selection: Selection | null = typeof window !== 'undefined' ? window.getSelection() : null,
): QuoteSelectionInfo | null {
  if (!selection || selection.isCollapsed || selection.rangeCount === 0) return null;
  const text = selection.toString().replace(/\u00a0/g, ' ');
  if (!text.trim()) return null;

  const anchorEl = nodeElement(selection.anchorNode);
  const focusEl = nodeElement(selection.focusNode);
  if (!anchorEl || !focusEl) return null;

  // Keep native copy / code selection working: never treat composer or inputs
  // as quote sources.
  if (
    anchorEl.closest('textarea, input, .composer, .composer-editor, [data-no-quote]') ||
    focusEl.closest('textarea, input, .composer, .composer-editor, [data-no-quote]')
  ) {
    return null;
  }

  const anchorMessage = anchorEl.closest(ASSISTANT_MESSAGE_SELECTOR);
  const focusMessage = focusEl.closest(ASSISTANT_MESSAGE_SELECTOR);
  if (!anchorMessage || anchorMessage !== focusMessage) return null;

  // Prefer the rendered answer body so tool-rail chrome doesn't become a quote
  // source when the user only meant to drag across a header.
  const inAnswer =
    anchorEl.closest('.markdown-body, .message-body, pre.message-body') &&
    focusEl.closest('.markdown-body, .message-body, pre.message-body');
  if (!inAnswer) return null;

  // Ignore pure UI chrome inside the bubble (action buttons, etc.).
  const anchorInChrome = Boolean(anchorEl.closest('.message-actions'));
  const focusInChrome = Boolean(focusEl.closest('.message-actions'));
  if (anchorInChrome && focusInChrome) return null;

  let rect: DOMRect;
  try {
    rect = selection.getRangeAt(0).getBoundingClientRect();
  } catch {
    return null;
  }
  if (!rect || (rect.width === 0 && rect.height === 0)) return null;

  return {
    text,
    messageId: anchorMessage.getAttribute('data-message-id'),
    rect: {
      top: rect.top,
      left: rect.left,
      bottom: rect.bottom,
      right: rect.right,
      width: rect.width,
      height: rect.height,
    },
  };
}

/** Short Codex-like id for the attribution line (avoid dumping full UUIDs). */
export function formatQuoteAttributionId(messageId: string | null | undefined): string | null {
  const raw = messageId?.trim();
  if (!raw) return null;
  if (raw.length <= 18) return raw;
  // Prefer the trailing segment when ids look like `a-mue0xho5-7be2db`.
  const tail = raw.split('-').filter(Boolean).slice(-2).join('-');
  if (tail && tail.length >= 6 && tail.length <= 18) return tail;
  return `${raw.slice(0, 8)}…${raw.slice(-6)}`;
}

/** Format selected text as a markdown blockquote with a light role attribution. */
export function formatQuoteMarkdown(
  text: string,
  opts?: { role?: 'assistant' | 'user'; messageId?: string | null },
): string {
  const normalized = text.replace(/\r\n/g, '\n').replace(/\r/g, '\n').replace(/\u00a0/g, ' ');
  // Whitespace-only selections are not useful quotes.
  if (!normalized.trim()) return '';
  // Trim outer blank lines but preserve internal indentation (code snippets).
  const trimmed = normalized.replace(/^\n+/, '').replace(/\n+$/, '');
  if (!trimmed) return '';

  const role = opts?.role === 'user' ? 'User' : 'Assistant';
  const id = formatQuoteAttributionId(opts?.messageId);
  const attribution = id ? `${role} · ${id}` : role;

  const body = trimmed
    .split('\n')
    .map((line) => `> ${line}`)
    .join('\n');

  // Blank `>` keeps attribution and body as separate paragraphs so CSS can
  // mute the first line (Codex: dim “— Assistant · id”, brighter excerpt).
  return `> — ${attribution}\n>\n${body}`;
}

/** Merge a quote block into existing composer markdown. */
export function mergeQuoteIntoComposer(existing: string, quoteBlock: string): string {
  const quote = quoteBlock.trim();
  if (!quote) return existing;
  const current = existing.replace(/\s+$/u, '');
  if (!current.trim()) return `${quote}\n\n`;
  return `${current}\n\n${quote}\n\n`;
}
