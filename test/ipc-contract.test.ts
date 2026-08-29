import { describe, expect, it } from 'vitest';
import {
  authFlowEventSchema,
  bashResultSchema,
  bridgeEventSchema,
  contextFilesSchema,
  entrySnapshotSchema,
  envelopeSchema,
  MAX_CONTEXT_FILES,
  MAX_SESSION_CATALOG_ENTRIES,
  MAX_TREE_DEPTH,
  MAX_TREE_PREVIEW,
  MAX_TREE_ROWS,
  parseSessionIpcResult,
  piAgentPreferencesSchema,
  providerAuthListSchema,
  requestSchema,
  resourceCatalogSchema,
  sessionCatalogSchema,
  resourceReloadResultSchema,
  systemPromptInspectionSchema,
  toolCatalogSchema,
  treeSnapshotSchema,
} from '../src/shared/ipc.js';
import { DEFAULT_CAPABILITIES, DEFAULT_SETTINGS } from '../src/shared/domain.js';
import { extensionPolicySchema, extensionUiEventSchema } from '../src/shared/extensions.js';
import { IMAGE_LIMITS, imageAttachmentListSchema } from '../src/shared/images.js';
import { INTROSPECTION_LIMITS } from '../src/shared/introspection.js';
import { RESOURCE_LIMITS } from '../src/shared/resources.js';
import { MAX_SCOPED_MODEL_KEY_LENGTH, modelKey } from '../src/shared/scoped-models.js';

const key = (provider: string, modelId: string): string => modelKey({ provider, modelId });

