export type DeliveryBusyAction = "commit" | "push" | "create-pr" | "check-pr" | "merge" | "sync" | "cleanup";
export type PullRequestCheckStatus = "passing" | "failing" | "pending";

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
  prCreatedCompletesTask: false;
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
  const headSha = input.pullRequest?.headSha ?? input.commitEvidence?.commitSha;
  const expectedHeadSha = input.checks?.expectedHeadSha;
  const exactHeadChecksPassed =
    input.checks?.checkStatus === "passing" &&
    input.checks.mergeable &&
    !!headSha &&
    !!expectedHeadSha &&
    headSha === expectedHeadSha;
  const mergeReady = hasPullRequest && exactHeadChecksPassed;
  const cleanupAllowed = input.mergeComplete || input.syncComplete || input.cleanupExplicitlyAllowed;
  const deleteBranchBlocked = input.deleteBranch && !input.deleteBranchConfirmed;

  return {
    canCommit:
      input.backend.commit &&
      input.busyAction !== "commit" &&
      input.isCommitLane &&
      input.hasGitEvidence &&
      input.hasGitChanges,
    canPush:
      input.backend.push &&
      input.busyAction !== "push" &&
      hasCommit &&
      !hasPullRequest,
    canCreatePr:
      input.backend.createPr &&
      input.busyAction !== "create-pr" &&
      hasPushedBranch &&
      !!input.commitEvidence?.branch &&
      !hasPullRequest,
    canCheckPr:
      input.backend.checkPr &&
      input.busyAction !== "check-pr" &&
      hasPullRequest,
    exactHeadChecksPassed,
    mergeReady,
    canMerge:
      input.backend.merge &&
      input.busyAction !== "merge" &&
      mergeReady &&
      input.mergeConfirmed &&
      input.mergeTitle.trim().length > 0,
    canSync:
      input.backend.sync &&
      input.busyAction !== "sync" &&
      input.mergeComplete,
    canCleanup:
      input.backend.cleanup &&
      input.busyAction !== "cleanup" &&
      cleanupAllowed &&
      input.cleanupConfirmed &&
      !deleteBranchBlocked,
    deleteBranchRequested: input.deleteBranch,
    prCreatedCompletesTask: false,
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
      state.checks = {
        checkStatus: status,
        ...(headSha ? { expectedHeadSha: headSha } : {}),
        mergeable: status === "passing",
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

function text(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value : undefined;
}

function numeric(value: unknown): number | undefined {
  return typeof value === "number" ? value : undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}
