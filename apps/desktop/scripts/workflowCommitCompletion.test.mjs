import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import vm from "node:vm";

import { createRequire } from "node:module";

const require = createRequire(import.meta.url);

test("successful commit process evidence fails closed without authoritative Git facts", async () => {
  const { adjudicateWorkflowRunEvidence, AUTHORITATIVE_COMMIT_FAILURE_REASON } = await loadRuntime();
  for (const scenario of ["A-to-A-dirty", "A-to-A-clean-empty", "A-to-B-dirty", "facts-unavailable"]) {
    const raw = succeededEvidence();
    const result = adjudicateWorkflowRunEvidence(commitLane(), raw, null);

    assert.equal(result.status, "failed", scenario);
    assert.equal(result.exitCode, 0, scenario);
    assert.equal(result.errorReason, AUTHORITATIVE_COMMIT_FAILURE_REASON, scenario);
    assert.equal(result.changesetId, null, scenario);
    assert.equal(JSON.stringify(result.checks.at(-1)), JSON.stringify({
      kind: "git",
      name: "Authoritative Git commit",
      status: "failed",
      detail: AUTHORITATIVE_COMMIT_FAILURE_REASON,
    }), scenario);
  }
});

test("clean advanced commits succeed for current branch and new worktree with bound changeset identity", async () => {
  const { adjudicateWorkflowRunEvidence } = await loadRuntime();
  for (const executionTarget of ["current_branch", "new_worktree"]) {
    const raw = succeededEvidence();
    const result = adjudicateWorkflowRunEvidence(
      commitLane(),
      raw,
      commitFacts(executionTarget),
    );

    assert.equal(result.status, "succeeded", executionTarget);
    assert.equal(result.exitCode, 0, executionTarget);
    assert.equal(result.changesetId, "changeset-lane-commit", executionTarget);
    assert.equal(JSON.stringify(result.checks.at(-1)), JSON.stringify({
      kind: "git",
      name: "Authoritative Git commit",
      status: "passed",
      detail: "Authoritative Git commit facts recorded.",
    }), executionTarget);
  }
});

test("raw failed, cancelled, and timed-out commit evidence stays exact", async () => {
  const { adjudicateWorkflowRunEvidence } = await loadRuntime();
  for (const raw of [
    terminalEvidence("failed", 7),
    terminalEvidence("cancelled", null),
    terminalEvidence("timed-out", null),
  ]) {
    assert.strictEqual(adjudicateWorkflowRunEvidence(commitLane(), raw, null), raw);
  }
});

test("nominal success without a zero exit stays exact and never freezes a commit manifest", async () => {
  const { adjudicateWorkflowRunEvidence, completeWorkflowRun } = await loadRuntime();
  for (const exitCode of [null, 9]) {
    const raw = terminalEvidence("succeeded", exitCode);
    assert.strictEqual(adjudicateWorkflowRunEvidence(commitLane(), raw, commitFacts("current_branch")), raw);
    const calls = [];
    const result = await completeWorkflowRun(commitLane(), raw, {
      readCommitFacts() {
        assert.fail("nonzero or missing exit must not read commit facts");
      },
      async captureAndRecordCommitFacts() {
        assert.fail("nonzero or missing exit must not capture commit facts");
      },
      recordRunResult(evidence) {
        calls.push(evidence);
      },
      freezeCandidateManifest() {
        assert.fail("nonzero or missing exit must not freeze a manifest");
      },
    });
    assert.strictEqual(result.evidence, raw);
    assert.deepEqual(calls, [raw]);
  }
});

test("ordinary executable lane success keeps unchanged-HEAD process evidence exact", async () => {
  const { adjudicateWorkflowRunEvidence } = await loadRuntime();
  const raw = succeededEvidence();
  assert.strictEqual(adjudicateWorkflowRunEvidence({ laneKind: "implementation", executable: true }, raw, null), raw);
});

test("completion records or reuses commit facts before terminal evidence and freezes afterward", async () => {
  const { completeWorkflowRun } = await loadRuntime();
  for (const mode of ["capture", "reopen"] ) {
    const calls = [];
    const facts = commitFacts("current_branch");
    const result = await completeWorkflowRun(commitLane(), succeededEvidence(), {
      readCommitFacts() {
        calls.push("read-facts");
        return mode === "reopen" ? facts : null;
      },
      async captureAndRecordCommitFacts() {
        calls.push("capture-facts");
        return facts;
      },
      recordRunResult(evidence) {
        calls.push(`terminal:${evidence.status}`);
      },
      freezeCandidateManifest() {
        calls.push("freeze-manifest");
      },
    });

    assert.equal(result.evidence.status, "succeeded", mode);
    assert.deepEqual(calls, mode === "capture"
      ? ["read-facts", "capture-facts", "terminal:succeeded", "freeze-manifest"]
      : ["read-facts", "terminal:succeeded", "freeze-manifest"]);
  }
});

