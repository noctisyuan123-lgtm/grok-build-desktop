import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type PointerEvent as ReactPointerEvent,
} from 'react';
import { invoke } from '@tauri-apps/api/core';
import { listen, type UnlistenFn } from '@tauri-apps/api/event';
import { FitAddon } from '@xterm/addon-fit';
import { Terminal } from '@xterm/xterm';
import '@xterm/xterm/css/xterm.css';
import { Plus, TerminalSquare, X } from 'lucide-react';
import { t } from '../i18n';
import { createTerminalSessionId, nextTerminalTitle } from '../lib/terminalTabs';
import { VS_CODE_TERMINAL_OPTIONS } from '../lib/vscodeTerminal';

const TERMINAL_HEIGHT_KEY = 'grok-desktop-terminal-height';
const MIN_TERMINAL_HEIGHT = 150;
const MAX_TERMINAL_HEIGHT = 520;

interface TerminalOutputPayload {
  sessionId: string;
  data: string;
}

interface TerminalTab {
  id: string;
  title: string;
}

function storedTerminalHeight(): number {
  const parsed = Number.parseInt(window.localStorage.getItem(TERMINAL_HEIGHT_KEY) ?? '', 10);
  if (!Number.isFinite(parsed)) return 260;
  return Math.min(MAX_TERMINAL_HEIGHT, Math.max(MIN_TERMINAL_HEIGHT, parsed));
}

function decodeTerminalBytes(encoded: string): Uint8Array {
  const binary = window.atob(encoded);
  return Uint8Array.from(binary, (character) => character.charCodeAt(0));
}

// Shared stream decoder: PTY bytes arrive in arbitrary chunks, so a multi-byte
// UTF-8 char (or an ANSI color sequence) can be split across two events. A
// streaming TextDecoder reassembles them; passing a decoded *string* to
// terminal.write() avoids xterm.js re-decoding a Uint8Array and mangling
// escape sequences / non-ASCII bytes on chunk boundaries (which drops colors).
function createTerminalWriter(terminal: Terminal) {
  const decoder = new TextDecoder('utf-8');
  return (encoded: string) => {
    const bytes = decodeTerminalBytes(encoded);
    terminal.write(decoder.decode(bytes, { stream: true }));
  };
}

function makeTab(existingTitles: readonly string[]): TerminalTab {
  return {
    id: createTerminalSessionId(),
    title: nextTerminalTitle(existingTitles),
  };
}

export interface TerminalDockProps {
  open: boolean;
  onClose: () => void;
  cwd: string;
  workingDirectory: string;
}

interface TerminalSessionPaneProps {
  sessionId: string;
  cwd: string;
  active: boolean;
}

/**
 * Owns one xterm + PTY lifecycle keyed by a stable sessionId.
 * Stays mounted while the parent tab exists so switching tabs does not recreate PTYs.
 */
