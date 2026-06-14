import { describe, expect, it } from "vitest";

import {
  compileWorkflowIntent,
  createDefaultFlowPolicy,
  evaluateGate,
  parseWorkflowIntent,
  reduceWorkflowEvents,
  scheduleReadyLanes,
  type FlowEvent,
  type FlowProjection,
  type WorkflowIntent,
} from "./index.js";

const now = "2026-06-14T00:00:00.000Z";

describe("Flow Kernel intent compiler", () => {
  it("accepts WorkflowIntent JSON and rejects Hermes UI mutations or self-completion", () => {
    const accepted = parseWorkflowIntent(
      JSON.stringify({
        intentId: "intent-frontend-1",
        sessionId: "session-1",
        operations: [
          { type: "AnalyzeRequirement", requirement: "Add search filtering" },
          { type: "DiscoverProject", profile: { languages: ["typescript"], capabilities: ["frontend-ui"] } },
          { type: "ProposeLanes" },
        ],
      }),
    );

    expect(accepted.ok).toBe(true);

    const rejectedMutation = parseWorkflowIntent(
      JSON.stringify({
        toolCalls: [{ tool: "createWorkflowCard", input: { id: "node-code" } }],
      }),
    );
    expect(rejectedMutation).toMatchObject({ ok: false, reason: expect.stringMatching(/WorkflowIntent/i) });

    const rejectedCompletion = parseWorkflowIntent(
      JSON.stringify({
        intentId: "intent-bad-complete",
        sessionId: "session-1",
        operations: [{ type: "RequestReview", laneId: "node-review", status: "completed", agentKind: "hermes" }],
      }),
    );
    expect(rejectedCompletion).toMatchObject({ ok: false, reason: expect.stringMatching(/Hermes.*completed/i) });

    const rejectedMissingPayload = parseWorkflowIntent(
      JSON.stringify({
        intentId: "intent-missing-payload",
        sessionId: "session-1",
        operations: [{ type: "AnalyzeRequirement" }, { type: "DiscoverProject" }, { type: "ProposeLanes" }],
      }),
    );
    expect(rejectedMissingPayload).toMatchObject({ ok: false, reason: expect.stringMatching(/AnalyzeRequirement.*requirement/i) });
  });

  it("compiles policy-pack suggestions into deterministic idempotent lanes and edges", () => {
    const policy = createDefaultFlowPolicy({ allowedParallelism: 2 });
    const intent: WorkflowIntent = {
      intentId: "intent-frontend-1",
      sessionId: "session-1",
      operations: [
        { type: "AnalyzeRequirement", requirement: "Add a search filter control to the React task list" },
        { type: "DiscoverProject", profile: { languages: ["typescript"], capabilities: ["frontend-ui"] } },
        { type: "ProposeLanes" },
      ],
    };

    const first = reduceWorkflowEvents(compileWorkflowIntent(intent, emptyProjection("session-1"), policy, now).events);
    const replayed = reduceWorkflowEvents([
      ...compileWorkflowIntent(intent, emptyProjection("session-1"), policy, now).events,
      ...compileWorkflowIntent(intent, first, policy, now).events,
    ]);

    expect(first.lanes.map((lane) => lane.kind)).toEqual([
      "discovery",
      "design",
      "implementation",
      "browser_validation",
      "review",
      "commit",
    ]);
    expect(first.edges.map((edge) => [edge.sourceLaneId, edge.targetLaneId])).toEqual([
      ["lane-discovery", "lane-design"],
      ["lane-design", "lane-implementation"],
      ["lane-implementation", "lane-browser-validation"],
      ["lane-browser-validation", "lane-review"],
      ["lane-review", "lane-commit"],
    ]);
    expect(replayed.lanes).toEqual(first.lanes);
    expect(replayed.edges).toEqual(first.edges);
  });
});

