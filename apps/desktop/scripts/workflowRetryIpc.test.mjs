import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { mkdir, mkdtemp, readdir, realpath, rm, symlink } from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import * as agentBridgeModule from "@skyturn/agent-bridge";
import { createSourceModuleLoader } from "./sourceModuleLoader.mjs";

const require = createRequire(import.meta.url);
const repo = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");
const now = "2026-09-10T00:00:00.000Z";
const output = "  Original failure\r\n\n";
const plain = (value) => JSON.parse(JSON.stringify(value));
const tick = () => new Promise((done) => setImmediate(done));
async function until(predicate) {
  const deadline = Date.now() + 5000;
  while (!predicate()) {
    assert.ok(Date.now() < deadline, "production boundary was not reached");
    await tick();
  }
}
function evidence(runId, status = "failed") {
  return { runId, status, exitCode: status === "succeeded" ? 0 : 1, changesetId: null, checks: [], artifacts: [],
    review: null, errorReason: status === "succeeded" ? null : "Original failure", cancelReason: null, completedAt: now };
}

async function harness(t) {
  const temp = await mkdtemp(join(tmpdir(), "skyturn-retry-ipc-"));
  const projectRoot = join(await realpath(temp), "project");
  await mkdir(projectRoot);
  const alias = join(temp, "alias");
  await symlink(projectRoot, alias);
  execFileSync("git", ["init", "-b", "main", projectRoot], { stdio: "ignore" });
  execFileSync("git", ["-c", "user.name=Fixture", "-c", "user.email=fixture@example.invalid",
    "commit", "--allow-empty", "-m", "Fixture"], { cwd: projectRoot, stdio: "ignore" });
  const head = execFileSync("git", ["rev-parse", "HEAD"], { cwd: projectRoot, encoding: "utf8" }).trim();
  const runs = [];
  const gates = [];
  let preflight = async () => undefined;
  let start = async () => undefined;
  const bridge = {
    async startRun(input) {
      await start(input);
      const run = { ...input, id: input.runId, status: "running" };
      runs.push(run);
      return run;
    },
    listRuns: () => runs,
    getEvidence: async (_root, runId) => evidence(runId),
    loadEvents: async () => [],
  };
  const handlers = new Map();
  let api;
  const electron = {
    app: { getPath: () => join(temp, "private"), on() {}, requestSingleInstanceLock: () => true,
      whenReady: () => ({ then() {} }) },
    BrowserWindow: { getAllWindows: () => [] }, dialog: {}, shell: {},
    ipcMain: { handle: (channel, handler) => handlers.set(channel, handler) },
    ipcRenderer: { invoke: (channel, ...args) => handlers.get(channel)(null, ...args) },
    contextBridge: { exposeInMainWorld: (_name, value) => { api = value; } },
  };
  let loader;
  loader = createSourceModuleLoader({
    typescript: require("typescript"),
    globals: { process, console, Buffer, Error, URL, AbortController, AbortSignal, setTimeout, clearTimeout,
      setImmediate, testBridge: bridge },
    mocks: new Map([["electron", electron], ["@skyturn/agent-bridge", {
      ...agentBridgeModule,
      assertExpectedArtifactVerifierCapability: (...args) => preflight(...args),
    }]]),
    loadExternal(specifier, importer) {
      if (!specifier.startsWith("@skyturn/")) return createRequire(importer)(specifier);
      const [name, subpath] = specifier.slice(9).split("/");
      const packageRoot = join(repo, "packages", name);
      const manifest = JSON.parse(readFileSync(join(packageRoot, "package.json"), "utf8"));
      return loader.load(join(packageRoot, manifest.exports[subpath ? `./${subpath}` : "."].types));
    },
  });
  const main = loader.load(join(repo, "apps/desktop/electron/main.ts"), { sourceSuffix: `
agentBridge = testBridge;
export { advanceWorkflowSession, enqueueWorkflowProjectAdvance, withWorkflowSessionMutationLock,
  getWorkflowStore, openedProjectRoots, planProjectIdentities, workflowStores,
  workflowStoreInitializations, workflowProjectAdvanceTails, workflowSessionMutationLocks,
  workflowStoreOperationTasks, workflowTerminalReconciliationTasks };` });
  loader.load(join(repo, "apps/desktop/electron/preload.ts"));
  const { createWorkflowStore } = loader.load(join(repo, "packages/persistence/src/workflowStore.ts"));
  let store = createWorkflowStore({ projectRoot });
  main.workflowStores.set(projectRoot, store);
  for (const root of [projectRoot, alias]) {
    main.openedProjectRoots.add(root);
    await main.planProjectIdentities.remember(root);
  }
  t.after(async () => {
    for (const gate of gates) gate.release();
    await Promise.allSettled([...main.workflowStoreOperationTasks, ...main.workflowProjectAdvanceTails.values(),
      ...main.workflowTerminalReconciliationTasks]);
    for (const current of new Set([store, ...main.workflowStores.values()])) current.close();
    await rm(temp, { recursive: true, force: true });
  });
  assert.equal(typeof api.workflow.retryLane, "function", "preload must expose the production Retry IPC");
  assert.equal(typeof handlers.get("workflow:lane:retry"), "function", "main must register Retry");
  function seed(status = "failed", sessionId = "session-1") {
    const session = store.createWorkflowSession({ id: sessionId, projectId: "project-1", title: "Retry",
      goal: "Retry safely", mode: "fast", target: { executionTarget: "current_branch", selectedBranch: "main" },
      plannerProfile: "default", transport: "hermes_replay_recovery", recoveryReason: "Test fixture.", now });
    const { segment } = store.claimPlannerRunStart({ sessionId, laneId: session.plannerLaneId,
      runId: `${sessionId}-planner`, agentKind: "hermes", worktreePath: projectRoot, now });
    store.recordRunResult({ ...segment, evidence: evidence(segment.runId, "succeeded"), outputSummary: "", now });
    store.recordPlannerIntentReconciled(segment, now);
    for (const id of ["first", "downstream"]) store.appendWorkflowEvent({ sessionId,
      kind: "workflow.lane.declared", source: "test", idempotencyKey: `lane:${id}`,
      payload: { lane: { id, kind: "validation", title: id, agentKind: "codex", status: "pending" } }, now });
    store.appendWorkflowEvent({ sessionId, kind: "workflow.edge.declared", source: "test",
      payload: { edge: { id: "edge", sourceLaneId: "first", targetLaneId: "downstream" } }, now });
    const lane = store.scheduleReadyLanes(sessionId, { now }).readyLanes[0];
    assert.equal(lane.id, "first");
    store.recordRunCheckpoint({ sessionId, nodeId: lane.id, laneId: lane.id, segmentId: lane.segmentId,
      runId: lane.runId, phase: "before", executionTarget: "current_branch", worktreePath: projectRoot,
      branchName: "main", headCommit: head, worktreeState: "clean", evidenceRefs: [{ kind: "run", id: lane.runId }], now });
    const terminal = { sessionId, laneId: lane.id, segmentId: lane.segmentId, runId: lane.runId, agentKind: "codex",
      evidence: evidence(lane.runId, status), now,
      runEvents: [{ protocolVersion: 1, runId: lane.runId, seq: 1, timestamp: now, kind: "output", payload: { text: output } }] };
    store.recordRunResult(terminal);
    return { terminal, request: { requestId: `retry-${sessionId}`, sessionId, laneId: lane.id,
      terminalSegmentId: lane.segmentId, terminalRunId: lane.runId } };
  }
  return { main, api, handlers, temp, projectRoot, alias, runs, seed, get store() { return store; },
    preflight: (hook) => { preflight = hook; }, start: (hook) => { start = hook; },
    gate() {
      let release;
      const promise = new Promise((done) => { release = done; });
      const gate = { promise, release };
      gates.push(gate);
      return gate;
    },
    retry: (input, root = alias) => api.workflow.retryLane(root, input),
    pause: () => api.workflow.pauseScheduling(alias, { sessionId: "session-1", requestId: "pause",
      expectedStatus: "active", expectedRevision: 0 }),
    advance: () => main.advanceWorkflowSession(projectRoot, store, "session-1", true),
    async reopen() {
      for (const current of new Set([store, ...main.workflowStores.values()])) current.close();
      main.workflowStores.clear();
      store = await main.getWorkflowStore(alias);
    },
  };
}

