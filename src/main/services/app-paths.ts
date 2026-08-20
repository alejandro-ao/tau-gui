import {
  chmodSync,
  closeSync,
  constants,
  fsyncSync,
  lstatSync,
  linkSync,
  mkdirSync,
  openSync,
  readFileSync,
  realpathSync,
  unlinkSync,
  writeSync,
} from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join, parse, relative, resolve, sep } from 'node:path';

export const AO_AGENT_DIR_ENV = 'AO_AGENT_DIR';
export const LEGACY_AGENT_DIR_ENV = 'TAU_GUI_AGENT_DIR';
export const AO_USER_DATA_DIR_ENV = 'AO_USER_DATA_DIR';
export const LEGACY_USER_DATA_DIR_ENV = 'TAU_GUI_USER_DATA_DIR';
export const AO_TEST_RPC_RUNTIME_ENV = 'AO_TEST_RPC_RUNTIME';
export const LEGACY_TEST_RPC_RUNTIME_ENV = 'TAU_GUI_TEST_RPC_RUNTIME';

export interface AppStoragePaths {
  agentDir: string;
  sessionRoot: string;
  sessionDir: string;
}

/** Returns a new environment variable, falling back to its transition alias. */
export function environmentValue(
  env: NodeJS.ProcessEnv,
  current: string,
  legacy: string,
): string | undefined {
  const preferred = env[current];
  if (preferred !== undefined && preferred !== '') return preferred;
  const deprecated = env[legacy];
  return deprecated !== undefined && deprecated !== '' ? deprecated : undefined;
}

/** Resolve AO-owned storage independently from Pi's standard agent directory. */
export function resolveAppStoragePaths(options: {
  agentDir: string;
  home?: string;
  env?: NodeJS.ProcessEnv;
}): AppStoragePaths {
  const home = options.home ?? homedir();
  const configured = environmentValue(
    options.env ?? process.env,
    AO_AGENT_DIR_ENV,
    LEGACY_AGENT_DIR_ENV,
  );
  const sessionRoot = validateStoragePath(configured ?? join(home, '.ao-agent'));
  return {
    agentDir: validateStoragePath(options.agentDir),
    sessionRoot,
    sessionDir: join(sessionRoot, 'sessions'),
  };
}

/** Create app-owned directories with private permissions where supported. */
export function ensurePrivateDirectory(path: string): void {
  const resolved = validateStoragePath(path);
  const missing: string[] = [];
  let current = resolved;
  while (true) {
    try {
      lstatSync(current);
      break;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      missing.push(current);
      const parent = dirname(current);
      if (parent === current) throw error;
      current = parent;
    }
  }

  assertStablePathComponents(resolved);
  for (const directory of missing.reverse()) {
    mkdirSync(directory, { mode: 0o700 });
    // Check immediately after creation. Never chmod a symlink target.
    assertPathWithoutSymlink(directory);
  }
  try {
    assertPathWithoutSymlink(resolved);
    chmodSync(resolved, 0o700);
  } catch {
    // Windows and some mounted filesystems do not support chmod.
  }
}

