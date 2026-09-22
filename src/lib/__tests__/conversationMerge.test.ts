import { describe, expect, it } from 'vitest';
import {
  isDanglingActiveTabId,
  isReinstallGhostTab,
  mergeTabLists,
  reconcileActiveTab,
  richerMessageList,
} from '../conversationMerge';
import type { Tab } from '../tabs';

function tab(id: string, messageIds: string[], cwd = '', extras: Partial<Tab> = {}): Tab {
  return {
    id,
    name: id,
    cwd,
    createdAt: 1,
    messages: messageIds.map((messageId) => ({
      id: messageId,
      role: 'user',
      content: messageId,
      ts: 1,
    })),
    ...extras,
  };
}

describe('richerMessageList', () => {
  it('keeps local when there is no overlap', () => {
    expect(richerMessageList([{ id: 'a' }], [{ id: 'x' }, { id: 'y' }])).toEqual([{ id: 'a' }]);
  });

  it('adopts the longer overlapping transcript', () => {
    expect(
      richerMessageList([{ id: 'a' }, { id: 'b' }], [{ id: 'a' }, { id: 'b' }, { id: 'c' }]).map(
        (row) => row.id,
      ),
    ).toEqual(['a', 'b', 'c']);
  });
});

describe('mergeTabLists', () => {
  it('keeps the tab copy with more messages and preserves local order (id-overlap)', () => {
    const local = [tab('t1', ['a']), tab('t2', ['b'])];
    const disk = [tab('t1', ['a', 'a2']), tab('t3', ['c'])];
    const merged = mergeTabLists(local, disk);
    expect(merged.map((item) => item.id)).toEqual(['t1', 't2', 't3']);
    expect(merged[0]?.messages.map((message) => message.id)).toEqual(['a', 'a2']);
  });

  it('drops reinstall bootstrap ghost when disk already has sessions', () => {
    // Cleared localStorage → makeTab() mints tab_new; conversations.json keeps real sessions.
    const local = [tab('tab_new', [])];
    const disk = [tab('tab_real', ['m1', 'm2']), tab('tab_other', ['n1'])];
    const merged = mergeTabLists(local, disk);
    expect(merged.map((item) => item.id)).toEqual(['tab_real', 'tab_other']);
  });

  it('drops a reinstall bootstrap empty tab that duplicates a disk empty', () => {
    const local = [tab('tab_new', [])];
    const disk = [tab('tab_old_empty', []), tab('tab_real', ['m1', 'm2'])];
    const merged = mergeTabLists(local, disk);
    expect(merged.map((item) => item.id)).toEqual(['tab_old_empty', 'tab_real']);
  });

  it('drops a local-only tab whose messages are a subset of a disk tab', () => {
    // session_state.json rehydrated the transcript into the fresh tab id.
    const local = [tab('tab_new', ['m1', 'm2'])];
    const disk = [tab('tab_stable', ['m1', 'm2', 'm3'])];
    const merged = mergeTabLists(local, disk);
    expect(merged.map((item) => item.id)).toEqual(['tab_stable']);
    expect(merged[0]?.messages.map((message) => message.id)).toEqual(['m1', 'm2', 'm3']);
  });

  it('keeps two different real sessions with messages', () => {
    const local = [tab('s1', ['a1', 'a2']), tab('s2', ['b1'])];
    const disk = [tab('s1', ['a1']), tab('s2', ['b1', 'b2'])];
    const merged = mergeTabLists(local, disk);
    expect(merged.map((item) => item.id)).toEqual(['s1', 's2']);
    expect(merged[0]?.messages.map((message) => message.id)).toEqual(['a1', 'a2']);
    expect(merged[1]?.messages.map((message) => message.id)).toEqual(['b1', 'b2']);
  });

  it('keeps local-only tabs with unique content (not on disk)', () => {
    const local = [tab('tab_draft', ['brand-new'])];
    const disk = [tab('tab_stable', ['m1'])];
    const merged = mergeTabLists(local, disk);
    expect(merged.map((item) => item.id)).toEqual(['tab_draft', 'tab_stable']);
  });

  it('does not collapse persisted forks that share message ids', () => {
    // Forks copy message ids but both tab ids live on disk.
    const forkMsgs = ['m1', 'm2'];
    const local = [tab('root', forkMsgs), tab('fork', forkMsgs)];
    const disk = [tab('root', forkMsgs), tab('fork', forkMsgs)];
    const merged = mergeTabLists(local, disk);
    expect(merged.map((item) => item.id)).toEqual(['root', 'fork']);
  });

  it('dedupes multiple empty untitled sessions down to one', () => {
    const local = [tab('empty_a', []), tab('empty_b', [])];
    const disk = [tab('empty_c', []), tab('real', ['m1'])];
    const merged = mergeTabLists(local, disk);
    const empties = merged.filter((item) => (item.messages?.length ?? 0) === 0);
    expect(empties).toHaveLength(1);
    expect(merged.some((item) => item.id === 'real')).toBe(true);
  });
});

