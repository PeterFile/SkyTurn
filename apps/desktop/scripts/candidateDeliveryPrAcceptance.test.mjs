import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

let subject = {};
try {
  subject = await import("./candidateDeliveryPrAcceptance.mjs");
} catch {
  // The first TDD run intentionally reaches this assertion path before the module exists.
}

const branch = "skyturn/smoke/20260724T010203Z-deadbeef";
const markerFile = ".devflow/smoke/20260724T010203Z-deadbeef.md";
const headSha = "a".repeat(40);
const baseHeadSha = "b".repeat(40);
const prUrl = "https://github.com/acme/skyturn/pull/42";
let eventSequence = 0;

test("candidate delivery acceptance is skipped by default before any side effect", async () => {
  const runCandidateDeliveryAcceptance = requiredExport("runCandidateDeliveryAcceptance");
  const lines = [];
  const calls = [];

  const result = await runCandidateDeliveryAcceptance({
    env: {},
    write: (line) => lines.push(line),
    services: new Proxy({}, {
      get(_target, property) {
        return async () => {
          calls.push(String(property));
          throw new Error("default acceptance must not perform side effects");
        };
      },
    }),
  });

  assert.equal(result.status, "skipped");
  assert.match(result.reason, /SKYTURN_REAL_DELIVERY_ACCEPTANCE=1/);
  assert.deepEqual(calls, []);
  assert.deepEqual(lines, [`SKIPPED: ${result.reason}`]);
});

test("desktop exposes the bounded candidate delivery acceptance package script", async () => {
  const packageJson = JSON.parse(await readFile(
    new URL("../package.json", import.meta.url),
    "utf8",
  ));

  assert.equal(
    packageJson.scripts["acceptance:candidate-delivery-pr"],
    "node scripts/candidateDeliveryPrAcceptance.mjs",
  );
});

test("candidate delivery input derives bounded disposable identities and rejects unsafe values", () => {
  const parseCandidateDeliveryAcceptanceInput = requiredExport("parseCandidateDeliveryAcceptanceInput");
  const input = parseCandidateDeliveryAcceptanceInput({
    SKYTURN_REAL_DELIVERY_ACCEPTANCE: "1",
    SKYTURN_DELIVERY_ACCEPTANCE_REPO: "acme/skyturn",
    SKYTURN_DELIVERY_ACCEPTANCE_BASE_BRANCH: "main",
    SKYTURN_DELIVERY_ACCEPTANCE_REMOTE: "upstream",
    SKYTURN_DELIVERY_ACCEPTANCE_CHECK_TIMEOUT_MS: "9000",
    SKYTURN_DELIVERY_ACCEPTANCE_POLL_INTERVAL_MS: "2000",
  }, {
    now: new Date("2026-07-24T01:02:03.000Z"),
    randomHex: () => "deadbeef",
  });

  assert.deepEqual(input, {
    enabled: true,
    cleanupEnabled: false,
    repo: "acme/skyturn",
    baseBranch: "main",
    remote: "upstream",
    branch,
    smokeId: "20260724T010203Z-deadbeef",
    markerFile,
    checkTimeoutMs: 9000,
    pollIntervalMs: 2000,
    maxCheckAttempts: 5,
  });

  assert.throws(
    () => parseCandidateDeliveryAcceptanceInput({
      SKYTURN_REAL_DELIVERY_ACCEPTANCE: "1",
      SKYTURN_DELIVERY_ACCEPTANCE_REMOTE: "origin;git push",
    }),
    /remote/i,
  );
  assert.throws(
    () => parseCandidateDeliveryAcceptanceInput({
      SKYTURN_REAL_DELIVERY_ACCEPTANCE: "1",
      SKYTURN_DELIVERY_ACCEPTANCE_REPO: "https://github.com/acme/skyturn",
    }),
    /repo/i,
  );
  assert.throws(
    () => parseCandidateDeliveryAcceptanceInput({
      SKYTURN_REAL_DELIVERY_ACCEPTANCE: "1",
      SKYTURN_DELIVERY_ACCEPTANCE_BASE_BRANCH: "main\nnext",
    }),
    /base branch/i,
  );
  assert.throws(
    () => parseCandidateDeliveryAcceptanceInput({
      SKYTURN_REAL_DELIVERY_ACCEPTANCE: "1",
      SKYTURN_DELIVERY_ACCEPTANCE_CHECK_TIMEOUT_MS: "3600001",
    }),
    /timeout/i,
  );
});

