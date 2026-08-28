import { constants } from 'node:fs';
import { mkdir, open, opendir, lstat, realpath, rm } from 'node:fs/promises';
import { dirname, isAbsolute, relative, resolve, sep } from 'node:path';
import { SessionManager, type SessionInfo } from '@earendil-works/pi-coding-agent';

export const SESSION_IO_LIMITS = {
  directories: 128,
  entriesPerDirectory: 1_000,
  files: 500,
  fileBytes: 16 * 1024 * 1024,
  totalBytes: 64 * 1024 * 1024,
  milliseconds: 2_000,
} as const;

export interface PhysicalFile {
  path: string;
  key: string;
  size: number;
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
}> {
  const started = Date.now();
  const diagnostics: string[] = [];
  let rootReal: string;
  try {
    rootReal = await checkedDirectory(resolve(root));
  } catch (error) {
    return { sessions: [], diagnostics: [`Session root rejected: ${(error as Error).message}`] };
  }

  const directoryPaths = [rootReal];
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
        if (!entry.isDirectory() || entry.isSymbolicLink()) continue;
        directoryPaths.push(resolve(rootReal, entry.name));
        if (directoryPaths.length > SESSION_IO_LIMITS.directories) {
          throw new Error('Session directory budget exceeded');
        }
      }
    } finally {
      await handle.close().catch(() => undefined);
    }
  } catch (error) {
    return { sessions: [], diagnostics: [(error as Error).message] };
  }

  const budget = { files: 0, bytes: 0 };
  const approved: ApprovedDirectory[] = [];
  for (const directory of directoryPaths) {
    try {
      approved.push(await inspectDirectory(directory, rootReal, budget, started));
    } catch (error) {
      diagnostics.push(`Skipped session directory: ${(error as Error).message}`);
    }
  }

  const sessions: Array<{ info: SessionInfo; physical: PhysicalFile }> = [];
  for (const directory of approved) {
    deadline(started);
    let listed: SessionInfo[];
    try {
      // Public SDK owns JSONL parsing. Its API has no abort/file/byte budget, so calls
      // happen only for directories whose complete metadata set passed the budgets above.
      listed = await SessionManager.listAll(directory.path);
    } catch (error) {
      diagnostics.push(`Skipped malformed session directory: ${(error as Error).message}`);
      continue;
    }
    for (const info of listed) {
      try {
        if (!info || typeof info.path !== 'string') throw new Error('Malformed SDK record');
        const path = resolve(info.path);
        const physical = directory.files.get(path);
        if (!physical) throw new Error('SDK returned an unapproved path');
        const checked = await inspectPhysicalFile(path, directory.path);
        if (checked.key !== physical.key || checked.size !== physical.size) {
          throw new Error('Session file changed during listing');
        }
        sessions.push({ info, physical });
      } catch (error) {
        diagnostics.push(`Dropped session record: ${(error as Error).message}`);
      }
    }
  }
  return { sessions, diagnostics };
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

/** Copy from a no-follow source handle into an exclusively-created destination. */
export async function exclusiveCopy(source: string, destination: string): Promise<PhysicalFile> {
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
    const after = await sourceHandle.stat();
    if (after.dev !== before.dev || after.ino !== before.ino || after.size !== before.size) {
      throw new Error('Import source changed during copy');
    }
    return inspectPhysicalFile(destination, dirname(destination));
  } catch (error) {
    if (created) await rm(destination, { force: true }).catch(() => undefined);
    throw error;
  } finally {
    await destinationHandle?.close().catch(() => undefined);
    await sourceHandle.close().catch(() => undefined);
  }
}
