/** Presentation helpers shared by transcript, tool and sidebar components. */

const PATH_KEYS = ['path', 'file_path', 'filePath', 'file', 'filename', 'target'];
const PATH_LIST_KEYS = ['paths', 'file_paths', 'files'];
const MAX_ARG_JSON = 400;

/** Paths referenced by a tool invocation, in argument order. */
export function toolPaths(args: Record<string, unknown>): string[] {
  const paths: string[] = [];
  for (const key of PATH_KEYS) {
    const value = args[key];
    if (typeof value === 'string' && value.trim()) paths.push(value);
  }
  for (const key of PATH_LIST_KEYS) {
    const value = args[key];
    if (Array.isArray(value)) {
      for (const entry of value) if (typeof entry === 'string' && entry.trim()) paths.push(entry);
    }
  }
  return paths;
}

/** Collapsed-state intent line: what the call is doing, never its output. */
export function toolIntent(name: string, args: Record<string, unknown>): string {
  const paths = toolPaths(args);
  switch (name) {
    case 'read':
    case 'edit':
    case 'write':
    case 'multiedit': {
      if (paths.length === 0) return boundedArgs(args);
      const first = paths[0] ?? '';
      return paths.length === 1 ? first : `${first} +${paths.length - 1} more`;
    }
    case 'bash': {
      const description = args['description'];
      if (typeof description === 'string' && description.trim()) return description.trim();
      const command = args['command'];
      return typeof command === 'string' ? firstLine(command) : boundedArgs(args);
    }
    default:
      return boundedArgs(args);
  }
}

export function firstLine(text: string): string {
  const line = text.split('\n').find((candidate) => candidate.trim().length > 0);
  return (line ?? '').trim();
}

/** Bounded JSON so unknown/extension tools stay readable when collapsed. */
export function boundedArgs(args: Record<string, unknown>, limit = MAX_ARG_JSON): string {
  const entries = Object.entries(args);
  if (entries.length === 0) return '(no arguments)';
  let json: string;
  try {
    json = JSON.stringify(args);
  } catch {
    json = String(Object.keys(args));
  }
  return json.length > limit ? `${json.slice(0, limit)}…` : json;
}

export function formatArgs(args: Record<string, unknown>): string {
  try {
    return JSON.stringify(args, null, 2);
  } catch {
    return String(Object.keys(args));
  }
}

export function formatTokens(value: number): string {
  if (!Number.isFinite(value)) return '0';
  if (Math.abs(value) >= 1_000_000) return `${(value / 1_000_000).toFixed(2)}M`;
  if (Math.abs(value) >= 1_000) return `${(value / 1_000).toFixed(1)}k`;
  return String(Math.round(value));
}

export function formatCost(cost: number | null): string {
  return cost === null ? '$N/A' : `$${cost.toFixed(4)}`;
}

export function formatPercent(value: number): string {
  return `${Math.round(value)}%`;
}

/** True while the user holds a real text selection somewhere in the document. */
export function hasTextSelection(): boolean {
  const selection = window.getSelection?.();
  return Boolean(selection && !selection.isCollapsed && selection.toString().trim().length > 0);
}
