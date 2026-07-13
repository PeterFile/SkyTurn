import type {
  WorkflowNodeCheckpoint,
  WorkflowRemoteSideEffectRef,
  WorkflowRollbackEligibility,
} from "@skyturn/project-core";
import {
  evaluateRollbackEligibility,
  reduceWorkflowEvents,
  type FlowEvent,
  type FlowProjection,
} from "@skyturn/workflow-kernel";

export type SelectedNodeComposerMode =
  | "global"
  | "repair-selected-node-from-after-checkpoint"
  | "variant-from-before-checkpoint"
  | "rollback-selected-node-and-downstream";

export interface NodeRollbackPayload {
  sessionId: string;
  nodeId: string;
  laneId: string;
  checkpointId: string;
  requestId?: string;
  now?: string;
}

export interface NodeCheckpointSuccessorPayload {
  sessionId: string;
  nodeId: string;
  laneId: string;
  checkpointId: string;
  intentId?: string;
  successorLaneId: string;
  successorSemanticKey: string;
  title?: string;
  now?: string;
}

export interface SelectedNodeCheckpointDisplay {
  hasBefore: boolean;
  hasAfter: boolean;
  beforeCheckpointId: string | null;
  afterCheckpointId: string | null;
  beforeCommitSha: string | null;
  afterCommitSha: string | null;
  beforeSource: string | null;
  afterSource: string | null;
}

export interface SelectedNodeActionState {
  composerMode: SelectedNodeComposerMode;
  canRollback: boolean;
  blockedByRemoteSideEffect: boolean;
  needsBackendCheck: boolean;
  canCreateRepair: boolean;
  canCreateVariant: boolean;
  checkpoints: SelectedNodeCheckpointDisplay;
  remoteSideEffects: WorkflowRemoteSideEffectRef[];
  blockedReasons: string[];
  rollbackPayload: NodeRollbackPayload | null;
  repairPayload: NodeCheckpointSuccessorPayload | null;
  variantPayload: NodeCheckpointSuccessorPayload | null;
  rollbackEligibility: WorkflowRollbackEligibility | null;
}

export interface BuildSelectedNodeActionStateInput {
  sessionId: string;
  selectedNode: unknown;
  projection: unknown;
  composerMode?: SelectedNodeComposerMode | null;
  backendEligibility?: unknown;
  now?: string;
}

export interface HydrateSelectedNodeActionStateInput extends Omit<BuildSelectedNodeActionStateInput, "projection"> {
  events: unknown;
}

const knownFlowEventKinds = new Set<string>([
  "workflow.user_input",
  "workflow.profile",
  "workflow.intent.accepted",
  "workflow.intent.rejected",
  "workflow.lane.declared",
  "workflow.edge.declared",
  "workflow.segment.started",
  "workflow.segment.output_delta",
  "workflow.segment.finished",
  "workflow.evidence.recorded",
  "workflow.changeset.evidence_recorded",
  "workflow.node.checkpoint_recorded",
  "workflow.node.rollback_requested",
  "workflow.node.rollback_applied",
  "workflow.node.rollback_rejected",
  "workflow.node.repair_requested",
  "workflow.node.variant_requested",
  "workflow.node.fork_requested",
  "workflow.join.completed",
  "workflow.replan.requested",
  "workflow.user_decision.requested",
  "workflow.user_decision.answered",
  "workflow.commit.created",
  "workflow.remote_side_effect.requested",
  "workflow.remote_side_effect.completed",
  "workflow.delivery.pushed",
  "workflow.pull_request.created",
  "workflow.pull_request.checks_recorded",
  "workflow.pull_request.merged",
  "workflow.delivery.main_synced",
  "workflow.worktree.create_requested",
  "workflow.worktree.created",
  "workflow.worktree.create_failed",
  "workflow.worktree.clean_requested",
  "workflow.worktree.cleaned",
  "workflow.worktree.clean_failed",
  "workflow.variant.adopt_requested",
  "workflow.variant.adopted",
  "workflow.variant.adopt_failed",
  "workflow.variant.rejected",
]);

