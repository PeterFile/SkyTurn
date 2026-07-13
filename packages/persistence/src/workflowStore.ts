import Database from "better-sqlite3";
import { mkdirSync, realpathSync } from "node:fs";
import { join, resolve } from "node:path";

import { hasConcreteRunEvidence, normalizeSessionTarget } from "@skyturn/project-core";
import type {
  AgentKind,
  CanvasNode,
  CanvasSession,
  EvidenceCheck,
  HermesPlannerTransport,
  NodeLifecyclePhase,
  NodeRuntimeState,
  NodeStatus,
  RunEvidence,
  SessionTarget,
  UserDecisionProjection,
  WorktreeMetadata,
  WorkflowLedgerSummary,
  WorkflowLedgerSummaryEvent,
  WorkflowLoopEngineeringProjectionInput,
  WorkflowLoopEngineeringState,
  WorkflowMode,
  WorkflowNodeCheckpoint,
  WorkflowRollbackEligibility,
  WorkflowWorktreeIdentity,
} from "@skyturn/project-core";
import type { WorkflowNodePositionUpdateRequest } from "./index.js";
import {
  compileWorkflowIntent,
  createDefaultFlowPolicy,
  evaluateRollbackEligibility,
  nodeStatusProjectionForFlowLane,
  parseWorkflowIntent,
  projectLoopEngineeringState,
  reduceWorkflowEvents,
  scheduleReadyLanes as scheduleFlowReadyLanes,
  type CompileWorkflowIntentResult,
  type FlowEvidence,
  type FlowEvent,
  type FlowEventKind,
  type FlowLane,
  type FlowProjection,
} from "@skyturn/workflow-kernel";

export type WorkflowLaneKind =
  | "planner"
  | "analysis"
  | "planning"
  | "coding"
  | "review"
  | "fix"
  | "validation"
  | "commit"
  | "pull_request"
  | "merge"
  | "closeout";

export type WorkflowLaneStatus =
  | "pending"
  | "blocked"
  | "ready"
  | "running"
  | "waiting_input"
  | "reviewing"
  | "retrying"
  | "completed"
  | "failed"
  | "archived";

export type WorkflowAuditEventKind =
  | "workflow.run.recovery_failed"
  | "workflow.run.start_reconciliation_failed"
  | "workflow.node.checkpoint_failed";

export type WorkflowEventKind =
  | "user_input"
  | "hermes_session_started"
  | "hermes_session_reused"
  | "hermes_session_recovered"
  | "hermes_session_failed"
  | "hermes_output_delta"
  | "node_declared"
  | "node_patched"
  | "canvas_node_position_updated"
  | "edge_declared"
  | "gate_opened"
  | "gate_blocked"
  | "gate_satisfied"
  | "segment_started"
  | "segment_output_delta"
  | "segment_tool_call"
  | "segment_evidence"
  | "segment_finished"
  | "handoff_created"
  | "checkpoint_created"
  | "review_completed"
  | "continuation_requested"
  | "lane_status_changed"
  | WorkflowAuditEventKind
  | FlowEventKind;

export interface WorkflowCardCreateInput {
  id?: string;
  taskKey?: string;
  title: string;
  agent: AgentKind;
  status?: NodeStatus;
  progress?: string;
  brief: string;
  dependencies?: string[];
  position?: CanvasNode["position"];
  output?: string | string[];
  worktreePath?: string;
}

export interface WorkflowCardUpdateInput {
  id: string;
  taskKey?: string;
  title?: string;
  agent?: AgentKind;
  status?: NodeStatus;
  progress?: string;
  brief?: string;
  dependencies?: string[];
  output?: string | string[];
  worktreePath?: string;
}

export interface WorkflowCardDeleteInput {
  id: string;
  reason?: string;
}

export type WorkflowCardToolCall =
  | { tool: "createWorkflowCard"; toolCallId?: string; input: WorkflowCardCreateInput }
  | { tool: "updateWorkflowCard"; toolCallId?: string; input: WorkflowCardUpdateInput }
  | { tool: "deleteWorkflowCard"; toolCallId?: string; input: WorkflowCardDeleteInput };

export interface WorkflowStoreOptions {
  projectRoot: string;
  databasePath?: string;
}

function canonicalPath(value: string): string {
  const absolute = resolve(value);
  try {
    return realpathSync.native(absolute);
  } catch {
    return absolute;
  }
}

export interface CreateWorkflowSessionInput {
  id: string;
  projectId: string;
  title: string;
  goal: string;
  mode: WorkflowMode;
  plannerProfile: string;
  transport: HermesPlannerTransport;
  processId?: number;
  opaqueHandle?: string;
  recoveryReason?: string;
  target?: SessionTarget;
  now: string;
}

export interface WorkflowSessionRecord {
  id: string;
  projectId: string;
  hermesSessionId: string;
  plannerLaneId: string;
  title: string;
  goal: string;
  mode: WorkflowMode;
  target: SessionTarget;
  createdAt: string;
  updatedAt: string;
}

export interface HermesSessionRecord {
  id: string;
  workflowSessionId: string;
  transport: HermesPlannerTransport;
  plannerProfile: string;
  processId: number | null;
  opaqueHandle: string | null;
  status: string;
  startedAt: string;
  lastSeenAt: string;
  endedAt: string | null;
  recoveryReason: string | null;
  metadata: Record<string, unknown>;
}

export interface WorkflowEventRecord {
  id: string;
  sessionId: string;
  seq: number;
  kind: WorkflowEventKind;
  source: string;
  laneId: string | null;
  segmentId: string | null;
  causationId: string | null;
  correlationId: string | null;
  idempotencyKey: string | null;
  payload: Record<string, unknown>;
  createdAt: string;
}

export interface WorkflowLaneRecord {
  id: string;
  sessionId: string;
  nodeId: string;
  semanticKey: string | null;
  laneKind: WorkflowLaneKind;
  agentKind: AgentKind;
  title: string;
  brief: string;
  status: WorkflowLaneStatus;
  phase: string;
  archived: boolean;
  createdAt: string;
  updatedAt: string;
}

export interface WorkflowSegmentRecord {
  id: string;
  sessionId: string;
  laneId: string;
  segmentId: string;
  parentSegmentId: string | null;
  runId: string;
  agentKind: AgentKind;
  transport: string;
  status: string;
  worktreePath: string;
  startedAt: string;
  endedAt: string | null;
  exitCode: number | null;
  evidence: Record<string, unknown> | null;
  errorReason: string | null;
}

export interface RunningWorkflowSegment {
  sessionId: string;
  laneId: string;
  segmentId: string;
  runId: string;
  agentKind: AgentKind;
  status: "running";
}

export type RunCheckpointEnrichmentCandidate = Omit<RunningWorkflowSegment, "status">;

export interface WorkflowCardToolContext {
  sourceRunId: string;
  now: string;
  causationId?: string;
  correlationId?: string;
}

export interface WorkflowCardToolResult {
  tool: WorkflowCardToolCall["tool"];
  nodeId: string;
  status: "applied" | "skipped";
  message: string;
}

export interface AppendWorkflowEventInput {
  sessionId: string;
  kind: WorkflowEventKind;
  source: string;
  laneId?: string | null;
  segmentId?: string | null;
  causationId?: string | null;
  correlationId?: string | null;
  idempotencyKey?: string | null;
  payload: Record<string, unknown>;
  now: string;
}

export interface AppendUserInput {
  sessionId: string;
  inputId: string;
  text: string;
  now: string;
}

export interface RecordCanvasNodePositionInput extends WorkflowNodePositionUpdateRequest {
  now: string;
}

export interface WorkflowLedgerOptions {
  recentEventLimit?: number;
  factLimit?: number;
  maxSummaryLength?: number;
}

export interface ScheduledWorkflowLane extends FlowLane {
  runId: string;
  segmentId: string;
}

export interface ScheduleReadyWorkflowLanesInput {
  allowedParallelism?: number;
  now: string;
}

export interface ScheduleReadyWorkflowLanesResult {
  readyLanes: ScheduledWorkflowLane[];
  projection: FlowProjection;
}

export interface WorkflowLaneReassignmentInput {
  requestId: string;
  sessionId: string;
  laneId: string;
  agentKind: AgentKind;
  now: string;
}

export interface WorkflowLaneReassignmentResult {
  event: WorkflowEventRecord;
  projection: FlowProjection;
  canvasSession: CanvasSession;
}

export interface RecordRunResultInput {
  sessionId: string;
  laneId: string;
  segmentId: string;
  runId: string;
  agentKind: AgentKind;
  outputSummary?: string;
  evidence: RunEvidence;
  now: string;
}

export interface ClaimPlannerRunStartInput {
  sessionId: string;
  laneId: string;
  runId: string;
  agentKind: AgentKind;
  worktreePath: string;
  now: string;
}

export interface ClaimPlannerRunStartResult {
  segment: RunningWorkflowSegment;
  created: boolean;
}

export interface ResolveCurrentBranchTargetInput {
  sessionId: string;
  branchName: string;
  now: string;
}

export interface RecordRunCheckpointInput {
  sessionId: string;
  nodeId: string;
  laneId: string;
  runId: string;
  segmentId: string;
  phase: WorkflowNodeCheckpoint["phase"];
  executionTarget: WorkflowNodeCheckpoint["executionTarget"];
  worktreeId?: string;
  worktreePath: string;
  branchName: string;
  headCommit: string;
  worktreeState: NonNullable<WorkflowNodeCheckpoint["worktreeState"]>;
  evidenceRefs: WorkflowNodeCheckpoint["evidenceRefs"];
  now: string;
}

export interface WorkflowNodeCheckpointQuery {
  sessionId: string;
  nodeId?: string;
  laneId?: string;
  runId?: string;
  phase?: WorkflowNodeCheckpoint["phase"];
}

export interface WorkflowNodeRollbackInput {
  sessionId: string;
  nodeId?: string;
  laneId?: string;
  checkpointId?: string;
  requestId?: string;
  localRollbackSafe?: boolean;
  manualRepairRequired?: boolean;
  now: string;
}

export interface WorkflowNodeRollbackEligibilityInput {
  sessionId: string;
  nodeId?: string;
  laneId?: string;
  checkpointId?: string;
  localRollbackSafe?: boolean;
}

export type WorkflowRollbackBlockCode =
  | "remote_side_effect"
  | "in_flight_remote_side_effect"
  | "manual_repair_required"
  | "invalid_checkpoint"
  | "unknown_target";

export interface WorkflowRollbackBlockReason {
  code: WorkflowRollbackBlockCode;
  message: string;
  eventKinds?: string[];
  remoteSideEffects?: WorkflowRollbackEligibility["blockingRemoteSideEffects"];
  affectedLaneIds?: string[];
  manualRepairRequired?: boolean;
}

export type WorkflowNodeRollbackResult =
  | {
      status: "applied";
      event: WorkflowEventRecord;
      requestedEvent: WorkflowEventRecord;
      eligibility: WorkflowRollbackEligibility;
      projection: FlowProjection;
    }
  | {
      status: "blocked";
      eligibility: WorkflowRollbackEligibility;
      blockedReason: WorkflowRollbackBlockReason;
      manualRepairRequired?: boolean;
      projection: FlowProjection;
    };

export interface WorkflowCheckpointSuccessorRequest {
  sessionId: string;
  nodeId?: string;
  laneId?: string;
  checkpointId: string;
  intentId?: string;
  successorLaneId?: string;
  successorSemanticKey?: string;
  title?: string;
  instruction?: string;
  now: string;
}

export interface WorkflowCheckpointSuccessorResult {
  status: "requested";
  event: WorkflowEventRecord;
  laneEvent: WorkflowEventRecord;
  edgeEvents: WorkflowEventRecord[];
  projection: FlowProjection;
}

interface PreparedCheckpointSuccessorRequest {
  projection: FlowProjection;
  checkpoint: WorkflowNodeCheckpoint;
  targetLaneId: string;
  lane: FlowLane;
  successorLaneId: string;
  successorSemanticKey: string;
  intentId: string;
  edgeSources: string[];
  sourceEvidenceIds: string[];
  failedEvidence?: FlowEvidence;
  failedRunId?: string;
  failedEvidenceFallbackReason?: string;
}

interface PreparedRepairRegressionLane {
  laneId: string;
  semanticKey: string;
  failedEvidenceId: string;
  lane: Record<string, unknown>;
}

export interface SegmentEvidenceInput {
  sessionId: string;
  laneId: string;
  segmentId: string;
  runId: string;
  agentKind: AgentKind;
  transport: string;
  worktreePath: string;
  evidence: {
    exitCode?: number | null;
    changesetId?: string | null;
    checks?: EvidenceCheck[];
    artifacts?: string[];
    review?: EvidenceCheck | null;
    errorReason?: string | null;
  };
  now: string;
}

export interface FinishSegmentInput {
  sessionId: string;
  laneId: string;
  segmentId: string;
  runId: string;
  agentKind: AgentKind;
  transport: string;
  worktreePath: string;
  status: "succeeded" | "failed" | "cancelled" | "timed-out";
  exitCode: number | null;
  errorReason?: string | null;
  now: string;
}

export interface ContinuationInput {
  sessionId: string;
  laneId: string;
  segmentId: string;
  runId: string;
  agentKind: AgentKind;
  transport: string;
  worktreePath: string;
  now: string;
}

export interface ManualEvidenceInput {
  sessionId: string;
  laneId: string;
  idempotencyKey: string;
  summary: string;
  now: string;
}

interface MigrationRow {
  version: number;
}

interface PragmaRow {
  journal_mode?: string;
  foreign_keys?: number;
}

interface SessionRow {
  id: string;
  project_id: string;
  hermes_session_id: string;
  planner_lane_id: string;
  title: string;
  goal: string;
  mode: WorkflowMode;
  execution_target: string;
  selected_branch: string;
  base_ref: string | null;
  created_at: string;
  updated_at: string;
}

interface HermesSessionRow {
  id: string;
  workflow_session_id: string;
  transport: HermesPlannerTransport;
  planner_profile: string;
  process_id: number | null;
  opaque_handle: string | null;
  status: string;
  started_at: string;
  last_seen_at: string;
  ended_at: string | null;
  recovery_reason: string | null;
  metadata_json: string;
}

interface EventRow {
  id: string;
  session_id: string;
  seq: number;
  kind: WorkflowEventKind;
  source: string;
  lane_id: string | null;
  segment_id: string | null;
  causation_id: string | null;
  correlation_id: string | null;
  idempotency_key: string | null;
  payload_json: string;
  created_at: string;
}

interface LaneRow {
  id: string;
  session_id: string;
  node_id: string;
  semantic_key: string | null;
  lane_kind: WorkflowLaneKind;
  agent_kind: AgentKind;
  title: string;
  brief: string;
  status: WorkflowLaneStatus;
  phase: string;
  archived: 0 | 1;
  created_at: string;
  updated_at: string;
}

interface EdgeRow {
  id: string;
  session_id: string;
  source_lane_id: string;
  target_lane_id: string;
  created_at: string;
}

interface SegmentRow {
  id: string;
  session_id: string;
  lane_id: string;
  parent_segment_id: string | null;
  run_id: string;
  agent_kind: AgentKind;
  transport: string;
  status: string;
  worktree_path: string;
  started_at: string;
  ended_at: string | null;
  exit_code: number | null;
  evidence_json: string | null;
  error_reason: string | null;
}

interface WorkflowStoreStatements {
  migrations: Database.Statement;
  getSession: Database.Statement;
  listWorkflowSessionIds: Database.Statement;
  listHermesSessions: Database.Statement;
  listEvents: Database.Statement;
  getEventByIdempotencyKey: Database.Statement;
  maxSeq: Database.Statement;
  insertEvent: Database.Statement;
  getLane: Database.Statement;
  getLaneBySemanticKey: Database.Statement;
  listLanes: Database.Statement;
  insertLane: Database.Statement;
  updateLaneStatus: Database.Statement;
  archiveLane: Database.Statement;
  insertEdge: Database.Statement;
  listEdges: Database.Statement;
  getSegment: Database.Statement;
  getSegmentByRunId: Database.Statement;
  listSegments: Database.Statement;
  listRunningPlannerSegments: Database.Statement;
  insertSegment: Database.Statement;
  updateSegmentEvidence: Database.Statement;
  finishSegment: Database.Statement;
  insertSession: Database.Statement;
  updateCurrentBranchTarget: Database.Statement;
  insertHermesSession: Database.Statement;
}

export class WorkflowStore {
  readonly databasePath: string;

  private readonly db: Database.Database;
  private readonly projectRoot: string;
  private readonly statements: WorkflowStoreStatements;

  constructor(options: WorkflowStoreOptions) {
    this.projectRoot = canonicalPath(options.projectRoot);
    this.databasePath = options.databasePath ?? join(this.projectRoot, ".devflow", "skyturn-workflow.sqlite");
    mkdirSync(join(this.projectRoot, ".devflow"), { recursive: true });
    this.db = new Database(this.databasePath);
    this.db.pragma("journal_mode = WAL");
    this.db.pragma("foreign_keys = ON");
    applyMigrations(this.db);
    this.statements = prepareStatements(this.db);
  }

  close(): void {
    this.db.close();
  }

  readPragmas(): { journalMode: string; foreignKeys: number } {
    const journalRows = this.db.pragma("journal_mode", { simple: false }) as PragmaRow[];
    const foreignKeyRows = this.db.pragma("foreign_keys", { simple: false }) as PragmaRow[];
    const journal = journalRows[0];
    const foreignKeys = foreignKeyRows[0];
    return {
      journalMode: String(journal?.journal_mode ?? "").toLowerCase(),
      foreignKeys: Number(foreignKeys?.foreign_keys ?? 0),
    };
  }

  listAppliedMigrations(): number[] {
    return (this.statements.migrations.all() as MigrationRow[]).map((row) => row.version);
  }

  createWorkflowSession(input: CreateWorkflowSessionInput): WorkflowSessionRecord {
    validateHermesTransport(input);
    const existing = this.getWorkflowSession(input.id);
    if (existing) return existing;
    const target = normalizeSessionTarget(input.target);

    const tx = this.db.transaction(() => {
      const hermesSessionId = `hermes-${input.id}`;
      const plannerLaneId = "node-1";
      this.statements.insertSession.run({
        id: input.id,
        project_id: input.projectId,
        hermes_session_id: hermesSessionId,
        planner_lane_id: plannerLaneId,
        title: input.title,
        goal: input.goal,
        mode: input.mode,
        execution_target: target.executionTarget,
        selected_branch: target.selectedBranch,
        base_ref: target.baseRef ?? null,
        created_at: input.now,
        updated_at: input.now,
      });
      this.statements.insertHermesSession.run({
        id: hermesSessionId,
        workflow_session_id: input.id,
        transport: input.transport,
        planner_profile: input.plannerProfile,
        process_id: input.processId ?? null,
        opaque_handle: input.opaqueHandle ?? null,
        status: input.transport === "hermes_replay_recovery" ? "recovered" : "running",
        started_at: input.now,
        last_seen_at: input.now,
        ended_at: null,
        recovery_reason: input.recoveryReason ?? null,
        metadata_json: stableJson({}),
      });
      this.insertEventInTransaction({
        sessionId: input.id,
        kind: "hermes_session_started",
        source: "workflow_store",
        payload: {
          hermesSessionId,
          plannerLaneId,
          transport: input.transport,
          recoveryReason: input.recoveryReason ?? null,
          target,
        },
        idempotencyKey: `session:${input.id}:hermes-started`,
        now: input.now,
      });
      this.statements.insertLane.run({
        id: plannerLaneId,
        session_id: input.id,
        node_id: "node-1",
        semantic_key: "planner:root",
        lane_kind: "planner",
        agent_kind: "hermes",
        title: "Hermes planner",
        brief: input.goal,
        status: "running",
        phase: "Planning",
        archived: 0,
        created_at: input.now,
        updated_at: input.now,
      });
    });
    tx();
    const created = this.getWorkflowSession(input.id);
    if (!created) throw new Error(`Failed to create workflow session ${input.id}.`);
    return created;
  }

