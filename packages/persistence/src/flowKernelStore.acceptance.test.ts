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
});
