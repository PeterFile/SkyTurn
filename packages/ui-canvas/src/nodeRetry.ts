import { parseRunEvidence, type CanvasSession, type RunEvidence } from "@skyturn/project-core";
import type { WorkflowApi, WorkflowRetryRequest } from "@skyturn/persistence";
import type { FlowSegment } from "@skyturn/workflow-kernel";

export interface NodeRetryScope {
  projectId: string;
  queryRoot: string;
  canonicalRoot: string;
  sessionId: string;
  nodeId: string;
  runId: string;
  generation: number;
}

export interface NodeRetryHistory extends FlowSegment { evidence: RunEvidence | null }
interface RetryFacts {
  reason: string | null;
  terminal: Omit<WorkflowRetryRequest, "requestId"> | null;
  history: NodeRetryHistory[];
}
export interface NodeRetryState {
  busy: boolean;
  confirming: boolean;
  reason: string | null;
  error: string | null;
  history: NodeRetryHistory[];
}
export const NODE_RETRY_CONFIRMATION =
  "Start a new attempt in the CURRENT workspace? Retry keeps current files. It does not reset Git, roll back changes, or restore a checkpoint. The original attempt, output, and evidence are retained. Paused scheduling stays paused.";

function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
function records(value: unknown): Record<string, unknown>[] {
  if (!Array.isArray(value) || !value.every(record)) throw new Error("Retry authority is incomplete. Reopen node details to reload.");
  return value;
}
function identifier(value: unknown): value is string {
  return typeof value === "string" && /^[A-Za-z0-9][A-Za-z0-9._:-]{0,511}$/.test(value);
}
function scopeKey(scope: NodeRetryScope): string {
  return JSON.stringify([scope.projectId, scope.queryRoot, scope.canonicalRoot, scope.sessionId, scope.nodeId, scope.runId]);
}

