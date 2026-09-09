import { useEffect, useState } from 'react';
import { CircleCheck, CircleHelp, TriangleAlert } from 'lucide-react';
import { formatRemainingDuration, formatUsdAmount, formatUsageReset } from '../app/format';
import { t } from '../i18n';
import { formatPercent } from '../lib/contextMetrics';
import {
  consumptionPace,
  cycleLengthDays,
  parseTimestamp,
  quotaFillTone,
  remainingPercent,
  remainingTimePercent,
  type ConsumptionPace,
  type QuotaFillTone,
} from '../lib/quotaPace';
import {
  buildCurrentCycleChart,
  chartPoint,
  type BillingSnapshot,
  type QuotaChartPoint,
  type QuotaCycleChart,
} from '../lib/quotaHistory';

export type { BillingSnapshot };

export type CliUsage = {
  ok: boolean;
  error: string | null;
  creditUsagePercent: number | null;
  periodType: string | null;
  periodStart: string | null;
  periodEnd: string | null;
  onDemandCap: number | null;
  onDemandUsed: number | null;
  prepaidBalance: number | null;
  unifiedBilling: boolean;
  subscriptionTier: string | null;
  snapshots?: BillingSnapshot[];
};

const SPARK_W = 320;
const SPARK_H = 92;
const SPARK_PAD_X = 6;
const SPARK_PAD_Y = 10;

const RING_SIZE = 118;
const RING_OUTER = 8;
const RING_INNER = 6;
const RING_GAP = 5;
const RING_CX = RING_SIZE / 2;
const OUTER_R = (RING_SIZE - RING_OUTER) / 2;
const INNER_R = OUTER_R - RING_OUTER / 2 - RING_GAP - RING_INNER / 2;
const OUTER_CIRC = 2 * Math.PI * OUTER_R;
const INNER_CIRC = 2 * Math.PI * INNER_R;

function periodLabel(kind: string | null): string {
  if (kind === 'monthly') return t('settings.usagePeriodMonthly');
  if (kind === 'weekly') return t('settings.usagePeriodWeekly');
  return t('settings.usagePeriodUnknown');
}

function useNow(intervalMs = 60_000): number {
  const [, setTick] = useState(0);
  useEffect(() => {
    const id = window.setInterval(() => setTick((n) => n + 1), intervalMs);
    return () => window.clearInterval(id);
  }, [intervalMs]);
  return Date.now();
}

export function UsageMeter({
  usage,
  loading,
  onRefresh,
}: {
  usage: CliUsage | null;
  loading: boolean;
  onRefresh: () => void;
}) {
  const now = useNow();
  const ready = Boolean(usage?.ok);
  const used = ready ? (usage!.creditUsagePercent ?? 0) : 0;
  const remaining = remainingPercent(used);
  const window = {
    usedPercent: used,
    periodStart: usage?.periodStart ?? null,
    periodEnd: usage?.periodEnd ?? null,
  };
  const remainingTime = ready ? remainingTimePercent(window, now) : null;
  const pace = ready ? consumptionPace(window, now) : 'unavailable';
  const fillTone = quotaFillTone(remaining);
  const period = periodLabel(usage?.periodType ?? null);
  const snapshots = usage?.snapshots ?? [];
  const chart = ready
    ? buildCurrentCycleChart({
        snapshots,
        periodStart: usage!.periodStart,
        periodEnd: usage!.periodEnd,
        remainingPercent: remaining,
        now,
      })
    : null;

  return (
    <div className="set-cli-usage">
      <div className="set-cli-usage-toolbar">
        <p className="set-cli-usage-hint">{t('settings.usageHint')}</p>
        <button type="button" className="set-cli-refresh" onClick={onRefresh} disabled={loading}>
          {t('settings.usageRefresh')}
        </button>
      </div>

      {loading && !ready ? (
        <p className="set-cli-muted">{t('settings.usageLoading')}</p>
      ) : usage && !usage.ok ? (
        <p className="set-cli-muted">{usage.error || t('settings.usageError')}</p>
      ) : ready && usage ? (
        <>
          <QuotaCard
            usage={usage}
            period={period}
            remaining={remaining}
            remainingTime={remainingTime}
            pace={pace}
            fillTone={fillTone}
            now={now}
          />
          <QuotaHistory
            remaining={remaining}
            days={cycleLengthDays(usage.periodStart, usage.periodEnd)}
            chart={chart}
          />
        </>
      ) : (
        <p className="set-cli-muted">{t('settings.usageError')}</p>
      )}
    </div>
  );
}

