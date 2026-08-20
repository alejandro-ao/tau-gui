import { resolve } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { createSpawnSessionTool } from '../src/main/runtime/spawn-session-tool.js';

describe('spawn_session tool', () => {
  it('resolves a relative target from the owning session and returns sidebar identity', async () => {
    const spawn = vi.fn().mockResolvedValue({
      sessionId: 'child-session',
      sessionFile: '/sessions/child.jsonl',
      cwd: '/project/worktree',
    });
    const tool = createSpawnSessionTool('/project/main', spawn);

    const result = await tool.execute(
      'tool-call',
      { prompt: '  implement the feature  ', cwd: '../worktree', name: '  delegated work  ' },
      undefined,
      undefined,
      {} as never,
    );

    expect(spawn).toHaveBeenCalledWith({
      cwd: resolve('/project/main', '../worktree'),
      prompt: 'implement the feature',
      name: 'delegated work',
    });
    expect(result.details).toEqual({
      sessionId: 'child-session',
      sessionFile: '/sessions/child.jsonl',
      cwd: '/project/worktree',
    });
    expect(result.content).toEqual([
      {
        type: 'text',
        text: 'Started background session child-session in /project/worktree. It is available in the app sidebar.',
      },
    ]);
  });

  it('defaults to the owning session directory and rejects whitespace prompts', async () => {
    const spawn = vi.fn().mockResolvedValue({
      sessionId: 'child-session',
      sessionFile: null,
      cwd: '/project/main',
    });
    const tool = createSpawnSessionTool('/project/main', spawn);

    await tool.execute(
      'tool-call',
      { prompt: 'review the code' },
      undefined,
      undefined,
      {} as never,
    );
    expect(spawn).toHaveBeenCalledWith({ cwd: '/project/main', prompt: 'review the code' });

    await expect(
      tool.execute('tool-call', { prompt: '   ' }, undefined, undefined, {} as never),
    ).rejects.toThrow('cannot be empty');
  });
});
