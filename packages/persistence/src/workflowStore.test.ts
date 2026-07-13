import { mkdtemp, readFile, realpath, rm, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import Database from "better-sqlite3";
import { afterEach, describe, expect, it } from "vitest";

import {
  createWorkflowStore,
  type WorkflowCardCreateInput,
  type WorkflowCardToolCall,
} from "./workflowStore.js";
import type { RunEvent, RunEvidence, WorkflowWorktreeIdentity } from "@skyturn/project-core";
import {
  compileInsertClarificationBefore,
  scheduleReadyLanes,
  type FlowEvent,
  type FlowEventKind,
  type WorkflowIntent,
} from "@skyturn/workflow-kernel";

const roots: string[] = [];
const hermesHandlePhysicalCleanup = "hermes_handle_physical_cleanup_v1";

afterEach(async () => {
  await Promise.all(roots.map((root) => rm(root, { recursive: true, force: true })));
  roots.length = 0;
});

describe("SQLite workflow store", () => {
  it("never persists or returns a raw Hermes resume handle", async () => {
    const projectRoot = await makeTempRoot();
    const rawHandle = "Bearer resume-secret path=/Users/alice/private password=hunter2";
    const store = createWorkflowStore({ projectRoot });
    store.createWorkflowSession({
      id: "session-resume",
      projectId: "project-1",
      title: "Resume Hermes",
      goal: "Continue planning",
      mode: "fast",
      plannerProfile: "default",
      transport: "hermes_session_resume",
      opaqueHandle: rawHandle,
      now: "2026-06-14T00:00:00.000Z",
    });

    expect(JSON.stringify(store.listHermesSessions("session-resume"))).not.toContain(rawHandle);
    expect(store.listHermesSessions("session-resume")[0]?.opaqueHandle).toBe("[redacted]");
    store.close();

    const db = new Database(join(projectRoot, ".devflow", "skyturn-workflow.sqlite"), { readonly: true });
    expect(db.prepare("SELECT opaque_handle FROM hermes_sessions WHERE workflow_session_id = ?").get("session-resume")).toEqual({
      opaque_handle: "[redacted]",
    });
    db.close();

    const reopened = createWorkflowStore({ projectRoot });
    const serialized = JSON.stringify({
      sessions: reopened.listHermesSessions("session-resume"),
      events: reopened.listEvents("session-resume"),
    });
    expect(serialized).not.toMatch(/resume-secret|alice|hunter2/);
    expect(reopened.listHermesSessions("session-resume")[0]?.opaqueHandle).toBe("[redacted]");
    reopened.close();
  });

  it("physically redacts schema-current legacy Hermes handles across reopen and repeated migration", async () => {
    const projectRoot = await makeTempRoot();
    const rawHandle = "legacy-schema-current-resume-capability-123456";
    const store = createWorkflowStore({ projectRoot });
    store.createWorkflowSession({
      id: "session-legacy-current",
      projectId: "project-1",
      title: "Legacy resume",
      goal: "Continue planning",
      mode: "fast",
      plannerProfile: "default",
      transport: "hermes_session_resume",
      opaqueHandle: "current-write-redacted",
      now: "2026-06-14T00:00:00.000Z",
    });
    store.close();
    seedLegacyHermesHandle(projectRoot, "session-legacy-current", rawHandle);

    for (let attempt = 0; attempt < 2; attempt += 1) {
      const reopened = createWorkflowStore({ projectRoot });
      expect(reopened.listHermesSessions("session-legacy-current")[0]?.opaqueHandle).toBe("[redacted]");
      expect(reopened.listAppliedMigrations()).toContain(5);
      reopened.close();
      await expectRawHandleAbsent(projectRoot, rawHandle);
    }
  });

  it("physically redacts legacy Hermes handles while completing older migration markers", async () => {
    const projectRoot = await makeTempRoot();
    const rawHandle = "legacy-old-schema-resume-capability-654321";
    const store = createWorkflowStore({ projectRoot });
    store.createWorkflowSession({
      id: "session-legacy-old",
      projectId: "project-1",
      title: "Old legacy resume",
      goal: "Continue planning",
      mode: "fast",
      plannerProfile: "default",
      transport: "hermes_session_resume",
      opaqueHandle: "current-write-redacted",
      now: "2026-06-14T00:00:00.000Z",
    });
    store.close();
    seedLegacyHermesHandle(projectRoot, "session-legacy-old", rawHandle, true);

    const reopened = createWorkflowStore({ projectRoot });
    expect(reopened.listAppliedMigrations()).toEqual([1, 2, 3, 4, 5, 6, 7]);
    expect(reopened.listHermesSessions("session-legacy-old")[0]?.opaqueHandle).toBe("[redacted]");
    reopened.close();
    await expectRawHandleAbsent(projectRoot, rawHandle);
  });

  it.each([
    ["old database without v5", "absent", "absent"],
    ["v5 database without physical completion", "present", "absent"],
    ["schema-current database containing a raw handle", "present", "complete"],
  ] as const)("physically cleans %s and records completion exactly once", async (_name, v5, physicalState) => {
    const projectRoot = await makeTempRoot();
    const rawHandle = `legacy-${v5}-${physicalState}-resume-capability-123456`;
    seedHermesHandleCleanupCase(projectRoot, rawHandle, { v5, physicalState });
    const firstTrace: string[] = [];

    const first = createWorkflowStore({
      projectRoot,
      faultInjection: maintenanceFaultInjection({ trace: firstTrace }),
    });
    expect(first.listAppliedMigrations()).toEqual([1, 2, 3, 4, 5, 6, 7]);
    expect(first.listHermesSessions("session-maintenance")[0]?.opaqueHandle).toBe("[redacted]");
    first.close();

    expect(firstTrace).toEqual(hermesHandlePhysicalCleanupSqlTrace);
    expect(readHermesHandlePhysicalCleanupState(projectRoot)).toBe("complete");
    await expectRawHandleAbsent(projectRoot, rawHandle);

    const secondTrace: string[] = [];
    const second = createWorkflowStore({
      projectRoot,
      faultInjection: maintenanceFaultInjection({ trace: secondTrace }),
    });
    second.close();
    expect(secondTrace).toEqual([]);
    expect(readHermesHandlePhysicalCleanupState(projectRoot)).toBe("complete");
  });

  it("does not repeat physical cleanup for an already-complete database", async () => {
    const projectRoot = await makeTempRoot();
    const first = createWorkflowStore({ projectRoot });
    first.close();
    expect(readHermesHandlePhysicalCleanupState(projectRoot)).toBe("complete");

    const trace: string[] = [];
    const reopened = createWorkflowStore({
      projectRoot,
      faultInjection: maintenanceFaultInjection({ trace }),
    });
    reopened.close();

    expect(trace).toEqual([]);
  });

  it.each([
    ["initial checkpoint busy", "initial-checkpoint"],
    ["VACUUM SQLITE_FULL", "vacuum"],
    ["completion marker write", "marker-write"],
    ["final checkpoint busy", "final-checkpoint"],
  ] as const)("retries Hermes handle physical cleanup after %s failure", async (_name, fault) => {
    const projectRoot = await makeTempRoot();
    const rawHandle = `legacy-${fault}-resume-capability-987654`;
    seedHermesHandleCleanupCase(projectRoot, rawHandle, { v5: "absent", physicalState: "absent" });
    const failedTrace: string[] = [];

    expect(() => createWorkflowStore({
      projectRoot,
      faultInjection: maintenanceFaultInjection({ trace: failedTrace, fault }),
    })).toThrow(fault === "vacuum"
      ? /SQLITE_FULL/
      : fault === "marker-write"
        ? /marker write/
        : /checkpoint failed/);
    expect(failedTrace).toContain(fault === "initial-checkpoint"
      ? "PRAGMA wal_checkpoint(TRUNCATE)"
      : fault === "vacuum"
        ? "VACUUM"
        : fault === "final-checkpoint"
          ? "PRAGMA wal_checkpoint(TRUNCATE)"
          : "INSERT INTO workflow_maintenance(name, state, completed_at) VALUES (?, 'complete', datetime('now'))");
    expect(readHermesHandlePhysicalCleanupState(projectRoot)).not.toBe("complete");

    const retryTrace: string[] = [];
    const reopened = createWorkflowStore({
      projectRoot,
      faultInjection: maintenanceFaultInjection({ trace: retryTrace }),
    });
    expect(reopened.listAppliedMigrations()).toContain(5);
    expect(reopened.listHermesSessions("session-maintenance")[0]?.opaqueHandle).toBe("[redacted]");
    reopened.close();

    expect(retryTrace).toEqual(hermesHandlePhysicalCleanupSqlTrace);
    expect(readHermesHandlePhysicalCleanupState(projectRoot)).toBe("complete");
    await expectRawHandleAbsent(projectRoot, rawHandle);

    const finalTrace: string[] = [];
    const final = createWorkflowStore({
      projectRoot,
      faultInjection: maintenanceFaultInjection({ trace: finalTrace }),
    });
    final.close();
    expect(finalTrace).toEqual([]);
  });

  it("rejects a ready insert-before target and preserves the graph across restart", async () => {
    const projectRoot = await makeTempRoot();
    const store = createWorkflowStore({ projectRoot });
    seedStore(store);
    declareCodeChangeWorkflow(store);
    const target = store.materializeFlowProjection("session-1").lanes.find((lane) => lane.id === "lane-validation");
    expect(target).toBeDefined();
    store.appendWorkflowEvent({
      sessionId: "session-1",
      kind: "workflow.lane.declared",
      source: "test",
      idempotencyKey: "lane-validation:ready",
      payload: { lane: { ...target, status: "ready" } },
      now: "2026-06-14T00:00:02.500Z",
    });
    const before = store.materializeFlowProjection("session-1");

    expect(() => store.insertClarificationBefore({
      sessionId: "session-1", targetLaneId: "lane-validation", requestId: "reject-ready", now: "2026-06-14T00:00:03.000Z",
    })).toThrow(/eligible pending lane/i);
    expect(store.materializeFlowProjection("session-1")).toEqual(before);
    store.close();

    const reopened = createWorkflowStore({ projectRoot });
    expect(reopened.materializeFlowProjection("session-1")).toEqual(before);
    expect(reopened.materializeFlowProjection("session-1").lanes.find((lane) => lane.id === "lane-validation")?.status).toBe("ready");
    reopened.close();
  });

  it("rejects conflicting insert-before requestId without changing the graph", async () => {
    const store = createWorkflowStore({ projectRoot: await makeTempRoot() });
    seedStore(store);
    declareCodeChangeWorkflow(store);
    store.insertClarificationBefore({ sessionId: "session-1", targetLaneId: "lane-validation", requestId: "same-request", now: "2026-06-14T00:00:03.000Z" });
    const before = store.materializeFlowProjection("session-1");
    expect(() => store.insertClarificationBefore({ sessionId: "session-1", targetLaneId: "lane-review", requestId: "same-request", now: "2026-06-14T00:00:04.000Z" })).toThrow(/conflicts/i);
    expect(store.materializeFlowProjection("session-1")).toEqual(before);
    store.close();
  });

  it.each(["append", "projection"] as const)("rolls back insert-before when %s validation fails", async (failure) => {
    let armed = false;
    const store = createWorkflowStore({
      projectRoot: await makeTempRoot(),
      faultInjection: {
        beforeInsertBeforeAppend: () => { if (armed && failure === "append") throw new Error("injected append failure"); },
        afterInsertBeforeProjection: () => { if (armed && failure === "projection") throw new Error("injected projection failure"); },
      },
    });
    seedStore(store);
    declareCodeChangeWorkflow(store);
    const before = store.materializeFlowProjection("session-1");
    armed = true;
    expect(() => store.insertClarificationBefore({ sessionId: "session-1", targetLaneId: "lane-validation", requestId: `fail-${failure}`, now: "2026-06-14T00:00:03.000Z" })).toThrow(`injected ${failure} failure`);
    armed = false;
    expect(store.materializeFlowProjection("session-1")).toEqual(before);
    store.close();
  });

  it("recovers the authoritative graph on identical retry after response delivery fails", async () => {
    const store = createWorkflowStore({ projectRoot: await makeTempRoot() });
    seedStore(store);
    declareCodeChangeWorkflow(store);
    const request = { sessionId: "session-1", targetLaneId: "lane-validation", requestId: "response-retry", now: "2026-06-14T00:00:03.000Z" };
    const committed = store.insertClarificationBefore(request);
    expect(() => { throw new Error("injected response failure"); }).toThrow("injected response failure");
    const retry = store.insertClarificationBefore({ ...request, now: "2026-06-14T00:00:04.000Z" });
    expect(retry.event.id).toBe(committed.event.id);
    expect(retry.projection).toEqual(committed.projection);
    expect(retry.canvasSession).toEqual(committed.canvasSession);
    store.close();
  });

  it("reuses target A's durable insert request after a lost response and a target B request", async () => {
    const store = createWorkflowStore({ projectRoot: await makeTempRoot() });
    seedStore(store);
    declareCodeChangeWorkflow(store);

    const firstA = store.insertClarificationBefore({
      sessionId: "session-1",
      targetLaneId: "lane-validation",
      requestId: "target-a-original",
      now: "2026-06-14T00:00:03.000Z",
    });
    store.insertClarificationBefore({
      sessionId: "session-1",
      targetLaneId: "lane-review",
      requestId: "target-b-original",
      now: "2026-06-14T00:00:04.000Z",
    });
    const retryA = store.insertClarificationBefore({
      sessionId: "session-1",
      targetLaneId: "lane-validation",
      requestId: "target-a-after-switch",
      now: "2026-06-14T00:00:05.000Z",
    });

    expect(retryA.event.id).toBe(firstA.event.id);
    expect(retryA.event.payload.requestId).toBe("target-a-original");
    expect(insertBeforeEventsForTarget(store, "lane-validation")).toHaveLength(1);
    expect(insertBeforeEventsForTarget(store, "lane-review")).toHaveLength(1);
    expect(retryA.projection.lanes.filter((lane) => lane.id === firstA.lane.id)).toHaveLength(1);
    store.close();
  });

  it("reuses a pending durable insert request after the request tracker and SQLite store restart", async () => {
    const projectRoot = await makeTempRoot();
    const store = createWorkflowStore({ projectRoot });
    seedStore(store);
    declareCodeChangeWorkflow(store);
    const first = store.insertClarificationBefore({
      sessionId: "session-1",
      targetLaneId: "lane-validation",
      requestId: "before-renderer-restart",
      now: "2026-06-14T00:00:03.000Z",
    });
    store.close();

    const reopened = createWorkflowStore({ projectRoot });
    const retry = reopened.insertClarificationBefore({
      sessionId: "session-1",
      targetLaneId: "lane-validation",
      requestId: "after-renderer-restart",
      now: "2026-06-14T00:00:04.000Z",
    });

    expect(retry.event.id).toBe(first.event.id);
    expect(retry.event.payload.requestId).toBe("before-renderer-restart");
    expect(insertBeforeEventsForTarget(reopened, "lane-validation")).toHaveLength(1);
    expect(retry.projection.lanes.filter((lane) => lane.id === first.lane.id)).toHaveLength(1);
    reopened.close();
  });

  it("persists insert-before topology idempotently across restart", async () => {
    const projectRoot = await makeTempRoot();
    const store = createWorkflowStore({ projectRoot });
    seedStore(store);
    declareCodeChangeWorkflow(store);

    const first = store.insertClarificationBefore({
      sessionId: "session-1",
      targetLaneId: "lane-validation",
      requestId: "insert-before-validation-1",
      now: "2026-06-14T00:00:03.000Z",
    });
    const duplicate = store.insertClarificationBefore({
      sessionId: "session-1",
      targetLaneId: "lane-validation",
      requestId: "insert-before-validation-1",
      now: "2026-06-14T00:00:04.000Z",
    });

    expect(duplicate.event.id).toBe(first.event.id);
    expect(first.projection.lanes.filter((lane) => lane.id === first.lane.id)).toHaveLength(1);
    expect(first.projection.edges.map((edge) => [edge.sourceLaneId, edge.targetLaneId])).toContainEqual([
      "lane-implementation",
      first.lane.id,
    ]);
    expect(first.projection.edges.map((edge) => [edge.sourceLaneId, edge.targetLaneId])).toContainEqual([
      first.lane.id,
      "lane-validation",
    ]);
    expect(first.projection.edges.map((edge) => [edge.sourceLaneId, edge.targetLaneId])).not.toContainEqual([
      "lane-implementation",
      "lane-validation",
    ]);
    const planner = first.canvasSession?.nodes.find((node) => node.id === first.canvasSession?.plannerNodeId);
    expect(planner?.context.dependencies).toEqual([]);
    expect(first.canvasSession?.edges.some((edge) => edge.target === planner?.id)).toBe(false);
    store.close();

    const reopened = createWorkflowStore({ projectRoot });
    expect(reopened.materializeFlowProjection("session-1")).toEqual(first.projection);
    const restartedCanvasSession = reopened.materializeCanvasSession("session-1");
    expect(restartedCanvasSession).toEqual(first.canvasSession);
    const restartedPlanner = restartedCanvasSession?.nodes.find((node) => node.id === restartedCanvasSession.plannerNodeId);
    const restartedTarget = restartedCanvasSession?.nodes.find((node) => node.id === "lane-validation");
    expect(restartedPlanner?.context.dependencies).toEqual([]);
    expect(restartedCanvasSession?.edges.some((edge) => edge.target === restartedPlanner?.id)).toBe(false);
    expect(restartedTarget?.context.dependencies).toEqual([first.lane.id]);
    expect(restartedTarget?.status).toBe("pending");
    reopened.close();
  });

  it("preserves a ReplanFromEvidence Repair chain and scheduling across SQLite reopen", async () => {
    const projectRoot = await makeTempRoot();
    const store = createWorkflowStore({ projectRoot });
    seedStore(store);
    declareCodeChangeWorkflow(store);
    advanceCodeChangeWorkflowToLane(store, "lane-implementation");
    store.recordRunResult(runResultInput(store, "lane-implementation", "failed", "2026-06-14T00:00:07.000Z"));
    const evidenceId = "evidence-segment-session-1-lane-implementation";
    const replan = store.applyWorkflowIntent({
      intentId: "intent-replan-insert-before",
      sessionId: "session-1",
      operations: [{ type: "ReplanFromEvidence", laneId: "lane-implementation", evidenceId }],
    }, "2026-06-14T00:00:08.000Z");
    expect(replan.ok).toBe(true);

    const before = store.materializeFlowProjection("session-1");
    const repair = before.lanes.find((lane) => lane.semanticKey === `repair:lane-implementation:${evidenceId}`);
    const regression = before.lanes.find((lane) => lane.semanticKey === `regression:lane-implementation:${evidenceId}`);
    expect(repair).toBeDefined();
    expect(regression).toBeDefined();
    if (!repair || !regression) throw new Error("ReplanFromEvidence did not create its repair chain.");
    expect(scheduleReadyLanes(before, { allowedParallelism: 2 }).map((lane) => lane.id)).toEqual([repair.id]);

    const inserted = store.insertClarificationBefore({
      sessionId: "session-1",
      targetLaneId: repair.id,
      requestId: "persist-replan-repair",
      now: "2026-06-14T00:00:09.000Z",
    });
    const expectedRepairEdges = [
      {
        id: `edge-implementation-${repair.id.replace(/^lane-/, "")}`,
        sourceLaneId: "lane-implementation",
        targetLaneId: repair.id,
      },
      {
        id: `edge-${repair.id.replace(/^lane-/, "")}-${regression.id.replace(/^lane-/, "")}`,
        sourceLaneId: repair.id,
        targetLaneId: regression.id,
      },
      {
        id: `edge-${inserted.lane.id}-${repair.id}`,
        sourceLaneId: inserted.lane.id,
        targetLaneId: repair.id,
      },
    ];
    expect(inserted.projection.edges.filter((edge) =>
      edge.targetLaneId === repair.id ||
      edge.sourceLaneId === repair.id
    )).toEqual(expectedRepairEdges);
    expect(scheduleReadyLanes(inserted.projection, { allowedParallelism: 2 }).map((lane) => lane.id)).toEqual([inserted.lane.id]);
    const insertedEdges = structuredClone(inserted.projection.edges);
    store.close();

    const reopened = createWorkflowStore({ projectRoot });
    const replayed = reopened.materializeFlowProjection("session-1");
    expect(replayed.edges).toEqual(insertedEdges);
    expect(scheduleReadyLanes(replayed, { allowedParallelism: 2 }).map((lane) => lane.id)).toEqual([inserted.lane.id]);
    reopened.appendWorkflowEvent({
      sessionId: "session-1",
      kind: "workflow.evidence.recorded",
      source: "test",
      laneId: inserted.lane.id,
      segmentId: `segment-${inserted.lane.id}`,
      idempotencyKey: `evidence:${inserted.lane.id}:completed`,
      payload: {
        laneId: inserted.lane.id,
        segmentId: `segment-${inserted.lane.id}`,
        evidence: {
          id: `evidence-${inserted.lane.id}`,
          kind: "run-exit",
          status: "passed",
          checks: ["run-exit:succeeded"],
          artifacts: [],
        },
      },
      now: "2026-06-14T00:00:10.000Z",
    });
    const completed = reopened.materializeFlowProjection("session-1");
    expect(completed.edges).toEqual(insertedEdges);
    expect(scheduleReadyLanes(completed, { allowedParallelism: 2 }).map((lane) => lane.id)).toEqual([repair.id]);
    reopened.close();

    const completedReopen = createWorkflowStore({ projectRoot });
    const completedReplay = completedReopen.materializeFlowProjection("session-1");
    expect(completedReplay.edges).toEqual(insertedEdges);
    expect(scheduleReadyLanes(completedReplay, { allowedParallelism: 2 }).map((lane) => lane.id)).toEqual([repair.id]);
    completedReopen.close();
  });

  it.each([
    ["null idempotency key", null, "restart-envelope"],
    ["wrong idempotency key", "insert-before:wrong-request", "restart-envelope"],
    ["envelope and payload request mismatch", "insert-before:restart-envelope", "other-request"],
  ])("fails closed after SQLite restart with insert-before %s", async (_label, idempotencyKey, payloadRequestId) => {
    const projectRoot = await makeTempRoot();
    const store = createWorkflowStore({ projectRoot });
    seedStore(store);
    declareCodeChangeWorkflow(store);
    const before = store.materializeFlowProjection("session-1");
    const compiled = compileInsertClarificationBefore(before, {
      sessionId: "session-1", targetLaneId: "lane-validation", requestId: "restart-envelope",
    }, "2026-06-14T00:00:03.000Z");
    appendCompiledFlowEvent(store, {
      ...compiled.event,
      idempotencyKey,
      payload: { ...compiled.event.payload, requestId: payloadRequestId },
    });
    expect(store.listEvents("session-1").at(-1)).toMatchObject({
      kind: "workflow.lane.inserted_before",
      idempotencyKey,
    });
    store.close();

    const reopened = createWorkflowStore({ projectRoot });
    expect(() => reopened.materializeFlowProjection("session-1")).toThrow(/insert-before replay/i);
    expect(() => reopened.insertClarificationBefore({
      sessionId: "session-1", targetLaneId: "lane-validation", requestId: "restart-envelope", now: "2026-06-14T00:00:04.000Z",
    })).toThrow(/insert-before replay|conflicts/i);
    reopened.close();
  });

  it.each([
    ["source", (event: FlowEvent) => { event.source = "hermes"; }],
    ["brief", (event: FlowEvent) => { insertBeforeLanePayload(event).brief = "Injected instructions"; }],
    ["output", (event: FlowEvent) => { insertBeforeLanePayload(event).output = ["Injected prompt context"]; }],
    ["side effects", (event: FlowEvent) => {
      (insertBeforeLanePayload(event).runtimePolicy as Record<string, unknown>).sideEffects = ["git"];
    }],
  ] as const)("fails closed after SQLite reopen with non-canonical insert-before %s", async (_label, mutate) => {
    const projectRoot = await makeTempRoot();
    const store = createWorkflowStore({ projectRoot });
    seedStore(store);
    declareCodeChangeWorkflow(store);
    const before = store.materializeFlowProjection("session-1");
    const compiled = compileInsertClarificationBefore(before, {
      sessionId: "session-1",
      targetLaneId: "lane-validation",
      requestId: "restart-canonical-payload",
    }, "2026-06-14T00:00:03.000Z");
    const tampered = structuredClone(compiled.event);
    mutate(tampered);
    appendCompiledFlowEvent(store, tampered);
    expect(before.lanes.some((lane) => lane.id === compiled.lane.id)).toBe(false);
    store.close();

    const reopened = createWorkflowStore({ projectRoot });
    expect(() => reopened.materializeFlowProjection("session-1")).toThrow(/insert-before replay/i);
    reopened.close();
  });

  it("returns the durable insert-before mutation for the same request after SQLite restart", async () => {
    const projectRoot = await makeTempRoot();
    const request = {
      sessionId: "session-1", targetLaneId: "lane-validation", requestId: "restart-retry", now: "2026-06-14T00:00:03.000Z",
    };
    const store = createWorkflowStore({ projectRoot });
    seedStore(store);
    declareCodeChangeWorkflow(store);
    const first = store.insertClarificationBefore(request);
    store.close();

    const reopened = createWorkflowStore({ projectRoot });
    const retry = reopened.insertClarificationBefore({ ...request, now: "2026-06-14T00:00:04.000Z" });
    expect(retry.event.id).toBe(first.event.id);
    expect(retry.projection).toEqual(first.projection);
    expect(retry.canvasSession).toEqual(first.canvasSession);
    reopened.close();
  });

  it.each(["planner pollution", "retained edge ID collision"] as const)(
    "fails closed after SQLite restart with preexisting %s before insert-before replay",
    async (failure) => {
      const projectRoot = await makeTempRoot();
      const store = createWorkflowStore({ projectRoot });
      seedStore(store);
      declareCodeChangeWorkflow(store);
      if (failure === "planner pollution") {
        store.appendWorkflowEvent({
          sessionId: "session-1",
          kind: "workflow.lane.declared",
          source: "test",
          idempotencyKey: "lane:planner-replay-pollution",
          payload: {
            lane: { id: "lane-planner", semanticKey: "planner:session-1", kind: "planner", title: "Planner", agentKind: "hermes", status: "pending" },
          },
          now: "2026-06-14T00:00:02.500Z",
        });
      }
      const request = {
        sessionId: "session-1",
        targetLaneId: "lane-validation",
        requestId: `restart-${failure.replaceAll(" ", "-")}`,
      };
      const compiled = compileInsertClarificationBefore(
        store.materializeFlowProjection("session-1"),
        request,
        "2026-06-14T00:00:03.000Z",
      );
      const generatedEdgeId = (compiled.event.payload.edges as Array<{ id: string }>)[0].id;
      store.appendWorkflowEvent({
        sessionId: "session-1",
        kind: "workflow.edge.declared",
        source: "test",
        idempotencyKey: `malformed:${failure}`,
        payload: {
          edge: failure === "planner pollution"
            ? { id: "edge-implementation-planner", sourceLaneId: "lane-implementation", targetLaneId: "lane-planner" }
            : { id: generatedEdgeId, sourceLaneId: "lane-implementation", targetLaneId: "lane-review" },
        },
        now: "2026-06-14T00:00:04.000Z",
      });
      appendCompiledFlowEvent(store, compiled.event);
      store.close();

      const reopened = createWorkflowStore({ projectRoot });
      expect(() => reopened.materializeFlowProjection("session-1")).toThrow(
        failure === "planner pollution" ? /planner|intake/i : /edge ID.*conflict/i,
      );
      expect(() => reopened.materializeCanvasSession("session-1")).toThrow(
        failure === "planner pollution" ? /planner|intake/i : /edge ID.*conflict/i,
      );
      reopened.close();
    },
  );

  it("initializes the SQLite schema in .devflow and applies migrations idempotently", async () => {
    const projectRoot = await makeTempRoot();
    const first = createWorkflowStore({ projectRoot });
    const firstMigrations = first.listAppliedMigrations();
    const pragmas = first.readPragmas();
    first.close();

    const second = createWorkflowStore({ projectRoot });

    expect(first.databasePath).toBe(join(await realpath(projectRoot), ".devflow", "skyturn-workflow.sqlite"));
    expect(pragmas.journalMode).toBe("wal");
    expect(pragmas.foreignKeys).toBe(1);
    expect(firstMigrations).toEqual([1, 2, 3, 4, 5, 6, 7]);
    expect(second.listAppliedMigrations()).toEqual([1, 2, 3, 4, 5, 6, 7]);
    second.close();
  });

  it("creates one stable Hermes session record for a CanvasSession", async () => {
    const store = await makeStore();

    const session = store.createWorkflowSession({
      id: "session-1",
      projectId: "project-1",
      title: "Persisted workflow",
      goal: "Implement event sourced workflow",
      mode: "fast",
      plannerProfile: "default",
      transport: "hermes_replay_recovery",
      recoveryReason: "Hermes live chat handle was not available during test setup.",
      now: "2026-06-14T00:00:00.000Z",
    });
    const duplicate = store.createWorkflowSession({
      id: "session-1",
      projectId: "project-1",
      title: "Persisted workflow",
      goal: "Implement event sourced workflow",
      mode: "fast",
      plannerProfile: "default",
      transport: "hermes_replay_recovery",
      recoveryReason: "Hermes live chat handle was not available during test setup.",
      now: "2026-06-14T00:00:01.000Z",
    });

    expect(duplicate).toEqual(session);
    expect(store.listHermesSessions("session-1")).toHaveLength(1);
    expect(store.listLanes("session-1")).toMatchObject([
      {
        id: session.plannerLaneId,
        laneKind: "planner",
        agentKind: "hermes",
        nodeId: "node-1",
        status: "running",
      },
    ]);
  });

  it("atomically grants planner segment ownership to only one SQLite store", async () => {
    const projectRoot = await makeTempRoot();
    const seed = createWorkflowStore({ projectRoot });
    seedStore(seed);
    seed.close();
    const stores = [
      createWorkflowStore({ projectRoot }),
      createWorkflowStore({ projectRoot }),
    ];
    const input = {
      sessionId: "session-1",
      laneId: "node-1",
      runId: "run-session-1-node-1-concurrent",
      agentKind: "hermes" as const,
      worktreePath: projectRoot,
      now: "2026-07-13T01:00:01.000Z",
    };

    const claims = await Promise.all(stores.map((store) => Promise.resolve().then(() => store.claimPlannerRunStart(input))));

    expect(claims.map((claim) => claim.created).sort()).toEqual([false, true]);
    expect(claims[0]?.segment).toEqual(claims[1]?.segment);
    expect(stores[0]?.listEvents("session-1").filter((event) =>
      event.idempotencyKey === `planner-run:${input.runId}:lane-running`
    )).toHaveLength(1);
    stores.forEach((store) => store.close());
  });

  it("persists default current branch session target facts", async () => {
    const store = await makeStore();

    const session = store.createWorkflowSession({
      id: "session-1",
      projectId: "project-1",
      title: "Persisted workflow",
      goal: "Implement on current branch",
      mode: "fast",
      plannerProfile: "default",
      transport: "hermes_replay_recovery",
      recoveryReason: "Hermes live chat handle was not available during test setup.",
      now: "2026-06-14T00:00:00.000Z",
    });
    const canvasSession = store.materializeCanvasSession("session-1");
    const started = store.listEvents("session-1").find((event) => event.kind === "hermes_session_started");

    expect(session.target).toEqual({
      executionTarget: "current_branch",
      selectedBranch: "HEAD",
    });
    expect(canvasSession?.target).toEqual(session.target);
    expect(canvasSession?.nodes[0]?.worktree).toMatchObject({
      path: ".",
      branchName: "HEAD",
      baseCommit: "HEAD",
      executionTarget: "current_branch",
      selectedBranch: "HEAD",
    });
    expect(started?.payload.target).toEqual(session.target);
  });

  it("resolves an omitted legacy HEAD target durably before checkpoint validation", async () => {
    const projectRoot = await makeTempRoot();
    const store = createWorkflowStore({ projectRoot });
    seedStore(store);
    declareCodeChangeWorkflow(store);
    advanceCodeChangeWorkflowToLane(store, "lane-implementation");
    expect(store.getWorkflowSession("session-1")?.target.selectedBranch).toBe("HEAD");
    store.close();

    const reopened = createWorkflowStore({ projectRoot });
    const resolved = reopened.resolveCurrentBranchTarget({
      sessionId: "session-1",
      branchName: "codex/persist-run-checkpoints",
      now: "2026-07-13T01:00:00.000Z",
    });
    const checkpoint = reopened.recordRunCheckpoint({
      sessionId: "session-1",
      nodeId: "lane-implementation",
      laneId: "lane-implementation",
      runId: "run-session-1-lane-implementation",
      segmentId: "segment-session-1-lane-implementation",
      phase: "before",
      executionTarget: "current_branch",
      worktreePath: projectRoot,
      branchName: "codex/persist-run-checkpoints",
      headCommit: "a".repeat(40),
      worktreeState: "clean",
      evidenceRefs: [{ kind: "run", id: "run-session-1-lane-implementation" }],
      now: "2026-07-13T01:00:01.000Z",
    });

    expect(resolved.target).toEqual({
      executionTarget: "current_branch",
      selectedBranch: "codex/persist-run-checkpoints",
    });
    expect(reopened.materializeCanvasSession("session-1")?.target).toEqual(resolved.target);
    expect(checkpoint.branchName).toBe("codex/persist-run-checkpoints");
    reopened.close();
  });

  it("persists new worktree target metadata without claiming a created worktree", async () => {
    const store = await makeStore();

    const session = store.createWorkflowSession({
      id: "session-1",
      projectId: "project-1",
      title: "Persisted workflow",
      goal: "Implement in candidate worktree",
      mode: "fast",
      plannerProfile: "default",
      transport: "hermes_replay_recovery",
      recoveryReason: "Hermes live chat handle was not available during test setup.",
      target: {
        executionTarget: "new_worktree",
        selectedBranch: "main",
        baseRef: "origin/main",
      },
      now: "2026-06-14T00:00:00.000Z",
    });
    const canvasSession = store.materializeCanvasSession("session-1");
    const planner = canvasSession?.nodes.find((node) => node.id === canvasSession.plannerNodeId);

    expect(session.target).toEqual({
      executionTarget: "new_worktree",
      selectedBranch: "main",
      baseRef: "origin/main",
    });
    expect(planner?.worktree).toMatchObject({
      path: ".",
      branchName: "main",
      baseCommit: "origin/main",
      executionTarget: "new_worktree",
      selectedBranch: "main",
      baseRef: "origin/main",
      worktreeId: "worktree-session-1-node-1",
      variantId: "node-1",
    });
    expect(planner?.worktree.realPath).toBeUndefined();
    expect(planner?.worktree.gitdir).toBeUndefined();
  });

  it("materializes created managed worktree identities after replay and restart", async () => {
    const projectRoot = await makeTempRoot();
    const store = createWorkflowStore({ projectRoot });
    store.createWorkflowSession({
      id: "session-1",
      projectId: "project-1",
      title: "Persisted workflow",
      goal: "Implement in candidate worktree",
      mode: "fast",
      plannerProfile: "default",
      transport: "hermes_replay_recovery",
      recoveryReason: "Hermes live chat handle was not available during test setup.",
      target: {
        executionTarget: "new_worktree",
        selectedBranch: "main",
        baseRef: "origin/main",
      },
      now: "2026-06-14T00:00:00.000Z",
    });
    store.applyWorkflowIntent({
      intentId: "intent-audit-1",
      sessionId: "session-1",
      operations: [
        { type: "AnalyzeRequirement", requirement: "Add audit logging" },
        { type: "DiscoverProject", profile: { languages: ["typescript"], capabilities: ["code-change"] } },
        { type: "ProposeLanes" },
      ],
    }, "2026-06-14T00:00:01.000Z");
    const worktree: WorkflowWorktreeIdentity = {
      worktreeId: "worktree-session-1-lane-implementation",
      variantId: "lane-implementation",
      path: "/tmp/project.worktrees/session-session-1-variant-lane-implementation",
      realPath: "/tmp/project.worktrees/session-session-1-variant-lane-implementation",
      gitdir: "/tmp/project/.git/worktrees/session-session-1-variant-lane-implementation",
      repoRoot: "/tmp/project",
      branchName: "skyturn/session-1/lane-implementation",
      baseCommit: "abc123",
      headCommit: "abc123",
      parentLaneId: "lane-implementation",
    };
    store.appendWorkflowEvent({
      sessionId: "session-1",
      kind: "workflow.worktree.created",
      source: "git-worktree",
      idempotencyKey: "worktree:lane-implementation:created",
      payload: { worktree },
      now: "2026-06-14T00:00:02.000Z",
    });

    const first = store.materializeCanvasSession("session-1");
    store.close();

    const reopened = createWorkflowStore({ projectRoot });
    const afterRestart = reopened.materializeCanvasSession("session-1");
    const implementation = afterRestart?.nodes.find((node) => node.id === "lane-implementation");

    expect(first?.nodes.find((node) => node.id === "lane-implementation")?.worktree).toMatchObject({
      path: worktree.realPath,
      realPath: worktree.realPath,
      gitdir: worktree.gitdir,
      repoRoot: worktree.repoRoot,
      worktreeId: worktree.worktreeId,
      variantId: worktree.variantId,
      headCommit: worktree.headCommit,
    });
    expect(implementation?.worktree).toMatchObject({
      path: worktree.realPath,
      realPath: worktree.realPath,
      gitdir: worktree.gitdir,
      repoRoot: worktree.repoRoot,
      worktreeId: worktree.worktreeId,
      variantId: worktree.variantId,
      headCommit: worktree.headCommit,
    });
    reopened.close();
  });

  it.each([false, true])(
    "preserves dependency scheduling and the reassigned agent with restart=%s",
    async (restart) => {
      const projectRoot = await makeTempRoot();
      let store = createWorkflowStore({ projectRoot });
      seedStore(store);
      declareCodeChangeWorkflow(store);
      const beforeProjection = store.materializeFlowProjection("session-1");
      const beforeLane = beforeProjection.lanes.find((lane) => lane.id === "lane-validation");
      const beforeNode = store.materializeCanvasSession("session-1")?.nodes.find((node) => node.id === "lane-validation");
      const beforeEdges = beforeProjection.edges;

      const result = store.reassignWorkflowLane({
        requestId: "reassign-validation-gemini",
        sessionId: "session-1",
        laneId: "lane-validation",
        agentKind: "gemini",
        now: "2026-06-14T00:00:03.000Z",
      });

      expect(result.event).toMatchObject({
        kind: "workflow.lane.reassigned",
        source: "user",
        laneId: "lane-validation",
        payload: {
          laneId: "lane-validation",
          previousAgentKind: "codex",
          agentKind: "gemini",
        },
      });
      expect(result.projection.lanes.find((lane) => lane.id === "lane-validation")).toEqual({
        ...beforeLane,
        agentKind: "gemini",
      });
      expect(result.canvasSession.nodes.find((node) => node.id === "lane-validation")).toEqual({
        ...beforeNode,
        agent: "gemini",
        display: {
          ...beforeNode?.display,
          agentLabel: "Gemini",
        },
      });
      expect(result.projection.edges).toEqual(beforeEdges);
      expect(store.scheduleReadyLanes("session-1", {
        allowedParallelism: 2,
        now: "2026-06-14T00:00:04.000Z",
      }).readyLanes.map((lane) => [lane.id, lane.agentKind])).toEqual([["lane-implementation", "codex"]]);
      if (restart) {
        store.close();
        store = createWorkflowStore({ projectRoot });
        expect(store.materializeFlowProjection("session-1").edges).toEqual(beforeEdges);
        expect(store.materializeFlowProjection("session-1").lanes.find((lane) => lane.id === "lane-validation")?.agentKind).toBe("gemini");
      }
      store.recordRunResult(runResultInput(store, "lane-implementation", "succeeded", "2026-06-14T00:00:05.000Z"));
      expect(store.scheduleReadyLanes("session-1", {
        allowedParallelism: 2,
        now: "2026-06-14T00:00:06.000Z",
      }).readyLanes.map((lane) => [lane.id, lane.agentKind])).toEqual([["lane-validation", "gemini"]]);
      expect(store.materializeCanvasSession("session-1")?.nodes.find((node) => node.id === "lane-validation")?.agent).toBe("gemini");
      store.close();
    },
  );

  it("returns the authoritative result for an identical reassignment retry without appending an event", async () => {
    const store = await makeSeededStore();
    declareCodeChangeWorkflow(store);
    const request = {
      requestId: "reassign-implementation-gemini",
      sessionId: "session-1",
      laneId: "lane-implementation",
      agentKind: "gemini" as const,
      now: "2026-06-14T00:00:03.000Z",
    };

    const first = store.reassignWorkflowLane(request);
    const retried = store.reassignWorkflowLane({ ...request, now: "2026-06-14T00:00:04.000Z" });

    expect(retried.event).toEqual(first.event);
    expect(retried.projection.lanes.find((lane) => lane.id === request.laneId)?.agentKind).toBe("gemini");
    expect(store.listEvents(request.sessionId).filter((event) => event.kind === "workflow.lane.reassigned")).toHaveLength(1);
    store.close();
  });

  it("fails closed when a reassignment requestId is reused with a conflicting payload", async () => {
    const store = await makeSeededStore();
    declareCodeChangeWorkflow(store);
    store.reassignWorkflowLane({
      requestId: "reassign-implementation",
      sessionId: "session-1",
      laneId: "lane-implementation",
      agentKind: "gemini",
      now: "2026-06-14T00:00:03.000Z",
    });

    expect(() => store.reassignWorkflowLane({
      requestId: "reassign-implementation",
      sessionId: "session-1",
      laneId: "lane-validation",
      agentKind: "claude-code",
      now: "2026-06-14T00:00:04.000Z",
    })).toThrow(/requestId.*conflict/i);
    expect(store.listEvents("session-1").filter((event) => event.kind === "workflow.lane.reassigned")).toHaveLength(1);
    store.close();
  });

  it("does not reverse a later reassignment when an old request is replayed after restart", async () => {
    const projectRoot = await makeTempRoot();
    const store = createWorkflowStore({ projectRoot });
    seedStore(store);
    declareCodeChangeWorkflow(store);
    const oldRequest = {
      requestId: "reassign-implementation-gemini",
      sessionId: "session-1",
      laneId: "lane-implementation",
      agentKind: "gemini" as const,
      now: "2026-06-14T00:00:03.000Z",
    };
    store.reassignWorkflowLane(oldRequest);
    store.reassignWorkflowLane({ ...oldRequest, requestId: "reassign-implementation-claude", agentKind: "claude-code", now: "2026-06-14T00:00:04.000Z" });
    store.close();

    const reopened = createWorkflowStore({ projectRoot });
    const replayed = reopened.reassignWorkflowLane({ ...oldRequest, now: "2026-06-14T00:00:05.000Z" });

    expect(replayed.event.payload).toMatchObject({ previousAgentKind: "codex", agentKind: "gemini" });
    expect(replayed.projection.lanes.find((lane) => lane.id === oldRequest.laneId)?.agentKind).toBe("claude-code");
    expect(replayed.canvasSession.nodes.find((node) => node.id === oldRequest.laneId)?.agent).toBe("claude-code");
    expect(reopened.listEvents(oldRequest.sessionId).filter((event) => event.kind === "workflow.lane.reassigned")).toHaveLength(2);
    reopened.close();
  });

  it("rejects reassignment for non-lanes and unsupported agents", async () => {
    const store = await makeSeededStore();
    declareCodeChangeWorkflow(store);
    store.appendWorkflowEvent({
      sessionId: "session-1",
      kind: "workflow.user_decision.requested",
      source: "test",
      payload: { decisionId: "decision-1", prompt: "Choose", options: ["Continue"], reason: "Need input" },
      now: "2026-06-14T00:00:03.000Z",
    });

    expect(() => store.reassignWorkflowLane({ requestId: "request-1", sessionId: "", laneId: "lane-implementation", agentKind: "gemini", now: "2026-06-14T00:00:04.000Z" })).toThrow(/sessionId/i);
    expect(() => store.reassignWorkflowLane({ requestId: "request-2", sessionId: "session-1", laneId: "", agentKind: "gemini", now: "2026-06-14T00:00:04.000Z" })).toThrow(/laneId/i);
    expect(() => store.reassignWorkflowLane({ requestId: "request-3", sessionId: "session-1", laneId: "../lane-implementation", agentKind: "gemini", now: "2026-06-14T00:00:04.000Z" })).toThrow(/laneId/i);
    expect(() => store.reassignWorkflowLane({ requestId: "request-4", sessionId: "session-1", laneId: "node-1", agentKind: "gemini", now: "2026-06-14T00:00:04.000Z" })).toThrow(/planner/i);
    expect(() => store.reassignWorkflowLane({ requestId: "request-5", sessionId: "session-1", laneId: "decision-1", agentKind: "gemini", now: "2026-06-14T00:00:04.000Z" })).toThrow(/user decision/i);
    expect(() => store.reassignWorkflowLane({ requestId: "request-6", sessionId: "session-1", laneId: "missing", agentKind: "gemini", now: "2026-06-14T00:00:04.000Z" })).toThrow(/unknown/i);
    expect(() => store.reassignWorkflowLane({ requestId: "request-7", sessionId: "session-1", laneId: "lane-implementation", agentKind: "agy", now: "2026-06-14T00:00:04.000Z" })).toThrow(/agentKind/i);

    store.close();
  });

  it.each(["running", "waiting_input", "completed", "failed", "blocked"] as const)(
    "rejects reassignment for a lane in %s state",
    async (status) => {
      const store = await makeSeededStore();
      store.appendWorkflowEvent({
        sessionId: "session-1",
        kind: "workflow.lane.declared",
        source: "test",
        payload: {
          lane: {
            id: "lane-target",
            semanticKey: "target",
            kind: "implementation",
            title: "Target",
            agentKind: "codex",
            status,
          },
        },
        now: "2026-06-14T00:00:03.000Z",
      });

      expect(() => store.reassignWorkflowLane({
        requestId: `reject-${status}`,
        sessionId: "session-1",
        laneId: "lane-target",
        agentKind: "gemini",
        now: "2026-06-14T00:00:04.000Z",
      })).toThrow(new RegExp(status, "i"));
      store.close();
    },
  );

  it.each(["rolled_back", "inactive"] as const)("rejects reassignment for a %s lane", async (rollbackStatus) => {
    const rolledBackStore = await makeSeededStore();
    declareCodeChangeWorkflow(rolledBackStore);
    recordCheckpoint(rolledBackStore, "checkpoint-before-implementation", "lane-implementation", "before", "base-sha");
    rolledBackStore.appendWorkflowEvent({
      sessionId: "session-1",
      kind: "workflow.node.rollback_applied",
      source: "test",
      laneId: "lane-implementation",
      payload: {
        requestId: "rollback-lane-implementation",
        laneId: "lane-implementation",
        checkpointId: "checkpoint-before-implementation",
        localRollbackSafe: true,
      },
      now: "2026-06-14T00:00:06.000Z",
    });
    const laneId = rollbackStatus === "rolled_back" ? "lane-implementation" : "lane-validation";
    expect(() => rolledBackStore.reassignWorkflowLane({
      requestId: `reject-${rollbackStatus}`,
      sessionId: "session-1",
      laneId,
      agentKind: "gemini",
      now: "2026-06-14T00:00:07.000Z",
    })).toThrow(/rolled back|inactive/i);
    rolledBackStore.close();
  });

  it("materializes the SQLite planner root before any WorkflowIntent projection nodes exist", async () => {
    const store = await makeStore();

    store.createWorkflowSession({
      id: "session-1",
      projectId: "project-1",
      title: "Persisted workflow",
      goal: "Implement event sourced workflow",
      mode: "fast",
      plannerProfile: "default",
      transport: "hermes_replay_recovery",
      recoveryReason: "Hermes live chat handle was not available during test setup.",
      now: "2026-06-14T00:00:00.000Z",
    });
    const projection = store.materializeFlowProjection("session-1");
    const canvasSession = store.materializeCanvasSession("session-1");

    expect(projection.projectionNodes).toEqual([]);
    expect(canvasSession?.plannerNodeId).toBe("node-1");
    expect(canvasSession?.nodes).toMatchObject([
      {
        id: "node-1",
        agent: "hermes",
        status: "running",
      },
    ]);
  });

  it("allocates event seq monotonically and dedupes idempotency keys", async () => {
    const store = await makeSeededStore();

    const first = store.appendWorkflowEvent({
      sessionId: "session-1",
      kind: "user_input",
      source: "user",
      idempotencyKey: "input:1",
      payload: { text: "Build it" },
      now: "2026-06-14T00:00:01.000Z",
    });
    const second = store.appendWorkflowEvent({
      sessionId: "session-1",
      kind: "user_input",
      source: "user",
      idempotencyKey: "input:2",
      payload: { text: "Then verify it" },
      now: "2026-06-14T00:00:02.000Z",
    });
    const duplicate = store.appendWorkflowEvent({
      sessionId: "session-1",
      kind: "user_input",
      source: "user",
      idempotencyKey: "input:1",
      payload: { text: "Build it again" },
      now: "2026-06-14T00:00:03.000Z",
    });

    expect(first.seq).toBeLessThan(second.seq);
    expect(duplicate).toEqual(first);
    expect(store.listEvents("session-1").map((event) => event.seq)).toEqual([1, 2, 3, 4]);
  });

  it("replays repeated createWorkflowCard calls without duplicate lanes or duplicate events", async () => {
    const store = await makeSeededStore();
    const call: WorkflowCardToolCall = {
      tool: "createWorkflowCard",
      toolCallId: "tool-call-code-1",
      input: {
        id: "node-code",
        taskKey: "implement-core",
        title: "Implement workflow core",
        agent: "codex",
        status: "running",
        brief: "Implement the SQLite workflow core.",
        dependencies: ["node-plan"],
        worktreePath: "/tmp/worktree",
      },
    };
    declareCompletedPlanningLane(store);

    const first = store.applyWorkflowCardToolCall("session-1", call, workflowContext("run-planner"));
    const second = store.applyWorkflowCardToolCall("session-1", call, workflowContext("run-planner"));

    expect(first.status).toBe("applied");
    expect(second).toEqual(first);
    expect(store.listLanes("session-1").filter((lane) => lane.semanticKey === "task-key:implement-core")).toHaveLength(1);
    expect(store.listEvents("session-1").filter((event) => event.idempotencyKey?.includes("tool-call-code-1"))).toHaveLength(2);
  });

  it("rejects edges pointing to the planner lane and rolls back the event write", async () => {
    const store = await makeSeededStore();
    const before = store.listEvents("session-1").length;
    const planner = store.getWorkflowSession("session-1")?.plannerLaneId;

    expect(() =>
      store.appendWorkflowEvent({
        sessionId: "session-1",
        kind: "edge_declared",
        source: "test",
        payload: {
          sourceLaneId: "lane-analysis",
          targetLaneId: planner,
        },
        idempotencyKey: "bad-edge",
        now: "2026-06-14T00:00:01.000Z",
      }),
    ).toThrow(/planner lane/i);
    expect(store.listEvents("session-1")).toHaveLength(before);
  });

  it("blocks coding, review, merge, and premature future cards until evidence gates are satisfied", async () => {
    const store = await makeSeededStore();

    expect(
      store.applyWorkflowCardToolCall(
        "session-1",
        createCard("tool-code-early", {
          id: "node-code",
          taskKey: "code",
          title: "Implement core",
          agent: "codex",
          brief: "Write the implementation.",
        }),
        workflowContext("run-planner"),
      ),
    ).toMatchObject({ status: "skipped", message: expect.stringMatching(/planning/i) });

    declareCompletedPlanningLane(store);
    expect(
      store.applyWorkflowCardToolCall(
        "session-1",
        createCard("tool-code-ok", {
          id: "node-code",
          taskKey: "code",
          title: "Implement core",
          agent: "codex",
          brief: "Write the implementation.",
        }),
        workflowContext("run-planner"),
      ),
    ).toMatchObject({ status: "applied", nodeId: "node-code" });

    expect(
      store.applyWorkflowCardToolCall(
        "session-1",
        createCard("tool-review-early", {
          id: "node-review",
          taskKey: "review",
          title: "Review core",
          agent: "hermes",
          brief: "Review the implementation.",
          dependencies: ["node-code"],
        }),
        workflowContext("run-planner"),
      ),
    ).toMatchObject({ status: "skipped", message: expect.stringMatching(/evidence/i) });

    store.recordSegmentEvidence({
      sessionId: "session-1",
      laneId: "node-code",
      segmentId: "segment-code-1",
      runId: "run-code-1",
      agentKind: "codex",
      transport: "codex_cli",
      worktreePath: "/tmp/worktree",
      evidence: {
        exitCode: 0,
        changesetId: "changeset-code-1",
        checks: [{ kind: "test", name: "pnpm test --filter core", status: "passed" }],
      },
      now: "2026-06-14T00:00:02.000Z",
    });
    expect(store.getLane("session-1", "node-code")?.status).toBe("completed");

    expect(
      store.applyWorkflowCardToolCall(
        "session-1",
        createCard("tool-review-ok", {
          id: "node-review",
          taskKey: "review",
          title: "Review core",
          agent: "hermes",
          brief: "Review the implementation.",
          dependencies: ["node-code"],
        }),
        workflowContext("run-planner"),
      ),
    ).toMatchObject({ status: "applied", nodeId: "node-review" });

    expect(
      store.applyWorkflowCardToolCall(
        "session-1",
        createCard("tool-merge-early", {
          id: "node-merge",
          taskKey: "merge",
          title: "Merge pull request",
          agent: "hermes",
          brief: "Merge the reviewed pull request.",
          dependencies: ["node-review"],
        }),
        workflowContext("run-planner"),
      ),
    ).toMatchObject({ status: "skipped", message: expect.stringMatching(/review/i) });
  });

  it("keeps successful segments without evidence from completing a lane and preserves failed history on continuation", async () => {
    const store = await makeSeededStore();
    declareCompletedPlanningLane(store);
    store.applyWorkflowCardToolCall(
      "session-1",
      createCard("tool-code-ok", {
        id: "node-code",
        taskKey: "code",
        title: "Implement core",
        agent: "codex",
        brief: "Write the implementation.",
      }),
      workflowContext("run-planner"),
    );

    store.finishSegment({
      sessionId: "session-1",
      laneId: "node-code",
      segmentId: "segment-code-1",
      runId: "run-code-1",
      agentKind: "codex",
      transport: "codex_cli",
      worktreePath: "/tmp/worktree",
      status: "succeeded",
      exitCode: 0,
      now: "2026-06-14T00:00:02.000Z",
    });
    expect(store.getLane("session-1", "node-code")?.status).not.toBe("completed");

    store.finishSegment({
      sessionId: "session-1",
      laneId: "node-code",
      segmentId: "segment-code-2",
      runId: "run-code-2",
      agentKind: "codex",
      transport: "codex_cli",
      worktreePath: "/tmp/worktree",
      status: "failed",
      exitCode: 1,
      now: "2026-06-14T00:00:03.000Z",
    });
    store.requestContinuation({
      sessionId: "session-1",
      laneId: "node-code",
      segmentId: "segment-code-3",
      runId: "run-code-3",
      agentKind: "codex",
      transport: "codex_cli",
      worktreePath: "/tmp/worktree-2",
      now: "2026-06-14T00:00:04.000Z",
    });

    expect(store.listSegments("session-1", "node-code").map((segment) => segment.segmentId)).toEqual([
      "segment-code-1",
      "segment-code-2",
      "segment-code-3",
    ]);
    expect(store.getLane("session-1", "node-code")?.status).toBe("retrying");
  });

  it("materializes a deterministic CanvasSession projection across replay and restart", async () => {
    const projectRoot = await makeTempRoot();
    const store = createWorkflowStore({ projectRoot });
    seedStore(store);
    declareCompletedPlanningLane(store);
    store.applyWorkflowCardToolCall(
      "session-1",
      createCard("tool-code-ok", {
        id: "node-code",
        taskKey: "code",
        title: "Implement core",
        agent: "codex",
        brief: "Write the implementation.",
      }),
      workflowContext("run-planner"),
    );
    const first = store.materializeCanvasSession("session-1");
    const second = store.materializeCanvasSession("session-1");
    store.close();

    const reopened = createWorkflowStore({ projectRoot });
    const afterRestart = reopened.materializeCanvasSession("session-1");

    expect(second).toEqual(first);
    expect(afterRestart).toEqual(first);
    expect(first?.nodes.map((node) => node.id)).toEqual(["node-1", "node-plan", "node-code"]);
    expect(first?.edges).toEqual([{ id: "edge-node-plan-node-code", source: "node-plan", target: "node-code" }]);
    reopened.close();
  });

  it("replays the latest persisted planner, lane, and decision node positions after restart", async () => {
    const projectRoot = await makeTempRoot();
    const store = createWorkflowStore({ projectRoot });
    seedStore(store);
    store.applyWorkflowIntent({
      intentId: "intent-position-1",
      sessionId: "session-1",
      operations: [
        { type: "AnalyzeRequirement", requirement: "Persist canvas layout" },
        { type: "DiscoverProject", profile: { languages: ["typescript"], capabilities: ["frontend-ui"] } },
        { type: "ProposeLanes" },
        {
          type: "RequestUserDecision",
          decisionId: "decision-layout",
          prompt: "Keep this layout?",
          options: ["Keep", "Reset"],
          reason: "The user arranged the workflow.",
        },
      ],
    }, "2026-06-14T00:00:03.000Z");

    const laneId = store.materializeFlowProjection("session-1").lanes[0]!.id;
    const updates = [
      { updateId: "drag-planner", nodeId: "node-1", position: { x: 11, y: 22 } },
      { updateId: "drag-lane", nodeId: laneId, position: { x: 333, y: 444 } },
      { updateId: "drag-decision", nodeId: "decision-layout", position: { x: 555, y: 666 } },
      { updateId: "drag-lane-latest", nodeId: laneId, position: { x: 777, y: 888 } },
    ] as const;
    for (const [index, update] of updates.entries()) {
      store.recordCanvasNodePosition({
        sessionId: "session-1",
        ...update,
        now: `2026-06-14T00:00:0${index + 4}.000Z`,
      });
    }
    store.appendWorkflowEvent({
      sessionId: "session-1",
      kind: "canvas_node_position_updated",
      source: "test",
      idempotencyKey: "malformed-position-event",
      payload: { nodeId: laneId, position: { x: 1_000_001, y: 999 } },
      now: "2026-06-14T00:00:08.000Z",
    });
    const duplicate = store.recordCanvasNodePosition({
      sessionId: "session-1",
      ...updates[3],
      now: "2026-06-14T00:00:09.000Z",
    });
    const beforeRestart = store.materializeCanvasSession("session-1");
    store.close();

    const reopened = createWorkflowStore({ projectRoot });
    const afterRestart = reopened.materializeCanvasSession("session-1");
    const positions = Object.fromEntries(afterRestart!.nodes.map((node) => [node.id, node.position]));
    const positionEvents = reopened.listEvents("session-1").filter((event) => event.kind === "canvas_node_position_updated");

    expect(duplicate.id).toBe(positionEvents[3]?.id);
    expect(positionEvents).toHaveLength(5);
    expect(afterRestart).toEqual(beforeRestart);
    expect(positions).toMatchObject({
      "node-1": { x: 11, y: 22 },
      [laneId]: { x: 777, y: 888 },
      "decision-layout": { x: 555, y: 666 },
    });
    expect(afterRestart?.nodes.find((node) => node.id === "node-1")?.context.dependencies).toEqual([]);
    expect(afterRestart?.edges.some((edge) => edge.target === "node-1")).toBe(false);
    reopened.close();
  });

  it("rejects unknown nodes and invalid canvas coordinates without recording events", async () => {
    const store = await makeSeededStore();
    const eventCount = store.listEvents("session-1").length;

    expect(() => store.recordCanvasNodePosition({
      sessionId: "missing-session",
      updateId: "drag-unknown-session",
      nodeId: "node-1",
      position: { x: 1, y: 2 },
      now: "2026-06-14T00:00:03.000Z",
    })).toThrow(/session.*not known/i);
    expect(() => store.recordCanvasNodePosition({
      sessionId: "session-1",
      updateId: "drag-unknown",
      nodeId: "missing-node",
      position: { x: 1, y: 2 },
      now: "2026-06-14T00:00:04.000Z",
    })).toThrow(/node.*not known/i);
    expect(() => store.recordCanvasNodePosition({
      sessionId: "session-1",
      updateId: "drag-invalid",
      nodeId: "node-1",
      position: { x: Number.POSITIVE_INFINITY, y: 2 },
      now: "2026-06-14T00:00:05.000Z",
    })).toThrow(/finite|coordinate/i);
    expect(() => store.recordCanvasNodePosition({
      sessionId: "session-1",
      updateId: "drag-out-of-range",
      nodeId: "node-1",
      position: { x: 1_000_001, y: 2 },
      now: "2026-06-14T00:00:06.000Z",
    })).toThrow(/range|coordinate/i);
    expect(store.listEvents("session-1")).toHaveLength(eventCount);
    store.close();
  });

  it("persists accepted WorkflowIntent events and replays a deterministic Flow Kernel projection after restart", async () => {
    const projectRoot = await makeTempRoot();
    const store = createWorkflowStore({ projectRoot });
    seedStore(store);
    const intent: WorkflowIntent = {
      intentId: "intent-frontend-1",
      sessionId: "session-1",
      operations: [
        { type: "AnalyzeRequirement", requirement: "Add a search filtering control" },
        { type: "DiscoverProject", profile: { languages: ["typescript"], capabilities: ["frontend-ui"] } },
        { type: "ProposeLanes" },
      ],
    };

    const first = store.applyWorkflowIntent(intent, "2026-06-14T00:00:03.000Z");
    const duplicate = store.applyWorkflowIntent(intent, "2026-06-14T00:00:04.000Z");
    const projection = store.materializeFlowProjection("session-1");
    store.close();

    const reopened = createWorkflowStore({ projectRoot });
    const replayed = reopened.materializeFlowProjection("session-1");

    expect(first.ok).toBe(true);
    expect(duplicate.events).toEqual([]);
    expect(projection.lanes.map((lane) => lane.kind)).toEqual([
      "discovery",
      "design",
      "implementation",
      "browser_validation",
      "review",
      "commit",
    ]);
    expect(replayed).toEqual(projection);
    expect(reopened.listEvents("session-1").some((event) => event.kind === "workflow.intent.accepted")).toBe(true);
    reopened.close();
  });

  it("lists node checkpoints and applies rollback as replayable event cascade", async () => {
    const projectRoot = await makeTempRoot();
    const store = createWorkflowStore({ projectRoot });
    seedStore(store);
    declareCodeChangeWorkflow(store);
    advanceCodeChangeWorkflowToLane(store, "lane-review");
    recordCheckpoint(store, "checkpoint-before-implementation", "lane-implementation", "before", "base-sha");

    const checkpoints = store.listNodeCheckpoints({
      sessionId: "session-1",
      nodeId: "lane-implementation",
      runId: "run-session-1-lane-implementation",
    });
    const eligibility = store.getNodeRollbackEligibility({
      sessionId: "session-1",
      laneId: "lane-implementation",
      checkpointId: "checkpoint-before-implementation",
      localRollbackSafe: true,
    });
    const applied = store.applyNodeRollback({
      sessionId: "session-1",
      laneId: "lane-implementation",
      checkpointId: "checkpoint-before-implementation",
      requestId: "rollback-implementation",
      localRollbackSafe: true,
      now: "2026-06-14T00:00:20.000Z",
    });
    const projection = store.materializeFlowProjection("session-1");
    const canvas = store.materializeCanvasSession("session-1");
    const rollbackAppliedEvents = store.listEvents("session-1").filter((event) => event.kind === "workflow.node.rollback_applied");
    store.close();

    const reopened = createWorkflowStore({ projectRoot });
    const replayed = reopened.materializeFlowProjection("session-1");

    expect(checkpoints.map((checkpoint) => checkpoint.id)).toEqual(["checkpoint-before-implementation"]);
    expect(eligibility).toMatchObject({
      eligible: true,
      checkpointId: "checkpoint-before-implementation",
      checkpointPhase: "before",
      restoreCommitRef: "base-sha",
      affectedLaneIds: expect.arrayContaining(["lane-implementation", "lane-validation", "lane-review"]),
      affectedNodeIds: expect.arrayContaining(["lane-implementation", "lane-validation", "lane-review"]),
      downstreamInactiveLaneIds: expect.arrayContaining(["lane-validation", "lane-review"]),
      blockingRemoteSideEffects: [],
      localSafetyStatus: "safe",
    });
    expect(applied).toMatchObject({
      status: "applied",
      event: expect.objectContaining({ kind: "workflow.node.rollback_applied" }),
      eligibility: expect.objectContaining({
        eligible: true,
        checkpointPhase: "before",
        affectedLaneIds: expect.arrayContaining(["lane-implementation", "lane-validation", "lane-review"]),
        downstreamInactiveLaneIds: expect.arrayContaining(["lane-validation", "lane-review"]),
        localSafetyStatus: "safe",
      }),
    });
    expect(rollbackAppliedEvents).toHaveLength(1);
    expect(projection.lanes.find((lane) => lane.id === "lane-implementation")).toMatchObject({ rollbackStatus: "rolled_back" });
    expect(projection.lanes.find((lane) => lane.id === "lane-validation")).toMatchObject({ rollbackStatus: "inactive" });
    expect(projection.lanes.find((lane) => lane.id === "lane-review")).toMatchObject({ rollbackStatus: "inactive" });
    expect(canvas?.nodes.find((node) => node.id === "lane-implementation")).toMatchObject({ status: "failed", rollbackStatus: "rolled_back" });
    expect(canvas?.nodes.find((node) => node.id === "lane-validation")).toMatchObject({ status: "failed", rollbackStatus: "inactive" });
    expect(canvas?.nodes.find((node) => node.id === "lane-review")).toMatchObject({ status: "failed", rollbackStatus: "inactive" });
    expect(applied.eligibility.downstreamInactiveLaneIds).toEqual(["lane-validation", "lane-review", "lane-commit"]);
    expect(replayed).toEqual(projection);
    reopened.close();
  });

  it("records backend run checkpoints idempotently and rejects identity drift", async () => {
    const projectRoot = await makeTempRoot();
    const store = createWorkflowStore({ projectRoot });
    seedStore(store);
    declareCodeChangeWorkflow(store);
    advanceCodeChangeWorkflowToLane(store, "lane-implementation");
    const input = {
      sessionId: "session-1",
      nodeId: "lane-implementation",
      laneId: "lane-implementation",
      runId: "run-session-1-lane-implementation",
      segmentId: "segment-session-1-lane-implementation",
      phase: "before" as const,
      executionTarget: "current_branch" as const,
      worktreePath: projectRoot,
      branchName: "HEAD",
      headCommit: "a".repeat(40),
      worktreeState: "dirty" as const,
      evidenceRefs: [
        { kind: "run" as const, id: "run-session-1-lane-implementation" },
        { kind: "changeset" as const, id: "changeset-session-1-lane-implementation" },
      ],
      now: "2026-06-14T00:00:03.000Z",
    };

    const dirtyBefore = store.recordRunCheckpoint(input);
    expect(store.getNodeRollbackEligibility({
      sessionId: "session-1",
      laneId: input.laneId,
      checkpointId: dirtyBefore.id,
      localRollbackSafe: true,
    })).toMatchObject({ eligible: false, reason: expect.stringMatching(/restorable clean before checkpoint/i) });
    expect(() => store.requestNodeVariant({
      sessionId: "session-1",
      laneId: input.laneId,
      checkpointId: dirtyBefore.id,
      intentId: "variant-dirty-before",
      successorLaneId: "lane-dirty-variant",
      successorSemanticKey: "variant:dirty-before",
      now: "2026-06-14T00:00:03.500Z",
    })).toThrow(/restorable clean before checkpoint/i);

    store.recordRunResult(runResultInput(store, input.laneId, "failed", "2026-06-14T00:00:04.000Z"));
    const afterInput = { ...input, phase: "after" as const, now: "2026-06-14T00:00:05.000Z" };
    const first = store.recordRunCheckpoint(afterInput);
    const duplicate = store.recordRunCheckpoint(afterInput);
    expect(first).toEqual(duplicate);
    expect(store.listEvents("session-1").filter((event) => event.kind === "workflow.node.checkpoint_recorded")).toHaveLength(2);
    expect(store.listNodeCheckpoints({ sessionId: "session-1", runId: input.runId, phase: "after" })).toEqual([
      expect.objectContaining({
        id: `checkpoint:${input.runId}:after`,
        branchName: input.branchName,
        headCommit: input.headCommit,
        worktreeState: "dirty",
        evidenceRefs: expect.arrayContaining([{ kind: "changeset", id: "changeset-session-1-lane-implementation" }]),
      }),
    ]);
    expect(() => store.recordRunCheckpoint({ ...afterInput, headCommit: "b".repeat(40) })).toThrow(/checkpoint identity mismatch/i);
    expect(() => store.recordRunCheckpoint({ ...afterInput, worktreePath: `${projectRoot}-drifted` })).toThrow(/current branch.*project root/i);
    expect(() => store.recordRunCheckpoint({ ...afterInput, branchName: "other-branch" })).toThrow(/current branch.*selected branch/i);
    expect(() => store.recordRunCheckpoint({ ...input, worktreeId: "unexpected-worktree" })).toThrow(/current branch.*worktree id/i);
    expect(() => store.recordRunCheckpoint({ ...input, worktreePath: `${projectRoot}-other` })).toThrow(/current branch.*project root/i);
    expect(() => store.recordRunCheckpoint({ ...input, branchName: "wrong-selected-branch" })).toThrow(/current branch.*selected branch/i);
    store.close();

    const reopened = createWorkflowStore({ projectRoot });
    expect(reopened.listNodeCheckpoints({ sessionId: "session-1", runId: input.runId, phase: "after" })).toEqual([
      expect.objectContaining({ id: `checkpoint:${input.runId}:after`, headCommit: input.headCommit }),
    ]);
    reopened.close();
  });

  it("persists run fault audit events without replaying them into FlowProjection", async () => {
    const projectRoot = await makeTempRoot();
    const store = createWorkflowStore({ projectRoot });
    seedStore(store);
    declareCodeChangeWorkflow(store);
    advanceCodeChangeWorkflowToLane(store, "lane-implementation");
    recordCheckpoint(store, "checkpoint-before-implementation", "lane-implementation", "before", "base-sha");
    const projectionBeforeAudit = store.materializeFlowProjection("session-1");
    const faultKinds = [
      "workflow.run.recovery_failed",
      "workflow.run.start_reconciliation_failed",
      "workflow.node.checkpoint_failed",
    ] as const;

    for (const [index, kind] of faultKinds.entries()) {
      store.appendWorkflowEvent({
        sessionId: "session-1",
        kind,
        source: "test",
        laneId: "lane-implementation",
        segmentId: "segment-session-1-lane-implementation",
        idempotencyKey: `fault-audit:${index}`,
        payload: { runId: "run-session-1-lane-implementation", status: "failed", reason: kind },
        now: `2026-06-14T00:00:2${index}.000Z`,
      });
    }

    expect(store.listEvents("session-1").filter((event) => faultKinds.includes(event.kind as typeof faultKinds[number])))
      .toHaveLength(3);
    expect(store.materializeFlowProjection("session-1")).toEqual(projectionBeforeAudit);
    store.close();

    const reopened = createWorkflowStore({ projectRoot });
    expect(reopened.listEvents("session-1").filter((event) => faultKinds.includes(event.kind as typeof faultKinds[number])))
      .toHaveLength(3);
    expect(reopened.materializeFlowProjection("session-1")).toEqual(projectionBeforeAudit);
    reopened.close();
  });

  it("canonicalizes project-root and current-branch checkpoint path aliases", async () => {
    const realProjectRoot = await makeTempRoot();
    const aliasParent = await makeTempRoot();
    const projectAlias = join(aliasParent, "project-alias");
    await symlink(realProjectRoot, projectAlias, "dir");
    const store = createWorkflowStore({ projectRoot: projectAlias });
    seedStore(store);
    declareCodeChangeWorkflow(store);
    advanceCodeChangeWorkflowToLane(store, "lane-implementation");
    const input = {
      sessionId: "session-1",
      nodeId: "lane-implementation",
      laneId: "lane-implementation",
      runId: "run-session-1-lane-implementation",
      segmentId: "segment-session-1-lane-implementation",
      phase: "before" as const,
      executionTarget: "current_branch" as const,
      worktreePath: realProjectRoot,
      branchName: "HEAD",
      headCommit: "a".repeat(40),
      worktreeState: "clean" as const,
      evidenceRefs: [{ kind: "run" as const, id: "run-session-1-lane-implementation" }],
      now: "2026-06-14T00:00:03.000Z",
    };

    expect(store.recordRunCheckpoint(input)).toMatchObject({ worktreePath: await realpath(realProjectRoot) });
    store.close();
  });

  it("requires checkpoints to match the managed new-worktree identity", async () => {
    const projectRoot = await makeTempRoot();
    const store = createWorkflowStore({ projectRoot });
    seedStore(store, {
      executionTarget: "new_worktree",
      selectedBranch: "main",
      baseRef: "origin/main",
    });
    declareCodeChangeWorkflow(store);
    const worktreePath = `${projectRoot}/.devflow/worktrees/lane-implementation`;
    store.appendWorkflowEvent({
      sessionId: "session-1",
      kind: "workflow.worktree.created",
      source: "git-worktree",
      idempotencyKey: "worktree:lane-implementation:created",
      payload: {
        worktree: {
          worktreeId: "worktree-session-1-lane-implementation",
          variantId: "lane-implementation",
          path: worktreePath,
          realPath: worktreePath,
          gitdir: `${projectRoot}/.git/worktrees/lane-implementation`,
          repoRoot: projectRoot,
          branchName: "skyturn/session-1/lane-implementation",
          baseCommit: "a".repeat(40),
          headCommit: "a".repeat(40),
          parentLaneId: "lane-implementation",
        },
      },
      now: "2026-06-14T00:00:02.500Z",
    });
    advanceCodeChangeWorkflowToLane(store, "lane-implementation");
    const input = {
      sessionId: "session-1",
      nodeId: "lane-implementation",
      laneId: "lane-implementation",
      runId: "run-session-1-lane-implementation",
      segmentId: "segment-session-1-lane-implementation",
      phase: "before" as const,
      executionTarget: "new_worktree" as const,
      worktreeId: "worktree-session-1-lane-implementation",
      worktreePath,
      branchName: "skyturn/session-1/lane-implementation",
      headCommit: "a".repeat(40),
      worktreeState: "clean" as const,
      evidenceRefs: [{ kind: "run" as const, id: "run-session-1-lane-implementation" }],
      now: "2026-06-14T00:00:03.000Z",
    };

    expect(store.recordRunCheckpoint(input)).toMatchObject({ worktreeId: input.worktreeId, worktreePath, branchName: input.branchName });
    expect(() => store.recordRunCheckpoint({ ...input, worktreeId: undefined })).toThrow(/new worktree.*worktree id/i);
    expect(() => store.recordRunCheckpoint({ ...input, worktreeId: "wrong" })).toThrow(/managed worktree identity/i);
    expect(() => store.recordRunCheckpoint({ ...input, worktreePath: `${worktreePath}-wrong` })).toThrow(/managed worktree identity/i);
    expect(() => store.recordRunCheckpoint({ ...input, branchName: "wrong" })).toThrow(/managed worktree identity/i);
    store.close();
  });

  it.each(["succeeded", "cancelled", "timed-out"] as const)(
    "keeps checkpoint repair compatible for %s terminal RunEvidence",
    async (status) => {
      const projectRoot = await makeTempRoot();
      const store = createWorkflowStore({ projectRoot });
      seedStore(store);
      declareCodeChangeWorkflow(store);
      advanceCodeChangeWorkflowToLane(store, "lane-implementation");
      const runId = "run-session-1-lane-implementation";
      const segmentId = "segment-session-1-lane-implementation";
      const checkpointIdentity = {
        sessionId: "session-1",
        nodeId: "lane-implementation",
        laneId: "lane-implementation",
        runId,
        segmentId,
        executionTarget: "current_branch" as const,
        worktreePath: projectRoot,
        branchName: "HEAD",
        headCommit: "d".repeat(40),
        worktreeState: "clean" as const,
        evidenceRefs: [
          { kind: "run" as const, id: runId },
          { kind: "segment" as const, id: segmentId },
        ],
      };
      store.recordRunCheckpoint({
        ...checkpointIdentity,
        phase: "before",
        now: "2026-06-14T00:00:03.000Z",
      });
      store.recordRunResult(runResultInput(store, "lane-implementation", status, "2026-06-14T00:00:04.000Z"));
      store.recordRunCheckpoint({
        ...checkpointIdentity,
        phase: "after",
        evidenceRefs: [
          ...checkpointIdentity.evidenceRefs,
          { kind: "evidence" as const, id: `evidence-${segmentId}` },
        ],
        now: "2026-06-14T00:00:05.000Z",
      });

      const repair = store.requestNodeRepair({
        sessionId: "session-1",
        laneId: "lane-implementation",
        checkpointId: `checkpoint:${runId}:after`,
        now: "2026-06-14T00:00:06.000Z",
      });
      expect(repair.event.payload).toMatchObject({
        failedEvidenceFallbackReason: expect.stringContaining("No failed evidence matched"),
      });
      expect(repair.event.payload).not.toHaveProperty("sourceEvidenceIds");
      expect(repair.projection.lanes.filter((lane) => lane.semanticSubtype === "repair")).toHaveLength(1);
      expect(repair.projection.lanes.filter((lane) => lane.semanticSubtype === "regression_check")).toHaveLength(0);
      store.close();
    },
  );

  it.each(["cancelled", "timed-out"] as const)(
    "reconciles a crashed running segment as durable %s evidence after restart",
    async (status) => {
    const projectRoot = await makeTempRoot();
    const store = createWorkflowStore({ projectRoot });
    seedStore(store);
    declareCodeChangeWorkflow(store);
    advanceCodeChangeWorkflowToLane(store, "lane-implementation");
    store.close();

    const reopened = createWorkflowStore({ projectRoot });
    expect(reopened.listRunningSegments()).toEqual([
      expect.objectContaining({
        sessionId: "session-1",
        laneId: "lane-implementation",
        segmentId: "segment-session-1-lane-implementation",
        runId: "run-session-1-lane-implementation",
        status: "running",
      }),
    ]);
    reopened.recordRunResult(runResultInput(
      reopened,
      "lane-implementation",
      status,
      "2026-06-14T00:00:10.000Z",
    ));
    reopened.close();

    const reconciled = createWorkflowStore({ projectRoot });
    expect(reconciled.listRunningSegments()).toEqual([]);
    expect(reconciled.materializeFlowProjection("session-1").segments).toContainEqual(
      expect.objectContaining({ id: "segment-session-1-lane-implementation", status }),
    );
    reconciled.close();
    },
  );

  it("replays crash-window rollback recovery from requested to applied", async () => {
    const projectRoot = await makeTempRoot();
    const store = createWorkflowStore({ projectRoot });
    const restoreCommitRef = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
    seedStore(store);
    declareCodeChangeWorkflow(store);
    advanceCodeChangeWorkflowToLane(store, "lane-review");
    recordCheckpoint(store, "checkpoint-before-implementation", "lane-implementation", "before", restoreCommitRef);
    store.appendWorkflowEvent({
      sessionId: "session-1",
      kind: "workflow.node.rollback_requested",
      source: "electron-main",
      laneId: "lane-implementation",
      idempotencyKey: "rollback:rollback-implementation:requested",
      payload: {
        requestId: "rollback-implementation",
        laneId: "lane-implementation",
        checkpointId: "checkpoint-before-implementation",
        localRollbackSafe: true,
        restoreCommitRef,
      },
      now: "2026-06-14T00:00:20.000Z",
    });
    store.appendWorkflowEvent({
      sessionId: "session-1",
      kind: "workflow.node.rollback_applied",
      source: "electron-main",
      laneId: "lane-implementation",
      idempotencyKey: "rollback:rollback-implementation:applied",
      payload: {
        requestId: "rollback-implementation",
        laneId: "lane-implementation",
        checkpointId: "checkpoint-before-implementation",
        localRollbackSafe: true,
        restoreCommitRef,
        reason: "Rollback applied.",
      },
      now: "2026-06-14T00:00:21.000Z",
    });
    const projection = store.materializeFlowProjection("session-1");
    store.close();

    const reopened = createWorkflowStore({ projectRoot });
    const replayed = reopened.materializeFlowProjection("session-1");

    expect(projection.rollbackIntents).toEqual([
      expect.objectContaining({
        intentId: "rollback-implementation",
        status: "applied",
        checkpointId: "checkpoint-before-implementation",
      }),
    ]);
    expect(projection.lanes.find((lane) => lane.id === "lane-implementation")).toMatchObject({ rollbackStatus: "rolled_back" });
    expect(projection.lanes.find((lane) => lane.id === "lane-validation")).toMatchObject({ rollbackStatus: "inactive" });
    expect(projection.lanes.find((lane) => lane.id === "lane-review")).toMatchObject({ rollbackStatus: "inactive" });
    expect(replayed).toEqual(projection);
    reopened.close();
  });

  it("retains run evidence and rollback history after persisted rollback replay", async () => {
    const projectRoot = await makeTempRoot();
    const store = createWorkflowStore({ projectRoot });
    seedStore(store);
    declareCodeChangeWorkflow(store);
    advanceCodeChangeWorkflowToLane(store, "lane-review");
    recordCheckpoint(store, "checkpoint-before-implementation", "lane-implementation", "before", "base-sha");

    store.applyNodeRollback({
      sessionId: "session-1",
      laneId: "lane-implementation",
      checkpointId: "checkpoint-before-implementation",
      requestId: "rollback-implementation",
      localRollbackSafe: true,
      now: "2026-06-14T00:00:20.000Z",
    });
    const beforeCloseEvents = store.listEvents("session-1");
    store.close();

    const reopened = createWorkflowStore({ projectRoot });
    const replayed = reopened.materializeFlowProjection("session-1");
    const replayedEvents = reopened.listEvents("session-1");

    expect(replayedEvents.map((event) => event.kind)).toEqual(beforeCloseEvents.map((event) => event.kind));
    expect(replayedEvents).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          kind: "workflow.evidence.recorded",
          payload: expect.objectContaining({ laneId: "lane-implementation" }),
        }),
        expect.objectContaining({ kind: "workflow.node.rollback_requested", laneId: "lane-implementation" }),
        expect.objectContaining({ kind: "workflow.node.rollback_applied", laneId: "lane-implementation" }),
      ]),
    );
    expect(replayed.evidence).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          laneId: "lane-implementation",
          status: "passed",
        }),
      ]),
    );
    expect(replayed.rollbackIntents).toEqual([
      expect.objectContaining({
        intentId: "rollback-implementation",
        status: "applied",
      }),
    ]);
    expect(replayed.lanes.find((lane) => lane.id === "lane-implementation")).toMatchObject({ rollbackStatus: "rolled_back" });
    reopened.close();
  });

  it("blocks rollback without mutating the ledger after pushed branch evidence", async () => {
    const store = await makeSeededStore();
    declareCodeChangeWorkflow(store);
    recordCheckpoint(store, "checkpoint-before-implementation", "lane-implementation", "before", "base-sha");
    store.appendWorkflowEvent({
      sessionId: "session-1",
      kind: "workflow.delivery.pushed",
      source: "test",
      laneId: "lane-implementation",
      idempotencyKey: "delivery:pushed:rollback-block",
      payload: {
        laneId: "lane-implementation",
        evidence: { remote: "origin", branch: "feature/slice-b", commitSha: "local-sha" },
      },
      now: "2026-06-14T00:00:09.000Z",
    });
    const eventCountBefore = store.listEvents("session-1").length;

    const blocked = store.applyNodeRollback({
      sessionId: "session-1",
      laneId: "lane-implementation",
      checkpointId: "checkpoint-before-implementation",
      localRollbackSafe: true,
      now: "2026-06-14T00:00:20.000Z",
    });

    expect(blocked).toMatchObject({
      status: "blocked",
      blockedReason: {
        code: "remote_side_effect",
        eventKinds: ["workflow.delivery.pushed"],
      },
      eligibility: {
        eligible: false,
        blockingRemoteSideEffects: [expect.objectContaining({ eventKind: "workflow.delivery.pushed", status: "recorded" })],
        downstreamInactiveLaneIds: expect.arrayContaining(["lane-validation", "lane-review"]),
        localSafetyStatus: "safe",
      },
    });
    expect(store.listEvents("session-1")).toHaveLength(eventCountBefore);
    expect(store.materializeFlowProjection("session-1").rollbackIntents).toEqual([]);
    store.close();
  });

  it("blocks rollback without mutating the ledger after pull request creation evidence", async () => {
    const store = await makeSeededStore();
    declareCodeChangeWorkflow(store);
    recordCheckpoint(store, "checkpoint-before-implementation", "lane-implementation", "before", "base-sha");
    store.appendWorkflowEvent({
      sessionId: "session-1",
      kind: "workflow.pull_request.created",
      source: "test",
      laneId: "lane-implementation",
      idempotencyKey: "pull-request:created:rollback-block",
      payload: {
        laneId: "lane-implementation",
        evidence: { number: 42, url: "https://example.test/pr/42", head: "feature/slice-b", commitSha: "local-sha" },
      },
      now: "2026-06-14T00:00:09.000Z",
    });
    const eventCountBefore = store.listEvents("session-1").length;

    const blocked = store.applyNodeRollback({
      sessionId: "session-1",
      laneId: "lane-implementation",
      checkpointId: "checkpoint-before-implementation",
      localRollbackSafe: true,
      now: "2026-06-14T00:00:20.000Z",
    });

    expect(blocked).toMatchObject({
      status: "blocked",
      blockedReason: {
        code: "remote_side_effect",
        eventKinds: ["workflow.pull_request.created"],
      },
      eligibility: {
        blockingRemoteSideEffects: [expect.objectContaining({ eventKind: "workflow.pull_request.created", status: "recorded" })],
      },
    });
    expect(store.listEvents("session-1")).toHaveLength(eventCountBefore);
    store.close();
  });

  it("blocks rollback when pull request creation is downstream of the selected lane", async () => {
    const store = await makeSeededStore();
    declareCodeChangeWorkflow(store);
    recordCheckpoint(store, "checkpoint-before-implementation", "lane-implementation", "before", "base-sha");
    store.appendWorkflowEvent({
      sessionId: "session-1",
      kind: "workflow.pull_request.created",
      source: "test",
      laneId: "lane-validation",
      idempotencyKey: "pull-request:created:rollback-downstream-block",
      payload: {
        laneId: "lane-validation",
        commitLaneId: "lane-implementation",
        affectedLaneIds: ["lane-implementation", "lane-validation"],
        evidence: { number: 43, url: "https://example.test/pr/43", head: "feature/slice-b", commitSha: "local-sha" },
      },
      now: "2026-06-14T00:00:09.000Z",
    });
    const eventCountBefore = store.listEvents("session-1").length;

    const blocked = store.applyNodeRollback({
      sessionId: "session-1",
      laneId: "lane-implementation",
      checkpointId: "checkpoint-before-implementation",
      localRollbackSafe: true,
      now: "2026-06-14T00:00:20.000Z",
    });

    expect(blocked).toMatchObject({
      status: "blocked",
      blockedReason: {
        code: "remote_side_effect",
        eventKinds: ["workflow.pull_request.created"],
        affectedLaneIds: ["lane-implementation", "lane-validation", "lane-review", "lane-commit"],
      },
      eligibility: {
        eligible: false,
        affectedLaneIds: ["lane-implementation", "lane-validation", "lane-review", "lane-commit"],
        downstreamInactiveLaneIds: ["lane-validation", "lane-review", "lane-commit"],
        blockingRemoteSideEffects: [
          expect.objectContaining({
            eventKind: "workflow.pull_request.created",
            status: "recorded",
            laneId: "lane-validation",
            affectedLaneIds: ["lane-validation", "lane-implementation"],
          }),
        ],
      },
    });
    expect(store.listEvents("session-1")).toHaveLength(eventCountBefore);
    store.close();
  });

  it("returns manual repair required for local unsafe rollback without mutating the ledger", async () => {
    const store = await makeSeededStore();
    declareCodeChangeWorkflow(store);
    recordCheckpoint(store, "checkpoint-before-implementation", "lane-implementation", "before", "base-sha");
    const eventCountBefore = store.listEvents("session-1").length;

    const blocked = store.applyNodeRollback({
      sessionId: "session-1",
      laneId: "lane-implementation",
      checkpointId: "checkpoint-before-implementation",
      localRollbackSafe: false,
      now: "2026-06-14T00:00:20.000Z",
    });

    expect(blocked).toMatchObject({
      status: "blocked",
      manualRepairRequired: true,
      blockedReason: {
        code: "manual_repair_required",
        manualRepairRequired: true,
      },
      eligibility: {
        eligible: false,
        localRollbackSafe: false,
        localSafetyStatus: "unsafe",
        manualRepairReason: "Local rollback is not safe.",
        reason: "Local rollback is not safe.",
      },
    });
    expect(store.listEvents("session-1")).toHaveLength(eventCountBefore);
    store.close();
  });

  it.each([
    "workflow.pull_request.merged",
    "workflow.delivery.main_synced",
  ] as const)("blocks rollback without mutating the ledger after %s evidence", async (kind) => {
    const store = await makeSeededStore();
    declareCodeChangeWorkflow(store);
    recordCheckpoint(store, "checkpoint-before-implementation", "lane-implementation", "before", "base-sha");
    store.appendWorkflowEvent({
      sessionId: "session-1",
      kind,
      source: "test",
      laneId: "lane-implementation",
      idempotencyKey: `${kind}:rollback-block`,
      payload: {
        laneId: "lane-implementation",
        prNumber: 42,
        headSha: "local-sha",
        evidence: { number: 42, headSha: "local-sha", status: kind === "workflow.pull_request.merged" ? "merged" : "synced" },
      },
      now: "2026-06-14T00:00:09.000Z",
    });
    const eventCountBefore = store.listEvents("session-1").length;

    const blocked = store.applyNodeRollback({
      sessionId: "session-1",
      laneId: "lane-implementation",
      checkpointId: "checkpoint-before-implementation",
      localRollbackSafe: true,
      now: "2026-06-14T00:00:20.000Z",
    });

    expect(blocked).toMatchObject({
      status: "blocked",
      blockedReason: {
        code: "remote_side_effect",
        eventKinds: [kind],
      },
      eligibility: {
        blockingRemoteSideEffects: [expect.objectContaining({ eventKind: kind, status: "recorded" })],
      },
    });
    expect(store.listEvents("session-1")).toHaveLength(eventCountBefore);
    store.close();
  });

  it("blocks rollback after restart while durable remote side-effect intent is unresolved", async () => {
    const projectRoot = await makeTempRoot();
    const store = createWorkflowStore({ projectRoot });
    seedStore(store);
    declareCodeChangeWorkflow(store);
    recordCheckpoint(store, "checkpoint-before-implementation", "lane-implementation", "before", "base-sha");
    store.appendWorkflowEvent({
      sessionId: "session-1",
      kind: "workflow.remote_side_effect.requested",
      source: "electron-main",
      laneId: "lane-implementation",
      idempotencyKey: "remote-side-effect:push:requested",
      payload: {
        operationId: "remote-push-1",
        eventKind: "workflow.delivery.pushed",
        laneId: "lane-implementation",
        affectedLaneIds: ["lane-implementation"],
      },
      now: "2026-06-14T00:00:09.000Z",
    });
    store.close();

    const reopened = createWorkflowStore({ projectRoot });
    const eligibility = reopened.getNodeRollbackEligibility({
      sessionId: "session-1",
      laneId: "lane-implementation",
      checkpointId: "checkpoint-before-implementation",
      localRollbackSafe: true,
    });

    expect(eligibility).toMatchObject({
      eligible: false,
      blockingRemoteSideEffects: [
        expect.objectContaining({
          eventKind: "workflow.delivery.pushed",
          status: "in_flight",
          operationId: "remote-push-1",
          laneId: "lane-implementation",
        }),
      ],
    });
    reopened.close();
  });

  it.each([
    ["workflow.delivery.pushed", false],
    ["workflow.pull_request.created", false],
    ["workflow.pull_request.merged", false],
    ["workflow.delivery.main_synced", true],
  ] as const)("replays ambiguous failed durable %s as a rollback blocker after restart", async (eventKind, sessionWide) => {
    const projectRoot = await makeTempRoot();
    const store = createWorkflowStore({ projectRoot });
    seedStore(store);
    declareCodeChangeWorkflow(store);
    recordCheckpoint(store, "checkpoint-before-implementation", "lane-implementation", "before", "base-sha");
    store.appendWorkflowEvent({
      sessionId: "session-1",
      kind: "workflow.remote_side_effect.requested",
      source: "electron-main",
      laneId: "lane-implementation",
      idempotencyKey: `remote-side-effect:${eventKind}:requested`,
      payload: {
        operationId: `remote-side-effect-${eventKind}`,
        eventKind,
        laneId: "lane-implementation",
        affectedLaneIds: ["lane-implementation"],
        ...(sessionWide ? { sessionWide: true } : {}),
      },
      now: "2026-06-14T00:00:09.000Z",
    });
    store.appendWorkflowEvent({
      sessionId: "session-1",
      kind: "workflow.remote_side_effect.completed",
      source: "electron-main",
      laneId: "lane-implementation",
      idempotencyKey: `remote-side-effect:${eventKind}:completed`,
      payload: {
        operationId: `remote-side-effect-${eventKind}`,
        eventKind,
        laneId: "lane-implementation",
        affectedLaneIds: ["lane-implementation"],
        ...(sessionWide ? { sessionWide: true } : {}),
        status: "failed",
        error: { message: "command failed after remote mutation was attempted" },
      },
      now: "2026-06-14T00:00:10.000Z",
    });
    store.close();

    const reopened = createWorkflowStore({ projectRoot });
    const eligibility = reopened.getNodeRollbackEligibility({
      sessionId: "session-1",
      laneId: "lane-implementation",
      checkpointId: "checkpoint-before-implementation",
      localRollbackSafe: true,
    });

    expect(eligibility).toMatchObject({
      eligible: false,
      blockingRemoteSideEffects: [
        expect.objectContaining({
          eventKind,
          ...(sessionWide ? { sessionWide: true } : { laneId: "lane-implementation" }),
        }),
      ],
    });
    reopened.close();
  });

  it("replays Electron main sync as a session-wide rollback blocker after restart", async () => {
    const projectRoot = await makeTempRoot();
    const store = createWorkflowStore({ projectRoot });
    seedStore(store);
    declareCodeChangeWorkflow(store);
    store.appendWorkflowEvent({
      sessionId: "session-1",
      kind: "workflow.lane.declared",
      source: "test",
      idempotencyKey: "lane:independent",
      payload: {
        lane: {
          id: "lane-independent",
          semanticKey: "lane-independent",
          kind: "implementation",
          title: "Independent lane",
          agentKind: "codex",
          status: "completed",
        },
      },
      now: "2026-06-14T00:00:08.500Z",
    });
    recordCheckpoint(store, "checkpoint-before-independent", "lane-independent", "before", "base-sha");
    store.appendWorkflowEvent({
      sessionId: "session-1",
      kind: "workflow.delivery.main_synced",
      source: "electron-main",
      laneId: "lane-review",
      idempotencyKey: "delivery-main-synced:session-wide",
      payload: {
        sessionWide: true,
        laneId: "lane-review",
        prNumber: 42,
        headSha: "main-sha",
        evidence: { status: "synced", mainBranch: "main", remote: "origin" },
      },
      now: "2026-06-14T00:00:09.000Z",
    });
    store.close();

    const reopened = createWorkflowStore({ projectRoot });
    const eligibility = reopened.getNodeRollbackEligibility({
      sessionId: "session-1",
      laneId: "lane-independent",
      checkpointId: "checkpoint-before-independent",
      localRollbackSafe: true,
    });

    expect(eligibility).toMatchObject({
      eligible: false,
      blockingRemoteSideEffects: [
        expect.objectContaining({
          eventKind: "workflow.delivery.main_synced",
          sessionWide: true,
        }),
      ],
    });
    reopened.close();
  });

  it("appends durable repair intent and repair lane from an after checkpoint", async () => {
    const projectRoot = await makeTempRoot();
    const store = createWorkflowStore({ projectRoot });
    seedStore(store);
    declareCodeChangeWorkflow(store);
    advanceCodeChangeWorkflowToLane(store, "lane-implementation");
    store.recordRunResult(runResultInput(store, "lane-implementation", "failed", "2026-06-14T00:00:07.000Z"));
    recordCheckpoint(store, "checkpoint-after-implementation", "lane-implementation", "after", "head-sha");

    const repair = store.requestNodeRepair({
      sessionId: "session-1",
      laneId: "lane-implementation",
      checkpointId: "checkpoint-after-implementation",
      successorLaneId: "lane-implementation-repair",
      successorSemanticKey: "repair:lane-implementation:manual",
      instruction: "Fix the failing review notes.",
      now: "2026-06-14T00:00:20.000Z",
    });
    const projection = store.materializeFlowProjection("session-1");
    store.close();

    const reopened = createWorkflowStore({ projectRoot });

    expect(repair).toMatchObject({
      status: "requested",
      event: expect.objectContaining({ kind: "workflow.node.repair_requested" }),
    });
    expect(repair.event.payload).toMatchObject({ instruction: "Fix the failing review notes." });
    expect(projection.checkpointIntents).toContainEqual(expect.objectContaining({
      kind: "repair",
      status: "requested",
      checkpointId: "checkpoint-after-implementation",
      successorLaneId: "lane-implementation-repair",
      instruction: "Fix the failing review notes.",
    }));
    expect(projection.lanes.find((lane) => lane.id === "lane-implementation-repair")).toMatchObject({
      laneKind: "fix",
      semanticSubtype: "repair",
      runtimePolicy: { sandbox: "workspace-write" },
    });
    expect(projection.edges).toContainEqual(expect.objectContaining({
      sourceLaneId: "lane-implementation",
      targetLaneId: "lane-implementation-repair",
    }));
    expect(reopened.materializeFlowProjection("session-1")).toEqual(projection);
    reopened.close();
  });

  it("requests checkpoint repair once with failed evidence context and a regression continuation", async () => {
    const projectRoot = await makeTempRoot();
    const store = createWorkflowStore({ projectRoot });
    seedStore(store);
    declareCodeChangeWorkflow(store);
    advanceCodeChangeWorkflowToLane(store, "lane-implementation");
    recordCheckpoint(store, "checkpoint-after-implementation", "lane-implementation", "after", "head-sha");

    store.appendWorkflowEvent({
      sessionId: "session-1",
      kind: "workflow.segment.started",
      source: "test",
      laneId: "lane-implementation",
      segmentId: "segment-session-1-lane-implementation",
      idempotencyKey: "manual-failure:started",
      payload: {
        segment: {
          id: "segment-session-1-lane-implementation",
          laneId: "lane-implementation",
          runId: "run-session-1-lane-implementation",
          status: "running",
        },
      },
      now: "2026-06-14T00:00:09.000Z",
    });
    store.appendWorkflowEvent({
      sessionId: "session-1",
      kind: "workflow.evidence.recorded",
      source: "test",
      laneId: "lane-implementation",
      segmentId: "segment-session-1-lane-implementation",
      idempotencyKey: "manual-failure:evidence",
      payload: {
        laneId: "lane-implementation",
        segmentId: "segment-session-1-lane-implementation",
        evidence: {
          id: "evidence-segment-session-1-lane-implementation",
          kind: "run-exit",
          status: "failed",
          checks: ["run-exit:Agent run exit:failed"],
          artifacts: [],
          detail: "exit 1",
          runEvidence: {
            runId: "run-session-1-lane-implementation",
            status: "failed",
            exitCode: 1,
            changesetId: null,
            checks: [{ kind: "run-exit", name: "Agent run exit", status: "failed" }],
            artifacts: [],
            review: null,
            errorReason: "exit 1",
            cancelReason: null,
            completedAt: "2026-06-14T00:00:10.000Z",
          },
        },
      },
      now: "2026-06-14T00:00:10.000Z",
    });
    store.appendWorkflowEvent({
      sessionId: "session-1",
      kind: "workflow.segment.finished",
      source: "test",
      laneId: "lane-implementation",
      segmentId: "segment-session-1-lane-implementation",
      idempotencyKey: "manual-failure:finished",
      payload: {
        laneId: "lane-implementation",
        segmentId: "segment-session-1-lane-implementation",
        status: "failed",
        exitCode: 1,
      },
      now: "2026-06-14T00:00:10.000Z",
    });
    const firstRequest = store.requestNodeRepair({
      sessionId: "session-1",
      laneId: "lane-implementation",
      checkpointId: "checkpoint-after-implementation",
      intentId: "manual-repair-intent-1",
      successorLaneId: "lane-implementation-manual-repair",
      successorSemanticKey: "manual:repair:lane-implementation",
      instruction: "Repair from the failed run evidence.",
      now: "2026-06-14T00:00:20.000Z",
    });
    const eventCountBeforeRetry = store.listEvents("session-1").length;
    const retry = store.requestNodeRepair({
      sessionId: "session-1",
      laneId: "lane-implementation",
      checkpointId: "checkpoint-after-implementation",
      intentId: "manual-repair-intent-1",
      successorLaneId: "lane-implementation-manual-repair",
      successorSemanticKey: "manual:repair:lane-implementation",
      instruction: "Repair from the failed run evidence.",
      now: "2026-06-14T00:00:21.000Z",
    });
    expect(store.listEvents("session-1")).toHaveLength(eventCountBeforeRetry);
    const projection = store.materializeFlowProjection("session-1");
    const scheduled = store.scheduleReadyLanes("session-1", {
      allowedParallelism: 10,
      now: "2026-06-14T00:00:22.000Z",
    });
    const scheduledProjection = store.materializeFlowProjection("session-1");
    const canvasSession = store.materializeCanvasSession("session-1");
    const scheduledCanvasSession = store.materializeCanvasSession("session-1");
    const repairLane = projection.lanes.find((lane) => lane.id === "lane-implementation-manual-repair");
    const scheduledRepairLane = scheduled.readyLanes.find((lane) => lane.id === "lane-implementation-manual-repair") as
      | { brief?: string }
      | undefined;
    const repairNode = canvasSession?.nodes.find((node) => node.id === "lane-implementation-manual-repair");
    const scheduledRepairNode = scheduledCanvasSession?.nodes.find((node) => node.id === "lane-implementation-manual-repair");
    const regressionLane = projection.lanes.find((lane) => lane.id === "lane-implementation-manual-repair-regression");
    const failedEvidenceId = "evidence-segment-session-1-lane-implementation";
    store.close();

    const reopened = createWorkflowStore({ projectRoot });

    expect(firstRequest.event.id).toBe(retry.event.id);
    expect(eventCountBeforeRetry).toBeGreaterThan(0);
    expect(reopened.materializeFlowProjection("session-1").events).toHaveLength(scheduledProjection.events.length);
    expect(projection.lanes.find((lane) => lane.id === "lane-implementation")).toMatchObject({ status: "failed" });
    expect(projection.evidence).toContainEqual(expect.objectContaining({
      id: failedEvidenceId,
      laneId: "lane-implementation",
      status: "failed",
    }));
    expect(firstRequest.event.payload).toMatchObject({
      sourceEvidenceIds: [failedEvidenceId],
      sourceLaneId: "lane-implementation",
      sourceNodeId: "lane-implementation",
      sourceCheckpointId: "checkpoint-after-implementation",
      failedRunId: "run-session-1-lane-implementation",
    });
    expect(firstRequest.event.payload).toMatchObject({
      regressionLaneId: "lane-implementation-manual-repair-regression",
      regressionSemanticKey: `regression:manual:repair:lane-implementation:${failedEvidenceId}`,
    });
    expect(repairLane).toMatchObject({
      laneKind: "fix",
      semanticSubtype: "repair",
      output: expect.arrayContaining([
        expect.stringContaining("source lane lane-implementation"),
        expect.stringContaining("checkpoint checkpoint-after-implementation"),
        expect.stringContaining(failedEvidenceId),
      ]),
    });
    const repairBrief = repairNode?.context.brief ?? "";
    expect(repairBrief).toContain("after checkpoint checkpoint-after-implementation");
    expect(repairBrief).toContain("source lane lane-implementation");
    expect(repairBrief).toContain("source node lane-implementation");
    expect(repairBrief).toContain("source run run-session-1-lane-implementation");
    expect(repairBrief).toContain("source segment segment-session-1-lane-implementation");
    expect(repairBrief).toContain(`failed evidence ${failedEvidenceId}`);
    expect(repairBrief).toContain("failed detail exit 1");
    expect(repairBrief).toContain("instruction Repair from the failed run evidence.");
    expect(scheduledRepairLane?.brief).toBe(repairBrief);
    expect(scheduledRepairNode?.context.brief).toBe(repairBrief);
    expect(regressionLane).toMatchObject({
      laneKind: "regression",
      semanticSubtype: "regression_check",
      requiredEvidence: ["test"],
      runtimePolicy: {
        source: "workflow_projection",
        trusted: true,
        sandbox: "read-only",
      },
    });
    expect(projection.edges).toEqual(expect.arrayContaining([
      expect.objectContaining({ sourceLaneId: "lane-implementation", targetLaneId: "lane-implementation-manual-repair" }),
      expect.objectContaining({ sourceLaneId: "lane-implementation-manual-repair", targetLaneId: "lane-implementation-manual-repair-regression" }),
    ]));
    expect(scheduled.readyLanes.map((lane) => lane.id)).toContain("lane-implementation-manual-repair");
    expect(reopened.materializeFlowProjection("session-1")).toEqual(scheduledProjection);
    reopened.close();
  });

  it("does not create a second repair chain for the same failed evidence", async () => {
    const store = await makeSeededStore();
    declareCodeChangeWorkflow(store);
    advanceCodeChangeWorkflowToLane(store, "lane-implementation");
    recordCheckpoint(store, "checkpoint-after-implementation", "lane-implementation", "after", "head-sha");
    appendFailedEvidence(
      store,
      "lane-implementation",
      "segment-session-1-lane-implementation",
      "evidence-segment-session-1-lane-implementation",
      "exit 1",
      "2026-06-14T00:00:10.000Z",
      "run-session-1-lane-implementation",
    );

    const first = store.requestNodeRepair({
      sessionId: "session-1",
      laneId: "lane-implementation",
      checkpointId: "checkpoint-after-implementation",
      intentId: "manual-repair-intent-1",
      successorLaneId: "lane-implementation-manual-repair",
      successorSemanticKey: "manual:repair:lane-implementation",
      instruction: "Repair from the failed run evidence.",
      now: "2026-06-14T00:00:20.000Z",
    });
    const eventCountBeforeDuplicate = store.listEvents("session-1").length;

    const duplicate = store.requestNodeRepair({
      sessionId: "session-1",
      laneId: "lane-implementation",
      checkpointId: "checkpoint-after-implementation",
      intentId: "manual-repair-intent-2",
      successorLaneId: "lane-implementation-second-repair",
      successorSemanticKey: "manual:repair:lane-implementation:second",
      instruction: "Try another repair for the same evidence.",
      now: "2026-06-14T00:00:21.000Z",
    });
    const projection = store.materializeFlowProjection("session-1");

    expect(duplicate.event.id).toBe(first.event.id);
    expect(store.listEvents("session-1")).toHaveLength(eventCountBeforeDuplicate);
    expect(projection.lanes.filter((lane) => lane.semanticSubtype === "repair")).toHaveLength(1);
    expect(projection.lanes.filter((lane) => lane.semanticSubtype === "regression_check")).toHaveLength(1);
    expect(projection.lanes.some((lane) => lane.id === "lane-implementation-second-repair")).toBe(false);
    store.close();
  });

  it("uses failed evidence matching the selected repair checkpoint segment instead of newer lane failure", async () => {
    const projectRoot = await makeTempRoot();
    const store = createWorkflowStore({ projectRoot });
    seedStore(store);
    declareCodeChangeWorkflow(store);
    advanceCodeChangeWorkflowToLane(store, "lane-implementation");
    recordCheckpointForSegment(
      store,
      "checkpoint-after-implementation-old",
      "lane-implementation",
      "run-implementation-old",
      "segment-implementation-old",
      "2026-06-14T00:00:08.000Z",
    );
    appendFailedEvidence(
      store,
      "lane-implementation",
      "segment-implementation-old",
      "old-failed-evidence",
      "old failure detail",
      "2026-06-14T00:00:10.000Z",
      "run-implementation-old",
    );
    recordCheckpointForSegment(
      store,
      "checkpoint-after-implementation-new",
      "lane-implementation",
      "run-implementation-new",
      "segment-implementation-new",
      "2026-06-14T00:00:11.000Z",
    );
    appendFailedEvidence(
      store,
      "lane-implementation",
      "segment-implementation-new",
      "new-failed-evidence",
      "new failure detail",
      "2026-06-14T00:00:12.000Z",
      "run-implementation-new",
    );

    const repair = store.requestNodeRepair({
      sessionId: "session-1",
      laneId: "lane-implementation",
      checkpointId: "checkpoint-after-implementation-old",
      intentId: "repair-old-checkpoint",
      successorLaneId: "lane-implementation-old-repair",
      successorSemanticKey: "manual:repair:lane-implementation:old",
      now: "2026-06-14T00:00:20.000Z",
    });
    const canvasSession = store.materializeCanvasSession("session-1");
    const repairNode = canvasSession?.nodes.find((node) => node.id === "lane-implementation-old-repair");
    const repairBrief = repairNode?.context.brief ?? "";
    store.close();

    expect(repair.event.payload).toMatchObject({
      sourceEvidenceIds: ["old-failed-evidence"],
      failedEvidenceId: "old-failed-evidence",
      failedEvidenceDetail: "old failure detail",
      failedSegmentId: "segment-implementation-old",
    });
    expect(repair.event.payload).not.toMatchObject({
      sourceEvidenceIds: ["new-failed-evidence"],
      failedEvidenceDetail: "new failure detail",
    });
    expect(repairBrief).toContain("failed evidence old-failed-evidence");
    expect(repairBrief).toContain("failed detail old failure detail");
    expect(repairBrief).not.toContain("new-failed-evidence");
    expect(repairBrief).not.toContain("new failure detail");
  });

  it("falls back to checkpoint context when referenced failed evidence does not match the selected run", async () => {
    const projectRoot = await makeTempRoot();
    const store = createWorkflowStore({ projectRoot });
    seedStore(store);
    declareCodeChangeWorkflow(store);
    advanceCodeChangeWorkflowToLane(store, "lane-implementation");
    appendFailedEvidence(
      store,
      "lane-implementation",
      "segment-implementation-new",
      "new-failed-evidence",
      "new failure detail",
      "2026-06-14T00:00:10.000Z",
      "run-implementation-new",
    );
    recordCheckpointForSegment(
      store,
      "checkpoint-after-implementation-old",
      "lane-implementation",
      "run-implementation-old",
      "segment-implementation-old",
      "2026-06-14T00:00:12.000Z",
      [{ kind: "evidence", id: "new-failed-evidence" }],
    );

    const repair = store.requestNodeRepair({
      sessionId: "session-1",
      laneId: "lane-implementation",
      checkpointId: "checkpoint-after-implementation-old",
      intentId: "repair-old-checkpoint-mismatched-evidence",
      successorLaneId: "lane-implementation-old-repair",
      successorSemanticKey: "manual:repair:lane-implementation:old",
      now: "2026-06-14T00:00:20.000Z",
    });
    const repairNode = store.materializeCanvasSession("session-1")?.nodes.find((node) => node.id === "lane-implementation-old-repair");

    expect(repair.event.payload).toMatchObject({
      failedEvidenceFallbackReason: expect.stringContaining("No failed evidence matched"),
    });
    expect(repair.event.payload).not.toHaveProperty("sourceEvidenceIds");
    expect(repair.event.payload).not.toHaveProperty("failedEvidenceId");
    expect(repairNode?.context.brief).toContain("No failed evidence matched");
    expect(repairNode?.context.brief).not.toContain("new-failed-evidence");
    store.close();
  });

  it("rejects conflicting idempotent repair retries before adding successor edges", async () => {
    const store = await makeSeededStore();
    declareCodeChangeWorkflow(store);
    advanceCodeChangeWorkflowToLane(store, "lane-implementation");
    appendFailedEvidence(
      store,
      "lane-implementation",
      "segment-session-1-lane-implementation",
      "evidence-segment-session-1-lane-implementation",
      "exit 1",
      "2026-06-14T00:00:10.000Z",
      "run-session-1-lane-implementation",
    );
    recordCheckpoint(store, "checkpoint-after-implementation", "lane-implementation", "after", "head-sha");
    store.requestNodeRepair({
      sessionId: "session-1",
      laneId: "lane-implementation",
      checkpointId: "checkpoint-after-implementation",
      intentId: "repair-intent-1",
      successorLaneId: "lane-implementation-repair-a",
      successorSemanticKey: "repair:lane-implementation:a",
      now: "2026-06-14T00:00:20.000Z",
    });
    const eventCountBefore = store.listEvents("session-1").length;

    expect(() => store.requestNodeRepair({
      sessionId: "session-1",
      laneId: "lane-implementation",
      checkpointId: "checkpoint-after-implementation",
      intentId: "repair-intent-1",
      successorLaneId: "lane-implementation-repair-b",
      successorSemanticKey: "repair:lane-implementation:b",
      now: "2026-06-14T00:00:21.000Z",
    })).toThrow(/idempotent.*successor/i);
    expect(store.listEvents("session-1")).toHaveLength(eventCountBefore);
    expect(store.materializeFlowProjection("session-1").edges).not.toContainEqual(expect.objectContaining({
      targetLaneId: "lane-implementation-repair-b",
    }));
    store.close();
  });

  it("rejects conflicting idempotent variant retries before adding successor edges", async () => {
    const store = await makeSeededStore();
    declareCodeChangeWorkflow(store);
    recordCheckpoint(store, "checkpoint-before-implementation", "lane-implementation", "before", "base-sha");
    store.requestNodeVariant({
      sessionId: "session-1",
      laneId: "lane-implementation",
      checkpointId: "checkpoint-before-implementation",
      intentId: "variant-intent-1",
      successorLaneId: "lane-implementation-variant-a",
      successorSemanticKey: "variant:lane-implementation:a",
      now: "2026-06-14T00:00:20.000Z",
    });
    const eventCountBefore = store.listEvents("session-1").length;

    expect(() => store.requestNodeVariant({
      sessionId: "session-1",
      laneId: "lane-implementation",
      checkpointId: "checkpoint-before-implementation",
      intentId: "variant-intent-1",
      successorLaneId: "lane-implementation-variant-b",
      successorSemanticKey: "variant:lane-implementation:b",
      now: "2026-06-14T00:00:21.000Z",
    })).toThrow(/idempotent.*successor/i);
    expect(store.listEvents("session-1")).toHaveLength(eventCountBefore);
    expect(store.materializeFlowProjection("session-1").edges).not.toContainEqual(expect.objectContaining({
      targetLaneId: "lane-implementation-variant-b",
    }));
    store.close();
  });

  it("rejects implicit checkpoint phases for repair and variant without writing successor events", async () => {
    const store = await makeSeededStore();
    declareCodeChangeWorkflow(store);
    recordDefaultedCheckpoint(store, "checkpoint-defaulted-implementation", "lane-implementation");
    const eventCountBeforeRepair = store.listEvents("session-1").length;

    expect(() => store.requestNodeRepair({
      sessionId: "session-1",
      laneId: "lane-implementation",
      checkpointId: "checkpoint-defaulted-implementation",
      successorLaneId: "lane-implementation-repair-defaulted",
      successorSemanticKey: "repair:lane-implementation:defaulted",
      now: "2026-06-14T00:00:20.000Z",
    })).toThrow(/explicit.*after checkpoint/i);
    expect(store.listEvents("session-1")).toHaveLength(eventCountBeforeRepair);

    const eventCountBeforeVariant = store.listEvents("session-1").length;
    expect(() => store.requestNodeVariant({
      sessionId: "session-1",
      laneId: "lane-implementation",
      checkpointId: "checkpoint-defaulted-implementation",
      successorLaneId: "lane-implementation-variant-defaulted",
      successorSemanticKey: "variant:lane-implementation:defaulted",
      now: "2026-06-14T00:00:21.000Z",
    })).toThrow(/explicit.*before checkpoint/i);
    expect(store.listEvents("session-1")).toHaveLength(eventCountBeforeVariant);
    expect(store.materializeFlowProjection("session-1").lanes).not.toContainEqual(expect.objectContaining({
      id: "lane-implementation-variant-defaulted",
    }));
    store.close();
  });

  it("rejects colliding successor lane identities before writing successor events", async () => {
    const store = await makeSeededStore();
    declareCodeChangeWorkflow(store);
    recordCheckpoint(store, "checkpoint-before-implementation", "lane-implementation", "before", "base-sha");
    const validationLane = store.materializeFlowProjection("session-1").lanes.find((lane) => lane.id === "lane-validation");
    expect(validationLane).toBeDefined();
    const eventCountBeforeLaneIdConflict = store.listEvents("session-1").length;

    expect(() => store.requestNodeVariant({
      sessionId: "session-1",
      laneId: "lane-implementation",
      checkpointId: "checkpoint-before-implementation",
      successorLaneId: "lane-validation",
      successorSemanticKey: "variant:lane-implementation:lane-conflict",
      now: "2026-06-14T00:00:20.000Z",
    })).toThrow(/successor lane id/i);
    expect(store.listEvents("session-1")).toHaveLength(eventCountBeforeLaneIdConflict);

    const eventCountBeforeSemanticConflict = store.listEvents("session-1").length;
    expect(() => store.requestNodeVariant({
      sessionId: "session-1",
      laneId: "lane-implementation",
      checkpointId: "checkpoint-before-implementation",
      successorLaneId: "lane-implementation-variant-semantic-conflict",
      successorSemanticKey: validationLane!.semanticKey,
      now: "2026-06-14T00:00:21.000Z",
    })).toThrow(/successor semantic key/i);
    expect(store.listEvents("session-1")).toHaveLength(eventCountBeforeSemanticConflict);

    const implementationLane = store.materializeFlowProjection("session-1").lanes.find((lane) => lane.id === "lane-implementation");
    expect(implementationLane).toBeDefined();
    const eventCountBeforeSelfLoop = store.listEvents("session-1").length;
    expect(() => store.requestNodeVariant({
      sessionId: "session-1",
      laneId: "lane-implementation",
      checkpointId: "checkpoint-before-implementation",
      successorLaneId: "lane-implementation",
      successorSemanticKey: implementationLane!.semanticKey,
      now: "2026-06-14T00:00:22.000Z",
    })).toThrow(/successor.*source lane/i);
    expect(store.listEvents("session-1")).toHaveLength(eventCountBeforeSelfLoop);
    store.close();
  });

  it("appends durable variant intent and variant lane with the selected node upstream dependencies", async () => {
    const projectRoot = await makeTempRoot();
    const store = createWorkflowStore({ projectRoot });
    seedStore(store);
    declareCompletedImplementationWithUpstream(store);
    recordCheckpoint(store, "checkpoint-before-implementation", "lane-implementation", "before", "base-sha");
    const upstreamBefore = store
      .materializeFlowProjection("session-1")
      .edges.filter((edge) => edge.targetLaneId === "lane-implementation")
      .map((edge) => edge.sourceLaneId);

    const variant = store.requestNodeVariant({
      sessionId: "session-1",
      laneId: "lane-implementation",
      checkpointId: "checkpoint-before-implementation",
      successorLaneId: "lane-implementation-variant",
      successorSemanticKey: "variant:lane-implementation:manual",
      instruction: "Try a simpler implementation path.",
      now: "2026-06-14T00:00:20.000Z",
    });
    const projection = store.materializeFlowProjection("session-1");
    store.close();

    const reopened = createWorkflowStore({ projectRoot });
    const variantIncoming = projection.edges
      .filter((edge) => edge.targetLaneId === "lane-implementation-variant")
      .map((edge) => edge.sourceLaneId);

    expect(variant).toMatchObject({
      status: "requested",
      event: expect.objectContaining({ kind: "workflow.node.variant_requested" }),
    });
    expect(variant.event.payload).toMatchObject({ instruction: "Try a simpler implementation path." });
    expect(projection.checkpointIntents).toContainEqual(expect.objectContaining({
      kind: "variant",
      status: "requested",
      checkpointId: "checkpoint-before-implementation",
      successorLaneId: "lane-implementation-variant",
      instruction: "Try a simpler implementation path.",
    }));
    expect(projection.lanes.find((lane) => lane.id === "lane-implementation")).toBeDefined();
    expect(projection.lanes.find((lane) => lane.id === "lane-implementation-variant")).toMatchObject({
      laneKind: "implementation",
      semanticKey: "variant:lane-implementation:manual",
    });
    expect(variantIncoming).toEqual(upstreamBefore);
    expect(reopened.materializeFlowProjection("session-1")).toEqual(projection);
    reopened.close();
  });

  it("materializes and schedules variant successor brief with manual instruction", async () => {
    const projectRoot = await makeTempRoot();
    const store = createWorkflowStore({ projectRoot });
    seedStore(store);
    declareCompletedImplementationWithUpstream(store);
    recordCheckpoint(store, "checkpoint-before-implementation", "lane-implementation", "before", "base-sha");

    store.requestNodeVariant({
      sessionId: "session-1",
      laneId: "lane-implementation",
      checkpointId: "checkpoint-before-implementation",
      successorLaneId: "lane-implementation-variant",
      successorSemanticKey: "variant:lane-implementation:manual",
      instruction: "Try a simpler implementation path.",
      now: "2026-06-14T00:00:20.000Z",
    });
    const projection = store.materializeFlowProjection("session-1");
    const canvasSession = store.materializeCanvasSession("session-1");
    const scheduled = store.scheduleReadyLanes("session-1", {
      allowedParallelism: 2,
      now: "2026-06-14T00:00:22.000Z",
    });
    const scheduledCanvasSession = store.materializeCanvasSession("session-1");
    const variantLane = projection.lanes.find((lane) => lane.id === "lane-implementation-variant") as { brief?: string } | undefined;
    const variantNode = canvasSession?.nodes.find((node) => node.id === "lane-implementation-variant");
    const scheduledVariantLane = scheduled.readyLanes.find((lane) => lane.id === "lane-implementation-variant") as
      | { brief?: string }
      | undefined;
    const scheduledVariantNode = scheduledCanvasSession?.nodes.find((node) => node.id === "lane-implementation-variant");
    store.close();

    expect(variantLane?.brief).toContain("Variant from before checkpoint checkpoint-before-implementation");
    expect(variantLane?.brief).toContain("instruction Try a simpler implementation path.");
    expect(variantNode?.context.brief).toBe(variantLane?.brief);
    expect(scheduledVariantLane?.brief).toBe(variantLane?.brief);
    expect(scheduledVariantNode?.context.brief).toBe(variantLane?.brief);
  });

  it("keeps checkpoint variant isolated, idempotent, and schedulable without mutating the original lane", async () => {
    const projectRoot = await makeTempRoot();
    const store = createWorkflowStore({ projectRoot });
    seedStore(store);
    declareCompletedImplementationWithUpstream(store);
    recordCheckpoint(store, "checkpoint-before-implementation", "lane-implementation", "before", "base-sha");

    const variant = store.requestNodeVariant({
      sessionId: "session-1",
      laneId: "lane-implementation",
      checkpointId: "checkpoint-before-implementation",
      intentId: "variant-intent-idempotent",
      successorLaneId: "lane-implementation-variant",
      successorSemanticKey: "variant:lane-implementation:idempotent",
      now: "2026-06-14T00:00:20.000Z",
    });
    const eventCountBeforeRetry = store.listEvents("session-1").length;
    const retry = store.requestNodeVariant({
      sessionId: "session-1",
      laneId: "lane-implementation",
      checkpointId: "checkpoint-before-implementation",
      intentId: "variant-intent-idempotent",
      successorLaneId: "lane-implementation-variant",
      successorSemanticKey: "variant:lane-implementation:idempotent",
      now: "2026-06-14T00:00:21.000Z",
    });
    const beforeSchedule = store.materializeFlowProjection("session-1");
    const scheduled = store.scheduleReadyLanes("session-1", {
      allowedParallelism: 2,
      now: "2026-06-14T00:00:22.000Z",
    });
    const afterSchedule = store.materializeFlowProjection("session-1");
    store.close();

    const reopened = createWorkflowStore({ projectRoot });

    expect(retry.event.id).toBe(variant.event.id);
    expect(reopened.listEvents("session-1")).toHaveLength(eventCountBeforeRetry + 1);
    expect(beforeSchedule.lanes.find((lane) => lane.id === "lane-implementation")).toMatchObject({ status: "completed" });
    expect(beforeSchedule.lanes.find((lane) => lane.id === "lane-implementation-variant")).toMatchObject({
      status: "pending",
      semanticKey: "variant:lane-implementation:idempotent",
    });
    expect(beforeSchedule.checkpointIntents.filter((intent) => intent.intentId === "variant-intent-idempotent")).toHaveLength(1);
    expect(beforeSchedule.edges).toContainEqual(expect.objectContaining({
      sourceLaneId: "lane-upstream",
      targetLaneId: "lane-implementation-variant",
    }));
    expect(scheduled.readyLanes.map((lane) => lane.id)).toEqual(["lane-implementation-variant"]);
    expect(afterSchedule.lanes.find((lane) => lane.id === "lane-implementation")).toMatchObject({ status: "completed" });
    expect(afterSchedule.lanes.find((lane) => lane.id === "lane-implementation-variant")).toMatchObject({ status: "running" });
    expect(reopened.materializeFlowProjection("session-1")).toEqual(afterSchedule);
    reopened.close();
  });

  it("does not append successor edges when an idempotent variant retry sees incoming-edge drift", async () => {
    const store = await makeSeededStore();
    declareCodeChangeWorkflow(store);
    recordCheckpoint(store, "checkpoint-before-implementation", "lane-implementation", "before", "base-sha");
    const variant = store.requestNodeVariant({
      sessionId: "session-1",
      laneId: "lane-implementation",
      checkpointId: "checkpoint-before-implementation",
      intentId: "variant-intent-1",
      successorLaneId: "lane-implementation-variant",
      successorSemanticKey: "variant:lane-implementation:manual",
      now: "2026-06-14T00:00:20.000Z",
    });
    store.appendWorkflowEvent({
      sessionId: "session-1",
      kind: "workflow.edge.declared",
      source: "test",
      idempotencyKey: "edge-drift-validation-to-implementation",
      payload: {
        edge: {
          id: "edge-validation-implementation-drift",
          sourceLaneId: "lane-validation",
          targetLaneId: "lane-implementation",
        },
      },
      now: "2026-06-14T00:00:21.000Z",
    });
    const eventCountBeforeRetry = store.listEvents("session-1").length;
    const edgesBeforeRetry = store.materializeFlowProjection("session-1").edges;

    const retry = store.requestNodeVariant({
      sessionId: "session-1",
      laneId: "lane-implementation",
      checkpointId: "checkpoint-before-implementation",
      intentId: "variant-intent-1",
      successorLaneId: "lane-implementation-variant",
      successorSemanticKey: "variant:lane-implementation:manual",
      now: "2026-06-14T00:00:22.000Z",
    });

    expect(retry.event.id).toBe(variant.event.id);
    expect(store.listEvents("session-1")).toHaveLength(eventCountBeforeRetry);
    expect(store.materializeFlowProjection("session-1").edges).toEqual(edgesBeforeRetry);
    expect(store.materializeFlowProjection("session-1").edges).not.toContainEqual(expect.objectContaining({
      sourceLaneId: "lane-validation",
      targetLaneId: "lane-implementation-variant",
    }));
    store.close();
  });

  it("replays worktree cleanup failures through the Flow Kernel projection", async () => {
    const store = await makeSeededStore();
    const event = store.appendWorkflowEvent({
      sessionId: "session-1",
      kind: "workflow.worktree.clean_failed",
      source: "git-worktree",
      idempotencyKey: "worktree:cleanup-failed",
      payload: {
        worktreeId: "worktree-session-1-lane-implementation",
        reason: "dirty worktree",
      },
      now: "2026-06-14T00:00:03.000Z",
    });

    const projection = store.materializeFlowProjection("session-1");

    expect(event.kind).toBe("workflow.worktree.clean_failed");
    expect(projection.events).toEqual(expect.arrayContaining([
      expect.objectContaining({ kind: "workflow.worktree.clean_failed" }),
    ]));
    expect(projection.worktrees).toEqual([]);
    store.close();
  });

  it("replays a later delivery push as the current pull request head for check gates", async () => {
    const store = await makeSeededStore();
    const checksRecordedKind = "workflow.pull_request.checks_recorded" as FlowEventKind;

    store.appendWorkflowEvent({
      sessionId: "session-1",
      kind: "workflow.lane.declared",
      source: "test",
      idempotencyKey: "lane:commit",
      payload: { lane: { id: "lane-commit", semanticKey: "lane-commit", kind: "commit", title: "Commit", agentKind: "codex", status: "running" } },
      now: "2026-06-14T00:00:02.500Z",
    });
    store.appendWorkflowEvent({
      sessionId: "session-1",
      kind: "workflow.lane.declared",
      source: "test",
      idempotencyKey: "lane:ci",
      payload: { lane: { id: "lane-ci", semanticKey: "lane-ci", kind: "ci_check", title: "CI check", agentKind: "codex", status: "running" } },
      now: "2026-06-14T00:00:03.000Z",
    });
    store.appendWorkflowEvent({
      sessionId: "session-1",
      kind: "workflow.lane.declared",
      source: "test",
      idempotencyKey: "lane:pr",
      payload: { lane: { id: "lane-pr", semanticKey: "lane-pr", kind: "pull_request", title: "Create PR", agentKind: "codex", status: "running" } },
      now: "2026-06-14T00:00:03.500Z",
    });
    store.appendWorkflowEvent({
      sessionId: "session-1",
      kind: "workflow.pull_request.created",
      source: "test",
      idempotencyKey: "pr:created",
      payload: {
        laneId: "lane-pr",
        commitLaneId: "lane-commit",
        evidence: { number: 21, url: "https://example.test/pr/21", head: "feature/slice-b", commitSha: "sha-a" },
      },
      now: "2026-06-14T00:00:04.000Z",
    });
    store.appendWorkflowEvent({
      sessionId: "session-1",
      kind: "workflow.delivery.pushed",
      source: "test",
      idempotencyKey: "delivery:pushed",
      payload: {
        laneId: "lane-commit",
        url: "https://example.test/compare",
        evidence: { remote: "origin", branch: "feature/slice-b", commitSha: "sha-b" },
      },
      now: "2026-06-14T00:00:05.000Z",
    });
    store.appendWorkflowEvent({
      sessionId: "session-1",
      kind: checksRecordedKind,
      source: "test",
      idempotencyKey: "pr:checks:stale",
      payload: {
        laneId: "lane-ci",
        prNumber: 21,
        url: "https://example.test/pr/21/checks",
        headSha: "sha-a",
        status: "passed",
        checks: [{ name: "Build and test", status: "passed", url: "https://example.test/checks/old" }],
      },
      now: "2026-06-14T00:00:06.000Z",
    });

    const stale = store.materializeFlowProjection("session-1");
    expect(stale.lanes.find((lane) => lane.id === "lane-ci")?.status).toBe("running");
    expect(stale.lanes.find((lane) => lane.id === "lane-commit")?.status).toBe("running");
    expect(stale.lanes.find((lane) => lane.id === "lane-pr")?.status).toBe("running");
    expect(stale.evidence.map((item) => [item.kind, item.status])).toContainEqual(["pull-request-checks", "passed"]);
    const staleLoopState = store.getLoopEngineeringState("session-1");
    expect(staleLoopState.delivery.phase).toBe("checks_stale");
    expect(staleLoopState.evidenceStale).toBe(true);
    expect(staleLoopState.blockedReason).toMatchObject({ code: "stale_head" });

    store.appendWorkflowEvent({
      sessionId: "session-1",
      kind: checksRecordedKind,
      source: "test",
      idempotencyKey: "pr:checks:pending",
      payload: {
        laneId: "lane-ci",
        prNumber: 21,
        url: "https://example.test/pr/21/checks",
        headSha: "sha-b",
        status: "pending",
        checks: [{ name: "Build and test", status: "pending", url: "https://example.test/checks/pending" }],
      },
      now: "2026-06-14T00:00:07.000Z",
    });
    expect(store.materializeFlowProjection("session-1").lanes.find((lane) => lane.id === "lane-ci")?.status).toBe("running");

    store.appendWorkflowEvent({
      sessionId: "session-1",
      kind: checksRecordedKind,
      source: "test",
      idempotencyKey: "pr:checks:passed",
      payload: {
        laneId: "lane-ci",
        prNumber: 21,
        url: "https://example.test/pr/21/checks",
        headSha: "sha-b",
        status: "passed",
        review: { status: "approved" },
        checks: [{ name: "Build and test", status: "passed", url: "https://example.test/checks/current" }],
      },
      now: "2026-06-14T00:00:08.000Z",
    });

    const exact = store.materializeFlowProjection("session-1");
    expect(exact.lanes.find((lane) => lane.id === "lane-ci")?.status).toBe("completed");
    expect(exact.lanes.find((lane) => lane.id === "lane-commit")?.status).toBe("running");
    expect(exact.lanes.find((lane) => lane.id === "lane-pr")?.status).toBe("running");
    expect(exact.evidence.at(-1)).toMatchObject({
      laneId: "lane-ci",
      kind: "pull-request-checks",
      status: "passed",
      checks: ["Build and test:passed", "review:approved"],
    });
    expect(store.getLoopEngineeringState("session-1").nextAction).toMatchObject({
      kind: "merge_pull_request",
      loop: "delivery",
      laneId: "lane-ci",
    });
    store.close();
  });

  it("replays stale checks when a newer delivery push arrives after exact-head checks passed", async () => {
    const store = await makeSeededStore();
    const checksRecordedKind = "workflow.pull_request.checks_recorded" as FlowEventKind;

    store.appendWorkflowEvent({
      sessionId: "session-1",
      kind: "workflow.lane.declared",
      source: "test",
      idempotencyKey: "lane:commit:post-check-push",
      payload: { lane: { id: "lane-commit", semanticKey: "lane-commit", kind: "commit", title: "Commit", agentKind: "codex", status: "running" } },
      now: "2026-06-14T00:00:02.500Z",
    });
    store.appendWorkflowEvent({
      sessionId: "session-1",
      kind: "workflow.lane.declared",
      source: "test",
      idempotencyKey: "lane:ci:post-check-push",
      payload: { lane: { id: "lane-ci", semanticKey: "lane-ci", kind: "ci_check", title: "CI check", agentKind: "codex", status: "running" } },
      now: "2026-06-14T00:00:03.000Z",
    });
    store.appendWorkflowEvent({
      sessionId: "session-1",
      kind: "workflow.lane.declared",
      source: "test",
      idempotencyKey: "lane:pr:post-check-push",
      payload: { lane: { id: "lane-pr", semanticKey: "lane-pr", kind: "pull_request", title: "Create PR", agentKind: "codex", status: "running" } },
      now: "2026-06-14T00:00:03.500Z",
    });
    store.appendWorkflowEvent({
      sessionId: "session-1",
      kind: "workflow.pull_request.created",
      source: "test",
      idempotencyKey: "pr:created:post-check-push",
      payload: {
        laneId: "lane-pr",
        commitLaneId: "lane-commit",
        evidence: { number: 22, url: "https://example.test/pr/22", head: "feature/slice-c", commitSha: "sha-a" },
      },
      now: "2026-06-14T00:00:04.000Z",
    });
    store.appendWorkflowEvent({
      sessionId: "session-1",
      kind: checksRecordedKind,
      source: "test",
      idempotencyKey: "pr:checks:passed:post-check-push",
      payload: {
        laneId: "lane-ci",
        prNumber: 22,
        url: "https://example.test/pr/22/checks",
        headSha: "sha-a",
        status: "passed",
        checks: [{ name: "Build and test", status: "passed", url: "https://example.test/checks/current" }],
      },
      now: "2026-06-14T00:00:05.000Z",
    });
    store.appendWorkflowEvent({
      sessionId: "session-1",
      kind: "workflow.delivery.pushed",
      source: "test",
      idempotencyKey: "delivery:pushed:post-check-push",
      payload: {
        laneId: "lane-commit",
        url: "https://example.test/compare",
        evidence: { remote: "origin", branch: "feature/slice-c", commitSha: "sha-b" },
      },
      now: "2026-06-14T00:00:06.000Z",
    });

    const loopState = store.getLoopEngineeringState("session-1");
    expect(loopState.delivery.phase).toBe("checks_stale");
    expect(loopState.delivery.headSha).toBe("sha-b");
    expect(loopState.delivery.lastCheckedHeadSha).toBe("sha-a");
    expect(loopState.evidenceStale).toBe(true);
    expect(loopState.nextAction.kind).not.toBe("merge_pull_request");
    expect(loopState.nextAction).toMatchObject({
      kind: "blocked",
      loop: "delivery",
      laneId: "lane-ci",
    });
    expect(loopState.blockedReason).toMatchObject({ code: "stale_head" });
    store.close();
  });

  it("replays rollback loop state for the selected lane without inheriting another lane intent", async () => {
    const store = await makeSeededStore();

    store.appendWorkflowEvent({
      sessionId: "session-1",
      kind: "workflow.lane.declared",
      source: "test",
      idempotencyKey: "lane:a:rollback-selected-replay",
      payload: { lane: { id: "lane-a", semanticKey: "lane-a", kind: "implementation", title: "Lane A", agentKind: "codex", status: "completed" } },
      now: "2026-06-14T00:00:02.500Z",
    });
    store.appendWorkflowEvent({
      sessionId: "session-1",
      kind: "workflow.lane.declared",
      source: "test",
      idempotencyKey: "lane:b:rollback-selected-replay",
      payload: { lane: { id: "lane-b", semanticKey: "lane-b", kind: "validation", title: "Lane B", agentKind: "codex", status: "completed" } },
      now: "2026-06-14T00:00:03.000Z",
    });
    recordCheckpoint(store, "checkpoint-before-lane-a", "lane-a", "before", "restore-a");
    recordCheckpoint(store, "checkpoint-before-lane-b", "lane-b", "before", "restore-b");
    store.appendWorkflowEvent({
      sessionId: "session-1",
      kind: "workflow.node.rollback_requested",
      source: "test",
      laneId: "lane-a",
      idempotencyKey: "rollback:lane-a:selected-replay",
      payload: {
        requestId: "rollback-lane-a",
        laneId: "lane-a",
        checkpointId: "checkpoint-before-lane-a",
        localRollbackSafe: true,
      },
      now: "2026-06-14T00:00:09.000Z",
    });

    const loopState = store.getLoopEngineeringState("session-1", { selectedLaneId: "lane-b" });

    expect(loopState.rollback).toMatchObject({
      phase: "ready",
      targetLaneId: "lane-b",
      targetNodeId: "lane-b",
      checkpointId: "checkpoint-before-lane-b",
      restoreCommitRef: "restore-b",
      affectedLaneIds: ["lane-b"],
    });
    expect(loopState.rollback).not.toMatchObject({
      phase: "requested",
      checkpointId: "checkpoint-before-lane-a",
    });
    expect(loopState.rollback).not.toHaveProperty("blockedReason");
    expect(loopState.nextAction).toMatchObject({
      kind: "rollback_node",
      loop: "rollback",
      laneId: "lane-b",
      checkpointId: "checkpoint-before-lane-b",
    });
    expect(loopState.blockedReason).toBeUndefined();
    store.close();
  });

  it("replays Electron nested pull request checks evidence from the SQLite ledger", async () => {
    const store = await makeSeededStore();
    const checksRecordedKind = "workflow.pull_request.checks_recorded" as FlowEventKind;

    store.appendWorkflowEvent({
      sessionId: "session-1",
      kind: "workflow.lane.declared",
      source: "test",
      idempotencyKey: "lane:commit:nested-checks",
      payload: { lane: { id: "lane-commit", semanticKey: "lane-commit", kind: "commit", title: "Commit", agentKind: "codex", status: "running" } },
      now: "2026-06-14T00:00:02.500Z",
    });
    store.appendWorkflowEvent({
      sessionId: "session-1",
      kind: "workflow.lane.declared",
      source: "test",
      idempotencyKey: "lane:ci:nested-checks",
      payload: { lane: { id: "lane-ci", semanticKey: "lane-ci", kind: "ci_check", title: "CI check", agentKind: "codex", status: "running" } },
      now: "2026-06-14T00:00:03.000Z",
    });
    store.appendWorkflowEvent({
      sessionId: "session-1",
      kind: "workflow.lane.declared",
      source: "test",
      idempotencyKey: "lane:pr:nested-checks",
      payload: { lane: { id: "lane-pr", semanticKey: "lane-pr", kind: "pull_request", title: "Create PR", agentKind: "codex", status: "running" } },
      now: "2026-06-14T00:00:03.500Z",
    });
    store.appendWorkflowEvent({
      sessionId: "session-1",
      kind: "workflow.pull_request.created",
      source: "test",
      idempotencyKey: "pr:created:nested-checks",
      payload: {
        laneId: "lane-pr",
        commitLaneId: "lane-commit",
        evidence: { number: 22, url: "https://example.test/pr/22", head: "feature/slice-c", commitSha: "sha-c" },
      },
      now: "2026-06-14T00:00:04.000Z",
    });
    store.appendWorkflowEvent({
      sessionId: "session-1",
      kind: "workflow.delivery.pushed",
      source: "test",
      idempotencyKey: "delivery:pushed:nested-checks",
      payload: {
        laneId: "lane-commit",
        evidence: { remote: "origin", branch: "feature/slice-c", commitSha: "sha-c" },
      },
      now: "2026-06-14T00:00:05.000Z",
    });
    store.appendWorkflowEvent({
      sessionId: "session-1",
      kind: checksRecordedKind,
      source: "electron-main",
      idempotencyKey: "pr:checks:nested-passed",
      payload: {
        laneId: "lane-ci",
        evidence: {
          status: "passed",
          number: 22,
          url: "https://example.test/pr/22",
          headSha: "sha-c",
          review: { status: "approved" },
          checks: [{ name: "Build and test", status: "passed", link: "https://example.test/checks/current" }],
        },
      },
      now: "2026-06-14T00:00:06.000Z",
    });

    const projection = store.materializeFlowProjection("session-1");
    expect(projection.lanes.find((lane) => lane.id === "lane-ci")?.status).toBe("completed");
    expect(projection.lanes.find((lane) => lane.id === "lane-commit")?.status).toBe("running");
    expect(projection.lanes.find((lane) => lane.id === "lane-pr")?.status).toBe("running");
    expect(projection.evidence.at(-1)).toMatchObject({
      laneId: "lane-ci",
      kind: "pull-request-checks",
      status: "passed",
      checks: ["Build and test:passed", "review:approved"],
      artifacts: ["https://example.test/pr/22", "https://example.test/checks/current"],
    });
    store.close();
  });

  it("restores delivery review gate state from event replay after restart", async () => {
    const projectRoot = await makeTempRoot();
    const store = createWorkflowStore({ projectRoot });
    seedStore(store);
    const checksRecordedKind = "workflow.pull_request.checks_recorded" as FlowEventKind;

    store.appendWorkflowEvent({
      sessionId: "session-1",
      kind: "workflow.lane.declared",
      source: "test",
      idempotencyKey: "lane:ci:review-replay",
      payload: { lane: { id: "lane-ci", semanticKey: "lane-ci", kind: "ci_check", title: "CI check", agentKind: "codex", status: "running" } },
      now: "2026-06-14T00:00:03.000Z",
    });
    store.appendWorkflowEvent({
      sessionId: "session-1",
      kind: "workflow.pull_request.created",
      source: "test",
      idempotencyKey: "pr:created:review-replay",
      payload: {
        laneId: "lane-ci",
        prNumber: 23,
        url: "https://example.test/pr/23",
        headSha: "sha-review",
      },
      now: "2026-06-14T00:00:04.000Z",
    });
    store.appendWorkflowEvent({
      sessionId: "session-1",
      kind: checksRecordedKind,
      source: "electron-main",
      idempotencyKey: "pr:checks:review-replay",
      payload: {
        laneId: "lane-ci",
        evidence: {
          status: "passed",
          number: 23,
          url: "https://example.test/pr/23",
          headSha: "sha-review",
          review: { status: "changes_requested", detail: "Reviewer requested changes." },
          checks: [{ name: "Build and test", status: "passed", link: "https://example.test/checks/review" }],
        },
      },
      now: "2026-06-14T00:00:06.000Z",
    });
    store.close();

    const restarted = createWorkflowStore({ projectRoot });
    const loopState = restarted.getLoopEngineeringState("session-1");

    expect(loopState.delivery).toMatchObject({
      phase: "changes_requested",
      review: { status: "changes_requested", detail: "Reviewer requested changes." },
    });
    expect(loopState.blockedReason).toMatchObject({ code: "changes_requested" });
    expect(restarted.materializeFlowProjection("session-1").evidence.at(-1)).toMatchObject({
      kind: "pull-request-checks",
      status: "failed",
      checks: ["Build and test:passed", "review:changes_requested"],
    });
    restarted.close();
  });

  it("builds a redacted ledger summary from persisted user inputs and recent events", async () => {
    const store = await makeSeededStore();

    store.appendUserInput({
      sessionId: "session-1",
      inputId: "input-1",
      text: "Add audit logging and keep the retry decision explicit. token=sk-secret-123",
      now: "2026-06-14T00:00:01.000Z",
    });
    store.applyWorkflowIntent({
      intentId: "intent-audit-1",
      sessionId: "session-1",
      operations: [
        { type: "AnalyzeRequirement", requirement: "Add audit logging and preserve key retry decisions" },
        { type: "DiscoverProject", profile: { languages: ["typescript"], capabilities: ["code-change"] } },
        { type: "ProposeLanes" },
      ],
    }, "2026-06-14T00:00:02.000Z");
    store.appendWorkflowEvent({
      sessionId: "session-1",
      kind: "workflow.segment.output_delta",
      source: "codex",
      laneId: "lane-implementation",
      segmentId: "segment-implementation-1",
      idempotencyKey: "raw-output",
      payload: {
        laneId: "lane-implementation",
        delta: {
          protocolVersion: 1,
          runId: "run-ledger-output",
          seq: 1,
          timestamp: "2026-06-14T00:00:03.000Z",
          kind: "output",
          payload: {
            text: [
              "stderr BEGIN",
              "OPENAI_API_KEY=sk-do-not-leak",
              "read .env with DATABASE_URL=postgres://secret",
              "diff --git a/src/a.ts b/src/a.ts",
              "+".repeat(7000),
              "stderr END",
            ].join("\n"),
          },
        },
      },
      now: "2026-06-14T00:00:03.000Z",
    });
    store.appendUserInput({
      sessionId: "session-1",
      inputId: "input-2",
      text: "Now export the ledger summary before Hermes starts again.",
      now: "2026-06-14T00:00:04.000Z",
    });

    const ledger = store.buildLedgerSummary("session-1");
    const serialized = JSON.stringify(ledger);

    expect(ledger.throughSeq).toBe(store.listEvents("session-1").at(-1)?.seq);
    expect(ledger.facts.join("\n")).toContain("Add audit logging");
    expect(ledger.facts.join("\n")).toContain("retry decision");
    expect(ledger.recentEvents.map((event) => event.kind)).toContain("workflow.user_input");
    expect(serialized).toContain("[REDACTED]");
    expect(serialized).not.toContain("sk-do-not-leak");
    expect(serialized).not.toContain("OPENAI_API_KEY");
    expect(serialized).not.toContain(".env");
    expect(serialized).not.toContain("diff --git");
    expect(serialized).not.toContain("stderr BEGIN");
    expect(serialized.length).toBeLessThan(4_000);
  });

  it.each([
    ["text-only downgrade", "codex", "invalid-output:text-only", { text: "legacy without provenance" }],
    [
      "text-only forged compatibility",
      "codex",
      "invalid-output:forged-compatibility",
      { text: "forged legacy", compatibilitySource: "legacy-disk" },
    ],
    [
      "text-only trusted-looking metadata",
      "persistence-migration",
      "legacy-disk:output:1",
      { text: "forged trusted source" },
    ],
    [
      "typed forged compatibility",
      "codex",
      "invalid-output:typed-forged-compatibility",
      {
        compatibilitySource: "legacy-disk",
        delta: runOutputEvent("run-typed-forged-compatibility", 1, "typed"),
      },
    ],
    ["malformed delta", "codex", "invalid-output:malformed", { text: "forged", delta: { malformed: true } }],
    [
      "mismatched typed text",
      "codex",
      "invalid-output:mismatched-text",
      {
        text: "forged",
        delta: runOutputEvent("run-output-mismatch", 1, "typed"),
      },
    ],
    [
      "patch-only forged text",
      "codex",
      "invalid-output:patch-only",
      {
        text: "forged",
        delta: {
          protocolVersion: 1,
          runId: "run-patch-forged-text",
          seq: 1,
          timestamp: "2026-06-14T00:00:03.000Z",
          kind: "changes",
          payload: { patch: { path: "src/a.ts", hunks: [] } },
        },
      },
    ],
    [
      "disallowed status event",
      "codex",
      "invalid-output:status",
      {
        delta: {
          protocolVersion: 1,
          runId: "run-status-output",
          seq: 1,
          timestamp: "2026-06-14T00:00:03.000Z",
          kind: "status",
          payload: { status: "succeeded", exitCode: 0 },
        },
      },
    ],
  ] as const)("rejects invalid current workflow output delta without a SQLite write: %s", async (
    _label,
    source,
    idempotencyKey,
    payload,
  ) => {
    const store = await makeSeededStore();
    declareCodeChangeWorkflow(store);
    const before = store.listEvents("session-1");

    expect(() => store.appendWorkflowEvent({
      sessionId: "session-1",
      kind: "workflow.segment.output_delta",
      source,
      laneId: "lane-implementation",
      segmentId: "segment-invalid-output",
      idempotencyKey,
      payload: { laneId: "lane-implementation", segmentId: "segment-invalid-output", ...payload },
      now: "2026-06-14T00:00:03.000Z",
    })).toThrow(/RunEvent output delta|required|mismatch|compatibility/i);
    expect(store.listEvents("session-1")).toEqual(before);
    expect(store.materializeFlowProjection("session-1").events.some((event) =>
      event.idempotencyKey === idempotencyKey
    )).toBe(false);
    store.close();
  });

  it("physically upgrades historical text-only output to a strict typed delta exactly once", async () => {
    const projectRoot = await makeTempRoot();
    let store = createWorkflowStore({ projectRoot });
    seedStore(store);
    declareCodeChangeWorkflow(store);
    store.scheduleReadyLanes("session-1", {
      allowedParallelism: 1,
      now: "2026-06-14T00:00:02.500Z",
    });
    const segmentId = "segment-session-1-lane-implementation";
    const runId = "run-session-1-lane-implementation";
    const inserted = store.appendWorkflowEvent({
      sessionId: "session-1",
      kind: "workflow.segment.output_delta",
      source: "codex",
      laneId: "lane-implementation",
      segmentId,
      idempotencyKey: "legacy-output",
      payload: {
        laneId: "lane-implementation",
        segmentId,
        delta: runOutputEvent(runId, 1, "typed before migration"),
      },
      now: "2026-06-14T00:00:03.000Z",
    });
    store.close();

    const databasePath = join(projectRoot, ".devflow", "skyturn-workflow.sqlite");
    const legacy = new Database(databasePath);
    legacy.prepare([
      "UPDATE workflow_events SET payload_json = ?, legacy_evidence_compatibility = 0",
      "WHERE id = ?",
    ].join(" ")).run(JSON.stringify({
      laneId: "lane-implementation",
      segmentId,
      text: "  historical output\n",
      compatibilitySource: "legacy-disk",
    }), inserted.id);
    legacy.prepare("DELETE FROM schema_migrations WHERE version = 6").run();
    legacy.pragma("wal_checkpoint(TRUNCATE)");
    legacy.close();

    store = createWorkflowStore({ projectRoot });
    const events = store.listEvents("session-1");
    const projection = store.materializeFlowProjection("session-1");
    const canvas = store.materializeCanvasSession("session-1");
    const migratedEvent = events.find((event) => event.id === inserted.id);
    const lane = projection.lanes.find((candidate) => candidate.id === "lane-implementation");
    const node = canvas?.nodes.find((candidate) => candidate.id === "lane-implementation");
    expect(migratedEvent).toMatchObject({
      id: inserted.id,
      seq: inserted.seq,
      idempotencyKey: "legacy-output",
      payload: {
        laneId: "lane-implementation",
        segmentId,
        text: "  historical output\n",
        delta: {
          protocolVersion: 1,
          runId,
          seq: inserted.seq,
          timestamp: inserted.createdAt,
          kind: "output",
          payload: { text: "  historical output\n" },
        },
      },
    });
    expect(migratedEvent?.payload).not.toHaveProperty("compatibilitySource");
    expect(lane?.output).toEqual(["  historical output\n"]);
    expect(lane?.outputDeltas).toEqual([migratedEvent?.payload.delta]);
    expect(node?.output).toEqual(["  historical output\n"]);
    expect(node?.outputDeltas).toEqual([migratedEvent?.payload.delta]);
    store.close();

    const migrated = new Database(databasePath);
    const raw = migrated.prepare(
      "SELECT id, seq, idempotency_key, payload_json, legacy_evidence_compatibility FROM workflow_events WHERE id = ?",
    ).get(inserted.id) as {
      id: string;
      seq: number;
      idempotency_key: string;
      payload_json: string;
      legacy_evidence_compatibility: number;
    };
    expect(raw.id).toBe(inserted.id);
    expect(raw.seq).toBe(inserted.seq);
    expect(raw.idempotency_key).toBe("legacy-output");
    expect(raw.legacy_evidence_compatibility).toBe(0);
    expect(JSON.parse(raw.payload_json)).toEqual(migratedEvent?.payload);
    expect(raw.payload_json).not.toContain("compatibilitySource");
    expect(migrated.prepare("SELECT COUNT(*) AS count FROM schema_migrations WHERE version = 6").get()).toEqual({ count: 1 });
    migrated.exec(`
      CREATE TRIGGER reject_repeated_output_migration_update
      BEFORE UPDATE ON workflow_events
      BEGIN
        SELECT RAISE(ABORT, 'unexpected repeated output migration update');
      END;
      CREATE TRIGGER reject_repeated_output_migration_marker
      BEFORE INSERT ON schema_migrations
      WHEN NEW.version = 6
      BEGIN
        SELECT RAISE(ABORT, 'unexpected repeated output migration marker');
      END;
    `);
    migrated.pragma("wal_checkpoint(TRUNCATE)");
    migrated.close();

    const beforeReopenBytes = await readFile(databasePath);
    const reopened = createWorkflowStore({ projectRoot });
    expect(reopened.listEvents("session-1")).toEqual(events);
    expect(reopened.materializeFlowProjection("session-1")).toEqual(projection);
    expect(reopened.materializeCanvasSession("session-1")).toEqual(canvas);
    reopened.close();
    expect(await readFile(databasePath)).toEqual(beforeReopenBytes);
  });

  it("schedules runnable lanes and records RunEvidence through the Flow Kernel event stream", async () => {
    const store = await makeSeededStore();
    declareCodeChangeWorkflow(store);

    const scheduled = store.scheduleReadyLanes("session-1", {
      allowedParallelism: 1,
      now: "2026-06-14T00:00:03.000Z",
    });
    const duplicateSchedule = store.scheduleReadyLanes("session-1", {
      allowedParallelism: 1,
      now: "2026-06-14T00:00:04.000Z",
    });

    expect(scheduled.readyLanes.map((lane) => lane.id)).toEqual(["lane-implementation"]);
    expect(scheduled.readyLanes[0]?.runId).toBe("run-session-1-lane-implementation");
    expect(duplicateSchedule.readyLanes).toEqual([]);
    expect(store.listEvents("session-1").filter((event) => event.kind === "workflow.segment.started")).toHaveLength(1);

    const evidence = {
      runId: "run-session-1-lane-implementation",
      status: "succeeded",
      exitCode: 0,
      changesetId: "changeset-implementation-1",
      checks: [{ kind: "test", name: "pnpm test", status: "passed", detail: "2 passed" }],
      artifacts: [".devflow/acceptance/session-1/lane-implementation/result.md"],
      review: null,
      errorReason: null,
      cancelReason: null,
      completedAt: "2026-06-14T00:00:05.000Z",
    } satisfies RunEvidence;

    store.recordRunResult({
      sessionId: "session-1",
      laneId: "lane-implementation",
      segmentId: "segment-session-1-lane-implementation",
      runId: evidence.runId,
      agentKind: "codex",
      outputSummary: "Implemented status filtering with tests.",
      evidence,
      now: "2026-06-14T00:00:05.000Z",
    });

    const projection = store.materializeFlowProjection("session-1");
    const canvas = store.materializeCanvasSession("session-1");

    expect(projection.lanes.find((lane) => lane.id === "lane-implementation")?.status).toBe("completed");
    expect(projection.evidence).toMatchObject([
      {
        laneId: "lane-implementation",
        segmentId: "segment-session-1-lane-implementation",
        status: "passed",
      },
    ]);
    expect(canvas?.nodes.find((node) => node.id === "lane-implementation")).toMatchObject({
      status: "completed",
      runId: evidence.runId,
      changesetId: "changeset-implementation-1",
      output: [],
    });
  });

  it("rejects non-terminal or mismatched run result identity at the store boundary", async () => {
    const store = await makeSeededStore();
    declareCodeChangeWorkflow(store);
    advanceCodeChangeWorkflowToLane(store, "lane-implementation");
    const valid = runResultInput(store, "lane-implementation", "failed", "2026-06-14T00:00:05.000Z");

    const invalidInputs = [
      { label: "cross session", input: { ...valid, sessionId: "session-other" } },
      { label: "cross lane", input: { ...valid, laneId: "lane-validation" } },
      { label: "cross segment", input: { ...valid, segmentId: "segment-session-1-lane-validation" } },
      { label: "wrong request run", input: { ...valid, runId: "run-other" } },
      { label: "wrong evidence run", input: { ...valid, evidence: { ...valid.evidence, runId: "run-other" } } },
      { label: "wrong agent", input: { ...valid, agentKind: "hermes" as const } },
      { label: "non-terminal evidence", input: { ...valid, evidence: { ...valid.evidence, status: "running" } as RunEvidence } },
    ];

    for (const { label, input } of invalidInputs) {
      expect(() => store.recordRunResult(input), label).toThrow(/run result.*identity|terminal RunEvidence/i);
    }
    expect(store.listRunningSegments()).toHaveLength(1);
    store.close();

    const reopened = createWorkflowStore({ projectRoot: dirname(dirname(store.databasePath)) });
    expect(reopened.listRunningSegments()).toEqual([
      expect.objectContaining({
        sessionId: valid.sessionId,
        laneId: valid.laneId,
        segmentId: valid.segmentId,
        runId: valid.runId,
        status: "running",
      }),
    ]);
    expect(reopened.listEvents(valid.sessionId).filter((event) => event.kind === "workflow.segment.finished")).toEqual([]);
    reopened.close();
  });

  it("replays executable terminal results only when full evidence and output are identical", async () => {
    const projectRoot = await makeTempRoot();
    let store = createWorkflowStore({ projectRoot });
    seedStore(store);
    declareCodeChangeWorkflow(store);
    advanceCodeChangeWorkflowToLane(store, "lane-implementation");
    const baseInput = runResultInput(store, "lane-implementation", "succeeded", "2026-06-14T00:00:05.000Z");
    const typedDeltas = [
      runOutputEvent(baseInput.runId, 1, "  exact executable output\n"),
      runProgressEvent(baseInput.runId, 2, "\texact executable progress  \n", "codex"),
      runChangesEvent(baseInput.runId, 3, "codex"),
    ];
    const input = {
      ...baseInput,
      outputSummary: "Executable compact summary is metadata only.",
      runEvents: typedDeltas,
    };

    const assertReplayContract = () => {
      const eventsBefore = store.listEvents(input.sessionId);
      const projectionBefore = store.materializeFlowProjection(input.sessionId);
      const canvasBefore = store.materializeCanvasSession(input.sessionId);
      const outputEvents = eventsBefore.filter((event) =>
        event.kind === "workflow.segment.output_delta" && event.payload.segmentId === input.segmentId
      );
      expect(outputEvents.map((event) => event.payload.delta)).toEqual(typedDeltas);
      expect(projectionBefore.lanes.find((lane) => lane.id === input.laneId)?.output).toEqual([
        "  exact executable output\n",
        "\texact executable progress  \n",
      ]);
      expect(canvasBefore?.nodes.find((node) => node.id === input.laneId)?.outputDeltas).toEqual(typedDeltas);
      const lane = projectionBefore.lanes.find((candidate) => candidate.id === input.laneId);
      const node = canvasBefore?.nodes.find((candidate) => candidate.id === input.laneId);
      expect(JSON.stringify({
        outputEvents,
        laneOutput: lane?.output,
        laneOutputDeltas: lane?.outputDeltas,
        nodeOutput: node?.output,
        nodeOutputDeltas: node?.outputDeltas,
      })).not.toContain("Executable compact summary is metadata only.");
      expect(store.recordRunResult({ ...input, now: "2026-06-14T00:00:06.000Z" })).toEqual(projectionBefore);
      expect(store.listEvents(input.sessionId)).toEqual(eventsBefore);
      expect(store.recordRunResult({ ...input, outputSummary: "Different metadata summary.", now: "2026-06-14T00:00:06.500Z" })).toEqual(
        projectionBefore,
      );
      expect(store.listEvents(input.sessionId)).toEqual(eventsBefore);

      const conflicts = [
        { label: "status", input: { ...input, evidence: { ...input.evidence, status: "failed" as const } } },
        { label: "exit", input: { ...input, evidence: { ...input.evidence, exitCode: 17 } } },
        { label: "checks", input: { ...input, evidence: { ...input.evidence, checks: [{ ...input.evidence.checks[0]!, detail: "different" }] } } },
        { label: "changeset", input: { ...input, evidence: { ...input.evidence, changesetId: "changeset-conflict" } } },
        { label: "output", input: { ...input, runEvents: [runOutputEvent(input.runId, 1, "conflicting typed output\n")] } },
      ];
      for (const conflict of conflicts) {
        expect(() => store.recordRunResult({ ...conflict.input, now: "2026-06-14T00:00:07.000Z" }), conflict.label).toThrow(
          /executable terminal (evidence|output) conflict/i,
        );
        expect(store.listEvents(input.sessionId), conflict.label).toEqual(eventsBefore);
      }
    };

    store.recordRunResult(input);
    assertReplayContract();
    store.close();
    store = createWorkflowStore({ projectRoot });
    assertReplayContract();
    store.close();
  });

  it.each([
    ["generated", "Generated compact terminal summary.", "Generated compact terminal summary."],
    ["default", undefined, "Run succeeded; pnpm test: passed."],
    [
      "explicit",
      `${"Explicit compact summary ".repeat(30)}OPENAI_API_KEY=sk-summary-secret-123456789`,
      undefined,
    ],
  ] as const)(
    "keeps %s executable terminal summary as bounded metadata with empty authoritative output",
    async (_label, requestedSummary, expectedSummary) => {
      const projectRoot = await makeTempRoot();
      let store = createWorkflowStore({ projectRoot });
      seedStore(store);
      declareCodeChangeWorkflow(store);
      advanceCodeChangeWorkflowToLane(store, "lane-implementation");
      const base = runResultInput(store, "lane-implementation", "succeeded", "2026-06-14T00:00:05.000Z");
      const { outputSummary: _defaultSummary, ...withoutSummary } = base;
      const input = {
        ...withoutSummary,
        ...(requestedSummary === undefined ? {} : { outputSummary: requestedSummary }),
        runEvents: terminalOnlyRunEvents(base.runId),
      };

      store.recordRunResult(input);
      const firstEvents = store.listEvents("session-1");
      const firstProjection = store.materializeFlowProjection("session-1");
      expect(store.recordRunResult({
        ...input,
        outputSummary: "Replay summary must not replace stored metadata.",
        now: "2026-06-14T00:00:06.000Z",
      })).toEqual(firstProjection);
      expect(store.listEvents("session-1")).toEqual(firstEvents);
      store.close();

      store = createWorkflowStore({ projectRoot });
      const outputEvents = store.listEvents("session-1").filter((event) =>
        event.kind === "workflow.segment.output_delta" && event.payload.segmentId === base.segmentId
      );
      const projection = store.materializeFlowProjection("session-1");
      const canvasSession = store.materializeCanvasSession("session-1");
      const desktopPayload = { projectRoot, sessionId: "session-1", projection, canvasSession };
      const lane = projection.lanes.find((candidate) => candidate.id === base.laneId);
      const node = canvasSession?.nodes.find((candidate) => candidate.id === base.laneId);
      const evidenceEvent = store.listEvents("session-1").find((event) =>
        event.kind === "workflow.evidence.recorded" && event.payload.segmentId === base.segmentId
      );

      expect(outputEvents).toEqual([]);
      expect(lane?.output).toEqual([]);
      expect(lane?.outputDeltas).toBeUndefined();
      expect(node?.output).toEqual([]);
      expect(node?.outputDeltas).toBeUndefined();
      expect(desktopPayload.canvasSession?.nodes.find((candidate) => candidate.id === base.laneId)?.output).toEqual([]);
      expect(evidenceEvent?.payload.summary).toEqual(expectedSummary ?? expect.stringContaining("... [truncated]"));
      expect(String(evidenceEvent?.payload.summary ?? "").length).toBeLessThanOrEqual(320);
      expect(JSON.stringify({ events: store.listEvents("session-1"), projection, canvasSession })).not.toContain("sk-summary-secret");

      const reopenedEvents = store.listEvents("session-1");
      expect(store.recordRunResult({ ...input, now: "2026-06-14T00:00:07.000Z" })).toEqual(projection);
      expect(store.listEvents("session-1")).toEqual(reopenedEvents);
      store.close();
    },
  );

  it.each([
    ["generated", "Generated planner terminal summary.", "Generated planner terminal summary."],
    ["default", undefined, "Run succeeded; Hermes CLI exit: passed."],
    [
      "explicit",
      `${"Explicit planner summary ".repeat(30)}HERMES_API_KEY=sk-planner-summary-secret-123456789`,
      undefined,
    ],
  ] as const)(
    "keeps %s planner terminal summary as bounded metadata with empty authoritative output",
    async (_label, requestedSummary, expectedSummary) => {
      const projectRoot = await makeTempRoot();
      let store = createWorkflowStore({ projectRoot });
      seedStore(store);
      const runId = `run-session-1-node-1-summary-${_label}`;
      const { segment } = store.claimPlannerRunStart({
        sessionId: "session-1",
        laneId: "node-1",
        runId,
        agentKind: "hermes",
        worktreePath: projectRoot,
        now: "2026-06-14T00:00:01.000Z",
      });
      const completedAt = "2026-06-14T00:00:02.000Z";
      const evidence = plannerRunEvidence(runId, completedAt);
      const input = {
        sessionId: "session-1",
        laneId: "node-1",
        segmentId: segment.segmentId,
        runId,
        agentKind: "hermes" as const,
        ...(requestedSummary === undefined ? {} : { outputSummary: requestedSummary }),
        runEvents: terminalOnlyRunEvents(runId, "hermes"),
        evidence,
        now: completedAt,
      };

      store.recordRunResult(input);
      const firstEvents = store.listEvents("session-1");
      const firstProjection = store.materializeFlowProjection("session-1");
      expect(store.recordRunResult({
        ...input,
        outputSummary: "Replay planner summary must not replace stored metadata.",
        now: "2026-06-14T00:00:03.000Z",
      })).toEqual(firstProjection);
      expect(store.listEvents("session-1")).toEqual(firstEvents);
      store.close();

      store = createWorkflowStore({ projectRoot });
      const outputEvents = store.listEvents("session-1").filter((event) =>
        event.kind === "segment_output_delta" && event.segmentId === segment.segmentId
      );
      const projection = store.materializeFlowProjection("session-1");
      const canvasSession = store.materializeCanvasSession("session-1");
      const desktopPayload = { projectRoot, sessionId: "session-1", projection, canvasSession };
      const planner = canvasSession?.nodes.find((candidate) => candidate.id === "node-1");
      const evidenceEvent = store.listEvents("session-1").find((event) =>
        event.kind === "segment_evidence" && event.segmentId === segment.segmentId
      );

      expect(outputEvents).toEqual([]);
      expect(planner?.output).toEqual([]);
      expect(planner?.outputDeltas).toBeUndefined();
      expect(desktopPayload.canvasSession?.nodes.find((candidate) => candidate.id === "node-1")?.output).toEqual([]);
      expect(evidenceEvent?.payload.summary).toEqual(expectedSummary ?? expect.stringContaining("... [truncated]"));
      expect(String(evidenceEvent?.payload.summary ?? "").length).toBeLessThanOrEqual(320);
      expect(JSON.stringify({ events: store.listEvents("session-1"), projection, canvasSession })).not.toContain(
        "sk-planner-summary-secret",
      );

      const reopenedEvents = store.listEvents("session-1");
      expect(store.recordRunResult({ ...input, now: "2026-06-14T00:00:04.000Z" })).toEqual(projection);
      expect(store.listEvents("session-1")).toEqual(reopenedEvents);
      store.close();
    },
  );

  it("persists planner typed deltas exactly once and never duplicates its compact summary into output", async () => {
    const projectRoot = await makeTempRoot();
    let store = createWorkflowStore({ projectRoot });
    seedStore(store);
    const runId = "run-session-1-node-1-typed-output";
    const { segment } = store.claimPlannerRunStart({
      sessionId: "session-1",
      laneId: "node-1",
      runId,
      agentKind: "hermes",
      worktreePath: projectRoot,
      now: "2026-06-14T00:00:01.000Z",
    });
    const typedDeltas = [
      runOutputEvent(runId, 1, "  planner output\n"),
      runProgressEvent(runId, 2, "\tplanner progress  \n"),
      runChangesEvent(runId, 3),
    ];
    const completedAt = "2026-06-14T00:00:02.000Z";
    const evidence = plannerRunEvidence(runId, completedAt);
    const input = {
      sessionId: "session-1",
      laneId: "node-1",
      segmentId: segment.segmentId,
      runId,
      agentKind: "hermes" as const,
      outputSummary: "This compact summary is metadata only.",
      runEvents: [...typedDeltas, ...terminalOnlyRunEvents(runId, "hermes", 4)],
      evidence,
      now: completedAt,
    };

    store.recordRunResult(input);
    store.recordRunResult({ ...input, now: "2026-06-14T00:00:03.000Z" });
    store.close();
    store = createWorkflowStore({ projectRoot });

    const outputEvents = store.listEvents("session-1").filter((event) =>
      event.kind === "segment_output_delta" && event.segmentId === segment.segmentId
    );
    const planner = store.materializeCanvasSession("session-1")?.nodes.find((candidate) => candidate.id === "node-1");
    expect(outputEvents.map((event) => event.payload.delta)).toEqual(typedDeltas);
    expect(outputEvents.map((event) => event.payload.text).filter((text) => text !== undefined)).toEqual([
      "  planner output\n",
      "\tplanner progress  \n",
    ]);
    expect(planner?.output).toEqual(["  planner output\n", "\tplanner progress  \n"]);
    expect(planner?.outputDeltas).toEqual(typedDeltas);
    expect(JSON.stringify({ outputEvents, planner })).not.toContain("compact summary is metadata only");
    store.close();
  });

  it("materializes succeeded planner evidence on the root card after workflow lanes complete", async () => {
    const store = await makeStore();
    store.createWorkflowSession({
      id: "session-1",
      projectId: "project-1",
      title: "Persisted workflow",
      goal: "Implement event sourced workflow",
      mode: "fast",
      plannerProfile: "default",
      transport: "hermes_replay_recovery",
      recoveryReason: "Hermes live chat handle was not available during test setup.",
      now: "2026-06-14T00:00:00.000Z",
    });
    const plannerEvidence = {
      runId: "run-session-1-node-1",
      status: "succeeded",
      exitCode: 0,
      changesetId: null,
      checks: [{ kind: "run-exit", name: "Hermes CLI exit", status: "passed", detail: "exit 0" }],
      artifacts: [],
      review: null,
      errorReason: null,
      cancelReason: null,
      completedAt: "2026-06-14T00:00:01.000Z",
    } satisfies RunEvidence;

    store.recordRunResult({
      sessionId: "session-1",
      laneId: "node-1",
      segmentId: "segment-session-1-node-1",
      runId: plannerEvidence.runId,
      agentKind: "hermes",
      outputSummary: "Planner produced a workflow intent and concrete run evidence.",
      evidence: plannerEvidence,
      now: "2026-06-14T00:00:01.000Z",
    });
    declareCodeChangeWorkflow(store);
    const completedLaneIds: string[] = [];
    for (let index = 0; index < 8; index += 1) {
      const scheduled = store.scheduleReadyLanes("session-1", {
        allowedParallelism: 1,
        now: `2026-06-14T00:00:${String(3 + index * 2).padStart(2, "0")}.000Z`,
      });
      if (scheduled.readyLanes.length === 0) break;
      for (const lane of scheduled.readyLanes) {
        completedLaneIds.push(lane.id);
        store.recordRunResult(
          runResultInput(
            store,
            lane.id,
            "succeeded",
            `2026-06-14T00:00:${String(4 + index * 2).padStart(2, "0")}.000Z`,
          ),
        );
      }
    }

    const projection = store.materializeFlowProjection("session-1");
    const canvas = store.materializeCanvasSession("session-1");
    const planner = canvas?.nodes.find((node) => node.id === canvas.plannerNodeId);

    expect(completedLaneIds).toEqual(["lane-implementation", "lane-validation", "lane-review", "lane-commit"]);
    expect(projection.lanes.every((lane) => lane.status === "completed")).toBe(true);
    expect(planner).toMatchObject({
      id: "node-1",
      agent: "hermes",
      status: "completed",
      progress: "Evidence ready",
      runtime: { phase: "Completed" },
      runId: plannerEvidence.runId,
    });
    expect(planner?.context.dependencies).toEqual([]);
    expect(canvas?.edges.some((edge) => edge.target === canvas.plannerNodeId)).toBe(false);
  });

  it("replays identical planner terminal evidence idempotently and rejects conflicts across reopen", async () => {
    const projectRoot = await makeTempRoot();
    const store = createWorkflowStore({ projectRoot });
    seedStore(store);
    const runId = "run-session-1-node-1-terminal";
    const { segment } = store.claimPlannerRunStart({
      sessionId: "session-1",
      laneId: "node-1",
      runId,
      agentKind: "hermes",
      worktreePath: projectRoot,
      now: "2026-06-14T00:00:01.000Z",
    });
    const evidence = {
      runId,
      status: "succeeded",
      exitCode: 0,
      changesetId: null,
      checks: [{ kind: "run-exit", name: "Hermes CLI exit", status: "passed", detail: "exit 0" }],
      artifacts: [],
      review: null,
      errorReason: null,
      cancelReason: null,
      completedAt: "2026-06-14T00:00:02.000Z",
    } satisfies RunEvidence;
    const input = {
      sessionId: "session-1",
      laneId: "node-1",
      segmentId: segment.segmentId,
      runId,
      agentKind: "hermes" as const,
      outputSummary: "Planner terminal output.",
      evidence,
      now: "2026-06-14T00:00:02.000Z",
    };
    const conflictingInput = {
      ...input,
      evidence: {
        ...evidence,
        status: "failed" as const,
        exitCode: 1,
        errorReason: "Conflicting terminal result.",
        checks: [{ kind: "run-exit" as const, name: "Hermes CLI exit", status: "failed" as const, detail: "exit 1" }],
      },
      now: "2026-06-14T00:00:04.000Z",
    };

    store.recordRunResult(input);
    const eventsAfterFirst = store.listEvents("session-1");
    const segmentAfterFirst = store.listSegments("session-1", "node-1").find((item) => item.runId === runId);
    store.recordRunResult({ ...input, outputSummary: "Duplicate output is ignored.", now: "2026-06-14T00:00:03.000Z" });
    expect(store.listEvents("session-1")).toEqual(eventsAfterFirst);
    expect(store.listSegments("session-1", "node-1").find((item) => item.runId === runId)).toEqual(segmentAfterFirst);
    expect(() => store.recordRunResult(conflictingInput)).toThrow(/planner terminal evidence conflict/i);
    expect(store.listEvents("session-1")).toEqual(eventsAfterFirst);
    expect(store.listSegments("session-1", "node-1").find((item) => item.runId === runId)).toEqual(segmentAfterFirst);
    expect(eventsAfterFirst.filter((event) =>
      event.idempotencyKey === `planner-segment:${segment.segmentId}:lane-terminal`
    )).toEqual([
      expect.objectContaining({
        idempotencyKey: `planner-segment:${segment.segmentId}:lane-terminal`,
        payload: expect.objectContaining({ status: "completed" }),
      }),
    ]);
    store.close();

    const reopened = createWorkflowStore({ projectRoot });
    const reopenedEvents = reopened.listEvents("session-1");
    const reopenedSegment = reopened.listSegments("session-1", "node-1").find((item) => item.runId === runId);
    reopened.recordRunResult({ ...input, now: "2026-06-14T00:00:05.000Z" });
    expect(reopened.listEvents("session-1")).toEqual(reopenedEvents);
    expect(reopened.listSegments("session-1", "node-1").find((item) => item.runId === runId)).toEqual(reopenedSegment);
    expect(() => reopened.recordRunResult({ ...conflictingInput, now: "2026-06-14T00:00:06.000Z" })).toThrow(
      /planner terminal evidence conflict/i,
    );
    expect(reopened.listEvents("session-1")).toEqual(reopenedEvents);
    expect(reopened.listSegments("session-1", "node-1").find((item) => item.runId === runId)).toEqual(reopenedSegment);
    reopened.close();
  });

  it.each(["lane-implementation", "lane-validation", "lane-review"] as const)(
    "records failed %s RunEvidence without automatically creating a repair chain",
    async (failedLaneId) => {
      const store = await makeSeededStore();
      declareCodeChangeWorkflow(store);
      advanceCodeChangeWorkflowToLane(store, failedLaneId);
      const failedInput = runResultInput(store, failedLaneId, "failed", "2026-06-14T00:00:10.000Z");

      store.recordRunResult(failedInput);
      store.recordRunResult(failedInput);

      const projection = store.materializeFlowProjection("session-1");
      const evidenceId = `evidence-segment-session-1-${failedLaneId}`;
      const replanEvents = store
        .listEvents("session-1")
        .filter((event) => event.kind === "workflow.replan.requested" && event.payload.laneId === failedLaneId);

      expect(projection.lanes.find((lane) => lane.id === failedLaneId)?.status).toBe("failed");
      expect(replanEvents).toEqual([]);
      expect(projection.lanes.find((lane) => lane.semanticKey === `repair:${failedLaneId}:${evidenceId}`)).toBeUndefined();
      expect(projection.lanes.find((lane) => lane.semanticKey === `regression:${failedLaneId}:${evidenceId}`)).toBeUndefined();

      const scheduled = store.scheduleReadyLanes("session-1", {
        allowedParallelism: 3,
        now: "2026-06-14T00:00:11.000Z",
      });

      expect(scheduled.readyLanes).toEqual([]);
    },
  );

  it("keeps failed expected-artifact evidence terminal when the process exits zero", async () => {
    const store = await makeSeededStore();
    declareCodeChangeWorkflow(store);
    store.scheduleReadyLanes("session-1", {
      allowedParallelism: 1,
      now: "2026-06-14T00:00:03.000Z",
    });
    const evidence = {
      runId: "run-session-1-lane-implementation",
      status: "failed",
      exitCode: 0,
      changesetId: null,
      checks: [
        { kind: "artifact", name: "Expected artifacts", status: "failed", detail: "missing=1" },
      ],
      artifacts: [],
      review: null,
      errorReason: null,
      cancelReason: null,
      completedAt: "2026-06-14T00:00:04.000Z",
    } satisfies RunEvidence;

    store.recordRunResult({
      sessionId: "session-1",
      laneId: "lane-implementation",
      segmentId: "segment-session-1-lane-implementation",
      runId: evidence.runId,
      agentKind: "codex",
      evidence,
      now: evidence.completedAt,
    });

    const events = store.listEvents("session-1");
    const projection = store.materializeFlowProjection("session-1");
    const canvas = store.materializeCanvasSession("session-1");
    expect(events.filter((event) => event.kind === "workflow.segment.output_delta")).toEqual([]);
    expect(events).toContainEqual(
      expect.objectContaining({
        kind: "workflow.segment.finished",
        payload: expect.objectContaining({ status: "failed", exitCode: 0 }),
      }),
    );
    expect(projection.lanes.find((lane) => lane.id === "lane-implementation")?.status).toBe("failed");
    expect(projection.evidence).toContainEqual(
      expect.objectContaining({
        laneId: "lane-implementation",
        segmentId: "segment-session-1-lane-implementation",
        status: "failed",
      }),
    );
    expect(events).toContainEqual(
      expect.objectContaining({
        kind: "workflow.evidence.recorded",
        payload: expect.objectContaining({
          evidence: expect.objectContaining({
            status: "failed",
            runEvidence: expect.objectContaining({ status: "failed", exitCode: 0 }),
          }),
        }),
      }),
    );
    expect(canvas?.nodes.find((node) => node.id === "lane-implementation")).toMatchObject({
      status: "failed",
      output: [],
    });

    const scheduled = store.scheduleReadyLanes("session-1", {
      allowedParallelism: 3,
      now: "2026-06-14T00:00:05.000Z",
    });
    expect(scheduled.readyLanes).toEqual([]);
  });

  it("normalizes stale succeeded RunEvidence with a failed expected-artifact gate", async () => {
    const store = await makeSeededStore();
    declareCodeChangeWorkflow(store);
    store.scheduleReadyLanes("session-1", {
      allowedParallelism: 1,
      now: "2026-06-14T00:00:03.000Z",
    });
    const evidence = {
      runId: "run-session-1-lane-implementation",
      status: "succeeded",
      exitCode: 0,
      changesetId: null,
      checks: [
        { kind: "artifact", name: "Expected artifacts", status: "failed", detail: "missing=1" },
      ],
      artifacts: [],
      review: null,
      errorReason: null,
      cancelReason: null,
      completedAt: "2026-06-14T00:00:04.000Z",
    } satisfies RunEvidence;

    store.recordRunResult({
      sessionId: "session-1",
      laneId: "lane-implementation",
      segmentId: "segment-session-1-lane-implementation",
      runId: evidence.runId,
      agentKind: "codex",
      evidence,
      now: evidence.completedAt,
    });

    const events = store.listEvents("session-1");
    const projection = store.materializeFlowProjection("session-1");
    expect(projection.lanes.find((lane) => lane.id === "lane-implementation")?.status).toBe("failed");
    expect(events).toContainEqual(
      expect.objectContaining({
        kind: "workflow.evidence.recorded",
        payload: expect.objectContaining({
          evidence: expect.objectContaining({
            status: "failed",
            runEvidence: expect.objectContaining({ status: "failed", exitCode: 0 }),
          }),
        }),
      }),
    );
  });

  it("fails current empty null-exit success across recordRunResult and reopen", async () => {
    const store = await makeSeededStore();
    const projectRoot = dirname(dirname(store.databasePath));
    declareCodeChangeWorkflow(store);
    store.scheduleReadyLanes("session-1", {
      allowedParallelism: 1,
      now: "2026-06-14T00:00:03.000Z",
    });
    const evidence = {
      runId: "run-session-1-lane-implementation",
      status: "succeeded",
      exitCode: null,
      changesetId: null,
      checks: [],
      artifacts: [],
      review: null,
      errorReason: null,
      cancelReason: null,
      completedAt: "2026-06-14T00:00:04.000Z",
    } satisfies RunEvidence;

    store.recordRunResult({
      sessionId: "session-1",
      laneId: "lane-implementation",
      segmentId: "segment-session-1-lane-implementation",
      runId: evidence.runId,
      agentKind: "codex",
      evidence,
      now: evidence.completedAt,
    });

    expect(store.materializeFlowProjection("session-1").evidence.at(-1)?.status).toBe("failed");
    expect(store.materializeFlowProjection("session-1").segments.at(-1)?.status).toBe("failed");
    expect(store.materializeFlowProjection("session-1").lanes.find((lane) => lane.id === "lane-implementation")?.status).toBe("failed");
    expect(store.materializeCanvasSession("session-1")?.nodes.find((node) => node.id === "lane-implementation")?.status).toBe("failed");
    expect(store.scheduleReadyLanes("session-1", { allowedParallelism: 2, now: "2026-06-14T00:00:05.000Z" }).readyLanes).toEqual([]);
    store.close();

    const reopened = createWorkflowStore({ projectRoot });
    expect(reopened.materializeFlowProjection("session-1").evidence.at(-1)?.status).toBe("failed");
    expect(reopened.materializeFlowProjection("session-1").segments.at(-1)?.status).toBe("failed");
    expect(reopened.materializeCanvasSession("session-1")?.nodes.find((node) => node.id === "lane-implementation")?.status).toBe("failed");
    expect(reopened.scheduleReadyLanes("session-1", { allowedParallelism: 2, now: "2026-06-14T00:00:06.000Z" }).readyLanes).toEqual([]);
    reopened.close();
  });

  it("requires artifact-passed evidence for a persisted browser screenshot lane", async () => {
    const store = await makeSeededStore();
    const projectRoot = dirname(dirname(store.databasePath));
    store.appendWorkflowEvent({
      sessionId: "session-1",
      kind: "workflow.lane.declared",
      source: "test",
      idempotencyKey: "lane:browser",
      payload: {
        lane: {
          id: "lane-browser",
          semanticKey: "lane-browser",
          kind: "browser_validation",
          title: "Capture browser screenshot",
          agentKind: "codex",
          status: "pending",
          requiredEvidence: ["browser", "screenshot"],
        },
      },
      now: "2026-06-14T00:00:01.000Z",
    });
    store.appendWorkflowEvent({
      sessionId: "session-1",
      kind: "workflow.lane.declared",
      source: "test",
      idempotencyKey: "lane:browser-review",
      payload: {
        lane: { id: "lane-browser-review", semanticKey: "lane-browser-review", kind: "review", title: "Review screenshot", agentKind: "hermes", status: "pending" },
      },
      now: "2026-06-14T00:00:01.100Z",
    });
    store.appendWorkflowEvent({
      sessionId: "session-1",
      kind: "workflow.edge.declared",
      source: "test",
      idempotencyKey: "edge:browser-review",
      payload: { edge: { id: "edge-browser-review", sourceLaneId: "lane-browser", targetLaneId: "lane-browser-review" } },
      now: "2026-06-14T00:00:01.200Z",
    });
    store.scheduleReadyLanes("session-1", { allowedParallelism: 1, now: "2026-06-14T00:00:02.000Z" });
    const evidence = {
      runId: "run-session-1-lane-browser",
      status: "succeeded",
      exitCode: 0,
      changesetId: null,
      checks: [{ kind: "run-exit", name: "Codex CLI exit", status: "passed" }],
      artifacts: [],
      review: null,
      errorReason: null,
      cancelReason: null,
      completedAt: "2026-06-14T00:00:03.000Z",
    } satisfies RunEvidence;

    store.recordRunResult({
      sessionId: "session-1",
      laneId: "lane-browser",
      segmentId: "segment-session-1-lane-browser",
      runId: evidence.runId,
      agentKind: "codex",
      evidence,
      now: evidence.completedAt,
    });

    expect(store.materializeFlowProjection("session-1").lanes.find((lane) => lane.id === "lane-browser")?.status).toBe("failed");
    expect(store.materializeCanvasSession("session-1")?.nodes.find((node) => node.id === "lane-browser")?.status).toBe("failed");
    expect(store.scheduleReadyLanes("session-1", { allowedParallelism: 2, now: "2026-06-14T00:00:04.000Z" }).readyLanes).toEqual([]);
    store.close();

    const reopened = createWorkflowStore({ projectRoot });
    expect(reopened.materializeFlowProjection("session-1").lanes.find((lane) => lane.id === "lane-browser")?.status).toBe("failed");
    expect(reopened.materializeCanvasSession("session-1")?.nodes.find((node) => node.id === "lane-browser")?.status).toBe("failed");
    expect(reopened.scheduleReadyLanes("session-1", { allowedParallelism: 2, now: "2026-06-14T00:00:05.000Z" }).readyLanes).toEqual([]);
    reopened.close();
  });

  it("keeps external browser artifact contracts canonical through terminal reconciliation and reopen", async () => {
    const store = await makeSeededStore();
    const projectRoot = dirname(dirname(store.databasePath));
    store.applyWorkflowIntent({
      intentId: "intent-browser-contracts",
      sessionId: "session-1",
      operations: [{
        type: "ProposeLanes",
        lanes: [
          {
            id: "lane-browser-omitted",
            kind: "browser_validation",
            title: "Capture browser screenshot",
            agentKind: "codex",
          },
          {
            id: "lane-browser-empty",
            kind: "browser_validation",
            title: "Capture browser screenshot",
            agentKind: "codex",
            requiredEvidence: [],
          },
          {
            id: "lane-browser-prose-neighbor",
            kind: "implementation",
            title: "Avoid browser work in this implementation",
            agentKind: "codex",
          },
          {
            id: "lane-browser-review",
            kind: "review",
            title: "Review screenshot evidence",
            agentKind: "hermes",
            dependsOn: ["lane-browser-omitted"],
          },
        ],
      }],
    }, "2026-06-14T00:00:01.000Z");

    const declaredLanes = store.listEvents("session-1")
      .filter((item) => item.kind === "workflow.lane.declared")
      .map((item) => item.payload.lane as { id: string; requiredEvidence?: string[] });
    expect(declaredLanes.find((lane) => lane.id === "lane-browser-omitted")?.requiredEvidence).toEqual([
      "browser",
      "screenshot",
    ]);
    expect(declaredLanes.find((lane) => lane.id === "lane-browser-empty")?.requiredEvidence).toEqual([
      "browser",
      "screenshot",
    ]);
    expect(declaredLanes.find((lane) => lane.id === "lane-browser-prose-neighbor")?.requiredEvidence).toEqual([]);

    const scheduled = store.scheduleReadyLanes("session-1", {
      allowedParallelism: 3,
      now: "2026-06-14T00:00:02.000Z",
    });
    expect(scheduled.readyLanes.map((lane) => lane.id)).toEqual([
      "lane-browser-omitted",
      "lane-browser-empty",
      "lane-browser-prose-neighbor",
    ]);

    store.recordRunResult({
      sessionId: "session-1",
      laneId: "lane-browser-omitted",
      segmentId: "segment-session-1-lane-browser-omitted",
      runId: "run-session-1-lane-browser-omitted",
      agentKind: "codex",
      outputSummary: "Browser screenshot captured successfully.",
      evidence: terminalRunEvidence(
        "run-session-1-lane-browser-omitted",
        "succeeded",
        0,
        [{ kind: "run-exit", name: "Codex CLI exit", status: "passed" }],
        [],
      ),
      now: "2026-06-14T00:00:03.000Z",
    });
    store.recordRunResult({
      sessionId: "session-1",
      laneId: "lane-browser-empty",
      segmentId: "segment-session-1-lane-browser-empty",
      runId: "run-session-1-lane-browser-empty",
      agentKind: "codex",
      evidence: terminalRunEvidence(
        "run-session-1-lane-browser-empty",
        "succeeded",
        0,
        [
          { kind: "run-exit", name: "Codex CLI exit", status: "passed" },
          { kind: "artifact", name: "Expected artifacts", status: "passed" },
        ],
        [".devflow/acceptance/react-app.png"],
      ),
      now: "2026-06-14T00:00:03.100Z",
    });
    store.recordRunResult({
      sessionId: "session-1",
      laneId: "lane-browser-prose-neighbor",
      segmentId: "segment-session-1-lane-browser-prose-neighbor",
      runId: "run-session-1-lane-browser-prose-neighbor",
      agentKind: "codex",
      evidence: terminalRunEvidence(
        "run-session-1-lane-browser-prose-neighbor",
        "succeeded",
        0,
        [{ kind: "run-exit", name: "Codex CLI exit", status: "passed" }],
        [],
      ),
      now: "2026-06-14T00:00:03.200Z",
    });

    const assertCanonical = (current: ReturnType<typeof createWorkflowStore>) => {
      const projection = current.materializeFlowProjection("session-1");
      const canvas = current.materializeCanvasSession("session-1");
      expect(projection.lanes.find((lane) => lane.id === "lane-browser-omitted")).toMatchObject({
        status: "failed",
        requiredEvidence: ["browser", "screenshot"],
      });
      expect(projection.lanes.find((lane) => lane.id === "lane-browser-empty")).toMatchObject({
        status: "completed",
        requiredEvidence: ["browser", "screenshot"],
      });
      expect(projection.lanes.find((lane) => lane.id === "lane-browser-prose-neighbor")).toMatchObject({
        status: "completed",
        requiredEvidence: [],
      });
      expect(canvas?.nodes.find((node) => node.id === "lane-browser-omitted")?.requiredEvidence).toEqual([
        "browser",
        "screenshot",
      ]);
      expect(current.scheduleReadyLanes("session-1", {
        allowedParallelism: 4,
        now: "2026-06-14T00:00:04.000Z",
      }).readyLanes.map((lane) => lane.id)).not.toContain("lane-browser-review");
    };

    assertCanonical(store);
    store.close();
    const reopened = createWorkflowStore({ projectRoot });
    assertCanonical(reopened);
    reopened.close();
  });

  it("migrates historical browser lane events before projection, canvas materialization, and reopen", async () => {
    const store = await makeSeededStore();
    const projectRoot = dirname(dirname(store.databasePath));
    store.appendWorkflowEvent({
      sessionId: "session-1",
      kind: "workflow.lane.declared",
      source: "legacy-test",
      idempotencyKey: "lane:historical-browser",
      payload: {
        lane: {
          id: "lane-historical-browser",
          semanticKey: "lane-historical-browser",
          kind: "browser_validation",
          title: "Capture browser screenshot",
          agentKind: "codex",
          status: "pending",
        },
      },
      now: "2026-06-14T00:00:01.000Z",
    });
    store.close();

    const legacy = new Database(join(projectRoot, ".devflow", "skyturn-workflow.sqlite"));
    const row = legacy.prepare("SELECT payload_json FROM workflow_events WHERE idempotency_key = ?").get(
      "lane:historical-browser",
    ) as { payload_json: string };
    const payload = JSON.parse(row.payload_json) as { lane: Record<string, unknown> };
    delete payload.lane.requiredEvidence;
    legacy.prepare("UPDATE workflow_events SET payload_json = ? WHERE idempotency_key = ?").run(
      JSON.stringify(payload),
      "lane:historical-browser",
    );
    legacy.prepare("DELETE FROM schema_migrations WHERE version = 7").run();
    legacy.close();

    const reopened = createWorkflowStore({ projectRoot });
    const event = reopened.listEvents("session-1").find((item) => item.idempotencyKey === "lane:historical-browser");
    expect((event?.payload.lane as { requiredEvidence?: string[] }).requiredEvidence).toEqual([
      "browser",
      "screenshot",
    ]);
    expect(reopened.materializeFlowProjection("session-1").lanes.find((lane) => lane.id === "lane-historical-browser")?.requiredEvidence).toEqual([
      "browser",
      "screenshot",
    ]);
    expect(reopened.materializeCanvasSession("session-1")?.nodes.find((node) => node.id === "lane-historical-browser")?.requiredEvidence).toEqual([
      "browser",
      "screenshot",
    ]);
    reopened.close();
  });

  it("normalizes a pre-evidence browser lane row before canvas materialization and terminal reconciliation", async () => {
    const store = await makeSeededStore();
    const projectRoot = dirname(dirname(store.databasePath));
    store.close();

    const legacy = new Database(join(projectRoot, ".devflow", "skyturn-workflow.sqlite"));
    legacy.prepare([
      "INSERT INTO workflow_lanes(",
      "id, session_id, node_id, semantic_key, lane_kind, agent_kind, title, brief, status, phase, archived, created_at, updated_at",
      ") VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
    ].join(" ")).run(
      "lane-legacy-browser",
      "session-1",
      "lane-legacy-browser",
      "legacy:browser",
      "validation",
      "codex",
      "Capture browser screenshot",
      "Capture browser screenshot evidence",
      "pending",
      "Validation",
      0,
      "2026-06-14T00:00:01.000Z",
      "2026-06-14T00:00:01.000Z",
    );
    legacy.close();

    const reopened = createWorkflowStore({ projectRoot });
    expect(reopened.getLane("session-1", "lane-legacy-browser")?.requiredEvidence).toEqual([
      "browser",
      "screenshot",
    ]);
    expect(reopened.materializeCanvasSession("session-1")?.nodes.find((node) => node.id === "lane-legacy-browser")?.requiredEvidence).toEqual([
      "browser",
      "screenshot",
    ]);
    const segment = reopened.recordSegmentEvidence({
      sessionId: "session-1",
      laneId: "lane-legacy-browser",
      segmentId: "segment-legacy-browser",
      runId: "run-legacy-browser",
      agentKind: "codex",
      transport: "codex_cli",
      worktreePath: projectRoot,
      evidence: {
        exitCode: 0,
        changesetId: null,
        checks: [{ kind: "run-exit", name: "Codex CLI exit", status: "passed" }],
        artifacts: [],
        review: null,
        errorReason: null,
      },
      now: "2026-06-14T00:00:02.000Z",
    });
    expect(segment.status).toBe("failed");
    reopened.close();
  });

  it("requires strict nested artifact evidence across append and reopen", async () => {
    const store = await makeSeededStore();
    const projectRoot = dirname(dirname(store.databasePath));
    for (const suffix of ["invalid", "valid"]) {
      store.appendWorkflowEvent({
        sessionId: "session-1",
        kind: "workflow.lane.declared",
        source: "test",
        idempotencyKey: `lane:browser-${suffix}`,
        payload: {
          lane: {
            id: `lane-browser-${suffix}`,
            semanticKey: `lane-browser-${suffix}`,
            kind: "browser_validation",
            title: "Capture browser screenshot",
            agentKind: "codex",
            status: "pending",
            requiredEvidence: ["browser", "screenshot"],
          },
        },
        now: "2026-06-14T00:00:01.000Z",
      });
      store.appendWorkflowEvent({
        sessionId: "session-1",
        kind: "workflow.lane.declared",
        source: "test",
        idempotencyKey: `lane:review-${suffix}`,
        payload: {
          lane: {
            id: `lane-review-${suffix}`,
            semanticKey: `lane-review-${suffix}`,
            kind: "review",
            title: "Review screenshot",
            agentKind: "hermes",
            status: "pending",
          },
        },
        now: "2026-06-14T00:00:01.100Z",
      });
      store.appendWorkflowEvent({
        sessionId: "session-1",
        kind: "workflow.edge.declared",
        source: "test",
        idempotencyKey: `edge:browser-review-${suffix}`,
        payload: {
          edge: {
            id: `edge-browser-review-${suffix}`,
            sourceLaneId: `lane-browser-${suffix}`,
            targetLaneId: `lane-review-${suffix}`,
          },
        },
        now: "2026-06-14T00:00:01.200Z",
      });
      store.appendWorkflowEvent({
        sessionId: "session-1",
        kind: "workflow.segment.started",
        source: "test",
        laneId: `lane-browser-${suffix}`,
        segmentId: `segment-browser-${suffix}`,
        idempotencyKey: `segment:browser-${suffix}:started`,
        payload: {
          laneId: `lane-browser-${suffix}`,
          segment: {
            id: `segment-browser-${suffix}`,
            laneId: `lane-browser-${suffix}`,
            runId: `run-browser-${suffix}`,
            status: "running",
          },
        },
        now: "2026-06-14T00:00:02.000Z",
      });
    }
    store.appendWorkflowEvent({
      sessionId: "session-1",
      kind: "workflow.evidence.recorded",
      source: "test",
      laneId: "lane-browser-invalid",
      segmentId: "segment-browser-invalid",
      idempotencyKey: "evidence:browser-invalid",
      payload: {
        laneId: "lane-browser-invalid",
        segmentId: "segment-browser-invalid",
        evidence: {
          id: "evidence-browser-invalid",
          kind: "run-exit",
          status: "passed",
          checks: ["run-exit:passed"],
          artifacts: [],
        },
      },
      now: "2026-06-14T00:00:03.000Z",
    });
    store.appendWorkflowEvent({
      sessionId: "session-1",
      kind: "workflow.segment.finished",
      source: "test",
      laneId: "lane-browser-invalid",
      segmentId: "segment-browser-invalid",
      idempotencyKey: "segment:browser-invalid:finished",
      payload: { laneId: "lane-browser-invalid", segmentId: "segment-browser-invalid", status: "succeeded", exitCode: 0 },
      now: "2026-06-14T00:00:03.100Z",
    });
    store.appendWorkflowEvent({
      sessionId: "session-1",
      kind: "workflow.evidence.recorded",
      source: "test",
      laneId: "lane-browser-valid",
      segmentId: "segment-browser-valid",
      idempotencyKey: "evidence:browser-valid",
      payload: {
        laneId: "lane-browser-valid",
        segmentId: "segment-browser-valid",
        evidence: {
          id: "evidence-browser-valid",
          kind: "run-exit",
          status: "passed",
          checks: [],
          artifacts: [],
          runEvidence: terminalRunEvidence("run-browser-valid", "succeeded", 0, [
            { kind: "run-exit", name: "Codex CLI exit", status: "passed" },
            { kind: "artifact", name: "Expected artifacts", status: "passed" },
          ], [".devflow/acceptance/browser.png"]),
        },
      },
      now: "2026-06-14T00:00:04.000Z",
    });
    store.appendWorkflowEvent({
      sessionId: "session-1",
      kind: "workflow.segment.finished",
      source: "test",
      laneId: "lane-browser-valid",
      segmentId: "segment-browser-valid",
      idempotencyKey: "segment:browser-valid:finished",
      payload: { laneId: "lane-browser-valid", segmentId: "segment-browser-valid", status: "succeeded", exitCode: 0 },
      now: "2026-06-14T00:00:04.100Z",
    });

    assertStrictArtifactAppendProjection(store);
    store.close();

    const reopened = createWorkflowStore({ projectRoot });
    assertStrictArtifactAppendProjection(reopened);
    reopened.close();
  });

  it("physically migrates historical outer-only artifact payloads before list, projection, canvas, and reopen", async () => {
    const store = await makeSeededStore();
    const projectRoot = dirname(dirname(store.databasePath));
    const hostPath = "/Users/alice/.ssh/id_rsa";
    const rawCheck = `token=outer-secret path=${hostPath}`;
    const rawDetail = `Bearer outer-secret ${hostPath}`;
    store.appendWorkflowEvent({
      sessionId: "session-1",
      kind: "workflow.lane.declared",
      source: "test",
      idempotencyKey: "lane:artifact-outer-only",
      payload: {
        lane: {
          id: "lane-artifact-outer-only",
          semanticKey: "lane-artifact-outer-only",
          kind: "validation",
          title: "Validate release package",
          agentKind: "codex",
          status: "pending",
          requiredEvidence: ["artifact"],
        },
      },
      now: "2026-06-14T00:00:01.000Z",
    });
    store.appendWorkflowEvent({
      sessionId: "session-1",
      kind: "workflow.lane.declared",
      source: "test",
      idempotencyKey: "lane:artifact-outer-only-review",
      payload: {
        lane: {
          id: "lane-artifact-outer-only-review",
          semanticKey: "lane-artifact-outer-only-review",
          kind: "review",
          title: "Review validation",
          agentKind: "hermes",
          status: "pending",
        },
      },
      now: "2026-06-14T00:00:01.100Z",
    });
    store.appendWorkflowEvent({
      sessionId: "session-1",
      kind: "workflow.edge.declared",
      source: "test",
      idempotencyKey: "edge:artifact-outer-only-review",
      payload: {
        edge: {
          id: "edge-artifact-outer-only-review",
          sourceLaneId: "lane-artifact-outer-only",
          targetLaneId: "lane-artifact-outer-only-review",
        },
      },
      now: "2026-06-14T00:00:01.200Z",
    });
    store.appendWorkflowEvent({
      sessionId: "session-1",
      kind: "workflow.segment.started",
      source: "test",
      laneId: "lane-artifact-outer-only",
      segmentId: "segment-artifact-outer-only",
      idempotencyKey: "segment:artifact-outer-only:started",
      payload: {
        laneId: "lane-artifact-outer-only",
        segment: {
          id: "segment-artifact-outer-only",
          laneId: "lane-artifact-outer-only",
          runId: "run-artifact-outer-only",
          status: "running",
        },
      },
      now: "2026-06-14T00:00:02.000Z",
    });
    store.appendWorkflowEvent({
      sessionId: "session-1",
      kind: "workflow.evidence.recorded",
      source: "test",
      laneId: "lane-artifact-outer-only",
      segmentId: "segment-artifact-outer-only",
      idempotencyKey: "evidence:artifact-outer-only",
      payload: {
        laneId: "lane-artifact-outer-only",
        segmentId: "segment-artifact-outer-only",
        evidence: {
          id: "evidence-artifact-outer-only",
          kind: "run-exit",
          status: "passed",
          checks: [rawCheck],
          artifacts: [hostPath],
          detail: rawDetail,
        },
      },
      now: "2026-06-14T00:00:03.000Z",
    });
    store.appendWorkflowEvent({
      sessionId: "session-1",
      kind: "workflow.segment.finished",
      source: "test",
      laneId: "lane-artifact-outer-only",
      segmentId: "segment-artifact-outer-only",
      idempotencyKey: "segment:artifact-outer-only:finished",
      payload: {
        laneId: "lane-artifact-outer-only",
        segmentId: "segment-artifact-outer-only",
        status: "succeeded",
        exitCode: 0,
      },
      now: "2026-06-14T00:00:03.100Z",
    });

    store.close();

    const databasePath = join(projectRoot, ".devflow", "skyturn-workflow.sqlite");
    const legacy = new Database(databasePath);
    const eventIdentity = legacy.prepare([
      "SELECT id, session_id, seq, kind, source, lane_id, segment_id, causation_id, correlation_id,",
      "idempotency_key, created_at, legacy_evidence_compatibility",
      "FROM workflow_events WHERE session_id = ? AND idempotency_key = ?",
    ].join(" ")).get("session-1", "evidence:artifact-outer-only") as Record<string, unknown>;
    const legacyPayload = JSON.stringify({
      laneId: "lane-artifact-outer-only",
      segmentId: "segment-artifact-outer-only",
      evidence: {
        id: "evidence-artifact-outer-only",
        kind: "run-exit",
        status: "passed",
        checks: [rawCheck, "API_KEY=historical-api-key password=historical-password"],
        artifacts: [hostPath],
        detail: rawDetail,
        token: "historical-token",
        path: hostPath,
      },
    });
    legacy.prepare(
      "UPDATE workflow_events SET payload_json = ? WHERE session_id = ? AND idempotency_key = ?",
    ).run(legacyPayload, "session-1", "evidence:artifact-outer-only");
    legacy.prepare("DELETE FROM schema_migrations WHERE version = 4").run();
    expect(legacy.prepare(
      "SELECT payload_json FROM workflow_events WHERE session_id = ? AND idempotency_key = ?",
    ).get("session-1", "evidence:artifact-outer-only")).toEqual({ payload_json: legacyPayload });
    legacy.close();

    const reopened = createWorkflowStore({ projectRoot });
    const rawValues = [
      hostPath,
      rawCheck,
      rawDetail,
      "outer-secret",
      "historical-api-key",
      "historical-password",
      "historical-token",
    ];
    assertOuterOnlyArtifactPayloadRemoved(reopened, rawValues);
    expect(reopened.listAppliedMigrations()).toEqual([1, 2, 3, 4, 5, 6, 7]);
    reopened.close();

    const migrated = new Database(databasePath);
    const migratedRow = migrated.prepare([
      "SELECT id, session_id, seq, kind, source, lane_id, segment_id, causation_id, correlation_id,",
      "idempotency_key, payload_json, created_at, legacy_evidence_compatibility",
      "FROM workflow_events WHERE session_id = ? AND idempotency_key = ?",
    ].join(" ")).get("session-1", "evidence:artifact-outer-only") as Record<string, unknown> & {
      id: string;
      payload_json: string;
    };
    expect(Object.fromEntries(Object.entries(migratedRow).filter(([key]) => key !== "payload_json"))).toEqual(eventIdentity);
    expect(JSON.parse(migratedRow.payload_json)).toEqual({
      evidence: {
        artifacts: [],
        checks: [],
        id: "evidence-artifact-outer-only",
        kind: "run-exit",
        status: "failed",
      },
      laneId: "lane-artifact-outer-only",
      segmentId: "segment-artifact-outer-only",
    });
    for (const raw of rawValues) expect(migratedRow.payload_json).not.toContain(raw);
    const firstMigratedPayload = migratedRow.payload_json;
    migrated.exec(`
      CREATE TRIGGER reject_second_outer_evidence_migration
      BEFORE UPDATE OF payload_json ON workflow_events
      WHEN OLD.id = '${migratedRow.id}'
      BEGIN
        SELECT RAISE(ABORT, 'unexpected second migration write');
      END;
    `);
    migrated.close();

    const secondReopen = createWorkflowStore({ projectRoot });
    assertOuterOnlyArtifactPayloadRemoved(secondReopen, rawValues);
    secondReopen.close();
    const afterSecond = new Database(databasePath, { readonly: true });
    expect(afterSecond.prepare(
      "SELECT payload_json FROM workflow_events WHERE session_id = ? AND idempotency_key = ?",
    ).get("session-1", "evidence:artifact-outer-only")).toEqual({ payload_json: firstMigratedPayload });
    afterSecond.close();
  });

  it("persists only canonical nested evidence fields across reopen", async () => {
    const store = await makeSeededStore();
    const projectRoot = dirname(dirname(store.databasePath));
    declareCodeChangeWorkflow(store);
    store.scheduleReadyLanes("session-1", { allowedParallelism: 1, now: "2026-06-14T00:00:03.000Z" });
    const rawValues = [
      "/Users/alice/private/outer.png",
      "Bearer outer-secret path=/Users/alice/private/repo",
      "nested-secret",
      "C:\\Users\\alice\\private",
    ];
    store.appendWorkflowEvent({
      sessionId: "session-1",
      kind: "workflow.evidence.recorded",
      source: "test",
      laneId: "lane-implementation",
      segmentId: "segment-session-1-lane-implementation",
      idempotencyKey: "evidence:nested-canonical",
      payload: {
        laneId: "lane-implementation",
        segmentId: "segment-session-1-lane-implementation",
        evidence: {
          id: "evidence-nested-canonical",
          kind: "run-exit",
          status: "passed",
          checks: [rawValues[1]],
          artifacts: [".devflow/acceptance/present.png", rawValues[0]],
          detail: rawValues[1],
          runEvidence: {
            runId: "run-session-1-lane-implementation",
            status: "succeeded",
            exitCode: 0,
            changesetId: null,
            checks: [{ kind: "artifact", name: "Expected artifacts", status: "failed", detail: `token=${rawValues[2]} path=${rawValues[3]}` }],
            artifacts: [".devflow/acceptance/present.png"],
            review: null,
            errorReason: null,
            cancelReason: null,
            completedAt: "2026-06-14T00:00:04.000Z",
          },
        },
      },
      now: "2026-06-14T00:00:04.000Z",
    });
    store.appendWorkflowEvent({
      sessionId: "session-1",
      kind: "workflow.segment.finished",
      source: "test",
      laneId: "lane-implementation",
      segmentId: "segment-session-1-lane-implementation",
      idempotencyKey: "segment:nested-canonical:stale-finished",
      payload: { laneId: "lane-implementation", segmentId: "segment-session-1-lane-implementation", status: "succeeded", exitCode: 0 },
      now: "2026-06-14T00:00:05.000Z",
    });

    assertCanonicalNestedPersistence(store, rawValues);
    store.close();

    const reopened = createWorkflowStore({ projectRoot });
    assertCanonicalNestedPersistence(reopened, rawValues);
    reopened.close();
  });

  it.each([
    ["timed-out", "timed-out", "run-timeout", "failed", "evidence-first"],
    ["failed", "failed", "run-exit", "failed", "evidence-first"],
    ["cancelled", "cancelled", "run-exit", "skipped", "evidence-first"],
    ["timed-out", "timed-out", "run-timeout", "failed", "success-first"],
    ["failed", "failed", "run-exit", "failed", "success-first"],
    ["cancelled", "cancelled", "run-exit", "skipped", "success-first"],
  ] as const)(
    "keeps persisted nested %s as segment %s (%s/%s) when stale success is %s",
    async (runStatus, segmentStatus, checkKind, evidenceStatus, order) => {
    const store = await makeSeededStore();
    const projectRoot = dirname(dirname(store.databasePath));
    declareCodeChangeWorkflow(store);
    store.scheduleReadyLanes("session-1", { allowedParallelism: 1, now: "2026-06-14T00:00:03.000Z" });
    const terminalInput = {
      sessionId: "session-1",
      kind: "workflow.evidence.recorded",
      source: "test",
      laneId: "lane-implementation",
      segmentId: "segment-session-1-lane-implementation",
      idempotencyKey: `evidence:${runStatus}`,
      payload: {
        laneId: "lane-implementation",
        segmentId: "segment-session-1-lane-implementation",
        evidence: {
          id: `evidence-${runStatus}`,
          kind: "run-exit",
          status: "passed",
          checks: ["outer:passed"],
          artifacts: [],
          runEvidence: {
            runId: "run-session-1-lane-implementation",
            status: runStatus,
            exitCode: null,
            changesetId: null,
            checks: [{ kind: checkKind, name: "Terminal evidence", status: runStatus === "cancelled" ? "skipped" : "failed" }],
            artifacts: [],
            review: null,
            errorReason: runStatus === "failed" ? "Run failed." : null,
            cancelReason: runStatus === "cancelled" ? "Run cancelled." : null,
            completedAt: "2026-06-14T00:00:04.000Z",
          },
        },
      },
      now: "2026-06-14T00:00:04.000Z",
    } as const;
    const staleSuccessInput = {
      sessionId: "session-1",
      kind: "workflow.segment.finished",
      source: "test",
      laneId: "lane-implementation",
      segmentId: "segment-session-1-lane-implementation",
      idempotencyKey: `segment:${runStatus}:stale-finished`,
      payload: { laneId: "lane-implementation", segmentId: "segment-session-1-lane-implementation", status: "succeeded", exitCode: 0 },
      now: "2026-06-14T00:00:05.000Z",
    } as const;
    if (order === "evidence-first") {
      store.appendWorkflowEvent(terminalInput);
      store.appendWorkflowEvent(staleSuccessInput);
    } else {
      store.appendWorkflowEvent(staleSuccessInput);
      store.appendWorkflowEvent(terminalInput);
    }
    expect(() => store.appendWorkflowEvent({
      sessionId: "session-1",
      kind: "workflow.evidence.recorded",
      source: "test",
      laneId: "lane-implementation",
      segmentId: "segment-session-1-lane-implementation",
      idempotencyKey: `evidence:${runStatus}:conflicting-success`,
      payload: {
        laneId: "lane-implementation",
        segmentId: "segment-session-1-lane-implementation",
        evidence: {
          id: `evidence-${runStatus}-conflicting-success`,
          kind: "run-exit",
          status: "passed",
          checks: [],
          artifacts: [],
          runEvidence: terminalRunEvidence(
            "run-session-1-lane-implementation",
            "succeeded",
            0,
            [{ kind: "run-exit", name: "Late success", status: "passed" }],
            [],
          ),
        },
      },
      now: "2026-06-14T00:00:05.100Z",
    })).toThrow(/terminal evidence conflict/i);

    expect(store.materializeFlowProjection("session-1").segments.at(-1)?.status).toBe(segmentStatus);
    expect(store.materializeFlowProjection("session-1").evidence[0]?.status).toBe(evidenceStatus);
    expect(store.materializeFlowProjection("session-1").evidence[0]?.runEvidence).toMatchObject({
      status: runStatus,
      exitCode: null,
      cancelReason: runStatus === "cancelled" ? "Run cancelled." : null,
      completedAt: "2026-06-14T00:00:04.000Z",
    });
    expect(store.materializeFlowProjection("session-1").evidence.at(-1)?.status).toBe(evidenceStatus);
    expect(store.materializeFlowProjection("session-1").evidence.at(-1)?.runEvidence?.status).toBe(runStatus);
    expect(store.materializeFlowProjection("session-1").lanes.find((lane) => lane.id === "lane-implementation")?.status).toBe("failed");
    expect(store.materializeCanvasSession("session-1")?.nodes.find((node) => node.id === "lane-implementation")?.status).toBe("failed");
    expect(store.scheduleReadyLanes("session-1", { allowedParallelism: 2, now: "2026-06-14T00:00:06.000Z" }).readyLanes).toEqual([]);
    store.close();

    const reopened = createWorkflowStore({ projectRoot });
    expect(reopened.materializeFlowProjection("session-1").segments.at(-1)?.status).toBe(segmentStatus);
    expect(reopened.materializeFlowProjection("session-1").evidence[0]?.runEvidence?.status).toBe(runStatus);
    expect(reopened.materializeFlowProjection("session-1").evidence[0]?.runEvidence).toMatchObject({
      exitCode: null,
      cancelReason: runStatus === "cancelled" ? "Run cancelled." : null,
      completedAt: "2026-06-14T00:00:04.000Z",
    });
    expect(reopened.materializeFlowProjection("session-1").evidence.at(-1)?.status).toBe(evidenceStatus);
    expect(reopened.materializeFlowProjection("session-1").evidence.at(-1)?.runEvidence?.status).toBe(runStatus);
    expect(reopened.materializeFlowProjection("session-1").lanes.find((lane) => lane.id === "lane-implementation")?.status).toBe("failed");
    expect(reopened.materializeCanvasSession("session-1")?.nodes.find((node) => node.id === "lane-implementation")?.status).toBe("failed");
    expect(reopened.scheduleReadyLanes("session-1", { allowedParallelism: 2, now: "2026-06-14T00:00:07.000Z" }).readyLanes).toEqual([]);
    reopened.close();
    },
  );

  it("replays exact cancelled executable evidence without writes and rejects later success", async () => {
    const projectRoot = await makeTempRoot();
    let store = createWorkflowStore({ projectRoot });
    seedStore(store);
    declareCodeChangeWorkflow(store);
    advanceCodeChangeWorkflowToLane(store, "lane-implementation");
    const input = runResultInput(store, "lane-implementation", "cancelled", "2026-06-14T00:00:05.000Z");

    const assertReplay = () => {
      const events = store.listEvents(input.sessionId);
      const projection = store.materializeFlowProjection(input.sessionId);
      expect(store.recordRunResult({ ...input, now: "2026-06-14T00:00:06.000Z" })).toEqual(projection);
      expect(store.listEvents(input.sessionId)).toEqual(events);
      expect(() => store.recordRunResult({
        ...input,
        evidence: terminalRunEvidence(
          input.runId,
          "succeeded",
          0,
          [{ kind: "run-exit", name: "Late success", status: "passed" }],
          [],
        ),
        now: "2026-06-14T00:00:07.000Z",
      })).toThrow(/terminal evidence conflict/i);
      expect(store.listEvents(input.sessionId)).toEqual(events);
      expect(store.materializeFlowProjection(input.sessionId).segments.at(-1)?.status).toBe("cancelled");
      expect(store.materializeCanvasSession(input.sessionId)?.nodes.find((node) => node.id === input.laneId)?.status).toBe("failed");
    };

    store.recordRunResult(input);
    assertReplay();
    store.close();
    store = createWorkflowStore({ projectRoot });
    assertReplay();
    store.close();
  });

  it("fails legacy recordSegmentEvidence on artifact failure and clears partial artifacts across reopen", async () => {
    const store = await makeSeededStore();
    const projectRoot = dirname(dirname(store.databasePath));
    declareLegacyCodeLane(store);
    store.recordSegmentEvidence({
      sessionId: "session-1",
      laneId: "node-code",
      segmentId: "segment-code-artifact-failed",
      runId: "run-code-artifact-failed",
      agentKind: "codex",
      transport: "codex_cli",
      worktreePath: "/tmp/worktree",
      evidence: {
        exitCode: 0,
        changesetId: null,
        checks: [
          { kind: "run-exit", name: "Codex CLI exit", status: "passed" },
          { kind: "artifact", name: "Expected artifacts", status: "failed", detail: "missing=1" },
        ],
        artifacts: [".devflow/acceptance/present.png"],
        review: null,
        errorReason: null,
      },
      now: "2026-06-14T00:00:02.000Z",
    });

    assertLegacyArtifactFailure(store);
    store.close();

    const reopened = createWorkflowStore({ projectRoot });
    assertLegacyArtifactFailure(reopened);
    reopened.close();
  });

  it("returns the original segment on an identical zero-write evidence replay across reopen", async () => {
    const store = await makeSeededStore();
    const projectRoot = dirname(dirname(store.databasePath));
    declareLegacyCodeLane(store);
    const input = artifactFailureSegmentInput();
    const original = store.recordSegmentEvidence(input);
    const afterFirstWrite = workflowStoreSnapshot(store);

    const replay = store.recordSegmentEvidence(input);
    expect(workflowStoreSnapshot(store)).toEqual(afterFirstWrite);
    expect(replay).toEqual(original);
    expect(replay).toMatchObject({
      id: input.segmentId,
      runId: input.runId,
      laneId: input.laneId,
      status: "failed",
      exitCode: 0,
      endedAt: input.now,
    });
    store.close();

    const reopened = createWorkflowStore({ projectRoot });
    const reopenedReplay = reopened.recordSegmentEvidence(input);
    expect(workflowStoreSnapshot(reopened)).toEqual(afterFirstWrite);
    expect(reopenedReplay).toEqual(original);
    reopened.close();
  });

  it("rejects every recordSegmentEvidence identity or terminal conflict with zero writes across reopen", async () => {
    const store = await makeSeededStore();
    const projectRoot = dirname(dirname(store.databasePath));
    declareLegacyCodeLane(store);
    const input = artifactFailureSegmentInput();
    store.recordSegmentEvidence(input);
    const terminalSnapshot = workflowStoreSnapshot(store);

    assertSegmentEvidenceConflictsAreAtomic(store, input, terminalSnapshot);
    store.close();

    const reopened = createWorkflowStore({ projectRoot });
    assertSegmentEvidenceConflictsAreAtomic(reopened, input, terminalSnapshot);
    reopened.close();
  });

  it.each([
    ["malformed check", { checks: [{ kind: "unknown-kind", name: "Unsafe", status: "passed" }] }],
    ["unsafe artifact", { artifacts: ["/Users/alice/private/result.png"] }],
  ])("rejects %s in recordSegmentEvidence with zero writes across reopen", async (_label, invalidEvidence) => {
    const store = await makeSeededStore();
    const projectRoot = dirname(dirname(store.databasePath));
    declareLegacyCodeLane(store);
    const before = {
      events: store.listEvents("session-1"),
      lanes: store.listLanes("session-1"),
      segments: store.listSegments("session-1", "node-code"),
    };

    expect(() => store.recordSegmentEvidence({
      sessionId: "session-1",
      laneId: "node-code",
      segmentId: "segment-code-malformed",
      runId: "run-code-malformed",
      agentKind: "codex",
      transport: "codex_cli",
      worktreePath: "/tmp/worktree",
      evidence: {
        exitCode: 0,
        changesetId: "changeset-code-malformed",
        checks: [{ kind: "test", name: "pnpm test", status: "passed" }],
        artifacts: [],
        review: null,
        errorReason: null,
        ...invalidEvidence,
      } as never,
      now: "2026-06-14T00:00:02.000Z",
    })).toThrow(/invalid RunEvidence/i);
    expect({
      events: store.listEvents("session-1"),
      lanes: store.listLanes("session-1"),
      segments: store.listSegments("session-1", "node-code"),
    }).toEqual(before);
    store.close();

    const reopened = createWorkflowStore({ projectRoot });
    expect({
      events: reopened.listEvents("session-1"),
      lanes: reopened.listLanes("session-1"),
      segments: reopened.listSegments("session-1", "node-code"),
    }).toEqual(before);
    reopened.close();
  });

  it("hydrates concrete artifact-free segment evidence only from an old SQLite schema row", async () => {
    const store = await makeSeededStore();
    const projectRoot = dirname(dirname(store.databasePath));
    declareLegacyCodeLane(store);
    store.recordSegmentEvidence({
      sessionId: "session-1",
      laneId: "node-code",
      segmentId: "segment-code-legacy-disk",
      runId: "run-code-legacy-disk",
      agentKind: "codex",
      transport: "codex_cli",
      worktreePath: "/tmp/worktree",
      evidence: {
        exitCode: 0,
        changesetId: "changeset-code-legacy-disk",
        checks: [{ kind: "test", name: "pnpm test", status: "passed" }],
        artifacts: [],
        review: null,
        errorReason: null,
      },
      now: "2026-06-14T00:00:02.000Z",
    });
    store.close();

    const db = new Database(join(projectRoot, ".devflow", "skyturn-workflow.sqlite"));
    simulateLegacyEvidenceSchema(db);
    db.prepare("UPDATE workflow_segments SET evidence_json = ?, exit_code = NULL, status = 'succeeded' WHERE id = ?").run(
      JSON.stringify({
        exitCode: null,
        changesetId: "changeset-code-legacy-disk",
        checks: [{ kind: "test", name: "pnpm test", status: "passed" }],
        artifacts: [],
        review: null,
        errorReason: null,
      }),
      "segment-code-legacy-disk",
    );
    db.close();

    const reopened = createWorkflowStore({ projectRoot });
    const segment = reopened.listSegments("session-1", "node-code").find((item) => item.id === "segment-code-legacy-disk");
    expect(segment).toMatchObject({
      status: "succeeded",
      evidence: {
        runId: "run-code-legacy-disk",
        status: "succeeded",
        exitCode: null,
        changesetId: "changeset-code-legacy-disk",
        checks: [{ kind: "test", name: "pnpm test", status: "passed" }],
        artifacts: [],
      },
    });
    expect(reopened.applyWorkflowCardToolCall(
      "session-1",
      createCard("tool-review-legacy-disk", {
        id: "node-review-legacy-disk",
        taskKey: "review-legacy-disk",
        title: "Review legacy code",
        agent: "hermes",
        brief: "Review the implementation.",
        dependencies: ["node-code"],
      }),
      workflowContext("run-planner"),
    )).toMatchObject({ status: "applied" });
    reopened.close();
  });

  it("rejects a current-schema segment row forged into legacy null-exit shape", async () => {
    const store = await makeSeededStore();
    const projectRoot = dirname(dirname(store.databasePath));
    declareLegacyCodeLane(store);
    store.recordSegmentEvidence({
      ...artifactFailureSegmentInput(),
      segmentId: "segment-code-current-forgery",
      runId: "run-code-current-forgery",
      evidence: {
        exitCode: 0,
        changesetId: "changeset-code-current-forgery",
        checks: [{ kind: "test", name: "pnpm test", status: "passed" }],
        artifacts: [],
        review: null,
        errorReason: null,
      },
    });
    store.close();

    const db = new Database(join(projectRoot, ".devflow", "skyturn-workflow.sqlite"));
    db.prepare("UPDATE workflow_segments SET evidence_json = ?, exit_code = NULL, status = 'succeeded' WHERE id = ?").run(
      JSON.stringify({
        exitCode: null,
        changesetId: "changeset-code-current-forgery",
        checks: [{ kind: "test", name: "pnpm test", status: "passed" }],
        artifacts: [],
        review: null,
        errorReason: null,
      }),
      "segment-code-current-forgery",
    );
    db.close();

    const reopened = createWorkflowStore({ projectRoot });
    expect(reopened.listSegments("session-1", "node-code").find((item) => item.id === "segment-code-current-forgery")).toMatchObject({
      status: "failed",
      evidence: null,
    });
    reopened.close();
  });

  it("grants null-exit FlowEvent compatibility only to rows migrated from an old SQLite schema", async () => {
    const currentRoot = await makeNullExitFlowEventFixture(false);
    const current = createWorkflowStore({ projectRoot: currentRoot });
    expect(current.materializeFlowProjection("session-1").evidence.at(-1)?.status).toBe("failed");
    expect(current.materializeFlowProjection("session-1").lanes.find((lane) => lane.id === "lane-implementation")?.status).toBe("failed");
    current.close();

    const legacyRoot = await makeNullExitFlowEventFixture(true);
    const legacy = createWorkflowStore({ projectRoot: legacyRoot });
    expect(legacy.materializeFlowProjection("session-1").evidence.at(-1)?.status).toBe("passed");
    expect(legacy.materializeFlowProjection("session-1").lanes.find((lane) => lane.id === "lane-implementation")?.status).toBe("completed");
    expect(legacy.scheduleReadyLanes("session-1", { allowedParallelism: 2, now: "2026-06-14T00:00:06.000Z" }).readyLanes.map((lane) => lane.id)).toContain("lane-validation");
    legacy.close();
  });

  it("rejects malformed RunEvidence without writes and preserves the running lane after restart", async () => {
    const store = await makeSeededStore();
    declareCodeChangeWorkflow(store);
    store.scheduleReadyLanes("session-1", {
      allowedParallelism: 1,
      now: "2026-06-14T00:00:03.000Z",
    });
    const before = store.listEvents("session-1");
    const evidence = {
      runId: "run-session-1-lane-implementation",
      status: "succeeded",
      exitCode: 0,
      changesetId: null,
      checks: [{ kind: "unknown-kind", name: "Unsafe", status: "passed" }],
      artifacts: [],
      review: null,
      errorReason: null,
      cancelReason: null,
      completedAt: "2026-06-14T00:00:04.000Z",
    } as unknown as RunEvidence;

    expect(() => store.recordRunResult({
      sessionId: "session-1",
      laneId: "lane-implementation",
      segmentId: "segment-session-1-lane-implementation",
      runId: evidence.runId,
      agentKind: "codex",
      evidence,
      now: evidence.completedAt!,
    })).toThrow(/invalid RunEvidence/i);
    expect(store.listEvents("session-1")).toEqual(before);
    expect(store.materializeFlowProjection("session-1").lanes.find((lane) => lane.id === "lane-implementation")?.status).toBe("running");

    const projectRoot = dirname(dirname(store.databasePath));
    store.close();
    const reopened = createWorkflowStore({ projectRoot });
    expect(reopened.listEvents("session-1")).toEqual(before);
    expect(reopened.materializeFlowProjection("session-1").lanes.find((lane) => lane.id === "lane-implementation")?.status).toBe("running");
    reopened.close();
  });

  it("does not auto-trigger repair for cancelled runs or failed repair lanes", async () => {
    const cancelledStore = await makeSeededStore();
    declareCodeChangeWorkflow(cancelledStore);
    advanceCodeChangeWorkflowToLane(cancelledStore, "lane-implementation");

    cancelledStore.recordRunResult(
      runResultInput(cancelledStore, "lane-implementation", "cancelled", "2026-06-14T00:00:10.000Z"),
    );

    expect(cancelledStore.listEvents("session-1").filter((event) => event.kind === "workflow.replan.requested")).toEqual([]);
    expect(cancelledStore.materializeFlowProjection("session-1").lanes.some((lane) => lane.semanticKey.startsWith("repair:"))).toBe(false);

    const repairStore = await makeSeededStore();
    declareCodeChangeWorkflow(repairStore);
    advanceCodeChangeWorkflowToLane(repairStore, "lane-implementation");
    recordCheckpoint(repairStore, "checkpoint-after-implementation", "lane-implementation", "after", "head-sha");
    repairStore.recordRunResult(
      runResultInput(repairStore, "lane-implementation", "failed", "2026-06-14T00:00:10.000Z"),
    );
    repairStore.requestNodeRepair({
      sessionId: "session-1",
      laneId: "lane-implementation",
      checkpointId: "checkpoint-after-implementation",
      intentId: "manual-repair-intent-1",
      successorLaneId: "lane-implementation-manual-repair",
      successorSemanticKey: "manual:repair:lane-implementation",
      now: "2026-06-14T00:00:11.000Z",
    });
    const firstRepair = repairStore.materializeFlowProjection("session-1").lanes.find((lane) => lane.id === "lane-implementation-manual-repair");
    expect(firstRepair).toBeDefined();
    repairStore.scheduleReadyLanes("session-1", {
      allowedParallelism: 1,
      now: "2026-06-14T00:00:12.000Z",
    });

    repairStore.recordRunResult(
      runResultInput(repairStore, firstRepair!.id, "failed", "2026-06-14T00:00:13.000Z"),
    );

    const afterRepairFailure = repairStore.materializeFlowProjection("session-1");
    expect(repairStore.listEvents("session-1").filter((event) => event.kind === "workflow.replan.requested")).toEqual([]);
    expect(afterRepairFailure.lanes.filter((lane) => lane.semanticKey.startsWith(`repair:${firstRepair!.id}:`))).toEqual([]);
  });

  it("redacts run output and evidence before persisting event-stream projection data", async () => {
    const store = await makeSeededStore();
    declareCodeChangeWorkflow(store);
    advanceCodeChangeWorkflowToLane(store, "lane-implementation");
    const evidence = {
      runId: "run-session-1-lane-implementation",
      status: "failed",
      exitCode: 1,
      changesetId: "changeset-implementation-1",
      checks: [
        {
          kind: "test",
          name: "pnpm test OPENAI_API_KEY=sk-check-secret",
          status: "failed",
          detail: "DATABASE_URL=postgres://db-secret",
        },
      ],
      artifacts: [".devflow/acceptance/result.png"],
      review: {
        kind: "review",
        name: "review",
        status: "failed",
        detail: "Authorization: Bearer live-token",
      },
      errorReason: "stderr OPENAI_API_KEY=sk-error-secret from .env",
      cancelReason: null,
      completedAt: "2026-06-14T00:00:05.000Z",
    } satisfies RunEvidence;

    store.recordRunResult({
      sessionId: "session-1",
      laneId: "lane-implementation",
      segmentId: "segment-session-1-lane-implementation",
      runId: evidence.runId,
      agentKind: "codex",
      outputSummary: [
        "stderr BEGIN",
        "OPENAI_API_KEY=sk-output-secret",
        "diff --git a/src/a.ts b/src/a.ts",
        "+const token = 'sk-diff-secret';",
      ].join("\n"),
      evidence,
      now: "2026-06-14T00:00:05.000Z",
    });

    const serializedEvents = JSON.stringify(store.listEvents("session-1"));
    const serializedCanvas = JSON.stringify(store.materializeCanvasSession("session-1"));

    expect(serializedEvents).toContain("[redacted]");
    expect(serializedEvents).toContain("Patch content omitted");
    expect(serializedEvents).toContain("runEvidence");
    for (const serialized of [serializedEvents, serializedCanvas]) {
      expect(serialized).not.toContain("sk-output-secret");
      expect(serialized).not.toContain("sk-diff-secret");
      expect(serialized).not.toContain("sk-error-secret");
      expect(serialized).not.toContain("sk-check-secret");
      expect(serialized).not.toContain("db-secret");
      expect(serialized).not.toContain("live-token");
      expect(serialized).not.toContain(".env");
      expect(serialized).not.toContain("diff --git");
      expect(serialized).not.toContain("stderr BEGIN");
    }

    const projectRoot = dirname(dirname(store.databasePath));
    store.close();
    const reopened = createWorkflowStore({ projectRoot });
    const reopenedData = JSON.stringify(reopened.listEvents("session-1"));
    expect(reopenedData).not.toMatch(/sk-(?:output|diff|error|check)|db-secret|live-token|\.env/);
    reopened.close();
  });

  it("persists rejected WorkflowIntent events when gate validation fails", async () => {
    const store = await makeSeededStore();
    const rejected = store.applyWorkflowIntent({
      intentId: "intent-bad-review",
      sessionId: "session-1",
      operations: [{ type: "RequestReview", laneId: "lane-review" }],
    }, "2026-06-14T00:00:03.000Z");

    const projection = store.materializeFlowProjection("session-1");

    expect(rejected).toMatchObject({ ok: false, reason: expect.stringMatching(/implementation evidence/i) });
    expect(store.listEvents("session-1").at(-1)).toMatchObject({
      kind: "workflow.intent.rejected",
      payload: { intentId: "intent-bad-review", reason: expect.stringMatching(/implementation evidence/i) },
    });
    expect(projection.rejectedIntents).toEqual([
      { intentId: "intent-bad-review", reason: expect.stringMatching(/implementation evidence/i) },
    ]);
  });

  it("persists rejected WorkflowIntent events when schema validation fails", async () => {
    const store = await makeSeededStore();
    const rejected = store.applyWorkflowIntent({
      intentId: "intent-missing-requirement",
      sessionId: "session-1",
      operations: [{ type: "AnalyzeRequirement" }, { type: "DiscoverProject" }, { type: "ProposeLanes" }],
    }, "2026-06-14T00:00:03.000Z");

    expect(rejected).toMatchObject({ ok: false, reason: expect.stringMatching(/AnalyzeRequirement.*requirement/i) });
    expect(store.listEvents("session-1").at(-1)).toMatchObject({
      kind: "workflow.intent.rejected",
      payload: { intentId: "intent-missing-requirement", reason: expect.stringMatching(/AnalyzeRequirement.*requirement/i) },
    });
  });
});

