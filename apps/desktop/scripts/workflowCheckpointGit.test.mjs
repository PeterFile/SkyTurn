import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  createGitChangesetService,
  getGitCheckpointSnapshot,
} from "../../../packages/git-worktree/dist/node.js";
import { createWorkflowStore } from "../../../packages/persistence/dist/workflowStore.js";
import { resolveCurrentBranchRunBaseline } from "../dist-electron/electron/workflowCheckpointRuntime.js";

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
    const baselineRef = resolveCurrentBranchRunBaseline(reopened, {
      sessionId: "session-1",
      laneId: "lane-implementation",
      segmentId: "segment-session-1-lane-implementation",
      runId: "run-session-1-lane-implementation",
      phase: "after",
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
  store.scheduleReadyLanes("session-1", {
    allowedParallelism: 1,
    now: "2026-07-13T01:00:00.200Z",
  });
}

function git(cwd, ...args) {
  return execFileSync("git", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
}

function gitExitCode(cwd, ...args) {
  return spawnSync("git", args, { cwd, stdio: "ignore" }).status;
}
