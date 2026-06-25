import { execFile, spawn } from "node:child_process";
import { mkdir, readFile, realpath, stat } from "node:fs/promises";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { promisify } from "node:util";

import type {
  CanvasNode,
  Changeset,
  ChangesetEvidence,
  FinalChangesetReconciliation,
  WorkflowVariantAdoption,
  WorkflowWorktreeIdentity,
  WorktreeMetadata,
} from "@skyturn/project-core";

import {
  buildAdjudicationMetrics,
  type ChangesetEvidenceInput,
  type ChangesetEvidenceService,
  type ChangesetReconciliationInput,
  type ChangesetReconciliationService,
  type ChangesetService,
  type DeliveryCommandResult,
  type DeliveryCommitErrorCode,
  type DeliveryCommitEvidence,
  type DeliveryCommitInput,
  type DeliveryMainSyncEvidence,
  type DeliveryMainSyncInput,
  type DeliveryPullRequestCheck,
  type DeliveryPullRequestChecksEvidence,
  type DeliveryPullRequestChecksInput,
  type DeliveryPullRequestEvidence,
  type DeliveryPullRequestReviewGate,
  type DeliveryPullRequestInput,
  type DeliveryPullRequestMergeEvidence,
  type DeliveryPullRequestMergeInput,
  type DeliveryPushEvidence,
  type DeliveryPushInput,
  type DeliveryRemoteActionErrorCode,
  type GitBranchFacts,
  type ManagedWorktreeCleanupInput,
  type ManagedWorktreeCleanupResult,
  type ManagedWorktreeCreateInput,
  type ManagedWorktreeService,
  type VariantComparisonEvidence,
  type VariantComparisonInput,
  type VariantAdoptionService,
} from "./index.js";

export type ManagedWorktreeWorkflowEventKind =
  | "workflow.worktree.create_requested"
  | "workflow.worktree.created"
  | "workflow.worktree.create_failed"
  | "workflow.worktree.clean_requested"
  | "workflow.worktree.cleaned"
  | "workflow.worktree.clean_failed"
  | "workflow.variant.adopt_requested"
  | "workflow.variant.adopted"
  | "workflow.variant.adopt_failed"
  | "workflow.variant.rejected";

export interface ManagedWorktreeWorkflowEvent {
  kind: ManagedWorktreeWorkflowEventKind;
  source: "git-worktree";
  payload: Record<string, unknown>;
  createdAt: string;
  idempotencyKey: string;
  sessionId?: string;
}

export interface ManagedWorktreeEventSink {
  append(event: ManagedWorktreeWorkflowEvent): Promise<void>;
}

export interface ManagedWorktreeRunState {
  hasRunningTasks(worktree: WorkflowWorktreeIdentity): Promise<boolean>;
}

export interface NodeGitWorktreeServiceOptions {
  eventSink?: ManagedWorktreeEventSink;
  initialEvents?: ManagedWorktreeWorkflowEvent[];
  now?: () => string;
  runState?: ManagedWorktreeRunState;
}

export type ManagedWorktreeRecoveryResult =
  | { ok: true; status: "created"; worktree: WorkflowWorktreeIdentity }
  | { ok: false; status: "orphaned"; reason: string };

interface ManagedWorktreePlan {
  sessionId: string;
  worktreeId: string;
  variantId: string;
  repoRoot: string;
  managedRoot: string;
  path: string;
  baseCommit: string;
  branchName: string;
  parentLaneId: string;
  parentSegmentId?: string;
}

type ManagedWorktreeEventFacts = Omit<ManagedWorktreePlan, "managedRoot">;

interface CreatedWorktreeEvent {
  event: ManagedWorktreeWorkflowEvent;
  worktree: WorkflowWorktreeIdentity;
}

interface GitWorktreeListEntry {
  worktree: string;
  head: string | null;
  branch: string | null;
}

interface GitResult {
  stdout: string;
  stderr: string;
  exitCode: number;
}

interface GitRunOptions {
  allowFailure?: boolean;
  maxBuffer?: number;
}

interface ReconcileOptions {
  expectedHeadCommit?: string;
  allowHeadAdvance?: boolean;
}

const execFileAsync = promisify(execFile);
const gitOutputLimit = 8 * 1024 * 1024;
const patchPreviewLimit = 24 * 1024;
const defaultMaxPatchPreviewBytes = 64 * 1024;
const defaultMaxGitOutputBytes = 1024 * 1024;

export class GitCommandError extends Error {
  readonly stderr: string;

  constructor(message: string, stderr: string) {
    super(message);
    this.name = "GitCommandError";
    this.stderr = stderr;
  }
}

export class DeliveryCommitError extends Error {
  readonly code: DeliveryCommitErrorCode;

  constructor(code: DeliveryCommitErrorCode, message: string) {
    super(message);
    this.name = "DeliveryCommitError";
    this.code = code;
  }
}

export class DeliveryRemoteActionError extends Error {
  readonly code: DeliveryRemoteActionErrorCode;

  constructor(code: DeliveryRemoteActionErrorCode, message: string) {
    super(message);
    this.name = "DeliveryRemoteActionError";
    this.code = code;
  }
}

class AdoptionTargetBaseMismatchError extends Error {
  constructor(branchName: string, expectedHead: string, actualHead: string) {
    super(`Target branch HEAD mismatch for ${branchName}: expected ${expectedHead}, got ${actualHead}.`);
    this.name = "AdoptionTargetBaseMismatchError";
  }
}

export class NodeGitWorktreeService implements ManagedWorktreeService, VariantAdoptionService, ChangesetEvidenceService, ChangesetService {
  private readonly eventLog: ManagedWorktreeWorkflowEvent[];
  private readonly eventSink?: ManagedWorktreeEventSink;
  private readonly now: () => string;
  private readonly runState: ManagedWorktreeRunState;

  constructor(options: NodeGitWorktreeServiceOptions = {}) {
    this.eventLog = [...(options.initialEvents ?? [])];
    this.eventSink = options.eventSink;
    this.now = options.now ?? (() => new Date().toISOString());
    this.runState = options.runState ?? { hasRunningTasks: async () => false };
  }

  async createManagedWorktree(input: ManagedWorktreeCreateInput): Promise<WorkflowWorktreeIdentity> {
    let plan: ManagedWorktreePlan;
    try {
      plan = await this.planCreate(input);
    } catch (error) {
      await this.recordCreateFailure(createFailureFactsFromInput(input), error);
      throw error;
    }

    const existing = this.findCreatedWorktreeEvent(plan.worktreeId);
    if (existing) {
      try {
        verifyCreateRequestMatchesCreatedEvent(plan, existing);
        return await this.reconcileManagedWorktree(existing.worktree, { allowHeadAdvance: true });
      } catch (error) {
        await this.recordCreateFailure(plan, error);
        throw error;
      }
    }

    await this.record("workflow.worktree.create_requested", {
      ...eventPlan(plan),
      status: "requested",
    }, `worktree:${plan.worktreeId}:create-requested`, plan.sessionId);

    try {
      await validateSkyTurnBranch(plan.repoRoot, plan.branchName);
      const baseCommit = await verifyCommit(plan.repoRoot, plan.baseCommit, "base commit");
      await runGit(plan.repoRoot, ["worktree", "add", "-b", plan.branchName, "--", plan.path, baseCommit]);
      const worktree = await this.reconcilePlan(plan, { expectedHeadCommit: baseCommit });
      await this.record("workflow.worktree.created", {
        worktree,
      }, `worktree:${plan.worktreeId}:created`, plan.sessionId);
      return worktree;
    } catch (error) {
      await this.recordCreateFailure(plan, error);
      throw error;
    }
  }

  async recoverManagedWorktreeCreate(input: ManagedWorktreeCreateInput): Promise<ManagedWorktreeRecoveryResult> {
    const plan = await this.planCreate(input);
    if (!this.hasCreateRequestEvent(plan.worktreeId)) {
      throw new Error(`No create_requested event for ${plan.worktreeId}.`);
    }
    try {
      await stat(plan.path);
      const worktree = await this.reconcilePlan(plan);
      await this.record("workflow.worktree.created", {
        worktree,
        recovered: true,
      }, `worktree:${plan.worktreeId}:created`, plan.sessionId);
      return { ok: true, status: "created", worktree };
    } catch (error) {
      const reason = errorMessage(error);
      await this.record("workflow.worktree.create_failed", {
        ...eventPlan(plan),
        status: "orphaned",
        recovered: true,
        reason,
      }, `worktree:${plan.worktreeId}:recovery-orphaned`, plan.sessionId);
      return { ok: false, status: "orphaned", reason };
    }
  }

  async recoverRequestedWorktreeCreates(): Promise<ManagedWorktreeRecoveryResult[]> {
    const results: ManagedWorktreeRecoveryResult[] = [];
    for (const event of this.eventLog) {
      if (event.kind !== "workflow.worktree.create_requested") continue;
      const worktreeId = worktreeIdFromEvent(event);
      if (!worktreeId || this.hasCreateTerminalEvent(worktreeId)) continue;
      const input = createInputFromRequestedEvent(event);
      if (!input) continue;
      results.push(await this.recoverManagedWorktreeCreate(input));
    }
    return results;
  }

  async reconcileManagedWorktree(
    worktree: WorkflowWorktreeIdentity,
    options: ReconcileOptions = {},
  ): Promise<WorkflowWorktreeIdentity> {
    const repoRoot = await assertGitRepo(worktree.repoRoot);
    const managedRoot = await ensureManagedRoot(repoRoot);
    const realPath = await realpath(worktree.realPath || worktree.path);
    assertPathInside(realPath, managedRoot, "worktree path");
    const entry = await findListedWorktree(repoRoot, realPath);
    const gitdir = await readGitDirFile(realPath);
    if (worktree.gitdir) assertSamePath(gitdir, worktree.gitdir, "gitdir");

    const branchName = await currentBranch(realPath);
    if (branchName !== worktree.branchName) {
      throw new Error(`Worktree branch mismatch: expected ${worktree.branchName}, got ${branchName}.`);
    }
    if (entry.branch !== `refs/heads/${branchName}`) {
      throw new Error(`git worktree list branch mismatch for ${realPath}.`);
    }

    const headCommit = await currentHead(realPath);
    const expectedHead = options.allowHeadAdvance ? null : (options.expectedHeadCommit ?? worktree.headCommit);
    if (expectedHead && headCommit !== expectedHead) {
      throw new Error(`Worktree HEAD mismatch: expected ${expectedHead}, got ${headCommit}.`);
    }
    if (entry.head !== headCommit) {
      throw new Error(`git worktree list HEAD mismatch for ${realPath}.`);
    }

    await verifyCommit(repoRoot, worktree.baseCommit, "base commit");
    await ensureAncestor(repoRoot, worktree.baseCommit, headCommit);

    return {
      ...worktree,
      path: realPath,
      realPath,
      gitdir,
      repoRoot,
      branchName,
      headCommit,
    };
  }

