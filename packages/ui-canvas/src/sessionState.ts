import type { CanvasSessionTab } from "@skyturn/project-core";

export function renameSessionTitle(
  sessions: CanvasSessionTab[],
  sessionId: string,
  nextTitle: string,
  updatedAt: string,
): CanvasSessionTab[] {
  const title = nextTitle.trim();
  if (!title) return sessions;

  let changed = false;
  const nextSessions = sessions.map((session) => {
    if (session.id !== sessionId || session.title === title) return session;
    changed = true;
    return { ...session, title, updatedAt };
  });

  return changed ? nextSessions : sessions;
}
