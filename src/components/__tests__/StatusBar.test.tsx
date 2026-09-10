import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, render, screen } from '@testing-library/react';
import { formatTokenRate, RunStatusLine } from '../StatusBar';
import { applyRunEvent, applyStateChange, streamStore } from '../../lib/streamStore';
import { STALL_MS } from '../../lib/connectionHealth';

beforeEach(() => {
  streamStore.__reset();
  vi.useFakeTimers();
  vi.setSystemTime(1_000_000);
});

afterEach(() => {
  vi.useRealTimers();
});

describe('RunStatusLine', () => {
  it('shows waiting-for-network after T1 silence, not a fake reconnect counter', () => {
    applyStateChange('live', { state: 'Running', startedAt: 1_000_000 });
    render(<RunStatusLine runId="live" />);
    expect(screen.getByText('working…')).toBeInTheDocument();
    act(() => {
      vi.setSystemTime(1_000_000 + STALL_MS);
      vi.advanceTimersByTime(250);
    });
    expect(screen.getByText('Waiting for network…')).toBeInTheDocument();
    expect(screen.queryByText(/Reconnecting… 1\/5/)).toBeNull();
  });

  it('shows a token rate once the stream has a usable sample', () => {
    expect(formatTokenRate(0, 100)).toBeNull();
    expect(formatTokenRate(400, 1_000)).toBe('400 tok/s');
    applyStateChange('live-rate', { state: 'Running', startedAt: 1_000_000 });
    applyRunEvent('live-rate', { type: 'text', data: 'x'.repeat(400) });
    render(<RunStatusLine runId="live-rate" variant="titlebar" />);
    act(() => {
      vi.setSystemTime(1_001_000);
      vi.advanceTimersByTime(250);
    });
    expect(screen.getByText(/\d+ tok\/s/)).toBeInTheDocument();
    expect(document.querySelector('.run-status-line')).toHaveClass('is-titlebar');
  });

  it('keeps the last tok/s while a tool is running', () => {
    applyStateChange('live-hold', { state: 'Running', startedAt: 1_000_000 });
    applyRunEvent('live-hold', { type: 'text', data: 'x'.repeat(400) });
    const { rerender } = render(<RunStatusLine runId="live-hold" variant="hud" />);
    act(() => {
      vi.setSystemTime(1_001_000);
      vi.advanceTimersByTime(250);
    });
    expect(screen.getByText(/\d+ tok\/s/)).toBeInTheDocument();
    applyRunEvent(
      'live-hold',
      { type: 'unknown' },
      { type: 'tool_call', toolCallId: 't1', title: 'Shell', status: 'in_progress' },
    );
    rerender(<RunStatusLine runId="live-hold" variant="hud" />);
    expect(screen.getByText(/\d+ tok\/s/)).toBeInTheDocument();
  });
});
