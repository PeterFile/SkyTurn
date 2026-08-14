import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import test from "node:test";

let subject = {};
try {
  subject = await import("./candidateReviewCommitAcceptance.mjs");
} catch {
  // The first TDD run intentionally reaches the missing-export assertion.
}

const sha = (digit) => digit.repeat(40);
const digest = (digit) => digit.repeat(64);

test("desktop exposes the real candidate review commit acceptance", async () => {
  const packageJson = JSON.parse(await readFile(new URL("../package.json", import.meta.url), "utf8"));
  assert.equal(
    packageJson.scripts["acceptance:candidate-review-commit"],
    "node scripts/candidateReviewCommitAcceptance.mjs",
  );
});

test("renderer invocation uses only the public createDeliveryCommit IPC path and exercises one duplicate", () => {
  const buildCandidateReviewCommitRendererInvocation = requiredExport(
    "buildCandidateReviewCommitRendererInvocation",
  );
  const expression = buildCandidateReviewCommitRendererInvocation({
    projectRoot: "/private/disposable-project",
    sessionId: "session-candidate-review-commit",
    laneId: "lane-candidate-review-commit",
    worktreePath: "/private/disposable-project",
    subject: "test(delivery): publish reviewed candidate",
    body: "Prove real Hermes review through renderer IPC.",
  });

  assert.match(expression, /window\.devflow\?\.workflow/);
  assert.equal((expression.match(/workflow\.createDeliveryCommit\(/g) ?? []).length, 2);
  assert.match(expression, /workflow\.getEvents/);
  assert.match(expression, /workflow\.getProjection/);
  assert.doesNotMatch(expression, /(?:execFile|spawn)\s*\(|createCandidateDeliveryCommit|prepareCandidateDeliveryCommit|publishPreparedCandidateDeliveryCommit/);
});

test("process cleanup oracle avoids sandbox-blocked process table access", async () => {
  const source = await readFile(new URL("./candidateReviewCommitAcceptance.mjs", import.meta.url), "utf8");
  assert.doesNotMatch(source, /\/bin\/ps/);
  assert.match(source, /\/usr\/sbin\/lsof/);
});

test("candidate acceptance builds this checkout, rebuilds native dependencies, then verifies compiled files", async () => {
  const prepareCandidateReviewCommitCheckout = requiredExport("prepareCandidateReviewCommitCheckout");
  const checkoutRoot = fileURLToPath(new URL("../../..", import.meta.url));
  const calls = [];

  await prepareCandidateReviewCommitCheckout({
    deadline: Date.now() + 10_000,
    run: async (command, args, options) => {
      calls.push({ command, args, cwd: options.cwd });
      return { stdout: "", stderr: "" };
    },
    verifyCompiledFiles: async () => {
      calls.push({ command: "verify" });
    },
  });

  assert.deepEqual(calls, [
    { command: "pnpm", args: ["run", "build", "--force"], cwd: checkoutRoot },
    {
      command: "pnpm",
      args: ["--filter", "@skyturn/desktop", "run", "rebuild:native"],
      cwd: checkoutRoot,
    },
    { command: "verify" },
  ]);
  const source = await readFile(new URL("./candidateReviewCommitAcceptance.mjs", import.meta.url), "utf8");
  const preparation = source.indexOf("await prepareCandidateReviewCommitCheckout");
  assert.ok(preparation >= 0);
  assert.ok(preparation < source.indexOf('runElectronNodeMode("--seed"'));
  assert.ok(preparation < source.indexOf("app = await (services.launch ?? launchElectronAcceptanceApp)"));
});

test("candidate acceptance cannot continue after checkout build or native rebuild failure", async () => {
  const prepareCandidateReviewCommitCheckout = requiredExport("prepareCandidateReviewCommitCheckout");
  for (const failingCall of [1, 2]) {
    const calls = [];
    await assert.rejects(
      prepareCandidateReviewCommitCheckout({
        deadline: Date.now() + 10_000,
        run: async (_command, args) => {
          calls.push(args.join(" "));
          if (calls.length === failingCall) throw new Error("raw build diagnostic");
          return { stdout: "", stderr: "" };
        },
        verifyCompiledFiles: async () => {
          calls.push("verify");
        },
      }),
      (error) => {
        assert.doesNotMatch(error.message, /raw build diagnostic/);
        assert.match(error.message, failingCall === 1 ? /checkout build failed/ : /native rebuild failed/);
        return true;
      },
    );
    assert.deepEqual(
      calls,
      failingCall === 1
        ? ["run build --force"]
        : ["run build --force", "--filter @skyturn/desktop run rebuild:native"],
    );
  }
});

test("candidate review commit oracle accepts one exact reviewed publication with durable hidden preparation", () => {
  const candidateReviewCommitOracle = requiredExport("candidateReviewCommitOracle");
  const input = validOracleInput();
  const result = candidateReviewCommitOracle(input);

  assert.deepEqual(result, {
    ok: true,
    failures: [],
    rendererIpcInvoked: true,
    preloadApiAvailable: true,
    realHermesReviewObserved: true,
    manifestImmutable: true,
    reviewRequestExact: true,
    branchBindingExact: true,
    branchAdvanceCount: 1,
    parentMatchesManifestAfterHead: true,
    reviewedTreeExact: true,
    noExtraCandidateBytes: true,
    commitMessageExact: true,
    noRemoteDelivery: true,
    publicationPreparedDurable: true,
    commitCreatedDurable: true,
    publicationPreparedCount: 1,
    commitCreatedCount: 1,
    preparedOutsideProjection: true,
    preparedOutsideRenderer: true,
    duplicateCommitStable: true,
    duplicateEventsAbsent: true,
    hermesProtectedStateUnchanged: true,
    hermesTemporaryRootsUnchanged: true,
    verifierProcessesReaped: true,
    electronClosed: true,
    sqliteClosed: true,
    disposableResourcesRemoved: true,
  });
});

test("candidate renderer oracle summary retains rejection and both parent commits", () => {
  const summarizeCandidateReviewCommitRendererResult = requiredExport(
    "summarizeCandidateReviewCommitRendererResult",
  );
  const beforeHead = sha("a");
  const commitSha = sha("b");

  assert.deepEqual(summarizeCandidateReviewCommitRendererResult({
    publicApiAvailable: true,
    firstRejected: false,
    first: {
      status: "committed",
      commitSha,
      branch: "acceptance",
      parentCommit: beforeHead,
    },
    duplicate: {
      status: "committed",
      commitSha,
      branch: "acceptance",
      parentCommit: beforeHead,
    },
    preparedVisible: false,
    projectionPreparedCount: 0,
    createdVisibleCount: 1,
  }), {
    publicApiAvailable: true,
    firstRejected: false,
    firstStatus: "committed",
    firstCommitSha: commitSha,
    firstBranch: "acceptance",
    firstParentCommit: beforeHead,
    duplicateStatus: "committed",
    duplicateCommitSha: commitSha,
    duplicateBranch: "acceptance",
    duplicateParentCommit: beforeHead,
    preparedVisible: false,
    projectionPreparedCount: 0,
    createdVisibleCount: 1,
  });
});

test("candidate review commit oracle rejects request drift, duplicate facts, and cleanup leaks", () => {
  const candidateReviewCommitOracle = requiredExport("candidateReviewCommitOracle");
  const input = validOracleInput();
  input.review.actualRequestSha256 = digest("f");
  input.sqlite.reopened.createdCount = 2;
  input.renderer.preparedVisible = true;
  input.cleanup.verifierProcessesAfter = [9182];
  input.cleanup.resourcesRemoved = false;

  const result = candidateReviewCommitOracle(input);

  assert.equal(result.ok, false);
  assert.ok(result.failures.includes("review-request-mismatch"));
  assert.ok(result.failures.includes("commit-created-event-count-invalid"));
  assert.ok(result.failures.includes("prepared-visible-to-renderer"));
  assert.ok(result.failures.includes("verifier-process-survived"));
  assert.ok(result.failures.includes("disposable-resources-survived"));
});

test("candidate review commit oracle rejects incomplete or malformed input with one fixed failure", () => {
  const candidateReviewCommitOracle = requiredExport("candidateReviewCommitOracle");
  const mutations = [
    () => ({}),
    () => [],
    () => {
      const input = validOracleInput();
      delete input.expected.requestSha256;
      delete input.review.actualRequestSha256;
      delete input.review.expectedRequestSha256;
      return input;
    },
    () => {
      const input = validOracleInput();
      input.expected.beforeHead = null;
      return input;
    },
    () => {
      const input = validOracleInput();
      input.expected.commitSha = "B".repeat(40);
      return input;
    },
    () => {
      const input = validOracleInput();
      input.expected.manifestSha256 = "1".repeat(63);
      return input;
    },
    () => {
      const input = validOracleInput();
      input.expected.candidateFiles = null;
      return input;
    },
    () => {
      const input = validOracleInput();
      input.renderer.createdVisibleCount = "1";
      return input;
    },
    () => {
      const input = validOracleInput();
      input.renderer.firstStatus = null;
      return input;
    },
    () => {
      const input = validOracleInput();
      input.cleanup.electronClosed = 1;
      return input;
    },
  ];

  for (const mutate of mutations) {
    assert.deepEqual(candidateReviewCommitOracle(mutate()), {
      ok: false,
      failures: ["invalid-oracle-input"],
    });
  }
});

test("candidate review commit oracle rejects extra keys at every authoritative object schema", () => {
  const candidateReviewCommitOracle = requiredExport("candidateReviewCommitOracle");
  const cases = [
    ["root", (input) => { input.extra = true; }],
    ["expected", (input) => { input.expected.extra = true; }],
    ["renderer", (input) => { input.renderer.extra = true; }],
    ["review", (input) => { input.review.extra = true; }],
    ["git", (input) => { input.git.extra = true; }],
    ["sqlite", (input) => { input.sqlite.extra = true; }],
    ["reopened", (input) => { input.sqlite.reopened.extra = true; }],
    ["reopenedAgain", (input) => { input.sqlite.reopenedAgain.extra = true; }],
    ["manifest", (input) => { input.sqlite.seededManifest.extra = true; }],
    ["manifest terminal evidence", (input) => {
      input.sqlite.seededManifest.terminalRunEvidence.extra = true;
    }],
    ["manifest evidence check", (input) => {
      input.sqlite.seededManifest.terminalRunEvidence.checks[0].extra = true;
    }],
    ["prepared", (input) => { input.sqlite.reopened.prepared.extra = true; }],
    ["created", (input) => { input.sqlite.reopened.created.extra = true; }],
    ["review attestation", (input) => { input.sqlite.reopened.reviewAttestation.extra = true; }],
    ["cleanup", (input) => { input.cleanup.extra = true; }],
    ["protected state map", (input) => {
      input.cleanup.protectedStateBefore["unknown-protected-file"] = { kind: "missing" };
    }],
    ["protected state entry", (input) => {
      input.cleanup.protectedStateBefore["config.yaml"].extra = true;
    }],
  ];

  for (const [name, mutate] of cases) {
    const input = validOracleInput();
    mutate(input);
    assert.deepEqual(candidateReviewCommitOracle(input), {
      ok: false,
      failures: ["invalid-oracle-input"],
    }, name);
  }
});

test("candidate review commit oracle rejects missing, null, inherited, and malformed schema values", () => {
  const candidateReviewCommitOracle = requiredExport("candidateReviewCommitOracle");
  const cases = [
    ["missing root field", (input) => { delete input.cleanup; }],
    ["null expected field", (input) => { input.expected.body = null; }],
    ["null renderer field", (input) => { input.renderer.firstRejected = null; }],
    ["null review field", (input) => { input.review.actualRequestSha256 = null; }],
    ["null git field", (input) => { input.git.changedFiles = null; }],
    ["null sqlite field", (input) => { input.sqlite.reopened = null; }],
    ["null cleanup field", (input) => { input.cleanup.protectedStateAfter = null; }],
    ["array where record expected", (input) => { input.sqlite.reopened.prepared = []; }],
    ["null manifest field", (input) => {
      input.sqlite.seededManifest.terminalRunEvidence = null;
    }],
    ["missing protected filename", (input) => {
      delete input.cleanup.protectedStateBefore[".env"];
    }],
    ["null protected entry", (input) => {
      input.cleanup.protectedStateBefore["config.yaml"] = null;
    }],
    ["invalid status", (input) => { input.renderer.firstStatus = "success"; }],
    ["invalid disposition", (input) => {
      input.sqlite.reopened.reviewAttestation.disposition = "approved";
    }],
    ["negative count", (input) => { input.sqlite.reopened.preparedCount = -1; }],
    ["noninteger count", (input) => { input.git.remoteCount = 0.5; }],
    ["duplicate string array", (input) => {
      input.expected.candidateFiles = ["reviewed.txt", "reviewed.txt"];
    }],
    ["sparse string array", (input) => { input.expected.candidateFiles = new Array(1); }],
    ["malformed PID array", (input) => { input.cleanup.verifierProcessesBefore = [0]; }],
  ];

  for (const [name, mutate] of cases) {
    const input = validOracleInput();
    mutate(input);
    assert.deepEqual(candidateReviewCommitOracle(input), {
      ok: false,
      failures: ["invalid-oracle-input"],
    }, name);
  }

  const inherited = Object.create({ expected: validOracleInput().expected });
  Object.assign(inherited, validOracleInput());
  assert.deepEqual(candidateReviewCommitOracle(inherited), {
    ok: false,
    failures: ["invalid-oracle-input"],
  });
});

test("candidate review commit oracle requires an accepted first IPC result and exact renderer parents", () => {
  const candidateReviewCommitOracle = requiredExport("candidateReviewCommitOracle");

  for (const [name, mutate, failure] of [
    ["first rejected", (input) => { input.renderer.firstRejected = true; }, "renderer-ipc-result-invalid"],
    ["first parent mismatch", (input) => {
      input.renderer.firstParentCommit = sha("c");
    }, "renderer-ipc-result-invalid"],
    ["duplicate parent mismatch", (input) => {
      input.renderer.duplicateParentCommit = sha("c");
    }, "duplicate-ipc-result-conflict"],
  ]) {
    const input = validOracleInput();
    mutate(input);
    const result = candidateReviewCommitOracle(input);
    assert.equal(result.ok, false, name);
    assert.ok(result.failures.includes(failure), name);
  }

  for (const [name, mutate] of [
    ["null first parent", (input) => { input.renderer.firstParentCommit = null; }],
    ["uppercase first parent", (input) => { input.renderer.firstParentCommit = "A".repeat(40); }],
    ["short duplicate parent", (input) => { input.renderer.duplicateParentCommit = "b".repeat(39); }],
  ]) {
    const input = validOracleInput();
    mutate(input);
    assert.deepEqual(candidateReviewCommitOracle(input), {
      ok: false,
      failures: ["invalid-oracle-input"],
    }, name);
  }
});

test("candidate review commit oracle binds every parent surface to the immutable manifest after head", () => {
  const candidateReviewCommitOracle = requiredExport("candidateReviewCommitOracle");
  const input = validOracleInput();
  const wrongParent = sha("c");
  input.expected.beforeHead = wrongParent;
  input.renderer.firstParentCommit = wrongParent;
  input.renderer.duplicateParentCommit = wrongParent;
  input.git.parentCommit = wrongParent;
  for (const state of [input.sqlite.reopened, input.sqlite.reopenedAgain]) {
    state.prepared.parentCommit = wrongParent;
    state.created.parentCommit = wrongParent;
  }

  const result = candidateReviewCommitOracle(input);

  assert.equal(result.ok, false);
  assert.ok(result.failures.includes("commit-parent-mismatch"));
});

test("candidate review commit oracle binds every public and durable branch surface", () => {
  const candidateReviewCommitOracle = requiredExport("candidateReviewCommitOracle");
  const branchPaths = [
    ["git", "branch"],
    ["renderer", "firstBranch"],
    ["renderer", "duplicateBranch"],
    ["sqlite", "reopened", "prepared", "branch"],
    ["sqlite", "reopened", "created", "branch"],
    ["sqlite", "reopenedAgain", "prepared", "branch"],
    ["sqlite", "reopenedAgain", "created", "branch"],
  ];

  for (const path of branchPaths) {
    const input = validOracleInput();
    setPath(input, path, "wrong-branch");
    const result = candidateReviewCommitOracle(input);
    assert.equal(result.ok, false, path.join("."));
    assert.ok(result.failures.includes("candidate-branch-mismatch"), path.join("."));
  }
});

test("candidate review commit oracle rejects Git-invalid branch path components", () => {
  const candidateReviewCommitOracle = requiredExport("candidateReviewCommitOracle");
  for (const branch of ["release/.hidden", "release/topic.lock"]) {
    const input = validOracleInput();
    input.expected.branch = branch;
    input.renderer.firstBranch = branch;
    input.renderer.duplicateBranch = branch;
    input.git.branch = branch;
    input.sqlite.seededManifest.branchName = branch;
    for (const state of [input.sqlite.reopened, input.sqlite.reopenedAgain]) {
      state.manifest.branchName = branch;
      state.prepared.branch = branch;
      state.created.branch = branch;
    }
    assert.deepEqual(candidateReviewCommitOracle(input), {
      ok: false,
      failures: ["invalid-oracle-input"],
    }, branch);
  }
});

test("candidate review commit oracle requires one exact allow attestation after both reopens", () => {
  const candidateReviewCommitOracle = requiredExport("candidateReviewCommitOracle");
  const attestationMutations = [
    (attestation) => { attestation.requestSha256 = digest("f"); },
    (attestation) => { attestation.manifestSha256 = digest("e"); },
    (attestation) => { attestation.disposition = "block"; },
    (attestation) => { attestation.count = 2; },
  ];

  for (const reopenName of ["reopened", "reopenedAgain"]) {
    for (const mutate of attestationMutations) {
      const input = validOracleInput();
      mutate(input.sqlite[reopenName].reviewAttestation);
      const result = candidateReviewCommitOracle(input);
      assert.equal(result.ok, false, reopenName);
      assert.ok(result.failures.includes("review-request-mismatch"), reopenName);
    }
  }
});

test("candidate review commit oracle rejects prepared-event leakage through either reopened CanvasSession", () => {
  const candidateReviewCommitOracle = requiredExport("candidateReviewCommitOracle");
  for (const reopenName of ["reopened", "reopenedAgain"]) {
    const input = validOracleInput();
    input.sqlite[reopenName].canvasPreparedVisible = true;
    const result = candidateReviewCommitOracle(input);
    assert.equal(result.ok, false, reopenName);
    assert.ok(result.failures.includes("prepared-visible-to-renderer"), reopenName);
  }
});

test("candidate review commit oracle treats ambient Hermes observations as diagnostics only", () => {
  const candidateReviewCommitOracle = requiredExport("candidateReviewCommitOracle");
  const input = validOracleInput();
  input.review.temporaryRootObserved = false;
  input.review.verifierProcessObserved = false;

  const result = candidateReviewCommitOracle(input);

  assert.equal(result.ok, true);
  assert.equal(result.realHermesReviewObserved, false);
});

test("candidate review commit oracle rejects wrong integer evidence counts", () => {
  const candidateReviewCommitOracle = requiredExport("candidateReviewCommitOracle");
  for (const [path, value] of [
    [["git", "branchAdvanceCount"], 2],
    [["git", "remoteCount"], 1],
    [["renderer", "projectionPreparedCount"], 1],
    [["renderer", "createdVisibleCount"], 2],
    [["sqlite", "reopened", "preparedCount"], 0],
    [["sqlite", "reopenedAgain", "createdCount"], 2],
  ]) {
    const input = validOracleInput();
    setPath(input, path, value);
    assert.equal(candidateReviewCommitOracle(input).ok, false, path.join("."));
  }
});

test("lsof helpers accept only a clean exit-one no-match and strict PID output", async () => {
  const listHermesVerifierProcesses = requiredExport("listHermesVerifierProcesses");
  const noProcessHoldsFile = requiredExport("noProcessHoldsFile");
  const cleanNoMatch = Object.assign(new Error("no match"), {
    exitCode: 1,
    stdout: "",
    stderr: "",
    signal: null,
  });
  const noMatch = async () => { throw cleanNoMatch; };

  assert.deepEqual(await listHermesVerifierProcesses(noMatch), []);
  assert.equal(await noProcessHoldsFile("/private/secret.sqlite", noMatch), true);
  const strictMatch = async () => ({ stdout: "42\n7\n42\n", stderr: "" });
  assert.deepEqual(await listHermesVerifierProcesses(strictMatch), [7, 42]);
  assert.equal(await noProcessHoldsFile("/private/secret.sqlite", strictMatch), false);
});

test("lsof helpers fail closed on diagnostics, malformed PIDs, signals, and other errors", async () => {
  const listHermesVerifierProcesses = requiredExport("listHermesVerifierProcesses");
  const noProcessHoldsFile = requiredExport("noProcessHoldsFile");
  const failures = [
    async () => { throw Object.assign(new Error("bad"), { exitCode: 1, stdout: "12\n", stderr: "", signal: null }); },
    async () => { throw Object.assign(new Error("bad"), { exitCode: 1, stdout: "", stderr: "permission denied", signal: null }); },
    async () => { throw Object.assign(new Error("bad"), { exitCode: 1, stdout: "", stderr: "", signal: "SIGKILL" }); },
    async () => { throw Object.assign(new Error("bad"), { exitCode: 2, stdout: "", stderr: "", signal: null }); },
    async () => ({ stdout: "12\nnot-a-pid\n", stderr: "" }),
    async () => ({ stdout: "12\n", stderr: "diagnostic" }),
  ];

  for (const run of failures) {
    for (const operation of [
      () => listHermesVerifierProcesses(run),
      () => noProcessHoldsFile("/private/secret.sqlite", run),
    ]) {
      await assert.rejects(operation(), (error) => {
        assert.equal(error.message, "Process-holder inspection failed.");
        assert.doesNotMatch(error.message, /secret|permission|not-a-pid|diagnostic/);
        return true;
      });
    }
  }
});

test("bounded final JSON drops low-volume child and Git diagnostics and keeps fixed blocker keys", () => {
  const boundedCandidateReviewCommitJson = requiredExport("boundedCandidateReviewCommitJson");
  const sentinels = [
    "relative-secret-file.txt",
    "PROMPT_SENTINEL_do_not_leak",
    "Bearer eyJhbGciOiJIUzI1NiJ9.secret.signature",
    "build-user:correct-horse-battery-staple",
    "https://example.invalid/private-capability/abc123",
    "git status && curl -H secret-header",
    "TypeError",
  ];
  const diagnostic = sentinels.join(" | ");
  const output = boundedCandidateReviewCommitJson({
    ...candidateReviewCommitOracleResult(),
    blocker: {
      stage: "renderer-ipc",
      message: diagnostic,
      error: new TypeError(diagnostic),
    },
    diagnostics: diagnostic,
    gitStderr: diagnostic,
    childOutput: diagnostic,
  });

  assert.ok(Buffer.byteLength(output, "utf8") <= 4_096);
  for (const sentinel of sentinels) assert.equal(output.includes(sentinel), false, sentinel);
  const parsed = JSON.parse(output);
  assert.deepEqual(parsed.blocker, {
    stage: "renderer-ipc",
    code: "ACCEPTANCE_STAGE_FAILED",
  });
  assert.equal(parsed.reviewRequestExact, true);
  assert.equal(parsed.rendererIpcInvoked, true);
});

test("bounded final JSON maps unknown blocker stages and error objects to one fixed public shape", () => {
  const boundedCandidateReviewCommitJson = requiredExport("boundedCandidateReviewCommitJson");
  const sentinel = "UNKNOWN_ERROR_OBJECT_SENTINEL";
  const output = boundedCandidateReviewCommitJson({
    ...candidateReviewCommitOracleResult(),
    blocker: {
      stage: "custom-stage-with-private-data",
      code: "CUSTOM_PRIVATE_CODE",
      message: sentinel,
      cause: { name: "PrivateException", detail: sentinel },
    },
    error: new Error(sentinel),
  });

  assert.equal(output.includes(sentinel), false);
  assert.equal(output.includes("PrivateException"), false);
  assert.equal(output.includes("custom-stage-with-private-data"), false);
  assert.deepEqual(JSON.parse(output).blocker, {
    stage: "unknown",
    code: "ACCEPTANCE_STAGE_FAILED",
  });
});

function validOracleInput() {
  const beforeHead = sha("a");
  const commitSha = sha("b");
  const manifestSha256 = digest("1");
  const requestSha256 = digest("2");
  const fullPatchSha256 = digest("3");
  const fileManifestSha256 = digest("4");
  const ancestryProofSha256 = digest("5");
  const subject = "test(delivery): publish reviewed candidate";
  const body = "Prove real Hermes review through renderer IPC.";
  const manifest = {
    version: 1,
    createdAt: "2026-08-14T00:00:13.000Z",
    sessionId: "session-candidate-review-commit",
    nodeId: "lane-candidate-implementation",
    laneId: "lane-candidate-implementation",
    segmentId: "segment-candidate-implementation",
    runId: "run-candidate-implementation",
    agentKind: "codex",
    executionTarget: "current_branch",
    worktreeId: null,
    repositoryIdentity: digest("7"),
    worktreeIdentity: digest("8"),
    branchName: "acceptance",
    beforeCheckpointId: "checkpoint:run-candidate-implementation:before",
    beforeHeadCommit: beforeHead,
    afterCheckpointId: "checkpoint:run-candidate-implementation:after",
    afterHeadCommit: beforeHead,
    ancestryProofSha256,
    terminalEvidenceId: "evidence-segment-candidate-implementation",
    terminalRunEvidence: {
      runId: "run-candidate-implementation",
      status: "succeeded",
      exitCode: 0,
      changesetId: "changeset:run-candidate-implementation:candidate",
      checks: [{ kind: "test", status: "passed" }],
      artifactCount: 0,
      review: null,
      errorReason: null,
      cancelReason: null,
      completedAt: "2026-08-14T00:00:10.000Z",
    },
    terminalRunEvidenceSha256: digest("a"),
    changesetEvidenceId: "changeset-evidence:run-candidate-implementation:after",
    changesetId: "changeset:run-candidate-implementation:candidate",
    fullPatchSha256,
    fullPatchByteLength: 128,
    fileManifestSha256,
  };
  const persisted = {
    manifest,
    manifestSha256,
    preparedCount: 1,
    createdCount: 1,
    prepared: {
      manifestSha256,
      requestSha256: digest("6"),
      commitSha,
      parentCommit: beforeHead,
      expectedFullPatchSha256: fullPatchSha256,
      branch: "acceptance",
    },
    created: {
      manifestSha256,
      requestSha256: digest("6"),
      commitSha,
      parentCommit: beforeHead,
      branch: "acceptance",
    },
    projectionPreparedCount: 0,
    canvasPreparedVisible: false,
    reviewAttestation: {
      requestSha256,
      manifestSha256,
      disposition: "allow",
      count: 1,
    },
  };
  return {
    expected: {
      beforeHead,
      commitSha,
      manifestSha256,
      requestSha256,
      publicationRequestSha256: digest("6"),
      fullPatchSha256,
      fileManifestSha256,
      ancestryProofSha256,
      branch: "acceptance",
      subject,
      body,
      candidateFiles: ["reviewed.txt", "second.txt"],
    },
    renderer: {
      publicApiAvailable: true,
      firstRejected: false,
      firstStatus: "committed",
      firstCommitSha: commitSha,
      firstBranch: "acceptance",
      firstParentCommit: beforeHead,
      duplicateStatus: "committed",
      duplicateCommitSha: commitSha,
      duplicateBranch: "acceptance",
      duplicateParentCommit: beforeHead,
      preparedVisible: false,
      projectionPreparedCount: 0,
      createdVisibleCount: 1,
    },
    review: {
      actualRequestSha256: requestSha256,
      expectedRequestSha256: requestSha256,
      manifestSha256,
      fullPatchSha256,
      fileManifestSha256,
      ancestryProofSha256,
      temporaryRootObserved: true,
      verifierProcessObserved: true,
    },
    git: {
      branchAdvanceCount: 1,
      branch: "acceptance",
      parentCommit: beforeHead,
      commitSha,
      changedFiles: ["reviewed.txt", "second.txt"],
      reviewedFileBytesExact: true,
      treePatchSha256: fullPatchSha256,
      statusClean: true,
      subject,
      body,
      remoteCount: 0,
    },
    sqlite: {
      seededManifest: manifest,
      reopened: structuredClone(persisted),
      reopenedAgain: structuredClone(persisted),
    },
    cleanup: {
      protectedStateBefore: protectedState(),
      protectedStateAfter: protectedState(),
      hermesRootsBefore: [],
      hermesRootsAfter: [],
      verifierProcessesBefore: [],
      verifierProcessesAfter: [],
      electronClosed: true,
      sqliteClosed: true,
      resourcesRemoved: true,
    },
  };
}

function protectedState() {
  return {
    "config.yaml": {
      kind: "file",
      mode: 384,
      size: 42,
      sha256: digest("9"),
      device: "1",
      inode: "2",
    },
    ".env": { kind: "missing" },
    "auth.json": { kind: "missing" },
    ".anthropic_oauth.json": { kind: "missing" },
    "SOUL.md": { kind: "missing" },
    "USER.md": { kind: "missing" },
  };
}

function setPath(value, path, replacement) {
  let target = value;
  for (const key of path.slice(0, -1)) target = target[key];
  target[path.at(-1)] = replacement;
}

function candidateReviewCommitOracleResult() {
  const candidateReviewCommitOracle = requiredExport("candidateReviewCommitOracle");
  return candidateReviewCommitOracle(validOracleInput());
}

function requiredExport(name) {
  assert.equal(typeof subject[name], "function", `${name} export is required`);
  return subject[name];
}
