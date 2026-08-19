import { stat } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import type { ContextFile } from '../../shared/ipc.js';

interface Candidate {
  label: string;
  path: string;
}

/**
 * Finds the fixed AGENTS.md locations Tau may add to context. No renderer path
 * is accepted and file contents are never read. Project files require the same
 * explicit trust decision used for other project resource discovery.
 */
export async function discoverContextFiles(
  cwd: string,
  options: { includeProject?: boolean; home?: string } = {},
): Promise<ContextFile[]> {
  const home = options.home ?? homedir();
  const candidates: Candidate[] = [
    { label: '~/.tau/AGENTS.md', path: join(home, '.tau', 'AGENTS.md') },
    { label: '~/.agents/AGENTS.md', path: join(home, '.agents', 'AGENTS.md') },
  ];

  if (options.includeProject === true) {
    candidates.push(
      { label: './.tau/AGENTS.md', path: join(cwd, '.tau', 'AGENTS.md') },
      { label: './.agents/AGENTS.md', path: join(cwd, '.agents', 'AGENTS.md') },
    );
  }

  const files = await Promise.all(
    candidates.map(async (candidate): Promise<ContextFile | null> =>
      (await isFile(candidate.path)) ? candidate : null,
    ),
  );
  return files.filter((file): file is ContextFile => file !== null);
}

async function isFile(path: string): Promise<boolean> {
  try {
    return (await stat(path)).isFile();
  } catch {
    return false;
  }
}
