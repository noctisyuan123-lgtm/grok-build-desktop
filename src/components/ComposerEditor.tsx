import { Extension, type JSONContent } from '@tiptap/core';
import type { EditorView } from '@tiptap/pm/view';
import { EditorContent, useEditor, type Editor } from '@tiptap/react';
import StarterKit from '@tiptap/starter-kit';
import { Markdown } from '@tiptap/markdown';
import { TableKit } from '@tiptap/extension-table/kit';
import { forwardRef, useEffect, useImperativeHandle, useRef, useState } from 'react';
import type { FileEntry } from '../lib/files';

const FILE_PICKER_LISTBOX_ID = 'composer-file-picker-listbox';

type ComposerKeyHandlers = {
  pickerOpen: () => boolean;
  submit: (delivery: 'queue' | 'interrupt') => void;
  cancel: () => boolean;
};

// Module-stable extensions. A fresh StarterKit/keymap on every render makes
// TipTap call setOptions → view.updateState, which drops the caret in WKWebView.
const composerKeyHandlers = new WeakMap<Editor, ComposerKeyHandlers>();
let mountedComposer: Editor | null = null;

const composerKeys = Extension.create({
  name: 'composerKeys',
  addKeyboardShortcuts() {
    const read = () => composerKeyHandlers.get(this.editor);
    return {
      Enter: () => {
        const handlers = read();
        if (!handlers) return false;
        if (handlers.pickerOpen()) return true;
        if (this.editor.view.composing) return true;
        handlers.submit('queue');
        return true;
      },
      'Mod-Enter': () => {
        const handlers = read();
        if (!handlers) return false;
        if (handlers.pickerOpen()) return true;
        if (this.editor.view.composing) return true;
        handlers.submit('interrupt');
        return true;
      },
      'Alt-Enter': () => {
        const handlers = read();
        if (!handlers) return false;
        if (handlers.pickerOpen()) return true;
        if (this.editor.view.composing) return true;
        handlers.submit('queue');
        return true;
      },
      Escape: () => read()?.cancel() ?? false,
    };
  },
});

const composerExtensions = [
  StarterKit.configure({
    heading: { levels: [1, 2, 3, 4, 5, 6] },
    link: false,
  }),
  TableKit.configure({
    table: { resizable: false },
  }),
  Markdown,
  composerKeys,
];

const composerEditorProps = {
  attributes: {
    class: 'composer-prosemirror',
    role: 'textbox',
    'aria-multiline': 'true',
    spellcheck: 'false',
    autocorrect: 'off',
    autocapitalize: 'off',
  },
  handlePaste(_view: EditorView, event: ClipboardEvent) {
    const text = event.clipboardData?.getData('text/plain') ?? '';
    const html = event.clipboardData?.getData('text/html') ?? '';
    const looksLikeMdTable = /(?:^|\n)\s*\|.+\|/.test(text);
    // HTML tables (Sheets/Word/browser) need the default parser once TableKit is on.
    if (html.includes('<table') && !looksLikeMdTable) return false;
    if (!text) return false;
    const current = mountedComposer;
    if (!current) return false;
    event.preventDefault();
    insertPastedMarkdown(current, text);
    return true;
  },
};

export interface ComposerEditorHandle {
  getMarkdown: () => string;
  setMarkdown: (text: string) => void;
  focus: () => void;
  getDom: () => HTMLElement | null;
  replaceActiveMention: (entry: FileEntry) => void;
}

