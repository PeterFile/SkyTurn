export type WorkflowMode = "fast" | "plan";
export type SessionKind = "plan" | "canvas";
export type AgentKind = "hermes" | "codex" | "gemini" | "claude-code" | "openclaw";
export type NodeStatus = "pending" | "running" | "retrying" | "completed" | "failed";
export type NodeRollbackStatus = "rolled_back" | "inactive" | "rejected";
export type NodeLifecyclePhase =
  | "Queued"
  | "Think"
  | "Planning"
  | "Executing"
  | "Testing"
  | "Validating"
  | "Retrying"
  | "Summarizing"
  | "Completed"
  | "Failed";
export type NodeModalTab = "Output" | "Changes" | "Context";
export type AgentAvailabilityStatus = "available" | "missing" | "needs-auth" | "unhealthy";
export type AgentSupportLevel = "mock-only" | "detected-only" | "experimental-run" | "supported-run";
export type AgentReadinessLevel = "unavailable" | "detected-only" | "experimental-run";
export type AgentAuthReadinessStatus = "available" | "missing" | "unknown";
export type AgentReadinessCategory = "cli-missing" | "auth-missing" | "auth-unknown" | "version-probe-failed";
export type AgentCapability =
  | "chat"
  | "file-read"
  | "file-write"
  | "shell"
  | "software-control"
  | "mcp"
  | "worktree"
  | "resume";
export type AgentRunStatus =
  | "queued"
  | "running"
  | "waiting-input"
  | "requires-approval"
  | "succeeded"
  | "failed"
  | "cancelled"
  | "timed-out";
export type AgentRunSandbox = "read-only" | "workspace-write" | "danger-full-access";
export type RunEventKind = "output" | "status" | "error" | "approval" | "progress" | "evidence" | "changes";
export type EvidenceCheckStatus = "passed" | "failed" | "skipped";
export type EvidenceCheckKind = "run-exit" | "run-timeout" | "git" | "test" | "typecheck" | "build" | "review";
export type HermesPlannerTransport = "hermes_live_chat" | "hermes_session_resume" | "hermes_replay_recovery";
export type SessionExecutionTarget = "current_branch" | "new_worktree";
export type WorkflowLaneKind =
  | "discovery"
  | "design"
  | "implementation"
  | "fix"
  | "validation"
  | "regression"
  | "review"
  | "commit"
  | "pull_request"
  | "join"
  | "decision";
export type WorkflowLaneSemanticSubtype =
  | "coding"
  | "frontend_implementation"
  | "backend_implementation"
  | "persistence_implementation"
  | "repair"
  | "browser_validation"
  | "unit_test"
  | "integration_test"
  | "fixture_validation"
  | "regression_check"
  | "evidence_review"
  | "commit"
  | (string & {});
export type WorkflowProjectionNodeKind = "agent_task" | "user_decision";
export type WorkflowRuntimePolicySource = "workflow_projection";
export type WorkflowSideEffectKind = "filesystem" | "git" | "network" | "process" | "artifact";
export type UserDecisionAction = "backtrack" | "parallel_worktree" | "continue" | "abort";
export type UserDecisionNodeStatus = "waiting_input" | "answered";
export type WorkflowVariantAdoptionStrategy = "merge" | "cherry-pick";
export type WorkflowVariantAdoptionStatus = "requested" | "adopted" | "failed" | "rejected";
export type WorkflowNodeCheckpointPhase = "before" | "after";
export type WorkflowNodeCheckpointSource = "agent_bridge" | "workflow_kernel" | "backend" | "user";
export type WorkflowCheckpointEvidenceRefKind = "run" | "segment" | "evidence" | "changeset" | "artifact" | "commit";
export type WorkflowRemoteSideEffectEventKind =
  | "workflow.delivery.pushed"
  | "workflow.pull_request.created"
  | "workflow.pull_request.merged"
  | "workflow.delivery.main_synced";
