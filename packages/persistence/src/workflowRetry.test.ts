import { mkdtemp, mkdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";
import { afterEach, describe, expect, it } from "vitest";
import type { RunEvidence } from "@skyturn/project-core";
import { createWorkflowStore, type RecordRunResultInput } from "./workflowStore.js";

const now = "2026-09-09T00:00:00.000Z";
const roots: string[] = [];
const stores: ReturnType<typeof createWorkflowStore>[] = [];
afterEach(async () => {
  for (const store of stores.splice(0)) store.close();
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});
function open(projectRoot: string) {
  const store = createWorkflowStore({ projectRoot });
  stores.push(store);
  return store;
}
async function fixture(executionTarget: "current_branch" | "new_worktree", status: RunEvidence["status"] = "failed") {
  const root = await mkdtemp(join(tmpdir(), "skyturn-retry-"));
  roots.push(root);
  const store = open(root);
  store.createWorkflowSession({ id: "session-1", projectId: "project-1", title: "Retry", goal: "Retry", mode: "fast",
    target: { executionTarget, selectedBranch: "main" }, plannerProfile: "default", transport: "hermes_replay_recovery", recoveryReason: "SQLite test", now });
  store.appendWorkflowEvent({ sessionId: "session-1", kind: "workflow.lane.declared", source: "test", now,
    payload: { lane: { id: "lane-a", semanticKey: "lane-a", kind: "implementation", title: "Implement", agentKind: "codex" } } });
  const worktreePath = executionTarget === "current_branch" ? root : join(root, "candidate");
  await mkdir(worktreePath, { recursive: true });
  if (executionTarget === "new_worktree") store.appendWorkflowEvent({ sessionId: "session-1", kind: "workflow.lane.candidate_bound", source: "workflow-scheduler", now,
    payload: { binding: { sessionId: "session-1", laneId: "lane-a", variantId: "lane-a", worktreeId: "worktree-session-1-lane-a", lineageId: "lineage-a", reason: "default", predecessorLaneIds: [] } } });
  if (executionTarget === "new_worktree") store.appendWorkflowEvent({ sessionId: "session-1", kind: "workflow.worktree.created", source: "backend", now,
    payload: { worktree: { worktreeId: "worktree-session-1-lane-a", variantId: "lane-a", parentLaneId: "lane-a", path: worktreePath,
      realPath: worktreePath, branchName: "candidate", baseCommit: "a".repeat(40), headCommit: "a".repeat(40), repoRoot: root, gitdir: join(root, ".git/worktrees/candidate") } } });
  const lane = store.scheduleReadyLanes("session-1", { now }).readyLanes[0]!;
  const checkpoint = { sessionId: "session-1", nodeId: lane.id, laneId: lane.id, segmentId: lane.segmentId, runId: lane.runId,
    phase: "before" as const, executionTarget, worktreePath, branchName: executionTarget === "current_branch" ? "main" : "candidate",
    ...(executionTarget === "new_worktree" ? { worktreeId: "worktree-session-1-lane-a" } : {}),
    headCommit: "a".repeat(40), worktreeState: "clean" as const, evidenceRefs: [{ kind: "run" as const, id: lane.runId }], now };
  store.recordRunCheckpoint(checkpoint);
  const terminal: RecordRunResultInput = { sessionId: "session-1", laneId: lane.id, segmentId: lane.segmentId, runId: lane.runId, agentKind: "codex", now,
    runEvents: [{ protocolVersion: 1, runId: lane.runId, seq: 1, timestamp: now, kind: "output", payload: { text: "Original output\n" } }],
    evidence: { runId: lane.runId, status, exitCode: 1, changesetId: null, checks: [], artifacts: [], review: null,
      errorReason: "Failed", cancelReason: null, completedAt: now } };
  store.recordRunResult(terminal);
  const request = { requestId: "retry-1", sessionId: "session-1", laneId: lane.id, terminalSegmentId: lane.segmentId, terminalRunId: lane.runId };
  return { root, store, lane, terminal, request, checkpoint };
}
function writes(store: ReturnType<typeof createWorkflowStore>) {
  const db = (store as unknown as { db: Database.Database }).db;
  return (db.prepare("SELECT total_changes() AS count").get() as { count: number }).count;
}

describe("SQLite Retry requests", () => {
  it.each(["current_branch", "new_worktree"] as const)("reserves and schedules fresh attempts once with the same %s binding", async (target) => {
    const f = await fixture(target);
    const original = f.store.materializeFlowProjection("session-1");
    const originalNode = f.store.materializeCanvasSession("session-1")!.nodes.find((node) => node.id === f.lane.id)!;
    expect(original.lanes[0]?.output).toEqual(["Original output\n"]);
    f.store.pauseWorkflowScheduling({ sessionId: "session-1", requestId: "pause", expectedStatus: "active", expectedRevision: 0, now });
    const accepted = f.store.retryWorkflowLane(f.request, now);
    expect(accepted.created).toBe(true);
    expect(accepted.view.projection.segments).toEqual(original.segments);
    expect(accepted.view.projection.evidence).toEqual(original.evidence);
    expect(accepted.view.projection.lanes[0]?.output).toEqual(original.lanes[0]?.output);
    const queuedNode = accepted.view.canvasSession?.nodes.find((node) => node.id === f.lane.id);
    expect(queuedNode?.worktree).toEqual(originalNode.worktree);
    expect(queuedNode?.runId).not.toBe(f.lane.runId);
    expect(queuedNode?.status).toBe("pending");
    expect(f.store.scheduleReadyLanes("session-1", { now }).readyLanes).toEqual([]);
    f.store.close();
    stores.splice(stores.indexOf(f.store), 1);
    const store = open(f.root);
    const count = writes(store);
    expect(store.retryWorkflowLane(f.request, now)).toMatchObject({ created: false, event: accepted.event });
    expect(writes(store)).toBe(count);
    store.resumeWorkflowScheduling({ sessionId: "session-1", requestId: "resume", expectedStatus: "paused", expectedRevision: 1, now });
    const retry = store.scheduleReadyLanes("session-1", { now }).readyLanes[0]!;
    expect(retry.runId).not.toBe(f.lane.runId);
    expect(retry.segmentId).not.toBe(f.lane.segmentId);
    expect(store.scheduleReadyLanes("session-1", { now }).readyLanes).toEqual([]);
    store.recordRunCheckpoint({ ...f.checkpoint, runId: retry.runId, segmentId: retry.segmentId, evidenceRefs: [{ kind: "run", id: retry.runId }] });
    const beforeReplay = writes(store);
    expect(store.recordRunResult(f.terminal).lanes[0]?.status).toBe("running");
    expect(() => store.recordRunResult({ ...f.terminal, evidence: { ...f.terminal.evidence, errorReason: "conflict" } })).toThrow();
    expect(() => store.recordRunResult({ ...f.terminal, runEvents: [] })).toThrow();
    expect(writes(store)).toBe(beforeReplay);
    const secondTerminal = { ...f.terminal, runId: retry.runId, segmentId: retry.segmentId, runEvents: [], evidence: { ...f.terminal.evidence, runId: retry.runId } };
    store.recordRunResult(secondTerminal);
    store.retryWorkflowLane({ ...f.request, requestId: "retry-2", terminalSegmentId: retry.segmentId, terminalRunId: retry.runId }, now);
    const latest = store.materializeWorkflowView("session-1");
    const beforeOld = writes(store);
    expect(store.retryWorkflowLane(f.request, now).view).toEqual(latest);
    expect(() => store.retryWorkflowLane({ ...f.request, laneId: "other" }, now)).toThrow(/conflict/i);
    expect(writes(store)).toBe(beforeOld);
    expect(latest.projection.segments[0]).toEqual(original.segments[0]);
    expect(latest.projection.checkpoints[0]).toEqual(original.checkpoints[0]);
    store.close();
    stores.splice(stores.indexOf(store), 1);
    const reopened = open(f.root);
    const beforeReopenedReplay = writes(reopened);
    expect(reopened.retryWorkflowLane(f.request, now).view).toEqual(latest);
    expect(reopened.recordRunResult(f.terminal)).toEqual(latest.projection);
    expect(() => reopened.recordRunResult({ ...f.terminal, evidence: { ...f.terminal.evidence, exitCode: 2 } })).toThrow();
    expect(writes(reopened)).toBe(beforeReopenedReplay);
    const next = reopened.scheduleReadyLanes("session-1", { now }).readyLanes[0]!;
    expect(new Set([f.lane.runId, retry.runId, next.runId]).size).toBe(3);
    const succeeded = reopened.recordRunResult({ ...secondTerminal, runId: next.runId, segmentId: next.segmentId,
      evidence: { ...secondTerminal.evidence, runId: next.runId, status: "succeeded", exitCode: 0, errorReason: null } });
    expect(succeeded.lanes[0]?.status).toBe("completed");
    expect(succeeded.lanes[0]?.output).toEqual(original.lanes[0]?.output);
    expect(reopened.materializeCanvasSession("session-1")?.nodes.find((node) => node.id === f.lane.id)).toMatchObject({ status: "completed", runId: next.runId });
  });

  it.each(["failed", "cancelled", "timed-out"] as const)("accepts exact %s evidence and rejects malformed requests without writes", async (status) => {
    const { store, request } = await fixture("current_branch", status);
    const count = writes(store);
    for (const input of [null, [], {}, { ...request, prompt: "override" }, { ...request, terminalRunId: "bad id" },
      { ...request, requestId: "retry-1\n" }, { ...request, laneId: "lane-a\r" },
      { ...request, requestId: "x".repeat(513) }, { ...request, sessionId: " session-1" }, { ...request, terminalSegmentId: undefined }]) {
      expect(() => store.retryWorkflowLane(input as never, now)).toThrow();
      expect(writes(store)).toBe(count);
    }
    expect(() => store.appendWorkflowEvent({ sessionId: "session-1", kind: "workflow.lane.retry_requested", source: "test", payload: request, now })).toThrow();
    expect(writes(store)).toBe(count);
    expect(store.retryWorkflowLane(request, now).created).toBe(true);
  });

  it.each(["missing checkpoint", "checkpoint identity", "checkpoint source", "active work", "delivery", "other session collision"])("fails closed with zero writes for %s", async (unsafe) => {
    const { store, request } = await fixture("current_branch");
    if (unsafe === "missing checkpoint") {
      (store as unknown as { db: Database.Database }).db.prepare("DELETE FROM workflow_events WHERE kind = 'workflow.node.checkpoint_recorded'").run();
    } else if (unsafe === "checkpoint identity") {
      (store as unknown as { db: Database.Database }).db.prepare("UPDATE workflow_events SET payload_json = json_set(payload_json, '$.checkpoint.id', 'untrusted') WHERE kind = 'workflow.node.checkpoint_recorded'").run();
    } else if (unsafe === "checkpoint source") {
      (store as unknown as { db: Database.Database }).db.prepare("UPDATE workflow_events SET source = 'renderer' WHERE kind = 'workflow.node.checkpoint_recorded'").run();
    } else if (unsafe === "active work") {
      store.appendWorkflowEvent({ sessionId: request.sessionId, kind: "workflow.segment.started", source: "test", now,
        payload: { segment: { id: "active", laneId: "other", runId: "active", status: "running" } } });
    } else if (unsafe === "delivery") {
      store.appendWorkflowEvent({ sessionId: request.sessionId, kind: "workflow.remote_side_effect.requested", source: "backend", now, payload: {} });
    } else {
      store.createWorkflowSession({ id: "session-2", projectId: "project-1", title: "Other", goal: "Other", mode: "fast", target: { executionTarget: "current_branch", selectedBranch: "main" },
        plannerProfile: "default", transport: "hermes_replay_recovery", recoveryReason: "SQLite test", now });
      store.appendWorkflowEvent({ sessionId: "session-2", kind: "node_declared", source: "test", now, idempotencyKey: `retry:${request.requestId}`, payload: {} });
    }
    const count = writes(store);
    expect(() => store.retryWorkflowLane(request, now)).toThrow();
    expect(writes(store)).toBe(count);
  });
});
