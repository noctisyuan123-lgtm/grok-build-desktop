/** OpenCode-style revert pointer: hide a suffix of messages without deleting. */

export type TabRevertPointer = {
  /** Last visible message id (inclusive). Messages after this are hidden. */
  messageId: string;
  /** Engine session head at undo time; commit rewinds this head. */
  grokSessionId: string;
  undoneRunId?: string;
};

export function messagesBeforeRevert<T extends { id: string }>(
  messages: readonly T[],
  revert: TabRevertPointer | null | undefined,
): T[] {
  if (!revert) return [...messages];
  if (revert.messageId === '__empty__') return [];
  const index = messages.findIndex((message) => message.id === revert.messageId);
  if (index < 0) return [...messages];
  return messages.slice(0, index + 1);
}

/** Id of the message that should remain visible after undoing `selectedIndex`. */
export function revertAnchorId(
  messages: readonly { id: string; role: string }[],
  selectedIndex: number,
  assistantIndex: number,
  hasAssistant: boolean,
): string | null {
  const cut = hasAssistant ? assistantIndex - 1 : selectedIndex;
  if (cut <= 0) return null;
  return messages[cut - 1]?.id ?? null;
}
