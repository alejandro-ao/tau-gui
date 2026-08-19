import { describe, expect, it } from 'vitest';
import { envelopeSchema, requestSchema } from '../src/shared/ipc.js';
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
    expect(
      requestSchema.safeParse({ action: 'ui.copyText', payload: { text: 'copy me' } }).success,
    ).toBe(true);
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
