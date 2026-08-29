import { describe, expect, it } from 'vitest';
import {
  contextFilesSchema,
  envelopeSchema,
  requestSchema,
  resourceCatalogSchema,
} from '../src/shared/ipc.js';
import { modelKey } from '../src/shared/scoped-models.js';

describe('embedded Pi IPC contract', () => {
  it('accepts only Pi session targets and no runtime probe/selector actions', () => {
    expect(
      envelopeSchema.safeParse({
        action: 'agent.prompt',
        payload: { text: 'hello' },
        session: { runtime: 'pi', sessionId: 'session-1' },
      }).success,
    ).toBe(true);
    expect(
      envelopeSchema.safeParse({
        action: 'agent.prompt',
        payload: { text: 'hello' },
        session: { runtime: 'tau', sessionId: 'session-1' },
      }).success,
    ).toBe(false);
    expect(requestSchema.safeParse({ action: 'runtime.probe' }).success).toBe(false);
    expect(
      requestSchema.safeParse({ action: 'settings.update', payload: { agentRuntime: 'tau' } })
        .success,
    ).toBe(false);
    expect(
      requestSchema.safeParse({
        action: 'settings.update',
        payload: { runtime: { pi: { binary: '/bin/sh' } } },
      }).success,
    ).toBe(false);
  });

  it('strictly validates Pi model scope and core actions', () => {
    expect(
      requestSchema.safeParse({
        action: 'settings.toggleScopedModel',
        payload: { provider: 'fake', modelId: 'model' },
      }).success,
    ).toBe(true);
    expect(
      requestSchema.safeParse({
        action: 'settings.update',
        payload: { scopedModels: [modelKey({ provider: 'fake', modelId: 'model' })] },
      }).success,
    ).toBe(true);
    expect(
      requestSchema.safeParse({ action: 'runtime.start', payload: { cwd: null } }).success,
    ).toBe(true);
    expect(requestSchema.safeParse({ action: 'queue.snapshot' }).success).toBe(true);
    expect(requestSchema.safeParse({ action: 'resources.list' }).success).toBe(true);
  });

  it('keeps resource and context metadata strict and content-free', () => {
    expect(
      contextFilesSchema.safeParse([
        { label: '~/.pi/agent/AGENTS.md', path: '/home/u/.pi/agent/AGENTS.md' },
      ]).success,
    ).toBe(true);
    expect(
      contextFilesSchema.safeParse([{ label: 'x', path: '/x', content: 'secret' }]).success,
    ).toBe(false);
    expect(
      resourceCatalogSchema.safeParse({ skills: [], prompts: [], diagnostics: [] }).success,
    ).toBe(true);
  });
});
