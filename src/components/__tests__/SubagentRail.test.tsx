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
    expect(screen.getByText('Wait for build')).toBeInTheDocument();
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

  it('lists a watching monitor with its title in Tasks', () => {
    const messages = [message('run-watch')];
    streamStore.patchRun('run-watch', {
      state: 'done',
      watching: true,
      watchingStartedAt: Date.now() - 8_000,
      watchingLabel: 'Wait for mlx-serve download',
    });
    render(
      <SubagentUiProvider messages={messages}>
        <SubagentRail messages={messages} onStopTask={() => {}} />
      </SubagentUiProvider>,
    );
    expect(screen.getAllByText('Wait for mlx-serve download').length).toBeGreaterThan(0);
    expect(screen.getByText('Watching')).toBeInTheDocument();
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
    const messages = [message('run-1')];
    render(
      <SubagentUiProvider messages={messages}>
        <SubagentRail messages={messages} onStopTask={() => {}} />
      </SubagentUiProvider>,
    );

    expect(screen.getByText('1 agents')).toBeInTheDocument();
    expect(screen.getByText('0 tasks')).toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: 'Collapse activity' }));
    expect(screen.queryByText('Active')).toBeNull();
    expect(screen.queryByText('1 agents')).toBeNull();
    expect(screen.queryByText('0 tasks')).toBeNull();
    expect(document.querySelector('.subagent-rail-counts')).toBeNull();
    const rail = screen.getByRole('complementary', { name: 'Agents & Tasks' });
    const toggle = screen.getByRole('button', { name: 'Expand activity' });
    const dot = rail.querySelector('.subagent-rail-activity-dot');
    expect(dot).toBeInTheDocument();
    expect(dot).toHaveAttribute('aria-label', '1 agents, 0 tasks');
    expect(toggle.contains(dot)).toBe(false);
    await user.click(screen.getByRole('button', { name: 'Expand activity' }));
    expect(screen.getByText('Active')).toBeInTheDocument();
    expect(screen.getByText('1 agents')).toBeInTheDocument();
    expect(screen.getByText('0 tasks')).toBeInTheDocument();
  });

  it('uses an activity dot while collapsed, then restores Tasks and Active', async () => {
    const user = userEvent.setup();
    const messages = [message('run-1')];
    streamStore.patchRun('run-1', {
      state: 'running',
      traces: [
        agent(),
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
    render(
      <SubagentUiProvider messages={messages}>
        <SubagentRail messages={messages} onStopTask={() => {}} />
      </SubagentUiProvider>,
    );

    expect(screen.getByText('Active')).toBeInTheDocument();
    expect(screen.getByRole('heading', { name: /Tasks/ })).toBeInTheDocument();

    expect(screen.getByText('1 agents')).toBeInTheDocument();
    expect(screen.getByText('1 tasks')).toBeInTheDocument();
    expect(document.querySelector('.subagent-rail-counts')?.children).toHaveLength(2);

    await user.click(screen.getByRole('button', { name: 'Collapse activity' }));
    expect(screen.queryByText('Active')).toBeNull();
    expect(screen.queryByRole('heading', { name: /Tasks/ })).toBeNull();
    expect(screen.queryByText('1 agents')).toBeNull();
    expect(screen.queryByText('1 tasks')).toBeNull();
    expect(document.querySelector('.subagent-rail-counts')).toBeNull();
    const rail = screen.getByRole('complementary', { name: 'Agents & Tasks' });
    const toggle = screen.getByRole('button', { name: 'Expand activity' });
    const dot = rail.querySelector('.subagent-rail-activity-dot');
    expect(dot).toBeInTheDocument();
    expect(dot).toHaveAttribute('aria-label', '1 agents, 1 tasks');
    expect(toggle.contains(dot)).toBe(false);

    await user.click(screen.getByRole('button', { name: 'Expand activity' }));
    expect(screen.getByText('Active')).toBeInTheDocument();
    expect(screen.getByRole('heading', { name: /Tasks/ })).toBeInTheDocument();
    expect(screen.getByText('1 agents')).toBeInTheDocument();
    expect(screen.getByText('1 tasks')).toBeInTheDocument();
  });

  it('hides the collapsed activity dot when the rail is empty', async () => {
    const user = userEvent.setup();
    render(
      <SubagentUiProvider messages={[]}>
        <SubagentRail onStopTask={() => {}} />
      </SubagentUiProvider>,
    );

    await user.click(screen.getByRole('button', { name: 'Collapse activity' }));
    expect(document.querySelector('.subagent-rail-activity-dot')).toBeNull();
    expect(screen.queryByText('0 agents')).toBeNull();
    expect(screen.queryByText('0 tasks')).toBeNull();
  });
});
