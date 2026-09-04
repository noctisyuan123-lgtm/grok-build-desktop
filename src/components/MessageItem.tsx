import {
  memo,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type MouseEvent,
  type ReactNode,
} from 'react';
import { ChevronDown } from 'lucide-react';
import { useRunHtml, useRunSnapshot } from '../hooks/useRunSnapshot';
import { sanitizeHtml } from '../lib/sanitizeHtml';
import { ActivityGroup, TraceTimeline } from './TraceTimeline';
import { MessageActions } from './MessageActions';
import { t } from '../i18n';
import { useElapsed } from '../hooks/useElapsed';
import { sumEditStats, type EditStats } from '../lib/editStats';
import type { RunCompaction, TraceEvent } from '../lib/traceParser';
import { exteriorMarkdownKey, isRunInFlight, type TranscriptSegment } from '../lib/streamStore';
import type { ChatMessageStatus } from '../app/types';
import { attachTableScroll } from '../lib/tableScroll';

interface Props {
  runId: string;
  fallbackText?: string;
  durationMs?: number;
  fallbackTraces?: TraceEvent[];
  fallbackTranscript?: TranscriptSegment[];
  autoExpandWork?: boolean;
  canUndo?: boolean;
  showUndo?: boolean;
  onUndo?: () => void;
  canFork?: boolean;
  showFork?: boolean;
  onFork?: () => void;
  status?: ChatMessageStatus;
}

