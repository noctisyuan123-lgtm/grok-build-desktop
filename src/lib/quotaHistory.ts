import { storageKeys } from '../app/constants';
import { clampPercent, parseTimestamp, remainingPercent } from './quotaPace';

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

/** Same cadence as the desktop SQLite sampler. */
export const BILLING_ANCHOR_MS = 15 * 60 * 1000;
export const BILLING_RETENTION_MS = 90 * 24 * 60 * 60 * 1000;

/** True when two CLI period-start strings name the same instant. */
export function sameBillingPeriod(
  a: string | null | undefined,
  b: string | null | undefined,
): boolean {
  if (a == null || a === '' || b == null || b === '') return a === b;
  if (a === b) return true;
  const left = parseTimestamp(a);
  const right = parseTimestamp(b);
  return left != null && right != null && left === right;
}

/**
 * Current billing cycle for the sparkline: a synthetic 100% at period start
 * (the reset), recorded remaining samples, a live tip at `now` while the
 * cycle is open, and a linear 100→0 ideal burn line.
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

  const samples = input.snapshots
    .filter((sample) => sameBillingPeriod(sample.periodStart, input.periodStart))
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
    const live = clampPercent(input.remainingPercent);
    const last = actual[actual.length - 1];
    if (last.synthetic || input.now > last.t + 1000) {
      if (input.now > last.t) actual.push({ t: input.now, remaining: live });
      else last.remaining = live;
    } else {
      last.remaining = live;
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

function latestSnapshot(store: readonly BillingSnapshot[]): BillingSnapshot | null {
  return store.reduce<BillingSnapshot | null>((latest, row) => {
    if (!latest || row.sampledAt > latest.sampledAt) return row;
    return latest;
  }, null);
}

function shouldRecordSnapshot(
  previous: BillingSnapshot | null,
  next: BillingSnapshot,
): boolean {
  if (!previous) return true;
  if (!sameBillingPeriod(previous.periodStart, next.periodStart)) return true;
  if (previous.remainingPercent !== next.remainingPercent) return true;
  return next.sampledAt - previous.sampledAt >= BILLING_ANCHOR_MS;
}

/** Append a sample using the desktop rule: change, new cycle, or 15-minute anchor. */
export function appendBillingSnapshot(
  store: readonly BillingSnapshot[],
  sample: BillingSnapshot,
): BillingSnapshot[] {
  const next: BillingSnapshot = {
    ...sample,
    remainingPercent: Math.round(clampPercent(sample.remainingPercent)),
  };
  const pruned = store.filter((row) => row.sampledAt >= next.sampledAt - BILLING_RETENTION_MS);
  if (!shouldRecordSnapshot(latestSnapshot(pruned), next)) return pruned;
  return [...pruned, next];
}

export function snapshotsForPeriod(
  store: readonly BillingSnapshot[],
  periodStart: string | null | undefined,
): BillingSnapshot[] {
  return store
    .filter((row) => sameBillingPeriod(row.periodStart, periodStart))
    .sort((a, b) => a.sampledAt - b.sampledAt);
}

function readWebStore(): BillingSnapshot[] {
  try {
    const raw = window.localStorage.getItem(storageKeys.billingSnapshots);
    if (!raw) return [];
    const parsed = JSON.parse(raw) as unknown;
    if (!Array.isArray(parsed)) return [];
    return parsed.filter(isSnapshot);
  } catch {
    return [];
  }
}

function writeWebStore(rows: readonly BillingSnapshot[]): void {
  try {
    window.localStorage.setItem(storageKeys.billingSnapshots, JSON.stringify(rows));
  } catch {
    // quota — chart degrades to the live tip
  }
}

function isSnapshot(value: unknown): value is BillingSnapshot {
  if (!value || typeof value !== 'object') return false;
  const row = value as BillingSnapshot;
  return (
    typeof row.sampledAt === 'number' &&
    Number.isFinite(row.sampledAt) &&
    typeof row.remainingPercent === 'number'
  );
}

/** Vite / browser path: persist samples so Quota History is not a 2-point fiction. */
export function persistWebBillingSnapshot(input: {
  creditUsagePercent: number | null | undefined;
  periodStart: string | null | undefined;
  periodEnd: string | null | undefined;
  now?: number;
}): BillingSnapshot[] {
  const now = input.now ?? Date.now();
  const sample: BillingSnapshot = {
    sampledAt: now,
    remainingPercent: remainingPercent(input.creditUsagePercent),
    periodStart: input.periodStart ?? null,
    periodEnd: input.periodEnd ?? null,
  };
  const nextStore = appendBillingSnapshot(readWebStore(), sample);
  writeWebStore(nextStore);
  return snapshotsForPeriod(nextStore, sample.periodStart);
}
