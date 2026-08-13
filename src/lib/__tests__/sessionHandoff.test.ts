import { describe, expect, it } from 'vitest';
import {
  dropUndoneUserTurn,
  exportFingerprint,
  importedHasNewTurns,
  isHarnessUserContent,
  messagesFromGrokExport,
  stripDesktopTurnInstructions,
  unwrapUserQuery,
} from '../sessionHandoff';

describe('messagesFromGrokExport', () => {
  it('maps user/assistant sections and skips tools', () => {
    const md = [
      '## User',
      '',
      'hello',
      '',
      '## Assistant',
      '',
      'hi there',
      '',
      '## Tools',
      '',
      '- Read: foo.ts',
      '',
      '## Assistant',
      '',
      'and more',
    ].join('\n');
    const messages = messagesFromGrokExport(md, 'sess-1');
    expect(messages).toHaveLength(2);
    expect(messages[0]).toMatchObject({
      id: 'sess-1:u:1',
      role: 'user',
      content: 'hello',
    });
    expect(messages[1]).toMatchObject({
      id: 'sess-1:a:1',
      role: 'assistant',
      content: 'hi there\n\nand more',
      meta: { sessionId: 'sess-1' },
    });
  });

  it('skips system / harness user payloads and unwraps user_query', () => {
    const md = [
      '## System',
      '',
      'You are Grok 4.6 released by xAI.',
      '',
      '## User',
      '',
      'Grok Desktop instructions for this turn:\nOperate as a senior engineer.\n\nWorkspace contract:\n- Current working directory: /tmp',
      '',
      '## User',
      '',
      'You are Grok 4.6\n\n<work_policy>\n- Keep every requirement\n',
      '',
      '## User',
      '',
      '<user_info>\nOS Version: macos\n</user_info>',
      '',
      '## User',
      '',
      '<system-reminder>\n## Available Skills\n- foo\n</system-reminder>',
      '',
      '## User',
      '',
      'This session is being continued from a previous conversation that ran out of context.',
      '',
      '## User',
      '',
      'The user sent a message while you were working:\n<user_query>\n修一下 /cli\n</user_query>',
      '',
      '## Assistant',
      '',
      '好的，我来修。',
    ].join('\n');
    const messages = messagesFromGrokExport(md, 'sess-x');
    expect(messages).toHaveLength(2);
    expect(messages[0]).toMatchObject({ role: 'user', content: '修一下 /cli' });
    expect(messages[1]).toMatchObject({ role: 'assistant', content: '好的，我来修。' });
  });

  it('uses stable ids across re-parses of the same export', () => {
    const md = '## User\n\nhi\n\n## Assistant\n\nyo\n';
    const a = messagesFromGrokExport(md, 's');
    const b = messagesFromGrokExport(md, 's');
    expect(a.map((m) => m.id)).toEqual(b.map((m) => m.id));
  });
});

