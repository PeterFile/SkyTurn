import { execFile } from "node:child_process";
import { createRequire } from "node:module";
import { mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

import { buildSmokeBranchName } from "./deliveryGithubSmoke.mjs";
import {
  connectToReadySkyTurnRenderer,
  finalizeAcceptanceOutcome,
  launchElectronAcceptanceApp,
  waitForStoredProjectRegistration,
} from "./newSessionUiAcceptance.mjs";

const execFileAsync = promisify(execFile);
const require = createRequire(import.meta.url);
const scriptPath = fileURLToPath(import.meta.url);
const commandOutputLimit = 8 * 1024 * 1024;
const diagnosticLimit = 8_000;
const defaultCheckTimeoutMs = 10 * 60 * 1_000;
const maxCheckTimeoutMs = 60 * 60 * 1_000;
const defaultPollIntervalMs = 5_000;
const maxPollIntervalMs = 60_000;
const seedResultPrefix = "SKYTURN_CANDIDATE_DELIVERY_SEED=";
const inspectResultPrefix = "SKYTURN_CANDIDATE_DELIVERY_INSPECT=";

export const CANDIDATE_DELIVERY_PR_TITLE = "test(delivery): verify candidate worktree IPC";

export const candidateDeliveryFixture = Object.freeze({
  projectId: "project-candidate-delivery-pr",
  sessionId: "session-candidate-delivery-pr",
  sessionTitle: "Candidate worktree delivery acceptance",
  commitLaneId: "lane-candidate-delivery-commit",
  pullRequestLaneId: "lane-candidate-delivery-pr",
  edgeId: "edge-candidate-delivery-commit-pr",
});

export function parseCandidateDeliveryAcceptanceInput(env = process.env, options = {}) {
  if (env.SKYTURN_REAL_DELIVERY_ACCEPTANCE !== "1") {
    return {
      enabled: false,
      reason: "Set SKYTURN_REAL_DELIVERY_ACCEPTANCE=1 to run the real candidate-worktree delivery acceptance.",
    };
  }

  const repo = optionalText(env.SKYTURN_DELIVERY_ACCEPTANCE_REPO);
  if (repo) assertRepoName(repo);
  const baseBranch = optionalText(
    env.SKYTURN_DELIVERY_ACCEPTANCE_BASE_BRANCH ??
    env.SKYTURN_DELIVERY_ACCEPTANCE_BASE,
  );
  if (baseBranch) assertBranchName(baseBranch, "base branch");
  const remote = optionalText(env.SKYTURN_DELIVERY_ACCEPTANCE_REMOTE) ?? "origin";
  assertRemoteName(remote);
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
    cleanupEnabled: env.SKYTURN_DELIVERY_ACCEPTANCE_CLEANUP === "1",
    repo,
    baseBranch,
    remote,
    branch,
    smokeId,
    markerFile: `.devflow/smoke/${smokeId}.md`,
    checkTimeoutMs,
    pollIntervalMs,
    maxCheckAttempts: Math.max(1, Math.ceil(checkTimeoutMs / pollIntervalMs)),
  };
}

export async function runPublicDeliveryActions(input) {
  const {
    workflow,
    projectRoot,
    sessionId,
    commitLaneId,
    pullRequestLaneId,
    worktreePath,
    markerFile,
    branch,
    baseBranch,
    remote,
    title,
    whatChanged,
    why,
    breakingChanges,
    serverPr,
  } = input;
  const actionOrder = [];
  const progress = {
    commit: null,
    push: null,
    pullRequest: null,
    checks: null,
  };
  let stage = "preflight";

  const failure = (code, message) => ({
    ok: false,
    actionOrder,
    ...progress,
    checksObserved: Array.isArray(progress.checks?.checks) && progress.checks.checks.length > 0,
    checksStatus: progress.checks?.status ?? null,
    checksPassed: progress.checks?.status === "passed",
    checkAttempts: actionOrder.filter((action) => action === "checkPullRequest").length,
    failure: { stage, code, message },
  });

  try {
    if (!workflow || typeof workflow !== "object") {
      return failure("PUBLIC_WORKFLOW_API_UNAVAILABLE", "window.devflow.workflow is unavailable.");
    }
    for (const method of [
      "createDeliveryCommit",
      "pushDeliveryBranch",
      "createPullRequest",
      "checkPullRequest",
    ]) {
      if (typeof workflow[method] !== "function") {
        return failure("PUBLIC_WORKFLOW_API_UNAVAILABLE", `window.devflow.workflow.${method} is unavailable.`);
      }
    }

    stage = "createDeliveryCommit";
    actionOrder.push(stage);
    const commitResult = await workflow.createDeliveryCommit(projectRoot, {
      sessionId,
      laneId: commitLaneId,
      worktreePath,
      files: [markerFile],
      subject: title,
    });
    const commit = commitResult?.evidence;
    if (
      commitResult?.status !== "committed" ||
      commit?.status !== "committed" ||
      typeof commit.commitSha !== "string" ||
      !/^[0-9a-f]{40}$/i.test(commit.commitSha) ||
      commit.branch !== branch ||
      commit.worktreePath !== worktreePath
    ) {
      return failure("COMMIT_EVIDENCE_INVALID", "Delivery commit did not return exact candidate evidence.");
    }
    progress.commit = {
      status: commit.status,
      commitSha: commit.commitSha,
      branch: commit.branch,
      worktreePath: commit.worktreePath,
    };

    stage = "pushDeliveryBranch";
    actionOrder.push(stage);
    const pushResult = await workflow.pushDeliveryBranch(projectRoot, {
      sessionId,
      laneId: commitLaneId,
      worktreePath,
      commitSha: commit.commitSha,
      branch,
      remote,
    });
    const push = pushResult?.evidence;
    if (
      pushResult?.status !== "pushed" ||
      push?.status !== "pushed" ||
      push.commitSha !== commit.commitSha ||
      push.branch !== branch ||
      push.remote !== remote ||
      push.worktreePath !== worktreePath
    ) {
      return failure("PUSH_EVIDENCE_INVALID", "Delivery push did not return exact candidate evidence.");
    }
    progress.push = {
      status: push.status,
      remote: push.remote,
      branch: push.branch,
      commitSha: push.commitSha,
      worktreePath: push.worktreePath,
    };

    stage = "createPullRequest";
    actionOrder.push(stage);
    const pullRequestResult = await workflow.createPullRequest(projectRoot, {
      sessionId,
      laneId: pullRequestLaneId,
      commitLaneId,
      worktreePath,
      baseBranch,
      headBranch: branch,
      commitSha: commit.commitSha,
      remote,
      title,
      whatChanged,
      why,
      breakingChanges,
      serverPr,
    });
    const pullRequest = pullRequestResult?.evidence;
    if (
      pullRequestResult?.status !== "created" ||
      pullRequest?.status !== "created" ||
      !Number.isSafeInteger(pullRequest.number) ||
      pullRequest.number <= 0 ||
      typeof pullRequest.url !== "string" ||
      !pullRequest.url.endsWith(`/pull/${pullRequest.number}`) ||
      pullRequest.head !== branch ||
      pullRequest.base !== baseBranch ||
      pullRequest.remote !== remote ||
      pullRequest.commitSha !== commit.commitSha
    ) {
      return failure("PULL_REQUEST_EVIDENCE_INVALID", "Pull request creation did not return exact candidate evidence.");
    }
    progress.pullRequest = {
      status: pullRequest.status,
      url: pullRequest.url,
      number: pullRequest.number,
      head: pullRequest.head,
      base: pullRequest.base,
      remote: pullRequest.remote,
      commitSha: pullRequest.commitSha,
      title: pullRequest.title,
    };

    const maxCheckAttempts = Number.isSafeInteger(input.maxCheckAttempts) && input.maxCheckAttempts > 0
      ? input.maxCheckAttempts
      : 1;
    const pollIntervalMs = Number.isFinite(input.pollIntervalMs) && input.pollIntervalMs >= 0
      ? input.pollIntervalMs
      : 0;
    const sleep = typeof input.sleep === "function"
      ? input.sleep
      : (ms) => new Promise((resolveDelay) => setTimeout(resolveDelay, ms));

    for (let attempt = 1; attempt <= maxCheckAttempts; attempt += 1) {
      stage = "checkPullRequest";
      actionOrder.push(stage);
      const checksResult = await workflow.checkPullRequest(projectRoot, {
        sessionId,
        laneId: pullRequestLaneId,
        prNumber: pullRequest.number,
        prUrl: pullRequest.url,
        expectedHeadSha: commit.commitSha,
      });
      const checks = checksResult?.evidence;
      if (
        checksResult?.status !== "checks_recorded" ||
        !checks ||
        !["passed", "pending", "failed"].includes(checks.status) ||
        checks.number !== pullRequest.number ||
        checks.url !== pullRequest.url ||
        checks.headSha !== commit.commitSha ||
        checks.gate?.headSha !== commit.commitSha ||
        !Array.isArray(checks.checks)
      ) {
        return failure("CHECK_EVIDENCE_INVALID", "Pull request checks did not return exact-head evidence.");
      }
      progress.checks = {
        status: checks.status,
        number: checks.number,
        url: checks.url,
        headSha: checks.headSha,
        checks: checks.checks,
        review: checks.review,
        gate: checks.gate,
      };
      if (checks.checks.length > 0) {
        return {
          ok: true,
          actionOrder,
          ...progress,
          checksObserved: true,
          checksStatus: checks.status,
          checksPassed: checks.status === "passed",
          checkAttempts: attempt,
          failure: null,
        };
      }
      if (attempt < maxCheckAttempts) await sleep(pollIntervalMs);
    }

    return failure(
      "CHECKS_TIMEOUT",
      `Timed out after ${maxCheckAttempts} public checkPullRequest attempts without observing a check for the exact head.`,
    );
  } catch (error) {
    return failure("PUBLIC_WORKFLOW_ACTION_FAILED", error instanceof Error ? error.message : String(error));
  }
}

