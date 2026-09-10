import { describe, expect, it } from 'vitest';
import { estimateTokensFromText, formatTokPerSec, liveGeneratedTokens } from '../tokenEstimate';

describe('estimateTokensFromText', () => {
  it('uses ~4 chars per token for English', () => {
    expect(estimateTokensFromText('abcd'.repeat(25))).toBe(25);
  });

  it('does not undercount Chinese the way chars/4 does', () => {
    const zh = '权重齐了还不等于能跑。';
    const naive = Math.round(zh.length / 4);
    const estimated = estimateTokensFromText(zh);
    expect(estimated).toBeGreaterThan(naive);
    expect(estimated).toBeGreaterThanOrEqual(6);
  });
});

describe('liveGeneratedTokens', () => {
  it('prefers official output plus reasoning over the live estimate', () => {
    expect(
      liveGeneratedTokens({
        usage: {
          inputTokens: 100,
          outputTokens: 40,
          thoughtTokens: 12,
          cacheReadTokens: 0,
          cacheWriteTokens: 0,
          totalTokens: 152,
        },
        responseText: 'hello world this is a long enough english line',
      }),
    ).toBe(52);
  });
});

describe('formatTokPerSec', () => {
  it('hides until the sample is long enough', () => {
    expect(formatTokPerSec(100, 200)).toBeNull();
    expect(formatTokPerSec(100, 1_000)).toBe('100 tok/s');
  });
});
