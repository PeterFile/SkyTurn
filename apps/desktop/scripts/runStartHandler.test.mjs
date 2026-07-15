import assert from "node:assert/strict";
import { chmod, lstat, mkdir, mkdtemp, open, readFile, realpath, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { after } from "node:test";

import {
  AgentBridge as ProductionAgentBridge,
  assertExpectedArtifactVerifierCapability,
  createAgentRunStartFingerprint,
  createDurableRunClaimStore,
} from "../../../packages/agent-bridge/dist/index.js";
import { createWorkflowStore } from "../../../packages/persistence/dist/workflowStore.js";
import { createRunStartHandler } from "../dist-electron/electron/runStartHandler.js";
import {
  authorizeRunStartExpectedArtifacts,
  isTrustedPlannerRootStartInput,
} from "../dist-electron/electron/workflowIpcContracts.js";
import { compensateFailedWorkflowRun, recoverTerminalWorkflowRuns } from "../dist-electron/electron/workflowRunRecovery.js";

const previousStateHome = process.env.SKYTURN_STATE_HOME;
const testStateHome = await mkdtemp(join(tmpdir(), "skyturn-run-start-state-"));
const testClaimStore = createDurableRunClaimStore({ root: join(testStateHome, "run-claims") });
process.env.SKYTURN_STATE_HOME = testStateHome;

class AgentBridge extends ProductionAgentBridge {
  constructor(options = {}) {
    super({ durableRunClaimStore: testClaimStore, ...options });
  }
}

after(async () => {
  if (previousStateHome === undefined) delete process.env.SKYTURN_STATE_HOME;
  else process.env.SKYTURN_STATE_HOME = previousStateHome;
  await rm(testStateHome, { recursive: true, force: true });
});

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
          return [{
            protocolVersion: 1,
            runId,
            seq: 1,
            timestamp: `2026-07-13T01:0${index}:02.000Z`,
            kind: "output",
            payload: { text: `Planner turn ${index + 1} completed.` },
          }];
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

test("run:start rejects an unavailable artifact verifier before identity, store, checkpoint, claim, or adapter side effects", async () => {
  const calls = [];
  const input = runInput("C:\\project");
  input.expectedArtifacts = [".devflow/acceptance/react-app.png"];
  const handler = createRunStartHandler({
    preAuthorizeStart: async () => {
      calls.push("capability");
      throw new Error("Windows expected-artifact verifier capability is unavailable.");
    },
    authorizeStartInput: async (value) => {
      calls.push("authorize");
      return value;
    },
    resolveIdentity: async () => {
      calls.push("identity");
      return identityFromRunInput(input);
    },
    acquireStore: async () => {
      calls.push("store");
      return { listRunningSegments: () => [] };
    },
    reopenStore: async () => ({ listRunningSegments: () => [] }),
    assertStartInput: async () => calls.push("validate"),
    claimUnscheduledStart: async () => {
      calls.push("claim");
      return null;
    },
    prepareBeforeCheckpoint: async () => {
      calls.push("checkpoint");
      return true;
    },
    startRun: async () => {
      calls.push("start");
      return { id: input.runId };
    },
    reconcileTerminal: async () => {},
    compensateTerminal: () => {},
    enrichAfterCheckpoint: async () => {},
    recordBeforeCheckpointFailure: () => {},
    recordAfterCheckpointFailure: () => {},
  });

  await assert.rejects(handler(input), /Windows expected-artifact verifier capability is unavailable/);
  assert.deepEqual(calls, ["capability"]);
});

for (const agentKind of ["codex", "hermes"]) {
  test(`desktop run:start rejects null ${agentKind} artifacts before capability-dependent side effects`, async () => {
    const calls = [];
    const input = runInput("C:\\project");
    input.agentKind = agentKind;
    input.expectedArtifacts = null;
    const handler = desktopArtifactCapabilityHandler(input, calls);

    await assert.rejects(handler(input), /expectedArtifacts declaration is invalid/i);
    assert.deepEqual(calls, []);
  });

  for (const declaration of ["omitted", "empty"]) {
    test(`desktop run:start lets an ordinary ${agentKind} lane with ${declaration} artifacts bypass an unavailable Windows helper`, async () => {
      const calls = [];
      const input = runInput("C:\\project");
      input.agentKind = agentKind;
      if (declaration === "omitted") delete input.expectedArtifacts;
      else input.expectedArtifacts = [];
      const handler = desktopArtifactCapabilityHandler(input, calls);

      const result = await withProcessPlatform("win32", () => handler(input));

      assert.deepEqual(result, { id: input.runId });
      assert.deepEqual(calls, ["identity", "store", "validate", "claim", "checkpoint", "start"]);
    });
  }

  test(`desktop run:start rejects a ${agentKind} artifact lane before store, claim, checkpoint, or CLI when the Windows helper is unavailable`, async () => {
    const calls = [];
    const input = runInput("C:\\project");
    input.agentKind = agentKind;
    const handler = desktopArtifactCapabilityHandler(input, calls);

    await withProcessPlatform("win32", async () => {
      await assert.rejects(handler(input), /Windows expected-artifact verifier capability is unavailable/);
    });
    assert.deepEqual(calls, []);
  });
}

test("desktop main passes the raw expectedArtifacts field into capability preauthorization", async () => {
  const source = await readFile(new URL("../electron/main.ts", import.meta.url), "utf8");
  const preauthorization = source.match(/preAuthorizeStart:[\s\S]*?authorizeStartInput:/)?.[0];
  assert.ok(preauthorization);
  assert.match(preauthorization, /preAuthorizeStart:\s*async \(input\)/);
  assert.match(preauthorization, /assertExpectedArtifactVerifierCapability\(input\.expectedArtifacts\)/);
  assert.doesNotMatch(preauthorization, /assertExpectedArtifactVerifierCapability\(\)/);
});

for (const agentKind of ["codex", "hermes"]) {
  for (const [caseName, expectedArtifacts] of [
    ["omission", undefined],
    ["mismatch", [".devflow/acceptance/other.png"]],
    ["extra", [".devflow/acceptance/react-app.png", ".devflow/acceptance/other.png"]],
    ["traversal", [".devflow/acceptance/nested/../react-app.png"]],
    ["service-account backup", [".devflow/acceptance/service-account.json.backup"]],
    ["service-account chained backup", [".devflow/acceptance/service-account.json.backup.txt"]],
    ["service-account canonical alias", [".devflow/acceptance/SERVICE._-ACCOUNT--JSON__COPY.tar.gz"]],
    ["service-account Unicode space alias", [".devflow/acceptance/service account.json.backup.txt"]],
    ["service-account fullwidth dot alias", [".devflow/acceptance/service．account.json.orig.1"]],
    ["service-account Unicode dash alias", [".devflow/acceptance/service—account.JSON.backup"]],
    ["service-account separatorless alias", [".devflow/acceptance/serviceaccount.json.orig.1"]],
    ["service-account credential JSON report suffix", [".devflow/acceptance/service-account.json.report.json"]],
    ["case-fold duplicate", [
      ".devflow/acceptance/react-app.png",
      ".devflow/acceptance/REACT-APP.PNG",
    ]],
  ]) {
    test(`run:start rejects ${agentKind} artifact ${caseName} before checkpoint, durable claim, or adapter start`, async () => {
      const root = await mkdtemp(join(tmpdir(), "skyturn-authoritative-artifact-start-"));
      let store;
      try {
        store = agentKind === "codex"
          ? seedBrowserRunStore(root, [])
          : seedArtifactRunStore(root, agentKind, ["browser", "screenshot"]);
        const contracts = await import("../dist-electron/electron/workflowIpcContracts.js");
        assert.equal(typeof contracts.authorizeRunStartExpectedArtifacts, "function");
        const eventCount = store.listEvents("session-artifact").length;
        let checkpoints = 0;
        let adapterStarts = 0;
        const bridge = new AgentBridge({
          adapters: [{
            kind: agentKind,
            async detect() {
              throw new Error("Discovery is not part of this test.");
            },
            async startRun() {
              adapterStarts += 1;
              return { async cancel() {} };
            },
          }],
        });
        const input = artifactRunInput(root, agentKind, expectedArtifacts);
        const handler = createRunStartHandler({
          authorizeStartInput: async (startInput) => contracts.authorizeRunStartExpectedArtifacts(startInput, store),
          resolveIdentity: identityFromRunInput,
          acquireStore: async () => store,
          reopenStore: async () => createWorkflowStore({ projectRoot: root }),
          assertStartInput: async () => {},
          prepareBeforeCheckpoint: async () => {
            checkpoints += 1;
            return true;
          },
          startRun: (startInput) => bridge.startRun(startInput),
          reconcileTerminal: async () => {},
          compensateTerminal: () => {},
          enrichAfterCheckpoint: async () => {},
          recordBeforeCheckpointFailure: () => {},
          recordAfterCheckpointFailure: () => {},
        });

        await assert.rejects(handler(input), (error) => {
          assert.match(String(error), /expected artifact/i);
          const submittedArtifacts = expectedArtifacts === undefined ? [] : expectedArtifacts;
          assert.ok(Array.isArray(submittedArtifacts));
          for (const artifact of submittedArtifacts) {
            assert.ok(!String(error).includes(artifact));
          }
          return true;
        });
        assert.equal(checkpoints, 0);
        assert.equal(adapterStarts, 0);
        assert.equal(store.listEvents("session-artifact").length, eventCount);
        await assert.rejects(
          stat(await testClaimStore.markerPath(root, input.runId)),
          /ENOENT/,
        );
      } finally {
        store?.close();
        await rm(root, { recursive: true, force: true });
      }
    });
  }

  test(`run:start rejects generic ${agentKind} artifact evidence without a backend-approved declaration`, async () => {
    const root = await mkdtemp(join(tmpdir(), "skyturn-generic-artifact-start-"));
    let store;
    try {
      store = seedArtifactRunStore(root, agentKind, ["artifact"]);
      const contracts = await import("../dist-electron/electron/workflowIpcContracts.js");
      assert.equal(typeof contracts.authorizeRunStartExpectedArtifacts, "function");
      let checkpoints = 0;
      let adapterStarts = 0;
      const bridge = new AgentBridge({
        adapters: [{
          kind: agentKind,
          async detect() {
            throw new Error("Discovery is not part of this test.");
          },
          async startRun() {
            adapterStarts += 1;
            return { async cancel() {} };
          },
        }],
      });
      const input = artifactRunInput(root, agentKind, [".devflow/acceptance/react-app.png"]);
      const handler = createRunStartHandler({
        authorizeStartInput: async (startInput) => contracts.authorizeRunStartExpectedArtifacts(startInput, store),
        resolveIdentity: identityFromRunInput,
        acquireStore: async () => store,
        reopenStore: async () => createWorkflowStore({ projectRoot: root }),
        assertStartInput: async () => {},
        prepareBeforeCheckpoint: async () => {
          checkpoints += 1;
          return true;
        },
        startRun: (startInput) => bridge.startRun(startInput),
        reconcileTerminal: async () => {},
        compensateTerminal: () => {},
        enrichAfterCheckpoint: async () => {},
        recordBeforeCheckpointFailure: () => {},
        recordAfterCheckpointFailure: () => {},
      });

      await assert.rejects(handler(input), /concrete.*expected artifact|backend-approved/i);
      assert.equal(checkpoints, 0);
      assert.equal(adapterStarts, 0);
      await assert.rejects(stat(await testClaimStore.markerPath(root, input.runId)), /ENOENT/);
    } finally {
      store?.close();
      await rm(root, { recursive: true, force: true });
    }
  });

  test(`run:start gives ${agentKind} the canonical backend browser declaration and one shared fingerprint`, async () => {
    const root = await mkdtemp(join(tmpdir(), "skyturn-browser-artifact-start-"));
    let store;
    try {
      store = seedArtifactRunStore(root, agentKind, ["screenshot"]);
      const contracts = await import("../dist-electron/electron/workflowIpcContracts.js");
      assert.equal(typeof contracts.authorizeRunStartExpectedArtifacts, "function");
      let checkpoints = 0;
      let adapterInput;
      let durableFingerprint;
      const bridge = new AgentBridge({
        adapters: [{
          kind: agentKind,
          async detect() {
            throw new Error("Discovery is not part of this test.");
          },
          async startRun(startInput) {
            adapterInput = startInput;
            const claim = JSON.parse(await readFile(
              await testClaimStore.markerPath(root, startInput.runId),
              "utf8",
            ));
            durableFingerprint = claim.startFingerprint;
            return { async cancel() {} };
          },
        }],
      });
      const scheduledRunId = store.listRunningSegments().find((segment) => segment.laneId === "lane-artifact")?.runId;
      assert.ok(scheduledRunId);
      const input = {
        ...artifactRunInput(root, agentKind, [".devflow/acceptance/REACT-APP.PNG"]),
        runId: scheduledRunId,
      };
      let handlerFingerprint;
      const handler = createRunStartHandler({
        authorizeStartInput: async (startInput) => contracts.authorizeRunStartExpectedArtifacts(startInput, store),
        resolveIdentity: (startInput) => {
          const identity = productionIdentityFromRunInput(startInput);
          handlerFingerprint = identity.startFingerprint;
          return identity;
        },
        acquireStore: async () => store,
        reopenStore: async () => createWorkflowStore({ projectRoot: root }),
        assertStartInput: async () => {},
        prepareBeforeCheckpoint: async () => {
          checkpoints += 1;
          return true;
        },
        startRun: (startInput) => bridge.startRun(startInput),
        reconcileTerminal: async () => {},
        compensateTerminal: () => {},
        enrichAfterCheckpoint: async () => {},
        recordBeforeCheckpointFailure: () => {},
        recordAfterCheckpointFailure: () => {},
      });

      await handler(input);
      assert.equal(checkpoints, 1);
      assert.deepEqual(adapterInput.expectedArtifacts, [".devflow/acceptance/react-app.png"]);
      assert.equal(handlerFingerprint, createAgentRunStartFingerprint(adapterInput));
      assert.equal(durableFingerprint, handlerFingerprint);
    } finally {
      store?.close();
      await rm(root, { recursive: true, force: true });
    }
  });
}

for (const evidenceInput of [
  { caseName: "omitted", requiredEvidence: undefined },
  { caseName: "empty", requiredEvidence: [] },
]) {
  test(`run:start rejects a browser lane with ${evidenceInput.caseName} evidence and no declaration before side effects`, async () => {
    const root = await mkdtemp(join(tmpdir(), "skyturn-derived-browser-start-"));
    let store;
    try {
      store = seedBrowserRunStore(root, evidenceInput.requiredEvidence);
      const contracts = await import("../dist-electron/electron/workflowIpcContracts.js");
      const eventCount = store.listEvents("session-artifact").length;
      let checkpoints = 0;
      let adapterStarts = 0;
      const bridge = new AgentBridge({
        adapters: [{
          kind: "codex",
          async detect() {
            throw new Error("Discovery is not part of this test.");
          },
          async startRun() {
            adapterStarts += 1;
            return { async cancel() {} };
          },
        }],
      });
      const scheduledRunId = store.listRunningSegments().find((segment) => segment.laneId === "lane-artifact")?.runId;
      assert.ok(scheduledRunId);
      const input = {
        ...artifactRunInput(root, "codex", undefined),
        runId: scheduledRunId,
      };
      const handler = createRunStartHandler({
        authorizeStartInput: async (startInput) => contracts.authorizeRunStartExpectedArtifacts(startInput, store),
        resolveIdentity: identityFromRunInput,
        acquireStore: async () => store,
        reopenStore: async () => createWorkflowStore({ projectRoot: root }),
        assertStartInput: async () => {},
        prepareBeforeCheckpoint: async () => {
          checkpoints += 1;
          return true;
        },
        startRun: (startInput) => bridge.startRun(startInput),
        reconcileTerminal: async () => {},
        compensateTerminal: () => {},
        enrichAfterCheckpoint: async () => {},
        recordBeforeCheckpointFailure: () => {},
        recordAfterCheckpointFailure: () => {},
      });

      await assert.rejects(handler(input), /expected artifact/i);
      assert.equal(checkpoints, 0);
      assert.equal(adapterStarts, 0);
      assert.equal(store.listEvents("session-artifact").length, eventCount);
      await assert.rejects(stat(await testClaimStore.markerPath(root, input.runId)), /ENOENT/);
    } finally {
      store?.close();
      await rm(root, { recursive: true, force: true });
    }
  });
}

test("run:start authorizes only the fixed declaration derived from an omitted browser evidence contract", async () => {
  const root = await mkdtemp(join(tmpdir(), "skyturn-derived-browser-fixed-start-"));
  let store;
  try {
    store = seedBrowserRunStore(root, undefined);
    const contracts = await import("../dist-electron/electron/workflowIpcContracts.js");
    let adapterInput;
    const scheduledRunId = store.listRunningSegments().find((segment) => segment.laneId === "lane-artifact")?.runId;
    assert.ok(scheduledRunId);
    const bridge = new AgentBridge({
      adapters: [{
        kind: "codex",
        async detect() {
          throw new Error("Discovery is not part of this test.");
        },
        async startRun(input) {
          adapterInput = input;
          return { async cancel() {} };
        },
      }],
    });
    const input = {
      ...artifactRunInput(root, "codex", [".devflow/acceptance/REACT-APP.PNG"]),
      runId: scheduledRunId,
    };
    const handler = createRunStartHandler({
      authorizeStartInput: async (startInput) => contracts.authorizeRunStartExpectedArtifacts(startInput, store),
      resolveIdentity: identityFromRunInput,
      acquireStore: async () => store,
      reopenStore: async () => createWorkflowStore({ projectRoot: root }),
      assertStartInput: async () => {},
      prepareBeforeCheckpoint: async () => true,
      startRun: (startInput) => bridge.startRun(startInput),
      reconcileTerminal: async () => {},
      compensateTerminal: () => {},
      enrichAfterCheckpoint: async () => {},
      recordBeforeCheckpointFailure: () => {},
      recordAfterCheckpointFailure: () => {},
    });

    await handler(input);
    assert.deepEqual(adapterInput.expectedArtifacts, [".devflow/acceptance/react-app.png"]);
  } finally {
    store?.close();
    await rm(root, { recursive: true, force: true });
  }
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

test("run:start keeps the owned internal cause for compensation but sanitizes the public rejection", async () => {
  const root = await mkdtemp(join(tmpdir(), "skyturn-run-start-public-error-"));
  const rawCause = "Bearer ipc-secret path=/Users/alice/private password=hunter2";
  let compensatedError;
  let activeStore;
  try {
    seedRunningStore(root).close();
    const handler = createRunStartHandler({
      resolveIdentity: () => identity(root),
      acquireStore: async () => {
        activeStore = createWorkflowStore({ projectRoot: root });
        return activeStore;
      },
      reopenStore: async () => createWorkflowStore({ projectRoot: root }),
      assertStartInput: async () => {},
      prepareBeforeCheckpoint: async () => true,
      startRun: async () => { throw ownedStartError(rawCause); },
      reconcileTerminal: async () => { throw new Error("no bridge evidence"); },
      compensateTerminal: (store, segment, error) => {
        compensatedError = error;
        compensateFailedWorkflowRun(store, segment, error, () => "2026-07-12T00:00:04.000Z");
      },
      enrichAfterCheckpoint: async () => {},
      recordBeforeCheckpointFailure: () => {},
      recordAfterCheckpointFailure: () => {},
    });

    await assert.rejects(handler(runInput(root)), (error) => {
      assert.equal(error.durableRunClaimOwned, true);
      assert.doesNotMatch(String(error), /ipc-secret|alice|hunter2/);
      return true;
    });
    assert.equal(compensatedError.message, rawCause);
  } finally {
    activeStore?.close();
    await rm(root, { recursive: true, force: true });
  }
});

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
          await mkdir(runDirectory, { recursive: true });
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
    assert.equal(failure?.cause, undefined);
    assert.equal(failure?.terminalPersistenceError, undefined);
    assert.equal(injectedAppendAttempts, 2);
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
    await assert.rejects(restartedBridge.startRun(input), /already terminal|already (active|claimed)|durably claimed/i);
    assert.equal(adapterStarts, 1);
    assert.equal(restartStarts, 0);
  } finally {
    activeStore?.close();
    await rm(root, { recursive: true, force: true });
  }
});