export function buildRendererDeliveryInvocation(input) {
  const publicInput = {
    ...input,
    sleep: undefined,
  };
  return `
    (async () => {
      const workflow = window.devflow?.workflow;
      return (${runPublicDeliveryActions.toString()})({
        ...${JSON.stringify(publicInput)},
        workflow,
      });
    })()
  `;
}

export function candidateDeliveryOracle(input) {
  const failures = [];
  const addFailure = (failure) => {
    if (!failures.includes(failure)) failures.push(failure);
  };
  const expected = input.expected ?? {};
  const actions = input.actions ?? {};
  const headSha = actions.commit?.commitSha;
  const rendererState = input.rendererState;
  const persistedState = input.persistedState;
  const projection = persistedState?.projection;
  const canvasSession = persistedState?.canvasSession;

  if (actions.ok !== true) addFailure("public-delivery-actions-failed");
  if (!isFullCommitSha(headSha)) addFailure("commit-head-invalid");
  if (actions.commit?.branch !== expected.branch) addFailure("commit-branch-mismatch");
  if (actions.push?.commitSha !== headSha) addFailure("push-head-mismatch");
  if (actions.push?.branch !== expected.branch) addFailure("push-branch-mismatch");
  if (actions.push?.remote !== expected.remote) addFailure("push-remote-mismatch");
  if (actions.pullRequest?.commitSha !== headSha) addFailure("pull-request-head-mismatch");
  if (actions.pullRequest?.head !== expected.branch) addFailure("pull-request-branch-mismatch");
  if (actions.pullRequest?.base !== expected.baseBranch) addFailure("pull-request-base-mismatch");
  if (input.localHeadSha !== headSha) addFailure("candidate-head-mismatch");
  if (input.remoteHeadSha !== headSha) addFailure("remote-branch-head-mismatch");
  if (input.baseHeadBefore !== input.baseHeadAfter) addFailure("base-head-changed");

  const pr = input.pullRequest;
  if (!pr || pr.number !== actions.pullRequest?.number) addFailure("github-pr-number-mismatch");
  if (!pr || pr.url !== actions.pullRequest?.url) addFailure("github-pr-url-mismatch");
  if (!pr || pr.headRefName !== expected.branch) addFailure("github-pr-branch-mismatch");
  if (!pr || pr.headRefOid !== headSha) addFailure("github-pr-head-mismatch");
  if (!pr || pr.baseRefName !== expected.baseBranch) addFailure("github-pr-base-mismatch");
  if (!pr || pr.state !== "OPEN") addFailure("github-pr-not-open");

  const checksObserved = actions.checksObserved === true &&
    Array.isArray(actions.checks?.checks) &&
    actions.checks.checks.length > 0;
  const checksStatus = actions.checks?.status ?? actions.checksStatus ?? null;
  const checksPassed = checksStatus === "passed";
  if (!checksObserved) addFailure("exact-head-checks-not-observed");
  if (actions.checks?.headSha !== headSha) addFailure("checks-head-mismatch");
  if (checksStatus === "failed") addFailure("checks-failed");
  if (checksStatus !== "passed" && checksStatus !== "pending" && checksStatus !== "failed") {
    addFailure("checks-status-invalid");
  }
  if (actions.checksPassed !== checksPassed) addFailure("checks-pass-claim-invalid");

  if (!projection || !Array.isArray(projection.events)) {
    addFailure("persisted-projection-missing");
  }
  if (!canvasSession || canvasSession.id !== expected.sessionId) {
    addFailure("persisted-session-missing");
  }
  assertRendererDeliveryState(rendererState, "renderer", expected, actions, headSha, addFailure);
  assertRendererDeliveryState(input.reopenedRendererState, "reopened-renderer", expected, actions, headSha, addFailure);
  if (stableJson(rendererState) !== stableJson(input.reopenedRendererState)) {
    addFailure("renderer-reopen-state-mismatch");
  }

  const events = Array.isArray(projection?.events) ? projection.events : [];
  const commitEvents = events.filter((event) =>
    event?.kind === "workflow.commit.created" &&
    eventPayloadLaneId(event) === expected.commitLaneId &&
    event?.payload?.evidence?.commitSha === headSha
  );
  const pushEvents = events.filter((event) =>
    event?.kind === "workflow.delivery.pushed" &&
    eventPayloadLaneId(event) === expected.commitLaneId &&
    event?.payload?.evidence?.commitSha === headSha &&
    event?.payload?.evidence?.branch === expected.branch &&
    event?.payload?.evidence?.remote === expected.remote
  );
  const pullRequestEvents = events.filter((event) =>
    event?.kind === "workflow.pull_request.created" &&
    eventPayloadLaneId(event) === expected.pullRequestLaneId &&
    event?.payload?.commitLaneId === expected.commitLaneId &&
    event?.payload?.evidence?.commitSha === headSha &&
    event?.payload?.evidence?.number === actions.pullRequest?.number
  );
  const checkEvents = events.filter((event) =>
    event?.kind === "workflow.pull_request.checks_recorded" &&
    eventPayloadLaneId(event) === expected.pullRequestLaneId &&
    (event?.payload?.headSha ?? event?.payload?.evidence?.headSha) === headSha &&
    (event?.payload?.prNumber ?? event?.payload?.evidence?.number) === actions.pullRequest?.number
  );
  if (commitEvents.length !== 1) addFailure("commit-event-invalid");
  if (pushEvents.length !== 1) addFailure("push-event-invalid");
  if (pullRequestEvents.length !== 1) addFailure("pull-request-event-invalid");
  if (checkEvents.length < 1) addFailure("checks-event-missing");
  if (!checkEvents.some((event) => {
    const checks = event?.payload?.checks ?? event?.payload?.evidence?.checks;
    return Array.isArray(checks) && checks.length > 0;
  })) addFailure("checks-event-not-observed");

  const eventOrder = [
    events.indexOf(commitEvents[0]),
    events.indexOf(pushEvents[0]),
    events.indexOf(pullRequestEvents[0]),
    events.indexOf(checkEvents.at(-1)),
  ];
  if (
    eventOrder.some((index) => index < 0) ||
    !eventOrder.every((index, position) => position === 0 || eventOrder[position - 1] < index)
  ) {
    addFailure("delivery-event-order-invalid");
  }

  const mergeEventPresent = events.some((event) => event?.kind === "workflow.pull_request.merged");
  const mainSyncEventPresent = events.some((event) => event?.kind === "workflow.delivery.main_synced");
  if (mergeEventPresent) addFailure("merge-event-present");
  if (mainSyncEventPresent) addFailure("main-sync-event-present");

  const projectionEvidence = Array.isArray(projection?.evidence) ? projection.evidence : [];
  if (!projectionEvidence.some((evidence) =>
    evidence?.laneId === expected.commitLaneId &&
    evidence?.kind === "delivery-push" &&
    evidence?.status === "passed" &&
    evidence?.checks?.includes(`head:${headSha}`)
  )) addFailure("push-projection-evidence-invalid");
  if (!projectionEvidence.some((evidence) =>
    evidence?.laneId === expected.pullRequestLaneId &&
    evidence?.kind === "pull-request" &&
    evidence?.status === "passed" &&
    evidence?.checks?.includes(`head:${headSha}`)
  )) addFailure("pull-request-projection-evidence-invalid");
  if (!projectionEvidence.some((evidence) =>
    evidence?.laneId === expected.pullRequestLaneId &&
    evidence?.kind === "pull-request-checks" &&
    evidence?.status === checksStatus
  )) addFailure("checks-projection-evidence-invalid");

  const lanes = Array.isArray(projection?.lanes) ? projection.lanes : [];
  const commitLane = lanes.find((lane) => lane?.id === expected.commitLaneId);
  const pullRequestLane = lanes.find((lane) => lane?.id === expected.pullRequestLaneId);
  if (commitLane?.laneKind !== "commit" || commitLane.status !== "completed") {
    addFailure("commit-lane-lifecycle-invalid");
  }
  if (pullRequestLane?.laneKind !== "pull_request") addFailure("pull-request-lane-kind-invalid");
  const expectedPullRequestCompleted = checksStatus === "passed" &&
    ["approved", "pending"].includes(actions.checks?.review?.status);
  if (expectedPullRequestCompleted && pullRequestLane?.status !== "completed") {
    addFailure("pull-request-lane-not-completed");
  }
  if (!expectedPullRequestCompleted && pullRequestLane?.status === "completed") {
    addFailure("pull-request-lane-completed-without-passed-gate");
  }
  if (!projection?.edges?.some((edge) =>
    edge?.sourceLaneId === expected.commitLaneId &&
    edge?.targetLaneId === expected.pullRequestLaneId
  )) addFailure("pull-request-dependency-missing");
  if (!projection?.segments?.some((segment) =>
    segment?.laneId === expected.commitLaneId && segment?.status === "succeeded"
  )) addFailure("commit-segment-evidence-missing");

  const nodes = Array.isArray(canvasSession?.nodes) ? canvasSession.nodes : [];
  const commitNode = nodes.find((node) => node?.id === expected.commitLaneId);
  const pullRequestNode = nodes.find((node) => node?.id === expected.pullRequestLaneId);
  if (commitNode?.status !== "completed") addFailure("commit-node-lifecycle-invalid");
  if (!arrayEquals(pullRequestNode?.context?.dependencies, [expected.commitLaneId])) {
    addFailure("pull-request-node-dependency-invalid");
  }
  if (!canvasSession?.edges?.some((edge) =>
    edge?.source === expected.commitLaneId &&
    edge?.target === expected.pullRequestLaneId
  )) addFailure("canvas-pull-request-edge-missing");

  return {
    ok: failures.length === 0,
    failures,
    headSha: headSha ?? null,
    checksObserved,
    checksStatus,
    checksPassed,
    noMergeOrMainSync: !mergeEventPresent && !mainSyncEventPresent,
    rendererReopenPreserved: stableJson(rendererState) === stableJson(input.reopenedRendererState),
    eventOrder,
  };
}

