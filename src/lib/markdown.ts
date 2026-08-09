import { footnote } from '@mdit/plugin-footnote';
import { tasklist } from '@mdit/plugin-tasklist';
import markdownItKatex from '@vscode/markdown-it-katex';
import hljs from 'highlight.js/lib/common';
import type { KatexOptions } from 'katex';
import MarkdownIt from 'markdown-it';

type MarkdownKatexOptions = NonNullable<Parameters<typeof markdownItKatex>[1]>;

const markdown = new MarkdownIt({
  html: true,
  breaks: false,
  linkify: true,
  typographer: false,
  highlight(text, language) {
    const lang = normalizeLanguage(language);
    if (!lang || text.length > 50000 || !hljs.getLanguage(lang)) return '';
    try {
      return hljs.highlight(text, { language: lang, ignoreIllegals: true }).value;
    } catch {
      return '';
    }
  },
})
  .use(tasklist, { disabled: true, label: false })
  .use(footnote)
  // The production Tauri CSP intentionally blocks inline styles. KaTeX's
  // HTML renderer positions superscripts, fractions and large operators with
  // inline top/height styles, so that representation collapses in WKWebView.
  // WebKit has first-class MathML support; emitting MathML avoids inline
  // positioning entirely while keeping KaTeX's parser and error handling.
  .use(markdownItKatex, {
    throwOnError: false,
    enableFencedBlocks: true,
    output: 'mathml',
  } as MarkdownKatexOptions & KatexOptions);

// Keep fenced-code metadata visible instead of silently throwing the language
// away. This small header is intentionally static (copy remains a message-level
// action) so it works in the strict Tauri CSP without inline handlers.
const renderFence = markdown.renderer.rules.fence;
markdown.renderer.rules.fence = (tokens, index, options, env, self) => {
  const rendered = renderFence
    ? renderFence(tokens, index, options, env, self)
    : self.renderToken(tokens, index, options);
  const language = tokens[index]?.info.trim().split(/\s+/u)[0];
  if (!language) return rendered;
  return `<div class="code-block-shell"><div class="code-block-head"><span class="code-block-lang">${markdown.utils.escapeHtml(language)}</span></div>${rendered}</div>`;
};

export function renderMarkdown(source: string): string {
  return markdown.render(normalizeMathDelimiters(source));
}

// VS Code's math extension accepts dollar delimiters. Models also commonly
// emit LaTeX's \(...\) and \[...\] forms, so translate those forms while
// leaving fenced and inline code untouched.
export function normalizeMathDelimiters(source: string): string {
  let fence: { marker: string; length: number } | null = null;
  let blockMath = false;

  return source
    .split('\n')
    .map((line) => {
      const fenceMatch = line.match(/^\s*(`{3,}|~{3,})/);
      if (fenceMatch) {
        const run = fenceMatch[1]!;
        if (!fence) fence = { marker: run[0]!, length: run.length };
        else if (run[0] === fence.marker && run.length >= fence.length) fence = null;
        return line;
      }
      if (fence) return line;

      let result = '';
      let inlineTicks = 0;
      for (let i = 0; i < line.length; ) {
        if (line[i] === '`') {
          let end = i + 1;
          while (line[end] === '`') end += 1;
          const runLength = end - i;
          if (inlineTicks === 0) inlineTicks = runLength;
          else if (inlineTicks === runLength) inlineTicks = 0;
          result += line.slice(i, end);
          i = end;
          continue;
        }

        if (inlineTicks === 0 && line[i] === '\\' && i + 1 < line.length) {
          const delimiter = line[i + 1];
          if (delimiter === '[' && !blockMath) {
            result += '$$';
            blockMath = true;
            i += 2;
            continue;
          }
          if (delimiter === ']' && blockMath) {
            result += '$$';
            blockMath = false;
            i += 2;
            continue;
          }
          if (delimiter === '(' || delimiter === ')') {
            result += '$';
            i += 2;
            continue;
          }
        }

        result += line[i];
        i += 1;
      }
      return result;
    })
    .join('\n');
}

function normalizeLanguage(language: string): string {
  switch (language.toLowerCase()) {
    case 'shell':
      return 'sh';
    case 'py3':
      return 'python';
    case 'tsx':
    case 'typescriptreact':
      return 'jsx';
    case 'json5':
    case 'jsonc':
      return 'json';
    case 'c#':
    case 'csharp':
      return 'cs';
    default:
      return language;
  }
}
