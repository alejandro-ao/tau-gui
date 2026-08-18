import { readdir } from 'node:fs/promises';
import { homedir } from 'node:os';
import { isAbsolute, join, relative, resolve, sep } from 'node:path';
import { quotePath } from '../../shared/paths.js';
import type { FileCompletion } from '../../shared/ipc.js';

const SKIP_DIRECTORIES = new Set([
  '.git',
  '.venv',
  'node_modules',
  '__pycache__',
  'build',
  'dist',
  '.mypy_cache',
  '.pytest_cache',
  '.next',
  'out',
]);

const MAX_RESULTS = 60;
const MAX_VISITED_DIRECTORIES = 400;
/** How many levels above the session cwd `../` traversal may reach. */
export const MAX_PARENT_LEVELS = 2;

/**
 * True when `target` is inside `root` (or equal to it).
 */
function isInside(root: string, target: string): boolean {
  const relativePath = relative(root, target);
  return (
    relativePath === '' ||
    (!relativePath.startsWith(`..${sep}`) && relativePath !== '..' && !isAbsolute(relativePath))
  );
}

/**
 * Bound on user-supplied `../` traversal: a completion root is allowed when it
 * stays within `MAX_PARENT_LEVELS` above the session cwd and still inside the
 * user's home directory. Anything further (or outside home) is refused.
 */
export function isAllowedSearchRoot(cwd: string, searchRoot: string): boolean {
  const absoluteCwd = resolve(cwd);
  if (isInside(absoluteCwd, searchRoot)) return true;

  let ceiling = absoluteCwd;
  for (let level = 0; level < MAX_PARENT_LEVELS; level += 1) {
    const parent = resolve(ceiling, '..');
    if (parent === ceiling) break;
    ceiling = parent;
  }
  if (!isInside(ceiling, searchRoot)) return false;

  const home = resolve(homedir());
  // Outside home, only the cwd subtree and its allowed ancestors are reachable.
  return isInside(home, searchRoot) || isInside(searchRoot, absoluteCwd);
}

/**
 * Constrained `@` completion. Searches cwd-relative paths only, including
 * dotfiles, honouring explicit `../` traversal supplied by the user up to
 * `MAX_PARENT_LEVELS` above the cwd; deeper escapes return no results.
 */
export async function completePaths(
  cwd: string,
  query: string,
  limit = MAX_RESULTS,
): Promise<FileCompletion[]> {
  const normalizedQuery = query.replaceAll('\\', '/');
  const lastSlash = normalizedQuery.lastIndexOf('/');
  const dirPart = lastSlash >= 0 ? normalizedQuery.slice(0, lastSlash + 1) : '';
  const namePart = (
    lastSlash >= 0 ? normalizedQuery.slice(lastSlash + 1) : normalizedQuery
  ).toLowerCase();

  const searchRoot = resolve(cwd, dirPart);
  if (!isAllowedSearchRoot(cwd, searchRoot)) return [];
  const results: FileCompletion[] = [];
  const queue: { dir: string; depth: number }[] = [{ dir: searchRoot, depth: 0 }];
  let visited = 0;

  while (queue.length > 0 && results.length < limit && visited < MAX_VISITED_DIRECTORIES) {
    const next = queue.shift();
    if (!next) break;
    visited += 1;
    let entries;
    try {
      entries = await readdir(next.dir, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      if (entry.isDirectory() && SKIP_DIRECTORIES.has(entry.name)) continue;
      const absolute = join(next.dir, entry.name);
      const display = toDisplayPath(cwd, absolute);
      const matches =
        namePart.length === 0 ||
        entry.name.toLowerCase().includes(namePart) ||
        display.toLowerCase().includes(namePart);
      if (matches && results.length < limit) {
        results.push({ path: display, isDirectory: entry.isDirectory() });
      }
      // Only recurse when the user is actively searching by name.
      if (entry.isDirectory() && namePart.length > 0 && next.depth < 4) {
        queue.push({ dir: absolute, depth: next.depth + 1 });
      }
    }
  }

  results.sort((a, b) => {
    if (a.isDirectory !== b.isDirectory) return a.isDirectory ? -1 : 1;
    return a.path.length - b.path.length || a.path.localeCompare(b.path);
  });
  return results.slice(0, limit);
}

/** Prefer cwd-relative display paths, fall back to absolute for outside paths. */
export function toDisplayPath(cwd: string, absolutePath: string): string {
  const relativePath = relative(cwd, absolutePath);
  if (!relativePath) return '.';
  if (relativePath.startsWith(`..${sep}`) || relativePath === '..' || isAbsolute(relativePath)) {
    return absolutePath;
  }
  return relativePath.split(sep).join('/');
}

/** Quote a dropped or completed path for insertion into the composer. */
export function quoteForComposer(path: string): string {
  return quotePath(path);
}
