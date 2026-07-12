import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { AgentBridge } from "../../../packages/agent-bridge/dist/index.js";
import { createWorkflowStore } from "../../../packages/persistence/dist/workflowStore.js";
import { createRunStartHandler } from "../dist-electron/electron/runStartHandler.js";
import { isTrustedPlannerRootStartInput } from "../dist-electron/electron/workflowIpcContracts.js";
import { compensateFailedWorkflowRun, recoverTerminalWorkflowRuns } from "../dist-electron/electron/workflowRunRecovery.js";

test("trusted planner root persists and replays distinct first and second turn run ids", async () => {
  const root = await mkdtemp(join(tmpdir(), "skyturn-planner-run-start-"));
  try {
    seedPlannerStore(root).close();
    const runIds = ["run-session-1-node-1-20260713090000", "run-session-1-node-1-20260713090100"];

    for (const [index, runId] of runIds.entries()) {
      const input = plannerRunInput(root, runId);
      let activeStore;
      const handler = createRunStartHandler({
        resolveIdentity: identityFromRunInput,
        acquireStore: async () => {
          activeStore = createWorkflowStore({ projectRoot: root });
          activeStore.appendUserInput({
            sessionId: "session-1",
            inputId: input.plannerInputId,
            text: `Planner turn ${index + 1}`,
            now: `2026-07-13T01:0${index}:00.000Z`,
          });
          return activeStore;
        },
        reopenStore: async () => createWorkflowStore({ projectRoot: root }),
        assertStartInput: async (startInput, store) => {
          assert.equal(isTrustedPlannerRootStartInput(startInput, store), true);
        },
        claimUnscheduledStart: (startInput, store, identity) => store.claimPlannerRunStart({
          ...identity,
          agentKind: startInput.agentKind,
          worktreePath: root,
          now: `2026-07-13T01:0${index}:01.000Z`,
        }),
        prepareBeforeCheckpoint: async () => false,
        startRun: async () => ({ id: runId, status: "running" }),
        reconcileTerminal: async () => {},
        compensateTerminal: () => {},
        enrichAfterCheckpoint: async () => {},
        recordBeforeCheckpointFailure: () => {},
        recordAfterCheckpointFailure: () => {},
      });

      await assert.doesNotReject(handler(input));
      const running = activeStore.listRunningSegments().filter((segment) => segment.runId === runId);
      assert.equal(running.length, 1);
      assert.notEqual(running[0].segmentId, "segment-session-1-node-1");
      activeStore.close();

      const replayed = createWorkflowStore({ projectRoot: root });
      await recoverTerminalWorkflowRuns(root, replayed, {
        async getEvidence(_projectRoot, evidenceRunId) {
          return terminalPlannerEvidence(evidenceRunId, `2026-07-13T01:0${index}:02.000Z`);
        },
        async loadEvents() {
          return [{ kind: "output", payload: { text: `Planner turn ${index + 1} completed.` } }];
        },
      }, () => `Planner turn ${index + 1} completed.`);
      const canvas = replayed.materializeCanvasSession("session-1");
      const planner = canvas.nodes.find((node) => node.id === canvas.plannerNodeId);
      assert.equal(planner.runId, runId);
      assert.equal(planner.status, "completed");
      assert.deepEqual(planner.context.dependencies, []);
      assert.equal(canvas.edges.some((edge) => edge.target === canvas.plannerNodeId), false);
      replayed.close();
    }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("run:start single-flights the complete handler path for concurrent matching identities", async () => {
  const beforeEntered = deferred();
  const releaseBefore = deferred();
  const calls = [];
  const segment = {
    sessionId: "session-1",
    laneId: "lane-implementation",
    segmentId: "segment-session-1-lane-implementation",
    runId: "run-session-1-lane-implementation",
    agentKind: "codex",
  };
  const store = { listRunningSegments: () => [segment] };
  const input = runInput("/project");
  const handler = createRunStartHandler({
    resolveIdentity: identityFromRunInput,
    acquireStore: async () => {
      calls.push("store");
      return store;
    },
    reopenStore: async () => store,
    assertStartInput: async () => calls.push("preflight"),
    prepareBeforeCheckpoint: async () => {
      calls.push("before");
      beforeEntered.resolve();
      await releaseBefore.promise;
      return true;
    },
    startRun: async () => {
      calls.push("start");
      return { id: input.runId, status: "running" };
    },
    reconcileTerminal: async () => calls.push("reconcile"),
    compensateTerminal: () => calls.push("compensate"),
    enrichAfterCheckpoint: async () => calls.push("after"),
    recordBeforeCheckpointFailure: () => calls.push("before-failure"),
    recordAfterCheckpointFailure: () => calls.push("after-failure"),
  });

  const owner = handler(input);
  await beforeEntered.promise;
  const duplicate = handler({ ...input });
  releaseBefore.resolve();

  assert.deepEqual(await Promise.all([owner, duplicate]), [
    { id: input.runId, status: "running" },
    { id: input.runId, status: "running" },
  ]);
  assert.deepEqual(calls, ["store", "preflight", "before", "start"]);
});

test("two handlers and two AgentBridge instances never compensate the planner claim loser", async () => {
  const root = await mkdtemp(join(tmpdir(), "skyturn-planner-cross-instance-"));
  const claimBarrier = deferred();
  const ownerRelease = deferred();
  let claimEntrants = 0;
  let adapterStarts = 0;
  let compensations = 0;
  const stores = [];
  try {
    seedPlannerStore(root).close();
    const runId = "run-session-1-node-1-cross-instance";
    const input = plannerRunInput(root, runId);
    const adapter = {
      kind: "hermes",
      async detect() {
        throw new Error("Discovery is not part of this test.");
      },
      async startRun() {
        adapterStarts += 1;
        return { async cancel() {} };
      },
    };
    const bridges = [
      new AgentBridge({ adapters: [adapter] }),
      new AgentBridge({ adapters: [adapter] }),
    ];
    const handlers = bridges.map((bridge) => {
      const store = createWorkflowStore({ projectRoot: root });
      stores.push(store);
      return createRunStartHandler({
        resolveIdentity: identityFromRunInput,
        acquireStore: async () => store,
        reopenStore: async () => createWorkflowStore({ projectRoot: root }),
        assertStartInput: async () => {},
        claimUnscheduledStart: async (startInput, activeStore, identity) => {
          claimEntrants += 1;
          if (claimEntrants === 2) claimBarrier.resolve();
          await claimBarrier.promise;
          const claim = activeStore.claimPlannerRunStart({
            ...identity,
            agentKind: startInput.agentKind,
            worktreePath: root,
            now: "2026-07-13T01:00:01.000Z",
          });
          if (claim.created) await ownerRelease.promise;
          return claim;
        },
        prepareBeforeCheckpoint: async () => false,
        startRun: (startInput) => bridge.startRun(startInput),
        reconcileTerminal: async () => {
          throw new Error("The claim loser has no terminal evidence.");
        },
        compensateTerminal: (activeStore, segment, error) => {
          compensations += 1;
          compensateFailedWorkflowRun(activeStore, segment, error, () => "2026-07-13T01:00:02.000Z");
        },
        enrichAfterCheckpoint: async () => {},
        recordBeforeCheckpointFailure: () => {},
        recordAfterCheckpointFailure: () => {},
      });
    });

    const attempts = handlers.map((handler) => {
      const attempt = handler(input);
      void attempt.then(ownerRelease.resolve, ownerRelease.resolve);
      return attempt;
    });
    const results = await Promise.allSettled(attempts);
    assert.equal(results.filter((result) => result.status === "fulfilled").length, 1);
    assert.equal(results.filter((result) => result.status === "rejected").length, 1);
    assert.match(String(results.find((result) => result.status === "rejected")?.reason), /already (active|claimed)|durably claimed/i);
    assert.equal(adapterStarts, 1);
    assert.equal(compensations, 0);

    const verifier = createWorkflowStore({ projectRoot: root });
    const running = verifier.listRunningSegments();
    assert.equal(running.length, 1);
    assert.deepEqual(
      {
        sessionId: running[0].sessionId,
        laneId: running[0].laneId,
        runId: running[0].runId,
        status: running[0].status,
      },
      { sessionId: "session-1", laneId: "node-1", runId, status: "running" },
    );
    assert.equal(verifier.listEvents("session-1").some((event) =>
      event.segmentId === `planner-segment-${runId}` &&
      ["segment_finished", "lane_status_changed"].includes(event.kind) &&
      event.payload.status !== "running"
    ), false);
    verifier.close();
  } finally {
    for (const store of stores) store.close();
    await rm(root, { recursive: true, force: true });
  }
});

for (const [field, conflictingValue] of [
  ["agentKind", "gemini"],
  ["worktreePath", "/project-other"],
  ["sandbox", "danger-full-access"],
  ["prompt", "Run a different instruction"],
  ["expectedArtifacts", [".devflow/acceptance/other.png"]],
  ["plannerSessionId", "planner-session-other"],
  ["plannerInputId", "planner-input-other"],
  ["hermesSessionHandle", "resume-handle-other"],
  ["transport", "pty-interactive"],
]) {
  test(`run:start rejects concurrent ${field} identity conflicts without mutating the owner's segment`, async () => {
    const beforeEntered = deferred();
    const releaseBefore = deferred();
    const calls = [];
    const input = {
      ...runInput("/project"),
      plannerSessionId: "planner-session-1",
      plannerInputId: "planner-input-1",
      hermesSessionHandle: "resume-handle-1",
      transport: "exec-json",
    };
    const segment = {
      sessionId: input.sessionId,
      laneId: input.nodeId,
      segmentId: "segment-session-1-lane-implementation",
      runId: input.runId,
      agentKind: input.agentKind,
    };
    const store = { listRunningSegments: () => [segment] };
    const handler = createRunStartHandler({
      resolveIdentity: identityFromRunInput,
      acquireStore: async () => {
        calls.push("store");
        return store;
      },
      reopenStore: async () => store,
      assertStartInput: async () => calls.push("preflight"),
      prepareBeforeCheckpoint: async () => {
        calls.push("before");
        beforeEntered.resolve();
        await releaseBefore.promise;
        return true;
      },
      startRun: async () => {
        calls.push("start");
        return { id: input.runId, status: "running" };
      },
      reconcileTerminal: async () => calls.push("reconcile"),
      compensateTerminal: () => calls.push("compensate"),
      enrichAfterCheckpoint: async () => calls.push("after"),
      recordBeforeCheckpointFailure: () => calls.push("before-failure"),
      recordAfterCheckpointFailure: () => calls.push("after-failure"),
    });

    const owner = handler(input);
    await beforeEntered.promise;
    const conflictAssertion = assert.rejects(
      handler({ ...input, [field]: conflictingValue }),
      /different identity/i,
    );
    await new Promise((resolve) => setImmediate(resolve));
    releaseBefore.resolve();
    await conflictAssertion;
    await owner;
    assert.deepEqual(calls, ["store", "preflight", "before", "start"]);
  });
}

for (const [field, conflictingValue] of [
  ["agentKind", "gemini"],
  ["worktreePath", "/project-other"],
]) {
  test(`run:start rejects sequential ${field} conflicts without mutating the legal scheduled segment`, async () => {
    const calls = [];
    const input = runInput("/project");
    const segment = {
      sessionId: input.sessionId,
      laneId: input.nodeId,
      segmentId: "segment-session-1-lane-implementation",
      runId: input.runId,
      agentKind: input.agentKind,
    };
    const store = { listRunningSegments: () => [segment] };
    const handler = createRunStartHandler({
      resolveIdentity: identityFromRunInput,
      acquireStore: async () => store,
      reopenStore: async () => store,
      assertStartInput: async (startInput) => {
        if (startInput.worktreePath !== input.worktreePath) throw new Error("trusted worktree identity mismatch");
      },
      prepareBeforeCheckpoint: async () => {
        calls.push("before");
        return true;
      },
      startRun: async () => {
        calls.push("start");
        return { id: input.runId, status: "running" };
      },
      reconcileTerminal: async () => {
        calls.push("reconcile");
        throw new Error("no bridge evidence");
      },
      compensateTerminal: () => calls.push("compensate"),
      enrichAfterCheckpoint: async () => calls.push("after"),
      recordBeforeCheckpointFailure: () => calls.push("before-failure"),
      recordAfterCheckpointFailure: () => calls.push("after-failure"),
    });

    await handler(input);
    await assert.rejects(
      handler({ ...input, [field]: conflictingValue }),
      field === "agentKind" ? /agent.*identity/i : /worktree.*identity/i,
    );
    assert.deepEqual(calls, ["before", "start"]);
  });
}

for (const [failurePoint, shouldCompensate] of [
  ["preflight", false],
  ["store", false],
  ["beforeCheckpoint", false],
  ["bridgeStart", true],
]) {
  test(`run:start ${shouldCompensate ? "durably compensates" : "does not compensate"} ${failurePoint} failure`, async () => {
    const root = await mkdtemp(join(tmpdir(), "skyturn-run-start-"));
    try {
      seedRunningStore(root).close();
      const calls = [];
      let primaryStore;
      const handler = createRunStartHandler({
        resolveIdentity: () => identity(root),
        acquireStore: async () => {
          if (failurePoint === "store") throw new Error("store recovery failed");
          primaryStore = createWorkflowStore({ projectRoot: root });
          return primaryStore;
        },
        reopenStore: async () => createWorkflowStore({ projectRoot: root }),
        assertStartInput: async () => {
          calls.push("preflight");
          if (failurePoint === "preflight") throw new Error("preflight failed");
        },
        prepareBeforeCheckpoint: async () => {
          calls.push("before");
          if (failurePoint === "beforeCheckpoint") throw new Error("before checkpoint failed");
          return true;
        },
        startRun: async () => {
          calls.push("start");
          if (failurePoint === "bridgeStart") throw ownedStartError("bridge start failed");
          return { id: "unexpected" };
        },
        reconcileTerminal: async () => { throw new Error("no bridge evidence"); },
        compensateTerminal: (store, segment, error) => {
          calls.push("terminal");
          compensateFailedWorkflowRun(store, segment, error, () => "2026-07-12T00:00:04.000Z");
        },
        enrichAfterCheckpoint: async (store) => {
          calls.push("after");
          assert.equal(store.listRunningSegments().length, 0);
          assert.equal(segmentStatus(store), "failed");
        },
        recordBeforeCheckpointFailure: () => calls.push("before-failure"),
        recordAfterCheckpointFailure: () => calls.push("after-failure"),
      });

      await assert.rejects(handler(runInput(root)), new RegExp(failurePoint === "store" ? "store recovery" : failurePoint === "beforeCheckpoint" ? "before checkpoint" : failurePoint === "bridgeStart" ? "bridge start" : "preflight"));
      primaryStore?.close();

      const reopened = createWorkflowStore({ projectRoot: root });
      assert.equal(reopened.listRunningSegments().length, shouldCompensate ? 0 : 1);
      assert.equal(segmentStatus(reopened), shouldCompensate ? "failed" : "running");
      assert.equal(calls.includes("terminal"), shouldCompensate);
      assert.equal(calls.includes("after"), shouldCompensate);
      assert.equal(calls.includes("before-failure"), failurePoint === "beforeCheckpoint");
      reopened.close();
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
}

test("run:start retries terminal compensation on a reopened store when the active store cannot persist", async () => {
  const root = await mkdtemp(join(tmpdir(), "skyturn-run-start-reopen-"));
  try {
    seedRunningStore(root).close();
    const activeStore = createWorkflowStore({ projectRoot: root });
    let attempts = 0;
    const handler = createRunStartHandler({
      resolveIdentity: () => identity(root),
      acquireStore: async () => activeStore,
      reopenStore: async () => createWorkflowStore({ projectRoot: root }),
      assertStartInput: async () => {},
      prepareBeforeCheckpoint: async () => true,
      startRun: async () => { throw ownedStartError("bridge start failed"); },
      reconcileTerminal: async () => { throw new Error("no bridge evidence"); },
      compensateTerminal: (store, segment, error) => {
        attempts += 1;
        if (attempts === 1) throw new Error("active store write failed");
        compensateFailedWorkflowRun(store, segment, error, () => "2026-07-12T00:00:04.000Z");
      },
      enrichAfterCheckpoint: async () => {},
      recordBeforeCheckpointFailure: () => {},
      recordAfterCheckpointFailure: () => {},
    });

    await assert.rejects(handler(runInput(root)), /bridge start failed/);
    assert.equal(attempts, 2);
    activeStore.close();
    const reopened = createWorkflowStore({ projectRoot: root });
    assert.equal(reopened.listRunningSegments().length, 0);
    assert.equal(segmentStatus(reopened), "failed");
    reopened.close();
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("run:start compensates an owned durable claim when both terminal persistence paths fail", async () => {
  const root = await mkdtemp(join(tmpdir(), "skyturn-run-start-terminal-persistence-"));
  const input = { protocolVersion: 1, ...runInput(root) };
  const runDirectory = join(root, ".devflow", "runs", input.runId);
  const eventsPath = join(runDirectory, "events.ndjson");
  let activeStore;
  let adapterStarts = 0;
  let injectedAppendAttempts = 0;
  let compensations = 0;
  try {
    seedRunningStore(root).close();
    const bridge = new AgentBridge({
      appendEvent: async () => {
        injectedAppendAttempts += 1;
        throw new Error("injected terminal append failed");
      },
      adapters: [{
        kind: "codex",
        async detect() {
          throw new Error("Discovery is not part of this test.");
        },
        async startRun() {
          adapterStarts += 1;
          await mkdir(eventsPath);
          throw new Error("adapter spawn failed");
        },
      }],
    });
    const handler = createRunStartHandler({
      resolveIdentity: identityFromRunInput,
      acquireStore: async () => {
        activeStore = createWorkflowStore({ projectRoot: root });
        return activeStore;
      },
      reopenStore: async () => createWorkflowStore({ projectRoot: root }),
      assertStartInput: async () => {},
      prepareBeforeCheckpoint: async () => true,
      startRun: (startInput) => bridge.startRun(startInput),
      reconcileTerminal: async () => {
        throw new Error("No durable bridge terminal evidence exists.");
      },
      compensateTerminal: (store, segment, error) => {
        compensations += 1;
        compensateFailedWorkflowRun(store, segment, error, () => "2026-07-13T02:00:00.000Z");
      },
      enrichAfterCheckpoint: async () => {},
      recordBeforeCheckpointFailure: () => {},
      recordAfterCheckpointFailure: () => {},
    });

    let failure;
    await assert.rejects(handler(input), (error) => {
      failure = error;
      return true;
    });
    assert.equal(failure?.durableRunClaimOwned, true);
    assert.equal(failure?.message, "adapter spawn failed");
    assert.equal(failure?.cause?.message, "adapter spawn failed");
    assert.match(String(failure?.terminalPersistenceError), /EISDIR|illegal operation on a directory/i);
    assert.equal(injectedAppendAttempts, 1);
    assert.equal(compensations, 1);

    activeStore.close();
    activeStore = undefined;
    const verifier = createWorkflowStore({ projectRoot: root });
    assert.equal(verifier.listRunningSegments().length, 0);
    assert.equal(segmentStatus(verifier), "failed");
    verifier.close();

    await rm(eventsPath, { recursive: true, force: true });
    let restartStarts = 0;
    const restartedBridge = new AgentBridge({
      adapters: [{
        kind: "codex",
        async detect() {
          throw new Error("Discovery is not part of this test.");
        },
        async startRun() {
          restartStarts += 1;
          return { async cancel() {} };
        },
      }],
    });
    await assert.rejects(restartedBridge.startRun(input), /already (active|claimed)|durably claimed/i);
    assert.equal(adapterStarts, 1);
    assert.equal(restartStarts, 0);
  } finally {
    activeStore?.close();
    await rm(root, { recursive: true, force: true });
  }
});

function identity(projectRoot) {
  return identityFromRunInput(runInput(projectRoot));
}

function runInput(projectRoot) {
  return {
    projectRoot,
    sessionId: "session-1",
    nodeId: "lane-implementation",
    runId: "run-session-1-lane-implementation",
    agentKind: "codex",
    worktreePath: projectRoot,
    sandbox: "workspace-write",
    expectedArtifacts: [".devflow/acceptance/react-app.png"],
    prompt: "Implement the scheduled lane",
  };
}

function identityFromRunInput(input) {
  return {
    projectRoot: input.projectRoot,
    sessionId: input.sessionId,
    laneId: input.nodeId,
    runId: input.runId,
    agentKind: input.agentKind,
    worktreePath: input.worktreePath,
    plannerSessionId: input.plannerSessionId,
    plannerInputId: input.plannerInputId,
    hermesSessionHandle: input.hermesSessionHandle,
    transport: input.transport,
    startFingerprint: testStartFingerprint(input),
  };
}

function testStartFingerprint(input) {
  return JSON.stringify({
    projectRoot: input.projectRoot,
    sessionId: input.sessionId,
    nodeId: input.nodeId,
    runId: input.runId,
    agentKind: input.agentKind,
    transport: input.transport ?? null,
    worktreePath: input.worktreePath,
    sandbox: input.sandbox ?? null,
    prompt: input.prompt,
    expectedArtifacts: input.expectedArtifacts ?? [],
    plannerSessionId: input.plannerSessionId ?? null,
    plannerInputId: input.plannerInputId ?? null,
    hermesSessionHandle: input.hermesSessionHandle ?? null,
  });
}

function ownedStartError(message) {
  return Object.assign(new Error(message), { durableRunClaimOwned: true });
}

function deferred() {
  let resolve;
  const promise = new Promise((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

function seedRunningStore(projectRoot) {
  const store = createWorkflowStore({ projectRoot });
  store.createWorkflowSession({ id: "session-1", projectId: "project-1", title: "Run", goal: "Run", mode: "fast", plannerProfile: "default", transport: "hermes_replay_recovery", recoveryReason: "test", now: "2026-07-12T00:00:00.000Z" });
  store.appendWorkflowEvent({ sessionId: "session-1", kind: "workflow.lane.declared", source: "test", idempotencyKey: "lane:implementation", payload: { lane: { id: "lane-implementation", semanticKey: "lane-implementation", kind: "implementation", title: "Implement", agentKind: "codex", status: "pending" } }, now: "2026-07-12T00:00:01.000Z" });
  store.scheduleReadyLanes("session-1", { allowedParallelism: 1, now: "2026-07-12T00:00:02.000Z" });
  return store;
}

function seedPlannerStore(projectRoot) {
  const store = createWorkflowStore({ projectRoot });
  store.createWorkflowSession({
    id: "session-1",
    projectId: "project-1",
    title: "Planner run",
    goal: "Plan two turns",
    mode: "fast",
    plannerProfile: "default",
    transport: "hermes_replay_recovery",
    recoveryReason: "test",
    now: "2026-07-13T01:00:00.000Z",
  });
  return store;
}

function plannerRunInput(projectRoot, runId) {
  return {
    protocolVersion: 1,
    projectRoot,
    sessionId: "session-1",
    nodeId: "node-1",
    runId,
    agentKind: "hermes",
    worktreePath: projectRoot,
    plannerSessionId: "hermes-session-1",
    plannerInputId: runId,
    prompt: `Plan ${runId}`,
  };
}

function terminalPlannerEvidence(runId, completedAt) {
  return {
    runId,
    status: "succeeded",
    exitCode: 0,
    changesetId: null,
    checks: [{ kind: "run-exit", name: "Hermes CLI exit", status: "passed" }],
    artifacts: [],
    review: null,
    errorReason: null,
    cancelReason: null,
    completedAt,
  };
}

function segmentStatus(store) {
  return store.materializeFlowProjection("session-1").segments.find((segment) => segment.id === "segment-session-1-lane-implementation")?.status;
}
