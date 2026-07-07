export type DeliveryBusyAction = "commit" | "push" | "create-pr" | "check-pr" | "merge" | "sync" | "cleanup";
export type PullRequestCheckStatus = "passing" | "failing" | "pending";
export type PullRequestReviewStatus = "approved" | "changes_requested" | "pending" | "unknown";

export interface DeliveryPanelBackendAvailability {
  commit: boolean;
  push: boolean;
  createPr: boolean;
  checkPr: boolean;
  merge: boolean;
  sync: boolean;
  cleanup: boolean;
}

export interface DeliveryCommitSummary {
  commitSha?: string;
  branch?: string;
  worktreePath?: string;
  subject?: string;
}

export interface DeliveryPushSummary {
  remote?: string;
  branch?: string;
  commitSha?: string;
}

export interface DeliveryPullRequestSummary {
  number: number;
  url?: string;
  headSha?: string;
  title?: string;
}

export interface DeliveryPullRequestChecks {
  checkStatus: PullRequestCheckStatus;
  reviewStatus: PullRequestReviewStatus;
  expectedHeadSha?: string;
  mergeable: boolean;
}

export interface DeliveryPanelInput {
  isCommitLane: boolean;
  hasGitEvidence: boolean;
  hasGitChanges: boolean;
  backend: DeliveryPanelBackendAvailability;
  commitEvidence: DeliveryCommitSummary | null;
  pushEvidence: DeliveryPushSummary | null;
  pullRequest: DeliveryPullRequestSummary | null;
  checks: DeliveryPullRequestChecks | null;
  mergeTitle: string;
  mergeConfirmed: boolean;
  mergeComplete: boolean;
  syncComplete: boolean;
  syncConfirmed: boolean;
  cleanupExplicitlyAllowed: boolean;
  cleanupConfirmed: boolean;
  deleteBranch: boolean;
  deleteBranchConfirmed: boolean;
  busyAction: DeliveryBusyAction | null;
}

export type DeliveryStepStatus = "ready" | "blocked" | "done" | "stale" | "pending";
export type DeliveryGateKey = "commit" | "push" | "pr" | "checks" | "review" | "merge" | "sync" | "cleanup" | "delete-branch";
export type DeliveryGateStatus = DeliveryStepStatus | "safe";

export interface DeliveryStepState {
  status: DeliveryStepStatus;
  blockedMessage?: string;
}

export interface DeliveryGateCopy {
  key: DeliveryGateKey;
  label: string;
  status: DeliveryGateStatus;
  summary: string;
  detail?: string;
}

export interface DeliveryPanelState {
  canCommit: boolean;
  canPush: boolean;
  canCreatePr: boolean;
  canCheckPr: boolean;
  exactHeadChecksPassed: boolean;
  mergeReady: boolean;
  canMerge: boolean;
  canSync: boolean;
  canCleanup: boolean;
  deleteBranchRequested: boolean;
  prCreatedCompletesTask: boolean;

  commitStep: DeliveryStepState;
  pushStep: DeliveryStepState;
  prStep: DeliveryStepState;
  checkStep: DeliveryStepState;
  reviewStep: DeliveryStepState;
  mergeStep: DeliveryStepState;
  syncStep: DeliveryStepState;
  cleanupStep: DeliveryStepState;
  gateList: DeliveryGateCopy[];
}

export interface DeliveryLifecycleHydrationOptions {
  commitLaneId: string;
  pullRequestLaneId?: string;
}

export interface DeliveryLifecycleHydration {
  commitEvidence: DeliveryCommitSummary | null;
  pushEvidence: DeliveryPushSummary | null;
  pullRequest: DeliveryPullRequestSummary | null;
  checks: DeliveryPullRequestChecks | null;
  mergeComplete: boolean;
  syncComplete: boolean;
}

