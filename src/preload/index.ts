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
  parseSessionIpcResult,
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
    if (!response.ok) {
      if (typeof response.error !== 'string' || response.error.length > 1_000) {
        throw new Error('Malformed IPC error');
      }
      throw new Error(response.error);
    }
    if (action === 'resources.list') {
      return resourceCatalogSchema.parse(response.value) as IpcResult<typeof action>;
    }
    if (action === 'context.list') {
      return contextFilesSchema.parse(response.value) as IpcResult<typeof action>;
    }
    return parseSessionIpcResult(action, response.value) as IpcResult<typeof action>;
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
  if (!isRecord(value) || !boundedWire(value)) return false;
  switch (value['type']) {
    case 'agent':
      return (
        onlyKeys(value, ['type', 'sessionId', 'runtime', 'event']) &&
        validId(value['sessionId']) &&
        runtime(value['runtime']) &&
        isRecord(value['event']) &&
        typeof value['event']['type'] === 'string'
      );
    case 'queue':
      return onlyKeys(value, ['type', 'snapshot']) && isQueueSnapshot(value['snapshot']);
    case 'status':
      return onlyKeys(value, ['type', 'snapshot']) && isRuntimeSnapshot(value['snapshot']);
    case 'diagnostic':
      return onlyKeys(value, ['type', 'message']) && validText(value['message'], 2_000);
    case 'settings':
      return onlyKeys(value, ['type', 'settings']) && isSettings(value['settings']);
    case 'sessionActivity':
      return (
        onlyKeys(value, ['type', 'activity']) &&
        isRecord(value['activity']) &&
        onlyKeys(value['activity'], ['sessionId', 'runtime', 'status', 'responseReady']) &&
        validId(value['activity']['sessionId']) &&
        runtime(value['activity']['runtime']) &&
        validStatus(value['activity']['status']) &&
        [true, false, null].includes(value['activity']['responseReady'] as null)
      );
    case 'focus':
      return onlyKeys(value, ['type', 'focused']) && typeof value['focused'] === 'boolean';
    default:
      return false;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function onlyKeys(value: Record<string, unknown>, keys: string[]): boolean {
  const expected = new Set(keys);
  return Object.keys(value).every((key) => expected.has(key)) && keys.every((key) => key in value);
}

function validText(value: unknown, limit: number): value is string {
  return typeof value === 'string' && value.length <= limit;
}

function validId(value: unknown): value is string {
  return validText(value, 128) && value.length > 0;
}

function runtime(value: unknown): value is 'tau' | 'pi' {
  return value === 'tau' || value === 'pi';
}

function validStatus(value: unknown): boolean {
  return [
    'stopped',
    'starting',
    'idle',
    'running',
    'compacting',
    'retrying',
    'failed',
    'disconnected',
  ].includes(String(value));
}

function boundedWire(value: unknown): boolean {
  try {
    return JSON.stringify(value).length <= 1_000_000;
  } catch {
    return false;
  }
}

function isRuntimeSnapshot(value: unknown): boolean {
  if (!isRecord(value)) return false;
  const allowed = [
    'runtime',
    'status',
    'detail',
    'runtimeVersion',
    'capabilities',
    'cwd',
    'gitBranch',
    'state',
    'recoveryTarget',
  ];
  if (!Object.keys(value).every((key) => allowed.includes(key))) return false;
  if (!runtime(value['runtime']) || !validStatus(value['status'])) return false;
  if (!(value['detail'] === null || validText(value['detail'], 1_000))) return false;
  if (!(value['runtimeVersion'] === null || validText(value['runtimeVersion'], 200))) return false;
  if (!(value['cwd'] === null || validText(value['cwd'], 4_096))) return false;
  if (!(value['gitBranch'] === null || validText(value['gitBranch'], 500))) return false;
  if (!isRecord(value['capabilities'])) return false;
  const capabilityKeys = [
    'textPrompt',
    'imagePrompt',
    'steering',
    'followUps',
    'directBash',
    'abortBash',
    'retryControls',
    'sessionTree',
    'sessionClone',
    'sessionList',
    'extensionDialogs',
    'providerLogin',
    'resourceReload',
    'systemPromptInspection',
    'toolCatalog',
  ];
  if (!onlyKeys(value['capabilities'], capabilityKeys)) return false;
  if (!Object.values(value['capabilities']).every((item) => typeof item === 'boolean'))
    return false;
  if (value['state'] !== null && !isAgentState(value['state'])) return false;
  if (value['recoveryTarget'] === undefined || value['recoveryTarget'] === null) return true;
  return (
    isRecord(value['recoveryTarget']) &&
    onlyKeys(value['recoveryTarget'], ['runtime', 'sessionId']) &&
    runtime(value['recoveryTarget']['runtime']) &&
    validId(value['recoveryTarget']['sessionId'])
  );
}

function isAgentState(value: unknown): boolean {
  if (!isRecord(value)) return false;
  const keys = [
    'model',
    'thinkingLevel',
    'isStreaming',
    'isCompacting',
    'sessionFile',
    'sessionId',
    'sessionName',
    'autoCompactionEnabled',
    'messageCount',
    'pendingMessageCount',
  ];
  return (
    onlyKeys(value, keys) &&
    validId(value['sessionId']) &&
    (value['sessionFile'] === null || validText(value['sessionFile'], 4_096)) &&
    (value['sessionName'] === null || validText(value['sessionName'], 500)) &&
    typeof value['isStreaming'] === 'boolean' &&
    typeof value['isCompacting'] === 'boolean' &&
    typeof value['autoCompactionEnabled'] === 'boolean' &&
    Number.isSafeInteger(value['messageCount']) &&
    Number.isSafeInteger(value['pendingMessageCount'])
  );
}

function isSettings(value: unknown): boolean {
  if (!isRecord(value)) return false;
  const keys = [
    'agentRuntime',
    'theme',
    'sidebarPosition',
    'turnNotification',
    'showThinking',
    'cwd',
    'workingDirectories',
    'customSkillDirectories',
    'customPromptDirectories',
    'projectTrust',
    'runtime',
    'scopedModels',
    'recentSessions',
  ];
  return (
    onlyKeys(value, keys) &&
    runtime(value['agentRuntime']) &&
    (value['cwd'] === null || validText(value['cwd'], 4_096)) &&
    Array.isArray(value['workingDirectories']) &&
    value['workingDirectories'].length <= 100 &&
    Array.isArray(value['customSkillDirectories']) &&
    value['customSkillDirectories'].length <= 100 &&
    Array.isArray(value['customPromptDirectories']) &&
    value['customPromptDirectories'].length <= 100 &&
    Array.isArray(value['recentSessions']) &&
    value['recentSessions'].length <= 100
  );
}

function isQueueSnapshot(value: unknown): boolean {
  if (typeof value !== 'object' || value === null) return false;
  const snapshot = value as Record<string, unknown>;
  const validItems = (items: unknown): boolean =>
    Array.isArray(items) &&
    items.every(
      (item) =>
        isRecord(item) &&
        onlyKeys(item, ['id', 'kind', 'text']) &&
        validId(item['id']) &&
        validText(item['text'], 100_000) &&
        (item['kind'] === 'steering' || item['kind'] === 'follow-up'),
    );
  return (
    onlyKeys(snapshot, ['runtime', 'sessionId', 'steering', 'followUp']) &&
    runtime(snapshot['runtime']) &&
    validId(snapshot['sessionId']) &&
    validItems(snapshot['steering']) &&
    validItems(snapshot['followUp'])
  );
}

contextBridge.exposeInMainWorld('tau', bridge);
