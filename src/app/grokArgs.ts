// Pure builders for the grok CLI invocation. Extracted from App.tsx —
// behavior must match the composer's submit path exactly.
import type { ActionPolicy, Mode, PermissionMode, ReasoningEffort } from './types';

/** Visible chat turns re-seeded into a fresh ACP session. */
export type ReplayMessage = {
  role: 'user' | 'assistant';
  content: string;
};

export interface GrokRunConfig {
  mode: Mode;
  activeModel: string;
  reasoningEffort: ReasoningEffort;
  actionPolicy: ActionPolicy;
  permissionMode: PermissionMode;
  experimentalMemory: boolean;
  webSearchEnabled: boolean;
  codingCwd: string;
  /** Exact conversation head to fork. Avoids cwd-global `-c` leaking undone turns. */
  resumeSessionId?: string | null;
  /** Queue-time fallback while the parent run has not emitted its id yet. */
  continueLatestSession?: boolean;
  /**
   * After Undo: do not resume the prior ACP session. ACP `session/load` cannot
   * rewind, so the undone turn would still be model context if we resumed.
   */
  forceNewSession?: boolean;
  /**
   * Visible turns that remain after Undo (excluding the undone pair). When
   * forceNewSession is set, these are re-seeded into the fresh session as
   * instruction context ahead of the replacement prompt.
   */
  replayMessages?: ReplayMessage[];
  /**
   * When live-linked with CLI (`/cli` / `/desktop`), resume the same session
   * head without `--fork-session` so both surfaces write one shared transcript.
   * Normal Desktop turns still fork so Undo can isolate heads.
   */
  shareSession?: boolean;
  /** Resume an already-rewound Edit head in place without joining the CLI leader. */
  resumeSessionInPlace?: boolean;
}

/**
 * Visible conversation context carried via `--rules` so the Composer prompt
 * stays an exact mirror of what the user typed.
 */
export function buildConversationReplayBlock(messages: readonly ReplayMessage[]): string | null {
  const usable = messages
    .map((message) => ({
      role: message.role,
      content: message.content.trim(),
    }))
    .filter((message) => message.content.length > 0);
  if (usable.length === 0) return null;
  const body = usable
    .map((message) => {
      const label = message.role === 'user' ? 'User' : 'Assistant';
      return `${label}:\n${message.content}`;
    })
    .join('\n\n');
  return body;
}

// The user turn is EXACTLY what the user typed. grok-build already ships a
// strong coding system prompt, so durable behavioural guidance is appended at
// the system level via `--rules` (see buildGrokRules) instead of bolting a
// preamble onto every user turn. That keeps the model on-task, makes the
// chat bubble an exact mirror of the request, and avoids fighting
// grok-build's own prompt. Operational settings (reasoning/
// permission/web) ride as real CLI flags — never echoed as prose.

// Durable, system-level guidance for grok-build, passed via `--rules` (grok
// appends it to the agent's own system prompt — verified the model honours
// it). Kept TIGHT: only high-value additions beyond grok-build's defaults.
// We deliberately do NOT report grok's own ecosystem back to it (it discovers
// its 90+ skills / MCP servers itself via `grok inspect`; the old preamble
// hard-said "0 skills" before inspect had run, which was actively wrong).
export function buildGrokRules(
  config: Pick<GrokRunConfig, 'mode' | 'actionPolicy'>,
): string | null {
  if (config.mode !== 'coding') return null;
  const rules = [
    'Operate as a senior engineer: high signal, minimal ceremony.',
    'Before editing, quickly map the repo — entry points, likely files, build/test commands, risk boundaries.',
    'Prefer exact file paths, exact commands, and concrete diffs over prose.',
    'Keep edits narrow and make verification easy: give one command to verify each change.',
    'If the request is ambiguous, make the safest useful assumption and state it in one line.',
  ];
  // The Plan policy has no legacy Grok CLI flag, so its contract travels with
  // the turn. In ACP, Grok can enter its native plan mode via
  // `enter_plan_mode`; the host also rejects protected actions as a hard
  // read-only backstop.
  if (config.actionPolicy === 'review') {
    rules.push(
      'Enter plan mode before doing the work. Stay read-only: inspect and reason, but do not edit files or run mutating commands. Return a concrete implementation plan.',
    );
  }
  return rules.join('\n');
}

/** grok 1.0 treats `--effort` as an alias of `--reasoning-effort`. */
function mapGrokEffort(value: string): string {
  // grok accepts: none|minimal|low|medium|high|xhigh. The UI's "Max" is not
  // a valid value — sending it makes grok exit 2 and reply nothing.
  return value === 'max' ? 'xhigh' : value;
}

export function resolveGrokEffort(config: Pick<GrokRunConfig, 'reasoningEffort'>): string | null {
  if (!config.reasoningEffort || config.reasoningEffort === 'off') return null;
  return mapGrokEffort(config.reasoningEffort);
}

export function buildGrokArgs(config: GrokRunConfig): string[] {
  const args: string[] = ['--no-alt-screen', '--output-format', 'streaming-json'];
  if (config.activeModel) args.push('--model', config.activeModel);
  // One flag only. Sending both `--effort` and `--reasoning-effort` is the
  // same clap option twice and grok exits 2.
  const effort = resolveGrokEffort(config);
  if (effort) args.push('--reasoning-effort', effort);
  // Action policy → REAL grok permission behavior.
  //   review   → Plan contract (carried by --rules); no permission flag
  //   patch    → respect the advanced Settings permission-mode override (incl.
  //              "plan" for power users), else grok's default approvals
  //   autopilot→ --always-approve  (auto-approves EVERY tool call — risky)
  if (config.actionPolicy === 'autopilot') {
    args.push('--always-approve');
  } else if (config.permissionMode && config.permissionMode !== 'default') {
    args.push('--permission-mode', config.permissionMode);
  }
  // Behavioural guidance at the system-prompt level (grok-native), instead of
  // a preamble in the user turn. Coding mode only; chat stays freeform.
  // After Undo, ACP cannot rewind the loaded session, so we start fresh and
  // re-seed only the still-visible turns as instruction context.
  const ruleParts: string[] = [];
  const baseRules = buildGrokRules(config);
  if (baseRules) ruleParts.push(baseRules);
  if (config.forceNewSession && config.replayMessages?.length) {
    const replay = buildConversationReplayBlock(config.replayMessages);
    if (replay) ruleParts.push(replay);
  }
  if (ruleParts.length > 0) args.push('--rules', ruleParts.join('\n\n'));
  if (config.experimentalMemory) args.push('--experimental-memory');
  if (!config.webSearchEnabled) args.push('--disable-web-search');
  args.push('--max-turns', '12');
  if (config.mode === 'coding' && config.codingCwd.trim()) {
    args.push('--cwd', config.codingCwd.trim());
  }
  // Normal turns resume the UI's visible conversation head. After Undo we
  // force a clean session (ACP cannot drop the undone turn from a loaded
  // head) and rely on replayMessages for earlier visible context. `-c` is
  // only a queue-time fallback before the parent run has returned its id.
  // Live CLI↔Desktop link uses the same head (no fork) so both sides listen.
  if (!config.forceNewSession && config.resumeSessionId) {
    args.push('--resume', config.resumeSessionId);
    if (config.shareSession) args.push('--share-session');
    else if (!config.resumeSessionInPlace) args.push('--fork-session');
  } else if (!config.forceNewSession && config.continueLatestSession) {
    args.push('-c');
    if (config.shareSession) args.push('--share-session');
    else args.push('--fork-session');
  }
  return args;
}
