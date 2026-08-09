import { memo, useEffect, useMemo } from 'react';
import { useRunHtml, useRunSnapshot } from '../hooks/useRunSnapshot';
import { sanitizeHtml } from '../lib/sanitizeHtml';
import { TraceTimeline } from './TraceTimeline';
import { MessageActions } from './MessageActions';
import { t } from '../i18n';
import type { TraceEvent } from '../lib/traceParser';

interface Props {
  runId: string;
  fallbackText?: string;
  durationMs?: number;
  fallbackTraces?: TraceEvent[];
  canUndo?: boolean;
  onUndo?: () => void;
}

function MessageItemImpl({
  runId,
  fallbackText,
  durationMs,
  fallbackTraces,
  canUndo = false,
  onUndo,
}: Props) {
  const snap = useRunSnapshot(runId);
  const html = useRunHtml(runId);
  const workedMs =
    snap?.startedAt != null && snap.endedAt != null
      ? Math.max(0, snap.endedAt - snap.startedAt)
      : durationMs;
  const workedLabel = workedMs != null ? formatWorkedDuration(workedMs) : null;
  const runIsLive = snap?.state === 'queued' || snap?.state === 'running';

  // markdown-it does not sanitize; strip scripts/handlers before injecting.
  const safeHtml = useMemo(() => (html ? sanitizeHtml(html) : html), [html]);
  const workedRow = workedLabel ? (
    <TraceTimeline
      runId={runId}
      workedLabel={t('message.workedFor', { duration: workedLabel })}
      fallbackTraces={fallbackTraces}
    />
  ) : null;

  // Restored/legacy assistant messages (loaded from storage after a restart)
  // have stored text but no live run snapshot. Render them through the SAME
  // off-thread markdown worker so code blocks and formatting survive a restart
  // instead of showing raw ``` text. Falls back to plain text if the worker is
  // unavailable. Keyed by the message's stable synthetic runId (msg:<id>).
  // Lazy-import like streamStore does — markdownWorker's only other importers
  // are dynamic, and mixing a static import here would fold the module into
  // the main chunk (Vite warns about exactly that).
  useEffect(() => {
    if (!snap && runId && fallbackText && html === undefined) {
      import('../lib/markdownWorker')
        .then(({ scheduleMarkdownParse }) => scheduleMarkdownParse(runId, fallbackText))
        .catch(() => {
          /* worker unavailable; the plain-text fallback below renders */
        });
    }
  }, [snap, runId, fallbackText, html]);

  if (!snap) {
    if (safeHtml) {
      return (
        <>
          {workedRow}
          <div
            className="message-body markdown-body"
            dangerouslySetInnerHTML={{ __html: safeHtml }}
          />
          <MessageActions sourceText={fallbackText || ''} canUndo={canUndo} onUndo={onUndo} />
        </>
      );
    }
    if (fallbackText) {
      return (
        <>
          {workedRow}
          <pre className="message-body">{fallbackText}</pre>
          <MessageActions sourceText={fallbackText} canUndo={canUndo} onUndo={onUndo} />
        </>
      );
    }
    return null;
  }

  // The markdown worker is fed on every text event. Use its latest result as
  // soon as it arrives instead of holding it until the run finishes, so
  // headings, lists and fenced code progressively render while streaming.
  // Before the first worker response, show the current raw text immediately.
  return (
    <>
      {workedRow}
      {/* While a run is live, keep its changing action at the top of the
          response so waiting/tool/subagent progress has one stable home. Once
          complete, the same rail moves below the answer as a quiet, durable
          "Finished" disclosure — matching the reading order of Cursor's
          agent transcript without hiding the real-time workflow. */}
      {runIsLive ? <TraceTimeline runId={runId} /> : null}
      {safeHtml ? (
        <div
          className="message-body markdown-body markdown-streaming"
          dangerouslySetInnerHTML={{ __html: safeHtml }}
        />
      ) : snap.text || fallbackText ? (
        <pre className="message-body streaming-raw">{snap.text || fallbackText || ''}</pre>
      ) : null}
      {/* A failed/cancelled run must say so in the message area — the only
          other surface (StatusBar suffix) resets to "idle" as soon as the
          queue moves on, leaving a silent empty bubble. */}
      {snap.state === 'failed' ? (
        <div className="message-error" role="alert">
          {snap.error
            ? t('message.runFailedWithError', { error: snap.error })
            : t('message.runFailed')}
        </div>
      ) : null}
      {snap.state === 'cancelled' ? (
        <div className="message-error message-cancelled">{t('message.stopped')}</div>
      ) : null}
      <MessageActions
        sourceText={snap.text || fallbackText || ''}
        canUndo={canUndo && snap.state !== 'queued' && snap.state !== 'running'}
        onUndo={onUndo}
      />
    </>
  );
}

export const MessageItem = memo(MessageItemImpl);

function formatWorkedDuration(ms: number): string {
  const seconds = Math.max(0, Math.round(ms / 1000));
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  return `${minutes}m ${seconds % 60}s`;
}
