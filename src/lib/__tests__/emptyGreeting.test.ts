import { describe, expect, it } from 'vitest';
import { emptyGreetingKey } from '../emptyGreeting';

function at(isoLocalish: string): Date {
  return new Date(isoLocalish);
}

describe('emptyGreetingKey', () => {
  it('uses early-bird copy before 8am, even on a weekend', () => {
    expect(emptyGreetingKey(at('2026-08-29T06:12:00'))).toBe('emptyState.greetingEarlyBird');
    expect(emptyGreetingKey(at('2026-08-30T05:00:00'))).toBe('emptyState.greetingEarlyBird');
  });

  it('uses night-owl copy after 9pm and before 5am', () => {
    expect(emptyGreetingKey(at('2026-08-28T21:00:00'))).toBe('emptyState.greetingNightOwl');
    expect(emptyGreetingKey(at('2026-08-29T23:40:00'))).toBe('emptyState.greetingNightOwl');
    expect(emptyGreetingKey(at('2026-08-29T04:59:00'))).toBe('emptyState.greetingNightOwl');
  });

  it('uses weekday time-of-day greetings during working hours', () => {
    // 2026-08-26 is a Wednesday.
    expect(emptyGreetingKey(at('2026-08-26T09:15:00'))).toBe('emptyState.greetingMorning');
    expect(emptyGreetingKey(at('2026-08-26T12:00:00'))).toBe('emptyState.greetingAfternoon');
    expect(emptyGreetingKey(at('2026-08-26T16:59:00'))).toBe('emptyState.greetingAfternoon');
    expect(emptyGreetingKey(at('2026-08-26T17:00:00'))).toBe('emptyState.greetingEvening');
    expect(emptyGreetingKey(at('2026-08-26T20:59:00'))).toBe('emptyState.greetingEvening');
  });

  it('overlays Friday afternoon, Saturday, and Sunday once it is not night/early', () => {
    expect(emptyGreetingKey(at('2026-08-28T10:00:00'))).toBe('emptyState.greetingMorning');
    expect(emptyGreetingKey(at('2026-08-28T15:30:00'))).toBe('emptyState.greetingFriday');
    expect(emptyGreetingKey(at('2026-08-29T11:00:00'))).toBe('emptyState.greetingWeekend');
    expect(emptyGreetingKey(at('2026-08-30T14:00:00'))).toBe('emptyState.greetingSunday');
  });
});
