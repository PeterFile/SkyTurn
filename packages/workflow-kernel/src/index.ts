import type {
  AgentKind,
  AgentRunSandbox,
  ChangesetEvidence,
  UserDecisionAction,
  UserDecisionAnsweredPayload,
  UserDecisionProjection,
  UserDecisionRequestedPayload,
  WorkflowLaneKind,
  WorkflowLaneSemanticSubtype,
  WorkflowProjectionNodeKind,
  WorkflowRuntimePolicy,
  WorkflowSideEffectKind,
  WorkflowVariantAdoption,
  WorkflowWorktreeIdentity,
} from "@skyturn/project-core";

export type {
  ChangesetEvidence,
  UserDecisionAnsweredPayload,
  UserDecisionRequestedPayload,
  WorkflowLaneKind,
  WorkflowLaneSemanticSubtype,
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
  agentKind: AgentKind;
  nodeKind: WorkflowProjectionNodeKind;
  executable: boolean;
  runtimePolicy: WorkflowRuntimePolicy;
  status: FlowLaneStatus;
  fileScopes: string[];
  packageScopes: string[];
  requiredEvidence: string[];
  output: string[];
}

export type FlowLaneStatus = "pending" | "ready" | "running" | "waiting_input" | "completed" | "failed" | "blocked";

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
}

export type FlowEvidenceStatus = "passed" | "failed" | "skipped" | "pending";

export type PullRequestCheckStatus = "passed" | "failed" | "pending";

export interface PullRequestCheckResult {
  name: string;
  status: PullRequestCheckStatus;
  url?: string;
  detail?: string;
}

export interface PullRequestChecksRecordedPayload {
  laneId: string;
  prNumber: number;
  url: string;
  headSha: string;
  status: PullRequestCheckStatus;
  checks: PullRequestCheckResult[];
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
  | "workflow.edge.declared"
  | "workflow.segment.started"
  | "workflow.segment.output_delta"
  | "workflow.segment.finished"
  | "workflow.evidence.recorded"
  | "workflow.changeset.evidence_recorded"
  | "workflow.join.completed"
  | "workflow.replan.requested"
  | "workflow.user_decision.requested"
  | "workflow.user_decision.answered"
  | "workflow.commit.created"
  | "workflow.delivery.pushed"
  | "workflow.pull_request.created"
  | "workflow.pull_request.checks_recorded"
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
  projectionNodes: FlowProjectionNode[];
  userDecisions: UserDecisionProjection[];
  edges: FlowEdge[];
  segments: FlowSegment[];
  evidence: FlowEvidence[];
  changesetEvidence: ChangesetEvidence[];
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
    const hasDiscovery = projection.lanes.some((lane) => lane.kind === "discovery" && lane.status === "completed") || Boolean(projection.projectProfile);
    if (!hasDiscovery) return blocked("Implementation before discovery is rejected.");
  }
  if (operation.type === "RequestReview") {
    const hasImplementationEvidence = projection.evidence.some((evidence) => {
      const lane = projection.lanes.find((item) => item.id === evidence.laneId);
      return evidence.status === "passed" && Boolean(lane?.kind.includes("implementation"));
    });
    if (!hasImplementationEvidence) return blocked("Review before implementation evidence is rejected.");
  }
  if (operation.type === "JoinLanes") {
    const incomplete = operation.upstreamLaneIds.filter((id) => projection.lanes.find((lane) => lane.id === id)?.status !== "completed");
    if (incomplete.length > 0) return blocked("Join before upstream lanes complete is rejected.");
  }
  if (operation.type === "Commit") {
    const hasReview = projection.lanes.some((lane) => lane.kind === "review" && lane.status === "completed");
    const hasValidation = projection.lanes.some((lane) => /validation|test|regression/.test(lane.kind) && lane.status === "completed");
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
  const completed = new Set(projection.lanes.filter((lane) => lane.status === "completed").map((lane) => lane.id));
  const incoming = new Map<string, string[]>();
  for (const edge of projection.edges) {
    incoming.set(edge.targetLaneId, [...(incoming.get(edge.targetLaneId) ?? []), edge.sourceLaneId]);
  }

  for (const lane of projection.lanes) {
    if (selected.length >= input.allowedParallelism) break;
    if (!lane.executable) continue;
    if (lane.status !== "pending" && lane.status !== "ready") continue;
    if (isBlockedByWaitingDecision(projection, lane.id)) continue;
    if (!(incoming.get(lane.id) ?? []).every((dependency) => dependencyIsSatisfied(projection, lane, dependency, completed))) continue;
    if (hasScopeConflict(lane, occupied)) continue;
    selected.push(lane);
    occupied.push({ fileScopes: lane.fileScopes, packageScopes: lane.packageScopes });
  }
  return selected;
}

