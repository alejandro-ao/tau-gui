import { describe, expect, it } from 'vitest';
import {
  draftSegments,
  matchDirective,
} from '../../src/renderer/src/components/completion/directives.js';
import type { ResourceCatalog } from '../../src/shared/domain.js';

const RESOURCES: ResourceCatalog = {
  skills: [
    {
      name: 'security-review',
      description: 'Review for security issues',
      origin: '~/.agents/skills',
      disableModelInvocation: false,
    },
  ],
  prompts: [
    { name: 'release-notes', description: 'Draft release notes', origin: './.tau/prompts' },
    { name: 'model', description: 'Custom model audit', origin: './.tau/prompts' },
  ],
  diagnostics: [],
};

describe('composer directives', () => {
  it('matches a custom prompt in the first token', () => {
    expect(matchDirective('/release-notes', RESOURCES)).toEqual({
      kind: 'prompt',
      name: 'release-notes',
      token: { start: 0, end: 14, text: '/release-notes' },
    });
  });

  it('matches a skill invocation and keeps its arguments out of the token', () => {
    const directive = matchDirective('/skill:security-review check auth', RESOURCES);
    expect(directive?.kind).toBe('skill');
    expect(directive?.name).toBe('security-review');
    expect(directive?.token.text).toBe('/skill:security-review');
  });

  it('matches names case-insensitively, as dispatch does', () => {
    expect(matchDirective('/Release-Notes', RESOURCES)?.name).toBe('release-notes');
    expect(matchDirective('/SKILL:Security-Review', RESOURCES)?.kind).toBe('skill');
  });

  it('ignores unknown names so a pill always resolves to a real resource', () => {
    expect(matchDirective('/hotkeys', RESOURCES)).toBeNull();
    expect(matchDirective('/skill:missing', RESOURCES)).toBeNull();
    expect(matchDirective('/skill:', RESOURCES)).toBeNull();
    expect(matchDirective('/', RESOURCES)).toBeNull();
  });

  it('only treats the first token as a directive', () => {
    expect(matchDirective('please /release-notes', RESOURCES)).toBeNull();
    expect(matchDirective('!/release-notes', RESOURCES)).toBeNull();
  });

  it('splits the draft into the directive and its arguments', () => {
    expect(draftSegments('/release-notes for v2', RESOURCES)).toEqual([
      { text: '/release-notes', kind: 'prompt' },
      { text: ' for v2', kind: null },
    ]);
    expect(draftSegments('/skill:security-review', RESOURCES)).toEqual([
      { text: '/skill:security-review', kind: 'skill' },
    ]);
  });

  it('returns a single plain segment for ordinary drafts', () => {
    expect(draftSegments('ship the release', RESOURCES)).toEqual([
      { text: 'ship the release', kind: null },
    ]);
    expect(draftSegments('/hotkeys', RESOURCES)).toEqual([{ text: '/hotkeys', kind: null }]);
    expect(draftSegments('', RESOURCES)).toEqual([]);
  });

  it('reconstructs the draft exactly, so the backdrop mirrors the textarea', () => {
    const draft = '/release-notes  ship  v2\nsecond line';
    expect(
      draftSegments(draft, RESOURCES)
        .map((segment) => segment.text)
        .join(''),
    ).toBe(draft);
  });
});