describe('isReinstallGhostTab', () => {
  it('treats empty no-sessionHead local tabs as ghosts when disk has tabs', () => {
    expect(isReinstallGhostTab(tab('a', [], '/proj'), [tab('b', ['m1'], '/proj')])).toBe(true);
    expect(isReinstallGhostTab(tab('a', [], '/proj'), [tab('b', [], '/other')])).toBe(true);
  });

  it('is false when disk is empty', () => {
    expect(isReinstallGhostTab(tab('a', []), [])).toBe(false);
  });

  it('detects empty twins with sessionHead via same cwd', () => {
    expect(
      isReinstallGhostTab(tab('a', [], '/proj', { sessionHead: 'sess' }), [
        tab('b', [], '/proj', { sessionHead: 'other' }),
      ]),
    ).toBe(true);
    expect(
      isReinstallGhostTab(tab('a', [], '/proj', { sessionHead: 'sess' }), [
        tab('b', [], '/other', { sessionHead: 'other' }),
      ]),
    ).toBe(false);
  });
});

describe('reconcileActiveTab', () => {
  it('keeps a consistent activeTabId that already exists in tabs', () => {
    const tabs = [tab('t1', ['a']), tab('t2', ['b'])];
    expect(reconcileActiveTab(tabs, 't2')).toEqual({ tabs, activeTabId: 't2' });
  });

  it('synthesizes a missing active tab when live messages exist (persistence desync)', () => {
    const tabs = [tab('other', ['x'])];
    const liveMsgs = [
      { id: 'm1', role: 'user' as const, content: 'hi', ts: 1 },
      { id: 'm2', role: 'assistant' as const, content: 'yo', ts: 2 },
    ];
    const result = reconcileActiveTab(tabs, 'tab_muamqbbk_1', {
      messages: liveMsgs,
      cwd: '/repo',
    });
    expect(result.activeTabId).toBe('tab_muamqbbk_1');
    expect(result.tabs.map((item) => item.id)).toEqual(['other', 'tab_muamqbbk_1']);
    const added = result.tabs.find((item) => item.id === 'tab_muamqbbk_1')!;
    expect(added.messages.map((message) => message.id)).toEqual(['m1', 'm2']);
    expect(added.cwd).toBe('/repo');
  });

  it('synthesizes from sessionHead alone when messages are empty', () => {
    const tabs = [tab('other', ['x'])];
    const result = reconcileActiveTab(tabs, 'orphan', {
      sessionHead: 'sess-head',
      cwd: '/proj',
    });
    expect(result.activeTabId).toBe('orphan');
    expect(result.tabs.some((item) => item.id === 'orphan')).toBe(true);
    expect(result.tabs.find((item) => item.id === 'orphan')?.sessionHead).toBe('sess-head');
  });

  it('adopts an existing host tab instead of duplicating a reinstall ghost transcript', () => {
    const tabs = [tab('tab_stable', ['m1', 'm2', 'm3'])];
    const result = reconcileActiveTab(tabs, 'tab_new', {
      messages: [
        { id: 'm1', role: 'user', content: 'm1', ts: 1 },
        { id: 'm2', role: 'user', content: 'm2', ts: 1 },
      ],
    });
    expect(result.activeTabId).toBe('tab_stable');
    expect(result.tabs.map((item) => item.id)).toEqual(['tab_stable']);
  });

  it('re-points dangling empty activeTabId to the first tab', () => {
    const tabs = [tab('t1', ['a']), tab('t2', ['b'])];
    expect(reconcileActiveTab(tabs, 'ghost')).toEqual({ tabs, activeTabId: 't1' });
  });

  it('enriches the active tab with a richer live transcript', () => {
    const tabs = [tab('t1', ['a'])];
    const result = reconcileActiveTab(tabs, 't1', {
      messages: [
        { id: 'a', role: 'user', content: 'a', ts: 1 },
        { id: 'b', role: 'user', content: 'b', ts: 1 },
      ],
    });
    expect(result.activeTabId).toBe('t1');
    expect(result.tabs[0]?.messages.map((message) => message.id)).toEqual(['a', 'b']);
  });
});

describe('isDanglingActiveTabId', () => {
  it('detects active ids missing from tabs', () => {
    expect(isDanglingActiveTabId([tab('t1', [])], 'ghost')).toBe(true);
    expect(isDanglingActiveTabId([tab('t1', [])], 't1')).toBe(false);
    expect(isDanglingActiveTabId([tab('t1', [])], '')).toBe(false);
    expect(isDanglingActiveTabId([tab('t1', [])], null)).toBe(false);
  });
});