export function buildDeliveryPanelState(input: DeliveryPanelInput): DeliveryPanelState {
  const hasCommit = !!input.commitEvidence;
  const hasPushedBranch = !!input.pushEvidence;
  const hasPullRequest = !!input.pullRequest;
  const headSha = input.pullRequest?.headSha;
  const expectedHeadSha = input.checks?.expectedHeadSha;

  const isStaleChecks = !!expectedHeadSha && !!headSha && headSha !== expectedHeadSha;
  const hasExactHeadCheckTarget = !!expectedHeadSha && !!headSha;

  const exactHeadChecksPassed =
    input.checks?.checkStatus === "passing" &&
    !!expectedHeadSha &&
    !!headSha &&
    headSha === expectedHeadSha;

  const reviewStatus = input.checks?.reviewStatus;
  const reviewChangesRequested = reviewStatus === "changes_requested";
  const reviewStatusKnown = reviewStatus === "approved" || reviewStatus === "pending";

  const mergeReady =
    hasPullRequest &&
    exactHeadChecksPassed &&
    input.checks?.mergeable === true &&
    reviewStatusKnown &&
    !reviewChangesRequested;
  const cleanupAllowed = input.mergeComplete || input.syncComplete || input.cleanupExplicitlyAllowed;
  const deleteBranchBlocked = input.deleteBranch && !input.deleteBranchConfirmed;

  const commitStep: DeliveryStepState = { status: "blocked", blockedMessage: "no commit evidence" };
  const pushStep: DeliveryStepState = { status: "blocked", blockedMessage: "no commit evidence" };
  const prStep: DeliveryStepState = { status: "blocked", blockedMessage: "no pushed branch" };
  const checkStep: DeliveryStepState = { status: "blocked", blockedMessage: "PR not created" };
  const reviewStep: DeliveryStepState = { status: "blocked", blockedMessage: "PR not created" };
  const mergeStep: DeliveryStepState = { status: "blocked", blockedMessage: "PR not created" };
  const syncStep: DeliveryStepState = { status: "blocked", blockedMessage: "merge not complete" };
  const cleanupStep: DeliveryStepState = { status: "blocked", blockedMessage: "cleanup not confirmed" };

  if (hasCommit) {
    commitStep.status = "done";
  } else if (input.isCommitLane && input.hasGitEvidence && input.hasGitChanges) {
    commitStep.status = input.busyAction === "commit" ? "pending" : "ready";
  } else {
    commitStep.status = "blocked";
    commitStep.blockedMessage = "no git changes";
  }

  if (hasPullRequest) {
    pushStep.status = "blocked";
    pushStep.blockedMessage = "PR already exists";
  } else if (hasPushedBranch && input.pushEvidence?.commitSha === input.commitEvidence?.commitSha) {
    pushStep.status = "done";
  } else if (hasCommit) {
    pushStep.status = input.busyAction === "push" ? "pending" : "ready";
  } else {
    pushStep.status = "blocked";
    pushStep.blockedMessage = "no commit evidence";
  }

  if (hasPullRequest) {
    prStep.status = "done";
  } else if (hasPushedBranch && !!input.commitEvidence?.branch) {
    prStep.status = input.busyAction === "create-pr" ? "pending" : "ready";
  } else {
    prStep.status = "blocked";
    prStep.blockedMessage = "no pushed branch";
  }

  if (hasPullRequest) {
    if (input.busyAction === "check-pr") {
      checkStep.status = "pending";
    } else if (!input.checks) {
      checkStep.status = "ready";
    } else if (isStaleChecks) {
      checkStep.status = "stale";
      checkStep.blockedMessage = "checks stale";
    } else if (input.checks.checkStatus === "failing") {
      checkStep.status = "blocked";
      checkStep.blockedMessage = "checks failing";
    } else if (input.checks.checkStatus === "passing" && hasExactHeadCheckTarget) {
      checkStep.status = "done";
    } else if (input.checks.checkStatus === "passing") {
      checkStep.status = "blocked";
      checkStep.blockedMessage = "checks missing exact head";
    } else {
      checkStep.status = "pending";
      checkStep.blockedMessage = "checks pending";
    }
  }

  if (hasPullRequest) {
    if (!input.checks) {
      reviewStep.status = "blocked";
      reviewStep.blockedMessage = "checks pending";
    } else if (isStaleChecks) {
      reviewStep.status = "stale";
      reviewStep.blockedMessage = "checks stale";
    } else if (input.checks.reviewStatus === "changes_requested") {
      reviewStep.status = "blocked";
      reviewStep.blockedMessage = "review changes requested";
    } else if (input.checks.reviewStatus === "approved") {
      reviewStep.status = "done";
    } else if (input.checks.reviewStatus === "pending") {
      reviewStep.status = "ready";
    } else {
      reviewStep.status = "blocked";
      reviewStep.blockedMessage = "review evidence missing";
    }
  }

  if (input.mergeComplete) {
    mergeStep.status = "done";
  } else if (mergeReady) {
    if (input.busyAction === "merge") {
      mergeStep.status = "pending";
    } else if (input.mergeConfirmed && input.mergeTitle.trim().length > 0) {
      mergeStep.status = "ready";
    } else {
      mergeStep.status = "blocked";
      mergeStep.blockedMessage = "merge not confirmed";
    }
  } else {
    mergeStep.status = "blocked";
    if (!hasPullRequest) {
      mergeStep.blockedMessage = "PR not created";
    } else if (isStaleChecks) {
      mergeStep.blockedMessage = "checks stale";
    } else if (input.checks?.checkStatus === "failing") {
      mergeStep.blockedMessage = "checks failing";
    } else if (input.checks?.reviewStatus === "changes_requested") {
      mergeStep.blockedMessage = "review changes requested";
    } else {
      mergeStep.blockedMessage = "checks pending";
    }
  }

  if (input.syncComplete) {
    syncStep.status = "done";
  } else if (input.mergeComplete) {
    if (input.busyAction === "sync") {
      syncStep.status = "pending";
    } else if (input.syncConfirmed) {
      syncStep.status = "ready";
    } else {
      syncStep.status = "blocked";
      syncStep.blockedMessage = "sync not confirmed";
    }
  } else {
    syncStep.status = "blocked";
    syncStep.blockedMessage = "merge not complete";
  }

  if (cleanupAllowed) {
    if (input.busyAction === "cleanup") {
      cleanupStep.status = "pending";
    } else if (input.cleanupConfirmed && !deleteBranchBlocked) {
      cleanupStep.status = "ready";
    } else if (deleteBranchBlocked) {
      cleanupStep.status = "blocked";
      cleanupStep.blockedMessage = "delete branch not confirmed";
    } else {
      cleanupStep.status = "blocked";
      cleanupStep.blockedMessage = "cleanup not confirmed";
    }
  } else {
    cleanupStep.status = "blocked";
    cleanupStep.blockedMessage = "cleanup not confirmed";
  }

  return {
    canCommit: input.backend.commit && commitStep.status === "ready",
    canPush: input.backend.push && pushStep.status === "ready",
    canCreatePr: input.backend.createPr && prStep.status === "ready",
    canCheckPr: input.backend.checkPr && hasPullRequest && input.busyAction !== "check-pr",
    exactHeadChecksPassed,
    mergeReady,
    canMerge: input.backend.merge && mergeStep.status === "ready",
    canSync: input.backend.sync && syncStep.status === "ready",
    canCleanup: input.backend.cleanup && cleanupStep.status === "ready",
    deleteBranchRequested: input.deleteBranch,
    prCreatedCompletesTask: false,
    commitStep,
    pushStep,
    prStep,
    checkStep,
    reviewStep,
    mergeStep,
    syncStep,
    cleanupStep,
    gateList: buildDeliveryGateList(input, {
      commitStep,
      pushStep,
      prStep,
      checkStep,
      reviewStep,
      mergeStep,
      syncStep,
      cleanupStep,
    }),
  };
}

