import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";
import vm from "node:vm";

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const require = createRequire(import.meta.url);
const projectCore = await import(pathToFileURL(join(root, "..", "..", "packages", "project-core", "dist", "index.js")).href);

test("variant runtime persists compare evidence and adopts only from both live heads", async () => {
  const runtime = await loadRuntime();
  const harness = runtimeHarness();
  const input = comparisonInput();

  const compared = await runtime.compareWorkflowWorktrees(harness.dependencies, "/project", input);
  const recorded = harness.events.find((event) => event.kind === "workflow.variant.comparison_recorded");
  assert.equal(compared.comparison.comparisonId, "comparison-left-right");
  assert.ok(recorded);
  assert.equal(recorded.payload.recording.left.headCommit, "b".repeat(40));
  assert.equal(recorded.payload.recording.right.headCommit, "c".repeat(40));
  assert.doesNotMatch(JSON.stringify(recorded), /\/project|\.worktrees|prompt|handle/);

  const adopted = await runtime.adoptWorkflowWorktree(
    harness.dependencies,
    "/project",
    adoptionInput(compared.comparison.comparisonId),
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
  assert.deepEqual(harness.adoptCalls[0], {
    ...adoptionInput(compared.comparison.comparisonId).adoption,
    baseCommit: "a".repeat(40),
    headCommit: "b".repeat(40),
    targetBranchName: "main",
  });
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

test("failed comparison evidence sanitizes every persisted metric detail", async () => {
  const runtime = await loadRuntime();
  const sensitive = "/private/project/secret-worktree";
  const comparison = comparisonEvidence();
  comparison.variants[0] = {
    ...comparison.variants[0],
    changeset: {
      ...comparison.variants[0].changeset,
      status: "failed",
      files: [],
      diffStat: { added: 0, changed: 0, deleted: 0 },
      errorReason: sensitive,
    },
    metrics: [
      { kind: "changed-file-count", label: "Changed files", status: "unknown", source: "recorded", detail: sensitive },
      { kind: "diff-summary", label: "Diff summary", status: "unknown", source: "recorded", detail: sensitive },
    ],
  };
  const harness = runtimeHarness({ comparisonEvidence: comparison });

  await runtime.compareWorkflowWorktrees(harness.dependencies, "/project", comparisonInput());
  const recorded = harness.events.find((event) => event.kind === "workflow.variant.comparison_recorded");
  assert.ok(recorded);
  assert.doesNotMatch(JSON.stringify(recorded), /private|secret-worktree/);
  assert.deepEqual(
    recorded.payload.recording.comparison.variants[0].metrics.map((metric) => metric.detail),
    ["Git changeset collection failed.", "Git changeset collection failed."],
  );
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
  const events = options.events ? structuredClone(options.events) : createdEvents();
  const currentById = new Map([
    ["worktree-left", identity("left")],
    ["worktree-right", identity("right")],
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

function identity(side) {
  const headCommit = side === "left" ? "b".repeat(40) : "c".repeat(40);
  return {
    worktreeId: `worktree-${side}`,
    variantId: `variant-${side}`,
    path: `/project.worktrees/worktree-${side}`,
    realPath: `/project.worktrees/worktree-${side}`,
    gitdir: `/project/.git/worktrees/worktree-${side}`,
    repoRoot: "/project",
    branchName: `skyturn/session-1/variant-${side}`,
    baseCommit: "a".repeat(40),
    headCommit,
    parentLaneId: `lane-${side}`,
  };
}

function createdEvents(sessionId = "session-1") {
  return ["left", "right"].map((side, index) => ({
    id: `created-${side}`,
    seq: index + 1,
    sessionId,
    kind: "workflow.worktree.created",
    source: "git-worktree",
    payload: { worktree: identity(side) },
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
