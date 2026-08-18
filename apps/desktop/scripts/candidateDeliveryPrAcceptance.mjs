import { execFile } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { createRequire } from "node:module";
import { mkdir, mkdtemp, open, readdir, realpath, rename, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

import { buildSmokeBranchName } from "./deliveryGithubSmoke.mjs";
import {
  listHermesVerifierProcesses,
  prepareCandidateReviewCommitCheckout,
} from "./candidateReviewCommitAcceptance.mjs";
import {
  connectToReadySkyTurnRenderer,
  finalizeAcceptanceOutcome,
  launchElectronAcceptanceApp,
  waitForStoredProjectRegistration,
} from "./newSessionUiAcceptance.mjs";

const execFileAsync = promisify(execFile);
const require = createRequire(import.meta.url);
const scriptPath = fileURLToPath(import.meta.url);
const commandOutputLimit = 20 * 1024 * 1024;
const diagnosticLimit = 8_000;
const defaultCheckTimeoutMs = 10 * 60_000;
const maxCheckTimeoutMs = 60 * 60_000;
const defaultPollIntervalMs = 5_000;
const maxPollIntervalMs = 60_000;
const seedResultPrefix = "SKYTURN_CANDIDATE_DELIVERY_SEED=";
const inspectResultPrefix = "SKYTURN_CANDIDATE_DELIVERY_INSPECT=";
const deliveryActionMethods = [
  "createDeliveryCommit",
  "pushDeliveryBranch",
  "createPullRequest",
  "checkPullRequest",
  "mergePullRequest",
  "syncMain",
];
const deliveryEventKinds = [
  "workflow.commit.created",
  "workflow.delivery.pushed",
  "workflow.pull_request.created",
  "workflow.pull_request.checks_recorded",
  "workflow.pull_request.merged",
  "workflow.delivery.main_synced",
];
const cleanupEventKinds = [
  "workflow.worktree.clean_requested",
  "workflow.worktree.cleaned",
  "workflow.worktree.clean_failed",
];
const volatilePathspecs = [
  ".",
  ":(top,exclude).devflow/skyturn-workflow.sqlite",
  ":(top,exclude).devflow/skyturn-workflow.sqlite-wal",
  ":(top,exclude).devflow/skyturn-workflow.sqlite-shm",
  ":(top,glob,exclude).devflow/runs/**",
  ":(top,glob,exclude).devflow/tasks/**/output.md",
];

export const CANDIDATE_DELIVERY_PR_TITLE = "test(delivery): verify candidate worktree IPC";
export const CANDIDATE_DELIVERY_COMMIT_BODY = "Prove all explicit delivery actions.";

export const candidateDeliveryFixture = Object.freeze({
  projectId: "project-candidate-delivery-pr",
  sessionId: "session-candidate-delivery-pr",
  sessionTitle: "Candidate delivery acceptance",
  implementationLaneId: "lane-candidate-delivery-implementation",
  validationLaneId: "lane-candidate-delivery-validation",
  reviewLaneId: "lane-candidate-delivery-review",
  commitLaneId: "lane-candidate-delivery-commit",
  pullRequestLaneId: "lane-candidate-delivery-pr",
  worktreeId: "worktree-session-candidate-delivery-pr-candidate",
  variantId: "candidate",
  lineageId: "lineage-session-candidate-delivery-pr-candidate",
});

export function parseCandidateDeliveryAcceptanceInput(env = process.env, options = {}) {
  if (env.SKYTURN_REAL_DELIVERY_ACCEPTANCE !== "1") {
    return {
      enabled: false,
      reason: "Set SKYTURN_REAL_DELIVERY_ACCEPTANCE=1 to select the real candidate delivery acceptance.",
    };
  }
  if (env.SKYTURN_DELIVERY_ACCEPTANCE_ALLOW_SQUASH_MERGE !== "1") {
    return {
      enabled: false,
      reason: "Set SKYTURN_DELIVERY_ACCEPTANCE_ALLOW_SQUASH_MERGE=1 to authorize the disposable repository squash merge.",
    };
  }

  const repo = requiredText(
    env.SKYTURN_DELIVERY_ACCEPTANCE_REPO,
    "An explicitly named one-shot GitHub repository is required.",
  );
  assertRepoName(repo);
  if (repo.split("/").at(-1)?.toLowerCase() === "skyturn") {
    throw new Error("The SkyTurn repository is never an accepted delivery acceptance target.");
  }
  const ghRepo = optionalText(env.GH_REPO);
  if (ghRepo && ghRepo.toLowerCase() !== repo.toLowerCase()) {
    throw new Error("GH_REPO must be unset or match the exact disposable repository.");
  }
  const ghHost = optionalText(env.GH_HOST);
  if (ghHost && ghHost.toLowerCase() !== "github.com") {
    throw new Error("GH_HOST must be unset or github.com for this disposable repository acceptance.");
  }
  const baseBranch = optionalText(env.SKYTURN_DELIVERY_ACCEPTANCE_BASE_BRANCH) ?? "main";
  if (baseBranch !== "main") {
    throw new Error("Candidate delivery acceptance requires default branch main.");
  }
  const remote = optionalText(env.SKYTURN_DELIVERY_ACCEPTANCE_REMOTE) ?? "origin";
  if (remote !== "origin") {
    throw new Error("Candidate delivery acceptance requires the isolated clone remote origin.");
  }
  const checkName = requiredText(
    env.SKYTURN_DELIVERY_ACCEPTANCE_CHECK_NAME,
    "An exact deterministic pull request check name is required.",
  );
  assertBoundedText(checkName, "check name", 200);
  const workflowPath = requiredText(
    env.SKYTURN_DELIVERY_ACCEPTANCE_WORKFLOW_PATH,
    "An exact deterministic GitHub Actions workflow path is required.",
  );
  if (!/^\.github\/workflows\/[A-Za-z0-9_.-]+\.ya?ml$/.test(workflowPath)) {
    throw new Error("Delivery acceptance workflow path must name one YAML file under .github/workflows.");
  }
  const expectedReviewStatus = requiredText(
    env.SKYTURN_DELIVERY_ACCEPTANCE_EXPECTED_REVIEW_STATUS,
    "An explicit expected pull request review status is required.",
  );
  if (expectedReviewStatus !== "approved" && expectedReviewStatus !== "pending") {
    throw new Error("Expected pull request review status must be approved or pending.");
  }
  const checkTimeoutMs = boundedPositiveInteger(
    env.SKYTURN_DELIVERY_ACCEPTANCE_CHECK_TIMEOUT_MS,
    defaultCheckTimeoutMs,
    maxCheckTimeoutMs,
    "check timeout",
  );
  const pollIntervalMs = boundedPositiveInteger(
    env.SKYTURN_DELIVERY_ACCEPTANCE_POLL_INTERVAL_MS,
    defaultPollIntervalMs,
    maxPollIntervalMs,
    "poll interval",
  );
  const branch = buildSmokeBranchName({
    now: options.now ?? new Date(),
    randomHex: options.randomHex,
  });
  const smokeId = branch.split("/").at(-1);
  return {
    enabled: true,
    repo,
    baseBranch,
    remote,
    checkName,
    workflowPath,
    expectedReviewStatus,
    branch,
    smokeId,
    markerFile: `.devflow/smoke/${smokeId}.md`,
    checkTimeoutMs,
    pollIntervalMs,
    maxCheckAttempts: Math.max(1, Math.ceil(checkTimeoutMs / pollIntervalMs)),
  };
}

export function validateCandidateDeliveryPreflight(facts, input) {
  if (!facts || typeof facts !== "object") throw new Error("Candidate delivery preflight facts are missing.");
  const repository = facts.repository;
  const actions = facts.actions;
  const workflow = facts.workflow;
  const local = facts.local;
  if (!repository || typeof repository !== "object") throw new Error("GitHub repository facts are missing.");
  if (repository.nameWithOwner?.toLowerCase() !== input.repo.toLowerCase()) {
    throw new Error("GitHub repository identity does not match the explicit one-shot repository.");
  }
  if (repository.defaultBranch !== "main") throw new Error("Disposable repository default branch must be main.");
  if (repository.squashMergeAllowed !== true) throw new Error("Disposable repository must enable squash merge.");
  if (repository.deleteBranchOnMerge !== false) {
    throw new Error("Disposable repository must disable automatic head branch deletion.");
  }
  if (repository.archived === true || repository.disabled === true) {
    throw new Error("Disposable repository must be active.");
  }
  if (repository.canPush !== true) throw new Error("Disposable repository push permission is required.");
  if (repository.isFork !== false) throw new Error("Disposable repository must not be a fork.");
  if (actions?.enabled !== true) throw new Error("GitHub Actions must be enabled for the disposable repository.");
  if (
    !Number.isSafeInteger(workflow?.id) ||
    workflow.id <= 0 ||
    workflow?.name !== input.checkName ||
    workflow?.path !== input.workflowPath ||
    workflow?.state !== "active"
  ) {
    throw new Error("The exact deterministic pull request workflow must be active.");
  }
  if (facts.priorPullRequestCount !== 0) {
    throw new Error("The one-shot repository must have no prior pull requests.");
  }
  if (facts.branchProtectionRuleCount !== 0 || facts.rulesetCount !== 0) {
    throw new Error("Disposable repository must not enable branch protection, rulesets, or merge queues.");
  }
  if (!local || typeof local !== "object") throw new Error("Local disposable clone facts are missing.");
  if (local.branch !== "main") throw new Error("Local disposable checkout must remain on main.");
  if (local.status !== "") throw new Error("Local disposable main checkout must be clean.");
  if (
    !isFullCommitSha(local.localMainHead) ||
    local.localMainHead !== local.originMainHead ||
    local.localMainHead !== local.remoteMainHead
  ) {
    throw new Error("Local main must exactly equal freshly fetched origin/main and remote main.");
  }
  if (!arrayEquals(local.divergence, [0, 0])) {
    throw new Error("Local main and origin/main must have zero divergence.");
  }
  if (
    local.fetchRepo?.toLowerCase() !== input.repo.toLowerCase() ||
    local.pushRepo?.toLowerCase() !== input.repo.toLowerCase() ||
    local.fetchHost !== "github.com" ||
    local.pushHost !== "github.com"
  ) {
    throw new Error("Origin fetch and push URLs must resolve to the explicit github.com repository.");
  }
  if (
    !Array.isArray(local.remoteBranches) ||
    local.remoteBranches.length !== 1 ||
    local.remoteBranches[0]?.name !== "main" ||
    local.remoteBranches[0]?.sha !== local.remoteMainHead
  ) {
    throw new Error("A one-shot repository must expose only the exact main branch before acceptance.");
  }
  if (!arrayEquals(local.remoteNames, ["origin"])) {
    throw new Error("The isolated clone must expose only the explicit origin remote.");
  }
  if (local.smokeBranchHead !== null) {
    throw new Error("Generated smoke branch already exists on the disposable repository.");
  }
  if (!isAbsolute(facts.repoRoot)) throw new Error("Disposable clone root must be absolute.");
  return {
    repo: input.repo,
    repoRoot: facts.repoRoot,
    baseBranch: "main",
    baseHead: local.localMainHead,
    workflow: {
      id: workflow.id,
      name: workflow.name,
      path: workflow.path,
      state: workflow.state,
    },
  };
}

export async function preflightCandidateDeliveryAcceptance({ cwd, input, run = runCommand, repoRoot }) {
  try {
    await capture(run, "gh", ["--version"], { cwd });
  } catch {
    throw new Error("GitHub CLI is unavailable for the opted-in candidate delivery acceptance.");
  }
  try {
    await capture(run, "gh", ["auth", "status"], { cwd });
  } catch {
    throw new Error("GitHub CLI authentication is unavailable for the opted-in candidate delivery acceptance.");
  }

  const repositoryApi = parseJsonObject((await capture(run, "gh", [
    "api",
    `repos/${input.repo}`,
  ], { cwd })).stdout, "GitHub repository preflight returned invalid JSON.");
  const actionsApi = parseJsonObject((await capture(run, "gh", [
    "api",
    `repos/${input.repo}/actions/permissions`,
  ], { cwd })).stdout, "GitHub Actions preflight returned invalid JSON.");
  const workflowsApi = parseJsonObject((await capture(run, "gh", [
    "api",
    `repos/${input.repo}/actions/workflows?per_page=100`,
  ], { cwd })).stdout, "GitHub workflow preflight returned invalid JSON.");
  const [repoOwner, repoName] = input.repo.split("/");
  const branchProtectionApi = parseJsonObject((await capture(run, "gh", [
    "api",
    "graphql",
    "-f",
    `owner=${repoOwner}`,
    "-f",
    `name=${repoName}`,
    "-f",
    "query=query($owner:String!,$name:String!){repository(owner:$owner,name:$name){branchProtectionRules(first:1){totalCount}}}",
  ], { cwd })).stdout, "GitHub branch protection preflight returned invalid JSON.");
  const rulesetsApi = parseJsonArray((await capture(run, "gh", [
    "api",
    `repos/${input.repo}/rulesets?includes_parents=true&per_page=100`,
  ], { cwd })).stdout, "GitHub ruleset preflight returned invalid JSON.");
  const matchingWorkflows = Array.isArray(workflowsApi.workflows)
    ? workflowsApi.workflows.filter((item) => item?.path === input.workflowPath)
    : [];
  if (matchingWorkflows.length !== 1) {
    throw new Error("GitHub repository must expose exactly one configured deterministic workflow.");
  }
  const priorPullRequests = parseJsonArray((await capture(run, "gh", [
    "pr",
    "list",
    "--repo",
    input.repo,
    "--state",
    "all",
    "--limit",
    "2",
    "--json",
    "number",
  ], { cwd })).stdout, "GitHub pull request preflight returned invalid JSON.");

  await mkdir(dirname(repoRoot), { recursive: true });
  await capture(run, "gh", [
    "repo",
    "clone",
    input.repo,
    repoRoot,
    "--no-upstream",
    "--",
    "--origin",
    "origin",
    "--branch",
    "main",
    "--single-branch",
    "--no-tags",
  ], { cwd: dirname(repoRoot) });
  const realRepoRoot = await realpath(repoRoot);
  await capture(run, "git", [
    "fetch",
    "--no-tags",
    "origin",
    "refs/heads/main:refs/remotes/origin/main",
  ], { cwd: realRepoRoot });

  const [
    branchResult,
    statusResult,
    localMainResult,
    originMainResult,
    divergenceResult,
    fetchUrlResult,
    pushUrlResult,
    remoteNamesResult,
    remoteRefsResult,
  ] = await Promise.all([
    capture(run, "git", ["symbolic-ref", "--quiet", "--short", "HEAD"], { cwd: realRepoRoot }),
    capture(run, "git", ["status", "--porcelain=v1", "--untracked-files=all"], { cwd: realRepoRoot }),
    capture(run, "git", ["rev-parse", "refs/heads/main^{commit}"], { cwd: realRepoRoot }),
    capture(run, "git", ["rev-parse", "refs/remotes/origin/main^{commit}"], { cwd: realRepoRoot }),
    capture(run, "git", ["rev-list", "--left-right", "--count", "refs/heads/main...refs/remotes/origin/main"], { cwd: realRepoRoot }),
    capture(run, "git", ["remote", "get-url", "origin"], { cwd: realRepoRoot }),
    capture(run, "git", ["remote", "get-url", "--push", "origin"], { cwd: realRepoRoot }),
    capture(run, "git", ["remote"], { cwd: realRepoRoot }),
    capture(run, "git", ["ls-remote", "--heads", "origin"], { cwd: realRepoRoot }),
  ]);
  const remoteBranches = parseRemoteHeads(remoteRefsResult.stdout);
  const remoteMainHead = remoteBranches.find((item) => item.name === "main")?.sha ?? null;
  const smokeBranchHead = remoteBranches.find((item) => item.name === input.branch)?.sha ?? null;
  const divergence = divergenceResult.stdout.trim().split(/\s+/).map(Number);
  const facts = {
    repoRoot: realRepoRoot,
    repository: {
      nameWithOwner: optionalText(repositoryApi.full_name),
      defaultBranch: optionalText(repositoryApi.default_branch),
      squashMergeAllowed: repositoryApi.allow_squash_merge,
      deleteBranchOnMerge: repositoryApi.delete_branch_on_merge,
      archived: repositoryApi.archived,
      disabled: repositoryApi.disabled,
      canPush: repositoryApi.permissions?.push,
      isFork: repositoryApi.fork,
    },
    actions: { enabled: actionsApi.enabled },
    workflow: {
      id: Number(matchingWorkflows[0]?.id),
      name: optionalText(matchingWorkflows[0]?.name),
      path: optionalText(matchingWorkflows[0]?.path),
      state: optionalText(matchingWorkflows[0]?.state),
    },
    priorPullRequestCount: priorPullRequests.length,
    branchProtectionRuleCount: branchProtectionApi.data?.repository?.branchProtectionRules?.totalCount,
    rulesetCount: rulesetsApi.length,
    local: {
      branch: branchResult.stdout.trim(),
      status: statusResult.stdout.trim(),
      localMainHead: localMainResult.stdout.trim().toLowerCase(),
      originMainHead: originMainResult.stdout.trim().toLowerCase(),
      remoteMainHead,
      divergence,
      fetchRepo: githubRepoFromRemoteUrl(fetchUrlResult.stdout),
      pushRepo: githubRepoFromRemoteUrl(pushUrlResult.stdout),
      fetchHost: githubHostFromRemoteUrl(fetchUrlResult.stdout),
      pushHost: githubHostFromRemoteUrl(pushUrlResult.stdout),
      remoteNames: remoteNamesResult.stdout.trim().split("\n").filter(Boolean).sort(compareUtf8),
      remoteBranches,
      smokeBranchHead,
    },
  };
  return validateCandidateDeliveryPreflight(facts, input);
}

export async function runPublicDeliveryActions(input) {
  const progress = {
    commit: null,
    push: null,
    pullRequest: null,
    checks: null,
    merge: null,
    sync: null,
  };
  const actionOrder = [];
  const boundaries = [];
  let verifiedWorkflowRuns = null;
  let stage = "preflight";
  const redactPaths = normalizePathRoots([input.projectRoot, input.worktreePath]);
  const failure = (code, message) => ({
    ok: false,
    actionOrder,
    boundaries,
    ...progress,
    failure: {
      stage,
      code,
      message: sanitizeDiagnostic(message, redactPaths),
      evidence: sanitizedEvidence(publicActionEvidence({
        actionOrder,
        boundaries,
        ...progress,
      }), redactPaths),
    },
  });
  const captureState = async () => {
    if (typeof input.captureState !== "function") return;
    const boundary = await input.captureState({
      completedAction: stage,
      actions: { ok: true, actionOrder: [...actionOrder], ...progress },
    });
    boundaries.push(boundary);
  };

  try {
    const workflow = input.workflow;
    if (!workflow || typeof workflow !== "object") {
      return failure("PUBLIC_WORKFLOW_API_UNAVAILABLE", "window.devflow.workflow is unavailable.");
    }
    for (const method of deliveryActionMethods) {
      if (typeof workflow[method] !== "function") {
        return failure("PUBLIC_WORKFLOW_API_UNAVAILABLE", `window.devflow.workflow.${method} is unavailable.`);
      }
    }

    stage = "createDeliveryCommit";
    actionOrder.push(stage);
    const commitResult = await workflow.createDeliveryCommit(input.projectRoot, {
      sessionId: input.sessionId,
      laneId: input.commitLaneId,
      worktreePath: input.worktreePath,
      subject: input.title,
      ...(input.body ? { body: input.body } : {}),
    });
    const commit = commitResult?.evidence;
    if (
      commitResult?.status !== "committed" ||
      commit?.status !== "committed" ||
      !isFullCommitSha(commit.commitSha) ||
      commit.branch !== input.branch ||
      !isFullCommitSha(commit.parentCommit)
    ) {
      return failure("COMMIT_EVIDENCE_INVALID", "Delivery commit did not return exact candidate publication evidence.");
    }
    progress.commit = Object.freeze({
      status: commit.status,
      commitSha: commit.commitSha.toLowerCase(),
      branch: commit.branch,
      parentCommit: commit.parentCommit.toLowerCase(),
    });
    await captureState();

    stage = "pushDeliveryBranch";
    actionOrder.push(stage);
    const pushResult = await workflow.pushDeliveryBranch(input.projectRoot, {
      sessionId: input.sessionId,
      laneId: input.commitLaneId,
      worktreePath: input.worktreePath,
      commitSha: progress.commit.commitSha,
      branch: input.branch,
      remote: input.remote,
    });
    const push = pushResult?.evidence;
    if (
      pushResult?.status !== "pushed" ||
      push?.status !== "pushed" ||
      push.commitSha !== progress.commit.commitSha ||
      push.branch !== input.branch ||
      push.remote !== input.remote ||
      push.worktreePath !== input.worktreePath
    ) {
      return failure("PUSH_EVIDENCE_INVALID", "Delivery push did not return exact candidate evidence.");
    }
    progress.push = Object.freeze({
      status: push.status,
      remote: push.remote,
      branch: push.branch,
      commitSha: push.commitSha,
      worktreePath: push.worktreePath,
    });
    await captureState();

    stage = "createPullRequest";
    actionOrder.push(stage);
    const pullRequestResult = await workflow.createPullRequest(input.projectRoot, {
      sessionId: input.sessionId,
      laneId: input.pullRequestLaneId,
      commitLaneId: input.commitLaneId,
      worktreePath: input.worktreePath,
      baseBranch: input.baseBranch,
      headBranch: input.branch,
      commitSha: progress.commit.commitSha,
      remote: input.remote,
      title: input.title,
      whatChanged: input.whatChanged,
      why: input.why,
      breakingChanges: input.breakingChanges,
      serverPr: input.serverPr,
    });
    const pullRequest = pullRequestResult?.evidence;
    if (
      pullRequestResult?.status !== "created" ||
      pullRequest?.status !== "created" ||
      !Number.isSafeInteger(pullRequest.number) ||
      pullRequest.number <= 0 ||
      typeof pullRequest.url !== "string" ||
      !pullRequest.url.endsWith(`/pull/${pullRequest.number}`) ||
      pullRequest.head !== input.branch ||
      pullRequest.base !== input.baseBranch ||
      pullRequest.remote !== input.remote ||
      pullRequest.commitSha !== progress.commit.commitSha ||
      pullRequest.title !== input.title
    ) {
      return failure("PULL_REQUEST_EVIDENCE_INVALID", "Pull request creation did not return exact candidate evidence.");
    }
    progress.pullRequest = Object.freeze({
      status: pullRequest.status,
      url: pullRequest.url,
      number: pullRequest.number,
      head: pullRequest.head,
      base: pullRequest.base,
      remote: pullRequest.remote,
      commitSha: pullRequest.commitSha,
      title: pullRequest.title,
    });
    await captureState();

    stage = "waitForExactHeadGate";
    try {
      if (typeof input.waitForGate !== "function") {
        throw new Error("The independent exact workflow run gate is unavailable.");
      }
      const gate = await input.waitForGate({
        projectRoot: input.projectRoot,
        repo: input.repo,
        prNumber: progress.pullRequest.number,
        prUrl: progress.pullRequest.url,
        expectedHeadSha: progress.commit.commitSha,
        checkName: input.checkName,
        workflowId: input.workflowId,
        workflowPath: input.workflowPath,
        expectedReviewStatus: input.expectedReviewStatus,
      });
      assertPassedChecksGate(
        gate,
        progress.pullRequest,
        progress.commit.commitSha,
        input.checkName,
        input.expectedReviewStatus,
        input.workflowId,
        input.workflowPath,
      );
      verifiedWorkflowRuns = summarizeWorkflowRuns(gate.workflowRuns);
    } catch (error) {
      return failure("CHECK_GATE_NOT_PASSED", safeErrorMessage(error));
    }

    stage = "checkPullRequest";
    actionOrder.push(stage);
    const checksResult = await workflow.checkPullRequest(input.projectRoot, {
      sessionId: input.sessionId,
      laneId: input.pullRequestLaneId,
      prNumber: progress.pullRequest.number,
      prUrl: progress.pullRequest.url,
      expectedHeadSha: progress.commit.commitSha,
    });
    const checks = checksResult?.evidence && {
      ...checksResult.evidence,
      workflowRuns: verifiedWorkflowRuns,
    };
    try {
      if (checksResult?.status !== "checks_recorded") throw new Error("checks result status is invalid");
      assertPassedChecksGate(
        checks,
        progress.pullRequest,
        progress.commit.commitSha,
        input.checkName,
        input.expectedReviewStatus,
        input.workflowId,
        input.workflowPath,
      );
    } catch {
      progress.checks = summarizeChecks(checks);
      return failure("CHECK_GATE_NOT_PASSED", "The public exact-head Checks action did not persist a passed merge gate.");
    }
    progress.checks = summarizeChecks(checks);
    await captureState();

    try {
      assertExactWorkflowRuns(
        progress.checks.workflowRuns,
        progress.commit.commitSha,
        input.workflowId,
        input.workflowPath,
      );
    } catch {
      return failure("CHECK_GATE_NOT_PASSED", "The exact configured workflow run was not successful at the merge boundary.");
    }
    stage = "mergePullRequest";
    actionOrder.push(stage);
    const mergeResult = await workflow.mergePullRequest(input.projectRoot, {
      sessionId: input.sessionId,
      laneId: input.pullRequestLaneId,
      prNumber: progress.pullRequest.number,
      prUrl: progress.pullRequest.url,
      expectedHeadSha: progress.commit.commitSha,
      subject: input.title,
      ...(input.body ? { body: input.body } : {}),
    });
    const merge = mergeResult?.evidence;
    if (
      mergeResult?.status !== "merged" ||
      merge?.status !== "merged" ||
      merge.number !== progress.pullRequest.number ||
      merge.url !== progress.pullRequest.url ||
      merge.headSha !== progress.commit.commitSha ||
      merge.subject !== input.title ||
      !namedCheckPassed(merge.checks, input.checkName) ||
      merge.review?.status !== input.expectedReviewStatus
    ) {
      return failure("MERGE_EVIDENCE_INVALID", "Squash merge did not return exact candidate evidence.");
    }
    progress.merge = Object.freeze({
      status: merge.status,
      number: merge.number,
      url: merge.url,
      headSha: merge.headSha,
      subject: merge.subject,
      checks: merge.checks,
      review: merge.review,
    });
    await captureState();

    stage = "syncMain";
    actionOrder.push(stage);
    const syncResult = await workflow.syncMain(input.projectRoot, {
      sessionId: input.sessionId,
      laneId: input.pullRequestLaneId,
      prNumber: progress.pullRequest.number,
      prUrl: progress.pullRequest.url,
      expectedHeadSha: progress.commit.commitSha,
      mainBranch: input.baseBranch,
      remote: input.remote,
    });
    const sync = syncResult?.evidence;
    if (
      syncResult?.status !== "synced" ||
      sync?.status !== "synced" ||
      sync.mainBranch !== input.baseBranch ||
      sync.remote !== input.remote
    ) {
      return failure("SYNC_EVIDENCE_INVALID", "Sync Main did not return exact main branch evidence.");
    }
    progress.sync = Object.freeze({
      status: sync.status,
      mainBranch: sync.mainBranch,
      remote: sync.remote,
    });
    await captureState();

    return {
      ok: true,
      actionOrder,
      boundaries,
      ...progress,
      failure: null,
    };
  } catch (error) {
    return failure("PUBLIC_WORKFLOW_ACTION_FAILED", safeErrorMessage(error, redactPaths));
  }
}

export function buildRendererDeliveryActionInvocation(method, projectRoot, input) {
  if (!deliveryActionMethods.includes(method)) {
    throw new Error(`Unknown public delivery action: ${method}.`);
  }
  return `
    (async () => {
      const workflow = window.devflow?.workflow;
      if (!workflow || typeof workflow.${method} !== 'function') {
        throw new Error('Public delivery action is unavailable: ${method}.');
      }
      return await workflow.${method}(${JSON.stringify(projectRoot)}, ${JSON.stringify(input)});
    })()
  `;
}

export function candidateDeliveryAuthoritativeStateOracle(
  persistedState,
  expected = {},
  actions = {},
  label = "persisted",
) {
  const failures = [];
  const addFailure = (failure) => {
    const value = `${label}-authoritative-${failure}`;
    if (!failures.includes(value)) failures.push(value);
  };
  const laneSpecs = candidateDeliveryLaneSpecs(expected);
  const dependencySpecs = candidateDeliveryDependencySpecs(expected);
  const expectedLaneIds = laneSpecs.map(([laneId]) => laneId);
  const expectedLaneIdSet = new Set(expectedLaneIds);
  if (
    expectedLaneIds.some((laneId) => typeof laneId !== "string" || laneId.length === 0) ||
    expectedLaneIdSet.size !== laneSpecs.length
  ) {
    addFailure("expected-lane-identity-invalid");
    return { ok: false, failures };
  }

  const projection = persistedState?.projection;
  const canvasSession = persistedState?.canvasSession;
  if (!isObjectRecord(projection)) addFailure("projection-missing");
  if (!isObjectRecord(canvasSession)) addFailure("canvas-session-missing");
  if (persistedState?.manifest?.sessionId !== expected.sessionId) addFailure("manifest-session-invalid");

  if (projection?.sessionId !== expected.sessionId) addFailure("projection-session-invalid");
  assertExactCandidateProjectionLanes(projection?.lanes, laneSpecs, addFailure);
  assertExactCandidateTopology(
    projection?.edges,
    dependencySpecs,
    "sourceLaneId",
    "targetLaneId",
    addFailure,
    "projection",
  );

  if (
    canvasSession?.id !== expected.sessionId ||
    canvasSession?.projectId !== expected.projectId ||
    canvasSession?.title !== candidateDeliveryFixture.sessionTitle ||
    canvasSession?.kind !== "canvas" ||
    canvasSession?.mode !== "fast"
  ) addFailure("canvas-session-identity-invalid");
  if (
    canvasSession?.target?.executionTarget !== "new_worktree" ||
    canvasSession?.target?.selectedBranch !== expected.baseBranch ||
    canvasSession?.target?.baseRef !== `origin/${expected.baseBranch}`
  ) addFailure("canvas-session-target-invalid");
  assertExactCandidateCanvasNodes(canvasSession, laneSpecs, expectedLaneIdSet, addFailure);
  assertExactCandidateTopology(
    canvasSession?.edges,
    dependencySpecs,
    "source",
    "target",
    addFailure,
    "canvas",
  );

  const rawEvents = Array.isArray(persistedState?.events) ? persistedState.events : [];
  const projectionEvents = Array.isArray(projection?.events) ? projection.events : [];
  if (rawEvents.length === 0 || rawEvents.some((event) => event?.sessionId !== expected.sessionId)) {
    addFailure("raw-event-session-invalid");
  }
  if (
    projectionEvents.length === 0 ||
    projectionEvents.some((event) => event?.sessionId !== expected.sessionId)
  ) addFailure("projection-event-session-invalid");
  const rawDeliveryEvents = rawEvents.filter((event) => deliveryEventKinds.includes(event?.kind));
  const projectedDeliveryEvents = projectionEvents.filter((event) => deliveryEventKinds.includes(event?.kind));
  assertCandidateDeliveryEventFacts(rawDeliveryEvents, expected, actions, addFailure, "raw");
  assertCandidateDeliveryEventFacts(projectedDeliveryEvents, expected, actions, addFailure, "projection");
  if (
    stableJson(rawDeliveryEvents.map(authoritativeFlowEventFields)) !==
    stableJson(projectedDeliveryEvents.map(authoritativeFlowEventFields))
  ) addFailure("projection-events-mismatch");

  return { ok: failures.length === 0, failures };
}

export function candidateDeliveryOracle(input) {
  const failures = [];
  const addFailure = (failure) => {
    if (!failures.includes(failure)) failures.push(failure);
  };
  const expected = input.expected ?? {};
  const actions = input.actions ?? {};
  const candidateSha = actions.commit?.commitSha;
  const persisted = input.persistedState;
  const reopened = input.reopenedPersistedState;
  const events = Array.isArray(persisted?.events) ? persisted.events : [];
  const primaryEvents = events.filter((item) => deliveryEventKinds.includes(item?.kind));
  const primaryKinds = primaryEvents.map((item) => item.kind);
  const finalRemote = input.finalRemote ?? {};
  const mergeSha = finalRemote.pullRequest?.mergeCommitOid;
  const temporaryRootObserved = input.reviewObservation?.temporaryRootObserved === true;
  const verifierProcessObserved = input.reviewObservation?.verifierProcessObserved === true;

  if (actions.ok !== true) addFailure("public-actions-failed");
  if (!temporaryRootObserved) addFailure("hermes-review-temporary-root-not-observed");
  if (!verifierProcessObserved) addFailure("hermes-review-verifier-process-not-observed");
  if (!arrayEquals(actions.actionOrder, deliveryActionMethods)) addFailure("public-action-order-invalid");
  if (!isFullCommitSha(candidateSha)) addFailure("candidate-sha-invalid");
  if (actions.commit?.branch !== expected.branch) addFailure("commit-branch-mismatch");
  if (actions.commit?.parentCommit !== expected.baseHead) addFailure("commit-parent-mismatch");
  if (actions.push?.commitSha !== candidateSha || actions.push?.branch !== expected.branch) {
    addFailure("push-candidate-mismatch");
  }
  if (actions.pullRequest?.commitSha !== candidateSha || actions.pullRequest?.head !== expected.branch) {
    addFailure("pull-request-candidate-mismatch");
  }
  if (actions.checks?.headSha !== candidateSha || actions.checks?.status !== "passed") {
    addFailure("checks-candidate-mismatch");
  }
  if (!namedCheckPassed(actions.checks?.checks, expected.checkName)) addFailure("deterministic-check-missing");
  try {
    assertExactWorkflowRuns(
      actions.checks?.workflowRuns,
      candidateSha,
      expected.workflowId,
      expected.workflowPath,
    );
  } catch {
    addFailure("exact-workflow-run-invalid");
  }
  if (
    actions.checks?.gate?.headSha !== candidateSha ||
    actions.checks?.gate?.checksStatus !== "passed" ||
    actions.checks?.gate?.state !== "OPEN" ||
    actions.checks?.gate?.mergeable !== true ||
    actions.checks?.gate?.reviewStatus !== expected.expectedReviewStatus
  ) addFailure("checks-gate-invalid");
  if (actions.merge?.headSha !== candidateSha || actions.merge?.status !== "merged") {
    addFailure("merge-candidate-mismatch");
  }
  if (actions.merge?.review?.status !== expected.expectedReviewStatus) {
    addFailure("merge-review-status-mismatch");
  }
  if (
    actions.sync?.status !== "synced" ||
    actions.sync?.mainBranch !== expected.baseBranch ||
    actions.sync?.remote !== expected.remote
  ) addFailure("sync-evidence-invalid");

  const persistedAuthority = candidateDeliveryAuthoritativeStateOracle(
    persisted,
    expected,
    actions,
    "persisted",
  );
  const reopenedAuthority = candidateDeliveryAuthoritativeStateOracle(
    reopened,
    expected,
    actions,
    "reopened",
  );
  for (const failure of [...persistedAuthority.failures, ...reopenedAuthority.failures]) addFailure(failure);
  const authoritativeStateValid = persistedAuthority.ok && reopenedAuthority.ok;
  const authoritativeReopenPreserved =
    stableJson(persisted?.projection) === stableJson(reopened?.projection) &&
    stableJson(persisted?.canvasSession) === stableJson(reopened?.canvasSession);
  if (!authoritativeReopenPreserved) addFailure("sqlite-authoritative-reopen-drifted");

  if (!arrayEquals(primaryKinds, deliveryEventKinds)) addFailure("delivery-event-cardinality-or-order-invalid");
  if (!strictlyIncreasing(primaryEvents.map((item) => item?.seq))) addFailure("delivery-event-sequence-invalid");
  if (primaryEvents.some((item) => item?.source !== "electron-main")) addFailure("delivery-event-source-invalid");
  assertRemoteSideEffectEvents(events, primaryEvents, addFailure);
  const reopenedEvents = Array.isArray(reopened?.events) ? reopened.events : [];
  const reopenedPrimaryEvents = reopenedEvents.filter((item) => deliveryEventKinds.includes(item?.kind));
  assertRemoteSideEffectEvents(
    reopenedEvents,
    reopenedPrimaryEvents,
    addFailure,
    undefined,
    "reopened-",
  );
  const [commitEvent, pushEvent, prEvent, checksEvent, mergeEvent, syncEvent] = primaryEvents;
  if (
    eventLaneId(commitEvent) !== expected.commitLaneId ||
    commitEvent?.payload?.evidence?.commitSha !== candidateSha ||
    commitEvent?.payload?.evidence?.parentCommit !== expected.baseHead
  ) addFailure("commit-event-invalid");
  if (
    eventLaneId(pushEvent) !== expected.commitLaneId ||
    pushEvent?.payload?.evidence?.commitSha !== candidateSha
  ) addFailure("push-event-invalid");
  if (
    eventLaneId(prEvent) !== expected.pullRequestLaneId ||
    prEvent?.payload?.commitLaneId !== expected.commitLaneId ||
    prEvent?.payload?.evidence?.commitSha !== candidateSha
  ) addFailure("pull-request-event-invalid");
  const checksEvidence = checksEvent?.payload?.evidence;
  if (
    eventLaneId(checksEvent) !== expected.pullRequestLaneId ||
    checksEvent?.payload?.headSha !== candidateSha ||
    checksEvidence?.status !== "passed" ||
    checksEvidence?.review?.status !== expected.expectedReviewStatus ||
    !namedCheckPassed(checksEvidence?.checks, expected.checkName)
  ) addFailure("checks-event-invalid");
  if (
    eventLaneId(mergeEvent) !== expected.pullRequestLaneId ||
    mergeEvent?.payload?.evidence?.headSha !== candidateSha ||
    mergeEvent?.payload?.evidence?.status !== "merged"
  ) addFailure("merge-event-invalid");
  if (
    eventLaneId(syncEvent) !== expected.pullRequestLaneId ||
    syncEvent?.payload?.sessionWide !== true ||
    syncEvent?.payload?.prNumber !== actions.pullRequest?.number ||
    syncEvent?.payload?.headSha !== candidateSha ||
    syncEvent?.payload?.evidence?.status !== "synced" ||
    syncEvent?.payload?.evidence?.mainBranch !== expected.baseBranch ||
    syncEvent?.payload?.evidence?.remote !== expected.remote
  ) addFailure("sync-event-invalid");

  const reviewEvents = events.filter((item) => item?.kind === "workflow.candidate.review_allowed");
  const preparedEvents = events.filter((item) => item?.kind === "workflow.commit.publication_prepared");
  if (
    reviewEvents.length !== 1 ||
    reviewEvents[0]?.payload?.manifestSha256 !== expected.manifestSha256 ||
    reviewEvents[0]?.payload?.decision?.disposition !== "allow"
  ) addFailure("candidate-review-attestation-invalid");
  if (
    preparedEvents.length !== 1 ||
    preparedEvents[0]?.payload?.manifestSha256 !== expected.manifestSha256
  ) addFailure("candidate-publication-preparation-invalid");
  if (persisted?.manifestSha256 !== expected.manifestSha256) addFailure("persisted-manifest-invalid");
  if (input.seededManifestSha256 !== expected.manifestSha256) addFailure("seeded-manifest-invalid");

  const manifestReopenPreserved =
    reopened?.manifestSha256 === expected.manifestSha256 &&
    stableJson(persisted?.manifest) === stableJson(reopened?.manifest) &&
    stableJson(events) === stableJson(reopened?.events);
  if (!manifestReopenPreserved) addFailure("sqlite-reopen-drifted");

  assertRendererTerminalState(input.rendererState, expected, actions, addFailure, "renderer");
  assertRendererTerminalState(input.reopenedRendererState, expected, actions, addFailure, "reopened-renderer");
  const rendererReopenPreserved = stableJson(input.rendererState) === stableJson(input.reopenedRendererState);
  if (!rendererReopenPreserved) addFailure("renderer-reopen-drifted");

  assertDeliveryBoundaries(input.boundaries, expected, candidateSha, mergeSha, addFailure);
  if (!isFullCommitSha(mergeSha)) addFailure("merge-sha-invalid");
  const pr = finalRemote.pullRequest;
  if (
    !pr ||
    pr.number !== actions.pullRequest?.number ||
    pr.url !== actions.pullRequest?.url ||
    pr.headRefName !== expected.branch ||
    pr.headRefOid !== candidateSha ||
    pr.baseRefName !== expected.baseBranch ||
    pr.state !== "MERGED" ||
    pr.mergeCommitOid !== mergeSha
  ) addFailure("github-merged-pull-request-invalid");
  if (
    finalRemote.candidateHead !== candidateSha ||
    finalRemote.candidateParentCommit !== expected.baseHead ||
    finalRemote.remoteBranchHead !== candidateSha
  ) addFailure("candidate-git-lineage-invalid");
  if (
    finalRemote.remoteMainHead !== mergeSha ||
    finalRemote.originMainHead !== mergeSha ||
    finalRemote.localMainHead !== mergeSha
  ) addFailure("main-sync-sha-invalid");
  if (
    finalRemote.mainParentCommit !== expected.baseHead ||
    !isFullCommitSha(finalRemote.candidateTreeSha) ||
    finalRemote.mainTreeSha !== finalRemote.candidateTreeSha
  ) addFailure("squash-merge-tree-invalid");

  const noCleanupAction = !events.some((item) => cleanupEventKinds.includes(item?.kind));
  if (!noCleanupAction) addFailure("cleanup-action-present");

  return {
    ok: failures.length === 0,
    failures,
    candidateSha: candidateSha ?? null,
    mergeSha: mergeSha ?? null,
    deliveryEventKinds: primaryKinds,
    rendererReopenPreserved,
    manifestReopenPreserved,
    authoritativeStateValid,
    authoritativeReopenPreserved,
    noCleanupAction,
    hermesReview: {
      temporaryRootObserved,
      verifierProcessObserved,
    },
  };
}

function candidateDeliveryLaneSpecs(expected) {
  return [
    [expected.implementationLaneId, "implementation"],
    [expected.validationLaneId, "validation"],
    [expected.reviewLaneId, "review"],
    [expected.commitLaneId, "commit"],
    [expected.pullRequestLaneId, "pull_request"],
  ];
}

function candidateDeliveryDependencySpecs(expected) {
  return [
    [expected.implementationLaneId, expected.validationLaneId],
    [expected.validationLaneId, expected.reviewLaneId],
    [expected.reviewLaneId, expected.commitLaneId],
    [expected.commitLaneId, expected.pullRequestLaneId],
  ];
}

function assertExactCandidateProjectionLanes(lanes, laneSpecs, addFailure) {
  if (!Array.isArray(lanes) || lanes.length !== laneSpecs.length) {
    addFailure("projection-lane-cardinality-invalid");
  }
  const values = Array.isArray(lanes) ? lanes : [];
  const expectedIds = new Set(laneSpecs.map(([laneId]) => laneId));
  if (values.some((lane) => !expectedIds.has(lane?.id))) addFailure("projection-lane-identity-invalid");
  for (const [laneId, laneKind] of laneSpecs) {
    const matches = values.filter((lane) => lane?.id === laneId);
    if (matches.length !== 1) {
      addFailure("projection-lane-identity-invalid");
      continue;
    }
    const lane = matches[0];
    if (lane.kind !== laneKind || lane.laneKind !== laneKind) addFailure("projection-lane-kind-invalid");
    if (lane.status !== "completed") addFailure("projection-lane-status-invalid");
  }
}

function assertExactCandidateCanvasNodes(canvasSession, laneSpecs, expectedLaneIds, addFailure) {
  const nodes = Array.isArray(canvasSession?.nodes) ? canvasSession.nodes : [];
  const candidateNodes = nodes.filter((node) => expectedLaneIds.has(node?.id));
  const plannerNodeId = canvasSession?.plannerNodeId;
  const plannerNodes = typeof plannerNodeId === "string"
    ? nodes.filter((node) => node?.id === plannerNodeId)
    : [];
  const unexpectedNodes = nodes.filter((node) =>
    !expectedLaneIds.has(node?.id) && node?.id !== plannerNodeId
  );
  if (
    candidateNodes.length !== laneSpecs.length ||
    plannerNodes.length !== 1 ||
    unexpectedNodes.length !== 0 ||
    nodes.length !== laneSpecs.length + 1
  ) addFailure("canvas-node-cardinality-invalid");
  if (!arrayEquals(plannerNodes[0]?.context?.dependencies, [])) {
    addFailure("canvas-planner-topology-invalid");
  }
  const dependencies = new Map([
    [laneSpecs[0]?.[0], []],
    [laneSpecs[1]?.[0], [laneSpecs[0]?.[0]]],
    [laneSpecs[2]?.[0], [laneSpecs[1]?.[0]]],
    [laneSpecs[3]?.[0], [laneSpecs[2]?.[0]]],
    [laneSpecs[4]?.[0], [laneSpecs[3]?.[0]]],
  ]);
  for (const [laneId, laneKind] of laneSpecs) {
    const matches = candidateNodes.filter((node) => node?.id === laneId);
    if (matches.length !== 1) {
      addFailure("canvas-node-identity-invalid");
      continue;
    }
    const node = matches[0];
    if (node.laneKind !== laneKind) addFailure("canvas-node-kind-invalid");
    if (node.status !== "completed") addFailure("canvas-node-status-invalid");
    if (!arrayEquals(node.context?.dependencies, dependencies.get(laneId) ?? [])) {
      addFailure("canvas-node-dependencies-invalid");
    }
  }
}

function assertExactCandidateTopology(
  edges,
  dependencySpecs,
  sourceKey,
  targetKey,
  addFailure,
  label,
) {
  if (!Array.isArray(edges) || edges.length !== dependencySpecs.length) {
    addFailure(`${label}-edge-cardinality-invalid`);
  }
  const values = Array.isArray(edges) ? edges : [];
  const pairs = values.map((edge) => `${edge?.[sourceKey]}\0${edge?.[targetKey]}`);
  const expectedPairs = dependencySpecs.map(([source, target]) => `${source}\0${target}`);
  if (
    new Set(pairs).size !== dependencySpecs.length ||
    !arrayEquals([...pairs].sort(compareUtf8), [...expectedPairs].sort(compareUtf8))
  ) addFailure(`${label}-topology-invalid`);
  const edgeIds = values.map((edge) => edge?.id);
  if (
    edgeIds.some((edgeId) => typeof edgeId !== "string" || edgeId.length === 0) ||
    new Set(edgeIds).size !== dependencySpecs.length
  ) addFailure(`${label}-edge-identity-invalid`);
}

function assertCandidateDeliveryEventFacts(events, expected, actions, addFailure, label) {
  const kinds = events.map((event) => event?.kind);
  if (!arrayEquals(kinds, deliveryEventKinds)) addFailure(`${label}-delivery-event-cardinality-invalid`);
  if (!strictlyIncreasing(events.map((event) => event?.seq))) {
    addFailure(`${label}-delivery-event-sequence-invalid`);
  }
  if (events.some((event) => event?.source !== "electron-main")) {
    addFailure(`${label}-delivery-event-source-invalid`);
  }
  if (events.some((event) => event?.sessionId !== expected.sessionId)) {
    addFailure(`${label}-delivery-event-session-invalid`);
  }
  const [commitEvent, pushEvent, prEvent, checksEvent, mergeEvent, syncEvent] = events;
  const candidateSha = actions.commit?.commitSha;
  const commit = commitEvent?.payload?.evidence;
  if (
    eventLaneId(commitEvent) !== expected.commitLaneId ||
    commit?.status !== "committed" ||
    commit?.commitSha !== candidateSha ||
    commit?.branch !== expected.branch ||
    commit?.parentCommit !== expected.baseHead
  ) addFailure(`${label}-commit-event-invalid`);
  const push = pushEvent?.payload?.evidence;
  if (
    eventLaneId(pushEvent) !== expected.commitLaneId ||
    push?.status !== "pushed" ||
    push?.commitSha !== candidateSha ||
    push?.branch !== expected.branch ||
    push?.remote !== expected.remote
  ) addFailure(`${label}-push-event-invalid`);
  const pullRequest = prEvent?.payload?.evidence;
  if (
    eventLaneId(prEvent) !== expected.pullRequestLaneId ||
    prEvent?.payload?.commitLaneId !== expected.commitLaneId ||
    pullRequest?.status !== "created" ||
    pullRequest?.number !== actions.pullRequest?.number ||
    pullRequest?.url !== actions.pullRequest?.url ||
    pullRequest?.head !== expected.branch ||
    pullRequest?.base !== expected.baseBranch ||
    pullRequest?.remote !== expected.remote ||
    pullRequest?.commitSha !== candidateSha ||
    pullRequest?.title !== actions.pullRequest?.title
  ) addFailure(`${label}-pull-request-event-invalid`);
  const checks = checksEvent?.payload?.evidence;
  if (
    eventLaneId(checksEvent) !== expected.pullRequestLaneId ||
    checksEvent?.payload?.prNumber !== actions.pullRequest?.number ||
    checksEvent?.payload?.headSha !== candidateSha ||
    checksEvent?.payload?.status !== "passed" ||
    checks?.status !== "passed" ||
    checks?.number !== actions.pullRequest?.number ||
    checks?.url !== actions.pullRequest?.url ||
    checks?.headSha !== candidateSha ||
    checks?.review?.status !== expected.expectedReviewStatus ||
    checks?.gate?.headSha !== candidateSha ||
    checks?.gate?.checksStatus !== "passed" ||
    checks?.gate?.reviewStatus !== expected.expectedReviewStatus ||
    checks?.gate?.state !== "OPEN" ||
    checks?.gate?.mergeable !== true ||
    !namedCheckPassed(checks?.checks, expected.checkName)
  ) addFailure(`${label}-checks-event-invalid`);
  const merge = mergeEvent?.payload?.evidence;
  if (
    eventLaneId(mergeEvent) !== expected.pullRequestLaneId ||
    merge?.status !== "merged" ||
    merge?.number !== actions.pullRequest?.number ||
    merge?.url !== actions.pullRequest?.url ||
    merge?.headSha !== candidateSha ||
    merge?.subject !== actions.merge?.subject ||
    merge?.review?.status !== expected.expectedReviewStatus
  ) addFailure(`${label}-merge-event-invalid`);
  const sync = syncEvent?.payload?.evidence;
  if (
    eventLaneId(syncEvent) !== expected.pullRequestLaneId ||
    syncEvent?.payload?.sessionWide !== true ||
    syncEvent?.payload?.prNumber !== actions.pullRequest?.number ||
    syncEvent?.payload?.headSha !== candidateSha ||
    sync?.status !== "synced" ||
    sync?.mainBranch !== expected.baseBranch ||
    sync?.remote !== expected.remote
  ) addFailure(`${label}-sync-event-invalid`);
}

function authoritativeFlowEventFields(event) {
  return {
    id: event?.id ?? null,
    sessionId: event?.sessionId ?? null,
    kind: event?.kind ?? null,
    source: event?.source ?? null,
    payload: event?.payload ?? null,
    createdAt: event?.createdAt ?? null,
    idempotencyKey: event?.idempotencyKey ?? null,
  };
}

function isObjectRecord(value) {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function assertDeliveryBoundaries(boundaries, expected, candidateSha, mergeSha, addFailure) {
  if (!Array.isArray(boundaries) || boundaries.length !== deliveryActionMethods.length) {
    addFailure("delivery-boundaries-missing");
    return;
  }
  for (const [index, boundary] of boundaries.entries()) {
    if (boundary?.completedAction !== deliveryActionMethods[index]) {
      addFailure("delivery-boundary-action-order-invalid");
    }
    if (!arrayEquals(boundary?.deliveryEventKinds, deliveryEventKinds.slice(0, index + 1))) {
      addFailure("delivery-boundary-event-prefix-invalid");
    }
    const expectedRemoteSideEffects = [
      ...(index >= 1 ? ["workflow.delivery.pushed"] : []),
      ...(index >= 2 ? ["workflow.pull_request.created"] : []),
      ...(index >= 4 ? ["workflow.pull_request.merged"] : []),
      ...(index >= 5 ? ["workflow.delivery.main_synced"] : []),
    ];
    if (
      !arrayEquals(boundary?.remoteSideEffectEventKinds, expectedRemoteSideEffects) ||
      !arrayEquals(boundary?.remoteSideEffectCompletedKinds, expectedRemoteSideEffects)
    ) addFailure("delivery-boundary-remote-side-effect-prefix-invalid");
    const boundaryEvents = Array.isArray(boundary?.persisted?.events) ? boundary.persisted.events : [];
    assertRemoteSideEffectEvents(
      boundaryEvents,
      boundaryEvents.filter((item) => deliveryEventKinds.includes(item?.kind)),
      addFailure,
      expectedRemoteSideEffects,
      "delivery-boundary-",
    );
    const remote = boundary?.remote ?? {};
    const pushed = index >= 1;
    const pullRequestCreated = index >= 2;
    const merged = index >= 4;
    const synced = index >= 5;
    if (remote.candidateHead !== candidateSha) addFailure("delivery-boundary-candidate-invalid");
    if (remote.remoteBranchHead !== (pushed ? candidateSha : null)) {
      addFailure("delivery-boundary-remote-branch-invalid");
    }
    if (!pullRequestCreated && remote.pullRequest !== null) addFailure("delivery-boundary-early-pr-side-effect");
    if (pullRequestCreated) {
      if (
        remote.pullRequest?.headRefName !== expected.branch ||
        remote.pullRequest?.headRefOid !== candidateSha ||
        remote.pullRequest?.baseRefName !== expected.baseBranch ||
        remote.pullRequest?.state !== (merged ? "MERGED" : "OPEN")
      ) addFailure("delivery-boundary-pr-invalid");
    }
    if (!merged) {
      if (
        remote.remoteMainHead !== expected.baseHead ||
        remote.localMainHead !== expected.baseHead ||
        remote.originMainHead !== expected.baseHead ||
        remote.pullRequest?.mergeCommitOid
      ) addFailure("delivery-boundary-early-merge-side-effect");
    } else if (
      remote.remoteMainHead !== mergeSha ||
      remote.pullRequest?.mergeCommitOid !== mergeSha ||
      remote.localMainHead !== (synced ? mergeSha : expected.baseHead) ||
      remote.originMainHead !== (synced ? mergeSha : expected.baseHead)
    ) {
      addFailure("delivery-boundary-merge-sync-invalid");
    }
  }
}

function assertRemoteSideEffectEvents(
  events,
  primaryEvents,
  addFailure,
  expected = [
    "workflow.delivery.pushed",
    "workflow.pull_request.created",
    "workflow.pull_request.merged",
    "workflow.delivery.main_synced",
  ],
  failurePrefix = "",
) {
  const requested = events.filter((item) => item?.kind === "workflow.remote_side_effect.requested");
  const completed = events.filter((item) => item?.kind === "workflow.remote_side_effect.completed");
  const requestOperationIds = requested.map((item) => item?.payload?.operationId);
  const completionOperationIds = completed.map((item) => item?.payload?.operationId);
  if (
    !arrayEquals(requested.map((item) => item?.payload?.eventKind), expected) ||
    !arrayEquals(completed.map((item) => item?.payload?.eventKind), expected) ||
    completed.some((item) => item?.payload?.status !== "succeeded") ||
    requestOperationIds.some((operationId) => typeof operationId !== "string" || operationId.length === 0) ||
    completionOperationIds.some((operationId) => typeof operationId !== "string" || operationId.length === 0) ||
    new Set(requestOperationIds).size !== expected.length ||
    new Set(completionOperationIds).size !== expected.length
  ) {
    addFailure(`${failurePrefix}remote-side-effect-audit-cardinality-invalid`);
    return;
  }
  for (const [index, eventKind] of expected.entries()) {
    const request = requested[index];
    const completion = completed[index];
    const primary = primaryEvents.find((item) => item?.kind === eventKind);
    const nextRequest = requested[index + 1];
    if (
      !request ||
      !completion ||
      !primary ||
      request.payload?.operationId !== completion.payload?.operationId ||
      !Number.isSafeInteger(request.seq) ||
      !Number.isSafeInteger(primary.seq) ||
      !Number.isSafeInteger(completion.seq) ||
      !(request.seq < primary.seq && primary.seq < completion.seq) ||
      (nextRequest && !(completion.seq < nextRequest.seq))
    ) addFailure(`${failurePrefix}remote-side-effect-audit-order-invalid`);
  }
}

function assertRendererTerminalState(state, expected, actions, addFailure, prefix) {
  if (!state || typeof state !== "object") {
    addFailure(`${prefix}-missing`);
    return;
  }
  if (
    state.session?.title !== candidateDeliveryFixture.sessionTitle ||
    state.session?.activeSidebarTitle !== candidateDeliveryFixture.sessionTitle ||
    state.session?.mode !== "fast"
  ) addFailure(`${prefix}-session-invalid`);
  const lanes = Array.isArray(state.lanes) ? state.lanes : [];
  for (const laneId of [
    expected.implementationLaneId,
    expected.validationLaneId,
    expected.reviewLaneId,
    expected.commitLaneId,
    expected.pullRequestLaneId,
  ]) {
    if (lanes.find((lane) => lane?.id === laneId)?.status !== "completed") {
      addFailure(`${prefix}-lineage-lane-invalid`);
    }
  }
  const delivery = state.delivery;
  if (
    delivery?.sessionId !== expected.sessionId ||
    delivery?.commitLaneId !== expected.commitLaneId ||
    delivery?.pullRequestLaneId !== expected.pullRequestLaneId ||
    delivery?.commitSha !== actions.commit?.commitSha ||
    delivery?.pullRequestHeadSha !== actions.commit?.commitSha ||
    delivery?.checksExpectedHeadSha !== actions.commit?.commitSha ||
    delivery?.branch !== expected.branch ||
    delivery?.prNumber !== actions.pullRequest?.number ||
    delivery?.prUrl !== actions.pullRequest?.url ||
    delivery?.checksStatus !== "passing"
  ) addFailure(`${prefix}-delivery-facts-invalid`);
  if (
    state.gates?.["Squash merge"] !== "done" ||
    state.gates?.["Sync main"] !== "done" ||
    state.gates?.Cleanup !== "blocked" ||
    state.cleanup !== "Waiting"
  ) addFailure(`${prefix}-delivery-gates-invalid`);
}

export async function cleanupCandidateDeliveryResources({
  state,
  run = runCommand,
  remove = rm,
}) {
  const audit = cleanupAudit(state);
  const hasLocalState = Boolean(audit.tempRoot || audit.worktreeCreated || audit.localBranchCreated);
  const hasRemoteState = Boolean(audit.remoteBranchCreated || audit.pr);
  if (!hasLocalState && !hasRemoteState) {
    return publicCleanupResult(audit, {
      status: "not-required",
      prClosed: false,
      remoteBranchDeleted: false,
      localBranchDeleted: false,
      localStateRemoved: false,
    });
  }
  if (!audit.repoRoot && audit.tempRoot && !hasRemoteState) {
    try {
      await assertStandaloneTempRoot(audit.tempRoot);
      await remove(audit.tempRoot, { recursive: true, force: true });
      return publicCleanupResult(audit, {
        status: "cleaned",
        prClosed: false,
        remoteBranchDeleted: false,
        localBranchDeleted: false,
        localStateRemoved: true,
      });
    } catch (error) {
      return publicCleanupResult(audit, {
        status: "cleanup-failed",
        prClosed: false,
        remoteBranchDeleted: false,
        localBranchDeleted: false,
        localStateRemoved: false,
        message: safeErrorMessage(error, cleanupPathRoots(audit)),
      });
    }
  }

  let remoteBranchDeleted = false;
  let localBranchDeleted = false;
  let localStateRemoved = false;
  try {
    assertCleanupPaths(audit);
    if (audit.remoteEvidenceUncertain || (hasRemoteState && audit.pr?.state !== "MERGED")) {
      return publicCleanupResult(audit, {
        status: "evidence-retained",
        prClosed: false,
        remoteBranchDeleted: false,
        localBranchDeleted: false,
        localStateRemoved: false,
        message: "Remote delivery evidence was not a completed MERGED pull request; local and remote state were retained.",
      });
    }
    if (audit.pr) assertMergedPullRequestAuditTarget(audit);
    if (audit.remoteBranchCreated) {
      assertRepoName(audit.repo);
      assertSmokeBranch(audit.branch);
      assertRemoteName(audit.remote);
      if (!isFullCommitSha(audit.headSha)) throw new Error("Cleanup requires the exact candidate head SHA.");
      const remoteHead = await readRemoteBranchHead({
        run,
        cwd: audit.candidateWorktreePath ?? audit.repoRoot,
        remote: audit.remote,
        branch: audit.branch,
      });
      if (remoteHead !== null && remoteHead !== audit.headSha) {
        throw new Error("Refusing cleanup because the remote smoke branch is not the exact audited candidate head.");
      }
      if (remoteHead === audit.headSha) {
        await capture(run, "git", [
          "push",
          `--force-with-lease=refs/heads/${audit.branch}:${audit.headSha}`,
          audit.remote,
          `:refs/heads/${audit.branch}`,
        ], { cwd: audit.candidateWorktreePath ?? audit.repoRoot });
        const remaining = await readRemoteBranchHead({
          run,
          cwd: audit.candidateWorktreePath ?? audit.repoRoot,
          remote: audit.remote,
          branch: audit.branch,
        });
        if (remaining !== null) throw new Error("Remote smoke branch deletion could not be verified.");
        remoteBranchDeleted = true;
      }
    }
    if (audit.worktreeCreated && audit.candidateWorktreePath) {
      await capture(run, "git", [
        "worktree",
        "remove",
        "--force",
        "--",
        audit.candidateWorktreePath,
      ], { cwd: audit.repoRoot });
    }
    if (audit.localBranchCreated) {
      await capture(run, "git", [
        "update-ref",
        "-d",
        `refs/heads/${audit.branch}`,
        audit.headSha,
      ], { cwd: audit.repoRoot });
      localBranchDeleted = true;
    }
    if (audit.tempRoot) {
      await remove(audit.tempRoot, { recursive: true, force: true });
      localStateRemoved = true;
    }
    return publicCleanupResult(audit, {
      status: "cleaned",
      prClosed: false,
      remoteBranchDeleted,
      localBranchDeleted,
      localStateRemoved,
    });
  } catch (error) {
    return publicCleanupResult(audit, {
      status: "cleanup-failed",
      prClosed: false,
      remoteBranchDeleted,
      localBranchDeleted,
      localStateRemoved,
      message: safeErrorMessage(error, cleanupPathRoots(audit)),
    });
  }
}

export async function seedCandidateDeliveryStore(config) {
  const { createWorkflowStore } = await import("@skyturn/persistence/workflow-store");
  const {
    createGitChangesetService,
    createLiveWorkflowGitAncestryProofContext,
    createWorkflowGitAncestryProof,
    verifyWorkflowGitAncestryProof,
  } = await import("@skyturn/git-worktree/node");
  const {
    canonicalWorkflowCandidateManifestJson,
    resolveWorkflowDeliveryCandidateIdentity,
  } = await import("@skyturn/project-core");
  const { resolveLaneCandidateBinding } = await import("@skyturn/workflow-kernel");
  const store = createWorkflowStore({ projectRoot: config.projectRoot });
  const now = "2026-08-18T00:00:00.000Z";
  try {
    store.createWorkflowSession({
      id: candidateDeliveryFixture.sessionId,
      projectId: candidateDeliveryFixture.projectId,
      title: candidateDeliveryFixture.sessionTitle,
      goal: "Prove Commit, Push, Create PR, Checks, Squash Merge, and Sync Main as separate delivery actions.",
      mode: "fast",
      target: {
        executionTarget: "new_worktree",
        selectedBranch: "main",
        baseRef: "origin/main",
      },
      plannerProfile: "default",
      transport: "hermes_replay_recovery",
      recoveryReason: "Acceptance deterministically seeds current candidate publication prerequisites.",
      now,
    });

    const lanes = [
      {
        id: candidateDeliveryFixture.implementationLaneId,
        semanticKey: "delivery:candidate-implementation",
        kind: "implementation",
        title: "Prepare exact candidate marker",
        brief: "Production-shaped completed implementation prerequisite.",
        agentKind: "codex",
        executable: true,
        status: "pending",
        requiredEvidence: [],
        fileScopes: [config.markerFile],
        packageScopes: [],
      },
      {
        id: candidateDeliveryFixture.validationLaneId,
        semanticKey: "delivery:candidate-validation",
        kind: "validation",
        title: "Validate exact candidate marker",
        brief: "Production-shaped completed validation prerequisite.",
        agentKind: "codex",
        executable: false,
        status: "completed",
        requiredEvidence: [],
        fileScopes: [],
        packageScopes: [],
      },
      {
        id: candidateDeliveryFixture.reviewLaneId,
        semanticKey: "delivery:candidate-lineage-review",
        kind: "review",
        title: "Record candidate review lineage",
        brief: "Completed lineage gate; the isolated candidate reviewer runs during Commit.",
        agentKind: "hermes",
        executable: false,
        status: "completed",
        requiredEvidence: [],
        fileScopes: [],
        packageScopes: [],
      },
      {
        id: candidateDeliveryFixture.commitLaneId,
        semanticKey: "delivery:candidate-commit",
        kind: "commit",
        title: "Commit reviewed candidate",
        brief: "Publish only the immutable candidate manifest allowed by isolated Hermes review.",
        agentKind: "codex",
        executable: false,
        status: "pending",
        requiredEvidence: [],
        fileScopes: [config.markerFile],
        packageScopes: [],
      },
      {
        id: candidateDeliveryFixture.pullRequestLaneId,
        semanticKey: "delivery:candidate-pull-request",
        kind: "pull_request",
        title: "Deliver candidate pull request",
        brief: "Run explicit remote delivery actions without automatic cleanup.",
        agentKind: "codex",
        executable: false,
        status: "pending",
        requiredEvidence: [],
        fileScopes: [],
        packageScopes: [],
      },
    ];
    for (const [index, lane] of lanes.entries()) {
      store.appendWorkflowEvent({
        sessionId: candidateDeliveryFixture.sessionId,
        kind: "workflow.lane.declared",
        source: "candidate-delivery-acceptance",
        laneId: lane.id,
        idempotencyKey: `candidate-delivery:lane:${lane.id}`,
        payload: { lane },
        now: `2026-08-18T00:00:0${index + 1}.000Z`,
      });
    }
    const edges = [
      [candidateDeliveryFixture.implementationLaneId, candidateDeliveryFixture.validationLaneId],
      [candidateDeliveryFixture.validationLaneId, candidateDeliveryFixture.reviewLaneId],
      [candidateDeliveryFixture.reviewLaneId, candidateDeliveryFixture.commitLaneId],
      [candidateDeliveryFixture.commitLaneId, candidateDeliveryFixture.pullRequestLaneId],
    ];
    for (const [index, [sourceLaneId, targetLaneId]] of edges.entries()) {
      store.appendWorkflowEvent({
        sessionId: candidateDeliveryFixture.sessionId,
        kind: "workflow.edge.declared",
        source: "candidate-delivery-acceptance",
        idempotencyKey: `candidate-delivery:edge:${index + 1}`,
        payload: {
          edge: {
            id: `edge-candidate-delivery-${index + 1}`,
            sourceLaneId,
            targetLaneId,
          },
        },
        now: `2026-08-18T00:00:0${index + 6}.000Z`,
      });
    }

    const scheduled = store.scheduleReadyLanes(candidateDeliveryFixture.sessionId, {
      allowedParallelism: 1,
      authorizedLaneIds: [candidateDeliveryFixture.implementationLaneId],
      now: "2026-08-18T00:00:10.000Z",
    });
    if (
      scheduled.readyLanes.length !== 1 ||
      scheduled.readyLanes[0]?.id !== candidateDeliveryFixture.implementationLaneId
    ) {
      throw new Error("Candidate implementation prerequisite was not scheduled exactly once.");
    }
    const segment = scheduled.readyLanes[0];
    if (
      config.worktree?.worktreeId !== candidateDeliveryFixture.worktreeId ||
      config.worktree?.variantId !== candidateDeliveryFixture.variantId ||
      config.worktree?.parentLaneId !== candidateDeliveryFixture.implementationLaneId
    ) {
      throw new Error("Candidate managed worktree identity is invalid.");
    }
    store.appendWorkflowEvent({
      sessionId: candidateDeliveryFixture.sessionId,
      kind: "workflow.worktree.created",
      source: "git-worktree",
      idempotencyKey: `worktree:${candidateDeliveryFixture.worktreeId}:created`,
      payload: { worktree: config.worktree },
      now: "2026-08-18T00:00:11.000Z",
    });

    for (const laneId of [
      candidateDeliveryFixture.validationLaneId,
      candidateDeliveryFixture.reviewLaneId,
      candidateDeliveryFixture.commitLaneId,
      candidateDeliveryFixture.pullRequestLaneId,
    ]) {
      const resolution = resolveLaneCandidateBinding(
        store.materializeFlowProjection(candidateDeliveryFixture.sessionId),
        laneId,
      );
      if (resolution.status !== "bound") throw new Error(`Candidate lane binding is unavailable: ${laneId}.`);
      store.appendWorkflowEvent({
        sessionId: candidateDeliveryFixture.sessionId,
        kind: "workflow.lane.candidate_bound",
        source: "candidate-delivery-acceptance",
        laneId,
        idempotencyKey: `candidate-binding:${laneId}:bound`,
        payload: { binding: resolution.binding },
        now: "2026-08-18T00:00:11.500Z",
      });
    }

    const checkpointBase = {
      sessionId: candidateDeliveryFixture.sessionId,
      nodeId: candidateDeliveryFixture.implementationLaneId,
      laneId: candidateDeliveryFixture.implementationLaneId,
      segmentId: segment.segmentId,
      runId: segment.runId,
      executionTarget: "new_worktree",
      worktreeId: candidateDeliveryFixture.worktreeId,
      worktreePath: config.candidateWorktreePath,
      branchName: config.branch,
    };
    store.recordRunCheckpoint({
      ...checkpointBase,
      phase: "before",
      headCommit: config.baseHead,
      worktreeState: "clean",
      evidenceRefs: [{ kind: "run", id: segment.runId }],
      now: "2026-08-18T00:00:12.000Z",
    });

    const changesetId = `changeset:${segment.runId}:candidate`;
    const changesetService = createGitChangesetService({
      repoRoot: config.projectRoot,
      maxPatchPreviewBytes: 1,
    });
    const changesetEvidence = await changesetService.collectChangesetEvidence({
      node: {
        id: candidateDeliveryFixture.implementationLaneId,
        changesetId,
        worktree: { path: config.candidateWorktreePath },
      },
    });
    if (
      changesetEvidence.status !== "available" ||
      !arrayEquals(changesetEvidence.files, [config.markerFile]) ||
      !isDigest(changesetEvidence.fullPatchSha256) ||
      !Number.isSafeInteger(changesetEvidence.fullPatchByteLength) ||
      changesetEvidence.fullPatchByteLength <= 0 ||
      !isDigest(changesetEvidence.fileManifestSha256)
    ) {
      throw new Error("Candidate changeset prerequisite is not complete exact Git evidence.");
    }
    const runEvidence = {
      runId: segment.runId,
      status: "succeeded",
      exitCode: 0,
      changesetId,
      checks: [{
        kind: "test",
        name: "Deterministic candidate marker",
        status: "passed",
        detail: "The exact marker bytes were staged before candidate manifest freeze.",
      }],
      artifacts: [],
      review: null,
      errorReason: null,
      cancelReason: null,
      completedAt: "2026-08-18T00:00:13.000Z",
    };
    store.recordRunResult({
      sessionId: candidateDeliveryFixture.sessionId,
      laneId: candidateDeliveryFixture.implementationLaneId,
      segmentId: segment.segmentId,
      runId: segment.runId,
      agentKind: "codex",
      outputSummary: `Candidate marker ${config.markerFile} is ready for immutable publication.`,
      evidence: runEvidence,
      now: runEvidence.completedAt,
    });
    store.appendWorkflowEvent({
      sessionId: candidateDeliveryFixture.sessionId,
      kind: "workflow.changeset.evidence_recorded",
      source: "backend",
      laneId: candidateDeliveryFixture.implementationLaneId,
      segmentId: segment.segmentId,
      idempotencyKey: `checkpoint-changeset:${segment.runId}:after`,
      payload: {
        laneId: candidateDeliveryFixture.implementationLaneId,
        segmentId: segment.segmentId,
        baselineHeadCommit: config.baseHead,
        evidence: changesetEvidence,
      },
      now: "2026-08-18T00:00:14.000Z",
    });

    const ancestryInput = {
      repositoryPath: config.projectRoot,
      worktreePath: config.candidateWorktreePath,
      beforeHeadCommit: config.baseHead,
      afterHeadCommit: config.baseHead,
    };
    const ancestryProof = await createWorkflowGitAncestryProof(ancestryInput);
    const ancestryProofContext = await createLiveWorkflowGitAncestryProofContext(ancestryInput);
    await verifyWorkflowGitAncestryProof(ancestryProof, ancestryInput);
    store.recordRunCheckpoint({
      ...checkpointBase,
      phase: "after",
      headCommit: config.baseHead,
      worktreeState: "dirty",
      ancestryProof,
      ancestryProofContext,
      evidenceRefs: [
        { kind: "run", id: segment.runId },
        { kind: "segment", id: segment.segmentId },
        { kind: "evidence", id: `evidence-${segment.segmentId}` },
        { kind: "changeset", id: changesetEvidence.evidenceId },
      ],
      now: "2026-08-18T00:00:15.000Z",
    });

    const identity = {
      sessionId: candidateDeliveryFixture.sessionId,
      nodeId: candidateDeliveryFixture.implementationLaneId,
      laneId: candidateDeliveryFixture.implementationLaneId,
      segmentId: segment.segmentId,
      runId: segment.runId,
    };
    const manifest = store.freezeCandidateManifest({
      ...identity,
      now: "2026-08-18T00:00:16.000Z",
    });
    const manifestSha256 = sha256(canonicalWorkflowCandidateManifestJson(manifest));
    const projection = store.materializeFlowProjection(candidateDeliveryFixture.sessionId);
    const deliveryIdentity = resolveWorkflowDeliveryCandidateIdentity(
      projection,
      candidateDeliveryFixture.sessionId,
      candidateDeliveryFixture.commitLaneId,
    );
    const { agentKind, ...manifestIdentity } = deliveryIdentity;
    if (agentKind !== "codex" || stableJson(manifestIdentity) !== stableJson(identity)) {
      throw new Error("Delivery commit lineage does not resolve to the immutable implementation candidate.");
    }
    const canvasSession = store.materializeCanvasSession(candidateDeliveryFixture.sessionId);
    assertSeededCandidateAuthority({
      projection,
      canvasSession,
      segment,
      manifest,
      manifestSha256,
      changesetEvidence,
      config,
    });
    const workspace = candidateWorkspaceState({
      projectRoot: config.projectRoot,
      candidateWorktreePath: config.candidateWorktreePath,
      canvasSession,
      segment,
      runEvidence,
      openedAt: now,
    });
    await mkdir(dirname(config.workspacePath), { recursive: true });
    await writeFile(config.workspacePath, `${JSON.stringify(workspace, null, 2)}\n`, "utf8");
    return {
      identity,
      manifest,
      manifestSha256,
      changesetEvidence,
      projection,
      canvasSession,
      segment,
      workspace,
    };
  } finally {
    store.close();
  }
}

export async function inspectCandidateDeliveryStore(config) {
  const { createWorkflowStore } = await import("@skyturn/persistence/workflow-store");
  const { canonicalWorkflowCandidateManifestJson } = await import("@skyturn/project-core");
  const store = createWorkflowStore({ projectRoot: config.projectRoot });
  try {
    const projection = store.materializeFlowProjection(candidateDeliveryFixture.sessionId);
    const canvasSession = store.materializeCanvasSession(candidateDeliveryFixture.sessionId);
    const events = store.listEvents(candidateDeliveryFixture.sessionId);
    const manifest = config.identity ? store.getCandidateManifest(config.identity) : null;
    const manifestSha256 = manifest ? sha256(canonicalWorkflowCandidateManifestJson(manifest)) : null;
    const reviewDecision = manifest && config.identity
      ? store.getCandidateReviewAllowed({ ...config.identity, manifestSha256 })
      : null;
    return {
      projection,
      canvasSession,
      events,
      manifest,
      manifestSha256,
      reviewDecision,
    };
  } finally {
    store.close();
  }
}

export async function restoreCandidateDeliveryWorkspace({ workspacePath, workspace }) {
  if (!isAbsolute(workspacePath)) throw new Error("Candidate delivery workspace path must be absolute.");
  assertOriginalCandidateDeliveryWorkspace(workspace);
  const parent = dirname(workspacePath);
  const temporary = join(
    parent,
    `${basename(workspacePath)}.${process.pid}.${randomUUID()}.tmp`,
  );
  await mkdir(parent, { recursive: true, mode: 0o700 });
  let handle = null;
  let renamed = false;
  try {
    handle = await open(temporary, "wx", 0o600);
    await handle.writeFile(`${JSON.stringify(workspace, null, 2)}\n`, "utf8");
    await handle.sync();
    await handle.close();
    handle = null;
    await rename(temporary, workspacePath);
    renamed = true;
    await syncCandidateDeliveryWorkspaceDirectory(parent);
  } catch (error) {
    if (handle) await handle.close().catch(() => {});
    if (!renamed) await rm(temporary, { force: true }).catch(() => {});
    throw error;
  }
}

function assertOriginalCandidateDeliveryWorkspace(workspace) {
  if (!isObjectRecord(workspace)) throw new Error("Original candidate delivery workspace is invalid.");
  const projects = Array.isArray(workspace.projects) ? workspace.projects : [];
  const sessions = Array.isArray(workspace.sessions) ? workspace.sessions : [];
  const project = projects[0];
  const session = sessions[0];
  const laneSpecs = candidateDeliveryLaneSpecs(candidateDeliveryFixture);
  if (
    projects.length !== 1 ||
    project?.id !== candidateDeliveryFixture.projectId ||
    sessions.length !== 1 ||
    session?.id !== candidateDeliveryFixture.sessionId ||
    session?.projectId !== candidateDeliveryFixture.projectId ||
    workspace.activeProjectId !== candidateDeliveryFixture.projectId ||
    workspace.activeSessionId !== candidateDeliveryFixture.sessionId ||
    !isObjectRecord(workspace.runs) ||
    !isObjectRecord(workspace.runEvents) ||
    !isObjectRecord(workspace.runEvidence)
  ) throw new Error("Original candidate delivery workspace is invalid.");
  const nodes = Array.isArray(session.nodes) ? session.nodes : [];
  for (const [laneId, laneKind] of laneSpecs) {
    const matches = nodes.filter((node) => node?.id === laneId);
    if (matches.length !== 1 || matches[0]?.laneKind !== laneKind) {
      throw new Error("Original candidate delivery workspace is invalid.");
    }
  }
}

async function syncCandidateDeliveryWorkspaceDirectory(parent) {
  if (process.platform === "win32") return;
  const handle = await open(parent, "r");
  try {
    await handle.sync();
  } finally {
    await handle.close();
  }
}

export async function runCandidateDeliveryAcceptance(options = {}) {
  const env = options.env ?? process.env;
  const write = options.write ?? ((line) => console.log(line));
  let input;
  try {
    input = parseCandidateDeliveryAcceptanceInput(env, {
      now: options.now,
      randomHex: options.randomHex,
    });
  } catch (error) {
    const failure = normalizedFailure("input", error);
    const result = { ok: false, status: "failed", failure };
    write(JSON.stringify(result, null, 2));
    return result;
  }
  if (!input.enabled) {
    write(`SKIPPED: ${input.reason}`);
    return { status: "skipped", reason: input.reason };
  }

  const services = options.services ?? {};
  const run = services.run ?? runCommand;
  const cwd = options.cwd ?? process.cwd();
  const state = {
    repo: input.repo,
    repoRoot: null,
    baseBranch: input.baseBranch,
    baseHead: null,
    remote: input.remote,
    branch: input.branch,
    headSha: null,
    mergeSha: null,
    pr: null,
    remoteBranchCreated: false,
    remoteEvidenceUncertain: false,
    localBranchCreated: false,
    worktreeCreated: false,
    candidateWorktreePath: null,
    userDataPath: null,
    tempRoot: null,
    workflowId: null,
  };
  let stage = "checkout";
  let app = null;
  let cdp = null;
  let actions = null;
  let seeded = null;
  let originalSeededWorkspace = null;
  let rendererState = null;
  let reopenedRendererState = null;
  let persistedState = null;
  let reopenedPersistedState = null;
  let finalRemote = null;
  let oracle = null;
  let failure = null;
  let closeResult = null;
  let reviewObservation = null;
  const restoreCommitIdentity = installCommitIdentityDefaults(env);

  try {
    const deadline = Date.now() + Math.max(input.checkTimeoutMs + 5 * 60_000, 15 * 60_000);
    stage = "local-setup";
    const makeTempRoot = services.makeTempRoot ?? (() =>
      mkdtemp(join(tmpdir(), "skyturn-candidate-delivery-")));
    state.tempRoot = await realpath(await makeTempRoot());
    assertIsolatedTempRoot(state.tempRoot, cwd);
    state.userDataPath = join(state.tempRoot, "user-data");
    await mkdir(state.userDataPath, { recursive: true });

    stage = "preflight";
    const preflight = await (services.preflight ?? preflightCandidateDeliveryAcceptance)({
      cwd,
      input,
      run,
      repoRoot: join(state.tempRoot, "project"),
    });
    state.repoRoot = preflight.repoRoot;
    state.baseHead = preflight.baseHead;
    state.headSha = preflight.baseHead;
    state.workflowId = preflight.workflow?.id ?? null;

    stage = "checkout";
    await (services.prepareCheckout ?? prepareCandidateReviewCommitCheckout)({ deadline });

    stage = "candidate-worktree";
    state.candidateWorktreePath = join(`${state.repoRoot}.worktrees`, input.smokeId);
    const worktree = await (services.createCandidateWorktree ?? createCandidateWorktree)({
      repoRoot: state.repoRoot,
      candidateWorktreePath: state.candidateWorktreePath,
      branch: state.branch,
      baseHead: state.baseHead,
      run,
      onCreated(created) {
        state.localBranchCreated = created.localBranchCreated === true;
        state.worktreeCreated = created.worktreeCreated === true;
      },
    });
    state.localBranchCreated = true;
    state.worktreeCreated = true;

    stage = "candidate-fixture";
    await (services.writeMarker ?? writeCandidateMarker)({
      candidateWorktreePath: state.candidateWorktreePath,
      markerFile: input.markerFile,
      repo: input.repo,
      baseBranch: input.baseBranch,
      branch: input.branch,
      run,
    });
    await assertConcreteCandidateChange({
      run,
      candidateWorktreePath: state.candidateWorktreePath,
      markerFile: input.markerFile,
    });

    stage = "seed";
    const workspacePath = join(state.userDataPath, "workspace.json");
    seeded = await (services.seed ?? runElectronNodeMode)("--seed", {
      projectRoot: state.repoRoot,
      candidateWorktreePath: state.candidateWorktreePath,
      workspacePath,
      baseHead: state.baseHead,
      branch: state.branch,
      markerFile: input.markerFile,
      worktree,
    }, run);
    if (
      seeded?.canvasSession?.id !== candidateDeliveryFixture.sessionId ||
      seeded?.manifest?.branchName !== state.branch ||
      !isDigest(seeded?.manifestSha256)
    ) throw new Error("Candidate delivery seed did not freeze the exact managed candidate manifest.");
    assertOriginalCandidateDeliveryWorkspace(seeded.workspace);
    originalSeededWorkspace = structuredClone(seeded.workspace);

    stage = "electron-launch";
    ({ app, cdp } = await launchAndConnect({ services, userDataPath: state.userDataPath, projectRoot: state.repoRoot }));

    stage = "public-actions";
    const actionInput = {
      projectRoot: state.repoRoot,
      sessionId: candidateDeliveryFixture.sessionId,
      commitLaneId: candidateDeliveryFixture.commitLaneId,
      pullRequestLaneId: candidateDeliveryFixture.pullRequestLaneId,
      worktreePath: state.candidateWorktreePath,
      markerFile: input.markerFile,
      branch: state.branch,
      baseBranch: state.baseBranch,
      remote: state.remote,
      repo: state.repo,
      checkName: input.checkName,
      workflowId: state.workflowId,
      workflowPath: input.workflowPath,
      expectedReviewStatus: input.expectedReviewStatus,
      title: CANDIDATE_DELIVERY_PR_TITLE,
      body: CANDIDATE_DELIVERY_COMMIT_BODY,
      whatChanged: `Added disposable marker ${input.markerFile}.`,
      why: "Verify all explicit SkyTurn delivery actions against one exact candidate.",
      breakingChanges: "None.",
      serverPr: "None.",
      maxCheckAttempts: input.maxCheckAttempts,
      pollIntervalMs: input.pollIntervalMs,
      rendererRequestTimeoutMs: input.checkTimeoutMs + 2 * 60_000,
      waitForGate: services.waitForGate ?? ((gateInput) => waitForCandidatePullRequestGate({
        ...gateInput,
        run,
        attempts: input.maxCheckAttempts,
        intervalMs: input.pollIntervalMs,
      })),
      captureState: services.captureState ?? (async ({ completedAction, actions: currentActions }) => {
        const boundary = await captureCandidateDeliveryBoundary({
          completedAction,
          actions: currentActions,
          projectRoot: state.repoRoot,
          candidateWorktreePath: state.candidateWorktreePath,
          repo: state.repo,
          remote: state.remote,
          baseBranch: state.baseBranch,
          branch: state.branch,
          identity: seeded.identity,
          run,
          attempts: input.maxCheckAttempts,
          intervalMs: input.pollIntervalMs,
        });
        state.remoteBranchCreated = boundary.remote.remoteBranchHead !== null;
        if (boundary.remote.pullRequest) state.pr = boundary.remote.pullRequest;
        if (isFullCommitSha(boundary.remote.pullRequest?.mergeCommitOid)) {
          state.mergeSha = boundary.remote.pullRequest.mergeCommitOid;
        }
        return boundary;
      }),
    };
    const invoked = await (services.invokeActions ?? invokeCandidateDeliveryThroughRenderer)(cdp, actionInput);
    actions = invoked.actions ?? invoked;
    reviewObservation = invoked.reviewObservation ?? null;
    applyActionProgressToState(state, actions);
    if (actions?.ok !== true) {
      stage = actions?.failure?.stage ?? stage;
      throw new Error(`${actions?.failure?.code ?? "PUBLIC_DELIVERY_FAILED"}: ${actions?.failure?.message ?? "Public delivery action failed."}`);
    }

    stage = "renderer-before-close";
    rendererState = await (services.readRendererState ?? readRendererDeliveryState)(
      cdp,
      rendererDeliveryExpectation(state, actions),
    );
  } catch (error) {
    failure = normalizedFailure(
      stage,
      error,
      { actions: publicActionEvidence(actions), state: publicStateEvidence(state) },
      candidateDeliverySensitivePaths(state, cwd),
    );
  } finally {
    restoreCommitIdentity();
    if (app || cdp) {
      closeResult = await closeAcceptanceApp({ services, app, cdp, failure });
      app = null;
      cdp = null;
      if (closeResult?.ok !== true && !failure) {
        failure = normalizedFailure(
          "electron-close",
          new Error(closeResult?.diagnostic ?? "Electron close failed."),
          null,
          candidateDeliverySensitivePaths(state, cwd),
        );
      }
    }
  }

  if (!failure && state.repoRoot && seeded) {
    try {
      stage = "sqlite-reopen";
      persistedState = await (services.inspect ?? runElectronNodeMode)("--inspect", {
        projectRoot: state.repoRoot,
        identity: seeded.identity,
      }, run);
      stage = "workspace-reset-before-relaunch";
      await (services.restoreWorkspace ?? restoreCandidateDeliveryWorkspace)({
        workspacePath: join(state.userDataPath, "workspace.json"),
        workspace: originalSeededWorkspace,
      });
      stage = "electron-relaunch";
      ({ app, cdp } = await launchAndConnect({ services, userDataPath: state.userDataPath, projectRoot: state.repoRoot }));
      reopenedRendererState = await (services.readRendererState ?? readRendererDeliveryState)(
        cdp,
        rendererDeliveryExpectation(state, actions),
      );
    } catch (error) {
      failure = normalizedFailure(
        stage,
        error,
        {
          actions: publicActionEvidence(actions),
          persisted: Boolean(persistedState?.manifest),
          manifestSha256: persistedState?.manifestSha256 ?? null,
        },
        candidateDeliverySensitivePaths(state, cwd),
      );
    } finally {
      if (app || cdp) {
        closeResult = await closeAcceptanceApp({ services, app, cdp, failure });
        app = null;
        cdp = null;
        if (closeResult?.ok !== true && !failure) {
          failure = normalizedFailure(
            "electron-relaunch-close",
            new Error(closeResult?.diagnostic ?? "Reopened Electron close failed."),
            null,
            candidateDeliverySensitivePaths(state, cwd),
          );
        }
      }
    }
  }

  if (!failure && state.repoRoot && seeded) {
    try {
      stage = "sqlite-reopen-after-renderer";
      reopenedPersistedState = await (services.inspect ?? runElectronNodeMode)("--inspect", {
        projectRoot: state.repoRoot,
        identity: seeded.identity,
      }, run);
      stage = "final-git-github-oracle";
      finalRemote = await (services.auditRemote ?? auditCandidateRemoteState)({
        run,
        repo: state.repo,
        repoRoot: state.repoRoot,
        candidateWorktreePath: state.candidateWorktreePath,
        remote: state.remote,
        baseBranch: state.baseBranch,
        branch: state.branch,
        knownPrNumber: actions.pullRequest.number,
      });
      state.pr = finalRemote.pullRequest;
      state.mergeSha = finalRemote.pullRequest?.mergeCommitOid ?? state.mergeSha;
      stage = "oracle";
      oracle = candidateDeliveryOracle({
        expected: {
          ...candidateDeliveryFixture,
          branch: state.branch,
          baseBranch: state.baseBranch,
          remote: state.remote,
          checkName: input.checkName,
          workflowId: state.workflowId,
          workflowPath: input.workflowPath,
          expectedReviewStatus: input.expectedReviewStatus,
          baseHead: state.baseHead,
          manifestSha256: seeded.manifestSha256,
        },
        actions,
        boundaries: actions.boundaries,
        seededManifestSha256: seeded.manifestSha256,
        rendererState,
        reopenedRendererState,
        persistedState,
        reopenedPersistedState,
        finalRemote,
        reviewObservation,
      });
      if (!oracle.ok) throw new Error(`Acceptance predicates failed: ${oracle.failures.join(", ")}.`);
    } catch (error) {
      failure = normalizedFailure(
        stage,
        error,
        { actions: publicActionEvidence(actions), oracle, finalRemote },
        candidateDeliverySensitivePaths(state, cwd),
      );
    }
  }

  if (
    failure &&
    state.repoRoot &&
    state.worktreeCreated &&
    state.candidateWorktreePath &&
    isFullCommitSha(actions?.commit?.commitSha)
  ) {
    stage = "failure-remote-reconciliation";
    await recoverCandidateDeliveryFailureState({
      state,
      actions,
      audit: services.auditRemote ?? auditCandidateRemoteState,
      auditInput: {
        run,
        repo: state.repo,
        repoRoot: state.repoRoot,
        candidateWorktreePath: state.candidateWorktreePath,
        remote: state.remote,
        baseBranch: state.baseBranch,
        branch: state.branch,
        knownPrNumber: actions?.pullRequest?.number ?? null,
      },
    });
    failure.evidence = sanitizedEvidence({
      prior: failure.evidence,
      recoveredState: publicStateEvidence(state),
      remoteEvidenceUncertain: state.remoteEvidenceUncertain,
    });
  }

  stage = "cleanup";
  const cleanup = await (services.cleanup ?? cleanupCandidateDeliveryResources)({ state, run });
  const redactPaths = candidateDeliverySensitivePaths(state, cwd);
  if (!failure && cleanup.status !== "cleaned" && cleanup.status !== "not-required") {
    failure = normalizedFailure(
      stage,
      new Error(cleanup.message ?? "Post-merge cleanup failed."),
      cleanup,
      redactPaths,
    );
  }

  const result = sanitizedEvidence(candidateDeliveryResult({
    state,
    input,
    actions,
    persistedState,
    reopenedPersistedState,
    oracle,
    cleanup,
    failure,
    reviewObservation,
    closeResult,
    redactPaths,
  }), redactPaths);
  write(JSON.stringify(result, null, 2));
  return result;
}

export async function recoverCandidateDeliveryFailureState({
  state,
  actions,
  audit = auditCandidateRemoteState,
  auditInput = {},
}) {
  if (!isFullCommitSha(actions?.commit?.commitSha)) return state;
  try {
    const remote = await audit(auditInput);
    if (isFullCommitSha(remote?.candidateHead)) state.headSha = remote.candidateHead;
    state.remoteBranchCreated = isFullCommitSha(remote?.remoteBranchHead);
    if (remote?.pullRequest) state.pr = remote.pullRequest;
    if (isFullCommitSha(remote?.pullRequest?.mergeCommitOid)) {
      state.mergeSha = remote.pullRequest.mergeCommitOid;
    }
    state.remoteEvidenceUncertain = false;
    state.failureRemoteAudit = remote;
  } catch (error) {
    state.remoteEvidenceUncertain = true;
    state.failureRemoteAudit = {
      diagnostic: safeErrorMessage(error, candidateDeliverySensitivePaths(state)),
    };
  }
  return state;
}

async function createCandidateWorktree({
  repoRoot,
  candidateWorktreePath,
  branch,
  baseHead,
  run,
  onCreated = () => {},
}) {
  assertSmokeBranch(branch);
  if (!isFullCommitSha(baseHead)) throw new Error("Candidate base must be a full commit SHA.");
  await mkdir(dirname(candidateWorktreePath), { recursive: true });
  try {
    await capture(run, "git", [
      "worktree",
      "add",
      "-b",
      branch,
      "--",
      candidateWorktreePath,
      baseHead,
    ], { cwd: repoRoot });
  } catch (error) {
    const [branchResult, worktreesResult] = await Promise.all([
      tryCapture(run, "git", ["rev-parse", "--verify", `refs/heads/${branch}^{commit}`], { cwd: repoRoot }),
      tryCapture(run, "git", ["worktree", "list", "--porcelain"], { cwd: repoRoot }),
    ]);
    onCreated({
      localBranchCreated: isFullCommitSha(branchResult?.stdout.trim()),
      worktreeCreated: worktreesResult?.stdout.split("\n").includes(`worktree ${candidateWorktreePath}`) === true,
    });
    throw error;
  }
  onCreated({ localBranchCreated: true, worktreeCreated: true });
  const [actualBranch, actualHead, gitdirResult] = await Promise.all([
    capture(run, "git", ["branch", "--show-current"], { cwd: candidateWorktreePath }),
    capture(run, "git", ["rev-parse", "HEAD^{commit}"], { cwd: candidateWorktreePath }),
    capture(run, "git", ["rev-parse", "--absolute-git-dir"], { cwd: candidateWorktreePath }),
  ]);
  if (
    actualBranch.stdout.trim() !== branch ||
    actualHead.stdout.trim().toLowerCase() !== baseHead
  ) throw new Error("Candidate worktree identity does not match its generated branch and base.");
  const realCandidatePath = await realpath(candidateWorktreePath);
  return {
    worktreeId: candidateDeliveryFixture.worktreeId,
    variantId: candidateDeliveryFixture.variantId,
    path: realCandidatePath,
    realPath: realCandidatePath,
    gitdir: await realpath(gitdirResult.stdout.trim()),
    repoRoot: await realpath(repoRoot),
    branchName: branch,
    baseCommit: baseHead,
    headCommit: baseHead,
    parentLaneId: candidateDeliveryFixture.implementationLaneId,
  };
}

async function writeCandidateMarker({
  candidateWorktreePath,
  markerFile,
  repo,
  baseBranch,
  branch,
  run,
}) {
  const markerPath = join(candidateWorktreePath, markerFile);
  await mkdir(dirname(markerPath), { recursive: true });
  await writeFile(markerPath, [
    "# SkyTurn Candidate Delivery Acceptance",
    "",
    `Repository: ${repo}`,
    `Base: ${baseBranch}`,
    `Branch: ${branch}`,
    "",
    "This one-shot marker is published only through the six public SkyTurn delivery actions.",
    "",
  ].join("\n"), "utf8");
  await capture(run, "git", ["add", "--", markerFile], { cwd: candidateWorktreePath });
}

async function assertConcreteCandidateChange({ run, candidateWorktreePath, markerFile }) {
  const [status, staged] = await Promise.all([
    capture(run, "git", [
      "status",
      "--porcelain=v1",
      "--untracked-files=all",
      "--",
      ...volatilePathspecs,
    ], { cwd: candidateWorktreePath }),
    capture(run, "git", ["diff", "--cached", "--name-only", "--", markerFile], { cwd: candidateWorktreePath }),
  ]);
  if (status.stdout.trim() !== `A  ${markerFile}` || staged.stdout.trim() !== markerFile) {
    throw new Error("Candidate fixture must contain one exact staged marker change.");
  }
}

export async function invokeCandidateDeliveryThroughRenderer(cdp, input, services = {}) {
  const rendererRequestTimeoutMs = input.rendererRequestTimeoutMs;
  const observeReview = services.observeReview ?? observeRealHermesReview;
  let reviewObservation = null;
  const workflow = {};
  for (const method of deliveryActionMethods) {
    workflow[method] = async (projectRoot, actionInput) => {
      const invoke = () => cdp.evaluate(
        buildRendererDeliveryActionInvocation(method, projectRoot, actionInput),
        {
          awaitPromise: true,
          returnByValue: true,
          requestTimeoutMs: rendererRequestTimeoutMs,
        },
      );
      if (method !== "createDeliveryCommit") return await invoke();
      const observed = await observeReview(invoke);
      reviewObservation = observed.observation;
      if (
        reviewObservation?.temporaryRootObserved !== true ||
        reviewObservation?.verifierProcessObserved !== true
      ) {
        throw new Error("The real Hermes candidate review was not observed through both its temporary root and verifier process.");
      }
      return observed.value;
    };
  }
  const actions = await runPublicDeliveryActions({ ...input, workflow });
  return { actions, reviewObservation };
}

async function observeRealHermesReview(operation) {
  let active = true;
  let temporaryRootObserved = false;
  let verifierProcessObserved = false;
  const [rootBaseline, processBaseline] = await Promise.all([
    listHermesReviewRoots(),
    listHermesVerifierProcesses(),
  ]);
  const baselineRoots = new Set(rootBaseline);
  const baselineProcesses = new Set(processBaseline);
  const monitor = (async () => {
    while (active) {
      const [roots, processes] = await Promise.all([
        listHermesReviewRoots(),
        listHermesVerifierProcesses(),
      ]);
      if (roots.some((root) => !baselineRoots.has(root))) temporaryRootObserved = true;
      if (processes.some((pid) => !baselineProcesses.has(pid))) verifierProcessObserved = true;
      if (active) await delay(50);
    }
  })();
  let value;
  try {
    value = await operation();
  } finally {
    active = false;
    await monitor;
  }
  return {
    value,
    observation: { temporaryRootObserved, verifierProcessObserved },
  };
}

async function listHermesReviewRoots() {
  const entries = await readdir(tmpdir(), { withFileTypes: true });
  return entries
    .filter((entry) => entry.isDirectory() && entry.name.startsWith("skyturn-hermes-review-"))
    .map((entry) => entry.name)
    .sort(compareUtf8);
}

async function waitForCandidatePullRequestGate({
  projectRoot,
  repo,
  prNumber,
  expectedHeadSha,
  checkName,
  workflowId,
  workflowPath,
  expectedReviewStatus,
  run = runCommand,
  attempts,
  intervalMs,
  sleep = delay,
}) {
  const { checkDeliveryPullRequest } = await import("@skyturn/git-worktree/node");
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    const [evidence, workflowRuns] = await Promise.all([
      checkDeliveryPullRequest({
        projectRoot,
        prNumber,
        expectedHeadSha,
      }),
      readCandidateWorkflowRuns({
        run,
        cwd: projectRoot,
        repo,
        workflowId,
        workflowPath,
        expectedHeadSha,
      }),
    ]);
    if (evidence.status === "failed") {
      throw new Error("The deterministic exact-head pull request check failed.");
    }
    try {
      assertPassedChecksGate(
        { ...evidence, workflowRuns },
        { number: prNumber },
        expectedHeadSha,
        checkName,
        expectedReviewStatus,
        workflowId,
        workflowPath,
      );
      return { ...evidence, workflowRuns };
    } catch {
      if (attempt === attempts) break;
    }
    await sleep(intervalMs);
  }
  throw new Error("Timed out waiting for the exact-head passed, review-allowed, mergeable OPEN pull request gate.");
}

export async function readCandidateWorkflowRuns({
  run,
  cwd,
  repo,
  workflowId,
  workflowPath,
  expectedHeadSha,
}) {
  assertRepoName(repo);
  if (!Number.isSafeInteger(workflowId) || workflowId <= 0) {
    throw new Error("The configured workflow ID is invalid.");
  }
  if (typeof workflowPath !== "string" || !workflowPath) {
    throw new Error("The configured workflow path is invalid.");
  }
  if (!isFullCommitSha(expectedHeadSha)) throw new Error("The candidate workflow head SHA is invalid.");
  const query = [
    `repos/${repo}/actions/workflows/${workflowId}/runs`,
    `?event=pull_request&head_sha=${expectedHeadSha}&per_page=100`,
  ].join("");
  const response = parseJsonObject((await capture(run, "gh", ["api", query], { cwd })).stdout,
    "GitHub workflow run gate returned invalid JSON.");
  if (!Array.isArray(response.workflow_runs)) {
    throw new Error("GitHub workflow run gate did not return workflow runs.");
  }
  if (
    !Number.isSafeInteger(response.total_count) ||
    response.total_count !== response.workflow_runs.length
  ) {
    throw new Error("GitHub workflow run gate returned incomplete workflow run cardinality.");
  }
  return response.workflow_runs.map((item) => ({
    id: Number(item?.id),
    workflowId: Number(item?.workflow_id),
    path: optionalText(item?.path),
    headSha: optionalText(item?.head_sha)?.toLowerCase() ?? null,
    event: optionalText(item?.event),
    status: optionalText(item?.status),
    conclusion: optionalText(item?.conclusion),
  }));
}

async function captureCandidateDeliveryBoundary({
  completedAction,
  actions,
  projectRoot,
  candidateWorktreePath,
  repo,
  remote,
  baseBranch,
  branch,
  identity,
  run,
  attempts,
  intervalMs,
}) {
  const persisted = await runElectronNodeMode("--inspect", { projectRoot, identity }, run);
  const auditInput = {
    run,
    repo,
    repoRoot: projectRoot,
    candidateWorktreePath,
    remote,
    baseBranch,
    branch,
    knownPrNumber: actions.pullRequest?.number ?? null,
  };
  const remoteState = completedAction === "mergePullRequest"
    ? await waitForMergedRemoteEvidence({ ...auditInput, attempts, intervalMs })
    : await auditCandidateRemoteState(auditInput);
  const remoteSideEffectEventKinds = persisted.events
    .filter((item) => item.kind === "workflow.remote_side_effect.requested")
    .map((item) => item.payload?.eventKind);
  const remoteSideEffectCompletedKinds = persisted.events
    .filter((item) => item.kind === "workflow.remote_side_effect.completed")
    .map((item) => item.payload?.eventKind);
  return {
    completedAction,
    deliveryEventKinds: persisted.events
      .filter((item) => deliveryEventKinds.includes(item.kind))
      .map((item) => item.kind),
    remoteSideEffectEventKinds,
    remoteSideEffectCompletedKinds,
    persisted,
    remote: remoteState,
  };
}

async function waitForMergedRemoteEvidence(input) {
  for (let attempt = 1; attempt <= input.attempts; attempt += 1) {
    const state = await auditCandidateRemoteState(input);
    const mergeSha = state.pullRequest?.mergeCommitOid;
    if (
      state.pullRequest?.state === "MERGED" &&
      isFullCommitSha(mergeSha) &&
      state.remoteMainHead === mergeSha
    ) return state;
    if (attempt < input.attempts) await delay(input.intervalMs);
  }
  throw new Error("Timed out waiting for GitHub to expose the full squash merge commit on remote main.");
}

export async function readRendererDeliveryState(cdp, expected) {
  const value = await cdp.evaluate(`
    (async () => {
      const expected = ${JSON.stringify(expected)};
      const sessionTitle = ${JSON.stringify(candidateDeliveryFixture.sessionTitle)};
      const waitFor = (probe, label) => {
        const deadline = Date.now() + 15000;
        return new Promise((resolve, reject) => {
          const tick = () => {
            let result;
            try { result = probe(); } catch (error) { reject(error); return; }
            if (result) { resolve(result); return; }
            if (Date.now() > deadline) { reject(new Error('Timed out waiting for renderer ' + label)); return; }
            requestAnimationFrame(tick);
          };
          tick();
        });
      };
      const text = (element) => element?.textContent?.trim() ?? null;
      const flowNode = (id) => [...document.querySelectorAll('.react-flow__node')]
        .find((node) => node.getAttribute('data-id') === id) ?? null;
      const lane = (id) => {
        const node = flowNode(id);
        const shell = node?.querySelector('.agent-node-shell');
        return node && shell ? { id, title: text(node.querySelector('.agent-node-title')), status: shell.getAttribute('data-state') } : null;
      };
      const panelFacts = () => {
        const panel = document.querySelector('section.delivery-panel[aria-label="Delivery lifecycle"]');
        if (!panel) return null;
        const entries = [...panel.querySelectorAll('.delivery-facts > div')].map((entry) => [
          text(entry.querySelector('dt')),
          text(entry.querySelector('dd')),
        ]);
        const byLabel = Object.fromEntries(entries);
        const prLink = panel.querySelector('.delivery-facts a[href]');
        const checks = byLabel.Checks?.match(/^(passing|pending|failing) @ ([0-9a-f]{7})$/i);
        const gates = Object.fromEntries([...panel.querySelectorAll('.delivery-gate-item')].map((item) => [
          text(item.querySelector('strong')),
          text(item.querySelector('.delivery-gate-status'))?.toLowerCase(),
        ]));
        return {
          delivery: {
            sessionId: panel.getAttribute('data-delivery-session-id'),
            commitLaneId: panel.getAttribute('data-delivery-commit-lane-id'),
            pullRequestLaneId: panel.getAttribute('data-delivery-pull-request-lane-id'),
            commitSha: panel.getAttribute('data-delivery-commit-sha'),
            pullRequestHeadSha: panel.getAttribute('data-delivery-pull-request-head-sha'),
            checksExpectedHeadSha: panel.getAttribute('data-delivery-checks-expected-head-sha'),
            branch: byLabel.Branch ?? null,
            prNumber: /^#([1-9][0-9]*)$/.test(byLabel.PR ?? '') ? Number(byLabel.PR.slice(1)) : null,
            prUrl: prLink?.href ?? null,
            checksStatus: checks?.[1]?.toLowerCase() ?? null,
          },
          gates,
          cleanup: byLabel.Cleanup ?? null,
        };
      };

      await waitFor(() => {
        const title = text(document.querySelector('.topbar-field[aria-label="Session title"] .title-edit-button'));
        const sidebar = text(document.querySelector('.sidebar-session-row.active .sidebar-session-title'));
        return title === sessionTitle && sidebar === sessionTitle &&
          lane(expected.implementationLaneId) &&
          lane(expected.validationLaneId) &&
          lane(expected.reviewLaneId) &&
          lane(expected.commitLaneId) &&
          lane(expected.pullRequestLaneId);
      }, 'candidate canvas session');

      const commitNode = flowNode(expected.commitLaneId);
      const more = commitNode?.querySelector('button[aria-label^="More details for "]');
      if (!more) throw new Error('Renderer commit lane details control is missing.');
      more.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, view: window }));
      const changesTab = await waitFor(() => [...document.querySelectorAll('.node-modal .modal-tabs button')]
        .find((button) => text(button) === 'Changes'), 'Changes tab');
      changesTab.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, view: window }));

      const facts = await waitFor(() => {
        const current = panelFacts();
        return current &&
          current.delivery.sessionId === expected.sessionId &&
          current.delivery.commitLaneId === expected.commitLaneId &&
          current.delivery.pullRequestLaneId === expected.pullRequestLaneId &&
          current.delivery.commitSha === expected.commitSha &&
          current.delivery.pullRequestHeadSha === expected.commitSha &&
          current.delivery.checksExpectedHeadSha === expected.commitSha &&
          current.delivery.branch === expected.branch &&
          current.delivery.prNumber === expected.prNumber &&
          current.delivery.prUrl === expected.prUrl &&
          current.delivery.checksStatus === 'passing' &&
          current.gates['Squash merge'] === 'done' &&
          current.gates['Sync main'] === 'done' &&
          current.gates.Cleanup === 'blocked' &&
          current.cleanup === 'Waiting'
          ? current
          : null;
      }, 'terminal delivery evidence');

      return {
        session: {
          title: text(document.querySelector('.topbar-field[aria-label="Session title"] .title-edit-button')),
          activeSidebarTitle: text(document.querySelector('.sidebar-session-row.active .sidebar-session-title')),
          mode: text(document.querySelector('.topbar-field[aria-label="Session type"] .session-type-value')),
        },
        lanes: [
          lane(expected.implementationLaneId),
          lane(expected.validationLaneId),
          lane(expected.reviewLaneId),
          lane(expected.commitLaneId),
          lane(expected.pullRequestLaneId),
        ],
        ...facts,
      };
    })()
  `, { awaitPromise: true, returnByValue: true });
  if (!value?.session || !Array.isArray(value?.lanes) || !value?.delivery || !value?.gates) {
    throw new Error("Renderer terminal candidate delivery semantics are unavailable.");
  }
  return value;
}

async function auditCandidateRemoteState({
  run,
  repo,
  repoRoot,
  candidateWorktreePath,
  remote,
  baseBranch,
  branch,
  knownPrNumber,
}) {
  const [
    localBranchResult,
    localMainResult,
    originMainResult,
    remoteMainHead,
    remoteBranchHead,
    candidateHeadResult,
    candidateParentResult,
    candidateTreeResult,
  ] = await Promise.all([
    capture(run, "git", ["branch", "--show-current"], { cwd: repoRoot }),
    capture(run, "git", ["rev-parse", `refs/heads/${baseBranch}^{commit}`], { cwd: repoRoot }),
    capture(run, "git", ["rev-parse", `refs/remotes/${remote}/${baseBranch}^{commit}`], { cwd: repoRoot }),
    readRemoteBranchHead({ run, cwd: repoRoot, remote, branch: baseBranch, required: true }),
    readRemoteBranchHead({ run, cwd: candidateWorktreePath, remote, branch }),
    capture(run, "git", ["rev-parse", "HEAD^{commit}"], { cwd: candidateWorktreePath }),
    capture(run, "git", ["rev-parse", "HEAD^1"], { cwd: candidateWorktreePath }),
    capture(run, "git", ["rev-parse", "HEAD^{tree}"], { cwd: candidateWorktreePath }),
  ]);
  if (localBranchResult.stdout.trim() !== baseBranch) {
    throw new Error("Imported project root no longer remains on main.");
  }
  const localMainHead = localMainResult.stdout.trim().toLowerCase();
  const originMainHead = originMainResult.stdout.trim().toLowerCase();
  const candidateHead = candidateHeadResult.stdout.trim().toLowerCase();
  const candidateParentCommit = candidateParentResult.stdout.trim().toLowerCase();
  const candidateTreeSha = candidateTreeResult.stdout.trim().toLowerCase();
  for (const sha of [localMainHead, originMainHead, remoteMainHead, candidateHead, candidateParentCommit, candidateTreeSha]) {
    if (!isFullCommitSha(sha)) throw new Error("Git delivery audit did not return full commit identities.");
  }

  let pullRequest = null;
  if (knownPrNumber) {
    const value = parseJsonObject((await capture(run, "gh", [
      "pr",
      "view",
      String(knownPrNumber),
      "--repo",
      repo,
      "--json",
      "number,url,headRefName,headRefOid,baseRefName,state,mergeCommit",
    ], { cwd: repoRoot })).stdout, "GitHub pull request audit returned invalid JSON.");
    pullRequest = normalizePullRequestAudit(value);
  } else {
    const values = parseJsonArray((await capture(run, "gh", [
      "pr",
      "list",
      "--repo",
      repo,
      "--head",
      branch,
      "--state",
      "all",
      "--limit",
      "2",
      "--json",
      "number,url,headRefName,headRefOid,baseRefName,state",
    ], { cwd: repoRoot })).stdout, "GitHub pull request list audit returned invalid JSON.");
    if (values.length > 1) throw new Error("Multiple pull requests unexpectedly match the one-shot smoke branch.");
    pullRequest = values.length === 1 ? normalizePullRequestAudit(values[0]) : null;
  }

  let mainParentCommit = null;
  let mainTreeSha = null;
  if (localMainHead === remoteMainHead) {
    const [parents, tree] = await Promise.all([
      capture(run, "git", ["rev-list", "--parents", "-n", "1", localMainHead], { cwd: repoRoot }),
      capture(run, "git", ["rev-parse", `${localMainHead}^{tree}`], { cwd: repoRoot }),
    ]);
    const parentParts = parents.stdout.trim().split(/\s+/);
    mainParentCommit = parentParts.length === 2 ? parentParts[1].toLowerCase() : null;
    mainTreeSha = tree.stdout.trim().toLowerCase();
  }
  return {
    candidateHead,
    candidateParentCommit,
    candidateTreeSha,
    remoteBranchHead,
    localMainHead,
    originMainHead,
    remoteMainHead,
    mainParentCommit,
    mainTreeSha,
    pullRequest,
  };
}

async function runElectronNodeMode(mode, config, run = runCommand) {
  const electronBinary = require("electron");
  const result = await capture(run, electronBinary, [scriptPath, mode, JSON.stringify(config)], {
    cwd: dirname(scriptPath),
    env: { ...process.env, ELECTRON_RUN_AS_NODE: "1" },
  });
  const prefix = mode === "--seed" ? seedResultPrefix : inspectResultPrefix;
  const line = result.stdout.split("\n").find((candidate) => candidate.startsWith(prefix));
  if (!line) throw new Error(`Electron ${mode} did not return a structured candidate delivery result.`);
  return parseJson(line.slice(prefix.length), `Electron ${mode} returned invalid candidate delivery JSON.`);
}

function assertSeededCandidateAuthority({
  projection,
  canvasSession,
  segment,
  manifest,
  manifestSha256,
  changesetEvidence,
  config,
}) {
  if (!projection || !canvasSession) throw new Error("Candidate delivery session did not materialize.");
  const laneById = new Map(projection.lanes.map((lane) => [lane.id, lane]));
  for (const [laneId, laneKind, status] of [
    [candidateDeliveryFixture.implementationLaneId, "implementation", "completed"],
    [candidateDeliveryFixture.validationLaneId, "validation", "completed"],
    [candidateDeliveryFixture.reviewLaneId, "review", "completed"],
    [candidateDeliveryFixture.commitLaneId, "commit", "pending"],
    [candidateDeliveryFixture.pullRequestLaneId, "pull_request", "pending"],
  ]) {
    const lane = laneById.get(laneId);
    if (lane?.laneKind !== laneKind || lane.status !== status) {
      throw new Error(`Seeded candidate lane is invalid: ${laneId}.`);
    }
  }
  if (
    canvasSession.target?.executionTarget !== "new_worktree" ||
    canvasSession.target?.selectedBranch !== "main" ||
    canvasSession.target?.baseRef !== "origin/main"
  ) throw new Error("Seeded candidate target is not the managed main-based worktree contract.");
  const implementationNode = canvasSession.nodes.find((node) => node.id === candidateDeliveryFixture.implementationLaneId);
  const commitNode = canvasSession.nodes.find((node) => node.id === candidateDeliveryFixture.commitLaneId);
  const pullRequestNode = canvasSession.nodes.find((node) => node.id === candidateDeliveryFixture.pullRequestLaneId);
  if (
    implementationNode?.worktree?.worktreeId !== candidateDeliveryFixture.worktreeId ||
    implementationNode?.worktree?.realPath !== config.candidateWorktreePath ||
    implementationNode?.worktree?.branchName !== config.branch ||
    commitNode?.worktree?.worktreeId !== candidateDeliveryFixture.worktreeId ||
    commitNode?.worktree?.realPath !== config.candidateWorktreePath ||
    commitNode?.worktree?.branchName !== config.branch ||
    pullRequestNode?.worktree?.worktreeId !== candidateDeliveryFixture.worktreeId ||
    pullRequestNode?.worktree?.realPath !== config.candidateWorktreePath
  ) throw new Error("Seeded candidate nodes do not share the managed worktree lineage.");
  if (!projection.segments.some((item) =>
    item.id === segment.segmentId &&
    item.runId === segment.runId &&
    item.laneId === candidateDeliveryFixture.implementationLaneId &&
    item.status === "succeeded"
  )) throw new Error("Seeded candidate implementation segment is not succeeded.");
  const checkpoints = projection.checkpoints.filter((item) => item.runId === segment.runId);
  if (
    checkpoints.length !== 2 ||
    checkpoints[0]?.phase !== "before" ||
    checkpoints[1]?.phase !== "after" ||
    checkpoints[1]?.worktreeState !== "dirty" ||
    !checkpoints[1]?.ancestryProof
  ) throw new Error("Seeded candidate checkpoints are incomplete.");
  if (
    !arrayEquals(changesetEvidence.files, [config.markerFile]) ||
    manifest.fullPatchSha256 !== changesetEvidence.fullPatchSha256 ||
    manifest.fullPatchByteLength !== changesetEvidence.fullPatchByteLength ||
    manifest.fileManifestSha256 !== changesetEvidence.fileManifestSha256 ||
    manifest.executionTarget !== "new_worktree" ||
    manifest.worktreeId !== candidateDeliveryFixture.worktreeId ||
    manifest.branchName !== config.branch ||
    !isDigest(manifestSha256)
  ) throw new Error("Seeded immutable candidate manifest does not match complete changeset evidence.");
  if (projection.events.some((item) => deliveryEventKinds.includes(item.kind))) {
    throw new Error("Seeded projection already contains a public delivery action.");
  }
}

function candidateWorkspaceState({
  projectRoot,
  candidateWorktreePath,
  canvasSession,
  segment,
  runEvidence,
  openedAt,
}) {
  const project = {
    id: candidateDeliveryFixture.projectId,
    name: basename(projectRoot),
    rootPath: projectRoot,
    canonicalRootPath: projectRoot,
    devflowPath: join(projectRoot, ".devflow"),
    openedAt,
  };
  const run = {
    id: segment.runId,
    nodeId: candidateDeliveryFixture.implementationLaneId,
    sessionId: candidateDeliveryFixture.sessionId,
    projectRoot,
    worktreePath: candidateWorktreePath,
    agentKind: "codex",
    status: "succeeded",
    startedAt: segment.startedAt ?? openedAt,
    endedAt: runEvidence.completedAt,
  };
  return {
    projects: [project],
    sessions: [canvasSession],
    changesets: {},
    agents: [],
    runs: { [run.id]: run },
    runEvents: { [run.id]: [] },
    runEvidence: { [run.id]: runEvidence },
    activeProjectId: project.id,
    activeSessionId: canvasSession.id,
    sidebarCollapsed: false,
    collapsedProjectIds: [],
  };
}

async function launchAndConnect({ services, userDataPath, projectRoot }) {
  const app = await (services.launch ?? launchElectronAcceptanceApp)({
    userData: userDataPath,
    projectRoot,
  });
  const cdp = await (services.connect ?? connectToReadySkyTurnRenderer)({
    cdpPort: app.cdpPort,
    devServerUrl: app.devServerUrl,
    projectRoot,
    processDiagnostics: app.diagnostics,
  });
  await (services.waitForProject ?? waitForStoredProjectRegistration)(cdp, projectRoot);
  return { app, cdp };
}

async function closeAcceptanceApp({ services, app, cdp, failure }) {
  if (app && !cdp && !services.closeApp) {
    return app.close().then(() => ({ ok: true, cleanupConfirmed: true, diagnostic: null })).catch((error) => ({
      ok: false,
      cleanupConfirmed: false,
      diagnostic: safeErrorMessage(error),
    }));
  }
  return (services.closeApp ?? finalizeAcceptanceOutcome)({
    app,
    liveCdp: cdp,
    ...(failure ? { error: new Error(failure.diagnostic) } : { ok: true }),
  }).catch((error) => ({
    ok: false,
    cleanupConfirmed: false,
    diagnostic: safeErrorMessage(error),
  }));
}

function applyActionProgressToState(state, actions) {
  if (isFullCommitSha(actions?.commit?.commitSha)) state.headSha = actions.commit.commitSha;
  if (actions?.push?.status === "pushed") state.remoteBranchCreated = true;
  if (actions?.pullRequest?.number && actions?.pullRequest?.url) {
    state.pr = {
      number: actions.pullRequest.number,
      url: actions.pullRequest.url,
      headRefName: actions.pullRequest.head,
      headRefOid: actions.pullRequest.commitSha,
      baseRefName: actions.pullRequest.base,
      state: "OPEN",
      mergeCommitOid: null,
    };
  }
  const mergedBoundary = actions?.boundaries?.find((item) => item.completedAction === "mergePullRequest");
  if (isFullCommitSha(mergedBoundary?.remote?.pullRequest?.mergeCommitOid)) {
    state.mergeSha = mergedBoundary.remote.pullRequest.mergeCommitOid;
    state.pr = mergedBoundary.remote.pullRequest;
  }
}

function rendererDeliveryExpectation(state, actions) {
  return {
    ...candidateDeliveryFixture,
    commitSha: actions.commit.commitSha,
    branch: state.branch,
    prNumber: actions.pullRequest.number,
    prUrl: actions.pullRequest.url,
  };
}

function candidateDeliveryResult({
  state,
  input,
  actions,
  persistedState,
  reopenedPersistedState,
  oracle,
  cleanup,
  failure,
  reviewObservation,
  closeResult,
  redactPaths,
}) {
  const ok = failure === null;
  const events = Array.isArray(persistedState?.events) ? persistedState.events : [];
  return {
    ok,
    status: ok ? "completed" : "failed",
    failure: failure ? sanitizedEvidence(failure, redactPaths) : null,
    repository: state.repo,
    baseBranch: state.baseBranch,
    baseHead: state.baseHead,
    branch: state.branch,
    candidateSha: state.headSha,
    mergeSha: state.mergeSha,
    remote: state.remote,
    pullRequest: state.pr,
    checkName: input.checkName,
    workflowId: state.workflowId,
    workflowPath: input.workflowPath,
    expectedReviewStatus: input.expectedReviewStatus,
    actionEvidence: publicActionEvidence(actions),
    authority: {
      deliveryEventKinds: events.filter((item) => deliveryEventKinds.includes(item.kind)).map((item) => item.kind),
      persisted: Boolean(persistedState?.manifest && reopenedPersistedState?.manifest),
      manifestStable: persistedState && reopenedPersistedState
        ? stableJson(persistedState.manifest) === stableJson(reopenedPersistedState.manifest)
        : false,
    },
    hermesReview: {
      durableAllowRecorded: events.filter((item) => item.kind === "workflow.candidate.review_allowed").length === 1,
      temporaryRootObserved: reviewObservation?.temporaryRootObserved === true,
      verifierProcessObserved: reviewObservation?.verifierProcessObserved === true,
    },
    oracle,
    cleanup: publicCleanupSummary(cleanup, state, redactPaths),
    electronClose: closeResult ? {
      ok: closeResult.ok === true,
      cleanupConfirmed: closeResult.cleanupConfirmed === true,
      diagnostic: closeResult.diagnostic
        ? boundedDiagnostic(sanitizeDiagnostic(closeResult.diagnostic, redactPaths))
        : null,
    } : null,
  };
}

function publicActionEvidence(actions) {
  if (!actions || typeof actions !== "object") return null;
  return {
    order: Array.isArray(actions.actionOrder) ? [...actions.actionOrder] : [],
    commit: actions.commit ? {
      status: actions.commit.status ?? null,
      commitSha: actions.commit.commitSha ?? null,
      branch: actions.commit.branch ?? null,
      parentCommit: actions.commit.parentCommit ?? null,
    } : null,
    push: actions.push ? {
      status: actions.push.status ?? null,
      remote: actions.push.remote ?? null,
      branch: actions.push.branch ?? null,
      commitSha: actions.push.commitSha ?? null,
    } : null,
    pullRequest: actions.pullRequest ? {
      status: actions.pullRequest.status ?? null,
      url: actions.pullRequest.url ?? null,
      number: actions.pullRequest.number ?? null,
      head: actions.pullRequest.head ?? null,
      base: actions.pullRequest.base ?? null,
      remote: actions.pullRequest.remote ?? null,
      commitSha: actions.pullRequest.commitSha ?? null,
      title: actions.pullRequest.title ?? null,
    } : null,
    checks: summarizeChecks(actions.checks),
    merge: actions.merge ? {
      status: actions.merge.status ?? null,
      number: actions.merge.number ?? null,
      url: actions.merge.url ?? null,
      headSha: actions.merge.headSha ?? null,
      subject: actions.merge.subject ?? null,
      checks: Array.isArray(actions.merge.checks) ? actions.merge.checks : [],
      review: actions.merge.review ?? null,
    } : null,
    sync: actions.sync ? {
      status: actions.sync.status ?? null,
      mainBranch: actions.sync.mainBranch ?? null,
      remote: actions.sync.remote ?? null,
    } : null,
    boundaryCount: Array.isArray(actions.boundaries) ? actions.boundaries.length : 0,
  };
}

function publicCleanupSummary(cleanup, state, redactPaths) {
  if (!cleanup || typeof cleanup !== "object") return null;
  return {
    status: typeof cleanup.status === "string" ? cleanup.status : "cleanup-failed",
    prClosed: cleanup.prClosed === true,
    remoteBranchDeleted: cleanup.remoteBranchDeleted === true,
    localBranchDeleted: cleanup.localBranchDeleted === true,
    localStateRemoved: cleanup.localStateRemoved === true,
    audit: publicCleanupAudit(cleanup.audit ?? cleanupAudit(state)),
    ...(cleanup.message ? {
      message: boundedDiagnostic(sanitizeDiagnostic(cleanup.message, redactPaths)),
    } : {}),
  };
}

function cleanupAudit(state) {
  return {
    repo: state?.repo ?? null,
    repoRoot: state?.repoRoot ?? null,
    baseBranch: state?.baseBranch ?? null,
    remote: state?.remote ?? null,
    branch: state?.branch ?? null,
    headSha: state?.headSha ?? null,
    mergeSha: state?.mergeSha ?? null,
    pr: state?.pr ? {
      number: state.pr.number,
      url: state.pr.url,
      headRefName: state.pr.headRefName,
      headRefOid: state.pr.headRefOid,
      baseRefName: state.pr.baseRefName,
      state: state.pr.state,
      mergeCommitOid: state.pr.mergeCommitOid,
    } : null,
    remoteBranchCreated: state?.remoteBranchCreated === true,
    remoteEvidenceUncertain: state?.remoteEvidenceUncertain === true,
    localBranchCreated: state?.localBranchCreated === true,
    worktreeCreated: state?.worktreeCreated === true,
    candidateWorktreePath: state?.candidateWorktreePath ?? null,
    userDataPath: state?.userDataPath ?? null,
    tempRoot: state?.tempRoot ?? null,
  };
}

function publicCleanupResult(audit, result) {
  return {
    ...result,
    ...(result?.message ? {
      message: boundedDiagnostic(sanitizeDiagnostic(result.message, cleanupPathRoots(audit))),
    } : {}),
    audit: publicCleanupAudit(audit),
  };
}

function publicCleanupAudit(audit) {
  return {
    repository: audit?.repository ?? audit?.repo ?? null,
    baseBranch: audit?.baseBranch ?? null,
    remote: audit?.remote ?? null,
    branch: audit?.branch ?? null,
    candidateSha: audit?.candidateSha ?? audit?.headSha ?? null,
    mergeSha: audit?.mergeSha ?? null,
    pullRequest: publicPullRequestAudit(audit?.pullRequest ?? audit?.pr),
    remoteBranchCreated: audit?.remoteBranchCreated === true,
    remoteEvidenceUncertain: audit?.remoteEvidenceUncertain === true,
    localBranchCreated: audit?.localBranchCreated === true,
    worktreeCreated: audit?.worktreeCreated === true,
  };
}

function publicPullRequestAudit(pullRequest) {
  if (!pullRequest || typeof pullRequest !== "object") return null;
  return {
    number: pullRequest.number ?? null,
    url: pullRequest.url ?? null,
    headRefName: pullRequest.headRefName ?? null,
    headRefOid: pullRequest.headRefOid ?? null,
    baseRefName: pullRequest.baseRefName ?? null,
    state: pullRequest.state ?? null,
    mergeCommitOid: pullRequest.mergeCommitOid ?? null,
  };
}

function cleanupPathRoots(audit) {
  return normalizePathRoots([
    audit?.repoRoot,
    audit?.candidateWorktreePath,
    audit?.userDataPath,
    audit?.tempRoot,
  ]);
}

function assertCleanupPaths(audit) {
  if (!audit.tempRoot || !isAbsolute(audit.tempRoot) || resolve(audit.tempRoot) === resolve(sep)) {
    throw new Error("Cleanup temporary root is unsafe.");
  }
  if (!audit.repoRoot || !isPathWithinOrEqual(audit.repoRoot, audit.tempRoot)) {
    throw new Error("Cleanup repository root escapes isolated temporary state.");
  }
  for (const candidate of [audit.candidateWorktreePath, audit.userDataPath]) {
    if (candidate && !isPathWithinOrEqual(candidate, audit.tempRoot)) {
      throw new Error("Cleanup path escapes isolated temporary state.");
    }
  }
}

async function assertStandaloneTempRoot(tempRoot) {
  const resolved = resolve(tempRoot);
  const resolvedSystemTemp = await realpath(tmpdir());
  if (
    resolved === resolve(sep) ||
    !isPathWithinOrEqual(resolved, resolvedSystemTemp) ||
    !basename(resolved).startsWith("skyturn-candidate-delivery-")
  ) throw new Error("Standalone cleanup temporary root is unsafe.");
}

function assertMergedPullRequestAuditTarget(audit) {
  assertRepoName(audit.repo);
  assertPositivePrNumber(audit.pr.number);
  const url = optionalText(audit.pr.url);
  if (!url) throw new Error("Cleanup pull request URL is missing.");
  let pathname;
  try {
    const parsed = new URL(url);
    if (parsed.hostname.toLowerCase() !== "github.com") {
      throw new Error("unexpected GitHub host");
    }
    pathname = parsed.pathname.replace(/\/+$/, "");
  } catch {
    throw new Error("Cleanup pull request URL is invalid.");
  }
  if (pathname.toLowerCase() !== `/${audit.repo}/pull/${audit.pr.number}`.toLowerCase()) {
    throw new Error("Cleanup pull request does not belong to the exact disposable repository.");
  }
  if (
    audit.pr.state !== "MERGED" ||
    audit.pr.headRefName !== audit.branch ||
    audit.pr.headRefOid !== audit.headSha ||
    audit.pr.baseRefName !== audit.baseBranch ||
    !isFullCommitSha(audit.pr.mergeCommitOid) ||
    audit.pr.mergeCommitOid !== audit.mergeSha
  ) throw new Error("Cleanup requires independently audited exact MERGED pull request evidence.");
}

async function readRemoteBranchHead({ run, cwd, remote, branch, required = false }) {
  assertRemoteName(remote);
  assertBranchName(branch, "branch");
  const output = (await capture(run, "git", [
    "ls-remote",
    "--heads",
    remote,
    `refs/heads/${branch}`,
  ], { cwd })).stdout.trim();
  if (!output) {
    if (required) throw new Error(`Remote branch ${remote}/${branch} does not exist.`);
    return null;
  }
  const lines = output.split("\n").filter(Boolean);
  if (lines.length !== 1) throw new Error(`Remote branch ${remote}/${branch} is ambiguous.`);
  const [sha, ref] = lines[0].split(/\s+/);
  if (!isFullCommitSha(sha) || ref !== `refs/heads/${branch}`) {
    throw new Error(`Remote branch ${remote}/${branch} did not return exact ref evidence.`);
  }
  return sha.toLowerCase();
}

function normalizePullRequestAudit(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("GitHub pull request audit record is invalid.");
  }
  const number = Number(value.number);
  assertPositivePrNumber(number);
  const url = requiredText(value.url, "GitHub pull request URL is missing.");
  let parsedUrl;
  try {
    parsedUrl = new URL(url);
  } catch {
    throw new Error("GitHub pull request URL is invalid.");
  }
  if (parsedUrl.hostname.toLowerCase() !== "github.com") {
    throw new Error("GitHub pull request URL host is invalid.");
  }
  const headRefName = requiredText(value.headRefName, "GitHub pull request head branch is missing.");
  const headRefOid = optionalText(value.headRefOid)?.toLowerCase();
  const baseRefName = requiredText(value.baseRefName, "GitHub pull request base branch is missing.");
  const state = requiredText(value.state, "GitHub pull request state is missing.").toUpperCase();
  const mergeCommitOid = optionalText(value.mergeCommit?.oid)?.toLowerCase() ?? null;
  if (!isFullCommitSha(headRefOid) || (mergeCommitOid !== null && !isFullCommitSha(mergeCommitOid))) {
    throw new Error("GitHub pull request audit record has invalid commit evidence.");
  }
  return { number, url, headRefName, headRefOid, baseRefName, state, mergeCommitOid };
}

