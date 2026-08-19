import type { Dirent } from 'node:fs';
import { open, opendir, stat } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import type { PromptTemplateInfo, ResourceCatalog, SkillInfo } from '../../shared/domain.js';
import { RESOURCE_LIMITS, resourceCatalogSchema } from '../../shared/resources.js';

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
  // Project resources are opt-in. Callers must supply an authoritative,
  // explicit positive trust decision; omission must never imply trust.
  const includeProject = options.includeProject === true;
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
      if (previous) {
        addDiagnostic(
          diagnostics,
          `skill ${skill.name}: ${skill.origin} overrides ${previous.origin}`,
        );
      }
      if (previous || skills.size < RESOURCE_LIMITS.catalogEntries) skills.set(skill.name, skill);
      else addDiagnostic(diagnostics, 'skill catalog limit reached; remaining resources ignored');
    }
  }
  for (const directory of promptDirectories) {
    for (const prompt of await promptsFrom(directory, diagnostics)) {
      const previous = prompts.get(prompt.name);
      if (previous) {
        addDiagnostic(
          diagnostics,
          `prompt ${prompt.name}: ${prompt.origin} overrides ${previous.origin}`,
        );
      }
      if (previous || prompts.size < RESOURCE_LIMITS.catalogEntries)
        prompts.set(prompt.name, prompt);
      else addDiagnostic(diagnostics, 'prompt catalog limit reached; remaining resources ignored');
    }
  }

  return resourceCatalogSchema.parse({
    skills: [...skills.values()].sort(byName),
    prompts: [...prompts.values()].sort(byName),
    diagnostics,
  });
}

