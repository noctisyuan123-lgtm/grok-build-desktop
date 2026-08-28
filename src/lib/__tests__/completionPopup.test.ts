import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const tauri = vi.hoisted(() => ({ invoke: vi.fn<() => Promise<void>>() }));

vi.mock('@tauri-apps/api/core', () => ({
  invoke: tauri.invoke,
}));

import { showCompletionPopup, tabIdFromPayload } from '../completionPopup';

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

    await showCompletionPopup('tab-1');

    expect(tauri.invoke).toHaveBeenCalledWith('show_completion_popup', { tabId: 'tab-1' });
  });
});

describe('tabIdFromPayload', () => {
  it('reads a bare string or { tabId } object', () => {
    expect(tabIdFromPayload('tab-1')).toBe('tab-1');
    expect(tabIdFromPayload({ tabId: 'tab-2' })).toBe('tab-2');
    expect(tabIdFromPayload({})).toBeNull();
    expect(tabIdFromPayload('')).toBeNull();
    expect(tabIdFromPayload(null)).toBeNull();
  });
});