function assertPassedChecksGate(
  evidence,
  pullRequest,
  candidateSha,
  checkName,
  expectedReviewStatus,
  workflowId,
  workflowPath,
) {
  if (
    !evidence ||
    evidence.status !== "passed" ||
    evidence.number !== pullRequest.number ||
    (pullRequest.url && evidence.url && evidence.url !== pullRequest.url) ||
    evidence.headSha !== candidateSha ||
    !namedCheckPassed(evidence.checks, checkName) ||
    !reviewAllowsMerge(expectedReviewStatus) ||
    evidence.review?.status !== expectedReviewStatus ||
    evidence.gate?.headSha !== candidateSha ||
    evidence.gate?.checksStatus !== "passed" ||
    evidence.gate?.reviewStatus !== evidence.review?.status ||
    evidence.gate?.state !== "OPEN" ||
    evidence.gate?.mergeable !== true
  ) throw new Error("Exact-head pull request gate is not passed, review-allowed, mergeable, and OPEN.");
  assertExactWorkflowRuns(evidence.workflowRuns, candidateSha, workflowId, workflowPath);
}

function summarizeChecks(checks) {
  if (!checks || typeof checks !== "object") return null;
  return {
    status: checks.status ?? null,
    number: checks.number ?? null,
    url: checks.url ?? null,
    headSha: checks.headSha ?? null,
    checks: Array.isArray(checks.checks) ? checks.checks : [],
    review: checks.review ?? null,
    gate: checks.gate ?? null,
    workflowRuns: summarizeWorkflowRuns(checks.workflowRuns),
  };
}

