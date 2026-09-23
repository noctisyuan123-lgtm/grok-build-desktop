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

  it('does not change tok/s when wall time advances during a tool', () => {
    applyStateChange('live-pause', { state: 'Running', startedAt: 1_000_000 });
    applyRunEvent('live-pause', { type: 'text', data: 'x'.repeat(400) });
    const { rerender } = render(<RunStatusLine runId="live-pause" variant="hud" />);
    act(() => {
      vi.setSystemTime(1_001_000);
      vi.advanceTimersByTime(250);
    });
    applyRunEvent(
      'live-pause',
      { type: 'unknown' },
      { type: 'tool_call', toolCallId: 't1', title: 'Shell', status: 'in_progress' },
    );
    rerender(<RunStatusLine runId="live-pause" variant="hud" />);
    const held = screen.getByText(/\d+ tok\/s/).textContent;
    expect(held).toMatch(/\d+ tok\/s/);
    act(() => {
      vi.setSystemTime(1_010_000);
      vi.advanceTimersByTime(250);
    });
    rerender(<RunStatusLine runId="live-pause" variant="hud" />);
    expect(screen.getByText(/\d+ tok\/s/).textContent).toBe(held);
  });

  it('recomputes tok/s when usage jumps during a tool', () => {
    applyStateChange('live-usage', { state: 'Running', startedAt: 1_000_000 });
    applyRunEvent('live-usage', { type: 'text', data: 'x'.repeat(400) });
    const { rerender } = render(<RunStatusLine runId="live-usage" variant="hud" />);
    act(() => {
      vi.setSystemTime(1_001_000);
      vi.advanceTimersByTime(250);
    });
    // Pin wall clock so the tool flush records exactly 1s of active generation.
    act(() => {
      vi.setSystemTime(1_001_000);
    });
    applyRunEvent(
      'live-usage',
      { type: 'unknown' },
      { type: 'tool_call', toolCallId: 't1', title: 'Shell', status: 'in_progress' },
    );
    rerender(<RunStatusLine runId="live-usage" variant="hud" />);
    const before = screen.getByText(/\d+ tok\/s/).textContent;
    // Char estimate ≈100 tokens → ~100 tok/s over 1s active. Official usage is higher.
    streamStore.patchRun('live-usage', {
      usage: {
        inputTokens: 10,
        outputTokens: 400,
        thoughtTokens: 100,
        cacheReadTokens: 0,
        cacheWriteTokens: 0,
        totalTokens: 510,
      },
    });
    rerender(<RunStatusLine runId="live-usage" variant="hud" />);
    const after = screen.getByText(/\d+ tok\/s/).textContent;
    expect(after).not.toBe(before);
    expect(screen.getByText('500 tok/s')).toBeInTheDocument();
  });
});