export function buildSelectedNodeActionState(input: BuildSelectedNodeActionStateInput): SelectedNodeActionState {
  const sessionId = text(input.sessionId);
  const nodeId = nodeIdFromSelectedNode(input.selectedNode);
  const projection = sessionId && isFlowProjection(input.projection, sessionId) ? input.projection : null;

  if (!sessionId || !nodeId || !projection) {
    return failClosed("Selected node is stale or malformed.");
  }

  const laneId = resolveSelectedLaneId(projection, nodeId);
  if (!laneId) return failClosed("Selected node is stale or malformed.");

  const beforeCheckpoint = latestCheckpointForLane(projection, sessionId, laneId, nodeId, "before");
  const afterCheckpoint = latestCheckpointForLane(projection, sessionId, laneId, nodeId, "after");
  const checkpoints = checkpointDisplay(beforeCheckpoint, afterCheckpoint);
  const backend = normalizeBackendEligibility(input.backendEligibility);
  const blockedReasons: string[] = [];
  const rollbackEligibility = beforeCheckpoint
    ? evaluateRollbackEligibility(projection, laneId, { checkpointId: beforeCheckpoint.id, targetNodeId: nodeId })
    : null;
  const remoteSideEffects = uniqueRemoteSideEffects([
    ...(rollbackEligibility?.blockingRemoteSideEffects ?? []),
    ...backend.blockingRemoteSideEffects,
  ]);
  const blockedByRemoteSideEffect = remoteSideEffects.length > 0;
  const needsBackendCheck = backend.needsBackendCheck;

  if (!beforeCheckpoint) blockedReasons.push("Rollback requires an existing before checkpoint.");
  if (rollbackEligibility && !rollbackEligibility.eligible && rollbackEligibility.reason !== "Rollback eligible.") {
    blockedReasons.push(rollbackEligibility.reason ?? "Rollback is not eligible.");
  }
  if (backend.reason) blockedReasons.push(backend.reason);

  const canRollback = !!rollbackEligibility?.eligible && !needsBackendCheck && !blockedByRemoteSideEffect;
  const canCreateRepair = !!afterCheckpoint;
  const canCreateVariant = !!beforeCheckpoint && beforeCheckpoint.worktreeState !== "dirty";
  const rollbackPayload = canRollback && beforeCheckpoint
    ? withOptionalTime({
        sessionId,
        nodeId,
        laneId,
        checkpointId: beforeCheckpoint.id,
      }, input.now)
    : null;
  const repairPayload = canCreateRepair && afterCheckpoint
    ? successorPayload({
        kind: "repair",
        sessionId,
        nodeId,
        laneId,
        checkpointId: afterCheckpoint.id,
        selectedNode: input.selectedNode,
        now: input.now,
      })
    : null;
  const variantPayload = canCreateVariant && beforeCheckpoint
    ? successorPayload({
        kind: "variant",
        sessionId,
        nodeId,
        laneId,
        checkpointId: beforeCheckpoint.id,
        selectedNode: input.selectedNode,
        now: input.now,
      })
    : null;

  return {
    composerMode: resolveComposerMode(input.composerMode, { canRollback, canCreateRepair, canCreateVariant }),
    canRollback,
    blockedByRemoteSideEffect,
    needsBackendCheck,
    canCreateRepair,
    canCreateVariant,
    checkpoints,
    remoteSideEffects,
    blockedReasons: uniqueStrings(blockedReasons),
    rollbackPayload,
    repairPayload,
    variantPayload,
    rollbackEligibility,
  };
}

export function hydrateSelectedNodeActionStateFromEvents(
  input: HydrateSelectedNodeActionStateInput,
): SelectedNodeActionState {
  const sessionId = text(input.sessionId);
  if (!sessionId) return failClosed("Workflow events are stale or malformed.");
  const events = normalizeHydratableFlowEvents(input.events, sessionId);
  if (!events) return failClosed("Workflow events are stale or malformed.");
  try {
    return buildSelectedNodeActionState({
      ...input,
      projection: reduceWorkflowEvents(events),
    });
  } catch {
    return failClosed("Workflow events are stale or malformed.");
  }
}

function failClosed(reason: string): SelectedNodeActionState {
  return {
    composerMode: "global",
    canRollback: false,
    blockedByRemoteSideEffect: false,
    needsBackendCheck: false,
    canCreateRepair: false,
    canCreateVariant: false,
    checkpoints: {
      hasBefore: false,
      hasAfter: false,
      beforeCheckpointId: null,
      afterCheckpointId: null,
      beforeCommitSha: null,
      afterCommitSha: null,
      beforeSource: null,
      afterSource: null,
    },
    remoteSideEffects: [],
    blockedReasons: [reason],
    rollbackPayload: null,
    repairPayload: null,
    variantPayload: null,
    rollbackEligibility: null,
  };
}

