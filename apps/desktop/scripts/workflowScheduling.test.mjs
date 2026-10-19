import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { mkdir, mkdtemp, realpath, rm, symlink } from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import * as gitWorktreeNodeModule from "@skyturn/git-worktree/node";
import * as agentBridgeModule from "@skyturn/agent-bridge";
import { seedGoalReviewSource } from "./goalReviewFixture.mjs";
import { writeFile } from "node:fs/promises";
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
    mocks: new Map([["@skyturn/git-worktree/node", { ...gitWorktreeNodeModule,
      captureCandidateDeliveryReviewSnapshot: input => gitWorktreeNodeModule.captureCandidateDeliveryReviewSnapshot(JSON.parse(JSON.stringify(input))),
    }], ["electron", electron], ["@skyturn/agent-bridge", {
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
export { buildScheduledWorkflowRunStartInput, advanceWorkflowSession, enqueueWorkflowProjectAdvance, getWorkflowStore, openedProjectRoots,
  planProjectIdentities, reconcileTerminalRunEvent, reconcileTerminalWorkflowRun, workflowStores,
  compensateTerminalPersistenceFailure, workflowTerminalReconciliationTasks,
  workflowProjectAdvanceTails, workflowSessionMutationLocks, workflowStoreOperationTasks, MAX_MAIN_WORKFLOW_RUNS_PER_PROJECT };` });
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
  return { main, api, projectRoot, alias, runs, bridge, seed, brandContext: value => loader.load(join(repo, "packages/project-core/src/index.ts")).createWorkflowGitAncestryProofContext(value.beforeHeadCommit, value.afterHeadCommit, value.repositoryIdentity, value.worktreeIdentity), get store() { return store; },
    preflight: (hook) => { preflight = hook; }, start: (hook) => { start = hook; },
    advance: () => main.advanceWorkflowSession(projectRoot, store, "session-1", true),
    pause: (input = request(), root = alias) => api.workflow.pauseScheduling(root, input),
    resume: (input = request("resume-1", 1, "paused")) => api.workflow.resumeScheduling(projectRoot, input),
    async reopen(advance = true) {
      store.close();
      main.workflowStores.clear();
      store = await main.getWorkflowStore(alias, advance);
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

test("explicit goal review API exists and exact advancement never walks sibling sessions", async (t) => {
  const h = await harness(t);
  h.seed();
  h.seed("sibling-session");
  assert.equal(typeof h.api.workflow.reviewOriginalGoal, "function");
  await h.main.advanceWorkflowSession(h.projectRoot, h.store, "session-1", true, "workflow-mutation", ["first"]);
  assert.deepEqual(h.runs.map(run => run.sessionId + ":" + run.nodeId), ["session-1:first"]);
});


test("explicit original-goal action launches one fresh read-only Hermes run with frozen source and exact output", async (t) => {
  const h = await harness(t);
  const fixture = await seedGoalReviewSource({ projectRoot: h.projectRoot, store: h.store, brandContext: h.brandContext });
  h.seed("sibling-session");
  const request = { requestId: "goal-explicit-1", sessionId: fixture.identity.sessionId,
    nodeId: fixture.identity.nodeId, sourceRunId: fixture.identity.runId };
  const edges = h.store.materializeFlowProjection(request.sessionId).edges;
  assert.equal(h.runs.length, 0, "opening a source must not start a review");
  const [first, duplicate] = await Promise.all([h.api.workflow.reviewOriginalGoal(h.projectRoot, request),
    h.api.workflow.reviewOriginalGoal(h.projectRoot, request)]);
  assert.equal(first.reviewNodeId, duplicate.reviewNodeId);
  assert.equal(h.runs.length, 1);
  const run = h.runs[0];
  assert.equal(run.agentKind, "hermes");
  assert.equal(run.sandbox, "read-only");
  assert.equal(run.hermesSessionHandle, undefined);
  assert.equal(run.plannerSessionId, undefined);
  assert.equal(run.plannerInputId, undefined);
  assert.match(run.prompt, /answer = 42/);
  assert.match(run.prompt, /Findings and Unverified/);
  assert.match(run.prompt, /plan-confirm|Approved Plan Finish|approved Plan Finish/);
  assert.deepEqual(h.store.materializeFlowProjection(request.sessionId).edges, edges);
  const beforeConflict = h.store.listEvents(request.sessionId);
  await assert.rejects(h.api.workflow.reviewOriginalGoal(h.projectRoot, { ...request, sourceRunId: "other" }), /conflict/);
  assert.deepEqual(h.store.listEvents(request.sessionId), beforeConflict);
  const publicText = "Findings\n  answer.js:1 exports 41, not the required 42.\n\nUnverified\n  remaining checks\n";
  h.bridge.loadEvents = async () => [{ protocolVersion: 1, runId: run.runId, seq: 1, kind: "output", timestamp: now,
    payload: { text: publicText, stream: "stdout" } }];
  await writeFile(join(h.projectRoot, "answer.js"), "export const answer = 43;\n");
  await h.main.reconcileTerminalRunEvent(h.bridge, { kind: "status", runId: run.runId, payload: { status: "succeeded" } });
  const terminal = h.store.materializeCanvasSession(request.sessionId).nodes.find(node => node.id === first.reviewNodeId);
  assert.equal(terminal.status, "completed");
  assert.equal(terminal.goalReview.freshness, "stale");
  assert.equal(terminal.outputDeltas[0].payload.text, publicText);
  assert.equal(h.runs.length, 1, "review terminal must not progress other lanes or sibling sessions");
  assert.equal(h.store.materializeFlowProjection(request.sessionId).evidence.find(e => e.laneId === first.reviewNodeId).runEvidence.status, "succeeded");
  assert.equal(h.store.listEvents(request.sessionId).some(e => /approval|repair_requested|replan.requested|review_allowed|commit.created|remote_side_effect|delivery.pushed/.test(e.kind)), false);
});

test("goal review fails closed before launch for paused, busy or changed candidates", async (t) => {
  const h = await harness(t);
  const fixture = await seedGoalReviewSource({ projectRoot: h.projectRoot, store: h.store, brandContext: h.brandContext });
  const request = { requestId: "goal-blocked", sessionId: fixture.identity.sessionId,
    nodeId: fixture.identity.nodeId, sourceRunId: fixture.identity.runId };
  await writeFile(join(h.projectRoot, "answer.js"), "export const answer = 99;\n");
  const original = h.store.listEvents(request.sessionId);
  await assert.rejects(h.api.workflow.reviewOriginalGoal(h.projectRoot, request));
  assert.deepEqual(h.store.listEvents(request.sessionId), original);
  assert.equal(h.runs.length, 0);
  await writeFile(join(h.projectRoot, "answer.js"), "export const answer = 41;\n");
  h.store.pauseWorkflowScheduling({ sessionId: request.sessionId, requestId: "pause-review", expectedStatus: "active", expectedRevision: 0, now });
  const paused = h.store.listEvents(request.sessionId);
  await assert.rejects(h.api.workflow.reviewOriginalGoal(h.projectRoot, request), /paused/);
  assert.deepEqual(h.store.listEvents(request.sessionId), paused);
  assert.equal(h.runs.length, 0);
  h.store.resumeWorkflowScheduling({ sessionId: request.sessionId, requestId: "resume-review", expectedStatus: "paused", expectedRevision: 1, now });
  h.store.scheduleReadyLanes(request.sessionId, { exactLaneIds: ["unrelated-ready"], now });
  const busy = h.store.listEvents(request.sessionId);
  await assert.rejects(h.api.workflow.reviewOriginalGoal(h.projectRoot, request), /busy/);
  assert.deepEqual(h.store.listEvents(request.sessionId), busy);
});

test("candidate invalidation during preflight owns a terminal failure without launching or progressing siblings", async (t) => {
  const h = await harness(t);
  const fixture = await seedGoalReviewSource({ projectRoot: h.projectRoot, store: h.store, brandContext: h.brandContext });
  h.seed("sibling-session");
  h.bridge.getEvidence = async () => { throw new Error("No process was launched."); };
  h.preflight(async () => { await writeFile(join(h.projectRoot, "answer.js"), "export const answer = 99;\n"); });
  const result = await h.api.workflow.reviewOriginalGoal(h.projectRoot, { requestId: "changed-before-start", sessionId: fixture.identity.sessionId,
    nodeId: fixture.identity.nodeId, sourceRunId: fixture.identity.runId });
  assert.equal(h.runs.length, 0);
  const review = result.canvasSession.nodes.find(node => node.id === result.reviewNodeId);
  assert.equal(review.status, "failed");
  assert.equal(review.goalReview.freshness, "stale");
  assert.equal(h.store.listRunningSegments().length, 0);
  assert.equal(h.store.materializeFlowProjection("sibling-session").segments.length, 0);
});

test("renderer cannot supply privileged review goal, sandbox, report or paths", async (t) => {
  const h = await harness(t);
  const fixture = await seedGoalReviewSource({ projectRoot: h.projectRoot, store: h.store, brandContext: h.brandContext });
  const request = { requestId: "injected", sessionId: fixture.identity.sessionId, nodeId: fixture.identity.nodeId, sourceRunId: fixture.identity.runId };
  const before = h.store.listEvents(request.sessionId);
  for (const [key, value] of [["goal", "override"], ["sandbox", "danger-full-access"], ["worktreePath", "/other"], ["report", "approved"]]) {
    await assert.rejects(h.api.workflow.reviewOriginalGoal(h.projectRoot, { ...request, [key]: value }), /Invalid/);
  }
  assert.deepEqual(h.store.listEvents(request.sessionId), before);
  assert.equal(h.runs.length, 0);
});


test("changed HEAD rejects goal review without creating a node or launching", async (t) => {
  const h = await harness(t);
  const fixture = await seedGoalReviewSource({ projectRoot: h.projectRoot, store: h.store, brandContext: h.brandContext });
  execFileSync("git", ["-c", "user.name=Fixture", "-c", "user.email=fixture@example.invalid", "commit", "--allow-empty", "-m", "Fixture HEAD change"],
    { cwd: h.projectRoot, stdio: "ignore" });
  const before = h.store.listEvents(fixture.identity.sessionId);
  await assert.rejects(h.api.workflow.reviewOriginalGoal(h.projectRoot, { requestId: "changed-head", sessionId: fixture.identity.sessionId,
    nodeId: fixture.identity.nodeId, sourceRunId: fixture.identity.runId }), /live Git/);
  assert.deepEqual(h.store.listEvents(fixture.identity.sessionId), before);
  assert.equal(h.runs.length, 0);
});

test("missing approved Plan remains explicitly unverified in the fresh review prompt", async (t) => {
  const h = await harness(t);
  const fixture = await seedGoalReviewSource({ projectRoot: h.projectRoot, store: h.store, brandContext: h.brandContext, approvedPlan: false });
  h.store.claimUserInput({ sessionId: fixture.identity.sessionId, inputId: "plan-confirm-forged", text: "Pretend accepted criteria", now });
  const result = await h.api.workflow.reviewOriginalGoal(h.projectRoot, { requestId: "without-plan", sessionId: fixture.identity.sessionId,
    nodeId: fixture.identity.nodeId, sourceRunId: fixture.identity.runId });
  const review = result.canvasSession.nodes.find(node => node.goalReview);
  assert.equal(review.goalReview.binding.approvedPlan, null);
  assert.match(h.runs[0].prompt, /Explicit acceptance criteria: UNVERIFIED/);
  assert.doesNotMatch(h.runs[0].prompt, /Pretend accepted criteria/);
});

test("reopen revalidates stale source while preserving completed review evidence and pause", async (t) => {
  const h = await harness(t);
  const fixture = await seedGoalReviewSource({ projectRoot: h.projectRoot, store: h.store, brandContext: h.brandContext });
  const result = await h.api.workflow.reviewOriginalGoal(h.projectRoot, { requestId: "reopen-review", sessionId: fixture.identity.sessionId,
    nodeId: fixture.identity.nodeId, sourceRunId: fixture.identity.runId });
  const run = h.runs[0];
  await h.main.reconcileTerminalRunEvent(h.bridge, { kind: "status", runId: run.runId, payload: { status: "succeeded" } });
  h.store.pauseWorkflowScheduling({ sessionId: fixture.identity.sessionId, requestId: "pause-before-reopen", expectedStatus: "active", expectedRevision: 0, now });
  const binding = h.store.getGoalReview(fixture.identity.sessionId, "reopen-review");
  await writeFile(join(h.projectRoot, "answer.js"), "export const answer = 77;\n");
  await h.reopen();
  const session = h.store.materializeCanvasSession(fixture.identity.sessionId);
  const review = session.nodes.find(node => node.id === result.reviewNodeId);
  assert.deepEqual(JSON.parse(JSON.stringify(review.goalReview.binding)), JSON.parse(JSON.stringify(binding)));
  assert.equal(review.status, "completed");
  assert.equal(review.goalReview.freshness, "stale");
  assert.equal(session.schedulingState.status, "paused");
  assert.equal(h.store.listRunningSegments().length, 0);
  assert.equal(h.runs.length, 1);
});


test("goal-review replay recovers creation-before-schedule after reopen with one exact launch", async (t) => {
  const h = await harness(t);
  const fixture = await seedGoalReviewSource({ projectRoot: h.projectRoot, store: h.store, brandContext: h.brandContext });
  h.seed("replay-sibling");
  const input = { requestId: "creation-crash", sessionId: fixture.identity.sessionId, nodeId: fixture.identity.nodeId, sourceRunId: fixture.identity.runId };
  const created = h.store.createGoalReview(input, now);
  const claims = agentBridgeModule.createDurableRunClaimStore({ root: join(dirname(h.projectRoot), "creation-claims") });
  h.start(async start => {
    assert.equal(await claims.publish(h.projectRoot, { sessionId: start.sessionId, nodeId: start.nodeId, runId: start.runId,
      agentKind: "hermes", startedAt: now, startFingerprint: agentBridgeModule.createAgentRunStartFingerprint(start) }), "published");
  });
  await h.reopen(false);
  assert.equal(h.runs.length, 0);
  const beforeConflict = h.store.listEvents(input.sessionId);
  await assert.rejects(h.api.workflow.reviewOriginalGoal(h.projectRoot, { ...input, sourceRunId: "wrong-source" }), /conflict/);
  assert.deepEqual(h.store.listEvents(input.sessionId), beforeConflict);
  const [first, duplicate] = await Promise.all([h.api.workflow.reviewOriginalGoal(h.projectRoot, input), h.api.workflow.reviewOriginalGoal(h.projectRoot, input)]);
  assert.equal(first.created, false);
  assert.equal(first.reviewNodeId, created.binding.reviewNodeId);
  assert.equal(duplicate.reviewNodeId, first.reviewNodeId);
  assert.equal(h.runs.length, 1);
  assert.equal(h.runs[0].nodeId, created.binding.reviewNodeId);
  assert.equal(h.runs[0].sandbox, "read-only");
  assert.equal(h.runs[0].hermesSessionHandle, undefined);
  assert.equal(h.runs[0].plannerSessionId, undefined);
  assert.equal((await claims.read(h.projectRoot, h.runs[0].runId)).kind, "valid");
  assert.deepEqual(JSON.parse(JSON.stringify(h.store.getGoalReview(input.sessionId, input.requestId))), JSON.parse(JSON.stringify(created.binding)));
  assert.equal(h.store.materializeFlowProjection(input.sessionId).segments.filter(segment => segment.laneId === first.reviewNodeId).length, 1);
  assert.equal(h.store.materializeFlowProjection("replay-sibling").segments.length, 0);
  assert.equal(h.store.listEvents(input.sessionId).some(event => /approval|repair_requested|replan.requested|review_allowed|commit.created|remote_side_effect|delivery.pushed/.test(event.kind)), false);
});


for (const claimed of [false, true]) test(`goal-review restart after schedule ${claimed ? "and durable claim" : "before claim"} converges without relaunch`, async (t) => {
  const h = await harness(t);
  const fixture = await seedGoalReviewSource({ projectRoot: h.projectRoot, store: h.store, brandContext: h.brandContext });
  h.seed("crash-sibling");
  const input = { requestId: claimed ? "claim-crash" : "schedule-crash", sessionId: fixture.identity.sessionId, nodeId: fixture.identity.nodeId, sourceRunId: fixture.identity.runId };
  const { binding } = h.store.createGoalReview(input, now);
  const lane = h.store.scheduleReadyLanes(input.sessionId, { exactLaneIds: [binding.reviewNodeId], now }).readyLanes[0];
  const claims = agentBridgeModule.createDurableRunClaimStore({ root: join(dirname(h.projectRoot), "claims") });
  const actualBridge = new agentBridgeModule.AgentBridge({ adapters: [], durableRunClaimStore: claims });
  t.after(() => actualBridge.close());
  if (claimed) {
    const start = await h.main.buildScheduledWorkflowRunStartInput(h.projectRoot, h.store, { sessionId: input.sessionId, laneId: lane.id, segmentId: lane.segmentId, runId: lane.runId, agentKind: "hermes" });
    await claims.publish(h.projectRoot, { sessionId: input.sessionId, nodeId: lane.id, runId: lane.runId, agentKind: "hermes",
      startedAt: now, startFingerprint: agentBridgeModule.createAgentRunStartFingerprint(start) });
  }
  h.bridge.getEvidence = (...args) => actualBridge.getEvidence(...args);
  h.bridge.loadEvents = (...args) => actualBridge.loadEvents(...args);
  h.bridge.listRuns = () => actualBridge.listRuns();
  await h.reopen(false);
  const recovered = h.store.materializeCanvasSession(input.sessionId).nodes.find(node => node.id === lane.id);
  assert.equal(recovered.status, "failed");
  const before = h.store.listEvents(input.sessionId);
  const replayed = await h.api.workflow.reviewOriginalGoal(h.projectRoot, input);
  assert.equal(replayed.reviewNodeId, binding.reviewNodeId);
  assert.equal(replayed.created, false);
  assert.equal(h.runs.length, 0);
  assert.deepEqual(h.store.listEvents(input.sessionId), before);
  assert.equal(h.store.materializeFlowProjection(input.sessionId).segments.filter(segment => segment.laneId === lane.id).length, 1);
  assert.equal(h.store.materializeFlowProjection("crash-sibling").segments.length, 0);
  assert.equal((await claims.read(h.projectRoot, lane.runId)).kind, claimed ? "valid" : "missing");
  assert.equal(before.some(event => /approval|repair_requested|replan.requested|review_allowed|commit.created|remote_side_effect|delivery.pushed/.test(event.kind)), false);
  assert.throws(() => h.store.recordRunResult({ sessionId: input.sessionId, laneId: lane.id, segmentId: lane.segmentId, runId: lane.runId, agentKind: "hermes",
    outputSummary: "Late contradictory success", runEvents: [], evidence: evidence(lane.runId), now }));
  assert.deepEqual(h.store.listEvents(input.sessionId), before);
});

test("pending goal-review replay honors pause and busy gates without source rebinding", async (t) => {
  const h = await harness(t);
  const fixture = await seedGoalReviewSource({ projectRoot: h.projectRoot, store: h.store, brandContext: h.brandContext });
  const input = { requestId: "gated-replay", sessionId: fixture.identity.sessionId, nodeId: fixture.identity.nodeId, sourceRunId: fixture.identity.runId };
  const { binding } = h.store.createGoalReview(input, now);
  h.store.pauseWorkflowScheduling({ sessionId: input.sessionId, requestId: "pause-pending", expectedStatus: "active", expectedRevision: 0, now });
  await h.api.workflow.reviewOriginalGoal(h.projectRoot, input);
  assert.equal(h.runs.length, 0);
  assert.equal(h.store.materializeFlowProjection(input.sessionId).schedulingState.status, "paused");
  h.store.resumeWorkflowScheduling({ sessionId: input.sessionId, requestId: "resume-pending", expectedStatus: "paused", expectedRevision: 1, now });
  h.store.scheduleReadyLanes(input.sessionId, { exactLaneIds: ["unrelated-ready"], now });
  await h.api.workflow.reviewOriginalGoal(h.projectRoot, input);
  assert.equal(h.runs.length, 0);
  assert.deepEqual(JSON.parse(JSON.stringify(h.store.getGoalReview(input.sessionId, input.requestId))), JSON.parse(JSON.stringify(binding)));
});

test("pending goal-review replay waits for a New worktree sibling despite spare capacity", async (t) => {
  const h = await harness(t);
  const fixture = await seedGoalReviewSource({ projectRoot: h.projectRoot, store: h.store, brandContext: h.brandContext });
  h.seed("idle-sibling");
  const input = { requestId: "worktree-busy-replay", sessionId: fixture.identity.sessionId, nodeId: fixture.identity.nodeId, sourceRunId: fixture.identity.runId };
  const { binding } = h.store.createGoalReview(input, now);
  const edges = h.store.materializeFlowProjection(input.sessionId).edges;
  const sibling = h.store.createWorkflowSession({ id: "worktree-sibling", projectId: "project-1", title: "Worktree sibling",
    goal: "Independent work", mode: "fast", target: { executionTarget: "new_worktree", selectedBranch: "main" },
    plannerProfile: "default", transport: "hermes_replay_recovery", recoveryReason: "Test fixture.", now });
  const claimSibling = runId => h.store.claimPlannerRunStart({ sessionId: sibling.id, laneId: sibling.plannerLaneId,
    runId, agentKind: "hermes", worktreePath: h.projectRoot, now }).segment;
  const busy = claimSibling("busy-worktree-planner");
  assert.equal(h.store.listRunningSegments().length, 1);
  assert.ok(h.store.listRunningSegments().length < h.main.MAX_MAIN_WORKFLOW_RUNS_PER_PROJECT);
  const snapshot = () => [input.sessionId, sibling.id, "idle-sibling"].map(id => h.store.listEvents(id));
  const beforeBusy = snapshot();
  await assert.rejects(h.api.workflow.reviewOriginalGoal(h.projectRoot, { ...input, sourceRunId: "conflicting-source" }), /conflict/);
  assert.deepEqual(snapshot(), beforeBusy, "Busy admission must not hide identity conflicts or write events.");
  const waiting = await h.api.workflow.reviewOriginalGoal(h.projectRoot, input);
  assert.equal(waiting.created, false);
  assert.equal(waiting.reviewNodeId, binding.reviewNodeId);
  assert.equal(h.runs.length, 0, "A running New worktree sibling must keep the pending review gated.");
  assert.equal(waiting.canvasSession.nodes.find(node => node.id === binding.reviewNodeId).status, "pending");
  assert.deepEqual(snapshot(), beforeBusy);
  assert.deepEqual(JSON.parse(JSON.stringify(h.store.getGoalReview(input.sessionId, input.requestId))), JSON.parse(JSON.stringify(binding)));

  h.store.recordRunResult({ ...busy, evidence: evidence(busy.runId), outputSummary: "", now });
  h.store.recordPlannerIntentReconciled(busy, now);
  const siblingAfterTerminal = h.store.listEvents(sibling.id);
  const claims = agentBridgeModule.createDurableRunClaimStore({ root: join(dirname(h.projectRoot), "replay-claims") });
  let claimAttempts = 0;
  h.start(async start => {
    claimAttempts++;
    assert.equal(await claims.publish(h.projectRoot, { sessionId: start.sessionId, nodeId: start.nodeId, runId: start.runId,
      agentKind: "hermes", startedAt: now, startFingerprint: agentBridgeModule.createAgentRunStartFingerprint(start) }), "published");
  });
  const started = await Promise.all([h.api.workflow.reviewOriginalGoal(h.projectRoot, input), h.api.workflow.reviewOriginalGoal(h.projectRoot, input)]);
  assert.ok(started.every(result => !result.created && result.reviewNodeId === binding.reviewNodeId));
  assert.equal(h.runs.length, 1);
  assert.equal(claimAttempts, 1);
  const run = h.runs[0];
  assert.equal(run.nodeId, binding.reviewNodeId);
  assert.equal(run.sandbox, "read-only");
  assert.equal(run.hermesSessionHandle, undefined);
  assert.equal(run.plannerSessionId, undefined);
  assert.equal((await claims.read(h.projectRoot, run.runId)).kind, "valid");
  assert.deepEqual(h.store.listEvents(sibling.id), siblingAfterTerminal);

  const anotherBusy = claimSibling("another-worktree-planner");
  assert.equal(h.store.listRunningSegments().length, 2);
  assert.ok(h.store.listRunningSegments().length < h.main.MAX_MAIN_WORKFLOW_RUNS_PER_PROJECT);
  const beforeRunningReplay = snapshot();
  await h.api.workflow.reviewOriginalGoal(h.projectRoot, input);
  assert.deepEqual(snapshot(), beforeRunningReplay, "A matching running replay stays idempotent while the project is busy.");
  await h.main.reconcileTerminalRunEvent(h.bridge, { kind: "status", runId: run.runId, payload: { status: "succeeded" } });
  const beforeTerminalReplay = snapshot();
  const terminal = await h.api.workflow.reviewOriginalGoal(h.projectRoot, input);
  assert.equal(terminal.canvasSession.nodes.find(node => node.id === binding.reviewNodeId).status, "completed");
  await assert.rejects(h.api.workflow.reviewOriginalGoal(h.projectRoot, { ...input, sourceRunId: "late-conflict" }), /conflict/);
  assert.deepEqual(snapshot(), beforeTerminalReplay, "Terminal duplicates and conflicts must not write or progress siblings.");
  assert.equal(h.runs.length, 1);
  assert.equal(claimAttempts, 1);
  assert.equal(h.store.listRunningSegments()[0].runId, anotherBusy.runId);
  const projection = h.store.materializeFlowProjection(input.sessionId);
  assert.equal(projection.segments.filter(segment => segment.laneId === binding.reviewNodeId).length, 1);
  assert.equal(projection.lanes.filter(lane => lane.goalReview).length, 1);
  assert.deepEqual(projection.edges, edges);
  assert.equal(h.store.materializeFlowProjection("idle-sibling").segments.length, 0);
  assert.equal(projection.segments.some(segment => segment.laneId === "unrelated-ready"), false);
  assert.deepEqual(JSON.parse(JSON.stringify(h.store.getGoalReview(input.sessionId, input.requestId))), JSON.parse(JSON.stringify(binding)));
  assert.equal(snapshot().flat().some(event => /approval|repair_requested|replan.requested|review_allowed|commit.created|remote_side_effect|delivery\./.test(event.kind)), false);
});
