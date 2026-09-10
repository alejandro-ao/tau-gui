import { CredentialSynchronizationError, type ModelRuntime } from '@earendil-works/pi-coding-agent';
import { describe, expect, it, vi } from 'vitest';
import { PiAuthService } from '../src/main/services/pi-auth.js';
import type { AuthFlow } from '../src/shared/auth.js';

interface FakeInteraction {
  notify(event: { type: 'progress'; message: string }): void;
  prompt(prompt: { type: 'secret' | 'manual_code'; message: string }): Promise<string>;
}

function fakeRuntime() {
  let credential: 'api_key' | 'oauth' | null = null;
  let snapshotCredential: 'api_key' | 'oauth' | null = null;
  let synchronizationFailure: 'login' | 'logout' | null = null;
  let unknownFailure: 'login' | 'logout' | null = null;
  const refreshCalls: string[][] = [];
  const provider = {
    id: 'fake',
    name: 'Fake Provider',
    auth: {
      apiKey: {
        name: 'Fake API key',
        login: vi.fn(),
        resolve: vi.fn(),
      },
      oauth: {
        name: 'Fake subscription',
        loginLabel: 'Sign in to Fake',
        login: vi.fn(),
        refresh: vi.fn(),
        toAuth: vi.fn(),
      },
    },
  };
  const runtime = {
    getProviders: () => [provider],
    getProvider: (id: string) => (id === provider.id ? provider : undefined),
    getProviderAuthStatus: () =>
      snapshotCredential ? { configured: true, source: 'stored' as const } : { configured: false },
    listCredentials: vi.fn(() =>
      Promise.resolve(credential ? [{ providerId: provider.id, type: credential }] : []),
    ),
    login: vi.fn(async (_id: string, type: 'api_key' | 'oauth', interaction: FakeInteraction) => {
      if (unknownFailure === 'login') throw new Error('secret provider detail');
      interaction.notify({ type: 'progress', message: 'Waiting safely' });
      const value = await interaction.prompt({
        type: type === 'api_key' ? 'secret' : 'manual_code',
        message: type === 'api_key' ? 'Enter key' : 'Paste code',
      });
      if (value !== 'one-use-secret') throw new Error('bad input');
      credential = type;
      const result =
        type === 'api_key'
          ? { type, key: value }
          : { type, refresh: value, access: value, expires: Date.now() + 60_000 };
      if (synchronizationFailure === 'login') {
        throw new CredentialSynchronizationError(provider.id, 'login', result, {
          cause: new Error('fake refresh failed'),
        });
      }
      snapshotCredential = credential;
      return result;
    }),
    logout: vi.fn(() => {
      if (unknownFailure === 'logout') throw new Error('secret logout detail');
      credential = null;
      if (synchronizationFailure === 'logout') {
        throw new CredentialSynchronizationError(provider.id, 'logout', undefined, {
          cause: new Error('fake refresh failed'),
        });
      }
      snapshotCredential = null;
      return Promise.resolve();
    }),
    refresh: (options: { providers?: readonly string[] }) => {
      refreshCalls.push([...(options.providers ?? [])]);
      return Promise.reject(new Error('fake refresh still failing'));
    },
  };
  return {
    runtime: runtime as unknown as ModelRuntime,
    provider,
    failSynchronization: (operation: 'login' | 'logout') => {
      synchronizationFailure = operation;
    },
    failUnknown: (operation: 'login' | 'logout') => {
      unknownFailure = operation;
    },
    refreshCalls,
  };
}

async function waitFor(snapshots: AuthFlow[], status: AuthFlow['status']): Promise<AuthFlow> {
  for (let attempt = 0; attempt < 50; attempt += 1) {
    const flow = snapshots.findLast((snapshot) => snapshot.status === status);
    if (flow) return flow;
    await new Promise((resolve) => setTimeout(resolve, 0));
  }
  throw new Error(`Auth flow never reached ${status}`);
}

