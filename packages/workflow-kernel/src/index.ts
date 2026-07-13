import type {
  AgentKind,
  AgentRunSandbox,
  RunEvidence,
  ChangesetEvidence,
  NodeStatus,
  UserDecisionAction,
  UserDecisionAnsweredPayload,
  UserDecisionProjection,
  UserDecisionRequestedPayload,
  WorkflowLaneKind,
  WorkflowLaneSemanticSubtype,
  WorkflowNodeCheckpoint,
  WorkflowNodeCheckpointPhase,
  WorkflowNodeCheckpointSource,
  WorkflowCheckpointEvidenceRef,
  WorkflowCheckpointIntent,
  WorkflowCheckpointIntentKind,
  WorkflowRemoteSideEffectEventKind,
  WorkflowRemoteSideEffectRef,
  WorkflowRollbackEligibility,
  WorkflowRollbackLocalSafetyStatus,
  WorkflowDeliveryCheckStatus,
  WorkflowDeliveryLoopState,
  WorkflowDeliveryReviewStatus,
  WorkflowDeliveryReviewSummary,
  WorkflowLoopBlockedReason,
  WorkflowLoopEngineeringProjectionInput,
  WorkflowLoopEngineeringState,
  WorkflowLoopNextAction,
  WorkflowProjectionNodeKind,
  WorkflowRollbackLoopState,
  WorkflowRuntimePolicy,
  WorkflowSideEffectKind,
  WorkflowSuccessorLoopState,
  WorkflowVariantAdoption,
  WorkflowWorktreeIdentity,
} from "@skyturn/project-core";

export type {
  ChangesetEvidence,
  UserDecisionAnsweredPayload,
  UserDecisionRequestedPayload,
  WorkflowLaneKind,
  WorkflowLaneSemanticSubtype,
  WorkflowNodeCheckpoint,
  WorkflowCheckpointIntent,
  WorkflowRollbackEligibility,
  WorkflowLoopEngineeringProjectionInput,
  WorkflowLoopEngineeringState,
  WorkflowRuntimePolicy,
  WorkflowVariantAdoption,
  WorkflowWorktreeIdentity,
} from "@skyturn/project-core";

export type WorkflowIntentOperationType =
  | "AnalyzeRequirement"
  | "DiscoverProject"
  | "ProposeLanes"
  | "SplitLane"
  | "JoinLanes"
  | "StartImplementation"
  | "RequestValidation"
  | "RequestReview"
  | "RequestUserDecision"
  | "ReplanFromEvidence"
  | "Commit"
  | "DeclareEdge";

export interface WorkflowIntent {
  intentId: string;
  sessionId: string;
  operations: WorkflowIntentOperation[];
}

export type WorkflowIntentOperation =
  | { type: "AnalyzeRequirement"; requirement: string }
  | { type: "DiscoverProject"; profile: Partial<ProjectProfile> }
  | { type: "ProposeLanes"; lanes?: LaneSuggestion[] }
  | { type: "SplitLane"; sourceLaneId: string; lanes: LaneSuggestion[] }
  | { type: "JoinLanes"; joinLaneId: string; upstreamLaneIds: string[] }
  | { type: "StartImplementation"; laneId: string }
  | { type: "RequestValidation"; laneId: string }
  | { type: "RequestReview"; laneId: string; status?: string; agentKind?: AgentKind }
  | ({ type: "RequestUserDecision" } & UserDecisionRequestedPayload)
  | { type: "ReplanFromEvidence"; laneId: string; evidenceId: string }
  | { type: "Commit"; laneId: string }
  | { type: "DeclareEdge"; sourceLaneId: string; targetLaneId: string };

export interface ProjectProfile {
  languages: string[];
  capabilities: string[];
  packages: string[];
  hasFrontend: boolean;
  hasBackend: boolean;
  hasPersistence: boolean;
}

export interface RequirementProfile {
  text: string;
  capabilities: string[];
  risk: "low" | "medium" | "high";
}

export interface FlowPolicy {
  allowedParallelism: number;
  policyPacks: PolicyPack[];
  gateRules: GateRule[];
  joinRules: JoinRule[];
}

export interface PolicyPack {
  id: string;
  detects(input: { projectProfile: ProjectProfile; requirementProfile: RequirementProfile }): boolean;
  suggestedLanes(input: { projectProfile: ProjectProfile; requirementProfile: RequirementProfile }): LaneSuggestion[];
  evidence: string[];
  validation: string[];
  capabilities: string[];
}

export interface GateRule {
  id: string;
  description: string;
}

export interface JoinRule {
  id: string;
  upstreamLaneKinds: string[];
  joinLaneKind: string;
}

export interface LaneSuggestion {
  id: string;
  semanticKey?: string;
  kind: string;
  laneKind?: WorkflowLaneKind;
  semanticSubtype?: WorkflowLaneSemanticSubtype;
  title: string;
  agentKind?: AgentKind;
  executable?: boolean;
  runtimePolicy?: WorkflowRuntimePolicy;
  dependsOn?: string[];
  fileScopes?: string[];
  packageScopes?: string[];
  requiredEvidence?: string[];
}

export interface FlowLane {
  id: string;
  semanticKey: string;
  kind: string;
  laneKind: WorkflowLaneKind;
  semanticSubtype: WorkflowLaneSemanticSubtype;
  title: string;
  brief?: string;
  agentKind: AgentKind;
  nodeKind: WorkflowProjectionNodeKind;
  executable: boolean;
  runtimePolicy: WorkflowRuntimePolicy;
  status: FlowLaneStatus;
  rollbackStatus?: FlowLaneRollbackStatus;
  fileScopes: string[];
  packageScopes: string[];
  requiredEvidence: string[];
  output: string[];
}

export type FlowLaneStatus = "pending" | "ready" | "running" | "waiting_input" | "completed" | "failed" | "blocked";

export type FlowLaneRollbackStatus = "rolled_back" | "inactive" | "rejected";

export interface NodeStatusProjection {
  status: NodeStatus;
  rollbackStatus?: FlowLaneRollbackStatus;
}

export interface FlowEdge {
  id: string;
  sourceLaneId: string;
  targetLaneId: string;
}

export interface FlowSegment {
  id: string;
  laneId: string;
  runId: string;
  status: "running" | "succeeded" | "failed" | "cancelled" | "timed-out";
  exitCode: number | null;
}

export interface FlowEvidence {
  id: string;
  laneId: string;
  segmentId: string;
  kind: string;
  status: FlowEvidenceStatus;
  checks: string[];
  artifacts: string[];
  detail?: string;
  runEvidence?: RunEvidence;
}

export type FlowEvidenceStatus = "passed" | "failed" | "skipped" | "pending";

export type PullRequestCheckStatus = WorkflowDeliveryCheckStatus;
export type PullRequestReviewStatus = WorkflowDeliveryReviewStatus;

export interface PullRequestCheckResult {
  name: string;
  status: PullRequestCheckStatus;
  url?: string;
  detail?: string;
}

export type PullRequestReviewResult = WorkflowDeliveryReviewSummary;

export interface PullRequestChecksRecordedPayload {
  laneId: string;
  prNumber: number;
  url: string;
  headSha: string;
  status: PullRequestCheckStatus;
  checks: PullRequestCheckResult[];
  review: PullRequestReviewResult;
}

interface PullRequestHeadSnapshot {
  prNumber: number;
  headSha?: string;
  headBranch?: string;
}

interface PullRequestHeadState {
  byLaneId: Map<string, PullRequestHeadSnapshot>;
  currentByPrNumber: Map<number, PullRequestHeadSnapshot>;
}

export interface FlowProjectionNode {
  id: string;
  nodeKind: WorkflowProjectionNodeKind;
  laneId?: string;
  decisionId?: string;
  executable: boolean;
  runtimePolicy: WorkflowRuntimePolicy;
}

export type FlowEventKind =
  | "workflow.user_input"
  | "workflow.profile"
  | "workflow.intent.accepted"
  | "workflow.intent.rejected"
  | "workflow.lane.declared"
  | "workflow.lane.reassigned"
  | "workflow.edge.declared"
  | "workflow.segment.started"
  | "workflow.segment.output_delta"
  | "workflow.segment.finished"
  | "workflow.evidence.recorded"
  | "workflow.changeset.evidence_recorded"
  | "workflow.node.checkpoint_recorded"
  | "workflow.node.rollback_requested"
  | "workflow.node.rollback_applied"
  | "workflow.node.rollback_rejected"
  | "workflow.node.repair_requested"
  | "workflow.node.variant_requested"
  | "workflow.node.fork_requested"
  | "workflow.join.completed"
  | "workflow.replan.requested"
  | "workflow.user_decision.requested"
  | "workflow.user_decision.answered"
  | "workflow.commit.created"
  | "workflow.remote_side_effect.requested"
  | "workflow.remote_side_effect.completed"
  | "workflow.delivery.pushed"
  | "workflow.pull_request.created"
  | "workflow.pull_request.checks_recorded"
  | "workflow.pull_request.merged"
  | "workflow.delivery.main_synced"
  | "workflow.worktree.create_requested"
  | "workflow.worktree.created"
  | "workflow.worktree.create_failed"
  | "workflow.worktree.clean_requested"
  | "workflow.worktree.cleaned"
  | "workflow.worktree.clean_failed"
  | "workflow.variant.adopt_requested"
  | "workflow.variant.adopted"
  | "workflow.variant.adopt_failed"
  | "workflow.variant.rejected";

export interface FlowEvent {
  id: string;
  sessionId: string;
  seq: number;
  kind: FlowEventKind;
  source: string;
  payload: Record<string, unknown>;
  createdAt: string;
  idempotencyKey: string | null;
}

export interface FlowProjection {
  sessionId: string;
  events: FlowEvent[];
  lanes: FlowLane[];
  laneRollbackStatuses: Record<string, FlowLaneRollbackStatus>;
  projectionNodes: FlowProjectionNode[];
  userDecisions: UserDecisionProjection[];
  edges: FlowEdge[];
  segments: FlowSegment[];
  evidence: FlowEvidence[];
  changesetEvidence: ChangesetEvidence[];
  checkpoints: WorkflowNodeCheckpoint[];
  checkpointAuthorityFields: Record<string, Partial<Record<"laneId" | "nodeId" | "phase" | "executionTarget", true>>>;
  checkpointIntents: WorkflowCheckpointIntent[];
  rollbackIntents: WorkflowCheckpointIntent[];
  worktrees: WorkflowWorktreeIdentity[];
  variantAdoptions: WorkflowVariantAdoption[];
  rejectedIntents: Array<{ intentId: string; reason: string }>;
  acceptedIntentIds: string[];
  projectProfile: ProjectProfile | null;
  requirementProfile: RequirementProfile | null;
}

export type ParseWorkflowIntentResult =
  | { ok: true; intent: WorkflowIntent }
  | { ok: false; reason: string };

export interface CompileWorkflowIntentResult {
  ok: boolean;
  events: FlowEvent[];
  reason?: string;
}

export interface GateResult {
  allowed: boolean;
  reason: string;
}

export interface ScheduleReadyLanesInput {
  allowedParallelism: number;
  runningScopes?: Array<{ fileScopes: string[]; packageScopes: string[] }>;
}

export interface FlowKernelAcceptanceSummary {
  ok: boolean;
  root: string;
  artifacts: string[];
  scenarios: FlowKernelScenarioSummary[];
}

export interface FlowKernelScenarioSummary {
  id: string;
  repoRoot: string;
  laneKinds: string[];
  projection: FlowProjection;
  evidence: FlowEvidence[];
  commands: Array<{ command: string; exitCode: number }>;
  artifacts: string[];
}

const defaultProjectProfile: ProjectProfile = {
  languages: [],
  capabilities: [],
  packages: [],
  hasFrontend: false,
  hasBackend: false,
  hasPersistence: false,
};

const emptyRequirementProfile: RequirementProfile = {
  text: "",
  capabilities: [],
  risk: "low",
};

const remoteSideEffectEventKinds: WorkflowRemoteSideEffectEventKind[] = [
  "workflow.delivery.pushed",
  "workflow.pull_request.created",
  "workflow.pull_request.merged",
  "workflow.delivery.main_synced",
];

type RollbackRemoteSideEffectRef = WorkflowRemoteSideEffectRef & {
  affectedLaneIds?: string[];
  sessionWide?: boolean;
  operationId?: string;
};

interface PendingRemoteSideEffectRequest {
  operationId: string;
  eventKind: WorkflowRemoteSideEffectEventKind;
  eventId: string;
  laneIds: string[];
  sessionWide: boolean;
  createdAt: string;
}

type WorkflowCheckpointIntentSuccessorFields = {
  successorLaneId?: string;
  successorSemanticKey?: string;
};
type RequestedCheckpointSuccessorIntent = WorkflowCheckpointIntent &
  WorkflowCheckpointIntentSuccessorFields & {
    kind: Exclude<WorkflowCheckpointIntentKind, "rollback">;
    status: "requested";
    laneId: string;
  };

type CheckpointAuthorityField = "laneId" | "nodeId" | "phase" | "executionTarget";
type CheckpointExplicitFields = Partial<Record<CheckpointAuthorityField, true>>;
type CheckpointAuthority = {
  laneIdExplicit: boolean;
  nodeIdExplicit: boolean;
  phaseExplicit: boolean;
  executionTargetExplicit: boolean;
};
type WorkflowNodeCheckpointWithAuthority = WorkflowNodeCheckpoint & { authority: CheckpointAuthority };
type ResolvedRollbackTarget = {
  laneId?: string;
  nodeId?: string;
  checkpointId?: string;
  localRollbackSafe?: boolean;
  reason?: string;
};

export function parseWorkflowIntent(output: string): ParseWorkflowIntentResult {
  const parsed = parseFirstJsonObject(output);
  if (!parsed) return { ok: false, reason: "Hermes output must be one WorkflowIntent JSON object." };
  if (Array.isArray(parsed.toolCalls)) {
    return { ok: false, reason: "Hermes v2 must output WorkflowIntent, not workflow-card UI mutations." };
  }
  if (typeof parsed.intentId !== "string" || typeof parsed.sessionId !== "string" || !Array.isArray(parsed.operations)) {
    return { ok: false, reason: "Hermes output must match the WorkflowIntent schema." };
  }

  const operations: WorkflowIntentOperation[] = [];
  for (const raw of parsed.operations) {
    if (!isRecord(raw) || typeof raw.type !== "string" || !isWorkflowIntentOperationType(raw.type)) {
      return { ok: false, reason: "WorkflowIntent contains an unsupported operation." };
    }
    if (raw.agentKind === "hermes" && raw.status === "completed") {
      return { ok: false, reason: "Hermes cannot set a lane completed; completion is evidence-only." };
    }
    const operation = parseWorkflowIntentOperation(raw);
    if (typeof operation === "string") return { ok: false, reason: operation };
    operations.push(operation);
  }

  return {
    ok: true,
    intent: {
      intentId: parsed.intentId,
      sessionId: parsed.sessionId,
      operations,
    },
  };
}

function parseWorkflowIntentOperation(raw: Record<string, unknown>): WorkflowIntentOperation | string {
  switch (raw.type) {
    case "AnalyzeRequirement":
      return typeof raw.requirement === "string" && raw.requirement.trim()
        ? { type: raw.type, requirement: raw.requirement }
        : "AnalyzeRequirement requires a non-empty requirement.";
    case "DiscoverProject":
      return isRecord(raw.profile)
        ? { type: raw.type, profile: raw.profile }
        : "DiscoverProject requires a project profile object.";
    case "ProposeLanes": {
      if (raw.lanes === undefined) return { type: raw.type };
      const lanes = parseExternalLaneSuggestions(raw.lanes, "ProposeLanes lanes");
      return typeof lanes === "string" ? lanes : { type: raw.type, lanes };
    }
    case "SplitLane": {
      const lanes = parseExternalLaneSuggestions(raw.lanes, "SplitLane lanes");
      return typeof raw.sourceLaneId === "string" && typeof lanes !== "string"
        ? { type: raw.type, sourceLaneId: raw.sourceLaneId, lanes }
        : typeof lanes === "string" ? lanes : "SplitLane requires sourceLaneId and lanes.";
    }
    case "JoinLanes":
      return typeof raw.joinLaneId === "string" && isStringArray(raw.upstreamLaneIds) && raw.upstreamLaneIds.length > 0
        ? { type: raw.type, joinLaneId: raw.joinLaneId, upstreamLaneIds: raw.upstreamLaneIds }
        : "JoinLanes requires joinLaneId and upstreamLaneIds.";
    case "StartImplementation":
    case "RequestValidation":
    case "Commit":
      return typeof raw.laneId === "string" ? { type: raw.type, laneId: raw.laneId } : `${raw.type} requires laneId.`;
    case "RequestReview":
      return typeof raw.laneId === "string"
        ? {
            type: raw.type,
            laneId: raw.laneId,
            ...(typeof raw.status === "string" ? { status: raw.status } : {}),
            ...(typeof raw.agentKind === "string" ? { agentKind: raw.agentKind as AgentKind } : {}),
          }
        : "RequestReview requires laneId.";
    case "RequestUserDecision":
      return typeof raw.decisionId === "string" &&
        typeof raw.prompt === "string" &&
        isStringArray(raw.options) &&
        typeof raw.reason === "string"
        ? {
            type: raw.type,
            decisionId: raw.decisionId,
            prompt: raw.prompt,
            options: raw.options,
            reason: raw.reason,
            ...(typeof raw.targetLaneId === "string" ? { targetLaneId: raw.targetLaneId } : {}),
            ...(typeof raw.targetSegmentId === "string" ? { targetSegmentId: raw.targetSegmentId } : {}),
          }
        : "RequestUserDecision requires decisionId, prompt, options, and reason.";
    case "ReplanFromEvidence":
      return typeof raw.laneId === "string" && typeof raw.evidenceId === "string"
        ? { type: raw.type, laneId: raw.laneId, evidenceId: raw.evidenceId }
        : "ReplanFromEvidence requires laneId and evidenceId.";
    case "DeclareEdge":
      return typeof raw.sourceLaneId === "string" && typeof raw.targetLaneId === "string"
        ? { type: raw.type, sourceLaneId: raw.sourceLaneId, targetLaneId: raw.targetLaneId }
        : "DeclareEdge requires sourceLaneId and targetLaneId.";
  }
  return "WorkflowIntent contains an unsupported operation.";
}

