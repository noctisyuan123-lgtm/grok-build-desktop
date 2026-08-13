// Second slice of full-<App/> integration tests: keyboard shortcuts, the
// composer footer (mode / workflow presets), the folder picker, the terminal
// dock's shell runner, sidebar health actions, and the inspector drawer
// (context runners + the Mac desktop bridge).
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { VirtuosoMockContext } from 'react-virtuoso';
import App from '../App';
import { detachTauriListeners, streamStore } from '../lib/streamStore';
import { reasoningEfforts } from '../app/constants';
import { t } from '../i18n';
import { installTauriAppMock, type CommandHandler, type TauriAppMock } from '../test/tauriAppMock';

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
  return document.querySelector('.composer textarea') as HTMLTextAreaElement;
}

async function bootApp(overrides: Record<string, CommandHandler> = {}): Promise<Ctx> {
  const ctx = setup(overrides);
  expect(
    await screen.findByRole('button', { name: t('emptyState.workspaceAria') }),
  ).toBeInTheDocument();
  await waitFor(() => expect(ctx.tauri.commands()).toContain('get_grok_auth_status'));
  return ctx;
}

describe('keyboard shortcuts', () => {
  it('focuses the composer with "/" and opens global search with ⌘F', async () => {
    const { user } = await bootApp();

    await user.keyboard('/');
    expect(composerTextarea()).toHaveFocus();

    // "/" while typing in a field must NOT steal focus — it's a character.
    await user.type(composerTextarea(), 'path/to');
    expect(composerTextarea().value).toContain('path/to');

    (document.activeElement as HTMLElement).blur();
    await user.keyboard('{Meta>}f{/Meta}');
    expect(screen.getByRole('dialog', { name: t('palette.ariaLabel') })).toBeInTheDocument();
  });

  it('opens Settings with ⌘, and switches modes with ⌘1/⌘2', async () => {
    const { user } = await bootApp();

    await user.keyboard('{Meta>},{/Meta}');
    expect(await screen.findByRole('dialog', { name: t('settings.title') })).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: t('settings.close') }));

    // Mode switch leaves the composer empty — no seeded default prompt.
    const chatButton = screen.getByRole('button', { name: t('sidebar.mode.standard') });
    const codeButton = screen.getByRole('button', { name: t('sidebar.mode.coding') });
    expect(codeButton).toHaveAttribute('aria-pressed', 'true');
    await user.keyboard('{Meta>}1{/Meta}');
    await waitFor(() => expect(chatButton).toHaveAttribute('aria-pressed', 'true'));
    expect(composerTextarea().value).toBe('');
    await user.keyboard('{Meta>}2{/Meta}');
    await waitFor(() => expect(codeButton).toHaveAttribute('aria-pressed', 'true'));
  });
});

describe('compact composer controls', () => {
  it('switches CLI-only models and effort so enqueue gets one reasoning flag', async () => {
    const { tauri, user } = await bootApp({
      list_grok_models: () => ({
        ok: true,
        command: 'grok models',
        cwd: '',
        exit_code: 0,
        duration_ms: 1,
        timed_out: false,
        output: 'Available models:\n  * grok-4.6 (default)\n  - grok-4.5\n',
        stderr: '',
      }),
    });

    const modelTrigger = await screen.findByRole('button', { name: t('composerSection.grokModel') });
    await waitFor(() => expect(modelTrigger).toHaveTextContent('grok-4.6'));
    await user.click(modelTrigger);
    await user.click(screen.getByRole('option', { name: 'grok-4.5' }));
    expect(modelTrigger).toHaveTextContent('grok-4.5');

    await user.click(screen.getByRole('button', { name: t('composerSection.runSettings') }));
    await user.click(screen.getByRole('button', { name: t('composerSection.reasoningEffort') }));
    await user.click(screen.getByRole('option', { name: reasoningEfforts.xhigh.label }));

    const textarea = composerTextarea();
    await user.clear(textarea);
    await user.type(textarea, 'use the selected model');
    await user.keyboard('{Enter}');
    await waitFor(() => expect(tauri.calls.some((call) => call.cmd === 'enqueue_run')).toBe(true));

    const enqueue = [...tauri.calls].reverse().find((call) => call.cmd === 'enqueue_run')!;
    const args = enqueue.args.args as string[];
    expect(args[args.indexOf('--model') + 1]).toBe('grok-4.5');
    expect(args).not.toContain('--effort');
    expect(args[args.indexOf('--reasoning-effort') + 1]).toBe('xhigh');
    expect(args.filter((part) => part === '--reasoning-effort')).toHaveLength(1);
  });

  it('switches mode from the sidebar segment and preserves typed drafts', async () => {
    const { user } = await bootApp();
    const chatButton = screen.getByRole('button', { name: t('sidebar.mode.standard') });
    const codeButton = screen.getByRole('button', { name: t('sidebar.mode.coding') });

    // Fresh modes start EMPTY — the old seeded default prompt is gone.
    expect(composerTextarea().value).toBe('');
    await user.click(chatButton);
    expect(composerTextarea().value).toBe('');

    // Typed text is stashed per-mode and restored on return.
    await user.click(codeButton);
    await user.type(composerTextarea(), 'fix the flaky test');
    await user.click(chatButton);
    expect(composerTextarea().value).toBe('');
    await user.click(codeButton);
    expect(composerTextarea().value).toBe('fix the flaky test');
  });
});