function assertRendererDeliveryState(state, prefix, expected, actions, headSha, addFailure) {
  if (!state || typeof state !== "object") {
    addFailure(`${prefix}-state-missing`);
    return;
  }
  if (
    state.session?.title !== candidateDeliveryFixture.sessionTitle ||
    state.session?.activeSidebarTitle !== candidateDeliveryFixture.sessionTitle ||
    state.session?.mode !== "fast"
  ) addFailure(`${prefix}-session-mismatch`);

  const lanes = Array.isArray(state.lanes) ? state.lanes : [];
  const commitLane = lanes.find((lane) => lane?.id === expected.commitLaneId);
  const pullRequestLane = lanes.find((lane) => lane?.id === expected.pullRequestLaneId);
  const expectedPullRequestStatus = actions.checks?.status === "passed" &&
    ["approved", "pending"].includes(actions.checks?.review?.status)
    ? "completed"
    : "pending";
  if (
    commitLane?.title !== "Commit candidate delivery marker" ||
    commitLane?.status !== "completed"
  ) addFailure(`${prefix}-commit-lane-mismatch`);
  if (
    pullRequestLane?.title !== "Create candidate pull request" ||
    pullRequestLane?.status !== expectedPullRequestStatus
  ) {
    addFailure(`${prefix}-pull-request-lane-mismatch`);
  }

  const delivery = state.delivery;
  const expectedCheckStatus = actions.checks?.status === "passed"
    ? "passing"
    : actions.checks?.status === "failed" ? "failing" : "pending";
  if (delivery?.sessionId !== expected.sessionId) addFailure(`${prefix}-session-id-mismatch`);
  if (delivery?.commitLaneId !== expected.commitLaneId) addFailure(`${prefix}-commit-lane-id-mismatch`);
  if (delivery?.pullRequestLaneId !== expected.pullRequestLaneId) {
    addFailure(`${prefix}-pull-request-lane-id-mismatch`);
  }
  if (delivery?.commitSha !== actions.commit?.commitSha) addFailure(`${prefix}-commit-sha-mismatch`);
  if (delivery?.pullRequestHeadSha !== actions.pullRequest?.commitSha) {
    addFailure(`${prefix}-pull-request-head-sha-mismatch`);
  }
  if (delivery?.checksExpectedHeadSha !== actions.checks?.headSha) {
    addFailure(`${prefix}-checks-expected-head-sha-mismatch`);
  }
  if (delivery?.commit !== headSha?.slice(0, 7)) addFailure(`${prefix}-commit-evidence-missing`);
  if (delivery?.branch !== expected.branch) addFailure(`${prefix}-branch-evidence-missing`);
  if (delivery?.prNumber !== actions.pullRequest?.number || delivery?.prUrl !== actions.pullRequest?.url) {
    addFailure(`${prefix}-pull-request-evidence-missing`);
  }
  if (delivery?.headSha !== headSha?.slice(0, 7)) addFailure(`${prefix}-head-evidence-missing`);
  if (
    delivery?.checksStatus !== expectedCheckStatus ||
    delivery?.checksHeadSha !== headSha?.slice(0, 7)
  ) addFailure(`${prefix}-checks-evidence-missing`);
}

