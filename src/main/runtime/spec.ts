/**
 * Runtime launch specs and capability tables.
 *
 * Capability flags reflect what each runtime's RPC surface actually implements.
 * See docs/rpc-protocol.md for the audited command/event matrix.
 */
import type { RuntimeCapabilities, RuntimeKind, RuntimeLaunchConfig } from '../../shared/domain.js';
import { DEFAULT_CAPABILITIES } from '../../shared/domain.js';

export const CAPABILITIES: Record<RuntimeKind, RuntimeCapabilities> = {
  tau: {
    ...DEFAULT_CAPABILITIES,
    textPrompt: true,
    steering: true,
    followUps: true,
    directBash: true,
    sessionTree: true,
  },
  pi: {
    ...DEFAULT_CAPABILITIES,
    textPrompt: true,
    imagePrompt: true,
    steering: true,
    followUps: true,
    directBash: true,
    abortBash: true,
    retryControls: true,
    sessionTree: true,
    sessionClone: true,
  },
};

export interface LaunchSpec {
  args: string[];
  /** Session reference that must be applied with `switch_session` after start. */
  deferredSessionRef: string | null;
}

export function buildLaunchSpec(config: RuntimeLaunchConfig): LaunchSpec {
  const args = ['--mode', 'rpc'];
  let deferredSessionRef: string | null = null;

  if (config.kind === 'tau') {
    args.push('--cwd', config.cwd);
    if (config.provider) args.push('--provider', config.provider);
    if (config.model) args.push('--model', config.model);
    if (config.sessionRef) args.push('--session', config.sessionRef);
    if (config.projectTrust === 'approve-once') args.push('--approve');
    if (config.projectTrust === 'decline-once') args.push('--no-approve');
  } else {
    // Pi has no --cwd flag; the working directory is inherited from the spawn.
    if (config.provider) args.push('--provider', config.provider);
    if (config.model) args.push('--model', config.model);
    // Pi resumes by session path, applied once the connection is live.
    if (config.sessionRef) deferredSessionRef = config.sessionRef;
  }

  args.push(...config.extraArgs);
  return { args, deferredSessionRef };
}
