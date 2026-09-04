// Integration tests for the full <App/> shell under jsdom, with the Tauri IPC
// surface mocked (src/test/tauriAppMock.ts mirrors the e2e harness). These
// exercise the real user flows end-to-end through the production components:
// boot render, composer submit → queued run → streamed reply, stop, session
// tabs, sidebar/history, the ⌘K palette, settings, panels, and undo.
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { act, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { VirtuosoMockContext } from 'react-virtuoso';
import App from '../App';
import { detachTauriListeners, streamStore } from '../lib/streamStore';
import { storageKeys } from '../app/constants';
import { t } from '../i18n';
import { installTauriAppMock, type CommandHandler, type TauriAppMock } from '../test/tauriAppMock';

// jsdom lacks layout APIs the app calls: Virtuoso needs ResizeObserver, the
// palette / file picker keep their highlight visible via scrollIntoView.
class ResizeObserverStub {
  observe() {}
  unobserve() {}
  disconnect() {}
}
beforeEach(() => {
  if (typeof window.ResizeObserver === 'undefined') {
    vi.stubGlobal('ResizeObserver', ResizeObserverStub);
  }
  Element.prototype.scrollIntoView = vi.fn();
});

function setup(overrides: Record<string, CommandHandler> = {}) {
  // Fresh mock first, THEN drop listeners registered against the previous
  // test's mock (the unlisten invokes land harmlessly in the new one).
  const tauri: TauriAppMock = installTauriAppMock(overrides);
  detachTauriListeners();
  streamStore.__reset();
  const user = userEvent.setup();
  const view = render(
    <VirtuosoMockContext.Provider value={{ viewportHeight: 800, itemHeight: 64 }}>
      <App />
    </VirtuosoMockContext.Provider>,
  );
  return { tauri, user, view };
}
type Ctx = ReturnType<typeof setup>;

function composerTextarea(): HTMLTextAreaElement {
  return screen.getByPlaceholderText(t('mode.coding.placeholder')) as HTMLTextAreaElement;
}

/** Queries scoped to the conversation panel — the sidebar HISTORY rows repeat
 *  the first prompt as the conversation title, so unscoped text queries would
 *  match twice. */
function convo() {
  return within(document.querySelector('.conversation-panel') as HTMLElement);
}

async function bootApp(overrides: Record<string, CommandHandler> = {}): Promise<Ctx> {
  const ctx = setup(overrides);
  expect(
    await screen.findByRole('button', { name: t('emptyState.workspaceAria') }),
  ).toBeInTheDocument();
  // Wait for the runner bootstrap so later assertions aren't racing it.
  await waitFor(() => expect(ctx.tauri.commands()).toContain('get_grok_auth_status'));
  return ctx;
}

/** Type a prompt and press Enter; returns the run id handed out by the mock. */
async function submitPrompt(ctx: Ctx, prompt: string): Promise<string> {
  const before = ctx.tauri.runIds.length;
  const textarea = composerTextarea();
  await ctx.user.clear(textarea);
  await ctx.user.type(textarea, prompt);
  await ctx.user.keyboard('{Enter}');
  await waitFor(() => expect(ctx.tauri.runIds.length).toBeGreaterThan(before));
  return ctx.tauri.runIds[ctx.tauri.runIds.length - 1]!;
}

describe('App boot', () => {
  it('renders the shell and bootstraps through the Tauri IPC surface', async () => {
    const { tauri } = await bootApp();

    // Cursor-style new-session workspace row + composer; no starter-card wall.
    expect(screen.getByRole('button', { name: t('emptyState.workspaceAria') })).toBeInTheDocument();
    expect(document.querySelector('.starter-card')).not.toBeInTheDocument();
    expect(composerTextarea()).toBeInTheDocument();
    expect(document.querySelector('.status-bar-idle')).not.toBeInTheDocument();

    // Connection labels are intentionally omitted from the minimal chrome.
    expect(document.querySelector('.brand-wordmark')).not.toBeInTheDocument();
    expect(document.querySelector('.account-text')).not.toBeInTheDocument();
    expect(document.querySelector('.conn-pill')).not.toBeInTheDocument();

    // Boot invokes the same command surface the e2e harness documents.
    await waitFor(() => {
      for (const cmd of [
        'load_session_state',
        'get_tool_statuses',
        'get_grok_auth_status',
        'get_static_preview',
        'list_grok_models',
        'get_queue',
      ]) {
        expect(tauri.commands()).toContain(cmd);
      }
    });
    expect(tauri.unknownCommands).toEqual([]);
  });

  it('selects a workspace from the new-session project control', async () => {
    const { tauri, user } = await bootApp();
    await user.click(screen.getByRole('button', { name: t('emptyState.workspaceAria') }));
    await waitFor(() => expect(tauri.commands()).toContain('pick_project_folder'));
    expect(screen.getByRole('button', { name: t('emptyState.workspaceAria') })).toHaveTextContent(
      'project',
    );
  });

  it('opens the exact conversation sent by the CLI /desktop handoff', async () => {
    let consumed = false;
    const sessionId = '019ff6a0-9578-7870-81c6-3ab79d0f80ad';
    const ctx = await bootApp({
      consume_desktop_handoff: () => {
        if (consumed) return null;
        consumed = true;
        return { sessionId, cwd: '/mock/project', requestedAt: Date.now() };
      },
      export_grok_session: () => '## User\n\nCLI prompt\n\n## Assistant\n\nCLI answer\n',
    });

    await waitFor(() => expect(convo().getByText('CLI answer')).toBeInTheDocument());
    expect(
      [...ctx.tauri.calls].reverse().find((call) => call.cmd === 'export_grok_session')?.args
        .sessionId,
    ).toBe(sessionId);
  });
});

describe('composer submit → queued run → streamed reply', () => {
  it('enqueues the prompt and renders the streamed reply to completion', async () => {
    const ctx = await bootApp();
    const { tauri } = ctx;

    const runId = await submitPrompt(ctx, 'Say hello please');

    // enqueue_run got the prompt and the built CLI args.
    const enqueue = tauri.calls.find((c) => c.cmd === 'enqueue_run')!;
    expect(enqueue.args.prompt).toBe('Say hello please');
    expect(enqueue.args.args).toContain('-p');
    // The user bubble shows what was typed; the composer cleared.
    expect(await convo().findByText('Say hello please')).toBeInTheDocument();
    expect(composerTextarea().value).toBe('');

    // Backend picks the run up: queue active + Running state.
    await act(async () => {
      await tauri.emitQueue(runId, []);
      await tauri.emitRunState(runId, 'Running', { startedAt: Date.now() });
    });
    expect(await screen.findByRole('button', { name: /Working for/ })).toBeInTheDocument();

    // Streamed text chunks…
    await act(async () => {
      await tauri.emitRunEvent(runId, {
        type: 'tool_call',
        toolCallId: 'tool-1',
        title: 'Read file',
        status: 'completed',
        rawInput: { path: 'src/App.tsx' },
        rawOutput: { lines: 42 },
      });
      await tauri.emitRunEvent(runId, { type: 'text', data: 'Hello from mock grok. ' });
      await tauri.emitRunEvent(runId, { type: 'text', data: 'All systems streaming.' });
    });
    expect(
      await convo().findByText('Hello from mock grok. All systems streaming.'),
    ).toBeInTheDocument();

    // …then the end of the stream.
    await act(async () => {
      await tauri.emitRunEvent(runId, {
        type: 'end',
        stopReason: 'EndTurn',
        sessionId: 's-1',
        requestId: 'q-1',
      });
      await tauri.emitRunState(runId, 'Done', { endedAt: Date.now() });
    });
    // The typewriter drains the buffered tail, then the full reply is visible.
    await waitFor(() => {
      expect(document.querySelector('.message-assistant')).toHaveTextContent(
        'Hello from mock grok. All systems streaming.',
      );
    });
    // Live activity is attached below the response only while it is running;
    // completion removes the caption instead of leaving another status bar.
    expect(document.querySelector('.run-status-line')).not.toBeInTheDocument();

    // Queue empties → the transient run row disappears instead of showing idle.
    await act(async () => {
      await tauri.emitQueue(null, []);
    });
    await waitFor(() => {
      expect(document.querySelector('.status-bar-idle')).not.toBeInTheDocument();
    });

    // The finalize write-back persisted the streamed text into messages.
    await waitFor(() => {
      const stored = JSON.parse(
        window.localStorage.getItem(storageKeys.messages) ?? '[]',
      ) as Array<{
        role: string;
        content: string;
        status?: string;
        meta?: { traces?: Array<{ label?: string; raw?: unknown }> };
      }>;
      const assistant = stored.find((m) => m.role === 'assistant');
      expect(assistant?.content).toBe('Hello from mock grok. All systems streaming.');
      expect(assistant?.status).toBe('done');
      expect(assistant?.meta?.traces?.[0]?.label).toBe('Read file');
      expect(assistant?.meta?.traces?.[0]?.raw).toBeUndefined();
    });
    expect(tauri.unknownCommands).toEqual([]);
  });

  it('renders idle monitor wakeups as a new assistant bubble without a user prompt', async () => {
    const ctx = await bootApp();
    const { tauri } = ctx;
    const parentRunId = await submitPrompt(ctx, 'Keep watching the download');
    await act(async () => {
      await tauri.streamReply(parentRunId, ['盯着了。']);
    });
    expect(await convo().findByText('盯着了。')).toBeInTheDocument();

    const wakeupId = 'wakeup-run-1';
    await act(async () => {
      await tauri.emitWakeup(wakeupId, '', 'sess-1');
      await tauri.emitRunState(wakeupId, 'Running', { startedAt: Date.now() });
      await tauri.emitRunEvent(wakeupId, { type: 'text', data: '齐了，没断。' });
      await tauri.emitRunEvent(wakeupId, {
        type: 'end',
        stopReason: 'EndTurn',
        sessionId: 'sess-1',
        requestId: 'wakeup',
      });
      await tauri.emitRunState(wakeupId, 'Done', { endedAt: Date.now() });
    });

    expect(await convo().findByText('齐了，没断。')).toBeInTheDocument();
    expect(convo().queryByText('Keep watching the download')).toBeInTheDocument();
    const assistantBubbles = document.querySelectorAll('.message-assistant');
    expect(assistantBubbles.length).toBeGreaterThanOrEqual(2);
    expect(tauri.unknownCommands).toEqual([]);
  });

  it('keeps the latest response undoable while its monitor is watching', async () => {
    const ctx = await bootApp();
    const { tauri } = ctx;
    const runId = await submitPrompt(ctx, 'Watch this until it finishes');
    await act(async () => {
      await tauri.streamReply(runId, ['已开始监听。']);
    });

    await act(async () => {
      await tauri.emitWatching(runId, true, Date.now() - 1000, 'Watch this');
    });

    expect(await convo().findByText(/Watching for/)).toBeInTheDocument();
    const undo = await convo().findByRole('button', { name: t('message.undoResponse') });
    expect(undo).not.toBeDisabled();
  });

  it('checkpoints partial assistant text into storage while the run is still live', async () => {
    const ctx = await bootApp();
    const { tauri } = ctx;
    const runId = await submitPrompt(ctx, 'Keep going');

    await act(async () => {
      await tauri.emitQueue(runId, []);
      await tauri.emitRunState(runId, 'Running', { startedAt: Date.now() });
      await tauri.emitRunEvent(runId, { type: 'text', data: 'partial before quit' });
    });

    // Mid-stream checkpoint is debounced (~300ms) so React does not thrash.
    await waitFor(
      () => {
        const stored = JSON.parse(
          window.localStorage.getItem(storageKeys.messages) ?? '[]',
        ) as Array<{ role: string; content: string; status?: string }>;
        const assistant = stored.find((m) => m.role === 'assistant');
        expect(assistant?.content).toBe('partial before quit');
        expect(assistant?.status).toBe('streaming');
      },
      { timeout: 2000 },
    );
  });

  it('hands one session to CLI, imports CLI turns, and keeps Desktop on the shared head', async () => {
    const exported = [
      '## User',
      '',
      'Start together',
      '',
      '## Assistant',
      '',
      'Desktop reply',
      '',
      '## User',
      '',
      'Message from CLI',
      '',
      '## Assistant',
      '',
      'CLI reply',
    ].join('\n');
    const ctx = await bootApp({ export_grok_session: () => exported });
    const runId = await submitPrompt(ctx, 'Start together');

    await act(async () => {
      await ctx.tauri.emitRunState(runId, 'Running', { startedAt: Date.now() });
      await ctx.tauri.emitRunEvent(runId, { type: 'text', data: 'Desktop reply' });
      await ctx.tauri.emitRunEvent(runId, {
        type: 'end',
        stopReason: 'EndTurn',
        sessionId: 'shared-session',
        requestId: 'shared-request',
      });
      await ctx.tauri.emitRunState(runId, 'Done', { endedAt: Date.now() });
    });

    const textarea = composerTextarea();
    await ctx.user.type(textarea, '/cli');
    await ctx.user.keyboard('{Enter}');
    await waitFor(() => expect(ctx.tauri.commands()).toContain('open_grok_cli'));
    const openCli = [...ctx.tauri.calls].reverse().find((call) => call.cmd === 'open_grok_cli')!;
    expect(openCli.args.sessionId).toBe('shared-session');
    expect(ctx.tauri.runIds).toHaveLength(1);

    // Linking starts the Desktop listener immediately; the shared export is
    // imported without submitting the slash command as a model turn.
    expect(await convo().findByText('Message from CLI')).toBeInTheDocument();
    expect(await convo().findByText('CLI reply')).toBeInTheDocument();

    await ctx.user.type(textarea, 'Message from Desktop');
    await ctx.user.keyboard('{Enter}');
    await waitFor(() => expect(ctx.tauri.runIds).toHaveLength(2));
    const sharedEnqueue = [...ctx.tauri.calls]
      .reverse()
      .find((call) => call.cmd === 'enqueue_run')!;
    const args = sharedEnqueue.args.args as string[];
    expect(args[args.indexOf('--resume') + 1]).toBe('shared-session');
    expect(args).toContain('--share-session');
    expect(args).not.toContain('--fork-session');
  });

  it('does not restore an undone Desktop turn when CLI writes the shared session', async () => {
    let exported = [
      '## User',
      '',
      'Keep this',
      '',
      '## Assistant',
      '',
      'Kept.',
      '',
      '## User',
      '',
      'Undo me',
      '',
      '## Assistant',
      '',
      'Gone.',
    ].join('\n');
    const ctx = await bootApp({
      export_grok_session: () => exported,
      rewind_grok_session: (args) => ({
        rewound: true,
        sessionId: String(args.sessionId),
        rebased: false,
      }),
    });
    const first = await submitPrompt(ctx, 'Keep this');
    await act(async () => {
      await ctx.tauri.streamReply(first, ['Kept.']);
    });
    const second = await submitPrompt(ctx, 'Undo me');
    await act(async () => {
      await ctx.tauri.streamReply(second, ['Gone.']);
    });
    const textarea = composerTextarea();
    await ctx.user.type(textarea, '/cli');
    await ctx.user.keyboard('{Enter}');
    await waitFor(() => expect(ctx.tauri.commands()).toContain('open_grok_cli'));

    const undoButtons = await convo().findAllByRole('button', { name: t('message.undoResponse') });
    const enabledUndo = undoButtons.find((button) => !(button as HTMLButtonElement).disabled);
    await ctx.user.click(enabledUndo!);
    await waitFor(() => expect(ctx.tauri.commands()).toContain('rewind_grok_session'));
    expect(convo().queryByText('Gone.')).not.toBeInTheDocument();

    exported = [
      exported,
      '',
      '## User',
      '',
      'from CLI after undo',
      '',
      '## Assistant',
      '',
      'CLI saw the old turn',
    ].join('\n');
    await act(async () => {
      window.dispatchEvent(new Event('focus'));
    });
    expect(await convo().findByText('from CLI after undo')).toBeInTheDocument();
    expect(convo().queryByText('Undo me')).not.toBeInTheDocument();
    expect(convo().queryByText('Gone.')).not.toBeInTheDocument();
    expect(await convo().findByText('Keep this')).toBeInTheDocument();
  });

  it('undoes the latest duplicate Desktop prompt without dropping later CLI turns', async () => {
    let exported = [
      '## User',
      '',
      'continue',
      '## Assistant',
      '',
      'First continue reply',
      '## User',
      '',
      'continue',
      '## Assistant',
      '',
      'Second continue reply',
    ].join('\n');
    const ctx = await bootApp({
      export_grok_session: () => exported,
      rewind_grok_session: (args) => ({
        rewound: true,
        sessionId: String(args.sessionId),
        rebased: false,
      }),
    });
    const first = await submitPrompt(ctx, 'continue');
    await act(async () => {
      await ctx.tauri.streamReply(first, ['First continue reply']);
    });
    const second = await submitPrompt(ctx, 'continue');
    await act(async () => {
      await ctx.tauri.streamReply(second, ['Second continue reply']);
    });

    const textarea = composerTextarea();
    await ctx.user.type(textarea, '/cli');
    await ctx.user.keyboard('{Enter}');
    await waitFor(() => expect(ctx.tauri.commands()).toContain('open_grok_cli'));

    const undoButtons = await convo().findAllByRole('button', { name: t('message.undoResponse') });
    const enabledUndo = undoButtons.find((button) => !(button as HTMLButtonElement).disabled);
    await ctx.user.click(enabledUndo!);
    await waitFor(() => expect(ctx.tauri.commands()).toContain('rewind_grok_session'));

    exported = [
      exported,
      '## User',
      '',
      'from CLI after undo',
      '## Assistant',
      '',
      'CLI reply after undo',
    ].join('\n');
    await act(async () => {
      window.dispatchEvent(new Event('focus'));
    });

    expect(await convo().findByText('from CLI after undo')).toBeInTheDocument();
    expect(await convo().findByText('CLI reply after undo')).toBeInTheDocument();
    expect(await convo().findByText('First continue reply')).toBeInTheDocument();
    expect(convo().queryByText('Second continue reply')).not.toBeInTheDocument();
    expect(convo().getAllByText('continue')).toHaveLength(1);
    const rewind = [...ctx.tauri.calls]
      .reverse()
      .find((call) => call.cmd === 'rewind_grok_session');
    expect(rewind?.args.undoPrompt).toBe('continue');
  });

  it('moves the visible and live head to a rebased undo session', async () => {
    let exported = [
      '## User',
      '',
      'Keep this context',
      '',
      '## Assistant',
      '',
      'Context kept.',
      '',
      '## User',
      '',
      'Undo this turn',
      '',
      '## Assistant',
      '',
      'Undo this answer.',
    ].join('\n');
    const ctx = await bootApp({
      export_grok_session: () => exported,
      rewind_grok_session: () => {
        exported = '';
        return {
          rewound: false,
          sessionId: 'rebased-session',
          rebased: true,
        };
      },
    });
    const first = await submitPrompt(ctx, 'Keep this context');
    await act(async () => {
      await ctx.tauri.streamReply(first, ['Context kept.']);
    });
    const second = await submitPrompt(ctx, 'Undo this turn');
    await act(async () => {
      await ctx.tauri.streamReply(second, ['Undo this answer.']);
    });

    await ctx.user.type(composerTextarea(), '/cli');
    await ctx.user.keyboard('{Enter}');
    await waitFor(() => expect(ctx.tauri.commands()).toContain('open_grok_cli'));
    const opensBeforeUndo = ctx.tauri.calls.filter((call) => call.cmd === 'open_grok_cli').length;

    const undoButtons = await convo().findAllByRole('button', { name: t('message.undoResponse') });
    const enabledUndo = undoButtons.find((button) => !(button as HTMLButtonElement).disabled);
    await ctx.user.click(enabledUndo!);

    await waitFor(() => {
      const opens = ctx.tauri.calls.filter((call) => call.cmd === 'open_grok_cli');
      expect(opens).toHaveLength(opensBeforeUndo + 1);
      expect(opens.at(-1)?.args.sessionId).toBe('rebased-session');
    });
    expect(composerTextarea().value).toBe('Undo this turn');
    expect(await convo().findByText('Context kept.')).toBeInTheDocument();
    expect(convo().queryByText('Undo this answer.')).not.toBeInTheDocument();

    const rewind = [...ctx.tauri.calls]
      .reverse()
      .find((call) => call.cmd === 'rewind_grok_session');
    expect(rewind?.args.replayContext).toContain('Keep this context');
    expect(rewind?.args.replayContext).toContain('Context kept.');

    exported = '## User\n\nCLI after rebase\n\n## Assistant\n\nCLI rebased reply.\n';
    await act(async () => {
      window.dispatchEvent(new Event('focus'));
    });
    expect(await convo().findByText('Keep this context')).toBeInTheDocument();
    expect(await convo().findByText('Context kept.')).toBeInTheDocument();
    expect(await convo().findByText('CLI after rebase')).toBeInTheDocument();
    expect(await convo().findByText('CLI rebased reply.')).toBeInTheDocument();
    expect(convo().queryByText('Undo this turn')).not.toBeInTheDocument();
    expect(convo().queryByText('Undo this answer.')).not.toBeInTheDocument();

    await ctx.user.keyboard('{Enter}');
    await waitFor(() => expect(ctx.tauri.runIds).toHaveLength(3));
    const enqueue = [...ctx.tauri.calls].reverse().find((call) => call.cmd === 'enqueue_run')!;
    const args = enqueue.args.args as string[];
    expect(args[args.indexOf('--resume') + 1]).toBe('rebased-session');
  });

  it('resumes a rebased head after undoing the only visible turn', async () => {
    let exported = '## User\n\nOnly turn\n\n## Assistant\n\nOnly answer.\n';
    const ctx = await bootApp({
      export_grok_session: () => exported,
      rewind_grok_session: () => {
        exported = '';
        return {
          rewound: false,
          sessionId: 'empty-rebased-session',
          rebased: true,
        };
      },
    });
    const runId = await submitPrompt(ctx, 'Only turn');
    await act(async () => {
      await ctx.tauri.streamReply(runId, ['Only answer.']);
    });
    await ctx.user.type(composerTextarea(), '/cli');
    await ctx.user.keyboard('{Enter}');
    await waitFor(() => expect(ctx.tauri.commands()).toContain('open_grok_cli'));

    await ctx.user.click(await convo().findByRole('button', { name: t('message.undoResponse') }));
    await waitFor(() => {
      const open = [...ctx.tauri.calls].reverse().find((call) => call.cmd === 'open_grok_cli');
      expect(open?.args.sessionId).toBe('empty-rebased-session');
    });
    expect(composerTextarea().value).toBe('Only turn');
    expect(convo().queryByText('Only answer.')).not.toBeInTheDocument();

    await ctx.user.keyboard('{Enter}');
    await waitFor(() => expect(ctx.tauri.runIds).toHaveLength(2));
    const enqueue = [...ctx.tauri.calls].reverse().find((call) => call.cmd === 'enqueue_run')!;
    const args = enqueue.args.args as string[];
    expect(args[args.indexOf('--resume') + 1]).toBe('empty-rebased-session');
    expect(args).toContain('--share-session');
  });

  it('stops a running run from the composer send position and marks the message stopped', async () => {
    const ctx = await bootApp();
    const { tauri, user } = ctx;
    const runId = await submitPrompt(ctx, 'Long running task');

    await act(async () => {
      await tauri.emitQueue(runId, []);
      await tauri.emitRunState(runId, 'Running', { startedAt: Date.now() });
      await tauri.emitRunEvent(runId, { type: 'text', data: 'partial output' });
    });

    // Stop occupies the send slot (icon-only square); no separate text Stop.
    expect(screen.queryByRole('button', { name: t('composer.send') })).not.toBeInTheDocument();
    expect(
      screen.queryByRole('button', { name: t('composer.sendEnqueue') }),
    ).not.toBeInTheDocument();
    const stop = await screen.findByRole('button', { name: t('composerSection.stopRun') });
    expect(stop).toHaveClass('composer-send', 'composer-stop');
    expect(stop.querySelector('.composer-stop-square')).toBeInTheDocument();
    await user.click(stop);
    await waitFor(() => {
      const cancel = tauri.calls.find((c) => c.cmd === 'cancel_run');
      expect(cancel?.args).toEqual({ runId });
    });

    await act(async () => {
      await tauri.emitRunState(runId, 'Cancelled', { endedAt: Date.now() });
      await tauri.emitQueue(null, []);
    });
    expect(await screen.findByText(t('message.stopped'))).toBeInTheDocument();
  });

  it('enqueues a same-session follow-up against the exact active parent run', async () => {
    const ctx = await bootApp();
    const { tauri } = ctx;
    const runId = await submitPrompt(ctx, 'Parent turn still streaming');

    await act(async () => {
      await tauri.emitQueue(runId, []);
      await tauri.emitRunState(runId, 'Running', { startedAt: Date.now() });
      await tauri.emitRunEvent(runId, { type: 'text', data: 'partial…' });
    });

    const followUpId = await submitPrompt(ctx, 'Continue after this finishes');
    const enqueue = [...tauri.calls].reverse().find((c) => c.cmd === 'enqueue_run')!;
    expect(enqueue.args.prompt).toBe('Continue after this finishes');
    const args = enqueue.args.args as string[];
    // Parent has not emitted a session id yet. The queue resolves this exact
    // run's ACP session head when it starts the child — no cwd-global `-c`.
    expect(enqueue.args.parentRunId).toBe(runId);
    // Same UI session → same lane; backend serializes behind parentRunId.
    expect(typeof enqueue.args.laneId).toBe('string');
    expect(String(enqueue.args.laneId).length).toBeGreaterThan(0);
    expect(args).not.toContain('-c');
    expect(args).not.toContain('--resume');
    expect(followUpId).toBeTruthy();
    expect(await convo().findByText('Continue after this finishes')).toBeInTheDocument();
  });

  it('undoes only the latest completed turn and restores its prompt to the composer', async () => {
    const ctx = await bootApp();
    const runId = await submitPrompt(ctx, 'Please revise this prompt');
    await act(async () => {
      await ctx.tauri.streamReply(runId, ['A completed answer.']);
    });
    await waitFor(() => {
      expect(document.querySelector('.message-assistant')).toHaveTextContent('A completed answer.');
    });
    await ctx.user.type(composerTextarea(), 'Keep this newer draft');

    await ctx.user.click(await convo().findByRole('button', { name: t('message.undoResponse') }));

    expect(
      await convo().findByRole('button', { name: t('emptyState.workspaceAria') }),
    ).toBeInTheDocument();
    expect(composerTextarea().value).toBe('Please revise this prompt');
    expect(convo().queryByText('A completed answer.')).not.toBeInTheDocument();

    await ctx.user.click(screen.getByRole('button', { name: t('common.undo') }));
    expect(await convo().findByText('Please revise this prompt')).toBeInTheDocument();
    expect(composerTextarea().value).toBe('Keep this newer draft');
  });

  it('copies the prompt and rewinds context from the latest response control', async () => {
    const ctx = await bootApp({
      rewind_grok_session: () => ({
        rewound: false,
        sessionId: 'replacement-session',
        rebased: true,
      }),
    });
    const runId = await submitPrompt(ctx, 'Undo this prompt from its own controls');
    await act(async () => {
      await ctx.tauri.streamReply(runId, ['This response should disappear too.']);
    });
    await waitFor(() => {
      expect(document.querySelector('.message-assistant')).toHaveTextContent(
        'This response should disappear too.',
      );
    });

    const writeText = vi.spyOn(navigator.clipboard, 'writeText').mockResolvedValue();
    await ctx.user.click(await convo().findByRole('button', { name: t('message.copyPrompt') }));
    expect(writeText).toHaveBeenCalledWith('Undo this prompt from its own controls');

    expect(
      convo().queryByRole('button', { name: t('message.undoPrompt') }),
    ).not.toBeInTheDocument();
    await ctx.user.click(await convo().findByRole('button', { name: t('message.undoResponse') }));

    await waitFor(() => expect(ctx.tauri.commands()).toContain('rewind_grok_session'));
    const rewind = [...ctx.tauri.calls]
      .reverse()
      .find((call) => call.cmd === 'rewind_grok_session');
    expect(rewind?.args.undoPrompt).toBe('Undo this prompt from its own controls');
    expect(convo().queryByText('Undo this prompt from its own controls')).not.toBeInTheDocument();
    expect(convo().queryByText('This response should disappear too.')).not.toBeInTheDocument();
    expect(composerTextarea().value).toBe('Undo this prompt from its own controls');

    await ctx.user.keyboard('{Enter}');
    await waitFor(() => expect(ctx.tauri.runIds).toHaveLength(2));
    const resumedArgs = [...ctx.tauri.calls].reverse().find((call) => call.cmd === 'enqueue_run')
      ?.args.args as string[];
    expect(resumedArgs).toContain('--resume');
    expect(resumedArgs[resumedArgs.indexOf('--resume') + 1]).toBe('replacement-session');
    expect(resumedArgs).not.toContain('--share-session');
  });

  it('edits the latest user bubble only after the old model context is rewound', async () => {
    let rewindArgs: Record<string, unknown> | undefined;
    const ctx = await bootApp({
      rewind_grok_session: (args) => {
        rewindArgs = args;
        return {
          rewound: true,
          sessionId: String(args.sessionId),
          rebased: false,
        };
      },
    });
    const firstRun = await submitPrompt(ctx, 'Original prompt');
    await act(async () => {
      await ctx.tauri.streamReply(firstRun, ['Original answer']);
    });
    await waitFor(() => expect(convo().getByText('Original answer')).toBeInTheDocument());

    await ctx.user.click(await convo().findByRole('button', { name: t('message.editPrompt') }));
    const editBox = await convo().findByRole('textbox', { name: t('message.editPromptInput') });
    await ctx.user.clear(editBox);
    await ctx.user.type(editBox, 'Edited prompt');
    await ctx.user.click(await convo().findByRole('button', { name: t('message.editSend') }));

    await waitFor(() => expect(ctx.tauri.commands()).toContain('rewind_grok_session'));
    expect(rewindArgs?.undoPrompt).toBe('Original prompt');
    expect(String(rewindArgs?.replayContext ?? '')).not.toContain('Original prompt');
    await waitFor(() => expect(ctx.tauri.runIds).toHaveLength(2));
    expect(convo().queryByText('Original prompt')).not.toBeInTheDocument();
    expect(convo().queryByText('Original answer')).not.toBeInTheDocument();
    expect(await convo().findByText('Edited prompt')).toBeInTheDocument();
    const enqueue = [...ctx.tauri.calls].reverse().find((call) => call.cmd === 'enqueue_run');
    expect(enqueue?.args.prompt).toBe('Edited prompt');
    expect(enqueue?.args.args).toContain('--resume');
    expect(enqueue?.args.args).toContain(String(rewindArgs?.sessionId));
    expect(enqueue?.args.args).not.toContain('--fork-session');
  });

  it('restores the original user bubble and sends nothing when edit rewind fails', async () => {
    const ctx = await bootApp({
      rewind_grok_session: () => {
        throw new Error('rewind unavailable');
      },
    });
    const firstRun = await submitPrompt(ctx, 'Keep original');
    await act(async () => {
      await ctx.tauri.streamReply(firstRun, ['Original answer remains']);
    });
    await waitFor(() => expect(convo().getByText('Original answer remains')).toBeInTheDocument());

    await ctx.user.click(await convo().findByRole('button', { name: t('message.editPrompt') }));
    const editBox = await convo().findByRole('textbox', { name: t('message.editPromptInput') });
    await ctx.user.clear(editBox);
    await ctx.user.type(editBox, 'Must not send');
    await ctx.user.click(await convo().findByRole('button', { name: t('message.editSend') }));

    await waitFor(() =>
      expect(screen.getByRole('status')).toHaveTextContent(t('message.editFailed')),
    );
    expect(await convo().findByText('Keep original')).toBeInTheDocument();
    expect(await convo().findByText('Original answer remains')).toBeInTheDocument();
    expect(convo().queryByText('Must not send')).not.toBeInTheDocument();
    expect(ctx.tauri.runIds).toHaveLength(1);
  });

  it('keeps the visible pre-Undo history when the rewound export is temporarily incomplete', async () => {
    let exportText = '';
    const ctx = await bootApp({
      export_grok_session: () => exportText,
      rewind_grok_session: (args) => {
        // Simulate the durable session briefly exposing only the retained
        // prompt while its assistant transcript is still being written.
        exportText = '## User\n\nKeep this context\n';
        return {
          rewound: true,
          sessionId: String(args.sessionId),
          rebased: false,
        };
      },
    });
    const firstRun = await submitPrompt(ctx, 'Keep this context');
    await act(async () => {
      await ctx.tauri.streamReply(firstRun, ['Kept reply.']);
    });
    const secondRun = await submitPrompt(ctx, 'Remove this turn');
    await act(async () => {
      await ctx.tauri.streamReply(secondRun, ['This reply is undone.']);
    });

    await ctx.user.click(await convo().findByRole('button', { name: t('message.undoResponse') }));

    await waitFor(() => expect(ctx.tauri.commands()).toContain('rewind_grok_session'));
    expect(await convo().findByText('Keep this context')).toBeInTheDocument();
    expect(await convo().findByText('Kept reply.')).toBeInTheDocument();
    expect(convo().queryByText('Remove this turn')).not.toBeInTheDocument();
    expect(convo().queryByText('This reply is undone.')).not.toBeInTheDocument();
  });

  it('lets a user-only tail undo itself through the same context replacement path', async () => {
    let handoffConsumed = false;
    let undonePrompt = '';
    const ctx = await bootApp({
      consume_desktop_handoff: () => {
        if (handoffConsumed) return null;
        handoffConsumed = true;
        return {
          sessionId: 'shared-user-tail',
          cwd: '/mock/project',
          requestedAt: Date.now(),
        };
      },
      export_grok_session: () => '## User\n\nUndo this user-only tail\n',
      rewind_grok_session: (args) => {
        undonePrompt = String(args.undoPrompt ?? '');
        return {
          rewound: false,
          sessionId: 'replacement-user-tail',
          rebased: true,
        };
      },
    });

    expect(await convo().findByText('Undo this user-only tail')).toBeInTheDocument();
    await ctx.user.click(await convo().findByRole('button', { name: t('message.undoPrompt') }));

    await waitFor(() => expect(ctx.tauri.commands()).toContain('rewind_grok_session'));
    expect(undonePrompt).toBe('Undo this user-only tail');
    expect(convo().queryByText('Undo this user-only tail')).not.toBeInTheDocument();
    expect(composerTextarea().value).toBe('Undo this user-only tail');
  });

  it('after undo re-seeds visible prior turns into a fresh session (not a bare /clear)', async () => {
    const ctx = await bootApp();
    const firstRun = await submitPrompt(ctx, 'Remember the project name Aurora');
    await act(async () => {
      await ctx.tauri.streamReply(firstRun, ['Aurora noted.']);
    });
    await waitFor(() => {
      expect(document.querySelector('.message-assistant')).toHaveTextContent('Aurora noted.');
    });

    const secondRun = await submitPrompt(ctx, 'Now do something wrong');
    await act(async () => {
      await ctx.tauri.streamReply(secondRun, ['Wrong answer to undo.']);
    });
    await waitFor(() => {
      expect(document.querySelectorAll('.message-assistant').length).toBe(2);
    });

    const undoButtons = await convo().findAllByRole('button', { name: t('message.undoResponse') });
    const enabledUndo = undoButtons.find((button) => !(button as HTMLButtonElement).disabled);
    expect(enabledUndo).toBeTruthy();
    await ctx.user.click(enabledUndo!);
    expect(convo().queryByText('Wrong answer to undo.')).not.toBeInTheDocument();
    expect(await convo().findByText('Remember the project name Aurora')).toBeInTheDocument();
    expect(composerTextarea().value).toBe('Now do something wrong');

    // Submit the restored (or revised) prompt: must NOT resume the ACP head
    // that still holds the undone turn, and must re-seed the visible first turn.
    await ctx.user.keyboard('{Enter}');
    await waitFor(() => expect(ctx.tauri.runIds.length).toBe(3));
    const enqueue = [...ctx.tauri.calls].reverse().find((c) => c.cmd === 'enqueue_run')!;
    const args = enqueue.args.args as string[];
    expect(args).not.toContain('--resume');
    expect(args).not.toContain('-c');
    const rulesIdx = args.indexOf('--rules');
    expect(rulesIdx).toBeGreaterThanOrEqual(0);
    const rules = args[rulesIdx + 1] ?? '';
    expect(rules).toContain('Remember the project name Aurora');
    expect(rules).toContain('Aurora noted.');
    expect(rules).not.toContain('Wrong answer to undo');
    expect(rules).not.toContain('Now do something wrong');
  });

  it('toast recovery after undo clears the fresh-session re-seed plan', async () => {
    const ctx = await bootApp();
    const firstRun = await submitPrompt(ctx, 'Keep this context');
    await act(async () => {
      await ctx.tauri.streamReply(firstRun, ['Kept.']);
    });
    const secondRun = await submitPrompt(ctx, 'Undo me');
    await act(async () => {
      await ctx.tauri.streamReply(secondRun, ['Gone.']);
    });
    await waitFor(() => {
      expect(document.querySelectorAll('.message-assistant').length).toBe(2);
    });

    const undoButtons = await convo().findAllByRole('button', { name: t('message.undoResponse') });
    const enabledUndo = undoButtons.find((button) => !(button as HTMLButtonElement).disabled);
    expect(enabledUndo).toBeTruthy();
    await ctx.user.click(enabledUndo!);
    await ctx.user.click(screen.getByRole('button', { name: t('common.undo') }));
    expect(await convo().findByText('Gone.')).toBeInTheDocument();

    // Follow-up after toast restore should resume normally, not force-replay.
    await ctx.user.clear(composerTextarea());
    await ctx.user.type(composerTextarea(), 'Continue after restore');
    await ctx.user.keyboard('{Enter}');
    await waitFor(() => expect(ctx.tauri.runIds.length).toBe(3));
    const enqueue = [...ctx.tauri.calls].reverse().find((c) => c.cmd === 'enqueue_run')!;
    const args = enqueue.args.args as string[];
    expect(args).toContain('--resume');
    const rules = (args[args.indexOf('--rules') + 1] as string) ?? '';
    expect(rules).not.toContain('re-seeded into a fresh session after Undo');
  });

  it('surfaces an enqueue failure as a session notice and keeps the draft', async () => {
    const ctx = await bootApp({
      enqueue_run: () => {
        throw new Error('backend not ready');
      },
    });
    const textarea = composerTextarea();
    await ctx.user.clear(textarea);
    await ctx.user.type(textarea, 'Doomed prompt');
    await ctx.user.keyboard('{Enter}');

    // Scoped to the conversation panel — the same notice also mirrors into
    // the (closed) terminal dock.
    expect(
      await convo().findByText(t('composerSection.sendFailed', { message: 'backend not ready' })),
    ).toBeInTheDocument();
    // The prompt is still there for a retry.
    expect(composerTextarea().value).toBe('Doomed prompt');
  });
});

describe('session tabs and history', () => {
  it('forks a conversation from the selected assistant response', async () => {
    const ctx = await bootApp();
    const { tauri, user } = ctx;

    const runId = await submitPrompt(ctx, 'Explore two approaches');
    expect(convo().queryByRole('button', { name: t('message.fork') })).not.toBeInTheDocument();
    await act(async () => {
      await tauri.streamReply(runId, ['The first approach is ready.']);
    });
    await waitFor(() => {
      expect(document.querySelector('.message-assistant')).toHaveTextContent(
        'The first approach is ready.',
      );
    });
    expect(convo().getByRole('button', { name: t('message.fork') })).toBeInTheDocument();

    await user.click(convo().getByRole('button', { name: t('message.fork') }));
    expect(await convo().findByText('Explore two approaches')).toBeInTheDocument();
    expect(await convo().findByText('The first approach is ready.')).toBeInTheDocument();

    await submitPrompt(ctx, 'Try the second approach');
    const enqueue = [...tauri.calls].reverse().find((call) => call.cmd === 'enqueue_run')!;
    expect(enqueue.args.args).toContain('--resume');
    expect(enqueue.args.args).toContain('s-1');
    expect(enqueue.args.args).toContain('--fork-session');
  });

  it('replays only the selected branch when forking an older response', async () => {
    const ctx = await bootApp();
    const { tauri, user } = ctx;

    const firstRun = await submitPrompt(ctx, 'First branch point');
    await act(async () => {
      await tauri.streamReply(firstRun, ['First response']);
    });
    const secondRun = await submitPrompt(ctx, 'Later turn to exclude');
    await act(async () => {
      await tauri.streamReply(secondRun, ['Later response']);
    });

    const forkButtons = convo().getAllByRole('button', { name: t('message.fork') });
    await user.click(forkButtons[0]!);
    expect(convo().queryByText('Later turn to exclude')).not.toBeInTheDocument();
    expect(convo().queryByText('Later response')).not.toBeInTheDocument();

    await submitPrompt(ctx, 'Continue this older branch');
    const enqueue = [...tauri.calls].reverse().find((call) => call.cmd === 'enqueue_run')!;
    expect(enqueue.args.args).not.toContain('--resume');
    const args = enqueue.args.args as string[];
    const rules = args[args.indexOf('--rules') + 1] ?? '';
    expect(rules).toContain('First response');
    expect(rules).not.toContain('Later response');
  });

  it('creates a fresh session and switches back through the history row', async () => {
    const ctx = await bootApp();
    const { tauri, user } = ctx;

    const runId = await submitPrompt(ctx, 'Fix the login flake');
    await act(async () => {
      await tauri.streamReply(runId, ['Login flake fixed.']);
    });
    await waitFor(() => {
      expect(document.querySelector('.message-assistant')).toHaveTextContent('Login flake fixed.');
    });

    // New Session → clean slate in the conversation panel.
    await user.click(screen.getByRole('button', { name: new RegExp(t('nav.newSession')) }));
    expect(
      await convo().findByRole('button', { name: t('emptyState.workspaceAria') }),
    ).toBeInTheDocument();
    expect(convo().queryByText('Fix the login flake')).not.toBeInTheDocument();

    // The old conversation shows up in HISTORY; clicking it restores it.
    const row = await screen.findByRole('button', { name: /Fix the login flake/ });
    await user.click(row);
    expect(await convo().findByText('Fix the login flake')).toBeInTheDocument();
    await waitFor(() => {
      expect(document.querySelector('.message-assistant')).toHaveTextContent('Login flake fixed.');
    });
  });

  it('⌘N starts a clean session without re-showing the prior conversation', async () => {
    // Regression for the deferred microtask tab-create path that could mirror
    // the old messages onto the new tab for one frame (and sometimes stick).
    const ctx = await bootApp();
    const { tauri, user } = ctx;

    const runId = await submitPrompt(ctx, 'Prior conversation body');
    await act(async () => {
      await tauri.streamReply(runId, ['Prior reply stays in history only.']);
    });
    await waitFor(() => {
      expect(document.querySelector('.message-assistant')).toHaveTextContent(
        'Prior reply stays in history only.',
      );
    });

    // ⌘N is ignored while a textarea/input has focus (don't steal New Window).
    // Move focus onto a non-field chrome control, then fire the shortcut.
    const priorRow = await screen.findByRole('button', { name: /Prior conversation body/ });
    priorRow.focus();
    await user.keyboard('{Meta>}n{/Meta}');

    expect(
      await convo().findByRole('button', { name: t('emptyState.workspaceAria') }),
    ).toBeInTheDocument();
    expect(convo().queryByText('Prior conversation body')).not.toBeInTheDocument();
    expect(convo().queryByText('Prior reply stays in history only.')).not.toBeInTheDocument();

    // Prior chat remains a distinct HISTORY row (not split into the new surface).
    expect(
      await screen.findByRole('button', { name: /Prior conversation body/ }),
    ).toBeInTheDocument();
  });

  it('queues a new session without inheriting another session run args or Stop control', async () => {
    const ctx = await bootApp();
    const { tauri, user } = ctx;

    const runA = await submitPrompt(ctx, 'Session A long script');
    await act(async () => {
      await tauri.emitQueue(runA, []);
      await tauri.emitRunState(runA, 'Running', { startedAt: Date.now() });
      await tauri.emitRunEvent(runA, {
        type: 'text',
        data: 'Streaming only in session A',
      });
    });
    // Current session owns the run → Stop in the send slot.
    expect(await screen.findByRole('button', { name: t('composerSection.stopRun') })).toHaveClass(
      'composer-send',
      'composer-stop',
    );
    expect(await convo().findByText('Streaming only in session A')).toBeInTheDocument();

    // New empty session while A is still running.
    await user.click(screen.getByRole('button', { name: new RegExp(t('nav.newSession')) }));
    expect(
      await convo().findByRole('button', { name: t('emptyState.workspaceAria') }),
    ).toBeInTheDocument();
    expect(convo().queryByText('Session A long script')).not.toBeInTheDocument();
    expect(convo().queryByText('Streaming only in session A')).not.toBeInTheDocument();
    // Other session's run must not replace this session's send button, and
    // concurrent lanes mean this free session still shows Send (not Enqueue).
    expect(
      screen.queryByRole('button', { name: t('composerSection.stopRun') }),
    ).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: t('composer.send') })).toBeInTheDocument();

    const runB = await submitPrompt(ctx, 'Fresh session B prompt');
    const enqueueB = [...tauri.calls].reverse().find((c) => c.cmd === 'enqueue_run')!;
    expect(enqueueB.args.prompt).toBe('Fresh session B prompt');
    const argsB = enqueueB.args.args as string[];
    // Must not continue / resume session A's conversation.
    expect(argsB).not.toContain('-c');
    expect(argsB).not.toContain('--resume');
    expect(await convo().findByText('Fresh session B prompt')).toBeInTheDocument();
    // Assistant output from A must not paint into B's empty-started surface.
    expect(convo().queryByText('Streaming only in session A')).not.toBeInTheDocument();
    expect(runB).toBeTruthy();
  });

  it('clears the conversation with an undo window that restores it', async () => {
    const ctx = await bootApp();
    const { tauri, user } = ctx;

    const runId = await submitPrompt(ctx, 'Document the parser');
    await act(async () => {
      await tauri.streamReply(runId, ['Parser documented.']);
    });
    await convo().findByText('Document the parser');

    // ⌘K → "Clear current conversation".
    await user.keyboard('{Meta>}k{/Meta}');
    const palette = await screen.findByRole('dialog', { name: t('palette.ariaLabel') });
    expect(palette).toBeInTheDocument();
    await user.keyboard('clear current');
    await user.keyboard('{Enter}');

    expect(
      await convo().findByRole('button', { name: t('emptyState.workspaceAria') }),
    ).toBeInTheDocument();
    expect(convo().queryByText('Document the parser')).not.toBeInTheDocument();
    expect(screen.getByText(t('notices.cleared'))).toBeInTheDocument();

    // Undo brings the conversation back.
    await user.click(screen.getByRole('button', { name: t('common.undo') }));
    expect(await convo().findByText('Document the parser')).toBeInTheDocument();
  });
});