function summarizeWorkflowRuns(workflowRuns) {
  if (!Array.isArray(workflowRuns)) return null;
  return workflowRuns.map((item) => ({
    id: item?.id ?? null,
    workflowId: item?.workflowId ?? null,
    path: item?.path ?? null,
    headSha: item?.headSha ?? null,
    event: item?.event ?? null,
    status: item?.status ?? null,
    conclusion: item?.conclusion ?? null,
  }));
}

function assertExactWorkflowRuns(workflowRuns, candidateSha, workflowId, workflowPath) {
  if (!Array.isArray(workflowRuns) || workflowRuns.length !== 1) {
    throw new Error("Exactly one configured pull request workflow run is required.");
  }
  const workflowRun = workflowRuns[0];
  if (
    !Number.isSafeInteger(workflowRun?.id) ||
    workflowRun.id <= 0 ||
    !Number.isSafeInteger(workflowId) ||
    workflowId <= 0 ||
    workflowRun.workflowId !== workflowId ||
    workflowRun.path !== workflowPath ||
    workflowRun.headSha !== candidateSha ||
    workflowRun.event !== "pull_request" ||
    workflowRun.status !== "completed" ||
    workflowRun.conclusion !== "success"
  ) {
    throw new Error("The configured pull request workflow run does not match the exact successful candidate run.");
  }
}

