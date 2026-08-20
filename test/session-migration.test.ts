import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { SessionManager } from '@earendil-works/pi-coding-agent';
import { afterEach, describe, expect, it } from 'vitest';
import { migrateLegacySessions } from '../src/main/services/session-migration.js';
import { SettingsStore } from '../src/main/services/settings.js';

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe('migrateLegacySessions', () => {
  it('copies only AO-indexed sessions, preserves the original, and is idempotent', async () => {
    const root = mkdtempSync(join(tmpdir(), 'ao-session-migration-'));
    roots.push(root);
    const legacy = join(root, 'pi', 'sessions');
    const target = join(root, 'ao', 'sessions');
    const cwd = join(root, 'project');
    const safeCwd = resolve(cwd)
      .replace(/^[/\\]/, '')
      .replace(/[/\\:]/g, '-');
    const legacyProjectDir = join(legacy, `--${safeCwd}--`);
    const manager = SessionManager.create(cwd, legacyProjectDir);
    const id = manager.getSessionId();
    mkdirSync(legacy, { recursive: true });
    const source = join(legacyProjectDir, `2026-01-01T00-00-00-000Z_${id}.jsonl`);
    writeFileSync(
      source,
      `${JSON.stringify({ type: 'session', version: 3, id, timestamp: '2026-01-01T00:00:00.000Z', cwd })}\n`,
    );
    const settings = new SettingsStore(join(root, 'settings.json'));
    settings.rememberSession({
      id,
      name: null,
      path: null,
      cwd,
      runtime: 'pi',
      lastSeen: 1,
    });

    const first = await migrateLegacySessions(settings, legacy, target);
    const destination = settings.current.recentSessions[0]?.path;
    expect(first.migrated).toBe(1);
    expect(destination).toBeTruthy();
    expect(existsSync(source)).toBe(true);
    expect(existsSync(destination!)).toBe(true);
    expect(readFileSync(destination!, 'utf8')).toBe(readFileSync(source, 'utf8'));

    const second = await migrateLegacySessions(settings, legacy, target);
    expect(second.migrated).toBe(0);
    expect(settings.current.recentSessions[0]?.path).toBe(destination);
  });

  it('does not import an unreferenced Pi session', async () => {
    const root = mkdtempSync(join(tmpdir(), 'ao-session-migration-'));
    roots.push(root);
    const legacy = join(root, 'pi', 'sessions');
    const target = join(root, 'ao', 'sessions');
    const manager = SessionManager.create(join(root, 'project'), legacy);
    const settings = new SettingsStore(join(root, 'settings.json'));
    settings.rememberSession({
      id: 'different-id',
      name: null,
      path: null,
      cwd: null,
      runtime: 'pi',
      lastSeen: 1,
    });

    const result = await migrateLegacySessions(settings, legacy, target);
    expect(result.migrated).toBe(0);
    expect(settings.current.recentSessions[0]?.path).toBeNull();
    expect(existsSync(join(target, manager.getSessionId()))).toBe(false);
  });
});