function TerminalSessionPane({ sessionId, cwd, active }: TerminalSessionPaneProps) {
  const hostRef = useRef<HTMLDivElement | null>(null);
  const fitRef = useRef<FitAddon | null>(null);
  const terminalRef = useRef<Terminal | null>(null);
  const activeRef = useRef(active);
  activeRef.current = active;

  useEffect(() => {
    const host = hostRef.current;
    if (!host) return;

    const id = sessionId;
    const terminal = new Terminal({
      ...VS_CODE_TERMINAL_OPTIONS,
      allowProposedApi: false,
      convertEol: false,
      macOptionIsMeta: true,
      scrollback: 5000,
    });
    const fit = new FitAddon();
    terminal.loadAddon(fit);
    terminal.open(host);
    fitRef.current = fit;
    terminalRef.current = terminal;

    // Prefer the WebGL renderer: the DOM renderer can drop colors in Tauri's
    // WebKit webview. Fall back to DOM if WebGL is unavailable.
    import('@xterm/addon-webgl')
      .then(({ WebglAddon }) => {
        if (disposed) return;
        try {
          terminal.loadAddon(new WebglAddon());
        } catch {
          /* keep DOM renderer */
        }
      })
      .catch(() => {
        /* addon unavailable — keep DOM renderer */
      });
    const writeOutput = createTerminalWriter(terminal);

    let disposed = false;
    let started = false;
    let pendingInput = '';
    let writeChain = Promise.resolve();
    const unlisteners: UnlistenFn[] = [];

    const reportTerminalError = (error: unknown) => {
      if (disposed) return;
      terminal.writeln(`\r\n\x1b[31m${String(error)}\x1b[0m`);
      terminal.options.disableStdin = true;
    };

    const writeToPty = (data: string) => {
      writeChain = writeChain
        .then(async () => {
          if (disposed) return;
          await invoke('write_terminal_session', { sessionId: id, data });
        })
        .catch(reportTerminalError);
    };

    const focusTerminal = () => terminal.focus();
    host.addEventListener('pointerdown', focusTerminal);

    const disposables = [
      terminal.onData((data) => {
        if (disposed) return;
        if (!started) {
          pendingInput += data;
          return;
        }
        writeToPty(data);
      }),
      terminal.onResize(({ cols, rows }) => {
        if (!started || disposed) return;
        void invoke('resize_terminal_session', { sessionId: id, cols, rows });
      }),
    ];

    const fitTerminal = () => {
      if (disposed) return;
      try {
        fit.fit();
      } catch {
        // The host may be between grid layouts for one animation frame.
      }
    };

    void (async () => {
      const stopOutput = await listen<TerminalOutputPayload>(
        'grok-desktop://terminal-output',
        (event) => {
          if (event.payload.sessionId === id && !disposed) {
            writeOutput(event.payload.data);
          }
        },
      );
      const stopExit = await listen<string>('grok-desktop://terminal-exit', (event) => {
        if (event.payload === id && !disposed) terminal.options.disableStdin = true;
      });
      if (disposed) {
        stopOutput();
        stopExit();
        return;
      }
      unlisteners.push(stopOutput, stopExit);
      fitTerminal();
      try {
        await invoke('start_terminal_session', {
          sessionId: id,
          cwd: cwd.trim() || null,
          cols: terminal.cols,
          rows: terminal.rows,
        });
        if (disposed) {
          await invoke('close_terminal_session', { sessionId: id });
          return;
        }
        started = true;
        if (pendingInput) {
          const input = pendingInput;
          pendingInput = '';
          writeToPty(input);
        }
        await invoke('resize_terminal_session', {
          sessionId: id,
          cols: terminal.cols,
          rows: terminal.rows,
        });
        if (active) terminal.focus();
      } catch (error) {
        reportTerminalError(error);
      }
    })();

    const onWindowResize = () => fitTerminal();
    // Dock chrome resize: parent dispatches this; only the active pane fits
    // (inactive panes keep size via absolute stacking but stay cheap).
    const onDockResize = () => {
      if (!activeRef.current) return;
      fitTerminal();
    };
    window.addEventListener('resize', onWindowResize);
    window.addEventListener('terminal-dock-resize', onDockResize);

    return () => {
      disposed = true;
      window.removeEventListener('resize', onWindowResize);
      window.removeEventListener('terminal-dock-resize', onDockResize);
      host.removeEventListener('pointerdown', focusTerminal);
      unlisteners.forEach((unlisten) => unlisten());
      disposables.forEach((disposable) => disposable.dispose());
      if (started) void invoke('close_terminal_session', { sessionId: id });
      fitRef.current = null;
      terminalRef.current = null;
      terminal.dispose();
    };
    // sessionId is stable for the pane's lifetime; cwd is captured at mount
    // (new tabs pick up the latest cwd; switching tabs must not recreate PTYs).
    // eslint-disable-next-line react-hooks/exhaustive-deps -- intentional mount-once
  }, [sessionId]);

  // Fit + focus only the visible pane when it becomes active (or when shown).
  useEffect(() => {
    if (!active) return;
    const fit = fitRef.current;
    const terminal = terminalRef.current;
    if (!fit || !terminal) return;
    try {
      fit.fit();
    } catch {
      /* layout may still be settling */
    }
    terminal.focus();
  }, [active]);

  return <div className="terminal-xterm" ref={hostRef} />;
}

