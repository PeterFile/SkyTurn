import type { CanvasSessionTab } from "@skyturn/project-core";
import { describe, expect, it } from "vitest";

import { renameSessionTitle } from "./sessionState.js";

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