function createCard(
  toolCallId: string,
  input: WorkflowCardCreateInput,
): WorkflowCardToolCall {
  return { tool: "createWorkflowCard", toolCallId, input };
}

async function makeTempRoot(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "skyturn-workflow-store-"));
  roots.push(root);
  return root;
}

const hermesHandlePhysicalCleanupSqlTrace = [
  "UPDATE hermes_sessions SET opaque_handle = '[redacted]' WHERE opaque_handle IS NOT NULL AND opaque_handle != '[redacted]'",
  "PRAGMA wal_checkpoint(TRUNCATE)",
  "VACUUM",
  "PRAGMA wal_checkpoint(TRUNCATE)",
  "PRAGMA journal_mode = DELETE",
  "INSERT INTO workflow_maintenance(name, state, completed_at) VALUES (?, 'complete', datetime('now'))",
  "PRAGMA journal_mode = WAL",
];

function maintenanceFaultInjection(input: {
  trace: string[];
  fault?: "initial-checkpoint" | "vacuum" | "marker-write" | "final-checkpoint";
}) {
  return {
    traceHermesHandleMaintenanceSql(sql: string) {
      input.trace.push(sql);
    },
    beforeHermesHandleMaintenanceStep(
      step: "initial-checkpoint" | "vacuum" | "marker-write" | "final-checkpoint",
    ) {
      if (step !== input.fault) return;
      if (step === "vacuum") {
        const error = new Error("injected SQLITE_FULL during VACUUM");
        Object.assign(error, { code: "SQLITE_FULL" });
        throw error;
      }
      if (step === "marker-write") throw new Error("injected completion marker write failure");
    },
    overrideHermesHandleCheckpointResult(phase: "initial" | "final") {
      if (
        (phase === "initial" && input.fault === "initial-checkpoint") ||
        (phase === "final" && input.fault === "final-checkpoint")
      ) {
        return [{ busy: 1, log: 1, checkpointed: 0 }];
      }
      return undefined;
    },
  };
}

