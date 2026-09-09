import { afterEach, describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import { UsageMeter, type CliUsage } from '../UsageMeter';

const PERIOD_START = '2026-09-08T00:06:00.000Z';
const PERIOD_END = '2026-09-15T00:06:00.000Z';

function usage(overrides: Partial<CliUsage> = {}): CliUsage {
  return {
    ok: true,
    error: null,
    creditUsagePercent: 32,
    periodType: 'weekly',
    periodStart: PERIOD_START,
    periodEnd: PERIOD_END,
    onDemandCap: 0,
    onDemandUsed: 0,
    prepaidBalance: 0,
    unifiedBilling: true,
    subscriptionTier: 'SuperGrok',
    snapshots: [
      {
        sampledAt: Date.parse(PERIOD_START) + 60_000,
        remainingPercent: 90,
        periodStart: PERIOD_START,
        periodEnd: PERIOD_END,
      },
    ],
    ...overrides,
  };
}

describe('UsageMeter', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it('compares remaining quota with remaining time on the same scale', () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-09-08T16:06:00.000Z'));
    render(<UsageMeter usage={usage()} loading={false} onRefresh={() => undefined} />);
    expect(screen.getByText('Weekly quota')).toBeInTheDocument();
    expect(screen.getByText('Above pace')).toBeInTheDocument();
    expect(screen.getByText('32% used')).toBeInTheDocument();
    expect(screen.getByText('6d 8h')).toBeInTheDocument();
    expect(screen.queryByText(/behind the window/)).not.toBeInTheDocument();
    expect(
      screen.getByRole('img', { name: /68% quota remaining; 90% of the billing window remaining/ }),
    ).toBeInTheDocument();
    expect(document.querySelector('.set-quota-swatch.quota.tone-yellow')).toBeTruthy();
    expect(screen.getByText(/Resets:/)).toBeInTheDocument();
    expect(screen.getByText('Quota History')).toBeInTheDocument();
    expect(screen.getByText('Current 7-day quota cycle')).toBeInTheDocument();
    expect(
      screen.getByRole('img', { name: 'Quota remaining over the current cycle' }),
    ).toBeInTheDocument();
  });

  it('does not repeat remaining percent beside the rings', () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-09-08T16:06:00.000Z'));
    render(
      <UsageMeter
        usage={usage({ creditUsagePercent: 9 })}
        loading={false}
        onRefresh={() => undefined}
      />,
    );
    expect(screen.getByText('On track')).toBeInTheDocument();
    expect(screen.getByText('9% used')).toBeInTheDocument();
    expect(screen.getByText('6d 8h')).toBeInTheDocument();
    expect(screen.queryByText(/ahead of the window/)).not.toBeInTheDocument();
    expect(screen.queryByText('Time remaining')).not.toBeInTheDocument();
    expect(screen.queryByRole('meter')).not.toBeInTheDocument();
  });

  it('keeps refresh available while a previous snapshot is on screen', () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-09-08T16:06:00.000Z'));
    render(<UsageMeter usage={usage()} loading={true} onRefresh={() => undefined} />);
    expect(screen.getByRole('button', { name: 'Refresh' })).toBeDisabled();
    expect(screen.getByText('Weekly quota')).toBeInTheDocument();
  });

  it('turns the quota fill orange at 30% remaining and red at 10%', () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-09-08T16:06:00.000Z'));
    const { rerender } = render(
      <UsageMeter
        usage={usage({ creditUsagePercent: 70 })}
        loading={false}
        onRefresh={() => undefined}
      />,
    );
    expect(document.querySelector('.set-quota-swatch.quota.tone-orange')).toBeTruthy();
    expect(document.querySelector('.set-quota-rings.tone-orange')).toBeTruthy();

    rerender(
      <UsageMeter
        usage={usage({ creditUsagePercent: 91 })}
        loading={false}
        onRefresh={() => undefined}
      />,
    );
    expect(document.querySelector('.set-quota-swatch.quota.tone-red')).toBeTruthy();
    expect(document.querySelector('.set-quota-rings.tone-red')).toBeTruthy();
  });
});