export type WorkflowCheckpointIntentKind = "rollback" | "repair" | "variant" | "fork";
export type WorkflowCheckpointIntentStatus = "requested" | "applied" | "rejected";
export type ChangesetEvidenceStatus = "available" | "empty" | "failed" | "unknown";
export type LiveRunChangeOperation = "add" | "delete" | "update" | "move";
export type FinalChangesetReconciliationStatus = "available" | "empty" | "failed" | "mismatch";

export const NODE_MODAL_TABS: NodeModalTab[] = ["Output", "Changes", "Context"];
export const RUN_EVENT_PROTOCOL_VERSION = 1;
export const DEFAULT_SESSION_TARGET: SessionTarget = {
  executionTarget: "current_branch",
  selectedBranch: "HEAD",
};
export const WORKFLOW_LANE_KINDS: WorkflowLaneKind[] = [
  "discovery",
  "design",
  "implementation",
  "fix",
  "validation",
  "regression",
  "review",
  "commit",
  "pull_request",
  "join",
  "decision",
];
export const EVIDENCE_CHECK_KINDS: EvidenceCheckKind[] = [
  "run-exit",
  "run-timeout",
  "git",
  "test",
  "typecheck",
  "build",
  "review",
];
export const AGENT_SUPPORT_LEVELS: AgentSupportLevel[] = [
  "mock-only",
  "detected-only",
  "experimental-run",
  "supported-run",
];

export interface AgentDescriptor {
  kind: AgentKind;
  label: string;
  executablePath: string | null;
  version: string | null;
  status: AgentAvailabilityStatus;
  supportLevel: AgentSupportLevel;
  capabilities: AgentCapability[];
  configFiles: string[];
  readiness?: {
    level: AgentReadinessLevel;
    cli: {
      available: boolean;
      path: string | null;
      version: string | null;
    };
    auth: {
      status: AgentAuthReadinessStatus;
      source?: "environment";
    };
    categories: AgentReadinessCategory[];
  };
}

export interface AgentRun {
  id: string;
  nodeId: string;
  sessionId: string;
  plannerSessionId?: string;
  plannerInputId?: string;
  projectRoot: string;
  worktreePath: string;
  agentKind: AgentKind;
  status: AgentRunStatus;
  startedAt: string;
  endedAt?: string;
}

export interface StartAgentRunInput {
  protocolVersion: typeof RUN_EVENT_PROTOCOL_VERSION;
  runId?: string;
  nodeId: string;
  sessionId: string;
  plannerSessionId?: string;
  plannerInputId?: string;
  hermesSessionHandle?: string;
  projectRoot: string;
  worktreePath: string;
  agentKind: AgentKind;
  sandbox?: AgentRunSandbox;
  prompt: string;
}

export interface RunEvent {
  protocolVersion: typeof RUN_EVENT_PROTOCOL_VERSION;
  runId: string;
  seq: number;
  timestamp: string;
  kind: RunEventKind;
  payload: Record<string, unknown>;
}

export interface EvidenceCheck {
  kind: EvidenceCheckKind;
  name: string;
  status: EvidenceCheckStatus;
  detail?: string;
}

export interface RunEvidence {
  runId: string;
  status: AgentRunStatus;
  exitCode: number | null;
  changesetId: string | null;
  checks: EvidenceCheck[];
  artifacts: string[];
  review: EvidenceCheck | null;
  errorReason: string | null;
  cancelReason: string | null;
  completedAt: string | null;
}

export interface ImportedProject {
  id: string;
  name: string;
  rootPath: string;
  devflowPath: string;
  openedAt: string;
}

export interface PlanMarkdown {
  requirements: string;
  design: string;
  tasks: string;
}

export interface SessionTarget {
  executionTarget: SessionExecutionTarget;
  selectedBranch: string;
  baseRef?: string;
}

export interface WorktreeMetadata {
  path: string;
  branchName: string;
  baseCommit: string;
  executionTarget?: SessionExecutionTarget;
  selectedBranch?: string;
  baseRef?: string;
  baselineRef?: string;
  worktreeId?: string;
  variantId?: string;
  realPath?: string;
  gitdir?: string;
  repoRoot?: string;
  headCommit?: string;
}

