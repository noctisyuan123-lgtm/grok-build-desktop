// Shared vitest setup: jest-dom matchers, DOM cleanup, Tauri IPC mock reset,
// and a clean localStorage between tests so persisted-state hooks can't leak
// state across cases.
import '@testing-library/jest-dom/vitest';
import { afterEach, vi } from 'vitest';
import { cleanup } from '@testing-library/react';
import { clearMocks } from '@tauri-apps/api/mocks';

vi.mock('@xterm/addon-fit', () => ({
  FitAddon: class {
    activate() {}
    dispose() {}
    fit() {}
  },
}));

vi.mock('@xterm/xterm', () => ({
  Terminal: class {
    cols = 80;
    rows = 24;
    options: Record<string, unknown> = {};
    private dataListeners = new Set<(data: string) => void>();
    private host: HTMLElement | null = null;
    private input: HTMLTextAreaElement | null = null;

    constructor(options: Record<string, unknown>) {
      this.options = { ...options };
    }

    loadAddon(addon: { activate?: (terminal: unknown) => void }) {
      addon.activate?.(this);
    }

    open(host: HTMLElement) {
      this.host = host;
      this.input = document.createElement('textarea');
      this.input.setAttribute('aria-label', 'Terminal input');
      this.input.addEventListener('input', () => {
        const data = this.input?.value ?? '';
        this.input!.value = '';
        this.dataListeners.forEach((listener) => listener(data));
      });
      this.input.addEventListener('keydown', (event) => {
        if (event.key === 'Enter') this.dataListeners.forEach((listener) => listener('\r'));
        if (event.key === 'ArrowUp') this.dataListeners.forEach((listener) => listener('\u001b[A'));
      });
      host.appendChild(this.input);
    }

    onData(listener: (data: string) => void) {
      this.dataListeners.add(listener);
      return { dispose: () => this.dataListeners.delete(listener) };
    }

    onResize() {
      return { dispose() {} };
    }

    focus() {
      this.input?.focus();
    }

    write(data: string | Uint8Array) {
      const text = typeof data === 'string' ? data : new TextDecoder().decode(data);
      this.host?.append(document.createTextNode(text));
    }

    writeln(data: string) {
      this.host?.append(document.createTextNode(`${data}\n`));
    }

    dispose() {
      this.host?.replaceChildren();
      this.dataListeners.clear();
    }
  },
}));

afterEach(() => {
  cleanup();
  clearMocks();
  window.localStorage.clear();
});
