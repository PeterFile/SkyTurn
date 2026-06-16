import type { CanvasNode, NodeRuntimeState } from "@skyturn/project-core";
import { describe, expect, it } from "vitest";

import { agentIdentityForNode, canUseAgentNodeActions, nodeFooterForNode } from "./nodeDisplay.js";

describe("canvas node display helpers", () => {
  it("renders waiting user decisions as non-executable input nodes", () => {
    const node = makeNode({
      nodeKind: "user_decision",
      executable: false,
      userDecision: {
        decisionId: "decision-1",
        prompt: "Continue?",
        options: ["Continue", "Abort"],
        reason: "Risk changed.",
        status: "waiting_input",
      },
    });

    expect(agentIdentityForNode(node)).toBe("Waiting input");
    expect(nodeFooterForNode(node, runtime)).toEqual({ primary: "Waiting input" });
    expect(canUseAgentNodeActions(node)).toBe(false);
  });

  it("renders answered user decisions as completed decision state", () => {
    const node = makeNode({
      status: "completed",
      nodeKind: "user_decision",
      executable: false,
      userDecision: {
        decisionId: "decision-1",
        prompt: "Continue?",
        options: ["Continue", "Abort"],
        reason: "Risk changed.",
        status: "answered",
        selectedOption: "Continue",
        action: "continue",
      },
    });

    expect(agentIdentityForNode(node)).toBe("Decision answered");
    expect(nodeFooterForNode(node, { ...runtime, phase: "Completed" })).toEqual({
      primary: "Decision set",
      secondary: "Continue",
    });
    expect(canUseAgentNodeActions(node)).toBe(false);
  });

  it("disables agent actions when trusted runtime policy is non-executable", () => {
    const node = makeNode({
      runtimePolicy: {
        source: "workflow_projection",
        trusted: true,
        executable: false,
        sandbox: "read-only",
        sideEffects: [],
        reason: "Projection node is not executable.",
      },
    });

    expect(canUseAgentNodeActions(node)).toBe(false);
  });
});

const runtime: NodeRuntimeState = {
  phase: "Queued",
  message: "waiting",
  action: "Waiting for scheduler",
};

function makeNode(overrides: Partial<CanvasNode>): CanvasNode {
  return {
    id: "node-1",
    title: "Decision",
    agent: "hermes",
    progress: "Waiting for user decision",
    status: "pending",
    position: { x: 0, y: 0 },
    runId: "run-node-1",
    changesetId: "changeset-node-1",
    output: [],
    worktree: {
      path: ".",
      branchName: "skyturn/session/node-1",
      baseCommit: "base",
    },
    context: {
      brief: "Decision",
      sessionGoal: "Build",
      relatedRequirements: "",
      relatedDesign: "",
      relatedTasks: "",
      dependencies: [],
      constraints: [],
    },
    ...overrides,
  };
}
