import { describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MessageActions } from '../MessageActions';
import { t } from '../../i18n';

describe('MessageActions', () => {
  it('copies the original Markdown source and announces success', async () => {
    const user = userEvent.setup();
    const writeText = vi.spyOn(navigator.clipboard, 'writeText').mockResolvedValue();
    render(<MessageActions sourceText={'## Heading\n\n**bold**'} canUndo={false} />);

    await user.click(screen.getByRole('button', { name: t('message.copy') }));

    expect(writeText).toHaveBeenCalledWith('## Heading\n\n**bold**');
    expect(await screen.findByRole('button', { name: t('message.copied') })).toBeInTheDocument();
  });

  it('only invokes an enabled undo action', async () => {
    const user = userEvent.setup();
    const onUndo = vi.fn();
    const { rerender } = render(
      <MessageActions sourceText="answer" canUndo={false} onUndo={onUndo} />,
    );

    await user.click(screen.getByRole('button', { name: t('message.undoResponse') }));
    expect(onUndo).not.toHaveBeenCalled();

    rerender(<MessageActions sourceText="answer" canUndo onUndo={onUndo} />);
    await user.click(screen.getByRole('button', { name: t('message.undoResponse') }));
    expect(onUndo).toHaveBeenCalledTimes(1);
  });

  it('can hide response copy until the response is complete', () => {
    render(
      <MessageActions
        sourceText="streaming answer"
        canUndo={false}
        showCopy={false}
        showUndo={false}
      />,
    );

    expect(screen.queryByRole('button', { name: t('message.copy') })).not.toBeInTheDocument();
  });

  it('invokes an enabled fork action and keeps it disabled for incomplete responses', async () => {
    const user = userEvent.setup();
    const onFork = vi.fn();
    const { rerender } = render(
      <MessageActions
        sourceText="answer"
        canUndo={false}
        canFork={false}
        showFork
        onFork={onFork}
      />,
    );

    await user.click(screen.getByRole('button', { name: t('message.fork') }));
    expect(onFork).not.toHaveBeenCalled();

    rerender(
      <MessageActions sourceText="answer" canUndo={false} canFork showFork onFork={onFork} />,
    );
    await user.click(screen.getByRole('button', { name: t('message.fork') }));
    expect(onFork).toHaveBeenCalledTimes(1);
  });
});
