import type { ITerminalOptions, ITheme } from '@xterm/xterm';

// Values copied from the local VS Code 1.132 Dark Modern theme and integrated
// terminal defaults. Keep these together so the terminal does not slowly drift
// back into an editor-inspired approximation.
export const VS_CODE_DARK_MODERN_TERMINAL_THEME: ITheme = {
  background: '#181818',
  foreground: '#CCCCCC',
  black: '#000000',
  red: '#CD3131',
  green: '#0DBC79',
  yellow: '#E5E510',
  blue: '#2472C8',
  magenta: '#BC3FBC',
  cyan: '#11A8CD',
  white: '#E5E5E5',
  brightBlack: '#666666',
  brightRed: '#F14C4C',
  brightGreen: '#23D18B',
  brightYellow: '#F5F543',
  brightBlue: '#3B8EEA',
  brightMagenta: '#D670D6',
  brightCyan: '#29B8DB',
  brightWhite: '#E5E5E5',
  cursor: '#CCCCCC',
  cursorAccent: '#181818',
  selectionBackground: '#264F78',
};

export const VS_CODE_TERMINAL_OPTIONS = {
  cursorBlink: false,
  cursorStyle: 'block',
  cursorInactiveStyle: 'outline',
  drawBoldTextInBrightColors: true,
  fontFamily: "Menlo, Monaco, 'Courier New', monospace",
  fontSize: 12,
  letterSpacing: 0,
  lineHeight: 1,
  minimumContrastRatio: 4.5,
  theme: VS_CODE_DARK_MODERN_TERMINAL_THEME,
} satisfies Partial<ITerminalOptions>;