  getWorkflowSession(sessionId: string): WorkflowSessionRecord | null {
    const row = this.statements.getSession.get(sessionId) as SessionRow | undefined;
    return row ? mapSession(row) : null;
  }

  resolveCurrentBranchTarget(input: ResolveCurrentBranchTargetInput): WorkflowSessionRecord {
    const session = this.requireKnownSession(input.sessionId);
    const branchName = requireIdentifier(input.branchName, "branchName");
    if (session.target.executionTarget !== "current_branch") {
      throw new Error("Only current branch workflow targets can resolve HEAD.");
    }
    if (session.target.selectedBranch !== "HEAD") {
      if (session.target.selectedBranch !== branchName) {
        throw new Error("Current branch workflow target is already resolved to another branch.");
      }
      return session;
    }

    this.statements.updateCurrentBranchTarget.run({
      id: input.sessionId,
      selected_branch: branchName,
      updated_at: input.now,
    });
    return this.requireKnownSession(input.sessionId);
  }

  listHermesSessions(sessionId: string): HermesSessionRecord[] {
    return (this.statements.listHermesSessions.all(sessionId) as HermesSessionRow[]).map(mapHermesSession);
  }

  appendWorkflowEvent(input: AppendWorkflowEventInput): WorkflowEventRecord {
    const tx = this.db.transaction(() => {
      const existing = input.idempotencyKey ? this.getEventByIdempotencyKey(input.sessionId, input.idempotencyKey) : null;
      if (existing) return existing;
      const event = this.insertEventInTransaction(input);
      this.projectEventInTransaction(event);
      return event;
    });
    return tx();
  }

  appendUserInput(input: AppendUserInput): WorkflowEventRecord {
    return this.appendWorkflowEvent({
      sessionId: input.sessionId,
      kind: "workflow.user_input",
      source: "user",
      idempotencyKey: `user-input:${input.inputId}`,
      payload: { inputId: input.inputId, text: input.text },
      now: input.now,
    });
  }

  recordCanvasNodePosition(input: RecordCanvasNodePositionInput): WorkflowEventRecord {
    const sessionId = requireIdentifier(input.sessionId, "sessionId");
    const updateId = requireIdentifier(input.updateId, "updateId");
    const nodeId = requireIdentifier(input.nodeId, "nodeId");
    const position = requireCanvasPosition(input.position);
    const canvasSession = this.materializeCanvasSession(sessionId);
    if (!canvasSession) throw new Error(`Workflow session is not known: ${sessionId}.`);
    if (!canvasSession.nodes.some((node) => node.id === nodeId)) {
      throw new Error(`Workflow canvas node is not known: ${nodeId}.`);
    }

    const idempotencyKey = `canvas-node-position:${updateId}`;
    const existing = this.getEventByIdempotencyKey(sessionId, idempotencyKey);
    if (existing) {
      const existingPosition = canvasPositionFromPayload(existing.payload);
      if (
        existing.kind !== "canvas_node_position_updated" ||
        existing.payload.nodeId !== nodeId ||
        !existingPosition ||
        existingPosition.x !== position.x ||
        existingPosition.y !== position.y
      ) {
        throw new Error(`Canvas node position updateId was already used with different input: ${updateId}.`);
      }
      return existing;
    }

    return this.appendWorkflowEvent({
      sessionId,
      kind: "canvas_node_position_updated",
      source: "renderer",
      idempotencyKey,
      payload: { nodeId, position },
      now: input.now,
    });
  }

  buildLedgerSummary(sessionId: string, options: WorkflowLedgerOptions = {}): WorkflowLedgerSummary {
    const sanitizer = new LedgerSanitizer(options);
    return sanitizer.build(this.listEvents(sessionId));
  }

  applyWorkflowIntent(intent: unknown, now: string): CompileWorkflowIntentResult {
    const sessionId = workflowIntentSessionId(intent);
    if (!sessionId) throw new Error("WorkflowIntent sessionId is required.");
    const projection = this.materializeFlowProjection(sessionId);
    const parsed = parseWorkflowIntent(stableJson(intent));
    if (!parsed.ok) {
      const rejected = makeRejectedFlowIntentEvent(projection, workflowIntentId(intent), parsed.reason, now);
      const tx = this.db.transaction(() => {
        this.insertFlowEventInTransaction(rejected, now);
      });
      tx();
      return { ok: false, reason: parsed.reason, events: [rejected] };
    }
    const compiled = compileWorkflowIntent(parsed.intent, projection, createDefaultFlowPolicy(), now);
    if (compiled.events.length === 0) return compiled;
    const tx = this.db.transaction(() => {
      for (const event of compiled.events) this.insertFlowEventInTransaction(event, now);
    });
    tx();
    return compiled;
  }

  scheduleReadyLanes(
    sessionId: string,
    input: ScheduleReadyWorkflowLanesInput,
  ): ScheduleReadyWorkflowLanesResult {
    const projection = this.materializeFlowProjection(sessionId);
    const runningScopes = projection.lanes
      .filter((lane) => lane.status === "running")
      .map((lane) => ({ fileScopes: lane.fileScopes, packageScopes: lane.packageScopes }));
    const ready = scheduleFlowReadyLanes(projection, {
      allowedParallelism: input.allowedParallelism ?? 1,
      runningScopes,
    });
    const scheduled = ready.map((lane) => ({
      ...lane,
      runId: runIdForLane(sessionId, lane.id),
      segmentId: segmentIdForLane(sessionId, lane.id),
    }));
    if (scheduled.length === 0) return { readyLanes: [], projection };

    const tx = this.db.transaction(() => {
      for (const lane of scheduled) {
        this.insertFlowEventInTransaction({
          id: `${sessionId}:flow-schedule:${lane.id}`,
          sessionId,
          seq: 0,
          kind: "workflow.segment.started",
          source: "workflow-scheduler",
          payload: {
            laneId: lane.id,
            segment: {
              id: lane.segmentId,
              laneId: lane.id,
              runId: lane.runId,
              status: "running",
              exitCode: null,
            },
          },
          createdAt: input.now,
          idempotencyKey: `schedule:${lane.segmentId}:started`,
        }, input.now);
      }
    });
    tx();

    return {
      readyLanes: scheduled,
      projection: this.materializeFlowProjection(sessionId),
    };
  }

  reassignWorkflowLane(input: WorkflowLaneReassignmentInput): WorkflowLaneReassignmentResult {
    const requestId = requireWorkflowIdentifier(input.requestId, "requestId");
    const sessionId = requireWorkflowIdentifier(input.sessionId, "sessionId");
    const laneId = requireWorkflowIdentifier(input.laneId, "laneId");
    const session = this.requireKnownSession(sessionId);
    const agentKind = requireWorkflowReassignmentAgent(input.agentKind);
    const idempotencyKey = `lane-reassign:${requestId}`;
    const existing = this.getEventByIdempotencyKey(sessionId, idempotencyKey);
    if (existing) {
      if (
        existing.kind !== "workflow.lane.reassigned" ||
        existing.laneId !== laneId ||
        existing.payload.requestId !== requestId ||
        existing.payload.laneId !== laneId ||
        existing.payload.agentKind !== agentKind ||
        !requireOptionalAgent(existing.payload.previousAgentKind)
      ) {
        throw new Error(`Workflow reassignment requestId conflict: ${requestId}.`);
      }
      const currentProjection = this.materializeFlowProjection(sessionId);
      const currentCanvasSession = this.materializeCanvasSession(sessionId);
      if (!currentCanvasSession) throw new Error(`Workflow session is not known: ${sessionId}.`);
      return { event: existing, projection: currentProjection, canvasSession: currentCanvasSession };
    }
    const projection = this.materializeFlowProjection(sessionId);

    if (laneId === session.plannerLaneId || this.getLane(sessionId, laneId)?.laneKind === "planner") {
      throw new Error("Workflow planner root cannot be reassigned.");
    }
    if (projection.userDecisions.some((decision) => decision.decisionId === laneId)) {
      throw new Error("Workflow user decision nodes cannot be reassigned.");
    }
    const lane = projection.lanes.find((item) => item.id === laneId);
    if (!lane) throw new Error(`Unknown workflow lane ${laneId}.`);
    if (lane.rollbackStatus === "rolled_back" || lane.rollbackStatus === "inactive") {
      throw new Error("Rolled back or inactive workflow lanes cannot be reassigned.");
    }
    if (!lane.executable || lane.nodeKind !== "agent_task") {
      throw new Error("Only executable workflow lanes can be reassigned.");
    }
    if (lane.status !== "pending" && lane.status !== "ready") {
      throw new Error(`Workflow lane in ${lane.status} state cannot be reassigned.`);
    }
    if (lane.agentKind === agentKind) throw new Error(`Workflow lane is already assigned to ${agentKind}.`);

    const event = this.appendWorkflowEvent({
      sessionId,
      kind: "workflow.lane.reassigned",
      source: "user",
      laneId,
      idempotencyKey,
      payload: {
        requestId,
        laneId,
        previousAgentKind: lane.agentKind,
        agentKind,
      },
      now: input.now,
    });
    const nextProjection = this.materializeFlowProjection(sessionId);
    const canvasSession = this.materializeCanvasSession(sessionId);
    if (!canvasSession) throw new Error(`Workflow session is not known: ${sessionId}.`);
    return { event, projection: nextProjection, canvasSession };
  }

  recordRunResult(input: RecordRunResultInput): FlowProjection {
    const projection = this.materializeFlowProjection(input.sessionId);
    const lane = projection.lanes.find((item) => item.id === input.laneId) ?? this.getLane(input.sessionId, input.laneId);
    if (!lane || lane.agentKind !== input.agentKind) {
      throw new Error("Run result lane and agent identity mismatch.");
    }
    if (input.evidence.runId !== input.runId) {
      throw new Error("Run result RunEvidence identity mismatch.");
    }
    if (!isTerminalRunEvidence(input.evidence)) {
      throw new Error("Run result requires terminal RunEvidence.");
    }
    const segment = projection.segments.find((item) => item.id === input.segmentId);
    let authoritativeInput = input;
    if (lane.laneKind === "planner") {
      const stored = this.statements.getSegmentByRunId.get(input.runId) as SegmentRow | undefined;
      if (stored) {
        if (
          stored.session_id !== input.sessionId ||
          stored.lane_id !== input.laneId ||
          stored.agent_kind !== input.agentKind ||
          (input.segmentId !== stored.id && input.segmentId !== segmentIdForLane(input.sessionId, input.laneId))
        ) {
          throw new Error("Run result planner segment identity mismatch.");
        }
        authoritativeInput = { ...input, segmentId: stored.id };
      } else if (
        input.segmentId !== segmentIdForLane(input.sessionId, input.laneId) ||
        input.runId !== runIdForLane(input.sessionId, input.laneId) ||
        (segment && (segment.laneId !== input.laneId || segment.runId !== input.runId))
      ) {
        throw new Error("Run result planner segment identity mismatch.");
      }
    } else if (!segment || segment.laneId !== input.laneId || segment.runId !== input.runId) {
      throw new Error("Run result segment identity mismatch.");
    }
    const safeEvidence = sanitizeRunEvidence(input.evidence);
    const outputSummary = sanitizeWorkflowStoredText(input.outputSummary ?? resultSummaryFromEvidence(safeEvidence));
    if (lane?.laneKind === "planner") return this.recordPlannerRunResult(authoritativeInput, safeEvidence, outputSummary);

    if (!segment) throw new Error("Run result segment identity mismatch.");
    if (segment.status !== "running") {
      this.assertExecutableTerminalReplay(input, safeEvidence, outputSummary);
      return projection;
    }

    const status = flowStatusFromRunEvidence(input.evidence);
    const evidenceStatus = status === "succeeded" ? "passed" : input.evidence.status === "cancelled" ? "skipped" : "failed";
    const evidenceId = `evidence-${input.segmentId}`;
    const tx = this.db.transaction(() => {
      const hasTerminalEvent = ["output-summary", "evidence", "finished"].some((suffix) =>
        this.getEventByIdempotencyKey(input.sessionId, `segment:${input.segmentId}:${suffix}`)
      );
      if (hasTerminalEvent) {
        this.assertExecutableTerminalReplay(input, safeEvidence, outputSummary);
        return;
      }
      this.insertFlowEventInTransaction({
        id: `${input.sessionId}:flow-output:${input.segmentId}`,
        sessionId: input.sessionId,
        seq: 0,
        kind: "workflow.segment.output_delta",
        source: input.agentKind,
        payload: {
          laneId: input.laneId,
          segmentId: input.segmentId,
          text: outputSummary,
        },
        createdAt: input.now,
        idempotencyKey: `segment:${input.segmentId}:output-summary`,
      }, input.now);
      this.insertFlowEventInTransaction({
        id: `${input.sessionId}:flow-evidence:${input.segmentId}`,
        sessionId: input.sessionId,
        seq: 0,
        kind: "workflow.evidence.recorded",
        source: input.agentKind,
        payload: {
          laneId: input.laneId,
          segmentId: input.segmentId,
          evidence: {
            id: evidenceId,
            kind: "run-exit",
            status: evidenceStatus,
            changesetId: safeEvidence.changesetId,
            checks: safeEvidence.checks.map((check) => `${check.kind}:${check.name}:${check.status}`),
            artifacts: safeEvidence.artifacts,
            detail: safeEvidence.errorReason ?? safeEvidence.review?.detail ?? null,
            runEvidence: safeEvidence,
          },
        },
        createdAt: input.now,
        idempotencyKey: `segment:${input.segmentId}:evidence`,
      }, input.now);
      this.insertFlowEventInTransaction({
        id: `${input.sessionId}:flow-finished:${input.segmentId}`,
        sessionId: input.sessionId,
        seq: 0,
        kind: "workflow.segment.finished",
        source: input.agentKind,
        payload: {
          laneId: input.laneId,
          segmentId: input.segmentId,
          status,
          exitCode: safeEvidence.exitCode,
          errorReason: safeEvidence.errorReason ?? safeEvidence.cancelReason ?? null,
        },
        createdAt: input.now,
        idempotencyKey: `segment:${input.segmentId}:finished`,
      }, input.now);
    });
    tx.immediate();
    return this.materializeFlowProjection(input.sessionId);
  }

  recordRunCheckpoint(input: RecordRunCheckpointInput): WorkflowNodeCheckpoint {
    const session = this.requireKnownSession(input.sessionId);
    if (session.target.executionTarget !== input.executionTarget) {
      throw new Error("Run checkpoint execution target identity mismatch.");
    }
    const canvasSession = this.materializeCanvasSession(input.sessionId);
    const canvasNode = canvasSession?.nodes.find((node) => node.id === input.nodeId);
    const canonicalWorktreePath = canonicalPath(input.worktreePath);
    if (input.executionTarget === "current_branch") {
      if (input.worktreeId) throw new Error("Current branch checkpoint must not include a worktree id.");
      if (canonicalWorktreePath !== this.projectRoot) {
        throw new Error("Current branch checkpoint path must match the project root.");
      }
      if (input.branchName !== session.target.selectedBranch) {
        throw new Error("Current branch checkpoint branch must match the session selected branch.");
      }
    } else {
      if (!input.worktreeId) throw new Error("New worktree checkpoint requires a worktree id.");
      const managedWorktree = canvasNode?.worktree;
      const managedPath = managedWorktree?.realPath ?? managedWorktree?.path;
      if (
        managedWorktree?.worktreeId !== input.worktreeId ||
        !managedPath ||
        canonicalPath(managedPath) !== canonicalWorktreePath ||
        managedWorktree.branchName !== input.branchName
      ) {
        throw new Error("Run checkpoint must match the managed worktree identity.");
      }
    }
    const projection = this.materializeFlowProjection(input.sessionId);
    const lane = projection.lanes.find((item) => item.id === input.laneId);
    const projectedNode = projection.projectionNodes.find((node) => node.id === input.nodeId && node.laneId === input.laneId);
    if (!lane || !projectedNode?.executable) {
      throw new Error("Run checkpoint requires matching executable lane and node identity.");
    }
    const segment = projection.segments.find((item) => item.id === input.segmentId);
    if (!segment || segment.laneId !== input.laneId || segment.runId !== input.runId) {
      throw new Error("Run checkpoint segment identity mismatch.");
    }
    if (input.phase === "before" && segment.status !== "running") {
      throw new Error("Before run checkpoint requires a running scheduled segment.");
    }
    if (input.phase === "after" && segment.status === "running") {
      throw new Error("After run checkpoint requires terminal RunEvidence.");
    }
    if (input.phase === "after") {
      const before = projection.checkpoints.find((item) =>
        item.phase === "before" &&
        item.sessionId === input.sessionId &&
        item.laneId === input.laneId &&
        item.segmentId === input.segmentId &&
        item.runId === input.runId
      );
      if (!before) throw new Error("After run checkpoint requires the matching before checkpoint.");
      if (
        before.executionTarget !== input.executionTarget ||
        before.worktreeId !== input.worktreeId ||
        !before.worktreePath ||
        canonicalPath(before.worktreePath) !== canonicalWorktreePath ||
        before.branchName !== input.branchName
      ) {
        throw new Error("After run checkpoint must match before checkpoint worktree identity.");
      }
    }
    if (!/^[0-9a-f]{40}$/i.test(input.headCommit)) throw new Error("Run checkpoint requires a full commit SHA.");
    if (!input.worktreePath || !input.branchName) throw new Error("Run checkpoint requires worktree and branch identity.");
    if (!input.evidenceRefs.some((ref) => ref.kind === "run" && ref.id === input.runId)) {
      throw new Error("Run checkpoint requires matching run evidence.");
    }
    if (input.worktreeState === "dirty" && !input.evidenceRefs.some((ref) => ref.kind === "changeset")) {
      throw new Error("Dirty run checkpoint requires changeset evidence.");
    }
    const id = `checkpoint:${input.runId}:${input.phase}`;
    const checkpoint: WorkflowNodeCheckpoint = {
      id,
      sessionId: input.sessionId,
      nodeId: input.nodeId,
      laneId: input.laneId,
      runId: input.runId,
      segmentId: input.segmentId,
      phase: input.phase,
      executionTarget: input.executionTarget,
      ...(input.worktreeId ? { worktreeId: input.worktreeId } : {}),
      worktreePath: canonicalWorktreePath,
      branchName: input.branchName,
      headCommit: input.headCommit.toLowerCase(),
      worktreeState: input.worktreeState,
      createdAt: input.now,
      source: "backend",
      evidenceRefs: input.evidenceRefs,
    };
    const idempotencyKey = `checkpoint:${input.runId}:${input.phase}`;
    const existing = this.getEventByIdempotencyKey(input.sessionId, idempotencyKey);
    if (existing) {
      const existingCheckpoint = isRecord(existing.payload.checkpoint) ? existing.payload.checkpoint : null;
      const comparableCheckpoint = existingCheckpoint && typeof existingCheckpoint.createdAt === "string"
        ? { ...checkpoint, createdAt: existingCheckpoint.createdAt }
        : checkpoint;
      if (stableJson(existingCheckpoint) !== stableJson(comparableCheckpoint)) {
        throw new Error("Run checkpoint identity mismatch for existing run phase.");
      }
      return existingCheckpoint as unknown as WorkflowNodeCheckpoint;
    }
    this.appendWorkflowEvent({
      sessionId: input.sessionId,
      kind: "workflow.node.checkpoint_recorded",
      source: "backend",
      laneId: input.laneId,
      segmentId: input.segmentId,
      idempotencyKey,
      payload: { checkpoint },
      now: input.now,
    });
    return checkpoint;
  }

