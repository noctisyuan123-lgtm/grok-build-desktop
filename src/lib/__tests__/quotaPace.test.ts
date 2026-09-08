import { describe, expect, it } from 'vitest';
import {
  attentionLevel,
  clampPercent,
  consumptionPace,
  cycleLengthDays,
  paceDelta,
  parseTimestamp,
  quotaFillTone,
  remainingPercent,
  remainingTimePercent,
} from '../quotaPace';

const NOW = Date.parse('2027-01-15T00:00:00.000Z');
const HOUR = 60 * 60 * 1000;

function windowAt(used: number, elapsedFraction: number, durationMs = 100 * 60 * 1000) {
  return {
    usedPercent: used,
    periodStart: NOW - elapsedFraction * durationMs,
    periodEnd: NOW + (1 - elapsedFraction) * durationMs,
  };
}

describe('remainingPercent', () => {
  it('clamps remaining quota to 0–100', () => {
    expect(remainingPercent(-10)).toBe(100);
    expect(remainingPercent(40)).toBe(60);
    expect(remainingPercent(140)).toBe(0);
  });

  it('treats missing used percent as 0% used', () => {
    expect(remainingPercent(null)).toBe(100);
    expect(remainingPercent(undefined)).toBe(100);
    expect(remainingPercent(Number.NaN)).toBe(100);
  });
});

describe('remainingTimePercent', () => {
  it('is 50% halfway through the window', () => {
    const window = windowAt(50, 0.5);
    expect(remainingTimePercent(window, NOW)).toBeCloseTo(50, 5);
    expect(consumptionPace(window, NOW)).toBe('onTrack');
    expect(paceDelta(window, NOW)).toBeCloseTo(0, 5);
  });

  it('does not guess when reset bounds are missing', () => {
    expect(
      remainingTimePercent({ usedPercent: 20, periodStart: null, periodEnd: NOW + HOUR }, NOW),
    ).toBeNull();
    expect(
      remainingTimePercent({ usedPercent: 20, periodStart: NOW - HOUR, periodEnd: null }, NOW),
    ).toBeNull();
    expect(
      consumptionPace({ usedPercent: 20, periodStart: null, periodEnd: NOW + HOUR }, NOW),
    ).toBe('unavailable');
  });

  it('does not guess after the window has expired', () => {
    const window = {
      usedPercent: 20,
      periodStart: NOW - 2 * HOUR,
      periodEnd: NOW - 1,
    };
    expect(remainingTimePercent(window, NOW)).toBeNull();
    expect(consumptionPace(window, NOW)).toBe('unavailable');
  });

  it('clamps remaining time at 100% when now is before period start', () => {
    const sevenDays = 7 * 24 * HOUR;
    const window = {
      usedPercent: 0,
      periodStart: NOW + sevenDays * 0.5,
      periodEnd: NOW + sevenDays * 1.5,
    };
    expect(remainingTimePercent(window, NOW)).toBeCloseTo(100, 5);
  });
});

describe('consumptionPace', () => {
  it('is over pace when remaining quota is below remaining time', () => {
    const window = windowAt(60, 0.5);
    expect(remainingPercent(window.usedPercent)).toBe(40);
    expect(consumptionPace(window, NOW)).toBe('overPace');
  });

  it('is on track when remaining quota lasts at least as long as remaining time', () => {
    const window = windowAt(40, 0.5);
    expect(remainingPercent(window.usedPercent)).toBe(60);
    expect(consumptionPace(window, NOW)).toBe('onTrack');
  });

  it('treats equal displayed percents as on track', () => {
    const window = windowAt(5, 0.054);
    expect(remainingPercent(5)).toBe(95);
    expect(Math.round(remainingTimePercent(window, NOW) ?? 0)).toBe(95);
    expect(consumptionPace(window, NOW)).toBe('onTrack');
  });
});

describe('attentionLevel', () => {
  it('warns when usage is above pace', () => {
    const window = windowAt(60, 0.5);
    expect(attentionLevel(window, NOW)).toBe('warning');
  });

  it('prioritizes critical quota below 20% remaining', () => {
    const window = windowAt(81, 0.9);
    expect(remainingPercent(81)).toBe(19);
    expect(attentionLevel(window, NOW)).toBe('critical');
  });

  it('does not treat 20% remaining as critical', () => {
    const window = windowAt(80, 0.9);
    expect(remainingPercent(80)).toBe(20);
    expect(attentionLevel(window, NOW)).not.toBe('critical');
  });
});

describe('quotaFillTone', () => {
  it('stays yellow above 30% remaining', () => {
    expect(quotaFillTone(100)).toBe('yellow');
    expect(quotaFillTone(31)).toBe('yellow');
  });

  it('turns orange at 30% remaining and below', () => {
    expect(quotaFillTone(30)).toBe('orange');
    expect(quotaFillTone(11)).toBe('orange');
  });

  it('turns red at 10% remaining and below', () => {
    expect(quotaFillTone(10)).toBe('red');
    expect(quotaFillTone(0)).toBe('red');
  });
});

describe('parseTimestamp / cycleLengthDays', () => {
  it('parses ISO strings and rejects junk', () => {
    expect(parseTimestamp('2026-09-01T00:00:00.000Z')).toBe(Date.parse('2026-09-01T00:00:00.000Z'));
    expect(parseTimestamp('not-a-date')).toBeNull();
    expect(parseTimestamp(NOW)).toBe(NOW);
  });

  it('rounds a 7-day billing window to 7 days', () => {
    expect(cycleLengthDays('2026-08-25T09:58:55.164Z', '2026-09-01T09:58:55.164Z')).toBe(7);
  });

  it('clamps non-finite percents to 0', () => {
    expect(clampPercent(Number.NaN)).toBe(0);
    expect(clampPercent(Infinity)).toBe(0);
  });
});