export interface WorkflowRuntimePolicy {
  source: WorkflowRuntimePolicySource;
  trusted: true;
  executable: boolean;
  sandbox: AgentRunSandbox;
  sideEffects: WorkflowSideEffectKind[];
  reason: string;
}

export interface UserDecisionRequestedPayload {
  decisionId: string;
  prompt: string;
  options: string[];
  reason: string;
  targetLaneId?: string;
  targetSegmentId?: string;
}

export interface UserDecisionAnsweredPayload {
  decisionId: string;
  selectedOption: string;
  action: UserDecisionAction;
  comment?: string;
  targetLaneId?: string;
  targetSegmentId?: string;
}

export interface UserDecisionProjection {
  decisionId: string;
  prompt: string;
  options: string[];
  reason: string;
  status: UserDecisionNodeStatus;
  targetLaneId?: string;
  targetSegmentId?: string;
  selectedOption?: string;
  action?: UserDecisionAction;
  comment?: string;
}

export interface WorkflowLedgerSummaryEvent {
  seq: number;
  kind: string;
  summary: string;
  laneId?: string;
}

export interface WorkflowLedgerSummary {
  throughSeq: number;
  checkpointSummary: string | null;
  facts: string[];
  recentEvents: WorkflowLedgerSummaryEvent[];
  openQuestions: string[];
}

export interface WorkflowWorktreeIdentity {
  worktreeId: string;
  variantId: string;
  path: string;
  realPath: string;
  gitdir: string;
  repoRoot: string;
  branchName: string;
  baseCommit: string;
  headCommit: string;
  parentLaneId: string;
  parentSegmentId?: string;
}

export interface WorkflowVariantAdoption {
  adoptionId: string;
  variantId: string;
  worktreeId: string;
  strategy: WorkflowVariantAdoptionStrategy;
  status: WorkflowVariantAdoptionStatus;
  baseCommit: string;
  headCommit: string;
  targetBranchName: string;
  adoptedCommit?: string;
  failureReason?: string;
}

export interface WorkflowCheckpointEvidenceRef {
  kind: WorkflowCheckpointEvidenceRefKind;
  id: string;
  uri?: string;
}

export interface WorkflowNodeCheckpointAuthority {
  laneIdExplicit?: boolean;
  nodeIdExplicit?: boolean;
  phaseExplicit?: boolean;
  executionTargetExplicit?: boolean;
}

export interface WorkflowNodeCheckpoint {
  id: string;
  sessionId: string;
  nodeId: string;
  laneId?: string;
  runId?: string;
  segmentId?: string;
  phase: WorkflowNodeCheckpointPhase;
  executionTarget: SessionExecutionTarget;
  worktreeId?: string;
  worktreePath?: string;
  baseCommit?: string;
  headCommit?: string;
  createdAt: string;
  source: WorkflowNodeCheckpointSource;
  evidenceRefs: WorkflowCheckpointEvidenceRef[];
  authority?: WorkflowNodeCheckpointAuthority;
}

export interface WorkflowRemoteSideEffectRef {
  eventKind: WorkflowRemoteSideEffectEventKind;
  eventId: string;
  laneId?: string;
  affectedLaneIds?: string[];
  sessionWide?: boolean;
  createdAt?: string;
}

export interface WorkflowRemoteSideEffectPayload {
  laneId?: string;
  commitLaneId?: string;
  targetLaneId?: string;
  affectedLaneIds?: string[];
  evidence?: Record<string, unknown>;
  [key: string]: unknown;
}

export interface WorkflowRollbackEligibility {
  eligible: boolean;
  targetLaneId: string;
  targetNodeId?: string;
  checkpointId?: string;
  restoreCommitRef?: string;
  affectedLaneIds: string[];
  blockingRemoteSideEffects: WorkflowRemoteSideEffectRef[];
  localRollbackSafe?: boolean;
  reason?: string;
}

