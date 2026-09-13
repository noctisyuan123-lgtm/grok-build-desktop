import { Extension } from '@tiptap/core';
import { EditorContent, useEditor, type Editor } from '@tiptap/react';
import StarterKit from '@tiptap/starter-kit';
import { Markdown } from '@tiptap/markdown';
import Placeholder from '@tiptap/extension-placeholder';
import { TableKit } from '@tiptap/extension-table/kit';
import { forwardRef, useEffect, useImperativeHandle, useRef } from 'react';
import type { FileEntry } from '../lib/files';

const FILE_PICKER_LISTBOX_ID = 'composer-file-picker-listbox';

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
  },
  outerRef,
) {
  const pickerOpenRef = useRef(pickerOpen);
  pickerOpenRef.current = pickerOpen;
  const placeholderRef = useRef(placeholder);
  placeholderRef.current = placeholder;
  const onSubmitEnterRef = useRef(onSubmitEnter);
  onSubmitEnterRef.current = onSubmitEnter;
  const onMarkdownChangeRef = useRef(onMarkdownChange);
  onMarkdownChangeRef.current = onMarkdownChange;
  const onMentionScanRef = useRef(onMentionScan);
  onMentionScanRef.current = onMentionScan;
  const editorRef = useRef<Editor | null>(null);

  const scanMention = (editor: Editor) => {
    const { from } = editor.state.selection;
    const $from = editor.state.selection.$from;
    const start = $from.start();
    const textBefore = editor.state.doc.textBetween(start, from);
    onMentionScanRef.current?.(detectPlainMention(textBefore, textBefore.length));
  };

  const editor = useEditor({
    immediatelyRender: false,
    content: initialValue,
    contentType: 'markdown',
    editable: !disabled,
    extensions: [
      StarterKit.configure({
        heading: { levels: [1, 2, 3, 4, 5, 6] },
        link: false,
      }),
      TableKit.configure({
        table: { resizable: false },
      }),
      Markdown,
      Placeholder.configure({
        placeholder: () => placeholderRef.current,
      }),
      Extension.create({
        name: 'composerKeys',
        addKeyboardShortcuts() {
          return {
            Enter: () => {
              if (pickerOpenRef.current) return true;
              if (this.editor.view.composing) return true;
              onSubmitEnterRef.current?.('queue');
              return true;
            },
            'Mod-Enter': () => {
              if (pickerOpenRef.current) return true;
              if (this.editor.view.composing) return true;
              onSubmitEnterRef.current?.('interrupt');
              return true;
            },
            'Alt-Enter': () => {
              if (pickerOpenRef.current) return true;
              if (this.editor.view.composing) return true;
              onSubmitEnterRef.current?.('queue');
              return true;
            },
          };
        },
      }),
    ],
    editorProps: {
      attributes: {
        class: 'composer-prosemirror',
        role: 'textbox',
        'aria-multiline': 'true',
      },
      handlePaste(_view, event) {
        const text = event.clipboardData?.getData('text/plain') ?? '';
        const html = event.clipboardData?.getData('text/html') ?? '';
        const looksLikeMdTable = /(?:^|\n)\s*\|.+\|/.test(text);
        // HTML tables (Sheets/Word/browser) need the default parser once TableKit is on.
        if (html.includes('<table') && !looksLikeMdTable) return false;
        if (!text) return false;
        event.preventDefault();
        editorRef.current?.commands.insertContent(text, { contentType: 'markdown' });
        return true;
      },
    },
    onUpdate: ({ editor: next }) => {
      scanMention(next);
      // Avoid React setState on every keystroke (that remounted the editor
      // wrapper). Tests still read data-composer-source.
      const markdown = next.getMarkdown();
      next.view.dom.closest('.composer-editor')?.setAttribute('data-composer-source', markdown);
      onMarkdownChangeRef.current?.(markdown);
    },
    onSelectionUpdate: ({ editor: next }) => {
      scanMention(next);
    },
  });

  editorRef.current = editor;

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
        current.commands.setContent(text, { contentType: 'markdown' });
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
    <EditorContent
      editor={editor}
      className="composer-editor"
      data-composer-source={initialValue}
      onBlur={() => onBlurMarkdown?.(editorRef.current?.getMarkdown() ?? '')}
    />
  );
});
