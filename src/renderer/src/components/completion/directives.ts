import type { ResourceCatalog } from '../../../../shared/domain.js';
import { tokenAt, type Token } from './tokens.js';

/**
 * Resource-backed slash directives the composer highlights while typing.
 *
 * Both expand inside the runtime rather than running a GUI command, so the
 * composer marks them to explain why Enter sends a prompt instead of opening a
 * modal.
 */
export type DirectiveKind = 'prompt' | 'skill';

export interface Directive {
  kind: DirectiveKind;
  /** Catalog name, without the leading `/` or the `skill:` prefix. */
  name: string;
  token: Token;
}

/** Run of draft text sharing one highlight state. */
export interface DraftSegment {
  text: string;
  kind: DirectiveKind | null;
}

const SKILL_PREFIX = '/skill:';

/**
 * Recognizes the leading `/skill:<name>` or `/<prompt>` directive of a draft.
 *
 * Mirrors dispatch in `useCompletion`: only the first token can be a directive,
 * names match case-insensitively, and unknown names stay unhighlighted so the
 * highlight always means "this resolves to a resource that exists".
 */
export function matchDirective(text: string, resources: ResourceCatalog): Directive | null {
  if (!text.startsWith('/')) return null;
  const token = tokenAt(text, 0);
  if (token.text.toLowerCase().startsWith(SKILL_PREFIX)) {
    const name = token.text.slice(SKILL_PREFIX.length);
    const skill = find(
      resources.skills.map((entry) => entry.name),
      name,
    );
    return skill === null ? null : { kind: 'skill', name: skill, token };
  }
  const prompt = find(
    resources.prompts.map((entry) => entry.name),
    token.text.slice(1),
  );
  return prompt === null ? null : { kind: 'prompt', name: prompt, token };
}

function find(names: string[], candidate: string): string | null {
  if (candidate.length === 0) return null;
  const lowered = candidate.toLowerCase();
  return names.find((name) => name.toLowerCase() === lowered) ?? null;
}

/**
 * Splits a draft into highlighted and plain runs for the composer backdrop.
 *
 * The directive always starts the draft, so at most two segments are produced:
 * the directive itself and any remaining arguments.
 */
export function draftSegments(text: string, resources: ResourceCatalog): DraftSegment[] {
  const directive = matchDirective(text, resources);
  if (!directive) return text.length === 0 ? [] : [{ text, kind: null }];
  const rest = text.slice(directive.token.end);
  const head: DraftSegment = { text: directive.token.text, kind: directive.kind };
  return rest.length === 0 ? [head] : [head, { text: rest, kind: null }];
}