export function TerminalDock({ open, onClose, cwd, workingDirectory }: TerminalDockProps) {
  const heightRef = useRef(storedTerminalHeight());
  const [tabs, setTabs] = useState<TerminalTab[]>([]);
  const [activeId, setActiveId] = useState<string | null>(null);
  const panesRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    document.documentElement.style.setProperty('--terminal-height', `${heightRef.current}px`);
  }, []);

  // Open → ensure one live tab before paint. Close → drop tabs so panes unmount / PTYs die.
  useLayoutEffect(() => {
    if (!open) {
      setTabs([]);
      setActiveId(null);
      return;
    }
    setTabs((prev) => (prev.length > 0 ? prev : [makeTab([])]));
  }, [open]);

  useEffect(() => {
    if (!open || tabs.length === 0) return;
    setActiveId((current) =>
      current && tabs.some((tab) => tab.id === current) ? current : tabs[0].id,
    );
  }, [open, tabs]);

  // Dock chrome resize: notify panes; only the active one fits.
  useEffect(() => {
    if (!open || !panesRef.current) return;
    const root = panesRef.current;
    const notify = () => window.dispatchEvent(new Event('terminal-dock-resize'));
    if (typeof ResizeObserver === 'undefined') return;
    const observer = new ResizeObserver(notify);
    observer.observe(root);
    return () => observer.disconnect();
  }, [open]);

  const addTab = useCallback(() => {
    setTabs((prev) => {
      const next = makeTab(prev.map((tab) => tab.title));
      setActiveId(next.id);
      return [...prev, next];
    });
  }, []);

  const closeTab = useCallback(
    (id: string) => {
      setTabs((prev) => {
        if (prev.length <= 1) {
          onClose();
          return prev;
        }
        const index = prev.findIndex((tab) => tab.id === id);
        if (index < 0) return prev;
        const next = prev.filter((tab) => tab.id !== id);
        setActiveId((current) => {
          if (current !== id) return current;
          const neighbor = next[Math.max(0, index - 1)] ?? next[0];
          return neighbor?.id ?? null;
        });
        return next;
      });
    },
    [onClose],
  );

  if (!open) return null;

  function startResize(event: ReactPointerEvent<HTMLDivElement>) {
    event.preventDefault();
    const startY = event.clientY;
    const startHeight = heightRef.current;
    const maximum = Math.min(MAX_TERMINAL_HEIGHT, Math.round(window.innerHeight * 0.58));

    const move = (moveEvent: PointerEvent) => {
      const next = Math.min(
        maximum,
        Math.max(MIN_TERMINAL_HEIGHT, startHeight + startY - moveEvent.clientY),
      );
      heightRef.current = next;
      document.documentElement.style.setProperty('--terminal-height', `${next}px`);
    };
    const stop = () => {
      window.localStorage.setItem(TERMINAL_HEIGHT_KEY, String(heightRef.current));
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', stop);
    };
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', stop, { once: true });
  }

  const activeTab = tabs.find((tab) => tab.id === activeId) ?? tabs[0];

  return (
    <section className="terminal-dock" aria-label={t('terminal.title')}>
      <div
        aria-label="Resize terminal"
        aria-orientation="horizontal"
        className="terminal-resizer"
        onPointerDown={startResize}
        role="separator"
      />
      <div className="terminal-toolbar">
        <div className="terminal-toolbar-start">
          <div className="terminal-tab-list" role="tablist" aria-label={t('terminal.title')}>
            {tabs.map((tab) => {
              const selected = tab.id === (activeTab?.id ?? null);
              return (
                <div
                  key={tab.id}
                  className={`terminal-tab${selected ? ' is-active' : ''}`}
                  role="tab"
                  aria-selected={selected}
                  {...(selected ? { 'aria-current': 'page' as const } : {})}
                >
                  <button
                    type="button"
                    className="terminal-tab-button"
                    onClick={() => setActiveId(tab.id)}
                  >
                    <TerminalSquare aria-hidden="true" size={14} />
                    <span>{tab.title}</span>
                  </button>
                  <button
                    type="button"
                    className="terminal-tab-close"
                    aria-label={t('terminal.closeTab')}
                    onClick={(event) => {
                      event.stopPropagation();
                      closeTab(tab.id);
                    }}
                  >
                    <X size={12} />
                  </button>
                </div>
              );
            })}
          </div>
          <button
            type="button"
            className="terminal-icon-button"
            aria-label={t('terminal.new')}
            onClick={addTab}
          >
            <Plus size={16} />
          </button>
          {activeTab ? (
            <small className="terminal-cwd" title={workingDirectory}>
              {workingDirectory}
            </small>
          ) : null}
        </div>
        <button
          aria-label={t('common.close')}
          className="terminal-icon-button"
          onClick={onClose}
          type="button"
        >
          <X size={16} />
        </button>
      </div>
      <div className="terminal-panes" ref={panesRef}>
        {tabs.map((tab) => (
          <div
            key={tab.id}
            className={`terminal-pane${tab.id === activeId ? ' is-active' : ''}`}
            role="tabpanel"
            aria-hidden={tab.id !== activeId}
          >
            <TerminalSessionPane sessionId={tab.id} cwd={cwd} active={tab.id === activeId} />
          </div>
        ))}
      </div>
    </section>
  );
}
