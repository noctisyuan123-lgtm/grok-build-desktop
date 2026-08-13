import { describe, expect, it } from 'vitest';
import type { ChatMessage } from '../../app/types';
import {
  coerceStreamingMessagesStopped,
  mergeStreamIntoMessages,
  streamPersistFingerprint,
} from '../mergeStreamMessages';
import type { RunSnapshot } from '../streamStore';

function message(partial: Partial<ChatMessage> & Pick<ChatMessage, 'id' | 'role'>): ChatMessage {
  return {
    content: '',
    ts: 1,
    ...partial,
  };
}

function snap(partial: Partial<RunSnapshot> & Pick<RunSnapshot, 'id'>): RunSnapshot {
  return {
    state: 'running',
    startedAt: 10,
    endedAt: null,
    thoughtChars: 0,
    textChars: 0,
    lastEventType: null,
    text: '',
    htmlVersion: 0,
    stopReason: null,
    sessionId: null,
    error: null,
    usage: null,
    traces: [],
    transcript: [],
    ...partial,
  };
}

describe('mergeStreamIntoMessages', () => {
  it('checkpoints partial text and transcript while the run is still live', () => {
    const current = [
      message({ id: 'u1', role: 'user', content: 'hi' }),
      message({ id: 'a1', role: 'assistant', content: '', runId: 'r1', status: 'streaming' }),
    ];
    const snapshot = snap({
      id: 'r1',
      state: 'running',
      text: 'partial reply',
      textChars: 13,
      lastEventType: 'text',
      transcript: [{ key: 'response:0', kind: 'response', text: 'partial reply' }],
    });
    const { next, changed } = mergeStreamIntoMessages(current, 'checkpoint', (id) =>
      id === 'r1' ? snapshot : undefined,
    );
    expect(changed).toBe(true);
    expect(next[1]).toMatchObject({
      content: 'partial reply',
      status: 'streaming',
      meta: {
        transcript: [{ key: 'response:0', kind: 'response', text: 'partial reply' }],
      },
    });
  });

  it('does not rewrite when checkpoint content is unchanged', () => {
    const current = [
      message({
        id: 'a1',
        role: 'assistant',
        content: 'partial reply',
        runId: 'r1',
        status: 'streaming',
        meta: {
          transcript: [{ key: 'response:0', kind: 'response', text: 'partial reply' }],
        },
      }),
    ];
    const snapshot = snap({
      id: 'r1',
      state: 'running',
      text: 'partial reply',
      textChars: 13,
      transcript: [{ key: 'response:0', kind: 'response', text: 'partial reply' }],
    });
    const { next, changed } = mergeStreamIntoMessages(current, 'checkpoint', () => snapshot);
    expect(changed).toBe(false);
    expect(next).toBe(current);
  });

  it('terminal mode skips live runs and finalizes done ones', () => {
    const current = [
      message({ id: 'a1', role: 'assistant', content: '', runId: 'live', status: 'streaming' }),
      message({ id: 'a2', role: 'assistant', content: '', runId: 'done', status: 'streaming' }),
    ];
    const live = snap({
      id: 'live',
      state: 'running',
      text: 'still going',
      textChars: 11,
    });
    const done = snap({
      id: 'done',
      state: 'done',
      text: 'finished',
      textChars: 8,
      startedAt: 1,
      endedAt: 51,
      sessionId: 'sess-1',
      lastEventType: 'end',
      stopReason: 'EndTurn',
    });
    const get = (id: string) => (id === 'live' ? live : id === 'done' ? done : undefined);
    const { next, changed } = mergeStreamIntoMessages(current, 'terminal', get);
    expect(changed).toBe(true);
    expect(next[0]).toMatchObject({ content: '', status: 'streaming' });
    expect(next[1]).toMatchObject({
      content: 'finished',
      status: 'done',
      meta: { sessionId: 'sess-1', durationMs: 50 },
    });
  });

  it('attaches a late sessionId onto an already-finalized message', () => {
    const current = [
      message({
        id: 'a1',
        role: 'assistant',
        content: 'done text',
        runId: 'r1',
        status: 'done',
      }),
    ];
    const snapshot = snap({
      id: 'r1',
      state: 'done',
      text: 'done text',
      sessionId: 'late-session',
      lastEventType: 'end',
      stopReason: 'EndTurn',
    });
    const { next, changed } = mergeStreamIntoMessages(current, 'terminal', () => snapshot);
    expect(changed).toBe(true);
    expect(next[0]?.meta?.sessionId).toBe('late-session');
  });
});

describe('coerceStreamingMessagesStopped', () => {
  it('marks orphaned streaming assistants as stopped', () => {
    const msgs = [
      message({ id: 'u1', role: 'user', content: 'q' }),
      message({
        id: 'a1',
        role: 'assistant',
        content: 'partial',
        status: 'streaming',
        runId: 'r1',
      }),
    ];
    const next = coerceStreamingMessagesStopped(msgs);
    expect(next[1]?.status).toBe('stopped');
    expect(next[1]?.content).toBe('partial');
  });
});

describe('streamPersistFingerprint', () => {
  it('changes when text grows', () => {
    const a = streamPersistFingerprint(snap({ id: 'r', textChars: 1, thoughtChars: 0 }));
    const b = streamPersistFingerprint(snap({ id: 'r', textChars: 2, thoughtChars: 0 }));
    expect(a).not.toBe(b);
  });
});
