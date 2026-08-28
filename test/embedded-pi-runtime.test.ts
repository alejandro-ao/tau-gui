import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { CAPABILITY_RUNTIME_METHODS } from '../src/main/runtime/agent-runtime.js';
import {
  EMBEDDED_PI_CAPABILITIES,
  EmbeddedPiRuntime,
} from '../src/main/runtime/embedded-pi-runtime.js';
import type { RuntimeStatus } from '../src/shared/domain.js';
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
  it('advertises only capabilities represented by executable runtime operations', () => {
    const runtime = new EmbeddedPiRuntime({
      event: () => undefined,
      status: () => undefined,
      diagnostic: () => undefined,
    });

    for (const [capability, enabled] of Object.entries(EMBEDDED_PI_CAPABILITIES)) {
      if (!enabled) continue;
      const methods =
        CAPABILITY_RUNTIME_METHODS[capability as keyof typeof CAPABILITY_RUNTIME_METHODS];
      expect(methods, `${capability} has no application-domain operation`).not.toBeNull();
      for (const method of methods ?? []) {
        expect(typeof runtime[method], `${capability} requires ${method}`).toBe('function');
      }
    }

    expect(EMBEDDED_PI_CAPABILITIES).toMatchObject({
      imagePrompt: false,
      abortBash: false,
      retryControls: false,
      sessionClone: true,
      sessionList: true,
      extensionDialogs: false,
      providerLogin: false,
      resourceReload: false,
      systemPromptInspection: false,
      toolCatalog: false,
    });
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
    expect(state.sessionFile).toContain(agentDir);
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

    const sessionInternals = runtime as unknown as {
      runtime: {
        session: {
          sessionManager: {
            appendMessage: (message: unknown) => string;
            appendSessionInfo: (name: string) => string;
          };
        };
      };
    };
    const originalId = (await runtime.getState()).sessionId;
    const entryId = sessionInternals.runtime.session.sessionManager.appendMessage({
      role: 'user',
      content: 'Native catalog task',
      timestamp: Date.now(),
    });
    sessionInternals.runtime.session.sessionManager.appendMessage({
      role: 'assistant',
      content: [{ type: 'text', text: 'Ready' }],
      api: 'test',
      provider: 'test',
      model: 'test',
      usage: {
        input: 1,
        output: 1,
        cacheRead: 0,
        cacheWrite: 0,
        totalTokens: 2,
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
      },
      stopReason: 'stop',
      timestamp: Date.now(),
    });
    sessionInternals.runtime.session.sessionManager.appendSessionInfo('safe\u202Eevil');
    await runtime.setLabel(entryId, 'bookmark');
    const tree = await runtime.getTree();
    const labeled = tree.rows.find((row) => row.id === entryId);
    expect(labeled?.label).toBe('bookmark');

    const catalog = await runtime.listSessions('all');
    expect(catalog).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          sessionId: originalId,
          source: 'native',
          name: 'safe evil',
          firstMessage: 'Native catalog task',
          cwd,
          messageCount: 2,
        }),
      ]),
    );
    expect(catalog[0]).not.toHaveProperty('path');

    const portable = join(root, 'portable.jsonl');
    await expect(runtime.exportJsonl(portable)).resolves.toBe(portable);
    await runtime.clone();
    const cloneId = (await runtime.getState()).sessionId;
    expect(cloneId).not.toBe(originalId);
    expect((await runtime.getMessages())[0]).toMatchObject({
      role: 'user',
      text: 'Native catalog task',
    });
    expect(await runtime.listSessions('all')).toEqual(
      expect.arrayContaining([expect.objectContaining({ sessionId: cloneId })]),
    );

    const collision = join(dirname((await runtime.getState()).sessionFile!), 'portable.jsonl');
    writeFileSync(collision, 'owned destination');
    await runtime.prepareImport(portable);
    await runtime.importJsonl(portable);
    expect(readFileSync(collision, 'utf8')).toBe('owned destination');
    expect((await runtime.getState()).sessionId).toBe(originalId);
    expect((await runtime.getMessages())[0]).toMatchObject({
      role: 'user',
      text: 'Native catalog task',
    });

    await expect(runtime.prepareImport((await runtime.getState()).sessionFile!)).rejects.toThrow(
      'active session',
    );

    const malformed = join(root, 'malformed.jsonl');
    writeFileSync(malformed, '{not-jsonl}\n');
    await expect(runtime.prepareImport(malformed)).rejects.toThrow();
    const staging = join(agentDir, 'import-staging');
    expect(readdirSync(staging)).toEqual([]);
  });
});
