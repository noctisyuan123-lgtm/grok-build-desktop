import { renderHook } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { useAppShortcuts } from '../useAppShortcuts';
import type { Mode } from '../../app/types';

function mount() {
  const focusComposer = vi.fn();
  const handleTabCreate = vi.fn();
  renderHook(() =>
    useAppShortcuts({
      paletteOpen: false,
      setPaletteOpen: vi.fn(),
      sidebarCollapsed: false,
      setSidebarCollapsed: vi.fn(),
      previewOpen: false,
      setPreviewOpen: vi.fn(),
      contextOpen: false,
      setContextOpen: vi.fn(),
      terminalOpen: false,
      setTerminalOpen: vi.fn(),
      toolsOpen: false,
      setToolsOpen: vi.fn(),
      setToolsPageOpen: vi.fn(),
      setSettingsOpen: vi.fn(),
      setInspectorTab: vi.fn(),
      togglePanel: vi.fn(),
      handleTabCreate,
      clearRunHistory: vi.fn(),
      focusComposer,
      stopRun: vi.fn(),
      getActiveRunId: () => null,
      switchMode: vi.fn(),
      busyRunner: null,
      drafts: { standard: '', coding: '' },
      mode: 'coding' as Mode,
    }),
  );
  return { focusComposer, handleTabCreate };
}

describe('composer shortcuts', () => {
  afterEach(() => {
    document.body.replaceChildren();
  });

  it('types slash and cmd-n into the contenteditable instead of stealing them', () => {
    const { focusComposer, handleTabCreate } = mount();
    const field = document.createElement('div');
    field.setAttribute('contenteditable', 'true');
    field.className = 'ProseMirror';
    document.body.appendChild(field);

    field.dispatchEvent(new KeyboardEvent('keydown', { key: '/', bubbles: true }));
    field.dispatchEvent(
      new KeyboardEvent('keydown', { key: 'n', metaKey: true, bubbles: true }),
    );

    expect(focusComposer).not.toHaveBeenCalled();
    expect(handleTabCreate).not.toHaveBeenCalled();
  });

  it('still focuses the composer on slash when nothing is being typed', () => {
    const { focusComposer } = mount();
    window.dispatchEvent(new KeyboardEvent('keydown', { key: '/', bubbles: true }));
    expect(focusComposer).toHaveBeenCalledTimes(1);
  });
});
