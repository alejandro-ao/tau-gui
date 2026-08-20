import { describe, expect, it } from 'vitest';
import {
  contextFilesSchema,
  envelopeSchema,
  MAX_CONTEXT_FILES,
  requestSchema,
  resourceCatalogSchema,
} from '../src/shared/ipc.js';
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