function buildDeliveryGateList(
  input: DeliveryPanelInput,
  steps: {
    commitStep: DeliveryStepState;
    pushStep: DeliveryStepState;
    prStep: DeliveryStepState;
    checkStep: DeliveryStepState;
    reviewStep: DeliveryStepState;
    mergeStep: DeliveryStepState;
    syncStep: DeliveryStepState;
    cleanupStep: DeliveryStepState;
  },
): DeliveryGateCopy[] {
  return [
    commitGateCopy(input, steps.commitStep),
    pushGateCopy(input, steps.pushStep),
    pullRequestGateCopy(input, steps.prStep),
    checksGateCopy(input, steps.checkStep),
    reviewGateCopy(input, steps.reviewStep),
    mergeGateCopy(steps.mergeStep),
    syncGateCopy(steps.syncStep),
    cleanupGateCopy(input, steps.cleanupStep),
    deleteBranchGateCopy(input),
  ];
}

function commitGateCopy(input: DeliveryPanelInput, step: DeliveryStepState): DeliveryGateCopy {
  if (input.commitEvidence) {
    return {
      key: "commit",
      label: "Local commit",
      status: "done",
      summary: `Local commit recorded: ${shortSha(input.commitEvidence.commitSha)}.`,
    };
  }
  if (step.status === "ready") {
    return {
      key: "commit",
      label: "Local commit",
      status: "ready",
      summary: "Ready to create a local commit from verified git changes.",
    };
  }
  return {
    key: "commit",
    label: "Local commit",
    status: step.status,
    summary: step.status === "pending" ? "Creating local commit..." : "Blocked until verified git changes are available.",
  };
}

