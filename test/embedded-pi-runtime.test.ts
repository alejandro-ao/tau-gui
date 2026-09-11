import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SessionManager, type AgentSession } from '@earendil-works/pi-coding-agent';
import { afterEach, describe, expect, it, vi, type Mock } from 'vitest';
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

type PiSessionEvent = Parameters<Parameters<AgentSession['subscribe']>[0]>[0];
type PersistedMessage = Parameters<SessionManager['appendMessage']>[0];
type CompleteSimpleStub = (model: unknown, context: unknown, options?: unknown) => Promise<unknown>;

function asRecord(value: unknown): Record<string, unknown> {
  return typeof value === 'object' && value !== null ? (value as Record<string, unknown>) : {};
}

function titleResponse(text: string, stopReason = 'stop') {
  return {
    content: text ? [{ type: 'text', text }] : [],
    stopReason,
  };
}

function createNamingFixture(
  completeSimple: Mock<CompleteSimpleStub>,
  messages: PersistedMessage[] = [],
) {
  const root = mkdtempSync(join(tmpdir(), 'tau-gui-session-name-'));
  roots.push(root);
  const cwd = join(root, 'project');
  mkdirSync(cwd, { recursive: true });
  const sessionManager = SessionManager.create(cwd, join(root, 'sessions'));
  for (const message of messages) sessionManager.appendMessage(message);
  const model = {
    id: 'currently-selected',
    name: 'Currently selected',
    api: 'openai-completions',
    provider: 'selected-provider',
    baseUrl: 'https://example.invalid',
    reasoning: false,
    input: ['text'],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: 128_000,
    maxTokens: 8_192,
  } as NonNullable<AgentSession['model']>;
  let listener: ((event: PiSessionEvent) => void) | null = null;
  const setSessionName = vi.fn((name: string) => {
    sessionManager.appendSessionInfo(name);
    listener?.({ type: 'session_info_changed', name: sessionManager.getSessionName() });
  });
  const session = {
    sessionId: sessionManager.getSessionId(),
    get sessionName() {
      return sessionManager.getSessionName();
    },
    model,
    modelRuntime: { completeSimple, getModel: () => model },
    messages,
    sessionManager,
    setSessionName,
    subscribe(next: (event: PiSessionEvent) => void) {
      listener = next;
      return () => {
        listener = null;
      };
    },
  } as unknown as AgentSession;
  const diagnostics: string[] = [];
  let stateChanges = 0;
  const runtime = new EmbeddedPiRuntime({
    event: () => undefined,
    status: () => undefined,
    diagnostic: (message) => diagnostics.push(message),
    stateChanged: () => {
      stateChanges += 1;
    },
  });
  const host = { session, dispose: () => Promise.resolve() };
  const internals = runtime as unknown as {
    runtime: typeof host | null;
    bindSession: (next: AgentSession) => void;
    automaticNameAbort: AbortController | null;
  };
  internals.runtime = host;
  internals.bindSession.call(runtime, session);
  active = runtime;

  return {
    runtime,
    internals,
    model,
    session,
    sessionManager,
    setSessionName,
    diagnostics,
    get stateChanges() {
      return stateChanges;
    },
    emit(event: PiSessionEvent) {
      listener?.(event);
      // AgentSession persists a completed user message immediately after it
      // notifies subscribers; mirror that ordering in this adapter fixture.
      if (event.type === 'message_end' && event.message.role === 'user') {
        sessionManager.appendMessage(event.message);
      }
    },
  };
}

