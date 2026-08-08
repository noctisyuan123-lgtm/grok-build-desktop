import { useEffect, useRef, type PointerEvent as ReactPointerEvent } from 'react';
import { invoke } from '@tauri-apps/api/core';
import { listen, type UnlistenFn } from '@tauri-apps/api/event';
import { FitAddon } from '@xterm/addon-fit';
import { Terminal } from '@xterm/xterm';
import '@xterm/xterm/css/xterm.css';
import { TerminalSquare, X } from 'lucide-react';
import { t } from '../i18n';
import { VS_CODE_TERMINAL_OPTIONS } from '../lib/vscodeTerminal';

const TERMINAL_HEIGHT_KEY = 'grok-desktop-terminal-height';
const MIN_TERMINAL_HEIGHT = 150;
const MAX_TERMINAL_HEIGHT = 520;

interface TerminalOutputPayload {
  sessionId: string;
  data: string;
}

function storedTerminalHeight(): number {
  const parsed = Number.parseInt(window.localStorage.getItem(TERMINAL_HEIGHT_KEY) ?? '', 10);
  if (!Number.isFinite(parsed)) return 260;
  return Math.min(MAX_TERMINAL_HEIGHT, Math.max(MIN_TERMINAL_HEIGHT, parsed));
}

function sessionId(): string {
  return `terminal-${Date.now().toString(36)}-${Math.random().toString(16).slice(2, 9)}`;
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

export interface TerminalDockProps {
  open: boolean;
  onClose: () => void;
  cwd: string;
  workingDirectory: string;
}

export function TerminalDock({ open, onClose, cwd, workingDirectory }: TerminalDockProps) {
  const heightRef = useRef(storedTerminalHeight());
  const hostRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    document.documentElement.style.setProperty('--terminal-height', `${heightRef.current}px`);
  }, []);

  useEffect(() => {
    if (!open || !hostRef.current) return;

    const host = hostRef.current;
    const id = sessionId();
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
    let resizeObserver: ResizeObserver | null = null;
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
    terminal.focus();

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
        terminal.focus();
      } catch (error) {
        reportTerminalError(error);
      }
    })();

    if (typeof ResizeObserver !== 'undefined') {
      resizeObserver = new ResizeObserver(fitTerminal);
      resizeObserver.observe(host);
    } else {
      window.addEventListener('resize', fitTerminal);
    }

    return () => {
      disposed = true;
      resizeObserver?.disconnect();
      window.removeEventListener('resize', fitTerminal);
      host.removeEventListener('pointerdown', focusTerminal);
      unlisteners.forEach((unlisten) => unlisten());
      disposables.forEach((disposable) => disposable.dispose());
      if (started) void invoke('close_terminal_session', { sessionId: id });
      terminal.dispose();
    };
  }, [cwd, open]);

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
        <div className="terminal-tab" aria-current="page">
          <TerminalSquare aria-hidden="true" size={14} />
          <span>zsh</span>
          <small>{workingDirectory}</small>
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
      <div className="terminal-xterm" ref={hostRef} />
    </section>
  );
}
