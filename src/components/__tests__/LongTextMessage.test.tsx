import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it } from 'vitest';
import { LongTextMessage } from '../LongTextMessage';
import { isLongUserText } from '../../lib/longText';

describe('LongTextMessage', () => {
  it('only collapses genuinely long pasted text', () => {
    expect(isLongUserText('short message')).toBe(false);
    expect(isLongUserText('line\n'.repeat(10))).toBe(true);
    expect(isLongUserText('x'.repeat(800))).toBe(true);
  });

  it('opens the complete text in a line-numbered dialog and closes with Escape', async () => {
    const user = userEvent.setup();
    const text = ['Last login: Mon Aug 10 21:59:37 on ttys000', 'second line', 'third line'].join(
      '\n',
    );
    render(<LongTextMessage text={text} />);

    expect(screen.getByText('Last login: Mon Aug 10 21:59:37 on ttys000')).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Open pasted text' }));

    expect(screen.getByRole('dialog', { name: 'Pasted text preview' })).toBeInTheDocument();
    expect(screen.getByText('3 lines')).toBeInTheDocument();
    expect(document.querySelector('.long-text-content')?.textContent).toBe(text);

    await user.keyboard('{Escape}');
    expect(screen.queryByRole('dialog', { name: 'Pasted text preview' })).not.toBeInTheDocument();
  });
});
