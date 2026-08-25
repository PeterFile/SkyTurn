import { createHash } from "node:crypto";
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
import {
  canonicalCandidateReviewRequestJson,
  canonicalWorkflowCandidateManifestJson,
  createWorkflowGitAncestryProofContext,
  type CandidateReviewRequest,
  type RunEvent,
  type RunEvidence,
  type WorkflowGitAncestryProofContext,
  type WorkflowWorktreeIdentity,
} from "@skyturn/project-core";
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
  it("materializes a reopened legacy pending planner without fabricating a run", async () => {
    const projectRoot = await makeTempRoot();
    const store = createWorkflowStore({ projectRoot });
    const session = store.createWorkflowSession({
      id: "session-legacy-pending",
      projectId: "project-1",
      title: "Legacy pending planner",
      goal: "Wait for the first concrete planner turn",
      mode: "fast",
      plannerProfile: "default",
      transport: "hermes_replay_recovery",
      recoveryReason: "Legacy durable session has not started a planner turn.",
      now: "2026-07-21T00:00:00.000Z",
    });
    store.close();

    const reopened = createWorkflowStore({ projectRoot });
    const canvas = reopened.materializeCanvasSession(session.id);
    const planner = canvas?.nodes.find((node) => node.id === session.plannerLaneId);

    expect(planner?.status).toBe("pending");
    expect(planner).not.toHaveProperty("runId");
    expect(canvas?.activeNodeId).toBeNull();
    expect(reopened.listSegments(session.id, session.plannerLaneId)).toEqual([]);
    reopened.close();
  });

  it("lists workflow session ids in durable creation order across reopen", async () => {
    const projectRoot = await makeTempRoot();
    const store = createWorkflowStore({ projectRoot });
    for (const [id, now] of [
      ["session-later-id", "2026-07-21T00:00:00.000Z"],
      ["session-earlier-id", "2026-07-21T00:00:01.000Z"],
    ] as const) {
      const session = store.createWorkflowSession({
        id,
        projectId: "project-1",
        title: id,
        goal: `Goal for ${id}`,
        mode: "fast",
        plannerProfile: "default",
        transport: "hermes_replay_recovery",
        recoveryReason: "Test setup has no live Hermes session.",
        now,
      });
      completeInitialPlannerTurn(store, session);
    }
    expect(store.listWorkflowSessionIds()).toEqual(["session-later-id", "session-earlier-id"]);
    const first = store.getWorkflowSession("session-later-id");
    const second = store.getWorkflowSession("session-earlier-id");
    expect(first?.plannerLaneId).toBe("node-1");
    expect(second?.plannerLaneId).toMatch(/^node-planner-[a-f0-9]{24}$/);
    expect(second?.plannerLaneId).not.toBe(first?.plannerLaneId);
    expect(store.materializeCanvasSession("session-later-id")?.plannerNodeId).toBe(first?.plannerLaneId);
    expect(store.materializeCanvasSession("session-earlier-id")?.plannerNodeId).toBe(second?.plannerLaneId);
    expect(store.materializeCanvasSession("session-earlier-id")?.nodes.map((node) => node.id)).toContain(second?.plannerLaneId);
    store.close();

    const reopened = createWorkflowStore({ projectRoot });
    expect(reopened.listWorkflowSessionIds()).toEqual(["session-later-id", "session-earlier-id"]);
    expect(reopened.getWorkflowSession("session-later-id")?.plannerLaneId).toBe(first?.plannerLaneId);
    expect(reopened.getWorkflowSession("session-earlier-id")?.plannerLaneId).toBe(second?.plannerLaneId);
    reopened.close();
  });

  it("persists one strict allowed candidate review attestation across two reopens without projection authority", async () => {
    const projectRoot = await makeTempRoot();
    const store = createWorkflowStore({ projectRoot });
    const fixture = preparedPublicationFixture(store, projectRoot);
    const projectionBefore = store.materializeFlowProjection(fixture.identity.sessionId);
    const ledgerBefore = store.buildLedgerSummary(fixture.identity.sessionId);
    const event = appendAllowedCandidateReview(store, fixture);
    const eventBytes = JSON.stringify(event);
    const eventCount = store.listEvents(fixture.identity.sessionId).length;

    expect(appendAllowedCandidateReview(store, fixture, "2026-08-14T00:00:01.000Z")).toEqual(event);
    expect(JSON.stringify(appendAllowedCandidateReview(
      store,
      fixture,
      "2026-08-14T00:00:02.000Z",
    ))).toBe(eventBytes);
    expect(store.listEvents(fixture.identity.sessionId)).toHaveLength(eventCount);
    expect(getAllowedCandidateReview(store, fixture)).toEqual(fixture.decision);
    expect(event).toMatchObject({
      kind: "workflow.candidate.review_allowed",
      source: "workflow_store",
      laneId: fixture.identity.laneId,
      segmentId: fixture.identity.segmentId,
      idempotencyKey: `candidate-review-allowed:${fixture.identity.runId}`,
      payload: {
        sessionId: fixture.identity.sessionId,
        nodeId: fixture.identity.nodeId,
        laneId: fixture.identity.laneId,
        segmentId: fixture.identity.segmentId,
        runId: fixture.identity.runId,
        manifestSha256: fixture.manifestSha256,
        decision: fixture.decision,
      },
    });
    expect(store.materializeFlowProjection(fixture.identity.sessionId)).toEqual(projectionBefore);
    expect(store.buildLedgerSummary(fixture.identity.sessionId)).toEqual(ledgerBefore);
    expect(JSON.stringify(event)).not.toMatch(
      /worktreePath|patch|files|reviewRequest|prompt|credential|subject|body|output/,
    );
    store.close();

    const reopened = createWorkflowStore({ projectRoot });
    expect(getAllowedCandidateReview(reopened, fixture)).toEqual(fixture.decision);
    expect(reopened.materializeFlowProjection(fixture.identity.sessionId)).toEqual(projectionBefore);
    reopened.close();

    const reopenedAgain = createWorkflowStore({ projectRoot });
    expect(getAllowedCandidateReview(reopenedAgain, fixture)).toEqual(fixture.decision);
    expect(reopenedAgain.materializeFlowProjection(fixture.identity.sessionId)).toEqual(projectionBefore);
    reopenedAgain.close();
  });

  it("opens an old store without an attestation and returns no review authority", async () => {
    const projectRoot = await makeTempRoot();
    const store = createWorkflowStore({ projectRoot });
    const fixture = preparedPublicationFixture(store, projectRoot);
    store.close();

    const reopened = createWorkflowStore({ projectRoot });
    expect(getAllowedCandidateReview(reopened, fixture)).toBeNull();
    reopened.close();
  });

  it("opens an old prepared publication without attestation but refuses to return publication authority", async () => {
    const projectRoot = await makeTempRoot();
    const store = createWorkflowStore({ projectRoot });
    const fixture = preparedPublicationFixture(store, projectRoot);
    const databasePath = store.databasePath;
    store.close();
    insertPreAttestationPreparedPublicationRow(databasePath, fixture);

    const reopened = createWorkflowStore({ projectRoot });
    expect(() => reopened.getPreparedCandidatePublication(fixture.lookup)).toThrow(/review|attestation/i);
    expect(getAllowedCandidateReview(reopened, fixture)).toBeNull();
    reopened.close();
  });

  it("refuses a prepared publication when the allow attestation was appended afterward", async () => {
    const projectRoot = await makeTempRoot();
    const store = createWorkflowStore({ projectRoot });
    const fixture = preparedPublicationFixture(store, projectRoot);
    const databasePath = store.databasePath;
    store.close();
    insertPreAttestationPreparedPublicationRow(databasePath, fixture);

    const reopened = createWorkflowStore({ projectRoot });
    appendAllowedCandidateReview(reopened, fixture, "2026-08-14T00:00:01.000Z");
    expect(() => reopened.getPreparedCandidatePublication(fixture.lookup)).toThrow(/review|attestation|order/i);
    reopened.close();

    expect(() => createWorkflowStore({ projectRoot })).toThrow(/review|attestation|prepared|digest/i);
  });

  it("rejects conflicting allowed review replay without writing", async () => {
    const projectRoot = await makeTempRoot();
    const store = createWorkflowStore({ projectRoot });
    const fixture = preparedPublicationFixture(store, projectRoot);
    appendAllowedCandidateReview(store, fixture);
    const events = store.listEvents(fixture.identity.sessionId);

    expect(() => appendAllowedCandidateReview(store, {
      ...fixture,
      decision: { ...fixture.decision, requestSha256: "c".repeat(64) },
    })).toThrow(/review|attestation|conflict/i);
    expect(store.listEvents(fixture.identity.sessionId)).toEqual(events);
    store.close();
  });

  it.each([
    ["a forged manifest digest", (row: RawWorkflowEventRow) => {
      const payload = JSON.parse(row.payload_json) as Record<string, unknown>;
      payload.manifestSha256 = "9".repeat(64);
      row.payload_json = stableTestJson(payload);
    }],
    ["a forged request digest", (row: RawWorkflowEventRow) => {
      const payload = JSON.parse(row.payload_json) as { decision: Record<string, unknown> };
      payload.decision.requestSha256 = "A".repeat(64);
      row.payload_json = stableTestJson(payload);
    }],
    ["a blocked disposition", (row: RawWorkflowEventRow) => {
      const payload = JSON.parse(row.payload_json) as { decision: Record<string, unknown> };
      payload.decision.disposition = "block";
      row.payload_json = stableTestJson(payload);
    }],
    ["an extra payload field", (row: RawWorkflowEventRow) => {
      const payload = JSON.parse(row.payload_json) as Record<string, unknown>;
      payload.prompt = "untrusted";
      row.payload_json = stableTestJson(payload);
    }],
    ["a forged outer lane", (row: RawWorkflowEventRow) => {
      row.lane_id = "lane-forged";
    }],
    ["a forged idempotency key", (row: RawWorkflowEventRow) => {
      row.idempotency_key = "candidate-review-allowed:run-forged";
    }],
    ["noncanonical payload bytes", (row: RawWorkflowEventRow) => {
      row.payload_json = `${row.payload_json} `;
    }],
    ["malformed payload JSON", (row: RawWorkflowEventRow) => {
      row.payload_json = "{";
    }],
  ])("fails store reopen closed for an allowed review attestation with %s", async (_label, mutate) => {
    const projectRoot = await makeTempRoot();
    const store = createWorkflowStore({ projectRoot });
    const fixture = preparedPublicationFixture(store, projectRoot);
    const event = appendAllowedCandidateReview(store, fixture) as { id: string };
    const databasePath = store.databasePath;
    store.close();

    mutateRawWorkflowEvent(databasePath, event.id, mutate);
    expect(() => createWorkflowStore({ projectRoot })).toThrow(/review|attestation|candidate|JSON/i);
  });

  it("persists only manifest-bound prepared publication input across reopen without projecting it", async () => {
    const projectRoot = await makeTempRoot();
    const store = createWorkflowStore({ projectRoot });
    const fixture = preparedPublicationFixture(store, projectRoot);
    const projectionBefore = store.materializeFlowProjection(fixture.identity.sessionId);
    const ledgerBefore = store.buildLedgerSummary(fixture.identity.sessionId);
    appendAllowedCandidateReview(store, fixture);
    const api = store as unknown as {
      appendPreparedCandidatePublication(input: typeof fixture.input): unknown;
      getPreparedCandidatePublication(input: typeof fixture.lookup): unknown;
    };
    expect(typeof api.appendPreparedCandidatePublication).toBe("function");
    expect(typeof api.getPreparedCandidatePublication).toBe("function");
    if (
      typeof api.appendPreparedCandidatePublication !== "function" ||
      typeof api.getPreparedCandidatePublication !== "function"
    ) {
      store.close();
      return;
    }

    const event = api.appendPreparedCandidatePublication(fixture.input) as {
      kind: string;
      source: string;
      payload: Record<string, unknown>;
    };
    const eventBytes = JSON.stringify(event);
    const eventsAfterAppend = store.listEvents(fixture.identity.sessionId);
    expect(api.appendPreparedCandidatePublication({
      ...fixture.input,
      now: "2026-08-14T00:00:01.000Z",
    })).toEqual(event);
    expect(JSON.stringify(api.appendPreparedCandidatePublication({
      ...fixture.input,
      now: "2026-08-14T00:00:02.000Z",
    }))).toBe(eventBytes);
    expect(store.listEvents(fixture.identity.sessionId)).toEqual(eventsAfterAppend);
    expect(api.getPreparedCandidatePublication(fixture.lookup)).toEqual(fixture.preparation);
    expect(event).toMatchObject({
      kind: "workflow.commit.publication_prepared",
      source: "workflow_store",
      payload: {
        laneId: fixture.publicationLaneId,
        candidateLaneId: fixture.identity.laneId,
        segmentId: fixture.identity.segmentId,
        manifestSha256: fixture.manifestSha256,
        requestSha256: fixture.input.requestSha256,
        reviewRequestSha256: fixture.reviewRequestSha256,
        preparation: fixture.preparation,
      },
    });
    const independentReviewRequestSha256 = createHash("sha256")
      .update(canonicalCandidateReviewRequestJson(fixture.reviewRequest), "utf8")
      .digest("hex");
    expect(fixture.decision.requestSha256).toBe(independentReviewRequestSha256);
    expect(event.payload.reviewRequestSha256).toBe(independentReviewRequestSha256);
    expect(store.materializeFlowProjection(fixture.identity.sessionId)).toEqual(projectionBefore);
    expect(store.buildLedgerSummary(fixture.identity.sessionId)).toEqual(ledgerBefore);
    expect(JSON.stringify(event)).not.toMatch(/worktreePath|fullPatchBase64|patchPreview|credential|subject|body/);
    store.close();

    const reopened = createWorkflowStore({ projectRoot });
    const reopenedApi = reopened as unknown as {
      getPreparedCandidatePublication(input: typeof fixture.lookup): unknown;
    };
    expect(reopenedApi.getPreparedCandidatePublication(fixture.lookup)).toEqual(fixture.preparation);
    expect(reopened.materializeFlowProjection(fixture.identity.sessionId)).toEqual(projectionBefore);
    expect(reopened.buildLedgerSummary(fixture.identity.sessionId)).toEqual(ledgerBefore);
    reopened.close();

    const reopenedAgain = createWorkflowStore({ projectRoot });
    expect(reopenedAgain.getPreparedCandidatePublication(fixture.lookup)).toEqual(fixture.preparation);
    reopenedAgain.close();
  });

  it.each(["attestation", "prepared publication"])(
    "fails getter and reopen when the %s has a different legal review request digest",
    async (corruptedSide) => {
      const projectRoot = await makeTempRoot();
      const store = createWorkflowStore({ projectRoot });
      const fixture = preparedPublicationFixture(store, projectRoot);
      const attestation = appendAllowedCandidateReview(store, fixture) as { id: string };
      const prepared = store.appendPreparedCandidatePublication(fixture.input);
      const targetId = corruptedSide === "attestation" ? attestation.id : prepared.id;

      mutateRawWorkflowEvent(store.databasePath, targetId, (row) => {
        const payload = JSON.parse(row.payload_json) as Record<string, unknown>;
        if (corruptedSide === "attestation") {
          (payload.decision as Record<string, unknown>).requestSha256 = fixture.otherReviewRequestSha256;
        } else {
          payload.reviewRequestSha256 = fixture.otherReviewRequestSha256;
        }
        row.payload_json = stableTestJson(payload);
      });

      expect(fixture.otherReviewRequestSha256).not.toBe(fixture.reviewRequestSha256);
      expect(() => store.getPreparedCandidatePublication(fixture.lookup)).toThrow(/review|attestation|prepared|digest/i);
      store.close();
      expect(() => createWorkflowStore({ projectRoot })).toThrow(/review|attestation|prepared|digest/i);
    },
  );

  it("quarantines exact v8 prepared publications before strict validation and permits a fresh strict preparation", async () => {
    const projectRoot = await makeTempRoot();
    const store = createWorkflowStore({ projectRoot });
    const fixture = preparedPublicationFixture(store, projectRoot);
    const projectionBefore = store.materializeFlowProjection(fixture.identity.sessionId);
    const databasePath = store.databasePath;
    store.close();

    const legacy = insertBaselinePreparedPublicationRow(databasePath, fixture);
    const legacyLogicalValues = [
      fixture.manifestSha256,
      fixture.input.requestSha256,
      fixture.preparation.commitSha,
      fixture.preparation.treeSha,
    ];

    const reopened = createWorkflowStore({ projectRoot });
    expect(reopened.listAppliedMigrations()).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9]);
    const events = reopened.listEvents(fixture.identity.sessionId);
    const audit = events.find((event) => event.id === legacy.id);
    expect(audit).toEqual({
      id: legacy.id,
      sessionId: fixture.identity.sessionId,
      seq: legacy.seq,
      kind: "workflow.run.recovery_failed",
      source: "workflow_store",
      laneId: null,
      segmentId: null,
      causationId: null,
      correlationId: null,
      idempotencyKey: null,
      payload: {
        reason: "legacy-prepared-publication-requires-fresh-review",
        status: "failed",
      },
      createdAt: legacy.createdAt,
    });
    const logicalAudit = JSON.stringify(audit);
    for (const value of legacyLogicalValues) expect(logicalAudit).not.toContain(value);
    expect(reopened.getPreparedCandidatePublication(fixture.lookup)).toBeNull();
    expect(reopened.materializeFlowProjection(fixture.identity.sessionId)).toEqual(projectionBefore);

    const quarantinedRow = readRawWorkflowEvent(databasePath, legacy.id);
    expect(quarantinedRow.kind).toBe("workflow.run.recovery_failed");
    expect(quarantinedRow.idempotency_key).toBeNull();
    expect(quarantinedRow.payload_json).toBe(JSON.stringify({
      reason: "legacy-prepared-publication-requires-fresh-review",
      status: "failed",
    }));
    for (const value of legacyLogicalValues) expect(JSON.stringify(quarantinedRow)).not.toContain(value);

    appendAllowedCandidateReview(reopened, fixture);
    const fresh = reopened.appendPreparedCandidatePublication(fixture.input);
    expect(fresh.idempotencyKey).toBe(
      `delivery-commit-prepared:${fixture.publicationLaneId}:${fixture.identity.segmentId}`,
    );
    expect(reopened.getPreparedCandidatePublication(fixture.lookup)).toEqual(fixture.preparation);
    const quarantineBytes = JSON.stringify(readRawWorkflowEvent(databasePath, legacy.id));
    reopened.close();

    const reopenedAgain = createWorkflowStore({ projectRoot });
    expect(reopenedAgain.listAppliedMigrations().filter((version) => version === 9)).toHaveLength(1);
    expect(JSON.stringify(readRawWorkflowEvent(databasePath, legacy.id))).toBe(quarantineBytes);
    expect(reopenedAgain.getPreparedCandidatePublication(fixture.lookup)).toEqual(fixture.preparation);
    expect(reopenedAgain.materializeFlowProjection(fixture.identity.sessionId)).toEqual(projectionBefore);
    reopenedAgain.close();
  });

  it("rolls back legacy publication quarantine when the v9 marker cannot be committed", async () => {
    const projectRoot = await makeTempRoot();
    const store = createWorkflowStore({ projectRoot });
    const fixture = preparedPublicationFixture(store, projectRoot);
    const databasePath = store.databasePath;
    store.close();
    const legacy = insertBaselinePreparedPublicationRow(databasePath, fixture);

    const db = new Database(databasePath);
    db.exec(`
      CREATE TRIGGER reject_publication_quarantine_migration
      BEFORE INSERT ON schema_migrations
      WHEN NEW.version = 9
      BEGIN
        SELECT RAISE(ABORT, 'injected publication quarantine marker failure');
      END;
    `);
    db.close();

    expect(() => createWorkflowStore({ projectRoot })).toThrow(/injected publication quarantine marker failure/);
    const failedRow = readRawWorkflowEvent(databasePath, legacy.id);
    expect(failedRow.kind).toBe("workflow.commit.publication_prepared");
    expect(failedRow.idempotency_key).toBe(legacy.idempotencyKey);
    expect(failedRow.payload_json).toBe(legacy.payloadJson);
    const afterFailure = new Database(databasePath);
    expect(afterFailure.prepare("SELECT COUNT(*) AS count FROM schema_migrations WHERE version = 9").get())
      .toEqual({ count: 0 });
    afterFailure.exec("DROP TRIGGER reject_publication_quarantine_migration");
    afterFailure.close();

    const reopened = createWorkflowStore({ projectRoot });
    expect(reopened.listAppliedMigrations()).toContain(9);
    reopened.close();
  });

  it("leaves a non-legacy prepared publication missing candidate identity to fail store open", async () => {
    const projectRoot = await makeTempRoot();
    const store = createWorkflowStore({ projectRoot });
    const fixture = preparedPublicationFixture(store, projectRoot);
    const databasePath = store.databasePath;
    store.close();
    const malformed = insertBaselinePreparedPublicationRow(databasePath, fixture, (payload) => {
      payload.nodeId = fixture.identity.nodeId;
      payload.runId = fixture.identity.runId;
    });

    expect(() => createWorkflowStore({ projectRoot })).toThrow(/prepared candidate publication.*identity/i);
    const row = readRawWorkflowEvent(databasePath, malformed.id);
    expect(row.kind).toBe("workflow.commit.publication_prepared");
    expect(row.idempotency_key).toBe(malformed.idempotencyKey);
    expect(row.payload_json).toBe(malformed.payloadJson);
    const db = new Database(databasePath, { readonly: true });
    expect(db.prepare("SELECT COUNT(*) AS count FROM schema_migrations WHERE version = 9").get())
      .toEqual({ count: 1 });
    db.close();
  });

  it.each(["forged event id", "manifest ordered after publication"])(
    "leaves a legacy-shaped publication with %s to fail store open",
    async (tampering) => {
      const projectRoot = await makeTempRoot();
      const store = createWorkflowStore({ projectRoot });
      const fixture = preparedPublicationFixture(store, projectRoot);
      const databasePath = store.databasePath;
      store.close();
      const legacy = insertBaselinePreparedPublicationRow(databasePath, fixture);

      const db = new Database(databasePath);
      if (tampering === "forged event id") {
        db.prepare("UPDATE workflow_events SET id = ? WHERE id = ?")
          .run("event-forged-legacy-prepared-publication", legacy.id);
      } else {
        const manifest = db.prepare([
          "SELECT id FROM workflow_events",
          "WHERE session_id = ? AND kind = 'workflow.candidate.manifest_recorded'",
        ].join(" ")).get(fixture.identity.sessionId) as { id: string };
        db.prepare("UPDATE workflow_events SET seq = ? WHERE id = ?")
          .run(legacy.seq + 1, manifest.id);
      }
      db.close();

      expect(() => createWorkflowStore({ projectRoot })).toThrow(/prepared candidate publication.*identity/i);
      const reopened = new Database(databasePath, { readonly: true });
      expect(reopened.prepare([
        "SELECT kind, idempotency_key FROM workflow_events",
        "WHERE session_id = ? AND kind = 'workflow.commit.publication_prepared'",
      ].join(" ")).get(fixture.identity.sessionId)).toEqual({
        kind: "workflow.commit.publication_prepared",
        idempotency_key: legacy.idempotencyKey,
      });
      reopened.close();
    },
  );

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
    expect(reopened.listAppliedMigrations()).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9]);
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
    expect(first.listAppliedMigrations()).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9]);
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
    expect(firstMigrations).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9]);
    expect(second.listAppliedMigrations()).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9]);
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
        status: "pending",
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

  it("atomically rejects a different running planner run across SQLite stores and allows the next terminal turn", async () => {
    const projectRoot = await makeTempRoot();
    const seed = createWorkflowStore({ projectRoot });
    const session = seed.createWorkflowSession({
      id: "session-planner-owner",
      projectId: "project-1",
      title: "Planner ownership",
      goal: "Serialize planner turns",
      mode: "fast",
      plannerProfile: "default",
      transport: "hermes_replay_recovery",
      recoveryReason: "Test setup has no live Hermes session.",
      now: "2026-07-22T01:00:00.000Z",
    });
    seed.close();
    const stores = [
      createWorkflowStore({ projectRoot }),
      createWorkflowStore({ projectRoot }),
    ];
    const claim = (store: ReturnType<typeof createWorkflowStore>, runId: string, now: string) =>
      store.claimPlannerRunStart({
        sessionId: session.id,
        laneId: session.plannerLaneId,
        runId,
        agentKind: "hermes",
        worktreePath: projectRoot,
        now,
      });

    const competing = await Promise.allSettled([
      Promise.resolve().then(() => claim(stores[0]!, "planner-run-owner-a", "2026-07-22T01:00:01.000Z")),
      Promise.resolve().then(() => claim(stores[1]!, "planner-run-owner-b", "2026-07-22T01:00:01.001Z")),
    ]);

    expect(competing.filter((result) => result.status === "fulfilled")).toHaveLength(1);
    expect(competing.filter((result) => result.status === "rejected")).toHaveLength(1);
    expect(String(competing.find((result) => result.status === "rejected")?.reason)).toMatch(
      /planner lane.*running|running planner/i,
    );
    const owner = competing.find((result): result is PromiseFulfilledResult<ReturnType<typeof claim>> =>
      result.status === "fulfilled"
    )!.value;
    const ownerStore = owner.segment.runId === "planner-run-owner-a" ? stores[0]! : stores[1]!;
    const retryStore = ownerStore === stores[0] ? stores[1]! : stores[0]!;
    expect(claim(retryStore, owner.segment.runId, "2026-07-22T01:00:02.000Z").created).toBe(false);

    ownerStore.recordSegmentEvidence({
      ...owner.segment,
      transport: "agent-bridge",
      worktreePath: projectRoot,
      evidence: plannerRunEvidence(owner.segment.runId, "2026-07-22T01:00:03.000Z"),
      now: "2026-07-22T01:00:03.000Z",
    });
    const next = claim(retryStore, "planner-run-next-turn", "2026-07-22T01:00:04.000Z");
    expect(next.created).toBe(true);
    expect(next.segment.runId).toBe("planner-run-next-turn");
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
    completeInitialPlannerTurn(store, session);
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
    completeInitialPlannerTurn(store, session);
    const canvasSession = store.materializeCanvasSession("session-1");
    const planner = canvasSession?.nodes.find((node) => node.id === canvasSession.plannerNodeId);

    expect(session.target).toEqual({
      executionTarget: "new_worktree",
      selectedBranch: "main",
      baseRef: "origin/main",
    });
    expect(planner?.worktree).toMatchObject({
      path: dirname(dirname(store.databasePath)),
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
    completeInitialPlannerTurn(store, session);
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

  it("persists planner intent causation on accepted and declared-lane facts across reopen", async () => {
    const projectRoot = await makeTempRoot();
    const store = createWorkflowStore({ projectRoot });
    seedStore(store);
    const plannerRunId = "run-planner-semantic-turn-2";
    const { segment } = store.claimPlannerRunStart({
      sessionId: "session-1",
      laneId: "node-1",
      runId: plannerRunId,
      agentKind: "hermes",
      worktreePath: projectRoot,
      now: "2026-06-14T00:00:01.000Z",
    });
    store.recordRunResult({
      ...segment,
      evidence: {
        runId: plannerRunId,
        status: "succeeded",
        exitCode: 0,
        changesetId: null,
        checks: [{ kind: "run-exit", name: "Hermes CLI exit", status: "passed" }],
        artifacts: [],
        review: null,
        errorReason: null,
        cancelReason: null,
        completedAt: "2026-06-14T00:00:02.000Z",
      },
      now: "2026-06-14T00:00:02.000Z",
    });
    store.applyWorkflowIntent({
      causationId: plannerRunId,
      intentId: "intent-planner-semantic-turn-2",
      sessionId: "session-1",
      operations: [
        { type: "AnalyzeRequirement", requirement: "Add strict causal provenance" },
        { type: "DiscoverProject", profile: { languages: ["typescript"], capabilities: ["code-change"] } },
        { type: "ProposeLanes" },
      ],
    }, "2026-06-14T00:00:03.000Z");

    const semanticFacts = store.listEvents("session-1").filter((event) =>
      event.kind === "workflow.intent.accepted" || event.kind === "workflow.lane.declared"
    );
    expect(semanticFacts.length).toBeGreaterThan(1);
    expect(semanticFacts.every((event) => event.causationId === plannerRunId)).toBe(true);
    expect(semanticFacts.filter((event) => event.kind === "workflow.lane.declared").every((event) =>
      typeof event.laneId === "string" && event.laneId.length > 0
    )).toBe(true);
    const serializedPayloads = JSON.stringify(semanticFacts.map((event) => event.payload));
    expect(serializedPayloads).not.toContain(plannerRunId);
    expect(serializedPayloads).not.toContain('"prompt"');
    expect(serializedPayloads).not.toContain('"path"');
    expect(serializedPayloads).not.toContain('"handle"');
    store.close();

    const reopened = createWorkflowStore({ projectRoot });
    const reopenedFacts = reopened.listEvents("session-1").filter((event) =>
      event.kind === "workflow.intent.accepted" || event.kind === "workflow.lane.declared"
    );
    expect(reopenedFacts.map((event) => ({
      kind: event.kind,
      laneId: event.laneId,
      causationId: event.causationId,
    }))).toEqual(semanticFacts.map((event) => ({
      kind: event.kind,
      laneId: event.laneId,
      causationId: event.causationId,
    })));
    reopened.close();
  });

  it("replays an accepted planner intent with the same causation as a zero-write success after reopen", async () => {
    const projectRoot = await makeTempRoot();
    const plannerRunId = "run-session-1-initial-planner-turn";
    const intent = {
      intentId: "intent-same-planner-causation",
      sessionId: "session-1",
      operations: [{ type: "AnalyzeRequirement", requirement: "Preserve exact planner causation" }],
    };
    const store = createWorkflowStore({ projectRoot });
    seedStore(store);
    store.applyWorkflowIntent({ ...intent, causationId: plannerRunId }, "2026-06-14T00:00:01.000Z");
    const eventsBeforeReopen = store.listEvents("session-1");
    store.close();

    const reopened = createWorkflowStore({ projectRoot });
    expect(reopened.applyWorkflowIntent({
      ...intent,
      causationId: plannerRunId,
      operations: [{ type: "AnalyzeRequirement", requirement: "A replay must not replace accepted operations" }],
    }, "2026-06-14T00:00:02.000Z")).toEqual({ ok: true, events: [] });
    expect(reopened.listEvents("session-1")).toEqual(eventsBeforeReopen);
    reopened.close();
  });

  it("rejects a reused accepted intentId from a different planner causation without transaction writes", async () => {
    const projectRoot = await makeTempRoot();
    const firstRunId = "run-session-1-initial-planner-turn";
    const secondRunId = "run-planner-reused-intent";
    const intent = {
      intentId: "intent-reused-by-another-planner-run",
      sessionId: "session-1",
      operations: [{ type: "AnalyzeRequirement", requirement: "Bind intent identity to the planner run" }],
    };
    const store = createWorkflowStore({ projectRoot });
    seedStore(store);
    store.applyWorkflowIntent({ ...intent, causationId: firstRunId }, "2026-06-14T00:00:01.000Z");
    const { segment } = store.claimPlannerRunStart({
      sessionId: "session-1",
      laneId: "node-1",
      runId: secondRunId,
      agentKind: "hermes",
      worktreePath: projectRoot,
      now: "2026-06-14T00:00:02.000Z",
    });
    store.recordRunResult({
      ...segment,
      evidence: plannerRunEvidence(secondRunId, "2026-06-14T00:00:03.000Z"),
      now: "2026-06-14T00:00:03.000Z",
    });
    const eventsBeforeConflict = store.listEvents("session-1");
    const projectionBeforeConflict = store.materializeFlowProjection("session-1");
    store.close();

    const reopened = createWorkflowStore({ projectRoot });
    let conflict: unknown;
    try {
      reopened.applyWorkflowIntent({
        ...intent,
        causationId: secondRunId,
        operations: [{ type: "ProposeLanes" }],
      }, "2026-06-14T00:00:04.000Z");
    } catch (error) {
      conflict = error;
    }
    expect(conflict).toMatchObject({
      name: "WorkflowIntentCausationConflictError",
      code: "WORKFLOW_INTENT_CAUSATION_CONFLICT",
    });
    expect(String(conflict)).toBe("WorkflowIntentCausationConflictError: WorkflowIntent was already accepted for another planner run.");
    expect(String(conflict)).not.toMatch(/run-session|run-planner|intent-reused/);
    expect(reopened.listEvents("session-1")).toEqual(eventsBeforeConflict);
    expect(reopened.materializeFlowProjection("session-1")).toEqual(projectionBeforeConflict);
    reopened.close();
  });

  it("rolls back intent application when the accepted idempotency key is bound to another event", async () => {
    const store = await makeSeededStore();
    store.appendWorkflowEvent({
      sessionId: "session-1",
      kind: "workflow.intent.rejected",
      source: "test",
      idempotencyKey: "intent:intent-accepted-key-conflict:accepted",
      payload: { intentId: "another-intent", reason: "seeded idempotency conflict" },
      now: "2026-06-14T00:00:01.000Z",
    });
    const eventsBeforeConflict = store.listEvents("session-1");
    const projectionBeforeConflict = store.materializeFlowProjection("session-1");

    expect(() => store.applyWorkflowIntent({
      intentId: "intent-accepted-key-conflict",
      sessionId: "session-1",
      operations: [{ type: "AnalyzeRequirement", requirement: "Do not partially apply" }],
    }, "2026-06-14T00:00:02.000Z")).toThrow(/accepted idempotency key conflicts/i);
    expect(store.listEvents("session-1")).toEqual(eventsBeforeConflict);
    expect(store.materializeFlowProjection("session-1")).toEqual(projectionBeforeConflict);
    store.close();
  });

  it("keeps explicit non-planner intent application compatible without invented causation", async () => {
    const store = await makeSeededStore();
    store.applyWorkflowIntent({
      intentId: "intent-explicit-no-planner-cause",
      sessionId: "session-1",
      operations: [
        { type: "AnalyzeRequirement", requirement: "Preserve explicit applyIntent compatibility" },
        { type: "DiscoverProject", profile: { languages: ["typescript"], capabilities: ["code-change"] } },
        { type: "ProposeLanes" },
      ],
    }, "2026-06-14T00:00:01.000Z");

    const semanticFacts = store.listEvents("session-1").filter((event) =>
      event.kind === "workflow.intent.accepted" || event.kind === "workflow.lane.declared"
    );
    expect(semanticFacts.length).toBeGreaterThan(1);
    expect(semanticFacts.every((event) => event.causationId === null)).toBe(true);
    store.close();
  });

  it("rejects an unproven or sensitive planner intent causation before persistence", async () => {
    const store = await makeSeededStore();
    const eventCount = store.listEvents("session-1").length;
    const intent = {
      intentId: "intent-invalid-planner-cause",
      sessionId: "session-1",
      operations: [{ type: "AnalyzeRequirement", requirement: "Do not persist invalid causal metadata" }],
    };

    expect(() => store.applyWorkflowIntent({
      ...intent,
      causationId: "run-not-recorded",
    }, "2026-06-14T00:00:01.000Z")).toThrow(/terminal planner run/i);
    expect(() => store.applyWorkflowIntent({
      ...intent,
      causationId: "/Users/alice/private/planner-handle",
    }, "2026-06-14T00:00:01.000Z")).toThrow(/non-sensitive run identifier/i);
    expect(store.listEvents("session-1")).toHaveLength(eventCount);
    store.close();
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

  it("persists exact run authorization decisions across reopen", async () => {
    const projectRoot = await makeTempRoot();
    const authorization = {
      sandbox: "danger-full-access",
      runId: "run-session-1-lane-commit",
      startFingerprint: "a".repeat(64),
    };
    const store = createWorkflowStore({ projectRoot });
    seedStore(store);
    store.appendWorkflowEvent({
      sessionId: "session-1",
      kind: "workflow.user_decision.requested",
      source: "electron-main",
      idempotencyKey: "danger-run:requested",
      payload: {
        decisionId: "decision-danger-run",
        prompt: "Authorize full host access?",
        options: ["Authorize this run"],
        reason: "This run can modify host state outside the project.",
        targetLaneId: "lane-commit",
        targetSegmentId: "segment-session-1-lane-commit",
        runAuthorization: authorization,
      },
      now: "2026-07-23T00:00:00.000Z",
    });
    store.appendWorkflowEvent({
      sessionId: "session-1",
      kind: "workflow.user_decision.answered",
      source: "renderer",
      idempotencyKey: "danger-run:answered",
      payload: {
        decisionId: "decision-danger-run",
        selectedOption: "Authorize this run",
        action: "continue",
        targetLaneId: "lane-commit",
        targetSegmentId: "segment-session-1-lane-commit",
        runAuthorization: authorization,
      },
      now: "2026-07-23T00:00:01.000Z",
    });
    store.close();

    const reopened = createWorkflowStore({ projectRoot });
    const decision = reopened.materializeFlowProjection("session-1").userDecisions[0];
    const canvasDecision = reopened.materializeCanvasSession("session-1")?.nodes
      .find((node) => node.id === "decision-danger-run")?.userDecision;

    expect(decision).toMatchObject({ status: "answered", runAuthorization: authorization });
    expect(canvasDecision).toMatchObject({ status: "answered", runAuthorization: authorization });
    reopened.close();
  });

  it("fails closed for dangerous ready lanes until the backend authorizes them", async () => {
    const store = await makeSeededStore();
    for (const lane of [
      { id: "lane-implementation", kind: "implementation" },
      { id: "lane-commit", kind: "commit" },
    ]) {
      store.appendWorkflowEvent({
        sessionId: "session-1",
        kind: "workflow.lane.declared",
        source: "test",
        idempotencyKey: `lane:${lane.id}`,
        payload: {
          lane: {
            ...lane,
            semanticKey: lane.id,
            title: lane.id,
            agentKind: "codex",
            status: "pending",
          },
        },
        now: "2026-07-23T00:00:00.000Z",
      });
    }

    const unauthorized = store.scheduleReadyLanes("session-1", {
      allowedParallelism: 2,
      now: "2026-07-23T00:00:01.000Z",
    });

    expect(unauthorized.readyLanes.map((lane) => lane.id)).toEqual(["lane-implementation"]);
    expect(store.listRunningSegments().map((segment) => segment.laneId)).toEqual(["lane-implementation"]);

    const blockedAuthorized = store.scheduleReadyLanes("session-1", {
      allowedParallelism: 2,
      authorizedLaneIds: ["lane-commit"],
      now: "2026-07-23T00:00:02.000Z",
    });

    expect(blockedAuthorized.readyLanes).toEqual([]);
    expect(blockedAuthorized.projection.lanes.find((lane) => lane.id === "lane-commit")?.status).toBe("pending");
    expect(store.listRunningSegments().map((segment) => segment.laneId)).toEqual(["lane-implementation"]);

    store.recordRunResult(
      runResultInput(store, "lane-implementation", "succeeded", "2026-07-23T00:00:03.000Z"),
    );
    const authorized = store.scheduleReadyLanes("session-1", {
      allowedParallelism: 2,
      authorizedLaneIds: ["lane-commit"],
      now: "2026-07-23T00:00:04.000Z",
    });

    expect(authorized.readyLanes.map((lane) => lane.id)).toEqual(["lane-commit"]);
    expect(store.listRunningSegments().map((segment) => segment.laneId)).toEqual(["lane-commit"]);
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

  it("materializes a pending planner root before its first concrete segment", async () => {
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
    const projection = store.materializeFlowProjection("session-1");

    expect(projection.projectionNodes).toEqual([]);
    const pendingCanvasSession = store.materializeCanvasSession("session-1");
    expect(pendingCanvasSession?.nodes).toMatchObject([{
      id: "node-1",
      agent: "hermes",
      status: "pending",
    }]);
    expect(pendingCanvasSession?.nodes[0]).not.toHaveProperty("runId");

    store.claimPlannerRunStart({
      sessionId: session.id,
      laneId: session.plannerLaneId,
      runId: "run-session-1-initial-planner-turn",
      agentKind: "hermes",
      worktreePath: store.databasePath,
      now: "2026-06-14T00:00:01.000Z",
    });
    const canvasSession = store.materializeCanvasSession("session-1");

    expect(canvasSession?.plannerNodeId).toBe("node-1");
    expect(canvasSession?.nodes).toMatchObject([
      {
        id: "node-1",
        agent: "hermes",
        status: "running",
        runId: "run-session-1-initial-planner-turn",
      },
    ]);
  });

  it("advances the planner brief only when a durable user input is delivered, including reopen", async () => {
    const projectRoot = await makeTempRoot();
    const store = createWorkflowStore({ projectRoot });
    store.createWorkflowSession({
      id: "session-input-replay",
      projectId: "project-1",
      title: "Persisted workflow",
      goal: "Implement event sourced workflow",
      mode: "fast",
      plannerProfile: "default",
      transport: "hermes_replay_recovery",
      recoveryReason: "Hermes native resume is unavailable in this test.",
      now: "2026-07-21T00:00:00.000Z",
    });
    store.claimUserInput({
      sessionId: "session-input-replay",
      inputId: "input-1",
      text: "First durable planner requirement",
      now: "2026-07-21T00:00:01.000Z",
    });
    store.recordUserInputDelivered({
      sessionId: "session-input-replay",
      inputId: "input-1",
      now: "2026-07-21T00:00:02.000Z",
    });
    store.claimPlannerRunStart({
      sessionId: "session-input-replay",
      laneId: "node-1",
      runId: "run-first-delivered-input",
      agentKind: "hermes",
      worktreePath: projectRoot,
      now: "2026-07-21T00:00:03.000Z",
    });
    store.claimUserInput({
      sessionId: "session-input-replay",
      inputId: "input-2",
      text: "Second durable planner requirement",
      now: "2026-07-21T00:00:04.000Z",
    });

    const whileSecondPending = store.materializeCanvasSession("session-input-replay");
    const pendingPlanner = whileSecondPending?.nodes.find((node) => node.id === whileSecondPending.plannerNodeId);
    expect(whileSecondPending?.plannerNodeId).toBe("node-1");
    expect(whileSecondPending?.nodes.filter((node) => node.id === whileSecondPending.plannerNodeId)).toHaveLength(1);
    expect(pendingPlanner?.context.brief).toBe("First durable planner requirement");
    expect(pendingPlanner?.runId).toBe("run-first-delivered-input");
    expect(pendingPlanner?.context.dependencies).toEqual([]);
    expect(whileSecondPending?.edges.some((edge) => edge.target === whileSecondPending.plannerNodeId)).toBe(false);

    store.recordUserInputDelivered({
      sessionId: "session-input-replay",
      inputId: "input-2",
      now: "2026-07-21T00:00:05.000Z",
    });
    const afterDelivery = store.materializeCanvasSession("session-input-replay");
    expect(afterDelivery?.nodes.find((node) => node.id === afterDelivery.plannerNodeId)?.context.brief)
      .toBe("Second durable planner requirement");
    store.close();

    const reopened = createWorkflowStore({ projectRoot });
    expect(reopened.materializeCanvasSession("session-input-replay")).toEqual(afterDelivery);
    reopened.close();
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
    const seqs = store.listEvents("session-1").map((event) => event.seq);
    expect(seqs).toEqual(seqs.map((_seq, index) => index + 1));
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

  it("preserves exact canonical ancestry proof bytes through replay and reopen with zero writes", async () => {
    const projectRoot = await makeTempRoot();
    let store = createWorkflowStore({ projectRoot });
    const { afterInput, beforeHeadCommit } = prepareProofCheckpointRun(store, projectRoot);
    const proof = workflowGitAncestryProof(beforeHeadCommit, afterInput.headCommit);
    const input = { ...afterInput, ...proof, now: "2026-08-01T00:00:05.000Z" };

    const first = store.recordRunCheckpoint(input);
    const events = store.listEvents(input.sessionId);
    const proofEvent = events.find((event) => event.idempotencyKey === `checkpoint:${input.runId}:after`);
    expect(first.ancestryProof).toBe(proof.ancestryProof);
    expect(proofEvent?.payload.checkpoint).toMatchObject({ ancestryProof: proof.ancestryProof });
    expect(store.materializeFlowProjection(input.sessionId).checkpoints.at(-1)?.ancestryProof)
      .toBe(proof.ancestryProof);
    expect(store.listNodeCheckpoints({ sessionId: input.sessionId, runId: input.runId, phase: "after" })[0]?.ancestryProof)
      .toBe(proof.ancestryProof);

    const wrongContext = workflowGitAncestryProof(
      beforeHeadCommit,
      afterInput.headCommit,
      "3".repeat(64),
    ).ancestryProofContext;
    expect(() => store.recordRunCheckpoint({ ...input, ancestryProofContext: wrongContext }))
      .toThrow(/context mismatch/i);
    expect(() => store.recordRunCheckpoint({ ...input, ancestryProof: `${proof.ancestryProof} ` }))
      .toThrow(/canonical/i);
    expect(() => store.recordRunCheckpoint({ ...input, authority: "forged" } as typeof input))
      .toThrow(/authority|restricted/i);
    expect(store.listEvents(input.sessionId)).toEqual(events);
    expect(store.recordRunCheckpoint({ ...input, now: "2026-08-01T00:00:06.000Z" })).toEqual(first);
    expect(store.listEvents(input.sessionId)).toEqual(events);
    store.close();

    store = createWorkflowStore({ projectRoot });
    expect(store.listEvents(input.sessionId).find((event) => event.idempotencyKey === proofEvent?.idempotencyKey)
      ?.payload.checkpoint).toMatchObject({ ancestryProof: proof.ancestryProof });
    expect(store.materializeFlowProjection(input.sessionId).checkpoints.at(-1)?.ancestryProof)
      .toBe(proof.ancestryProof);
    expect(store.listNodeCheckpoints({ sessionId: input.sessionId, runId: input.runId, phase: "after" })[0]?.ancestryProof)
      .toBe(proof.ancestryProof);
    expect(store.recordRunCheckpoint({ ...input, now: "2026-08-01T00:00:07.000Z" })).toEqual(first);
    expect(store.listEvents(input.sessionId)).toEqual(events);
    store.close();
  });

  it.each(["current_branch", "new_worktree"] as const)(
    "atomically records and reopens strict %s commit completion facts",
    async (executionTarget) => {
      const projectRoot = await makeTempRoot();
      let store = createWorkflowStore({ projectRoot });
      const fixture = prepareCommitCompletionFactsRun(store, projectRoot, executionTarget);

      const recorded = store.recordCommitLaneCompletionFacts(fixture.input);
      const events = store.listEvents(fixture.identity.sessionId);

      expect(recorded).toMatchObject({
        ...fixture.identity,
        baselineHeadCommit: fixture.beforeHeadCommit,
        beforeCheckpoint: {
          phase: "before",
          headCommit: fixture.beforeHeadCommit,
          executionTarget,
        },
        afterCheckpoint: {
          phase: "after",
          headCommit: fixture.afterHeadCommit,
          worktreeState: "clean",
          ancestryProof: fixture.input.ancestryProof,
        },
        changesetEvidence: {
          evidenceId: `changeset-evidence:${fixture.identity.runId}:after`,
          changesetId: `changeset-${fixture.identity.laneId}`,
          source: "git",
          status: "available",
          files: ["src/index.ts"],
        },
      });
      expect(store.getCommitLaneCompletionFacts(fixture.identity)).toEqual(recorded);
      expect(events.filter((event) =>
        event.kind === "workflow.changeset.evidence_recorded" ||
        event.kind === "workflow.node.checkpoint_recorded"
      ).slice(-2).map((event) => event.kind)).toEqual([
        "workflow.changeset.evidence_recorded",
        "workflow.node.checkpoint_recorded",
      ]);
      store.close();

      store = createWorkflowStore({ projectRoot });
      expect(store.getCommitLaneCompletionFacts(fixture.identity)).toEqual(recorded);
      store.close();
    },
  );

  it("replays exact commit completion facts without adding events in process or after reopen", async () => {
    const projectRoot = await makeTempRoot();
    let store = createWorkflowStore({ projectRoot });
    const fixture = prepareCommitCompletionFactsRun(store, projectRoot, "current_branch");
    const recorded = store.recordCommitLaneCompletionFacts(fixture.input);
    const events = store.listEvents(fixture.identity.sessionId);

    expect(store.recordCommitLaneCompletionFacts({
      ...fixture.input,
      now: "2026-08-16T00:00:09.000Z",
    })).toEqual(recorded);
    expect(store.listEvents(fixture.identity.sessionId)).toEqual(events);
    store.close();

    store = createWorkflowStore({ projectRoot });
    expect(store.recordCommitLaneCompletionFacts({
      ...fixture.input,
      now: "2026-08-16T00:00:10.000Z",
    })).toEqual(recorded);
    expect(store.listEvents(fixture.identity.sessionId)).toEqual(events);
    store.close();
  });

  it.each([
    ["payload", (fixture: CommitCompletionFactsFixture) => ({
      ...fixture.input,
      branchName: "different-branch",
    })],
    ["identity", (fixture: CommitCompletionFactsFixture) => ({
      ...fixture.input,
      segmentId: "segment-conflict",
    })],
    ["proof", (fixture: CommitCompletionFactsFixture) => ({
      ...fixture.input,
      ...workflowGitAncestryProof(
        fixture.beforeHeadCommit,
        fixture.afterHeadCommit,
        "8".repeat(64),
        "9".repeat(64),
      ),
    })],
    ["changeset", (fixture: CommitCompletionFactsFixture) => ({
      ...fixture.input,
      changeset: {
        ...fixture.input.changeset,
        evidence: {
          ...fixture.input.changeset.evidence,
          fullPatchSha256: "6".repeat(64),
        },
      },
    })],
  ] as const)("rejects changed commit completion %s replay with zero writes", async (_label, mutate) => {
    const projectRoot = await makeTempRoot();
    const store = createWorkflowStore({ projectRoot });
    const fixture = prepareCommitCompletionFactsRun(store, projectRoot, "current_branch");
    store.recordCommitLaneCompletionFacts(fixture.input);
    const before = store.listEvents(fixture.identity.sessionId);

    expect(() => store.recordCommitLaneCompletionFacts(mutate(fixture))).toThrow(/commit.*facts|identity|conflict|branch/i);
    expect(store.listEvents(fixture.identity.sessionId)).toEqual(before);
    store.close();
  });

  it("rolls back both commit facts when the checkpoint append fails", async () => {
    const projectRoot = await makeTempRoot();
    let injectFailure = false;
    const store = createWorkflowStore({
      projectRoot,
      faultInjection: {
        afterCommitChangesetBeforeCheckpoint() {
          if (injectFailure) throw new Error("injected commit checkpoint failure");
        },
      },
    });
    const fixture = prepareCommitCompletionFactsRun(store, projectRoot, "current_branch");
    const before = store.listEvents(fixture.identity.sessionId);
    injectFailure = true;

    expect(() => store.recordCommitLaneCompletionFacts(fixture.input)).toThrow(/injected commit checkpoint failure/i);
    expect(store.listEvents(fixture.identity.sessionId)).toEqual(before);
    expect(store.getCommitLaneCompletionFacts(fixture.identity)).toBeNull();
    store.close();
  });

  it("fails closed on a reopened legacy successful commit terminal without completion facts", async () => {
    const projectRoot = await makeTempRoot();
    let store = createWorkflowStore({ projectRoot });
    const fixture = prepareCommitCompletionFactsRun(store, projectRoot, "current_branch");
    store.recordRunResult(runResultInput(
      store,
      fixture.identity.laneId,
      "succeeded",
      "2026-08-16T00:00:08.000Z",
    ));
    const storedEvents = store.listEvents(fixture.identity.sessionId);
    const rawTerminal = storedEvents.find((event) =>
      event.idempotencyKey === `segment:${fixture.identity.segmentId}:evidence`
    );
    expect(rawTerminal?.payload.evidence).toMatchObject({
      status: "passed",
      runEvidence: {
        runId: fixture.identity.runId,
        status: "succeeded",
        exitCode: 0,
      },
    });

    const assertFailedProjection = () => {
      const projection = store.materializeFlowProjection(fixture.identity.sessionId);
      const segment = projection.segments.find((candidate) => candidate.id === fixture.identity.segmentId);
      const lane = projection.lanes.find((candidate) => candidate.id === fixture.identity.laneId);
      const evidence = projection.evidence.find((candidate) =>
        candidate.segmentId === fixture.identity.segmentId &&
        candidate.runEvidence?.runId === fixture.identity.runId
      );
      expect(segment).toMatchObject({ status: "failed", exitCode: 0 });
      expect(lane?.status).toBe("failed");
      expect(evidence).toMatchObject({
        status: "failed",
        detail: "Authoritative Git commit verification failed.",
        runEvidence: {
          runId: fixture.identity.runId,
          status: "failed",
          exitCode: 0,
          changesetId: null,
          errorReason: "Authoritative Git commit verification failed.",
          cancelReason: null,
          checks: expect.arrayContaining([
            expect.objectContaining({
              kind: "git",
              name: "Authoritative Git commit",
              status: "failed",
            }),
          ]),
        },
      });
      expect(store.listPendingRunCheckpointEnrichments()).toEqual([]);
      expect(store.listPendingCandidateManifestFreezes()).toEqual([]);
      expect(store.scheduleReadyLanes(fixture.identity.sessionId, {
        allowedParallelism: 2,
        now: "2026-08-16T00:00:09.000Z",
      }).readyLanes).toEqual([]);
      expect(store.getCandidateManifest(fixture.identity)).toBeNull();
      expect(store.listEvents(fixture.identity.sessionId)).toEqual(storedEvents);
    };

    assertFailedProjection();
    store.close();

    store = createWorkflowStore({ projectRoot });
    assertFailedProjection();
    store.close();
  });

  it("rejects unexpected public commit fact fields before mutation", async () => {
    const projectRoot = await makeTempRoot();
    const store = createWorkflowStore({ projectRoot });
    const fixture = prepareCommitCompletionFactsRun(store, projectRoot, "current_branch");
    const before = store.listEvents(fixture.identity.sessionId);

    expect(() => store.recordCommitLaneCompletionFacts({
      ...fixture.input,
      prompt: "untrusted",
    } as typeof fixture.input)).toThrow(/commit.*facts.*only|unexpected/i);
    expect(store.listEvents(fixture.identity.sessionId)).toEqual(before);
    store.close();
  });

  it.each([
    "ordinary-lane",
    "wrong-segment-run",
    "no-before-checkpoint",
    "terminal-segment",
  ] as const)("rejects %s commit facts before mutation", async (failure) => {
    const projectRoot = await makeTempRoot();
    const store = createWorkflowStore({ projectRoot });
    const fixture = failure === "ordinary-lane"
      ? prepareExecutableCompletionFactsRun(store, projectRoot, "lane-implementation")
      : prepareCommitCompletionFactsRun(store, projectRoot, "current_branch", {
          recordBefore: failure !== "no-before-checkpoint",
        });
    if (failure === "terminal-segment") {
      store.recordRunResult(runResultInput(
        store,
        fixture.identity.laneId,
        "succeeded",
        "2026-08-16T00:00:08.000Z",
      ));
    }
    const input = failure === "wrong-segment-run"
      ? { ...fixture.input, segmentId: "segment-wrong", runId: "run-wrong" }
      : fixture.input;
    const before = store.listEvents(fixture.identity.sessionId);

    expect(() => store.recordCommitLaneCompletionFacts(input)).toThrow(/commit|segment|before checkpoint|running/i);
    expect(store.listEvents(fixture.identity.sessionId)).toEqual(before);
    store.close();
  });

  it("freezes one immutable backend-only candidate manifest and replays it with zero writes", async () => {
    const projectRoot = await makeTempRoot();
    let store = createWorkflowStore({ projectRoot });
    const identity = prepareCandidateManifestRun(store, projectRoot);
    const projectionBefore = store.materializeFlowProjection(identity.sessionId);
    expect(store.listPendingCandidateManifestFreezes()).toEqual([identity]);

    const manifest = store.freezeCandidateManifest({
      ...identity,
      now: "2026-08-11T00:00:06.000Z",
    });
    const eventsAfterFreeze = store.listEvents(identity.sessionId);
    const replayed = store.freezeCandidateManifest({
      ...identity,
      now: "2026-08-11T00:00:07.000Z",
    });

    expect(replayed).toEqual(manifest);
    expect(store.getCandidateManifest(identity)).toEqual(manifest);
    expect(store.listEvents(identity.sessionId)).toEqual(eventsAfterFreeze);
    expect(store.materializeFlowProjection(identity.sessionId)).toEqual(projectionBefore);
    expect(store.listPendingCandidateManifestFreezes()).toEqual([]);
    expect(manifest).toMatchObject({
      version: 1,
      createdAt: "2026-08-11T00:00:06.000Z",
      ...identity,
      agentKind: "codex",
      executionTarget: "current_branch",
      worktreeId: null,
      repositoryIdentity: "1".repeat(64),
      worktreeIdentity: "2".repeat(64),
      beforeHeadCommit: "a".repeat(40),
      afterHeadCommit: "b".repeat(40),
      terminalEvidenceId: `evidence-${identity.segmentId}`,
      changesetEvidenceId: `changeset-evidence:${identity.runId}:after`,
      changesetId: `changeset-${identity.laneId}`,
      fullPatchSha256: "4".repeat(64),
      fullPatchByteLength: 128,
      fileManifestSha256: "5".repeat(64),
    });

    const manifestEvent = eventsAfterFreeze.find((event) => event.kind === "workflow.candidate.manifest_recorded");
    expect(manifestEvent).toMatchObject({
      source: "workflow_store",
      laneId: identity.laneId,
      segmentId: identity.segmentId,
      payload: { manifest },
    });
    const db = new Database(store.databasePath, { readonly: true });
    const row = db.prepare("SELECT payload_json FROM workflow_events WHERE id = ?")
      .get(manifestEvent?.id) as { payload_json: string };
    db.close();
    expect(row.payload_json).not.toContain(projectRoot);
    expect(row.payload_json).not.toMatch(/worktreePath|patchPreview|files|prompt|output/);
    store.close();

    store = createWorkflowStore({ projectRoot });
    expect(store.getCandidateManifest(identity)).toEqual(manifest);
    expect(store.freezeCandidateManifest({ ...identity, now: "2026-08-11T00:00:08.000Z" })).toEqual(manifest);
    expect(store.listEvents(identity.sessionId)).toEqual(eventsAfterFreeze);
    store.close();
  });

  it("freezes a pathless terminal evidence binding while hashing exact artifact and prose-bearing evidence", async () => {
    const projectRoot = await makeTempRoot();
    const store = createWorkflowStore({ projectRoot });
    const checks: RunEvidence["checks"] = [
      {
        kind: "test",
        name: "test worktree/src/private-file.ts prompt transcript",
        status: "passed",
        detail: "raw prompt and agent output preview from src/private-file.ts",
      },
      { kind: "build", name: "private-file build", status: "skipped" },
    ];
    const artifacts = [".devflow/acceptance/private-file-output.png"];
    const review: NonNullable<RunEvidence["review"]> = {
      kind: "review",
      name: "review prompt transcript",
      status: "passed",
      detail: "agent prose output for private-file.ts",
    };
    const identity = prepareCandidateManifestRun(store, projectRoot, {
      terminalEvidence: { checks, artifacts, review },
    });
    const authoritativeRunEvidence: RunEvidence = {
      runId: identity.runId,
      status: "succeeded",
      exitCode: 0,
      changesetId: `changeset-${identity.laneId}`,
      checks,
      artifacts,
      review,
      errorReason: null,
      cancelReason: null,
      completedAt: "2026-08-11T00:00:04.000Z",
    };

    const manifest = store.freezeCandidateManifest({
      ...identity,
      now: "2026-08-11T00:00:06.000Z",
    });

    expect(manifest.terminalRunEvidence).toEqual({
      runId: identity.runId,
      status: "succeeded",
      exitCode: 0,
      changesetId: `changeset-${identity.laneId}`,
      checks: [
        { kind: "test", status: "passed" },
        { kind: "build", status: "skipped" },
      ],
      artifactCount: 1,
      review: { kind: "review", status: "passed" },
      errorReason: null,
      cancelReason: null,
      completedAt: "2026-08-11T00:00:04.000Z",
    });
    expect(manifest.terminalRunEvidenceSha256).toBe(
      createHash("sha256").update(canonicalJson(authoritativeRunEvidence), "utf8").digest("hex"),
    );

    const manifestEvent = store.listEvents(identity.sessionId)
      .find((event) => event.kind === "workflow.candidate.manifest_recorded");
    const db = new Database(store.databasePath, { readonly: true });
    const row = db.prepare("SELECT payload_json FROM workflow_events WHERE id = ?")
      .get(manifestEvent?.id) as { payload_json: string };
    db.close();
    expect(JSON.parse(row.payload_json)).toEqual({ manifest });
    for (const sensitive of [
      projectRoot,
      checks[0]!.name,
      checks[0]!.detail!,
      checks[1]!.name,
      artifacts[0]!,
      review.name,
      review.detail!,
      "private-file.ts",
      "private-file-output.png",
    ]) {
      expect(JSON.stringify(manifest)).not.toContain(sensitive);
      expect(row.payload_json).not.toContain(sensitive);
    }
    expect(row.payload_json).toContain('"artifactCount":1');
    expect(row.payload_json).toContain('"terminalRunEvidenceSha256"');
    store.close();
  });

  it("rejects an extra raw terminal RunEvidence field with zero writes", async () => {
    const projectRoot = await makeTempRoot();
    const store = createWorkflowStore({ projectRoot });
    const identity = prepareCandidateManifestRun(store, projectRoot);
    const db = new Database(store.databasePath);
    const row = db.prepare("SELECT id, payload_json FROM workflow_events WHERE session_id = ? AND idempotency_key = ?")
      .get(identity.sessionId, `segment:${identity.segmentId}:evidence`) as { id: string; payload_json: string };
    const payload = JSON.parse(row.payload_json) as {
      evidence: { runEvidence: Record<string, unknown> };
    };
    payload.evidence.runEvidence.compatibilitySource = "legacy-disk";
    db.prepare("UPDATE workflow_events SET payload_json = ? WHERE id = ?").run(JSON.stringify(payload), row.id);
    db.close();
    const before = store.listEvents(identity.sessionId);

    expect(() => store.freezeCandidateManifest({
      ...identity,
      now: "2026-08-11T00:00:06.000Z",
    })).toThrow(/candidate manifest.*RunEvidence|current.*RunEvidence/i);
    expect(store.getCandidateManifest(identity)).toBeNull();
    expect(store.listEvents(identity.sessionId)).toEqual(before);
    store.close();
  });

  it("rejects a path-like changeset identity with zero writes", async () => {
    const projectRoot = await makeTempRoot();
    const store = createWorkflowStore({ projectRoot });
    const identity = prepareCandidateManifestRun(store, projectRoot, {
      changesetId: "src/private.ts",
    });
    const before = store.listEvents(identity.sessionId);

    expect(() => store.freezeCandidateManifest({
      ...identity,
      now: "2026-08-11T00:00:06.000Z",
    })).toThrow(/candidate manifest.*RunEvidence|changeset id/i);
    expect(store.getCandidateManifest(identity)).toBeNull();
    expect(store.listEvents(identity.sessionId)).toEqual(before);
    store.close();
  });

  it("rejects a checkpoint with the same run scope and a conflicting node id with zero writes", async () => {
    const projectRoot = await makeTempRoot();
    const store = createWorkflowStore({ projectRoot });
    const identity = prepareCandidateManifestRun(store, projectRoot);
    insertRawCheckpointEvents(store.databasePath, [rawCheckpoint({
      id: `checkpoint:${identity.runId}:after-conflicting-node`,
      sessionId: identity.sessionId,
      nodeId: "lane-conflicting-node",
      laneId: identity.laneId,
      segmentId: identity.segmentId,
      runId: identity.runId,
      phase: "after",
      executionTarget: "current_branch",
      worktreePath: projectRoot,
      branchName: "HEAD",
      headCommit: "b".repeat(40),
      createdAt: "2026-08-11T00:00:05.750Z",
      evidenceRefs: [{ kind: "run", id: identity.runId }],
    })]);
    const before = store.listEvents(identity.sessionId);

    expect(() => store.freezeCandidateManifest({
      ...identity,
      now: "2026-08-11T00:00:06.000Z",
    })).toThrow(/candidate manifest.*checkpoint/i);
    expect(store.getCandidateManifest(identity)).toBeNull();
    expect(store.listEvents(identity.sessionId)).toEqual(before);
    store.close();
  });

  it.each([
    {
      kind: "workflow.candidate.manifest_recorded",
      idempotencyKey: "candidate-manifest:run-forged",
      payload: { manifest: { version: 1 } },
    },
    {
      kind: "workflow.commit.publication_prepared",
      idempotencyKey: "delivery-commit-prepared:lane-forged:segment-forged",
      payload: {
        laneId: "lane-forged",
        candidateLaneId: "lane-candidate-forged",
        segmentId: "segment-forged",
        manifestSha256: "a".repeat(64),
        requestSha256: "b".repeat(64),
        preparation: {},
      },
    },
    {
      kind: "workflow.candidate.review_allowed",
      idempotencyKey: "candidate-review-allowed:run-forged",
      payload: {
        sessionId: "session-1",
        nodeId: "node-forged",
        laneId: "lane-forged",
        segmentId: "segment-forged",
        runId: "run-forged",
        manifestSha256: "a".repeat(64),
        decision: {
          version: 1,
          requestSha256: "b".repeat(64),
          manifestSha256: "a".repeat(64),
          disposition: "allow",
        },
      },
    },
  ])("rejects generic $kind forgery before idempotency", async ({ kind, idempotencyKey, payload }) => {
    const projectRoot = await makeTempRoot();
    const store = createWorkflowStore({ projectRoot });
    seedStore(store);
    const input = {
      sessionId: "session-1",
      kind: kind as never,
      source: "backend",
      idempotencyKey,
      payload,
      now: "2026-08-11T00:00:00.000Z",
    };

    expect(() => store.appendWorkflowEvent(input)).toThrow(/internal|forg/i);
    expect(store.listEvents("session-1").some((event) => event.kind === input.kind)).toBe(false);
    store.close();
  });

  it("rejects conflicting or noncanonical prepared publication input before writing", async () => {
    const projectRoot = await makeTempRoot();
    const store = createWorkflowStore({ projectRoot });
    const fixture = preparedPublicationFixture(store, projectRoot);
    const api = store as unknown as {
      appendPreparedCandidatePublication(input: unknown): unknown;
    };
    if (typeof api.appendPreparedCandidatePublication !== "function") {
      store.close();
      return;
    }
    appendAllowedCandidateReview(store, fixture);
    api.appendPreparedCandidatePublication(fixture.input);
    const events = store.listEvents(fixture.identity.sessionId);
    const { reviewRequestSha256: _reviewRequestSha256, ...missingReviewRequestSha256 } = fixture.input;

    for (const invalid of [
      { ...fixture.input, requestSha256: "c".repeat(64) },
      { ...fixture.input, reviewRequestSha256: fixture.otherReviewRequestSha256 },
      { ...fixture.input, reviewRequestSha256: "A".repeat(64) },
      missingReviewRequestSha256,
      { ...fixture.input, candidateLaneId: fixture.publicationLaneId },
      { ...fixture.input, candidateLaneId: " lane-implementation" },
      { ...fixture.input, manifestSha256: "A".repeat(64) },
      { ...fixture.input, preparation: { ...fixture.preparation, commitSha: "2".repeat(39) } },
      { ...fixture.input, preparation: { ...fixture.preparation, branch: "forged" } },
      {
        ...fixture.input,
        preparation: {
          ...fixture.preparation,
          expected: { ...fixture.preparation.expected, fullPatchSha256: "9".repeat(64) },
        },
      },
      { ...fixture.input, worktreePath: "/private/source" },
    ]) {
      expect(() => api.appendPreparedCandidatePublication(invalid)).toThrow();
      expect(store.listEvents(fixture.identity.sessionId)).toEqual(events);
    }
    store.close();
  });

  it.each([
    ["a missing candidate lane identity", (payload: Record<string, unknown>) => {
      delete payload.candidateLaneId;
    }],
    ["a candidate lane identity matching the publication lane", (payload: Record<string, unknown>) => {
      payload.candidateLaneId = payload.laneId;
    }],
    ["a forged candidate lane identity", (payload: Record<string, unknown>) => {
      payload.candidateLaneId = "lane-forged-candidate";
    }],
    ["an extra sensitive field", (payload: Record<string, unknown>) => {
      payload.worktreePath = "/private/source";
    }],
    ["a forged manifest digest", (payload: Record<string, unknown>) => {
      payload.manifestSha256 = "9".repeat(64);
    }],
    ["a malformed review request digest", (payload: Record<string, unknown>) => {
      payload.reviewRequestSha256 = "A".repeat(64);
    }],
    ["a malformed preparation SHA", (payload: Record<string, unknown>) => {
      (payload.preparation as Record<string, unknown>).commitSha = "A".repeat(40);
    }],
    ["an expectation mismatch", (payload: Record<string, unknown>) => {
      const preparation = payload.preparation as { expected: Record<string, unknown> };
      preparation.expected.fileManifestSha256 = "9".repeat(64);
    }],
  ])("fails store reopen closed for prepared publication with %s", async (_label, mutate) => {
    const projectRoot = await makeTempRoot();
    const store = createWorkflowStore({ projectRoot });
    const fixture = preparedPublicationFixture(store, projectRoot);
    const api = store as unknown as {
      appendPreparedCandidatePublication(input: unknown): unknown;
    };
    if (typeof api.appendPreparedCandidatePublication !== "function") {
      store.close();
      return;
    }
    appendAllowedCandidateReview(store, fixture);
    const event = api.appendPreparedCandidatePublication(fixture.input) as { id: string };
    store.close();

    const db = new Database(join(projectRoot, ".devflow", "skyturn-workflow.sqlite"));
    const row = db.prepare("SELECT payload_json FROM workflow_events WHERE id = ?")
      .get(event.id) as { payload_json: string };
    const payload = JSON.parse(row.payload_json) as Record<string, unknown>;
    mutate(payload);
    db.prepare("UPDATE workflow_events SET payload_json = ? WHERE id = ?")
      .run(JSON.stringify(payload), event.id);
    db.close();

    expect(() => createWorkflowStore({ projectRoot })).toThrow(
      /prepared publication|candidate publication|candidate manifest/i,
    );
  });

  it("freezes authoritative changeset evidence when succeeded RunEvidence has a null changeset id", async () => {
    const projectRoot = await makeTempRoot();
    const store = createWorkflowStore({ projectRoot });
    const identity = prepareCandidateManifestRun(store, projectRoot, { nullRunChangesetId: true });

    const manifest = store.freezeCandidateManifest({
      ...identity,
      now: "2026-08-11T00:00:06.000Z",
    });

    expect(manifest.terminalRunEvidence.changesetId).toBeNull();
    expect(manifest.changesetId).toBe(`changeset-${identity.laneId}`);
    store.close();
  });

  it.each([
    "legacy",
    "digestless",
    "failed",
    "missing-proof",
    "wrong-header-source",
    "duplicate-changeset",
  ] as const)(
    "fails candidate manifest freeze closed for %s authoritative facts",
    async (failure) => {
      const projectRoot = await makeTempRoot();
      const store = createWorkflowStore({ projectRoot });
      const identity = prepareCandidateManifestRun(store, projectRoot, {
        status: failure === "failed" ? "failed" : "succeeded",
        digestless: failure === "digestless",
        includeProof: failure !== "missing-proof",
      });
      if (failure === "legacy") {
        const db = new Database(store.databasePath);
        db.prepare("UPDATE workflow_events SET legacy_evidence_compatibility = 1 WHERE session_id = ? AND idempotency_key = ?")
          .run(identity.sessionId, `segment:${identity.segmentId}:evidence`);
        db.close();
      }
      if (failure === "wrong-header-source") {
        const db = new Database(store.databasePath);
        db.prepare("UPDATE workflow_events SET source = 'git' WHERE session_id = ? AND idempotency_key = ?")
          .run(identity.sessionId, `checkpoint-changeset:${identity.runId}:after`);
        db.close();
      }
      if (failure === "duplicate-changeset") {
        const db = new Database(store.databasePath);
        const row = db.prepare([
          "SELECT kind, source, lane_id, segment_id, payload_json, created_at",
          "FROM workflow_events WHERE session_id = ? AND idempotency_key = ?",
        ].join(" ")).get(
          identity.sessionId,
          `checkpoint-changeset:${identity.runId}:after`,
        ) as {
          kind: string;
          source: string;
          lane_id: string;
          segment_id: string;
          payload_json: string;
          created_at: string;
        };
        const maxSeq = (db.prepare("SELECT max(seq) AS seq FROM workflow_events WHERE session_id = ?")
          .get(identity.sessionId) as { seq: number }).seq;
        db.prepare([
          "INSERT INTO workflow_events(",
          "id, session_id, seq, kind, source, lane_id, segment_id, idempotency_key, payload_json, created_at",
          ") VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
        ].join(" ")).run(
          `${identity.sessionId}:event:duplicate-changeset`,
          identity.sessionId,
          maxSeq + 1,
          row.kind,
          row.source,
          row.lane_id,
          row.segment_id,
          `duplicate-checkpoint-changeset:${identity.runId}:after`,
          row.payload_json,
          row.created_at,
        );
        db.close();
      }
      const before = store.listEvents(identity.sessionId);

      expect(() => store.freezeCandidateManifest({
        ...identity,
        now: "2026-08-11T00:00:06.000Z",
      })).toThrow(/candidate manifest|current|succeeded|digest|proof/i);
      expect(store.getCandidateManifest(identity)).toBeNull();
      expect(store.listEvents(identity.sessionId)).toEqual(before);
      store.close();
    },
  );

  it.each([
    ["legacy changeset evidence", undefined],
    ["wrong baseline", "c".repeat(40)],
    ["noncanonical baseline", "A".repeat(40)],
  ] as const)(
    "rejects %s without writing a candidate manifest and stays fail closed after reopen",
    async (_failure, baselineHeadCommit) => {
      const projectRoot = await makeTempRoot();
      let store = createWorkflowStore({ projectRoot });
      const identity = prepareCandidateManifestRun(store, projectRoot);
      rewriteChangesetBaseline(store.databasePath, identity, baselineHeadCommit);
      const before = store.listEvents(identity.sessionId);

      expect(() => store.freezeCandidateManifest({
        ...identity,
        now: "2026-08-11T00:00:06.000Z",
      })).toThrow(/candidate manifest.*baseline|before.*head/i);
      expect(store.getCandidateManifest(identity)).toBeNull();
      expect(store.listPendingCandidateManifestFreezes()).toEqual([]);
      expect(store.listEvents(identity.sessionId)).toEqual(before);
      store.close();

      store = createWorkflowStore({ projectRoot });
      const reopenedBefore = store.listEvents(identity.sessionId);
      expect(() => store.freezeCandidateManifest({
        ...identity,
        now: "2026-08-11T00:00:07.000Z",
      })).toThrow(/candidate manifest.*baseline|before.*head/i);
      expect(store.listEvents(identity.sessionId)).toEqual(reopenedBefore);
      store.close();
    },
  );

  it("rejects a duplicate matching before checkpoint before manifest mutation", async () => {
    const projectRoot = await makeTempRoot();
    const store = createWorkflowStore({ projectRoot });
    const identity = prepareCandidateManifestRun(store, projectRoot);
    insertRawCheckpointEvents(store.databasePath, [rawCheckpoint({
      id: `checkpoint:${identity.runId}:before-duplicate`,
      sessionId: identity.sessionId,
      nodeId: identity.nodeId,
      laneId: identity.laneId,
      segmentId: identity.segmentId,
      runId: identity.runId,
      phase: "before",
      executionTarget: "current_branch",
      worktreePath: projectRoot,
      branchName: "HEAD",
      headCommit: "a".repeat(40),
      createdAt: "2026-08-11T00:00:03.250Z",
      evidenceRefs: [{ kind: "run", id: identity.runId }],
    })]);
    const db = new Database(store.databasePath, { readonly: true });
    const countBefore = (db.prepare("SELECT count(*) AS count FROM workflow_events WHERE session_id = ?")
      .get(identity.sessionId) as { count: number }).count;
    db.close();

    expect(() => store.freezeCandidateManifest({
      ...identity,
      now: "2026-08-11T00:00:06.000Z",
    })).toThrow(/candidate manifest.*checkpoint|unique.*before|proof-bearing.*before/i);
    expect(store.getCandidateManifest(identity)).toBeNull();
    store.close();

    const reopenedDb = new Database(join(projectRoot, ".devflow", "skyturn-workflow.sqlite"), { readonly: true });
    expect((reopenedDb.prepare("SELECT count(*) AS count FROM workflow_events WHERE session_id = ?")
      .get(identity.sessionId) as { count: number }).count).toBe(countBefore);
    reopenedDb.close();
  });

  it("conflicts with zero writes when authoritative digest facts change after freeze", async () => {
    const projectRoot = await makeTempRoot();
    const store = createWorkflowStore({ projectRoot });
    const identity = prepareCandidateManifestRun(store, projectRoot);
    store.freezeCandidateManifest({ ...identity, now: "2026-08-11T00:00:06.000Z" });
    store.close();

    const db = new Database(join(projectRoot, ".devflow", "skyturn-workflow.sqlite"));
    const row = db.prepare("SELECT id, payload_json FROM workflow_events WHERE session_id = ? AND idempotency_key = ?")
      .get(identity.sessionId, `checkpoint-changeset:${identity.runId}:after`) as { id: string; payload_json: string };
    const payload = JSON.parse(row.payload_json) as { evidence: { fullPatchSha256: string } };
    payload.evidence.fullPatchSha256 = "6".repeat(64);
    db.prepare("UPDATE workflow_events SET payload_json = ? WHERE id = ?").run(JSON.stringify(payload), row.id);
    const countBefore = (db.prepare("SELECT count(*) AS count FROM workflow_events WHERE session_id = ?")
      .get(identity.sessionId) as { count: number }).count;
    db.close();

    expect(() => createWorkflowStore({ projectRoot })).toThrow(/candidate manifest.*conflict/i);
    const reopenedDb = new Database(join(projectRoot, ".devflow", "skyturn-workflow.sqlite"), { readonly: true });
    expect((reopenedDb.prepare("SELECT count(*) AS count FROM workflow_events WHERE session_id = ?")
      .get(identity.sessionId) as { count: number }).count).toBe(countBefore);
    reopenedDb.close();
  });

  it("fails reopen closed when a frozen manifest's changeset baseline binding changes", async () => {
    const projectRoot = await makeTempRoot();
    const store = createWorkflowStore({ projectRoot });
    const identity = prepareCandidateManifestRun(store, projectRoot);
    store.freezeCandidateManifest({ ...identity, now: "2026-08-11T00:00:06.000Z" });
    store.close();
    rewriteChangesetBaseline(
      join(projectRoot, ".devflow", "skyturn-workflow.sqlite"),
      identity,
      "c".repeat(40),
    );
    const db = new Database(join(projectRoot, ".devflow", "skyturn-workflow.sqlite"), { readonly: true });
    const countBefore = (db.prepare("SELECT count(*) AS count FROM workflow_events WHERE session_id = ?")
      .get(identity.sessionId) as { count: number }).count;
    db.close();

    expect(() => createWorkflowStore({ projectRoot })).toThrow(/candidate manifest.*baseline|before.*head/i);
    const reopenedDb = new Database(join(projectRoot, ".devflow", "skyturn-workflow.sqlite"), { readonly: true });
    expect((reopenedDb.prepare("SELECT count(*) AS count FROM workflow_events WHERE session_id = ?")
      .get(identity.sessionId) as { count: number }).count).toBe(countBefore);
    reopenedDb.close();
  });

  it("rejects a structurally valid persisted manifest that conflicts with authoritative facts", async () => {
    const projectRoot = await makeTempRoot();
    const store = createWorkflowStore({ projectRoot });
    const identity = prepareCandidateManifestRun(store, projectRoot);
    store.freezeCandidateManifest({ ...identity, now: "2026-08-11T00:00:06.000Z" });
    const manifestEvent = store.listEvents(identity.sessionId)
      .find((event) => event.kind === "workflow.candidate.manifest_recorded");

    const db = new Database(join(projectRoot, ".devflow", "skyturn-workflow.sqlite"));
    const row = db.prepare("SELECT payload_json FROM workflow_events WHERE id = ?")
      .get(manifestEvent?.id) as { payload_json: string };
    const payload = JSON.parse(row.payload_json) as { manifest: { agentKind: string } };
    payload.manifest.agentKind = "gemini";
    db.prepare("UPDATE workflow_events SET payload_json = ? WHERE id = ?")
      .run(JSON.stringify(payload), manifestEvent?.id);
    const countBefore = (db.prepare("SELECT count(*) AS count FROM workflow_events WHERE session_id = ?")
      .get(identity.sessionId) as { count: number }).count;
    db.close();

    expect(() => store.getCandidateManifest(identity)).toThrow(/candidate manifest.*conflict/i);
    expect(() => store.listPendingCandidateManifestFreezes()).toThrow(/candidate manifest.*conflict/i);
    store.close();
    expect(() => createWorkflowStore({ projectRoot })).toThrow(/candidate manifest.*conflict/i);

    const reopenedDb = new Database(join(projectRoot, ".devflow", "skyturn-workflow.sqlite"), { readonly: true });
    expect((reopenedDb.prepare("SELECT count(*) AS count FROM workflow_events WHERE session_id = ?")
      .get(identity.sessionId) as { count: number }).count).toBe(countBefore);
    reopenedDb.close();
  });

  it("rejects proof or context on before checkpoints and incomplete after proof inputs before mutation", async () => {
    const projectRoot = await makeTempRoot();
    const store = createWorkflowStore({ projectRoot });
    const { afterInput, beforeHeadCommit } = prepareProofCheckpointRun(store, projectRoot);
    const proof = workflowGitAncestryProof(beforeHeadCommit, afterInput.headCommit);
    const beforeInput = {
      ...afterInput,
      phase: "before" as const,
      headCommit: beforeHeadCommit,
      now: "2026-08-01T00:00:03.000Z",
    };
    const events = store.listEvents(afterInput.sessionId);

    expect(() => store.recordRunCheckpoint({ ...beforeInput, ...proof })).toThrow(/before.*proof|proof.*before/i);
    expect(() => store.recordRunCheckpoint({ ...beforeInput, ancestryProof: proof.ancestryProof })).toThrow(/before.*proof|proof.*before/i);
    expect(() => store.recordRunCheckpoint({ ...beforeInput, ancestryProofContext: proof.ancestryProofContext })).toThrow(/before.*context|context.*before/i);
    expect(() => store.recordRunCheckpoint({ ...afterInput, ancestryProof: proof.ancestryProof })).toThrow(/both.*proof.*context|proof.*context/i);
    expect(() => store.recordRunCheckpoint({ ...afterInput, ancestryProofContext: proof.ancestryProofContext })).toThrow(/both.*proof.*context|proof.*context/i);
    expect(store.listEvents(afterInput.sessionId)).toEqual(events);
    store.close();
  });

  it.each([
    "object proof",
    "malformed proof",
    "noncanonical proof",
    "tampered proof",
    "wrong branded repository context",
    "wrong branded worktree context",
    "before commit mismatch",
    "after commit mismatch",
  ] as const)("rejects %s before checkpoint mutation", async (failure) => {
    const projectRoot = await makeTempRoot();
    const store = createWorkflowStore({ projectRoot });
    const { afterInput, beforeHeadCommit } = prepareProofCheckpointRun(store, projectRoot);
    const valid = workflowGitAncestryProof(beforeHeadCommit, afterInput.headCommit);
    let ancestryProof: unknown = valid.ancestryProof;
    let ancestryProofContext: WorkflowGitAncestryProofContext = valid.ancestryProofContext;

    if (failure === "object proof") ancestryProof = JSON.parse(valid.ancestryProof);
    if (failure === "malformed proof") ancestryProof = "{";
    if (failure === "noncanonical proof") ancestryProof = valid.ancestryProof.replace("{", "{ ");
    if (failure === "tampered proof") ancestryProof = valid.ancestryProof.replace(beforeHeadCommit, "c".repeat(40));
    if (failure === "wrong branded repository context") {
      ancestryProofContext = workflowGitAncestryProof(
        beforeHeadCommit,
        afterInput.headCommit,
        "3".repeat(64),
      ).ancestryProofContext;
    }
    if (failure === "wrong branded worktree context") {
      ancestryProofContext = workflowGitAncestryProof(
        beforeHeadCommit,
        afterInput.headCommit,
        "1".repeat(64),
        "4".repeat(64),
      ).ancestryProofContext;
    }
    if (failure === "before commit mismatch") {
      ({ ancestryProof, ancestryProofContext } = workflowGitAncestryProof("c".repeat(40), afterInput.headCommit));
    }
    if (failure === "after commit mismatch") {
      ({ ancestryProof, ancestryProofContext } = workflowGitAncestryProof(beforeHeadCommit, "c".repeat(40)));
    }
    const events = store.listEvents(afterInput.sessionId);

    expect(() => store.recordRunCheckpoint({
      ...afterInput,
      ancestryProof: ancestryProof as string,
      ancestryProofContext,
    })).toThrow(/proof|commit|context|serialized|string/i);
    expect(store.listEvents(afterInput.sessionId)).toEqual(events);
    store.close();
  });

  it("rejects proof, context, and authority spellings from generic checkpoint append before idempotency", async () => {
    const projectRoot = await makeTempRoot();
    let store = createWorkflowStore({ projectRoot });
    seedStore(store);
    const checkpoint = rawCheckpoint({
      id: "checkpoint-generic-legacy",
      runId: "run-generic-legacy",
      segmentId: "segment-generic-legacy",
      phase: "before",
      headCommit: "a".repeat(40),
      worktreePath: projectRoot,
    });
    const input = {
      sessionId: "session-1",
      kind: "workflow.node.checkpoint_recorded" as const,
      source: "test" as const,
      idempotencyKey: "checkpoint:generic-legacy",
      payload: { checkpoint },
      now: "2026-08-01T00:00:01.000Z",
    };
    const legacy = store.appendWorkflowEvent(input);
    const events = store.listEvents(input.sessionId);
    const projection = store.materializeFlowProjection(input.sessionId);
    const canonicalProof = workflowGitAncestryProof("a".repeat(40), "b".repeat(40)).ancestryProof;
    const reservedFields = [
      "ancestryProof",
      "ancestry_proof",
      "Ancestry-Proof",
      "ancestryProofContext",
      "workflow_git_ancestry_proof_context",
      "proofContext",
      "authority",
      "AUTHORITY",
      "_authority",
      "checkpointAuthority",
      "checkpoint_authority",
      "proofAuthority",
      "proof-authority",
    ];

    for (const field of reservedFields) {
      const value = field.toLowerCase().includes("ancestry") && !field.toLowerCase().includes("context")
        ? canonicalProof
        : "forged";
      expect(() => store.appendWorkflowEvent({
        ...input,
        payload: { ...input.payload, [field]: value },
      }), `payload.${field}`).toThrow(/checkpoint.*restricted|proof|context|authority/i);
      expect(() => store.appendWorkflowEvent({
        ...input,
        payload: { checkpoint: { ...checkpoint, [field]: value } },
      }), `payload.checkpoint.${field}`).toThrow(/checkpoint.*restricted|proof|context|authority/i);
    }
    expect(store.listEvents(input.sessionId)).toEqual(events);
    expect(store.materializeFlowProjection(input.sessionId)).toEqual(projection);
    expect(store.listNodeCheckpoints({ sessionId: input.sessionId })).toContainEqual(
      expect.objectContaining({ id: checkpoint.id }),
    );
    store.close();

    store = createWorkflowStore({ projectRoot });
    expect(store.listEvents(input.sessionId)).toContainEqual(legacy);
    expect(store.listNodeCheckpoints({ sessionId: input.sessionId })[0]).not.toHaveProperty("ancestryProof");
    store.close();
  });

  it("fails every checkpoint read path before returning directly tampered proof bytes", async () => {
    const projectRoot = await makeTempRoot();
    let store = createWorkflowStore({ projectRoot });
    const { afterInput, beforeHeadCommit } = prepareProofCheckpointRun(store, projectRoot);
    const proof = workflowGitAncestryProof(beforeHeadCommit, afterInput.headCommit);
    store.recordRunCheckpoint({ ...afterInput, ...proof });
    store.close();

    const db = new Database(join(projectRoot, ".devflow", "skyturn-workflow.sqlite"));
    const row = db.prepare("SELECT payload_json FROM workflow_events WHERE session_id = ? AND idempotency_key = ?")
      .get(afterInput.sessionId, `checkpoint:${afterInput.runId}:after`) as { payload_json: string };
    const payload = JSON.parse(row.payload_json) as { checkpoint: Record<string, unknown> };
    payload.checkpoint.ancestryProof = `${proof.ancestryProof} `;
    db.prepare("UPDATE workflow_events SET payload_json = ? WHERE session_id = ? AND idempotency_key = ?")
      .run(JSON.stringify(payload), afterInput.sessionId, `checkpoint:${afterInput.runId}:after`);
    db.close();

    store = createWorkflowStore({ projectRoot });
    expect(() => store.listEvents(afterInput.sessionId)).toThrow(/ancestry proof|canonical/i);
    expect(() => store.materializeFlowProjection(afterInput.sessionId)).toThrow(/ancestry proof|canonical/i);
    expect(() => store.listNodeCheckpoints({ sessionId: afterInput.sessionId })).toThrow(/ancestry proof|canonical/i);
    store.close();
  });

  it.each([
    ["node", { nodeId: "node-other" }],
    ["execution target", { executionTarget: "new_worktree", worktreeId: "worktree-other" }],
    ["worktree id presence", { worktreeId: "worktree-other" }],
    ["worktree path", { worktreePath: "/different/repository/worktree" }],
    ["branch", { branchName: "other-branch" }],
  ] as const)("rejects persisted proof whose unique before checkpoint has mismatched %s authority", async (_label, beforeOverride) => {
    const projectRoot = await makeTempRoot();
    const store = createWorkflowStore({ projectRoot });
    seedStore(store);
    store.close();
    const runId = `run-authority-${_label.replaceAll(" ", "-")}`;
    const beforeHeadCommit = "a".repeat(40);
    const afterHeadCommit = "b".repeat(40);
    const common = {
      sessionId: "session-1",
      nodeId: "node-authority",
      laneId: "lane-authority",
      runId,
      segmentId: "segment-authority",
      executionTarget: "current_branch",
      worktreePath: projectRoot,
      branchName: "HEAD",
    };
    const proof = workflowGitAncestryProof(beforeHeadCommit, afterHeadCommit);
    insertRawCheckpointEvents(join(projectRoot, ".devflow", "skyturn-workflow.sqlite"), [
      rawCheckpoint({
        ...common,
        ...beforeOverride,
        id: `checkpoint:${runId}:before`,
        phase: "before",
        headCommit: beforeHeadCommit,
      }),
      rawCheckpoint({
        ...common,
        id: `checkpoint:${runId}:after`,
        phase: "after",
        headCommit: afterHeadCommit,
        ancestryProof: proof.ancestryProof,
      }),
    ]);

    const reopened = createWorkflowStore({ projectRoot });
    expect(() => reopened.listEvents("session-1")).toThrow(/authority|worktree identity|checkpoint/i);
    expect(() => reopened.materializeFlowProjection("session-1")).toThrow(/authority|worktree identity|checkpoint/i);
    expect(() => reopened.listNodeCheckpoints({ sessionId: "session-1" })).toThrow(/authority|worktree identity|checkpoint/i);
    reopened.close();
  });

  it.each([
    ["different authority", {
      id: "checkpoint-duplicate-before-other-authority",
      nodeId: "node-other",
      executionTarget: "new_worktree",
      worktreeId: "worktree-other",
      worktreePath: "/different/repository/worktree",
      branchName: "other-branch",
    }],
    ["only checkpoint id differs", { id: "checkpoint-duplicate-before-id-only" }],
  ] as const)("rejects proof-bearing after checkpoint with same-head ambiguous before candidates: %s", async (_label, duplicateOverride) => {
    const projectRoot = await makeTempRoot();
    const store = createWorkflowStore({ projectRoot });
    seedStore(store);
    store.close();
    const runId = `run-ambiguous-${_label.replaceAll(" ", "-")}`;
    const beforeHeadCommit = "a".repeat(40);
    const afterHeadCommit = "b".repeat(40);
    const common = {
      sessionId: "session-1",
      nodeId: "node-ambiguous",
      laneId: "lane-ambiguous",
      runId,
      segmentId: "segment-ambiguous",
      executionTarget: "current_branch",
      worktreePath: projectRoot,
      branchName: "HEAD",
    };
    const before = rawCheckpoint({
      ...common,
      id: `checkpoint:${runId}:before`,
      phase: "before",
      headCommit: beforeHeadCommit,
    });
    const proof = workflowGitAncestryProof(beforeHeadCommit, afterHeadCommit);
    insertRawCheckpointEvents(join(projectRoot, ".devflow", "skyturn-workflow.sqlite"), [
      before,
      { ...before, ...duplicateOverride },
      rawCheckpoint({
        ...common,
        id: `checkpoint:${runId}:after`,
        phase: "after",
        headCommit: afterHeadCommit,
        ancestryProof: proof.ancestryProof,
      }),
    ]);

    const reopened = createWorkflowStore({ projectRoot });
    expect(() => reopened.listEvents("session-1")).toThrow(/exactly one|ambiguous/i);
    expect(() => reopened.materializeFlowProjection("session-1")).toThrow(/exactly one|ambiguous/i);
    expect(() => reopened.listNodeCheckpoints({ sessionId: "session-1" })).toThrow(/exactly one|ambiguous/i);
    reopened.close();
  });

  it("keeps duplicate same-run legacy checkpoints readable when no after checkpoint has proof", async () => {
    const projectRoot = await makeTempRoot();
    const store = createWorkflowStore({ projectRoot });
    seedStore(store);
    store.close();
    const runId = "run-ambiguous-legacy";
    const common = {
      sessionId: "session-1",
      nodeId: "node-ambiguous-legacy",
      laneId: "lane-ambiguous-legacy",
      runId,
      segmentId: "segment-ambiguous-legacy",
      executionTarget: "current_branch",
      worktreePath: projectRoot,
      branchName: "HEAD",
    };
    const before = rawCheckpoint({
      ...common,
      id: `checkpoint:${runId}:before`,
      phase: "before",
      headCommit: "a".repeat(40),
      authority: { laneIdExplicit: true, nodeIdExplicit: true },
    });
    insertRawCheckpointEvents(join(projectRoot, ".devflow", "skyturn-workflow.sqlite"), [
      before,
      {
        ...before,
        id: "checkpoint-ambiguous-legacy-duplicate",
        nodeId: "node-other",
        executionTarget: "new_worktree",
        worktreeId: "worktree-other",
        worktreePath: "/different/repository/worktree",
        branchName: "other-branch",
      },
      rawCheckpoint({
        ...common,
        id: `checkpoint:${runId}:after`,
        phase: "after",
        headCommit: "b".repeat(40),
      }),
    ]);

    const reopened = createWorkflowStore({ projectRoot });
    expect(reopened.listEvents("session-1").filter((event) => event.kind === "workflow.node.checkpoint_recorded"))
      .toHaveLength(3);
    expect(reopened.materializeFlowProjection("session-1").checkpoints).toHaveLength(3);
    expect(reopened.listNodeCheckpoints({ sessionId: "session-1" })).toHaveLength(3);
    expect(reopened.listNodeCheckpoints({ sessionId: "session-1" }).some((checkpoint) => "ancestryProof" in checkpoint))
      .toBe(false);
    reopened.close();
  });

  it("validates many distinct persisted proof pairs through the indexed read path", async () => {
    const projectRoot = await makeTempRoot();
    const canonicalProjectRoot = await realpath(projectRoot);
    const store = createWorkflowStore({ projectRoot });
    seedStore(store);
    store.close();
    const checkpoints: Record<string, unknown>[] = [];
    for (let index = 0; index < 128; index += 1) {
      const runId = `run-linear-${index}`;
      const beforeHeadCommit = index.toString(16).padStart(40, "0");
      const afterHeadCommit = (index + 1_000).toString(16).padStart(40, "0");
      const common = {
        sessionId: "session-1",
        nodeId: `node-linear-${index}`,
        laneId: `lane-linear-${index}`,
        runId,
        segmentId: `segment-linear-${index}`,
        executionTarget: "current_branch",
        worktreePath: canonicalProjectRoot,
        branchName: "HEAD",
      };
      checkpoints.push(
        rawCheckpoint({
          ...common,
          id: `checkpoint:${runId}:before`,
          phase: "before",
          headCommit: beforeHeadCommit,
        }),
        rawCheckpoint({
          ...common,
          id: `checkpoint:${runId}:after`,
          phase: "after",
          headCommit: afterHeadCommit,
          ancestryProof: workflowGitAncestryProof(beforeHeadCommit, afterHeadCommit).ancestryProof,
        }),
      );
    }
    insertRawCheckpointEvents(join(projectRoot, ".devflow", "skyturn-workflow.sqlite"), checkpoints);

    const reopened = createWorkflowStore({ projectRoot });
    expect(reopened.listEvents("session-1").filter((event) => event.kind === "workflow.node.checkpoint_recorded"))
      .toHaveLength(256);
    expect(reopened.materializeFlowProjection("session-1").checkpoints).toHaveLength(256);
    expect(reopened.listNodeCheckpoints({ sessionId: "session-1", phase: "after" })).toHaveLength(128);
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
    const worktreePath = `${projectRoot}/.devflow/worktrees/candidate`;
    store.appendWorkflowEvent({
      sessionId: "session-1",
      kind: "workflow.worktree.created",
      source: "git-worktree",
      idempotencyKey: "worktree:candidate:created",
      payload: {
        worktree: {
          worktreeId: "worktree-session-1-candidate",
          variantId: "candidate",
          path: worktreePath,
          realPath: worktreePath,
          gitdir: `${projectRoot}/.git/worktrees/candidate`,
          repoRoot: projectRoot,
          branchName: "skyturn/session-1/candidate",
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
      worktreeId: "worktree-session-1-candidate",
      worktreePath,
      branchName: "skyturn/session-1/candidate",
      headCommit: "a".repeat(40),
      worktreeState: "clean" as const,
      evidenceRefs: [{ kind: "run" as const, id: "run-session-1-lane-implementation" }],
      now: "2026-06-14T00:00:03.000Z",
    };

    expect(store.recordRunCheckpoint(input)).toMatchObject({ worktreeId: input.worktreeId, worktreePath, branchName: input.branchName });
    expect(() => store.recordRunCheckpoint({ ...input, worktreeId: undefined })).toThrow(/new worktree.*worktree id/i);
    expect(() => store.recordRunCheckpoint({ ...input, worktreeId: "wrong" })).toThrow(/candidate binding/i);
    expect(() => store.recordRunCheckpoint({ ...input, worktreePath: `${worktreePath}-wrong` })).toThrow(/managed worktree identity/i);
    expect(() => store.recordRunCheckpoint({ ...input, branchName: "wrong" })).toThrow(/managed worktree identity/i);

    appendTestLane(store, "lane-legacy");
    const legacyWorktree = candidateWorktree(projectRoot, "legacy", "lane-legacy");
    appendWorktreeCreated(store, legacyWorktree);
    appendTestFlowEvent(store, "workflow.segment.started", {
      laneId: "lane-legacy",
      segment: {
        id: "segment-legacy",
        laneId: "lane-legacy",
        runId: "run-legacy",
        status: "running",
      },
    }, "test-segment:legacy");
    expect(store.recordRunCheckpoint({
      ...input,
      nodeId: "lane-legacy",
      laneId: "lane-legacy",
      runId: "run-legacy",
      segmentId: "segment-legacy",
      worktreeId: legacyWorktree.worktreeId,
      worktreePath: legacyWorktree.realPath,
      branchName: legacyWorktree.branchName,
      headCommit: legacyWorktree.headCommit,
      evidenceRefs: [{ kind: "run", id: "run-legacy" }],
      now: "2026-06-14T00:00:04.000Z",
    })).toMatchObject({ worktreeId: legacyWorktree.worktreeId });
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

  it("exactly replays a terminal failed repair regression chain after SQLite reopen", async () => {
    const projectRoot = await makeTempRoot();
    const store = createWorkflowStore({ projectRoot });
    seedStore(store);
    declareCodeChangeWorkflow(store);
    advanceCodeChangeWorkflowToLane(store, "lane-implementation");
    store.recordRunResult(runResultInput(store, "lane-implementation", "failed", "2026-06-14T00:00:07.000Z"));
    recordCheckpoint(store, "checkpoint-after-implementation", "lane-implementation", "after", "head-sha");

    store.requestNodeRepair({
      sessionId: "session-1",
      laneId: "lane-implementation",
      checkpointId: "checkpoint-after-implementation",
      intentId: "deterministic-repair-intent",
      successorLaneId: "lane-implementation-repair",
      successorSemanticKey: "repair:lane-implementation:deterministic",
      instruction: "Repair the failed implementation and rerun its regression test.",
      now: "2026-06-14T00:00:20.000Z",
    });
    expect(store.scheduleReadyLanes("session-1", {
      allowedParallelism: 1,
      now: "2026-06-14T00:00:21.000Z",
    }).readyLanes.map((lane) => lane.id)).toEqual(["lane-implementation-repair"]);
    store.recordRunResult(runResultInput(
      store,
      "lane-implementation-repair",
      "succeeded",
      "2026-06-14T00:00:22.000Z",
    ));
    expect(store.scheduleReadyLanes("session-1", {
      allowedParallelism: 1,
      now: "2026-06-14T00:00:23.000Z",
    }).readyLanes.map((lane) => lane.id)).toEqual(["lane-implementation-repair-regression"]);
    store.recordRunResult(runResultInput(
      store,
      "lane-implementation-repair-regression",
      "succeeded",
      "2026-06-14T00:00:24.000Z",
    ));

    const live = {
      projection: store.materializeFlowProjection("session-1"),
      canvasSession: store.materializeCanvasSession("session-1"),
    };
    expect(live.projection.lanes.find((lane) => lane.id === "lane-implementation")?.status).toBe("failed");
    expect(live.projection.lanes.find((lane) => lane.id === "lane-implementation-repair")?.status).toBe("completed");
    expect(live.projection.lanes.find((lane) => lane.id === "lane-implementation-repair-regression")?.status).toBe("completed");
    store.close();

    const reopened = createWorkflowStore({ projectRoot });
    const replayed = {
      projection: reopened.materializeFlowProjection("session-1"),
      canvasSession: reopened.materializeCanvasSession("session-1"),
    };
    expect(replayed).toEqual(live);
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

  it("keeps user input delivery pending until a durable delivered fact is recorded", async () => {
    const store = await makeSeededStore();
    const claimUserInput = Reflect.get(store, "claimUserInput") as undefined | ((input: {
      sessionId: string;
      inputId: string;
      text: string;
      now: string;
    }) => { event: { id: string; payload: Record<string, unknown> }; created: boolean; ownsDelivery: boolean });
    const recordUserInputDelivered = Reflect.get(store, "recordUserInputDelivered") as undefined | ((input: {
      sessionId: string;
      inputId: string;
      now: string;
    }) => { id: string; payload: Record<string, unknown> });
    expect(claimUserInput).toBeTypeOf("function");
    expect(recordUserInputDelivered).toBeTypeOf("function");
    const input = {
      sessionId: "session-1",
      inputId: "input-owned-1",
      text: "Deliver this exact text once.",
      now: "2026-06-14T00:00:01.000Z",
    };

    const first = claimUserInput!.call(store, input);
    const pendingRetry = claimUserInput!.call(store, { ...input, now: "2026-06-14T00:00:02.000Z" });
    const projectionBeforeDelivery = store.materializeFlowProjection("session-1");
    const ledgerBeforeDelivery = store.buildLedgerSummary("session-1");
    const delivered = recordUserInputDelivered!.call(store, {
      sessionId: input.sessionId,
      inputId: input.inputId,
      now: "2026-06-14T00:00:03.000Z",
    });
    const deliveredRetry = claimUserInput!.call(store, { ...input, now: "2026-06-14T00:00:04.000Z" });

    expect(first).toMatchObject({ created: true, ownsDelivery: true });
    expect(pendingRetry).toMatchObject({ created: false, ownsDelivery: true });
    expect(pendingRetry.event).toEqual(first.event);
    expect(deliveredRetry).toMatchObject({ created: false, ownsDelivery: false });
    expect(deliveredRetry.event).toEqual(first.event);
    expect(delivered.payload).toEqual({ inputId: input.inputId });
    expect(JSON.stringify(delivered)).not.toContain(input.text);
    expect(store.listEvents("session-1").filter((event) => event.idempotencyKey === "user-input:input-owned-1"))
      .toHaveLength(1);
    expect(store.listEvents("session-1").filter((event) => event.idempotencyKey === "user-input-delivered:input-owned-1"))
      .toHaveLength(1);
    expect(store.materializeFlowProjection("session-1")).toEqual(projectionBeforeDelivery);
    expect(store.buildLedgerSummary("session-1")).toEqual(ledgerBeforeDelivery);
    store.close();
  });

  it("keeps Finish launch acceptance durable but out of Flow projection and planner ledger", async () => {
    const projectRoot = await makeTempRoot();
    const rawAcpHandle = "acp-private-finish-plan-handle";
    const store = createWorkflowStore({ projectRoot });
    seedStore(store);
    const projectionBefore = store.materializeFlowProjection("session-1");
    const ledgerBefore = store.buildLedgerSummary("session-1");
    const input = {
      sessionId: "session-1",
      kind: "workflow.plan_finish.launch_accepted" as const,
      source: "electron-main" as const,
      idempotencyKey: "plan-finish:plan-confirm-session-1:launch-accepted",
      payload: {
        inputId: "plan-confirm-session-1",
        runId: "hermes-plan-finish-session-1-attempt-1",
      },
      now: "2026-06-14T00:00:03.000Z",
    };

    const accepted = store.appendWorkflowEvent(input);
    const retry = store.appendWorkflowEvent(input);
    expect(retry).toEqual(accepted);
    expect(store.listEvents("session-1").filter((event) => event.kind === input.kind)).toHaveLength(1);
    expect(store.materializeFlowProjection("session-1")).toEqual(projectionBefore);
    expect(store.buildLedgerSummary("session-1")).toEqual(ledgerBefore);
    expect(JSON.stringify(store.listEvents("session-1"))).not.toContain(rawAcpHandle);
    store.close();

    const reopened = createWorkflowStore({ projectRoot });
    expect(reopened.listEvents("session-1").filter((event) => event.kind === input.kind)).toHaveLength(1);
    expect(reopened.materializeFlowProjection("session-1")).toEqual(projectionBefore);
    expect(reopened.buildLedgerSummary("session-1")).toEqual(ledgerBefore);
    expect(JSON.stringify(reopened.listEvents("session-1"))).not.toContain(rawAcpHandle);
    reopened.close();
  });

  it("bounds terminal planner intent recovery with an internal durable marker", async () => {
    const projectRoot = await makeTempRoot();
    const store = createWorkflowStore({ projectRoot });
    const session = planFinishWorkflowSessionInput();
    store.createPlanFinishWorkflowSession(session);
    const { segment } = store.claimPlannerRunStart({
      sessionId: session.id,
      laneId: "node-1",
      runId: "hermes-plan-finish-session-plan-finish-attempt-1",
      agentKind: "hermes",
      worktreePath: projectRoot,
      now: "2026-07-18T00:00:01.000Z",
    });
    store.recordRunResult({
      ...segment,
      outputSummary: "Planner completed before intent reconciliation.",
      evidence: {
        runId: segment.runId,
        status: "succeeded",
        exitCode: 0,
        changesetId: null,
        checks: [{ kind: "run-exit", name: "Hermes CLI exit", status: "passed" }],
        artifacts: [],
        review: null,
        errorReason: null,
        cancelReason: null,
        completedAt: "2026-07-18T00:00:02.000Z",
      },
      now: "2026-07-18T00:00:02.000Z",
    });
    const projectionBefore = store.materializeFlowProjection(session.id);
    const ledgerBefore = store.buildLedgerSummary(session.id);

    expect(store.listPendingPlannerIntentReconciliations()).toEqual([{
      sessionId: segment.sessionId,
      laneId: segment.laneId,
      segmentId: segment.segmentId,
      runId: segment.runId,
      agentKind: segment.agentKind,
    }]);
    store.completePlannerIntentReconciliation(segment, {
      disposition: "applied",
      intentId: "intent-plan-finish",
      operationSummary: [],
    }, "2026-07-18T00:00:03.000Z");

    expect(store.listPendingPlannerIntentReconciliations()).toEqual([]);
    expect(store.materializeFlowProjection(session.id)).toEqual(projectionBefore);
    expect(store.buildLedgerSummary(session.id)).toEqual(ledgerBefore);
    expect(store.listEvents(session.id).at(-1)).toMatchObject({
      kind: "workflow.planner_intent.reconciled",
      payload: {
        runId: segment.runId,
        agentKind: "hermes",
        disposition: "applied",
        intentId: "intent-plan-finish",
      },
    });
    store.close();
  });

  it("persists an ordered planner operation summary and compares it across reopen", async () => {
    const projectRoot = await makeTempRoot();
    let store = createWorkflowStore({ projectRoot });
    const { session, segment } = seedSucceededPlannerIntentCandidate(
      store,
      projectRoot,
      "run-planner-operation-summary",
      "planner output is already authenticated separately",
    );
    const operationSummary = [
      { type: "AnalyzeRequirement" },
      { type: "DiscoverProject" },
      { type: "ProposeLanes", lanesMode: "omitted" },
    ];
    const first = store.completePlannerIntentReconciliation(segment, {
      disposition: "applied",
      intentId: "intent-operation-summary",
      operationSummary,
    }, "2026-07-22T01:59:03.000Z");
    const firstEvents = store.listEvents(session.id);

    expect(first.payload).toEqual({
      runId: segment.runId,
      agentKind: "hermes",
      disposition: "applied",
      intentId: "intent-operation-summary",
      operationSummary,
    });
    store.close();

    store = createWorkflowStore({ projectRoot });
    expect(store.completePlannerIntentReconciliation(segment, {
      disposition: "applied",
      intentId: "intent-operation-summary",
      operationSummary: structuredClone(operationSummary),
    }, "2026-07-22T01:59:04.000Z")).toEqual(first);
    expect(store.listEvents(session.id)).toEqual(firstEvents);
    expect(() => store.completePlannerIntentReconciliation(segment, {
      disposition: "applied",
      intentId: "intent-operation-summary",
      operationSummary: [
        { type: "AnalyzeRequirement" },
        { type: "DiscoverProject" },
        { type: "ProposeLanes", lanesMode: "explicit" },
      ],
    }, "2026-07-22T01:59:05.000Z")).toThrow(/conflict/i);
    expect(store.listEvents(session.id)).toEqual(firstEvents);
    store.close();
  });

  it.each([
    ["explicit undefined", undefined],
    ["non-array", { type: "AnalyzeRequirement" }],
    ["unknown operation", [{ type: "LaunchUnknownAgent" }]],
    ["extra operation key", [{ type: "AnalyzeRequirement", requirement: "must stay private" }]],
    ["missing ProposeLanes mode", [{ type: "ProposeLanes" }]],
    ["unknown ProposeLanes mode", [{ type: "ProposeLanes", lanesMode: "defaulted" }]],
    ["extra ProposeLanes key", [{ type: "ProposeLanes", lanesMode: "omitted", lanes: [] }]],
    ["unbounded operation count", Array.from({ length: 65 }, () => ({ type: "AnalyzeRequirement" }))],
  ])("rejects %s in a planner operation summary before reconciliation persistence", async (label, operationSummary) => {
    const projectRoot = await makeTempRoot();
    const store = createWorkflowStore({ projectRoot });
    const { session, segment } = seedSucceededPlannerIntentCandidate(
      store,
      projectRoot,
      `run-planner-operation-summary-${label.replaceAll(" ", "-")}`,
      "planner summary normalization fixture",
    );
    const eventsBefore = store.listEvents(session.id);

    expect(() => store.completePlannerIntentReconciliation(segment, {
      disposition: "applied",
      intentId: "intent-operation-summary-invalid",
      operationSummary,
    }, "2026-07-22T01:59:03.000Z")).toThrow(/operation summary/i);
    expect(store.listEvents(session.id)).toEqual(eventsBefore);
    expect(store.listPendingPlannerIntentReconciliations()).toEqual([{
      sessionId: segment.sessionId,
      laneId: segment.laneId,
      segmentId: segment.segmentId,
      runId: segment.runId,
      agentKind: segment.agentKind,
    }]);
    store.close();
  });

  it("rejects a missing planner operation summary before reconciliation persistence", async () => {
    const projectRoot = await makeTempRoot();
    const store = createWorkflowStore({ projectRoot });
    const { session, segment } = seedSucceededPlannerIntentCandidate(
      store,
      projectRoot,
      "run-planner-operation-summary-missing",
      "planner summary presence fixture",
    );
    const eventsBefore = store.listEvents(session.id);

    expect(() => store.completePlannerIntentReconciliation(segment, {
      disposition: "applied",
      intentId: "intent-operation-summary-missing",
    } as unknown as Parameters<typeof store.completePlannerIntentReconciliation>[1], "2026-07-22T01:59:03.000Z"))
      .toThrow(/operation summary/i);
    expect(store.listEvents(session.id)).toEqual(eventsBefore);
    expect(store.listPendingPlannerIntentReconciliations()).toHaveLength(1);
    store.close();
  });

  it("persists an explicit empty operation summary for an unparsed invalid planner turn", async () => {
    const projectRoot = await makeTempRoot();
    const store = createWorkflowStore({ projectRoot });
    const { segment } = seedSucceededPlannerIntentCandidate(
      store,
      projectRoot,
      "run-planner-empty-operation-summary",
      "not a WorkflowIntent",
    );

    const event = store.completePlannerIntentReconciliation(segment, {
      disposition: "invalid",
      reasonCode: "parse_invalid",
      operationSummary: [],
    }, "2026-07-22T01:59:03.000Z");

    expect(event.payload.operationSummary).toEqual([]);
    store.close();
  });

  it("finalizes invalid planner intent without changing exact successful process evidence or output", async () => {
    const projectRoot = await makeTempRoot();
    const store = createWorkflowStore({ projectRoot });
    const { session, segment, evidence, output } = seedSucceededPlannerIntentCandidate(
      store,
      projectRoot,
      "run-planner-invalid",
      "not a WorkflowIntent\n",
    );
    const projectionBefore = store.materializeFlowProjection(session.id);

    const disposition = store.completePlannerIntentReconciliation(segment, {
      disposition: "invalid",
      reasonCode: "parse_invalid",
      operationSummary: [],
    }, "2026-07-22T02:00:03.000Z");

    expect(disposition).toMatchObject({
      kind: "workflow.planner_intent.reconciled",
      payload: {
        runId: segment.runId,
        agentKind: "hermes",
        disposition: "invalid",
        reasonCode: "parse_invalid",
      },
    });
    expect(store.listPendingPlannerIntentReconciliations()).toEqual([]);
    expect(store.materializeFlowProjection(session.id)).toEqual(projectionBefore);
    const persisted = store.listSegments(session.id, session.plannerLaneId).at(-1);
    expect(persisted).toMatchObject({ status: "succeeded", exitCode: 0, errorReason: null });
    expect(persisted?.evidence).toEqual(evidence);
    expect(store.materializeCanvasSession(session.id)?.nodes.find((node) => node.id === session.plannerLaneId))
      .toMatchObject({ status: "failed", output: [output] });
    expect(store.listEvents(session.id).filter((event) =>
      event.kind === "lane_status_changed" && event.idempotencyKey === `planner-intent:${segment.runId}:lane-failed`
    )).toEqual([
      expect.objectContaining({ payload: { status: "failed", reason: "planner-intent-invalid:parse_invalid" } }),
    ]);
    store.close();
  });

  it("makes planner disposition replay zero-write across reopen and rejects conflicts before writes", async () => {
    const projectRoot = await makeTempRoot();
    let store = createWorkflowStore({ projectRoot });
    const { session, segment } = seedSucceededPlannerIntentCandidate(
      store,
      projectRoot,
      "run-planner-idempotent",
      "invalid planner output",
    );
    const first = store.completePlannerIntentReconciliation(segment, {
      disposition: "invalid",
      reasonCode: "parse_invalid",
      operationSummary: [],
    }, "2026-07-22T02:01:03.000Z");
    const firstEvents = store.listEvents(session.id);
    const firstLane = store.getLane(session.id, session.plannerLaneId);

    expect(store.completePlannerIntentReconciliation(segment, {
      disposition: "invalid",
      reasonCode: "parse_invalid",
      operationSummary: [],
    }, "2026-07-22T02:01:04.000Z")).toEqual(first);
    expect(store.listEvents(session.id)).toEqual(firstEvents);
    expect(store.getLane(session.id, session.plannerLaneId)).toEqual(firstLane);
    expect(() => store.completePlannerIntentReconciliation(segment, {
      disposition: "rejected",
      intentId: "intent-conflict",
      reasonCode: "policy_rejected",
      operationSummary: [],
    }, "2026-07-22T02:01:05.000Z")).toThrow(/conflict/i);
    expect(() => store.completePlannerIntentReconciliation(segment, {
      disposition: "invalid",
      intentId: "intent-conflict",
      reasonCode: "parse_invalid",
      operationSummary: [],
    }, "2026-07-22T02:01:05.500Z")).toThrow(/conflict/i);
    expect(() => store.completePlannerIntentReconciliation({ ...segment, laneId: "lane-conflict" }, {
      disposition: "invalid",
      reasonCode: "parse_invalid",
      operationSummary: [],
    }, "2026-07-22T02:01:06.000Z")).toThrow(/conflict/i);
    expect(store.listEvents(session.id)).toEqual(firstEvents);
    store.close();

    store = createWorkflowStore({ projectRoot });
    expect(store.completePlannerIntentReconciliation(segment, {
      disposition: "invalid",
      reasonCode: "parse_invalid",
      operationSummary: [],
    }, "2026-07-22T02:01:07.000Z")).toEqual(first);
    expect(store.listEvents(session.id)).toEqual(firstEvents);
    expect(store.getLane(session.id, session.plannerLaneId)).toEqual(firstLane);
    store.close();
  });

  it("rolls back disposition event, lane failure, and candidate deletion together on SQLite failure", async () => {
    const projectRoot = await makeTempRoot();
    let failCommit = true;
    const store = createWorkflowStore({
      projectRoot,
      faultInjection: {
        beforePlannerIntentDispositionCommit() {
          if (failCommit) throw new Error("injected planner disposition transaction failure");
        },
      },
    });
    const { session, segment, evidence } = seedSucceededPlannerIntentCandidate(
      store,
      projectRoot,
      "run-planner-transaction-failure",
      "invalid transaction output",
    );

    expect(() => store.completePlannerIntentReconciliation(segment, {
      disposition: "invalid",
      reasonCode: "parse_invalid",
      operationSummary: [],
    }, "2026-07-22T02:01:03.000Z")).toThrow("injected planner disposition transaction failure");
    expect(store.listPendingPlannerIntentReconciliations()).toHaveLength(1);
    expect(store.listEvents(session.id).some((event) => event.kind === "workflow.planner_intent.reconciled")).toBe(false);
    expect(store.getLane(session.id, session.plannerLaneId)?.status).toBe("completed");
    expect(store.listSegments(session.id, session.plannerLaneId).at(-1)?.evidence).toEqual(evidence);

    failCommit = false;
    store.completePlannerIntentReconciliation(segment, {
      disposition: "invalid",
      reasonCode: "parse_invalid",
      operationSummary: [],
    }, "2026-07-22T02:01:04.000Z");
    expect(store.listPendingPlannerIntentReconciliations()).toEqual([]);
    expect(store.getLane(session.id, session.plannerLaneId)?.status).toBe("failed");
    store.close();
  });

  it("reads historical reconciliation events without disposition as applied zero-write facts", async () => {
    const projectRoot = await makeTempRoot();
    let store = createWorkflowStore({ projectRoot });
    const { session, segment } = seedSucceededPlannerIntentCandidate(
      store,
      projectRoot,
      "run-planner-legacy-applied",
      "legacy applied output",
    );
    store.completePlannerIntentReconciliation(segment, {
      disposition: "applied",
      intentId: "intent-original",
      operationSummary: [],
    }, "2026-07-22T02:01:03.000Z");
    store.close();

    const db = new Database(join(projectRoot, ".devflow", "skyturn-workflow.sqlite"));
    db.prepare("UPDATE workflow_events SET payload_json = ? WHERE session_id = ? AND idempotency_key = ?")
      .run(JSON.stringify({ runId: segment.runId }), session.id, `planner-intent:${segment.runId}:reconciled`);
    db.close();

    store = createWorkflowStore({ projectRoot });
    const before = store.listEvents(session.id);
    const legacy = store.completePlannerIntentReconciliation(segment, {
      disposition: "applied",
      intentId: "intent-historical-unknown",
      operationSummary: [],
    }, "2026-07-22T02:01:04.000Z");
    expect(legacy.payload).toEqual({ runId: segment.runId });
    expect(store.listEvents(session.id)).toEqual(before);
    expect(store.listPendingPlannerIntentReconciliations()).toEqual([]);
    store.close();
  });

  it("does not let an old invalid candidate override a newer planner turn and accepts another turn after failure", async () => {
    const projectRoot = await makeTempRoot();
    const store = createWorkflowStore({ projectRoot });
    const first = seedSucceededPlannerIntentCandidate(
      store,
      projectRoot,
      "run-planner-old-invalid",
      "old invalid output",
    );
    const secondClaim = store.claimPlannerRunStart({
      sessionId: first.session.id,
      laneId: first.session.plannerLaneId,
      runId: "run-planner-newer",
      agentKind: "hermes",
      worktreePath: projectRoot,
      now: "2026-07-22T02:02:03.000Z",
    });

    store.completePlannerIntentReconciliation(first.segment, {
      disposition: "invalid",
      reasonCode: "parse_invalid",
      operationSummary: [],
    }, "2026-07-22T02:02:04.000Z");
    expect(store.getLane(first.session.id, first.session.plannerLaneId)?.status).toBe("running");
    expect(store.listEvents(first.session.id).some((event) =>
      event.idempotencyKey === `planner-intent:${first.segment.runId}:lane-failed`
    )).toBe(false);

    const secondCompletedAt = "2026-07-22T02:02:05.000Z";
    const secondEvidence = succeededPlannerRunEvidence(secondClaim.segment.runId, secondCompletedAt);
    store.recordRunResult({
      ...secondClaim.segment,
      outputSummary: "new invalid planner output",
      runEvents: [plannerOutputEvent(secondClaim.segment.runId, "new invalid planner output", secondCompletedAt)],
      evidence: secondEvidence,
      now: secondCompletedAt,
    });
    store.completePlannerIntentReconciliation(secondClaim.segment, {
      disposition: "invalid",
      reasonCode: "parse_invalid",
      operationSummary: [],
    }, "2026-07-22T02:02:06.000Z");
    expect(store.getLane(first.session.id, first.session.plannerLaneId)?.status).toBe("failed");

    const third = store.claimPlannerRunStart({
      sessionId: first.session.id,
      laneId: first.session.plannerLaneId,
      runId: "run-planner-after-invalid",
      agentKind: "hermes",
      worktreePath: projectRoot,
      now: "2026-07-22T02:02:07.000Z",
    });
    expect(third.created).toBe(true);
    expect(store.getLane(first.session.id, first.session.plannerLaneId)?.status).toBe("running");
    store.close();
  });

  it("fails closed on corrupt planner candidate identity without deleting recovery state", async () => {
    const projectRoot = await makeTempRoot();
    let store = createWorkflowStore({ projectRoot });
    const { segment } = seedSucceededPlannerIntentCandidate(
      store,
      projectRoot,
      "run-planner-corrupt",
      "corrupt candidate output",
    );
    store.close();

    const db = new Database(join(projectRoot, ".devflow", "skyturn-workflow.sqlite"));
    const row = db.prepare("SELECT name, state FROM workflow_maintenance WHERE name LIKE 'planner_intent_reconciliation:%'")
      .get() as { name: string; state: string };
    const corrupt = { ...JSON.parse(row.state), laneId: "lane-corrupt" };
    db.prepare("UPDATE workflow_maintenance SET state = ? WHERE name = ?").run(JSON.stringify(corrupt), row.name);
    db.close();

    store = createWorkflowStore({ projectRoot });
    const [candidate] = store.listPendingPlannerIntentReconciliations();
    expect(() => store.getPlannerIntentReconciliationFacts(candidate!)).toThrow(/identity|planner/i);
    expect(() => store.completePlannerIntentReconciliation(candidate!, {
      disposition: "invalid",
      reasonCode: "parse_invalid",
      operationSummary: [],
    }, "2026-07-22T02:03:03.000Z")).toThrow(/identity|planner/i);
    expect(store.listPendingPlannerIntentReconciliations()).toEqual([candidate]);
    expect(store.listSegments(segment.sessionId, segment.laneId).at(-1)?.status).toBe("succeeded");
    store.close();
  });

  it.each([
    ["missing segment", "DELETE FROM workflow_segments WHERE run_id = ?"],
    ["missing evidence", "UPDATE workflow_segments SET evidence_json = NULL WHERE run_id = ?"],
    ["run identity mismatch", "UPDATE workflow_segments SET run_id = 'run-planner-mismatched' WHERE run_id = ?"],
  ])("fails closed on %s while preserving the exact pending candidate", async (_label, mutation) => {
    const projectRoot = await makeTempRoot();
    let store = createWorkflowStore({ projectRoot });
    const { segment } = seedSucceededPlannerIntentCandidate(
      store,
      projectRoot,
      `run-planner-${_label.replaceAll(" ", "-")}`,
      "planner corruption output",
    );
    const [candidate] = store.listPendingPlannerIntentReconciliations();
    store.close();

    const db = new Database(join(projectRoot, ".devflow", "skyturn-workflow.sqlite"));
    db.prepare(mutation).run(segment.runId);
    db.close();

    store = createWorkflowStore({ projectRoot });
    const eventsBefore = store.listEvents(segment.sessionId);
    expect(() => store.getPlannerIntentReconciliationFacts(candidate!)).toThrow(/identity|evidence/i);
    expect(() => store.completePlannerIntentReconciliation(candidate!, {
      disposition: "invalid",
      reasonCode: "parse_invalid",
      operationSummary: [],
    }, "2026-07-22T02:04:03.000Z")).toThrow(/identity|evidence/i);
    expect(store.listPendingPlannerIntentReconciliations()).toEqual([candidate]);
    expect(store.listEvents(segment.sessionId)).toEqual(eventsBefore);
    store.close();
  });

  it("creates the Plan Finish session and backend binding atomically", async () => {
    const projectRoot = await makeTempRoot();
    const store = createWorkflowStore({
      projectRoot,
      faultInjection: {
        beforePlanFinishBinding: () => {
          throw new Error("injected Plan Finish binding failure");
        },
      },
    });

    expect(() => store.createPlanFinishWorkflowSession(planFinishWorkflowSessionInput()))
      .toThrow("injected Plan Finish binding failure");
    expect(store.getWorkflowSession("session-plan-finish")).toBeNull();
    expect(store.listEvents("session-plan-finish")).toEqual([]);
    store.close();

    const reopened = createWorkflowStore({ projectRoot });
    expect(reopened.getWorkflowSession("session-plan-finish")).toBeNull();
    expect(reopened.listEvents("session-plan-finish")).toEqual([]);
    reopened.close();
  });

  it("rejects generic reuse while preserving exact durable Plan Finish retries across reopen", async () => {
    const projectRoot = await makeTempRoot();
    const input = planFinishWorkflowSessionInput();
    const store = createWorkflowStore({ projectRoot });
    store.createWorkflowSession({
      id: "session-before-plan-finish",
      projectId: "project-1",
      title: "Ordinary workflow",
      goal: "Reserve the legacy first planner lane identity",
      mode: "fast",
      plannerProfile: "default",
      transport: "hermes_replay_recovery",
      recoveryReason: "Test setup has no live Hermes session.",
      now: "2026-07-17T23:59:59.000Z",
    });
    const created = store.createPlanFinishWorkflowSession(input);
    const projection = store.materializeFlowProjection(input.id);
    const ledger = store.buildLedgerSummary(input.id);

    expect(created.plannerLaneId).toMatch(/^node-planner-[a-f0-9]{24}$/);
    expect(created.plannerLaneId).not.toBe("node-1");
    expect(() => store.createWorkflowSession({ ...input, now: "2026-07-18T00:00:01.000Z" }))
      .toThrow(/bound by Plan Finish/i);
    expect(store.createPlanFinishWorkflowSession({ ...input, now: "2026-07-18T00:00:01.000Z" })).toEqual(created);
    expect(store.listEvents(input.id).filter((event) => event.kind === "workflow.plan_finish.bound"))
      .toHaveLength(1);
    expect(projection.events.some((event) => String(event.kind) === "workflow.plan_finish.bound")).toBe(false);
    expect(ledger.recentEvents.some((event) => event.kind === "workflow.plan_finish.bound")).toBe(false);
    store.close();

    const reopened = createWorkflowStore({ projectRoot });
    expect(reopened.createPlanFinishWorkflowSession({ ...input, now: "2026-07-18T00:00:02.000Z" }))
      .toEqual(created);
    expect(() => reopened.createPlanFinishWorkflowSession({
      ...input,
      planSessionId: "another-plan",
      now: "2026-07-18T00:00:03.000Z",
    })).toThrow(/Plan Finish binding conflicts/i);
    expect(() => reopened.createPlanFinishWorkflowSession({
      ...input,
      title: "Forged matching Plan session",
      now: "2026-07-18T00:00:04.000Z",
    })).toThrow(/Plan Finish binding conflicts/i);
    expect(reopened.listEvents(input.id).filter((event) => event.kind === "workflow.plan_finish.bound"))
      .toHaveLength(1);
    reopened.close();
  });

  it("rejects generic workflow sessions that lack a backend Plan Finish binding", async () => {
    const store = await makeStore();
    const input = planFinishWorkflowSessionInput();
    store.createWorkflowSession(input);

    expect(() => store.assertPlanFinishWorkflowSessionAvailable(input))
      .toThrow(/not bound by Plan Finish/i);
    expect(() => store.createPlanFinishWorkflowSession(input))
      .toThrow(/not bound by Plan Finish/i);
    expect(store.listEvents(input.id).some((event) => event.kind === "workflow.plan_finish.bound")).toBe(false);
    store.close();
  });

  it("keeps a pending user input retryable after store reopen", async () => {
    const projectRoot = await makeTempRoot();
    const input = {
      sessionId: "session-1",
      inputId: "input-pending-reopen",
      text: "Retry this after reopen.",
      now: "2026-06-14T00:00:01.000Z",
    };
    const store = createWorkflowStore({ projectRoot });
    seedStore(store);
    expect(store.claimUserInput(input)).toMatchObject({ created: true, ownsDelivery: true });
    store.close();

    const reopened = createWorkflowStore({ projectRoot });
    expect(reopened.claimUserInput({ ...input, now: "2026-06-14T00:00:02.000Z" }))
      .toMatchObject({ created: false, ownsDelivery: true });
    reopened.close();
  });

  it("suppresses a durably delivered user input after store reopen", async () => {
    const projectRoot = await makeTempRoot();
    const input = {
      sessionId: "session-1",
      inputId: "input-delivered-reopen",
      text: "Do not replay this after reopen.",
      now: "2026-06-14T00:00:01.000Z",
    };
    const store = createWorkflowStore({ projectRoot });
    seedStore(store);
    store.claimUserInput(input);
    const recordUserInputDelivered = Reflect.get(store, "recordUserInputDelivered") as undefined | ((delivery: {
      sessionId: string;
      inputId: string;
      now: string;
    }) => unknown);
    expect(recordUserInputDelivered).toBeTypeOf("function");
    recordUserInputDelivered!.call(store, {
      sessionId: input.sessionId,
      inputId: input.inputId,
      now: "2026-06-14T00:00:02.000Z",
    });
    store.close();

    const reopened = createWorkflowStore({ projectRoot });
    expect(reopened.claimUserInput({ ...input, now: "2026-06-14T00:00:03.000Z" }))
      .toMatchObject({ created: false, ownsDelivery: false });
    expect(reopened.listEvents("session-1").filter((event) =>
      event.idempotencyKey === "user-input-delivered:input-delivered-reopen"
    )).toHaveLength(1);
    reopened.close();
  });

  it.each([
    ["wrong kind", { kind: "user_input", source: "workflow_store", payload: { inputId: "input-delivery-conflict" }, causation: "pending" }],
    ["wrong source", { kind: "workflow.user_input.delivered", source: "corrupt-source", payload: { inputId: "input-delivery-conflict" }, causation: "pending" }],
    ["wrong payload", { kind: "workflow.user_input.delivered", source: "workflow_store", payload: { inputId: "other-input" }, causation: "pending" }],
    ["wrong causationId", { kind: "workflow.user_input.delivered", source: "workflow_store", payload: { inputId: "input-delivery-conflict" }, causation: "wrong" }],
  ] as const)("rejects a delivered fact with %s before and after store reopen", async (_name, corrupt) => {
    const projectRoot = await makeTempRoot();
    const input = {
      sessionId: "session-1",
      inputId: "input-delivery-conflict",
      text: "This delivery must remain pending.",
      now: "2026-06-14T00:00:01.000Z",
    };
    const store = createWorkflowStore({ projectRoot });
    seedStore(store);
    const pending = store.claimUserInput(input).event;
    store.appendWorkflowEvent({
      sessionId: input.sessionId,
      kind: corrupt.kind,
      source: corrupt.source,
      causationId: corrupt.causation === "pending" ? pending.id : "wrong-causation-id",
      idempotencyKey: `user-input-delivered:${input.inputId}`,
      payload: corrupt.payload,
      now: "2026-06-14T00:00:02.000Z",
    });

    const conflict = `Workflow user input delivery id conflicts with existing state: ${input.inputId}.`;
    expect(() => store.claimUserInput({ ...input, now: "2026-06-14T00:00:03.000Z" })).toThrow(conflict);
    expect(() => store.recordUserInputDelivered({
      sessionId: input.sessionId,
      inputId: input.inputId,
      now: "2026-06-14T00:00:04.000Z",
    })).toThrow(conflict);
    store.close();

    const reopened = createWorkflowStore({ projectRoot });
    expect(() => reopened.claimUserInput({ ...input, now: "2026-06-14T00:00:05.000Z" })).toThrow(conflict);
    expect(() => reopened.recordUserInputDelivered({
      sessionId: input.sessionId,
      inputId: input.inputId,
      now: "2026-06-14T00:00:06.000Z",
    })).toThrow(conflict);
    reopened.close();
  });

  it("rejects a conflicting durable user input claim before mutation", async () => {
    const store = await makeSeededStore();
    const claimUserInput = Reflect.get(store, "claimUserInput") as (input: {
      sessionId: string;
      inputId: string;
      text: string;
      now: string;
    }) => unknown;
    expect(claimUserInput).toBeTypeOf("function");
    claimUserInput.call(store, {
      sessionId: "session-1",
      inputId: "input-conflict-1",
      text: "Original durable text.",
      now: "2026-06-14T00:00:01.000Z",
    });

    expect(() => claimUserInput.call(store, {
      sessionId: "session-1",
      inputId: "input-conflict-1",
      text: "Conflicting terminal text.",
      now: "2026-06-14T00:00:02.000Z",
    })).toThrow("Workflow user input id was already used with different input: input-conflict-1.");
    expect(store.listEvents("session-1").filter((event) => event.idempotencyKey === "user-input:input-conflict-1"))
      .toEqual([expect.objectContaining({ payload: { inputId: "input-conflict-1", text: "Original durable text." } })]);
    store.close();
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
    expect(store.listEvents("session-1").filter((event) => event.kind.startsWith("workflow.lane.candidate_"))).toEqual([]);

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

  it("binds a normal new-worktree serial chain before segment start and reuses its physical candidate", async () => {
    const projectRoot = await makeTempRoot();
    const store = createWorkflowStore({ projectRoot });
    seedStore(store, newWorktreeTarget());
    declareCodeChangeWorkflow(store);

    expect(scheduleLaneIds(store, "2026-07-28T00:00:00.000Z")).toEqual(["lane-implementation"]);
    const firstEvents = store.listEvents("session-1");
    const boundIndex = firstEvents.findIndex((event) =>
      event.kind === "workflow.lane.candidate_bound" && event.laneId === "lane-implementation");
    const startedIndex = firstEvents.findIndex((event) =>
      event.kind === "workflow.segment.started" && event.laneId === "lane-implementation");
    expect(boundIndex).toBeGreaterThan(-1);
    expect(startedIndex).toBeGreaterThan(boundIndex);
    const placeholder = store.materializeCanvasSession("session-1")?.nodes
      .find((node) => node.id === "lane-implementation");
    expect(placeholder?.candidateBinding).toMatchObject(candidateBindingFacts("candidate"));
    expect(placeholder?.worktree).toMatchObject(candidateBindingFacts("candidate"));

    const worktree = candidateWorktree(projectRoot, "candidate", "lane-implementation");
    appendWorktreeCreated(store, worktree);
    store.recordRunResult(runResultInput(store, "lane-implementation", "succeeded", "2026-07-28T00:00:01.000Z"));
    expect(scheduleLaneIds(store, "2026-07-28T00:00:02.000Z")).toEqual(["lane-validation"]);

    const projection = store.materializeFlowProjection("session-1");
    const serial = projection.candidateBindings.find((binding) => binding.laneId === "lane-validation");
    expect(serial).toMatchObject({ ...candidateBindingFacts("candidate"), reason: "serial" });
    for (const laneId of ["lane-implementation", "lane-validation"]) {
      expect(store.materializeCanvasSession("session-1")?.nodes.find((node) => node.id === laneId)?.worktree)
        .toMatchObject(worktreeMetadataFacts(worktree));
    }
    store.close();

    const reopened = createWorkflowStore({ projectRoot });
    expect(reopened.materializeFlowProjection("session-1").candidateBindings).toEqual(projection.candidateBindings);
    expect(reopened.materializeFlowProjection("session-1").segments).toEqual(projection.segments);
    expect(reopened.materializeCanvasSession("session-1")?.nodes.find((node) => node.id === "lane-validation")?.worktree)
      .toMatchObject(worktreeMetadataFacts(worktree));
    reopened.close();
  });

  it("serializes parallel roots on the same candidate until its running segment is terminal", async () => {
    const store = await makeNewWorktreeStore();
    appendTestLane(store, "lane-root-a");
    appendTestLane(store, "lane-root-b");

    expect(scheduleLaneIds(store, "2026-07-28T01:00:00.000Z", 2)).toEqual(["lane-root-a"]);
    expect(store.materializeFlowProjection("session-1").candidateBindings.map((binding) => binding.laneId))
      .toEqual(["lane-root-a", "lane-root-b"]);
    expect(store.materializeFlowProjection("session-1").lanes.find((lane) => lane.id === "lane-root-b")?.status)
      .toBe("pending");

    store.recordRunResult(runResultInput(store, "lane-root-a", "succeeded", "2026-07-28T01:00:01.000Z"));
    expect(scheduleLaneIds(store, "2026-07-28T01:00:02.000Z", 2)).toEqual(["lane-root-b"]);
    store.close();

    const distinct = await makeNewWorktreeStore();
    for (const laneId of ["lane-root-a", "lane-root-b"]) appendTestLane(distinct, laneId);
    appendCandidateBinding(distinct, "lane-root-a", "a", "lineage-a");
    appendCandidateBinding(distinct, "lane-root-b", "b", "lineage-b");
    expect(scheduleLaneIds(distinct, "2026-07-28T01:00:03.000Z", 2)).toEqual(["lane-root-a", "lane-root-b"]);
    distinct.close();
  });

  it("holds scheduling authority while previewing and serializes a shared candidate across stores", async () => {
    const projectRoot = await makeTempRoot();
    const seed = createWorkflowStore({ projectRoot });
    try {
      seedStore(seed, newWorktreeTarget());
      appendTestLane(seed, "lane-root-a", "pending", "implementation", {
        fileScopes: ["packages/root-a/**"],
        packageScopes: ["@skyturn/root-a"],
      });
      appendTestLane(seed, "lane-root-b", "pending", "implementation", {
        fileScopes: ["packages/root-b/**"],
        packageScopes: ["@skyturn/root-b"],
      });
    } finally {
      seed.close();
    }

    const contender = createWorkflowStore({
      projectRoot,
      faultInjection: { sqliteBusyTimeoutMs: 1 },
    });
    let contentionError: unknown;
    const owner = createWorkflowStore({
      projectRoot,
      faultInjection: {
        afterSchedulePreview: () => {
          try {
            contender.scheduleReadyLanes("session-1", {
              allowedParallelism: 2,
              authorizedLaneIds: ["lane-root-b"],
              now: "2026-07-28T01:01:00.001Z",
            });
          } catch (error) {
            contentionError = error;
          }
        },
      },
    });
    try {
      expect(owner.materializeFlowProjection("session-1").segments).toEqual([]);
      expect(contender.materializeFlowProjection("session-1").segments).toEqual([]);
      expect(owner.scheduleReadyLanes("session-1", {
        allowedParallelism: 2,
        authorizedLaneIds: ["lane-root-a"],
        now: "2026-07-28T01:01:00.000Z",
      }).readyLanes.map((lane) => lane.id)).toEqual(["lane-root-a"]);
      expect(contentionError).toMatchObject({ code: "SQLITE_BUSY" });

      const beforeTerminal = contender.materializeFlowProjection("session-1");
      const runningSegments = beforeTerminal.segments.filter((segment) => segment.status === "running");
      expect(runningSegments.map((segment) => segment.laneId)).toEqual(["lane-root-a"]);
      expect(beforeTerminal.candidateBindings).toEqual([
        expect.objectContaining({ laneId: "lane-root-a", ...candidateBindingFacts("candidate") }),
      ]);
      expect(contender.scheduleReadyLanes("session-1", {
        allowedParallelism: 2,
        authorizedLaneIds: ["lane-root-b"],
        now: "2026-07-28T01:01:00.002Z",
      }).readyLanes).toEqual([]);

      owner.recordRunResult(
        runResultInput(owner, "lane-root-a", "succeeded", "2026-07-28T01:01:01.000Z"),
      );
      expect(contender.scheduleReadyLanes("session-1", {
        allowedParallelism: 2,
        authorizedLaneIds: ["lane-root-b"],
        now: "2026-07-28T01:01:02.000Z",
      }).readyLanes.map((lane) => lane.id)).toEqual(["lane-root-b"]);
    } finally {
      try {
        owner.close();
      } finally {
        contender.close();
      }
    }

    const reopened = createWorkflowStore({ projectRoot });
    try {
      const projection = reopened.materializeFlowProjection("session-1");
      const rootSegments = projection.segments.filter((segment) =>
        segment.laneId === "lane-root-a" || segment.laneId === "lane-root-b"
      );
      const rootBindings = projection.candidateBindings.filter((binding) =>
        binding.laneId === "lane-root-a" || binding.laneId === "lane-root-b"
      );
      expect(rootSegments).toHaveLength(2);
      expect(new Set(rootSegments.map((segment) => segment.id))).toHaveLength(2);
      expect(rootBindings).toHaveLength(2);
      expect(new Set(rootBindings.map((binding) => binding.laneId))).toHaveLength(2);
      expect(new Set(rootBindings.map((binding) => binding.worktreeId))).toEqual(
        new Set(["worktree-session-1-candidate"]),
      );
    } finally {
      reopened.close();
    }
  });

  it("serializes current-branch writers across sessions and stores while allowing observers", async () => {
    const projectRoot = await makeTempRoot();
    const contenderLanes = [
      ["lane-writer-contender-a", "implementation"],
      ["lane-observer-a", "validation"],
      ["lane-writer-contender-b", "commit"],
      ["lane-observer-b", "review"],
    ] as const;
    const contenderLaneIds = contenderLanes.map(([laneId]) => laneId);
    const seed = createWorkflowStore({ projectRoot });
    try {
      for (const [sessionId, now] of [
        ["session-writer-owner", "2026-07-28T01:01:10.000Z"],
        ["session-writer-contender", "2026-07-28T01:01:11.000Z"],
      ] as const) {
        seed.createWorkflowSession({
          id: sessionId,
          projectId: "project-1",
          title: sessionId,
          goal: "Exercise authoritative current-branch scheduling.",
          mode: "fast",
          target: { executionTarget: "current_branch", selectedBranch: "main" },
          plannerProfile: "default",
          transport: "hermes_replay_recovery",
          recoveryReason: "Test setup has no live Hermes session.",
          now,
        });
      }
      appendTestFlowEvent(seed, "workflow.lane.declared", {
        lane: {
          id: "lane-writer-owner",
          semanticKey: "lane-writer-owner",
          kind: "implementation",
          title: "Owner writer",
          agentKind: "codex",
          status: "pending",
        },
      }, "test-lane:writer-owner", "session-writer-owner");
      for (const [laneId, kind] of contenderLanes) {
        appendTestFlowEvent(seed, "workflow.lane.declared", {
          lane: {
            id: laneId,
            semanticKey: laneId,
            kind,
            title: laneId,
            agentKind: "codex",
            status: "pending",
          },
        }, `test-lane:${laneId}`, "session-writer-contender");
      }
    } finally {
      seed.close();
    }

    const contender = createWorkflowStore({
      projectRoot,
      faultInjection: { sqliteBusyTimeoutMs: 1 },
    });
    let contentionError: unknown;
    const owner = createWorkflowStore({
      projectRoot,
      faultInjection: {
        afterSchedulePreview: () => {
          try {
            contender.scheduleReadyLanes("session-writer-contender", {
              allowedParallelism: 4,
              authorizedLaneIds: contenderLaneIds,
              now: "2026-07-28T01:01:12.001Z",
            });
          } catch (error) {
            contentionError = error;
          }
        },
      },
    });
    let ownerClosed = false;
    try {
      expect(owner.materializeFlowProjection("session-writer-owner").segments).toEqual([]);
      expect(contender.materializeFlowProjection("session-writer-contender").segments).toEqual([]);
      expect(owner.scheduleReadyLanes("session-writer-owner", {
        allowedParallelism: 1,
        now: "2026-07-28T01:01:12.000Z",
      }).readyLanes.map((lane) => lane.id)).toEqual(["lane-writer-owner"]);
      expect(contentionError).toMatchObject({ code: "SQLITE_BUSY" });

      const observerSchedule = contender.scheduleReadyLanes("session-writer-contender", {
        allowedParallelism: 4,
        authorizedLaneIds: contenderLaneIds,
        now: "2026-07-28T01:01:12.002Z",
      });
      expect(observerSchedule.readyLanes.map((lane) => lane.id)).toEqual([
        "lane-observer-a",
        "lane-observer-b",
      ]);
      expect(observerSchedule.readyLanes.every((lane) => lane.runtimePolicy.sandbox === "read-only")).toBe(true);
      expect(observerSchedule.projection.lanes.filter((lane) => lane.id.startsWith("lane-writer-contender")))
        .toEqual([
          expect.objectContaining({
            id: "lane-writer-contender-a",
            status: "pending",
            runtimePolicy: expect.objectContaining({ sandbox: "workspace-write" }),
          }),
          expect.objectContaining({
            id: "lane-writer-contender-b",
            status: "pending",
            runtimePolicy: expect.objectContaining({ sandbox: "danger-full-access" }),
          }),
        ]);
      expect(contender.scheduleReadyLanes("session-writer-contender", {
        allowedParallelism: 4,
        authorizedLaneIds: contenderLaneIds,
        now: "2026-07-28T01:01:12.003Z",
      }).readyLanes).toEqual([]);

      owner.recordRunResult({
        sessionId: "session-writer-owner",
        laneId: "lane-writer-owner",
        segmentId: "segment-session-writer-owner-lane-writer-owner",
        runId: "run-session-writer-owner-lane-writer-owner",
        agentKind: "codex",
        outputSummary: "Owner writer completed.",
        evidence: {
          runId: "run-session-writer-owner-lane-writer-owner",
          status: "succeeded",
          exitCode: 0,
          changesetId: "changeset-writer-owner",
          checks: [{ kind: "test", name: "owner writer", status: "passed", detail: "passed" }],
          artifacts: [],
          review: null,
          errorReason: null,
          cancelReason: null,
          completedAt: "2026-07-28T01:01:13.000Z",
        },
        now: "2026-07-28T01:01:13.000Z",
      });

      const loserSchedule = contender.scheduleReadyLanes("session-writer-contender", {
        allowedParallelism: 4,
        authorizedLaneIds: contenderLaneIds,
        now: "2026-07-28T01:01:14.000Z",
      });
      expect(loserSchedule.readyLanes.map((lane) => lane.id)).toEqual(["lane-writer-contender-a"]);
      expect(loserSchedule.readyLanes[0]?.runtimePolicy.sandbox).toBe("workspace-write");
      expect(loserSchedule.projection.lanes.find((lane) => lane.id === "lane-writer-contender-b")?.status)
        .toBe("pending");

      const ownerEvents = owner.listEvents("session-writer-owner");
      const contenderEvents = contender.listEvents("session-writer-contender");
      expect(contender.scheduleReadyLanes("session-writer-contender", {
        allowedParallelism: 4,
        authorizedLaneIds: contenderLaneIds,
        now: "2026-07-28T01:01:15.000Z",
      }).readyLanes).toEqual([]);
      expect(contender.listEvents("session-writer-contender")).toEqual(contenderEvents);
      owner.close();
      ownerClosed = true;

      const reopened = createWorkflowStore({ projectRoot });
      try {
        expect(reopened.listEvents("session-writer-owner")).toEqual(ownerEvents);
        expect(reopened.listEvents("session-writer-contender")).toEqual(contenderEvents);
        expect(reopened.scheduleReadyLanes("session-writer-contender", {
          allowedParallelism: 4,
          authorizedLaneIds: contenderLaneIds,
          now: "2026-07-28T01:01:16.000Z",
        }).readyLanes).toEqual([]);
        expect(reopened.listEvents("session-writer-contender")).toEqual(contenderEvents);
      } finally {
        reopened.close();
      }
    } finally {
      if (!ownerClosed) owner.close();
      contender.close();
    }
  });

  it("preserves cross-session current-branch scopes while backfilling disjoint observers", async () => {
    const projectRoot = await makeTempRoot();
    const seed = createWorkflowStore({ projectRoot });
    try {
      for (const [sessionId, now] of [
        ["session-scope-owner", "2026-07-28T01:01:16.000Z"],
        ["session-scope-contender", "2026-07-28T01:01:16.001Z"],
      ] as const) {
        seed.createWorkflowSession({
          id: sessionId,
          projectId: "project-1",
          title: sessionId,
          goal: "Preserve authoritative scopes across current-branch sessions.",
          mode: "fast",
          target: { executionTarget: "current_branch", selectedBranch: "main" },
          plannerProfile: "default",
          transport: "hermes_replay_recovery",
          recoveryReason: "Test setup has no live Hermes session.",
          now,
        });
      }
      for (const [sessionId, laneId, kind, fileScopes] of [
        ["session-scope-owner", "lane-scope-owner", "implementation", ["src/shared.ts"]],
        ["session-scope-owner", "lane-scope-observer", "validation", ["src/observed.ts"]],
        ["session-scope-contender", "lane-blocked-writer", "implementation", ["src/writer.ts"]],
        ["session-scope-contender", "lane-shared-observer", "validation", ["src/shared.ts"]],
        ["session-scope-contender", "lane-observed-observer", "review", ["src/observed.ts"]],
        ["session-scope-contender", "lane-disjoint-observer", "review", ["src/disjoint.ts"]],
      ] as const) {
        appendTestFlowEvent(seed, "workflow.lane.declared", {
          lane: {
            id: laneId,
            semanticKey: laneId,
            kind,
            title: laneId,
            agentKind: "codex",
            status: "pending",
            fileScopes,
            packageScopes: [],
          },
        }, `test-lane:${laneId}`, sessionId);
      }
    } finally {
      seed.close();
    }

    const owner = createWorkflowStore({ projectRoot });
    const contender = createWorkflowStore({ projectRoot });
    let contenderClosed = false;
    try {
      expect(owner.scheduleReadyLanes("session-scope-owner", {
        allowedParallelism: 2,
        now: "2026-07-28T01:01:16.002Z",
      }).readyLanes.map((lane) => lane.id)).toEqual(["lane-scope-owner", "lane-scope-observer"]);

      const scheduled = contender.scheduleReadyLanes("session-scope-contender", {
        allowedParallelism: 2,
        now: "2026-07-28T01:01:16.003Z",
      });
      expect(scheduled.readyLanes.map((lane) => lane.id)).toEqual(["lane-disjoint-observer"]);
      expect(scheduled.projection.lanes.find((lane) => lane.id === "lane-blocked-writer")?.status)
        .toBe("pending");
      expect(scheduled.projection.lanes.find((lane) => lane.id === "lane-shared-observer")?.status)
        .toBe("pending");
      expect(scheduled.projection.lanes.find((lane) => lane.id === "lane-observed-observer")?.status)
        .toBe("pending");

      const contenderEvents = contender.listEvents("session-scope-contender");
      expect(contender.scheduleReadyLanes("session-scope-contender", {
        allowedParallelism: 2,
        now: "2026-07-28T01:01:16.004Z",
      }).readyLanes).toEqual([]);
      expect(contender.listEvents("session-scope-contender")).toEqual(contenderEvents);
      contender.close();
      contenderClosed = true;

      const reopened = createWorkflowStore({ projectRoot });
      try {
        expect(reopened.scheduleReadyLanes("session-scope-contender", {
          allowedParallelism: 2,
          now: "2026-07-28T01:01:16.005Z",
        }).readyLanes).toEqual([]);
        expect(reopened.listEvents("session-scope-contender")).toEqual(contenderEvents);
        expect(reopened.materializeFlowProjection("session-scope-contender").lanes
          .find((lane) => lane.id === "lane-shared-observer")?.status).toBe("pending");
      } finally {
        reopened.close();
      }
    } finally {
      owner.close();
      if (!contenderClosed) contender.close();
    }
  });

  it("fails closed for a writer when stored and projected running run identities conflict", async () => {
    const projectRoot = await makeTempRoot();
    const seed = createWorkflowStore({ projectRoot });
    try {
      for (const [sessionId, now] of [
        ["session-run-owner", "2026-07-28T01:01:16.100Z"],
        ["session-run-contender", "2026-07-28T01:01:16.101Z"],
      ] as const) {
        seed.createWorkflowSession({
          id: sessionId,
          projectId: "project-1",
          title: sessionId,
          goal: "Fail closed when running run identity is ambiguous.",
          mode: "fast",
          target: { executionTarget: "current_branch", selectedBranch: "main" },
          plannerProfile: "default",
          transport: "hermes_replay_recovery",
          recoveryReason: "Test setup has no live Hermes session.",
          now,
        });
      }
      for (const [sessionId, laneId, kind, fileScopes] of [
        ["session-run-owner", "lane-run-observer", "validation", ["src/observed.ts"]],
        ["session-run-contender", "lane-run-writer", "implementation", ["src/writer.ts"]],
        ["session-run-contender", "lane-run-disjoint", "review", ["src/disjoint.ts"]],
      ] as const) {
        appendTestFlowEvent(seed, "workflow.lane.declared", {
          lane: {
            id: laneId,
            semanticKey: laneId,
            kind,
            title: laneId,
            agentKind: "codex",
            status: "pending",
            fileScopes,
            packageScopes: [],
          },
        }, `test-lane:${laneId}`, sessionId);
      }
    } finally {
      seed.close();
    }

    const owner = createWorkflowStore({ projectRoot });
    const running = owner.scheduleReadyLanes("session-run-owner", {
      allowedParallelism: 1,
      now: "2026-07-28T01:01:16.102Z",
    }).readyLanes[0];
    expect(running).toEqual(expect.objectContaining({ id: "lane-run-observer" }));
    owner.close();
    if (!running) throw new Error("Expected the run-owner observer to be running.");

    const conflictingRunId = `${running.runId}-stored-conflict`;
    const db = new Database(join(projectRoot, ".devflow", "skyturn-workflow.sqlite"));
    db.pragma("foreign_keys = OFF");
    db.prepare([
      "INSERT INTO workflow_segments",
      "(id, session_id, lane_id, parent_segment_id, run_id, agent_kind, transport, status, worktree_path,",
      " started_at, ended_at, exit_code, evidence_json, error_reason, legacy_evidence_compatibility)",
      "VALUES (?, ?, ?, NULL, ?, ?, ?, 'running', ?, ?, NULL, NULL, NULL, NULL, 0)",
    ].join(" ")).run(
      running.segmentId,
      "session-run-owner",
      running.id,
      conflictingRunId,
      running.agentKind,
      "agent-bridge",
      projectRoot,
      "2026-07-28T01:01:16.102Z",
    );
    db.close();

    const contender = createWorkflowStore({ projectRoot });
    const scheduled = contender.scheduleReadyLanes("session-run-contender", {
      allowedParallelism: 2,
      now: "2026-07-28T01:01:16.103Z",
    });
    expect(scheduled.readyLanes.map((lane) => lane.id)).toEqual(["lane-run-disjoint"]);
    expect(scheduled.projection.lanes.find((lane) => lane.id === "lane-run-writer")?.status).toBe("pending");
    expect(contender.materializeFlowProjection("session-run-owner").segments).toEqual([
      expect.objectContaining({ id: running.segmentId, laneId: running.id, runId: running.runId, status: "running" }),
    ]);
    const contenderEvents = contender.listEvents("session-run-contender");
    contender.close();

    const verifyDb = new Database(join(projectRoot, ".devflow", "skyturn-workflow.sqlite"), { readonly: true });
    expect((verifyDb.prepare("SELECT run_id FROM workflow_segments WHERE id = ?")
      .get(running.segmentId) as { run_id: string }).run_id).toBe(conflictingRunId);
    verifyDb.close();

    const reopened = createWorkflowStore({ projectRoot });
    try {
      expect(reopened.scheduleReadyLanes("session-run-contender", {
        allowedParallelism: 2,
        now: "2026-07-28T01:01:16.104Z",
      }).readyLanes).toEqual([]);
      expect(reopened.listEvents("session-run-contender")).toEqual(contenderEvents);
    } finally {
      reopened.close();
    }
  });

  it("backfills current-branch observer capacity when another session owns the writer slot", async () => {
    const projectRoot = await makeTempRoot();
    const store = createWorkflowStore({ projectRoot });
    for (const [sessionId, now] of [
      ["session-writer-owner", "2026-07-28T01:01:17.000Z"],
      ["session-observer-contender", "2026-07-28T01:01:18.000Z"],
    ] as const) {
      store.createWorkflowSession({
        id: sessionId,
        projectId: "project-1",
        title: sessionId,
        goal: "Fill current-branch scheduling capacity without a second writer.",
        mode: "fast",
        target: { executionTarget: "current_branch", selectedBranch: "main" },
        plannerProfile: "default",
        transport: "hermes_replay_recovery",
        recoveryReason: "Test setup has no live Hermes session.",
        now,
      });
    }
    for (const [sessionId, laneId, kind] of [
      ["session-writer-owner", "lane-writer-owner", "implementation"],
      ["session-observer-contender", "lane-writer", "implementation"],
      ["session-observer-contender", "lane-observer-1", "validation"],
      ["session-observer-contender", "lane-observer-2", "review"],
    ] as const) {
      appendTestFlowEvent(store, "workflow.lane.declared", {
        lane: {
          id: laneId,
          semanticKey: laneId,
          kind,
          title: laneId,
          agentKind: "codex",
          status: "pending",
        },
      }, `test-lane:${laneId}`, sessionId);
    }

    expect(store.scheduleReadyLanes("session-writer-owner", {
      allowedParallelism: 1,
      now: "2026-07-28T01:01:19.000Z",
    }).readyLanes.map((lane) => lane.id)).toEqual(["lane-writer-owner"]);

    const scheduled = store.scheduleReadyLanes("session-observer-contender", {
      allowedParallelism: 2,
      authorizedLaneIds: ["lane-writer"],
      now: "2026-07-28T01:01:20.000Z",
    });
    expect(scheduled.readyLanes.map((lane) => lane.id)).toEqual([
      "lane-observer-1",
      "lane-observer-2",
    ]);
    expect(scheduled.readyLanes.every((lane) => lane.runtimePolicy.sandbox === "read-only")).toBe(true);
    expect(scheduled.projection.lanes.find((lane) => lane.id === "lane-writer")?.status).toBe("pending");

    const contenderEvents = store.listEvents("session-observer-contender");
    expect(store.scheduleReadyLanes("session-observer-contender", {
      allowedParallelism: 2,
      now: "2026-07-28T01:01:21.000Z",
    }).readyLanes).toEqual([]);
    expect(store.listEvents("session-observer-contender")).toEqual(contenderEvents);
    store.close();

    const reopened = createWorkflowStore({ projectRoot });
    try {
      expect(reopened.scheduleReadyLanes("session-observer-contender", {
        allowedParallelism: 2,
        now: "2026-07-28T01:01:22.000Z",
      }).readyLanes).toEqual([]);
      expect(reopened.listEvents("session-observer-contender")).toEqual(contenderEvents);
      expect(reopened.materializeFlowProjection("session-observer-contender").lanes
        .find((lane) => lane.id === "lane-writer")?.status).toBe("pending");
    } finally {
      reopened.close();
    }
  });

  it("fails closed for a current-branch writer when a running policy is unresolved", async () => {
    const projectRoot = await makeTempRoot();
    const seed = createWorkflowStore({ projectRoot });
    let unresolvedPlannerLaneId = "";
    try {
      for (const [sessionId, now] of [
        ["session-unknown-owner", "2026-07-28T01:01:20.000Z"],
        ["session-unknown-contender", "2026-07-28T01:01:21.000Z"],
      ] as const) {
        const session = seed.createWorkflowSession({
          id: sessionId,
          projectId: "project-1",
          title: sessionId,
          goal: "Exercise fail-closed current-branch scheduling.",
          mode: "fast",
          target: { executionTarget: "current_branch", selectedBranch: "main" },
          plannerProfile: "default",
          transport: "hermes_replay_recovery",
          recoveryReason: "Test setup has no live Hermes session.",
          now,
        });
        if (sessionId === "session-unknown-owner") unresolvedPlannerLaneId = session.plannerLaneId;
      }
      seed.claimPlannerRunStart({
        sessionId: "session-unknown-owner",
        laneId: unresolvedPlannerLaneId,
        runId: "run-unresolved-running",
        agentKind: "hermes",
        worktreePath: projectRoot,
        now: "2026-07-28T01:01:21.500Z",
      });
      for (const [laneId, kind] of [
        ["lane-blocked-writer", "implementation"],
        ["lane-allowed-observer", "validation"],
      ] as const) {
        appendTestFlowEvent(seed, "workflow.lane.declared", {
          lane: {
            id: laneId,
            semanticKey: laneId,
            kind,
            title: laneId,
            agentKind: "codex",
            status: "pending",
          },
        }, `test-lane:${laneId}`, "session-unknown-contender");
      }
    } finally {
      seed.close();
    }

    const owner = createWorkflowStore({ projectRoot });
    const contender = createWorkflowStore({ projectRoot });
    try {
      const unresolvedBefore = owner.listRunningSegments()
        .filter((segment) => segment.sessionId === "session-unknown-owner");
      expect(unresolvedBefore).toEqual([expect.objectContaining({
        laneId: unresolvedPlannerLaneId,
        runId: "run-unresolved-running",
        status: "running",
      })]);

      const scheduled = contender.scheduleReadyLanes("session-unknown-contender", {
        allowedParallelism: 2,
        now: "2026-07-28T01:01:22.000Z",
      });
      expect(scheduled.readyLanes.map((lane) => lane.id)).toEqual(["lane-allowed-observer"]);
      expect(scheduled.projection.lanes.find((lane) => lane.id === "lane-blocked-writer")?.status)
        .toBe("pending");
      expect(owner.listRunningSegments().filter((segment) => segment.sessionId === "session-unknown-owner"))
        .toEqual(unresolvedBefore);
    } finally {
      owner.close();
      contender.close();
    }

    const reopened = createWorkflowStore({ projectRoot });
    try {
      expect(reopened.scheduleReadyLanes("session-unknown-contender", {
        allowedParallelism: 2,
        now: "2026-07-28T01:01:23.000Z",
      }).readyLanes).toEqual([]);
      expect(reopened.listRunningSegments().filter((segment) => segment.sessionId === "session-unknown-owner"))
        .toEqual([expect.objectContaining({
          laneId: unresolvedPlannerLaneId,
          runId: "run-unresolved-running",
          status: "running",
        })]);
    } finally {
      reopened.close();
    }
  });

  it("starts distinct persisted candidates through independently opened scheduling stores", async () => {
    const projectRoot = await makeTempRoot();
    const seed = createWorkflowStore({ projectRoot });
    try {
      seedStore(seed, newWorktreeTarget());
      appendTestLane(seed, "lane-root-a", "pending", "implementation", {
        fileScopes: ["packages/root-a/**"],
        packageScopes: ["@skyturn/root-a"],
      });
      appendTestLane(seed, "lane-root-b", "pending", "implementation", {
        fileScopes: ["packages/root-b/**"],
        packageScopes: ["@skyturn/root-b"],
      });
      appendCandidateBinding(seed, "lane-root-a", "candidate-a", "lineage-candidate-a");
      appendCandidateBinding(seed, "lane-root-b", "candidate-b", "lineage-candidate-b");
    } finally {
      seed.close();
    }

    const stores = [
      createWorkflowStore({ projectRoot }),
      createWorkflowStore({ projectRoot }),
    ];
    try {
      expect(stores.map((store) => store.materializeFlowProjection("session-1").segments)).toEqual([[], []]);
      // Both handles materialize the empty projection before either queued call, so the second transaction must
      // rematerialize the first handle's committed SQLite state before deciding that the distinct candidate can run.
      const scheduled = await Promise.all([
        Promise.resolve().then(() => stores[0]!.scheduleReadyLanes("session-1", {
          allowedParallelism: 2,
          authorizedLaneIds: ["lane-root-a"],
          now: "2026-07-28T01:02:00.000Z",
        })),
        Promise.resolve().then(() => stores[1]!.scheduleReadyLanes("session-1", {
          allowedParallelism: 2,
          authorizedLaneIds: ["lane-root-b"],
          now: "2026-07-28T01:02:00.001Z",
        })),
      ]);

      expect(scheduled.map((result) => result.readyLanes.map((lane) => lane.id))).toEqual([
        ["lane-root-a"],
        ["lane-root-b"],
      ]);
      const projection = stores[0]!.materializeFlowProjection("session-1");
      const runningSegments = projection.segments.filter((segment) => segment.status === "running");
      const identities = projection.candidateBindings.map((binding) =>
        `${binding.lineageId}\0${binding.worktreeId}`
      );
      expect(runningSegments.map((segment) => segment.laneId).sort()).toEqual(["lane-root-a", "lane-root-b"]);
      expect(new Set(identities)).toHaveLength(2);
    } finally {
      try {
        stores[0]!.close();
      } finally {
        stores[1]!.close();
      }
    }

    const reopened = createWorkflowStore({ projectRoot });
    try {
      const projection = reopened.materializeFlowProjection("session-1");
      const rootSegments = projection.segments.filter((segment) =>
        segment.laneId === "lane-root-a" || segment.laneId === "lane-root-b"
      );
      const rootBindings = projection.candidateBindings.filter((binding) =>
        binding.laneId === "lane-root-a" || binding.laneId === "lane-root-b"
      );
      expect(rootSegments).toHaveLength(2);
      expect(rootSegments.every((segment) => segment.status === "running")).toBe(true);
      expect(new Set(rootSegments.map((segment) => segment.id))).toHaveLength(2);
      expect(rootBindings).toHaveLength(2);
      expect(new Set(rootBindings.map((binding) => binding.laneId))).toHaveLength(2);
      expect(new Set(rootBindings.map((binding) => `${binding.lineageId}\0${binding.worktreeId}`))).toHaveLength(2);
    } finally {
      reopened.close();
    }
  });

  it("treats exact candidate retries as zero-write and rejects same-key conflicts", async () => {
    const exact = await makeNewWorktreeStore();
    appendTestLane(exact, "lane-occupier");
    appendTestLane(exact, "lane-root");
    appendCandidateBinding(exact, "lane-occupier", "candidate", "lineage-session-1-candidate");
    appendCandidateBinding(
      exact,
      "lane-root",
      "candidate",
      "lineage-session-1-candidate",
      [],
      "default",
      "candidate-binding:lane-root:bound",
    );
    appendTestFlowEvent(exact, "workflow.segment.started", {
      laneId: "lane-occupier",
      segment: {
        id: "segment-occupier",
        laneId: "lane-occupier",
        runId: "run-occupier",
        status: "running",
      },
    }, "test-segment:occupier");
    const exactEvents = exact.listEvents("session-1");
    expect(scheduleLaneIds(exact, "2026-07-28T01:10:00.000Z")).toEqual([]);
    expect(exact.listEvents("session-1")).toEqual(exactEvents);
    exact.close();

    const conflict = await makeNewWorktreeStore();
    appendTestLane(conflict, "lane-root");
    appendCandidateBinding(
      conflict,
      "lane-other",
      "other",
      "lineage-other",
      [],
      "default",
      "candidate-binding:lane-root:bound",
    );
    const conflictEvents = conflict.listEvents("session-1");
    expect(() => scheduleLaneIds(conflict, "2026-07-28T01:10:01.000Z")).toThrow(/candidate binding conflicts/i);
    expect(conflict.listEvents("session-1")).toEqual(conflictEvents);
    conflict.close();
  });

  it("persists mixed-lineage fan-in blocks and allows a later exact binding to clear them", async () => {
    const projectRoot = await makeTempRoot();
    const store = createWorkflowStore({ projectRoot });
    seedStore(store, newWorktreeTarget());
    for (const laneId of ["lane-a", "lane-b"]) appendTestLane(store, laneId, "completed");
    appendTestLane(store, "lane-join", "pending", "integration_join");
    appendTestEdge(store, "lane-a", "lane-join");
    appendTestEdge(store, "lane-b", "lane-join");
    appendCandidateBinding(store, "lane-a", "a", "lineage-a");
    appendCandidateBinding(store, "lane-b", "b", "lineage-b");

    expect(scheduleLaneIds(store, "2026-07-28T02:00:00.000Z")).toEqual([]);
    expect(store.materializeFlowProjection("session-1").candidateBindingBlocks[0]).toMatchObject({
      laneId: "lane-join",
      reason: "ambiguous_predecessor_lineage",
      predecessorLaneIds: ["lane-a", "lane-b"],
      lineageIds: ["lineage-a", "lineage-b"],
    });
    expect(store.materializeFlowProjection("session-1").segments).toEqual([]);
    store.close();

    const reopened = createWorkflowStore({ projectRoot });
    expect(scheduleLaneIds(reopened, "2026-07-28T02:00:01.000Z")).toEqual([]);
    appendCandidateBinding(reopened, "lane-join", "a", "lineage-a", ["lane-a", "lane-b"], "explicit_join");
    expect(scheduleLaneIds(reopened, "2026-07-28T02:00:02.000Z")).toEqual(["lane-join"]);
    reopened.close();
  });

  it("backfills legacy predecessor worktrees exactly and blocks distinct legacy identities", async () => {
    const store = await makeNewWorktreeStore();
    for (const laneId of ["lane-a", "lane-b"]) appendTestLane(store, laneId, "completed");
    appendTestLane(store, "lane-serial");
    appendTestLane(store, "lane-join", "pending", "integration_join");
    appendTestLane(store, "lane-invalid-source", "completed");
    appendTestLane(store, "lane-invalid");
    appendTestEdge(store, "lane-a", "lane-serial");
    appendTestEdge(store, "lane-a", "lane-join");
    appendTestEdge(store, "lane-b", "lane-join");
    appendTestEdge(store, "lane-invalid-source", "lane-invalid");
    const projectRoot = dirname(dirname(store.databasePath));
    appendWorktreeCreated(store, candidateWorktree(projectRoot, "legacy-a", "lane-a"));
    appendWorktreeCreated(store, candidateWorktree(projectRoot, "legacy-b", "lane-b"));
    appendWorktreeCreated(store, {
      ...candidateWorktree(projectRoot, "legacy-invalid", "lane-invalid-source"),
      worktreeId: "worktree-session-1-mismatch",
    });

    expect(scheduleLaneIds(store, "2026-07-28T03:00:00.000Z", 2)).toEqual(["lane-serial"]);
    const projection = store.materializeFlowProjection("session-1");
    expect(projection.candidateBindings.find((binding) => binding.laneId === "lane-a"))
      .toMatchObject(candidateBindingFacts("legacy-a"));
    expect(projection.candidateBindings.find((binding) => binding.laneId === "lane-serial"))
      .toMatchObject(candidateBindingFacts("legacy-a"));
    expect(projection.candidateBindingBlocks.find((block) => block.laneId === "lane-join"))
      .toMatchObject({ lineageIds: ["lineage-session-1-legacy-a", "lineage-session-1-legacy-b"] });
    expect(projection.candidateBindings.some((binding) => binding.laneId === "lane-invalid")).toBe(false);
    expect(projection.segments.some((segment) => segment.laneId === "lane-invalid")).toBe(false);
    store.close();
  });

  it("fails closed when one legacy predecessor owns two valid physical worktree identities", async () => {
    const projectRoot = await makeTempRoot();
    const store = createWorkflowStore({ projectRoot });
    try {
      seedStore(store, newWorktreeTarget());
      appendTestLane(store, "lane-source", "completed");
      appendTestLane(store, "lane-downstream");
      appendTestEdge(store, "lane-source", "lane-downstream");
      appendWorktreeCreated(store, candidateWorktree(projectRoot, "legacy-a", "lane-source"));
      appendWorktreeCreated(store, candidateWorktree(projectRoot, "legacy-b", "lane-source"));

      expect(store.previewReadyLanes("session-1", { allowedParallelism: 2 }).readyLanes.map((lane) => lane.id))
        .toEqual(["lane-downstream"]);
      expect(scheduleLaneIds(store, "2026-07-28T03:01:00.000Z", 2)).toEqual([]);
      const projection = store.materializeFlowProjection("session-1");
      const sourceWorktrees = projection.worktrees.filter((worktree) => worktree.parentLaneId === "lane-source");
      expect(sourceWorktrees.map((worktree) => ({
        worktreeId: worktree.worktreeId,
        variantId: worktree.variantId,
        parentLaneId: worktree.parentLaneId,
      }))).toEqual([
        {
          worktreeId: "worktree-session-1-legacy-a",
          variantId: "legacy-a",
          parentLaneId: "lane-source",
        },
        {
          worktreeId: "worktree-session-1-legacy-b",
          variantId: "legacy-b",
          parentLaneId: "lane-source",
        },
      ]);
      expect(projection.candidateBindings).toEqual([]);
      expect(projection.candidateBindingBlocks).toEqual([]);
      expect(projection.segments).toEqual([]);
    } finally {
      store.close();
    }

    const reopened = createWorkflowStore({ projectRoot });
    try {
      expect(reopened.previewReadyLanes("session-1", { allowedParallelism: 2 }).readyLanes.map((lane) => lane.id))
        .toEqual(["lane-downstream"]);
      expect(scheduleLaneIds(reopened, "2026-07-28T03:01:01.000Z", 2)).toEqual([]);
      const projection = reopened.materializeFlowProjection("session-1");
      expect(projection.worktrees.filter((worktree) => worktree.parentLaneId === "lane-source")).toHaveLength(2);
      expect(projection.candidateBindings).toEqual([]);
      expect(projection.candidateBindingBlocks).toEqual([]);
      expect(projection.segments).toEqual([]);
    } finally {
      reopened.close();
    }
  });

  it("binds a new-worktree repair to the selected after-checkpoint candidate before scheduling", async () => {
    const projectRoot = await makeTempRoot();
    const store = createWorkflowStore({ projectRoot });
    seedStore(store, newWorktreeTarget());
    appendTestLane(store, "lane-source", "completed");
    appendCandidateBinding(store, "lane-source", "source", "lineage-source");
    recordNewWorktreeCheckpoint(store, "checkpoint-after-source", "lane-source", "after", "source", "a".repeat(40));

    const eventCountBeforeRequest = store.listEvents("session-1").length;
    store.requestNodeRepair({
      sessionId: "session-1",
      laneId: "lane-source",
      checkpointId: "checkpoint-after-source",
      intentId: "repair-bound-source",
      successorLaneId: "lane-repair",
      successorSemanticKey: "repair:lane-source:bound",
      now: "2026-07-28T03:10:01.000Z",
    });
    const projection = store.materializeFlowProjection("session-1");
    expect(projection.candidateBindings.find((binding) => binding.laneId === "lane-repair")).toEqual({
      sessionId: "session-1",
      laneId: "lane-repair",
      variantId: "source",
      worktreeId: "worktree-session-1-source",
      lineageId: "lineage-source",
      reason: "repair",
      predecessorLaneIds: ["lane-source"],
      sourceCheckpointId: "checkpoint-after-source",
      sourceHeadCommit: "a".repeat(40),
    });
    expect(store.listEvents("session-1").slice(eventCountBeforeRequest).map((event) => event.kind)).toEqual([
      "workflow.lane.declared",
      "workflow.edge.declared",
      "workflow.lane.candidate_bound",
      "workflow.node.repair_requested",
    ]);
    recordNewWorktreeCheckpoint(
      store, "checkpoint-after-mismatch", "lane-source", "after", "other", "b".repeat(40),
    );
    const eventsBeforeMismatch = store.listEvents("session-1");
    expect(() => store.requestNodeRepair({
      sessionId: "session-1",
      laneId: "lane-source",
      checkpointId: "checkpoint-after-mismatch",
      successorLaneId: "lane-repair-mismatch",
      successorSemanticKey: "repair:lane-source:mismatch",
      now: "2026-07-28T03:10:02.000Z",
    })).toThrow(/binding conflicts.*checkpoint worktree/i);
    expect(store.listEvents("session-1")).toEqual(eventsBeforeMismatch);
    store.close();

    const reopened = createWorkflowStore({ projectRoot });
    expect(reopened.materializeFlowProjection("session-1").candidateBindings)
      .toContainEqual(expect.objectContaining({ laneId: "lane-repair", reason: "repair", lineageId: "lineage-source" }));
    reopened.close();
  });

  it("binds failed-evidence repair and regression lanes to one serialized candidate in deterministic order", async () => {
    const projectRoot = await makeTempRoot();
    const store = createWorkflowStore({ projectRoot });
    seedStore(store, newWorktreeTarget());
    declareCodeChangeWorkflow(store);
    advanceCodeChangeWorkflowToLane(store, "lane-implementation");
    store.recordRunResult(runResultInput(store, "lane-implementation", "failed", "2026-07-28T03:20:00.000Z"));
    recordNewWorktreeCheckpoint(
      store, "checkpoint-after-implementation", "lane-implementation", "after", "candidate", "b".repeat(40),
    );
    const eventCountBeforeRequest = store.listEvents("session-1").length;

    store.requestNodeRepair({
      sessionId: "session-1",
      laneId: "lane-implementation",
      checkpointId: "checkpoint-after-implementation",
      intentId: "repair-failed-source",
      successorLaneId: "lane-repair",
      successorSemanticKey: "repair:lane-implementation:failed",
      now: "2026-07-28T03:20:01.000Z",
    });
    const projection = store.materializeFlowProjection("session-1");
    const repair = projection.candidateBindings.find((binding) => binding.laneId === "lane-repair");
    const regression = projection.candidateBindings.find((binding) => binding.laneId === "lane-repair-regression");
    expect(repair).toMatchObject({
      ...candidateBindingFacts("candidate"),
      reason: "repair",
      predecessorLaneIds: ["lane-implementation"],
      sourceCheckpointId: "checkpoint-after-implementation",
      sourceHeadCommit: "b".repeat(40),
    });
    expect(regression).toEqual({
      ...repair!,
      laneId: "lane-repair-regression",
      reason: "regression",
      predecessorLaneIds: ["lane-repair"],
    });
    expect(store.listEvents("session-1").slice(eventCountBeforeRequest)
      .filter((event) => event.kind === "workflow.lane.candidate_bound")
      .map((event) => event.laneId)).toEqual(["lane-repair", "lane-repair-regression"]);

    expect(scheduleLaneIds(store, "2026-07-28T03:20:02.000Z", 2)).toEqual(["lane-repair"]);
    expect(scheduleLaneIds(store, "2026-07-28T03:20:03.000Z", 2)).toEqual([]);
    store.recordRunResult(runResultInput(store, "lane-repair", "succeeded", "2026-07-28T03:20:04.000Z"));
    expect(scheduleLaneIds(store, "2026-07-28T03:20:05.000Z", 2)).toEqual(["lane-repair-regression"]);
    store.close();

    const reopened = createWorkflowStore({ projectRoot });
    expect(reopened.materializeFlowProjection("session-1").candidateBindings)
      .toEqual(expect.arrayContaining([repair, regression]));
    reopened.close();
  });


  it("allocates a full-digest variant candidate that can run beside its occupied source candidate", async () => {
    const projectRoot = await makeTempRoot();
    const store = createWorkflowStore({ projectRoot });
    seedStore(store, newWorktreeTarget());
    appendTestLane(store, "lane-source");
    appendCandidateBinding(store, "lane-source", "source", "lineage-source");
    appendTestFlowEvent(store, "workflow.segment.started", {
      laneId: "lane-source",
      segment: { id: "segment-source", laneId: "lane-source", runId: "run-source", status: "running" },
    }, "test-segment:source");
    recordNewWorktreeCheckpoint(
      store, "checkpoint-before-source", "lane-source", "before", "source", "e".repeat(40),
    );

    const eventCountBeforeRequest = store.listEvents("session-1").length;
    store.requestNodeVariant({
      sessionId: "session-1",
      laneId: "lane-source",
      checkpointId: "checkpoint-before-source",
      intentId: "variant-intent-a",
      successorLaneId: "lane-variant-a",
      successorSemanticKey: "variant:lane-source:a",
      now: "2026-07-28T03:50:00.000Z",
    });
    expect(store.listEvents("session-1").slice(eventCountBeforeRequest).map((event) => event.kind)).toEqual([
      "workflow.lane.declared",
      "workflow.lane.candidate_bound",
      "workflow.node.variant_requested",
    ]);
    const binding = store.materializeFlowProjection("session-1").candidateBindings
      .find((candidate) => candidate.laneId === "lane-variant-a");
    expect(binding).toEqual({
      sessionId: "session-1",
      laneId: "lane-variant-a",
      variantId: expect.stringMatching(/^variant-[0-9a-f]{64}$/),
      worktreeId: expect.stringMatching(/^worktree-session-1-variant-[0-9a-f]{64}$/),
      lineageId: expect.stringMatching(/^lineage-[0-9a-f]{64}$/),
      reason: "variant",
      predecessorLaneIds: [],
      sourceCheckpointId: "checkpoint-before-source",
      sourceHeadCommit: "e".repeat(40),
    });
    expect(binding?.worktreeId).toBe(`worktree-session-1-${binding?.variantId}`);
    expect(binding?.lineageId).toBe(`lineage-${binding?.variantId.slice("variant-".length)}`);
    expect(binding?.variantId).not.toBe("source");
    expect(scheduleLaneIds(store, "2026-07-28T03:50:01.000Z", 2)).toEqual(["lane-variant-a"]);
    expect(store.materializeFlowProjection("session-1").segments.filter((segment) => segment.status === "running")
      .map((segment) => segment.laneId).sort()).toEqual(["lane-source", "lane-variant-a"]);
    expect(store.materializeCanvasSession("session-1")?.nodes.find((node) => node.id === "lane-variant-a"))
      .toMatchObject({
        candidateBinding: binding,
        worktree: {
          variantId: binding?.variantId,
          worktreeId: binding?.worktreeId,
          lineageId: binding?.lineageId,
        },
      });
    store.close();

    const reopened = createWorkflowStore({ projectRoot });
    expect(reopened.materializeFlowProjection("session-1").candidateBindings).toContainEqual(binding);
    reopened.close();
  });

  it("allocates distinct deterministic candidates for distinct variant requests and retries with zero writes", async () => {
    const store = await makeNewWorktreeStore();
    appendTestLane(store, "lane-source", "completed");
    appendCandidateBinding(store, "lane-source", "source", "lineage-source");
    recordNewWorktreeCheckpoint(
      store, "checkpoint-before-source", "lane-source", "before", "source", "f".repeat(40),
    );
    const request = (suffix: "a" | "b", now: string) => store.requestNodeVariant({
      sessionId: "session-1",
      laneId: "lane-source",
      checkpointId: "checkpoint-before-source",
      intentId: `variant-intent-${suffix}`,
      successorLaneId: `lane-variant-${suffix}`,
      successorSemanticKey: `variant:lane-source:${suffix}`,
      now,
    });
    const first = request("a", "2026-07-28T04:00:00.000Z");
    request("b", "2026-07-28T04:00:01.000Z");
    const eventsBeforeRetry = store.listEvents("session-1");
    const retry = request("a", "2026-07-28T04:00:02.000Z");
    const bindings = store.materializeFlowProjection("session-1").candidateBindings
      .filter((binding) => binding.laneId.startsWith("lane-variant-"));

    expect(retry.event.id).toBe(first.event.id);
    expect(store.listEvents("session-1")).toEqual(eventsBeforeRetry);
    expect(bindings).toHaveLength(2);
    expect(new Set(bindings.map((binding) => binding.variantId))).toHaveLength(2);
    expect(new Set(bindings.map((binding) => binding.worktreeId))).toHaveLength(2);
    expect(new Set(bindings.map((binding) => binding.lineageId))).toHaveLength(2);
    store.close();
  });

  it("allocates a full-digest variant for the longest accepted session identity", async () => {
    const sessionId = "s".repeat(200);
    const store = await makeStore();
    seedStore(store, newWorktreeTarget(), sessionId);
    appendTestFlowEvent(store, "workflow.lane.declared", {
      lane: {
        id: "lane-source",
        semanticKey: "lane-source",
        kind: "implementation",
        agentKind: "codex",
        status: "completed",
      },
    }, "test-lane:lane-source", sessionId);
    recordNewWorktreeCheckpoint(
      store, "checkpoint-before-long-session", "lane-source", "before", "source", "f".repeat(40), sessionId,
    );

    store.requestNodeVariant({
      sessionId,
      laneId: "lane-source",
      checkpointId: "checkpoint-before-long-session",
      intentId: "variant-long-session",
      successorLaneId: "lane-variant",
      successorSemanticKey: "variant:lane-source:long-session",
      now: "2026-07-28T04:05:00.000Z",
    });
    const binding = store.materializeFlowProjection(sessionId).candidateBindings
      .find((candidate) => candidate.laneId === "lane-variant");
    expect(binding?.variantId).toMatch(/^variant-[0-9a-f]{64}$/);
    expect(binding?.worktreeId).toBe(`worktree-${sessionId}-${binding?.variantId}`);
    expect(binding?.lineageId).toBe(`lineage-${binding?.variantId.slice("variant-".length)}`);
    store.close();
  });

  it.each(["repair", "variant"] as const)(
    "keeps current-branch %s successor event-compatible without candidate events",
    async (kind) => {
      const store = await makeSeededStore();
      appendTestLane(store, "lane-source", "completed");
      recordCheckpoint(
        store,
        `checkpoint-${kind}-source`,
        "lane-source",
        kind === "repair" ? "after" : "before",
        "1".repeat(40),
      );
      const eventsBefore = store.listEvents("session-1").length;
      const request = {
        sessionId: "session-1",
        laneId: "lane-source",
        checkpointId: `checkpoint-${kind}-source`,
        intentId: `${kind}-current-branch`,
        successorLaneId: `lane-${kind}`,
        successorSemanticKey: `${kind}:lane-source:current`,
        now: "2026-07-28T04:10:00.000Z",
      };
      if (kind === "repair") store.requestNodeRepair(request);
      else store.requestNodeVariant(request);

      expect(store.listEvents("session-1").slice(eventsBefore).map((event) => event.kind)).toEqual(
        kind === "repair"
          ? ["workflow.lane.declared", "workflow.edge.declared", "workflow.node.repair_requested"]
          : ["workflow.lane.declared", "workflow.node.variant_requested"],
      );
      expect(store.materializeFlowProjection("session-1").candidateBindings).toEqual([]);
      store.close();
    },
  );

  it("rejects a new-worktree checkpoint in a current-branch session before successor writes", async () => {
    const store = await makeSeededStore();
    appendTestLane(store, "lane-source", "completed");
    recordNewWorktreeCheckpoint(
      store, "checkpoint-variant-mixed-target", "lane-source", "before", "mixed", "1".repeat(40),
    );
    const eventsBefore = store.listEvents("session-1");

    expect(() => store.requestNodeVariant({
      sessionId: "session-1",
      laneId: "lane-source",
      checkpointId: "checkpoint-variant-mixed-target",
      intentId: "variant-mixed-target",
      successorLaneId: "lane-variant",
      successorSemanticKey: "variant:lane-source:mixed-target",
      now: "2026-07-28T04:15:00.000Z",
    })).toThrow(/execution target conflicts/i);
    expect(store.listEvents("session-1")).toEqual(eventsBefore);
    store.close();
  });

  it.each(["repair", "variant"] as const)(
    "keeps a preexisting unbound new-worktree %s retry on the legacy zero-write path",
    async (kind) => {
      const store = await makeNewWorktreeStore();
      appendTestLane(store, "lane-source", "completed");
      const checkpointId = `checkpoint-${kind}-historical`;
      const successorLaneId = `lane-${kind}-historical`;
      const successorSemanticKey = `${kind}:lane-source:historical`;
      const intentId = `${kind}-historical`;
      recordNewWorktreeCheckpoint(
        store, checkpointId, "lane-source", kind === "repair" ? "after" : "before", "historical", "2".repeat(40),
      );
      appendTestFlowEvent(store, "workflow.lane.declared", {
        lane: {
          id: successorLaneId,
          semanticKey: successorSemanticKey,
          kind: kind === "repair" ? "fix" : "implementation",
          agentKind: "codex",
          status: "pending",
        },
      }, `checkpoint-successor:${intentId}:lane`);
      if (kind === "repair") {
        appendTestFlowEvent(store, "workflow.edge.declared", {
          edge: {
            id: `edge-lane-source-${successorLaneId}`,
            sourceLaneId: "lane-source",
            targetLaneId: successorLaneId,
          },
        }, `checkpoint-successor:${intentId}:edge:lane-source:${successorLaneId}`);
      }
      appendTestFlowEvent(store, `workflow.node.${kind}_requested`, {
        intentId,
        laneId: "lane-source",
        nodeId: "lane-source",
        checkpointId,
        successorLaneId,
        successorSemanticKey,
      }, `checkpoint-successor:${intentId}:intent`);
      const eventsBeforeRetry = store.listEvents("session-1");
      const request = {
        sessionId: "session-1",
        laneId: "lane-source",
        checkpointId,
        intentId,
        successorLaneId,
        successorSemanticKey,
        now: "2026-07-28T04:20:00.000Z",
      };

      if (kind === "repair") store.requestNodeRepair(request);
      else store.requestNodeVariant(request);
      expect(store.listEvents("session-1")).toEqual(eventsBeforeRetry);
      expect(store.materializeFlowProjection("session-1").candidateBindings).toEqual([]);
      store.close();
    },
  );

  it.each(["variant", "fork"] as const)(
    "keeps an unbound new-worktree %s successor on the legacy scheduling path",
    async (kind) => {
      const store = await makeNewWorktreeStore();
      appendTestLane(store, "lane-source", "completed");
      appendTestLane(store, `lane-${kind}`);
      const checkpointId = `checkpoint-${kind}`;
      recordCheckpoint(store, checkpointId, "lane-source", "before", "a".repeat(40));
      appendTestFlowEvent(store, `workflow.node.${kind}_requested`, {
        intentId: `intent-${kind}`,
        laneId: "lane-source",
        nodeId: "lane-source",
        checkpointId,
        successorLaneId: `lane-${kind}`,
      }, `intent:${kind}`);

      expect(scheduleLaneIds(store, "2026-07-28T04:00:02.000Z")).toEqual([`lane-${kind}`]);
      expect(store.materializeFlowProjection("session-1").candidateBindings
        .some((binding) => binding.laneId === `lane-${kind}`)).toBe(false);
      store.close();
    },
  );

  it("keeps a newly requested repair from an unbound legacy source unbound", async () => {
    const store = await makeNewWorktreeStore();
    appendTestLane(store, "lane-implementation", "completed");
    recordNewWorktreeCheckpoint(
      store, "checkpoint-after-implementation", "lane-implementation", "after", "historical", "3".repeat(40),
    );
    store.requestNodeRepair({
      sessionId: "session-1",
      laneId: "lane-implementation",
      checkpointId: "checkpoint-after-implementation",
      successorLaneId: "lane-repair",
      successorSemanticKey: "repair:lane-implementation:pr1b",
      now: "2026-07-28T04:10:01.000Z",
    });
    const projection = store.materializeFlowProjection("session-1");
    expect(projection.lanes.some((lane) => lane.id === "lane-repair")).toBe(true);
    expect(projection.candidateBindings
      .some((binding) => binding.laneId === "lane-repair")).toBe(false);
    store.close();
  });

  it("rolls back the whole new-worktree successor transaction after checkpoint candidate insertion", async () => {
    let armed = true;
    const projectRoot = await makeTempRoot();
    const store = createWorkflowStore({
      projectRoot,
      faultInjection: {
        afterCheckpointCandidateEvents: () => {
          if (armed) throw new Error("injected checkpoint candidate failure");
        },
      },
    });
    seedStore(store, newWorktreeTarget());
    appendTestLane(store, "lane-source", "failed");
    appendCandidateBinding(store, "lane-source", "source", "lineage-source");
    appendFailedEvidence(
      store,
      "lane-source",
      "segment-session-1-lane-source",
      "evidence-failed-source",
      "source failed",
      "2026-07-28T04:29:59.000Z",
      "run-session-1-lane-source",
    );
    recordNewWorktreeCheckpoint(
      store, "checkpoint-after-source", "lane-source", "after", "source", "4".repeat(40),
    );
    const eventsBefore = store.listEvents("session-1");
    const projectionBefore = store.materializeFlowProjection("session-1");
    const request = {
      sessionId: "session-1",
      laneId: "lane-source",
      checkpointId: "checkpoint-after-source",
      intentId: "repair-after-fault",
      successorLaneId: "lane-repair",
      successorSemanticKey: "repair:lane-source:fault",
      now: "2026-07-28T04:30:00.000Z",
    };

    expect(() => store.requestNodeRepair(request)).toThrow("injected checkpoint candidate failure");
    expect(store.listEvents("session-1")).toEqual(eventsBefore);
    expect(store.materializeFlowProjection("session-1")).toEqual(projectionBefore);
    expect(store.materializeFlowProjection("session-1").lanes
      .some((lane) => lane.id === "lane-repair" || lane.id === "lane-repair-regression")).toBe(false);
    armed = false;
    expect(store.requestNodeRepair(request).status).toBe("requested");
    expect(store.materializeFlowProjection("session-1").candidateBindings)
      .toEqual(expect.arrayContaining([
        expect.objectContaining({ laneId: "lane-source", reason: "default" }),
        expect.objectContaining({ laneId: "lane-repair", reason: "repair" }),
        expect.objectContaining({ laneId: "lane-repair-regression", reason: "regression" }),
      ]));
    store.close();
  });

  it("rejects checkpoint candidate idempotency conflicts without partial successor writes", async () => {
    const store = await makeNewWorktreeStore();
    appendTestLane(store, "lane-source", "completed");
    recordNewWorktreeCheckpoint(
      store, "checkpoint-before-source", "lane-source", "before", "source", "5".repeat(40),
    );
    appendCandidateBinding(
      store,
      "lane-conflict",
      "conflict",
      "lineage-conflict",
      [],
      "default",
      "candidate-binding:lane-variant:bound",
    );
    const eventsBefore = store.listEvents("session-1");

    expect(() => store.requestNodeVariant({
      sessionId: "session-1",
      laneId: "lane-source",
      checkpointId: "checkpoint-before-source",
      intentId: "variant-conflict",
      successorLaneId: "lane-variant",
      successorSemanticKey: "variant:lane-source:conflict",
      now: "2026-07-28T04:40:00.000Z",
    })).toThrow(/candidate binding conflicts/i);
    expect(store.listEvents("session-1")).toEqual(eventsBefore);
    expect(store.materializeFlowProjection("session-1").lanes.some((lane) => lane.id === "lane-variant")).toBe(false);
    store.close();
  });

  it("rolls back both normal candidate binding and segment start when scheduling faults between them", async () => {
    let armed = false;
    const projectRoot = await makeTempRoot();
    const store = createWorkflowStore({
      projectRoot,
      faultInjection: {
        afterCandidateBindingBeforeSegment: () => {
          if (armed) throw new Error("injected candidate scheduling failure");
        },
      },
    });
    seedStore(store, newWorktreeTarget());
    appendTestLane(store, "lane-root");
    armed = true;

    expect(() => store.scheduleReadyLanes("session-1", {
      allowedParallelism: 1,
      now: "2026-07-28T05:00:00.000Z",
    })).toThrow("injected candidate scheduling failure");
    expect(store.materializeFlowProjection("session-1").candidateBindings).toEqual([]);
    expect(store.materializeFlowProjection("session-1").segments).toEqual([]);
    store.close();
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
      const readyLaneIds = store.previewReadyLanes("session-1", {
        allowedParallelism: 1,
      }).readyLanes.map((lane) => lane.id);
      const scheduled = store.scheduleReadyLanes("session-1", {
        allowedParallelism: 1,
        authorizedLaneIds: readyLaneIds,
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
          title: "Opaque verification step 51",
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

    const projectedLanes = store.materializeFlowProjection("session-1").lanes;
    expect(projectedLanes.find((lane) => lane.id === "lane-browser-omitted")).toMatchObject({
      laneKind: "validation",
      semanticSubtype: "browser_validation",
      requiredEvidence: ["browser", "screenshot"],
      runtimePolicy: { sandbox: "workspace-write" },
    });
    expect(projectedLanes.find((lane) => lane.id === "lane-browser-empty")).toMatchObject({
      laneKind: "validation",
      semanticSubtype: "browser_validation",
      requiredEvidence: ["browser", "screenshot"],
      runtimePolicy: { sandbox: "workspace-write" },
    });
    expect(projectedLanes.find((lane) => lane.id === "lane-browser-prose-neighbor")).toMatchObject({
      laneKind: "implementation",
      requiredEvidence: [],
      runtimePolicy: { sandbox: "workspace-write" },
    });

    const firstSchedule = store.scheduleReadyLanes("session-1", {
      allowedParallelism: 3,
      now: "2026-06-14T00:00:02.000Z",
    });
    expect(firstSchedule.readyLanes).toEqual([
      expect.objectContaining({
        id: "lane-browser-omitted",
        segmentId: "segment-session-1-lane-browser-omitted",
        runId: "run-session-1-lane-browser-omitted",
      }),
    ]);
    const firstWriter = firstSchedule.readyLanes[0]!;
    const firstEvidence = {
      ...terminalRunEvidence(
        firstWriter.runId,
        "succeeded",
        0,
        [{ kind: "run-exit", name: "Codex CLI exit", status: "passed" }],
        [],
      ),
      completedAt: "2026-06-14T00:00:03.000Z",
    } satisfies RunEvidence;

    store.recordRunResult({
      sessionId: "session-1",
      laneId: firstWriter.id,
      segmentId: firstWriter.segmentId,
      runId: firstWriter.runId,
      agentKind: "codex",
      outputSummary: "Browser screenshot captured successfully.",
      evidence: firstEvidence,
      now: firstEvidence.completedAt,
    });

    const secondSchedule = store.scheduleReadyLanes("session-1", {
      allowedParallelism: 3,
      now: "2026-06-14T00:00:04.000Z",
    });
    expect(secondSchedule.readyLanes).toEqual([
      expect.objectContaining({
        id: "lane-browser-empty",
        segmentId: "segment-session-1-lane-browser-empty",
        runId: "run-session-1-lane-browser-empty",
      }),
    ]);
    const secondWriter = secondSchedule.readyLanes[0]!;
    const secondEvidence = {
      ...terminalRunEvidence(
        secondWriter.runId,
        "succeeded",
        0,
        [
          { kind: "run-exit", name: "Codex CLI exit", status: "passed" },
          { kind: "artifact", name: "Expected artifacts", status: "passed" },
        ],
        [".devflow/acceptance/react-app.png"],
      ),
      completedAt: "2026-06-14T00:00:05.000Z",
    } satisfies RunEvidence;

    store.recordRunResult({
      sessionId: "session-1",
      laneId: secondWriter.id,
      segmentId: secondWriter.segmentId,
      runId: secondWriter.runId,
      agentKind: "codex",
      evidence: secondEvidence,
      now: secondEvidence.completedAt,
    });

    const thirdSchedule = store.scheduleReadyLanes("session-1", {
      allowedParallelism: 3,
      now: "2026-06-14T00:00:06.000Z",
    });
    expect(thirdSchedule.readyLanes).toEqual([
      expect.objectContaining({
        id: "lane-browser-prose-neighbor",
        segmentId: "segment-session-1-lane-browser-prose-neighbor",
        runId: "run-session-1-lane-browser-prose-neighbor",
      }),
    ]);
    const thirdWriter = thirdSchedule.readyLanes[0]!;
    const thirdEvidence = {
      ...terminalRunEvidence(
        thirdWriter.runId,
        "succeeded",
        0,
        [{ kind: "run-exit", name: "Codex CLI exit", status: "passed" }],
        [],
      ),
      completedAt: "2026-06-14T00:00:07.000Z",
    } satisfies RunEvidence;

    store.recordRunResult({
      sessionId: "session-1",
      laneId: thirdWriter.id,
      segmentId: thirdWriter.segmentId,
      runId: thirdWriter.runId,
      agentKind: "codex",
      evidence: thirdEvidence,
      now: thirdEvidence.completedAt,
    });

    const assertCanonical = (current: ReturnType<typeof createWorkflowStore>, now: string) => {
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
        now,
      }).readyLanes.map((lane) => lane.id)).not.toContain("lane-browser-review");
    };

    assertCanonical(store, "2026-06-14T00:00:08.000Z");
    store.close();
    const reopened = createWorkflowStore({ projectRoot });
    assertCanonical(reopened, "2026-06-14T00:00:09.000Z");
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
          laneKind: "validation",
          semanticSubtype: "browser_validation",
          title: "Capture browser screenshot",
          agentKind: "codex",
          status: "pending",
          requiredEvidence: ["browser", "screenshot"],
          runtimePolicy: {
            source: "workflow_projection",
            trusted: true,
            executable: true,
            sandbox: "read-only",
            sideEffects: [],
            reason: "Historical projected policy.",
          },
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
    expect(event?.payload.lane).toMatchObject({
      requiredEvidence: ["browser", "screenshot"],
      runtimePolicy: { sandbox: "read-only", sideEffects: [] },
    });
    expect(reopened.materializeFlowProjection("session-1").lanes.find((lane) => lane.id === "lane-historical-browser")).toMatchObject({
      requiredEvidence: ["browser", "screenshot"],
      runtimePolicy: { sandbox: "workspace-write", sideEffects: ["process", "artifact"] },
    });
    expect(reopened.materializeCanvasSession("session-1")?.nodes.find((node) => node.id === "lane-historical-browser")).toMatchObject({
      requiredEvidence: ["browser", "screenshot"],
      runtimePolicy: { sandbox: "workspace-write", sideEffects: ["process", "artifact"] },
    });
    reopened.close();
  });

  it("does not infer browser authority from pre-evidence lane-row prose", async () => {
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
    expect(reopened.getLane("session-1", "lane-legacy-browser")?.requiredEvidence).toEqual([]);
    expect(reopened.materializeCanvasSession("session-1")?.nodes.find((node) => node.id === "lane-legacy-browser")?.requiredEvidence).toEqual([]);
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
    expect(segment.status).toBe("succeeded");
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
    expect(reopened.listAppliedMigrations()).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9]);
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

function planFinishWorkflowSessionInput() {
  return {
    planSessionId: "plan-session-1",
    id: "session-plan-finish",
    projectId: "project-1",
    title: "Approved Plan",
    goal: "Finish the approved Plan",
    mode: "plan" as const,
    target: { executionTarget: "current_branch" as const, selectedBranch: "main" },
    plannerProfile: "default",
    transport: "hermes_session_resume" as const,
    hasOpaqueHandle: true,
    recoveryReason: "Plan ACP continuity is used only for this backend-owned planner launch.",
    now: "2026-07-18T00:00:00.000Z",
  };
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

async function makeNewWorktreeStore() {
  const store = await makeStore();
  seedStore(store, newWorktreeTarget());
  return store;
}

function newWorktreeTarget() {
  return {
    executionTarget: "new_worktree" as const,
    selectedBranch: "main",
    baseRef: "origin/main",
  };
}

function scheduleLaneIds(store: TestWorkflowStore, now: string, allowedParallelism = 1): string[] {
  return store.scheduleReadyLanes("session-1", { allowedParallelism, now }).readyLanes.map((lane) => lane.id);
}

function candidateBindingFacts(variantId: string, lineageId = `lineage-session-1-${variantId}`) {
  return { variantId, worktreeId: `worktree-session-1-${variantId}`, lineageId };
}

function worktreeMetadataFacts(worktree: WorkflowWorktreeIdentity) {
  const { parentLaneId: _parentLaneId, parentSegmentId: _parentSegmentId, ...metadata } = worktree;
  return metadata;
}

function appendTestFlowEvent(
  store: TestWorkflowStore,
  kind: FlowEventKind,
  payload: Record<string, unknown>,
  idempotencyKey: string,
  sessionId = "session-1",
): void {
  store.appendWorkflowEvent({
    sessionId,
    kind,
    source: "test",
    idempotencyKey,
    payload,
    now: "2026-07-28T00:00:00.000Z",
  });
}

function appendTestLane(
  store: TestWorkflowStore,
  laneId: string,
  status: "pending" | "completed" | "failed" = "pending",
  kind = "implementation",
  scopes?: { fileScopes: string[]; packageScopes: string[] },
): void {
  appendTestFlowEvent(store, "workflow.lane.declared", {
    lane: {
      id: laneId,
      semanticKey: laneId,
      kind,
      title: laneId,
      agentKind: "codex",
      status,
      ...(scopes ?? {}),
    },
  }, `test-lane:${laneId}`);
}

function appendTestEdge(store: TestWorkflowStore, sourceLaneId: string, targetLaneId: string): void {
  appendTestFlowEvent(store, "workflow.edge.declared", {
    edge: { id: `edge-${sourceLaneId}-${targetLaneId}`, sourceLaneId, targetLaneId },
  }, `test-edge:${sourceLaneId}:${targetLaneId}`);
}

function appendCandidateBinding(
  store: TestWorkflowStore,
  laneId: string,
  variantId: string,
  lineageId: string,
  predecessorLaneIds: string[] = [],
  reason: "default" | "explicit_join" = "default",
  idempotencyKey = `test-candidate:${laneId}`,
): void {
  appendTestFlowEvent(store, "workflow.lane.candidate_bound", {
    binding: {
      sessionId: "session-1", laneId, variantId,
      worktreeId: `worktree-session-1-${variantId}`,
      lineageId, reason, predecessorLaneIds,
    },
  }, idempotencyKey);
}

function candidateWorktree(
  projectRoot: string,
  variantId: string,
  parentLaneId: string,
): WorkflowWorktreeIdentity {
  const path = join(projectRoot, ".devflow", "worktrees", variantId);
  return {
    worktreeId: `worktree-session-1-${variantId}`,
    variantId,
    path,
    realPath: path,
    gitdir: join(projectRoot, ".git", "worktrees", variantId),
    repoRoot: projectRoot,
    branchName: `skyturn/session-1/${variantId}`,
    baseCommit: "a".repeat(40),
    headCommit: "a".repeat(40),
    parentLaneId,
  };
}

function appendWorktreeCreated(store: TestWorkflowStore, worktree: WorkflowWorktreeIdentity): void {
  appendTestFlowEvent(
    store,
    "workflow.worktree.created",
    { worktree },
    `worktree:${worktree.worktreeId}:created`,
  );
}

type TestWorkflowStore = ReturnType<typeof createWorkflowStore>;
type TestSegmentEvidenceInput = Parameters<TestWorkflowStore["recordSegmentEvidence"]>[0];

function workflowGitAncestryProof(
  beforeHeadCommit: string,
  afterHeadCommit: string,
  repositoryIdentity = "1".repeat(64),
  worktreeIdentity = "2".repeat(64),
): { ancestryProof: string; ancestryProofContext: WorkflowGitAncestryProofContext } {
  const ancestryProofContext = createWorkflowGitAncestryProofContext(
    beforeHeadCommit,
    afterHeadCommit,
    repositoryIdentity,
    worktreeIdentity,
  );
  return {
    ancestryProof: JSON.stringify({
      protocolVersion: 1,
      method: "git-merge-base-is-ancestor",
      beforeHeadCommit,
      afterHeadCommit,
      repositoryIdentity,
      worktreeIdentity,
    }),
    ancestryProofContext,
  };
}

interface CommitCompletionFactsFixture {
  identity: {
    sessionId: string;
    nodeId: string;
    laneId: string;
    segmentId: string;
    runId: string;
  };
  beforeHeadCommit: string;
  afterHeadCommit: string;
  input: {
    sessionId: string;
    nodeId: string;
    laneId: string;
    segmentId: string;
    runId: string;
    executionTarget: "current_branch" | "new_worktree";
    worktreeId?: string;
    worktreePath: string;
    branchName: string;
    baselineHeadCommit: string;
    afterHeadCommit: string;
    afterWorktreeState: "clean";
    changeset: {
      evidence: Record<string, unknown>;
      collectedAt: string;
    };
    ancestryProof: string;
    ancestryProofContext: WorkflowGitAncestryProofContext;
    now: string;
  };
}

function prepareCommitCompletionFactsRun(
  store: TestWorkflowStore,
  projectRoot: string,
  executionTarget: "current_branch" | "new_worktree",
  options: { recordBefore?: boolean } = {},
): CommitCompletionFactsFixture {
  seedStore(store, executionTarget === "new_worktree" ? newWorktreeTarget() : undefined);
  declareCodeChangeWorkflow(store);
  advanceCodeChangeWorkflowToLane(store, "lane-review");
  store.recordRunResult(runResultInput(store, "lane-review", "succeeded", "2026-08-16T00:00:06.000Z"));
  store.scheduleReadyLanes("session-1", {
    allowedParallelism: 1,
    authorizedLaneIds: ["lane-commit"],
    now: "2026-08-16T00:00:07.000Z",
  });
  return prepareExecutableCompletionFactsRun(
    store,
    projectRoot,
    "lane-commit",
    executionTarget,
    options,
  );
}

function prepareExecutableCompletionFactsRun(
  store: TestWorkflowStore,
  projectRoot: string,
  laneId: "lane-implementation" | "lane-commit",
  executionTarget: "current_branch" | "new_worktree" = "current_branch",
  options: { recordBefore?: boolean } = {},
): CommitCompletionFactsFixture {
  if (laneId === "lane-implementation") {
    seedStore(store);
    declareCodeChangeWorkflow(store);
    advanceCodeChangeWorkflowToLane(store, "lane-implementation");
  }
  const projection = store.materializeFlowProjection("session-1");
  const segment = projection.segments.find((candidate) =>
    candidate.laneId === laneId && candidate.status === "running"
  );
  if (!segment) throw new Error(`Missing running test segment for ${laneId}: ${JSON.stringify({
    lanes: projection.lanes.map((lane) => [lane.id, lane.status]),
    segments: projection.segments.map((candidate) => [candidate.laneId, candidate.status]),
  })}`);
  let worktreeId: string | undefined;
  let worktreePath = projectRoot;
  let branchName = "HEAD";
  if (executionTarget === "new_worktree") {
    const binding = projection.candidateBindings.find((candidate) => candidate.laneId === laneId);
    if (!binding) throw new Error(`Missing candidate binding for ${laneId}.`);
    const worktree = candidateWorktree(projectRoot, binding.variantId, laneId);
    appendWorktreeCreated(store, worktree);
    worktreeId = binding.worktreeId;
    worktreePath = worktree.realPath;
    branchName = worktree.branchName;
  }
  const identity = {
    sessionId: "session-1",
    nodeId: laneId,
    laneId,
    segmentId: segment.id,
    runId: segment.runId,
  };
  const beforeHeadCommit = "a".repeat(40);
  const afterHeadCommit = "b".repeat(40);
  if (options.recordBefore !== false) {
    store.recordRunCheckpoint({
      ...identity,
      phase: "before",
      executionTarget,
      ...(worktreeId ? { worktreeId } : {}),
      worktreePath,
      branchName,
      headCommit: beforeHeadCommit,
      worktreeState: "clean",
      evidenceRefs: [{ kind: "run", id: identity.runId }],
      now: "2026-08-16T00:00:07.500Z",
    });
  }
  return {
    identity,
    beforeHeadCommit,
    afterHeadCommit,
    input: {
      ...identity,
      executionTarget,
      ...(worktreeId ? { worktreeId } : {}),
      worktreePath,
      branchName,
      baselineHeadCommit: beforeHeadCommit,
      afterHeadCommit,
      afterWorktreeState: "clean",
      changeset: {
        evidence: {
          changesetId: `changeset-${laneId}`,
          source: "git",
          status: "available",
          files: ["src/index.ts"],
          diffStat: { added: 4, changed: 1, deleted: 0 },
          patchPreviewTruncated: false,
          fullPatchSha256: "4".repeat(64),
          fullPatchByteLength: 128,
          fileManifestSha256: "5".repeat(64),
        },
        collectedAt: "2026-08-16T00:00:08.000Z",
      },
      ...workflowGitAncestryProof(beforeHeadCommit, afterHeadCommit),
      now: "2026-08-16T00:00:08.000Z",
    },
  };
}

function prepareProofCheckpointRun(store: TestWorkflowStore, projectRoot: string) {
  seedStore(store);
  declareCodeChangeWorkflow(store);
  advanceCodeChangeWorkflowToLane(store, "lane-implementation");
  const beforeHeadCommit = "a".repeat(40);
  const common = {
    sessionId: "session-1",
    nodeId: "lane-implementation",
    laneId: "lane-implementation",
    runId: "run-session-1-lane-implementation",
    segmentId: "segment-session-1-lane-implementation",
    executionTarget: "current_branch" as const,
    worktreePath: projectRoot,
    branchName: "HEAD",
    worktreeState: "clean" as const,
    evidenceRefs: [{ kind: "run" as const, id: "run-session-1-lane-implementation" }],
  };
  store.recordRunCheckpoint({
    ...common,
    phase: "before",
    headCommit: beforeHeadCommit,
    now: "2026-08-01T00:00:03.000Z",
  });
  store.recordRunResult(runResultInput(
    store,
    common.laneId,
    "succeeded",
    "2026-08-01T00:00:04.000Z",
  ));
  return {
    beforeHeadCommit,
    afterInput: {
      ...common,
      phase: "after" as const,
      headCommit: "b".repeat(40),
      now: "2026-08-01T00:00:05.000Z",
    },
  };
}

function prepareCandidateManifestRun(
  store: TestWorkflowStore,
  projectRoot: string,
  options: {
    status?: "succeeded" | "failed";
    digestless?: boolean;
    includeProof?: boolean;
    nullRunChangesetId?: boolean;
    changesetId?: string;
    terminalEvidence?: Partial<RunEvidence>;
  } = {},
) {
  seedStore(store);
  declareCodeChangeWorkflow(store);
  advanceCodeChangeWorkflowToLane(store, "lane-implementation");
  const identity = {
    sessionId: "session-1",
    nodeId: "lane-implementation",
    laneId: "lane-implementation",
    segmentId: "segment-session-1-lane-implementation",
    runId: "run-session-1-lane-implementation",
  };
  const checkpoint = {
    ...identity,
    executionTarget: "current_branch" as const,
    worktreePath: projectRoot,
    branchName: "HEAD",
    worktreeState: "clean" as const,
  };
  store.recordRunCheckpoint({
    ...checkpoint,
    phase: "before",
    headCommit: "a".repeat(40),
    evidenceRefs: [{ kind: "run", id: identity.runId }],
    now: "2026-08-11T00:00:03.000Z",
  });
  const changesetId = options.changesetId ?? `changeset-${identity.laneId}`;
  const terminal = runResultInput(
    store,
    identity.laneId,
    options.status ?? "succeeded",
    "2026-08-11T00:00:04.000Z",
  );
  terminal.evidence.changesetId = options.nullRunChangesetId ? null : changesetId;
  Object.assign(terminal.evidence, options.terminalEvidence);
  store.recordRunResult(terminal);
  const changesetEvidenceId = `changeset-evidence:${identity.runId}:after`;
  store.appendWorkflowEvent({
    sessionId: identity.sessionId,
    kind: "workflow.changeset.evidence_recorded",
    source: "backend",
    laneId: identity.laneId,
    segmentId: identity.segmentId,
    idempotencyKey: `checkpoint-changeset:${identity.runId}:after`,
    payload: {
      laneId: identity.laneId,
      segmentId: identity.segmentId,
      baselineHeadCommit: "a".repeat(40),
      evidence: {
        evidenceId: changesetEvidenceId,
        changesetId,
        source: "git",
        status: "available",
        files: ["src/index.ts"],
        diffStat: { added: 4, changed: 1, deleted: 0 },
        patchPreviewTruncated: false,
        collectedAt: "2026-08-11T00:00:05.000Z",
        ...(!options.digestless ? {
          fullPatchSha256: "4".repeat(64),
          fullPatchByteLength: 128,
          fileManifestSha256: "5".repeat(64),
        } : {}),
      },
    },
    now: "2026-08-11T00:00:05.000Z",
  });
  const proof = workflowGitAncestryProof("a".repeat(40), "b".repeat(40));
  store.recordRunCheckpoint({
    ...checkpoint,
    phase: "after",
    headCommit: "b".repeat(40),
    evidenceRefs: [
      { kind: "run", id: identity.runId },
      { kind: "segment", id: identity.segmentId },
      { kind: "evidence", id: `evidence-${identity.segmentId}` },
      { kind: "changeset", id: changesetEvidenceId },
    ],
    ...(options.includeProof === false ? {} : proof),
    now: "2026-08-11T00:00:05.500Z",
  });
  return identity;
}

function preparedPublicationFixture(store: TestWorkflowStore, projectRoot: string) {
  const identity = prepareCandidateManifestRun(store, projectRoot);
  const publicationLaneId = "lane-candidate-review-commit";
  const manifest = store.freezeCandidateManifest({
    ...identity,
    now: "2026-08-11T00:00:06.000Z",
  });
  const manifestSha256 = createHash("sha256")
    .update(canonicalWorkflowCandidateManifestJson(manifest), "utf8")
    .digest("hex");
  const expected = {
    repositoryIdentity: manifest.repositoryIdentity,
    worktreeIdentity: manifest.worktreeIdentity,
    branchName: manifest.branchName,
    beforeHeadCommit: manifest.beforeHeadCommit,
    afterHeadCommit: manifest.afterHeadCommit,
    ancestryProofSha256: manifest.ancestryProofSha256,
    fullPatchSha256: manifest.fullPatchSha256,
    fullPatchByteLength: manifest.fullPatchByteLength,
    fileManifestSha256: manifest.fileManifestSha256,
  };
  const preparation = {
    status: "prepared" as const,
    commitSha: "2".repeat(40),
    treeSha: "3".repeat(40),
    branch: expected.branchName,
    parentCommit: expected.afterHeadCommit,
    expected,
  };
  const reviewPatch = Buffer.alloc(manifest.fullPatchByteLength, 0x61);
  const reviewRequest: CandidateReviewRequest = {
    version: 1,
    manifestSha256,
    identity: {
      sessionId: manifest.sessionId,
      nodeId: manifest.nodeId,
      laneId: manifest.laneId,
      segmentId: manifest.segmentId,
      runId: manifest.runId,
    },
    candidate: {
      repositoryIdentity: manifest.repositoryIdentity,
      worktreeIdentity: manifest.worktreeIdentity,
      branchName: manifest.branchName,
      beforeHeadCommit: manifest.beforeHeadCommit,
      afterHeadCommit: manifest.afterHeadCommit,
      ancestryProofSha256: manifest.ancestryProofSha256,
      fileManifestSha256: manifest.fileManifestSha256,
    },
    patch: {
      encoding: "base64",
      sha256: manifest.fullPatchSha256,
      byteLength: reviewPatch.byteLength,
      base64: reviewPatch.toString("base64"),
    },
  };
  const reviewRequestSha256 = createHash("sha256")
    .update(canonicalCandidateReviewRequestJson(reviewRequest), "utf8")
    .digest("hex");
  const otherReviewRequestSha256 = createHash("sha256")
    .update(canonicalCandidateReviewRequestJson({
      ...reviewRequest,
      patch: {
        ...reviewRequest.patch,
        base64: Buffer.alloc(reviewPatch.byteLength, 0x62).toString("base64"),
      },
    }), "utf8")
    .digest("hex");
  const lookup = {
    ...identity,
    laneId: publicationLaneId,
    candidateLaneId: identity.laneId,
    manifestSha256,
    requestSha256: "b".repeat(64),
  };
  const decision = {
    version: 1 as const,
    requestSha256: reviewRequestSha256,
    manifestSha256,
    disposition: "allow" as const,
  };
  return {
    identity,
    publicationLaneId,
    manifest,
    manifestSha256,
    reviewRequest,
    reviewRequestSha256,
    otherReviewRequestSha256,
    decision,
    preparation,
    lookup,
    input: {
      ...lookup,
      reviewRequestSha256,
      preparation,
      now: "2026-08-14T00:00:00.000Z",
    },
  };
}

function appendAllowedCandidateReview(
  store: TestWorkflowStore,
  fixture: ReturnType<typeof preparedPublicationFixture>,
  now = "2026-08-13T23:59:59.000Z",
): unknown {
  const api = store as unknown as {
    appendCandidateReviewAllowed(input: unknown): unknown;
  };
  return api.appendCandidateReviewAllowed({
    ...fixture.identity,
    manifestSha256: fixture.manifestSha256,
    decision: fixture.decision,
    now,
  });
}

function getAllowedCandidateReview(
  store: TestWorkflowStore,
  fixture: ReturnType<typeof preparedPublicationFixture>,
): unknown {
  const api = store as unknown as {
    getCandidateReviewAllowed(input: unknown): unknown;
  };
  return api.getCandidateReviewAllowed({
    ...fixture.identity,
    manifestSha256: fixture.manifestSha256,
  });
}

function insertPreAttestationPreparedPublicationRow(
  databasePath: string,
  fixture: ReturnType<typeof preparedPublicationFixture>,
): void {
  const db = new Database(databasePath);
  const seq = Number((db.prepare("SELECT MAX(seq) AS seq FROM workflow_events WHERE session_id = ?")
    .get(fixture.identity.sessionId) as { seq: number | null }).seq ?? 0) + 1;
  const id = `${fixture.identity.sessionId}:event:${String(seq).padStart(8, "0")}`;
  const idempotencyKey = `delivery-commit-prepared:${fixture.publicationLaneId}:${fixture.identity.segmentId}`;
  const payload = stableTestJson({
    laneId: fixture.publicationLaneId,
    candidateLaneId: fixture.identity.laneId,
    nodeId: fixture.identity.nodeId,
    segmentId: fixture.identity.segmentId,
    runId: fixture.identity.runId,
    manifestSha256: fixture.manifestSha256,
    requestSha256: fixture.input.requestSha256,
    preparation: fixture.preparation,
  });
  db.prepare([
    "INSERT INTO workflow_events(",
    "id, session_id, seq, kind, source, lane_id, segment_id, causation_id, correlation_id,",
    "idempotency_key, payload_json, created_at, legacy_evidence_compatibility",
    ") VALUES (?, ?, ?, 'workflow.commit.publication_prepared', 'workflow_store', ?, ?, NULL, NULL, ?, ?, ?, 0)",
  ].join(" ")).run(
    id,
    fixture.identity.sessionId,
    seq,
    fixture.publicationLaneId,
    fixture.identity.segmentId,
    idempotencyKey,
    payload,
    "2026-08-14T00:00:00.000Z",
  );
  db.close();
}

interface RawWorkflowEventRow {
  id: string;
  session_id: string;
  seq: number;
  kind: string;
  source: string;
  lane_id: string | null;
  segment_id: string | null;
  causation_id: string | null;
  correlation_id: string | null;
  idempotency_key: string | null;
  payload_json: string;
  created_at: string;
  legacy_evidence_compatibility: number;
}

function mutateRawWorkflowEvent(
  databasePath: string,
  eventId: string,
  mutate: (row: RawWorkflowEventRow) => void,
): void {
  const db = new Database(databasePath);
  const row = db.prepare("SELECT * FROM workflow_events WHERE id = ?").get(eventId) as RawWorkflowEventRow;
  mutate(row);
  db.prepare([
    "UPDATE workflow_events SET session_id = @session_id, seq = @seq, kind = @kind, source = @source,",
    "lane_id = @lane_id, segment_id = @segment_id, causation_id = @causation_id,",
    "correlation_id = @correlation_id, idempotency_key = @idempotency_key,",
    "payload_json = @payload_json, created_at = @created_at,",
    "legacy_evidence_compatibility = @legacy_evidence_compatibility WHERE id = @id",
  ].join(" ")).run(row);
  db.close();
}

function insertBaselinePreparedPublicationRow(
  databasePath: string,
  fixture: ReturnType<typeof preparedPublicationFixture>,
  mutatePayload?: (payload: Record<string, unknown>) => void,
) {
  const db = new Database(databasePath);
  db.prepare("DELETE FROM schema_migrations WHERE version = 9").run();
  const seq = Number((db.prepare("SELECT MAX(seq) AS seq FROM workflow_events WHERE session_id = ?")
    .get(fixture.identity.sessionId) as { seq: number | null }).seq ?? 0) + 1;
  const id = `${fixture.identity.sessionId}:event:${String(seq).padStart(8, "0")}`;
  const idempotencyKey = `delivery-commit-prepared:${fixture.identity.laneId}:${fixture.identity.segmentId}`;
  const createdAt = "2026-08-13T00:00:00.000Z";
  const payload: Record<string, unknown> = {
    laneId: fixture.identity.laneId,
    manifestSha256: fixture.manifestSha256,
    preparation: fixture.preparation,
    requestSha256: fixture.input.requestSha256,
    segmentId: fixture.identity.segmentId,
  };
  mutatePayload?.(payload);
  const payloadJson = stableTestJson(payload);
  db.prepare([
    "INSERT INTO workflow_events(",
    "id, session_id, seq, kind, source, lane_id, segment_id, causation_id, correlation_id,",
    "idempotency_key, payload_json, created_at, legacy_evidence_compatibility",
    ") VALUES (?, ?, ?, 'workflow.commit.publication_prepared', 'workflow_store', ?, ?, NULL, NULL, ?, ?, ?, 0)",
  ].join(" ")).run(
    id,
    fixture.identity.sessionId,
    seq,
    fixture.identity.laneId,
    fixture.identity.segmentId,
    idempotencyKey,
    payloadJson,
    createdAt,
  );
  db.close();
  return { id, seq, idempotencyKey, payloadJson, createdAt };
}

function readRawWorkflowEvent(databasePath: string, eventId: string): {
  kind: string;
  idempotency_key: string | null;
  payload_json: string;
} {
  const db = new Database(databasePath, { readonly: true });
  const row = db.prepare([
    "SELECT kind, idempotency_key, payload_json FROM workflow_events WHERE id = ?",
  ].join(" ")).get(eventId) as {
    kind: string;
    idempotency_key: string | null;
    payload_json: string;
  };
  db.close();
  return row;
}

function stableTestJson(value: unknown): string {
  return JSON.stringify(sortTestJson(value));
}

function sortTestJson(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortTestJson);
  if (!value || typeof value !== "object") return value;
  const record = value as Record<string, unknown>;
  return Object.fromEntries(Object.keys(record).sort().map((key) => [key, sortTestJson(record[key])]));
}

function rewriteChangesetBaseline(
  databasePath: string,
  identity: { sessionId: string; runId: string },
  baselineHeadCommit: string | undefined,
): void {
  const db = new Database(databasePath);
  const row = db.prepare("SELECT id, payload_json FROM workflow_events WHERE session_id = ? AND idempotency_key = ?")
    .get(identity.sessionId, `checkpoint-changeset:${identity.runId}:after`) as { id: string; payload_json: string };
  const payload = JSON.parse(row.payload_json) as Record<string, unknown>;
  if (baselineHeadCommit === undefined) delete payload.baselineHeadCommit;
  else payload.baselineHeadCommit = baselineHeadCommit;
  db.prepare("UPDATE workflow_events SET payload_json = ? WHERE id = ?").run(JSON.stringify(payload), row.id);
  db.close();
}

function rawCheckpoint(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  const runId = typeof overrides.runId === "string" ? overrides.runId : "run-raw";
  const segmentId = typeof overrides.segmentId === "string" ? overrides.segmentId : "segment-raw";
  const laneId = typeof overrides.laneId === "string" ? overrides.laneId : "lane-raw";
  return {
    id: `checkpoint:${runId}:before`,
    sessionId: "session-1",
    nodeId: laneId,
    laneId,
    runId,
    segmentId,
    phase: "before",
    executionTarget: "current_branch",
    worktreePath: "/repo",
    branchName: "HEAD",
    worktreeState: "clean",
    headCommit: "a".repeat(40),
    createdAt: "2026-08-01T00:00:00.000Z",
    source: "backend",
    evidenceRefs: [{ kind: "run", id: runId }],
    ...overrides,
  };
}

function insertRawCheckpointEvents(databasePath: string, checkpoints: Record<string, unknown>[]): void {
  const db = new Database(databasePath);
  let seq = Number((db.prepare("SELECT MAX(seq) AS seq FROM workflow_events WHERE session_id = ?")
    .get("session-1") as { seq: number | null }).seq ?? 0);
  const usedIdempotencyKeys = new Set(
    (db.prepare("SELECT idempotency_key FROM workflow_events WHERE session_id = ? AND idempotency_key IS NOT NULL")
      .all("session-1") as Array<{ idempotency_key: string }>).map((row) => row.idempotency_key),
  );
  const insert = db.prepare([
    "INSERT INTO workflow_events(",
    "id, session_id, seq, kind, source, lane_id, segment_id, causation_id, correlation_id,",
    "idempotency_key, payload_json, created_at",
    ") VALUES (?, ?, ?, ?, ?, ?, ?, NULL, NULL, ?, ?, ?)",
  ].join(" "));
  for (const checkpoint of checkpoints) {
    seq += 1;
    const sessionId = String(checkpoint.sessionId ?? "session-1");
    const checkpointId = String(checkpoint.id ?? `checkpoint-raw-${seq}`);
    const runId = typeof checkpoint.runId === "string" ? checkpoint.runId : `raw-${seq}`;
    const phase = checkpoint.phase === "after" ? "after" : "before";
    const expectedIdempotencyKey = `checkpoint:${runId}:${phase}`;
    const idempotencyKey = usedIdempotencyKeys.has(expectedIdempotencyKey)
      ? `${expectedIdempotencyKey}:duplicate:${seq}`
      : expectedIdempotencyKey;
    usedIdempotencyKeys.add(idempotencyKey);
    insert.run(
      `${sessionId}:raw-checkpoint-event:${seq}`,
      sessionId,
      seq,
      "workflow.node.checkpoint_recorded",
      "backend",
      typeof checkpoint.laneId === "string" ? checkpoint.laneId : null,
      typeof checkpoint.segmentId === "string" ? checkpoint.segmentId : null,
      idempotencyKey,
      JSON.stringify({ checkpoint }),
      typeof checkpoint.createdAt === "string" ? checkpoint.createdAt : "2026-08-01T00:00:00.000Z",
    );
  }
  db.close();
}

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

function canonicalJson(value: unknown): string {
  return JSON.stringify(sortCanonicalJson(value));
}

function sortCanonicalJson(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortCanonicalJson);
  if (!value || typeof value !== "object") return value;
  const record = value as Record<string, unknown>;
  return Object.fromEntries(Object.keys(record).sort().map((key) => [key, sortCanonicalJson(record[key])]));
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
  sessionId = "session-1",
): void {
  const session = store.createWorkflowSession({
    id: sessionId,
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
  completeInitialPlannerTurn(store, session);
  store.applyWorkflowCardToolCall(
    sessionId,
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

function completeInitialPlannerTurn(
  store: ReturnType<typeof createWorkflowStore>,
  session: { id: string; plannerLaneId: string },
): void {
  const runId = `run-${session.id}-initial-planner-turn`;
  const { segment } = store.claimPlannerRunStart({
    sessionId: session.id,
    laneId: session.plannerLaneId,
    runId,
    agentKind: "hermes",
    worktreePath: dirname(dirname(store.databasePath)),
    now: "2026-06-14T00:00:00.500Z",
  });
  store.recordSegmentEvidence({
    ...segment,
    transport: "agent-bridge",
    worktreePath: dirname(dirname(store.databasePath)),
    evidence: plannerRunEvidence(runId, "2026-06-14T00:00:00.750Z"),
    now: "2026-06-14T00:00:00.750Z",
  });
}

function seedSucceededPlannerIntentCandidate(
  store: ReturnType<typeof createWorkflowStore>,
  projectRoot: string,
  runId: string,
  output: string,
) {
  const session = store.createWorkflowSession({
    id: `session-${runId}`,
    projectId: "project-1",
    title: "Planner disposition",
    goal: "Classify the terminal planner intent",
    mode: "plan",
    target: { executionTarget: "current_branch" as const, selectedBranch: "main" },
    plannerProfile: "default",
    transport: "hermes_replay_recovery",
    recoveryReason: "Test setup has no live Hermes session.",
    now: "2026-07-22T02:00:00.000Z",
  });
  const { segment } = store.claimPlannerRunStart({
    sessionId: session.id,
    laneId: session.plannerLaneId,
    runId,
    agentKind: "hermes",
    worktreePath: projectRoot,
    now: "2026-07-22T02:00:01.000Z",
  });
  const completedAt = "2026-07-22T02:00:02.000Z";
  const evidence = succeededPlannerRunEvidence(runId, completedAt);
  store.recordRunResult({
    ...segment,
    outputSummary: output,
    runEvents: [plannerOutputEvent(runId, output, completedAt)],
    evidence,
    now: completedAt,
  });
  return { session, segment, evidence, output };
}

function succeededPlannerRunEvidence(runId: string, completedAt: string): RunEvidence {
  return {
    runId,
    status: "succeeded",
    exitCode: 0,
    changesetId: null,
    checks: [
      { kind: "run-exit", name: "Hermes CLI exit", status: "passed", detail: "exit=0" },
      { kind: "test", name: "Planner output persisted", status: "passed", detail: "exact" },
    ],
    artifacts: [],
    review: null,
    errorReason: null,
    cancelReason: null,
    completedAt,
  };
}

function plannerOutputEvent(runId: string, text: string, timestamp: string): RunEvent {
  return {
    protocolVersion: 1,
    runId,
    seq: 1,
    timestamp,
    kind: "output",
    payload: { text },
  };
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

function recordNewWorktreeCheckpoint(
  store: ReturnType<typeof createWorkflowStore>,
  checkpointId: string,
  laneId: string,
  phase: "before" | "after",
  variantId: string,
  headCommit: string,
  sessionId = "session-1",
): void {
  store.appendWorkflowEvent({
    sessionId,
    kind: "workflow.node.checkpoint_recorded",
    source: "test",
    laneId,
    idempotencyKey: `checkpoint:${checkpointId}`,
    payload: {
      checkpoint: {
        id: checkpointId,
        sessionId,
        nodeId: laneId,
        laneId,
        runId: `run-${sessionId}-${laneId}`,
        segmentId: `segment-${sessionId}-${laneId}`,
        phase,
        executionTarget: "new_worktree",
        worktreeId: `worktree-${sessionId}-${variantId}`,
        worktreeState: "clean",
        baseCommit: "0".repeat(40),
        headCommit,
        createdAt: "2026-07-28T00:00:00.000Z",
        source: "backend",
        evidenceRefs: [{ kind: "run", id: `run-${sessionId}-${laneId}` }],
      },
    },
    now: "2026-07-28T00:00:00.000Z",
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
