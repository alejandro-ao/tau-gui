import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { beforeAll, describe, expect, it } from 'vitest';
import {
  completePaths,
  isAllowedSearchRoot,
  quoteForComposer,
  toDisplayPath,
} from '../src/main/services/filesystem.js';

let root: string;

beforeAll(() => {
  root = mkdtempSync(join(tmpdir(), 'tau-gui-fs-'));
  mkdirSync(join(root, 'src', 'deep'), { recursive: true });
  mkdirSync(join(root, 'node_modules', 'pkg'), { recursive: true });
  mkdirSync(join(root, '.git'), { recursive: true });
  writeFileSync(join(root, 'src', 'index.ts'), '');
  writeFileSync(join(root, 'src', 'deep', 'widget.tsx'), '');
  writeFileSync(join(root, '.env'), '');
  writeFileSync(join(root, 'node_modules', 'pkg', 'index.js'), '');
  writeFileSync(join(root, '.git', 'HEAD'), '');
  writeFileSync(join(root, 'name with space.md'), '');
});

describe('completePaths', () => {
  it('lists cwd-relative entries including dotfiles', async () => {
    const results = await completePaths(root, '');
    const paths = results.map((result) => result.path);
    expect(paths).toContain('src');
    expect(paths).toContain('.env');
  });

  it('skips ignored directories', async () => {
    const results = await completePaths(root, 'index');
    const paths = results.map((result) => result.path);
    expect(paths).toContain('src/index.ts');
    expect(paths.some((path) => path.includes('node_modules'))).toBe(false);
    expect(paths.some((path) => path.includes('.git/'))).toBe(false);
  });

  it('searches nested directories by name', async () => {
    const results = await completePaths(root, 'widget');
    expect(results.map((result) => result.path)).toContain('src/deep/widget.tsx');
  });

  it('honours an explicit directory prefix', async () => {
    const results = await completePaths(root, 'src/');
    expect(results.map((result) => result.path)).toContain('src/index.ts');
  });

  it('honours explicit parent traversal supplied by the user', async () => {
    const nested = join(root, 'src', 'deep');
    expect((await completePaths(nested, '../')).length).toBeGreaterThan(0);
    // Two levels up is the documented ceiling and is still allowed.
    expect((await completePaths(nested, '../../')).length).toBeGreaterThan(0);
  });

  it('refuses traversal beyond the documented ceiling', async () => {
    const nested = join(root, 'src', 'deep');
    expect(await completePaths(nested, '../../../')).toEqual([]);
    expect(await completePaths(nested, '../../../../etc/')).toEqual([]);
    expect(await completePaths(nested, '/etc/')).toEqual([]);
  });

  it('respects the result limit', async () => {
    const results = await completePaths(root, '', 2);
    expect(results).toHaveLength(2);
  });
});

describe('isAllowedSearchRoot', () => {
  it('allows the cwd subtree and bounded ancestors', () => {
    const nested = join(root, 'src', 'deep');
    expect(isAllowedSearchRoot(nested, join(nested, 'more'))).toBe(true);
    expect(isAllowedSearchRoot(nested, join(root, 'src'))).toBe(true);
    expect(isAllowedSearchRoot(nested, root)).toBe(true);
  });

  it('rejects roots further above the cwd', () => {
    const nested = join(root, 'src', 'deep');
    expect(isAllowedSearchRoot(nested, join(root, '..'))).toBe(false);
    expect(isAllowedSearchRoot(nested, '/etc')).toBe(false);
  });
});

describe('path helpers', () => {
  it('prefers relative display paths and falls back to absolute', () => {
    expect(toDisplayPath(root, join(root, 'src', 'index.ts'))).toBe('src/index.ts');
    expect(toDisplayPath(join(root, 'src'), '/etc/hosts')).toBe('/etc/hosts');
  });

  it('quotes paths containing whitespace', () => {
    expect(quoteForComposer('src/index.ts')).toBe('src/index.ts');
    expect(quoteForComposer('name with space.md')).toBe('"name with space.md"');
  });
});
