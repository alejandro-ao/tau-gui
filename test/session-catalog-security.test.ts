import { mkdir, mkdtemp, realpath, rename, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SessionManager, type SessionInfo } from '@earendil-works/pi-coding-agent';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { loadCatalog } from '../src/main/runtime/embedded-pi-runtime.js';

let root: string | null = null;
afterEach(async () => {
  vi.restoreAllMocks();
  if (root) await rm(root, { recursive: true, force: true });
  root = null;
});

describe('session catalog record isolation', () => {
  it('fails closed while one project directory is hidden by a symlink and recovers exactly', async () => {
    root = await mkdtemp(join(tmpdir(), 'tau-gui-catalog-'));
    const sessions = join(root, 'sessions');
    const directoryA = join(sessions, 'project-a');
    const directoryB = join(sessions, 'project-b');
    const hiddenA = join(root, 'hidden-a');
    await mkdir(directoryA, { recursive: true });
    await mkdir(directoryB, { recursive: true });
    const pathA = join(directoryA, 'a.jsonl');
    const pathB = join(directoryB, 'b.jsonl');
    await writeFile(pathA, '{}\n');
    await writeFile(pathB, '{}\n');
    const records = new Map([
      [directoryA, { path: await realpath(pathA), id: 'session-a' }],
      [directoryB, { path: await realpath(pathB), id: 'session-b' }],
    ]);
    vi.spyOn(SessionManager, 'listAll').mockImplementation((sessionDir?: string) => {
      const record = sessionDir
        ? [...records.entries()].find(([directory]) =>
            sessionDir.endsWith(directory.slice(directory.lastIndexOf('/'))),
          )?.[1]
        : undefined;
      return Promise.resolve(
        record
          ? [
              {
                ...record,
                cwd: '/work',
                created: new Date(1),
                modified: new Date(2),
                messageCount: 0,
                firstMessage: '',
                allMessagesText: '',
              },
            ]
          : [],
      );
    });

    await rename(directoryA, hiddenA);
    await symlink(hiddenA, directoryA);
    const hidden = await loadCatalog(root, null);
    expect(hidden.complete).toBe(false);
    expect(hidden.diagnostics.join(' ')).toContain('unsafe or unknown session-root child');

    await rm(directoryA);
    await rename(hiddenA, directoryA);
    records.set(directoryA, { path: await realpath(pathA), id: 'session-a' });
    const recovered = await loadCatalog(root, null);
    expect(recovered.complete).toBe(true);
    expect(recovered.records.map((record) => record.sessionId).sort()).toEqual([
      'session-a',
      'session-b',
    ]);
  });
  it('drops invalid dates/types without suppressing an independent valid record', async () => {
    root = await mkdtemp(join(tmpdir(), 'tau-gui-catalog-'));
    const directory = join(root, 'sessions', 'project');
    await mkdir(directory, { recursive: true });
    const validPath = join(directory, 'valid.jsonl');
    const invalidPath = join(directory, 'invalid.jsonl');
    await writeFile(validPath, '{}\n');
    await writeFile(invalidPath, '{}\n');

    const valid: SessionInfo = {
      path: await realpath(validPath),
      id: 'valid-id',
      cwd: '/work',
      created: new Date(1),
      modified: new Date(2),
      messageCount: 1,
      firstMessage: 'safe',
      allMessagesText: 'safe',
    };
    const invalid = {
      ...valid,
      path: await realpath(invalidPath),
      id: 42,
      created: new Date(Number.NaN),
    } as unknown as SessionInfo;
    vi.spyOn(SessionManager, 'listAll').mockImplementation((sessionDir?: string) =>
      Promise.resolve(sessionDir?.endsWith('/project') ? [invalid, valid] : []),
    );

    const catalog = await loadCatalog(root, null);
    expect(catalog.records.map((record) => record.sessionId)).toEqual(['valid-id']);
    expect(catalog.diagnostics.join(' ')).toContain('Dropped malformed session record');
  });

  it('drops IDs outside Pi public session identity grammar', async () => {
    root = await mkdtemp(join(tmpdir(), 'tau-gui-catalog-'));
    const directory = join(root, 'sessions', 'project');
    await mkdir(directory, { recursive: true });
    const path = join(directory, 'invalid-id.jsonl');
    await writeFile(path, '{}\n');
    vi.spyOn(SessionManager, 'listAll').mockResolvedValue([
      {
        path: await realpath(path),
        id: 'invalid/id\u202E',
        cwd: '/work',
        created: new Date(1),
        modified: new Date(2),
        messageCount: 1,
        firstMessage: 'unsafe',
        allMessagesText: 'unsafe',
      },
    ]);

    const catalog = await loadCatalog(root, null);
    expect(catalog.records).toEqual([]);
    expect(catalog.diagnostics.join(' ')).toContain('session identity is invalid');
  });

  it('drops every selectable record when one logical id names two physical files', async () => {
    root = await mkdtemp(join(tmpdir(), 'tau-gui-catalog-'));
    const directory = join(root, 'sessions', 'project');
    await mkdir(directory, { recursive: true });
    const paths = [join(directory, 'a.jsonl'), join(directory, 'b.jsonl')];
    await Promise.all(paths.map((path) => writeFile(path, '{}\n')));
    const physicalPaths = await Promise.all(paths.map((path) => realpath(path)));
    vi.spyOn(SessionManager, 'listAll').mockImplementation((sessionDir?: string) =>
      Promise.resolve(
        sessionDir?.endsWith('/project')
          ? physicalPaths.map((path, index) => ({
              path,
              id: 'duplicate-id',
              cwd: '/work',
              created: new Date(1),
              modified: new Date(index + 2),
              messageCount: 1,
              firstMessage: 'duplicate',
              allMessagesText: 'duplicate',
            }))
          : [],
      ),
    );

    const catalog = await loadCatalog(root, null);
    expect(catalog.records).toEqual([]);
    expect(catalog.diagnostics.join(' ')).toContain('Dropped conflicting session identity');
  });
});
