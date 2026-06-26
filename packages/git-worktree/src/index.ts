import type {
  CanvasNode,
  Changeset,
  ChangesetEvidence,
  FinalChangesetReconciliation,
  LiveRunChangesEvidence,
  EvidenceCheck,
  EvidenceCheckStatus,
  RunEvidence,
  SessionTarget,
  WorkflowVariantAdoption,
  WorkflowWorktreeIdentity,
  WorktreeMetadata,
} from "@skyturn/project-core";

export const GIT_WORKTREE_CONTRACT_VERSION = 1;

export type EditorKind =
  | "vscode"
  | "cursor"
  | "zed"
  | "antigravity"
  | "finder"
  | "terminal"
  | "iterm2"
  | "xcode";

export interface GitService {
  getBaseCommit(projectId: string): Promise<string>;
}

export interface WorktreeService {
  createWorktree(node: CanvasNode): Promise<WorktreeMetadata>;
  cancelRun(runId: string): Promise<{ ok: boolean; persisted: boolean }>;
}

export interface ChangesetService {
  getChangeset(node: CanvasNode): Promise<Changeset>;
}

export interface ChangesetReconciliationInput {
  node: CanvasNode;
  target: SessionTarget;
  baselineRef?: string;
  liveChanges?: LiveRunChangesEvidence | null;
}

export interface ChangesetReconciliationService {
  reconcileFinalChangeset(input: ChangesetReconciliationInput): Promise<FinalChangesetReconciliation>;
}

export interface GitBranchFacts {
  currentBranch: string;
  branches: string[];
}

export type DeliveryCommitErrorCode = "INVALID_INPUT" | "UNSAFE_WORKTREE_PATH" | "DELIVERY_REJECTED";
export type DeliveryRemoteActionErrorCode = DeliveryCommitErrorCode | "GH_UNAVAILABLE" | "AUTH_REQUIRED" | "REMOTE_HEAD_MISMATCH";

export interface DeliveryCommitInput {
  projectRoot: string;
  worktreePath: string;
  files: string[];
  subject: string;
  body?: string;
  reconciliationStatus?: FinalChangesetReconciliation["status"];
  acceptMismatch?: boolean;
}

export interface DeliveryCommandResult {
  command: "git" | "gh";
  args: string[];
  ok: boolean;
  exitCode: number;
  stdout: string;
  stderr: string;
}

export interface DeliveryCommitCheckResult {
  name: "delivery-commit-preflight";
  ok: boolean;
  detail: string;
  files: string[];
}

export interface DeliveryCommitEvidence {
  status: "committed";
  commitSha: string;
  branch: string;
  stagedFiles: string[];
  worktreePath: string;
  command: DeliveryCommandResult;
  check: DeliveryCommitCheckResult;
}

export interface ManagedWorktreeCreateInput {
  sessionId: string;
  variantId: string;
  repoRoot: string;
  baseCommit: string;
  branchName: string;
  parentLaneId: string;
  parentSegmentId?: string;
}

export interface ManagedWorktreeCleanupInput {
  worktree: WorkflowWorktreeIdentity;
  deleteBranch?: boolean;
}

export interface ManagedWorktreeCleanupResult {
  ok: boolean;
  worktreeId: string;
  cleanedAt: string;
  branchDeleted?: boolean;
  reason?: string;
}

export type RollbackWorktreeManualRepairReasonCode =
  | "invalid_restore_commit"
  | "invalid_recorded_commit"
  | "missing_restore_commit"
  | "missing_recorded_commit"
  | "unmanaged_worktree"
  | "branch_mismatch"
  | "head_mismatch"
  | "dirty_worktree"
  | "git_reset_failed"
  | "post_reset_mismatch";

export interface RollbackWorktreeInput {
  projectRoot: string;
  worktreePath: string;
  expectedBranchName: string;
  expectedHeadCommit: string;
  restoreCommitRef: string;
}

export interface RollbackWorktreeSafeState {
  status: "safe";
  worktreePath: string;
  branchName: string;
  headCommit: string;
  restoreCommitRef: string;
}

export interface RollbackWorktreeAlreadyRestoredState {
  status: "already_restored";
  worktreePath: string;
  branchName: string;
  headCommit: string;
  restoreCommitRef: string;
}

