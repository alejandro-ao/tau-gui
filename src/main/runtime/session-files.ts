import { constants } from 'node:fs';
import { mkdir, open, opendir, lstat, realpath } from 'node:fs/promises';
import { dirname, isAbsolute, relative, resolve, sep } from 'node:path';
import { SessionManager, type SessionInfo } from '@earendil-works/pi-coding-agent';

export const SESSION_IO_LIMITS = {
  directories: 128,
  entriesPerDirectory: 1_000,
  files: 500,
  fileBytes: 16 * 1024 * 1024,
  totalBytes: 64 * 1024 * 1024,
  milliseconds: 2_000,
  retainedArtifacts: 32,
} as const;

export interface PhysicalFile {
  path: string;
  key: string;
  size: number;
}

/**
 * Node cannot unlink relative to an already-open file handle. Never path-delete an
 * artifact after a separate ownership check: a same-user swap could make that
 * path caller-owned before unlink. Retain it and report whether ownership stayed
 * stable so bounded diagnostics can direct explicit recovery.
 */
export async function retainPhysicalFile(
  expected: PhysicalFile,
  diagnostic: (message: string) => void,
): Promise<void> {
  const current = await inspectPhysicalFile(expected.path, dirname(expected.path)).catch(
    () => null,
  );
  diagnostic(
    current?.key === expected.key && current.size === expected.size
      ? 'Retained app-created session artifact because atomic cleanup is unavailable'
      : 'Retained session artifact path after ownership became uncertain; no file was deleted',
  );
}

interface ApprovedDirectory {
  path: string;
  files: Map<string, PhysicalFile>;
}

function within(root: string, candidate: string): boolean {
  const path = relative(root, candidate);
  return path === '' || (!path.startsWith(`..${sep}`) && path !== '..' && !isAbsolute(path));
}

function deadline(started: number): void {
  if (Date.now() - started > SESSION_IO_LIMITS.milliseconds) {
    throw new Error('Session catalog metadata budget exceeded');
  }
}

export async function ensureCheckedDirectory(path: string, rootReal?: string): Promise<string> {
  await mkdir(path, { recursive: true, mode: 0o700 });
  return checkedDirectory(path, rootReal);
}

/** Refuse further staging once retained artifacts reach a finite recovery budget. */
export async function assertArtifactCapacity(directory: string): Promise<void> {
  const checked = await checkedDirectory(directory);
  const handle = await opendir(checked);
  let entries = 0;
  try {
    while ((await handle.read()) !== null) {
      entries += 1;
      if (entries >= SESSION_IO_LIMITS.retainedArtifacts) {
        throw new Error(
          'Retained import artifact budget reached; explicit staging-directory recovery is required',
        );
      }
    }
  } finally {
    await handle.close().catch(() => undefined);
  }
}

async function checkedDirectory(path: string, rootReal?: string): Promise<string> {
  const before = await lstat(path);
  if (!before.isDirectory() || before.isSymbolicLink()) throw new Error('Unsafe session directory');
  const physical = await realpath(path);
  if (rootReal && !within(rootReal, physical))
    throw new Error('Session directory escapes its root');
  const after = await lstat(path);
  if (after.dev !== before.dev || after.ino !== before.ino || after.isSymbolicLink()) {
    throw new Error('Session directory changed during validation');
  }
  return physical;
}

