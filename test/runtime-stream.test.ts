import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import type { AgentEvent } from '../src/shared/domain.js';
import { JsonlAgentRuntime } from '../src/main/runtime/agent-runtime.js';

const BURST = fileURLToPath(new URL('./fake/burst-runtime.mjs', import.meta.url));
const BURST_SIZE = 2_000;

interface Harness {
  runtime: JsonlAgentRuntime;
  events: AgentEvent[];
  settled: () => Promise<void>;
}

async function launch(options: { stdoutHighWaterMark?: number } = {}): Promise<Harness> {
  const events: AgentEvent[] = [];
  let notifySettled: (() => void) | null = null;
  const runtime = new JsonlAgentRuntime(
    'tau',
    {
      event: (event) => {
        events.push(event);
        if (event.type === 'agent_settled') notifySettled?.();
      },
      status: () => {},
      diagnostic: () => {},
    },
    // Small thresholds make the pause/resume path deterministic in tests.
    { stdoutHighWaterMark: options.stdoutHighWaterMark ?? 8 * 1024, stdoutLowWaterMark: 4 * 1024 },
  );
  await runtime.start({
    kind: 'tau',
    binary: BURST,
    cwd: process.cwd(),
    provider: null,
    model: null,
    sessionRef: null,
    extraArgs: [],
    projectTrust: 'default',
  });
  return {
    runtime,
    events,
    settled: () =>
      new Promise<void>((resolve) => {
        if (events.some((event) => event.type === 'agent_settled')) resolve();
        else notifySettled = resolve;
      }),
  };
}

let active: Harness | null = null;

afterEach(async () => {
  await active?.runtime.stop();
  active = null;
});

/** Access the internal RPC client the way the adapter's own methods do. */
function rpc(runtime: JsonlAgentRuntime): {
  request: (command: string, params?: Record<string, unknown>) => Promise<unknown>;
} {
  return (
    runtime as unknown as {
      rpc: { request: (command: string, params?: Record<string, unknown>) => Promise<unknown> };
    }
  ).rpc;
}

describe('stdout flow control', () => {
  it('delivers a large burst of records without loss or reordering', async () => {
    active = await launch();
    await rpc(active.runtime).request('burst', { count: BURST_SIZE });
    await active.settled();

    // The pipe must actually have been throttled, not just drained fast.
    expect(active.runtime.flowControlPauses).toBeGreaterThan(0);

    const sequence = active.events
      .filter((event) => event.type === 'queue_update')
      .map((event) => Number((event as { steering: string[] }).steering[0]));

    expect(sequence).toHaveLength(BURST_SIZE);
    expect(sequence).toEqual(Array.from({ length: BURST_SIZE }, (_, index) => index));
    expect(active.events.at(-1)?.type).toBe('agent_settled');
  }, 30_000);
});

describe('stdin backpressure', () => {
  it('preserves order across many queued writes', async () => {
    active = await launch();
    const client = rpc(active.runtime);
    const responses = await Promise.all(
      Array.from({ length: 500 }, (_, index) =>
        client.request('echo', { seq: index, padding: 'y'.repeat(2048) }),
      ),
    );
    expect(responses.map((value) => (value as { seq: number }).seq)).toEqual(
      Array.from({ length: 500 }, (_, index) => index),
    );
  }, 30_000);
});