  private recordPlannerRunResult(
    input: RecordRunResultInput,
    safeEvidence: RunEvidence,
    outputSummary: string,
  ): FlowProjection {
    const status = flowStatusFromRunEvidence(safeEvidence);
    const laneStatus: WorkflowLaneStatus = status === "succeeded" && hasConcreteRunEvidence(safeEvidence)
      ? "completed"
      : "failed";
    const tx = this.db.transaction(() => {
      const existing = this.statements.getSegment.get(input.sessionId, input.segmentId) as SegmentRow | undefined;
      if (existing && existing.status !== "running") {
        assertPlannerTerminalEvidenceReplay(existing, safeEvidence);
        return;
      }
      this.ensureSegmentInTransaction({
        sessionId: input.sessionId,
        laneId: input.laneId,
        segmentId: input.segmentId,
        runId: input.runId,
        agentKind: input.agentKind,
        transport: "agent-bridge",
        worktreePath: ".",
        now: input.now,
      });
      this.insertEventInTransaction({
        sessionId: input.sessionId,
        kind: "segment_output_delta",
        source: input.agentKind,
        laneId: input.laneId,
        segmentId: input.segmentId,
        idempotencyKey: `planner-segment:${input.segmentId}:output-summary`,
        payload: { text: outputSummary },
        now: input.now,
      });
      const evidenceEvent = this.insertEventInTransaction({
        sessionId: input.sessionId,
        kind: "segment_evidence",
        source: input.agentKind,
        laneId: input.laneId,
        segmentId: input.segmentId,
        idempotencyKey: `planner-segment:${input.segmentId}:evidence`,
        payload: { evidence: safeEvidence },
        now: input.now,
      });
      this.statements.updateSegmentEvidence.run({
        id: input.segmentId,
        evidence_json: stableJson(safeEvidence),
        exit_code: safeEvidence.exitCode ?? null,
        error_reason: safeEvidence.errorReason ?? safeEvidence.cancelReason ?? null,
      });
      this.insertEventInTransaction({
        sessionId: input.sessionId,
        kind: "segment_finished",
        source: input.agentKind,
        laneId: input.laneId,
        segmentId: input.segmentId,
        causationId: evidenceEvent.id,
        idempotencyKey: `planner-segment:${input.segmentId}:finished`,
        payload: {
          status,
          exitCode: safeEvidence.exitCode,
          errorReason: safeEvidence.errorReason ?? safeEvidence.cancelReason ?? null,
        },
        now: input.now,
      });
      this.statements.finishSegment.run({
        id: input.segmentId,
        status,
        ended_at: input.now,
        exit_code: safeEvidence.exitCode ?? null,
        error_reason: safeEvidence.errorReason ?? safeEvidence.cancelReason ?? null,
      });
      this.setLaneStatus(input.sessionId, input.laneId, laneStatus, input.now);
      this.insertEventInTransaction({
        sessionId: input.sessionId,
        kind: "lane_status_changed",
        source: "workflow_store",
        laneId: input.laneId,
        segmentId: input.segmentId,
        causationId: evidenceEvent.id,
        idempotencyKey: `planner-segment:${input.segmentId}:lane-terminal`,
        payload: { status: laneStatus, reason: "planner run evidence" },
        now: input.now,
      });
    });
    tx();
    return this.materializeFlowProjection(input.sessionId);
  }

  private assertExecutableTerminalReplay(
    input: RecordRunResultInput,
    evidence: RunEvidence,
    outputSummary: string,
  ): void {
    const output = this.getEventByIdempotencyKey(input.sessionId, `segment:${input.segmentId}:output-summary`);
    const expectedOutput = {
      laneId: input.laneId,
      segmentId: input.segmentId,
      text: outputSummary,
    };
    if (
      output?.kind !== "workflow.segment.output_delta" ||
      output.source !== input.agentKind ||
      stableJson(output.payload) !== stableJson(expectedOutput)
    ) {
      throw new Error("Executable terminal output conflict for existing run.");
    }

    const status = flowStatusFromRunEvidence(evidence);
    const evidenceStatus = status === "succeeded" ? "passed" : evidence.status === "cancelled" ? "skipped" : "failed";
    const evidenceEvent = this.getEventByIdempotencyKey(input.sessionId, `segment:${input.segmentId}:evidence`);
    const expectedEvidence = {
      laneId: input.laneId,
      segmentId: input.segmentId,
      evidence: {
        id: `evidence-${input.segmentId}`,
        kind: "run-exit",
        status: evidenceStatus,
        changesetId: evidence.changesetId,
        checks: evidence.checks.map((check) => `${check.kind}:${check.name}:${check.status}`),
        artifacts: evidence.artifacts,
        detail: evidence.errorReason ?? evidence.review?.detail ?? null,
        runEvidence: evidence,
      },
    };
    const finished = this.getEventByIdempotencyKey(input.sessionId, `segment:${input.segmentId}:finished`);
    const expectedFinished = {
      laneId: input.laneId,
      segmentId: input.segmentId,
      status,
      exitCode: evidence.exitCode,
      errorReason: evidence.errorReason ?? evidence.cancelReason ?? null,
    };
    if (
      evidenceEvent?.kind !== "workflow.evidence.recorded" ||
      evidenceEvent.source !== input.agentKind ||
      stableJson(evidenceEvent.payload) !== stableJson(expectedEvidence) ||
      finished?.kind !== "workflow.segment.finished" ||
      finished.source !== input.agentKind ||
      stableJson(finished.payload) !== stableJson(expectedFinished)
    ) {
      throw new Error("Executable terminal evidence conflict for existing run.");
    }
  }

  materializeFlowProjection(sessionId: string): FlowProjection {
    const flowEvents = this.listEvents(sessionId)
      .filter((event) => isFlowEventKind(event.kind))
      .map(mapWorkflowRecordToFlowEvent);
    return reduceWorkflowEvents([seedFlowUserInputEvent(sessionId), ...flowEvents]);
  }

  getLoopEngineeringState(
    sessionId: string,
    input: WorkflowLoopEngineeringProjectionInput = {},
  ): WorkflowLoopEngineeringState {
    this.requireKnownSession(sessionId);
    return projectLoopEngineeringState(this.materializeFlowProjection(sessionId), input);
  }

  listEvents(sessionId: string): WorkflowEventRecord[] {
    return (this.statements.listEvents.all(sessionId) as EventRow[]).map(mapEvent);
  }

  listNodeCheckpoints(input: WorkflowNodeCheckpointQuery): WorkflowNodeCheckpoint[] {
    this.requireKnownSession(input.sessionId);
    const projection = this.materializeFlowProjection(input.sessionId);
    return projection.checkpoints.filter((checkpoint) => {
      if (input.nodeId && checkpoint.nodeId !== input.nodeId) return false;
      if (input.laneId && checkpoint.laneId !== input.laneId) return false;
      if (input.runId && checkpoint.runId !== input.runId) return false;
      if (input.phase && checkpoint.phase !== input.phase) return false;
      return true;
    });
  }

  getNodeRollbackEligibility(input: WorkflowNodeRollbackEligibilityInput): WorkflowRollbackEligibility {
    this.requireKnownSession(input.sessionId);
    const projection = this.materializeFlowProjection(input.sessionId);
    const targetLaneId = rollbackTargetLaneId(projection, input);
    if (!targetLaneId) {
      return {
        eligible: false,
        targetLaneId: input.laneId ?? input.nodeId ?? "",
        affectedLaneIds: [],
        downstreamInactiveLaneIds: [],
        blockingRemoteSideEffects: [],
        ...(typeof input.localRollbackSafe === "boolean" ? { localRollbackSafe: input.localRollbackSafe } : {}),
        localSafetyStatus: rollbackLocalSafetyStatus(input.localRollbackSafe),
        ...(input.localRollbackSafe === false ? { manualRepairReason: "Local rollback is not safe." } : {}),
        reason: "Rollback target lane does not exist.",
      };
    }
    return evaluateRollbackEligibility(projection, targetLaneId, {
      ...(input.checkpointId ? { checkpointId: input.checkpointId } : {}),
      ...(input.nodeId ? { targetNodeId: input.nodeId } : {}),
      ...(typeof input.localRollbackSafe === "boolean" ? { localRollbackSafe: input.localRollbackSafe } : {}),
    });
  }

  applyNodeRollback(input: WorkflowNodeRollbackInput): WorkflowNodeRollbackResult {
    this.requireKnownSession(input.sessionId);
    const eligibility = this.getNodeRollbackEligibility(input);
    const manualRepairRequired = input.manualRepairRequired === true || eligibility.localRollbackSafe === false;
    const blockedEligibility = input.manualRepairRequired === true
      ? rollbackEligibilityWithManualRepair(eligibility, "Local rollback requires manual repair.")
      : eligibility;
    if (!blockedEligibility.eligible || manualRepairRequired) {
      const projection = this.materializeFlowProjection(input.sessionId);
      return {
        status: "blocked",
        eligibility: blockedEligibility,
        blockedReason: rollbackBlockReason(blockedEligibility, manualRepairRequired),
        ...(manualRepairRequired ? { manualRepairRequired: true } : {}),
        projection,
      };
    }

    const requestId = input.requestId ?? rollbackRequestId(input, eligibility);
    const now = input.now;
    const tx = this.db.transaction(() => {
      const requestedEvent = this.insertEventInTransaction({
        sessionId: input.sessionId,
        kind: "workflow.node.rollback_requested",
        source: "workflow-store",
        laneId: eligibility.targetLaneId,
        idempotencyKey: `rollback:${requestId}:requested`,
        payload: rollbackEventPayload(input, eligibility, requestId),
        now,
      });
      const event = this.insertEventInTransaction({
        sessionId: input.sessionId,
        kind: "workflow.node.rollback_applied",
        source: "workflow-store",
        laneId: eligibility.targetLaneId,
        idempotencyKey: `rollback:${requestId}:applied`,
        payload: {
          ...rollbackEventPayload(input, eligibility, requestId),
          reason: "Rollback applied.",
        },
        now,
      });
      return { requestedEvent, event };
    });
    const { requestedEvent, event } = tx();
    return {
      status: "applied",
      event,
      requestedEvent,
      eligibility,
      projection: this.materializeFlowProjection(input.sessionId),
    };
  }

  requestNodeRepair(input: WorkflowCheckpointSuccessorRequest): WorkflowCheckpointSuccessorResult {
    return this.requestCheckpointSuccessor("repair", input);
  }

  requestNodeVariant(input: WorkflowCheckpointSuccessorRequest): WorkflowCheckpointSuccessorResult {
    return this.requestCheckpointSuccessor("variant", input);
  }

  listLanes(sessionId: string): WorkflowLaneRecord[] {
    return (this.statements.listLanes.all(sessionId) as LaneRow[]).map(mapLane);
  }

  getLane(sessionId: string, laneId: string): WorkflowLaneRecord | null {
    const row = this.statements.getLane.get(sessionId, laneId) as LaneRow | undefined;
    return row ? mapLane(row) : null;
  }

  claimPlannerRunStart(input: ClaimPlannerRunStartInput): ClaimPlannerRunStartResult {
    const session = this.requireKnownSession(input.sessionId);
    const lane = this.getLane(input.sessionId, input.laneId);
    if (
      !lane ||
      lane.id !== session.plannerLaneId ||
      lane.laneKind !== "planner" ||
      lane.agentKind !== "hermes" ||
      input.agentKind !== "hermes" ||
      lane.archived
    ) {
      throw new Error("Planner run start identity mismatch.");
    }
    const segmentId = plannerSegmentIdForRun(input.runId);
    const tx = this.db.transaction(() => {
      const existing = this.statements.getSegmentByRunId.get(input.runId) as SegmentRow | undefined;
      if (existing) {
        if (
          existing.id !== segmentId ||
          existing.session_id !== input.sessionId ||
          existing.lane_id !== input.laneId ||
          existing.agent_kind !== input.agentKind
        ) {
          throw new Error("Planner run start identity mismatch for existing run.");
        }
        if (existing.status !== "running") throw new Error(`Planner run ${input.runId} is already terminal.`);
        return false;
      }
      this.ensureSegmentInTransaction({
        ...input,
        segmentId,
        transport: "agent-bridge",
      });
      this.setLaneStatus(input.sessionId, input.laneId, "running", input.now);
      this.insertEventInTransaction({
        sessionId: input.sessionId,
        kind: "lane_status_changed",
        source: "workflow_store",
        laneId: input.laneId,
        segmentId,
        idempotencyKey: `planner-run:${input.runId}:lane-running`,
        payload: { status: "running", reason: "planner turn started", runId: input.runId },
        now: input.now,
      });
      return true;
    });
    const created = tx.immediate();
    const segment: RunningWorkflowSegment = {
      sessionId: input.sessionId,
      laneId: input.laneId,
      segmentId,
      runId: input.runId,
      agentKind: input.agentKind,
      status: "running",
    };
    return { segment, created };
  }

  listSegments(sessionId: string, laneId: string): WorkflowSegmentRecord[] {
    return (this.statements.listSegments.all(sessionId, laneId) as SegmentRow[]).map(mapSegment);
  }

  listRunningSegments(): RunningWorkflowSegment[] {
    const plannerSegments = (this.statements.listRunningPlannerSegments.all() as SegmentRow[]).map((segment) => ({
      sessionId: segment.session_id,
      laneId: segment.lane_id,
      segmentId: segment.id,
      runId: segment.run_id,
      agentKind: segment.agent_kind,
      status: "running" as const,
    }));
    const sessions = this.statements.listWorkflowSessionIds.all() as Array<{ id: string }>;
    const flowSegments = sessions.flatMap(({ id: sessionId }) => {
      const projection = this.materializeFlowProjection(sessionId);
      return projection.segments
        .filter((segment) => segment.status === "running")
        .flatMap((segment) => {
          const lane = projection.lanes.find((item) => item.id === segment.laneId);
          return lane ? [{
            sessionId,
            laneId: segment.laneId,
            segmentId: segment.id,
            runId: segment.runId,
            agentKind: lane.agentKind,
            status: "running" as const,
          }] : [];
        });
    });
    return [...plannerSegments, ...flowSegments];
  }

  listPendingRunCheckpointEnrichments(): RunCheckpointEnrichmentCandidate[] {
    const sessions = this.statements.listWorkflowSessionIds.all() as Array<{ id: string }>;
    return sessions.flatMap(({ id: sessionId }) => {
      const projection = this.materializeFlowProjection(sessionId);
      return projection.segments.flatMap((segment) => {
        if (segment.status === "running") return [];
        const lane = projection.lanes.find((item) => item.id === segment.laneId);
        if (!lane || lane.executable === false) return [];
        const checkpoints = projection.checkpoints.filter((checkpoint) =>
          checkpoint.sessionId === sessionId &&
          checkpoint.laneId === segment.laneId &&
          checkpoint.segmentId === segment.id &&
          checkpoint.runId === segment.runId
        );
        if (!checkpoints.some((checkpoint) => checkpoint.phase === "before") || checkpoints.some((checkpoint) => checkpoint.phase === "after")) {
          return [];
        }
        return [{
          sessionId,
          laneId: segment.laneId,
          segmentId: segment.id,
          runId: segment.runId,
          agentKind: lane.agentKind,
        }];
      });
    });
  }

  applyWorkflowCardToolCall(
    sessionId: string,
    call: WorkflowCardToolCall,
    context: WorkflowCardToolContext,
  ): WorkflowCardToolResult {
    if (call.tool !== "createWorkflowCard") {
      return this.patchOrArchiveWorkflowCard(sessionId, call, context);
    }
    return this.createWorkflowCard(sessionId, call, context);
  }

  recordManualEvidence(input: ManualEvidenceInput): WorkflowEventRecord {
    const tx = this.db.transaction(() => {
      const existing = this.getEventByIdempotencyKey(input.sessionId, input.idempotencyKey);
      if (existing) return existing;
      const event = this.insertEventInTransaction({
        sessionId: input.sessionId,
        kind: "segment_evidence",
        source: "human",
        laneId: input.laneId,
        idempotencyKey: input.idempotencyKey,
        payload: {
          evidence: {
            manualApproval: true,
            checks: [{ kind: "review", name: "Manual confirmation", status: "passed", detail: input.summary }],
          },
        },
        now: input.now,
      });
      this.setLaneStatus(input.sessionId, input.laneId, "completed", input.now);
      this.insertEventInTransaction({
        sessionId: input.sessionId,
        kind: "lane_status_changed",
        source: "workflow_store",
        laneId: input.laneId,
        causationId: event.id,
        payload: { status: "completed", reason: "manual evidence" },
        now: input.now,
      });
      return event;
    });
    return tx();
  }

  recordSegmentEvidence(input: SegmentEvidenceInput): void {
    const tx = this.db.transaction(() => {
      this.ensureSegmentInTransaction(input);
      const evidenceEvent = this.insertEventInTransaction({
        sessionId: input.sessionId,
        kind: "segment_evidence",
        source: input.agentKind,
        laneId: input.laneId,
        segmentId: input.segmentId,
        idempotencyKey: `segment:${input.segmentId}:evidence`,
        payload: { evidence: input.evidence },
        now: input.now,
      });
      this.statements.updateSegmentEvidence.run({
        id: input.segmentId,
        evidence_json: stableJson(input.evidence),
        exit_code: input.evidence.exitCode ?? null,
        error_reason: input.evidence.errorReason ?? null,
      });
      this.insertEventInTransaction({
        sessionId: input.sessionId,
        kind: "segment_finished",
        source: input.agentKind,
        laneId: input.laneId,
        segmentId: input.segmentId,
        causationId: evidenceEvent.id,
        idempotencyKey: `segment:${input.segmentId}:finished`,
        payload: { status: input.evidence.exitCode === 0 ? "succeeded" : "failed", exitCode: input.evidence.exitCode ?? null },
        now: input.now,
      });
      this.statements.finishSegment.run({
        id: input.segmentId,
        status: input.evidence.exitCode === 0 ? "succeeded" : "failed",
        ended_at: input.now,
        exit_code: input.evidence.exitCode ?? null,
        error_reason: input.evidence.errorReason ?? null,
      });
      if (hasConcreteEvidence(input.evidence)) {
        this.setLaneStatus(input.sessionId, input.laneId, "completed", input.now);
        this.insertEventInTransaction({
          sessionId: input.sessionId,
          kind: "lane_status_changed",
          source: "workflow_store",
          laneId: input.laneId,
          causationId: evidenceEvent.id,
          payload: { status: "completed", reason: "segment evidence" },
          now: input.now,
        });
      }
    });
    tx();
  }

  finishSegment(input: FinishSegmentInput): void {
    const tx = this.db.transaction(() => {
      this.ensureSegmentInTransaction(input);
      const event = this.insertEventInTransaction({
        sessionId: input.sessionId,
        kind: "segment_finished",
        source: input.agentKind,
        laneId: input.laneId,
        segmentId: input.segmentId,
        idempotencyKey: `segment:${input.segmentId}:finished`,
        payload: { status: input.status, exitCode: input.exitCode, errorReason: input.errorReason ?? null },
        now: input.now,
      });
      this.statements.finishSegment.run({
        id: input.segmentId,
        status: input.status,
        ended_at: input.now,
        exit_code: input.exitCode,
        error_reason: input.errorReason ?? null,
      });
      if (input.status === "failed" || input.status === "timed-out" || input.status === "cancelled") {
        this.setLaneStatus(input.sessionId, input.laneId, "failed", input.now);
        this.insertEventInTransaction({
          sessionId: input.sessionId,
          kind: "lane_status_changed",
          source: "workflow_store",
          laneId: input.laneId,
          causationId: event.id,
          payload: { status: "failed", reason: input.status },
          now: input.now,
        });
      }
    });
    tx();
  }

  requestContinuation(input: ContinuationInput): void {
    const tx = this.db.transaction(() => {
      const continuation = this.insertEventInTransaction({
        sessionId: input.sessionId,
        kind: "continuation_requested",
        source: "workflow_store",
        laneId: input.laneId,
        idempotencyKey: `segment:${input.segmentId}:continuation`,
        payload: { runId: input.runId },
        now: input.now,
      });
      this.ensureSegmentInTransaction(input, continuation.id);
      this.setLaneStatus(input.sessionId, input.laneId, "retrying", input.now);
      this.insertEventInTransaction({
        sessionId: input.sessionId,
        kind: "lane_status_changed",
        source: "workflow_store",
        laneId: input.laneId,
        causationId: continuation.id,
        payload: { status: "retrying", reason: "continuation requested" },
        now: input.now,
      });
    });
    tx();
  }

