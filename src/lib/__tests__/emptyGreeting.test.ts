import { describe, expect, it } from 'vitest';
import {
  emptyGreeting,
  greetingCandidates,
  millisecondsUntilNextGreetingChange,
} from '../emptyGreeting';

describe('emptyGreeting', () => {
  it('picks a stable line from the local time window', () => {
    const noon = new Date(2026, 8, 9, 12);
    const text = emptyGreeting(noon);
    expect(greetingCandidates(noon)).toContain(text);
    expect(emptyGreeting(noon)).toBe(text);
    expect(greetingCandidates(noon, 'Ada')).toContain(emptyGreeting(noon, 'Ada'));
  });

  it('keeps weekday-only lines in the matching morning window', () => {
    const fridayMorning = new Date(2026, 8, 11, 8);
    const pool = greetingCandidates(fridayMorning);
    expect(pool).toContain('Happy Friday, Noctis');
    expect(pool).toContain('That Friday feeling, Noctis');
    expect(pool).toContain('Coffee and agents time?');
    expect(pool).not.toContain('Happy Wednesday, Noctis');
    expect(pool).not.toContain('Good afternoon, Noctis');
  });

  it('opens weekend-only morning lines on Saturday and Sunday', () => {
    const saturday = greetingCandidates(new Date(2026, 8, 12, 9));
    const sunday = greetingCandidates(new Date(2026, 8, 13, 9));
    expect(saturday).toContain('Welcome to the weekend, Noctis');
    expect(saturday).toContain('Happy Saturday, Noctis');
    expect(sunday).toContain('Sunday session, Noctis?');
    expect(sunday).toContain('Happy Sunday, Noctis');
    expect(sunday).not.toContain('Happy Saturday, Noctis');
  });

  it('never mentions Claude or Grok', () => {
    for (let day = 9; day <= 15; day += 1) {
      for (const hour of [0, 6, 12, 17, 21]) {
        for (const line of greetingCandidates(new Date(2026, 8, day, hour))) {
          expect(line.toLowerCase()).not.toMatch(/claude|grok/);
        }
      }
    }
  });

  it('schedules the next update at the next window boundary', () => {
    expect(millisecondsUntilNextGreetingChange(new Date(2026, 8, 9, 23, 59, 59, 500))).toBe(500);
    expect(millisecondsUntilNextGreetingChange(new Date(2026, 8, 9, 11, 0, 0, 0))).toBe(3_600_000);
    expect(millisecondsUntilNextGreetingChange(new Date(2026, 8, 9, 12, 0, 0, 0))).toBe(
      5 * 3_600_000,
    );
    expect(millisecondsUntilNextGreetingChange(new Date(2026, 8, 9, 21, 0, 0, 0))).toBe(
      3 * 3_600_000,
    );
  });
});
