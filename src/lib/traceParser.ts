/**
 * Normalises Grok's `streaming-json` activity events into one stable shape.
 *
 * Grok 0.2.118 follows the ACP field names (`toolCallId`, `rawInput`,
 * `rawOutput`). Older releases and a few extensions use snake_case, so the
 * reader intentionally accepts both. The important invariant is that every
 * update for one tool/subagent resolves to the same key and is upserted.
 */

export type TraceKind = 'tool' | 'subagent' | 'task' | 'other';
export type TraceStatus = 'running' | 'done' | 'error' | 'cancelled';

export interface TraceEvent {
  key: string;
  kind: TraceKind;
  label: string;
  status: TraceStatus;
  startedAt: number;
  endedAt: number | null;
  detail?: string;
  parentKey?: string;
  progress?: string;
  path?: string;
  /** Compact unified diff retained after raw ACP payloads are discarded. */
  diff?: string;
  additions?: number;
  deletions?: number;
  raw?: unknown;
}

export type TraceParseResult = { kind: 'upsert'; event: TraceEvent } | { kind: 'ignore' };

export interface RunUsage {
  inputTokens: number;
  outputTokens: number;
  thoughtTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  totalTokens: number;
  turns?: number;
}

function asString(value: unknown): string | undefined {
  if (typeof value === 'string') return value;
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  return undefined;
}

function asNumber(value: unknown): number | undefined {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value === 'string' && value.trim() !== '') {
    const parsed = Number(value);
    if (Number.isFinite(parsed)) return parsed;
  }
  return undefined;
}

function readField(obj: Record<string, unknown>, ...names: string[]): string | undefined {
  for (const name of names) {
    const value = asString(obj[name]);
    if (value !== undefined && value !== '') return value;
  }
  return undefined;
}

function readNumber(obj: Record<string, unknown>, ...names: string[]): number | undefined {
  for (const name of names) {
    const value = asNumber(obj[name]);
    if (value !== undefined) return value;
  }
  return undefined;
}

function readObj(
  obj: Record<string, unknown>,
  ...names: string[]
): Record<string, unknown> | undefined {
  for (const name of names) {
    const value = obj[name];
    if (value && typeof value === 'object' && !Array.isArray(value)) {
      return value as Record<string, unknown>;
    }
  }
  return undefined;
}

function shorten(value: unknown, max = 180): string | undefined {
  if (value == null) return undefined;
  try {
    const text = typeof value === 'string' ? value : JSON.stringify(value);
    const compact = text.replace(/\s+/g, ' ').trim();
    if (!compact) return undefined;
    return compact.length <= max ? compact : `${compact.slice(0, max - 1)}…`;
  } catch {
    return undefined;
  }
}

function normaliseStatus(type: string, value: string | undefined): TraceStatus {
  const status = (value ?? '').toLowerCase();
  if (status === 'failed' || status === 'error' || type.endsWith('_failed')) return 'error';
  if (status === 'cancelled' || status === 'canceled' || type.endsWith('_cancelled')) {
    return 'cancelled';
  }
  if (
    status === 'completed' ||
    status === 'done' ||
    status === 'success' ||
    type.endsWith('_finished') ||
    type.endsWith('_complete') ||
    type.endsWith('_completed') ||
    type.endsWith('_done') ||
    type.endsWith('_result') ||
    type.endsWith('_end')
  ) {
    return 'done';
  }
  return 'running';
}

function typeOf(obj: Record<string, unknown>): string {
  return (readField(obj, 'type', 'sessionUpdate', 'session_update', 'event', 'kind') ?? '')
    .toLowerCase()
    .trim();
}

function planSummary(entries: unknown): string | undefined {
  if (!Array.isArray(entries)) return shorten(entries);
  let completed = 0;
  let active: string | undefined;
  for (const item of entries) {
    if (!item || typeof item !== 'object') continue;
    const entry = item as Record<string, unknown>;
    const status = readField(entry, 'status')?.toLowerCase();
    if (status === 'completed' || status === 'done') completed += 1;
    if (status === 'in_progress' || status === 'running') {
      active = readField(entry, 'content', 'title', 'description', 'label');
    }
  }
  const progress = entries.length > 0 ? `${completed}/${entries.length}` : undefined;
  return [progress, active].filter(Boolean).join(' · ') || undefined;
}