function namedCheckPassed(checks, checkName) {
  return Array.isArray(checks) && checks.some((check) =>
    check?.name === checkName &&
    check?.workflow === checkName &&
    check?.status === "passed"
  );
}

function reviewAllowsMerge(status) {
  return status === "approved" || status === "pending";
}

function installCommitIdentityDefaults(env) {
  const defaults = {
    GIT_AUTHOR_NAME: "SkyTurn Delivery Acceptance",
    GIT_AUTHOR_EMAIL: "skyturn-delivery@example.invalid",
    GIT_COMMITTER_NAME: "SkyTurn Delivery Acceptance",
    GIT_COMMITTER_EMAIL: "skyturn-delivery@example.invalid",
  };
  const previous = new Map();
  for (const [key, value] of Object.entries(defaults)) {
    previous.set(key, env[key]);
    if (!env[key]) env[key] = value;
  }
  return () => {
    for (const [key, value] of previous) {
      if (value === undefined) delete env[key];
      else env[key] = value;
    }
  };
}

async function capture(run, command, args, options = {}) {
  const result = await run(command, args, options);
  const redactPaths = commandDiagnosticPaths(options);
  return {
    stdout: String(result?.stdout ?? ""),
    stderr: sanitizeDiagnostic(String(result?.stderr ?? ""), redactPaths),
  };
}

