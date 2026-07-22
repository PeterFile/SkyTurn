export const WORKFLOW_IPC_ERROR_PREFIX = "SKYTURN_WORKFLOW_IPC_ERROR";

export const WORKFLOW_IPC_CHANNELS = {
  createSession: "workflow:createSession",
  finishPlan: "workflow:finishPlan",
  appendUserInput: "workflow:appendUserInput",
  ledger: "workflow:ledger",
  updateNodePosition: "workflow:nodePosition:update",
  projection: "workflow:projection",
  events: "workflow:events",
  checkpoints: "workflow:checkpoints",
  pendingInsertBefore: "workflow:insertBefore:pending",
  insertBefore: "workflow:insertBefore",
  rollbackEligibility: "workflow:rollback:eligibility",
  rollbackApply: "workflow:rollback:apply",
  repairCreate: "workflow:repair:create",
  variantCreate: "workflow:variant:create",
  answerUserDecision: "workflow:userDecision:answer",
  worktreeCreate: "workflow:worktree:create",
  worktreeCompare: "workflow:worktree:compare",
  worktreeAdopt: "workflow:worktree:adopt",
  worktreeClean: "workflow:worktree:clean",
  deliveryCommit: "workflow:delivery:commit",
  deliveryPush: "workflow:delivery:push",
  pullRequestCreate: "workflow:pullRequest:create",
  pullRequestChecks: "workflow:pullRequest:checks",
  pullRequestMerge: "workflow:pullRequest:merge",
  deliverySyncMain: "workflow:delivery:syncMain",
  changeset: "workflow:changeset",
  changesetReconcileFinal: "workflow:changeset:reconcileFinal",
} as const;

export interface WorkflowNodePositionUpdateInput {
  sessionId: string;
  updateId: string;
  nodeId: string;
  position: { x: number; y: number };
}

const MAX_CANVAS_COORDINATE = 1_000_000;

export function normalizeWorkflowNodePositionUpdate(input: unknown): WorkflowNodePositionUpdateInput {
  if (!isRecord(input)) throw workflowIpcError("INVALID_INPUT", "Node position input must be an object.");
  const sessionId = boundedIdentifier(input.sessionId, "sessionId");
  const updateId = boundedIdentifier(input.updateId, "updateId");
  const nodeId = boundedIdentifier(input.nodeId, "nodeId");
  if (!isRecord(input.position) || !Number.isFinite(input.position.x) || !Number.isFinite(input.position.y)) {
    throw workflowIpcError("INVALID_INPUT", "Node position coordinates must be finite numbers.");
  }
  const x = Number(input.position.x);
  const y = Number(input.position.y);
  if (Math.abs(x) > MAX_CANVAS_COORDINATE || Math.abs(y) > MAX_CANVAS_COORDINATE) {
    throw workflowIpcError("INVALID_INPUT", `Node position coordinates must be within ${MAX_CANVAS_COORDINATE}.`);
  }
  return { sessionId, updateId, nodeId, position: { x, y } };
}

export type WorkflowIpcErrorCode =
  | "INVALID_INPUT"
  | "UNKNOWN_PROJECT"
  | "UNKNOWN_SESSION"
  | "NON_EXECUTABLE_NODE"
  | "UNSAFE_WORKTREE_PATH"
  | "UNAVAILABLE"
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
  getPlannerStartAuthorization(sessionId: string): unknown;
}

export interface ExpectedArtifactRunStartStore extends TrustedPlannerRootStartStore {
  materializeCanvasSession(sessionId: string): unknown;
  materializeFlowProjection(sessionId: string): unknown;
}