function seedHermesHandleCleanupCase(
  projectRoot: string,
  rawHandle: string,
  state: { v5: "absent" | "present"; physicalState: "absent" | "complete" },
): void {
  const store = createWorkflowStore({ projectRoot });
  store.createWorkflowSession({
    id: "session-maintenance",
    projectId: "project-maintenance",
    title: "Maintenance",
    goal: "Clean legacy handle",
    mode: "fast",
    plannerProfile: "default",
    transport: "hermes_session_resume",
    opaqueHandle: "current-write-redacted",
    now: "2026-07-15T00:00:00.000Z",
  });
  store.close();

  const databasePath = join(projectRoot, ".devflow", "skyturn-workflow.sqlite");
  const db = new Database(databasePath);
  db.pragma("journal_mode = WAL");
  db.exec(`
    CREATE TABLE IF NOT EXISTS workflow_maintenance (
      name TEXT PRIMARY KEY,
      state TEXT NOT NULL,
      completed_at TEXT NOT NULL
    )
  `);
  db.prepare("UPDATE hermes_sessions SET opaque_handle = ? WHERE workflow_session_id = ?")
    .run(rawHandle, "session-maintenance");
  if (state.v5 === "absent") db.prepare("DELETE FROM schema_migrations WHERE version = 5").run();
  db.prepare("DELETE FROM workflow_maintenance WHERE name = ?").run(hermesHandlePhysicalCleanup);
  if (state.physicalState === "complete") {
    db.prepare([
      "INSERT INTO workflow_maintenance(name, state, completed_at)",
      "VALUES (?, 'complete', datetime('now'))",
    ].join(" ")).run(hermesHandlePhysicalCleanup);
  }
  db.pragma("wal_checkpoint(TRUNCATE)");
  db.close();
}

