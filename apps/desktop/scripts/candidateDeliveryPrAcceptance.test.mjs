import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, realpath, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

let subject = {};
try {
  subject = await import("./candidateDeliveryPrAcceptance.mjs");
} catch {
  // The red TDD run may reach missing exports before the implementation exists.
}

const branch = "skyturn/smoke/20260818T010203Z-deadbeef";
const markerFile = ".devflow/smoke/20260818T010203Z-deadbeef.md";
const candidateSha = "a".repeat(40);
const baseSha = "b".repeat(40);
const mergeSha = "c".repeat(40);
const treeSha = "d".repeat(40);
const manifestSha256 = "e".repeat(64);
const prUrl = "https://github.com/acme/skyturn-p3-oneshot/pull/1";
const repo = "acme/skyturn-p3-oneshot";
const checkName = "Candidate delivery";
const workflowPath = ".github/workflows/candidate-delivery.yml";
const workflowId = 424242;

test("candidate delivery acceptance stays inert without both destructive opt-ins", async () => {
  const runCandidateDeliveryAcceptance = requiredExport("runCandidateDeliveryAcceptance");

  for (const env of [
    {},
    { SKYTURN_REAL_DELIVERY_ACCEPTANCE: "1" },
  ]) {
    const lines = [];
    const calls = [];
    const result = await runCandidateDeliveryAcceptance({
      env,
      write: (line) => lines.push(line),
      services: new Proxy({}, {
        get(_target, property) {
          return async () => {
            calls.push(String(property));
            throw new Error("disabled acceptance must not perform side effects");
          };
        },
      }),
    });

    assert.equal(result.status, "skipped");
    assert.deepEqual(calls, []);
    assert.deepEqual(lines, [`SKIPPED: ${result.reason}`]);
  }
});

test("desktop keeps the bounded candidate delivery acceptance entrypoint", async () => {
  const packageJson = JSON.parse(await readFile(new URL("../package.json", import.meta.url), "utf8"));
  assert.equal(
    packageJson.scripts["acceptance:candidate-delivery-pr"],
    "node scripts/candidateDeliveryPrAcceptance.mjs",
  );
});

test("opt-in input requires one explicit non-SkyTurn repository and deterministic check", () => {
  const parseCandidateDeliveryAcceptanceInput = requiredExport("parseCandidateDeliveryAcceptanceInput");
  const input = parseCandidateDeliveryAcceptanceInput(realAcceptanceEnv(), {
    now: new Date("2026-08-18T01:02:03.000Z"),
    randomHex: () => "deadbeef",
  });

  assert.deepEqual(input, {
    enabled: true,
    repo,
    baseBranch: "main",
    remote: "origin",
    checkName,
    workflowPath,
    expectedReviewStatus: "approved",
    branch,
    smokeId: "20260818T010203Z-deadbeef",
    markerFile,
    checkTimeoutMs: 9000,
    pollIntervalMs: 2000,
    maxCheckAttempts: 5,
  });

  for (const [name, value, pattern] of [
    ["SKYTURN_DELIVERY_ACCEPTANCE_REPO", undefined, /repository/i],
    ["SKYTURN_DELIVERY_ACCEPTANCE_REPO", "acme/SkyTurn", /SkyTurn repository/i],
    ["SKYTURN_DELIVERY_ACCEPTANCE_REPO", "https://github.com/acme/disposable", /repo/i],
    ["SKYTURN_DELIVERY_ACCEPTANCE_CHECK_NAME", undefined, /check/i],
    ["SKYTURN_DELIVERY_ACCEPTANCE_WORKFLOW_PATH", undefined, /workflow/i],
    ["SKYTURN_DELIVERY_ACCEPTANCE_WORKFLOW_PATH", "candidate.yml", /workflow/i],
    ["SKYTURN_DELIVERY_ACCEPTANCE_EXPECTED_REVIEW_STATUS", undefined, /review/i],
    ["SKYTURN_DELIVERY_ACCEPTANCE_EXPECTED_REVIEW_STATUS", "unknown", /review/i],
    ["SKYTURN_DELIVERY_ACCEPTANCE_BASE_BRANCH", "develop", /main/i],
    ["SKYTURN_DELIVERY_ACCEPTANCE_REMOTE", "upstream", /origin/i],
    ["GH_REPO", "acme/other", /GH_REPO/i],
    ["GH_HOST", "github.example.test", /GH_HOST/i],
  ]) {
    const env = realAcceptanceEnv();
    if (value === undefined) delete env[name];
    else env[name] = value;
    assert.throws(() => parseCandidateDeliveryAcceptanceInput(env), pattern);
  }
});

test("preflight oracle requires a fresh one-shot main repository with exact settings", () => {
  const validateCandidateDeliveryPreflight = requiredExport("validateCandidateDeliveryPreflight");
  const facts = validPreflightFacts();

  assert.deepEqual(validateCandidateDeliveryPreflight(facts, enabledInput()), {
    repo,
    repoRoot: "/tmp/skyturn-delivery/project",
    baseBranch: "main",
    baseHead: baseSha,
    workflow: { id: workflowId, name: checkName, path: workflowPath, state: "active" },
  });

  const mutations = [
    ["repository identity", (value) => { value.repository.nameWithOwner = "acme/other"; }],
    ["default main", (value) => { value.repository.defaultBranch = "develop"; }],
    ["squash", (value) => { value.repository.squashMergeAllowed = false; }],
    ["head deletion", (value) => { value.repository.deleteBranchOnMerge = true; }],
    ["archived", (value) => { value.repository.archived = true; }],
    ["push permission", (value) => { value.repository.canPush = false; }],
    ["fork", (value) => { value.repository.isFork = true; }],
    ["Actions", (value) => { value.actions.enabled = false; }],
    ["workflow id", (value) => { value.workflow.id = 0; }],
    ["workflow path", (value) => { value.workflow.path = ".github/workflows/other.yml"; }],
    ["workflow active", (value) => { value.workflow.state = "disabled_manually"; }],
    ["one-shot PR history", (value) => { value.priorPullRequestCount = 1; }],
    ["classic branch protection", (value) => { value.branchProtectionRuleCount = 1; }],
    ["repository ruleset", (value) => { value.rulesetCount = 1; }],
    ["local main", (value) => { value.local.branch = "topic"; }],
    ["clean checkout", (value) => { value.local.status = "?? stray.txt"; }],
    ["local exact head", (value) => { value.local.localMainHead = candidateSha; }],
    ["origin exact head", (value) => { value.local.originMainHead = candidateSha; }],
    ["fresh remote main", (value) => { value.local.remoteMainHead = candidateSha; }],
    ["zero divergence", (value) => { value.local.divergence = [1, 0]; }],
    ["fetch remote", (value) => { value.local.fetchRepo = "acme/other"; }],
    ["push remote", (value) => { value.local.pushRepo = "acme/other"; }],
    ["fetch host", (value) => { value.local.fetchHost = "github.example.test"; }],
    ["push host", (value) => { value.local.pushHost = "github.example.test"; }],
    ["single main ref", (value) => { value.local.remoteBranches.push({ name: "topic", sha: baseSha }); }],
    ["single origin remote", (value) => { value.local.remoteNames.push("upstream"); }],
    ["fresh smoke ref", (value) => { value.local.smokeBranchHead = candidateSha; }],
  ];
  for (const [label, mutate] of mutations) {
    const invalid = structuredClone(facts);
    mutate(invalid);
    assert.throws(
      () => validateCandidateDeliveryPreflight(invalid, enabledInput()),
      undefined,
      label,
    );
  }
});

test("preflight collector clones only the explicit non-fork repo and proves local main facts", async () => {
  const preflightCandidateDeliveryAcceptance = requiredExport("preflightCandidateDeliveryAcceptance");
  const tempRoot = await mkdtemp(join(tmpdir(), "skyturn-candidate-delivery-preflight-"));
  const repoRoot = join(tempRoot, "project");
  const calls = [];
  try {
    const result = await preflightCandidateDeliveryAcceptance({
      cwd: "/tmp/skyturn-source",
      input: enabledInput(),
      repoRoot,
      run: async (command, args, options) => {
        calls.push({ command, args, cwd: options.cwd });
        if (command === "gh" && args[0] === "repo" && args[1] === "clone") {
          await mkdir(repoRoot, { recursive: true });
          return { stdout: "", stderr: "" };
        }
        if (command === "gh" && args[0] === "api") {
          if (args[1] === `repos/${repo}`) {
            return { stdout: JSON.stringify({
              full_name: repo,
              default_branch: "main",
              allow_squash_merge: true,
              delete_branch_on_merge: false,
              archived: false,
              disabled: false,
              fork: false,
              permissions: { push: true },
            }), stderr: "" };
          }
          if (args[1] === `repos/${repo}/actions/permissions`) {
            return { stdout: JSON.stringify({ enabled: true }), stderr: "" };
          }
          if (args[1].startsWith(`repos/${repo}/actions/workflows`)) {
            return { stdout: JSON.stringify({
              workflows: [{ id: workflowId, name: checkName, path: workflowPath, state: "active" }],
            }), stderr: "" };
          }
          if (args[1] === "graphql") {
            return { stdout: JSON.stringify({
              data: { repository: { branchProtectionRules: { totalCount: 0 } } },
            }), stderr: "" };
          }
          if (args[1].startsWith(`repos/${repo}/rulesets`)) {
            return { stdout: "[]", stderr: "" };
          }
        }
        if (command === "gh" && args[0] === "pr") return { stdout: "[]", stderr: "" };
        if (command === "git") {
          const action = args[0];
          if (action === "symbolic-ref") return { stdout: "main\n", stderr: "" };
          if (action === "status") return { stdout: "", stderr: "" };
          if (action === "rev-parse") return { stdout: `${baseSha}\n`, stderr: "" };
          if (action === "rev-list") return { stdout: "0\t0\n", stderr: "" };
          if (action === "remote" && args[1] === "get-url") {
            return { stdout: `https://github.com/${repo}.git\n`, stderr: "" };
          }
          if (action === "remote") return { stdout: "origin\n", stderr: "" };
          if (action === "ls-remote") {
            return { stdout: `${baseSha}\trefs/heads/main\n`, stderr: "" };
          }
          if (action === "fetch") return { stdout: "", stderr: "" };
        }
        return { stdout: "", stderr: "" };
      },
    });

    assert.equal(result.repo, repo);
    assert.equal(result.repoRoot, await realpath(repoRoot));
    assert.equal(result.baseHead, baseSha);
    assert.deepEqual(result.workflow, {
      id: workflowId,
      name: checkName,
      path: workflowPath,
      state: "active",
    });
    const clone = calls.find(({ command, args }) => command === "gh" && args[0] === "repo");
    assert.ok(clone.args.includes("--no-upstream"));
    assert.equal(calls.some(({ args }) => args.includes("create") || args.includes("merge")), false);
  } finally {
    await rm(tempRoot, { recursive: true, force: true });
  }
});

