import type { RunUsage } from './traceParser';

/** CJK / kana / hangul / fullwidth — BPE usually spends ~1–1.5 tokens each. */
function isCjk(code: number): boolean {
  return (
    (code >= 0x3000 && code <= 0x303f) ||
    (code >= 0x3400 && code <= 0x9fff) ||
    (code >= 0x3040 && code <= 0x30ff) ||
    (code >= 0xac00 && code <= 0xd7af) ||
    (code >= 0xff00 && code <= 0xffef)
  );
}

/**
 * Live stand-in for Grok's tokenizer until an official `usage` line arrives.
 * `chars/4` is English-calibrated and undercounts Chinese by 4–8×.
 */
export function estimateTokensFromText(text: string): number {
  if (!text) return 0;
  let cjk = 0;
  let other = 0;
  for (const ch of text) {
    const code = ch.codePointAt(0);
    if (code == null) continue;
    if (code <= 32) continue;
    if (isCjk(code)) cjk += 1;
    else other += 1;
  }
  return Math.max(0, Math.round(cjk / 1.5 + other / 4));
}

/** Generated tokens this turn: official output+reasoning, else a live estimate. */
export function liveGeneratedTokens(input: {
  usage?: RunUsage | null;
  thoughtText?: string;
  responseText?: string;
}): number {
  const official = (input.usage?.outputTokens ?? 0) + (input.usage?.thoughtTokens ?? 0);
  if (official > 0) return official;
  return estimateTokensFromText(`${input.thoughtText ?? ''}${input.responseText ?? ''}`);
}

export function formatTokenCount(tokens: number): string {
  if (tokens >= 1000) return `${(tokens / 1000).toFixed(1)}k`;
  return String(Math.round(tokens));
}

/** tok/s from generated tokens over generation elapsed (not tool-wait wall time). */
export function formatTokPerSec(tokens: number, elapsedMs: number | null): string | null {
  if (elapsedMs == null || elapsedMs < 400) return null;
  const perSec = tokens / (elapsedMs / 1000);
  if (perSec < 0.05) return null;
  const rate = perSec >= 10 ? String(Math.round(perSec)) : perSec.toFixed(1);
  return `${rate} tok/s`;
}

export function thoughtTextFromTranscript(
  transcript: Array<{ kind: string; text?: string }> | undefined,
): string {
  if (!transcript?.length) return '';
  let out = '';
  for (const segment of transcript) {
    if (segment.kind === 'thought' && segment.text) out += segment.text;
  }
  return out;
}
