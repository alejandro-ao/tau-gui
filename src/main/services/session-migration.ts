import { createHash } from 'node:crypto';
import { constants, lstatSync } from 'node:fs';
import { mkdir, open, readdir, stat, link, unlink } from 'node:fs/promises';
import { basename, dirname, join, relative, resolve, sep } from 'node:path';
import { SessionManager } from '@earendil-works/pi-coding-agent';
import type { SessionRef } from '../../shared/domain.js';
import { assertPathWithinRoot, assertPathWithoutSymlink } from './app-paths.js';
import type { SettingsStore } from './settings.js';

const NO_FOLLOW = (constants as { O_NOFOLLOW?: number }).O_NOFOLLOW ?? 0;
export const SESSION_MIGRATION_TEMP_PREFIX = '.ao-session-migration-';

export interface SessionMigrationResult {
  migrated: number;
  retained: number;
  skipped: number;
}

/**
 * Copies only sessions referenced by AO's persisted catalog. Pi remains the
 * owner of session structure; AO never parses or rewrites session JSONL.
 */
export async function migrateLegacySessions(
  settings: SettingsStore,
  legacySessionDir: string,
  sessionDir: string,
): Promise<SessionMigrationResult> {
  const recent = settings.current.recentSessions;
  if (recent.length === 0 || resolve(legacySessionDir) === resolve(sessionDir)) {
    return { migrated: 0, retained: 0, skipped: 0 };
  }
  try {
    // SessionManager.listAll follows directory symlinks. Reject symlinked
    // roots before handing either ownership boundary to the SDK.
    assertPathWithoutSymlink(legacySessionDir);
    assertPathWithoutSymlink(sessionDir);
  } catch {
    return { migrated: 0, retained: 0, skipped: recent.length };
  }

  let legacySessions: Awaited<ReturnType<typeof SessionManager.listAll>> = [];
  try {
    legacySessions = await SessionManager.listAll(legacySessionDir);
    const nested = await Promise.all(
      recent
        .filter((reference) => !reference.path && reference.cwd)
        .map(async (reference) => {
          try {
            return await SessionManager.list(
              reference.cwd!,
              legacySessionDirFor(reference.cwd!, legacySessionDir),
            );
          } catch {
            return [];
          }
        }),
    );
    legacySessions = [...legacySessions, ...nested.flat()];
  } catch {
    // A missing or unreadable legacy catalog is recoverable: keep references
    // untouched so a later retry can migrate them.
  }

  let migrated = 0;
  let retained = 0;
  let skipped = 0;
  let changed = false;
  const next = recent.map((reference) => {
    const source = sourceFor(reference, legacySessionDir, legacySessions);
    if (!source) return Promise.resolve(reference);

    const destination = destinationFor(source, legacySessionDir, sessionDir);
    if (!destination) {
      skipped += 1;
      return Promise.resolve(reference);
    }

    return copySession(source, destination, legacySessionDir, sessionDir).then((result) => {
      if (result === 'migrated') {
        migrated += 1;
        changed = true;
        return { ...reference, path: destination };
      }
      if (result === 'retained') retained += 1;
      else skipped += 1;
      // Keep the persisted reference unchanged for a collision. In
      // particular, do not silently convert an id-only reference to a
      // different destination or source path.
      return reference;
    });
  });

  const resolved = await Promise.all(next);
  if (changed) settings.update({ recentSessions: resolved });
  return { migrated, retained, skipped };
}

function sourceFor(
  reference: SessionRef,
  legacySessionDir: string,
  sessions: Awaited<ReturnType<typeof SessionManager.listAll>>,
): string | null {
  if (reference.path && isSafeLegacyPath(reference.path, legacySessionDir)) {
    return resolve(reference.path);
  }
  const match = sessions.find((session) => session.id === reference.id);
  return match && isSafeLegacyPath(match.path, legacySessionDir) ? resolve(match.path) : null;
}

function legacySessionDirFor(cwd: string, legacySessionDir: string): string {
  const safePath = `--${resolve(cwd)
    .replace(/^[/\\]/, '')
    .replace(/[/\\:]/g, '-')}--`;
  return join(resolve(legacySessionDir), safePath);
}

function destinationFor(
  source: string,
  legacySessionDir: string,
  sessionDir: string,
): string | null {
  const sourceRoot = resolve(legacySessionDir);
  if (resolve(source) === sourceRoot || !resolve(source).startsWith(`${sourceRoot}${sep}`)) {
    return null;
  }
  const suffix = relative(resolve(legacySessionDir), source);
  if (!suffix || suffix.startsWith(`..${sep}`) || suffix === '..') return null;
  const destination = resolve(sessionDir, suffix);
  try {
    assertPathWithinRoot(destination, sessionDir);
    return destination;
  } catch {
    return null;
  }
}

function isSafeLegacyPath(path: string, root: string): boolean {
  const candidate = resolve(path);
  const base = resolve(root);
  if (!(candidate !== base && candidate.startsWith(`${base}${sep}`))) return false;
  try {
    assertPathWithinRoot(candidate, base);
    return true;
  } catch {
    return false;
  }
}

type CopyResult = 'migrated' | 'retained' | 'skipped';

