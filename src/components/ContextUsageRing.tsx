// Compact circular context-occupancy ring below the composer's lower-right edge.
// Occupancy = Grok session signals (true context window fill), not billing usage.
// Panel shows an approximate Cursor-style category breakdown when available.
import { useEffect, useId, useLayoutEffect, useRef, useState } from 'react';
import type { ChatMessage } from '../app/types';
import { useContextUsage } from '../hooks/useContextUsage';
import { useModalFocus } from '../hooks/useModalFocus';
import {
  BREAKDOWN_SEGMENTS,
  breakdownSegmentPercents,
  formatApproxTokenCount,
  formatPercent,
  formatTokenCount,
  type BreakdownSegmentKey,
  type ContextUsageBreakdown,
  type ContextUsageTone,
  type ContextUsageViewState,
} from '../lib/contextMetrics';
import { t } from '../i18n';

/** Visible ring diameter; hit target is larger via CSS (18px). */
const RING_SIZE = 13;
const STROKE = 2;
const RADIUS = (RING_SIZE - STROKE) / 2;
const CIRCUMFERENCE = 2 * Math.PI * RADIUS;

export interface ContextUsageRingProps {
  messages: readonly ChatMessage[];
  cwd: string;
}

function ringAriaLabel(view: ContextUsageViewState, streaming: boolean): string {
  const live = streaming ? ` ${t('context.streamingHint')}` : '';
  if (view.kind === 'ready') {
    return (
      t('context.ringAriaReady', {
        percent: formatPercent(view.percent),
        used: formatTokenCount(view.metrics.contextTokensUsed),
        window: formatTokenCount(view.metrics.contextWindowTokens),
      }) + live
    );
  }
  if (view.kind === 'loading') return t('context.ringAriaLoading') + live;
  if (view.kind === 'error') return t('context.ringAriaError') + live;
  if (view.reason === 'no-session') return t('context.ringAriaEmpty');
  return t('context.ringAriaUnavailable') + live;
}

function toneClass(tone: ContextUsageTone | 'loading' | 'error'): string {
  return `context-usage-ring tone-${tone}`;
}

function segmentTokens(breakdown: ContextUsageBreakdown, key: BreakdownSegmentKey): number {
  switch (key) {
    case 'systemPrompt':
      return breakdown.systemPrompt;
    case 'rules':
      return breakdown.rules;
    case 'toolsRuntime':
      return breakdown.toolsRuntime;
    case 'conversation':
      return breakdown.conversation;
  }
}

export function ContextUsageRing({ messages, cwd }: ContextUsageRingProps) {
  const { view, streaming, refresh } = useContextUsage(messages, cwd);
  const [open, setOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);
  const popoverRef = useRef<HTMLDivElement>(null);
  const buttonRef = useRef<HTMLButtonElement>(null);
  const closeRef = useRef<HTMLButtonElement>(null);
  const titleId = useId();
  const popoverId = useId();

  useModalFocus(open, popoverRef, {
    initialFocus: closeRef,
    onEscape: () => setOpen(false),
  });

  // Outside click closes the popover.
  useEffect(() => {
    if (!open) return;
    const onPointer = (event: MouseEvent) => {
      const target = event.target as Node | null;
      if (!target) return;
      if (rootRef.current?.contains(target)) return;
      setOpen(false);
    };
    document.addEventListener('mousedown', onPointer);
    return () => document.removeEventListener('mousedown', onPointer);
  }, [open]);

  // Close when the conversation head disappears (new chat / switch mid-open).
  useEffect(() => {
    if (view.kind === 'empty' && view.reason === 'no-session') {
      setOpen(false);
    }
  }, [view]);

  const percent = view.kind === 'ready' ? view.percent : 0;
  const tone: ContextUsageTone | 'loading' | 'error' =
    view.kind === 'ready'
      ? view.tone
      : view.kind === 'loading'
        ? 'loading'
        : view.kind === 'error'
          ? 'error'
          : 'empty';
  const dashOffset = CIRCUMFERENCE * (1 - Math.min(100, Math.max(0, percent)) / 100);
  const label = ringAriaLabel(view, streaming);

  return (
    <div className="context-usage" ref={rootRef}>
      <button
        ref={buttonRef}
        type="button"
        className={`${toneClass(tone)}${streaming ? ' is-streaming' : ''}${open ? ' is-open' : ''}`}
        aria-label={label}
        aria-haspopup="dialog"
        aria-expanded={open}
        aria-controls={open ? popoverId : undefined}
        title={label}
        onClick={() => {
          setOpen((v) => {
            const next = !v;
            if (next) refresh();
            return next;
          });
        }}
      >
        <svg
          className="context-usage-svg"
          width={RING_SIZE}
          height={RING_SIZE}
          viewBox={`0 0 ${RING_SIZE} ${RING_SIZE}`}
          aria-hidden="true"
        >
          <circle
            className="context-usage-track"
            cx={RING_SIZE / 2}
            cy={RING_SIZE / 2}
            r={RADIUS}
            fill="none"
            strokeWidth={STROKE}
          />
          <circle
            className="context-usage-progress"
            cx={RING_SIZE / 2}
            cy={RING_SIZE / 2}
            r={RADIUS}
            fill="none"
            strokeWidth={STROKE}
            strokeLinecap="round"
            strokeDasharray={CIRCUMFERENCE}
            strokeDashoffset={view.kind === 'ready' ? dashOffset : CIRCUMFERENCE}
            transform={`rotate(-90 ${RING_SIZE / 2} ${RING_SIZE / 2})`}
          />
        </svg>
      </button>

      {open ? (
        <div
          ref={popoverRef}
          id={popoverId}
          className="context-usage-popover"
          role="dialog"
          aria-modal="true"
          aria-labelledby={titleId}
          tabIndex={-1}
        >
          <div className="context-usage-header">
            <strong id={titleId}>{t('context.popoverTitle')}</strong>
            <button
              ref={closeRef}
              type="button"
              className="context-usage-close"
              aria-label={t('context.closePanel')}
              onClick={() => setOpen(false)}
            >
              <span aria-hidden="true">×</span>
            </button>
          </div>
          <ContextUsagePopoverBody view={view} streaming={streaming} />
        </div>
      ) : null}
    </div>
  );
}

