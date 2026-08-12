import { useEffect, useRef, useState } from 'react';
import { ChevronDown } from 'lucide-react';
import { useElapsed } from '../hooks/useElapsed';
import { useRunSnapshot } from '../hooks/useRunSnapshot';
import type { RunSnapshot } from '../lib/streamStore';
import { displayEdit, isEditTrace, sumEditStats } from '../lib/editStats';
import type { TraceEvent, TraceStatus } from '../lib/traceParser';
import { t } from '../i18n';

interface Props {
  runId: string;
  workedLabel?: string;
  fallbackTraces?: TraceEvent[];
}

/**
 * Compact, message-local activity rail. The current action is always visible;
 * individual tools and subagents stay behind one disclosure so a long task
 * does not become a wall of cards.
 */
export function TraceTimeline({ runId, workedLabel, fallbackTraces = [] }: Props) {
  const snapshot = useRunSnapshot(runId);
  const availableTraces = snapshot?.traces.length ? snapshot.traces : fallbackTraces;
  const traces = availableTraces.filter(isVisibleTrace);
  const [expanded, setExpanded] = useState(false);
  const hasError = traces.some((trace) => trace.status === 'error');

  useEffect(() => {
    if (hasError) setExpanded(true);
  }, [hasError]);

  if (workedLabel) {
    return (
      <section className={`message-worked-rail${expanded ? ' is-expanded' : ''}`}>
        {traces.length > 0 ? (
          <button
            type="button"
            className="message-worked"
            onClick={() => setExpanded((value) => !value)}
            aria-expanded={expanded}
          >
            <span className="message-worked-summary">{workedLabel}</span>
            <ChevronDown
              className="message-worked-chevron"
              size={17}
              strokeWidth={1.8}
              aria-hidden
            />
          </button>
        ) : (
          <div className="message-worked" aria-label={workedLabel}>
            <span>{workedLabel}</span>
          </div>
        )}
        {expanded && traces.length > 0 ? <ActivityGroup traces={traces} /> : null}
      </section>
    );
  }

  if (!snapshot || (traces.length === 0 && !isLive(snapshot))) return null;

  return (
    <section className={`activity-rail${expanded ? ' is-expanded' : ''}`}>
      <ActivitySummary
        snapshot={snapshot}
        traces={traces}
        expanded={expanded}
        expandable={traces.length > 0}
        onToggle={() => setExpanded((value) => !value)}
      />
      {expanded && traces.length > 0 ? (
        <div className="activity-list" aria-label={t('message.traceAriaLabel')}>
          {traces.map((trace) => (
            <ActivityRow key={trace.key} trace={trace} />
          ))}
        </div>
      ) : null}
    </section>
  );
}

