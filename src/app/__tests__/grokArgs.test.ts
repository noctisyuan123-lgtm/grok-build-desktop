import { describe, expect, it } from 'vitest';
import {
  buildConversationReplayBlock,
  buildGrokArgs,
  buildGrokRules,
  type GrokRunConfig,
} from '../grokArgs';

function config(overrides: Partial<GrokRunConfig> = {}): GrokRunConfig {
  return {
    mode: 'coding',
    activeModel: 'grok-build',
    reasoningEffort: 'medium',
    actionPolicy: 'patch',
    permissionMode: 'default',
    experimentalMemory: false,
    webSearchEnabled: true,
    codingCwd: '',
    resumeSessionId: null,
    continueLatestSession: false,
    ...overrides,
  };
}

/** Value of the flag that immediately follows `flag` in args, or null. */
function flagValue(args: string[], flag: string): string | null {
  const index = args.indexOf(flag);
  return index >= 0 ? (args[index + 1] ?? null) : null;
}

describe('buildGrokRules', () => {
  it('returns null outside coding mode', () => {
    expect(buildGrokRules({ mode: 'standard', actionPolicy: 'review' })).toBeNull();
  });

  it('adds the read-only contract only for the review policy', () => {
    const review = buildGrokRules({ mode: 'coding', actionPolicy: 'review' })!;
    const patch = buildGrokRules({ mode: 'coding', actionPolicy: 'patch' })!;
    expect(review).toContain('Enter plan mode');
    expect(review).toContain('Stay read-only');
    expect(patch).not.toContain('Stay read-only');
    expect(patch).toContain('senior engineer');
  });
});