function snapshot(h) {
  return plain({ writes: h.store.db.prepare("SELECT total_changes() AS count").get().count,
    rows: h.store.db.prepare("SELECT * FROM workflow_events ORDER BY session_id, seq").all(),
    view: h.store.materializeWorkflowView("session-1") });
}

test("concurrent exact Retry requests reserve and launch once; identity conflicts write nothing", { timeout: 60000 }, async (t) => {
  const h = await harness(t);
  const { request, terminal } = h.seed();
  const original = plain(h.store.materializeFlowProjection(request.sessionId));
  const responses = await Promise.all([h.retry(request), h.retry({ ...request }, h.projectRoot)]);
  assert.deepEqual(responses.map((result) => result.created).sort(), [false, true]);
  const first = responses.find((result) => result.created);
  const duplicate = responses.find((result) => !result.created);
  assert.deepEqual(plain(duplicate.event), plain(first.event));
  assert.equal(first.event.kind, "workflow.lane.retry_requested");
  assert.equal(first.projectRoot, h.projectRoot);
  assert.equal(first.sessionId, request.sessionId);
  assert.equal(h.runs.length, 1);
  const run = h.runs[0];
  assert.notEqual(run.id, terminal.runId);
  assert.equal(run.id, first.event.payload.nextRunId);
  assert.equal(first.canvasSession.nodes.find((node) => node.id === "first").runId, run.id);
  assert.equal(first.canvasSession.nodes.find((node) => node.id === "first").status, "running");
  assert.deepEqual(plain(first.canvasSession.nodes.find((node) => node.id === "first").output), [output]);
  assert.equal(h.store.listRunningSegments()[0].segmentId, first.event.payload.nextSegmentId);
  assert.notEqual(first.event.payload.nextSegmentId, terminal.segmentId);
  const after = plain(h.store.materializeFlowProjection(request.sessionId));
  assert.deepEqual(after.segments.filter((segment) => segment.id === terminal.segmentId),
    original.segments.filter((segment) => segment.id === terminal.segmentId));
  assert.deepEqual(after.evidence, original.evidence);
  assert.deepEqual(after.lanes.find((lane) => lane.id === "first").output, [output]);
  assert.deepEqual(after.checkpoints.filter((checkpoint) => checkpoint.runId === terminal.runId), original.checkpoints);
  assert.equal(after.checkpoints.find((checkpoint) => checkpoint.runId === run.id).source, "backend");
  const beforeReplay = snapshot(h);
  let previews = 0;
  const preview = h.store.previewReadyLanes.bind(h.store);
  h.store.previewReadyLanes = (...args) => { previews++; return preview(...args); };
  assert.equal((await h.retry(request)).created, false);
  for (const changed of [{ laneId: "downstream" }, { terminalRunId: "forged-run" }, { terminalSegmentId: "forged-segment" }]) {
    await assert.rejects(h.retry({ ...request, ...changed }), /conflict/i);
  }
  assert.equal(previews, 0, "exact replay must not advance again");
  assert.deepEqual(snapshot(h), beforeReplay);
  assert.equal(h.runs.length, 1);
});