/** Display preflight only. The store remains the authority for Retry admission. */
export function readNodeRetryFacts(value: unknown, scope: NodeRetryScope): RetryFacts {
  if (!record(value) || value.protocolVersion !== 1 || value.projectRoot !== scope.canonicalRoot ||
    value.sessionId !== scope.sessionId || !record(value.canvasSession) ||
    value.canvasSession.id !== scope.sessionId || value.canvasSession.projectId !== scope.projectId ||
    !record(value.projection) || value.projection.sessionId !== scope.sessionId) {
    throw new Error("Retry authority does not match this project and session.");
  }
  const canvas = value.canvasSession;
  const projection = value.projection;
  const nodes = records(canvas.nodes).filter((node) => node.id === scope.nodeId);
  const mappings = records(projection.projectionNodes).filter((node) => node.id === scope.nodeId);
  const lanes = records(projection.lanes);
  const lane = mappings.length === 1 ? lanes.find((item) => item.id === mappings[0].laneId) : undefined;
  const evidence = records(projection.evidence);
  const segments = records(projection.segments);
  const history: NodeRetryHistory[] = segments.filter((segment) => segment.laneId === lane?.id).map((segment) => {
    if (!identifier(segment.id) || !identifier(segment.runId) || !identifier(segment.laneId) ||
      !["running", "succeeded", "failed", "cancelled", "timed-out"].includes(String(segment.status)) ||
      !(segment.exitCode === null || Number.isInteger(segment.exitCode))) throw new Error("Retry segment authority is invalid.");
    const matching = evidence.filter((item) => item.laneId === segment.laneId && item.segmentId === segment.id);
    const parsed = matching.length === 1 ? parseRunEvidence(matching[0].runEvidence) : null;
    return { id: segment.id, laneId: segment.laneId, runId: segment.runId,
      status: segment.status as FlowSegment["status"], exitCode: segment.exitCode as number | null,
      evidence: parsed?.runId === segment.runId ? parsed : null };
  });
  const blocked = (reason: string): RetryFacts => ({ reason, terminal: null, history });
  if (nodes.length !== 1 || !lane || !identifier(lane.id)) return blocked("Exact workflow lane authority is unavailable.");
  const node = nodes[0];
  if (canvas.plannerNodeId === node.id || ["planner", "intake", "commit", "pull_request", "delivery"].includes(String(lane.kind)) ||
    ["planner", "intake", "commit", "pull_request"].includes(String(lane.laneKind))) {
    return blocked("Retry is available only for ordinary executable tasks, not planner or delivery tasks.");
  }
  if (lane.rollbackStatus || node.rollbackStatus || !record(projection.laneRollbackStatuses) || projection.laneRollbackStatuses[lane.id]) {
    return blocked("Rolled-back or inactive tasks cannot be retried.");
  }
  const latest = history.at(-1);
  if (record(lane.retryAttempt) && lane.retryAttempt.segmentId !== latest?.id) {
    return blocked("A new attempt is already reserved. It will run when scheduling permits.");
  }
  if (node.runId !== scope.runId || latest?.runId !== scope.runId) return blocked("Terminal run authority changed. Reopen node details to reload.");
  if (!lane.executable || lane.nodeKind !== "agent_task" || !record(lane.runtimePolicy) ||
    lane.runtimePolicy.trusted !== true || lane.runtimePolicy.executable !== true || lane.runtimePolicy.source !== "workflow_projection") {
    return blocked("This task has no trusted executable Retry scope.");
  }
  if (lane.status !== "failed" || !latest || !["failed", "cancelled", "timed-out"].includes(latest.status) ||
    !latest.evidence || latest.evidence.status !== latest.status || latest.evidence.exitCode !== latest.exitCode) {
    return blocked("Retry requires the latest failed, cancelled, or timed-out attempt and its exact terminal evidence.");
  }
  const checkpoints = records(projection.checkpoints);
  const before = checkpoints.filter((checkpoint) => checkpoint.laneId === lane.id && checkpoint.nodeId === node.id &&
    checkpoint.runId === latest.runId && checkpoint.segmentId === latest.id && checkpoint.phase === "before");
  if (before.length !== 1 || before[0].source !== "backend" || before[0].id !== `checkpoint:${latest.runId}:before` ||
    typeof before[0].headCommit !== "string" || !/^[0-9a-f]{40}$/i.test(before[0].headCommit)) {
    return blocked("The original backend checkpoint is unavailable. Retry cannot be verified.");
  }
  const descendants = new Set<unknown>([lane.id]);
  const edges = records(projection.edges);
  for (let size = 0; size !== descendants.size;) {
    size = descendants.size;
    for (const edge of edges) if (descendants.has(edge.sourceLaneId)) descendants.add(edge.targetLaneId);
  }
  descendants.delete(lane.id);
  const unsafeDescendant = lanes.some((item) => descendants.has(item.id) &&
    (!["pending", "ready", "blocked"].includes(String(item.status)) || item.rollbackStatus ||
      /^(repair|regression):/.test(String(item.semanticKey)) ||
      [...segments, ...evidence, ...checkpoints].some((fact) => fact.laneId === item.id)));
  if (unsafeDescendant || segments.some((item) => item.status === "running") ||
    lanes.some((item) => item.status === "running" || item.status === "waiting_input") ||
    records(projection.rollbackIntents).length || records(projection.checkpointIntents).length ||
    records(projection.candidateBindingBlocks).some((item) => item.laneId === lane.id) ||
    records(projection.events).some((event) => /^(workflow\.(delivery\.|pull_request\.|remote_side_effect\.|variant\.(adopt|reject)|worktree\.clean)|workflow\.commit\.created)/.test(String(event.kind)))) {
    return blocked("Retry is unavailable while work is active or after downstream progress, rollback, or delivery.");
  }
  return { reason: null, history, terminal: { sessionId: scope.sessionId, laneId: lane.id,
    terminalSegmentId: latest.id, terminalRunId: latest.runId } };
}

