import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, renderHook } from '@testing-library/react';
import { applyStateChange, streamStore } from '../../lib/streamStore';
import { GIVE_UP_MS } from '../../lib/connectionHealth';
import { useNetworkWatchdog } from '../useNetworkWatchdog';

beforeEach(() => {
  streamStore.__reset();
  vi.useFakeTimers();
  vi.setSystemTime(1_000_000);
});

afterEach(() => {
  vi.useRealTimers();
});

describe('useNetworkWatchdog', () => {
  it('fails a silent in-flight run after the give-up window', () => {
    applyStateChange('hung', { state: 'Running', startedAt: 1_000_000 });
    streamStore.setQueue({ active: 'hung', activeIds: ['hung'], items: [] });
    const cancelRun = vi.fn(async () => true);
    renderHook(() => useNetworkWatchdog(true, cancelRun));
    act(() => {
      vi.setSystemTime(1_000_000 + GIVE_UP_MS);
      vi.advanceTimersByTime(1_000);
    });
    expect(streamStore.getRunSnapshot('hung')?.state).toBe('failed');
    expect(streamStore.getRunSnapshot('hung')?.error).toMatch(/Disconnected/);
    expect(cancelRun).toHaveBeenCalledWith('hung');
  });
});
