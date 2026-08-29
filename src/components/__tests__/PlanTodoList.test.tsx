import { act, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it } from 'vitest';
import {
  PlanFloat,
  PlanTodoList,
  findVisiblePlan,
  isPlanAllCompleted,
  resolveActivePlanEntries,
  resolvePlanEntriesFromTraces,
  shouldShowPlan,
} from '../PlanTodoList';
import { applyRunEvent, applyStateChange, streamStore } from '../../lib/streamStore';
import type { PlanEntry } from '../../lib/traceParser';

beforeEach(() => {
  streamStore.__reset();
});

const samplePlan: PlanEntry[] = [
  { text: 'Inspect code', status: 'completed' },
  { text: 'Implement fix', status: 'in_progress' },
  { text: 'Verify tests', status: 'pending' },
];

describe('PlanTodoList rendering', () => {
  it('renders status marks (not markdown checkboxes) with status classes', () => {
    const { container } = render(<PlanTodoList entries={samplePlan} />);
    const list = screen.getByRole('list', { name: 'Plan' });
    expect(list).not.toHaveClass('task-list-container');
    const items = container.querySelectorAll('.plan-todo-item');
    expect(items).toHaveLength(3);
    expect(container.querySelectorAll('input[type="checkbox"]')).toHaveLength(0);

    expect(items[0]).toHaveClass('is-completed');
    expect(items[0]).toHaveTextContent('Inspect code');
    expect(items[0]?.textContent).not.toMatch(/- \[[ x/]\]/);
    expect(items[0]?.querySelector('.plan-todo-mark svg')).toBeTruthy();

    expect(items[1]).toHaveClass('is-active');
    expect(items[1]).toHaveAttribute('aria-current', 'step');
    expect(items[1]).toHaveTextContent('Implement fix');
    expect(items[1]?.querySelector('.plan-todo-dot')).toBeTruthy();

    expect(items[2]).toHaveClass('is-pending');
    expect(items[2]).toHaveTextContent('Verify tests');
    expect(items[2]?.querySelector('.plan-todo-ring')).toBeTruthy();

    expect(list.textContent).not.toContain('[ ]');
    expect(list.textContent).not.toContain('[x]');
    expect(list.textContent).not.toContain('[/]');
  });

  it('occupies no space when there are no plan entries', () => {
    const { container } = render(<PlanTodoList entries={[]} />);
    expect(container).toBeEmptyDOMElement();
    expect(screen.queryByRole('list', { name: 'Plan' })).toBeNull();
  });
});

describe('PlanFloat', () => {
  it('docks a persisted incomplete plan above the composer, not in the message body', () => {
    const { container } = render(
      <PlanFloat
        messages={[
          {
            role: 'assistant',
            runId: 'run-1',
            meta: {
              planEntries: [
                { text: 'Step one', status: 'pending' },
                { text: 'Step two', status: 'in_progress' },
              ],
            },
          },
        ]}
      />,
    );
    expect(container.querySelector('.plan-float-dock')).toBeTruthy();
    expect(container.querySelector('.plan-float')).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Plan 0 of 2' })).toBeInTheDocument();
    expect(screen.getByText('Step one')).toBeInTheDocument();
    expect(screen.queryByRole('list', { name: 'Plan' })).toBeInTheDocument();
  });

  it('keeps a persisted plan after the run ends', async () => {
    applyStateChange('plan-done', { state: 'Running', startedAt: Date.now() });
    await act(async () => {
      applyRunEvent(
        'plan-done',
        { type: 'unknown' },
        {
          type: 'plan',
          entries: [{ content: 'Still unfinished', status: 'in_progress' }],
        },
      );
      applyRunEvent('plan-done', {
        type: 'end',
        stopReason: 'EndTurn',
        sessionId: 's',
        requestId: 'q',
      });
    });

    render(
      <PlanFloat
        messages={[
          {
            role: 'assistant',
            runId: 'plan-done',
            meta: { planEntries: [{ text: 'Still unfinished', status: 'in_progress' }] },
          },
        ]}
      />,
    );
    expect(screen.getByText('Still unfinished')).toBeInTheDocument();
    expect(screen.getByRole('list', { name: 'Plan' })).toBeInTheDocument();
  });

  it('prefers a live run plan over an older persisted plan', async () => {
    await act(async () => {
      applyStateChange('live-plan', { state: 'Running', startedAt: Date.now() });
      applyRunEvent(
        'live-plan',
        { type: 'unknown' },
        {
          type: 'plan',
          entries: [{ content: 'Fresh live step', status: 'in_progress' }],
        },
      );
    });

    render(
      <PlanFloat
        activeRunId="live-plan"
        messages={[
          {
            role: 'assistant',
            runId: 'old-run',
            meta: { planEntries: [{ text: 'Stale step', status: 'pending' }] },
          },
        ]}
      />,
    );
    expect(screen.getByText('Fresh live step')).toBeInTheDocument();
    expect(screen.queryByText('Stale step')).toBeNull();
  });

  it('hides when lifecycle says the plan should not show', () => {
    const { container } = render(
      <PlanFloat
        messages={[
          {
            role: 'assistant',
            meta: {
              planEntries: [
                { text: 'All done', status: 'completed' },
                { text: 'Also done', status: 'completed' },
              ],
            },
          },
          { role: 'user' },
          { role: 'assistant', meta: {} },
          { role: 'user' },
        ]}
      />,
    );
    expect(container).toBeEmptyDOMElement();
  });

  it('collapses a completed plan and expands on toggle', async () => {
    const user = userEvent.setup();
    render(
      <PlanFloat
        messages={[
          {
            role: 'assistant',
            meta: {
              planEntries: [
                { text: 'Done A', status: 'completed' },
                { text: 'Done B', status: 'completed' },
              ],
            },
          },
        ]}
      />,
    );
    const toggle = screen.getByRole('button', { name: 'Plan 2 of 2' });
    expect(toggle).toHaveAttribute('aria-expanded', 'false');
    expect(screen.queryByRole('list', { name: 'Plan' })).toBeNull();

    await user.click(toggle);
    expect(toggle).toHaveAttribute('aria-expanded', 'true');
    expect(screen.getByText('Done A')).toBeInTheDocument();
  });
});

