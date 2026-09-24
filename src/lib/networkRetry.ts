/** Pure helpers for network-failure Retry (collapse + resend). */

export type RetryTurnMessage = {
  id: string;
  role: string;
  content: string;
  runId?: string | null;
};

export type CollapsedRetryTurn<T extends RetryTurnMessage> = {
  /** Transcript with the failed user+assistant turn removed. */
  preserved: T[];
  /** User text to resubmit. */
  userText: string;
  /** Index of the removed user message in the original list. */
  userIndex: number;
  /** Index of the failed assistant message in the original list. */
  assistantIndex: number;
};

/**
 * Locate the failed assistant (by runId) and its preceding user bubble, then
 * return the transcript with that pair removed so Retry can resubmit without
 * duplicating the user message or leaving an empty failed assistant.
 */
export function collapseFailedNetworkTurn<T extends RetryTurnMessage>(
  messages: T[],
  runId: string,
): CollapsedRetryTurn<T> | null {
  const assistantIndex = messages.findIndex((message) => message.runId === runId);
  if (assistantIndex < 0) return null;

  let userIndex = -1;
  for (let i = assistantIndex - 1; i >= 0; i -= 1) {
    if (messages[i]?.role === 'user') {
      userIndex = i;
      break;
    }
  }
  if (userIndex < 0) return null;

  const userText = messages[userIndex]!.content;
  if (!userText.trim()) return null;

  // Drop the user bubble and everything after it that belongs to this failed
  // turn. In the normal case that is exactly [user, assistant]; if anything
  // was inserted between them, keep earlier history only.
  const preserved = messages.slice(0, userIndex);
  return { preserved, userText, userIndex, assistantIndex };
}

/**
 * Shared Retry orchestration used by App — kept here so cancel+collapse can be
 * unit-tested without mounting the full desktop shell.
 */
export async function performNetworkRetry<T extends RetryTurnMessage>(opts: {
  messages: T[];
  runId: string;
  cancelRun: (runId: string) => Promise<boolean>;
  dismissFailure: (runId: string) => void;
  clearOpenWork?: (runId: string) => void;
  replaceMessages: (next: T[]) => void;
  setComposerValue: (text: string) => void;
  submit: () => void;
}): Promise<boolean> {
  const collapsed = collapseFailedNetworkTurn(opts.messages, opts.runId);
  if (!collapsed) return false;
  opts.dismissFailure(opts.runId);
  try {
    await opts.cancelRun(opts.runId);
  } catch {
    /* already gone */
  }
  opts.clearOpenWork?.(opts.runId);
  opts.replaceMessages(collapsed.preserved);
  opts.setComposerValue(collapsed.userText);
  opts.submit();
  return true;
}
