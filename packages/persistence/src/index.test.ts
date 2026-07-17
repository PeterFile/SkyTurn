import { describe, expect, it } from "vitest";

import { parsePlanBootstrapSession } from "@skyturn/project-core";
import { normalizeWorkspaceState, type WorkspaceState } from "./index.js";

describe("workspace persistence compatibility", () => {
  it("hydrates legacy Plan sessions with usable staged defaults", () => {
    const workspace = normalizeWorkspaceState({
      sessions: [{
        id: "plan-legacy",
        projectId: "project-1",
        title: "Legacy plan",
        goal: "Keep the old plan usable",
        mode: "plan",
        kind: "plan",
        createdAt: "2026-06-10T00:00:00.000Z",
        updatedAt: "2026-06-10T00:00:00.000Z",
        plan: {
          requirements: "# Requirements\n\nLegacy.",
          design: "# Design\n\nLegacy.",
          tasks: "# Tasks\n\n- [ ] Legacy.",
        },
        nodes: [],
        edges: [],
        activeNodeId: null,
      }],
    } as unknown as Partial<WorkspaceState>);

    const session = workspace.sessions[0];
    expect(session?.kind).toBe("plan");
    if (session?.kind !== "plan") return;
    expect(session.plannerConversationId).toBe("hermes-plan-plan-legacy");
    expect(session.stateVersion).toBe(0);
    expect(session.conversationStarted).toBe(false);
    expect(session.activeStage).toBe("requirements");
    expect(session.stages.requirements).toMatchObject({
      status: "ready",
      accepted: false,
      checkpoints: [],
      lastRunId: null,
    });
  });

  it.each([Number.NaN, Number.POSITIVE_INFINITY, -1, 1.5, "4"])(
    "sanitizes invalid legacy Plan state versions",
    (stateVersion) => {
      const workspace = normalizeWorkspaceState({
        sessions: [{
          id: "plan-version",
          projectId: "project-1",
          title: "Version",
          goal: "Normalize",
          mode: "plan",
          kind: "plan",
          stateVersion,
          createdAt: "2026-07-16T00:00:00.000Z",
          updatedAt: "2026-07-16T00:00:00.000Z",
          plan: { requirements: "", design: "", tasks: "" },
        }],
      } as unknown as Partial<WorkspaceState>);

      expect(workspace.sessions[0]?.kind).toBe("plan");
      expect((workspace.sessions[0] as { stateVersion?: unknown }).stateVersion).toBe(0);
    },
  );

  it("fails closed interrupted Plan work and bounds stage checkpoints", () => {
    const workspace = normalizeWorkspaceState({
      sessions: [{
        id: "plan-interrupted",
        projectId: "project-1",
        title: "Interrupted plan",
        goal: "Recover safely",
        mode: "plan",
        kind: "plan",
        target: { executionTarget: "current_branch", selectedBranch: "main" },
        createdAt: "2026-06-10T00:00:00.000Z",
        updatedAt: "2026-06-10T00:00:00.000Z",
        plan: { requirements: "# Requirements", design: "", tasks: "" },
        activeStage: "requirements",
        plannerConversationId: "raw-acp-session-must-not-survive",
        conversationStarted: true,
        stages: {
          requirements: {
            status: "revising",
            accepted: true,
            draft: "partial secret draft",
            error: null,
            runId: "run-old",
            lastRunId: "run-before-old",
            operation: "revise",
            checkpoints: Array.from({ length: 25 }, (_, index) => `revision-${index}`),
          },
        },
        nodes: [],
        edges: [],
        activeNodeId: null,
      }],
    } as unknown as Partial<WorkspaceState>);

    const session = workspace.sessions[0];
    expect(session?.kind).toBe("plan");
    if (session?.kind !== "plan") return;
    expect(session.plannerConversationId).toBe("hermes-plan-plan-interrupted");
    expect(session.stages.requirements).toMatchObject({
      status: "failed",
      accepted: false,
      draft: "",
      runId: null,
      operation: "revise",
      lastRunId: "run-before-old",
    });
    expect(session.stages.requirements.error).toContain("interrupted");
    expect(session.stages.requirements.checkpoints).toEqual(
      Array.from({ length: 20 }, (_, index) => `revision-${index + 5}`),
    );
  });

  it("drops malformed and oversized legacy workspace checkpoints before applying the 20-entry cap", () => {
    const workspace = normalizeWorkspaceState({
      sessions: [{
        id: "plan-checkpoint-compatibility",
        projectId: "project-1",
        title: "Checkpoint compatibility",
        goal: "Bound legacy local state",
        mode: "plan",
        kind: "plan",
        createdAt: "2026-07-16T00:00:00.000Z",
        updatedAt: "2026-07-16T00:00:00.000Z",
        plan: { requirements: "# Requirements", design: "", tasks: "" },
        stages: {
          requirements: {
            status: "ready",
            checkpoints: [
              ...Array.from({ length: 25 }, (_, index) => `revision-${index}`),
              1,
              "",
              " \n\t ",
              "x".repeat(2_000_001),
            ],
          },
          design: { status: "pending", checkpoints: "invalid" },
        },
      }],
    } as unknown as Partial<WorkspaceState>);

    const session = workspace.sessions[0];
    expect(session?.kind).toBe("plan");
    if (session?.kind !== "plan") return;
    expect(session.stages.requirements.checkpoints).toEqual(
      Array.from({ length: 20 }, (_, index) => `revision-${index + 5}`),
    );
    expect(session.stages.design.checkpoints).toEqual([]);
  });

  it("does not restore whitespace-only Plan Markdown as ready or accepted", () => {
    const workspace = normalizeWorkspaceState({
      sessions: [{
        id: "plan-whitespace",
        projectId: "project-1",
        title: "Whitespace plan",
        goal: "Reject blank Tasks",
        mode: "plan",
        kind: "plan",
        createdAt: "2026-06-10T00:00:00.000Z",
        updatedAt: "2026-06-10T00:00:00.000Z",
        plan: {
          requirements: "# Requirements",
          design: "# Design",
          tasks: " \n\t ",
        },
        stages: {
          tasks: {
            status: "ready",
            accepted: true,
            checkpoints: [],
          },
        },
      }],
    } as unknown as Partial<WorkspaceState>);

    const session = workspace.sessions[0];
    expect(session?.kind).toBe("plan");
    if (session?.kind !== "plan") return;
    expect(session.stages.tasks).toMatchObject({ status: "pending", accepted: false });
  });

  it("preserves acceptance only for failed revisions with existing Markdown", () => {
    const normalizeFailure = (operation: "generate" | "revise", markdown: string) => {
      const workspace = normalizeWorkspaceState({
        sessions: [{
          id: `plan-failed-${operation}`,
          projectId: "project-1",
          title: "Failed Plan",
          goal: "Retry safely",
          mode: "plan",
          kind: "plan",
          createdAt: "2026-07-16T00:00:00.000Z",
          updatedAt: "2026-07-16T00:00:00.000Z",
          plan: { requirements: markdown, design: "", tasks: "" },
          stages: {
            requirements: {
              status: "failed",
              accepted: true,
              draft: "",
              error: "Hermes ACP prompt failed.",
              runId: null,
              lastRunId: "run-failed",
              operation,
              checkpoints: markdown.trim() ? ["requirements-v0"] : [],
            },
          },
        }],
      } as unknown as Partial<WorkspaceState>);
      const session = workspace.sessions[0];
      expect(session?.kind).toBe("plan");
      if (session?.kind !== "plan") throw new Error("Plan session did not normalize.");
      return session.stages.requirements;
    };

    expect(normalizeFailure("revise", "# Requirements")).toMatchObject({
      status: "failed",
      accepted: true,
      operation: "revise",
    });
    expect(normalizeFailure("generate", "# Requirements")).toMatchObject({
      status: "failed",
      accepted: false,
      operation: "generate",
    });
    expect(normalizeFailure("revise", " \n\t ")).toMatchObject({
      status: "failed",
      accepted: false,
      operation: "revise",
    });
  });

  it.each([
    {
      name: "failed without an operation becomes ready",
      markdown: "# Requirements",
      raw: { status: "failed", accepted: true, operation: null, error: "stale", lastRunId: "" },
      expected: { status: "ready", accepted: true, operation: null, error: null, lastRunId: null },
    },
    {
      name: "ready clears stale failure fields",
      markdown: "# Requirements",
      raw: { status: "ready", accepted: true, operation: "generate", error: "stale" },
      expected: { status: "ready", accepted: true, operation: null, error: null },
    },
    {
      name: "pending clears stale failure fields",
      markdown: "",
      raw: { status: "pending", accepted: true, operation: "revise", error: "stale" },
      expected: { status: "pending", accepted: false, operation: null, error: null },
    },
    {
      name: "interrupted generating infers generate",
      markdown: "",
      raw: { status: "generating", accepted: true, operation: null, error: null },
      expected: {
        status: "failed",
        accepted: false,
        operation: "generate",
        error: "Plan generation was interrupted. Retry to continue.",
      },
    },
    {
      name: "interrupted revising infers revise",
      markdown: "# Requirements",
      raw: { status: "revising", accepted: true, operation: "generate", error: null },
      expected: {
        status: "failed",
        accepted: false,
        operation: "revise",
        error: "Plan generation was interrupted. Retry to continue.",
      },
    },
    {
      name: "accepted failed generate loses acceptance",
      markdown: "# Requirements",
      raw: { status: "failed", accepted: true, operation: "generate", error: "generate failed" },
      expected: { status: "failed", accepted: false, operation: "generate", error: "generate failed" },
    },
    {
      name: "accepted failed revise keeps acceptance with Markdown",
      markdown: "# Requirements",
      raw: { status: "failed", accepted: true, operation: "revise", error: "revise failed" },
      expected: { status: "failed", accepted: true, operation: "revise", error: "revise failed" },
    },
    {
      name: "accepted failed revise loses acceptance without Markdown",
      markdown: "",
      raw: { status: "failed", accepted: true, operation: "revise", error: "revise failed" },
      expected: { status: "failed", accepted: false, operation: "revise", error: "revise failed" },
    },
    {
      name: "failed with an invalid operation becomes pending",
      markdown: "",
      raw: { status: "failed", accepted: true, operation: "invalid", error: "stale" },
      expected: { status: "pending", accepted: false, operation: null, error: null },
    },
  ])("round-trips canonical Plan stage state: $name", ({ markdown, raw, expected }) => {
    const workspace = normalizeWorkspaceState({
      sessions: [{
        id: "plan-normalized-stage",
        projectId: "project-1",
        title: "Normalized stage",
        goal: "Always satisfy strict bootstrap parsing",
        mode: "plan",
        kind: "plan",
        target: { executionTarget: "current_branch", selectedBranch: "main" },
        createdAt: "2026-07-16T00:00:00.000Z",
        updatedAt: "2026-07-16T00:00:00.000Z",
        plan: { requirements: markdown, design: "", tasks: "" },
        stages: { requirements: { ...raw, draft: "stale draft", runId: "stale-run", checkpoints: [] } },
      }],
    } as unknown as Partial<WorkspaceState>);
    const session = workspace.sessions[0];
    expect(session?.kind).toBe("plan");
    if (session?.kind !== "plan") throw new Error("Plan session did not normalize.");

    expect(() => parsePlanBootstrapSession(session)).not.toThrow();
    expect(session.stages.requirements).toMatchObject({
      ...expected,
      draft: "",
      runId: null,
    });
  });

  it.each([
    {
      name: "keeps Markdown at the strict maximum",
      markdown: "x".repeat(2_000_000),
    },
    {
      name: "truncates Markdown above the strict maximum",
      markdown: "x".repeat(2_000_001),
    },
  ])("round-trips accepted Plan Markdown: $name", ({ markdown }) => {
    const workspace = normalizeWorkspaceState({
      sessions: [{
        id: "plan-markdown-limit",
        projectId: "project-1",
        title: "Markdown limit",
        goal: "Keep legacy content parseable",
        mode: "plan",
        kind: "plan",
        target: { executionTarget: "current_branch", selectedBranch: "main" },
        createdAt: "2026-07-16T00:00:00.000Z",
        updatedAt: "2026-07-16T00:00:00.000Z",
        plan: { requirements: markdown, design: "", tasks: "" },
        stages: { requirements: { status: "ready", accepted: true, checkpoints: [] } },
      }],
    } as unknown as Partial<WorkspaceState>);
    const session = workspace.sessions[0];
    expect(session?.kind).toBe("plan");
    if (session?.kind !== "plan") throw new Error("Plan session did not normalize.");

    expect(() => parsePlanBootstrapSession(session)).not.toThrow();
    expect(session.plan.requirements).toBe(markdown.slice(0, 2_000_000));
    expect(session.stages.requirements.accepted).toBe(true);
  });

  it.each([
    {
      name: "clears Design material when Requirements is unaccepted",
      plan: { requirements: "# Requirements", design: "# Design", tasks: "" },
      stages: {
        requirements: { status: "ready", accepted: false, checkpoints: ["requirements-v0"] },
        design: { status: "ready", accepted: true, checkpoints: ["design-v0"] },
      },
      accepted: { requirements: false, design: false, tasks: false },
      checkpoints: { requirements: ["requirements-v0"], design: [], tasks: [] },
      stageMatches: {},
    },
    {
      name: "clears Design material when Requirements is missing",
      plan: { requirements: "", design: "# Design", tasks: "" },
      stages: {
        requirements: { status: "pending", accepted: true, checkpoints: ["requirements-v0"] },
        design: { status: "ready", accepted: true, checkpoints: ["design-v0"] },
      },
      accepted: { requirements: false, design: false, tasks: false },
      checkpoints: { requirements: ["requirements-v0"], design: [], tasks: [] },
      stageMatches: {},
    },
    {
      name: "clears Tasks and Design material when Requirements is unaccepted",
      plan: { requirements: "# Requirements", design: "# Design", tasks: "# Tasks" },
      stages: {
        requirements: { status: "ready", accepted: false, checkpoints: [] },
        design: { status: "ready", accepted: true, checkpoints: ["design-v0"] },
        tasks: { status: "ready", accepted: true, checkpoints: ["tasks-v0"] },
      },
      accepted: { requirements: false, design: false, tasks: false },
      checkpoints: { requirements: [], design: [], tasks: [] },
      stageMatches: {},
    },
    {
      name: "clears Tasks material when Design is unaccepted",
      plan: { requirements: "# Requirements", design: "# Design", tasks: "# Tasks" },
      stages: {
        requirements: { status: "ready", accepted: true, checkpoints: ["requirements-v0"] },
        design: { status: "ready", accepted: false, checkpoints: ["design-v0"] },
        tasks: { status: "ready", accepted: true, checkpoints: ["tasks-v0"] },
      },
      accepted: { requirements: true, design: false, tasks: false },
      checkpoints: { requirements: ["requirements-v0"], design: ["design-v0"], tasks: [] },
      stageMatches: {},
    },
    {
      name: "preserves a valid accepted chain",
      plan: { requirements: "# Requirements", design: "# Design", tasks: "# Tasks" },
      stages: {
        requirements: { status: "ready", accepted: true, checkpoints: ["requirements-v0"] },
        design: { status: "ready", accepted: true, checkpoints: ["design-v0"] },
        tasks: { status: "ready", accepted: true, checkpoints: ["tasks-v0"] },
      },
      accepted: { requirements: true, design: true, tasks: true },
      checkpoints: {
        requirements: ["requirements-v0"],
        design: ["design-v0"],
        tasks: ["tasks-v0"],
      },
      stageMatches: {},
    },
    {
      name: "clears failed-revise Design material without changing failure normalization",
      plan: { requirements: "# Requirements", design: "# Design", tasks: "" },
      stages: {
        requirements: { status: "ready", accepted: false, checkpoints: [] },
        design: {
          status: "failed",
          accepted: true,
          operation: "revise",
          error: "revise failed",
          checkpoints: ["design-v0"],
        },
      },
      accepted: { requirements: false, design: false, tasks: false },
      checkpoints: { requirements: [], design: [], tasks: [] },
      stageMatches: { design: { status: "failed", operation: "revise", error: "revise failed" } },
    },
    {
      name: "clears failed-revise Tasks material when Design failed generation",
      plan: { requirements: "# Requirements", design: "# Design", tasks: "# Tasks" },
      stages: {
        requirements: { status: "ready", accepted: true, checkpoints: [] },
        design: {
          status: "failed",
          accepted: true,
          operation: "generate",
          error: "generate failed",
          checkpoints: ["design-v0"],
        },
        tasks: {
          status: "failed",
          accepted: true,
          operation: "revise",
          error: "revise failed",
          checkpoints: ["tasks-v0"],
        },
      },
      accepted: { requirements: true, design: false, tasks: false },
      checkpoints: { requirements: [], design: ["design-v0"], tasks: [] },
      stageMatches: {
        design: { status: "failed", operation: "generate", error: "generate failed" },
        tasks: { status: "failed", operation: "revise", error: "revise failed" },
      },
    },
  ])("round-trips canonical Plan dependencies: $name", ({ plan, stages, accepted, checkpoints, stageMatches }) => {
    const workspace = normalizeWorkspaceState({
      sessions: [{
        id: "plan-dependencies",
        projectId: "project-1",
        title: "Plan dependencies",
        goal: "Keep legacy dependencies parseable",
        mode: "plan",
        kind: "plan",
        target: { executionTarget: "current_branch", selectedBranch: "main" },
        createdAt: "2026-07-16T00:00:00.000Z",
        updatedAt: "2026-07-16T00:00:00.000Z",
        plan,
        stages,
      }],
    } as unknown as Partial<WorkspaceState>);
    const session = workspace.sessions[0];
    expect(session?.kind).toBe("plan");
    if (session?.kind !== "plan") throw new Error("Plan session did not normalize.");

    const parsed = parsePlanBootstrapSession(session);
    expect(parsed.snapshot.accepted).toEqual(accepted);
    expect(parsed.snapshot.checkpoints).toEqual(checkpoints);
    for (const [stage, expected] of Object.entries(stageMatches)) {
      expect(session.stages[stage as keyof typeof session.stages]).toMatchObject(expected);
    }
  });

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
