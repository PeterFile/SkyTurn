import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { launchElectronAcceptanceApp, connectToReadySkyTurnRenderer, finalizeAcceptanceOutcome,
  waitForStoredProjectRegistration } from "./newSessionUiAcceptance.mjs";
import { goalReviewFixture, seedGoalReviewSource } from "./goalReviewFixture.mjs";

const require = createRequire(import.meta.url);
const script = fileURLToPath(import.meta.url);
const command = promisify(execFile);
const sessionId = goalReviewFixture.sessionId;
const timeoutMs = 5 * 60_000;
const forbidden = /workflow\.(candidate\.review_allowed|node\.repair_requested|replan\.requested|commit\.|remote_side_effect\.|delivery\.|pull_request\.)/;
const hash = value => createHash("sha256").update(value).digest("hex");

/** Predicates consume public facts only; verifier prose never supplies run status or workflow authority. */
export function assertGoalReviewAcceptance({ session, projection, evidence, runs }) {
  const reviews = session.nodes.filter(node => node.goalReview);
  assert.equal(reviews.length, 1);
  const review = reviews[0];
  assert.equal(review.agent, "hermes");
  assert.equal(review.runtimePolicy.sandbox, "read-only");
  assert.equal(review.status, "completed");
  assert.equal(review.goalReview.freshness, "current");
  assert.equal(review.goalReview.binding.originalGoal, goalReviewFixture.originalGoal);
  assert.equal(review.goalReview.binding.approvedPlan.text, goalReviewFixture.approvedPlan);
  assert.equal(review.goalReview.binding.request.nodeId, goalReviewFixture.sourceNodeId);
  assert.equal(evidence.runId, review.runId);
  assert.equal(evidence.status, "succeeded");
  assert.equal(evidence.exitCode, 0);
  assert.ok(evidence.checks.some(check => check.kind === "run-exit" && check.name === "Hermes CLI exit" && check.status === "passed"));
  assert.deepEqual(runs.map(run => run.id), [review.runId]);
  assert.ok(projection.segments.some(segment => segment.laneId === review.id && segment.runId === review.runId && segment.status === "succeeded"));
  assert.equal(projection.events.some(event => forbidden.test(event.kind)), false);
  assert.equal(projection.edges.some(edge => [edge.sourceLaneId, edge.targetLaneId].includes(review.id)), false);
  const output = (review.outputDeltas ?? []).filter(delta => delta.kind === "output").map(delta => delta.payload.text).join("");
  assert.match(output, /Findings|Unverified/i);
  assert.match(output, /41/);
  assert.match(output, /42/);
  assert.ok(output.length > 0, "Real verifier must discuss the genuinely unmet goal.");
  return { reviewId: review.id, runId: review.runId, binding: review.goalReview.binding, outputHash: hash(output) };
}

async function nodeMode(mode, config) {
  // Uses the installed Electron ABI, with no native rebuild or provider process in seed/inspect mode.
  const result = await command(require("electron"), [script, mode, JSON.stringify(config)], {
    env: { ...process.env, ELECTRON_RUN_AS_NODE: "1" }, timeout: 30_000, maxBuffer: 2 * 1024 * 1024,
  });
  const line = result.stdout.split("\n").find(line => line.startsWith("GOAL_REVIEW_FACTS="));
  if (!line) throw new Error("Acceptance worker returned no facts.");
  return JSON.parse(line.slice("GOAL_REVIEW_FACTS=".length));
}

