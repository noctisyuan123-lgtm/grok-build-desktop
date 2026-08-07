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
    expect(screen.getByText('{"path":"src/App.tsx"}')).toBeInTheDocument();
  });

  it('summarises concurrent subagents instead of duplicating working pills', () => {
    seed([
      makeTrace({ key: 'subagent:a', kind: 'subagent', label: 'Review backend' }),
      makeTrace({ key: 'subagent:b', kind: 'subagent', label: 'Review frontend' }),
    ]);
    render(<TraceTimeline runId="r1" />);
    expect(screen.getByText('2 subagents working')).toBeInTheDocument();
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

  it('auto-expands errors and keeps failure detail visible', () => {
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
    expect(screen.getByText('permission denied')).toBeInTheDocument();
    expect(screen.getByText('×')).toBeInTheDocument();
  });

  it('shows a completed summary without an extra full-width panel', () => {
    seed(
      [
        makeTrace({ status: 'done', endedAt: 2_000 }),
        makeTrace({ key: 'tool:2', status: 'done', endedAt: 2_500 }),
      ],
      'done',
    );
    const { container } = render(<TraceTimeline runId="r1" />);
    expect(screen.getByText('2 steps completed')).toBeInTheDocument();
    expect(container.querySelector('.trace-card')).toBeNull();
  });

  it('reveals raw diagnostics only after clicking an individual row', async () => {
    seed([makeTrace({ raw: { toolCallId: '1', rawOutput: { lines: 42 } } })]);
    const user = userEvent.setup();
    const { container } = render(<TraceTimeline runId="r1" />);
    await user.click(screen.getByRole('button', { name: /Read src\/App.tsx/ }));
    expect(container.querySelector('pre.activity-raw')).toBeNull();
    const buttons = screen.getAllByRole('button');
    await user.click(buttons[1]!);
    expect(container.querySelector('pre.activity-raw')).toHaveTextContent('"lines": 42');
  });
});