function QuotaCard({
  usage,
  period,
  remaining,
  remainingTime,
  pace,
  fillTone,
  now,
}: {
  usage: CliUsage;
  period: string;
  remaining: number;
  remainingTime: number | null;
  pace: ConsumptionPace;
  fillTone: QuotaFillTone;
  now: number;
}) {
  const resetAt = formatUsageReset(usage.periodEnd);
  const resetMs = parseTimestamp(usage.periodEnd);
  const resetIn = resetMs != null && resetMs >= now ? formatRemainingDuration(resetMs - now) : null;
  const paygOn = (usage.onDemandCap ?? 0) > 0;
  const usedPct = `${Math.round(100 - remaining)}%`;

  return (
    <section className="set-quota-card">
      <header className="set-quota-head">
        <div>
          <h3 className="set-quota-title">{period}</h3>
          {usage.subscriptionTier ? (
            <div className="set-cli-tier">
              {t('settings.usageTier', { tier: usage.subscriptionTier })}
            </div>
          ) : null}
        </div>
        <PaceBadge pace={pace} />
      </header>

      <div className="set-quota-hero">
        <QuotaRings remaining={remaining} remainingTime={remainingTime} fillTone={fillTone} />
        <div className="set-quota-facts">
          <MetricStat
            kind="quota"
            fillTone={fillTone}
            kicker={t('settings.usageLegendQuota')}
            value={t('settings.usageQuotaUsed', { percent: usedPct })}
          />
          <MetricStat
            kind="time"
            kicker={t('settings.usageLegendWindow')}
            value={resetIn ?? '—'}
            hint={
              resetAt
                ? t('settings.usageResetsAt', { when: resetAt })
                : t('settings.usageResetUnavailable')
            }
          />
        </div>
      </div>

      {paygOn ? (
        <div className="set-cli-extra">
          {t('settings.usageOnDemand')}:{' '}
          {t('settings.usageOnDemandUsed', {
            used: formatUsdAmount(usage.onDemandUsed),
            cap: formatUsdAmount(usage.onDemandCap),
          })}
        </div>
      ) : (
        <div className="set-cli-extra">{t('settings.usageOnDemandOff')}</div>
      )}
      {(usage.prepaidBalance ?? 0) > 0 ? (
        <div className="set-cli-extra">
          {t('settings.usagePrepaid')}: {formatUsdAmount(usage.prepaidBalance)}
        </div>
      ) : null}
    </section>
  );
}

function PaceBadge({ pace }: { pace: ConsumptionPace }) {
  if (pace === 'onTrack') {
    return (
      <span className="set-quota-pace on-track">
        <CircleCheck size={14} strokeWidth={2} aria-hidden="true" />
        {t('settings.usagePaceOnTrack')}
      </span>
    );
  }
  if (pace === 'overPace') {
    return (
      <span className="set-quota-pace over-pace">
        <TriangleAlert size={14} strokeWidth={2} aria-hidden="true" />
        {t('settings.usagePaceOver')}
      </span>
    );
  }
  return (
    <span className="set-quota-pace unavailable">
      <CircleHelp size={14} strokeWidth={2} aria-hidden="true" />
      {t('settings.usagePaceUnavailable')}
    </span>
  );
}

function ringOffset(circumference: number, value: number | null): number {
  if (value == null) return circumference;
  return circumference * (1 - Math.max(0, Math.min(100, value)) / 100);
}

function QuotaRings({
  remaining,
  remainingTime,
  fillTone,
}: {
  remaining: number;
  remainingTime: number | null;
  fillTone: QuotaFillTone;
}) {
  const quotaPct = formatPercent(remaining);
  const timePct = remainingTime == null ? '—' : formatPercent(remainingTime);
  return (
    <div
      className={`set-quota-rings tone-${fillTone}`}
      role="img"
      aria-label={t('settings.usageAriaRings', { quota: quotaPct, time: timePct })}
    >
      <svg
        className="set-quota-rings-svg"
        width={RING_SIZE}
        height={RING_SIZE}
        viewBox={`0 0 ${RING_SIZE} ${RING_SIZE}`}
        aria-hidden="true"
      >
        <circle
          className="set-quota-ring-track outer"
          cx={RING_CX}
          cy={RING_CX}
          r={OUTER_R}
          fill="none"
          strokeWidth={RING_OUTER}
        />
        <circle
          className="set-quota-ring-fill outer"
          cx={RING_CX}
          cy={RING_CX}
          r={OUTER_R}
          fill="none"
          strokeWidth={RING_OUTER}
          strokeLinecap="round"
          strokeDasharray={OUTER_CIRC}
          strokeDashoffset={ringOffset(OUTER_CIRC, remaining)}
          transform={`rotate(-90 ${RING_CX} ${RING_CX})`}
        />
        <circle
          className="set-quota-ring-track inner"
          cx={RING_CX}
          cy={RING_CX}
          r={INNER_R}
          fill="none"
          strokeWidth={RING_INNER}
        />
        <circle
          className={`set-quota-ring-fill inner${remainingTime == null ? ' is-unknown' : ''}`}
          cx={RING_CX}
          cy={RING_CX}
          r={INNER_R}
          fill="none"
          strokeWidth={RING_INNER}
          strokeLinecap="round"
          strokeDasharray={INNER_CIRC}
          strokeDashoffset={ringOffset(INNER_CIRC, remainingTime)}
          transform={`rotate(-90 ${RING_CX} ${RING_CX})`}
        />
      </svg>
      <div className="set-quota-rings-center">
        <span className="set-quota-rings-pct">{quotaPct}</span>
        <span className="set-quota-rings-cap">{t('settings.usageRingCaption')}</span>
      </div>
    </div>
  );
}