function resolveComposerMode(
  requested: SelectedNodeComposerMode | null | undefined,
  state: Pick<SelectedNodeActionState, "canRollback" | "canCreateRepair" | "canCreateVariant">,
): SelectedNodeComposerMode {
  if (requested === "repair-selected-node-from-after-checkpoint" && state.canCreateRepair) return requested;
  if (requested === "variant-from-before-checkpoint" && state.canCreateVariant) return requested;
  if (requested === "rollback-selected-node-and-downstream" && state.canRollback) return requested;
  return "global";
}

function checkpointDisplay(
  beforeCheckpoint: WorkflowNodeCheckpoint | null,
  afterCheckpoint: WorkflowNodeCheckpoint | null,
): SelectedNodeCheckpointDisplay {
  return {
    hasBefore: !!beforeCheckpoint,
    hasAfter: !!afterCheckpoint,
    beforeCheckpointId: beforeCheckpoint?.id ?? null,
    afterCheckpointId: afterCheckpoint?.id ?? null,
    beforeCommitSha: beforeCheckpoint?.headCommit?.substring(0, 7) ?? null,
    afterCommitSha: afterCheckpoint?.headCommit?.substring(0, 7) ?? null,
    beforeSource: beforeCheckpoint?.source ?? null,
    afterSource: afterCheckpoint?.source ?? null,
  };
}

function latestCheckpointForLane(
  projection: FlowProjection,
  sessionId: string,
  laneId: string,
  nodeId: string,
  phase: WorkflowNodeCheckpoint["phase"],
): WorkflowNodeCheckpoint | null {
  return [...projection.checkpoints].reverse().find((checkpoint) => {
    if (checkpoint.sessionId !== sessionId) return false;
    if (checkpoint.phase !== phase) return false;
    if (!checkpointPhaseIsExplicit(projection, checkpoint)) return false;
    if (checkpoint.laneId !== laneId) return false;
    return checkpoint.nodeId === nodeId || checkpoint.nodeId === laneId;
  }) ?? null;
}

function checkpointPhaseIsExplicit(projection: FlowProjection, checkpoint: WorkflowNodeCheckpoint): boolean {
  if (checkpoint.authority?.phaseExplicit === true) return true;
  return projection.checkpointAuthorityFields[checkpoint.id]?.phase === true;
}

function resolveSelectedLaneId(projection: FlowProjection, nodeId: string): string | null {
  const projectionNode = projection.projectionNodes.find((item) => item.id === nodeId || item.laneId === nodeId);
  const laneId = text(projectionNode?.laneId) ?? (projection.lanes.some((lane) => lane.id === nodeId) ? nodeId : null);
  if (!laneId) return null;
  return projection.lanes.some((lane) => lane.id === laneId) ? laneId : null;
}

function nodeIdFromSelectedNode(selectedNode: unknown): string | null {
  if (!isRecord(selectedNode)) return null;
  return text(selectedNode.id);
}

function successorPayload(input: {
  kind: "repair" | "variant";
  sessionId: string;
  nodeId: string;
  laneId: string;
  checkpointId: string;
  selectedNode: unknown;
  now?: string;
}): NodeCheckpointSuccessorPayload {
  const successorLaneId = `${input.laneId}-${input.kind}`;
  const payload: NodeCheckpointSuccessorPayload = {
    sessionId: input.sessionId,
    nodeId: input.nodeId,
    laneId: input.laneId,
    checkpointId: input.checkpointId,
    successorLaneId,
    successorSemanticKey: `${input.kind}:${input.laneId}:manual`,
  };
  const title = selectedNodeTitle(input.selectedNode);
  return withOptionalTime({
    ...payload,
    ...(title ? { title: `${input.kind === "repair" ? "Repair" : "Variant"} ${title}` } : {}),
  }, input.now);
}

function withOptionalTime<T extends object>(payload: T, now: unknown): T & { now?: string } {
  return {
    ...payload,
    ...(text(now) ? { now: text(now)! } : {}),
  };
}

