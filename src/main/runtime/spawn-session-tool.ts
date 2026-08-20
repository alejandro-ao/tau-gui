import { homedir } from 'node:os';
import { isAbsolute, resolve } from 'node:path';
import { Type } from 'typebox';
import { defineTool } from '@earendil-works/pi-coding-agent';

export interface SpawnSessionRequest {
  cwd: string;
  prompt: string;
  name?: string;
}

export interface SpawnSessionResult {
  sessionId: string;
  sessionFile: string | null;
  cwd: string;
}

export type SpawnSessionHandler = (request: SpawnSessionRequest) => Promise<SpawnSessionResult>;

/** App-owned Pi tool that delegates session lifecycle to the main-process pool. */
export function createSpawnSessionTool(sourceCwd: string, spawnSession: SpawnSessionHandler) {
  return defineTool({
    name: 'spawn_session',
    label: 'Spawn session',
    description:
      'Start a new background coding-agent session in the current directory or an existing directory. The session appears in the app sidebar and continues independently.',
    promptSnippet:
      'spawn_session: Start an independent background agent session in this directory or another existing directory',
    promptGuidelines: [
      'Use spawn_session for independent work that should have its own transcript in the app sidebar.',
      'When targeting another Git worktree, create or identify that worktree first and pass its directory as cwd.',
    ],
    parameters: Type.Object({
      prompt: Type.String({
        minLength: 1,
        maxLength: 100_000,
        description: 'Complete task or instruction for the new session',
      }),
      cwd: Type.Optional(
        Type.String({
          minLength: 1,
          maxLength: 4_096,
          description: 'Existing target directory; defaults to this session directory',
        }),
      ),
      name: Type.Optional(
        Type.String({
          minLength: 1,
          maxLength: 256,
          description: 'Optional sidebar display name for the new session',
        }),
      ),
    }),
    async execute(_toolCallId, params, signal) {
      if (signal?.aborted) throw new Error('Session spawn was cancelled');
      const prompt = params.prompt.trim();
      const name = params.name?.trim();
      if (!prompt) throw new Error('Session prompt cannot be empty');
      if (params.name !== undefined && !name) throw new Error('Session name cannot be empty');

      const cwd = resolveTargetCwd(sourceCwd, params.cwd);
      const spawned = await spawnSession({ cwd, prompt, ...(name ? { name } : {}) });
      return {
        content: [
          {
            type: 'text',
            text: `Started background session ${spawned.sessionId} in ${spawned.cwd}. It is available in the app sidebar.`,
          },
        ],
        details: spawned,
      };
    },
  });
}

function resolveTargetCwd(sourceCwd: string, input?: string): string {
  if (!input) return resolve(sourceCwd);
  const trimmed = input.trim();
  if (trimmed === '~') return homedir();
  if (trimmed.startsWith('~/') || trimmed.startsWith('~\\')) {
    return resolve(homedir(), trimmed.slice(2));
  }
  return isAbsolute(trimmed) ? resolve(trimmed) : resolve(sourceCwd, trimmed);
}
