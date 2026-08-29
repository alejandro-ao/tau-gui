import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
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
    expect(await stopped.health()).toEqual({ retained: 1, capacity: 32 });

    const restarted = new ImportRecoveryService(root, () => Promise.resolve(''));
    expect(await restarted.health()).toEqual({ retained: 1, capacity: 32 });
  });

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
