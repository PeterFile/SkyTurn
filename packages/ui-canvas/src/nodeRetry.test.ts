import { describe, expect, it, vi } from "vitest";
import { createNodeRetryController, readNodeRetryFacts } from "./nodeRetry.js";
import { reduceWorkflowEvents, type FlowEvent } from "@skyturn/workflow-kernel";

const now = "2026-09-10T00:00:00.000Z";
const policy = { trusted: true, executable: true, source: "workflow_projection", sandbox: "read-only" };
function fixture(status = "failed") {
  const scope = { projectId: "project", queryRoot: "/alias", canonicalRoot: "/project", sessionId: "session",
    nodeId: "lane", runId: "original-run", generation: 1 };
  const evidence = { runId: scope.runId, status, exitCode: 1, changesetId: null, checks: [], artifacts: [],
    review: null, errorReason: "Original failure", cancelReason: null, completedAt: now };
  const projection = { ...reduceWorkflowEvents([]), sessionId: scope.sessionId, schedulingState: { status: "paused", revision: 1 },
    lanes: [{ id: "lane", kind: "validation", semanticKey: "lane", nodeKind: "agent_task", executable: true,
      runtimePolicy: policy, status: "failed" }],
    projectionNodes: [{ id: "lane", laneId: "lane" }],
    segments: [{ id: "exact-segment", laneId: "lane", runId: scope.runId, status, exitCode: 1 }],
    evidence: [{ laneId: "lane", segmentId: "exact-segment", runEvidence: evidence }],
    checkpoints: [{ id: "checkpoint:original-run:before", sessionId: "session", nodeId: "lane", laneId: "lane",
      runId: scope.runId, segmentId: "exact-segment", phase: "before", source: "backend", headCommit: "a".repeat(40) }] };
  const node = { id: "lane", runId: scope.runId, status: "failed", output: ["  Original\r\n\n"],
    executable: true, nodeKind: "agent_task", runtimePolicy: policy };
  const response = { protocolVersion: 1, projectRoot: "/project", sessionId: "session", projection,
    canvasSession: { id: "session", projectId: "project", plannerNodeId: "planner", kind: "canvas", nodes: [node],
      schedulingState: { status: "paused", revision: 1 } } };
  return { scope, response, evidence };
}
function deferred() {
  let resolve!: (value: any) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<any>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}
function accepted(f: ReturnType<typeof fixture>, request: any) {
  const result = structuredClone(f.response);
  const retryAttempt = { ...request, runId: "backend-new-run", segmentId: "backend-new-segment" };
  Object.assign(result.projection.lanes[0], { status: "pending", retryAttempt });
  Object.assign(result.canvasSession.nodes[0], { runId: retryAttempt.runId, status: "pending" });
  return { ...result, created: true, event: { sessionId: "session", kind: "workflow.lane.retry_requested",
    source: "workflow-kernel", idempotencyKey: `retry:${request.requestId}`,
    payload: { ...request, nextRunId: retryAttempt.runId, nextSegmentId: retryAttempt.segmentId } } };
}
async function harness() {
  expect(createNodeRetryController).toBeTypeOf("function");
  const f = fixture();
  let current: any = f.scope;
  const apply = vi.fn(() => true);
  const changed = vi.fn();
  const getProjection = vi.fn(async () => f.response);
  const retryLane = vi.fn(async (_root, request) => accepted(f, request));
  const controller = createNodeRetryController({ getProjection, retryLane, createRequestId: () => "request-one",
    isCurrent: (scope) => current === scope,
    canvas: (value, scope) => value?.protocolVersion === 1 && value.projectRoot === scope.canonicalRoot &&
      value.sessionId === scope.sessionId && value.canvasSession?.projectId === scope.projectId ? value.canvasSession : null,
    apply, changed });
  await controller.activate(f.scope);
  return { ...f, controller, apply, changed, getProjection, retryLane,
    async switchTo(scope: any) { current = scope; await controller.activate(scope); } };
}