export interface RollbackWorktreeAppliedState {
  status: "applied";
  worktreePath: string;
  branchName: string;
  headCommit: string;
  restoreCommitRef: string;
}

export interface RollbackWorktreeManualRepairState {
  status: "manual_repair_required";
  reasonCode: RollbackWorktreeManualRepairReasonCode;
  message: string;
  manualRepairRequired: true;
  worktreePath?: string;
  branchName?: string;
  headCommit?: string;
  restoreCommitRef?: string;
}

export type RollbackWorktreeState = RollbackWorktreeSafeState | RollbackWorktreeAlreadyRestoredState | RollbackWorktreeManualRepairState;
export type RollbackWorktreeResetResult = RollbackWorktreeAppliedState | RollbackWorktreeAlreadyRestoredState | RollbackWorktreeManualRepairState;

export interface VariantComparisonInput {
  left: WorkflowWorktreeIdentity;
  right: WorkflowWorktreeIdentity;
  recordedEvidence?: Partial<Record<string, RecordedAdjudicationEvidence>>;
}

export interface VariantComparisonEvidence {
  comparisonId: string;
  variants: Array<{
    variantId: string;
    worktreeId: string;
    changeset: ChangesetEvidence;
    metrics: AdjudicationMetric[];
  }>;
  collectedAt: string;
}

export interface ManagedWorktreeService {
  createManagedWorktree(input: ManagedWorktreeCreateInput): Promise<WorkflowWorktreeIdentity>;
  compareVariants(input: VariantComparisonInput): Promise<VariantComparisonEvidence>;
  cleanManagedWorktree(input: ManagedWorktreeCleanupInput): Promise<ManagedWorktreeCleanupResult>;
}

export interface VariantAdoptionService {
  adoptVariant(input: WorkflowVariantAdoption): Promise<WorkflowVariantAdoption>;
}

export interface ChangesetEvidenceInput {
  node: CanvasNode;
  worktree?: WorkflowWorktreeIdentity;
}

export interface ChangesetEvidenceService {
  collectChangesetEvidence(input: ChangesetEvidenceInput): Promise<ChangesetEvidence>;
}

export type AdjudicationMetricKind =
  | "test"
  | "build"
  | "typecheck"
  | "artifact"
  | "changed-file-count"
  | "diff-summary"
  | "performance-output"
  | "conflict-check";

export type AdjudicationMetricStatus = EvidenceCheckStatus | "recorded" | "unknown" | "equivalent";

export interface AdjudicationMetric {
  kind: AdjudicationMetricKind;
  label: string;
  status: AdjudicationMetricStatus;
  source: "recorded";
  value?: number | string;
  detail?: string;
  artifactPaths?: string[];
}

export interface RecordedAdjudicationEvidence {
  runEvidence?: RunEvidence | null;
  changeset?: ChangesetEvidence | null;
  performanceOutput?: string | null;
  conflictCheck?: EvidenceCheck | null;
}

const MAX_ADJUDICATION_DETAIL_LENGTH = 1000;

export interface EditorAdapter {
  openWorktree(editor: EditorKind, worktreePath: string): Promise<{ ok: boolean; message: string }>;
}

export const mockGitService: GitService = {
  async getBaseCommit() {
    return "mock-base-commit";
  },
};

export const mockWorktreeService: WorktreeService = {
  async createWorktree(node) {
    return node.worktree;
  },
  async cancelRun() {
    return { ok: true, persisted: true };
  },
};

export const mockChangesetService: ChangesetService = {
  async getChangeset(node) {
    return createMockChangeset(node);
  },
};

