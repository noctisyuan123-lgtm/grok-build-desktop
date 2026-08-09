import { beforeEach, describe, expect, it } from 'vitest';
import { act, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MessageItem } from '../MessageItem';
import { applyRunEvent, applyStateChange, streamStore } from '../../lib/streamStore';
import { renderMarkdown } from '../../lib/markdown';

beforeEach(() => {
  streamStore.__reset();
  delete (window as unknown as Record<string, unknown>).__pwned;
});

describe('MessageItem sanitization', () => {
  it('renders hostile worker HTML without scripts, handlers, or javascript: URLs', () => {
    applyRunEvent('r1', { type: 'text', data: 'hi' });
    applyRunEvent('r1', { type: 'end', stopReason: 'EndTurn', sessionId: 's', requestId: 'q' });
    streamStore.setHtml(
      'r1',
      '<p>hello</p>' +
        '<script>window.__pwned = 1;</script>' +
        '<img src="x" onerror="window.__pwned = 1" alt="evil">' +
        '<a href="javascript:window.__pwned=1">click</a>' +
        '<iframe src="https://evil.example"></iframe>',
    );

    const { container } = render(<MessageItem runId="r1" />);

    expect(screen.getByText('hello')).toBeInTheDocument();
    expect(container.querySelector('script')).toBeNull();
    expect(container.querySelector('iframe')).toBeNull();
    expect(container.querySelector('img')?.getAttribute('onerror')).toBeNull();
    const link = container.querySelector('a');
    expect(link?.getAttribute('href') ?? '').not.toContain('javascript:');
    expect((window as unknown as Record<string, unknown>).__pwned).toBeUndefined();
  });

  it('sanitizes restored-message HTML on the no-snapshot path too', () => {
    streamStore.setHtml('msg:m1', '<em>legacy</em><script>window.__pwned=2</script>');
    const { container } = render(<MessageItem runId="msg:m1" fallbackText="legacy" />);
    expect(screen.getByText('legacy')).toBeInTheDocument();
    expect(container.querySelector('script')).toBeNull();
    expect((window as unknown as Record<string, unknown>).__pwned).toBeUndefined();
  });

  it('copies a fenced code block through the VS Code preview control', async () => {
    const user = userEvent.setup();
    applyRunEvent('copy-code', { type: 'text', data: 'code' });
    streamStore.setHtml('copy-code', renderMarkdown('```sh\necho ok\n```'));
    render(<MessageItem runId="copy-code" />);

    await user.click(screen.getByRole('button', { name: 'Copy code block' }));

    await expect(navigator.clipboard.readText()).resolves.toBe('echo ok\n');
    expect(screen.getByRole('button', { name: 'Copied' })).toHaveClass('copied');
  });
});