function parseExternalLaneSuggestions(value: unknown, field: string): LaneSuggestion[] | string {
  if (!Array.isArray(value)) return `${field} must be an array.`;
  const lanes: LaneSuggestion[] = [];
  for (const item of value) {
    if (!isRecord(item)) return `${field} entries must be objects.`;
    const lane = parseExternalLaneSuggestion(item);
    if (typeof lane === "string") return lane;
    lanes.push(lane);
  }
  return lanes;
}

function parseExternalLaneSuggestion(raw: Record<string, unknown>): LaneSuggestion | string {
  if (!isNonEmptyString(raw.id) || !isNonEmptyString(raw.kind) || !isNonEmptyString(raw.title)) {
    return "Lane suggestions require id, kind, and title.";
  }
  const lane: LaneSuggestion = {
    id: raw.id.trim(),
    kind: raw.kind.trim(),
    laneKind: laneKindForExternalKind(raw.kind.trim()),
    title: raw.title.trim(),
  };
  if (isNonEmptyString(raw.semanticKey) && !isReservedRepairSemanticKey(raw.semanticKey.trim())) {
    lane.semanticKey = raw.semanticKey.trim();
  }
  if (isNonEmptyString(raw.semanticSubtype) && raw.semanticSubtype.trim() !== "repair") {
    lane.semanticSubtype = raw.semanticSubtype.trim();
  }
  if (isAgentKind(raw.agentKind)) lane.agentKind = raw.agentKind;
  if (Array.isArray(raw.dependsOn)) lane.dependsOn = stringArray(raw.dependsOn);
  if (Array.isArray(raw.fileScopes)) lane.fileScopes = stringArray(raw.fileScopes);
  if (Array.isArray(raw.packageScopes)) lane.packageScopes = stringArray(raw.packageScopes);
  if (Array.isArray(raw.requiredEvidence)) lane.requiredEvidence = stringArray(raw.requiredEvidence);
  return lane;
}

export function createDefaultFlowPolicy(input: Partial<Pick<FlowPolicy, "allowedParallelism">> = {}): FlowPolicy {
  return {
    allowedParallelism: input.allowedParallelism ?? 2,
    gateRules: [
      { id: "no-implementation-before-discovery", description: "Implementation requires discovery evidence." },
      { id: "review-needs-implementation-evidence", description: "Review requires implementation evidence." },
      { id: "join-needs-upstream-complete", description: "Join requires all upstream lanes complete." },
      { id: "commit-needs-review-validation", description: "Commit requires review and validation evidence." },
      { id: "acyclic-edges", description: "Edges must not create cycles." },
      { id: "intake-planner-root", description: "Planner and intake lanes cannot have incoming edges." },
      { id: "evidence-only-completion", description: "Hermes text cannot mark a lane completed." },
    ],
    joinRules: [{ id: "integration-join", upstreamLaneKinds: ["frontend_implementation", "backend_implementation", "persistence_implementation"], joinLaneKind: "integration_join" }],
    policyPacks: [
      policyPack("code-change", ["code-change"], [
        laneSuggestion("lane-implementation", "implementation", "Implement repository change", "codex", [], [], ["app"]),
        laneSuggestion("lane-validation", "validation", "Run repository tests", "codex", ["lane-implementation"]),
        laneSuggestion("lane-review", "review", "Review code evidence", "hermes", ["lane-validation"]),
        laneSuggestion("lane-commit", "commit", "Commit verified change", "codex", ["lane-review"]),
      ], ["test", "git"], ["validation"]),
      policyPack("frontend-ui", ["frontend-ui"], [
        laneSuggestion("lane-discovery", "discovery", "Discover UI surface", "hermes"),
        laneSuggestion("lane-design", "design", "Design compact control", "hermes", ["lane-discovery"]),
        laneSuggestion("lane-implementation", "implementation", "Implement UI behavior", "codex", ["lane-design"], ["src/search-filter.ts"], ["frontend"]),
        laneSuggestion("lane-browser-validation", "browser_validation", "Validate in browser", "codex", ["lane-implementation"]),
        laneSuggestion("lane-review", "review", "Review UI evidence", "hermes", ["lane-browser-validation"]),
        laneSuggestion("lane-commit", "commit", "Commit verified change", "codex", ["lane-review"]),
      ], ["browser", "screenshot"], ["browser_validation"]),
      policyPack("backend-api", ["backend-api"], [
        laneSuggestion("lane-discovery", "discovery", "Discover API surface", "hermes"),
        laneSuggestion("lane-contract-analysis", "contract_analysis", "Analyze endpoint contract", "hermes", ["lane-discovery"]),
        laneSuggestion("lane-implementation", "implementation", "Implement API endpoint", "codex", ["lane-contract-analysis"], ["src/server.mjs"], ["backend"]),
        laneSuggestion("lane-unit-test", "unit_test", "Run unit tests", "codex", ["lane-implementation"]),
        laneSuggestion("lane-integration-test", "integration_test", "Run integration tests", "codex", ["lane-unit-test"]),
        laneSuggestion("lane-review", "review", "Review API evidence", "hermes", ["lane-integration-test"]),
      ], ["unit_test", "integration_test"], ["unit_test", "integration_test"]),
      policyPack("data-script", ["data-script"], [
        laneSuggestion("lane-data-contract-analysis", "data_contract_analysis", "Analyze CSV contract", "hermes"),
        laneSuggestion("lane-implementation", "implementation", "Implement CSV cleaning", "codex", ["lane-data-contract-analysis"], ["scripts/clean.mjs"], ["data"]),
        laneSuggestion("lane-fixture-validation", "fixture_validation", "Validate CSV fixtures", "codex", ["lane-implementation"]),
        laneSuggestion("lane-regression-check", "regression_check", "Run regression check", "codex", ["lane-fixture-validation"]),
      ], ["fixture", "regression"], ["fixture_validation", "regression_check"]),
      policyPack("fullstack-settings", ["fullstack-settings"], [
        laneSuggestion("lane-discovery", "discovery", "Discover setting surfaces", "hermes"),
        laneSuggestion("lane-frontend-implementation", "frontend_implementation", "Implement settings UI", "codex", ["lane-discovery"], ["frontend/settings.mjs"], ["frontend"]),
        laneSuggestion("lane-backend-implementation", "backend_implementation", "Implement settings API", "codex", ["lane-discovery"], ["backend/settings.mjs"], ["backend"]),
        laneSuggestion("lane-persistence-implementation", "persistence_implementation", "Implement settings persistence", "codex", ["lane-discovery"], ["persistence/settings-store.mjs"], ["persistence"]),
        laneSuggestion("lane-integration-join", "integration_join", "Join settings implementation", "hermes", [
          "lane-frontend-implementation",
          "lane-backend-implementation",
          "lane-persistence-implementation",
        ]),
        laneSuggestion("lane-validation", "validation", "Validate settings flow", "codex", ["lane-integration-join"]),
        laneSuggestion("lane-review", "review", "Review settings evidence", "hermes", ["lane-validation"]),
      ], ["integration", "review"], ["validation"]),
    ],
  };
}

export function compileWorkflowIntent(
  intent: WorkflowIntent,
  projection: FlowProjection,
  policy: FlowPolicy,
  now: string,
): CompileWorkflowIntentResult {
  if (projection.acceptedIntentIds.includes(intent.intentId)) return { ok: true, events: [] };

  let working = projection;
  const events: FlowEvent[] = [
    makeEvent(working, {
      kind: "workflow.intent.accepted",
      source: "workflow-kernel",
      payload: { intentId: intent.intentId },
      now,
      idempotencyKey: `intent:${intent.intentId}:accepted`,
    }),
  ];
  working = reduceWorkflowEvents([...working.events, ...events]);

  for (const operation of intent.operations) {
    const gate = evaluateGate(working, operation);
    if (!gate.allowed) {
      return {
        ok: false,
        reason: gate.reason,
        events: [
          makeEvent(projection, {
            kind: "workflow.intent.rejected",
            source: "workflow-kernel",
            payload: { intentId: intent.intentId, reason: gate.reason },
            now,
            idempotencyKey: `intent:${intent.intentId}:rejected`,
          }),
        ],
      };
    }
    const next = compileOperation(operation, intent, working, policy, now);
    events.push(...next);
    working = reduceWorkflowEvents([...working.events, ...next]);
  }

  return { ok: true, events };
}

export function evaluateGate(projection: FlowProjection, operation: WorkflowIntentOperation): GateResult {
  if ("agentKind" in operation && operation.agentKind === "hermes" && "status" in operation && operation.status === "completed") {
    return blocked("Hermes cannot set completed; completion requires evidence.");
  }
  if (operation.type === "DeclareEdge") {
    const target = projection.lanes.find((lane) => lane.id === operation.targetLaneId);
    if (operation.sourceLaneId === operation.targetLaneId) return blocked("Edge would create a cycle.");
    if (target?.kind === "planner" || target?.kind === "intake" || /planner|intake/.test(operation.targetLaneId)) {
      return blocked("Planner/intake lanes cannot have incoming edges.");
    }
    if (createsCycle(projection.edges, operation.sourceLaneId, operation.targetLaneId)) return blocked("Edge would create a cycle.");
  }
  if (operation.type === "StartImplementation") {
    const hasDiscovery = projection.lanes.some((lane) => lane.kind === "discovery" && isCompletedLane(lane)) || Boolean(projection.projectProfile);
    if (!hasDiscovery) return blocked("Implementation before discovery is rejected.");
  }
  if (operation.type === "RequestReview") {
    const hasImplementationEvidence = projection.evidence.some((evidence) => {
      const lane = projection.lanes.find((item) => item.id === evidence.laneId);
      return evidence.status === "passed" && Boolean(lane && isCompletedLane(lane) && lane.kind.includes("implementation"));
    });
    if (!hasImplementationEvidence) return blocked("Review before implementation evidence is rejected.");
  }
  if (operation.type === "JoinLanes") {
    const incomplete = operation.upstreamLaneIds.filter((id: string) => {
      const lane = projection.lanes.find((item) => item.id === id);
      return !lane || !isCompletedLane(lane);
    });
    if (incomplete.length > 0) return blocked("Join before upstream lanes complete is rejected.");
  }
  if (operation.type === "Commit") {
    const hasReview = projection.lanes.some((lane) => lane.kind === "review" && isCompletedLane(lane));
    const hasValidation = projection.lanes.some((lane) => /validation|test|regression/.test(lane.kind) && isCompletedLane(lane));
    if (!hasReview || !hasValidation) return blocked("Commit before review and validation is rejected.");
  }
  if (operation.type === "ReplanFromEvidence") {
    const lane = projection.lanes.find((item) => item.id === operation.laneId);
    if (!lane) return blocked("Replan requires an existing failed lane.");
    if (lane.laneKind === "fix" || lane.semanticSubtype === "repair" || lane.semanticKey.startsWith("repair:")) {
      return blocked("Failed repair lanes do not automatically create second-level repair.");
    }
    if (latestSegmentForLane(projection, lane.id)?.status === "cancelled") {
      return blocked("Cancelled run does not trigger automatic repair.");
    }
    const evidence = projection.evidence.find((item) => item.id === operation.evidenceId && item.laneId === operation.laneId);
    if (!evidence || evidence.status !== "failed") return blocked("Replan requires failed evidence.");
    if (lane.status !== "failed") return blocked("Replan requires the source lane to remain failed.");
  }
  return { allowed: true, reason: "allowed" };
}

export function scheduleReadyLanes(projection: FlowProjection, input: ScheduleReadyLanesInput): FlowLane[] {
  const selected: FlowLane[] = [];
  const occupied = [...(input.runningScopes ?? [])];
  const completed = completedLaneIdsForScheduling(projection);
  const incoming = new Map<string, string[]>();
  for (const edge of projection.edges) {
    incoming.set(edge.targetLaneId, [...(incoming.get(edge.targetLaneId) ?? []), edge.sourceLaneId]);
  }

  for (const lane of projection.lanes) {
    if (selected.length >= input.allowedParallelism) break;
    if (!lane.executable) continue;
    if (isTerminalRollbackLane(lane)) continue;
    if (lane.status !== "pending" && lane.status !== "ready") continue;
    if (isBlockedByWaitingDecision(projection, lane.id)) continue;
    if (isCheckpointSuccessorWaitingForRollback(projection, lane)) continue;
    if (!(incoming.get(lane.id) ?? []).every((dependency) => dependencyIsSatisfied(projection, lane, dependency, completed))) continue;
    if (hasScopeConflict(lane, occupied)) continue;
    selected.push(lane);
    occupied.push({ fileScopes: lane.fileScopes, packageScopes: lane.packageScopes });
  }
  return selected;
}

function completedLaneIdsForScheduling(projection: FlowProjection): Set<string> {
  const staleCheckGateLaneIds = stalePullRequestCheckGateLaneIds(projection);
  return new Set(
    projection.lanes
      .filter((lane) => isCompletedLane(lane) && !staleCheckGateLaneIds.has(lane.id))
      .map((lane) => lane.id),
  );
}

function stalePullRequestCheckGateLaneIds(projection: FlowProjection): Set<string> {
  const headState: PullRequestHeadState = {
    byLaneId: new Map(),
    currentByPrNumber: new Map(),
  };
  const latestChecksByLaneId = new Map<string, PullRequestChecksRecordedPayload>();

  for (const event of projection.events) {
    if (event.kind === "workflow.delivery.pushed" || event.kind === "workflow.pull_request.created") {
      rememberPullRequestHead(headState, event.payload);
    }
    if (event.kind === "workflow.pull_request.checks_recorded") {
      const recorded = normalizePullRequestChecksRecorded(event);
      if (recorded) latestChecksByLaneId.set(recorded.payload.laneId, recorded.payload);
    }
  }

  const stale = new Set<string>();
  for (const [laneId, payload] of latestChecksByLaneId) {
    const lane = projection.lanes.find((item) => item.id === laneId);
    if (!lane || !isPullRequestCheckGateLane(lane)) continue;
    if (!pullRequestChecksAllowMerge(payload) || !matchesCurrentPullRequestHead(headState, payload)) {
      stale.add(laneId);
    }
  }
  return stale;
}

export function projectLoopEngineeringState(
  projection: FlowProjection,
  input: WorkflowLoopEngineeringProjectionInput = {},
): WorkflowLoopEngineeringState {
  const delivery = projectDeliveryLoopState(projection);
  const rollback = projectRollbackLoopState(projection, input);
  const repair = projectSuccessorLoopState(projection, "repair");
  const variant = projectSuccessorLoopState(projection, "variant");
  const nextAction = projectNextLoopAction(projection, delivery, rollback, input);
  const blockedReason = rollback.blockedReason ?? delivery.blockedReason;
  return {
    sessionId: projection.sessionId,
    throughSeq: projection.events.at(-1)?.seq ?? 0,
    nextAction,
    ...(blockedReason ? { blockedReason } : {}),
    evidenceStale: delivery.evidenceStale,
    delivery,
    rollback,
    repair,
    variant,
  };
}

function projectNextLoopAction(
  projection: FlowProjection,
  delivery: WorkflowDeliveryLoopState,
  rollback: WorkflowRollbackLoopState,
  input: WorkflowLoopEngineeringProjectionInput,
): WorkflowLoopNextAction {
  if (rollback.phase === "blocked" && rollback.blockedReason) {
    return {
      kind: "blocked",
      loop: "rollback",
      laneId: rollback.targetLaneId,
      checkpointId: rollback.checkpointId,
      reason: rollback.blockedReason.message,
    };
  }
  if (rollback.phase === "ready") {
    return {
      kind: "rollback_node",
      loop: "rollback",
      laneId: rollback.targetLaneId,
      checkpointId: rollback.checkpointId,
      reason: "Rollback is locally eligible.",
    };
  }
  if (delivery.phase === "merge_ready") {
    return {
      kind: "merge_pull_request",
      loop: "delivery",
      laneId: delivery.checkLaneId ?? delivery.pullRequestLaneId,
      reason: "Pull request checks passed for the current head.",
      ...(delivery.prNumber ? { prNumber: delivery.prNumber } : {}),
      ...(delivery.headSha ? { headSha: delivery.headSha } : {}),
    };
  }
  if (delivery.blockedReason) {
    if (delivery.blockedReason.code === "pending_checks") {
      return {
        kind: "wait_for_checks",
        loop: "delivery",
        laneId: delivery.checkLaneId ?? delivery.pullRequestLaneId,
        reason: delivery.blockedReason.message,
        ...(delivery.prNumber ? { prNumber: delivery.prNumber } : {}),
        ...(delivery.headSha ? { headSha: delivery.headSha } : {}),
      };
    }
    if (delivery.blockedReason.code === "failed_checks") {
      return {
        kind: "fix_failed_checks",
        loop: "delivery",
        laneId: delivery.checkLaneId ?? delivery.pullRequestLaneId,
        reason: delivery.blockedReason.message,
        ...(delivery.prNumber ? { prNumber: delivery.prNumber } : {}),
        ...(delivery.headSha ? { headSha: delivery.headSha } : {}),
      };
    }
    return {
      kind: "blocked",
      loop: "delivery",
      laneId: delivery.checkLaneId ?? delivery.pullRequestLaneId,
      reason: delivery.blockedReason.message,
      ...(delivery.prNumber ? { prNumber: delivery.prNumber } : {}),
      ...(delivery.headSha ? { headSha: delivery.headSha } : {}),
    };
  }

  const readyLane = scheduleReadyLanes(projection, { allowedParallelism: input.allowedParallelism ?? 1 })[0];
  if (readyLane) {
    return {
      kind: "execute_lane",
      loop: "execution",
      laneId: readyLane.id,
      reason: "Lane dependencies are satisfied.",
    };
  }

  const failedLane = [...projection.lanes].reverse().find((lane) =>
    lane.status === "failed" && !isTerminalRollbackLane(lane) && lane.semanticSubtype !== "repair"
  );
  if (failedLane) {
    return {
      kind: "request_repair",
      loop: "repair",
      laneId: failedLane.id,
      reason: "Failed lane needs a repair successor.",
    };
  }

  return { kind: "none", reason: "No safe loop action is currently available." };
}

