/** Idle-monitor wakeup must stay on the conversation that owns the grok session. */

export type WakeupLaneTab = {
  id: string;
  sessionHead?: string | null;
  messages?: readonly unknown[];
};

function messageSessionId(message: unknown): string | undefined {
  if (!message || typeof message !== 'object') return undefined;
  const meta = (message as { meta?: { sessionId?: string } }).meta;
  return meta?.sessionId;
}

/**
 * TUI auto-wake stays in the same session. Desktop has many tabs, so a wakeup
 * with an empty/wrong lane must not land on whichever tab is focused.
 */
export function resolveWakeupLane(opts: {
  laneId?: string | null;
  sessionId?: string | null;
  activeTabId: string;
  tabs: readonly WakeupLaneTab[];
}): string | null {
  const laneId = opts.laneId?.trim() ?? '';
  const sessionId = opts.sessionId?.trim() ?? '';
  if (laneId && opts.tabs.some((tab) => tab.id === laneId)) return laneId;
  if (sessionId) {
    const byHead = opts.tabs.find((tab) => tab.sessionHead === sessionId);
    if (byHead) return byHead.id;
    const byMessage = opts.tabs.find((tab) =>
      (tab.messages ?? []).some((message) => messageSessionId(message) === sessionId),
    );
    if (byMessage) return byMessage.id;
  }
  if (opts.tabs.length <= 1) return opts.activeTabId || opts.tabs[0]?.id || null;
  return null;
}
