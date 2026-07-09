export type WorkflowMode = "fast" | "plan";
export type SessionKind = "plan" | "canvas";
export type AgentKind = "hermes" | "codex" | "agy" | "gemini" | "claude-code" | "openclaw";
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
export type AgentTransportKind = "exec-json" | "pty-interactive";
export type TerminalSessionStatus =
  | "starting"
  | "running"
  | "waiting"
  | "exited"
  | "timed-out"
  | "cancelled"
  | "failed";
export type TerminalSessionEventKind = "output" | "progress" | "lifecycle";
export type TerminalOutputStream = "stdout" | "stderr";
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
export type WorkflowRemoteSideEffectStatus = "recorded" | "in_flight";
export type WorkflowRollbackLocalSafetyStatus =
  | "unknown"
  | "safe"
  | "unsafe"
  | "not_required"
  | "manual_repair_required"
  | "already_restored";
export type WorkflowCheckpointIntentKind = "rollback" | "repair" | "variant" | "fork";
export type WorkflowCheckpointIntentStatus = "requested" | "applied" | "rejected";
export type ChangesetEvidenceStatus = "available" | "empty" | "failed" | "unknown";
export type LiveRunChangeOperation = "add" | "delete" | "update" | "move";
export type FinalChangesetReconciliationStatus = "available" | "empty" | "failed" | "mismatch";

export const NODE_MODAL_TABS: NodeModalTab[] = ["Output", "Changes", "Context"];
export const RUN_EVENT_PROTOCOL_VERSION = 1;
export const AGENT_TRANSPORT_KINDS: AgentTransportKind[] = ["exec-json", "pty-interactive"];
export const TERMINAL_SESSION_STATUSES: TerminalSessionStatus[] = [
  "starting",
  "running",
  "waiting",
  "exited",
  "timed-out",
  "cancelled",
  "failed",
];
export const DEFAULT_AGENT_TRANSPORT_FEATURE_FLAGS: AgentTransportFeatureFlags = {
  ptyInteractiveSessions: false,
};
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
  transportCapabilities?: AgentTransportCapabilities;
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

export interface AgentTransportCapabilities {
  supportsExecJson: boolean;
  supportsPtyInteractive: boolean;
  supportsResume: boolean;
  supportsStructuredEvents: boolean;
}

export interface AgentTransportFeatureFlags {
  ptyInteractiveSessions: boolean;
}

export interface AgentTerminalSession {
  id: string;
  runId: string;
  canvasSessionId: string;
  agentKind: AgentKind;
  cwd: string;
  commandLabel: string;
  transport: "pty-interactive";
  status: TerminalSessionStatus;
  createdAt: string;
  endedAt?: string;
}

export interface TerminalSessionEventDraftBase {
  terminalSessionId: string;
  runId: string;
  timestamp?: string;
}

export interface TerminalOutputChunkEventDraft extends TerminalSessionEventDraftBase {
  kind: "output";
  stream: TerminalOutputStream;
  text: string;
}

export interface TerminalProgressEventDraft extends TerminalSessionEventDraftBase {
  kind: "progress";
  message: string;
}

export interface TerminalLifecycleEventDraft extends TerminalSessionEventDraftBase {
  kind: "lifecycle";
  status: TerminalSessionStatus;
  message?: string;
}

export type TerminalSessionEventDraft =
  | TerminalOutputChunkEventDraft
  | TerminalProgressEventDraft
  | TerminalLifecycleEventDraft;

export type AgentWorkflowReadinessStatus = "ready" | "degraded" | "blocked" | "mock-only";
export type AgentWorkflowRunSupport = "supported-run" | "experimental-run" | "mock-only" | "unavailable";
export type AgentWorkflowReadinessCheckStatus = "ready" | "missing" | "unknown";
export type AgentWorkflowReadinessReason =
  | "hermes-cli-missing"
  | "codex-cli-missing"
  | "agy-cli-missing"
  | "hermes-auth-missing"
  | "codex-auth-missing"
  | "hermes-auth-unknown"
  | "codex-auth-unknown"
  | "experimental-run"
  | "supported-run"
  | "mock-only-fallback";

