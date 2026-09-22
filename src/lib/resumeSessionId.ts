/** Decide which grok session id a Desktop turn may --resume. */

export type ResumeMessage = {
  role?: string;
  meta?: { sessionId?: string | null } | null;
};

export function transcriptHasBoundSession(
  messages: readonly ResumeMessage[] | null | undefined,
): boolean {
  return (messages ?? []).some(
    (message) => message.role === 'assistant' && Boolean(message.meta?.sessionId),
  );
}

/**
 * Prefer an in-message / rebase head. Fall back to tab.sessionHead only when
 * the transcript already bound an engine session — never on a blank first turn
 * that may still carry a foreign head from a live-link leak.
 */
export function pickResumeSessionId(opts: {
  inPlaceEditSessionId?: string | null;
  rebasedSessionId?: string | null;
  visibleSessionId?: string | null;
  currentSessionId?: string | null;
  tabSessionHead?: string | null;
  messages: readonly ResumeMessage[];
}): string | null {
  const {
    inPlaceEditSessionId = null,
    rebasedSessionId = null,
    visibleSessionId = null,
    currentSessionId = null,
    tabSessionHead = null,
    messages,
  } = opts;
  const headFallback = transcriptHasBoundSession(messages) ? tabSessionHead : null;
  return (
    inPlaceEditSessionId ??
    rebasedSessionId ??
    visibleSessionId ??
    currentSessionId ??
    headFallback ??
    null
  );
}
