import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { createRequire } from "node:module";
import { mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  createLiveWorkflowGitAncestryProofContext,
  createGitChangesetService,
  createWorkflowGitAncestryProof,
  getGitCheckpointSnapshot,
  verifyWorkflowGitAncestryProof,
} from "../../../packages/git-worktree/dist/node.js";
import { createWorkflowStore } from "../../../packages/persistence/dist/workflowStore.js";
import checkpointRuntime from "../dist-electron/electron/workflowCheckpointRuntime.js";

const {
  WORKFLOW_CHECKPOINT_ANCESTRY_UNAVAILABLE_REASON,
  createAfterCheckpointAncestryProof,
  recordWorkflowCheckpointFailure,
  requireCheckpointBoundWorktreeBase,
  resolveExecutableRunBaseline,
  verifyWorkflowCheckpointActionGate,
} = checkpointRuntime;

const requireFromPersistence = createRequire(import.meta.resolve("@skyturn/persistence/workflow-store"));
const Database = requireFromPersistence("better-sqlite3");

const ancestryAuthority = {
  createProof: createWorkflowGitAncestryProof,
  createContext: createLiveWorkflowGitAncestryProofContext,
  verify: verifyWorkflowGitAncestryProof,
};

test("current-branch checkpoint evidence excludes volatile runtime and preserves the exact before HEAD after reopen", async () => {
  const root = await mkdtemp(join(tmpdir(), "skyturn-current-branch-checkpoint-"));
  try {
    git(root, "init");
    git(root, "checkout", "-b", "main");
    git(root, "config", "user.email", "skyturn@example.test");
    git(root, "config", "user.name", "SkyTurn Test");
    await mkdir(join(root, ".devflow", "memory"), { recursive: true });
    await writeFile(join(root, "src.ts"), "export const value = 1;\n", "utf8");
    await writeFile(join(root, ".devflow", "memory", "summaries.md"), "# Shared memory\n", "utf8");
    git(root, "add", "src.ts", ".devflow/memory/summaries.md");
    git(root, "commit", "-m", "initial");

    const store = createWorkflowStore({ projectRoot: root });
    seedExecutableRun(store, root);
    await mkdir(join(root, ".devflow", "runs", "run-session-1-lane-implementation"), { recursive: true });
    await mkdir(join(root, ".devflow", "tasks", "lane-implementation"), { recursive: true });
    await writeFile(join(root, ".devflow", "runs", "run-session-1-lane-implementation", "events.ndjson"), "{}\n", "utf8");
    await writeFile(join(root, ".devflow", "runs", "run-session-1-lane-implementation", "start-claim.json"), "{}\n", "utf8");
    await writeFile(join(root, ".devflow", "tasks", "lane-implementation", "output.md"), "runtime output\n", "utf8");
    for (const runtimePath of [
      ".devflow/skyturn-workflow.sqlite",
      ".devflow/runs/run-session-1-lane-implementation/events.ndjson",
      ".devflow/tasks/lane-implementation/output.md",
    ]) {
      assert.equal(gitExitCode(root, "check-ignore", "--no-index", runtimePath), 1);
    }

    const before = await getGitCheckpointSnapshot(root);
    assert.equal(before.worktreeState, "clean");
    store.recordRunCheckpoint({
      sessionId: "session-1",
      nodeId: "lane-implementation",
      laneId: "lane-implementation",
      runId: "run-session-1-lane-implementation",
      segmentId: "segment-session-1-lane-implementation",
      phase: "before",
      executionTarget: "current_branch",
      worktreePath: root,
      branchName: "main",
      headCommit: before.headCommit,
      worktreeState: before.worktreeState,
      evidenceRefs: [
        { kind: "run", id: "run-session-1-lane-implementation" },
        { kind: "segment", id: "segment-session-1-lane-implementation" },
      ],
      now: "2026-07-13T01:00:01.000Z",
    });
    store.close();

    await writeFile(join(root, "src.ts"), "export const value = 2;\n", "utf8");
    await writeFile(join(root, ".devflow", "memory", "summaries.md"), "# Shared memory\n\nUpdated.\n", "utf8");
    git(root, "add", "src.ts", ".devflow/memory/summaries.md");
    git(root, "commit", "-m", "change source and memory");

    const reopened = createWorkflowStore({ projectRoot: root });
    const after = await getGitCheckpointSnapshot(root);
    const baselineRef = resolveExecutableRunBaseline(reopened, {
      sessionId: "session-1",
      nodeId: "lane-implementation",
      laneId: "lane-implementation",
      segmentId: "segment-session-1-lane-implementation",
      runId: "run-session-1-lane-implementation",
      phase: "after",
      executionTarget: "current_branch",
      worktreePath: await realpath(root),
      branchName: "main",
      headCommit: after.headCommit,
    });
    const node = reopened.materializeCanvasSession("session-1").nodes.find((item) => item.id === "lane-implementation");
    const reconciliation = await createGitChangesetService({ repoRoot: root }).reconcileFinalChangeset({
      node,
      target: { executionTarget: "current_branch", selectedBranch: "main" },
      baselineRef,
    });

    assert.equal(baselineRef, before.headCommit);
    assert.deepEqual(reconciliation.changeset.files, [".devflow/memory/summaries.md", "src.ts"]);
    assert.match(reconciliation.changeset.patchPreview, /diff --git a\/\.devflow\/memory\/summaries\.md/);
    assert.match(reconciliation.changeset.patchPreview, /diff --git a\/src\.ts/);
    assert.doesNotMatch(reconciliation.changeset.patchPreview, /skyturn-workflow\.sqlite|events\.ndjson|start-claim\.json|output\.md/);
    reopened.close();
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("executable run baseline uses each target's exact matching before checkpoint instead of its static base", () => {
  const currentBefore = baselineCheckpoint({
    executionTarget: "current_branch",
    headCommit: "a".repeat(40),
  });
  const worktreeBefore = baselineCheckpoint({
    executionTarget: "new_worktree",
    worktreeId: "worktree-candidate",
    worktreePath: "/repo/.devflow/worktrees/candidate",
    branchName: "skyturn/session-1/candidate",
    headCommit: "b".repeat(40),
  });

  for (const checkpoint of [currentBefore, worktreeBefore]) {
    const calls = [];
    const baseline = resolveExecutableRunBaseline({
      listNodeCheckpoints(input) {
        calls.push(input);
        return [checkpoint];
      },
    }, {
      ...checkpoint,
      phase: "after",
      headCommit: "c".repeat(40),
    });

    assert.equal(baseline, checkpoint.headCommit);
    assert.deepEqual(calls, [{
      sessionId: checkpoint.sessionId,
      laneId: checkpoint.laneId,
      runId: checkpoint.runId,
      phase: "before",
    }]);
  }
  assert.notEqual(worktreeBefore.headCommit, "9".repeat(40), "per-run B must win over the static worktree base");
});

test("before run baseline uses the current canonical full HEAD without reading persisted checkpoints", () => {
  for (const executionTarget of ["current_branch", "new_worktree"]) {
    const headCommit = "D".repeat(40);
    const baseline = resolveExecutableRunBaseline({
      listNodeCheckpoints() {
        assert.fail("before baseline must not query persisted checkpoints");
      },
    }, {
      ...baselineCheckpoint({
        executionTarget,
        ...(executionTarget === "new_worktree" ? { worktreeId: "worktree-candidate" } : {}),
        headCommit,
      }),
      phase: "before",
    });
    assert.equal(baseline, headCommit.toLowerCase());
  }
});

test("after run baseline fails closed for duplicate, malformed, or mismatched before checkpoint authority", () => {
  const matching = baselineCheckpoint({
    executionTarget: "new_worktree",
    worktreeId: "worktree-later-run",
    worktreePath: "/repo/.devflow/worktrees/later-run",
    branchName: "skyturn/session-1/later-run",
    headCommit: "e".repeat(40),
  });
  const after = { ...matching, phase: "after", headCommit: "f".repeat(40) };
  const cases = [
    ["missing", []],
    ["duplicate", [matching, { ...matching }]],
    ["malformed", [{ ...matching, headCommit: "short" }]],
    ["cross-node", [{ ...matching, nodeId: "lane-other" }]],
    ["cross-segment", [{ ...matching, segmentId: "segment-other" }]],
    ["cross-worktree", [{ ...matching, worktreeId: "worktree-other" }]],
    ["cross-path", [{ ...matching, worktreePath: "/repo/.devflow/worktrees/other" }]],
    ["cross-target", [{ ...matching, executionTarget: "current_branch", worktreeId: undefined }]],
  ];

  for (const [label, checkpoints] of cases) {
    assert.throws(
      () => resolveExecutableRunBaseline({ listNodeCheckpoints: () => checkpoints }, after),
      /matching before checkpoint|identity|baseline|commit/i,
      label,
    );
  }
});

test("Electron after-proof production survives SQLite reopen and live-gates repair, variant, and rollback", async () => {
  const root = await createRepository("skyturn-electron-ancestry-linear-");
  try {
    let store = createWorkflowStore({ projectRoot: root });
    const segment = seedExecutableRun(store, root);
    const before = await recordCheckpoint(store, root, segment, "before");

    await writeFile(join(root, "src.ts"), "export const value = 2;\n", "utf8");
    git(root, "add", "src.ts");
    git(root, "commit", "-m", "change source");
    recordTerminalResult(store, segment);
    const afterSnapshot = await getGitCheckpointSnapshot(root);
    const proof = await createAfterCheckpointAncestryProof(store, {
      ...checkpointIdentity(root, segment, afterSnapshot),
      repositoryPath: root,
    }, ancestryAuthority);
    const after = store.recordRunCheckpoint({
      ...checkpointInput(root, segment, "after", afterSnapshot),
      ...proof,
      now: "2026-08-03T00:00:04.000Z",
    });
    store.close();

    store = createWorkflowStore({ projectRoot: root });
    for (const [action, checkpointId] of [
      ["repair", after.id],
      ["variant", before.id],
      ["rollback", before.id],
    ]) {
      const gate = await verifyWorkflowCheckpointActionGate(store, {
        action,
        sessionId: segment.sessionId,
        laneId: segment.laneId,
        checkpointId,
      }, liveGateAuthority(root));
      assert.equal(gate.available, true, `${action} should be live-verifiable`);
      assert.equal(gate.sourceCheckpoint.id, checkpointId);
      assert.equal(gate.beforeCheckpoint.headCommit, before.headCommit);
      assert.equal(gate.afterCheckpoint.headCommit, after.headCommit);
    }
    store.close();
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("Electron refuses an authoritative after checkpoint when Git history diverged", async () => {
  const root = await createRepository("skyturn-electron-ancestry-diverged-");
  try {
    const store = createWorkflowStore({ projectRoot: root });
    const segment = seedExecutableRun(store, root);
    await recordCheckpoint(store, root, segment, "before");
    await rewriteMainWithoutBeforeCommit(root);
    recordTerminalResult(store, segment);
    const afterSnapshot = await getGitCheckpointSnapshot(root);

    await assert.rejects(
      createAfterCheckpointAncestryProof(store, {
        ...checkpointIdentity(root, segment, afterSnapshot),
        repositoryPath: root,
      }, ancestryAuthority),
      /not an ancestor/i,
    );
    assert.equal(store.listNodeCheckpoints({ sessionId: segment.sessionId, phase: "after" }).length, 0);
    store.close();
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("legacy no-proof checkpoints stay readable but all Electron action gates are unavailable", async () => {
  const root = await createRepository("skyturn-electron-ancestry-legacy-");
  try {
    let store = createWorkflowStore({ projectRoot: root });
    const segment = seedExecutableRun(store, root);
    const before = await recordCheckpoint(store, root, segment, "before");
    recordTerminalResult(store, segment);
    const after = await recordCheckpoint(store, root, segment, "after");
    store.close();

    store = createWorkflowStore({ projectRoot: root });
    assert.equal(store.listNodeCheckpoints({ sessionId: segment.sessionId }).length, 2);
    for (const [action, checkpointId] of [
      ["repair", after.id],
      ["variant", before.id],
      ["rollback", before.id],
    ]) {
      const gate = await verifyWorkflowCheckpointActionGate(store, {
        action,
        sessionId: segment.sessionId,
        laneId: segment.laneId,
        checkpointId,
      }, liveGateAuthority(root));
      assert.deepEqual(gate, {
        available: false,
        reason: WORKFLOW_CHECKPOINT_ANCESTRY_UNAVAILABLE_REASON,
      });
    }
    store.close();
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("reopened Electron gates reject changed proof bytes and a mismatched persisted source pair", async () => {
  for (const tamper of ["proof", "pair"]) {
    const root = await createRepository(`skyturn-electron-ancestry-${tamper}-`);
    try {
      const { segment, before } = await seedProofBearingRun(root);
      tamperCheckpointDatabase(root, segment, before, tamper);
      const reopened = createWorkflowStore({ projectRoot: root });
      const gate = await verifyWorkflowCheckpointActionGate(reopened, {
        action: "repair",
        sessionId: segment.sessionId,
        laneId: segment.laneId,
        checkpointId: `checkpoint:${segment.runId}:after`,
      }, liveGateAuthority(root));
      assert.deepEqual(gate, {
        available: false,
        reason: WORKFLOW_CHECKPOINT_ANCESTRY_UNAVAILABLE_REASON,
      });
      reopened.close();
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  }
});

test("same-path Git re-init after SQLite reopen invalidates every live action gate", async () => {
  const root = await createRepository("skyturn-electron-ancestry-reinit-");
  try {
    const { segment, before, after } = await seedProofBearingRun(root);
    await rm(join(root, ".git"), { recursive: true, force: true });
    git(root, "init");
    git(root, "checkout", "-b", "main");
    git(root, "config", "user.email", "skyturn@example.test");
    git(root, "config", "user.name", "SkyTurn Test");
    git(root, "add", "src.ts");
    git(root, "commit", "-m", "recreated repository");

    const reopened = createWorkflowStore({ projectRoot: root });
    for (const [action, checkpointId] of [
      ["repair", after.id],
      ["variant", before.id],
      ["rollback", before.id],
    ]) {
      const gate = await verifyWorkflowCheckpointActionGate(reopened, {
        action,
        sessionId: segment.sessionId,
        laneId: segment.laneId,
        checkpointId,
      }, liveGateAuthority(root));
      assert.equal(gate.available, false);
      assert.equal(gate.reason, WORKFLOW_CHECKPOINT_ANCESTRY_UNAVAILABLE_REASON);
    }
    reopened.close();
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("after-proof failure records audit-only failure without changing durable terminal evidence", async () => {
  const root = await createRepository("skyturn-electron-ancestry-audit-");
  try {
    const store = createWorkflowStore({ projectRoot: root });
    const segment = seedExecutableRun(store, root);
    await recordCheckpoint(store, root, segment, "before");
    await rewriteMainWithoutBeforeCommit(root);
    recordTerminalResult(store, segment);
    const terminalBefore = store.materializeFlowProjection(segment.sessionId).evidence;
    const afterSnapshot = await getGitCheckpointSnapshot(root);
    let failure;
    try {
      await createAfterCheckpointAncestryProof(store, {
        ...checkpointIdentity(root, segment, afterSnapshot),
        repositoryPath: root,
      }, ancestryAuthority);
    } catch (error) {
      failure = error;
    }
    assert.ok(failure);
    recordWorkflowCheckpointFailure(store, {
      ...segment,
      phase: "after",
      now: "2026-08-03T00:00:05.000Z",
    });

    const events = store.listEvents(segment.sessionId);
    const audit = events.find((event) => event.kind === "workflow.node.checkpoint_failed");
    assert.deepEqual(audit?.payload, {
      runId: segment.runId,
      phase: "after",
      status: "failed",
      terminalRunPreserved: true,
      reason: "Workflow after checkpoint could not be recorded.",
    });
    const projection = store.materializeFlowProjection(segment.sessionId);
    assert.deepEqual(projection.evidence, terminalBefore);
    assert.equal(projection.checkpoints.some((checkpoint) => checkpoint.phase === "after"), false);
    assert.equal(projection.events.some((event) => event.kind === "workflow.node.checkpoint_failed"), false);
    store.close();
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("before-checkpoint failure audit does not claim terminal evidence exists", async () => {
  const events = [];
  recordWorkflowCheckpointFailure({
    appendWorkflowEvent(event) {
      events.push(event);
    },
  }, {
    sessionId: "session-before-failure",
    laneId: "lane-before-failure",
    segmentId: "segment-before-failure",
    runId: "run-before-failure",
    phase: "before",
    now: "2026-08-03T00:00:00.000Z",
  });

  assert.equal(events.length, 1);
  assert.equal(events[0].payload.reason, "Workflow before checkpoint could not be recorded.");
  assert.equal(Object.hasOwn(events[0].payload, "terminalRunPreserved"), false);
});

test("checkpoint-bound delayed worktree creation re-verifies live context and returns only the immutable source HEAD", async () => {
  const root = await createRepository("skyturn-electron-ancestry-delayed-");
  try {
    const { segment, before } = await seedProofBearingRun(root);
    let store = createWorkflowStore({ projectRoot: root });
    assert.equal(await requireCheckpointBoundWorktreeBase(store, {
      sessionId: segment.sessionId,
      sourceCheckpointId: before.id,
      sourceHeadCommit: before.headCommit,
      action: "variant",
    }, liveGateAuthority(root)), before.headCommit);
    store.close();

    await rm(join(root, ".git"), { recursive: true, force: true });
    git(root, "init");
    git(root, "checkout", "-b", "main");
    git(root, "config", "user.email", "skyturn@example.test");
    git(root, "config", "user.name", "SkyTurn Test");
    git(root, "add", "src.ts");
    git(root, "commit", "-m", "changed delayed source context");

    store = createWorkflowStore({ projectRoot: root });
    await assert.rejects(
      requireCheckpointBoundWorktreeBase(store, {
        sessionId: segment.sessionId,
        sourceCheckpointId: before.id,
        sourceHeadCommit: before.headCommit,
        action: "variant",
      }, liveGateAuthority(root)),
      new RegExp(WORKFLOW_CHECKPOINT_ANCESTRY_UNAVAILABLE_REASON.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")),
    );
    store.close();
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

function seedExecutableRun(store, projectRoot) {
  const session = store.createWorkflowSession({
    id: "session-1",
    projectId: "project-1",
    title: "Current branch run",
    goal: "Change source",
    mode: "fast",
    plannerProfile: "default",
    transport: "hermes_replay_recovery",
    recoveryReason: "test",
    target: { executionTarget: "current_branch", selectedBranch: "main" },
    now: "2026-07-13T01:00:00.000Z",
  });
  const plannerRunId = "run-session-1-initial-planner-turn";
  const { segment: plannerSegment } = store.claimPlannerRunStart({
    sessionId: session.id,
    laneId: session.plannerLaneId,
    runId: plannerRunId,
    agentKind: "hermes",
    worktreePath: projectRoot,
    now: "2026-07-13T01:00:00.025Z",
  });
  store.recordRunResult({
    ...plannerSegment,
    evidence: {
      runId: plannerRunId,
      status: "succeeded",
      exitCode: 0,
      changesetId: null,
      checks: [{ kind: "run-exit", name: "Hermes CLI exit", status: "passed" }],
      artifacts: [],
      review: null,
      errorReason: null,
      cancelReason: null,
      completedAt: "2026-07-13T01:00:00.050Z",
    },
    now: "2026-07-13T01:00:00.050Z",
  });
  store.recordPlannerIntentReconciled(plannerSegment, "2026-07-13T01:00:00.075Z");
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
    now: "2026-07-13T01:00:00.100Z",
  });
  const scheduled = store.scheduleReadyLanes("session-1", {
    allowedParallelism: 1,
    now: "2026-07-13T01:00:00.200Z",
  });
  assert.equal(scheduled.readyLanes.length, 1);
  return {
    sessionId: "session-1",
    laneId: "lane-implementation",
    nodeId: "lane-implementation",
    runId: scheduled.readyLanes[0].runId,
    segmentId: scheduled.readyLanes[0].segmentId,
    agentKind: "codex",
  };
}

async function createRepository(prefix) {
  const root = await mkdtemp(join(tmpdir(), prefix));
  git(root, "init");
  git(root, "checkout", "-b", "main");
  git(root, "config", "user.email", "skyturn@example.test");
  git(root, "config", "user.name", "SkyTurn Test");
  await writeFile(join(root, "src.ts"), "export const value = 1;\n", "utf8");
  git(root, "add", "src.ts");
  git(root, "commit", "-m", "initial");
  return realpath(root);
}

function checkpointInput(root, segment, phase, snapshot) {
  return {
    sessionId: segment.sessionId,
    nodeId: segment.nodeId,
    laneId: segment.laneId,
    runId: segment.runId,
    segmentId: segment.segmentId,
    phase,
    executionTarget: "current_branch",
    worktreePath: root,
    branchName: "main",
    headCommit: snapshot.headCommit,
    worktreeState: snapshot.worktreeState,
    evidenceRefs: [
      { kind: "run", id: segment.runId },
      { kind: "segment", id: segment.segmentId },
      ...(phase === "after" ? [{ kind: "evidence", id: `evidence-${segment.segmentId}` }] : []),
    ],
  };
}

function checkpointIdentity(root, segment, snapshot) {
  return {
    ...checkpointInput(root, segment, "after", snapshot),
    worktreePath: root,
  };
}

function baselineCheckpoint(overrides = {}) {
  return {
    id: "checkpoint:run-session-1-lane-implementation:before",
    sessionId: "session-1",
    nodeId: "lane-implementation",
    laneId: "lane-implementation",
    segmentId: "segment-session-1-lane-implementation",
    runId: "run-session-1-lane-implementation",
    phase: "before",
    executionTarget: "current_branch",
    worktreePath: "/repo",
    branchName: "main",
    headCommit: "a".repeat(40),
    ...overrides,
  };
}

async function recordCheckpoint(store, root, segment, phase) {
  const snapshot = await getGitCheckpointSnapshot(root);
  return store.recordRunCheckpoint({
    ...checkpointInput(root, segment, phase, snapshot),
    now: phase === "before" ? "2026-08-03T00:00:01.000Z" : "2026-08-03T00:00:04.000Z",
  });
}

function recordTerminalResult(store, segment) {
  store.recordRunResult({
    sessionId: segment.sessionId,
    laneId: segment.laneId,
    segmentId: segment.segmentId,
    runId: segment.runId,
    agentKind: segment.agentKind,
    outputSummary: "Completed.",
    evidence: {
      runId: segment.runId,
      status: "succeeded",
      exitCode: 0,
      changesetId: null,
      checks: [{ kind: "run-exit", name: "Codex CLI exit", status: "passed" }],
      artifacts: [],
      review: null,
      errorReason: null,
      cancelReason: null,
      completedAt: "2026-08-03T00:00:03.000Z",
    },
    now: "2026-08-03T00:00:03.000Z",
  });
}

async function seedProofBearingRun(root) {
  const store = createWorkflowStore({ projectRoot: root });
  const segment = seedExecutableRun(store, root);
  const before = await recordCheckpoint(store, root, segment, "before");
  await writeFile(join(root, "src.ts"), "export const value = 2;\n", "utf8");
  git(root, "add", "src.ts");
  git(root, "commit", "-m", "change source");
  recordTerminalResult(store, segment);
  const snapshot = await getGitCheckpointSnapshot(root);
  const proof = await createAfterCheckpointAncestryProof(store, {
    ...checkpointIdentity(root, segment, snapshot),
    repositoryPath: root,
  }, ancestryAuthority);
  const after = store.recordRunCheckpoint({
    ...checkpointInput(root, segment, "after", snapshot),
    ...proof,
    now: "2026-08-03T00:00:04.000Z",
  });
  store.close();
  return { segment, before, after };
}

function liveGateAuthority(root) {
  return {
    resolveCanonicalPaths: async () => ({ repositoryPath: root, worktreePath: root }),
    verify: verifyWorkflowGitAncestryProof,
  };
}

async function rewriteMainWithoutBeforeCommit(root) {
  git(root, "checkout", "--orphan", "rewritten-main");
  execFileSync("git", ["rm", "-rf", "--cached", "."], {
    cwd: root,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  });
  await rm(join(root, "src.ts"), { force: true });
  await writeFile(join(root, "rewritten.ts"), "export const rewritten = true;\n", "utf8");
  git(root, "add", "rewritten.ts");
  git(root, "commit", "-m", "rewrite history");
  git(root, "branch", "-f", "main", "HEAD");
  git(root, "checkout", "main");
}

function tamperCheckpointDatabase(root, segment, before, tamper) {
  const database = new Database(join(root, ".devflow", "skyturn-workflow.sqlite"));
  const idempotencyKey = tamper === "proof"
    ? `checkpoint:${segment.runId}:after`
    : `checkpoint:${segment.runId}:before`;
  const row = database.prepare(
    "SELECT payload_json FROM workflow_events WHERE session_id = ? AND idempotency_key = ?",
  ).get(segment.sessionId, idempotencyKey);
  const payload = JSON.parse(row.payload_json);
  if (tamper === "proof") {
    const parsed = JSON.parse(payload.checkpoint.ancestryProof);
    parsed.repositoryIdentity = `${parsed.repositoryIdentity.slice(0, -1)}${parsed.repositoryIdentity.endsWith("0") ? "1" : "0"}`;
    payload.checkpoint.ancestryProof = JSON.stringify(parsed);
  } else {
    payload.checkpoint.headCommit = before.headCommit.replace(/^./, before.headCommit.startsWith("0") ? "1" : "0");
  }
  database.prepare(
    "UPDATE workflow_events SET payload_json = ? WHERE session_id = ? AND idempotency_key = ?",
  ).run(JSON.stringify(payload), segment.sessionId, idempotencyKey);
  database.close();
}

function git(cwd, ...args) {
  return execFileSync("git", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
}

function gitExitCode(cwd, ...args) {
  return spawnSync("git", args, { cwd, stdio: "ignore" }).status;
}
