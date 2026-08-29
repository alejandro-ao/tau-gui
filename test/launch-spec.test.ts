import { describe, expect, it } from 'vitest';
import type { RuntimeLaunchConfig } from '../src/shared/domain.js';
import { CAPABILITIES, buildLaunchSpec } from '../src/main/runtime/spec.js';

const config = (patch: Partial<RuntimeLaunchConfig> = {}): RuntimeLaunchConfig => ({
  kind: 'tau',
  binary: 'tau',
  cwd: '/work/project',
  provider: null,
  model: null,
  sessionRef: null,
  extraArgs: [],
  projectTrust: 'default',
  ...patch,
});

describe('buildLaunchSpec', () => {
  it('builds Tau arguments with cwd, provider, model, and session id', () => {
    const spec = buildLaunchSpec(
      config({ provider: 'openai', model: 'gpt-5', sessionRef: 'abc123' }),
    );
    expect(spec.args).toEqual([
      '--mode',
      'rpc',
      '--cwd',
      '/work/project',
      '--provider',
      'openai',
      '--model',
      'gpt-5',
      '--session',
      'abc123',
    ]);
    expect(spec.deferredSessionRef).toBeNull();
  });

  it('maps one-run project trust decisions to approve flags', () => {
    expect(buildLaunchSpec(config({ projectTrust: 'approve-once' })).args).toContain('--approve');
    expect(buildLaunchSpec(config({ projectTrust: 'decline-once' })).args).toContain(
      '--no-approve',
    );
    expect(buildLaunchSpec(config()).args).not.toContain('--approve');
  });

  it('defers Pi session resumption to switch_session and omits --cwd', () => {
    const spec = buildLaunchSpec(
      config({ kind: 'pi', binary: 'pi', sessionRef: '/sessions/a.jsonl', provider: 'anthropic' }),
    );
    expect(spec.args).toEqual(['--mode', 'rpc', '--provider', 'anthropic']);
    expect(spec.deferredSessionRef).toBe('/sessions/a.jsonl');
  });

  it('appends user-supplied extra arguments last', () => {
    expect(buildLaunchSpec(config({ extraArgs: ['--no-extensions'] })).args.at(-1)).toBe(
      '--no-extensions',
    );
  });

  it('never produces a shell string', () => {
    const spec = buildLaunchSpec(config({ cwd: '/work/my project; rm -rf /' }));
    expect(spec.args).toContain('/work/my project; rm -rf /');
    expect(spec.args.every((arg) => typeof arg === 'string')).toBe(true);
  });
});

describe('capability tables', () => {
  it('marks Tau-only gaps explicitly', () => {
    expect(CAPABILITIES.tau).toMatchObject({
      steering: true,
      followUps: true,
      directBash: true,
      abortBash: false,
      imagePrompt: false,
      sessionClone: false,
      retryControls: false,
    });
  });

  it('marks Pi extras', () => {
    expect(CAPABILITIES.pi).toMatchObject({
      abortBash: true,
      imagePrompt: true,
      sessionClone: true,
      retryControls: true,
    });
  });

  it('keeps unavailable protocol surfaces off for both runtimes', () => {
    for (const capabilities of [CAPABILITIES.tau, CAPABILITIES.pi]) {
      expect(capabilities.sessionList).toBe(false);
      expect(capabilities.toolCatalog).toBe(false);
      expect(capabilities.systemPromptInspection).toBe(false);
      expect(capabilities.providerLogin).toBe(false);
      expect(capabilities.resourceReload).toBe(false);
    }
    expect(CAPABILITIES.tau.extensionDialogs).toBe(false);
  });
});
