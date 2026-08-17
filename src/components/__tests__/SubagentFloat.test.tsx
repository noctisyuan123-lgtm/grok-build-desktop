import { act, fireEvent, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it } from 'vitest';
import { pickCurrentSubagent, SubagentFloat } from '../SubagentFloat';
import { streamStore } from '../../lib/streamStore';
import type { TraceEvent } from '../../lib/traceParser';

beforeEach(() => {
  streamStore.__reset();
  window.localStorage.removeItem('grok-desktop-subagent-drawer-width');
});

function subagent(overrides: Partial<TraceEvent> = {}): TraceEvent {
  return {
    key: 'subagent:review',
    kind: 'subagent',
    label: 'Review backend',
    status: 'running',
    startedAt: 1_000,
    endedAt: null,
    detail: 'Scanning controllers',
    progress: '2 tools',
    ...overrides,
  };
}

describe('SubagentFloat', () => {
  it('shows a floating card for the current session run subagent', () => {
    streamStore.patchRun('session-run', {
      state: 'running',
      startedAt: 1_000,
      traces: [subagent()],
    });
    render(<SubagentFloat sessionRunIds={['session-run']} />);
    expect(screen.getByRole('button', { name: /Open subagent session: Review backend/i })).toBeInTheDocument();
    expect(screen.getByText('Review backend')).toBeInTheDocument();
    expect(screen.getByText('Running')).toBeInTheDocument();
  });

  it('does not render another tab session’s subagent', () => {
    streamStore.patchRun('other-tab-run', {
      state: 'running',
      startedAt: 1_000,
      traces: [subagent({ label: 'Other tab agent' })],
    });
    streamStore.setQueue({ active: 'other-tab-run', activeIds: ['other-tab-run'], items: [] });
    const { container } = render(<SubagentFloat sessionRunIds={['this-tab-run']} />);
    expect(container).toBeEmptyDOMElement();
    expect(screen.queryByText('Other tab agent')).toBeNull();
  });

  it('opens and closes the session inspector drawer', async () => {
    const user = userEvent.setup();
    streamStore.patchRun('session-run', {
      state: 'running',
      startedAt: 1_000,
      traces: [
        subagent({ detail: 'Looking at auth' }),
        {
          key: 'tool:1',
          kind: 'tool',
          label: 'Read auth.ts',
          status: 'done',
          startedAt: 1_100,
          endedAt: 1_200,
          parentKey: 'subagent:review',
        },
      ],
    });
    render(<SubagentFloat sessionRunIds={['session-run']} />);

    await user.click(screen.getByRole('button', { name: /Open subagent session/i }));
    expect(screen.getByRole('dialog', { name: /Subagent · Review backend/i })).toBeInTheDocument();
    expect(screen.getByText('Looking at auth')).toBeInTheDocument();
    expect(screen.getByText('Read auth.ts')).toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: 'Close subagent session' }));
    expect(screen.queryByRole('dialog', { name: /Subagent · Review backend/i })).toBeNull();
  });

  it('prefers the newest live subagent over older finished ones', () => {
    const picked = pickCurrentSubagent(
      [
        subagent({ key: 'subagent:old', label: 'Old', status: 'done', endedAt: 1_500 }),
        subagent({ key: 'subagent:new', label: 'New live', status: 'running' }),
      ],
      'run-1',
    );
    expect(picked?.label).toBe('New live');
  });

  it('hides when the session has no subagent traces', () => {
    streamStore.patchRun('session-run', {
      state: 'running',
      traces: [
        {
          key: 'tool:1',
          kind: 'tool',
          label: 'Read only',
          status: 'running',
          startedAt: 1,
          endedAt: null,
        },
      ],
    });
    const { container } = render(<SubagentFloat sessionRunIds={['session-run']} />);
    expect(container).toBeEmptyDOMElement();
  });

  it('updates when the session run gains a subagent', async () => {
    streamStore.patchRun('session-run', { state: 'running', traces: [] });
    const { rerender } = render(<SubagentFloat sessionRunIds={['session-run']} />);
    expect(screen.queryByText('Review backend')).toBeNull();

    await act(async () => {
      streamStore.patchRun('session-run', { traces: [subagent()] });
    });
    rerender(<SubagentFloat sessionRunIds={['session-run']} />);
    expect(screen.getByText('Review backend')).toBeInTheDocument();
  });

  it('renders one composer card per subagent and opens its own transcript', async () => {
    const user = userEvent.setup();
    const second = subagent({
      key: 'subagent:frontend',
      label: 'Review frontend',
      sessionId: 'child-2',
      transcript: [{ key: 'response:0', kind: 'response', text: 'Frontend result' }],
    });
    const first = subagent({
      sessionId: 'child-1',
      transcript: [{ key: 'response:0', kind: 'response', text: 'Backend result' }],
    });
    streamStore.patchRun('session-run', {
      state: 'done',
      traces: [first, second],
    });

    render(<SubagentFloat sessionRunIds={['session-run']} />);
    expect(screen.getAllByRole('button', { name: /Open subagent session/i })).toHaveLength(2);

    await user.click(screen.getByRole('button', { name: /Open subagent session: Review frontend/i }));
    expect(screen.getByRole('dialog', { name: /Subagent · Review frontend/i })).toBeInTheDocument();
    expect(screen.getByText('Frontend result')).toBeInTheDocument();
    expect(screen.queryByText('Backend result')).toBeNull();
  });

  it('resizes the drawer from its left edge and remembers the width', async () => {
    const user = userEvent.setup();
    streamStore.patchRun('session-run', {
      state: 'running',
      traces: [subagent()],
    });

    render(<SubagentFloat sessionRunIds={['session-run']} />);
    await user.click(screen.getByRole('button', { name: /Open subagent session/i }));

    const drawer = screen.getByRole('dialog', { name: /Subagent · Review backend/i });
    const resizer = screen.getByRole('separator', { name: 'Resize subagent window' });
    expect(drawer).toHaveStyle({ width: '420px' });

    fireEvent.pointerDown(resizer, { button: 0, clientX: 900 });
    fireEvent.pointerMove(window, { clientX: 820 });
    fireEvent.pointerUp(window, { clientX: 820 });

    expect(drawer).toHaveStyle({ width: '500px' });
    expect(window.localStorage.getItem('grok-desktop-subagent-drawer-width')).toBe('500');
  });
});