function projectDeliveryLoopState(projection: FlowProjection): WorkflowDeliveryLoopState {
  const headState: PullRequestHeadState = {
    byLaneId: new Map(),
    currentByPrNumber: new Map(),
  };
  let phase: WorkflowDeliveryLoopState["phase"] = "not_started";
  let pullRequestLaneId: string | undefined;
  let checkLaneId: string | undefined;
  let prNumber: number | undefined;
  let headSha: string | undefined;
  let headBranch: string | undefined;
  let lastCheckedHeadSha: string | undefined;
  let checks: WorkflowDeliveryLoopState["checks"] = [];
  let review: WorkflowDeliveryReviewSummary = { status: "unknown" };
  let evidenceStale = false;

  for (const event of projection.events) {
    if (event.kind === "workflow.delivery.pushed") {
      rememberPullRequestHead(headState, event.payload);
      phase = phase === "not_started" ? "pushed" : phase;
      const current = currentPullRequestHead(headState, prNumber, pullRequestLaneId);
      headSha = current?.headSha ?? headSha;
      headBranch = current?.headBranch ?? headBranch;
    }
    if (event.kind === "workflow.pull_request.created") {
      rememberPullRequestHead(headState, event.payload);
      pullRequestLaneId = stringValue(event.payload.laneId) ?? pullRequestLaneId;
      prNumber = numberValue(event.payload.prNumber) ??
        (isRecord(event.payload.evidence) ? numberValue(event.payload.evidence.number) : null) ??
        prNumber;
      const current = currentPullRequestHead(headState, prNumber, pullRequestLaneId);
      headSha = current?.headSha ?? pullRequestHeadSha(event.payload) ?? headSha;
      headBranch = current?.headBranch ?? pullRequestHeadBranch(event.payload) ?? headBranch;
      phase = "pr_created";
      evidenceStale = false;
    }
    if (event.kind === "workflow.pull_request.checks_recorded") {
      const recorded = normalizePullRequestChecksRecorded(event);
      if (!recorded) continue;
      checkLaneId = recorded.payload.laneId;
      prNumber = recorded.payload.prNumber;
      lastCheckedHeadSha = recorded.payload.headSha;
      checks = recorded.payload.checks;
      review = recorded.payload.review;
      const current = currentPullRequestHead(headState, prNumber, checkLaneId);
      headSha = current?.headSha ?? headSha;
      headBranch = current?.headBranch ?? headBranch;
      const exactHead = matchesCurrentPullRequestHead(headState, recorded.payload);
      evidenceStale = !exactHead;
      if (!exactHead) {
        phase = "checks_stale";
        continue;
      }
      phase = review.status === "changes_requested" || recorded.payload.status === "changes_requested"
        ? "changes_requested"
        : recorded.payload.status === "passed" && reviewStatusAllowsMerge(review.status)
        ? "merge_ready"
        : recorded.payload.status === "failed"
          ? "checks_failed"
          : "checks_pending";
    }
    if (event.kind === "workflow.pull_request.merged") {
      phase = "merged";
      evidenceStale = false;
    }
    if (event.kind === "workflow.delivery.main_synced") {
      phase = "main_synced";
      evidenceStale = false;
    }
  }

  const finalHead = currentPullRequestHead(headState, prNumber, checkLaneId ?? pullRequestLaneId);
  headSha = finalHead?.headSha ?? headSha;
  headBranch = finalHead?.headBranch ?? headBranch;
  if (headShaChangedAfterChecks(phase, headSha, lastCheckedHeadSha)) {
    phase = "checks_stale";
    evidenceStale = true;
  }

  const blockedReason = deliveryBlockedReason(phase, checkLaneId ?? pullRequestLaneId);
  return {
    phase,
    evidenceStale,
    ...(pullRequestLaneId ? { pullRequestLaneId } : {}),
    ...(checkLaneId ? { checkLaneId } : {}),
    ...(prNumber ? { prNumber } : {}),
    ...(headSha ? { headSha } : {}),
    ...(headBranch ? { headBranch } : {}),
    ...(lastCheckedHeadSha ? { lastCheckedHeadSha } : {}),
    checks,
    review,
    ...(blockedReason ? { blockedReason } : {}),
  };
}

function pullRequestChecksAllowMerge(payload: PullRequestChecksRecordedPayload): boolean {
  return payload.status === "passed" && reviewStatusAllowsMerge(payload.review.status);
}

function reviewStatusAllowsMerge(status: WorkflowDeliveryReviewStatus): boolean {
  return status === "approved" || status === "pending";
}

function headShaChangedAfterChecks(
  phase: WorkflowDeliveryLoopState["phase"],
  headSha: string | undefined,
  lastCheckedHeadSha: string | undefined,
): boolean {
  return Boolean(
    headSha &&
    lastCheckedHeadSha &&
    headSha !== lastCheckedHeadSha &&
    phase !== "merged" &&
    phase !== "main_synced",
  );
}

function currentPullRequestHead(
  state: PullRequestHeadState,
  prNumber: number | undefined,
  laneId: string | undefined,
): PullRequestHeadSnapshot | undefined {
  return (typeof prNumber === "number" ? state.currentByPrNumber.get(prNumber) : undefined) ??
    (laneId ? state.byLaneId.get(laneId) : undefined);
}

function deliveryBlockedReason(
  phase: WorkflowDeliveryLoopState["phase"],
  laneId: string | undefined,
): WorkflowLoopBlockedReason | undefined {
  if (phase === "pr_created" || phase === "checks_pending") {
    return {
      code: "pending_checks",
      message: "Pull request checks are pending for the current head.",
      ...(laneId ? { laneId } : {}),
    };
  }
  if (phase === "checks_stale") {
    return {
      code: "stale_head",
      message: "Pull request checks are stale for the current head.",
      ...(laneId ? { laneId } : {}),
    };
  }
  if (phase === "checks_failed") {
    return {
      code: "failed_checks",
      message: "Pull request checks failed for the current head.",
      ...(laneId ? { laneId } : {}),
    };
  }
  if (phase === "changes_requested") {
    return {
      code: "changes_requested",
      message: "Pull request review requested changes for the current head.",
      ...(laneId ? { laneId } : {}),
    };
  }
  return undefined;
}

function projectRollbackLoopState(
  projection: FlowProjection,
  input: WorkflowLoopEngineeringProjectionInput,
): WorkflowRollbackLoopState {
  const latestIntent = [...projection.rollbackIntents].reverse().find((intent) => intent.laneId);
  const targetLaneId = input.selectedLaneId ?? latestIntent?.laneId;
  const targetIntent = targetLaneId
    ? [...projection.rollbackIntents].reverse().find((intent) => intent.laneId === targetLaneId)
    : undefined;
  if (!targetLaneId) {
    return {
      phase: "not_requested",
      affectedLaneIds: [],
      downstreamInactiveLaneIds: [],
      remoteBlockers: [],
    };
  }

  const checkpointId = targetIntent?.checkpointId ?? latestBeforeCheckpointIdForLane(projection, targetLaneId);
  const eligibility = evaluateRollbackEligibility(projection, targetLaneId, {
    ...(checkpointId ? { checkpointId } : {}),
    ...(targetIntent?.nodeId ? { targetNodeId: targetIntent.nodeId } : {}),
    ...(typeof input.localRollbackSafe === "boolean" ? { localRollbackSafe: input.localRollbackSafe } : {}),
  });
  const blockedReason = eligibility.eligible ? undefined : rollbackLoopBlockedReason(eligibility);
  const phase = targetIntent?.status === "applied"
    ? "applied"
    : targetIntent?.status === "rejected"
      ? "rejected"
      : blockedReason
        ? "blocked"
        : targetIntent?.status === "requested"
          ? "requested"
          : "ready";

  return {
    phase,
    targetLaneId,
    ...(eligibility.targetNodeId ? { targetNodeId: eligibility.targetNodeId } : {}),
    ...(eligibility.checkpointId ? { checkpointId: eligibility.checkpointId } : {}),
    ...(eligibility.checkpointPhase ? { checkpointPhase: eligibility.checkpointPhase } : {}),
    ...(eligibility.restoreCommitRef ? { restoreCommitRef: eligibility.restoreCommitRef } : {}),
    affectedLaneIds: eligibility.affectedLaneIds,
    ...(eligibility.affectedNodeIds ? { affectedNodeIds: eligibility.affectedNodeIds } : {}),
    downstreamInactiveLaneIds: eligibility.downstreamInactiveLaneIds,
    ...(eligibility.downstreamInactiveNodeIds ? { downstreamInactiveNodeIds: eligibility.downstreamInactiveNodeIds } : {}),
    remoteBlockers: eligibility.blockingRemoteSideEffects,
    ...(typeof eligibility.localRollbackSafe === "boolean" ? { localRollbackSafe: eligibility.localRollbackSafe } : {}),
    ...(eligibility.localSafetyStatus ? { localSafetyStatus: eligibility.localSafetyStatus } : {}),
    ...(eligibility.manualRepairReason ? { manualRepairReason: eligibility.manualRepairReason } : {}),
    ...(blockedReason ? { blockedReason } : {}),
  };
}

function latestBeforeCheckpointIdForLane(projection: FlowProjection, laneId: string): string | undefined {
  return [...projection.checkpoints].reverse().find((checkpoint) => checkpoint.laneId === laneId && checkpoint.phase === "before")?.id;
}

function rollbackLoopBlockedReason(eligibility: WorkflowRollbackEligibility): WorkflowLoopBlockedReason {
  if (eligibility.blockingRemoteSideEffects.length > 0) {
    return {
      code: "remote_side_effect",
      message: "Rollback is blocked by remote side effects.",
      affectedLaneIds: eligibility.affectedLaneIds,
      eventKinds: uniqueWorkflowRemoteSideEffectKinds(eligibility.blockingRemoteSideEffects),
      remoteSideEffects: eligibility.blockingRemoteSideEffects,
    };
  }
  if (eligibility.localRollbackSafe === false) {
    return {
      code: "local_rollback_unsafe",
      message: eligibility.reason ?? "Local rollback is not safe.",
      affectedLaneIds: eligibility.affectedLaneIds,
      localRollbackSafe: false,
    };
  }
  if (eligibility.affectedLaneIds.length === 0) {
    return {
      code: "unknown_target",
      message: eligibility.reason ?? "Rollback target lane does not exist.",
      affectedLaneIds: [],
    };
  }
  return {
    code: "invalid_checkpoint",
    message: eligibility.reason ?? "Rollback checkpoint is invalid.",
    affectedLaneIds: eligibility.affectedLaneIds,
  };
}

function uniqueWorkflowRemoteSideEffectKinds(
  refs: WorkflowRemoteSideEffectRef[],
): WorkflowRemoteSideEffectEventKind[] {
  return [...new Set(refs.map((ref) => ref.eventKind))];
}

function projectSuccessorLoopState(
  projection: FlowProjection,
  kind: "repair" | "variant",
): WorkflowSuccessorLoopState {
  const intent = [...projection.checkpointIntents].reverse().find((item) => item.kind === kind);
  if (!intent) return { phase: "not_requested" };
  const sourceLaneId = checkpointIntentTargetLaneId(projection, intent) ?? intent.laneId;
  const successorLane = successorLaneForIntent(projection, intent);
  if (intent.status === "rejected") {
    return {
      phase: "rejected",
      ...(sourceLaneId ? { sourceLaneId } : {}),
      ...(intent.checkpointId ? { checkpointId: intent.checkpointId } : {}),
      ...checkpointSuccessorFields(intent),
      ...checkpointIntentInstruction(intent),
    };
  }
  const phase = successorLane?.status === "completed"
    ? "completed"
    : successorLane?.status === "running" || successorLane?.status === "waiting_input"
      ? "running"
      : successorLane && scheduleReadyLanes(projection, { allowedParallelism: Number.MAX_SAFE_INTEGER }).some((lane) => lane.id === successorLane.id)
        ? "ready"
        : "requested";
  return {
    phase,
    ...(sourceLaneId ? { sourceLaneId } : {}),
    ...(intent.checkpointId ? { checkpointId: intent.checkpointId } : {}),
    ...checkpointSuccessorFields(intent),
    ...checkpointIntentInstruction(intent),
  };
}

function successorLaneForIntent(projection: FlowProjection, intent: WorkflowCheckpointIntent): FlowLane | undefined {
  const fields = checkpointSuccessorFields(intent);
  return projection.lanes.find((lane) => {
    const laneIdMatches = fields.successorLaneId ? lane.id === fields.successorLaneId : true;
    const semanticKeyMatches = fields.successorSemanticKey ? lane.semanticKey === fields.successorSemanticKey : true;
    return laneIdMatches && semanticKeyMatches;
  });
}

function checkpointSuccessorFields(
  intent: WorkflowCheckpointIntent,
): { successorLaneId?: string; successorSemanticKey?: string } {
  return {
    ...("successorLaneId" in intent && intent.successorLaneId ? { successorLaneId: intent.successorLaneId } : {}),
    ...("successorSemanticKey" in intent && intent.successorSemanticKey ? { successorSemanticKey: intent.successorSemanticKey } : {}),
  };
}

function checkpointIntentInstruction(intent: WorkflowCheckpointIntent): { instruction?: string } {
  return "instruction" in intent && intent.instruction ? { instruction: intent.instruction } : {};
}

export function evaluateRollbackEligibility(
  projection: FlowProjection,
  targetLaneId: string,
  input: { localRollbackSafe?: boolean; checkpointId?: string; targetNodeId?: string; throughSeq?: number } = {},
): WorkflowRollbackEligibility {
  const affectedLaneIds = affectedRollbackLaneIds(projection, targetLaneId);
  const latestRequest = [...projection.rollbackIntents].reverse().find((intent) => intent.laneId === targetLaneId);
  const checkpointId = input.checkpointId ?? latestRequest?.checkpointId;
  const checkpointValidation = validateRollbackCheckpoint(projection, targetLaneId, checkpointId, {
    targetNodeId: input.targetNodeId,
  });
  const resolvedCheckpointId = checkpointValidation.checkpoint?.id;
  const checkpointPhase = checkpointValidation.checkpoint?.phase;
  const restoreCommitRef = checkpointValidation.reason || !checkpointValidation.checkpoint
    ? undefined
    : checkpointRestoreCommitRef(checkpointValidation.checkpoint);
  const nodeIdByLaneId = rollbackNodeIdByLaneId(
    affectedLaneIds,
    targetLaneId,
    input.targetNodeId,
    checkpointValidation.checkpoint,
  );
  const affectedNodeIds = affectedLaneIds.length > 0 ? affectedLaneIds.map((laneId) => nodeIdByLaneId.get(laneId) ?? laneId) : undefined;
  const downstreamInactiveLaneIds = downstreamInactiveRollbackLaneIds(projection, targetLaneId, affectedLaneIds);
  const downstreamInactiveNodeIds = affectedNodeIds
    ? downstreamInactiveLaneIds.map((laneId) => nodeIdByLaneId.get(laneId) ?? laneId)
    : undefined;
  const blockingRemoteSideEffects = remoteSideEffectsForLanes(projection, new Set(affectedLaneIds), input.throughSeq);
  const inheritedLocalRollbackSafe = latestRequest?.status === "rejected" ? undefined : latestRequest?.localRollbackSafe;
  const localRollbackSafe = input.localRollbackSafe ?? inheritedLocalRollbackSafe;
  const localRollbackBlocked = localRollbackSafe === false;
  const localSafetyStatus = rollbackLocalSafetyStatus(localRollbackSafe);
  const manualRepairReason = localRollbackBlocked ? "Local rollback is not safe." : undefined;
  const reason =
    affectedLaneIds.length === 0
      ? "Rollback target lane does not exist."
      : checkpointValidation.reason
        ? checkpointValidation.reason
        : localRollbackBlocked
          ? "Local rollback is not safe."
          : blockingRemoteSideEffects.length > 0
            ? "Remote side effects exist."
            : "Rollback eligible.";
  return {
    eligible: affectedLaneIds.length > 0 && !checkpointValidation.reason && !localRollbackBlocked && blockingRemoteSideEffects.length === 0,
    targetLaneId,
    ...(input.targetNodeId ? { targetNodeId: input.targetNodeId } : {}),
    ...(!input.targetNodeId && !checkpointValidation.reason && checkpointValidation.checkpoint?.nodeId
      ? { targetNodeId: checkpointValidation.checkpoint.nodeId }
      : {}),
    ...(resolvedCheckpointId ? { checkpointId: resolvedCheckpointId } : {}),
    ...(checkpointPhase ? { checkpointPhase } : {}),
    ...(restoreCommitRef ? { restoreCommitRef } : {}),
    affectedLaneIds,
    ...(affectedNodeIds ? { affectedNodeIds } : {}),
    downstreamInactiveLaneIds,
    ...(downstreamInactiveNodeIds ? { downstreamInactiveNodeIds } : {}),
    blockingRemoteSideEffects,
    ...(typeof localRollbackSafe === "boolean" ? { localRollbackSafe } : {}),
    localSafetyStatus,
    ...(manualRepairReason ? { manualRepairReason } : {}),
    reason,
  };
}

export function nodeStatusProjectionForFlowLane(lane: FlowLane): NodeStatusProjection;
export function nodeStatusProjectionForFlowLane(status: FlowLaneStatus, rollbackStatus?: FlowLaneRollbackStatus): NodeStatusProjection;
export function nodeStatusProjectionForFlowLane(
  laneOrStatus: FlowLane | FlowLaneStatus,
  rollbackStatus?: FlowLaneRollbackStatus,
): NodeStatusProjection {
  const status = typeof laneOrStatus === "string" ? laneOrStatus : laneOrStatus.status;
  const canonicalRollbackStatus = typeof laneOrStatus === "string" ? rollbackStatus : laneOrStatus.rollbackStatus ?? rollbackStatus;
  if (isTerminalRollbackStatus(canonicalRollbackStatus)) {
    return { status: "failed", rollbackStatus: canonicalRollbackStatus };
  }
  if (status === "completed") {
    return canonicalRollbackStatus ? { status: "completed", rollbackStatus: canonicalRollbackStatus } : { status: "completed" };
  }
  const nodeStatus = status === "failed" || status === "blocked"
    ? "failed"
    : status === "running" || status === "waiting_input"
      ? "running"
      : "pending";
  return canonicalRollbackStatus ? { status: nodeStatus, rollbackStatus: canonicalRollbackStatus } : { status: nodeStatus };
}

export function nodeStatusProjectionForFlowLaneStatus(
  status: FlowLaneStatus,
  rollbackStatus?: FlowLaneRollbackStatus,
): NodeStatusProjection {
  return nodeStatusProjectionForFlowLane(status, rollbackStatus);
}

