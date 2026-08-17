import { describe, expect, it } from 'vitest';
import { isBackgroundSessionRun } from '../completionNotification';

describe('isBackgroundSessionRun', () => {
  const tabs = [
    { id: 'active', messages: [{ runId: 'active-run' }] },
    { id: 'background', messages: [{ runId: 'background-run' }] },
  ];

  it('does not classify the visible session run as background', () => {
    expect(isBackgroundSessionRun('active-run', 'active', tabs[0]!.messages, tabs)).toBe(false);
  });

  it('classifies a run from another session as background', () => {
    expect(isBackgroundSessionRun('background-run', 'active', tabs[0]!.messages, tabs)).toBe(true);
  });

  it('ignores unknown runs', () => {
    expect(isBackgroundSessionRun('missing', 'active', tabs[0]!.messages, tabs)).toBe(false);
  });
});
