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
  cleanupExplicitlyAllowed: boolean;
  cleanupConfirmed: boolean;
  deleteBranch: boolean;
  deleteBranchConfirmed: boolean;
  busyAction: DeliveryBusyAction | null;
}

export type DeliveryStepStatus = "ready" | "blocked" | "done" | "stale" | "pending";

export interface DeliveryStepState {
  status: DeliveryStepStatus;
  blockedMessage?: string;
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
    } else if (input.checks.checkStatus === "passing") {
      checkStep.status = "done";
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
    } else {
      reviewStep.status = "ready";
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
    syncStep.status = input.busyAction === "sync" ? "pending" : "ready";
  } else {
    syncStep.status = "blocked";
    syncStep.blockedMessage = "merge not complete";
  }

  if (cleanupAllowed) {
    if (input.busyAction === "cleanup") {
      cleanupStep.status = "pending";
    } else if (input.cleanupConfirmed && !deleteBranchBlocked) {
      cleanupStep.status = "ready";
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
  };
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