function readHermesHandlePhysicalCleanupState(projectRoot: string): string | null {
  const databasePath = join(projectRoot, ".devflow", "skyturn-workflow.sqlite");
  const db = new Database(databasePath, { readonly: true });
  try {
    const row = db.prepare("SELECT state FROM workflow_maintenance WHERE name = ?")
      .get(hermesHandlePhysicalCleanup) as { state: string } | undefined;
    return row?.state ?? null;
  } catch {
    return null;
  } finally {
    db.close();
  }
}

function seedLegacyHermesHandle(
  projectRoot: string,
  sessionId: string,
  rawHandle: string,
  olderMigrationMarkers = false,
): void {
  const databasePath = join(projectRoot, ".devflow", "skyturn-workflow.sqlite");
  const db = new Database(databasePath);
  db.pragma("journal_mode = WAL");
  db.prepare("UPDATE hermes_sessions SET opaque_handle = ? WHERE workflow_session_id = ?").run(rawHandle, sessionId);
  db.prepare(olderMigrationMarkers
    ? "DELETE FROM schema_migrations WHERE version > 1"
    : "DELETE FROM schema_migrations WHERE version = 5").run();
  db.pragma("wal_checkpoint(TRUNCATE)");
  db.close();
}

async function expectRawHandleAbsent(projectRoot: string, rawHandle: string): Promise<void> {
  const databasePath = join(projectRoot, ".devflow", "skyturn-workflow.sqlite");
  for (const path of [databasePath, `${databasePath}-wal`, `${databasePath}-shm`]) {
    const bytes = await readFile(path).catch(() => Buffer.alloc(0));
    expect(bytes.includes(Buffer.from(rawHandle, "utf8")), path).toBe(false);
  }
}