  materializeCanvasSession(sessionId: string): CanvasSession | null {
    const session = this.getWorkflowSession(sessionId);
    if (!session) return null;
    const flowProjection = this.materializeFlowProjection(sessionId);
    if (flowProjection.lanes.length > 0 || flowProjection.userDecisions.length > 0) {
      return this.applyPersistedCanvasNodePositions(
        sessionId,
        this.materializeFlowCanvasSession(session, flowProjection),
      );
    }
    const lanes = this.listLanes(sessionId).filter((lane) => !lane.archived);
    const edges = (this.statements.listEdges.all(sessionId) as EdgeRow[]).map((row) => ({
      id: row.id,
      source: row.source_lane_id,
      target: row.target_lane_id,
    }));
    const worktreesByLaneId = worktreesByParentLaneId(flowProjection.worktrees);
    const nodes = lanes.map((lane, index) =>
      this.materializeNode(session, lane, index, worktreesByLaneId.get(lane.id) ?? worktreesByLaneId.get(lane.nodeId)),
    );
    return this.applyPersistedCanvasNodePositions(sessionId, {
      id: session.id,
      projectId: session.projectId,
      title: session.title,
      goal: session.goal,
      mode: session.mode,
      kind: "canvas",
      target: session.target,
      hermesPlannerSessionId: session.hermesSessionId,
      plannerNodeId: session.plannerLaneId,
      createdAt: session.createdAt,
      updatedAt: session.updatedAt,
      nodes,
      edges,
      activeNodeId: nodes.find((node) => node.status === "running" || node.status === "retrying")?.id ?? null,
    });
  }

  private applyPersistedCanvasNodePositions(sessionId: string, canvasSession: CanvasSession): CanvasSession {
    const positions = latestCanvasNodePositions(this.listEvents(sessionId));
    if (positions.size === 0) return canvasSession;
    return {
      ...canvasSession,
      nodes: canvasSession.nodes.map((node) => {
        const position = positions.get(node.id);
        return position ? { ...node, position } : node;
      }),
    };
  }

  private materializeFlowCanvasSession(session: WorkflowSessionRecord, projection: FlowProjection): CanvasSession {
    const plannerLane = this.getLane(session.id, session.plannerLaneId);
    const plannerNode = plannerLane
      ? this.materializeNode(session, plannerLane, 0)
      : flowPlannerNode(session);
    const dependenciesByLaneId = dependenciesFromFlowProjection(projection);
    const changesetsByLaneId = changesetsFromFlowEvents(this.listEvents(session.id));
    const flowNodes = projection.lanes.map((lane, index) =>
      flowLaneToCanvasNode(session, projection, lane, index + 1, dependenciesByLaneId.get(lane.id) ?? [], changesetsByLaneId.get(lane.id)),
    );
    const decisionNodes = projection.userDecisions.map((decision, index) =>
      flowDecisionToCanvasNode(session, decision, projection.lanes.length + index + 1),
    );
    const nodes = [plannerNode, ...flowNodes, ...decisionNodes];
    return {
      id: session.id,
      projectId: session.projectId,
      title: session.title,
      goal: session.goal,
      mode: session.mode,
      kind: "canvas",
      target: session.target,
      hermesPlannerSessionId: session.hermesSessionId,
      plannerNodeId: session.plannerLaneId,
      createdAt: session.createdAt,
      updatedAt: session.updatedAt,
      nodes,
      edges: projection.edges.map((edge) => ({
        id: edge.id,
        source: edge.sourceLaneId,
        target: edge.targetLaneId,
      })),
      activeNodeId: nodes.find((node) => node.status === "running" || node.status === "retrying")?.id ?? plannerNode.id,
    };
  }

  private requestCheckpointSuccessor(
    kind: "repair" | "variant",
    input: WorkflowCheckpointSuccessorRequest,
  ): WorkflowCheckpointSuccessorResult {
    this.requireKnownSession(input.sessionId);

    const tx = this.db.transaction(() => {
      const currentProjection = this.materializeFlowProjection(input.sessionId);
      const currentPrepared = prepareCheckpointSuccessorRequest(kind, input, currentProjection);
      const existing = this.checkpointSuccessorIdempotentResult(
        kind,
        input,
        currentPrepared.intentId,
        currentPrepared.successorLaneId,
        currentPrepared.successorSemanticKey,
      );
      if (existing) return { kind: "existing" as const, existing };
      const existingForFailedEvidence = kind === "repair" && currentPrepared.failedEvidence
        ? this.checkpointRepairFailedEvidenceResult(input.sessionId, currentPrepared.failedEvidence.id)
        : null;
      if (existingForFailedEvidence) return { kind: "existing" as const, existing: existingForFailedEvidence };
      this.assertCheckpointSuccessorIdentityAvailable(kind, currentPrepared);
      const lanePayload = successorLanePayload(
        kind,
        currentPrepared.lane,
        currentPrepared.checkpoint,
        currentPrepared.successorLaneId,
        currentPrepared.successorSemanticKey,
        currentPrepared.sourceEvidenceIds,
        currentPrepared.failedEvidence,
        currentPrepared.failedEvidenceFallbackReason,
        input.instruction,
        input.title,
      );
      const regressionPayload = kind === "repair" && currentPrepared.failedEvidence
        ? repairRegressionLanePayload(currentPrepared, input.instruction)
        : null;
      if (regressionPayload) this.assertRepairRegressionIdentityAvailable(currentPrepared, regressionPayload);
      const laneEvent = this.insertEventInTransaction({
        sessionId: input.sessionId,
        kind: "workflow.lane.declared",
        source: "workflow-store",
        laneId: currentPrepared.successorLaneId,
        idempotencyKey: `checkpoint-successor:${currentPrepared.intentId}:lane`,
        payload: { lane: lanePayload },
        now: input.now,
      });
      const edgeEvents = currentPrepared.edgeSources.map((sourceLaneId) =>
        this.insertEventInTransaction({
          sessionId: input.sessionId,
          kind: "workflow.edge.declared",
          source: "workflow-store",
          idempotencyKey: `checkpoint-successor:${currentPrepared.intentId}:edge:${sourceLaneId}:${currentPrepared.successorLaneId}`,
          payload: {
            edge: {
              id: `edge-${sourceLaneId}-${currentPrepared.successorLaneId}`,
              sourceLaneId,
              targetLaneId: currentPrepared.successorLaneId,
            },
          },
          now: input.now,
        })
      );
      const regressionLaneEvent = regressionPayload
        ? this.insertEventInTransaction({
            sessionId: input.sessionId,
            kind: "workflow.lane.declared",
            source: "workflow-store",
            laneId: regressionPayload.laneId,
            idempotencyKey: `checkpoint-successor:${currentPrepared.intentId}:regression-lane:${regressionPayload.failedEvidenceId}`,
            payload: { lane: regressionPayload.lane },
            now: input.now,
          })
        : null;
      if (regressionPayload && !regressionLaneEvent) {
        throw new Error("repair regression lane could not be recorded.");
      }
      if (regressionPayload) {
        edgeEvents.push(this.insertEventInTransaction({
          sessionId: input.sessionId,
          kind: "workflow.edge.declared",
          source: "workflow-store",
          idempotencyKey: `checkpoint-successor:${currentPrepared.intentId}:edge:${currentPrepared.successorLaneId}:${regressionPayload.laneId}`,
          payload: {
            edge: {
              id: `edge-${currentPrepared.successorLaneId}-${regressionPayload.laneId}`,
              sourceLaneId: currentPrepared.successorLaneId,
              targetLaneId: regressionPayload.laneId,
            },
          },
          now: input.now,
        }));
      }
      const event = this.insertEventInTransaction({
        sessionId: input.sessionId,
        kind: kind === "repair" ? "workflow.node.repair_requested" : "workflow.node.variant_requested",
        source: "workflow-store",
        laneId: currentPrepared.targetLaneId,
        idempotencyKey: `checkpoint-successor:${currentPrepared.intentId}:intent`,
        payload: {
          intentId: currentPrepared.intentId,
          laneId: currentPrepared.targetLaneId,
          nodeId: currentPrepared.checkpoint.nodeId,
          checkpointId: input.checkpointId,
          sourceLaneId: currentPrepared.targetLaneId,
          sourceNodeId: currentPrepared.checkpoint.nodeId,
          sourceCheckpointId: input.checkpointId,
          checkpointPhase: currentPrepared.checkpoint.phase,
          ...(currentPrepared.checkpoint.runId ? { sourceRunId: currentPrepared.checkpoint.runId } : {}),
          ...(currentPrepared.checkpoint.segmentId ? { sourceSegmentId: currentPrepared.checkpoint.segmentId } : {}),
          ...(currentPrepared.failedEvidence?.segmentId ? { failedSegmentId: currentPrepared.failedEvidence.segmentId } : {}),
          ...(currentPrepared.failedEvidence?.id ? { failedEvidenceId: currentPrepared.failedEvidence.id } : {}),
          ...(currentPrepared.failedEvidence?.kind ? { failedEvidenceKind: currentPrepared.failedEvidence.kind } : {}),
          ...(currentPrepared.failedEvidence?.detail ? { failedEvidenceDetail: currentPrepared.failedEvidence.detail } : {}),
          ...(currentPrepared.sourceEvidenceIds.length > 0 ? { sourceEvidenceIds: currentPrepared.sourceEvidenceIds } : {}),
          ...(currentPrepared.failedRunId ? { failedRunId: currentPrepared.failedRunId } : {}),
          ...(currentPrepared.failedEvidenceFallbackReason ? { failedEvidenceFallbackReason: currentPrepared.failedEvidenceFallbackReason } : {}),
          successorLaneId: currentPrepared.successorLaneId,
          successorSemanticKey: currentPrepared.successorSemanticKey,
          ...(regressionPayload
            ? {
                regressionLaneId: regressionPayload.laneId,
                regressionSemanticKey: regressionPayload.semanticKey,
              }
            : {}),
          ...(input.instruction ? { instruction: input.instruction } : {}),
        },
        now: input.now,
      });
      return {
        kind: "created" as const,
        laneEvent,
        edgeEvents,
        event,
      };
    });
    const result = tx();
    if (result.kind === "existing") return result.existing;
    const { laneEvent, edgeEvents, event } = result;
    return {
      status: "requested",
      event,
      laneEvent,
      edgeEvents,
      projection: this.materializeFlowProjection(input.sessionId),
    };
  }

  private checkpointSuccessorIdempotentResult(
    kind: "repair" | "variant",
    input: WorkflowCheckpointSuccessorRequest,
    intentId: string,
    successorLaneId: string,
    successorSemanticKey: string,
  ): WorkflowCheckpointSuccessorResult | null {
    const existing = this.getEventByIdempotencyKey(input.sessionId, `checkpoint-successor:${intentId}:intent`);
    if (!existing) return null;
    if (
      (kind === "repair" && existing.kind !== "workflow.node.repair_requested") ||
      (kind === "variant" && existing.kind !== "workflow.node.variant_requested")
    ) {
      throw new Error(`${kind} idempotent retry conflicts with an existing successor intent kind.`);
    }
    const existingSuccessorLaneId = optionalText(existing.payload.successorLaneId);
    const existingSuccessorSemanticKey = optionalText(existing.payload.successorSemanticKey);
    const existingCheckpointId = optionalText(existing.payload.checkpointId);
    const existingLaneId = optionalText(existing.payload.laneId);
    const existingInstruction = optionalText(existing.payload.instruction);
    if (
      existingSuccessorLaneId !== successorLaneId ||
      existingSuccessorSemanticKey !== successorSemanticKey ||
      existingCheckpointId !== input.checkpointId ||
      existingLaneId !== (input.laneId ?? existingLaneId) ||
      existingInstruction !== (input.instruction ?? existingInstruction)
    ) {
      throw new Error(`${kind} idempotent retry conflicts with existing successor identity.`);
    }
    const laneEvent = this.getEventByIdempotencyKey(input.sessionId, `checkpoint-successor:${intentId}:lane`);
    if (!laneEvent || laneEvent.kind !== "workflow.lane.declared") {
      throw new Error(`${kind} idempotent retry conflicts with missing existing successor lane.`);
    }
    const edgePrefix = `checkpoint-successor:${intentId}:edge:`;
    const edgeEvents = this.listEvents(input.sessionId).filter((event) =>
      event.kind === "workflow.edge.declared" &&
      typeof event.idempotencyKey === "string" &&
      event.idempotencyKey.startsWith(edgePrefix)
    );
    return {
      status: "requested",
      event: existing,
      laneEvent,
      edgeEvents,
      projection: this.materializeFlowProjection(input.sessionId),
    };
  }

  private checkpointRepairFailedEvidenceResult(
    sessionId: string,
    failedEvidenceId: string,
  ): WorkflowCheckpointSuccessorResult | null {
    const existing = this.listEvents(sessionId).find((event) =>
      event.kind === "workflow.node.repair_requested" &&
      repairEventReferencesFailedEvidence(event, failedEvidenceId)
    );
    if (!existing) return null;

    const intentId = optionalText(existing.payload.intentId);
    if (!intentId) throw new Error("repair idempotent retry conflicts with an existing repair missing intent identity.");
    const laneEvent = this.getEventByIdempotencyKey(sessionId, `checkpoint-successor:${intentId}:lane`);
    if (!laneEvent || laneEvent.kind !== "workflow.lane.declared") {
      throw new Error("repair idempotent retry conflicts with missing existing successor lane.");
    }
    const edgePrefix = `checkpoint-successor:${intentId}:edge:`;
    const edgeEvents = this.listEvents(sessionId).filter((event) =>
      event.kind === "workflow.edge.declared" &&
      typeof event.idempotencyKey === "string" &&
      event.idempotencyKey.startsWith(edgePrefix)
    );
    return {
      status: "requested",
      event: existing,
      laneEvent,
      edgeEvents,
      projection: this.materializeFlowProjection(sessionId),
    };
  }

  private assertCheckpointSuccessorIdentityAvailable(
    kind: "repair" | "variant",
    prepared: PreparedCheckpointSuccessorRequest,
  ): void {
    const { projection, lane, targetLaneId, successorLaneId, successorSemanticKey, intentId } = prepared;
    if (successorLaneId === targetLaneId) {
      throw new Error(`${kind} successor lane id must not match the source lane.`);
    }
    if (successorSemanticKey === lane.semanticKey) {
      throw new Error(`${kind} successor semantic key must not match the source lane semantic key.`);
    }
    const laneIdConflict = projection.lanes.find((item) => item.id === successorLaneId);
    if (laneIdConflict) throw new Error(`${kind} successor lane id already exists in this session.`);
    const semanticKeyConflict = projection.lanes.find((item) => item.semanticKey === successorSemanticKey);
    if (semanticKeyConflict) throw new Error(`${kind} successor semantic key already exists in this session.`);
    const intentConflict = projection.checkpointIntents.find((item) =>
      item.intentId !== intentId &&
      (item.successorLaneId === successorLaneId || item.successorSemanticKey === successorSemanticKey)
    );
    if (intentConflict?.successorLaneId === successorLaneId) {
      throw new Error(`${kind} successor lane id already belongs to another checkpoint intent.`);
    }
    if (intentConflict?.successorSemanticKey === successorSemanticKey) {
      throw new Error(`${kind} successor semantic key already belongs to another checkpoint intent.`);
    }
  }

  private assertRepairRegressionIdentityAvailable(
    prepared: PreparedCheckpointSuccessorRequest,
    regression: PreparedRepairRegressionLane,
  ): void {
    const laneIdConflict = prepared.projection.lanes.find((item) => item.id === regression.laneId);
    if (laneIdConflict) throw new Error("repair regression lane id already exists in this session.");
    const semanticKeyConflict = prepared.projection.lanes.find((item) => item.semanticKey === regression.semanticKey);
    if (semanticKeyConflict) throw new Error("repair regression semantic key already exists in this session.");
  }

  private requireKnownSession(sessionId: string): WorkflowSessionRecord {
    const session = this.getWorkflowSession(sessionId);
    if (!session) throw new Error(`Workflow session is not known: ${sessionId}.`);
    return session;
  }

  private createWorkflowCard(
    sessionId: string,
    call: Extract<WorkflowCardToolCall, { tool: "createWorkflowCard" }>,
    context: WorkflowCardToolContext,
  ): WorkflowCardToolResult {
    const toolKey = call.toolCallId ? `tool:${call.toolCallId}` : `tool:${stableJson(call)}`;
    const existingEvent = this.getEventByIdempotencyKey(sessionId, `${toolKey}:node_declared`);
    if (existingEvent) {
      return {
        tool: call.tool,
        nodeId: String(existingEvent.payload.nodeId ?? call.input.id ?? "unknown"),
        status: "applied",
        message: "Card created.",
      };
    }
    const blocked = this.getEventByIdempotencyKey(sessionId, `${toolKey}:gate_blocked`);
    if (blocked) {
      return {
        tool: call.tool,
        nodeId: cleanId(call.input.id) ?? "unknown",
        status: "skipped",
        message: String(blocked.payload.reason ?? "Gate blocked."),
      };
    }

    const id = cleanId(call.input.id) ?? nextNodeId(this.listLanes(sessionId));
    const title = requireText(call.input.title, "title");
    const brief = requireText(call.input.brief, "brief");
    const agent = requireAgent(call.input.agent);
    const laneKind = inferLaneKind(agent, title, brief);
    const taskKey = normalizeTaskKey(call.input.taskKey);
    const semanticKey = taskKey ? `task-key:${taskKey}` : semanticKeyForCard(agent, title, brief);
    const existingLane = this.findExistingLane(sessionId, id, semanticKey);
    const lanes = this.listLanes(sessionId);
    const segments = this.listSegmentsForSession(sessionId);
    const dependencyIds = repairGateDependencies(
      lanes,
      segments,
      laneKind,
      uniqueIds(call.input.dependencies ?? []).filter((dependency) => dependency !== id),
    );
    const gate = evaluateGate(lanes, segments, {
      laneKind,
      dependencies: dependencyIds,
    });

    if (!gate.allowed) {
      this.appendWorkflowEvent({
        sessionId,
        kind: "gate_blocked",
        source: "workflow_gate",
        causationId: context.causationId ?? null,
        correlationId: context.correlationId ?? null,
        idempotencyKey: `${toolKey}:gate_blocked`,
        payload: { nodeId: id, laneKind, reason: gate.reason },
        now: context.now,
      });
      return { tool: call.tool, nodeId: id, status: "skipped", message: gate.reason };
    }

    const tx = this.db.transaction(() => {
      const eventKind: WorkflowEventKind = existingLane ? "node_patched" : "node_declared";
      const event = this.insertEventInTransaction({
        sessionId,
        kind: eventKind,
        source: "hermes",
        laneId: existingLane?.id ?? id,
        causationId: context.causationId ?? null,
        correlationId: context.correlationId ?? null,
        idempotencyKey: `${toolKey}:node_declared`,
        payload: {
          nodeId: existingLane?.nodeId ?? id,
          laneId: existingLane?.id ?? id,
          semanticKey,
          laneKind,
          agentKind: agent,
          title,
          brief,
          requestedStatus: call.input.status ?? "pending",
          sourceRunId: context.sourceRunId,
          toolCallId: call.toolCallId ?? null,
          worktreePath: call.input.worktreePath ?? null,
          output: call.input.output ?? null,
        },
        now: context.now,
      });
      if (existingLane) {
        this.updateLaneFromPatch(existingLane.id, {
          sessionId,
          title,
          brief,
          status: normalizeInitialLaneStatus(call.input.status, laneKind),
          now: context.now,
        });
      } else {
        this.statements.insertLane.run({
          id,
          session_id: sessionId,
          node_id: id,
          semantic_key: semanticKey,
          lane_kind: laneKind,
          agent_kind: agent,
          title,
          brief,
          status: normalizeInitialLaneStatus(call.input.status, laneKind),
          phase: phaseForLaneKind(laneKind),
          archived: 0,
          created_at: context.now,
          updated_at: context.now,
        });
      }
      for (const dependency of dependencyIds) {
        this.insertEdgeInTransaction(sessionId, dependency, existingLane?.id ?? id, context.now, `${toolKey}:edge:${dependency}:${id}`, event.id);
      }
      return event;
    });
    tx();
    return { tool: call.tool, nodeId: existingLane?.nodeId ?? id, status: "applied", message: existingLane ? "Equivalent card merged." : "Card created." };
  }