function selectedNodeTitle(selectedNode: unknown): string | null {
  if (!isRecord(selectedNode)) return null;
  return text(selectedNode.title);
}

function normalizeBackendEligibility(value: unknown): {
  needsBackendCheck: boolean;
  reason: string | null;
  blockingRemoteSideEffects: WorkflowRemoteSideEffectRef[];
} {
  if (!isRecord(value)) return { needsBackendCheck: false, reason: null, blockingRemoteSideEffects: [] };
  const source = isRecord(value.eligibility) ? value.eligibility : value;
  const blockedReasonObject = isRecord(value.blockedReason) ? value.blockedReason : null;
  const sourceRemoteSideEffects = normalizeRemoteSideEffects(source.blockingRemoteSideEffects);
  const blockedReasonRemoteSideEffects = normalizeRemoteSideEffects(blockedReasonObject?.remoteSideEffects);
  const malformedRemoteSideEffects = sourceRemoteSideEffects.malformed || blockedReasonRemoteSideEffects.malformed;
  const blockingRemoteSideEffects = uniqueRemoteSideEffects([
    ...sourceRemoteSideEffects.values,
    ...blockedReasonRemoteSideEffects.values,
  ]);
  const manualRepairRequired = value.manualRepairRequired === true;
  const localRollbackSafe = source.localRollbackSafe;
  const eligible = source.eligible;
  const blockedReason = blockedReasonObject ? text(blockedReasonObject.message) : text(value.blockedReason);
  const reason = malformedRemoteSideEffects ? "Backend rollback eligibility is stale or malformed." : blockedReason ?? text(source.reason);
  const needsBackendCheck =
    malformedRemoteSideEffects ||
    manualRepairRequired ||
    localRollbackSafe === false ||
    (eligible === false && blockingRemoteSideEffects.length === 0);
  return { needsBackendCheck, reason, blockingRemoteSideEffects };
}

function normalizeRemoteSideEffects(value: unknown): {
  values: WorkflowRemoteSideEffectRef[];
  malformed: boolean;
} {
  if (value === undefined) return { values: [], malformed: false };
  if (!Array.isArray(value)) return { values: [], malformed: true };
  const values: WorkflowRemoteSideEffectRef[] = [];
  let malformed = false;
  for (const item of value) {
    const normalized = normalizeRemoteSideEffect(item);
    if (!normalized) {
      malformed = true;
      continue;
    }
    values.push(normalized);
  }
  return { values, malformed };
}

function normalizeRemoteSideEffect(value: unknown): WorkflowRemoteSideEffectRef | null {
  if (!isRecord(value)) return null;
  const eventKind = remoteSideEffectEventKind(value.eventKind);
  const eventId = text(value.eventId);
  if (!eventKind || !eventId) return null;
  const laneId = text(value.laneId);
  const affectedLaneIds = stringArray(value.affectedLaneIds);
  const createdAt = text(value.createdAt);
  if (!laneId && affectedLaneIds.length === 0 && value.sessionWide !== true) return null;
  return {
    eventKind,
    eventId,
    ...(laneId ? { laneId } : {}),
    ...(affectedLaneIds.length > 0 ? { affectedLaneIds } : {}),
    ...(value.sessionWide === true ? { sessionWide: true } : {}),
    ...(createdAt ? { createdAt } : {}),
  };
}

function remoteSideEffectEventKind(value: unknown): WorkflowRemoteSideEffectRef["eventKind"] | null {
  if (
    value === "workflow.delivery.pushed" ||
    value === "workflow.pull_request.created" ||
    value === "workflow.pull_request.merged" ||
    value === "workflow.delivery.main_synced"
  ) {
    return value;
  }
  return null;
}

function uniqueRemoteSideEffects(values: WorkflowRemoteSideEffectRef[]): WorkflowRemoteSideEffectRef[] {
  const seen = new Set<string>();
  const result: WorkflowRemoteSideEffectRef[] = [];
  for (const value of values) {
    const key = `${value.eventKind}:${value.eventId}:${value.laneId ?? ""}`;
    if (seen.has(key)) continue;
    seen.add(key);
    result.push(value);
  }
  return result;
}