async function makeStore() {
  return createWorkflowStore({ projectRoot: await makeTempRoot() });
}

async function makeSeededStore() {
  const store = await makeStore();
  seedStore(store);
  return store;
}

type TestWorkflowStore = ReturnType<typeof createWorkflowStore>;
type TestSegmentEvidenceInput = Parameters<TestWorkflowStore["recordSegmentEvidence"]>[0];

function terminalRunEvidence(
  runId: string,
  status: RunEvidence["status"],
  exitCode: number | null,
  checks: RunEvidence["checks"],
  artifacts: string[],
): RunEvidence {
  return {
    runId,
    status,
    exitCode,
    changesetId: null,
    checks,
    artifacts,
    review: null,
    errorReason: status === "failed" ? "Run failed." : null,
    cancelReason: status === "cancelled" ? "Run cancelled." : null,
    completedAt: "2026-06-14T00:00:04.000Z",
  };
}

function artifactFailureSegmentInput(): TestSegmentEvidenceInput {
  return {
    sessionId: "session-1",
    laneId: "node-code",
    segmentId: "segment-code-terminal",
    runId: "run-code-terminal",
    agentKind: "codex",
    transport: "codex_cli",
    worktreePath: "/tmp/worktree",
    evidence: {
      exitCode: 0,
      changesetId: "changeset-code-terminal",
      checks: [
        { kind: "run-exit", name: "Codex CLI exit", status: "passed" },
        { kind: "artifact", name: "Expected artifacts", status: "failed", detail: "missing=1" },
      ],
      artifacts: [".devflow/acceptance/present.png"],
      review: null,
      errorReason: null,
    },
    now: "2026-06-14T00:00:02.000Z",
  };
}