  private patchOrArchiveWorkflowCard(
    sessionId: string,
    call: Exclude<WorkflowCardToolCall, { tool: "createWorkflowCard" }>,
    context: WorkflowCardToolContext,
  ): WorkflowCardToolResult {
    const id = requireText(call.input.id, "id");
    const lane = this.getLane(sessionId, id);
    if (!lane) return { tool: call.tool, nodeId: id, status: "skipped", message: "Card not found." };

    const tx = this.db.transaction(() => {
      const event = this.insertEventInTransaction({
        sessionId,
        kind: "node_patched",
        source: "hermes",
        laneId: id,
        causationId: context.causationId ?? null,
        correlationId: context.correlationId ?? null,
        idempotencyKey: call.toolCallId ? `tool:${call.toolCallId}:node_patched` : null,
        payload: { nodeId: id, patch: call.input, archived: call.tool === "deleteWorkflowCard" },
        now: context.now,
      });
      if (call.tool === "deleteWorkflowCard") {
        this.statements.archiveLane.run({ session_id: sessionId, id, updated_at: context.now });
        return event;
      }
      this.updateLaneFromPatch(id, {
        sessionId,
        title: call.input.title?.trim() || lane.title,
        brief: call.input.brief?.trim() || lane.brief,
        status: call.input.status ? normalizeInitialLaneStatus(call.input.status, lane.laneKind) : lane.status,
        now: context.now,
      });
      return event;
    });
    tx();
    return { tool: call.tool, nodeId: id, status: "applied", message: call.tool === "deleteWorkflowCard" ? "Card archived." : "Card updated." };
  }

  private materializeNode(
    session: WorkflowSessionRecord,
    lane: WorkflowLaneRecord,
    index: number,
    createdWorktree?: WorkflowWorktreeIdentity | null,
  ): CanvasNode {
    const segments = this.listSegments(session.id, lane.id);
    const latestSegment = segments.at(-1) ?? null;
    const evidence = latestSegment?.evidence ?? null;
    const changesetId = isRecord(evidence) && typeof evidence.changesetId === "string" ? evidence.changesetId : `changeset-${session.id}-${lane.nodeId}`;
    const output = this.listEvents(session.id)
      .filter((event) => event.laneId === lane.id && event.kind === "segment_output_delta" && typeof event.payload.text === "string")
      .map((event) => String(event.payload.text));
    return {
      id: lane.nodeId,
      title: lane.title,
      agent: lane.agentKind,
      progress: progressForLaneStatus(lane.status),
      runtime: runtimeForLaneStatus(lane.status),
      display: {
        agentLabel: agentLabel(lane.agentKind),
        meta: [lane.laneKind, lane.nodeId],
      },
      workflowTrace:
        lane.laneKind === "planner"
          ? undefined
          : {
              source: "hermes",
              sourceRunId: "workflow-event-stream",
              lastTool: "createWorkflowCard",
              ...(lane.semanticKey?.startsWith("task-key:") ? { taskKey: lane.semanticKey.slice("task-key:".length) } : {}),
              ...(lane.semanticKey ? { semanticKey: lane.semanticKey } : {}),
            },
      status: mapLaneStatusToNodeStatus(lane.status),
      position: { x: 120 + (index % 3) * 340, y: 120 + Math.floor(index / 3) * 220 },
      runId: latestSegment?.runId ?? `run-${session.id}-${lane.nodeId}`,
      changesetId,
      output: output.length > 0 ? output : [`Workflow lane ${lane.status}.`],
      worktree: worktreeForSessionTarget(session, lane.nodeId, latestSegment?.worktreePath, createdWorktree),
      context: {
        brief: lane.brief,
        sessionGoal: session.goal,
        relatedRequirements: "Projected from SQLite workflow_events.",
        relatedDesign: "CanvasSession is a deterministic projection, not the fact source.",
        relatedTasks: lane.semanticKey ?? lane.laneKind,
        dependencies: this.dependenciesForLane(session.id, lane.id),
        constraints: [
          "Renderer does not access SQLite directly.",
          "Completion follows evidence events, not agent prose.",
        ],
      },
    };
  }

  private dependenciesForLane(sessionId: string, laneId: string): string[] {
    return (this.statements.listEdges.all(sessionId) as EdgeRow[])
      .filter((edge) => edge.target_lane_id === laneId)
      .map((edge) => edge.source_lane_id);
  }

  private ensureSegmentInTransaction(
    input: SegmentEvidenceInput | FinishSegmentInput | ContinuationInput,
    causationId?: string,
  ): void {
    const existing = this.statements.getSegment.get(input.sessionId, input.segmentId) as SegmentRow | undefined;
    if (existing) return;
    this.insertEventInTransaction({
      sessionId: input.sessionId,
      kind: "segment_started",
      source: input.agentKind,
      laneId: input.laneId,
      segmentId: input.segmentId,
      causationId: causationId ?? null,
      idempotencyKey: `segment:${input.segmentId}:started`,
      payload: {
        runId: input.runId,
        agentKind: input.agentKind,
        transport: input.transport,
        worktreePath: input.worktreePath,
      },
      now: input.now,
    });
    this.statements.insertSegment.run({
      id: input.segmentId,
      session_id: input.sessionId,
      lane_id: input.laneId,
      parent_segment_id: null,
      run_id: input.runId,
      agent_kind: input.agentKind,
      transport: input.transport,
      status: "running",
      worktree_path: input.worktreePath,
      started_at: input.now,
      ended_at: null,
      exit_code: null,
      evidence_json: null,
      error_reason: null,
    });
  }

  private insertEventInTransaction(input: AppendWorkflowEventInput): WorkflowEventRecord {
    if (input.idempotencyKey) {
      const existing = this.getEventByIdempotencyKey(input.sessionId, input.idempotencyKey);
      if (existing) return existing;
    }
    const max = this.statements.maxSeq.get(input.sessionId) as { seq: number | null } | undefined;
    const seq = Number(max?.seq ?? 0) + 1;
    const id = `${input.sessionId}:event:${String(seq).padStart(8, "0")}`;
    this.statements.insertEvent.run({
      id,
      session_id: input.sessionId,
      seq,
      kind: input.kind,
      source: input.source,
      lane_id: input.laneId ?? null,
      segment_id: input.segmentId ?? null,
      causation_id: input.causationId ?? null,
      correlation_id: input.correlationId ?? null,
      idempotency_key: input.idempotencyKey ?? null,
      payload_json: stableJson(input.payload),
      created_at: input.now,
    });
    const row = this.statements.getEventByIdempotencyKey.get(input.sessionId, input.idempotencyKey ?? `__missing__`) as EventRow | undefined;
    if (row) return mapEvent(row);
    return {
      id,
      sessionId: input.sessionId,
      seq,
      kind: input.kind,
      source: input.source,
      laneId: input.laneId ?? null,
      segmentId: input.segmentId ?? null,
      causationId: input.causationId ?? null,
      correlationId: input.correlationId ?? null,
      idempotencyKey: input.idempotencyKey ?? null,
      payload: input.payload,
      createdAt: input.now,
    };
  }

  private insertFlowEventInTransaction(event: FlowEvent, now: string): WorkflowEventRecord {
    return this.insertEventInTransaction({
      sessionId: event.sessionId,
      kind: event.kind,
      source: event.source,
      idempotencyKey: event.idempotencyKey,
      payload: event.payload,
      now,
    });
  }

  private projectEventInTransaction(event: WorkflowEventRecord): void {
    if (event.kind !== "edge_declared") return;
    const sourceLaneId = requirePayloadText(event.payload, "sourceLaneId");
    const targetLaneId = requirePayloadText(event.payload, "targetLaneId");
    this.insertEdgeInTransaction(event.sessionId, sourceLaneId, targetLaneId, event.createdAt, event.idempotencyKey ?? null, event.id);
  }

  private insertEdgeInTransaction(
    sessionId: string,
    sourceLaneId: string,
    targetLaneId: string,
    now: string,
    idempotencyKey: string | null,
    causationId?: string,
  ): void {
    if (sourceLaneId === targetLaneId) throw new Error("Workflow edge cannot be a self-loop.");
    const session = this.getWorkflowSession(sessionId);
    if (!session) throw new Error(`Unknown workflow session ${sessionId}.`);
    if (targetLaneId === session.plannerLaneId) throw new Error("Workflow edge cannot target the planner lane.");
    if (!this.getLane(sessionId, sourceLaneId)) throw new Error(`Unknown source workflow lane ${sourceLaneId}.`);
    if (!this.getLane(sessionId, targetLaneId)) throw new Error(`Unknown target workflow lane ${targetLaneId}.`);
    if (this.createsCycle(sessionId, sourceLaneId, targetLaneId)) throw new Error("Workflow edge would create a cycle.");
    if (idempotencyKey && !this.getEventByIdempotencyKey(sessionId, idempotencyKey)) {
      this.insertEventInTransaction({
        sessionId,
        kind: "edge_declared",
        source: "workflow_store",
        causationId: causationId ?? null,
        idempotencyKey,
        payload: { sourceLaneId, targetLaneId },
        now,
      });
    }
    this.statements.insertEdge.run({
      id: `edge-${sourceLaneId}-${targetLaneId}`,
      session_id: sessionId,
      source_lane_id: sourceLaneId,
      target_lane_id: targetLaneId,
      created_at: now,
    });
  }

  private createsCycle(sessionId: string, sourceLaneId: string, targetLaneId: string): boolean {
    const edges = this.statements.listEdges.all(sessionId) as EdgeRow[];
    const outgoing = new Map<string, string[]>();
    for (const edge of edges) {
      const values = outgoing.get(edge.source_lane_id) ?? [];
      values.push(edge.target_lane_id);
      outgoing.set(edge.source_lane_id, values);
    }
    const queue = [targetLaneId];
    const seen = new Set<string>();
    while (queue.length > 0) {
      const current = queue.shift();
      if (!current || seen.has(current)) continue;
      if (current === sourceLaneId) return true;
      seen.add(current);
      queue.push(...(outgoing.get(current) ?? []));
    }
    return false;
  }

  private findExistingLane(sessionId: string, id: string, semanticKey: string): WorkflowLaneRecord | null {
    const byId = this.getLane(sessionId, id);
    if (byId) return byId;
    const row = this.statements.getLaneBySemanticKey.get(sessionId, semanticKey) as LaneRow | undefined;
    return row ? mapLane(row) : null;
  }

  private listSegmentsForSession(sessionId: string): WorkflowSegmentRecord[] {
    const lanes = this.listLanes(sessionId);
    return lanes.flatMap((lane) => this.listSegments(sessionId, lane.id));
  }

  private getEventByIdempotencyKey(sessionId: string, idempotencyKey: string): WorkflowEventRecord | null {
    const row = this.statements.getEventByIdempotencyKey.get(sessionId, idempotencyKey) as EventRow | undefined;
    return row ? mapEvent(row) : null;
  }

  private updateLaneFromPatch(
    laneId: string,
    input: { sessionId: string; title: string; brief: string; status: WorkflowLaneStatus; now: string },
  ): void {
    this.db
      .prepare(
        [
          "UPDATE workflow_lanes",
          "SET title = @title, brief = @brief, status = @status, phase = @phase, updated_at = @updated_at",
          "WHERE session_id = @session_id AND id = @id",
        ].join(" "),
      )
      .run({
        session_id: input.sessionId,
        id: laneId,
        title: input.title,
        brief: input.brief,
        status: input.status,
        phase: phaseForLaneStatus(input.status),
        updated_at: input.now,
      });
  }

  private setLaneStatus(sessionId: string, laneId: string, status: WorkflowLaneStatus, now: string): void {
    const lane = this.getLane(sessionId, laneId);
    if (!lane) throw new Error(`Unknown workflow lane ${laneId}.`);
    if (lane.status === "completed" && status === "running" && lane.laneKind !== "planner") {
      throw new Error("Completed workflow lane cannot return to running without continuation.");
    }
    this.statements.updateLaneStatus.run({
      session_id: sessionId,
      id: laneId,
      status,
      phase: phaseForLaneStatus(status),
      updated_at: now,
    });
  }
}

class LedgerSanitizer {
  private readonly recentEventLimit: number;
  private readonly factLimit: number;
  private readonly maxSummaryLength: number;

  constructor(options: WorkflowLedgerOptions) {
    this.recentEventLimit = options.recentEventLimit ?? 12;
    this.factLimit = options.factLimit ?? 8;
    this.maxSummaryLength = options.maxSummaryLength ?? 320;
  }

  build(events: WorkflowEventRecord[]): WorkflowLedgerSummary {
    const workflowEvents = events.filter((event) => event.kind.startsWith("workflow."));
    const facts: string[] = [];
    const requestedQuestions = new Map<string, string>();
    const answeredQuestions = new Set<string>();

    for (const event of workflowEvents) {
      if (event.kind === "workflow.user_input" && typeof event.payload.text === "string") {
        facts.push(`User input: ${this.sanitize(event.payload.text)}`);
      }
      if (event.kind === "workflow.profile" && isRecord(event.payload.requirementProfile)) {
        const text = event.payload.requirementProfile.text;
        if (typeof text === "string" && text.trim()) facts.push(`Requirement: ${this.sanitize(text)}`);
      }
      if (event.kind === "workflow.user_decision.requested" && typeof event.payload.decisionId === "string") {
        requestedQuestions.set(event.payload.decisionId, this.sanitize(String(event.payload.prompt ?? event.payload.reason ?? "")));
      }
      if (event.kind === "workflow.user_decision.answered" && typeof event.payload.decisionId === "string") {
        answeredQuestions.add(event.payload.decisionId);
        if (typeof event.payload.selectedOption === "string") {
          facts.push(`Decision: ${this.sanitize(event.payload.selectedOption)}`);
        }
      }
    }

    const recentEvents = workflowEvents
      .map((event) => this.summarizeEvent(event))
      .filter((event): event is WorkflowLedgerSummaryEvent => Boolean(event))
      .slice(-this.recentEventLimit);
    const openQuestions = [...requestedQuestions]
      .filter(([decisionId]) => !answeredQuestions.has(decisionId))
      .map(([, prompt]) => prompt)
      .filter(Boolean);

    return {
      throughSeq: workflowEvents.at(-1)?.seq ?? 0,
      checkpointSummary: null,
      facts: compactStrings(facts).slice(-this.factLimit),
      recentEvents,
      openQuestions,
    };
  }

  private summarizeEvent(event: WorkflowEventRecord): WorkflowLedgerSummaryEvent | null {
    const summary = this.summaryText(event);
    if (!summary) return null;
    const laneId = event.laneId ?? laneIdFromPayload(event.payload);
    return {
      seq: event.seq,
      kind: event.kind,
      summary,
      ...(laneId ? { laneId } : {}),
    };
  }

  private summaryText(event: WorkflowEventRecord): string {
    switch (event.kind) {
      case "workflow.user_input":
        return `User input: ${this.sanitize(String(event.payload.text ?? ""))}`;
      case "workflow.intent.accepted":
        return `WorkflowIntent accepted: ${this.sanitize(String(event.payload.intentId ?? ""))}`;
      case "workflow.intent.rejected":
        return `WorkflowIntent rejected: ${this.sanitize(String(event.payload.reason ?? ""))}`;
      case "workflow.lane.declared":
        return `Lane declared: ${this.sanitize(laneTitleFromPayload(event.payload))}`;
      case "workflow.edge.declared":
        return `Edge declared: ${this.sanitize(edgeSummaryFromPayload(event.payload))}`;
      case "workflow.segment.started":
        return `Run started: ${this.sanitize(segmentSummaryFromPayload(event.payload))}`;
      case "workflow.segment.output_delta":
        return `Output summary: ${this.sanitize(String(event.payload.text ?? ""))}`;
      case "workflow.segment.finished":
        return `Run finished: ${this.sanitize(String(event.payload.status ?? "unknown"))}`;
      case "workflow.evidence.recorded":
        return `Evidence recorded: ${this.sanitize(evidenceSummaryFromPayload(event.payload))}`;
      case "workflow.user_decision.requested":
        return `Decision requested: ${this.sanitize(String(event.payload.prompt ?? event.payload.reason ?? ""))}`;
      case "workflow.user_decision.answered":
        return `Decision answered: ${this.sanitize(String(event.payload.selectedOption ?? ""))}`;
      default:
        return this.sanitize(String(event.kind));
    }
  }

  private sanitize(value: string): string {
    return sanitizeLedgerText(value, this.maxSummaryLength);
  }
}

export function createWorkflowStore(options: WorkflowStoreOptions): WorkflowStore {
  return new WorkflowStore(options);
}

function flowPlannerNode(session: WorkflowSessionRecord): CanvasNode {
  return {
    id: session.plannerLaneId,
    title: "Hermes planner",
    agent: "hermes",
    progress: "Running",
    runtime: { phase: "Planning", message: "Running", action: "planning" },
    display: { agentLabel: "Hermes", meta: ["planner", session.plannerLaneId] },
    status: "running",
    position: { x: 120, y: 120 },
    runId: runIdForLane(session.id, session.plannerLaneId),
    changesetId: `changeset-${session.id}-${session.plannerLaneId}`,
    output: ["Workflow planner is active."],
    worktree: worktreeForSessionTarget(session, session.plannerLaneId),
    context: {
      brief: session.goal,
      sessionGoal: session.goal,
      relatedRequirements: "Projected from SQLite workflow_events.",
      relatedDesign: "CanvasSession is a deterministic projection, not the fact source.",
      relatedTasks: "planner:root",
      dependencies: [],
      constraints: [
        "Renderer does not access SQLite directly.",
        "Completion follows evidence events, not agent prose.",
      ],
    },
  };
}

function flowLaneToCanvasNode(
  session: WorkflowSessionRecord,
  projection: FlowProjection,
  lane: FlowLane,
  index: number,
  dependencies: string[],
  changesetId: string | undefined,
): CanvasNode {
  const latestSegment = [...projection.segments].reverse().find((segment) => segment.laneId === lane.id);
  const createdWorktree = worktreeForParentLane(projection, lane.id);
  const statusProjection = nodeStatusProjectionForFlowLane(lane);
  const status = statusProjection.status;
  return {
    id: lane.id,
    title: lane.title,
    agent: lane.agentKind,
    progress: progressForFlowLaneStatus(lane.status),
    nodeKind: lane.nodeKind,
    executable: lane.executable,
    laneKind: lane.laneKind,
    semanticSubtype: lane.semanticSubtype,
    runtimePolicy: lane.runtimePolicy,
    runtime: runtimeForNodeStatus(status, lane.kind),
    display: {
      agentLabel: agentLabel(lane.agentKind),
      meta: [lane.kind, lane.id, "flow-kernel"],
    },
    workflowTrace: {
      source: "hermes",
      sourceRunId: "workflow-event-stream",
      lastTool: "createWorkflowCard",
      semanticKey: lane.semanticKey,
    },
    status,
    ...(statusProjection.rollbackStatus ? { rollbackStatus: statusProjection.rollbackStatus } : {}),
    position: { x: 460 + ((index - 1) % 3) * 340, y: 140 + Math.floor((index - 1) / 3) * 220 },
    runId: latestSegment?.runId ?? runIdForLane(session.id, lane.id),
    changesetId: changesetId ?? `changeset-${session.id}-${lane.id}`,
    output: lane.output.length > 0 ? lane.output : [`Flow Kernel lane ${lane.kind} is ${lane.status}.`],
    worktree: worktreeForSessionTarget(session, lane.id, undefined, createdWorktree),
    context: {
      brief: lane.brief ?? lane.title,
      sessionGoal: session.goal,
      relatedRequirements: "Compiled from Hermes WorkflowIntent.",
      relatedDesign: "Flow Kernel policy/gate/compiler creates the DAG projection.",
      relatedTasks: lane.semanticKey,
      dependencies,
      constraints: [
        "Renderer renders projection only.",
        "Completion follows evidence events, not agent prose.",
      ],
    },
  };
}

