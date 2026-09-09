import { mkdtemp, mkdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";
import { afterEach, describe, expect, it } from "vitest";
import type { RunEvidence } from "@skyturn/project-core";
import { createWorkflowStore, type AppendWorkflowEventInput, type RecordRunResultInput } from "./workflowStore.js";

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

function reopenFixture(f: Awaited<ReturnType<typeof fixture>>) {
  f.store.close();
  stores.splice(stores.indexOf(f.store), 1);
  f.store = open(f.root);
}
function storeSnapshot(store: ReturnType<typeof createWorkflowStore>) {
  const db = (store as unknown as { db: Database.Database }).db;
  return { writes: writes(store), rows: db.prepare("SELECT * FROM workflow_events ORDER BY session_id, seq").all(),
    view: store.materializeWorkflowView("session-1") };
}
function addChild(store: ReturnType<typeof createWorkflowStore>) {
  store.appendWorkflowEvent({ sessionId: "session-1", kind: "workflow.lane.declared", source: "test", now,
    payload: { lane: { id: "lane-b", semanticKey: "lane-b", kind: "implementation", title: "Child", agentKind: "codex" } } });
  store.appendWorkflowEvent({ sessionId: "session-1", kind: "workflow.edge.declared", source: "test", now,
    payload: { edge: { sourceLaneId: "lane-a", targetLaneId: "lane-b" } } });
}
function resultFor(f: Awaited<ReturnType<typeof fixture>>, runId: string, segmentId: string, status: RunEvidence["status"] = "succeeded"): RecordRunResultInput {
  return { ...f.terminal, runId, segmentId, evidence: { ...f.terminal.evidence, runId, status,
    exitCode: status === "succeeded" ? 0 : 1, errorReason: status === "succeeded" ? null : "Failed" },
    runEvents: [{ protocolVersion: 1, runId, seq: 1, timestamp: now, kind: "output", payload: { text: "  Retry\r\n\n" } }] };
}

const genericCases = ["foreign start", "exact renderer start", "converted start", "spoof scheduler start", "spoof workflow-scheduler start", "cross lane start", "outer lane start",
  "cross session start", "padded start", "evidence", "foreign evidence", "cross lane evidence", "cross session evidence", "missing run evidence",
  "output", "foreign output", "cross lane output", "cross session output", "finish", "foreign finish", "cross lane finish", "cross session finish",
  "declared", "semantic alias", "padded declared", "padded semantic alias", "lane status", "legacy lane status", "legacy declared", "legacy start", "legacy evidence", "legacy output", "legacy finish", "join"] as const;

describe("SQLite Retry lifecycle authority", () => {
  it.each(genericCases)("rejects generic %s before every write, including reopened paused reservations", async (kind) => {
    const f = await fixture("current_branch");
    addChild(f.store);
    f.store.pauseWorkflowScheduling({ sessionId: "session-1", requestId: "pause", expectedStatus: "active", expectedRevision: 0, now });
    const retry = f.store.retryWorkflowLane(f.request, now).view.projection.lanes.find((lane) => lane.id === "lane-a")!.retryAttempt!;
    f.store.createWorkflowSession({ id: "session-2", projectId: "project-1", title: "Other", goal: "Other", mode: "fast",
      target: { executionTarget: "current_branch", selectedBranch: "main" }, plannerProfile: "default", transport: "hermes_replay_recovery", recoveryReason: "SQLite test", now });
    const result = resultFor(f, retry.runId, retry.segmentId);
    const input: AppendWorkflowEventInput = { sessionId: kind.includes("cross session") ? "session-2" : "session-1", source: "renderer", now,
      kind: "workflow.segment.started", payload: { laneId: "lane-a", segment: { id: retry.segmentId, laneId: "lane-a", runId: retry.runId, status: "running", exitCode: null } } };
    if (kind.includes("evidence")) {
      input.kind = "workflow.evidence.recorded";
      input.payload = { laneId: "lane-a", segmentId: retry.segmentId, evidence: { id: "forged", kind: "run-exit", status: "passed",
        ...(kind === "missing run evidence" ? {} : { runEvidence: { ...result.evidence, runId: kind === "foreign evidence" ? "foreign" : retry.runId } }) } };
    } else if (kind.includes("output")) {
      input.kind = "workflow.segment.output_delta";
      input.payload = { laneId: "lane-a", segmentId: retry.segmentId, delta: { ...(result.runEvents![0] as object), runId: kind === "foreign output" ? "foreign" : retry.runId } };
    } else if (kind.includes("finish")) {
      input.kind = "workflow.segment.finished";
      input.payload = { laneId: "lane-a", segmentId: retry.segmentId, runId: kind === "foreign finish" ? "foreign" : retry.runId, status: "succeeded", exitCode: 0 };
    } else if (kind.includes("declared") || kind.includes("semantic alias")) {
      input.kind = "workflow.lane.declared";
      input.payload = { lane: { id: kind.includes("semantic alias") ? "alias" : "lane-a", semanticKey: "lane-a", kind: "implementation", title: "Forged", agentKind: "codex", status: "completed", output: ["Forged"] } };
    } else if (kind.includes("lane status")) {
      input.kind = "workflow.lane.status_changed" as never;
      input.payload = { laneId: "lane-a", status: "completed" };
    } else if (kind === "join") {
      input.kind = "workflow.join.completed";
      input.payload = { laneId: "lane-a" };
    }
    if (kind.startsWith("padded")) {
      for (const object of [input.payload, input.payload.segment, input.payload.lane]) {
        if (!object) continue;
        const fields = object as Record<string, unknown>;
        for (const key of ["laneId", "id", "runId", "semanticKey"]) {
          if (typeof fields[key] === "string") fields[key] = ` ${fields[key]} `;
        }
      }
    }
    if (kind === "foreign start") (input.payload.segment as Record<string, unknown>).runId = "foreign";
    if (kind.includes("cross lane")) {
      input.payload.laneId = "lane-b";
      if (input.payload.segment) (input.payload.segment as Record<string, unknown>).laneId = "lane-b";
    }
    if (kind === "outer lane start") input.laneId = "lane-b";
    if (kind === "converted start") input.source = "codex";
    if (kind.startsWith("spoof")) {
      input.source = kind === "spoof scheduler start" ? "scheduler" : "workflow-scheduler";
      input.idempotencyKey = `schedule:${retry.segmentId}:started`;
    }
    if (kind.startsWith("legacy")) {
      input.kind = ({ "legacy lane status": "lane_status_changed", "legacy declared": "node_declared", "legacy start": "segment_started",
        "legacy evidence": "segment_evidence", "legacy output": "segment_output_delta", "legacy finish": "segment_finished" } as const)[kind as "legacy start"];
      input.laneId = "lane-a";
      input.segmentId = retry.segmentId;
    }
    for (const paused of [true, false]) {
      if (!paused) f.store.resumeWorkflowScheduling({ sessionId: "session-1", requestId: "resume", expectedStatus: "paused", expectedRevision: 1, now });
      for (const reopened of [false, true]) {
        if (reopened) reopenFixture(f);
        const before = storeSnapshot(f.store);
        expect(() => f.store.appendWorkflowEvent(input)).toThrow();
        expect(storeSnapshot(f.store)).toEqual(before);
        if (paused) expect(f.store.scheduleReadyLanes("session-1", { now }).readyLanes).toEqual([]);
        else expect(f.store.previewReadyLanes("session-1", {}).readyLanes.map((lane) => lane.id)).toEqual(["lane-a"]);
      }
    }
  });

  it.each(["reserved", "running", "succeeded", "failed"] as const)("rejects foreign result identity in %s phase without writes", async (phase) => {
    const f = await fixture("current_branch");
    addChild(f.store);
    const retry = f.store.retryWorkflowLane(f.request, now).view.projection.lanes[0]!.retryAttempt!;
    const result = resultFor(f, retry.runId, retry.segmentId, phase === "failed" ? "failed" : "succeeded");
    if (phase !== "reserved") expect(f.store.scheduleReadyLanes("session-1", { now }).readyLanes[0]?.runId).toBe(retry.runId);
    if (phase === "succeeded" || phase === "failed") f.store.recordRunResult(result);
    for (const reopened of [false, true]) {
      if (reopened) reopenFixture(f);
      const before = storeSnapshot(f.store);
      const invalid = [
        { ...result, runId: "foreign", evidence: { ...result.evidence, runId: "foreign" } },
        { ...result, segmentId: "foreign" }, { ...result, laneId: "lane-b" }, { ...result, sessionId: "session-2" },
        { ...result, evidence: { ...result.evidence, runId: "foreign" } },
        { ...result, runEvents: [{ ...(result.runEvents![0] as object), runId: "foreign" }] },
      ];
      if (phase === "reserved") invalid.push(result);
      if (phase === "succeeded" || phase === "failed") invalid.push({ ...result, evidence: { ...result.evidence,
        status: phase === "succeeded" ? "failed" : "succeeded", exitCode: phase === "succeeded" ? 1 : 0 } });
      for (const input of invalid) {
        expect(() => f.store.recordRunResult(input)).toThrow();
        expect(storeSnapshot(f.store)).toEqual(before);
      }
      const generic = { sessionId: "session-1", source: "codex", now, kind: "workflow.evidence.recorded" as const,
        payload: { laneId: "lane-a", segmentId: retry.segmentId, evidence: { id: "foreign", kind: "run-exit", status: "passed",
          runEvidence: { ...result.evidence, runId: "foreign", status: "succeeded", exitCode: 0, errorReason: null } } } };
      expect(() => f.store.appendWorkflowEvent(generic)).toThrow();
      expect(storeSnapshot(f.store)).toEqual(before);
      for (const laneId of ["lane-a", "lane-b"]) {
        expect(() => f.store.appendWorkflowEvent({ ...generic, kind: "workflow.segment.output_delta", payload: {
          laneId, segmentId: retry.segmentId, delta: { ...(result.runEvents![0] as object), runId: "foreign" } } })).toThrow();
        expect(storeSnapshot(f.store)).toEqual(before);
      }
      expect(() => f.store.appendWorkflowEvent({ ...generic, kind: "workflow.segment.finished", payload: {
        laneId: "lane-a", segmentId: retry.segmentId, status: phase === "succeeded" ? "failed" : "succeeded", exitCode: phase === "succeeded" ? 1 : 0 } })).toThrow();
      expect(storeSnapshot(f.store)).toEqual(before);
    }
  });

  it.each(["current_branch", "new_worktree"] as const)("reopens a genuinely scheduled %s retry, records exact output and releases only its child", async (target) => {
    const f = await fixture(target);
    addChild(f.store);
    const original = f.store.materializeFlowProjection("session-1");
    const retry = f.store.retryWorkflowLane(f.request, now).view.projection.lanes[0]!.retryAttempt!;
    const ready = f.store.scheduleReadyLanes("session-1", { now }).readyLanes;
    expect(ready.map((lane) => [lane.id, lane.runId, lane.segmentId])).toEqual([["lane-a", retry.runId, retry.segmentId]]);
    reopenFixture(f);
    const result = resultFor(f, retry.runId, retry.segmentId);
    const completed = f.store.recordRunResult(result);
    expect(completed.lanes.find((lane) => lane.id === "lane-a")).toMatchObject({ status: "completed", output: ["Original output\n", "  Retry\r\n\n"] });
    expect(completed.segments[0]).toEqual(original.segments[0]);
    expect(completed.evidence[0]).toEqual(original.evidence[0]);
    for (const reopened of [false, true]) {
      if (reopened) reopenFixture(f);
      const before = storeSnapshot(f.store);
      expect(f.store.recordRunResult(result)).toEqual(completed);
      expect(f.store.recordRunResult(f.terminal)).toEqual(completed);
      for (const event of f.store.listEvents("session-1").filter((event) =>
        event.kind === "workflow.segment.started" || event.kind === "workflow.segment.output_delta" ||
        event.kind === "workflow.evidence.recorded" || event.kind === "workflow.segment.finished")) {
        expect(f.store.appendWorkflowEvent({ ...event, now })).toEqual(event);
      }
      expect(storeSnapshot(f.store)).toEqual(before);
    }
    expect(f.store.scheduleReadyLanes("session-1", { now }).readyLanes.map((lane) => lane.id)).toEqual(["lane-b"]);
  });
});
