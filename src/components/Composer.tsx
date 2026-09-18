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
import { ComposerEditor, type ComposerEditorHandle } from './ComposerEditor';
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

export interface ComposerFolder {
  name: string;
  path: string;
}

export interface ComposerHandle {
  /** Imperatively set the textarea value (used by starter cards / history click / drafts). */
  setValue: (text: string) => void;
  /** Restore the folder card when an undone turn is put back into the composer. */
  setAttachedFolder: (folder: ComposerFolder | null) => void;
  /** Read the current folder card before a reversible composer operation. */
  getAttachedFolder: () => ComposerFolder | null;
  /** Current textarea value. */
  getValue: () => string;
  /** Focus the textarea. */
  focus: () => void;
  /** Submit the current textarea value through the normal enqueue path. */
  submit: () => Promise<void>;
}

interface Props {
  cwd: string;
  argsBuilder: (laneId?: string) => string[];
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
  /** Temporarily lock sends while a destructive turn replacement is settling. */
  locked?: boolean;
  placeholder?: string;
  onEnqueued?: (info: {
    runId: string;
    position: number;
    prompt: string;
    rawText: string;
    attachments: ComposerAttachment[];
    attachedFolder?: ComposerFolder;
    /** Tab that owned the submit; pinned before any await. */
    laneId?: string;
  }) => void;
  /** Called when enqueueing the prompt fails, with a human-readable message.
   *  The host surfaces it (session notice) — a silent console.error left the
   *  user staring at a composer that "ate" their prompt. */
  onError?: (message: string) => void;
  /**
   * OpenCode-style cleanup-on-commit: run before args/enqueue so a pending
   * revert pointer can rewind the engine and tighten the visible transcript.
   */
  beforeEnqueue?: (laneId?: string) => Promise<void>;
  /**
   * Optional draft-persistence callback. It is deliberately not called on
   * every keystroke — passing it as a per-keystroke listener would force the
   * parent (3000-line App.tsx) to re-render on each character and stall the
   * main thread, which in turn drops IME composition events and causes
   * accidental auto-submits. It runs on blur/unmount and native window-hide
   * boundaries so a focused draft survives the macOS close button.
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
  /** Device is offline — keep the draft, do not enqueue. */
  offline?: boolean;
  /** Escape while editing a prior prompt in this composer. */
  onCancelEdit?: () => void;
}

/** Listbox id shared by the editor (aria-controls) and the FilePicker. */
const FILE_PICKER_LISTBOX_ID = 'composer-file-picker-listbox';