test("rejects unopened projects before canonicalization and malformed contracts before initialization", { timeout: 60000 }, async (t) => {
  const h = await harness(t);
  const { request } = h.seed();
  const before = snapshot(h);
  let canonicalizations = 0;
  const canonicalize = h.main.planProjectIdentities.canonicalize.bind(h.main.planProjectIdentities);
  h.main.planProjectIdentities.canonicalize = (...args) => { canonicalizations++; return canonicalize(...args); };
  const unopened = join(h.temp, "unopened");
  await mkdir(unopened);
  await assert.rejects(h.retry(request, unopened), /not open/i);
  assert.equal(canonicalizations, 0);
  const fresh = join(h.temp, "fresh");
  await mkdir(fresh);
  h.main.openedProjectRoots.add(fresh);
  await h.main.planProjectIdentities.remember(fresh);
  for (const input of [null, [], {}, { ...request, prompt: "override" }, { ...request, runId: "renderer-run" },
    { ...request, terminalRunId: "bad id" }, { ...request, terminalSegmentId: undefined },
    { ...request, requestId: "retry\n" }, { ...request, sessionId: " session-1" }]) {
    await assert.rejects(h.retry(input, fresh), /SKYTURN_WORKFLOW_IPC_ERROR:INVALID_INPUT: Invalid exact Workflow Retry request/);
    assert.equal(h.main.workflowStoreInitializations.size, 0);
    assert.equal(h.main.workflowStores.has(fresh), false);
  }
  assert.deepEqual(await readdir(fresh), []);
  assert.deepEqual(await readdir(unopened), []);
  assert.deepEqual(snapshot(h), before);
  assert.equal(h.runs.length, 0);
});

