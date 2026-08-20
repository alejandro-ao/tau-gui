import { copyFile, mkdir, stat, utimes } from 'node:fs/promises';
import { constants } from 'node:fs';
import { existsSync } from 'node:fs';
import { basename, dirname, join, relative, resolve, sep } from 'node:path';
import { SessionManager } from '@earendil-works/pi-coding-agent';
import type { SessionRef } from '../../shared/domain.js';
import type { SettingsStore } from './settings.js';

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

    return copySession(source, destination).then((result) => {
      if (result === 'migrated') {
        migrated += 1;
        changed = true;
        return { ...reference, path: destination };
      }
      if (result === 'retained') retained += 1;
      else skipped += 1;
      if (!reference.path) {
        changed = true;
        return { ...reference, path: source };
      }
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
  if (reference.path && isWithin(reference.path, legacySessionDir)) return resolve(reference.path);
  const match = sessions.find((session) => session.id === reference.id);
  return match && isWithin(match.path, legacySessionDir) ? resolve(match.path) : null;
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
  if (!isWithin(source, legacySessionDir)) return null;
  const suffix = relative(resolve(legacySessionDir), source);
  if (!suffix || suffix.startsWith(`..${sep}`) || suffix === '..') return null;
  return resolve(sessionDir, suffix);
}

function isWithin(path: string, root: string): boolean {
  const candidate = resolve(path);
  const base = resolve(root);
  return candidate === base || candidate.startsWith(`${base}${sep}`);
}

type CopyResult = 'migrated' | 'retained' | 'skipped';

async function copySession(source: string, destination: string): Promise<CopyResult> {
  if (!existsSync(source)) return 'skipped';
  try {
    const sourceInfo = await stat(source);
    if (!sourceInfo.isFile()) return 'skipped';
    if (existsSync(destination)) {
      const destinationInfo = await stat(destination);
      // A previous successful migration is safe to reuse. A different file is
      // an explicit collision and must never be overwritten.
      if (
        destinationInfo.isFile() &&
        destinationInfo.size === sourceInfo.size &&
        Math.abs(destinationInfo.mtimeMs - sourceInfo.mtimeMs) < 2
      ) {
        return 'migrated';
      }
      return 'retained';
    }
    await mkdirFor(destination);
    await copyFile(source, destination, constants.COPYFILE_EXCL);
    await utimes(destination, sourceInfo.atime, sourceInfo.mtime);
    const copiedInfo = await stat(destination);
    return copiedInfo.size === sourceInfo.size &&
      Math.abs(copiedInfo.mtimeMs - sourceInfo.mtimeMs) < 2
      ? 'migrated'
      : 'skipped';
  } catch {
    return 'skipped';
  }
}

async function mkdirFor(path: string): Promise<void> {
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
}

/** Useful in diagnostics and tests without exposing transcript contents. */
export function sessionFileName(path: string): string {
  return basename(path);
}
