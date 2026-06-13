import type { CanvasSessionTab, ImportedProject } from "@skyturn/project-core";

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

export function resolveSessionProjectId(
  projects: ImportedProject[],
  selectedProjectId: string | null | undefined,
  activeProjectId: string | null | undefined,
): string | null {
  if (selectedProjectId && projects.some((project) => project.id === selectedProjectId)) {
    return selectedProjectId;
  }

  if (activeProjectId && projects.some((project) => project.id === activeProjectId)) {
    return activeProjectId;
  }

  return projects[0]?.id ?? null;
}

export function chooseActiveSessionIdForProject(
  sessions: CanvasSessionTab[],
  activeSessionId: string | null,
  projectId: string,
): string | null {
  const activeSession = sessions.find((session) => session.id === activeSessionId);
  if (activeSession?.projectId === projectId) return activeSession.id;

  return sessions.find((session) => session.projectId === projectId)?.id ?? null;
}

export function toggleCollapsedProjectId(collapsedProjectIds: string[], projectId: string): string[] {
  return collapsedProjectIds.includes(projectId)
    ? collapsedProjectIds.filter((id) => id !== projectId)
    : [...collapsedProjectIds, projectId];
}