export function createNodeRetryController(options: {
  getProjection: WorkflowApi["getProjection"];
  retryLane: WorkflowApi["retryLane"];
  createRequestId: () => string;
  isCurrent: (scope: NodeRetryScope) => boolean;
  canvas: (response: unknown, scope: NodeRetryScope) => CanvasSession | null;
  apply: (response: unknown, scope: NodeRetryScope) => boolean;
  changed: () => void;
}) {
  let scope: NodeRetryScope | null = null;
  let epoch = 0;
  let facts: RetryFacts | null = null;
  let baseline: { canvas: CanvasSession; history: NodeRetryHistory[] } | null = null;
  let state: NodeRetryState = { busy: false, confirming: false, reason: "Checking Retry eligibility…", error: null, history: [] };
  const requests = new Map<string, WorkflowRetryRequest>();
  const inFlight = new Set<string>();
  const reserved = new Set<string>();
  const current = (captured: NodeRetryScope, token: number) => epoch === token && scope === captured && options.isCurrent(captured);
  const change = (patch: Partial<NodeRetryState>) => { state = { ...state, ...patch }; options.changed(); };
  const read = (response: unknown, captured: NodeRetryScope) => {
    if (!options.canvas(response, captured)) throw new Error("Retry response authority is invalid or foreign.");
    return readNodeRetryFacts(response, captured);
  };
  return {
    get state(): NodeRetryState { return state; },
    async activate(next: NodeRetryScope | null) {
      scope = next;
      const token = ++epoch;
      facts = null;
      baseline = null;
      change({ busy: false, confirming: false, reason: "Checking Retry eligibility…", error: null, history: [] });
      if (!next) return;
      try {
        const response = await options.getProjection(next.queryRoot, next.sessionId);
        if (!current(next, token)) return;
        facts = read(response, next);
        baseline = { canvas: options.canvas(response, next)!, history: facts.history };
        change({ history: facts.history, reason: inFlight.has(scopeKey(next))
          ? "A previous Retry request is still in progress. Reopen node details after it settles."
          : reserved.has(scopeKey(next)) ? "A new attempt is already reserved." : facts.reason });
      } catch (error) {
        if (current(next, token)) change({ reason: "Retry authority unavailable. Reopen node details to reload.", error: String(error) });
      }
    },
    begin() {
      if (!scope || !options.isCurrent(scope) || state.busy || state.reason || !facts?.terminal ||
        inFlight.has(scopeKey(scope)) || reserved.has(scopeKey(scope))) return;
      change({ confirming: true, error: null });
    },
    cancel() { if (!state.busy) change({ confirming: false }); },
    async confirm() {
      if (!scope || !options.isCurrent(scope) || !state.confirming || state.busy || !facts?.terminal) return;
      const captured = scope;
      const token = epoch;
      const key = scopeKey(captured);
      if (inFlight.has(key) || reserved.has(key)) return;
      inFlight.add(key);
      change({ busy: true, confirming: false, error: null });
      try {
        // An earlier IPC can commit even when its response is lost. Re-read before resubmission.
        const projectionResponse = await options.getProjection(captured.queryRoot, captured.sessionId);
        if (!current(captured, token)) return;
        const fresh = read(projectionResponse, captured);
        facts = fresh;
        if (fresh.reason || !fresh.terminal) {
          const known = requests.get(key);
          const projection = record(projectionResponse.projection) ? projectionResponse.projection : null;
          const lane = projection && records(projection.lanes).find((item) => item.id === known?.laneId);
          if (known && baseline && lane && record(lane.retryAttempt) && lane.retryAttempt.requestId === known.requestId) {
            validateRetryProjection(projectionResponse, options.canvas(projectionResponse, captured)!, captured, known, baseline);
            if (!options.apply(projectionResponse, captured)) throw new Error("Retry recovery authority is no longer current.");
            reserved.add(key);
          }
          change({ reason: fresh.reason, history: fresh.history });
          return;
        }
        const request = requests.get(key) ?? { ...fresh.terminal, requestId: options.createRequestId() };
        if (Object.entries(fresh.terminal).some(([name, value]) => request[name as keyof WorkflowRetryRequest] !== value)) {
          throw new Error("Retry terminal authority changed. Reopen node details to reload.");
        }
        requests.set(key, request);
        const result = await options.retryLane(captured.queryRoot, request);
        if (!current(captured, token)) return;
        const canvas = options.canvas(result, captured);
        const event = record(result.event) ? result.event : null;
        const payload = event && record(event.payload) ? event.payload : null;
        const node = canvas?.nodes.find((item) => item.id === captured.nodeId);
        if (!canvas || typeof result.created !== "boolean" || event?.sessionId !== captured.sessionId ||
          event.kind !== "workflow.lane.retry_requested" || event.source !== "workflow-kernel" ||
          event.idempotencyKey !== `retry:${request.requestId}` || !payload ||
          Object.entries(request).some(([name, value]) => payload[name] !== value) ||
          !identifier(payload.nextRunId) || !identifier(payload.nextSegmentId) || payload.nextRunId === captured.runId ||
          payload.nextSegmentId === request.terminalSegmentId || node?.runId !== payload.nextRunId) {
          throw new Error("Retry response authority does not match the requested attempt.");
        }
        const returned = validateRetryProjection(result, canvas, captured, request, {
          canvas: options.canvas(projectionResponse, captured)!, history: fresh.history,
        }, payload.nextSegmentId);
        if (!options.apply(result, captured)) throw new Error("Retry authority is no longer current. Reopen node details to reload.");
        reserved.add(key);
        change({ reason: "A new attempt is already reserved.", history: returned.history });
      } catch (error) {
        if (current(captured, token)) change({ error: `${String(error)} Retry again to check the same request.` });
      } finally {
        inFlight.delete(key);
        if (current(captured, token)) change({ busy: false });
      }
    },
  };
}

