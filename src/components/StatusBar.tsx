import { useElapsed } from '../hooks/useElapsed';
import { useRunSnapshot } from '../hooks/useRunSnapshot';
import type { RunSnapshot } from '../lib/streamStore';
import { t } from '../i18n';

function formatTokens(chars: number): string {
  const tokens = Math.round(chars / 4);
  if (tokens >= 1000) return `${(tokens / 1000).toFixed(1)}k`;
  return String(tokens);
}

function formatElapsed(ms: number): string {
  const seconds = ms / 1000;
  if (seconds < 60) return `${seconds.toFixed(1)}s`;
  const minutes = Math.floor(seconds / 60);
  return `${minutes}m ${Math.round(seconds - minutes * 60)}s`;
}

function liveState(snap: RunSnapshot): string {
  if (snap.lastEventType === 'thought') return t('statusBar.thinking');
  if (snap.lastEventType === 'text') return t('statusBar.writing');
  return t('statusBar.working');
}

/**
 * A live, layout-neutral run caption attached to the assistant message that
 * owns the run. It replaces the old full-width bar above the composer, so
 * status reads as part of the response instead of a new application panel.
 */
export function RunStatusLine({ runId }: { runId: string }) {
  const snap = useRunSnapshot(runId);
  const elapsed = useElapsed(snap?.startedAt ?? null, snap?.endedAt ?? null);
  if (!snap || (snap.state !== 'queued' && snap.state !== 'running')) return null;

  const chars = snap.thoughtChars + snap.textChars;
  return (
    <div className="run-status-line" role="status" aria-live="polite">
      <span className="run-status-mark" aria-hidden>✦</span>
      <span>{elapsed != null ? formatElapsed(elapsed) : '0.0s'}</span>
      <span aria-hidden>·</span>
      <span>{t('statusBar.tokens', { tokens: formatTokens(chars) })}</span>
      <span aria-hidden>·</span>
      <span className="run-status-state">{liveState(snap)}</span>
    </div>
  );
}
