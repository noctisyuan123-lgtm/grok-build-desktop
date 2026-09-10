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
  const code = button.parentElement?.querySelector('code');
  if (!code) return;
  void copyCodeBlock(button, code.textContent ?? '');
}

async function copyCodeBlock(button: HTMLButtonElement, text: string): Promise<void> {
  try {
    await navigator.clipboard.writeText(text);
  } catch {
    const code = button.parentElement?.querySelector('code');
    const selection = window.getSelection();
    if (!code || !selection) return;
    selection.removeAllRanges();
    const range = document.createRange();
    range.selectNodeContents(code);
    selection.addRange(range);
    document.execCommand('copy');
    selection.removeAllRanges();
  }
  button.classList.add('copied');
  button.setAttribute('aria-label', 'Copied');
  window.setTimeout(() => {
    button.classList.remove('copied');
    button.setAttribute('aria-label', 'Copy code block');
  }, 2_000);
}