  async compareVariants(input: VariantComparisonInput): Promise<VariantComparisonEvidence> {
    const collectedAt = this.now();
    const left = await this.reconcileManagedWorktree(input.left);
    const right = await this.reconcileManagedWorktree(input.right);
    const leftChangeset = await this.collectChangesetEvidence({ node: minimalNode(left), worktree: left });
    const rightChangeset = await this.collectChangesetEvidence({ node: minimalNode(right), worktree: right });
    const leftRecorded = { ...input.recordedEvidence?.[left.variantId], changeset: leftChangeset };
    const rightRecorded = { ...input.recordedEvidence?.[right.variantId], changeset: rightChangeset };
    return {
      comparisonId: `comparison-${left.variantId}-${right.variantId}-${collectedAt}`,
      collectedAt,
      variants: [
        {
          variantId: left.variantId,
          worktreeId: left.worktreeId,
          changeset: leftChangeset,
          metrics: buildAdjudicationMetrics(leftRecorded),
        },
        {
          variantId: right.variantId,
          worktreeId: right.worktreeId,
          changeset: rightChangeset,
          metrics: buildAdjudicationMetrics(rightRecorded),
        },
      ],
    };
  }

  async adoptVariant(input: WorkflowVariantAdoption): Promise<WorkflowVariantAdoption> {
    const requested: WorkflowVariantAdoption = { ...input, status: "requested" };
    await this.record("workflow.variant.adopt_requested", {
      adoption: requested,
    }, `variant:${input.adoptionId}:adopt-requested`);

    const eventWorktree = this.findCreatedWorktree(input.worktreeId);
    let repoRoot: string | null = eventWorktree?.repoRoot ?? null;
    try {
      if (!eventWorktree) throw new Error(`No created worktree event for ${input.worktreeId}.`);
      verifyAdoptionRecord(input, eventWorktree);
      const worktree = await this.reconcileManagedWorktree(eventWorktree, { expectedHeadCommit: input.headCommit });
      repoRoot = worktree.repoRoot;
      await assertCleanWorktree(worktree.realPath, "variant worktree");
      await validateTargetBranch(worktree.repoRoot, input.targetBranchName);
      await checkoutTargetBranch(worktree.repoRoot, input.targetBranchName);
      await assertCleanWorktree(worktree.repoRoot, "target worktree");
      await assertTargetHeadMatchesBase(worktree.repoRoot, input);
      await previewAdoption(worktree.repoRoot, input);
      await applyAdoption(worktree.repoRoot, input);
      const adoptedCommit = await currentHead(worktree.repoRoot);
      const adopted: WorkflowVariantAdoption = { ...input, status: "adopted", adoptedCommit };
      await this.record("workflow.variant.adopted", {
        adoption: adopted,
      }, `variant:${input.adoptionId}:adopted`);
      return adopted;
    } catch (error) {
      if (repoRoot) await abortAdoption(repoRoot);
      const failed: WorkflowVariantAdoption = {
        ...input,
        status: "failed",
        failureReason: errorMessage(error),
      };
      await this.record("workflow.variant.adopt_failed", {
        adoption: failed,
      }, `variant:${input.adoptionId}:adopt-failed`);
      if (error instanceof AdoptionTargetBaseMismatchError) throw error;
      return failed;
    }
  }

  async cleanManagedWorktree(input: ManagedWorktreeCleanupInput): Promise<ManagedWorktreeCleanupResult> {
    let failureWorktree = input.worktree;
    try {
      if (input.deleteBranch) {
        validateBranchName(input.worktree.branchName, { requireSkyTurnPrefix: true });
      }
      if (await this.runState.hasRunningTasks(input.worktree)) {
        throw new Error(`Cannot clean ${input.worktree.worktreeId}: running tasks still target this worktree.`);
      }
      const eventWorktree = this.findCreatedWorktree(input.worktree.worktreeId);
      if (!eventWorktree) throw new Error(`No created worktree event for ${input.worktree.worktreeId}.`);
      failureWorktree = eventWorktree;
      verifyCleanupRecord(input.worktree, eventWorktree);
      const worktree = await this.reconcileManagedWorktree(eventWorktree, { expectedHeadCommit: input.worktree.headCommit });
      failureWorktree = worktree;
      if (input.deleteBranch === true) {
        await assertBranchDeleteSafe(worktree.repoRoot, worktree.branchName);
      }
      await this.record("workflow.worktree.clean_requested", {
        worktree,
        deleteBranch: input.deleteBranch === true,
      }, `worktree:${worktree.worktreeId}:clean-requested`);

      await runGit(worktree.repoRoot, ["worktree", "remove", "--", worktree.realPath]);
      let branchDeleted = false;
      if (input.deleteBranch === true) {
        await runGit(worktree.repoRoot, ["branch", "-d", "--", worktree.branchName]);
        branchDeleted = true;
      }

      const cleanedAt = this.now();
      const result: ManagedWorktreeCleanupResult = {
        ok: true,
        worktreeId: worktree.worktreeId,
        cleanedAt,
        branchDeleted,
      };
      await this.record("workflow.worktree.cleaned", {
        worktree,
        result,
      }, `worktree:${worktree.worktreeId}:cleaned`);
      return result;
    } catch (error) {
      await this.recordCleanFailure(failureWorktree, error);
      throw error;
    }
  }

  async collectChangesetEvidence(input: ChangesetEvidenceInput): Promise<ChangesetEvidence> {
    const worktree = input.worktree ? await this.reconcileManagedWorktree(input.worktree) : undefined;
    const service = createGitChangesetService({ maxPatchPreviewBytes: patchPreviewLimit });
    return service.collectChangesetEvidence({ node: input.node, ...(worktree ? { worktree } : {}) });
  }

  async getChangeset(node: CanvasNode): Promise<Changeset> {
    return createGitChangesetService({ maxPatchPreviewBytes: patchPreviewLimit }).getChangeset(node);
  }

  private async planCreate(input: ManagedWorktreeCreateInput): Promise<ManagedWorktreePlan> {
    const repoRoot = await assertGitRepo(input.repoRoot);
    const managedRoot = await ensureManagedRoot(repoRoot);
    const sessionId = safeId(input.sessionId, "sessionId");
    const variantId = safeId(input.variantId, "variantId");
    const worktreeId = `worktree-${sessionId}-${variantId}`;
    const path = resolve(managedRoot, `session-${sessionId}-variant-${variantId}`);
    assertPathInside(path, managedRoot, "planned worktree path");
    return {
      sessionId: input.sessionId,
      worktreeId,
      variantId: input.variantId,
      repoRoot,
      managedRoot,
      path,
      baseCommit: input.baseCommit,
      branchName: input.branchName,
      parentLaneId: input.parentLaneId,
      ...(input.parentSegmentId ? { parentSegmentId: input.parentSegmentId } : {}),
    };
  }

  private async reconcilePlan(plan: ManagedWorktreePlan, options: ReconcileOptions = {}): Promise<WorkflowWorktreeIdentity> {
    const realPath = await realpath(plan.path);
    const gitdir = await readGitDirFile(realPath);
    const headCommit = await currentHead(realPath);
    const identity: WorkflowWorktreeIdentity = {
      worktreeId: plan.worktreeId,
      variantId: plan.variantId,
      path: realPath,
      realPath,
      gitdir,
      repoRoot: plan.repoRoot,
      branchName: plan.branchName,
      baseCommit: await verifyCommit(plan.repoRoot, plan.baseCommit, "base commit"),
      headCommit,
      parentLaneId: plan.parentLaneId,
      ...(plan.parentSegmentId ? { parentSegmentId: plan.parentSegmentId } : {}),
    };
    return this.reconcileManagedWorktree(identity, options);
  }

  private async record(
    kind: ManagedWorktreeWorkflowEventKind,
    payload: Record<string, unknown>,
    idempotencyKey: string,
    sessionId?: string,
  ): Promise<void> {
    if (this.eventLog.some((event) => event.idempotencyKey === idempotencyKey)) return;
    const event: ManagedWorktreeWorkflowEvent = {
      kind,
      source: "git-worktree",
      payload,
      createdAt: this.now(),
      idempotencyKey,
      ...(sessionId ? { sessionId } : {}),
    };
    await this.eventSink?.append(event);
    this.eventLog.push(event);
  }

  private recordCreateFailure(facts: ManagedWorktreeEventFacts, error: unknown): Promise<void> {
    return this.record("workflow.worktree.create_failed", {
      ...eventPlan(facts),
      status: "failed",
      reason: errorMessage(error),
    }, `worktree:${facts.worktreeId}:create-failed`, facts.sessionId);
  }

  private recordCleanFailure(worktree: WorkflowWorktreeIdentity, error: unknown): Promise<void> {
    const result: ManagedWorktreeCleanupResult = {
      ok: false,
      worktreeId: worktree.worktreeId,
      cleanedAt: this.now(),
      branchDeleted: false,
      reason: errorMessage(error),
    };
    return this.record("workflow.worktree.clean_failed", {
      worktree,
      result,
    }, `worktree:${worktree.worktreeId}:clean-failed`);
  }

  private findCreatedWorktree(worktreeId: string): WorkflowWorktreeIdentity | null {
    return this.findCreatedWorktreeEvent(worktreeId)?.worktree ?? null;
  }

  private findCreatedWorktreeEvent(worktreeId: string): CreatedWorktreeEvent | null {
    for (let index = this.eventLog.length - 1; index >= 0; index -= 1) {
      const event = this.eventLog[index];
      if (event?.kind !== "workflow.worktree.created") continue;
      const worktree = event.payload.worktree;
      if (isWorktreeIdentity(worktree) && worktree.worktreeId === worktreeId) return { event, worktree };
    }
    return null;
  }

  private hasCreateTerminalEvent(worktreeId: string): boolean {
    return this.eventLog.some((event) => {
      if (event.kind !== "workflow.worktree.created" && event.kind !== "workflow.worktree.create_failed") return false;
      return worktreeIdFromEvent(event) === worktreeId;
    });
  }

  private hasCreateRequestEvent(worktreeId: string): boolean {
    return this.eventLog.some((event) => (
      event.kind === "workflow.worktree.create_requested" && worktreeIdFromEvent(event) === worktreeId
    ));
  }
}

export function createNodeGitWorktreeService(options: NodeGitWorktreeServiceOptions = {}): NodeGitWorktreeService {
  return new NodeGitWorktreeService(options);
}

export interface GitChangesetServiceOptions {
  repoRoot?: string;
  maxPatchPreviewBytes?: number;
}

export function createGitChangesetService(
  options: GitChangesetServiceOptions = {},
): ChangesetService & ChangesetEvidenceService & ChangesetReconciliationService {
  return new GitChangesetService(options);
}

export function createGitVariantComparisonService(
  options: GitChangesetServiceOptions = {},
): Pick<ManagedWorktreeService, "compareVariants"> {
  return new GitVariantComparisonService(options);
}

export async function getGitBranchFacts(repoRoot: string): Promise<GitBranchFacts> {
  const [branchResult, refsResult] = await Promise.all([
    runGit(repoRoot, ["branch", "--show-current"], { allowFailure: true }),
    runGit(repoRoot, ["for-each-ref", "--format=%(refname:short)", "refs/heads"], { allowFailure: true }),
  ]);
  const currentBranch = branchResult.exitCode === 0 && branchResult.stdout ? branchResult.stdout : "HEAD";
  const branches = unionSorted([
    currentBranch,
    ...(refsResult.exitCode === 0 ? stringLines(refsResult.stdout) : []),
  ]);
  return {
    currentBranch,
    branches: branches.length > 0 ? branches : ["HEAD"],
  };
}