async function tryCapture(run, command, args, options = {}) {
  try {
    return await capture(run, command, args, options);
  } catch {
    return null;
  }
}

export async function runCommand(command, args, options = {}) {
  const redactPaths = commandDiagnosticPaths(options);
  try {
    const result = await execFileAsync(command, args, {
      cwd: options.cwd,
      env: options.env ?? process.env,
      encoding: "utf8",
      maxBuffer: commandOutputLimit,
      shell: false,
    });
    return {
      stdout: String(result.stdout ?? ""),
      stderr: sanitizeDiagnostic(String(result.stderr ?? ""), redactPaths),
    };
  } catch (error) {
    const exit = typeof error?.code === "number" ? error.code : "failed";
    const commandName = basename(String(command));
    const detail = boundedDiagnostic(sanitizeDiagnostic(
      String(error?.stderr || error?.stdout || error?.message || ""),
      redactPaths,
    ));
    throw new Error(`${commandName} ${safeCommandAction(args)} failed (${exit})${detail ? `: ${detail}` : ""}.`);
  }
}

function normalizedFailure(stage, error, evidence = null, redactPaths = []) {
  return {
    code: "CANDIDATE_DELIVERY_ACCEPTANCE_FAILED",
    stage: typeof stage === "string" && stage ? stage : "unknown",
    message: "Real candidate delivery acceptance failed.",
    diagnostic: boundedDiagnostic(safeErrorMessage(error, redactPaths)),
    evidence: sanitizedEvidence(evidence, redactPaths),
  };
}

