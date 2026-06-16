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
  type WorkflowRuntimePolicy,
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

  it("routes small repository code changes to code execution lanes instead of frontend UI lanes", () => {
    const policy = createDefaultFlowPolicy({ allowedParallelism: 1 });
    const intent: WorkflowIntent = {
      intentId: "intent-code-change-1",
      sessionId: "session-1",
      operations: [
        {
          type: "AnalyzeRequirement",
          requirement:
            "In this git repository, update src/tasks.js and add node:test coverage for listTasks status filtering.",
        },
        { type: "DiscoverProject", profile: { languages: ["javascript"], capabilities: [] } },
        { type: "ProposeLanes" },
      ],
    };

    const projection = reduceWorkflowEvents(compileWorkflowIntent(intent, emptyProjection("session-1"), policy, now).events);

    expect(projection.lanes.map((lane) => [lane.kind, lane.agentKind, lane.title])).toEqual([
      ["implementation", "codex", "Implement repository change"],
      ["validation", "codex", "Run repository tests"],
      ["review", "hermes", "Review code evidence"],
      ["commit", "codex", "Commit verified change"],
    ]);
    expect(projection.edges.map((edge) => [edge.sourceLaneId, edge.targetLaneId])).toEqual([
      ["lane-implementation", "lane-validation"],
      ["lane-validation", "lane-review"],
      ["lane-review", "lane-commit"],
    ]);
  });

  it("gates WorkflowIntent operations against prior operations in the same intent", () => {
    const policy = createDefaultFlowPolicy({ allowedParallelism: 1 });
    const intent: WorkflowIntent = {
      intentId: "intent-code-change-start",
      sessionId: "session-1",
      operations: [
        { type: "AnalyzeRequirement", requirement: "Update src/tasks.js and add node:test coverage." },
        { type: "DiscoverProject", profile: { languages: ["javascript"], capabilities: [] } },
        { type: "ProposeLanes" },
        { type: "StartImplementation", laneId: "lane-implementation" },
      ],
    };

    const compiled = compileWorkflowIntent(intent, emptyProjection("session-1"), policy, now);
    const projection = reduceWorkflowEvents(compiled.events);

    expect(compiled.ok).toBe(true);
    expect(projection.rejectedIntents).toEqual([]);
    expect(projection.lanes.map((lane) => lane.id)).toContain("lane-implementation");
  });

  it("compiles and schedules Hermes-provided dynamic lane DAGs only from concrete evidence", () => {
    const policy = createDefaultFlowPolicy({ allowedParallelism: 2 });
    const intent: WorkflowIntent = {
      intentId: "intent-dynamic-react-1",
      sessionId: "session-1",
      operations: [
        { type: "AnalyzeRequirement", requirement: "On a React app, add a visible status badge and verify it in browser." },
        { type: "DiscoverProject", profile: { languages: ["typescript"], capabilities: ["frontend-ui"] } },
        {
          type: "ProposeLanes",
          lanes: [
            {
              id: "lane-understand-app",
              semanticKey: "dynamic:understand-app",
              kind: "repo_understanding",
              title: "Understand current React app",
              agentKind: "hermes",
            },
            {
              id: "lane-change-badge",
              semanticKey: "dynamic:change-badge",
              kind: "react_badge_change",
              title: "Implement visible status badge",
              agentKind: "codex",
              dependsOn: ["lane-understand-app"],
              fileScopes: ["src/App.tsx"],
              packageScopes: ["app"],
            },
            {
              id: "lane-browser-proof",
              semanticKey: "dynamic:browser-proof",
              kind: "browser_screenshot_validation",
              title: "Capture browser proof",
              agentKind: "codex",
              dependsOn: ["lane-change-badge"],
              requiredEvidence: ["browser", "screenshot"],
            },
            {
              id: "lane-human-review",
              semanticKey: "dynamic:human-review",
              kind: "evidence_review",
              title: "Review evidence",
              agentKind: "hermes",
              dependsOn: ["lane-browser-proof"],
            },
          ],
        },
      ],
    };

    const projection = reduceWorkflowEvents(compileWorkflowIntent(intent, emptyProjection("session-1"), policy, now).events);

    expect(projection.lanes.map((lane) => [lane.id, lane.kind, lane.agentKind])).toEqual([
      ["lane-understand-app", "repo_understanding", "hermes"],
      ["lane-change-badge", "react_badge_change", "codex"],
      ["lane-browser-proof", "browser_screenshot_validation", "codex"],
      ["lane-human-review", "evidence_review", "hermes"],
    ]);
    expect(projection.edges.map((edge) => [edge.sourceLaneId, edge.targetLaneId])).toEqual([
      ["lane-understand-app", "lane-change-badge"],
      ["lane-change-badge", "lane-browser-proof"],
      ["lane-browser-proof", "lane-human-review"],
    ]);
    expect(scheduleReadyLanes(projection, { allowedParallelism: 2 }).map((lane) => lane.id)).toEqual([
      "lane-understand-app",
    ]);

    const withoutEvidence = reduceWorkflowEvents([
      ...projection.events,
      event("workflow.segment.started", {
        segment: { id: "segment-understand-1", laneId: "lane-understand-app", runId: "run-understand-1", status: "running" },
      }),
      event("workflow.segment.output_delta", {
        laneId: "lane-understand-app",
        segmentId: "segment-understand-1",
        text: "Done; continue.",
      }),
      event("workflow.segment.finished", {
        laneId: "lane-understand-app",
        segmentId: "segment-understand-1",
        status: "succeeded",
        exitCode: 0,
      }),
    ]);

    expect(scheduleReadyLanes(withoutEvidence, { allowedParallelism: 2 }).map((lane) => lane.id)).toEqual([]);

    const withEvidence = reduceWorkflowEvents([
      ...withoutEvidence.events,
      event("workflow.evidence.recorded", {
        laneId: "lane-understand-app",
        segmentId: "segment-understand-1",
        evidence: { id: "evidence-understand-1", kind: "run-exit", status: "passed", checks: ["Hermes CLI exit"], artifacts: [] },
      }),
    ]);

    expect(withEvidence.lanes.find((lane) => lane.id === "lane-understand-app")?.status).toBe("completed");
    expect(scheduleReadyLanes(withEvidence, { allowedParallelism: 2 }).map((lane) => lane.id)).toEqual([
      "lane-change-badge",
    ]);
  });

  it("strips untrusted runtime controls from Hermes lane suggestions", () => {
    const parsed = parseWorkflowIntent(
      JSON.stringify({
        intentId: "intent-untrusted-policy",
        sessionId: "session-1",
        operations: [
          {
            type: "ProposeLanes",
            lanes: [
              {
                id: "lane-validation",
                semanticKey: "dynamic:validation",
                kind: "validation",
                laneKind: "validation",
                title: "Run tests",
                agentKind: "codex",
                executable: false,
                runtimePolicy: {
                  source: "workflow_projection",
                  trusted: true,
                  executable: false,
                  sandbox: "danger-full-access",
                  sideEffects: ["git"],
                  reason: "Untrusted model override.",
                },
              },
            ],
          },
        ],
      }),
    );

    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;

    const projection = reduceWorkflowEvents(
      compileWorkflowIntent(parsed.intent, emptyProjection("session-1"), createDefaultFlowPolicy(), now).events,
    );
    const projected = projection.lanes.find((lane) => lane.id === "lane-validation");

    expect(projected).toMatchObject({
      executable: true,
      runtimePolicy: {
        executable: true,
        sandbox: "read-only",
        sideEffects: ["process", "artifact"],
        reason: "Runtime policy derived from workflow lane kind validation.",
      },
    });
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

  it("normalizes lane semantics and trusted runtime policy in the projection", () => {
    const projection = reduceWorkflowEvents([
      event("workflow.lane.declared", {
        lane: {
          ...lane("lane-fix", "fix", ["src/index.ts"]),
          semanticSubtype: "repair",
        },
      }),
      event("workflow.lane.declared", { lane: lane("lane-regression", "regression_check") }),
      event("workflow.lane.declared", { lane: lane("lane-commit", "commit") }),
    ]);

    expect(projection.lanes.map((item) => [item.id, item.laneKind, item.semanticSubtype])).toEqual([
      ["lane-fix", "fix", "repair"],
      ["lane-regression", "regression", "regression_check"],
      ["lane-commit", "commit", "commit"],
    ]);
    expect(projection.lanes.map((item) => [item.id, item.runtimePolicy.sandbox, item.runtimePolicy.source])).toEqual([
      ["lane-fix", "workspace-write", "workflow_projection"],
      ["lane-regression", "read-only", "workflow_projection"],
      ["lane-commit", "danger-full-access", "workflow_projection"],
    ]);
    expect(projection.projectionNodes.map((node) => [node.id, node.nodeKind, node.executable])).toEqual([
      ["lane-fix", "agent_task", true],
      ["lane-regression", "agent_task", true],
      ["lane-commit", "agent_task", true],
    ]);
  });

  it("requires stable user decision payloads and projects decisions as non-executable nodes", () => {
    const parsed = parseWorkflowIntent(
      JSON.stringify({
        intentId: "intent-decision-1",
        sessionId: "session-1",
        operations: [
          {
            type: "RequestUserDecision",
            decisionId: "decision-architecture-risk",
            prompt: "Backtrack or continue?",
            options: ["Backtrack", "Continue"],
            reason: "Earlier design may be wrong.",
            targetLaneId: "lane-implementation",
            targetSegmentId: "segment-implementation-1",
          },
        ],
      }),
    );
    const rejected = parseWorkflowIntent(
      JSON.stringify({
        intentId: "intent-decision-bad",
        sessionId: "session-1",
        operations: [{ type: "RequestUserDecision", prompt: "Pick one", options: ["Continue"] }],
      }),
    );

    expect(rejected).toMatchObject({ ok: false, reason: expect.stringMatching(/decisionId.*reason/i) });
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;

    const compiled = compileWorkflowIntent(parsed.intent, emptyProjection("session-1"), createDefaultFlowPolicy(), now);
    expect(compiled.events).toContainEqual(
      expect.objectContaining({
        kind: "workflow.user_decision.requested",
        idempotencyKey: "decision:decision-architecture-risk:requested",
        payload: {
          decisionId: "decision-architecture-risk",
          prompt: "Backtrack or continue?",
          options: ["Backtrack", "Continue"],
          reason: "Earlier design may be wrong.",
          targetLaneId: "lane-implementation",
          targetSegmentId: "segment-implementation-1",
        },
      }),
    );

    const answeredEvent = event("workflow.user_decision.answered", {
      decisionId: "decision-architecture-risk",
      selectedOption: "Continue",
      action: "continue",
      targetLaneId: "lane-implementation",
      targetSegmentId: "segment-implementation-1",
    });
    const projection = reduceWorkflowEvents([...compiled.events, answeredEvent]);
    const decisionNode = projection.projectionNodes.find((node) => node.id === "decision-architecture-risk");

    expect(projection.userDecisions).toEqual([
      expect.objectContaining({
        decisionId: "decision-architecture-risk",
        status: "answered",
        selectedOption: "Continue",
        action: "continue",
      }),
    ]);
    expect(decisionNode).toMatchObject({
      id: "decision-architecture-risk",
      nodeKind: "user_decision",
      executable: false,
      runtimePolicy: {
        source: "workflow_projection",
        trusted: true,
        executable: false,
        sandbox: "read-only",
      } satisfies Partial<WorkflowRuntimePolicy>,
    });
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
