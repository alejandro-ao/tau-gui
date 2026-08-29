'use strict';

/**
 * App-owned utility boundary. It intentionally accepts no extension path or
 * loading command until Pi exposes a serializable extension host adapter.
 */
const port = process.parentPort;
if (!port) throw new Error('Extension host requires an Electron utility parent port');

port.on('message', (event) => {
  const message = event.data;
  if (!message || typeof message !== 'object' || Array.isArray(message)) return;
  if (message.type === 'ping' && typeof message.nonce === 'string') {
    port.postMessage({ type: 'ready', nonce: message.nonce.slice(0, 100) });
    return;
  }
  if (message.type === 'shutdown') process.exit(0);
});