describe('project folder picker', () => {
  it('does not duplicate project selection in the top toolbar', async () => {
    await bootApp();
    expect(screen.queryByRole('button', { name: 'Pick a project' })).not.toBeInTheDocument();
  });
});

describe('Customize control plane', () => {
  it('opens the real Grok customization sections from the sidebar', async () => {
    const { tauri, user } = await bootApp();

    await user.click(screen.getByRole('button', { name: /Customize/i }));
    const dialog = await screen.findByRole('dialog', { name: 'Customize Grok' });
    const customize = within(dialog);

    for (const section of ['Rules', 'Commands', 'Skills', 'Subagents', 'MCP', 'Hooks', 'Plugins']) {
      expect(customize.getByRole('button', { name: section })).toBeInTheDocument();
    }
    await waitFor(() => expect(tauri.commands()).toContain('list_customizations'));

    await user.click(customize.getByRole('button', { name: 'Commands' }));
    expect(
      await customize.findByText('Nothing to preview yet. Click Edit to add Markdown.'),
    ).toBeInTheDocument();
    expect(customize.queryByText('Rendering preview…')).not.toBeInTheDocument();

    await user.click(customize.getByRole('button', { name: 'MCP' }));
    await waitFor(() => expect(tauri.commands()).toContain('list_grok_mcp'));
    await user.click(customize.getByRole('button', { name: 'Plugins' }));
    await waitFor(() => expect(tauri.commands()).toContain('list_customize_plugins'));
  });

  it('renders Markdown by default and keeps the source editable', async () => {
    const { user } = await bootApp({
      list_customizations: (args) =>
        args.kind === 'rule'
          ? [
              {
                kind: 'rule',
                scope: 'user',
                name: 'preview-rule',
                path: '/mock/.grok/rules/preview-rule.md',
                content: '# Preview rule\n\n- Keep changes readable.',
                enabled: true,
                modifiedAt: Date.now(),
              },
            ]
          : [],
    });

    await user.click(screen.getByRole('button', { name: /Customize/i }));
    const dialog = await screen.findByRole('dialog', { name: 'Customize Grok' });
    const customize = within(dialog);
    expect(await customize.findByRole('heading', { name: 'Preview rule' })).toBeInTheDocument();
    expect(customize.queryByRole('textbox', { name: 'rule content' })).not.toBeInTheDocument();

    await user.click(customize.getByRole('button', { name: 'Edit' }));
    expect(customize.getByRole('textbox', { name: 'rule content' })).toHaveValue(
      '# Preview rule\n\n- Keep changes readable.',
    );
    expect(customize.getByRole('button', { name: 'Preview' })).toBeInTheDocument();
  });

  it('uses a left directory and right detail pane for MCP and Plugins', async () => {
    const { user } = await bootApp({
      list_grok_mcp: () => ({
        ok: true,
        output: JSON.stringify([
          { name: 'filesystem', scope: 'user', transport: 'stdio', enabled: true, command: 'npx' },
        ]),
        stderr: '',
      }),
      list_customize_plugins: () => ({
        ok: true,
        output: JSON.stringify([
          { name: 'review-tools', version: '1.2.0', enabled: true, source: 'owner/review-tools' },
        ]),
        stderr: '',
      }),
    });

    await user.click(screen.getByRole('button', { name: /Customize/i }));
    const customize = within(await screen.findByRole('dialog', { name: 'Customize Grok' }));

    await user.click(customize.getByRole('button', { name: 'MCP' }));
    expect(await customize.findByRole('button', { name: /filesystem/i })).toBeInTheDocument();
    expect(customize.getByText('Configuration')).toBeInTheDocument();
    expect(customize.getByText(/"command": "npx"/)).toBeInTheDocument();

    await user.click(customize.getByRole('button', { name: 'Plugins' }));
    expect(await customize.findByRole('button', { name: /review-tools/i })).toBeInTheDocument();
    expect(customize.getByText('Plugin details')).toBeInTheDocument();
    expect(customize.getByText(/"source": "owner\/review-tools"/)).toBeInTheDocument();
  });
});

