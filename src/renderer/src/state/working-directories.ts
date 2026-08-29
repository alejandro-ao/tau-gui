import type { AppSettings, SessionSummary } from '../../../shared/domain.js';

export interface WorkingDirectoryGroup {
  cwd: string;
  label: string;
  sessions: SessionSummary[];
}

/** Main owns all native/recent identities; renderer never synthesizes catalog IDs. */
export function catalogSessions(
  _settings: AppSettings,
  sessions: SessionSummary[],
): SessionSummary[] {
  const seen = new Set<string>();
  return sessions
    .filter((session) => {
      const identity = `${session.runtime}:${session.id}`;
      if (seen.has(identity)) return false;
      seen.add(identity);
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
