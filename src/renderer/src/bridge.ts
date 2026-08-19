import type { BridgeEvent, IpcAction, IpcResult } from '../../shared/ipc.js';

interface TauBridge {
  invoke<A extends IpcAction>(action: A, payload?: Record<string, unknown>): Promise<IpcResult<A>>;
  subscribe(listener: (event: BridgeEvent) => void): () => void;
  pathForFile?: (file: File) => string;
  platform: string;
}

declare global {
  interface Window {
    tau?: TauBridge;
  }
}

function bridge(): TauBridge {
  const value = window.tau;
  if (!value) throw new Error('Preload bridge is unavailable');
  return value;
}

export function invoke<A extends IpcAction>(
  action: A,
  payload?: Record<string, unknown>,
): Promise<IpcResult<A>> {
  return bridge().invoke(action, payload);
}

export function subscribe(listener: (event: BridgeEvent) => void): () => void {
  return bridge().subscribe(listener);
}

/**
 * Filesystem path for a dropped file. Electron exposes this through the
 * preload bridge only; the renderer never touches Node APIs.
 */
export function pathForFile(file: File): string {
  return window.tau?.pathForFile?.(file) ?? '';
}

export function platform(): string {
  return window.tau?.platform ?? 'unknown';
}

/** Wraps an action so failures surface as UI notices instead of unhandled rejections. */
export async function attempt<A extends IpcAction>(
  action: A,
  payload: Record<string, unknown> | undefined,
  onError: (message: string) => void,
): Promise<IpcResult<A> | null> {
  try {
    return await invoke(action, payload);
  } catch (error) {
    onError((error as Error).message);
    return null;
  }
}
