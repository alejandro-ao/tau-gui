import { contextBridge, ipcRenderer } from 'electron';
import type { BridgeEvent, IpcAction, IpcResponse, IpcResult } from '../shared/ipc.js';
import { IPC_EVENT_CHANNEL, IPC_INVOKE_CHANNEL } from '../shared/ipc.js';

/**
 * Narrow, context-isolated bridge. The renderer gets exactly two capabilities:
 * a validated request/response call and a subscription to domain events.
 */
export interface TauBridge {
  invoke<A extends IpcAction>(action: A, payload?: Record<string, unknown>): Promise<IpcResult<A>>;
  subscribe(listener: (event: BridgeEvent) => void): () => void;
  platform: string;
}

const bridge: TauBridge = {
  async invoke(action, payload) {
    const request = payload === undefined ? { action } : { action, payload };
    const response = (await ipcRenderer.invoke(IPC_INVOKE_CHANNEL, request)) as IpcResponse;
    if (!response || typeof response !== 'object' || !('ok' in response)) {
      throw new Error('Malformed IPC response');
    }
    if (!response.ok) throw new Error(response.error);
    return response.value as IpcResult<typeof action>;
  },
  subscribe(listener) {
    const handler = (_event: unknown, payload: unknown): void => {
      if (isBridgeEvent(payload)) listener(payload);
    };
    ipcRenderer.on(IPC_EVENT_CHANNEL, handler);
    return () => {
      ipcRenderer.removeListener(IPC_EVENT_CHANNEL, handler);
    };
  },
  platform: process.platform,
};

function isBridgeEvent(value: unknown): value is BridgeEvent {
  if (typeof value !== 'object' || value === null) return false;
  const type = (value as { type?: unknown }).type;
  return (
    type === 'agent' ||
    type === 'status' ||
    type === 'diagnostic' ||
    type === 'settings' ||
    type === 'focus'
  );
}

contextBridge.exposeInMainWorld('tau', bridge);