function isFlowProjection(value: unknown, expectedSessionId: string): value is FlowProjection {
  if (!isRecord(value)) return false;
  const sessionId = text(value.sessionId);
  if (sessionId !== expectedSessionId) return false;
  if (
    !Array.isArray(value.events) ||
    !Array.isArray(value.lanes) ||
    !Array.isArray(value.edges) ||
    !Array.isArray(value.projectionNodes) ||
    !Array.isArray(value.checkpoints) ||
    !Array.isArray(value.rollbackIntents)
  ) {
    return false;
  }
  return (
    isRecord(value.checkpointAuthorityFields) &&
    value.lanes.every(isLaneLike) &&
    value.edges.every(isEdgeLike) &&
    value.projectionNodes.every(isProjectionNodeLike) &&
    value.checkpoints.every((checkpoint) => isCheckpointLike(checkpoint, sessionId)) &&
    value.rollbackIntents.every((intent) => isRollbackIntentLike(intent, sessionId)) &&
    normalizeHydratableFlowEvents(value.events, expectedSessionId) !== null
  );
}

function isLaneLike(value: unknown): value is FlowProjection["lanes"][number] {
  return isRecord(value) && text(value.id) !== null;
}

function isEdgeLike(value: unknown): value is FlowProjection["edges"][number] {
  return isRecord(value) && text(value.sourceLaneId) !== null && text(value.targetLaneId) !== null;
}

function isProjectionNodeLike(value: unknown): value is FlowProjection["projectionNodes"][number] {
  return isRecord(value) && text(value.id) !== null;
}

function isCheckpointLike(value: unknown, projectionSessionId: string): value is WorkflowNodeCheckpoint {
  return (
    isRecord(value) &&
    text(value.id) !== null &&
    text(value.sessionId) === projectionSessionId &&
    text(value.nodeId) !== null &&
    text(value.laneId) !== null &&
    (value.phase === "before" || value.phase === "after") &&
    (value.executionTarget === "current_branch" || value.executionTarget === "new_worktree") &&
    text(value.createdAt) !== null &&
    isCheckpointSource(value.source) &&
    Array.isArray(value.evidenceRefs) &&
    value.evidenceRefs.every(isCheckpointEvidenceRef)
  );
}

function isRollbackIntentLike(value: unknown, projectionSessionId: string): value is FlowProjection["rollbackIntents"][number] {
  return (
    isRecord(value) &&
    value.kind === "rollback" &&
    (value.status === "requested" || value.status === "applied" || value.status === "rejected") &&
    text(value.intentId) !== null &&
    text(value.sessionId) === projectionSessionId &&
    text(value.createdAt) !== null &&
    isOptionalText(value.laneId) &&
    isOptionalText(value.nodeId) &&
    isOptionalText(value.checkpointId) &&
    isOptionalBoolean(value.localRollbackSafe)
  );
}

function isFlowEvent(value: unknown): value is FlowEvent {
  return (
    isRecord(value) &&
    text(value.id) !== null &&
    text(value.sessionId) !== null &&
    typeof value.seq === "number" &&
    text(value.kind) !== null &&
    text(value.source) !== null &&
    isRecord(value.payload) &&
    text(value.createdAt) !== null
  );
}

function normalizeHydratableFlowEvents(events: unknown, expectedSessionId: string): FlowEvent[] | null {
  if (!Array.isArray(events)) return null;
  if (!events.every(isHydratableFlowEventShape)) return null;
  if (events.some((event) => event.sessionId !== expectedSessionId)) return null;
  return flowEventPayloadsAreSafe(events) ? [...events] : null;
}

function isHydratableFlowEventShape(value: unknown): value is FlowEvent {
  return isFlowEvent(value) && knownFlowEventKinds.has(value.kind);
}

interface TrackedRemoteSideEffectRequest {
  eventKind: WorkflowRemoteSideEffectRef["eventKind"];
  laneIds: string[];
  sessionWide: boolean;
}

interface ConcreteRemoteSideEffectEvent {
  eventKind: WorkflowRemoteSideEffectRef["eventKind"];
  laneIds: string[];
  sessionWide: boolean;
}

function flowEventPayloadsAreSafe(events: readonly FlowEvent[]): boolean {
  const remoteSideEffectRequests = new Map<string, TrackedRemoteSideEffectRequest>();
  const concreteRemoteSideEffects = collectConcreteRemoteSideEffectEvents(events);
  for (const event of events) {
    if (!flowEventPayloadIsSafe(event, remoteSideEffectRequests, concreteRemoteSideEffects)) return false;
    if (event.kind === "workflow.remote_side_effect.requested") {
      const request = trackedRemoteSideEffectRequest(event.payload);
      if (!request) return false;
      for (const requestId of remoteSideEffectIdentityIds(event.payload)) {
        remoteSideEffectRequests.set(requestId, request);
      }
    }
  }
  return true;
}

