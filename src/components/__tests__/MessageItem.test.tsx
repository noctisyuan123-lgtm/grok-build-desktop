import { beforeEach, describe, expect, it } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MessageItem } from '../MessageItem';
import { applyRunEvent, applyStateChange, streamStore } from '../../lib/streamStore';

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
    expect(screen.getByText('Read src/App.tsx')).toBeInTheDocument();
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

  it('uses the live activity line as the empty waiting state without a blank text block', () => {
    applyStateChange('r-waiting', { state: 'Running', startedAt: Date.now() });
    const { container } = render(<MessageItem runId="r-waiting" />);
    expect(screen.getByText('working…')).toBeInTheDocument();
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
