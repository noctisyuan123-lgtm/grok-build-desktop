import { describe, expect, it } from 'vitest';
import { mergeTabLists, richerMessageList } from '../conversationMerge';
import type { Tab } from '../tabs';

function tab(id: string, messageIds: string[]): Tab {
  return {
    id,
    name: id,
    cwd: '',
    createdAt: 1,
    messages: messageIds.map((messageId) => ({
      id: messageId,
      role: 'user',
      content: messageId,
      ts: 1,
    })),
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
  it('keeps the tab copy with more messages and preserves local order', () => {
    const local = [tab('t1', ['a']), tab('t2', ['b'])];
    const disk = [tab('t1', ['a', 'a2']), tab('t3', ['c'])];
    const merged = mergeTabLists(local, disk);
    expect(merged.map((item) => item.id)).toEqual(['t1', 't2', 't3']);
    expect(merged[0]?.messages.map((message) => message.id)).toEqual(['a', 'a2']);
  });
});