export async function createDeliveryCommit(input: DeliveryCommitInput): Promise<DeliveryCommitEvidence> {
  assertDeliveryReconciliationStatus(input.reconciliationStatus, input.acceptMismatch === true);
  const subject = normalizeCommitSubject(input.subject);
  const body = typeof input.body === "string" && input.body.trim().length > 0 ? input.body.trim() : undefined;
  const worktreePath = await resolveDeliveryWorktreePath(input.projectRoot, input.worktreePath);
  const files = await normalizeDeliveryFileList(worktreePath, input.files);
  const statusLines = parseStatusLines((await git(worktreePath, ["status", "--porcelain=v1", "--untracked-files=all", "--"])).stdout);
  const changedFiles = new Set(filesFromStatus(statusLines));
  const missingFromChangeset = files.filter((file) => !changedFiles.has(file));
  if (missingFromChangeset.length > 0) {
    throwDelivery("DELIVERY_REJECTED", `Requested files are not in the reconciled changeset: ${missingFromChangeset.join(", ")}.`);
  }

  await runGit(worktreePath, ["add", "--", ...files]);
  const stagedFiles = stringLines((await git(worktreePath, ["diff", "--cached", "--name-only", "--", ...files])).stdout).sort();
  if (stagedFiles.length === 0) {
    throwDelivery("DELIVERY_REJECTED", "Refusing to create an empty delivery commit.");
  }
  if (!sameStringSet(stagedFiles, files)) {
    throwDelivery("DELIVERY_REJECTED", `Staged files do not match requested files: ${stagedFiles.join(", ")}.`);
  }

  const commitArgs = ["commit", "--only", "-m", subject, ...(body ? ["-m", body] : []), "--", ...files];
  const command = await runDeliveryGitCommand(worktreePath, commitArgs);
  const commitSha = await currentHead(worktreePath);
  const committedFiles = stringLines((await git(worktreePath, [
    "diff-tree",
    "--no-commit-id",
    "--name-only",
    "-r",
    commitSha,
    "--",
  ])).stdout).sort();
  if (!sameStringSet(committedFiles, files)) {
    throwDelivery("DELIVERY_REJECTED", `Committed files do not match requested files: ${committedFiles.join(", ")}.`);
  }
  const branch = await currentBranch(worktreePath);
  return {
    status: "committed",
    commitSha,
    branch,
    stagedFiles,
    worktreePath,
    command,
    check: {
      name: "delivery-commit-preflight",
      ok: true,
      detail: "Requested files matched git status, the staged index, and the committed file set.",
      files: committedFiles,
    },
  };
}

export async function pushDeliveryBranch(input: DeliveryPushInput): Promise<DeliveryPushEvidence> {
  const remote = normalizeRemoteName(input.remote ?? "origin");
  const facts = await resolveDeliveryActionFacts(input);
  await assertRemoteExists(facts.worktreePath, remote);
  const command = await runDeliveryCommand("git", facts.worktreePath, ["push", remote, `HEAD:refs/heads/${facts.branch}`]);
  return {
    status: "pushed",
    remote,
    branch: facts.branch,
    commitSha: facts.commitSha,
    worktreePath: facts.worktreePath,
    command,
  };
}

export async function createDeliveryPullRequest(input: DeliveryPullRequestInput): Promise<DeliveryPullRequestEvidence> {
  const remote = normalizeRemoteName(input.remote ?? "origin");
  const facts = await resolveDeliveryActionFacts({
    projectRoot: input.projectRoot,
    worktreePath: input.worktreePath,
    commitSha: input.commitSha,
    branch: input.headBranch,
  });
  const base = await normalizeExistingBaseBranch(facts.worktreePath, remote, input.baseBranch);
  if (base === facts.branch) {
    throwRemote("DELIVERY_REJECTED", "Pull request base and head branches must differ.");
  }
  const title = normalizeCommitSubject(input.title);
  const body = normalizePullRequestBody(input, facts);
  await assertRemoteExists(facts.worktreePath, remote);
  await assertRemoteBranchHeadMatchesCommit(facts.worktreePath, remote, facts.branch, facts.commitSha);
  await ensureGhAvailable(facts.worktreePath);
  await ensureGhAuthenticated(facts.worktreePath);
  const command = await runDeliveryCommand("gh", facts.worktreePath, [
    "pr",
    "create",
    "--base",
    base,
    "--head",
    facts.branch,
    "--title",
    title,
    "--body",
    body,
  ]);
  const url = pullRequestUrlFromOutput(command.stdout);
  const number = pullRequestNumberFromUrl(url);
  return {
    status: "created",
    url,
    number,
    head: facts.branch,
    base,
    remote,
    commitSha: facts.commitSha,
    title,
    command,
  };
}

export async function checkDeliveryPullRequest(input: DeliveryPullRequestChecksInput): Promise<DeliveryPullRequestChecksEvidence> {
  const repoRoot = await assertGitRepo(input.projectRoot);
  const expectedHeadSha = normalizeExpectedHeadSha(input.expectedHeadSha);
  await ensureGhAvailable(repoRoot);
  await ensureGhAuthenticated(repoRoot);
  const pr = await fetchPullRequestState(repoRoot, input, expectedHeadSha);
  const execution = await runDeliveryCommandWithRawOutput("gh", repoRoot, [
    "pr",
    "checks",
    String(pr.number),
    "--json",
    "name,state,bucket,workflow,link,description",
  ], "DELIVERY_REJECTED", { allowFailure: true });
  const checks = parsePullRequestChecks(execution.rawStdout);
  const status = aggregatePullRequestChecks(checks);
  const verifiedPr = await fetchPullRequestState(repoRoot, { prNumber: pr.number }, expectedHeadSha);
  return {
    status,
    number: verifiedPr.number,
    ...(verifiedPr.url ? { url: verifiedPr.url } : {}),
    headSha: verifiedPr.headSha,
    checks,
    review: verifiedPr.review,
    gate: {
      headSha: verifiedPr.headSha,
      checksStatus: status,
      reviewStatus: verifiedPr.review.status,
      state: verifiedPr.state,
      mergeable: verifiedPr.mergeable,
    },
    command: execution.result,
    summary: pullRequestChecksSummary(checks, status, verifiedPr.review),
  };
}

export async function mergeDeliveryPullRequest(input: DeliveryPullRequestMergeInput): Promise<DeliveryPullRequestMergeEvidence> {
  const repoRoot = await assertGitRepo(input.projectRoot);
  const expectedHeadSha = normalizeExpectedHeadSha(input.expectedHeadSha);
  const subject = normalizeCommitSubject(input.subject);
  const body = typeof input.body === "string" && input.body.trim().length > 0 ? input.body.trim() : undefined;
  await ensureGhAvailable(repoRoot);
  await ensureGhAuthenticated(repoRoot);
  const pr = await fetchPullRequestState(repoRoot, input, expectedHeadSha);
  if (pr.state !== "OPEN") throwRemote("DELIVERY_REJECTED", `Pull request must be open before merge; got ${pr.state}.`);
  if (!pr.mergeable) throwRemote("DELIVERY_REJECTED", "Pull request is not mergeable.");
  const checksEvidence = await checkDeliveryPullRequest({
    projectRoot: repoRoot,
    prNumber: pr.number,
    expectedHeadSha,
  });
  if (checksEvidence.status !== "passed") {
    throwRemote("DELIVERY_REJECTED", `Pull request checks must be passed before merge; got ${checksEvidence.status}.`);
  }
  if (checksEvidence.review.status === "changes_requested") {
    throwRemote("DELIVERY_REJECTED", "Pull request review requested changes before merge.");
  }
  const command = await runDeliveryCommand("gh", repoRoot, [
    "pr",
    "merge",
    String(pr.number),
    "--match-head-commit",
    expectedHeadSha,
    "--squash",
    "--subject",
    subject,
    ...(body ? ["--body", body] : []),
  ]);
  return {
    status: "merged",
    number: pr.number,
    ...(pr.url ? { url: pr.url } : {}),
    headSha: pr.headSha,
    subject,
    checks: checksEvidence.checks,
    review: checksEvidence.review,
    command,
  };
}

export async function syncDeliveryMain(input: DeliveryMainSyncInput): Promise<DeliveryMainSyncEvidence> {
  const repoRoot = await assertGitRepo(input.projectRoot);
  const remote = normalizeRemoteName(input.remote ?? "origin");
  const mainBranch = await normalizeDeliveryBranch(repoRoot, input.mainBranch ?? "main", "main branch");
  const current = await currentBranch(repoRoot);
  if (current !== mainBranch) {
    throwRemote("DELIVERY_REJECTED", `Refusing to sync ${mainBranch} while current branch is ${current}.`);
  }
  await assertRemoteExists(repoRoot, remote);
  const fetch = await runDeliveryCommand("git", repoRoot, ["fetch", remote, mainBranch]);
  const pull = await runDeliveryCommand("git", repoRoot, ["pull", "--ff-only", remote, mainBranch]);
  return {
    status: "synced",
    mainBranch,
    remote,
    commands: [fetch, pull],
  };
}

interface DeliveryActionFacts {
  worktreePath: string;
  commitSha: string;
  branch: string;
}

async function resolveDeliveryActionFacts(input: DeliveryPushInput): Promise<DeliveryActionFacts> {
  const worktreePath = await resolveDeliveryWorktreePath(input.projectRoot, input.worktreePath);
  const commitSha = await verifyCommit(worktreePath, input.commitSha, "delivery commit");
  const headCommit = await currentHead(worktreePath);
  if (headCommit !== commitSha) {
    throwRemote("DELIVERY_REJECTED", `Delivery commit must match worktree HEAD: expected ${commitSha}, got ${headCommit}.`);
  }
  const current = await currentBranch(worktreePath);
  const branch = input.branch ? await normalizeDeliveryBranch(worktreePath, input.branch, "delivery branch") : current;
  if (branch !== current) {
    throwRemote("DELIVERY_REJECTED", `Delivery branch must match the current worktree branch: expected ${current}, got ${branch}.`);
  }
  return { worktreePath, commitSha, branch };
}

function normalizeRemoteName(value: string): string {
  const remote = typeof value === "string" ? value.trim() : "";
  if (!/^[A-Za-z0-9._-]+$/.test(remote)) {
    throwRemote("INVALID_INPUT", "Git remote name is invalid.");
  }
  return remote;
}

async function normalizeDeliveryBranch(cwd: string, value: string, label: string): Promise<string> {
  const branch = typeof value === "string" ? value.trim() : "";
  try {
    validateBranchName(branch, { requireSkyTurnPrefix: false });
    await runGit(cwd, ["check-ref-format", "--branch", branch]);
  } catch {
    throwRemote("INVALID_INPUT", `${label} is invalid.`);
  }
  return branch;
}

async function normalizeExistingBaseBranch(cwd: string, remote: string, value: string): Promise<string> {
  const branch = await normalizeDeliveryBranch(cwd, value, "pull request base branch");
  const local = await runGit(cwd, ["rev-parse", "--verify", `refs/heads/${branch}^{commit}`], { allowFailure: true });
  if (local.exitCode === 0) return branch;
  const remoteRef = await runGit(cwd, ["rev-parse", "--verify", `refs/remotes/${remote}/${branch}^{commit}`], { allowFailure: true });
  if (remoteRef.exitCode === 0) return branch;
  const remoteHead = await runGit(cwd, ["ls-remote", "--exit-code", "--heads", remote, branch], { allowFailure: true });
  if (remoteHead.exitCode === 0) return branch;
  throwRemote("INVALID_INPUT", `Pull request base branch does not resolve locally or on ${remote}: ${branch}.`);
}