export interface AgentWorkflowReadinessChecks {
  hermesCli: AgentWorkflowReadinessCheckStatus;
  codexCli: AgentWorkflowReadinessCheckStatus;
  agyCli: AgentWorkflowReadinessCheckStatus;
  hermesAuth: AgentAuthReadinessStatus;
  codexAuth: AgentAuthReadinessStatus;
  mockFallback: boolean;
}

export interface AgentWorkflowReadinessSummary {
  status: AgentWorkflowReadinessStatus;
  runSupport: AgentWorkflowRunSupport;
  message: string;
  reasons: AgentWorkflowReadinessReason[];
  checks: AgentWorkflowReadinessChecks;
}

export function summarizeAgentReadiness(agents: readonly AgentDescriptor[]): AgentWorkflowReadinessSummary {
  const hermes = agentByKind(agents, "hermes");
  const codex = agentByKind(agents, "codex");
  const agy = agentByKind(agents, "agy");
  const checks: AgentWorkflowReadinessChecks = {
    hermesCli: agentCliCheck(hermes),
    codexCli: agentCliCheck(codex),
    agyCli: agentCliCheck(agy),
    hermesAuth: agentAuthCheck(hermes),
    codexAuth: agentAuthCheck(codex),
    mockFallback: agents.some((agent) => agent.supportLevel === "mock-only"),
  };
  const reasons: AgentWorkflowReadinessReason[] = [];

  if (checks.hermesCli === "missing") reasons.push("hermes-cli-missing");
  if (checks.codexCli === "missing") reasons.push("codex-cli-missing");
  if (checks.agyCli === "missing") reasons.push("agy-cli-missing");
  if (checks.hermesAuth === "missing") reasons.push("hermes-auth-missing");
  if (checks.codexAuth === "missing") reasons.push("codex-auth-missing");
  if (checks.hermesAuth === "unknown") reasons.push("hermes-auth-unknown");
  if (checks.codexAuth === "unknown") reasons.push("codex-auth-unknown");

  const cliBlocked = checks.hermesCli === "missing" || checks.codexCli === "missing";
  const authBlocked = checks.hermesAuth === "missing" || checks.codexAuth === "missing";
  const realCliReady = checks.hermesCli === "ready" && checks.codexCli === "ready";
  const realExperimental = [hermes, codex].some((agent) => agent?.supportLevel === "experimental-run");
  const realSupported = [hermes, codex].every((agent) => agent?.supportLevel === "supported-run");

  if (checks.mockFallback && !realCliReady) {
    reasons.push("mock-only-fallback");
    return {
      status: "mock-only",
      runSupport: "mock-only",
      message: agentReadinessMessage(
        "Mock fallback only; install and authenticate Hermes and Codex for real workflow runs.",
        checks,
      ),
      reasons: uniqueReadinessReasons(reasons),
      checks,
    };
  }

  if (realExperimental) reasons.push("experimental-run");
  if (realSupported) reasons.push("supported-run");

  if (cliBlocked || authBlocked) {
    return {
      status: "blocked",
      runSupport: "unavailable",
      message: agentReadinessMessage(blockedAgentReadinessMessage(checks), checks),
      reasons: uniqueReadinessReasons(reasons),
      checks,
    };
  }

  if (!realCliReady) {
    return {
      status: "blocked",
      runSupport: "unavailable",
      message: agentReadinessMessage(
        "Hermes and Codex CLI readiness could not be verified for real workflow runs.",
        checks,
      ),
      reasons: uniqueReadinessReasons(reasons),
      checks,
    };
  }

  if (checks.hermesAuth === "unknown" || checks.codexAuth === "unknown" || realExperimental) {
    return {
      status: "degraded",
      runSupport: realExperimental ? "experimental-run" : "supported-run",
      message: agentReadinessMessage(
        "Real loop available in experimental mode; verify agent auth before relying on long runs.",
        checks,
      ),
      reasons: uniqueReadinessReasons(reasons),
      checks,
    };
  }

  return {
    status: "ready",
    runSupport: "supported-run",
    message: agentReadinessMessage("Real loop ready.", checks),
    reasons: uniqueReadinessReasons(reasons),
    checks,
  };
}

function agentByKind(agents: readonly AgentDescriptor[], kind: AgentKind): AgentDescriptor | undefined {
  return agents.find((agent) => agent.kind === kind);
}