export function createMockChangeset(node: CanvasNode): Changeset {
  return {
    id: node.changesetId,
    files: [`src/tasks/${node.id}.ts`, `.devflow/tasks/${node.id}/result.md`],
    diffStat: {
      added: 6,
      changed: 2,
      deleted: 2,
    },
    patchPreview: [
      `diff --git a/src/tasks/${node.id}.ts b/src/tasks/${node.id}.ts`,
      "index 1111111..2222222 100644",
      `--- a/src/tasks/${node.id}.ts`,
      `+++ b/src/tasks/${node.id}.ts`,
      "@@ -1,5 +1,7 @@",
      " export async function runTask() {",
      '-  return "pending";',
      "+  const evidence = await collectRunEvidence();",
      "+  return evidence.status;",
      " }",
      `diff --git a/.devflow/tasks/${node.id}/result.md b/.devflow/tasks/${node.id}/result.md`,
      "index 3333333..4444444 100644",
      `--- a/.devflow/tasks/${node.id}/result.md`,
      `+++ b/.devflow/tasks/${node.id}/result.md`,
      "@@ -1,4 +1,8 @@",
      " # Task result",
      "- Status: pending",
      "+ Status: verified",
      "+ Mock task-local output persisted.",
      "+ Verification evidence remains required before completion.",
      "+ Review summary is ready.",
    ].join("\n"),
    source: "mock",
  };
}

export interface DeliveryPushInput {
  projectRoot: string;
  worktreePath: string;
  commitSha: string;
  remote?: string;
  branch?: string;
}

export interface DeliveryPushEvidence {
  status: "pushed";
  remote: string;
  branch: string;
  commitSha: string;
  worktreePath: string;
  command: DeliveryCommandResult;
}

export interface DeliveryPullRequestInput {
  projectRoot: string;
  worktreePath: string;
  commitSha: string;
  baseBranch: string;
  headBranch?: string;
  remote?: string;
  title: string;
  body?: string;
  whatChanged?: string;
  why?: string;
  breakingChanges?: string;
  serverPr?: string;
}

export interface DeliveryPullRequestEvidence {
  status: "created";
  url: string;
  number: number;
  head: string;
  base: string;
  remote: string;
  commitSha: string;
  title: string;
  command: DeliveryCommandResult;
}

export interface DeliveryPullRequestChecksInput {
  projectRoot: string;
  prNumber?: number;
  prUrl?: string;
  expectedHeadSha: string;
}

export type DeliveryPullRequestCheckStatus = "passed" | "failed" | "pending";
export type DeliveryPullRequestReviewStatus = "approved" | "changes_requested" | "pending" | "unknown";

export interface DeliveryPullRequestCheck {
  name: string;
  status: DeliveryPullRequestCheckStatus;
  state: string;
  workflow?: string;
  link?: string;
  detail?: string;
}

export interface DeliveryPullRequestReviewGate {
  status: DeliveryPullRequestReviewStatus;
  decision: string;
  detail?: string;
  reviewer?: string;
  link?: string;
}

export interface DeliveryPullRequestGateSummary {
  headSha: string;
  checksStatus: DeliveryPullRequestCheckStatus;
  reviewStatus: DeliveryPullRequestReviewStatus;
  state: string;
  mergeable: boolean;
}

export interface DeliveryPullRequestChecksEvidence {
  status: DeliveryPullRequestCheckStatus;
  number: number;
  url?: string;
  headSha: string;
  checks: DeliveryPullRequestCheck[];
  review: DeliveryPullRequestReviewGate;
  gate: DeliveryPullRequestGateSummary;
  command: DeliveryCommandResult;
  summary: string;
}

export interface DeliveryPullRequestMergeInput {
  projectRoot: string;
  prNumber?: number;
  prUrl?: string;
  expectedHeadSha: string;
  subject: string;
  body?: string;
}

export interface DeliveryPullRequestMergeEvidence {
  status: "merged";
  number: number;
  url?: string;
  headSha: string;
  subject: string;
  checks: DeliveryPullRequestCheck[];
  review: DeliveryPullRequestReviewGate;
  command: DeliveryCommandResult;
}

export interface DeliveryMainSyncInput {
  projectRoot: string;
  mainBranch?: string;
  remote?: string;
}

export interface DeliveryMainSyncEvidence {
  status: "synced";
  mainBranch: string;
  remote: string;
  commands: DeliveryCommandResult[];
}

