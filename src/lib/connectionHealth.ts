import type { RunState } from './streamStore';

/** No thought/text/activity for this long → show "Waiting for network…". */
export const STALL_MS = 20_000;
/** Tools can be silent longer than a model stream. */
export const STALL_TOOL_MS = 90_000;
/** Still silent after this → treat the ACP hang as a network failure. */
export const GIVE_UP_MS = 60_000;
export const GIVE_UP_TOOL_MS = 180_000;

export type ConnectionAppearance = 'ok' | 'stalled' | 'reconnecting' | 'disconnected';

export function silenceMs(
  now: number,
  lastEventAt?: number | null,
  startedAt?: number | null,
): number {
  const origin = lastEventAt ?? startedAt ?? now;
  return Math.max(0, now - origin);
}

export function hasRunningTool(traces: { status: string }[] | undefined): boolean {
  return Boolean(traces?.some((trace) => trace.status === 'running'));
}

export function deriveConnection(input: {
  now: number;
  online: boolean;
  inFlight: boolean;
  lastEventAt?: number | null;
  startedAt?: number | null;
  hasRunningTool?: boolean;
  retryAttempt?: number | null;
}): ConnectionAppearance {
  if (!input.inFlight) return 'ok';
  if (!input.online) return 'disconnected';
  if ((input.retryAttempt ?? 0) > 0) return 'reconnecting';
  const silentFor = silenceMs(input.now, input.lastEventAt, input.startedAt);
  const stallAfter = input.hasRunningTool ? STALL_TOOL_MS : STALL_MS;
  if (silentFor >= stallAfter) return 'stalled';
  return 'ok';
}

/** True when a live run has been silent long enough to cancel the zombie. */
export function shouldGiveUp(input: {
  now: number;
  online: boolean;
  inFlight: boolean;
  lastEventAt?: number | null;
  startedAt?: number | null;
  hasRunningTool?: boolean;
}): boolean {
  if (!input.inFlight || !input.online) return false;
  const silentFor = silenceMs(input.now, input.lastEventAt, input.startedAt);
  const giveUpAfter = input.hasRunningTool ? GIVE_UP_TOOL_MS : GIVE_UP_MS;
  return silentFor >= giveUpAfter;
}

const NETWORK_RE =
  /econnreset|econnrefused|enotfound|eai_again|etimedout|timed out|timeout|network|offline|proxy|socket is closed|connection (refused|reset|lost|closed|dropped)|disconnected|no internet|unreachable|failed to fetch|dns/i;

export function isNetworkFailure(error: string | null | undefined): boolean {
  if (!error) return false;
  return NETWORK_RE.test(error);
}

export function networkGiveUpError(): string {
  return 'Disconnected from the model';
}

export function isInFlightState(state: RunState | undefined): boolean {
  return state === 'queued' || state === 'running';
}