export function ActivityGroup({
  traces,
  hideEditDetails = false,
  embedded = false,
}: {
  traces: TraceEvent[];
  /** Phase headings already expose edit totals; avoid repeating edit rows below. */
  hideEditDetails?: boolean;
  /**
   * When nested under a workflow phase summary, render each tool once without
   * a second group summary. Single-edit keeps the concise Edited-file row that
   * opens its diff directly (no duplicate full-path row).
   */
  embedded?: boolean;
}) {
  const visible = traces.filter(isVisibleTrace);
  const [expanded, setExpanded] = useState(false);
  const [settlingTrace, setSettlingTrace] = useState<TraceEvent | null>(null);
  const settleTimer = useRef<number | null>(null);
  const previousActiveKeyRef = useRef<string | null>(null);
  // Newest running call only — collapsed groups stage that one row.
  const activeTrace =
    [...visible].reverse().find((trace) => trace.status === 'running') ?? null;
  const activeKey = activeTrace?.key ?? null;
  // Stable content signature so settle logic does not re-fire on new array identity.
  const tracesFingerprint = visible.map((trace) => `${trace.key}:${trace.status}`).join('\0');

  useEffect(() => {
    return () => {
      if (settleTimer.current != null) window.clearTimeout(settleTimer.current);
    };
  }, []);

  useEffect(() => {
    const clearSettleTimer = () => {
      if (settleTimer.current != null) {
        window.clearTimeout(settleTimer.current);
        settleTimer.current = null;
      }
    };

    const previousKey = previousActiveKeyRef.current;
    if (activeKey) {
      clearSettleTimer();
      if (previousKey && previousKey !== activeKey) {
        const finished = visible.find((trace) => trace.key === previousKey);
        if (finished && finished.status !== 'running') {
          setSettlingTrace(finished);
          settleTimer.current = window.setTimeout(() => {
            setSettlingTrace(null);
            settleTimer.current = null;
          }, 420);
        }
      }
      previousActiveKeyRef.current = activeKey;
      return;
    }

    previousActiveKeyRef.current = null;
    if (!previousKey) return;

    const finished = visible.find((trace) => trace.key === previousKey);
    if (!finished || finished.status === 'running') return;

    clearSettleTimer();
    setSettlingTrace(finished);
    settleTimer.current = window.setTimeout(() => {
      setSettlingTrace(null);
      settleTimer.current = null;
    }, 420);

    return;
    // visible is read via tracesFingerprint; listing it would churn on every parent render.
    // eslint-disable-next-line react-hooks/exhaustive-deps -- fingerprint tracks visible content
  }, [activeKey, tracesFingerprint]);

  if (visible.length === 0) return null;

  const singleEdit = visible.length === 1 && isEditTrace(visible[0]!) ? visible[0] : undefined;
  const editStats = visible.map(displayEdit);
  const additions = editStats.reduce((total, edit) => total + edit.additions, 0);
  const deletions = editStats.reduce((total, edit) => total + edit.deletions, 0);
  const summary = singleEdit
    ? `Edited ${shortPath(singleEdit.path) || singleEdit.label.replace(/^Edit\s*/iu, '')}`
    : summarizeTraces(visible);
  const detailTraces = hideEditDetails ? visible.filter((trace) => !isEditTrace(trace)) : visible;

  // Nested under a phase summary: one row per tool, no second group chrome.
  // Single edit retains the concise Edited-file control that opens the diff.
  if (embedded) {
    if (singleEdit) {
      return (
        <section className={`transcript-tool-group${expanded ? ' is-expanded' : ''}`}>
          <button
            type="button"
            className="transcript-tool-summary"
            onClick={() => setExpanded((value) => !value)}
            aria-expanded={expanded}
          >
            <span>{summary}</span>
            {additions > 0 || deletions > 0 ? (
              <span className="activity-diff-stats">
                {additions > 0 ? <span className="is-add">+{additions}</span> : null}{' '}
                {deletions > 0 ? <span className="is-del">−{deletions}</span> : null}
              </span>
            ) : null}
            <ChevronDown size={14} strokeWidth={1.7} aria-hidden />
          </button>
          {expanded ? (
            <div
              className="activity-list message-worked-list"
              aria-label={t('message.traceAriaLabel')}
            >
              <EditDetail trace={singleEdit} />
            </div>
          ) : null}
        </section>
      );
    }
    return (
      <div className="activity-list message-worked-list" aria-label={t('message.traceAriaLabel')}>
        {detailTraces.map((trace) => (
          <ActivityRow key={trace.key} trace={trace} />
        ))}
      </div>
    );
  }

  // Collapsed: one staged row (enter while running, settle on completion).
  // Expanded: every row once, static aside from the running-label shimmer in CSS.
  const stagedRows = !expanded && (settlingTrace || activeTrace) ? (
    <>
      {settlingTrace && (!hideEditDetails || !isEditTrace(settlingTrace)) ? (
        <ActivityRow key={`settle:${settlingTrace.key}`} trace={settlingTrace} motion="settle" />
      ) : null}
      {activeTrace && (!hideEditDetails || !isEditTrace(activeTrace)) ? (
        <ActivityRow key={`enter:${activeTrace.key}`} trace={activeTrace} motion="enter" />
      ) : null}
    </>
  ) : null;

  return (
    <section className={`transcript-tool-group${expanded ? ' is-expanded' : ''}`}>
      <button
        type="button"
        className="transcript-tool-summary"
        onClick={() => setExpanded((value) => !value)}
        aria-expanded={expanded}
      >
        <span>{summary}</span>
        {additions > 0 || deletions > 0 ? (
          <span className="activity-diff-stats">
            {additions > 0 ? <span className="is-add">+{additions}</span> : null}{' '}
            {deletions > 0 ? <span className="is-del">−{deletions}</span> : null}
          </span>
        ) : null}
        <ChevronDown size={14} strokeWidth={1.7} aria-hidden />
      </button>
      {expanded || stagedRows ? (
        <div className="activity-list message-worked-list" aria-label={t('message.traceAriaLabel')}>
          {expanded ? (
            singleEdit ? (
              <EditDetail trace={singleEdit} />
            ) : (
              detailTraces.map((trace) => <ActivityRow key={trace.key} trace={trace} />)
            )
          ) : stagedRows}
        </div>
      ) : null}
    </section>
  );
}

