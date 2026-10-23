import type { CanvasSessionTab, WorkflowLoopNextAction } from "@skyturn/project-core";
import { buildNextSafeActionHint, resolveNextActionNavigation } from "./nextSafeAction.js";

export interface SessionAttentionHint {
  kind: "decision" | "manual" | "paused";
  label: string;
  description: string;
  targetNodeId: string | null;
}

const manualActionKinds = new Set<WorkflowLoopNextAction["kind"]>([
  "request_repair", "request_variant", "rollback_node", "fix_failed_checks", "merge_pull_request", "blocked",
]);

export function deriveSessionAttention(
  session: CanvasSessionTab,
  nextAction: WorkflowLoopNextAction | null,
): SessionAttentionHint | null {
  if (session.kind !== "canvas") return null;
  const decision = session.nodes.find((node) => (
    node.nodeKind === "user_decision" && node.userDecision?.status === "waiting_input" &&
    resolveNextActionNavigation({ kind: "blocked", laneId: node.id, reason: "" }, [node])
  ));
  if (decision) {
    return { kind: "decision", label: "Input", description: "Waiting for input", targetNodeId: decision.id };
  }
  if (nextAction && manualActionKinds.has(nextAction.kind)) {
    const hint = buildNextSafeActionHint(nextAction, session.nodes);
    const target = session.nodes.find((node) => node.id === hint?.navigation?.targetNodeId);
    if (hint && target && target.status !== "running" && target.nodeKind !== "user_decision") {
      return { kind: "manual", label: "Action", description: hint.label, targetNodeId: target.id };
    }
  }
  if (session.schedulingState?.status === "paused") {
    return { kind: "paused", label: "Paused", description: "Scheduling paused", targetNodeId: null };
  }
  return null;
}

export function SessionAttention({ attention, sessionTitle, projectId, sessionId, onNavigate }: {
  attention: SessionAttentionHint;
  sessionTitle: string;
  projectId: string;
  sessionId: string;
  onNavigate: () => void;
}) {
  return (
    <button
      type="button"
      className={`session-attention ${attention.kind}`}
      aria-label={`Open ${sessionTitle}: ${attention.description}`}
      title={attention.description}
      data-session-attention={attention.kind}
      data-project-id={projectId}
      data-session-id={sessionId}
      data-target-node-id={attention.targetNodeId ?? undefined}
      onClick={onNavigate}
    >{attention.label}</button>
  );
}
