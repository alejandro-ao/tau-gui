import { randomUUID } from 'node:crypto';
import { CredentialSynchronizationError, type ModelRuntime } from '@earendil-works/pi-coding-agent';
import {
  AUTH_LIMITS,
  authFlowSchema,
  authProviderListSchema,
  type AuthFlow,
  type AuthLogoutResult,
  type AuthProvider,
  type AuthType,
} from '../../shared/auth.js';

interface PendingPrompt {
  flowId: string;
  promptId: string;
  resolve: (value: string) => void;
  reject: (error: Error) => void;
  signal?: AbortSignal;
  onAbort?: () => void;
}

/**
 * Main-process owner for Pi's public authentication APIs.
 *
 * It intentionally exposes only bounded metadata and interaction state. Prompt
 * responses are consumed once and never copied into flow snapshots, events,
 * diagnostics, results, or GUI persistence.
 */
export class PiAuthService {
  private flow: AuthFlow | null = null;
  private controller: AbortController | null = null;
  private pending: PendingPrompt | null = null;

  constructor(
    private readonly runtime: () => ModelRuntime,
    private readonly publish: (flow: AuthFlow) => void,
    private readonly openExternal: (url: string) => Promise<void> = () => Promise.resolve(),
  ) {}

  async listProviders(): Promise<AuthProvider[]> {
    const runtime = this.runtime();
    const credentials = new Map(
      (await runtime.listCredentials({ signal: AbortSignal.timeout(15_000) })).map((credential) => [
        credential.providerId,
        credential.type,
      ]),
    );
    const providers = runtime
      .getProviders()
      .slice(0, AUTH_LIMITS.providers)
      .map((provider) => {
        const storedCredential = credentials.get(provider.id) ?? null;
        const authStatus = runtime.getProviderAuthStatus(provider.id);
        return {
          id: provider.id,
          name: provider.name,
          methods: [
            ...(provider.auth.oauth
              ? [
                  {
                    type: 'oauth' as const,
                    label: provider.auth.oauth.loginLabel ?? provider.auth.oauth.name,
                    interactive: true,
                  },
                ]
              : []),
            ...(provider.auth.apiKey
              ? [
                  {
                    type: 'api_key' as const,
                    label: provider.auth.apiKey.name,
                    interactive: typeof provider.auth.apiKey.login === 'function',
                  },
                ]
              : []),
          ],
          // A synchronization failure can leave Pi's stored snapshot stale even
          // though listCredentials() already reflects the committed mutation.
          configured:
            authStatus.source === 'stored'
              ? storedCredential !== null
              : authStatus.configured || storedCredential !== null,
          storedCredential,
        };
      })
      .filter((provider) => provider.methods.length > 0)
      .sort((left, right) => left.name.localeCompare(right.name));
    return authProviderListSchema.parse(providers);
  }

  startLogin(providerId: string, authType: AuthType): AuthFlow {
    if (this.flow && ['running', 'prompt'].includes(this.flow.status)) {
      throw new Error('Another provider login is already in progress');
    }
    const runtime = this.runtime();
    const provider = runtime.getProvider(providerId);
    if (!provider) throw new Error(`Unknown provider: ${providerId}`);
    const method = authType === 'oauth' ? provider.auth.oauth : provider.auth.apiKey;
    if (!method) throw new Error(`${provider.name} does not support that authentication method`);
    if (authType === 'api_key' && !method.login) {
      throw new Error(`${method.name} is configured outside Pi and has no interactive login`);
    }

    this.controller = new AbortController();
    this.flow = authFlowSchema.parse({
      id: randomUUID(),
      providerId: provider.id,
      providerName: provider.name,
      authType,
      status: 'running',
      prompt: null,
      notices: [],
      message: authType === 'oauth' ? 'Starting sign-in…' : 'Starting API key setup…',
    });
    const initial = this.flow;
    queueMicrotask(() => void this.runLogin(runtime, initial));
    return initial;
  }

