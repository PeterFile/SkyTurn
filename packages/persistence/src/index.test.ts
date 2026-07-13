import { describe, expect, it } from "vitest";

import { normalizeWorkspaceState, type WorkspaceState } from "./index.js";

describe("workspace persistence compatibility", () => {
  it("rehydrates nested lossless RunEvent payloads without compacting their content", () => {
    const content = "  first\r\n\tsecond  \n\n";
    const workspace = normalizeWorkspaceState({
      runEvents: {
        "run-lossless": [{
          protocolVersion: 1,
          runId: "run-lossless",
          seq: 1,
          timestamp: "2026-07-15T00:00:00.000Z",
          kind: "output",
          payload: {
            text: content,
            patch: { path: "  src/index.ts\n", hunks: [{ content }] },
            code: [{ language: "  typescript\n", body: content }],
            diff: { path: "  src/index.ts\n", lines: [content, "", "final\n"] },
          },
        }],
      },
    } as unknown as Partial<WorkspaceState>);

    expect(workspace.runEvents["run-lossless"]?.[0]?.payload).toEqual({
      text: content,
      patch: { path: "src/index.ts", hunks: [{ content }] },
      code: [{ language: "typescript", body: content }],
      diff: { path: "src/index.ts", lines: [content, "", "final\n"] },
    });
  });

  it("strictly parses persisted RunEvidence during workspace hydration", () => {
    const workspace = normalizeWorkspaceState({
      runEvents: {
        "run-valid": [{
          protocolVersion: 1,
          runId: "run-valid",
          seq: 1,
          timestamp: "2026-06-10T00:00:00.000Z",
          kind: "progress",
          payload: {
            source: "hermes",
            command: "repo=C:\\Users\\alice\\private",
            opaqueHandle: "Bearer persisted-capability",
          },
        }],
        "run-invalid": [{
          protocolVersion: 1,
          runId: "run-invalid",
          seq: "one",
          timestamp: "2026-06-10T00:00:00.000Z",
          kind: "progress",
          payload: { text: "invalid" },
        }],
      },
      runEvidence: {
        "run-valid": {
          runId: "run-valid",
          status: "succeeded",
          exitCode: 0,
          changesetId: null,
          checks: [{ kind: "artifact", name: "Expected artifacts", status: "failed", detail: "missing=1" }],
          artifacts: [".devflow/acceptance/partial.png"],
          review: null,
          errorReason: null,
          cancelReason: null,
          completedAt: "2026-06-10T00:00:01.000Z",
        },
        "run-invalid": {
          runId: "run-invalid",
          status: "succeeded",
          exitCode: 0,
          changesetId: null,
          checks: [{ kind: "unknown-kind", name: "Unsafe", status: "passed" }],
          artifacts: [],
          review: null,
          errorReason: null,
          cancelReason: null,
          completedAt: "2026-06-10T00:00:01.000Z",
        },
      },
    } as unknown as Partial<WorkspaceState>);

    expect(workspace.runEvidence["run-valid"]).toMatchObject({ status: "failed", artifacts: [] });
    expect(workspace.runEvidence["run-invalid"]).toBeUndefined();
    expect(workspace.runEvents["run-valid"]?.[0]?.payload).toMatchObject({
      command: "repo=[redacted-path]",
      opaqueHandle: "[redacted]",
    });
    expect(workspace.runEvents["run-invalid"]).toBeUndefined();
  });

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
