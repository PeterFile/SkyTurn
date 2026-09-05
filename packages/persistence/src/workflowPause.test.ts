import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import type { RunEvidence, SessionTarget } from "@skyturn/project-core";
import { createWorkflowStore } from "./workflowStore.js";

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.map((root) => rm(root, { recursive: true, force: true })));
  roots.length = 0;
});

describe("SQLite workflow scheduling control", () => {
  it.each([
    ["current_branch", { executionTarget: "current_branch", selectedBranch: "main" }],
    ["new_worktree", { executionTarget: "new_worktree", selectedBranch: "main", baseRef: "origin/main" }],
  ] as const)("durably gates every %s scheduling path with CAS and exact retry semantics", async (_name, target) => {
    const projectRoot = await makeTempRoot();
    const store = createWorkflowStore({ projectRoot });
    seedReadyLane(store, target);
    expect(store.materializeCanvasSession("session-1")?.schedulingState).toEqual({
      status: "active", revision: 0, requestId: null, changedAt: null,
    });

    const paused = store.pauseWorkflowScheduling({
      sessionId: "session-1", requestId: "pause-1", expectedStatus: "active", expectedRevision: 0,
      now: "2026-09-05T00:00:01.000Z",
    });
    expect(paused).toMatchObject({
      created: true,
      event: { kind: "workflow.scheduling.paused", payload: { requestId: "pause-1", expectedStatus: "active", expectedRevision: 0 } },
      view: {
        schedulingState: { status: "paused", revision: 1, requestId: "pause-1" },
        canvasSession: { schedulingState: { status: "paused", revision: 1 } },
        loopState: { nextAction: { kind: "blocked", schedulingState: { status: "paused", revision: 1 } } },
      },
    });
    expect(store.previewReadyLanes("session-1", { allowedParallelism: 2 }).readyLanes).toEqual([]);
    expect(store.scheduleReadyLanes("session-1", { allowedParallelism: 2, now: "2026-09-05T00:00:02.000Z" }).readyLanes).toEqual([]);
    store.close();

    const reopened = createWorkflowStore({ projectRoot });
    expect(reopened.materializeWorkflowView("session-1")).toMatchObject({
      schedulingState: { status: "paused", revision: 1 },
      canvasSession: { schedulingState: { status: "paused", revision: 1 } },
      loopState: { nextAction: { kind: "blocked", schedulingState: { status: "paused", revision: 1 } } },
    });
    const resumed = reopened.resumeWorkflowScheduling({
      sessionId: "session-1", requestId: "resume-1", expectedStatus: "paused", expectedRevision: 1,
      now: "2026-09-05T00:00:03.000Z",
    });
    const eventCount = reopened.listEvents("session-1").length;
    expect(reopened.resumeWorkflowScheduling({
      sessionId: "session-1", requestId: "resume-1", expectedStatus: "paused", expectedRevision: 1,
      now: "2026-09-05T00:00:04.000Z",
    })).toMatchObject({ created: false, event: resumed.event, view: { schedulingState: { status: "active", revision: 2 } } });
    expect(reopened.listEvents("session-1")).toHaveLength(eventCount);
    reopened.pauseWorkflowScheduling({
      sessionId: "session-1", requestId: "pause-2", expectedStatus: "active", expectedRevision: 2,
      now: "2026-09-05T00:00:05.000Z",
    });
    reopened.close();

    const afterOpposite = createWorkflowStore({ projectRoot });
    const retryAfterOpposite = afterOpposite.resumeWorkflowScheduling({
      sessionId: "session-1", requestId: "resume-1", expectedStatus: "paused", expectedRevision: 1,
      now: "2026-09-05T00:00:06.000Z",
    });
    expect(retryAfterOpposite).toMatchObject({ created: false, view: { schedulingState: { status: "paused", revision: 3 } } });
    expect(() => afterOpposite.resumeWorkflowScheduling({
      sessionId: "session-1", requestId: "pause-2", expectedStatus: "paused", expectedRevision: 3,
      now: "2026-09-05T00:00:07.000Z",
    })).toThrow(/requestId.*conflict/i);
    expect(() => afterOpposite.resumeWorkflowScheduling({
      sessionId: "session-1", requestId: "resume-stale", expectedStatus: "paused", expectedRevision: 1,
      now: "2026-09-05T00:00:08.000Z",
    })).toThrow(/stale/i);
    expect(() => afterOpposite.resumeWorkflowScheduling({
      sessionId: "session-1 ", requestId: "resume-invalid", expectedStatus: "paused", expectedRevision: 3,
      now: "2026-09-05T00:00:09.000Z",
    })).toThrow(/sessionId/i);
    expect(() => afterOpposite.appendWorkflowEvent({
      sessionId: "session-1", kind: "workflow.scheduling.resumed", source: "test",
      idempotencyKey: "scheduling-control:bypass", payload: {}, now: "2026-09-05T00:00:09.000Z",
    })).toThrow(/transactional API/i);
    afterOpposite.appendWorkflowEvent({
      sessionId: "session-1", kind: "node_declared", source: "test",
      idempotencyKey: "scheduling-control:collision", payload: {}, now: "2026-09-05T00:00:09.000Z",
    });
    expect(() => afterOpposite.resumeWorkflowScheduling({
      sessionId: "session-1", requestId: "collision", expectedStatus: "paused", expectedRevision: 3,
      now: "2026-09-05T00:00:09.000Z",
    })).toThrow(/requestId.*conflict/i);
    afterOpposite.resumeWorkflowScheduling({
      sessionId: "session-1", requestId: "resume-2", expectedStatus: "paused", expectedRevision: 3,
      now: "2026-09-05T00:00:10.000Z",
    });
    expect(afterOpposite.previewReadyLanes("session-1", { allowedParallelism: 2 }).readyLanes.map((lane) => lane.id)).toEqual(["lane-a"]);
    expect(afterOpposite.scheduleReadyLanes("session-1", { allowedParallelism: 2, now: "2026-09-05T00:00:11.000Z" }).readyLanes.map((lane) => lane.id)).toEqual(["lane-a"]);
    afterOpposite.close();
  });

  it("keeps pre-pause ownership and terminal evidence intact without releasing downstream work", async () => {
    const projectRoot = await makeTempRoot();
    const store = createWorkflowStore({ projectRoot });
    seedReadyLane(store, { executionTarget: "current_branch", selectedBranch: "main" });
    appendLane(store, "lane-b");
    store.appendWorkflowEvent({
      sessionId: "session-1", kind: "workflow.edge.declared", source: "test", idempotencyKey: "edge:a:b",
      payload: { edge: { id: "edge-a-b", sourceLaneId: "lane-a", targetLaneId: "lane-b" } },
      now: "2026-09-05T01:00:00.000Z",
    });
    const scheduled = store.scheduleReadyLanes("session-1", { allowedParallelism: 1, now: "2026-09-05T01:00:01.000Z" }).readyLanes[0]!;
    store.pauseWorkflowScheduling({
      sessionId: "session-1", requestId: "pause-running", expectedStatus: "active", expectedRevision: 0,
      now: "2026-09-05T01:00:02.000Z",
    });
    expect(store.materializeFlowProjection("session-1").segments).toContainEqual(expect.objectContaining({
      id: scheduled.segmentId, runId: scheduled.runId, laneId: "lane-a", status: "running",
    }));

    const evidence: RunEvidence = {
      runId: scheduled.runId,
      status: "succeeded",
      exitCode: 0,
      changesetId: "changeset-lane-a",
      checks: [{ kind: "run-exit", name: "Focused test", status: "passed" }],
      artifacts: [],
      review: null,
      errorReason: null,
      cancelReason: null,
      completedAt: "2026-09-05T01:00:03.000Z",
    };
    const terminal = store.recordRunResult({
      sessionId: "session-1", laneId: "lane-a", segmentId: scheduled.segmentId, runId: scheduled.runId,
      agentKind: "codex", outputSummary: "Completed lane A.", evidence, now: "2026-09-05T01:00:03.000Z",
    });
    expect(terminal.schedulingState.status).toBe("paused");
    expect(terminal.lanes.find((lane) => lane.id === "lane-a")?.status).toBe("completed");
    expect(terminal.lanes.find((lane) => lane.id === "lane-b")?.status).toBe("pending");
    expect(terminal.evidence.at(-1)?.runEvidence).toEqual(evidence);
    expect(store.previewReadyLanes("session-1", { allowedParallelism: 2 }).readyLanes).toEqual([]);
    expect(store.scheduleReadyLanes("session-1", { allowedParallelism: 2, now: "2026-09-05T01:00:04.000Z" }).readyLanes).toEqual([]);
    store.close();
  });
});

async function makeTempRoot(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "skyturn-workflow-pause-"));
  roots.push(root);
  return root;
}

function seedReadyLane(store: ReturnType<typeof createWorkflowStore>, target: SessionTarget): void {
  store.createWorkflowSession({
    id: "session-1", projectId: "project-1", title: "Scheduling", goal: "Control scheduling", mode: "fast",
    target, plannerProfile: "default", transport: "hermes_replay_recovery",
    recoveryReason: "No live Hermes session is required for this store test.", now: "2026-09-05T00:00:00.000Z",
  });
  appendLane(store, "lane-a");
}

function appendLane(store: ReturnType<typeof createWorkflowStore>, laneId: string): void {
  store.appendWorkflowEvent({
    sessionId: "session-1", kind: "workflow.lane.declared", source: "test", idempotencyKey: `lane:${laneId}`,
    payload: { lane: { id: laneId, semanticKey: laneId, kind: "implementation", title: laneId, agentKind: "codex", status: "pending" } },
    now: "2026-09-05T00:00:00.000Z",
  });
}
