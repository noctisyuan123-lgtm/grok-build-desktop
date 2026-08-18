import { streamStore } from './streamStore';

interface ParseResponse {
  runId: string;
  html: string;
}

let worker: Worker | null = null;
const latestByRun = new Map<string, string>();
const inflight = new Set<string>();
// Streaming Markdown is whole-document parsing. Keep it off the hot path:
// intermediate renders are trailing-edge throttled, while the terminal parse
// can still be requested immediately for an exact final document.
const MIN_PARSE_INTERVAL_MS = 250;
const lastParseAt = new Map<string, number>();
const parseTimers = new Map<string, ReturnType<typeof setTimeout>>();

function ensureWorker(): Worker | null {
  if (typeof Worker === 'undefined') return null;
  if (!worker) {
    try {
      worker = new Worker(new URL('./markdown.worker.ts', import.meta.url), { type: 'module' });
      worker.addEventListener('message', (e: MessageEvent<ParseResponse>) => {
        const { runId, html } = e.data;
        streamStore.setHtml(runId, html);
        inflight.delete(runId);
        if (latestByRun.has(runId)) {
          const next = latestByRun.get(runId)!;
          latestByRun.delete(runId);
          postParse(runId, next);
        }
      });
      worker.addEventListener('error', (err) => {
        console.warn('markdown.worker error, disabling worker fast path', err);
        worker = null;
        // The dead worker will never pump the queues: clear the in-flight
        // marks (otherwise those runIds are stuck raw forever) and re-drive
        // any stashed texts through a fresh worker. postParse returns
        // harmlessly if construction keeps failing.
        inflight.clear();
        const pending = Array.from(latestByRun.entries());
        latestByRun.clear();
        parseTimers.forEach((timer) => clearTimeout(timer));
        parseTimers.clear();
        for (const [id, text] of pending) postParse(id, text);
      });
    } catch (err) {
      console.warn('failed to construct markdown worker', err);
      worker = null;
    }
  }
  return worker;
}

function postParse(runId: string, text: string): void {
  const w = ensureWorker();
  if (!w) return; // Worker unavailable; MessageItem renders raw text fallback.
  inflight.add(runId);
  lastParseAt.set(runId, Date.now());
  w.postMessage({ runId, text });
}

function flushParked(runId: string): void {
  parseTimers.delete(runId);
  if (inflight.has(runId)) return;
  const text = latestByRun.get(runId);
  if (text === undefined) return;
  latestByRun.delete(runId);
  postParse(runId, text);
}

export function scheduleMarkdownParse(
  runId: string,
  text: string,
  options: { immediate?: boolean } = {},
): void {
  if (inflight.has(runId)) {
    latestByRun.set(runId, text);
    return;
  }
  if (options.immediate) {
    const timer = parseTimers.get(runId);
    if (timer) clearTimeout(timer);
    parseTimers.delete(runId);
    latestByRun.delete(runId);
    postParse(runId, text);
    return;
  }
  const elapsed = Date.now() - (lastParseAt.get(runId) ?? 0);
  if (elapsed < MIN_PARSE_INTERVAL_MS) {
    latestByRun.set(runId, text);
    if (!parseTimers.has(runId)) {
      parseTimers.set(
        runId,
        setTimeout(() => flushParked(runId), MIN_PARSE_INTERVAL_MS - elapsed),
      );
    }
    return;
  }
  postParse(runId, text);
}
