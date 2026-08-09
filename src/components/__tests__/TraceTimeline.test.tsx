import { beforeEach, describe, expect, it } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { TraceTimeline } from '../TraceTimeline';
import { streamStore } from '../../lib/streamStore';
import type { TraceEvent } from '../../lib/traceParser';

beforeEach(() => {
  streamStore.__reset();
});

function makeTrace(overrides: Partial<TraceEvent> = {}): TraceEvent {
  return {
    key: 'tool:1',
    kind: 'tool',
    label: 'Read src/App.tsx',
    status: 'running',
    startedAt: 1_000,
    endedAt: null,
    ...overrides,
  };
}

function seed(traces: TraceEvent[], state: 'running' | 'done' | 'failed' = 'running') {
  streamStore.patchRun('r1', { traces, state, startedAt: 1_000 });
}

describe('TraceTimeline activity rail', () => {
  it('renders nothing for an unknown run', () => {
    const { container } = render(<TraceTimeline runId="missing" />);
    expect(container).toBeEmptyDOMElement();
  });

  it('shows only the current activity summary until expanded', async () => {
    seed([makeTrace({ detail: '{"path":"src/App.tsx"}' })]);
    const user = userEvent.setup();
    render(<TraceTimeline runId="r1" />);

    const disclosure = screen.getByRole('button', { name: /Read src\/App.tsx/ });
    expect(disclosure).toHaveAttribute('aria-expanded', 'false');
    expect(screen.queryByLabelText('Tool and subagent activity')).not.toBeInTheDocument();

    await user.click(disclosure);
    expect(disclosure).toHaveAttribute('aria-expanded', 'true');
    expect(screen.getByLabelText('Tool and subagent activity')).toBeInTheDocument();
    expect(screen.getAllByText('Read src/App.tsx')).toHaveLength(2);
  });

  it('keeps the current subagent action primary and moves concurrency into metadata', () => {
    seed([
      makeTrace({ key: 'subagent:a', kind: 'subagent', label: 'Review backend' }),
      makeTrace({ key: 'subagent:b', kind: 'subagent', label: 'Review frontend' }),
    ]);
    render(<TraceTimeline runId="r1" />);
    expect(screen.getByText('Review frontend')).toBeInTheDocument();
    expect(screen.getByText(/2 subagents/)).toBeInTheDocument();
  });

  it('uses authoritative usage and turn counts in the compact metadata', () => {
    seed([makeTrace()]);
    streamStore.patchRun('r1', {
      usage: {
        inputTokens: 9_000,
        outputTokens: 1_000,
        thoughtTokens: 0,
        cacheReadTokens: 0,
        cacheWriteTokens: 0,
        totalTokens: 10_000,
        turns: 3,
      },
    });
    render(<TraceTimeline runId="r1" />);
    expect(screen.getByText(/10k tokens/)).toBeInTheDocument();
    expect(screen.getByText(/3 turns/)).toBeInTheDocument();
  });

  it('auto-expands errors and keeps the failed tool visibly marked', () => {
    seed(
      [
        makeTrace({
          status: 'error',
          endedAt: 2_000,
          detail: 'permission denied',
        }),
      ],
      'failed',
    );
    render(<TraceTimeline runId="r1" />);
    expect(screen.getByLabelText('Tool and subagent activity')).toBeInTheDocument();
    expect(screen.queryByText('permission denied')).toBeNull();
    expect(screen.getByText('×')).toBeInTheDocument();
  });

  it('shows a compact completed summary without an extra full-width panel', () => {
    seed(
      [
        makeTrace({ status: 'done', endedAt: 2_000 }),
        makeTrace({ key: 'tool:2', status: 'done', endedAt: 2_500 }),
      ],
      'done',
    );
    const { container } = render(<TraceTimeline runId="r1" />);
    expect(screen.getByText('Finished')).toBeInTheDocument();
    expect(screen.getByText(/2 tools/)).toBeInTheDocument();
    expect(container.querySelector('.trace-card')).toBeNull();
  });

  it('does not label an active tool as live or color completed steps as success badges', async () => {
    seed([makeTrace({ detail: 'src/App.tsx' })]);
    const user = userEvent.setup();
    const { container } = render(<TraceTimeline runId="r1" />);
    expect(screen.queryByText('live')).toBeNull();

    await user.click(screen.getByRole('button', { name: /Read src\/App.tsx/ }));
    expect(container.querySelector('.activity-row-mark.status-running')).toBeInTheDocument();
    expect(container.querySelector('.activity-row-time')).toBeNull();
  });

  it('lists tool calls without a second raw-detail disclosure', async () => {
    seed([makeTrace({ raw: { toolCallId: '1', rawOutput: { lines: 42 } } })]);
    const user = userEvent.setup();
    const { container } = render(<TraceTimeline runId="r1" />);
    await user.click(screen.getByRole('button', { name: /Read src\/App.tsx/ }));
    expect(container.querySelector('pre.activity-raw')).toBeNull();
    expect(container.querySelectorAll('.activity-row')).toHaveLength(1);
    expect(container.querySelector('.activity-row')?.tagName).toBe('DIV');
  });

  it('renders restored activity as clear tool cards from the Worked disclosure', async () => {
    const user = userEvent.setup();
    render(
      <TraceTimeline
        runId="restored"
        workedLabel="Worked for 14s"
        fallbackTraces={[
          makeTrace({
            status: 'done',
            endedAt: 2_000,
            raw: undefined,
            detail: '{"path":"/Users/untitled/Desktop/hello.py"}',
          }),
          makeTrace({
            key: 'tool:legacy',
            label: 'Tool',
            status: 'done',
            endedAt: 2_500,
            raw: undefined,
            detail: undefined,
          }),
        ]}
      />,
    );

    await user.click(screen.getByRole('button', { name: 'Worked for 14s' }));
    expect(document.querySelectorAll('.message-worked-list .activity-row')).toHaveLength(1);
    expect(screen.getByText('Read src/App.tsx')).toBeInTheDocument();
    expect(screen.queryByText('Tool call')).toBeNull();
    expect(document.querySelector('pre.activity-raw')).toBeNull();
  });
});
