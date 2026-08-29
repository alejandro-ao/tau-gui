import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { FakePiRuntime } from '../src/main/runtime/fake-pi-runtime.js';
import { RuntimePool } from '../src/main/services/runtime-pool.js';
import { SettingsStore } from '../src/main/services/settings.js';
import type { BridgeEvent } from '../src/shared/ipc.js';

const roots: string[] = [];
let pool: RuntimePool | null = null;

afterEach(async () => {
  await pool?.stopAll();
  pool = null;
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function setup(events: BridgeEvent[] = []): RuntimePool {
  const root = mkdtempSync(join(tmpdir(), 'tau-gui-fake-pi-pool-'));
  roots.push(root);
  const settings = new SettingsStore(join(root, 'settings.json'));
  settings.update({ cwd: root });
  pool = new RuntimePool(settings, (event) => events.push(event), {
    runtimeFactory: (sink) => new FakePiRuntime(sink),
  });
  return pool;
}

describe('RuntimePool with injected fake Pi', () => {
  it('starts, prompts, and restores authoritative state without a provider', async () => {
    const events: BridgeEvent[] = [];
    const runtimePool = setup(events);
    const started = await runtimePool.start();
    expect(started).toMatchObject({ runtime: 'pi', status: 'idle' });
    await runtimePool.active.prompt({ text: 'hello' });
    await runtimePool.refreshState(true);
    expect(runtimePool.snapshot().state).toMatchObject({ messageCount: 2 });
    expect(events).toEqual(expect.arrayContaining([expect.objectContaining({ type: 'agent' })]));
  });

  it('replaces an idle session with a fresh Pi owner', async () => {
    const runtimePool = setup();
    const first = await runtimePool.start();
    const firstId = first.state!.sessionId;
    const second = await runtimePool.openSession(first.cwd!);
    expect(second.state!.sessionId).not.toBe(firstId);
    expect(() => runtimePool.runtimeFor({ runtime: 'pi', sessionId: firstId })).toThrow(
      'no longer available',
    );
  });

  it('retains and drains queued work through deterministic Pi lifecycle events', async () => {
    const runtimePool = setup();
    const started = await runtimePool.start();
    const target = { runtime: 'pi' as const, sessionId: started.state!.sessionId };
    runtimePool.enqueuePrompt('follow-up', 'queued work', target);
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(runtimePool.queueSnapshot(target).followUp).toHaveLength(0);
  });

  it('restarts and shuts down all embedded owners cleanly', async () => {
    const runtimePool = setup();
    await runtimePool.start();
    await runtimePool.restart();
    await runtimePool.stopAll();
    expect(runtimePool.snapshot()).toMatchObject({ runtime: 'pi', status: 'stopped' });
  });
});
