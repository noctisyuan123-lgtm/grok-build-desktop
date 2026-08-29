import type { MessageKey } from '../i18n';

/**
 * Claude-style empty-stage greeting: local clock first, then a weekday
 * overlay. Early-bird / night-owl win over Friday/weekend copy so 6am on
 * Saturday still reads as early, not "welcome to the weekend".
 *
 * Hour windows (local):
 *   05–08  early bird
 *   08–12  morning
 *   12–17  afternoon
 *   17–21  evening
 *   21–05  night owl
 */
export function emptyGreetingKey(now: Date = new Date()): MessageKey {
  const hour = now.getHours();
  const weekday = now.getDay(); // 0 Sun … 6 Sat

  if (hour >= 5 && hour < 8) return 'emptyState.greetingEarlyBird';
  if (hour >= 21 || hour < 5) return 'emptyState.greetingNightOwl';
  if (weekday === 5 && hour >= 12) return 'emptyState.greetingFriday';
  if (weekday === 6) return 'emptyState.greetingWeekend';
  if (weekday === 0) return 'emptyState.greetingSunday';
  if (hour < 12) return 'emptyState.greetingMorning';
  if (hour < 17) return 'emptyState.greetingAfternoon';
  return 'emptyState.greetingEvening';
}