function EditDetail({ trace }: { trace: TraceEvent }) {
  const edit = displayEdit(trace);
  if (!edit.diff) return null;
  return (
    <div className="activity-detail-surface">
      <pre className="activity-diff" aria-label={`Changes to ${trace.path || trace.label}`}>
        {parseDiff(edit.diff).map((line, index) => (
          <span key={`${index}:${line.text}`} className={`activity-diff-line is-${line.kind}`}>
            <span className="activity-diff-number" aria-hidden>
              {index + 1}
            </span>
            <span className="activity-diff-sign" aria-hidden>
              {line.kind === 'add' ? '+' : line.kind === 'del' ? '−' : ' '}
            </span>
            <code>{line.text}</code>
          </span>
        ))}
      </pre>
    </div>
  );
}

function isVisibleTrace(trace: TraceEvent): boolean {
  return !(
    trace.kind === 'tool' &&
    trace.label === 'Tool' &&
    trace.detail == null &&
    trace.progress == null &&
    trace.raw == null
  );
}

function ActivitySummary({
  snapshot,
  traces,
  expanded,
  expandable,
  onToggle,
}: {
  snapshot: RunSnapshot;
  traces: TraceEvent[];
  expanded: boolean;
  expandable: boolean;
  onToggle: () => void;
}) {
  const elapsed = useElapsed(
    snapshot.startedAt,
    isLive(snapshot) ? snapshot.endedAt : (snapshot.endedAt ?? snapshot.startedAt),
  );
  const label = isLive(snapshot)
    ? liveLabel(snapshot)
    : traces.length > 0
      ? summarizeTraces(traces)
      : liveLabel(snapshot);
  const editTotals = sumEditStats(traces);
  const meta = summaryMeta(snapshot, elapsed);
  const content = (
    <>
      <span className={`activity-mark${isLive(snapshot) ? ' is-live' : ''}`} aria-hidden />
      <span className="activity-label" aria-live={isLive(snapshot) ? 'polite' : undefined}>
        {label}
      </span>
      {editTotals.additions > 0 || editTotals.deletions > 0 ? (
        <span className="activity-diff-stats">
          {editTotals.additions > 0 ? (
            <span className="is-add">+{editTotals.additions}</span>
          ) : null}{' '}
          {editTotals.deletions > 0 ? (
            <span className="is-del">−{editTotals.deletions}</span>
          ) : null}
        </span>
      ) : null}
      {meta ? <span className="activity-meta">{meta}</span> : null}
      {expandable ? (
        <ChevronDown className="activity-chevron" size={13} strokeWidth={1.7} aria-hidden />
      ) : null}
    </>
  );

  return expandable ? (
    <button type="button" className="activity-summary" onClick={onToggle} aria-expanded={expanded}>
      {content}
    </button>
  ) : (
    <div className="activity-summary" role="status">
      {content}
    </div>
  );
}

