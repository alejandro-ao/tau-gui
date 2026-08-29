import {
  linkSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  renameSync,
  rmSync,
  symlinkSync,
  truncateSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SessionManager } from '@earendil-works/pi-coding-agent';
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
      sessionClone: false,
      sessionImport: false,
      sessionList: true,
      extensionDialogs: false,
      providerLogin: false,
      resourceReload: false,
      systemPromptInspection: false,
      toolCatalog: false,
    });
  });

  it('has no runtime clone method that can create or switch an artifact', () => {
    const runtime = new EmbeddedPiRuntime({
      event: () => undefined,
      status: () => undefined,
      diagnostic: () => undefined,
    });
    expect('clone' in runtime).toBe(false);
  });

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

  it.each(
    ['regular', 'symlink', 'hardlink', 'same-inode'].flatMap((substitution) =>
      ['native', 'legacy'].flatMap((reference) =>
        ['startup', 'live-switch'].map((route) => ({ substitution, reference, route })),
      ),
    ),
  )(
    'fails $reference $route closed before a $substitution pathname can change external bytes',
    async ({ substitution, reference, route }) => {
      const root = mkdtempSync(join(tmpdir(), 'tau-gui-resume-closed-'));
      roots.push(root);
      const cwd = join(root, 'project');
      const agentDir = join(root, 'agent');
      const selected = join(root, 'selected.jsonl');
      const external = join(root, 'external.jsonl');
      mkdirSync(cwd, { recursive: true });
      const bytes = Buffer.from(`external-${substitution}-${reference}-${route}`);
      writeFileSync(external, bytes);
      if (substitution === 'symlink') symlinkSync(external, selected);
      else if (substitution === 'hardlink') linkSync(external, selected);
      else if (substitution === 'same-inode') {
        linkSync(external, selected);
        writeFileSync(selected, bytes);
      } else writeFileSync(selected, bytes);

      const runtime = new EmbeddedPiRuntime(
        { event: () => undefined, status: () => undefined, diagnostic: () => undefined },
        { agentDir, home: root },
      );
      active = runtime;
      const ref = reference === 'native' ? `pi-${'a'.repeat(32)}` : selected;
      if (route === 'startup') {
        await expect(
          runtime.start({
            kind: 'pi',
            binary: '',
            cwd,
            sessionRef: ref,
            extraArgs: [],
            projectTrust: 'default',
          }),
        ).rejects.toThrow('Session resume is unavailable');
        expect(runtime.running).toBe(false);
      } else {
        await runtime.start({
          kind: 'pi',
          binary: '',
          cwd,
          extraArgs: [],
          projectTrust: 'default',
        });
        const before = await runtime.getState();
        await expect(runtime.switchSession(ref)).rejects.toThrow('Session resume is unavailable');
        expect((await runtime.getState()).sessionId).toBe(before.sessionId);
      }
      expect(readFileSync(external)).toEqual(bytes);
      expect(readFileSync(selected)).toEqual(bytes);
    },
  );

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

    // A stale active path or same-user symlink swap must never export its target.
    const displacedActive = `${activePath}.displaced`;
    const secret = join(root, 'secret.jsonl');
    const rejectedExport = join(root, 'rejected-swap.jsonl');
    writeFileSync(secret, 'SECRET-SWAP-CONTENT');
    renameSync(activePath, displacedActive);
    symlinkSync(secret, activePath);
    await expect(runtime.exportJsonl(rejectedExport)).rejects.toThrow();
    expect(() => readFileSync(rejectedExport, 'utf8')).toThrow();
    rmSync(activePath);
    renameSync(displacedActive, activePath);

    expect((await runtime.getState()).sessionId).toBe(originalId);

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
  });
});
