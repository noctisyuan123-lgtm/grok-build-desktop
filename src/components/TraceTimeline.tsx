import { useEffect, useState } from 'react';
import { ChevronDown } from 'lucide-react';
import { useElapsed } from '../hooks/useElapsed';
import { useRunSnapshot } from '../hooks/useRunSnapshot';
import type { RunSnapshot } from '../lib/streamStore';
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

export function ActivityGroup({ traces }: { traces: TraceEvent[] }) {
  const visible = traces.filter(isVisibleTrace);
  const [expanded, setExpanded] = useState(false);
  if (visible.length === 0) return null;
  return (
    <section className={`transcript-tool-group${expanded ? ' is-expanded' : ''}`}>
      <button
        type="button"
        className="transcript-tool-summary"
        onClick={() => setExpanded((value) => !value)}
        aria-expanded={expanded}
      >
        <span>{summarizeTraces(visible)}</span>
        <ChevronDown size={14} strokeWidth={1.7} aria-hidden />
      </button>
      {expanded ? (
        <div className="activity-list message-worked-list" aria-label={t('message.traceAriaLabel')}>
          {visible.map((trace) => (
            <ActivityRow key={trace.key} trace={trace} />
          ))}
        </div>
      ) : null}
    </section>
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
  const meta = summaryMeta(snapshot, elapsed);
  const content = (
    <>
      <span className={`activity-mark${isLive(snapshot) ? ' is-live' : ''}`} aria-hidden />
      <span className="activity-label" aria-live={isLive(snapshot) ? 'polite' : undefined}>
        {label}
      </span>
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

export function ActivityRow({ trace }: { trace: TraceEvent }) {
  const [expanded, setExpanded] = useState(false);
  const elapsed = useElapsed(trace.startedAt, trace.endedAt);
  const duration =
    trace.status === 'running' && elapsed != null ? formatDuration(Math.max(0, elapsed)) : null;
  const isEdit = trace.diff != null || trace.additions != null || trace.deletions != null;
  const label =
    trace.kind === 'subagent'
      ? `Subagent · ${trace.label}`
      : isEdit && trace.path
        ? `Edited ${trace.path}`
        : trace.label;
  const hasBody = Boolean(trace.diff || trace.detail);
  const diffLines = trace.diff ? parseDiff(trace.diff) : [];
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
          <span className="is-add">+{trace.additions ?? 0}</span>{' '}
          <span className="is-del">−{trace.deletions ?? 0}</span>
        </span>
      ) : null}
      {trace.progress ? <span className="activity-row-progress">{trace.progress}</span> : null}
      {duration ? <span className="activity-row-time">{duration}</span> : null}
      {hasBody ? <ChevronDown className="activity-row-chevron" size={13} aria-hidden /> : null}
    </>
  );

  return (
    <div
      className={`activity-item activity-kind-${trace.kind} activity-status-${trace.status}${expanded ? ' row-open' : ''}`}
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
          {trace.diff ? (
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
