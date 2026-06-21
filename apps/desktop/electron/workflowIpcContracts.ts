export const WORKFLOW_IPC_ERROR_PREFIX = "SKYTURN_WORKFLOW_IPC_ERROR";

export const WORKFLOW_IPC_CHANNELS = {
  createSession: "workflow:createSession",
  appendUserInput: "workflow:appendUserInput",
  ledger: "workflow:ledger",
  applyIntent: "workflow:applyIntent",
  scheduleReady: "workflow:scheduleReady",
  recordRunResult: "workflow:recordRunResult",
  projection: "workflow:projection",
  events: "workflow:events",
  answerUserDecision: "workflow:userDecision:answer",
  worktreeCreate: "workflow:worktree:create",
  worktreeCompare: "workflow:worktree:compare",
  worktreeAdopt: "workflow:worktree:adopt",
  worktreeClean: "workflow:worktree:clean",
  deliveryCommit: "workflow:delivery:commit",
  deliveryPush: "workflow:delivery:push",
  pullRequestCreate: "workflow:pullRequest:create",
  changeset: "workflow:changeset",
  changesetReconcileFinal: "workflow:changeset:reconcileFinal",
} as const;

export type WorkflowIpcErrorCode =
  | "INVALID_INPUT"
  | "UNKNOWN_PROJECT"
  | "UNKNOWN_SESSION"
  | "NON_EXECUTABLE_NODE"
  | "UNSAFE_WORKTREE_PATH"
  | "DELIVERY_REJECTED"
  | "GH_UNAVAILABLE"
  | "AUTH_REQUIRED"
  | "REMOTE_HEAD_MISMATCH";

export function formatWorkflowIpcError(code: WorkflowIpcErrorCode, message: string): string {
  return `${WORKFLOW_IPC_ERROR_PREFIX}:${code}: ${message}`;
}

export function workflowIpcError(code: WorkflowIpcErrorCode, message: string): Error {
  return new Error(formatWorkflowIpcError(code, message));
}

export function normalizeWorkflowIpcError(error: unknown): Error {
  const message = error instanceof Error ? error.message : String(error);
  if (message.startsWith(`${WORKFLOW_IPC_ERROR_PREFIX}:`)) return new Error(message);
  return workflowIpcError("INVALID_INPUT", message);
}

export function isNonExecutableStartInput(input: unknown): boolean {
  if (!isRecord(input)) return false;
  if (input.nodeKind === "user_decision") return true;
  if (input.executable === false) return true;
  if (isRecord(input.runtimePolicy) && input.runtimePolicy.executable === false) return true;
  if (isRecord(input.display) && Array.isArray(input.display.meta) && input.display.meta.includes("user_decision")) {
    return true;
  }
  return false;
}

export function workflowStartInputError(input: unknown): WorkflowIpcErrorCode | null {
  if (!isRecord(input)) return "INVALID_INPUT";
  if (isNonExecutableStartInput(input)) return "NON_EXECUTABLE_NODE";
  const hasSessionId = isNonEmptyString(input.sessionId);
  const hasNodeId = isNonEmptyString(input.nodeId);
  if (hasSessionId !== hasNodeId) return "INVALID_INPUT";
  return null;
}

export function rejectMissingWorkflowProjectionNode(input: unknown, workflowEventCount: number): boolean {
  if (!isRecord(input)) return false;
  if (!isNonEmptyString(input.sessionId) || !isNonEmptyString(input.nodeId)) return false;
  return workflowEventCount > 0;
}

export interface TrustedPlannerRootStartStore {
  materializeCanvasSession(sessionId: string): unknown;
}

export function isTrustedPlannerRootStartInput(input: unknown, store: TrustedPlannerRootStartStore): boolean {
  if (!isRecord(input)) return false;
  if (!isNonEmptyString(input.sessionId) || !isNonEmptyString(input.nodeId)) return false;

  const canvasSession = store.materializeCanvasSession(input.sessionId);
  if (!isRecord(canvasSession)) return false;
  if (canvasSession.plannerNodeId !== input.nodeId) return false;
  if (!Array.isArray(canvasSession.nodes)) return false;

  const plannerNode = canvasSession.nodes.find((node) =>
    isRecord(node) && node.id === input.nodeId
  );
  if (!isRecord(plannerNode)) return false;
  if (plannerNode.agent !== "hermes") return false;
  if (plannerNode.nodeKind === "user_decision") return false;
  if (plannerNode.executable === false) return false;
  if (isRecord(plannerNode.runtimePolicy) && plannerNode.runtimePolicy.executable === false) return false;
  return plannerNode.status === "running" || plannerNode.status === "retrying";
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}