async function inspectDirectory(
  directory: string,
  rootReal: string,
  budget: { files: number; bytes: number },
  started: number,
): Promise<ApprovedDirectory> {
  const directoryReal = await checkedDirectory(directory, rootReal);
  const files = new Map<string, PhysicalFile>();
  const handle = await opendir(directoryReal);
  let entries = 0;
  try {
    for await (const entry of handle) {
      deadline(started);
      entries += 1;
      if (entries > SESSION_IO_LIMITS.entriesPerDirectory) {
        throw new Error('Session directory entry budget exceeded');
      }
      if (!entry.name.endsWith('.jsonl')) continue;
      const path = resolve(directoryReal, entry.name);
      if (!within(directoryReal, path) || entry.isSymbolicLink()) {
        throw new Error('Unsafe session file');
      }
      const before = await lstat(path);
      if (!before.isFile() || before.isSymbolicLink() || before.nlink !== 1) {
        throw new Error('Session file must be a singly-linked regular file');
      }
      const physical = await realpath(path);
      if (!within(directoryReal, physical)) throw new Error('Session file escapes its directory');
      if (before.size > SESSION_IO_LIMITS.fileBytes) throw new Error('Session file is too large');
      budget.files += 1;
      budget.bytes += before.size;
      if (budget.files > SESSION_IO_LIMITS.files || budget.bytes > SESSION_IO_LIMITS.totalBytes) {
        throw new Error('Session catalog file budget exceeded');
      }
      files.set(path, {
        path,
        key: `${String(before.dev)}:${String(before.ino)}`,
        size: before.size,
      });
    }
  } finally {
    await handle.close().catch(() => undefined);
  }
  return { path: directoryReal, files };
}

/**
 * Calls Pi's public listing API only after privileged metadata proves a finite input set.
 * A directory that fails any check is isolated; no SDK call is made for it.
 */
export async function boundedSessionList(root: string): Promise<{
  sessions: Array<{ info: SessionInfo; physical: PhysicalFile }>;
  diagnostics: string[];
  /** False whenever any directory or record was omitted from this bounded scan. */
  complete: boolean;
}> {
  const started = Date.now();
  const diagnostics: string[] = [];
  let rootReal: string;
  try {
    rootReal = await checkedDirectory(resolve(root));
  } catch (error) {
    return {
      sessions: [],
      diagnostics: [`Session root rejected: ${(error as Error).message}`],
      complete: false,
    };
  }

  const directoryPaths = [rootReal];
  let completeRootScan = true;
  try {
    const handle = await opendir(rootReal);
    let entries = 0;
    try {
      for await (const entry of handle) {
        deadline(started);
        entries += 1;
        if (entries > SESSION_IO_LIMITS.entriesPerDirectory) {
          throw new Error('Session root entry budget exceeded');
        }
        if (entry.isSymbolicLink() || (!entry.isDirectory() && !entry.isFile())) {
          completeRootScan = false;
          if (diagnostics.length < 20) {
            diagnostics.push('Skipped unsafe or unknown session-root child');
          }
          continue;
        }
        if (!entry.isDirectory()) continue;
        directoryPaths.push(resolve(rootReal, entry.name));
        if (directoryPaths.length > SESSION_IO_LIMITS.directories) {
          throw new Error('Session directory budget exceeded');
        }
      }
    } finally {
      await handle.close().catch(() => undefined);
    }
  } catch (error) {
    return { sessions: [], diagnostics: [(error as Error).message], complete: false };
  }

  const budget = { files: 0, bytes: 0 };
  const approved: ApprovedDirectory[] = [];
  let complete = completeRootScan;
  for (const directory of directoryPaths) {
    try {
      approved.push(await inspectDirectory(directory, rootReal, budget, started));
    } catch (error) {
      complete = false;
      diagnostics.push(`Skipped session directory: ${(error as Error).message}`);
    }
  }

  const sessions: Array<{ info: SessionInfo; physical: PhysicalFile }> = [];
  for (const directory of approved) {
    let listed: SessionInfo[];
    try {
      deadline(started);
      // Recheck every approved identity immediately before Pi opens any file.
      // The public API cannot consume handles, so a same-user mutation after this
      // point remains the narrowly documented listing residual.
      for (const approvedFile of directory.files.values()) {
        const checked = await inspectPhysicalFile(approvedFile.path, directory.path);
        if (checked.key !== approvedFile.key || checked.size !== approvedFile.size) {
          throw new Error('Session file changed before listing');
        }
      }
      // Public SDK owns JSONL parsing. Its API has no abort/file/byte budget, so calls
      // happen only for directories whose complete metadata set passed the budgets above.
      listed = await SessionManager.listAll(directory.path);
      deadline(started);
    } catch (error) {
      complete = false;
      diagnostics.push(`Skipped malformed session directory: ${(error as Error).message}`);
      continue;
    }
    const represented = new Set<string>();
    for (const info of listed) {
      try {
        deadline(started);
        if (!info || typeof info.path !== 'string') throw new Error('Malformed SDK record');
        const path = resolve(info.path);
        const physical = directory.files.get(path);
        if (!physical) throw new Error('SDK returned an unapproved path');
        if (represented.has(path)) throw new Error('SDK returned a duplicate path');
        represented.add(path);
        const checked = await inspectPhysicalFile(path, directory.path);
        if (checked.key !== physical.key || checked.size !== physical.size) {
          throw new Error('Session file changed during listing');
        }
        sessions.push({ info, physical });
      } catch (error) {
        complete = false;
        diagnostics.push(`Dropped session record: ${(error as Error).message}`);
      }
    }
    if (represented.size !== directory.files.size) {
      complete = false;
      diagnostics.push('Dropped session record: SDK omitted an approved session file');
    }
  }
  return { sessions, diagnostics, complete };
}

