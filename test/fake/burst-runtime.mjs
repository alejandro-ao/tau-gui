#!/usr/bin/env node
/**
 * Minimal JSONL runtime used to exercise stdout flow control and stdin
 * backpressure.
 *
 * - `get_state` answers the adapter's start-up probe.
 * - `burst` writes `count` events as fast as the pipe accepts them, each
 *   carrying its sequence number and padding so the burst spans many chunks.
 * - `echo` responds with whatever `seq` it received, so ordered stdin writes
 *   can be verified.
 */
import { createInterface } from 'node:readline';

const PADDING = 'x'.repeat(4096);

function write(value) {
  process.stdout.write(`${JSON.stringify(value)}\n`);
}

function respond(id, command, data) {
  const record = { type: 'response', command, success: true };
  if (id !== undefined) record.id = id;
  if (data !== undefined) record.data = data;
  write(record);
}

const reader = createInterface({ input: process.stdin, crlfDelay: Infinity });
reader.on('line', (raw) => {
  const line = raw.trim();
  if (!line) return;
  const command = JSON.parse(line);
  switch (command.type) {
    case 'get_state':
      respond(command.id, 'get_state', {
        model: null,
        thinkingLevel: 'medium',
        isStreaming: false,
        isCompacting: false,
        sessionFile: null,
        sessionId: 'burst-session',
        sessionName: null,
        autoCompactionEnabled: true,
        messageCount: 0,
        pendingMessageCount: 0,
      });
      return;
    case 'burst': {
      const count = Number(command.count ?? 100);
      respond(command.id, 'burst');
      for (let index = 0; index < count; index += 1) {
        write({ type: 'queue_update', steering: [String(index)], followUp: [PADDING] });
      }
      write({ type: 'agent_settled' });
      return;
    }
    case 'echo':
      respond(command.id, 'echo', { seq: command.seq });
      return;
    default:
      write({
        type: 'response',
        command: String(command.type),
        success: false,
        error: `Unknown command: ${String(command.type)}`,
        id: command.id,
      });
  }
});
reader.on('close', () => process.exit(0));
