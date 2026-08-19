import type { Dirent } from 'node:fs';
import { readFile, readdir, stat } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import type { PromptTemplateInfo, ResourceCatalog, SkillInfo } from '../../shared/domain.js';

const RESERVED_PROMPTS = new Set(['prompts', 'skills', 'tools', 'reload']);

interface ResourceDirectory {
  path: string;
  origin: string;
}

/**
 * Discover Tau's user and project prompt resources without exposing file
 * contents to the renderer. Directories are visited in Tau precedence order;
 * later resources replace earlier resources with the same name.
 */
export async function discoverTauResources(
  cwd: string,
  options: { includeProject?: boolean; home?: string } = {},
): Promise<ResourceCatalog> {
  const home = options.home ?? homedir();
  const includeProject = options.includeProject ?? true;
  const skillDirectories: ResourceDirectory[] = [
    { path: join(home, '.tau', 'skills'), origin: '~/.tau/skills' },
    { path: join(home, '.agents', 'skills'), origin: '~/.agents/skills' },
  ];
  const promptDirectories: ResourceDirectory[] = [
    { path: join(home, '.tau', 'prompts'), origin: '~/.tau/prompts' },
    { path: join(home, '.agents', 'prompts'), origin: '~/.agents/prompts' },
  ];
  if (includeProject) {
    skillDirectories.push(
      { path: join(cwd, '.tau', 'skills'), origin: './.tau/skills' },
      { path: join(cwd, '.agents', 'skills'), origin: './.agents/skills' },
    );
    promptDirectories.push(
      { path: join(cwd, '.tau', 'prompts'), origin: './.tau/prompts' },
      { path: join(cwd, '.agents', 'prompts'), origin: './.agents/prompts' },
    );
  }

  const diagnostics: string[] = [];
  const skills = new Map<string, SkillInfo>();
  const prompts = new Map<string, PromptTemplateInfo>();

  for (const directory of skillDirectories) {
    for (const skill of await skillsFrom(directory, diagnostics)) {
      const previous = skills.get(skill.name);
      if (previous)
        diagnostics.push(`skill ${skill.name}: ${skill.origin} overrides ${previous.origin}`);
      skills.set(skill.name, skill);
    }
  }
  for (const directory of promptDirectories) {
    for (const prompt of await promptsFrom(directory, diagnostics)) {
      const previous = prompts.get(prompt.name);
      if (previous)
        diagnostics.push(`prompt ${prompt.name}: ${prompt.origin} overrides ${previous.origin}`);
      prompts.set(prompt.name, prompt);
    }
  }

  return {
    skills: [...skills.values()].sort(byName),
    prompts: [...prompts.values()].sort(byName),
    diagnostics,
  };
}

async function skillsFrom(
  directory: ResourceDirectory,
  diagnostics: string[],
): Promise<SkillInfo[]> {
  const entries = await entriesOf(directory.path);
  const skills: SkillInfo[] = [];
  for (const entry of entries) {
    if (entry.name.toUpperCase() === 'AGENTS.MD') continue;
    const entryPath = join(directory.path, entry.name);
    if (entry.isFile() && entry.name.toLowerCase().endsWith('.md')) {
      diagnostics.push(
        `skill ${entry.name}: bare Markdown ignored in ${directory.origin}; use <name>/SKILL.md`,
      );
      continue;
    }
    if (!(await isDirectory(entryPath))) continue;
    const path = join(entryPath, 'SKILL.md');
    const raw = await readableMarkdown(path, `skill ${entry.name}`, diagnostics);
    if (raw === null) continue;
    const parsed = parseMarkdownResource(raw);
    skills.push({
      name: entry.name,
      description: parsed.metadata.get('description') ?? deriveDescription(parsed.content),
      origin: directory.origin,
      disableModelInvocation:
        parsed.metadata.get('disable-model-invocation')?.trim().toLowerCase() === 'true',
    });
  }
  return skills;
}

async function promptsFrom(
  directory: ResourceDirectory,
  diagnostics: string[],
): Promise<PromptTemplateInfo[]> {
  const prompts: PromptTemplateInfo[] = [];
  for (const entry of await entriesOf(directory.path)) {
    if (!entry.name.toLowerCase().endsWith('.md')) continue;
    const name = entry.name.slice(0, -3);
    if (RESERVED_PROMPTS.has(name.toLowerCase())) {
      diagnostics.push(`prompt ${name}: name is reserved; ignored in ${directory.origin}`);
      continue;
    }
    const path = join(directory.path, entry.name);
    const raw = await readableMarkdown(path, `prompt ${name}`, diagnostics);
    if (raw === null) continue;
    const parsed = parseMarkdownResource(raw);
    prompts.push({
      name,
      description: parsed.metadata.get('description') ?? deriveDescription(parsed.content),
      origin: directory.origin,
    });
  }
  return prompts;
}

async function entriesOf(path: string): Promise<Dirent<string>[]> {
  try {
    return await readdir(path, { withFileTypes: true });
  } catch {
    return [];
  }
}

async function isDirectory(path: string): Promise<boolean> {
  try {
    return (await stat(path)).isDirectory();
  } catch {
    return false;
  }
}

async function readableMarkdown(
  path: string,
  label: string,
  diagnostics: string[],
): Promise<string | null> {
  try {
    return await readFile(path, 'utf8');
  } catch (error) {
    // Missing SKILL.md is normal; other failures remain useful diagnostics.
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
      diagnostics.push(`${label}: could not read resource`);
    }
    return null;
  }
}

function parseMarkdownResource(raw: string): { metadata: Map<string, string>; content: string } {
  const normalized = raw.replaceAll('\r\n', '\n').replaceAll('\r', '\n');
  if (!normalized.startsWith('---\n')) return { metadata: new Map(), content: normalized };
  const end = normalized.indexOf('\n---', 4);
  if (end < 0) return { metadata: new Map(), content: normalized };
  const metadata = new Map<string, string>();
  for (const line of normalized.slice(4, end).split('\n')) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const separator = trimmed.indexOf(':');
    if (separator < 0) continue;
    const key = trimmed.slice(0, separator).trim();
    const value = trimmed
      .slice(separator + 1)
      .trim()
      .replace(/^(["'])(.*)\1$/, '$2');
    metadata.set(key, value);
  }
  let content = normalized.slice(end + 4);
  if (content.startsWith('\n')) content = content.slice(1);
  return { metadata, content };
}

function deriveDescription(content: string): string | null {
  for (const line of content.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    return trimmed.startsWith('#') ? trimmed.replace(/^#+/, '').trim() || null : trimmed;
  }
  return null;
}

function byName(left: { name: string }, right: { name: string }): number {
  return left.name.localeCompare(right.name);
}
