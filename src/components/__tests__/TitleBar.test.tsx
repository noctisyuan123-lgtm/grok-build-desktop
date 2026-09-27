import { render } from '@testing-library/react';
import { beforeEach, describe, expect, it } from 'vitest';
import type { ChatMessage } from '../../app/types';
import { applyStateChange, streamStore } from '../../lib/streamStore';
import { TitleBar } from '../TitleBar';
import { LiveRunHud } from '../StatusBar';

beforeEach(() => {
  streamStore.__reset();
});

describe('TitleBar', () => {
  it('does not put live token stats in the titlebar', () => {
    applyStateChange('run-1', { state: 'Running', startedAt: Date.now() });
    const messages: ChatMessage[] = [
      { id: 'u1', role: 'user', content: 'hi', ts: 1 },
      { id: 'a1', role: 'assistant', content: '', ts: 2, runId: 'run-1', status: 'streaming' },
    ];
    render(
      <TitleBar
        messages={messages}
        codingCwd="/tmp"
        anyPanelOpen={false}
        openPanelMenu={() => {}}
        contextUsageOpen={false}
        onContextUsageOpenChange={() => {}}
      />,
    );
    expect(document.querySelector('.window-titlebar .run-status-line')).toBeNull();
  });
});

describe('LiveRunHud', () => {
  it('paints only the activity word on the workspace glass', () => {
    applyStateChange('run-1', { state: 'Running', startedAt: Date.now() });
    const messages: ChatMessage[] = [
      { id: 'u1', role: 'user', content: 'hi', ts: 1 },
      { id: 'a1', role: 'assistant', content: '', ts: 2, runId: 'run-1', status: 'streaming' },
    ];
    render(<LiveRunHud messages={messages} />);
    expect(document.querySelector('.run-status-line.is-hud')).toBeTruthy();
    expect(document.querySelector('.run-status-state')?.textContent).toBe('working…');
    expect(document.querySelector('.run-status-rate')).toBeNull();
    expect(document.body.textContent).not.toMatch(/tok\/s|tokens/);
  });

  it('keeps token metrics in fullscreen', () => {
    applyStateChange('run-1', { state: 'Running', startedAt: Date.now() - 1_000 });
    const messages: ChatMessage[] = [
      { id: 'u1', role: 'user', content: 'hi', ts: 1 },
      { id: 'a1', role: 'assistant', content: '', ts: 2, runId: 'run-1', status: 'streaming' },
    ];
    render(<LiveRunHud messages={messages} showTokenMetrics />);
    expect(document.querySelector('.run-status-line.is-hud')).toBeTruthy();
    expect(document.body.textContent).toMatch(/tokens/);
    expect(document.querySelector('.run-status-state')?.textContent).toBe('working…');
  });

  it('hides when nothing is running', () => {
    const messages: ChatMessage[] = [
      { id: 'a1', role: 'assistant', content: 'done', ts: 2, runId: 'run-done' },
    ];
    render(<LiveRunHud messages={messages} />);
    expect(document.querySelector('.run-status-line')).toBeNull();
  });
});
