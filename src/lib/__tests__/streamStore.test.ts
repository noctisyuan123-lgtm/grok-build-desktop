import { describe, it, expect, beforeEach } from 'vitest';
import { streamStore, applyRunEvent, applyStateChange, replaceQueue } from '../streamStore';

beforeEach(() => streamStore.__reset());

describe('streamStore', () => {
  it('appends text on text event and tracks chars', () => {
    applyRunEvent('r1', { type: 'text', data: 'hello' });
    applyRunEvent('r1', { type: 'text', data: ' world' });
    const snap = streamStore.getRunSnapshot('r1');
    expect(snap?.text).toBe('hello world');
    expect(snap?.textChars).toBe(11);
    expect(snap?.lastEventType).toBe('text');
  });

  it('counts thought chars separately', () => {
    applyRunEvent('r1', { type: 'thought', data: 'thinking' });
    const snap = streamStore.getRunSnapshot('r1');
    expect(snap?.thoughtChars).toBe(8);
    expect(snap?.text).toBe('');
    expect(snap?.lastEventType).toBe('thought');
    expect(snap?.transcript).toMatchObject([{ kind: 'thought', text: 'thinking' }]);
  });

  it('preserves Thought -> Respond -> Tool -> Respond order', () => {
    applyRunEvent('ordered', { type: 'thought', data: 'considering' });
    applyRunEvent('ordered', { type: 'text', data: "I'll inspect it." });
    applyRunEvent(
      'ordered',
      { type: 'unknown' },
      {
        type: 'tool_call',
        toolCallId: 'read-1',
        title: 'Read src/App.tsx',
        status: 'in_progress',
      },
    );
    applyRunEvent(
      'ordered',
      { type: 'unknown' },
      {
        type: 'tool_call_update',
        toolCallId: 'read-1',
        title: 'Read src/App.tsx',
        status: 'completed',
      },
    );
    applyRunEvent('ordered', { type: 'text', data: 'Found it.' });
    expect(
      streamStore.getRunSnapshot('ordered')?.transcript.map((segment) => segment.kind),
    ).toEqual(['thought', 'response', 'tools', 'response']);
    const tools = streamStore.getRunSnapshot('ordered')?.transcript[2];
    expect(tools).toMatchObject({ kind: 'tools', traceKeys: ['tool:read-1'] });
  });

  it('end event marks done and records stopReason', () => {
    applyRunEvent('r1', { type: 'text', data: 'hi' });
    applyRunEvent('r1', { type: 'end', stopReason: 'EndTurn', sessionId: 's', requestId: 'r' });
    const snap = streamStore.getRunSnapshot('r1');
    expect(snap?.state).toBe('done');
    expect(snap?.stopReason).toBe('EndTurn');
  });

  it('applyStateChange overwrites state and timestamps', () => {
    applyStateChange('r1', { state: 'Running', startedAt: 100 });
    const snap = streamStore.getRunSnapshot('r1');
    expect(snap?.state).toBe('running');
    expect(snap?.startedAt).toBe(100);
  });

  it('replaceQueue overwrites queue snapshot', () => {
    replaceQueue({
      active: 'r1',
      activeIds: ['r1', 'r3'],
      items: [{ id: 'r2', prompt: 'p', state: 'Queued', enqueuedAt: 1 }],
    });
    expect(streamStore.getQueueSnapshot().active).toBe('r1');
    expect(streamStore.getQueueSnapshot().activeIds).toEqual(['r1', 'r3']);
    expect(streamStore.getQueueSnapshot().items.length).toBe(1);
  });

  it('exposes a stable key for queued and running work only', () => {
    applyStateChange('r1', { state: 'Running' });
    applyStateChange('r2', { state: 'Done' });
    replaceQueue({
      active: 'r1',
      items: [{ id: 'r3', prompt: 'queued', state: 'Queued', enqueuedAt: 1 }],
    });
    expect(streamStore.getInflightRunIdsSnapshot().split('\0')).toEqual(['r1', 'r3']);

    applyStateChange('r1', { state: 'Done' });
    replaceQueue({ active: null, activeIds: [], items: [] });
    expect(streamStore.getInflightRunIdsSnapshot()).toBe('');
  });

  it('subscriber notified on event', () => {
    let calls = 0;
    const unsub = streamStore.subscribe(() => calls++);
    applyRunEvent('r1', { type: 'text', data: 'a' });
    expect(calls).toBeGreaterThan(0);
    unsub();
  });

  it('upserts official tool start/update events by toolCallId', () => {
    applyRunEvent(
      'tools',
      { type: 'unknown' },
      {
        type: 'tool_call',
        toolCallId: 'call_1',
        title: 'Read',
        status: 'in_progress',
        rawInput: { path: 'src/App.tsx' },
      },
    );
    const startedAt = streamStore.getRunSnapshot('tools')?.traces[0]?.startedAt;
    applyRunEvent(
      'tools',
      { type: 'unknown' },
      {
        type: 'tool_call_update',
        toolCallId: 'call_1',
        title: 'Read src/App.tsx',
        status: 'completed',
        rawOutput: { lines: 40 },
      },
    );
    const traces = streamStore.getRunSnapshot('tools')?.traces;
    expect(traces).toHaveLength(1);
    expect(traces?.[0]).toMatchObject({
      key: 'tool:call_1',
      label: 'Read src/App.tsx',
      status: 'done',
      startedAt,
      detail: '{"lines":40}',
    });
  });

  it('upserts subagent lifecycle events and preserves the spawn label', () => {
    applyRunEvent(
      'agents',
      { type: 'unknown' },
      {
        type: 'subagent_spawned',
        subagent_id: 'sa_1',
        description: 'Check the frontend',
      },
    );
    applyRunEvent(
      'agents',
      { type: 'unknown' },
      {
        type: 'subagent_finished',
        subagent_id: 'sa_1',
        status: 'completed',
        tool_calls: 4,
      },
    );
    const traces = streamStore.getRunSnapshot('agents')?.traces;
    expect(traces).toHaveLength(1);
    expect(traces?.[0]).toMatchObject({
      key: 'subagent:sa_1',
      label: 'Check the frontend',
      status: 'done',
      progress: '4 tools',
    });
  });

  it('reconciles open activity when a run reaches every terminal state', () => {
    for (const [runId, state, expected] of [
      ['done-run', 'Done', 'done'],
      ['failed-run', 'Failed', 'error'],
      ['cancelled-run', 'Cancelled', 'cancelled'],
    ] as const) {
      applyRunEvent(
        runId,
        { type: 'unknown' },
        {
          type: 'tool_call',
          toolCallId: runId,
          title: 'Bash',
          status: 'in_progress',
        },
      );
      applyStateChange(runId, { state });
      expect(streamStore.getRunSnapshot(runId)?.traces[0]?.status).toBe(expected);
      expect(streamStore.getRunSnapshot(runId)?.traces[0]?.endedAt).not.toBeNull();
    }
  });

  it('stores real usage and promotes stdout error lines to run failures', () => {
    applyRunEvent(
      'usage',
      { type: 'unknown' },
      {
        type: 'usage',
        usage: { input_tokens: 100, output_tokens: 25 },
      },
    );
    expect(streamStore.getRunSnapshot('usage')?.usage?.totalTokens).toBe(125);

    applyRunEvent('usage', { type: 'unknown' }, { type: 'error', message: 'quota exhausted' });
    expect(streamStore.getRunSnapshot('usage')).toMatchObject({
      state: 'failed',
      error: 'quota exhausted',
    });
  });
});
