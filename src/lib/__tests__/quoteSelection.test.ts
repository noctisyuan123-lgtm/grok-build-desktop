import { describe, expect, it } from 'vitest';
import { formatQuoteMarkdown, mergeQuoteIntoComposer } from '../quoteSelection';

describe('formatQuoteMarkdown', () => {
  it('wraps each line as a blockquote with an Assistant attribution', () => {
    expect(formatQuoteMarkdown('hello\nworld')).toBe('> — Assistant\n>\n> hello\n> world');
  });

  it('includes a short message id when provided', () => {
    expect(formatQuoteMarkdown('x', { messageId: 'msg-123' })).toBe(
      '> — Assistant · msg-123\n>\n> x',
    );
  });

  it('compacts long message ids in the attribution line', () => {
    expect(
      formatQuoteMarkdown('x', { messageId: 'a-mue0xho5-7be2db-extra-long-tail' }),
    ).toBe('> — Assistant · long-tail\n>\n> x');
  });

  it('preserves indentation inside the selection', () => {
    expect(formatQuoteMarkdown('  foo\n    bar')).toBe('> — Assistant\n>\n>   foo\n>     bar');
  });

  it('returns empty string for whitespace-only input', () => {
    expect(formatQuoteMarkdown('  \n  ')).toBe('');
  });
});

describe('mergeQuoteIntoComposer', () => {
  it('inserts into an empty composer', () => {
    expect(mergeQuoteIntoComposer('', '> — Assistant\n>\n> hi')).toBe('> — Assistant\n>\n> hi\n\n');
  });

  it('appends after existing draft with a blank line', () => {
    expect(mergeQuoteIntoComposer('draft note', '> — Assistant\n>\n> hi')).toBe(
      'draft note\n\n> — Assistant\n>\n> hi\n\n',
    );
  });
});

import {
  isLongQuoteBlock,
  quoteBlockLabel,
  quoteBlockPlainText,
  quoteBlockStats,
  splitUserTextSegments,
  LONG_QUOTE_BODY_LINE_THRESHOLD,
  LONG_QUOTE_CHAR_THRESHOLD,
} from '../quoteCollapse';

function attributedQuote(bodyLines: string[]): string {
  return ['> — Assistant', '>', ...bodyLines.map((line) => `> ${line}`)].join('\n');
}

describe('splitUserTextSegments', () => {
  it('collapses short quotes and preserves follow-up prose', () => {
    const text = `${attributedQuote(['one liner'])}\n\nplease fix this`;
    expect(splitUserTextSegments(text)).toEqual([
      { type: 'quote', text: attributedQuote(['one liner']), collapse: true },
      { type: 'prose', text: '\nplease fix this', collapse: false },
    ]);
  });

  it('marks long body-line quotes for collapse', () => {
    const body = ['a', 'b', 'c', 'd'];
    expect(body.length).toBe(LONG_QUOTE_BODY_LINE_THRESHOLD);
    const quote = attributedQuote(body);
    const segments = splitUserTextSegments(`${quote}\n\nplease fix this`);
    expect(segments[0]).toMatchObject({ type: 'quote', collapse: true, text: quote });
    expect(segments[1]).toMatchObject({ type: 'prose', collapse: false });
    expect(segments[1]?.text).toContain('please fix this');
  });

  it('marks bulky single-paragraph quotes by character threshold', () => {
    const body = 'x'.repeat(LONG_QUOTE_CHAR_THRESHOLD);
    const quote = attributedQuote([body]);
    expect(quoteBlockStats(quote).bodyLines).toBe(1);
    expect(isLongQuoteBlock(quote)).toBe(true);
    expect(splitUserTextSegments(quote)[0]?.collapse).toBe(true);
  });

  it('splits multiple quote runs separated by prose', () => {
    const short = attributedQuote(['short']);
    const long = attributedQuote(['a', 'b', 'c', 'd']);
    const text = `${short}\n\nmid note\n\n${long}`;
    const segments = splitUserTextSegments(text);
    expect(segments.map((s) => [s.type, s.collapse])).toEqual([
      ['quote', true],
      ['prose', false],
      ['quote', true],
    ]);
  });

  it('returns a single prose segment when there are no quotes', () => {
    expect(splitUserTextSegments('just a prompt')).toEqual([
      { type: 'prose', text: 'just a prompt', collapse: false },
    ]);
  });
});

describe('quoteBlockLabel', () => {
  it('prefers the first body line over the attribution', () => {
    expect(quoteBlockLabel(attributedQuote(['Hello world', 'more']))).toBe('Hello world');
  });

  it('skips blank quote lines when finding a label', () => {
    expect(quoteBlockLabel('> — Assistant\n>\n>\n> actual body')).toBe('actual body');
  });
});

describe('quoteBlockPlainText', () => {
  it('strips markers and attribution, keeping selected body lines', () => {
    expect(quoteBlockPlainText(attributedQuote(['Hello world', 'more']))).toBe(
      'Hello world\nmore',
    );
  });

  it('omits the attribution line from the card body', () => {
    const plain = quoteBlockPlainText(
      formatQuoteMarkdown('selected bit', { messageId: 'msg-abc' }),
    );
    expect(plain).toBe('selected bit');
    expect(plain).not.toContain('Assistant');
  });

  it('preserves blank lines between body paragraphs', () => {
    expect(quoteBlockPlainText('> — Assistant\n>\n> para one\n>\n> para two')).toBe(
      'para one\n\npara two',
    );
  });
});

describe('isLongQuoteBlock', () => {
  it('still reports size for short one-liners (segment split always collapses)', () => {
    expect(isLongQuoteBlock(attributedQuote(['tiny']))).toBe(false);
    expect(isLongQuoteBlock(attributedQuote(['a', 'b', 'c']))).toBe(false);
    expect(splitUserTextSegments(attributedQuote(['tiny']))[0]?.collapse).toBe(true);
  });
});
