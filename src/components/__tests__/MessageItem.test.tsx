import { beforeEach, describe, expect, it } from 'vitest';
import { act, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MessageItem } from '../MessageItem';
import {
  applyRunEvent,
  applyStateChange,
  exteriorMarkdownKey,
  streamStore,
} from '../../lib/streamStore';
import { renderMarkdown } from '../../lib/markdown';

beforeEach(() => {
  streamStore.__reset();
  delete (window as unknown as Record<string, unknown>).__pwned;
});

describe('MessageItem sanitization', () => {
  it('renders hostile worker HTML without scripts, handlers, or javascript: URLs', () => {
    applyRunEvent('r1', { type: 'text', data: 'hi' });
    applyRunEvent('r1', { type: 'end', stopReason: 'EndTurn', sessionId: 's', requestId: 'q' });
    // Exterior final reads the trailing-response markdown key, not bare runId.
    streamStore.setHtml(
      exteriorMarkdownKey('r1', 0),
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

  it('re-parses restored HTML when live-imported fallback text grows', async () => {
    streamStore.setHtml('msg:partial', '<p>first paragraph</p>');
    const view = render(
      <MessageItem runId="msg:partial" fallbackText="first paragraph" />,
    );
    expect(screen.getByText('first paragraph')).toBeInTheDocument();
    streamStore.setHtml('msg:partial', '<p>first paragraph</p><p>rest after tools</p>');
    view.rerender(
      <MessageItem
        runId="msg:partial"
        fallbackText="first paragraph\n\nrest after tools"
      />,
    );
    await act(async () => {
      await Promise.resolve();
    });
    expect(screen.getByText(/rest after tools/)).toBeInTheDocument();
  });

  it('copies a fenced code block through the VS Code preview control', async () => {
    const user = userEvent.setup();
    applyRunEvent('copy-code', { type: 'text', data: 'code' });
    streamStore.setHtml(
      exteriorMarkdownKey('copy-code', 0),
      renderMarkdown('```sh\necho ok\n```'),
    );
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
    // Thought + mid-respond phase: one summary (not a nested Thought wrapper).
    expect(screen.queryByRole('button', { name: /^Thought$/ })).toBeNull();
    const thought = screen.getByRole('button', { name: 'Thought for 1s · Responded' });
    expect(screen.queryByText("I'll inspect it.")).toBeNull();
    await user.click(thought);
    expect(screen.getByText('I should inspect it.')).toBeInTheDocument();
    expect(screen.getByText("I'll inspect it.")).toBeInTheDocument();
    // Still only one phase disclosure after expand.
    expect(screen.getAllByRole('button', { name: 'Thought for 1s · Responded' })).toHaveLength(1);
    const thoughtNode = container.querySelector('.transcript-thought');
    const responseNode = container.querySelector('.transcript-response');
    expect(thoughtNode).not.toBeNull();
    expect(responseNode).not.toBeNull();
    expect(
      thoughtNode!.compareDocumentPosition(responseNode!) & Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy();
  });

  it('folds a closed workflow phase above an intermediate response', async () => {
    const user = userEvent.setup();
    const { container } = render(
      <MessageItem
        runId="msg:phase-fold"
        durationMs={8_000}
        fallbackText="Final answer"
        fallbackTranscript={[
          {
            key: 'thought:0',
            kind: 'thought',
            text: 'First look.',
            startedAt: 1_000,
            endedAt: 2_000,
          },
          { key: 'tools:1', kind: 'tools', traceKeys: ['tool:read', 'tool:search'] },
          {
            key: 'thought:2',
            kind: 'thought',
            text: 'Then reconsider.',
            startedAt: 3_000,
            endedAt: 4_000,
          },
          { key: 'response:3', kind: 'response', text: 'I will inspect next.' },
          { key: 'tools:4', kind: 'tools', traceKeys: ['tool:write'] },
          { key: 'response:5', kind: 'response', text: 'Final answer' },
        ]}
        fallbackTraces={[
          {
            key: 'tool:read',
            kind: 'tool',
            label: 'Read src/App.tsx',
            status: 'done',
            startedAt: 2_000,
            endedAt: 2_500,
          },
          {
            key: 'tool:search',
            kind: 'tool',
            label: 'Search MessageItem',
            status: 'done',
            startedAt: 2_500,
            endedAt: 3_000,
          },
          {
            key: 'tool:write',
            kind: 'tool',
            label: 'Record usage',
            status: 'done',
            startedAt: 5_000,
            endedAt: 6_000,
          },
        ]}
      />,
    );

    const external = container.querySelector('.markdown-streaming');
    expect(external).toHaveTextContent('Final answer');
    expect(container.querySelector('.transcript-work')?.contains(external)).toBe(false);

    await user.click(screen.getByRole('button', { name: 'Worked for 8s' }));

    // First phase collapses into one factual summary; its intermediate response
    // is folded into the same disclosure rather than sitting beside it.
    const phaseSummary = screen.getByRole('button', { name: 'Thought and used 2 tools' });
    expect(phaseSummary).toHaveAttribute('aria-expanded', 'false');
    expect(screen.queryByText('I will inspect next.')).toBeNull();
    expect(screen.queryByRole('button', { name: 'Thought for 1s' })).toBeNull();
    expect(screen.queryByText('First look.')).toBeNull();
    expect(screen.queryByText('Read src/App.tsx')).toBeNull();

    // Open phase after the intermediate response stays visible (not folded).
    expect(screen.getByText('Used 1 tool')).toBeInTheDocument();

    await user.click(phaseSummary);
    expect(phaseSummary).toHaveAttribute('aria-expanded', 'true');
    expect(screen.getByText('I will inspect next.')).toBeInTheDocument();
    // Each underlying thought/tool once — no nested "Read 1 file" group under
    // the phase summary (embedded tool rows).
    const thoughtButtons = screen.getAllByRole('button', { name: 'Thought for 1s' });
    expect(thoughtButtons).toHaveLength(2);
    expect(screen.queryByRole('button', { name: /Read 1 file, searched 1 time/i })).toBeNull();
    expect(screen.getByText('Read src/App.tsx')).toBeInTheDocument();
    expect(screen.getByText('Search MessageItem')).toBeInTheDocument();

    const thoughtNode = container.querySelector('.transcript-thought');
    const responseNode = container.querySelector('.transcript-response');
    expect(thoughtNode).not.toBeNull();
    expect(responseNode).not.toBeNull();
    expect(
      thoughtNode!.compareDocumentPosition(responseNode!) & Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy();
  });

  it('folds initial thoughts as soon as the first intermediate response exists', async () => {
    const user = userEvent.setup();
    render(
      <MessageItem
        runId="msg:initial-thought-fold"
        durationMs={3_000}
        fallbackText="Final answer"
        fallbackTranscript={[
          {
            key: 'thought:0',
            kind: 'thought',
            text: 'Opening look.',
            startedAt: 1_000,
            endedAt: 2_000,
          },
          { key: 'response:1', kind: 'response', text: 'I will dig deeper.' },
          { key: 'response:2', kind: 'response', text: 'Final answer' },
        ]}
      />,
    );

    await user.click(screen.getByRole('button', { name: 'Worked for 3s' }));
    // Single thought + mid-respond — one "… · Responded" row, not nested Thought.
    expect(screen.queryByRole('button', { name: /^Thought$/ })).toBeNull();
    expect(screen.getByRole('button', { name: 'Thought for 1s · Responded' })).toBeInTheDocument();
    expect(screen.queryByText('I will dig deeper.')).toBeNull();
    await user.click(screen.getByRole('button', { name: 'Thought for 1s · Responded' }));
    expect(screen.getByText('Opening look.')).toBeInTheDocument();
    expect(screen.getByText('I will dig deeper.')).toBeInTheDocument();
  });

  it('also folds the first thought when the first response is the final response', async () => {
    const user = userEvent.setup();
    render(
      <MessageItem
        runId="msg:first-thought-before-final"
        durationMs={2_000}
        fallbackText="Final answer"
        fallbackTranscript={[
          {
            key: 'thought:0',
            kind: 'thought',
            text: 'Check the premise.',
            startedAt: 1_000,
            endedAt: 2_000,
          },
          { key: 'response:1', kind: 'response', text: 'Final answer' },
        ]}
      />,
    );

    await user.click(screen.getByRole('button', { name: 'Worked for 2s' }));
    expect(screen.queryByRole('button', { name: /^Thought$/ })).toBeNull();
    const thought = screen.getByRole('button', { name: 'Thought for 1s' });
    expect(thought).toBeInTheDocument();
    expect(screen.queryByText('Check the premise.')).toBeNull();
    await user.click(thought);
    expect(screen.getByText('Check the premise.')).toBeInTheDocument();
    expect(screen.getAllByText('Final answer')).toHaveLength(1);
  });

  it('keeps a closed intermediate response visible while later tools are still running', async () => {
    applyStateChange('live-after-intermediate', { state: 'Running', startedAt: Date.now() });
    render(
      <MessageItem
        runId="live-after-intermediate"
        autoExpandWork
        fallbackTranscript={[
          {
            key: 'thought:0',
            kind: 'thought',
            text: 'First look.',
            startedAt: 1_000,
            endedAt: 2_000,
          },
          { key: 'response:1', kind: 'response', text: "I'll inspect next." },
          { key: 'tools:2', kind: 'tools', traceKeys: ['tool:read'] },
        ]}
        fallbackTraces={[
          {
            key: 'tool:read',
            kind: 'tool',
            label: 'Read src/App.tsx',
            status: 'running',
            startedAt: 2_500,
            endedAt: null,
          },
        ]}
      />,
    );

    // Process before the mid-respond folds; the mid-respond itself stays
    // independently readable (not nested under thought). Later tools continue.
    expect(screen.getByRole('button', { name: 'Thought for 1s' })).toBeInTheDocument();
    expect(screen.queryByText('First look.')).toBeNull();
    expect(screen.getByText("I'll inspect next.")).toBeInTheDocument();
    expect(screen.getByText('Read src/App.tsx')).toBeInTheDocument();
  });

  it('folds thought/tools between intermediate responds while the mid-respond stays readable (live)', async () => {
    applyStateChange('live-phase-between-responds', { state: 'Running', startedAt: Date.now() });
    render(
      <MessageItem
        runId="live-phase-between-responds"
        autoExpandWork
        fallbackTranscript={[
          {
            key: 'thought:0',
            kind: 'thought',
            text: 'First look.',
            startedAt: 1_000,
            endedAt: 1_500,
          },
          { key: 'tools:1', kind: 'tools', traceKeys: ['tool:read', 'tool:search'] },
          {
            key: 'thought:2',
            kind: 'thought',
            text: 'Then reconsider.',
            startedAt: 2_000,
            endedAt: 2_500,
          },
          { key: 'response:3', kind: 'response', text: 'I will inspect next.' },
          { key: 'tools:4', kind: 'tools', traceKeys: ['tool:write'] },
        ]}
        fallbackTraces={[
          {
            key: 'tool:read',
            kind: 'tool',
            label: 'Read src/App.tsx',
            status: 'done',
            startedAt: 1_500,
            endedAt: 1_800,
          },
          {
            key: 'tool:search',
            kind: 'tool',
            label: 'Search MessageItem',
            status: 'done',
            startedAt: 1_800,
            endedAt: 2_000,
          },
          {
            key: 'tool:write',
            kind: 'tool',
            label: 'Record usage',
            status: 'running',
            startedAt: 3_000,
            endedAt: null,
          },
        ]}
      />,
    );

    // Closed phase process is one summary; mid-respond is outside that summary.
    const phaseSummary = screen.getByRole('button', { name: 'Thought and used 2 tools' });
    expect(phaseSummary).toHaveAttribute('aria-expanded', 'false');
    expect(screen.queryByText('First look.')).toBeNull();
    expect(screen.queryByText('Read src/App.tsx')).toBeNull();
    expect(screen.getByText('I will inspect next.')).toBeInTheDocument();
    // Open tools after the mid-respond stay live.
    expect(screen.getByText('Record usage')).toBeInTheDocument();

    await userEvent.setup().click(phaseSummary);
    // Embedded tool rows appear; thought bodies stay behind nested Thought rows.
    expect(screen.getByText('Read src/App.tsx')).toBeInTheDocument();
    expect(screen.getByText('Search MessageItem')).toBeInTheDocument();
    expect(screen.getAllByRole('button', { name: 'Thought for 1s' })).toHaveLength(2);
    // Mid-respond stays a sibling of the process pack, never a thought child.
    expect(screen.getByText('I will inspect next.').closest('.transcript-thought')).toBeNull();
    expect(screen.getByText('I will inspect next.').closest('.transcript-phase-body')).toBeNull();
  });

  it('does not paint mid-respond text into the exterior final via runId html cache', async () => {
    const user = userEvent.setup();
    // streamStore / markdown worker keys full accumulated text under bare runId.
    // Exterior final must use a separate cache key so polluted run html cannot
    // re-surface intermediate responds below Worked for.
    streamStore.setHtml(
      'msg:mid-as-final',
      '<p>快速复核 weclaw 现状。能用 weclaw，但半残。</p>',
    );
    const { container } = render(
      <MessageItem
        runId="msg:mid-as-final"
        durationMs={20_000}
        fallbackText="快速复核 weclaw 现状。能用 weclaw，但半残。"
        fallbackTranscript={[
          {
            key: 'thought:0',
            kind: 'thought',
            text: 'The user is asking about weclaw.',
            startedAt: 1_000,
            endedAt: 1_200,
          },
          { key: 'response:1', kind: 'response', text: '快速复核 weclaw 现状。' },
          { key: 'tools:2', kind: 'tools', traceKeys: ['tool:1'] },
          {
            key: 'thought:3',
            kind: 'thought',
            text: 'Confirm residual issues.',
            startedAt: 3_000,
            endedAt: 3_400,
          },
          { key: 'response:4', kind: 'response', text: '能用 weclaw，但半残。' },
        ]}
        fallbackTraces={[
          {
            key: 'tool:1',
            kind: 'tool',
            label: 'Read weclaw notes',
            status: 'done',
            startedAt: 2_000,
            endedAt: 2_500,
          },
        ]}
      />,
    );

    const exterior = container.querySelector('.markdown-streaming');
    expect(exterior).toHaveTextContent('能用 weclaw，但半残。');
    expect(exterior).not.toHaveTextContent('快速复核');
    // Mid stays under Work for until expanded — not duplicated outside.
    expect(screen.queryByText('快速复核 weclaw 现状。')).toBeNull();

    await user.click(screen.getByRole('button', { name: 'Worked for 20s' }));
    await user.click(screen.getByRole('button', { name: 'Thought briefly · Responded' }));
    expect(screen.getByText('快速复核 weclaw 现状。')).toBeInTheDocument();
    // Still only one exterior final, and it did not grow mid text.
    expect(container.querySelector('.markdown-streaming')).toHaveTextContent('能用 weclaw，但半残。');
    expect(container.querySelector('.markdown-streaming')).not.toHaveTextContent('快速复核');
  });

  it('keeps a folded intermediate response as a sibling of thought content', async () => {
    const user = userEvent.setup();
    render(
      <MessageItem
        runId="msg:response-sibling"
        durationMs={3_000}
        fallbackText="Final answer"
        fallbackTranscript={[
          {
            key: 'thought:0',
            kind: 'thought',
            text: 'Inspect first.',
            startedAt: 1_000,
            endedAt: 2_000,
          },
          { key: 'response:1', kind: 'response', text: 'I will inspect next.' },
          { key: 'tools:2', kind: 'tools', traceKeys: ['tool:1'] },
          { key: 'response:3', kind: 'response', text: 'Final answer' },
        ]}
        fallbackTraces={[
          {
            key: 'tool:1',
            kind: 'tool',
            label: 'Read src/App.tsx',
            status: 'done',
            startedAt: 2_000,
            endedAt: 2_100,
          },
        ]}
      />,
    );
    await user.click(screen.getByRole('button', { name: 'Worked for 3s' }));
    const thought = screen.getByRole('button', { name: 'Thought for 1s · Responded' });
    expect(screen.queryByText('I will inspect next.')).toBeNull();
    await user.click(thought);
    const response = screen.getByText('I will inspect next.');
    screen.getByText('Inspect first.');
    expect(response.closest('.transcript-thought')).toBeNull();
  });

  it('shows phase-scoped +/− on a collapsed intermediate-response heading (+2/-1 + +3/-4 => +5/-5)', async () => {
    const user = userEvent.setup();
    const { container } = render(
      <MessageItem
        runId="msg:phase-edits"
        durationMs={6_000}
        fallbackText="Final answer"
        fallbackTranscript={[
          {
            key: 'thought:0',
            kind: 'thought',
            text: 'Need two edits.',
            startedAt: 1_000,
            endedAt: 1_500,
          },
          { key: 'tools:1', kind: 'tools', traceKeys: ['edit:1', 'edit:2'] },
          { key: 'response:2', kind: 'response', text: 'I will patch both files.' },
          { key: 'tools:3', kind: 'tools', traceKeys: ['edit:3'] },
          { key: 'response:4', kind: 'response', text: 'Final answer' },
        ]}
        fallbackTraces={[
          {
            key: 'edit:1',
            kind: 'tool',
            label: 'Edit src/a.ts',
            status: 'done',
            startedAt: 1_500,
            endedAt: 2_000,
            path: 'src/a.ts',
            additions: 2,
            deletions: 1,
          },
          {
            key: 'edit:2',
            kind: 'tool',
            label: 'Edit src/b.ts',
            status: 'done',
            startedAt: 2_000,
            endedAt: 2_500,
            path: 'src/b.ts',
            additions: 3,
            deletions: 4,
          },
          {
            key: 'edit:3',
            kind: 'tool',
            label: 'Edit src/c.ts',
            status: 'done',
            startedAt: 4_000,
            endedAt: 5_000,
            path: 'src/c.ts',
            additions: 10,
            deletions: 7,
          },
        ]}
      />,
    );

    await user.click(screen.getByRole('button', { name: 'Worked for 6s' }));

    const phaseSummary = screen.getByRole('button', {
      name: /Thought and used 2 tools/,
    });
    expect(phaseSummary).toHaveTextContent('+5');
    expect(phaseSummary).toHaveTextContent('−5');
    // Phase isolation: later-phase edits (+10/-7) must not bleed into the first heading.
    expect(phaseSummary).not.toHaveTextContent('+10');
    expect(phaseSummary).not.toHaveTextContent('−7');
    expect(phaseSummary).not.toHaveTextContent('+15');

    // Outer Work for summary stays duration-only — no global edit totals.
    const workSummary = container.querySelector('.message-worked-summary');
    expect(workSummary).toHaveTextContent('Worked for 6s');
    expect(workSummary?.querySelector('.activity-diff-stats')).toBeNull();
    expect(workSummary).not.toHaveTextContent('+5');
  });

  it('omits phase edit stats when the phase has no edit traces', async () => {
    const user = userEvent.setup();
    render(
      <MessageItem
        runId="msg:phase-no-edits"
        durationMs={4_000}
        fallbackText="Final answer"
        fallbackTranscript={[
          {
            key: 'thought:0',
            kind: 'thought',
            text: 'Read only.',
            startedAt: 1_000,
            endedAt: 1_500,
          },
          { key: 'tools:1', kind: 'tools', traceKeys: ['tool:read'] },
          { key: 'response:2', kind: 'response', text: 'Looks fine.' },
          { key: 'response:3', kind: 'response', text: 'Final answer' },
        ]}
        fallbackTraces={[
          {
            key: 'tool:read',
            kind: 'tool',
            label: 'Read src/App.tsx',
            status: 'done',
            startedAt: 1_500,
            endedAt: 2_000,
          },
        ]}
      />,
    );

    await user.click(screen.getByRole('button', { name: 'Worked for 4s' }));
    const phaseSummary = screen.getByRole('button', { name: 'Thought and used 1 tool' });
    expect(phaseSummary.querySelector('.activity-diff-stats')).toBeNull();
    expect(phaseSummary).not.toHaveTextContent('+');
    expect(phaseSummary).not.toHaveTextContent('−');
  });

  it('isolates edit stats across two collapsed intermediate phases', async () => {
    const user = userEvent.setup();
    render(
      <MessageItem
        runId="msg:phase-isolation"
        durationMs={9_000}
        fallbackText="Final answer"
        fallbackTranscript={[
          {
            key: 'thought:0',
            kind: 'thought',
            text: 'First wave.',
            startedAt: 1_000,
            endedAt: 1_500,
          },
          { key: 'tools:1', kind: 'tools', traceKeys: ['edit:a'] },
          { key: 'response:2', kind: 'response', text: 'Patched A.' },
          {
            key: 'thought:3',
            kind: 'thought',
            text: 'Second wave.',
            startedAt: 3_000,
            endedAt: 3_500,
          },
          { key: 'tools:4', kind: 'tools', traceKeys: ['edit:b'] },
          { key: 'response:5', kind: 'response', text: 'Patched B.' },
          { key: 'response:6', kind: 'response', text: 'Final answer' },
        ]}
        fallbackTraces={[
          {
            key: 'edit:a',
            kind: 'tool',
            label: 'Edit a.ts',
            status: 'done',
            startedAt: 1_500,
            endedAt: 2_000,
            path: 'a.ts',
            additions: 2,
            deletions: 1,
          },
          {
            key: 'edit:b',
            kind: 'tool',
            label: 'Edit b.ts',
            status: 'done',
            startedAt: 3_500,
            endedAt: 4_000,
            path: 'b.ts',
            additions: 3,
            deletions: 4,
          },
        ]}
      />,
    );

    await user.click(screen.getByRole('button', { name: 'Worked for 9s' }));
    const phaseA = screen.getByRole('button', { name: /Thought and used 1 tool.*\+2/ });
    const phaseB = screen.getByRole('button', { name: /Thought and used 1 tool.*\+3/ });
    expect(phaseA).toHaveTextContent('+2');
    expect(phaseA).toHaveTextContent('−1');
    expect(phaseA).not.toHaveTextContent('+3');
    expect(phaseB).toHaveTextContent('+3');
    expect(phaseB).toHaveTextContent('−4');
    expect(phaseB).not.toHaveTextContent('+2');
  });

  it('does not promote an intermediate response while Done arrives before end', async () => {
    applyStateChange('done-before-end', { state: 'Running', startedAt: Date.now() });
    applyRunEvent('done-before-end', { type: 'text', data: 'I am still working.' });
    const { container, rerender } = render(<MessageItem runId="done-before-end" autoExpandWork />);

    await act(async () => {
      applyStateChange('done-before-end', { state: 'Done' });
    });
    rerender(<MessageItem runId="done-before-end" autoExpandWork />);
    expect(container.querySelector('.markdown-streaming')).toBeNull();
    await userEvent.setup().click(screen.getByRole('button', { name: /Worked for/ }));
    expect(container.querySelector('.transcript-response')).toHaveTextContent(
      'I am still working.',
    );

    await act(async () => {
      applyRunEvent('done-before-end', {
        type: 'end',
        stopReason: 'EndTurn',
        sessionId: 'session',
        requestId: 'request',
      });
    });
    expect(container.querySelector('.markdown-streaming')).toHaveTextContent('I am still working.');
    expect(container.querySelector('.transcript-response')).toBeNull();
  });

  it('keeps prior mid-responds visible while a later mid-respond is streaming (live multi-mid)', async () => {
    applyStateChange('live-multi-mid', { state: 'Running', startedAt: Date.now() });
    render(
      <MessageItem
        runId="live-multi-mid"
        autoExpandWork
        fallbackTranscript={[
          {
            key: 'thought:0',
            kind: 'thought',
            text: 'Look first.',
            startedAt: 1_000,
            endedAt: 1_400,
          },
          { key: 'response:1', kind: 'response', text: 'Mid one: checking weclaw.' },
          { key: 'tools:2', kind: 'tools', traceKeys: ['tool:a'] },
          {
            key: 'thought:3',
            kind: 'thought',
            text: 'Then reconsider.',
            startedAt: 3_000,
            endedAt: 3_300,
          },
          // Trailing respond is provisional exterior while live — prior mids
          // must remain in the work rail, not disappear into folded phases.
          { key: 'response:4', kind: 'response', text: 'Mid two: still residual.' },
        ]}
        fallbackTraces={[
          {
            key: 'tool:a',
            kind: 'tool',
            label: 'Read weclaw notes',
            status: 'done',
            startedAt: 2_000,
            endedAt: 2_400,
          },
        ]}
      />,
    );

    // Current trailing mid is exterior; earlier mid stays readable in the rail.
    expect(screen.getByText('Mid one: checking weclaw.')).toBeInTheDocument();
    expect(screen.getByText('Mid two: still residual.')).toBeInTheDocument();
    // Process before each closed mid still folds.
    expect(screen.getByRole('button', { name: 'Thought briefly' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Thought and used 1 tool' })).toBeInTheDocument();
    // Prior mid is not buried inside a collapsed phase body.
    expect(screen.getByText('Mid one: checking weclaw.').closest('.transcript-phase-body')).toBeNull();
  });

  it('moves an intermediate response back into the work rail when a tool starts', async () => {
    applyStateChange('response-then-tool', { state: 'Running', startedAt: Date.now() });
    applyRunEvent('response-then-tool', { type: 'text', data: "I'll inspect it." });
    const { container } = render(<MessageItem runId="response-then-tool" autoExpandWork />);

    expect(container.querySelector('.markdown-streaming')).toHaveTextContent("I'll inspect it.");

    await act(async () => {
      applyRunEvent(
        'response-then-tool',
        { type: 'unknown' },
        {
          type: 'tool_call',
          toolCallId: 'read-1',
          title: 'Read src/App.tsx',
          status: 'in_progress',
        },
      );
    });

    expect(container.querySelector('.markdown-streaming')).toBeNull();
    expect(container.querySelector('.transcript-response')).toHaveTextContent("I'll inspect it.");
    expect(screen.getByText('Read 1 file')).toBeInTheDocument();
  });

  it('folds the preceding workflow as soon as the final response starts streaming', async () => {
    applyStateChange('response-starts', { state: 'Running', startedAt: Date.now() });
    applyRunEvent('response-starts', { type: 'thought', data: 'inspect first' });
    applyRunEvent(
      'response-starts',
      { type: 'unknown' },
      {
        type: 'tool_call',
        toolCallId: 'read-starts',
        title: 'Read src/App.tsx',
        status: 'completed',
      },
    );
    render(<MessageItem runId="response-starts" autoExpandWork />);

    expect(screen.getByRole('button', { name: 'Thought briefly' })).toBeInTheDocument();
    await act(async () => {
      applyRunEvent('response-starts', { type: 'text', data: 'Here is the first sentence.' });
    });

    expect(screen.getByRole('button', { name: 'Thought and used 1 tool' })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Thought briefly' })).toBeNull();
    expect(screen.getByText('Here is the first sentence.')).toBeInTheDocument();
  });

  it('keeps thought→tools→thought visible until a response starts', () => {
    // Empty live snapshot so fallbackTranscript drives the ordered segments.
    applyStateChange('live-phase-early', { state: 'Running', startedAt: Date.now() });
    render(
      <MessageItem
        runId="live-phase-early"
        autoExpandWork
        fallbackTranscript={[
          {
            key: 'thought:0',
            kind: 'thought',
            text: 'First look.',
            startedAt: 1_000,
            endedAt: 2_000,
          },
          { key: 'tools:1', kind: 'tools', traceKeys: ['tool:read'] },
          {
            key: 'thought:2',
            kind: 'thought',
            text: 'Still reconsidering.',
            startedAt: 3_000,
            endedAt: null,
          },
        ]}
        fallbackTraces={[
          {
            key: 'tool:read',
            kind: 'tool',
            label: 'Read src/App.tsx',
            status: 'done',
            startedAt: 2_000,
            endedAt: 2_500,
          },
        ]}
      />,
    );

    expect(screen.queryByRole('button', { name: 'Thought and used 1 tool' })).toBeNull();
    expect(screen.getByRole('button', { name: 'Thought for 1s' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Thinking…' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Read 1 file' })).toBeInTheDocument();
  });

  it('keeps a lone running thought directly visible (not phase-folded)', () => {
    applyStateChange('lone-thought', { state: 'Running', startedAt: Date.now() });
    applyRunEvent('lone-thought', { type: 'thought', data: 'just thinking' });
    render(<MessageItem runId="lone-thought" autoExpandWork />);

    expect(screen.getByRole('button', { name: 'Thinking…' })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /Thought and used/ })).toBeNull();
    expect(screen.queryByRole('button', { name: /^Thought$/ })).toBeNull();
  });

  it('keeps the final response outside Worked for after completion despite trailing activity', async () => {
    const startedAt = Date.now() - 4_000;
    applyStateChange('final-after-activity', { state: 'Running', startedAt });
    applyRunEvent('final-after-activity', { type: 'text', data: 'Here is the answer.' });
    await act(async () => {
      applyRunEvent(
        'final-after-activity',
        { type: 'unknown' },
        {
          type: 'tool_call',
          toolCallId: 'bookkeep-1',
          title: 'Record usage',
          status: 'completed',
        },
      );
      applyRunEvent('final-after-activity', {
        type: 'end',
        stopReason: 'EndTurn',
        sessionId: 's-final',
        requestId: 'q-final',
      });
    });

    const { container } = render(
      <MessageItem runId="final-after-activity" autoExpandWork={false} />,
    );

    const external = container.querySelector('.markdown-streaming');
    expect(external).toHaveTextContent('Here is the answer.');
    expect(container.querySelector('.transcript-work')?.contains(external)).toBe(false);

    const user = userEvent.setup();
    await user.click(screen.getByRole('button', { name: /Worked for/ }));
    expect(container.querySelector('.transcript-response')).toBeNull();
    expect(screen.getByText('Used 1 tool')).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Used 1 tool' }));
    expect(screen.getByText('Record usage')).toBeInTheDocument();
  });

  it('labels a reasoning preview that Grok truncated upstream', async () => {
    const user = userEvent.setup();
    const clippedThought = `${'x'.repeat(200)}...`;
    render(
      <MessageItem
        runId="msg:clipped-thought"
        durationMs={1_000}
        fallbackText="done"
        fallbackTranscript={[
          {
            key: 'thought:0',
            kind: 'thought',
            text: clippedThought,
            startedAt: 1_000,
            endedAt: 2_000,
          },
          { key: 'response:1', kind: 'response', text: 'done' },
        ]}
      />,
    );

    await user.click(screen.getByRole('button', { name: 'Worked for 1s' }));
    await user.click(screen.getByRole('button', { name: 'Thought for 1s' }));
    expect(screen.getByRole('note')).toHaveTextContent('Preview truncated upstream');
  });

  it('opens a live turn, folds it on completion, and keeps history folded', async () => {
    applyStateChange('live-turn', { state: 'Running', startedAt: Date.now() });
    applyRunEvent('live-turn', { type: 'thought', data: 'checking' });
    const { container, rerender } = render(<MessageItem runId="live-turn" autoExpandWork />);
    const liveWork = screen.getByRole('button', { name: /Working for/ });
    expect(liveWork).toHaveAttribute('aria-expanded', 'true');
    expect(container.querySelector('.transcript-work')).toHaveClass('is-live');
    expect(container.querySelector('.transcript-thought')).toHaveClass('is-running');

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
      'false',
    );
    expect(container.querySelector('.transcript-work')).not.toHaveClass('is-live');
    expect(container.querySelector('.transcript-thought')).toBeNull();

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
    streamStore.setHtml(exteriorMarkdownKey('r3', 0), '<h1>heading</h1>');
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
