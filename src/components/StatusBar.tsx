import { useMemo } from 'react';
import { useElapsed } from '../hooks/useElapsed';
import { useAppOnline } from '../hooks/useAppOnline';
import { useSessionActiveRun } from '../hooks/useActiveRun';
import { useRunSnapshot } from '../hooks/useRunSnapshot';
import type { ChatMessage } from '../app/types';
import {
  deriveConnection,
  hasRunningTool,
  type ConnectionAppearance,
} from '../lib/connectionHealth';
import type { RunSnapshot } from '../lib/streamStore';
import {
  formatTokPerSec,
  formatTokenCount,
  liveGeneratedTokens,
  thoughtTextFromTranscript,
} from '../lib/tokenEstimate';
import { t } from '../i18n';

function formatElapsed(ms: number): string {
  const seconds = ms / 1000;
  if (seconds < 60) return `${seconds.toFixed(1)}s`;
  const minutes = Math.floor(seconds / 60);
  return `${minutes}m ${Math.round(seconds - minutes * 60)}s`;
}

export function formatTokenRate(tokens: number, elapsedMs: number | null): string | null {
  const raw = formatTokPerSec(tokens, elapsedMs);
  if (!raw) return null;
  const rate = raw.replace(' tok/s', '');
  return t('statusBar.tokenRate', { rate });
}

function liveState(snap: RunSnapshot, appearance: ConnectionAppearance): string {
  if (appearance === 'disconnected') return t('statusBar.disconnected');
  if (appearance === 'stalled') return t('statusBar.waitingForNetwork');
  if (appearance === 'reconnecting') return t('statusBar.reconnecting');
  if (snap.lastEventType === 'thought') return t('statusBar.thinking');
  if (snap.lastEventType === 'text') return t('statusBar.writing');
  return t('statusBar.working');
}

/**
 * Live run caption. Fullscreen keeps elapsed, token count, and tok/s.
 * A normal window only keeps the activity word (working, Disconnected, …).
 * Sits on the workspace glass in the bottom-right — not a chrome bar.
 */
export function RunStatusLine({
  runId,
  variant = 'inline',
  showTokenMetrics = true,
}: {
  runId: string;
  variant?: 'inline' | 'titlebar' | 'hud';
  showTokenMetrics?: boolean;
}) {
  const snap = useRunSnapshot(runId);
  const online = useAppOnline();
  const elapsed = useElapsed(snap?.startedAt ?? null, snap?.endedAt ?? null);
  // Tick while a generation segment is open so tok/s updates during streaming.
  const segmentElapsed = useElapsed(snap?.generationResumedAt ?? null, null);
  useElapsed(snap?.lastEventAt ?? snap?.startedAt ?? null, snap?.endedAt ?? null);
  if (!snap || (snap.state !== 'queued' && snap.state !== 'running') || snap.watching) return null;

  const appearance = deriveConnection({
    now: Date.now(),
    online,
    inFlight: true,
    lastEventAt: snap.lastEventAt,
    startedAt: snap.startedAt,
    hasRunningTool: hasRunningTool(snap.traces),
  });
  const stateLabel = liveState(snap, appearance);
  const generated = showTokenMetrics
    ? liveGeneratedTokens({
        usage: snap.usage,
        thoughtText: thoughtTextFromTranscript(snap.transcript),
        responseText: snap.text,
      })
    : 0;
  // Denominator is generation-active time only (paused during tools / activity).
  const activeMs = snap.generationActiveMs + (segmentElapsed ?? 0);
  const rate = showTokenMetrics ? formatTokenRate(generated, activeMs) : null;
  return (
    <div
      className={`run-status-line${variant === 'titlebar' ? ' is-titlebar' : ''}${variant === 'hud' ? ' is-hud' : ''}`}
      role="status"
      aria-live="polite"
    >
      <span className="run-status-mark" aria-hidden>
        ✦
      </span>
      {showTokenMetrics ? (
        <>
          <span>{elapsed != null ? formatElapsed(elapsed) : '0.0s'}</span>
          <span aria-hidden>·</span>
          <span>{t('statusBar.tokens', { tokens: formatTokenCount(generated) })}</span>
          {rate ? (
            <>
              <span aria-hidden>·</span>
              <span className="run-status-rate">{rate}</span>
            </>
          ) : null}
          <span aria-hidden>·</span>
        </>
      ) : null}
      <span className="run-status-state">{stateLabel}</span>
    </div>
  );
}

/** Bottom-right overlay for the active session run. */
export function LiveRunHud({
  messages,
  showTokenMetrics = false,
}: {
  messages: readonly ChatMessage[];
  /** Fullscreen keeps tok/s. A normal window only shows the activity word. */
  showTokenMetrics?: boolean;
}) {
  const sessionRunIds = useMemo(
    () => messages.map((message) => message.runId).filter((id): id is string => Boolean(id)),
    [messages],
  );
  const liveRun = useSessionActiveRun(sessionRunIds);
  if (!liveRun) return null;
  return <RunStatusLine runId={liveRun.id} variant="hud" showTokenMetrics={showTokenMetrics} />;
}
