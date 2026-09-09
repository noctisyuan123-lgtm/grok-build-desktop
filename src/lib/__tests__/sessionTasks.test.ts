import { expect, it } from 'vitest';
import { collectSessionTasks, isLongTask } from '../sessionTasks';
import { applyRunEvent, streamStore } from '../streamStore';
import type { TraceEvent } from '../traceParser';
const trace: TraceEvent = {
  key: 'tool:1',
  kind: 'tool',
  label: 'Tool',
  status: 'running',
  startedAt: 1_000,
  endedAt: null,
};
it('includes explicit sleep/process commands immediately, and slow generic tools after five seconds', () => {
  expect(isLongTask({ ...trace, command: 'sleep 60' }, 1_000)).toBe(true);
  expect(isLongTask({ ...trace, label: 'Execute process' }, 1_000)).toBe(true);
  expect(isLongTask(trace, 5_999)).toBe(false);
  expect(isLongTask(trace, 6_000)).toBe(true);
  expect(isLongTask({ ...trace, kind: 'subagent' }, 60_000)).toBe(false);
});
it('hides completed calls while retaining independent active calls across runs', () => {
  const items = collectSessionTasks(
    ['a', 'b'].map((runId) => ({
      id: runId,
      runId,
      role: 'assistant',
      content: '',
      ts: 1,
      meta: { traces: [{ ...trace, command: 'sleep 60' }] },
    })),
    new Map([['a', [{ ...trace, command: 'sleep 60', status: 'done', endedAt: 10_000 }]]]),
    20_000,
  );
  expect(items).toHaveLength(1);
  expect(items[0]?.runId).toBe('b');
});
it('preserves the command when tool completion replaces input with output', () => {
  streamStore.__reset();
  applyRunEvent(
    'task',
    { type: 'unknown' },
    {
      type: 'tool_call',
      toolCallId: 'sleep',
      title: 'Shell',
      rawInput: { command: 'sleep 60' },
      status: 'in_progress',
    },
  );
  applyRunEvent(
    'task',
    { type: 'unknown' },
    { type: 'tool_call_update', toolCallId: 'sleep', rawOutput: 'finished', status: 'completed' },
  );
  const item = streamStore.getRunSnapshot('task')?.traces[0];
  expect(item?.command).toBe('sleep 60');
  expect(item?.status).toBe('done');
});