function workflowStoreSnapshot(store: TestWorkflowStore) {
  return {
    events: store.listEvents("session-1"),
    lanes: store.listLanes("session-1"),
    codeSegments: store.listSegments("session-1", "node-code"),
    planningSegments: store.listSegments("session-1", "node-plan"),
  };
}

function assertSegmentEvidenceConflictsAreAtomic(
  store: TestWorkflowStore,
  input: TestSegmentEvidenceInput,
  snapshot: ReturnType<typeof workflowStoreSnapshot>,
): void {
  const conflicts: TestSegmentEvidenceInput[] = [
    { ...input, runId: "run-code-conflict", now: "2026-06-14T00:00:03.000Z" },
    { ...input, agentKind: "hermes", now: "2026-06-14T00:00:03.100Z" },
    { ...input, laneId: "node-plan", now: "2026-06-14T00:00:03.200Z" },
    {
      ...input,
      evidence: { ...input.evidence, changesetId: "changeset-evidence-conflict" },
      now: "2026-06-14T00:00:03.300Z",
    },
    {
      ...input,
      evidence: {
        exitCode: 0,
        changesetId: "changeset-code-terminal",
        checks: [{ kind: "run-exit", name: "Codex CLI exit", status: "passed" }],
        artifacts: [],
        review: null,
        errorReason: null,
      },
      now: "2026-06-14T00:00:03.400Z",
    },
    {
      ...input,
      evidence: {
        exitCode: 1,
        changesetId: "changeset-code-terminal",
        checks: [{ kind: "run-exit", name: "Codex CLI exit", status: "failed" }],
        artifacts: [],
        review: null,
        errorReason: "exit 1",
      },
      now: "2026-06-14T00:00:03.500Z",
    },
  ];

  for (const conflict of conflicts) {
    expect(() => store.recordSegmentEvidence(conflict)).toThrow(/identity|terminal/i);
    expect(workflowStoreSnapshot(store)).toEqual(snapshot);
  }
}

