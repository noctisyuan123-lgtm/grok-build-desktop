import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { mockIPC } from '@tauri-apps/api/mocks';
import { Composer } from '../Composer';
import { streamStore, getPendingSubmitCount } from '../../lib/streamStore';

// jsdom provides requestAnimationFrame, but keep the focus-restore rAF
// deterministic regardless of environment quirks.
beforeEach(() => {
  streamStore.__reset();
  vi.stubGlobal('requestAnimationFrame', (cb: FrameRequestCallback) => {
    cb(0);
    return 0;
  });
});

function renderComposer(overrides: Partial<Parameters<typeof Composer>[0]> = {}) {
  const onEnqueued = vi.fn();
  const onError = vi.fn();
  const utils = render(
    <Composer
      cwd=""
      argsBuilder={() => ['--output-format', 'streaming-json']}
      onEnqueued={onEnqueued}
      onError={onError}
      {...overrides}
    />,
  );
  const textarea = screen.getByRole('textbox') as HTMLTextAreaElement;
  return { ...utils, onEnqueued, onError, textarea };
}

describe('Composer submit', () => {
  it('replaces the send arrow with a round square stop control while running', async () => {
    mockIPC(() => undefined);
    const onStop = vi.fn();
    const user = userEvent.setup();
    streamStore.patchRun('active-run', { state: 'running' });
    streamStore.setQueue({ active: 'active-run', activeIds: ['active-run'], items: [] });
    const { container } = renderComposer({ onStop });

    // Icon-only Stop occupies the send slot; no separate text Stop control.
    expect(screen.queryByRole('button', { name: 'Send' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Enqueue' })).not.toBeInTheDocument();
    const stop = screen.getByRole('button', { name: 'Stop run' });
    expect(stop).toHaveClass('composer-send', 'composer-stop');
    expect(container.querySelector('.composer-stop-square')).toBeInTheDocument();
    expect(stop).not.toHaveTextContent('Stop');
    await user.click(stop);
    expect(onStop).toHaveBeenCalledTimes(1);
  });

  it('submits (enqueues) on Enter while Stop occupies the send slot', async () => {
    const calls: Array<{ cmd: string; payload: unknown }> = [];
    mockIPC((cmd, payload) => {
      calls.push({ cmd, payload });
      return cmd === 'enqueue_run' ? { runId: 'queued-1', position: 1 } : undefined;
    });
    const onStop = vi.fn();
    const user = userEvent.setup();
    streamStore.patchRun('active-run', { state: 'running' });
    streamStore.setQueue({ active: 'active-run', activeIds: ['active-run'], items: [] });
    const { onEnqueued, textarea } = renderComposer({
      onStop,
      parentRunId: 'parent-run',
      laneId: 'tab-session-1',
    });

    await user.type(textarea, 'follow-up after long script');
    await user.keyboard('{Enter}');
    await waitFor(() => expect(onEnqueued).toHaveBeenCalledTimes(1));
    expect(onEnqueued.mock.calls[0][0].prompt).toBe('follow-up after long script');
    expect(calls.find((call) => call.cmd === 'enqueue_run')?.payload).toMatchObject({
      parentRunId: 'parent-run',
      laneId: 'tab-session-1',
    });
    expect(onStop).not.toHaveBeenCalled();
  });

  it('keeps the ArrowUp Send button when no onStop is provided even if another session is inflight', async () => {
    // Other-session runs must not replace this session's send control, and
    // concurrent lanes must not flip this free session to Enqueue either.
    mockIPC(() => undefined);
    streamStore.patchRun('other-run', { state: 'running' });
    streamStore.setQueue({ active: 'other-run', activeIds: ['other-run'], items: [] });
    renderComposer({ sessionRunIds: [], laneId: 'this-session' });

    expect(screen.getByRole('button', { name: 'Send' })).toHaveClass('composer-send');
    expect(screen.queryByRole('button', { name: 'Stop run' })).not.toBeInTheDocument();
  });

  it('enqueues the typed prompt with the built args plus -p, then clears the box', async () => {
    const calls: Array<{ cmd: string; payload: unknown }> = [];
    mockIPC((cmd, payload) => {
      calls.push({ cmd, payload });
      if (cmd === 'enqueue_run') return { runId: 'r1', position: 0 };
      return undefined;
    });
    const user = userEvent.setup();
    const { onEnqueued, onError, textarea } = renderComposer({ cwd: '/repo' });

    await user.type(textarea, 'fix the bug');
    await user.click(screen.getByRole('button', { name: 'Send' }));

    await waitFor(() => expect(onEnqueued).toHaveBeenCalledTimes(1));
    expect(onEnqueued).toHaveBeenCalledWith({
      runId: 'r1',
      position: 0,
      prompt: 'fix the bug',
      rawText: 'fix the bug',
      attachments: [],
    });
    const enqueue = calls.find((c) => c.cmd === 'enqueue_run')!;
    expect(enqueue.payload).toMatchObject({
      prompt: 'fix the bug',
      cwd: '/repo',
      args: ['--output-format', 'streaming-json', '-p', 'fix the bug'],
    });
    expect(textarea.value).toBe('');
    expect(onError).not.toHaveBeenCalled();
    expect(getPendingSubmitCount()).toBe(0);
  });

  it('submits on Enter but inserts a newline on Shift+Enter', async () => {
    mockIPC((cmd) => (cmd === 'enqueue_run' ? { runId: 'r2', position: 0 } : undefined));
    const user = userEvent.setup();
    const { onEnqueued, textarea } = renderComposer();

    await user.type(textarea, 'line one');
    await user.keyboard('{Shift>}{Enter}{/Shift}');
    expect(onEnqueued).not.toHaveBeenCalled();
    expect(textarea.value).toBe('line one\n');

    await user.keyboard('{Enter}');
    await waitFor(() => expect(onEnqueued).toHaveBeenCalledTimes(1));
    expect(onEnqueued.mock.calls[0][0].prompt).toBe('line one');
  });

  it('does nothing for a blank prompt', async () => {
    const invokeSpy = vi.fn();
    mockIPC(invokeSpy);
    const user = userEvent.setup();
    const { onEnqueued, textarea } = renderComposer();
    await user.type(textarea, '   ');
    await user.keyboard('{Enter}');
    expect(onEnqueued).not.toHaveBeenCalled();
    expect(invokeSpy).not.toHaveBeenCalledWith('enqueue_run', expect.anything());
  });

  it('restores a locally deleted draft with Cmd/Ctrl+Z without a server round trip', async () => {
    mockIPC(() => undefined);
    const user = userEvent.setup();
    const { textarea } = renderComposer();

    await user.type(textarea, 'keep this draft');
    expect(textarea.value).toBe('keep this draft');

    // Accidental select-all + delete.
    textarea.setSelectionRange(0, textarea.value.length);
    await user.keyboard('{Backspace}');
    expect(textarea.value).toBe('');

    // Textarea-scoped undo — not message undo, not a global window listener.
    await user.keyboard('{Meta>}z{/Meta}');
    expect(textarea.value).toBe('keep this draft');

    // Ctrl+Z path (non-mac / same handler).
    textarea.setSelectionRange(0, textarea.value.length);
    await user.keyboard('{Backspace}');
    expect(textarea.value).toBe('');
    await user.keyboard('{Control>}z{/Control}');
    expect(textarea.value).toBe('keep this draft');
  });

  it('surfaces an enqueue failure via onError and keeps the prompt for retry', async () => {
    mockIPC((cmd) => {
      if (cmd === 'enqueue_run') throw new Error('backend not ready');
      return undefined;
    });
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const user = userEvent.setup();
    const { onEnqueued, onError, textarea } = renderComposer();

    await user.type(textarea, 'important prompt');
    await user.click(screen.getByRole('button', { name: 'Send' }));

    await waitFor(() => expect(onError).toHaveBeenCalledTimes(1));
    expect(onError.mock.calls[0][0]).toContain('backend not ready');
    expect(onEnqueued).not.toHaveBeenCalled();
    // The user must be able to retry without retyping.
    expect(textarea.value).toBe('important prompt');
    // The pending-submit counter must unwind even on failure.
    expect(getPendingSubmitCount()).toBe(0);
  });

  it('seeds the initial value once on mount', () => {
    renderComposer({ initialValue: 'restored draft' });
    expect((screen.getByRole('textbox') as HTMLTextAreaElement).value).toBe('restored draft');
  });

  it('persists the draft via onTextChange on blur, not on each keystroke', async () => {
    const onTextChange = vi.fn();
    const user = userEvent.setup();
    const { textarea } = renderComposer({ onTextChange });
    await user.type(textarea, 'draft text');
    expect(onTextChange).not.toHaveBeenCalled();
    await user.tab(); // blur
    expect(onTextChange).toHaveBeenCalledWith('draft text');
  });

  it('attaches selected images and sends them as ACP prompt-json content blocks', async () => {
    const calls: Array<{ cmd: string; payload: unknown }> = [];
    mockIPC((cmd, payload) => {
      calls.push({ cmd, payload });
      if (cmd === 'enqueue_run') return { runId: 'image-run', position: 0 };
      return undefined;
    });
    const user = userEvent.setup();
    const { container, onEnqueued, textarea } = renderComposer({ cwd: '/repo' });
    const input = container.querySelector('input[type="file"]') as HTMLInputElement;
    const image = new File(['tiny image'], 'reference.png', { type: 'image/png' });

    fireEvent.change(input, { target: { files: [image] } });
    expect(await screen.findByText('reference.png')).toBeInTheDocument();
    await user.type(textarea, 'Describe this');
    await user.click(screen.getByRole('button', { name: 'Send' }));

    await waitFor(() => expect(onEnqueued).toHaveBeenCalledTimes(1));
    const enqueue = calls.find((call) => call.cmd === 'enqueue_run')!;
    const payload = enqueue.payload as { args: string[] };
    const jsonIndex = payload.args.indexOf('--prompt-json');
    expect(jsonIndex).toBeGreaterThan(-1);
    const blocks = JSON.parse(payload.args[jsonIndex + 1]!) as Array<Record<string, string>>;
    expect(blocks[0]).toMatchObject({ type: 'text' });
    expect(blocks[1]).toMatchObject({ type: 'image', mimeType: 'image/png' });
    expect(blocks[1]!.data).toMatch(/^[A-Za-z0-9+/]+=*$/);
    expect(screen.queryByText('reference.png')).not.toBeInTheDocument();
  });

  it('accepts dropped files and lets the user remove them before sending', async () => {
    mockIPC(() => undefined);
    const user = userEvent.setup();
    const { textarea } = renderComposer();
    const file = new File(['notes'], 'notes.txt', { type: 'text/plain' });

    fireEvent.drop(textarea.closest('.composer')!, { dataTransfer: { files: [file] } });
    expect(await screen.findByText('notes.txt')).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Remove notes.txt' }));
    expect(screen.queryByText('notes.txt')).not.toBeInTheDocument();
  });

  it('attaches a local folder as a compact folder card and sends its path as context', async () => {
    const calls: Array<{ cmd: string; payload: unknown }> = [];
    mockIPC((cmd, payload) => {
      calls.push({ cmd, payload });
      if (cmd === 'pick_project_folder') return '/repo/IndexTTS-heartbeats';
      if (cmd === 'enqueue_run') return { runId: 'folder-run', position: 0 };
      return undefined;
    });
    const user = userEvent.setup();
    const { onEnqueued, textarea } = renderComposer({ cwd: '/repo' });

    await user.click(screen.getByRole('button', { name: 'Attach a folder' }));
    expect(await screen.findByText('IndexTTS-heartbeats')).toBeInTheDocument();
    expect(screen.getByText('Folder')).toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: 'Send' }));
    await waitFor(() => expect(onEnqueued).toHaveBeenCalledTimes(1));
    expect(onEnqueued.mock.calls[0][0].attachedFolder).toEqual({
      name: 'IndexTTS-heartbeats',
      path: '/repo/IndexTTS-heartbeats',
    });
    expect(onEnqueued.mock.calls[0][0].prompt).toContain(
      'Attached folder:\n- IndexTTS-heartbeats (/repo/IndexTTS-heartbeats)',
    );
    expect(calls.some((call) => call.cmd === 'pick_project_folder')).toBe(true);
    expect(textarea.value).toBe('');

    expect(screen.queryByText('IndexTTS-heartbeats')).not.toBeInTheDocument();
  });

  it('lets the user remove an attached folder before sending', async () => {
    mockIPC((cmd) => (cmd === 'pick_project_folder' ? '/repo/docs' : undefined));
    const user = userEvent.setup();
    renderComposer({ cwd: '/repo' });

    await user.click(screen.getByRole('button', { name: 'Attach a folder' }));
    expect(await screen.findByText('docs')).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Remove folder docs' }));
    expect(screen.queryByText('docs')).not.toBeInTheDocument();
  });
});

