import { act, render, screen } from '@testing-library/react';
import { beforeEach, describe, expect, it } from 'vitest';
import {
  PlanTodoList,
  isPlanAllCompleted,
  resolveActivePlanEntries,
  resolvePlanEntriesFromTraces,
  shouldShowPlan,
} from '../PlanTodoList';
import { MessageItem } from '../MessageItem';
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
  it('renders disabled task-list checkboxes (not raw markdown syntax) with status classes', () => {
    const { container } = render(<PlanTodoList entries={samplePlan} />);
    const list = screen.getByRole('list', { name: 'Plan' });
    expect(list).toHaveClass('task-list-container');
    const items = container.querySelectorAll('.plan-todo-item');
    expect(items).toHaveLength(3);

    const checkboxes = container.querySelectorAll<HTMLInputElement>(
      'input.task-list-item-checkbox[type="checkbox"]',
    );
    expect(checkboxes).toHaveLength(3);
    for (const box of checkboxes) {
      expect(box.disabled).toBe(true);
    }

    expect(items[0]).toHaveClass('is-completed');
    expect(checkboxes[0]?.checked).toBe(true);
    expect(items[0]).toHaveTextContent('Inspect code');
    expect(items[0]?.textContent).not.toMatch(/- \[[ x/]\]/);

    expect(items[1]).toHaveClass('is-active');
    expect(checkboxes[1]?.checked).toBe(false);
    expect(items[1]).toHaveTextContent('Implement fix');
    expect(items[1]?.textContent).not.toMatch(/- \[[ x/]\]/);

    expect(items[2]).toHaveClass('is-pending');
    expect(checkboxes[2]?.checked).toBe(false);
    expect(items[2]).toHaveTextContent('Verify tests');
    expect(items[2]?.textContent).not.toMatch(/- \[[ x/]\]/);

    // No raw markdown task-list source characters anywhere in the list.
    expect(list.textContent).not.toContain('[ ]');
    expect(list.textContent).not.toContain('[x]');
    expect(list.textContent).not.toContain('[/]');
  });

  it('occupies no space when there are no plan entries', () => {
    const { container } = render(<PlanTodoList entries={[]} />);
    expect(container).toBeEmptyDOMElement();
    expect(screen.queryByRole('list', { name: 'Plan' })).toBeNull();
  });

  it('renders at the bottom of an assistant message after the body', () => {
    // Restored / no-snapshot path: body + persisted plan, no live stream.
    streamStore.setHtml('msg:plan-bottom', '<p>Working on it.</p>');
    const { container } = render(
      <MessageItem
        runId="msg:plan-bottom"
        fallbackText="Working on it."
        showPlan
        planEntries={[
          { text: 'Step one', status: 'pending' },
          { text: 'Step two', status: 'in_progress' },
        ]}
      />,
    );
    const body = container.querySelector('.message-body');
    const plan = screen.getByRole('list', { name: 'Plan' });
    expect(body).toBeTruthy();
    expect(plan).toBeInTheDocument();
    // Plan is after the message body in document order.
    expect(
      Boolean(body && plan.compareDocumentPosition(body) & Node.DOCUMENT_POSITION_PRECEDING),
    ).toBe(true);
  });

  it('keeps a persisted plan after the run ends when showPlan is true', async () => {
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
      <MessageItem
        runId="plan-done"
        fallbackText="done"
        showPlan
        planEntries={[{ text: 'Still unfinished', status: 'in_progress' }]}
      />,
    );
    expect(screen.getByText('Still unfinished')).toBeInTheDocument();
    expect(screen.getByRole('list', { name: 'Plan' })).toBeInTheDocument();
  });

  it('hides a completed plan once lifecycle says so', () => {
    render(
      <MessageItem
        runId="msg:hidden"
        fallbackText="done"
        showPlan={false}
        planEntries={[
          { text: 'All done', status: 'completed' },
          { text: 'Also done', status: 'completed' },
        ]}
      />,
    );
    expect(screen.queryByRole('list', { name: 'Plan' })).toBeNull();
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
  });
});
