/**
 * Collapse quoted references in user transcript bubbles.
 *
 * Quote selection inserts markdown blockquotes (`> — Assistant` + body).
 * Even short cites clutter the bubble beside follow-up prose, so we split
 * the user text into quote runs vs prose and fold every quote run into a
 * Codex-style annotation pill + inline selected-text card. Follow-up prose
 * stays visible in the normal user bubble.
 *
 * Product default: collapse all continuous `/^\s*>/` quote runs (any length).
 * `isLongQuoteBlock` / the legacy thresholds remain for callers that want a
 * size check; segment splitting always sets `collapse: true` on quotes.
 */

const BLOCKQUOTE_LINE_RE = /^\s*>/;
/** Codex attribution inserted by formatQuoteMarkdown (`> — Assistant · id`). */
const ATTRIBUTION_LINE_RE = /^\s*>\s*—/;
const BLANK_QUOTE_LINE_RE = /^\s*>\s*$/;

/** Min body lines (non-blank, non-attribution) before a quote collapses. */
export const LONG_QUOTE_BODY_LINE_THRESHOLD = 4;
/** Min total characters in the quote block (including `>` markers) to collapse. */
export const LONG_QUOTE_CHAR_THRESHOLD = 240;

export type UserTextSegment = {
  type: 'quote' | 'prose';
  text: string;
  /** True when this quote run should render as a collapsed annotation. Prose is never collapsed here. */
  collapse: boolean;
};

function normalizeNewlines(text: string): string {
  return text.replace(/\r\n/g, '\n').replace(/\r/g, '\n');
}

function stripQuoteMarker(line: string): string {
  return line.replace(/^\s*>\s?/, '');
}

/** Body-line count and total chars used by the long-quote threshold. */
export function quoteBlockStats(quoteText: string): { bodyLines: number; chars: number } {
  const lines = normalizeNewlines(quoteText).split('\n');
  let bodyLines = 0;
  for (const line of lines) {
    if (!BLOCKQUOTE_LINE_RE.test(line)) continue;
    if (ATTRIBUTION_LINE_RE.test(line)) continue;
    if (BLANK_QUOTE_LINE_RE.test(line)) continue;
    bodyLines += 1;
  }
  return { bodyLines, chars: quoteText.length };
}

export function isLongQuoteBlock(quoteText: string): boolean {
  const { bodyLines, chars } = quoteBlockStats(quoteText);
  return bodyLines >= LONG_QUOTE_BODY_LINE_THRESHOLD || chars >= LONG_QUOTE_CHAR_THRESHOLD;
}

/**
 * Prefer the first non-empty body line (after `>`) for a short label — not
 * the muted `> — Assistant · id` attribution.
 */
export function quoteBlockLabel(quoteText: string): string {
  const lines = normalizeNewlines(quoteText).split('\n');
  for (const line of lines) {
    if (!BLOCKQUOTE_LINE_RE.test(line)) continue;
    if (ATTRIBUTION_LINE_RE.test(line)) continue;
    if (BLANK_QUOTE_LINE_RE.test(line)) continue;
    const body = stripQuoteMarker(line).trim();
    if (body) return body;
  }
  return '';
}

/**
 * Strip `>` markers and the attribution line into plain selected text for the
 * annotation card body (Codex shows just the selection under "Selected text:").
 */
export function quoteBlockPlainText(quoteText: string): string {
  const lines = normalizeNewlines(quoteText).split('\n');
  const out: string[] = [];
  for (const line of lines) {
    if (!BLOCKQUOTE_LINE_RE.test(line)) continue;
    if (ATTRIBUTION_LINE_RE.test(line)) continue;
    if (BLANK_QUOTE_LINE_RE.test(line)) {
      if (out.length > 0) out.push('');
      continue;
    }
    out.push(stripQuoteMarker(line));
  }
  while (out.length > 0 && out[out.length - 1] === '') out.pop();
  return out.join('\n');
}

/**
 * Split user markdown into consecutive blockquote runs vs surrounding prose.
 * A continuous run of lines matching `/^\s*>/` is one quote segment; everything
 * else (including blank lines between quote blocks) is prose.
 */
export function splitUserTextSegments(text: string): UserTextSegment[] {
  const lines = normalizeNewlines(text).split('\n');
  const segments: UserTextSegment[] = [];
  let i = 0;

  while (i < lines.length) {
    if (BLOCKQUOTE_LINE_RE.test(lines[i]!)) {
      const start = i;
      while (i < lines.length && BLOCKQUOTE_LINE_RE.test(lines[i]!)) i += 1;
      const quoteText = lines.slice(start, i).join('\n');
      segments.push({
        type: 'quote',
        text: quoteText,
        // Always fold quotes — short one-liners included (product default).
        collapse: true,
      });
    } else {
      const start = i;
      while (i < lines.length && !BLOCKQUOTE_LINE_RE.test(lines[i]!)) i += 1;
      segments.push({
        type: 'prose',
        text: lines.slice(start, i).join('\n'),
        collapse: false,
      });
    }
  }

  return segments;
}

/** True when the text contains any quote run (all quotes collapse). */
export function hasCollapsibleQuote(text: string): boolean {
  return splitUserTextSegments(text).some((seg) => seg.type === 'quote' && seg.collapse);
}
