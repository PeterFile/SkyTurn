import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";
import vm from "node:vm";

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const require = createRequire(import.meta.url);
const projectCore = await import(pathToFileURL(join(root, "..", "..", "packages", "project-core", "dist", "index.js")).href);
const persistenceRoot = join(root, "..", "..", "packages", "persistence");
const { createWorkflowStore } = await import(pathToFileURL(join(persistenceRoot, "dist", "workflowStore.js")).href);
const Database = createRequire(join(persistenceRoot, "package.json"))("better-sqlite3");
const gitWorktree = await import(pathToFileURL(join(root, "..", "..", "packages", "git-worktree", "dist", "node.js")).href);

test("real Git comparison refreshes same-HEAD run metrics and reuses receipts after SQLite reopen", async () => {
  const fixture = await realComparisonFixture();
  try {
    const unknown = await fixture.compare();
    assertRunMetrics(unknown, 0, ["unknown", "unknown", "unknown", "unknown"]);
    assert.deepEqual(await fixture.compare(), unknown);
    await fixture.finish("left");
    const leftRecorded = await fixture.compare();
    assertRunMetrics(leftRecorded, 0, ["passed", "passed", "passed", "recorded"]);
    assert.notEqual(leftRecorded.recording.comparison.comparisonId, unknown.comparison.comparisonId);
    assert.equal(leftRecorded.recording.left.headCommit, unknown.recording.left.headCommit);
    assert.doesNotMatch(JSON.stringify(leftRecorded), /TOKEN_private|\/private\/sensitive|all tests passed in prose/);
    assert.ok(JSON.stringify(leftRecorded).includes(".devflow/acceptance/left.txt"));
    await fixture.finish("right", "failed");
    const bothRecorded = await fixture.compare();
    assertRunMetrics(bothRecorded, 1, ["passed", "failed", "passed", "recorded"]);
    assert.equal(bothRecorded.recording.right.headCommit, unknown.recording.right.headCommit);
    // Cache identity must include canonical content even when every binding is unchanged.
    const updatedDetail = "Updated recorded test detail api_key=TOKEN_private /private/sensitive/result.txt";
    fixture.rewriteTestDetail(updatedDetail);
    const updated = await fixture.compare();
    assert.notEqual(updated.comparison.comparisonId, bothRecorded.comparison.comparisonId);
    assert.equal(updated.comparison.variants[0].metrics.find((metric) => metric.kind === "test").detail, projectCore.sanitizePublicEvidenceText(updatedDetail));
    assert.doesNotMatch(JSON.stringify(updated), /TOKEN_private|\/private\/sensitive/);
    fixture.rewriteTestDetail(updatedDetail.replace("TOKEN_private", "TOKEN_other"));
    assert.deepEqual(await fixture.compare(), updated);
    fixture.append({ kind: "workflow.user_input", source: "user", payload: { text: "Unrelated traffic" } });
    fixture.reopen();
    assert.deepEqual(await fixture.compare(), updated);
    assert.deepEqual(await fixture.compare(), updated);
    assert.equal(fixture.events().filter((event) => event.kind === "workflow.variant.comparison_recorded").length, 4);
  } finally {
    await fixture.close();
  }
});