function sanitizedEvidence(value, redactPaths = []) {
  if (value === undefined) return null;
  try {
    return JSON.parse(sanitizeDiagnostic(JSON.stringify(value), redactPaths));
  } catch {
    return boundedDiagnostic(sanitizeDiagnostic(String(value), redactPaths));
  }
}

function publicStateEvidence(state) {
  return {
    repository: state.repo,
    baseBranch: state.baseBranch,
    baseHead: state.baseHead,
    branch: state.branch,
    candidateSha: state.headSha,
    mergeSha: state.mergeSha,
    pullRequest: state.pr,
    remoteBranchCreated: state.remoteBranchCreated,
    remoteEvidenceUncertain: state.remoteEvidenceUncertain,
    failureRemoteAudit: state.failureRemoteAudit ?? null,
  };
}

function safeErrorMessage(error, redactPaths = []) {
  return sanitizeDiagnostic(error instanceof Error ? error.message : String(error), redactPaths);
}

function sanitizeDiagnostic(value, redactPaths = []) {
  let sanitized = String(value)
    .replace(/-----BEGIN [^-]+PRIVATE KEY-----[\s\S]*?-----END [^-]+PRIVATE KEY-----/g, "[REDACTED_PRIVATE_KEY]")
    .replace(/\b(?:gh[pousr]_[A-Za-z0-9_]+|github_pat_[A-Za-z0-9_]+)\b/g, "[REDACTED_GITHUB_TOKEN]")
    .replace(/\b(authorization)\b\s*[:=]\s*bearer\s+[^\s"',;}\]]+/gi, "$1: Bearer [REDACTED]")
    .replace(/\b(token|secret|password|api[_-]?key|cookie)\b\s*[:=]\s*[^\s"',;}\]]+/gi, "$1=[REDACTED]")
    .replace(/\b[A-Za-z][A-Za-z0-9+.-]*:\/\/[^\s/@:]+:[^\s/@]+@[^\s]+/g, "[REDACTED_URL]");
  for (const pathRoot of normalizePathRoots(redactPaths).sort((left, right) => right.length - left.length)) {
    sanitized = sanitized.split(pathRoot).join("[REDACTED_PATH]");
  }
  return sanitized;
}

function boundedDiagnostic(value) {
  const text = String(value);
  if (Buffer.byteLength(text) <= diagnosticLimit) return text;
  const marker = "... [truncated]";
  return `${Buffer.from(text).subarray(0, diagnosticLimit - Buffer.byteLength(marker)).toString("utf8").replace(/\uFFFD$/, "")}${marker}`;
}

function safeCommandAction(args) {
  const action = Array.isArray(args) && typeof args[0] === "string" ? args[0] : "command";
  return /^[A-Za-z0-9._:-]+$/.test(action) ? action : "command";
}

function githubRepoFromRemoteUrl(value) {
  return githubRemoteIdentity(value)?.repo ?? null;
}

function githubHostFromRemoteUrl(value) {
  return githubRemoteIdentity(value)?.host ?? null;
}

function githubRemoteIdentity(value) {
  const remoteUrl = String(value).trim();
  let pathname = null;
  let host = null;
  try {
    const parsed = new URL(remoteUrl);
    pathname = parsed.pathname;
    host = parsed.hostname.toLowerCase();
  } catch {
    const match = remoteUrl.match(/^(?:[^@]+@)?([^:]+):(.+)$/);
    if (match) {
      host = match[1].toLowerCase();
      pathname = match[2];
    }
  }
  if (!pathname || !host) return null;
  const normalized = pathname.replace(/^\/+/, "").replace(/\.git$/i, "");
  const parts = normalized.split("/").filter(Boolean);
  if (parts.length !== 2) return null;
  const repo = `${parts[0]}/${parts[1]}`;
  try {
    assertRepoName(repo);
    return { host, repo };
  } catch {
    return null;
  }
}

function parseRemoteHeads(output) {
  const heads = [];
  for (const line of String(output).trim().split("\n").filter(Boolean)) {
    const [sha, ref] = line.split(/\s+/);
    if (!isFullCommitSha(sha) || !ref?.startsWith("refs/heads/")) {
      throw new Error("Remote branch preflight returned invalid ref evidence.");
    }
    heads.push({ name: ref.slice("refs/heads/".length), sha: sha.toLowerCase() });
  }
  return heads.sort((left, right) => left.name.localeCompare(right.name));
}

function assertRepoName(repo) {
  if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(repo)) {
    throw new Error(`Invalid GitHub repo: ${repo}.`);
  }
}

function assertRemoteName(remote) {
  if (!/^[A-Za-z0-9._-]+$/.test(remote)) throw new Error("Delivery remote must be a git remote name.");
}

function assertBranchName(branch, label) {
  if (
    typeof branch !== "string" ||
    branch.length === 0 ||
    /[\0-\x20\x7f~^:?*[\]\\]/.test(branch) ||
    branch.startsWith("-") ||
    branch.startsWith(".") ||
    branch.endsWith("/") ||
    branch.endsWith(".") ||
    branch.includes("..") ||
    branch.includes("@{") ||
    branch.split("/").some((part) => !part || part.startsWith(".") || part.endsWith(".lock"))
  ) throw new Error(`Invalid ${label}: ${branch}.`);
}

function assertSmokeBranch(branch) {
  if (!/^skyturn\/smoke\/[0-9]{8}T[0-9]{6}Z-[0-9a-f]{6,16}$/.test(branch)) {
    throw new Error(`Refusing non-smoke branch: ${branch}.`);
  }
}

function assertPositivePrNumber(value) {
  if (!Number.isSafeInteger(value) || value <= 0) throw new Error(`Invalid pull request number: ${value}.`);
}

function assertBoundedText(value, label, maximum) {
  if (typeof value !== "string" || !value.trim() || value !== value.trim() || value.length > maximum || /[\0\r\n]/.test(value)) {
    throw new Error(`Delivery acceptance ${label} is invalid.`);
  }
}

function boundedPositiveInteger(value, fallback, maximum, label) {
  if (value === undefined || value === null || value === "") return fallback;
  const number = Number(value);
  if (!Number.isSafeInteger(number) || number <= 0 || number > maximum) {
    throw new Error(`Delivery acceptance ${label} must be a positive integer no greater than ${maximum}.`);
  }
  return number;
}

function requiredText(value, message) {
  const text = optionalText(value);
  if (!text) throw new Error(message);
  return text;
}

function optionalText(value) {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function isFullCommitSha(value) {
  return typeof value === "string" && /^[0-9a-f]{40}$/i.test(value);
}

function isDigest(value) {
  return typeof value === "string" && /^[0-9a-f]{64}$/i.test(value);
}

function parseJson(value, message) {
  try {
    return JSON.parse(value);
  } catch {
    throw new Error(message);
  }
}

function parseJsonObject(value, message) {
  const parsed = parseJson(value, message);
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error(message);
  return parsed;
}

function parseJsonArray(value, message) {
  const parsed = parseJson(value, message);
  if (!Array.isArray(parsed)) throw new Error(message);
  return parsed;
}

function eventLaneId(event) {
  return event?.laneId ?? event?.payload?.laneId ?? null;
}

function arrayEquals(actual, expected) {
  return Array.isArray(actual) &&
    actual.length === expected.length &&
    actual.every((value, index) => value === expected[index]);
}

function strictlyIncreasing(values) {
  return values.length > 0 && values.every((value, index) =>
    Number.isSafeInteger(value) && (index === 0 || values[index - 1] < value)
  );
}

function stableJson(value) {
  return JSON.stringify(value, (_key, nested) => {
    if (!nested || typeof nested !== "object" || Array.isArray(nested)) return nested;
    return Object.fromEntries(Object.entries(nested).sort(([left], [right]) => left.localeCompare(right)));
  });
}

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

function compareUtf8(left, right) {
  return Buffer.compare(Buffer.from(left), Buffer.from(right));
}

function commandDiagnosticPaths(options) {
  return normalizePathRoots([
    options?.cwd,
    ...(Array.isArray(options?.redactPaths) ? options.redactPaths : []),
  ]);
}

function candidateDeliverySensitivePaths(state, checkoutRoot) {
  return normalizePathRoots([
    checkoutRoot,
    state?.repoRoot,
    state?.repoRoot ? `${state.repoRoot}.worktrees` : null,
    state?.candidateWorktreePath ? dirname(state.candidateWorktreePath) : null,
    state?.candidateWorktreePath,
    state?.userDataPath,
    state?.tempRoot,
  ]);
}

function normalizePathRoots(values) {
  const roots = [];
  for (const value of values ?? []) {
    if (typeof value !== "string" || !isAbsolute(value)) continue;
    const resolved = resolve(value);
    const candidates = [value, resolved];
    for (const candidate of [value, resolved]) {
      if (candidate.startsWith("/private/var/") || candidate.startsWith("/private/tmp/")) {
        candidates.push(candidate.slice("/private".length));
      } else if (candidate.startsWith("/var/") || candidate.startsWith("/tmp/")) {
        candidates.push(`/private${candidate}`);
      }
    }
    for (const candidate of candidates) {
      if (candidate !== resolve(sep) && !roots.includes(candidate)) roots.push(candidate);
    }
  }
  return roots;
}

function isPathWithinOrEqual(candidate, parent) {
  const relativePath = relative(resolve(parent), resolve(candidate));
  return relativePath === "" || (
    relativePath !== ".." &&
    !relativePath.startsWith(`..${sep}`) &&
    !isAbsolute(relativePath)
  );
}

function assertIsolatedTempRoot(tempRoot, checkoutRoot) {
  const resolvedTemp = resolve(tempRoot);
  const resolvedCheckout = resolve(checkoutRoot);
  if (
    resolvedTemp === resolve(sep) ||
    resolvedTemp === resolvedCheckout ||
    isPathWithinOrEqual(resolvedTemp, resolvedCheckout) ||
    isPathWithinOrEqual(resolvedCheckout, resolvedTemp)
  ) throw new Error("Candidate delivery temporary state must be isolated from the SkyTurn checkout.");
}

function delay(ms) {
  return new Promise((resolveDelay) => setTimeout(resolveDelay, ms));
}

async function runRuntimeMode() {
  const mode = process.argv[2];
  if (mode !== "--seed" && mode !== "--inspect") return false;
  const config = parseJson(process.argv[3] ?? "null", "Candidate delivery runtime config is invalid.");
  if (mode === "--seed") {
    process.stdout.write(`${seedResultPrefix}${JSON.stringify(await seedCandidateDeliveryStore(config))}\n`);
  } else {
    process.stdout.write(`${inspectResultPrefix}${JSON.stringify(await inspectCandidateDeliveryStore(config))}\n`);
  }
  return true;
}

if (process.argv[1] === scriptPath) {
  runRuntimeMode().then(async (handled) => {
    if (handled) return;
    const result = await runCandidateDeliveryAcceptance();
    if (result.status !== "skipped" && result.ok !== true) process.exitCode = 1;
  }).catch((error) => {
    const failure = normalizedFailure("unhandled", error);
    process.stderr.write(`FAILED: ${failure.diagnostic}\n`);
    process.exitCode = 1;
  });
}
