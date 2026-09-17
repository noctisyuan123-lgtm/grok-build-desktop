import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { LongTextMessage } from '../LongTextMessage';
import { isLongUserText } from '../../lib/longText';
import { renderMarkdown } from '../../lib/markdown';
import { streamStore } from '../../lib/streamStore';

class FakeMarkdownWorker {
  private handlers = new Map<string, Array<(event: { data: unknown }) => void>>();

  addEventListener(type: string, cb: (event: { data: unknown }) => void): void {
    this.handlers.set(type, [...(this.handlers.get(type) ?? []), cb]);
  }

  postMessage(msg: { runId: string; text: string }): void {
    const html = renderMarkdown(msg.text);
    queueMicrotask(() => {
      for (const cb of this.handlers.get('message') ?? []) {
        cb({ data: { runId: msg.runId, html, text: msg.text } });
      }
    });
  }

  terminate(): void {}
}

describe('LongTextMessage', () => {
  beforeEach(() => {
    streamStore.__reset();
    vi.stubGlobal('Worker', FakeMarkdownWorker);
  });

  it('only collapses genuinely long pasted text', () => {
    expect(isLongUserText('short message')).toBe(false);
    expect(isLongUserText('line\n'.repeat(10))).toBe(true);
    expect(isLongUserText('x'.repeat(800))).toBe(true);
  });

  it('opens the complete text as conversation markdown and closes with Escape', async () => {
    const user = userEvent.setup();
    const text = ['# Hello', '', 'second paragraph', 'third line'].join('\n');
    render(<LongTextMessage text={text} />);

    expect(screen.getByText('# Hello')).toBeInTheDocument();
    expect(screen.queryByRole('heading', { level: 1, name: 'Hello' })).not.toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Open pasted text' }));

    expect(screen.getByRole('dialog', { name: 'Pasted text preview' })).toBeInTheDocument();
    expect(screen.getByText('4 lines')).toBeInTheDocument();
    expect(document.querySelector('.long-text-line-numbers')).toBeNull();
    expect(await screen.findByRole('heading', { level: 1, name: 'Hello' })).toBeInTheDocument();
    expect(document.querySelector('.long-text-markdown .markdown-body')).not.toBeNull();

    await user.keyboard('{Escape}');
    expect(screen.queryByRole('dialog', { name: 'Pasted text preview' })).not.toBeInTheDocument();
  });
});
