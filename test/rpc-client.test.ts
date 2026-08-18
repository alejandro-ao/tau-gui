import { describe, expect, it, vi } from 'vitest';
import { RpcClient, RpcError } from '../src/main/rpc/client.js';

interface Harness {
  client: RpcClient;
  written: string[];
  events: Record<string, unknown>[];
  diagnostics: string[];
}

function harness(): Harness {
  const written: string[] = [];
  const events: Record<string, unknown>[] = [];
  const diagnostics: string[] = [];
  const client = new RpcClient({
    write: (data) => written.push(data),
    onEvent: (event) => events.push(event),
    onDiagnostic: (message) => diagnostics.push(message),
  });
  return { client, written, events, diagnostics };
}

const lastId = (written: string[]): string =>
  (JSON.parse(written.at(-1) as string) as { id: string }).id;

describe('RpcClient', () => {
  it('correlates a response to its request', async () => {
    const { client, written } = harness();
    const promise = client.request<{ ok: boolean }>('get_state');
    const id = lastId(written);
    client.handleChunk(
      `${JSON.stringify({ type: 'response', command: 'get_state', success: true, id, data: { ok: true } })}\n`,
    );
    await expect(promise).resolves.toEqual({ ok: true });
  });

  it('assigns distinct ids and resolves out of order', async () => {
    const { client, written } = harness();
    const first = client.request<number>('a');
    const firstId = lastId(written);
    const second = client.request<number>('b');
    const secondId = lastId(written);
    expect(firstId).not.toEqual(secondId);
    client.handleChunk(
      `${JSON.stringify({ type: 'response', command: 'b', success: true, id: secondId, data: 2 })}\n`,
    );
    client.handleChunk(
      `${JSON.stringify({ type: 'response', command: 'a', success: true, id: firstId, data: 1 })}\n`,
    );
    await expect(second).resolves.toBe(2);
    await expect(first).resolves.toBe(1);
  });

  it('rejects failed responses with the runtime error text', async () => {
    const { client, written } = harness();
    const promise = client.request('set_model');
    const id = lastId(written);
    client.handleChunk(
      `${JSON.stringify({ type: 'response', command: 'set_model', success: false, error: 'nope', id })}\n`,
    );
    await expect(promise).rejects.toThrow('nope');
  });

  it('forwards non-response records as events', () => {
    const { client, events } = harness();
    client.handleChunk('{"type":"agent_settled"}\n');
    expect(events).toEqual([{ type: 'agent_settled' }]);
  });

  it('reports uncorrelated errors as diagnostics', () => {
    const { client, diagnostics } = harness();
    client.handleChunk(
      '{"type":"response","command":"parse","success":false,"error":"Failed to parse command"}\n',
    );
    expect(diagnostics[0]).toContain('Failed to parse command');
  });

  it('times out a request', async () => {
    vi.useFakeTimers();
    try {
      const { client } = harness();
      const promise = client.request('get_state', {}, 50);
      const assertion = expect(promise).rejects.toBeInstanceOf(RpcError);
      await vi.advanceTimersByTimeAsync(60);
      await assertion;
    } finally {
      vi.useRealTimers();
    }
  });

  it('rejects outstanding requests when the stream closes', async () => {
    const { client } = harness();
    const promise = client.request('get_state');
    client.handleClose('Runtime exited');
    await expect(promise).rejects.toThrow('Runtime exited');
    await expect(client.request('get_state')).rejects.toThrow('closed');
  });

  it('reports malformed framing as a diagnostic, not a rejection', () => {
    const { client, diagnostics } = harness();
    client.handleChunk('garbage\n');
    expect(diagnostics[0]).toContain('Failed to parse RPC record');
  });
});
