// Pure formatting/parsing helpers shared by App and its hooks.
import type { ToolRun } from '../lib/grok';
import type { ToolStatus } from './types';

export function makeId(prefix: string) {
  return `${prefix}-${Date.now().toString(36)}-${Math.random().toString(16).slice(2, 8)}`;
}

const NOISE_MODEL_TOKENS = new Set(['models', 'available', 'default', 'custom']);

/** Current grok.com catalog used when `grok models` has not reported yet. */
export const FALLBACK_GROK_MODELS = ['grok-4.6', 'grok-4.5'];

export function parseStoredModelIds(raw: string | null | undefined): string[] {
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (!Array.isArray(parsed)) return [];
    return parsed.filter(
      (id): id is string =>
        typeof id === 'string' &&
        /^[\w./:@-]+$/.test(id) &&
        !NOISE_MODEL_TOKENS.has(id.toLowerCase()),
    );
  } catch {
    return [];
  }
}

export function resolveModelOptions(availableModels: readonly string[], stored: readonly string[]): string[] {
  const fromCli = availableModels.filter(
    (value) => value && !NOISE_MODEL_TOKENS.has(value.toLowerCase()),
  );
  if (fromCli.length > 0) return Array.from(new Set(fromCli));
  if (stored.length > 0) return Array.from(new Set(stored));
  return [...FALLBACK_GROK_MODELS];
}

export function parseAvailableModels(output: string): string[] {
  if (!output.trim()) return [];
  const models = new Set<string>();
  const defaultId = output.match(/^\s*Default model:\s*([\w./:@-]+)/im)?.[1];
  if (defaultId) models.add(defaultId);

  const lines = output.split('\n');
  const start = lines.findIndex((line) => /available models/i.test(line));
  if (start < 0) return Array.from(models);
  let sawItem = false;
  for (let index = start + 1; index < lines.length; index += 1) {
    const line = lines[index];
    if (!line.trim()) {
      if (sawItem) break;
      continue;
    }
    const match =
      line.match(/^\s*[*\-•·●✓✔]\s*([\w./:@-]+)/) ??
      line.match(/^\s+(grok[\w./:@-]*)\b/i);
    if (!match) {
      if (sawItem) break;
      continue;
    }
    if (NOISE_MODEL_TOKENS.has(match[1].toLowerCase())) continue;
    models.add(match[1]);
    sawItem = true;
  }
  return Array.from(models);
}

export function timeLabel(ts: number) {
  try {
    return new Date(ts).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  } catch {
    return '';
  }
}

/** Compact duration for settings usage: "47 min", "3h", "3h 12m". */
export function formatRunDuration(ms: number): string {
  const totalMin = Math.max(0, Math.round(ms / 60_000));
  if (totalMin < 1) return 'under 1 min';
  const hours = Math.floor(totalMin / 60);
  const mins = totalMin % 60;
  if (hours === 0) return `${totalMin} min`;
  if (mins === 0) return `${hours}h`;
  return `${hours}h ${mins}m`;
}

/** CLI `/usage` reset timestamp, e.g. "Sep 1, 5:58 PM". */
export function formatUsageReset(iso: string | null | undefined): string {
  if (!iso) return '';
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return iso;
  return date.toLocaleString(undefined, {
    month: 'short',
    day: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
  });
}

/** Dollar amounts from grok billing `val` fields. */
export function formatUsdAmount(n: number | null | undefined): string {
  if (n == null || !Number.isFinite(n)) return '—';
  if (Math.abs(n - Math.round(n)) < 1e-9) return `$${Math.round(n)}`;
  return `$${n.toFixed(2)}`;
}

export function nativeUnavailable(command: string): ToolRun {
  return {
    ok: false,
    command,
    cwd: '',
    exit_code: null,
    duration_ms: 0,
    timed_out: false,
    output: '',
    stderr: 'Native commands are available in the Tauri desktop window. Run npm run tauri:dev.',
  };
}

export function formatOutput(run: ToolRun | null, terminalOutput = '') {
  if (terminalOutput.trim()) return terminalOutput;
  if (!run) return 'No run yet.';
  const output = run.output.trim();
  const stderr = run.stderr.trim();

  if (!output && !stderr) return 'Command finished without output.';
  if (run.ok && output) return output;
  if (!output) return stderr;
  if (!stderr) return output;
  return `${output}\n\nstderr:\n${stderr}`;
}

export function terminalClass(line: string) {
  if (line.startsWith('[err]')) return 'terminal-line terminal-error';
  if (line.startsWith('[sys]')) return 'terminal-line terminal-system';
  if (
    line.includes('```') ||
    line.includes('diff --git') ||
    line.includes('@@') ||
    /^\[out\]\s{2,}/.test(line) ||
    /^\[out\]\s[+-]/.test(line)
  ) {
    return 'terminal-line terminal-code';
  }
  return 'terminal-line';
}

export function terminalText(line: string) {
  return line.replace(/^\[(out|err|sys)\]\s?/, '');
}

export function terminalPrefix(line: string) {
  const match = line.match(/^\[(out|err|sys)\]/);
  return match?.[1] ?? 'out';
}

export function statusTone(status?: ToolStatus) {
  if (!status) return 'idle';
  return status.installed ? 'ready' : 'missing';
}

export function grokInspectCount(output: string, label: string) {
  const match = output.match(new RegExp(`${label} \\((\\d+)\\)`));
  return match?.[1] ?? '0';
}

export function grokInspectSection(output: string, label: string, limit = 8) {
  const lines = output.split('\n');
  const headings = [
    'Skills',
    'Agents',
    'Plugins',
    'Marketplaces',
    'MCP Servers',
    'Hooks',
    'Config Sources',
    'Permissions',
  ];
  const start = lines.findIndex((line) => line.trim().startsWith(`${label} (`));
  if (start < 0) return [];

  const items: string[] = [];
  for (let index = start + 1; index < lines.length; index += 1) {
    const trimmed = lines[index].trim();
    if (!trimmed) {
      if (items.length > 0) break;
      continue;
    }

    if (headings.some((heading) => trimmed.startsWith(`${heading} (`))) break;

    const item = trimmed
      .replace(/^[-•]\s*/, '')
      .replace(/^\d+[.)]\s*/, '')
      .replace(/\s+/g, ' ');
    if (item) items.push(item);
    if (items.length >= limit) break;
  }

  return items;
}

export function grokInspectLine(output: string, pattern: RegExp, fallback = 'unknown') {
  return output.match(pattern)?.[1]?.trim() ?? fallback;
}

export function grokTrust(output: string) {
  const match = output.match(/Project trusted:\s*(yes|no)/i);
  return match?.[1] ?? 'unknown';
}