export async function authorizeRunStartExpectedArtifacts<T extends Record<string, unknown>>(
  input: T,
  store: ExpectedArtifactRunStartStore,
): Promise<T> {
  const {
    canonicalExpectedArtifactDeclarationKeys,
    expectedArtifactContractForRequiredEvidence,
  } = await import("@skyturn/project-core");
  const requiredEvidence = authoritativeRunStartRequiredEvidence(input, store);
  const contract = expectedArtifactContractForRequiredEvidence(requiredEvidence);
  const submittedKeys = canonicalExpectedArtifactDeclarationKeys(
    input.expectedArtifacts === undefined ? [] : input.expectedArtifacts,
  );
  if (!submittedKeys) {
    throw workflowIpcError("INVALID_INPUT", "Expected artifact declarations are invalid.");
  }
  if (contract.required && contract.declarations.length === 0) {
    throw workflowIpcError(
      "INVALID_INPUT",
      "Workflow required evidence has no concrete backend-approved expected artifact declaration.",
    );
  }
  const approvedKeys = canonicalExpectedArtifactDeclarationKeys(contract.declarations);
  if (!approvedKeys || !sameStrings(submittedKeys, approvedKeys)) {
    throw workflowIpcError("INVALID_INPUT", "Expected artifact declarations do not match backend required evidence.");
  }

  const { expectedArtifacts: _expectedArtifacts, ...withoutRendererDeclaration } = input;
  return (contract.declarations.length > 0
    ? { ...withoutRendererDeclaration, expectedArtifacts: contract.declarations }
    : withoutRendererDeclaration) as T;
}

export function isTrustedPlannerRootStartInput(input: unknown, store: TrustedPlannerRootStartStore): boolean {
  if (!isRecord(input)) return false;
  if (
    !isNonEmptyString(input.sessionId) ||
    !isNonEmptyString(input.nodeId) ||
    !isNonEmptyString(input.runId) ||
    input.agentKind !== "hermes" ||
    !isNonEmptyString(input.plannerSessionId) ||
    input.plannerInputId !== input.runId
  ) {
    return false;
  }

  const authorization = store.getPlannerStartAuthorization(input.sessionId);
  if (!isRecord(authorization)) return false;
  return authorization.plannerNodeId === input.nodeId &&
    authorization.plannerSessionId === input.plannerSessionId &&
    authorization.agentKind === "hermes" &&
    authorization.executable === true &&
    Array.isArray(authorization.dependencies) &&
    authorization.dependencies.length === 0 &&
    authorization.hasIncomingEdges === false;
}

function authoritativeRunStartRequiredEvidence(
  input: Record<string, unknown>,
  store: ExpectedArtifactRunStartStore,
): string[] {
  if (!isNonEmptyString(input.sessionId) || !isNonEmptyString(input.nodeId)) return [];
  if (isTrustedPlannerRootStartInput(input, store)) return [];
  const projection = store.materializeFlowProjection(input.sessionId);
  const lane = isRecord(projection) && Array.isArray(projection.lanes)
    ? projection.lanes.find((candidate) => isRecord(candidate) && candidate.id === input.nodeId)
    : undefined;
  if (isRecord(lane)) return requiredEvidenceFromBackendRecord(lane);

  const canvasSession = store.materializeCanvasSession(input.sessionId);
  const node = isRecord(canvasSession) && Array.isArray(canvasSession.nodes)
    ? canvasSession.nodes.find((candidate) => isRecord(candidate) && candidate.id === input.nodeId)
    : undefined;
  return isRecord(node) ? requiredEvidenceFromBackendRecord(node) : [];
}

function requiredEvidenceFromBackendRecord(value: Record<string, unknown>): string[] {
  if (value.requiredEvidence === undefined) return [];
  if (!Array.isArray(value.requiredEvidence) || !value.requiredEvidence.every((kind) => typeof kind === "string")) {
    throw workflowIpcError("INVALID_INPUT", "Backend required evidence is invalid.");
  }
  return value.requiredEvidence;
}

function sameStrings(left: string[], right: string[]): boolean {
  return left.length === right.length && left.every((value, index) => value === right[index]);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

function boundedIdentifier(value: unknown, field: string): string {
  if (!isNonEmptyString(value) || value.trim().length > 200) {
    throw workflowIpcError("INVALID_INPUT", `${field} must be a non-empty string of at most 200 characters.`);
  }
  return value.trim();
}