function agentCliCheck(agent: AgentDescriptor | undefined): AgentWorkflowReadinessCheckStatus {
  if (!agent) return "missing";
  if (agent.supportLevel === "mock-only") return "unknown";
  if (agent.readiness?.cli.available === false) return "missing";
  if (agent.readiness?.cli.available === true) return "ready";
  if (agent.status === "missing" || !agent.executablePath) return "missing";
  if (agent.status === "available") return "ready";
  return "unknown";
}

function agentAuthCheck(agent: AgentDescriptor | undefined): AgentAuthReadinessStatus {
  if (!agent || agent.supportLevel === "mock-only") return "unknown";
  return agent.readiness?.auth.status ?? "unknown";
}

function blockedAgentReadinessMessage(checks: AgentWorkflowReadinessChecks): string {
  if (checks.hermesCli === "missing") return "Hermes CLI missing; install Hermes before starting real planner runs.";
  if (checks.codexCli === "missing") return "Codex CLI missing; install Codex before starting real executor runs.";
  if (checks.hermesAuth === "missing") return "Hermes auth missing; authenticate Hermes before starting real planner runs.";
  if (checks.codexAuth === "missing") return "Codex auth missing; authenticate Codex before starting real executor runs.";
  return "Agent readiness blocked.";
}

function agentReadinessMessage(message: string, checks: AgentWorkflowReadinessChecks): string {
  if (checks.agyCli !== "missing") return message;
  return `${message} Antigravity CLI optional detected-only design agent not detected.`;
}