describe('IPC request validation', () => {
  it('accepts well-formed requests', () => {
    expect(requestSchema.safeParse({ action: 'settings.get' }).success).toBe(true);
    expect(
      requestSchema.safeParse({ action: 'agent.prompt', payload: { text: 'hi' } }).success,
    ).toBe(true);
    expect(
      requestSchema.safeParse({ action: 'thinking.set', payload: { level: 'xhigh' } }).success,
    ).toBe(true);
    expect(requestSchema.safeParse({ action: 'agent.entries' }).success).toBe(true);
    expect(requestSchema.safeParse({ action: 'shell.abort' }).success).toBe(true);
    expect(requestSchema.safeParse({ action: 'queue.snapshot' }).success).toBe(true);
    expect(requestSchema.safeParse({ action: 'queue.pop' }).success).toBe(true);
    expect(
      requestSchema.safeParse({
        action: 'queue.resolve',
        payload: { id: 'prompt-1', outcome: 'restore' },
      }).success,
    ).toBe(true);
    expect(requestSchema.safeParse({ action: 'runtime.restart' }).success).toBe(true);
    expect(
      requestSchema.safeParse({ action: 'ui.copyText', payload: { text: 'copy me' } }).success,
    ).toBe(true);
  });

  it('strictly validates working-directory persistence and opening requests', () => {
    expect(
      requestSchema.safeParse({
        action: 'runtime.openSession',
        payload: { cwd: '/work/project' },
      }).success,
    ).toBe(true);
    expect(
      requestSchema.safeParse({
        action: 'runtime.openSession',
        payload: { cwd: '', sessionRef: 'unexpected' },
      }).success,
    ).toBe(false);
    expect(
      requestSchema.safeParse({
        action: 'settings.rememberWorkingDirectory',
        payload: { cwd: '/work/project' },
      }).success,
    ).toBe(true);
    expect(
      requestSchema.safeParse({
        action: 'settings.rememberWorkingDirectory',
        payload: { cwd: '', extra: true },
      }).success,
    ).toBe(false);
    expect(requestSchema.safeParse({ action: 'settings.rememberWorkingDirectory' }).success).toBe(
      false,
    );
  });

  it('bounds image preparation and prompt attachment tokens', () => {
    const ids = Array.from({ length: IMAGE_LIMITS.count }, () => crypto.randomUUID());
    expect(
      requestSchema.safeParse({
        action: 'images.prepare',
        payload: { paths: ['/tmp/a.png', '/tmp/b.jpg'] },
      }).success,
    ).toBe(true);
    expect(
      requestSchema.safeParse({
        action: 'agent.prompt',
        payload: { text: 'describe', attachmentIds: ids },
      }).success,
    ).toBe(true);
    expect(
      requestSchema.safeParse({
        action: 'agent.prompt',
        payload: { text: 'describe', attachmentIds: [...ids, crypto.randomUUID()] },
      }).success,
    ).toBe(false);
    expect(
      requestSchema.safeParse({
        action: 'images.prepare',
        payload: {
          paths: Array.from({ length: IMAGE_LIMITS.count + 1 }, (_, i) => `/tmp/${i}.png`),
        },
      }).success,
    ).toBe(false);
    expect(
      imageAttachmentListSchema.safeParse([
        {
          id: crypto.randomUUID(),
          mimeType: 'image/png',
          width: 10,
          height: 10,
          sizeBytes: 100,
          previewData: 'AAAA',
          path: '/must/not/cross',
        },
      ]).success,
    ).toBe(false);
  });

  it('strictly bounds provider auth and Pi preference requests', () => {
    expect(requestSchema.safeParse({ action: 'auth.providers' }).success).toBe(true);
    expect(
      requestSchema.safeParse({
        action: 'auth.login',
        payload: { providerId: 'openai', method: 'oauth' },
      }).success,
    ).toBe(true);
    expect(
      requestSchema.safeParse({
        action: 'auth.respond',
        payload: { flowId: 'flow-1', challengeId: 'challenge-1', value: 'x'.repeat(8_193) },
      }).success,
    ).toBe(false);
    expect(
      requestSchema.safeParse({
        action: 'auth.login',
        payload: { providerId: 'openai', method: 'oauth', token: 'must-not-cross' },
      }).success,
    ).toBe(false);
    expect(
      requestSchema.safeParse({
        action: 'pi.preferences.update',
        payload: { retryEnabled: true, retryMaxRetries: 999 },
      }).success,
    ).toBe(false);
    expect(requestSchema.safeParse({ action: 'retry.abort' }).success).toBe(true);
  });

  it('validates sanitized auth, preference, and challenge results', () => {
    expect(
      providerAuthListSchema.safeParse([
        {
          id: 'openai',
          name: 'OpenAI',
          methods: ['api_key', 'oauth'],
          configured: true,
          credentialType: 'oauth',
          source: 'OAuth',
        },
      ]).success,
    ).toBe(true);
    expect(
      providerAuthListSchema.safeParse([
        {
          id: 'openai',
          name: 'OpenAI',
          methods: ['api_key'],
          configured: true,
          credentialType: 'api_key',
          source: 'sk-secret',
          key: 'secret',
        },
      ]).success,
    ).toBe(false);
    expect(
      authFlowEventSchema.safeParse({
        flowId: 'flow-1',
        type: 'prompt',
        challengeId: 'challenge-1',
        input: 'secret',
        message: 'API key',
        placeholder: null,
        options: [],
      }).success,
    ).toBe(true);
    expect(
      piAgentPreferencesSchema.safeParse({
        steeringMode: 'all',
        followUpMode: 'one-at-a-time',
        transport: 'auto',
        retryEnabled: true,
        retryMaxRetries: 3,
        retryBaseDelayMs: 2_000,
        providerTimeoutMs: null,
        providerMaxRetries: 0,
        providerMaxRetryDelayMs: 60_000,
        isRetrying: false,
        retryAttempt: 0,
        autoCompactionEnabled: true,
        compactionReserveTokens: 16_384,
        compactionKeepRecentTokens: 20_000,
        defaultProvider: null,
        defaultModel: null,
        defaultThinkingLevel: 'max',
        writable: {
          queueModes: true,
          transport: true,
          retryEnabled: true,
          retryPolicy: false,
          autoCompaction: true,
          compactionThresholds: false,
          modelDefaults: true,
        },
      }).success,
    ).toBe(true);
  });

  it('strictly bounds extension policy and dialog IPC', () => {
    expect(requestSchema.safeParse({ action: 'extensions.list' }).success).toBe(true);
    expect(
      requestSchema.safeParse({
        action: 'extensions.policy.update',
        payload: { userEnabled: true, executePath: '/tmp/evil.ts' },
      }).success,
    ).toBe(false);
    expect(
      requestSchema.safeParse({
        action: 'extensions.dialog.respond',
        payload: { requestId: crypto.randomUUID(), value: 'x'.repeat(100_001) },
      }).success,
    ).toBe(false);
    expect(
      extensionPolicySchema.safeParse({
        userEnabled: true,
        projectEnabled: true,
        executionAvailable: false,
        blocker: 'blocked',
      }).success,
    ).toBe(true);
    expect(
      extensionUiEventSchema.safeParse({
        type: 'custom_message',
        extensionId: crypto.randomUUID(),
        customType: 'card',
        text: 'hello',
        data: 'x'.repeat(70_000),
      }).success,
    ).toBe(false);
  });

  it('has no executable probe action', () => {
    expect(requestSchema.safeParse({ action: 'runtime.probe' }).success).toBe(false);
    expect(
      requestSchema.safeParse({ action: 'runtime.probe', payload: { binary: '/bin/sh' } }).success,
    ).toBe(false);
  });

  it('strictly bounds complete restored response wrappers', () => {
    const huge = 'x'.repeat(2 * 1024 * 1024);
    expect(entrySnapshotSchema.safeParse({ entries: [], leafId: 'entry-1' }).success).toBe(true);
    expect(
      treeSnapshotSchema.safeParse({ rows: [], leafId: 'entry-1', truncated: false }).success,
    ).toBe(true);
    expect(entrySnapshotSchema.safeParse({ entries: [], leafId: huge }).success).toBe(false);
    expect(treeSnapshotSchema.safeParse({ rows: [], leafId: huge, truncated: false }).success).toBe(
      false,
    );
  });

  it('rejects over-budget rows-based trees without unbounded work', () => {
    const row = {
      id: 'entry',
      parentId: null,
      depth: 0,
      kind: 'message' as const,
      role: 'user' as const,
      timestamp: '2026-01-01T00:00:00Z',
      preview: 'safe',
      label: null,
    };
    const tooMany = {
      rows: Array.from({ length: MAX_TREE_ROWS + 1 }, () => row),
      leafId: null,
      truncated: true,
    };
    const tooDeep = {
      rows: [{ ...row, depth: MAX_TREE_DEPTH + 1 }],
      leafId: null,
      truncated: true,
    };
    const tooManyBytes = {
      rows: Array.from({ length: MAX_TREE_ROWS }, (_, index) => ({
        ...row,
        id: `entry-${index}`,
        preview: 'é'.repeat(MAX_TREE_PREVIEW),
      })),
      leafId: null,
      truncated: true,
    };

    expect(() => treeSnapshotSchema.safeParse(tooMany)).not.toThrow();
    expect(treeSnapshotSchema.safeParse(tooMany).success).toBe(false);
    expect(() => treeSnapshotSchema.safeParse(tooDeep)).not.toThrow();
    expect(treeSnapshotSchema.safeParse(tooDeep).success).toBe(false);
    expect(() => treeSnapshotSchema.safeParse(tooManyBytes)).not.toThrow();
    expect(treeSnapshotSchema.safeParse(tooManyBytes).success).toBe(false);
  });

  it('strictly bounds direct shell responses', () => {
    expect(
      bashResultSchema.safeParse({
        command: 'echo ok',
        output: 'ok',
        exitCode: 0,
        cancelled: false,
        truncated: false,
      }).success,
    ).toBe(true);
    expect(
      bashResultSchema.safeParse({
        command: 'echo huge',
        output: 'x'.repeat(64 * 1024 + 1),
        exitCode: 0,
        cancelled: false,
        truncated: false,
      }).success,
    ).toBe(false);
  });

  it('accepts only payload-free introspection and reload requests', () => {
    for (const action of ['agent.inspectSystemPrompt', 'tools.list', 'resources.reload'] as const) {
      expect(requestSchema.safeParse({ action }).success).toBe(true);
      expect(requestSchema.safeParse({ action, payload: { prompt: 'leak it' } }).success).toBe(
        false,
      );
    }
  });

  it('strictly bounds local-only introspection results', () => {
    expect(
      systemPromptInspectionSchema.safeParse({
        text: 'local prompt',
        totalCharacters: 12,
        truncated: false,
        origin: 'active Pi session',
      }).success,
    ).toBe(true);
    expect(
      systemPromptInspectionSchema.safeParse({
        text: 'x'.repeat(INTROSPECTION_LIMITS.systemPromptCharacters + 1),
        totalCharacters: INTROSPECTION_LIMITS.systemPromptCharacters + 1,
        truncated: false,
        origin: 'active Pi session',
      }).success,
    ).toBe(false);

    const catalog = {
      tools: [
        {
          name: 'read',
          description: 'Read a file',
          origin: 'builtin',
          active: true,
          parameters: { type: 'object', properties: { path: { type: 'string' } } },
          schemaTruncated: false,
        },
      ],
      total: 1,
      truncated: false,
      diagnostics: [],
    };
    expect(toolCatalogSchema.safeParse(catalog).success).toBe(true);
    expect(
      toolCatalogSchema.safeParse({
        ...catalog,
        tools: [{ ...catalog.tools[0], secret: process.env }],
      }).success,
    ).toBe(false);
    expect(
      toolCatalogSchema.safeParse({
        ...catalog,
        tools: [{ ...catalog.tools[0], parameters: { value: 'x'.repeat(5_000) } }],
      }).success,
    ).toBe(false);

    expect(
      resourceReloadResultSchema.safeParse({
        before: { skills: 1, prompts: 2, themes: 2, contextFiles: 1, extensions: 0, tools: 4 },
        after: { skills: 2, prompts: 2, themes: 2, contextFiles: 1, extensions: 0, tools: 4 },
        diagnostics: [],
      }).success,
    ).toBe(true);
  });

  it('accepts only the payload-free resources.list request', () => {
    expect(requestSchema.safeParse({ action: 'resources.list' }).success).toBe(true);
    expect(
      requestSchema.safeParse({ action: 'resources.list', payload: { cwd: '/untrusted' } }).success,
    ).toBe(false);
  });

  it('accepts only payload-free context discovery and validates metadata', () => {
    expect(requestSchema.safeParse({ action: 'context.list' }).success).toBe(true);
    expect(
      requestSchema.safeParse({ action: 'context.list', payload: { cwd: '/untrusted' } }).success,
    ).toBe(false);
    expect(
      contextFilesSchema.safeParse([
        { label: '~/.tau/AGENTS.md', path: '/home/user/.tau/AGENTS.md' },
      ]).success,
    ).toBe(true);
    expect(
      contextFilesSchema.safeParse([
        { label: '~/.tau/AGENTS.md', path: '/home/user/.tau/AGENTS.md', content: 'secret' },
      ]).success,
    ).toBe(false);
    expect(
      contextFilesSchema.safeParse(
        Array.from({ length: MAX_CONTEXT_FILES + 1 }, (_, index) => ({
          label: `file-${index}`,
          path: `/file-${index}`,
        })),
      ).success,
    ).toBe(false);
  });

  it('validates and bounds resources.list output metadata', () => {
    const valid = {
      skills: [
        {
          name: 'review',
          description: null,
          origin: '~/.tau/skills',
          disableModelInvocation: false,
          estimatedTokens: 120,
        },
      ],
      prompts: [],
      diagnostics: [],
    };
    expect(resourceCatalogSchema.safeParse(valid).success).toBe(true);
    expect(
      resourceCatalogSchema.safeParse({
        ...valid,
        skills: [{ ...valid.skills[0], content: 'must not cross IPC' }],
      }).success,
    ).toBe(false);
    expect(
      resourceCatalogSchema.safeParse({
        ...valid,
        skills: [{ ...valid.skills[0], origin: 'x'.repeat(RESOURCE_LIMITS.originCharacters + 1) }],
      }).success,
    ).toBe(false);
    expect(
      resourceCatalogSchema.safeParse({
        ...valid,
        diagnostics: ['x'.repeat(RESOURCE_LIMITS.diagnosticCharacters + 1)],
      }).success,
    ).toBe(false);
    expect(
      resourceCatalogSchema.safeParse({
        ...valid,
        prompts: Array.from({ length: RESOURCE_LIMITS.catalogEntries + 1 }, (_, index) => ({
          name: `p${index}`,
          description: null,
          origin: '~/.tau/prompts',
        })),
      }).success,
    ).toBe(false);
  });

  it('strictly validates session lifecycle requests and bounded metadata', () => {
    for (const request of [
      { action: 'session.clone' },
      { action: 'session.importJsonl' },
      { action: 'session.importHealth' },
      { action: 'session.revealImportRecovery' },
      { action: 'session.list', payload: { scope: 'all' } },
      { action: 'session.exportHtml' },
      { action: 'session.exportJsonl', payload: {} },
      { action: 'session.label', payload: { entryId: 'entry-1', label: 'bookmark' } },
    ]) {
      expect(requestSchema.safeParse(request).success, request.action).toBe(true);
    }
    expect(
      requestSchema.safeParse({
        action: 'session.exportHtml',
        payload: { destination: '/renderer/chosen' },
      }).success,
    ).toBe(false);
    expect(
      requestSchema.safeParse({
        action: 'session.importJsonl',
        payload: { path: '/renderer/chosen' },
      }).success,
    ).toBe(false);
    expect(
      sessionCatalogSchema.safeParse([
        {
          id: `pi-${'a'.repeat(32)}`,
          source: 'native',
          runtime: 'pi',
          sessionId: 'session-1',
          exportable: true,
          name: 'Task',
          firstMessage: 'Do work',
          cwd: '/work/project',
          createdAt: 1,
          modifiedAt: 2,
          messageCount: 2,
          parentSessionId: null,
        },
      ]).success,
    ).toBe(true);
    expect(
      sessionCatalogSchema.safeParse(
        Array.from({ length: MAX_SESSION_CATALOG_ENTRIES + 1 }, (_, index) => ({
          id: `pi-${index.toString(16).padStart(32, '0')}`,
          source: 'native',
          runtime: 'pi',
          sessionId: `session-${index}`,
          exportable: true,
          name: null,
          firstMessage: null,
          cwd: '/work/project',
          createdAt: 1,
          modifiedAt: 2,
          messageCount: 0,
          parentSessionId: null,
        })),
      ).success,
    ).toBe(false);
    expect(
      sessionCatalogSchema.safeParse([
        {
          id: `pi-${'b'.repeat(32)}`,
          source: 'native',
          runtime: 'pi',
          sessionId: 'session-1',
          exportable: true,
          name: null,
          firstMessage: null,
          cwd: '/work/project',
          createdAt: 1,
          modifiedAt: 2,
          messageCount: 0,
          parentSessionId: null,
          path: '/must/not/cross-ipc.jsonl',
        },
      ]).success,
    ).toBe(false);
  });

  it('strictly bounds tree and export responses at both IPC boundaries', () => {
    const row = {
      id: 'entry',
      parentId: null,
      depth: 0,
      kind: 'message' as const,
      role: 'user' as const,
      timestamp: '2026-01-01T00:00:00Z',
      preview: 'safe',
      label: null,
    };
    expect(
      treeSnapshotSchema.safeParse({ rows: [row], leafId: 'entry', truncated: false }).success,
    ).toBe(true);
    expect(
      treeSnapshotSchema.safeParse({
        rows: Array.from({ length: MAX_TREE_ROWS + 1 }, () => row),
        leafId: null,
        truncated: true,
      }).success,
    ).toBe(false);
    expect(
      treeSnapshotSchema.safeParse({
        rows: [{ ...row, message: { images: ['forbidden'] } }],
        leafId: null,
        truncated: false,
      }).success,
    ).toBe(false);
    expect(() => parseSessionIpcResult('session.exportJsonl', '/x'.repeat(5_000))).toThrow();
    expect(() =>
      parseSessionIpcResult('session.fork', {
        editorText: null,
        editorTextTruncated: false,
        cancelled: false,
        aborted: false,
        extra: true,
      }),
    ).toThrow();
    expect(() => parseSessionIpcResult('session.new', {})).toThrow();
    expect(() => parseSessionIpcResult('session.switch', undefined)).toThrow();
    expect(() => parseSessionIpcResult('session.name', undefined)).toThrow();
    expect(parseSessionIpcResult('session.new', null)).toBeNull();
    expect(parseSessionIpcResult('session.name', null)).toBeNull();
  });

  it('bounds, sanitizes, and strictly validates session names', () => {
    const parsed = requestSchema.safeParse({
      action: 'session.name',
      payload: { name: '  release\u202E\nprep  ' },
    });
    expect(parsed.success).toBe(true);
    expect(
      parsed.success && parsed.data.action === 'session.name' && parsed.data.payload.name,
    ).toBe('release  prep');
    expect(
      requestSchema.safeParse({
        action: 'session.name',
        payload: { name: 'x'.repeat(501) },
      }).success,
    ).toBe(false);
    expect(
      requestSchema.safeParse({
        action: 'session.name',
        payload: { name: 'safe', extra: true },
      }).success,
    ).toBe(false);
  });

  it('strictly validates complete bridge events and renderer state', () => {
    const snapshot = {
      runtime: 'pi' as const,
      status: 'idle' as const,
      detail: null,
      runtimeVersion: null,
      capabilities: DEFAULT_CAPABILITIES,
      cwd: '/work',
      gitBranch: null,
      state: null,
    };
    expect(bridgeEventSchema.safeParse({ type: 'status', snapshot }).success).toBe(true);
    expect(
      bridgeEventSchema.safeParse({
        type: 'status',
        snapshot: { ...snapshot, state: { sessionFile: '/private/session.jsonl' } },
      }).success,
    ).toBe(false);
    expect(
      bridgeEventSchema.safeParse({
        type: 'settings',
        settings: { ...DEFAULT_SETTINGS, recentSessions: [{ path: '/private' }] },
      }).success,
    ).toBe(false);
    expect(
      bridgeEventSchema.safeParse({
        type: 'agent',
        sessionId: 'session-1',
        runtime: 'pi',
        event: { type: 'message_end' },
      }).success,
    ).toBe(false);
    expect(
      bridgeEventSchema.safeParse({
        type: 'agent',
        sessionId: 'session-1',
        runtime: 'pi',
        event: {
          type: 'tool_end',
          toolCallId: 'tool-1',
          toolName: 'read',
          text: 'ok',
          details: { nested: { forged: true, extra: { value: 1 } } },
          isError: false,
          forged: true,
        },
      }).success,
    ).toBe(false);
    let nested: Record<string, unknown> = { value: true };
    for (let depth = 0; depth < 10; depth += 1) nested = { nested };
    expect(
      bridgeEventSchema.safeParse({
        type: 'agent',
        sessionId: 'session-1',
        runtime: 'pi',
        event: {
          type: 'tool_end',
          toolCallId: 'tool-1',
          toolName: 'read',
          text: 'ok',
          details: nested,
          isError: false,
        },
      }).success,
    ).toBe(false);
  });

  it('rejects unknown actions', () => {
    expect(requestSchema.safeParse({ action: 'agent.selfDestruct' }).success).toBe(false);
  });

  it('rejects malformed payloads', () => {
    expect(requestSchema.safeParse({ action: 'agent.prompt' }).success).toBe(false);
    expect(requestSchema.safeParse({ action: 'agent.prompt', payload: { text: '' } }).success).toBe(
      false,
    );
    expect(
      requestSchema.safeParse({ action: 'thinking.set', payload: { level: 'ultra' } }).success,
    ).toBe(false);
    expect(
      requestSchema.safeParse({ action: 'shell.run', payload: { command: 'ls' } }).success,
    ).toBe(false);
    expect(
      requestSchema.safeParse({ action: 'fs.complete', payload: { query: 'a', limit: 5000 } })
        .success,
    ).toBe(false);
    expect(requestSchema.safeParse({ action: 'ui.copyText' }).success).toBe(false);
    expect(
      requestSchema.safeParse({ action: 'queue.pop', payload: { id: 'forged' } }).success,
    ).toBe(false);
    expect(
      requestSchema.safeParse({
        action: 'queue.resolve',
        payload: { id: 'prompt-1', outcome: 'drop' },
      }).success,
    ).toBe(false);
  });

  it('rejects settings patches with unknown values', () => {
    expect(
      requestSchema.safeParse({ action: 'settings.update', payload: { theme: 'pure-black' } })
        .success,
    ).toBe(true);
    expect(
      requestSchema.safeParse({ action: 'settings.update', payload: { theme: 'neon' } }).success,
    ).toBe(false);
    expect(
      requestSchema.safeParse({ action: 'settings.update', payload: { agentRuntime: 'pi' } })
        .success,
    ).toBe(false);
    expect(
      requestSchema.safeParse({
        action: 'settings.update',
        payload: {
          runtime: { tau: { binary: 'tau', provider: null, model: null, extraArgs: [] } },
        },
      }).success,
    ).toBe(false);
    expect(
      requestSchema.safeParse({
        action: 'settings.update',
        payload: { customSkillDirectories: ['/shared/skills'] },
      }).success,
    ).toBe(false);
    expect(
      requestSchema.safeParse({
        action: 'settings.addResourceDirectory',
        payload: { kind: 'skills' },
      }).success,
    ).toBe(true);
    expect(
      requestSchema.safeParse({
        action: 'settings.removeResourceDirectory',
        payload: { kind: 'prompts', path: 'bad\npath' },
      }).success,
    ).toBe(false);
  });

  it('validates the optional session target on the envelope', () => {
    const parsed = envelopeSchema.safeParse({
      action: 'agent.prompt',
      payload: { text: 'hi' },
      session: { runtime: 'pi', sessionId: 'abc' },
    });
    expect(parsed.success).toBe(true);
    expect(parsed.success && parsed.data.session).toEqual({ runtime: 'pi', sessionId: 'abc' });

    expect(envelopeSchema.safeParse({ action: 'agent.abort' }).success).toBe(true);
    expect(envelopeSchema.safeParse({ action: 'agent.abort', extra: 'forged' }).success).toBe(
      false,
    );
    expect(requestSchema.safeParse({ action: 'agent.abort', extra: 'forged' }).success).toBe(false);
    expect(
      envelopeSchema.safeParse({
        action: 'agent.abort',
        session: { runtime: 'zsh', sessionId: 'a' },
      }).success,
    ).toBe(false);
    expect(
      envelopeSchema.safeParse({
        action: 'agent.abort',
        session: { runtime: 'pi', sessionId: '' },
      }).success,
    ).toBe(false);
    expect(
      envelopeSchema.safeParse({
        action: 'agent.abort',
        session: { runtime: 'pi', sessionId: 'x'.repeat(129) },
      }).success,
    ).toBe(false);
    expect(
      envelopeSchema.safeParse({
        action: 'agent.abort',
        session: { runtime: 'pi', sessionId: 'abc', extra: true },
      }).success,
    ).toBe(false);
  });

  it('validates Pi scoped model patches', () => {
    expect(
      requestSchema.safeParse({
        action: 'settings.update',
        payload: { scopedModels: [key('fake', 'a')] },
      }).success,
    ).toBe(true);
    expect(
      requestSchema.safeParse({ action: 'settings.update', payload: { scopedModels: [''] } })
        .success,
    ).toBe(false);
    expect(
      requestSchema.safeParse({
        action: 'settings.update',
        payload: { scopedModels: Array.from({ length: 101 }, () => key('fake', 'a')) },
      }).success,
    ).toBe(false);
    expect(
      requestSchema.safeParse({
        action: 'settings.update',
        payload: { scopedModels: [`["p","${'m'.repeat(MAX_SCOPED_MODEL_KEY_LENGTH)}"]`] },
      }).success,
    ).toBe(false);
  });

  it('validates narrow atomic scoped-model mutations', () => {
    expect(
      requestSchema.safeParse({
        action: 'settings.toggleScopedModel',
        payload: { provider: 'a:b', modelId: 'c' },
      }).success,
    ).toBe(true);
    expect(
      requestSchema.safeParse({
        action: 'settings.toggleScopedModel',
        payload: {
          provider: 'p',
          modelId: 'm'.repeat(MAX_SCOPED_MODEL_KEY_LENGTH),
        },
      }).success,
    ).toBe(false);
    expect(
      requestSchema.safeParse({
        action: 'settings.toggleScopedModel',
        payload: { runtime: 'other', provider: 'p', modelId: 'm' },
      }).success,
    ).toBe(false);
  });

  it('rejects obsolete runtime launch settings', () => {
    expect(
      requestSchema.safeParse({
        action: 'settings.update',
        payload: { runtime: { pi: { binary: 'pi' } } },
      }).success,
    ).toBe(false);
  });
});
