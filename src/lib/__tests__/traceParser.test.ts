import { describe, expect, it } from 'vitest';
import { classifyEvent, extractPlanEntries, extractRunError, extractUsage } from '../traceParser';

function eventOf(raw: unknown) {
  const result = classifyEvent(raw, 1_000);
  expect(result.kind).toBe('upsert');
  if (result.kind !== 'upsert') throw new Error('expected activity event');
  return result.event;
}

describe('classifyEvent', () => {
  it('ignores response, usage, terminal, and unknown payloads', () => {
    expect(classifyEvent({ type: 'thought', data: 'x' }).kind).toBe('ignore');
    expect(classifyEvent({ type: 'text', data: 'x' }).kind).toBe('ignore');
    expect(classifyEvent({ type: 'usage', usage: {} }).kind).toBe('ignore');
    expect(classifyEvent({ type: 'end' }).kind).toBe('ignore');
    expect(classifyEvent({ type: 'error', message: 'nope' }).kind).toBe('ignore');
    expect(classifyEvent({ type: 'random_unknown' }).kind).toBe('ignore');
    expect(classifyEvent(null).kind).toBe('ignore');
  });

  it('normalises the official Grok 0.2.118 tool_call shape', () => {
    const event = eventOf({
      type: 'tool_call',
      toolCallId: 'call_1',
      title: 'Read',
      kind: 'read',
      status: 'in_progress',
      toolName: 'read_file',
      rawInput: { path: 'src/main.rs' },
    });
    expect(event).toMatchObject({
      key: 'tool:call_1',
      kind: 'tool',
      label: 'Read',
      status: 'running',
      detail: '{"path":"src/main.rs"}',
    });
  });

  it('updates the same toolCallId and honours terminal statuses', () => {
    const completed = eventOf({
      type: 'tool_call_update',
      toolCallId: 'call_1',
      status: 'completed',
      rawOutput: { lines: 42 },
    });
    expect(completed.key).toBe('tool:call_1');
    expect(completed.status).toBe('done');
    expect(completed.endedAt).toBe(1_000);

    const failed = eventOf({
      type: 'tool_call_update',
      toolCallId: 'call_2',
      status: 'failed',
      error: 'permission denied',
    });
    expect(failed.status).toBe('error');
    expect(failed.detail).toContain('permission denied');
  });

  it('derives a persistent edit diff and file stats from ACP output', () => {
    const edit = eventOf({
      type: 'tool_call_update',
      toolCallId: 'edit_1',
      title: 'Edit settings',
      status: 'completed',
      locations: [{ path: '.zshrc' }],
      rawOutput: {
        EditsApplied: { old_string: 'MODEL=k3', new_string: 'MODEL=k3-256k' },
      },
    });
    expect(edit).toMatchObject({
      path: '.zshrc',
      diff: '-MODEL=k3\n+MODEL=k3-256k',
      additions: 1,
      deletions: 1,
    });
  });

  it('does not double-count a created file repeated in direct and nested edit fields', () => {
    const edit = eventOf({
      type: 'tool_call_update',
      toolCallId: 'create_1',
      title: 'Edit `/tmp/hello.py`',
      status: 'completed',
      rawOutput: {
        EditsApplied: {
          absolute_path: '/tmp/hello.py',
          new_string: 'print("hello")\nmain()',
          edits: {
            details: [{ new_line: 1, new_string: 'print("hello")\nmain()' }],
          },
        },
      },
    });
    expect(edit).toMatchObject({
      diff: '+print("hello")\n+main()',
      additions: 2,
      deletions: 0,
    });
  });

  it('ignores nameless ACP bookkeeping updates instead of adding a fake Tool row', () => {
    expect(
      classifyEvent({ type: 'tool_call_update', status: 'completed', durationMs: 8_500 }).kind,
    ).toBe('ignore');
  });

  it('keeps compatibility with legacy snake_case tool events', () => {
    const start = eventOf({
      type: 'tool_use',
      id: 'legacy',
      name: 'Edit',
      input: { file: 'a.ts' },
    });
    const end = eventOf({ type: 'tool_result', tool_use_id: 'legacy', name: 'Edit', output: 'ok' });
    expect(start.key).toBe('tool:legacy');
    expect(end.key).toBe(start.key);
    expect(end.status).toBe('done');
  });

  it('normalises spawned and finished subagents into one lifecycle', () => {
    const spawned = eventOf({
      type: 'subagent_spawned',
      subagent_id: 'agent_1',
      parent_session_id: 'parent_1',
      description: 'Review frontend quality',
      subagent_type: 'explore',
      rawInput: {
        prompt: 'Inspect the frontend for a11y regressions and list the files to change.',
      },
    });
    const finished = eventOf({
      type: 'subagent_finished',
      subagent_id: 'agent_1',
      status: 'completed',
      tool_calls: 17,
      turns: 2,
      duration_ms: 8_000,
    });
    expect(spawned).toMatchObject({
      key: 'subagent:agent_1',
      kind: 'subagent',
      label: 'Review frontend quality',
      status: 'running',
      parentKey: 'subagent:parent_1',
      prompt: 'Inspect the frontend for a11y regressions and list the files to change.',
    });
    expect(finished.key).toBe(spawned.key);
    expect(finished.status).toBe('done');
    expect(finished.progress).toBe('17 tools · 2 turns');
    expect(finished.startedAt).toBe(0);
  });

  it('reads the parent prompt off an ACP Task tool_call', () => {
    const event = eventOf({
      sessionUpdate: 'tool_call',
      toolCallId: 'task-1',
      title: 'Explore workspace again',
      kind: 'task',
      status: 'in_progress',
      rawInput: {
        description: 'Explore workspace again',
        prompt: 'List the files in the workspace and say what each one is for.',
        subagent_type: 'explore',
      },
    });
    expect(event).toMatchObject({
      key: 'tool:task-1',
      kind: 'tool',
      label: 'Explore workspace again',
      prompt: 'List the files in the workspace and say what each one is for.',
    });
  });

  it('reduces plan entries into one progress row', () => {
    const plan = eventOf({
      type: 'plan',
      entries: [
        { content: 'Inspect', status: 'completed' },
        { content: 'Implement', status: 'in_progress' },
        { content: 'Verify', status: 'pending' },
      ],
    });
    expect(plan).toMatchObject({
      key: 'task:current-plan',
      kind: 'task',
      label: 'Plan',
      detail: '1/3 · Implement',
    });
  });
});