test("unknown sessions, lanes and forged terminal identities fail without writes or launches", { timeout: 60000 }, async (t) => {
  const h = await harness(t);
  const { request } = h.seed();
  const other = h.seed("failed", "session-2");
  const before = snapshot(h);
  for (const changed of [{ sessionId: "unknown" }, { laneId: "unknown" }, { laneId: "downstream" },
    { terminalRunId: "forged" }, { terminalSegmentId: "forged" },
    { terminalRunId: other.request.terminalRunId, terminalSegmentId: other.request.terminalSegmentId }]) {
    await assert.rejects(h.retry({ ...request, ...changed }));
    assert.deepEqual(snapshot(h), before);
  }
  assert.equal(h.runs.length, 0);
});

for (const unsafe of ["checkpoint", "active project work", "delivery"]) {
  test(`Retry rejects unsafe ${unsafe} scope without writes`, { timeout: 60000 }, async (t) => {
    const h = await harness(t);
    const { request } = h.seed();
    if (unsafe === "checkpoint") {
      h.store.db.prepare("UPDATE workflow_events SET source = 'renderer' WHERE kind = 'workflow.node.checkpoint_recorded'").run();
    } else if (unsafe === "active project work") {
      h.seed("failed", "session-2");
      h.store.claimPlannerRunStart({ sessionId: "session-2", laneId: h.store.materializeCanvasSession("session-2").plannerNodeId,
        runId: "other-active-run", agentKind: "hermes", worktreePath: h.projectRoot, now });
    } else {
      h.store.appendWorkflowEvent({ sessionId: request.sessionId, kind: "workflow.remote_side_effect.requested",
        source: "backend", payload: {}, now });
    }
    const before = snapshot(h);
    await assert.rejects(h.retry(request));
    assert.deepEqual(snapshot(h), before);
    assert.equal(h.runs.length, 0);
  });
}

for (const status of ["failed", "cancelled", "timed-out"]) {
  test(`paused Retry preserves exact ${status} history across initialization and replay`, { timeout: 60000 }, async (t) => {
    const h = await harness(t);
    const { request } = h.seed(status);
    const original = plain(h.store.materializeFlowProjection(request.sessionId));
    await h.pause();
    // Force the real initialization/recovery path inside Retry, before queue admission.
    h.store.close();
    h.main.workflowStores.clear();
    const accepted = await h.retry(request);
    await h.reopen();
    assert.equal(accepted.created, true);
    assert.equal(accepted.canvasSession.schedulingState.status, "paused");
    assert.equal(accepted.canvasSession.nodes.find((node) => node.id === "first").status, "pending");
    assert.deepEqual(plain(accepted.projection.segments), original.segments);
    assert.deepEqual(plain(accepted.projection.evidence), original.evidence);
    assert.deepEqual(plain(accepted.projection.lanes.find((lane) => lane.id === "first").output), [output]);
    const before = snapshot(h);
    const replay = await h.retry(request);
    assert.equal(replay.created, false);
    assert.deepEqual(plain(replay.projection), before.view.projection);
    assert.deepEqual(snapshot(h), before);
    assert.equal(h.runs.length, 0);
    assert.equal(h.store.listRunningSegments().length, 0);
  });
}

test("pause ahead of Retry in the project queue suppresses its launch", { timeout: 60000 }, async (t) => {
  const h = await harness(t);
  const { request } = h.seed();
  const blocker = h.gate();
  const holding = h.main.enqueueWorkflowProjectAdvance(h.projectRoot, () => blocker.promise);
  const waitingState = snapshot(h);
  const before = h.main.workflowProjectAdvanceTails.get(h.projectRoot);
  const pausing = h.pause();
  await until(() => h.main.workflowProjectAdvanceTails.get(h.projectRoot) !== before);
  const pausedTail = h.main.workflowProjectAdvanceTails.get(h.projectRoot);
  const retrying = h.retry(request);
  await until(() => h.main.workflowProjectAdvanceTails.get(h.projectRoot) !== pausedTail);
  assert.deepEqual(snapshot(h), waitingState, "neither queued mutation may write before project admission");
  blocker.release();
  await Promise.all([holding, pausing]);
  const result = await retrying;
  await h.advance();
  assert.equal(result.created, true);
  assert.equal(result.canvasSession.schedulingState.status, "paused");
  assert.equal(h.runs.length, 0);
});

