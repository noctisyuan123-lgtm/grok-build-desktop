import { describe, expect, it } from 'vitest';
import {
  canAcceptProviderTitle,
  fallbackSessionTitle,
  isPlausibleProviderTitle,
  normalizeProviderTitle,
  resolveSessionTitle,
  shouldScheduleFirstPromptProvider,
} from '../sessionTitle';

describe('sessionTitle (DeepSeek first-prompt cadence)', () => {
  it('resolves user > provider > fallback', () => {
    expect(
      resolveSessionTitle({
        firstPrompt: 'fix the login flake',
        userLabel: 'My name',
        providerTitle: 'Login Flake',
      }),
    ).toEqual({ title: 'My name', source: 'user' });
    expect(
      resolveSessionTitle({
        firstPrompt: 'fix the login flake',
        providerTitle: 'Login Flake',
      }),
    ).toEqual({ title: 'Login Flake', source: 'provider' });
    expect(resolveSessionTitle({ firstPrompt: 'fix the login flake' }).source).toBe('fallback');
    expect(fallbackSessionTitle('fix the login flake')).toBe('fix the login flake');
  });

  it('schedules provider only for fresh non-fork non-pinned sessions', () => {
    expect(
      shouldScheduleFirstPromptProvider({ isFork: false, alreadyAttempted: false }),
    ).toBe(true);
    expect(
      shouldScheduleFirstPromptProvider({ isFork: true, alreadyAttempted: false }),
    ).toBe(false);
    expect(
      shouldScheduleFirstPromptProvider({ isFork: false, alreadyAttempted: true }),
    ).toBe(false);
    expect(
      shouldScheduleFirstPromptProvider({
        isFork: false,
        alreadyAttempted: false,
        source: 'user',
      }),
    ).toBe(false);
  });

  it('CAS: provider cannot overwrite a user pin', () => {
    expect(canAcceptProviderTitle('fallback')).toBe(true);
    expect(canAcceptProviderTitle('provider')).toBe(true);
    expect(canAcceptProviderTitle(undefined)).toBe(true);
    expect(canAcceptProviderTitle('user')).toBe(false);
  });

  it('normalizes model output', () => {
    expect(normalizeProviderTitle('Title: Login Fix\n')).toBe('Login Fix');
    expect(normalizeProviderTitle('"Auth Bug"')).toBe('Auth Bug');
  });

  it('rejects Latin gibberish titles for CJK prompts', () => {
    expect(
      isPlausibleProviderTitle('你简单说说LLM为什么会出现幻觉', 'LM ML Meter Implementation'),
    ).toBe(false);
    expect(
      isPlausibleProviderTitle(
        '你简单说说LLM为什么会出现幻觉',
        'Why LLMs May Experience Illusions',
      ),
    ).toBe(true);
    expect(isPlausibleProviderTitle('fix the login flake', 'Login Flake')).toBe(true);
  });

});
