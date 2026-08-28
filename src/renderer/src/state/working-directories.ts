import type { AppSettings, SessionSummary } from '../../../shared/domain.js';

export interface WorkingDirectoryGroup {
  cwd: string;
  label: string;
  sessions: SessionSummary[];
}

/** Main returns a tagged, deduplicated catalog. Renderer never resolves legacy paths. */
export function catalogSessions(
  settings: AppSettings,
  sessions: SessionSummary[],
): SessionSummary[] {
  const identities = new Set(sessions.map((session) => `${session.runtime}:${session.sessionId}`));
  const remembered: SessionSummary[] = settings.recentSessions
    .filter((session) => !identities.has(`${session.runtime}:${session.id}`))
    .map((session) => ({
      // Legacy id is an opaque settings key here; its path never enters a renderer request.
      id: session.id,
      source: 'recent',
      runtime: session.runtime,
      sessionId: session.id,
      exportable: false,
      name: session.name,
      firstMessage: session.firstMessage ?? null,
      cwd: session.cwd,
      createdAt: session.lastSeen,
      modifiedAt: session.lastSeen,
      messageCount: session.messageCount ?? (session.name || session.firstMessage ? 1 : 0),
      parentSessionId: null,
    }));
  const seen = new Set<string>();
  return [...sessions, ...remembered]
    .filter((session) => {
      if (seen.has(session.id)) return false;
      seen.add(session.id);
      return true;
    })
    .sort((left, right) => right.modifiedAt - left.modifiedAt);
}

export function groupSessionsByWorkingDirectory(
  settings: AppSettings,
  nativeSessions: SessionSummary[] = [],
): WorkingDirectoryGroup[] {
  const sessions = catalogSessions(settings, nativeSessions);
  const directories = [
    ...settings.workingDirectories,
    settings.cwd,
    ...sessions.map((session) => session.cwd),
  ]
    .filter((cwd): cwd is string => Boolean(cwd))
    .filter((cwd, index, all) => all.indexOf(cwd) === index);

  return directories.map((cwd) => ({
    cwd,
    label: directoryLabel(cwd),
    sessions: sessions.filter(
      (session) =>
        session.cwd === cwd && session.messageCount !== 0 && sessionLabel(session) !== null,
    ),
  }));
}

export function directoryLabel(cwd: string): string {
  return cwd.split(/[\\/]/).filter(Boolean).at(-1) ?? cwd;
}

export function sessionLabel(
  session: Pick<SessionSummary, 'name' | 'firstMessage'>,
): string | null {
  const name = session.name?.trim();
  if (name) return name;
  const message = session.firstMessage?.replace(/\s+/g, ' ').trim();
  if (!message) return null;
  return message.length > 48 ? `${message.slice(0, 48)}…` : message;
}