describe("Flow Kernel gate engine and scheduler", () => {
  it("emits rejected gate events for invalid transitions instead of silently mutating projection", () => {
    const projection = reduceWorkflowEvents([
      event("workflow.lane.declared", { lane: lane("lane-implementation", "implementation", ["src/App.ts"]) }),
      event("workflow.lane.declared", { lane: lane("lane-review", "review") }),
      event("workflow.lane.declared", { lane: lane("lane-commit", "commit") }),
      event("workflow.edge.declared", { edge: { id: "edge-review-implementation", sourceLaneId: "lane-review", targetLaneId: "lane-implementation" } }),
    ]);

    expect(evaluateGate(projection, { type: "StartImplementation", laneId: "lane-implementation" })).toMatchObject({
      allowed: false,
      reason: expect.stringMatching(/discovery/i),
    });
    expect(evaluateGate(projection, { type: "RequestReview", laneId: "lane-review" })).toMatchObject({
      allowed: false,
      reason: expect.stringMatching(/implementation evidence/i),
    });
    expect(
      evaluateGate(projection, {
        type: "JoinLanes",
        joinLaneId: "lane-integration-join",
        upstreamLaneIds: ["lane-implementation", "lane-review"],
      }),
    ).toMatchObject({ allowed: false, reason: expect.stringMatching(/upstream/i) });
    expect(evaluateGate(projection, { type: "Commit", laneId: "lane-commit" })).toMatchObject({
      allowed: false,
      reason: expect.stringMatching(/review.*validation/i),
    });
    expect(
      evaluateGate(projection, {
        type: "DeclareEdge",
        sourceLaneId: "lane-implementation",
        targetLaneId: "lane-review",
      }),
    ).toMatchObject({ allowed: false, reason: expect.stringMatching(/cycle/i) });
    expect(
      evaluateGate(projection, {
        type: "DeclareEdge",
        sourceLaneId: "lane-implementation",
        targetLaneId: "lane-intake",
      }),
    ).toMatchObject({ allowed: false, reason: expect.stringMatching(/planner|intake/i) });
  });

  it("schedules ready lanes by dependency, allowed parallelism, and file/package conflicts", () => {
    const projection = reduceWorkflowEvents([
      event("workflow.lane.declared", { lane: { ...lane("lane-discovery", "discovery"), status: "completed" } }),
      event("workflow.lane.declared", { lane: lane("lane-frontend", "implementation", ["apps/web/src/Search.tsx"], ["apps/web"]) }),
      event("workflow.lane.declared", { lane: lane("lane-api", "implementation", ["apps/api/src/search.ts"], ["apps/api"]) }),
      event("workflow.lane.declared", { lane: lane("lane-style", "implementation", ["apps/web/src/Search.tsx"], ["apps/web"]) }),
      event("workflow.edge.declared", { edge: { id: "edge-discovery-frontend", sourceLaneId: "lane-discovery", targetLaneId: "lane-frontend" } }),
      event("workflow.edge.declared", { edge: { id: "edge-discovery-api", sourceLaneId: "lane-discovery", targetLaneId: "lane-api" } }),
      event("workflow.edge.declared", { edge: { id: "edge-discovery-style", sourceLaneId: "lane-discovery", targetLaneId: "lane-style" } }),
    ]);

    const ready = scheduleReadyLanes(projection, {
      allowedParallelism: 2,
      runningScopes: [{ fileScopes: ["apps/web/src/Search.tsx"], packageScopes: ["apps/web"] }],
    });

    expect(ready.map((item) => item.id)).toEqual(["lane-api"]);
  });

  it("keeps lane completion evidence-only even when agent text claims done", () => {
    const projection = reduceWorkflowEvents([
      event("workflow.lane.declared", { lane: lane("lane-implementation", "implementation") }),
      event("workflow.segment.started", { segment: { id: "segment-1", laneId: "lane-implementation", runId: "run-1", status: "running" } }),
      event("workflow.segment.output_delta", { laneId: "lane-implementation", segmentId: "segment-1", text: "done, completed, ship it" }),
      event("workflow.segment.finished", { laneId: "lane-implementation", segmentId: "segment-1", status: "succeeded", exitCode: 0 }),
    ]);

    expect(projection.lanes.find((item) => item.id === "lane-implementation")?.status).toBe("running");

    const withEvidence = reduceWorkflowEvents([
      ...projection.events,
      event("workflow.evidence.recorded", {
        laneId: "lane-implementation",
        segmentId: "segment-1",
        evidence: { id: "evidence-1", kind: "test", status: "passed", checks: ["unit"], artifacts: [] },
      }),
    ]);

    expect(withEvidence.lanes.find((item) => item.id === "lane-implementation")?.status).toBe("completed");
  });
});

function emptyProjection(sessionId: string): FlowProjection {
  return reduceWorkflowEvents([event("workflow.user_input", { sessionId, text: "seed" })]);
}

function event(kind: FlowEvent["kind"], payload: Record<string, unknown>): FlowEvent {
  return {
    id: `${kind}:${JSON.stringify(payload)}`,
    sessionId: "session-1",
    seq: 1,
    kind,
    source: "test",
    payload,
    createdAt: now,
    idempotencyKey: `${kind}:${JSON.stringify(payload)}`,
  };
}

function lane(
  id: string,
  kind: string,
  fileScopes: string[] = [],
  packageScopes: string[] = [],
) {
  return {
    id,
    semanticKey: id,
    kind,
    title: id,
    agentKind: kind === "review" ? "hermes" : "codex",
    status: "pending",
    fileScopes,
    packageScopes,
    requiredEvidence: [],
  };
}
