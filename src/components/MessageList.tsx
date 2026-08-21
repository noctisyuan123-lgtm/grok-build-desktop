import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Virtuoso, type VirtuosoHandle } from 'react-virtuoso';
import { MessageItem } from './MessageItem';
import { LongTextMessage } from './LongTextMessage';
import { MessageActions } from './MessageActions';
import { isLongUserText } from '../lib/longText';
import { useSessionActiveRunProgress } from '../hooks/useActiveRun';
import { t } from '../i18n';
import type { PlanEntry, TraceEvent } from '../lib/traceParser';
import type { TranscriptSegment } from '../lib/streamStore';
import type { ComposerAttachment } from '../lib/attachments';

export interface MessageRef {
  runId: string;
  role: 'user' | 'assistant';
  userText?: string;
  /** Stable message id — used to scroll/flash a specific message when the
   *  user clicks it in the HISTORY sidebar ("return to that task"). */
  id?: string;
  /**
   * Fallback content for assistant messages that have no live streamStore
   * snapshot — typically legacy messages loaded from session_state.json
   * before F shipped (no runId, no per-event events).
   */
  fallbackText?: string;
  durationMs?: number;
  traces?: TraceEvent[];
  transcript?: TranscriptSegment[];
  /** Persisted plan checklist for this assistant turn (session-scoped). */
  planEntries?: PlanEntry[];
  /** Lifecycle gate from {@link shouldShowPlan}; live runs may still show plans. */
  showPlan?: boolean;
  /** Keep the work fold open only while this turn is actively streaming. */
  autoExpandWork?: boolean;
  canUndo?: boolean;
  showUndo?: boolean;
  canEdit?: boolean;
  showEdit?: boolean;
  attachments?: ComposerAttachment[];
}

interface Props {
  messages: MessageRef[];
  /** When set (with a fresh nonce), scroll to the message with this id and
   *  flash it. The nonce lets the same id be re-focused on repeated clicks. */
  focusId?: string | null;
  focusNonce?: number;
  onUndoAssistant?: (messageId: string) => void;
  onUndoUser?: (messageId: string) => void;
  onEditUser?: (messageId: string, text: string) => void;
  onAttachmentClick?: (attachment: ComposerAttachment) => void;
}

