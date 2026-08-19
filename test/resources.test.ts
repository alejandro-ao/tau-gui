import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { discoverTauResources } from '../src/main/services/resources.js';

async function markdown(path: string, content: string): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, content, 'utf8');
}

describe('Tau resource discovery', () => {
  it('loads metadata in Tau precedence order without returning contents', async () => {
    const root = await mkdtemp(join(tmpdir(), 'tau-gui-resources-'));
    const home = join(root, 'home');
    const cwd = join(root, 'project');
    await markdown(
      join(home, '.tau', 'skills', 'review', 'SKILL.md'),
      '---\ndescription: User review\n---\nsecret user instructions',
    );
    await markdown(
      join(cwd, '.agents', 'skills', 'review', 'SKILL.md'),
      '---\ndescription: Project review\ndisable-model-invocation: true\n---\nsecret project instructions',
    );
    await markdown(
      join(home, '.agents', 'prompts', 'ship.md'),
      '---\ndescription: Ship safely\n---\nDeploy {{ arguments }}',
    );

    const catalog = await discoverTauResources(cwd, { home });

    expect(catalog.skills).toEqual([
      {
        name: 'review',
        description: 'Project review',
        origin: './.agents/skills',
        disableModelInvocation: true,
      },
    ]);
    expect(catalog.prompts).toEqual([
      { name: 'ship', description: 'Ship safely', origin: '~/.agents/prompts' },
    ]);
    expect(catalog.diagnostics[0]).toContain('overrides');
    expect(JSON.stringify(catalog)).not.toContain('secret');
  });

  it('ignores reserved prompts, bare skill Markdown, and declined project resources', async () => {
    const root = await mkdtemp(join(tmpdir(), 'tau-gui-resources-'));
    const home = join(root, 'home');
    const cwd = join(root, 'project');
    await markdown(join(home, '.tau', 'skills', 'old.md'), '# Old skill');
    await markdown(join(home, '.tau', 'prompts', 'skills.md'), '# Reserved');
    await markdown(join(cwd, '.tau', 'prompts', 'project.md'), '# Project prompt');

    const catalog = await discoverTauResources(cwd, { home, includeProject: false });

    expect(catalog.skills).toEqual([]);
    expect(catalog.prompts).toEqual([]);
    expect(catalog.diagnostics).toHaveLength(2);
  });
});
