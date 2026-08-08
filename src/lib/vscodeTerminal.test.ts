import { describe, expect, it } from 'vitest';
import { VS_CODE_DARK_MODERN_TERMINAL_THEME, VS_CODE_TERMINAL_OPTIONS } from './vscodeTerminal';

describe('VS Code terminal parity', () => {
  it('keeps the cursor obvious and preserves shell-provided ANSI contrast', () => {
    expect(VS_CODE_TERMINAL_OPTIONS).toMatchObject({
      cursorBlink: true,
      cursorStyle: 'block',
      cursorInactiveStyle: 'block',
      minimumContrastRatio: 1,
    });
  });

  it('uses the Dark Modern foreground and ANSI dim color', () => {
    expect(VS_CODE_DARK_MODERN_TERMINAL_THEME).toMatchObject({
      background: '#181818',
      foreground: '#CCCCCC',
      brightBlack: '#666666',
    });
  });
});