function detectPlainMention(
  text: string,
  caret: number,
): { start: number; query: string } | null {
  if (caret <= 0) return null;
  let i = caret - 1;
  while (i >= 0) {
    const ch = text[i];
    if (ch === '@') {
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

function mentionInsertion(entry: FileEntry): string {
  return /\s/.test(entry.path) ? `@"${entry.path}" ` : `@${entry.path} `;
}

function normalizePasteText(text: string): string {
  return text.replace(/\r\n/g, '\n').replace(/\r/g, '\n');
}

function isBlockMarkdownPaste(text: string): boolean {
  return /(?:^|\n)\s*\|.+\|/.test(text) || /(?:^|\n)```/.test(text);
}

function inCodeContext(editor: Editor): boolean {
  const { $from, $to } = editor.state.selection;
  if (!$from.sameParent($to)) return false;
  return Boolean($from.parent.type.spec.code) || editor.isActive('code');
}

/** Codex-style literal paste: one paragraph, `\n` → hardBreak. */
function literalHardBreakContent(text: string): JSONContent[] {
  const lines = normalizePasteText(text).replace(/\n+$/, '').split('\n');
  const content: JSONContent[] = [];
  for (let i = 0; i < lines.length; i++) {
    if (i > 0) content.push({ type: 'hardBreak' });
    const line = lines[i];
    if (line) content.push({ type: 'text', text: line });
  }
  return content;
}

function insertPastedMarkdown(editor: Editor, text: string) {
  const normalized = normalizePasteText(text);
  if (inCodeContext(editor)) {
    editor.view.dispatch(editor.state.tr.insertText(normalized));
    return;
  }
  if (isBlockMarkdownPaste(normalized)) {
    editor.commands.insertContent(normalized, { contentType: 'markdown' });
    return;
  }
  const trimmed = normalized.replace(/\n+$/, '');
  if (!trimmed.includes('\n')) {
    const blocks = editor.markdown?.parse(trimmed)?.content ?? [];
    const only = blocks.find((block) => block.type === 'paragraph' && block.content?.length);
    if (only?.content) {
      editor.commands.insertContent(only.content);
      return;
    }
    if (trimmed) editor.commands.insertContent([{ type: 'text', text: trimmed }]);
    return;
  }
  const inline = literalHardBreakContent(normalized);
  if (inline.length) editor.commands.insertContent(inline);
}

interface Props {
  initialValue?: string;
  disabled?: boolean;
  placeholder?: string;
  pickerOpen?: boolean;
  activeOptionId?: string | null;
  onMarkdownChange?: (markdown: string) => void;
  onMentionScan?: (mention: { start: number; query: string } | null) => void;
  onBlurMarkdown?: (markdown: string) => void;
  onSubmitEnter?: (delivery: 'queue' | 'interrupt') => void;
  onCancel?: () => void;
}

export const ComposerEditor = forwardRef<ComposerEditorHandle, Props>(function ComposerEditor(
  {
    initialValue = '',
    disabled = false,
    placeholder = '',
    pickerOpen = false,
    activeOptionId,
    onMarkdownChange,
    onMentionScan,
    onBlurMarkdown,
    onSubmitEnter,
    onCancel,
  },
  outerRef,
) {
  const pickerOpenRef = useRef(pickerOpen);
  pickerOpenRef.current = pickerOpen;
  const onSubmitEnterRef = useRef(onSubmitEnter);
  onSubmitEnterRef.current = onSubmitEnter;
  const onCancelRef = useRef(onCancel);
  onCancelRef.current = onCancel;
  const onMarkdownChangeRef = useRef(onMarkdownChange);
  onMarkdownChangeRef.current = onMarkdownChange;
  const onMentionScanRef = useRef(onMentionScan);
  onMentionScanRef.current = onMentionScan;
  const editorRef = useRef<Editor | null>(null);
  const [showPlaceholder, setShowPlaceholder] = useState(() => initialValue.trim() === '');

  const scanMention = (editor: Editor) => {
    const { from } = editor.state.selection;
    const $from = editor.state.selection.$from;
    const start = $from.start();
    const textBefore = editor.state.doc.textBetween(start, from);
    onMentionScanRef.current?.(detectPlainMention(textBefore, textBefore.length));
  };

  const editor = useEditor({
    immediatelyRender: false,
    shouldRerenderOnTransaction: false,
    content: initialValue,
    contentType: 'markdown',
    editable: !disabled,
    extensions: composerExtensions,
    editorProps: composerEditorProps,
    onUpdate: ({ editor: next }) => {
      scanMention(next);
      // Avoid React setState on every keystroke (that remounted the editor
      // wrapper). Tests still read data-composer-source. Placeholder visibility
      // flips once, when the doc leaves or returns to empty — not per letter.
      const markdown = next.getMarkdown();
      const isEmpty = next.isEmpty;
      setShowPlaceholder((current) => (current === isEmpty ? current : isEmpty));
      next.view.dom.closest('.composer-editor')?.setAttribute('data-composer-source', markdown);
      onMarkdownChangeRef.current?.(markdown);
    },
    onSelectionUpdate: ({ editor: next }) => {
      scanMention(next);
    },
  });

  editorRef.current = editor;
  mountedComposer = editor;
  if (editor) {
    composerKeyHandlers.set(editor, {
      pickerOpen: () => pickerOpenRef.current,
      submit: (delivery) => {
        onSubmitEnterRef.current?.(delivery);
      },
      cancel: () => {
        if (!onCancelRef.current) return false;
        onCancelRef.current();
        return true;
      },
    });
  }

  useEffect(() => {
    editor?.setEditable(!disabled);
  }, [disabled, editor]);

  useEffect(() => {
    const dom = editor?.view.dom;
    if (!dom) return;
    if (pickerOpen) {
      dom.setAttribute('role', 'combobox');
      dom.setAttribute('aria-expanded', 'true');
      dom.setAttribute('aria-controls', FILE_PICKER_LISTBOX_ID);
      dom.setAttribute('aria-autocomplete', 'list');
      if (activeOptionId) dom.setAttribute('aria-activedescendant', activeOptionId);
      else dom.removeAttribute('aria-activedescendant');
    } else {
      dom.setAttribute('role', 'textbox');
      dom.removeAttribute('aria-expanded');
      dom.removeAttribute('aria-controls');
      dom.removeAttribute('aria-autocomplete');
      dom.removeAttribute('aria-activedescendant');
    }
  }, [activeOptionId, editor, pickerOpen]);

  useImperativeHandle(
    outerRef,
    () => ({
      getMarkdown: () => editorRef.current?.getMarkdown() ?? '',
      setMarkdown: (text: string) => {
        const current = editorRef.current;
        if (!current) return;
        // External writes only. A focused editor already holding this text
        // must not setContent — that rebuilds the DOM and drops the caret.
        if (current.view.hasFocus() && current.getMarkdown() === text) return;
        current.commands.setContent(text, { contentType: 'markdown' });
        setShowPlaceholder(current.isEmpty);
        const markdown = current.getMarkdown();
        current.view.dom.closest('.composer-editor')?.setAttribute('data-composer-source', markdown);
        onMarkdownChangeRef.current?.(markdown);
      },
      focus: () => {
        editorRef.current?.commands.focus('end');
      },
      getDom: () => editorRef.current?.view.dom ?? null,
      replaceActiveMention: (entry: FileEntry) => {
        const current = editorRef.current;
        if (!current) return;
        const { from } = current.state.selection;
        const start = current.state.selection.$from.start();
        const textBefore = current.state.doc.textBetween(start, from);
        const mention = detectPlainMention(textBefore, textBefore.length);
        if (!mention) return;
        const insertion = mentionInsertion(entry);
        current
          .chain()
          .focus()
          .insertContentAt({ from: start + mention.start, to: from }, insertion)
          .run();
      },
    }),
    [],
  );

  return (
    <div className="composer-editor-shell">
      {showPlaceholder && placeholder ? (
        <div className="composer-placeholder" aria-hidden="true">
          {placeholder}
        </div>
      ) : null}
      <EditorContent
        editor={editor}
        className="composer-editor"
        data-composer-source={initialValue}
        onBlur={() => onBlurMarkdown?.(editorRef.current?.getMarkdown() ?? '')}
      />
    </div>
  );
});