test("Retry takes the session lock before the launch queue so a waiting mutation cannot block pause", { timeout: 60000 }, async (t) => {
  const h = await harness(t);
  const { request } = h.seed();
  const blocker = h.gate();
  const holding = h.main.withWorkflowSessionMutationLock(h.projectRoot, request.sessionId, () => blocker.promise);
  const waitingState = snapshot(h);
  const before = [...h.main.workflowSessionMutationLocks.values()][0];
  const retrying = h.retry(request);
  await until(() => [...h.main.workflowSessionMutationLocks.values()][0] !== before);
  assert.equal(h.main.workflowProjectAdvanceTails.size, 0);
  assert.deepEqual(snapshot(h), waitingState, "Retry cannot mutate before session admission");
  assert.equal((await h.pause()).schedulingState.status, "paused");
  blocker.release();
  await holding;
  assert.equal((await retrying).created, true);
  assert.equal(h.runs.length, 0);
  assert.equal(h.main.workflowSessionMutationLocks.size, 0);
});

test("Retry holds project admission through preflight and start while pause and scheduler wait", { timeout: 60000 }, async (t) => {
  const h = await harness(t);
  const { request } = h.seed();
  const entered = h.gate();
  const preflight = h.gate();
  const startEntered = h.gate();
  const start = h.gate();
  h.preflight(async () => { entered.release(); await preflight.promise; });
  h.start(async () => { startEntered.release(); await start.promise; });
  const retrying = h.retry(request);
  await entered.promise;
  const before = h.main.workflowProjectAdvanceTails.get(h.projectRoot);
  let paused = false;
  const pausing = h.pause().then((result) => { paused = true; return result; });
  await until(() => h.main.workflowProjectAdvanceTails.get(h.projectRoot) !== before);
  const advancing = h.advance();
  assert.equal(paused, false);
  preflight.release();
  await startEntered.promise;
  assert.equal(paused, false);
  start.release();
  assert.equal((await retrying).created, true);
  assert.equal((await pausing).schedulingState.status, "paused");
  await advancing;
  assert.equal(h.runs.length, 1);
  assert.equal(h.store.listRunningSegments().length, 1);
  const beforeReplay = snapshot(h);
  const replay = await h.retry(request);
  assert.equal(replay.created, false);
  assert.equal(replay.canvasSession.schedulingState.status, "paused", "replay returns the current authoritative view");
  assert.deepEqual(snapshot(h), beforeReplay);
  assert.equal(h.main.workflowSessionMutationLocks.size, 0);
});

test("preload requires a strict authoritative Retry envelope", { timeout: 60000 }, async (t) => {
  const h = await harness(t);
  const { request } = h.seed();
  await h.pause();
  const accepted = plain(await h.retry(request));
  const before = snapshot(h);
  for (const invalid of [null, {}, { ...accepted, canvasSession: undefined }, { ...accepted, protocolVersion: 2 },
    { ...accepted, projectRoot: "relative" }, { ...accepted, sessionId: "foreign" },
    { ...accepted, canvasSession: { ...accepted.canvasSession, id: "foreign" } },
    { ...accepted, canvasSession: { ...accepted.canvasSession, nodes: null } },
    { ...accepted, canvasSession: { ...accepted.canvasSession, plannerNodeId: undefined } }]) {
    h.handlers.set("workflow:lane:retry", async () => invalid);
    await assert.rejects(h.retry(request), /SKYTURN_WORKFLOW_IPC_ERROR:INVALID_INPUT/);
  }
  h.handlers.set("workflow:lane:retry", async () => accepted);
  assert.deepEqual(plain(await h.retry(request)), accepted);
  assert.deepEqual(snapshot(h), before);
  assert.equal(h.runs.length, 0);
});

test("a scheduler admitted before Retry owns the project; Retry revalidates active scope after waiting", { timeout: 60000 }, async (t) => {
  const h = await harness(t);
  const { request } = h.seed();
  h.seed("failed", "session-2");
  h.store.appendWorkflowEvent({ sessionId: "session-2", kind: "workflow.lane.declared", source: "test", now,
    payload: { lane: { id: "independent", kind: "validation", title: "Independent", agentKind: "codex" } } });
  const entered = h.gate();
  const start = h.gate();
  h.start(async () => { entered.release(); await start.promise; });
  const advancing = h.main.advanceWorkflowSession(h.projectRoot, h.store, "session-2", true);
  await entered.promise;
  const before = snapshot(h);
  const tail = h.main.workflowProjectAdvanceTails.get(h.projectRoot);
  const rejection = assert.rejects(h.retry(request), /active project work/i);
  await until(() => h.main.workflowProjectAdvanceTails.get(h.projectRoot) !== tail);
  assert.deepEqual(snapshot(h), before);
  start.release();
  await Promise.all([advancing, rejection]);
  assert.deepEqual(snapshot(h), before);
  assert.equal(h.runs.length, 1);
  assert.equal(h.runs[0].sessionId, "session-2");
});