function assertStrictArtifactAppendProjection(store: TestWorkflowStore): void {
  const projection = store.materializeFlowProjection("session-1");
  expect(projection.evidence.find((item) => item.id === "evidence-browser-invalid")?.status).toBe("failed");
  expect(projection.evidence.find((item) => item.id === "evidence-browser-valid")?.status).toBe("passed");
  expect(projection.segments.find((item) => item.id === "segment-browser-invalid")?.status).toBe("failed");
  expect(projection.segments.find((item) => item.id === "segment-browser-valid")?.status).toBe("succeeded");
  expect(projection.lanes.find((item) => item.id === "lane-browser-invalid")?.status).toBe("failed");
  expect(projection.lanes.find((item) => item.id === "lane-browser-valid")?.status).toBe("completed");
  expect(store.materializeCanvasSession("session-1")?.nodes.find((node) => node.id === "lane-browser-invalid")?.status).toBe("failed");
  const ready = scheduleReadyLanes(projection, { allowedParallelism: 4 }).map((lane) => lane.id);
  expect(ready).not.toContain("lane-review-invalid");
  expect(ready).toContain("lane-review-valid");
}

function assertOuterOnlyArtifactPayloadRemoved(store: TestWorkflowStore, rawValues: string[]): void {
  const projection = store.materializeFlowProjection("session-1");
  const evidence = projection.evidence.find((item) => item.id === "evidence-artifact-outer-only");
  const canvasSession = store.materializeCanvasSession("session-1");
  expect(evidence).toMatchObject({ status: "failed", checks: [], artifacts: [] });
  expect(evidence?.detail).toBeUndefined();
  expect(evidence?.runEvidence).toBeUndefined();
  expect(projection.segments.find((item) => item.id === "segment-artifact-outer-only")?.status).toBe("failed");
  expect(projection.lanes.find((item) => item.id === "lane-artifact-outer-only")?.status).toBe("failed");
  expect(canvasSession?.nodes.find((node) => node.id === "lane-artifact-outer-only")).toMatchObject({
    status: "failed",
    requiredEvidence: ["artifact"],
  });
  expect(scheduleReadyLanes(projection, { allowedParallelism: 2 }).map((lane) => lane.id)).not.toContain(
    "lane-artifact-outer-only-review",
  );
  const serialized = JSON.stringify({ events: store.listEvents("session-1"), projection, canvasSession });
  for (const raw of rawValues) expect(serialized).not.toContain(raw);
}