export async function cleanupCandidateDeliveryResources({
  cleanupEnabled,
  state,
  run = runCommand,
  remove = rm,
}) {
  const audit = cleanupAudit(state);
  const manualMessage = manualCleanupMessage(audit);
  const hasCleanupTarget = Boolean(
    audit.pr ||
    audit.remoteBranchCreated ||
    audit.localBranchCreated ||
    audit.worktreeCreated ||
    audit.tempRoot,
  );
  if (!hasCleanupTarget) {
    return {
      status: "not-required",
      prClosed: false,
      remoteBranchDeleted: false,
      localBranchDeleted: false,
      localStateRemoved: false,
      audit,
    };
  }
  if (!cleanupEnabled) {
    return {
      status: "manual-cleanup-required",
      prClosed: false,
      remoteBranchDeleted: false,
      localBranchDeleted: false,
      localStateRemoved: false,
      audit,
      message: manualMessage,
    };
  }

  let prClosed = false;
  let remoteBranchDeleted = false;
  let localBranchDeleted = false;
  let localStateRemoved = false;
  try {
    assertCleanupPaths(audit);
    const hasBranchCleanup = audit.remoteBranchCreated || audit.localBranchCreated || audit.pr !== null;
    if (hasBranchCleanup) {
      assertRepoName(audit.repo);
      assertSmokeBranch(audit.branch);
      assertRemoteName(audit.remote);
      if (!isFullCommitSha(audit.headSha)) throw new Error("Cleanup requires the exact candidate head SHA.");
    }

    if (audit.remoteBranchCreated) {
      const remoteHead = await readRemoteBranchHead({
        run,
        cwd: audit.candidateWorktreePath ?? audit.repoRoot,
        remote: audit.remote,
        branch: audit.branch,
      });
      if (remoteHead !== audit.headSha) {
        throw new Error("Refusing to mutate cleanup state when the remote smoke branch is not the exact audited candidate head.");
      }
    }
    if (audit.pr) {
      assertPositivePrNumber(audit.pr.number);
      assertPullRequestAuditTarget(audit);
      await capture(run, "gh", [
        "pr",
        "close",
        String(audit.pr.number),
        "--repo",
        audit.repo,
        "--comment",
        "Closing disposable SkyTurn candidate delivery acceptance PR.",
      ], { cwd: audit.candidateWorktreePath ?? audit.repoRoot });
      const stateResult = await capture(run, "gh", [
        "pr",
        "view",
        String(audit.pr.number),
        "--repo",
        audit.repo,
        "--json",
        "state",
        "--jq",
        ".state",
      ], { cwd: audit.candidateWorktreePath ?? audit.repoRoot });
      if (stateResult.stdout.trim() !== "CLOSED") {
        throw new Error(`Disposable PR #${audit.pr.number} close could not be verified.`);
      }
      prClosed = true;
    }

    if (audit.remoteBranchCreated) {
      await capture(run, "git", [
        "push",
        `--force-with-lease=refs/heads/${audit.branch}:${audit.headSha}`,
        audit.remote,
        `:refs/heads/${audit.branch}`,
      ], { cwd: audit.candidateWorktreePath ?? audit.repoRoot });
      const remainingRemoteHead = await readRemoteBranchHead({
        run,
        cwd: audit.candidateWorktreePath ?? audit.repoRoot,
        remote: audit.remote,
        branch: audit.branch,
      });
      if (remainingRemoteHead !== null) {
        throw new Error("Remote smoke branch deletion could not be verified.");
      }
      remoteBranchDeleted = true;
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

    return {
      status: "cleaned",
      prClosed,
      remoteBranchDeleted,
      localBranchDeleted,
      localStateRemoved,
      audit,
    };
  } catch (error) {
    return {
      status: "cleanup-failed",
      prClosed,
      remoteBranchDeleted,
      localBranchDeleted,
      localStateRemoved,
      audit,
      message: `${safeErrorMessage(error)} ${manualMessage}`,
    };
  }
}

export async function seedCandidateDeliveryStore(config) {
  const { createWorkflowStore } = await import("@skyturn/persistence/workflow-store");
  const now = "2026-07-24T00:00:00.000Z";
  const store = createWorkflowStore({ projectRoot: config.projectRoot });
  try {
    store.createWorkflowSession({
      id: candidateDeliveryFixture.sessionId,
      projectId: candidateDeliveryFixture.projectId,
      title: candidateDeliveryFixture.sessionTitle,
      goal: "Commit, push, open a pull request, and observe exact-head checks through SkyTurn delivery IPC.",
      mode: "fast",
      target: {
        executionTarget: "current_branch",
        selectedBranch: config.branch,
      },
      plannerProfile: "default",
      transport: "hermes_replay_recovery",
      recoveryReason: "Acceptance fixture starts from a completed candidate delivery lane.",
      now,
    });
    store.appendWorkflowEvent({
      sessionId: candidateDeliveryFixture.sessionId,
      kind: "workflow.lane.declared",
      source: "candidate-delivery-acceptance",
      idempotencyKey: "candidate-delivery:commit-lane",
      payload: {
        lane: {
          id: candidateDeliveryFixture.commitLaneId,
          semanticKey: "delivery:candidate-commit",
          semanticSubtype: "commit",
          kind: "commit",
          title: "Commit candidate delivery marker",
          brief: `Commit only ${config.markerFile} after candidate verification.`,
          agentKind: "codex",
          executable: true,
          status: "pending",
          requiredEvidence: [],
          fileScopes: [config.markerFile],
          packageScopes: [],
        },
      },
      now: "2026-07-24T00:00:01.000Z",
    });
    store.appendWorkflowEvent({
      sessionId: candidateDeliveryFixture.sessionId,
      kind: "workflow.lane.declared",
      source: "candidate-delivery-acceptance",
      idempotencyKey: "candidate-delivery:pull-request-lane",
      payload: {
        lane: {
          id: candidateDeliveryFixture.pullRequestLaneId,
          semanticKey: "delivery:candidate-pull-request",
          semanticSubtype: "pull_request",
          kind: "pull_request",
          title: "Create candidate pull request",
          brief: "Create and poll the disposable candidate pull request without merging.",
          agentKind: "codex",
          executable: false,
          status: "pending",
          requiredEvidence: [],
          fileScopes: [],
          packageScopes: [],
        },
      },
      now: "2026-07-24T00:00:02.000Z",
    });
    store.appendWorkflowEvent({
      sessionId: candidateDeliveryFixture.sessionId,
      kind: "workflow.edge.declared",
      source: "candidate-delivery-acceptance",
      idempotencyKey: "candidate-delivery:commit-pr-edge",
      payload: {
        edge: {
          id: candidateDeliveryFixture.edgeId,
          sourceLaneId: candidateDeliveryFixture.commitLaneId,
          targetLaneId: candidateDeliveryFixture.pullRequestLaneId,
        },
      },
      now: "2026-07-24T00:00:03.000Z",
    });

    const scheduled = store.scheduleReadyLanes(candidateDeliveryFixture.sessionId, {
      allowedParallelism: 1,
      authorizedLaneIds: [candidateDeliveryFixture.commitLaneId],
      now: "2026-07-24T00:00:04.000Z",
    });
    if (
      scheduled.readyLanes.length !== 1 ||
      scheduled.readyLanes[0]?.id !== candidateDeliveryFixture.commitLaneId
    ) {
      throw new Error("Candidate commit lane was not scheduled exactly once.");
    }
    const segment = scheduled.readyLanes[0];
    const changesetEvidence = {
      evidenceId: `changeset-evidence:${segment.runId}:after`,
      changesetId: `changeset:${segment.runId}:after`,
      source: "git",
      status: "available",
      files: [config.markerFile],
      diffStat: { added: 1, changed: 0, deleted: 0 },
      patchPreviewTruncated: false,
      collectedAt: "2026-07-24T00:00:05.000Z",
    };
    store.appendWorkflowEvent({
      sessionId: candidateDeliveryFixture.sessionId,
      kind: "workflow.changeset.evidence_recorded",
      source: "candidate-delivery-acceptance",
      laneId: candidateDeliveryFixture.commitLaneId,
      segmentId: segment.segmentId,
      idempotencyKey: `candidate-delivery:changeset:${segment.runId}`,
      payload: {
        laneId: candidateDeliveryFixture.commitLaneId,
        segmentId: segment.segmentId,
        evidence: changesetEvidence,
      },
      now: changesetEvidence.collectedAt,
    });
    const runEvidence = {
      runId: segment.runId,
      status: "succeeded",
      exitCode: 0,
      changesetId: changesetEvidence.changesetId,
      checks: [{
        kind: "run-exit",
        name: "Codex CLI exit",
        status: "passed",
        detail: "Acceptance fixture has a concrete candidate marker ready for explicit delivery.",
      }],
      artifacts: [],
      review: null,
      errorReason: null,
      cancelReason: null,
      completedAt: "2026-07-24T00:00:06.000Z",
    };
    store.recordRunResult({
      sessionId: candidateDeliveryFixture.sessionId,
      laneId: candidateDeliveryFixture.commitLaneId,
      segmentId: segment.segmentId,
      runId: segment.runId,
      agentKind: "codex",
      outputSummary: `Candidate marker ${config.markerFile} is ready for explicit delivery.`,
      evidence: runEvidence,
      now: runEvidence.completedAt,
    });

    const projection = store.materializeFlowProjection(candidateDeliveryFixture.sessionId);
    const canvasSession = store.materializeCanvasSession(candidateDeliveryFixture.sessionId);
    assertSeededCandidateAuthority({ projection, canvasSession, segment, markerFile: config.markerFile });
    const workspace = candidateWorkspaceState({
      projectRoot: config.projectRoot,
      canvasSession,
      segment,
      runEvidence,
      openedAt: now,
    });
    await mkdir(dirname(config.workspacePath), { recursive: true });
    await writeFile(config.workspacePath, `${JSON.stringify(workspace, null, 2)}\n`, "utf8");
    return {
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
  const store = createWorkflowStore({ projectRoot: config.projectRoot });
  try {
    return {
      projection: store.materializeFlowProjection(candidateDeliveryFixture.sessionId),
      canvasSession: store.materializeCanvasSession(candidateDeliveryFixture.sessionId),
    };
  } finally {
    store.close();
  }
}

export async function runCandidateDeliveryAcceptance(options = {}) {
  const env = options.env ?? process.env;
  const write = options.write ?? ((line) => console.log(line));
  const input = parseCandidateDeliveryAcceptanceInput(env, {
    now: options.now,
    randomHex: options.randomHex,
  });
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
    baseHeadBefore: null,
    remote: input.remote,
    branch: input.branch,
    headSha: null,
    pr: null,
    remoteBranchCreated: false,
    localBranchCreated: false,
    worktreeCreated: false,
    candidateWorktreePath: null,
    userDataPath: null,
    tempRoot: null,
  };
  let app = null;
  let cdp = null;
  let actions = null;
  let rendererState = null;
  let reopenedRendererState = null;
  let persistedState = null;
  let remoteAudit = null;
  let oracle = null;
  let failure = null;
  let closeResult = null;
  const restoreCommitIdentity = installCommitIdentityDefaults(env);

  try {
    const preflight = await (services.preflight ?? preflightCandidateDeliveryAcceptance)({
      cwd,
      input,
      run,
    });
    state.repo = preflight.repo;
    state.repoRoot = preflight.repoRoot;
    state.baseBranch = preflight.baseBranch;

    state.tempRoot = await realpath(await (services.makeTempRoot ?? (() =>
      mkdtemp(join(tmpdir(), "skyturn-candidate-delivery-"))
    ))());
    assertIsolatedTempRoot(state.tempRoot, state.repoRoot);
    state.candidateWorktreePath = join(state.tempRoot, "candidate");
    state.userDataPath = join(state.tempRoot, "user-data");
    await mkdir(state.userDataPath, { recursive: true });

    const worktree = await (services.createCandidateWorktree ?? createCandidateWorktree)({
      repoRoot: state.repoRoot,
      candidateWorktreePath: state.candidateWorktreePath,
      branch: state.branch,
      baseBranch: state.baseBranch,
      remote: state.remote,
      run,
      onCreated: (created = {}) => {
        state.localBranchCreated = created.localBranchCreated !== false;
        state.worktreeCreated = created.worktreeCreated !== false;
      },
    });
    state.localBranchCreated = true;
    state.worktreeCreated = true;
    state.baseHeadBefore = worktree.baseHead;
    state.headSha = worktree.baseHead;

    await (services.writeMarker ?? writeCandidateMarker)({
      candidateWorktreePath: state.candidateWorktreePath,
      markerFile: input.markerFile,
      repo: state.repo,
      baseBranch: state.baseBranch,
      branch: state.branch,
    });
    await assertConcreteMarkerChange({
      run,
      candidateWorktreePath: state.candidateWorktreePath,
      markerFile: input.markerFile,
    });

    const workspacePath = join(state.userDataPath, "workspace.json");
    const seeded = await (services.seed ?? runElectronNodeMode)("--seed", {
      projectRoot: state.candidateWorktreePath,
      workspacePath,
      branch: state.branch,
      markerFile: input.markerFile,
    }, run);
    if (
      seeded?.canvasSession?.id !== candidateDeliveryFixture.sessionId ||
      seeded.canvasSession.nodes?.find((node) => node.id === candidateDeliveryFixture.commitLaneId)?.status !== "completed"
    ) {
      throw new Error("Candidate delivery SQLite seed did not produce the completed commit lane.");
    }

    app = await (services.launch ?? launchElectronAcceptanceApp)({
      userData: state.userDataPath,
      projectRoot: state.candidateWorktreePath,
    });
    cdp = await (services.connect ?? connectToReadySkyTurnRenderer)({
      cdpPort: app.cdpPort,
      devServerUrl: app.devServerUrl,
      projectRoot: state.candidateWorktreePath,
      processDiagnostics: app.diagnostics,
    });
    await (services.waitForProject ?? waitForStoredProjectRegistration)(
      cdp,
      state.candidateWorktreePath,
    );

    actions = await (services.invokeActions ?? invokeCandidateDeliveryThroughRenderer)(cdp, {
      projectRoot: state.candidateWorktreePath,
      sessionId: candidateDeliveryFixture.sessionId,
      commitLaneId: candidateDeliveryFixture.commitLaneId,
      pullRequestLaneId: candidateDeliveryFixture.pullRequestLaneId,
      worktreePath: state.candidateWorktreePath,
      markerFile: input.markerFile,
      branch: state.branch,
      baseBranch: state.baseBranch,
      remote: state.remote,
      title: CANDIDATE_DELIVERY_PR_TITLE,
      whatChanged: `Added disposable marker ${input.markerFile}.`,
      why: "Verify SkyTurn delivery IPC against an exact candidate head.",
      breakingChanges: "None.",
      serverPr: "None.",
      maxCheckAttempts: input.maxCheckAttempts,
      pollIntervalMs: input.pollIntervalMs,
      rendererRequestTimeoutMs: input.checkTimeoutMs + 2 * 60 * 1_000,
    });
    applyActionProgressToState(state, actions);
    if (actions?.ok !== true) {
      throw new Error(`${actions?.failure?.code ?? "PUBLIC_DELIVERY_FAILED"}: ${actions?.failure?.message ?? "Public delivery action failed."}`);
    }
    rendererState = await (services.readRendererState ?? readRendererDeliveryState)(
      cdp,
      rendererDeliveryExpectation(state, actions),
    );
  } catch (error) {
    failure = normalizedFailure(error);
  } finally {
    restoreCommitIdentity();
    if (app || cdp) {
      if (app && !cdp && !services.closeApp) {
        closeResult = await app.close().then(() => ({
          ok: true,
          cleanupConfirmed: true,
          diagnostic: null,
        })).catch((error) => ({
          ok: false,
          cleanupConfirmed: false,
          diagnostic: safeErrorMessage(error),
        }));
      } else {
        closeResult = await (services.closeApp ?? finalizeAcceptanceOutcome)({
          app,
          liveCdp: cdp,
          ...(failure ? { error: new Error(failure.diagnostic) } : { ok: true }),
        }).catch((error) => ({
          ok: false,
          cleanupConfirmed: false,
          diagnostic: safeErrorMessage(error),
        }));
      }
      app = null;
      cdp = null;
      if (closeResult?.ok === false && !failure) {
        failure = normalizedFailure(new Error(closeResult.diagnostic ?? "Electron close failed."));
      }
    }
  }

  if (state.worktreeCreated && state.candidateWorktreePath) {
    try {
      persistedState = await (services.inspect ?? runElectronNodeMode)("--inspect", {
        projectRoot: state.candidateWorktreePath,
      }, run);
    } catch (error) {
      failure ??= normalizedFailure(error);
    }
  }

  if (
    state.repoRoot &&
    state.repo &&
    state.baseBranch &&
    (state.localBranchCreated || state.worktreeCreated || actions)
  ) {
    try {
      remoteAudit = await (services.auditRemote ?? auditCandidateRemoteState)({
        run,
        repo: state.repo,
        repoRoot: state.repoRoot,
        candidateWorktreePath: state.worktreeCreated ? state.candidateWorktreePath : null,
        remote: state.remote,
        baseBranch: state.baseBranch,
        branch: state.branch,
        knownPrNumber: actions?.pullRequest?.number ?? state.pr?.number ?? null,
      });
      state.headSha = remoteAudit.localHeadSha ?? state.headSha;
      state.remoteBranchCreated = remoteAudit.remoteHeadSha !== null;
      if (remoteAudit.pullRequest) state.pr = remoteAudit.pullRequest;
    } catch (error) {
      failure ??= normalizedFailure(error);
    }
  }

  if (!failure && actions && rendererState && persistedState && remoteAudit) {
    try {
      app = await (services.launch ?? launchElectronAcceptanceApp)({
        userData: state.userDataPath,
        projectRoot: state.candidateWorktreePath,
      });
      cdp = await (services.connect ?? connectToReadySkyTurnRenderer)({
        cdpPort: app.cdpPort,
        devServerUrl: app.devServerUrl,
        projectRoot: state.candidateWorktreePath,
        processDiagnostics: app.diagnostics,
      });
      await (services.waitForProject ?? waitForStoredProjectRegistration)(
        cdp,
        state.candidateWorktreePath,
      );
      reopenedRendererState = await (services.readRendererState ?? readRendererDeliveryState)(
        cdp,
        rendererDeliveryExpectation(state, actions),
      );
    } catch (error) {
      failure = normalizedFailure(error);
    } finally {
      if (app || cdp) {
        closeResult = await (services.closeApp ?? finalizeAcceptanceOutcome)({
          app,
          liveCdp: cdp,
          ...(failure ? { error: new Error(failure.diagnostic) } : { ok: true }),
        }).catch((error) => ({
          ok: false,
          cleanupConfirmed: false,
          diagnostic: safeErrorMessage(error),
        }));
        app = null;
        cdp = null;
        if (closeResult?.ok === false && !failure) {
          failure = normalizedFailure(new Error(closeResult.diagnostic ?? "Reopened Electron close failed."));
        }
      }
    }
  }

  if (!failure && actions && rendererState && reopenedRendererState && persistedState && remoteAudit) {
    oracle = candidateDeliveryOracle({
      expected: {
        sessionId: candidateDeliveryFixture.sessionId,
        commitLaneId: candidateDeliveryFixture.commitLaneId,
        pullRequestLaneId: candidateDeliveryFixture.pullRequestLaneId,
        branch: state.branch,
        baseBranch: state.baseBranch,
        remote: state.remote,
      },
      actions,
      rendererState,
      reopenedRendererState,
      persistedState,
      localHeadSha: remoteAudit.localHeadSha,
      remoteHeadSha: remoteAudit.remoteHeadSha,
      pullRequest: remoteAudit.pullRequest,
      baseHeadBefore: state.baseHeadBefore,
      baseHeadAfter: remoteAudit.baseHeadSha,
    });
    if (!oracle.ok) {
      failure = normalizedFailure(new Error(`Acceptance predicates failed: ${oracle.failures.join(", ")}.`));
    }
  }

  const cleanup = await (services.cleanup ?? cleanupCandidateDeliveryResources)({
    cleanupEnabled: input.cleanupEnabled,
    state,
    run,
  });
  if (input.cleanupEnabled && cleanup.status !== "cleaned" && cleanup.status !== "not-required") {
    failure ??= normalizedFailure(new Error(cleanup.message ?? "Explicit cleanup failed."));
  }

  let baseHeadAfterCleanup = remoteAudit?.baseHeadSha ?? null;
  if (state.repoRoot && state.baseBranch && cleanup.status === "cleaned") {
    try {
      baseHeadAfterCleanup = await readRemoteBranchHead({
        run,
        cwd: state.repoRoot,
        remote: state.remote,
        branch: state.baseBranch,
        required: true,
      });
      if (baseHeadAfterCleanup !== state.baseHeadBefore) {
        failure ??= normalizedFailure(new Error("Configured base branch changed during cleanup."));
      }
    } catch (error) {
      failure ??= normalizedFailure(error);
    }
  }

  const result = candidateDeliveryResult({
    state,
    input,
    actions,
    persistedState,
    oracle,
    cleanup,
    failure,
    closeResult,
    baseHeadAfterCleanup,
  });
  write(JSON.stringify(result, null, 2));
  return result;
}

async function preflightCandidateDeliveryAcceptance({ cwd, input, run }) {
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
  const repoRoot = await realpath((await capture(run, "git", [
    "rev-parse",
    "--show-toplevel",
  ], { cwd })).stdout.trim());
  const repository = parseJsonObject((await capture(run, "gh", [
    "repo",
    "view",
    "--json",
    "nameWithOwner,defaultBranchRef",
  ], { cwd: repoRoot })).stdout, "GitHub repository preflight returned invalid JSON.");
  const inferredRepo = optionalText(repository.nameWithOwner);
  if (!inferredRepo) throw new Error("GitHub repository preflight did not identify nameWithOwner.");
  assertRepoName(inferredRepo);
  if (input.repo && input.repo.toLowerCase() !== inferredRepo.toLowerCase()) {
    throw new Error(`Configured repo ${input.repo} does not match the opened GitHub repository ${inferredRepo}.`);
  }
  const repo = input.repo ?? inferredRepo;
  const defaultBranch = optionalText(repository.defaultBranchRef?.name);
  const baseBranch = input.baseBranch ?? defaultBranch;
  if (!baseBranch) throw new Error("GitHub repository preflight did not identify a base branch.");
  assertBranchName(baseBranch, "base branch");
  await capture(run, "git", ["check-ref-format", "--branch", baseBranch], { cwd: repoRoot });
  const remoteUrl = (await capture(run, "git", [
    "remote",
    "get-url",
    input.remote,
  ], { cwd: repoRoot })).stdout.trim();
  const remoteRepo = githubRepoFromRemoteUrl(remoteUrl);
  if (!remoteRepo || remoteRepo.toLowerCase() !== repo.toLowerCase()) {
    throw new Error(`Git remote ${input.remote} does not resolve to the configured GitHub repository ${repo}.`);
  }
  await readRemoteBranchHead({
    run,
    cwd: repoRoot,
    remote: input.remote,
    branch: baseBranch,
    required: true,
  });
  return { repoRoot, repo, baseBranch };
}

async function createCandidateWorktree({
  repoRoot,
  candidateWorktreePath,
  branch,
  baseBranch,
  remote,
  run,
  onCreated = () => {},
}) {
  assertSmokeBranch(branch);
  await capture(run, "git", [
    "fetch",
    "--no-tags",
    remote,
    `refs/heads/${baseBranch}`,
  ], { cwd: repoRoot });
  const baseHead = (await capture(run, "git", [
    "rev-parse",
    "FETCH_HEAD^{commit}",
  ], { cwd: repoRoot })).stdout.trim().toLowerCase();
  if (!isFullCommitSha(baseHead)) throw new Error("Fetched GitHub base did not resolve to a full commit SHA.");
  const remoteBaseHead = await readRemoteBranchHead({
    run,
    cwd: repoRoot,
    remote,
    branch: baseBranch,
    required: true,
  });
  if (remoteBaseHead !== baseHead) {
    throw new Error("Configured GitHub base moved between fetch and candidate worktree creation.");
  }
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
    const [localBranch, worktreeList] = await Promise.all([
      tryCapture(run, "git", [
        "rev-parse",
        "--verify",
        `refs/heads/${branch}^{commit}`,
      ], { cwd: repoRoot }),
      tryCapture(run, "git", ["worktree", "list", "--porcelain"], { cwd: repoRoot }),
    ]);
    const expectedWorktreeLine = `worktree ${candidateWorktreePath}`;
    onCreated({
      localBranchCreated: isFullCommitSha(localBranch?.stdout.trim()),
      worktreeCreated: worktreeList?.stdout.split("\n").includes(expectedWorktreeLine) === true,
    });
    throw error;
  }
  onCreated({ localBranchCreated: true, worktreeCreated: true });
  const [actualBranch, actualHead] = await Promise.all([
    capture(run, "git", ["branch", "--show-current"], { cwd: candidateWorktreePath }),
    capture(run, "git", ["rev-parse", "HEAD^{commit}"], { cwd: candidateWorktreePath }),
  ]);
  if (actualBranch.stdout.trim() !== branch || actualHead.stdout.trim().toLowerCase() !== baseHead) {
    throw new Error("Candidate worktree identity does not match the generated branch and fetched base.");
  }
  return { baseHead };
}

async function writeCandidateMarker({
  candidateWorktreePath,
  markerFile,
  repo,
  baseBranch,
  branch,
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
    "This disposable marker must be committed through the public SkyTurn workflow API.",
    "",
  ].join("\n"), "utf8");
}