describe('terminal dock and sidebar health', () => {
  it('queues keystrokes typed while the PTY is still starting', async () => {
    let finishStart: (() => void) | undefined;
    const startPending = new Promise<void>((resolve) => {
      finishStart = resolve;
    });
    const { tauri, user } = await bootApp({
      start_terminal_session: () => startPending,
    });

    await user.click(screen.getByRole('button', { name: t('titleBar.panelsAria') }));
    await user.click(await screen.findByRole('menuitem', { name: /Terminal/ }));
    await waitFor(() => expect(tauri.commands()).toContain('start_terminal_session'));

    const dock = within(document.querySelector('section.terminal-dock') as HTMLElement);
    const terminalInput = dock.getByRole('textbox', { name: 'Terminal input' });
    await user.click(terminalInput);
    await user.keyboard('hi');
    expect(tauri.commands()).not.toContain('write_terminal_session');

    finishStart?.();
    await waitFor(() => {
      const writes = tauri.calls
        .filter((call) => call.cmd === 'write_terminal_session')
        .map((call) => String(call.args.data))
        .join('');
      expect(writes).toBe('hi');
    });
  });

  it('starts an interactive PTY and forwards terminal keystrokes directly to it', async () => {
    const { tauri, user } = await bootApp();

    await user.click(screen.getByRole('button', { name: t('titleBar.panelsAria') }));
    await user.click(await screen.findByRole('menuitem', { name: /Terminal/ }));

    const dock = within(document.querySelector('section.terminal-dock') as HTMLElement);
    await waitFor(() => {
      expect(tauri.calls.find((c) => c.cmd === 'start_terminal_session')).toBeDefined();
    });
    const startCall = tauri.calls.find((c) => c.cmd === 'start_terminal_session')!;
    expect(startCall.args.cwd).toBeNull();

    const terminalInput = dock.getByRole('textbox', { name: 'Terminal input' });
    await user.click(terminalInput);
    await user.keyboard('echo hello{Enter}');
    await waitFor(() => {
      const writes = tauri.calls
        .filter((call) => call.cmd === 'write_terminal_session')
        .map((call) => String(call.args.data))
        .join('');
      expect(writes).toContain('echo hello');
      expect(writes).toContain('\r');
    });
  });

  it('re-probes tool statuses and runs the doctor from the sidebar', async () => {
    const { tauri, user } = await bootApp();

    const before = tauri.commands().filter((c) => c === 'get_tool_statuses').length;
    await user.click(screen.getByRole('button', { name: t('sidebar.refreshStatus') }));
    await waitFor(() => {
      expect(tauri.commands().filter((c) => c === 'get_tool_statuses').length).toBeGreaterThan(
        before,
      );
    });

    await user.click(screen.getByRole('button', { name: new RegExp(t('common.doctor')) }));
    await waitFor(() => expect(tauri.commands()).toContain('run_doctor'));
  });
});

