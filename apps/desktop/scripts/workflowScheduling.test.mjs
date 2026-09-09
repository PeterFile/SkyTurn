import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { mkdir, mkdtemp, realpath, rm, symlink } from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import * as agentBridgeModule from "@skyturn/agent-bridge";
import { createSourceModuleLoader } from "./sourceModuleLoader.mjs";

const require = createRequire(import.meta.url);
const repo = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");
const now = "2026-09-08T00:00:00.000Z";
const request = (requestId = "pause-1", expectedRevision = 0, expectedStatus = "active", sessionId = "session-1") =>
  ({ sessionId, requestId, expectedStatus, expectedRevision });
const tick = () => new Promise((done) => setImmediate(done));
function gate() {
  let release;
  const promise = new Promise((done) => { release = done; });
  return { promise, release };
}
async function until(predicate) {
  const deadline = Date.now() + 5000;
  while (!predicate()) {
    assert.ok(Date.now() < deadline, "production boundary was not reached");
    await tick();
  }
}
function evidence(runId) {
  return { runId, status: "succeeded", exitCode: 0, changesetId: null, checks: [], artifacts: [],
    review: null, errorReason: null, cancelReason: null, completedAt: now };
}

async function harness(t, controls = true) {
  const temp = await mkdtemp(join(tmpdir(), "skyturn-scheduling-"));
  const projectRoot = join(await realpath(temp), "project");
  await mkdir(projectRoot);
  const alias = join(temp, "alias");
  await symlink(projectRoot, alias);
  execFileSync("git", ["init", "-b", "main", projectRoot], { stdio: "ignore" });
  execFileSync("git", ["-c", "user.name=Fixture", "-c", "user.email=fixture@example.invalid",
    "commit", "--allow-empty", "-m", "Fixture"], { cwd: projectRoot, stdio: "ignore" });
  const runs = [];
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
      const entry = manifest.exports[subpath ? `./${subpath}` : "."].types;
      return loader.load(join(packageRoot, entry));
    },
  });
  const main = loader.load(join(repo, "apps/desktop/electron/main.ts"), { sourceSuffix: `
agentBridge = testBridge;
export { advanceWorkflowSession, enqueueWorkflowProjectAdvance, getWorkflowStore, openedProjectRoots,
  planProjectIdentities, reconcileTerminalRunEvent, reconcileTerminalWorkflowRun, workflowStores,
  compensateTerminalPersistenceFailure, workflowTerminalReconciliationTasks,
  workflowProjectAdvanceTails, workflowSessionMutationLocks, workflowStoreOperationTasks };` });
  loader.load(join(repo, "apps/desktop/electron/preload.ts"));
  const { createWorkflowStore } = loader.load(join(repo, "packages/persistence/src/workflowStore.ts"));
  let store = createWorkflowStore({ projectRoot });
  main.workflowStores.set(projectRoot, store);
  for (const root of [projectRoot, alias]) {
    main.openedProjectRoots.add(root);
    await main.planProjectIdentities.remember(root);
  }
  t.after(async () => {
    await Promise.allSettled([...main.workflowStoreOperationTasks, ...main.workflowProjectAdvanceTails.values(),
      ...main.workflowTerminalReconciliationTasks]);
    store.close();
    await rm(temp, { recursive: true, force: true });
  });
  if (controls) assert.equal(typeof api.workflow.pauseScheduling, "function", "preload exposes registered scheduling controls");
  function seed(sessionId = "session-1", lanes = true) {
    const session = store.createWorkflowSession({ id: sessionId, projectId: "project-1", title: "Scheduling",
      goal: "Scheduling controls", mode: "fast", target: { executionTarget: "current_branch", selectedBranch: "main" },
      plannerProfile: "default", transport: "hermes_replay_recovery", recoveryReason: "Test fixture.", now });
    const { segment } = store.claimPlannerRunStart({ sessionId, laneId: session.plannerLaneId,
      runId: `${sessionId}-planner`, agentKind: "hermes", worktreePath: projectRoot, now });
    store.recordRunResult({ ...segment, evidence: evidence(segment.runId), outputSummary: "", now });
    store.recordPlannerIntentReconciled(segment, now);
    if (lanes) {
      for (const id of ["first", "downstream"]) store.appendWorkflowEvent({ sessionId,
        kind: "workflow.lane.declared", source: "test", idempotencyKey: `lane:${id}`,
        payload: { lane: { id, kind: "validation", title: id, agentKind: "codex", status: "pending" } }, now });
      store.appendWorkflowEvent({ sessionId, kind: "workflow.edge.declared", source: "test",
        payload: { edge: { id: "edge", sourceLaneId: "first", targetLaneId: "downstream" } }, now });
    }
    return session;
  }
  return { main, api, projectRoot, alias, runs, bridge, seed, get store() { return store; },
    preflight: (hook) => { preflight = hook; }, start: (hook) => { start = hook; },
    advance: () => main.advanceWorkflowSession(projectRoot, store, "session-1", true),
    pause: (input = request(), root = alias) => api.workflow.pauseScheduling(root, input),
    resume: (input = request("resume-1", 1, "paused")) => api.workflow.resumeScheduling(projectRoot, input),
    async reopen() {
      store.close();
      main.workflowStores.clear();
      store = await main.getWorkflowStore(alias);
    },
  };
}