function flowEventPayloadIsSafe(
  event: FlowEvent,
  remoteSideEffectRequests: ReadonlyMap<string, TrackedRemoteSideEffectRequest>,
  concreteRemoteSideEffects: readonly ConcreteRemoteSideEffectEvent[],
): boolean {
  switch (event.kind) {
    case "workflow.lane.declared":
      return isValidLaneDeclaredPayload(event.payload);
    case "workflow.edge.declared":
      return isValidEdgeDeclaredPayload(event.payload);
    case "workflow.node.checkpoint_recorded":
      return isValidCheckpointRecordedPayload(event.payload, event.sessionId);
    case "workflow.node.rollback_requested":
    case "workflow.node.rollback_applied":
    case "workflow.node.rollback_rejected":
      return isValidRollbackEventPayload(event.kind, event.payload);
    case "workflow.node.repair_requested":
    case "workflow.node.variant_requested":
    case "workflow.node.fork_requested":
      return isValidCheckpointSuccessorPayload(event.payload);
    case "workflow.remote_side_effect.requested":
      return isValidRemoteSideEffectRequestPayload(event.payload);
    case "workflow.remote_side_effect.completed":
      return isValidRemoteSideEffectCompletionPayload(
        event.payload,
        remoteSideEffectRequests,
        concreteRemoteSideEffects,
      );
    case "workflow.delivery.pushed":
      return isValidDeliveryPushedPayload(event.payload);
    case "workflow.pull_request.created":
      return isValidPullRequestCreatedPayload(event.payload);
    case "workflow.pull_request.merged":
      return isValidPullRequestMergedPayload(event.payload);
    case "workflow.delivery.main_synced":
      return isValidMainSyncedPayload(event.payload);
    default:
      return true;
  }
}

function isValidLaneDeclaredPayload(payload: Record<string, unknown>): boolean {
  return isRecord(payload.lane) && text(payload.lane.id) !== null;
}

function isValidEdgeDeclaredPayload(payload: Record<string, unknown>): boolean {
  return (
    isRecord(payload.edge) &&
    text(payload.edge.sourceLaneId) !== null &&
    text(payload.edge.targetLaneId) !== null
  );
}

function isValidCheckpointRecordedPayload(payload: Record<string, unknown>, eventSessionId: string): boolean {
  if (!isRecord(payload.checkpoint)) return false;
  const checkpoint = payload.checkpoint;
  return (
    text(checkpoint.id) !== null &&
    text(checkpoint.sessionId) === eventSessionId &&
    text(checkpoint.nodeId) !== null &&
    text(checkpoint.laneId) !== null &&
    (checkpoint.phase === "before" || checkpoint.phase === "after") &&
    (checkpoint.executionTarget === "current_branch" || checkpoint.executionTarget === "new_worktree") &&
    text(checkpoint.createdAt) !== null &&
    isCheckpointSource(checkpoint.source) &&
    Array.isArray(checkpoint.evidenceRefs) &&
    checkpoint.evidenceRefs.every(isCheckpointEvidenceRef)
  );
}

function isValidRollbackEventPayload(kind: FlowEvent["kind"], payload: Record<string, unknown>): boolean {
  const hasIdentity = kind === "workflow.node.rollback_requested"
    ? text(payload.requestId) !== null
    : text(payload.requestId) !== null || text(payload.intentId) !== null;
  return hasIdentity && text(payload.laneId) !== null && text(payload.checkpointId) !== null;
}

function isValidCheckpointSuccessorPayload(payload: Record<string, unknown>): boolean {
  return (
    (text(payload.intentId) !== null || text(payload.requestId) !== null) &&
    text(payload.nodeId) !== null &&
    text(payload.laneId) !== null &&
    text(payload.checkpointId) !== null &&
    (text(payload.successorLaneId) !== null || text(payload.successorSemanticKey) !== null)
  );
}

