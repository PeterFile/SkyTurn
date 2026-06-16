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
  changeset: "workflow:changeset",
} as const;

export type WorkflowIpcErrorCode =
  | "INVALID_INPUT"
  | "UNKNOWN_PROJECT"
  | "UNKNOWN_SESSION"
  | "NON_EXECUTABLE_NODE"
  | "UNSAFE_WORKTREE_PATH";

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

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

function isNonEmptyString(value: unknown): boolean {
  return typeof value === "string" && value.trim().length > 0;
}
