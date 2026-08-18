import { quotePath } from '../../../../shared/paths.js';

export interface Token {
  start: number;
  end: number;
  text: string;
}

/** Whitespace-delimited token containing the cursor. */
export function tokenAt(text: string, cursor: number): Token {
  const position = Math.max(0, Math.min(cursor, text.length));
  let start = position;
  while (start > 0) {
    const character = text[start - 1];
    if (character === undefined || /\s/.test(character)) break;
    start -= 1;
  }
  let end = position;
  while (end < text.length) {
    const character = text[end];
    if (character === undefined || /\s/.test(character)) break;
    end += 1;
  }
  return { start, end, text: text.slice(start, end) };
}

/** `@`-prefixed token under the cursor, if any. */
export function pathQuery(text: string, cursor: number): { token: Token; query: string } | null {
  const token = tokenAt(text, cursor);
  if (!token.text.startsWith('@')) return null;
  return { token, query: token.text.slice(1) };
}

/**
 * Slash-command query.
 *
 * Only the first token of the draft may be a command, matching Tau, and the
 * cursor must still be inside it.
 */
export function slashQuery(text: string, cursor: number): string | null {
  if (!text.startsWith('/')) return null;
  const token = tokenAt(text, cursor);
  if (token.start !== 0) return null;
  return token.text;
}

/** Replaces a token, returning the new text and cursor position. */
export function applyCompletion(
  text: string,
  token: Token,
  insertion: string,
): { text: string; cursor: number } {
  const next = `${text.slice(0, token.start)}${insertion}${text.slice(token.end)}`;
  return { text: next, cursor: token.start + insertion.length };
}

/**
 * Inserts dropped or completed paths at the cursor, quoting where needed and
 * preserving the surrounding draft.
 */
export function insertPaths(
  text: string,
  cursor: number,
  paths: string[],
): { text: string; cursor: number } {
  const position = Math.max(0, Math.min(cursor, text.length));
  const quoted = paths.map(quotePath).join(' ');
  if (quoted.length === 0) return { text, cursor: position };
  const before = text.slice(0, position);
  const after = text.slice(position);
  const prefix = before.length > 0 && !/\s$/.test(before) ? ' ' : '';
  const suffix = after.length === 0 || /^\s/.test(after) ? '' : ' ';
  const insertion = `${prefix}${quoted}${suffix}`;
  return { text: `${before}${insertion}${after}`, cursor: position + insertion.length };
}