export function reduceWorkflowEvents(events: FlowEvent[]): FlowProjection {
  const unique = dedupeEvents(events);
  const projection = emptyFlowProjection(unique[0]?.sessionId ?? "session-1");
  projection.events = unique;
  const pullRequestHeadState: PullRequestHeadState = {
    byLaneId: new Map(),
    currentByPrNumber: new Map(),
  };
  const checkpointExplicitFields = new Map<string, CheckpointExplicitFields>();
  const declaredLaneStatuses = new Map<string, FlowLaneStatus>();

  for (const event of unique) {
    if (event.kind === "workflow.profile") {
      if (isRecord(event.payload.projectProfile)) {
        projection.projectProfile = normalizeProjectProfile(event.payload.projectProfile);
      }
      if (isRecord(event.payload.requirementProfile)) {
        projection.requirementProfile = normalizeRequirementProfile(event.payload.requirementProfile);
      }
    }
    if (event.kind === "workflow.intent.accepted" && typeof event.payload.intentId === "string") {
      projection.acceptedIntentIds.push(event.payload.intentId);
    }
    if (event.kind === "workflow.intent.rejected" && typeof event.payload.intentId === "string" && typeof event.payload.reason === "string") {
      projection.rejectedIntents.push({ intentId: event.payload.intentId, reason: event.payload.reason });
    }
    if (event.kind === "workflow.lane.declared" && isRecord(event.payload.lane)) {
      const normalizedLane = normalizeLane(event.payload.lane);
      declaredLaneStatuses.set(normalizedLane.id, normalizedLane.status);
      upsertLane(projection, normalizedLane);
      restoreRollbackSuccessorsForRequestedIntents(projection, declaredLaneStatuses);
    }
    if (
      event.kind === "workflow.lane.reassigned" &&
      typeof event.payload.laneId === "string" &&
      isAgentKind(event.payload.agentKind)
    ) {
      const agentKind = event.payload.agentKind;
      projection.lanes = projection.lanes.map((lane) =>
        lane.id === event.payload.laneId ? { ...lane, agentKind } : lane
      );
    }
    if (event.kind === "workflow.edge.declared" && isRecord(event.payload.edge)) {
      upsertEdge(projection, normalizeEdge(event.payload.edge));
    }
    if (event.kind === "workflow.segment.started" && isRecord(event.payload.segment)) {
      const segment = normalizeSegment(event.payload.segment);
      upsertSegment(projection, segment);
      setLaneStatus(projection, segment.laneId, "running");
    }
    if (event.kind === "workflow.segment.output_delta") {
      const laneId = typeof event.payload.laneId === "string" ? event.payload.laneId : null;
      const text = typeof event.payload.text === "string" ? event.payload.text : null;
      if (laneId && text) appendLaneOutput(projection, laneId, text);
    }
    if (event.kind === "workflow.segment.finished") {
      const segmentId = typeof event.payload.segmentId === "string" ? event.payload.segmentId : null;
      const laneId = typeof event.payload.laneId === "string" ? event.payload.laneId : null;
      const status = normalizeSegmentStatus(event.payload.status);
      if (segmentId) updateSegment(projection, segmentId, status, numberOrNull(event.payload.exitCode));
      if (laneId && status !== "succeeded") setLaneStatus(projection, laneId, "failed");
    }
    if (event.kind === "workflow.evidence.recorded" && isRecord(event.payload.evidence)) {
      const laneId = typeof event.payload.laneId === "string" ? event.payload.laneId : "";
      const segmentId = typeof event.payload.segmentId === "string" ? event.payload.segmentId : "";
      const evidence = normalizeEvidence(event.payload.evidence, laneId, segmentId);
      projection.evidence.push(evidence);
      if (evidence.status === "passed") setLaneStatus(projection, evidence.laneId, "completed");
    }
    if (event.kind === "workflow.changeset.evidence_recorded" && isRecord(event.payload.evidence)) {
      projection.changesetEvidence.push(event.payload.evidence as unknown as ChangesetEvidence);
    }
    if (event.kind === "workflow.node.checkpoint_recorded" && isRecord(event.payload.checkpoint)) {
      const checkpointId = stringValue(event.payload.checkpoint.id);
      const existing = checkpointId ? projection.checkpoints.find((item) => item.id === checkpointId) : undefined;
      const explicitFields = checkpointExplicitAuthorityFields(event.payload.checkpoint);
      upsertNodeCheckpoint(
        projection,
        normalizeNodeCheckpoint(
          event.payload.checkpoint,
          event,
          existing,
          checkpointId ? checkpointExplicitFields.get(checkpointId) : undefined,
        ),
        explicitFields,
        checkpointExplicitFields,
      );
    }
    if (event.kind === "workflow.node.rollback_requested") {
      applyRollbackRequest(projection, event);
    }
    if (event.kind === "workflow.node.rollback_applied") {
      applyRollbackApplied(projection, event, declaredLaneStatuses);
    }
    if (event.kind === "workflow.node.rollback_rejected") {
      upsertCheckpointIntent(projection.rollbackIntents, normalizeRollbackRejectedEvent(projection, event));
    }
    if (event.kind === "workflow.node.repair_requested") {
      const intent = normalizeCheckpointIntent(projection, event, "repair", "after");
      upsertCheckpointIntent(projection.checkpointIntents, intent);
      restoreRollbackSuccessorsForIntent(projection, intent, declaredLaneStatuses);
    }
    if (event.kind === "workflow.node.variant_requested") {
      const intent = normalizeCheckpointIntent(projection, event, "variant", "before");
      upsertCheckpointIntent(projection.checkpointIntents, intent);
      restoreRollbackSuccessorsForIntent(projection, intent, declaredLaneStatuses);
    }
    if (event.kind === "workflow.node.fork_requested") {
      const intent = normalizeCheckpointIntent(projection, event, "fork", "before");
      upsertCheckpointIntent(projection.checkpointIntents, intent);
      restoreRollbackSuccessorsForIntent(projection, intent, declaredLaneStatuses);
    }
    if (event.kind === "workflow.user_decision.requested") {
      upsertUserDecision(projection, normalizeUserDecisionRequested(event.payload));
    }
    if (event.kind === "workflow.user_decision.answered") {
      answerUserDecision(projection, normalizeUserDecisionAnswered(event.payload));
    }
    if (event.kind === "workflow.delivery.pushed") {
      const evidence = normalizeDeliveryPushEvidence(event);
      if (evidence) projection.evidence.push(evidence);
      rememberPullRequestHead(pullRequestHeadState, event.payload);
    }
    if (event.kind === "workflow.pull_request.created") {
      const evidence = normalizePullRequestCreatedEvidence(event);
      if (evidence) projection.evidence.push(evidence);
      rememberPullRequestHead(pullRequestHeadState, event.payload);
    }
    if (event.kind === "workflow.pull_request.checks_recorded") {
      const checks = normalizePullRequestChecksRecorded(event);
      if (checks) {
        projection.evidence.push(checks.evidence);
        const lane = projection.lanes.find((item) => item.id === checks.payload.laneId);
        if (
          lane &&
          isPullRequestCheckGateLane(lane) &&
          pullRequestChecksAllowMerge(checks.payload) &&
          matchesCurrentPullRequestHead(pullRequestHeadState, checks.payload)
        ) {
          setLaneStatus(projection, lane.id, "completed");
        }
      }
    }
    if (event.kind === "workflow.worktree.created" && isRecord(event.payload.worktree)) {
      upsertWorktree(projection, event.payload.worktree as unknown as WorkflowWorktreeIdentity);
    }
    if (event.kind === "workflow.worktree.clean_failed") continue;
    if (
      (event.kind === "workflow.variant.adopt_requested" ||
        event.kind === "workflow.variant.adopted" ||
        event.kind === "workflow.variant.adopt_failed" ||
        event.kind === "workflow.variant.rejected") &&
      isRecord(event.payload.adoption)
    ) {
      upsertVariantAdoption(projection, event.payload.adoption as unknown as WorkflowVariantAdoption);
    }
    if (event.kind === "workflow.join.completed") {
      const laneId = typeof event.payload.laneId === "string" ? event.payload.laneId : null;
      if (laneId) setLaneStatus(projection, laneId, "completed");
    }
    if (event.kind === "workflow.commit.created") {
      const laneId = typeof event.payload.laneId === "string" ? event.payload.laneId : null;
      const lane = projection.lanes.find((item) => item.id === laneId);
      if (lane?.laneKind === "commit") setLaneStatus(projection, lane.id, "completed");
    }
  }

  refreshProjectionNodes(projection);
  return projection;
}

function compileOperation(
  operation: WorkflowIntentOperation,
  intent: WorkflowIntent,
  projection: FlowProjection,
  policy: FlowPolicy,
  now: string,
): FlowEvent[] {
  if (operation.type === "AnalyzeRequirement") {
    return [
      makeEvent(projection, {
        kind: "workflow.profile",
        source: "workflow-kernel",
        payload: { requirementProfile: inferRequirementProfile(operation.requirement) },
        now,
        idempotencyKey: `intent:${intent.intentId}:requirement-profile`,
      }),
    ];
  }
  if (operation.type === "DiscoverProject") {
    return [
      makeEvent(projection, {
        kind: "workflow.profile",
        source: "workflow-kernel",
        payload: { projectProfile: normalizeProjectProfile(operation.profile) },
        now,
        idempotencyKey: `intent:${intent.intentId}:project-profile`,
      }),
    ];
  }
  if (operation.type === "ProposeLanes") {
    const projectProfile = projection.projectProfile ?? defaultProjectProfile;
    const requirementProfile = projection.requirementProfile ?? emptyRequirementProfile;
    return laneAndEdgeEvents(
      projection,
      operation.lanes ?? suggestedLanesForPolicy(policy, projectProfile, requirementProfile),
      now,
      `intent:${intent.intentId}`,
    );
  }
  if (operation.type === "SplitLane") {
    return laneAndEdgeEvents(projection, operation.lanes, now, `intent:${intent.intentId}:split:${operation.sourceLaneId}`);
  }
  if (operation.type === "JoinLanes") {
    return laneAndEdgeEvents(
      projection,
      [laneSuggestion(operation.joinLaneId, "integration_join", "Join upstream work", "hermes", operation.upstreamLaneIds)],
      now,
      `intent:${intent.intentId}:join:${operation.joinLaneId}`,
    );
  }
  if (operation.type === "RequestUserDecision") {
    return [
      makeEvent(projection, {
        kind: "workflow.user_decision.requested",
        source: "workflow-kernel",
        payload: {
          decisionId: operation.decisionId,
          prompt: operation.prompt,
          options: operation.options,
          reason: operation.reason,
          ...(operation.targetLaneId ? { targetLaneId: operation.targetLaneId } : {}),
          ...(operation.targetSegmentId ? { targetSegmentId: operation.targetSegmentId } : {}),
        },
        now,
        idempotencyKey: `decision:${operation.decisionId}:requested`,
      }),
    ];
  }
  if (operation.type === "ReplanFromEvidence") {
    const replanEvent = makeEvent(projection, {
      kind: "workflow.replan.requested",
      source: "workflow-kernel",
      payload: { laneId: operation.laneId, evidenceId: operation.evidenceId },
      now,
      idempotencyKey: `replan:${operation.laneId}:${operation.evidenceId}:requested`,
    });
    const working = reduceWorkflowEvents([...projection.events, replanEvent]);
    return [
      replanEvent,
      ...laneAndEdgeEvents(
        working,
        repairLaneSuggestionsForEvidence(working, operation.laneId, operation.evidenceId),
        now,
        `repair:${operation.laneId}:${operation.evidenceId}`,
      ),
    ];
  }
  return [];
}

function repairLaneSuggestionsForEvidence(
  projection: FlowProjection,
  failedLaneId: string,
  evidenceId: string,
): LaneSuggestion[] {
  const failedLane = projection.lanes.find((lane) => lane.id === failedLaneId);
  const evidence = projection.evidence.find((item) => item.id === evidenceId && item.laneId === failedLaneId);
  if (!failedLane || !evidence) return [];

  const suffix = `${idFragment(failedLaneId)}-${idFragment(evidenceId)}`;
  const fixLaneId = `lane-fix-${suffix}`;
  const regressionLaneId = `lane-regression-${suffix}`;
  const evidenceKind = evidence.kind.trim() ? evidence.kind : "run-exit";
  return [
    {
      id: fixLaneId,
      semanticKey: `repair:${failedLaneId}:${evidenceId}`,
      kind: "fix",
      laneKind: "fix",
      semanticSubtype: "repair",
      title: `Fix ${failedLane.title}`,
      agentKind: "codex",
      dependsOn: [failedLaneId],
      fileScopes: failedLane.fileScopes,
      packageScopes: failedLane.packageScopes,
      requiredEvidence: [evidenceKind],
    },
    {
      id: regressionLaneId,
      semanticKey: `regression:${failedLaneId}:${evidenceId}`,
      kind: "regression_check",
      laneKind: "regression",
      semanticSubtype: "regression_check",
      title: `Validate fix for ${failedLane.title}`,
      agentKind: "codex",
      dependsOn: [fixLaneId],
      fileScopes: failedLane.fileScopes,
      packageScopes: failedLane.packageScopes,
      requiredEvidence: ["test"],
    },
  ];
}

function laneAndEdgeEvents(
  projection: FlowProjection,
  suggestions: LaneSuggestion[],
  now: string,
  keyPrefix: string,
): FlowEvent[] {
  let working = projection;
  const events: FlowEvent[] = [];
  const existingLaneIds = new Set(projection.lanes.map((lane) => lane.id));
  const existingSemanticKeys = new Set(projection.lanes.map((lane) => lane.semanticKey));
  const existingEdges = new Set(projection.edges.map((edge) => `${edge.sourceLaneId}->${edge.targetLaneId}`));

  for (const suggestion of suggestions) {
    const lane = normalizeLane({
      ...suggestion,
      semanticKey: suggestion.semanticKey ?? suggestion.id,
      agentKind: suggestion.agentKind ?? "codex",
      status: "pending",
      fileScopes: suggestion.fileScopes ?? [],
      packageScopes: suggestion.packageScopes ?? [],
      requiredEvidence: suggestion.requiredEvidence ?? [],
    });
    if (!existingLaneIds.has(lane.id) && !existingSemanticKeys.has(lane.semanticKey)) {
      const event = makeEvent(working, {
        kind: "workflow.lane.declared",
        source: "workflow-kernel",
        payload: { lane },
        now,
        idempotencyKey: `${keyPrefix}:lane:${lane.semanticKey}`,
      });
      events.push(event);
      working = reduceWorkflowEvents([...working.events, event]);
      existingLaneIds.add(lane.id);
      existingSemanticKeys.add(lane.semanticKey);
    }
  }

  for (const suggestion of suggestions) {
    for (const dependency of suggestion.dependsOn ?? []) {
      const edgeKey = `${dependency}->${suggestion.id}`;
      if (existingEdges.has(edgeKey)) continue;
      const edge = { id: `edge-${dependency.replace(/^lane-/, "")}-${suggestion.id.replace(/^lane-/, "")}`, sourceLaneId: dependency, targetLaneId: suggestion.id };
      const gate = evaluateGate(working, { type: "DeclareEdge", sourceLaneId: dependency, targetLaneId: suggestion.id });
      if (!gate.allowed) {
        events.push(makeEvent(working, {
          kind: "workflow.intent.rejected",
          source: "workflow-gate",
          payload: { intentId: keyPrefix, reason: gate.reason },
          now,
          idempotencyKey: `${keyPrefix}:edge-rejected:${edgeKey}`,
        }));
        continue;
      }
      const event = makeEvent(working, {
        kind: "workflow.edge.declared",
        source: "workflow-kernel",
        payload: { edge },
        now,
        idempotencyKey: `${keyPrefix}:edge:${edgeKey}`,
      });
      events.push(event);
      working = reduceWorkflowEvents([...working.events, event]);
      existingEdges.add(edgeKey);
    }
  }

  return events;
}

function suggestedLanesForPolicy(
  policy: FlowPolicy,
  projectProfile: ProjectProfile,
  requirementProfile: RequirementProfile,
): LaneSuggestion[] {
  const packs = policy.policyPacks.filter((pack) => pack.detects({ projectProfile, requirementProfile }));
  const lanes = packs.flatMap((pack) => pack.suggestedLanes({ projectProfile, requirementProfile }));
  return [...new Map(lanes.map((lane) => [lane.id, lane])).values()];
}

function inferRequirementProfile(requirement: string): RequirementProfile {
  const text = requirement.toLowerCase();
  const isBackend = text.includes("endpoint") || text.includes("api");
  const isRepositoryCodeChange =
    text.includes("git repository") ||
    text.includes("node:test") ||
    /\bsrc\/[\w./-]+/.test(text) ||
    /\b(test|tests?)\/[\w./-]+/.test(text) ||
    /\b[\w-]+\.(js|ts|mjs|tsx)\b/.test(text);
  const capabilities = [
    isRepositoryCodeChange ? "code-change" : null,
    !isBackend && !isRepositoryCodeChange && (text.includes("search") || text.includes("filter") || text.includes("ui") || text.includes("react")) ? "frontend-ui" : null,
    isBackend ? "backend-api" : null,
    text.includes("csv") || text.includes("data") ? "data-script" : null,
    text.includes("settings") || text.includes("fullstack") ? "fullstack-settings" : null,
  ].filter((value): value is string => Boolean(value));
  return {
    text: requirement,
    capabilities: capabilities.length > 0 ? capabilities : ["frontend-ui"],
    risk: capabilities.includes("fullstack-settings") ? "high" : "medium",
  };
}

function policyPack(
  id: string,
  capabilities: string[],
  lanes: LaneSuggestion[],
  evidence: string[],
  validation: string[],
): PolicyPack {
  return {
    id,
    capabilities,
    evidence,
    validation,
    detects({ projectProfile, requirementProfile }) {
      const values = new Set([...projectProfile.capabilities, ...requirementProfile.capabilities]);
      return capabilities.some((capability) => values.has(capability));
    },
    suggestedLanes() {
      return lanes;
    },
  };
}

