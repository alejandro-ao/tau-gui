import { describe, expect, it } from 'vitest';
import { requestSchema, resourceCatalogSchema } from '../src/shared/ipc.js';
import { RESOURCE_LIMITS } from '../src/shared/resources.js';

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

  it('validates and bounds resources.list output metadata', () => {
    const valid = {
      skills: [
        {
          name: 'review',
          description: null,
          origin: '~/.tau/skills',
          disableModelInvocation: false,
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
  });

  it('rejects settings patches with unknown values', () => {
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
