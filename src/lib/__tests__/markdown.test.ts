import { describe, expect, it } from 'vitest';
import { normalizeMathDelimiters, renderMarkdown } from '../markdown';

describe('renderMarkdown extensions', () => {
  it('renders task-list markers as disabled checkboxes', () => {
    const html = renderMarkdown('- [x] done\n- [ ] pending');
    expect(html).toContain('class="task-list-item"');
    expect(html).toContain('type="checkbox"');
    expect(html).toContain('checked="checked"');
    expect(html).not.toContain('[x]');
  });

  it('renders footnotes and backlinks', () => {
    const html = renderMarkdown('A note[^1].\n\n[^1]: Footnote text.');
    expect(html).toContain('class="footnote-ref"');
    expect(html).toContain('class="footnotes"');
    expect(html).toContain('Footnote text.');
  });

  it('renders dollar and LaTeX bracket math with KaTeX', () => {
    const inline = renderMarkdown('Inline $E=mc^2$.');
    expect(inline).toContain('class="katex"');
    expect(inline).toContain('<msup>');
    expect(inline).not.toContain('class="katex-html"');
    expect(renderMarkdown('Inline \\(E=mc^2\\).')).toContain('class="katex"');
    const block = renderMarkdown('\\[\\sum_{i=1}^{n} i\\]');
    expect(block).toContain('class="katex-block"');
    expect(block).toContain('display="block"');
    expect(block).toContain('<munderover>');
  });

  it('does not rewrite math delimiters inside code', () => {
    const source = '`\\(inline code\\)`\n\n```txt\n\\[block code\\]\n```';
    expect(normalizeMathDelimiters(source)).toBe(source);
  });

  it('uses the original compact native pre for fenced code', () => {
    const html = renderMarkdown('```ts\nconst value = 1;\n```');
    expect(html).toContain('<pre><code class="language-ts"');
    expect(html).toContain('class="language-ts"');
    expect(html).toContain('<span class="hljs-keyword">const</span>');
    expect(html).toContain('<span class="hljs-number">1</span>');
    expect(html).toContain('class="code-block-copy-button"');
    expect(html).toContain('aria-label="Copy code block"');
    expect(html).not.toContain('code-block-shell');
    expect(html).not.toContain('code-block-head');
  });
});
