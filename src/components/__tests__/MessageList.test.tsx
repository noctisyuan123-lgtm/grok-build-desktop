import { describe, expect, it, beforeEach } from 'vitest';
import { render } from '@testing-library/react';
import { VirtuosoMockContext } from 'react-virtuoso';
import { MessageList, type MessageRef } from '../MessageList';
import { streamStore } from '../../lib/streamStore';

beforeEach(() => {
  streamStore.__reset();
});

function renderList(messages: MessageRef[]) {
  return render(
    <VirtuosoMockContext.Provider value={{ viewportHeight: 800, itemHeight: 64 }}>
      <MessageList messages={messages} />
    </VirtuosoMockContext.Provider>,
  );
}

describe('MessageList session isolation', () => {
  it('keys Virtuoso rows by stable message id so session switches do not reuse the wrong run', () => {
    streamStore.patchRun('run-a', {
      state: 'running',
      text: 'Reply from session A',
      textChars: 20,
    });
    streamStore.setQueue({ active: 'run-a', activeIds: ['run-a'], items: [] });

    const sessionA: MessageRef[] = [
      { id: 'u-a', runId: 'user-a', role: 'user', userText: 'Prompt A' },
      { id: 'a-a', runId: 'run-a', role: 'assistant', autoExpandWork: true },
    ];
    const sessionB: MessageRef[] = [
      { id: 'u-b', runId: 'user-b', role: 'user', userText: 'Prompt B' },
      { id: 'a-b', runId: 'run-b', role: 'assistant', fallbackText: '' },
    ];

    const { rerender, container } = renderList(sessionA);
    expect(container.querySelector('[data-message-id="a-a"]')).toBeInTheDocument();

    // Replace the whole transcript (as switchToSession does). Index-based
    // keys would keep MessageItem for run-a mounted under the new row.
    rerender(
      <VirtuosoMockContext.Provider value={{ viewportHeight: 800, itemHeight: 64 }}>
        <MessageList messages={sessionB} />
      </VirtuosoMockContext.Provider>,
    );

    expect(container.querySelector('[data-message-id="a-b"]')).toBeInTheDocument();
    expect(container.querySelector('[data-message-id="a-a"]')).not.toBeInTheDocument();
    // Live text from the other session's active run must not appear here.
    expect(container.textContent).not.toContain('Reply from session A');
    expect(container.textContent).toContain('Prompt B');
  });
});
