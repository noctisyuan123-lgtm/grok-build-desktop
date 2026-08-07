import { useEffect, useState } from 'react';
import { ChevronDown } from 'lucide-react';
import { useElapsed } from '../hooks/useElapsed';
import { useRunSnapshot } from '../hooks/useRunSnapshot';
import type { RunSnapshot } from '../lib/streamStore';
import type { TraceEvent, TraceStatus } from '../lib/traceParser';
import { t } from '../i18n';

interface Props {
  runId: string;
}

/**
 * Compact, message-local activity rail. The current action is always visible;
 * individual tools and subagents stay behind one disclosure so a long task
 * does not become a wall of cards.
 */
export function TraceTimeline({ runId }: Props) {
  const snapshot = useRunSnapshot(runId);
  const traces = snapshot?.traces ?? [];
  const [expanded, setExpanded] = useState(false);
  const hasError = traces.some((trace) => trace.status === 'error');

  useEffect(() => {
    if (hasError) setExpanded(true);
  }, [hasError]);

  if (!snapshot || (traces.length === 0 && !isLive(snapshot))) return null;

  return (
    <section className={`activity-rail${expanded ? ' is-expanded' : ''}`}>
      <ActivitySummary
        snapshot={snapshot}
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

function ActivitySummary({
  snapshot,
  expanded,
  expandable,
  onToggle,
}: {
  snapshot: RunSnapshot;
  expanded: boolean;
  expandable: boolean;
  onToggle: () => void;
}) {
  const elapsed = useElapsed(snapshot.startedAt, snapshot.endedAt);
  const label = liveLabel(snapshot);
  const meta = summaryMeta(snapshot, elapsed);
  const content = (
    <>
      <span className={`activity-mark${isLive(snapshot) ? ' is-live' : ''}`} aria-hidden />
      <span className="activity-label">{label}</span>
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

function ActivityRow({ trace }: { trace: TraceEvent }) {
  const [open, setOpen] = useState(false);
  const canOpen = Boolean(trace.raw);
  const duration =
    trace.endedAt != null ? formatDuration(Math.max(0, trace.endedAt - trace.startedAt)) : 'live';
  const row = (
    <>
      <span className={`activity-row-mark status-${trace.status}`} aria-hidden>
        {statusIcon(trace.status)}
      </span>
      <span className="activity-row-label">{trace.label}</span>
      {trace.detail ? <span className="activity-row-detail">{trace.detail}</span> : null}
      {trace.progress ? <span className="activity-row-progress">{trace.progress}</span> : null}
      <span className="activity-row-time">{duration}</span>
    </>
  );

  return (
    <div
      className={`activity-item activity-kind-${trace.kind} activity-status-${trace.status}`}
      data-parent={trace.parentKey || undefined}
    >
      {canOpen ? (
        <button
          type="button"
          className="activity-row"
          onClick={() => setOpen((value) => !value)}
          aria-expanded={open}
        >
          {row}
        </button>
      ) : (
        <div className="activity-row">{row}</div>
      )}
      {open && trace.raw ? (
        <pre className="activity-raw">{JSON.stringify(trace.raw, null, 2)}</pre>
      ) : null}
    </div>
  );
}

function isLive(snapshot: RunSnapshot): boolean {
  return snapshot.state === 'queued' || snapshot.state === 'running';
}

function liveLabel(snapshot: RunSnapshot): string {
  const active = snapshot.traces.filter((trace) => trace.status === 'running');
  const activeAgents = active.filter((trace) => trace.kind === 'subagent');
  const latest = active.at(-1);
  if (activeAgents.length > 1) return `${activeAgents.length} subagents working`;
  if (latest) return latest.label;
  if (!isLive(snapshot)) {
    const failed = snapshot.traces.filter((trace) => trace.status === 'error').length;
    if (failed > 0) return `${failed} ${failed === 1 ? 'step' : 'steps'} failed`;
    const count = snapshot.traces.length;
    return `${count} ${count === 1 ? 'step' : 'steps'} completed`;
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
