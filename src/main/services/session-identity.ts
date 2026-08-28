import { createHash } from 'node:crypto';
import type { SessionRef, SessionSummary } from '../../shared/domain.js';

export function recentCatalogId(session: SessionRef): string {
  return `recent-${createHash('sha256')
    .update(`${session.runtime}\0${session.id}\0${session.path ?? ''}`)
    .digest('hex')
    .slice(0, 32)}`;
}

export function recentSummary(session: SessionRef): SessionSummary {
  return {
    id: recentCatalogId(session),
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
  };
}