function laneSuggestion(
  id: string,
  kind: string,
  title: string,
  agentKind: AgentKind,
  dependsOn: string[] = [],
  fileScopes: string[] = [],
  packageScopes: string[] = [],
): LaneSuggestion {
  const laneKind = laneKindForLegacyKind(kind);
  return {
    id,
    semanticKey: id,
    kind,
    laneKind,
    semanticSubtype: semanticSubtypeForLegacyKind(kind, laneKind),
    title,
    agentKind,
    dependsOn,
    fileScopes,
    packageScopes,
    requiredEvidence: evidenceForLaneKind(kind),
  };
}

function evidenceForLaneKind(kind: string): string[] {
  if (/browser/.test(kind)) return ["browser", "screenshot"];
  if (/test|validation|regression/.test(kind)) return ["test"];
  if (/review/.test(kind)) return ["review"];
  if (/commit/.test(kind)) return ["git"];
  return ["run-exit"];
}

function makeEvent(
  projection: FlowProjection,
  input: {
    kind: FlowEventKind;
    source: string;
    payload: Record<string, unknown>;
    now: string;
    idempotencyKey?: string | null;
  },
): FlowEvent {
  const seq = projection.events.length + 1;
  const idempotencyKey = input.idempotencyKey ?? null;
  return {
    id: `${projection.sessionId}:flow-event:${String(seq).padStart(8, "0")}`,
    sessionId: projection.sessionId,
    seq,
    kind: input.kind,
    source: input.source,
    payload: input.payload,
    createdAt: input.now,
    idempotencyKey,
  };
}

function emptyFlowProjection(sessionId: string): FlowProjection {
  return {
    sessionId,
    events: [],
    lanes: [],
    laneRollbackStatuses: {},
    projectionNodes: [],
    userDecisions: [],
    edges: [],
    segments: [],
    evidence: [],
    changesetEvidence: [],
    checkpoints: [],
    checkpointAuthorityFields: {},
    checkpointIntents: [],
    rollbackIntents: [],
    worktrees: [],
    variantAdoptions: [],
    rejectedIntents: [],
    acceptedIntentIds: [],
    projectProfile: null,
    requirementProfile: null,
  };
}

function dedupeEvents(events: FlowEvent[]): FlowEvent[] {
  const seen = new Set<string>();
  const result: FlowEvent[] = [];
  for (const event of events) {
    const key = event.idempotencyKey ?? event.id;
    if (seen.has(key)) continue;
    seen.add(key);
    result.push(event);
  }
  return result.map((event, index) => ({ ...event, seq: index + 1 }));
}

function normalizeProjectProfile(value: Record<string, unknown> | Partial<ProjectProfile>): ProjectProfile {
  const capabilities = stringArray(value.capabilities);
  return {
    languages: stringArray(value.languages),
    capabilities,
    packages: stringArray(value.packages),
    hasFrontend: Boolean(value.hasFrontend) || capabilities.includes("frontend-ui") || capabilities.includes("fullstack-settings"),
    hasBackend: Boolean(value.hasBackend) || capabilities.includes("backend-api") || capabilities.includes("fullstack-settings"),
    hasPersistence: Boolean(value.hasPersistence) || capabilities.includes("fullstack-settings"),
  };
}

function normalizeRequirementProfile(value: Record<string, unknown> | RequirementProfile): RequirementProfile {
  return {
    text: typeof value.text === "string" ? value.text : "",
    capabilities: stringArray(value.capabilities),
    risk: value.risk === "high" || value.risk === "medium" || value.risk === "low" ? value.risk : "medium",
  };
}

function normalizeLane(value: Record<string, unknown> | LaneSuggestion | FlowLane): FlowLane {
  const record = value as Record<string, unknown>;
  const id = requireString(record.id, "lane.id");
  const kind = requireString(record.kind, "lane.kind");
  const laneKind = isWorkflowLaneKind(record.laneKind) ? record.laneKind : laneKindForLegacyKind(kind);
  const semanticSubtype =
    typeof record.semanticSubtype === "string" ? record.semanticSubtype : semanticSubtypeForLegacyKind(kind, laneKind);
  const executable = typeof record.executable === "boolean" ? record.executable : true;
  const rollbackStatus = normalizeNodeRollbackStatus(record.rollbackStatus) ?? normalizeNodeRollbackStatus(record.status);
  const status = isTerminalRollbackStatus(rollbackStatus)
    ? "blocked"
    : isLaneStatus(record.status)
      ? record.status
      : "pending";
  return {
    id,
    semanticKey: typeof record.semanticKey === "string" ? record.semanticKey : id,
    kind,
    laneKind,
    semanticSubtype,
    title: typeof record.title === "string" ? record.title : id,
    ...(typeof record.brief === "string" && record.brief.trim() ? { brief: record.brief.trim() } : {}),
    agentKind: isAgentKind(record.agentKind) ? record.agentKind : "codex",
    nodeKind: "agent_task",
    executable,
    runtimePolicy: normalizeRuntimePolicy(record.runtimePolicy, laneKind, executable),
    status,
    ...(rollbackStatus ? { rollbackStatus } : {}),
    fileScopes: stringArray(record.fileScopes),
    packageScopes: stringArray(record.packageScopes),
    requiredEvidence: stringArray(record.requiredEvidence),
    output: stringArray(record.output),
  };
}

function laneKindForLegacyKind(kind: string): WorkflowLaneKind {
  const value = kind.toLowerCase();
  if (isWorkflowLaneKind(value)) return value;
  if (/fix|repair/.test(value)) return "fix";
  if (/regression/.test(value)) return "regression";
  if (/validation|test|browser|screenshot|check/.test(value)) return "validation";
  if (/review/.test(value)) return "review";
  if (/commit|adopt/.test(value)) return "commit";
  if (/join|integration/.test(value)) return "join";
  if (/design/.test(value)) return "design";
  if (/discover|profile|understanding|analysis/.test(value)) return "discovery";
  return "implementation";
}

function laneKindForExternalKind(kind: string): WorkflowLaneKind {
  const laneKind = laneKindForLegacyKind(kind);
  // External fix-like lanes are normal implementation; trusted repair lanes come from ReplanFromEvidence.
  return laneKind === "fix" ? "implementation" : laneKind;
}

function isReservedRepairSemanticKey(value: string): boolean {
  return value.startsWith("repair:") || value.startsWith("regression:");
}

function semanticSubtypeForLegacyKind(kind: string, laneKind: WorkflowLaneKind): WorkflowLaneSemanticSubtype {
  if (kind === laneKind && laneKind === "fix") return "repair";
  return kind as WorkflowLaneSemanticSubtype;
}

function normalizeRuntimePolicy(
  value: unknown,
  laneKind: WorkflowLaneKind,
  executable: boolean,
): WorkflowRuntimePolicy {
  const fallback = defaultRuntimePolicyForLane(laneKind, executable);
  if (!isRecord(value)) return fallback;
  return {
    source: "workflow_projection",
    trusted: true,
    executable,
    sandbox: isAgentRunSandbox(value.sandbox) ? value.sandbox : fallback.sandbox,
    sideEffects: normalizeSideEffects(value.sideEffects, fallback.sideEffects),
    reason: typeof value.reason === "string" && value.reason.trim() ? value.reason : fallback.reason,
  };
}

function defaultRuntimePolicyForLane(laneKind: WorkflowLaneKind, executable: boolean): WorkflowRuntimePolicy {
  if (!executable) {
    return {
      source: "workflow_projection",
      trusted: true,
      executable: false,
      sandbox: "read-only",
      sideEffects: [],
      reason: "Projection node is not executable.",
    };
  }
  const sandbox = sandboxForLaneKind(laneKind);
  return {
    source: "workflow_projection",
    trusted: true,
    executable: true,
    sandbox,
    sideEffects: sideEffectsForLaneKind(laneKind),
    reason: `Runtime policy derived from workflow lane kind ${laneKind}.`,
  };
}

function sandboxForLaneKind(laneKind: WorkflowLaneKind): AgentRunSandbox {
  if (laneKind === "commit") return "danger-full-access";
  if (laneKind === "implementation" || laneKind === "fix") return "workspace-write";
  return "read-only";
}

function sideEffectsForLaneKind(laneKind: WorkflowLaneKind): WorkflowSideEffectKind[] {
  if (laneKind === "commit") return ["git", "filesystem", "process"];
  if (laneKind === "implementation" || laneKind === "fix") return ["filesystem", "process"];
  if (laneKind === "validation" || laneKind === "regression" || laneKind === "review") return ["process", "artifact"];
  return ["process"];
}

function normalizeSideEffects(value: unknown, fallback: WorkflowSideEffectKind[]): WorkflowSideEffectKind[] {
  const values = Array.isArray(value) ? value.filter(isWorkflowSideEffectKind) : fallback;
  return [...new Set(values)];
}

function normalizeUserDecisionRequested(payload: Record<string, unknown>): UserDecisionProjection {
  const requested = payload as Partial<UserDecisionRequestedPayload>;
  const decisionId = requireString(requested.decisionId, "decision.decisionId");
  return {
    decisionId,
    prompt: typeof requested.prompt === "string" ? requested.prompt : "",
    options: stringArray(requested.options),
    reason: typeof requested.reason === "string" ? requested.reason : "",
    status: "waiting_input",
    ...(typeof requested.targetLaneId === "string" ? { targetLaneId: requested.targetLaneId } : {}),
    ...(typeof requested.targetSegmentId === "string" ? { targetSegmentId: requested.targetSegmentId } : {}),
  };
}

function normalizeUserDecisionAnswered(payload: Record<string, unknown>): UserDecisionAnsweredPayload {
  const decisionId = requireString(payload.decisionId, "decision.decisionId");
  return {
    decisionId,
    selectedOption: typeof payload.selectedOption === "string" ? payload.selectedOption : "",
    action: isUserDecisionAction(payload.action) ? payload.action : "continue",
    ...(typeof payload.comment === "string" ? { comment: payload.comment } : {}),
    ...(typeof payload.targetLaneId === "string" ? { targetLaneId: payload.targetLaneId } : {}),
    ...(typeof payload.targetSegmentId === "string" ? { targetSegmentId: payload.targetSegmentId } : {}),
  };
}

function upsertUserDecision(projection: FlowProjection, decision: UserDecisionProjection): void {
  const index = projection.userDecisions.findIndex((item) => item.decisionId === decision.decisionId);
  if (index === -1) {
    projection.userDecisions.push(decision);
    return;
  }
  projection.userDecisions[index] = { ...projection.userDecisions[index], ...decision };
}

function answerUserDecision(projection: FlowProjection, answer: UserDecisionAnsweredPayload): void {
  const index = projection.userDecisions.findIndex((item) => item.decisionId === answer.decisionId);
  if (index === -1) return;
  const existing = projection.userDecisions[index];
  const next: UserDecisionProjection = {
    decisionId: answer.decisionId,
    prompt: existing.prompt,
    options: existing.options,
    reason: existing.reason,
    targetLaneId: answer.targetLaneId ?? existing.targetLaneId,
    targetSegmentId: answer.targetSegmentId ?? existing.targetSegmentId,
    status: "answered",
    selectedOption: answer.selectedOption,
    action: answer.action,
    ...(answer.comment ? { comment: answer.comment } : {}),
  };
  projection.userDecisions[index] = next;
}

function refreshProjectionNodes(projection: FlowProjection): void {
  const laneNodes: FlowProjectionNode[] = projection.lanes.map((lane) => ({
    id: lane.id,
    laneId: lane.id,
    nodeKind: lane.nodeKind,
    executable: lane.executable,
    runtimePolicy: lane.runtimePolicy,
  }));
  const decisionNodes: FlowProjectionNode[] = projection.userDecisions.map((decision) => ({
    id: decision.decisionId,
    decisionId: decision.decisionId,
    nodeKind: "user_decision",
    executable: false,
    runtimePolicy: defaultRuntimePolicyForLane("decision", false),
  }));
  projection.projectionNodes = [...laneNodes, ...decisionNodes];
}

function upsertWorktree(projection: FlowProjection, worktree: WorkflowWorktreeIdentity): void {
  const index = projection.worktrees.findIndex((item) => item.worktreeId === worktree.worktreeId);
  if (index === -1) {
    projection.worktrees.push(worktree);
    return;
  }
  projection.worktrees[index] = { ...projection.worktrees[index], ...worktree };
}

function upsertVariantAdoption(projection: FlowProjection, adoption: WorkflowVariantAdoption): void {
  const index = projection.variantAdoptions.findIndex((item) => item.adoptionId === adoption.adoptionId);
  if (index === -1) {
    projection.variantAdoptions.push(adoption);
    return;
  }
  projection.variantAdoptions[index] = { ...projection.variantAdoptions[index], ...adoption };
}

function normalizeEdge(value: Record<string, unknown>): FlowEdge {
  const sourceLaneId = requireString(value.sourceLaneId, "edge.sourceLaneId");
  const targetLaneId = requireString(value.targetLaneId, "edge.targetLaneId");
  return {
    id: typeof value.id === "string" ? value.id : `edge-${sourceLaneId}-${targetLaneId}`,
    sourceLaneId,
    targetLaneId,
  };
}

function normalizeSegment(value: Record<string, unknown>): FlowSegment {
  return {
    id: requireString(value.id, "segment.id"),
    laneId: requireString(value.laneId, "segment.laneId"),
    runId: requireString(value.runId, "segment.runId"),
    status: normalizeSegmentStatus(value.status),
    exitCode: numberOrNull(value.exitCode),
  };
}

function normalizeSegmentStatus(value: unknown): FlowSegment["status"] {
  if (value === "succeeded" || value === "failed" || value === "cancelled" || value === "timed-out" || value === "running") {
    return value;
  }
  return "running";
}

function normalizeEvidence(value: Record<string, unknown>, laneId: string, segmentId: string): FlowEvidence {
  return {
    id: typeof value.id === "string" ? value.id : `evidence-${laneId}-${segmentId}`,
    laneId,
    segmentId,
    kind: typeof value.kind === "string" ? value.kind : "run-exit",
    status: normalizeFlowEvidenceStatus(value.status),
    checks: stringArray(value.checks),
    artifacts: stringArray(value.artifacts),
    ...(typeof value.detail === "string" ? { detail: value.detail } : {}),
    ...(isRecord(value.runEvidence) ? { runEvidence: value.runEvidence as unknown as RunEvidence } : {}),
  };
}

function normalizeNodeCheckpoint(
  value: Record<string, unknown>,
  event: FlowEvent,
  existing?: WorkflowNodeCheckpoint,
  existingExplicitFields: CheckpointExplicitFields = {},
): WorkflowNodeCheckpoint {
  const id = requireString(value.id, "checkpoint.id");
  const incomingLaneId = stringValue(value.laneId);
  const laneId = existingExplicitFields.laneId ? existing?.laneId : incomingLaneId ?? existing?.laneId;
  const incomingNodeId = stringValue(value.nodeId);
  const nodeId = existingExplicitFields.nodeId ? existing?.nodeId : incomingNodeId ?? existing?.nodeId;
  const incomingPhase = isCheckpointPhase(value.phase) ? value.phase : undefined;
  const phase = existingExplicitFields.phase ? existing?.phase : incomingPhase ?? existing?.phase;
  const incomingExecutionTarget = normalizeCheckpointExecutionTarget(value.executionTarget);
  const executionTarget = existingExplicitFields.executionTarget
    ? existing?.executionTarget
    : incomingExecutionTarget ?? existing?.executionTarget;
  const runId = existing?.runId ?? stringValue(value.runId);
  const segmentId = existing?.segmentId ?? stringValue(value.segmentId);
  const worktreeId = existing?.worktreeId ?? stringValue(value.worktreeId);
  const worktreePath = existing?.worktreePath ?? stringValue(value.worktreePath);
  const branchName = existing?.branchName ?? stringValue(value.branchName);
  const worktreeState = existing?.worktreeState ?? normalizeCheckpointWorktreeState(value.worktreeState);
  const baseCommit = existing?.baseCommit ?? stringValue(value.baseCommit);
  const headCommit = existing?.headCommit ?? stringValue(value.headCommit);
  const evidenceRefs = Array.isArray(value.evidenceRefs) ? normalizeCheckpointEvidenceRefs(value.evidenceRefs) : [];
  return {
    id,
    sessionId: existing?.sessionId ?? stringValue(value.sessionId) ?? event.sessionId,
    nodeId: nodeId ?? laneId ?? id,
    ...(laneId ? { laneId } : {}),
    ...(runId ? { runId } : {}),
    ...(segmentId ? { segmentId } : {}),
    phase: phase ?? "before",
    executionTarget: executionTarget ?? "current_branch",
    ...(worktreeId ? { worktreeId } : {}),
    ...(worktreePath ? { worktreePath } : {}),
    ...(branchName ? { branchName } : {}),
    ...(worktreeState ? { worktreeState } : {}),
    ...(baseCommit ? { baseCommit } : {}),
    ...(headCommit ? { headCommit } : {}),
    createdAt: existing?.createdAt ?? stringValue(value.createdAt) ?? event.createdAt,
    source: existing?.source ?? (isCheckpointSource(value.source) ? value.source : "workflow_kernel"),
    evidenceRefs: mergeCheckpointEvidenceRefs(existing?.evidenceRefs ?? [], evidenceRefs),
  };
}

function normalizeCheckpointWorktreeState(value: unknown): WorkflowNodeCheckpoint["worktreeState"] | undefined {
  return value === "clean" || value === "dirty" ? value : undefined;
}

function upsertNodeCheckpoint(
  projection: FlowProjection,
  checkpoint: WorkflowNodeCheckpoint,
  explicitFields: CheckpointExplicitFields,
  explicitFieldsByCheckpointId: Map<string, CheckpointExplicitFields>,
): void {
  const index = projection.checkpoints.findIndex((item) => item.id === checkpoint.id);
  if (index === -1) {
    projection.checkpoints.push(withCheckpointAuthority(checkpoint, explicitFields));
    explicitFieldsByCheckpointId.set(checkpoint.id, explicitFields);
    projection.checkpointAuthorityFields[checkpoint.id] = explicitFields;
    return;
  }
  const mergedExplicitFields = mergeCheckpointExplicitFields(explicitFieldsByCheckpointId.get(checkpoint.id), explicitFields);
  projection.checkpoints[index] = withCheckpointAuthority(checkpoint, mergedExplicitFields);
  explicitFieldsByCheckpointId.set(checkpoint.id, mergedExplicitFields);
  projection.checkpointAuthorityFields[checkpoint.id] = mergedExplicitFields;
}

