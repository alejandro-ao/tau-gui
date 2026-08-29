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
  mtimeNs: string;
  ctimeNs: string;
}

function samePhysicalGeneration(left: PhysicalFile, right: PhysicalFile): boolean {
  return (
    left.path === right.path &&
    left.key === right.key &&
    left.size === right.size &&
    left.mtimeNs === right.mtimeNs &&
    left.ctimeNs === right.ctimeNs
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

class SessionFilesystemError extends Error {}

function sessionFilesystemError(message: string, code?: string): SessionFilesystemError {
  const error = new SessionFilesystemError(message) as SessionFilesystemError & { code?: string };
  if (code) error.code = code;
  return error;
}

function safeFilesystemError(error: unknown, fallback: string): Error {
  return error instanceof SessionFilesystemError ? error : sessionFilesystemError(fallback);
}

function safeFilesystemMessage(error: unknown, fallback: string): string {
  return safeFilesystemError(error, fallback).message;
}

function deadline(started: number): void {
  if (Date.now() - started > SESSION_IO_LIMITS.milliseconds) {
    throw sessionFilesystemError('Session catalog metadata budget exceeded');
  }
}

export async function ensureCheckedDirectory(path: string, rootReal?: string): Promise<string> {
  try {
    await mkdir(path, { recursive: true, mode: 0o700 });
    return await checkedDirectory(path, rootReal);
  } catch (error) {
    throw safeFilesystemError(error, 'Session directory is unavailable or unsafe');
  }
}

/** Validate an existing directory without creating any user-selected path. */
export async function checkedExistingDirectory(path: string): Promise<string> {
  try {
    return await checkedDirectory(path);
  } catch (error) {
    throw safeFilesystemError(error, 'Session directory is unavailable or unsafe');
  }
}

export async function retainedArtifactCount(directory: string): Promise<number> {
  let handle;
  try {
    const checked = await checkedDirectory(directory);
    handle = await opendir(checked);
    let retained = 0;
    for await (const entry of handle) {
      if (entry.name.endsWith('.retained')) {
        // Unknown/symlink markers still consume capacity: an attacker cannot
        // bypass the finite failure budget by replacing recovery evidence.
        retained += 1;
        if (retained >= SESSION_IO_LIMITS.retainedArtifacts) break;
      }
    }
    return retained;
  } catch (error) {
    throw safeFilesystemError(error, 'Session recovery directory is unavailable or unsafe');
  } finally {
    await handle?.close().catch(() => undefined);
  }
}

async function checkedDirectory(path: string, rootReal?: string): Promise<string> {
  const before = await lstat(path);
  if (!before.isDirectory() || before.isSymbolicLink())
    throw sessionFilesystemError('Unsafe session directory');
  const physical = await realpath(path);
  if (rootReal && !within(rootReal, physical))
    throw sessionFilesystemError('Session directory escapes its root');
  const after = await lstat(path);
  if (after.dev !== before.dev || after.ino !== before.ino || after.isSymbolicLink()) {
    throw sessionFilesystemError('Session directory changed during validation');
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
        throw sessionFilesystemError('Session directory entry budget exceeded');
      }
      if (entry.isSymbolicLink() || (!entry.isFile() && !entry.isDirectory())) {
        throw sessionFilesystemError('Unsafe or unknown session-directory child');
      }
      if (!entry.name.endsWith('.jsonl')) continue;
      const path = resolve(directoryReal, entry.name);
      if (!within(directoryReal, path) || !entry.isFile()) {
        throw sessionFilesystemError('Unsafe session file');
      }
      const before = await lstat(path, { bigint: true });
      if (!before.isFile() || before.isSymbolicLink() || before.nlink !== 1n) {
        throw sessionFilesystemError('Session file must be a singly-linked regular file');
      }
      const physical = await realpath(path);
      if (!within(directoryReal, physical))
        throw sessionFilesystemError('Session file escapes its directory');
      if (before.size > BigInt(SESSION_IO_LIMITS.fileBytes)) {
        throw sessionFilesystemError('Session file is too large');
      }
      const size = Number(before.size);
      budget.files += 1;
      budget.bytes += size;
      if (budget.files > SESSION_IO_LIMITS.files || budget.bytes > SESSION_IO_LIMITS.totalBytes) {
        throw sessionFilesystemError('Session catalog file budget exceeded');
      }
      files.set(path, {
        path,
        key: `${String(before.dev)}:${String(before.ino)}`,
        size,
        mtimeNs: String(before.mtimeNs),
        ctimeNs: String(before.ctimeNs),
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
  } catch {
    return {
      sessions: [],
      diagnostics: ['Session root is unavailable or unsafe'],
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
          throw sessionFilesystemError('Session root entry budget exceeded');
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
          throw sessionFilesystemError('Session directory budget exceeded');
        }
      }
    } finally {
      await handle.close().catch(() => undefined);
    }
  } catch (error) {
    return {
      sessions: [],
      diagnostics: [safeFilesystemMessage(error, 'Session root enumeration failed safely')],
      complete: false,
    };
  }

  const budget = { files: 0, bytes: 0 };
  const approved: ApprovedDirectory[] = [];
  let complete = completeRootScan;
  for (const directory of directoryPaths) {
    try {
      approved.push(await inspectDirectory(directory, rootReal, budget, started));
    } catch (error) {
      complete = false;
      diagnostics.push(
        `Skipped session directory: ${safeFilesystemMessage(error, 'metadata validation failed safely')}`,
      );
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
        if (!samePhysicalGeneration(checked, approvedFile)) {
          throw sessionFilesystemError('Session file changed before listing');
        }
      }
      // Public SDK owns JSONL parsing. Its API has no abort/file/byte budget, so calls
      // happen only for directories whose complete metadata set passed the budgets above.
      listed = await SessionManager.listAll(directory.path);
      deadline(started);
    } catch (error) {
      complete = false;
      diagnostics.push(
        `Skipped malformed session directory: ${safeFilesystemMessage(error, 'listing or recheck failed safely')}`,
      );
      continue;
    }
    const represented = new Set<string>();
    for (const info of listed) {
      try {
        deadline(started);
        if (!info || typeof info.path !== 'string')
          throw sessionFilesystemError('Malformed SDK record');
        const path = resolve(info.path);
        const physical = directory.files.get(path);
        if (!physical) throw sessionFilesystemError('SDK returned an unapproved path');
        if (represented.has(path)) throw sessionFilesystemError('SDK returned a duplicate path');
        represented.add(path);
        const checked = await inspectPhysicalFile(path, directory.path);
        if (!samePhysicalGeneration(checked, physical)) {
          throw sessionFilesystemError('Session file changed during listing');
        }
        sessions.push({ info, physical });
      } catch (error) {
        complete = false;
        diagnostics.push(
          `Dropped session record: ${safeFilesystemMessage(error, 'validation failed safely')}`,
        );
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
  try {
    const absolute = resolve(path);
    const before = await lstat(absolute, { bigint: true });
    if (!before.isFile() || before.isSymbolicLink() || before.nlink !== 1n) {
      throw sessionFilesystemError('Session source must be a singly-linked regular file');
    }
    if (before.size > BigInt(SESSION_IO_LIMITS.fileBytes)) {
      throw sessionFilesystemError('Session file is too large');
    }
    const physical = await realpath(absolute);
    if (requiredRoot && !within(resolve(requiredRoot), physical)) {
      throw sessionFilesystemError('Session file escapes its owned directory');
    }
    const after = await lstat(absolute, { bigint: true });
    if (
      after.dev !== before.dev ||
      after.ino !== before.ino ||
      after.size !== before.size ||
      after.mtimeNs !== before.mtimeNs ||
      after.ctimeNs !== before.ctimeNs
    ) {
      throw sessionFilesystemError('Session file changed during validation');
    }
    return {
      path: absolute,
      key: `${String(before.dev)}:${String(before.ino)}`,
      size: Number(before.size),
      mtimeNs: String(before.mtimeNs),
      ctimeNs: String(before.ctimeNs),
    };
  } catch (error) {
    throw safeFilesystemError(error, 'Session source is unavailable or unsafe');
  }
}

interface ExclusiveCopyOptions {
  /** Require the open source handle to be this freshly cataloged inode. */
  expectedSource?: PhysicalFile;
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
  let sourceHandle;
  let destinationHandle;
  let created = false;
  let stage: 'source' | 'destination' | 'copy' = 'source';
  try {
    sourceHandle = await open(source, constants.O_RDONLY | constants.O_NOFOLLOW);
    const before = await sourceHandle.stat({ bigint: true });
    const sourceKey = `${String(before.dev)}:${String(before.ino)}`;
    if (
      !before.isFile() ||
      before.nlink !== 1n ||
      before.size > BigInt(SESSION_IO_LIMITS.fileBytes)
    ) {
      throw sessionFilesystemError('Copy source must be a bounded singly-linked regular file');
    }
    if (
      options.expectedSource &&
      (sourceKey !== options.expectedSource.key ||
        Number(before.size) !== options.expectedSource.size ||
        String(before.mtimeNs) !== options.expectedSource.mtimeNs ||
        String(before.ctimeNs) !== options.expectedSource.ctimeNs)
    ) {
      throw sessionFilesystemError('Copy source no longer matches its authoritative identity');
    }
    stage = 'destination';
    destinationHandle = await open(
      destination,
      constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW,
      0o600,
    );
    created = true;
    stage = 'copy';
    await options.afterCreate?.(destination);
    const buffer = Buffer.alloc(64 * 1024);
    let position = 0;
    const sourceSize = Number(before.size);
    while (position < sourceSize) {
      const read = await sourceHandle.read(
        buffer,
        0,
        Math.min(buffer.length, sourceSize - position),
        position,
      );
      if (read.bytesRead === 0) throw sessionFilesystemError('Copy source ended unexpectedly');
      await destinationHandle.write(buffer, 0, read.bytesRead, position);
      position += read.bytesRead;
    }
    await destinationHandle.sync();
    const [after, createdInfo] = await Promise.all([
      sourceHandle.stat({ bigint: true }),
      destinationHandle.stat(),
    ]);
    if (
      after.dev !== before.dev ||
      after.ino !== before.ino ||
      after.size !== before.size ||
      after.mtimeNs !== before.mtimeNs ||
      after.ctimeNs !== before.ctimeNs
    ) {
      throw sessionFilesystemError('Copy source changed during copy');
    }
    const physical = await inspectPhysicalFile(destination, dirname(destination));
    if (
      physical.key !== `${String(createdInfo.dev)}:${String(createdInfo.ino)}` ||
      physical.size !== createdInfo.size
    ) {
      throw sessionFilesystemError('Copy destination changed after exclusive creation');
    }
    return physical;
  } catch (error) {
    if (created) {
      options.onRetained?.(
        'Retained failed copy artifact because atomic path ownership cleanup is unavailable',
      );
    }
    if (error instanceof SessionFilesystemError) throw error;
    const code = (error as NodeJS.ErrnoException).code;
    if (stage === 'destination' && code === 'EEXIST') {
      throw sessionFilesystemError('Export destination already exists', 'EEXIST');
    }
    throw sessionFilesystemError(
      stage === 'source'
        ? 'Session export source could not be opened safely'
        : stage === 'destination'
          ? 'Export destination could not be created safely'
          : 'Session export copy failed safely',
    );
  } finally {
    await destinationHandle?.close().catch(() => undefined);
    await sourceHandle?.close().catch(() => undefined);
  }
}