function pushGateCopy(input: DeliveryPanelInput, step: DeliveryStepState): DeliveryGateCopy {
  if (input.pullRequest) {
    return {
      key: "push",
      label: "Push branch",
      status: "blocked",
      summary: `Push is closed because PR #${input.pullRequest.number} already exists.`,
    };
  }
  if (step.status === "done") {
    return {
      key: "push",
      label: "Push branch",
      status: "done",
      summary: `Pushed ${input.pushEvidence?.remote ?? "remote"}/${input.pushEvidence?.branch ?? "branch"} at ${shortSha(input.pushEvidence?.commitSha)}.`,
    };
  }
  if (step.status === "ready") {
    return {
      key: "push",
      label: "Push branch",
      status: "ready",
      summary: `Ready to push ${input.commitEvidence?.branch ?? "branch"} for commit ${shortSha(input.commitEvidence?.commitSha)}.`,
    };
  }
  return {
    key: "push",
    label: "Push branch",
    status: step.status,
    summary: step.status === "pending" ? "Pushing delivery branch..." : "Blocked until local commit evidence exists.",
  };
}

function pullRequestGateCopy(input: DeliveryPanelInput, step: DeliveryStepState): DeliveryGateCopy {
  if (input.pullRequest) {
    return {
      key: "pr",
      label: "Pull request",
      status: "done",
      summary: `PR #${input.pullRequest.number} created. This is delivery evidence, not task completion.`,
    };
  }
  if (step.status === "ready") {
    return {
      key: "pr",
      label: "Pull request",
      status: "ready",
      summary: `Ready to create a PR from pushed branch ${input.pushEvidence?.branch ?? "branch"}.`,
    };
  }
  return {
    key: "pr",
    label: "Pull request",
    status: step.status,
    summary: step.status === "pending" ? "Creating pull request..." : "Blocked until branch push evidence exists.",
  };
}

function checksGateCopy(input: DeliveryPanelInput, step: DeliveryStepState): DeliveryGateCopy {
  if (!input.pullRequest) {
    return {
      key: "checks",
      label: "Exact-head checks",
      status: "blocked",
      summary: "Blocked until PR is created.",
    };
  }
  if (!input.checks && step.status === "ready") {
    return {
      key: "checks",
      label: "Exact-head checks",
      status: "ready",
      summary: "Ready to check exact PR head before merge.",
    };
  }
  const checkedSha = shortSha(input.checks?.expectedHeadSha);
  const headSha = shortSha(input.pullRequest.headSha);
  if (step.status === "stale") {
    return {
      key: "checks",
      label: "Exact-head checks",
      status: "stale",
      summary: `Checks are stale: checked ${checkedSha}, PR head is ${headSha}.`,
    };
  }
  if (input.checks?.checkStatus === "failing") {
    return {
      key: "checks",
      label: "Exact-head checks",
      status: "blocked",
      summary: `Checks failed for ${checkedSha}; merge is blocked.`,
    };
  }
  if (step.status === "done") {
    return {
      key: "checks",
      label: "Exact-head checks",
      status: "done",
      summary: `Exact-head checks passed for ${checkedSha}. Green checks do not auto-merge.`,
    };
  }
  if (input.checks?.checkStatus === "pending") {
    return {
      key: "checks",
      label: "Exact-head checks",
      status: "pending",
      summary: `Checks are pending for ${checkedSha}; re-check before merge.`,
    };
  }
  return {
    key: "checks",
    label: "Exact-head checks",
    status: step.status,
    summary: step.status === "pending" ? "Checking exact PR head..." : "Blocked until exact PR head can be verified.",
  };
}

