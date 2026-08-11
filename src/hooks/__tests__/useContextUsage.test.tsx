import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, renderHook, waitFor } from '@testing-library/react';
import { useContextUsage } from '../useContextUsage';
import type { ChatMessage } from '../../app/types';
import { streamStore } from '../../lib/streamStore';
import { installTauriAppMock } from '../../test/tauriAppMock';
import { ACTIVE_RUN_POLL_MS } from '../../lib/contextMetrics';

const SESSION = '019fe74c-9daf-7b03-9387-36b35cf1eb63';

function messagesWithSession(sessionId = SESSION): ChatMessage[] {
  return [
    { id: 'u1', role: 'user', content: 'hi', ts: 1 },
    {
      id: 'a1',
      role: 'assistant',
      content: 'hello',
      ts: 2,
      meta: { sessionId },
    },
  ];
}

describe('useContextUsage', () => {
  beforeEach(() => {
    streamStore.__reset();
    vi.useFakeTimers({ shouldAdvanceTime: true });
  });

  afterEach(() => {
    vi.useRealTimers();
    streamStore.__reset();
  });

  it('stays empty when there is no Grok session yet', async () => {
    installTauriAppMock();
    const { result } = renderHook(() =>
      useContextUsage([{ id: 'u1', role: 'user', content: 'hi', ts: 1 }], '/proj'),
    );
    await waitFor(() => {
      expect(result.current.view.kind).toBe('empty');
    });
    if (result.current.view.kind === 'empty') {
      expect(result.current.view.reason).toBe('no-session');
    }
    expect(result.current.sessionId).toBeNull();
  });

  it('loads ready metrics for the active session head', async () => {
    const mock = installTauriAppMock({
      get_session_context_metrics: () => ({
        available: true,
        sessionId: SESSION,
        contextTokensUsed: 90_000,
        contextWindowTokens: 500_000,
        contextWindowUsage: 18,
        compactionCount: 1,
        totalTokensBeforeCompaction: 400_000,
        turnCount: 3,
        primaryModelId: 'grok-4.5',
        autoCompactThresholdPercent: 80,
        breakdown: {
          systemPrompt: 8_000,
          rules: 4_000,
          conversation: 30_000,
          toolsRuntime: 48_000,
        },
        breakdownApproximate: true,
        detail: null,
      }),
    });
    const { result } = renderHook(() => useContextUsage(messagesWithSession(), '/proj'));
    await waitFor(() => {
      expect(result.current.view.kind).toBe('ready');
    });
    expect(result.current.view).toMatchObject({
      kind: 'ready',
      percent: 18,
      tone: 'neutral',
    });
    expect(mock.commands()).toContain('get_session_context_metrics');
    const call = mock.calls.find((c) => c.cmd === 'get_session_context_metrics');
    expect(call?.args).toMatchObject({ cwd: '/proj', sessionId: SESSION });
  });

  it('loads metrics by session id when no project folder is selected', async () => {
    const mock = installTauriAppMock();
    renderHook(() => useContextUsage(messagesWithSession(), ''));
    await waitFor(() => expect(mock.commands()).toContain('get_session_context_metrics'));
    const call = mock.calls.find((c) => c.cmd === 'get_session_context_metrics');
    expect(call?.args).toMatchObject({ cwd: '', sessionId: SESSION });
  });

  it('clears occupancy when the conversation switches to a session-less chat', async () => {
    installTauriAppMock({
      get_session_context_metrics: () => ({
        available: true,
        sessionId: SESSION,
        contextTokensUsed: 10,
        contextWindowTokens: 100,
        contextWindowUsage: 10,
        compactionCount: 0,
        totalTokensBeforeCompaction: 0,
        turnCount: 1,
        primaryModelId: 'grok-4.5',
        autoCompactThresholdPercent: 80,
        breakdown: {
          systemPrompt: 2,
          rules: 1,
          conversation: 3,
          toolsRuntime: 4,
        },
        breakdownApproximate: true,
        detail: null,
      }),
    });
    const { result, rerender } = renderHook(
      ({ msgs }: { msgs: ChatMessage[] }) => useContextUsage(msgs, '/proj'),
      { initialProps: { msgs: messagesWithSession() } },
    );
    await waitFor(() => expect(result.current.view.kind).toBe('ready'));
    rerender({ msgs: [{ id: 'u-new', role: 'user', content: 'fresh', ts: 9 }] });
    await waitFor(() => {
      expect(result.current.sessionId).toBeNull();
      expect(result.current.view.kind).toBe('empty');
    });
  });

  it('polls only while a run is inflight', async () => {
    let hits = 0;
    installTauriAppMock({
      get_session_context_metrics: () => {
        hits += 1;
        return {
          available: true,
          sessionId: SESSION,
          contextTokensUsed: hits * 1000,
          contextWindowTokens: 500_000,
          contextWindowUsage: hits,
          compactionCount: 0,
          totalTokensBeforeCompaction: 0,
          turnCount: 1,
          primaryModelId: 'grok-4.5',
          autoCompactThresholdPercent: 80,
          breakdown: {
            systemPrompt: 100,
            rules: 50,
            conversation: 200,
            toolsRuntime: Math.max(0, hits * 1000 - 350),
          },
          breakdownApproximate: true,
          detail: null,
        };
      },
    });
    streamStore.patchRun('run-1', { state: 'running', sessionId: SESSION });
    streamStore.setQueue({ active: 'run-1', items: [] });

    const { result } = renderHook(() => useContextUsage(messagesWithSession(), '/proj'));
    await waitFor(() => expect(result.current.streaming).toBe(true));
    await waitFor(() => expect(hits).toBeGreaterThanOrEqual(1));
    const afterFirst = hits;

    await act(async () => {
      await vi.advanceTimersByTimeAsync(ACTIVE_RUN_POLL_MS + 50);
    });
    expect(hits).toBeGreaterThan(afterFirst);

    // End the run — polling stops; one final lifecycle refresh is allowed.
    const beforeIdle = hits;
    await act(async () => {
      streamStore.patchRun('run-1', { state: 'done', sessionId: SESSION });
      streamStore.setQueue({ active: null, items: [] });
    });
    await waitFor(() => expect(result.current.streaming).toBe(false));
    await waitFor(() => expect(hits).toBeGreaterThanOrEqual(beforeIdle));

    const settled = hits;
    await act(async () => {
      await vi.advanceTimersByTimeAsync(ACTIVE_RUN_POLL_MS * 3);
    });
    expect(hits).toBe(settled);
  });

  it('surfaces IPC errors without throwing', async () => {
    installTauriAppMock({
      get_session_context_metrics: () => {
        throw new Error('invalid session id');
      },
    });
    const { result } = renderHook(() => useContextUsage(messagesWithSession(), '/proj'));
    await waitFor(() => expect(result.current.view.kind).toBe('error'));
    if (result.current.view.kind === 'error') {
      expect(result.current.view.message).toMatch(/invalid session id/i);
    }
  });
});
