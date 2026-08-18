import { describe, expect, it } from 'vitest';
import {
  applyCompletion,
  insertPaths,
  pathQuery,
  slashQuery,
  tokenAt,
} from '../../src/renderer/src/components/completion/tokens.js';

describe('composer tokens', () => {
  it('finds the whitespace-delimited token under the cursor', () => {
    expect(tokenAt('read @src/app.ts now', 12)).toEqual({
      start: 5,
      end: 16,
      text: '@src/app.ts',
    });
    expect(tokenAt('', 0)).toEqual({ start: 0, end: 0, text: '' });
  });

  it('detects @ path queries only for the token under the cursor', () => {
    expect(pathQuery('look at @src/a', 14)?.query).toBe('src/a');
    expect(pathQuery('look at @src/a', 4)).toBeNull();
  });

  it('detects slash queries only in the first token', () => {
    expect(slashQuery('/mod', 4)).toBe('/mod');
    expect(slashQuery('/model now', 9)).toBeNull();
    expect(slashQuery('hello /model', 12)).toBeNull();
  });

  it('replaces the completed token and returns the caret position', () => {
    const token = tokenAt('see @a', 6);
    expect(applyCompletion('see @a', token, '"a b.ts" ')).toEqual({
      text: 'see "a b.ts" ',
      cursor: 13,
    });
  });

  it('inserts dropped paths at the cursor with quoting and spacing', () => {
    expect(insertPaths('check', 5, ['src/a.ts', 'a b.ts'])).toEqual({
      text: 'check src/a.ts "a b.ts"',
      cursor: 23,
    });
    expect(insertPaths('a  b', 2, ['x.ts'])).toEqual({ text: 'a x.ts b', cursor: 6 });
    expect(insertPaths('keep', 2, [])).toEqual({ text: 'keep', cursor: 2 });
  });
});
