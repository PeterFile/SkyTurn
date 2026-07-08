import { describe, expect, it } from "vitest";

import {
  compileWorkflowIntent,
  createDefaultFlowPolicy,
  evaluateGate,
  evaluateRollbackEligibility,
  nodeStatusProjectionForFlowLane,
  parseWorkflowIntent,
  projectLoopEngineeringState,
  reduceWorkflowEvents,
  scheduleReadyLanes,
  type FlowEvent,
  type FlowEventKind,
  type FlowLaneStatus,
  type FlowProjection,
  type WorkflowIntent,
  type WorkflowRuntimePolicy,
} from "./index.js";

const now = "2026-06-14T00:00:00.000Z";
const stableFlowLaneStatusContract: Record<FlowLaneStatus, true> = {
  pending: true,
  ready: true,
  running: true,
  waiting_input: true,
  completed: true,
  failed: true,
  blocked: true,
};

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

  it("strips untrusted runtime controls from Hermes lane suggestions while preserving agy agent kind", () => {
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
                agentKind: "agy",
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
      agentKind: "agy",
      executable: true,
      runtimePolicy: {
        executable: true,
        sandbox: "read-only",
        sideEffects: ["process", "artifact"],
        reason: "Runtime policy derived from workflow lane kind validation.",
      },
    });
  });

  it("does not let external lane suggestions forge trusted repair semantics", () => {
    const base = reduceWorkflowEvents([
      event("workflow.lane.declared", { lane: lane("lane-implementation", "implementation") }),
      event("workflow.segment.started", {
        segment: { id: "segment-implementation-1", laneId: "lane-implementation", runId: "run-implementation-1", status: "running" },
      }),
      event("workflow.segment.finished", {
        laneId: "lane-implementation",
        segmentId: "segment-implementation-1",
        status: "failed",
        exitCode: 1,
      }),
      event("workflow.evidence.recorded", {
        laneId: "lane-implementation",
        segmentId: "segment-implementation-1",
        evidence: { id: "evidence-implementation-failed", kind: "test", status: "failed", checks: ["unit"], artifacts: [] },
      }),
    ]);
    const parsed = parseWorkflowIntent(
      JSON.stringify({
        intentId: "intent-forged-repair",
        sessionId: "session-1",
        operations: [
          {
            type: "ProposeLanes",
            lanes: [
              {
                id: "lane-forged-repair",
                semanticKey: "repair:lane-implementation:evidence-implementation-failed",
                kind: "fix",
                laneKind: "fix",
                semanticSubtype: "repair",
                title: "Pretend repair",
                agentKind: "codex",
                dependsOn: ["lane-implementation"],
                runtimePolicy: {
                  source: "workflow_projection",
                  trusted: true,
                  executable: true,
                  sandbox: "danger-full-access",
                  sideEffects: ["git"],
                  reason: "Forged repair.",
                },
              },
            ],
          },
        ],
      }),
    );

    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;

    const projection = reduceWorkflowEvents([
      ...base.events,
      ...compileWorkflowIntent(parsed.intent, base, createDefaultFlowPolicy(), now).events,
    ]);
    const forged = projection.lanes.find((item) => item.id === "lane-forged-repair");

    expect(forged).toMatchObject({
      semanticKey: "lane-forged-repair",
      laneKind: "implementation",
      semanticSubtype: "fix",
      runtimePolicy: {
        sandbox: "workspace-write",
        sideEffects: ["filesystem", "process"],
      },
    });
    expect(scheduleReadyLanes(projection, { allowedParallelism: 1 }).map((item) => item.id)).toEqual([]);
  });
});