/** Parse one official or legacy activity line. */
export function classifyEvent(raw: unknown, now = Date.now()): TraceParseResult {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return { kind: 'ignore' };
  const obj = raw as Record<string, unknown>;
  const type = typeOf(obj);
  if (!type) return { kind: 'ignore' };

  // Text/thought/usage/end/error are handled by streamStore, not the rail.
  if (
    type === 'thought' ||
    type === 'text' ||
    type === 'end' ||
    type === 'error' ||
    type === 'usage' ||
    type === 'usage_update' ||
    type === 'agent_thought_chunk' ||
    type === 'agent_message_chunk' ||
    type === 'user_message_chunk' ||
    type === 'available_commands' ||
    type === 'available_commands_update'
  ) {
    return { kind: 'ignore' };
  }

  if (type === 'plan' || type === 'plan_update' || type.includes('task')) {
    const id = readField(obj, 'id', 'taskId', 'task_id', 'planId', 'plan_id') ?? 'current-plan';
    const entries = obj.entries;
    const status = normaliseStatus(type, readField(obj, 'status'));
    return {
      kind: 'upsert',
      event: {
        key: `task:${id}`,
        kind: 'task',
        label: readField(obj, 'title', 'name', 'plan') ?? 'Plan',
        status,
        startedAt: now,
        endedAt: status === 'running' ? null : now,
        detail: planSummary(entries) ?? shorten(obj.detail),
        raw,
      },
    };
  }

  const isSubagent = type.includes('subagent') || type.includes('sub_agent');
  const isTool =
    type === 'tool_call' ||
    type === 'tool_call_update' ||
    type === 'tool_use' ||
    type === 'tool_result' ||
    type.startsWith('tool_') ||
    obj.toolCallId != null ||
    obj.tool_call_id != null;
  if (!isSubagent && !isTool) return { kind: 'ignore' };

  const id = isSubagent
    ? readField(obj, 'subagentId', 'subagent_id', 'childSessionId', 'child_session_id', 'id')
    : readField(
        obj,
        'toolCallId',
        'tool_call_id',
        'tool_use_id',
        'toolId',
        'tool_id',
        'call_id',
        'invocation_id',
        'id',
      );
  const name = isSubagent
    ? readField(obj, 'description', 'title', 'name', 'role', 'subagent_type', 'subagent')
    : readField(obj, 'title', 'toolName', 'tool_name', 'name', 'tool', 'function_name');
  // ID-less legacy pairs still share a deterministic key. Official events
  // always carry toolCallId/subagent_id, so concurrent calls remain distinct.
  const keyName = name ?? (isSubagent ? 'agent' : 'tool');
  const key = `${isSubagent ? 'subagent' : 'tool'}:${id ?? keyName}`;
  const status = normaliseStatus(type, readField(obj, 'status'));
  const input =
    obj.rawInput ?? obj.raw_input ?? obj.input ?? obj.arguments ?? obj.args ?? obj.params;
  const output = obj.rawOutput ?? obj.raw_output ?? obj.output ?? obj.result ?? obj.response;
  const error = readField(obj, 'error', 'message', 'stderr');
  // ACP can emit bookkeeping-only tool updates without an id, title, input,
  // output, or error. They used to become a misleading extra “Tool” row.
  if (!id && !name && input == null && output == null && !error) return { kind: 'ignore' };
  const detail =
    status === 'error' ? (error ?? shorten(output)) : (shorten(output) ?? shorten(input));
  const parent = readField(obj, 'parentSessionId', 'parent_session_id', 'parentId', 'parent_id');
  const duration = readNumber(obj, 'durationMs', 'duration_ms');
  const toolCalls = readNumber(obj, 'toolCalls', 'tool_calls');
  const turns = readNumber(obj, 'turns');
  const progress =
    isSubagent && status !== 'running'
      ? [toolCalls != null ? `${toolCalls} tools` : '', turns != null ? `${turns} turns` : '']
          .filter(Boolean)
          .join(' · ') || undefined
      : readField(obj, 'progress', 'activity', 'current_activity');
  const inputObj =
    input && typeof input === 'object' && !Array.isArray(input)
      ? (input as Record<string, unknown>)
      : undefined;
  const outputObj =
    output && typeof output === 'object' && !Array.isArray(output)
      ? (output as Record<string, unknown>)
      : undefined;
  const locations = Array.isArray(obj.locations) ? obj.locations : [];
  const locationPath = locations
    .map((location) =>
      location && typeof location === 'object' && !Array.isArray(location)
        ? readField(location as Record<string, unknown>, 'path')
        : undefined,
    )
    .find(Boolean);
  const path =
    locationPath ??
    (inputObj
      ? readField(inputObj, 'file_path', 'path', 'target_file', 'filename', 'absolute_path')
      : undefined) ??
    (outputObj ? readField(outputObj, 'absolute_path', 'path', 'file_path') : undefined);
  const edit = extractEdit(outputObj);

  return {
    kind: 'upsert',
    event: {
      key,
      kind: isSubagent ? 'subagent' : 'tool',
      label: name ?? (isSubagent ? 'Subagent' : 'Tool'),
      status,
      startedAt: duration != null && status !== 'running' ? Math.max(0, now - duration) : now,
      endedAt: status === 'running' ? null : now,
      detail,
      parentKey: parent ? `subagent:${parent}` : undefined,
      progress,
      path,
      diff: edit?.diff,
      additions: edit?.additions,
      deletions: edit?.deletions,
      raw,
    },
  };
}

