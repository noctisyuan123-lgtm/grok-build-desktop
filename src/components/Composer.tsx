import {
  forwardRef,
  useCallback,
  useEffect,
  useImperativeHandle,
  useRef,
  useState,
  type ReactNode,
} from 'react';
import { ArrowUp, FileImage, FileText, FolderOpen, Paperclip, X } from 'lucide-react';
import { invoke } from '@tauri-apps/api/core';
import { getCurrentWindow } from '@tauri-apps/api/window';
import { enqueueRun } from '../lib/grok';
import { useHasInflight } from '../hooks/useActiveRun';
import { notePendingSubmitEnd, notePendingSubmitStart } from '../lib/streamStore';
import { extractFileMentions, readFileSafe, type FileEntry } from '../lib/files';
import { FilePicker } from './FilePicker';
import { t } from '../i18n';
import { hasTauriRuntime } from '../lib/runtime';
import {
  attachmentToAcpBlock,
  fileToAttachment,
  formatAttachmentSize,
  MAX_ATTACHMENT_BYTES,
  MAX_ATTACHMENT_COUNT,
  MAX_ATTACHMENTS_TOTAL_BYTES,
  readNativeAttachment,
  type ComposerAttachment,
} from '../lib/attachments';

export interface ComposerHandle {
  /** Imperatively set the textarea value (used by starter cards / history click / drafts). */
  setValue: (text: string) => void;
  /** Current textarea value. */
  getValue: () => string;
  /** Focus the textarea. */
  focus: () => void;
}

interface Props {
  cwd: string;
  argsBuilder: () => string[];
  /** Current session's active run. The backend resolves its session after it ends. */
  parentRunId?: string;
  /**
   * UI session / tab id for the concurrent lane scheduler. Same lane serializes;
   * different lanes run side-by-side. Never inferred from cwd.
   */
  laneId?: string;
  /** Run ids that belong to this session (for session-scoped Send/Enqueue). */
  sessionRunIds?: readonly string[];
  /** Initial seed value (e.g. restored from session_state drafts). Only applied once on mount. */
  initialValue?: string;
  placeholder?: string;
  onEnqueued?: (info: {
    runId: string;
    position: number;
    prompt: string;
    rawText: string;
    attachments: ComposerAttachment[];
  }) => void;
  /** Called when enqueueing the prompt fails, with a human-readable message.
   *  The host surfaces it (session notice) — a silent console.error left the
   *  user staring at a composer that "ate" their prompt. */
  onError?: (message: string) => void;
  /**
   * Optional draft-persistence callback. **Called only on blur and on unmount**,
   * not on every keystroke — passing it as a per-keystroke listener would force
   * the parent (3000-line App.tsx) to re-render on each character and stall the
   * main thread, which in turn drops IME composition events and causes
   * accidental auto-submits. We persist on blur instead, which is enough for
   * "user typed, switched modes" preservation.
   */
  onTextChange?: (text: string) => void;
  /** Compact mode/model/run controls rendered inside the input card. */
  controls?: ReactNode;
  /**
   * When set (current UI session has a stoppable run), replaces the send
   * arrow with an icon-only Stop control in the same slot. Enter still
   * enqueues a follow-up — stop is click-only.
   */
  onStop?: () => void;
  /**
   * Host-handled slash commands (e.g. `/cli`, `/desktop`). Return true when
   * the prompt was fully handled and must not be sent to grok.
   */
  onHostSlash?: (raw: string) => boolean | Promise<boolean>;
}

/**
 * Find the active `@token` immediately to the left of the textarea caret. If
 * the caret is not inside an unfinished `@…` mention, returns null. The token
 * begins right after the most recent `@` that follows whitespace or
 * string-start, and runs until the caret. Whitespace inside the token closes
 * it (the user finished typing the filename).
 */
/** Listbox id shared by the textarea (aria-controls) and the FilePicker. */
const FILE_PICKER_LISTBOX_ID = 'composer-file-picker-listbox';

