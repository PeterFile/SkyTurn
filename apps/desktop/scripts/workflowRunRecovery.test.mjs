import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { appendFile, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import vm from "node:vm";

import { AgentBridge, RUN_EVENT_PROTOCOL_VERSION, createMockAgentAdapter } from "@skyturn/agent-bridge";
import { createWorkflowStore } from "@skyturn/persistence/workflow-store";

import { compensateFailedWorkflowRun, recoverTerminalWorkflowRuns } from "../dist-electron/electron/workflowRunRecovery.js";

const require = createRequire(import.meta.url);

for (const status of ["succeeded", "failed", "cancelled", "timed-out"]) {
  test(`restart recovery persists ${status} agent-bridge disk evidence exactly once`, async () => {
    const root = await makeRoot();
    try {
      const store = seedRunningStore(root);
      store.close();
      const bridge = bridgeForTerminalStatus(status);
      await bridge.startRun(runInput(root));

      const reopened = createWorkflowStore({ projectRoot: root });
      await recoverTerminalWorkflowRuns(root, reopened, bridge, () => "recovered output");
      await recoverTerminalWorkflowRuns(root, reopened, bridge, () => "duplicate output");

      assert.equal(reopened.listRunningSegments().length, 0);
      assert.equal(segmentStatus(reopened), status);
      assert.equal(reopened.listEvents("session-1").filter((event) => event.kind === "workflow.segment.finished").length, 1);
      reopened.close();
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
}

test("restart recovery replays after enrichment idempotently and makes a failed run repairable", async () => {
  const root = await makeRoot();
  try {
    const store = seedRunningStore(root);
    const segment = store.listRunningSegments()[0];
    assert.ok(segment);
    const before = checkpointInput(root, segment, "before");
    store.recordRunCheckpoint(before);
    store.recordRunResult(runResult(segment, "failed"));
    store.close();

    for (let restart = 0; restart < 2; restart += 1) {
      const reopened = createWorkflowStore({ projectRoot: root });
      await recoverTerminalWorkflowRuns(root, reopened, new AgentBridge({ adapters: [] }), () => "unused", undefined, async (candidate) => {
        reopened.appendWorkflowEvent({
          sessionId: candidate.sessionId,
          kind: "workflow.changeset.evidence_recorded",
          source: "test",
          laneId: candidate.laneId,
          segmentId: candidate.segmentId,
          idempotencyKey: `checkpoint-changeset:${candidate.runId}:after`,
          payload: { evidence: { evidenceId: `changeset-evidence:${candidate.runId}:after`, status: "available" } },
          now: "2026-06-14T00:00:05.000Z",
        });
        reopened.recordRunCheckpoint({
          ...checkpointInput(root, candidate, "after"),
          evidenceRefs: [
            { kind: "run", id: candidate.runId },
            { kind: "segment", id: candidate.segmentId },
            { kind: "changeset", id: `changeset-evidence:${candidate.runId}:after` },
            { kind: "evidence", id: `evidence-${candidate.segmentId}` },
          ],
        });
      });
      assert.equal(reopened.materializeFlowProjection("session-1").checkpoints.filter((item) => item.phase === "after").length, 1);
      assert.doesNotThrow(() => reopened.requestNodeRepair({
        sessionId: "session-1",
        laneId: "lane-implementation",
        checkpointId: `checkpoint:${segment.runId}:after`,
        now: "2026-06-14T00:00:06.000Z",
      }));
      reopened.close();
    }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("getWorkflowStore completes pending checkpoint enrichment without waiting on its own recovery", { timeout: 10_000 }, async () => {
  const root = await makeRoot();
  try {
    const store = seedRunningStore(root);
    const segment = store.listRunningSegments()[0];
    assert.ok(segment);
    store.recordRunCheckpoint(checkpointInput(root, segment, "before"));
    store.recordRunResult(runResult(segment, "succeeded"));
    store.close();

    const harness = await loadMainWorkflowStoreHarness();
    const recovered = await withTimeout(
      harness.getWorkflowStore(root),
      500,
      "getWorkflowStore pending enrichment timed out",
    );

    assert.equal(harness.resolverReceivedKnownStore(), true);
    assert.equal(recovered.listNodeCheckpoints({
      sessionId: segment.sessionId,
      runId: segment.runId,
      phase: "after",
    }).length, 1);
    harness.closeWorkflowStores();
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("concurrent getWorkflowStore callers share one unpublished recovery barrier", { timeout: 10_000 }, async () => {
  const root = await makeRoot();
  const storeCreated = deferred();
  const bridgeRelease = deferred();
  const recoveryEntered = deferred();
  const recoveryRelease = deferred();
  let first;
  let second;
  let harness;
  let createCount = 0;
  try {
    const seed = seedRunningStore(root);
    const segment = seed.listRunningSegments()[0];
    assert.ok(segment);
    seed.close();
    harness = await loadMainWorkflowStoreHarness({
      onStoreCreated() {
        createCount += 1;
        storeCreated.resolve();
      },
      async getAgentBridge() {
        await bridgeRelease.promise;
        return {
          async getEvidence() {
            recoveryEntered.resolve();
            await recoveryRelease.promise;
            return runResult(segment, "succeeded").evidence;
          },
          async loadEvents() {
            return [];
          },
        };
      },
    });

    let firstResolved = false;
    let secondResolved = false;
    first = harness.getWorkflowStore(root).then((store) => {
      firstResolved = true;
      return store;
    });
    await storeCreated.promise;
    second = harness.getWorkflowStore(root).then((store) => {
      secondResolved = true;
      return store;
    });
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(firstResolved, false);
    assert.equal(secondResolved, false);
    assert.equal(harness.hasPublishedStore(root), false);

    bridgeRelease.resolve();
    await recoveryEntered.promise;
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(firstResolved, false);
    assert.equal(secondResolved, false);
    assert.equal(harness.hasPublishedStore(root), false);

    recoveryRelease.resolve();
    const [firstStore, secondStore] = await Promise.all([first, second]);
    assert.strictEqual(firstStore, secondStore);
    assert.equal(createCount, 1);
    assert.strictEqual(harness.hasPublishedStore(root), firstStore);
    assert.equal(firstStore.listRunningSegments().length, 0);
    assert.equal(segmentStatus(firstStore), "succeeded");
  } finally {
    bridgeRelease.resolve();
    recoveryRelease.resolve();
    await Promise.allSettled([first, second].filter(Boolean));
    harness?.closeWorkflowStores();
    await rm(root, { recursive: true, force: true });
  }
});

test("failed getWorkflowStore initialization closes partial state and permits a clean retry", async () => {
  const root = await makeRoot();
  let bridgeAttempts = 0;
  let createCount = 0;
  let closeCount = 0;
  const harness = await loadMainWorkflowStoreHarness({
    onStoreCreated(store) {
      createCount += 1;
      const close = store.close.bind(store);
      store.close = () => {
        closeCount += 1;
        close();
      };
    },
    async getAgentBridge() {
      bridgeAttempts += 1;
      if (bridgeAttempts === 1) throw new Error("bridge initialization failed");
      return {
        async getEvidence() {
          return null;
        },
        async loadEvents() {
          return [];
        },
      };
    },
  });
  try {
    await assert.rejects(harness.getWorkflowStore(root), /bridge initialization failed/);
    assert.equal(createCount, 1);
    assert.equal(closeCount, 1);
    assert.equal(harness.hasPublishedStore(root), false);

    const recovered = await harness.getWorkflowStore(root);
    assert.equal(createCount, 2);
    assert.strictEqual(harness.hasPublishedStore(root), recovered);
  } finally {
    harness.closeWorkflowStores();
    assert.equal(closeCount, 2);
    await rm(root, { recursive: true, force: true });
  }
});

for (const mode of ["same-process", "concurrent", "reopened"]) {
  test(`changeset evidence accepts semantically equal ${mode} duplicate enrichment`, async () => {
    const root = await makeRoot();
    try {
      const recordRunChangesetEvidence = await loadMainChangesetEvidenceRecorder();
      let store = seedRunningStore(root);
      const identity = {
        sessionId: "session-1",
        laneId: "lane-implementation",
        segmentId: "segment-session-1-lane-implementation",
        runId: "run-session-1-lane-implementation",
      };
      const first = changesetEvidence("normal-order");
      const duplicate = changesetEvidence("reordered");

      if (mode === "concurrent") {
        await Promise.all([
          Promise.resolve().then(() => recordRunChangesetEvidence(store, identity, "after", first)),
          Promise.resolve().then(() => recordRunChangesetEvidence(store, identity, "after", duplicate)),
        ]);
      } else {
        recordRunChangesetEvidence(store, identity, "after", first);
        if (mode === "reopened") {
          store.close();
          store = createWorkflowStore({ projectRoot: root });
        }
        recordRunChangesetEvidence(store, identity, "after", duplicate);
      }

      assert.equal(store.listEvents("session-1").filter((event) =>
        event.kind === "workflow.changeset.evidence_recorded"
      ).length, 1);
      store.close();
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
}

test("restart recovery persists retryable after-enrichment failure and retries it after another restart", async () => {
  const root = await makeRoot();
  try {
    const store = seedRunningStore(root);
    const segment = store.listRunningSegments()[0];
    assert.ok(segment);
    store.recordRunCheckpoint(checkpointInput(root, segment, "before"));
    store.recordRunResult(runResult(segment, "succeeded"));
    store.close();

    const failedRestart = createWorkflowStore({ projectRoot: root });
    await recoverTerminalWorkflowRuns(root, failedRestart, new AgentBridge({ adapters: [] }), () => "unused", undefined, async () => {
      throw new Error("git temporarily unavailable");
    });
    assert.equal(failedRestart.listEvents("session-1").filter((event) =>
      event.kind === "workflow.node.checkpoint_failed" && event.payload.retryable === true
    ).length, 1);
    failedRestart.close();

    const retriedRestart = createWorkflowStore({ projectRoot: root });
    await recoverTerminalWorkflowRuns(root, retriedRestart, new AgentBridge({ adapters: [] }), () => "unused", undefined, async (candidate) => {
      retriedRestart.recordRunCheckpoint({
        ...checkpointInput(root, candidate, "after"),
        evidenceRefs: [
          { kind: "run", id: candidate.runId },
          { kind: "segment", id: candidate.segmentId },
          { kind: "evidence", id: `evidence-${candidate.segmentId}` },
        ],
      });
    });
    assert.equal(retriedRestart.materializeFlowProjection("session-1").checkpoints.filter((item) => item.phase === "after").length, 1);
    assert.equal(segmentStatus(retriedRestart), "succeeded");
    retriedRestart.close();
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("restart recovery fails closed for missing, mismatched, and corrupt disk evidence", async () => {
  for (const evidenceCase of ["missing", "mismatched", "corrupt"]) {
    const root = await makeRoot();
    try {
      const store = seedRunningStore(root);
      store.close();
      const bridge = new AgentBridge({ adapters: [] });
      const eventsPath = join(root, ".devflow", "runs", "run-session-1-lane-implementation", "events.ndjson");
      await mkdir(join(root, ".devflow", "runs", "run-session-1-lane-implementation"), { recursive: true });
      if (evidenceCase === "mismatched") {
        await writeFile(eventsPath, `${JSON.stringify({
          protocolVersion: RUN_EVENT_PROTOCOL_VERSION,
          runId: "wrong-run",
          seq: 1,
          timestamp: "2026-06-14T00:00:04.000Z",
          kind: "status",
          payload: { status: "failed", reason: "wrong identity" },
        })}\n`);
      } else if (evidenceCase === "corrupt") {
        await writeFile(eventsPath, "{not-json}\n");
      }

      const reopened = createWorkflowStore({ projectRoot: root });
      await recoverTerminalWorkflowRuns(root, reopened, bridge, () => "must not recover", () => "2026-06-14T00:00:05.000Z");

      assert.equal(reopened.listRunningSegments().length, 1, evidenceCase);
      assert.equal(segmentStatus(reopened), "running", evidenceCase);
      const recoveryFailures = reopened.listEvents("session-1").filter((event) => event.kind === "workflow.run.recovery_failed");
      assert.equal(recoveryFailures.length, evidenceCase === "missing" ? 0 : 1, evidenceCase);
      reopened.close();
      if (evidenceCase !== "missing") assert.ok((await readFile(eventsPath, "utf8")).length > 0);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  }
});

test("missing adapter compensation recovers the scheduled workflow run as failed", async () => {
  const root = await makeRoot();
  try {
    const store = seedRunningStore(root);
    store.close();
    const bridge = new AgentBridge({ adapters: [] });
    await assert.rejects(bridge.startRun({ ...runInput(root), agentKind: "agy" }), /No local adapter registered/);

    const reopened = createWorkflowStore({ projectRoot: root });
    await recoverTerminalWorkflowRuns(root, reopened, bridge, () => "missing adapter");

    assert.equal(reopened.listRunningSegments().length, 0);
    assert.equal(segmentStatus(reopened), "failed");
    reopened.close();
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("direct workflow compensation is idempotent and survives reopening when agent persistence fails", async () => {
  const root = await makeRoot();
  try {
    const store = seedRunningStore(root);
    const segment = store.listRunningSegments()[0];
    assert.ok(segment);

    compensateFailedWorkflowRun(store, segment, new Error("agent event persistence failed"), () => "2026-06-14T00:00:05.000Z");
    compensateFailedWorkflowRun(store, segment, new Error("retry must be idempotent"), () => "2026-06-14T00:00:06.000Z");
    store.close();

    const reopened = createWorkflowStore({ projectRoot: root });
    assert.deepEqual(reopened.listRunningSegments(), []);
    assert.equal(segmentStatus(reopened), "failed");
    assert.equal(reopened.listEvents("session-1").filter((event) => event.kind === "workflow.segment.finished").length, 1);
    reopened.close();
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("AgentBridge start failure commits SQLite terminal state before optional after enrichment", async () => {
  const root = await makeRoot();
  try {
    const store = seedRunningStore(root);
    store.recordRunCheckpoint(checkpointInput(root, store.listRunningSegments()[0], "before"));
    const bridge = new AgentBridge({
      appendEvent: async (projectRoot, event) => {
        if (event.kind === "evidence") throw new Error("evidence append failed");
        const directory = join(projectRoot, ".devflow", "runs", event.runId);
        await mkdir(directory, { recursive: true });
        await appendFile(join(directory, "events.ndjson"), `${JSON.stringify(event)}\n`, "utf8");
      },
      adapters: [{
        ...createMockAgentAdapter(),
        async startRun(_input, sink) {
          await sink.emit({ kind: "evidence", payload: { exitCode: null, checks: [] } });
          throw new Error("adapter must not continue");
        },
      }],
    });

    await assert.rejects(bridge.startRun(runInput(root)), /evidence append failed/);
    let enrichmentObservedTerminalCommit = false;
    await recoverTerminalWorkflowRuns(root, store, bridge, () => "start failed", undefined, async () => {
      enrichmentObservedTerminalCommit = store.listRunningSegments().length === 0 && segmentStatus(store) === "failed";
      throw new Error("git enrichment failed");
    });
    assert.equal(enrichmentObservedTerminalCommit, true);
    store.close();

    const reopened = createWorkflowStore({ projectRoot: root });
    assert.equal(reopened.listRunningSegments().length, 0);
    assert.equal(segmentStatus(reopened), "failed");
    assert.equal(reopened.listEvents("session-1").filter((event) =>
      event.kind === "workflow.node.checkpoint_failed" && event.payload.terminalRunPreserved === true
    ).length, 1);
    reopened.close();
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

function bridgeForTerminalStatus(status) {
  return new AgentBridge({
    adapters: [{
      ...createMockAgentAdapter(),
      async startRun(_input, sink) {
        await sink.emit({ kind: "evidence", payload: { exitCode: status === "failed" ? 1 : null, checks: [] } });
        await sink.emit({ kind: "status", payload: { status, reason: `${status} on disk` } });
        return { async cancel() {} };
      },
    }],
  });
}

function runInput(projectRoot) {
  return {
    protocolVersion: RUN_EVENT_PROTOCOL_VERSION,
    runId: "run-session-1-lane-implementation",
    nodeId: "lane-implementation",
    sessionId: "session-1",
    projectRoot,
    worktreePath: projectRoot,
    agentKind: "codex",
    prompt: "Recover after restart",
  };
}

function seedRunningStore(projectRoot) {
  const store = createWorkflowStore({ projectRoot });
  store.createWorkflowSession({
    id: "session-1",
    projectId: "project-1",
    title: "Recovery",
    goal: "Recover a crashed run",
    mode: "fast",
    plannerProfile: "default",
    transport: "hermes_replay_recovery",
    recoveryReason: "Test restart recovery.",
    now: "2026-06-14T00:00:00.000Z",
  });
  store.appendWorkflowEvent({
    sessionId: "session-1",
    kind: "workflow.lane.declared",
    source: "test",
    idempotencyKey: "lane:implementation",
    payload: {
      lane: {
        id: "lane-implementation",
        semanticKey: "lane-implementation",
        kind: "implementation",
        title: "Implement",
        agentKind: "codex",
        status: "pending",
      },
    },
    now: "2026-06-14T00:00:02.000Z",
  });
  store.scheduleReadyLanes("session-1", { allowedParallelism: 1, now: "2026-06-14T00:00:03.000Z" });
  return store;
}

function segmentStatus(store) {
  return store.materializeFlowProjection("session-1").segments.find((segment) => segment.id === "segment-session-1-lane-implementation")?.status;
}

function checkpointInput(projectRoot, segment, phase) {
  return {
    sessionId: segment.sessionId,
    nodeId: segment.laneId,
    laneId: segment.laneId,
    runId: segment.runId,
    segmentId: segment.segmentId,
    phase,
    executionTarget: "current_branch",
    worktreePath: projectRoot,
    branchName: "HEAD",
    headCommit: "d".repeat(40),
    worktreeState: "clean",
    evidenceRefs: [{ kind: "run", id: segment.runId }, { kind: "segment", id: segment.segmentId }],
    now: phase === "before" ? "2026-06-14T00:00:03.500Z" : "2026-06-14T00:00:05.000Z",
  };
}

function runResult(segment, status) {
  return {
    ...segment,
    outputSummary: "terminal result persisted before crash",
    evidence: {
      runId: segment.runId,
      status,
      exitCode: status === "succeeded" ? 0 : 1,
      changesetId: null,
      checks: [],
      artifacts: [],
      review: null,
      errorReason: status === "failed" ? "failed before enrichment" : null,
      cancelReason: null,
      completedAt: "2026-06-14T00:00:04.000Z",
    },
    now: "2026-06-14T00:00:04.000Z",
  };
}

async function makeRoot() {
  return mkdtemp(join(tmpdir(), "skyturn-recovery-"));
}

async function loadMainWorkflowStoreHarness(options = {}) {
  const main = await readFile(new URL("../electron/main.ts", import.meta.url), "utf8");
  const getWorkflowStoreSource = extractFunction(main, "getWorkflowStore").replace(
    'const { createWorkflowStore } = await import("@skyturn/persistence/workflow-store");',
    "const { createWorkflowStore } = persistenceModule;",
  );
  const source = [
    "const workflowStores = new Map();",
    "const workflowStoreInitializations = new Map();",
    "let resolverReceivedKnownStore = false;",
    "async function workflowStoreIdentity(projectRoot) { return projectRoot; }",
    "async function getAgentBridge() { return bridgeProvider(); }",
    "function summarizeRunOutput() { return ''; }",
    "function isExecutableCheckpointLane() { return true; }",
    "function assertWorkflowAgentKind(value) { return value; }",
    "function optionalText(value) { return typeof value === 'string' && value ? value : undefined; }",
    "function readField(value, key) { return value && typeof value === 'object' ? value[key] : undefined; }",
    `async function resolveExecutableRunIdentity(input, _phase, knownStore) {
      if (!knownStore) await getWorkflowStore(input.projectRoot);
      resolverReceivedKnownStore = knownStore !== undefined;
      return {
        sessionId: input.sessionId,
        nodeId: input.nodeId,
        laneId: input.nodeId,
        segmentId: 'segment-session-1-lane-implementation',
        runId: input.runId,
        agentKind: input.agentKind,
        executionTarget: 'current_branch',
        worktreePath: input.projectRoot,
        branchName: 'HEAD',
        headCommit: '${"d".repeat(40)}',
        worktreeState: 'clean',
        node: {},
        target: {},
      };
    }`,
    "async function reconcileRunChangeset() { return { evidence: { status: 'available' }, collectedAt: '2026-06-14T00:00:05.000Z' }; }",
    "async function verifyRunGitIdentityAtCheckpoint(identity) { return identity; }",
    "function recordRunChangesetEvidence(_store, identity, phase) { return `changeset-evidence:${identity.runId}:${phase}`; }",
    `function runCheckpointInput(identity, phase, changesetEvidenceId, now) {
      return {
        sessionId: identity.sessionId,
        nodeId: identity.nodeId,
        laneId: identity.laneId,
        runId: identity.runId,
        segmentId: identity.segmentId,
        phase,
        executionTarget: identity.executionTarget,
        worktreePath: identity.worktreePath,
        branchName: identity.branchName,
        headCommit: identity.headCommit,
        worktreeState: identity.worktreeState,
        evidenceRefs: [
          { kind: 'run', id: identity.runId },
          { kind: 'segment', id: identity.segmentId },
          { kind: 'changeset', id: changesetEvidenceId },
          { kind: 'evidence', id: 'evidence-' + identity.segmentId },
        ],
        now,
      };
    }`,
    getWorkflowStoreSource,
    extractSourceRange(main, "async function enrichTerminalWorkflowRun", "async function workflowStoreIdentity"),
    "function closeWorkflowStores() { for (const store of workflowStores.values()) store.close(); workflowStores.clear(); workflowStoreInitializations.clear(); }",
    "module.exports = { getWorkflowStore, closeWorkflowStores, hasPublishedStore: (root) => workflowStores.get(root) ?? false, resolverReceivedKnownStore: () => resolverReceivedKnownStore };",
  ].join("\n");
  const ts = require("typescript");
  const output = ts.transpileModule(source, {
    compilerOptions: {
      module: ts.ModuleKind.CommonJS,
      target: ts.ScriptTarget.ES2022,
    },
  }).outputText;
  const module = { exports: {} };
  const bridge = { async loadEvents() { return []; }, async getEvidence() { return null; } };
  const bridgeProvider = options.getAgentBridge ?? (async () => bridge);
  const onStoreCreated = options.onStoreCreated ?? (() => {});
  const persistenceModule = {
    createWorkflowStore(input) {
      const store = createWorkflowStore(input);
      onStoreCreated(store);
      return store;
    },
  };
  vm.runInNewContext(output, {
    bridge,
    bridgeProvider,
    Date,
    Error,
    Map,
    Promise,
    module,
    exports: module.exports,
    persistenceModule,
    recoverTerminalWorkflowRuns,
  }, { filename: "main.workflowStoreHarness.ts" });
  return module.exports;
}

function deferred() {
  let resolve;
  const promise = new Promise((onResolve) => {
    resolve = onResolve;
  });
  return { promise, resolve };
}

async function loadMainChangesetEvidenceRecorder() {
  const main = await readFile(new URL("../electron/main.ts", import.meta.url), "utf8");
  const source = [
    "function workflowIpcError(_code, message) { return new Error(message); }",
    extractFunction(main, "recordRunChangesetEvidence"),
    extractFunction(main, "stableJson"),
    extractFunction(main, "sortJson"),
    extractFunction(main, "isRecord"),
    "module.exports = { recordRunChangesetEvidence };",
  ].join("\n");
  const ts = require("typescript");
  const output = ts.transpileModule(source, {
    compilerOptions: {
      module: ts.ModuleKind.CommonJS,
      target: ts.ScriptTarget.ES2022,
    },
  }).outputText;
  const module = { exports: {} };
  vm.runInNewContext(output, {
    Error,
    JSON,
    Object,
    module,
    exports: module.exports,
  }, { filename: "main.changesetEvidence.ts" });
  return module.exports.recordRunChangesetEvidence;
}

function changesetEvidence(order) {
  const nested = order === "normal-order" ? { zeta: 2, alpha: 1 } : { alpha: 1, zeta: 2 };
  const evidence = order === "normal-order"
    ? { status: "available", summary: nested, files: [{ path: "src/a.ts", status: "modified" }] }
    : { files: [{ status: "modified", path: "src/a.ts" }], summary: nested, status: "available" };
  return { evidence, collectedAt: "2026-06-14T00:00:05.000Z" };
}

function extractFunction(source, name) {
  const functionStart = source.indexOf(`function ${name}`);
  assert.ok(functionStart >= 0, `missing function ${name}`);
  const asyncStart = source.lastIndexOf("async ", functionStart);
  const start = asyncStart >= 0 && asyncStart + "async ".length === functionStart ? asyncStart : functionStart;
  const braceStart = source.indexOf("{", start);
  assert.ok(braceStart > start, `missing function body for ${name}`);
  let depth = 0;
  for (let index = braceStart; index < source.length; index += 1) {
    const char = source[index];
    if (char === "{") depth += 1;
    if (char === "}") depth -= 1;
    if (depth === 0) return source.slice(start, index + 1);
  }
  throw new Error(`unterminated function ${name}`);
}

function extractSourceRange(source, startMarker, endMarker) {
  const start = source.indexOf(startMarker);
  const end = source.indexOf(endMarker, start);
  assert.ok(start >= 0, `missing source marker ${startMarker}`);
  assert.ok(end > start, `missing source marker ${endMarker}`);
  return source.slice(start, end);
}

async function withTimeout(promise, timeoutMs, message) {
  let timeout;
  try {
    return await Promise.race([
      promise,
      new Promise((_, reject) => {
        timeout = setTimeout(() => reject(new Error(message)), timeoutMs);
      }),
    ]);
  } finally {
    clearTimeout(timeout);
  }
}