export function buildAdjudicationMetrics(recorded: RecordedAdjudicationEvidence): AdjudicationMetric[] {
  const checks = recorded.runEvidence?.checks ?? [];
  const artifactPaths = [
    ...(recorded.runEvidence?.artifacts ?? []),
    ...(recorded.changeset?.artifactPaths ?? []),
  ];

  return [
    metricFromCheck("test", "Tests", findCheck(checks, "test")),
    metricFromCheck("build", "Build", findCheck(checks, "build")),
    metricFromCheck("typecheck", "Typecheck", findCheck(checks, "typecheck")),
    artifactMetric(artifactPaths),
    changedFileCountMetric(recorded.changeset),
    diffSummaryMetric(recorded.changeset),
    performanceMetric(recorded.performanceOutput),
    metricFromCheck("conflict-check", "Conflict check", recorded.conflictCheck ?? null),
  ];
}

function findCheck(checks: EvidenceCheck[], kind: EvidenceCheck["kind"]): EvidenceCheck | null {
  return checks.find((check) => check.kind === kind) ?? null;
}

function metricFromCheck(
  kind: AdjudicationMetricKind,
  label: string,
  check: EvidenceCheck | null,
): AdjudicationMetric {
  if (!check) return unknownMetric(kind, label);
  return {
    kind,
    label,
    status: check.status,
    source: "recorded",
    detail: boundedDetail(check.detail ?? check.name),
  };
}

function artifactMetric(artifactPaths: string[]): AdjudicationMetric {
  if (artifactPaths.length === 0) return unknownMetric("artifact", "Artifact");
  return {
    kind: "artifact",
    label: "Artifact",
    status: "recorded",
    source: "recorded",
    value: artifactPaths.length,
    artifactPaths,
  };
}

function changedFileCountMetric(changeset: ChangesetEvidence | null | undefined): AdjudicationMetric {
  if (!changeset) return unknownMetric("changed-file-count", "Changed files");
  if (changeset.status === "failed") {
    return {
      kind: "changed-file-count",
      label: "Changed files",
      status: "failed",
      source: "recorded",
      detail: boundedDetail(changeset.errorReason),
    };
  }
  if (changeset.status === "empty") {
    return {
      kind: "changed-file-count",
      label: "Changed files",
      status: "equivalent",
      source: "recorded",
      value: 0,
      detail: "No git changes recorded.",
    };
  }
  if (changeset.status !== "available") return unknownMetric("changed-file-count", "Changed files");
  return {
    kind: "changed-file-count",
    label: "Changed files",
    status: "recorded",
    source: "recorded",
    value: changeset.files.length,
  };
}

function diffSummaryMetric(changeset: ChangesetEvidence | null | undefined): AdjudicationMetric {
  if (!changeset) return unknownMetric("diff-summary", "Diff summary");
  if (changeset.status === "failed") {
    return {
      kind: "diff-summary",
      label: "Diff summary",
      status: "failed",
      source: "recorded",
      detail: boundedDetail(changeset.errorReason),
    };
  }
  if (changeset.status === "empty") {
    return {
      kind: "diff-summary",
      label: "Diff summary",
      status: "equivalent",
      source: "recorded",
      detail: "No git diff recorded.",
    };
  }
  if (changeset.status !== "available") return unknownMetric("diff-summary", "Diff summary");
  return {
    kind: "diff-summary",
    label: "Diff summary",
    status: "recorded",
    source: "recorded",
    detail: `+${changeset.diffStat.added} / -${changeset.diffStat.deleted} across ${changeset.files.length} files`,
  };
}

function performanceMetric(performanceOutput: string | null | undefined): AdjudicationMetric {
  const detail = performanceOutput?.trim();
  if (!detail) return unknownMetric("performance-output", "Performance output");
  return {
    kind: "performance-output",
    label: "Performance output",
    status: "recorded",
    source: "recorded",
    detail: boundedDetail(detail),
  };
}

function unknownMetric(kind: AdjudicationMetricKind, label: string): AdjudicationMetric {
  return {
    kind,
    label,
    status: "unknown",
    source: "recorded",
  };
}

function boundedDetail(detail: string | undefined): string | undefined {
  if (!detail || detail.length <= MAX_ADJUDICATION_DETAIL_LENGTH) return detail;
  return `${detail.slice(0, MAX_ADJUDICATION_DETAIL_LENGTH).trimEnd()}...`;
}
