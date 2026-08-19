import { describe, expect, it } from 'vitest';
import { estimateTextTokens, formatApproximateTokens } from '../src/shared/token-estimate.js';

describe('skill token estimates', () => {
  it('deterministically estimates one token per four text characters', () => {
    expect(estimateTextTokens('')).toBe(0);
    expect(estimateTextTokens('1234')).toBe(1);
    expect(estimateTextTokens('12345')).toBe(2);
    expect(estimateTextTokens('😀😀😀😀')).toBe(1);
  });

  it('formats approximate totals compactly', () => {
    expect(formatApproximateTokens(616)).toBe('~616 tokens');
    expect(formatApproximateTokens(2_000)).toBe('~2k tokens');
    expect(formatApproximateTokens(2_250)).toBe('~2.3k tokens');
  });
});
