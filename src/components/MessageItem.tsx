import {
  memo,
  useEffect,
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
import { PlanTodoList, resolvePlanEntriesFromTraces } from './PlanTodoList';
import { t } from '../i18n';
import { useElapsed } from '../hooks/useElapsed';
import { sumEditStats, type EditStats } from '../lib/editStats';
import type { PlanEntry, TraceEvent } from '../lib/traceParser';
import type { TranscriptSegment } from '../lib/streamStore';

interface Props {
  runId: string;
  fallbackText?: string;
  durationMs?: number;
  fallbackTraces?: TraceEvent[];
  fallbackTranscript?: TranscriptSegment[];
  planEntries?: PlanEntry[];
  showPlan?: boolean;
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
  planEntries: persistedPlan,
  showPlan = false,
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
  const livePlan = useMemo(
    () => resolvePlanEntriesFromTraces(snap?.traces?.length ? snap.traces : fallbackTraces),
    [snap?.traces, fallbackTraces],
  );
  const planEntries = livePlan ?? persistedPlan ?? null;
  const planVisible = Boolean(planEntries?.length) && (runIsLive || showPlan);
  const planNode = planVisible && planEntries ? <PlanTodoList entries={planEntries} /> : null;
  // The queue can publish a terminal state before the stream's `end` event.
  // Keep the transcript in its live/intermediate shape until that event has
  // actually arrived, otherwise the last intermediate response briefly gets
  // promoted into the final answer and then jumps back into the work rail.
  const responseTerminalReady =
    !snap || snap.lastEventType === 'end' || snap.stopReason != null;

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
          responseTerminalReady
          startedAt={null}
          autoExpandWork={autoExpandWork}
          canUndo={canUndo}
          onUndo={onUndo}
          planNode={planNode}
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
          {planNode}
          <MessageActions sourceText={fallbackText || ''} canUndo={canUndo} onUndo={onUndo} />
        </>
      );
    }
    if (fallbackText) {
      return (
        <>
          {workedRow}
          <pre className="message-body">{fallbackText}</pre>
          {planNode}
          <MessageActions sourceText={fallbackText} canUndo={canUndo} onUndo={onUndo} />
        </>
      );
    }
    return planNode;
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
          responseTerminalReady={responseTerminalReady}
          startedAt={snap.startedAt}
          autoExpandWork={autoExpandWork}
          canUndo={canUndo && !runIsLive}
          onUndo={onUndo}
          planNode={planNode}
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
          {planNode}
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
  responseTerminalReady,
  startedAt,
  autoExpandWork,
  canUndo,
  onUndo,
  planNode,
}: {
  runId: string;
  transcript: TranscriptSegment[];
  traces: TraceEvent[];
  workedLabel?: string;
  fallbackText?: string;
  live: boolean;
  responseTerminalReady: boolean;
  startedAt: number | null;
  autoExpandWork: boolean;
  canUndo: boolean;
  onUndo?: () => void;
  planNode?: ReactNode;
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
              {phases.map((phase, phaseIndex) => {
                const hasClosedResponse = phase.response?.kind === 'response';
                // Exterior final answer sits outside the work rail. Any other
                // closed response (including live intermediates while tools
                // continue) folds its preceding activity once it exists.
                const isExteriorFinal =
                  hasClosedResponse &&
                  finalIndex >= 0 &&
                  phase.responseIndex === finalIndex;
                const foldResponseIntoPhase = hasClosedResponse && !isExteriorFinal;
                // Fold only after a response closes the phase. Before that,
                // thought/tool/thought stays live and chronological.
                // A response closes *all* prior activity, including the
                // very first thought before the final response. The final
                // response itself stays outside Worked for, but its leading
                // thought/tools still become one disclosure.
                const collapsePhase = phase.activity.length > 0 && hasClosedResponse;
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
                const phaseEditStats = collapsePhase
                  ? sumEditStats(tracesForPhase(phase, traces))
                  : null;
                const phaseKey = `phase:${phaseIndex}:${phase.activity[0]?.segment.key ?? phase.response?.key ?? phaseIndex}`;
                return (
                  <div key={phaseKey} className="transcript-phase-block">
                    {collapsePhase ? (
                      renderCollapsedPhase({
                        runId,
                        phase,
                        traces,
                        live,
                        foldResponseIntoPhase,
                        responseNode,
                        phaseEditStats,
                      })
                    ) : (
                      <>
                        {phase.activity.map(({ segment }) =>
                          renderWorkflowSegment(runId, segment, traces, live),
                        )}
                        {/* Intermediate responses with no preceding activity
                            (or while still open) stay visible in the work rail. */}
                        {foldResponseIntoPhase ? responseNode : null}
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
        <MarkdownSegment cacheKey={runId} text={finalText} className="markdown-streaming" />
      ) : null}
      {planNode}
      <MessageActions sourceText={finalText} canUndo={canUndo} onUndo={onUndo} />
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
    return (
      <ThoughtSegment
        cacheKey={`${runId}:${thought.key}`}
        segment={thought}
        live={live}
      >
        {foldResponseIntoPhase ? responseNode : null}
      </ThoughtSegment>
    );
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
  return (
    <ActivityGroup
      key={segment.key}
      traces={groupTraces}
      embedded={options.embedded}
    />
  );
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
  const showStats =
    editStats != null && (editStats.additions > 0 || editStats.deletions > 0);
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
  children,
}: {
  cacheKey: string;
  segment: Extract<TranscriptSegment, { kind: 'thought' }>;
  live: boolean;
  /** Optional trailing content (e.g. folded intermediate response) shown when expanded. */
  children?: ReactNode;
}) {
  const [expanded, setExpanded] = useState(false);
  const duration = Math.max(0, (segment.endedAt ?? Date.now()) - segment.startedAt);
  const previewTruncated = isUpstreamTruncatedThought(segment.text);
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
      {expanded ? (
        <>
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
          {children}
        </>
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
