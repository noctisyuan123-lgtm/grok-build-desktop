import { describe, expect, it } from 'vitest';
import { emptyGreeting, millisecondsUntilNextLocalDay } from '../emptyGreeting';

describe('emptyGreeting', () => {
  it('uses the local weekday and configured display name', () => {
    expect(emptyGreeting(new Date(2026, 8, 9, 12))).toBe('Happy Wednesday, Noctis');
    expect(emptyGreeting(new Date(2026, 8, 10, 12), 'Ada')).toBe('Happy Thursday, Ada');
  });

  it('schedules the next update just after local midnight', () => {
    expect(millisecondsUntilNextLocalDay(new Date(2026, 8, 9, 23, 59, 59, 500))).toBe(500);
  });
});
