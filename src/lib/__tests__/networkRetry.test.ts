import { describe, expect, it, vi } from 'vitest';
import { collapseFailedNetworkTurn, performNetworkRetry } from '../networkRetry';

function msg(
  id: string,
  role: string,
  content: string,
  runId?: string,
) {
  return { id, role, content, runId };
}

describe('collapseFailedNetworkTurn', () => {
  it('removes the failed user+assistant pair and returns the user text', () => {
    const messages = [
      msg('u0', 'user', 'earlier'),
      msg('a0', 'assistant', 'reply', 'run-0'),
      msg('u1', 'user', 'please fix the flaky test'),
      msg('a1', 'assistant', '', 'run-failed'),
    ];
    const collapsed = collapseFailedNetworkTurn(messages, 'run-failed');
    expect(collapsed).not.toBeNull();
    expect(collapsed!.userText).toBe('please fix the flaky test');
    expect(collapsed!.preserved.map((m) => m.id)).toEqual(['u0', 'a0']);
    expect(collapsed!.userIndex).toBe(2);
    expect(collapsed!.assistantIndex).toBe(3);
  });

  it('returns null when the run is missing or has no preceding user', () => {
    expect(collapseFailedNetworkTurn([msg('a1', 'assistant', '', 'r1')], 'r1')).toBeNull();
    expect(collapseFailedNetworkTurn([msg('u1', 'user', 'hi')], 'missing')).toBeNull();
  });

  it('returns null when the user text is empty', () => {
    const messages = [msg('u1', 'user', '   '), msg('a1', 'assistant', '', 'r1')];
    expect(collapseFailedNetworkTurn(messages, 'r1')).toBeNull();
  });

  it('drops anything after the user bubble of the failed turn', () => {
    const messages = [
      msg('u0', 'user', 'keep'),
      msg('u1', 'user', 'retry me'),
      msg('note', 'system', 'injected'),
      msg('a1', 'assistant', '', 'r1'),
    ];
    const collapsed = collapseFailedNetworkTurn(messages, 'r1');
    expect(collapsed!.preserved.map((m) => m.id)).toEqual(['u0']);
    expect(collapsed!.userText).toBe('retry me');
  });
});

describe('performNetworkRetry', () => {
  it('cancels the old run, collapses the turn, and submits a fresh send', async () => {
    const messages = [
      msg('u0', 'user', 'earlier'),
      msg('a0', 'assistant', 'ok', 'run-0'),
      msg('u1', 'user', 'redo please'),
      msg('a1', 'assistant', '', 'run-failed'),
    ];
    const cancelRun = vi.fn(async () => true);
    const dismissFailure = vi.fn();
    const clearOpenWork = vi.fn();
    const replaceMessages = vi.fn();
    const setComposerValue = vi.fn();
    const submit = vi.fn();

    const ok = await performNetworkRetry({
      messages,
      runId: 'run-failed',
      cancelRun,
      dismissFailure,
      clearOpenWork,
      replaceMessages,
      setComposerValue,
      submit,
    });

    expect(ok).toBe(true);
    expect(dismissFailure).toHaveBeenCalledWith('run-failed');
    expect(cancelRun).toHaveBeenCalledWith('run-failed');
    expect(clearOpenWork).toHaveBeenCalledWith('run-failed');
    expect(replaceMessages).toHaveBeenCalledWith([
      msg('u0', 'user', 'earlier'),
      msg('a0', 'assistant', 'ok', 'run-0'),
    ]);
    expect(setComposerValue).toHaveBeenCalledWith('redo please');
    expect(submit).toHaveBeenCalledTimes(1);
  });

  it('still resubmits when cancelRun rejects (run already gone)', async () => {
    const messages = [msg('u1', 'user', 'hi'), msg('a1', 'assistant', '', 'r1')];
    const cancelRun = vi.fn(async () => {
      throw new Error('gone');
    });
    const submit = vi.fn();
    const ok = await performNetworkRetry({
      messages,
      runId: 'r1',
      cancelRun,
      dismissFailure: vi.fn(),
      replaceMessages: vi.fn(),
      setComposerValue: vi.fn(),
      submit,
    });
    expect(ok).toBe(true);
    expect(submit).toHaveBeenCalledTimes(1);
  });
});