async function assertRemoteExists(cwd: string, remote: string): Promise<void> {
  const result = await runGit(cwd, ["remote", "get-url", "--push", remote], { allowFailure: true });
  if (result.exitCode !== 0) throwRemote("INVALID_INPUT", `Git remote is not configured: ${remote}.`);
}

async function assertRemoteBranchHeadMatchesCommit(cwd: string, remote: string, branch: string, expectedCommitSha: string): Promise<void> {
  const result = await runGit(cwd, ["ls-remote", "--exit-code", "--heads", remote, branch], { allowFailure: true });
  if (result.exitCode !== 0) {
    throwRemote("DELIVERY_REJECTED", `Remote branch was not found after push: ${remote}/${branch}.`);
  }
  const remoteSha = remoteHeadShaFromLsRemote(result.stdout, branch);
  if (!remoteSha) {
    throwRemote("DELIVERY_REJECTED", `Remote branch was not found after push: ${remote}/${branch}.`);
  }
  if (remoteSha !== expectedCommitSha) {
    throwRemote(
      "REMOTE_HEAD_MISMATCH",
      `Remote branch head does not match delivery commit for ${remote}/${branch}: expected ${shortSha(expectedCommitSha)}, got ${shortSha(remoteSha)}.`,
    );
  }
}

function remoteHeadShaFromLsRemote(output: string, branch: string): string | null {
  const expectedRef = `refs/heads/${branch}`;
  for (const line of output.split(/\r?\n/)) {
    const [sha, ref] = line.trim().split(/\s+/);
    if (sha && ref === expectedRef && /^[0-9a-fA-F]{7,64}$/.test(sha)) return sha;
  }
  return null;
}

function shortSha(sha: string): string {
  return sha.slice(0, 12);
}

async function ensureGhAvailable(cwd: string): Promise<void> {
  await runDeliveryCommand("gh", cwd, ["--version"], "GH_UNAVAILABLE");
}

async function ensureGhAuthenticated(cwd: string): Promise<void> {
  await runDeliveryCommand("gh", cwd, ["auth", "status"], "AUTH_REQUIRED");
}

function normalizePullRequestBody(input: DeliveryPullRequestInput, facts: DeliveryActionFacts): string {
  if (typeof input.body === "string" && input.body.trim()) {
    const body = input.body.trim();
    for (const section of ["What changed?", "Why?", "Breaking changes?", "Server PR"]) {
      if (!body.includes(section)) throwRemote("INVALID_INPUT", `Pull request body must include ${section}.`);
    }
    return body;
  }
  return [
    "**What changed?**",
    input.whatChanged?.trim() || `Pushed delivery commit ${facts.commitSha.slice(0, 12)} from ${facts.branch}.`,
    "",
    "**Why?**",
    input.why?.trim() || "Prepare the verified delivery branch for review.",
    "",
    "**Breaking changes?**",
    input.breakingChanges?.trim() || "None.",
    "",
    "**Server PR**",
    input.serverPr?.trim() || "None.",
  ].join("\n");
}

interface PullRequestState {
  number: number;
  url?: string;
  headSha: string;
  state: string;
  mergeable: boolean;
  review: DeliveryPullRequestReviewGate;
}

async function fetchPullRequestState(
  cwd: string,
  input: Pick<DeliveryPullRequestChecksInput, "prNumber" | "prUrl">,
  expectedHeadSha: string,
): Promise<PullRequestState> {
  const selector = pullRequestSelector(input);
  const execution = await runDeliveryCommandWithRawOutput("gh", cwd, [
    "pr",
    "view",
    selector,
    "--json",
    "number,url,headRefOid,state,mergeable,reviewDecision,reviews",
  ]);
  const value = parseJsonObject(execution.rawStdout, "GitHub CLI did not return pull request JSON.");
  const number = normalizePullRequestNumber(value.number ?? input.prNumber ?? numberFromPullRequestUrl(input.prUrl));
  const headSha = normalizeExpectedHeadSha(value.headRefOid);
  if (headSha !== expectedHeadSha) {
    throwRemote(
      "REMOTE_HEAD_MISMATCH",
      `Pull request head does not match expected delivery commit: expected ${shortSha(expectedHeadSha)}, got ${shortSha(headSha)}.`,
    );
  }
  const state = typeof value.state === "string" && value.state.trim() ? value.state.trim().toUpperCase() : "UNKNOWN";
  return {
    number,
    ...(typeof value.url === "string" && value.url.trim() ? { url: value.url.trim() } : {}),
    headSha,
    state,
    mergeable: normalizePullRequestMergeable(value.mergeable),
    review: normalizePullRequestReviewGate(value),
  };
}

function pullRequestSelector(input: Pick<DeliveryPullRequestChecksInput, "prNumber" | "prUrl">): string {
  if (typeof input.prNumber === "number" && Number.isSafeInteger(input.prNumber) && input.prNumber > 0) {
    return String(input.prNumber);
  }
  if (typeof input.prUrl === "string" && input.prUrl.trim()) {
    numberFromPullRequestUrl(input.prUrl);
    return input.prUrl.trim();
  }
  throwRemote("INVALID_INPUT", "Pull request number or URL is required.");
}

function normalizePullRequestNumber(value: unknown): number {
  const number = typeof value === "number" ? value : typeof value === "string" ? Number(value) : NaN;
  if (!Number.isSafeInteger(number) || number <= 0) throwRemote("INVALID_INPUT", "Pull request number is invalid.");
  return number;
}

function numberFromPullRequestUrl(value: unknown): number | null {
  if (typeof value !== "string" || !value.trim()) return null;
  const match = value.trim().match(/\/pull\/(\d+)$/);
  if (!match) throwRemote("INVALID_INPUT", "Pull request URL is invalid.");
  return normalizePullRequestNumber(match[1]);
}

function normalizeExpectedHeadSha(value: unknown): string {
  const sha = typeof value === "string" ? value.trim().toLowerCase() : "";
  if (!/^[0-9a-f]{40}$/.test(sha)) throwRemote("INVALID_INPUT", "Expected pull request head SHA must be a full commit SHA.");
  return sha;
}

function normalizePullRequestMergeable(value: unknown): boolean {
  if (value === true) return true;
  if (typeof value !== "string") return false;
  return value.trim().toUpperCase() === "MERGEABLE";
}

function normalizePullRequestReviewGate(value: Record<string, unknown>): DeliveryPullRequestReviewGate {
  const decision = textFromUnknown(value.reviewDecision);
  const latestReview = latestActionableReview(value.reviews);
  const status = reviewStatusFromDecision(decision) ?? reviewStatusFromDecision(latestReview?.state) ?? "unknown";
  return {
    status,
    decision: sanitizeCommandOutput(decision ?? latestReview?.state ?? "UNKNOWN"),
    ...(latestReview?.detail ? { detail: sanitizeCommandOutput(latestReview.detail) } : {}),
    ...(latestReview?.reviewer ? { reviewer: sanitizeCommandOutput(latestReview.reviewer) } : {}),
    ...(latestReview?.link ? { link: sanitizeCommandOutput(latestReview.link) } : {}),
  };
}

function latestActionableReview(value: unknown): { state: string; reviewer?: string; detail?: string; link?: string } | null {
  if (!Array.isArray(value)) return null;
  const reviews = value
    .filter(isRecord)
    .map((review, index) => ({
      state: textFromUnknown(review.state) ?? textFromUnknown(review.reviewDecision) ?? "",
      reviewer: reviewAuthor(review.author),
      detail: textFromUnknown(review.body) ?? textFromUnknown(review.description) ?? undefined,
      link: textFromUnknown(review.url) ?? textFromUnknown(review.link) ?? undefined,
      index,
    }))
    .filter((review) => review.state);
  return reviews.reverse().find((review) => {
    const status = reviewStatusFromDecision(review.state);
    return status === "approved" || status === "changes_requested";
  }) ?? null;
}

function reviewAuthor(value: unknown): string | undefined {
  if (isRecord(value)) return textFromUnknown(value.login) ?? undefined;
  return textFromUnknown(value) ?? undefined;
}

function reviewStatusFromDecision(value: string | null | undefined): DeliveryPullRequestReviewGate["status"] | null {
  const decision = value?.trim().toLowerCase();
  if (!decision) return null;
  if (decision === "approved" || decision === "approve") return "approved";
  if (decision === "changes_requested" || decision === "changes requested") return "changes_requested";
  if (decision === "review_required" || decision === "review required" || decision === "pending") return "pending";
  return null;
}

function parsePullRequestChecks(output: string): DeliveryPullRequestCheck[] {
  const value = parseJsonArray(output, "GitHub CLI did not return pull request checks JSON.");
  return value.map((item) => normalizePullRequestCheck(item)).filter((item): item is DeliveryPullRequestCheck => item !== null);
}

function normalizePullRequestCheck(value: unknown): DeliveryPullRequestCheck | null {
  if (!isRecord(value)) return null;
  const name = textFromUnknown(value.name) ?? textFromUnknown(value.workflow);
  if (!name) return null;
  const rawState = textFromUnknown(value.state) ?? textFromUnknown(value.bucket) ?? "UNKNOWN";
  const status = pullRequestCheckStatus(rawState);
  const workflow = textFromUnknown(value.workflow);
  const link = textFromUnknown(value.link);
  const detail = textFromUnknown(value.description);
  return {
    name: sanitizeCommandOutput(name),
    status,
    state: sanitizeCommandOutput(rawState),
    ...(workflow ? { workflow: sanitizeCommandOutput(workflow) } : {}),
    ...(link ? { link: sanitizeCommandOutput(link) } : {}),
    ...(detail ? { detail: sanitizeCommandOutput(detail) } : {}),
  };
}

function pullRequestCheckStatus(value: string): DeliveryPullRequestCheck["status"] {
  const state = value.trim().toLowerCase();
  if (["success", "successful", "passed", "pass"].includes(state)) return "passed";
  if (["failure", "failed", "fail", "error", "cancelled", "canceled", "timed_out", "action_required", "startup_failure"].includes(state)) {
    return "failed";
  }
  return "pending";
}

function aggregatePullRequestChecks(checks: DeliveryPullRequestCheck[]): DeliveryPullRequestChecksEvidence["status"] {
  if (checks.some((check) => check.status === "failed")) return "failed";
  if (checks.length > 0 && checks.every((check) => check.status === "passed")) return "passed";
  return "pending";
}

function pullRequestChecksSummary(
  checks: DeliveryPullRequestCheck[],
  status: DeliveryPullRequestChecksEvidence["status"],
  review: DeliveryPullRequestReviewGate,
): string {
  const passed = checks.filter((check) => check.status === "passed").length;
  const failed = checks.filter((check) => check.status === "failed").length;
  const pending = checks.filter((check) => check.status === "pending").length;
  return `${checks.length} checks: ${passed} passed, ${failed} failed, ${pending} pending; overall ${status}; review ${review.status}.`;
}

function parseJsonObject(output: string, message: string): Record<string, unknown> {
  try {
    const parsed = JSON.parse(output);
    if (isRecord(parsed)) return parsed;
  } catch {
    // Fall through to normalized delivery error.
  }
  throwRemote("DELIVERY_REJECTED", message);
}

