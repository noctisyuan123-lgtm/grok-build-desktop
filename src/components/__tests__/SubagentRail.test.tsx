import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { SubagentRail, SubagentUiProvider } from '../SubagentRail';
import { streamStore } from '../../lib/streamStore';
import type { ChatMessage } from '../../app/types';
import type { TraceEvent } from '../../lib/traceParser';

beforeEach(() => {
  streamStore.__reset();
  window.localStorage.removeItem('grok-desktop-subagent-rail-collapsed');
});

function agent(overrides: Partial<TraceEvent> = {}): TraceEvent {
  return {
    key: 'subagent:review',
    kind: 'subagent',
    label: 'Review backend',
    status: 'running',
    startedAt: 1_000,
    endedAt: null,
    ...overrides,
  };
}

function message(runId: string): ChatMessage {
  return {
    id: `msg-${runId}`,
    role: 'assistant',
    content: 'working',
    ts: 1,
    runId,
  };
}

describe('SubagentRail', () => {
  it('keeps the empty rail mounted and shows long tasks without any subagents', async () => {
    const messages = [message('run-task')];
    streamStore.patchRun('run-task', {
      state: 'running',
      traces: [
        {
          key: 'tool:sleep',
          kind: 'tool',
          label: 'Wait for build',
          command: 'sleep 60',
          status: 'running',
          startedAt: Date.now(),
          endedAt: null,
        },
      ],
    });
    const onStopTask = vi.fn();
    const { rerender } = render(
      <SubagentUiProvider messages={messages}>
        <SubagentRail messages={messages} onStopTask={onStopTask} />
      </SubagentUiProvider>,
    );
    expect(screen.getByText('sleep 60')).toBeInTheDocument();
    expect(screen.getByText('Running')).toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: 'Stop Wait for build' }));
    expect(onStopTask).toHaveBeenCalledWith('run-task');
    rerender(
      <SubagentUiProvider messages={[]}>
        <SubagentRail onStopTask={() => {}} />
      </SubagentUiProvider>,
    );
    expect(screen.getByRole('complementary', { name: 'Agents & Tasks' })).toBeInTheDocument();
    expect(screen.queryByText('Processes and long tasks appear here.')).toBeNull();
  });

  it('lists session subagents and opens the inspector from a row', async () => {
    const user = userEvent.setup();
    streamStore.patchRun('run-1', {
      state: 'running',
      traces: [
        agent(),
        agent({
          key: 'subagent:old',
          label: 'Earlier pass',
          status: 'done',
          endedAt: 4_000,
          startedAt: 1_000,
        }),
      ],
    });
    render(
      <SubagentUiProvider messages={[message('run-1')]}>
        <SubagentRail onStopTask={() => {}} />
      </SubagentUiProvider>,
    );

    expect(screen.getByRole('complementary', { name: 'Agents & Tasks' })).toBeInTheDocument();
    expect(screen.getByText('Active')).toBeInTheDocument();
    expect(screen.getByText('Done')).toBeInTheDocument();
    expect(screen.getByText('Earlier pass')).toBeInTheDocument();
    expect(screen.getByText('Working')).toBeInTheDocument();

    await user.click(
      screen.getByRole('button', { name: /Open subagent session: Review backend/i }),
    );
    expect(screen.getByRole('dialog', { name: /Subagent · Review backend/i })).toBeInTheDocument();
  });

  it('collapses to a compact card and restores from the header', async () => {
    const user = userEvent.setup();
    streamStore.patchRun('run-1', { state: 'running', traces: [agent()] });
    render(
      <SubagentUiProvider messages={[message('run-1')]}>
        <SubagentRail onStopTask={() => {}} />
      </SubagentUiProvider>,
    );

    await user.click(screen.getByRole('button', { name: 'Collapse activity' }));
    expect(screen.queryByText('Active')).toBeNull();
    expect(screen.getByText('1 working')).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Expand activity' }));
    expect(screen.getByText('Active')).toBeInTheDocument();
  });
});
