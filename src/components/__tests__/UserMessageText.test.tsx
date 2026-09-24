import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { UserMessageText } from '../UserMessageText';
import { renderMarkdown } from '../../lib/markdown';
import { streamStore } from '../../lib/streamStore';
import { formatQuoteMarkdown } from '../../lib/quoteSelection';

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

function longQuoteMarkdown(): string {
  return formatQuoteMarkdown(['alpha', 'beta', 'gamma', 'delta'].join('\n'), {
    messageId: 'msg-abc',
  });
}

describe('UserMessageText', () => {
  beforeEach(() => {
    streamStore.__reset();
    vi.stubGlobal('Worker', FakeMarkdownWorker);
  });

  it('shows an annotation pill plus visible follow-up for quotes', async () => {
    const text = `${longQuoteMarkdown()}\n\nplease fix this`;
    const { container } = render(<UserMessageText text={text} cacheKey="user:test" />);

    expect(screen.getByRole('button', { name: '1 annotation' })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Open quoted text' })).not.toBeInTheDocument();
    expect(container.querySelector('.long-text-pill')).toBeNull();
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    expect(await screen.findByText('please fix this')).toBeInTheDocument();
  });

  it('collapses short quotes to an annotation pill and keeps follow-up visible', async () => {
    const text = `${formatQuoteMarkdown('tiny cite')}\n\nthanks`;
    const { container } = render(<UserMessageText text={text} cacheKey="user:short" />);

    expect(screen.getByRole('button', { name: '1 annotation' })).toBeInTheDocument();
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    await vi.waitFor(() => {
      expect(container.textContent).toContain('thanks');
    });
  });

  it('floats selected-text cards above the pill without a modal chrome', async () => {
    const user = userEvent.setup();
    render(<UserMessageText text={longQuoteMarkdown()} cacheKey="user:expand" />);

    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: '1 annotation' }));
    const dialog = await screen.findByRole('dialog');
    expect(dialog.classList.contains('user-quote-float')).toBe(true);
    expect(dialog.querySelector('.user-quote-popover-head')).toBeNull();
    expect(screen.getByText('1. Selected text:')).toBeInTheDocument();
    const body = dialog.querySelector('.user-quote-selected-body');
    expect(body?.textContent).toBe('alpha\nbeta\ngamma\ndelta');
    expect(body?.textContent).not.toMatch(/— Assistant/);

    // Toggle closed via the same pill.
    await user.click(screen.getByRole('button', { name: '1 annotation' }));
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
  });

  it('keeps follow-up prose mounted when the float opens', async () => {
    const user = userEvent.setup();
    const followUp = '这是light的特点吗';
    const text = `${longQuoteMarkdown()}\n\n${followUp}`;
    const { container } = render(
      <div className="message message-user">
        <UserMessageText text={text} cacheKey="user:stable-prose" />
      </div>,
    );

    await vi.waitFor(() => {
      expect(container.textContent).toContain(followUp);
    });
    expect(container.querySelector('.message.message-user > .user-quote-annotations')).not.toBeNull();
    await vi.waitFor(() => {
      expect(
        container.querySelector('.message.message-user > .message-body.markdown-body'),
      ).not.toBeNull();
    });
    const prose = container.querySelector(
      '.message.message-user > .message-body.markdown-body',
    );
    expect(prose).not.toBeNull();
    expect(prose?.textContent).toContain(followUp);

    await user.click(screen.getByRole('button', { name: '1 annotation' }));
    expect(await screen.findByRole('dialog')).toBeInTheDocument();
    expect(
      container.querySelector('.message.message-user > .message-body.markdown-body'),
    ).toBe(prose);
    expect(prose?.textContent).toContain(followUp);

    await user.click(screen.getByRole('button', { name: '1 annotation' }));
    expect(
      container.querySelector('.message.message-user > .message-body.markdown-body'),
    ).toBe(prose);
  });

  it('numbers multiple quote annotations in the float', async () => {
    const user = userEvent.setup();
    const text = `${formatQuoteMarkdown('first')}\n\nmid\n\n${formatQuoteMarkdown('second')}`;
    render(<UserMessageText text={text} cacheKey="user:multi" />);

    expect(screen.getByRole('button', { name: '2 annotations' })).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: '2 annotations' }));
    expect(await screen.findByText('1. Selected text:')).toBeInTheDocument();
    expect(screen.getByText('2. Selected text:')).toBeInTheDocument();
    expect(screen.getByText('first')).toBeInTheDocument();
    expect(screen.getByText('second')).toBeInTheDocument();
  });

  it('falls back to LongTextMessage for long pastes without quotes', () => {
    const text = Array.from({ length: 80 }, (_, i) => `line ${i}`).join('\n');
    const { container } = render(<UserMessageText text={text} cacheKey="user:long" />);
    expect(container.querySelector('.long-text-pill')).not.toBeNull();
    expect(screen.queryByRole('button', { name: /annotation/ })).not.toBeInTheDocument();
  });
});
