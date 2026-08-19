const CHARACTERS_PER_TOKEN = 4;

/** Deterministic provider-neutral estimate; no tokenizer or skill content leaves main. */
export function estimateTextTokens(text: string): number {
  if (text.length === 0) return 0;
  return Math.ceil([...text].length / CHARACTERS_PER_TOKEN);
}

/** Concise approximate count for derived resource footprints: `~2k tokens`. */
export function formatApproximateTokens(value: number): string {
  const count = Number.isFinite(value) ? Math.max(0, value) : 0;
  if (count >= 1_000_000) return `~${compactDecimal(count / 1_000_000)}m tokens`;
  if (count >= 1_000) return `~${compactDecimal(count / 1_000)}k tokens`;
  return `~${Math.round(count)} tokens`;
}

function compactDecimal(value: number): string {
  return value.toFixed(1).replace(/\.0$/, '');
}
