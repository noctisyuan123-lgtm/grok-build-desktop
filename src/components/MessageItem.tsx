import { memo, useEffect, useMemo, useState, type MouseEvent } from 'react';
import { ChevronDown } from 'lucide-react';
import { useRunHtml, useRunSnapshot } from '../hooks/useRunSnapshot';
import { sanitizeHtml } from '../lib/sanitizeHtml';
import { ActivityGroup, TraceTimeline } from './TraceTimeline';
import { MessageActions } from './MessageActions';
import { t } from '../i18n';
import { useElapsed } from '../hooks/useElapsed';
import type { TraceEvent } from '../lib/traceParser';
import type { TranscriptSegment } from '../lib/streamStore';

interface Props {
  runId: string;
  fallbackText?: string;
  durationMs?: number;
  fallbackTraces?: TraceEvent[];
  fallbackTranscript?: TranscriptSegment[];
  autoExpandWork?: boolean;
  canUndo?: boolean;
  onUndo?: () => void;
}

function MessageItemImpl({
  runId,
  fallbackText,
  durationMs,
  fallbackTraces,
  fallbackTranscript,
  autoExpandWork = false,
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
  const transcript = snap?.transcript.length ? snap.transcript : fallbackTranscript;
  const traces = snap?.traces.length ? snap.traces : fallbackTraces || [];

  // markdown-it does not sanitize; strip scripts/handlers before injecting.
  const safeHtml = useMemo(() => (html ? sanitizeHtml(html) : html), [html]);
  const workedRow =
    workedLabel && !transcript?.length ? (
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
    if (transcript?.length) {
      return (
        <TranscriptMessage
          key={runId}
          runId={runId}
          transcript={transcript}
          traces={traces}
          workedLabel={workedLabel ? t('message.workedFor', { duration: workedLabel }) : undefined}
          fallbackText={fallbackText}
          live={false}
          startedAt={null}
          autoExpandWork={autoExpandWork}
          canUndo={canUndo}
          onUndo={onUndo}
        />
      );
    }
    if (safeHtml) {
      return (
        <>
          {workedRow}
          <div
            className="message-body markdown-body"
            dangerouslySetInnerHTML={{ __html: safeHtml }}
            onClick={handleMarkdownClick}
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
      {transcript?.length ? (
        <TranscriptMessage
          key={runId}
          runId={runId}
          transcript={transcript}
          traces={traces}
          workedLabel={workedLabel ? t('message.workedFor', { duration: workedLabel }) : undefined}
          fallbackText={fallbackText}
          live={runIsLive}
          startedAt={snap.startedAt}
          autoExpandWork={autoExpandWork}
          canUndo={canUndo && !runIsLive}
          onUndo={onUndo}
        />
      ) : (
        <>
          {workedRow}
          {/* While a run is live, keep its changing action at the top of the
          response so waiting/tool/subagent progress has one stable home. Once
          complete, the same rail moves below the answer as a quiet, durable
          "Finished" disclosure — matching the reading order of Cursor's
          agent transcript without hiding the real-time workflow. */}
          {runIsLive ? (
            snap.traces.length > 0 || snap.lastEventType != null ? (
              <TraceTimeline runId={runId} />
            ) : (
              <div className="agent-starting" role="status" aria-live="polite">
                <span className="agent-starting-dot" aria-hidden />
                <span>Starting…</span>
              </div>
            )
          ) : null}
          {safeHtml ? (
            <div
              className="message-body markdown-body markdown-streaming"
              dangerouslySetInnerHTML={{ __html: safeHtml }}
              onClick={handleMarkdownClick}
            />
          ) : snap.text || fallbackText ? (
            <pre className="message-body streaming-raw">{snap.text || fallbackText || ''}</pre>
          ) : null}
        </>
      )}
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
      {!transcript?.length ? (
        <MessageActions
          sourceText={snap.text || fallbackText || ''}
          canUndo={canUndo && snap.state !== 'queued' && snap.state !== 'running'}
          onUndo={onUndo}
        />
      ) : null}
    </>
  );
}

export const MessageItem = memo(MessageItemImpl);

function TranscriptMessage({
  runId,
  transcript,
  traces,
  workedLabel,
  fallbackText,
  live,
  startedAt,
  autoExpandWork,
  canUndo,
  onUndo,
}: {
  runId: string;
  transcript: TranscriptSegment[];
  traces: TraceEvent[];
  workedLabel?: string;
  fallbackText?: string;
  live: boolean;
  startedAt: number | null;
  autoExpandWork: boolean;
  canUndo: boolean;
  onUndo?: () => void;
}) {
  const [expanded, setExpanded] = useState(autoExpandWork);
  useEffect(() => {
    if (autoExpandWork) setExpanded(true);
  }, [autoExpandWork]);
  const liveElapsed = useElapsed(live ? startedAt : null, null);
  const responseIndexes = transcript
    .map((segment, index) => (segment.kind === 'response' ? index : -1))
    .filter((index) => index >= 0);
  const finalIndex = responseIndexes.at(-1) ?? -1;
  const finalSegment = finalIndex >= 0 ? transcript[finalIndex] : undefined;
  const finalText = finalSegment?.kind === 'response' ? finalSegment.text : fallbackText || '';
  const header = live ? `Working for ${formatWorkedDuration(liveElapsed ?? 0)}` : workedLabel;

  return (
    <>
      {header ? (
        <section
          className={`message-worked-rail transcript-work${expanded ? ' is-expanded' : ''}${live ? ' is-live' : ''}`}
        >
          <button
            type="button"
            className="message-worked"
            onClick={() => setExpanded((value) => !value)}
            aria-expanded={expanded}
          >
            <span className="message-worked-summary">{header}</span>
            <ChevronDown
              className="message-worked-chevron"
              size={17}
              strokeWidth={1.8}
              aria-hidden
            />
          </button>
          {expanded ? (
            <div className="transcript-segments">
              {transcript.map((segment, index) => {
                if (index === finalIndex) return null;
                if (segment.kind === 'thought') {
                  return (
                    <ThoughtSegment
                      key={segment.key}
                      cacheKey={`${runId}:${segment.key}`}
                      segment={segment}
                      live={live}
                    />
                  );
                }
                if (segment.kind === 'response') {
                  return (
                    <MarkdownSegment
                      key={segment.key}
                      cacheKey={`${runId}:${segment.key}`}
                      text={segment.text}
                      className="transcript-response"
                    />
                  );
                }
                const groupTraces = segment.traceKeys
                  .map((key) => traces.find((trace) => trace.key === key))
                  .filter((trace): trace is TraceEvent => Boolean(trace));
                return <ActivityGroup key={segment.key} traces={groupTraces} />;
              })}
            </div>
          ) : null}
        </section>
      ) : null}
      {finalText ? (
        <MarkdownSegment cacheKey={runId} text={finalText} className="markdown-streaming" />
      ) : null}
      <MessageActions sourceText={finalText} canUndo={canUndo} onUndo={onUndo} />
    </>
  );
}

function ThoughtSegment({
  cacheKey,
  segment,
  live,
}: {
  cacheKey: string;
  segment: Extract<TranscriptSegment, { kind: 'thought' }>;
  live: boolean;
}) {
  const [expanded, setExpanded] = useState(false);
  const duration = Math.max(0, (segment.endedAt ?? Date.now()) - segment.startedAt);
  const label =
    live && segment.endedAt == null
      ? 'Thinking…'
      : duration < 500
        ? 'Thought briefly'
        : `Thought for ${formatWorkedDuration(duration)}`;
  return (
    <section
      className={`transcript-thought${expanded ? ' is-expanded' : ''}${live && segment.endedAt == null ? ' is-running' : ''}`}
    >
      <button type="button" onClick={() => setExpanded((value) => !value)} aria-expanded={expanded}>
        <span>{label}</span>
        <ChevronDown size={14} strokeWidth={1.7} aria-hidden />
      </button>
      {expanded && segment.text ? (
        <MarkdownSegment
          cacheKey={cacheKey}
          text={segment.text}
          className="transcript-thought-body"
        />
      ) : null}
    </section>
  );
}

function MarkdownSegment({
  cacheKey,
  text,
  className = '',
}: {
  cacheKey: string;
  text: string;
  className?: string;
}) {
  const html = useRunHtml(cacheKey);
  const safeHtml = useMemo(() => (html ? sanitizeHtml(html) : html), [html]);
  useEffect(() => {
    import('../lib/markdownWorker')
      .then(({ scheduleMarkdownParse }) => scheduleMarkdownParse(cacheKey, text))
      .catch(() => {});
  }, [cacheKey, text]);
  return safeHtml ? (
    <div
      className={`message-body markdown-body ${className}`}
      dangerouslySetInnerHTML={{ __html: safeHtml }}
      onClick={handleMarkdownClick}
    />
  ) : (
    <pre className={`message-body streaming-raw ${className}`}>{text}</pre>
  );
}

function formatWorkedDuration(ms: number): string {
  const seconds = Math.max(0, Math.round(ms / 1000));
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  return `${minutes}m ${seconds % 60}s`;
}

function handleMarkdownClick(event: MouseEvent<HTMLDivElement>): void {
  const target = event.target;
  if (!(target instanceof Element)) return;
  const button = target.closest<HTMLButtonElement>('.code-block-copy-button');
  if (!button) return;
  event.preventDefault();
  event.stopPropagation();
  const code = button.parentElement?.querySelector('code');
  if (!code) return;
  void copyCodeBlock(button, code.textContent ?? '');
}

async function copyCodeBlock(button: HTMLButtonElement, text: string): Promise<void> {
  try {
    await navigator.clipboard.writeText(text);
  } catch {
    const code = button.parentElement?.querySelector('code');
    const selection = window.getSelection();
    if (!code || !selection) return;
    selection.removeAllRanges();
    const range = document.createRange();
    range.selectNodeContents(code);
    selection.addRange(range);
    document.execCommand('copy');
    selection.removeAllRanges();
  }
  button.classList.add('copied');
  button.setAttribute('aria-label', 'Copied');
  window.setTimeout(() => {
    button.classList.remove('copied');
    button.setAttribute('aria-label', 'Copy code block');
  }, 2_000);
}
