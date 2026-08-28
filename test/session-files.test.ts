import { link, mkdir, mkdtemp, readFile, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  boundedSessionList,
  exclusiveCopy,
  inspectPhysicalFile,
  SESSION_IO_LIMITS,
} from '../src/main/runtime/session-files.js';

const roots: string[] = [];
afterEach(async () => {
  const { rm } = await import('node:fs/promises');
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function root(): Promise<string> {
  const path = await mkdtemp(join(tmpdir(), 'tau-gui-session-files-'));
  roots.push(path);
  return path;
}

describe('privileged session filesystem guards', () => {
  it('never overwrites an existing import destination', async () => {
    const directory = await root();
    const source = join(directory, 'source.jsonl');
    const destination = join(directory, 'destination.jsonl');
    await writeFile(source, 'source');
    await writeFile(destination, 'owned');

    await expect(exclusiveCopy(source, destination)).rejects.toThrow();
    await expect(readFile(destination, 'utf8')).resolves.toBe('owned');
  });

  it('rejects symlink and hardlink import sources', async () => {
    const directory = await root();
    const source = join(directory, 'source.jsonl');
    const alias = join(directory, 'alias.jsonl');
    const symbolic = join(directory, 'symbolic.jsonl');
    await writeFile(source, 'source');
    await link(source, alias);
    await symlink(source, symbolic);

    await expect(inspectPhysicalFile(alias)).rejects.toThrow('singly-linked');
    await expect(exclusiveCopy(symbolic, join(directory, 'copy.jsonl'))).rejects.toThrow();
  });

  it('fails closed for symlinked roots and children before SDK listing', async () => {
    const directory = await root();
    const sessions = join(directory, 'sessions');
    const outside = join(directory, 'outside');
    await mkdir(sessions);
    await mkdir(outside);
    await symlink(outside, join(sessions, 'child'));
    const childResult = await boundedSessionList(sessions);
    expect(childResult.sessions).toEqual([]);

    const fileTarget = join(outside, 'outside.jsonl');
    await writeFile(fileTarget, '{}');
    await symlink(fileTarget, join(sessions, 'escaped.jsonl'));
    const fileResult = await boundedSessionList(sessions);
    expect(fileResult.sessions).toEqual([]);
    expect(fileResult.diagnostics.join(' ')).toContain('Unsafe session file');

    const rootLink = join(directory, 'sessions-link');
    await symlink(sessions, rootLink);
    const rootResult = await boundedSessionList(rootLink);
    expect(rootResult.sessions).toEqual([]);
    expect(rootResult.diagnostics[0]).toContain('Session root rejected');
  });

  it('enforces directory-entry budgets before public SDK calls', async () => {
    const directory = await root();
    const sessions = join(directory, 'sessions');
    await mkdir(sessions);
    await Promise.all(
      Array.from({ length: SESSION_IO_LIMITS.entriesPerDirectory + 1 }, (_, index) =>
        writeFile(join(sessions, `ignored-${index}`), ''),
      ),
    );
    const result = await boundedSessionList(sessions);
    expect(result.sessions).toEqual([]);
    expect(result.diagnostics.join(' ')).toContain('entry budget exceeded');
  });
});
