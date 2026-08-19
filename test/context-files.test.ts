import { mkdir, mkdtemp, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { discoverContextFiles } from '../src/main/services/context-files.js';

async function file(path: string): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, '# instructions', 'utf8');
}

describe('context file discovery', () => {
  it('returns only existing fixed AGENTS.md files with compact and full paths', async () => {
    const root = await mkdtemp(join(tmpdir(), 'tau-gui-context-'));
    const home = join(root, 'home');
    const cwd = join(root, 'project');
    await file(join(home, '.tau', 'AGENTS.md'));
    await file(join(home, '.agents', 'not-agents.md'));
    await file(join(cwd, '.agents', 'AGENTS.md'));

    expect(await discoverContextFiles(cwd, { home, includeProject: true })).toEqual([
      { label: '~/.tau/AGENTS.md', path: join(home, '.tau', 'AGENTS.md') },
      { label: './.agents/AGENTS.md', path: join(cwd, '.agents', 'AGENTS.md') },
    ]);
  });

  it('does not inspect project candidates without explicit trust', async () => {
    const root = await mkdtemp(join(tmpdir(), 'tau-gui-context-'));
    const home = join(root, 'home');
    const cwd = join(root, 'project');
    await file(join(home, '.agents', 'AGENTS.md'));
    await file(join(cwd, '.tau', 'AGENTS.md'));

    const files = await discoverContextFiles(cwd, { home });

    expect(files).toEqual([
      { label: '~/.agents/AGENTS.md', path: join(home, '.agents', 'AGENTS.md') },
    ]);
  });

  it('ignores directories and accepts a fixed-location link to a regular file', async () => {
    const root = await mkdtemp(join(tmpdir(), 'tau-gui-context-'));
    const home = join(root, 'home');
    const cwd = join(root, 'project');
    await mkdir(join(home, '.tau', 'AGENTS.md'), { recursive: true });
    const target = join(root, 'shared-agents.md');
    await file(target);
    await mkdir(join(cwd, '.agents'), { recursive: true });
    await symlink(target, join(cwd, '.agents', 'AGENTS.md'));

    expect(await discoverContextFiles(cwd, { home, includeProject: true })).toEqual([
      { label: './.agents/AGENTS.md', path: join(cwd, '.agents', 'AGENTS.md') },
    ]);
  });
});
