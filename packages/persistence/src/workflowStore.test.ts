import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
  createWorkflowStore,
  type WorkflowCardCreateInput,
  type WorkflowCardToolCall,
} from "./workflowStore.js";

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
    expect(firstMigrations).toEqual([1]);
    expect(second.listAppliedMigrations()).toEqual([1]);
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
