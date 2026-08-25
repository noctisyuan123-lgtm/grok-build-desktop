import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const tauri = vi.hoisted(() => ({ invoke: vi.fn<() => Promise<void>>() }));

vi.mock('@tauri-apps/api/core', () => ({
  invoke: tauri.invoke,
}));

import { showCompletionPopup } from '../completionPopup';

beforeEach(() => {
  vi.clearAllMocks();
  Object.defineProperty(window, '__TAURI_INTERNALS__', { configurable: true, value: {} });
});

afterEach(() => {
  delete (window as Window & { __TAURI_INTERNALS__?: unknown }).__TAURI_INTERNALS__;
});

describe('showCompletionPopup', () => {
  it('opens the app-owned completion window for every completion', async () => {
    tauri.invoke.mockResolvedValue();

    await showCompletionPopup();

    expect(tauri.invoke).toHaveBeenCalledWith('show_completion_popup');
  });
});
