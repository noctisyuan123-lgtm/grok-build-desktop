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