function MetricStat({
  kind,
  fillTone,
  kicker,
  value,
  hint,
}: {
  kind: 'quota' | 'time';
  fillTone?: QuotaFillTone;
  kicker: string;
  value: string;
  hint?: string;
}) {
  const swatchClass =
    kind === 'quota'
      ? `set-quota-swatch quota tone-${fillTone ?? 'yellow'}`
      : 'set-quota-swatch time';
  return (
    <div className={`set-quota-stat ${kind}`}>
      <span className={swatchClass} aria-hidden="true" />
      <div className="set-quota-stat-copy">
        <div className="set-quota-stat-kicker">{kicker}</div>
        <div className="set-quota-stat-value">{value}</div>
        {hint ? <div className="set-quota-stat-hint">{hint}</div> : null}
      </div>
    </div>
  );
}

function QuotaHistory({
  remaining,
  days,
  chart,
}: {
  remaining: number;
  days: number | null;
  chart: QuotaCycleChart | null;
}) {
  return (
    <section className="set-quota-history">
      <header className="set-quota-history-head">
        <div>
          <h3 className="set-quota-title">{t('settings.usageHistoryTitle')}</h3>
          <p className="set-quota-history-sub">
            {days ? t('settings.usageHistoryCycle', { days }) : t('settings.usageHistoryEmpty')}
          </p>
        </div>
        <div className="set-quota-history-remain">
          <span className="set-quota-history-pct">{formatPercent(remaining)}</span>
          <span className="set-quota-history-cap">{t('settings.usageQuotaRemaining')}</span>
        </div>
      </header>
      {chart ? (
        <QuotaSparkline chart={chart} />
      ) : (
        <p className="set-cli-muted">{t('settings.usageHistoryEmpty')}</p>
      )}
    </section>
  );
}

function QuotaSparkline({ chart }: { chart: QuotaCycleChart }) {
  const innerW = SPARK_W - SPARK_PAD_X * 2;
  const innerH = SPARK_H - SPARK_PAD_Y * 2;
  const toXy = (point: QuotaChartPoint) => {
    const raw = chartPoint(point.t, point.remaining, chart.start, chart.end, innerW, innerH);
    return { x: raw.x + SPARK_PAD_X, y: raw.y + SPARK_PAD_Y };
  };
  const ideal = chart.ideal.map(toXy);
  const actual = chart.actual.map(toXy);
  const latest = actual[actual.length - 1];
  const idealD = `M ${ideal[0].x} ${ideal[0].y} L ${ideal[1].x} ${ideal[1].y}`;
  const actualLine = actual.map((p, i) => `${i === 0 ? 'M' : 'L'} ${p.x} ${p.y}`).join(' ');
  const areaD = `${actualLine} L ${latest.x} ${SPARK_H - SPARK_PAD_Y} L ${actual[0].x} ${SPARK_H - SPARK_PAD_Y} Z`;

  return (
    <svg
      className="set-quota-spark"
      viewBox={`0 0 ${SPARK_W} ${SPARK_H}`}
      role="img"
      aria-label={t('settings.usageAriaHistory')}
    >
      <path className="set-quota-spark-area" d={areaD} />
      <path className="set-quota-spark-ideal" d={idealD} />
      <path className="set-quota-spark-actual" d={actualLine} />
      <circle className="set-quota-spark-tip" cx={latest.x} cy={latest.y} r="3.5" />
    </svg>
  );
}