describe('inspector drawer', () => {
  async function openInspector(user: Ctx['user']) {
    await user.keyboard('{Meta>}k{/Meta}');
    await screen.findByRole('dialog', { name: t('palette.ariaLabel') });
    await user.keyboard('open context');
    await user.keyboard('{Enter}');
    return await screen.findByRole('complementary', { name: t('inspector.ariaLabel') });
  }

  it('runs Inspect Grok from the context tab', async () => {
    const { tauri, user } = await bootApp();
    const inspector = await openInspector(user);

    await user.click(within(inspector).getByRole('tab', { name: t('inspectorTab.context') }));
    await user.click(within(inspector).getByRole('button', { name: t('inspector.inspectGrok') }));
    await waitFor(() => expect(tauri.commands()).toContain('inspect_grok_environment'));
  });

  it('lists MCP servers and runs the MCP doctor from the MCP tab', async () => {
    const { tauri, user } = await bootApp();
    const inspector = await openInspector(user);

    await user.click(within(inspector).getByRole('tab', { name: t('inspectorTab.mcp') }));
    await user.click(within(inspector).getByRole('button', { name: t('inspector.listMcp') }));
    await waitFor(() => expect(tauri.commands()).toContain('list_grok_mcp'));
    await user.click(within(inspector).getByRole('button', { name: t('common.doctor') }));
    await waitFor(() => expect(tauri.commands()).toContain('doctor_grok_mcp'));
  });

  it('pulls desktop context from the Mac bridge into the composer draft', async () => {
    const { tauri, user } = await bootApp();

    // The palette's dedicated action opens the drawer on the Desktop tab.
    await user.keyboard('{Meta>}k{/Meta}');
    await screen.findByRole('dialog', { name: t('palette.ariaLabel') });
    await user.keyboard('desktop bridge');
    await user.keyboard('{Enter}');

    const inspector = await screen.findByRole('complementary', {
      name: t('inspector.ariaLabel'),
    });
    // Safari is running (mock) and exposes one read-only query.
    expect(await within(inspector).findByText('Safari')).toBeInTheDocument();
    expect(within(inspector).getByText(t('desktop.notRunning'))).toBeInTheDocument();

    await user.click(within(inspector).getByRole('button', { name: 'Read Safari URL' }));
    await waitFor(() => {
      expect(tauri.calls.find((c) => c.cmd === 'desktop_query')?.args.action).toBe('safari_url');
    });
    // The result lands in the draft with its provenance header.
    await waitFor(() => {
      expect(composerTextarea().value).toContain('[Desktop context — Safari · Read Safari URL]');
      expect(composerTextarea().value).toContain('mock:safari_url');
    });
    expect(document.querySelector('.session-toast')).toHaveTextContent(
      t('notices.desktopContextAppended'),
    );

    await user.click(within(inspector).getByRole('button', { name: t('desktop.bringToFront') }));
    await waitFor(() => {
      expect(tauri.calls.find((c) => c.cmd === 'desktop_activate')?.args.app).toBe('Safari');
    });
  });

  it('lists plugins and sessions, and starts a Grok login', async () => {
    const { tauri, user } = await bootApp();
    const inspector = await openInspector(user);

    await user.click(within(inspector).getByRole('tab', { name: t('inspectorTab.plugins') }));
    await user.click(within(inspector).getByRole('button', { name: t('inspector.listPlugins') }));
    await waitFor(() => expect(tauri.commands()).toContain('list_grok_plugins'));

    await user.click(within(inspector).getByRole('tab', { name: t('inspectorTab.agents') }));
    await user.click(within(inspector).getByRole('button', { name: t('inspector.sessions') }));
    await waitFor(() => expect(tauri.commands()).toContain('list_grok_sessions'));

    await user.click(within(inspector).getByRole('tab', { name: t('inspectorTab.context') }));
    await user.click(within(inspector).getByRole('button', { name: t('inspector.connect') }));
    await waitFor(() => {
      const login = tauri.calls.find((c) => c.cmd === 'start_grok_login');
      expect(login?.args.deviceAuth).toBe(false);
    });
  });
});

describe('developer toolbelt', () => {
  it('runs the browser task and absorbs a repository', async () => {
    const { tauri, user } = await bootApp();
    const belt = within(document.querySelector('details.toolbelt') as HTMLElement);

    await user.click(belt.getByRole('button', { name: t('common.run') }));
    await waitFor(() => {
      const call = tauri.calls.find((c) => c.cmd === 'run_browser_task');
      expect(String(call?.args.task)).toContain('example.com');
    });

    await user.type(belt.getByLabelText(t('toolbelt.repoPath')), '/some/repo');
    await user.click(belt.getByRole('button', { name: t('toolbelt.absorb') }));
    await waitFor(() => {
      const call = tauri.calls.find((c) => c.cmd === 'run_absorb_repo');
      expect(call?.args.repoPath).toBe('/some/repo');
      expect(call?.args.copyText).toBe(true);
    });
  });
});

describe('conversation context menu and preview panel', () => {
  it('opens Settings from the conversation right-click menu', async () => {
    const { user } = await bootApp();

    const panel = document.querySelector('.conversation-panel') as HTMLElement;
    await user.pointer({ keys: '[MouseRight]', target: panel });
    await user.click(await screen.findByRole('menuitem', { name: 'Settings…' }));
    expect(await screen.findByRole('dialog', { name: t('settings.title') })).toBeInTheDocument();
  });

  it('opens the preview panel from the panels menu and refreshes it', async () => {
    const { tauri, user } = await bootApp();

    const before = tauri.commands().filter((c) => c === 'get_static_preview').length;
    await user.click(screen.getByRole('button', { name: t('titleBar.panelsAria') }));
    await user.click(await screen.findByRole('menuitem', { name: /Preview/ }));

    const panel = await screen.findByRole('complementary', { name: t('preview.ariaLabel') });
    expect(within(panel).getByText(t('preview.emptyTitle'))).toBeInTheDocument();
    expect(within(panel).getByText('No index.html in the mock project.')).toBeInTheDocument();
    await waitFor(() => {
      expect(tauri.commands().filter((c) => c === 'get_static_preview').length).toBeGreaterThan(
        before,
      );
    });

    await user.click(within(panel).getByRole('button', { name: t('preview.close') }));
    await waitFor(() => {
      expect(
        screen.queryByRole('complementary', { name: t('preview.ariaLabel') }),
      ).not.toBeInTheDocument();
    });
  });
});