function parseJsonArray(output: string, message: string): unknown[] {
  try {
    const parsed = JSON.parse(output);
    if (Array.isArray(parsed)) return parsed;
  } catch {
    // Fall through to normalized delivery error.
  }
  throwRemote("DELIVERY_REJECTED", message);
}

function textFromUnknown(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

async function runDeliveryCommand(
  command: "git" | "gh",
  cwd: string,
  args: string[],
  failureCode: DeliveryRemoteActionErrorCode = "DELIVERY_REJECTED",
  options: { allowFailure?: boolean } = {},
): Promise<DeliveryCommandResult> {
  return (await runDeliveryCommandWithRawOutput(command, cwd, args, failureCode, options)).result;
}

interface DeliveryCommandExecution {
  result: DeliveryCommandResult;
  rawStdout: string;
}

async function runDeliveryCommandWithRawOutput(
  command: "git" | "gh",
  cwd: string,
  args: string[],
  failureCode: DeliveryRemoteActionErrorCode = "DELIVERY_REJECTED",
  options: { allowFailure?: boolean } = {},
): Promise<DeliveryCommandExecution> {
  try {
    const result = await execFileAsync(command, args, {
      cwd,
      encoding: "utf8",
      maxBuffer: gitOutputLimit,
      shell: false,
    });
    const rawStdout = String(result.stdout).trim();
    const rawStderr = String(result.stderr).trim();
    return {
      result: {
        command,
        args: command === "gh" ? redactGhArgs(args) : args,
        ok: true,
        exitCode: 0,
        stdout: sanitizeCommandOutput(rawStdout),
        stderr: sanitizeCommandOutput(rawStderr),
      },
      rawStdout,
    };
  } catch (error) {
    const failure = error as { code?: number | string; stderr?: string; stdout?: string; message?: string };
    const code = command === "gh" && failure.code === "ENOENT" ? "GH_UNAVAILABLE" : failureCode;
    const rawStdout = String(failure.stdout || "").trim();
    const rawStderr = String(failure.stderr || "").trim();
    const stdout = sanitizeCommandOutput(rawStdout);
    const stderr = sanitizeCommandOutput(rawStderr);
    if (options.allowFailure) {
      return {
        result: {
          command,
          args: command === "gh" ? redactGhArgs(args) : args,
          ok: false,
          exitCode: typeof failure.code === "number" ? failure.code : 1,
          stdout,
          stderr,
        },
        rawStdout,
      };
    }
    const detail = sanitizeCommandOutput(String(failure.stderr || failure.stdout || failure.message || "").trim());
    throwRemote(code, `${command} ${args[0]} failed: ${detail || "command failed"}.`);
  }
}

function redactGhArgs(args: string[]): string[] {
  return args.map((arg, index) => (
    args[index - 1] === "--body" || args[index - 1] === "--subject" || args[index - 1] === "--title"
      ? sanitizeCommandOutput(arg)
      : arg
  ));
}

function sanitizeCommandOutput(value: string): string {
  return value
    .replace(/-----BEGIN [^-]+PRIVATE KEY-----[\s\S]*?-----END [^-]+PRIVATE KEY-----/g, "[REDACTED_PRIVATE_KEY]")
    .replace(/\b(authorization)\b\s*[:=]\s*bearer\s+[^\s"',;}\]]+/gi, "$1: Bearer [REDACTED]")
    .replace(/\b(authorization)\b\s*[:=]\s*(?!bearer\b)[^\s"',;}\]]+/gi, "$1=[REDACTED]")
    .replace(/\b(token|secret|password|api[_-]?key|cookie)\b\s*[:=]\s*[^\s"',;}\]]+/gi, "$1=[REDACTED]")
    .replace(/\b[A-Za-z][A-Za-z0-9+.-]*:\/\/[^\s/@:]+:[^\s/@]+@[^\s]+/g, "[REDACTED_URL]")
    .replace(/\s+$/g, "");
}

function pullRequestUrlFromOutput(output: string): string {
  const match = output.match(/https?:\/\/[A-Za-z0-9.-]+\/[^/\s]+\/[^/\s]+\/pull\/\d+/);
  if (!match) throwRemote("DELIVERY_REJECTED", "GitHub CLI did not return a pull request URL.");
  return match[0];
}

function pullRequestNumberFromUrl(url: string): number {
  const match = url.match(/\/pull\/(\d+)$/);
  const number = match ? Number(match[1]) : NaN;
  if (!Number.isSafeInteger(number) || number <= 0) {
    throwRemote("DELIVERY_REJECTED", "GitHub CLI returned an invalid pull request URL.");
  }
  return number;
}

function throwRemote(code: DeliveryRemoteActionErrorCode, message: string): never {
  throw new DeliveryRemoteActionError(code, message);
}

function assertDeliveryReconciliationStatus(status: DeliveryCommitInput["reconciliationStatus"], acceptMismatch: boolean): void {
  if (!status) return;
  if (status === "available") return;
  if (status === "mismatch" && acceptMismatch) return;
  throwDelivery("DELIVERY_REJECTED", `Delivery commit requires an available reconciliation; got ${status}.`);
}

function normalizeCommitSubject(value: string): string {
  const subject = typeof value === "string" ? value.trim() : "";
  if (!subject) throwDelivery("INVALID_INPUT", "Commit subject is required.");
  if (!/^[a-z][a-z0-9-]*(?:\([a-z0-9._/-]+\))?!?: .+$/.test(subject)) {
    throwDelivery("INVALID_INPUT", "Commit subject must use Conventional Commits format.");
  }
  return subject;
}

async function resolveDeliveryWorktreePath(projectRoot: string, worktreePath: string): Promise<string> {
  const repoRoot = await assertGitRepo(projectRoot);
  const candidate = await realpath(worktreePath);
  let topLevel: string;
  try {
    topLevel = await realpath((await runGit(candidate, ["rev-parse", "--show-toplevel"])).stdout);
    await findListedWorktree(repoRoot, topLevel);
  } catch {
    throwDelivery("UNSAFE_WORKTREE_PATH", "Delivery worktree path must stay inside the opened project or SkyTurn managed worktree boundary.");
  }
  if (topLevel === repoRoot) return topLevel;

  const managedRoot = await realpath(resolve(dirname(repoRoot), `${basename(repoRoot)}.worktrees`)).catch(() => null);
  if (managedRoot && isPathWithin(topLevel, managedRoot)) return topLevel;
  throwDelivery("UNSAFE_WORKTREE_PATH", "Delivery worktree path must stay inside the opened project or SkyTurn managed worktree boundary.");
}

async function normalizeDeliveryFileList(worktreePath: string, files: string[]): Promise<string[]> {
  if (!Array.isArray(files) || files.length === 0) {
    throwDelivery("INVALID_INPUT", "Delivery file list must be non-empty.");
  }
  const normalized = new Set<string>();
  for (const file of files) {
    if (typeof file !== "string") throwDelivery("INVALID_INPUT", "Delivery file paths must be strings.");
    const value = file.trim();
    if (!value) throwDelivery("INVALID_INPUT", "Delivery file paths must be non-empty.");
    if (isAbsolute(value)) throwDelivery("INVALID_INPUT", "Delivery file paths must be relative to the worktree.");
    if (/[\0\r\n]/.test(value) || value.startsWith(":") || /[*?\[]/.test(value)) {
      throwDelivery("INVALID_INPUT", `Delivery file path is ambiguous: ${value}.`);
    }
    const absolutePath = resolve(worktreePath, value);
    if (!isPathWithinOrSame(absolutePath, worktreePath)) {
      throwDelivery("UNSAFE_WORKTREE_PATH", `Delivery file path must stay inside the worktree: ${value}.`);
    }
    const realFilePath = await realpath(absolutePath).catch(() => null);
    if (realFilePath && !isPathWithinOrSame(realFilePath, worktreePath)) {
      throwDelivery("UNSAFE_WORKTREE_PATH", `Delivery file path must stay inside the worktree: ${value}.`);
    }
    const relativePath = relativePathFromWorktree(worktreePath, absolutePath);
    if (!relativePath) throwDelivery("INVALID_INPUT", "Delivery file path must point to a file inside the worktree.");
    if (normalized.has(relativePath)) throwDelivery("INVALID_INPUT", `Delivery file list has a duplicate or ambiguous entry: ${file}.`);
    normalized.add(relativePath);
  }
  return [...normalized].sort();
}

function relativePathFromWorktree(worktreePath: string, absolutePath: string): string {
  const relativePath = relative(worktreePath, absolutePath);
  return relativePath.split(sep).join("/");
}

function isPathWithinOrSame(candidate: string, parent: string): boolean {
  const resolvedCandidate = resolve(candidate);
  const resolvedParent = resolve(parent);
  return resolvedCandidate === resolvedParent || isPathWithin(resolvedCandidate, resolvedParent);
}

function isPathWithin(candidate: string, parent: string): boolean {
  const resolvedCandidate = resolve(candidate);
  const resolvedParent = resolve(parent);
  return resolvedCandidate.startsWith(`${resolvedParent}${sep}`);
}

function sameStringSet(left: string[], right: string[]): boolean {
  if (left.length !== right.length) return false;
  const rightSet = new Set(right);
  return left.every((value) => rightSet.has(value));
}

async function runDeliveryGitCommand(cwd: string, args: string[]): Promise<DeliveryCommandResult> {
  try {
    const result = await execFileAsync("git", args, {
      cwd,
      encoding: "utf8",
      maxBuffer: gitOutputLimit,
      shell: false,
    });
    return {
      command: "git",
      args,
      ok: true,
      exitCode: 0,
      stdout: String(result.stdout).trim(),
      stderr: String(result.stderr).trim(),
    };
  } catch (error) {
    const failure = error as { code?: number | string; stderr?: string; stdout?: string; message?: string };
    const stderr = String(failure.stderr || failure.message || "").trim();
    throwDelivery("DELIVERY_REJECTED", `git ${args[0]} failed: ${stderr}`);
  }
}

function throwDelivery(code: DeliveryCommitErrorCode, message: string): never {
  throw new DeliveryCommitError(code, message);
}

class GitChangesetService implements ChangesetService, ChangesetEvidenceService, ChangesetReconciliationService {
  constructor(private readonly options: GitChangesetServiceOptions) {}

  async getChangeset(node: CanvasNode): Promise<Changeset> {
    try {
      const repoRoot = await this.resolveRepoRoot(node);
      await assertGitWorktree(repoRoot);
      const status = await git(repoRoot, ["status", "--porcelain=v1", "--untracked-files=all", "--"]);
      if (status.truncated) throw new Error("Git status output exceeded the changeset evidence limit.");
      const statusLines = parseStatusLines(status.stdout);
      const files = filesFromStatus(statusLines);
      if (files.length === 0) return this.emptyChangeset(node);

      const untrackedFiles = untrackedFilesFromStatus(statusLines);
      const diffStat = await diffStatForRepo(repoRoot, files.length, untrackedFiles);
      const patch = await diffPreviewForRepo(
        repoRoot,
        this.options.maxPatchPreviewBytes ?? defaultMaxPatchPreviewBytes,
        untrackedFiles,
      );
      const evidence = this.evidenceFor(node, "available", files, diffStat, patch.truncated);
      return {
        id: node.changesetId,
        files,
        diffStat,
        patchPreview: patch.value,
        source: "git",
        evidence,
      };
    } catch (error: unknown) {
      return this.failedChangeset(node, boundedReason(error instanceof Error ? error.message : "Unable to collect git changeset."));
    }
  }

  async collectChangesetEvidence(input: ChangesetEvidenceInput): Promise<ChangesetEvidence> {
    if (input.worktree) {
      return this.collectCommittedWorktreeEvidence(input.node, input.worktree);
    }
    const changeset = await this.getChangeset(input.node);
    return changeset.evidence ?? this.evidenceFor(input.node, "unknown", [], changeset.diffStat, false);
  }

  async reconcileFinalChangeset(input: ChangesetReconciliationInput): Promise<FinalChangesetReconciliation> {
    const baselineRef = input.baselineRef ?? input.node.worktree.baselineRef ?? input.node.worktree.baseCommit ?? input.target.baseRef ?? input.target.selectedBranch;
    try {
      const repoRoot = await this.resolveRepoRoot(input.node);
      await assertGitWorktree(repoRoot);
      await verifyGitRef(repoRoot, baselineRef);
      const status = await git(repoRoot, ["status", "--porcelain=v1", "--untracked-files=all", "--"]);
      if (status.truncated) throw new Error("Git status output exceeded the changeset evidence limit.");
      const statusLines = parseStatusLines(status.stdout);
      const untrackedFiles = untrackedFilesFromStatus(statusLines);
      const files = unionSorted([
        ...stringLines((await git(repoRoot, ["diff", "--name-only", baselineRef, "--"])).stdout),
        ...filesFromStatus(statusLines),
      ]);
      const diffStat = files.length === 0
        ? { added: 0, changed: 0, deleted: 0 }
        : await diffStatForRepo(repoRoot, files.length, untrackedFiles, baselineRef);
      const patch = files.length === 0
        ? { value: "", truncated: false }
        : await diffPreviewForRepo(
            repoRoot,
            this.options.maxPatchPreviewBytes ?? defaultMaxPatchPreviewBytes,
            untrackedFiles,
            baselineRef,
          );
      const evidence = this.evidenceFor(input.node, files.length === 0 ? "empty" : "available", files, diffStat, patch.truncated);
      const changeset: Changeset = {
        id: input.node.changesetId,
        files,
        diffStat,
        patchPreview: patch.value,
        source: "git",
        evidence,
      };
      const mismatches = mismatchAgainstLiveChanges(input.liveChanges, files);
      return {
        status: mismatches.length > 0 ? "mismatch" : evidence.status === "empty" ? "empty" : "available",
        changeset,
        metadata: {
          source: "git",
          executionTarget: input.target.executionTarget,
          selectedBranch: input.target.selectedBranch,
          baselineRef,
          ...(input.target.baseRef ? { baseRef: input.target.baseRef } : {}),
          ...(input.node.worktree.worktreeId ? { worktreeId: input.node.worktree.worktreeId } : {}),
          ...(input.node.worktree.variantId ? { variantId: input.node.worktree.variantId } : {}),
        },
        ...(input.liveChanges ? { liveChanges: input.liveChanges } : {}),
        ...(mismatches.length > 0 ? { mismatches } : {}),
      };
    } catch (error) {
      const reason = boundedReason(error instanceof Error ? error.message : "Unable to reconcile git changeset.");
      const changeset = this.failedChangeset(input.node, reason);
      return {
        status: "failed",
        changeset,
        metadata: {
          source: "git",
          executionTarget: input.target.executionTarget,
          selectedBranch: input.target.selectedBranch,
          baselineRef,
          ...(input.target.baseRef ? { baseRef: input.target.baseRef } : {}),
          ...(input.node.worktree.worktreeId ? { worktreeId: input.node.worktree.worktreeId } : {}),
          ...(input.node.worktree.variantId ? { variantId: input.node.worktree.variantId } : {}),
        },
        ...(input.liveChanges ? { liveChanges: input.liveChanges } : {}),
        errorReason: reason,
      };
    }
  }

  private async collectCommittedWorktreeEvidence(
    node: CanvasNode,
    worktree: WorkflowWorktreeIdentity,
  ): Promise<ChangesetEvidence> {
    const worktreeNode = nodeWithWorktree(node, worktree);
    try {
      const diffRange = `${worktree.baseCommit}..${worktree.headCommit}`;
      const repoRoot = await realpath(worktree.realPath);
      await assertGitWorktree(repoRoot);
      const files = stringLines((await git(repoRoot, ["diff", "--name-only", diffRange, "--"])).stdout);
      const numstat = (await git(repoRoot, ["diff", "--numstat", diffRange, "--"])).stdout;
      const patch = await git(
        repoRoot,
        ["diff", "--no-ext-diff", diffRange, "--"],
        { maxBytes: this.options.maxPatchPreviewBytes ?? defaultMaxPatchPreviewBytes },
      );
      return {
        ...this.evidenceFor(
          worktreeNode,
          files.length === 0 ? "empty" : "available",
          files,
          parseNumstat(numstat),
          patch.truncated,
        ),
        worktreeId: worktree.worktreeId,
      };
    } catch (error) {
      return {
        ...this.evidenceFor(worktreeNode, "failed", [], { added: 0, changed: 0, deleted: 0 }, false),
        worktreeId: worktree.worktreeId,
        errorReason: errorMessage(error),
      };
    }
  }

  private async resolveRepoRoot(node: CanvasNode): Promise<string> {
    const candidate = isAbsolute(node.worktree.path)
      ? node.worktree.path
      : this.options.repoRoot ?? resolve(process.cwd(), node.worktree.path);
    return realpath(candidate);
  }

  private emptyChangeset(node: CanvasNode): Changeset {
    return {
      id: node.changesetId,
      files: [],
      diffStat: { added: 0, changed: 0, deleted: 0 },
      patchPreview: "",
      source: "git",
      evidence: this.evidenceFor(node, "empty", [], { added: 0, changed: 0, deleted: 0 }, false),
    };
  }

  private failedChangeset(node: CanvasNode, reason: string): Changeset {
    return {
      id: node.changesetId,
      files: [],
      diffStat: { added: 0, changed: 0, deleted: 0 },
      patchPreview: "",
      source: "git",
      evidence: {
        ...this.evidenceFor(node, "failed", [], { added: 0, changed: 0, deleted: 0 }, false),
        errorReason: reason,
      },
    };
  }

  private evidenceFor(
    node: CanvasNode,
    status: ChangesetEvidence["status"],
    files: string[],
    diffStat: Changeset["diffStat"],
    patchPreviewTruncated: boolean,
  ): ChangesetEvidence {
    return {
      evidenceId: `changeset-evidence-${node.changesetId}`,
      changesetId: node.changesetId,
      source: "git",
      status,
      files,
      diffStat,
      patchPreviewTruncated,
      collectedAt: new Date().toISOString(),
    };
  }
}

class GitVariantComparisonService implements Pick<ManagedWorktreeService, "compareVariants"> {
  constructor(private readonly options: GitChangesetServiceOptions) {}

  async compareVariants(input: VariantComparisonInput): Promise<VariantComparisonEvidence> {
    const service = createGitChangesetService(this.options);
    const left = await collectVariantChangeset(service, input.left);
    const right = await collectVariantChangeset(service, input.right);
    const leftRecorded = { ...input.recordedEvidence?.[input.left.variantId], changeset: left };
    const rightRecorded = { ...input.recordedEvidence?.[input.right.variantId], changeset: right };

    return {
      comparisonId: `comparison-${input.left.variantId}-${input.right.variantId}`,
      variants: [
        {
          variantId: input.left.variantId,
          worktreeId: input.left.worktreeId,
          changeset: left,
          metrics: buildAdjudicationMetrics(leftRecorded),
        },
        {
          variantId: input.right.variantId,
          worktreeId: input.right.worktreeId,
          changeset: right,
          metrics: buildAdjudicationMetrics(rightRecorded),
        },
      ],
      collectedAt: new Date().toISOString(),
    };
  }
}

async function collectVariantChangeset(
  service: ChangesetEvidenceService,
  worktree: WorkflowWorktreeIdentity,
): Promise<ChangesetEvidence> {
  return service.collectChangesetEvidence({
    node: minimalNode(worktree),
    worktree,
  });
}

function nodeWithWorktree(node: CanvasNode, worktree: WorkflowWorktreeIdentity): CanvasNode {
  return {
    ...node,
    worktree: {
      ...node.worktree,
      path: worktree.realPath,
      branchName: worktree.branchName,
      baseCommit: worktree.baseCommit,
      worktreeId: worktree.worktreeId,
      variantId: worktree.variantId,
      realPath: worktree.realPath,
      gitdir: worktree.gitdir,
      repoRoot: worktree.repoRoot,
      headCommit: worktree.headCommit,
    },
  };
}

export function worktreeMetadataForVariant(worktree: WorkflowWorktreeIdentity): WorktreeMetadata {
  return {
    path: worktree.realPath,
    branchName: worktree.branchName,
    baseCommit: worktree.baseCommit,
    worktreeId: worktree.worktreeId,
    variantId: worktree.variantId,
    realPath: worktree.realPath,
    gitdir: worktree.gitdir,
    repoRoot: worktree.repoRoot,
    headCommit: worktree.headCommit,
  };
}

async function assertGitRepo(repoRoot: string): Promise<string> {
  const realRepoRoot = await realpath(repoRoot);
  const topLevel = (await runGit(realRepoRoot, ["rev-parse", "--show-toplevel"])).stdout;
  const realTopLevel = await realpath(topLevel);
  if (realRepoRoot !== realTopLevel) {
    throw new Error(`Repo root mismatch: expected ${realRepoRoot}, git reports ${realTopLevel}.`);
  }
  return realRepoRoot;
}

async function ensureManagedRoot(repoRoot: string): Promise<string> {
  const managedRoot = resolve(dirname(repoRoot), `${basename(repoRoot)}.worktrees`);
  await mkdir(managedRoot, { recursive: true });
  return realpath(managedRoot);
}

async function verifyCommit(repoRoot: string, commit: string, label: string): Promise<string> {
  validateCommitHash(commit, label);
  return (await runGit(repoRoot, ["rev-parse", "--verify", `${commit}^{commit}`])).stdout;
}

async function verifyGitRef(repoRoot: string, ref: string): Promise<string> {
  validateGitRef(ref);
  try {
    return (await git(repoRoot, ["rev-parse", "--verify", `${ref}^{commit}`])).stdout.trim();
  } catch (error) {
    throw new Error(`Baseline ref does not resolve: ${ref}: ${errorMessage(error)}`);
  }
}

async function validateSkyTurnBranch(repoRoot: string, branchName: string): Promise<void> {
  validateBranchName(branchName, { requireSkyTurnPrefix: true });
  await runGit(repoRoot, ["check-ref-format", "--branch", branchName]);
}

async function validateTargetBranch(repoRoot: string, branchName: string): Promise<void> {
  validateBranchName(branchName, { requireSkyTurnPrefix: false });
  await runGit(repoRoot, ["rev-parse", "--verify", `refs/heads/${branchName}^{commit}`]);
}

async function assertBranchDeleteSafe(repoRoot: string, branchName: string): Promise<void> {
  await validateSkyTurnBranch(repoRoot, branchName);
  const branchRef = `refs/heads/${branchName}`;
  await runGit(repoRoot, ["rev-parse", "--verify", `${branchRef}^{commit}`]);
  const merged = await runGit(repoRoot, ["merge-base", "--is-ancestor", branchRef, "HEAD"], { allowFailure: true });
  if (merged.exitCode !== 0) {
    throw new Error(`Cannot delete branch ${branchName}: branch is not fully merged into HEAD.`);
  }
}

function validateBranchName(branchName: string, input: { requireSkyTurnPrefix: boolean }): void {
  if (!branchName || branchName.startsWith("-") || branchName.includes("\\") || /[\s\0-\x1f]/.test(branchName)) {
    throw new Error(`Unsafe branch name: ${branchName}.`);
  }
  if (branchName.includes("..") || branchName.includes("@{") || branchName.endsWith(".lock")) {
    throw new Error(`Unsafe branch name: ${branchName}.`);
  }
  if (input.requireSkyTurnPrefix && !branchName.startsWith("skyturn/")) {
    throw new Error(`Managed branch must use the skyturn/ prefix: ${branchName}.`);
  }
}

function validateCommitHash(commit: string, label: string): void {
  if (!/^[0-9a-fA-F]{7,64}$/.test(commit)) {
    throw new Error(`Invalid ${label}: ${commit}.`);
  }
}

function validateGitRef(ref: string): void {
  if (!ref || ref.startsWith("-") || /[\s\0-\x1f]/.test(ref)) {
    throw new Error(`Invalid baseline ref: ${ref}.`);
  }
}

async function findListedWorktree(repoRoot: string, realPath: string): Promise<GitWorktreeListEntry> {
  const entries = parseWorktreeList((await runGit(repoRoot, ["worktree", "list", "--porcelain"])).stdout);
  for (const entry of entries) {
    const entryPath = await realpath(entry.worktree);
    if (entryPath === realPath) return entry;
  }
  throw new Error(`Worktree is not listed by git: ${realPath}.`);
}

function parseWorktreeList(output: string): GitWorktreeListEntry[] {
  const entries: GitWorktreeListEntry[] = [];
  let current: GitWorktreeListEntry | null = null;
  for (const line of output.split(/\r?\n/)) {
    if (!line.trim()) {
      if (current) entries.push(current);
      current = null;
      continue;
    }
    const [key, ...rest] = line.split(" ");
    const value = rest.join(" ");
    if (key === "worktree") current = { worktree: value, head: null, branch: null };
    if (!current) continue;
    if (key === "HEAD") current.head = value;
    if (key === "branch") current.branch = value;
  }
  if (current) entries.push(current);
  return entries;
}

async function readGitDirFile(worktreePath: string): Promise<string> {
  const content = await readFile(join(worktreePath, ".git"), "utf8");
  const prefix = "gitdir:";
  if (!content.startsWith(prefix)) throw new Error(`Worktree .git file does not contain a gitdir pointer: ${worktreePath}.`);
  const gitdir = content.slice(prefix.length).trim();
  const resolved = gitdir.startsWith(sep) ? gitdir : resolve(worktreePath, gitdir);
  return realpath(resolved);
}

async function currentBranch(cwd: string): Promise<string> {
  return (await runGit(cwd, ["symbolic-ref", "--short", "HEAD"])).stdout;
}

async function currentHead(cwd: string): Promise<string> {
  return (await runGit(cwd, ["rev-parse", "HEAD"])).stdout;
}

async function ensureAncestor(repoRoot: string, baseCommit: string, headCommit: string): Promise<void> {
  const result = await runGit(repoRoot, ["merge-base", "--is-ancestor", baseCommit, headCommit], { allowFailure: true });
  if (result.exitCode !== 0) {
    throw new Error(`Base commit is not an ancestor of worktree HEAD: ${result.stderr || result.stdout}`.trim());
  }
}

async function assertCleanWorktree(cwd: string, label: string): Promise<void> {
  const status = (await runGit(cwd, ["status", "--porcelain=v1", "--untracked-files=all", "--"])).stdout;
  if (status.trim()) throw new Error(`${label} has uncommitted changes.`);
}

async function checkoutTargetBranch(repoRoot: string, branchName: string): Promise<void> {
  const current = await currentBranch(repoRoot);
  if (current === branchName) return;
  await runGit(repoRoot, ["switch", "--", branchName]);
}

async function previewAdoption(repoRoot: string, adoption: WorkflowVariantAdoption): Promise<void> {
  const previewHead = await currentHead(repoRoot);
  await assertCleanWorktree(repoRoot, "target worktree");
  let previewFailed = false;
  try {
    if (adoption.strategy === "merge") {
      await runGit(repoRoot, ["merge", "--no-commit", "--no-ff", adoption.headCommit]);
      return;
    }
    await runGit(repoRoot, ["cherry-pick", "--no-commit", adoption.headCommit]);
  } catch (error) {
    previewFailed = true;
    throw error;
  } finally {
    try {
      await restoreAdoptionPreview(repoRoot, previewHead);
    } catch (error) {
      if (!previewFailed) throw error;
    }
  }
}

async function applyAdoption(repoRoot: string, adoption: WorkflowVariantAdoption): Promise<void> {
  if (adoption.strategy === "merge") {
    await runGit(repoRoot, ["merge", "--ff-only", adoption.headCommit]);
    return;
  }
  await runGit(repoRoot, ["cherry-pick", adoption.headCommit]);
}

async function assertTargetHeadMatchesBase(repoRoot: string, adoption: WorkflowVariantAdoption): Promise<void> {
  const targetHead = await currentHead(repoRoot);
  if (targetHead !== adoption.baseCommit) {
    throw new AdoptionTargetBaseMismatchError(adoption.targetBranchName, adoption.baseCommit, targetHead);
  }
}

async function restoreAdoptionPreview(repoRoot: string, headCommit: string): Promise<void> {
  await abortAdoption(repoRoot);
  await runGit(repoRoot, ["reset", "--hard", headCommit]);
}

async function abortAdoption(repoRoot: string): Promise<void> {
  await runGit(repoRoot, ["merge", "--abort"], { allowFailure: true });
  await runGit(repoRoot, ["cherry-pick", "--abort"], { allowFailure: true });
}

function verifyAdoptionRecord(input: WorkflowVariantAdoption, eventWorktree: WorkflowWorktreeIdentity): void {
  if (input.variantId !== eventWorktree.variantId) {
    throw new Error(`Adoption variant mismatch for ${input.worktreeId}.`);
  }
  if (input.baseCommit !== eventWorktree.baseCommit) {
    throw new Error(`Adoption base commit mismatch for ${input.worktreeId}.`);
  }
}

function verifyCleanupRecord(input: WorkflowWorktreeIdentity, eventWorktree: WorkflowWorktreeIdentity): void {
  if (input.variantId !== eventWorktree.variantId) {
    throw new Error(`Cleanup variant mismatch for ${input.worktreeId}.`);
  }
  assertSamePath(input.realPath, eventWorktree.realPath, "cleanup realPath");
  assertSamePath(input.gitdir, eventWorktree.gitdir, "cleanup gitdir");
  assertSamePath(input.repoRoot, eventWorktree.repoRoot, "cleanup repoRoot");
  if (input.branchName !== eventWorktree.branchName) {
    throw new Error(`Cleanup branch mismatch for ${input.worktreeId}.`);
  }
  if (input.baseCommit !== eventWorktree.baseCommit) {
    throw new Error(`Cleanup base commit mismatch for ${input.worktreeId}.`);
  }
  validateCommitHash(input.headCommit, "cleanup head commit");
}

async function runGit(cwd: string, args: string[], options: GitRunOptions = {}): Promise<GitResult> {
  try {
    const result = await execFileAsync("git", args, {
      cwd,
      encoding: "utf8",
      maxBuffer: options.maxBuffer ?? gitOutputLimit,
      shell: false,
    });
    return {
      stdout: String(result.stdout).trim(),
      stderr: String(result.stderr).trim(),
      exitCode: 0,
    };
  } catch (error) {
    const failure = error as { code?: number | string; stderr?: string; stdout?: string; message?: string };
    if (options.allowFailure) {
      return {
        stdout: String(failure.stdout ?? "").trim(),
        stderr: String(failure.stderr ?? "").trim(),
        exitCode: typeof failure.code === "number" ? failure.code : 1,
      };
    }
    throw new GitCommandError(`git ${args.join(" ")} failed in ${cwd}.`, String(failure.stderr || failure.message || "").trim());
  }
}

function eventPlan(plan: ManagedWorktreeEventFacts): Record<string, unknown> {
  return {
    sessionId: plan.sessionId,
    worktreeId: plan.worktreeId,
    variantId: plan.variantId,
    path: plan.path,
    repoRoot: plan.repoRoot,
    branchName: plan.branchName,
    baseCommit: plan.baseCommit,
    parentLaneId: plan.parentLaneId,
    ...(plan.parentSegmentId ? { parentSegmentId: plan.parentSegmentId } : {}),
  };
}

function createFailureFactsFromInput(input: ManagedWorktreeCreateInput): ManagedWorktreeEventFacts {
  const sessionId = safeEventId(input.sessionId);
  const variantId = safeEventId(input.variantId);
  const repoRoot = resolve(input.repoRoot);
  const managedRoot = resolve(dirname(repoRoot), `${basename(repoRoot)}.worktrees`);
  return {
    sessionId: input.sessionId,
    worktreeId: `worktree-${sessionId}-${variantId}`,
    variantId: input.variantId,
    repoRoot,
    path: resolve(managedRoot, `session-${sessionId}-variant-${variantId}`),
    baseCommit: input.baseCommit,
    branchName: input.branchName,
    parentLaneId: input.parentLaneId,
    ...(input.parentSegmentId ? { parentSegmentId: input.parentSegmentId } : {}),
  };
}

function verifyCreateRequestMatchesCreatedEvent(plan: ManagedWorktreePlan, created: CreatedWorktreeEvent): void {
  const mismatches: string[] = [];
  const worktree = created.worktree;
  const eventSessionId = created.event.sessionId ?? stringField(created.event.payload, "sessionId");

  if (eventSessionId && eventSessionId !== plan.sessionId) {
    mismatches.push(`sessionId expected ${plan.sessionId}, got ${eventSessionId}`);
  }
  if (worktree.variantId !== plan.variantId) {
    mismatches.push(`variantId expected ${plan.variantId}, got ${worktree.variantId}`);
  }
  if (!samePath(worktree.repoRoot, plan.repoRoot)) {
    mismatches.push(`repoRoot expected ${plan.repoRoot}, got ${worktree.repoRoot}`);
  }
  if (worktree.baseCommit !== plan.baseCommit) {
    mismatches.push(`baseCommit expected ${plan.baseCommit}, got ${worktree.baseCommit}`);
  }
  if (worktree.branchName !== plan.branchName) {
    mismatches.push(`branchName expected ${plan.branchName}, got ${worktree.branchName}`);
  }
  if (worktree.parentLaneId !== plan.parentLaneId) {
    mismatches.push(`parentLaneId expected ${plan.parentLaneId}, got ${worktree.parentLaneId}`);
  }
  if ((worktree.parentSegmentId ?? null) !== (plan.parentSegmentId ?? null)) {
    mismatches.push(`parentSegmentId expected ${plan.parentSegmentId ?? "none"}, got ${worktree.parentSegmentId ?? "none"}`);
  }

  if (mismatches.length > 0) {
    throw new Error(`Managed worktree create conflict for ${plan.worktreeId}: ${mismatches.join("; ")}.`);
  }
}

function safeId(value: string, field: string): string {
  if (!/^[A-Za-z0-9._-]+$/.test(value)) {
    throw new Error(`${field} must contain only letters, numbers, dot, underscore, or dash.`);
  }
  return value;
}

function safeEventId(value: string): string {
  const normalized = value.replace(/[^A-Za-z0-9._-]+/g, "-").replace(/^-+|-+$/g, "");
  return normalized || "invalid";
}

function assertPathInside(path: string, root: string, label: string): void {
  if (path !== root && !path.startsWith(`${root}${sep}`)) {
    throw new Error(`${label} escapes the SkyTurn managed worktree root.`);
  }
}

function assertSamePath(left: string, right: string, label: string): void {
  if (!samePath(left, right)) throw new Error(`${label} mismatch: expected ${right}, got ${left}.`);
}

function samePath(left: string, right: string): boolean {
  return resolve(left) === resolve(right);
}

function isWorktreeIdentity(value: unknown): value is WorkflowWorktreeIdentity {
  if (!value || typeof value !== "object") return false;
  const item = value as Partial<WorkflowWorktreeIdentity>;
  return (
    typeof item.worktreeId === "string" &&
    typeof item.variantId === "string" &&
    typeof item.realPath === "string" &&
    typeof item.gitdir === "string" &&
    typeof item.repoRoot === "string" &&
    typeof item.branchName === "string" &&
    typeof item.baseCommit === "string" &&
    typeof item.headCommit === "string"
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object";
}

function worktreeIdFromEvent(event: ManagedWorktreeWorkflowEvent): string | null {
  if (event.kind === "workflow.worktree.created") {
    const worktree = event.payload.worktree;
    return isWorktreeIdentity(worktree) ? worktree.worktreeId : null;
  }
  return typeof event.payload.worktreeId === "string" ? event.payload.worktreeId : null;
}

function createInputFromRequestedEvent(event: ManagedWorktreeWorkflowEvent): ManagedWorktreeCreateInput | null {
  const payload = event.payload;
  if (!isRecord(payload)) return null;
  const sessionId = stringField(payload, "sessionId");
  const variantId = stringField(payload, "variantId");
  const repoRoot = stringField(payload, "repoRoot");
  const baseCommit = stringField(payload, "baseCommit");
  const branchName = stringField(payload, "branchName");
  const parentLaneId = stringField(payload, "parentLaneId");
  if (!sessionId || !variantId || !repoRoot || !baseCommit || !branchName || !parentLaneId) return null;
  const parentSegmentId = stringField(payload, "parentSegmentId");
  return {
    sessionId,
    variantId,
    repoRoot,
    baseCommit,
    branchName,
    parentLaneId,
    ...(parentSegmentId ? { parentSegmentId } : {}),
  };
}

function stringField(record: Record<string, unknown>, field: string): string | null {
  const value = record[field];
  return typeof value === "string" ? value : null;
}

function minimalNode(worktree: WorkflowWorktreeIdentity): CanvasNode {
  return {
    id: worktree.worktreeId,
    changesetId: `changeset-${worktree.worktreeId}`,
    worktree: worktreeMetadataForVariant(worktree),
  } as CanvasNode;
}

function parseNumstat(output: string): ChangesetEvidence["diffStat"] {
  let added = 0;
  let deleted = 0;
  let changed = 0;
  for (const line of stringLines(output)) {
    const [rawAdded, rawDeleted] = line.split("\t");
    added += parseStatValue(rawAdded);
    deleted += parseStatValue(rawDeleted);
    changed += 1;
  }
  return { added, changed, deleted };
}

function parseStatValue(value: string | undefined): number {
  if (!value || value === "-") return 0;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : 0;
}

function stringLines(output: string): string[] {
  return output.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
}

function unionSorted(values: string[]): string[] {
  return [...new Set(values.filter(Boolean))].sort();
}

function mismatchAgainstLiveChanges(
  liveChanges: ChangesetReconciliationInput["liveChanges"],
  gitFiles: string[],
): NonNullable<FinalChangesetReconciliation["mismatches"]> {
  if (!liveChanges || liveChanges.status !== "available") return [];
  const liveFiles = unionSorted(liveChanges.files);
  const normalizedGitFiles = unionSorted(gitFiles);
  if (liveFiles.length === normalizedGitFiles.length && liveFiles.every((file, index) => file === normalizedGitFiles[index])) {
    return [];
  }
  return [{ kind: "file-set", liveFiles, gitFiles: normalizedGitFiles }];
}

function errorMessage(error: unknown): string {
  if (error instanceof GitCommandError && error.stderr) return truncate(error.stderr);
  if (error instanceof Error) return truncate(error.message);
  return truncate(String(error));
}

function truncate(value: string): string {
  return value.length > 1200 ? `${value.slice(0, 1200)}...` : value;
}

async function assertGitWorktree(repoRoot: string): Promise<void> {
  const result = await git(repoRoot, ["rev-parse", "--is-inside-work-tree"]);
  if (result.stdout.trim() !== "true") throw new Error("Path is not inside a git worktree.");
}

async function diffStatForRepo(
  repoRoot: string,
  changedFileCount: number,
  untrackedFiles: string[],
  baselineRef = "HEAD",
): Promise<Changeset["diffStat"]> {
  const output = await diffTextAgainstRef(repoRoot, baselineRef, ["--numstat"]);
  let added = 0;
  let deleted = 0;
  for (const line of `${output}${await untrackedNumstat(repoRoot, untrackedFiles)}`.split(/\r?\n/)) {
    if (!line.trim()) continue;
    const [rawAdded, rawDeleted] = line.split(/\s+/, 3);
    added += parseStatValue(rawAdded);
    deleted += parseStatValue(rawDeleted);
  }
  return { added, changed: changedFileCount, deleted };
}

async function diffPreviewForRepo(
  repoRoot: string,
  maxPatchPreviewBytes: number,
  untrackedFiles: string[],
  baselineRef = "HEAD",
): Promise<{ value: string; truncated: boolean }> {
  const result = await diffTextAgainstRefBounded(repoRoot, baselineRef, ["--no-ext-diff"], maxPatchPreviewBytes);
  if (result.truncated) return { value: `${result.stdout.trimEnd()}\n[diff truncated]\n`, truncated: true };

  let value = result.stdout;
  for (const file of untrackedFiles) {
    const remaining = maxPatchPreviewBytes - Buffer.byteLength(value);
    if (remaining <= 0) return { value: `${value.trimEnd()}\n[diff truncated]\n`, truncated: true };
    const untracked = await untrackedFileDiff(repoRoot, file, ["--no-ext-diff"], remaining);
    value += untracked.stdout;
    if (untracked.truncated) return { value: `${value.trimEnd()}\n[diff truncated]\n`, truncated: true };
  }
  return { value, truncated: false };
}

async function diffTextAgainstRef(repoRoot: string, baselineRef: string, diffArgs: string[]): Promise<string> {
  validateGitRef(baselineRef);
  const args = ["diff", ...diffArgs, baselineRef, "--"];
  try {
    const result = await git(repoRoot, args);
    return result.stdout;
  } catch {
    const unstaged = await git(repoRoot, ["diff", ...diffArgs, "--"]);
    const staged = await git(repoRoot, ["diff", "--cached", ...diffArgs, "--"]);
    return `${staged.stdout}${unstaged.stdout}`;
  }
}

async function diffTextAgainstRefBounded(
  repoRoot: string,
  baselineRef: string,
  diffArgs: string[],
  maxBytes: number,
): Promise<{ stdout: string; truncated: boolean }> {
  validateGitRef(baselineRef);
  const args = ["diff", ...diffArgs, baselineRef, "--"];
  try {
    return await git(repoRoot, args, { maxBytes });
  } catch {
    return git(repoRoot, ["diff", ...diffArgs, "--"], { maxBytes });
  }
}

function parseStatusLines(output: string): string[] {
  return output.split(/\r?\n/).filter((line) => line.trim().length > 0);
}

function filesFromStatus(lines: string[]): string[] {
  const files = new Set<string>();
  for (const line of lines) {
    const value = line.slice(3).trim();
    const renamed = value.includes(" -> ") ? value.split(" -> ").at(-1) : value;
    if (renamed) files.add(renamed);
  }
  return [...files].sort();
}

function untrackedFilesFromStatus(lines: string[]): string[] {
  return lines
    .filter((line) => line.startsWith("?? "))
    .map((line) => line.slice(3).trim())
    .filter(Boolean)
    .sort();
}

async function untrackedNumstat(repoRoot: string, files: string[]): Promise<string> {
  const chunks: string[] = [];
  for (const file of files) {
    const result = await untrackedFileDiff(repoRoot, file, ["--numstat"]);
    chunks.push(result.stdout);
  }
  return chunks.join("");
}

async function untrackedFileDiff(
  repoRoot: string,
  file: string,
  diffArgs: string[],
  maxBytes?: number,
): Promise<{ stdout: string; truncated: boolean }> {
  return git(repoRoot, ["diff", "--no-index", ...diffArgs, "--", "/dev/null", file], {
    allowExitCodes: [0, 1],
    ...(maxBytes ? { maxBytes } : {}),
  });
}

function boundedReason(reason: string): string {
  const maxLength = 1000;
  if (reason.length <= maxLength) return reason;
  return `${reason.slice(0, maxLength).trimEnd()}...`;
}

async function git(
  cwd: string,
  args: string[],
  options: { maxBytes?: number; allowExitCodes?: number[] } = {},
): Promise<{ stdout: string; truncated: boolean }> {
  const maxBytes = options.maxBytes ?? defaultMaxGitOutputBytes;
  const allowExitCodes = new Set([0, ...(options.allowExitCodes ?? [])]);
  return new Promise((resolve, reject) => {
    const child = spawn("git", args, { cwd, stdio: ["ignore", "pipe", "pipe"] });
    const stdoutChunks: Buffer[] = [];
    const stderrChunks: Buffer[] = [];
    let stdoutBytes = 0;
    let stderrBytes = 0;
    let truncated = false;

    child.stdout.on("data", (chunk: Buffer) => {
      if (stdoutBytes >= maxBytes) return;
      const remaining = maxBytes - stdoutBytes;
      const value = chunk.byteLength > remaining ? chunk.subarray(0, remaining) : chunk;
      stdoutChunks.push(value);
      stdoutBytes += value.byteLength;
      if (chunk.byteLength >= remaining) {
        truncated = true;
        child.kill("SIGTERM");
      }
    });

    child.stderr.on("data", (chunk: Buffer) => {
      if (stderrBytes >= defaultMaxGitOutputBytes) return;
      const remaining = defaultMaxGitOutputBytes - stderrBytes;
      const value = chunk.byteLength > remaining ? chunk.subarray(0, remaining) : chunk;
      stderrChunks.push(value);
      stderrBytes += value.byteLength;
    });

    child.on("error", reject);
    child.on("close", (code) => {
      const stdout = Buffer.concat(stdoutChunks).toString("utf8");
      const stderr = Buffer.concat(stderrChunks).toString("utf8");
      if (!allowExitCodes.has(code ?? -1) && !truncated) {
        reject(new Error(stderr.trim() || `git ${args[0]} failed with exit code ${code ?? "unknown"}.`));
        return;
      }
      resolve({ stdout, truncated });
  });
  });
}
