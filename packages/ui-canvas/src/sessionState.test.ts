import type { CanvasSessionTab } from "@skyturn/project-core";
import { describe, expect, it } from "vitest";

import {
  chooseActiveSessionIdForProject,
  renameSessionTitle,
  resolveSessionProjectId,
  toggleCollapsedProjectId,
} from "./sessionState.js";

const session = {
  id: "session-1",
  projectId: "project-1",
  title: "Old title",
  goal: "Ship UI",
  mode: "fast",
  kind: "canvas",
  createdAt: "2026-06-13T00:00:00.000Z",
  updatedAt: "2026-06-13T00:00:00.000Z",
  nodes: [],
  edges: [],
  activeNodeId: null,
} satisfies CanvasSessionTab;

describe("session title state", () => {
  it("renames the selected session and trims display whitespace", () => {
    const sessions = renameSessionTitle([session], "session-1", "  New title  ", "2026-06-13T01:00:00.000Z");

    expect(sessions[0]?.title).toBe("New title");
    expect(sessions[0]?.updatedAt).toBe("2026-06-13T01:00:00.000Z");
  });

  it("ignores empty title edits", () => {
    const original = [session];
    const sessions = renameSessionTitle(original, "session-1", "   ", "2026-06-13T01:00:00.000Z");

    expect(sessions).toBe(original);
    expect(sessions[0]).toBe(session);
  });
});

describe("project session state", () => {
  const projects = [
    {
      id: "project-1",
      name: "SkyTurn",
      rootPath: "/tmp/skyturn",
      devflowPath: "/tmp/skyturn/.devflow",
      openedAt: "2026-06-13T00:00:00.000Z",
    },
    {
      id: "project-2",
      name: "Hermes",
      rootPath: "/tmp/hermes",
      devflowPath: "/tmp/hermes/.devflow",
      openedAt: "2026-06-13T00:00:00.000Z",
    },
  ];

  it("uses the explicitly selected project for a new session", () => {
    expect(resolveSessionProjectId(projects, "project-2", "project-1")).toBe("project-2");
  });

  it("falls back to the active project when the selected project is stale", () => {
    expect(resolveSessionProjectId(projects, "missing", "project-1")).toBe("project-1");
  });

  it("keeps the active session only when it belongs to the selected project", () => {
    const sessions = [
      session,
      { ...session, id: "session-2", projectId: "project-2", title: "Other project" },
    ];

    expect(chooseActiveSessionIdForProject(sessions, "session-1", "project-1")).toBe("session-1");
    expect(chooseActiveSessionIdForProject(sessions, "session-1", "project-2")).toBe("session-2");
  });

  it("toggles project session collapse without duplicating ids", () => {
    expect(toggleCollapsedProjectId([], "project-1")).toEqual(["project-1"]);
    expect(toggleCollapsedProjectId(["project-1"], "project-1")).toEqual([]);
    expect(toggleCollapsedProjectId(["project-1"], "project-2")).toEqual(["project-1", "project-2"]);
  });
});