describe("desktop Node Retry controller", () => {
  it.each(["failed", "cancelled", "timed-out"])("uses exact authoritative %s segment and evidence", (status) => {
    expect(readNodeRetryFacts).toBeTypeOf("function");
    const f = fixture(status);
    const facts = readNodeRetryFacts(f.response, f.scope);
    expect(facts.reason).toBeNull();
    expect(facts.terminal).toEqual({ sessionId: "session", laneId: "lane", terminalRunId: "original-run", terminalSegmentId: "exact-segment" });
    expect(facts.history[0].evidence).toEqual(f.evidence);
  });

  it("opens confirmation, cancels with zero mutation IPC, then confirms once and retains old history", async () => {
    const h = await harness();
    const original = structuredClone(h.response);
    h.controller.begin();
    expect(h.controller.state.confirming).toBe(true);
    h.controller.cancel();
    expect(h.retryLane).not.toHaveBeenCalled();
    expect(h.apply).not.toHaveBeenCalled();
    h.controller.begin();
    await h.controller.confirm();
    expect(h.retryLane).toHaveBeenCalledExactlyOnceWith("/alias", { requestId: "request-one", sessionId: "session",
      laneId: "lane", terminalRunId: "original-run", terminalSegmentId: "exact-segment" });
    expect(h.apply).toHaveBeenCalledOnce();
    expect(h.apply.mock.calls[0][0].canvasSession.schedulingState.status).toBe("paused");
    expect(h.apply.mock.calls[0][0].projection.segments).toEqual(original.projection.segments);
    expect(h.response).toEqual(original);
    h.controller.begin();
    await h.controller.confirm();
    expect(h.retryLane).toHaveBeenCalledOnce();
  });

  it("suppresses busy calls and reuses the requestId after a network failure", async () => {
    const h = await harness();
    const pending = deferred();
    h.retryLane.mockImplementationOnce(() => pending.promise);
    h.controller.begin();
    const first = h.controller.confirm();
    await vi.waitFor(() => expect(h.retryLane).toHaveBeenCalledOnce());
    h.controller.begin();
    await h.controller.confirm();
    expect(h.retryLane).toHaveBeenCalledOnce();
    pending.reject(new Error("Connection lost"));
    await first;
    expect(h.controller.state.error).toContain("Connection lost");
    h.controller.begin();
    await h.controller.confirm();
    expect(h.retryLane.mock.calls[1][1]).toEqual(h.retryLane.mock.calls[0][1]);
  });

  it("checks for an already reserved attempt after an ambiguous failure without resubmitting", async () => {
    const h = await harness();
    h.retryLane.mockRejectedValueOnce(new Error("Response lost"));
    h.controller.begin();
    await h.controller.confirm();
    h.getProjection.mockResolvedValue(accepted(h, h.retryLane.mock.calls[0][1]));
    h.controller.begin();
    await h.controller.confirm();
    expect(h.retryLane).toHaveBeenCalledOnce();
    expect(h.controller.state.reason).toMatch(/already.*reserved/i);
    expect(h.apply).toHaveBeenCalledOnce();
    expect(h.apply.mock.calls[0][0].canvasSession.nodes[0].runId).toBe("backend-new-run");
  });

  it.each(["root", "project", "session", "node", "run", "receipt", "projection receipt", "output", "pause"])("rejects foreign or invalid %s authority inline", async (field) => {
    const h = await harness();
    h.retryLane.mockImplementation(async (_root, request) => {
      const result = accepted(h, request);
      if (field === "root") result.projectRoot = "/foreign";
      if (field === "project") result.canvasSession.projectId = "foreign";
      if (field === "session") result.sessionId = "foreign";
      if (field === "node") result.canvasSession.nodes[0].id = "foreign";
      if (field === "run") result.canvasSession.nodes[0].runId = "foreign";
      if (field === "receipt") result.event.payload.terminalRunId = "foreign";
      if (field === "projection receipt") Object.assign(result.projection.lanes[0], { retryAttempt: {} });
      if (field === "output") result.canvasSession.nodes[0].output = [];
      if (field === "pause") result.canvasSession.schedulingState.status = "active";
      return result;
    });
    h.controller.begin();
    await h.controller.confirm();
    expect(h.apply).not.toHaveBeenCalled();
    expect(h.controller.state.error).toMatch(/authorit|history|output/i);
  });

  it.each(["resolve", "reject"])("ignores stale %s and finally after switching away and back", async (ending) => {
    const h = await harness();
    const pending = deferred();
    h.retryLane.mockImplementationOnce(() => pending.promise);
    h.controller.begin();
    const first = h.controller.confirm();
    await vi.waitFor(() => expect(h.retryLane).toHaveBeenCalledOnce());
    await h.switchTo(null);
    await h.switchTo({ ...h.scope, generation: 2 });
    const before = structuredClone(h.controller.state);
    h.changed.mockClear();
    if (ending === "resolve") pending.resolve(accepted(h, h.retryLane.mock.calls[0][1]));
    else pending.reject(new Error("Old error"));
    await first;
    expect(h.controller.state).toEqual(before);
    expect(h.changed).not.toHaveBeenCalled();
    expect(h.apply).not.toHaveBeenCalled();
  });

  it.each(["planner", "delivery", "running", "succeeded", "inactive", "missing evidence", "forged run", "descendant"])("disables unsafe %s scopes", (unsafe) => {
    const f = fixture();
    const lane = f.response.projection.lanes[0];
    if (unsafe === "planner") f.response.canvasSession.plannerNodeId = "lane";
    if (unsafe === "delivery") lane.kind = "commit";
    if (unsafe === "running") lane.status = "running";
    if (unsafe === "succeeded") f.response.projection.segments[0].status = "succeeded";
    if (unsafe === "inactive") Object.assign(lane, { rollbackStatus: "inactive" });
    if (unsafe === "missing evidence") f.response.projection.evidence = [];
    if (unsafe === "forged run") f.response.projection.segments[0].runId = "foreign";
    if (unsafe === "descendant") {
      f.response.projection.edges.push({ id: "edge", sourceLaneId: "lane", targetLaneId: "child" });
      f.response.projection.lanes.push({ ...lane, id: "child", status: "completed" });
    }
    expect(readNodeRetryFacts(f.response, f.scope).reason).toBeTruthy();
  });
});