export type WorkflowEngineeringLoopKind = "execution" | "delivery" | "rollback" | "repair" | "variant";
export type WorkflowDeliveryLoopPhase =
  | "not_started"
  | "pushed"
  | "pr_created"
  | "checks_pending"
  | "checks_failed"
  | "changes_requested"
  | "checks_stale"
  | "merge_ready"
  | "merged"
  | "main_synced";
export type WorkflowRollbackLoopPhase = "not_requested" | "ready" | "blocked" | "requested" | "applied" | "rejected";
export type WorkflowSuccessorLoopPhase = "not_requested" | "requested" | "ready" | "running" | "completed" | "rejected";
export type WorkflowLoopNextActionKind =
  | "execute_lane"
  | "wait_for_checks"
  | "fix_failed_checks"
  | "merge_pull_request"
  | "rollback_node"
  | "request_repair"
  | "request_variant"
  | "blocked"
  | "none";
export type WorkflowLoopBlockedReasonCode =
  | "changes_requested"
  | "stale_head"
  | "pending_checks"
  | "failed_checks"
  | "remote_side_effect"
  | "local_rollback_unsafe"
  | "invalid_checkpoint"
  | "unknown_target";
export type WorkflowDeliveryCheckStatus = "passed" | "failed" | "pending" | "changes_requested";
export type WorkflowDeliveryReviewStatus = "approved" | "changes_requested" | "pending" | "unknown";

export interface WorkflowDeliveryCheckSummary {
  name: string;
  status: WorkflowDeliveryCheckStatus;
  url?: string;
  detail?: string;
}

export interface WorkflowDeliveryReviewSummary {
  status: WorkflowDeliveryReviewStatus;
  detail?: string;
  reviewer?: string;
  url?: string;
}

export interface WorkflowLoopBlockedReason {
  code: WorkflowLoopBlockedReasonCode;
  message: string;
  laneId?: string;
  affectedLaneIds?: string[];
  eventKinds?: WorkflowRemoteSideEffectEventKind[];
  remoteSideEffects?: WorkflowRemoteSideEffectRef[];
  localRollbackSafe?: boolean;
}

export interface WorkflowLoopNextAction {
  kind: WorkflowLoopNextActionKind;
  loop?: WorkflowEngineeringLoopKind;
  laneId?: string;
  reason: string;
  prNumber?: number;
  headSha?: string;
  checkpointId?: string;
}

export interface WorkflowDeliveryLoopState {
  phase: WorkflowDeliveryLoopPhase;
  evidenceStale: boolean;
  pullRequestLaneId?: string;
  checkLaneId?: string;
  prNumber?: number;
  headSha?: string;
  headBranch?: string;
  lastCheckedHeadSha?: string;
  checks: WorkflowDeliveryCheckSummary[];
  review?: WorkflowDeliveryReviewSummary;
  blockedReason?: WorkflowLoopBlockedReason;
}

export interface WorkflowRollbackLoopState {
  phase: WorkflowRollbackLoopPhase;
  targetLaneId?: string;
  targetNodeId?: string;
  checkpointId?: string;
  restoreCommitRef?: string;
  affectedLaneIds: string[];
  remoteBlockers: WorkflowRemoteSideEffectRef[];
  localRollbackSafe?: boolean;
  blockedReason?: WorkflowLoopBlockedReason;
}

export interface WorkflowSuccessorLoopState {
  phase: WorkflowSuccessorLoopPhase;
  sourceLaneId?: string;
  checkpointId?: string;
  successorLaneId?: string;
  successorSemanticKey?: string;
  instruction?: string;
}

export interface WorkflowLoopEngineeringProjectionInput {
  selectedLaneId?: string;
  allowedParallelism?: number;
  localRollbackSafe?: boolean;
}

export interface WorkflowLoopEngineeringState {
  sessionId: string;
  throughSeq: number;
  nextAction: WorkflowLoopNextAction;
  blockedReason?: WorkflowLoopBlockedReason;
  evidenceStale: boolean;
  delivery: WorkflowDeliveryLoopState;
  rollback: WorkflowRollbackLoopState;
  repair: WorkflowSuccessorLoopState;
  variant: WorkflowSuccessorLoopState;
}