  respond(flowId: string, promptId: string, value: string): void {
    const pending = this.pending;
    if (!pending || pending.flowId !== flowId || pending.promptId !== promptId) {
      throw new Error('Authentication prompt is no longer active');
    }
    this.pending = null;
    if (pending.signal && pending.onAbort) {
      pending.signal.removeEventListener('abort', pending.onAbort);
    }
    pending.resolve(value);
    // `value` is deliberately not retained or returned.
  }

  cancel(flowId: string): void {
    if (!this.flow || this.flow.id !== flowId) return;
    this.controller?.abort();
    this.rejectPending(new Error('Login cancelled'));
    this.update({ status: 'cancelled', prompt: null, message: 'Login cancelled' });
  }

  async logout(providerId: string): Promise<AuthLogoutResult> {
    const runtime = this.runtime();
    const providerName = runtime.getProvider(providerId)?.name ?? providerId;
    const stored = await runtime.listCredentials({ signal: AbortSignal.timeout(15_000) });
    if (!stored.some((credential) => credential.providerId === providerId)) {
      throw new Error(`No stored credential exists for ${providerName}`);
    }
    let warning: string | null = null;
    try {
      await runtime.logout(providerId, { signal: AbortSignal.timeout(15_000) });
    } catch (error) {
      if (!committedSynchronizationError(error, providerId, 'logout')) {
        throw new Error(`Could not remove the stored credential for ${providerName}`);
      }
      await refreshAfterSynchronizationError(runtime, providerId);
      warning = bounded(
        `Removed the stored credential for ${providerName}, but local model state could not synchronize. Restart the session if models remain stale.`,
      );
    }
    return { providers: await this.listProviders(), warning };
  }

  private async runLogin(runtime: ModelRuntime, initial: AuthFlow): Promise<void> {
    try {
      await runtime.login(initial.providerId, initial.authType, {
        signal: this.controller?.signal,
        prompt: (prompt) => this.requestPrompt(initial.id, prompt),
        notify: (event) => {
          if (this.flow?.id !== initial.id) return;
          const notice = sanitizeNotice(event);
          if (!notice) return;
          this.update({
            notices: [...this.flow.notices, notice].slice(-AUTH_LIMITS.notices),
            message:
              event.type === 'progress'
                ? bounded(event.message)
                : event.type === 'device_code'
                  ? 'Complete authentication in your browser'
                  : this.flow.message,
          });
          const url =
            event.type === 'auth_url'
              ? safeWebUrl(event.url)
              : event.type === 'device_code'
                ? safeWebUrl(event.verificationUri)
                : null;
          if (url) void this.openExternal(url).catch(() => undefined);
        },
      });
      if (this.flow?.id !== initial.id) return;
      this.pending = null;
      this.update({
        status: 'succeeded',
        prompt: null,
        message:
          initial.authType === 'oauth'
            ? `Logged in to ${initial.providerName}`
            : `Saved API key for ${initial.providerName}`,
      });
    } catch (error) {
      if (this.flow?.id !== initial.id || this.flow.status === 'cancelled') return;
      this.rejectPending(new Error('Login cancelled'));
      if (committedSynchronizationError(error, initial.providerId, 'login')) {
        await refreshAfterSynchronizationError(runtime, initial.providerId);
        this.update({
          status: 'succeeded',
          prompt: null,
          message: bounded(
            `Saved the credential for ${initial.providerName}, but local model state could not synchronize. Restart the session if models remain unavailable.`,
          ),
        });
        return;
      }
      this.update({
        status: 'failed',
        prompt: null,
        message: `Authentication failed for ${initial.providerName}. Retry or check the provider setup.`,
      });
    } finally {
      if (this.flow?.id === initial.id) this.controller = null;
    }
  }

