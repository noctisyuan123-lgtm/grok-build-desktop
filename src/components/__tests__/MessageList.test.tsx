import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
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
  it('copies every message but only shows Undo on the latest message role', () => {
    const onUndoUser = vi.fn();
    const onUndoAssistant = vi.fn();
    render(
      <VirtuosoMockContext.Provider value={{ viewportHeight: 800, itemHeight: 64 }}>
        <MessageList
          messages={[
            {
              id: 'user-1',
              runId: '',
              role: 'user',
              userText: 'Earlier prompt',
              showUndo: false,
            },
            {
              id: 'assistant-1',
              runId: 'run-1',
              role: 'assistant',
              fallbackText: 'Latest response',
              canUndo: true,
              showUndo: true,
            },
          ]}
          onUndoAssistant={onUndoAssistant}
          onUndoUser={onUndoUser}
        />
      </VirtuosoMockContext.Provider>,
    );

    expect(screen.getByRole('button', { name: 'Copy prompt' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Copy response' })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Undo prompt' })).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Undo response' })).toBeInTheDocument();
  });

  it('shows the prompt Undo control when the latest visible message is a user turn', () => {
    render(
      <VirtuosoMockContext.Provider value={{ viewportHeight: 800, itemHeight: 64 }}>
        <MessageList
          messages={[
            {
              id: 'user-tail',
              runId: '',
              role: 'user',
              userText: 'Prompt tail',
              canUndo: true,
              showUndo: true,
            },
          ]}
          onUndoUser={vi.fn()}
        />
      </VirtuosoMockContext.Provider>,
    );

    expect(screen.getByRole('button', { name: 'Copy prompt' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Undo prompt' })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Undo response' })).not.toBeInTheDocument();
  });

  it('sends an edited prompt with Enter and keeps Shift+Enter for newlines', async () => {
    const user = userEvent.setup();
    const onEditUser = vi.fn();
    render(
      <VirtuosoMockContext.Provider value={{ viewportHeight: 800, itemHeight: 64 }}>
        <MessageList
          messages={[
            {
              id: 'user-edit',
              runId: '',
              role: 'user',
              userText: 'Original prompt',
              canEdit: true,
              showEdit: true,
            },
          ]}
          onEditUser={onEditUser}
        />
      </VirtuosoMockContext.Provider>,
    );

    await user.click(screen.getByRole('button', { name: 'Edit prompt' }));
    const input = screen.getByRole('textbox', { name: 'Edit prompt text' });
    expect(input).toHaveFocus();
    expect((input as HTMLTextAreaElement).selectionStart).toBe('Original prompt'.length);
    expect((input as HTMLTextAreaElement).selectionEnd).toBe('Original prompt'.length);
    await user.click(input);
    expect((input as HTMLTextAreaElement).selectionStart).toBe('Original prompt'.length);
    expect((input as HTMLTextAreaElement).selectionEnd).toBe('Original prompt'.length);
    await user.clear(input);
    await user.type(input, 'first line');
    await user.keyboard('{Shift>}{Enter}{/Shift}');
    await user.type(input, 'second line');

    expect(onEditUser).not.toHaveBeenCalled();
    expect(input).toHaveValue('first line\nsecond line');

    await user.keyboard('{Enter}');
    expect(onEditUser).toHaveBeenCalledWith('user-edit', 'first line\nsecond line');
  });

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

  it('notifies the parent when a sent attachment is clicked', () => {
    const attachment = {
      id: 'image-1',
      name: 'screenshot.png',
      mimeType: 'image/png',
      sizeBytes: 128,
      dataUrl: 'data:image/png;base64,AAAA',
    };
    const onAttachmentClick = vi.fn();

    render(
      <VirtuosoMockContext.Provider value={{ viewportHeight: 800, itemHeight: 64 }}>
        <MessageList
          messages={[
            {
              id: 'user-1',
              runId: '',
              role: 'user',
              userText: 'Review this image',
              attachments: [attachment],
            },
          ]}
          onAttachmentClick={onAttachmentClick}
        />
      </VirtuosoMockContext.Provider>,
    );

    fireEvent.click(screen.getByRole('button', { name: 'Preview screenshot.png' }));
    expect(onAttachmentClick).toHaveBeenCalledWith(attachment);
  });

  it('does not install a polling scroll loop while a response streams', () => {
    const setIntervalSpy = vi.spyOn(window, 'setInterval');
    streamStore.patchRun('run-streaming', { state: 'running', textChars: 12 });
    streamStore.setQueue({ active: 'run-streaming', activeIds: ['run-streaming'], items: [] });

    renderList([
      { id: 'user-1', runId: 'user-1', role: 'user', userText: 'Prompt' },
      { id: 'assistant-1', runId: 'run-streaming', role: 'assistant' },
    ]);

    expect(setIntervalSpy.mock.calls.some(([, delay]) => delay === 180)).toBe(false);
    setIntervalSpy.mockRestore();
  });
});
