import type { AppSettings, SessionSummary } from '../../../shared/domain.js';

export interface WorkingDirectoryGroup {
  cwd: string;
  label: string;
  sessions: SessionSummary[];
}

/**
 * Pi's catalog is authoritative. App-owned recents remain a fallback for
 * previously remembered Pi sessions and keep only UI ordering metadata.
 */
export function catalogSessions(
  settings: AppSettings,
  nativeSessions: SessionSummary[],
): SessionSummary[] {
  const ids = new Set(nativeSessions.map((session) => session.id));
  const remembered = settings.recentSessions
    .filter((session) => !ids.has(session.id))
    .map((session) => ({
      id: session.id,
      name: session.name,
      firstMessage: session.firstMessage ?? null,
      cwd: session.cwd,
      createdAt: session.lastSeen,
      modifiedAt: session.lastSeen,
      messageCount: session.messageCount ?? (session.name || session.firstMessage ? 1 : 0),
      parentSessionId: null,
    }));
  return [...nativeSessions, ...remembered].sort(
    (left, right) => right.modifiedAt - left.modifiedAt,
  );
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