async function seed(config) {
  const { createWorkflowStore } = await import("@skyturn/persistence/workflow-store");
  const { emptyWorkspace } = await import("@skyturn/persistence");
  await command("git", ["init", "-b", "main", config.projectRoot], { timeout: 10_000 });
  const store = createWorkflowStore({ projectRoot: config.projectRoot });
  try {
    const fixture = await seedGoalReviewSource({ projectRoot: config.projectRoot, store });
    // Existing scheduler activity is separately tested deterministically. Keep this real gate verifier-only.
    store.appendWorkflowEvent({ sessionId, kind: "workflow.lane.declared", source: "fixture", now: new Date().toISOString(),
      payload: { lane: { id: goalReviewFixture.unrelatedNodeId, kind: "validation", title: "Unrelated task (waiting)", status: "waiting_input" } } });
    const session = store.materializeCanvasSession(sessionId);
    const project = { id: session.projectId, name: basename(config.projectRoot), rootPath: config.projectRoot,
      canonicalRootPath: config.projectRoot, devflowPath: join(config.projectRoot, ".devflow"), openedAt: session.createdAt };
    await writeFile(join(config.userData, "workspace.json"), JSON.stringify({ ...emptyWorkspace(),
      projects: [project], sessions: [session], activeProjectId: project.id, activeSessionId: session.id }));
    return { headCommit: fixture.headCommit, sourceRunId: fixture.identity.runId };
  } finally { store.close(); }
}
async function inspect(config) {
  const { createWorkflowStore } = await import("@skyturn/persistence/workflow-store");
  const store = createWorkflowStore({ projectRoot: config.projectRoot });
  try { return { session: store.materializeCanvasSession(sessionId), projection: store.materializeFlowProjection(sessionId) }; }
  finally { store.close(); }
}
async function facts(cdp, projectRoot) {
  return cdp.evaluate(`(async () => {
    const response = await window.devflow.workflow.getProjection(${JSON.stringify(projectRoot)}, ${JSON.stringify(sessionId)});
    const node = response.canvasSession.nodes.find(node => node.goalReview);
    const evidence = node ? (await window.devflow.getRunEvidence(${JSON.stringify(projectRoot)}, node.runId)).evidence : null;
    return { session: response.canvasSession, projection: response.projection, evidence,
      runs: (await window.devflow.listAgentRuns()).runs };
  })()`, { awaitPromise: true, returnByValue: true });
}
export async function clickOriginalGoalReview(cdp, nodeId) {
  await cdp.evaluate(`(() => {
    const card = document.querySelector('.react-flow__node[data-id="' + ${JSON.stringify(nodeId)} + '"]');
    const more = card?.querySelector('button[aria-label^="More details for"]');
    if (!more) throw new Error('Source More button unavailable.');
    more.click();
  })()`);
  await cdp.evaluate(`(async () => {
    const deadline = Date.now() + 15000;
    while (Date.now() < deadline) {
      const button = document.querySelector('.node-modal button[aria-label="Review original goal"]');
      if (button && !button.disabled) { button.click(); return; }
      await new Promise(resolve => requestAnimationFrame(resolve));
    }
    throw new Error('Visible original-goal review action unavailable.');
  })()`, { awaitPromise: true });
}
async function gitFingerprint(projectRoot) {
  const head = (await command("git", ["rev-parse", "HEAD"], { cwd: projectRoot })).stdout.trim();
  const status = (await command("git", ["status", "--porcelain=v1", "--untracked-files=all", "--", ".",
    ":(top,exclude).devflow/skyturn-workflow.sqlite", ":(top,exclude).devflow/skyturn-workflow.sqlite-wal",
    ":(top,exclude).devflow/skyturn-workflow.sqlite-shm", ":(top,glob,exclude).devflow/runs/**",
    ":(top,glob,exclude).devflow/tasks/**/output.md"], { cwd: projectRoot, env: { ...process.env, GIT_OPTIONAL_LOCKS: "0" } })).stdout;
  return { head, status, answerHash: hash(await readFile(join(projectRoot, "answer.js"))),
    indexHash: hash(await readFile(join(projectRoot, ".git/index"))),
    refs: (await command("git", ["show-ref"], { cwd: projectRoot })).stdout };
}