export const Composer = forwardRef<ComposerHandle, Props>(function Composer(
  {
    cwd,
    argsBuilder,
    parentRunId,
    beforeEnqueue,
    laneId,
    sessionRunIds,
    initialValue,
    locked = false,
    placeholder,
    onEnqueued,
    onError,
    onTextChange,
    controls,
    onStop,
    onHostSlash,
    offline = false,
    onCancelEdit,
  }: Props,
  outerRef,
) {
  const editorRef = useRef<ComposerEditorHandle>(null);
  // Track composition via BOTH a ref (sync, immune to React lag) and React
  // state (drives Send/Queuing label re-render). The ref is the authoritative
  // guard inside the keydown handler.
  const [submitting, setSubmitting] = useState(false);
  const [mention, setMention] = useState<{ start: number; query: string } | null>(null);
  // Highlighted FilePicker option id, exposed as aria-activedescendant while
  // the picker is open (the textarea keeps DOM focus the whole time).
  const [activeOptionId, setActiveOptionId] = useState<string | null>(null);
  const [attachments, setAttachments] = useState<ComposerAttachment[]>([]);
  const [attachedFolder, setAttachedFolder] = useState<ComposerFolder | null>(null);
  const [attachmentPickerBusy, setAttachmentPickerBusy] = useState(false);
  const [dragActive, setDragActive] = useState(false);
  const fileInputRef = useRef<HTMLInputElement>(null);
  // WebKit/Tauri can report the Enter keydown without metaKey even though the
  // preceding Command keydown was delivered normally. Keep a tiny native
  // modifier latch so Cmd+Enter still selects the interrupt path in that case.
  const heldModifierRef = useRef({ meta: false, ctrl: false });
  const onTextChangeRef = useRef(onTextChange);
  onTextChangeRef.current = onTextChange;

  useEffect(() => {
    const onModifierKey = (event: KeyboardEvent) => {
      const isMeta =
        event.key === 'Meta' ||
        event.key === 'OS' ||
        event.key === 'Command' ||
        event.keyCode === 91;
      const isControl = event.key === 'Control' || event.keyCode === 17;
      if (isMeta) heldModifierRef.current.meta = event.type === 'keydown';
      if (isControl) heldModifierRef.current.ctrl = event.type === 'keydown';
    };
    const clearModifiers = () => {
      heldModifierRef.current.meta = false;
      heldModifierRef.current.ctrl = false;
    };
    window.addEventListener('keydown', onModifierKey, true);
    window.addEventListener('keyup', onModifierKey, true);
    window.addEventListener('blur', clearModifiers);
    return () => {
      window.removeEventListener('keydown', onModifierKey, true);
      window.removeEventListener('keyup', onModifierKey, true);
      window.removeEventListener('blur', clearModifiers);
    };
  }, []);
  // Primitive selector — subscribing to whole run/queue snapshots would
  // re-render the Composer on every streamed token (see useHasInflight).
  // Session-scoped so another tab's long run does not flip Send → Enqueue here.
  const hasInflight = useHasInflight(
    sessionRunIds || laneId ? { sessionRunIds: sessionRunIds ?? [], laneId } : undefined,
  );

  const addAttachments = useCallback(
    (incoming: ComposerAttachment[]) => {
      setAttachments((current) => {
        const deduped = incoming.filter(
          (item) =>
            !current.some(
              (existing) => existing.name === item.name && existing.sizeBytes === item.sizeBytes,
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

  const addNativePaths = useCallback(
    async (paths: string[]) => {
      const items = await Promise.all(
        paths.map(async (path) => {
          try {
            if (await invoke<boolean>('path_is_directory', { path })) {
              return { folderPath: path } as const;
            }
            return { attachment: await readNativeAttachment(path) } as const;
          } catch (error) {
            onError?.(error instanceof Error ? error.message : String(error));
            return null;
          }
        }),
      );
      const folder = items.find(
        (item): item is { folderPath: string } => item?.folderPath !== undefined,
      );
      if (folder) attachFolderPath(folder.folderPath);
      addAttachments(
        items
          .filter(
            (item): item is { attachment: ComposerAttachment } => item?.attachment !== undefined,
          )
          .map((item) => item.attachment),
      );
    },
    [addAttachments, attachFolderPath, onError],
  );

  const chooseAttachment = useCallback(async () => {
    if (attachmentPickerBusy) return;
    // The web fallback still supports file selection; the installed desktop
    // app uses one native picker that permits both files and directories.
    if (!hasTauriRuntime()) {
      fileInputRef.current?.click();
      return;
    }
    setAttachmentPickerBusy(true);
    try {
      const paths = await invoke<string[]>('pick_attachments', {
        initial: cwd || null,
      });
      await addNativePaths(paths);
    } catch (error) {
      onError?.(
        t('notices.folderPickerFailed', {
          error: error instanceof Error ? error.message : String(error),
        }),
      );
    } finally {
      setAttachmentPickerBusy(false);
    }
  }, [addNativePaths, attachmentPickerBusy, cwd, onError]);

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
        void addNativePaths(event.payload.paths);
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
  }, [addNativePaths, onError]);

  // Persist the in-flight draft on focus/window lifecycle boundaries (e.g.
  // the macOS close button hides the window without unmounting the WebView).
  // Reads the current text directly from the DOM ref — no dependency on
  // React state. These listeners stay scoped to this mounted Composer.
  useEffect(() => {
    const flushDraft = () => {
      onTextChangeRef.current?.(editorRef.current?.getMarkdown() ?? '');
    };
    const onVisibilityChange = () => {
      if (document.visibilityState === 'hidden') flushDraft();
    };
    window.addEventListener('blur', flushDraft);
    window.addEventListener('pagehide', flushDraft);
    document.addEventListener('visibilitychange', onVisibilityChange);
    return () => {
      window.removeEventListener('blur', flushDraft);
      window.removeEventListener('pagehide', flushDraft);
      document.removeEventListener('visibilitychange', onVisibilityChange);
      onTextChangeRef.current?.(editorRef.current?.getMarkdown() ?? '');
    };
  }, []);

  /**
   * Re-scan the textarea for an active @mention. Called on input + caret
   * movement. We can't use a controlled value because the textarea is
   * uncontrolled (perf invariant — see onTextChange comment).
   */
  const insertMention = (entry: FileEntry) => {
    editorRef.current?.replaceActiveMention(entry);
    setMention(null);
    editorRef.current?.focus();
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

  const submit = async (force = false, delivery: 'queue' | 'interrupt' = 'queue') => {
    if (offline) {
      onError?.(t('composerSection.offline'));
      return;
    }
    if (submitting || (locked && !force)) return;
    const editor = editorRef.current;
    if (!editor) return;
    const rawText = editor.getMarkdown().trim();
    if (!rawText && attachments.length === 0 && !attachedFolder) return;
    setSubmitting(true);
    setMention(null);
    notePendingSubmitStart();
    try {
      // Host slash commands stay in the desktop shell (CLI handoff, etc.).
      if (rawText.startsWith('/') && onHostSlash && (await onHostSlash(rawText))) {
        editor.setMarkdown('');
        onTextChangeRef.current?.('');
        notePendingSubmitEnd();
        setSubmitting(false);
        requestAnimationFrame(() => editorRef.current?.focus());
        return;
      }
      const attachmentFallback =
        attachedFolder && attachments.length === 0
          ? t('composer.folderOnlyPrompt')
          : t('composer.attachmentOnlyPrompt');
      // Pin the tab before any await so a mid-flight tab switch cannot steal
      // this send's lane, resume head, or transcript append.
      const pinnedLaneId = laneId;
      const expandedText = await expandMentionsInPrompt(rawText || attachmentFallback);
      const attachmentList = attachments.map((item) => `- ${item.name}`).join('\n');
      const folderContext = attachedFolder
        ? `\n\nAttached folder:\n- ${attachedFolder.name} (${attachedFolder.path})`
        : '';
      const prompt = `${attachments.length ? `${expandedText}\n\nAttached files:\n${attachmentList}` : expandedText}${folderContext}`;
      if (beforeEnqueue) {
        await beforeEnqueue(pinnedLaneId);
      }
      const args = argsBuilder(pinnedLaneId);
      if (attachments.length > 0) {
        const blocks = [{ type: 'text', text: prompt }, ...attachments.map(attachmentToAcpBlock)];
        args.push('--prompt-json', JSON.stringify(blocks));
      } else {
        args.push('-p', prompt);
      }
      const result = await enqueueRun({
        prompt,
        cwd,
        args,
        parentRunId,
        laneId: pinnedLaneId,
        delivery,
      });
      editor.setMarkdown('');
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
        ...(attachedFolder ? { attachedFolder } : {}),
        laneId: pinnedLaneId,
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
      requestAnimationFrame(() => editorRef.current?.focus());
    }
  };

  // Handle modifier+Enter at the native capture phase as well as on the
  // textarea. Plain Enter always follows the normal send/queue path; when a
  // session is already running, Command/Ctrl+Enter is the explicit interrupt
  // gesture. Capturing the modifier path here keeps it reliable when a
  // macOS input method/WebView drops the modifier from React's event.
  const submitRef = useRef(submit);
  submitRef.current = submit;
  const mentionRef = useRef(mention);
  mentionRef.current = mention;
  useEffect(() => {
    const onNativeKeyDown = (event: KeyboardEvent) => {
      const dom = editorRef.current?.getDom();
      const target = event.target;
      if (!dom) return;
      if (target !== dom && (!(target instanceof Node) || !dom.contains(target))) return;
      if ((event.key !== 'Enter' && event.code !== 'NumpadEnter') || event.shiftKey) return;
      if (event.altKey) return;
      if (mentionRef.current && cwd.trim()) return;
      if (event.isComposing || event.keyCode === 229) {
        return;
      }
      const modifier =
        event.metaKey ||
        event.ctrlKey ||
        event.getModifierState?.('Meta') ||
        event.getModifierState?.('Control') ||
        heldModifierRef.current.meta ||
        heldModifierRef.current.ctrl;
      if (!modifier) return;
      event.preventDefault();
      event.stopPropagation();
      void submitRef.current(true, 'interrupt');
    };
    window.addEventListener('keydown', onNativeKeyDown, true);
    return () => window.removeEventListener('keydown', onNativeKeyDown, true);
  }, [cwd]);

  useImperativeHandle(
    outerRef,
    () => ({
      setValue: (text: string) => {
        editorRef.current?.setMarkdown(text);
      },
      setAttachedFolder,
      getAttachedFolder: () => attachedFolder,
      getValue: () => editorRef.current?.getMarkdown() ?? '',
      focus: () => editorRef.current?.focus(),
      submit: () => submit(true),
    }),
    [attachedFolder, submit],
  );

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
                <span className="composer-attachment-icon">
                  <FileText size={14} />
                </span>
              )}
              <span className="composer-attachment-copy">
                <strong>{item.name}</strong>
                <small>{formatAttachmentSize(item.sizeBytes)}</small>
              </span>
              <button
                type="button"
                aria-label={t('composer.removeAttachment', { name: item.name })}
                onClick={() =>
                  setAttachments((current) => current.filter((entry) => entry.id !== item.id))
                }
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
        <div className="composer-input-field">
          <ComposerEditor
            ref={editorRef}
            initialValue={initialValue}
            disabled={submitting || locked}
            placeholder={
              submitting
                ? t('composer.placeholderQueuing')
                : (placeholder ??
                  (hasInflight
                    ? t('composer.placeholderQueueAnother')
                    : t('composer.placeholderAsk')))
            }
            pickerOpen={pickerOpen}
            activeOptionId={activeOptionId}
            onMentionScan={setMention}
            onBlurMarkdown={(markdown) => {
              onTextChangeRef.current?.(markdown);
              setTimeout(() => setMention(null), 100);
            }}
            onSubmitEnter={(delivery) => {
              void submit(delivery === 'interrupt', delivery);
            }}
            onCancel={onCancelEdit}
          />
        </div>
        <div className="composer-inline-bar">
          <button
            className="composer-attach"
            type="button"
            disabled={submitting || locked || attachmentPickerBusy}
            aria-label={t('composer.chooseAttachment')}
            title={t('composer.chooseAttachment')}
            onClick={() => void chooseAttachment()}
          >
            {attachments.some((item) => item.mimeType.startsWith('image/')) ? (
              <FileImage size={15} />
            ) : (
              <Paperclip size={15} />
            )}
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
              disabled={submitting || locked}
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
