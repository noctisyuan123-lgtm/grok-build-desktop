import { describe, expect, it } from 'vitest';
import { buildCurrentCycleChart, chartPoint } from '../quotaHistory';

const START = Date.parse('2026-09-08T00:06:00.000Z');
const END = Date.parse('2026-09-15T00:06:00.000Z');
const PERIOD_START = '2026-09-08T00:06:00.000Z';
const PERIOD_END = '2026-09-15T00:06:00.000Z';

describe('buildCurrentCycleChart', () => {
  it('returns null without a usable period', () => {
    expect(
      buildCurrentCycleChart({
        snapshots: [],
        periodStart: null,
        periodEnd: PERIOD_END,
        remainingPercent: 68,
        now: START + 1000,
      }),
    ).toBeNull();
  });

  it('starts at 100% and draws a linear 100→0 ideal line', () => {
    const now = START + 12 * 60 * 60 * 1000;
    const chart = buildCurrentCycleChart({
      snapshots: [],
      periodStart: PERIOD_START,
      periodEnd: PERIOD_END,
      remainingPercent: 68,
      now,
    });
    expect(chart).not.toBeNull();
    expect(chart!.ideal).toEqual([
      { t: START, remaining: 100 },
      { t: END, remaining: 0 },
    ]);
    expect(chart!.actual[0]).toEqual({ t: START, remaining: 100, synthetic: true });
    expect(chart!.actual.at(-1)).toEqual({ t: now, remaining: 68 });
  });

  it('keeps only samples from the current period and adds a live tip', () => {
    const now = START + 2 * 24 * 60 * 60 * 1000;
    const chart = buildCurrentCycleChart({
      snapshots: [
        {
          sampledAt: START - 60_000,
          remainingPercent: 12,
          periodStart: '2026-09-01T00:06:00.000Z',
          periodEnd: PERIOD_START,
        },
        {
          sampledAt: START + 60_000,
          remainingPercent: 90,
          periodStart: PERIOD_START,
          periodEnd: PERIOD_END,
        },
        {
          sampledAt: START + 3_600_000,
          remainingPercent: 80,
          periodStart: PERIOD_START,
          periodEnd: PERIOD_END,
        },
      ],
      periodStart: PERIOD_START,
      periodEnd: PERIOD_END,
      remainingPercent: 68,
      now,
    });
    expect(chart!.actual.map((p) => p.remaining)).toEqual([100, 90, 80, 68]);
  });

  it('does not add a live tip after the cycle ends', () => {
    const chart = buildCurrentCycleChart({
      snapshots: [
        {
          sampledAt: START + 60_000,
          remainingPercent: 40,
          periodStart: PERIOD_START,
          periodEnd: PERIOD_END,
        },
      ],
      periodStart: PERIOD_START,
      periodEnd: PERIOD_END,
      remainingPercent: 10,
      now: END + 60_000,
    });
    expect(chart!.actual.at(-1)).toEqual({ t: START + 60_000, remaining: 40 });
  });
});

describe('chartPoint', () => {
  it('maps remaining 100 to the top and 0 to the bottom', () => {
    expect(chartPoint(START, 100, START, END, 100, 50)).toEqual({ x: 0, y: 0 });
    expect(chartPoint(END, 0, START, END, 100, 50)).toEqual({ x: 100, y: 50 });
  });
});
