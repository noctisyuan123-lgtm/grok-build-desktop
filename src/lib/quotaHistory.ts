import { clampPercent, parseTimestamp } from './quotaPace';

export type BillingSnapshot = {
  sampledAt: number;
  remainingPercent: number;
  periodStart: string | null;
  periodEnd: string | null;
};

export type QuotaChartPoint = {
  t: number;
  remaining: number;
  synthetic?: boolean;
};

export type QuotaCycleChart = {
  start: number;
  end: number;
  actual: QuotaChartPoint[];
  ideal: QuotaChartPoint[];
};

/**
 * Current billing cycle for the sparkline: a synthetic 100% at period start,
 * recorded remaining samples, a live tip at `now` while the cycle is open,
 * and a linear 100→0 ideal burn line.
 */
export function buildCurrentCycleChart(input: {
  snapshots: readonly BillingSnapshot[];
  periodStart: string | null | undefined;
  periodEnd: string | null | undefined;
  remainingPercent: number;
  now: number;
}): QuotaCycleChart | null {
  const start = parseTimestamp(input.periodStart);
  const end = parseTimestamp(input.periodEnd);
  if (start == null || end == null || end <= start) return null;

  const periodStart = input.periodStart ?? null;
  const samples = input.snapshots
    .filter((sample) => sample.periodStart === periodStart)
    .filter((sample) => sample.sampledAt >= start && sample.sampledAt <= end)
    .sort((a, b) => a.sampledAt - b.sampledAt)
    .map((sample) => ({
      t: sample.sampledAt,
      remaining: clampPercent(sample.remainingPercent),
    }));

  const actual: QuotaChartPoint[] = [{ t: start, remaining: 100, synthetic: true }];
  for (const sample of samples) {
    if (sample.t > start) actual.push(sample);
  }

  if (input.now >= start && input.now <= end) {
    const last = actual[actual.length - 1];
    if (input.now > last.t + 1000) {
      actual.push({
        t: input.now,
        remaining: clampPercent(input.remainingPercent),
      });
    }
  }

  return {
    start,
    end,
    actual,
    ideal: [
      { t: start, remaining: 100 },
      { t: end, remaining: 0 },
    ],
  };
}

export function chartPoint(
  t: number,
  remaining: number,
  start: number,
  end: number,
  width: number,
  height: number,
): {
  x: number;
  y: number;
} {
  const span = Math.max(1, end - start);
  return {
    x: ((t - start) / span) * width,
    y: (1 - clampPercent(remaining) / 100) * height,
  };
}
