import { useLayoutEffect, useRef } from 'react';
import { formatUsdAmount, formatUsageReset } from '../app/format';
import { t } from '../i18n';
import { clampPercent, formatPercent, usageTone } from '../lib/contextMetrics';

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
};

const RING_SIZE = 92;
const STROKE = 8;
const RADIUS = (RING_SIZE - STROKE) / 2;
const CIRCUMFERENCE = 2 * Math.PI * RADIUS;

function periodLabel(kind: string | null): string {
  if (kind === 'monthly') return t('settings.usagePeriodMonthly');
  if (kind === 'weekly') return t('settings.usagePeriodWeekly');
  return t('settings.usagePeriodUnknown');
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
  const ready = Boolean(usage?.ok && usage.creditUsagePercent != null);
  const percent = ready ? clampPercent(usage!.creditUsagePercent ?? 0) : 0;
  const remaining = clampPercent(100 - percent);
  const tone = ready ? usageTone(percent) : loading ? 'loading' : usage ? 'error' : 'empty';
  const dashOffset = CIRCUMFERENCE * (1 - percent / 100);
  const period = periodLabel(usage?.periodType ?? null);
  const aria = ready
    ? t('settings.usageAria', { percent: formatPercent(percent), period })
    : loading
      ? t('settings.usageLoading')
      : t('settings.usageError');

  return (
    <div className="set-cli-usage">
      <div className="set-cli-usage-toolbar">
        <p className="set-cli-usage-hint">{t('settings.usageHint')}</p>
        <button
          type="button"
          className="set-cli-refresh"
          onClick={onRefresh}
          disabled={loading}
        >
          {t('settings.usageRefresh')}
        </button>
      </div>

      <div className="set-cli-usage-hero">
        <div
          className={`set-credit-ring tone-${tone}${loading ? ' is-loading' : ''}`}
          role="img"
          aria-label={aria}
        >
          <svg
            className="set-credit-svg"
            width={RING_SIZE}
            height={RING_SIZE}
            viewBox={`0 0 ${RING_SIZE} ${RING_SIZE}`}
            aria-hidden="true"
          >
            <circle
              className="set-credit-track"
              cx={RING_SIZE / 2}
              cy={RING_SIZE / 2}
              r={RADIUS}
              fill="none"
              strokeWidth={STROKE}
            />
            <circle
              className="set-credit-progress"
              cx={RING_SIZE / 2}
              cy={RING_SIZE / 2}
              r={RADIUS}
              fill="none"
              strokeWidth={STROKE}
              strokeLinecap="round"
              strokeDasharray={CIRCUMFERENCE}
              strokeDashoffset={ready ? dashOffset : CIRCUMFERENCE}
              transform={`rotate(-90 ${RING_SIZE / 2} ${RING_SIZE / 2})`}
            />
          </svg>
          <span className="set-credit-center">
            {loading ? '…' : ready ? formatPercent(percent) : '—'}
          </span>
        </div>

        <div className="set-cli-usage-copy">
          {loading ? (
            <p className="set-cli-muted">{t('settings.usageLoading')}</p>
          ) : usage && !usage.ok ? (
            <p className="set-cli-muted">{usage.error || t('settings.usageError')}</p>
          ) : ready && usage ? (
            <UsageCopy usage={usage} percent={percent} remaining={remaining} period={period} />
          ) : (
            <p className="set-cli-muted">{t('settings.usageError')}</p>
          )}
        </div>
      </div>

      {ready ? <UsageBreakdown percent={percent} remaining={remaining} /> : null}
    </div>
  );
}

function UsageCopy({
  usage,
  percent,
  remaining,
  period,
}: {
  usage: CliUsage;
  percent: number;
  remaining: number;
  period: string;
}) {
  const reset = formatUsageReset(usage.periodEnd);
  const paygOn = (usage.onDemandCap ?? 0) > 0;
  return (
    <>
      {usage.subscriptionTier ? (
        <div className="set-cli-tier">{t('settings.usageTier', { tier: usage.subscriptionTier })}</div>
      ) : null}
      <div className="set-cli-period">{period}</div>
      <div className="set-cli-used">{t('settings.usagePercent', { percent: formatPercent(percent) })}</div>
      <div className="set-cli-remain">
        {t('settings.usageRemaining', { percent: formatPercent(remaining) })}
      </div>
      {reset ? <div className="set-cli-reset">{t('settings.usageReset', { when: reset })}</div> : null}
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
    </>
  );
}

function UsageBreakdown({ percent, remaining }: { percent: number; remaining: number }) {
  const barRef = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => {
    const bar = barRef.current;
    if (!bar) return;
    const used = bar.querySelector<HTMLElement>('[data-seg="used"]');
    const free = bar.querySelector<HTMLElement>('[data-seg="free"]');
    if (used) {
      used.style.width = percent > 0 ? `${percent}%` : '0%';
      used.style.display = percent > 0 ? '' : 'none';
    }
    if (free) {
      free.style.width = remaining > 0 ? `${remaining}%` : '0%';
      free.style.display = remaining > 0 ? '' : 'none';
    }
  }, [percent, remaining]);

  return (
    <>
      <div ref={barRef} className="set-cli-bar" role="img" aria-hidden="true">
        <span data-seg="used" className="set-cli-bar-seg seg-used" />
        <span data-seg="free" className="set-cli-bar-seg seg-free" />
      </div>
      <ul className="set-cli-legend">
        <li>
          <span className="set-cli-swatch seg-used" aria-hidden="true" />
          <span>{t('settings.usageUsedSeg')}</span>
          <span className="set-cli-legend-value">{formatPercent(percent)}</span>
        </li>
        <li>
          <span className="set-cli-swatch seg-free" aria-hidden="true" />
          <span>{t('settings.usageFreeSeg')}</span>
          <span className="set-cli-legend-value">{formatPercent(remaining)}</span>
        </li>
      </ul>
    </>
  );
}
