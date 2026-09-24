import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { ArrowDown, FileText } from 'lucide-react';
import { Virtuoso, type VirtuosoHandle } from 'react-virtuoso';
import { MessageItem } from './MessageItem';
import { UserMessageText } from './UserMessageText';
import { MessageActions } from './MessageActions';
import { useSessionActiveRunProgress } from '../hooks/useActiveRun';
import { t } from '../i18n';
import type { TraceEvent } from '../lib/traceParser';
import type { TranscriptSegment } from '../lib/streamStore';
import {
  formatAttachmentSize,
  isVideoAttachment,
  type ComposerAttachment,
} from '../lib/attachments';
import type { ChatMessageStatus } from '../app/types';

const AT_BOTTOM_PX = 24;

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
  /** Keep the work fold open only while this turn is actively streaming. */
  autoExpandWork?: boolean;
  canUndo?: boolean;
  showUndo?: boolean;
  canFork?: boolean;
  showFork?: boolean;
  showCopy?: boolean;
  canEdit?: boolean;
  showEdit?: boolean;
  attachments?: ComposerAttachment[];
  status?: ChatMessageStatus;
}

interface Props {
  messages: MessageRef[];
  /** When set (with a fresh nonce), scroll to the message with this id and
   *  flash it. The nonce lets the same id be re-focused on repeated clicks. */
  focusId?: string | null;
  focusNonce?: number;
  onUndoAssistant?: (messageId: string) => void;
  onUndoUser?: (messageId: string) => void;
  onForkAssistant?: (messageId: string) => void;
  /** Load this prompt into the composer for editing (not inline in the bubble). */
  onEditUser?: (messageId: string, text: string) => void;
  /** Prompt currently being edited in the composer — bubble stays visible. */
  editingUserId?: string | null;
  onAttachmentClick?: (attachment: ComposerAttachment) => void;
  onRetryTurn?: (messageId: string, runId: string) => void;
  onContinueTurn?: (messageId: string, runId: string) => void;
}

function scrollerAtBottom(el: HTMLElement): boolean {
  return el.scrollHeight - el.clientHeight - el.scrollTop <= AT_BOTTOM_PX;
}

function attachmentChipKind(attachment: ComposerAttachment): 'image' | 'video' | 'file' {
  if (attachment.mimeType.startsWith('image/')) return 'image';
  if (isVideoAttachment(attachment)) return 'video';
  return 'file';
}

function AttachmentChip({
  attachment,
  onClick,
}: {
  attachment: ComposerAttachment;
  onClick?: (attachment: ComposerAttachment) => void;
}) {
  const kind = attachmentChipKind(attachment);
  const sizeLabel = attachment.sizeBytes > 0 ? formatAttachmentSize(attachment.sizeBytes) : null;
  return (
    <button
      aria-label={`Preview ${attachment.name}`}
      className={`message-attachment-trigger is-${kind}`}
      title={`Preview ${attachment.name}`}
      type="button"
      onClick={() => onClick?.(attachment)}
    >
      {kind === 'image' ? (
        <img className="message-attachment-image" src={attachment.dataUrl} alt={attachment.name} />
      ) : kind === 'video' ? (
        <>
          <span className="message-attachment-video-wrap">
            <video
              className="message-attachment-video"
              src={attachment.dataUrl}
              muted
              playsInline
              preload="metadata"
            />
            <span className="message-attachment-play" aria-hidden="true" />
          </span>
          <span className="message-attachment-meta">
            <span className="message-attachment-name">{attachment.name}</span>
            {sizeLabel ? <span className="message-attachment-size">{sizeLabel}</span> : null}
          </span>
        </>
      ) : (
        <>
          <span className="message-attachment-icon">
            <FileText size={14} />
          </span>
          <span className="message-attachment-meta">
            <span className="message-attachment-name">{attachment.name}</span>
            {sizeLabel ? <span className="message-attachment-size">{sizeLabel}</span> : null}
          </span>
        </>
      )}
    </button>
  );
}