function ContextUsageBreakdownPanel({
  breakdown,
  contextWindow,
}: {
  breakdown: ContextUsageBreakdown;
  contextWindow: number | null;
}) {
  const barRef = useRef<HTMLDivElement>(null);

  // Dynamic segment widths via element.style on a ref (CSP / smoke invariant).
  useLayoutEffect(() => {
    const bar = barRef.current;
    if (!bar) return;
    const pct = breakdownSegmentPercents(breakdown, contextWindow);
    for (const seg of BREAKDOWN_SEGMENTS) {
      const node = bar.querySelector<HTMLElement>(`[data-seg="${seg.key}"]`);
      if (!node) continue;
      const width = pct[seg.key];
      node.style.width = width > 0 ? `${width}%` : '0%';
      node.style.display = width > 0 ? '' : 'none';
    }
  }, [breakdown, contextWindow]);

  return (
    <>
      <div
        ref={barRef}
        className="context-usage-bar"
        role="img"
        aria-label={t('context.estimatedBreakdown')}
      >
        {BREAKDOWN_SEGMENTS.map((seg) => (
          <span
            key={seg.key}
            data-seg={seg.key}
            className={`context-usage-bar-seg seg-${seg.color}`}
          />
        ))}
      </div>

      <ul className="context-usage-legend">
        {BREAKDOWN_SEGMENTS.map((seg) => (
          <li key={seg.key}>
            <span className={`context-usage-swatch seg-${seg.color}`} aria-hidden="true" />
            <span className="context-usage-legend-label">{t(seg.labelKey)}</span>
            <span className="context-usage-legend-value">
              {formatApproxTokenCount(segmentTokens(breakdown, seg.key))}
            </span>
          </li>
        ))}
      </ul>

      <p className="context-usage-estimate-hint">{t('context.estimatedBreakdown')}</p>
    </>
  );
}

function ContextUsagePopoverBody({
  view,
  streaming,
}: {
  view: ContextUsageViewState;
  streaming: boolean;
}) {
  if (view.kind === 'loading') {
    return <p className="context-usage-muted">{t('context.loading')}</p>;
  }
  if (view.kind === 'error') {
    return <p className="context-usage-muted">{view.message}</p>;
  }
  if (view.kind === 'empty') {
    return (
      <p className="context-usage-muted">
        {view.detail ??
          (view.reason === 'no-session'
            ? t('context.emptyNoSession')
            : t('context.emptyUnavailable'))}
      </p>
    );
  }

  const { metrics, percent } = view;
  const breakdown = metrics.breakdown;
  const usedLabel = formatApproxTokenCount(metrics.contextTokensUsed);
  const windowLabel = formatTokenCount(metrics.contextWindowTokens);

  return (
    <>
      <div className="context-usage-summary">
        <span className="context-usage-full">
          {t('context.percentFull', { percent: formatPercent(percent) })}
        </span>
        <span className="context-usage-tokens">
          {t('context.tokensSummary', { used: usedLabel, window: windowLabel })}
        </span>
      </div>

      {breakdown ? (
        <ContextUsageBreakdownPanel
          breakdown={breakdown}
          contextWindow={metrics.contextWindowTokens}
        />
      ) : null}

      {streaming ? (
        <p className="context-usage-live" role="status" aria-live="polite">
          {t('context.streamingHint')}
        </p>
      ) : null}
    </>
  );
}
