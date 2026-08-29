import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ExtensionHostService } from '../src/main/services/extension-host.js';
import type { ExtensionUiEvent } from '../src/shared/extensions.js';

class FakeHost {
  messages: unknown[] = [];
  killed = false;
  private messageListener: ((message: unknown) => void) | null = null;
  private exitListener: ((code: number) => void) | null = null;

  postMessage(message: unknown): void {
    this.messages.push(message);
    if (
      typeof message === 'object' &&
      message !== null &&
      (message as { type?: string }).type === 'ping'
    ) {
      queueMicrotask(() =>
        this.emit({ type: 'ready', nonce: (message as { nonce: string }).nonce }),
      );
    }
  }
  on(_event: 'message', listener: (message: unknown) => void): this {
    this.messageListener = listener;
    return this;
  }
  once(_event: 'exit', listener: (code: number) => void): this {
    this.exitListener = listener;
    return this;
  }
  kill(): boolean {
    this.killed = true;
    return true;
  }
  emit(data: unknown): void {
    this.messageListener?.(data);
  }
  crash(code = 1): void {
    this.exitListener?.(code);
  }
}

const roots: string[] = [];
afterEach(() => {
  vi.useRealTimers();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function setup() {
  const root = mkdtempSync(join(tmpdir(), 'tau-gui-extension-host-'));
  roots.push(root);
  const agentDir = join(root, 'agent');
  const cwd = join(root, 'project');
  mkdirSync(join(agentDir, 'extensions'), { recursive: true });
  mkdirSync(join(cwd, '.pi', 'extensions'), { recursive: true });
  writeFileSync(join(agentDir, 'extensions', 'user.ts'), 'throw new Error("must never execute")');
  writeFileSync(
    join(cwd, '.pi', 'extensions', 'project.ts'),
    'throw new Error("must never execute")',
  );
  const events: ExtensionUiEvent[] = [];
  const hosts: FakeHost[] = [];
  const service = new ExtensionHostService({
    agentDir,
    policyPath: join(root, 'policy.json'),
    workerPath: '/app/extension-host-worker.js',
    broadcast: (event) => events.push(event),
    spawn: () => {
      const host = new FakeHost();
      hosts.push(host);
      return host;
    },
  });
  return { root, agentDir, cwd, events, hosts, service };
}

describe('ExtensionHostService', () => {
  it('discovers metadata but keeps all third-party execution fail-closed', async () => {
    const { service, cwd } = setup();
    await service.load();
    expect(await service.list(cwd, false)).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ name: 'user', scope: 'user', execution: 'blocked' }),
        expect.objectContaining({
          name: 'project',
          scope: 'project',
          trusted: false,
          execution: 'blocked',
        }),
      ]),
    );
    const policy = await service.updatePolicy({ userEnabled: true, projectEnabled: true });
    expect(policy).toMatchObject({
      userEnabled: true,
      projectEnabled: true,
      executionAvailable: false,
    });
    expect(policy.blocker).toContain('no public serializable extension-host adapter');
    expect((await service.list(cwd, true)).every((item) => item.execution === 'blocked')).toBe(
      true,
    );
  });

  it('starts only the app-owned utility boundary and responds to bounded dialogs', async () => {
    const { service, hosts, events } = setup();
    await expect(service.probe()).resolves.toMatchObject({ status: 'ready' });
    const host = hosts[0]!;
    const extensionId = crypto.randomUUID();
    const requestId = crypto.randomUUID();
    host.emit({
      type: 'ui',
      event: {
        type: 'dialog',
        dialog: {
          requestId,
          extensionId,
          kind: 'confirm',
          title: 'Continue?',
          message: 'Bounded message',
          timeoutMs: 1_000,
        },
      },
    });
    expect(events).toEqual(expect.arrayContaining([expect.objectContaining({ type: 'dialog' })]));
    service.respondDialog(requestId, true);
    expect(host.messages).toContainEqual({ type: 'dialog_response', requestId, value: true });
    expect(events.at(-1)).toMatchObject({ type: 'dialog_closed', reason: 'answered' });
  });

  it('kills malformed or oversized hosts and closes dialogs on crash', async () => {
    const { service, hosts, events } = setup();
    await service.probe();
    const host = hosts[0]!;
    host.emit({ type: 'ui', event: { type: 'notification', message: 'x'.repeat(300_000) } });
    expect(host.killed).toBe(true);

    const requestId = crypto.randomUUID();
    const extensionId = crypto.randomUUID();
    host.emit({
      type: 'ui',
      event: {
        type: 'dialog',
        dialog: {
          requestId,
          extensionId,
          kind: 'input',
          title: 'Input',
          message: 'Value',
          placeholder: null,
          initialValue: '',
          timeoutMs: 1_000,
        },
      },
    });
    host.crash();
    expect(events).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ type: 'dialog_closed', requestId, reason: 'crash' }),
        expect.objectContaining({ type: 'host', status: 'crashed' }),
      ]),
    );
  });

  it('times dialogs out and cleans pending state', async () => {
    vi.useFakeTimers();
    const { service, hosts, events } = setup();
    const probe = service.probe();
    vi.runAllTicks();
    await probe;
    const host = hosts[0]!;
    const requestId = crypto.randomUUID();
    host.emit({
      type: 'ui',
      event: {
        type: 'dialog',
        dialog: {
          requestId,
          extensionId: crypto.randomUUID(),
          kind: 'select',
          title: 'Pick',
          options: [],
          timeoutMs: 10,
        },
      },
    });
    await vi.advanceTimersByTimeAsync(11);
    expect(host.messages).toContainEqual({ type: 'dialog_response', requestId, value: null });
    expect(events.at(-1)).toMatchObject({ type: 'dialog_closed', reason: 'timeout' });
    expect(() => service.respondDialog(requestId, 'late')).toThrow('no longer active');
  });
});
