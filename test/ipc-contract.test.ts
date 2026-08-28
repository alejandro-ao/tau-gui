import { describe, expect, it } from 'vitest';
import {
  bridgeEventSchema,
  contextFilesSchema,
  envelopeSchema,
  MAX_CONTEXT_FILES,
  MAX_SESSION_CATALOG_ENTRIES,
  MAX_TREE_ROWS,
  parseSessionIpcResult,
  requestSchema,
  resourceCatalogSchema,
  sessionCatalogSchema,
  treeSnapshotSchema,
} from '../src/shared/ipc.js';
import { DEFAULT_CAPABILITIES, DEFAULT_SETTINGS } from '../src/shared/domain.js';
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

  it('never lets the renderer choose the probed binary', () => {
    expect(requestSchema.safeParse({ action: 'runtime.probe' }).success).toBe(true);
    expect(requestSchema.safeParse({ action: 'runtime.probe', payload: {} }).success).toBe(true);
    expect(
      requestSchema.safeParse({ action: 'runtime.probe', payload: { kind: 'pi' } }).success,
    ).toBe(true);
    expect(
      requestSchema.safeParse({ action: 'runtime.probe', payload: { kind: 'sh' } }).success,
    ).toBe(false);

    // A renderer-supplied binary is stripped by validation and never reaches
    // the handler.
    const parsed = requestSchema.safeParse({
      action: 'runtime.probe',
      payload: { kind: 'tau', binary: '/bin/sh' },
    });
    expect(parsed.success).toBe(true);
    expect(parsed.success && parsed.data.action === 'runtime.probe' && parsed.data.payload).toEqual(
      {
        kind: 'tau',
      },
    );
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
    expect(parseSessionIpcResult('session.new', null)).toBeNull();
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
    ).toBe(true);
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
      session: { runtime: 'tau', sessionId: 'abc' },
    });
    expect(parsed.success).toBe(true);
    expect(parsed.success && parsed.data.session).toEqual({ runtime: 'tau', sessionId: 'abc' });

    expect(envelopeSchema.safeParse({ action: 'agent.abort' }).success).toBe(true);
    expect(
      envelopeSchema.safeParse({
        action: 'agent.abort',
        session: { runtime: 'zsh', sessionId: 'a' },
      }).success,
    ).toBe(false);
    expect(
      envelopeSchema.safeParse({
        action: 'agent.abort',
        session: { runtime: 'tau', sessionId: '' },
      }).success,
    ).toBe(false);
  });

  it('validates scoped model patches', () => {
    expect(
      requestSchema.safeParse({
        action: 'settings.update',
        payload: { scopedModels: { tau: [key('fake', 'a')], pi: [] } },
      }).success,
    ).toBe(true);
    // Both runtimes must be supplied, and entries must be non-empty strings.
    expect(
      requestSchema.safeParse({
        action: 'settings.update',
        payload: { scopedModels: { tau: [key('fake', 'a')] } },
      }).success,
    ).toBe(false);
    expect(
      requestSchema.safeParse({
        action: 'settings.update',
        payload: { scopedModels: { tau: [''], pi: [] } },
      }).success,
    ).toBe(false);
    expect(
      requestSchema.safeParse({
        action: 'settings.update',
        payload: {
          scopedModels: { tau: Array.from({ length: 101 }, () => key('fake', 'a')), pi: [] },
        },
      }).success,
    ).toBe(false);
    expect(
      requestSchema.safeParse({
        action: 'settings.update',
        payload: {
          scopedModels: { tau: [`["p","${'m'.repeat(MAX_SCOPED_MODEL_KEY_LENGTH)}"]`], pi: [] },
        },
      }).success,
    ).toBe(false);
  });

  it('validates narrow atomic scoped-model mutations', () => {
    expect(
      requestSchema.safeParse({
        action: 'settings.toggleScopedModel',
        payload: { runtime: 'tau', provider: 'a:b', modelId: 'c' },
      }).success,
    ).toBe(true);
    expect(
      requestSchema.safeParse({
        action: 'settings.toggleScopedModel',
        payload: {
          runtime: 'tau',
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

  it('requires a complete runtime map when runtime settings change', () => {
    const runtime = { binary: 'tau', provider: null, model: null, extraArgs: [] };
    expect(
      requestSchema.safeParse({
        action: 'settings.update',
        payload: { runtime: { tau: runtime, pi: { ...runtime, binary: 'pi' } } },
      }).success,
    ).toBe(true);
  });
});
