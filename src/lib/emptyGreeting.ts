/** The display name shown by the daily Claude-style welcome. */
export const EMPTY_GREETING_NAME = 'Noctis';

type Weekday =
  | 'Monday'
  | 'Tuesday'
  | 'Wednesday'
  | 'Thursday'
  | 'Friday'
  | 'Saturday'
  | 'Sunday';

interface GreetingTemplate {
  text: string;
  days?: Weekday[];
  /** Inclusive local hour. */
  startHour: number;
  /** Exclusive local hour. If less than `startHour`, the range wraps midnight. */
  endHour: number;
}

/**
 * Claude's live greeting is remotely configured. The pool and hour/day
 * filters below follow the desktop client's published templates; the one
 * branded line uses "agents" instead of a product name.
 */
const GREETINGS: GreetingTemplate[] = [
  { text: 'Good morning, {name}', startHour: 6, endHour: 12 },
  { text: 'Welcome, {name}', startHour: 6, endHour: 12 },
  { text: 'Hey there, {name}', startHour: 6, endHour: 12 },
  { text: 'Happy Monday, {name}', days: ['Monday'], startHour: 6, endHour: 12 },
  { text: 'Happy Tuesday, {name}', days: ['Tuesday'], startHour: 6, endHour: 12 },
  { text: 'Happy Wednesday, {name}', days: ['Wednesday'], startHour: 6, endHour: 12 },
  { text: 'Happy Thursday, {name}', days: ['Thursday'], startHour: 6, endHour: 12 },
  { text: 'Happy Friday, {name}', days: ['Friday'], startHour: 6, endHour: 12 },
  { text: 'That Friday feeling, {name}', days: ['Friday'], startHour: 6, endHour: 12 },
  {
    text: 'Welcome to the weekend, {name}',
    days: ['Saturday', 'Sunday'],
    startHour: 6,
    endHour: 12,
  },
  { text: 'Happy Saturday, {name}', days: ['Saturday'], startHour: 6, endHour: 12 },
  {
    text: 'What\u2019s on your mind, {name}?',
    days: ['Saturday', 'Sunday'],
    startHour: 6,
    endHour: 12,
  },
  { text: 'Sunday session, {name}?', days: ['Sunday'], startHour: 6, endHour: 12 },
  { text: 'Happy Sunday, {name}', days: ['Sunday'], startHour: 6, endHour: 12 },
  { text: 'Good afternoon, {name}', startHour: 12, endHour: 17 },
  { text: 'Hi {name}, how are you?', startHour: 12, endHour: 17 },
  { text: 'What\u2019s new, {name}?', startHour: 12, endHour: 17 },
  { text: 'Back at it, {name}', startHour: 12, endHour: 17 },
  { text: '{name} returns!', startHour: 17, endHour: 21 },
  { text: 'Good evening, {name}', startHour: 17, endHour: 21 },
  { text: 'Evening, {name}', startHour: 17, endHour: 21 },
  { text: 'How was your day, {name}?', startHour: 17, endHour: 21 },
  { text: 'How\u2019s it going, {name}?', startHour: 21, endHour: 6 },
  { text: 'Coffee and agents time?', startHour: 6, endHour: 12 },
  { text: 'What\u2019s on your mind tonight?', startHour: 21, endHour: 6 },
  { text: 'Hello, night owl', startHour: 21, endHour: 6 },
];

const REFRESH_HOURS = [0, 6, 12, 17, 21];

function weekdayName(date: Date): Weekday {
  return new Intl.DateTimeFormat('en-US', { weekday: 'long' }).format(date) as Weekday;
}

function hourInRange(hour: number, startHour: number, endHour: number): boolean {
  if (startHour < endHour) return hour >= startHour && hour < endHour;
  return hour >= startHour || hour < endHour;
}

function matches(template: GreetingTemplate, date: Date): boolean {
  if (template.days && !template.days.includes(weekdayName(date))) return false;
  return hourInRange(date.getHours(), template.startHour, template.endHour);
}

function render(template: string, name: string): string {
  return template.replace(/\{name\}/g, name);
}

function greetingSlot(date: Date): number {
  const hour = date.getHours();
  if (hour >= 21 || hour < 6) return 0;
  if (hour < 12) return 1;
  if (hour < 17) return 2;
  return 3;
}

/** Stable pick for a local calendar day + time window so re-renders do not flicker. */
function pickStable(pool: string[], date: Date): string {
  const y = date.getFullYear();
  const m = date.getMonth() + 1;
  const d = date.getDate();
  const slot = greetingSlot(date);
  let n = (y * 397) ^ (m * 31) ^ (d * 17) ^ (slot * 13);
  n = Math.imul(n ^ (n >>> 16), 0x45d9f3b);
  n = Math.imul(n ^ (n >>> 16), 0x45d9f3b);
  n = (n ^ (n >>> 16)) >>> 0;
  return pool[n % pool.length] ?? pool[0] ?? '';
}

export function greetingCandidates(date: Date, name = EMPTY_GREETING_NAME): string[] {
  return GREETINGS.filter((template) => matches(template, date)).map((template) =>
    render(template.text, name),
  );
}

export function emptyGreeting(date: Date, name = EMPTY_GREETING_NAME): string {
  const pool = greetingCandidates(date, name);
  return pickStable(pool, date);
}

/**
 * Next local midnight or time-window boundary (06 / 12 / 17 / 21), whichever
 * comes first — the pool changes at those hours, and the pick re-rolls at
 * midnight even when the late-night window continues.
 */
export function millisecondsUntilNextGreetingChange(date: Date): number {
  const hour = date.getHours();
  const next = new Date(date);
  const nextHour = REFRESH_HOURS.find((boundary) => boundary > hour) ?? 24;
  next.setHours(nextHour, 0, 0, 0);
  return Math.max(1, next.getTime() - date.getTime());
}