function detectActiveMention(text: string, caret: number): { start: number; query: string } | null {
  if (caret <= 0) return null;
  let i = caret - 1;
  while (i >= 0) {
    const ch = text[i];
    if (ch === '@') {
      // valid only if @ is at string-start or preceded by whitespace
      if (i === 0 || /\s/.test(text[i - 1]!)) {
        return { start: i, query: text.slice(i + 1, caret) };
      }
      return null;
    }
    if (/\s/.test(ch ?? '')) return null;
    i--;
  }
  return null;
}

export const Composer = forwardRef<ComposerHandle, Props>(function Composer(
  {
    cwd,
    argsBuilder,
    parentRunId,
    laneId,
    sessionRunIds,
    initialValue,
    placeholder,
    onEnqueued,
    onError,
    onTextChange,
    controls,
    onStop,
    onHostSlash,
  }: Props,
  outerRef,
) {
  const ref = useRef<HTMLTextAreaElement>(null);
  // Track composition via BOTH a ref (sync, immune to React lag) and React
  // state (drives Send/Queuing label re-render). The ref is the authoritative
  // guard inside the keydown handler.
  const composingRef = useRef(false);
  const [isComposing, setIsComposing] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [mention, setMention] = useState<{ start: number; query: string } | null>(null);
  // Highlighted FilePicker option id, exposed as aria-activedescendant while
  // the picker is open (the textarea keeps DOM focus the whole time).
  const [activeOptionId, setActiveOptionId] = useState<string | null>(null);
  const [attachments, setAttachments] = useState<ComposerAttachment[]>([]);
  const [attachedFolder, setAttachedFolder] = useState<{ name: string; path: string } | null>(null);
  const [folderPickerBusy, setFolderPickerBusy] = useState(false);
  const [dragActive, setDragActive] = useState(false);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const onTextChangeRef = useRef(onTextChange);
  onTextChangeRef.current = onTextChange;
  // Local draft undo/redo (textarea-scoped). Native undo stacks are cleared by
  // programmatic value writes (setValue / submit clear / IME edge cases) and
  // are unreliable in WebView/jsdom — keep a small stack so Cmd/Ctrl+Z restores
  // accidental deletes without a global key listener or message-round-trip undo.
  const draftHistoryRef = useRef<string[]>([initialValue ?? '']);
  const draftIndexRef = useRef(0);
  const applyingDraftHistoryRef = useRef(false);

  const recordDraftHistory = useCallback((value: string) => {
    if (applyingDraftHistoryRef.current || composingRef.current) return;
    const history = draftHistoryRef.current;
    const index = draftIndexRef.current;
    if (history[index] === value) return;
    const next = history.slice(0, index + 1);
    next.push(value);
    // Cap growth; drop oldest and keep index aligned.
    if (next.length > 100) {
      next.shift();
      draftHistoryRef.current = next;
      draftIndexRef.current = next.length - 1;
    } else {
      draftHistoryRef.current = next;
      draftIndexRef.current = next.length - 1;
    }
  }, []);

  const applyDraftHistory = useCallback((value: string) => {
    const el = ref.current;
    if (!el) return;
    applyingDraftHistoryRef.current = true;
    el.value = value;
    const caret = value.length;
    try {
      el.setSelectionRange(caret, caret);
    } catch {
      /* some test hosts reject selection on detached nodes */
    }
    applyingDraftHistoryRef.current = false;
    const nextCaret = el.selectionStart ?? 0;
    setMention(detectActiveMention(el.value, nextCaret));
  }, []);
  // Primitive selector — subscribing to whole run/queue snapshots would
  // re-render the Composer on every streamed token (see useHasInflight).
  // Session-scoped so another tab's long run does not flip Send → Enqueue here.
  const hasInflight = useHasInflight(
    sessionRunIds || laneId
      ? { sessionRunIds: sessionRunIds ?? [], laneId }
      : undefined,
  );

  const addAttachments = useCallback(
    (incoming: ComposerAttachment[]) => {
      setAttachments((current) => {
        const deduped = incoming.filter(
          (item) =>
            !current.some(
              (existing) =>
                existing.name === item.name && existing.sizeBytes === item.sizeBytes,
            ),
        );
        const oversized = deduped.find((item) => item.sizeBytes > MAX_ATTACHMENT_BYTES);
        if (oversized) {
          onError?.(t('composer.attachmentTooLarge', { name: oversized.name }));
          return current;
        }
        if (current.length + deduped.length > MAX_ATTACHMENT_COUNT) {
          onError?.(t('composer.tooManyAttachments', { count: MAX_ATTACHMENT_COUNT }));
          return current;
        }
        const total = [...current, ...deduped].reduce((sum, item) => sum + item.sizeBytes, 0);
        if (total > MAX_ATTACHMENTS_TOTAL_BYTES) {
          onError?.(t('composer.attachmentsTotalTooLarge'));
          return current;
        }
        return [...current, ...deduped];
      });
    },
    [onError],
  );

  const addBrowserFiles = useCallback(
    async (files: File[]) => {
      const eligible = files.filter((file) => {
        if (file.size <= MAX_ATTACHMENT_BYTES) return true;
        onError?.(t('composer.attachmentTooLarge', { name: file.name }));
        return false;
      });
      try {
        addAttachments(await Promise.all(eligible.map(fileToAttachment)));
      } catch (error) {
        onError?.(error instanceof Error ? error.message : String(error));
      }
    },
    [addAttachments, onError],
  );

  const attachFolderPath = useCallback((path: string) => {
    const normalized = path.replace(/[\\/]+$/, '');
    const name = normalized.split(/[\\/]/).filter(Boolean).at(-1) ?? normalized;
    setAttachedFolder({ name, path });
  }, []);

  const chooseFolder = useCallback(async () => {
    if (folderPickerBusy) return;
    if (!hasTauriRuntime()) {
      onError?.(t('notices.folderPickerUnavailable'));
      return;
    }
    setFolderPickerBusy(true);
    try {
      const path = await invoke<string | null>('pick_project_folder', {
        initial: cwd || null,
      });
      if (!path) return;
      attachFolderPath(path);
    } catch (error) {
      onError?.(t('notices.folderPickerFailed', {
        error: error instanceof Error ? error.message : String(error),
      }));
    } finally {
      setFolderPickerBusy(false);
    }
  }, [attachFolderPath, cwd, folderPickerBusy, onError]);

  // Finder drops are delivered by Tauri as native paths rather than DOM File
  // objects. Keep the normal HTML drop handlers too so browser/dev mode works.
  useEffect(() => {
    if (!hasTauriRuntime()) return;
    let disposed = false;
    let unlisten: (() => void) | undefined;
    let currentWindow: ReturnType<typeof getCurrentWindow>;
    try {
      currentWindow = getCurrentWindow();
    } catch {
      // Tauri's IPC mock (and some embedded browser harnesses) exposes the
      // runtime marker without window metadata. HTML drop remains available.
      return;
    }
    void currentWindow
      .onDragDropEvent((event) => {
        if (event.payload.type === 'enter' || event.payload.type === 'over') {
          setDragActive(true);
          return;
        }
        if (event.payload.type === 'leave') {
          setDragActive(false);
          return;
        }
        setDragActive(false);
        void Promise.all(
          event.payload.paths.map(async (path) => {
            try {
              const isDirectory = await invoke<boolean>('path_is_directory', { path });
              if (isDirectory) return { folderPath: path } as const;
              return { attachment: await readNativeAttachment(path) } as const;
            } catch (error) {
              onError?.(error instanceof Error ? error.message : String(error));
              return null;
            }
          }),
        ).then((items) => {
          const folder = items.find(
            (item): item is { folderPath: string } => item?.folderPath !== undefined,
          );
          if (folder) attachFolderPath(folder.folderPath);
          addAttachments(
            items
              .filter(
                (item): item is { attachment: ComposerAttachment } =>
                  item?.attachment !== undefined,
              )
              .map((item) => item.attachment),
          );
        });
      })
      .then((stop) => {
        if (disposed) stop();
        else unlisten = stop;
      })
      .catch((error) => onError?.(error instanceof Error ? error.message : String(error)));
    return () => {
      disposed = true;
      unlisten?.();
    };
  }, [addAttachments, attachFolderPath, onError]);

  useImperativeHandle(
    outerRef,
    () => ({
      setValue: (text: string) => {
        const el = ref.current;
        if (!el) return;
        el.value = text;
        // Imperative writes (mode switch, undo-response restore, starters)
        // replace the live draft — seed history so Cmd+Z can still recover
        // the previous local text if the user immediately deletes.
        recordDraftHistory(text);
      },
      getValue: () => ref.current?.value ?? '',
      focus: () => ref.current?.focus(),
    }),
    [recordDraftHistory],
  );

  // Apply initialValue once on mount.
  useEffect(() => {
    if (initialValue && ref.current && !ref.current.value) {
      ref.current.value = initialValue;
      draftHistoryRef.current = [initialValue];
      draftIndexRef.current = 0;
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Persist the in-flight draft on unmount (e.g. parent re-mounts Composer on
  // mode switch). Reads the current text directly from the DOM ref — no
  // dependency on React state.
  useEffect(() => {
    const node = ref.current;
    return () => {
      const text = node?.value ?? '';
      if (text && onTextChangeRef.current) onTextChangeRef.current(text);
    };
  }, []);

  /**
   * Re-scan the textarea for an active @mention. Called on input + caret
   * movement. We can't use a controlled value because the textarea is
   * uncontrolled (perf invariant — see onTextChange comment).
   */
  const refreshMentionFrom = (el: HTMLTextAreaElement | null) => {
    if (!el) {
      setMention(null);
      return;
    }
    const caret = el.selectionStart ?? 0;
    setMention(detectActiveMention(el.value, caret));
  };

  const refreshMention = () => refreshMentionFrom(ref.current);

  const insertMention = (entry: FileEntry) => {
    const el = ref.current;
    if (!el || !mention) return;
    const caret = el.selectionStart ?? 0;
    const before = el.value.slice(0, mention.start);
    const after = el.value.slice(caret);
    // Quote paths containing whitespace so extractFileMentions can parse them
    // back out as one token ("My Project/notes.md" would otherwise become @My).
    const insertion = /\s/.test(entry.path) ? `@"${entry.path}" ` : `@${entry.path} `;
    el.value = `${before}${insertion}${after}`;
    const newCaret = before.length + insertion.length;
    el.setSelectionRange(newCaret, newCaret);
    recordDraftHistory(el.value);
    setMention(null);
    el.focus();
  };

  /**
   * Resolve `@path` mentions in the raw prompt: read each file (size-capped)
   * and append the contents as a fenced context block at the end. The model
   * sees the original prompt verbatim (mentions remain inline) plus a
   * "Referenced files" section with the actual content.
   */
  const expandMentionsInPrompt = async (raw: string): Promise<string> => {
    const mentions = extractFileMentions(raw);
    if (mentions.length === 0 || !cwd.trim()) return raw;
    const blocks: string[] = [];
    for (const mentionPath of mentions) {
      const body = await readFileSafe(cwd, mentionPath, 200_000);
      if (body == null) {
        blocks.push(`\n### @${mentionPath}\n_(file unreadable, too large, or binary — skipped)_`);
      } else {
        const ext = mentionPath.includes('.') ? mentionPath.split('.').pop() : '';
        blocks.push(`\n### @${mentionPath}\n\`\`\`${ext ?? ''}\n${body}\n\`\`\``);
      }
    }
    return `${raw}\n\n---\nReferenced files (from @ mentions):${blocks.join('\n')}`;
  };

  const submit = async () => {
    if (submitting) return;
    const el = ref.current;
    if (!el) return;
    const rawText = el.value.trim();
    if (!rawText && attachments.length === 0 && !attachedFolder) return;
    setSubmitting(true);
    setMention(null);
    notePendingSubmitStart();
    try {
      // Host slash commands stay in the desktop shell (CLI handoff, etc.).
      if (rawText.startsWith('/') && onHostSlash && (await onHostSlash(rawText))) {
        el.value = '';
        recordDraftHistory('');
        onTextChangeRef.current?.('');
        notePendingSubmitEnd();
        setSubmitting(false);
        requestAnimationFrame(() => ref.current?.focus());
        return;
      }
      const attachmentFallback = attachedFolder && attachments.length === 0
        ? t('composer.folderOnlyPrompt')
        : t('composer.attachmentOnlyPrompt');
      const expandedText = await expandMentionsInPrompt(rawText || attachmentFallback);
      const attachmentList = attachments.map((item) => `- ${item.name}`).join('\n');
      const folderContext = attachedFolder
        ? `\n\nAttached folder:\n- ${attachedFolder.name} (${attachedFolder.path})`
        : '';
      const prompt = `${attachments.length ? `${expandedText}\n\nAttached files:\n${attachmentList}` : expandedText}${folderContext}`;
      const args = argsBuilder();
      if (attachments.length > 0) {
        const blocks = [
          { type: 'text', text: prompt },
          ...attachments.map(attachmentToAcpBlock),
        ];
        args.push('--prompt-json', JSON.stringify(blocks));
      } else {
        args.push('-p', prompt);
      }
      const result = await enqueueRun({ prompt, cwd, args, parentRunId, laneId });
      el.value = '';
      recordDraftHistory('');
      setAttachments([]);
      setAttachedFolder(null);
      onTextChangeRef.current?.('');
      onEnqueued?.({
        runId: result.runId,
        position: result.position,
        prompt,
        // Attachments render in their own preview strip above the bubble. Do
        // not leak filenames, URLs, or base64 into the visible message text.
        rawText,
        attachments,
      });
    } catch (err) {
      console.error('[grok-desktop] enqueue failed', err);
      // Surface the failure — the prompt is still in the textarea, so the
      // user can retry once the cause (e.g. backend not ready) is fixed.
      onError?.(err instanceof Error ? err.message : String(err));
    } finally {
      notePendingSubmitEnd();
      setSubmitting(false);
      // Disabling the textarea during submit blurs it; restore focus so the
      // type→Enter→type flow survives every send. rAF lets the re-enable
      // render commit first.
      requestAnimationFrame(() => ref.current?.focus());
    }
  };

  const pickerOpen = Boolean(mention && cwd.trim());

  return (
    <div
      className={`composer${submitting ? ' composer-submitting' : ''}${dragActive ? ' composer-drag-active' : ''}`}
      onDragEnter={(event) => {
        event.preventDefault();
        setDragActive(true);
      }}
      onDragOver={(event) => event.preventDefault()}
      onDragLeave={(event) => {
        if (!event.currentTarget.contains(event.relatedTarget as Node | null)) setDragActive(false);
      }}
      onDrop={(event) => {
        event.preventDefault();
        setDragActive(false);
        void addBrowserFiles(Array.from(event.dataTransfer.files));
      }}
    >
      {mention && cwd.trim() ? (
        <FilePicker
          cwd={cwd}
          query={mention.query}
          onSelect={insertMention}
          onCancel={() => setMention(null)}
          listboxId={FILE_PICKER_LISTBOX_ID}
          onActiveDescendant={setActiveOptionId}
        />
      ) : null}
      {dragActive ? <div className="composer-drop-overlay">{t('composer.dropFiles')}</div> : null}
      {attachedFolder ? (
        <div className="composer-folder-attachment-row" aria-label={t('composer.folderAttachment')}>
          <div className="composer-folder-attachment" title={attachedFolder.path}>
            <span className="composer-folder-attachment-icon" aria-hidden="true">
              <FolderOpen size={22} strokeWidth={1.55} />
            </span>
            <span className="composer-folder-attachment-copy">
              <strong>{attachedFolder.name}</strong>
              <small>{t('composer.folderType')}</small>
            </span>
            <button
              type="button"
              aria-label={t('composer.removeFolder', { name: attachedFolder.name })}
              onClick={() => setAttachedFolder(null)}
            >
              <X size={14} />
            </button>
          </div>
        </div>
      ) : null}
      {attachments.length > 0 ? (
        <div className="composer-attachments" aria-label={t('composer.attachments')}>
          {attachments.map((item) => (
            <div className="composer-attachment" key={item.id}>
              {item.mimeType.startsWith('image/') ? (
                <img src={item.dataUrl} alt="" />
              ) : (
                <span className="composer-attachment-icon"><FileText size={14} /></span>
              )}
              <span className="composer-attachment-copy">
                <strong>{item.name}</strong>
                <small>{formatAttachmentSize(item.sizeBytes)}</small>
              </span>
              <button
                type="button"
                aria-label={t('composer.removeAttachment', { name: item.name })}
                onClick={() => setAttachments((current) => current.filter((entry) => entry.id !== item.id))}
              >
                <X size={12} />
              </button>
            </div>
          ))}
        </div>
      ) : null}
      <input
        ref={fileInputRef}
        className="composer-file-input"
        type="file"
        multiple
        aria-label={t('composer.chooseFiles')}
        onChange={(event) => {
          void addBrowserFiles(Array.from(event.currentTarget.files ?? []));
          event.currentTarget.value = '';
        }}
      />
      <div className="composer-input-shell">
        <textarea
        ref={ref}
        disabled={submitting}
        // While the @-mention picker is open the textarea drives a listbox
        // without losing DOM focus — the ARIA combobox pattern. The role is
        // scoped to that state so the composer stays a plain multiline
        // textbox the rest of the time.
        role={pickerOpen ? 'combobox' : undefined}
        aria-expanded={pickerOpen ? true : undefined}
        aria-controls={pickerOpen ? FILE_PICKER_LISTBOX_ID : undefined}
        aria-activedescendant={pickerOpen ? (activeOptionId ?? undefined) : undefined}
        aria-autocomplete={pickerOpen ? 'list' : undefined}
        placeholder={
          submitting
            ? t('composer.placeholderQueuing')
            : (placeholder ??
              (hasInflight ? t('composer.placeholderQueueAnother') : t('composer.placeholderAsk')))
        }
        onCompositionStart={() => {
          composingRef.current = true;
          setIsComposing(true);
        }}
        onCompositionEnd={() => {
          composingRef.current = false;
          setIsComposing(false);
          const el = ref.current;
          if (el) recordDraftHistory(el.value);
          refreshMention();
        }}
        onInput={() => {
          const el = ref.current;
          if (el && !composingRef.current) recordDraftHistory(el.value);
          refreshMention();
        }}
        onClick={() => refreshMention()}
        onKeyUp={(e) => {
          // arrow-nav over the textarea moves the caret too — refresh after.
          if (
            e.key === 'ArrowLeft' ||
            e.key === 'ArrowRight' ||
            e.key === 'ArrowUp' ||
            e.key === 'ArrowDown' ||
            e.key === 'Home' ||
            e.key === 'End'
          ) {
            refreshMention();
          }
        }}
        onBlur={(e) => {
          // Persist draft only on blur, not every keystroke — that's the
          // critical perf invariant. See header comment on onTextChange prop.
          onTextChangeRef.current?.((e.target as HTMLTextAreaElement).value);
          // Close mention picker on blur so it doesn't linger over other UI.
          // Use a microtask so mousedown on a picker row can fire first.
          setTimeout(() => setMention(null), 100);
        }}
        onKeyDown={(e) => {
          // When the file picker is open it owns Enter/Tab/Arrows/Esc. Mirror
          // the render condition below (`mention && cwd.trim()`): with no cwd
          // the picker never shows, so a trailing @word must not swallow Enter.
          if (mention && cwd.trim()) {
            const navKeys = ['Enter', 'Tab', 'ArrowDown', 'ArrowUp', 'Escape'];
            if (navKeys.includes(e.key)) return;
          }
          // Draft undo/redo — only while this textarea is the event target.
          // Never register a window-level listener that could steal Cmd+Z from
          // other editable controls or app-wide undo surfaces.
          const mod = e.metaKey || e.ctrlKey;
          if (mod && !e.altKey && e.key.toLowerCase() === 'z') {
            const native = e.nativeEvent as KeyboardEvent;
            if (composingRef.current || isComposing || native.isComposing || native.keyCode === 229) {
              return;
            }
            e.preventDefault();
            e.stopPropagation();
            if (e.shiftKey) {
              // Redo (Cmd/Ctrl+Shift+Z)
              if (draftIndexRef.current < draftHistoryRef.current.length - 1) {
                draftIndexRef.current += 1;
                applyDraftHistory(draftHistoryRef.current[draftIndexRef.current] ?? '');
              }
            } else if (draftIndexRef.current > 0) {
              draftIndexRef.current -= 1;
              applyDraftHistory(draftHistoryRef.current[draftIndexRef.current] ?? '');
            }
            return;
          }
          if (e.key !== 'Enter' || e.shiftKey) return;
          // Four-layer guard against accidental Enter-during-IME auto-submit:
          //   1. composingRef.current — sync ref, set synchronously by
          //      onCompositionStart even when React is busy
          //   2. React isComposing state — same signal but visible to children
          //   3. native.isComposing — browser-level flag, immune to React lag
          //   4. keyCode 229 — some browsers fire Enter as 229 mid-composition
          // Any one means "do not submit".
          const native = e.nativeEvent as KeyboardEvent;
          if (composingRef.current || isComposing || native.isComposing || native.keyCode === 229) {
            return;
          }
          e.preventDefault();
          void submit();
        }}
        />
        <div className="composer-inline-bar">
          <button
            className="composer-attach"
            type="button"
            disabled={submitting}
            aria-label={t('composer.chooseFiles')}
            title={t('composer.chooseFiles')}
            onClick={() => fileInputRef.current?.click()}
          >
            {attachments.some((item) => item.mimeType.startsWith('image/')) ? (
              <FileImage size={15} />
            ) : (
              <Paperclip size={15} />
            )}
          </button>
          <button
            className="composer-folder-attach"
            type="button"
            disabled={submitting || folderPickerBusy}
            aria-label={t('composer.attachFolder')}
            title={t('composer.attachFolder')}
            onClick={() => void chooseFolder()}
          >
            <FolderOpen size={15} />
          </button>
          {controls}
          {onStop ? (
            <button
              className="composer-send composer-stop"
              type="button"
              aria-label={t('composerSection.stopRun')}
              title={t('composerSection.stopRun')}
              onClick={onStop}
            >
              <span className="composer-stop-square" aria-hidden="true" />
            </button>
          ) : (
            <button
              className="composer-send"
              type="button"
              disabled={submitting}
              aria-label={
                submitting
                  ? t('composer.sendQueuing')
                  : hasInflight
                    ? t('composer.sendEnqueue')
                    : t('composer.send')
              }
              title={
                submitting
                  ? t('composer.sendQueuing')
                  : hasInflight
                    ? t('composer.sendEnqueue')
                    : t('composer.send')
              }
              onClick={() => void submit()}
            >
              <ArrowUp size={19} strokeWidth={1.9} aria-hidden="true" />
            </button>
          )}
        </div>
      </div>
    </div>
  );
});
