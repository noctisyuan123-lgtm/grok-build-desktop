import { useLayoutEffect, useRef, type MouseEvent } from 'react';
import { attachTableScroll } from '../lib/tableScroll';

/** Rendered markdown HTML with conversation table-scroll and code-copy behavior. */
export function MarkdownHtml({
  html,
  owner,
  className,
}: {
  html: string;
  owner: string;
  className?: string;
}) {
  const ref = useRef<HTMLDivElement>(null);

  useLayoutEffect(() => {
    const root = ref.current;
    if (!root) return;
    return attachTableScroll(owner, root);
  }, [html, owner]);

  return (
    <div
      ref={ref}
      className={className}
      dangerouslySetInnerHTML={{ __html: html }}
      onClick={handleMarkdownClick}
    />
  );
}

function handleMarkdownClick(event: MouseEvent<HTMLDivElement>): void {
  const target = event.target;
  if (!(target instanceof Element)) return;
  const button = target.closest<HTMLButtonElement>('.code-block-copy-button');
  if (!button) return;
  event.preventDefault();
  event.stopPropagation();

  const tableShell = button.closest('.md-table-shell, .md-table-wrap');
  if (tableShell) {
    const table = tableShell.querySelector('table');
    if (!table) return;
    void copyMarkdownClipboard(button, tableToPlainText(table), 'Copy table');
    return;
  }

  const code = button.parentElement?.querySelector('code');
  if (!code) return;
  void copyMarkdownClipboard(button, code.textContent ?? '', 'Copy code block');
}

function tableToPlainText(table: HTMLTableElement): string {
  return Array.from(table.querySelectorAll('tr'))
    .map((row) =>
      Array.from(row.querySelectorAll('th, td'))
        .map((cell) => (cell.textContent ?? '').replace(/\s+/g, ' ').trim())
        .join('\t'),
    )
    .join('\n');
}

async function copyMarkdownClipboard(
  button: HTMLButtonElement,
  text: string,
  idleLabel: string,
): Promise<void> {
  try {
    await navigator.clipboard.writeText(text);
  } catch {
    const selection = window.getSelection();
    if (!selection) return;
    selection.removeAllRanges();
    const range = document.createRange();
    const tableHost = button.closest('.md-table-shell, .md-table-wrap');
    const fallback = tableHost?.querySelector('table') ?? button.parentElement?.querySelector('code');
    if (!fallback) return;
    range.selectNodeContents(fallback);
    selection.addRange(range);
    document.execCommand('copy');
    selection.removeAllRanges();
  }
  button.classList.add('copied');
  button.setAttribute('aria-label', 'Copied');
  window.setTimeout(() => {
    button.classList.remove('copied');
    button.setAttribute('aria-label', idleLabel);
  }, 2_000);
}
