import { link, mkdir, mkdtemp, readFile, rename, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  assertArtifactCapacity,
  boundedSessionList,
  exclusiveCopy,
  inspectPhysicalFile,
  retainPhysicalFile,
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

    const hardTarget = join(directory, 'hard-target.jsonl');
    const hardDestination = join(directory, 'hard-destination.jsonl');
    const symbolicDestination = join(directory, 'symbolic-destination.jsonl');
    await writeFile(hardTarget, 'hard-owned');
    await link(hardTarget, hardDestination);
    await symlink(hardTarget, symbolicDestination);
    await expect(exclusiveCopy(source, hardDestination)).rejects.toThrow();
    await expect(exclusiveCopy(source, symbolicDestination)).rejects.toThrow();
    await expect(readFile(hardTarget, 'utf8')).resolves.toBe('hard-owned');
  });

  it('retains caller replacements after a post-create swap and forced failure', async () => {
    const directory = await root();
    const source = join(directory, 'source.jsonl');
    const destination = join(directory, 'destination.jsonl');
    const displaced = join(directory, 'displaced-app-artifact.jsonl');
    const diagnostics: string[] = [];
    await writeFile(source, 'source');

    await expect(
      exclusiveCopy(source, destination, {
        afterCreate: async () => {
          await rename(destination, displaced);
          await writeFile(destination, 'caller replacement');
          throw new Error('forced post-create failure');
        },
        onRetained: (message) => diagnostics.push(message),
      }),
    ).rejects.toThrow('forced post-create failure');

    await expect(readFile(destination, 'utf8')).resolves.toBe('caller replacement');
    await expect(readFile(displaced, 'utf8')).resolves.toBe('');
    expect(diagnostics.join(' ')).toContain('Retained failed copy artifact');
  });

  it('never deletes a replacement swapped in after an ownership check', async () => {
    const directory = await root();
    const destination = join(directory, 'cleanup.jsonl');
    const displaced = join(directory, 'retained-app-artifact.jsonl');
    const diagnostics: string[] = [];
    await writeFile(destination, 'app artifact');
    const expected = await inspectPhysicalFile(destination);

    await rename(destination, displaced);
    await writeFile(destination, 'caller replacement');
    await retainPhysicalFile(expected, (message) => diagnostics.push(message));

    await expect(readFile(destination, 'utf8')).resolves.toBe('caller replacement');
    await expect(readFile(displaced, 'utf8')).resolves.toBe('app artifact');
    expect(diagnostics.join(' ')).toContain('ownership became uncertain');
  });

  it('fails closed at the retained staging-artifact budget', async () => {
    const directory = await root();
    await Promise.all(
      Array.from({ length: SESSION_IO_LIMITS.retainedArtifacts }, (_, index) =>
        writeFile(join(directory, `retained-${index}.jsonl`), ''),
      ),
    );

    await expect(assertArtifactCapacity(directory)).rejects.toThrow('artifact budget reached');
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