test("real Git comparison rejects unsuitable latest facts without borrowing older run evidence", async () => {
  const fixture = await realComparisonFixture();
  try {
    await fixture.finish("left");
    const recorded = await fixture.compare();
    assertRunMetrics(recorded, 0, ["passed", "passed", "passed", "recorded"]);
    const original = fixture.events();
    const evidenceIndex = original.findIndex((event) => event.kind === "workflow.evidence.recorded" && event.laneId === "lane-left");
    const checkpointIndex = original.findIndex((event) => event.kind === "workflow.node.checkpoint_recorded" && event.payload.checkpoint.phase === "after");
    const mutations = [
      (events) => { events[evidenceIndex].payload.evidence.runEvidence.runId = "another-run"; },
      (events) => { events[evidenceIndex].payload.segmentId = "another-segment"; },
      (events) => { events[evidenceIndex].laneId = "another-lane"; },
      (events) => { events[evidenceIndex].sessionId = "another-session"; },
      (events) => { events[evidenceIndex].source = "human"; },
      (events) => { events[evidenceIndex].payload.evidence.runEvidence.checks[0].status = "success"; },
      (events) => { events[evidenceIndex].payload.evidence.runEvidence.artifacts = [".env"]; },
      (events) => { delete events[evidenceIndex].payload.evidence.runEvidence; },
      (events) => { events[checkpointIndex].payload.checkpoint.headCommit = "f".repeat(40); },
      (events) => { events[checkpointIndex].payload.checkpoint.headCommit = recorded.recording.left.headCommit.slice(0, 8); },
      (events) => { events[checkpointIndex].payload.checkpoint.worktreeId = "another-worktree"; },
      (events) => { events[checkpointIndex].payload.checkpoint.worktreePath += "-other"; },
      (events) => { events[checkpointIndex].payload.checkpoint.branchName = "another-branch"; },
      (events) => { events[checkpointIndex].payload.checkpoint.worktreeState = "dirty"; },
      (events) => { delete events[checkpointIndex].payload.checkpoint.ancestryProof; },
      (events) => { events[checkpointIndex].payload.checkpoint.evidenceRefs = []; },
      (events) => { events.splice(checkpointIndex, 1); },
      (events) => {
        const latest = structuredClone(events[evidenceIndex]);
        latest.payload.evidence.runEvidence.checks[0].status = "failed";
        events.push(latest);
      },
      (events) => { events[evidenceIndex].source = "gemini"; },
      (events) => { events[evidenceIndex].payload.evidence.runEvidence.checks.push({ kind: "test", name: "Other tests", status: "failed" }); },
      (events) => { events[evidenceIndex].payload.evidence.runEvidence.completedAt = null; },
      (events) => { events.push({ ...events[evidenceIndex], payload: null }); },
      (events) => { events.push({ ...events[checkpointIndex], payload: { checkpoint: { phase: "after" } } }); },
      (events) => {
        const started = structuredClone(events.find((event) => event.kind === "workflow.segment.started" && event.laneId === "lane-left"));
        started.payload.segment.runId = "newer-run";
        events.push(started);
      },
      (events) => {
        const latest = structuredClone(events[evidenceIndex]);
        latest.payload.segmentId = "newer-segment";
        latest.payload.evidence.runEvidence = null;
        events.push(latest);
      },
    ];
    for (const [index, mutate] of mutations.entries()) {
      // Corrupt only the read boundary; valid baseline facts come from real producers below.
      const events = structuredClone(original);
      mutate(events);
      if (index === 3) {
        await assert.rejects(fixture.compare(events), /another session/);
        continue;
      }
      const result = await fixture.compare(events);
      assertRunMetrics(result, 0, ["unknown", "unknown", "unknown", "unknown"], `mutation ${index}`);
    }
    const duplicate = structuredClone(original);
    duplicate.push(structuredClone(duplicate[evidenceIndex]));
    assert.deepEqual(await fixture.compare(duplicate), recorded);
  } finally {
    await fixture.close();
  }
});

function assertRunMetrics(result, side, statuses, message) {
  const metrics = result.comparison.variants[side].metrics;
  assert.deepEqual(["test", "build", "typecheck", "artifact"].map((kind) => metrics.find((metric) => metric.kind === kind).status), statuses, message);
}

