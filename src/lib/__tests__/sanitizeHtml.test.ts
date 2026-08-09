import { describe, expect, it } from 'vitest';
import { renderMarkdown } from '../markdown';
import { sanitizeHtml } from '../sanitizeHtml';

// Mirrors the pipeline: assistant text → markdown-it (worker) → sanitizeHtml →
// dangerouslySetInnerHTML in MessageItem. markdown-it passes raw HTML through
// unmodified, so hostile markup in a model/tool response must be stripped
// here — while normal markdown (code blocks, links, tables) survives.
const hostileMarkdown = [
  '# Report',
  '',
  '<script>window.__pwned = true;</script>',
  '',
  '<img src="x" onerror="window.__pwned = true" />',
  '',
  '<a href="javascript:alert(1)">totally safe link</a>',
  '',
  '```ts',
  'const x: number = 1;',
  '```',
  '',
  '| name | value |',
  '| ---- | ----- |',
  '| a    | 1     |',
  '',
  '[docs](https://example.com/docs)',
].join('\n');

function parse(md: string): string {
  return renderMarkdown(md);
}

describe('sanitizeHtml', () => {
  it('strips script tags and inline event handlers from parsed markdown', () => {
    const html = parse(hostileMarkdown);
    // Sanity: markdown-it really does let the raw HTML through untouched.
    expect(html).toContain('<script>');
    expect(html).toContain('onerror');

    const safe = sanitizeHtml(html);
    expect(safe).not.toContain('<script');
    expect(safe).not.toContain('__pwned');
    expect(safe).not.toContain('onerror');
    expect(safe).not.toContain('javascript:');
  });

  it('keeps normal markdown output: headings, code blocks, tables, links', () => {
    const safe = sanitizeHtml(parse(hostileMarkdown));
    expect(safe).toContain('<h1');
    expect(safe).toContain('<pre');
    expect(safe).toContain('<code');
    const rendered = document.createElement('div');
    rendered.innerHTML = safe;
    expect(rendered.textContent).toContain('const x: number = 1;');
    expect(safe).toContain('<table');
    expect(safe).toContain('<td>a</td>');
    expect(safe).toMatch(/<a[^>]+href="https:\/\/example\.com\/docs"/);
  });

  it('keeps highlight.js code-block markup (classes and spans)', () => {
    const highlighted =
      '<pre class="code-block"><code class="hljs language-ts">' +
      '<span class="hljs-keyword">const</span> x = 1;</code></pre>';
    const safe = sanitizeHtml(highlighted);
    expect(safe).toContain('class="hljs language-ts"');
    expect(safe).toContain('<span class="hljs-keyword">const</span>');
  });

  it('keeps the VS Code copy control while stripping executable attributes', () => {
    const safe = sanitizeHtml(
      '<pre><code>echo ok</code><button class="code-block-copy-button" type="button" aria-label="Copy code block" onclick="steal()"><svg viewBox="0 0 16 16"><path d="M0 0"></path></svg></button></pre>',
    );
    expect(safe).toContain('class="code-block-copy-button"');
    expect(safe).toContain('aria-label="Copy code block"');
    expect(safe).toContain('<svg');
    expect(safe).not.toContain('onclick');
  });

  it('keeps KaTeX MathML semantics without flattening the TeX annotation', () => {
    const safe = sanitizeHtml(renderMarkdown('$E=mc^2$'));
    const rendered = document.createElement('div');
    rendered.innerHTML = safe;

    expect(rendered.querySelector('math msup')).not.toBeNull();
    expect(rendered.querySelector('math semantics')).not.toBeNull();
    expect(rendered.querySelector('math annotation')?.getAttribute('encoding')).toBe(
      'application/x-tex',
    );
  });
});
