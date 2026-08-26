import { describe, expect, it } from "vitest";

import type { CanvasNode, WorkflowLoopNextAction } from "@skyturn/project-core";

import { buildNextSafeActionHint, resolveNextActionNavigation } from "./nextSafeAction.js";

const longLaneId = `lane-${"a".repeat(250)}`;
const nodes = [
  { id: "node-1" } as CanvasNode,
  { id: longLaneId } as CanvasNode,
];

function action(input: Partial<WorkflowLoopNextAction> = {}): WorkflowLoopNextAction {
  return { kind: "execute_lane", reason: "Run the next lane.", laneId: "node-1", ...input };
}

describe("next safe action hint", () => {
  it("hides a none action", () => {
    expect(buildNextSafeActionHint(action({ kind: "none" }), nodes)).toBeNull();
  });

  it.each([
    ["wait_for_checks", "Wait for checks"],
    ["blocked", "Workflow blocked"],
  ] as const)("shows %s without navigation", (kind, label) => {
    expect(buildNextSafeActionHint(action({ kind }), nodes)).toEqual({
      label,
      reason: "Run the next lane.",
      navigation: null,
    });
  });

  it("keeps a missing lane target non-actionable", () => {
    expect(buildNextSafeActionHint(action({ laneId: "missing-node" }), nodes)).toMatchObject({
      label: "Open next task",
      navigation: null,
    });
  });

  it.each(["inactive", "rolled_back"] as const)(
    "keeps a %s lane target non-actionable",
    (rollbackStatus) => {
      const inactiveNodes = [{ id: "node-1", rollbackStatus } as CanvasNode];
      expect(buildNextSafeActionHint(action(), inactiveNodes)).toMatchObject({
        label: "Open next task",
        navigation: null,
      });
    },
  );

  it("navigates to a canonical lane ID longer than 200 characters", () => {
    expect(resolveNextActionNavigation(action({ laneId: longLaneId }), nodes)).toEqual({
      targetNodeId: longLaneId,
      modalTab: null,
    });
  });

  it.each(["fix_failed_checks", "merge_pull_request"] as const)(
    "opens existing Changes for %s without executing the action",
    (kind) => {
      expect(buildNextSafeActionHint(action({ kind }), nodes)).toEqual({
        label: kind === "fix_failed_checks" ? "Review failed checks" : "Review merge-ready changes",
        reason: "Run the next lane.",
        navigation: { targetNodeId: "node-1", modalTab: "Changes" },
      });
    },
  );
});
