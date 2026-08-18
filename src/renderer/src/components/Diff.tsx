import type { ReactNode } from 'react';

type LineKind = 'add' | 'del' | 'meta' | 'hunk' | 'context';

/** Heuristic: unified-diff output from patch/edit tools. */
export function looksLikeDiff(text: string): boolean {
  if (!text.includes('\n')) return false;
  const lines = text.split('\n');
  if (lines.some((line) => line.startsWith('@@'))) return true;
  const hasHeaders =
    lines.some((line) => line.startsWith('--- ')) && lines.some((line) => line.startsWith('+++ '));
  return hasHeaders;
}

export function Diff({ text }: { text: string }): ReactNode {
  const lines = text.split('\n');
  return (
    <div className="diff" role="group" aria-label="diff">
      {lines.map((line, index) => (
        <div key={index} className="diff-line" data-kind={classify(line)}>
          {line === '' ? ' ' : line}
        </div>
      ))}
    </div>
  );
}

function classify(line: string): LineKind {
  if (line.startsWith('@@')) return 'hunk';
  if (line.startsWith('+++') || line.startsWith('---') || line.startsWith('diff ')) return 'meta';
  if (line.startsWith('+')) return 'add';
  if (line.startsWith('-')) return 'del';
  return 'context';
}