test("planner IPC cannot launch a new process for a durably paused session", { timeout: 60000 }, async (t) => {
  const h = await harness(t, false);
  h.seed("session-1", false);
  h.store.pauseWorkflowScheduling({ ...request(), now });
  await assert.rejects(h.api.workflow.appendUserInput(h.alias,
    { sessionId: "session-1", inputId: "paused-turn", text: "Follow up" }), /paused/);
  assert.equal(h.runs.length, 0);
});

test("start-time terminal compensation persists without waiting on its own launch queue", { timeout: 60000 }, async (t) => {
  const h = await harness(t);
  h.seed("session-1", false);
  let compensated = false;
  h.start(async (input) => {
    await h.main.compensateTerminalPersistenceFailure({ projectRoot: h.projectRoot,
      sessionId: input.sessionId, nodeId: input.nodeId, runId: input.runId, agentKind: "hermes",
      reason: "terminal-persistence-failed", evidence: { ...evidence(input.runId), status: "failed",
        exitCode: 1, errorReason: "terminal-persistence-failed" } });
    compensated = true;
  });
  const starting = h.api.workflow.appendUserInput(h.alias,
    { sessionId: "session-1", inputId: "failing-start", text: "Follow up" });
  await until(() => compensated);
  await starting;
  assert.equal((await h.pause()).schedulingState.status, "paused");
  assert.equal(h.store.listRunningSegments().length, 0);
});

test("registered controls suppress queued starts across aliases and isolate sessions", { timeout: 60000 }, async (t) => {
  const h = await harness(t);
  h.seed();
  h.seed("session-2", false);
  const blocker = gate();
  const holding = h.main.enqueueWorkflowProjectAdvance(h.projectRoot, () => blocker.promise);
  const before = h.main.workflowProjectAdvanceTails.get(h.projectRoot);
  const pausing = h.pause();
  await until(() => h.main.workflowProjectAdvanceTails.get(h.projectRoot) !== before);
  const advancing = h.advance();
  blocker.release();
  const paused = await pausing;
  await Promise.all([holding, advancing]);
  assert.equal(paused.projectRoot, h.projectRoot);
  assert.equal(paused.schedulingState.status, "paused");
  assert.equal(paused.canvasSession.schedulingState.status, "paused");
  assert.equal(paused.mutation.created, true);
  assert.equal(h.runs.length, 0);
  await assert.rejects(h.api.workflow.appendUserInput(h.alias,
    { sessionId: "session-1", inputId: "blocked", text: "Follow up" }), /paused/);
  await assert.rejects(h.api.startAgentRun({ projectRoot: h.alias, sessionId: "session-1", nodeId: "first",
    runId: "public", agentKind: "codex", worktreePath: h.projectRoot, prompt: "Run" }), /paused/);
  await h.api.workflow.appendUserInput(h.alias, { sessionId: "session-2", inputId: "other", text: "Follow up" });
  assert.equal(h.runs.length, 1);
  assert.equal(h.runs[0].sessionId, "session-2");
});

