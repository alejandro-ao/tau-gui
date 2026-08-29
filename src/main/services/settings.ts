import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import type { AppSettings, ModelRef, SessionRef } from '../../shared/domain.js';
import { DEFAULT_SETTINGS } from '../../shared/domain.js';
import {
  MAX_SCOPED_MODELS,
  repairScopedModelKey,
  toggleScopedKey,
} from '../../shared/scoped-models.js';

const MAX_RECENT_SESSIONS = 30;
const MAX_WORKING_DIRECTORIES = 100;
const MAX_RESOURCE_DIRECTORIES = 100;

/**
 * GUI-owned settings, persisted independently from Pi agent configuration.
 * Unknown or malformed fields fall back to defaults instead of throwing.
 */
export class SettingsStore {
  private settings: AppSettings;

  constructor(private readonly file: string) {
    this.settings = this.read();
  }

  static defaultFile(userDataDir: string): string {
    return join(userDataDir, 'settings.json');
  }

  get current(): AppSettings {
    return this.settings;
  }

  update(patch: Partial<AppSettings>): AppSettings {
    this.settings = {
      ...this.settings,
      ...patch,
      scopedModels: patch.scopedModels ?? this.settings.scopedModels,
    };
    this.write();
    return this.settings;
  }

  /** Persists a chooser-selected directory without replacing the whole settings object. */
  rememberWorkingDirectory(cwd: string): AppSettings {
    this.settings = {
      ...this.settings,
      cwd,
      workingDirectories: prependDirectory(this.settings.workingDirectories, cwd),
    };
    this.write();
    return this.settings;
  }

  /** Persists a native-chooser-selected resource directory without renderer path authority. */
  addResourceDirectory(kind: 'skills' | 'prompts', path: string): AppSettings {
    const key = kind === 'skills' ? 'customSkillDirectories' : 'customPromptDirectories';
    this.settings = {
      ...this.settings,
      [key]: [...this.settings[key].filter((directory) => directory !== path), path].slice(
        -MAX_RESOURCE_DIRECTORIES,
      ),
    };
    this.write();
    return this.settings;
  }

  removeResourceDirectory(kind: 'skills' | 'prompts', path: string): AppSettings {
    const key = kind === 'skills' ? 'customSkillDirectories' : 'customPromptDirectories';
    this.settings = {
      ...this.settings,
      [key]: this.settings[key].filter((directory) => directory !== path),
    };
    this.write();
    return this.settings;
  }

  /** Atomically toggles against current main-process settings. */
  toggleScopedModel(ref: ModelRef): AppSettings {
    this.settings = {
      ...this.settings,
      scopedModels: toggleScopedKey(this.settings.scopedModels, ref),
    };
    this.write();
    return this.settings;
  }

  /**
   * Records a session ref. With `bump` (the default for real activity, e.g. a
   * settled run) the entry moves to the top with a fresh `lastSeen`. Without
   * it — selecting, renaming, or otherwise refreshing state — the entry keeps
   * its position and timestamp; only its metadata is updated.
   */
  rememberSession(ref: SessionRef, bump = true): AppSettings {
    const existing = this.settings.recentSessions.find((item) => item.id === ref.id);
    const recentSessions =
      bump || !existing
        ? [ref, ...this.settings.recentSessions.filter((item) => item.id !== ref.id)]
        : this.settings.recentSessions.map((item) =>
            item.id === ref.id ? { ...ref, lastSeen: item.lastSeen } : item,
          );
    this.settings = {
      ...this.settings,
      workingDirectories: ref.cwd
        ? prependDirectory(this.settings.workingDirectories, ref.cwd)
        : this.settings.workingDirectories,
      recentSessions: recentSessions.slice(0, MAX_RECENT_SESSIONS),
    };
    this.write();
    return this.settings;
  }

  forgetSession(id: string): AppSettings {
    this.settings = {
      ...this.settings,
      recentSessions: this.settings.recentSessions.filter((item) => item.id !== id),
    };
    this.write();
    return this.settings;
  }

  private read(): AppSettings {
    try {
      if (!existsSync(this.file)) return { ...DEFAULT_SETTINGS };
      const parsed: unknown = JSON.parse(readFileSync(this.file, 'utf8'));
      return mergeSettings(parsed);
    } catch {
      return { ...DEFAULT_SETTINGS };
    }
  }