function flowDecisionToCanvasNode(
  session: WorkflowSessionRecord,
  decision: UserDecisionProjection,
  index: number,
): CanvasNode {
  const status: NodeStatus = decision.status === "answered" ? "completed" : "pending";
  return {
    id: decision.decisionId,
    title: "User decision required",
    agent: "hermes",
    progress: decision.status === "answered" ? "Decision answered" : "Waiting for user decision",
    nodeKind: "user_decision",
    executable: false,
    laneKind: "decision",
    semanticSubtype: "user_decision",
    runtimePolicy: {
      source: "workflow_projection",
      trusted: true,
      executable: false,
      sandbox: "read-only",
      sideEffects: [],
      reason: "User decision nodes are not executable.",
    },
    userDecision: decision,
    runtime: runtimeForNodeStatus(status, "decision"),
    display: { agentLabel: "User", meta: ["decision", decision.decisionId, "flow-kernel"] },
    workflowTrace: {
      source: "hermes",
      sourceRunId: "workflow-event-stream",
      lastTool: "createWorkflowCard",
      semanticKey: decision.decisionId,
    },
    status,
    position: { x: 460 + ((index - 1) % 3) * 340, y: 140 + Math.floor((index - 1) / 3) * 220 },
    runId: runIdForLane(session.id, decision.decisionId),
    changesetId: `changeset-${session.id}-${decision.decisionId}`,
    output: [
      decision.prompt,
      `Reason: ${decision.reason}`,
      `Options: ${decision.options.join(", ")}`,
    ],
    worktree: worktreeForSessionTarget(session, decision.decisionId),
    context: {
      brief: decision.prompt,
      sessionGoal: session.goal,
      relatedRequirements: decision.reason,
      relatedDesign: "Hermes requested a user decision before continuing the workflow.",
      relatedTasks: decision.targetLaneId ?? decision.decisionId,
      dependencies: decision.targetLaneId ? [decision.targetLaneId] : [],
      constraints: ["This node is not executable.", "The answer is restored through Flow Kernel user decision state."],
    },
  };
}

function worktreeForSessionTarget(
  session: WorkflowSessionRecord,
  nodeId: string,
  worktreePath?: string,
  createdWorktree?: WorkflowWorktreeIdentity | null,
): WorktreeMetadata {
  if (session.target.executionTarget === "new_worktree") {
    if (createdWorktree) {
      return {
        path: createdWorktree.realPath || createdWorktree.path,
        branchName: createdWorktree.branchName,
        baseCommit: createdWorktree.baseCommit,
        executionTarget: session.target.executionTarget,
        selectedBranch: session.target.selectedBranch,
        ...(session.target.baseRef ? { baseRef: session.target.baseRef } : {}),
        baselineRef: session.target.baseRef ?? session.target.selectedBranch,
        worktreeId: createdWorktree.worktreeId,
        variantId: createdWorktree.variantId,
        realPath: createdWorktree.realPath,
        gitdir: createdWorktree.gitdir,
        repoRoot: createdWorktree.repoRoot,
        headCommit: createdWorktree.headCommit,
      };
    }
    return {
      path: worktreePath ?? ".",
      branchName: session.target.selectedBranch,
      baseCommit: session.target.baseRef ?? session.target.selectedBranch,
      executionTarget: session.target.executionTarget,
      selectedBranch: session.target.selectedBranch,
      ...(session.target.baseRef ? { baseRef: session.target.baseRef } : {}),
      baselineRef: session.target.baseRef ?? session.target.selectedBranch,
      worktreeId: `worktree-${session.id}-${nodeId}`,
      variantId: nodeId,
    };
  }
  return {
    path: ".",
    branchName: session.target.selectedBranch,
    baseCommit: session.target.selectedBranch,
    executionTarget: session.target.executionTarget,
    selectedBranch: session.target.selectedBranch,
    baselineRef: session.target.selectedBranch,
  };
}

function worktreeForParentLane(projection: FlowProjection, laneId: string): WorkflowWorktreeIdentity | null {
  return projection.worktrees.find((worktree) => worktree.parentLaneId === laneId) ?? null;
}

function rollbackTargetLaneId(
  projection: FlowProjection,
  input: { laneId?: string; nodeId?: string; checkpointId?: string },
): string | null {
  if (input.laneId && projection.lanes.some((lane) => lane.id === input.laneId)) return input.laneId;
  if (input.checkpointId) {
    const checkpoint = projection.checkpoints.find((item) => item.id === input.checkpointId);
    if (checkpoint?.laneId && projection.lanes.some((lane) => lane.id === checkpoint.laneId)) return checkpoint.laneId;
  }
  if (input.nodeId) {
    const node = projection.projectionNodes.find((item) => item.id === input.nodeId || item.laneId === input.nodeId);
    if (node?.laneId && projection.lanes.some((lane) => lane.id === node.laneId)) return node.laneId;
    if (projection.lanes.some((lane) => lane.id === input.nodeId)) return input.nodeId;
    const checkpoint = projection.checkpoints.find((item) => item.nodeId === input.nodeId);
    if (checkpoint?.laneId && projection.lanes.some((lane) => lane.id === checkpoint.laneId)) return checkpoint.laneId;
  }
  return null;
}

function rollbackRequestId(input: WorkflowNodeRollbackInput, eligibility: WorkflowRollbackEligibility): string {
  return `rollback:${input.sessionId}:${eligibility.targetLaneId}:${eligibility.checkpointId ?? "checkpoint"}:${input.now}`;
}

function rollbackEventPayload(
  input: WorkflowNodeRollbackInput,
  eligibility: WorkflowRollbackEligibility,
  requestId: string,
): Record<string, unknown> {
  return {
    requestId,
    laneId: eligibility.targetLaneId,
    ...(input.nodeId ?? eligibility.targetNodeId ? { nodeId: input.nodeId ?? eligibility.targetNodeId } : {}),
    ...(eligibility.checkpointId ? { checkpointId: eligibility.checkpointId } : {}),
    ...(eligibility.checkpointPhase ? { checkpointPhase: eligibility.checkpointPhase } : {}),
    ...(eligibility.restoreCommitRef ? { restoreCommitRef: eligibility.restoreCommitRef } : {}),
    affectedLaneIds: eligibility.affectedLaneIds,
    ...(eligibility.affectedNodeIds ? { affectedNodeIds: eligibility.affectedNodeIds } : {}),
    downstreamInactiveLaneIds: eligibility.downstreamInactiveLaneIds,
    ...(eligibility.downstreamInactiveNodeIds ? { downstreamInactiveNodeIds: eligibility.downstreamInactiveNodeIds } : {}),
    ...(typeof input.localRollbackSafe === "boolean" ? { localRollbackSafe: input.localRollbackSafe } : {}),
    ...(eligibility.localSafetyStatus ? { localSafetyStatus: eligibility.localSafetyStatus } : {}),
    ...(eligibility.manualRepairReason ? { manualRepairReason: eligibility.manualRepairReason } : {}),
  };
}

function rollbackEligibilityWithManualRepair(
  eligibility: WorkflowRollbackEligibility,
  manualRepairReason: string,
): WorkflowRollbackEligibility {
  return {
    ...eligibility,
    eligible: false,
    localRollbackSafe: false,
    localSafetyStatus: "manual_repair_required",
    manualRepairReason,
    reason: manualRepairReason,
  };
}

function rollbackLocalSafetyStatus(localRollbackSafe: boolean | undefined): WorkflowRollbackEligibility["localSafetyStatus"] {
  if (localRollbackSafe === true) return "safe";
  if (localRollbackSafe === false) return "unsafe";
  return "unknown";
}

function rollbackBlockReason(
  eligibility: WorkflowRollbackEligibility,
  manualRepairRequired: boolean,
): WorkflowRollbackBlockReason {
  if (eligibility.blockingRemoteSideEffects.length > 0) {
    return {
      code: "remote_side_effect",
      message: "Rollback is blocked by remote side effects.",
      eventKinds: uniqueStrings(eligibility.blockingRemoteSideEffects.map((effect) => effect.eventKind)),
      remoteSideEffects: eligibility.blockingRemoteSideEffects,
      affectedLaneIds: eligibility.affectedLaneIds,
    };
  }
  if (manualRepairRequired) {
    return {
      code: "manual_repair_required",
      message: eligibility.manualRepairReason ?? "Local rollback requires manual repair.",
      affectedLaneIds: eligibility.affectedLaneIds,
      manualRepairRequired: true,
    };
  }
  if (eligibility.localRollbackSafe === false) {
    return {
      code: "manual_repair_required",
      message: eligibility.reason ?? "Local rollback is not safe.",
      affectedLaneIds: eligibility.affectedLaneIds,
      manualRepairRequired: true,
    };
  }
  return {
    code: eligibility.affectedLaneIds.length === 0 ? "unknown_target" : "invalid_checkpoint",
    message: eligibility.reason ?? "Rollback is not eligible.",
    affectedLaneIds: eligibility.affectedLaneIds,
  };
}

function prepareCheckpointSuccessorRequest(
  kind: "repair" | "variant",
  input: WorkflowCheckpointSuccessorRequest,
  projection: FlowProjection,
): PreparedCheckpointSuccessorRequest {
  const checkpoint = projection.checkpoints.find((item) => item.id === input.checkpointId);
  if (!checkpoint) throw new Error(`${kind} requires an existing checkpoint.`);
  const targetLaneId = input.laneId ?? checkpoint.laneId;
  if (!targetLaneId || checkpoint.laneId !== targetLaneId) {
    throw new Error(`${kind} requires a matching checkpoint for the target lane.`);
  }
  if (input.nodeId && checkpoint.nodeId !== input.nodeId) {
    throw new Error(`${kind} requires a matching checkpoint for the target node.`);
  }
  const requiredPhase = kind === "repair" ? "after" : "before";
  if (!checkpointPhaseIsExplicit(projection, checkpoint)) {
    throw new Error(`${kind} requires an explicit ${requiredPhase} checkpoint.`);
  }
  if (checkpoint.phase !== requiredPhase) throw new Error(`${kind} requires a ${requiredPhase} checkpoint.`);
  if (kind === "variant" && checkpoint.worktreeState === "dirty") {
    throw new Error("variant requires a restorable clean before checkpoint.");
  }
  const lane = projection.lanes.find((item) => item.id === targetLaneId);
  if (!lane) throw new Error(`${kind} requires a known target lane.`);
  const failedEvidence = kind === "repair" ? failedEvidenceForCheckpoint(projection, targetLaneId, checkpoint) : undefined;
  const failedRunId = failedEvidence ? runIdForFailedEvidence(projection, checkpoint, failedEvidence, input.sessionId) : undefined;
  const failedEvidenceFallbackReason = kind === "repair" && !failedEvidence
    ? "No failed evidence matched the selected checkpoint segment or run; repair is scoped to checkpoint context only."
    : undefined;
  const successorLaneId = input.successorLaneId ?? `${kind}-${targetLaneId}-${input.checkpointId}`;
  const successorSemanticKey = input.successorSemanticKey ?? `${kind}:${targetLaneId}:${input.checkpointId}`;
  const intentId = input.intentId ?? `${kind}:${successorLaneId}:${input.checkpointId}`;
  return {
    projection,
    checkpoint,
    targetLaneId,
    lane,
    successorLaneId,
    successorSemanticKey,
    intentId,
    edgeSources: kind === "repair" ? [targetLaneId] : incomingLaneIds(projection, targetLaneId),
    sourceEvidenceIds: failedEvidence ? [failedEvidence.id] : [],
    ...(failedEvidence ? { failedEvidence } : {}),
    ...(failedRunId ? { failedRunId } : {}),
    ...(failedEvidenceFallbackReason ? { failedEvidenceFallbackReason } : {}),
  };
}

function checkpointPhaseIsExplicit(projection: FlowProjection, checkpoint: WorkflowNodeCheckpoint): boolean {
  const authority = (checkpoint as { authority?: { phaseExplicit?: unknown } }).authority;
  if (authority) return authority.phaseExplicit === true;
  return projection.checkpointAuthorityFields[checkpoint.id]?.phase === true;
}

function successorLanePayload(
  kind: "repair" | "variant",
  lane: FlowLane,
  checkpoint: WorkflowNodeCheckpoint,
  successorLaneId: string,
  successorSemanticKey: string,
  sourceEvidenceIds: string[],
  failedEvidence?: FlowEvidence,
  failedEvidenceFallbackReason?: string,
  instruction?: string,
  title?: string,
): Record<string, unknown> {
  if (kind === "repair") {
    const brief = checkpointSuccessorContextBrief(
      kind,
      lane,
      checkpoint,
      sourceEvidenceIds,
      failedEvidence,
      failedEvidenceFallbackReason,
      instruction,
    );
    return {
      id: successorLaneId,
      semanticKey: successorSemanticKey,
      kind: "fix",
      laneKind: "fix",
      semanticSubtype: "repair",
      title: title ?? `Repair ${lane.title}`,
      brief,
      agentKind: lane.agentKind,
      status: "pending",
      fileScopes: lane.fileScopes,
      packageScopes: lane.packageScopes,
      requiredEvidence: lane.requiredEvidence,
      output: checkpointSuccessorContextOutput("repair", lane, checkpoint, sourceEvidenceIds, failedEvidence, failedEvidenceFallbackReason),
    };
  }
  const brief = checkpointSuccessorContextBrief(
    kind,
    lane,
    checkpoint,
    sourceEvidenceIds,
    failedEvidence,
    failedEvidenceFallbackReason,
    instruction,
  );
  return {
    id: successorLaneId,
    semanticKey: successorSemanticKey,
    kind: lane.kind,
    laneKind: lane.laneKind,
    semanticSubtype: lane.semanticSubtype,
    title: title ?? `Variant ${lane.title}`,
    brief,
    agentKind: lane.agentKind,
    status: "pending",
    fileScopes: lane.fileScopes,
    packageScopes: lane.packageScopes,
    requiredEvidence: lane.requiredEvidence,
    output: checkpointSuccessorContextOutput("variant", lane, checkpoint, sourceEvidenceIds),
  };
}

function repairRegressionLanePayload(
  prepared: PreparedCheckpointSuccessorRequest,
  instruction?: string,
): PreparedRepairRegressionLane {
  const failedEvidence = prepared.failedEvidence;
  if (!failedEvidence) throw new Error("repair regression requires failed evidence.");
  const laneId = `${prepared.successorLaneId}-regression`;
  const semanticKey = `regression:${prepared.successorSemanticKey}:${failedEvidence.id}`;
  return {
    laneId,
    semanticKey,
    failedEvidenceId: failedEvidence.id,
    lane: {
      id: laneId,
      semanticKey,
      kind: "regression_check",
      laneKind: "regression",
      semanticSubtype: "regression_check",
      title: `Validate ${prepared.lane.title}`,
      brief: repairRegressionContextBrief(prepared, instruction),
      agentKind: "codex",
      status: "pending",
      fileScopes: prepared.lane.fileScopes,
      packageScopes: prepared.lane.packageScopes,
      requiredEvidence: ["test"],
      output: [
        `Regression check for repair ${prepared.successorLaneId}.`,
        `Source lane ${prepared.targetLaneId}; failed evidence ${failedEvidence.id}.`,
        ...(failedEvidence.detail ? [`Failed detail ${failedEvidence.detail}.`] : []),
      ],
    },
  };
}

function repairRegressionContextBrief(prepared: PreparedCheckpointSuccessorRequest, instruction?: string): string {
  const failedEvidence = prepared.failedEvidence;
  const trimmedInstruction = instruction?.trim();
  return [
    `Regression check after repair ${prepared.successorLaneId}.`,
    `source lane ${prepared.targetLaneId}; source node ${prepared.checkpoint.nodeId}.`,
    ...(prepared.checkpoint.runId ? [`source run ${prepared.checkpoint.runId}.`] : []),
    ...(prepared.checkpoint.segmentId ? [`source segment ${prepared.checkpoint.segmentId}.`] : []),
    ...(failedEvidence ? [`failed evidence ${failedEvidence.id}.`] : []),
    ...(failedEvidence?.detail ? [`failed detail ${failedEvidence.detail}.`] : []),
    ...(trimmedInstruction ? [`repair instruction ${trimmedInstruction}`] : []),
  ].join(" ");
}

function checkpointSuccessorContextOutput(
  kind: "repair" | "variant",
  lane: FlowLane,
  checkpoint: WorkflowNodeCheckpoint,
  sourceEvidenceIds: string[],
  failedEvidence?: FlowEvidence,
  failedEvidenceFallbackReason?: string,
): string[] {
  return [
    `${kind} successor for source lane ${lane.id}.`,
    `Original node ${checkpoint.nodeId}; checkpoint ${checkpoint.id} (${checkpoint.phase}).`,
    ...(checkpoint.runId ? [`Checkpoint run ${checkpoint.runId}.`] : []),
    ...(checkpoint.segmentId ? [`Checkpoint segment ${checkpoint.segmentId}.`] : []),
    ...(sourceEvidenceIds.length > 0 ? [`Failed evidence ${sourceEvidenceIds.join(", ")}.`] : []),
    ...(failedEvidence?.detail ? [`Failed detail ${failedEvidence.detail}.`] : []),
    ...(failedEvidenceFallbackReason ? [failedEvidenceFallbackReason] : []),
  ];
}

function checkpointSuccessorContextBrief(
  kind: "repair" | "variant",
  lane: FlowLane,
  checkpoint: WorkflowNodeCheckpoint,
  sourceEvidenceIds: string[],
  failedEvidence?: FlowEvidence,
  failedEvidenceFallbackReason?: string,
  instruction?: string,
): string {
  const trimmedInstruction = instruction?.trim();
  return [
    `${kind === "repair" ? "Repair" : "Variant"} from ${checkpoint.phase} checkpoint ${checkpoint.id}.`,
    `source lane ${lane.id}; source node ${checkpoint.nodeId}.`,
    ...(checkpoint.runId ? [`source run ${checkpoint.runId}.`] : []),
    ...(checkpoint.segmentId ? [`source segment ${checkpoint.segmentId}.`] : []),
    ...(sourceEvidenceIds.length > 0 ? [`failed evidence ${sourceEvidenceIds.join(", ")}.`] : []),
    ...(failedEvidence?.detail ? [`failed detail ${failedEvidence.detail}.`] : []),
    ...(failedEvidenceFallbackReason ? [failedEvidenceFallbackReason] : []),
    ...(trimmedInstruction ? [`instruction ${trimmedInstruction}`] : []),
  ].join(" ");
}

function repairEventReferencesFailedEvidence(event: WorkflowEventRecord, failedEvidenceId: string): boolean {
  if (optionalText(event.payload.failedEvidenceId) === failedEvidenceId) return true;
  const sourceEvidenceIds = event.payload.sourceEvidenceIds;
  return Array.isArray(sourceEvidenceIds) && sourceEvidenceIds.some((value) => value === failedEvidenceId);
}

function failedEvidenceForCheckpoint(
  projection: FlowProjection,
  laneId: string,
  checkpoint: WorkflowNodeCheckpoint,
): FlowEvidence | undefined {
  if (!checkpoint.runId || !checkpoint.segmentId) return undefined;
  const segment = projection.segments.find((item) =>
    item.id === checkpoint.segmentId &&
    item.laneId === laneId &&
    item.runId === checkpoint.runId &&
    item.status === "failed"
  );
  if (!segment) return undefined;
  return [...projection.evidence].reverse().find((evidence) =>
    evidence.laneId === laneId &&
    evidence.segmentId === checkpoint.segmentId &&
    evidence.status === "failed" &&
    evidence.runEvidence?.runId === checkpoint.runId &&
    evidence.runEvidence?.status === "failed"
  );
}

