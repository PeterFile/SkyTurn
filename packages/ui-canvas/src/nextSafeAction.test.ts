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
    expect(resolveNextActionNavigation(action({ kind: "none" }), nodes)).toBeNull();
  });

  describe.each([
    ["blocked", "Locate blocked task", "Workflow blocked", null],
    ["wait_for_checks", "Review pending checks", "Wait for checks", "Changes"],
  ] as const)("%s navigation", (kind, label, passiveLabel, modalTab) => {
    const reason = "  Waiting on this exact task.\nKeep the original reason.  ";

    it.each(["node-1", longLaneId])("navigates only to the exact live target %s", (laneId) => {
      const nextAction = action({ kind, laneId, reason });
      const navigation = { targetNodeId: laneId, modalTab };

      expect(buildNextSafeActionHint(nextAction, nodes)).toEqual({ label, reason, navigation });
      expect(resolveNextActionNavigation(nextAction, nodes)).toEqual(navigation);
    });

    it("keeps an absent lane ID passive without choosing another node", () => {
      const nextAction: WorkflowLoopNextAction = { kind, reason };

      expect(buildNextSafeActionHint(nextAction, nodes)).toEqual({
        label: passiveLabel,
        reason,
        navigation: null,
      });
      expect(resolveNextActionNavigation(nextAction, nodes)).toBeNull();
    });

    it.each([undefined, "", "missing-node"])("keeps lane ID %s passive without a fallback", (laneId) => {
      const nextAction = action({ kind, laneId, reason });

      expect(buildNextSafeActionHint(nextAction, nodes)).toEqual({
        label: passiveLabel,
        reason,
        navigation: null,
      });
      expect(resolveNextActionNavigation(nextAction, nodes)).toBeNull();
    });

    it.each(["inactive", "rolled_back"] as const)("keeps a %s target passive without a fallback", (rollbackStatus) => {
      const nextAction = action({ kind, laneId: longLaneId, reason });
      const unavailableNodes = [nodes[0]!, { id: longLaneId, rollbackStatus } as CanvasNode];

      expect(buildNextSafeActionHint(nextAction, unavailableNodes)).toEqual({
        label: passiveLabel,
        reason,
        navigation: null,
      });
      expect(resolveNextActionNavigation(nextAction, unavailableNodes)).toBeNull();
    });
  });

  it.each([
    ["execute_lane", "Open next task"],
    ["request_repair", "Review repair target"],
    ["request_variant", "Review variant target"],
    ["rollback_node", "Review rollback target"],
  ] as const)("preserves selection-only navigation for %s", (kind, label) => {
    expect(buildNextSafeActionHint(action({ kind, laneId: longLaneId }), nodes)).toEqual({
      label,
      reason: "Run the next lane.",
      navigation: { targetNodeId: longLaneId, modalTab: null },
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
      expect(buildNextSafeActionHint(action({ kind, laneId: longLaneId }), nodes)).toEqual({
        label: kind === "fix_failed_checks" ? "Review failed checks" : "Review merge-ready changes",
        reason: "Run the next lane.",
        navigation: { targetNodeId: longLaneId, modalTab: "Changes" },
      });
    },
  );
});