test("public delivery actions run commit then push then PR then exact-head checks and accept pending evidence", async () => {
  const runPublicDeliveryActions = requiredExport("runPublicDeliveryActions");
  const calls = [];
  let checkAttempt = 0;
  const workflow = {
    async createDeliveryCommit(projectRoot, input) {
      calls.push(["createDeliveryCommit", projectRoot, input]);
      return {
        protocolVersion: 1,
        status: "committed",
        event: { kind: "workflow.commit.created" },
        evidence: {
          status: "committed",
          commitSha: headSha,
          branch,
          stagedFiles: [markerFile],
          worktreePath: projectRoot,
        },
      };
    },
    async pushDeliveryBranch(projectRoot, input) {
      calls.push(["pushDeliveryBranch", projectRoot, input]);
      return {
        protocolVersion: 1,
        status: "pushed",
        event: { kind: "workflow.delivery.pushed" },
        evidence: {
          status: "pushed",
          remote: "origin",
          branch,
          commitSha: headSha,
          worktreePath: projectRoot,
        },
      };
    },
    async createPullRequest(projectRoot, input) {
      calls.push(["createPullRequest", projectRoot, input]);
      return {
        protocolVersion: 1,
        status: "created",
        event: { kind: "workflow.pull_request.created" },
        evidence: {
          status: "created",
          url: prUrl,
          number: 42,
          head: branch,
          base: "main",
          remote: "origin",
          commitSha: headSha,
          title: "test(delivery): verify candidate worktree IPC",
        },
      };
    },
    async checkPullRequest(projectRoot, input) {
      calls.push(["checkPullRequest", projectRoot, input]);
      checkAttempt += 1;
      return {
        protocolVersion: 1,
        status: "checks_recorded",
        event: { kind: "workflow.pull_request.checks_recorded" },
        evidence: {
          status: "pending",
          number: 42,
          url: prUrl,
          headSha,
          checks: checkAttempt === 1 ? [] : [{
            name: "ci",
            status: "pending",
            state: "IN_PROGRESS",
            workflow: "CI",
          }],
          review: { status: "pending", decision: "REVIEW_REQUIRED" },
          gate: {
            headSha,
            checksStatus: "pending",
            reviewStatus: "pending",
            state: "OPEN",
            mergeable: false,
          },
        },
      };
    },
    async mergePullRequest() {
      throw new Error("acceptance must never merge");
    },
    async syncMain() {
      throw new Error("acceptance must never sync main");
    },
  };

  const result = await runPublicDeliveryActions({
    workflow,
    ...deliveryActionInput(),
    maxCheckAttempts: 3,
    pollIntervalMs: 0,
    sleep: async () => {},
  });

  assert.equal(result.ok, true);
  assert.equal(result.checksObserved, true);
  assert.equal(result.checksStatus, "pending");
  assert.equal(result.checksPassed, false);
  assert.equal(result.checkAttempts, 2);
  assert.deepEqual(result.actionOrder, [
    "createDeliveryCommit",
    "pushDeliveryBranch",
    "createPullRequest",
    "checkPullRequest",
    "checkPullRequest",
  ]);
  assert.deepEqual(calls.map(([name]) => name), result.actionOrder);
  assert.deepEqual(calls[0][2].files, [markerFile]);
  assert.deepEqual(calls[1][2], {
    sessionId: "session-candidate-delivery-pr",
    laneId: "lane-candidate-delivery-commit",
    worktreePath: "/tmp/skyturn-candidate",
    commitSha: headSha,
    branch,
    remote: "origin",
  });
  assert.deepEqual(calls[2][2], {
    sessionId: "session-candidate-delivery-pr",
    laneId: "lane-candidate-delivery-pr",
    commitLaneId: "lane-candidate-delivery-commit",
    worktreePath: "/tmp/skyturn-candidate",
    baseBranch: "main",
    headBranch: branch,
    commitSha: headSha,
    remote: "origin",
    title: "test(delivery): verify candidate worktree IPC",
    whatChanged: `Added disposable marker ${markerFile}.`,
    why: "Verify SkyTurn delivery IPC against an exact candidate head.",
    breakingChanges: "None.",
    serverPr: "None.",
  });
  assert.ok(calls.slice(3).every(([, , input]) =>
    input.prNumber === 42 && input.prUrl === prUrl && input.expectedHeadSha === headSha
  ));
});

