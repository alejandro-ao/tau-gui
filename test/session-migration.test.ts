import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  utimesSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { SessionManager } from '@earendil-works/pi-coding-agent';
import { afterEach, describe, expect, it } from 'vitest';
import {
  migrateLegacySessions,
  SESSION_MIGRATION_TEMP_PREFIX,
} from '../src/main/services/session-migration.js';
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
    mkdirSync(join(target, `--${safeCwd}--`), { recursive: true });
    const staleTemporary = join(
      target,
      `--${safeCwd}--`,
      `${SESSION_MIGRATION_TEMP_PREFIX}session.jsonl-interrupted.tmp`,
    );
    writeFileSync(staleTemporary, 'partial transcript\n');
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
    expect(existsSync(staleTemporary)).toBe(false);
    expect(readFileSync(destination!, 'utf8')).toBe(readFileSync(source, 'utf8'));

    const second = await migrateLegacySessions(settings, legacy, target);
    expect(second.migrated).toBe(0);
    expect(settings.current.recentSessions[0]?.path).toBe(destination);
  });

  it('retains a same-size same-mtime collision and leaves the catalog unchanged', async () => {
    const root = mkdtempSync(join(tmpdir(), 'ao-session-migration-'));
    roots.push(root);
    const legacy = join(root, 'pi', 'sessions');
    const target = join(root, 'ao', 'sessions');
    const source = join(legacy, 'project', 'session.jsonl');
    const destination = join(target, 'project', 'session.jsonl');
    mkdirSync(dirname(source), { recursive: true });
    mkdirSync(dirname(destination), { recursive: true });
    writeFileSync(source, 'source-1234\n');
    writeFileSync(destination, 'other-5678\n');
    const timestamp = new Date('2026-01-01T00:00:00.000Z');
    utimesSync(source, timestamp, timestamp);
    utimesSync(destination, timestamp, timestamp);
    const settings = new SettingsStore(join(root, 'settings.json'));
    settings.rememberSession({
      id: 'collision-id',
      name: null,
      path: source,
      cwd: null,
      runtime: 'pi',
      lastSeen: 1,
    });

    const result = await migrateLegacySessions(settings, legacy, target);

    expect(result).toEqual({ migrated: 0, retained: 1, skipped: 0 });
    expect(readFileSync(destination, 'utf8')).toBe('other-5678\n');
    expect(settings.current.recentSessions[0]?.path).toBe(source);
  });

  it('rejects a symlinked source without reading outside the legacy root', async () => {
    if (process.platform === 'win32') return;
    const root = mkdtempSync(join(tmpdir(), 'ao-session-migration-'));
    roots.push(root);
    const legacy = join(root, 'pi', 'sessions');
    const target = join(root, 'ao', 'sessions');
    const outside = join(root, 'outside.jsonl');
    const source = join(legacy, 'project', 'session.jsonl');
    mkdirSync(dirname(source), { recursive: true });
    writeFileSync(outside, 'outside content\n');
    symlinkSync(outside, source);
    const settings = new SettingsStore(join(root, 'settings.json'));
    settings.rememberSession({
      id: 'symlink-id',
      name: null,
      path: source,
      cwd: null,
      runtime: 'pi',
      lastSeen: 1,
    });

    const result = await migrateLegacySessions(settings, legacy, target);

    expect(result).toEqual({ migrated: 0, retained: 0, skipped: 0 });
    expect(readFileSync(outside, 'utf8')).toBe('outside content\n');
    expect(existsSync(join(target, 'project', 'session.jsonl'))).toBe(false);
    expect(settings.current.recentSessions[0]?.path).toBe(source);
  });

  it('rejects a symlinked destination parent without writing outside AO storage', async () => {
    if (process.platform === 'win32') return;
    const root = mkdtempSync(join(tmpdir(), 'ao-session-migration-'));
    roots.push(root);
    const legacy = join(root, 'pi', 'sessions');
    const target = join(root, 'ao', 'sessions');
    const source = join(legacy, 'project', 'session.jsonl');
    const outside = join(root, 'outside');
    mkdirSync(dirname(source), { recursive: true });
    mkdirSync(outside, { recursive: true });
    mkdirSync(target, { recursive: true });
    writeFileSync(source, 'source content\n');
    symlinkSync(outside, join(target, 'project'));
    const settings = new SettingsStore(join(root, 'settings.json'));
    settings.rememberSession({
      id: 'destination-symlink-id',
      name: null,
      path: source,
      cwd: null,
      runtime: 'pi',
      lastSeen: 1,
    });

    const result = await migrateLegacySessions(settings, legacy, target);

    expect(result).toEqual({ migrated: 0, retained: 0, skipped: 1 });
    expect(existsSync(join(outside, 'session.jsonl'))).toBe(false);
    expect(settings.current.recentSessions[0]?.path).toBe(source);
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
