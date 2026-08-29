import { join } from 'node:path';
import type { ImportRecoveryHealth } from '../../shared/ipc.js';
import {
  ensureCheckedDirectory,
  retainedArtifactCount,
  SESSION_IO_LIMITS,
} from '../runtime/session-files.js';

export interface ImportRecoveryAccess {
  health(): Promise<ImportRecoveryHealth>;
  reveal(): Promise<void>;
}

/** Main-owned recovery access that does not depend on a selected/live runtime. */
export class ImportRecoveryService implements ImportRecoveryAccess {
  constructor(
    private readonly agentDir: string,
    private readonly openPath: (path: string) => Promise<string>,
  ) {}

  async health(): Promise<ImportRecoveryHealth> {
    try {
      const root = await ensureCheckedDirectory(join(this.agentDir, 'imported-sessions'));
      return {
        available: true,
        retained: await retainedArtifactCount(root),
        capacity: SESSION_IO_LIMITS.retainedArtifacts,
      };
    } catch {
      // Creation, directory validation, and enumeration failures are all
      // intentionally collapsed before this DTO reaches IPC.
      return { available: false, error: 'Import recovery is unavailable' };
    }
  }

  async reveal(): Promise<void> {
    try {
      const root = await ensureCheckedDirectory(join(this.agentDir, 'imported-sessions'));
      const error = await this.openPath(root);
      if (error) throw new Error(error);
    } catch {
      // The selected path and platform error are main-process-only. IPC gets no
      // details that could disclose the configured Pi agent directory.
      throw new Error('Could not reveal the import recovery directory');
    }
  }
}
