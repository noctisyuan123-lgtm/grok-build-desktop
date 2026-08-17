type SessionTab = { id: string; messages: readonly unknown[] };

function hasRun(messages: readonly unknown[], runId: string): boolean {
  return messages.some(
    (message) =>
      typeof message === 'object' &&
      message !== null &&
      'runId' in message &&
      (message as { runId?: unknown }).runId === runId,
  );
}

/**
 * A finished run deserves a completion sound when its owning conversation is
 * no longer the one on screen, even if the desktop window itself is focused.
 */
export function isBackgroundSessionRun(
  runId: string,
  activeTabId: string,
  activeMessages: readonly unknown[],
  tabs: readonly SessionTab[],
): boolean {
  if (hasRun(activeMessages, runId)) return false;
  return tabs.some((tab) => tab.id !== activeTabId && hasRun(tab.messages, runId));
}