export function ActivityRow({
  trace,
  motion,
}: {
  trace: TraceEvent;
  motion?: 'enter' | 'settle';
}) {
  // Subagent (and tool) detail bodies stay collapsed until the user opens the
  // summary row — never auto-open nested activity inside Work for / TraceTimeline.
  const [expanded, setExpanded] = useState(false);
  const elapsed = useElapsed(trace.startedAt, trace.endedAt);
  const duration =
    trace.status === 'running' && elapsed != null ? formatDuration(Math.max(0, elapsed)) : null;
  const isEdit = isEditTrace(trace);
  const edit = displayEdit(trace);
  const label =
    trace.kind === 'subagent'
      ? `Subagent · ${trace.label}`
      : isEdit && trace.path
        ? `Edited ${trace.path}`
        : trace.label;
  const hasBody = Boolean(edit.diff || trace.detail);
  const diffLines = edit.diff ? parseDiff(edit.diff) : [];
  const rowContent = (
    <>
      <span className={`activity-row-mark status-${trace.status}`} aria-hidden>
        {statusIcon(trace.status)}
      </span>
      <span
        className="activity-row-label"
        aria-live={trace.status === 'running' ? 'polite' : undefined}
      >
        {label}
      </span>
      {isEdit ? (
        <span className="activity-diff-stats">
          {edit.additions > 0 ? <span className="is-add">+{edit.additions}</span> : null}{' '}
          {edit.deletions > 0 ? <span className="is-del">−{edit.deletions}</span> : null}
        </span>
      ) : null}
      {trace.progress ? <span className="activity-row-progress">{trace.progress}</span> : null}
      {duration ? <span className="activity-row-time">{duration}</span> : null}
      {hasBody ? <ChevronDown className="activity-row-chevron" size={13} aria-hidden /> : null}
    </>
  );

  return (
    <div
      className={`activity-item activity-kind-${trace.kind} activity-status-${trace.status}${isEdit ? ' activity-is-edit' : ''}${expanded ? ' row-open' : ''}${motion ? ` activity-motion-${motion}` : ''}`}
      data-parent={trace.parentKey || undefined}
    >
      {hasBody ? (
        <button
          type="button"
          className="activity-row"
          onClick={() => setExpanded((value) => !value)}
          aria-expanded={expanded}
        >
          {rowContent}
        </button>
      ) : (
        <div className="activity-row">{rowContent}</div>
      )}
      {expanded && hasBody ? (
        <div className="activity-detail-surface">
          {edit.diff ? (
            <pre className="activity-diff" aria-label={`Changes to ${trace.path || trace.label}`}>
              {diffLines.map((line, index) => (
                <span
                  key={`${index}:${line.text}`}
                  className={`activity-diff-line is-${line.kind}`}
                >
                  <span className="activity-diff-number" aria-hidden>
                    {index + 1}
                  </span>
                  <span className="activity-diff-sign" aria-hidden>
                    {line.kind === 'add' ? '+' : line.kind === 'del' ? '−' : ' '}
                  </span>
                  <code>{line.text}</code>
                </span>
              ))}
            </pre>
          ) : (
            <pre className="activity-detail">
              <code>{trace.detail}</code>
            </pre>
          )}
        </div>
      ) : null}
    </div>
  );
}

function shortPath(path: string | undefined): string | undefined {
  if (!path) return undefined;
  return path.split('/').filter(Boolean).at(-1) ?? path;
}

function parseDiff(diff: string): Array<{ kind: 'add' | 'del' | 'context'; text: string }> {
  return diff
    .split('\n')
    .map((line) =>
      line.startsWith('+')
        ? { kind: 'add' as const, text: line.slice(1) }
        : line.startsWith('-')
          ? { kind: 'del' as const, text: line.slice(1) }
          : { kind: 'context' as const, text: line.startsWith(' ') ? line.slice(1) : line },
    );
}

function isLive(snapshot: RunSnapshot): boolean {
  return snapshot.state === 'queued' || snapshot.state === 'running';
}