export async function inspectPhysicalFile(
  path: string,
  requiredRoot?: string,
): Promise<PhysicalFile> {
  const absolute = resolve(path);
  const before = await lstat(absolute);
  if (!before.isFile() || before.isSymbolicLink() || before.nlink !== 1) {
    throw new Error('Session source must be a singly-linked regular file');
  }
  if (before.size > SESSION_IO_LIMITS.fileBytes) throw new Error('Session file is too large');
  const physical = await realpath(absolute);
  if (requiredRoot && !within(resolve(requiredRoot), physical)) {
    throw new Error('Session file escapes its owned directory');
  }
  const after = await lstat(absolute);
  if (after.dev !== before.dev || after.ino !== before.ino || after.size !== before.size) {
    throw new Error('Session file changed during validation');
  }
  return { path: absolute, key: `${String(before.dev)}:${String(before.ino)}`, size: before.size };
}

interface ExclusiveCopyOptions {
  /** Test seam and future post-create initialization; may deliberately fail. */
  afterCreate?: (destination: string) => void | Promise<void>;
  onRetained?: (message: string) => void;
}

/**
 * Copy from a no-follow source handle into an exclusively-created destination.
 * Failure retains the created inode: path cleanup cannot be made atomic in Node.
 */
export async function exclusiveCopy(
  source: string,
  destination: string,
  options: ExclusiveCopyOptions = {},
): Promise<PhysicalFile> {
  const sourceHandle = await open(source, constants.O_RDONLY | constants.O_NOFOLLOW);
  let destinationHandle;
  let created = false;
  try {
    const before = await sourceHandle.stat();
    if (!before.isFile() || before.nlink !== 1 || before.size > SESSION_IO_LIMITS.fileBytes) {
      throw new Error('Import source must be a bounded singly-linked regular file');
    }
    destinationHandle = await open(
      destination,
      constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW,
      0o600,
    );
    created = true;
    await options.afterCreate?.(destination);
    const buffer = Buffer.alloc(64 * 1024);
    let position = 0;
    while (position < before.size) {
      const read = await sourceHandle.read(
        buffer,
        0,
        Math.min(buffer.length, before.size - position),
        position,
      );
      if (read.bytesRead === 0) throw new Error('Import source ended unexpectedly');
      await destinationHandle.write(buffer, 0, read.bytesRead, position);
      position += read.bytesRead;
    }
    await destinationHandle.sync();
    const [after, createdInfo] = await Promise.all([sourceHandle.stat(), destinationHandle.stat()]);
    if (after.dev !== before.dev || after.ino !== before.ino || after.size !== before.size) {
      throw new Error('Import source changed during copy');
    }
    const physical = await inspectPhysicalFile(destination, dirname(destination));
    if (
      physical.key !== `${String(createdInfo.dev)}:${String(createdInfo.ino)}` ||
      physical.size !== createdInfo.size
    ) {
      throw new Error('Import destination changed after exclusive creation');
    }
    return physical;
  } catch (error) {
    if (created) {
      options.onRetained?.(
        'Retained failed copy artifact because atomic path ownership cleanup is unavailable',
      );
    }
    throw error;
  } finally {
    await destinationHandle?.close().catch(() => undefined);
    await sourceHandle.close().catch(() => undefined);
  }
}