async function skillsFrom(
  directory: ResourceDirectory,
  diagnostics: string[],
): Promise<SkillInfo[]> {
  const entries = await entriesOf(directory, diagnostics);
  const skills: SkillInfo[] = [];
  for (const entry of entries) {
    if (entry.name.toUpperCase() === 'AGENTS.MD') continue;
    if (!validName(entry.name)) {
      addDiagnostic(diagnostics, `skill ${entry.name}: invalid or oversized name; ignored`);
      continue;
    }
    const entryPath = join(directory.path, entry.name);
    if (entry.isFile() && entry.name.toLowerCase().endsWith('.md')) {
      addDiagnostic(
        diagnostics,
        `skill ${entry.name}: bare Markdown ignored in ${directory.origin}; use <name>/SKILL.md`,
      );
      continue;
    }
    if (!(await isDirectory(entryPath))) continue;
    const path = join(entryPath, 'SKILL.md');
    const raw = await readableMarkdown(path, `skill ${entry.name}`, diagnostics);
    if (raw === null) continue;
    const parsed = parseMarkdownResource(raw);
    const description = parsed.metadata.get('description') ?? null;
    if (!validDescription(description)) {
      addDiagnostic(diagnostics, `skill ${entry.name}: invalid or oversized description; ignored`);
      continue;
    }
    skills.push({
      name: entry.name,
      description,
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
  for (const entry of await entriesOf(directory, diagnostics)) {
    if (!entry.name.toLowerCase().endsWith('.md')) continue;
    const name = entry.name.slice(0, -3);
    if (!validName(name)) {
      addDiagnostic(diagnostics, `prompt ${name}: invalid or oversized name; ignored`);
      continue;
    }
    if (RESERVED_PROMPTS.has(name.toLowerCase())) {
      addDiagnostic(
        diagnostics,
        `prompt ${name}: name is reserved; ignored in ${directory.origin}`,
      );
      continue;
    }
    const path = join(directory.path, entry.name);
    const raw = await readableMarkdown(path, `prompt ${name}`, diagnostics);
    if (raw === null) continue;
    const parsed = parseMarkdownResource(raw);
    const description = parsed.metadata.get('description') ?? null;
    if (!validDescription(description)) {
      addDiagnostic(diagnostics, `prompt ${name}: invalid or oversized description; ignored`);
      continue;
    }
    prompts.push({ name, description, origin: directory.origin });
  }
  return prompts;
}

async function entriesOf(
  directory: ResourceDirectory,
  diagnostics: string[],
): Promise<Dirent<string>[]> {
  if (!validPath(directory.path)) {
    addDiagnostic(diagnostics, `${directory.origin}: resource path is oversized; ignored`);
    return [];
  }
  const entries: Dirent<string>[] = [];
  try {
    const handle = await opendir(directory.path);
    for await (const entry of handle) {
      if (entries.length >= RESOURCE_LIMITS.directoryEntries) {
        addDiagnostic(diagnostics, `${directory.origin}: directory entry limit reached`);
        break;
      }
      entries.push(entry);
    }
  } catch {
    return [];
  }
  return entries;
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
  if (!validPath(path)) {
    addDiagnostic(diagnostics, `${label}: resource path is oversized; ignored`);
    return null;
  }
  let handle;
  try {
    handle = await open(path, 'r');
    const info = await handle.stat();
    if (!info.isFile() || info.size > RESOURCE_LIMITS.fileBytes) {
      addDiagnostic(diagnostics, `${label}: resource is oversized or not a regular file; ignored`);
      return null;
    }
    const buffer = Buffer.alloc(RESOURCE_LIMITS.fileBytes + 1);
    let bytesRead = 0;
    while (bytesRead < buffer.length) {
      const result = await handle.read(buffer, bytesRead, buffer.length - bytesRead, bytesRead);
      if (result.bytesRead === 0) break;
      bytesRead += result.bytesRead;
    }
    if (bytesRead > RESOURCE_LIMITS.fileBytes) {
      addDiagnostic(diagnostics, `${label}: resource is oversized; ignored`);
      return null;
    }
    try {
      return new TextDecoder('utf-8', { fatal: true }).decode(buffer.subarray(0, bytesRead));
    } catch {
      addDiagnostic(diagnostics, `${label}: resource is not valid UTF-8; ignored`);
      return null;
    }
  } catch (error) {
    // Missing SKILL.md is normal; other failures remain useful diagnostics.
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
      addDiagnostic(diagnostics, `${label}: could not read resource`);
    }
    return null;
  } finally {
    await handle?.close();
  }
}

function parseMarkdownResource(raw: string): { metadata: Map<string, string> } {
  const normalized = raw.replaceAll('\r\n', '\n').replaceAll('\r', '\n');
  if (!normalized.startsWith('---\n')) return { metadata: new Map() };
  const end = normalized.indexOf('\n---', 4);
  if (end < 0) return { metadata: new Map() };
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
  return { metadata };
}

function validName(value: string): boolean {
  return (
    value.length > 0 &&
    value.length <= RESOURCE_LIMITS.nameCharacters &&
    ![...value].some((character) => {
      const codePoint = character.codePointAt(0) ?? 0;
      return codePoint <= 0x1f || codePoint === 0x7f;
    })
  );
}

function validDescription(value: string | null): boolean {
  return (
    value === null ||
    (value.length <= RESOURCE_LIMITS.descriptionCharacters && !hasControlCharacter(value))
  );
}

function validPath(value: string): boolean {
  return value.length <= RESOURCE_LIMITS.pathCharacters;
}

function addDiagnostic(diagnostics: string[], message: string): void {
  if (diagnostics.length >= RESOURCE_LIMITS.diagnostics) return;
  const sanitized = [...message]
    .map((character) => (hasControlCharacter(character) ? '\ufffd' : character))
    .join('');
  diagnostics.push(sanitized.slice(0, RESOURCE_LIMITS.diagnosticCharacters));
}

function hasControlCharacter(value: string): boolean {
  return [...value].some((character) => {
    const codePoint = character.codePointAt(0) ?? 0;
    return codePoint <= 0x1f || codePoint === 0x7f;
  });
}

function byName(left: { name: string }, right: { name: string }): number {
  return left.name.localeCompare(right.name);
}
