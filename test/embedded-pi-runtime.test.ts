import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { CAPABILITY_RUNTIME_METHODS } from '../src/main/runtime/agent-runtime.js';
import {
  EMBEDDED_PI_CAPABILITIES,
  EmbeddedPiRuntime,
} from '../src/main/runtime/embedded-pi-runtime.js';
import { MAX_TOOL_OUTPUT_CHARACTERS } from '../src/main/runtime/untrusted.js';
import type { RuntimeStatus } from '../src/shared/domain.js';
import { INTROSPECTION_LIMITS } from '../src/shared/introspection.js';
import { resourceCatalogSchema } from '../src/shared/resources.js';
import {
  MAX_SESSION_IDENTIFIER_CHARACTERS,
  MAX_SESSION_STRUCTURE_BYTES,
} from '../src/shared/session-structures.js';
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
      resourceReload: true,
      systemPromptInspection: true,
      toolCatalog: true,
      imagePrompt: false,
      abortBash: false,
      retryControls: false,
      sessionClone: false,
      sessionList: false,
      extensionDialogs: false,
      providerLogin: true,
    });
  });

  it('bounds live shell and restored entry/tree responses before IPC', async () => {
    const huge = 'x'.repeat(2 * 1024 * 1024);
    const entry = {
      id: 'tool-entry',
      type: 'message',
      message: {
        role: 'toolResult',
        toolCallId: 'call',
        toolName: 'read',
        content: huge,
        details: { nested: huge },
      },
    };
    const runtime = new EmbeddedPiRuntime({
      event: () => undefined,
      status: () => undefined,
      diagnostic: () => undefined,
    });
    (runtime as unknown as { runtime: unknown }).runtime = {
      session: {
        executeBash: () =>
          Promise.resolve({ output: huge, exitCode: 0, cancelled: false, truncated: false }),
        sessionManager: {
          getEntries: () => [entry],
          getTree: () => [{ entry, children: [] }],
          getLeafId: () => huge,
        },
      },
    };

    const shell = await runtime.runShell('printf huge', false);
    expect(shell.output).toHaveLength(MAX_TOOL_OUTPUT_CHARACTERS);
    expect(shell.truncated).toBe(true);
    const entries = await runtime.getEntries();
    const tree = await runtime.getTree();
    expect(entries.leafId).toHaveLength(MAX_SESSION_IDENTIFIER_CHARACTERS);
    expect(tree.leafId).toHaveLength(MAX_SESSION_IDENTIFIER_CHARACTERS);
    expect(Buffer.byteLength(JSON.stringify(entries))).toBeLessThanOrEqual(
      MAX_SESSION_STRUCTURE_BYTES,
    );
    expect(Buffer.byteLength(JSON.stringify(tree))).toBeLessThanOrEqual(
      MAX_SESSION_STRUCTURE_BYTES,
    );
    expect(entries.entries[0]).not.toHaveProperty('raw');
  });

  it('sanitizes hostile tool arrays and descriptors without ordinary property reads', async () => {
    let descriptorGets = 0;
    let accessorGets = 0;
    let sourceGets = 0;
    let arrayGets = 0;
    const valid = (name: string, sourceInfo: unknown = { source: 'test' }) => ({
      name,
      description: 'safe',
      parameters: { type: 'object' },
      sourceInfo,
    });
    const nonthrowing = new Proxy(valid('proxy-safe'), {
      get(target, key, receiver): unknown {
        descriptorGets += 1;
        return Reflect.get(target, key, receiver) as unknown;
      },
    });
    const throwingGet = new Proxy(valid('proxy-throwing-get'), {
      get() {
        descriptorGets += 1;
        throw new Error('ordinary descriptor get must not run');
      },
    });
    const throwingReflection = new Proxy(valid('reflection-failure'), {
      ownKeys() {
        throw new Error('reflection denied');
      },
    });
    const accessorDescriptor = valid('accessor');
    Object.defineProperty(accessorDescriptor, 'name', {
      enumerable: true,
      get: () => {
        accessorGets += 1;
        return 'getter-leak';
      },
    });
    const accessorSource = {};
    Object.defineProperty(accessorSource, 'source', {
      enumerable: true,
      get: () => {
        sourceGets += 1;
        return 'getter-origin';
      },
    });
    const revoked = Proxy.revocable(valid('revoked'), {});
    revoked.revoke();
    const rawTools: unknown[] = [
      valid('read'),
      nonthrowing,
      throwingGet,
      accessorDescriptor,
      throwingReflection,
      revoked.proxy,
      valid('source-fallback', accessorSource),
      valid('dup\n'),
      valid('dup '),
      null,
      42,
      false,
    ];
    Object.defineProperty(rawTools, '11', {
      configurable: true,
      enumerable: true,
      get: () => {
        accessorGets += 1;
        return valid('array-getter');
      },
    });
    const tools = new Proxy(rawTools, {
      get(target, key, receiver): unknown {
        arrayGets += 1;
        return Reflect.get(target, key, receiver) as unknown;
      },
    });
    const active = ['read', 'proxy-safe', 'proxy-throwing-get'];
    Object.defineProperty(active, '2', {
      configurable: true,
      enumerable: true,
      get: () => {
        accessorGets += 1;
        return 'proxy-throwing-get';
      },
    });
    const runtime = new EmbeddedPiRuntime({
      event: () => undefined,
      status: () => undefined,
      diagnostic: () => undefined,
    });
    (runtime as unknown as { runtime: unknown }).runtime = {
      session: {
        getAllTools: () => tools,
        getActiveToolNames: () => active,
      },
    };

    const catalog = await runtime.listTools();
    expect(descriptorGets).toBe(0);
    expect(arrayGets).toBe(0);
    expect(accessorGets).toBe(0);
    expect(sourceGets).toBe(0);
    expect(catalog.tools.map((tool) => tool.name)).toEqual([
      'read',
      'proxy-safe',
      'proxy-throwing-get',
      'source-fallback',
      'dup',
    ]);
    expect(catalog.tools.find((tool) => tool.name === 'source-fallback')?.origin).toBe('unknown');
    expect(catalog.tools.filter((tool) => tool.name === 'dup')).toHaveLength(1);
    expect(catalog.truncated).toBe(true);
    expect(catalog.diagnostics.length).toBeLessThanOrEqual(INTROSPECTION_LIMITS.diagnostics);
    expect(catalog.diagnostics.every((item) => item.length <= 512)).toBe(true);

    const revokedArray = Proxy.revocable([valid('never')], {});
    revokedArray.revoke();
    (runtime as unknown as { runtime: { session: Record<string, unknown> } }).runtime.session[
      'getAllTools'
    ] = () => revokedArray.proxy;
    await expect(runtime.listTools()).resolves.toMatchObject({ tools: [], truncated: true });

    (runtime as unknown as { runtime: { session: Record<string, unknown> } }).runtime.session[
      'getAllTools'
    ] = () => {
      throw new Error('catalog failure');
    };
    (runtime as unknown as { runtime: { session: Record<string, unknown> } }).runtime.session[
      'getActiveToolNames'
    ] = () => {
      throw new Error('active failure');
    };
    await expect(runtime.listTools()).resolves.toMatchObject({ tools: [], truncated: true });
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

    const messagesBeforeInspection = await runtime.getMessages();
    const systemPrompt = await runtime.inspectSystemPrompt();
    expect(systemPrompt.text).toContain('Global instructions');
    expect(systemPrompt.origin).toBe('active Pi session');
    expect(systemPrompt.truncated).toBe(false);

    const tools = await runtime.listTools();
    expect(tools.tools.map((tool) => tool.name)).toEqual(
      expect.arrayContaining(['read', 'bash', 'edit', 'write', 'spawn_session']),
    );
    expect(tools.tools.find((tool) => tool.name === 'read')).toMatchObject({
      active: true,
      origin: 'builtin',
      schemaTruncated: false,
    });
    expect(await runtime.getMessages()).toEqual(messagesBeforeInspection);

    mkdirSync(join(customSkills, 'after-reload'), { recursive: true });
    writeFileSync(
      join(customSkills, 'after-reload', 'SKILL.md'),
      '---\nname: after-reload\ndescription: Added later\n---\n# Later\n',
    );
    const reload = await runtime.reloadResources();
    expect(reload.after.skills).toBe(reload.before.skills + 1);
    expect((await runtime.getResources()).skills.map((skill) => skill.name)).toContain(
      'after-reload',
    );
    expect(await runtime.getMessages()).toEqual(messagesBeforeInspection);

    const contextFiles = await runtime.getContextFiles();
    const labels = new Map(contextFiles.map((file) => [file.path, file.label]));
    expect(contextFiles.length).toBeGreaterThanOrEqual(7);
    expect(labels.get(globalContext)).toBe('~/.pi/agent/AGENTS.md');
    expect(labels.get(join(cwd, 'AGENTS.md'))).toBe('./AGENTS.md');
    expect(labels.get(join(project, 'AGENTS.md'))).toBe('../../../../../AGENTS.md');
  });
});