describe('MessageItem rendering states', () => {
  it('shows persisted worked time only when duration metadata exists', () => {
    const { rerender } = render(
      <MessageItem runId="msg:timed" fallbackText="finished" durationMs={359_000} />,
    );
    expect(screen.getByLabelText('Worked for 5m 59s')).toBeInTheDocument();

    rerender(<MessageItem runId="msg:untimed" fallbackText="legacy" />);
    expect(screen.queryByText(/Worked for/)).toBeNull();
  });

  it('does not draw a fake disclosure arrow when no activity detail exists', () => {
    render(<MessageItem runId="msg:quiet" fallbackText="done" durationMs={19_000} />);
    expect(screen.getByLabelText('Worked for 19s')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Worked for 19s' })).toBeNull();
  });

  it('expands persisted activity from the Worked disclosure after restart', async () => {
    const user = userEvent.setup();
    render(
      <MessageItem
        runId="msg:tools"
        fallbackText="done"
        durationMs={19_000}
        fallbackTraces={[
          {
            key: 'tool:1',
            kind: 'tool',
            label: 'Read src/App.tsx',
            status: 'done',
            startedAt: 1_000,
            endedAt: 2_000,
          },
        ]}
      />,
    );
    const disclosure = screen.getByRole('button', { name: 'Worked for 19s' });
    expect(disclosure).toHaveAttribute('aria-expanded', 'false');
    expect(screen.queryByText('Read src/App.tsx')).toBeNull();
    await user.click(disclosure);
    expect(disclosure).toHaveAttribute('aria-expanded', 'true');
    await user.click(screen.getByRole('button', { name: 'Read 1 file' }));
    expect(screen.getByText('Read src/App.tsx')).toBeInTheDocument();
  });

  it('keeps Thought, Respond, Tool, Respond in transcript order', async () => {
    const user = userEvent.setup();
    const { container } = render(
      <MessageItem
        runId="msg:ordered"
        durationMs={4_000}
        fallbackText="Final answer"
        fallbackTranscript={[
          {
            key: 'thought:0',
            kind: 'thought',
            text: 'I should inspect it.',
            startedAt: 1_000,
            endedAt: 2_000,
          },
          { key: 'response:1', kind: 'response', text: "I'll inspect it." },
          { key: 'tools:2', kind: 'tools', traceKeys: ['tool:read'] },
          { key: 'response:3', kind: 'response', text: 'Final answer' },
        ]}
        fallbackTraces={[
          {
            key: 'tool:read',
            kind: 'tool',
            label: 'Read src/App.tsx',
            status: 'done',
            startedAt: 2_000,
            endedAt: 3_000,
          },
        ]}
      />,
    );
    expect(screen.getByText('Final answer')).toBeInTheDocument();
    expect(screen.queryByText("I'll inspect it.")).toBeNull();
    await user.click(screen.getByRole('button', { name: 'Worked for 4s' }));
    const thought = screen.getByRole('button', { name: 'Thought for 1s' });
    expect(thought).toBeInTheDocument();
    expect(screen.getByText("I'll inspect it.")).toBeInTheDocument();
    const thoughtNode = container.querySelector('.transcript-thought');
    const responseNode = container.querySelector('.transcript-response');
    expect(thoughtNode).not.toBeNull();
    expect(responseNode).not.toBeNull();
    expect(
      thoughtNode!.compareDocumentPosition(responseNode!) & Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy();
  });

  it('keeps the just-generated turn open but resets a different historical run to collapsed', async () => {
    applyStateChange('live-turn', { state: 'Running', startedAt: Date.now() });
    applyRunEvent('live-turn', { type: 'thought', data: 'checking' });
    const { rerender } = render(<MessageItem runId="live-turn" autoExpandWork />);
    const liveWork = screen.getByRole('button', { name: /Working for/ });
    expect(liveWork).toHaveAttribute('aria-expanded', 'true');

    await act(async () => {
      applyRunEvent('live-turn', {
        type: 'end',
        stopReason: 'EndTurn',
        sessionId: 'session',
        requestId: 'request',
      });
    });
    expect(screen.getByRole('button', { name: /Worked for/ })).toHaveAttribute(
      'aria-expanded',
      'true',
    );

    rerender(
      <MessageItem
        runId="historical-turn"
        durationMs={2_000}
        fallbackText="done"
        fallbackTranscript={[
          {
            key: 'thought:0',
            kind: 'thought',
            text: 'old thought',
            startedAt: 1_000,
            endedAt: 2_000,
          },
          { key: 'response:1', kind: 'response', text: 'done' },
        ]}
      />,
    );
    expect(screen.getByRole('button', { name: 'Worked for 2s' })).toHaveAttribute(
      'aria-expanded',
      'false',
    );
  });

  it('does not auto-open a stale live snapshot restored during app startup', () => {
    applyStateChange('stale-live', { state: 'Running', startedAt: Date.now() - 60_000 });
    applyRunEvent('stale-live', { type: 'thought', data: 'old thought' });
    render(<MessageItem runId="stale-live" />);
    expect(screen.getByRole('button', { name: /Working for/ })).toHaveAttribute(
      'aria-expanded',
      'false',
    );
  });

  it('uses completed snapshot timestamps and hides worked time while running', () => {
    applyStateChange('r-timed', { state: 'Running', startedAt: 1_000 });
    const { rerender } = render(<MessageItem runId="r-timed" />);
    expect(screen.queryByText(/Worked for/)).toBeNull();

    applyStateChange('r-timed', { state: 'Done', endedAt: 360_000 });
    rerender(<MessageItem runId="r-timed" />);
    expect(screen.getByLabelText('Worked for 5m 59s')).toBeInTheDocument();
  });

  it('renders plain fallback text for a restored message with no snapshot or HTML', () => {
    const { container } = render(<MessageItem runId="msg:m2" fallbackText="raw restored text" />);
    const pre = container.querySelector('pre.message-body');
    expect(pre).toHaveTextContent('raw restored text');
  });

  it('renders nothing without a snapshot, html, or fallback', () => {
    const { container } = render(<MessageItem runId="msg:m3" />);
    expect(container).toBeEmptyDOMElement();
  });

  it('renders raw text only until the first streaming markdown result arrives', () => {
    applyRunEvent('r2', { type: 'text', data: 'streaming toke' });
    const { container } = render(<MessageItem runId="r2" />);
    expect(container.querySelector('pre.streaming-raw')).toHaveTextContent('streaming toke');
    expect(container.querySelector('.stream-caret')).toBeNull();
  });

  it('uses a quiet starting state without a placeholder timer or blank text block', () => {
    applyStateChange('r-waiting', { state: 'Running', startedAt: Date.now() });
    const { container } = render(<MessageItem runId="r-waiting" />);
    expect(screen.getByText('Starting…')).toBeInTheDocument();
    expect(screen.queryByText(/0(?:\.0)?s/)).toBeNull();
    expect(container.querySelector('pre.streaming-raw')).toBeNull();
    expect(container.querySelector('.stream-caret')).toBeNull();
  });

  it('renders parsed markdown while the run is still streaming', () => {
    applyRunEvent('r3', { type: 'text', data: '# heading' });
    streamStore.setHtml('r3', '<h1>heading</h1>');
    const { container } = render(<MessageItem runId="r3" />);
    expect(container.querySelector('h1')).toHaveTextContent('heading');
    expect(container.querySelector('pre.streaming-raw')).toBeNull();
    expect(container.querySelector('.markdown-streaming')).toBeInTheDocument();
  });

  it('announces a failed run in the message area', () => {
    applyStateChange('r4', { state: 'Failed', error: 'exit code 2' });
    render(<MessageItem runId="r4" />);
    expect(screen.getByRole('alert')).toHaveTextContent('Run failed: exit code 2');
  });

  it('marks a cancelled run as stopped by the user', () => {
    applyRunEvent('r5', { type: 'text', data: 'partial' });
    applyStateChange('r5', { state: 'Cancelled' });
    render(<MessageItem runId="r5" />);
    expect(screen.getByText('Stopped by you.')).toBeInTheDocument();
  });
});
