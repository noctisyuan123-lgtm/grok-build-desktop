/** Billing-window pace: remaining quota vs remaining time on the same 0–100 scale. */

export type ConsumptionPace = 'onTrack' | 'overPace' | 'unavailable';
export type QuotaAttentionLevel = 'normal' | 'warning' | 'critical';
/** Fill color for remaining quota: yellow while healthy, then orange / red. */
export type QuotaFillTone = 'yellow' | 'orange' | 'red';

export const QUOTA_FILL_THRESHOLDS = {
  orange: 30,
  red: 10,
} as const;

export type QuotaWindowInput = {
  usedPercent: number;
  periodStart: string | number | Date | null | undefined;
  periodEnd: string | number | Date | null | undefined;
};

const CRITICAL_REMAINING = 20;

export function clampPercent(value: number): number {
  if (!Number.isFinite(value) || value < 0) return 0;
  if (value > 100) return 100;
  return value;
}

/** Remaining quota as a 0–100 integer. Missing/non-finite used percent is 0% used. */
export function remainingPercent(usedPercent: number | null | undefined): number {
  const used = typeof usedPercent === 'number' && Number.isFinite(usedPercent) ? usedPercent : 0;
  return Math.round(clampPercent(100 - used));
}

export function parseTimestamp(value: string | number | Date | null | undefined): number | null {
  if (value == null || value === '') return null;
  if (value instanceof Date) {
    const ms = value.getTime();
    return Number.isFinite(ms) ? ms : null;
  }
  if (typeof value === 'number') {
    return Number.isFinite(value) ? value : null;
  }
  const ms = Date.parse(value);
  return Number.isNaN(ms) ? null : ms;
}

/**
 * Remaining fraction of the billing window. Missing or expired bounds stay
 * unknown — never guess a duration.
 */
export function remainingTimePercent(window: QuotaWindowInput, now: number): number | null {
  const start = parseTimestamp(window.periodStart);
  const end = parseTimestamp(window.periodEnd);
  if (start == null || end == null) return null;
  const duration = end - start;
  if (duration <= 0) return null;
  const remainingMs = end - now;
  if (remainingMs < 0) return null;
  return clampPercent((remainingMs / duration) * 100);
}

/** Quota lasting at least as long as displayed remaining time is on pace. */
export function consumptionPace(window: QuotaWindowInput, now: number): ConsumptionPace {
  const remainingTime = remainingTimePercent(window, now);
  if (remainingTime == null) return 'unavailable';
  // Compare integer percents so pace matches the two meters (68% vs 92%),
  // not a 0.4% float remainder that still renders as the same whole number.
  return remainingPercent(window.usedPercent) >= Math.round(remainingTime) ? 'onTrack' : 'overPace';
}

export function paceDelta(window: QuotaWindowInput, now: number): number | null {
  const remainingTime = remainingTimePercent(window, now);
  if (remainingTime == null) return null;
  return remainingPercent(window.usedPercent) - Math.round(remainingTime);
}

/** Remaining-quota color: yellow until 30%, orange until 10%, then red. */
export function quotaFillTone(remaining: number): QuotaFillTone {
  if (remaining <= QUOTA_FILL_THRESHOLDS.red) return 'red';
  if (remaining <= QUOTA_FILL_THRESHOLDS.orange) return 'orange';
  return 'yellow';
}

/** Low remaining quota is more urgent than a pacing warning. */
export function attentionLevel(
  window: QuotaWindowInput,
  now: number,
  criticalBelow = CRITICAL_REMAINING,
): QuotaAttentionLevel {
  if (remainingPercent(window.usedPercent) < criticalBelow) return 'critical';
  return consumptionPace(window, now) === 'overPace' ? 'warning' : 'normal';
}

export function cycleLengthDays(
  periodStart: string | number | Date | null | undefined,
  periodEnd: string | number | Date | null | undefined,
): number | null {
  const start = parseTimestamp(periodStart);
  const end = parseTimestamp(periodEnd);
  if (start == null || end == null || end <= start) return null;
  return Math.max(1, Math.round((end - start) / 86_400_000));
}