function simulateLegacyEvidenceSchema(db: Database.Database): void {
  for (const table of ["workflow_events", "workflow_segments"]) {
    const columns = new Set((db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>).map((row) => row.name));
    if (columns.has("legacy_evidence_compatibility")) {
      db.exec(`ALTER TABLE ${table} DROP COLUMN legacy_evidence_compatibility`);
    }
  }
  db.prepare("DELETE FROM schema_migrations WHERE version = 3").run();
}

async function makeNullExitFlowEventFixture(legacySchema: boolean): Promise<string> {
  const store = await makeSeededStore();
  const projectRoot = dirname(dirname(store.databasePath));
  declareCodeChangeWorkflow(store);
  store.scheduleReadyLanes("session-1", { allowedParallelism: 1, now: "2026-06-14T00:00:03.000Z" });
  store.appendWorkflowEvent({
    sessionId: "session-1",
    kind: "workflow.evidence.recorded",
    source: "codex",
    laneId: "lane-implementation",
    segmentId: "segment-session-1-lane-implementation",
    idempotencyKey: "evidence:null-exit-schema-fixture",
    payload: {
      laneId: "lane-implementation",
      segmentId: "segment-session-1-lane-implementation",
      evidence: {
        id: "evidence-null-exit-schema-fixture",
        kind: "run-exit",
        status: "passed",
        checks: [],
        artifacts: [],
        runEvidence: terminalRunEvidence(
          "run-session-1-lane-implementation",
          "succeeded",
          0,
          [{ kind: "test", name: "Historical verification", status: "passed" }],
          [],
        ),
      },
    },
    now: "2026-06-14T00:00:04.000Z",
  });
  store.appendWorkflowEvent({
    sessionId: "session-1",
    kind: "workflow.segment.finished",
    source: "codex",
    laneId: "lane-implementation",
    segmentId: "segment-session-1-lane-implementation",
    idempotencyKey: "segment:null-exit-schema-fixture:finished",
    payload: {
      laneId: "lane-implementation",
      segmentId: "segment-session-1-lane-implementation",
      status: "succeeded",
      exitCode: 0,
    },
    now: "2026-06-14T00:00:04.100Z",
  });
  store.close();

  const db = new Database(join(projectRoot, ".devflow", "skyturn-workflow.sqlite"));
  if (legacySchema) simulateLegacyEvidenceSchema(db);
  db.prepare("UPDATE workflow_events SET payload_json = ? WHERE session_id = ? AND idempotency_key = ?").run(
    JSON.stringify({
      laneId: "lane-implementation",
      segmentId: "segment-session-1-lane-implementation",
      evidence: {
        id: "evidence-null-exit-schema-fixture",
        kind: "run-exit",
        status: "passed",
        checks: ["test:Historical verification:passed"],
        artifacts: [],
        runEvidence: terminalRunEvidence(
          "run-session-1-lane-implementation",
          "succeeded",
          null,
          [{ kind: "test", name: "Historical verification", status: "passed" }],
          [],
        ),
      },
    }),
    "session-1",
    "evidence:null-exit-schema-fixture",
  );
  db.close();
  return projectRoot;
}

function seedStore(
  store: ReturnType<typeof createWorkflowStore>,
  target?: { executionTarget: "new_worktree"; selectedBranch: string; baseRef: string },
): void {
  store.createWorkflowSession({
    id: "session-1",
    projectId: "project-1",
    title: "Persisted workflow",
    goal: "Implement event sourced workflow",
    mode: "fast",
    plannerProfile: "default",
    transport: "hermes_replay_recovery",
    recoveryReason: "Hermes live chat handle was not available during test setup.",
    ...(target ? { target } : {}),
    now: "2026-06-14T00:00:00.000Z",
  });
  store.applyWorkflowCardToolCall(
    "session-1",
    createCard("tool-plan", {
      id: "node-plan",
      taskKey: "planning",
      title: "Plan requirements",
      agent: "hermes",
      status: "running",
      brief: "Complete the requirements plan.",
    }),
    workflowContext("run-planner"),
  );
}

function declareCodeChangeWorkflow(store: ReturnType<typeof createWorkflowStore>): void {
  store.appendUserInput({
    sessionId: "session-1",
    inputId: "input-1",
    text: "In this git repository, update src/tasks.ts and add tests.",
    now: "2026-06-14T00:00:01.000Z",
  });
  store.applyWorkflowIntent({
    intentId: "intent-code-change-1",
    sessionId: "session-1",
    operations: [
      {
        type: "AnalyzeRequirement",
        requirement: "In this git repository, update src/tasks.ts and add tests.",
      },
      { type: "DiscoverProject", profile: { languages: ["typescript"], capabilities: ["code-change"] } },
      { type: "ProposeLanes" },
    ],
  }, "2026-06-14T00:00:02.000Z");
}

function declareLegacyCodeLane(store: ReturnType<typeof createWorkflowStore>): void {
  declareCompletedPlanningLane(store);
  expect(store.applyWorkflowCardToolCall(
    "session-1",
    createCard("tool-code-legacy-evidence", {
      id: "node-code",
      taskKey: "code-legacy-evidence",
      title: "Implement core",
      agent: "codex",
      brief: "Write the implementation.",
    }),
    workflowContext("run-planner"),
  )).toMatchObject({ status: "applied", nodeId: "node-code" });
}

function assertCanonicalNestedPersistence(
  store: ReturnType<typeof createWorkflowStore>,
  rawValues: string[],
): void {
  const projection = store.materializeFlowProjection("session-1");
  const serialized = JSON.stringify({ events: store.listEvents("session-1"), projection });
  const evidence = projection.evidence.at(-1);
  expect(evidence).toMatchObject({ status: "failed", artifacts: [] });
  expect(evidence?.runEvidence).toMatchObject({ status: "failed", artifacts: [] });
  expect(projection.segments.at(-1)?.status).toBe("failed");
  expect(projection.lanes.find((lane) => lane.id === "lane-implementation")?.status).toBe("failed");
  expect(store.materializeCanvasSession("session-1")?.nodes.find((node) => node.id === "lane-implementation")?.status).toBe("failed");
  expect(store.scheduleReadyLanes("session-1", { allowedParallelism: 2, now: "2026-06-14T00:00:06.000Z" }).readyLanes).toEqual([]);
  for (const raw of rawValues) expect(serialized).not.toContain(raw);
}

function assertLegacyArtifactFailure(store: ReturnType<typeof createWorkflowStore>): void {
  const segment = store.listSegments("session-1", "node-code").find((item) => item.id === "segment-code-artifact-failed");
  expect(segment).toMatchObject({
    status: "failed",
    evidence: {
      runId: "run-code-artifact-failed",
      status: "failed",
      exitCode: 0,
      artifacts: [],
    },
  });
  expect(store.getLane("session-1", "node-code")?.status).toBe("failed");
  expect(store.materializeCanvasSession("session-1")?.nodes.find((node) => node.id === "node-code")?.status).toBe("failed");
  expect(store.applyWorkflowCardToolCall(
    "session-1",
    createCard("tool-review-blocked-artifact", {
      id: "node-review-blocked-artifact",
      taskKey: "review-blocked-artifact",
      title: "Review failed artifact",
      agent: "hermes",
      brief: "Review the implementation.",
      dependencies: ["node-code"],
    }),
    workflowContext("run-planner"),
  )).toMatchObject({ status: "skipped", message: expect.stringMatching(/evidence/i) });
}

function appendCompiledFlowEvent(store: ReturnType<typeof createWorkflowStore>, event: FlowEvent): void {
  store.appendWorkflowEvent({
    sessionId: event.sessionId,
    kind: event.kind,
    source: event.source,
    idempotencyKey: event.idempotencyKey,
    payload: event.payload,
    now: event.createdAt,
  });
}

function insertBeforeEventsForTarget(
  store: ReturnType<typeof createWorkflowStore>,
  targetLaneId: string,
) {
  return store.listEvents("session-1").filter((event) =>
    event.kind === "workflow.lane.inserted_before" && event.payload.targetLaneId === targetLaneId
  );
}

function insertBeforeLanePayload(event: FlowEvent): Record<string, unknown> {
  return event.payload.lane as Record<string, unknown>;
}

function declareCompletedImplementationWithUpstream(store: ReturnType<typeof createWorkflowStore>): void {
  store.appendWorkflowEvent({
    sessionId: "session-1",
    kind: "workflow.lane.declared",
    source: "test",
    idempotencyKey: "lane:upstream",
    payload: { lane: { id: "lane-upstream", semanticKey: "lane-upstream", kind: "design", title: "Upstream", agentKind: "codex", status: "completed" } },
    now: "2026-06-14T00:00:01.000Z",
  });
  store.appendWorkflowEvent({
    sessionId: "session-1",
    kind: "workflow.lane.declared",
    source: "test",
    idempotencyKey: "lane:implementation",
    payload: { lane: { id: "lane-implementation", semanticKey: "lane-implementation", kind: "implementation", title: "Implement", agentKind: "codex", status: "completed" } },
    now: "2026-06-14T00:00:02.000Z",
  });
  store.appendWorkflowEvent({
    sessionId: "session-1",
    kind: "workflow.edge.declared",
    source: "test",
    idempotencyKey: "edge:upstream-implementation",
    payload: { edge: { id: "edge-upstream-implementation", sourceLaneId: "lane-upstream", targetLaneId: "lane-implementation" } },
    now: "2026-06-14T00:00:03.000Z",
  });
  store.appendWorkflowEvent({
    sessionId: "session-1",
    kind: "workflow.evidence.recorded",
    source: "test",
    laneId: "lane-implementation",
    segmentId: "segment-session-1-lane-implementation",
    idempotencyKey: "evidence:implementation-completed",
    payload: {
      laneId: "lane-implementation",
      segmentId: "segment-session-1-lane-implementation",
      evidence: { id: "evidence-implementation-completed", kind: "run-exit", status: "passed", checks: [], artifacts: [] },
    },
    now: "2026-06-14T00:00:04.000Z",
  });
}

function advanceCodeChangeWorkflowToLane(
  store: ReturnType<typeof createWorkflowStore>,
  targetLaneId: "lane-implementation" | "lane-validation" | "lane-review",
): void {
  store.scheduleReadyLanes("session-1", {
    allowedParallelism: 1,
    now: "2026-06-14T00:00:03.000Z",
  });
  if (targetLaneId === "lane-implementation") return;
  store.recordRunResult(runResultInput(store, "lane-implementation", "succeeded", "2026-06-14T00:00:04.000Z"));
  store.scheduleReadyLanes("session-1", {
    allowedParallelism: 1,
    now: "2026-06-14T00:00:05.000Z",
  });
  if (targetLaneId === "lane-validation") return;
  store.recordRunResult(runResultInput(store, "lane-validation", "succeeded", "2026-06-14T00:00:06.000Z"));
  store.scheduleReadyLanes("session-1", {
    allowedParallelism: 1,
    now: "2026-06-14T00:00:07.000Z",
  });
}

function runOutputEvent(runId: string, seq: number, text: string): RunEvent {
  return {
    protocolVersion: 1,
    runId,
    seq,
    kind: "output",
    payload: { source: "codex", stream: "stdout", format: "text", text },
    timestamp: `2026-06-14T00:00:${String(seq).padStart(2, "0")}.000Z`,
  };
}

function runProgressEvent(
  runId: string,
  seq: number,
  text: string,
  source: "codex" | "hermes" = "hermes",
): RunEvent {
  return {
    protocolVersion: 1,
    runId,
    seq,
    kind: "progress",
    payload: { source, stream: "stderr", format: "text", text },
    timestamp: `2026-06-14T00:00:${String(seq).padStart(2, "0")}.000Z`,
  };
}

function runChangesEvent(runId: string, seq: number, source: "codex" | "hermes" = "hermes"): RunEvent {
  return {
    protocolVersion: 1,
    runId,
    seq,
    kind: "changes",
    payload: { source, files: ["src/planner.ts"] },
    timestamp: `2026-06-14T00:00:${String(seq).padStart(2, "0")}.000Z`,
  };
}

function terminalOnlyRunEvents(
  runId: string,
  source: "codex" | "hermes" = "codex",
  startSeq = 1,
): RunEvent[] {
  return [
    {
      protocolVersion: 1,
      runId,
      seq: startSeq,
      kind: "evidence",
      payload: {
        source,
        exitCode: 0,
        checks: [{ kind: "run-exit", name: `${source === "hermes" ? "Hermes CLI" : "Agent"} exit`, status: "passed" }],
      },
      timestamp: `2026-06-14T00:00:${String(startSeq).padStart(2, "0")}.000Z`,
    },
    {
      protocolVersion: 1,
      runId,
      seq: startSeq + 1,
      kind: "status",
      payload: { source, status: "succeeded", exitCode: 0 },
      timestamp: `2026-06-14T00:00:${String(startSeq + 1).padStart(2, "0")}.000Z`,
    },
  ];
}

function plannerRunEvidence(runId: string, completedAt: string): RunEvidence {
  return {
    runId,
    status: "succeeded",
    exitCode: 0,
    changesetId: null,
    checks: [{ kind: "run-exit", name: "Hermes CLI exit", status: "passed", detail: "exit 0" }],
    artifacts: [],
    review: null,
    errorReason: null,
    cancelReason: null,
    completedAt,
  };
}

function runResultInput(
  store: ReturnType<typeof createWorkflowStore>,
  laneId: string,
  status: RunEvidence["status"],
  now: string,
) {
  const lane = store.materializeFlowProjection("session-1").lanes.find((item) => item.id === laneId);
  if (!lane) throw new Error(`Unknown test lane ${laneId}.`);
  const passed = status === "succeeded";
  const cancelled = status === "cancelled";
  return {
    sessionId: "session-1",
    laneId,
    segmentId: `segment-session-1-${laneId}`,
    runId: `run-session-1-${laneId}`,
    agentKind: lane.agentKind,
    outputSummary: passed ? `Completed ${laneId}.` : `Stopped ${laneId}.`,
    evidence: {
      runId: `run-session-1-${laneId}`,
      status,
      exitCode: passed ? 0 : cancelled ? null : 1,
      changesetId: passed ? `changeset-${laneId}` : null,
      checks: [
        {
          kind: passed ? "test" : "run-exit",
          name: passed ? "pnpm test" : "Agent run exit",
          status: passed ? "passed" : cancelled ? "skipped" : "failed",
          detail: passed ? "passed" : cancelled ? "User cancelled the run." : "exit 1",
        },
      ],
      artifacts: [],
      review: null,
      errorReason: passed || cancelled ? null : `${laneId} failed.`,
      cancelReason: cancelled ? "User cancelled the run." : null,
      completedAt: now,
    } satisfies RunEvidence,
    now,
  };
}

function recordCheckpoint(
  store: ReturnType<typeof createWorkflowStore>,
  checkpointId: string,
  laneId: string,
  phase: "before" | "after",
  headCommit: string,
): void {
  store.appendWorkflowEvent({
    sessionId: "session-1",
    kind: "workflow.node.checkpoint_recorded",
    source: "test",
    laneId,
    idempotencyKey: `checkpoint:${checkpointId}`,
    payload: {
      checkpoint: {
        id: checkpointId,
        sessionId: "session-1",
        nodeId: laneId,
        laneId,
        runId: `run-session-1-${laneId}`,
        segmentId: `segment-session-1-${laneId}`,
        phase,
        executionTarget: "current_branch",
        baseCommit: "base-sha",
        headCommit,
        createdAt: "2026-06-14T00:00:08.000Z",
        source: "backend",
        evidenceRefs: [{ kind: "run", id: `run-session-1-${laneId}` }],
      },
    },
    now: "2026-06-14T00:00:08.000Z",
  });
}

function recordCheckpointForSegment(
  store: ReturnType<typeof createWorkflowStore>,
  checkpointId: string,
  laneId: string,
  runId: string,
  segmentId: string,
  now: string,
  evidenceRefs: Array<{ kind: "run" | "evidence"; id: string }> = [{ kind: "run", id: runId }],
): void {
  store.appendWorkflowEvent({
    sessionId: "session-1",
    kind: "workflow.node.checkpoint_recorded",
    source: "test",
    laneId,
    idempotencyKey: `checkpoint:${checkpointId}`,
    payload: {
      checkpoint: {
        id: checkpointId,
        sessionId: "session-1",
        nodeId: laneId,
        laneId,
        runId,
        segmentId,
        phase: "after",
        executionTarget: "current_branch",
        baseCommit: "base-sha",
        headCommit: `${checkpointId}-head-sha`,
        createdAt: now,
        source: "backend",
        evidenceRefs,
      },
    },
    now,
  });
}

function appendFailedEvidence(
  store: ReturnType<typeof createWorkflowStore>,
  laneId: string,
  segmentId: string,
  evidenceId: string,
  detail: string,
  now: string,
  runId?: string,
): void {
  if (runId) {
    store.appendWorkflowEvent({
      sessionId: "session-1",
      kind: "workflow.segment.started",
      source: "test",
      laneId,
      segmentId,
      idempotencyKey: `segment:${segmentId}:started`,
      payload: {
        segment: {
          id: segmentId,
          laneId,
          runId,
          status: "running",
        },
      },
      now,
    });
  }
  store.appendWorkflowEvent({
    sessionId: "session-1",
    kind: "workflow.evidence.recorded",
    source: "test",
    laneId,
    segmentId,
    idempotencyKey: `evidence:${evidenceId}`,
    payload: {
      laneId,
      segmentId,
      evidence: {
        id: evidenceId,
        kind: "run-exit",
        status: "failed",
        checks: ["run-exit:failed"],
        artifacts: [],
        detail,
        ...(runId ? {
          runEvidence: {
            runId,
            status: "failed",
            exitCode: 1,
            changesetId: null,
            checks: [{ kind: "run-exit", name: "Agent run exit", status: "failed" }],
            artifacts: [],
            review: null,
            errorReason: detail,
            cancelReason: null,
            completedAt: now,
          },
        } : {}),
      },
    },
    now,
  });
  store.appendWorkflowEvent({
    sessionId: "session-1",
    kind: "workflow.segment.finished",
    source: "test",
    laneId,
    segmentId,
    idempotencyKey: `segment:${segmentId}:finished`,
    payload: {
      laneId,
      segmentId,
      status: "failed",
      exitCode: 1,
    },
    now,
  });
}

function recordDefaultedCheckpoint(
  store: ReturnType<typeof createWorkflowStore>,
  checkpointId: string,
  laneId: string,
): void {
  store.appendWorkflowEvent({
    sessionId: "session-1",
    kind: "workflow.node.checkpoint_recorded",
    source: "test",
    laneId,
    idempotencyKey: `checkpoint:${checkpointId}`,
    payload: {
      checkpoint: {
        id: checkpointId,
        sessionId: "session-1",
        nodeId: laneId,
        laneId,
        runId: `run-session-1-${laneId}`,
        segmentId: `segment-session-1-${laneId}`,
        executionTarget: "current_branch",
        baseCommit: "base-sha",
        headCommit: "head-sha",
        createdAt: "2026-06-14T00:00:08.000Z",
        source: "backend",
        evidenceRefs: [{ kind: "run", id: `run-session-1-${laneId}` }],
      },
    },
    now: "2026-06-14T00:00:08.000Z",
  });
}

function declareCompletedPlanningLane(store: ReturnType<typeof createWorkflowStore>): void {
  store.recordManualEvidence({
    sessionId: "session-1",
    laneId: "node-plan",
    idempotencyKey: "manual:planning-complete",
    summary: "Planning approved.",
    now: "2026-06-14T00:00:01.000Z",
  });
}

function workflowContext(sourceRunId: string) {
  return {
    sourceRunId,
    now: "2026-06-14T00:00:01.000Z",
    causationId: "event-hermes-output",
  };
}