test("workflow run collector queries the retained numeric workflow and exact candidate filters", async () => {
  const readCandidateWorkflowRuns = requiredExport("readCandidateWorkflowRuns");
  const calls = [];
  const result = await readCandidateWorkflowRuns({
    cwd: "/tmp/disposable-project",
    repo,
    workflowId,
    workflowPath,
    expectedHeadSha: candidateSha,
    run: async (command, args, options) => {
      calls.push({ command, args, cwd: options.cwd });
      return {
        stdout: JSON.stringify({
          total_count: 1,
          workflow_runs: [{
            id: 9001,
            workflow_id: workflowId,
            path: workflowPath,
            head_sha: candidateSha.toUpperCase(),
            event: "pull_request",
            status: "completed",
            conclusion: "success",
          }],
        }),
        stderr: "",
      };
    },
  });

  assert.deepEqual(result, [successfulWorkflowRun()]);
  assert.deepEqual(calls, [{
    command: "gh",
    args: [
      "api",
      `repos/${repo}/actions/workflows/${workflowId}/runs?event=pull_request&head_sha=${candidateSha}&per_page=100`,
    ],
    cwd: "/tmp/disposable-project",
  }]);
});

test("six public actions are separate, ordered, exact-head, and observed before the next invocation", async () => {
  const runPublicDeliveryActions = requiredExport("runPublicDeliveryActions");
  const trace = [];
  const workflow = completeWorkflow(trace);

  const result = await runPublicDeliveryActions({
    workflow,
    ...deliveryActionInput(),
    waitForGate: async (input) => {
      trace.push("poll-exact-head-gate");
      assert.equal(input.expectedHeadSha, candidateSha);
      assert.equal(input.checkName, checkName);
      assert.equal(input.workflowId, workflowId);
      assert.equal(input.workflowPath, workflowPath);
      return passedChecksEvidence();
    },
    captureState: async ({ completedAction, actions }) => {
      trace.push(`capture:${completedAction}`);
      assert.equal(actions.actionOrder.at(-1), completedAction);
      return { completedAction };
    },
  });

  assert.equal(result.ok, true);
  assert.deepEqual(result.actionOrder, [
    "createDeliveryCommit",
    "pushDeliveryBranch",
    "createPullRequest",
    "checkPullRequest",
    "mergePullRequest",
    "syncMain",
  ]);
  assert.deepEqual(trace, [
    "createDeliveryCommit",
    "capture:createDeliveryCommit",
    "pushDeliveryBranch",
    "capture:pushDeliveryBranch",
    "createPullRequest",
    "capture:createPullRequest",
    "poll-exact-head-gate",
    "checkPullRequest",
    "capture:checkPullRequest",
    "mergePullRequest",
    "capture:mergePullRequest",
    "syncMain",
    "capture:syncMain",
  ]);
  assert.deepEqual(result.commit, {
    status: "committed",
    commitSha: candidateSha,
    branch,
    parentCommit: baseSha,
  });
  assert.equal(result.checks.status, "passed");
  assert.equal(result.checks.gate.state, "OPEN");
  assert.equal(result.checks.gate.mergeable, true);
  assert.deepEqual(result.checks.workflowRuns, [successfulWorkflowRun()]);
  assert.equal(result.merge.headSha, candidateSha);
  assert.deepEqual(result.sync, { status: "synced", mainBranch: "main", remote: "origin" });
  assert.equal(result.boundaries.length, 6);

  const calls = workflow.calls;
  assert.deepEqual(calls.createDeliveryCommit, {
    sessionId: fixture().sessionId,
    laneId: fixture().commitLaneId,
    worktreePath: "/tmp/skyturn-delivery/project.worktrees/candidate",
    subject: "test(delivery): verify candidate worktree IPC",
    body: "Prove all explicit delivery actions.",
  });
  assert.deepEqual(calls.mergePullRequest, {
    sessionId: fixture().sessionId,
    laneId: fixture().pullRequestLaneId,
    prNumber: 1,
    prUrl,
    expectedHeadSha: candidateSha,
    subject: "test(delivery): verify candidate worktree IPC",
    body: "Prove all explicit delivery actions.",
  });
  assert.deepEqual(calls.syncMain, {
    sessionId: fixture().sessionId,
    laneId: fixture().pullRequestLaneId,
    prNumber: 1,
    prUrl,
    expectedHeadSha: candidateSha,
    mainBranch: "main",
    remote: "origin",
  });
});

test("missing either real Hermes observation stops after Commit and before Push", async () => {
  const invokeCandidateDeliveryThroughRenderer = requiredExport("invokeCandidateDeliveryThroughRenderer");

  for (const [label, observation] of [
    ["temporary root", { temporaryRootObserved: false, verifierProcessObserved: true }],
    ["verifier process", { temporaryRootObserved: true, verifierProcessObserved: false }],
  ]) {
    const trace = [];
    const workflow = completeWorkflow(trace);
    const cdp = {
      evaluate(expression) {
        const method = [
          "createDeliveryCommit",
          "pushDeliveryBranch",
          "createPullRequest",
          "checkPullRequest",
          "mergePullRequest",
          "syncMain",
        ].find((candidate) => expression.includes(`workflow.${candidate}(`));
        assert.ok(method, label);
        return workflow[method](deliveryActionInput().projectRoot, deliveryActionInput());
      },
    };

    const result = await invokeCandidateDeliveryThroughRenderer(
      cdp,
      {
        ...deliveryActionInput(),
        waitForGate: async () => passedChecksEvidence(),
      },
      {
        observeReview: async (operation) => ({
          value: await operation(),
          observation,
        }),
      },
    );

    assert.equal(result.actions.ok, false, label);
    assert.equal(result.actions.failure.stage, "createDeliveryCommit", label);
    assert.deepEqual(result.actions.actionOrder, ["createDeliveryCommit"], label);
    assert.equal(trace.includes("pushDeliveryBranch"), false, label);
    assert.deepEqual(result.reviewObservation, observation, label);
  }
});

test("pending or invalid public checks cannot reach merge or sync", async () => {
  const runPublicDeliveryActions = requiredExport("runPublicDeliveryActions");
  const trace = [];
  const workflow = completeWorkflow(trace, { checksStatus: "pending" });

  const result = await runPublicDeliveryActions({
    workflow,
    ...deliveryActionInput(),
    waitForGate: async () => passedChecksEvidence(),
  });

  assert.equal(result.ok, false);
  assert.equal(result.failure.stage, "checkPullRequest");
  assert.equal(result.failure.code, "CHECK_GATE_NOT_PASSED");
  assert.equal(trace.includes("mergePullRequest"), false);
  assert.equal(trace.includes("syncMain"), false);
});

test("exact configured workflow run gates public Checks and Merge for every identity mismatch", async () => {
  const runPublicDeliveryActions = requiredExport("runPublicDeliveryActions");
  const cases = [
    ["absent", (evidence) => { evidence.workflowRuns = []; }],
    ["duplicate", (evidence) => { evidence.workflowRuns.push(successfulWorkflowRun({ id: 9002 })); }],
    ["stale head", (evidence) => { evidence.workflowRuns[0].headSha = baseSha; }],
    ["wrong event", (evidence) => { evidence.workflowRuns[0].event = "push"; }],
    ["wrong path", (evidence) => { evidence.workflowRuns[0].path = ".github/workflows/other.yml"; }],
    ["wrong workflow id", (evidence) => { evidence.workflowRuns[0].workflowId = workflowId + 1; }],
    ["not completed", (evidence) => {
      evidence.workflowRuns[0].status = "in_progress";
      evidence.workflowRuns[0].conclusion = null;
    }],
    ["failed", (evidence) => { evidence.workflowRuns[0].conclusion = "failure"; }],
  ];

  for (const [label, mutate] of cases) {
    const trace = [];
    const evidence = passedChecksEvidence();
    mutate(evidence);
    const result = await runPublicDeliveryActions({
      workflow: completeWorkflow(trace),
      ...deliveryActionInput(),
      waitForGate: async () => evidence,
    });

    assert.equal(result.ok, false, label);
    assert.equal(result.failure.code, "CHECK_GATE_NOT_PASSED", label);
    assert.equal(trace.includes("checkPullRequest"), false, label);
    assert.equal(trace.includes("mergePullRequest"), false, label);
  }
});

