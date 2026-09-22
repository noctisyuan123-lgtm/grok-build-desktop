// Empty landing must not reserve the Agents & Tasks column (Codex-style full width).
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { VirtuosoMockContext } from 'react-virtuoso';
import App from '../App';
import { detachTauriListeners, streamStore } from '../lib/streamStore';
import { t } from '../i18n';
import { installTauriAppMock, type TauriAppMock } from '../test/tauriAppMock';

vi.mock('../hooks/useExpandedWindow', () => ({
  useExpandedWindow: () => true,
}));

class ResizeObserverStub {
  observe() {}
  unobserve() {}
  disconnect() {}
}

beforeEach(() => {
  if (typeof window.ResizeObserver === 'undefined') {
    vi.stubGlobal('ResizeObserver', ResizeObserverStub);
  }
  Element.prototype.scrollIntoView = vi.fn();
});

function convo() {
  return within(document.querySelector('.conversation-panel') as HTMLElement);
}

function composerTextarea(): HTMLTextAreaElement {
  return convo().getByRole('textbox') as HTMLTextAreaElement;
}

describe('task rail empty landing', () => {
  it('omits Agents & Tasks and has-task-rail until messages exist', async () => {
    const tauri: TauriAppMock = installTauriAppMock();
    detachTauriListeners();
    streamStore.__reset();
    const user = userEvent.setup();
    const view = render(
      <VirtuosoMockContext.Provider value={{ viewportHeight: 800, itemHeight: 64 }}>
        <App />
      </VirtuosoMockContext.Provider>,
    );

    expect(
      await screen.findByRole('button', { name: t('emptyState.workspaceAria') }),
    ).toBeInTheDocument();
    await waitFor(() => expect(tauri.commands()).toContain('get_grok_auth_status'));

    const shell = view.container.querySelector('main.app-shell')!;
    const panel = document.querySelector('.conversation-panel')!;
    expect(panel.className).toContain('is-empty');
    expect(shell.className).not.toContain('has-task-rail');
    expect(screen.queryByRole('complementary', { name: 'Agents & Tasks' })).toBeNull();
    expect(panel.querySelector('.subagent-rail')).toBeNull();

    const before = tauri.runIds.length;
    const textarea = composerTextarea();
    await user.clear(textarea);
    await user.type(textarea, 'hello rail');
    await user.keyboard('{Enter}');
    await waitFor(() => expect(tauri.runIds.length).toBeGreaterThan(before));

    await waitFor(() => {
      expect(document.querySelector('.conversation-panel')!.className).not.toContain('is-empty');
      expect(shell.className).toContain('has-task-rail');
      expect(screen.getByRole('complementary', { name: 'Agents & Tasks' })).toBeInTheDocument();
    });
  });
});