function uniqueReadinessReasons(reasons: AgentWorkflowReadinessReason[]): AgentWorkflowReadinessReason[] {
  return [...new Set(reasons)];
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
  transport?: AgentTransportKind;
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
  transport?: AgentTransportKind;
  sandbox?: AgentRunSandbox;
  expectedArtifacts?: string[];
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
  status?: WorkflowRemoteSideEffectStatus;
  eventId: string;
  laneId?: string;
  affectedLaneIds?: string[];
  sessionWide?: boolean;
  operationId?: string;
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
  checkpointPhase?: WorkflowNodeCheckpointPhase;
  restoreCommitRef?: string;
  affectedLaneIds: string[];
  affectedNodeIds?: string[];
  downstreamInactiveLaneIds: string[];
  downstreamInactiveNodeIds?: string[];
  blockingRemoteSideEffects: WorkflowRemoteSideEffectRef[];
  localRollbackSafe?: boolean;
  localSafetyStatus?: WorkflowRollbackLocalSafetyStatus;
  manualRepairReason?: string;
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
  checkpointPhase?: WorkflowNodeCheckpointPhase;
  restoreCommitRef?: string;
  affectedLaneIds: string[];
  affectedNodeIds?: string[];
  downstreamInactiveLaneIds: string[];
  downstreamInactiveNodeIds?: string[];
  remoteBlockers: WorkflowRemoteSideEffectRef[];
  localRollbackSafe?: boolean;
  localSafetyStatus?: WorkflowRollbackLocalSafetyStatus;
  manualRepairReason?: string;
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
  sourceEvidenceIds?: string[];
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

export interface EvidenceSummaryFact {
  label: string;
  value: string;
}

export interface EvidenceCommitSummary {
  commitSha?: string;
  branch?: string;
  worktreePath?: string;
  subject?: string;
}

export type EvidenceRepoState = "clean" | "dirty" | "failed" | "unknown";

export interface RunEvidenceSummaryInput {
  runEvidence?: RunEvidence | null;
  changeset?: Changeset | null;
  reconciliation?: FinalChangesetReconciliation | null;
  commitEvidence?: EvidenceCommitSummary | null;
  expectedArtifacts?: string[];
}

export interface RunEvidenceSummary {
  run: {
    id: string | null;
    status: AgentRunStatus | "unknown";
    exitCode: number | null;
  };
  reason: string | null;
  latestFailedCheck: string | null;
  checkSummary: string;
  artifactSummary: string;
  reviewSummary: string | null;
  runFacts: EvidenceSummaryFact[];
  changes: {
    changesetId: string | null;
    status: ChangesetEvidenceStatus | FinalChangesetReconciliationStatus | "unknown";
    files: string[];
    diffStat: Changeset["diffStat"];
    repoState: EvidenceRepoState;
    repoStateSummary: string;
  };
  changeFacts: EvidenceSummaryFact[];
}

export function hasConcreteRunEvidence(evidence: RunEvidence | null | undefined): boolean {
  if (!evidence) return false;
  if (evidence.exitCode === 0) return true;
  if (evidence.changesetId) return true;
  if (evidence.artifacts.length > 0) return true;
  if (evidence.review?.status === "passed") return true;
  return evidence.checks.some((check) => check.status === "passed");
}

export function summarizeRunEvidence(input: RunEvidenceSummaryInput = {}): RunEvidenceSummary {
  const runEvidence = input.runEvidence ?? null;
  const checks = runEvidence?.checks ?? [];
  const reviewSummary = runEvidence?.review ? formatEvidenceCheck(runEvidence.review) : null;
  const artifactPaths = runEvidence?.artifacts.length ? runEvidence.artifacts : input.expectedArtifacts ?? [];
  const artifactSummary = formatArtifacts(
    artifactPaths,
    runEvidence?.artifacts.length ? "recorded" : input.expectedArtifacts?.length ? "expected" : "none",
  );
  const reason = runEvidence ? runEvidenceReason(runEvidence) : null;
  const latestFailedCheck = latestFailedCheckSummary(checks);
  const changes = summarizeChangeEvidence(input.reconciliation ?? null, input.changeset ?? null);
  const changeFacts = changeFactsForSummary(changes, input.commitEvidence ?? null);
  const runFacts: EvidenceSummaryFact[] = [
    { label: "Run ID", value: runEvidence?.runId ?? "None" },
    { label: "Run status", value: runEvidence?.status ?? "unknown" },
    ...(runEvidence?.exitCode !== null && runEvidence?.exitCode !== undefined
      ? [{ label: "Exit code", value: String(runEvidence.exitCode) }]
      : []),
    { label: "Checks", value: formatChecks(checks) },
    { label: "Artifacts", value: artifactSummary },
    ...(reviewSummary ? [{ label: "Review", value: reviewSummary }] : []),
    ...(reason ? [{ label: "Reason", value: reason }] : []),
  ];

  return {
    run: {
      id: runEvidence?.runId ?? null,
      status: runEvidence?.status ?? "unknown",
      exitCode: runEvidence?.exitCode ?? null,
    },
    reason,
    latestFailedCheck,
    checkSummary: formatChecks(checks),
    artifactSummary,
    reviewSummary,
    runFacts,
    changes,
    changeFacts,
  };
}

function summarizeChangeEvidence(
  reconciliation: FinalChangesetReconciliation | null,
  changesetInput: Changeset | null,
): RunEvidenceSummary["changes"] {
  const changeset = reconciliation?.changeset ?? changesetInput;
  const status = reconciliation?.status ?? changeset?.evidence?.status ?? "unknown";
  const files = changeset ? (changeset.evidence?.files.length ? changeset.evidence.files : changeset.files) : [];
  const diffStat = changeset?.diffStat ?? { added: 0, changed: 0, deleted: 0 };
  const repoStateSummary = repoStateSummaryForChangeEvidence(status, reconciliation, changeset);

  return {
    changesetId: changeset?.id ?? changeset?.evidence?.changesetId ?? null,
    status,
    files,
    diffStat,
    repoState: repoStateForChangeEvidence(status),
    repoStateSummary,
  };
}

function changeFactsForSummary(
  changes: RunEvidenceSummary["changes"],
  commitEvidence: EvidenceCommitSummary | null,
): EvidenceSummaryFact[] {
  const changedFileCount = changes.diffStat.changed || changes.files.length;
  const fileLabel = changedFileCount === 1 ? "file" : "files";
  const facts: EvidenceSummaryFact[] = [
    { label: "Changeset status", value: changes.status },
    {
      label: "Changed files",
      value: changes.files.length ? `${changes.files.length} (${changes.files.join(", ")})` : "None",
    },
    {
      label: "Diff stat",
      value: `+${changes.diffStat.added} / -${changes.diffStat.deleted} across ${changedFileCount} ${fileLabel}`,
    },
    { label: "Repo state", value: changes.repoStateSummary },
  ];
  const commit = commitEvidenceSummary(commitEvidence);
  if (commit) facts.push({ label: "Commit", value: commit });
  return facts;
}

function repoStateForChangeEvidence(
  status: ChangesetEvidenceStatus | FinalChangesetReconciliationStatus | "unknown",
): EvidenceRepoState {
  if (status === "empty") return "clean";
  if (status === "available" || status === "mismatch") return "dirty";
  if (status === "failed") return "failed";
  return "unknown";
}

function repoStateSummaryForChangeEvidence(
  status: ChangesetEvidenceStatus | FinalChangesetReconciliationStatus | "unknown",
  reconciliation: FinalChangesetReconciliation | null,
  changeset: Changeset | null,
): string {
  if (status === "empty") return "Clean at collection";
  if (status === "available" || status === "mismatch") return "Git changes recorded";
  if (status === "failed") return reconciliation?.errorReason ?? changeset?.evidence?.errorReason ?? "Collection failed";
  return "Not recorded";
}

function runEvidenceReason(runEvidence: RunEvidence): string | null {
  if (runEvidence.status === "timed-out") {
    const timeoutReason =
      runEvidence.errorReason ??
      runEvidence.checks.find((check) => check.kind === "run-timeout" && typeof check.detail === "string")?.detail ??
      null;
    return `Timeout: ${timeoutReason ?? "run timed out"}`;
  }
  if (runEvidence.status === "cancelled" || runEvidence.cancelReason) {
    return `Cancelled: ${runEvidence.cancelReason ?? "run cancelled"}`;
  }
  if (runEvidence.errorReason) return `Error: ${runEvidence.errorReason}`;
  if (runEvidence.status !== "failed") return null;
  const failedCheck = latestFailedCheckSummary(runEvidence.checks);
  if (failedCheck) return `Check failed: ${failedCheck}`;
  if (runEvidence.exitCode !== null && runEvidence.exitCode !== 0) return `Exit code ${runEvidence.exitCode}`;
  return null;
}

function latestFailedCheckSummary(checks: EvidenceCheck[]): string | null {
  const failedCheck = [...checks].reverse().find((check) => check.status === "failed");
  if (!failedCheck) return null;
  const detail = cleanEvidenceText(failedCheck.detail);
  return `${failedCheck.name}: ${failedCheck.status}${detail ? ` - ${detail}` : ""}`;
}

function formatChecks(checks: EvidenceCheck[]): string {
  return checks.length ? checks.map(formatEvidenceCheck).join(", ") : "None";
}

function formatEvidenceCheck(check: EvidenceCheck): string {
  const detail = cleanEvidenceText(check.detail);
  return `${check.kind} [${check.name}]: ${check.status}${detail ? ` - ${detail}` : ""}`;
}

function formatArtifacts(paths: string[], source: "recorded" | "expected" | "none"): string {
  if (!paths.length || source === "none") return "None";
  const label = source === "expected" ? " expected" : "";
  return `${paths.length}${label} (${paths.join(", ")})`;
}

function commitEvidenceSummary(commitEvidence: EvidenceCommitSummary | null): string | null {
  if (!commitEvidence) return null;
  if (commitEvidence.commitSha && commitEvidence.branch) return `${shortEvidenceSha(commitEvidence.commitSha)} on ${commitEvidence.branch}`;
  if (commitEvidence.commitSha) return shortEvidenceSha(commitEvidence.commitSha);
  if (commitEvidence.branch) return commitEvidence.branch;
  return cleanEvidenceText(commitEvidence.subject);
}

function shortEvidenceSha(value: string): string {
  return value.slice(0, 7);
}

function cleanEvidenceText(value: string | null | undefined): string | null {
  return typeof value === "string" && value.trim().length > 0 ? value : null;
}

export function canUsePtyInteractiveTransport(
  capabilities: AgentTransportCapabilities | null | undefined,
  flags: AgentTransportFeatureFlags = DEFAULT_AGENT_TRANSPORT_FEATURE_FLAGS,
): boolean {
  return flags.ptyInteractiveSessions && capabilities?.supportsPtyInteractive === true;
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
