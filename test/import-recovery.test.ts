import { chmodSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ImportRecoveryService } from '../src/main/services/import-recovery.js';

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe('ImportRecoveryService', () => {
  it('retains health across stopped service owners and app service recreation', async () => {
    const root = mkdtempSync(join(tmpdir(), 'tau-gui-recovery-'));
    roots.push(root);
    const recovery = join(root, 'imported-sessions');
    mkdirSync(recovery);
    writeFileSync(join(recovery, 'failed.jsonl.retained'), '');

    const stopped = new ImportRecoveryService(root, () => Promise.resolve(''));
    expect(await stopped.health()).toEqual({ available: true, retained: 1, capacity: 32 });

    const restarted = new ImportRecoveryService(root, () => Promise.resolve(''));
    expect(await restarted.health()).toEqual({ available: true, retained: 1, capacity: 32 });
  });

  it.each(['creation', 'validation', 'enumeration'] as const)(
    'redacts %s filesystem failures from health',
    async (failure) => {
      const root = mkdtempSync(join(tmpdir(), `tau-gui-private-${failure}-`));
      roots.push(root);
      const agentDir = failure === 'creation' ? join(root, 'agent-file') : join(root, 'agent');
      if (failure === 'creation') {
        writeFileSync(agentDir, 'not a directory');
      } else {
        mkdirSync(agentDir);
        const recovery = join(agentDir, 'imported-sessions');
        if (failure === 'validation') {
          const target = join(root, 'redirected');
          mkdirSync(target);
          symlinkSync(target, recovery);
        } else {
          mkdirSync(recovery);
          chmodSync(recovery, 0o000);
        }
      }
      const service = new ImportRecoveryService(agentDir, () => Promise.resolve(''));

      await expect(service.health()).resolves.toEqual({
        available: false,
        error: 'Import recovery is unavailable',
      });
    },
  );

  it('reveals the configured recovery directory but never leaks path-bearing errors', async () => {
    const root = mkdtempSync(join(tmpdir(), 'tau-gui-private-agent-'));
    roots.push(root);
    const openPath = vi.fn(() => Promise.resolve(`failed to open ${root}: denied`));
    const service = new ImportRecoveryService(root, openPath);

    await expect(service.reveal()).rejects.toThrow(
      'Could not reveal the import recovery directory',
    );
    await expect(service.reveal()).rejects.not.toThrow(root);
    expect(openPath).toHaveBeenCalledWith(expect.stringMatching(/\/imported-sessions$/));
  });
});