describe('harness filters', () => {
  it('detects harness content', () => {
    expect(isHarnessUserContent('You are Grok 4.6 released by xAI.')).toBe(true);
    expect(
      isHarnessUserContent(
        'You are an interactive CLI tool that helps users with software engineering tasks.',
      ),
    ).toBe(true);
    expect(isHarnessUserContent('<system-reminder>\nidle\n</system-reminder>')).toBe(true);
    expect(isHarnessUserContent('normal chat')).toBe(false);
  });

  it('drops system-prompt-shaped assistant sections', () => {
    const md = [
      '## Assistant',
      '',
      'You are Grok 4.6 released by xAI. You are an interactive CLI tool...',
      '',
      '## User',
      '',
      'real question',
      '',
      '## Assistant',
      '',
      'real answer',
    ].join('\n');
    const messages = messagesFromGrokExport(md, 's2');
    expect(messages).toHaveLength(2);
    expect(messages[0]).toMatchObject({ role: 'user', content: 'real question' });
    expect(messages[1]).toMatchObject({ role: 'assistant', content: 'real answer' });
  });

  it('unwraps user_query tags', () => {
    expect(unwrapUserQuery('<user_query>\nhello\n</user_query>')).toBe('hello');
    expect(unwrapUserQuery('plain')).toBe('plain');
  });

  it('keeps the real query after a leaked Desktop rules prefix', () => {
    const glued = [
      'Grok Desktop instructions for this turn:',
      'Operate as a senior engineer: high signal, minimal ceremony.',
      'Before editing, quickly map the repo.',
      '',
      'hello from desktop',
    ].join('\n');
    expect(stripDesktopTurnInstructions(glued)).toBe('hello from desktop');
    expect(stripDesktopTurnInstructions(`<user_query>\n${glued}\n</user_query>`)).toBe(
      'hello from desktop',
    );

    const md = `## User\n\n${glued}\n\n## Assistant\n\nok\n`;
    const messages = messagesFromGrokExport(md, 'sess-cli');
    expect(messages).toHaveLength(2);
    expect(messages[0]).toMatchObject({ role: 'user', content: 'hello from desktop' });
  });

  it('detects CLI turns the local transcript is missing', () => {
    const local = [
      { role: 'user', content: 'hello' },
      { role: 'assistant', content: 'hi' },
    ];
    const imported = [
      ...local,
      { role: 'user', content: 'from CLI' },
      { role: 'assistant', content: 'cli reply' },
    ];
    expect(importedHasNewTurns(local, imported)).toBe(true);
    expect(importedHasNewTurns(imported, imported)).toBe(false);
    expect(
      importedHasNewTurns(
        [
          { role: 'user', content: 'q' },
          { role: 'assistant', content: 'first paragraph' },
        ],
        [
          { role: 'user', content: 'q' },
          { role: 'assistant', content: 'first paragraph\n\nrest after tools' },
        ],
      ),
    ).toBe(true);
  });

  it('drops an undone user turn and its assistant reply', () => {
    const rows = [
      { role: 'user', content: 'keep' },
      { role: 'assistant', content: 'ok' },
      { role: 'user', content: 'undo me' },
      { role: 'assistant', content: 'gone' },
      { role: 'user', content: 'from cli' },
    ];
    expect(dropUndoneUserTurn(rows, 'undo me')).toEqual([
      { role: 'user', content: 'keep' },
      { role: 'assistant', content: 'ok' },
      { role: 'user', content: 'from cli' },
    ]);
  });

  it('drops the latest matching user turn when prompts repeat', () => {
    const rows = [
      { role: 'user', content: 'continue' },
      { role: 'assistant', content: 'first reply' },
      { role: 'user', content: 'continue' },
      { role: 'assistant', content: 'second reply' },
    ];
    expect(dropUndoneUserTurn(rows, 'continue')).toEqual([
      { role: 'user', content: 'continue' },
      { role: 'assistant', content: 'first reply' },
    ]);
  });

  it('preserves later CLI turns when dropping a repeated Desktop turn', () => {
    const rows = [
      { role: 'user', content: 'continue' },
      { role: 'assistant', content: 'first reply' },
      { role: 'user', content: 'continue' },
      { role: 'assistant', content: 'undone reply' },
      { role: 'user', content: 'from CLI' },
      { role: 'assistant', content: 'CLI reply' },
    ];
    expect(dropUndoneUserTurn(rows, 'continue')).toEqual([
      { role: 'user', content: 'continue' },
      { role: 'assistant', content: 'first reply' },
      { role: 'user', content: 'from CLI' },
      { role: 'assistant', content: 'CLI reply' },
    ]);
  });

  it('fingerprints export text stably', () => {
    expect(exportFingerprint('abc')).toBe(exportFingerprint('abc'));
    expect(exportFingerprint('abc')).not.toBe(exportFingerprint('abd'));
  });
});