describe('PiAuthService', () => {
  it('lists only bounded provider and stored-credential metadata', async () => {
    const { runtime } = fakeRuntime();
    const service = new PiAuthService(
      () => runtime,
      () => undefined,
    );

    expect(await service.listProviders()).toEqual([
      {
        id: 'fake',
        name: 'Fake Provider',
        methods: [
          { type: 'oauth', label: 'Sign in to Fake', interactive: true },
          { type: 'api_key', label: 'Fake API key', interactive: true },
        ],
        configured: false,
        storedCredential: null,
      },
    ]);
  });

  it('consumes a prompt response once without publishing or returning the secret', async () => {
    const { runtime } = fakeRuntime();
    const snapshots: AuthFlow[] = [];
    const service = new PiAuthService(
      () => runtime,
      (flow) => snapshots.push(flow),
    );

    const started = service.startLogin('fake', 'api_key');
    const prompt = await waitFor(snapshots, 'prompt');
    expect(JSON.stringify({ started, snapshots })).not.toContain('one-use-secret');

    service.respond(started.id, prompt.prompt!.id, 'one-use-secret');
    const succeeded = await waitFor(snapshots, 'succeeded');

    expect(succeeded.message).toBe('Saved API key for Fake Provider');
    expect(JSON.stringify(snapshots)).not.toContain('one-use-secret');
    expect(() => service.respond(started.id, prompt.prompt!.id, 'second')).toThrow(
      'no longer active',
    );
  });

  it('uses native logout only for a stored Pi credential', async () => {
    const { runtime } = fakeRuntime();
    const snapshots: AuthFlow[] = [];
    const service = new PiAuthService(
      () => runtime,
      (flow) => snapshots.push(flow),
    );
    const started = service.startLogin('fake', 'oauth');
    const prompt = await waitFor(snapshots, 'prompt');
    service.respond(started.id, prompt.prompt!.id, 'one-use-secret');
    await waitFor(snapshots, 'succeeded');

    await expect(service.logout('fake')).resolves.toEqual({
      providers: [expect.objectContaining({ id: 'fake', storedCredential: null })],
      warning: null,
    });
    await expect(service.logout('fake')).rejects.toThrow('No stored credential');
  });

  it('preserves committed login success when Pi model synchronization fails', async () => {
    const { runtime, failSynchronization, refreshCalls } = fakeRuntime();
    const snapshots: AuthFlow[] = [];
    const service = new PiAuthService(
      () => runtime,
      (flow) => snapshots.push(flow),
    );
    failSynchronization('login');

    const started = service.startLogin('fake', 'api_key');
    const prompt = await waitFor(snapshots, 'prompt');
    service.respond(started.id, prompt.prompt!.id, 'one-use-secret');
    const succeeded = await waitFor(snapshots, 'succeeded');

    expect(succeeded.message).toContain('Saved the credential for Fake Provider');
    expect(succeeded.message).toContain('local model state could not synchronize');
    expect(succeeded.message!.length).toBeLessThanOrEqual(2_048);
    expect(await service.listProviders()).toEqual([
      expect.objectContaining({ id: 'fake', configured: true, storedCredential: 'api_key' }),
    ]);
    expect(refreshCalls).toEqual([['fake']]);
  });

  it('preserves committed logout success when Pi model synchronization fails', async () => {
    const { runtime, failSynchronization, refreshCalls } = fakeRuntime();
    const snapshots: AuthFlow[] = [];
    const service = new PiAuthService(
      () => runtime,
      (flow) => snapshots.push(flow),
    );
    const started = service.startLogin('fake', 'oauth');
    const prompt = await waitFor(snapshots, 'prompt');
    service.respond(started.id, prompt.prompt!.id, 'one-use-secret');
    await waitFor(snapshots, 'succeeded');
    failSynchronization('logout');

    const result = await service.logout('fake');

    expect(result.warning).toContain('Removed the stored credential for Fake Provider');
    expect(result.warning).toContain('local model state could not synchronize');
    expect(result.warning!.length).toBeLessThanOrEqual(2_048);
    expect(result.providers).toEqual([
      expect.objectContaining({ id: 'fake', configured: false, storedCredential: null }),
    ]);
    expect(refreshCalls).toEqual([['fake']]);
  });

  it('keeps unknown login and logout errors generic', async () => {
    const loginFake = fakeRuntime();
    const snapshots: AuthFlow[] = [];
    const loginService = new PiAuthService(
      () => loginFake.runtime,
      (flow) => snapshots.push(flow),
    );
    loginFake.failUnknown('login');

    loginService.startLogin('fake', 'api_key');
    const failed = await waitFor(snapshots, 'failed');
    expect(failed.message).not.toContain('secret provider detail');

    const logoutFake = fakeRuntime();
    const logoutSnapshots: AuthFlow[] = [];
    const logoutService = new PiAuthService(
      () => logoutFake.runtime,
      (flow) => logoutSnapshots.push(flow),
    );
    const started = logoutService.startLogin('fake', 'api_key');
    const prompt = await waitFor(logoutSnapshots, 'prompt');
    logoutService.respond(started.id, prompt.prompt!.id, 'one-use-secret');
    await waitFor(logoutSnapshots, 'succeeded');
    logoutFake.failUnknown('logout');

    await expect(logoutService.logout('fake')).rejects.toThrow(
      'Could not remove the stored credential for Fake Provider',
    );
  });

  it('cancels a pending native login without exposing provider errors', async () => {
    const { runtime } = fakeRuntime();
    const snapshots: AuthFlow[] = [];
    const service = new PiAuthService(
      () => runtime,
      (flow) => snapshots.push(flow),
    );
    const started = service.startLogin('fake', 'api_key');
    await waitFor(snapshots, 'prompt');

    service.cancel(started.id);
    expect((await waitFor(snapshots, 'cancelled')).message).toBe('Login cancelled');
  });
});
