import { describe, expect, it } from "vitest";

import {
  convertPlanToCanvas,
  createFastCanvasSession,
  createPlanSession,
} from "./index";
import * as planner from "./index";

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
    }, { randomUUID: () => "11111111-1111-4111-8111-111111111111" });

    expect(session.kind).toBe("plan");
    expect(session.plan).toEqual({ requirements: "", design: "", tasks: "" });
    expect(session.activeStage).toBe("requirements");
    expect(session.plannerConversationId).toBe(
      "hermes-plan-plan-202606100000-11111111-1111-4111-8111-111111111111",
    );
    expect(session.conversationStarted).toBe(false);
    expect(session.stages).toEqual({
      requirements: {
        status: "pending",
        accepted: false,
        draft: "",
        error: null,
        runId: null,
        lastRunId: null,
        operation: null,
        checkpoints: [],
      },
      design: {
        status: "pending",
        accepted: false,
        draft: "",
        error: null,
        runId: null,
        lastRunId: null,
        operation: null,
        checkpoints: [],
      },
      tasks: {
        status: "pending",
        accepted: false,
        draft: "",
        error: null,
        runId: null,
        lastRunId: null,
        operation: null,
        checkpoints: [],
      },
    });
    expect(session.nodes).toHaveLength(0);
  });

  it("creates distinct Plan identities for the same creation timestamp", () => {
    const createdAt = "2026-06-10T00:00:00.000Z";
    const ids = [
      "11111111-1111-4111-8111-111111111111",
      "22222222-2222-4222-8222-222222222222",
    ];

    const first = createPlanSession({ projectId: "project-1", goal: "First", createdAt }, {
      randomUUID: () => ids.shift()!,
    });
    const second = createPlanSession({ projectId: "project-1", goal: "Second", createdAt }, {
      randomUUID: () => ids.shift()!,
    });

    expect(first.id).not.toBe(second.id);
    expect(first.id).toBe("plan-202606100000-11111111-1111-4111-8111-111111111111");
    expect(second.id).toBe("plan-202606100000-22222222-2222-4222-8222-222222222222");
    expect(first.plannerConversationId).not.toBe(second.plannerConversationId);
  });

  it("converts plan tasks into compact canvas nodes with dependencies", () => {
    const plan = createPlanSession({
      projectId: "project-1",
      goal: "Plan then execute",
      createdAt: "2026-06-10T00:00:00.000Z",
    }, { randomUUID: () => "11111111-1111-4111-8111-111111111111" });

    const canvas = convertPlanToCanvas(plan);

    expect(canvas.kind).toBe("canvas");
    expect(canvas.mode).toBe("plan");
    expect(canvas.hermesPlannerSessionId).toBe(
      "hermes-planner-plan-202606100000-11111111-1111-4111-8111-111111111111",
    );
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

  it("converts the edited plan text into node context", () => {
    const plan = createPlanSession({
      projectId: "project-1",
      goal: "Plan then execute edited draft",
      createdAt: "2026-06-10T00:00:00.000Z",
    });
    const editedPlan = {
      ...plan,
      plan: {
        requirements: "## Requirements\n\n- Edited requirement from user review.",
        design: "## Design\n\n- Edited design from user review.",
        tasks: "## Tasks\n\n- [ ] Edited task from user review.",
      },
    };

    const canvas = convertPlanToCanvas(editedPlan);

    expect(canvas.nodes[1]?.context.relatedRequirements).toContain("Edited requirement");
    expect(canvas.nodes[1]?.context.relatedDesign).toContain("Edited design");
    expect(canvas.nodes[1]?.context.relatedTasks).toContain("Edited task");
  });

  it("formats the exact approved Plan as deterministic authoritative workflow input", () => {
    const format = Reflect.get(planner, "formatApprovedPlanWorkflowInput") as undefined | ((session: unknown) => string);
    expect(format).toBeTypeOf("function");
    if (!format) return;
    const session = createPlanSession({
      projectId: "project-1",
      goal: "Original goal, unchanged.",
      createdAt: "2026-07-17T00:00:00.000Z",
    }, { randomUUID: () => "11111111-1111-4111-8111-111111111111" });
    const approved = {
      ...session,
      plan: {
        requirements: "# Requirements\n\nExact requirement bytes.",
        design: "# Design\n\nExact design bytes.",
        tasks: "# Tasks\n\n- [ ] Exact task bytes.",
      },
      stages: {
        requirements: { ...session.stages.requirements, status: "ready" as const, accepted: true },
        design: { ...session.stages.design, status: "ready" as const, accepted: true },
        tasks: { ...session.stages.tasks, status: "ready" as const, accepted: true },
      },
    };

    expect(format(approved)).toBe([
      "# Approved Plan",
      "",
      "## Goal",
      "Original goal, unchanged.",
      "",
      "## Requirements",
      "# Requirements\n\nExact requirement bytes.",
      "",
      "## Design",
      "# Design\n\nExact design bytes.",
      "",
      "## Tasks",
      "# Tasks\n\n- [ ] Exact task bytes.",
    ].join("\n"));
  });
});
