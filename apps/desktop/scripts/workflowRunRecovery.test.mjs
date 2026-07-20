import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { appendFile, chmod, lstat, mkdir, mkdtemp, open, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { after, test } from "node:test";
import vm from "node:vm";

import {
  AgentBridge as ProductionAgentBridge,
  RUN_EVENT_PROTOCOL_VERSION,
  createAgentRunStartFingerprint,
  createCodexCliAdapter,
  createDurableRunClaimStore,
  createMockAgentAdapter,
  createPrivateRunEventStore,
  loadRunEvents,
} from "@skyturn/agent-bridge";
import { createWorkflowStore } from "@skyturn/persistence/workflow-store";

import { compensateFailedWorkflowRun, recoverTerminalWorkflowRuns } from "../dist-electron/electron/workflowRunRecovery.js";

const require = createRequire(import.meta.url);
const previousStateHome = process.env.SKYTURN_STATE_HOME;
const testStateHome = await mkdtemp(join(tmpdir(), "skyturn-recovery-state-"));
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

test("restart recovery reconciles permanent child-close terminal persistence failure exactly once", async () => {
  const root = await makeRoot();
  const binRoot = await makeRoot();
  const executablePath = join(binRoot, "codex");
  const launchCountPath = join(binRoot, "launches.log");
  const input = runInput(root);
  const eventsPath = join(root, ".devflow", "runs", input.runId, "events.ndjson");
  const privateError = "status append failed token=desktop-persistence-secret-123456 at /Users/alice/.ssh/id_rsa";
  let statusAppendAttempts = 0;
  const liveEvents = [];
  try {
    await mkdir(join(root, ".git"));
    await writeFile(
      executablePath,
      `#!/bin/sh\nprintf 'launch\\n' >> ${JSON.stringify(launchCountPath)}\nexit 0\n`,
      { mode: 0o755 },
    );
    seedRunningStore(root).close();
    const bridge = new AgentBridge({
      adapters: [createCodexCliAdapter({ executablePath })],
      appendEvent: async (projectRoot, event) => {
        if (event.kind === "status") {
          if (statusAppendAttempts === 0) {
            await rm(eventsPath, { force: true });
            await mkdir(eventsPath);
          }
          statusAppendAttempts += 1;
          throw new Error(privateError);
        }
        const directory = join(projectRoot, ".devflow", "runs", event.runId);
        await mkdir(directory, { recursive: true });
        await appendFile(join(directory, "events.ndjson"), `${JSON.stringify(event)}\n`, "utf8");
      },
    });
    bridge.onRunEvent((event) => liveEvents.push(event));
    await bridge.startRun(input);
    await waitUntil(() => statusAppendAttempts === 2);
    await waitUntil(() => bridge.listRuns().some((run) => run.id === input.runId && run.status === "failed"));
    await waitUntil(async () => (await bridge.getEvidence(root, input.runId)).status === "failed");

    let reopened = createWorkflowStore({ projectRoot: root });
    const restartedBridge = new AgentBridge({ adapters: [] });
    await recoverTerminalWorkflowRuns(root, reopened, restartedBridge, () => "terminal persistence failed");
    await recoverTerminalWorkflowRuns(root, reopened, restartedBridge, () => "duplicate recovery");
    assert.equal(reopened.listRunningSegments().length, 0);
    assert.equal(segmentStatus(reopened), "failed");
    assert.equal(reopened.listEvents("session-1").filter((event) => event.kind === "workflow.segment.finished").length, 1);
    assert.equal(reopened.materializeFlowProjection("session-1").lanes.find((lane) => lane.id === "lane-implementation")?.status, "failed");
    assert.equal(reopened.listEvents("session-1").filter((event) => event.kind === "workflow.run.recovery_failed").length, 0);
    reopened.close();

    reopened = createWorkflowStore({ projectRoot: root });
    await recoverTerminalWorkflowRuns(root, reopened, new AgentBridge({ adapters: [] }), () => "reopened recovery");
    assert.equal(reopened.listEvents("session-1").filter((event) => event.kind === "workflow.segment.finished").length, 1);
    reopened.close();

    const runEvents = await loadRunEvents(root, input.runId);
    const terminalStatuses = runEvents.filter((event) => event.kind === "status");
    assert.equal(terminalStatuses.length, 0);
    assert.equal(liveEvents.filter((event) => event.kind === "status" && event.payload.status === "failed").length, 0);
    await assert.rejects(readFile(join(root, ".devflow", "runs", input.runId, "terminal-recovery.json")));
    const publicState = JSON.stringify({ liveEvents, runEvents, evidence: await bridge.getEvidence(root, input.runId) });
    assert.match(publicState, /terminal-persistence-failed/);
    assert.doesNotMatch(publicState, /desktop-persistence-secret-123456|alice|id_rsa/);

    const launchGuardBridge = new AgentBridge({ adapters: [createCodexCliAdapter({ executablePath })] });
    await assert.rejects(launchGuardBridge.startRun(input), /already terminal/i);
    assert.equal((await launchGuardBridge.getEvidence(root, input.runId)).status, "failed");
    assert.equal(await readFile(launchCountPath, "utf8"), "launch\n");
  } finally {
    await rm(root, { recursive: true, force: true });
    await rm(binRoot, { recursive: true, force: true });
  }
});

test("readable unsynced terminal compensates SQLite and never releases Canvas downstream work", async () => {
  const root = await makeRoot();
  const input = runInput(root);
  const privateStore = readableUnsyncedTerminalStore();
  const liveEvents = [];
  let compensationCount = 0;
  let store;
  try {
    store = seedRunningStore(root);
    declareDownstreamLane(store);
    const bridge = new AgentBridge({
      adapters: [createMockAgentAdapter()],
      privateRunEventStore: privateStore.store,
      onTerminalPersistenceFailure: async (failure) => {
        compensationCount += 1;
        const segment = store.listRunningSegments().find((candidate) => candidate.runId === failure.runId);
        assert.ok(segment);
        compensateFailedWorkflowRun(store, segment, new Error(failure.reason), () => "2026-07-14T00:00:02.000Z");
      },
    });
    bridge.onRunEvent((event) => liveEvents.push(event));

    await bridge.startRun(input);
    await waitUntil(() => compensationCount === 1);

    assert.equal(privateStore.statusAttempts, 2);
    assert.equal(compensationCount, 1);
    assert.equal(liveEvents.filter((event) => event.kind === "status").length, 0);
    assert.equal((await bridge.getEvidence(root, input.runId)).status, "failed");
    const mirror = await workspaceRunEvents(root, input.runId);
    assert.equal(mirror.filter((event) => event.kind === "status").length, 0);
    const projection = store.materializeFlowProjection("session-1");
    const canvas = store.materializeCanvasSession("session-1");
    assert.equal(projection.events.filter((event) => event.kind === "workflow.segment.finished").length, 1);
    assert.equal(projection.lanes.find((lane) => lane.id === "lane-implementation")?.status, "failed");
    assert.equal(projection.lanes.find((lane) => lane.id === "lane-downstream")?.status, "pending");
    assert.equal(canvas?.nodes.find((node) => node.id === "lane-implementation")?.status, "failed");
    assert.deepEqual(store.scheduleReadyLanes("session-1", {
      allowedParallelism: 2,
      now: "2026-07-14T00:00:03.000Z",
    }).readyLanes, []);
    store.close();
    store = undefined;

    const reopened = createWorkflowStore({ projectRoot: root });
    assert.equal(segmentStatus(reopened), "failed");
    assert.equal(reopened.materializeFlowProjection("session-1").lanes.find((lane) => lane.id === "lane-downstream")?.status, "pending");
    reopened.close();
  } finally {
    store?.close();
    await rm(root, { recursive: true, force: true });
  }
});

for (const failedSyncTarget of ["file", "directory"]) {
  test(`crashed ${failedSyncTarget} sync failure needs durable read before SQLite and Canvas recovery`, async () => {
    const root = await makeRoot();
    const privateRoot = await makeRoot();
    const input = runInput(root);
    const durableRunClaimStore = createDurableRunClaimStore({ root: privateRoot });
    const terminal = {
      protocolVersion: RUN_EVENT_PROTOCOL_VERSION,
      runId: input.runId,
      seq: 1,
      timestamp: "2026-07-15T00:00:01.000Z",
      kind: "status",
      payload: { status: "succeeded", exitCode: 0 },
    };
    let store;
    try {
      store = seedRunningStore(root);
      declareDownstreamLane(store);
      const eventPath = await durableRunClaimStore.runStatePath(root, input.runId, "events");
      const writeFault = syncFaultPrivateEventStore(
        durableRunClaimStore,
        ({ target, path }) =>
          target === failedSyncTarget && (failedSyncTarget === "file" || path === dirname(eventPath)) ? "EIO" : null,
      );
      await writeFault.store.prepare(root, root);
      await durableRunClaimStore.publish(root, {
        runId: input.runId,
        nodeId: input.nodeId,
        sessionId: input.sessionId,
        agentKind: input.agentKind,
        startFingerprint: createAgentRunStartFingerprint(input),
        startedAt: terminal.timestamp,
      });
      await assert.rejects(writeFault.store.append(root, terminal), { code: "EIO" });

      const readFault = syncFaultPrivateEventStore(
        durableRunClaimStore,
        ({ target, path }) =>
          target === failedSyncTarget && (failedSyncTarget === "file" || path === dirname(eventPath)) ? "EIO" : null,
      );
      const restartedBridge = new AgentBridge({
        adapters: [],
        durableRunClaimStore,
        privateRunEventStore: readFault.store,
      });
      assert.deepEqual(await restartedBridge.loadEvents(root, input.runId), []);
      assert.deepEqual(await restartedBridge.getEvidence(root, input.runId), {
        runId: input.runId,
        status: "failed",
        exitCode: null,
        changesetId: null,
        checks: [{
          kind: "run-exit",
          name: "Terminal persistence",
          status: "failed",
          detail: "terminal-persistence-failed",
        }],
        artifacts: [],
        review: null,
        errorReason: "terminal-persistence-failed",
        cancelReason: null,
        completedAt: terminal.timestamp,
      });

      await recoverTerminalWorkflowRuns(root, store, restartedBridge, () => "must not expose succeeded output");
      await recoverTerminalWorkflowRuns(root, store, restartedBridge, () => "duplicate recovery");
      const projection = store.materializeFlowProjection("session-1");
      const canvas = store.materializeCanvasSession("session-1");
      const compensationCount = projection.events.filter((event) => event.kind === "workflow.segment.finished").length;
      assert.equal(compensationCount, 1);
      assert.equal(store.listRunningSegments().length, 0);
      assert.equal(projection.lanes.find((lane) => lane.id === "lane-implementation")?.status, "failed");
      assert.equal(projection.lanes.find((lane) => lane.id === "lane-downstream")?.status, "pending");
      assert.equal(canvas?.nodes.find((node) => node.id === "lane-implementation")?.status, "failed");
      assert.deepEqual(store.scheduleReadyLanes("session-1", {
        allowedParallelism: 2,
        now: "2026-07-15T00:00:03.000Z",
      }).readyLanes, []);
      assert.equal(store.listEvents("session-1").filter((event) => event.kind === "workflow.run.recovery_failed").length, 0);
      store.close();
      store = undefined;

      const repairedStore = syncFaultPrivateEventStore(durableRunClaimStore, () => null);
      const repairedBridge = new AgentBridge({
        adapters: [],
        durableRunClaimStore,
        privateRunEventStore: repairedStore.store,
      });
      assert.deepEqual(await repairedBridge.loadEvents(root, input.runId), [terminal]);
      assert.equal((await repairedBridge.getEvidence(root, input.runId)).status, "succeeded");

      const reopened = createWorkflowStore({ projectRoot: root });
      await recoverTerminalWorkflowRuns(root, reopened, repairedBridge, () => "late repaired output");
      assert.equal(segmentStatus(reopened), "failed");
      assert.equal(reopened.listEvents("session-1").filter((event) => event.kind === "workflow.segment.finished").length, 1);
      assert.equal(reopened.materializeFlowProjection("session-1").lanes.find((lane) => lane.id === "lane-downstream")?.status, "pending");
      reopened.close();
    } finally {
      store?.close();
      await rm(root, { recursive: true, force: true });
      await rm(privateRoot, { recursive: true, force: true });
    }
  });
}

test("forged project event success cannot override real Codex failure or release downstream work", async () => {
  const root = await makeRoot();
  const binRoot = await makeRoot();
  const executablePath = join(binRoot, "codex");
  const input = runInput(root);
  const runDirectory = join(root, ".devflow", "runs", input.runId);
  const eventsPath = join(runDirectory, "events.ndjson");
  try {
    await mkdir(join(root, ".git"));
    await mkdir(runDirectory, { recursive: true });
    const store = seedRunningStore(root);
    declareDownstreamLane(store);
    await writeFile(
      executablePath,
      [
        "#!/usr/bin/env node",
        "const fs = require('node:fs');",
        `const target = ${JSON.stringify(eventsPath)};`,
        `const runId = ${JSON.stringify(input.runId)};`,
        "const deadline = Date.now() + 5000;",
        "while ((!fs.existsSync(target) || fs.readFileSync(target, 'utf8').split('\\n').filter(Boolean).length === 0) && Date.now() < deadline) {}",
        "const seq = fs.readFileSync(target, 'utf8').split('\\n').filter(Boolean).length + 1;",
        "const base = { protocolVersion: 1, runId, timestamp: '2026-07-14T00:00:00.000Z' };",
        "fs.appendFileSync(target, JSON.stringify({ ...base, seq, kind: 'evidence', payload: { exitCode: 0, checks: [{ kind: 'artifact', name: 'Expected artifacts', status: 'passed' }], artifacts: ['.devflow/acceptance/missing.png'] } }) + '\\n');",
        "fs.appendFileSync(target, JSON.stringify({ ...base, seq: seq + 1, kind: 'status', payload: { status: 'succeeded', exitCode: 0 } }) + '\\n');",
        "process.exit(7);",
      ].join("\n"),
      { mode: 0o755 },
    );
    const bridge = new AgentBridge({ adapters: [createCodexCliAdapter({ executablePath })] });
    await bridge.startRun({
      ...input,
      expectedArtifacts: [".devflow/acceptance/missing.png"],
    });
    await waitUntil(() => bridge.listRuns().some((run) => run.id === input.runId && run.status === "failed"));
    const activeEvidence = await bridge.getEvidence(root, input.runId);
    assert.equal(activeEvidence.status, "failed");
    assert.equal(activeEvidence.exitCode, 7);
    assert.deepEqual(activeEvidence.artifacts, []);
    assert.equal(activeEvidence.checks.some((check) => check.kind === "artifact" && check.status === "passed"), false);

    const restartedBridge = new AgentBridge({ adapters: [] });
    const restartedEvidence = await restartedBridge.getEvidence(root, input.runId);
    assert.deepEqual(restartedEvidence, activeEvidence);

    await recoverTerminalWorkflowRuns(root, store, restartedBridge, () => "real adapter failed");

    const projection = store.materializeFlowProjection("session-1");
    const canvas = store.materializeCanvasSession("session-1");
    assert.equal(projection.lanes.find((lane) => lane.id === "lane-implementation")?.status, "failed");
    assert.equal(projection.lanes.find((lane) => lane.id === "lane-downstream")?.status, "pending");
    assert.equal(projection.segments.find((segment) => segment.id === "segment-session-1-lane-implementation")?.status, "failed");
    assert.equal(canvas?.nodes.find((node) => node.id === "lane-implementation")?.status, "failed");
    assert.deepEqual(store.scheduleReadyLanes("session-1", {
      allowedParallelism: 2,
      now: "2026-07-14T00:00:01.000Z",
    }).readyLanes, []);
    store.close();

    const reopened = createWorkflowStore({ projectRoot: root });
    assert.equal(segmentStatus(reopened), "failed");
    assert.equal(reopened.materializeFlowProjection("session-1").lanes.find((lane) => lane.id === "lane-downstream")?.status, "pending");
    reopened.close();
  } finally {
    await rm(root, { recursive: true, force: true });
    await rm(binRoot, { recursive: true, force: true });
  }
});

test("desktop terminal persistence callback compensates SQLite without broadcasting an unpersisted terminal", async () => {
  const root = await makeRoot();
  const binRoot = await makeRoot();
  const executablePath = join(binRoot, "codex");
  const input = runInput(root);
  const runDirectory = join(root, ".devflow", "runs", input.runId);
  const eventsPath = join(runDirectory, "events.ndjson");
  const recoveryPath = join(runDirectory, "terminal-recovery.json");
  const launchCountPath = join(binRoot, "launches.log");
  let store;
  try {
    await mkdir(join(root, ".git"));
    store = seedRunningStore(root);
    await writeFile(
      executablePath,
      `#!/bin/sh\nprintf 'launch\\n' >> ${JSON.stringify(launchCountPath)}\nmkdir ${JSON.stringify(recoveryPath)}\nexit 0\n`,
      { mode: 0o755 },
    );
    let statusAttempts = 0;
    let compensationCount = 0;
    const broadcastStates = [];
    const options = {
      adapters: [createCodexCliAdapter({ executablePath })],
      appendEvent: async (projectRoot, event) => {
        if (event.kind === "status") {
          if (statusAttempts === 0) {
            await rm(eventsPath, { force: true });
            await mkdir(eventsPath);
          }
          statusAttempts += 1;
          throw new Error("token=desktop-triple-secret-123456 at /Users/alice/private");
        }
        const directory = join(projectRoot, ".devflow", "runs", event.runId);
        await mkdir(directory, { recursive: true });
        await appendFile(join(directory, "events.ndjson"), `${JSON.stringify(event)}\n`, "utf8");
      },
      onTerminalPersistenceFailure: async (failure) => {
        compensationCount += 1;
        assert.equal(failure.reason, "terminal-persistence-failed");
        const segment = store.listRunningSegments().find((candidate) => candidate.runId === failure.runId);
        assert.ok(segment);
        compensateFailedWorkflowRun(store, segment, new Error("terminal-persistence-failed"), () => "2026-07-14T00:00:02.000Z");
      },
    };
    const bridge = new AgentBridge(options);
    bridge.onRunEvent((event) => {
      if (event.kind === "status") broadcastStates.push(segmentStatus(store));
    });

    await bridge.startRun(input);
    await waitUntil(() => compensationCount === 1);
    assert.equal(statusAttempts, 2);
    assert.equal(compensationCount, 1);
    assert.deepEqual(broadcastStates, []);
    assert.equal(store.listEvents("session-1").filter((event) => event.kind === "workflow.segment.finished").length, 1);
    store.close();
    store = undefined;

    const reopened = createWorkflowStore({ projectRoot: root });
    assert.equal(segmentStatus(reopened), "failed");
    assert.equal(reopened.listEvents("session-1").filter((event) => event.kind === "workflow.segment.finished").length, 1);
    reopened.close();
    let restartStarts = 0;
    const restarted = new AgentBridge({
      adapters: [{
        ...createMockAgentAdapter({ holdOpen: true }),
        async startRun() {
          restartStarts += 1;
          return { async cancel() {} };
        },
      }],
    });
    await assert.rejects(restarted.startRun(input), /durable state is invalid|already terminal|already (active|claimed)|durably claimed/i);
    assert.equal(restartStarts, 0);
    assert.equal(await readFile(launchCountPath, "utf8"), "launch\n");
    const sqlite = await readFile(join(root, ".devflow", "skyturn-workflow.sqlite"));
    assert.doesNotMatch(sqlite.toString("utf8"), /desktop-triple-secret|alice|private/);
  } finally {
    store?.close();
    await rm(root, { recursive: true, force: true });
    await rm(binRoot, { recursive: true, force: true });
  }
});

test("restart recovery compensates invalid final claims once with fixed sanitized evidence", async () => {
  for (const recoveryCase of ["zero-claim", "truncated-claim", "empty-claim", "symlink-claim", "directory-claim", "permissions-claim"]) {
    const root = await makeRoot();
    try {
      const store = seedRunningStore(root);
      const input = runInput(root);
      const bridge = bridgeForTerminalStatus("succeeded");
      await bridge.startRun(input);
      const claimPath = await testClaimStore.markerPath(root, input.runId);
      const marker = await readFile(claimPath);
      await rm(claimPath);
      if (recoveryCase === "zero-claim") {
        await writeFile(claimPath, "", { mode: 0o600 });
      } else if (recoveryCase === "truncated-claim") {
        await writeFile(claimPath, '{"value":"Bearer restart-secret-123456 /Users/alice/private"', { mode: 0o600 });
      } else if (recoveryCase === "empty-claim") {
        await writeFile(claimPath, "{}\n", { mode: 0o600 });
      } else if (recoveryCase === "symlink-claim") {
        const target = join(root, "restart-secret-123456");
        await writeFile(target, "secret");
        await symlink(target, claimPath);
      } else if (recoveryCase === "directory-claim") {
        await mkdir(claimPath);
      } else {
        await writeFile(claimPath, marker, { mode: 0o600 });
        await chmod(claimPath, 0o644);
      }

      await assert.rejects(bridge.getEvidence(root, input.runId), /run-start-claim-invalid/);

      let adapterStarts = 0;
      const restarted = new AgentBridge({ adapters: [{
        ...createMockAgentAdapter({ holdOpen: true }),
        async startRun() {
          adapterStarts += 1;
          return { async cancel() {} };
        },
      }] });
      await recoverTerminalWorkflowRuns(root, store, restarted, () => "unused", () => "2026-07-14T00:00:03.000Z");
      await recoverTerminalWorkflowRuns(root, store, restarted, () => "duplicate", () => "2026-07-14T00:00:04.000Z");
      const serialized = JSON.stringify(store.listEvents("session-1"));
      assert.equal(segmentStatus(store), "failed", recoveryCase);
      assert.equal(store.listRunningSegments().length, 0, recoveryCase);
      assert.equal(store.listEvents("session-1").filter((event) => event.kind === "workflow.segment.finished").length, 1, recoveryCase);
      const audits = store.listEvents("session-1").filter((event) => event.kind === "workflow.run.recovery_failed");
      assert.equal(audits.length, 1, recoveryCase);
      assert.equal(audits[0].payload.reason, "run-start-claim-invalid", recoveryCase);
      await assert.rejects(restarted.startRun(input), /run-start-claim-invalid/);
      assert.equal(adapterStarts, 0, recoveryCase);
      assert.ok(await lstat(claimPath), recoveryCase);
      assert.match(serialized, /run-start-claim-invalid/);
      assert.doesNotMatch(serialized, /restart-secret|alice|private|Unexpected|JSON|start-claim\.json|Users/);
      store.close();

      const reopened = createWorkflowStore({ projectRoot: root });
      await recoverTerminalWorkflowRuns(root, reopened, new AgentBridge({ adapters: [] }), () => "reopen");
      assert.equal(segmentStatus(reopened), "failed", recoveryCase);
      assert.equal(reopened.listEvents("session-1").filter((event) => event.kind === "workflow.segment.finished").length, 1, recoveryCase);
      assert.equal(reopened.listEvents("session-1").filter((event) => event.kind === "workflow.run.recovery_failed").length, 1, recoveryCase);
      reopened.close();
      const sqlite = await readFile(join(root, ".devflow", "skyturn-workflow.sqlite"));
      assert.doesNotMatch(sqlite.toString("utf8"), /restart-secret|alice|private|start-claim\.json|Users/);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  }
});

for (const persistedStatus of ["failed", "cancelled", "timed-out"]) {
  test(`invalid final claim dominates persisted ${persistedStatus} evidence across recovery and reopen`, async () => {
    const root = await makeRoot();
    try {
      const store = seedRunningStore(root);
      const input = runInput(root);
      const bridge = bridgeForTerminalStatus(persistedStatus);
      await bridge.startRun(input);
      const claimPath = await testClaimStore.markerPath(root, input.runId);
      await writeFile(claimPath, "", { mode: 0o600 });

      const restarted = new AgentBridge({ adapters: [] });
      await recoverTerminalWorkflowRuns(root, store, restarted, () => "must not replay terminal NDJSON");
      await recoverTerminalWorkflowRuns(root, store, restarted, () => "duplicate recovery");

      assert.equal(segmentStatus(store), "failed");
      assert.equal(store.listEvents("session-1").filter((event) => event.kind === "workflow.segment.finished").length, 1);
      const audits = store.listEvents("session-1").filter((event) => event.kind === "workflow.run.recovery_failed");
      assert.equal(audits.length, 1);
      assert.equal(audits[0].payload.reason, "run-start-claim-invalid");
      assert.match(JSON.stringify(store.listEvents("session-1")), /run-start-claim-invalid/);
      store.close();

      const reopened = createWorkflowStore({ projectRoot: root });
      await recoverTerminalWorkflowRuns(root, reopened, new AgentBridge({ adapters: [] }), () => "reopen duplicate");
      assert.equal(segmentStatus(reopened), "failed");
      assert.equal(reopened.listEvents("session-1").filter((event) => event.kind === "workflow.segment.finished").length, 1);
      assert.equal(reopened.listEvents("session-1").filter((event) => event.kind === "workflow.run.recovery_failed").length, 1);
      reopened.close();
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
}

test("invalid claim compensation does not depend on recovery audit persistence", async () => {
  const root = await makeRoot();
  try {
    const store = seedRunningStore(root);
    const input = runInput(root);
    const claimPath = await testClaimStore.markerPath(root, input.runId);
    await mkdir(dirname(claimPath), { recursive: true, mode: 0o700 });
    await writeFile(claimPath, "", { mode: 0o600 });
    const appendWorkflowEvent = store.appendWorkflowEvent.bind(store);
    store.appendWorkflowEvent = (event) => {
      if (event.kind === "workflow.run.recovery_failed") throw new Error("audit persistence unavailable");
      return appendWorkflowEvent(event);
    };

    await assert.rejects(
      recoverTerminalWorkflowRuns(root, store, new AgentBridge({ adapters: [] }), () => "unused"),
      /audit persistence unavailable/,
    );
    assert.equal(segmentStatus(store), "failed");
    assert.equal(store.listRunningSegments().length, 0);
    store.close();
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("claimed restart recovery ignores every legacy terminal sidecar shape and compensates exactly once", async () => {
  for (const sidecarCase of [
    "zero-byte",
    "truncated",
    "empty-object",
    "forged-success",
    "forged-failure",
    "secret-json",
    "symlink",
    "directory",
    "permissions",
  ]) {
    const root = await makeRoot();
    try {
      const store = seedRunningStore(root);
      const input = runInput(root);
      const active = new AgentBridge({ adapters: [createMockAgentAdapter({ holdOpen: true })] });
      await active.startRun(input);
      assert.equal((await active.getEvidence(root, input.runId)).status, "running", sidecarCase);
      const runDirectory = join(root, ".devflow", "runs", input.runId);
      const sidecarPath = join(runDirectory, "terminal-recovery.json");
      const claimPath = await testClaimStore.markerPath(root, input.runId);
      const originalClaim = await readFile(claimPath, "utf8");
      if (sidecarCase === "zero-byte") await writeFile(sidecarPath, "", { mode: 0o600 });
      if (sidecarCase === "truncated") await writeFile(sidecarPath, '{"version":1', { mode: 0o600 });
      if (sidecarCase === "empty-object") await writeFile(sidecarPath, "{}\n", { mode: 0o600 });
      if (sidecarCase === "forged-success" || sidecarCase === "forged-failure") {
        await writeFile(sidecarPath, `${JSON.stringify({
          runId: input.runId,
          status: sidecarCase === "forged-success" ? "succeeded" : "failed",
          exitCode: sidecarCase === "forged-success" ? 0 : 1,
          errorReason: sidecarCase === "forged-failure" ? "forged" : null,
          completedAt: "2026-07-14T00:00:00.000Z",
        })}\n`, { mode: 0o600 });
      }
      if (sidecarCase === "secret-json") {
        await writeFile(
          sidecarPath,
          '{"secret":"Bearer legacy-sidecar-secret-123456 at /Users/alice/private"}\n',
          { mode: 0o600 },
        );
      }
      if (sidecarCase === "symlink") {
        const target = join(root, "legacy-sidecar-secret-123456");
        await writeFile(target, "secret");
        await symlink(target, sidecarPath);
      }
      if (sidecarCase === "directory") await mkdir(sidecarPath);
      if (sidecarCase === "permissions") {
        await writeFile(sidecarPath, "{}\n", { mode: 0o600 });
        await chmod(sidecarPath, 0o644);
      }

      let adapterStarts = 0;
      const restarted = new AgentBridge({
        adapters: [{
          ...createMockAgentAdapter({ holdOpen: true }),
          async startRun() {
            adapterStarts += 1;
            return { async cancel() {} };
          },
        }],
      });
      await recoverTerminalWorkflowRuns(root, store, restarted, () => "restart compensation");
      await recoverTerminalWorkflowRuns(root, store, restarted, () => "duplicate compensation");

      assert.equal(segmentStatus(store), "failed", sidecarCase);
      assert.equal(store.listRunningSegments().length, 0, sidecarCase);
      assert.equal(store.listEvents("session-1").filter((event) => event.kind === "workflow.segment.finished").length, 1, sidecarCase);
      assert.equal(store.listEvents("session-1").filter((event) => event.kind === "workflow.run.recovery_failed").length, 0, sidecarCase);
      assert.equal((await restarted.getEvidence(root, input.runId)).errorReason, "terminal-persistence-failed", sidecarCase);
      await assert.rejects(restarted.startRun(input), /already terminal|durably claimed|durable state/i);
      assert.equal(adapterStarts, 0, sidecarCase);
      assert.equal(await readFile(claimPath, "utf8"), originalClaim, sidecarCase);
      store.close();

      const reopened = createWorkflowStore({ projectRoot: root });
      await recoverTerminalWorkflowRuns(root, reopened, new AgentBridge({ adapters: [] }), () => "reopen duplicate");
      assert.equal(segmentStatus(reopened), "failed", sidecarCase);
      assert.equal(reopened.listEvents("session-1").filter((event) => event.kind === "workflow.segment.finished").length, 1, sidecarCase);
      reopened.close();
      const sqlite = await readFile(join(root, ".devflow", "skyturn-workflow.sqlite"));
      assert.doesNotMatch(sqlite.toString("utf8"), /legacy-sidecar-secret|alice|private/);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  }
});

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

test("getWorkflowStore recovers a terminal Finish planner intent and schedules its lanes", async () => {
  const root = await makeRoot();
  let harness;
  try {
    const { segment } = seedRunningFinishPlannerStore(root);
    const bridge = await finishPlannerBridge(root, segment);
    harness = await loadMainWorkflowStoreHarness({ getAgentBridge: async () => bridge });

    const recovered = await harness.getWorkflowStore(root);

    assertFinishPlannerConverged(recovered, segment);
  } finally {
    harness?.closeWorkflowStores();
    await rm(root, { recursive: true, force: true });
  }
});

test("getWorkflowStore applies a Finish planner intent when RunEvidence was committed before the crash", async () => {
  const root = await makeRoot();
  let harness;
  try {
    const { store, segment } = seedRunningFinishPlannerStore(root, { keepOpen: true });
    const bridge = await finishPlannerBridge(root, segment);
    const [events, evidence] = await Promise.all([
      bridge.loadEvents(root, segment.runId),
      bridge.getEvidence(root, segment.runId),
    ]);
    store.recordRunResult({
      ...segment,
      outputSummary: "terminal result persisted before planner intent reconciliation",
      runEvents: events,
      evidence,
      now: evidence.completedAt,
    });
    assert.equal(store.listEvents(segment.sessionId).some((event) => event.kind === "workflow.intent.accepted"), false);
    store.close();

    harness = await loadMainWorkflowStoreHarness({ getAgentBridge: async () => bridge });
    const recovered = await harness.getWorkflowStore(root);

    assertFinishPlannerConverged(recovered, segment);
  } finally {
    harness?.closeWorkflowStores();
    await rm(root, { recursive: true, force: true });
  }
});

for (const crashWindow of ["intent-applied", "lanes-scheduled"]) {
  test(`getWorkflowStore converges when a crash leaves Finish planner ${crashWindow} without reconciliation`, async () => {
    const root = await makeRoot();
    let harness;
    try {
      const { store, segment } = seedRunningFinishPlannerStore(root, { keepOpen: true });
      const bridge = await finishPlannerBridge(root, segment);
      const [events, evidence] = await Promise.all([
        bridge.loadEvents(root, segment.runId),
        bridge.getEvidence(root, segment.runId),
      ]);
      store.recordRunResult({
        ...segment,
        outputSummary: "terminal result persisted before planner intent reconciliation",
        runEvents: events,
        evidence,
        now: evidence.completedAt,
      });
      store.applyWorkflowIntent(finishPlannerIntent(segment.sessionId), evidence.completedAt);
      if (crashWindow === "lanes-scheduled") {
        store.scheduleReadyLanes(segment.sessionId, { allowedParallelism: 2, now: evidence.completedAt });
      }
      store.close();

      harness = await loadMainWorkflowStoreHarness({ getAgentBridge: async () => bridge });
      const recovered = await harness.getWorkflowStore(root);

      assertFinishPlannerConverged(recovered, segment);
      const recoveredEvents = recovered.listEvents(segment.sessionId);
      assert.equal(recoveredEvents.filter((event) => event.kind === "workflow.intent.accepted").length, 1);
      assert.equal(recoveredEvents.filter((event) => event.kind === "workflow.lane.declared").length, 2);
      assert.equal(recoveredEvents.filter((event) => event.kind === "workflow.segment.started").length, 2);
    } finally {
      harness?.closeWorkflowStores();
      await rm(root, { recursive: true, force: true });
    }
  });
}

test("repeated getWorkflowStore reopen recovery keeps one Finish planner graph and launch set", async () => {
  const root = await makeRoot();
  let firstHarness;
  let secondHarness;
  try {
    const { segment } = seedRunningFinishPlannerStore(root);
    const bridge = await finishPlannerBridge(root, segment);
    firstHarness = await loadMainWorkflowStoreHarness({ getAgentBridge: async () => bridge });
    const first = await firstHarness.getWorkflowStore(root);
    assertFinishPlannerConverged(first, segment);
    firstHarness.closeWorkflowStores();
    firstHarness = undefined;

    secondHarness = await loadMainWorkflowStoreHarness({ getAgentBridge: async () => bridge });
    const reopened = await secondHarness.getWorkflowStore(root);

    assertFinishPlannerConverged(reopened, segment);
    const events = reopened.listEvents(segment.sessionId);
    assert.equal(events.filter((event) => event.kind === "workflow.intent.accepted").length, 1);
    assert.equal(events.filter((event) => event.kind === "workflow.lane.declared").length, 2);
    assert.equal(events.filter((event) => event.kind === "workflow.segment.started").length, 2);
    assert.equal(events.filter((event) => event.kind === "workflow.plan_finish.launch_accepted").length, 1);
  } finally {
    firstHarness?.closeWorkflowStores();
    secondHarness?.closeWorkflowStores();
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

test("restart recovery ignores missing, mismatched, and corrupt workspace event mirrors", async () => {
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
      assert.equal(recoveryFailures.length, 0, evidenceCase);
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
        await sink.emit({
          kind: "evidence",
          payload: {
            exitCode: status === "succeeded" ? 0 : status === "failed" ? 1 : null,
            checks: status === "succeeded"
              ? [{ kind: "run-exit", name: "Recovered run exit", status: "passed" }]
              : [],
          },
        });
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

function declareDownstreamLane(store) {
  store.appendWorkflowEvent({
    sessionId: "session-1",
    kind: "workflow.lane.declared",
    source: "test",
    idempotencyKey: "lane:downstream",
    payload: {
      lane: {
        id: "lane-downstream",
        semanticKey: "lane-downstream",
        kind: "validation",
        title: "Downstream",
        agentKind: "codex",
        status: "pending",
      },
    },
    now: "2026-06-14T00:00:03.100Z",
  });
  store.appendWorkflowEvent({
    sessionId: "session-1",
    kind: "workflow.edge.declared",
    source: "test",
    idempotencyKey: "edge:implementation-downstream",
    payload: {
      edge: {
        id: "edge-implementation-downstream",
        sourceLaneId: "lane-implementation",
        targetLaneId: "lane-downstream",
      },
    },
    now: "2026-06-14T00:00:03.200Z",
  });
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

function seedRunningFinishPlannerStore(projectRoot, options = {}) {
  const store = createWorkflowStore({ projectRoot });
  store.createPlanFinishWorkflowSession({
    id: "finish-session-1",
    planSessionId: "finish-session-1",
    projectId: "project-1",
    title: "Finish approved Plan",
    goal: "Apply the approved Plan",
    mode: "plan",
    target: { executionTarget: "current_branch", selectedBranch: "main" },
    plannerProfile: "default",
    transport: "hermes_replay_recovery",
    recoveryReason: "Test has no native Plan handle.",
    now: "2026-07-18T00:00:00.000Z",
  });
  store.appendWorkflowEvent({
    sessionId: "finish-session-1",
    kind: "workflow.plan_finish.launch_accepted",
    source: "electron-main",
    idempotencyKey: "plan-finish:finish-input-1:launch-accepted",
    payload: { inputId: "finish-input-1", runId: "hermes-plan-finish-finish-session-1-attempt-1" },
    now: "2026-07-18T00:00:01.000Z",
  });
  const claimed = store.claimPlannerRunStart({
    sessionId: "finish-session-1",
    laneId: "node-1",
    runId: "hermes-plan-finish-finish-session-1-attempt-1",
    agentKind: "hermes",
    worktreePath: projectRoot,
    now: "2026-07-18T00:00:01.000Z",
  });
  if (!options.keepOpen) store.close();
  return { store, segment: claimed.segment };
}

async function finishPlannerBridge(projectRoot, segment) {
  const base = createMockAgentAdapter();
  const bridge = new AgentBridge({
    adapters: [{
      ...base,
      kind: "hermes",
      label: "Test Hermes Agent",
      async startRun(_input, sink) {
        await sink.emit({ kind: "output", payload: { text: JSON.stringify(finishPlannerIntent(segment.sessionId)) } });
        await sink.emit({
          kind: "evidence",
          payload: {
            exitCode: 0,
            checks: [{ kind: "run-exit", name: "Hermes CLI exit", status: "passed" }],
          },
        });
        await sink.emit({ kind: "status", payload: { status: "succeeded", exitCode: 0 } });
        return { async cancel() {} };
      },
    }],
  });
  await bridge.startRun({
    protocolVersion: RUN_EVENT_PROTOCOL_VERSION,
    runId: segment.runId,
    nodeId: segment.laneId,
    sessionId: segment.sessionId,
    projectRoot,
    worktreePath: projectRoot,
    agentKind: "hermes",
    prompt: "Finish the approved Plan.",
  });
  return bridge;
}

function finishPlannerIntent(sessionId) {
  return {
    intentId: "finish-plan-intent-1",
    sessionId,
    operations: [
      { type: "AnalyzeRequirement", requirement: "Implement the approved Plan." },
      {
        type: "DiscoverProject",
        profile: {
          languages: ["TypeScript"],
          capabilities: ["desktop"],
          packages: ["@skyturn/desktop"],
          hasFrontend: true,
          hasBackend: true,
          hasPersistence: true,
        },
      },
      {
        type: "ProposeLanes",
        lanes: [
          { id: "lane-review-a", kind: "review", title: "Review approved Plan A", agentKind: "hermes" },
          { id: "lane-review-b", kind: "review", title: "Review approved Plan B", agentKind: "hermes" },
        ],
      },
    ],
  };
}

function assertFinishPlannerConverged(store, segment) {
  const projection = store.materializeFlowProjection(segment.sessionId);
  assert.equal(store.listSegments(segment.sessionId, segment.laneId).find((item) => item.id === segment.segmentId)?.status, "succeeded");
  assert.equal(projection.lanes.find((lane) => lane.id === "lane-review-a")?.status, "running");
  assert.equal(projection.lanes.find((lane) => lane.id === "lane-review-b")?.status, "running");
  assert.equal(store.listEvents(segment.sessionId).filter((event) => event.kind === "workflow.intent.accepted").length, 1);
}

async function makeRoot() {
  return mkdtemp(join(tmpdir(), "skyturn-recovery-"));
}

async function waitUntil(predicate) {
  const started = Date.now();
  for (;;) {
    if (await predicate()) return;
    if (Date.now() - started > 2_000) throw new Error("Timed out waiting for recovery condition");
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
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
    "function isRecord(value) { return typeof value === 'object' && value !== null && !Array.isArray(value); }",
    "function workflowIpcError(_code, message) { return new Error(message); }",
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
    extractSourceRange(main, "async function reconcileTerminalWorkflowRun", "async function enrichTerminalWorkflowRun"),
    extractSourceRange(main, "function assertTerminalRunEvidence", "async function verifyRunGitIdentityAtCheckpoint"),
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
  const orchestratorModule = await import("@skyturn/orchestrator");
  const workflowRuntimeModule = await import("@skyturn/ui-canvas/workflow-runtime");
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
    require(specifier) {
      if (specifier === "@skyturn/orchestrator") return orchestratorModule;
      if (specifier === "@skyturn/ui-canvas/workflow-runtime") return workflowRuntimeModule;
      throw new Error(`Unexpected harness import: ${specifier}`);
    },
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

function syncFaultPrivateEventStore(durableRunClaimStore, fault) {
  const attempts = new Map();
  const syncTargets = [];
  const store = createPrivateRunEventStore({
    durableRunClaimStore,
    fileSystem: {
      chmod,
      lstat,
      mkdir,
      async open(path, flags, mode) {
        const handle = await open(path, flags, mode);
        const target = typeof flags === "string" ? "directory" : "file";
        return new Proxy(handle, {
          get(value, property) {
            if (property === "sync") {
              return async () => {
                const key = `${target}:${path}`;
                const attempt = (attempts.get(key) ?? 0) + 1;
                attempts.set(key, attempt);
                syncTargets.push(target);
                const code = fault({ target, path, attempt });
                if (code) throw Object.assign(new Error(`injected ${target} sync failure`), { code });
                await value.sync();
              };
            }
            const member = Reflect.get(value, property, value);
            return typeof member === "function" ? member.bind(value) : member;
          },
        });
      },
    },
  });
  return { store, syncTargets };
}

function readableUnsyncedTerminalStore() {
  const events = new Map();
  let statusAttempts = 0;
  return {
    store: {
      async prepare() {},
      async eventPath(_projectRoot, runId) {
        return `/private/${runId}.events.ndjson`;
      },
      async append(_projectRoot, event) {
        const runEvents = events.get(event.runId) ?? [];
        const existing = runEvents.find((candidate) => candidate.seq === event.seq);
        if (existing && JSON.stringify(existing) !== JSON.stringify(event)) throw new Error("event conflict");
        if (!existing) {
          runEvents.push(event);
          events.set(event.runId, runEvents);
        }
        if (event.kind === "status") {
          statusAttempts += 1;
          throw Object.assign(new Error("injected file sync failure"), { code: "EIO" });
        }
        return existing ? "exists" : "appended";
      },
      async read(_projectRoot, runId) {
        const runEvents = events.get(runId);
        if (runEvents?.some((event) => event.kind === "status")) return { kind: "invalid" };
        return runEvents ? { kind: "valid", events: runEvents } : { kind: "missing" };
      },
    },
    get statusAttempts() {
      return statusAttempts;
    },
  };
}

async function workspaceRunEvents(projectRoot, runId) {
  try {
    const text = await readFile(join(projectRoot, ".devflow", "runs", runId, "events.ndjson"), "utf8");
    return text.split("\n").filter(Boolean).map(JSON.parse);
  } catch {
    return [];
  }
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