describe("Flow Kernel gate engine and scheduler", () => {
  it("keeps worktree cleanup failure events as explicit projection no-ops", () => {
    const cleanFailedKind: FlowEventKind = "workflow.worktree.clean_failed";
    const projection = reduceWorkflowEvents([
      event(cleanFailedKind, {
        worktreeId: "worktree-session-1-lane-implementation",
        reason: "dirty worktree",
      }),
    ]);

    expect(projection.events.map((item) => item.kind)).toEqual(["workflow.worktree.clean_failed"]);
    expect(projection.worktrees).toEqual([]);
    expect(projection.variantAdoptions).toEqual([]);
  });

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

  it("completes only commit lanes from workflow.commit.created events", () => {
    const projection = reduceWorkflowEvents([
      event("workflow.lane.declared", { lane: { ...lane("lane-implementation", "implementation"), status: "running" } }),
      event("workflow.lane.declared", { lane: { ...lane("lane-commit", "commit"), status: "running" } }),
      event("workflow.commit.created", { laneId: "lane-implementation" }),
      event("workflow.commit.created", { laneId: "unknown-lane" }),
      event("workflow.commit.created", { laneId: "lane-commit" }),
    ]);

    expect(projection.lanes.find((item) => item.id === "lane-implementation")?.status).toBe("running");
    expect(projection.lanes.find((item) => item.id === "lane-commit")?.status).toBe("completed");
  });

  it("records delivery push and pull request events without completing kernel lanes", () => {
    const projection = reduceWorkflowEvents([
      event("workflow.lane.declared", { lane: { ...lane("lane-commit", "commit"), status: "running" } }),
      event("workflow.lane.declared", { lane: { ...lane("lane-pr", "pull_request"), status: "running" } }),
      event("workflow.pull_request.created", {
        laneId: "lane-pr",
        commitLaneId: "lane-commit",
        evidence: { number: 12, url: "https://example.test/pr/12", head: "feature/slice-b", commitSha: "sha-a" },
      }),
      event("workflow.delivery.pushed", {
        laneId: "lane-commit",
        url: "https://example.test/compare",
        evidence: { remote: "origin", branch: "feature/slice-b", commitSha: "sha-b" },
      }),
    ]);

    expect(projection.lanes.find((item) => item.id === "lane-commit")?.status).toBe("running");
    expect(projection.lanes.find((item) => item.id === "lane-pr")?.status).toBe("running");
    expect(projection.lanes.find((item) => item.id === "lane-pr")?.laneKind).toBe("pull_request");
    expect(projection.events.map((item) => item.kind)).toContain("workflow.pull_request.created");
    expect(projection.events.map((item) => item.kind)).toContain("workflow.delivery.pushed");
    expect(projection.evidence.map((item) => [item.laneId, item.kind, item.status])).toEqual([
      ["lane-pr", "pull-request", "passed"],
      ["lane-commit", "delivery-push", "passed"],
    ]);

    const loopState = projectLoopEngineeringState(projection);
    expect(loopState.delivery.phase).toBe("pr_created");
    expect(loopState.nextAction).toMatchObject({
      kind: "wait_for_checks",
      loop: "delivery",
      laneId: "lane-pr",
    });
    expect(loopState.blockedReason).toMatchObject({ code: "pending_checks" });
  });

  it("uses a later delivery push as the current pull request head for check gates", () => {
    const checksRecordedKind = "workflow.pull_request.checks_recorded" as FlowEventKind;
    const base = [
      event("workflow.lane.declared", { lane: { ...lane("lane-commit", "commit"), status: "running" } }),
      event("workflow.lane.declared", { lane: { ...lane("lane-ci", "ci_check"), status: "running" } }),
      event("workflow.lane.declared", { lane: { ...lane("lane-pr", "pull_request"), status: "running" } }),
      event("workflow.pull_request.created", {
        laneId: "lane-pr",
        commitLaneId: "lane-commit",
        evidence: { number: 15, url: "https://example.test/pr/15", head: "feature/slice-b", commitSha: "sha-a" },
      }),
      event("workflow.delivery.pushed", {
        laneId: "lane-commit",
        url: "https://example.test/compare",
        evidence: { remote: "origin", branch: "feature/slice-b", commitSha: "sha-b" },
      }),
    ];
    const stale = reduceWorkflowEvents([
      ...base,
      event(checksRecordedKind, {
        laneId: "lane-ci",
        prNumber: 15,
        url: "https://example.test/pr/15/checks",
        headSha: "sha-a",
        status: "passed",
        review: { status: "approved" },
        checks: [{ name: "Build and test", status: "passed", url: "https://example.test/checks/1" }],
      }),
    ]);
    const exact = reduceWorkflowEvents([
      ...base,
      event(checksRecordedKind, {
        laneId: "lane-ci",
        prNumber: 15,
        url: "https://example.test/pr/15/checks",
        headSha: "sha-b",
        status: "passed",
        review: { status: "pending" },
        checks: [{ name: "Build and test", status: "passed", url: "https://example.test/checks/2" }],
      }),
    ]);
    const prGate = reduceWorkflowEvents([
      ...base,
      event(checksRecordedKind, {
        laneId: "lane-pr",
        prNumber: 15,
        url: "https://example.test/pr/15/checks",
        headSha: "sha-b",
        status: "passed",
        review: { status: "pending" },
        checks: [{ name: "Build and test", status: "passed", url: "https://example.test/checks/3" }],
      }),
    ]);

    expect(stale.lanes.find((item) => item.id === "lane-ci")?.status).toBe("running");
    expect(stale.lanes.find((item) => item.id === "lane-commit")?.status).toBe("running");
    expect(stale.lanes.find((item) => item.id === "lane-pr")?.status).toBe("running");
    expect(exact.lanes.find((item) => item.id === "lane-ci")?.status).toBe("completed");
    expect(exact.lanes.find((item) => item.id === "lane-commit")?.status).toBe("running");
    expect(exact.lanes.find((item) => item.id === "lane-pr")?.status).toBe("running");
    expect(prGate.lanes.find((item) => item.id === "lane-pr")?.status).toBe("completed");
    expect(prGate.lanes.find((item) => item.id === "lane-commit")?.status).toBe("running");
    expect(exact.evidence.at(-1)).toMatchObject({
      laneId: "lane-ci",
      kind: "pull-request-checks",
      status: "passed",
      checks: ["Build and test:passed", "review:pending"],
    });

    const staleLoopState = projectLoopEngineeringState(stale);
    expect(staleLoopState.delivery.phase).toBe("checks_stale");
    expect(staleLoopState.evidenceStale).toBe(true);
    expect(staleLoopState.nextAction).toMatchObject({
      kind: "blocked",
      loop: "delivery",
      laneId: "lane-ci",
    });
    expect(staleLoopState.blockedReason).toMatchObject({
      code: "stale_head",
      laneId: "lane-ci",
    });

    const exactLoopState = projectLoopEngineeringState(exact);
    expect(exactLoopState.delivery.phase).toBe("merge_ready");
    expect(exactLoopState.nextAction).toMatchObject({
      kind: "merge_pull_request",
      loop: "delivery",
      laneId: "lane-ci",
    });
  });

  it("blocks merge when a newer delivery push arrives after exact-head checks passed", () => {
    const checksRecordedKind = "workflow.pull_request.checks_recorded" as FlowEventKind;
    const projection = reduceWorkflowEvents([
      event("workflow.lane.declared", { lane: { ...lane("lane-commit", "commit"), status: "running" } }),
      event("workflow.lane.declared", { lane: { ...lane("lane-ci", "ci_check"), status: "running" } }),
      event("workflow.lane.declared", { lane: { ...lane("lane-pr", "pull_request"), status: "running" } }),
      event("workflow.lane.declared", { lane: lane("lane-merge", "merge") }),
      event("workflow.edge.declared", { edge: { id: "edge-ci-merge", sourceLaneId: "lane-ci", targetLaneId: "lane-merge" } }),
      event("workflow.pull_request.created", {
        laneId: "lane-pr",
        commitLaneId: "lane-commit",
        evidence: { number: 16, url: "https://example.test/pr/16", head: "feature/slice-c", commitSha: "sha-a" },
      }),
      event(checksRecordedKind, {
        laneId: "lane-ci",
        prNumber: 16,
        url: "https://example.test/pr/16/checks",
        headSha: "sha-a",
        status: "passed",
        review: { status: "approved" },
        checks: [{ name: "Build and test", status: "passed", url: "https://example.test/checks/1" }],
      }),
      event("workflow.delivery.pushed", {
        laneId: "lane-commit",
        url: "https://example.test/compare",
        evidence: { remote: "origin", branch: "feature/slice-c", commitSha: "sha-b" },
      }),
    ]);

    const loopState = projectLoopEngineeringState(projection);
    expect(projection.lanes.find((item) => item.id === "lane-ci")?.status).toBe("completed");
    expect(scheduleReadyLanes(projection, { allowedParallelism: 1 }).map((item) => item.id)).toEqual([]);
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
    expect(loopState.blockedReason).toMatchObject({
      code: "stale_head",
      laneId: "lane-ci",
    });
  });

  it("schedules merge when exact-head checks remain current", () => {
    const checksRecordedKind = "workflow.pull_request.checks_recorded" as FlowEventKind;
    const projection = reduceWorkflowEvents([
      event("workflow.lane.declared", { lane: { ...lane("lane-commit", "commit"), status: "running" } }),
      event("workflow.lane.declared", { lane: { ...lane("lane-ci", "ci_check"), status: "running" } }),
      event("workflow.lane.declared", { lane: { ...lane("lane-pr", "pull_request"), status: "running" } }),
      event("workflow.lane.declared", { lane: lane("lane-merge", "merge") }),
      event("workflow.edge.declared", { edge: { id: "edge-ci-merge", sourceLaneId: "lane-ci", targetLaneId: "lane-merge" } }),
      event("workflow.pull_request.created", {
        laneId: "lane-pr",
        commitLaneId: "lane-commit",
        evidence: { number: 16, url: "https://example.test/pr/16", head: "feature/slice-c", commitSha: "sha-a" },
      }),
      event(checksRecordedKind, {
        laneId: "lane-ci",
        prNumber: 16,
        url: "https://example.test/pr/16/checks",
        headSha: "sha-a",
        status: "passed",
        review: { status: "approved", detail: "One approving review." },
        checks: [{ name: "Build and test", status: "passed", url: "https://example.test/checks/1" }],
      }),
    ]);

    expect(projectLoopEngineeringState(projection).delivery).toMatchObject({
      phase: "merge_ready",
      review: { status: "approved", detail: "One approving review." },
    });
    expect(scheduleReadyLanes(projection, { allowedParallelism: 1 }).map((item) => item.id)).toEqual(["lane-merge"]);
  });

  it("keeps approved and pending review non-blocking when exact-head checks pass", () => {
    const checksRecordedKind = "workflow.pull_request.checks_recorded" as FlowEventKind;

    for (const reviewStatus of ["approved", "pending"] as const) {
      const projection = reduceWorkflowEvents([
        event("workflow.lane.declared", { lane: { ...lane("lane-ci", "ci_check"), status: "running" } }),
        event("workflow.pull_request.created", {
          laneId: "lane-ci",
          prNumber: 19,
          url: "https://example.test/pr/19",
          headSha: "sha-current",
        }),
        event(checksRecordedKind, {
          laneId: "lane-ci",
          prNumber: 19,
          url: "https://example.test/pr/19/checks",
          headSha: "sha-current",
          status: "passed",
          review: { status: reviewStatus },
          checks: [{ name: "Build and test", status: "passed", url: "https://example.test/checks/19" }],
        }),
      ]);

      expect(projectLoopEngineeringState(projection).delivery).toMatchObject({
        phase: "merge_ready",
        review: { status: reviewStatus },
      });
      expect(projectLoopEngineeringState(projection).nextAction.kind).toBe("merge_pull_request");
    }
  });

  it("blocks merge when exact-head checks pass with unknown review evidence", () => {
    const checksRecordedKind = "workflow.pull_request.checks_recorded" as FlowEventKind;
    const projection = reduceWorkflowEvents([
      event("workflow.lane.declared", { lane: { ...lane("lane-ci", "ci_check"), status: "running" } }),
      event("workflow.lane.declared", { lane: lane("lane-merge", "merge") }),
      event("workflow.edge.declared", { edge: { id: "edge-ci-merge", sourceLaneId: "lane-ci", targetLaneId: "lane-merge" } }),
      event("workflow.pull_request.created", {
        laneId: "lane-ci",
        prNumber: 20,
        url: "https://example.test/pr/20",
        headSha: "sha-current",
      }),
      event(checksRecordedKind, {
        laneId: "lane-ci",
        prNumber: 20,
        url: "https://example.test/pr/20/checks",
        headSha: "sha-current",
        status: "passed",
        review: { status: "unknown" },
        checks: [{ name: "Build and test", status: "passed", url: "https://example.test/checks/20" }],
      }),
    ]);

    const loopState = projectLoopEngineeringState(projection);
    expect(projection.lanes.find((item) => item.id === "lane-ci")?.status).toBe("running");
    expect(scheduleReadyLanes(projection, { allowedParallelism: 1 }).map((item) => item.id)).toEqual([]);
    expect(loopState.delivery).toMatchObject({
      phase: "checks_pending",
      review: { status: "unknown" },
    });
    expect(loopState.nextAction.kind).not.toBe("merge_pull_request");
    expect(loopState.nextAction).toMatchObject({
      kind: "wait_for_checks",
      loop: "delivery",
      laneId: "lane-ci",
    });
  });

  it("blocks merge when exact-head checks pass without review evidence", () => {
    const checksRecordedKind = "workflow.pull_request.checks_recorded" as FlowEventKind;
    const projection = reduceWorkflowEvents([
      event("workflow.lane.declared", { lane: { ...lane("lane-ci", "ci_check"), status: "running" } }),
      event("workflow.lane.declared", { lane: lane("lane-merge", "merge") }),
      event("workflow.edge.declared", { edge: { id: "edge-ci-merge", sourceLaneId: "lane-ci", targetLaneId: "lane-merge" } }),
      event("workflow.pull_request.created", {
        laneId: "lane-ci",
        prNumber: 21,
        url: "https://example.test/pr/21",
        headSha: "sha-current",
      }),
      event(checksRecordedKind, {
        laneId: "lane-ci",
        prNumber: 21,
        url: "https://example.test/pr/21/checks",
        headSha: "sha-current",
        status: "passed",
        checks: [{ name: "Build and test", status: "passed", url: "https://example.test/checks/21" }],
      }),
    ]);

    const loopState = projectLoopEngineeringState(projection);
    expect(projection.lanes.find((item) => item.id === "lane-ci")?.status).toBe("running");
    expect(scheduleReadyLanes(projection, { allowedParallelism: 1 }).map((item) => item.id)).toEqual([]);
    expect(loopState.delivery).toMatchObject({
      phase: "checks_pending",
      review: { status: "unknown" },
    });
    expect(loopState.nextAction.kind).not.toBe("merge_pull_request");
    expect(loopState.nextAction).toMatchObject({
      kind: "wait_for_checks",
      loop: "delivery",
      laneId: "lane-ci",
    });
  });

  it("replays Electron checks events with nested evidence for exact-head gates", () => {
    const checksRecordedKind = "workflow.pull_request.checks_recorded" as FlowEventKind;
    const projection = reduceWorkflowEvents([
      event("workflow.lane.declared", { lane: { ...lane("lane-commit", "commit"), status: "running" } }),
      event("workflow.lane.declared", { lane: { ...lane("lane-ci", "ci_check"), status: "running" } }),
      event("workflow.lane.declared", { lane: { ...lane("lane-pr", "pull_request"), status: "running" } }),
      event("workflow.pull_request.created", {
        laneId: "lane-pr",
        commitLaneId: "lane-commit",
        evidence: { number: 17, url: "https://example.test/pr/17", head: "feature/slice-c", commitSha: "sha-c" },
      }),
      event("workflow.delivery.pushed", {
        laneId: "lane-commit",
        evidence: { remote: "origin", branch: "feature/slice-c", commitSha: "sha-c" },
      }),
      event(checksRecordedKind, {
        laneId: "lane-ci",
        evidence: {
          status: "passed",
          number: 17,
          url: "https://example.test/pr/17",
          headSha: "sha-c",
          review: { status: "pending", detail: "No blocking review." },
          checks: [{ name: "Build and test", status: "passed", link: "https://example.test/checks/current" }],
        },
      }),
    ]);

    expect(projection.lanes.find((item) => item.id === "lane-ci")?.status).toBe("completed");
    expect(projection.lanes.find((item) => item.id === "lane-commit")?.status).toBe("running");
    expect(projection.lanes.find((item) => item.id === "lane-pr")?.status).toBe("running");
    expect(projection.evidence.at(-1)).toMatchObject({
      laneId: "lane-ci",
      kind: "pull-request-checks",
      status: "passed",
      checks: ["Build and test:passed", "review:pending"],
      artifacts: ["https://example.test/pr/17", "https://example.test/checks/current"],
    });
  });

  it("does not complete validation gates for failed or pending pull request checks", () => {
    const checksRecordedKind = "workflow.pull_request.checks_recorded" as FlowEventKind;

    for (const status of ["failed", "pending"] as const) {
      const projection = reduceWorkflowEvents([
        event("workflow.lane.declared", { lane: { ...lane(`lane-ci-${status}`, "ci_check"), status: "running" } }),
        event("workflow.pull_request.created", {
          laneId: `lane-ci-${status}`,
          prNumber: 16,
          url: "https://example.test/pr/16",
          headSha: "sha-current",
        }),
        event(checksRecordedKind, {
          laneId: `lane-ci-${status}`,
          prNumber: 16,
          url: "https://example.test/pr/16/checks",
          headSha: "sha-current",
          status,
          checks: [{ name: "Build and test", status, url: "https://example.test/checks/3" }],
        }),
      ]);

      expect(projection.lanes.find((item) => item.id === `lane-ci-${status}`)?.status).toBe("running");
      expect(projection.evidence.at(-1)).toMatchObject({
        laneId: `lane-ci-${status}`,
        kind: "pull-request-checks",
        status,
      });
    }
  });

  it("projects changes-requested pull request checks as a merge blocker", () => {
    const checksRecordedKind = "workflow.pull_request.checks_recorded" as FlowEventKind;
    const projection = reduceWorkflowEvents([
      event("workflow.lane.declared", { lane: { ...lane("lane-ci", "ci_check"), status: "running" } }),
      event("workflow.pull_request.created", {
        laneId: "lane-ci",
        prNumber: 18,
        url: "https://example.test/pr/18",
        headSha: "sha-current",
      }),
      event(checksRecordedKind, {
        laneId: "lane-ci",
        prNumber: 18,
        url: "https://example.test/pr/18/checks",
        headSha: "sha-current",
        status: "passed",
        review: { status: "changes_requested", detail: "Reviewer requested changes." },
        checks: [{ name: "Build and test", status: "passed", url: "https://example.test/checks/18" }],
      }),
    ]);

    const loopState = projectLoopEngineeringState(projection);
    expect(projection.lanes.find((item) => item.id === "lane-ci")?.status).toBe("running");
    expect(loopState.delivery.phase).toBe("changes_requested");
    expect(loopState.delivery.review).toMatchObject({
      status: "changes_requested",
      detail: "Reviewer requested changes.",
    });
    expect(projection.evidence.at(-1)).toMatchObject({
      kind: "pull-request-checks",
      status: "failed",
      checks: ["Build and test:passed", "review:changes_requested"],
    });
    expect(loopState.nextAction).toMatchObject({
      kind: "blocked",
      loop: "delivery",
      laneId: "lane-ci",
    });
    expect(loopState.blockedReason).toMatchObject({ code: "changes_requested" });
  });

  it("expresses rollback remote blockers, affected lanes, restore commit, and local safety", () => {
    const projection = reduceWorkflowEvents([
      event("workflow.lane.declared", { lane: { ...lane("lane-b", "implementation"), status: "completed" } }),
      event("workflow.lane.declared", { lane: lane("lane-c", "validation") }),
      event("workflow.edge.declared", { edge: { id: "edge-b-c", sourceLaneId: "lane-b", targetLaneId: "lane-c" } }),
      event("workflow.node.checkpoint_recorded", {
        checkpoint: checkpoint("checkpoint-before-lane-b", "lane-b", "before", "restore-sha"),
      }),
      event("workflow.pull_request.created", {
        laneId: "lane-b",
        evidence: { number: 24, url: "https://example.test/pr/24", commitSha: "restore-sha" },
      }),
    ]);

    const loopState = projectLoopEngineeringState(projection, { selectedLaneId: "lane-b", localRollbackSafe: true });
    expect(loopState.rollback).toMatchObject({
      phase: "blocked",
      targetLaneId: "lane-b",
      checkpointId: "checkpoint-before-lane-b",
      checkpointPhase: "before",
      restoreCommitRef: "restore-sha",
      affectedLaneIds: ["lane-b", "lane-c"],
      affectedNodeIds: ["lane-b", "lane-c"],
      downstreamInactiveLaneIds: ["lane-c"],
      downstreamInactiveNodeIds: ["lane-c"],
      localRollbackSafe: true,
      localSafetyStatus: "safe",
    });
    expect(loopState.rollback.remoteBlockers).toEqual([
      expect.objectContaining({
        eventKind: "workflow.pull_request.created",
        status: "recorded",
        laneId: "lane-b",
        affectedLaneIds: ["lane-b"],
      }),
    ]);
    expect(loopState.blockedReason).toMatchObject({
      code: "remote_side_effect",
      affectedLaneIds: ["lane-b", "lane-c"],
    });
  });

  it("projects selected rollback impact without upstream or sibling lanes", () => {
    const projection = reduceWorkflowEvents([
      event("workflow.lane.declared", { lane: { ...lane("lane-a", "design"), status: "completed" } }),
      event("workflow.lane.declared", { lane: { ...lane("lane-b", "implementation"), status: "completed" } }),
      event("workflow.lane.declared", { lane: { ...lane("lane-c", "validation"), status: "completed" } }),
      event("workflow.lane.declared", { lane: { ...lane("lane-d", "review"), status: "completed" } }),
      event("workflow.edge.declared", { edge: { id: "edge-a-b", sourceLaneId: "lane-a", targetLaneId: "lane-b" } }),
      event("workflow.edge.declared", { edge: { id: "edge-b-c", sourceLaneId: "lane-b", targetLaneId: "lane-c" } }),
      event("workflow.edge.declared", { edge: { id: "edge-a-d", sourceLaneId: "lane-a", targetLaneId: "lane-d" } }),
      event("workflow.node.checkpoint_recorded", {
        checkpoint: checkpoint("checkpoint-before-lane-b", "lane-b", "before", "restore-sha", "node-b"),
      }),
    ]);

    const eligibility = evaluateRollbackEligibility(projection, "lane-b", {
      checkpointId: "checkpoint-before-lane-b",
      targetNodeId: "node-b",
      localRollbackSafe: true,
    });

    expect(eligibility).toMatchObject({
      eligible: true,
      targetLaneId: "lane-b",
      targetNodeId: "node-b",
      checkpointId: "checkpoint-before-lane-b",
      checkpointPhase: "before",
      restoreCommitRef: "restore-sha",
      affectedLaneIds: ["lane-b", "lane-c"],
      affectedNodeIds: ["node-b", "lane-c"],
      downstreamInactiveLaneIds: ["lane-c"],
      downstreamInactiveNodeIds: ["lane-c"],
      localRollbackSafe: true,
      localSafetyStatus: "safe",
      blockingRemoteSideEffects: [],
    });
    expect(eligibility.affectedLaneIds).not.toContain("lane-a");
    expect(eligibility.affectedLaneIds).not.toContain("lane-d");
  });

  it("blocks selected rollback when a downstream pull request exists", () => {
    const projection = reduceWorkflowEvents([
      event("workflow.lane.declared", { lane: { ...lane("lane-b", "implementation"), status: "completed" } }),
      event("workflow.lane.declared", { lane: { ...lane("lane-c", "pull_request"), status: "completed" } }),
      event("workflow.edge.declared", { edge: { id: "edge-b-c", sourceLaneId: "lane-b", targetLaneId: "lane-c" } }),
      event("workflow.node.checkpoint_recorded", {
        checkpoint: checkpoint("checkpoint-before-lane-b", "lane-b", "before", "restore-sha"),
      }),
      event("workflow.pull_request.created", {
        laneId: "lane-c",
        commitLaneId: "lane-b",
        evidence: { number: 42, url: "https://example.test/pr/42", commitSha: "restore-sha" },
      }),
    ]);

    expect(evaluateRollbackEligibility(projection, "lane-b", { checkpointId: "checkpoint-before-lane-b", localRollbackSafe: true })).toMatchObject({
      eligible: false,
      affectedLaneIds: ["lane-b", "lane-c"],
      downstreamInactiveLaneIds: ["lane-c"],
      localSafetyStatus: "safe",
      blockingRemoteSideEffects: [
        expect.objectContaining({
          eventKind: "workflow.pull_request.created",
          status: "recorded",
          laneId: "lane-c",
          affectedLaneIds: ["lane-c", "lane-b"],
        }),
      ],
      reason: "Remote side effects exist.",
    });
  });

  it("scopes prior rollback intent state to the selected lane", () => {
    const projection = reduceWorkflowEvents([
      event("workflow.lane.declared", { lane: { ...lane("lane-a", "implementation"), status: "completed" } }),
      event("workflow.lane.declared", { lane: { ...lane("lane-b", "validation"), status: "completed" } }),
      event("workflow.node.checkpoint_recorded", {
        checkpoint: checkpoint("checkpoint-before-lane-a", "lane-a", "before", "restore-a"),
      }),
      event("workflow.node.checkpoint_recorded", {
        checkpoint: checkpoint("checkpoint-before-lane-b", "lane-b", "before", "restore-b"),
      }),
      event("workflow.node.rollback_requested", {
        requestId: "rollback-lane-a",
        laneId: "lane-a",
        checkpointId: "checkpoint-before-lane-a",
        localRollbackSafe: true,
      }),
    ]);

    const loopState = projectLoopEngineeringState(projection, { selectedLaneId: "lane-b" });

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
  });

  it("does not project rolled-back or inactive lanes as the next executable action", () => {
    const projection = reduceWorkflowEvents([
      event("workflow.lane.declared", { lane: { ...lane("lane-b", "implementation"), status: "ready" } }),
      event("workflow.lane.declared", { lane: { ...lane("lane-c", "validation"), status: "ready" } }),
      event("workflow.edge.declared", { edge: { id: "edge-b-c", sourceLaneId: "lane-b", targetLaneId: "lane-c" } }),
      event("workflow.node.checkpoint_recorded", {
        checkpoint: checkpoint("checkpoint-before-lane-b", "lane-b", "before", "restore-sha"),
      }),
      event("workflow.node.rollback_applied", {
        requestId: "rollback-lane-b",
        laneId: "lane-b",
        checkpointId: "checkpoint-before-lane-b",
      }),
    ]);

    expect(projection.lanes.find((item) => item.id === "lane-b")).toMatchObject({ rollbackStatus: "rolled_back" });
    expect(projection.lanes.find((item) => item.id === "lane-c")).toMatchObject({ rollbackStatus: "inactive" });
    expect(scheduleReadyLanes(projection, { allowedParallelism: 3 })).toEqual([]);
    expect(projectLoopEngineeringState(projection, { allowedParallelism: 3 }).nextAction.kind).toBe("none");
  });

  it("records merge and cleanup requests without completing unrelated lanes", () => {
    const projection = reduceWorkflowEvents([
      event("workflow.lane.declared", { lane: { ...lane("lane-ci", "ci_check"), status: "running" } }),
      event("workflow.lane.declared", { lane: { ...lane("lane-merge", "merge"), status: "running" } }),
      event("workflow.variant.adopt_requested", {
        adoption: {
          adoptionId: "adoption-1",
          variantId: "variant-1",
          worktreeId: "worktree-1",
          strategy: "merge",
          status: "requested",
          baseCommit: "base",
          headCommit: "head",
          targetBranchName: "main",
        },
      }),
      event("workflow.worktree.clean_requested", { worktreeId: "worktree-1", laneId: "lane-merge" }),
    ]);

    expect(projection.lanes.find((item) => item.id === "lane-ci")?.status).toBe("running");
    expect(projection.lanes.find((item) => item.id === "lane-merge")?.status).toBe("running");
    expect(projection.variantAdoptions).toMatchObject([{ adoptionId: "adoption-1", strategy: "merge", status: "requested" }]);
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

  it("materializes one explicit repair chain from failed evidence and schedules only the fix from the failed dependency", () => {
    const base = reduceWorkflowEvents([
      event("workflow.lane.declared", { lane: lane("lane-implementation", "implementation") }),
      event("workflow.segment.started", {
        segment: { id: "segment-implementation-1", laneId: "lane-implementation", runId: "run-implementation-1", status: "running" },
      }),
      event("workflow.segment.finished", {
        laneId: "lane-implementation",
        segmentId: "segment-implementation-1",
        status: "failed",
        exitCode: 1,
      }),
      event("workflow.evidence.recorded", {
        laneId: "lane-implementation",
        segmentId: "segment-implementation-1",
        evidence: {
          id: "evidence-implementation-failed",
          kind: "test",
          status: "failed",
          checks: ["unit"],
          artifacts: ["artifacts/unit.log"],
          detail: "unit test failed",
        },
      }),
    ]);
    const intent: WorkflowIntent = {
      intentId: "intent-repair-1",
      sessionId: "session-1",
      operations: [{ type: "ReplanFromEvidence", laneId: "lane-implementation", evidenceId: "evidence-implementation-failed" }],
    };

    const compiled = compileWorkflowIntent(intent, base, createDefaultFlowPolicy(), now);
    const first = reduceWorkflowEvents([...base.events, ...compiled.events]);
    const replayed = reduceWorkflowEvents([
      ...first.events,
      ...compileWorkflowIntent({ ...intent, intentId: "intent-repair-replay" }, first, createDefaultFlowPolicy(), now).events,
    ]);
    const fix = first.lanes.find((item) => item.semanticKey === "repair:lane-implementation:evidence-implementation-failed");
    const regression = first.lanes.find((item) => item.semanticKey === "regression:lane-implementation:evidence-implementation-failed");

    expect(compiled.ok).toBe(true);
    expect(first.lanes.find((item) => item.id === "lane-implementation")?.status).toBe("failed");
    expect(fix).toMatchObject({
      laneKind: "fix",
      semanticSubtype: "repair",
      status: "pending",
      requiredEvidence: ["test"],
      runtimePolicy: { sandbox: "workspace-write" },
    });
    expect(regression).toMatchObject({
      laneKind: "regression",
      semanticSubtype: "regression_check",
      status: "pending",
      runtimePolicy: { sandbox: "read-only" },
    });
    expect(first.edges.map((edge) => [edge.sourceLaneId, edge.targetLaneId])).toEqual([
      ["lane-implementation", fix?.id],
      [fix?.id, regression?.id],
    ]);
    expect(scheduleReadyLanes(first, { allowedParallelism: 2 }).map((item) => item.id)).toEqual([fix?.id]);
    expect(replayed.lanes.filter((item) => item.semanticKey === fix?.semanticKey)).toHaveLength(1);
    expect(replayed.lanes.filter((item) => item.semanticKey === regression?.semanticKey)).toHaveLength(1);
  });

  it("does not auto-repair cancelled runs or failed repair lanes", () => {
    const cancelled = reduceWorkflowEvents([
      event("workflow.lane.declared", { lane: lane("lane-implementation", "implementation") }),
      event("workflow.segment.started", {
        segment: { id: "segment-cancelled-1", laneId: "lane-implementation", runId: "run-cancelled-1", status: "running" },
      }),
      event("workflow.segment.finished", {
        laneId: "lane-implementation",
        segmentId: "segment-cancelled-1",
        status: "cancelled",
        exitCode: null,
      }),
    ]);
    const repairFailed = reduceWorkflowEvents([
      event("workflow.lane.declared", { lane: { ...lane("lane-fix-implementation-evidence-1", "fix"), semanticKey: "repair:lane-implementation:evidence-1" } }),
      event("workflow.segment.started", {
        segment: { id: "segment-fix-1", laneId: "lane-fix-implementation-evidence-1", runId: "run-fix-1", status: "running" },
      }),
      event("workflow.segment.finished", {
        laneId: "lane-fix-implementation-evidence-1",
        segmentId: "segment-fix-1",
        status: "failed",
        exitCode: 1,
      }),
      event("workflow.evidence.recorded", {
        laneId: "lane-fix-implementation-evidence-1",
        segmentId: "segment-fix-1",
        evidence: { id: "evidence-fix-failed", kind: "test", status: "failed", checks: ["unit"], artifacts: [] },
      }),
    ]);

    const cancelledCompile = compileWorkflowIntent(
      {
        intentId: "intent-cancelled-repair",
        sessionId: "session-1",
        operations: [{ type: "ReplanFromEvidence", laneId: "lane-implementation", evidenceId: "evidence-cancelled" }],
      },
      cancelled,
      createDefaultFlowPolicy(),
      now,
    );
    const repairFailedCompile = compileWorkflowIntent(
      {
        intentId: "intent-second-level-repair",
        sessionId: "session-1",
        operations: [{ type: "ReplanFromEvidence", laneId: "lane-fix-implementation-evidence-1", evidenceId: "evidence-fix-failed" }],
      },
      repairFailed,
      createDefaultFlowPolicy(),
      now,
    );

    expect(cancelledCompile.ok).toBe(false);
    expect(cancelledCompile.reason).toMatch(/cancelled/i);
    expect(repairFailedCompile.ok).toBe(false);
    expect(repairFailedCompile.reason).toMatch(/repair/i);
  });

  it("rejects validation, review, and commit scheduling from failed dependencies", () => {
    const projection = reduceWorkflowEvents([
      event("workflow.lane.declared", { lane: { ...lane("lane-implementation", "implementation"), status: "failed" } }),
      event("workflow.lane.declared", { lane: lane("lane-validation", "validation") }),
      event("workflow.lane.declared", { lane: lane("lane-review", "review") }),
      event("workflow.lane.declared", { lane: lane("lane-commit", "commit") }),
      event("workflow.edge.declared", { edge: { id: "edge-implementation-validation", sourceLaneId: "lane-implementation", targetLaneId: "lane-validation" } }),
      event("workflow.edge.declared", { edge: { id: "edge-implementation-review", sourceLaneId: "lane-implementation", targetLaneId: "lane-review" } }),
      event("workflow.edge.declared", { edge: { id: "edge-implementation-commit", sourceLaneId: "lane-implementation", targetLaneId: "lane-commit" } }),
    ]);

    expect(scheduleReadyLanes(projection, { allowedParallelism: 3 }).map((item) => item.id)).toEqual([]);
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

  it("blocks downstream scheduling until a targeted user decision is answered", () => {
    const waiting = reduceWorkflowEvents([
      event("workflow.lane.declared", { lane: { ...lane("lane-implementation", "implementation"), status: "completed" } }),
      event("workflow.lane.declared", { lane: lane("lane-validation", "validation") }),
      event("workflow.edge.declared", { edge: { id: "edge-implementation-validation", sourceLaneId: "lane-implementation", targetLaneId: "lane-validation" } }),
      event("workflow.user_decision.requested", {
        decisionId: "decision-continue-after-risk",
        prompt: "Continue after architecture risk?",
        options: ["Continue", "Backtrack"],
        reason: "Risk affects validation path.",
        targetLaneId: "lane-implementation",
      }),
    ]);
    const answered = reduceWorkflowEvents([
      ...waiting.events,
      event("workflow.user_decision.answered", {
        decisionId: "decision-continue-after-risk",
        selectedOption: "Continue",
        action: "continue",
        targetLaneId: "lane-implementation",
      }),
    ]);

    expect(scheduleReadyLanes(waiting, { allowedParallelism: 1 }).map((item) => item.id)).toEqual([]);
    expect(scheduleReadyLanes(answered, { allowedParallelism: 1 }).map((item) => item.id)).toEqual(["lane-validation"]);
  });

  it("ignores answered user decisions that were never requested", () => {
    const projection = reduceWorkflowEvents([
      event("workflow.user_decision.answered", {
        decisionId: "decision-missing-request",
        selectedOption: "Continue",
        action: "continue",
      }),
    ]);

    expect(projection.userDecisions).toEqual([]);
    expect(projection.projectionNodes).toEqual([]);
  });

  it("keeps FlowLaneStatus stable and models rollback terminal state separately", () => {
    expect(Object.keys(stableFlowLaneStatusContract).sort()).toEqual([
      "blocked",
      "completed",
      "failed",
      "pending",
      "ready",
      "running",
      "waiting_input",
    ]);
  });

  it("projects flow lane status and rollback status to canonical canvas node status fields", () => {
    expect(nodeStatusProjectionForFlowLane("pending")).toEqual({ status: "pending" });
    expect(nodeStatusProjectionForFlowLane("ready")).toEqual({ status: "pending" });
    expect(nodeStatusProjectionForFlowLane("running")).toEqual({ status: "running" });
    expect(nodeStatusProjectionForFlowLane("waiting_input")).toEqual({ status: "running" });
    expect(nodeStatusProjectionForFlowLane("completed")).toEqual({ status: "completed" });
    expect(nodeStatusProjectionForFlowLane("failed")).toEqual({ status: "failed" });
    expect(nodeStatusProjectionForFlowLane("blocked")).toEqual({ status: "failed" });
    expect(nodeStatusProjectionForFlowLane("blocked", "inactive")).toEqual({
      status: "failed",
      rollbackStatus: "inactive",
    });
    expect(nodeStatusProjectionForFlowLane("completed", "rolled_back")).toEqual({
      status: "failed",
      rollbackStatus: "rolled_back",
    });
  });

  it("normalizes completed lanes with terminal rollbackStatus to non-completed canvas projection", () => {
    const projection = reduceWorkflowEvents([
      event("workflow.lane.declared", {
        lane: {
          ...lane("lane-rolled-back", "implementation"),
          status: "completed",
          rollbackStatus: "rolled_back",
        },
      }),
    ]);
    const laneItem = projection.lanes.find((item) => item.id === "lane-rolled-back");

    expect(laneItem).toMatchObject({
      status: "blocked",
      rollbackStatus: "rolled_back",
    });
    expect(nodeStatusProjectionForFlowLane(laneItem!)).toEqual({
      status: "failed",
      rollbackStatus: "rolled_back",
    });
  });

  it("keeps applied rollback lanes on stable lane status with canonical rollback projection", () => {
    const beforeCheckpointId = "checkpoint-before-lane-b-run-1";
    const projection = reduceWorkflowEvents([
      event("workflow.lane.declared", { lane: { ...lane("lane-b", "implementation"), status: "completed" } }),
      event("workflow.lane.declared", { lane: { ...lane("lane-c", "validation"), status: "ready" } }),
      event("workflow.edge.declared", { edge: { id: "edge-b-c", sourceLaneId: "lane-b", targetLaneId: "lane-c" } }),
      event("workflow.node.checkpoint_recorded", {
        checkpoint: checkpoint(beforeCheckpointId, "lane-b", "before", "base-sha"),
      }),
      event("workflow.node.rollback_applied", {
        requestId: "rollback-lane-b",
        laneId: "lane-b",
        checkpointId: beforeCheckpointId,
      }),
    ]);
    const targetLane = projection.lanes.find((item) => item.id === "lane-b");
    const downstreamLane = projection.lanes.find((item) => item.id === "lane-c");

    expectLaneRollback(projection, "lane-b", "rolled_back");
    expectLaneRollback(projection, "lane-c", "inactive");
    expect(targetLane?.status).toBe("blocked");
    expect(downstreamLane?.status).toBe("blocked");
    expect(nodeStatusProjectionForFlowLane(targetLane!)).toEqual({
      status: "failed",
      rollbackStatus: "rolled_back",
    });
    expect(nodeStatusProjectionForFlowLane(downstreamLane!)).toEqual({
      status: "failed",
      rollbackStatus: "inactive",
    });
  });

  it("retains rollback request, run evidence, and event history after applying rollback", () => {
    const beforeCheckpointId = "checkpoint-before-lane-b-run-1";
    const projection = reduceWorkflowEvents([
      event("workflow.lane.declared", { lane: { ...lane("lane-b", "implementation"), status: "completed" } }),
      event("workflow.lane.declared", { lane: { ...lane("lane-c", "validation"), status: "ready" } }),
      event("workflow.edge.declared", { edge: { id: "edge-b-c", sourceLaneId: "lane-b", targetLaneId: "lane-c" } }),
      event("workflow.segment.started", {
        segment: { id: "segment-b-1", laneId: "lane-b", runId: "run-b-1", status: "running" },
      }),
      event("workflow.segment.output_delta", {
        laneId: "lane-b",
        segmentId: "segment-b-1",
        text: "implementation output\n",
      }),
      event("workflow.evidence.recorded", {
        laneId: "lane-b",
        segmentId: "segment-b-1",
        evidence: { id: "evidence-b-1", kind: "run-exit", status: "passed", checks: ["unit"], artifacts: ["artifact-b"] },
      }),
      event("workflow.node.checkpoint_recorded", {
        checkpoint: checkpoint(beforeCheckpointId, "lane-b", "before", "base-sha"),
      }),
      event("workflow.node.rollback_requested", {
        requestId: "rollback-lane-b",
        laneId: "lane-b",
        checkpointId: beforeCheckpointId,
        localRollbackSafe: true,
      }),
      event("workflow.node.rollback_applied", {
        requestId: "rollback-lane-b",
        laneId: "lane-b",
        checkpointId: beforeCheckpointId,
        localRollbackSafe: true,
      }),
    ]);

    expectLaneRollback(projection, "lane-b", "rolled_back");
    expectLaneRollback(projection, "lane-c", "inactive");
    expect(projection.rollbackIntents).toEqual([
      expect.objectContaining({
        intentId: "rollback-lane-b",
        status: "applied",
        checkpointId: beforeCheckpointId,
      }),
    ]);
    expect(projection.evidence).toEqual([
      expect.objectContaining({
        id: "evidence-b-1",
        laneId: "lane-b",
        status: "passed",
      }),
    ]);
    expect(projection.lanes.find((lane) => lane.id === "lane-b")).toMatchObject({
      output: ["implementation output\n"],
    });
    expect(projection.events.map((item) => item.kind)).toEqual([
      "workflow.lane.declared",
      "workflow.lane.declared",
      "workflow.edge.declared",
      "workflow.segment.started",
      "workflow.segment.output_delta",
      "workflow.evidence.recorded",
      "workflow.node.checkpoint_recorded",
      "workflow.node.rollback_requested",
      "workflow.node.rollback_applied",
    ]);
  });

  it("keeps late-declared downstream lanes inactive after rollback_applied", () => {
    const beforeCheckpointId = "checkpoint-before-lane-b-run-1";
    const projection = reduceWorkflowEvents([
      event("workflow.edge.declared", { edge: { id: "edge-b-c", sourceLaneId: "lane-b", targetLaneId: "lane-c" } }),
      event("workflow.lane.declared", { lane: { ...lane("lane-b", "implementation"), status: "completed" } }),
      event("workflow.node.checkpoint_recorded", {
        checkpoint: checkpoint(beforeCheckpointId, "lane-b", "before", "base-sha"),
      }),
      event("workflow.node.rollback_applied", {
        requestId: "rollback-lane-b",
        laneId: "lane-b",
        checkpointId: beforeCheckpointId,
      }),
      event("workflow.lane.declared", { lane: { ...lane("lane-c", "validation"), status: "ready" } }),
    ]);

    expectLaneRollback(projection, "lane-b", "rolled_back");
    expectLaneRollback(projection, "lane-c", "inactive");
    expect(scheduleReadyLanes(projection, { allowedParallelism: 1 }).map((item) => item.id)).toEqual([]);
  });

  it("rejects RequestReview when prior implementation evidence belongs to a rolled-back lane", () => {
    const beforeCheckpointId = "checkpoint-before-lane-implementation-run-1";
    const projection = reduceWorkflowEvents([
      event("workflow.lane.declared", { lane: { ...lane("lane-implementation", "implementation"), status: "completed" } }),
      event("workflow.segment.started", {
        segment: { id: "segment-implementation-1", laneId: "lane-implementation", runId: "run-implementation-1", status: "running" },
      }),
      event("workflow.evidence.recorded", {
        laneId: "lane-implementation",
        segmentId: "segment-implementation-1",
        evidence: { id: "evidence-implementation", kind: "test", status: "passed", checks: ["unit"], artifacts: [] },
      }),
      event("workflow.node.checkpoint_recorded", {
        checkpoint: checkpoint(beforeCheckpointId, "lane-implementation", "before", "base-sha"),
      }),
      event("workflow.node.rollback_applied", {
        requestId: "rollback-lane-implementation",
        laneId: "lane-implementation",
        checkpointId: beforeCheckpointId,
      }),
    ]);

    expectLaneRollback(projection, "lane-implementation", "rolled_back");
    expect(evaluateGate(projection, { type: "RequestReview", laneId: "lane-review" })).toMatchObject({
      allowed: false,
      reason: expect.stringMatching(/implementation evidence/i),
    });
  });

  it("rejects rollback_requested with a missing checkpoint without mutating lane statuses", () => {
    const beforeCheckpointId = "checkpoint-before-lane-b-run-1";
    const projection = reduceWorkflowEvents([
      event("workflow.lane.declared", { lane: { ...lane("lane-b", "implementation"), status: "completed", output: ["B output"] } }),
      event("workflow.lane.declared", { lane: { ...lane("lane-c", "validation"), status: "ready", output: ["C output"] } }),
      event("workflow.edge.declared", { edge: { id: "edge-b-c", sourceLaneId: "lane-b", targetLaneId: "lane-c" } }),
      event("workflow.node.checkpoint_recorded", {
        checkpoint: checkpoint(beforeCheckpointId, "lane-b", "before", "base-sha"),
      }),
      event("workflow.node.rollback_requested", {
        requestId: "rollback-lane-b",
        laneId: "lane-b",
        checkpointId: "missing-checkpoint",
        localRollbackSafe: true,
      }),
    ]);

    expect(projection.rollbackIntents).toEqual([
      expect.objectContaining({
        kind: "rollback",
        status: "rejected",
        checkpointId: "missing-checkpoint",
        eligibility: expect.objectContaining({
          eligible: false,
          reason: expect.stringMatching(/before checkpoint/i),
        }),
      }),
    ]);
    expect(projection.lanes.find((item) => item.id === "lane-b")?.status).toBe("completed");
    expect(projection.lanes.find((item) => item.id === "lane-c")?.status).toBe("ready");
    expect(projection.lanes.find((item) => item.id === "lane-b")).not.toHaveProperty("rollbackStatus");
    expect(projection.lanes.find((item) => item.id === "lane-c")).not.toHaveProperty("rollbackStatus");
    expect(projection.lanes.find((item) => item.id === "lane-b")?.output).toEqual(["B output"]);
    expect(projection.lanes.find((item) => item.id === "lane-c")?.output).toEqual(["C output"]);
  });

  it("rejects rollback_requested with wrong-phase or wrong-lane checkpoints without mutating lane statuses", () => {
    const afterCheckpointId = "checkpoint-after-lane-b-run-1";
    const otherLaneCheckpointId = "checkpoint-before-lane-a-run-1";
    const projection = reduceWorkflowEvents([
      event("workflow.lane.declared", { lane: { ...lane("lane-a", "implementation"), status: "completed" } }),
      event("workflow.lane.declared", { lane: { ...lane("lane-b", "implementation"), status: "completed" } }),
      event("workflow.lane.declared", { lane: { ...lane("lane-c", "validation"), status: "ready" } }),
      event("workflow.edge.declared", { edge: { id: "edge-b-c", sourceLaneId: "lane-b", targetLaneId: "lane-c" } }),
      event("workflow.node.checkpoint_recorded", {
        checkpoint: checkpoint(afterCheckpointId, "lane-b", "after", "head-sha"),
      }),
      event("workflow.node.checkpoint_recorded", {
        checkpoint: checkpoint(otherLaneCheckpointId, "lane-a", "before", "base-sha"),
      }),
      event("workflow.node.rollback_requested", {
        requestId: "rollback-wrong-phase",
        laneId: "lane-b",
        checkpointId: afterCheckpointId,
        localRollbackSafe: true,
      }),
      event("workflow.node.rollback_requested", {
        requestId: "rollback-wrong-lane",
        laneId: "lane-b",
        checkpointId: otherLaneCheckpointId,
        localRollbackSafe: true,
      }),
    ]);

    expect(projection.rollbackIntents).toEqual([
      expect.objectContaining({
        intentId: "rollback-wrong-phase",
        status: "rejected",
        checkpointId: afterCheckpointId,
        reason: expect.stringMatching(/before checkpoint/i),
      }),
      expect.objectContaining({
        intentId: "rollback-wrong-lane",
        status: "rejected",
        checkpointId: otherLaneCheckpointId,
        reason: expect.stringMatching(/matching checkpoint/i),
      }),
    ]);
    expect(projection.lanes.find((item) => item.id === "lane-a")?.status).toBe("completed");
    expect(projection.lanes.find((item) => item.id === "lane-b")?.status).toBe("completed");
    expect(projection.lanes.find((item) => item.id === "lane-c")?.status).toBe("ready");
  });

  it("keeps explicit rollback payload target identity when checkpoint ownership mismatches", () => {
    const otherLaneCheckpointId = "checkpoint-before-lane-a-run-1";
    const projection = reduceWorkflowEvents([
      event("workflow.lane.declared", { lane: { ...lane("lane-a", "implementation"), status: "completed" } }),
      event("workflow.lane.declared", { lane: { ...lane("lane-b", "implementation"), status: "completed" } }),
      event("workflow.lane.declared", { lane: { ...lane("lane-c", "validation"), status: "ready" } }),
      event("workflow.edge.declared", { edge: { id: "edge-b-c", sourceLaneId: "lane-b", targetLaneId: "lane-c" } }),
      event("workflow.node.checkpoint_recorded", {
        checkpoint: checkpoint(otherLaneCheckpointId, "lane-a", "before", "base-sha", "node-a"),
      }),
      event("workflow.node.rollback_applied", {
        requestId: "rollback-explicit-b-with-a-checkpoint",
        laneId: "lane-b",
        nodeId: "node-b",
        checkpointId: otherLaneCheckpointId,
        localRollbackSafe: true,
      }),
    ]);

    expect(projection.rollbackIntents).toEqual([
      expect.objectContaining({
        intentId: "rollback-explicit-b-with-a-checkpoint",
        status: "rejected",
        laneId: "lane-b",
        nodeId: "node-b",
        checkpointId: otherLaneCheckpointId,
        reason: expect.stringMatching(/matching checkpoint/i),
      }),
    ]);
    expect(projection.lanes.find((item) => item.id === "lane-a")?.status).toBe("completed");
    expect(projection.lanes.find((item) => item.id === "lane-b")?.status).toBe("completed");
    expect(projection.lanes.find((item) => item.id === "lane-c")?.status).toBe("ready");
  });

  it("rejects lane-less checkpoint rollback for arbitrary payload lanes without mutating lane statuses", () => {
    const laneLessCheckpointId = "checkpoint-before-node-orphan-run-1";
    const projection = reduceWorkflowEvents([
      event("workflow.lane.declared", { lane: { ...lane("lane-b", "implementation"), status: "completed" } }),
      event("workflow.lane.declared", { lane: { ...lane("lane-c", "validation"), status: "ready" } }),
      event("workflow.edge.declared", { edge: { id: "edge-b-c", sourceLaneId: "lane-b", targetLaneId: "lane-c" } }),
      event("workflow.node.checkpoint_recorded", {
        checkpoint: {
          id: laneLessCheckpointId,
          sessionId: "session-1",
          nodeId: "node-orphan",
          phase: "before",
          executionTarget: "new_worktree",
          headCommit: "base-sha",
          createdAt: now,
          source: "agent_bridge",
          evidenceRefs: [{ kind: "run", id: "run-orphan-1" }],
        },
      }),
      event("workflow.node.rollback_applied", {
        requestId: "rollback-arbitrary-lane",
        laneId: "lane-b",
        checkpointId: laneLessCheckpointId,
        localRollbackSafe: true,
      }),
    ]);

    expect(projection.rollbackIntents).toEqual([
      expect.objectContaining({
        intentId: "rollback-arbitrary-lane",
        status: "rejected",
        checkpointId: laneLessCheckpointId,
        reason: expect.stringMatching(/matching checkpoint/i),
      }),
    ]);
    expect(projection.lanes.find((item) => item.id === "lane-b")?.status).toBe("completed");
    expect(projection.lanes.find((item) => item.id === "lane-c")?.status).toBe("ready");
  });

  it("rejects rollback_requested when local rollback is explicitly unsafe without mutating lane statuses", () => {
    const beforeCheckpointId = "checkpoint-before-lane-b-run-1";
    const projection = reduceWorkflowEvents([
      event("workflow.lane.declared", { lane: { ...lane("lane-b", "implementation"), status: "completed", output: ["B output"] } }),
      event("workflow.lane.declared", { lane: { ...lane("lane-c", "validation"), status: "ready", output: ["C output"] } }),
      event("workflow.edge.declared", { edge: { id: "edge-b-c", sourceLaneId: "lane-b", targetLaneId: "lane-c" } }),
      event("workflow.node.checkpoint_recorded", {
        checkpoint: checkpoint(beforeCheckpointId, "lane-b", "before", "base-sha"),
      }),
      event("workflow.node.rollback_requested", {
        requestId: "rollback-lane-b",
        laneId: "lane-b",
        checkpointId: beforeCheckpointId,
        localRollbackSafe: false,
      }),
    ]);

    expect(projection.rollbackIntents).toEqual([
      expect.objectContaining({
        intentId: "rollback-lane-b",
        status: "rejected",
        localRollbackSafe: false,
        eligibility: expect.objectContaining({
          eligible: false,
          localRollbackSafe: false,
          reason: expect.stringMatching(/local rollback/i),
        }),
      }),
    ]);
    expect(projection.lanes.find((item) => item.id === "lane-b")?.status).toBe("completed");
    expect(projection.lanes.find((item) => item.id === "lane-c")?.status).toBe("ready");
    expect(projection.lanes.find((item) => item.id === "lane-b")?.output).toEqual(["B output"]);
    expect(projection.lanes.find((item) => item.id === "lane-c")?.output).toEqual(["C output"]);
  });

  it("rejects rollback_applied when local rollback is explicitly unsafe without mutating lane statuses", () => {
    const beforeCheckpointId = "checkpoint-before-lane-b-run-1";
    const projection = reduceWorkflowEvents([
      event("workflow.lane.declared", { lane: { ...lane("lane-b", "implementation"), status: "completed" } }),
      event("workflow.lane.declared", { lane: { ...lane("lane-c", "validation"), status: "ready" } }),
      event("workflow.edge.declared", { edge: { id: "edge-b-c", sourceLaneId: "lane-b", targetLaneId: "lane-c" } }),
      event("workflow.node.checkpoint_recorded", {
        checkpoint: checkpoint(beforeCheckpointId, "lane-b", "before", "base-sha"),
      }),
      event("workflow.node.rollback_applied", {
        requestId: "rollback-lane-b",
        laneId: "lane-b",
        checkpointId: beforeCheckpointId,
        localRollbackSafe: false,
      }),
    ]);

    expect(projection.rollbackIntents).toEqual([
      expect.objectContaining({
        intentId: "rollback-lane-b",
        status: "rejected",
        localRollbackSafe: false,
        eligibility: expect.objectContaining({
          eligible: false,
          localRollbackSafe: false,
          reason: expect.stringMatching(/local rollback/i),
        }),
      }),
    ]);
    expect(projection.lanes.find((item) => item.id === "lane-b")?.status).toBe("completed");
    expect(projection.lanes.find((item) => item.id === "lane-c")?.status).toBe("ready");
  });

  it("does not let rejected local rollback safety poison later eligibility", () => {
    const beforeCheckpointId = "checkpoint-before-lane-b-run-1";
    const projection = reduceWorkflowEvents([
      event("workflow.lane.declared", { lane: { ...lane("lane-b", "implementation"), status: "completed" } }),
      event("workflow.lane.declared", { lane: { ...lane("lane-c", "validation"), status: "ready" } }),
      event("workflow.edge.declared", { edge: { id: "edge-b-c", sourceLaneId: "lane-b", targetLaneId: "lane-c" } }),
      event("workflow.node.checkpoint_recorded", {
        checkpoint: checkpoint(beforeCheckpointId, "lane-b", "before", "base-sha"),
      }),
      event("workflow.node.rollback_rejected", {
        requestId: "rollback-dirty-worktree",
        laneId: "lane-b",
        checkpointId: beforeCheckpointId,
        localRollbackSafe: false,
        reasonCode: "dirty_worktree",
        reason: "Worktree has uncommitted changes.",
        manualRepairRequired: true,
      }),
    ]);

    expect(projection.rollbackIntents).toEqual([
      expect.objectContaining({
        intentId: "rollback-dirty-worktree",
        status: "rejected",
        localRollbackSafe: false,
      }),
    ]);
    expect(evaluateRollbackEligibility(projection, "lane-b", { checkpointId: beforeCheckpointId })).toMatchObject({
      eligible: true,
      checkpointId: beforeCheckpointId,
      affectedLaneIds: ["lane-b", "lane-c"],
      blockingRemoteSideEffects: [],
    });
  });

  it("rejects rollback events when the before checkpoint has no restore commit ref", () => {
    const beforeCheckpointId = "checkpoint-before-lane-b-run-1";
    const cases: Array<{ kind: FlowEventKind; requestId: string }> = [
      { kind: "workflow.node.rollback_requested", requestId: "rollback-request-no-restore-ref" },
      { kind: "workflow.node.rollback_applied", requestId: "rollback-applied-no-restore-ref" },
    ];

    for (const item of cases) {
      const projection = reduceWorkflowEvents([
        event("workflow.lane.declared", { lane: { ...lane("lane-b", "implementation"), status: "completed" } }),
        event("workflow.lane.declared", { lane: { ...lane("lane-c", "validation"), status: "ready" } }),
        event("workflow.edge.declared", { edge: { id: "edge-b-c", sourceLaneId: "lane-b", targetLaneId: "lane-c" } }),
        event("workflow.node.checkpoint_recorded", {
          checkpoint: {
            id: beforeCheckpointId,
            sessionId: "session-1",
            nodeId: "lane-b",
            laneId: "lane-b",
            runId: "run-b-1",
            segmentId: "segment-b-1",
            phase: "before",
            executionTarget: "new_worktree",
            worktreeId: "worktree-b",
            worktreePath: "/repo.worktrees/session-1-lane-b",
            createdAt: now,
            source: "agent_bridge",
            evidenceRefs: [{ kind: "run", id: "run-b-1" }],
          },
        }),
        event(item.kind, {
          requestId: item.requestId,
          laneId: "lane-b",
          checkpointId: beforeCheckpointId,
          localRollbackSafe: true,
        }),
      ]);

      expect(evaluateRollbackEligibility(projection, "lane-b", { checkpointId: beforeCheckpointId })).toMatchObject({
        eligible: false,
        checkpointId: beforeCheckpointId,
        reason: expect.stringMatching(/restore commit/i),
      });
      expect(projection.rollbackIntents).toEqual([
        expect.objectContaining({
          intentId: item.requestId,
          status: "rejected",
          checkpointId: beforeCheckpointId,
          eligibility: expect.objectContaining({
            eligible: false,
            reason: expect.stringMatching(/restore commit/i),
          }),
        }),
      ]);
      expect(projection.lanes.find((laneItem) => laneItem.id === "lane-b")?.status).toBe("completed");
      expect(projection.lanes.find((laneItem) => laneItem.id === "lane-c")?.status).toBe("ready");
    }
  });

  it("rejects rollback when checkpoint authority fields were defaulted instead of explicit", () => {
    const missingPhaseCheckpointId = "checkpoint-missing-phase";
    const missingTargetCheckpointId = "checkpoint-missing-execution-target";
    const cases: Array<{
      checkpointId: string;
      checkpoint: Record<string, unknown>;
      reason: RegExp;
    }> = [
      {
        checkpointId: missingPhaseCheckpointId,
        checkpoint: {
          id: missingPhaseCheckpointId,
          sessionId: "session-1",
          nodeId: "lane-b",
          laneId: "lane-b",
          executionTarget: "new_worktree",
          baseCommit: "base-sha",
          createdAt: now,
          source: "agent_bridge",
          evidenceRefs: [{ kind: "run", id: "run-b-1" }],
        },
        reason: /explicit before checkpoint/i,
      },
      {
        checkpointId: missingTargetCheckpointId,
        checkpoint: {
          id: missingTargetCheckpointId,
          sessionId: "session-1",
          nodeId: "lane-b",
          laneId: "lane-b",
          phase: "before",
          baseCommit: "base-sha",
          createdAt: now,
          source: "agent_bridge",
          evidenceRefs: [{ kind: "run", id: "run-b-1" }],
        },
        reason: /execution target/i,
      },
    ];

    for (const item of cases) {
      const projection = reduceWorkflowEvents([
        event("workflow.lane.declared", { lane: { ...lane("lane-b", "implementation"), status: "completed" } }),
        event("workflow.lane.declared", { lane: { ...lane("lane-c", "validation"), status: "ready" } }),
        event("workflow.edge.declared", { edge: { id: "edge-b-c", sourceLaneId: "lane-b", targetLaneId: "lane-c" } }),
        event("workflow.node.checkpoint_recorded", { checkpoint: item.checkpoint }),
        event("workflow.node.rollback_applied", {
          requestId: `rollback-${item.checkpointId}`,
          laneId: "lane-b",
          checkpointId: item.checkpointId,
          localRollbackSafe: true,
        }),
      ]);

      expect(evaluateRollbackEligibility(projection, "lane-b", { checkpointId: item.checkpointId })).toMatchObject({
        eligible: false,
        checkpointId: item.checkpointId,
        reason: expect.stringMatching(item.reason),
      });
      expect(projection.rollbackIntents).toEqual([
        expect.objectContaining({
          status: "rejected",
          checkpointId: item.checkpointId,
          eligibility: expect.objectContaining({
            eligible: false,
            reason: expect.stringMatching(item.reason),
          }),
        }),
      ]);
      expect(projection.lanes.find((laneItem) => laneItem.id === "lane-b")?.status).toBe("completed");
      expect(projection.lanes.find((laneItem) => laneItem.id === "lane-c")?.status).toBe("ready");
    }
  });

  it("requires headCommit as rollback restoreCommitRef and treats baseCommit as metadata only", () => {
    const withHeadCheckpointId = "checkpoint-before-lane-b-with-head";
    const baseOnlyCheckpointId = "checkpoint-before-lane-b-base-only";
    const requested = reduceWorkflowEvents([
      event("workflow.lane.declared", { lane: { ...lane("lane-b", "implementation"), status: "completed" } }),
      event("workflow.lane.declared", { lane: { ...lane("lane-c", "validation"), status: "ready" } }),
      event("workflow.edge.declared", { edge: { id: "edge-b-c", sourceLaneId: "lane-b", targetLaneId: "lane-c" } }),
      event("workflow.node.checkpoint_recorded", {
        checkpoint: checkpoint(withHeadCheckpointId, "lane-b", "before", "head-sha"),
      }),
      event("workflow.node.checkpoint_recorded", {
        checkpoint: {
          ...checkpoint(baseOnlyCheckpointId, "lane-b", "before", "base-sha"),
          headCommit: undefined,
        },
      }),
      event("workflow.node.rollback_requested", {
        requestId: "rollback-request-base-only",
        laneId: "lane-b",
        checkpointId: baseOnlyCheckpointId,
        localRollbackSafe: true,
      }),
    ]);
    const applied = reduceWorkflowEvents([
      ...requested.events,
      event("workflow.node.rollback_applied", {
        requestId: "rollback-applied-base-only",
        laneId: "lane-b",
        checkpointId: baseOnlyCheckpointId,
        localRollbackSafe: true,
      }),
    ]);

    expect(evaluateRollbackEligibility(requested, "lane-b", { checkpointId: withHeadCheckpointId })).toMatchObject({
      eligible: true,
      restoreCommitRef: "head-sha",
    });
    expect(evaluateRollbackEligibility(requested, "lane-b", { checkpointId: baseOnlyCheckpointId })).toMatchObject({
      eligible: false,
      checkpointId: baseOnlyCheckpointId,
      reason: expect.stringMatching(/restore commit/i),
    });
    expect(requested.rollbackIntents).toEqual([
      expect.objectContaining({
        intentId: "rollback-request-base-only",
        status: "rejected",
        eligibility: expect.objectContaining({
          eligible: false,
          reason: expect.stringMatching(/restore commit/i),
        }),
      }),
    ]);
    expect(applied.rollbackIntents).toContainEqual(
      expect.objectContaining({
        intentId: "rollback-applied-base-only",
        status: "rejected",
        eligibility: expect.objectContaining({
          eligible: false,
          reason: expect.stringMatching(/restore commit/i),
        }),
      }),
    );
    expect(requested.lanes.find((item) => item.id === "lane-b")?.status).toBe("completed");
    expect(requested.lanes.find((item) => item.id === "lane-c")?.status).toBe("ready");
    expect(applied.lanes.find((item) => item.id === "lane-b")?.status).toBe("completed");
    expect(applied.lanes.find((item) => item.id === "lane-c")?.status).toBe("ready");
  });

  it("rejects repair, variant, and fork intents when the required checkpoint phase was defaulted", () => {
    const defaultedBeforeCheckpointId = "checkpoint-defaulted-before-lane-b";
    const explicitAfterCheckpointId = "checkpoint-after-lane-b-run-1";
    const projection = reduceWorkflowEvents([
      event("workflow.lane.declared", { lane: { ...lane("lane-b", "implementation"), status: "completed" } }),
      event("workflow.node.checkpoint_recorded", {
        checkpoint: {
          id: defaultedBeforeCheckpointId,
          sessionId: "session-1",
          nodeId: "lane-b",
          laneId: "lane-b",
          executionTarget: "new_worktree",
          headCommit: "head-before-sha",
          createdAt: now,
          source: "agent_bridge",
          evidenceRefs: [{ kind: "run", id: "run-b-1" }],
        },
      }),
      event("workflow.node.checkpoint_recorded", {
        checkpoint: checkpoint(explicitAfterCheckpointId, "lane-b", "after", "head-after-sha"),
      }),
      event("workflow.node.variant_requested", {
        intentId: "variant-defaulted-before",
        laneId: "lane-b",
        checkpointId: defaultedBeforeCheckpointId,
      }),
      event("workflow.node.fork_requested", {
        intentId: "fork-defaulted-before",
        laneId: "lane-b",
        checkpointId: defaultedBeforeCheckpointId,
      }),
      event("workflow.node.repair_requested", {
        intentId: "repair-defaulted-before",
        laneId: "lane-b",
        checkpointId: defaultedBeforeCheckpointId,
      }),
    ]);

    expect(projection.checkpoints.find((item) => item.id === defaultedBeforeCheckpointId)).toMatchObject({
      phase: "before",
      authority: {
        phaseExplicit: false,
      },
    });
    expect(projection.checkpointIntents).toEqual([
      expect.objectContaining({
        intentId: "variant-defaulted-before",
        kind: "variant",
        status: "rejected",
        reason: expect.stringMatching(/explicit before checkpoint/i),
      }),
      expect.objectContaining({
        intentId: "fork-defaulted-before",
        kind: "fork",
        status: "rejected",
        reason: expect.stringMatching(/explicit before checkpoint/i),
      }),
      expect.objectContaining({
        intentId: "repair-defaulted-before",
        kind: "repair",
        status: "rejected",
        reason: expect.stringMatching(/after checkpoint/i),
      }),
    ]);
  });

  it("resolves rollback targets from checkpoint laneId when payload only carries the real nodeId", () => {
    const beforeCheckpointId = "checkpoint-before-lane-b-run-1";
    const requested = reduceWorkflowEvents([
      event("workflow.lane.declared", { lane: { ...lane("lane-b", "implementation"), status: "completed" } }),
      event("workflow.lane.declared", { lane: { ...lane("lane-c", "validation"), status: "ready" } }),
      event("workflow.edge.declared", { edge: { id: "edge-b-c", sourceLaneId: "lane-b", targetLaneId: "lane-c" } }),
      event("workflow.node.checkpoint_recorded", {
        checkpoint: checkpoint(beforeCheckpointId, "lane-b", "before", "base-sha", "node-b"),
      }),
      event("workflow.node.rollback_requested", {
        requestId: "rollback-node-b",
        nodeId: "node-b",
        checkpointId: beforeCheckpointId,
        localRollbackSafe: true,
      }),
    ]);
    const applied = reduceWorkflowEvents([
      ...requested.events,
      event("workflow.node.rollback_applied", {
        requestId: "rollback-node-b",
        nodeId: "node-b",
        checkpointId: beforeCheckpointId,
      }),
    ]);

    expect(requested.rollbackIntents).toEqual([
      expect.objectContaining({
        intentId: "rollback-node-b",
        status: "requested",
        laneId: "lane-b",
        nodeId: "node-b",
        eligibility: expect.objectContaining({
          eligible: true,
          targetLaneId: "lane-b",
          targetNodeId: "node-b",
        }),
      }),
    ]);
    expect(applied.rollbackIntents).toEqual([
      expect.objectContaining({
        intentId: "rollback-node-b",
        status: "applied",
        laneId: "lane-b",
        nodeId: "node-b",
      }),
    ]);
    expectLaneRollback(applied, "lane-b", "rolled_back");
    expectLaneRollback(applied, "lane-c", "inactive");
  });

  it("rejects rollback events when payload nodeId mismatches the resolved checkpoint nodeId", () => {
    const beforeCheckpointId = "checkpoint-before-lane-b-run-1";
    const projection = reduceWorkflowEvents([
      event("workflow.lane.declared", { lane: { ...lane("lane-b", "implementation"), status: "completed" } }),
      event("workflow.lane.declared", { lane: { ...lane("lane-c", "validation"), status: "ready" } }),
      event("workflow.edge.declared", { edge: { id: "edge-b-c", sourceLaneId: "lane-b", targetLaneId: "lane-c" } }),
      event("workflow.node.checkpoint_recorded", {
        checkpoint: checkpoint(beforeCheckpointId, "lane-b", "before", "base-sha", "node-b"),
      }),
      event("workflow.node.rollback_requested", {
        requestId: "rollback-request-wrong-node",
        nodeId: "node-c",
        checkpointId: beforeCheckpointId,
        localRollbackSafe: true,
      }),
      event("workflow.node.rollback_applied", {
        requestId: "rollback-applied-wrong-node",
        nodeId: "node-c",
        checkpointId: beforeCheckpointId,
        localRollbackSafe: true,
      }),
    ]);

    expect(projection.rollbackIntents).toEqual([
      expect.objectContaining({
        intentId: "rollback-request-wrong-node",
        status: "rejected",
        laneId: "lane-b",
        nodeId: "node-c",
        checkpointId: beforeCheckpointId,
        reason: expect.stringMatching(/matching checkpoint/i),
      }),
      expect.objectContaining({
        intentId: "rollback-applied-wrong-node",
        status: "rejected",
        laneId: "lane-b",
        nodeId: "node-c",
        checkpointId: beforeCheckpointId,
        reason: expect.stringMatching(/matching checkpoint/i),
      }),
    ]);
    expect(projection.lanes.find((item) => item.id === "lane-b")?.status).toBe("completed");
    expect(projection.lanes.find((item) => item.id === "lane-c")?.status).toBe("ready");
  });

  it("rejects rollback events that provide only nodeId without a checkpoint or laneId", () => {
    const projection = reduceWorkflowEvents([
      event("workflow.lane.declared", { lane: { ...lane("lane-b", "implementation"), status: "completed" } }),
      event("workflow.node.rollback_requested", {
        requestId: "rollback-request-node-only",
        nodeId: "node-b",
        localRollbackSafe: true,
      }),
      event("workflow.node.rollback_applied", {
        requestId: "rollback-applied-node-only",
        nodeId: "node-b",
        localRollbackSafe: true,
      }),
    ]);

    expect(projection.rollbackIntents).toEqual([
      expect.objectContaining({
        intentId: "rollback-request-node-only",
        status: "rejected",
        nodeId: "node-b",
        reason: expect.stringMatching(/laneId or checkpointId/i),
      }),
      expect.objectContaining({
        intentId: "rollback-applied-node-only",
        status: "rejected",
        nodeId: "node-b",
        reason: expect.stringMatching(/laneId or checkpointId/i),
      }),
    ]);
    expect(projection.rollbackIntents[0]).not.toHaveProperty("laneId");
    expect(projection.rollbackIntents[1]).not.toHaveProperty("laneId");
    expect(projection.lanes.find((item) => item.id === "lane-b")?.status).toBe("completed");
  });

  it("requires an explicit before checkpoint for public rollback eligibility calls", () => {
    const beforeCheckpointId = "checkpoint-before-lane-b-run-1";
    const projection = reduceWorkflowEvents([
      event("workflow.lane.declared", { lane: { ...lane("lane-b", "implementation"), status: "completed" } }),
      event("workflow.lane.declared", { lane: { ...lane("lane-c", "validation"), status: "ready" } }),
      event("workflow.edge.declared", { edge: { id: "edge-b-c", sourceLaneId: "lane-b", targetLaneId: "lane-c" } }),
      event("workflow.node.checkpoint_recorded", {
        checkpoint: checkpoint(beforeCheckpointId, "lane-b", "before", "base-sha"),
      }),
    ]);

    expect(evaluateRollbackEligibility(projection, "lane-b")).toMatchObject({
      eligible: false,
      reason: expect.stringMatching(/before checkpoint/i),
      affectedLaneIds: ["lane-b", "lane-c"],
    });
    expect(evaluateRollbackEligibility(projection, "lane-b", { checkpointId: beforeCheckpointId })).toMatchObject({
      eligible: true,
      checkpointId: beforeCheckpointId,
      affectedLaneIds: ["lane-b", "lane-c"],
      blockingRemoteSideEffects: [],
    });

    const requested = reduceWorkflowEvents([
      ...projection.events,
      event("workflow.node.rollback_requested", {
        requestId: "rollback-lane-b",
        laneId: "lane-b",
        checkpointId: beforeCheckpointId,
        localRollbackSafe: true,
      }),
    ]);

    expect(evaluateRollbackEligibility(requested, "lane-b")).toMatchObject({
      eligible: true,
      checkpointId: beforeCheckpointId,
      affectedLaneIds: ["lane-b", "lane-c"],
    });
  });

  it("does not project checkpoint node identity when rollback eligibility target mismatches", () => {
    const otherLaneCheckpointId = "checkpoint-before-lane-a-run-1";
    const projection = reduceWorkflowEvents([
      event("workflow.lane.declared", { lane: { ...lane("lane-a", "implementation"), status: "completed" } }),
      event("workflow.lane.declared", { lane: { ...lane("lane-b", "implementation"), status: "completed" } }),
      event("workflow.node.checkpoint_recorded", {
        checkpoint: checkpoint(otherLaneCheckpointId, "lane-a", "before", "base-sha", "node-a"),
      }),
    ]);

    expect(
      evaluateRollbackEligibility(projection, "lane-b", {
        checkpointId: otherLaneCheckpointId,
        targetNodeId: "node-b",
      }),
    ).toMatchObject({
      eligible: false,
      targetLaneId: "lane-b",
      targetNodeId: "node-b",
      checkpointId: otherLaneCheckpointId,
      reason: expect.stringMatching(/matching checkpoint/i),
    });
    expect(evaluateRollbackEligibility(projection, "lane-b", { checkpointId: otherLaneCheckpointId })).not.toHaveProperty(
      "targetNodeId",
    );
  });

  it("records eligible rollback_requested but only rollback_applied mutates target and downstream lanes", () => {
    const beforeCheckpointId = "checkpoint-before-lane-b-run-1";
    const requested = reduceWorkflowEvents([
      event("workflow.lane.declared", { lane: { ...lane("lane-a", "implementation"), status: "completed", output: ["A output"] } }),
      event("workflow.lane.declared", { lane: { ...lane("lane-b", "implementation"), status: "completed", output: ["B output"] } }),
      event("workflow.lane.declared", { lane: { ...lane("lane-c", "validation"), status: "ready", output: ["C output"] } }),
      event("workflow.lane.declared", { lane: { ...lane("lane-d", "review"), status: "pending", output: ["D output"] } }),
      event("workflow.edge.declared", { edge: { id: "edge-a-b", sourceLaneId: "lane-a", targetLaneId: "lane-b" } }),
      event("workflow.edge.declared", { edge: { id: "edge-b-c", sourceLaneId: "lane-b", targetLaneId: "lane-c" } }),
      event("workflow.edge.declared", { edge: { id: "edge-c-d", sourceLaneId: "lane-c", targetLaneId: "lane-d" } }),
      event("workflow.segment.started", { segment: { id: "segment-b-1", laneId: "lane-b", runId: "run-b-1", status: "running" } }),
      event("workflow.segment.finished", { laneId: "lane-b", segmentId: "segment-b-1", status: "succeeded", exitCode: 0 }),
      event("workflow.evidence.recorded", {
        laneId: "lane-b",
        segmentId: "segment-b-1",
        evidence: { id: "evidence-b", kind: "test", status: "passed", checks: ["unit"], artifacts: ["artifacts/b.log"] },
      }),
      event("workflow.node.checkpoint_recorded", {
        checkpoint: checkpoint(beforeCheckpointId, "lane-b", "before", "base-sha"),
      }),
      event("workflow.node.rollback_requested", {
        requestId: "rollback-lane-b",
        laneId: "lane-b",
        checkpointId: beforeCheckpointId,
        localRollbackSafe: true,
      }),
    ]);
    const applied = reduceWorkflowEvents([
      ...requested.events,
      event("workflow.node.rollback_applied", {
        requestId: "rollback-lane-b",
        laneId: "lane-b",
        checkpointId: beforeCheckpointId,
        evidence: { restoredHeadCommit: "base-sha" },
      }),
    ]);

    expect(requested.rollbackIntents).toEqual([
      expect.objectContaining({
        kind: "rollback",
        status: "requested",
        checkpointId: beforeCheckpointId,
        eligibility: expect.objectContaining({ eligible: true }),
      }),
    ]);
    expect(requested.lanes.find((item) => item.id === "lane-b")?.status).toBe("completed");
    expect(requested.lanes.find((item) => item.id === "lane-c")?.status).toBe("ready");
    expect(requested.lanes.find((item) => item.id === "lane-d")?.status).toBe("pending");
    expect(applied.checkpoints.map((item) => [item.id, item.phase, item.laneId, item.headCommit])).toEqual([
      [beforeCheckpointId, "before", "lane-b", "base-sha"],
    ]);
    expect(applied.lanes.find((item) => item.id === "lane-a")?.status).toBe("completed");
    expectLaneRollback(applied, "lane-b", "rolled_back");
    expectLaneRollback(applied, "lane-c", "inactive");
    expectLaneRollback(applied, "lane-d", "inactive");
    expect(applied.lanes.find((item) => item.id === "lane-b")?.output).toEqual(["B output"]);
    expect(applied.lanes.find((item) => item.id === "lane-c")?.output).toEqual(["C output"]);
    expect(applied.lanes.find((item) => item.id === "lane-d")?.output).toEqual(["D output"]);
    expect(applied.evidence.find((item) => item.id === "evidence-b")).toMatchObject({
      laneId: "lane-b",
      artifacts: ["artifacts/b.log"],
    });
    expect(scheduleReadyLanes(applied, { allowedParallelism: 3 }).map((item) => item.id)).toEqual([]);
  });

  it("applies lifecycle-style rollback_applied by resolving the prior rollback request target", () => {
    const beforeCheckpointId = "checkpoint-before-lane-b-run-1";
    const requested = reduceWorkflowEvents([
      event("workflow.lane.declared", { lane: { ...lane("lane-b", "implementation"), status: "completed" } }),
      event("workflow.lane.declared", { lane: { ...lane("lane-c", "validation"), status: "ready" } }),
      event("workflow.edge.declared", { edge: { id: "edge-b-c", sourceLaneId: "lane-b", targetLaneId: "lane-c" } }),
      event("workflow.node.checkpoint_recorded", {
        checkpoint: checkpoint(beforeCheckpointId, "lane-b", "before", "base-sha"),
      }),
      event("workflow.node.rollback_requested", {
        requestId: "rollback-lane-b",
        laneId: "lane-b",
        checkpointId: beforeCheckpointId,
        localRollbackSafe: true,
      }),
    ]);
    const applied = reduceWorkflowEvents([
      ...requested.events,
      event("workflow.node.rollback_applied", {
        requestId: "rollback-lane-b",
      }),
    ]);

    expect(requested.rollbackIntents).toEqual([
      expect.objectContaining({
        intentId: "rollback-lane-b",
        status: "requested",
        laneId: "lane-b",
        checkpointId: beforeCheckpointId,
      }),
    ]);
    expect(applied.rollbackIntents).toEqual([
      expect.objectContaining({
        intentId: "rollback-lane-b",
        status: "applied",
        laneId: "lane-b",
        checkpointId: beforeCheckpointId,
      }),
    ]);
    expectLaneRollback(applied, "lane-b", "rolled_back");
    expectLaneRollback(applied, "lane-c", "inactive");
  });

  it("applies rollback_applied with nodeId only by merging the prior request target", () => {
    const beforeCheckpointId = "checkpoint-before-lane-b-run-1";
    const requested = reduceWorkflowEvents([
      event("workflow.lane.declared", { lane: { ...lane("lane-b", "implementation"), status: "completed" } }),
      event("workflow.lane.declared", { lane: { ...lane("lane-c", "validation"), status: "ready" } }),
      event("workflow.edge.declared", { edge: { id: "edge-b-c", sourceLaneId: "lane-b", targetLaneId: "lane-c" } }),
      event("workflow.node.checkpoint_recorded", {
        checkpoint: checkpoint(beforeCheckpointId, "lane-b", "before", "base-sha", "node-b"),
      }),
      event("workflow.node.rollback_requested", {
        requestId: "rollback-lane-b",
        laneId: "lane-b",
        checkpointId: beforeCheckpointId,
        localRollbackSafe: true,
      }),
    ]);
    const applied = reduceWorkflowEvents([
      ...requested.events,
      event("workflow.node.rollback_applied", {
        requestId: "rollback-lane-b",
        nodeId: "node-b",
      }),
    ]);

    expect(applied.rollbackIntents).toEqual([
      expect.objectContaining({
        intentId: "rollback-lane-b",
        status: "applied",
        laneId: "lane-b",
        nodeId: "node-b",
        checkpointId: beforeCheckpointId,
      }),
    ]);
    expectLaneRollback(applied, "lane-b", "rolled_back");
    expectLaneRollback(applied, "lane-c", "inactive");
  });

  it("keeps rolled_back and inactive lanes terminal against late segment, evidence, commit, and PR-check events", () => {
    const beforeCheckpointId = "checkpoint-before-lane-b-run-1";
    const checksRecordedKind = "workflow.pull_request.checks_recorded" as FlowEventKind;
    const projection = reduceWorkflowEvents([
      event("workflow.lane.declared", { lane: { ...lane("lane-b", "implementation"), status: "completed" } }),
      event("workflow.lane.declared", { lane: { ...lane("lane-c", "validation"), status: "ready" } }),
      event("workflow.lane.declared", { lane: { ...lane("lane-d", "commit"), status: "running" } }),
      event("workflow.edge.declared", { edge: { id: "edge-b-c", sourceLaneId: "lane-b", targetLaneId: "lane-c" } }),
      event("workflow.edge.declared", { edge: { id: "edge-c-d", sourceLaneId: "lane-c", targetLaneId: "lane-d" } }),
      event("workflow.node.checkpoint_recorded", {
        checkpoint: checkpoint(beforeCheckpointId, "lane-b", "before", "base-sha"),
      }),
      event("workflow.node.rollback_applied", {
        requestId: "rollback-lane-b",
        laneId: "lane-b",
        checkpointId: beforeCheckpointId,
        evidence: { restoredHeadCommit: "base-sha" },
      }),
      event("workflow.segment.started", { segment: { id: "late-segment-b", laneId: "lane-b", runId: "late-run-b", status: "running" } }),
      event("workflow.evidence.recorded", {
        laneId: "lane-b",
        segmentId: "late-segment-b",
        evidence: { id: "late-evidence-b", kind: "test", status: "passed", checks: ["unit"], artifacts: ["artifacts/late-b.log"] },
      }),
      event("workflow.segment.started", { segment: { id: "late-segment-c", laneId: "lane-c", runId: "late-run-c", status: "running" } }),
      event("workflow.evidence.recorded", {
        laneId: "lane-c",
        segmentId: "late-segment-c",
        evidence: { id: "late-evidence-c", kind: "test", status: "passed", checks: ["unit"], artifacts: ["artifacts/late-c.log"] },
      }),
      event("workflow.pull_request.created", {
        laneId: "lane-c",
        prNumber: 24,
        url: "https://example.test/pr/24",
        headSha: "head-after-rollback",
      }),
      event(checksRecordedKind, {
        laneId: "lane-c",
        prNumber: 24,
        url: "https://example.test/pr/24/checks",
        headSha: "head-after-rollback",
        status: "passed",
        checks: [{ name: "Build and test", status: "passed", url: "https://example.test/checks/24" }],
      }),
      event("workflow.commit.created", { laneId: "lane-d", commitSha: "late-commit" }),
    ]);

    expectLaneRollback(projection, "lane-b", "rolled_back");
    expectLaneRollback(projection, "lane-c", "inactive");
    expectLaneRollback(projection, "lane-d", "inactive");
    expect(projection.segments.map((item) => item.id)).toEqual(["late-segment-b", "late-segment-c"]);
    expect(projection.evidence.map((item) => item.id)).toEqual([
      "late-evidence-b",
      "late-evidence-c",
      expect.stringMatching(/^pull-request:/),
      expect.stringMatching(/^pull-request-checks:/),
    ]);
  });

  it("keeps legacy rejected rollbackStatus non-terminal for scheduling, gates, and later status updates", () => {
    const ready = reduceWorkflowEvents([
      event("workflow.lane.declared", { lane: { ...lane("lane-discovery", "discovery"), status: "completed" } }),
      event("workflow.lane.declared", {
        lane: {
          ...lane("lane-implementation", "implementation"),
          status: "pending",
          rollbackStatus: "rejected",
        },
      }),
      event("workflow.edge.declared", {
        edge: { id: "edge-discovery-implementation", sourceLaneId: "lane-discovery", targetLaneId: "lane-implementation" },
      }),
    ]);
    const completed = reduceWorkflowEvents([
      ...ready.events,
      event("workflow.segment.started", {
        segment: {
          id: "segment-implementation-1",
          laneId: "lane-implementation",
          runId: "run-implementation-1",
          status: "running",
        },
      }),
      event("workflow.segment.finished", {
        laneId: "lane-implementation",
        segmentId: "segment-implementation-1",
        status: "succeeded",
        exitCode: 0,
      }),
      event("workflow.evidence.recorded", {
        laneId: "lane-implementation",
        segmentId: "segment-implementation-1",
        evidence: { id: "evidence-implementation", kind: "test", status: "passed", checks: ["unit"], artifacts: [] },
      }),
    ]);

    expect(scheduleReadyLanes(ready, { allowedParallelism: 1 }).map((item) => item.id)).toEqual(["lane-implementation"]);
    expect(completed.lanes.find((item) => item.id === "lane-implementation")).toMatchObject({
      status: "completed",
      rollbackStatus: "rejected",
    });
    expect(evaluateGate(completed, { type: "RequestReview", laneId: "lane-review" })).toMatchObject({
      allowed: true,
    });
    expect(evaluateGate(completed, { type: "JoinLanes", joinLaneId: "lane-join", upstreamLaneIds: ["lane-implementation"] })).toMatchObject({
      allowed: true,
    });
  });

  it("keeps terminal rollback lane output when a late lane declaration has empty output", () => {
    const beforeCheckpointId = "checkpoint-before-lane-b-run-1";
    const projection = reduceWorkflowEvents([
      event("workflow.lane.declared", { lane: { ...lane("lane-b", "implementation"), status: "completed", output: ["B output"] } }),
      event("workflow.node.checkpoint_recorded", {
        checkpoint: checkpoint(beforeCheckpointId, "lane-b", "before", "base-sha"),
      }),
      event("workflow.node.rollback_applied", {
        requestId: "rollback-lane-b",
        laneId: "lane-b",
        checkpointId: beforeCheckpointId,
      }),
      event("workflow.lane.declared", { lane: { ...lane("lane-b", "implementation"), status: "pending", output: [] } }),
    ]);

    expectLaneRollback(projection, "lane-b", "rolled_back");
    expect(projection.lanes.find((item) => item.id === "lane-b")?.output).toEqual(["B output"]);
  });

  it("preserves terminal rollback lane identity and execution metadata across late redeclarations", () => {
    const beforeCheckpointId = "checkpoint-before-lane-b-run-1";
    const projection = reduceWorkflowEvents([
      event("workflow.lane.declared", {
        lane: {
          ...lane("lane-b", "implementation", ["src/original.ts"], ["pkg-original"]),
          semanticKey: "stable:lane-b",
          title: "Original lane",
          agentKind: "codex",
          executable: true,
          requiredEvidence: ["unit"],
          status: "completed",
          output: ["B output"],
        },
      }),
      event("workflow.node.checkpoint_recorded", {
        checkpoint: checkpoint(beforeCheckpointId, "lane-b", "before", "base-sha"),
      }),
      event("workflow.node.rollback_applied", {
        requestId: "rollback-lane-b",
        laneId: "lane-b",
        checkpointId: beforeCheckpointId,
      }),
      event("workflow.lane.declared", {
        lane: {
          ...lane("lane-b-redeclared", "review", ["src/redeclared.ts"], ["pkg-redeclared"]),
          semanticKey: "stable:lane-b",
          title: "Late display title",
          laneKind: "review",
          semanticSubtype: "evidence_review",
          agentKind: "hermes",
          executable: false,
          requiredEvidence: ["review"],
          status: "running",
          output: ["late output"],
        },
      }),
    ]);
    const rolledBack = projection.lanes.find((item) => item.semanticKey === "stable:lane-b");

    expect(projection.lanes.some((item) => item.id === "lane-b-redeclared")).toBe(false);
    expect(rolledBack).toMatchObject({
      id: "lane-b",
      semanticKey: "stable:lane-b",
      kind: "implementation",
      laneKind: "implementation",
      semanticSubtype: "implementation",
      agentKind: "codex",
      nodeKind: "agent_task",
      executable: true,
      status: "blocked",
      rollbackStatus: "rolled_back",
      fileScopes: ["src/original.ts"],
      packageScopes: ["pkg-original"],
      requiredEvidence: ["unit"],
      output: ["B output", "late output"],
      runtimePolicy: expect.objectContaining({
        source: "workflow_projection",
        trusted: true,
        executable: true,
        sandbox: "workspace-write",
      }),
    });
  });

  it("blocks rollback for all remote side-effect event shapes including affectedLaneIds and session-wide events", () => {
    const baseEvents: FlowEvent[] = [
      event("workflow.lane.declared", { lane: { ...lane("lane-b", "implementation"), status: "completed" } }),
      event("workflow.lane.declared", { lane: { ...lane("lane-c", "pull_request"), status: "running" } }),
      event("workflow.edge.declared", { edge: { id: "edge-b-c", sourceLaneId: "lane-b", targetLaneId: "lane-c" } }),
      event("workflow.node.checkpoint_recorded", {
        checkpoint: checkpoint("checkpoint-before-lane-b-run-1", "lane-b", "before", "base-sha"),
      }),
    ];
    const cases: Array<{
      kind: FlowEventKind;
      payload: Record<string, unknown>;
      expectedLaneId?: string;
    }> = [
      {
        kind: "workflow.delivery.pushed",
        payload: { affectedLaneIds: ["lane-b"], url: "https://example.test/compare" },
        expectedLaneId: "lane-b",
      },
      {
        kind: "workflow.pull_request.created",
        payload: {
          laneId: "lane-c",
          commitLaneId: "lane-b",
          evidence: { number: 42, url: "https://example.test/pr/42", head: "feature/node-checkpoint-contracts", commitSha: "remote-sha" },
        },
        expectedLaneId: "lane-c",
      },
      {
        kind: "workflow.pull_request.merged",
        payload: { targetLaneId: "lane-c", mergeCommitSha: "merge-sha" },
        expectedLaneId: "lane-c",
      },
      {
        kind: "workflow.delivery.main_synced",
        payload: { affectedLaneIds: ["lane-c"], headSha: "main-sha" },
        expectedLaneId: "lane-c",
      },
      {
        kind: "workflow.delivery.main_synced",
        payload: { headSha: "main-sha" },
      },
    ];

    for (const item of cases) {
      const projection = reduceWorkflowEvents([
        ...baseEvents,
        event(item.kind, item.payload),
        event("workflow.node.rollback_requested", {
          requestId: `rollback-${item.kind}`,
          laneId: "lane-b",
          checkpointId: "checkpoint-before-lane-b-run-1",
          localRollbackSafe: true,
        }),
      ]);

      expect(evaluateRollbackEligibility(projection, "lane-b", { checkpointId: "checkpoint-before-lane-b-run-1" })).toMatchObject({
        eligible: false,
        targetLaneId: "lane-b",
        affectedLaneIds: ["lane-b", "lane-c"],
        blockingRemoteSideEffects: [
          expect.objectContaining({
            eventKind: item.kind,
            ...(item.expectedLaneId ? { laneId: item.expectedLaneId } : {}),
          }),
        ],
      });
      expect(projection.rollbackIntents).toEqual([
        expect.objectContaining({
          kind: "rollback",
          status: "rejected",
          checkpointId: "checkpoint-before-lane-b-run-1",
        }),
      ]);
      expect(projection.lanes.find((laneItem) => laneItem.id === "lane-b")?.status).toBe("completed");
      expect(projection.lanes.find((laneItem) => laneItem.id === "lane-c")?.status).toBe("running");
    }
  });

  it("keeps ambiguous failed durable remote side-effect requests as rollback blockers", () => {
    const beforeCheckpointId = "checkpoint-before-lane-b-run-1";
    const baseEvents: FlowEvent[] = [
      event("workflow.lane.declared", { lane: { ...lane("lane-b", "implementation"), status: "completed" } }),
      event("workflow.lane.declared", { lane: { ...lane("lane-c", "pull_request"), status: "running" } }),
      event("workflow.edge.declared", { edge: { id: "edge-b-c", sourceLaneId: "lane-b", targetLaneId: "lane-c" } }),
      event("workflow.node.checkpoint_recorded", {
        checkpoint: checkpoint(beforeCheckpointId, "lane-b", "before", "base-sha"),
      }),
      event("workflow.remote_side_effect.requested", {
        operationId: "remote-push-1",
        eventKind: "workflow.delivery.pushed",
        laneId: "lane-b",
        affectedLaneIds: ["lane-b"],
      }),
    ];
    const requested = reduceWorkflowEvents(baseEvents);
    const completedFailure = reduceWorkflowEvents([
      ...baseEvents,
      event("workflow.remote_side_effect.completed", {
        operationId: "remote-push-1",
        eventKind: "workflow.delivery.pushed",
        status: "failed",
        error: { message: "remote rejected" },
      }),
    ]);
    const completedKnownPreMutationFailure = reduceWorkflowEvents([
      ...baseEvents,
      event("workflow.remote_side_effect.completed", {
        operationId: "remote-push-1",
        eventKind: "workflow.delivery.pushed",
        status: "failed",
        remoteMutationAttempted: false,
        error: { message: "remote rejected before mutation" },
      }),
    ]);

    expect(evaluateRollbackEligibility(requested, "lane-b", { checkpointId: beforeCheckpointId })).toMatchObject({
      eligible: false,
      blockingRemoteSideEffects: [
        expect.objectContaining({
          eventKind: "workflow.delivery.pushed",
          laneId: "lane-b",
          affectedLaneIds: ["lane-b"],
        }),
      ],
    });
    expect(evaluateRollbackEligibility(completedFailure, "lane-b", { checkpointId: beforeCheckpointId })).toMatchObject({
      eligible: false,
      blockingRemoteSideEffects: [
        expect.objectContaining({
          eventKind: "workflow.delivery.pushed",
          laneId: "lane-b",
          affectedLaneIds: ["lane-b"],
        }),
      ],
    });
    expect(evaluateRollbackEligibility(completedKnownPreMutationFailure, "lane-b", { checkpointId: beforeCheckpointId })).toMatchObject({
      eligible: true,
      blockingRemoteSideEffects: [],
    });
  });

  it("treats explicit sessionWide remote side-effect payloads as session-wide", () => {
    const beforeCheckpointId = "checkpoint-before-lane-b-run-1";
    const projection = reduceWorkflowEvents([
      event("workflow.lane.declared", { lane: { ...lane("lane-b", "implementation"), status: "completed" } }),
      event("workflow.lane.declared", { lane: { ...lane("lane-c", "validation"), status: "ready" } }),
      event("workflow.edge.declared", { edge: { id: "edge-b-c", sourceLaneId: "lane-b", targetLaneId: "lane-c" } }),
      event("workflow.node.checkpoint_recorded", {
        checkpoint: checkpoint(beforeCheckpointId, "lane-b", "before", "base-sha"),
      }),
      event("workflow.delivery.main_synced", {
        sessionWide: true,
        laneId: "lane-unrelated-pr",
        prNumber: 42,
        headSha: "main-sha",
        evidence: { status: "synced", mainBranch: "main", remote: "origin" },
      }),
    ]);

    expect(evaluateRollbackEligibility(projection, "lane-b", { checkpointId: beforeCheckpointId }).blockingRemoteSideEffects).toEqual([
      expect.objectContaining({
        eventKind: "workflow.delivery.main_synced",
        sessionWide: true,
      }),
    ]);
  });

  it("ignores explicit remote side-effect lane IDs outside the rollback affected set", () => {
    const beforeCheckpointId = "checkpoint-before-lane-b-run-1";
    const projection = reduceWorkflowEvents([
      event("workflow.lane.declared", { lane: { ...lane("lane-b", "implementation"), status: "completed" } }),
      event("workflow.lane.declared", { lane: { ...lane("lane-c", "validation"), status: "ready" } }),
      event("workflow.edge.declared", { edge: { id: "edge-b-c", sourceLaneId: "lane-b", targetLaneId: "lane-c" } }),
      event("workflow.node.checkpoint_recorded", {
        checkpoint: checkpoint(beforeCheckpointId, "lane-b", "before", "base-sha"),
      }),
      event("workflow.pull_request.created", {
        laneId: "lane-unrelated",
        affectedLaneIds: ["lane-other", "lane-unrelated"],
        evidence: {
          number: 42,
          url: "https://example.test/pr/42",
          affectedLaneIds: ["lane-external"],
        },
      }),
      event("workflow.node.rollback_applied", {
        requestId: "rollback-lane-b",
        laneId: "lane-b",
        checkpointId: beforeCheckpointId,
        localRollbackSafe: true,
      }),
    ]);

    expect(evaluateRollbackEligibility(projection, "lane-b", { checkpointId: beforeCheckpointId })).toMatchObject({
      eligible: true,
      affectedLaneIds: ["lane-b", "lane-c"],
      blockingRemoteSideEffects: [],
    });
    expect(projection.rollbackIntents).toEqual([
      expect.objectContaining({
        intentId: "rollback-lane-b",
        status: "applied",
        eligibility: expect.objectContaining({
          eligible: true,
          blockingRemoteSideEffects: [],
        }),
      }),
    ]);
    expectLaneRollback(projection, "lane-b", "rolled_back");
    expectLaneRollback(projection, "lane-c", "inactive");
  });

  it("blocks rollback events when remote side-effect lane IDs only appear in nested evidence", () => {
    const beforeCheckpointId = "checkpoint-before-lane-b-run-1";
    const baseEvents: FlowEvent[] = [
      event("workflow.lane.declared", { lane: { ...lane("lane-b", "implementation"), status: "completed" } }),
      event("workflow.lane.declared", { lane: { ...lane("lane-c", "pull_request"), status: "ready" } }),
      event("workflow.edge.declared", { edge: { id: "edge-b-c", sourceLaneId: "lane-b", targetLaneId: "lane-c" } }),
      event("workflow.node.checkpoint_recorded", {
        checkpoint: checkpoint(beforeCheckpointId, "lane-b", "before", "base-sha"),
      }),
      event("workflow.pull_request.created", {
        laneId: "lane-unrelated",
        evidence: {
          number: 42,
          url: "https://example.test/pr/42",
          affectedLaneIds: ["lane-b"],
        },
      }),
    ];
    const cases: Array<{ kind: FlowEventKind; requestId: string }> = [
      { kind: "workflow.node.rollback_requested", requestId: "rollback-request-nested-side-effect" },
      { kind: "workflow.node.rollback_applied", requestId: "rollback-applied-nested-side-effect" },
    ];

    for (const item of cases) {
      const projection = reduceWorkflowEvents([
        ...baseEvents,
        event(item.kind, {
          requestId: item.requestId,
          laneId: "lane-b",
          checkpointId: beforeCheckpointId,
          localRollbackSafe: true,
        }),
      ]);

      expect(projection.rollbackIntents).toEqual([
        expect.objectContaining({
          intentId: item.requestId,
          status: "rejected",
          eligibility: expect.objectContaining({
            eligible: false,
            reason: expect.stringMatching(/remote side effects/i),
            blockingRemoteSideEffects: [
              expect.objectContaining({
                eventKind: "workflow.pull_request.created",
                laneId: "lane-b",
                affectedLaneIds: ["lane-b"],
              }),
            ],
          }),
        }),
      ]);
      expect(projection.lanes.find((laneItem) => laneItem.id === "lane-b")?.status).toBe("completed");
      expect(projection.lanes.find((laneItem) => laneItem.id === "lane-c")?.status).toBe("ready");
    }
  });

  it("records session-wide and multi-lane remote side-effect refs directly in rollback eligibility", () => {
    const beforeCheckpointId = "checkpoint-before-lane-b-run-1";
    const projection = reduceWorkflowEvents([
      event("workflow.lane.declared", { lane: { ...lane("lane-b", "implementation"), status: "completed" } }),
      event("workflow.lane.declared", { lane: { ...lane("lane-c", "pull_request"), status: "running" } }),
      event("workflow.lane.declared", { lane: { ...lane("lane-d", "commit"), status: "running" } }),
      event("workflow.edge.declared", { edge: { id: "edge-b-c", sourceLaneId: "lane-b", targetLaneId: "lane-c" } }),
      event("workflow.edge.declared", { edge: { id: "edge-c-d", sourceLaneId: "lane-c", targetLaneId: "lane-d" } }),
      event("workflow.node.checkpoint_recorded", {
        checkpoint: checkpoint(beforeCheckpointId, "lane-b", "before", "base-sha"),
      }),
      event("workflow.pull_request.created", {
        laneId: "lane-c",
        commitLaneId: "lane-b",
        evidence: { number: 42, url: "https://example.test/pr/42", commitSha: "remote-sha" },
      }),
      event("workflow.delivery.main_synced", { headSha: "main-sha" }),
    ]);

    expect(evaluateRollbackEligibility(projection, "lane-b", { checkpointId: beforeCheckpointId }).blockingRemoteSideEffects).toEqual([
      expect.objectContaining({
        eventKind: "workflow.pull_request.created",
        laneId: "lane-c",
        affectedLaneIds: ["lane-c", "lane-b"],
      }),
      expect.objectContaining({
        eventKind: "workflow.delivery.main_synced",
        sessionWide: true,
      }),
    ]);
  });

  it("rejects rollback_applied when remote side effects already exist without mutating lane statuses", () => {
    const beforeCheckpointId = "checkpoint-before-lane-b-run-1";
    const cases: Array<{
      kind: FlowEventKind;
      payload: Record<string, unknown>;
      expectedLaneId: string;
    }> = [
      {
        kind: "workflow.delivery.pushed",
        payload: { affectedLaneIds: ["lane-b"], url: "https://example.test/compare" },
        expectedLaneId: "lane-b",
      },
      {
        kind: "workflow.pull_request.created",
        payload: {
          laneId: "lane-c",
          commitLaneId: "lane-b",
          evidence: { number: 42, url: "https://example.test/pr/42", commitSha: "remote-sha" },
        },
        expectedLaneId: "lane-c",
      },
      {
        kind: "workflow.pull_request.merged",
        payload: { targetLaneId: "lane-c", mergeCommitSha: "merge-sha" },
        expectedLaneId: "lane-c",
      },
      {
        kind: "workflow.delivery.main_synced",
        payload: { affectedLaneIds: ["lane-c"], headSha: "main-sha" },
        expectedLaneId: "lane-c",
      },
    ];

    for (const item of cases) {
      const projection = reduceWorkflowEvents([
        event("workflow.lane.declared", { lane: { ...lane("lane-b", "implementation"), status: "completed" } }),
        event("workflow.lane.declared", { lane: { ...lane("lane-c", "pull_request"), status: "running" } }),
        event("workflow.edge.declared", { edge: { id: "edge-b-c", sourceLaneId: "lane-b", targetLaneId: "lane-c" } }),
        event("workflow.node.checkpoint_recorded", {
          checkpoint: checkpoint(beforeCheckpointId, "lane-b", "before", "base-sha"),
        }),
        event(item.kind, item.payload),
        event("workflow.node.rollback_applied", {
          requestId: `rollback-applied-${item.kind}`,
          laneId: "lane-b",
          checkpointId: beforeCheckpointId,
        }),
      ]);

      expect(projection.rollbackIntents).toEqual([
        expect.objectContaining({
          intentId: `rollback-applied-${item.kind}`,
          status: "rejected",
          eligibility: expect.objectContaining({
            eligible: false,
            reason: expect.stringMatching(/remote side effects/i),
            blockingRemoteSideEffects: [
              expect.objectContaining({
                eventKind: item.kind,
                laneId: item.expectedLaneId,
              }),
            ],
          }),
        }),
      ]);
      expect(projection.lanes.find((laneItem) => laneItem.id === "lane-b")?.status).toBe("completed");
      expect(projection.lanes.find((laneItem) => laneItem.id === "lane-c")?.status).toBe("running");
    }
  });

  it("rejects rollback_applied after a session-wide remote side effect without mutating lane statuses", () => {
    const beforeCheckpointId = "checkpoint-before-lane-b-run-1";
    const projection = reduceWorkflowEvents([
      event("workflow.lane.declared", { lane: { ...lane("lane-b", "implementation"), status: "completed" } }),
      event("workflow.lane.declared", { lane: { ...lane("lane-c", "pull_request"), status: "running" } }),
      event("workflow.edge.declared", { edge: { id: "edge-b-c", sourceLaneId: "lane-b", targetLaneId: "lane-c" } }),
      event("workflow.node.checkpoint_recorded", {
        checkpoint: checkpoint(beforeCheckpointId, "lane-b", "before", "base-sha"),
      }),
      event("workflow.delivery.main_synced", { headSha: "main-sha" }),
      event("workflow.node.rollback_applied", {
        requestId: "rollback-applied-session-wide-side-effect",
        laneId: "lane-b",
        checkpointId: beforeCheckpointId,
      }),
    ]);

    expect(projection.rollbackIntents).toEqual([
      expect.objectContaining({
        intentId: "rollback-applied-session-wide-side-effect",
        status: "rejected",
        eligibility: expect.objectContaining({
          eligible: false,
          reason: expect.stringMatching(/remote side effects/i),
          blockingRemoteSideEffects: [
            expect.objectContaining({
              eventKind: "workflow.delivery.main_synced",
              sessionWide: true,
            }),
          ],
        }),
      }),
    ]);
    expect(projection.lanes.find((laneItem) => laneItem.id === "lane-b")?.status).toBe("completed");
    expect(projection.lanes.find((laneItem) => laneItem.id === "lane-c")?.status).toBe("running");
  });

  it("blocks rollback_applied when a remote side effect arrives after an eligible request", () => {
    const beforeCheckpointId = "checkpoint-before-lane-b-run-1";
    const requested = reduceWorkflowEvents([
      event("workflow.lane.declared", { lane: { ...lane("lane-b", "implementation"), status: "completed" } }),
      event("workflow.lane.declared", { lane: { ...lane("lane-c", "pull_request"), status: "running" } }),
      event("workflow.edge.declared", { edge: { id: "edge-b-c", sourceLaneId: "lane-b", targetLaneId: "lane-c" } }),
      event("workflow.node.checkpoint_recorded", {
        checkpoint: checkpoint(beforeCheckpointId, "lane-b", "before", "base-sha"),
      }),
      event("workflow.node.rollback_requested", {
        requestId: "rollback-lane-b",
        laneId: "lane-b",
        checkpointId: beforeCheckpointId,
        localRollbackSafe: true,
      }),
    ]);
    const applied = reduceWorkflowEvents([
      ...requested.events,
      event("workflow.pull_request.created", {
        laneId: "lane-c",
        commitLaneId: "lane-b",
        evidence: { number: 42, url: "https://example.test/pr/42", commitSha: "remote-sha" },
      }),
      event("workflow.node.rollback_applied", {
        requestId: "rollback-lane-b",
        laneId: "lane-b",
        checkpointId: beforeCheckpointId,
      }),
    ]);

    expect(requested.rollbackIntents).toEqual([
      expect.objectContaining({
        status: "requested",
        eligibility: expect.objectContaining({ eligible: true }),
      }),
    ]);
    expect(applied.rollbackIntents).toEqual([
      expect.objectContaining({
        intentId: "rollback-lane-b",
        status: "rejected",
        eligibility: expect.objectContaining({
          eligible: false,
          reason: expect.stringMatching(/remote side effects/i),
        }),
      }),
    ]);
    expect(applied.lanes.find((item) => item.id === "lane-b")?.status).toBe("completed");
    expect(applied.lanes.find((item) => item.id === "lane-c")?.status).toBe("running");
  });

  it("rejects repair, variant, and fork intents without explicit successor identity", () => {
    const beforeCheckpointId = "checkpoint-before-lane-b-run-1";
    const afterCheckpointId = "checkpoint-after-lane-b-run-1";
    const projection = reduceWorkflowEvents([
      event("workflow.lane.declared", { lane: { ...lane("lane-b", "implementation"), status: "completed" } }),
      event("workflow.node.checkpoint_recorded", {
        checkpoint: checkpoint(beforeCheckpointId, "lane-b", "before", "base-sha"),
      }),
      event("workflow.node.checkpoint_recorded", {
        checkpoint: checkpoint(afterCheckpointId, "lane-b", "after", "head-sha"),
      }),
      event("workflow.node.variant_requested", {
        intentId: "variant-from-before",
        laneId: "lane-b",
        checkpointId: beforeCheckpointId,
      }),
      event("workflow.node.fork_requested", {
        intentId: "fork-from-before",
        laneId: "lane-b",
        checkpointId: beforeCheckpointId,
      }),
      event("workflow.node.repair_requested", {
        intentId: "repair-from-after",
        laneId: "lane-b",
        checkpointId: afterCheckpointId,
      }),
    ]);

    expect(projection.checkpointIntents).toEqual([
      expect.objectContaining({
        kind: "variant",
        status: "rejected",
        checkpointId: beforeCheckpointId,
        reason: expect.stringMatching(/successor identity/i),
      }),
      expect.objectContaining({
        kind: "fork",
        status: "rejected",
        checkpointId: beforeCheckpointId,
        reason: expect.stringMatching(/successor identity/i),
      }),
      expect.objectContaining({
        kind: "repair",
        status: "rejected",
        checkpointId: afterCheckpointId,
        reason: expect.stringMatching(/successor identity/i),
      }),
    ]);
  });

  it("rejects checkpoint intents when payload lane or node ownership disagrees with the checkpoint", () => {
    const beforeCheckpointId = "checkpoint-before-lane-b-run-1";
    const afterCheckpointId = "checkpoint-after-lane-b-run-1";
    const projection = reduceWorkflowEvents([
      event("workflow.lane.declared", { lane: { ...lane("lane-b", "implementation"), status: "completed" } }),
      event("workflow.lane.declared", { lane: { ...lane("lane-c", "implementation"), status: "completed" } }),
      event("workflow.node.checkpoint_recorded", {
        checkpoint: checkpoint(beforeCheckpointId, "lane-b", "before", "base-sha"),
      }),
      event("workflow.node.checkpoint_recorded", {
        checkpoint: checkpoint(afterCheckpointId, "lane-b", "after", "head-sha"),
      }),
      event("workflow.node.variant_requested", {
        intentId: "variant-wrong-lane",
        laneId: "lane-c",
        checkpointId: beforeCheckpointId,
      }),
      event("workflow.node.fork_requested", {
        intentId: "fork-wrong-lane",
        laneId: "lane-c",
        checkpointId: beforeCheckpointId,
      }),
      event("workflow.node.repair_requested", {
        intentId: "repair-wrong-node",
        nodeId: "lane-c",
        checkpointId: afterCheckpointId,
      }),
    ]);

    expect(projection.checkpointIntents).toEqual([
      expect.objectContaining({
        intentId: "variant-wrong-lane",
        kind: "variant",
        status: "rejected",
        laneId: "lane-b",
        nodeId: "lane-b",
        reason: expect.stringMatching(/matching checkpoint/i),
      }),
      expect.objectContaining({
        intentId: "fork-wrong-lane",
        kind: "fork",
        status: "rejected",
        laneId: "lane-b",
        nodeId: "lane-b",
        reason: expect.stringMatching(/matching checkpoint/i),
      }),
      expect.objectContaining({
        intentId: "repair-wrong-node",
        kind: "repair",
        status: "rejected",
        laneId: "lane-b",
        nodeId: "lane-b",
        reason: expect.stringMatching(/matching checkpoint/i),
      }),
    ]);
  });

  it("preserves checkpoint identity and commit boundaries across duplicate partial upserts", () => {
    const afterCheckpointId = "checkpoint-after-lane-b-run-1";
    const projection = reduceWorkflowEvents([
      event("workflow.node.checkpoint_recorded", {
        checkpoint: {
          ...checkpoint(afterCheckpointId, "lane-b", "after", "head-sha"),
          source: "agent_bridge",
          evidenceRefs: [
            { kind: "run", id: "run-b-1" },
            { kind: "changeset", id: "changeset-b-1", uri: "diff://changeset-b-1" },
          ],
        },
      }),
      event("workflow.node.checkpoint_recorded", {
        checkpoint: {
          id: afterCheckpointId,
          nodeId: "node-c",
          laneId: "lane-c",
          phase: "before",
          source: "user",
          baseCommit: "base-sha-2",
          headCommit: "head-sha-2",
          executionTarget: "current_branch",
          worktreeId: "worktree-c",
          worktreePath: "/repo.worktrees/session-1-c",
          runId: "run-c-1",
          segmentId: "segment-c-1",
          createdAt: "2026-06-23T00:00:01.000Z",
          evidenceRefs: [],
        },
      }),
      event("workflow.node.checkpoint_recorded", {
        checkpoint: {
          id: afterCheckpointId,
          evidenceRefs: [
            { kind: "changeset", id: "changeset-b-1", uri: "diff://changeset-b-1" },
            { kind: "artifact", id: "artifact-b-1" },
          ],
        },
      }),
    ]);

    expect(projection.checkpoints).toEqual([
      expect.objectContaining({
        id: afterCheckpointId,
        nodeId: "lane-b",
        laneId: "lane-b",
        phase: "after",
        source: "agent_bridge",
        baseCommit: "base-sha",
        headCommit: "head-sha",
        executionTarget: "new_worktree",
        worktreeId: "worktree-b",
        worktreePath: "/repo.worktrees/session-1-lane-b",
        runId: "run-b-1",
        segmentId: "segment-b-1",
        createdAt: now,
        evidenceRefs: [
          { kind: "run", id: "run-b-1" },
          { kind: "changeset", id: "changeset-b-1", uri: "diff://changeset-b-1" },
          { kind: "artifact", id: "artifact-b-1" },
        ],
      }),
    ]);
  });

  it("fills defaulted checkpoint authority fields from later explicit duplicates only once", () => {
    const beforeCheckpointId = "checkpoint-before-lane-b-run-1";
    const projection = reduceWorkflowEvents([
      event("workflow.node.checkpoint_recorded", {
        checkpoint: {
          id: beforeCheckpointId,
          laneId: "lane-b",
        },
      }),
      event("workflow.node.checkpoint_recorded", {
        checkpoint: {
          id: beforeCheckpointId,
          nodeId: "node-b",
          laneId: "lane-b",
          phase: "after",
          executionTarget: "new_worktree",
          baseCommit: "base-sha",
          headCommit: "head-sha",
          worktreeId: "worktree-b",
          worktreePath: "/repo.worktrees/session-1-lane-b",
          runId: "run-b-1",
          segmentId: "segment-b-1",
          evidenceRefs: [{ kind: "run", id: "run-b-1" }],
        },
      }),
      event("workflow.node.checkpoint_recorded", {
        checkpoint: {
          id: beforeCheckpointId,
          nodeId: "node-conflict",
          laneId: "lane-conflict",
          phase: "before",
          executionTarget: "current_branch",
          baseCommit: "base-conflict",
          headCommit: "head-conflict",
          worktreeId: "worktree-conflict",
          worktreePath: "/repo.worktrees/session-1-conflict",
          runId: "run-conflict",
          segmentId: "segment-conflict",
          evidenceRefs: [{ kind: "artifact", id: "artifact-b-1" }],
        },
      }),
    ]);

    expect(projection.checkpoints).toEqual([
      expect.objectContaining({
        id: beforeCheckpointId,
        nodeId: "node-b",
        laneId: "lane-b",
        phase: "after",
        executionTarget: "new_worktree",
        baseCommit: "base-sha",
        headCommit: "head-sha",
        worktreeId: "worktree-b",
        worktreePath: "/repo.worktrees/session-1-lane-b",
        runId: "run-b-1",
        segmentId: "segment-b-1",
        evidenceRefs: [
          { kind: "run", id: "run-b-1" },
          { kind: "artifact", id: "artifact-b-1" },
        ],
      }),
    ]);
  });

  it("exposes checkpoint field authority and flips explicit flags from later duplicates", () => {
    const beforeCheckpointId = "checkpoint-before-lane-b-run-1";
    const defaulted = reduceWorkflowEvents([
      event("workflow.lane.declared", { lane: { ...lane("lane-b", "implementation"), status: "completed" } }),
      event("workflow.node.checkpoint_recorded", {
        checkpoint: {
          id: beforeCheckpointId,
          laneId: "lane-b",
        },
      }),
    ]);
    const explicit = reduceWorkflowEvents([
      ...defaulted.events,
      event("workflow.node.checkpoint_recorded", {
        checkpoint: {
          id: beforeCheckpointId,
          nodeId: "node-b",
          laneId: "lane-b",
          phase: "before",
          executionTarget: "new_worktree",
          baseCommit: "base-sha",
          headCommit: "head-sha",
        },
      }),
    ]);

    expect(defaulted.checkpoints[0]).toMatchObject({
      phase: "before",
      executionTarget: "current_branch",
      authority: {
        laneIdExplicit: true,
        nodeIdExplicit: false,
        phaseExplicit: false,
        executionTargetExplicit: false,
      },
    });
    expect(explicit.checkpoints[0]).toMatchObject({
      nodeId: "node-b",
      phase: "before",
      executionTarget: "new_worktree",
      authority: {
        laneIdExplicit: true,
        nodeIdExplicit: true,
        phaseExplicit: true,
        executionTargetExplicit: true,
      },
    });
    expect(evaluateRollbackEligibility(explicit, "lane-b", { checkpointId: beforeCheckpointId })).toMatchObject({
      eligible: true,
    });
  });

  it("fills missing checkpoint fields from later duplicates without overwriting existing refs", () => {
    const beforeCheckpointId = "checkpoint-before-lane-b-run-1";
    const projection = reduceWorkflowEvents([
      event("workflow.node.checkpoint_recorded", {
        checkpoint: {
          id: beforeCheckpointId,
          sessionId: "session-1",
          nodeId: "lane-b",
          laneId: "lane-b",
          phase: "before",
          executionTarget: "new_worktree",
          baseCommit: "base-sha",
          createdAt: now,
          source: "agent_bridge",
          evidenceRefs: [{ kind: "commit", id: "base-sha" }],
        },
      }),
      event("workflow.node.checkpoint_recorded", {
        checkpoint: {
          id: beforeCheckpointId,
          runId: "run-b-1",
          segmentId: "segment-b-1",
          worktreeId: "worktree-b",
          worktreePath: "/repo.worktrees/session-1-lane-b",
          headCommit: "head-sha",
          evidenceRefs: [{ kind: "run", id: "run-b-1" }],
        },
      }),
      event("workflow.node.checkpoint_recorded", {
        checkpoint: {
          id: beforeCheckpointId,
          runId: "run-b-conflict",
          segmentId: "segment-b-conflict",
          worktreeId: "worktree-b-conflict",
          worktreePath: "/repo.worktrees/session-1-conflict",
          baseCommit: "base-sha-conflict",
          headCommit: "head-sha-conflict",
          evidenceRefs: [{ kind: "artifact", id: "artifact-b-1" }],
        },
      }),
    ]);

    expect(projection.checkpoints).toEqual([
      expect.objectContaining({
        id: beforeCheckpointId,
        nodeId: "lane-b",
        laneId: "lane-b",
        phase: "before",
        executionTarget: "new_worktree",
        baseCommit: "base-sha",
        headCommit: "head-sha",
        runId: "run-b-1",
        segmentId: "segment-b-1",
        worktreeId: "worktree-b",
        worktreePath: "/repo.worktrees/session-1-lane-b",
        evidenceRefs: [
          { kind: "commit", id: "base-sha" },
          { kind: "run", id: "run-b-1" },
          { kind: "artifact", id: "artifact-b-1" },
        ],
      }),
    ]);
  });

  it("keeps predeclared rollback-derived successors active during cascade and schedules them by explicit identity", () => {
    const beforeCheckpointId = "checkpoint-before-lane-b-run-1";
    const afterCheckpointId = "checkpoint-after-lane-b-run-1";
    const projection = reduceWorkflowEvents([
      event("workflow.lane.declared", { lane: { ...lane("lane-b", "implementation"), status: "completed" } }),
      event("workflow.lane.declared", {
        lane: {
          ...lane("lane-repair-b", "fix"),
          semanticKey: "successor:repair-lane-b",
        },
      }),
      event("workflow.lane.declared", {
        lane: {
          ...lane("lane-regression-b", "regression_check"),
          semanticKey: "regression:repair-lane-b",
        },
      }),
      event("workflow.lane.declared", {
        lane: {
          ...lane("lane-unrelated-b", "implementation"),
          semanticKey: "dynamic:unrelated-b",
        },
      }),
      event("workflow.edge.declared", { edge: { id: "edge-b-repair", sourceLaneId: "lane-b", targetLaneId: "lane-repair-b" } }),
      event("workflow.edge.declared", { edge: { id: "edge-repair-regression", sourceLaneId: "lane-repair-b", targetLaneId: "lane-regression-b" } }),
      event("workflow.edge.declared", { edge: { id: "edge-b-unrelated", sourceLaneId: "lane-b", targetLaneId: "lane-unrelated-b" } }),
      event("workflow.node.checkpoint_recorded", {
        checkpoint: checkpoint(beforeCheckpointId, "lane-b", "before", "base-sha"),
      }),
      event("workflow.node.checkpoint_recorded", {
        checkpoint: checkpoint(afterCheckpointId, "lane-b", "after", "head-sha"),
      }),
      event("workflow.node.repair_requested", {
        intentId: "repair-lane-b-after",
        laneId: "lane-b",
        checkpointId: afterCheckpointId,
        successorLaneId: "lane-repair-b",
        successorSemanticKey: "successor:repair-lane-b",
      }),
      event("workflow.node.rollback_applied", {
        requestId: "rollback-lane-b",
        laneId: "lane-b",
        checkpointId: beforeCheckpointId,
      }),
    ]);
    const repaired = reduceWorkflowEvents([
      ...projection.events,
      event("workflow.segment.started", {
        segment: { id: "segment-repair-b-1", laneId: "lane-repair-b", runId: "run-repair-b-1", status: "running" },
      }),
      event("workflow.segment.finished", {
        laneId: "lane-repair-b",
        segmentId: "segment-repair-b-1",
        status: "succeeded",
        exitCode: 0,
      }),
      event("workflow.evidence.recorded", {
        laneId: "lane-repair-b",
        segmentId: "segment-repair-b-1",
        evidence: { id: "evidence-repair-b", kind: "test", status: "passed", checks: ["unit"], artifacts: [] },
      }),
    ]);

    expect(projection.checkpointIntents).toEqual([
      expect.objectContaining({
        intentId: "repair-lane-b-after",
        successorLaneId: "lane-repair-b",
        successorSemanticKey: "successor:repair-lane-b",
      }),
    ]);
    expectLaneRollback(projection, "lane-b", "rolled_back");
    expect(projection.lanes.find((item) => item.id === "lane-repair-b")?.status).toBe("pending");
    expect(projection.lanes.find((item) => item.id === "lane-regression-b")?.status).toBe("pending");
    expectLaneRollback(projection, "lane-unrelated-b", "inactive");
    expect(scheduleReadyLanes(projection, { allowedParallelism: 3 }).map((item) => item.id)).toEqual(["lane-repair-b"]);
    expect(repaired.lanes.find((item) => item.id === "lane-repair-b")?.status).toBe("completed");
    expect(repaired.lanes.find((item) => item.id === "lane-regression-b")?.status).toBe("pending");
    expect(scheduleReadyLanes(repaired, { allowedParallelism: 3 }).map((item) => item.id)).toEqual(["lane-regression-b"]);
  });

  it("retains repair and variant instructions in checkpoint intents", () => {
    const beforeCheckpointId = "checkpoint-before-lane-b-run-1";
    const afterCheckpointId = "checkpoint-after-lane-b-run-1";
    const projection = reduceWorkflowEvents([
      event("workflow.lane.declared", { lane: { ...lane("lane-b", "implementation"), status: "completed" } }),
      event("workflow.node.checkpoint_recorded", {
        checkpoint: checkpoint(beforeCheckpointId, "lane-b", "before", "base-sha"),
      }),
      event("workflow.node.checkpoint_recorded", {
        checkpoint: checkpoint(afterCheckpointId, "lane-b", "after", "head-sha"),
      }),
      event("workflow.node.repair_requested", {
        intentId: "repair-lane-b-after",
        laneId: "lane-b",
        checkpointId: afterCheckpointId,
        successorLaneId: "lane-repair-b",
        successorSemanticKey: "successor:repair-lane-b",
        instruction: "Fix the selected node result.",
      }),
      event("workflow.node.variant_requested", {
        intentId: "variant-lane-b-before",
        laneId: "lane-b",
        checkpointId: beforeCheckpointId,
        successorLaneId: "lane-variant-b",
        successorSemanticKey: "successor:variant-lane-b",
        instruction: "Try a different implementation.",
      }),
    ]);

    expect(projection.checkpointIntents).toEqual([
      expect.objectContaining({
        intentId: "repair-lane-b-after",
        kind: "repair",
        instruction: "Fix the selected node result.",
      }),
      expect.objectContaining({
        intentId: "variant-lane-b-before",
        kind: "variant",
        instruction: "Try a different implementation.",
      }),
    ]);
  });

  it("schedules checkpoint repair successors from failed source evidence without rolling back the original lane", () => {
    const afterCheckpointId = "checkpoint-after-lane-b-run-1";
    const projection = reduceWorkflowEvents([
      event("workflow.lane.declared", { lane: lane("lane-b", "implementation") }),
      event("workflow.lane.declared", {
        lane: {
          ...lane("lane-repair-b", "fix"),
          semanticKey: "manual:repair-lane-b",
        },
      }),
      event("workflow.edge.declared", { edge: { id: "edge-b-repair", sourceLaneId: "lane-b", targetLaneId: "lane-repair-b" } }),
      event("workflow.node.checkpoint_recorded", {
        checkpoint: checkpoint(afterCheckpointId, "lane-b", "after", "head-sha"),
      }),
      event("workflow.segment.started", {
        segment: { id: "segment-b-1", laneId: "lane-b", runId: "run-b-1", status: "running" },
      }),
      event("workflow.segment.finished", {
        laneId: "lane-b",
        segmentId: "segment-b-1",
        status: "failed",
        exitCode: 1,
      }),
      event("workflow.evidence.recorded", {
        laneId: "lane-b",
        segmentId: "segment-b-1",
        evidence: { id: "evidence-b-failed", kind: "run-exit", status: "failed", checks: ["run-exit:failed"], artifacts: [] },
      }),
      event("workflow.node.repair_requested", {
        intentId: "repair-lane-b-after",
        laneId: "lane-b",
        checkpointId: afterCheckpointId,
        successorLaneId: "lane-repair-b",
        successorSemanticKey: "manual:repair-lane-b",
        sourceEvidenceIds: ["evidence-b-failed"],
      }),
    ]);

    expect(projection.lanes.find((item) => item.id === "lane-b")?.status).toBe("failed");
    expect(projection.lanes.find((item) => item.id === "lane-b")?.rollbackStatus).toBeUndefined();
    expect(scheduleReadyLanes(projection, { allowedParallelism: 1 }).map((item) => item.id)).toEqual(["lane-repair-b"]);
  });

  it("does not schedule checkpoint repair successors when failed evidence is outside the selected checkpoint run", () => {
    const afterCheckpointId = "checkpoint-after-lane-b-run-old";
    const oldCheckpoint = {
      ...checkpoint(afterCheckpointId, "lane-b", "after", "old-head-sha"),
      runId: "run-b-old",
      segmentId: "segment-b-old",
      evidenceRefs: [{ kind: "evidence", id: "evidence-b-new-failed" }],
    };
    const projection = reduceWorkflowEvents([
      event("workflow.lane.declared", { lane: lane("lane-b", "implementation") }),
      event("workflow.lane.declared", {
        lane: {
          ...lane("lane-repair-b", "fix"),
          semanticKey: "manual:repair-lane-b",
        },
      }),
      event("workflow.edge.declared", { edge: { id: "edge-b-repair", sourceLaneId: "lane-b", targetLaneId: "lane-repair-b" } }),
      event("workflow.node.checkpoint_recorded", { checkpoint: oldCheckpoint }),
      event("workflow.segment.started", {
        segment: { id: "segment-b-new", laneId: "lane-b", runId: "run-b-new", status: "running" },
      }),
      event("workflow.segment.finished", {
        laneId: "lane-b",
        segmentId: "segment-b-new",
        status: "failed",
        exitCode: 1,
      }),
      event("workflow.evidence.recorded", {
        laneId: "lane-b",
        segmentId: "segment-b-new",
        evidence: { id: "evidence-b-new-failed", kind: "run-exit", status: "failed", checks: ["run-exit:failed"], artifacts: [] },
      }),
      event("workflow.node.repair_requested", {
        intentId: "repair-lane-b-after",
        laneId: "lane-b",
        checkpointId: afterCheckpointId,
        successorLaneId: "lane-repair-b",
        successorSemanticKey: "manual:repair-lane-b",
        sourceEvidenceIds: ["evidence-b-new-failed"],
      }),
    ]);

    expect(projection.checkpointIntents).toContainEqual(expect.objectContaining({
      intentId: "repair-lane-b-after",
      status: "requested",
    }));
    expect(projection.lanes.find((item) => item.id === "lane-b")?.status).toBe("failed");
    expect(scheduleReadyLanes(projection, { allowedParallelism: 1 }).map((item) => item.id)).toEqual([]);
  });

  it("does not schedule checkpoint repair successors from source evidence when checkpoint run cannot be validated", () => {
    const afterCheckpointId = "checkpoint-after-lane-b-run-old";
    const oldCheckpoint = {
      ...checkpoint(afterCheckpointId, "lane-b", "after", "old-head-sha"),
      runId: "run-b-old",
      segmentId: "segment-b-old",
      evidenceRefs: [{ kind: "evidence", id: "evidence-b-old-failed" }],
    };
    const projection = reduceWorkflowEvents([
      event("workflow.lane.declared", { lane: lane("lane-b", "implementation") }),
      event("workflow.lane.declared", {
        lane: {
          ...lane("lane-repair-b", "fix"),
          semanticKey: "manual:repair-lane-b",
        },
      }),
      event("workflow.edge.declared", { edge: { id: "edge-b-repair", sourceLaneId: "lane-b", targetLaneId: "lane-repair-b" } }),
      event("workflow.node.checkpoint_recorded", { checkpoint: oldCheckpoint }),
      event("workflow.segment.finished", {
        laneId: "lane-b",
        segmentId: "segment-b-old",
        status: "failed",
        exitCode: 1,
      }),
      event("workflow.evidence.recorded", {
        laneId: "lane-b",
        segmentId: "segment-b-old",
        evidence: { id: "evidence-b-old-failed", kind: "run-exit", status: "failed", checks: ["run-exit:failed"], artifacts: [] },
      }),
      event("workflow.node.repair_requested", {
        intentId: "repair-lane-b-after",
        laneId: "lane-b",
        checkpointId: afterCheckpointId,
        successorLaneId: "lane-repair-b",
        successorSemanticKey: "manual:repair-lane-b",
        sourceEvidenceIds: ["evidence-b-old-failed"],
      }),
    ]);

    expect(projection.lanes.find((item) => item.id === "lane-b")?.status).toBe("failed");
    expect(scheduleReadyLanes(projection, { allowedParallelism: 1 }).map((item) => item.id)).toEqual([]);
  });

  it("schedules checkpoint repair successors when failed evidence belongs to the selected checkpoint run", () => {
    const afterCheckpointId = "checkpoint-after-lane-b-run-1";
    const selectedCheckpoint = {
      ...checkpoint(afterCheckpointId, "lane-b", "after", "head-sha"),
      runId: "run-b-1",
      segmentId: "segment-b-run-1-failure",
    };
    const projection = reduceWorkflowEvents([
      event("workflow.lane.declared", { lane: lane("lane-b", "implementation") }),
      event("workflow.lane.declared", {
        lane: {
          ...lane("lane-repair-b", "fix"),
          semanticKey: "manual:repair-lane-b",
        },
      }),
      event("workflow.edge.declared", { edge: { id: "edge-b-repair", sourceLaneId: "lane-b", targetLaneId: "lane-repair-b" } }),
      event("workflow.node.checkpoint_recorded", { checkpoint: selectedCheckpoint }),
      event("workflow.segment.started", {
        segment: { id: "segment-b-run-1-failure", laneId: "lane-b", runId: "run-b-1", status: "running" },
      }),
      event("workflow.segment.finished", {
        laneId: "lane-b",
        segmentId: "segment-b-run-1-failure",
        status: "failed",
        exitCode: 1,
      }),
      event("workflow.evidence.recorded", {
        laneId: "lane-b",
        segmentId: "segment-b-run-1-failure",
        evidence: { id: "evidence-b-run-1-failed", kind: "run-exit", status: "failed", checks: ["run-exit:failed"], artifacts: [] },
      }),
      event("workflow.node.repair_requested", {
        intentId: "repair-lane-b-after",
        laneId: "lane-b",
        checkpointId: afterCheckpointId,
        successorLaneId: "lane-repair-b",
        successorSemanticKey: "manual:repair-lane-b",
        sourceEvidenceIds: ["evidence-b-run-1-failed"],
      }),
    ]);

    expect(scheduleReadyLanes(projection, { allowedParallelism: 1 }).map((item) => item.id)).toEqual(["lane-repair-b"]);
  });

  it("preserves executable lane brief through projection for repair prompts", () => {
    const projection = reduceWorkflowEvents([
      event("workflow.lane.declared", {
        lane: {
          ...lane("lane-repair-b", "fix"),
          semanticSubtype: "repair",
          brief: "Repair from after checkpoint checkpoint-after-lane-b-run-1; source lane lane-b; failed evidence evidence-b-failed.",
        },
      }),
    ]);

    const repairLane = projection.lanes.find((item) => item.id === "lane-repair-b") as { brief?: string } | undefined;

    expect(repairLane).toMatchObject({
      brief: expect.stringContaining("after checkpoint checkpoint-after-lane-b-run-1"),
    });
    expect(scheduleReadyLanes(projection, { allowedParallelism: 1 })[0] as { brief?: string }).toMatchObject({
      brief: expect.stringContaining("failed evidence evidence-b-failed"),
    });
  });

  it("schedules checkpoint variants from the selected before checkpoint dependencies without overwriting the original lane", () => {
    const beforeCheckpointId = "checkpoint-before-lane-b-run-1";
    const projection = reduceWorkflowEvents([
      event("workflow.lane.declared", { lane: { ...lane("lane-a", "design"), status: "completed" } }),
      event("workflow.lane.declared", { lane: lane("lane-b", "implementation") }),
      event("workflow.lane.declared", {
        lane: {
          ...lane("lane-variant-b", "implementation"),
          semanticKey: "successor:variant-lane-b",
        },
      }),
      event("workflow.edge.declared", { edge: { id: "edge-a-b", sourceLaneId: "lane-a", targetLaneId: "lane-b" } }),
      event("workflow.edge.declared", { edge: { id: "edge-a-variant-b", sourceLaneId: "lane-a", targetLaneId: "lane-variant-b" } }),
      event("workflow.node.checkpoint_recorded", {
        checkpoint: checkpoint(beforeCheckpointId, "lane-b", "before", "base-sha"),
      }),
      event("workflow.node.variant_requested", {
        intentId: "variant-lane-b-before",
        laneId: "lane-b",
        checkpointId: beforeCheckpointId,
        successorLaneId: "lane-variant-b",
        successorSemanticKey: "successor:variant-lane-b",
      }),
    ]);

    expect(projection.checkpointIntents).toContainEqual(expect.objectContaining({
      intentId: "variant-lane-b-before",
      kind: "variant",
      status: "requested",
    }));
    expect(projection.lanes.find((item) => item.id === "lane-b")?.status).toBe("pending");
    expect(projection.lanes.find((item) => item.id === "lane-variant-b")?.status).toBe("pending");
    expect(scheduleReadyLanes(projection, { allowedParallelism: 2 }).map((item) => item.id)).toEqual([
      "lane-b",
      "lane-variant-b",
    ]);
  });

  it("does not schedule rollback successors before rollback is applied", () => {
    const afterCheckpointId = "checkpoint-after-lane-b-run-1";
    const projection = reduceWorkflowEvents([
      event("workflow.lane.declared", { lane: { ...lane("lane-b", "implementation"), status: "completed" } }),
      event("workflow.lane.declared", {
        lane: {
          ...lane("lane-repair-b", "fix"),
          semanticKey: "successor:repair-lane-b",
        },
      }),
      event("workflow.edge.declared", { edge: { id: "edge-b-repair", sourceLaneId: "lane-b", targetLaneId: "lane-repair-b" } }),
      event("workflow.node.checkpoint_recorded", {
        checkpoint: checkpoint(afterCheckpointId, "lane-b", "after", "head-sha"),
      }),
      event("workflow.node.repair_requested", {
        intentId: "repair-lane-b-after",
        laneId: "lane-b",
        checkpointId: afterCheckpointId,
        successorLaneId: "lane-repair-b",
        successorSemanticKey: "successor:repair-lane-b",
      }),
    ]);

    expect(projection.lanes.find((item) => item.id === "lane-b")?.status).toBe("completed");
    expect(scheduleReadyLanes(projection, { allowedParallelism: 1 }).map((item) => item.id)).toEqual([]);
  });

  it("does not schedule explicit rollback successors without incoming edges before rollback", () => {
    const beforeCheckpointId = "checkpoint-before-lane-b-run-1";
    const afterCheckpointId = "checkpoint-after-lane-b-run-1";
    const requested = reduceWorkflowEvents([
      event("workflow.lane.declared", { lane: { ...lane("lane-b", "implementation"), status: "completed" } }),
      event("workflow.lane.declared", {
        lane: {
          ...lane("lane-repair-b", "fix"),
          semanticKey: "successor:repair-lane-b",
        },
      }),
      event("workflow.node.checkpoint_recorded", {
        checkpoint: checkpoint(beforeCheckpointId, "lane-b", "before", "base-sha"),
      }),
      event("workflow.node.checkpoint_recorded", {
        checkpoint: checkpoint(afterCheckpointId, "lane-b", "after", "head-sha"),
      }),
      event("workflow.node.repair_requested", {
        intentId: "repair-lane-b-after",
        laneId: "lane-b",
        checkpointId: afterCheckpointId,
        successorLaneId: "lane-repair-b",
        successorSemanticKey: "successor:repair-lane-b",
      }),
    ]);
    const applied = reduceWorkflowEvents([
      ...requested.events,
      event("workflow.node.rollback_applied", {
        requestId: "rollback-lane-b",
        laneId: "lane-b",
        checkpointId: beforeCheckpointId,
      }),
    ]);

    expect(requested.edges).toEqual([]);
    expect(requested.lanes.find((item) => item.id === "lane-b")?.status).toBe("completed");
    expect(scheduleReadyLanes(requested, { allowedParallelism: 1 }).map((item) => item.id)).toEqual([]);
    expectLaneRollback(applied, "lane-b", "rolled_back");
    expect(scheduleReadyLanes(applied, { allowedParallelism: 1 }).map((item) => item.id)).toEqual(["lane-repair-b"]);
  });

  it("rejects rollback successor intents without explicit identity and preserves no downstream lanes", () => {
    const beforeCheckpointId = "checkpoint-before-lane-b-run-1";
    const afterCheckpointId = "checkpoint-after-lane-b-run-1";
    const projection = reduceWorkflowEvents([
      event("workflow.lane.declared", { lane: { ...lane("lane-b", "implementation"), status: "completed" } }),
      event("workflow.lane.declared", {
        lane: {
          ...lane("lane-repair-b", "fix"),
          semanticKey: "repair:lane-b:repair-lane-b-after",
        },
      }),
      event("workflow.lane.declared", {
        lane: {
          ...lane("lane-variant-b", "implementation"),
          semanticKey: "variant:lane-b:variant-lane-b-before",
        },
      }),
      event("workflow.lane.declared", {
        lane: {
          ...lane("lane-fork-b", "implementation"),
          semanticKey: "fork:lane-b:fork-lane-b-before",
        },
      }),
      event("workflow.edge.declared", { edge: { id: "edge-b-repair", sourceLaneId: "lane-b", targetLaneId: "lane-repair-b" } }),
      event("workflow.edge.declared", { edge: { id: "edge-b-variant", sourceLaneId: "lane-b", targetLaneId: "lane-variant-b" } }),
      event("workflow.edge.declared", { edge: { id: "edge-b-fork", sourceLaneId: "lane-b", targetLaneId: "lane-fork-b" } }),
      event("workflow.node.checkpoint_recorded", {
        checkpoint: checkpoint(beforeCheckpointId, "lane-b", "before", "base-sha"),
      }),
      event("workflow.node.checkpoint_recorded", {
        checkpoint: checkpoint(afterCheckpointId, "lane-b", "after", "head-sha"),
      }),
      event("workflow.node.repair_requested", {
        intentId: "repair-lane-b-after",
        laneId: "lane-b",
        checkpointId: afterCheckpointId,
      }),
      event("workflow.node.variant_requested", {
        intentId: "variant-lane-b-before",
        laneId: "lane-b",
        checkpointId: beforeCheckpointId,
      }),
      event("workflow.node.fork_requested", {
        intentId: "fork-lane-b-before",
        laneId: "lane-b",
        checkpointId: beforeCheckpointId,
      }),
      event("workflow.node.rollback_applied", {
        requestId: "rollback-lane-b",
        laneId: "lane-b",
        checkpointId: beforeCheckpointId,
      }),
    ]);

    expect(projection.checkpointIntents).toEqual([
      expect.objectContaining({
        intentId: "repair-lane-b-after",
        kind: "repair",
        status: "rejected",
        reason: expect.stringMatching(/successor identity/i),
      }),
      expect.objectContaining({
        intentId: "variant-lane-b-before",
        kind: "variant",
        status: "rejected",
        reason: expect.stringMatching(/successor identity/i),
      }),
      expect.objectContaining({
        intentId: "fork-lane-b-before",
        kind: "fork",
        status: "rejected",
        reason: expect.stringMatching(/successor identity/i),
      }),
    ]);
    expectLaneRollback(projection, "lane-repair-b", "inactive");
    expectLaneRollback(projection, "lane-variant-b", "inactive");
    expectLaneRollback(projection, "lane-fork-b", "inactive");
    expect(scheduleReadyLanes(projection, { allowedParallelism: 1 }).map((item) => item.id)).toEqual([]);
  });

  it("rejects repair, variant, and fork from lane-less checkpoints even with explicit successor identity", () => {
    const rollbackCheckpointId = "checkpoint-before-lane-b-run-1";
    const laneLessBeforeCheckpointId = "checkpoint-before-node-b-run-1";
    const laneLessAfterCheckpointId = "checkpoint-after-node-b-run-1";
    const projection = reduceWorkflowEvents([
      event("workflow.lane.declared", { lane: { ...lane("lane-b", "implementation"), status: "completed" } }),
      event("workflow.lane.declared", {
        lane: {
          ...lane("lane-repair-b", "fix"),
          semanticKey: "successor:repair-lane-b",
        },
      }),
      event("workflow.lane.declared", {
        lane: {
          ...lane("lane-variant-b", "implementation"),
          semanticKey: "successor:variant-lane-b",
        },
      }),
      event("workflow.lane.declared", {
        lane: {
          ...lane("lane-fork-b", "implementation"),
          semanticKey: "successor:fork-lane-b",
        },
      }),
      event("workflow.edge.declared", { edge: { id: "edge-b-repair", sourceLaneId: "lane-b", targetLaneId: "lane-repair-b" } }),
      event("workflow.edge.declared", { edge: { id: "edge-b-variant", sourceLaneId: "lane-b", targetLaneId: "lane-variant-b" } }),
      event("workflow.edge.declared", { edge: { id: "edge-b-fork", sourceLaneId: "lane-b", targetLaneId: "lane-fork-b" } }),
      event("workflow.node.checkpoint_recorded", {
        checkpoint: checkpoint(rollbackCheckpointId, "lane-b", "before", "base-sha"),
      }),
      event("workflow.node.checkpoint_recorded", {
        checkpoint: {
          id: laneLessBeforeCheckpointId,
          sessionId: "session-1",
          nodeId: "node-b",
          phase: "before",
          executionTarget: "new_worktree",
          baseCommit: "base-sha",
          headCommit: "base-sha",
          createdAt: now,
          source: "agent_bridge",
          evidenceRefs: [{ kind: "run", id: "run-node-b-1" }],
        },
      }),
      event("workflow.node.checkpoint_recorded", {
        checkpoint: {
          id: laneLessAfterCheckpointId,
          sessionId: "session-1",
          nodeId: "node-b",
          phase: "after",
          executionTarget: "new_worktree",
          baseCommit: "base-sha",
          headCommit: "head-sha",
          createdAt: now,
          source: "agent_bridge",
          evidenceRefs: [{ kind: "changeset", id: "changeset-node-b-1" }],
        },
      }),
      event("workflow.node.repair_requested", {
        intentId: "repair-node-b-after",
        checkpointId: laneLessAfterCheckpointId,
        successorLaneId: "lane-repair-b",
      }),
      event("workflow.node.variant_requested", {
        intentId: "variant-node-b-before",
        checkpointId: laneLessBeforeCheckpointId,
        successorSemanticKey: "successor:variant-lane-b",
      }),
      event("workflow.node.fork_requested", {
        intentId: "fork-node-b-before",
        checkpointId: laneLessBeforeCheckpointId,
        successorLaneId: "lane-fork-b",
      }),
      event("workflow.node.rollback_applied", {
        requestId: "rollback-lane-b",
        laneId: "lane-b",
        checkpointId: rollbackCheckpointId,
      }),
    ]);

    expect(projection.checkpointIntents.map((item) => [item.intentId, item.kind, item.status])).toEqual([
      ["repair-node-b-after", "repair", "rejected"],
      ["variant-node-b-before", "variant", "rejected"],
      ["fork-node-b-before", "fork", "rejected"],
    ]);
    for (const intent of projection.checkpointIntents) {
      expect(intent).not.toHaveProperty("laneId");
      expect(intent.reason).toMatch(/target lane/i);
    }
    expectLaneRollback(projection, "lane-repair-b", "inactive");
    expectLaneRollback(projection, "lane-variant-b", "inactive");
    expectLaneRollback(projection, "lane-fork-b", "inactive");
    expect(scheduleReadyLanes(projection, { allowedParallelism: 3 }).map((item) => item.id)).toEqual([]);
  });

  it("schedules rollback successors by explicit successorLaneId without semantic-key conventions", () => {
    const beforeCheckpointId = "checkpoint-before-lane-b-run-1";
    const afterCheckpointId = "checkpoint-after-lane-b-run-1";
    const projection = reduceWorkflowEvents([
      event("workflow.lane.declared", { lane: { ...lane("lane-b", "implementation"), status: "completed" } }),
      event("workflow.lane.declared", {
        lane: {
          ...lane("lane-repair-b", "fix"),
          semanticKey: "dynamic:repair-lane-b",
        },
      }),
      event("workflow.edge.declared", { edge: { id: "edge-b-repair", sourceLaneId: "lane-b", targetLaneId: "lane-repair-b" } }),
      event("workflow.node.checkpoint_recorded", {
        checkpoint: checkpoint(beforeCheckpointId, "lane-b", "before", "base-sha"),
      }),
      event("workflow.node.checkpoint_recorded", {
        checkpoint: checkpoint(afterCheckpointId, "lane-b", "after", "head-sha"),
      }),
      event("workflow.node.repair_requested", {
        intentId: "repair-lane-b-after",
        laneId: "lane-b",
        checkpointId: afterCheckpointId,
        successorLaneId: "lane-repair-b",
      }),
      event("workflow.node.rollback_applied", {
        requestId: "rollback-lane-b",
        laneId: "lane-b",
        checkpointId: beforeCheckpointId,
      }),
    ]);

    expect(projection.lanes.find((item) => item.id === "lane-repair-b")?.status).toBe("pending");
    expect(scheduleReadyLanes(projection, { allowedParallelism: 1 }).map((item) => item.id)).toEqual(["lane-repair-b"]);
  });

  it("schedules rollback successors by explicit successorSemanticKey without lane-id conventions", () => {
    const beforeCheckpointId = "checkpoint-before-lane-b-run-1";
    const afterCheckpointId = "checkpoint-after-lane-b-run-1";
    const projection = reduceWorkflowEvents([
      event("workflow.lane.declared", { lane: { ...lane("lane-b", "implementation"), status: "completed" } }),
      event("workflow.lane.declared", {
        lane: {
          ...lane("lane-generated-repair-b", "fix"),
          semanticKey: "successor:repair-lane-b",
        },
      }),
      event("workflow.edge.declared", { edge: { id: "edge-b-repair", sourceLaneId: "lane-b", targetLaneId: "lane-generated-repair-b" } }),
      event("workflow.node.checkpoint_recorded", {
        checkpoint: checkpoint(beforeCheckpointId, "lane-b", "before", "base-sha"),
      }),
      event("workflow.node.checkpoint_recorded", {
        checkpoint: checkpoint(afterCheckpointId, "lane-b", "after", "head-sha"),
      }),
      event("workflow.node.repair_requested", {
        intentId: "repair-lane-b-after",
        laneId: "lane-b",
        checkpointId: afterCheckpointId,
        successorSemanticKey: "successor:repair-lane-b",
      }),
      event("workflow.node.rollback_applied", {
        requestId: "rollback-lane-b",
        laneId: "lane-b",
        checkpointId: beforeCheckpointId,
      }),
    ]);

    expect(projection.lanes.find((item) => item.id === "lane-generated-repair-b")?.status).toBe("pending");
    expect(scheduleReadyLanes(projection, { allowedParallelism: 1 }).map((item) => item.id)).toEqual(["lane-generated-repair-b"]);
  });

  it("keeps explicit repair, variant, and fork successors requested and schedulable", () => {
    const beforeCheckpointId = "checkpoint-before-lane-b-run-1";
    const afterCheckpointId = "checkpoint-after-lane-b-run-1";
    const projection = reduceWorkflowEvents([
      event("workflow.lane.declared", { lane: { ...lane("lane-b", "implementation"), status: "completed" } }),
      event("workflow.lane.declared", {
        lane: {
          ...lane("lane-repair-b", "fix"),
          semanticKey: "dynamic:repair-lane-b",
        },
      }),
      event("workflow.lane.declared", {
        lane: {
          ...lane("lane-variant-b", "implementation"),
          semanticKey: "successor:variant-lane-b",
        },
      }),
      event("workflow.lane.declared", {
        lane: {
          ...lane("lane-fork-b", "implementation"),
          semanticKey: "dynamic:fork-lane-b",
        },
      }),
      event("workflow.edge.declared", { edge: { id: "edge-b-repair", sourceLaneId: "lane-b", targetLaneId: "lane-repair-b" } }),
      event("workflow.edge.declared", { edge: { id: "edge-b-variant", sourceLaneId: "lane-b", targetLaneId: "lane-variant-b" } }),
      event("workflow.edge.declared", { edge: { id: "edge-b-fork", sourceLaneId: "lane-b", targetLaneId: "lane-fork-b" } }),
      event("workflow.node.checkpoint_recorded", {
        checkpoint: checkpoint(beforeCheckpointId, "lane-b", "before", "base-sha"),
      }),
      event("workflow.node.checkpoint_recorded", {
        checkpoint: checkpoint(afterCheckpointId, "lane-b", "after", "head-sha"),
      }),
      event("workflow.node.repair_requested", {
        intentId: "repair-lane-b-after",
        laneId: "lane-b",
        checkpointId: afterCheckpointId,
        successorLaneId: "lane-repair-b",
      }),
      event("workflow.node.variant_requested", {
        intentId: "variant-lane-b-before",
        laneId: "lane-b",
        checkpointId: beforeCheckpointId,
        successorSemanticKey: "successor:variant-lane-b",
      }),
      event("workflow.node.fork_requested", {
        intentId: "fork-lane-b-before",
        laneId: "lane-b",
        checkpointId: beforeCheckpointId,
        successorLaneId: "lane-fork-b",
      }),
      event("workflow.node.rollback_applied", {
        requestId: "rollback-lane-b",
        laneId: "lane-b",
        checkpointId: beforeCheckpointId,
      }),
    ]);

    expect(projection.checkpointIntents).toEqual([
      expect.objectContaining({ intentId: "repair-lane-b-after", kind: "repair", status: "requested" }),
      expect.objectContaining({ intentId: "variant-lane-b-before", kind: "variant", status: "requested" }),
      expect.objectContaining({ intentId: "fork-lane-b-before", kind: "fork", status: "requested" }),
    ]);
    expect(scheduleReadyLanes(projection, { allowedParallelism: 3 }).map((item) => item.id)).toEqual([
      "lane-repair-b",
      "lane-variant-b",
      "lane-fork-b",
    ]);
  });

  it("resets stale completed rollback successors to their declared schedulable state when rollback is applied", () => {
    const beforeCheckpointId = "checkpoint-before-lane-b-run-1";
    const afterCheckpointId = "checkpoint-after-lane-b-run-1";
    const projection = reduceWorkflowEvents([
      event("workflow.lane.declared", { lane: { ...lane("lane-b", "implementation"), status: "completed" } }),
      event("workflow.lane.declared", {
        lane: {
          ...lane("lane-repair-b", "fix"),
          status: "ready",
          semanticKey: "successor:repair-lane-b",
        },
      }),
      event("workflow.lane.declared", {
        lane: {
          ...lane("lane-variant-b", "implementation"),
          semanticKey: "successor:variant-lane-b",
        },
      }),
      event("workflow.edge.declared", { edge: { id: "edge-b-repair", sourceLaneId: "lane-b", targetLaneId: "lane-repair-b" } }),
      event("workflow.edge.declared", { edge: { id: "edge-b-variant", sourceLaneId: "lane-b", targetLaneId: "lane-variant-b" } }),
      event("workflow.node.checkpoint_recorded", {
        checkpoint: checkpoint(beforeCheckpointId, "lane-b", "before", "base-sha"),
      }),
      event("workflow.node.checkpoint_recorded", {
        checkpoint: checkpoint(afterCheckpointId, "lane-b", "after", "head-sha"),
      }),
      event("workflow.node.repair_requested", {
        intentId: "repair-lane-b-after",
        laneId: "lane-b",
        checkpointId: afterCheckpointId,
        successorLaneId: "lane-repair-b",
        successorSemanticKey: "successor:repair-lane-b",
      }),
      event("workflow.node.variant_requested", {
        intentId: "variant-lane-b-before",
        laneId: "lane-b",
        checkpointId: beforeCheckpointId,
        successorLaneId: "lane-variant-b",
        successorSemanticKey: "successor:variant-lane-b",
      }),
      event("workflow.segment.started", {
        segment: { id: "segment-repair-b-1", laneId: "lane-repair-b", runId: "run-repair-b-1", status: "running" },
      }),
      event("workflow.evidence.recorded", {
        laneId: "lane-repair-b",
        segmentId: "segment-repair-b-1",
        evidence: { id: "evidence-repair-b", kind: "test", status: "passed", checks: ["unit"], artifacts: [] },
      }),
      event("workflow.segment.started", {
        segment: { id: "segment-variant-b-1", laneId: "lane-variant-b", runId: "run-variant-b-1", status: "running" },
      }),
      event("workflow.evidence.recorded", {
        laneId: "lane-variant-b",
        segmentId: "segment-variant-b-1",
        evidence: { id: "evidence-variant-b", kind: "test", status: "passed", checks: ["unit"], artifacts: [] },
      }),
      event("workflow.node.rollback_applied", {
        requestId: "rollback-lane-b",
        laneId: "lane-b",
        checkpointId: beforeCheckpointId,
      }),
    ]);

    expectLaneRollback(projection, "lane-b", "rolled_back");
    expect(projection.lanes.find((item) => item.id === "lane-repair-b")?.status).toBe("ready");
    expect(projection.lanes.find((item) => item.id === "lane-variant-b")?.status).toBe("pending");
    expect(scheduleReadyLanes(projection, { allowedParallelism: 2 }).map((item) => item.id)).toEqual([
      "lane-repair-b",
      "lane-variant-b",
    ]);
  });

  it("does not schedule successors when successorLaneId and successorSemanticKey disagree", () => {
    const beforeCheckpointId = "checkpoint-before-lane-b-run-1";
    const afterCheckpointId = "checkpoint-after-lane-b-run-1";
    const projection = reduceWorkflowEvents([
      event("workflow.lane.declared", { lane: { ...lane("lane-b", "implementation"), status: "completed" } }),
      event("workflow.lane.declared", {
        lane: {
          ...lane("lane-repair-b", "fix"),
          semanticKey: "successor:repair-lane-b",
        },
      }),
      event("workflow.lane.declared", {
        lane: {
          ...lane("lane-wrong-b", "fix"),
          semanticKey: "successor:wrong-lane-b",
        },
      }),
      event("workflow.edge.declared", { edge: { id: "edge-b-repair", sourceLaneId: "lane-b", targetLaneId: "lane-repair-b" } }),
      event("workflow.edge.declared", { edge: { id: "edge-b-wrong", sourceLaneId: "lane-b", targetLaneId: "lane-wrong-b" } }),
      event("workflow.node.checkpoint_recorded", {
        checkpoint: checkpoint(beforeCheckpointId, "lane-b", "before", "base-sha"),
      }),
      event("workflow.node.checkpoint_recorded", {
        checkpoint: checkpoint(afterCheckpointId, "lane-b", "after", "head-sha"),
      }),
      event("workflow.node.repair_requested", {
        intentId: "repair-lane-b-after",
        laneId: "lane-b",
        checkpointId: afterCheckpointId,
        successorLaneId: "lane-repair-b",
        successorSemanticKey: "successor:wrong-lane-b",
      }),
      event("workflow.node.rollback_applied", {
        requestId: "rollback-lane-b",
        laneId: "lane-b",
        checkpointId: beforeCheckpointId,
      }),
    ]);

    expect(projection.checkpointIntents).toEqual([
      expect.objectContaining({
        status: "requested",
        successorLaneId: "lane-repair-b",
        successorSemanticKey: "successor:wrong-lane-b",
      }),
    ]);
    expectLaneRollback(projection, "lane-repair-b", "inactive");
    expectLaneRollback(projection, "lane-wrong-b", "inactive");
    expect(scheduleReadyLanes(projection, { allowedParallelism: 3 }).map((item) => item.id)).toEqual([]);
  });

  it("restores inactive rollback successors when repair intent arrives after rollback", () => {
    const beforeCheckpointId = "checkpoint-before-lane-b-run-1";
    const afterCheckpointId = "checkpoint-after-lane-b-run-1";
    const rolledBack = reduceWorkflowEvents([
      event("workflow.lane.declared", { lane: { ...lane("lane-b", "implementation"), status: "completed" } }),
      event("workflow.lane.declared", {
        lane: {
          ...lane("lane-repair-b", "fix"),
          semanticKey: "successor:repair-lane-b",
        },
      }),
      event("workflow.lane.declared", {
        lane: {
          ...lane("lane-regression-b", "regression_check"),
          semanticKey: "regression:repair-lane-b",
        },
      }),
      event("workflow.lane.declared", {
        lane: {
          ...lane("lane-unrelated-b", "implementation"),
          semanticKey: "dynamic:unrelated-b",
        },
      }),
      event("workflow.edge.declared", { edge: { id: "edge-b-repair", sourceLaneId: "lane-b", targetLaneId: "lane-repair-b" } }),
      event("workflow.edge.declared", { edge: { id: "edge-repair-regression", sourceLaneId: "lane-repair-b", targetLaneId: "lane-regression-b" } }),
      event("workflow.edge.declared", { edge: { id: "edge-b-unrelated", sourceLaneId: "lane-b", targetLaneId: "lane-unrelated-b" } }),
      event("workflow.node.checkpoint_recorded", {
        checkpoint: checkpoint(beforeCheckpointId, "lane-b", "before", "base-sha"),
      }),
      event("workflow.node.checkpoint_recorded", {
        checkpoint: checkpoint(afterCheckpointId, "lane-b", "after", "head-sha"),
      }),
      event("workflow.node.rollback_applied", {
        requestId: "rollback-lane-b",
        laneId: "lane-b",
        checkpointId: beforeCheckpointId,
      }),
    ]);
    const repaired = reduceWorkflowEvents([
      ...rolledBack.events,
      event("workflow.node.repair_requested", {
        intentId: "repair-lane-b-after",
        laneId: "lane-b",
        checkpointId: afterCheckpointId,
        successorLaneId: "lane-repair-b",
        successorSemanticKey: "successor:repair-lane-b",
      }),
    ]);
    const regression = reduceWorkflowEvents([
      ...repaired.events,
      event("workflow.segment.started", {
        segment: { id: "segment-repair-b-1", laneId: "lane-repair-b", runId: "run-repair-b-1", status: "running" },
      }),
      event("workflow.segment.finished", {
        laneId: "lane-repair-b",
        segmentId: "segment-repair-b-1",
        status: "succeeded",
        exitCode: 0,
      }),
      event("workflow.evidence.recorded", {
        laneId: "lane-repair-b",
        segmentId: "segment-repair-b-1",
        evidence: { id: "evidence-repair-b", kind: "test", status: "passed", checks: ["unit"], artifacts: [] },
      }),
    ]);

    expectLaneRollback(rolledBack, "lane-b", "rolled_back");
    expectLaneRollback(rolledBack, "lane-repair-b", "inactive");
    expectLaneRollback(rolledBack, "lane-regression-b", "inactive");
    expect(repaired.lanes.find((item) => item.id === "lane-repair-b")?.status).toBe("pending");
    expect(repaired.lanes.find((item) => item.id === "lane-regression-b")?.status).toBe("pending");
    expectLaneRollback(repaired, "lane-unrelated-b", "inactive");
    expect(scheduleReadyLanes(repaired, { allowedParallelism: 3 }).map((item) => item.id)).toEqual(["lane-repair-b"]);
    expect(scheduleReadyLanes(regression, { allowedParallelism: 3 }).map((item) => item.id)).toEqual(["lane-regression-b"]);
  });

  it("keeps rollback successor fan-in nodes inactive when an affected sibling branch is not preserved", () => {
    const beforeCheckpointId = "checkpoint-before-lane-b-run-1";
    const afterCheckpointId = "checkpoint-after-lane-b-run-1";
    const projection = reduceWorkflowEvents([
      event("workflow.lane.declared", { lane: { ...lane("lane-b", "implementation"), status: "completed" } }),
      event("workflow.lane.declared", {
        lane: {
          ...lane("lane-repair-b", "fix"),
          semanticKey: "successor:repair-lane-b",
        },
      }),
      event("workflow.lane.declared", { lane: lane("lane-downstream-b", "validation") }),
      event("workflow.lane.declared", { lane: lane("lane-integration-b", "integration_test") }),
      event("workflow.edge.declared", { edge: { id: "edge-b-repair", sourceLaneId: "lane-b", targetLaneId: "lane-repair-b" } }),
      event("workflow.edge.declared", { edge: { id: "edge-b-downstream", sourceLaneId: "lane-b", targetLaneId: "lane-downstream-b" } }),
      event("workflow.edge.declared", {
        edge: { id: "edge-repair-integration", sourceLaneId: "lane-repair-b", targetLaneId: "lane-integration-b" },
      }),
      event("workflow.edge.declared", {
        edge: { id: "edge-downstream-integration", sourceLaneId: "lane-downstream-b", targetLaneId: "lane-integration-b" },
      }),
      event("workflow.node.checkpoint_recorded", {
        checkpoint: checkpoint(beforeCheckpointId, "lane-b", "before", "base-sha"),
      }),
      event("workflow.node.checkpoint_recorded", {
        checkpoint: checkpoint(afterCheckpointId, "lane-b", "after", "head-sha"),
      }),
      event("workflow.node.repair_requested", {
        intentId: "repair-lane-b-after",
        laneId: "lane-b",
        checkpointId: afterCheckpointId,
        successorLaneId: "lane-repair-b",
        successorSemanticKey: "successor:repair-lane-b",
      }),
      event("workflow.node.rollback_applied", {
        requestId: "rollback-lane-b",
        laneId: "lane-b",
        checkpointId: beforeCheckpointId,
      }),
    ]);
    const repaired = reduceWorkflowEvents([
      ...projection.events,
      event("workflow.segment.started", {
        segment: { id: "segment-repair-b-1", laneId: "lane-repair-b", runId: "run-repair-b-1", status: "running" },
      }),
      event("workflow.segment.finished", {
        laneId: "lane-repair-b",
        segmentId: "segment-repair-b-1",
        status: "succeeded",
        exitCode: 0,
      }),
      event("workflow.evidence.recorded", {
        laneId: "lane-repair-b",
        segmentId: "segment-repair-b-1",
        evidence: { id: "evidence-repair-b", kind: "test", status: "passed", checks: ["unit"], artifacts: [] },
      }),
    ]);

    expect(projection.lanes.find((item) => item.id === "lane-repair-b")?.status).toBe("pending");
    expectLaneRollback(projection, "lane-downstream-b", "inactive");
    expectLaneRollback(projection, "lane-integration-b", "inactive");
    expect(scheduleReadyLanes(projection, { allowedParallelism: 3 }).map((item) => item.id)).toEqual(["lane-repair-b"]);
    expect(scheduleReadyLanes(repaired, { allowedParallelism: 3 }).map((item) => item.id)).toEqual([]);
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

function checkpoint(
  id: string,
  laneId: string,
  phase: "before" | "after",
  headCommit: string,
  nodeId = laneId,
) {
  return {
    id,
    sessionId: "session-1",
    nodeId,
    laneId,
    runId: `run-${laneId.replace(/^lane-/, "")}-1`,
    segmentId: `segment-${laneId.replace(/^lane-/, "")}-1`,
    phase,
    executionTarget: "new_worktree",
    worktreeId: `worktree-${laneId.replace(/^lane-/, "")}`,
    worktreePath: `/repo.worktrees/session-1-${laneId}`,
    baseCommit: "base-sha",
    headCommit,
    createdAt: now,
    source: "agent_bridge",
    evidenceRefs: [{ kind: "run", id: `run-${laneId.replace(/^lane-/, "")}-1` }],
  };
}

function expectLaneRollback(
  projection: FlowProjection,
  laneId: string,
  rollbackStatus: "rolled_back" | "inactive" | "rejected",
  status: FlowLaneStatus = "blocked",
): void {
  const laneItem = projection.lanes.find((item) => item.id === laneId);

  expect(laneItem?.status).toBe(status);
  expect(laneItem?.rollbackStatus).toBe(rollbackStatus);
}