function applyRollbackRequest(projection: FlowProjection, event: FlowEvent): void {
  const target = resolveRollbackTarget(projection, event);
  const localRollbackSafe = typeof event.payload.localRollbackSafe === "boolean" ? event.payload.localRollbackSafe : target.localRollbackSafe;
  if (!target.laneId || target.reason) {
    upsertCheckpointIntent(projection.rollbackIntents, {
      intentId: stringValue(event.payload.requestId) ?? event.id,
      sessionId: event.sessionId,
      kind: "rollback",
      status: "rejected",
      ...(target.laneId ? { laneId: target.laneId } : {}),
      ...(target.nodeId ? { nodeId: target.nodeId } : {}),
      ...(target.checkpointId ? { checkpointId: target.checkpointId } : {}),
      createdAt: event.createdAt,
      ...(typeof localRollbackSafe === "boolean" ? { localRollbackSafe } : {}),
      reason: target.reason,
    });
    return;
  }

  const eligibility = evaluateRollbackEligibility(projection, target.laneId, {
    checkpointId: target.checkpointId,
    localRollbackSafe,
    targetNodeId: target.nodeId,
    throughSeq: event.seq,
  });
  const intent: WorkflowCheckpointIntent = {
    intentId: stringValue(event.payload.requestId) ?? event.id,
    sessionId: event.sessionId,
    kind: "rollback",
    status: eligibility.eligible ? "requested" : "rejected",
    laneId: target.laneId,
    ...(target.nodeId ? { nodeId: target.nodeId } : {}),
    ...(target.checkpointId ? { checkpointId: target.checkpointId } : {}),
    createdAt: event.createdAt,
    ...(typeof localRollbackSafe === "boolean" ? { localRollbackSafe } : {}),
    eligibility,
    reason: eligibility.reason,
  };
  upsertCheckpointIntent(projection.rollbackIntents, intent);
}

function applyRollbackApplied(
  projection: FlowProjection,
  event: FlowEvent,
  declaredLaneStatuses: Map<string, FlowLaneStatus>,
): void {
  const target = resolveRollbackTarget(projection, event);
  const localRollbackSafe = typeof event.payload.localRollbackSafe === "boolean" ? event.payload.localRollbackSafe : target.localRollbackSafe;
  if (!target.laneId || target.reason) {
    upsertCheckpointIntent(projection.rollbackIntents, {
      intentId: stringValue(event.payload.requestId) ?? stringValue(event.payload.intentId) ?? event.id,
      sessionId: event.sessionId,
      kind: "rollback",
      status: "rejected",
      ...(target.laneId ? { laneId: target.laneId } : {}),
      ...(target.nodeId ? { nodeId: target.nodeId } : {}),
      ...(target.checkpointId ? { checkpointId: target.checkpointId } : {}),
      createdAt: event.createdAt,
      reason: target.reason,
    });
    return;
  }

  const eligibility = evaluateRollbackEligibility(projection, target.laneId, {
    checkpointId: target.checkpointId,
    localRollbackSafe,
    targetNodeId: target.nodeId,
    throughSeq: event.seq,
  });
  const intent: WorkflowCheckpointIntent = {
    intentId: stringValue(event.payload.requestId) ?? stringValue(event.payload.intentId) ?? event.id,
    sessionId: event.sessionId,
    kind: "rollback",
    status: eligibility.eligible ? "applied" : "rejected",
    laneId: target.laneId,
    ...(target.nodeId ? { nodeId: target.nodeId } : {}),
    ...(target.checkpointId ? { checkpointId: target.checkpointId } : {}),
    createdAt: event.createdAt,
    ...(typeof localRollbackSafe === "boolean" ? { localRollbackSafe } : {}),
    eligibility,
    reason: typeof event.payload.reason === "string" ? event.payload.reason : eligibility.reason,
  };
  upsertCheckpointIntent(projection.rollbackIntents, intent);
  if (!eligibility.eligible) return;

  const downstream = new Set<string>(eligibility.affectedLaneIds.filter((id: string) => id !== target.laneId));
  setLaneRollbackStatus(projection, target.laneId, "rolled_back");
  const preserved = preservedRollbackSuccessorSubgraph(projection, target.laneId, downstream);
  for (const preservedLaneId of preserved) {
    resetPreservedRollbackSuccessorStatus(projection, preservedLaneId, declaredLaneStatuses.get(preservedLaneId));
  }
  for (const affectedLaneId of downstream) {
    if (preserved.has(affectedLaneId)) continue;
    setLaneRollbackStatus(projection, affectedLaneId, "inactive");
  }
}

function normalizeRollbackRejectedEvent(projection: FlowProjection, event: FlowEvent): WorkflowCheckpointIntent {
  const target = resolveRollbackTarget(projection, event);
  const localRollbackSafe = typeof event.payload.localRollbackSafe === "boolean" ? event.payload.localRollbackSafe : target.localRollbackSafe;
  const eligibility = target.laneId && !target.reason
    ? evaluateRollbackEligibility(projection, target.laneId, {
        checkpointId: target.checkpointId,
        localRollbackSafe,
        targetNodeId: target.nodeId,
        throughSeq: event.seq,
      })
    : null;
  const reason = typeof event.payload.reason === "string" ? event.payload.reason : target.reason ?? eligibility?.reason;
  return {
    intentId: stringValue(event.payload.requestId) ?? stringValue(event.payload.intentId) ?? event.id,
    sessionId: event.sessionId,
    kind: "rollback",
    status: "rejected",
    ...(target.laneId ? { laneId: target.laneId } : {}),
    ...(target.nodeId ? { nodeId: target.nodeId } : {}),
    ...(target.checkpointId ? { checkpointId: target.checkpointId } : {}),
    createdAt: event.createdAt,
    ...(typeof localRollbackSafe === "boolean" ? { localRollbackSafe } : {}),
    ...(eligibility ? { eligibility } : {}),
    ...(reason ? { reason } : {}),
  };
}

function resolveRollbackTarget(
  projection: FlowProjection,
  event: FlowEvent,
): ResolvedRollbackTarget {
  const payloadCheckpointId = stringValue(event.payload.checkpointId) ?? undefined;
  const payloadLaneId = stringValue(event.payload.laneId) ?? undefined;
  const payloadNodeId = stringValue(event.payload.nodeId) ?? undefined;
  const payloadLocalRollbackSafe = typeof event.payload.localRollbackSafe === "boolean" ? event.payload.localRollbackSafe : undefined;
  const fallbackIntent = rollbackIntentForEvent(projection, event);
  const checkpointId = payloadCheckpointId ?? fallbackIntent?.checkpointId;
  const checkpoint = checkpointId ? projection.checkpoints.find((item) => item.id === checkpointId) : undefined;
  const requestedLaneId = payloadLaneId ?? fallbackIntent?.laneId;
  const requestedNodeId = payloadNodeId ?? fallbackIntent?.nodeId;
  const laneId = requestedLaneId ?? checkpoint?.laneId;
  const checkpointNodeId = requestedLaneId && checkpoint?.laneId && requestedLaneId !== checkpoint.laneId ? undefined : checkpoint?.nodeId;
  const nodeId = requestedNodeId ?? checkpointNodeId;
  const localRollbackSafe = payloadLocalRollbackSafe ?? fallbackIntent?.localRollbackSafe;
  const reason = !laneId
    ? "Rollback requires a laneId or checkpointId resolving to a laneId."
    : checkpoint?.laneId && requestedLaneId && requestedLaneId !== checkpoint.laneId
      ? "Rollback requires a matching checkpoint for the target lane."
      : checkpoint?.nodeId && requestedNodeId && requestedNodeId !== checkpoint.nodeId
        ? "Rollback requires a matching checkpoint for the target lane and node."
      : undefined;
  return {
    ...(laneId ? { laneId } : {}),
    ...(nodeId ? { nodeId } : {}),
    ...(checkpointId ? { checkpointId } : {}),
    ...(typeof localRollbackSafe === "boolean" ? { localRollbackSafe } : {}),
    ...(reason ? { reason } : {}),
  };
}

function rollbackIntentForEvent(projection: FlowProjection, event: FlowEvent): WorkflowCheckpointIntent | undefined {
  const requestId = stringValue(event.payload.requestId);
  const intentId = stringValue(event.payload.intentId);
  if (!requestId && !intentId) return undefined;
  return [...projection.rollbackIntents].reverse().find((intent) => intent.intentId === requestId || intent.intentId === intentId);
}

function normalizeCheckpointIntent(
  projection: FlowProjection,
  event: FlowEvent,
  kind: Exclude<WorkflowCheckpointIntentKind, "rollback">,
  requiredPhase: WorkflowNodeCheckpointPhase,
): WorkflowCheckpointIntent {
  const checkpointId = stringValue(event.payload.checkpointId);
  const checkpoint = checkpointId ? projection.checkpoints.find((item) => item.id === checkpointId) ?? null : null;
  const payloadLaneId = stringValue(event.payload.laneId);
  const payloadNodeId = stringValue(event.payload.nodeId);
  const successorLaneId = stringValue(event.payload.successorLaneId);
  const successorSemanticKey = stringValue(event.payload.successorSemanticKey);
  const instruction = stringValue(event.payload.instruction) ?? stringValue(event.payload.text);
  const sourceEvidenceIds = stringArray(event.payload.sourceEvidenceIds);
  const laneId = checkpoint?.laneId ?? payloadLaneId;
  const nodeId = checkpoint?.nodeId ?? payloadNodeId ?? laneId;
  const ownershipMatches =
    !checkpoint ||
    ((!checkpoint.laneId || !payloadLaneId || payloadLaneId === checkpoint.laneId) &&
      (!payloadNodeId || payloadNodeId === checkpoint.nodeId));
  const phaseExplicit = checkpoint ? checkpointAuthorityForValidation(projection, checkpoint).phaseExplicit : false;
  const phaseMatches = Boolean(checkpoint && checkpoint.phase === requiredPhase && phaseExplicit);
  const hasSuccessorIdentity = Boolean(successorLaneId || successorSemanticKey);
  const valid = phaseMatches && ownershipMatches && Boolean(laneId) && hasSuccessorIdentity;
  const reason = checkpoint && !ownershipMatches
    ? "Checkpoint intent requires a matching checkpoint for the requested lane and node."
    : checkpoint && !phaseExplicit
      ? `${kind} requires an explicit ${requiredPhase} checkpoint.`
      : !phaseMatches
        ? `${kind} requires a ${requiredPhase} checkpoint.`
        : !laneId
          ? `${kind} requires target lane.`
        : `${kind} requires successor identity.`;
  const baseIntent = {
    intentId: stringValue(event.payload.intentId) ?? stringValue(event.payload.requestId) ?? event.id,
    sessionId: event.sessionId,
    kind,
    ...(laneId ? { laneId } : {}),
    ...(nodeId ? { nodeId } : {}),
    ...(checkpointId ? { checkpointId } : {}),
    ...(sourceEvidenceIds.length > 0 ? { sourceEvidenceIds } : {}),
    ...(instruction ? { instruction } : {}),
    createdAt: event.createdAt,
    ...(typeof event.payload.localRollbackSafe === "boolean" ? { localRollbackSafe: event.payload.localRollbackSafe } : {}),
  };
  if (!valid || !laneId) {
    return {
      ...baseIntent,
      status: "rejected",
      ...(successorLaneId ? { successorLaneId } : {}),
      ...(successorSemanticKey ? { successorSemanticKey } : {}),
      reason,
    };
  }
  if (successorLaneId) {
    const intent: RequestedCheckpointSuccessorIntent = {
      ...baseIntent,
      laneId,
      status: "requested",
      successorLaneId,
      ...(successorSemanticKey ? { successorSemanticKey } : {}),
    };
    return intent;
  }
  const intent: RequestedCheckpointSuccessorIntent = {
    ...baseIntent,
    laneId,
    status: "requested",
    successorSemanticKey: successorSemanticKey as string,
  };
  return intent;
}

function upsertCheckpointIntent(intents: WorkflowCheckpointIntent[], intent: WorkflowCheckpointIntent): void {
  const index = intents.findIndex((item) => item.intentId === intent.intentId);
  if (index === -1) {
    intents.push(intent);
    return;
  }
  intents[index] = intent;
}

function validateRollbackCheckpoint(
  projection: FlowProjection,
  targetLaneId: string,
  checkpointId: string | undefined,
  input: { targetNodeId?: string },
): { checkpoint: WorkflowNodeCheckpoint | null; reason: string | null } {
  if (!checkpointId) {
    return {
      checkpoint: null,
      reason: "Rollback requires an existing before checkpoint.",
    };
  }
  const checkpoint = projection.checkpoints.find((item) => item.id === checkpointId) ?? null;
  if (!checkpoint) {
    return { checkpoint: null, reason: "Rollback requires an existing before checkpoint." };
  }
  const authority = checkpointAuthorityForValidation(projection, checkpoint);
  if (!authority.phaseExplicit) {
    return { checkpoint, reason: "Rollback requires an explicit before checkpoint." };
  }
  if (checkpoint.phase !== "before") {
    return { checkpoint, reason: "Rollback requires a before checkpoint." };
  }
  if (checkpoint.worktreeState === "dirty") {
    return { checkpoint, reason: "Rollback requires a restorable clean before checkpoint." };
  }
  if (!checkpoint.laneId) {
    return { checkpoint, reason: "Rollback requires a matching checkpoint for the target lane." };
  }
  if (!checkpointMatchesRollbackTarget(checkpoint, targetLaneId, input.targetNodeId)) {
    return { checkpoint, reason: "Rollback requires a matching checkpoint for the target lane." };
  }
  if (!authority.executionTargetExplicit || !hasCheckpointExecutionTarget(checkpoint)) {
    return { checkpoint, reason: "Rollback requires a before checkpoint with an explicit execution target." };
  }
  if (!checkpointRestoreCommitRef(checkpoint)) {
    return { checkpoint, reason: "Rollback requires a before checkpoint with a restore commit ref." };
  }
  return { checkpoint, reason: null };
}

function checkpointMatchesRollbackTarget(
  checkpoint: WorkflowNodeCheckpoint,
  targetLaneId: string,
  targetNodeId: string | undefined,
): boolean {
  if (checkpoint.laneId) {
    if (checkpoint.laneId !== targetLaneId) return false;
    return !targetNodeId || checkpoint.nodeId === targetNodeId;
  }
  return checkpoint.nodeId === (targetNodeId ?? targetLaneId);
}

function hasCheckpointExecutionTarget(checkpoint: WorkflowNodeCheckpoint): boolean {
  return checkpoint.executionTarget === "current_branch" || checkpoint.executionTarget === "new_worktree";
}

function checkpointRestoreCommitRef(checkpoint: WorkflowNodeCheckpoint): string | undefined {
  return checkpoint.headCommit;
}

function rollbackNodeIdByLaneId(
  affectedLaneIds: string[],
  targetLaneId: string,
  targetNodeId: string | undefined,
  checkpoint: WorkflowNodeCheckpoint | null,
): Map<string, string> {
  const byLaneId = new Map<string, string>();
  for (const laneId of affectedLaneIds) {
    byLaneId.set(laneId, laneId);
  }
  if (affectedLaneIds.includes(targetLaneId)) {
    byLaneId.set(targetLaneId, targetNodeId ?? checkpoint?.nodeId ?? targetLaneId);
  }
  return byLaneId;
}

function downstreamInactiveRollbackLaneIds(
  projection: FlowProjection,
  targetLaneId: string,
  affectedLaneIds: string[],
): string[] {
  const downstream = new Set<string>(affectedLaneIds.filter((id) => id !== targetLaneId));
  if (downstream.size === 0) return [];
  const preserved = preservedRollbackSuccessorSubgraph(projection, targetLaneId, downstream);
  return [...downstream].filter((laneId) => !preserved.has(laneId));
}

function rollbackLocalSafetyStatus(
  localRollbackSafe: boolean | undefined,
): WorkflowRollbackLocalSafetyStatus {
  if (localRollbackSafe === true) return "safe";
  if (localRollbackSafe === false) return "unsafe";
  return "unknown";
}

function affectedRollbackLaneIds(projection: FlowProjection, targetLaneId: string): string[] {
  if (!projection.lanes.some((lane) => lane.id === targetLaneId)) return [];
  return [targetLaneId, ...downstreamLaneIds(projection.edges, targetLaneId)];
}

function downstreamLaneIds(edges: FlowEdge[], targetLaneId: string): string[] {
  const outgoing = new Map<string, string[]>();
  for (const edge of edges) {
    outgoing.set(edge.sourceLaneId, [...(outgoing.get(edge.sourceLaneId) ?? []), edge.targetLaneId]);
  }
  const result: string[] = [];
  const queue = [...(outgoing.get(targetLaneId) ?? [])];
  const visited = new Set<string>();
  while (queue.length > 0) {
    const current = queue.shift() as string;
    if (visited.has(current)) continue;
    visited.add(current);
    result.push(current);
    queue.push(...(outgoing.get(current) ?? []));
  }
  return result;
}

function preservedRollbackSuccessorSubgraph(
  projection: FlowProjection,
  targetLaneId: string,
  affectedLaneIds: Set<string>,
): Set<string> {
  const outgoing = new Map<string, string[]>();
  const incoming = new Map<string, string[]>();
  for (const edge of projection.edges) {
    outgoing.set(edge.sourceLaneId, [...(outgoing.get(edge.sourceLaneId) ?? []), edge.targetLaneId]);
    incoming.set(edge.targetLaneId, [...(incoming.get(edge.targetLaneId) ?? []), edge.sourceLaneId]);
  }

  const roots = new Set(
    projection.lanes
      .filter((lane) => affectedLaneIds.has(lane.id) && isTrustedRolledBackSuccessorDependency(projection, lane, targetLaneId))
      .map((lane) => lane.id),
  );
  const reachable = new Set<string>();
  const queue = [...roots];
  while (queue.length > 0) {
    const current = queue.shift() as string;
    if (reachable.has(current) || !affectedLaneIds.has(current)) continue;
    reachable.add(current);
    queue.push(...(outgoing.get(current) ?? []));
  }

  const preserved = new Set<string>();
  let changed = true;
  while (changed) {
    changed = false;
    for (const laneId of reachable) {
      if (preserved.has(laneId)) continue;
      const lane = projection.lanes.find((item) => item.id === laneId);
      if (!lane) continue;
      if (!rollbackSuccessorIncomingDependenciesSatisfied(projection, lane, incoming.get(laneId) ?? [], affectedLaneIds, preserved)) {
        continue;
      }
      preserved.add(laneId);
      changed = true;
    }
  }
  return preserved;
}

