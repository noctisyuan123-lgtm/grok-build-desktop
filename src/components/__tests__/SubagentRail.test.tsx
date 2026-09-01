import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it } from 'vitest';
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
        <SubagentRail />
      </SubagentUiProvider>,
    );

    expect(screen.getByRole('complementary', { name: 'Agents' })).toBeInTheDocument();
    expect(screen.getByText('Active')).toBeInTheDocument();
    expect(screen.getByText('Done')).toBeInTheDocument();
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
        <SubagentRail />
      </SubagentUiProvider>,
    );

    await user.click(screen.getByRole('button', { name: 'Hide agents' }));
    expect(screen.queryByText('Active')).toBeNull();
    expect(screen.getByText('1 working')).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Show agents' }));
    expect(screen.getByText('Active')).toBeInTheDocument();
  });
});