test("renderer invocation binds the action sequencer only to the public workflow API", () => {
  const buildRendererDeliveryInvocation = requiredExport("buildRendererDeliveryInvocation");
  const expression = buildRendererDeliveryInvocation(deliveryActionInput());

  assert.match(expression, /window\.devflow\?\.workflow/);
  for (const method of [
    "createDeliveryCommit",
    "pushDeliveryBranch",
    "createPullRequest",
    "checkPullRequest",
  ]) {
    assert.match(expression, new RegExp(`workflow\\.${method}`));
  }
  assert.doesNotMatch(expression, /workflow\.(?:mergePullRequest|syncMain)/);
  assert.doesNotMatch(expression, /(?:execFile|spawn)\s*\(|["'](?:git|gh)["']/);
});

test("delivery oracle accepts exact-head pending evidence without claiming checks passed", () => {
  const candidateDeliveryOracle = requiredExport("candidateDeliveryOracle");
  const authority = authoritativeState();
  const result = candidateDeliveryOracle({
    expected: expectedOracleIdentity(),
    actions: completedActions("pending"),
    rendererState: rendererDeliveryState("pending"),
    reopenedRendererState: rendererDeliveryState("pending"),
    persistedState: structuredClone(authority),
    localHeadSha: headSha,
    remoteHeadSha: headSha,
    pullRequest: {
      number: 42,
      url: prUrl,
      headRefName: branch,
      headRefOid: headSha,
      baseRefName: "main",
      state: "OPEN",
    },
    baseHeadBefore: baseHeadSha,
    baseHeadAfter: baseHeadSha,
  });

  assert.equal(result.ok, true);
  assert.deepEqual(result.failures, []);
  assert.equal(result.checksObserved, true);
  assert.equal(result.checksStatus, "pending");
  assert.equal(result.checksPassed, false);
  assert.equal(result.noMergeOrMainSync, true);
});

test("delivery oracle rejects stale remote heads, base movement, and merge or main-sync events", () => {
  const candidateDeliveryOracle = requiredExport("candidateDeliveryOracle");
  const authority = authoritativeState();
  authority.projection.events.push(
    event("workflow.pull_request.merged", {
      laneId: "lane-candidate-delivery-pr",
      evidence: { number: 42, headSha },
    }),
    event("workflow.delivery.main_synced", { headSha: baseHeadSha }),
  );

  const result = candidateDeliveryOracle({
    expected: expectedOracleIdentity(),
    actions: completedActions("passed"),
    rendererState: rendererDeliveryState("passed"),
    reopenedRendererState: rendererDeliveryState("passed"),
    persistedState: structuredClone(authority),
    localHeadSha: headSha,
    remoteHeadSha: "c".repeat(40),
    pullRequest: {
      number: 42,
      url: prUrl,
      headRefName: branch,
      headRefOid: headSha,
      baseRefName: "main",
      state: "OPEN",
    },
    baseHeadBefore: baseHeadSha,
    baseHeadAfter: "d".repeat(40),
  });

  assert.equal(result.ok, false);
  assert.ok(result.failures.includes("remote-branch-head-mismatch"));
  assert.ok(result.failures.includes("base-head-changed"));
  assert.ok(result.failures.includes("merge-event-present"));
  assert.ok(result.failures.includes("main-sync-event-present"));
  assert.equal(result.noMergeOrMainSync, false);
});

test("failure cleanup is manual by default and retains exact audit paths without commands", async () => {
  const cleanupCandidateDeliveryResources = requiredExport("cleanupCandidateDeliveryResources");
  const tempRoot = await mkdtemp(join(tmpdir(), "skyturn-candidate-cleanup-disabled-"));
  const candidateWorktreePath = join(tempRoot, "candidate");
  const userDataPath = join(tempRoot, "user-data");
  await mkdir(candidateWorktreePath);
  await mkdir(userDataPath);
  const commands = [];

  try {
    const result = await cleanupCandidateDeliveryResources({
      cleanupEnabled: false,
      state: cleanupState({ tempRoot, candidateWorktreePath, userDataPath }),
      run: async (command, args) => {
        commands.push([command, args]);
        throw new Error("cleanup is opt-in");
      },
    });

    assert.equal(result.status, "manual-cleanup-required");
    assert.equal(result.prClosed, false);
    assert.equal(result.remoteBranchDeleted, false);
    assert.equal(result.localStateRemoved, false);
    assert.deepEqual(commands, []);
    assert.equal((await stat(candidateWorktreePath)).isDirectory(), true);
    assert.equal((await stat(userDataPath)).isDirectory(), true);
    assert.match(result.message, /PR #42/);
    assert.match(result.message, new RegExp(escapeRegExp(branch)));
    assert.match(result.message, new RegExp(escapeRegExp(headSha)));
    assert.match(result.message, new RegExp(escapeRegExp(candidateWorktreePath)));
    assert.match(result.message, new RegExp(escapeRegExp(userDataPath)));
  } finally {
    await rm(tempRoot, { recursive: true, force: true });
  }
});

test("explicit failure cleanup closes the disposable PR before deleting only its exact branch and temp state", async () => {
  const cleanupCandidateDeliveryResources = requiredExport("cleanupCandidateDeliveryResources");
  const tempRoot = await mkdtemp(join(tmpdir(), "skyturn-candidate-cleanup-enabled-"));
  const candidateWorktreePath = join(tempRoot, "candidate");
  const userDataPath = join(tempRoot, "user-data");
  await mkdir(candidateWorktreePath);
  await mkdir(userDataPath);
  const commands = [];
  let remoteProbe = 0;

  const result = await cleanupCandidateDeliveryResources({
    cleanupEnabled: true,
    state: cleanupState({ tempRoot, candidateWorktreePath, userDataPath }),
    run: async (command, args, options = {}) => {
      commands.push([command, args, options.cwd]);
      if (command === "gh" && args[0] === "pr" && args[1] === "close") return { stdout: "", stderr: "" };
      if (command === "gh" && args[0] === "pr" && args[1] === "view") return { stdout: "CLOSED\n", stderr: "" };
      if (command === "git" && args[0] === "ls-remote") {
        remoteProbe += 1;
        return {
          stdout: remoteProbe === 1 ? `${headSha}\trefs/heads/${branch}\n` : "",
          stderr: "",
        };
      }
      if (command === "git" && args[0] === "push") return { stdout: "", stderr: "" };
      if (command === "git" && args[0] === "worktree" && args[1] === "remove") return { stdout: "", stderr: "" };
      if (command === "git" && args[0] === "update-ref" && args[1] === "-d") return { stdout: "", stderr: "" };
      throw new Error(`unexpected cleanup command: ${command} ${args.join(" ")}`);
    },
  });

  assert.equal(result.status, "cleaned");
  assert.equal(result.prClosed, true);
  assert.equal(result.remoteBranchDeleted, true);
  assert.equal(result.localBranchDeleted, true);
  assert.equal(result.localStateRemoved, true);
  await assert.rejects(stat(tempRoot), /ENOENT/);

  const closeIndex = commandIndex(commands, "gh", ["pr", "close", "42"]);
  const remoteDeleteIndex = commandIndex(commands, "git", [
    "push",
    `--force-with-lease=refs/heads/${branch}:${headSha}`,
    "origin",
    `:refs/heads/${branch}`,
  ]);
  const worktreeRemoveIndex = commandIndex(commands, "git", ["worktree", "remove", "--force", "--", candidateWorktreePath]);
  const localDeleteIndex = commandIndex(commands, "git", [
    "update-ref",
    "-d",
    `refs/heads/${branch}`,
    headSha,
  ]);
  assert.ok(closeIndex >= 0);
  assert.ok(closeIndex < remoteDeleteIndex);
  assert.ok(remoteDeleteIndex < worktreeRemoveIndex);
  assert.ok(worktreeRemoveIndex < localDeleteIndex);
  assert.ok(!commands.some(([command, args]) =>
    command === "gh" && args[0] === "pr" && args[1] === "merge"
  ));
  assert.ok(!commands.some(([command, args]) =>
    command === "git" && args[0] === "push" && args.some((arg) => /refs\/heads\/main/.test(arg))
  ));
});

test("renderer oracle fails when backend authority is correct but renderer PR or check evidence is missing", () => {
  const candidateDeliveryOracle = requiredExport("candidateDeliveryOracle");
  const authority = authoritativeState();
  const renderer = rendererDeliveryState("pending");
  renderer.delivery.prNumber = null;
  renderer.delivery.prUrl = null;
  renderer.delivery.checksStatus = null;
  renderer.delivery.checksHeadSha = null;

  const result = candidateDeliveryOracle({
    expected: expectedOracleIdentity(),
    actions: completedActions("pending"),
    rendererState: renderer,
    reopenedRendererState: rendererDeliveryState("pending"),
    persistedState: authority,
    localHeadSha: headSha,
    remoteHeadSha: headSha,
    pullRequest: auditedPullRequest(),
    baseHeadBefore: baseHeadSha,
    baseHeadAfter: baseHeadSha,
  });

  assert.equal(result.ok, false);
  assert.ok(result.failures.includes("renderer-pull-request-evidence-missing"));
  assert.ok(result.failures.includes("renderer-checks-evidence-missing"));
  assert.ok(result.failures.includes("renderer-reopen-state-mismatch"));
});

test("renderer oracle rejects full SHA mismatches even when every visible seven-character prefix matches", async (t) => {
  const candidateDeliveryOracle = requiredExport("candidateDeliveryOracle");
  const samePrefixSha = `${headSha.slice(0, 7)}${"b".repeat(33)}`;
  assert.equal(samePrefixSha.slice(0, 7), headSha.slice(0, 7));
  assert.notEqual(samePrefixSha, headSha);

  for (const [field, failure] of [
    ["commitSha", "renderer-commit-sha-mismatch"],
    ["pullRequestHeadSha", "renderer-pull-request-head-sha-mismatch"],
    ["checksExpectedHeadSha", "renderer-checks-expected-head-sha-mismatch"],
  ]) {
    await t.test(field, () => {
      const renderer = rendererDeliveryState("pending");
      renderer.delivery[field] = samePrefixSha;
      const result = candidateDeliveryOracle(candidateOracleInput(
        renderer,
        rendererDeliveryState("pending"),
      ));

      assert.equal(result.ok, false);
      assert.ok(result.failures.includes(failure));
    });
  }
});

test("renderer oracle rejects missing or incorrect session and lane identity", async (t) => {
  const candidateDeliveryOracle = requiredExport("candidateDeliveryOracle");
  for (const [name, field, value, failure] of [
    ["missing session", "sessionId", undefined, "renderer-session-id-mismatch"],
    ["wrong session", "sessionId", "session-other", "renderer-session-id-mismatch"],
    ["missing commit lane", "commitLaneId", undefined, "renderer-commit-lane-id-mismatch"],
    ["wrong commit lane", "commitLaneId", "lane-other-commit", "renderer-commit-lane-id-mismatch"],
    ["missing pull request lane", "pullRequestLaneId", undefined, "renderer-pull-request-lane-id-mismatch"],
    ["wrong pull request lane", "pullRequestLaneId", "lane-other-pr", "renderer-pull-request-lane-id-mismatch"],
  ]) {
    await t.test(name, () => {
      const renderer = rendererDeliveryState("pending");
      renderer.delivery[field] = value;
      const result = candidateDeliveryOracle(candidateOracleInput(
        renderer,
        rendererDeliveryState("pending"),
      ));

      assert.equal(result.ok, false);
      assert.ok(result.failures.includes(failure));
    });
  }
});

test("renderer oracle repeats exact SHA and identity validation after Electron reopen", () => {
  const candidateDeliveryOracle = requiredExport("candidateDeliveryOracle");
  const samePrefixSha = `${headSha.slice(0, 7)}${"c".repeat(33)}`;
  const reopened = rendererDeliveryState("pending");
  reopened.delivery.sessionId = "session-other";
  reopened.delivery.commitLaneId = undefined;
  reopened.delivery.pullRequestLaneId = "lane-other-pr";
  reopened.delivery.commitSha = samePrefixSha;
  reopened.delivery.pullRequestHeadSha = samePrefixSha;
  reopened.delivery.checksExpectedHeadSha = samePrefixSha;

  const result = candidateDeliveryOracle(candidateOracleInput(
    rendererDeliveryState("pending"),
    reopened,
  ));

  assert.equal(result.ok, false);
  for (const failure of [
    "reopened-renderer-session-id-mismatch",
    "reopened-renderer-commit-lane-id-mismatch",
    "reopened-renderer-pull-request-lane-id-mismatch",
    "reopened-renderer-commit-sha-mismatch",
    "reopened-renderer-pull-request-head-sha-mismatch",
    "reopened-renderer-checks-expected-head-sha-mismatch",
  ]) assert.ok(result.failures.includes(failure), failure);
});

test("renderer acceptance reads canvas and delivery DOM without calling projection IPC", async () => {
  const readRendererDeliveryState = requiredExport("readRendererDeliveryState");
  let compiledExpression = "";
  const observed = await readRendererDeliveryState({
    async evaluate(expression) {
      compiledExpression = expression;
      assert.doesNotThrow(() => new Function(`return ${expression};`));
      return rendererDeliveryState("pending");
    },
  }, {
    sessionId: "session-candidate-delivery-pr",
    commitLaneId: "lane-candidate-delivery-commit",
    pullRequestLaneId: "lane-candidate-delivery-pr",
    commitSha: headSha,
    pullRequestHeadSha: headSha,
    checksExpectedHeadSha: headSha,
    branch,
    prNumber: 42,
    prUrl,
    checksStatus: "pending",
  });
  assert.deepEqual(observed, rendererDeliveryState("pending"));
  assert.doesNotMatch(compiledExpression, /getProjection|getWorkflowProjection|window\.devflow/);

  const source = await readFile(new URL("candidateDeliveryPrAcceptance.mjs", import.meta.url), "utf8");
  const start = source.indexOf("export async function readRendererDeliveryState");
  const end = source.indexOf("async function auditCandidateRemoteState", start);
  const reader = source.slice(start, end);

  assert.match(reader, /\.react-flow__node/);
  assert.match(reader, /\.agent-node-shell/);
  assert.match(reader, /section\.delivery-panel/);
  assert.match(reader, /\.delivery-facts/);
  assert.match(reader, /data-delivery-session-id/);
  assert.match(reader, /data-delivery-commit-lane-id/);
  assert.match(reader, /data-delivery-pull-request-lane-id/);
  assert.match(reader, /data-delivery-commit-sha/);
  assert.match(reader, /data-delivery-pull-request-head-sha/);
  assert.match(reader, /data-delivery-checks-expected-head-sha/);
  assert.match(reader, /current\.sessionId === expected\.sessionId/);
  assert.match(reader, /current\.commitLaneId === expected\.commitLaneId/);
  assert.match(reader, /current\.pullRequestLaneId === expected\.pullRequestLaneId/);
  assert.match(reader, /current\.commitSha === expected\.commitSha/);
  assert.match(reader, /current\.pullRequestHeadSha === expected\.pullRequestHeadSha/);
  assert.match(reader, /current\.checksExpectedHeadSha === expected\.checksExpectedHeadSha/);
  assert.doesNotMatch(reader, /getProjection|getWorkflowProjection|window\.devflow/);

  const runStart = source.indexOf("export async function runCandidateDeliveryAcceptance");
  const runEnd = source.indexOf("async function preflightCandidateDeliveryAcceptance", runStart);
  const run = source.slice(runStart, runEnd);
  const firstClose = run.indexOf("if (app || cdp)");
  const persistedReopen = run.indexOf('("--inspect"');
  const electronRelaunch = run.indexOf("app = await (services.launch ?? launchElectronAcceptanceApp)", firstClose + 1);
  const reopenedDomRead = run.indexOf("reopenedRendererState = await", electronRelaunch);
  assert.ok(firstClose >= 0);
  assert.ok(firstClose < persistedReopen);
  assert.ok(persistedReopen < electronRelaunch);
  assert.ok(electronRelaunch < reopenedDomRead);
});

test("cleanup fails closed before PR close for foreign, wrong-head, wrong-base, closed, and unaudited PR facts", async (t) => {
  const cleanupCandidateDeliveryResources = requiredExport("cleanupCandidateDeliveryResources");
  const cases = [
    ["foreign repository", { url: "https://github.com/other/skyturn/pull/42" }],
    ["wrong head branch", { headRefName: `${branch}-other` }],
    ["wrong head SHA", { headRefOid: "c".repeat(40) }],
    ["wrong base", { baseRefName: "release" }],
    ["not open", { state: "CLOSED" }],
    ["audit failure", {
      headRefName: undefined,
      headRefOid: undefined,
      baseRefName: undefined,
      state: undefined,
    }],
  ];

  for (const [name, prOverride] of cases) {
    await t.test(name, async () => {
      const commands = [];
      const state = cleanupState({ tempRoot: null, candidateWorktreePath: null, userDataPath: null });
      state.remoteBranchCreated = false;
      state.localBranchCreated = false;
      state.worktreeCreated = false;
      state.pr = { ...state.pr, ...prOverride };
      const result = await cleanupCandidateDeliveryResources({
        cleanupEnabled: true,
        state,
        run: async (command, args) => {
          commands.push([command, args]);
          throw new Error("destructive command must not run");
        },
      });

      assert.equal(result.status, "cleanup-failed");
      assert.equal(result.prClosed, false);
      assert.equal(result.remoteBranchDeleted, false);
      assert.deepEqual(commands, []);
    });
  }
});

test("cleanup rejects a remotely moved smoke branch before closing the PR", async () => {
  const cleanupCandidateDeliveryResources = requiredExport("cleanupCandidateDeliveryResources");
  const commands = [];
  const state = cleanupState({ tempRoot: null, candidateWorktreePath: null, userDataPath: null });
  state.localBranchCreated = false;
  state.worktreeCreated = false;
  const result = await cleanupCandidateDeliveryResources({
    cleanupEnabled: true,
    state,
    run: async (command, args) => {
      commands.push([command, args]);
      if (command === "git" && args[0] === "ls-remote") {
        return { stdout: `${"c".repeat(40)}\trefs/heads/${branch}\n`, stderr: "" };
      }
      throw new Error("branch move must stop cleanup");
    },
  });

  assert.equal(result.status, "cleanup-failed");
  assert.equal(result.prClosed, false);
  assert.equal(result.remoteBranchDeleted, false);
  assert.ok(!commands.some(([command]) => command === "gh"));
  assert.ok(!commands.some(([command, args]) => command === "git" && args[0] === "push"));
});

test("cleanup uses an exact expected-SHA lease and stops local cleanup when the lease is rejected", async () => {
  const cleanupCandidateDeliveryResources = requiredExport("cleanupCandidateDeliveryResources");
  const commands = [];
  const state = cleanupState({ tempRoot: null, candidateWorktreePath: null, userDataPath: null });
  state.localBranchCreated = true;
  state.worktreeCreated = false;
  const result = await cleanupCandidateDeliveryResources({
    cleanupEnabled: true,
    state,
    run: async (command, args) => {
      commands.push([command, args]);
      if (command === "git" && args[0] === "ls-remote") {
        return { stdout: `${headSha}\trefs/heads/${branch}\n`, stderr: "" };
      }
      if (command === "gh" && args[0] === "pr" && args[1] === "close") return { stdout: "", stderr: "" };
      if (command === "gh" && args[0] === "pr" && args[1] === "view") return { stdout: "CLOSED\n", stderr: "" };
      if (command === "git" && args[0] === "push") throw new Error("stale info");
      throw new Error(`unexpected cleanup command: ${command} ${args.join(" ")}`);
    },
  });

  assert.equal(result.status, "cleanup-failed");
  assert.equal(result.prClosed, true);
  assert.equal(result.remoteBranchDeleted, false);
  assert.equal(result.localBranchDeleted, false);
  assert.deepEqual(
    commands.find(([command, args]) => command === "git" && args[0] === "push")?.[1],
    [
      "push",
      `--force-with-lease=refs/heads/${branch}:${headSha}`,
      "origin",
      `:refs/heads/${branch}`,
    ],
  );
  assert.ok(!commands.some(([command, args]) => command === "git" && args[0] === "update-ref"));
});

function requiredExport(name) {
  assert.equal(typeof subject[name], "function", `missing candidate acceptance export: ${name}`);
  return subject[name];
}

function deliveryActionInput() {
  return {
    projectRoot: "/tmp/skyturn-candidate",
    sessionId: "session-candidate-delivery-pr",
    commitLaneId: "lane-candidate-delivery-commit",
    pullRequestLaneId: "lane-candidate-delivery-pr",
    worktreePath: "/tmp/skyturn-candidate",
    markerFile,
    branch,
    baseBranch: "main",
    remote: "origin",
    title: "test(delivery): verify candidate worktree IPC",
    whatChanged: `Added disposable marker ${markerFile}.`,
    why: "Verify SkyTurn delivery IPC against an exact candidate head.",
    breakingChanges: "None.",
    serverPr: "None.",
  };
}

function expectedOracleIdentity() {
  return {
    sessionId: "session-candidate-delivery-pr",
    commitLaneId: "lane-candidate-delivery-commit",
    pullRequestLaneId: "lane-candidate-delivery-pr",
    branch,
    baseBranch: "main",
    remote: "origin",
  };
}

function completedActions(checksStatus) {
  const checks = [{
    name: "ci",
    status: checksStatus === "passed" ? "passed" : "pending",
    state: checksStatus === "passed" ? "SUCCESS" : "IN_PROGRESS",
  }];
  return {
    ok: true,
    actionOrder: [
      "createDeliveryCommit",
      "pushDeliveryBranch",
      "createPullRequest",
      "checkPullRequest",
    ],
    commit: {
      status: "committed",
      commitSha: headSha,
      branch,
      worktreePath: "/tmp/skyturn-candidate",
    },
    push: {
      status: "pushed",
      remote: "origin",
      branch,
      commitSha: headSha,
      worktreePath: "/tmp/skyturn-candidate",
    },
    pullRequest: {
      status: "created",
      url: prUrl,
      number: 42,
      head: branch,
      base: "main",
      remote: "origin",
      commitSha: headSha,
      title: "test(delivery): verify candidate worktree IPC",
    },
    checks: {
      status: checksStatus,
      number: 42,
      url: prUrl,
      headSha,
      checks,
      review: { status: "pending", decision: "REVIEW_REQUIRED" },
      gate: {
        headSha,
        checksStatus,
        reviewStatus: "pending",
        state: "OPEN",
        mergeable: checksStatus === "passed",
      },
    },
    checksObserved: true,
    checksStatus,
    checksPassed: checksStatus === "passed",
    checkAttempts: 1,
  };
}

function authoritativeState() {
  const checks = [{
    name: "ci",
    status: "pending",
    state: "IN_PROGRESS",
  }];
  const projection = {
    lanes: [
      {
        id: "lane-candidate-delivery-commit",
        laneKind: "commit",
        status: "completed",
      },
      {
        id: "lane-candidate-delivery-pr",
        laneKind: "pull_request",
        status: "pending",
      },
    ],
    edges: [{
      id: "edge-candidate-delivery-commit-pr",
      sourceLaneId: "lane-candidate-delivery-commit",
      targetLaneId: "lane-candidate-delivery-pr",
    }],
    segments: [{
      id: "segment-candidate-delivery-commit",
      laneId: "lane-candidate-delivery-commit",
      runId: "run-candidate-delivery-commit",
      status: "succeeded",
    }],
    events: [
      event("workflow.commit.created", {
        laneId: "lane-candidate-delivery-commit",
        evidence: {
          status: "committed",
          commitSha: headSha,
          branch,
          worktreePath: "/tmp/skyturn-candidate",
        },
      }),
      event("workflow.delivery.pushed", {
        laneId: "lane-candidate-delivery-commit",
        evidence: {
          status: "pushed",
          remote: "origin",
          branch,
          commitSha: headSha,
          worktreePath: "/tmp/skyturn-candidate",
        },
      }),
      event("workflow.pull_request.created", {
        laneId: "lane-candidate-delivery-pr",
        commitLaneId: "lane-candidate-delivery-commit",
        evidence: {
          status: "created",
          url: prUrl,
          number: 42,
          head: branch,
          base: "main",
          remote: "origin",
          commitSha: headSha,
        },
      }),
      event("workflow.pull_request.checks_recorded", {
        laneId: "lane-candidate-delivery-pr",
        prNumber: 42,
        url: prUrl,
        headSha,
        status: "pending",
        checks,
        review: { status: "pending", decision: "REVIEW_REQUIRED" },
        evidence: {
          status: "pending",
          number: 42,
          url: prUrl,
          headSha,
          checks,
          review: { status: "pending", decision: "REVIEW_REQUIRED" },
        },
      }),
    ],
    evidence: [
      {
        laneId: "lane-candidate-delivery-commit",
        kind: "delivery-push",
        status: "passed",
        checks: [`remote:origin`, `branch:${branch}`, `head:${headSha}`],
      },
      {
        laneId: "lane-candidate-delivery-pr",
        kind: "pull-request",
        status: "passed",
        checks: [`PR #42`, `head-branch:${branch}`, `head:${headSha}`],
        artifacts: [prUrl],
      },
      {
        laneId: "lane-candidate-delivery-pr",
        kind: "pull-request-checks",
        status: "pending",
        checks: ["ci:pending", "review:pending"],
        artifacts: [prUrl],
      },
    ],
  };
  return {
    projection,
    canvasSession: {
      id: "session-candidate-delivery-pr",
      nodes: [
        {
          id: "lane-candidate-delivery-commit",
          status: "completed",
          context: { dependencies: [] },
        },
        {
          id: "lane-candidate-delivery-pr",
          status: "pending",
          context: { dependencies: ["lane-candidate-delivery-commit"] },
        },
      ],
      edges: [{
        id: "edge-candidate-delivery-commit-pr",
        source: "lane-candidate-delivery-commit",
        target: "lane-candidate-delivery-pr",
      }],
    },
  };
}

function rendererDeliveryState(checksStatus = "pending") {
  return {
    session: {
      title: "Candidate worktree delivery acceptance",
      activeSidebarTitle: "Candidate worktree delivery acceptance",
      mode: "fast",
      sidebarSessionCount: 2,
      canvasLaneCount: 3,
    },
    lanes: [
      {
        id: "lane-candidate-delivery-commit",
        title: "Commit candidate delivery marker",
        status: "completed",
      },
      {
        id: "lane-candidate-delivery-pr",
        title: "Create candidate pull request",
        status: checksStatus === "passed" ? "completed" : "pending",
      },
    ],
    delivery: {
      sessionId: "session-candidate-delivery-pr",
      commitLaneId: "lane-candidate-delivery-commit",
      pullRequestLaneId: "lane-candidate-delivery-pr",
      commitSha: headSha,
      pullRequestHeadSha: headSha,
      checksExpectedHeadSha: headSha,
      commit: headSha.slice(0, 7),
      branch,
      prNumber: 42,
      prUrl,
      headSha: headSha.slice(0, 7),
      checksStatus: checksStatus === "passed" ? "passing" : checksStatus,
      checksHeadSha: headSha.slice(0, 7),
    },
  };
}

function candidateOracleInput(rendererState, reopenedRendererState) {
  return {
    expected: expectedOracleIdentity(),
    actions: completedActions("pending"),
    rendererState,
    reopenedRendererState,
    persistedState: authoritativeState(),
    localHeadSha: headSha,
    remoteHeadSha: headSha,
    pullRequest: auditedPullRequest(),
    baseHeadBefore: baseHeadSha,
    baseHeadAfter: baseHeadSha,
  };
}

function event(kind, payload) {
  eventSequence += 1;
  return {
    id: `event-${eventSequence}-${kind}`,
    kind,
    source: "electron-main",
    payload,
  };
}

function auditedPullRequest(overrides = {}) {
  return {
    number: 42,
    url: prUrl,
    headRefName: branch,
    headRefOid: headSha,
    baseRefName: "main",
    state: "OPEN",
    ...overrides,
  };
}

function cleanupState({ tempRoot, candidateWorktreePath, userDataPath }) {
  return {
    repo: "acme/skyturn",
    repoRoot: "/tmp/skyturn-source",
    baseBranch: "main",
    remote: "origin",
    branch,
    headSha,
    pr: {
      number: 42,
      url: prUrl,
      headRefName: branch,
      headRefOid: headSha,
      baseRefName: "main",
      state: "OPEN",
    },
    remoteBranchCreated: true,
    localBranchCreated: true,
    worktreeCreated: true,
    candidateWorktreePath,
    userDataPath,
    tempRoot,
  };
}

function commandIndex(commands, command, prefix) {
  return commands.findIndex(([candidate, args]) =>
    candidate === command && prefix.every((value, index) => args[index] === value)
  );
}

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
