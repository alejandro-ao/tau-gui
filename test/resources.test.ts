import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { discoverTauResources } from '../src/main/services/resources.js';
import { RESOURCE_LIMITS, resourceCatalogSchema } from '../src/shared/resources.js';

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

    const catalog = await discoverTauResources(cwd, { home, includeProject: true });

    expect(catalog.skills).toEqual([
      {
        name: 'review',
        description: 'Project review',
        origin: './.agents/skills',
        disableModelInvocation: true,
        estimatedTokens: 24,
      },
    ]);
    expect(catalog.prompts).toEqual([
      { name: 'ship', description: 'Ship safely', origin: '~/.agents/prompts' },
    ]);
    expect(catalog.diagnostics[0]).toContain('overrides');
    expect(JSON.stringify(catalog)).not.toContain('secret');
  });

  it('does not read project resources when trust is default or declined', async () => {
    const root = await mkdtemp(join(tmpdir(), 'tau-gui-resources-'));
    const home = join(root, 'home');
    const cwd = join(root, 'project');
    await markdown(join(home, '.tau', 'prompts', 'user.md'), '# User prompt');
    await markdown(join(cwd, '.tau', 'prompts', 'project.md'), '# Project prompt');

    const defaultCatalog = await discoverTauResources(cwd, { home });
    const declinedCatalog = await discoverTauResources(cwd, { home, includeProject: false });

    expect(defaultCatalog.prompts.map(({ name }) => name)).toEqual(['user']);
    expect(declinedCatalog.prompts.map(({ name }) => name)).toEqual(['user']);
    expect(JSON.stringify(defaultCatalog)).not.toContain('User prompt');
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

  it('rejects oversized, invalid UTF-8, and oversized-description resources', async () => {
    const root = await mkdtemp(join(tmpdir(), 'tau-gui-resources-'));
    const home = join(root, 'home');
    const cwd = join(root, 'project');
    await markdown(
      join(home, '.tau', 'prompts', 'huge.md'),
      'x'.repeat(RESOURCE_LIMITS.fileBytes + 1),
    );
    const malformed = join(home, '.tau', 'prompts', 'malformed.md');
    await mkdir(dirname(malformed), { recursive: true });
    await writeFile(malformed, Buffer.from([0xc3, 0x28]));
    await markdown(
      join(home, '.tau', 'prompts', 'description.md'),
      `---\ndescription: ${'d'.repeat(RESOURCE_LIMITS.descriptionCharacters + 1)}\n---\nbody`,
    );
    await markdown(
      join(home, '.tau', 'prompts', `${'n'.repeat(RESOURCE_LIMITS.nameCharacters + 1)}.md`),
      '# invalid name',
    );

    const catalog = await discoverTauResources(cwd, { home });

    expect(catalog.prompts).toEqual([]);
    expect(catalog.diagnostics).toEqual(
      expect.arrayContaining([
        expect.stringContaining('oversized'),
        expect.stringContaining('valid UTF-8'),
        expect.stringContaining('oversized description'),
        expect.stringContaining('oversized name'),
      ]),
    );
    expect(resourceCatalogSchema.safeParse(catalog).success).toBe(true);
  });

  it('caps catalog and diagnostic counts deterministically', async () => {
    const root = await mkdtemp(join(tmpdir(), 'tau-gui-resources-'));
    const home = join(root, 'home');
    const cwd = join(root, 'project');
    await Promise.all(
      Array.from({ length: RESOURCE_LIMITS.catalogEntries + 5 }, (_, index) =>
        markdown(join(home, '.tau', 'prompts', `prompt-${index}.md`), '# prompt'),
      ),
    );

    const catalog = await discoverTauResources(cwd, { home });

    expect(catalog.prompts).toHaveLength(RESOURCE_LIMITS.catalogEntries);
    expect(catalog.diagnostics.length).toBeLessThanOrEqual(RESOURCE_LIMITS.diagnostics);
    expect(catalog.diagnostics.some((entry) => entry.includes('catalog limit'))).toBe(true);
  });
});
