import type { AgentKind, CanvasNode, NodeRuntimeState, NodeStatus } from "@skyturn/project-core";

const AGENT_LABELS: Record<AgentKind, string> = {
  hermes: "Hermes",
  codex: "Codex",
  gemini: "Gemini",
  "claude-code": "ClaudeCode",
  openclaw: "OpenClaw",
};

export function agentIdentityForNode(node: CanvasNode): string {
  if (node.nodeKind === "user_decision") {
    return node.userDecision?.status === "answered" ? "Decision answered" : "Waiting input";
  }
  return AGENT_LABELS[node.agent];
}

export function canUseAgentNodeActions(node: CanvasNode): boolean {
  return node.nodeKind !== "user_decision" && node.executable !== false && node.runtimePolicy?.executable !== false;
}

export function nodeFooterForNode(
  node: CanvasNode,
  runtime: NodeRuntimeState,
): { primary: string; secondary?: string } {
  if (node.nodeKind === "user_decision") {
    if (node.userDecision?.status === "answered") {
      return {
        primary: "Decision set",
        ...(node.userDecision.selectedOption ? { secondary: node.userDecision.selectedOption } : {}),
      };
    }
    return { primary: "Waiting input" };
  }

  return footerForStatus(node.status, runtime);
}

function footerForStatus(status: NodeStatus, runtime: NodeRuntimeState): { primary: string; secondary?: string } {
  switch (status) {
    case "pending":
      return { primary: "Queued" };
    case "running":
      return { primary: runtime.phase === "Think" ? "Thinking" : runtime.phase };
    case "retrying":
      return { primary: "Retrying" };
    case "completed":
      return { primary: "Verified", secondary: "Evidence ready" };
    case "failed":
      return { primary: "Attention" };
  }
}
