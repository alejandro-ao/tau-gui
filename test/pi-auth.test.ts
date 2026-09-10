import type { ModelRuntime } from '@earendil-works/pi-coding-agent';
import { describe, expect, it, vi } from 'vitest';
import { PiAuthService } from '../src/main/services/pi-auth.js';
import type { AuthFlow } from '../src/shared/auth.js';

interface FakeInteraction {
  notify(event: { type: 'progress'; message: string }): void;
  prompt(prompt: { type: 'secret' | 'manual_code'; message: string }): Promise<string>;
}

function fakeRuntime() {
  let credential: 'api_key' | 'oauth' | null = null;
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
    getProviderAuthStatus: () => ({ configured: credential !== null }),
    listCredentials: () =>
      Promise.resolve(credential ? [{ providerId: provider.id, type: credential }] : []),
    login: vi.fn(async (_id: string, type: 'api_key' | 'oauth', interaction: FakeInteraction) => {
      interaction.notify({ type: 'progress', message: 'Waiting safely' });
      const value = await interaction.prompt({
        type: type === 'api_key' ? 'secret' : 'manual_code',
        message: type === 'api_key' ? 'Enter key' : 'Paste code',
      });
      if (value !== 'one-use-secret') throw new Error('bad input');
      credential = type;
      return type === 'api_key'
        ? { type, key: value }
        : { type, refresh: value, access: value, expires: Date.now() + 60_000 };
    }),
    logout: vi.fn(() => {
      credential = null;
      return Promise.resolve();
    }),
  };
  return { runtime: runtime as unknown as ModelRuntime, provider };
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

    await expect(service.logout('fake')).resolves.toEqual([
      expect.objectContaining({ id: 'fake', storedCredential: null }),
    ]);
    await expect(service.logout('fake')).rejects.toThrow('No stored credential');
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