test("renderer builds one public workflow invocation at a time and never embeds shell access", () => {
  const buildRendererDeliveryActionInvocation = requiredExport("buildRendererDeliveryActionInvocation");
  const methods = [
    "createDeliveryCommit",
    "pushDeliveryBranch",
    "createPullRequest",
    "checkPullRequest",
    "mergePullRequest",
    "syncMain",
  ];
  for (const method of methods) {
    const expression = buildRendererDeliveryActionInvocation(method, "/tmp/disposable/project", { marker: method });
    assert.match(expression, /window\.devflow\?\.workflow/);
    assert.match(expression, new RegExp(`workflow\\.${method}\\(`));
    for (const other of methods.filter((candidate) => candidate !== method)) {
      assert.doesNotMatch(expression, new RegExp(`workflow\\.${other}\\(`));
    }
    assert.doesNotMatch(expression, /(?:execFile|spawn)\s*\(|["'](?:git|gh)["']/);
  }
  assert.throws(
    () => buildRendererDeliveryActionInvocation("deleteRepository", "/tmp/project", {}),
    /public delivery action/i,
  );
});

test("terminal oracle proves authoritative projection, canvas, C, M, and synced main", () => {
  const candidateDeliveryOracle = requiredExport("candidateDeliveryOracle");
  const input = validOracleInput();
  const result = candidateDeliveryOracle(input);

  assert.equal(result.ok, true);
  assert.deepEqual(result.failures, []);
  assert.equal(result.candidateSha, candidateSha);
  assert.equal(result.mergeSha, mergeSha);
  assert.deepEqual(result.deliveryEventKinds, deliveryEventKinds());
  assert.equal(result.rendererReopenPreserved, true);
  assert.equal(result.manifestReopenPreserved, true);
  assert.equal(result.authoritativeStateValid, true);
  assert.equal(result.authoritativeReopenPreserved, true);
  assert.equal(result.noCleanupAction, true);
});

test("terminal oracle accepts projection-relative sequences after audit-only events are excluded", () => {
  const candidateDeliveryOracle = requiredExport("candidateDeliveryOracle");
  const input = validOracleInput();
  const projectedDeliveryEvents = input.persistedState.projection.events.filter(
    (event) => deliveryEventKinds().includes(event.kind),
  );
  for (const [index, event] of projectedDeliveryEvents.entries()) event.seq = index + 1;
  input.reopenedPersistedState = structuredClone(input.persistedState);

  const result = candidateDeliveryOracle(input);

  assert.equal(result.ok, true);
  assert.deepEqual(result.failures, []);
  assert.equal(result.authoritativeStateValid, true);
});

test("terminal oracle rejects correct raw evidence with empty, duplicate, wrong-kind, or wrong-status authority", () => {
  const candidateDeliveryOracle = requiredExport("candidateDeliveryOracle");
  const cases = [
    ["persisted empty projection lanes", (input) => { input.persistedState.projection.lanes = []; }],
    ["reopened duplicate projection lane", (input) => {
      input.reopenedPersistedState.projection.lanes.push(
        structuredClone(input.reopenedPersistedState.projection.lanes[0]),
      );
    }],
    ["persisted wrong projection kind", (input) => {
      const lane = input.persistedState.projection.lanes.find(
        (item) => item.id === fixture().reviewLaneId,
      );
      lane.kind = "validation";
      lane.laneKind = "validation";
    }],
    ["reopened wrong projection status", (input) => {
      input.reopenedPersistedState.projection.lanes.find(
        (item) => item.id === fixture().commitLaneId,
      ).status = "pending";
    }],
    ["persisted empty canvas nodes", (input) => { input.persistedState.canvasSession.nodes = []; }],
    ["reopened duplicate canvas node", (input) => {
      const node = input.reopenedPersistedState.canvasSession.nodes.find(
        (item) => item.id === fixture().pullRequestLaneId,
      );
      input.reopenedPersistedState.canvasSession.nodes.push(structuredClone(node));
    }],
    ["persisted wrong canvas kind", (input) => {
      input.persistedState.canvasSession.nodes.find(
        (item) => item.id === fixture().validationLaneId,
      ).laneKind = "implementation";
    }],
    ["reopened wrong canvas status", (input) => {
      input.reopenedPersistedState.canvasSession.nodes.find(
        (item) => item.id === fixture().implementationLaneId,
      ).status = "failed";
    }],
  ];

  for (const [label, mutate] of cases) {
    const input = validOracleInput();
    mutate(input);
    const result = candidateDeliveryOracle(input);
    assert.equal(result.manifestReopenPreserved, true, label);
    assert.equal(result.rendererReopenPreserved, true, label);
    assert.equal(result.ok, false, label);
    assert.equal(result.authoritativeStateValid, false, label);
  }
});

test("stale terminal renderer cache cannot hide reopened authoritative projection or event drift", () => {
  const candidateDeliveryOracle = requiredExport("candidateDeliveryOracle");

  for (const [label, mutate] of [
    ["empty reopened projection", (input) => {
      input.reopenedPersistedState.projection.lanes = [];
      input.reopenedPersistedState.canvasSession.nodes = [];
    }],
    ["projection event disagrees with raw event", (input) => {
      const projectedCommit = input.reopenedPersistedState.projection.events.find(
        (item) => item.kind === "workflow.commit.created",
      );
      projectedCommit.payload.evidence.commitSha = "f".repeat(40);
    }],
  ]) {
    const input = validOracleInput();
    input.rendererState = hydratedRendererState();
    input.reopenedRendererState = hydratedRendererState();
    mutate(input);
    const result = candidateDeliveryOracle(input);

    assert.equal(result.rendererReopenPreserved, true, label);
    assert.equal(result.manifestReopenPreserved, true, label);
    assert.equal(result.ok, false, label);
  }
});

test("relaunch restores the original seeded workspace after close and rebuilds terminal UI from authority", async () => {
  const runCandidateDeliveryAcceptance = requiredExport("runCandidateDeliveryAcceptance");
  const tempRoot = await mkdtemp(join(tmpdir(), "skyturn-candidate-delivery-reopen-"));
  const harness = candidateRunnerHarness(await realpath(tempRoot));
  try {
    const result = await runCandidateDeliveryAcceptance({
      env: pendingReviewAcceptanceEnv(),
      now: new Date("2026-08-18T01:02:03.000Z"),
      randomHex: () => "deadbeef",
      write: () => {},
      services: harness.services,
    });

    assert.equal(result.status, "completed");
    assert.equal(result.ok, true);
    assert.equal(result.oracle.authoritativeStateValid, true);
    assert.equal(result.oracle.authoritativeReopenPreserved, true);
    assert.deepEqual(harness.workspaceAtRelaunch, harness.seededWorkspace);
    assert.notDeepEqual(harness.workspaceAtRelaunch, harness.staleTerminalWorkspace);
    const firstClose = harness.trace.indexOf("close:first");
    const reset = harness.trace.indexOf("workspace:reset");
    const relaunch = harness.trace.indexOf("launch:reopened");
    assert.ok(firstClose >= 0 && firstClose < reset && reset < relaunch, harness.trace.join(" -> "));
  } finally {
    await rm(tempRoot, { recursive: true, force: true });
  }
});

test("workspace reset failure is stage-bound, sanitized, and prevents Electron relaunch", async () => {
  const runCandidateDeliveryAcceptance = requiredExport("runCandidateDeliveryAcceptance");
  const tempRoot = await mkdtemp(join(tmpdir(), "skyturn-candidate-delivery-reset-failure-"));
  const canonicalTempRoot = await realpath(tempRoot);
  const harness = candidateRunnerHarness(canonicalTempRoot, { failWorkspaceReset: true });
  try {
    const result = await runCandidateDeliveryAcceptance({
      env: pendingReviewAcceptanceEnv(),
      now: new Date("2026-08-18T01:02:03.000Z"),
      randomHex: () => "deadbeef",
      write: () => {},
      services: harness.services,
    });

    assert.equal(result.status, "failed");
    assert.equal(result.failure.stage, "workspace-reset-before-relaunch");
    assert.match(result.failure.diagnostic, /workspace reset failed/i);
    assert.doesNotMatch(result.failure.diagnostic, /ghp_reset_secret/);
    assert.equal(result.failure.diagnostic.includes(canonicalTempRoot), false);
    assert.equal(harness.trace.includes("launch:reopened"), false);
    assert.ok(harness.trace.indexOf("close:first") < harness.trace.indexOf("workspace:reset"));
  } finally {
    await rm(tempRoot, { recursive: true, force: true });
  }
});

test("terminal oracle requires both real Hermes observations despite a durable allow event", () => {
  const candidateDeliveryOracle = requiredExport("candidateDeliveryOracle");

  for (const [label, observation] of [
    ["temporary root", { temporaryRootObserved: false, verifierProcessObserved: true }],
    ["verifier process", { temporaryRootObserved: true, verifierProcessObserved: false }],
  ]) {
    const input = validOracleInput();
    input.reviewObservation = observation;
    const durableAllow = input.persistedState.events.filter(
      (item) => item.kind === "workflow.candidate.review_allowed",
    );
    assert.equal(durableAllow.length, 1, label);
    assert.equal(durableAllow[0].payload.decision.disposition, "allow", label);
    assert.equal(candidateDeliveryOracle(input).ok, false, label);
  }
});

test("terminal oracle rejects missing, duplicate, stale, unordered, or cleanup-mutated evidence", () => {
  const candidateDeliveryOracle = requiredExport("candidateDeliveryOracle");
  const cases = [
    ["missing sync", (input) => {
      input.persistedState.events = input.persistedState.events.filter(
        (item) => item.kind !== "workflow.delivery.main_synced",
      );
    }],
    ["duplicate checks", (input) => {
      const check = structuredClone(input.persistedState.events.find((event) => event.kind === "workflow.pull_request.checks_recorded"));
      check.seq = 99;
      input.persistedState.events.push(check);
    }],
    ["pending checks", (input) => {
      const check = input.persistedState.events.find((event) => event.kind === "workflow.pull_request.checks_recorded");
      check.payload.status = "pending";
      check.payload.evidence.status = "pending";
    }],
    ["wrong candidate", (input) => { input.finalRemote.pullRequest.headRefOid = "f".repeat(40); }],
    ["open PR", (input) => { input.finalRemote.pullRequest.state = "OPEN"; }],
    ["wrong merge", (input) => { input.finalRemote.remoteMainHead = "f".repeat(40); }],
    ["unsynced local main", (input) => { input.finalRemote.localMainHead = baseSha; }],
    ["not a squash tree", (input) => { input.finalRemote.mainTreeSha = "f".repeat(40); }],
    ["wrong squash parent", (input) => { input.finalRemote.mainParentCommit = candidateSha; }],
    ["renderer lost sync", (input) => { input.reopenedRendererState.gates["Sync main"] = "blocked"; }],
    ["renderer lost implementation lineage", (input) => {
      for (const state of [input.rendererState, input.reopenedRendererState]) {
        state.lanes = state.lanes.filter((lane) => lane.id !== fixture().implementationLaneId);
      }
    }],
    ["manifest drift", (input) => { input.reopenedPersistedState.manifestSha256 = "f".repeat(64); }],
    ["sync event lost session scope", (input) => {
      for (const persisted of [input.persistedState, input.reopenedPersistedState]) {
        const sync = persisted.events.find((item) => item.kind === "workflow.delivery.main_synced");
        sync.payload.sessionWide = false;
      }
    }],
    ["cleanup action", (input) => {
      input.persistedState.events.push(event(100, "workflow.worktree.cleaned", { result: {} }));
    }],
    ["boundary skipped push", (input) => { input.boundaries.splice(1, 1); }],
    ["boundary exposed early sync side effect", (input) => {
      input.boundaries[4].remoteSideEffectEventKinds.push("workflow.delivery.main_synced");
      input.boundaries[4].remoteSideEffectCompletedKinds.push("workflow.delivery.main_synced");
    }],
  ];

  for (const [label, mutate] of cases) {
    const input = validOracleInput();
    mutate(input);
    assert.equal(candidateDeliveryOracle(input).ok, false, label);
  }
});

test("remote side-effect oracle rejects failed-then-successful and duplicate completions", () => {
  const candidateDeliveryOracle = requiredExport("candidateDeliveryOracle");

  for (const [label, firstStatus] of [
    ["failed then successful", "failed"],
    ["successful duplicate", "succeeded"],
  ]) {
    const input = validOracleInput();
    for (const persisted of [input.persistedState, input.reopenedPersistedState]) {
      insertRepeatedRemoteCompletion(
        persisted.events,
        "workflow.delivery.pushed",
        firstStatus,
      );
    }
    assert.equal(candidateDeliveryOracle(input).ok, false, label);
  }
});

test("delivery boundary cannot hide an extra remote completion in derived success arrays", () => {
  const candidateDeliveryOracle = requiredExport("candidateDeliveryOracle");
  const input = validOracleInput();
  const boundary = input.boundaries[1];
  const completion = structuredClone(boundary.persisted.events.find(
    (item) => item.kind === "workflow.remote_side_effect.completed",
  ));
  completion.id = "boundary-hidden-failed-completion";
  completion.seq += 1;
  completion.payload.status = "failed";
  boundary.persisted.events.push(completion);

  assert.deepEqual(boundary.remoteSideEffectCompletedKinds, ["workflow.delivery.pushed"]);
  assert.equal(candidateDeliveryOracle(input).ok, false);
});

test("seed source uses production changeset, checkpoint, ancestry, manifest, and new-worktree helpers", async () => {
  const source = await readFile(new URL("./candidateDeliveryPrAcceptance.mjs", import.meta.url), "utf8");
  const start = source.indexOf("export async function seedCandidateDeliveryStore");
  const end = source.indexOf("export async function inspectCandidateDeliveryStore", start);
  const seed = source.slice(start, end);

  assert.ok(start >= 0 && end > start);
  assert.match(seed, /createGitChangesetService/);
  assert.match(seed, /createWorkflowGitAncestryProof/);
  assert.match(seed, /createLiveWorkflowGitAncestryProofContext/);
  assert.match(seed, /recordRunCheckpoint/);
  assert.match(seed, /phase:\s*["']before["']/);
  assert.match(seed, /phase:\s*["']after["']/);
  assert.match(seed, /freezeCandidateManifest/);
  assert.match(seed, /resolveWorkflowDeliveryCandidateIdentity/);
  assert.match(seed, /workflow\.worktree\.created/);
  assert.match(seed, /executionTarget:\s*["']new_worktree["']/);
  assert.match(seed, /fullPatchSha256/);
  assert.match(seed, /fullPatchByteLength/);
  assert.match(seed, /fileManifestSha256/);
  assert.doesNotMatch(seed, /appendCandidateReviewAllowed|workflow\.candidate\.review_allowed/);
  assert.doesNotMatch(seed, /diffStat:\s*\{\s*added:\s*1/);
  assert.match(source, /"--no-upstream"/);
});

test("merged cleanup preserves PR/repository/main and deletes only an exact leased smoke ref plus local temp state", async () => {
  const cleanupCandidateDeliveryResources = requiredExport("cleanupCandidateDeliveryResources");
  const commands = [];
  const removed = [];
  let remotePresent = true;
  const state = cleanupState();

  const result = await cleanupCandidateDeliveryResources({
    state,
    run: async (command, args, options) => {
      commands.push({ command, args, cwd: options.cwd });
      if (command === "git" && args[0] === "ls-remote") {
        return {
          stdout: remotePresent ? `${candidateSha}\trefs/heads/${branch}\n` : "",
          stderr: "",
        };
      }
      if (command === "git" && args[0] === "push") remotePresent = false;
      return { stdout: "", stderr: "" };
    },
    remove: async (path, options) => removed.push({ path, options }),
  });

  assert.equal(result.status, "cleaned");
  assert.equal(result.prClosed, false);
  assert.equal(result.remoteBranchDeleted, true);
  assert.equal(result.localBranchDeleted, true);
  assert.equal(result.localStateRemoved, true);
  assert.equal(commands.some(({ command }) => command === "gh"), false);
  assert.equal(commands.some(({ args }) => args.includes("reset") || args.includes("checkout")), false);
  assert.equal(commands.some(({ args }) => args.includes("repo") && args.includes("delete")), false);
  const push = commands.find(({ command, args }) => command === "git" && args[0] === "push");
  assert.deepEqual(push.args, [
    "push",
    `--force-with-lease=refs/heads/${branch}:${candidateSha}`,
    "origin",
    `:refs/heads/${branch}`,
  ]);
  assert.deepEqual(removed, [{
    path: state.tempRoot,
    options: { recursive: true, force: true },
  }]);
});

test("cleanup fails closed and retains local evidence when the smoke ref lease does not match", async () => {
  const cleanupCandidateDeliveryResources = requiredExport("cleanupCandidateDeliveryResources");
  const commands = [];
  const removed = [];
  const result = await cleanupCandidateDeliveryResources({
    state: cleanupState(),
    run: async (command, args, options) => {
      commands.push({ command, args, cwd: options.cwd });
      if (command === "git" && args[0] === "ls-remote") {
        return { stdout: `${"f".repeat(40)}\trefs/heads/${branch}\n`, stderr: "" };
      }
      return { stdout: "", stderr: "" };
    },
    remove: async (...args) => removed.push(args),
  });

  assert.equal(result.status, "cleanup-failed");
  assert.equal(commands.some(({ args }) => args[0] === "push"), false);
  assert.equal(commands.some(({ args }) => args[0] === "worktree" || args[0] === "update-ref"), false);
  assert.deepEqual(removed, []);
  assert.match(result.message, /exact audited candidate head/i);
});

test("cleanup preserves OPEN pull request evidence without attempting close, branch deletion, or local deletion", async () => {
  const cleanupCandidateDeliveryResources = requiredExport("cleanupCandidateDeliveryResources");
  const commands = [];
  const removed = [];
  const state = cleanupState();
  state.pr.state = "OPEN";
  state.pr.mergeCommitOid = null;
  state.mergeSha = null;

  const result = await cleanupCandidateDeliveryResources({
    state,
    run: async (command, args, options) => {
      commands.push({ command, args, cwd: options.cwd });
      return { stdout: "", stderr: "" };
    },
    remove: async (...args) => removed.push(args),
  });

  assert.equal(result.status, "evidence-retained");
  assert.deepEqual(commands, []);
  assert.deepEqual(removed, []);
});

test("cleanup returns only safe audit facts on success and failure", async () => {
  const cleanupCandidateDeliveryResources = requiredExport("cleanupCandidateDeliveryResources");
  const state = cleanupState({
    tempRoot: "/private/tmp/skyturn-candidate-delivery-secret root",
    repoRoot: "/private/tmp/skyturn-candidate-delivery-secret root/repository checkout",
    candidateWorktreePath: "/private/tmp/skyturn-candidate-delivery-secret root/worktrees/candidate checkout",
    userDataPath: "/private/tmp/skyturn-candidate-delivery-secret root/electron user data",
  });
  const sensitivePaths = [
    state.repoRoot,
    `${state.repoRoot}/.git/config`,
    state.candidateWorktreePath,
    `${state.candidateWorktreePath}/nested/output.txt`,
    state.userDataPath,
    `${state.userDataPath}/Default/Preferences`,
    state.tempRoot,
    `${state.tempRoot}/cleanup-child`,
  ];
  let remotePresent = true;
  const success = await cleanupCandidateDeliveryResources({
    state,
    run: async (command, args) => {
      if (command === "git" && args[0] === "ls-remote") {
        return { stdout: remotePresent ? `${candidateSha}\trefs/heads/${branch}\n` : "", stderr: "" };
      }
      if (command === "git" && args[0] === "push") remotePresent = false;
      return { stdout: "", stderr: "" };
    },
    remove: async () => {},
  });

  assert.equal(success.status, "cleaned");
  assert.equal(success.audit.repository, repo);
  assert.equal(success.audit.branch, branch);
  assert.equal(success.audit.candidateSha, candidateSha);
  assert.equal(success.audit.pullRequest.number, 1);
  assertNoPathLeak(success, sensitivePaths);

  const failure = await cleanupCandidateDeliveryResources({
    state,
    run: async () => {
      throw new Error(`command stderr: ${sensitivePaths.join(" | ")}`);
    },
    remove: async () => {},
  });
  assert.equal(failure.status, "cleanup-failed");
  assert.equal(failure.audit.repository, repo);
  assert.equal(failure.remoteBranchDeleted, false);
  assertNoPathLeak(failure, sensitivePaths);
});

test("failure recovery independently discovers an unknown remote mutation before cleanup", async () => {
  const recoverCandidateDeliveryFailureState = requiredExport("recoverCandidateDeliveryFailureState");
  const state = cleanupState();
  state.remoteBranchCreated = false;
  state.pr = null;
  state.mergeSha = null;
  const remote = finalRemoteState();
  remote.pullRequest.state = "OPEN";
  remote.pullRequest.mergeCommitOid = null;
  remote.remoteMainHead = baseSha;
  remote.localMainHead = baseSha;
  remote.originMainHead = baseSha;

  const recovered = await recoverCandidateDeliveryFailureState({
    state,
    actions: { commit: { commitSha: candidateSha }, pullRequest: null },
    audit: async () => remote,
  });

  assert.equal(recovered.remoteBranchCreated, true);
  assert.equal(recovered.pr.state, "OPEN");
  assert.equal(recovered.remoteEvidenceUncertain, false);
});

test("enabled preflight failure is structured, stage-bound, sanitized, and never reported as skipped", async () => {
  const runCandidateDeliveryAcceptance = requiredExport("runCandidateDeliveryAcceptance");
  const tempRoot = await mkdtemp(join(tmpdir(), "skyturn-candidate-delivery-test-"));
  try {
    const result = await runCandidateDeliveryAcceptance({
      env: realAcceptanceEnv(),
      write: () => {},
      services: {
        prepareCheckout: async () => {},
        makeTempRoot: async () => tempRoot,
        preflight: async () => {
          throw new Error("token=ghp_should_not_escape exact preflight fact missing");
        },
      },
    });

    assert.equal(result.status, "failed");
    assert.equal(result.ok, false);
    assert.equal(result.failure.stage, "preflight");
    assert.match(result.failure.diagnostic, /exact preflight fact missing/);
    assert.doesNotMatch(result.failure.diagnostic, /ghp_should_not_escape/);
    assert.notEqual(result.status, "skipped");
    await assert.rejects(stat(tempRoot), { code: "ENOENT" });
  } finally {
    await rm(tempRoot, { recursive: true, force: true });
  }
});

test("returned and serialized failure results redact every known checkout and temporary root", async () => {
  const runCandidateDeliveryAcceptance = requiredExport("runCandidateDeliveryAcceptance");
  const tempRoot = await mkdtemp(join(tmpdir(), "skyturn-candidate-delivery-public-paths-"));
  const checkoutRoot = join(tmpdir(), "SkyTurn source checkout secret");
  const repoRoot = join(tempRoot, "repository checkout");
  const candidateWorktreePath = join(tempRoot, "worktrees", "candidate checkout");
  const userDataPath = join(tempRoot, "user-data");
  const sensitivePaths = [
    checkoutRoot,
    join(checkoutRoot, "apps", "desktop"),
    repoRoot,
    join(repoRoot, ".git", "config"),
    candidateWorktreePath,
    join(candidateWorktreePath, "nested", "output.txt"),
    userDataPath,
    join(userDataPath, "Default", "Preferences"),
    tempRoot,
    join(tempRoot, "cleanup", "child"),
  ];
  const lines = [];
  try {
    const result = await runCandidateDeliveryAcceptance({
      cwd: checkoutRoot,
      env: realAcceptanceEnv(),
      write: (line) => lines.push(line),
      services: {
        makeTempRoot: async () => tempRoot,
        preflight: async () => {
          throw new Error(`preflight diagnostics: ${sensitivePaths.join(" | ")}`);
        },
        cleanup: async () => ({
          status: "cleanup-failed",
          prClosed: false,
          remoteBranchDeleted: false,
          localBranchDeleted: false,
          localStateRemoved: false,
          audit: {
            repository: repo,
            branch,
            candidateSha,
            pullRequest: finalRemoteState().pullRequest,
            repoRoot,
            candidateWorktreePath,
            userDataPath,
            tempRoot,
          },
          message: `cleanup diagnostics: ${sensitivePaths.join(" | ")}`,
        }),
      },
    });

    assert.equal(result.status, "failed");
    assert.equal(result.cleanup.audit.repository, repo);
    assert.equal(result.cleanup.audit.branch, branch);
    assert.equal(result.cleanup.audit.candidateSha, candidateSha);
    assert.equal(result.cleanup.remoteBranchDeleted, false);
    assert.equal(lines.length, 1);
    assert.deepEqual(JSON.parse(lines[0]), result);
    assertNoPathLeak(result, sensitivePaths);
    assertNoPathLeak(lines[0], sensitivePaths);
    assertNoPathLeak(result.failure.evidence, sensitivePaths);
  } finally {
    await rm(tempRoot, { recursive: true, force: true });
  }
});

test("command stderr diagnostics redact configured absolute roots and child paths", async () => {
  const runCommand = requiredExport("runCommand");
  const tempRoot = await mkdtemp(join(tmpdir(), "skyturn-candidate-delivery-command-paths-"));
  const repoRoot = join(tempRoot, "repository checkout");
  const worktreeRoot = join(tempRoot, "worktrees", "candidate checkout");
  const userDataRoot = join(tempRoot, "electron user data");
  const sensitivePaths = [
    tempRoot,
    join(tempRoot, "child", "evidence.txt"),
    repoRoot,
    join(repoRoot, ".git", "config"),
    worktreeRoot,
    join(worktreeRoot, "nested", "output.txt"),
    userDataRoot,
    join(userDataRoot, "Default", "Preferences"),
  ];
  await mkdir(repoRoot, { recursive: true });
  try {
    await assert.rejects(
      runCommand(
        process.execPath,
        ["-e", `process.stderr.write(${JSON.stringify(sensitivePaths.join(" | "))}); process.exit(7);`],
        { cwd: repoRoot, redactPaths: sensitivePaths },
      ),
      (error) => {
        assertNoPathLeak(error.message, sensitivePaths);
        assert.match(error.message, /failed \(7\)/);
        return true;
      },
    );
  } finally {
    await rm(tempRoot, { recursive: true, force: true });
  }
});

test("one-shot repository preflight completes before checkout build or native rebuild", async () => {
  const runCandidateDeliveryAcceptance = requiredExport("runCandidateDeliveryAcceptance");
  const tempRoot = await mkdtemp(join(tmpdir(), "skyturn-candidate-delivery-order-"));
  const trace = [];
  try {
    const result = await runCandidateDeliveryAcceptance({
      env: realAcceptanceEnv(),
      write: () => {},
      services: {
        makeTempRoot: async () => tempRoot,
        preflight: async () => {
          trace.push("preflight");
          return {
            repo,
            repoRoot: join(tempRoot, "project"),
            baseBranch: "main",
            baseHead: baseSha,
            workflow: { id: workflowId, name: checkName, path: workflowPath, state: "active" },
          };
        },
        prepareCheckout: async () => {
          trace.push("prepareCheckout");
          throw new Error("stop after order proof");
        },
      },
    });

    assert.deepEqual(trace, ["preflight", "prepareCheckout"]);
    assert.equal(result.failure.stage, "checkout");
  } finally {
    await rm(tempRoot, { recursive: true, force: true });
  }
});

function requiredExport(name) {
  assert.equal(typeof subject[name], "function", `expected ${name} export`);
  return subject[name];
}

function realAcceptanceEnv() {
  return {
    SKYTURN_REAL_DELIVERY_ACCEPTANCE: "1",
    SKYTURN_DELIVERY_ACCEPTANCE_ALLOW_SQUASH_MERGE: "1",
    SKYTURN_DELIVERY_ACCEPTANCE_REPO: repo,
    SKYTURN_DELIVERY_ACCEPTANCE_BASE_BRANCH: "main",
    SKYTURN_DELIVERY_ACCEPTANCE_REMOTE: "origin",
    SKYTURN_DELIVERY_ACCEPTANCE_CHECK_NAME: checkName,
    SKYTURN_DELIVERY_ACCEPTANCE_WORKFLOW_PATH: workflowPath,
    SKYTURN_DELIVERY_ACCEPTANCE_EXPECTED_REVIEW_STATUS: "approved",
    SKYTURN_DELIVERY_ACCEPTANCE_CHECK_TIMEOUT_MS: "9000",
    SKYTURN_DELIVERY_ACCEPTANCE_POLL_INTERVAL_MS: "2000",
  };
}

function pendingReviewAcceptanceEnv() {
  return {
    ...realAcceptanceEnv(),
    SKYTURN_DELIVERY_ACCEPTANCE_EXPECTED_REVIEW_STATUS: "pending",
  };
}

function enabledInput() {
  return {
    enabled: true,
    repo,
    baseBranch: "main",
    remote: "origin",
    checkName,
    workflowPath,
    expectedReviewStatus: "approved",
    branch,
    markerFile,
  };
}

function validPreflightFacts() {
  return {
    repoRoot: "/tmp/skyturn-delivery/project",
    repository: {
      nameWithOwner: repo,
      defaultBranch: "main",
      squashMergeAllowed: true,
      deleteBranchOnMerge: false,
      archived: false,
      disabled: false,
      canPush: true,
      isFork: false,
    },
    actions: { enabled: true },
    workflow: { id: workflowId, name: checkName, path: workflowPath, state: "active" },
    priorPullRequestCount: 0,
    branchProtectionRuleCount: 0,
    rulesetCount: 0,
    local: {
      branch: "main",
      status: "",
      localMainHead: baseSha,
      originMainHead: baseSha,
      remoteMainHead: baseSha,
      divergence: [0, 0],
      fetchRepo: repo,
      pushRepo: repo,
      fetchHost: "github.com",
      pushHost: "github.com",
      remoteBranches: [{ name: "main", sha: baseSha }],
      remoteNames: ["origin"],
      smokeBranchHead: null,
    },
  };
}

function fixture() {
  return subject.candidateDeliveryFixture ?? {
    projectId: "project-candidate-delivery-pr",
    sessionId: "session-candidate-delivery-pr",
    implementationLaneId: "lane-candidate-delivery-implementation",
    validationLaneId: "lane-candidate-delivery-validation",
    reviewLaneId: "lane-candidate-delivery-review",
    commitLaneId: "lane-candidate-delivery-commit",
    pullRequestLaneId: "lane-candidate-delivery-pr",
  };
}

function deliveryActionInput() {
  return {
    projectRoot: "/tmp/skyturn-delivery/project",
    sessionId: fixture().sessionId,
    commitLaneId: fixture().commitLaneId,
    pullRequestLaneId: fixture().pullRequestLaneId,
    worktreePath: "/tmp/skyturn-delivery/project.worktrees/candidate",
    markerFile,
    branch,
    baseBranch: "main",
    remote: "origin",
    checkName,
    workflowId,
    workflowPath,
    expectedReviewStatus: "pending",
    title: "test(delivery): verify candidate worktree IPC",
    body: "Prove all explicit delivery actions.",
    whatChanged: `Added disposable marker ${markerFile}.`,
    why: "Verify all explicit SkyTurn delivery actions against one exact candidate.",
    breakingChanges: "None.",
    serverPr: "None.",
  };
}

function completeWorkflow(trace, options = {}) {
  const calls = {};
  const workflow = {
    calls,
    async createDeliveryCommit(_projectRoot, input) {
      trace.push("createDeliveryCommit");
      calls.createDeliveryCommit = input;
      return result("committed", {
        status: "committed",
        commitSha: candidateSha,
        branch,
        parentCommit: baseSha,
      });
    },
    async pushDeliveryBranch(_projectRoot, input) {
      trace.push("pushDeliveryBranch");
      calls.pushDeliveryBranch = input;
      return result("pushed", {
        status: "pushed",
        remote: "origin",
        branch,
        commitSha: candidateSha,
        worktreePath: "/tmp/skyturn-delivery/project.worktrees/candidate",
        command: commandEvidence("git"),
      });
    },
    async createPullRequest(_projectRoot, input) {
      trace.push("createPullRequest");
      calls.createPullRequest = input;
      return result("created", {
        status: "created",
        url: prUrl,
        number: 1,
        head: branch,
        base: "main",
        remote: "origin",
        commitSha: candidateSha,
        title: input.title,
        command: commandEvidence("gh"),
      });
    },
    async checkPullRequest(_projectRoot, input) {
      trace.push("checkPullRequest");
      calls.checkPullRequest = input;
      const evidence = publicChecksEvidence();
      if (options.checksStatus === "pending") {
        evidence.status = "pending";
        evidence.gate.checksStatus = "pending";
        evidence.gate.mergeable = false;
        evidence.checks[0].status = "pending";
        evidence.checks[0].state = "IN_PROGRESS";
      }
      return result("checks_recorded", evidence);
    },
    async mergePullRequest(_projectRoot, input) {
      trace.push("mergePullRequest");
      calls.mergePullRequest = input;
      return result("merged", {
        status: "merged",
        number: 1,
        url: prUrl,
        headSha: candidateSha,
        subject: input.subject,
        checks: publicChecksEvidence().checks,
        review: publicChecksEvidence().review,
        command: commandEvidence("gh"),
      });
    },
    async syncMain(_projectRoot, input) {
      trace.push("syncMain");
      calls.syncMain = input;
      return result("synced", {
        status: "synced",
        mainBranch: "main",
        remote: "origin",
        commands: [commandEvidence("git"), commandEvidence("git")],
      });
    },
  };
  return workflow;
}

function result(status, evidence) {
  return { protocolVersion: 1, status, event: { kind: `result:${status}` }, evidence };
}

function commandEvidence(command) {
  return { command, args: [], cwd: "/tmp/disposable", exitCode: 0, stdout: "", stderr: "" };
}

function passedChecksEvidence() {
  return {
    status: "passed",
    number: 1,
    url: prUrl,
    headSha: candidateSha,
    checks: [{ name: checkName, status: "passed", state: "SUCCESS", workflow: checkName }],
    review: { status: "pending", decision: "REVIEW_REQUIRED" },
    gate: {
      headSha: candidateSha,
      checksStatus: "passed",
      reviewStatus: "pending",
      state: "OPEN",
      mergeable: true,
    },
    workflowRuns: [successfulWorkflowRun()],
    command: commandEvidence("gh"),
    summary: "Candidate delivery passed; review pending is allowed by policy.",
  };
}

function publicChecksEvidence() {
  const evidence = passedChecksEvidence();
  delete evidence.workflowRuns;
  return evidence;
}

function successfulWorkflowRun(overrides = {}) {
  return {
    id: 9001,
    workflowId,
    path: workflowPath,
    headSha: candidateSha,
    event: "pull_request",
    status: "completed",
    conclusion: "success",
    ...overrides,
  };
}

function deliveryEventKinds() {
  return [
    "workflow.commit.created",
    "workflow.delivery.pushed",
    "workflow.pull_request.created",
    "workflow.pull_request.checks_recorded",
    "workflow.pull_request.merged",
    "workflow.delivery.main_synced",
  ];
}

function validOracleInput() {
  const actions = {
    ok: true,
    actionOrder: [
      "createDeliveryCommit",
      "pushDeliveryBranch",
      "createPullRequest",
      "checkPullRequest",
      "mergePullRequest",
      "syncMain",
    ],
    commit: { status: "committed", commitSha: candidateSha, branch, parentCommit: baseSha },
    push: { status: "pushed", remote: "origin", branch, commitSha: candidateSha },
    pullRequest: {
      status: "created",
      url: prUrl,
      number: 1,
      head: branch,
      base: "main",
      remote: "origin",
      commitSha: candidateSha,
      title: "test(delivery): verify candidate worktree IPC",
    },
    checks: passedChecksEvidence(),
    merge: {
      status: "merged",
      number: 1,
      url: prUrl,
      headSha: candidateSha,
      subject: "test(delivery): verify candidate worktree IPC",
      checks: passedChecksEvidence().checks,
      review: passedChecksEvidence().review,
    },
    sync: { status: "synced", mainBranch: "main", remote: "origin" },
  };
  const persistedState = authoritativePersistedState();
  const rendererState = hydratedRendererState();
  return {
    expected: {
      ...fixture(),
      branch,
      baseBranch: "main",
      remote: "origin",
      checkName,
      workflowId,
      workflowPath,
      expectedReviewStatus: "pending",
      baseHead: baseSha,
      manifestSha256,
    },
    actions,
    boundaries: deliveryBoundaries(),
    seededManifestSha256: manifestSha256,
    rendererState,
    reopenedRendererState: structuredClone(rendererState),
    persistedState,
    reopenedPersistedState: structuredClone(persistedState),
    finalRemote: finalRemoteState(),
    reviewObservation: { temporaryRootObserved: true, verifierProcessObserved: true },
  };
}

function authoritativePersistedState() {
  const events = [
    event(1, "workflow.candidate.manifest_recorded", { manifest: { sessionId: fixture().sessionId } }),
    event(2, "workflow.candidate.review_allowed", {
      manifestSha256,
      decision: { disposition: "allow", requestSha256: "1".repeat(64) },
    }),
    event(3, "workflow.commit.publication_prepared", { manifestSha256 }),
    event(4, "workflow.commit.created", {
      laneId: fixture().commitLaneId,
      manifestSha256,
      evidence: { status: "committed", commitSha: candidateSha, branch, parentCommit: baseSha },
    }, fixture().commitLaneId),
    remoteAuditEvent(5, "requested", "push", "workflow.delivery.pushed"),
    event(6, "workflow.delivery.pushed", {
      laneId: fixture().commitLaneId,
      evidence: { status: "pushed", remote: "origin", branch, commitSha: candidateSha },
    }, fixture().commitLaneId),
    remoteAuditEvent(7, "completed", "push", "workflow.delivery.pushed"),
    remoteAuditEvent(8, "requested", "pr", "workflow.pull_request.created"),
    event(9, "workflow.pull_request.created", {
      laneId: fixture().pullRequestLaneId,
      commitLaneId: fixture().commitLaneId,
      evidence: {
        status: "created",
        number: 1,
        url: prUrl,
        head: branch,
        base: "main",
        remote: "origin",
        commitSha: candidateSha,
        title: "test(delivery): verify candidate worktree IPC",
      },
    }, fixture().pullRequestLaneId),
    remoteAuditEvent(10, "completed", "pr", "workflow.pull_request.created"),
    event(11, "workflow.pull_request.checks_recorded", {
      laneId: fixture().pullRequestLaneId,
      prNumber: 1,
      headSha: candidateSha,
      status: "passed",
      checks: passedChecksEvidence().checks,
      review: passedChecksEvidence().review,
      gate: passedChecksEvidence().gate,
      evidence: passedChecksEvidence(),
    }, fixture().pullRequestLaneId),
    remoteAuditEvent(12, "requested", "merge", "workflow.pull_request.merged"),
    event(13, "workflow.pull_request.merged", {
      laneId: fixture().pullRequestLaneId,
      evidence: {
        status: "merged",
        number: 1,
        url: prUrl,
        headSha: candidateSha,
        subject: "test(delivery): verify candidate worktree IPC",
        checks: passedChecksEvidence().checks,
        review: passedChecksEvidence().review,
      },
    }, fixture().pullRequestLaneId),
    remoteAuditEvent(14, "completed", "merge", "workflow.pull_request.merged"),
    remoteAuditEvent(15, "requested", "sync", "workflow.delivery.main_synced"),
    event(16, "workflow.delivery.main_synced", {
      sessionWide: true,
      laneId: fixture().pullRequestLaneId,
      prNumber: 1,
      headSha: candidateSha,
      evidence: { status: "synced", mainBranch: "main", remote: "origin" },
    }, fixture().pullRequestLaneId),
    remoteAuditEvent(17, "completed", "sync", "workflow.delivery.main_synced"),
  ];
  const laneSpecs = [
    [fixture().implementationLaneId, "implementation"],
    [fixture().validationLaneId, "validation"],
    [fixture().reviewLaneId, "review"],
    [fixture().commitLaneId, "commit"],
    [fixture().pullRequestLaneId, "pull_request"],
  ];
  const dependencySpecs = [
    [fixture().implementationLaneId, fixture().validationLaneId],
    [fixture().validationLaneId, fixture().reviewLaneId],
    [fixture().reviewLaneId, fixture().commitLaneId],
    [fixture().commitLaneId, fixture().pullRequestLaneId],
  ];
  const dependenciesByLaneId = new Map([
    [fixture().implementationLaneId, []],
    [fixture().validationLaneId, [fixture().implementationLaneId]],
    [fixture().reviewLaneId, [fixture().validationLaneId]],
    [fixture().commitLaneId, [fixture().reviewLaneId]],
    [fixture().pullRequestLaneId, [fixture().commitLaneId]],
  ]);
  const plannerNodeId = `planner-${fixture().sessionId}`;
  return {
    manifestSha256,
    manifest: { sessionId: fixture().sessionId, branchName: branch },
    events,
    projection: {
      sessionId: fixture().sessionId,
      events: structuredClone(events.filter((item) => deliveryEventKinds().includes(item.kind))),
      lanes: laneSpecs.map(([id, kind]) => ({ id, kind, laneKind: kind, status: "completed" })),
      edges: dependencySpecs.map(([sourceLaneId, targetLaneId], index) => ({
        id: `edge-candidate-delivery-${index + 1}`,
        sourceLaneId,
        targetLaneId,
      })),
    },
    canvasSession: {
      id: fixture().sessionId,
      projectId: fixture().projectId,
      title: "Candidate delivery acceptance",
      mode: "fast",
      kind: "canvas",
      target: { executionTarget: "new_worktree", selectedBranch: "main", baseRef: "origin/main" },
      plannerNodeId,
      nodes: [
        { id: plannerNodeId, laneKind: "planner", status: "pending", context: { dependencies: [] } },
        ...laneSpecs.map(([id, laneKind]) => ({
          id,
          laneKind,
          status: "completed",
          context: { dependencies: dependenciesByLaneId.get(id) },
        })),
      ],
      edges: dependencySpecs.map(([source, target], index) => ({
        id: `edge-candidate-delivery-${index + 1}`,
        source,
        target,
      })),
    },
  };
}

function event(seq, kind, payload, laneId) {
  return {
    id: `event-${seq}`,
    sessionId: fixture().sessionId,
    seq,
    kind,
    source: kind.startsWith("workflow.candidate") || kind === "workflow.commit.publication_prepared"
      ? "workflow_store"
      : "electron-main",
    ...(laneId ? { laneId } : {}),
    payload,
    createdAt: new Date(Date.UTC(2026, 7, 18, 0, 0, seq)).toISOString(),
  };
}

function remoteAuditEvent(seq, phase, operationId, eventKind) {
  return event(seq, `workflow.remote_side_effect.${phase}`, {
    operationId: `remote-side-effect:${operationId}`,
    operationKey: `operation:${operationId}`,
    eventKind,
    ...(phase === "completed" ? { status: "succeeded" } : {}),
  }, eventKind === "workflow.delivery.pushed" ? fixture().commitLaneId : fixture().pullRequestLaneId);
}

function deliveryBoundaries() {
  const stages = [
    "createDeliveryCommit",
    "pushDeliveryBranch",
    "createPullRequest",
    "checkPullRequest",
    "mergePullRequest",
    "syncMain",
  ];
  const eventCutoffs = [4, 7, 10, 11, 14, 17];
  const authoritativeEvents = authoritativePersistedState().events;
  return stages.map((stage, index) => {
    const pullRequestExists = index >= 2;
    const merged = index >= 4;
    const synced = index >= 5;
    const remoteSideEffectEventKinds = [
      ...(index >= 1 ? ["workflow.delivery.pushed"] : []),
      ...(index >= 2 ? ["workflow.pull_request.created"] : []),
      ...(index >= 4 ? ["workflow.pull_request.merged"] : []),
      ...(index >= 5 ? ["workflow.delivery.main_synced"] : []),
    ];
    return {
      completedAction: stage,
      deliveryEventKinds: deliveryEventKinds().slice(0, index + 1),
      remoteSideEffectEventKinds,
      remoteSideEffectCompletedKinds: [...remoteSideEffectEventKinds],
      persisted: {
        events: structuredClone(authoritativeEvents.filter((item) => item.seq <= eventCutoffs[index])),
      },
      remote: {
        candidateHead: candidateSha,
        remoteBranchHead: index >= 1 ? candidateSha : null,
        remoteMainHead: merged ? mergeSha : baseSha,
        localMainHead: synced ? mergeSha : baseSha,
        originMainHead: synced ? mergeSha : baseSha,
        pullRequest: pullRequestExists ? {
          number: 1,
          url: prUrl,
          headRefName: branch,
          headRefOid: candidateSha,
          baseRefName: "main",
          state: merged ? "MERGED" : "OPEN",
          mergeCommitOid: merged ? mergeSha : null,
        } : null,
      },
    };
  });
}

function insertRepeatedRemoteCompletion(events, eventKind, firstStatus) {
  const index = events.findIndex((item) =>
    item.kind === "workflow.remote_side_effect.completed" &&
    item.payload?.eventKind === eventKind
  );
  assert.notEqual(index, -1);
  const first = events[index];
  first.payload.status = firstStatus;
  for (let offset = index + 1; offset < events.length; offset += 1) {
    events[offset].seq += 1;
  }
  const repeated = structuredClone(first);
  repeated.id = `${first.id}-repeated`;
  repeated.seq = first.seq + 1;
  repeated.payload.status = "succeeded";
  events.splice(index + 1, 0, repeated);
}

function hydratedRendererState() {
  return {
    session: {
      title: "Candidate delivery acceptance",
      activeSidebarTitle: "Candidate delivery acceptance",
      mode: "fast",
    },
    lanes: [
      { id: fixture().implementationLaneId, status: "completed" },
      { id: fixture().validationLaneId, status: "completed" },
      { id: fixture().reviewLaneId, status: "completed" },
      { id: fixture().commitLaneId, status: "completed" },
      { id: fixture().pullRequestLaneId, status: "completed" },
    ],
    delivery: {
      sessionId: fixture().sessionId,
      commitLaneId: fixture().commitLaneId,
      pullRequestLaneId: fixture().pullRequestLaneId,
      commitSha: candidateSha,
      pullRequestHeadSha: candidateSha,
      checksExpectedHeadSha: candidateSha,
      branch,
      prNumber: 1,
      prUrl,
      checksStatus: "passing",
    },
    gates: {
      "Squash merge": "done",
      "Sync main": "done",
      Cleanup: "blocked",
    },
    cleanup: "Waiting",
  };
}

function candidateRunnerHarness(tempRoot, { failWorkspaceReset = false } = {}) {
  const trace = [];
  const repoRoot = join(tempRoot, "project");
  const userDataPath = join(tempRoot, "user-data");
  const workspacePath = join(userDataPath, "workspace.json");
  const terminalAuthority = authoritativePersistedState();
  const seededCanvasSession = structuredClone(terminalAuthority.canvasSession);
  for (const node of seededCanvasSession.nodes) {
    if (node.id === fixture().commitLaneId || node.id === fixture().pullRequestLaneId) {
      node.status = "pending";
    }
  }
  const seededWorkspace = {
    projects: [{
      id: fixture().projectId,
      name: "project",
      rootPath: repoRoot,
      canonicalRootPath: repoRoot,
      devflowPath: join(repoRoot, ".devflow"),
      openedAt: "2026-08-18T00:00:00.000Z",
    }],
    sessions: [seededCanvasSession],
    changesets: {},
    agents: [],
    runs: {},
    runEvents: {},
    runEvidence: {},
    activeProjectId: fixture().projectId,
    activeSessionId: fixture().sessionId,
    sidebarCollapsed: false,
    collapsedProjectIds: [],
  };
  const staleTerminalWorkspace = structuredClone(seededWorkspace);
  staleTerminalWorkspace.cachedTerminalRendererState = true;
  for (const node of staleTerminalWorkspace.sessions[0].nodes) node.status = "completed";
  const oracleInput = validOracleInput();
  const actions = structuredClone(oracleInput.actions);
  actions.boundaries = structuredClone(oracleInput.boundaries);
  let launchCount = 0;
  let closeCount = 0;
  let rendererReadCount = 0;
  const harness = {
    trace,
    seededWorkspace,
    staleTerminalWorkspace,
    workspaceAtRelaunch: null,
    services: null,
  };

  harness.services = {
    async run(command, args) {
      if (command === "git" && args[0] === "status") {
        return { stdout: `A  ${markerFile}\n`, stderr: "" };
      }
      if (command === "git" && args[0] === "diff") {
        return { stdout: `${markerFile}\n`, stderr: "" };
      }
      throw new Error(`Unexpected local command in candidate runner harness: ${command} ${args.join(" ")}`);
    },
    makeTempRoot: async () => tempRoot,
    preflight: async () => ({
      repo,
      repoRoot,
      baseBranch: "main",
      baseHead: baseSha,
      workflow: { id: workflowId, name: checkName, path: workflowPath, state: "active" },
    }),
    prepareCheckout: async () => {},
    createCandidateWorktree: async () => ({
      worktreeId: fixture().worktreeId,
      variantId: fixture().variantId,
      path: join(`${repoRoot}.worktrees`, "20260818T010203Z-deadbeef"),
      realPath: join(`${repoRoot}.worktrees`, "20260818T010203Z-deadbeef"),
      branchName: branch,
      baseCommit: baseSha,
      headCommit: baseSha,
      parentLaneId: fixture().implementationLaneId,
    }),
    writeMarker: async () => {},
    seed: async (_mode, config) => {
      trace.push("workspace:seed");
      assert.equal(config.workspacePath, workspacePath);
      await mkdir(userDataPath, { recursive: true });
      await writeFile(workspacePath, `${JSON.stringify(seededWorkspace, null, 2)}\n`, "utf8");
      return {
        identity: {
          sessionId: fixture().sessionId,
          nodeId: fixture().implementationLaneId,
          laneId: fixture().implementationLaneId,
          segmentId: "segment-candidate-delivery-implementation",
          runId: "run-candidate-delivery-implementation",
        },
        manifest: { sessionId: fixture().sessionId, branchName: branch },
        manifestSha256,
        canvasSession: structuredClone(seededCanvasSession),
        workspace: seededWorkspace,
      };
    },
    launch: async () => {
      launchCount += 1;
      if (launchCount === 1) {
        trace.push("launch:first");
      } else {
        trace.push("launch:reopened");
        harness.workspaceAtRelaunch = JSON.parse(await readFile(workspacePath, "utf8"));
      }
      return { cdpPort: 9222 + launchCount, devServerUrl: "http://127.0.0.1:5173", diagnostics: [] };
    },
    connect: async () => ({}),
    waitForProject: async () => {},
    invokeActions: async () => ({
      actions: structuredClone(actions),
      reviewObservation: { temporaryRootObserved: true, verifierProcessObserved: true },
    }),
    readRendererState: async () => {
      rendererReadCount += 1;
      trace.push(rendererReadCount === 1 ? "renderer:first" : "renderer:reopened");
      return hydratedRendererState();
    },
    closeApp: async () => {
      closeCount += 1;
      trace.push(closeCount === 1 ? "close:first" : "close:reopened");
      if (closeCount === 1) {
        await writeFile(workspacePath, `${JSON.stringify(staleTerminalWorkspace, null, 2)}\n`, "utf8");
      }
      return { ok: true, cleanupConfirmed: true, diagnostic: null };
    },
    inspect: async () => {
      trace.push("sqlite:inspect");
      return structuredClone(terminalAuthority);
    },
    restoreWorkspace: async (input) => {
      trace.push("workspace:reset");
      assert.equal(input.workspacePath, workspacePath);
      assert.deepEqual(input.workspace, seededWorkspace);
      if (failWorkspaceReset) {
        throw new Error(`workspace reset failed at ${workspacePath}; token=ghp_reset_secret`);
      }
      const restoreCandidateDeliveryWorkspace = requiredExport("restoreCandidateDeliveryWorkspace");
      await restoreCandidateDeliveryWorkspace(input);
    },
    auditRemote: async () => {
      trace.push("remote:audit");
      return structuredClone(finalRemoteState());
    },
    cleanup: async () => {
      trace.push("cleanup");
      return {
        status: "cleaned",
        prClosed: false,
        remoteBranchDeleted: true,
        localBranchDeleted: true,
        localStateRemoved: true,
      };
    },
  };
  return harness;
}

function finalRemoteState() {
  return {
    candidateHead: candidateSha,
    candidateParentCommit: baseSha,
    candidateTreeSha: treeSha,
    remoteBranchHead: candidateSha,
    localMainHead: mergeSha,
    originMainHead: mergeSha,
    remoteMainHead: mergeSha,
    mainParentCommit: baseSha,
    mainTreeSha: treeSha,
    pullRequest: {
      number: 1,
      url: prUrl,
      headRefName: branch,
      headRefOid: candidateSha,
      baseRefName: "main",
      state: "MERGED",
      mergeCommitOid: mergeSha,
    },
  };
}

function cleanupState(overrides = {}) {
  return {
    repo,
    repoRoot: "/tmp/skyturn-candidate-delivery/project",
    baseBranch: "main",
    remote: "origin",
    branch,
    headSha: candidateSha,
    mergeSha,
    pr: finalRemoteState().pullRequest,
    remoteBranchCreated: true,
    localBranchCreated: true,
    worktreeCreated: true,
    candidateWorktreePath: "/tmp/skyturn-candidate-delivery/project.worktrees/candidate",
    userDataPath: "/tmp/skyturn-candidate-delivery/user-data",
    tempRoot: "/tmp/skyturn-candidate-delivery",
    ...overrides,
  };
}

function assertNoPathLeak(value, sensitivePaths) {
  const serialized = typeof value === "string" ? value : JSON.stringify(value);
  for (const sensitivePath of sensitivePaths) {
    const offset = serialized.indexOf(sensitivePath);
    assert.equal(
      offset,
      -1,
      `${sensitivePath}: ${serialized.slice(Math.max(0, offset - 80), offset + sensitivePath.length + 80)}`,
    );
  }
}
