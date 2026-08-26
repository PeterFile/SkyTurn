import type { CanvasNode, WorkflowLoopNextAction, WorkflowLoopNextActionKind } from "@skyturn/project-core";

export interface NextActionNavigation {
  targetNodeId: string;
  modalTab: "Changes" | null;
}

export interface NextSafeActionHint {
  label: string;
  reason: string;
  navigation: NextActionNavigation | null;
}

const labels: Record<WorkflowLoopNextActionKind, string> = {
  execute_lane: "Open next task",
  wait_for_checks: "Wait for checks",
  fix_failed_checks: "Review failed checks",
  merge_pull_request: "Review merge-ready changes",
  rollback_node: "Review rollback target",
  request_repair: "Review repair target",
  request_variant: "Review variant target",
  blocked: "Workflow blocked",
  none: "No action",
};

export function buildNextSafeActionHint(
  action: WorkflowLoopNextAction,
  nodes: readonly CanvasNode[],
): NextSafeActionHint | null {
  if (action.kind === "none") return null;
  return {
    label: labels[action.kind],
    reason: action.reason,
    navigation: resolveNextActionNavigation(action, nodes),
  };
}

export function resolveNextActionNavigation(
  action: WorkflowLoopNextAction,
  nodes: readonly CanvasNode[],
): NextActionNavigation | null {
  if (!action.laneId || action.kind === "wait_for_checks" || action.kind === "blocked" || action.kind === "none") {
    return null;
  }
  const node = nodes.find((candidate) => candidate.id === action.laneId);
  if (!node || node.rollbackStatus === "inactive" || node.rollbackStatus === "rolled_back") return null;
  return {
    targetNodeId: node.id,
    modalTab: action.kind === "fix_failed_checks" || action.kind === "merge_pull_request" ? "Changes" : null,
  };
}
