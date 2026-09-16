import { describe, expect, it } from 'vitest';
import { DEFAULT_TERMINAL_TAB_BASE, nextTerminalTitle } from './terminalTabs';

describe('nextTerminalTitle', () => {
  it('returns the base title when none exist', () => {
    expect(nextTerminalTitle([])).toBe(DEFAULT_TERMINAL_TAB_BASE);
    expect(nextTerminalTitle([], 'bash')).toBe('bash');
  });

  it('numbers subsequent tabs like VS Code', () => {
    expect(nextTerminalTitle(['zsh'])).toBe('zsh 2');
    expect(nextTerminalTitle(['zsh', 'zsh 2'])).toBe('zsh 3');
  });

  it('reuses the lowest free number after a tab was closed', () => {
    expect(nextTerminalTitle(['zsh', 'zsh 3'])).toBe('zsh 2');
  });

  it('ignores unrelated titles when picking the next number', () => {
    expect(nextTerminalTitle(['bash', 'zsh'])).toBe('zsh 2');
  });
});