async function copySession(
  source: string,
  destination: string,
  sourceRoot: string,
  destinationRoot: string,
): Promise<CopyResult> {
  const destinationDirectory = dirname(destination);
  let temporary: string | null = null;
  try {
    assertOwnedPath(source, sourceRoot);
    assertOwnedPath(destination, destinationRoot);
    const sourceInfo = await statNoFollow(source);
    if (!sourceInfo?.isFile()) return 'skipped';

    await mkdirFor(destination, destinationRoot);
    await cleanTemporaryFiles(destinationDirectory, destinationRoot);
    assertOwnedPath(source, sourceRoot);
    assertOwnedPath(destination, destinationRoot);
    const destinationInfo = await statNoFollow(destination);
    if (destinationInfo) {
      // Size and timestamps are not identity. Hash the opaque bytes so a
      // same-size/same-mtime collision can never be treated as a migration.
      if (!destinationInfo.isFile()) return 'retained';
      return (await fileHash(source, sourceRoot)) === (await fileHash(destination, destinationRoot))
        ? 'migrated'
        : 'retained';
    }

    temporary = join(
      destinationDirectory,
      `${SESSION_MIGRATION_TEMP_PREFIX}${basename(destination)}-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2)}.tmp`,
    );
    assertOwnedPath(temporary, destinationRoot);
    let sourceHandle: Awaited<ReturnType<typeof open>> | undefined;
    let temporaryHandle: Awaited<ReturnType<typeof open>> | undefined;
    try {
      sourceHandle = await open(source, constants.O_RDONLY | NO_FOLLOW);
      temporaryHandle = await open(
        temporary,
        constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | NO_FOLLOW,
        0o600,
      );
      const buffer = Buffer.alloc(64 * 1024);
      let position = 0;
      while (true) {
        const { bytesRead } = await sourceHandle.read(buffer, 0, buffer.length, position);
        if (bytesRead === 0) break;
        await temporaryHandle.write(buffer, 0, bytesRead, position);
        position += bytesRead;
      }
      await temporaryHandle.chmod(0o600);
      await temporaryHandle.utimes(sourceInfo.atime, sourceInfo.mtime);
      await temporaryHandle.sync();
    } finally {
      await Promise.allSettled([sourceHandle?.close(), temporaryHandle?.close()]);
    }

    // Verify the opaque bytes after closing both handles. A source changed
    // during the copy is not installed as if it were a valid migration.
    assertOwnedPath(source, sourceRoot);
    assertOwnedPath(temporary, destinationRoot);
    if ((await fileHash(source, sourceRoot)) !== (await fileHash(temporary, destinationRoot))) {
      return 'skipped';
    }

    // A hard link is the portable same-directory atomic install that refuses
    // to overwrite an existing destination. Rename is intentionally avoided:
    // on POSIX it would replace a deliberate collision.
    assertOwnedPath(destination, destinationRoot);
    try {
      await link(temporary, destination);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
      const collision = await statNoFollow(destination);
      if (!collision?.isFile()) return 'retained';
      return (await fileHash(source, sourceRoot)) === (await fileHash(destination, destinationRoot))
        ? 'migrated'
        : 'retained';
    }
    assertOwnedPath(destination, destinationRoot);
    return (await fileHash(source, sourceRoot)) === (await fileHash(destination, destinationRoot))
      ? 'migrated'
      : 'skipped';
  } catch {
    return 'skipped';
  } finally {
    if (temporary) await unlinkIfPresent(temporary);
  }
}

function assertOwnedPath(path: string, root: string): void {
  assertPathWithinRoot(path, root);
  assertPathWithoutSymlink(path);
}

async function statNoFollow(path: string) {
  try {
    assertPathWithoutSymlink(path);
    const info = await stat(path);
    assertPathWithoutSymlink(path);
    return info;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
    return null;
  }
}

async function fileHash(path: string, root: string): Promise<string> {
  assertOwnedPath(path, root);
  const handle = await open(path, constants.O_RDONLY | NO_FOLLOW);
  try {
    const hash = createHash('sha256');
    const buffer = Buffer.alloc(64 * 1024);
    let position = 0;
    while (true) {
      const { bytesRead } = await handle.read(buffer, 0, buffer.length, position);
      if (bytesRead === 0) break;
      hash.update(buffer.subarray(0, bytesRead));
      position += bytesRead;
    }
    assertOwnedPath(path, root);
    return hash.digest('hex');
  } finally {
    await handle.close();
  }
}

async function cleanTemporaryFiles(directory: string, boundary: string): Promise<void> {
  assertOwnedPath(directory, boundary);
  let entries;
  try {
    entries = await readdir(directory, { withFileTypes: true });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return;
    throw error;
  }
  for (const entry of entries) {
    if (!entry.name.startsWith(SESSION_MIGRATION_TEMP_PREFIX) || !entry.name.endsWith('.tmp')) {
      continue;
    }
    const path = join(directory, entry.name);
    assertOwnedPath(path, boundary);
    await unlinkIfPresent(path);
  }
}

async function unlinkIfPresent(path: string): Promise<void> {
  try {
    await unlink(path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
  }
}

async function mkdirFor(path: string, boundary: string): Promise<void> {
  const target = resolve(dirname(path));
  assertPathWithinRoot(target, boundary);

  const missing: string[] = [];
  let current = target;
  while (true) {
    try {
      // Validate every existing component before creating anything below it.
      lstatSync(current);
      assertPathWithoutSymlink(current);
      break;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      missing.push(current);
      const parent = dirname(current);
      if (parent === current) throw error;
      current = parent;
    }
  }

  for (const directory of missing.reverse()) {
    await mkdir(directory, { mode: 0o700 });
    assertPathWithoutSymlink(directory);
    try {
      lstatSync(boundary);
      assertPathWithinRoot(directory, boundary);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    }
  }
}

/** Useful in diagnostics and tests without exposing transcript contents. */
export function sessionFileName(path: string): string {
  return basename(path);
}
