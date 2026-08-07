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
});