describe('Composer @-mention combobox semantics', () => {
  beforeEach(() => {
    Element.prototype.scrollIntoView = vi.fn();
  });

  it('is a plain multiline textbox while no mention is active', () => {
    mockIPC(() => undefined);
    const { textarea } = renderComposer({ cwd: '/repo' });
    expect(textarea).not.toHaveAttribute('role');
    expect(textarea).not.toHaveAttribute('aria-expanded');
    expect(textarea).not.toHaveAttribute('aria-controls');
    expect(textarea).not.toHaveAttribute('aria-activedescendant');
  });

  it('becomes an expanded combobox over the file listbox while the picker is open', async () => {
    mockIPC((cmd) =>
      cmd === 'glob_files'
        ? [
            { path: 'src/a.ts', display_name: 'a.ts', size_bytes: 10 },
            { path: 'src/b.ts', display_name: 'b.ts', size_bytes: 20 },
          ]
        : undefined,
    );
    const user = userEvent.setup();
    const { textarea } = renderComposer({ cwd: '/repo' });

    await user.type(textarea, '@src');
    expect(await screen.findByText('a.ts')).toBeInTheDocument();

    const listbox = screen.getByRole('listbox');
    expect(textarea).toHaveAttribute('role', 'combobox');
    expect(textarea).toHaveAttribute('aria-expanded', 'true');
    expect(textarea).toHaveAttribute('aria-autocomplete', 'list');
    expect(textarea).toHaveAttribute('aria-controls', listbox.id);
    // The active descendant points at the highlighted option id…
    const options = screen.getAllByRole('option');
    await waitFor(() => expect(textarea).toHaveAttribute('aria-activedescendant', options[0]!.id));
    // …and tracks arrow-key navigation.
    fireEvent.keyDown(window, { key: 'ArrowDown' });
    await waitFor(() => expect(textarea).toHaveAttribute('aria-activedescendant', options[1]!.id));

    // Dismissing the picker returns the textarea to a plain textbox.
    fireEvent.keyDown(window, { key: 'Escape' });
    await waitFor(() => expect(screen.queryByRole('listbox')).not.toBeInTheDocument());
    expect(textarea).not.toHaveAttribute('role');
    expect(textarea).not.toHaveAttribute('aria-activedescendant');
  });
});
