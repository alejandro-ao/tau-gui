import { contextBridge, ipcRenderer, webUtils } from 'electron';
import type {
  BridgeEvent,
  IpcAction,
  IpcResponse,
  IpcResult,
  SessionTarget,
} from '../shared/ipc.js';
import {
  contextFilesSchema,
  IPC_EVENT_CHANNEL,
  IPC_INVOKE_CHANNEL,
  resourceCatalogSchema,
} from '../shared/ipc.js';

/**
 * Narrow, context-isolated bridge. The renderer gets exactly two capabilities:
 * a validated request/response call and a subscription to domain events.
 */
export interface TauBridge {
  /**
   * `session` binds the call to one transcript. The main process routes the
   * command to that session's runtime instead of the selected one, so a
   * session switch in flight can never redirect a prompt or a read.
   */
  invoke<A extends IpcAction>(
    action: A,
    payload?: Record<string, unknown>,
    session?: SessionTarget,
  ): Promise<IpcResult<A>>;
  subscribe(listener: (event: BridgeEvent) => void): () => void;
  /** Filesystem path of a dropped file; empty when Electron withholds it. */
  pathForFile(file: File): string;
  platform: string;
}

const bridge: TauBridge = {
  async invoke(action, payload, session) {
    const request: Record<string, unknown> = { action };
    if (payload !== undefined) request['payload'] = payload;
    if (session !== undefined) request['session'] = session;
    const response = (await ipcRenderer.invoke(IPC_INVOKE_CHANNEL, request)) as IpcResponse;
    if (!response || typeof response !== 'object' || !('ok' in response)) {
      throw new Error('Malformed IPC response');
    }
    if (!response.ok) throw new Error(response.error);
    if (action === 'resources.list') {
      return resourceCatalogSchema.parse(response.value) as IpcResult<typeof action>;
    }
    if (action === 'context.list') {
      return contextFilesSchema.parse(response.value) as IpcResult<typeof action>;
    }
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
  pathForFile(file) {
    try {
      return webUtils.getPathForFile(file);
    } catch {
      return '';
    }
  },
  platform: process.platform,
};

function isBridgeEvent(value: unknown): value is BridgeEvent {
  if (typeof value !== 'object' || value === null) return false;
  const record = value as {
    type?: unknown;
    sessionId?: unknown;
    runtime?: unknown;
    snapshot?: unknown;
  };
  const type = record.type;
  return (
    (type === 'agent' &&
      typeof record.sessionId === 'string' &&
      (record.runtime === 'tau' || record.runtime === 'pi')) ||
    (type === 'queue' && isQueueSnapshot(record.snapshot)) ||
    type === 'status' ||
    type === 'diagnostic' ||
    type === 'settings' ||
    type === 'sessionActivity' ||
    type === 'focus'
  );
}

function isQueueSnapshot(value: unknown): boolean {
  if (typeof value !== 'object' || value === null) return false;
  const snapshot = value as Record<string, unknown>;
  const validItems = (items: unknown): boolean =>
    Array.isArray(items) &&
    items.every(
      (item) =>
        typeof item === 'object' &&
        item !== null &&
        typeof (item as Record<string, unknown>)['id'] === 'string' &&
        typeof (item as Record<string, unknown>)['text'] === 'string' &&
        ((item as Record<string, unknown>)['kind'] === 'steering' ||
          (item as Record<string, unknown>)['kind'] === 'follow-up'),
    );
  return (
    (snapshot['runtime'] === 'tau' || snapshot['runtime'] === 'pi') &&
    typeof snapshot['sessionId'] === 'string' &&
    validItems(snapshot['steering']) &&
    validItems(snapshot['followUp'])
  );
}

contextBridge.exposeInMainWorld('tau', bridge);
