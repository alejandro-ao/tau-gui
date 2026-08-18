import { execFile } from 'node:child_process';
import { access, constants } from 'node:fs/promises';
import { delimiter, isAbsolute, join } from 'node:path';
import { promisify } from 'node:util';
import type { RuntimeKind } from '../../shared/domain.js';

const execFileAsync = promisify(execFile);

export interface RuntimeProbe {
  binary: string;
  /** Absolute path the binary resolves to, or null when it was not found. */
  resolved: string | null;
  version: string | null;
  error: string | null;
}

/** Version strings are child-process output: bound and sanitize before use. */
export const MAX_VERSION_LENGTH = 80;

/**
 * Extract a short, printable version string from raw child output. Only the
 * first line is kept, control characters are stripped, and the result is
 * truncated so a hostile or broken binary cannot flood the UI or logs.
 */
export function extractVersion(stdout: string, stderr = ''): string | null {
  const source = `${stdout}\n${stderr}`;
  const firstLine =
    source
      .split('\n')
      .map((line) => line.trim())
      .find((line) => line.length > 0) ?? '';
  // eslint-disable-next-line no-control-regex
  const printable = firstLine.replace(/[\u0000-\u001F\u007F-\u009F]/g, '').trim();
  if (!printable) return null;
  return printable.length > MAX_VERSION_LENGTH
    ? `${printable.slice(0, MAX_VERSION_LENGTH - 1)}…`
    : printable;
}

/**
 * First-run check: resolve the configured runtime binary on PATH and ask it for
 * its version. Used by the settings UI and by startup failure messages.
 * Arguments are passed as an array; nothing is interpolated into a shell.
 *
 * The binary always comes from persisted settings; the renderer can never
 * choose which executable is run.
 */
export async function probeRuntime(kind: RuntimeKind, binary: string): Promise<RuntimeProbe> {
  const resolved = await resolveBinary(binary);
  if (!resolved) {
    return {
      binary,
      resolved: null,
      version: null,
      error: `${binary} was not found on PATH. Install ${kind} or set an absolute binary path.`,
    };
  }
  try {
    const { stdout, stderr } = await execFileAsync(resolved, ['--version'], {
      timeout: 8_000,
      maxBuffer: 256 * 1024,
    });
    return { binary, resolved, version: extractVersion(stdout, stderr), error: null };
  } catch (error) {
    return {
      binary,
      resolved,
      version: null,
      error: `Found ${resolved} but could not read its version: ${(error as Error).message}`,
    };
  }
}

/** Minimal PATH lookup; avoids depending on `which`/`where`. */
export async function resolveBinary(binary: string): Promise<string | null> {
  const executable = async (candidate: string): Promise<boolean> => {
    try {
      await access(candidate, constants.X_OK);
      return true;
    } catch {
      return false;
    }
  };

  if (isAbsolute(binary) || binary.includes('/') || binary.includes('\\')) {
    return (await executable(binary)) ? binary : null;
  }

  const pathValue = process.env['PATH'] ?? '';
  const extensions = process.platform === 'win32' ? ['.exe', '.cmd', '.bat', ''] : [''];
  for (const directory of pathValue.split(delimiter).filter(Boolean)) {
    for (const extension of extensions) {
      const candidate = join(directory, `${binary}${extension}`);
      if (await executable(candidate)) return candidate;
    }
  }
  return null;
}