function runIdForFailedEvidence(
  projection: FlowProjection,
  checkpoint: WorkflowNodeCheckpoint,
  failedEvidence: FlowEvidence,
  sessionId: string,
): string | undefined {
  const segment = projection.segments.find((item) => item.id === failedEvidence.segmentId);
  if (segment?.runId) return segment.runId;
  if (checkpoint.segmentId === failedEvidence.segmentId && checkpoint.runId) return checkpoint.runId;
  return runIdFromSegmentId(sessionId, failedEvidence.segmentId);
}

function incomingLaneIds(projection: FlowProjection, laneId: string): string[] {
  return projection.edges
    .filter((edge) => edge.targetLaneId === laneId)
    .map((edge) => edge.sourceLaneId);
}

function uniqueStrings(values: string[]): string[] {
  return [...new Set(values)];
}

function worktreesByParentLaneId(worktrees: WorkflowWorktreeIdentity[]): Map<string, WorkflowWorktreeIdentity> {
  const byLaneId = new Map<string, WorkflowWorktreeIdentity>();
  for (const worktree of worktrees) byLaneId.set(worktree.parentLaneId, worktree);
  return byLaneId;
}

function dependenciesFromFlowProjection(projection: FlowProjection): Map<string, string[]> {
  const dependencies = new Map<string, string[]>();
  for (const edge of projection.edges) {
    dependencies.set(edge.targetLaneId, [...(dependencies.get(edge.targetLaneId) ?? []), edge.sourceLaneId]);
  }
  return dependencies;
}

function changesetsFromFlowEvents(events: WorkflowEventRecord[]): Map<string, string> {
  const changesets = new Map<string, string>();
  for (const event of events) {
    if (event.kind !== "workflow.evidence.recorded") continue;
    const laneId = laneIdFromPayload(event.payload);
    const evidence = isRecord(event.payload.evidence) ? event.payload.evidence : null;
    const changesetId = evidence && typeof evidence.changesetId === "string" ? evidence.changesetId : null;
    if (laneId && changesetId) changesets.set(laneId, changesetId);
  }
  return changesets;
}

function progressForFlowLaneStatus(status: FlowLane["status"]): string {
  if (status === "completed") return "Evidence ready";
  if (status === "running") return "Streaming output";
  if (status === "failed" || status === "blocked") return "Gate rejected";
  return "Waiting for scheduler";
}

function runtimeForNodeStatus(status: NodeStatus, action: string): NodeRuntimeState {
  switch (status) {
    case "pending":
      return { phase: "Queued", message: "Waiting for scheduler", action };
    case "running":
      return { phase: "Executing", message: "Running", action };
    case "retrying":
      return { phase: "Retrying", message: "Retrying", action };
    case "completed":
      return { phase: "Completed", message: "Evidence ready", action };
    case "failed":
      return { phase: "Failed", message: "Needs attention", action };
  }
}

function runIdForLane(sessionId: string, laneId: string): string {
  return `run-${sessionId}-${laneId}`;
}

function runIdFromSegmentId(sessionId: string, segmentId: string): string | undefined {
  const prefix = `segment-${sessionId}-`;
  return segmentId.startsWith(prefix) ? runIdForLane(sessionId, segmentId.slice(prefix.length)) : undefined;
}

function segmentIdForLane(sessionId: string, laneId: string): string {
  return `segment-${sessionId}-${laneId}`;
}

function plannerSegmentIdForRun(runId: string): string {
  return `planner-segment-${runId}`;
}

function flowStatusFromRunEvidence(evidence: RunEvidence): "succeeded" | "failed" | "cancelled" | "timed-out" {
  if (evidence.status === "cancelled") return "cancelled";
  if (evidence.status === "timed-out") return "timed-out";
  return evidence.exitCode === 0 || evidence.status === "succeeded" ? "succeeded" : "failed";
}

function isTerminalRunEvidence(evidence: RunEvidence): boolean {
  return new Set(["succeeded", "failed", "cancelled", "timed-out"]).has(evidence.status) &&
    typeof evidence.completedAt === "string" && evidence.completedAt.length > 0;
}

function assertPlannerTerminalEvidenceReplay(segment: SegmentRow, evidence: RunEvidence): void {
  const status = flowStatusFromRunEvidence(evidence);
  const errorReason = evidence.errorReason ?? evidence.cancelReason ?? null;
  if (
    segment.status !== status ||
    segment.evidence_json !== stableJson(evidence) ||
    segment.exit_code !== (evidence.exitCode ?? null) ||
    segment.error_reason !== errorReason
  ) {
    throw new Error("Planner terminal evidence conflict for existing run.");
  }
}

function resultSummaryFromEvidence(evidence: RunEvidence): string {
  const status = evidence.exitCode === 0 ? "succeeded" : evidence.status;
  const checkNames = evidence.checks.map((check) => `${check.name}: ${check.status}`).join(", ");
  return checkNames ? `Run ${status}; ${checkNames}.` : `Run ${status}.`;
}

function sanitizeRunEvidence(evidence: RunEvidence): RunEvidence {
  return {
    runId: evidence.runId,
    status: evidence.status,
    exitCode: evidence.exitCode,
    changesetId: sanitizeOptionalWorkflowText(evidence.changesetId),
    checks: evidence.checks.map(sanitizeEvidenceCheck),
    artifacts: evidence.artifacts.map(sanitizeWorkflowStoredText),
    review: evidence.review ? sanitizeEvidenceCheck(evidence.review) : null,
    errorReason: sanitizeOptionalWorkflowText(evidence.errorReason),
    cancelReason: sanitizeOptionalWorkflowText(evidence.cancelReason),
    completedAt: evidence.completedAt,
  };
}

function sanitizeEvidenceCheck(check: RunEvidence["checks"][number]): RunEvidence["checks"][number] {
  const detail = sanitizeOptionalWorkflowText(check.detail);
  return {
    kind: check.kind,
    name: sanitizeWorkflowStoredText(check.name),
    status: check.status,
    ...(detail ? { detail } : {}),
  };
}

function sanitizeOptionalWorkflowText(value: string | null | undefined): string | null {
  if (!value) return null;
  return sanitizeWorkflowStoredText(value) || null;
}

function sanitizeWorkflowStoredText(value: string): string {
  return sanitizeLedgerText(value, 320);
}

function compactStrings(values: string[]): string[] {
  return values.map((value) => value.trim()).filter(Boolean);
}

function laneIdFromPayload(payload: Record<string, unknown>): string | null {
  if (typeof payload.laneId === "string") return payload.laneId;
  if (isRecord(payload.segment) && typeof payload.segment.laneId === "string") return payload.segment.laneId;
  if (isRecord(payload.lane) && typeof payload.lane.id === "string") return payload.lane.id;
  return null;
}

function laneTitleFromPayload(payload: Record<string, unknown>): string {
  if (isRecord(payload.lane)) {
    return [payload.lane.id, payload.lane.kind, payload.lane.title].filter((value) => typeof value === "string").join(" ");
  }
  return "";
}

function edgeSummaryFromPayload(payload: Record<string, unknown>): string {
  if (!isRecord(payload.edge)) return "";
  return [payload.edge.sourceLaneId, "->", payload.edge.targetLaneId].filter((value) => typeof value === "string").join(" ");
}

function segmentSummaryFromPayload(payload: Record<string, unknown>): string {
  if (!isRecord(payload.segment)) return "";
  return [payload.segment.laneId, payload.segment.runId].filter((value) => typeof value === "string").join(" ");
}

function evidenceSummaryFromPayload(payload: Record<string, unknown>): string {
  const laneId = laneIdFromPayload(payload);
  const evidence = isRecord(payload.evidence) ? payload.evidence : null;
  const checks = evidence && Array.isArray(evidence.checks) ? evidence.checks.length : 0;
  const artifacts = evidence && Array.isArray(evidence.artifacts) ? evidence.artifacts.length : 0;
  const status = evidence && typeof evidence.status === "string" ? evidence.status : "unknown";
  return `${laneId ?? "lane"} ${status}; checks=${checks}; artifacts=${artifacts}`;
}

function sanitizeLedgerText(value: string, maxLength: number): string {
  const hasPatch = /(^|\n)diff --git\b/.test(value) || /(^|\n)(\+\+\+|---) [ab]\//.test(value);
  let sanitized = hasPatch ? "Patch content omitted; only summary is available." : value;
  sanitized = sanitized
    .replace(/-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g, "[REDACTED]")
    .replace(/\bAuthorization:\s*Bearer\s+\S+/gi, "Authorization: Bearer [REDACTED]")
    .replace(/\b(DATABASE_URL|DB_URL|PGURI|PGURL|MYSQL_URL|REDIS_URL|MONGODB_URI)\s*[:=]\s*['"]?[^'"\s]+['"]?/gi, "[REDACTED]")
    .replace(/\b[a-z][a-z0-9+.-]*:\/\/[^\s/@:]+:[^\s/@]+@[^\s]+/gi, "[REDACTED_URL]")
    .replace(/\b[A-Z0-9_]*(TOKEN|KEY|SECRET|COOKIE|PASSWORD|AUTH)[A-Z0-9_]*\s*[:=]\s*['"]?[^'"\s]+['"]?/gi, "[REDACTED]")
    .replace(/\btoken\s*[:=]\s*['"]?[^'"\s]+['"]?/gi, "[REDACTED]")
    .replace(/\bsk-[A-Za-z0-9_-]{6,}\b/g, "[REDACTED]")
    .replace(/\.env[\w.-]*/g, "[REDACTED_FILE]")
    .replace(/^.*\bstderr\b.*$/gim, "[log output omitted]");
  sanitized = sanitized.replace(/\s+/g, " ").trim();
  if (sanitized.length <= maxLength) return sanitized;
  return `${sanitized.slice(0, maxLength - 22).trimEnd()}... [truncated]`;
}

