/**
 * Deterministic fuzzy matching for pickers and completion popups.
 *
 * A candidate matches when the query characters appear in order. Scores favour
 * prefix matches, contiguous runs, and word boundaries so the most obvious
 * candidate stays first while the user types.
 */

export function fuzzyScore(text: string, query: string): number | null {
  if (query.length === 0) return 0;
  const haystack = text.toLowerCase();
  const needle = query.toLowerCase();
  let score = 0;
  let cursor = 0;
  let previousIndex = -2;

  for (const character of needle) {
    const index = haystack.indexOf(character, cursor);
    if (index < 0) return null;
    if (index === previousIndex + 1) score += 8;
    if (index === 0) score += 12;
    const previousCharacter = index > 0 ? haystack[index - 1] : undefined;
    if (previousCharacter !== undefined && /[\s/:._-]/.test(previousCharacter)) score += 6;
    score -= Math.min(index - cursor, 6);
    previousIndex = index;
    cursor = index + 1;
  }
  // Shorter candidates win ties so exact-ish matches float up.
  return score - Math.min(haystack.length / 8, 6);
}

export interface FuzzyCandidate {
  /** Text matched against the query. */
  haystack: string;
}

/** Filters and ranks candidates, keeping the original order for equal scores. */
export function fuzzyFilter<T>(items: T[], query: string, haystack: (item: T) => string): T[] {
  const trimmed = query.trim();
  if (trimmed.length === 0) return [...items];
  const scored: { item: T; score: number; index: number }[] = [];
  items.forEach((item, index) => {
    const score = fuzzyScore(haystack(item), trimmed);
    if (score !== null) scored.push({ item, score, index });
  });
  scored.sort((left, right) => right.score - left.score || left.index - right.index);
  return scored.map((entry) => entry.item);
}