test("completion fails closed before scheduling when commit facts cannot be recorded", async () => {
  const { completeWorkflowRun } = await loadRuntime();
  const calls = [];
  const result = await completeWorkflowRun(commitLane(), succeededEvidence(), {
    readCommitFacts() {
      calls.push("read-facts");
      return null;
    },
    async captureAndRecordCommitFacts() {
      calls.push("capture-facts");
      throw new Error("sensitive live Git error");
    },
    recordRunResult(evidence) {
      calls.push(`terminal:${evidence.status}:${String(evidence.exitCode)}`);
    },
    freezeCandidateManifest() {
      assert.fail("failed authoritative evidence must not freeze a manifest");
    },
  });

  assert.equal(result.evidence.status, "failed");
  assert.equal(result.evidence.exitCode, 0);
  assert.deepEqual(calls, ["read-facts", "capture-facts", "read-facts", "terminal:failed:0"]);
});

test("conflicting durable commit facts fail closed without live Git recollection", async () => {
  const { completeWorkflowRun } = await loadRuntime();
  let gitRecollections = 0;
  const result = await completeWorkflowRun(commitLane(), succeededEvidence(), {
    readCommitFacts() { throw new Error("durable fact identity conflict"); },
    async captureAndRecordCommitFacts() {
      gitRecollections += 1;
      return commitFacts("current_branch");
    },
    recordRunResult() {},
    freezeCandidateManifest() { assert.fail("conflicting facts must not freeze a manifest"); },
  });

  assert.equal(result.evidence.status, "failed");
  assert.equal(gitRecollections, 0);
});

test("manifest failure happens only after the successful terminal is durable", async () => {
  const { completeWorkflowRun } = await loadRuntime();
  const calls = [];
  await assert.rejects(completeWorkflowRun(commitLane(), succeededEvidence(), {
    readCommitFacts() { return commitFacts("current_branch"); },
    async captureAndRecordCommitFacts() { assert.fail("stored facts must avoid live Git"); },
    recordRunResult(evidence) { calls.push(`terminal:${evidence.status}`); },
    freezeCandidateManifest() {
      calls.push("freeze-manifest");
      throw new Error("crash-after-terminal");
    },
  }), /crash-after-terminal/);
  assert.deepEqual(calls, ["terminal:succeeded", "freeze-manifest"]);
});

function commitLane() {
  return {
    laneKind: "commit",
    executable: true,
    sessionId: "session-1",
    nodeId: "lane-commit",
    laneId: "lane-commit",
    segmentId: "segment-commit",
    runId: "run-commit",
  };
}

function succeededEvidence() {
  return terminalEvidence("succeeded", 0);
}

function terminalEvidence(status, exitCode) {
  return {
    runId: "run-commit",
    status,
    exitCode,
    changesetId: status === "succeeded" ? "agent-claimed-changeset" : null,
    checks: [{
      kind: "run-exit",
      name: "Codex CLI exit",
      status: status === "succeeded" ? "passed" : status === "cancelled" ? "skipped" : "failed",
      detail: `exit=${String(exitCode)}`,
    }],
    artifacts: [],
    review: null,
    errorReason: status === "failed" || status === "timed-out" ? "raw-agent-failure" : null,
    cancelReason: status === "cancelled" ? "raw-agent-cancel" : null,
    completedAt: "2026-08-16T00:00:08.000Z",
  };
}

function commitFacts(executionTarget) {
  const worktree = {
    executionTarget,
    ...(executionTarget === "new_worktree" ? { worktreeId: "worktree-candidate" } : {}),
    worktreePath: executionTarget === "new_worktree" ? "/repo.worktrees/candidate" : "/repo",
    branchName: executionTarget === "new_worktree" ? "skyturn/session/candidate" : "main",
  };
  return {
    sessionId: "session-1",
    nodeId: "lane-commit",
    laneId: "lane-commit",
    segmentId: "segment-commit",
    runId: "run-commit",
    baselineHeadCommit: "a".repeat(40),
    beforeCheckpoint: {
      ...worktree,
      phase: "before",
      headCommit: "a".repeat(40),
      worktreeState: "clean",
    },
    afterCheckpoint: {
      ...worktree,
      phase: "after",
      headCommit: "b".repeat(40),
      worktreeState: "clean",
      ancestryProof: "strict-proof",
    },
    changesetEvidence: {
      evidenceId: "changeset-evidence:run-commit:after",
      changesetId: "changeset-lane-commit",
      source: "git",
      status: "available",
      files: ["src/index.ts"],
      diffStat: { added: 1, changed: 1, deleted: 0 },
      patchPreviewTruncated: false,
      fullPatchSha256: "4".repeat(64),
      fullPatchByteLength: 16,
      fileManifestSha256: "5".repeat(64),
    },
  };
}

async function loadRuntime() {
  const source = await readFile(new URL("../electron/workflowCommitCompletion.ts", import.meta.url), "utf8");
  const ts = require("typescript");
  const output = ts.transpileModule(source, {
    compilerOptions: {
      module: ts.ModuleKind.CommonJS,
      target: ts.ScriptTarget.ES2022,
    },
  }).outputText;
  const module = { exports: {} };
  vm.runInNewContext(output, {
    module,
    exports: module.exports,
    Object,
  }, { filename: "workflowCommitCompletion.ts" });
  return module.exports;
}