function validateRetryProjection(
  response: { projection: unknown },
  canvas: CanvasSession,
  scope: NodeRetryScope,
  request: WorkflowRetryRequest,
  original: { canvas: CanvasSession; history: NodeRetryHistory[] },
  expectedSegmentId?: string,
): RetryFacts {
  const node = canvas.nodes.find((item) => item.id === scope.nodeId);
  const projection = record(response.projection) ? response.projection : null;
  const lane = projection && records(projection.lanes).find((item) => item.id === request.laneId);
  const attempt = lane && record(lane.retryAttempt) ? lane.retryAttempt : null;
  if (!attempt || Object.entries(request).some(([name, value]) => attempt[name] !== value) ||
    !identifier(attempt.runId) || !identifier(attempt.segmentId) || attempt.runId === scope.runId ||
    attempt.segmentId === request.terminalSegmentId || node?.runId !== attempt.runId ||
    (expectedSegmentId !== undefined && attempt.segmentId !== expectedSegmentId)) {
    throw new Error("Retry projection authority does not match the requested attempt.");
  }
  const returned = readNodeRetryFacts(response, { ...scope, runId: node.runId });
  const scheduling = canvas.schedulingState;
  const projectedScheduling = projection && record(projection.schedulingState) ? projection.schedulingState : null;
  if (!scheduling || !["active", "paused"].includes(scheduling.status) ||
    !Number.isSafeInteger(scheduling.revision) || scheduling.revision < 0 ||
    projectedScheduling?.status !== scheduling.status || projectedScheduling.revision !== scheduling.revision ||
    (original.canvas.schedulingState?.status === "paused" && scheduling.status !== "paused")) {
    throw new Error("Retry scheduling authority is invalid or did not preserve Pause.");
  }
  const originalNode = original.canvas.nodes.find((item) => item.id === scope.nodeId);
  if (!originalNode || !Array.isArray(node.output) || originalNode.output.some((text, index) => node.output[index] !== text) ||
    original.history.some((old) => !returned.history.some((item) => JSON.stringify(item) === JSON.stringify(old)))) {
    throw new Error("Retry response did not retain original output and attempt history.");
  }
  return returned;
}