function MessageItemImpl({
  runId,
  fallbackText,
  durationMs,
  fallbackTraces,
  fallbackTranscript,
  autoExpandWork = false,
  canUndo = false,
  showUndo = true,
  onUndo,
  canFork = false,
  showFork = false,
  onFork,
  status,
}: Props) {
  const snap = useRunSnapshot(runId);
  const html = useRunHtml(runId);
  const workedMs =
    snap?.startedAt != null && snap.endedAt != null
      ? Math.max(0, snap.endedAt - snap.startedAt)
      : durationMs;
  const workedLabel = workedMs != null ? formatWorkedDuration(workedMs) : null;
  const runIsLive = isRunInFlight(snap);
  const transcript = snap?.transcript.length ? snap.transcript : fallbackTranscript;
  const traces = snap?.traces.length ? snap.traces : fallbackTraces || [];
  // The queue can publish a terminal state before the stream's `end` event.
  // Keep the transcript in its live/intermediate shape until that event has
  // actually arrived, otherwise the last intermediate response briefly gets
  // promoted into the final answer and then jumps back into the work rail.
  const responseTerminalReady = !snap || snap.lastEventType === 'end' || snap.stopReason != null;
  const forkVisible = showFork && (!snap || (!runIsLive && responseTerminalReady));
  const forkEnabled = canFork && forkVisible;

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
  const parsedFallbackRef = useRef<string>('');
  useEffect(() => {
    if (snap || !runId || !fallbackText) return;
    // Re-parse when live-imported CLI text grows. The first poll often lands
    // the pre-tool paragraph; later chunks keep the same synthetic runId.
    if (html !== undefined && parsedFallbackRef.current === fallbackText) return;
    parsedFallbackRef.current = fallbackText;
    import('../lib/markdownWorker')
      .then(({ scheduleMarkdownParse }) => scheduleMarkdownParse(runId, fallbackText))
      .catch(() => {
        /* worker unavailable; the plain-text fallback below renders */
      });
  }, [snap, runId, fallbackText, html]);

  const liveWaiting =
    runIsLive &&
    !transcript?.length &&
    snap != null &&
    snap.traces.length === 0 &&
    snap.lastEventType == null;

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
          compaction={null}
          responseTerminalReady
          startedAt={null}
          autoExpandWork={autoExpandWork}
          canUndo={canUndo}
          showUndo={showUndo}
          onUndo={onUndo}
          canFork={forkEnabled}
          showFork={forkVisible}
          onFork={onFork}
        />
      );
    }
    if (safeHtml) {
      return (
        <>
          {workedRow}
          <MarkdownHtml html={safeHtml} owner={runId} className="message-body markdown-body" />
          <MessageActions
            sourceText={fallbackText || ''}
            canUndo={canUndo}
            showCopy
            showUndo={showUndo}
            onUndo={onUndo}
            canFork={forkEnabled}
            showFork={forkVisible}
            onFork={onFork}
          />
        </>
      );
    }
    if (fallbackText) {
      return (
        <>
          {workedRow}
          <pre className="message-body">{fallbackText}</pre>
          <MessageActions
            sourceText={fallbackText}
            canUndo={canUndo}
            showCopy
            showUndo={showUndo}
            onUndo={onUndo}
            canFork={forkEnabled}
            showFork={forkVisible}
            onFork={onFork}
          />
        </>
      );
    }
    // Restart / install can coerce an in-flight turn to `stopped` before any
    // text or transcript was checkpointed. Render a marker instead of an
    // invisible assistant row so the follow-up does not look deleted.
    if (workedRow) return workedRow;
    if (status === 'stopped' || status === 'error') {
      return (
        <div className="message-error message-cancelled" role="status">
          {status === 'error' ? t('message.runFailed') : t('message.interrupted')}
        </div>
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
      {transcript?.length || liveWaiting ? (
        <TranscriptMessage
          key={runId}
          runId={runId}
          transcript={transcript ?? []}
          traces={traces}
          workedLabel={workedLabel ? t('message.workedFor', { duration: workedLabel }) : undefined}
          fallbackText={fallbackText}
          live={runIsLive}
          compaction={snap.compaction}
          responseTerminalReady={responseTerminalReady}
          startedAt={snap.startedAt}
          autoExpandWork={autoExpandWork}
          canUndo={canUndo && !runIsLive}
          showUndo={showUndo}
          onUndo={onUndo}
          canFork={forkEnabled}
          showFork={forkVisible}
          onFork={onFork}
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
            <>
              <CompactionHint compaction={snap.compaction} />
              <TraceTimeline runId={runId} />
            </>
          ) : null}
          {safeHtml ? (
            <MarkdownHtml
              html={safeHtml}
              owner={runId}
              className="message-body markdown-body markdown-streaming"
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
      {!transcript?.length && !liveWaiting ? (
        <>
          <MessageActions
            sourceText={snap.text || fallbackText || ''}
            canUndo={canUndo && !runIsLive}
            showCopy={!runIsLive && responseTerminalReady}
            showUndo={showUndo}
            onUndo={onUndo}
            canFork={forkEnabled}
            showFork={forkVisible}
            onFork={onFork}
          />
        </>
      ) : null}
      {snap.watching ? (
        <WatchingRail startedAt={snap.watchingStartedAt ?? snap.endedAt ?? Date.now()} />
      ) : null}
    </>
  );
}

export const MessageItem = memo(MessageItemImpl);

export function TranscriptMessage({
  runId,
  transcript,
  traces,
  workedLabel,
  fallbackText,
  live,
  compaction,
  responseTerminalReady,
  startedAt,
  autoExpandWork,
  canUndo,
  showUndo,
  onUndo,
  canFork = false,
  showFork = false,
  onFork,
}: {
  runId: string;
  transcript: TranscriptSegment[];
  traces: TraceEvent[];
  workedLabel?: string;
  fallbackText?: string;
  live: boolean;
  compaction?: RunCompaction | null;
  responseTerminalReady: boolean;
  startedAt: number | null;
  autoExpandWork: boolean;
  canUndo: boolean;
  showUndo: boolean;
  onUndo?: () => void;
  canFork?: boolean;
  showFork?: boolean;
  onFork?: () => void;
}) {
  const [expanded, setExpanded] = useState(autoExpandWork);
  const wasLive = useRef(live);
  useEffect(() => {
    if (wasLive.current && !live) {
      setExpanded(false);
    } else if (autoExpandWork && live) {
      setExpanded(true);
    }
    wasLive.current = live;
  }, [autoExpandWork, live]);
  const liveElapsed = useElapsed(live ? startedAt : null, null);
  // While live, only the transcript tail may sit below the work rail: an
  // intermediate response followed by a tool returns into chronological order.
  // After completion the latest response always renders outside "Worked for",
  // even when trailing bookkeeping/activity arrived later.
  const { finalIndex, finalText } = resolveFinalResponse(
    transcript,
    live,
    responseTerminalReady,
    fallbackText,
  );
  const header = live ? `Working for ${formatWorkedDuration(liveElapsed ?? 0)}` : workedLabel;
  // Render-only phase groups: intermediate responses close a workflow phase and
  // fold its thought/tool records into one summary above the response. Stored
  // transcript order is never rewritten.
  const phases = useMemo(() => groupTranscriptPhases(transcript), [transcript]);

  return (
    <>
      {header || compaction ? (
        <section
          className={`message-worked-rail transcript-work${expanded ? ' is-expanded' : ''}${live ? ' is-live' : ''}`}
        >
          {header ? (
            <button
              type="button"
              className="message-worked"
              onClick={() => setExpanded((value) => !value)}
              aria-expanded={expanded}
            >
              <span
                className={`message-worked-summary${live ? ' is-shimmer' : ''}`}
                data-label={header}
              >
                {header}
              </span>
              <ChevronDown
                className="message-worked-chevron"
                size={17}
                strokeWidth={1.8}
                aria-hidden
              />
            </button>
          ) : null}
          <CompactionHint compaction={compaction} />
          {header && expanded ? (
            <div className="transcript-segments">
              {phases.map((phase, phaseIndex) => {
                const hasClosedResponse = phase.response?.kind === 'response';
                // Exterior final answer sits outside the work rail (finalText).
                const isExteriorFinal =
                  hasClosedResponse && finalIndex >= 0 && phase.responseIndex === finalIndex;
                // Three independent gates (do not collapse them into one):
                // 1) collapseActivity — a respond closes the phase, so fold the
                //    preceding thought/tools into a disclosure (live or settled).
                // 2) foldResponseIntoPhase — only when the run is *settled* with a
                //    real final, bury prior mid-responds inside that disclosure.
                //    While live, a trailing respond is only a *provisional*
                //    exterior (`finalIndex >= 0`); earlier mids must stay
                //    readable in the rail — otherwise each new mid hides all
                //    previous ones until the next tool/thought lands.
                // 3) showResponseInRail — mid-respond beside folded process.
                const collapseActivity = phase.activity.length > 0 && hasClosedResponse;
                const foldResponseIntoPhase =
                  !live && hasClosedResponse && !isExteriorFinal && finalIndex >= 0;
                const showResponseInRail =
                  hasClosedResponse && !isExteriorFinal && !foldResponseIntoPhase;
                const responseNode =
                  phase.response?.kind === 'response' ? (
                    <MarkdownSegment
                      key={phase.response.key}
                      cacheKey={`${runId}:${phase.response.key}`}
                      text={phase.response.text}
                      className="transcript-response"
                    />
                  ) : null;
                // Phase-local edit totals only — never outer Work for / global run sums.
                const phaseEditStats = collapseActivity
                  ? sumEditStats(tracesForPhase(phase, traces))
                  : null;
                const phaseKey = `phase:${phaseIndex}:${phase.activity[0]?.segment.key ?? phase.response?.key ?? phaseIndex}`;
                return (
                  <div key={phaseKey} className="transcript-phase-block">
                    {collapseActivity ? (
                      <>
                        {renderCollapsedPhase({
                          runId,
                          phase,
                          traces,
                          live,
                          foldResponseIntoPhase,
                          responseNode: foldResponseIntoPhase ? responseNode : null,
                          phaseEditStats,
                        })}
                        {/* Live / pre-final: process folded, mid-respond stays readable. */}
                        {showResponseInRail ? responseNode : null}
                      </>
                    ) : (
                      <>
                        {phase.activity.map(({ segment }) =>
                          renderWorkflowSegment(runId, segment, traces, live),
                        )}
                        {/* Intermediate response with no preceding activity. */}
                        {showResponseInRail || foldResponseIntoPhase ? responseNode : null}
                      </>
                    )}
                  </div>
                );
              })}
            </div>
          ) : null}
        </section>
      ) : null}
      {finalText ? (
        // Never use bare `runId` here: streamStore schedules full accumulated
        // `snap.text` (mid + final) under that key. Exterior must use the
        // trailing-response-only key from `exteriorMarkdownKey`.
        <MarkdownSegment
          cacheKey={
            finalIndex >= 0 ? exteriorMarkdownKey(runId, finalIndex) : `${runId}:exterior:fallback`
          }
          text={finalText}
          className="markdown-streaming"
        />
      ) : null}
      <MessageActions
        sourceText={finalText}
        canUndo={canUndo}
        showCopy={!live && responseTerminalReady}
        showUndo={showUndo}
        onUndo={onUndo}
        canFork={canFork}
        showFork={showFork}
        onFork={onFork}
      />
    </>
  );
}

type TranscriptPhase = {
  activity: Array<{ segment: TranscriptSegment; index: number }>;
  response: TranscriptSegment | null;
  responseIndex: number;
};

function groupTranscriptPhases(transcript: TranscriptSegment[]): TranscriptPhase[] {
  const phases: TranscriptPhase[] = [];
  let activity: TranscriptPhase['activity'] = [];

  transcript.forEach((segment, index) => {
    if (segment.kind === 'response') {
      phases.push({ activity, response: segment, responseIndex: index });
      activity = [];
      return;
    }
    activity.push({ segment, index });
  });

  if (activity.length > 0) {
    phases.push({ activity, response: null, responseIndex: -1 });
  }

  return phases;
}

function phaseSummaryTitle(activity: TranscriptSegment[], includesResponse = false): string {
  let hasThought = false;
  let toolCount = 0;
  for (const segment of activity) {
    if (segment.kind === 'thought') hasThought = true;
    if (segment.kind === 'tools') toolCount += segment.traceKeys.length;
  }
  if (hasThought && toolCount > 0) {
    return `Thought and used ${toolCount} tool${toolCount === 1 ? '' : 's'}`;
  }
  if (hasThought) return 'Thought';
  if (toolCount > 0) return `Used ${toolCount} tool${toolCount === 1 ? '' : 's'}`;
  if (includesResponse) return 'Responded';
  return 'Worked';
}

function isSingleThoughtPhase(phase: TranscriptPhase): boolean {
  return phase.activity.length === 1 && phase.activity[0]?.segment.kind === 'thought';
}

function isToolsOnlyPhase(phase: TranscriptPhase): boolean {
  return phase.activity.length > 0 && phase.activity.every((item) => item.segment.kind === 'tools');
}

function renderCollapsedPhase({
  runId,
  phase,
  traces,
  live,
  foldResponseIntoPhase,
  responseNode,
  phaseEditStats,
}: {
  runId: string;
  phase: TranscriptPhase;
  traces: TraceEvent[];
  live: boolean;
  foldResponseIntoPhase: boolean;
  responseNode: ReactNode;
  phaseEditStats: EditStats | null;
}) {
  // A lone thought phase: one "Thought for Ns" row that expands to content
  // (and the intermediate response when that was folded in). Never nest a
  // second Thought disclosure under a "Thought" summary.
  if (isSingleThoughtPhase(phase)) {
    const thought = phase.activity[0]!.segment;
    if (thought.kind !== 'thought') return null;
    if (foldResponseIntoPhase) {
      // Title must not read as "only thought" when a mid-respond is nested as sibling.
      return (
        <WorkflowPhaseSummary title={`${thoughtLabel(thought, live)} · Responded`}>
          <ThoughtContent cacheKey={`${runId}:${thought.key}`} segment={thought} />
          {responseNode}
        </WorkflowPhaseSummary>
      );
    }
    return <ThoughtSegment cacheKey={`${runId}:${thought.key}`} segment={thought} live={live} />;
  }

  // Tools-only with no intermediate response to fold: ActivityGroup already
  // owns the concise summary + single-edit diff path — avoid a second wrapper.
  if (isToolsOnlyPhase(phase) && !foldResponseIntoPhase && phase.activity.length === 1) {
    return renderWorkflowSegment(runId, phase.activity[0]!.segment, traces, live);
  }

  return (
    <WorkflowPhaseSummary
      title={phaseSummaryTitle(
        phase.activity.map((item) => item.segment),
        foldResponseIntoPhase,
      )}
      editStats={phaseEditStats ?? undefined}
    >
      {phase.activity.map(({ segment }) =>
        renderWorkflowSegment(runId, segment, traces, live, { embedded: true }),
      )}
      {foldResponseIntoPhase ? responseNode : null}
    </WorkflowPhaseSummary>
  );
}

function renderWorkflowSegment(
  runId: string,
  segment: TranscriptSegment,
  traces: TraceEvent[],
  live: boolean,
  options: { embedded?: boolean } = {},
) {
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
  return <ActivityGroup key={segment.key} traces={groupTraces} embedded={options.embedded} />;
}

/** Resolve tool traces that belong to one workflow phase (scoped, not global). */
function tracesForPhase(phase: TranscriptPhase, traces: TraceEvent[]): TraceEvent[] {
  const keys: string[] = [];
  for (const { segment } of phase.activity) {
    if (segment.kind === 'tools') keys.push(...segment.traceKeys);
  }
  return keys
    .map((key) => traces.find((trace) => trace.key === key))
    .filter((trace): trace is TraceEvent => Boolean(trace));
}

/** Compact disclosure for a closed workflow phase (thoughts + tools, with or without an intermediate response). */
function WorkflowPhaseSummary({
  title,
  editStats,
  children,
}: {
  title: string;
  editStats?: EditStats;
  children: ReactNode;
}) {
  const [expanded, setExpanded] = useState(false);
  const showStats = editStats != null && (editStats.additions > 0 || editStats.deletions > 0);
  return (
    <section className={`transcript-phase${expanded ? ' is-expanded' : ''}`}>
      <button type="button" onClick={() => setExpanded((value) => !value)} aria-expanded={expanded}>
        <span>{title}</span>
        {showStats ? (
          <span className="activity-diff-stats">
            {editStats.additions > 0 ? (
              <span className="is-add">+{editStats.additions}</span>
            ) : null}{' '}
            {editStats.deletions > 0 ? (
              <span className="is-del">−{editStats.deletions}</span>
            ) : null}
          </span>
        ) : null}
        <ChevronDown size={14} strokeWidth={1.7} aria-hidden />
      </button>
      {expanded ? <div className="transcript-phase-body">{children}</div> : null}
    </section>
  );
}

function resolveFinalResponse(
  transcript: TranscriptSegment[],
  live: boolean,
  responseTerminalReady: boolean,
  fallbackText?: string,
): { finalIndex: number; finalText: string } {
  if (live) {
    const trailing = transcript.at(-1);
    if (trailing?.kind === 'response') {
      return { finalIndex: transcript.length - 1, finalText: trailing.text };
    }
    if (transcript.some((segment) => segment.kind === 'response')) {
      return { finalIndex: -1, finalText: '' };
    }
    return { finalIndex: -1, finalText: fallbackText || '' };
  }

  // `done` is not enough: streamStore deliberately records it before the
  // terminal ACP event in some backends. Do not expose an intermediate
  // response as the final answer during that short hand-off window.
  if (!responseTerminalReady) {
    return { finalIndex: -1, finalText: '' };
  }

  for (let index = transcript.length - 1; index >= 0; index -= 1) {
    const segment = transcript[index];
    if (segment?.kind === 'response') {
      return { finalIndex: index, finalText: segment.text };
    }
  }
  return { finalIndex: -1, finalText: fallbackText || '' };
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
  const label = thoughtLabel(segment, live);
  return (
    <section
      className={`transcript-thought${expanded ? ' is-expanded' : ''}${live && segment.endedAt == null ? ' is-running' : ''}`}
    >
      <button type="button" onClick={() => setExpanded((value) => !value)} aria-expanded={expanded}>
        <span>{label}</span>
        <ChevronDown size={14} strokeWidth={1.7} aria-hidden />
      </button>
      {expanded ? <ThoughtContent cacheKey={cacheKey} segment={segment} /> : null}
    </section>
  );
}

function thoughtLabel(
  segment: Extract<TranscriptSegment, { kind: 'thought' }>,
  live: boolean,
): string {
  const duration = Math.max(0, (segment.endedAt ?? Date.now()) - segment.startedAt);
  return live && segment.endedAt == null
    ? 'Thinking…'
    : duration < 500
      ? 'Thought briefly'
      : `Thought for ${formatWorkedDuration(duration)}`;
}

function ThoughtContent({
  cacheKey,
  segment,
}: {
  cacheKey: string;
  segment: Extract<TranscriptSegment, { kind: 'thought' }>;
}) {
  const previewTruncated = isUpstreamTruncatedThought(segment.text);
  return (
    <section className="transcript-thought transcript-thought-content-only">
      {segment.text ? (
        <MarkdownSegment
          cacheKey={cacheKey}
          text={segment.text}
          className="transcript-thought-body"
        />
      ) : null}
      {previewTruncated ? (
        <div className="transcript-thought-truncated" role="note">
          Preview truncated upstream
        </div>
      ) : null}
    </section>
  );
}

function isUpstreamTruncatedThought(text: string): boolean {
  const trimmed = text.trimEnd();
  // Grok Build currently caps visible reasoning summaries at 200 characters,
  // then appends `...`. The full reasoning remains encrypted upstream, so the
  // desktop client must identify the preview honestly instead of presenting a
  // clipped sentence as complete. Keep the range narrow to avoid labelling a
  // short, intentional ellipsis as truncation.
  return trimmed.length >= 190 && trimmed.length <= 220 && /\.\.\.$/u.test(trimmed);
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
    <MarkdownHtml
      html={safeHtml}
      owner={cacheKey}
      className={`message-body markdown-body ${className}`}
    />
  ) : (
    <pre className={`message-body streaming-raw ${className}`}>{text}</pre>
  );
}

function MarkdownHtml({
  html,
  owner,
  className,
}: {
  html: string;
  owner: string;
  className?: string;
}) {
  const ref = useRef<HTMLDivElement>(null);

  useLayoutEffect(() => {
    const root = ref.current;
    if (!root) return;
    return attachTableScroll(owner, root);
  }, [html, owner]);

  return (
    <div
      ref={ref}
      className={className}
      dangerouslySetInnerHTML={{ __html: html }}
      onClick={handleMarkdownClick}
    />
  );
}

function compactionLabel(compaction: RunCompaction): string | null {
  if (compaction.status === 'cancelled') return null;
  if (compaction.status === 'failed') return t('message.compactFailed');
  if (compaction.status === 'done') return t('message.compacted');
  if (compaction.percentage != null) {
    return t('message.compactingPercent', { percent: Math.round(compaction.percentage) });
  }
  return t('message.compacting');
}

function WatchingRail({ startedAt }: { startedAt: number }) {
  const elapsed = useElapsed(startedAt, null);
  const label = t('message.watchingFor', {
    duration: formatWorkedDuration(elapsed ?? 0),
  });
  return (
    <section className="message-worked-rail transcript-work is-live" role="status">
      <div className="message-worked">
        <span className="message-worked-summary is-shimmer" data-label={label}>
          {label}
        </span>
      </div>
    </section>
  );
}

function CompactionHint({ compaction }: { compaction?: RunCompaction | null }) {
  if (!compaction) return null;
  const label = compactionLabel(compaction);
  if (!label) return null;
  const live = compaction.status === 'running';
  return (
    <div className="message-compaction" role="status">
      <span className={`message-worked-summary${live ? ' is-shimmer' : ''}`} data-label={label}>
        {label}
      </span>
    </div>
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