function reviewGateCopy(input: DeliveryPanelInput, step: DeliveryStepState): DeliveryGateCopy {
  if (!input.pullRequest) {
    return {
      key: "review",
      label: "Review gate",
      status: "blocked",
      summary: "Blocked until PR is created.",
    };
  }
  if (!input.checks) {
    return {
      key: "review",
      label: "Review gate",
      status: "blocked",
      summary: "Blocked until PR checks are refreshed.",
    };
  }
  if (step.status === "stale") {
    return {
      key: "review",
      label: "Review gate",
      status: "stale",
      summary: "Review gate is stale until exact-head checks are refreshed.",
    };
  }
  if (input.checks.reviewStatus === "changes_requested") {
    return {
      key: "review",
      label: "Review gate",
      status: "blocked",
      summary: "Review requested changes; merge is blocked.",
    };
  }
  if (input.checks.reviewStatus === "approved") {
    return {
      key: "review",
      label: "Review gate",
      status: "done",
      summary: "Review gate approved.",
    };
  }
  if (input.checks.reviewStatus === "pending") {
    return {
      key: "review",
      label: "Review gate",
      status: "ready",
      summary: "Review gate is pending; no requested changes are recorded.",
    };
  }
  return {
    key: "review",
    label: "Review gate",
    status: "blocked",
    summary: "Review gate evidence is missing.",
  };
}

function mergeGateCopy(step: DeliveryStepState): DeliveryGateCopy {
  if (step.status === "done") {
    return {
      key: "merge",
      label: "Squash merge",
      status: "done",
      summary: "PR merged. Sync and cleanup remain separate explicit actions.",
    };
  }
  if (step.status === "ready") {
    return {
      key: "merge",
      label: "Squash merge",
      status: "ready",
      summary: "Explicit squash merge confirmation is complete.",
    };
  }
  if (step.blockedMessage === "merge not confirmed") {
    return {
      key: "merge",
      label: "Squash merge",
      status: "blocked",
      summary: "Manual gate: confirm PR number, exact head SHA, and squash title.",
    };
  }
  return {
    key: "merge",
    label: "Squash merge",
    status: step.status,
    summary: step.status === "pending" ? "Merging pull request..." : "Blocked until PR, exact-head checks, mergeability, and review gate pass.",
  };
}

function syncGateCopy(step: DeliveryStepState): DeliveryGateCopy {
  if (step.status === "done") {
    return {
      key: "sync",
      label: "Sync main",
      status: "done",
      summary: "Main branch synced after merge.",
    };
  }
  if (step.status === "ready") {
    return {
      key: "sync",
      label: "Sync main",
      status: "ready",
      summary: "Ready to sync main after merge.",
    };
  }
  if (step.blockedMessage === "sync not confirmed") {
    return {
      key: "sync",
      label: "Sync main",
      status: "blocked",
      summary: "Manual gate: confirm post-merge main sync.",
    };
  }
  return {
    key: "sync",
    label: "Sync main",
    status: step.status,
    summary: step.status === "pending" ? "Syncing main..." : "Blocked until merge completes.",
  };
}

function cleanupGateCopy(input: DeliveryPanelInput, step: DeliveryStepState): DeliveryGateCopy {
  if (step.status === "ready") {
    return {
      key: "cleanup",
      label: "Cleanup",
      status: "ready",
      summary: "Ready to clean managed worktree.",
    };
  }
  if (step.blockedMessage === "delete branch not confirmed") {
    return {
      key: "cleanup",
      label: "Cleanup",
      status: "blocked",
      summary: "Blocked until branch deletion has second confirmation.",
    };
  }
  if ((input.mergeComplete || input.syncComplete || input.cleanupExplicitlyAllowed) && !input.cleanupConfirmed) {
    return {
      key: "cleanup",
      label: "Cleanup",
      status: "blocked",
      summary: "Manual gate: confirm cleanup after merge or sync.",
    };
  }
  return {
    key: "cleanup",
    label: "Cleanup",
    status: step.status,
    summary: step.status === "pending" ? "Cleaning managed worktree..." : "Blocked until merge/sync completes or cleanup is explicitly allowed.",
  };
}

function deleteBranchGateCopy(input: DeliveryPanelInput): DeliveryGateCopy {
  if (!input.deleteBranch) {
    return {
      key: "delete-branch",
      label: "Delete branch",
      status: "safe",
      summary: "Branch deletion is off by default.",
    };
  }
  if (!input.deleteBranchConfirmed) {
    return {
      key: "delete-branch",
      label: "Delete branch",
      status: "blocked",
      summary: "Branch deletion needs a second explicit confirmation.",
    };
  }
  return {
    key: "delete-branch",
    label: "Delete branch",
    status: "ready",
    summary: "Branch deletion explicitly confirmed.",
  };
}

function shortSha(value?: string): string {
  return value ? value.slice(0, 7) : "None";
}

