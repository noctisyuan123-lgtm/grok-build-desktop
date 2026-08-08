import { describe, expect, it } from 'vitest';
import { VS_CODE_DARK_MODERN_TERMINAL_THEME, VS_CODE_TERMINAL_OPTIONS } from './vscodeTerminal';

describe('VS Code terminal parity', () => {
  it('uses the VS Code cursor and contrast defaults', () => {
    expect(VS_CODE_TERMINAL_OPTIONS).toMatchObject({
      cursorBlink: false,
      cursorStyle: 'block',
      cursorInactiveStyle: 'outline',
      minimumContrastRatio: 4.5,
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
