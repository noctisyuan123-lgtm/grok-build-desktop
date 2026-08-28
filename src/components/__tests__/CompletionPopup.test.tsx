import { describe, expect, it } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { CompletionPopup } from '../CompletionPopup';
import { installTauriAppMock } from '../../test/tauriAppMock';

describe('CompletionPopup', () => {
  it('opens the completed session on click even before a tab id event arrives', async () => {
    const tauri = installTauriAppMock();
    const user = userEvent.setup();
    render(<CompletionPopup />);

    await user.click(screen.getByRole('button', { name: 'Open completed session' }));

    expect(tauri.commands()).toContain('open_completion_session');
  });
});