describe('buildGrokArgs', () => {
  it('always requests streaming json and caps turns', () => {
    const args = buildGrokArgs(config());
    expect(args.slice(0, 3)).toEqual(['--no-alt-screen', '--output-format', 'streaming-json']);
    expect(flagValue(args, '--max-turns')).toBe('12');
  });

  it('passes model and a single reasoning-effort flag', () => {
    const args = buildGrokArgs(config({ activeModel: 'grok-latest', reasoningEffort: 'high' }));
    expect(flagValue(args, '--model')).toBe('grok-latest');
    // grok 1.0 accepts one reasoning-effort control.
    expect(args).not.toContain('--effort');
    expect(flagValue(args, '--reasoning-effort')).toBe('high');
  });

  it('maps max to xhigh and omits the flag for Auto', () => {
    expect(flagValue(buildGrokArgs(config({ reasoningEffort: 'max' })), '--reasoning-effort')).toBe(
      'xhigh',
    );
    expect(buildGrokArgs(config({ reasoningEffort: 'off' }))).not.toContain('--reasoning-effort');
  });

  it('maps autopilot to --always-approve and suppresses --permission-mode', () => {
    const args = buildGrokArgs(config({ actionPolicy: 'autopilot', permissionMode: 'plan' }));
    expect(args).toContain('--always-approve');
    expect(args).not.toContain('--permission-mode');
  });

  it('passes a non-default permission mode for the patch policy', () => {
    const args = buildGrokArgs(config({ actionPolicy: 'patch', permissionMode: 'plan' }));
    expect(flagValue(args, '--permission-mode')).toBe('plan');
    expect(args).not.toContain('--always-approve');
    const defaults = buildGrokArgs(config({ actionPolicy: 'patch', permissionMode: 'default' }));
    expect(defaults).not.toContain('--permission-mode');
  });

  it('keeps the review policy read-only via rules, not permission flags', () => {
    const args = buildGrokArgs(config({ actionPolicy: 'review' }));
    expect(args).not.toContain('--always-approve');
    expect(args).not.toContain('--permission-mode');
    expect(flagValue(args, '--rules')).toContain('Stay read-only');
  });

  it('only sends --rules in coding mode', () => {
    expect(buildGrokArgs(config({ mode: 'standard' }))).not.toContain('--rules');
    expect(buildGrokArgs(config({ mode: 'coding' }))).toContain('--rules');
  });

  it('keeps subagents available without a user-facing disable flag', () => {
    expect(buildGrokArgs(config())).not.toContain('--no-subagents');
  });

  it('maps the remaining toggles to their flags', () => {
    const args = buildGrokArgs(config({ experimentalMemory: true, webSearchEnabled: false }));
    expect(args).toContain('--experimental-memory');
    expect(args).toContain('--disable-web-search');
    expect(args).not.toContain('--check');
    const off = buildGrokArgs(config());
    expect(off).not.toContain('--experimental-memory');
    expect(off).not.toContain('--disable-web-search');
  });

  it('passes --cwd only in coding mode with a non-blank path', () => {
    expect(flagValue(buildGrokArgs(config({ codingCwd: ' /repo ' })), '--cwd')).toBe('/repo');
    expect(buildGrokArgs(config({ codingCwd: '   ' }))).not.toContain('--cwd');
    expect(buildGrokArgs(config({ mode: 'standard', codingCwd: '/repo' }))).not.toContain('--cwd');
  });

  it('forks an explicit session head so undo can move context backward', () => {
    const explicit = buildGrokArgs(config({ resumeSessionId: 'session-parent' }));
    expect(flagValue(explicit, '--resume')).toBe('session-parent');
    expect(explicit).toContain('--fork-session');
    expect(explicit).not.toContain('-c');

    const queued = buildGrokArgs(config({ continueLatestSession: true }));
    expect(queued).toContain('-c');
    expect(queued).toContain('--fork-session');
  });

  it('shares the session head without forking when live-linked to CLI', () => {
    const shared = buildGrokArgs(
      config({ resumeSessionId: 'live-session', shareSession: true }),
    );
    expect(flagValue(shared, '--resume')).toBe('live-session');
    expect(shared).toContain('--share-session');
    expect(shared).not.toContain('--fork-session');

    const sharedContinue = buildGrokArgs(
      config({ continueLatestSession: true, shareSession: true }),
    );
    expect(sharedContinue).toContain('-c');
    expect(sharedContinue).toContain('--share-session');
    expect(sharedContinue).not.toContain('--fork-session');
  });

  it('never combines explicit resume with queue-time -c', () => {
    // resumeSessionId wins; continueLatest is only the pre-session-id fallback.
    const args = buildGrokArgs(
      config({ resumeSessionId: 's-explicit', continueLatestSession: true }),
    );
    expect(flagValue(args, '--resume')).toBe('s-explicit');
    expect(args).not.toContain('-c');
  });

  it('starts a clean branch when neither resume nor continue is set', () => {
    const args = buildGrokArgs(config());
    expect(args).not.toContain('--resume');
    expect(args).not.toContain('-c');
    expect(args).not.toContain('--fork-session');
  });

  it('forceNewSession drops resume/continue so the undone turn cannot remain in context', () => {
    const args = buildGrokArgs(
      config({
        forceNewSession: true,
        resumeSessionId: 'session-with-undone-turn',
        continueLatestSession: true,
      }),
    );
    expect(args).not.toContain('--resume');
    expect(args).not.toContain('-c');
    expect(args).not.toContain('--fork-session');
  });

  it('re-seeds only visible pre-undo turns into --rules when forcing a fresh session', () => {
    const args = buildGrokArgs(
      config({
        forceNewSession: true,
        resumeSessionId: 'session-with-undone-turn',
        replayMessages: [
          { role: 'user', content: 'First question' },
          { role: 'assistant', content: 'First answer' },
          { role: 'user', content: '  ' }, // blank → omitted
        ],
      }),
    );
    expect(args).not.toContain('--resume');
    const rules = flagValue(args, '--rules')!;
    expect(rules).toContain('re-seeded into a fresh session after Undo');
    expect(rules).toContain('First question');
    expect(rules).toContain('First answer');
    // Coding rules still present alongside the replay block.
    expect(rules).toContain('senior engineer');
  });

  it('does not inject a replay block when forceNewSession has no prior turns', () => {
    const args = buildGrokArgs(config({ forceNewSession: true, replayMessages: [] }));
    const rules = flagValue(args, '--rules');
    expect(rules ?? '').not.toContain('re-seeded into a fresh session after Undo');
  });
});

describe('buildConversationReplayBlock', () => {
  it('returns null for empty or blank-only messages', () => {
    expect(buildConversationReplayBlock([])).toBeNull();
    expect(buildConversationReplayBlock([{ role: 'user', content: '   ' }])).toBeNull();
  });

  it('formats visible turns without inventing the undone pair', () => {
    const block = buildConversationReplayBlock([
      { role: 'user', content: 'Keep me' },
      { role: 'assistant', content: 'Visible reply' },
    ])!;
    expect(block).toContain('User:\nKeep me');
    expect(block).toContain('Assistant:\nVisible reply');
    expect(block).toContain('intentionally absent');
  });
});
