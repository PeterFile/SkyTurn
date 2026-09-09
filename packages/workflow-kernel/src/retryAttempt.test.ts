import { describe, expect, it } from "vitest";
import { compileWorkflowRetry, evaluateGate, reduceWorkflowEvents, scheduleReadyLanes, type FlowEvent } from "./index.js";

const now = "2026-09-09T00:00:00.000Z";
const request = { requestId: "retry-1", sessionId: "session-1", laneId: "lane-a", terminalSegmentId: "segment-a", terminalRunId: "run-a" };
const attempt = { runId: "run-retry-1", segmentId: "segment-retry-1" };
let seq = 0;
function event(kind: FlowEvent["kind"], payload: FlowEvent["payload"]): FlowEvent {
  return { id: `event-${++seq}`, sessionId: request.sessionId, seq, kind, payload, source: "test", createdAt: now, idempotencyKey: null };
}
function failed(status = "failed") {
  return reduceWorkflowEvents([
    ...["lane-a", "lane-b"].map((id) => event("workflow.lane.declared", { lane: { id, semanticKey: id, kind: "implementation", title: id, agentKind: "codex" } })),
    event("workflow.edge.declared", { edge: { sourceLaneId: "lane-a", targetLaneId: "lane-b" } }),
    event("workflow.segment.started", { segment: { id: "segment-a", laneId: "lane-a", runId: "run-a", status: "running" } }),
    event("workflow.evidence.recorded", { laneId: "lane-a", segmentId: "segment-a", evidence: {
      id: "evidence-a", kind: "run-exit", status: "failed", checks: [], artifacts: [], runEvidence: {
        runId: "run-a", status, exitCode: 1, changesetId: null, checks: [], artifacts: [], review: null,
        errorReason: "Failed", cancelReason: null, completedAt: now,
      },
    } }),
  ]);
}

describe("Retry attempt projection", () => {
  it.each(["failed", "cancelled", "timed-out"])("retains %s history while only the reserved attempt controls the lane", (status) => {
    const original = failed(status);
    const retry = compileWorkflowRetry(original, request, attempt, now);
    const queued = reduceWorkflowEvents([...original.events, retry]);
    expect(queued.lanes[0]?.status).toBe("pending");
    expect(queued.segments).toEqual(original.segments);
    expect(queued.evidence).toEqual(original.evidence);
    expect(scheduleReadyLanes(queued, { allowedParallelism: 2 }).map((lane) => lane.id)).toEqual(["lane-a"]);
    const oldTerminal = event("workflow.segment.finished", { laneId: "lane-a", segmentId: "segment-a", status });
    const started = event("workflow.segment.started", { segment: { id: attempt.segmentId, runId: attempt.runId, laneId: "lane-a", status: "running" } });
    for (const events of [[oldTerminal], [started, oldTerminal]]) {
      const projected = reduceWorkflowEvents([...queued.events, ...events]);
      expect(projected.lanes[0]?.status).toBe(events.length === 1 ? "pending" : "running");
      expect(projected.segments[0]).toEqual(original.segments[0]);
      expect(scheduleReadyLanes(projected, { allowedParallelism: 2 }).some((lane) => lane.id === "lane-b")).toBe(false);
    }
    const evidence = original.evidence[0]!.runEvidence!;
    const success = event("workflow.evidence.recorded", { laneId: "lane-a", segmentId: attempt.segmentId,
      evidence: { id: "evidence-retry", kind: "run-exit", status: "passed", runEvidence: { ...evidence, runId: attempt.runId, status: "succeeded", exitCode: 0, errorReason: null } } });
    const completed = reduceWorkflowEvents([...queued.events, started, success, oldTerminal,
      event("workflow.evidence.recorded", original.events.at(-1)!.payload)]);
    expect(completed.lanes[0]?.status).toBe("completed");
    expect(scheduleReadyLanes(completed, { allowedParallelism: 2 }).map((lane) => lane.id)).toEqual(["lane-b"]);
    expect(compileWorkflowRetry(completed, request, attempt, now)).toEqual(retry);
    expect(completed.evidence[0]).toEqual(original.evidence[0]);
  });

  it("rejects stale identity, missing evidence, active work and progressed descendants", () => {
    const original = failed();
    for (const projection of [
      { ...original, evidence: [] },
      { ...original, segments: [...original.segments, { id: "other", laneId: "lane-b", runId: "other", status: "running" as const, exitCode: null }] },
      { ...original, lanes: original.lanes.map((lane) => lane.id === "lane-b" ? { ...lane, status: "completed" as const } : lane) },
      { ...original, lanes: original.lanes.map((lane) => lane.id === "lane-b" ? { ...lane, status: "running" as const } : lane) },
      { ...original, lanes: original.lanes.map((lane) => ({ ...lane, runtimePolicy: { ...lane.runtimePolicy, trusted: false as never } })) },
      { ...original, lanes: original.lanes.map((lane) => ({ ...lane, semanticKey: "planner" })) },
      { ...original, evidence: [...original.evidence, original.evidence[0]!] },
      { ...original, rollbackIntents: [{} as never] },
      { ...original, checkpointIntents: [{} as never] },
      { ...original, lanes: original.lanes.map((lane) => ({ ...lane, rollbackStatus: "inactive" as const })) },
    ]) expect(() => compileWorkflowRetry(projection, request, attempt, now)).toThrow();
    expect(() => compileWorkflowRetry(original, { ...request, terminalRunId: "stale" }, attempt, now)).toThrow();
  });

  it.each(["workflow.commit.created", "workflow.delivery.pushed", "workflow.pull_request.created", "workflow.remote_side_effect.requested", "workflow.worktree.clean_requested"] as const)("rejects Retry after %s", (kind) => {
    const projection = failed();
    expect(() => compileWorkflowRetry({ ...projection, events: [...projection.events, event(kind, {})] }, request, attempt, now)).toThrow();
  });

  it("rejects forged Retry replay and prevents stale failed evidence from triggering repair", () => {
    const original = failed();
    const retry = compileWorkflowRetry(original, request, attempt, now);
    expect(() => reduceWorkflowEvents([...original.events, { ...retry, payload: { ...retry.payload, terminalRunId: "wrong" } }])).toThrow();
    const again = reduceWorkflowEvents([...original.events, retry,
      event("workflow.segment.started", { segment: { id: attempt.segmentId, runId: attempt.runId, laneId: "lane-a", status: "running" } }),
      event("workflow.evidence.recorded", { laneId: "lane-a", segmentId: attempt.segmentId, evidence: { id: "evidence-retry", kind: "run-exit", status: "failed",
        runEvidence: { ...original.evidence[0]!.runEvidence!, runId: attempt.runId } } }),
    ]);
    expect(evaluateGate(again, { type: "ReplanFromEvidence", laneId: "lane-a", evidenceId: "evidence-a" }).allowed).toBe(false);
  });
});