function isValidRemoteSideEffectRequestPayload(payload: Record<string, unknown>): boolean {
  return (
    text(payload.operationId) !== null &&
    remoteSideEffectEventKind(payload.eventKind) !== null &&
    hasRemoteSideEffectScope(payload)
  );
}

function isValidRemoteSideEffectCompletionPayload(
  payload: Record<string, unknown>,
  remoteSideEffectRequests: ReadonlyMap<string, TrackedRemoteSideEffectRequest>,
  concreteRemoteSideEffects: readonly ConcreteRemoteSideEffectEvent[],
): boolean {
  const requestIds = remoteSideEffectIdentityIds(payload);
  if (requestIds.length === 0) return false;
  if (payload.status !== "succeeded" && payload.status !== "failed") return false;
  const request = matchingRemoteSideEffectRequest(requestIds, remoteSideEffectRequests);
  const completionEventKind = payload.eventKind === undefined ? null : remoteSideEffectEventKind(payload.eventKind);
  if (payload.eventKind !== undefined && !completionEventKind) return false;
  if (request && completionEventKind && completionEventKind !== request.eventKind) return false;
  if (payload.status === "succeeded") {
    if (!request) return false;
    return concreteRemoteSideEffects.some((event) => concreteRemoteSideEffectMatchesRequest(event, request));
  }
  return (
    hasRemoteSideEffectScope(payload) ||
    !!request
  );
}

function collectConcreteRemoteSideEffectEvents(events: readonly FlowEvent[]): ConcreteRemoteSideEffectEvent[] {
  const concreteEvents: ConcreteRemoteSideEffectEvent[] = [];
  for (const event of events) {
    const eventKind = remoteSideEffectEventKind(event.kind);
    if (!eventKind || !isValidConcreteRemoteSideEffectPayload(eventKind, event.payload)) continue;
    const laneIds = remoteSideEffectEventLaneIds(event.payload);
    concreteEvents.push({
      eventKind,
      laneIds,
      sessionWide: remoteSideEffectEventIsSessionWide(event.payload, laneIds),
    });
  }
  return concreteEvents;
}

function isValidConcreteRemoteSideEffectPayload(
  eventKind: WorkflowRemoteSideEffectRef["eventKind"],
  payload: Record<string, unknown>,
): boolean {
  switch (eventKind) {
    case "workflow.delivery.pushed":
      return isValidDeliveryPushedPayload(payload);
    case "workflow.pull_request.created":
      return isValidPullRequestCreatedPayload(payload);
    case "workflow.pull_request.merged":
      return isValidPullRequestMergedPayload(payload);
    case "workflow.delivery.main_synced":
      return isValidMainSyncedPayload(payload);
  }
}

function trackedRemoteSideEffectRequest(payload: Record<string, unknown>): TrackedRemoteSideEffectRequest | null {
  const eventKind = remoteSideEffectEventKind(payload.eventKind);
  if (!eventKind || !hasRemoteSideEffectScope(payload)) return null;
  return {
    eventKind,
    laneIds: remoteSideEffectPayloadLaneIds(payload),
    sessionWide: payload.sessionWide === true,
  };
}

function matchingRemoteSideEffectRequest(
  requestIds: readonly string[],
  remoteSideEffectRequests: ReadonlyMap<string, TrackedRemoteSideEffectRequest>,
): TrackedRemoteSideEffectRequest | null {
  const matches = requestIds
    .map((requestId) => remoteSideEffectRequests.get(requestId))
    .filter((request): request is TrackedRemoteSideEffectRequest => !!request);
  if (matches.length === 0) return null;
  const [first] = matches;
  return matches.every((request) => request === first) ? first : null;
}

function concreteRemoteSideEffectMatchesRequest(
  event: ConcreteRemoteSideEffectEvent,
  request: TrackedRemoteSideEffectRequest,
): boolean {
  if (event.eventKind !== request.eventKind) return false;
  if (request.sessionWide) return event.sessionWide;
  if (event.sessionWide) return true;
  return request.laneIds.some((laneId) => event.laneIds.includes(laneId));
}

function isValidDeliveryPushedPayload(payload: Record<string, unknown>): boolean {
  return (
    textFromPayloadOrEvidence(payload, "remote") !== null &&
    textFromPayloadOrEvidence(payload, "branch") !== null &&
    textFromPayloadOrEvidence(payload, "commitSha") !== null
  );
}