export function hydrateDeliveryLifecycleFromWorkflowEvents(
  events: readonly unknown[],
  options: DeliveryLifecycleHydrationOptions,
): DeliveryLifecycleHydration {
  const state: DeliveryLifecycleHydration = {
    commitEvidence: null,
    pushEvidence: null,
    pullRequest: null,
    checks: null,
    mergeComplete: false,
    syncComplete: false,
  };

  for (const event of events) {
    if (!isRecord(event) || typeof event.kind !== "string") continue;
    const payload = isRecord(event.payload) ? event.payload : {};
    const safeDelivery = isRecord(payload.delivery) ? payload.delivery : null;
    const evidence = safeDelivery ?? (isRecord(payload.evidence) ? payload.evidence : {});
    const laneId = text(event.laneId) ?? text(evidence.laneId) ?? text(payload.laneId);

    if (event.kind === "workflow.commit.created" && laneId === options.commitLaneId) {
      state.commitEvidence = {
        ...(text(evidence.commitSha) ? { commitSha: text(evidence.commitSha)! } : {}),
        ...(text(evidence.branch) ? { branch: text(evidence.branch)! } : {}),
        ...(text(evidence.worktreePath) ? { worktreePath: text(evidence.worktreePath)! } : {}),
        ...(text(evidence.subject) ? { subject: text(evidence.subject)! } : {}),
      };
      state.pushEvidence = null;
      state.pullRequest = null;
      state.checks = null;
      state.mergeComplete = false;
      state.syncComplete = false;
      continue;
    }

    if (event.kind === "workflow.delivery.pushed" && laneId === options.commitLaneId) {
      state.pushEvidence = {
        ...(text(evidence.remote) ? { remote: text(evidence.remote)! } : {}),
        ...(text(evidence.branch) ? { branch: text(evidence.branch)! } : {}),
        ...(text(evidence.commitSha) ? { commitSha: text(evidence.commitSha)! } : {}),
      };
      state.commitEvidence = mergeCommitEvidence(state.commitEvidence, evidence);
      state.pullRequest = null;
      state.checks = null;
      state.mergeComplete = false;
      state.syncComplete = false;
      continue;
    }

    if (event.kind === "workflow.pull_request.created" && matchesPullRequestEvent(laneId, payload, state, options)) {
      const number = numeric(evidence.prNumber) ?? numeric(evidence.number) ?? numeric(payload.prNumber);
      if (typeof number !== "number") continue;
      state.pullRequest = {
        number,
        ...(text(evidence.url) ?? text(payload.url) ? { url: (text(evidence.url) ?? text(payload.url))! } : {}),
        ...(pullRequestHeadSha(payload, evidence) ? { headSha: pullRequestHeadSha(payload, evidence)! } : {}),
        ...(text(evidence.title) ? { title: text(evidence.title)! } : {}),
      };
      state.checks = null;
      state.mergeComplete = false;
      state.syncComplete = false;
      continue;
    }

    if (event.kind === "workflow.pull_request.checks_recorded" && matchesPullRequestEvent(laneId, payload, state, options)) {
      const headSha = text(payload.headSha) ?? text(evidence.headSha);
      const status = deliveryCheckStatus(text(payload.status) ?? text(evidence.status));
      const reviewStatus = deliveryReviewStatusFromEvent(payload, evidence);
      const gateMergeable = deliveryGateMergeableFromEvent(payload, evidence);
      state.checks = {
        checkStatus: status,
        reviewStatus,
        ...(headSha ? { expectedHeadSha: headSha } : {}),
        mergeable: status === "passing" && gateMergeable === true,
      };
      state.mergeComplete = false;
      state.syncComplete = false;
      continue;
    }

    if (event.kind === "workflow.pull_request.merged" && matchesPullRequestEvent(laneId, payload, state, options)) {
      state.mergeComplete = text(evidence.status) === "merged" || text(payload.status) === "merged";
      state.syncComplete = false;
      continue;
    }

    if (event.kind === "workflow.delivery.main_synced" && matchesDeliverySyncEvent(laneId, payload, state, options)) {
      state.syncComplete = text(evidence.status) === "synced" || text(payload.status) === "synced";
    }
  }

  return state;
}