async function assertConcreteMarkerChange({ run, candidateWorktreePath, markerFile }) {
  const status = (await capture(run, "git", [
    "status",
    "--porcelain=v1",
    "--untracked-files=all",
    "--",
    markerFile,
  ], { cwd: candidateWorktreePath })).stdout.trim();
  if (status !== `?? ${markerFile}`) {
    throw new Error(`Candidate marker is not one exact untracked git change: ${markerFile}.`);
  }
}

async function invokeCandidateDeliveryThroughRenderer(cdp, input) {
  const requestTimeoutMs = input.rendererRequestTimeoutMs;
  const publicInput = { ...input };
  delete publicInput.rendererRequestTimeoutMs;
  return await cdp.evaluate(buildRendererDeliveryInvocation(publicInput), {
    awaitPromise: true,
    returnByValue: true,
    requestTimeoutMs,
  });
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
            try {
              result = probe();
            } catch (error) {
              reject(error);
              return;
            }
            if (result) {
              resolve(result);
              return;
            }
            if (Date.now() > deadline) {
              reject(new Error('Timed out waiting for renderer ' + label));
              return;
            }
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
        return node && shell ? {
          id,
          title: text(node.querySelector('.agent-node-title')),
          status: shell.getAttribute('data-state'),
        } : null;
      };
      const facts = () => {
        const panel = document.querySelector('section.delivery-panel[aria-label="Delivery lifecycle"]');
        if (!panel) return null;
        const entries = [...panel.querySelectorAll('.delivery-facts > div')].map((entry) => [
          text(entry.querySelector('dt')),
          text(entry.querySelector('dd')),
        ]);
        const byLabel = Object.fromEntries(entries);
        const prLink = panel.querySelector('.delivery-facts a[href]');
        const checks = byLabel.Checks?.match(/^(passing|pending|failing) @ ([0-9a-f]{7})$/i);
        return {
          sessionId: panel.getAttribute('data-delivery-session-id'),
          commitLaneId: panel.getAttribute('data-delivery-commit-lane-id'),
          pullRequestLaneId: panel.getAttribute('data-delivery-pull-request-lane-id'),
          commitSha: panel.getAttribute('data-delivery-commit-sha'),
          pullRequestHeadSha: panel.getAttribute('data-delivery-pull-request-head-sha'),
          checksExpectedHeadSha: panel.getAttribute('data-delivery-checks-expected-head-sha'),
          commit: byLabel.Commit ?? null,
          branch: byLabel.Branch ?? null,
          prNumber: /^#([1-9][0-9]*)$/.test(byLabel.PR ?? '') ? Number(byLabel.PR.slice(1)) : null,
          prUrl: prLink?.href ?? null,
          headSha: byLabel['Head SHA'] ?? null,
          checksStatus: checks?.[1]?.toLowerCase() ?? null,
          checksHeadSha: checks?.[2]?.toLowerCase() ?? null,
        };
      };

      await waitFor(() => {
        const title = text(document.querySelector('.topbar-field[aria-label="Session title"] .title-edit-button'));
        const activeSidebarTitle = text(document.querySelector('.sidebar-session-row.active .sidebar-session-title'));
        return title === sessionTitle && activeSidebarTitle === sessionTitle &&
          lane(expected.commitLaneId) && lane(expected.pullRequestLaneId);
      }, 'candidate canvas session');

      const commitNode = flowNode(expected.commitLaneId);
      const more = commitNode.querySelector('button[aria-label^="More details for "]');
      if (!more) throw new Error('Renderer commit lane details control is missing.');
      more.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, view: window }));
      const changesTab = await waitFor(() => [...document.querySelectorAll('.node-modal .modal-tabs button')]
        .find((button) => text(button) === 'Changes'), 'Changes tab');
      changesTab.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, view: window }));

      const delivery = await waitFor(() => {
        const current = facts();
        return current &&
          current.sessionId === expected.sessionId &&
          current.commitLaneId === expected.commitLaneId &&
          current.pullRequestLaneId === expected.pullRequestLaneId &&
          current.commitSha === expected.commitSha &&
          current.pullRequestHeadSha === expected.pullRequestHeadSha &&
          current.checksExpectedHeadSha === expected.checksExpectedHeadSha &&
          current.commit === expected.commitSha.slice(0, 7) &&
          current.branch === expected.branch &&
          current.prNumber === expected.prNumber &&
          current.prUrl === expected.prUrl &&
          current.headSha === expected.pullRequestHeadSha.slice(0, 7) &&
          current.checksStatus === expected.checksStatus &&
          current.checksHeadSha === expected.checksExpectedHeadSha.slice(0, 7)
          ? current
          : null;
      }, 'delivery evidence');

      return {
        session: {
          title: text(document.querySelector('.topbar-field[aria-label="Session title"] .title-edit-button')),
          activeSidebarTitle: text(document.querySelector('.sidebar-session-row.active .sidebar-session-title')),
          mode: text(document.querySelector('.topbar-field[aria-label="Session type"] .session-type-value')),
          sidebarSessionCount: document.querySelectorAll('.sidebar-session-row').length,
          canvasLaneCount: document.querySelectorAll('.react-flow__node').length,
        },
        lanes: [lane(expected.commitLaneId), lane(expected.pullRequestLaneId)],
        delivery,
      };
    })()
  `, { awaitPromise: true, returnByValue: true });
  if (!value?.session || !Array.isArray(value?.lanes) || !value?.delivery) {
    throw new Error("Renderer candidate delivery canvas semantics are unavailable.");
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
  const cwd = candidateWorktreePath ?? repoRoot;
  const localHeadRef = candidateWorktreePath ? "HEAD^{commit}" : `refs/heads/${branch}^{commit}`;
  const [localHeadResult, remoteHeadSha, baseHeadSha] = await Promise.all([
    capture(run, "git", ["rev-parse", "--verify", localHeadRef], { cwd }),
    readRemoteBranchHead({ run, cwd, remote, branch }),
    readRemoteBranchHead({ run, cwd, remote, branch: baseBranch, required: true }),
  ]);
  const localHeadSha = localHeadResult.stdout.trim().toLowerCase();
  if (!isFullCommitSha(localHeadSha)) throw new Error("Candidate worktree HEAD is not a full commit SHA.");

  let pullRequest = null;
  if (knownPrNumber) {
    const value = parseJsonObject((await capture(run, "gh", [
      "pr",
      "view",
      String(knownPrNumber),
      "--repo",
      repo,
      "--json",
      "number,url,headRefName,headRefOid,baseRefName,state",
    ], { cwd })).stdout, "GitHub pull request audit returned invalid JSON.");
    pullRequest = normalizePullRequestAudit(value);
  } else if (remoteHeadSha) {
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
      "20",
      "--json",
      "number,url,headRefName,headRefOid,baseRefName,state",
    ], { cwd })).stdout, "GitHub pull request list audit returned invalid JSON.")
      .map(normalizePullRequestAudit)
      .filter((candidate) =>
        candidate.headRefName === branch &&
        candidate.headRefOid === remoteHeadSha &&
        candidate.baseRefName === baseBranch
      );
    if (values.length > 1) throw new Error("Multiple disposable pull requests match the exact candidate head.");
    pullRequest = values[0] ?? null;
  }

  return {
    localHeadSha,
    remoteHeadSha,
    baseHeadSha,
    pullRequest,
  };
}

async function runElectronNodeMode(mode, config, run = runCommand) {
  const electronBinary = require("electron");
  const result = await capture(run, electronBinary, [
    scriptPath,
    mode,
    JSON.stringify(config),
  ], {
    cwd: dirname(scriptPath),
    env: { ...process.env, ELECTRON_RUN_AS_NODE: "1" },
  });
  const prefix = mode === "--seed" ? seedResultPrefix : inspectResultPrefix;
  const line = result.stdout.split("\n").find((candidate) => candidate.startsWith(prefix));
  if (!line) throw new Error(`Electron ${mode} did not return a structured candidate delivery result.`);
  return parseJson(line.slice(prefix.length), `Electron ${mode} returned invalid candidate delivery JSON.`);
}

function assertSeededCandidateAuthority({ projection, canvasSession, segment, markerFile }) {
  if (!projection || !canvasSession) throw new Error("Candidate delivery session did not materialize.");
  const commitLane = projection.lanes?.find((lane) => lane.id === candidateDeliveryFixture.commitLaneId);
  const pullRequestLane = projection.lanes?.find((lane) => lane.id === candidateDeliveryFixture.pullRequestLaneId);
  if (commitLane?.laneKind !== "commit" || commitLane.status !== "completed") {
    throw new Error("Seeded candidate commit lane is not completed.");
  }
  if (
    pullRequestLane?.laneKind !== "pull_request" ||
    pullRequestLane.status !== "pending" ||
    pullRequestLane.executable !== false
  ) {
    throw new Error("Seeded candidate pull request lane is not a pending non-executable delivery gate.");
  }
  if (!projection.edges?.some((edge) =>
    edge.sourceLaneId === candidateDeliveryFixture.commitLaneId &&
    edge.targetLaneId === candidateDeliveryFixture.pullRequestLaneId
  )) throw new Error("Seeded candidate pull request dependency is missing.");
  if (!projection.segments?.some((candidate) =>
    candidate.id === segment.segmentId &&
    candidate.runId === segment.runId &&
    candidate.laneId === candidateDeliveryFixture.commitLaneId &&
    candidate.status === "succeeded"
  )) throw new Error("Seeded candidate commit segment is not succeeded.");
  if (!projection.changesetEvidence?.some((evidence) =>
    evidence.status === "available" &&
    arrayEquals(evidence.files, [markerFile])
  )) throw new Error("Seeded candidate marker changeset evidence is missing.");
  if (projection.events?.some((event) => [
    "workflow.commit.created",
    "workflow.delivery.pushed",
    "workflow.pull_request.created",
    "workflow.pull_request.checks_recorded",
    "workflow.pull_request.merged",
    "workflow.delivery.main_synced",
  ].includes(event.kind))) {
    throw new Error("Seeded candidate projection already contains delivery side effects.");
  }
  const commitNode = canvasSession.nodes?.find((node) => node.id === candidateDeliveryFixture.commitLaneId);
  const pullRequestNode = canvasSession.nodes?.find((node) => node.id === candidateDeliveryFixture.pullRequestLaneId);
  if (commitNode?.status !== "completed" || commitNode?.worktree?.path !== ".") {
    throw new Error("Seeded candidate commit node is not bound to the opened current branch.");
  }
  if (!arrayEquals(pullRequestNode?.context?.dependencies, [candidateDeliveryFixture.commitLaneId])) {
    throw new Error("Seeded candidate pull request node dependency is invalid.");
  }
}

function candidateWorkspaceState({ projectRoot, canvasSession, segment, runEvidence, openedAt }) {
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
    nodeId: candidateDeliveryFixture.commitLaneId,
    sessionId: candidateDeliveryFixture.sessionId,
    projectRoot,
    worktreePath: projectRoot,
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

function applyActionProgressToState(state, actions) {
  if (isFullCommitSha(actions?.commit?.commitSha)) state.headSha = actions.commit.commitSha;
  if (actions?.push?.status === "pushed") state.remoteBranchCreated = true;
  if (actions?.pullRequest?.number && actions?.pullRequest?.url) {
    state.pr = {
      number: actions.pullRequest.number,
      url: actions.pullRequest.url,
    };
  }
}

function rendererDeliveryExpectation(state, actions) {
  const checksStatus = actions.checks?.status === "passed"
    ? "passing"
    : actions.checks?.status === "failed" ? "failing" : "pending";
  return {
    sessionId: candidateDeliveryFixture.sessionId,
    commitLaneId: candidateDeliveryFixture.commitLaneId,
    pullRequestLaneId: candidateDeliveryFixture.pullRequestLaneId,
    commitSha: actions.commit.commitSha,
    pullRequestHeadSha: actions.pullRequest.commitSha,
    checksExpectedHeadSha: actions.checks.headSha,
    branch: state.branch,
    prNumber: actions.pullRequest.number,
    prUrl: actions.pullRequest.url,
    checksStatus,
  };
}

function candidateDeliveryResult({
  state,
  input,
  actions,
  persistedState,
  oracle,
  cleanup,
  failure,
  closeResult,
  baseHeadAfterCleanup,
}) {
  const events = Array.isArray(persistedState?.projection?.events)
    ? persistedState.projection.events
    : [];
  const nodes = Array.isArray(persistedState?.canvasSession?.nodes)
    ? persistedState.canvasSession.nodes
    : [];
  const ok = failure === null;
  return {
    ok,
    status: ok ? (cleanup.status === "cleaned" ? "cleaned" : "created") : "failed",
    failure,
    repository: state.repo,
    baseBranch: state.baseBranch,
    baseHeadBefore: state.baseHeadBefore,
    baseHeadAfter: baseHeadAfterCleanup,
    branch: state.branch,
    headSha: state.headSha,
    remote: state.remote,
    pullRequest: state.pr,
    checks: {
      observed: actions?.checksObserved === true,
      status: actions?.checksStatus ?? actions?.checks?.status ?? null,
      passed: actions?.checksStatus === "passed" || actions?.checks?.status === "passed",
      attempts: actions?.checkAttempts ?? 0,
    },
    authority: {
      sessionId: candidateDeliveryFixture.sessionId,
      actionOrder: actions?.actionOrder ?? [],
      eventKinds: events.map((event) => event.kind),
      laneStatuses: nodes
        .filter((node) => [
          candidateDeliveryFixture.commitLaneId,
          candidateDeliveryFixture.pullRequestLaneId,
        ].includes(node.id))
        .map((node) => ({ id: node.id, status: node.status })),
      noMergeOrMainSync: oracle?.noMergeOrMainSync ??
        !events.some((event) => [
          "workflow.pull_request.merged",
          "workflow.delivery.main_synced",
        ].includes(event.kind)),
      persisted: Boolean(persistedState?.projection && persistedState?.canvasSession),
    },
    oracle,
    cleanup,
    resources: {
      candidateWorktreePath: state.candidateWorktreePath,
      userDataPath: state.userDataPath,
      tempRoot: state.tempRoot,
      cleanupRequested: input.cleanupEnabled,
    },
    electronClose: closeResult ? {
      ok: closeResult.ok === true,
      cleanupConfirmed: closeResult.cleanupConfirmed === true,
      diagnostic: closeResult.diagnostic
        ? boundedDiagnostic(sanitizeDiagnostic(closeResult.diagnostic))
        : null,
    } : null,
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
    pr: state?.pr ? {
      number: state.pr.number,
      url: state.pr.url,
      headRefName: state.pr.headRefName,
      headRefOid: state.pr.headRefOid,
      baseRefName: state.pr.baseRefName,
      state: state.pr.state,
    } : null,
    remoteBranchCreated: state?.remoteBranchCreated === true,
    localBranchCreated: state?.localBranchCreated === true,
    worktreeCreated: state?.worktreeCreated === true,
    candidateWorktreePath: state?.candidateWorktreePath ?? null,
    userDataPath: state?.userDataPath ?? null,
    tempRoot: state?.tempRoot ?? null,
  };
}

function manualCleanupMessage(audit) {
  const pr = audit.pr
    ? `close disposable PR #${audit.pr.number} (${audit.pr.url}) in ${audit.repo}`
    : "no pull request was recorded";
  const remoteBranch = audit.remoteBranchCreated
    ? `delete only remote branch ${audit.remote}/${audit.branch} after verifying exact head ${audit.headSha}`
    : "no remote branch was observed";
  const local = [
    audit.candidateWorktreePath ? `remove candidate worktree ${audit.candidateWorktreePath}` : null,
    audit.localBranchCreated ? `delete only local branch ${audit.branch}` : null,
    audit.userDataPath ? `remove isolated userData ${audit.userDataPath}` : null,
    audit.tempRoot ? `remove temporary root ${audit.tempRoot}` : null,
  ].filter(Boolean).join("; ");
  return `Manual cleanup required: ${pr}; ${remoteBranch}${local ? `; ${local}` : ""}.`;
}