function rollbackSuccessorIncomingDependenciesSatisfied(
  projection: FlowProjection,
  lane: FlowLane,
  incomingLaneIds: string[],
  affectedLaneIds: Set<string>,
  preserved: Set<string>,
): boolean {
  return incomingLaneIds.every((dependencyId) => {
    if (!affectedLaneIds.has(dependencyId)) return true;
    if (preserved.has(dependencyId)) return true;
    return isTrustedRolledBackSuccessorDependency(projection, lane, dependencyId);
  });
}

function restoreRollbackSuccessorsForIntent(
  projection: FlowProjection,
  intent: WorkflowCheckpointIntent,
  declaredLaneStatuses: Map<string, FlowLaneStatus>,
): void {
  if (intent.status !== "requested") return;
  if (intent.kind !== "repair" && intent.kind !== "variant" && intent.kind !== "fork") return;
  const targetLaneId = checkpointIntentTargetLaneId(projection, intent);
  if (!targetLaneId) return;
  if (projection.lanes.find((lane) => lane.id === targetLaneId)?.rollbackStatus !== "rolled_back") return;

  const affectedLaneIds = new Set(downstreamLaneIds(projection.edges, targetLaneId));
  const restored = preservedRollbackSuccessorSubgraph(projection, targetLaneId, affectedLaneIds);
  for (const laneId of restored) {
    const lane = projection.lanes.find((item) => item.id === laneId);
    if (lane?.rollbackStatus !== "inactive") continue;
    setLaneStatus(projection, laneId, restoredLaneStatus(declaredLaneStatuses.get(laneId)), { clearRollbackStatus: true, force: true });
  }
}

function restoreRollbackSuccessorsForRequestedIntents(
  projection: FlowProjection,
  declaredLaneStatuses: Map<string, FlowLaneStatus>,
): void {
  for (const intent of projection.checkpointIntents) {
    restoreRollbackSuccessorsForIntent(projection, intent, declaredLaneStatuses);
  }
}

function checkpointIntentTargetLaneId(projection: FlowProjection, intent: WorkflowCheckpointIntent): string | undefined {
  if (intent.laneId) return intent.laneId;
  const checkpoint = intent.checkpointId ? projection.checkpoints.find((item) => item.id === intent.checkpointId) : undefined;
  return checkpoint?.laneId;
}

function restoredLaneStatus(declaredStatus: FlowLaneStatus | undefined): FlowLaneStatus {
  return declaredStatus === "ready" ? "ready" : "pending";
}

function resetPreservedRollbackSuccessorStatus(
  projection: FlowProjection,
  laneId: string,
  declaredStatus: FlowLaneStatus | undefined,
): void {
  const lane = projection.lanes.find((item) => item.id === laneId);
  if (!lane) return;
  if (!lane.rollbackStatus && lane.status !== "running" && lane.status !== "completed") return;
  setLaneStatus(projection, laneId, restoredLaneStatus(declaredStatus), { clearRollbackStatus: true, force: true });
}

function remoteSideEffectsForLanes(
  projection: FlowProjection,
  affectedLaneIds: Set<string>,
  throughSeq?: number,
): RollbackRemoteSideEffectRef[] {
  const refs: RollbackRemoteSideEffectRef[] = [];
  const pendingRequests = new Map<string, PendingRemoteSideEffectRequest>();
  for (const event of projection.events) {
    if (typeof throughSeq === "number" && event.seq > throughSeq) continue;
    if (event.kind === "workflow.remote_side_effect.requested") {
      const request = normalizeRemoteSideEffectRequest(event);
      if (request) pendingRequests.set(request.operationId, request);
      continue;
    }
    if (event.kind === "workflow.remote_side_effect.completed") {
      const operationId = stringValue(event.payload.operationId);
      if (operationId && remoteSideEffectCompletionClearsRollbackBlock(event)) pendingRequests.delete(operationId);
      continue;
    }
    if (!isRemoteSideEffectEventKind(event.kind)) continue;
    if (remoteSideEffectIsSessionWide(event)) {
      refs.push({
        eventKind: event.kind,
        status: "recorded",
        eventId: event.id,
        affectedLaneIds: [...affectedLaneIds],
        sessionWide: true,
        createdAt: event.createdAt,
      });
      continue;
    }
    const laneIds = remoteSideEffectLaneIds(event);
    if (laneIds.length === 0) {
      refs.push({
        eventKind: event.kind,
        status: "recorded",
        eventId: event.id,
        affectedLaneIds: [...affectedLaneIds],
        sessionWide: true,
        createdAt: event.createdAt,
      });
      continue;
    }
    const matchingLaneIds = laneIds.filter((id) => affectedLaneIds.has(id));
    if (matchingLaneIds.length === 0) continue;
    refs.push({
      eventKind: event.kind,
      status: "recorded",
      eventId: event.id,
      laneId: matchingLaneIds[0],
      affectedLaneIds: matchingLaneIds,
      createdAt: event.createdAt,
    });
  }
  for (const request of pendingRequests.values()) {
    if (request.sessionWide) {
      refs.push({
        eventKind: request.eventKind,
        status: "in_flight",
        eventId: request.eventId,
        affectedLaneIds: [...affectedLaneIds],
        sessionWide: true,
        operationId: request.operationId,
        createdAt: request.createdAt,
      });
      continue;
    }
    const matchingLaneIds = request.laneIds.filter((id) => affectedLaneIds.has(id));
    if (matchingLaneIds.length === 0) continue;
    refs.push({
      eventKind: request.eventKind,
      status: "in_flight",
      eventId: request.eventId,
      laneId: matchingLaneIds[0],
      affectedLaneIds: matchingLaneIds,
      operationId: request.operationId,
      createdAt: request.createdAt,
    });
  }
  return refs;
}

function remoteSideEffectCompletionClearsRollbackBlock(event: FlowEvent): boolean {
  const status = stringValue(event.payload.status);
  return status === "succeeded" || (status === "failed" && event.payload.remoteMutationAttempted === false);
}

function normalizeRemoteSideEffectRequest(event: FlowEvent): PendingRemoteSideEffectRequest | null {
  const eventKind = isRemoteSideEffectEventKind(event.payload.eventKind) ? event.payload.eventKind : null;
  if (!eventKind) return null;
  const operationId = stringValue(event.payload.operationId) ?? event.id;
  const laneIds = remoteSideEffectLaneIds(event);
  return {
    operationId,
    eventKind,
    eventId: event.id,
    laneIds,
    sessionWide: remoteSideEffectIsSessionWide(event) || laneIds.length === 0,
    createdAt: event.createdAt,
  };
}

function remoteSideEffectIsSessionWide(event: FlowEvent): boolean {
  const evidence = isRecord(event.payload.evidence) ? event.payload.evidence : {};
  return event.payload.sessionWide === true || evidence.sessionWide === true;
}

function remoteSideEffectLaneIds(event: FlowEvent): string[] {
  const evidence = isRecord(event.payload.evidence) ? event.payload.evidence : {};
  return uniqueStrings([...remoteSideEffectPayloadLaneIds(event.payload), ...remoteSideEffectPayloadLaneIds(evidence)]);
}

function remoteSideEffectPayloadLaneIds(payload: Record<string, unknown>): string[] {
  return uniqueStrings(compactStrings([
    stringValue(payload.laneId),
    stringValue(payload.commitLaneId),
    stringValue(payload.targetLaneId),
    ...stringArray(payload.affectedLaneIds).map((value) => stringValue(value)),
  ]));
}

function withCheckpointAuthority(
  checkpoint: WorkflowNodeCheckpoint,
  explicitFields: CheckpointExplicitFields,
): WorkflowNodeCheckpointWithAuthority {
  return {
    ...checkpoint,
    authority: checkpointAuthorityFromExplicitFields(explicitFields),
  };
}

function checkpointAuthorityForValidation(
  projection: FlowProjection,
  checkpoint: WorkflowNodeCheckpoint,
): CheckpointAuthority {
  return checkpointAuthorityFromCheckpoint(checkpoint) ?? checkpointAuthorityFromExplicitFields(projection.checkpointAuthorityFields[checkpoint.id] ?? {});
}

function checkpointAuthorityFromExplicitFields(explicitFields: CheckpointExplicitFields): CheckpointAuthority {
  return {
    laneIdExplicit: explicitFields.laneId === true,
    nodeIdExplicit: explicitFields.nodeId === true,
    phaseExplicit: explicitFields.phase === true,
    executionTargetExplicit: explicitFields.executionTarget === true,
  };
}

function checkpointAuthorityFromCheckpoint(checkpoint: WorkflowNodeCheckpoint): CheckpointAuthority | undefined {
  const authority = (checkpoint as { authority?: Partial<CheckpointAuthority> }).authority;
  if (!authority) return undefined;
  return {
    laneIdExplicit: authority.laneIdExplicit === true,
    nodeIdExplicit: authority.nodeIdExplicit === true,
    phaseExplicit: authority.phaseExplicit === true,
    executionTargetExplicit: authority.executionTargetExplicit === true,
  };
}

function checkpointExplicitAuthorityFields(value: Record<string, unknown>): CheckpointExplicitFields {
  return {
    ...(stringValue(value.laneId) ? { laneId: true } : {}),
    ...(stringValue(value.nodeId) ? { nodeId: true } : {}),
    ...(isCheckpointPhase(value.phase) ? { phase: true } : {}),
    ...(normalizeCheckpointExecutionTarget(value.executionTarget) ? { executionTarget: true } : {}),
  };
}

function mergeCheckpointExplicitFields(
  existing: CheckpointExplicitFields | undefined,
  incoming: CheckpointExplicitFields,
): CheckpointExplicitFields {
  return {
    ...(existing ?? {}),
    ...incoming,
  };
}

function isCheckpointPhase(value: unknown): value is WorkflowNodeCheckpointPhase {
  return value === "before" || value === "after";
}

function normalizeCheckpointExecutionTarget(value: unknown): WorkflowNodeCheckpoint["executionTarget"] | undefined {
  if (value === "new_worktree" || value === "current_branch") return value;
  return undefined;
}

function isCheckpointSource(value: unknown): value is WorkflowNodeCheckpointSource {
  return value === "agent_bridge" || value === "workflow_kernel" || value === "backend" || value === "user";
}

function normalizeCheckpointEvidenceRefs(value: unknown): WorkflowCheckpointEvidenceRef[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((item) => {
    if (!isRecord(item)) return [];
    const id = stringValue(item.id);
    if (!id) return [];
    const uri = stringValue(item.uri);
    const ref: WorkflowCheckpointEvidenceRef = {
      kind: normalizeCheckpointEvidenceRefKind(item.kind),
      id,
      ...(uri ? { uri } : {}),
    };
    return [ref];
  });
}

function mergeCheckpointEvidenceRefs(
  existing: WorkflowCheckpointEvidenceRef[],
  incoming: WorkflowCheckpointEvidenceRef[],
): WorkflowCheckpointEvidenceRef[] {
  const refs = [...existing];
  const seen = new Set(refs.map(checkpointEvidenceRefKey));
  for (const ref of incoming) {
    const key = checkpointEvidenceRefKey(ref);
    if (seen.has(key)) continue;
    refs.push(ref);
    seen.add(key);
  }
  return refs;
}

function checkpointEvidenceRefKey(ref: WorkflowCheckpointEvidenceRef): string {
  return `${ref.kind}\u0000${ref.id}\u0000${ref.uri ?? ""}`;
}

function normalizeCheckpointEvidenceRefKind(value: unknown): WorkflowCheckpointEvidenceRef["kind"] {
  if (value === "run" || value === "segment" || value === "evidence" || value === "changeset" || value === "artifact" || value === "commit") {
    return value;
  }
  return "evidence";
}

function normalizeDeliveryPushEvidence(event: FlowEvent): FlowEvidence | null {
  const laneId = stringValue(event.payload.laneId);
  if (!laneId) return null;
  const evidence = isRecord(event.payload.evidence) ? event.payload.evidence : {};
  const headSha = pullRequestHeadSha(event.payload);
  const url = stringValue(event.payload.url) ?? stringValue(evidence.url);
  return {
    id: `delivery-push:${event.id}`,
    laneId,
    segmentId: stringValue(event.payload.segmentId) ?? "",
    kind: "delivery-push",
    status: "passed",
    checks: compactStrings([
      stringValue(evidence.remote) ? `remote:${stringValue(evidence.remote)}` : null,
      stringValue(evidence.branch) ? `branch:${stringValue(evidence.branch)}` : null,
      headSha ? `head:${headSha}` : null,
    ]),
    artifacts: compactStrings([url]),
  };
}

function normalizePullRequestCreatedEvidence(event: FlowEvent): FlowEvidence | null {
  const laneId = stringValue(event.payload.laneId);
  if (!laneId) return null;
  const evidence = isRecord(event.payload.evidence) ? event.payload.evidence : {};
  const prNumber = numberValue(event.payload.prNumber) ?? numberValue(evidence.number);
  const headSha = pullRequestHeadSha(event.payload);
  const url = stringValue(event.payload.url) ?? stringValue(evidence.url);
  return {
    id: `pull-request:${event.id}`,
    laneId,
    segmentId: stringValue(event.payload.segmentId) ?? "",
    kind: "pull-request",
    status: "passed",
    checks: compactStrings([
      typeof prNumber === "number" ? `PR #${prNumber}` : null,
      stringValue(evidence.head) ? `head-branch:${stringValue(evidence.head)}` : null,
      headSha ? `head:${headSha}` : null,
    ]),
    artifacts: compactStrings([url]),
  };
}

function normalizePullRequestChecksRecorded(event: FlowEvent): { payload: PullRequestChecksRecordedPayload; evidence: FlowEvidence } | null {
  const evidencePayload = isRecord(event.payload.evidence) ? event.payload.evidence : {};
  const laneId = stringValue(event.payload.laneId);
  const headSha = stringValue(event.payload.headSha) ?? stringValue(evidencePayload.headSha);
  const url = stringValue(event.payload.url) ?? stringValue(evidencePayload.url);
  const prNumber = numberValue(event.payload.prNumber) ?? numberValue(evidencePayload.number);
  if (!laneId || !headSha || !url || typeof prNumber !== "number") return null;
  const status = normalizePullRequestCheckStatus(event.payload.status ?? evidencePayload.status);
  const checks = normalizePullRequestChecks(event.payload.checks ?? evidencePayload.checks);
  const review = normalizePullRequestReview(event.payload.review ?? evidencePayload.review ?? (isRecord(evidencePayload.gate) ? evidencePayload.gate : null), checks, status);
  const evidenceStatus: FlowEvidenceStatus = review.status === "changes_requested"
    ? "failed"
    : status === "passed"
      ? "passed"
      : status === "pending"
        ? "pending"
        : "failed";
  const payload: PullRequestChecksRecordedPayload = {
    laneId,
    prNumber,
    url,
    headSha,
    status,
    checks,
    review,
  };
  return {
    payload,
    evidence: {
      id: `pull-request-checks:${event.id}`,
      laneId,
      segmentId: stringValue(event.payload.segmentId) ?? "",
      kind: "pull-request-checks",
      status: evidenceStatus,
      checks: [
        ...checks.map((check) => `${check.name}:${check.status}`),
        ...(review.status !== "unknown" ? [`review:${review.status}`] : []),
      ],
      artifacts: compactStrings([url, ...checks.map((check) => check.url ?? null)]),
      ...(review.detail ? { detail: review.detail } : {}),
    },
  };
}

function rememberPullRequestHead(state: PullRequestHeadState, payload: Record<string, unknown>): void {
  const laneId = stringValue(payload.laneId);
  const commitLaneId = stringValue(payload.commitLaneId);
  const laneIds = uniqueStrings(compactStrings([laneId, commitLaneId]));
  const headSha = pullRequestHeadSha(payload);
  const headBranch = pullRequestHeadBranch(payload);
  const prNumber = numberValue(payload.prNumber) ?? (isRecord(payload.evidence) ? numberValue(payload.evidence.number) : null);
  const associatedPrNumber =
    typeof prNumber === "number"
      ? prNumber
      : laneIds.map((id) => state.byLaneId.get(id)?.prNumber).find((value): value is number => typeof value === "number");
  if (typeof associatedPrNumber !== "number") return;

  const current = state.currentByPrNumber.get(associatedPrNumber);
  const snapshotHeadSha = headSha ?? current?.headSha;
  const snapshotHeadBranch = headBranch ?? current?.headBranch;
  const snapshot: PullRequestHeadSnapshot = {
    prNumber: associatedPrNumber,
    ...(snapshotHeadSha ? { headSha: snapshotHeadSha } : {}),
    ...(snapshotHeadBranch ? { headBranch: snapshotHeadBranch } : {}),
  };
  for (const id of laneIds) {
    state.byLaneId.set(id, snapshot);
  }
  state.currentByPrNumber.set(associatedPrNumber, snapshot);
}

function matchesCurrentPullRequestHead(state: PullRequestHeadState, payload: PullRequestChecksRecordedPayload): boolean {
  const currentHead = state.currentByPrNumber.get(payload.prNumber) ?? state.byLaneId.get(payload.laneId);
  return currentHead?.headSha === payload.headSha;
}

function pullRequestHeadSha(payload: Record<string, unknown>): string | null {
  const evidence = isRecord(payload.evidence) ? payload.evidence : {};
  return stringValue(payload.headSha) ?? stringValue(payload.commitSha) ?? stringValue(evidence.headSha) ?? stringValue(evidence.commitSha);
}

function pullRequestHeadBranch(payload: Record<string, unknown>): string | null {
  const evidence = isRecord(payload.evidence) ? payload.evidence : {};
  return stringValue(payload.headBranch) ?? stringValue(payload.branch) ?? stringValue(evidence.head) ?? stringValue(evidence.headBranch) ?? stringValue(evidence.branch);
}

function normalizePullRequestChecks(value: unknown): PullRequestCheckResult[] {
  if (!Array.isArray(value)) return [];
  return value.map((item, index) => normalizePullRequestCheck(item, index));
}