export async function runGoalReviewUiAcceptance() {
  const root = await realpath(await mkdtemp(join(tmpdir(), "skyturn-goal-review-ui-")));
  const config = { projectRoot: join(root, "project"), userData: join(root, "user-data") };
  await mkdir(config.projectRoot); await mkdir(config.userData);
  let app = null, cdp = null, stage = "seed", cleanupConfirmed = true;
  const deadline = Date.now() + timeoutMs;
  try {
    const seeded = await nodeMode("--seed", config);
    const gitBefore = await gitFingerprint(config.projectRoot);
    stage = "visible-action";
    cleanupConfirmed = false;
    app = await launchElectronAcceptanceApp(config);
    cdp = await connectToReadySkyTurnRenderer({ cdpPort: app.cdpPort, devServerUrl: app.devServerUrl,
      projectRoot: config.projectRoot, processDiagnostics: app.diagnostics });
    await waitForStoredProjectRegistration(cdp, config.projectRoot);
    const before = await facts(cdp, config.projectRoot);
    assert.equal(before.session.nodes.filter(node => node.goalReview).length, 0);
    assert.deepEqual(before.runs, []);
    await clickOriginalGoalReview(cdp, goalReviewFixture.sourceNodeId);
    stage = "real-hermes-terminal";
    let completed;
    while (Date.now() < deadline) {
      const current = await facts(cdp, config.projectRoot);
      const review = current.session.nodes.find(node => node.goalReview);
      if (review && ["completed", "failed"].includes(review.status)) { completed = current; break; }
      await new Promise(resolve => setTimeout(resolve, 250));
    }
    if (!completed) throw new Error("Real review terminal deadline exceeded.");
    const verified = assertGoalReviewAcceptance(completed);
    assert.equal(verified.binding.request.sourceRunId, seeded.sourceRunId);
    assert.deepEqual(await gitFingerprint(config.projectRoot), gitBefore);
    stage = "sqlite-reopen";
    const firstClose = await finalizeAcceptanceOutcome({ app, liveCdp: cdp, ok: true });
    if (!firstClose.ok || !firstClose.cleanupConfirmed) throw new Error("Owned process shutdown failed.");
    app = null; cdp = null; cleanupConfirmed = true;
    const reopened = await nodeMode("--inspect", config);
    const saved = reopened.session.nodes.find(node => node.id === verified.reviewId);
    assert.deepEqual(saved.goalReview, completed.session.nodes.find(node => node.id === verified.reviewId).goalReview);
    assert.deepEqual(saved.outputDeltas, completed.session.nodes.find(node => node.id === verified.reviewId).outputDeltas);
    stage = "electron-restart";
    app = await launchElectronAcceptanceApp(config); cleanupConfirmed = false;
    cdp = await connectToReadySkyTurnRenderer({ cdpPort: app.cdpPort, devServerUrl: app.devServerUrl,
      projectRoot: config.projectRoot, processDiagnostics: app.diagnostics });
    await waitForStoredProjectRegistration(cdp, config.projectRoot);
    const restarted = await facts(cdp, config.projectRoot);
    assert.deepEqual(restarted.runs, [], "Restart must not relaunch terminal verifier or unrelated work.");
    const replayed = restarted.session.nodes.find(node => node.id === verified.reviewId);
    assert.deepEqual(replayed.goalReview.binding, verified.binding);
    assert.equal(replayed.status, "completed");
    assert.deepEqual(replayed.outputDeltas, saved.outputDeltas);
    assert.deepEqual(await gitFingerprint(config.projectRoot), gitBefore);
    stage = "owned-process-cleanup";
    const finalClose = await finalizeAcceptanceOutcome({ app, liveCdp: cdp, ok: true });
    if (!finalClose.ok || !finalClose.cleanupConfirmed) throw new Error("Owned process shutdown failed.");
    app = null; cdp = null; cleanupConfirmed = true;
    const inventory = (await command("ps", ["-axo", "pid=,args="], { maxBuffer: 4 * 1024 * 1024 })).stdout;
    assert.equal(inventory.split("\n").filter(line => line.includes(root) && Number(line.trim().split(/\s+/)[0]) !== process.pid).length, 0);
    await rm(root, { recursive: true, force: true });
    return { ok: true, syntheticSource: true, realHermesVerifier: true, readOnly: true, unmetGoalReported: true,
      sqliteReopen: true, electronRestart: true, unintendedGitMutation: false, otherRunStarts: 0, ownedProcessLeftovers: 0 };
  } catch {
    if (app && cdp) {
      const cleanup = await finalizeAcceptanceOutcome({ app, liveCdp: cdp, ok: false, error: new Error("Goal review acceptance failed.") });
      cleanupConfirmed = cleanup.ok && cleanup.cleanupConfirmed;
    } else if (app) {
      // No visible action was admitted before renderer connection; close the owned launch resources.
      try { await app.close(); cleanupConfirmed = true; }
      catch { cleanupConfirmed = false; }
    }
    return { ok: false, stage, cleanupConfirmed, syntheticSource: true, realVerifierUnverified: true };
  }
}

if (process.argv[1] === script) {
  if (["--seed", "--inspect"].includes(process.argv[2])) {
    const config = JSON.parse(process.argv[3]);
    const result = process.argv[2] === "--seed" ? await seed(config) : await inspect(config);
    process.stdout.write(`GOAL_REVIEW_FACTS=${JSON.stringify(result)}\n`);
  } else {
    const result = await runGoalReviewUiAcceptance();
    process.stdout.write(`${JSON.stringify(result)}\n`);
    if (!result.ok) process.exitCode = 1;
  }
}