describe('extractPlanEntries', () => {
  it('maps common text and status fields from plan / plan_update payloads', () => {
    expect(
      extractPlanEntries({
        type: 'plan',
        entries: [
          { content: 'Inspect', status: 'completed' },
          { title: 'Implement', status: 'running' },
          { description: 'Verify', status: 'todo' },
          { label: 'Ship', status: 'done' },
        ],
      }),
    ).toEqual([
      { text: 'Inspect', status: 'completed' },
      { text: 'Implement', status: 'in_progress' },
      { text: 'Verify', status: 'pending' },
      { text: 'Ship', status: 'completed' },
    ]);

    expect(
      extractPlanEntries({
        type: 'plan_update',
        entries: [{ content: 'Almost done', status: 'in_progress' }],
      }),
    ).toEqual([{ text: 'Almost done', status: 'in_progress' }]);
  });

  it('returns null for non-plan events or empty entries', () => {
    expect(extractPlanEntries({ type: 'tool_call', entries: [{ content: 'x' }] })).toBeNull();
    expect(extractPlanEntries({ type: 'plan' })).toBeNull();
    expect(extractPlanEntries({ type: 'plan', entries: [] })).toBeNull();
    expect(extractPlanEntries({ type: 'plan', entries: [{ status: 'pending' }] })).toBeNull();
    expect(extractPlanEntries(null)).toBeNull();
  });
});

describe('run metadata extraction', () => {
  it('reads authoritative usage and turns from final events', () => {
    expect(
      extractUsage({
        type: 'end',
        usage: {
          input_tokens: 812,
          output_tokens: 45,
          cache_read_input_tokens: 100,
          cache_creation_input_tokens: 20,
          reasoning_tokens: 12,
        },
        num_turns: 7,
      }),
    ).toEqual({
      inputTokens: 812,
      outputTokens: 45,
      thoughtTokens: 12,
      cacheReadTokens: 100,
      cacheWriteTokens: 20,
      totalTokens: 977,
      turns: 7,
    });
  });

  it('extracts run-level error lines without turning them into tools', () => {
    expect(extractRunError({ type: 'error', message: 'quota exhausted' })).toBe('quota exhausted');
    expect(extractRunError({ type: 'text', data: 'error' })).toBeUndefined();
  });
});
