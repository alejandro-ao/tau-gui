import {
  appendFileSync,
  linkSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  symlinkSync,
  truncateSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { SessionManager } from '@earendil-works/pi-coding-agent';
import { afterEach, describe, expect, it } from 'vitest';
import { CAPABILITY_RUNTIME_METHODS } from '../src/main/runtime/agent-runtime.js';
import { ImportRecoveryService } from '../src/main/services/import-recovery.js';
import { SESSION_IO_LIMITS } from '../src/main/runtime/session-files.js';
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

function appendConversation(manager: SessionManager, text: string): void {
  manager.appendMessage({ role: 'user', content: text, timestamp: Date.now() });
  manager.appendMessage({
    role: 'assistant',
    content: [{ type: 'text', text: 'safe reply' }],
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
}

function recoveryHealth(agentDir: string): Promise<{ retained: number; capacity: number }> {
  return new ImportRecoveryService(agentDir, () => Promise.resolve('')).health();
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
      resourceReload: true,
      systemPromptInspection: true,
      toolCatalog: true,
      imagePrompt: false,
      abortBash: false,
      retryControls: false,
      sessionClone: true,
      sessionList: true,
      extensionDialogs: false,
      providerLogin: false,
    });
  });

  it.each(['regular replacement', 'symlink replacement', 'hardlink replacement', 'same inode'])(
    'clones the live manager without reading or mutating an externally changed source: %s',
    async (mutation) => {
      const root = mkdtempSync(join(tmpdir(), 'tau-gui-clone-race-'));
      roots.push(root);
      const cwd = join(root, 'project');
      const agentDir = join(root, 'agent');
      mkdirSync(cwd, { recursive: true });

      const runtime = new EmbeddedPiRuntime(
        { event: () => undefined, status: () => undefined, diagnostic: () => undefined },
        { agentDir, home: root },
      );
      active = runtime;
      await runtime.start({
        kind: 'pi',
        binary: '',
        cwd,
        extraArgs: [],
        projectTrust: 'default',
      });

      const manager = (
        runtime as unknown as { runtime: { session: { sessionManager: SessionManager } } }
      ).runtime.session.sessionManager;
      appendConversation(manager, `live manager ${mutation}`);
      const source = manager.getSessionFile();
      if (!source) throw new Error('clone fixture was not persisted');
      const sourceId = manager.getSessionId();
      const displaced = `${source}.displaced`;
      const external = join(root, 'external.jsonl');
      const externalBytes = Buffer.from(`EXTERNAL-${mutation}`);
      const createBranchedSession = manager.createBranchedSession.bind(manager);
      let createCalls = 0;

      manager.createBranchedSession = (leafId: string) => {
        createCalls += 1;
        if (mutation === 'same inode') {
          writeFileSync(source, externalBytes);
        } else {
          renameSync(source, displaced);
          if (mutation === 'regular replacement') {
            writeFileSync(source, externalBytes);
          } else {
            writeFileSync(external, externalBytes);
            if (mutation === 'symlink replacement') symlinkSync(external, source);
            else linkSync(external, source);
          }
        }

        const destination = createBranchedSession(leafId);
        const probe =
          mutation === 'regular replacement' || mutation === 'same inode' ? source : external;
        expect(readFileSync(probe)).toEqual(externalBytes);
        return destination;
      };

      await runtime.clone();

      expect(createCalls).toBe(1);
      expect((await runtime.getState()).sessionId).not.toBe(sourceId);
      expect(await runtime.getMessages()).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ role: 'user', text: `live manager ${mutation}` }),
          expect.objectContaining({ role: 'assistant', text: 'safe reply' }),
        ]),
      );
      const probe =
        mutation === 'regular replacement' || mutation === 'same inode' ? source : external;
      expect(readFileSync(probe)).toEqual(externalBytes);
    },
  );

  it.each([
    {
      name: 'in-place overwrite',
      mutate: (path: string, original: Buffer) =>
        writeFileSync(path, Buffer.alloc(original.length, 0x20)),
    },
    {
      name: 'truncate',
      mutate: (path: string) => truncateSync(path, 1),
    },
    {
      name: 'same-length rewrite',
      mutate: (path: string, original: Buffer) => writeFileSync(path, original),
    },
    {
      name: 'valid foreign session replacement',
      mutate: (path: string, _original: Buffer, foreign: Buffer) => writeFileSync(path, foreign),
    },
  ])(
    'refuses inactive portable export through a stale opaque id after $name',
    async ({ name, mutate }) => {
      const root = mkdtempSync(join(tmpdir(), 'tau-gui-inactive-export-'));
      roots.push(root);
      const cwd = join(root, 'project');
      const agentDir = join(root, 'agent');
      mkdirSync(cwd, { recursive: true });

      const foreign = SessionManager.create(cwd, join(root, 'foreign'));
      foreign.appendMessage({ role: 'user', content: 'session B', timestamp: Date.now() });
      foreign.appendMessage({
        role: 'assistant',
        content: [{ type: 'text', text: 'reply B' }],
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
      const foreignPath = foreign.getSessionFile();
      if (!foreignPath) throw new Error('foreign fixture was not persisted');

      const runtime = new EmbeddedPiRuntime(
        { event: () => undefined, status: () => undefined, diagnostic: () => undefined },
        { agentDir, home: root },
      );
      active = runtime;
      await runtime.start({
        kind: 'pi',
        binary: '',
        cwd,
        extraArgs: [],
        projectTrust: 'default',
      });

      const originalManager = (
        runtime as unknown as { runtime: { session: { sessionManager: SessionManager } } }
      ).runtime.session.sessionManager;
      originalManager.appendMessage({ role: 'user', content: 'session A', timestamp: Date.now() });
      originalManager.appendMessage({
        role: 'assistant',
        content: [{ type: 'text', text: 'reply A' }],
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
      const originalId = originalManager.getSessionId();
      const inactivePath = originalManager.getSessionFile();
      if (!inactivePath) throw new Error('inactive fixture was not persisted');
      await runtime.newSession();

      const catalog = await runtime.listSessions('all');
      const selected = catalog.find((record) => record.sessionId === originalId);
      if (!selected) throw new Error('inactive fixture was not cataloged');
      expect(selected.id).toMatch(/^pi-[a-f0-9]{32}$/);

      const original = readFileSync(inactivePath);
      const foreignBytes = readFileSync(foreignPath);
      mutate(inactivePath, original, foreignBytes);

      const destination = join(root, `${name.replaceAll(' ', '-')}.jsonl`);
      await expect(runtime.exportJsonl(destination, selected.id)).rejects.toThrow(
        /catalog|identity|record/,
      );
      expect(() => readFileSync(destination)).toThrow();
    },
  );

  it('copies empty and legacy imports before Pi initializes or migrates them', async () => {
    const root = mkdtempSync(join(tmpdir(), 'tau-gui-legacy-import-'));
    roots.push(root);
    const cwd = join(root, 'project');
    const agentDir = join(root, 'agent');
    mkdirSync(cwd, { recursive: true });
    let destination = 0;
    const runtime = new EmbeddedPiRuntime(
      { event: () => undefined, status: () => undefined, diagnostic: () => undefined },
      {
        agentDir,
        home: root,
        importDestinationName: () => `legacy-${destination++}.jsonl`,
      },
    );
    active = runtime;
    await runtime.start({
      kind: 'pi',
      binary: '',
      cwd,
      extraArgs: [],
      projectTrust: 'default',
    });

    const sources: string[] = [];
    const empty = join(root, 'empty.jsonl');
    writeFileSync(empty, '');
    sources.push(empty);
    for (const version of [1, 2]) {
      const directory = join(root, `v${version}`);
      mkdirSync(directory);
      const manager = SessionManager.create(cwd, directory);
      manager.appendMessage({ role: 'user', content: `legacy v${version}`, timestamp: Date.now() });
      manager.appendMessage({
        role: 'assistant',
        content: [{ type: 'text', text: 'ready' }],
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
      const path = manager.getSessionFile();
      if (!path) throw new Error('legacy fixture was not persisted');
      const migratedFixture = readFileSync(path, 'utf8')
        .trimEnd()
        .split('\n')
        .map((line, index) => {
          const entry = JSON.parse(line) as Record<string, unknown>;
          if (index === 0) entry['version'] = version;
          if (version === 1 && index > 0) {
            delete entry['id'];
            delete entry['parentId'];
          }
          return JSON.stringify(entry);
        })
        .join('\n');
      writeFileSync(path, `${migratedFixture}\n`);
      sources.push(path);
    }

    for (const source of sources) {
      const original = readFileSync(source);
      await runtime.prepareImport(source);
      await runtime.importJsonl(source);
      expect(readFileSync(source)).toEqual(original);
      const imported = readFileSync((await runtime.getState()).sessionFile!, 'utf8');
      expect(imported).toContain('"version":3');
    }
    expect(await recoveryHealth(agentDir)).toEqual({ retained: 0, capacity: 32 });
  });

  it('exports an active main-owned legacy session outside catalog roots safely', async () => {
    const root = mkdtempSync(join(tmpdir(), 'tau-gui-legacy-export-'));
    roots.push(root);
    const cwd = join(root, 'project');
    const agentDir = join(root, 'agent');
    const externalDir = join(root, 'legacy');
    mkdirSync(cwd, { recursive: true });
    mkdirSync(externalDir);
    const manager = SessionManager.create(cwd, externalDir);
    manager.appendMessage({ role: 'user', content: 'legacy export', timestamp: Date.now() });
    manager.appendMessage({
      role: 'assistant',
      content: [{ type: 'text', text: 'ready' }],
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
    const externalPath = manager.getSessionFile();
    if (!externalPath) throw new Error('external fixture was not persisted');
    const legacy = readFileSync(externalPath, 'utf8').replace('"version":3', '"version":2');
    writeFileSync(externalPath, legacy);

    let mutateOnCreate = false;
    const runtime = new EmbeddedPiRuntime(
      { event: () => undefined, status: () => undefined, diagnostic: () => undefined },
      {
        agentDir,
        home: root,
        exportAfterCreate: () => {
          if (mutateOnCreate) appendFileSync(externalPath, '\n');
        },
      },
    );
    active = runtime;
    await runtime.start({
      kind: 'pi',
      binary: '',
      cwd,
      sessionRef: externalPath,
      extraArgs: [],
      projectTrust: 'default',
    });

    const portable = join(root, 'external-portable.jsonl');
    await expect(runtime.exportJsonl(portable)).resolves.toBe(portable);
    expect(readFileSync(portable, 'utf8')).toContain(manager.getSessionId());

    const alias = join(root, 'external-hardlink.jsonl');
    linkSync(externalPath, alias);
    await expect(runtime.exportJsonl(join(root, 'hardlink-rejected.jsonl'))).rejects.toThrow(
      'singly-linked',
    );
    rmSync(alias);

    const displaced = `${externalPath}.displaced`;
    const unrelated = join(root, 'unrelated.jsonl');
    writeFileSync(unrelated, 'unrelated');
    renameSync(externalPath, displaced);
    writeFileSync(externalPath, 'stale replacement');
    await expect(runtime.exportJsonl(join(root, 'stale-rejected.jsonl'))).rejects.toThrow(
      'changed during binding',
    );
    rmSync(externalPath);
    symlinkSync(unrelated, externalPath);
    await expect(runtime.exportJsonl(join(root, 'symlink-rejected.jsonl'))).rejects.toThrow();
    rmSync(externalPath);
    renameSync(displaced, externalPath);

    mutateOnCreate = true;
    await expect(runtime.exportJsonl(join(root, 'mutation-rejected.jsonl'))).rejects.toThrow(
      'changed during copy',
    );
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
    expect(tree.leafId).toHaveLength(128);
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
    let forcedImportDestination: string | null = null;
    let mutateExportSource: (() => void) | null = null;
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
            cwd: spawnedCwd,
          }),
        importDestinationName: () => forcedImportDestination ?? 'unused-import.jsonl',
        exportAfterCreate: () => mutateExportSource?.(),
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

    // Mutating the same inode after fresh catalog selection must fail closed.
    const activePath = (await runtime.getState()).sessionFile!;
    const authoritativeBytes = readFileSync(activePath);
    const mutations: Array<[string, () => void]> = [
      ['overwrite', () => writeFileSync(activePath, Buffer.alloc(authoritativeBytes.length, 0x20))],
      ['truncate', () => writeFileSync(activePath, authoritativeBytes.subarray(0, 1))],
      ['rewrite', () => writeFileSync(activePath, authoritativeBytes)],
    ];
    for (const [name, mutation] of mutations) {
      mutateExportSource = mutation;
      await expect(runtime.exportJsonl(join(root, `${name}-rejected.jsonl`))).rejects.toThrow(
        /Copy source changed during copy|Copy source ended unexpectedly/,
      );
      mutateExportSource = null;
      writeFileSync(activePath, authoritativeBytes);
    }

    // A stale active path or symlink swap must never export its target.
    const swappedActivePath = (await runtime.getState()).sessionFile!;
    const displacedActive = `${swappedActivePath}.displaced`;
    const secret = join(root, 'secret.jsonl');
    const rejectedExport = join(root, 'rejected-swap.jsonl');
    writeFileSync(secret, 'SECRET-SWAP-CONTENT');
    renameSync(swappedActivePath, displacedActive);
    symlinkSync(secret, swappedActivePath);
    await expect(runtime.exportJsonl(rejectedExport)).rejects.toThrow();
    expect(() => readFileSync(rejectedExport, 'utf8')).toThrow();
    rmSync(swappedActivePath);
    renameSync(displacedActive, swappedActivePath);

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

    // The uniqueness oracle must not trust a partial scan. Poison the directory
    // containing exported A and clone B, then prove import refuses until a
    // subsequent complete catalog recovers.
    const nativeDirectory = dirname((await runtime.getState()).sessionFile!);
    const poison = Array.from({ length: SESSION_IO_LIMITS.entriesPerDirectory + 1 }, (_, index) =>
      join(nativeDirectory, `catalog-poison-${index}`),
    );
    for (const path of poison) writeFileSync(path, '');
    await expect(runtime.prepareImport(portable)).rejects.toThrow('catalog is incomplete');
    expect((await runtime.listSessions('all')).length).toBe(1);
    for (const path of poison) rmSync(path);
    rmSync(join(agentDir, 'imported-sessions', 'unused-import.jsonl'));
    rmSync(join(agentDir, 'imported-sessions', 'unused-import.jsonl.retained'));
    expect(await runtime.listSessions('all')).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ sessionId: originalId }),
        expect.objectContaining({ sessionId: cloneId }),
      ]),
    );

    // A portable copy preserves its logical ID. Re-importing it while the
    // original remains in this manager's recovered catalog must fail without
    // creating a duplicate that would make both records disappear.
    await expect(runtime.prepareImport(portable)).rejects.toThrow('portable re-import is refused');
    rmSync(join(agentDir, 'imported-sessions', 'unused-import.jsonl'));
    rmSync(join(agentDir, 'imported-sessions', 'unused-import.jsonl.retained'));
    const afterRejectedImport = await runtime.listSessions('all');
    const originalRecord = afterRejectedImport.find((session) => session.sessionId === originalId);
    expect(originalRecord).toBeDefined();
    expect(afterRejectedImport.some((session) => session.sessionId === cloneId)).toBe(true);
    await runtime.switchSession(originalRecord!.id);
    expect((await runtime.getState()).sessionId).toBe(originalId);
    const afterRejectedExport = join(root, 'after-rejected-import.jsonl');
    await expect(runtime.exportJsonl(afterRejectedExport)).resolves.toBe(afterRejectedExport);
    expect(readFileSync(afterRejectedExport, 'utf8')).toContain(originalId);

    await expect(runtime.prepareImport((await runtime.getState()).sessionFile!)).rejects.toThrow(
      'active session',
    );

    const externalDirectory = join(root, 'external-sessions');
    mkdirSync(externalDirectory, { recursive: true });
    const external = SessionManager.create(cwd, externalDirectory);
    external.appendMessage({ role: 'user', content: 'External import', timestamp: Date.now() });
    external.appendMessage({
      role: 'assistant',
      content: [{ type: 'text', text: 'External ready' }],
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
    const externalPath = external.getSessionFile();
    if (!externalPath) throw new Error('external session was not persisted');
    const externalBytes = readFileSync(externalPath);
    forcedImportDestination = 'caller-collision.jsonl';
    const collision = join(agentDir, 'imported-sessions', forcedImportDestination);
    writeFileSync(collision, 'caller-owned collision');
    await expect(runtime.prepareImport(externalPath)).rejects.toThrow();
    expect(readFileSync(collision, 'utf8')).toBe('caller-owned collision');
    expect((await runtime.getState()).sessionId).toBe(originalId);
    rmSync(collision);
    forcedImportDestination = 'successful-import.jsonl';
    await runtime.prepareImport(externalPath);
    await runtime.importJsonl(externalPath);
    expect((await runtime.getState()).sessionId).toBe(external.getSessionId());
    expect(readFileSync(externalPath)).toEqual(externalBytes);

    // Successful final files are sessions, not retained recovery artifacts:
    // 32 further imports and import 33 all remain available.
    for (let index = 0; index < 32; index += 1) {
      const capacitySource = join(root, `capacity-source-${index}`);
      mkdirSync(capacitySource);
      const candidate = SessionManager.create(cwd, capacitySource);
      candidate.appendMessage({
        role: 'user',
        content: `capacity import ${index}`,
        timestamp: Date.now() + index,
      });
      candidate.appendMessage({
        role: 'assistant',
        content: [{ type: 'text', text: 'ready' }],
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
        timestamp: Date.now() + index,
      });
      const candidatePath = candidate.getSessionFile();
      if (!candidatePath) throw new Error('capacity session was not persisted');
      forcedImportDestination = `successful-import-${index}.jsonl`;
      await runtime.prepareImport(candidatePath);
      await runtime.importJsonl(candidatePath);
    }
    expect(await recoveryHealth(agentDir)).toEqual({ retained: 0, capacity: 32 });

    const leafBeforeOversized = (await runtime.getTree()).leafId;
    const oversizedEntry = sessionInternals.runtime.session.sessionManager.appendMessage({
      role: 'user',
      content: 'x'.repeat(100_001),
      timestamp: Date.now(),
    });
    sessionInternals.runtime.session.sessionManager.appendMessage({
      role: 'assistant',
      content: [{ type: 'text', text: 'oversized reply' }],
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
    const navigation = await runtime.fork(oversizedEntry, { summary: 'none' });
    expect(navigation).toMatchObject({
      editorTextTruncated: true,
      cancelled: false,
      aborted: false,
    });
    expect(navigation.editorText).toHaveLength(100_000);
    expect((await runtime.getTree()).leafId).toBe(leafBeforeOversized);
    expect((await runtime.getMessages()).at(-1)).not.toMatchObject({ text: 'oversized reply' });

    const malformed = join(root, 'malformed.jsonl');
    writeFileSync(malformed, '{not-jsonl}\n');
    const importedRoot = join(agentDir, 'imported-sessions');
    const retainedBeforeMalformed = readdirSync(importedRoot).length;
    forcedImportDestination = 'malformed-import.jsonl';
    await expect(runtime.prepareImport(malformed)).rejects.toThrow();
    expect(readdirSync(importedRoot)).toHaveLength(retainedBeforeMalformed + 2);
    expect(readFileSync(malformed, 'utf8')).toBe('{not-jsonl}\n');
    expect(await recoveryHealth(agentDir)).toEqual({ retained: 1, capacity: 32 });
  });
});