  private requestPrompt(
    flowId: string,
    prompt: {
      type: 'text' | 'secret' | 'select' | 'manual_code';
      message: string;
      placeholder?: string;
      options?: readonly { id: string; label: string; description?: string }[];
      signal?: AbortSignal;
    },
  ): Promise<string> {
    if (this.flow?.id !== flowId) return Promise.reject(new Error('Login cancelled'));
    this.rejectPending(new Error('Login cancelled'));
    const promptId = randomUUID();
    this.update({
      status: 'prompt',
      prompt: {
        id: promptId,
        type: prompt.type,
        message: bounded(prompt.message),
        ...(prompt.placeholder ? { placeholder: bounded(prompt.placeholder, 256) } : {}),
        ...(prompt.type === 'select'
          ? {
              options: (prompt.options ?? []).slice(0, AUTH_LIMITS.promptOptions).map((option) => ({
                id: bounded(option.id, AUTH_LIMITS.labelCharacters),
                label: bounded(option.label, AUTH_LIMITS.labelCharacters),
                ...(option.description ? { description: bounded(option.description) } : {}),
              })),
            }
          : {}),
      },
      message: null,
    });
    return new Promise<string>((resolve, reject) => {
      const pending: PendingPrompt = { flowId, promptId, resolve, reject, signal: prompt.signal };
      if (prompt.signal) {
        pending.onAbort = () => {
          if (this.pending === pending) this.pending = null;
          reject(new Error('Login cancelled'));
        };
        prompt.signal.addEventListener('abort', pending.onAbort, { once: true });
      }
      this.pending = pending;
    });
  }

  private rejectPending(error: Error): void {
    const pending = this.pending;
    this.pending = null;
    if (!pending) return;
    if (pending.signal && pending.onAbort) {
      pending.signal.removeEventListener('abort', pending.onAbort);
    }
    pending.reject(error);
  }

  private update(patch: Partial<AuthFlow>): void {
    if (!this.flow) return;
    this.flow = authFlowSchema.parse({ ...this.flow, ...patch });
    this.publish(this.flow);
  }
}

function bounded(value: string, limit: number = AUTH_LIMITS.messageCharacters): string {
  return value.slice(0, limit);
}

function committedSynchronizationError(
  error: unknown,
  providerId: string,
  operation: 'login' | 'logout',
): error is CredentialSynchronizationError {
  return (
    error instanceof CredentialSynchronizationError &&
    error.providerId === providerId &&
    error.operation === operation
  );
}

async function refreshAfterSynchronizationError(
  runtime: ModelRuntime,
  providerId: string,
): Promise<void> {
  try {
    await runtime.refresh({
      allowNetwork: false,
      providers: [providerId],
      signal: AbortSignal.timeout(15_000),
    });
  } catch {
    // The mutation is already committed. Keep success semantics and let the
    // bounded warning tell the user how to recover from another refresh failure.
  }
}

function safeWebUrl(value: string): string | null {
  try {
    const url = new URL(value);
    return url.protocol === 'https:' || url.protocol === 'http:' ? url.toString() : null;
  } catch {
    return null;
  }
}

function sanitizeNotice(event: {
  type: 'info' | 'auth_url' | 'device_code' | 'progress';
  message?: string;
  links?: readonly { url: string; label?: string }[];
  url?: string;
  instructions?: string;
  userCode?: string;
  verificationUri?: string;
  expiresInSeconds?: number;
}): AuthFlow['notices'][number] | null {
  if (event.type === 'info') {
    return {
      type: 'info',
      message: bounded(event.message ?? ''),
      links: (event.links ?? []).flatMap((link) => {
        const url = safeWebUrl(link.url);
        return url ? [{ url, ...(link.label ? { label: bounded(link.label, 256) } : {}) }] : [];
      }),
    };
  }
  if (event.type === 'auth_url') {
    const url = safeWebUrl(event.url ?? '');
    return url
      ? {
          type: 'auth_url',
          url,
          ...(event.instructions ? { instructions: bounded(event.instructions) } : {}),
        }
      : null;
  }
  if (event.type === 'device_code') {
    const verificationUri = safeWebUrl(event.verificationUri ?? '');
    return verificationUri
      ? {
          type: 'device_code',
          userCode: bounded(event.userCode ?? '', 256),
          verificationUri,
          ...(event.expiresInSeconds ? { expiresInSeconds: event.expiresInSeconds } : {}),
        }
      : null;
  }
  return { type: 'progress', message: bounded(event.message ?? '') };
}
