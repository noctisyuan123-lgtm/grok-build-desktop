import { describe, expect, it } from 'vitest';
import {
  GIVE_UP_MS,
  GIVE_UP_TOOL_MS,
  STALL_MS,
  STALL_TOOL_MS,
  deriveConnection,
  isNetworkFailure,
  shouldGiveUp,
  silenceMs,
} from '../connectionHealth';

describe('connectionHealth', () => {
  it('computes silence from lastEventAt, then startedAt', () => {
    expect(silenceMs(20_000, 5_000, 1_000)).toBe(15_000);
    expect(silenceMs(20_000, null, 8_000)).toBe(12_000);
    expect(silenceMs(20_000, null, null)).toBe(0);
  });

  it('stays ok until T1, then stalled; tools use a longer T1', () => {
    const base = {
      now: 30_000,
      online: true,
      inFlight: true,
      startedAt: 1_000,
      lastEventAt: 1_000,
    };
    expect(deriveConnection({ ...base, lastEventAt: 30_000 - STALL_MS + 1 })).toBe('ok');
    expect(deriveConnection({ ...base, lastEventAt: 30_000 - STALL_MS })).toBe('stalled');
    expect(
      deriveConnection({
        ...base,
        hasRunningTool: true,
        lastEventAt: 30_000 - STALL_MS,
      }),
    ).toBe('ok');
    expect(
      deriveConnection({
        ...base,
        hasRunningTool: true,
        lastEventAt: 30_000 - STALL_TOOL_MS,
      }),
    ).toBe('stalled');
  });

  it('marks disconnected when the device is offline and reconnecting when a retry is in flight', () => {
    expect(
      deriveConnection({
        now: 10,
        online: false,
        inFlight: true,
        startedAt: 1,
        lastEventAt: 1,
      }),
    ).toBe('disconnected');
    expect(
      deriveConnection({
        now: 10,
        online: true,
        inFlight: true,
        startedAt: 1,
        lastEventAt: 1,
        retryAttempt: 2,
      }),
    ).toBe('reconnecting');
    expect(
      deriveConnection({
        now: 10,
        online: true,
        inFlight: false,
        startedAt: 1,
        lastEventAt: 1,
      }),
    ).toBe('ok');
  });

  it('does not give up while offline, and uses a longer window during a tool', () => {
    const base = {
      now: 200_000,
      inFlight: true,
      startedAt: 1_000,
      lastEventAt: 1_000,
    };
    expect(shouldGiveUp({ ...base, online: false })).toBe(false);
    expect(shouldGiveUp({ ...base, online: true, lastEventAt: 200_000 - GIVE_UP_MS + 1 })).toBe(
      false,
    );
    expect(shouldGiveUp({ ...base, online: true, lastEventAt: 200_000 - GIVE_UP_MS })).toBe(true);
    expect(
      shouldGiveUp({
        ...base,
        online: true,
        hasRunningTool: true,
        lastEventAt: 200_000 - GIVE_UP_MS,
      }),
    ).toBe(false);
    expect(
      shouldGiveUp({
        ...base,
        online: true,
        hasRunningTool: true,
        lastEventAt: 200_000 - GIVE_UP_TOOL_MS,
      }),
    ).toBe(true);
  });

  it('classifies network-ish errors and ignores crashes', () => {
    expect(isNetworkFailure('ECONNRESET')).toBe(true);
    expect(isNetworkFailure('Disconnected from the model')).toBe(true);
    expect(isNetworkFailure('grok exited with code 1 — panic')).toBe(false);
    expect(isNetworkFailure(null)).toBe(false);
  });
});