  private write(): void {
    try {
      mkdirSync(dirname(this.file), { recursive: true });
      writeFileSync(this.file, `${JSON.stringify(this.settings, null, 2)}\n`, 'utf8');
    } catch {
      // Settings persistence is best-effort; never break the session for it.
    }
  }
}

export function mergeSettings(value: unknown): AppSettings {
  if (typeof value !== 'object' || value === null) {
    return { ...DEFAULT_SETTINGS };
  }
  const wire = value as Record<string, unknown>;
  const pick = <T>(key: string, guard: (input: unknown) => boolean, fallback: T): T =>
    guard(wire[key]) ? (wire[key] as T) : fallback;
  const isString = (input: unknown): boolean => typeof input === 'string';

  const recentSessions = Array.isArray(wire['recentSessions'])
    ? wire['recentSessions'].filter(isSessionRef).slice(0, MAX_RECENT_SESSIONS)
    : [];
  const cwd = isString(wire['cwd']) ? (wire['cwd'] as string) : null;
  const persistedDirectories = Array.isArray(wire['workingDirectories'])
    ? wire['workingDirectories'].filter(
        (item): item is string => typeof item === 'string' && item.length > 0,
      )
    : [];
  const workingDirectories = [
    ...persistedDirectories,
    cwd,
    ...recentSessions.map((item) => item.cwd),
  ]
    .filter((item): item is string => Boolean(item))
    .filter((item, index, all) => all.indexOf(item) === index)
    .slice(0, MAX_WORKING_DIRECTORIES);

  return {
    theme: pick(
      'theme',
      (input) => input === 'tau-light' || input === 'high-contrast' || input === 'pure-black',
      'tau-dark',
    ),
    sidebarPosition: pick(
      'sidebarPosition',
      (input) => input === 'left' || input === 'off',
      'right',
    ),
    turnNotification: wire['turnNotification'] === 'off' ? 'off' : 'desktop',
    showThinking: wire['showThinking'] !== false,
    cwd,
    workingDirectories,
    customSkillDirectories: readDirectories(wire['customSkillDirectories']).slice(
      0,
      MAX_RESOURCE_DIRECTORIES,
    ),
    customPromptDirectories: readDirectories(wire['customPromptDirectories']).slice(
      0,
      MAX_RESOURCE_DIRECTORIES,
    ),
    projectTrust: pick(
      'projectTrust',
      (input) => input === 'approve-once' || input === 'decline-once',
      'default',
    ),
    scopedModels: mergeScopedModels(wire['scopedModels']),
    recentSessions,
  };
}

function readDirectories(value: unknown): string[] {
  return Array.isArray(value)
    ? value
        .filter(
          (item): item is string =>
            typeof item === 'string' &&
            item.length > 0 &&
            item.length <= 4_096 &&
            ![...item].some((character) => {
              const codePoint = character.codePointAt(0) ?? 0;
              return codePoint <= 0x1f || codePoint === 0x7f;
            }),
        )
        .filter((item, index, all) => all.indexOf(item) === index)
    : [];
}

function prependDirectory(directories: string[], cwd: string): string[] {
  return [cwd, ...directories.filter((directory) => directory !== cwd)].slice(
    0,
    MAX_WORKING_DIRECTORIES,
  );
}

function mergeScopedModels(value: unknown): string[] {
  const legacy =
    typeof value === 'object' && value !== null && !Array.isArray(value)
      ? ((value as Record<string, unknown>)['pi'] ?? (value as Record<string, unknown>)['tau'])
      : value;
  return Array.isArray(legacy)
    ? [
        ...new Set(
          legacy.map(repairScopedModelKey).filter((item): item is string => item !== null),
        ),
      ].slice(0, MAX_SCOPED_MODELS)
    : [];
}

function isSessionRef(value: unknown): value is SessionRef {
  if (typeof value !== 'object' || value === null) return false;
  const wire = value as Record<string, unknown>;
  return (
    typeof wire['id'] === 'string' &&
    (wire['runtime'] === 'tau' || wire['runtime'] === 'pi') &&
    (wire['cwd'] === undefined || wire['cwd'] === null || typeof wire['cwd'] === 'string') &&
    (wire['firstMessage'] === undefined ||
      wire['firstMessage'] === null ||
      typeof wire['firstMessage'] === 'string') &&
    (wire['messageCount'] === undefined ||
      (typeof wire['messageCount'] === 'number' &&
        Number.isInteger(wire['messageCount']) &&
        wire['messageCount'] >= 0))
  );
}