function mergeCommitEvidence(
  current: DeliveryCommitSummary | null,
  evidence: Record<string, unknown>,
): DeliveryCommitSummary | null {
  if (!current) return current;
  return {
    ...current,
    ...(text(evidence.commitSha) ? { commitSha: text(evidence.commitSha)! } : {}),
    ...(text(evidence.branch) ? { branch: text(evidence.branch)! } : {}),
    ...(text(evidence.worktreePath) ? { worktreePath: text(evidence.worktreePath)! } : {}),
  };
}

function matchesPullRequestEvent(
  laneId: string | undefined,
  payload: Record<string, unknown>,
  state: DeliveryLifecycleHydration,
  options: DeliveryLifecycleHydrationOptions,
): boolean {
  const delivery = isRecord(payload.delivery) ? payload.delivery : {};
  if (laneId && laneId === options.pullRequestLaneId) return true;
  if ((text(delivery.commitLaneId) ?? text(payload.commitLaneId)) === options.commitLaneId) return true;
  const prNumber =
    numeric(delivery.prNumber) ??
    numeric(payload.prNumber) ??
    (isRecord(payload.evidence) ? numeric(payload.evidence.number) : null);
  return typeof prNumber === "number" && prNumber === state.pullRequest?.number;
}

function matchesDeliverySyncEvent(
  laneId: string | undefined,
  payload: Record<string, unknown>,
  state: DeliveryLifecycleHydration,
  options: DeliveryLifecycleHydrationOptions,
): boolean {
  const delivery = isRecord(payload.delivery) ? payload.delivery : {};
  if (!laneId) return !!state.pullRequest || !!state.commitEvidence;
  if (laneId === options.pullRequestLaneId || laneId === options.commitLaneId) return true;
  const prNumber =
    numeric(delivery.prNumber) ??
    numeric(payload.prNumber) ??
    (isRecord(payload.evidence) ? numeric(payload.evidence.number) : null);
  return typeof prNumber === "number" && prNumber === state.pullRequest?.number;
}

function pullRequestHeadSha(payload: Record<string, unknown>, evidence: Record<string, unknown>): string | undefined {
  return text(evidence.headSha) ?? text(evidence.commitSha) ?? text(payload.headSha) ?? text(payload.commitSha);
}

function deliveryCheckStatus(status: string | undefined): PullRequestCheckStatus {
  if (status === "passed") return "passing";
  if (status === "failed") return "failing";
  return "pending";
}

function deliveryReviewStatusFromEvent(
  payload: Record<string, unknown>,
  evidence: Record<string, unknown>,
): PullRequestReviewStatus {
  const payloadReview = isRecord(payload.review) ? payload.review : {};
  const evidenceReview = isRecord(evidence.review) ? evidence.review : {};
  const payloadGate = isRecord(payload.gate) ? payload.gate : {};
  const evidenceGate = isRecord(evidence.gate) ? evidence.gate : {};
  return deliveryReviewStatus(
    text(payloadReview.status) ??
    text(evidenceReview.status) ??
    text(payloadGate.reviewStatus) ??
    text(evidenceGate.reviewStatus) ??
    deliveryReviewStatusFromChecks(payload.checks) ??
    deliveryReviewStatusFromChecks(evidence.checks),
  );
}

function deliveryGateMergeableFromEvent(
  payload: Record<string, unknown>,
  evidence: Record<string, unknown>,
): boolean | undefined {
  const payloadGate = isRecord(payload.gate) ? payload.gate : null;
  const evidenceGate = isRecord(evidence.gate) ? evidence.gate : null;
  const value = payloadGate?.mergeable ?? evidenceGate?.mergeable;
  return typeof value === "boolean" ? value : undefined;
}

function deliveryReviewStatusFromChecks(checks: unknown): string | undefined {
  if (!Array.isArray(checks)) return undefined;
  for (const check of checks) {
    if (!isRecord(check)) continue;
    const status = text(check.status);
    const name = text(check.name)?.toLowerCase() ?? "";
    const workflow = text(check.workflow)?.toLowerCase() ?? "";
    const normalized = deliveryReviewStatus(status);
    if (normalized === "unknown") continue;
    if (name.includes("review") || workflow.includes("review") || normalized === "changes_requested") return normalized;
  }
  return undefined;
}

function deliveryReviewStatus(status: string | undefined): PullRequestReviewStatus {
  if (status === "approved") return "approved";
  if (status === "changes_requested") return "changes_requested";
  if (status === "pending") return "pending";
  return "unknown";
}

function text(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value : undefined;
}

function numeric(value: unknown): number | undefined {
  return typeof value === "number" ? value : undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}