function normalizePullRequestCheck(value: unknown, index: number): PullRequestCheckResult {
  const record = isRecord(value) ? value : {};
  const name = stringValue(record.name) ?? stringValue(record.context) ?? `check-${index + 1}`;
  const url = stringValue(record.url) ?? stringValue(record.detailsUrl) ?? stringValue(record.link);
  const detail = stringValue(record.detail);
  return {
    name,
    status: normalizePullRequestCheckStatus(record.status),
    ...(url ? { url } : {}),
    ...(detail ? { detail } : {}),
  };
}

function normalizePullRequestCheckStatus(value: unknown): PullRequestCheckStatus {
  if (value === "passed" || value === "failed" || value === "pending" || value === "changes_requested") return value;
  return "pending";
}

function normalizePullRequestReview(
  value: unknown,
  checks: PullRequestCheckResult[],
  status: PullRequestCheckStatus,
): PullRequestReviewResult {
  const record = isRecord(value) ? value : {};
  const rawStatus = record.status ?? record.reviewStatus ?? record.decision;
  const normalized = normalizePullRequestReviewStatus(rawStatus);
  const fallback = status === "changes_requested" || checks.some((check) => check.status === "changes_requested")
    ? "changes_requested"
    : "unknown";
  const detail = stringValue(record.detail) ?? stringValue(record.description) ?? stringValue(record.reason);
  const reviewer = stringValue(record.reviewer) ?? stringValue(record.author);
  const url = stringValue(record.url) ?? stringValue(record.link);
  return {
    status: normalized ?? fallback,
    ...(detail ? { detail } : {}),
    ...(reviewer ? { reviewer } : {}),
    ...(url ? { url } : {}),
  };
}

function normalizePullRequestReviewStatus(value: unknown): PullRequestReviewStatus | null {
  if (value === "approved" || value === "changes_requested" || value === "pending" || value === "unknown") return value;
  if (typeof value !== "string") return null;
  const normalized = value.trim().toLowerCase();
  if (normalized === "approved" || normalized === "approve") return "approved";
  if (normalized === "changes_requested" || normalized === "changes requested") return "changes_requested";
  if (normalized === "review_required" || normalized === "review required" || normalized === "pending") return "pending";
  if (normalized === "unknown") return "unknown";
  return null;
}

function normalizeFlowEvidenceStatus(value: unknown): FlowEvidenceStatus {
  if (value === "failed" || value === "skipped" || value === "pending") return value;
  return "passed";
}

function isPullRequestCheckGateLane(lane: FlowLane): boolean {
  if (lane.laneKind === "pull_request") return true;
  if (lane.laneKind === "validation" || lane.laneKind === "regression") return true;
  return /check|validation|ci/.test(`${lane.kind} ${lane.semanticSubtype} ${lane.semanticKey}`.toLowerCase());
}

function stringValue(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value : null;
}

function numberValue(value: unknown): number | null {
  return typeof value === "number" && Number.isInteger(value) ? value : null;
}

function compactStrings(values: Array<string | null | undefined>): string[] {
  return values.filter((value): value is string => Boolean(value));
}

function uniqueStrings(values: string[]): string[] {
  return [...new Set(values)];
}

function upsertLane(projection: FlowProjection, lane: FlowLane): void {
  const rollbackStatus = projection.laneRollbackStatuses[lane.id];
  const nextLane = rollbackStatus ? withLaneRollbackStatus(lane, rollbackStatus) : lane;
  const index = projection.lanes.findIndex((item) => item.id === lane.id || item.semanticKey === lane.semanticKey);
  if (index === -1) {
    projection.lanes.push(nextLane);
    return;
  }
  const existing = projection.lanes[index];
  if (isTerminalRollbackLane(existing)) {
    projection.lanes[index] = {
      ...existing,
      title: nextLane.title,
      output: uniqueStrings([...existing.output, ...nextLane.output]),
      status: existing.status,
      rollbackStatus: existing.rollbackStatus,
    };
    return;
  }
  projection.lanes[index] = {
    ...existing,
    ...nextLane,
    output: nextLane.output,
    status: nextLane.status,
  };
}

function upsertEdge(projection: FlowProjection, edge: FlowEdge): void {
  if (projection.edges.some((item) => item.sourceLaneId === edge.sourceLaneId && item.targetLaneId === edge.targetLaneId)) return;
  projection.edges.push(edge);
}

function upsertSegment(projection: FlowProjection, segment: FlowSegment): void {
  const index = projection.segments.findIndex((item) => item.id === segment.id);
  if (index === -1) {
    projection.segments.push(segment);
    return;
  }
  projection.segments[index] = { ...projection.segments[index], ...segment };
}

function updateSegment(
  projection: FlowProjection,
  segmentId: string,
  status: FlowSegment["status"],
  exitCode: number | null,
): void {
  projection.segments = projection.segments.map((segment) =>
    segment.id === segmentId ? { ...segment, status, exitCode } : segment,
  );
}

function setLaneStatus(
  projection: FlowProjection,
  laneId: string,
  status: FlowLaneStatus,
  input: { force?: boolean; clearRollbackStatus?: boolean } = {},
): void {
  if (input.clearRollbackStatus) delete projection.laneRollbackStatuses[laneId];
  projection.lanes = projection.lanes.map((lane) => {
    if (lane.id !== laneId) return lane;
    if (!input.force && isTerminalRollbackLane(lane)) return lane;
    const next = { ...lane, status };
    if (!input.clearRollbackStatus) return next;
    delete next.rollbackStatus;
    return next;
  });
}

function setLaneRollbackStatus(
  projection: FlowProjection,
  laneId: string,
  rollbackStatus: FlowLaneRollbackStatus,
): void {
  projection.laneRollbackStatuses[laneId] = rollbackStatus;
  projection.lanes = projection.lanes.map((lane) => (lane.id === laneId ? withLaneRollbackStatus(lane, rollbackStatus) : lane));
}

function withLaneRollbackStatus(lane: FlowLane, rollbackStatus: FlowLaneRollbackStatus): FlowLane {
  return {
    ...lane,
    status: isTerminalRollbackStatus(rollbackStatus) ? "blocked" : lane.status,
    rollbackStatus,
  };
}

function appendLaneOutput(projection: FlowProjection, laneId: string, text: string): void {
  projection.lanes = projection.lanes.map((lane) => (lane.id === laneId ? { ...lane, output: [...lane.output, text] } : lane));
}

function dependencyIsSatisfied(
  projection: FlowProjection,
  lane: FlowLane,
  dependencyId: string,
  completed: Set<string>,
): boolean {
  if (isTrustedFailedCheckpointRepairDependency(projection, lane, dependencyId)) return true;
  if (isRollbackSuccessorDependency(projection, lane, dependencyId)) return isTrustedRolledBackSuccessorDependency(projection, lane, dependencyId);
  if (completed.has(dependencyId)) return true;
  if (lane.laneKind !== "fix") return false;
  return isTrustedFailedRepairDependency(projection, lane, dependencyId);
}

function isTrustedRolledBackSuccessorDependency(projection: FlowProjection, lane: FlowLane, dependencyId: string): boolean {
  const dependency = projection.lanes.find((item) => item.id === dependencyId);
  if (dependency?.rollbackStatus !== "rolled_back") return false;
  return isRollbackSuccessorDependency(projection, lane, dependencyId);
}

function isRollbackSuccessorDependency(projection: FlowProjection, lane: FlowLane, dependencyId: string): boolean {
  return projection.checkpointIntents.some((intent) => {
    if (intent.status !== "requested") return false;
    if (intent.kind !== "repair" && intent.kind !== "variant" && intent.kind !== "fork") return false;
    if (!checkpointIntentTargetsLane(projection, intent, dependencyId)) return false;
    return checkpointIntentSuccessorMatches(intent, lane);
  });
}

function checkpointIntentTargetsLane(
  projection: FlowProjection,
  intent: WorkflowCheckpointIntent,
  dependencyId: string,
): boolean {
  if (intent.laneId === dependencyId) return true;
  const checkpoint = intent.checkpointId ? projection.checkpoints.find((item) => item.id === intent.checkpointId) : undefined;
  return checkpoint?.laneId === dependencyId;
}

function checkpointIntentSuccessorMatches(
  intent: WorkflowCheckpointIntent,
  lane: FlowLane,
): boolean {
  const successor = intent as WorkflowCheckpointIntent & WorkflowCheckpointIntentSuccessorFields;
  if (!successor.successorLaneId && !successor.successorSemanticKey) return false;
  const laneIdMatches = successor.successorLaneId ? successor.successorLaneId === lane.id : true;
  const semanticKeyMatches = successor.successorSemanticKey ? successor.successorSemanticKey === lane.semanticKey : true;
  return laneIdMatches && semanticKeyMatches;
}

function isCheckpointSuccessorWaitingForRollback(projection: FlowProjection, lane: FlowLane): boolean {
  return projection.checkpointIntents.some((intent) => {
    if (intent.status !== "requested") return false;
    if (intent.kind !== "repair") return false;
    if (!checkpointIntentSuccessorMatches(intent, lane)) return false;
    const targetLaneId = checkpointIntentTargetLaneId(projection, intent);
    if (!targetLaneId) return true;
    const targetLane = projection.lanes.find((item) => item.id === targetLaneId);
    if (targetLane?.rollbackStatus === "rolled_back") return false;
    if (
      projection.edges.some((edge) => edge.sourceLaneId === targetLaneId && edge.targetLaneId === lane.id) &&
      isTrustedFailedCheckpointRepairDependency(projection, lane, targetLaneId)
    ) {
      return false;
    }
    return true;
  });
}

function isTrustedFailedCheckpointRepairDependency(projection: FlowProjection, lane: FlowLane, dependencyId: string): boolean {
  const dependency = projection.lanes.find((item) => item.id === dependencyId);
  if (dependency?.status !== "failed") return false;
  return projection.checkpointIntents.some((intent) => {
    if (intent.status !== "requested" || intent.kind !== "repair") return false;
    if (!checkpointIntentTargetsLane(projection, intent, dependencyId)) return false;
    if (!checkpointIntentSuccessorMatches(intent, lane)) return false;
    return checkpointIntentSourceEvidenceHasFailure(projection, intent, dependencyId);
  });
}

function checkpointIntentSourceEvidenceHasFailure(
  projection: FlowProjection,
  intent: WorkflowCheckpointIntent,
  dependencyId: string,
): boolean {
  const checkpoint = intent.checkpointId ? projection.checkpoints.find((item) => item.id === intent.checkpointId) : undefined;
  if (!checkpoint) return false;
  const sourceEvidenceIds = Array.isArray(intent.sourceEvidenceIds)
    ? intent.sourceEvidenceIds.filter((value): value is string => typeof value === "string")
    : [];
  if (sourceEvidenceIds.length === 0) return false;
  return sourceEvidenceIds.some((evidenceId) =>
    projection.evidence.some((evidence) =>
      evidence.id === evidenceId &&
      evidence.laneId === dependencyId &&
      evidence.status === "failed" &&
      evidenceMatchesCheckpoint(projection, checkpoint, evidence)
    )
  );
}

function evidenceMatchesCheckpoint(
  projection: FlowProjection,
  checkpoint: WorkflowNodeCheckpoint,
  evidence: FlowEvidence,
): boolean {
  if (checkpoint.runId) {
    const segment = projection.segments.find((item) => item.id === evidence.segmentId && item.laneId === evidence.laneId);
    if (!segment || segment.runId !== checkpoint.runId) return false;
    if (checkpoint.segmentId && evidence.segmentId !== checkpoint.segmentId) return false;
    return true;
  }
  if (checkpoint.segmentId) {
    return evidence.segmentId === checkpoint.segmentId;
  }
  return checkpoint.evidenceRefs.some((ref) => ref.kind === "evidence" && ref.id === evidence.id);
}

function isTrustedFailedRepairDependency(projection: FlowProjection, lane: FlowLane, dependencyId: string): boolean {
  const dependency = projection.lanes.find((item) => item.id === dependencyId);
  if (dependency?.status !== "failed") return false;
  const match = /^repair:([^:]+):([^:]+)$/.exec(lane.semanticKey);
  if (!match || match[1] !== dependencyId) return false;
  return projection.evidence.some((evidence) => evidence.id === match[2] && evidence.laneId === dependencyId && evidence.status === "failed");
}

function isBlockedByWaitingDecision(projection: FlowProjection, laneId: string): boolean {
  return projection.userDecisions.some((decision) => {
    if (decision.status !== "waiting_input" || !decision.targetLaneId) return false;
    return laneId === decision.targetLaneId || laneDependsOn(projection.edges, laneId, decision.targetLaneId);
  });
}

function laneDependsOn(edges: FlowEdge[], laneId: string, dependencyId: string): boolean {
  const incoming = new Map<string, string[]>();
  for (const edge of edges) {
    incoming.set(edge.targetLaneId, [...(incoming.get(edge.targetLaneId) ?? []), edge.sourceLaneId]);
  }
  const queue = incoming.get(laneId) ?? [];
  const visited = new Set<string>();
  while (queue.length > 0) {
    const current = queue.shift() as string;
    if (current === dependencyId) return true;
    if (visited.has(current)) continue;
    visited.add(current);
    queue.push(...(incoming.get(current) ?? []));
  }
  return false;
}

function latestSegmentForLane(projection: FlowProjection, laneId: string): FlowSegment | null {
  return [...projection.segments].reverse().find((segment) => segment.laneId === laneId) ?? null;
}

function hasScopeConflict(lane: FlowLane, occupied: Array<{ fileScopes: string[]; packageScopes: string[] }>): boolean {
  return occupied.some((scope) => intersects(lane.fileScopes, scope.fileScopes) || intersects(lane.packageScopes, scope.packageScopes));
}

function intersects(left: string[], right: string[]): boolean {
  return left.some((value) => right.includes(value));
}

function createsCycle(edges: FlowEdge[], sourceLaneId: string, targetLaneId: string): boolean {
  const outgoing = new Map<string, string[]>();
  for (const edge of [...edges, { id: "candidate", sourceLaneId, targetLaneId }]) {
    outgoing.set(edge.sourceLaneId, [...(outgoing.get(edge.sourceLaneId) ?? []), edge.targetLaneId]);
  }
  const visited = new Set<string>();
  const stack = new Set<string>();
  const visit = (id: string): boolean => {
    if (stack.has(id)) return true;
    if (visited.has(id)) return false;
    visited.add(id);
    stack.add(id);
    for (const next of outgoing.get(id) ?? []) {
      if (visit(next)) return true;
    }
    stack.delete(id);
    return false;
  };
  return [...outgoing.keys()].some(visit);
}

function blocked(reason: string): GateResult {
  return { allowed: false, reason };
}

function parseFirstJsonObject(output: string): Record<string, unknown> | null {
  const first = output.indexOf("{");
  const last = output.lastIndexOf("}");
  if (first === -1 || last < first) return null;
  try {
    const value = JSON.parse(output.slice(first, last + 1)) as unknown;
    return isRecord(value) ? value : null;
  } catch {
    return null;
  }
}

function isWorkflowIntentOperationType(value: string): value is WorkflowIntentOperationType {
  return (
    value === "AnalyzeRequirement" ||
    value === "DiscoverProject" ||
    value === "ProposeLanes" ||
    value === "SplitLane" ||
    value === "JoinLanes" ||
    value === "StartImplementation" ||
    value === "RequestValidation" ||
    value === "RequestReview" ||
    value === "RequestUserDecision" ||
    value === "ReplanFromEvidence" ||
    value === "Commit" ||
    value === "DeclareEdge"
  );
}

function isLaneStatus(value: unknown): value is FlowLaneStatus {
  return (
    value === "pending" ||
    value === "ready" ||
    value === "running" ||
    value === "waiting_input" ||
    value === "completed" ||
    value === "failed" ||
    value === "blocked"
  );
}

function normalizeNodeRollbackStatus(value: unknown): FlowLaneRollbackStatus | undefined {
  if (value === "rolled_back" || value === "inactive" || value === "rejected") return value;
  return undefined;
}

function isTerminalRollbackLane(lane: FlowLane): boolean {
  return isTerminalRollbackStatus(lane.rollbackStatus);
}

function isTerminalRollbackStatus(value: FlowLaneRollbackStatus | undefined): value is "rolled_back" | "inactive" {
  return value === "rolled_back" || value === "inactive";
}

function isCompletedLane(lane: FlowLane): boolean {
  return lane.status === "completed" && !isTerminalRollbackLane(lane);
}

function isRemoteSideEffectEventKind(value: unknown): value is WorkflowRemoteSideEffectEventKind {
  return remoteSideEffectEventKinds.includes(value as WorkflowRemoteSideEffectEventKind);
}

function isWorkflowLaneKind(value: unknown): value is WorkflowLaneKind {
  return (
    value === "discovery" ||
    value === "design" ||
    value === "implementation" ||
    value === "fix" ||
    value === "validation" ||
    value === "regression" ||
    value === "review" ||
    value === "commit" ||
    value === "pull_request" ||
    value === "join" ||
    value === "decision"
  );
}

function isAgentKind(value: unknown): value is AgentKind {
  return (
    value === "hermes" ||
    value === "codex" ||
    value === "gemini" ||
    value === "claude-code" ||
    value === "openclaw" ||
    value === "agy"
  );
}

function isAgentRunSandbox(value: unknown): value is AgentRunSandbox {
  return value === "read-only" || value === "workspace-write" || value === "danger-full-access";
}

function isWorkflowSideEffectKind(value: unknown): value is WorkflowSideEffectKind {
  return value === "filesystem" || value === "git" || value === "network" || value === "process" || value === "artifact";
}

function isUserDecisionAction(value: unknown): value is UserDecisionAction {
  return value === "backtrack" || value === "parallel_worktree" || value === "continue" || value === "abort";
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

function idFragment(value: string): string {
  const fragment = value.replace(/^lane-/, "").replace(/^evidence-/, "").replace(/[^a-zA-Z0-9_-]+/g, "-").replace(/^-+|-+$/g, "");
  return fragment.length > 0 ? fragment : "item";
}

function requireString(value: unknown, field: string): string {
  if (typeof value !== "string" || value.trim().length === 0) throw new Error(`${field} must be a non-empty string.`);
  return value.trim();
}

function stringArray(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : [];
}

function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((item) => typeof item === "string");
}

function numberOrNull(value: unknown): number | null {
  return typeof value === "number" ? value : null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}