for (const kind of ["scheduled", "planner"]) test(`pause waits through admitted ${kind} preflight and start, not run completion`, { timeout: 60000 }, async (t) => {
  const h = await harness(t);
  h.seed("session-1", kind === "scheduled");
  const entered = gate();
  const preflight = gate();
  const startEntered = gate();
  const start = gate();
  t.after(() => { preflight.release(); start.release(); });
  h.preflight(async () => { entered.release(); await preflight.promise; });
  h.start(async () => { startEntered.release(); await start.promise; });
  const launching = kind === "scheduled" ? h.advance() : h.api.workflow.appendUserInput(h.alias,
    { sessionId: "session-1", inputId: "turn-2", text: "Follow up" });
  await entered.promise;
  const before = h.main.workflowProjectAdvanceTails.get(h.projectRoot);
  let returned = false;
  const pausing = h.pause().then((result) => { returned = true; return result; });
  await until(() => h.main.workflowProjectAdvanceTails.get(h.projectRoot) !== before);
  assert.equal(returned, false);
  preflight.release();
  await startEntered.promise;
  assert.equal(returned, false);
  start.release();
  await launching;
  assert.equal((await pausing).schedulingState.status, "paused");
  assert.equal(h.runs.length, 1);
  assert.equal(h.store.listRunningSegments().length, 1);
  assert.equal(h.main.workflowSessionMutationLocks.size, 0);
});

test("paused terminal evidence survives reopen; new resume advances once and old retries return current state", { timeout: 60000 }, async (t) => {
  const h = await harness(t);
  h.seed();
  await h.advance();
  assert.equal(h.runs.length, 1);
  const segment = h.store.listRunningSegments()[0];
  await h.pause();
  const terminal = { kind: "status", runId: segment.runId, payload: { status: "succeeded" } };
  await h.main.reconcileTerminalRunEvent(h.bridge, terminal);
  await h.main.reconcileTerminalWorkflowRun(h.store, h.bridge, h.projectRoot, segment);
  assert.equal(h.store.listEvents("session-1").filter((event) =>
    event.kind === "workflow.segment.finished" && event.payload.segmentId === segment.segmentId).length, 1);
  assert.equal(h.store.listRunningSegments().length, 0);
  assert.equal(h.runs.length, 1);
  const count = () => h.store.listEvents("session-1").length;
  const beforeReopen = count();
  await h.reopen();
  assert.equal(count(), beforeReopen);
  assert.equal(h.runs.length, 1);
  assert.equal((await h.pause()).mutation.created, false);
  const resumed = await h.resume();
  assert.equal(resumed.schedulingState.status, "active");
  assert.equal(resumed.mutation.created, true);
  assert.equal(h.runs.length, 2);
  assert.equal(resumed.canvasSession.nodes.find((node) => node.id === "downstream").runId, h.runs[1].id);
  const afterResume = count();
  let previews = 0;
  const preview = h.store.previewReadyLanes.bind(h.store);
  h.store.previewReadyLanes = (...args) => { previews++; return preview(...args); };
  assert.equal((await h.resume()).mutation.created, false);
  const oldPause = await h.pause();
  assert.equal(oldPause.mutation.status, "paused");
  assert.equal(oldPause.schedulingState.status, "active");
  assert.equal(previews, 0);
  assert.equal(count(), afterResume);
  await h.reopen();
  assert.equal((await h.resume()).mutation.created, false);
  assert.equal(h.runs.length, 2);
  assert.equal(new Set(h.runs.map((run) => run.id)).size, 2);
  await h.pause(request("pause-2", 2));
  assert.equal((await h.resume()).schedulingState.status, "paused");
  assert.equal(h.runs.length, 2);
});

test("strict backend rejects invalid, stale, and conflicting controls without writes or raw payloads", { timeout: 60000 }, async (t) => {
  const h = await harness(t);
  h.seed();
  const before = h.store.listEvents("session-1").length;
  for (const input of [null, [], {}, request(" bad"), request("x", -1), request("x", 0.5),
    request("x", Number.MAX_SAFE_INTEGER), request("x", 0, "paused"), request("x", 1),
    request("x", 0, "active", "missing"), request("x", 0, "active", " session-1")]) {
    await assert.rejects(h.pause(input));
  }
  assert.equal(h.store.listEvents("session-1").length, before);
  const paused = await h.pause({ ...request(), opaqueHandle: "private-handle", now: "untrusted" });
  assert.doesNotMatch(JSON.stringify(paused), /private-handle|untrusted|opaqueHandle/);
  await assert.rejects(h.pause(request("new", 0)), /stale/);
  await assert.rejects(h.resume(request("pause-1", 1, "paused")), /conflict/);
  assert.equal(h.store.listEvents("session-1").length, before + 1);
  assert.equal(h.runs.length, 0);
});
