/** Default shell tab label (VS Code uses the shell name). */
export const DEFAULT_TERMINAL_TAB_BASE = 'zsh';

/**
 * Next VS Code-style terminal tab title: `zsh`, then `zsh 2`, `zsh 3`, …
 * Skips numbers already present so closing `zsh 2` and adding again reuses `zsh 2`.
 */
export function nextTerminalTitle(
  existingTitles: readonly string[],
  base: string = DEFAULT_TERMINAL_TAB_BASE,
): string {
  const taken = new Set(existingTitles);
  if (!taken.has(base)) return base;
  let n = 2;
  while (taken.has(`${base} ${n}`)) n += 1;
  return `${base} ${n}`;
}

export function createTerminalSessionId(): string {
  return `terminal-${Date.now().toString(36)}-${Math.random().toString(16).slice(2, 9)}`;
}