export function reduceWorkflowEvents(events: FlowEvent[]): FlowProjection {
  const unique = dedupeEvents(events);
  const projection = emptyFlowProjection(unique[0]?.sessionId ?? "session-1");
  projection.events = unique;
  const pullRequestHeadState: PullRequestHeadState = {
    byLaneId: new Map(),
    currentByPrNumber: new Map(),
  };

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
      upsertLane(projection, normalizeLane(event.payload.lane));
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
          checks.payload.status === "passed" &&
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
    projectionNodes: [],
    userDecisions: [],
    edges: [],
    segments: [],
    evidence: [],
    changesetEvidence: [],
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
  return {
    id,
    semanticKey: typeof record.semanticKey === "string" ? record.semanticKey : id,
    kind,
    laneKind,
    semanticSubtype,
    title: typeof record.title === "string" ? record.title : id,
    agentKind: isAgentKind(record.agentKind) ? record.agentKind : "codex",
    nodeKind: "agent_task",
    executable,
    runtimePolicy: normalizeRuntimePolicy(record.runtimePolicy, laneKind, executable),
    status: isLaneStatus(record.status) ? record.status : "pending",
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
  };
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
  const laneId = stringValue(event.payload.laneId);
  const headSha = stringValue(event.payload.headSha);
  const url = stringValue(event.payload.url);
  const prNumber = numberValue(event.payload.prNumber);
  if (!laneId || !headSha || !url || typeof prNumber !== "number") return null;
  const status = normalizePullRequestCheckStatus(event.payload.status);
  const checks = normalizePullRequestChecks(event.payload.checks);
  const payload: PullRequestChecksRecordedPayload = {
    laneId,
    prNumber,
    url,
    headSha,
    status,
    checks,
  };
  return {
    payload,
    evidence: {
      id: `pull-request-checks:${event.id}`,
      laneId,
      segmentId: stringValue(event.payload.segmentId) ?? "",
      kind: "pull-request-checks",
      status,
      checks: checks.map((check) => `${check.name}:${check.status}`),
      artifacts: compactStrings([url, ...checks.map((check) => check.url ?? null)]),
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
  const url = stringValue(record.url) ?? stringValue(record.detailsUrl);
  const detail = stringValue(record.detail);
  return {
    name,
    status: normalizePullRequestCheckStatus(record.status),
    ...(url ? { url } : {}),
    ...(detail ? { detail } : {}),
  };
}

function normalizePullRequestCheckStatus(value: unknown): PullRequestCheckStatus {
  if (value === "passed" || value === "failed" || value === "pending") return value;
  return "pending";
}

function normalizeFlowEvidenceStatus(value: unknown): FlowEvidenceStatus {
  if (value === "failed" || value === "skipped" || value === "pending") return value;
  return "passed";
}

function isPullRequestCheckGateLane(lane: FlowLane): boolean {
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
  const index = projection.lanes.findIndex((item) => item.id === lane.id || item.semanticKey === lane.semanticKey);
  if (index === -1) {
    projection.lanes.push(lane);
    return;
  }
  projection.lanes[index] = { ...projection.lanes[index], ...lane };
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

function setLaneStatus(projection: FlowProjection, laneId: string, status: FlowLaneStatus): void {
  projection.lanes = projection.lanes.map((lane) => (lane.id === laneId ? { ...lane, status } : lane));
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
  if (completed.has(dependencyId)) return true;
  if (lane.laneKind !== "fix") return false;
  return isTrustedFailedRepairDependency(projection, lane, dependencyId);
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
  return value === "pending" || value === "ready" || value === "running" || value === "waiting_input" || value === "completed" || value === "failed" || value === "blocked";
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
    value === "join" ||
    value === "decision"
  );
}

function isAgentKind(value: unknown): value is AgentKind {
  return value === "hermes" || value === "codex" || value === "gemini" || value === "claude-code" || value === "openclaw";
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
