import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ModelRuntime, SettingsManager } from '@earendil-works/pi-coding-agent';
import { afterEach, describe, expect, it } from 'vitest';
import { CAPABILITY_RUNTIME_METHODS } from '../src/main/runtime/agent-runtime.js';
import {
  EMBEDDED_PI_CAPABILITIES,
  EmbeddedPiRuntime,
} from '../src/main/runtime/embedded-pi-runtime.js';
import type { AuthFlowEvent, RuntimeStatus } from '../src/shared/domain.js';
import { resourceCatalogSchema } from '../src/shared/resources.js';
import { estimateTextTokens } from '../src/shared/token-estimate.js';

const roots: string[] = [];
let active: EmbeddedPiRuntime | null = null;

async function waitFor<T>(read: () => T | undefined): Promise<T> {
  for (let index = 0; index < 100; index += 1) {
    const value = read();
    if (value !== undefined) return value;
    await new Promise((resolve) => setTimeout(resolve, 0));
  }
  throw new Error('condition was not reached');
}

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
      retryControls: true,
      sessionClone: false,
      sessionList: false,
      extensionDialogs: false,
      providerLogin: true,
      resourceReload: false,
      systemPromptInspection: false,
      toolCatalog: false,
    });
  });

  it('owns provider credentials and Pi preferences without exposing secrets', async () => {
    const root = mkdtempSync(join(tmpdir(), 'tau-gui-auth-settings-'));
    roots.push(root);
    const cwd = join(root, 'project');
    const agentDir = join(root, 'agent');
    mkdirSync(cwd, { recursive: true });
    const modelRuntime = await ModelRuntime.create({
      authPath: join(agentDir, 'auth.json'),
      modelsPath: null,
      refreshOnCreate: false,
    });
    const settingsManager = SettingsManager.inMemory({
      steeringMode: 'one-at-a-time',
      followUpMode: 'one-at-a-time',
      retry: { enabled: false, maxRetries: 4, baseDelayMs: 25 },
      compaction: { enabled: true, reserveTokens: 8_000, keepRecentTokens: 12_000 },
    });
    const authEvents: AuthFlowEvent[] = [];
    const runtime = new EmbeddedPiRuntime(
      {
        event: () => undefined,
        status: () => undefined,
        diagnostic: () => undefined,
        auth: (event) => authEvents.push(event),
      },
      { agentDir, home: root, modelRuntime, settingsManager },
    );
    active = runtime;
    await runtime.start({
      kind: 'pi',
      binary: '',
      cwd,
      extraArgs: [],
      projectTrust: 'default',
    });

    const login = runtime.loginProvider('openai', 'api_key');
    await waitFor(() => authEvents.find((event) => event.type === 'prompt'));
    const challenge = authEvents.find((event) => event.type === 'prompt');
    if (!challenge || challenge.type !== 'prompt') throw new Error('missing API-key challenge');
    expect(challenge.input).toBe('secret');
    expect(JSON.stringify(challenge)).not.toContain('desktop-test-key');
    await runtime.respondProviderAuth(challenge.flowId, challenge.challengeId, 'desktop-test-key');
    await login;

    const providers = await runtime.listProviderAuth();
    expect(providers).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ id: 'openai', configured: true, credentialType: 'api_key' }),
      ]),
    );
    expect(JSON.stringify(providers)).not.toContain('desktop-test-key');

    const updated = await runtime.updatePiPreferences({
      steeringMode: 'all',
      followUpMode: 'all',
      transport: 'sse',
      retryEnabled: true,
      autoCompactionEnabled: false,
      defaultProvider: 'openai',
      defaultModel: 'gpt-5',
      defaultThinkingLevel: 'max',
    });
    expect(updated).toMatchObject({
      steeringMode: 'all',
      followUpMode: 'all',
      transport: 'sse',
      retryEnabled: true,
      autoCompactionEnabled: false,
      retryMaxRetries: 4,
      retryBaseDelayMs: 25,
      compactionReserveTokens: 8_000,
      compactionKeepRecentTokens: 12_000,
      defaultProvider: 'openai',
      defaultModel: 'gpt-5',
      defaultThinkingLevel: 'max',
    });
    expect(updated.writable).toMatchObject({
      retryPolicy: false,
      compactionThresholds: false,
    });
    await runtime.abortRetry();
    await runtime.logoutProvider('openai');
    expect(
      (await runtime.listProviderAuth()).find((provider) => provider.id === 'openai'),
    ).toMatchObject({
      configured: false,
    });
  });

  it('cancels an outstanding provider challenge authoritatively', async () => {
    const root = mkdtempSync(join(tmpdir(), 'tau-gui-auth-cancel-'));
    roots.push(root);
    const cwd = join(root, 'project');
    mkdirSync(cwd, { recursive: true });
    const modelRuntime = await ModelRuntime.create({
      authPath: join(root, 'auth.json'),
      modelsPath: null,
      refreshOnCreate: false,
    });
    const authEvents: AuthFlowEvent[] = [];
    const runtime = new EmbeddedPiRuntime(
      {
        event: () => undefined,
        status: () => undefined,
        diagnostic: () => undefined,
        auth: (event) => authEvents.push(event),
      },
      { agentDir: join(root, 'agent'), home: root, modelRuntime },
    );
    active = runtime;
    await runtime.start({ kind: 'pi', binary: '', cwd, extraArgs: [], projectTrust: 'default' });
    const login = runtime.loginProvider('openai', 'api_key');
    await waitFor(() => authEvents.find((event) => event.type === 'prompt'));
    const prompt = authEvents.find((event) => event.type === 'prompt');
    if (!prompt) throw new Error('missing prompt');
    await runtime.cancelProviderAuth(prompt.flowId);
    await expect(login).rejects.toThrow('cancelled');
    expect(authEvents.at(-1)).toMatchObject({ type: 'complete', success: false });
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
  });
});