function assertCleanupPaths(audit) {
  if (!audit.repoRoot || !isAbsolute(audit.repoRoot)) throw new Error("Cleanup repo root is invalid.");
  if (!audit.tempRoot) return;
  if (!isAbsolute(audit.tempRoot) || resolve(audit.tempRoot) === resolve(sep)) {
    throw new Error("Cleanup temporary root is unsafe.");
  }
  for (const candidate of [audit.candidateWorktreePath, audit.userDataPath]) {
    if (candidate && !isPathWithin(candidate, audit.tempRoot)) {
      throw new Error("Cleanup path escapes the isolated temporary root.");
    }
  }
}

function assertIsolatedTempRoot(tempRoot, repoRoot) {
  const resolvedTempRoot = resolve(tempRoot);
  const resolvedRepoRoot = resolve(repoRoot);
  if (
    resolvedTempRoot === resolvedRepoRoot ||
    isPathWithin(resolvedTempRoot, resolvedRepoRoot) ||
    isPathWithin(resolvedRepoRoot, resolvedTempRoot)
  ) {
    throw new Error("Candidate acceptance temporary state must stay outside the source repository.");
  }
}

function assertPullRequestAuditTarget(audit) {
  const url = optionalText(audit.pr?.url);
  if (!url) throw new Error("Cleanup pull request URL is missing.");
  let pathname;
  try {
    pathname = new URL(url).pathname.replace(/\/+$/, "");
  } catch {
    throw new Error("Cleanup pull request URL is invalid.");
  }
  const expectedPath = `/${audit.repo}/pull/${audit.pr.number}`.toLowerCase();
  if (pathname.toLowerCase() !== expectedPath) {
    throw new Error("Refusing to close a pull request outside the exact audited repository and number.");
  }
  if (audit.pr.headRefName !== audit.branch) {
    throw new Error("Refusing to close a pull request whose audited head branch is not the disposable smoke branch.");
  }
  if (!isFullCommitSha(audit.pr.headRefOid) || audit.pr.headRefOid.toLowerCase() !== audit.headSha) {
    throw new Error("Refusing to close a pull request whose audited head SHA is not the exact candidate head.");
  }
  if (audit.pr.baseRefName !== audit.baseBranch) {
    throw new Error("Refusing to close a pull request whose audited base branch is not the configured base.");
  }
  if (audit.pr.state !== "OPEN") {
    throw new Error("Refusing to close a pull request that was not independently audited as OPEN.");
  }
}

