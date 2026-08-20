import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { EmbeddedPiRuntime } from '../src/main/runtime/embedded-pi-runtime.js';
import { RuntimeManager } from '../src/main/services/runtime-manager.js';
import { SettingsStore } from '../src/main/services/settings.js';
import { DEFAULT_SETTINGS, type RuntimeStatus } from '../src/shared/domain.js';
import { resourceCatalogSchema } from '../src/shared/resources.js';
import { estimateTextTokens } from '../src/shared/token-estimate.js';

const roots: string[] = [];
let active: EmbeddedPiRuntime | null = null;

afterEach(async () => {
  await active?.stop();
  active = null;
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe('EmbeddedPiRuntime', () => {
  it('opens an explicit external Pi session without cataloging it as AO-owned', async () => {
    const root = mkdtempSync(join(tmpdir(), 'ao-embedded-pi-'));
    roots.push(root);
    const project = join(root, 'project');
    const agentDir = join(root, 'home', '.pi', 'agent');
    const sessionRoot = join(root, 'home', '.ao-agent');
    const externalSession = join(root, 'pi', 'sessions', 'external.jsonl');
    mkdirSync(project, { recursive: true });
    mkdirSync(dirname(externalSession), { recursive: true });
    writeFileSync(
      externalSession,
      `${JSON.stringify({
        type: 'session',
        version: 3,
        id: 'external-session',
        timestamp: '2026-01-01T00:00:00.000Z',
        cwd: project,
      })}\n`,
    );
    const settings = new SettingsStore(join(root, 'settings.json'));
    settings.update({
      ...DEFAULT_SETTINGS,
      cwd: project,
      runtime: {
        ...DEFAULT_SETTINGS.runtime,
        pi: { ...DEFAULT_SETTINGS.runtime.pi, binary: '/not-used' },
      },
    });
    const manager = new RuntimeManager(settings, () => undefined, {
      probeExecutable: false,
      sessionRoot,
      runtimeFactory: (_kind, sink) =>
        new EmbeddedPiRuntime(sink, { agentDir, sessionRoot, home: join(root, 'home') }),
    });

    try {
      const snapshot = await manager.start({
        cwd: project,
        runtime: 'pi',
        sessionRef: externalSession,
      });

      expect(snapshot.state?.sessionId).toBe('external-session');
      expect(snapshot.state?.sessionFile).toBe(externalSession);
      expect(settings.current.recentSessions).toEqual([]);
    } finally {
      await manager.stop();
    }
  });

  it('does not catalog an external session reached through an AO symlink alias', async () => {
    if (process.platform === 'win32') return;
    const root = mkdtempSync(join(tmpdir(), 'ao-embedded-pi-'));
    roots.push(root);
    const project = join(root, 'project');
    const agentDir = join(root, 'home', '.pi', 'agent');
    const sessionRoot = join(root, 'home', '.ao-agent');
    const sessions = join(sessionRoot, 'sessions');
    const outside = join(root, 'pi', 'sessions', 'external.jsonl');
    const alias = join(sessions, 'external-alias.jsonl');
    mkdirSync(project, { recursive: true });
    mkdirSync(sessions, { recursive: true });
    mkdirSync(dirname(outside), { recursive: true });
    writeFileSync(
      outside,
      `${JSON.stringify({
        type: 'session',
        version: 3,
        id: 'external-alias-session',
        timestamp: '2026-01-01T00:00:00.000Z',
        cwd: project,
      })}\n`,
    );
    symlinkSync(outside, alias);
    const settings = new SettingsStore(join(root, 'settings.json'));
    const manager = new RuntimeManager(settings, () => undefined, {
      probeExecutable: false,
      sessionRoot,
      runtimeFactory: (_kind, sink) =>
        new EmbeddedPiRuntime(sink, { agentDir, sessionRoot, home: join(root, 'home') }),
    });

    try {
      const snapshot = await manager.start({
        cwd: project,
        runtime: 'pi',
        sessionRef: alias,
      });
      expect(snapshot.state?.sessionId).toBe('external-alias-session');
      expect(settings.current.recentSessions).toEqual([]);
    } finally {
      await manager.stop();
    }
  });

  it('starts without an external executable and exposes Pi-owned resources', async () => {
    const root = mkdtempSync(join(tmpdir(), 'tau-gui-embedded-pi-'));
    roots.push(root);
    const project = join(root, 'project');
    const contextDirectories = [
      project,
      join(project, 'a'),
      join(project, 'a', 'b'),
      join(project, 'a', 'b', 'c'),
      join(project, 'a', 'b', 'c', 'd'),
      join(project, 'a', 'b', 'c', 'd', 'e'),
    ];
    const cwd = contextDirectories.at(-1)!;
    const agentDir = join(root, 'home', '.pi', 'agent');
    const sessionRoot = join(root, 'home', '.ao-agent');
    const home = join(root, 'home');
    const customSkills = join(root, 'shared-skills');
    const customPrompts = join(root, 'shared-prompts');
    mkdirSync(join(project, '.git'), { recursive: true });
    mkdirSync(join(cwd, '.pi', 'prompts'), { recursive: true });
    mkdirSync(join(project, '.pi', 'prompts'), { recursive: true });
    mkdirSync(join(project, '.agents', 'prompts'), { recursive: true });
    mkdirSync(join(agentDir, 'skills', 'review'), { recursive: true });
    mkdirSync(join(home, '.pi', 'prompts'), { recursive: true });
    mkdirSync(join(home, '.agents', 'skills', 'global-agent'), { recursive: true });
    mkdirSync(join(home, '.agents', 'prompts'), { recursive: true });
    mkdirSync(join(customSkills, 'shared'), { recursive: true });
    mkdirSync(customPrompts, { recursive: true });
    writeFileSync(join(cwd, '.pi', 'prompts', 'check.md'), '# Check\nReview this project.\n');
    writeFileSync(join(project, '.pi', 'prompts', 'root.md'), '# Root prompt\n');
    writeFileSync(join(project, '.agents', 'prompts', 'agent-prompt.md'), '# Agent prompt\n');
    writeFileSync(join(customPrompts, 'shared.md'), '# Shared prompt\n');
    writeFileSync(join(home, '.pi', 'prompts', 'home-pi.md'), '# Home Pi prompt\n');
    writeFileSync(join(home, '.agents', 'prompts', 'home-agent.md'), '# Home agent prompt\n');
    const skillText =
      '---\nname: review\ndescription: Review code\n---\n# Réview 🧪\nUse exact instructions.\n';
    writeFileSync(join(agentDir, 'skills', 'review', 'SKILL.md'), skillText);
    writeFileSync(
      join(home, '.agents', 'skills', 'global-agent', 'SKILL.md'),
      '---\nname: global-agent\ndescription: Global agent skill\n---\n# Global\n',
    );
    writeFileSync(
      join(customSkills, 'shared', 'SKILL.md'),
      `---\nname: shared\ndescription: ${'s'.repeat(600)}\n---\n# Shared\n`,
    );
    const globalContext = join(agentDir, 'AGENTS.md');
    writeFileSync(globalContext, '# Global instructions\n');
    for (const directory of contextDirectories) {
      mkdirSync(directory, { recursive: true });
      writeFileSync(join(directory, 'AGENTS.md'), `# Instructions for ${directory}\n`);
    }

    const statuses: RuntimeStatus[] = [];
    const runtime = new EmbeddedPiRuntime(
      {
        event: () => undefined,
        status: (status) => statuses.push(status),
        diagnostic: () => undefined,
      },
      {
        agentDir,
        sessionRoot,
        home,
        spawnSession: ({ cwd: spawnedCwd }) =>
          Promise.resolve({
            sessionId: 'spawned-session',
            sessionFile: null,
            cwd: spawnedCwd,
          }),
      },
    );
    active = runtime;

    await runtime.start({
      kind: 'pi',
      binary: '/definitely/not/an/executable',
      cwd,
      extraArgs: [],
      projectTrust: 'default',
      customSkillDirectories: [customSkills],
      customPromptDirectories: [customPrompts],
    });

    const state = await runtime.getState();
    expect(state.sessionId).not.toBe('');
    expect(state.sessionFile).toContain(join(sessionRoot, 'sessions'));
    expect(state.sessionFile).not.toContain(agentDir);
    expect(statuses).toEqual(expect.arrayContaining(['starting', 'idle']));
    const internals = runtime as unknown as {
      runtime: { session: { getToolDefinition: (name: string) => unknown } };
    };
    expect(internals.runtime.session.getToolDefinition('spawn_session')).toBeDefined();

    const resources = await runtime.getResources();
    const parsedResources = resourceCatalogSchema.safeParse(resources);
    expect(
      parsedResources.success,
      parsedResources.success ? '' : parsedResources.error.message,
    ).toBe(true);
    expect(resources.prompts.map((prompt) => prompt.name)).toEqual(
      expect.arrayContaining(['check', 'root', 'agent-prompt', 'home-pi', 'home-agent', 'shared']),
    );
    expect(resources.skills.map((skill) => skill.name)).toEqual(
      expect.arrayContaining(['review', 'global-agent', 'shared']),
    );
    const review = resources.skills.find((skill) => skill.name === 'review');
    expect(review?.estimatedTokens).toBe(estimateTextTokens(skillText));

    const contextFiles = await runtime.getContextFiles();
    const labels = new Map(contextFiles.map((file) => [file.path, file.label]));
    expect(contextFiles.length).toBeGreaterThanOrEqual(7);
    expect(labels.get(globalContext)).toBe('~/.pi/agent/AGENTS.md');
    expect(labels.get(join(cwd, 'AGENTS.md'))).toBe('./AGENTS.md');
    expect(labels.get(join(project, 'AGENTS.md'))).toBe('../../../../../AGENTS.md');
  });
});
