import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { test } from "node:test";
import { assertGoalReviewAcceptance, clickOriginalGoalReview } from "./goalReviewUiAcceptance.mjs";

test("acceptance activates only visible More and Review buttons", async () => {
  const calls = [];
  await clickOriginalGoalReview({ evaluate: async source => { calls.push(source); } }, "source-implementation");
  assert.equal(calls.length, 3);
  assert.match(calls[0], /More details for/);
  assert.match(calls[1], /Review original goal/);
  assert.ok(calls.every(source => !source.includes("window.devflow")));
  const source = await readFile(new URL("./goalReviewUiAcceptance.mjs", import.meta.url), "utf8");
  assert.match(source, /finalizeAcceptanceOutcome/);
  assert.match(source, /ELECTRON_RUN_AS_NODE/);
  assert.match(source, /ownedProcessLeftovers: 0/);
  assert.doesNotMatch(source, /startAgentRun\(|reviewOriginalGoal\(/);
});

test("acceptance rejects a process-success claim without actual advisory or terminal facts", () => {
  assert.throws(() => assertGoalReviewAcceptance({ session: { nodes: [] }, projection: {}, evidence: { status: "succeeded" }, runs: [] }));
});

test("acceptance seed and inspect workers use a disposable real Git candidate without a verifier result", async (t) => {
  const { mkdtemp, mkdir, rm } = await import("node:fs/promises");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");
  const { execFile } = await import("node:child_process");
  const { promisify } = await import("node:util");
  const { fileURLToPath } = await import("node:url");
  const root = await mkdtemp(join(tmpdir(), "skyturn-goal-harness-test-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const config = { projectRoot: join(root, "project"), userData: join(root, "private"), observedValue: 73194628 };
  await mkdir(config.projectRoot); await mkdir(config.userData);
  const script = fileURLToPath(new URL("./goalReviewUiAcceptance.mjs", import.meta.url));
  const run = async mode => {
    const result = await promisify(execFile)(process.execPath, [script, mode, JSON.stringify(config)], { timeout: 30000, maxBuffer: 2 * 1024 * 1024 });
    return JSON.parse(result.stdout.split("\n").find(line => line.startsWith("GOAL_REVIEW_FACTS=")).slice("GOAL_REVIEW_FACTS=".length));
  };
  const seeded = await run("--seed");
  const inspected = await run("--inspect");
  assert.equal(inspected.session.nodes.filter(node => node.goalReview).length, 0);
  assert.equal(inspected.projection.segments.filter(segment => segment.status === "running").length, 0);
  const source = inspected.session.nodes.find(node => node.id === "source-implementation");
  assert.equal(source.goalReviewSource.sourceRunId, seeded.sourceRunId);
  const workspace = JSON.parse(await readFile(join(config.userData, "workspace.json"), "utf8"));
  assert.equal(workspace.activeSessionId, inspected.session.id);
  assert.deepEqual(workspace.runEvents, {});
  assert.deepEqual(workspace.runEvidence, {});
  assert.match(await readFile(join(config.projectRoot, "answer.js"), "utf8"), /73194628/);
  assert.ok(!workspace.sessions[0].goal.includes(String(config.observedValue)));
  for (const event of inspected.projection.events.filter(event => event.kind === "workflow.user_input")) {
    assert.ok(!String(event.payload.text).includes(String(config.observedValue)));
  }
  // Exercise the inspector's private-claim comparison without a provider or injected review terminal/output.
  const { createWorkflowStore } = await import("@skyturn/persistence/workflow-store");
  const { createDurableRunClaimStore, createAgentRunStartFingerprint } = await import("@skyturn/agent-bridge");
  const { buildPromptForNodeRun } = await import("@skyturn/ui-canvas/workflow-runtime");
  const store = createWorkflowStore({ projectRoot: config.projectRoot });
  let review, session;
  try {
    const created = store.createGoalReview({ requestId: "inspect-launch-proof", sessionId: inspected.session.id,
      nodeId: source.id, sourceRunId: seeded.sourceRunId }, new Date().toISOString());
    session = store.materializeCanvasSession(inspected.session.id);
    review = session.nodes.find(node => node.id === created.binding.reviewNodeId);
  } finally { store.close(); }
  const claims = createDurableRunClaimStore({ root: join(config.userData, "run-claims") });
  const prompt = buildPromptForNodeRun(session, review);
  assert.ok(!prompt.includes(String(config.observedValue)), "Wrong value must not enter the fresh verifier prompt");
  const startFingerprint = createAgentRunStartFingerprint({ protocolVersion: 1, runId: review.runId, nodeId: review.id,
    sessionId: session.id, projectRoot: config.projectRoot, worktreePath: config.projectRoot, agentKind: "hermes", sandbox: "read-only", prompt });
  await claims.publish(config.projectRoot, { runId: review.runId, nodeId: review.id, sessionId: session.id, agentKind: "hermes", startFingerprint, startedAt: new Date().toISOString() });
  const withClaim = await run("--inspect");
  assert.deepEqual(withClaim.launchProof, { readOnlyNoResume: true, startFingerprint });
  assert.equal(withClaim.session.nodes.find(node => node.id === review.id).status, "pending");
});

test("independent observation oracle rejects echoed goals and requires the observed file/value in report sections", async () => {
  const module = await import("./goalReviewUiAcceptance.mjs");
  assert.equal(typeof module.assertObservedGoalFinding, "function");
  const observedValue = 73194628;
  for (const output of [
    "# Findings\nImplement answer.js exporting answer = 42.\n# Unverified\nNone.",
    `# Findings\nThe value is ${observedValue}.`,
    `answer.js exports ${observedValue}.\n# Findings\nCheck goal 42.`,
    "# Findings\nanswer.js exports 42.",
    `# Findings\nNone.\n# Other section\nanswer.js exports ${observedValue}.`,
  ]) assert.throws(() => module.assertObservedGoalFinding(output, observedValue));
  module.assertObservedGoalFinding(`# Findings\n- answer.js:1 exports ${observedValue}; the required value is 42.\n# Unverified\nOther checks.`, observedValue);
});

test("DOM oracle independently requires a visible terminal card, exact Output and frozen Context", async () => {
  const module = await import("./goalReviewUiAcceptance.mjs");
  assert.equal(typeof module.assertGoalReviewDom, "function");
  const binding = { originalGoal: "Export answer = 42.", manifestSha256: "a".repeat(64), manifest: {
    runId: "source-run", afterCheckpointId: "source-checkpoint", afterHeadCommit: "b".repeat(40) },
    approvedPlan: { eventId: "approved-plan", seq: 12, text: "Requirements: export 42." } };
  const expected = { reviewId: "review", outputHash: "9b00a2d96e549319be4600b0ce7adeb2dd643f6affbb29ca17c43acc3724bfea", binding };
  const { createHash } = await import("node:crypto");
  const outputText = "# Findings\nanswer.js:1 exports 73194628.\n";
  expected.outputHash = createHash("sha256").update(outputText).digest("hex");
  const dom = { cardId: "review", title: "Review original goal", status: "completed", visible: true,
    advisory: "Advisory only. Goal acceptance remains unverified.", outputText,
    contextText: [binding.originalGoal, "source-run", "source-checkpoint", "b".repeat(40), "a".repeat(64), "approved-plan", "seq 12", binding.approvedPlan.text].join("\n") };
  module.assertGoalReviewDom(dom, expected);
  for (const changed of [{ visible: false }, { status: "running" }, { outputText: outputText.trim() }, { contextText: "stale shadow" }, { cardId: "other" }])
    assert.throws(() => module.assertGoalReviewDom({ ...dom, ...changed }, expected));
});

test("screenshot and receipt helpers retain bounded evidence outside the disposable root", async (t) => {
  const module = await import("./goalReviewUiAcceptance.mjs");
  assert.equal(typeof module.saveGoalReviewScreenshot, "function");
  assert.equal(typeof module.saveGoalReviewReceipt, "function");
  const { mkdtemp, mkdir, readFile, rm } = await import("node:fs/promises");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");
  const root = await mkdtemp(join(tmpdir(), "goal-review-evidence-test-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const projectRoot = join(root, "disposable");
  const evidenceDir = join(root, "retained");
  await mkdir(projectRoot); await mkdir(evidenceDir);
  const png = Buffer.alloc(64); Buffer.from("89504e470d0a1a0a0000000d49484452", "hex").copy(png); png.writeUInt32BE(600, 16); png.writeUInt32BE(400, 20);
  const calls = [];
  const screenshot = await module.saveGoalReviewScreenshot({
    evaluate: async source => { assert.ok(!source.includes("window.devflow")); return { x: 0, y: 0, width: 600, height: 400 }; },
    call: async (method, params) => { calls.push([method, params]); return { result: { data: png.toString("base64") } }; },
  }, evidenceDir, "report-before");
  assert.equal(calls[0][0], "Page.captureScreenshot");
  assert.equal(screenshot.bytes, png.length);
  const receipt = { version: 1, ok: false, stage: "report", code: "predicate-failed", cleanupConfirmed: true,
    evidenceDir, screenshots: [screenshot], candidate: null, checks: {} };
  const path = await module.saveGoalReviewReceipt(evidenceDir, projectRoot, receipt);
  await rm(projectRoot, { recursive: true });
  assert.equal(JSON.parse(await readFile(path, "utf8")).cleanupConfirmed, true);
  await assert.rejects(module.saveGoalReviewReceipt(projectRoot, projectRoot, receipt));
});

test("failure diagnostics preserve cleanup truth and expose only stage/code/evidence location", async () => {
  const module = await import("./goalReviewUiAcceptance.mjs");
  assert.equal(typeof module.goalReviewFailureResult, "function");
  const result = module.goalReviewFailureResult("report", Object.assign(new Error("Bearer private-capability /private/path raw provider stream"), { code: "ERR_ASSERTION" }),
    "/controlled/evidence", { ok: false, cleanupConfirmed: true });
  assert.equal(result.ok, false);
  assert.equal(result.cleanupConfirmed, true);
  assert.equal(result.code, "predicate-failed");
  assert.equal(result.evidenceDir, "/controlled/evidence");
  assert.doesNotMatch(JSON.stringify(result), /private-capability|private\/path|provider stream/);
});

for (const inventoryCase of ["error", "leftover", "empty"]) test(`owned-process inventory ${inventoryCase} controls cleanup truth and retained receipt`, async (t) => {
  const module = await import("./goalReviewUiAcceptance.mjs");
  assert.equal(typeof module.confirmGoalReviewProcessCleanup, "function");
  const { mkdtemp, mkdir, rm } = await import("node:fs/promises");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");
  const root = await mkdtemp(join(tmpdir(), "residual-goal-review-cleanup-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const disposable = join(root, "disposable"), evidenceDir = join(root, "evidence");
  await mkdir(disposable); await mkdir(evidenceDir);
  const cleanup = { ok: true, cleanupConfirmed: true };
  const screenshot = { name: "report-before.png", bytes: 64, sha256: "a".repeat(64) };
  const receipt = { version: 1, ok: false, stage: "owned-process-cleanup", code: null, cleanupConfirmed: true,
    evidenceDir, screenshots: [screenshot], candidate: null, checks: { ownedProcessCleanup: null } };
  const inventory = async () => {
    assert.equal(cleanup.cleanupConfirmed, false, "Close success is provisional until inventory is known.");
    assert.equal(receipt.cleanupConfirmed, false);
    if (inventoryCase === "error") throw new Error("Private process inventory unavailable.");
    return `${process.pid} acceptance ${disposable}\n22 unrelated\n` + (inventoryCase === "leftover" ? `99999 owned ${disposable}\n` : "");
  };
  let failure;
  try { await module.confirmGoalReviewProcessCleanup(disposable, cleanup, receipt, inventory); }
  catch (error) { failure = error; }
  const confirmed = inventoryCase === "empty";
  assert.equal(Boolean(failure), !confirmed);
  assert.equal(cleanup.cleanupConfirmed, confirmed);
  assert.equal(receipt.cleanupConfirmed, confirmed);
  assert.equal(receipt.checks.ownedProcessCleanup, confirmed);
  assert.equal(receipt.ownedProcessLeftovers, inventoryCase === "error" ? null : inventoryCase === "leftover" ? 1 : 0);
  // An independent earlier predicate can fail even when cleanup was fully confirmed.
  const result = module.goalReviewFailureResult(receipt.stage, failure ?? Object.assign(new Error("Earlier predicate failed."), { code: "ERR_ASSERTION" }), evidenceDir, cleanup);
  assert.equal(result.ok, false);
  assert.equal(result.cleanupConfirmed, confirmed);
  Object.assign(receipt, { ok: result.ok, code: result.code, cleanupConfirmed: result.cleanupConfirmed });
  const file = await module.saveGoalReviewReceipt(evidenceDir, disposable, receipt);
  const saved = JSON.parse(await readFile(file, "utf8"));
  assert.deepEqual(saved, receipt);
  assert.deepEqual(saved.screenshots, [screenshot]);
  assert.doesNotMatch(JSON.stringify(saved), /Private process inventory/);
});


test("restart DOM is asserted before protected projection corroboration", async () => {
  const { verifyGoalReviewRestart } = await import("./goalReviewUiAcceptance.mjs");
  const { createHash } = await import("node:crypto");
  const outputText = "# Findings\nanswer.js:1 exports 73194628.\n";
  const binding = { originalGoal: "Export 42", manifestSha256: "a".repeat(64), manifest: {
    runId: "source", afterCheckpointId: "checkpoint", afterHeadCommit: "b".repeat(40) }, approvedPlan: { eventId: "plan", seq: 1, text: "Desired 42" } };
  const expected = { reviewId: "review", binding, outputHash: createHash("sha256").update(outputText).digest("hex") };
  const dom = { cardId: "review", title: "Review original goal", status: "completed", visible: true, advisory: "Advisory only; unverified", outputText,
    contextText: ["Export 42", "source", "checkpoint", "b".repeat(40), "a".repeat(64), "plan", "seq 1", "Desired 42"].join("\n") };
  const order = [];
  const cdp = { evaluate: async source => { order.push("DOM"); assert.ok(!source.includes("window.devflow")); return dom; } };
  await verifyGoalReviewRestart(cdp, expected, () => { order.push("protected-corroboration"); });
  assert.deepEqual(order, ["DOM", "protected-corroboration"]);
  order.length = 0;
  await assert.rejects(verifyGoalReviewRestart({ evaluate: async () => ({ ...dom, contextText: "stale workspace shadow" }) }, expected,
    () => { order.push("protected-corroboration"); }));
  assert.deepEqual(order, []);
});


test("bounded receipt rejects raw fields and oversized payloads without replacing retained evidence", async (t) => {
  const { saveGoalReviewReceipt, saveGoalReviewScreenshot } = await import("./goalReviewUiAcceptance.mjs");
  const { mkdtemp, mkdir, rm, readFile } = await import("node:fs/promises");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");
  const root = await mkdtemp(join(tmpdir(), "goal-review-receipt-test-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const evidenceDir = join(root, "evidence"), disposable = join(root, "disposable");
  await mkdir(evidenceDir); await mkdir(disposable);
  const receipt = { version: 1, ok: false, stage: "report", code: "predicate-failed", cleanupConfirmed: false, evidenceDir, screenshots: [], candidate: null, checks: {} };
  const path = await saveGoalReviewReceipt(evidenceDir, disposable, receipt);
  for (const invalid of [{ ...receipt, providerOutput: "raw" }, { ...receipt, checks: { oversized: "x".repeat(40000) } },
    { ...receipt, checks: { privatePath: disposable } }]) await assert.rejects(saveGoalReviewReceipt(evidenceDir, disposable, invalid));
  assert.deepEqual(JSON.parse(await readFile(path, "utf8")), receipt);
  await assert.rejects(saveGoalReviewScreenshot({ evaluate: async () => ({ x: 0, y: 0, width: 1, height: 1 }), call: async () => { assert.fail("Hidden screenshot surface must not be captured"); } }, evidenceDir, "action"));
});