function isValidPullRequestCreatedPayload(payload: Record<string, unknown>): boolean {
  return (
    numberFromPayloadOrEvidence(payload, "prNumber", "number") !== null &&
    textFromPayloadOrEvidence(payload, "url") !== null &&
    (
      textFromPayloadOrEvidence(payload, "headSha", "commitSha") !== null ||
      textFromPayloadOrEvidence(payload, "head", "headBranch", "branch") !== null
    )
  );
}

function isValidPullRequestMergedPayload(payload: Record<string, unknown>): boolean {
  const hasPullRequestIdentity =
    numberFromPayloadOrEvidence(payload, "prNumber", "number") !== null ||
    textFromPayloadOrEvidence(payload, "url") !== null ||
    textFromPayloadOrEvidence(payload, "mergeCommitSha") !== null;
  return (
    hasPullRequestIdentity &&
    (
      textFromPayloadOrEvidence(payload, "headSha", "commitSha", "mergeCommitSha") !== null ||
      textFromPayloadOrEvidence(payload, "status") === "merged"
    )
  );
}

function isValidMainSyncedPayload(payload: Record<string, unknown>): boolean {
  return textFromPayloadOrEvidence(payload, "headSha", "commitSha") !== null;
}

function hasRemoteSideEffectScope(payload: Record<string, unknown>): boolean {
  return payload.sessionWide === true || remoteSideEffectPayloadLaneIds(payload).length > 0;
}

function remoteSideEffectIdentityIds(payload: Record<string, unknown>): string[] {
  return uniqueStrings([
    text(payload.operationId),
    text(payload.requestId),
  ].filter((item): item is string => item !== null));
}

function remoteSideEffectPayloadLaneIds(payload: Record<string, unknown>): string[] {
  return uniqueStrings([
    text(payload.laneId),
    text(payload.commitLaneId),
    text(payload.targetLaneId),
    ...stringArray(payload.affectedLaneIds),
  ].filter((item): item is string => item !== null));
}

function remoteSideEffectEventLaneIds(payload: Record<string, unknown>): string[] {
  const evidence = isRecord(payload.evidence) ? payload.evidence : {};
  return uniqueStrings([
    ...remoteSideEffectPayloadLaneIds(payload),
    ...remoteSideEffectPayloadLaneIds(evidence),
  ]);
}

function remoteSideEffectEventIsSessionWide(payload: Record<string, unknown>, laneIds: readonly string[]): boolean {
  const evidence = isRecord(payload.evidence) ? payload.evidence : {};
  return payload.sessionWide === true || evidence.sessionWide === true || laneIds.length === 0;
}

function textFromPayloadOrEvidence(payload: Record<string, unknown>, ...keys: string[]): string | null {
  const evidence = isRecord(payload.evidence) ? payload.evidence : {};
  for (const key of keys) {
    const value = text(payload[key]) ?? text(evidence[key]);
    if (value) return value;
  }
  return null;
}

function numberFromPayloadOrEvidence(payload: Record<string, unknown>, ...keys: string[]): number | null {
  const evidence = isRecord(payload.evidence) ? payload.evidence : {};
  for (const key of keys) {
    const value = integer(payload[key]) ?? integer(evidence[key]);
    if (value !== null) return value;
  }
  return null;
}

function integer(value: unknown): number | null {
  return typeof value === "number" && Number.isInteger(value) ? value : null;
}

function isOptionalText(value: unknown): boolean {
  return value === undefined || text(value) !== null;
}

function isOptionalBoolean(value: unknown): boolean {
  return value === undefined || typeof value === "boolean";
}

function isCheckpointSource(value: unknown): boolean {
  return value === "agent_bridge" || value === "workflow_kernel" || value === "backend" || value === "user";
}

function isCheckpointEvidenceRef(value: unknown): boolean {
  if (!isRecord(value)) return false;
  if (
    value.kind !== "run" &&
    value.kind !== "segment" &&
    value.kind !== "evidence" &&
    value.kind !== "changeset" &&
    value.kind !== "artifact" &&
    value.kind !== "commit"
  ) {
    return false;
  }
  return text(value.id) !== null;
}

function uniqueStrings(values: string[]): string[] {
  return [...new Set(values)];
}

function stringArray(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return uniqueStrings(value.map(text).filter((item): item is string => item !== null));
}

function text(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}
