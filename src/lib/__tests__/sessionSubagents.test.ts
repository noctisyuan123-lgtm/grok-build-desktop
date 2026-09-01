import { describe, expect, it } from 'vitest';
import { collectSessionSubagents, partitionSessionSubagents } from '../sessionSubagents';
import type { TraceEvent } from '../traceParser';

function agent(overrides: Partial<TraceEvent> = {}): TraceEvent {
  return {
    key: 'subagent:a',
    kind: 'subagent',
    label: 'Explore',
    status: 'done',
    startedAt: 1,
    endedAt: 2,
    ...overrides,
  };
}

describe('collectSessionSubagents', () => {
  it('prefers live traces over persisted copies of the same key', () => {
    const live = new Map<string, TraceEvent[]>([
      [
        'run-1',
        [agent({ key: 'subagent:a', status: 'running', endedAt: null, label: 'Explore live' })],
      ],
    ]);
    const items = collectSessionSubagents(
      ['run-1'],
      [{ runId: 'run-1', traces: [agent({ key: 'subagent:a', label: 'Explore stale' })] }],
      live,
    );
    expect(items).toHaveLength(1);
    expect(items[0]).toMatchObject({
      key: 'subagent:a',
      label: 'Explore live',
      status: 'running',
      runId: 'run-1',
    });
  });

  it('keeps earlier-turn subagents that are only on persisted messages', () => {
    const items = collectSessionSubagents(
      ['run-new'],
      [
        { runId: 'run-old', traces: [agent({ key: 'subagent:old', label: 'First pass' })] },
        { runId: 'run-new', traces: [agent({ key: 'subagent:new', label: 'Second pass' })] },
      ],
      new Map(),
    );
    expect(items.map((item) => item.key)).toEqual(['subagent:old', 'subagent:new']);
  });
});

describe('partitionSessionSubagents', () => {
  it('splits running agents from settled ones', () => {
    const { active, done } = partitionSessionSubagents([
      { ...agent({ key: 'subagent:live', status: 'running', endedAt: null }), runId: 'r' },
      { ...agent({ key: 'subagent:ok', status: 'done' }), runId: 'r' },
      { ...agent({ key: 'subagent:bad', status: 'error' }), runId: 'r' },
    ]);
    expect(active.map((item) => item.key)).toEqual(['subagent:live']);
    expect(done.map((item) => item.key)).toEqual(['subagent:ok', 'subagent:bad']);
  });
});
