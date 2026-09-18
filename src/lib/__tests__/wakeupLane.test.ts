import { describe, expect, it } from 'vitest';
import { resolveWakeupLane } from '../wakeupLane';

describe('resolveWakeupLane', () => {
  it('keeps a wakeup on its originating tab', () => {
    expect(
      resolveWakeupLane({
        laneId: 'tab-a',
        sessionId: 'sess-a',
        activeTabId: 'tab-b',
        tabs: [
          { id: 'tab-a', sessionHead: 'sess-a' },
          { id: 'tab-b', sessionHead: 'sess-b' },
        ],
      }),
    ).toBe('tab-a');
  });

  it('does not dump another session wakeup onto the focused tab', () => {
    expect(
      resolveWakeupLane({
        laneId: '',
        sessionId: 'sess-a',
        activeTabId: 'tab-b',
        tabs: [
          { id: 'tab-a', sessionHead: 'sess-a' },
          { id: 'tab-b', sessionHead: 'sess-b' },
        ],
      }),
    ).toBe('tab-a');
  });

  it('falls back to the only tab when lane id is omitted', () => {
    expect(
      resolveWakeupLane({
        laneId: '',
        sessionId: 'sess-1',
        activeTabId: 'solo',
        tabs: [{ id: 'solo', sessionHead: 'sess-0' }],
      }),
    ).toBe('solo');
  });

  it('drops a wakeup that matches no tab when several are open', () => {
    expect(
      resolveWakeupLane({
        laneId: '',
        sessionId: 'sess-unknown',
        activeTabId: 'tab-b',
        tabs: [
          { id: 'tab-a', sessionHead: 'sess-a' },
          { id: 'tab-b', sessionHead: 'sess-b' },
        ],
      }),
    ).toBeNull();
  });
});