async function readRemoteBranchHead({
  run,
  cwd,
  remote,
  branch,
  required = false,
}) {
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
  const url = optionalText(value.url);
  const headRefName = optionalText(value.headRefName);
  const headRefOid = optionalText(value.headRefOid)?.toLowerCase();
  const baseRefName = optionalText(value.baseRefName);
  const state = optionalText(value.state)?.toUpperCase();
  if (!url || !headRefName || !isFullCommitSha(headRefOid) || !baseRefName || !state) {
    throw new Error("GitHub pull request audit record is incomplete.");
  }
  return { number, url, headRefName, headRefOid, baseRefName, state };
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
  return {
    stdout: String(result?.stdout ?? ""),
    stderr: String(result?.stderr ?? ""),
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
      stderr: String(result.stderr ?? ""),
    };
  } catch (error) {
    const failure = error;
    const exit = typeof failure.code === "number" ? failure.code : "failed";
    const commandName = basename(String(command));
    const detail = commandName === "gh"
      ? ""
      : boundedDiagnostic(sanitizeDiagnostic(
        String(failure.stderr || failure.stdout || failure.message || ""),
      ));
    throw new Error(`${commandName} ${safeCommandAction(args)} failed (${exit})${detail ? `: ${detail}` : ""}.`);
  }
}

