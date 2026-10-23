import { parseWorkflowCandidateManifest, sanitizePublicPayloadText } from "./index.js";
import type { CanvasNode, CanvasSession, WorkflowCandidateManifest } from "./index.js";

export interface GoalReviewRequest {
  requestId: string;
  sessionId: string;
  nodeId: string;
  sourceRunId: string;
}

/** Advisory provenance only. This identity never grants delivery authority. */
export interface GoalReviewBinding {
  readonly version: 1;
  readonly request: GoalReviewRequest;
  readonly reviewNodeId: string;
  readonly originalGoal: string;
  readonly approvedPlan: { eventId: string; seq: number; text: string } | null;
  readonly manifest: WorkflowCandidateManifest;
  readonly manifestSha256: string;
  readonly executionTarget: { executionTarget: "current_branch"; selectedBranch: string };
}

export interface GoalReviewState {
  binding: GoalReviewBinding;
  freshness: "unverified" | "current" | "stale";
}

function record(value: unknown): value is Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === null || (Object.getPrototypeOf(prototype) === null &&
    Object.hasOwn(prototype, "constructor") && prototype.constructor.name === "Object");
}
function keys(value: unknown, expected: string[]): value is Record<string, unknown> {
  return record(value) && Reflect.ownKeys(value).length === expected.length && expected.every(k => Object.hasOwn(value, k));
}
function id(value: unknown): value is string {
  return typeof value === "string" && /^[A-Za-z0-9][A-Za-z0-9._:-]{0,255}$/.test(value);
}
function text(value: unknown, max: number): value is string {
  return typeof value === "string" && value.length > 0 && value.length <= max && !value.includes("\0");
}
export function parseGoalReviewRequest(value: unknown): GoalReviewRequest {
  const expected = ["requestId", "sessionId", "nodeId", "sourceRunId"];
  if (!keys(value, expected) || !expected.every(k => id(value[k]))) throw new Error("Invalid original-goal review request.");
  return { requestId: value.requestId as string, sessionId: value.sessionId as string,
    nodeId: value.nodeId as string, sourceRunId: value.sourceRunId as string };
}
export function parseGoalReviewBinding(value: unknown): GoalReviewBinding {
  if (!keys(value, ["version", "request", "reviewNodeId", "originalGoal", "approvedPlan", "manifest", "manifestSha256", "executionTarget"]) ||
    value.version !== 1 || !id(value.reviewNodeId) || !text(value.originalGoal, 16_384) ||
    typeof value.manifestSha256 !== "string" || !/^[a-f0-9]{64}$/.test(value.manifestSha256)) throw new Error("Invalid original-goal review binding.");
  const request = parseGoalReviewRequest(value.request);
  const manifest = parseWorkflowCandidateManifest(value.manifest);
  if (!manifest || manifest.executionTarget !== "current_branch" || manifest.sessionId !== request.sessionId ||
    manifest.nodeId !== request.nodeId || manifest.laneId !== request.nodeId || manifest.runId !== request.sourceRunId ||
    value.reviewNodeId === request.nodeId ||
    !keys(value.executionTarget, ["executionTarget", "selectedBranch"]) || value.executionTarget.executionTarget !== "current_branch" ||
    value.executionTarget.selectedBranch !== manifest.branchName) throw new Error("Original-goal review source identity conflict.");
  let approvedPlan: GoalReviewBinding["approvedPlan"] = null;
  if (value.approvedPlan !== null) {
    const plan = value.approvedPlan;
    if (!keys(plan, ["eventId", "seq", "text"]) || !id(plan.eventId) || !Number.isSafeInteger(plan.seq) ||
      (plan.seq as number) < 1 || !text(plan.text, 65_536)) throw new Error("Invalid approved Plan binding.");
    approvedPlan = { eventId: plan.eventId, seq: plan.seq as number, text: plan.text };
  }
  return { version: 1, request, reviewNodeId: value.reviewNodeId, originalGoal: value.originalGoal,
    approvedPlan, manifest, manifestSha256: value.manifestSha256,
    executionTarget: { executionTarget: "current_branch", selectedBranch: manifest.branchName } };
}

/** Sanitization redacts capabilities without trimming or shortening the frozen text. */
export function publicGoalReviewBinding(binding: GoalReviewBinding): GoalReviewBinding {
  return { ...binding, originalGoal: sanitizePublicPayloadText(binding.originalGoal),
    approvedPlan: binding.approvedPlan ? { ...binding.approvedPlan, text: sanitizePublicPayloadText(binding.approvedPlan.text) } : null };
}

export function goalReviewUnavailableReason(session: CanvasSession, node: CanvasNode): string | null {
  if (session.target.executionTarget !== "current_branch") return "Review original goal requires Current branch.";
  if (node.goalReview) return "Advisory reviews cannot be reviewed or used as execution evidence.";
  if (node.rollbackStatus) return "Rolled-back or inactive sources cannot be reviewed.";
  if (node.status !== "completed" || !["implementation", "fix"].includes(node.laneKind ?? "")) return "Review requires a succeeded implementation or fix run.";
  if (!node.goalReviewSource) return "Exact candidate, checkpoint and changeset evidence is unavailable.";
  if (session.schedulingState?.status === "paused") return "Scheduling is paused. Resume explicitly before requesting a review.";
  return null;
}
