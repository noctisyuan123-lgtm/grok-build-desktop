import { describe, expect, it } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { emit } from '@tauri-apps/api/event';
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

  it('passes the banner tab id through to open_completion_session', async () => {
    const tauri = installTauriAppMock();
    const user = userEvent.setup();
    render(<CompletionPopup />);

    await emit('grok-desktop://completion-popup', 'tab-9');
    await user.click(screen.getByRole('button', { name: 'Open completed session' }));

    expect(
      tauri.calls.find((call) => call.cmd === 'open_completion_session')?.args,
    ).toEqual({ tabId: 'tab-9' });
  });
});
