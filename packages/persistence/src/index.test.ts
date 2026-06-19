import { describe, expect, it } from "vitest";

import { normalizeWorkspaceState, type WorkspaceState } from "./index.js";

describe("workspace persistence compatibility", () => {
  it("loads old canvas sessions without planner identity and assigns one lazily", () => {
    const workspace = normalizeWorkspaceState({
      sessions: [
        {
          id: "session-1",
          projectId: "project-1",
          title: "Old session",
          goal: "Ship old canvas",
          mode: "fast",
          kind: "canvas",
          createdAt: "2026-06-10T00:00:00.000Z",
          updatedAt: "2026-06-10T00:00:00.000Z",
          activeNodeId: "node-1",
          edges: [],
          nodes: [
            {
              id: "node-1",
              title: "Plan workflow",
              agent: "hermes",
              progress: "Planning",
              status: "completed",
              position: { x: 80, y: 100 },
              runId: "run-session-1-node-1",
              changesetId: "changeset-session-1-node-1",
              output: [],
              worktree: {
                path: ".",
                branchName: "skyturn/session-1/node-1",
                baseCommit: "base",
              },
              context: {
                brief: "Plan workflow",
                sessionGoal: "Ship old canvas",
                relatedRequirements: "",
                relatedDesign: "",
                relatedTasks: "",
                dependencies: [],
                constraints: [],
              },
            },
          ],
        },
      ],
    } as unknown as Partial<WorkspaceState>);

    const session = workspace.sessions[0];

    expect(session?.kind).toBe("canvas");
    if (session?.kind !== "canvas") return;
    expect(session.hermesPlannerSessionId).toBe("hermes-planner-session-1");
    expect(session.plannerNodeId).toBe("node-1");
    expect(session.target).toEqual({
      executionTarget: "current_branch",
      selectedBranch: "HEAD",
    });
  });
});
