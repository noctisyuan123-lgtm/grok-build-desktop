import { beforeEach, describe, expect, it } from 'vitest';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { ContextUsageRing } from '../ContextUsageRing';
import type { ChatMessage } from '../../app/types';
import { installTauriAppMock } from '../../test/tauriAppMock';
import { streamStore } from '../../lib/streamStore';

const SESSION = '019fe74c-9daf-7b03-9387-36b35cf1eb63';

const readyMessages: ChatMessage[] = [
  { id: 'u1', role: 'user', content: 'hi', ts: 1 },
  {
    id: 'a1',
    role: 'assistant',
    content: 'hello',
    ts: 2,
    meta: { sessionId: SESSION },
  },
];

const readyMetrics = {
  available: true,
  sessionId: SESSION,
  contextTokensUsed: 90_000,
  contextWindowTokens: 500_000,
  contextWindowUsage: 85,
  compactionCount: 2,
  totalTokensBeforeCompaction: 400_000,
  turnCount: 5,
  primaryModelId: 'grok-4.5',
  autoCompactThresholdPercent: 80,
  breakdown: {
    systemPrompt: 8_000,
    rules: 4_000,
    conversation: 30_000,
    toolsRuntime: 48_000,
  },
  breakdownApproximate: true,
  detail: null,
};

beforeEach(() => {
  streamStore.__reset();
});

describe('ContextUsageRing', () => {
  it('renders an empty-state control when no session exists', async () => {
    installTauriAppMock();
    render(<ContextUsageRing messages={[]} cwd="/proj" />);
    const button = await screen.findByRole('button', { name: /no active grok session/i });
    expect(button).toBeInTheDocument();
    expect(button).toHaveAttribute('aria-expanded', 'false');
  });

  it('opens a Cursor-style panel with summary, segments, and close control', async () => {
    const user = userEvent.setup();
    installTauriAppMock({
      get_session_context_metrics: () => ({ ...readyMetrics }),
    });
    render(<ContextUsageRing messages={readyMessages} cwd="/proj" />);

    const button = await screen.findByRole('button', { name: /context usage 85%/i });
    expect(button.className).toMatch(/tone-orange/);
    // 13px visible ring inside an 18px hit target
    const svg = button.querySelector('.context-usage-svg');
    expect(svg?.getAttribute('width')).toBe('13');
    expect(button.className).toMatch(/context-usage-ring/);

    const progress = button.querySelector('.context-usage-progress');
    expect(Number(progress?.getAttribute('stroke-dashoffset'))).toBeGreaterThan(0);
    expect(Number(progress?.getAttribute('stroke-dashoffset'))).toBeLessThan(
      Number(progress?.getAttribute('stroke-dasharray')),
    );

    await user.click(button);
    const dialog = await screen.findByRole('dialog', { name: /context usage/i });
    expect(dialog).toBeInTheDocument();

    // Summary: "N% Full" + "~used / window Tokens"
    expect(within(dialog).getByText(/85% Full/i)).toBeInTheDocument();
    expect(within(dialog).getByText(/~90k\s*\/\s*500k\s*Tokens/i)).toBeInTheDocument();

    // Four category rows with approximate counts
    expect(within(dialog).getByText('System prompt')).toBeInTheDocument();
    expect(within(dialog).getByText('Rules')).toBeInTheDocument();
    expect(within(dialog).getByText('Tools & runtime')).toBeInTheDocument();
    expect(within(dialog).getByText('Conversation')).toBeInTheDocument();
    expect(within(dialog).getByText('~8k')).toBeInTheDocument();
    expect(within(dialog).getByText('~4k')).toBeInTheDocument();
    expect(within(dialog).getByText('~30k')).toBeInTheDocument();
    expect(within(dialog).getByText('~48k')).toBeInTheDocument();

    // Estimated breakdown honesty label
    expect(within(dialog).getByText(/Estimated breakdown/i)).toBeInTheDocument();

    // Stacked bar segments proportional to breakdown (widths set via ref/style)
    const segs = [...dialog.querySelectorAll('.context-usage-bar-seg')] as HTMLElement[];
    expect(segs.length).toBe(4);
    const byKey = Object.fromEntries(segs.map((el) => [el.getAttribute('data-seg'), el]));
    expect(parseFloat(byKey.systemPrompt.style.width)).toBeCloseTo((8_000 / 500_000) * 100, 4);
    expect(parseFloat(byKey.rules.style.width)).toBeCloseTo((4_000 / 500_000) * 100, 4);
    expect(parseFloat(byKey.toolsRuntime.style.width)).toBeCloseTo((48_000 / 500_000) * 100, 4);
    expect(parseFloat(byKey.conversation.style.width)).toBeCloseTo((30_000 / 500_000) * 100, 4);

    // Removed noise rows
    expect(within(dialog).queryByText('Model')).not.toBeInTheDocument();
    expect(within(dialog).queryByText('Turns')).not.toBeInTheDocument();
    expect(within(dialog).queryByText(/Auto-compact/i)).not.toBeInTheDocument();
    expect(within(dialog).queryByText('Compactions')).not.toBeInTheDocument();
    expect(within(dialog).queryByText('grok-4.5')).not.toBeInTheDocument();

    // Explicit close button
    await user.click(within(dialog).getByRole('button', { name: /close context usage/i }));
    await waitFor(() => {
      expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    });
    expect(button).toHaveAttribute('aria-expanded', 'false');
  });

  it('dismisses the panel on Escape', async () => {
    const user = userEvent.setup();
    installTauriAppMock({
      get_session_context_metrics: () => ({ ...readyMetrics }),
    });
    render(<ContextUsageRing messages={readyMessages} cwd="/proj" />);

    const button = await screen.findByRole('button', { name: /context usage 85%/i });
    await user.click(button);
    expect(await screen.findByRole('dialog')).toBeInTheDocument();

    await user.keyboard('{Escape}');
    await waitFor(() => {
      expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    });
    expect(button).toHaveAttribute('aria-expanded', 'false');
  });

  it('shows a streaming cue while a run is active', async () => {
    installTauriAppMock({
      get_session_context_metrics: () => ({
        ...readyMetrics,
        contextTokensUsed: 10_000,
        contextWindowUsage: 2,
        breakdown: {
          systemPrompt: 1_000,
          rules: 500,
          conversation: 3_000,
          toolsRuntime: 5_500,
        },
      }),
    });
    streamStore.patchRun('run-1', { state: 'running', sessionId: SESSION });
    streamStore.setQueue({ active: 'run-1', items: [] });

    render(<ContextUsageRing messages={readyMessages} cwd="/proj" />);
    const button = await screen.findByRole('button', { name: /updating while grok is running/i });
    expect(button.className).toMatch(/is-streaming/);
  });

  it('applies the red tone at ≥90% occupancy', async () => {
    installTauriAppMock({
      get_session_context_metrics: () => ({
        ...readyMetrics,
        contextTokensUsed: 460_000,
        contextWindowUsage: 92,
        breakdown: {
          systemPrompt: 10_000,
          rules: 5_000,
          conversation: 200_000,
          toolsRuntime: 245_000,
        },
      }),
    });
    render(<ContextUsageRing messages={readyMessages} cwd="/proj" />);
    const button = await screen.findByRole('button', { name: /context usage 92%/i });
    expect(button.className).toMatch(/tone-red/);
  });
});
