import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
  createWorkflowStore,
  type WorkflowCardCreateInput,
  type WorkflowCardToolCall,
} from "./workflowStore.js";
import type { RunEvidence, WorkflowWorktreeIdentity } from "@skyturn/project-core";
import type { FlowEventKind, WorkflowIntent } from "@skyturn/workflow-kernel";

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.map((root) => rm(root, { recursive: true, force: true })));
  roots.length = 0;
});

describe("SQLite workflow store", () => {
  it("initializes the SQLite schema in .devflow and applies migrations idempotently", async () => {
    const projectRoot = await makeTempRoot();
    const first = createWorkflowStore({ projectRoot });
    const firstMigrations = first.listAppliedMigrations();
    const pragmas = first.readPragmas();
    first.close();

    const second = createWorkflowStore({ projectRoot });

    expect(first.databasePath).toBe(join(projectRoot, ".devflow", "skyturn-workflow.sqlite"));
    expect(pragmas.journalMode).toBe("wal");
    expect(pragmas.foreignKeys).toBe(1);
    expect(firstMigrations).toEqual([1, 2]);
    expect(second.listAppliedMigrations()).toEqual([1, 2]);
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
      restoreCommitRef: "base-sha",
      affectedLaneIds: expect.arrayContaining(["lane-implementation", "lane-validation", "lane-review"]),
      blockingRemoteSideEffects: [],
    });
    expect(applied).toMatchObject({
      status: "applied",
      event: expect.objectContaining({ kind: "workflow.node.rollback_applied" }),
      eligibility: expect.objectContaining({ eligible: true }),
    });
    expect(rollbackAppliedEvents).toHaveLength(1);
    expect(projection.lanes.find((lane) => lane.id === "lane-implementation")).toMatchObject({ rollbackStatus: "rolled_back" });
    expect(projection.lanes.find((lane) => lane.id === "lane-validation")).toMatchObject({ rollbackStatus: "inactive" });
    expect(projection.lanes.find((lane) => lane.id === "lane-review")).toMatchObject({ rollbackStatus: "inactive" });
    expect(canvas?.nodes.find((node) => node.id === "lane-implementation")).toMatchObject({ status: "failed", rollbackStatus: "rolled_back" });
    expect(canvas?.nodes.find((node) => node.id === "lane-validation")).toMatchObject({ status: "failed", rollbackStatus: "inactive" });
    expect(canvas?.nodes.find((node) => node.id === "lane-review")).toMatchObject({ status: "failed", rollbackStatus: "inactive" });
    expect(replayed).toEqual(projection);
    reopened.close();
  });

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
        blockingRemoteSideEffects: [expect.objectContaining({ eventKind: "workflow.delivery.pushed" })],
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

  it("rejects conflicting idempotent repair retries before adding successor edges", async () => {
    const store = await makeSeededStore();
    declareCodeChangeWorkflow(store);
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
    declareCodeChangeWorkflow(store);
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
      checks: ["Build and test:passed"],
    });
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
      checks: ["Build and test:passed"],
      artifacts: ["https://example.test/pr/22", "https://example.test/checks/current"],
    });
    store.close();
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
        text: [
          "stderr BEGIN",
          "OPENAI_API_KEY=sk-do-not-leak",
          "read .env with DATABASE_URL=postgres://secret",
          "diff --git a/src/a.ts b/src/a.ts",
          "+".repeat(7000),
          "stderr END",
        ].join("\n"),
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
      artifacts: [".devflow/tasks/session-1/lane-implementation/result.md"],
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
      output: expect.arrayContaining(["Implemented status filtering with tests."]),
    });
  });

  it.each(["lane-implementation", "lane-validation", "lane-review"] as const)(
    "records failed %s RunEvidence into one durable repair and regression chain",
    async (failedLaneId) => {
      const store = await makeSeededStore();
      declareCodeChangeWorkflow(store);
      advanceCodeChangeWorkflowToLane(store, failedLaneId);
      const failedInput = runResultInput(store, failedLaneId, "failed", "2026-06-14T00:00:10.000Z");

      store.recordRunResult(failedInput);
      store.recordRunResult(failedInput);

      const projection = store.materializeFlowProjection("session-1");
      const evidenceId = `evidence-segment-session-1-${failedLaneId}`;
      const fix = projection.lanes.find((lane) => lane.semanticKey === `repair:${failedLaneId}:${evidenceId}`);
      const regression = projection.lanes.find((lane) => lane.semanticKey === `regression:${failedLaneId}:${evidenceId}`);
      const replanEvents = store
        .listEvents("session-1")
        .filter((event) => event.kind === "workflow.replan.requested" && event.payload.laneId === failedLaneId);

      expect(projection.lanes.find((lane) => lane.id === failedLaneId)?.status).toBe("failed");
      expect(replanEvents).toHaveLength(1);
      expect(fix).toMatchObject({
        laneKind: "fix",
        semanticSubtype: "repair",
        runtimePolicy: {
          source: "workflow_projection",
          trusted: true,
          sandbox: "workspace-write",
        },
      });
      expect(regression).toMatchObject({
        laneKind: "regression",
        semanticSubtype: "regression_check",
        runtimePolicy: {
          source: "workflow_projection",
          trusted: true,
          sandbox: "read-only",
        },
      });
      expect(projection.edges).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ sourceLaneId: failedLaneId, targetLaneId: fix?.id }),
          expect.objectContaining({ sourceLaneId: fix?.id, targetLaneId: regression?.id }),
        ]),
      );

      const scheduled = store.scheduleReadyLanes("session-1", {
        allowedParallelism: 3,
        now: "2026-06-14T00:00:11.000Z",
      });

      expect(scheduled.readyLanes.map((lane) => lane.id)).toEqual([fix?.id]);
    },
  );

  it("does not auto-repair cancelled runs or failed repair lanes", async () => {
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
    repairStore.recordRunResult(
      runResultInput(repairStore, "lane-implementation", "failed", "2026-06-14T00:00:10.000Z"),
    );
    const firstRepair = repairStore
      .materializeFlowProjection("session-1")
      .lanes.find((lane) => lane.semanticKey.startsWith("repair:"));
    expect(firstRepair).toBeDefined();
    repairStore.scheduleReadyLanes("session-1", {
      allowedParallelism: 1,
      now: "2026-06-14T00:00:11.000Z",
    });

    repairStore.recordRunResult(
      runResultInput(repairStore, firstRepair!.id, "failed", "2026-06-14T00:00:12.000Z"),
    );

    const afterRepairFailure = repairStore.materializeFlowProjection("session-1");
    expect(repairStore.listEvents("session-1").filter((event) => event.kind === "workflow.replan.requested")).toHaveLength(1);
    expect(afterRepairFailure.lanes.filter((lane) => lane.semanticKey.startsWith(`repair:${firstRepair!.id}:`))).toEqual([]);
  });

  it("redacts run output and evidence before persisting event-stream projection data", async () => {
    const store = await makeSeededStore();
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
      artifacts: [".devflow/tasks/session-1/.env.secret"],
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

    expect(serializedEvents).toContain("[REDACTED]");
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

async function makeStore() {
  return createWorkflowStore({ projectRoot: await makeTempRoot() });
}

async function makeSeededStore() {
  const store = await makeStore();
  seedStore(store);
  return store;
}

function seedStore(store: ReturnType<typeof createWorkflowStore>): void {
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
