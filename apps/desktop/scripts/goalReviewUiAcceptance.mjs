import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { createHash, randomInt } from "node:crypto";
import { mkdir, mkdtemp, readFile, realpath, rename, rm, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { basename, isAbsolute, join, relative, resolve } from "node:path";
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
export function assertGoalReviewAcceptance({ session, projection, evidence, runs }, observedValue) {
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
  assert.equal(runs[0].plannerSessionId, undefined);
  assert.equal(runs[0].plannerInputId, undefined);
  const segments = projection.segments.filter(segment => segment.laneId === review.id);
  assert.equal(segments.length, 1);
  assert.ok(segments[0].runId === review.runId && segments[0].status === "succeeded");
  assert.equal(projection.events.some(event => forbidden.test(event.kind)), false);
  assert.equal(projection.edges.some(edge => [edge.sourceLaneId, edge.targetLaneId].includes(review.id)), false);
  const output = (review.outputDeltas ?? []).filter(delta => delta.kind === "output").map(delta => delta.payload.text).join("");
  assertObservedGoalFinding(output, observedValue);
  return { reviewId: review.id, reviewSegmentId: segments[0].id, runId: review.runId, binding: review.goalReview.binding, outputHash: hash(review.output.join("")) };
}

export function assertObservedGoalFinding(output, observedValue) {
  assert.ok(Number.isSafeInteger(observedValue) && observedValue !== 42, "Independent observation required.");
  assert.ok(typeof output === "string" && output.length <= 1_048_576, "Report unavailable or oversized.");
  const sections = [];
  let active = false, lines = [];
  for (const line of output.split("\n")) {
    const heading = line.match(/^\s*(?:#{1,6}\s+(.+?)|\*\*(.+?)\*\*\s*:?)\s*$/);
    const bare = line.match(/^\s*(Findings|Unverified)\s*:?\s*$/i);
    if (heading || bare) {
      if (active) sections.push(lines.join("\n"));
      active = /^(Findings|Unverified)$/i.test((heading?.[1] ?? heading?.[2] ?? bare[1]).replace(/:$/, "").trim());
      lines = [];
    } else if (active) lines.push(line);
  }
  if (active) sections.push(lines.join("\n"));
  const observation = new RegExp(`(^|[^0-9A-Za-z])${observedValue}([^0-9A-Za-z]|$)`);
  assert.ok(sections.some(section => section.split(/\n\s*\n|\n(?=\s*[-*]\s)/).some(paragraph =>
    paragraph.length <= 2_048 && /\banswer\.js(?::[0-9]+)?\b/i.test(paragraph) && observation.test(paragraph))),
    "Findings/Unverified must cite answer.js and its independently observed value.");
}

export function assertGoalReviewDom(dom, expected) {
  assert.equal(dom.cardId, expected.reviewId);
  assert.equal(dom.title, "Review original goal");
  assert.equal(dom.status, "completed");
  assert.equal(dom.visible, true);
  assert.match(dom.advisory, /advisory/i);
  assert.match(dom.advisory, /unverified/i);
  assert.equal(hash(dom.outputText), expected.outputHash, "Visible raw Output must match exact authoritative text.");
  const binding = expected.binding;
  for (const text of [binding.originalGoal, binding.manifest.runId, binding.manifest.afterCheckpointId,
    binding.manifest.afterHeadCommit, binding.manifestSha256, binding.approvedPlan.eventId,
    `seq ${binding.approvedPlan.seq}`, binding.approvedPlan.text]) {
    assert.ok(dom.contextText.includes(text), "Visible Context must retain original source provenance.");
  }
}

export async function saveGoalReviewScreenshot(cdp, evidenceDir, name) {
  assert.ok(["action", "report-before", "context-before", "report-after", "context-after", "failure"].includes(name));
  const clip = await cdp.evaluate(`(() => {
    const element = document.querySelector('.node-modal') ?? document.querySelector('.react-flow');
    if (!element) throw new Error('Visible acceptance surface unavailable.');
    const rect = element.getBoundingClientRect();
    return { x: Math.max(0, rect.x), y: Math.max(0, rect.y),
      width: Math.min(rect.width, innerWidth - Math.max(0, rect.x)),
      height: Math.min(rect.height, innerHeight - Math.max(0, rect.y)), scale: 1 };
  })()`);
  assert.ok(clip.width >= 200 && clip.height >= 100, "Screenshot surface is not visible.");
  const response = await cdp.call("Page.captureScreenshot", { format: "png", captureBeyondViewport: false,
    fromSurface: true, clip: { ...clip, scale: 1 } });
  const data = response.result?.data;
  assert.ok(typeof data === "string" && data.length <= 12 * 1024 * 1024 && /^[A-Za-z0-9+/=]+$/.test(data));
  const png = Buffer.from(data, "base64");
  assert.ok(png.length >= 64 && png.subarray(0, 8).equals(Buffer.from("89504e470d0a1a0a", "hex")) &&
    png.toString("ascii", 12, 16) === "IHDR" && png.readUInt32BE(16) >= 200 && png.readUInt32BE(20) >= 100, "Invalid UI screenshot.");
  const file = `${name}.png`;
  await writeFile(join(evidenceDir, file), png, { mode: 0o600 });
  return { file, bytes: png.length, sha256: hash(png) };
}

export async function saveGoalReviewReceipt(evidenceDir, disposableRoot, receipt) {
  const evidence = await realpath(evidenceDir);
  const disposable = await realpath(disposableRoot).catch(error => { if (error.code === "ENOENT") return resolve(disposableRoot); throw error; });
  const relativePath = relative(disposable, evidence);
  assert.ok(relativePath && (relativePath.startsWith(`..${process.platform === "win32" ? "\\" : "/"}`) || isAbsolute(relativePath)), "Evidence must survive disposable cleanup.");
  const keys = ["version", "ok", "stage", "code", "cleanupConfirmed", "evidenceDir", "screenshots", "candidate", "checks", "identifiers", "provenance", "outputHash", "startFingerprint", "launch", "ownedProcessLeftovers"];
  assert.ok(Object.keys(receipt).every(key => keys.includes(key)), "Unexpected receipt field.");
  const text = JSON.stringify(receipt, null, 2) + "\n";
  assert.ok(Buffer.byteLength(text) <= 32_768 && ![disposableRoot, disposable].some(path => text.includes(JSON.stringify(path).slice(1, -1))), "Receipt must be bounded and exclude private runtime paths.");
  const file = join(evidence, "receipt.json");
  const pending = join(evidence, "receipt.pending");
  await writeFile(pending, text, { mode: 0o600 });
  await rename(pending, file);
  return file;
}

export function goalReviewFailureResult(stage, error, evidenceDir, cleanup) {
  const allowedStages = ["seed", "visible-action", "real-hermes-terminal", "report", "sqlite-reopen", "electron-restart", "owned-process-cleanup", "receipt", "dispose"];
  const code = error?.code === "ERR_ASSERTION" ? "predicate-failed" : error?.code === "ENOENT" ? "required-file-missing" :
    error?.code === "EACCES" ? "evidence-access-denied" : /timeout|timed out|deadline/i.test(String(error?.message)) ? "deadline-exceeded" : "stage-failed";
  return { ok: false, stage: allowedStages.includes(stage) ? stage : "report", code,
    evidenceDir, cleanupConfirmed: cleanup?.cleanupConfirmed === true, syntheticSource: true, realVerifierUnverified: true };
}

// Every expression here reads the visible renderer. No protected projection read can materialize this oracle.
export async function readGoalReviewDom(cdp, { reviewId, terminal = false, waitMs = 15000 } = {}) {
  assert.ok(Number.isInteger(waitMs) && waitMs > 0 && waitMs <= timeoutMs);
  return cdp.evaluate(`(async () => {
    const expectedId = ${JSON.stringify(reviewId ?? null)};
    const waitFor = async (probe, limit = 15000) => {
      const deadline = Date.now() + limit;
      while (Date.now() < deadline) { const value = probe(); if (value) return value; await new Promise(resolve => requestAnimationFrame(resolve)); }
      throw new Error('Visible goal-review DOM deadline exceeded.');
    };
    const card = await waitFor(() => [...document.querySelectorAll('.react-flow__node[data-id]')].find(element =>
      expectedId ? element.getAttribute('data-id') === expectedId : element.querySelector('.agent-node-title')?.textContent === 'Review original goal'));
    if (${terminal}) await waitFor(() => ['completed', 'failed'].includes(card.querySelector('.agent-node-shell')?.getAttribute('data-state')), ${waitMs});
    const close = document.querySelector('.node-modal button[aria-label="Close"]');
    if (close) { close.click(); await waitFor(() => !document.querySelector('.node-modal')); }
    card.querySelector('button[aria-label^="More details for"]').click();
    const modal = await waitFor(() => document.querySelector('.node-modal'));
    const tab = label => [...modal.querySelectorAll('.modal-tabs button')].find(button => button.textContent === label);
    tab('Output').click();
    const raw = await waitFor(() => [...modal.querySelectorAll('.result-output-toolbar button')].find(button => button.textContent === 'Raw text'));
    raw.click();
    const output = await waitFor(() => modal.querySelector('.result-output-raw code') ?? (modal.querySelector('.result-output')?.textContent.includes('No node output yet.') ? { textContent: '' } : null));
    const outputText = output.textContent;
    [...modal.querySelectorAll('.result-output-toolbar button')].find(button => button.textContent === 'Preview').click();
    if (outputText) await waitFor(() => modal.querySelector('.result-output-preview'));
    tab('Context').click();
    const context = await waitFor(() => modal.querySelector('[aria-label="Original-goal review provenance"]'));
    const contextText = context.textContent;
    const rect = card.getBoundingClientRect();
    return { cardId: card.getAttribute('data-id'), title: card.querySelector('.agent-node-title')?.textContent,
      status: card.querySelector('.agent-node-shell')?.getAttribute('data-state'),
      visible: rect.width > 0 && rect.height > 0 && rect.right > 0 && rect.bottom > 0 && rect.left < innerWidth && rect.top < innerHeight,
      advisory: modal.querySelector('[aria-label="Advisory review status"]')?.textContent ?? '', outputText, contextText };
  })()`, { awaitPromise: true, returnByValue: true, requestTimeoutMs: waitMs + 60000 });
}

async function selectEvidenceTab(cdp, tab, observedValue) {
  await cdp.evaluate(`(async () => {
    const modal = document.querySelector('.node-modal');
    [...modal.querySelectorAll('.modal-tabs button')].find(button => button.textContent === ${JSON.stringify(tab)}).click();
    const selector = ${JSON.stringify(tab === "Output" ? ".result-output-preview" : '[aria-label="Original-goal review provenance"]')};
    const deadline = Date.now() + 15000;
    while (!modal.querySelector(selector)) { if (Date.now() > deadline) throw new Error('Visible tab deadline exceeded.'); await new Promise(resolve => requestAnimationFrame(resolve)); }
    let target = modal.querySelector(selector);
    if (${JSON.stringify(tab)} === 'Output') {
      const paragraphs = [...target.querySelectorAll('p, li, pre')];
      target = paragraphs.find(element => element.textContent.includes('answer.js') && element.textContent.includes(${JSON.stringify(String(observedValue))})) ?? target;
    }
    target.scrollIntoView({ block: 'center' });
  })()`, { awaitPromise: true });
}

async function candidateCodeIdentity() {
  const repository = fileURLToPath(new URL("../../..", import.meta.url));
  const sourcePaths = ["apps/desktop/electron/main.ts", "apps/desktop/electron/preload.ts", "apps/desktop/scripts/goalReviewFixture.mjs",
    "apps/desktop/scripts/goalReviewUiAcceptance.mjs", "packages/persistence/src/workflowStore.ts", "packages/project-core/src/index.ts", "packages/project-core/src/goalReview.ts",
    "packages/workflow-kernel/src/index.ts", "packages/ui-canvas/src/workflowRuntime.ts", "packages/ui-canvas/src/App.tsx"];
  const runtimePaths = ["apps/desktop/dist-electron/electron/main.js", "apps/desktop/dist-electron/electron/preload.js",
    "packages/project-core/dist/index.js", "packages/project-core/dist/goalReview.js", "packages/persistence/dist/workflowStore.js",
    "packages/workflow-kernel/dist/index.js", "packages/ui-canvas/dist/workflowRuntime.js", "packages/ui-canvas/dist/App.js", "packages/agent-bridge/dist/index.js"];
  const hashes = async paths => Object.fromEntries(await Promise.all(paths.map(async path => [path, hash(await readFile(join(repository, path)))])));
  return { headCommit: (await command("git", ["rev-parse", "HEAD"], { cwd: repository })).stdout.trim(),
    sourceHashes: await hashes(sourcePaths), runtimeHashes: await hashes(runtimePaths) };
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
    const fixture = await seedGoalReviewSource({ projectRoot: config.projectRoot, store, observedValue: config.observedValue });
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
  try {
    const session = store.materializeCanvasSession(sessionId);
    const review = session.nodes.find(node => node.goalReview);
    let launchProof = null;
    if (review) {
      const { createAgentRunStartFingerprint, createDurableRunClaimStore } = await import("@skyturn/agent-bridge");
      const { buildPromptForNodeRun } = await import("@skyturn/ui-canvas/workflow-runtime");
      const claims = createDurableRunClaimStore({ root: join(config.userData, "run-claims") });
      const claim = await claims.read(config.projectRoot, review.runId);
      const expectedFingerprint = createAgentRunStartFingerprint({ protocolVersion: 1, runId: review.runId,
        nodeId: review.id, sessionId: session.id, projectRoot: config.projectRoot, worktreePath: config.projectRoot,
        agentKind: "hermes", sandbox: "read-only", prompt: buildPromptForNodeRun(session, review) });
      launchProof = { readOnlyNoResume: claim.kind === "valid" && claim.claim.startFingerprint === expectedFingerprint,
        startFingerprint: claim.kind === "valid" ? claim.claim.startFingerprint : null };
    }
    return { session, projection: store.materializeFlowProjection(sessionId), launchProof };
  }
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
export async function clickOriginalGoalReview(cdp, nodeId, { beforeClick } = {}) {
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
      if (button && !button.disabled) return;
      await new Promise(resolve => requestAnimationFrame(resolve));
    }
    throw new Error('Visible original-goal review action unavailable.');
  })()`, { awaitPromise: true });
  if (beforeClick) await beforeClick();
  await cdp.evaluate(`(() => {
    const button = document.querySelector('.node-modal button[aria-label="Review original goal"]');
    if (!button || button.disabled) throw new Error('Visible review action became unavailable.');
    button.click();
  })()`);
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

export async function verifyGoalReviewRestart(cdp, expected, corroborate) {
  const dom = await readGoalReviewDom(cdp, { reviewId: expected.reviewId, terminal: true });
  assertGoalReviewDom(dom, expected);
  return corroborate();
}

export async function runGoalReviewUiAcceptance() {
  const base = resolve(process.env.SKYTURN_GOAL_REVIEW_EVIDENCE_DIR ?? tmpdir());
  let root, evidenceDir;
  try {
    root = await realpath(await mkdtemp(join(tmpdir(), "skyturn-goal-review-ui-")));
    await mkdir(base, { recursive: true, mode: 0o700 });
    evidenceDir = await realpath(await mkdtemp(join(base, "goal-review-evidence-")));
  } catch (error) {
    return { ...goalReviewFailureResult("seed", error, base, { cleanupConfirmed: true }), receiptWritten: false };
  }
  const config = { projectRoot: join(root, "project"), userData: join(root, "user-data"), observedValue: randomInt(10_000_000, 100_000_000) };
  let app = null, cdp = null, stage = "seed", cleanup = { cleanupConfirmed: true };
  const receipt = { version: 1, ok: false, stage, code: null, cleanupConfirmed: true, evidenceDir,
    screenshots: [], candidate: null, checks: { processEvidence: null, independentFinding: null, domBefore: null,
      domAfter: null, sqliteReopen: null, restart: null, readOnlyNoResume: null, gitUnchanged: null, otherRunStarts: null, ownedProcessCleanup: null } };
  const closeOwned = async (ok, error = null) => {
    cleanup = await finalizeAcceptanceOutcome({ app, liveCdp: cdp, ok, error });
    if (cleanup.cleanupConfirmed === true) { app = null; cdp = null; }
    receipt.cleanupConfirmed = cleanup.cleanupConfirmed === true;
    return cleanup;
  };
  const screenshots = async suffix => {
    await selectEvidenceTab(cdp, "Output", config.observedValue);
    receipt.screenshots.push(await saveGoalReviewScreenshot(cdp, evidenceDir, `report-${suffix}`));
    await selectEvidenceTab(cdp, "Context");
    receipt.screenshots.push(await saveGoalReviewScreenshot(cdp, evidenceDir, `context-${suffix}`));
  };
  try {
    await mkdir(config.projectRoot); await mkdir(config.userData);
    receipt.candidate = await candidateCodeIdentity();
    const seeded = await nodeMode("--seed", config);
    const gitBefore = await gitFingerprint(config.projectRoot);
    stage = "visible-action";
    cleanup = { cleanupConfirmed: false };
    app = await launchElectronAcceptanceApp(config);
    cdp = await connectToReadySkyTurnRenderer({ cdpPort: app.cdpPort, devServerUrl: app.devServerUrl,
      projectRoot: config.projectRoot, processDiagnostics: app.diagnostics });
    // Startup must render the source before any protected projection corroboration.
    await cdp.evaluate(`(async () => {
      const deadline = Date.now() + 15000;
      while (!document.querySelector('.react-flow__node[data-id="${goalReviewFixture.sourceNodeId}"]')) {
        if (Date.now() > deadline) throw new Error('Source card DOM unavailable.');
        await new Promise(resolve => requestAnimationFrame(resolve));
      }
    })()`, { awaitPromise: true });
    await waitForStoredProjectRegistration(cdp, config.projectRoot);
    const before = await facts(cdp, config.projectRoot);
    assert.equal(before.session.nodes.filter(node => node.goalReview).length, 0);
    assert.deepEqual(before.runs, []);
    await clickOriginalGoalReview(cdp, goalReviewFixture.sourceNodeId, { beforeClick: async () => {
      receipt.screenshots.push(await saveGoalReviewScreenshot(cdp, evidenceDir, "action"));
    } });
    stage = "real-hermes-terminal";
    const rendered = await readGoalReviewDom(cdp, { terminal: true, waitMs: timeoutMs });
    stage = "report";
    const completed = await facts(cdp, config.projectRoot);
    const verified = assertGoalReviewAcceptance(completed, config.observedValue);
    receipt.checks.processEvidence = true;
    receipt.checks.independentFinding = true;
    assertGoalReviewDom(rendered, verified);
    receipt.checks.domBefore = true;
    assert.equal(verified.binding.request.sourceRunId, seeded.sourceRunId);
    receipt.identifiers = { sourceSessionId: verified.binding.manifest.sessionId, sourceNodeId: verified.binding.manifest.nodeId,
      sourceLaneId: verified.binding.manifest.laneId, sourceSegmentId: verified.binding.manifest.segmentId,
      sourceRunId: seeded.sourceRunId, reviewNodeId: verified.reviewId, reviewSegmentId: verified.reviewSegmentId, reviewRunId: verified.runId };
    receipt.provenance = { manifestSha256: verified.binding.manifestSha256, afterCheckpointId: verified.binding.manifest.afterCheckpointId,
      sourceHeadCommit: verified.binding.manifest.afterHeadCommit, patchSha256: verified.binding.manifest.fullPatchSha256,
      fileManifestSha256: verified.binding.manifest.fileManifestSha256, originalGoalSha256: hash(verified.binding.originalGoal),
      approvedPlanEventId: verified.binding.approvedPlan.eventId, approvedPlanSeq: verified.binding.approvedPlan.seq,
      approvedPlanTextSha256: hash(verified.binding.approvedPlan.text) };
    receipt.outputHash = verified.outputHash;
    await screenshots("before");
    assert.deepEqual(await gitFingerprint(config.projectRoot), gitBefore);
    stage = "sqlite-reopen";
    Object.assign(receipt, { stage, cleanupConfirmed: false });
    await saveGoalReviewReceipt(evidenceDir, root, receipt);
    const firstClose = await closeOwned(true);
    assert.ok(firstClose.ok && firstClose.cleanupConfirmed, "Owned process shutdown failed.");
    const reopened = await nodeMode("--inspect", config);
    const saved = reopened.session.nodes.find(node => node.id === verified.reviewId);
    assert.deepEqual(saved.goalReview, completed.session.nodes.find(node => node.id === verified.reviewId).goalReview);
    assert.deepEqual(saved.outputDeltas, completed.session.nodes.find(node => node.id === verified.reviewId).outputDeltas);
    assert.equal(reopened.launchProof?.readOnlyNoResume, true, "Actual launch fingerprint must bind read-only and omitted continuity fields.");
    receipt.startFingerprint = reopened.launchProof.startFingerprint;
    receipt.launch = { sandbox: "read-only", continuity: "omitted", fingerprintVerified: true };
    receipt.checks.readOnlyNoResume = true;
    receipt.checks.sqliteReopen = true;
    stage = "electron-restart";
    cleanup = { cleanupConfirmed: false };
    app = await launchElectronAcceptanceApp(config);
    cdp = await connectToReadySkyTurnRenderer({ cdpPort: app.cdpPort, devServerUrl: app.devServerUrl,
      projectRoot: config.projectRoot, processDiagnostics: app.diagnostics });
    const restarted = await verifyGoalReviewRestart(cdp, verified, async () => {
      receipt.checks.domAfter = true;
      await screenshots("after");
      // Only corroborate after the restarted card, Output, and Context have passed DOM checks.
      return facts(cdp, config.projectRoot);
    });
    assert.deepEqual(restarted.runs, [], "Restart must not relaunch terminal verifier or unrelated work.");
    receipt.checks.otherRunStarts = true;
    const replayed = restarted.session.nodes.find(node => node.id === verified.reviewId);
    assert.deepEqual(replayed.goalReview.binding, verified.binding);
    assert.equal(replayed.status, "completed");
    assert.deepEqual(replayed.outputDeltas, saved.outputDeltas);
    assert.deepEqual(await gitFingerprint(config.projectRoot), gitBefore);
    receipt.checks.gitUnchanged = true;
    receipt.checks.restart = true;
    stage = "owned-process-cleanup";
    Object.assign(receipt, { stage, cleanupConfirmed: false });
    await saveGoalReviewReceipt(evidenceDir, root, receipt);
    const finalClose = await closeOwned(true);
    assert.ok(finalClose.ok && finalClose.cleanupConfirmed, "Owned process shutdown failed.");
    const inventory = (await command("ps", ["-axo", "pid=,args="], { maxBuffer: 4 * 1024 * 1024, timeout: 10000 })).stdout;
    receipt.ownedProcessLeftovers = inventory.split("\n").filter(line => line.includes(root) && Number(line.trim().split(/\s+/)[0]) !== process.pid).length;
    assert.equal(receipt.ownedProcessLeftovers, 0);
    receipt.checks.ownedProcessCleanup = true;
    assert.ok(Object.values(receipt.checks).every(value => value === true));
    stage = "receipt";
    receipt.ok = true;
    receipt.stage = "complete";
    receipt.cleanupConfirmed = true;
    await saveGoalReviewReceipt(evidenceDir, root, receipt);
    stage = "dispose";
    await rm(root, { recursive: true, force: true });
    return { ok: true, syntheticSource: true, realHermesVerifier: true, readOnly: true, noResume: true,
      sqliteReopen: true, electronRestart: true, otherRunStarts: 0, ownedProcessLeftovers: 0, cleanupConfirmed: true, evidenceDir };
  } catch (error) {
    if (cdp) {
      try { receipt.screenshots.push(await saveGoalReviewScreenshot(cdp, evidenceDir, "failure")); } catch {}
    }
    const pendingFailure = goalReviewFailureResult(stage, error, evidenceDir, cleanup);
    Object.assign(receipt, { ok: false, stage: pendingFailure.stage, code: pendingFailure.code, cleanupConfirmed: pendingFailure.cleanupConfirmed });
    try { await saveGoalReviewReceipt(evidenceDir, root, receipt); } catch {}
    if (app && cdp) {
      try { await closeOwned(false, new Error("Goal review acceptance failed.")); }
      catch { cleanup = { cleanupConfirmed: false }; }
    }
    else if (app) {
      try { await app.close(); cleanup = { cleanupConfirmed: true }; }
      catch { cleanup = { cleanupConfirmed: false }; }
    }
    const result = goalReviewFailureResult(stage, error, evidenceDir, cleanup);
    Object.assign(receipt, { ok: false, stage: result.stage, code: result.code, cleanupConfirmed: result.cleanupConfirmed });
    try { await saveGoalReviewReceipt(evidenceDir, root, receipt); }
    catch { return { ...result, receiptWritten: false }; }
    return { ...result, receiptWritten: true };
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