export function validateStoragePath(path: string): string {
  if (!path || path.includes('\0')) throw new Error('Storage path must be a non-empty safe path');
  const resolved = resolve(path);
  if (resolved === parse(resolved).root) {
    throw new Error('Storage path must not be a filesystem root');
  }
  // A configured root itself may not be an alias. Ancestor aliases such as
  // macOS /tmp are canonicalized below, while symlinks inside the root are
  // rejected by assertPathWithinRoot at each filesystem operation.
  assertPathWithoutSymlink(resolved);
  try {
    if (!lstatSync(resolved).isDirectory()) {
      throw new Error(`Storage path is not a directory: ${path}`);
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
  }
  return resolved;
}

/** Reject a symlink at the requested path without following it. */
export function assertPathWithoutSymlink(path: string): void {
  try {
    if (lstatSync(resolve(path)).isSymbolicLink()) {
      throw new Error(`Storage path cannot contain a symlink: ${path}`);
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
  }
}

/** Reject stable aliases in an owned path, allowing only macOS system aliases. */
export function assertStablePathComponents(path: string): void {
  let current = resolve(path);
  while (true) {
    try {
      const info = lstatSync(current);
      if (info.isSymbolicLink() && !isKnownSystemAlias(current)) {
        throw new Error(`Storage path cannot contain a symlink: ${current}`);
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    }
    const parent = dirname(current);
    if (parent === current) return;
    current = parent;
  }
}

function isKnownSystemAlias(path: string): boolean {
  if (process.platform !== 'darwin') return false;
  if (!['/var', '/tmp', '/etc'].includes(path)) return false;
  try {
    return realpathSync(path) === `/private${path}`;
  } catch {
    return false;
  }
}

/**
 * Check physical containment and reject symlinks in the owned portion of a
 * path. OS-level aliases above the configured root are canonicalized safely.
 */
export function assertPathWithinRoot(path: string, root: string): void {
  const candidate = resolve(path);
  const base = resolve(root);
  const lexicalRelative = relative(base, candidate);
  if (lexicalRelative.startsWith(`..${sep}`) || lexicalRelative === '..') {
    throw new Error(`Path escapes storage root: ${path}`);
  }
  assertSymlinksAbsentBetween(candidate, base);
  const physicalCandidate = physicalPath(candidate);
  const physicalBase = physicalPath(base);
  if (
    physicalCandidate !== physicalBase &&
    !physicalCandidate.startsWith(`${physicalBase}${sep}`)
  ) {
    throw new Error(`Path escapes storage root: ${path}`);
  }
}

function assertSymlinksAbsentBetween(path: string, root: string): void {
  let current = path;
  while (true) {
    assertPathWithoutSymlink(current);
    if (current === root) return;
    const parent = dirname(current);
    if (parent === current || (parent !== root && !parent.startsWith(`${root}${sep}`))) {
      throw new Error(`Path escapes storage root: ${path}`);
    }
    current = parent;
  }
}

/** Resolve existing ancestors physically and preserve missing suffixes. */
function physicalPath(path: string): string {
  const resolved = resolve(path);
  const missing: string[] = [];
  let current = resolved;
  while (true) {
    try {
      const physical = realpathSync(current);
      return join(physical, ...missing.reverse());
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      const parent = dirname(current);
      if (parent === current) throw error;
      missing.push(relative(parent, current));
      current = parent;
    }
  }
}

/** Candidate names used by Electron before the Tau GUI → AO application rename. */
export function legacyUserDataDirectories(appDataDir: string, userDataDir: string): string[] {
  const roots = [appDataDir, dirname(userDataDir)];
  const names = ['Tau GUI', 'tau-gui', 'com.alejandroao.tau-gui'];
  return [...new Set(roots.flatMap((root) => names.map((name) => join(root, name))))].filter(
    (candidate) => resolve(candidate) !== resolve(userDataDir),
  );
}

const NO_FOLLOW = (constants as { O_NOFOLLOW?: number }).O_NOFOLLOW ?? 0;

function copySettingsFile(source: string, destination: string, destinationRoot: string): boolean {
  const temporary = `${destination}.${process.pid}.${Date.now()}.tmp`;
  let sourceHandle: number | undefined;
  let temporaryHandle: number | undefined;
  try {
    assertPathWithinRoot(source, dirname(source));
    assertPathWithinRoot(destination, destinationRoot);
    sourceHandle = openSync(source, constants.O_RDONLY | NO_FOLLOW);
    const bytes = readFileSync(sourceHandle);
    closeSync(sourceHandle);
    sourceHandle = undefined;

    assertPathWithinRoot(source, dirname(source));
    assertPathWithinRoot(destination, destinationRoot);
    temporaryHandle = openSync(
      temporary,
      constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | NO_FOLLOW,
      0o600,
    );
    let offset = 0;
    while (offset < bytes.length) offset += writeSync(temporaryHandle, bytes, offset);
    fsyncSync(temporaryHandle);
    closeSync(temporaryHandle);
    temporaryHandle = undefined;

    // Hard-link installation is atomic and never replaces a deliberate
    // destination collision. Rename would overwrite on POSIX.
    assertPathWithinRoot(destination, destinationRoot);
    linkSync(temporary, destination);
    unlinkSync(temporary);
    try {
      chmodSync(destination, 0o600);
    } catch {
      // Windows and some mounted filesystems do not support chmod.
    }
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'EEXIST') return false;
    throw error;
  } finally {
    if (sourceHandle !== undefined) closeSync(sourceHandle);
    if (temporaryHandle !== undefined) closeSync(temporaryHandle);
    try {
      unlinkSync(temporary);
    } catch {
      // Cleanup is best effort; the validated destination was never replaced.
    }
  }
}

/** Copy the old Electron settings file once; never replace new user choices. */
export function migrateLegacySettings(userDataDir: string, appDataDir: string): boolean {
  const destination = join(userDataDir, 'settings.json');
  // Electron normally creates both paths, but validate them here too because
  // this function is also used by startup tests and before SettingsStore opens
  // the destination. Stable links are never accepted as ownership boundaries.
  validateStoragePath(userDataDir);
  validateStoragePath(appDataDir);
  assertStablePathComponents(userDataDir);
  assertStablePathComponents(appDataDir);
  assertPathWithinRoot(destination, userDataDir);

  try {
    const destinationInfo = lstatSync(destination);
    if (destinationInfo.isSymbolicLink()) {
      throw new Error(`Settings path cannot contain a symlink: ${destination}`);
    }
    if (destinationInfo.isFile()) return false;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
  }

  for (const legacyDir of legacyUserDataDirectories(appDataDir, userDataDir)) {
    const source = join(legacyDir, 'settings.json');
    try {
      const legacyRoot = resolve(legacyDir).startsWith(`${resolve(appDataDir)}${sep}`)
        ? appDataDir
        : dirname(userDataDir);
      assertPathWithinRoot(legacyDir, legacyRoot);
      assertPathWithinRoot(source, legacyRoot);
      if (!lstatSync(source).isFile()) continue;
      if (copySettingsFile(source, destination, userDataDir)) return true;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') continue;
      // A candidate can be unavailable during first launch. Do not weaken the
      // ownership checks or replace a destination selected by another process.
    }
  }
  return false;
}