function applyMigrations(db: Database.Database): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      version INTEGER PRIMARY KEY,
      applied_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS workflow_sessions (
      id TEXT PRIMARY KEY,
      project_id TEXT NOT NULL,
      hermes_session_id TEXT NOT NULL UNIQUE,
      planner_lane_id TEXT NOT NULL UNIQUE,
      title TEXT NOT NULL,
      goal TEXT NOT NULL,
      mode TEXT NOT NULL,
      execution_target TEXT NOT NULL DEFAULT 'current_branch',
      selected_branch TEXT NOT NULL DEFAULT 'HEAD',
      base_ref TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS hermes_sessions (
      id TEXT PRIMARY KEY,
      workflow_session_id TEXT NOT NULL UNIQUE REFERENCES workflow_sessions(id) ON DELETE RESTRICT,
      transport TEXT NOT NULL CHECK (transport IN ('hermes_live_chat', 'hermes_session_resume', 'hermes_replay_recovery')),
      planner_profile TEXT NOT NULL,
      process_id INTEGER,
      opaque_handle TEXT,
      status TEXT NOT NULL,
      started_at TEXT NOT NULL,
      last_seen_at TEXT NOT NULL,
      ended_at TEXT,
      recovery_reason TEXT,
      metadata_json TEXT NOT NULL,
      CHECK (transport != 'hermes_live_chat' OR process_id IS NOT NULL OR opaque_handle IS NOT NULL),
      CHECK (transport != 'hermes_session_resume' OR opaque_handle IS NOT NULL),
      CHECK (transport != 'hermes_replay_recovery' OR recovery_reason IS NOT NULL)
    );

    CREATE TABLE IF NOT EXISTS workflow_events (
      id TEXT PRIMARY KEY,
      session_id TEXT NOT NULL REFERENCES workflow_sessions(id) ON DELETE RESTRICT,
      seq INTEGER NOT NULL,
      kind TEXT NOT NULL,
      source TEXT NOT NULL,
      lane_id TEXT,
      segment_id TEXT,
      causation_id TEXT,
      correlation_id TEXT,
      idempotency_key TEXT,
      payload_json TEXT NOT NULL,
      created_at TEXT NOT NULL,
      UNIQUE(session_id, seq)
    );

    CREATE UNIQUE INDEX IF NOT EXISTS workflow_events_idempotency_key_uq
      ON workflow_events(session_id, idempotency_key)
      WHERE idempotency_key IS NOT NULL;

    CREATE TABLE IF NOT EXISTS workflow_lanes (
      id TEXT PRIMARY KEY,
      session_id TEXT NOT NULL REFERENCES workflow_sessions(id) ON DELETE RESTRICT,
      node_id TEXT NOT NULL UNIQUE,
      semantic_key TEXT,
      lane_kind TEXT NOT NULL CHECK (lane_kind IN ('planner', 'analysis', 'planning', 'coding', 'review', 'fix', 'validation', 'commit', 'pull_request', 'merge', 'closeout')),
      agent_kind TEXT NOT NULL,
      title TEXT NOT NULL,
      brief TEXT NOT NULL,
      status TEXT NOT NULL CHECK (status IN ('pending', 'blocked', 'ready', 'running', 'waiting_input', 'reviewing', 'retrying', 'completed', 'failed', 'archived')),
      phase TEXT NOT NULL,
      archived INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );

    CREATE UNIQUE INDEX IF NOT EXISTS workflow_lanes_semantic_key_uq
      ON workflow_lanes(session_id, semantic_key)
      WHERE semantic_key IS NOT NULL;

    CREATE TABLE IF NOT EXISTS workflow_edges (
      id TEXT PRIMARY KEY,
      session_id TEXT NOT NULL REFERENCES workflow_sessions(id) ON DELETE RESTRICT,
      source_lane_id TEXT NOT NULL REFERENCES workflow_lanes(id) ON DELETE RESTRICT,
      target_lane_id TEXT NOT NULL REFERENCES workflow_lanes(id) ON DELETE RESTRICT,
      created_at TEXT NOT NULL,
      UNIQUE(session_id, source_lane_id, target_lane_id),
      CHECK (source_lane_id != target_lane_id)
    );

    CREATE TABLE IF NOT EXISTS workflow_segments (
      id TEXT PRIMARY KEY,
      session_id TEXT NOT NULL REFERENCES workflow_sessions(id) ON DELETE RESTRICT,
      lane_id TEXT NOT NULL REFERENCES workflow_lanes(id) ON DELETE RESTRICT,
      parent_segment_id TEXT,
      run_id TEXT NOT NULL UNIQUE,
      agent_kind TEXT NOT NULL,
      transport TEXT NOT NULL,
      status TEXT NOT NULL,
      worktree_path TEXT NOT NULL,
      started_at TEXT NOT NULL,
      ended_at TEXT,
      exit_code INTEGER,
      evidence_json TEXT,
      error_reason TEXT
    );

    CREATE TABLE IF NOT EXISTS workflow_checkpoints (
      id TEXT PRIMARY KEY,
      session_id TEXT NOT NULL REFERENCES workflow_sessions(id) ON DELETE RESTRICT,
      lane_id TEXT REFERENCES workflow_lanes(id) ON DELETE RESTRICT,
      through_seq INTEGER NOT NULL,
      summary TEXT NOT NULL,
      facts_json TEXT NOT NULL,
      created_at TEXT NOT NULL
    );
  `);
  db.prepare("INSERT OR IGNORE INTO schema_migrations(version, applied_at) VALUES (1, datetime('now'))").run();
  applySessionTargetMigration(db);
  db.prepare("INSERT OR IGNORE INTO schema_migrations(version, applied_at) VALUES (2, datetime('now'))").run();
}

function applySessionTargetMigration(db: Database.Database): void {
  const columns = new Set((db.prepare("PRAGMA table_info(workflow_sessions)").all() as Array<{ name: string }>).map((row) => row.name));
  if (!columns.has("execution_target")) {
    db.exec("ALTER TABLE workflow_sessions ADD COLUMN execution_target TEXT NOT NULL DEFAULT 'current_branch'");
  }
  if (!columns.has("selected_branch")) {
    db.exec("ALTER TABLE workflow_sessions ADD COLUMN selected_branch TEXT NOT NULL DEFAULT 'HEAD'");
  }
  if (!columns.has("base_ref")) {
    db.exec("ALTER TABLE workflow_sessions ADD COLUMN base_ref TEXT");
  }
}

function prepareStatements(db: Database.Database): WorkflowStoreStatements {
  return {
    migrations: db.prepare("SELECT version FROM schema_migrations ORDER BY version"),
    getSession: db.prepare("SELECT * FROM workflow_sessions WHERE id = ?"),
    listWorkflowSessionIds: db.prepare("SELECT id FROM workflow_sessions ORDER BY created_at, id"),
    listHermesSessions: db.prepare("SELECT * FROM hermes_sessions WHERE workflow_session_id = ? ORDER BY started_at, id"),
    listEvents: db.prepare("SELECT * FROM workflow_events WHERE session_id = ? ORDER BY seq"),
    getEventByIdempotencyKey: db.prepare("SELECT * FROM workflow_events WHERE session_id = ? AND idempotency_key = ?"),
    maxSeq: db.prepare("SELECT MAX(seq) AS seq FROM workflow_events WHERE session_id = ?"),
    insertEvent: db.prepare(
      [
        "INSERT INTO workflow_events(id, session_id, seq, kind, source, lane_id, segment_id, causation_id, correlation_id, idempotency_key, payload_json, created_at)",
        "VALUES (@id, @session_id, @seq, @kind, @source, @lane_id, @segment_id, @causation_id, @correlation_id, @idempotency_key, @payload_json, @created_at)",
      ].join(" "),
    ),
    getLane: db.prepare("SELECT * FROM workflow_lanes WHERE session_id = ? AND id = ?"),
    getLaneBySemanticKey: db.prepare("SELECT * FROM workflow_lanes WHERE session_id = ? AND semantic_key = ?"),
    listLanes: db.prepare(
      [
        "SELECT * FROM workflow_lanes WHERE session_id = ?",
        "ORDER BY CASE lane_kind",
        "WHEN 'planner' THEN 0 WHEN 'analysis' THEN 1 WHEN 'planning' THEN 2 WHEN 'coding' THEN 3",
        "WHEN 'review' THEN 4 WHEN 'fix' THEN 5 WHEN 'validation' THEN 6 WHEN 'commit' THEN 7",
        "WHEN 'pull_request' THEN 8 WHEN 'merge' THEN 9 WHEN 'closeout' THEN 10 ELSE 99 END, created_at, id",
      ].join(" "),
    ),
    insertLane: db.prepare(
      [
        "INSERT INTO workflow_lanes(id, session_id, node_id, semantic_key, lane_kind, agent_kind, title, brief, status, phase, archived, created_at, updated_at)",
        "VALUES (@id, @session_id, @node_id, @semantic_key, @lane_kind, @agent_kind, @title, @brief, @status, @phase, @archived, @created_at, @updated_at)",
      ].join(" "),
    ),
    updateLaneStatus: db.prepare(
      "UPDATE workflow_lanes SET status = @status, phase = @phase, updated_at = @updated_at WHERE session_id = @session_id AND id = @id",
    ),
    archiveLane: db.prepare(
      "UPDATE workflow_lanes SET archived = 1, status = 'archived', phase = 'Archived', updated_at = @updated_at WHERE session_id = @session_id AND id = @id",
    ),
    insertEdge: db.prepare(
      "INSERT OR IGNORE INTO workflow_edges(id, session_id, source_lane_id, target_lane_id, created_at) VALUES (@id, @session_id, @source_lane_id, @target_lane_id, @created_at)",
    ),
    listEdges: db.prepare("SELECT * FROM workflow_edges WHERE session_id = ? ORDER BY created_at, id"),
    getSegment: db.prepare("SELECT * FROM workflow_segments WHERE session_id = ? AND id = ?"),
    getSegmentByRunId: db.prepare("SELECT * FROM workflow_segments WHERE run_id = ?"),
    listSegments: db.prepare("SELECT * FROM workflow_segments WHERE session_id = ? AND lane_id = ? ORDER BY started_at, id"),
    listRunningPlannerSegments: db.prepare(
      [
        "SELECT workflow_segments.* FROM workflow_segments",
        "JOIN workflow_lanes ON workflow_lanes.id = workflow_segments.lane_id",
        "WHERE workflow_segments.status = 'running' AND workflow_lanes.lane_kind = 'planner'",
        "ORDER BY workflow_segments.started_at, workflow_segments.id",
      ].join(" "),
    ),
    insertSegment: db.prepare(
      [
        "INSERT INTO workflow_segments(id, session_id, lane_id, parent_segment_id, run_id, agent_kind, transport, status, worktree_path, started_at, ended_at, exit_code, evidence_json, error_reason)",
        "VALUES (@id, @session_id, @lane_id, @parent_segment_id, @run_id, @agent_kind, @transport, @status, @worktree_path, @started_at, @ended_at, @exit_code, @evidence_json, @error_reason)",
      ].join(" "),
    ),
    updateSegmentEvidence: db.prepare(
      "UPDATE workflow_segments SET evidence_json = @evidence_json, exit_code = @exit_code, error_reason = @error_reason WHERE id = @id",
    ),
    finishSegment: db.prepare(
      "UPDATE workflow_segments SET status = @status, ended_at = @ended_at, exit_code = @exit_code, error_reason = @error_reason WHERE id = @id",
    ),
    insertSession: db.prepare(
      [
        "INSERT INTO workflow_sessions(id, project_id, hermes_session_id, planner_lane_id, title, goal, mode, execution_target, selected_branch, base_ref, created_at, updated_at)",
        "VALUES (@id, @project_id, @hermes_session_id, @planner_lane_id, @title, @goal, @mode, @execution_target, @selected_branch, @base_ref, @created_at, @updated_at)",
      ].join(" "),
    ),
    updateCurrentBranchTarget: db.prepare(
      "UPDATE workflow_sessions SET selected_branch = @selected_branch, updated_at = @updated_at WHERE id = @id",
    ),
    insertHermesSession: db.prepare(
      [
        "INSERT INTO hermes_sessions(id, workflow_session_id, transport, planner_profile, process_id, opaque_handle, status, started_at, last_seen_at, ended_at, recovery_reason, metadata_json)",
        "VALUES (@id, @workflow_session_id, @transport, @planner_profile, @process_id, @opaque_handle, @status, @started_at, @last_seen_at, @ended_at, @recovery_reason, @metadata_json)",
      ].join(" "),
    ),
  };
}

function evaluateGate(
  lanes: WorkflowLaneRecord[],
  segments: WorkflowSegmentRecord[],
  input: { laneKind: WorkflowLaneKind; dependencies: string[] },
): { allowed: true } | { allowed: false; reason: string } {
  const active = lanes.filter((lane) => !lane.archived);
  const completed = new Set(active.filter((lane) => lane.status === "completed").map((lane) => lane.id));
  if (input.laneKind === "analysis" || input.laneKind === "planning") {
    return { allowed: true };
  }
  if (input.laneKind === "coding" && !active.some((lane) => lane.laneKind === "planning" && lane.status === "completed")) {
    return { allowed: false, reason: "Coding lane is blocked until planning is completed." };
  }
  if (input.laneKind === "review") {
    const codingDeps = input.dependencies
      .map((id) => active.find((lane) => lane.id === id))
      .filter((lane): lane is WorkflowLaneRecord => lane?.laneKind === "coding");
    if (codingDeps.length === 0 || codingDeps.some((lane) => !completed.has(lane.id))) {
      return { allowed: false, reason: "Review lane is blocked until coding has trusted evidence." };
    }
    if (!codingDeps.every((lane) => laneHasTrustedEvidence(lane.id, segments))) {
      return { allowed: false, reason: "Review lane is blocked until coding has trusted evidence." };
    }
  }
  if (input.laneKind === "fix" && !active.some((lane) => lane.laneKind === "review" && lane.status === "failed")) {
    return { allowed: false, reason: "Fix lane is blocked until review reports blocking issues." };
  }
  if (input.laneKind === "validation" && !active.some((lane) => lane.laneKind === "review" && lane.status === "completed")) {
    return { allowed: false, reason: "Validation lane is blocked until review has no blocking issues." };
  }
  if (input.laneKind === "commit" && !active.some((lane) => lane.laneKind === "validation" && lane.status === "completed")) {
    return { allowed: false, reason: "Commit lane is blocked until candidate validation or manual approval." };
  }
  if (input.laneKind === "pull_request" && !active.some((lane) => lane.laneKind === "commit" && lane.status === "completed")) {
    return { allowed: false, reason: "Pull request lane is blocked until commit completes." };
  }
  if (input.laneKind === "merge") {
    if (!active.some((lane) => lane.laneKind === "review" && lane.status === "completed")) {
      return { allowed: false, reason: "Merge lane is blocked until review completes." };
    }
    if (!active.some((lane) => lane.laneKind === "pull_request" && lane.status === "completed")) {
      return { allowed: false, reason: "Merge lane is blocked until pull request state is trusted." };
    }
  }
  if (input.laneKind === "closeout" && !active.some((lane) => lane.laneKind === "merge" && lane.status === "completed")) {
    return { allowed: false, reason: "Closeout lane is blocked until merge is confirmed." };
  }
  return { allowed: true };
}

function repairGateDependencies(
  lanes: WorkflowLaneRecord[],
  segments: WorkflowSegmentRecord[],
  laneKind: WorkflowLaneKind,
  dependencies: string[],
): string[] {
  if (dependencies.length > 0) return dependencies;
  const active = lanes.filter((lane) => !lane.archived);
  if (laneKind === "coding") {
    return latestCompletedLane(active, "planning")?.id ? [latestCompletedLane(active, "planning")!.id] : dependencies;
  }
  if (laneKind === "review") {
    const codingLane = [...active]
      .reverse()
      .find((lane) => lane.laneKind === "coding" && lane.status === "completed" && laneHasTrustedEvidence(lane.id, segments));
    return codingLane ? [codingLane.id] : dependencies;
  }
  if (laneKind === "commit") {
    return latestCompletedLane(active, "validation")?.id ? [latestCompletedLane(active, "validation")!.id] : dependencies;
  }
  if (laneKind === "pull_request") {
    return latestCompletedLane(active, "commit")?.id ? [latestCompletedLane(active, "commit")!.id] : dependencies;
  }
  if (laneKind === "merge") {
    return latestCompletedLane(active, "pull_request")?.id ? [latestCompletedLane(active, "pull_request")!.id] : dependencies;
  }
  return dependencies;
}

function latestCompletedLane(lanes: WorkflowLaneRecord[], laneKind: WorkflowLaneKind): WorkflowLaneRecord | null {
  return [...lanes].reverse().find((lane) => lane.laneKind === laneKind && lane.status === "completed") ?? null;
}

function laneHasTrustedEvidence(laneId: string, segments: WorkflowSegmentRecord[]): boolean {
  return segments.some((segment) => segment.laneId === laneId && segment.status === "succeeded" && hasConcreteEvidence(segment.evidence ?? {}));
}

function hasConcreteEvidence(evidence: Record<string, unknown>): boolean {
  if (evidence.exitCode === 0 && (typeof evidence.changesetId === "string" || hasPassedCheck(evidence.checks))) return true;
  if (Array.isArray(evidence.artifacts) && evidence.artifacts.length > 0) return true;
  return hasPassedCheck(evidence.checks) || isPassedReview(evidence.review);
}

function hasPassedCheck(value: unknown): boolean {
  return Array.isArray(value) && value.some((item) => isRecord(item) && item.status === "passed");
}

function isPassedReview(value: unknown): boolean {
  return isRecord(value) && value.status === "passed";
}

function validateHermesTransport(input: CreateWorkflowSessionInput): void {
  if (input.transport === "hermes_live_chat" && !input.processId && !input.opaqueHandle) {
    throw new Error("hermes_live_chat requires a process id or live handle.");
  }
  if (input.transport === "hermes_session_resume" && !input.opaqueHandle) {
    throw new Error("hermes_session_resume requires an opaque handle.");
  }
  if (input.transport === "hermes_replay_recovery" && !input.recoveryReason) {
    throw new Error("hermes_replay_recovery requires a recovery reason.");
  }
}

function inferLaneKind(agent: AgentKind, title: string, brief: string): WorkflowLaneKind {
  const text = normalizeText(`${title} ${brief}`);
  if (/\b(merge|land)\b|合并/.test(text)) return "merge";
  if (/\b(pull request|pr)\b|拉取请求/.test(text)) return "pull_request";
  if (/\b(commit)\b|提交/.test(text)) return "commit";
  if (/\b(fix|repair)\b|修复/.test(text)) return "fix";
  if (/\b(review|verify|verification|validate|validation|audit|qa)\b|评审|验证|验收|复核/.test(text)) {
    return text.includes("validat") || /验证|验收/.test(text) ? "validation" : "review";
  }
  if (agent === "codex") return "coding";
  if (/\b(plan|planning|requirements|design)\b|规划|需求|设计/.test(text)) return "planning";
  if (/\b(analyze|analysis|inspect|investigate)\b|分析|核查/.test(text)) return "analysis";
  return "analysis";
}

function normalizeInitialLaneStatus(status: NodeStatus | undefined, laneKind: WorkflowLaneKind): WorkflowLaneStatus {
  if (status === "running") return laneKind === "review" ? "reviewing" : "running";
  if (status === "retrying") return "retrying";
  if (status === "failed") return "failed";
  return "pending";
}

function mapLaneStatusToNodeStatus(status: WorkflowLaneStatus): NodeStatus {
  if (status === "completed") return "completed";
  if (status === "failed") return "failed";
  if (status === "retrying") return "retrying";
  if (status === "running" || status === "reviewing" || status === "waiting_input") return "running";
  return "pending";
}

function phaseForLaneKind(kind: WorkflowLaneKind): string {
  if (kind === "planning" || kind === "planner") return "Planning";
  if (kind === "coding") return "Executing";
  if (kind === "review") return "Validating";
  return "Queued";
}

function phaseForLaneStatus(status: WorkflowLaneStatus): string {
  if (status === "completed") return "Completed";
  if (status === "failed") return "Failed";
  if (status === "retrying") return "Retrying";
  if (status === "running") return "Executing";
  if (status === "reviewing") return "Validating";
  if (status === "archived") return "Archived";
  return "Queued";
}

function runtimeForLaneStatus(status: WorkflowLaneStatus): NodeRuntimeState {
  const phase = phaseForLaneStatus(status) as NodeLifecyclePhase;
  return { phase, message: progressForLaneStatus(status), action: status };
}

function progressForLaneStatus(status: WorkflowLaneStatus): string {
  switch (status) {
    case "completed":
      return "Evidence ready";
    case "failed":
      return "Needs attention";
    case "retrying":
      return "Retrying";
    case "running":
    case "reviewing":
      return "Running";
    case "blocked":
      return "Blocked";
    default:
      return "Planned";
  }
}

function mapSession(row: SessionRow): WorkflowSessionRecord {
  return {
    id: row.id,
    projectId: row.project_id,
    hermesSessionId: row.hermes_session_id,
    plannerLaneId: row.planner_lane_id,
    title: row.title,
    goal: row.goal,
    mode: row.mode,
    target: normalizeSessionTarget({
      executionTarget: row.execution_target,
      selectedBranch: row.selected_branch,
      baseRef: row.base_ref ?? undefined,
    }),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function mapHermesSession(row: HermesSessionRow): HermesSessionRecord {
  return {
    id: row.id,
    workflowSessionId: row.workflow_session_id,
    transport: row.transport,
    plannerProfile: row.planner_profile,
    processId: row.process_id,
    opaqueHandle: row.opaque_handle,
    status: row.status,
    startedAt: row.started_at,
    lastSeenAt: row.last_seen_at,
    endedAt: row.ended_at,
    recoveryReason: row.recovery_reason,
    metadata: parseJson(row.metadata_json),
  };
}

function mapEvent(row: EventRow): WorkflowEventRecord {
  return {
    id: row.id,
    sessionId: row.session_id,
    seq: row.seq,
    kind: row.kind,
    source: row.source,
    laneId: row.lane_id,
    segmentId: row.segment_id,
    causationId: row.causation_id,
    correlationId: row.correlation_id,
    idempotencyKey: row.idempotency_key,
    payload: parseJson(row.payload_json),
    createdAt: row.created_at,
  };
}

function mapWorkflowRecordToFlowEvent(event: WorkflowEventRecord): FlowEvent {
  return {
    id: event.id,
    sessionId: event.sessionId,
    seq: event.seq,
    kind: event.kind as FlowEventKind,
    source: event.source,
    payload: event.payload,
    createdAt: event.createdAt,
    idempotencyKey: event.idempotencyKey,
  };
}

function seedFlowUserInputEvent(sessionId: string): FlowEvent {
  return {
    id: `${sessionId}:flow-seed:user-input`,
    sessionId,
    seq: 0,
    kind: "workflow.user_input",
    source: "workflow_store",
    payload: { sessionId },
    createdAt: new Date(0).toISOString(),
    idempotencyKey: `flow:${sessionId}:seed:user-input`,
  };
}

function makeRejectedFlowIntentEvent(
  projection: FlowProjection,
  intentId: string,
  reason: string,
  now: string,
): FlowEvent {
  const seq = projection.events.length + 1;
  return {
    id: `${projection.sessionId}:flow-event:${String(seq).padStart(8, "0")}`,
    sessionId: projection.sessionId,
    seq,
    kind: "workflow.intent.rejected",
    source: "workflow-kernel",
    payload: { intentId, reason },
    createdAt: now,
    idempotencyKey: `intent:${intentId}:rejected`,
  };
}

function workflowIntentSessionId(intent: unknown): string | null {
  return isRecord(intent) && typeof intent.sessionId === "string" ? intent.sessionId : null;
}

function workflowIntentId(intent: unknown): string {
  return isRecord(intent) && typeof intent.intentId === "string" ? intent.intentId : "unknown-intent";
}

function isFlowEventKind(kind: WorkflowEventKind): kind is FlowEventKind {
  return kind.startsWith("workflow.") && !isWorkflowAuditEventKind(kind);
}

function isWorkflowAuditEventKind(kind: WorkflowEventKind): kind is WorkflowAuditEventKind {
  return kind === "workflow.run.recovery_failed" ||
    kind === "workflow.run.start_reconciliation_failed" ||
    kind === "workflow.node.checkpoint_failed";
}

function mapLane(row: LaneRow): WorkflowLaneRecord {
  return {
    id: row.id,
    sessionId: row.session_id,
    nodeId: row.node_id,
    semanticKey: row.semantic_key,
    laneKind: row.lane_kind,
    agentKind: row.agent_kind,
    title: row.title,
    brief: row.brief,
    status: row.status,
    phase: row.phase,
    archived: row.archived === 1,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function mapSegment(row: SegmentRow): WorkflowSegmentRecord {
  return {
    id: row.id,
    sessionId: row.session_id,
    laneId: row.lane_id,
    segmentId: row.id,
    parentSegmentId: row.parent_segment_id,
    runId: row.run_id,
    agentKind: row.agent_kind,
    transport: row.transport,
    status: row.status,
    worktreePath: row.worktree_path,
    startedAt: row.started_at,
    endedAt: row.ended_at,
    exitCode: row.exit_code,
    evidence: row.evidence_json ? parseJson(row.evidence_json) : null,
    errorReason: row.error_reason,
  };
}

function requireText(value: unknown, field: string): string {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new Error(`Workflow card ${field} must be a non-empty string.`);
  }
  return value.trim();
}

const MAX_CANVAS_COORDINATE = 1_000_000;

function requireIdentifier(value: unknown, field: string): string {
  if (typeof value !== "string" || value.trim().length === 0 || value.trim().length > 200) {
    throw new Error(`Workflow canvas ${field} must be a non-empty string of at most 200 characters.`);
  }
  return value.trim();
}

function requireCanvasPosition(value: unknown): CanvasNode["position"] {
  if (!isRecord(value) || !Number.isFinite(value.x) || !Number.isFinite(value.y)) {
    throw new Error("Workflow canvas coordinates must be finite numbers.");
  }
  const x = Number(value.x);
  const y = Number(value.y);
  if (Math.abs(x) > MAX_CANVAS_COORDINATE || Math.abs(y) > MAX_CANVAS_COORDINATE) {
    throw new Error(`Workflow canvas coordinates must be within ${MAX_CANVAS_COORDINATE}.`);
  }
  return { x, y };
}

function canvasPositionFromPayload(payload: Record<string, unknown>): CanvasNode["position"] | null {
  try {
    return requireCanvasPosition(payload.position);
  } catch {
    return null;
  }
}

function latestCanvasNodePositions(events: WorkflowEventRecord[]): Map<string, CanvasNode["position"]> {
  const positions = new Map<string, CanvasNode["position"]>();
  for (const event of events) {
    if (event.kind !== "canvas_node_position_updated") continue;
    if (typeof event.payload.nodeId !== "string" || event.payload.nodeId.length === 0) continue;
    const position = canvasPositionFromPayload(event.payload);
    if (position) positions.set(event.payload.nodeId, position);
  }
  return positions;
}

function optionalText(value: unknown): string | null {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : null;
}

function requirePayloadText(value: Record<string, unknown>, field: string): string {
  return requireText(value[field], field);
}

function requireAgent(value: unknown): AgentKind {
  if (value === "hermes" || value === "codex" || value === "gemini" || value === "claude-code" || value === "openclaw") {
    return value;
  }
  throw new Error("Workflow card agent is not supported.");
}

function requireWorkflowReassignmentAgent(value: unknown): AgentKind {
  if (value === "hermes" || value === "codex" || value === "gemini" || value === "claude-code" || value === "openclaw") {
    return value;
  }
  throw new Error("Workflow reassignment agentKind is not supported.");
}

function requireOptionalAgent(value: unknown): AgentKind | null {
  try {
    return requireWorkflowReassignmentAgent(value);
  } catch {
    return null;
  }
}

function requireWorkflowIdentifier(value: unknown, field: string): string {
  const identifier = typeof value === "string" ? value.trim() : "";
  if (!identifier || !/^[A-Za-z0-9._:-]+$/.test(identifier)) {
    throw new Error(`Workflow reassignment ${field} is invalid.`);
  }
  return identifier;
}

function cleanId(value: unknown): string | null {
  return typeof value === "string" && /^[A-Za-z0-9._:-]+$/.test(value.trim()) ? value.trim() : null;
}

function uniqueIds(values: string[]): string[] {
  return [...new Set(values.map((value) => cleanId(value)).filter((value): value is string => Boolean(value)))];
}

function normalizeTaskKey(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const normalized = value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9._:\-\u4e00-\u9fff]+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "");
  return normalized || undefined;
}

function semanticKeyForCard(agent: AgentKind, title: string, brief: string): string {
  return [`agent:${agent}`, `kind:${inferLaneKind(agent, title, brief)}`, `title:${normalizeText(title)}`, `brief:${normalizeText(brief)}`].join("|");
}

function normalizeText(value: string): string {
  return value.trim().toLowerCase().replace(/[^a-z0-9\u4e00-\u9fff]+/g, " ").replace(/\s+/g, " ").trim();
}

function nextNodeId(lanes: WorkflowLaneRecord[]): string {
  const used = new Set(lanes.map((lane) => lane.nodeId));
  for (let index = lanes.length + 1; ; index += 1) {
    const id = `node-${index}`;
    if (!used.has(id)) return id;
  }
}

function stableJson(value: unknown): string {
  return JSON.stringify(sortJson(value));
}

function sortJson(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortJson);
  if (!isRecord(value)) return value;
  return Object.fromEntries(Object.keys(value).sort().map((key) => [key, sortJson(value[key])]));
}

function parseJson(value: string): Record<string, unknown> {
  const parsed = JSON.parse(value) as unknown;
  return isRecord(parsed) ? parsed : {};
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

function agentLabel(agent: AgentKind): string {
  switch (agent) {
    case "hermes":
      return "Hermes";
    case "codex":
      return "Codex";
    case "agy":
      return "Antigravity";
    case "gemini":
      return "Gemini";
    case "claude-code":
      return "Claude Code";
    case "openclaw":
      return "OpenClaw";
  }
}