export function MessageList({
  messages,
  focusId,
  focusNonce,
  onUndoAssistant,
  onUndoUser,
  onForkAssistant,
  onEditUser,
  editingUserId = null,
  onAttachmentClick,
  onRetryTurn,
  onContinueTurn,
}: Props) {
  const ref = useRef<VirtuosoHandle>(null);
  const scrollerElRef = useRef<HTMLElement | null>(null);
  const [scrollParent, setScrollParent] = useState<HTMLElement | null>(null);
  const [showJump, setShowJump] = useState(false);
  // The message currently flashing after a history-click jump.
  const [flashId, setFlashId] = useState<string | null>(null);
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

  const bindScroller = useCallback((node: HTMLElement | Window | null) => {
    const el = node instanceof HTMLElement ? node : null;
    scrollerElRef.current = el;
    setScrollParent((current) => (current === el ? current : el));
  }, []);

  const pinToBottom = useCallback(() => {
    const el = scrollerElRef.current;
    if (!el) return;
    const top = Math.max(0, el.scrollHeight - el.clientHeight);
    el.scrollTop = top;
    try {
      ref.current?.scrollTo({ top, behavior: 'auto' });
    } catch {
      /* virtuoso mock */
    }
  }, []);

  const syncJumpFromScroller = useCallback(() => {
    const el = scrollerElRef.current;
    if (!el) return;
    const atBottom = scrollerAtBottom(el);
    atBottomRef.current = atBottom;
    setShowJump(!atBottom);
  }, []);

  const jumpToBottom = useCallback(() => {
    atBottomRef.current = true;
    pinToBottom();
    const el = scrollerElRef.current;
    setShowJump(el ? !scrollerAtBottom(el) : false);
  }, [pinToBottom]);

  useEffect(() => {
    const el = scrollParent;
    if (!el) return;
    const onScroll = () => syncJumpFromScroller();
    el.addEventListener('scroll', onScroll, { passive: true });
    return () => el.removeEventListener('scroll', onScroll);
  }, [scrollParent, syncJumpFromScroller]);

  const scheduleScrollToLast = useCallback(
    (force = false) => {
      if (scrollFrameRef.current != null) return;
      scrollFrameRef.current = window.requestAnimationFrame(() => {
        scrollFrameRef.current = null;
        if (force || atBottomRef.current) pinToBottom();
      });
    },
    [pinToBottom],
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
    atBottomRef.current = false;
    setShowJump(true);
    ref.current?.scrollToIndex({ index: idx, align: 'center', behavior: 'smooth' });
    setFlashId(focusId);
    const t = window.setTimeout(() => setFlashId(null), 1300);
    return () => window.clearTimeout(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [focusId, focusNonce]);

  return (
    <div className="message-list-shell">
      <Virtuoso
        ref={ref}
        scrollerRef={bindScroller}
        data={messages}
        // Keep Virtuoso rows keyed by the message identity, not their array
        // index. Switching sessions replaces the whole data array; index reuse
        // can otherwise leave a previous session's streaming MessageItem alive
        // for one render and show the wrong run's response.
        computeItemKey={(_, msg) => msg.id || msg.runId}
        followOutput={(isAtBottom) => (isAtBottom ? 'auto' : false)}
        atBottomThreshold={AT_BOTTOM_PX}
        atBottomStateChange={(bottom) => {
          atBottomRef.current = bottom;
          setShowJump(!bottom);
        }}
        totalListHeightChanged={() => {
          if (atBottomRef.current) pinToBottom();
        }}
        // No inline style prop for height: Virtuoso's scroller defaults already
        // include height 100% (applied via the CSSOM, so it works under the
        // strict no-'unsafe-inline' style-src), and the codebase stays free of
        // inline-style props (guarded in scripts/smoke_test.mjs).
        increaseViewportBy={{ top: 200, bottom: 160 }}
        itemContent={(index, msg) => {
          const flash = msg.id && msg.id === flashId ? ' message-flash' : '';
          if (msg.role === 'user') {
            const isEditing = Boolean(msg.id && msg.id === editingUserId);
            return (
              <div
                className={`message message-user${flash}${isEditing ? ' is-editing' : ''}`}
                data-message-id={msg.id}
              >
                {msg.attachments?.length ? (
                  <div className="message-attachments" aria-label="Attachments">
                    {msg.attachments.map((attachment) => (
                      <AttachmentChip
                        key={attachment.id}
                        attachment={attachment}
                        onClick={onAttachmentClick}
                      />
                    ))}
                  </div>
                ) : null}
                {msg.userText ? (
                  <UserMessageText
                    cacheKey={`user:${msg.id || msg.runId || 'anon'}`}
                    text={msg.userText}
                  />
                ) : null}
                <MessageActions
                  sourceText={msg.userText ?? ''}
                  canUndo={Boolean(msg.canUndo)}
                  showUndo={Boolean(msg.showUndo)}
                  onUndo={msg.id && onUndoUser ? () => onUndoUser(msg.id!) : undefined}
                  canEdit={Boolean(msg.canEdit)}
                  showEdit={Boolean(msg.showEdit)}
                  onEdit={
                    msg.id && onEditUser ? () => onEditUser(msg.id!, msg.userText ?? '') : undefined
                  }
                  toolbarLabel={t('message.promptActions')}
                  copyLabel={t('message.copyPrompt')}
                  editLabel={t('message.editPrompt')}
                  editDisabledLabel={t('message.editPromptLatestOnly')}
                  undoLabel={t('message.undoPrompt')}
                  undoDisabledLabel={t('message.undoPromptLatestOnly')}
                />
              </div>
            );
          }
          // Capture the row's current stable id explicitly. Virtuoso reuses row
          // DOM while scrolling; this keeps the callback bound to the message
          // represented by this render rather than an index or mutable lookup.
          const assistantId = msg.id;
          const isTranscriptTip = index === messages.length - 1;
          const followsAssistant =
            index > 0 && messages[index - 1]?.role === 'assistant'
              ? ' message-assistant-followup'
              : '';
          return (
            <div
              className={`message message-assistant${followsAssistant}${flash}`}
              data-message-id={msg.id}
            >
              <MessageItem
                runId={msg.runId}
                fallbackText={msg.fallbackText}
                durationMs={msg.durationMs}
                fallbackTraces={msg.traces}
                fallbackTranscript={msg.transcript}
                status={msg.status}
                autoExpandWork={msg.autoExpandWork}
                canUndo={Boolean(msg.canUndo)}
                showUndo={Boolean(msg.showUndo)}
                canFork={Boolean(msg.canFork)}
                showFork={Boolean(msg.showFork)}
                showCopy={msg.showCopy !== false}
                isTranscriptTip={isTranscriptTip}
                onUndo={
                  assistantId && onUndoAssistant ? () => onUndoAssistant(assistantId) : undefined
                }
                onFork={
                  assistantId && onForkAssistant ? () => onForkAssistant(assistantId) : undefined
                }
                onRetryTurn={
                  assistantId && msg.runId && onRetryTurn
                    ? () => onRetryTurn(assistantId, msg.runId!)
                    : undefined
                }
                onContinueTurn={
                  assistantId && msg.runId && onContinueTurn
                    ? () => onContinueTurn(assistantId, msg.runId!)
                    : undefined
                }
              />
            </div>
          );
        }}
      />
      {showJump ? (
        <button
          type="button"
          className="jump-to-bottom"
          aria-label={t('conversation.jumpToBottom')}
          onMouseDown={(event) => event.preventDefault()}
          onClick={jumpToBottom}
        >
          <ArrowDown size={16} strokeWidth={2.4} aria-hidden />
        </button>
      ) : null}
    </div>
  );
}