async function realComparisonFixture() {
  const temporaryRoot = await realpath(await mkdtemp(join(tmpdir(), "skyturn-comparison-git-")));
  const projectRoot = join(temporaryRoot, "project");
  await mkdir(projectRoot);
  const git = (...args) => execFileSync("git", ["-C", projectRoot, ...args], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
  git("init", "-b", "main");
  await mkdir(join(projectRoot, ".devflow", "acceptance"), { recursive: true });
  for (const side of ["left", "right"]) await writeFile(join(projectRoot, ".devflow", "acceptance", `${side}.txt`), "Fixture artifact\n");
  git("add", ".devflow/acceptance");
  git("-c", "user.name=SkyTurn Test", "-c", "user.email=test@example.test", "-c", "commit.gpgsign=false", "commit", "-m", "fixture");
  let store = createWorkflowStore({ projectRoot });
  const now = "2026-09-01T00:00:00.000Z";
  let sequence = 0;
  const append = (event) => store.appendWorkflowEvent({ sessionId: "session-1", idempotencyKey: `fixture:${sequence++}`, now, ...event });
  const session = store.createWorkflowSession({
    id: "session-1", projectId: "project-1", title: "Compare", goal: "Compare runs", mode: "fast",
    target: { executionTarget: "new_worktree", selectedBranch: "main", baseRef: "main" },
    plannerProfile: "default", transport: "hermes_replay_recovery", recoveryReason: "fixture", now,
  });
  const evidence = (runId, checks = [], artifacts = []) => ({
    runId, status: checks.some((check) => check.status === "failed") ? "failed" : "succeeded",
    exitCode: 0, changesetId: null, checks, artifacts, review: null, errorReason: null, cancelReason: null, completedAt: now,
  });
  const { segment: planner } = store.claimPlannerRunStart({
    sessionId: session.id, laneId: session.plannerLaneId, runId: "planner-run", agentKind: "hermes", worktreePath: projectRoot, now,
  });
  store.recordRunResult({ ...planner, evidence: evidence(planner.runId), now });
  store.recordPlannerIntentReconciled(planner, now);
  const worktrees = {};
  const service = gitWorktree.createNodeGitWorktreeService({ eventSink: { append: async (event) => append({ ...event, now: event.createdAt }) } });
  for (const side of ["left", "right"]) {
    append({ kind: "workflow.lane.declared", source: "test", payload: { lane: {
      id: `lane-${side}`, semanticKey: `lane-${side}`, kind: "implementation", title: `Implement ${side}`, agentKind: "codex", status: "pending",
    } } });
    worktrees[side] = await service.createManagedWorktree({
      sessionId: session.id, variantId: side, repoRoot: projectRoot, baseCommit: git("rev-parse", "HEAD"),
      branchName: `skyturn/session-1/${side}`, parentLaneId: `lane-${side}`,
    });
    const mirror = join(worktrees[side].realPath, ".devflow", "runs", "mirror-run");
    await mkdir(mirror, { recursive: true });
    await writeFile(join(mirror, "events.ndjson"), JSON.stringify({ kind: "evidence", runId: "mirror-run", payload: {
      evidence: evidence("mirror-run", [{ kind: "test", name: "Mirror claims success", status: "passed" }]),
    } }) + "\n");
    append({ kind: "workflow.lane.candidate_bound", source: "workflow-scheduler", payload: {
      binding: projectCore.parseWorkflowLaneCandidateBinding({
        sessionId: session.id, laneId: `lane-${side}`, variantId: side, worktreeId: worktrees[side].worktreeId,
        lineageId: `lineage-${side}`, reason: "default", predecessorLaneIds: [],
      }),
    } });
  }
  const runtime = await loadRuntime();
  const harness = runtimeHarness({ projectRoot });
  harness.dependencies.canonicalPath = realpath;
  harness.dependencies.loadGitWorktreeModule = async () => gitWorktree;
  return {
    append,
    events: () => store.listEvents(session.id),
    reopen() { store.close(); store = createWorkflowStore({ projectRoot }); },
    rewriteTestDetail(detail) {
      // Exercise the persisted untrusted-content boundary without inventing a new HEAD join.
      const event = store.listEvents(session.id).find((event) => event.kind === "workflow.evidence.recorded" && event.laneId === "lane-left");
      event.payload.evidence.runEvidence.checks[0].detail = detail;
      const database = new Database(join(projectRoot, ".devflow", "skyturn-workflow.sqlite"));
      try {
        database.prepare("UPDATE workflow_events SET payload_json = ? WHERE id = ?").run(JSON.stringify(event.payload), event.id);
      } finally {
        database.close();
      }
    },
    async finish(side, buildStatus = "passed") {
      const scheduled = store.scheduleReadyLanes(session.id, { allowedParallelism: 1, now });
      const lane = scheduled.readyLanes.find((lane) => lane.id === `lane-${side}`);
      assert.ok(lane);
      const worktree = worktrees[side];
      const input = {
        sessionId: session.id, nodeId: lane.id, laneId: lane.id, segmentId: lane.segmentId, runId: lane.runId,
        executionTarget: "new_worktree", worktreeId: worktree.worktreeId, worktreePath: worktree.realPath,
        ...await gitWorktree.getGitCheckpointSnapshot(worktree.realPath),
        evidenceRefs: [{ kind: "run", id: lane.runId }, { kind: "segment", id: lane.segmentId }], now,
      };
      store.recordRunCheckpoint({ ...input, phase: "before" });
      const checks = ["test", "build", "typecheck"].map((kind) => ({
        kind, name: kind, status: kind === "build" ? buildStatus : "passed",
        detail: "Checked /private/sensitive/result.txt api_key=TOKEN_private",
      }));
      store.recordRunResult({ ...input, agentKind: "codex", evidence: evidence(input.runId, checks, [`.devflow/acceptance/${side}.txt`]), outputSummary: "all tests passed in prose", now });
      const proofInput = { repositoryPath: projectRoot, worktreePath: input.worktreePath, beforeHeadCommit: input.headCommit, afterHeadCommit: input.headCommit };
      store.recordRunCheckpoint({
        ...input, phase: "after", evidenceRefs: [...input.evidenceRefs, { kind: "evidence", id: `evidence-${input.segmentId}` }],
        ancestryProof: await gitWorktree.createWorkflowGitAncestryProof(proofInput),
        ancestryProofContext: await gitWorktree.createLiveWorkflowGitAncestryProofContext(proofInput),
      });
    },
    async compare(events) {
      harness.dependencies.getWorkflowStore = async () => ({
        materializeCanvasSession: (id) => store.materializeCanvasSession(id),
        listEvents: (id) => events ? [...events, ...store.listEvents(id).filter((event) =>
          event.kind === "workflow.variant.comparison_recorded" && !events.some((existing) => existing.id === event.id)
        )] : store.listEvents(id),
        appendWorkflowEvent: (input) => store.appendWorkflowEvent(input),
      });
      return runtime.compareWorkflowWorktrees(harness.dependencies, projectRoot, {
        sessionId: session.id, leftWorktreeId: worktrees.left.worktreeId, rightWorktreeId: worktrees.right.worktreeId,
      });
    },
    async close() { store.close(); await rm(temporaryRoot, { recursive: true, force: true }); },
  };
}

test("variant runtime returns the persisted reconciled receipt and adopts the advanced head", async () => {
  const runtime = await loadRuntime();
  const durableEvents = createdEvents();
  durableEvents[0].payload.worktree.headCommit = "a".repeat(40);
  const harness = runtimeHarness({ events: durableEvents });
  const input = comparisonInput();

  const compared = await runtime.compareWorkflowWorktrees(harness.dependencies, "/project", input);
  const recorded = harness.events.find((event) => event.kind === "workflow.variant.comparison_recorded");
  assert.equal(compared.comparison.comparisonId, "comparison-left-right");
  assert.ok(recorded);
  assert.deepEqual(compared.recording, recorded.payload.recording);
  assert.equal(compared.recording.left.baseCommit, "a".repeat(40));
  assert.equal(compared.recording.left.headCommit, "b".repeat(40));
  assert.doesNotMatch(JSON.stringify(compared), /\/project|\.worktrees|realPath|gitdir|repoRoot/);
  assert.equal(recorded.payload.recording.left.headCommit, "b".repeat(40));
  assert.equal(recorded.payload.recording.right.headCommit, "c".repeat(40));
  assert.doesNotMatch(JSON.stringify(recorded), /\/project|\.worktrees|prompt|handle/);

  const adoptedSide = compared.recording.left;
  const adoptionRequest = {
    sessionId: "session-1",
    comparisonId: compared.comparison.comparisonId,
    adoption: {
      adoptionId: `adopt-${adoptedSide.worktreeId}-${adoptedSide.headCommit}-comparison-left-right`,
      variantId: adoptedSide.variantId,
      worktreeId: adoptedSide.worktreeId,
      strategy: "merge",
      status: "requested",
      baseCommit: adoptedSide.baseCommit,
      headCommit: adoptedSide.headCommit,
      targetBranchName: "main",
    },
  };
  const adopted = await runtime.adoptWorkflowWorktree(
    harness.dependencies,
    "/project",
    adoptionRequest,
  );
  assert.equal(adopted.status, "adopted");
  assert.equal(harness.adoptCalls.length, 1);
  assert.deepEqual(harness.freshnessCalls[0].map((worktree) => ({
    worktreeId: worktree.worktreeId,
    headCommit: worktree.headCommit,
  })), [
    { worktreeId: "worktree-left", headCommit: "b".repeat(40) },
    { worktreeId: "worktree-right", headCommit: "c".repeat(40) },
  ]);
  assert.deepEqual(harness.adoptCalls[0], adoptionRequest.adoption);
});

test("comparison append failure blocks a successful compare response", async () => {
  const runtime = await loadRuntime();
  const harness = runtimeHarness({ failComparisonAppend: true });

  await assert.rejects(
    runtime.compareWorkflowWorktrees(harness.dependencies, "/project", comparisonInput()),
    /comparison failed/i,
  );
  assert.equal(harness.compareCalls.length, 1);
  assert.equal(harness.events.some((event) => event.kind === "workflow.variant.comparison_recorded"), false);
});

test("failed comparison evidence sanitizes every metric in the raw SQLite payload", async () => {
  const runtime = await loadRuntime();
  const projectRoot = await mkdtemp(join(tmpdir(), "skyturn-variant-runtime-"));
  const sensitivePath = join(projectRoot, "secret-worktree", "credential.txt");
  const sensitiveFragment = "TOKEN_super-sensitive-fragment_42";
  const sensitive = `${sensitivePath}?api_key=${sensitiveFragment}`;
  const safeText = "Git changeset collection failed.";
  let store = createWorkflowStore({ projectRoot });
  try {
    store.createWorkflowSession({
      id: "session-1",
      projectId: "project-1",
      title: "Variant comparison persistence regression",
      goal: "Persist only safe failed comparison evidence.",
      mode: "fast",
      target: { executionTarget: "new_worktree", selectedBranch: "main", baseRef: "main" },
      plannerProfile: "default",
      transport: "hermes_replay_recovery",
      recoveryReason: "The regression fixture seeds deterministic workflow state.",
      now: "2026-08-26T00:00:00.000Z",
    });
    for (const event of createdEvents("session-1", projectRoot)) {
      store.appendWorkflowEvent({
        sessionId: event.sessionId,
        kind: event.kind,
        source: event.source,
        idempotencyKey: event.idempotencyKey,
        payload: event.payload,
        now: event.createdAt,
      });
    }

    const comparison = comparisonEvidence();
    comparison.variants[0] = {
      ...comparison.variants[0],
      changeset: {
        ...comparison.variants[0].changeset,
        status: "failed",
        files: [],
        diffStat: { added: 0, changed: 0, deleted: 0 },
        artifactPaths: ["artifacts/safe-changeset.json"],
        errorReason: sensitive,
      },
      metrics: [
        {
          kind: "changed-file-count",
          label: `Changed files from ${sensitive}`,
          status: "unknown",
          source: "recorded",
          value: `unreadable ${sensitive}`,
          detail: `collector failed at ${sensitive}`,
          artifactPaths: ["artifacts/safe-count.json"],
        },
        {
          kind: "diff-summary",
          label: `Diff summary for ${sensitive}`,
          status: "unknown",
          source: "recorded",
          value: 7,
          detail: `summary failed at ${sensitive}`,
          artifactPaths: ["artifacts/safe-summary.json"],
        },
      ],
    };
    const harness = runtimeHarness({ comparisonEvidence: comparison, projectRoot });
    harness.dependencies.getWorkflowStore = async () => store;

    await runtime.compareWorkflowWorktrees(harness.dependencies, projectRoot, comparisonInput());
    store.close();
    store = null;

    const database = new Database(join(projectRoot, ".devflow", "skyturn-workflow.sqlite"), {
      readonly: true,
      fileMustExist: true,
    });
    let rawPayload;
    try {
      const row = database.prepare([
        "SELECT payload_json FROM workflow_events",
        "WHERE session_id = ? AND kind = ?",
      ].join(" ")).get("session-1", "workflow.variant.comparison_recorded");
      assert.ok(row);
      rawPayload = row.payload_json;
    } finally {
      database.close();
    }

    assert.equal(rawPayload.includes(sensitivePath), false);
    assert.equal(rawPayload.includes(sensitiveFragment), false);
    const persisted = JSON.parse(rawPayload).recording.comparison.variants[0];
    assert.equal(persisted.changeset.errorReason, safeText);
    assert.deepEqual(persisted.changeset.artifactPaths, ["artifacts/safe-changeset.json"]);
    assert.deepEqual(
      persisted.metrics.map(({ label, value, detail, artifactPaths }) => ({ label, value, detail, artifactPaths })),
      [
        {
          label: safeText,
          value: safeText,
          detail: safeText,
          artifactPaths: ["artifacts/safe-count.json"],
        },
        {
          label: safeText,
          value: 7,
          detail: safeText,
          artifactPaths: ["artifacts/safe-summary.json"],
        },
      ],
    );
  } finally {
    store?.close();
    await rm(projectRoot, { recursive: true, force: true });
  }
});

test("adoption rejects missing, wrong, cross-session, and malformed comparisons before service mutation", async () => {
  const runtime = await loadRuntime();
  const cases = [];

  cases.push(runtimeHarness());
  const wrongId = runtimeHarness({ events: comparedEvents() });
  cases.push(wrongId);
  const wrongWorktree = runtimeHarness({ events: comparedEvents() });
  cases.push(wrongWorktree);
  const wrongSession = runtimeHarness({ events: comparedEvents({ sessionId: "session-other" }) });
  cases.push(wrongSession);
  const malformed = comparedEvents();
  malformed.at(-1).payload.recording.projectRoot = "/secret/project";
  cases.push(runtimeHarness({ events: malformed }));

  const inputs = [
    adoptionInput("comparison-left-right"),
    adoptionInput("comparison-wrong"),
    { ...adoptionInput("comparison-left-right"), adoption: { ...adoptionInput().adoption, worktreeId: "worktree-other" } },
    adoptionInput("comparison-left-right"),
    adoptionInput("comparison-left-right"),
  ];
  for (let index = 0; index < cases.length; index += 1) {
    const harness = cases[index];
    await assert.rejects(runtime.adoptWorkflowWorktree(harness.dependencies, "/project", inputs[index]));
    assert.equal(harness.adoptCalls.length, 0);
    assert.equal(harness.events.some((event) => event.kind === "workflow.variant.adopt_failed"), true);
  }
});

test("exact compare and adopt retries reuse durable terminal facts", async () => {
  const runtime = await loadRuntime();
  const harness = runtimeHarness();
  const firstComparison = await runtime.compareWorkflowWorktrees(harness.dependencies, "/project", comparisonInput());
  const secondComparison = await runtime.compareWorkflowWorktrees(harness.dependencies, "/project", comparisonInput());
  assert.deepEqual(secondComparison, firstComparison);
  assert.equal(harness.compareCalls.length, 1);
  assert.equal(harness.events.filter((event) => event.kind === "workflow.variant.comparison_recorded").length, 1);

  const input = adoptionInput(firstComparison.comparison.comparisonId);
  const firstAdoption = await runtime.adoptWorkflowWorktree(harness.dependencies, "/project", input);
  const secondAdoption = await runtime.adoptWorkflowWorktree(harness.dependencies, "/project", input);
  assert.deepEqual(secondAdoption, firstAdoption);
  assert.equal(harness.adoptCalls.length, 1);
});

test("compare and adopt serialize through the canonical session mutation lock", async () => {
  const runtime = await loadRuntime();
  let releaseComparison;
  let comparisonEnteredResolve;
  const comparisonEntered = new Promise((resolve) => { comparisonEnteredResolve = resolve; });
  const comparisonGate = new Promise((resolve) => { releaseComparison = resolve; });
  const harness = runtimeHarness({ comparisonGate, comparisonEntered: comparisonEnteredResolve });

  const comparing = runtime.compareWorkflowWorktrees(harness.dependencies, "/project", comparisonInput());
  await comparisonEntered;
  const adopting = runtime.adoptWorkflowWorktree(
    harness.dependencies,
    "/project",
    adoptionInput("comparison-left-right"),
  );
  await Promise.resolve();
  assert.equal(harness.adoptCalls.length, 0);
  releaseComparison();
  await Promise.all([comparing, adopting]);
  assert.equal(harness.maxLockDepth, 1);
  assert.equal(harness.adoptCalls.length, 1);
});

test("reopen retains the comparison gate", async () => {
  const runtime = await loadRuntime();
  const first = runtimeHarness();
  const comparison = await runtime.compareWorkflowWorktrees(first.dependencies, "/project", comparisonInput());
  const reopened = runtimeHarness({ events: structuredClone(first.events) });

  await runtime.adoptWorkflowWorktree(
    reopened.dependencies,
    "/project",
    adoptionInput(comparison.comparison.comparisonId),
  );
  assert.equal(reopened.adoptCalls.length, 1);
});

test("either live HEAD or either side identity change stales adoption", async () => {
  const runtime = await loadRuntime();
  const staleCases = [
    { worktreeId: "worktree-left", change: { headCommit: "d".repeat(40) } },
    { worktreeId: "worktree-right", change: { headCommit: "d".repeat(40) } },
    { worktreeId: "worktree-left", change: { branchName: "skyturn/session-1/renamed-left" } },
    { worktreeId: "worktree-right", change: { baseCommit: "d".repeat(40) } },
  ];

  for (const stale of staleCases) {
    const harness = runtimeHarness({ events: comparedEvents() });
    harness.currentById.set(stale.worktreeId, {
      ...harness.currentById.get(stale.worktreeId),
      ...stale.change,
    });
    await assert.rejects(
      runtime.adoptWorkflowWorktree(harness.dependencies, "/project", adoptionInput("comparison-left-right")),
      /compare again|adoption failed/i,
    );
    assert.equal(harness.adoptCalls.length, 0);
    assert.equal(harness.events.some((event) => event.kind === "workflow.variant.adopt_failed"), true);
  }
});

async function loadRuntime() {
  const source = await readFile(join(root, "electron", "worktreeComparisonRuntime.ts"), "utf8");
  const ts = require("typescript");
  const output = ts.transpileModule(source, {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
  }).outputText;
  const module = { exports: {} };
  vm.runInNewContext(output, {
    Error,
    module,
    exports: module.exports,
    require(specifier) {
      if (specifier === "@skyturn/project-core") return projectCore;
      if (specifier === "./workflowIpcContracts") {
        return {
          workflowIpcError(code, message) {
            return new Error(`SKYTURN_WORKFLOW_IPC_ERROR:${code}: ${message}`);
          },
        };
      }
      return require(specifier);
    },
  }, { filename: "worktreeComparisonRuntime.ts" });
  return module.exports;
}

function runtimeHarness(options = {}) {
  const projectRoot = options.projectRoot ?? "/project";
  const events = options.events ? structuredClone(options.events) : createdEvents("session-1", projectRoot);
  const currentById = new Map([
    ["worktree-left", identity("left", projectRoot)],
    ["worktree-right", identity("right", projectRoot)],
  ]);
  const compareCalls = [];
  const adoptCalls = [];
  const freshnessCalls = [];
  let lockTail = Promise.resolve();
  let lockDepth = 0;
  const harness = {
    events,
    currentById,
    compareCalls,
    adoptCalls,
    freshnessCalls,
    maxLockDepth: 0,
  };
  const store = {
    materializeCanvasSession(sessionId) {
      return sessionId === "session-1"
        ? { id: sessionId, target: { executionTarget: "new_worktree", selectedBranch: "main", baseRef: "main" } }
        : null;
    },
    listEvents() {
      return events;
    },
    appendWorkflowEvent(input) {
      if (options.failComparisonAppend && input.kind === "workflow.variant.comparison_recorded") {
        throw new Error("sqlite append failed at /secret/database");
      }
      const existing = input.idempotencyKey
        ? events.find((event) => event.idempotencyKey === input.idempotencyKey)
        : null;
      if (existing) return existing;
      const event = {
        id: `event-${events.length + 1}`,
        seq: events.length + 1,
        sessionId: input.sessionId,
        kind: input.kind,
        source: input.source,
        payload: input.payload,
        idempotencyKey: input.idempotencyKey ?? null,
        createdAt: input.now,
      };
      events.push(event);
      return event;
    },
  };
  harness.dependencies = {
    assertKnownProjectRoot() {},
    async getWorkflowStore() { return store; },
    async workflowStoreIdentity(value) { return value; },
    async canonicalPath(value) { return value; },
    async withSessionMutationLock(_projectRoot, _sessionId, action) {
      const previous = lockTail;
      let release;
      lockTail = new Promise((resolve) => { release = resolve; });
      await previous;
      lockDepth += 1;
      harness.maxLockDepth = Math.max(harness.maxLockDepth, lockDepth);
      try {
        return await action();
      } finally {
        lockDepth -= 1;
        release();
      }
    },
    async loadGitWorktreeModule() {
      return {
        parseWorktreeComparisonRequest(value) { return value; },
        parseWorktreeAdoptionRequest(value) { return value; },
        parseVariantComparisonEvidence(value) { return structuredClone(value); },
        parseWorkflowVariantComparisonRecordedEvidence: projectCore.parseWorkflowVariantComparisonRecordedEvidence,
        createNodeGitWorktreeService(serviceOptions) {
          return {
            async reconcileManagedWorktree(worktree) {
              const current = currentById.get(worktree.worktreeId);
              if (!current) throw new Error("missing worktree at /secret/path");
              return structuredClone(current);
            },
            async compareVariants(input) {
              compareCalls.push(structuredClone(input));
              options.comparisonEntered?.();
              if (options.comparisonGate) await options.comparisonGate;
              return structuredClone(options.comparisonEvidence ?? comparisonEvidence());
            },
            async adoptVariant(input, adoptionOptions) {
              adoptCalls.push(structuredClone(input));
              freshnessCalls.push(structuredClone(adoptionOptions?.requiredFreshWorktrees ?? []));
              const requested = { ...input, status: "requested" };
              await serviceOptions?.eventSink?.append(serviceEvent("workflow.variant.adopt_requested", requested));
              const adopted = { ...input, status: "adopted", adoptedCommit: input.headCommit };
              await serviceOptions?.eventSink?.append(serviceEvent("workflow.variant.adopted", adopted));
              return adopted;
            },
          };
        },
      };
    },
  };
  return harness;
}

function comparisonInput() {
  return { sessionId: "session-1", leftWorktreeId: "worktree-left", rightWorktreeId: "worktree-right" };
}

function adoptionInput(comparisonId = undefined) {
  return {
    sessionId: "session-1",
    ...(comparisonId ? { comparisonId } : {}),
    adoption: {
      adoptionId: `adopt-left-${comparisonId?.replace(/[^A-Za-z0-9._-]/g, "-") ?? "legacy"}`,
      variantId: "variant-left",
      worktreeId: "worktree-left",
      strategy: "merge",
      status: "requested",
      baseCommit: "a".repeat(40),
      headCommit: "b".repeat(40),
      targetBranchName: "main",
    },
  };
}

function identity(side, projectRoot = "/project") {
  const headCommit = side === "left" ? "b".repeat(40) : "c".repeat(40);
  return {
    worktreeId: `worktree-${side}`,
    variantId: `variant-${side}`,
    path: `${projectRoot}.worktrees/worktree-${side}`,
    realPath: `${projectRoot}.worktrees/worktree-${side}`,
    gitdir: `${projectRoot}/.git/worktrees/worktree-${side}`,
    repoRoot: projectRoot,
    branchName: `skyturn/session-1/variant-${side}`,
    baseCommit: "a".repeat(40),
    headCommit,
    parentLaneId: `lane-${side}`,
  };
}

function createdEvents(sessionId = "session-1", projectRoot = "/project") {
  return ["left", "right"].map((side, index) => ({
    id: `created-${side}`,
    seq: index + 1,
    sessionId,
    kind: "workflow.worktree.created",
    source: "git-worktree",
    payload: { worktree: identity(side, projectRoot) },
    idempotencyKey: `worktree:worktree-${side}:created`,
    createdAt: "2026-08-26T00:00:00.000Z",
  }));
}

function comparisonEvidence() {
  const collectedAt = "2026-08-26T00:00:01.000Z";
  return {
    comparisonId: "comparison-left-right",
    collectedAt,
    variants: ["left", "right"].map((side) => ({
      variantId: `variant-${side}`,
      worktreeId: `worktree-${side}`,
      changeset: {
        evidenceId: `evidence-${side}`,
        changesetId: `changeset-${side}`,
        source: "git",
        status: "available",
        files: [`src/${side}.ts`],
        diffStat: { added: 1, changed: 0, deleted: 0 },
        patchPreviewTruncated: false,
        worktreeId: `worktree-${side}`,
        collectedAt,
      },
      metrics: [],
    })),
  };
}

function comparisonRecording(overrides = {}) {
  return {
    sessionId: overrides.sessionId ?? "session-1",
    comparison: comparisonEvidence(),
    left: sideIdentity("left"),
    right: sideIdentity("right"),
  };
}

function sideIdentity(side) {
  const worktree = identity(side);
  return {
    laneId: worktree.parentLaneId,
    variantId: worktree.variantId,
    worktreeId: worktree.worktreeId,
    branchName: worktree.branchName,
    baseCommit: worktree.baseCommit,
    headCommit: worktree.headCommit,
  };
}

function comparedEvents(overrides = {}) {
  const sessionId = overrides.sessionId ?? "session-1";
  return [
    ...createdEvents(sessionId),
    {
      id: "comparison-recorded",
      seq: 3,
      sessionId,
      kind: "workflow.variant.comparison_recorded",
      source: "electron-main",
      payload: { recording: comparisonRecording({ sessionId }) },
      idempotencyKey: `variant-comparison:${"d".repeat(64)}`,
      createdAt: "2026-08-26T00:00:01.000Z",
    },
  ];
}

function serviceEvent(kind, adoption) {
  const suffix = kind === "workflow.variant.adopt_requested" ? "adopt-requested" : "adopted";
  return {
    kind,
    source: "git-worktree",
    payload: { adoption },
    createdAt: "2026-08-26T00:00:02.000Z",
    idempotencyKey: `variant:${adoption.adoptionId}:${suffix}`,
    sessionId: "session-1",
  };
}
