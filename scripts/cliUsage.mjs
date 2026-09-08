// Dev-only ACP client for `_x.ai/billing`. Same protocol as
// src-tauri/src/runs/billing.rs so Vite can show live quota without Tauri.
import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { createInterface } from 'node:readline';

const TIMEOUT_MS = 25_000;

function fail(message) {
  return {
    ok: false,
    error: message,
    creditUsagePercent: null,
    periodType: null,
    periodStart: null,
    periodEnd: null,
    onDemandCap: null,
    onDemandUsed: null,
    prepaidBalance: null,
    unifiedBilling: false,
    subscriptionTier: null,
    snapshots: [],
  };
}

function commandPath() {
  const home = homedir();
  const fallback = [
    join(home, '.local/bin'),
    join(home, '.grok/bin'),
    join(home, 'bin'),
    '/opt/homebrew/bin',
    '/usr/local/bin',
    '/usr/bin',
    '/bin',
  ].join(':');
  const path = process.env.PATH?.trim();
  return path ? `${fallback}:${path}` : fallback;
}

function resolveGrokBinary() {
  if (process.env.GROK_DESKTOP_GROK_CMD && existsSync(process.env.GROK_DESKTOP_GROK_CMD)) {
    return process.env.GROK_DESKTOP_GROK_CMD;
  }
  for (const dir of commandPath().split(':')) {
    if (!dir) continue;
    const candidate = join(dir, 'grok');
    if (existsSync(candidate)) return candidate;
  }
  return join(homedir(), '.grok/bin/grok');
}

function jsonF64(value) {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value === 'string' && value.trim() && Number.isFinite(Number(value))) {
    return Number(value);
  }
  return null;
}

function moneyVal(value) {
  if (value == null) return null;
  return jsonF64(value) ?? jsonF64(value?.val);
}

function stringField(value, key) {
  const raw = value?.[key];
  if (typeof raw !== 'string') return null;
  const trimmed = raw.trim();
  return trimmed ? trimmed : null;
}

function periodKind(raw) {
  const upper = raw.trim().toUpperCase();
  if (upper.includes('MONTH')) return 'monthly';
  if (upper.includes('WEEK')) return 'weekly';
  return raw.trim().toLowerCase();
}

export function parseBillingResult(result) {
  const config = result?.config ?? result;
  if (config == null) {
    return {
      ok: true,
      error: null,
      creditUsagePercent: 0,
      periodType: null,
      periodStart: null,
      periodEnd: null,
      onDemandCap: null,
      onDemandUsed: null,
      prepaidBalance: null,
      unifiedBilling: false,
      subscriptionTier: null,
      snapshots: [],
    };
  }
  const period = config.currentPeriod ?? {};
  const periodStart = stringField(period, 'start') ?? stringField(config, 'billingPeriodStart');
  const periodEnd = stringField(period, 'end') ?? stringField(config, 'billingPeriodEnd');
  const periodTypeRaw = stringField(period, 'type') ?? stringField(config, 'periodType');
  return {
    ok: true,
    error: null,
    creditUsagePercent: jsonF64(config.creditUsagePercent) ?? 0,
    periodType: periodTypeRaw ? periodKind(periodTypeRaw) : null,
    periodStart,
    periodEnd,
    onDemandCap: moneyVal(config.onDemandCap),
    onDemandUsed: moneyVal(config.onDemandUsed),
    prepaidBalance: moneyVal(config.prepaidBalance),
    unifiedBilling: Boolean(config.isUnifiedBillingUser),
    subscriptionTier:
      stringField(result, 'subscription_tier') ??
      stringField(result, 'subscriptionTier') ??
      stringField(config, 'subscription_tier'),
    snapshots: [],
  };
}

function rpcId(message) {
  const id = message?.id;
  if (typeof id === 'number' && Number.isFinite(id)) return id;
  if (typeof id === 'string' && id.trim()) {
    const parsed = Number(id);
    return Number.isFinite(parsed) ? parsed : null;
  }
  return null;
}

export async function fetchCliBilling() {
  const program = resolveGrokBinary();
  if (!existsSync(program)) {
    return fail(`grok CLI not found at ${program}`);
  }

  const child = spawn(program, ['agent', '--no-leader', 'stdio'], {
    cwd: homedir(),
    env: { ...process.env, PATH: commandPath() },
    stdio: ['pipe', 'pipe', 'pipe'],
  });

  const pending = new Map();

  const failWait = (error) => {
    for (const deferred of pending.values()) deferred.reject(error);
    pending.clear();
  };

  const onMessage = (message) => {
    if (message?.method && message?.id != null && child.stdin.writable) {
      child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id: message.id, result: {} })}\n`);
      return;
    }
    const id = rpcId(message);
    if (id != null && pending.has(id)) {
      pending.get(id).resolve(message);
      pending.delete(id);
    }
  };

  const stdout = createInterface({ input: child.stdout });
  stdout.on('line', (line) => {
    const trimmed = line.trim();
    if (!trimmed) return;
    try {
      onMessage(JSON.parse(trimmed));
    } catch {
      // ignore non-JSON noise
    }
  });
  child.stderr?.resume();
  child.on('error', (error) => failWait(error));
  child.on('exit', () => failWait(new Error('Grok CLI exited before billing returned')));

  const writeRpc = (id, method, params) => {
    const payload = { jsonrpc: '2.0', id, method, params };
    child.stdin.write(`${JSON.stringify(payload)}\n`);
    return new Promise((resolve, reject) => {
      pending.set(id, { resolve, reject });
    });
  };

  const timer = setTimeout(() => {
    failWait(new Error('Timed out waiting for _x.ai/billing'));
    child.kill();
  }, TIMEOUT_MS);

  try {
    const init = await writeRpc(1, 'initialize', {
      protocolVersion: 1,
      clientCapabilities: {
        fs: { readTextFile: false, writeTextFile: false },
        terminal: false,
      },
      clientInfo: { name: 'grok-build-desktop', version: 'dev' },
    });
    if (init.error) return fail(`initialize: ${JSON.stringify(init.error)}`);

    const billing = await writeRpc(2, '_x.ai/billing', {});
    if (billing.error) return fail(`_x.ai/billing: ${JSON.stringify(billing.error)}`);
    return parseBillingResult(billing.result ?? null);
  } catch (error) {
    return fail(error instanceof Error ? error.message : String(error));
  } finally {
    clearTimeout(timer);
    stdout.close();
    if (!child.killed) child.kill();
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  fetchCliBilling().then((usage) => {
    console.log(JSON.stringify(usage, null, 2));
    process.exit(usage.ok ? 0 : 1);
  });
}
