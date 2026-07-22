import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { runFlowKernelAcceptanceScenarios } from "@skyturn/workflow-kernel/acceptance";

import { createWorkflowStore } from "./workflowStore.js";

describe("Flow Kernel SQLite acceptance", () => {
  it("replays the four Flow Kernel acceptance scenarios from SQLite events", async () => {
    const summary = await runFlowKernelAcceptanceScenarios();

    expect(summary.ok).toBe(true);
    expect(summary.scenarios.map((scenario) => scenario.id)).toEqual([
      "frontend-ui",
      "backend-api",
      "data-script",
      "complex-fullstack",
    ]);

    for (const scenario of summary.scenarios) {
      const store = createWorkflowStore({ projectRoot: scenario.repoRoot });
      store.createWorkflowSession({
        id: scenario.projection.sessionId,
        projectId: `project-${scenario.id}`,
        title: `Flow Kernel ${scenario.id}`,
        goal: scenario.id,
        mode: "fast",
        plannerProfile: "acceptance",
        transport: "hermes_replay_recovery",
        recoveryReason: "Acceptance replay verifies SQLite event stream projection.",
        now: "2026-06-14T00:00:00.000Z",
      });

      for (const event of scenario.projection.events.filter((item) => item.kind !== "workflow.user_input")) {
        store.appendWorkflowEvent({
          sessionId: event.sessionId,
          kind: event.kind,
          source: event.source,
          idempotencyKey: event.idempotencyKey,
          payload: event.payload,
          now: event.createdAt,
        });
      }

      const replayed = store.materializeFlowProjection(scenario.projection.sessionId);
      store.close();

      expect(replayed.lanes.map((lane) => [lane.id, lane.kind, lane.status])).toEqual(
        scenario.projection.lanes.map((lane) => [lane.id, lane.kind, lane.status]),
      );
      expect(replayed.edges.map((edge) => [edge.sourceLaneId, edge.targetLaneId])).toEqual(
        scenario.projection.edges.map((edge) => [edge.sourceLaneId, edge.targetLaneId]),
      );
      expect(replayed.evidence.map((evidence) => [evidence.laneId, evidence.kind, evidence.status])).toEqual(
        scenario.projection.evidence.map((evidence) => [evidence.laneId, evidence.kind, evidence.status]),
      );
    }

    const fullstack = summary.scenarios.find((scenario) => scenario.id === "complex-fullstack");
    expect(fullstack?.projection.edges.map((edge) => [edge.sourceLaneId, edge.targetLaneId])).toEqual(
      expect.arrayContaining([
        ["lane-frontend-implementation", "lane-integration-join"],
        ["lane-backend-implementation", "lane-integration-join"],
        ["lane-persistence-implementation", "lane-integration-join"],
      ]),
    );
  }, 30_000);

  it("replays an eligible after checkpoint for a failed executable run without duplicating completion", async () => {
    const projectRoot = await mkdtemp(join(tmpdir(), "skyturn-failed-run-checkpoint-"));
    const store = createWorkflowStore({ projectRoot });
    const session = store.createWorkflowSession({
      id: "session-failed-run",
      projectId: "project-failed-run",
      title: "Failed run checkpoint",
      goal: "Preserve the failed run state for repair.",
      mode: "fast",
      plannerProfile: "acceptance",
      transport: "hermes_replay_recovery",
      recoveryReason: "Acceptance fixture.",
      now: "2026-06-14T00:00:00.000Z",
    });
    const { segment: plannerSegment } = store.claimPlannerRunStart({
      sessionId: session.id,
      laneId: session.plannerLaneId,
      runId: "run-planner",
      agentKind: "hermes",
      worktreePath: projectRoot,
      now: "2026-06-14T00:00:00.250Z",
    });
    store.recordRunResult({
      ...plannerSegment,
      evidence: {
        runId: plannerSegment.runId,
        status: "succeeded",
        exitCode: 0,
        changesetId: null,
        checks: [{ kind: "run-exit", name: "Hermes CLI exit", status: "passed" }],
        artifacts: [],
        review: null,
        errorReason: null,
        cancelReason: null,
        completedAt: "2026-06-14T00:00:00.500Z",
      },
      now: "2026-06-14T00:00:00.500Z",
    });
    store.recordPlannerIntentReconciled(plannerSegment, "2026-06-14T00:00:00.750Z");
    store.appendWorkflowEvent({
      sessionId: "session-failed-run",
      kind: "workflow.lane.declared",
      source: "acceptance",
      idempotencyKey: "lane:implementation",
      payload: {
        lane: {
          id: "lane-implementation",
          semanticKey: "implementation",
          kind: "implementation",
          title: "Implement change",
          agentKind: "codex",
          status: "running",
        },
      },
      now: "2026-06-14T00:00:01.000Z",
    });
    store.appendWorkflowEvent({
      sessionId: "session-failed-run",
      kind: "workflow.segment.started",
      source: "workflow-scheduler",
      idempotencyKey: "segment:failed:started",
      payload: {
        laneId: "lane-implementation",
        segment: {
          id: "segment-failed",
          laneId: "lane-implementation",
          runId: "run-failed",
          status: "running",
          exitCode: null,
        },
      },
      now: "2026-06-14T00:00:02.000Z",
    });
    const evidence = {
      runId: "run-failed",
      status: "failed" as const,
      exitCode: 1,
      changesetId: "changeset-failed",
      checks: [{ kind: "run-exit" as const, name: "Agent run exit", status: "failed" as const }],
      artifacts: [],
      review: null,
      errorReason: "exit 1",
      cancelReason: null,
      completedAt: "2026-06-14T00:00:03.000Z",
    };
    const result = {
      sessionId: "session-failed-run",
      laneId: "lane-implementation",
      segmentId: "segment-failed",
      runId: "run-failed",
      agentKind: "codex" as const,
      evidence,
      now: evidence.completedAt,
    };
    store.recordRunCheckpoint({
      sessionId: "session-failed-run",
      nodeId: "lane-implementation",
      laneId: "lane-implementation",
      runId: "run-failed",
      segmentId: "segment-failed",
      phase: "before",
      executionTarget: "current_branch",
      worktreePath: projectRoot,
      branchName: "HEAD",
      headCommit: "b".repeat(40),
      worktreeState: "clean",
      evidenceRefs: [
        { kind: "run", id: "run-failed" },
        { kind: "segment", id: "segment-failed" },
      ],
      now: "2026-06-14T00:00:02.500Z",
    });
    store.recordRunResult(result);
    store.recordRunResult(result);
    const checkpoint = {
      sessionId: "session-failed-run",
      nodeId: "lane-implementation",
      laneId: "lane-implementation",
      runId: "run-failed",
      segmentId: "segment-failed",
      phase: "after" as const,
      executionTarget: "current_branch" as const,
      worktreePath: projectRoot,
      branchName: "HEAD",
      headCommit: "c".repeat(40),
      worktreeState: "dirty" as const,
      evidenceRefs: [
        { kind: "run" as const, id: "run-failed" },
        { kind: "evidence" as const, id: "evidence-segment-failed" },
        { kind: "changeset" as const, id: "changeset-failed" },
      ],
      now: "2026-06-14T00:00:04.000Z",
    };
    store.recordRunCheckpoint(checkpoint);
    store.recordRunCheckpoint(checkpoint);

    const projection = store.materializeFlowProjection("session-failed-run");
    expect(projection.lanes.find((lane) => lane.id === "lane-implementation")?.status).toBe("failed");
    expect(store.listNodeCheckpoints({ sessionId: "session-failed-run", runId: "run-failed", phase: "after" })).toHaveLength(1);
    expect(store.requestNodeRepair({
      sessionId: "session-failed-run",
      laneId: "lane-implementation",
      checkpointId: "checkpoint:run-failed:after",
      intentId: "repair-failed-run",
      successorLaneId: "lane-repair",
      successorSemanticKey: "repair:failed-run",
      now: "2026-06-14T00:00:05.000Z",
    }).event.kind).toBe("workflow.node.repair_requested");
    store.close();

    const replayed = createWorkflowStore({ projectRoot });
    expect(replayed.materializeFlowProjection("session-failed-run").checkpoints).toEqual(
      expect.arrayContaining([expect.objectContaining({ id: "checkpoint:run-failed:after", worktreeState: "dirty" })]),
    );
    replayed.close();
  });
});
