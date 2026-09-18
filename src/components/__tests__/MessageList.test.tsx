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

  it('loads the prompt into the composer instead of an in-bubble editor', async () => {
    const user = userEvent.setup();
    const onEditUser = vi.fn();
    const { container } = render(
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
          editingUserId="user-edit"
        />
      </VirtuosoMockContext.Provider>,
    );

    await user.click(screen.getByRole('button', { name: 'Edit prompt' }));
    expect(onEditUser).toHaveBeenCalledWith('user-edit', 'Original prompt');
    expect(screen.queryByRole('textbox', { name: 'Edit prompt text' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Send edit' })).not.toBeInTheDocument();
    expect(screen.getByText('Original prompt')).toBeInTheDocument();
    expect(container.querySelector('.message-user.is-editing')).toBeInTheDocument();
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

  it('renders a video thumb and an image together without a full-width file-only chip', () => {
    const longName =
      '2026-07-22 18-59-09_VibeCoding大赏 _ 如果降....#数据可视化 #粒子特效_video.mp4';
    const video = {
      id: 'video-1',
      name: longName,
      mimeType: 'video/mp4',
      sizeBytes: 4096,
      dataUrl: 'data:video/mp4;base64,AAAA',
    };
    const image = {
      id: 'image-1',
      name: 'frame.png',
      mimeType: 'image/png',
      sizeBytes: 128,
      dataUrl: 'data:image/png;base64,BBBB',
    };
    const onAttachmentClick = vi.fn();

    const { container } = render(
      <VirtuosoMockContext.Provider value={{ viewportHeight: 800, itemHeight: 64 }}>
        <MessageList
          messages={[
            {
              id: 'user-mix',
              runId: '',
              role: 'user',
              userText: 'Both files',
              attachments: [video, image],
            },
          ]}
          onAttachmentClick={onAttachmentClick}
        />
      </VirtuosoMockContext.Provider>,
    );

    const videoEl = container.querySelector(
      'video.message-attachment-video',
    ) as HTMLVideoElement | null;
    const imageEl = container.querySelector('img.message-attachment-image');
    expect(videoEl).toBeTruthy();
    expect(imageEl).toBeTruthy();
    expect(videoEl?.muted).toBe(true);
    expect(videoEl?.getAttribute('preload')).toBe('metadata');
    expect(videoEl?.controls).toBe(false);

    const videoChip = screen.getByRole('button', { name: `Preview ${longName}` });
    expect(videoChip.querySelector(':scope > .message-attachment-file:only-child')).toBeNull();
    expect(videoChip.querySelector('.message-attachment-name')).toHaveTextContent(longName);
    expect(videoChip).toHaveClass('is-video');

    fireEvent.click(videoChip);
    expect(onAttachmentClick).toHaveBeenCalledWith(video);
  });

  it('hides Continue on a disconnected turn once a follow-up assistant is live', () => {
    streamStore.patchRun('run-lost', {
      state: 'failed',
      error: 'ECONNRESET',
      text: 'half a reply',
      textChars: 12,
      startedAt: 1,
      endedAt: 2,
    });
    streamStore.patchRun('run-continue', {
      state: 'running',
      startedAt: Date.now(),
    });

    renderList([
      { id: 'user-1', runId: 'user-1', role: 'user', userText: 'Prompt' },
      {
        id: 'assistant-lost',
        runId: 'run-lost',
        role: 'assistant',
        fallbackText: 'half a reply',
      },
      { id: 'assistant-continue', runId: 'run-continue', role: 'assistant' },
    ]);

    expect(
      screen.queryByText('Connection lost mid-response. The text above may be incomplete.'),
    ).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Continue' })).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: /Working for/ })).toBeInTheDocument();
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

  it('shows the jump control after a history jump', () => {
    render(
      <VirtuosoMockContext.Provider value={{ viewportHeight: 800, itemHeight: 64 }}>
        <MessageList
          messages={[
            { id: 'user-1', runId: '', role: 'user', userText: 'First' },
            { id: 'user-2', runId: '', role: 'user', userText: 'Second' },
          ]}
          focusId="user-1"
          focusNonce={1}
        />
      </VirtuosoMockContext.Provider>,
    );
    expect(screen.getByRole('button', { name: 'Scroll to bottom' })).toBeInTheDocument();
  });

  it('pins the conversation scroller immediately when the jump control is clicked', () => {
    render(
      <VirtuosoMockContext.Provider value={{ viewportHeight: 800, itemHeight: 64 }}>
        <MessageList
          messages={[
            { id: 'user-1', runId: '', role: 'user', userText: 'First' },
            { id: 'user-2', runId: '', role: 'user', userText: 'Second' },
          ]}
          focusId="user-1"
          focusNonce={1}
        />
      </VirtuosoMockContext.Provider>,
    );
    const scroller = document.querySelector('[data-virtuoso-scroller]') as HTMLElement | null;
    expect(scroller).toBeInstanceOf(HTMLElement);
    Object.defineProperty(scroller!, 'scrollHeight', { configurable: true, value: 2400 });
    Object.defineProperty(scroller!, 'clientHeight', { configurable: true, value: 400 });
    scroller!.scrollTop = 120;
    fireEvent.click(screen.getByRole('button', { name: 'Scroll to bottom' }));
    expect(scroller!.scrollTop).toBe(2000);
    expect(screen.queryByRole('button', { name: 'Scroll to bottom' })).not.toBeInTheDocument();
  });
});

describe('MessageList user prompt markdown', () => {
  it('renders user prompts through the same sanitized markdown path as assistants', () => {
    delete (window as unknown as Record<string, unknown>).__pwned;
    streamStore.setHtml(
      'user:user-md',
      '<p>hello <strong>world</strong></p>' +
        '<script>window.__pwned = 1</script>' +
        '<a href="javascript:window.__pwned=1">x</a>',
    );
    const { container } = render(
      <VirtuosoMockContext.Provider value={{ viewportHeight: 800, itemHeight: 64 }}>
        <MessageList
          messages={[
            {
              id: 'user-md',
              runId: '',
              role: 'user',
              userText: 'hello **world**',
            },
          ]}
        />
      </VirtuosoMockContext.Provider>,
    );

    const body = container.querySelector('.message-user .message-body.markdown-body');
    expect(body).toBeTruthy();
    expect(body).toHaveTextContent('hello world');
    expect(body?.querySelector('strong')).toHaveTextContent('world');
    expect(container.querySelector('script')).toBeNull();
    const link = container.querySelector('.message-user a');
    expect(link?.getAttribute('href') ?? '').not.toContain('javascript:');
    expect((window as unknown as Record<string, unknown>).__pwned).toBeUndefined();
    // Actions still bind to the raw source text (edit/copy/undo unchanged).
    expect(screen.getByRole('button', { name: 'Copy prompt' })).toBeInTheDocument();
  });

  it('falls back to plain text until the markdown worker result arrives', () => {
    const { container } = render(
      <VirtuosoMockContext.Provider value={{ viewportHeight: 800, itemHeight: 64 }}>
        <MessageList
          messages={[
            {
              id: 'user-plain',
              runId: '',
              role: 'user',
              userText: 'plain **until** parsed',
            },
          ]}
        />
      </VirtuosoMockContext.Provider>,
    );
    expect(
      container.querySelector('.message-user pre.message-body.streaming-raw'),
    ).toHaveTextContent('plain **until** parsed');
  });
});