export function MessageList({
  messages,
  focusId,
  focusNonce,
  onUndoAssistant,
  onUndoUser,
  onEditUser,
  onAttachmentClick,
}: Props) {
  const ref = useRef<VirtuosoHandle>(null);
  // The message currently flashing after a history-click jump.
  const [flashId, setFlashId] = useState<string | null>(null);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editingText, setEditingText] = useState('');
  const editInputRef = useRef<HTMLTextAreaElement | null>(null);
  // Whether the viewport is pinned to the bottom. We only auto-follow
  // streaming text while this is true, so a user who scrolls up to read
  // history is never yanked back down.
  const atBottomRef = useRef(true);
  const prevLenRef = useRef(messages.length);
  const scrollFrameRef = useRef<number | null>(null);
  // Session-scoped active only. Concurrent runs in other tabs must not drive
  // auto-scroll (or appear to own) this transcript.
  const sessionRunIds = useMemo(
    () => messages.map((message) => message.runId).filter(Boolean),
    [messages],
  );
  const activeProgress = useSessionActiveRunProgress(sessionRunIds);
  const activeBelongsHere = activeProgress !== '';

  useEffect(() => {
    if (editingId && !messages.some((message) => message.id === editingId)) {
      setEditingId(null);
      setEditingText('');
    }
  }, [editingId, messages]);

  const startEditing = useCallback((message: MessageRef) => {
    if (!message.id || !message.canEdit) return;
    setEditingId(message.id);
    setEditingText(message.userText ?? '');
  }, []);

  const cancelEditing = useCallback(() => {
    setEditingId(null);
    setEditingText('');
  }, []);

  const focusEditInput = useCallback(
    (input: HTMLTextAreaElement | null) => {
      editInputRef.current = input;
      if (!input || !editingId) return;
      input.focus();
      const end = input.value.length;
      input.setSelectionRange(end, end);
    },
    [editingId],
  );

  const keepEditCaretAtEnd = useCallback((input: HTMLTextAreaElement) => {
    const end = input.value.length;
    input.setSelectionRange(end, end);
  }, []);

  const submitEditing = useCallback(() => {
    const text = editingText.trim();
    if (!editingId || !text || !onEditUser) return;
    onEditUser(editingId, text);
    cancelEditing();
  }, [cancelEditing, editingId, editingText, onEditUser]);

  const scrollToLast = useCallback(
    (smooth = false) => {
      const lastIndex = messages.length - 1;
      if (lastIndex < 0) return;
      ref.current?.scrollToIndex({
        index: lastIndex,
        align: 'end',
        behavior: smooth ? 'smooth' : 'auto',
      });
    },
    [messages.length],
  );

  // Coalesce streaming resize notifications to one scroll per animation
  // frame. This avoids the old fixed interval, which kept fighting wheel
  // input and caused visible scroll jank.
  const scheduleScrollToLast = useCallback(
    (force = false) => {
      if (scrollFrameRef.current != null) return;
      scrollFrameRef.current = window.requestAnimationFrame(() => {
        scrollFrameRef.current = null;
        if (force || atBottomRef.current) scrollToLast(false);
      });
    },
    [scrollToLast],
  );

  useEffect(
    () => () => {
      if (scrollFrameRef.current != null) window.cancelAnimationFrame(scrollFrameRef.current);
    },
    [],
  );

  // A NEW message arrived (user pressed Enter, or the assistant placeholder
  // was appended) → follow only when the user was already at the bottom.
  useEffect(() => {
    if (messages.length > prevLenRef.current) {
      // A new turn follows only when the user was already at the bottom.
      // Never yank someone back while they are reading older messages.
      scheduleScrollToLast(atBottomRef.current);
    }
    prevLenRef.current = messages.length;
  }, [messages.length, scheduleScrollToLast]);

  // The active run is STREAMING — its text/thought/html grows on the same
  // (last) message. Virtuoso's followOutput only fires on new items, not on
  // an item growing, so we pin to the bottom ourselves while at-bottom.
  useEffect(() => {
    if (!activeBelongsHere) return;
    if (atBottomRef.current) scheduleScrollToLast();
  }, [activeBelongsHere, activeProgress, scheduleScrollToLast]);

  // History-click jump: scroll the requested message into view (centered) and
  // flash it for ~1.3s so the user sees exactly which task they returned to.
  // Virtuoso virtualizes the list, so off-screen messages aren't in the DOM —
  // we must scroll by index, not querySelector. The nonce makes a repeat click
  // on the same message re-trigger this effect.
  useEffect(() => {
    if (!focusId) return;
    const idx = messages.findIndex((m) => m.id === focusId);
    if (idx < 0) return;
    atBottomRef.current = false; // don't fight the jump with bottom-follow
    ref.current?.scrollToIndex({ index: idx, align: 'center', behavior: 'smooth' });
    setFlashId(focusId);
    const t = window.setTimeout(() => setFlashId(null), 1300);
    return () => window.clearTimeout(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [focusId, focusNonce]);

  return (
    <Virtuoso
      ref={ref}
      data={messages}
      // Keep Virtuoso rows keyed by the message identity, not their array
      // index. Switching sessions replaces the whole data array; index reuse
      // can otherwise leave a previous session's streaming MessageItem alive
      // for one render and show the wrong run's response.
      computeItemKey={(_, msg) => msg.id || msg.runId}
      followOutput={(isAtBottom) => (isAtBottom ? 'auto' : false)}
      // A 140px threshold treats a visible upward wheel gesture as "still at
      // the bottom" and lets streaming updates pull the viewport back down.
      // Keep this close to the actual edge so manual reading wins immediately.
      atBottomThreshold={24}
      atBottomStateChange={(bottom) => {
        atBottomRef.current = bottom;
      }}
      // No inline style prop for height: Virtuoso's scroller defaults already
      // include height 100% (applied via the CSSOM, so it works under the
      // strict no-'unsafe-inline' style-src), and the codebase stays free of
      // inline-style props (guarded in scripts/smoke_test.mjs).
      increaseViewportBy={{ top: 200, bottom: 600 }}
      itemContent={(_, msg) => {
        const flash = msg.id && msg.id === flashId ? ' message-flash' : '';
        if (msg.role === 'user') {
          const isEditing = msg.id === editingId;
          return (
            <div className={`message message-user${flash}`} data-message-id={msg.id}>
              {msg.attachments?.length ? (
                <div className="message-attachments" aria-label="Attachments">
                  {msg.attachments.map((attachment) => (
                    <button
                      aria-label={`Preview ${attachment.name}`}
                      className={`message-attachment-trigger${
                        attachment.mimeType.startsWith('image/') ? ' is-image' : ' is-file'
                      }`}
                      key={attachment.id}
                      title={`Preview ${attachment.name}`}
                      type="button"
                      onClick={() => onAttachmentClick?.(attachment)}
                    >
                      {attachment.mimeType.startsWith('image/') ? (
                        <img
                          className="message-attachment-image"
                          src={attachment.dataUrl}
                          alt={attachment.name}
                        />
                      ) : (
                        <span className="message-attachment-file">{attachment.name}</span>
                      )}
                    </button>
                  ))}
                </div>
              ) : null}
              {isEditing ? (
                <div className="message-edit-box">
                  <textarea
                    ref={focusEditInput}
                    aria-label={t('message.editPromptInput')}
                    className="message-edit-input"
                    value={editingText}
                    onChange={(event) => setEditingText(event.target.value)}
                    onClick={(event) => keepEditCaretAtEnd(event.currentTarget)}
                    onKeyDown={(event) => {
                      if (event.key === 'Escape') {
                        event.preventDefault();
                        cancelEditing();
                        return;
                      }
                      // Edit follows the Composer convention: Enter commits,
                      // Shift+Enter inserts a newline. Keep IME composition
                      // untouched so Enter does not submit half-composed text.
                      const native = event.nativeEvent as KeyboardEvent;
                      if (
                        event.key === 'Enter' &&
                        !event.shiftKey &&
                        !event.metaKey &&
                        !event.ctrlKey &&
                        !native.isComposing &&
                        native.keyCode !== 229
                      ) {
                        event.preventDefault();
                        submitEditing();
                      }
                    }}
                    rows={Math.min(8, Math.max(3, editingText.split('\n').length))}
                  />
                  <div className="message-edit-controls">
                    <button className="message-edit-cancel" type="button" onClick={cancelEditing}>
                      {t('message.editCancel')}
                    </button>
                    <button
                      className="message-edit-send"
                      type="button"
                      onClick={submitEditing}
                      disabled={!editingText.trim()}
                    >
                      {t('message.editSend')}
                    </button>
                  </div>
                </div>
              ) : msg.userText ? (
                isLongUserText(msg.userText) ? (
                  <LongTextMessage text={msg.userText} />
                ) : (
                  <pre className="message-body">{msg.userText}</pre>
                )
              ) : null}
              {!isEditing ? (
                <MessageActions
                  sourceText={msg.userText ?? ''}
                  canUndo={Boolean(msg.canUndo)}
                  showUndo={Boolean(msg.showUndo)}
                  onUndo={msg.id && onUndoUser ? () => onUndoUser(msg.id!) : undefined}
                  canEdit={Boolean(msg.canEdit)}
                  showEdit={Boolean(msg.showEdit)}
                  onEdit={msg.id ? () => startEditing(msg) : undefined}
                  toolbarLabel={t('message.promptActions')}
                  copyLabel={t('message.copyPrompt')}
                  editLabel={t('message.editPrompt')}
                  editDisabledLabel={t('message.editPromptLatestOnly')}
                  undoLabel={t('message.undoPrompt')}
                  undoDisabledLabel={t('message.undoPromptLatestOnly')}
                />
              ) : null}
            </div>
          );
        }
        // Capture the row's current stable id explicitly. Virtuoso reuses row
        // DOM while scrolling; this keeps the callback bound to the message
        // represented by this render rather than an index or mutable lookup.
        const assistantId = msg.id;
        return (
          <div className={`message message-assistant${flash}`} data-message-id={msg.id}>
            <MessageItem
              runId={msg.runId}
              fallbackText={msg.fallbackText}
              durationMs={msg.durationMs}
              fallbackTraces={msg.traces}
              fallbackTranscript={msg.transcript}
              planEntries={msg.planEntries}
              showPlan={msg.showPlan}
              autoExpandWork={msg.autoExpandWork}
              canUndo={Boolean(msg.canUndo)}
              showUndo={Boolean(msg.showUndo)}
              onUndo={
                assistantId && onUndoAssistant ? () => onUndoAssistant(assistantId) : undefined
              }
            />
          </div>
        );
      }}
    />
  );
}