function firstUserMessage(text: string): PiSessionEvent {
  return {
    type: 'message_end',
    message: {
      role: 'user',
      content: [{ type: 'text', text }],
      timestamp: Date.now(),
    },
  };
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
      sessionClone: false,
      sessionList: false,
      extensionDialogs: false,
      providerLogin: false,
    });
  });

  it('uses the selected model to append a generated session_info name after the first prompt', async () => {
    const completeSimple = vi
      .fn<CompleteSimpleStub>()
      .mockResolvedValue(titleResponse('"Fix broken CLI output now"'));
    const fixture = createNamingFixture(completeSimple);

    fixture.emit(firstUserMessage('Please fix the broken CLI output.'));

    await vi.waitFor(() =>
      expect(fixture.sessionManager.getSessionName()).toBe('Fix broken CLI output'),
    );
    expect(completeSimple).toHaveBeenCalledOnce();
    const call = completeSimple.mock.calls[0];
    const context = asRecord(call?.[1]);
    const messages = Array.isArray(context['messages']) ? context['messages'] : [];
    const prompt = asRecord(messages[0]);
    const options = asRecord(call?.[2]);
    expect(call?.[0]).toBe(fixture.model);
    expect(context['systemPrompt']).toEqual(expect.stringContaining('maximum four words'));
    expect(context['tools']).toEqual([]);
    expect(prompt).toMatchObject({ role: 'user' });
    expect(prompt['content']).toEqual(expect.stringContaining('Please fix the broken CLI output.'));
    expect(options).toMatchObject({ cacheRetention: 'none', maxRetries: 0, maxTokens: 64 });
    expect(fixture.setSessionName).toHaveBeenCalledWith('Fix broken CLI output');
    expect(fixture.stateChanges).toBe(1);
    expect(fixture.sessionManager.getEntries().map((entry) => entry.type)).toEqual([
      'message',
      'session_info',
    ]);
    expect(fixture.sessionManager.getEntries().at(-1)).toMatchObject({
      type: 'session_info',
      name: 'Fix broken CLI output',
    });
  });

  it('auto-names a first message that only invokes a skill', async () => {
    const completeSimple = vi
      .fn<CompleteSimpleStub>()
      .mockResolvedValue(titleResponse('Review authentication security'));
    const fixture = createNamingFixture(completeSimple);
    const skillInvocation = [
      '<skill name="security-review" location="/skills/security-review/SKILL.md">',
      '# Security review',
      '',
      'Inspect authentication boundaries.',
      '</skill>',
    ].join('\n');

    fixture.emit(firstUserMessage(skillInvocation));

    await vi.waitFor(() =>
      expect(fixture.sessionManager.getSessionName()).toBe('Review authentication security'),
    );
    const call = completeSimple.mock.calls[0];
    const context = asRecord(call?.[1]);
    const messages = Array.isArray(context['messages']) ? context['messages'] : [];
    const prompt = asRecord(messages[0]);
    expect(prompt['content']).toEqual(expect.stringContaining('Invoked skill: security-review'));
    expect(prompt['content']).toEqual(
      expect.stringContaining('Inspect authentication boundaries.'),
    );
    expect(fixture.sessionManager.getEntries().at(-1)).toMatchObject({
      type: 'session_info',
      name: 'Review authentication security',
    });
  });

  it('falls back to a bounded first-message name when title generation fails', async () => {
    const completeSimple = vi.fn<CompleteSimpleStub>().mockResolvedValue({
      ...titleResponse('Incomplete provider output', 'error'),
      errorMessage: 'credential=secret',
    });
    const fixture = createNamingFixture(completeSimple);

    fixture.emit(firstUserMessage('Investigate flaky session restore tests'));

    await vi.waitFor(() =>
      expect(fixture.sessionManager.getSessionName()).toBe('Investigate flaky session restore'),
    );
    expect(fixture.diagnostics).toContain(
      'Automatic session naming failed; using the first-message fallback',
    );
    expect(fixture.diagnostics.join(' ')).not.toContain('credential=secret');
  });

  it('does not overwrite a manual name set while automatic naming is in flight', async () => {
    let finish!: (response: unknown) => void;
    const completion = new Promise<unknown>((resolve) => {
      finish = resolve;
    });
    const completeSimple = vi.fn<CompleteSimpleStub>(() => completion);
    const fixture = createNamingFixture(completeSimple);

    fixture.emit(firstUserMessage('Generate a session name'));
    await vi.waitFor(() => expect(completeSimple).toHaveBeenCalledOnce());
    fixture.session.setSessionName('Manual name');
    finish(titleResponse('Generated name'));
    await vi.waitFor(() => expect(fixture.internals.automaticNameAbort).toBeNull());

    expect(fixture.sessionManager.getSessionName()).toBe('Manual name');
    expect(
      fixture.sessionManager.getEntries().filter((entry) => entry.type === 'session_info'),
    ).toHaveLength(1);
  });

  it('does not auto-name a resumed conversation', async () => {
    const completeSimple = vi
      .fn<CompleteSimpleStub>()
      .mockResolvedValue(titleResponse('Unexpected name'));
    const fixture = createNamingFixture(completeSimple, [
      { role: 'user', content: 'Existing prompt', timestamp: Date.now() },
    ]);

    fixture.emit(firstUserMessage('Another prompt'));
    await Promise.resolve();

    expect(completeSimple).not.toHaveBeenCalled();
    expect(fixture.sessionManager.getEntries().some((entry) => entry.type === 'session_info')).toBe(
      false,
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
