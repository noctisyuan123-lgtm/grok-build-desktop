import { useEffect, useRef, type PointerEvent as ReactPointerEvent } from 'react';
import { Loader2, Play, TerminalSquare, X } from 'lucide-react';
import { terminalClass, terminalPrefix, terminalText } from '../app/format';
import { t } from '../i18n';

const TERMINAL_HEIGHT_KEY = 'grok-desktop-terminal-height';
const MIN_TERMINAL_HEIGHT = 150;
const MAX_TERMINAL_HEIGHT = 520;

function storedTerminalHeight(): number {
  const parsed = Number.parseInt(window.localStorage.getItem(TERMINAL_HEIGHT_KEY) ?? '', 10);
  if (!Number.isFinite(parsed)) return 260;
  return Math.min(MAX_TERMINAL_HEIGHT, Math.max(MIN_TERMINAL_HEIGHT, parsed));
}

export interface TerminalDockProps {
  open: boolean;
  onClose: () => void;
  busyRunner: string | null;
  shellCommand: string;
  setShellCommand: (command: string) => void;
  runShell: () => void | Promise<void>;
  workingDirectory: string;
  terminalDisplay: string[];
}

export function TerminalDock({
  open,
  onClose,
  busyRunner,
  shellCommand,
  setShellCommand,
  runShell,
  workingDirectory,
  terminalDisplay,
}: TerminalDockProps) {
  const heightRef = useRef(storedTerminalHeight());

  useEffect(() => {
    document.documentElement.style.setProperty('--terminal-height', `${heightRef.current}px`);
  }, []);

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

  const canRun = busyRunner === null && shellCommand.trim().length > 0;

  return (
    <section className="terminal-dock" aria-label={t('terminal.title')}>
      <div
        aria-label="Resize terminal"
        aria-orientation="horizontal"
        className="terminal-resizer"
        onPointerDown={startResize}
        role="separator"
      />
      <div className="terminal-commandbar">
        <label className="terminal-command-input">
          <TerminalSquare aria-hidden="true" size={14} />
          <span className="terminal-cwd">{workingDirectory}</span>
          <span className="terminal-chevron">›</span>
          <input
            aria-label={t('terminal.shellCommand')}
            autoCapitalize="off"
            autoComplete="off"
            onChange={(event) => setShellCommand(event.currentTarget.value)}
            onKeyDown={(event) => {
              if (event.key === 'Enter' && !event.shiftKey && canRun) {
                event.preventDefault();
                void runShell();
              }
            }}
            spellCheck={false}
            value={shellCommand}
          />
        </label>
        <button
          aria-label={t('common.run')}
          className="terminal-icon-button terminal-run"
          disabled={!canRun}
          onClick={() => void runShell()}
          type="button"
        >
          {busyRunner === 'shell' ? <Loader2 className="spin" size={15} /> : <Play size={15} />}
        </button>
        <button
          aria-label={t('common.close')}
          className="terminal-icon-button"
          onClick={onClose}
          type="button"
        >
          <X size={16} />
        </button>
      </div>
      <div className="terminal-view" role="log" aria-live="polite">
        {terminalDisplay.length === 0 ? (
          <div className="terminal-line terminal-system">
            <span className="terminal-prefix">cwd</span>
            <span>{workingDirectory}</span>
          </div>
        ) : (
          terminalDisplay.map((line, index) => (
            <div className={terminalClass(line)} key={`${line}-${index}`}>
              <span className="terminal-prefix">{terminalPrefix(line)}</span>
              <span>{terminalText(line)}</span>
            </div>
          ))
        )}
      </div>
    </section>
  );
}
