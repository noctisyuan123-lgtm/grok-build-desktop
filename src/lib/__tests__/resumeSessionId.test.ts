import { describe, expect, it } from 'vitest';
import { pickResumeSessionId, transcriptHasBoundSession } from '../resumeSessionId';

describe('pickResumeSessionId', () => {
  it('does not resume a poisoned sessionHead on a first-turn / empty transcript', () => {
    expect(
      pickResumeSessionId({
        messages: [{ role: 'user', meta: null }],
        tabSessionHead: '019fe000-dead-session',
      }),
    ).toBeNull();
    expect(transcriptHasBoundSession([{ role: 'user' }])).toBe(false);
  });

  it('resumes tab.sessionHead once an assistant turn bound a session', () => {
    expect(
      pickResumeSessionId({
        messages: [
          { role: 'user' },
          { role: 'assistant', meta: { sessionId: 'sess-a' } },
        ],
        tabSessionHead: 'sess-a',
      }),
    ).toBe('sess-a');
  });

  it('prefers the visible assistant session id over a stale head', () => {
    expect(
      pickResumeSessionId({
        messages: [{ role: 'assistant', meta: { sessionId: 'sess-b' } }],
        visibleSessionId: 'sess-b',
        tabSessionHead: 'sess-old',
      }),
    ).toBe('sess-b');
  });
});
