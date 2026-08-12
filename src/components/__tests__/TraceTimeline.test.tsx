import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { ActivityGroup, TraceTimeline } from '../TraceTimeline';
import { streamStore } from '../../lib/streamStore';
import type { TraceEvent } from '../../lib/traceParser';

beforeEach(() => {
  streamStore.__reset();
});

afterEach(() => {
  vi.useRealTimers();
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

describe('ActivityGroup staged tool motion', () => {
  it('exposes only the newest running tool while the group stays collapsed', () => {
    const { container } = render(
      <ActivityGroup
        traces={[
          makeTrace({
            key: 'tool:1',
            label: 'Read a.ts',
            status: 'done',
            endedAt: 1_500,
          }),
          makeTrace({
            key: 'tool:2',
            label: 'Download dependencies',
            status: 'running',
          }),
        ]}
      />,
    );

    expect(screen.getByText('Download dependencies')).toBeInTheDocument();
    expect(screen.queryByText('Read a.ts')).toBeNull();
    expect(container.querySelectorAll('.activity-row')).toHaveLength(1);
    expect(container.querySelector('.activity-motion-enter')).toBeInTheDocument();
    expect(container.querySelector('.activity-status-running .activity-row-label')).toBeInTheDocument();
  });

  it('does not duplicate the active tool when the group is expanded', async () => {
    const user = userEvent.setup();
    const { container } = render(
      <ActivityGroup
        traces={[
          makeTrace({
            key: 'tool:1',
            label: 'Read a.ts',
            status: 'done',
            endedAt: 1_500,
          }),
          makeTrace({
            key: 'tool:2',
            label: 'Download dependencies',
            status: 'running',
          }),
        ]}
      />,
    );

    await user.click(screen.getByRole('button', { name: /Read 1 file, used 1 tool/i }));
    expect(screen.getByText('Read a.ts')).toBeInTheDocument();
    expect(screen.getAllByText('Download dependencies')).toHaveLength(1);
    expect(container.querySelectorAll('.activity-row')).toHaveLength(2);
    expect(container.querySelector('.activity-motion-enter')).toBeNull();
    expect(container.querySelector('.activity-motion-settle')).toBeNull();
  });

  it('settles the finished tool into the summary when no next call is running', () => {
    vi.useFakeTimers();
    const { container, rerender } = render(
      <ActivityGroup
        traces={[makeTrace({ key: 'tool:1', label: 'Download dependencies', status: 'running' })]}
      />,
    );
    expect(container.querySelector('.activity-motion-enter')).toBeInTheDocument();

    rerender(
      <ActivityGroup
        traces={[
          makeTrace({
            key: 'tool:1',
            label: 'Download dependencies',
            status: 'done',
            endedAt: 2_000,
          }),
        ]}
      />,
    );
    expect(container.querySelector('.activity-motion-settle')).toBeInTheDocument();
    expect(screen.getByText('Download dependencies')).toBeInTheDocument();

    act(() => {
      vi.advanceTimersByTime(420);
    });
    expect(container.querySelector('.activity-motion-settle')).toBeNull();
    expect(screen.queryByText('Download dependencies')).toBeNull();
    expect(screen.getByRole('button', { name: /Used 1 tool/i })).toBeInTheDocument();
  });

  it('keeps the completed call floating out while the next call enters', () => {
    const { container, rerender } = render(
      <ActivityGroup traces={[makeTrace({ key: 'tool:1', label: 'Read a.ts' })]} />,
    );
    rerender(
      <ActivityGroup
        traces={[
          makeTrace({ key: 'tool:1', label: 'Read a.ts', status: 'done', endedAt: 1_500 }),
          makeTrace({ key: 'tool:2', label: 'Download dependencies' }),
        ]}
      />,
    );
    expect(container.querySelector('.activity-motion-settle')).toBeInTheDocument();
    expect(container.querySelector('.activity-motion-enter')).toBeInTheDocument();
  });

  it('keeps a single edit compact and opens its diff directly under the short summary', async () => {
    const user = userEvent.setup();
    render(
      <ActivityGroup
        traces={[
          makeTrace({
            key: 'edit:1',
            label: 'Edit /Users/untitled/Desktop/hello_world.txt',
            path: '/Users/untitled/Desktop/hello_world.txt',
            status: 'done',
            endedAt: 2_000,
            diff: '-old\n+new',
            additions: 1,
            deletions: 1,
          }),
        ]}
      />,
    );

    const summary = screen.getByRole('button', { name: /Edited hello_world\.txt/ });
    expect(screen.queryByText('/Users/untitled/Desktop/hello_world.txt')).toBeNull();
    await user.click(summary);
    expect(screen.getByLabelText('Changes to /Users/untitled/Desktop/hello_world.txt')).toBeInTheDocument();
    expect(screen.queryByText('Edited /Users/untitled/Desktop/hello_world.txt')).toBeNull();
  });

  it('embedded multi-tool groups list each tool once without a second summary', async () => {
    const { container } = render(
      <ActivityGroup
        embedded
        traces={[
          makeTrace({
            key: 'tool:1',
            label: 'Read a.ts',
            status: 'done',
            endedAt: 1_500,
          }),
          makeTrace({
            key: 'tool:2',
            label: 'Search MessageItem',
            status: 'done',
            endedAt: 2_000,
          }),
        ]}
      />,
    );

    expect(screen.queryByRole('button', { name: /Read 1 file/i })).toBeNull();
    expect(screen.getByText('Read a.ts')).toBeInTheDocument();
    expect(screen.getByText('Search MessageItem')).toBeInTheDocument();
    expect(container.querySelectorAll('.activity-row')).toHaveLength(2);
  });

  it('embedded single edit still opens the diff from the concise Edited-file row', async () => {
    const user = userEvent.setup();
    render(
      <ActivityGroup
        embedded
        traces={[
          makeTrace({
            key: 'edit:1',
            label: 'Edit /Users/untitled/Desktop/hello_world.txt',
            path: '/Users/untitled/Desktop/hello_world.txt',
            status: 'done',
            endedAt: 2_000,
            diff: '-old\n+new',
            additions: 1,
            deletions: 1,
          }),
        ]}
      />,
    );

    const summary = screen.getByRole('button', { name: /Edited hello_world\.txt/ });
    expect(screen.queryByText('Edited /Users/untitled/Desktop/hello_world.txt')).toBeNull();
    await user.click(summary);
    expect(screen.getByLabelText('Changes to /Users/untitled/Desktop/hello_world.txt')).toBeInTheDocument();
    expect(screen.queryByText('Edited /Users/untitled/Desktop/hello_world.txt')).toBeNull();
  });
});

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
    expect(screen.getByText('Review frontend')).toBeInTheDocument();
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

  it('keeps subagent detail bodies collapsed until the summary row is clicked', async () => {
    const user = userEvent.setup();
    seed(
      [
        makeTrace({
          key: 'subagent:a',
          kind: 'subagent',
          label: 'Explore repo',
          detail: 'nested agent output that must stay hidden',
          status: 'done',
          endedAt: 2_000,
        }),
      ],
      'done',
    );
    render(<TraceTimeline runId="r1" />);

    // Expand the outer activity rail first (summary is collapsed by default).
    await user.click(screen.getByRole('button', { name: /Used 1 subagent/i }));
    const row = screen.getByRole('button', { name: /Subagent · Explore repo/i });
    expect(row).toHaveAttribute('aria-expanded', 'false');
    expect(screen.queryByText('nested agent output that must stay hidden')).toBeNull();

    await user.click(row);
    expect(row).toHaveAttribute('aria-expanded', 'true');
    expect(screen.getByText('nested agent output that must stay hidden')).toBeInTheDocument();
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
    expect(screen.getByText('Read 2 files')).toBeInTheDocument();
    expect(container.querySelector('.trace-card')).toBeNull();
  });

  it('does not label an active tool as live or color completed steps as success badges', async () => {
    seed([makeTrace({ detail: 'src/App.tsx' })]);
    const user = userEvent.setup();
    const { container } = render(<TraceTimeline runId="r1" />);
    expect(screen.queryByText('live')).toBeNull();

    await user.click(screen.getByRole('button', { name: /Read src\/App.tsx/ }));
    expect(container.querySelector('.activity-row-mark.status-running')).toBeInTheDocument();
    expect(container.querySelector('.activity-row-time')).toBeInTheDocument();
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
    await user.click(screen.getByRole('button', { name: 'Read 1 file' }));
    expect(document.querySelectorAll('.message-worked-list .activity-row')).toHaveLength(1);
    expect(screen.getByText('Read src/App.tsx')).toBeInTheDocument();
    expect(screen.queryByText('Tool call')).toBeNull();
    expect(document.querySelector('pre.activity-raw')).toBeNull();
  });

  it('expands an edit into a line-numbered red/green diff', async () => {
    const user = userEvent.setup();
    seed(
      [
        makeTrace({
          label: 'Edit settings',
          status: 'done',
          endedAt: 2_000,
          path: '.zshrc',
          diff: '-MODEL=k3\n+MODEL=k3-256k',
          additions: 1,
          deletions: 1,
        }),
      ],
      'done',
    );
    const { container } = render(<TraceTimeline runId="r1" />);
    const summary = screen.getByRole('button', { name: /Edited .zshrc.*\+1.*−1/ });
    await user.click(summary);
    const edit = screen.getAllByRole('button', { name: /Edited .zshrc.*\+1.*−1/ })[1]!;
    expect(edit.closest('.activity-item')).toHaveClass('activity-is-edit');
    await user.click(edit);
    expect(screen.getByLabelText('Changes to .zshrc')).toBeInTheDocument();
    expect(container.querySelector('.activity-diff-line.is-add')).toHaveTextContent(
      'MODEL=k3-256k',
    );
    expect(container.querySelector('.activity-diff-line.is-del')).toHaveTextContent('MODEL=k3');
  });

  it('shows a created file addition count before the edit group is expanded', () => {
    seed(
      [
        makeTrace({
          label: 'Edit `/tmp/hello.py`',
          status: 'done',
          endedAt: 2_000,
          path: '/tmp/hello.py',
          diff: '+print("hello")',
          additions: 1,
          deletions: 0,
        }),
      ],
      'done',
    );
    render(<TraceTimeline runId="r1" />);
    expect(screen.getByRole('button', { name: /Edited hello.py.*\+1/ })).toBeInTheDocument();
    expect(screen.queryByText('−0')).toBeNull();
  });

  it('repairs duplicate created-file stats stored by the first transcript build', () => {
    seed(
      [
        makeTrace({
          label: 'Edit `/tmp/hello.py`',
          status: 'done',
          endedAt: 2_000,
          path: '/tmp/hello.py',
          diff: '+print("hello")\n+main()\n-1\n+print("hello")\n+main()',
          additions: 4,
          deletions: 1,
        }),
      ],
      'done',
    );
    render(<TraceTimeline runId="r1" />);
    expect(screen.getByRole('button', { name: /Edited hello.py.*\+2/ })).toBeInTheDocument();
    expect(screen.queryByText('−1')).toBeNull();
  });
});