describe('plan lifecycle helpers', () => {
  it('resolvePlanEntriesFromTraces prefers the latest plan payload', () => {
    const entries = resolvePlanEntriesFromTraces([
      {
        kind: 'task',
        raw: {
          type: 'plan',
          entries: [{ content: 'Old', status: 'pending' }],
        },
      },
      {
        kind: 'task',
        raw: {
          type: 'plan_update',
          entries: [
            { content: 'Old', status: 'completed' },
            { content: 'New', status: 'in_progress' },
          ],
        },
      },
    ]);
    expect(entries).toEqual([
      { text: 'Old', status: 'completed' },
      { text: 'New', status: 'in_progress' },
    ]);
  });

  it('does not invent a plan from prose or empty entries', () => {
    expect(
      resolveActivePlanEntries({
        state: 'running',
        traces: [{ kind: 'task', raw: { type: 'plan', entries: [] } }],
      }),
    ).toBeNull();
    expect(
      resolvePlanEntriesFromTraces([{ kind: 'tool', raw: { type: 'text', data: '1. Do stuff' } }]),
    ).toBeNull();
    expect(isPlanAllCompleted([])).toBe(false);
    expect(isPlanAllCompleted([{ text: 'a', status: 'completed' }])).toBe(true);
    expect(
      isPlanAllCompleted([
        { text: 'a', status: 'completed' },
        { text: 'b', status: 'pending' },
      ]),
    ).toBe(false);
  });

  it('keeps incomplete plans across later turns until superseded or completed', () => {
    const messages = [
      { role: 'user' as const },
      {
        role: 'assistant' as const,
        meta: {
          planEntries: [
            { text: 'A', status: 'completed' as const },
            { text: 'B', status: 'pending' as const },
          ],
        },
      },
      { role: 'user' as const },
      { role: 'assistant' as const, meta: {} },
      { role: 'user' as const },
      { role: 'assistant' as const, meta: {} },
    ];
    expect(shouldShowPlan(messages, 1)).toBe(true);
    expect(findVisiblePlan(messages)?.entries[0]?.text).toBe('A');
  });

  it('hides a completed plan only after the following turn has begun (second user turn)', () => {
    const base = [
      { role: 'user' as const },
      {
        role: 'assistant' as const,
        meta: {
          planEntries: [
            { text: 'A', status: 'completed' as const },
            { text: 'B', status: 'completed' as const },
          ],
        },
      },
    ];
    // Just finished — still visible.
    expect(shouldShowPlan(base, 1)).toBe(true);
    // Next user/assistant turn — still visible.
    expect(
      shouldShowPlan(
        [...base, { role: 'user' as const }, { role: 'assistant' as const, meta: {} }],
        1,
      ),
    ).toBe(true);
    // The turn after that has begun — hide.
    expect(
      shouldShowPlan(
        [
          ...base,
          { role: 'user' as const },
          { role: 'assistant' as const, meta: {} },
          { role: 'user' as const },
        ],
        1,
      ),
    ).toBe(false);
    expect(
      findVisiblePlan([
        ...base,
        { role: 'user' as const },
        { role: 'assistant' as const, meta: {} },
        { role: 'user' as const },
      ]),
    ).toBeNull();
  });

  it('lets a later assistant plan supersede an earlier one', () => {
    const messages = [
      { role: 'user' as const },
      {
        role: 'assistant' as const,
        meta: { planEntries: [{ text: 'Old', status: 'pending' as const }] },
      },
      { role: 'user' as const },
      {
        role: 'assistant' as const,
        meta: { planEntries: [{ text: 'New', status: 'in_progress' as const }] },
      },
    ];
    expect(shouldShowPlan(messages, 1)).toBe(false);
    expect(shouldShowPlan(messages, 3)).toBe(true);
    expect(findVisiblePlan(messages)?.entries[0]?.text).toBe('New');
  });

  it('never reads plans from another session when callers pass only this session', () => {
    // Isolation is by which messages the parent supplies — other tabs are not
    // in this array, so their plans cannot render here.
    const thisSession = [
      {
        role: 'assistant' as const,
        meta: { planEntries: [{ text: 'Mine', status: 'pending' as const }] },
      },
    ];
    expect(shouldShowPlan(thisSession, 0)).toBe(true);
    expect(shouldShowPlan([], 0)).toBe(false);
    expect(findVisiblePlan([])).toBeNull();
  });
});
