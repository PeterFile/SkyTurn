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
    expect(session.nodes.every((node) => node.worktree.branchName.startsWith("skyturn/"))).toBe(true);
    expect(session.nodes[0]?.context.relatedTasks).toContain("createWorkflowCard");
    expect(session.edges).toEqual([]);
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
    expect(canvas.edges).toEqual([
      { id: "edge-node-1-node-2", source: "node-1", target: "node-2" },
      { id: "edge-node-2-node-3", source: "node-2", target: "node-3" },
    ]);
  });
});