function extractEdit(
  output: Record<string, unknown> | undefined,
): { diff: string; additions: number; deletions: number } | undefined {
  if (!output) return undefined;
  const applied = readObj(output, 'EditsApplied', 'editsApplied', 'edits_applied');
  if (!applied) return undefined;
  const pairs: Array<{ oldText: string; newText: string }> = [];
  const directOld = asString(applied.old_string) ?? '';
  const directNew = asString(applied.new_string) ?? '';
  if (directOld || directNew) pairs.push({ oldText: directOld, newText: directNew });
  const edits = readObj(applied, 'edits');
  const details = edits && Array.isArray(edits.details) ? edits.details : [];
  for (const value of details) {
    if (!value || typeof value !== 'object' || Array.isArray(value)) continue;
    const detail = value as Record<string, unknown>;
    const oldText = readField(detail, 'old_string', 'old_line') ?? '';
    const newText = readField(detail, 'new_string', 'new_line') ?? '';
    if (oldText || newText) pairs.push({ oldText, newText });
  }
  if (pairs.length === 0) return undefined;
  const lines: string[] = [];
  let additions = 0;
  let deletions = 0;
  for (const pair of pairs) {
    for (const line of pair.oldText.split('\n')) {
      if (!pair.oldText && line === '') continue;
      lines.push(`-${line}`);
      deletions += 1;
    }
    for (const line of pair.newText.split('\n')) {
      if (!pair.newText && line === '') continue;
      lines.push(`+${line}`);
      additions += 1;
    }
  }
  return lines.length ? { diff: lines.join('\n'), additions, deletions } : undefined;
}

/** Extract authoritative usage from `usage` and final `end` lines. */
export function extractUsage(raw: unknown): RunUsage | undefined {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return undefined;
  const obj = raw as Record<string, unknown>;
  const usage = readObj(obj, 'usage');
  if (!usage) return undefined;
  const inputTokens = readNumber(usage, 'input_tokens', 'inputTokens') ?? 0;
  const outputTokens = readNumber(usage, 'output_tokens', 'outputTokens') ?? 0;
  const thoughtTokens = readNumber(usage, 'reasoning_tokens', 'thoughtTokens') ?? 0;
  const cacheReadTokens =
    readNumber(usage, 'cache_read_input_tokens', 'cacheReadInputTokens', 'cachedReadTokens') ?? 0;
  const cacheWriteTokens =
    readNumber(
      usage,
      'cache_creation_input_tokens',
      'cacheWriteInputTokens',
      'cachedWriteTokens',
    ) ?? 0;
  const totalTokens =
    readNumber(usage, 'total_tokens', 'totalTokens') ??
    inputTokens + outputTokens + cacheReadTokens + cacheWriteTokens;
  return {
    inputTokens,
    outputTokens,
    thoughtTokens,
    cacheReadTokens,
    cacheWriteTokens,
    totalTokens,
    turns: readNumber(obj, 'num_turns', 'numTurns', 'turns'),
  };
}

export function extractRunError(raw: unknown): string | undefined {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return undefined;
  const obj = raw as Record<string, unknown>;
  if (typeOf(obj) !== 'error') return undefined;
  return readField(obj, 'message', 'error', 'stderr') ?? 'Grok reported an error';
}
