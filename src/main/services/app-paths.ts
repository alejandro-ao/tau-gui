import { chmodSync, copyFileSync, existsSync, mkdirSync, constants } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join, parse, resolve } from 'node:path';

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
  mkdirSync(path, { recursive: true, mode: 0o700 });
  try {
    chmodSync(path, 0o700);
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
  return resolved;
}

/** Candidate names used by Electron before the Tau GUI → AO application rename. */
export function legacyUserDataDirectories(appDataDir: string, userDataDir: string): string[] {
  const roots = [appDataDir, dirname(userDataDir)];
  const names = ['Tau GUI', 'tau-gui', 'com.alejandroao.tau-gui'];
  return [...new Set(roots.flatMap((root) => names.map((name) => join(root, name))))].filter(
    (candidate) => resolve(candidate) !== resolve(userDataDir),
  );
}

/** Copy the old Electron settings file once; never replace new user choices. */
export function migrateLegacySettings(userDataDir: string, appDataDir: string): boolean {
  const destination = join(userDataDir, 'settings.json');
  if (existsSync(destination)) return false;
  for (const legacyDir of legacyUserDataDirectories(appDataDir, userDataDir)) {
    const source = join(legacyDir, 'settings.json');
    if (!existsSync(source)) continue;
    try {
      mkdirSync(userDataDir, { recursive: true, mode: 0o700 });
      copyFileSync(source, destination, constants.COPYFILE_EXCL);
      try {
        chmodSync(destination, 0o600);
      } catch {
        // Windows and some mounted filesystems do not support chmod.
      }
      return true;
    } catch {
      // Another candidate may still be available after an interrupted copy.
    }
  }
  return false;
}
