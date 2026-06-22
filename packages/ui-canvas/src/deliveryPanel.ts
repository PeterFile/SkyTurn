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
