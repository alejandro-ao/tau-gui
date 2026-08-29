import { join } from 'node:path';
import {
  ensureCheckedDirectory,
  retainedArtifactCount,
  SESSION_IO_LIMITS,
} from '../runtime/session-files.js';

export interface ImportRecoveryAccess {
  health(): Promise<{ retained: number; capacity: number }>;
  reveal(): Promise<void>;
}

/** Main-owned recovery access that does not depend on a selected/live runtime. */
export class ImportRecoveryService implements ImportRecoveryAccess {
  constructor(
    private readonly agentDir: string,
    private readonly openPath: (path: string) => Promise<string>,
  ) {}

  async health(): Promise<{ retained: number; capacity: number }> {
    const root = await ensureCheckedDirectory(join(this.agentDir, 'imported-sessions'));
    return {
      retained: await retainedArtifactCount(root),
      capacity: SESSION_IO_LIMITS.retainedArtifacts,
    };
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
