import { describe, expect, it } from "vitest";

import type { CanvasSession } from "@skyturn/project-core";

import { addRequirementPlanningNode } from "./composer.js";

describe("canvas composer", () => {
  it("turns workflow input into a running Hermes planning card", () => {
    const result = addRequirementPlanningNode(makeSession(), "Add audit logging to the run bridge", {
      projectName: "SkyTurn",
      now: "2026-06-14T04:00:00.000Z",
    });

    const node = result.node;
    expect(node.agent).toBe("hermes");
    expect(node.status).toBe("running");
    expect(node.progress).toBe("Calling workflow-card tools");
    expect(node.context.brief).toBe("Add audit logging to the run bridge");
    expect(node.context.relatedTasks).toBe("createWorkflowCard, updateWorkflowCard, deleteWorkflowCard");
    expect(node.context.dependencies).toEqual([]);
    expect(result.session.activeNodeId).toBe(node.id);
    expect(result.session.nodes).toContain(node);
  });

  it("reuses one Hermes planner identity and visible root card for repeated workflow input", () => {
    const first = addRequirementPlanningNode(makeSession(), "Add audit logging", {
      projectName: "SkyTurn",
      now: "2026-06-14T04:00:00.000Z",
    });
    const second = addRequirementPlanningNode(first.session, "Add retry evidence", {
      projectName: "SkyTurn",
      now: "2026-06-14T04:01:00.000Z",
    });

    expect(first.session.hermesPlannerSessionId).toBe("hermes-planner-session-1");
    expect(second.session.hermesPlannerSessionId).toBe(first.session.hermesPlannerSessionId);
    expect(second.node.id).toBe(first.node.id);
    expect(second.node.runId).not.toBe(first.node.runId);
    expect(second.node.context.brief).toBe("Add retry evidence");
    expect(second.session.nodes.filter((node) => node.agent === "hermes" && node.context.dependencies.length === 0)).toHaveLength(1);
  });
});

function makeSession(): CanvasSession {
  return {
    id: "session-1",
    projectId: "project-1",
    title: "Workflow",
    goal: "Build workflow",
    mode: "fast",
    kind: "canvas",
    createdAt: "2026-06-14T03:00:00.000Z",
    updatedAt: "2026-06-14T03:00:00.000Z",
    activeNodeId: "node-1",
    edges: [],
    nodes: [],
  } as CanvasSession;
}
