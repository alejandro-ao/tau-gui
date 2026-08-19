import type { AppSettings, SessionRef } from '../../../shared/domain.js';

export interface WorkingDirectoryGroup {
  cwd: string;
  label: string;
  sessions: SessionRef[];
}

/**
 * Groups app-owned session metadata without reading the filesystem. Persisted
 * directory order wins; session metadata repairs older settings on read.
 */
export function groupSessionsByWorkingDirectory(settings: AppSettings): WorkingDirectoryGroup[] {
  const directories = [
    ...settings.workingDirectories,
    settings.cwd,
    ...settings.recentSessions.map((session) => session.cwd),
  ]
    .filter((cwd): cwd is string => Boolean(cwd))
    .filter((cwd, index, all) => all.indexOf(cwd) === index);

  return directories.map((cwd) => ({
    cwd,
    label: directoryLabel(cwd),
    sessions: settings.recentSessions.filter(
      (session) =>
        session.cwd === cwd && session.messageCount !== 0 && sessionLabel(session) !== null,
    ),
  }));
}

export function directoryLabel(cwd: string): string {
  return cwd.split(/[\\/]/).filter(Boolean).at(-1) ?? cwd;
}

export function sessionLabel(session: Pick<SessionRef, 'name' | 'firstMessage'>): string | null {
  const name = session.name?.trim();
  if (name) return name;
  const message = session.firstMessage?.replace(/\s+/g, ' ').trim();
  if (!message) return null;
  return message.length > 48 ? `${message.slice(0, 48)}…` : message;
}
