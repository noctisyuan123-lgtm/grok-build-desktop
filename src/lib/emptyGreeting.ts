/** The display name shown by the daily Claude-style welcome. */
export const EMPTY_GREETING_NAME = 'Noctis';

/**
 * Claude's live greeting is remotely configured. The visible rule in the
 * desktop client is a personal day-of-week salutation, so keep the local
 * version deterministic and refresh it at the next local midnight.
 */
export function emptyGreeting(date: Date, name = EMPTY_GREETING_NAME): string {
  const weekday = new Intl.DateTimeFormat('en-US', { weekday: 'long' }).format(date);
  return `Happy ${weekday}, ${name}`;
}

export function millisecondsUntilNextLocalDay(date: Date): number {
  const next = new Date(date);
  next.setHours(24, 0, 0, 0);
  return Math.max(1, next.getTime() - date.getTime());
}