describe('command palette, settings, panels, shortcuts', () => {
  it('opens Settings from the palette and closes it again', async () => {
    const { user } = await bootApp();

    await user.keyboard('{Meta>}k{/Meta}');
    await screen.findByRole('dialog', { name: t('palette.ariaLabel') });
    await user.keyboard('open settings');
    await user.keyboard('{Enter}');

    // Settings modal is up; switch to the model section, then close.
    const dialog = await screen.findByRole('dialog', { name: t('settings.title') });
    expect(dialog).toBeInTheDocument();
    await user.click(within(dialog).getByRole('button', { name: t('settings.nav.model') }));
    expect(
      await within(dialog).findByRole('heading', { name: t('settings.nav.model') }),
    ).toBeInTheDocument();
    await user.click(within(dialog).getByRole('button', { name: t('settings.close') }));
    await waitFor(() => {
      expect(screen.queryByRole('dialog', { name: t('settings.title') })).not.toBeInTheDocument();
    });
  });

  it('opens the Terminal panel from the panels menu and closes it with Escape', async () => {
    const { user } = await bootApp();

    const dock = () => document.querySelector('section.terminal-dock');
    expect(dock()).not.toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: t('titleBar.panelsAria') }));
    await user.click(await screen.findByRole('menuitem', { name: /Terminal/ }));
    await waitFor(() => expect(dock()).toBeInTheDocument());

    await user.keyboard('{Escape}');
    await waitFor(() => expect(dock()).not.toBeInTheDocument());
  });

  it('toggles the sidebar with ⌘B and the theme with ⌘⇧L', async () => {
    const { view, user } = await bootApp();
    const shell = view.container.querySelector('main.app-shell')!;

    expect(shell.className).not.toContain('sidebar-collapsed');
    await user.keyboard('{Meta>}b{/Meta}');
    await waitFor(() => expect(shell.className).toContain('sidebar-collapsed'));
    expect(window.localStorage.getItem('grok-desktop-sidebar-collapsed')).toBe('1');
    await user.keyboard('{Meta>}b{/Meta}');
    await waitFor(() => expect(shell.className).not.toContain('sidebar-collapsed'));

    expect(shell.className).toContain('theme-dark');
    await user.keyboard('{Meta>}{Shift>}L{/Shift}{/Meta}');
    await waitFor(() => expect(shell.className).toContain('theme-light'));
    expect(document.documentElement.getAttribute('data-theme')).toBe('light');
  });
});