function liveLabel(snapshot: RunSnapshot): string {
  const active = snapshot.traces.filter((trace) => trace.status === 'running');
  const latest = active.at(-1);
  if (latest) return latest.label;
  if (!isLive(snapshot)) {
    const failed = snapshot.traces.filter((trace) => trace.status === 'error').length;
    if (failed > 0) return 'Finished with errors';
    return 'Finished';
  }
  if (snapshot.lastEventType === 'thought') return t('statusBar.thinking');
  if (snapshot.lastEventType === 'text') return t('statusBar.writing');
  return t('statusBar.working');
}

function summaryMeta(snapshot: RunSnapshot, elapsed: number | null): string {
  const parts: string[] = [];
  if (elapsed != null) parts.push(formatDuration(elapsed));
  if (snapshot.usage?.totalTokens) parts.push(formatTokens(snapshot.usage.totalTokens));
  if (snapshot.usage?.turns) {
    parts.push(`${snapshot.usage.turns} ${snapshot.usage.turns === 1 ? 'turn' : 'turns'}`);
  }
  return parts.join(' · ');
}

function summarizeTraces(traces: TraceEvent[]): string {
  if (traces.length === 1 && isEditTrace(traces[0]!)) {
    const trace = traces[0]!;
    return `Edited ${shortPath(trace.path) || trace.label.replace(/^Edit\s*/iu, '')}`;
  }
  const counts = {
    reads: 0,
    searches: 0,
    fetches: 0,
    commands: 0,
    edits: 0,
    subagents: 0,
    plans: 0,
    tools: 0,
  };

  for (const trace of traces) {
    if (trace.kind === 'subagent') {
      counts.subagents += 1;
      continue;
    }
    if (trace.kind === 'task') {
      counts.plans += 1;
      continue;
    }
    const label = trace.label.trim().toLowerCase();
    if (/^(read|list|explore|inspect)\b/u.test(label)) counts.reads += 1;
    else if (/^(search|grep|find|glob)\b/u.test(label)) counts.searches += 1;
    else if (/^(fetch|open url|browse|web)\b/u.test(label)) counts.fetches += 1;
    else if (/^(execute|run|terminal|shell)\b/u.test(label)) counts.commands += 1;
    else if (/^(write|edit|patch|create|delete|move|rename)\b/u.test(label)) counts.edits += 1;
    else counts.tools += 1;
  }

  const parts: string[] = [];
  if (counts.reads) parts.push(`read ${countWithNoun(counts.reads, 'file')}`);
  if (counts.searches) parts.push(`searched ${countWithNoun(counts.searches, 'time')}`);
  if (counts.fetches) parts.push(`fetched ${countWithNoun(counts.fetches, 'page')}`);
  if (counts.commands) parts.push(`ran ${countWithNoun(counts.commands, 'command')}`);
  if (counts.edits) parts.push(`made ${countWithNoun(counts.edits, 'edit')}`);
  if (counts.subagents) parts.push(`used ${countWithNoun(counts.subagents, 'subagent')}`);
  if (counts.plans) parts.push(`updated ${countWithNoun(counts.plans, 'plan')}`);
  if (counts.tools) parts.push(`used ${countWithNoun(counts.tools, 'tool')}`);

  const summary = parts.join(', ') || 'worked';
  return `${summary[0]!.toUpperCase()}${summary.slice(1)}`;
}

function countWithNoun(count: number, noun: string): string {
  return `${count} ${noun}${count === 1 ? '' : 's'}`;
}

function formatTokens(tokens: number): string {
  if (tokens >= 1000) return `${(tokens / 1000).toFixed(tokens >= 10_000 ? 0 : 1)}k tokens`;
  return `${tokens} tokens`;
}

function statusIcon(status: TraceStatus): string {
  if (status === 'done') return '✓';
  if (status === 'error') return '×';
  if (status === 'cancelled') return '–';
  return '';
}

function formatDuration(ms: number): string {
  if (ms < 1000) return `${Math.round(ms)}ms`;
  if (ms < 60_000) return `${(ms / 1000).toFixed(ms < 10_000 ? 1 : 0)}s`;
  const minutes = Math.floor(ms / 60_000);
  const seconds = Math.round((ms % 60_000) / 1000);
  return `${minutes}m ${seconds}s`;
}
