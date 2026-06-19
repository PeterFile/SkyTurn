import { describe, expect, it } from "vitest";

import {
  convertPlanToCanvas,
  createFastCanvasSession,
  createPlanSession,
} from "./index";

describe("canvas session factory", () => {
  it("creates a fast session with a Hermes-orchestrated canvas graph", () => {
    const session = createFastCanvasSession({
      projectId: "project-1",
      goal: "Ship the smallest runnable shell",
      createdAt: "2026-06-10T00:00:00.000Z",
    });

    expect(session.kind).toBe("canvas");
    expect(session.mode).toBe("fast");
    expect(session.hermesPlannerSessionId).toBe("hermes-planner-fast-202606100000");
    expect(session.plannerNodeId).toBe("node-1");
    expect(session.nodes.map((node) => node.title)).toEqual([
      "Plan workflow cards",
    ]);
    expect(session.nodes.map((node) => node.status)).toEqual(["running"]);
    expect(session.nodes[0]?.agent).toBe("hermes");
    expect(session.nodes[0]?.runtime).toEqual({
      phase: "Planning",
      message: "正在拆解任务",
      action: "calling workflow-card tools",
    });
    expect(session.nodes[0]?.display).toEqual({
      agentLabel: "Hermes",
      meta: ["workflow-card-tools", "TSK-0001"],
    });
    expect(session.target).toEqual({
      executionTarget: "current_branch",
      selectedBranch: "HEAD",
    });
    expect(session.nodes.every((node) => node.worktree.branchName === "HEAD")).toBe(true);
    expect(session.nodes[0]?.context.relatedTasks).toContain("createWorkflowCard");
    expect(session.edges).toEqual([]);
  });

  it("uses selected current branch metadata without inventing a managed worktree", () => {
    const session = createFastCanvasSession({
      projectId: "project-1",
      goal: "Ship on selected branch",
      createdAt: "2026-06-10T00:00:00.000Z",
      target: {
        executionTarget: "current_branch",
        selectedBranch: "feature/runtime-target",
        baseRef: "main",
      },
    });

    expect(session.target).toEqual({
      executionTarget: "current_branch",
      selectedBranch: "feature/runtime-target",
    });
    expect(session.nodes[0]?.worktree).toMatchObject({
      path: ".",
      branchName: "feature/runtime-target",
      baseCommit: "feature/runtime-target",
      executionTarget: "current_branch",
      selectedBranch: "feature/runtime-target",
    });
    expect(session.nodes[0]?.worktree.worktreeId).toBeUndefined();
  });

  it("records new worktree candidate metadata without claiming it was created", () => {
    const session = createFastCanvasSession({
      projectId: "project-1",
      goal: "Try candidate worktree",
      createdAt: "2026-06-10T00:00:00.000Z",
      target: {
        executionTarget: "new_worktree",
        selectedBranch: "main",
        baseRef: "origin/main",
      },
    });

    expect(session.target).toEqual({
      executionTarget: "new_worktree",
      selectedBranch: "main",
      baseRef: "origin/main",
    });
    expect(session.nodes[0]?.worktree).toMatchObject({
      path: ".",
      branchName: "main",
      baseCommit: "origin/main",
      executionTarget: "new_worktree",
      selectedBranch: "main",
      baseRef: "origin/main",
      worktreeId: "worktree-fast-202606100000-node-1",
      variantId: "variant-fast-202606100000-node-1",
    });
    expect(session.nodes[0]?.worktree.realPath).toBeUndefined();
    expect(session.nodes[0]?.worktree.gitdir).toBeUndefined();
  });

  it("keeps plan sessions in a Markdown planning state until confirmed", () => {
    const session = createPlanSession({
      projectId: "project-1",
      goal: "Design a task workflow",
      createdAt: "2026-06-10T00:00:00.000Z",
    });

    expect(session.kind).toBe("plan");
    expect(session.plan.requirements).toContain("## Requirements");
    expect(session.nodes).toHaveLength(0);
  });

  it("converts plan tasks into compact canvas nodes with dependencies", () => {
    const plan = createPlanSession({
      projectId: "project-1",
      goal: "Plan then execute",
      createdAt: "2026-06-10T00:00:00.000Z",
    });

    const canvas = convertPlanToCanvas(plan);

    expect(canvas.kind).toBe("canvas");
    expect(canvas.mode).toBe("plan");
    expect(canvas.hermesPlannerSessionId).toBe("hermes-planner-plan-202606100000");
    expect(canvas.plannerNodeId).toBe("node-1");
    expect(canvas.nodes.map((node) => node.title)).toEqual([
      "Confirm requirements",
      "Implement canvas shell",
      "Verify completion evidence",
    ]);
    expect(canvas.nodes[1]?.position.x).toBeGreaterThanOrEqual((canvas.nodes[0]?.position.x ?? 0) + 560);
    expect(canvas.nodes[2]?.position.x).toBeGreaterThanOrEqual((canvas.nodes[1]?.position.x ?? 0) + 560);
    expect(canvas.edges).toEqual([
      { id: "edge-node-1-node-2", source: "node-1", target: "node-2" },
      { id: "edge-node-2-node-3", source: "node-2", target: "node-3" },
    ]);
  });
});
