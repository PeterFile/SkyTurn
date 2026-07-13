import { mkdtemp, realpath, rm, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

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

    expect(first.databasePath).toBe(join(await realpath(projectRoot), ".devflow", "skyturn-workflow.sqlite"));
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
    const input = runResultInput(store, "lane-implementation", "succeeded", "2026-06-14T00:00:05.000Z");

    const assertReplayContract = () => {
      const eventsBefore = store.listEvents(input.sessionId);
      const projectionBefore = store.materializeFlowProjection(input.sessionId);
      expect(store.recordRunResult({ ...input, now: "2026-06-14T00:00:06.000Z" })).toEqual(projectionBefore);
      expect(store.listEvents(input.sessionId)).toEqual(eventsBefore);

      const conflicts = [
        { label: "status", input: { ...input, evidence: { ...input.evidence, status: "failed" as const } } },
        { label: "exit", input: { ...input, evidence: { ...input.evidence, exitCode: 17 } } },
        { label: "checks", input: { ...input, evidence: { ...input.evidence, checks: [{ ...input.evidence.checks[0]!, detail: "different" }] } } },
        { label: "changeset", input: { ...input, evidence: { ...input.evidence, changesetId: "changeset-conflict" } } },
        { label: "output", input: { ...input, outputSummary: "Conflicting terminal output." } },
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