function normalizedFailure(error) {
  return {
    code: "CANDIDATE_DELIVERY_ACCEPTANCE_FAILED",
    message: "Real candidate-worktree delivery acceptance failed.",
    diagnostic: boundedDiagnostic(safeErrorMessage(error)),
  };
}

function safeErrorMessage(error) {
  return sanitizeDiagnostic(error instanceof Error ? error.message : String(error));
}

function sanitizeDiagnostic(value) {
  return String(value)
    .replace(/-----BEGIN [^-]+PRIVATE KEY-----[\s\S]*?-----END [^-]+PRIVATE KEY-----/g, "[REDACTED_PRIVATE_KEY]")
    .replace(/\b(?:gh[pousr]_[A-Za-z0-9_]+|github_pat_[A-Za-z0-9_]+)\b/g, "[REDACTED_GITHUB_TOKEN]")
    .replace(/\b(authorization)\b\s*[:=]\s*bearer\s+[^\s"',;}\]]+/gi, "$1: Bearer [REDACTED]")
    .replace(/\b(token|secret|password|api[_-]?key|cookie)\b\s*[:=]\s*[^\s"',;}\]]+/gi, "$1=[REDACTED]")
    .replace(/\b[A-Za-z][A-Za-z0-9+.-]*:\/\/[^\s/@:]+:[^\s/@]+@[^\s]+/g, "[REDACTED_URL]");
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
  const remote = String(value).trim();
  let pathname = null;
  try {
    const url = new URL(remote);
    pathname = url.pathname;
  } catch {
    const scp = remote.match(/^(?:[^@]+@)?[^:]+:(.+)$/);
    if (scp) pathname = scp[1];
  }
  if (!pathname) return null;
  const normalized = pathname.replace(/^\/+/, "").replace(/\.git$/i, "");
  const segments = normalized.split("/").filter(Boolean);
  if (segments.length !== 2) return null;
  const repo = `${segments[0]}/${segments[1]}`;
  try {
    assertRepoName(repo);
    return repo;
  } catch {
    return null;
  }
}

function assertRepoName(repo) {
  if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(repo)) {
    throw new Error(`Invalid GitHub repo: ${repo}.`);
  }
}

function assertRemoteName(remote) {
  if (!/^[A-Za-z0-9._-]+$/.test(remote)) {
    throw new Error("Delivery acceptance remote must be a git remote name.");
  }
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
    branch.split("/").some((component) => !component || component.startsWith(".") || component.endsWith(".lock"))
  ) {
    throw new Error(`Invalid ${label}: ${branch}.`);
  }
}

function assertSmokeBranch(branch) {
  if (!/^skyturn\/smoke\/[0-9]{8}T[0-9]{6}Z-[0-9a-f]{6,16}$/.test(branch)) {
    throw new Error(`Refusing to cleanup non-smoke branch: ${branch}.`);
  }
}

function assertPositivePrNumber(value) {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new Error(`Invalid pull request number: ${value}.`);
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

function optionalText(value) {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function isFullCommitSha(value) {
  return typeof value === "string" && /^[0-9a-f]{40}$/i.test(value);
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

function eventPayloadLaneId(event) {
  return event?.laneId ?? event?.payload?.laneId ?? null;
}

function arrayEquals(actual, expected) {
  return Array.isArray(actual) &&
    actual.length === expected.length &&
    actual.every((value, index) => value === expected[index]);
}

function stableJson(value) {
  return JSON.stringify(value, (_key, nested) => {
    if (!nested || typeof nested !== "object" || Array.isArray(nested)) return nested;
    return Object.fromEntries(Object.entries(nested).sort(([left], [right]) => left.localeCompare(right)));
  });
}

function isPathWithin(candidate, parent) {
  const relativePath = relative(resolve(parent), resolve(candidate));
  return relativePath !== "" &&
    relativePath !== ".." &&
    !relativePath.startsWith(`..${sep}`) &&
    !isAbsolute(relativePath);
}

async function runRuntimeMode() {
  const mode = process.argv[2];
  if (mode !== "--seed" && mode !== "--inspect") return false;
  const config = parseJson(process.argv[3] ?? "null", "Candidate delivery runtime config is invalid.");
  if (mode === "--seed") {
    console.log(`${seedResultPrefix}${JSON.stringify(await seedCandidateDeliveryStore(config))}`);
  } else {
    console.log(`${inspectResultPrefix}${JSON.stringify(await inspectCandidateDeliveryStore(config))}`);
  }
  return true;
}

if (process.argv[1] === scriptPath) {
  runRuntimeMode().then(async (handled) => {
    if (handled) return;
    const result = await runCandidateDeliveryAcceptance();
    if (result.status !== "skipped" && result.ok !== true) process.exitCode = 1;
  }).catch((error) => {
    console.error(`FAILED: ${boundedDiagnostic(safeErrorMessage(error))}`);
    process.exitCode = 1;
  });
}
