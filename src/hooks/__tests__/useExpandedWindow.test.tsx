import { act, renderHook, waitFor } from '@testing-library/react';
import { beforeEach, expect, it, vi } from 'vitest';
import { useExpandedWindow } from '../useExpandedWindow';
const win = vi.hoisted(() => ({
  isMaximized: vi.fn(),
  isFullscreen: vi.fn(),
  onResized: vi.fn(),
  cleanup: vi.fn(),
}));
vi.mock('../../lib/runtime', () => ({ hasTauriRuntime: () => true }));
vi.mock('@tauri-apps/api/window', () => ({ getCurrentWindow: () => win }));
beforeEach(() => {
  vi.clearAllMocks();
  win.isMaximized.mockResolvedValue(false);
  win.isFullscreen.mockResolvedValue(false);
  win.onResized.mockResolvedValue(win.cleanup);
});
it('tracks maximize, restore and fullscreen from native window state', async () => {
  const { result, unmount } = renderHook(useExpandedWindow);
  await waitFor(() => expect(win.isMaximized).toHaveBeenCalled());
  expect(result.current).toBe(false);
  win.isMaximized.mockResolvedValue(true);
  await act(async () => win.onResized.mock.calls[0]![0]());
  expect(result.current).toBe(true);
  win.isMaximized.mockResolvedValue(false);
  await act(async () => win.onResized.mock.calls[0]![0]());
  expect(result.current).toBe(false);
  win.isFullscreen.mockResolvedValue(true);
  await act(async () => win.onResized.mock.calls[0]![0]());
  expect(result.current).toBe(true);
  unmount();
  expect(win.cleanup).toHaveBeenCalledOnce();
});
