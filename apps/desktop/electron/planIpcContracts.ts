import type {
  PlanAcceptStageRequest,
  PlanBootstrapRequest,
  PlanCancelRequest,
  PlanGenerateRequest,
  PlanGetStateRequest,
  PlanReviseRequest,
  PlanStage,
  PlanUndoStageRequest,
  PlanUpdateStageRequest,
} from "@skyturn/project-core" with { "resolution-mode": "import" };

const maxIdLength = 256;
const maxPathLength = 8_192;
const maxGoalLength = 100_000;
const maxMarkdownLength = 2_000_000;
const maxInstructionLength = 100_000;
const invalidPlanRequest = "Plan IPC request is invalid.";
const invalidIdentifierCharacter = /[\u0000-\u001f\u007f]/;
const invalidMultilineTextCharacter = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/;

export function parsePlanGenerateRequest(value: unknown): PlanGenerateRequest {
  const candidate = exactRecord(value, [
    "operation",
    "planSessionId",
    "projectRoot",
    "stage",
    "goal",
    "expectedStateVersion",
  ]);
  if (candidate.operation !== "generate") fail();
  return {
    operation: "generate",
    planSessionId: identifier(candidate.planSessionId),
    projectRoot: projectPath(candidate.projectRoot),
    stage: planStage(candidate.stage),
    goal: multilineText(candidate.goal, maxGoalLength),
    expectedStateVersion: stateVersion(candidate.expectedStateVersion),
  };
}

export function parsePlanReviseRequest(value: unknown): PlanReviseRequest {
  const candidate = exactRecord(value, [
    "operation",
    "planSessionId",
    "projectRoot",
    "stage",
    "goal",
    "expectedStateVersion",
    "instruction",
  ]);
  if (candidate.operation !== "revise") fail();
  return {
    operation: "revise",
    planSessionId: identifier(candidate.planSessionId),
    projectRoot: projectPath(candidate.projectRoot),
    stage: planStage(candidate.stage),
    goal: multilineText(candidate.goal, maxGoalLength),
    expectedStateVersion: stateVersion(candidate.expectedStateVersion),
    instruction: multilineText(candidate.instruction, maxInstructionLength),
  };
}

export function parsePlanUpdateStageRequest(value: unknown): PlanUpdateStageRequest {
  const candidate = exactRecord(value, [
    "planSessionId",
    "projectRoot",
    "stage",
    "expectedStateVersion",
    "markdown",
  ]);
  return {
    planSessionId: identifier(candidate.planSessionId),
    projectRoot: projectPath(candidate.projectRoot),
    stage: planStage(candidate.stage),
    expectedStateVersion: stateVersion(candidate.expectedStateVersion),
    markdown: markdown(candidate.markdown),
  };
}

export function parsePlanAcceptStageRequest(value: unknown): PlanAcceptStageRequest {
  return parseStageMutationRequest(value);
}

export function parsePlanUndoStageRequest(value: unknown): PlanUndoStageRequest {
  return parseStageMutationRequest(value);
}

export function parsePlanCancelRequest(value: unknown): PlanCancelRequest {
  const candidate = exactRecord(value, ["planSessionId", "projectRoot", "runId"]);
  return {
    planSessionId: identifier(candidate.planSessionId),
    projectRoot: projectPath(candidate.projectRoot),
    runId: identifier(candidate.runId),
  };
}

export function parsePlanGetStateRequest(value: unknown): PlanGetStateRequest {
  const candidate = exactRecord(value, ["planSessionId", "projectRoot"]);
  return {
    planSessionId: identifier(candidate.planSessionId),
    projectRoot: projectPath(candidate.projectRoot),
  };
}

export function parsePlanBootstrapRequest(value: unknown): PlanBootstrapRequest {
  const candidate = exactRecord(value, ["planSessionId", "projectRoot"]);
  return {
    planSessionId: identifier(candidate.planSessionId),
    projectRoot: projectPath(candidate.projectRoot),
  };
}

function parseStageMutationRequest(value: unknown): PlanAcceptStageRequest {
  const candidate = exactRecord(value, [
    "planSessionId",
    "projectRoot",
    "stage",
    "expectedStateVersion",
  ]);
  return {
    planSessionId: identifier(candidate.planSessionId),
    projectRoot: projectPath(candidate.projectRoot),
    stage: planStage(candidate.stage),
    expectedStateVersion: stateVersion(candidate.expectedStateVersion),
  };
}

function planStage(value: unknown): PlanStage {
  if (value === "requirements" || value === "design" || value === "tasks") return value;
  return fail();
}

function stateVersion(value: unknown): number {
  if (!Number.isSafeInteger(value) || (value as number) < 0) return fail();
  return value as number;
}

function identifier(value: unknown): string {
  if (
    typeof value !== "string" ||
    !value.trim() ||
    value !== value.trim() ||
    value.length > maxIdLength ||
    invalidIdentifierCharacter.test(value)
  ) return fail();
  return value.trim();
}

function projectPath(value: unknown): string {
  if (
    typeof value !== "string" ||
    !value.trim() ||
    value !== value.trim() ||
    value.length > maxPathLength ||
    invalidIdentifierCharacter.test(value)
  ) return fail();
  return value.trim();
}

function multilineText(value: unknown, maxLength: number): string {
  if (
    typeof value !== "string" ||
    !value.trim() ||
    value.length > maxLength ||
    invalidMultilineTextCharacter.test(value)
  ) return fail();
  return value;
}

function markdown(value: unknown): string {
  if (
    typeof value !== "string" ||
    value.length > maxMarkdownLength ||
    invalidMultilineTextCharacter.test(value)
  ) return fail();
  return value;
}

function exactRecord(value: unknown, keys: readonly string[]): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return fail();
  const candidate = value as Record<string, unknown>;
  const actual = Object.keys(candidate);
  if (actual.length !== keys.length || actual.some((key) => !keys.includes(key))) return fail();
  return candidate;
}

function fail(): never {
  throw new Error(invalidPlanRequest);
}