export interface WorkflowCheckpointIntentBase {
  intentId: string;
  sessionId: string;
  nodeId?: string;
  laneId?: string;
  checkpointId?: string;
  createdAt: string;
  localRollbackSafe?: boolean;
}

export interface WorkflowRollbackCheckpointIntent extends WorkflowCheckpointIntentBase {
  kind: "rollback";
  status: WorkflowCheckpointIntentStatus;
  eligibility?: WorkflowRollbackEligibility;
  reason?: string;
  successorLaneId?: never;
  successorSemanticKey?: never;
}

export type WorkflowCheckpointSuccessorKind = Exclude<WorkflowCheckpointIntentKind, "rollback">;

export type WorkflowCheckpointSuccessorIdentity =
  | { successorLaneId: string; successorSemanticKey?: string }
  | { successorLaneId?: string; successorSemanticKey: string };

export type WorkflowRequestedCheckpointSuccessorIntent = Omit<WorkflowCheckpointIntentBase, "laneId"> &
  { laneId: string } &
  WorkflowCheckpointSuccessorIdentity & {
    kind: WorkflowCheckpointSuccessorKind;
    status: "requested";
    instruction?: string;
    reason?: string;
  };

export interface WorkflowRejectedCheckpointSuccessorIntent extends WorkflowCheckpointIntentBase {
  kind: WorkflowCheckpointSuccessorKind;
  status: "rejected";
  successorLaneId?: string;
  successorSemanticKey?: string;
  instruction?: string;
  reason: string;
}

export type WorkflowCheckpointIntent =
  | WorkflowRollbackCheckpointIntent
  | WorkflowRequestedCheckpointSuccessorIntent
  | WorkflowRejectedCheckpointSuccessorIntent;

export interface ChangesetEvidence {
  evidenceId: string;
  changesetId: string;
  source: Changeset["source"];
  status: ChangesetEvidenceStatus;
  files: string[];
  diffStat: Changeset["diffStat"];
  patchPreviewTruncated: boolean;
  worktreeId?: string;
  collectedAt?: string;
  artifactPaths?: string[];
  errorReason?: string;
}

export interface StructuredRunChange {
  operation: LiveRunChangeOperation;
  path: string;
  previousPath?: string;
  unifiedDiff?: string;
}

export interface LiveRunChangesEvidence {
  source: "codex";
  status: "available" | "unknown";
  files: string[];
  changes: StructuredRunChange[];
  patchPreview?: string;
  patchPreviewTruncated?: boolean;
  collectedAt?: string;
}

export interface ChangesetReconciliationMetadata {
  source: "git";
  executionTarget: SessionExecutionTarget;
  selectedBranch: string;
  baselineRef: string;
  baseRef?: string;
  worktreeId?: string;
  variantId?: string;
}

export interface ChangesetReconciliationMismatch {
  kind: "file-set";
  liveFiles: string[];
  gitFiles: string[];
}

export interface FinalChangesetReconciliation {
  status: FinalChangesetReconciliationStatus;
  changeset: Changeset;
  metadata: ChangesetReconciliationMetadata;
  liveChanges?: LiveRunChangesEvidence;
  mismatches?: ChangesetReconciliationMismatch[];
  errorReason?: string;
}

export interface CanvasNodeContext {
  brief: string;
  sessionGoal: string;
  relatedRequirements: string;
  relatedDesign: string;
  relatedTasks: string;
  dependencies: string[];
  constraints: string[];
}

export interface NodeRuntimeState {
  phase: NodeLifecyclePhase;
  message: string;
  action: string;
}

export interface CanvasNodeDisplay {
  agentLabel: string;
  meta: string[];
}

export type WorkflowCardToolName = "createWorkflowCard" | "updateWorkflowCard" | "deleteWorkflowCard";