for (const fault of ["crash-before-content", "write", "fsync", "close"]) {
  test(`run:start awaits one compensation after owned durable claim ${fault} failure`, async () => {
    const root = await mkdtemp(join(tmpdir(), `skyturn-run-start-${fault}-`));
    const claimRoot = join(testStateHome, `fault-${fault}`);
    const durableRunClaimStore = createDurableRunClaimStore({
      root: claimRoot,
      fileSystem: faultingClaimFileSystem(fault),
    });
    const input = { protocolVersion: 1, ...runInput(root) };
    let activeStore;
    let adapterStarts = 0;
    let reconciliations = 0;
    let compensations = 0;
    try {
      seedRunningStore(root).close();
      const bridge = new AgentBridge({
        durableRunClaimStore,
        adapters: [{
          kind: "codex",
          async detect() {
            throw new Error("Discovery is not part of this test.");
          },
          async startRun() {
            adapterStarts += 1;
            return { async cancel() {} };
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
          reconciliations += 1;
          throw new Error("Publication failure has no authoritative terminal event.");
        },
        compensateTerminal: (store, segment, error) => {
          compensations += 1;
          compensateFailedWorkflowRun(store, segment, error, () => "2026-07-15T01:00:00.000Z");
        },
        enrichAfterCheckpoint: async () => {},
        recordBeforeCheckpointFailure: () => {},
        recordAfterCheckpointFailure: () => {},
      });

      await assert.rejects(handler(input), (error) => error?.durableRunClaimOwned === true);
      assert.equal(adapterStarts, 0);
      assert.equal(reconciliations, 1);
      assert.equal(compensations, 1);
      assert.equal(activeStore.listRunningSegments().length, 0);
      activeStore.close();
      activeStore = undefined;

      const marker = await durableRunClaimStore.read(root, input.runId);
      assert.equal(marker.kind, fault === "fsync" || fault === "close" ? "valid" : "invalid");
      const reopened = createWorkflowStore({ projectRoot: root });
      assert.equal(reopened.listRunningSegments().length, 0);
      assert.equal(segmentStatus(reopened), "failed");
      reopened.close();

      let restartStarts = 0;
      const restarted = new AgentBridge({
        durableRunClaimStore: createDurableRunClaimStore({ root: claimRoot }),
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
      await assert.rejects(restarted.startRun(input), /run-start-claim-invalid|already terminal|durably claimed/i);
      assert.equal(restartStarts, 0);
      assert.equal(restarted.listRuns().some((run) => run.status === "running"), false);
    } finally {
      activeStore?.close();
      await rm(root, { recursive: true, force: true });
    }
  });
}

function faultingClaimFileSystem(fault) {
  return {
    realpath,
    mkdir,
    chmod,
    lstat,
    async open(path, flags, mode) {
      const handle = await open(path, flags, mode);
      if (flags !== "wx") return handle;
      const overrides = {
        async writeFile(data) {
          if (fault === "crash-before-content") throw new Error("simulated parent crash");
          if (fault === "write") {
            const bytes = Buffer.from(data);
            await handle.writeFile(bytes.subarray(0, Math.max(1, Math.floor(bytes.length / 2))));
            throw new Error("injected write failure");
          }
          await handle.writeFile(data);
        },
        async sync() {
          if (fault === "fsync") throw new Error("injected fsync failure");
          await handle.sync();
        },
        async close() {
          await handle.close();
          if (fault === "close") throw new Error("injected close failure");
        },
      };
      return new Proxy(handle, {
        get(target, property, receiver) {
          if (Object.hasOwn(overrides, property)) return overrides[property];
          const value = Reflect.get(target, property, receiver);
          return typeof value === "function" ? value.bind(target) : value;
        },
      });
    },
  };
}

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

function desktopArtifactCapabilityHandler(input, calls) {
  const segment = {
    sessionId: input.sessionId,
    laneId: input.nodeId,
    segmentId: `segment-${input.sessionId}-${input.nodeId}`,
    runId: input.runId,
    agentKind: input.agentKind,
  };
  const store = { listRunningSegments: () => [segment] };
  return createRunStartHandler({
    preAuthorizeStart: (value) => assertExpectedArtifactVerifierCapability(value.expectedArtifacts),
    resolveIdentity: async (value) => {
      calls.push("identity");
      return identityFromRunInput(value);
    },
    acquireStore: async () => {
      calls.push("store");
      return store;
    },
    reopenStore: async () => store,
    assertStartInput: async () => calls.push("validate"),
    claimUnscheduledStart: async () => {
      calls.push("claim");
      return null;
    },
    prepareBeforeCheckpoint: async () => {
      calls.push("checkpoint");
      return true;
    },
    startRun: async () => {
      calls.push("start");
      return { id: input.runId };
    },
    reconcileTerminal: async () => {},
    compensateTerminal: () => {},
    enrichAfterCheckpoint: async () => {},
    recordBeforeCheckpointFailure: () => {},
    recordAfterCheckpointFailure: () => {},
  });
}

async function withProcessPlatform(platform, operation) {
  const descriptor = Object.getOwnPropertyDescriptor(process, "platform");
  Object.defineProperty(process, "platform", { ...descriptor, value: platform });
  try {
    return await operation();
  } finally {
    if (descriptor) Object.defineProperty(process, "platform", descriptor);
  }
}

test("backend expected-artifact authorization rejects null for an ordinary lane", async () => {
  const root = await mkdtemp(join(tmpdir(), "skyturn-null-artifact-authorization-"));
  let store;
  try {
    store = seedRunningStore(root);
    await assert.rejects(
      authorizeRunStartExpectedArtifacts({ ...runInput(root), expectedArtifacts: null }, store),
      /Expected artifact declarations are invalid/i,
    );
  } finally {
    store?.close();
    await rm(root, { recursive: true, force: true });
  }
});

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

function productionIdentityFromRunInput(input) {
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
    startFingerprint: createAgentRunStartFingerprint(input),
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
    expectedArtifacts: input.expectedArtifacts === undefined ? [] : input.expectedArtifacts,
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

function seedArtifactRunStore(projectRoot, agentKind, requiredEvidence) {
  const store = createWorkflowStore({ projectRoot });
  store.createWorkflowSession({
    id: "session-artifact",
    projectId: "project-1",
    title: "Artifact run",
    goal: "Verify an artifact",
    mode: "fast",
    plannerProfile: "default",
    transport: "hermes_replay_recovery",
    recoveryReason: "test",
    now: "2026-07-14T00:00:00.000Z",
  });
  store.appendWorkflowEvent({
    sessionId: "session-artifact",
    kind: "workflow.lane.declared",
    source: "test",
    idempotencyKey: "lane:artifact",
    payload: {
      lane: {
        id: "lane-artifact",
        semanticKey: "lane-artifact",
        kind: "validation",
        title: "Validate artifact",
        agentKind,
        status: "pending",
        requiredEvidence,
      },
    },
    now: "2026-07-14T00:00:01.000Z",
  });
  store.scheduleReadyLanes("session-artifact", {
    allowedParallelism: 1,
    now: "2026-07-14T00:00:02.000Z",
  });
  return store;
}

function seedBrowserRunStore(projectRoot, requiredEvidence) {
  const store = createWorkflowStore({ projectRoot });
  store.createWorkflowSession({
    id: "session-artifact",
    projectId: "project-1",
    title: "Browser artifact run",
    goal: "Verify a browser screenshot",
    mode: "fast",
    plannerProfile: "default",
    transport: "hermes_replay_recovery",
    recoveryReason: "test",
    now: "2026-07-14T00:00:00.000Z",
  });
  store.appendWorkflowEvent({
    sessionId: "session-artifact",
    kind: "workflow.lane.declared",
    source: "legacy-test",
    idempotencyKey: "lane:artifact",
    payload: {
      lane: {
        id: "lane-artifact",
        semanticKey: "lane-artifact",
        kind: "browser_validation",
        title: "Capture browser screenshot",
        agentKind: "codex",
        status: "pending",
        ...(requiredEvidence === undefined ? {} : { requiredEvidence }),
      },
    },
    now: "2026-07-14T00:00:01.000Z",
  });
  store.scheduleReadyLanes("session-artifact", {
    allowedParallelism: 1,
    now: "2026-07-14T00:00:02.000Z",
  });
  return store;
}

function artifactRunInput(projectRoot, agentKind, expectedArtifacts) {
  return {
    protocolVersion: 1,
    projectRoot,
    sessionId: "session-artifact",
    nodeId: "lane-artifact",
    runId: `run-${agentKind}-artifact`,
    agentKind,
    worktreePath: projectRoot,
    sandbox: agentKind === "codex" ? "read-only" : undefined,
    ...(expectedArtifacts === undefined ? {} : { expectedArtifacts }),
    prompt: "Verify the scheduled artifact lane",
  };
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