export interface CanvasNodeWorkflowTrace {
  source: "hermes";
  sourceRunId: string;
  toolCallId?: string;
  lastTool: WorkflowCardToolName;
  taskKey?: string;
  semanticKey?: string;
}

export interface CanvasNode {
  id: string;
  title: string;
  agent: AgentKind;
  progress: string;
  nodeKind?: WorkflowProjectionNodeKind;
  executable?: boolean;
  laneKind?: WorkflowLaneKind;
  semanticSubtype?: WorkflowLaneSemanticSubtype;
  runtimePolicy?: WorkflowRuntimePolicy;
  userDecision?: UserDecisionProjection;
  runtime?: NodeRuntimeState;
  display?: CanvasNodeDisplay;
  workflowTrace?: CanvasNodeWorkflowTrace;
  status: NodeStatus;
  rollbackStatus?: NodeRollbackStatus;
  position: {
    x: number;
    y: number;
  };
  runId: string;
  changesetId: string;
  output: string[];
  worktree: WorktreeMetadata;
  context: CanvasNodeContext;
}

export interface CanvasEdge {
  id: string;
  source: string;
  target: string;
}

export interface SessionBase {
  id: string;
  projectId: string;
  title: string;
  goal: string;
  mode: WorkflowMode;
  target: SessionTarget;
  createdAt: string;
  updatedAt: string;
}

export interface CanvasSession extends SessionBase {
  kind: "canvas";
  hermesPlannerSessionId: string;
  plannerNodeId: string;
  nodes: CanvasNode[];
  edges: CanvasEdge[];
  activeNodeId: string | null;
}

export interface PlanSession extends SessionBase {
  kind: "plan";
  mode: "plan";
  plan: PlanMarkdown;
  nodes: [];
  edges: [];
  activeNodeId: null;
}

export type CanvasSessionTab = CanvasSession | PlanSession;

export interface Changeset {
  id: string;
  files: string[];
  diffStat: {
    added: number;
    changed: number;
    deleted: number;
  };
  patchPreview: string;
  source: "mock" | "git";
  evidence?: ChangesetEvidence;
}

export function hasConcreteRunEvidence(evidence: RunEvidence | null | undefined): boolean {
  if (!evidence) return false;
  if (evidence.exitCode === 0) return true;
  if (evidence.changesetId) return true;
  if (evidence.artifacts.length > 0) return true;
  if (evidence.review?.status === "passed") return true;
  return evidence.checks.some((check) => check.status === "passed");
}

export function makeHermesPlannerSessionId(sessionId: string): string {
  return `hermes-planner-${sessionId}`;
}

export function normalizeSessionTarget(value: unknown, fallbackSelectedBranch = "HEAD"): SessionTarget {
  const fallback = cleanSessionRef(fallbackSelectedBranch) || DEFAULT_SESSION_TARGET.selectedBranch;
  if (!isRecord(value)) return { ...DEFAULT_SESSION_TARGET, selectedBranch: fallback };
  const executionTarget = value.executionTarget === "new_worktree" ? "new_worktree" : "current_branch";
  const selectedBranch = cleanSessionRef(value.selectedBranch);
  if (executionTarget === "current_branch") {
    return {
      executionTarget,
      selectedBranch: selectedBranch || fallback,
    };
  }
  const baseRef = cleanSessionRef(value.baseRef) || selectedBranch || fallback;
  return {
    executionTarget,
    selectedBranch: selectedBranch || baseRef,
    baseRef,
  };
}

export function deriveNodeStatusFromEvidence(
  run: AgentRun | null | undefined,
  evidence: RunEvidence | null | undefined,
): NodeStatus {
  if (!run) return "pending";
  if (run.status === "queued") return "pending";
  if (run.status === "running" || run.status === "waiting-input" || run.status === "requires-approval") {
    return "running";
  }
  if (run.status === "succeeded") {
    return hasConcreteRunEvidence(evidence) ? "completed" : "failed";
  }
  return "failed";
}

function cleanSessionRef(value: unknown): string {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : "";
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}
