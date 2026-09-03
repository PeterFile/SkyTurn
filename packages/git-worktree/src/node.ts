import { execFile, spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { chmod, mkdir, mkdtemp, readFile, realpath, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { createInterface } from "node:readline";
import { promisify } from "node:util";

import type {
  CanvasNode,
  Changeset,
  ChangesetEvidence,
  FinalChangesetReconciliation,
  WorkflowGitAncestryProof,
  WorkflowGitAncestryProofContext,
  WorkflowVariantAdoption,
  WorkflowWorktreeIdentity,
  WorktreeMetadata,
} from "@skyturn/project-core";
import {
  createWorkflowGitAncestryProofContext,
  parseWorkflowGitAncestryProof,
  parseWorkflowVariantComparisonRecordedEvidence,
} from "@skyturn/project-core";

import {
  buildAdjudicationMetrics,
  parseCandidateDeliveryCommitPreparation,
  parseVariantComparisonEvidence,
  parseWorktreeAdoptionRequest,
  parseWorktreeComparisonRequest,
  type ChangesetEvidenceInput,
  type ChangesetEvidenceService,
  type ChangesetReconciliationInput,
  type ChangesetReconciliationService,
  type ChangesetService,
  type CandidateCommitExpectation,
  type CandidateDeliveryCommitEvidence,
  type CandidateDeliveryCommitInput,
  type CandidateDeliveryCommitPreparation,
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
  type PublishPreparedCandidateDeliveryCommitInput,
  type RollbackWorktreeInput,
  type RollbackWorktreeManualRepairState,
  type RollbackWorktreeManualRepairReasonCode,
  type RollbackWorktreeResetResult,
  type RollbackWorktreeState,
  type VariantComparisonEvidence,
  type VariantComparisonInput,
  type VariantAdoptionOptions,
  type VariantAdoptionService,
} from "./index.js";
import {
  collectAtomicGitChangesetSnapshot,
  DEFAULT_MAX_FULL_PATCH_BYTES,
  SKYTURN_GIT_EVIDENCE_PATHSPECS as skyturnGitEvidencePathspecs,
  SKYTURN_VOLATILE_GIT_PATHS,
  type AtomicGitChangesetSnapshot,
  type GitChangesetBaseline,
} from "./internal/gitChangesetSnapshot.js";
import {
  publishPreparedCandidateRef,
  sanitizedGitEnvironment,
  spawnBoundedGit,
} from "./internal/gitCommand.js";

export {
  parseCandidateDeliveryCommitPreparation,
  parseVariantComparisonEvidence,
  parseWorkflowVariantComparisonRecordedEvidence,
  parseWorktreeAdoptionRequest,
  parseWorktreeComparisonRequest,
};
export { SKYTURN_VOLATILE_GIT_PATHS };

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
  unknownFailureExitCode?: number;
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
const candidateCommitMessageMaxBytes = 1024 * 1024;
const candidateGitMetadataMaxBytes = DEFAULT_MAX_FULL_PATCH_BYTES;
const candidateGitStderrMaxBytes = 64 * 1024;
const candidateExpectationKeys = [
  "afterHeadCommit",
  "ancestryProofSha256",
  "beforeHeadCommit",
  "branchName",
  "fileManifestSha256",
  "fullPatchByteLength",
  "fullPatchSha256",
  "repositoryIdentity",
  "worktreeIdentity",
] as const;
const candidateRejectedMessage = "Candidate delivery commit was rejected.";
const candidateInvalidMessage = "Candidate delivery commit input is invalid.";

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

export interface WorkflowGitAncestryProofInput {
  repositoryPath: string;
  worktreePath: string;
  beforeHeadCommit: string;
  afterHeadCommit: string;
}

export interface CandidateDeliveryReviewSnapshotInput {
  readonly projectRoot: string;
  readonly worktreePath: string;
  readonly expected: CandidateCommitExpectation;
}

export interface CandidateDeliveryReviewSnapshot {
  readonly baselineCommit: string;
  readonly headCommit: string;
  readonly fullPatchBase64: string;
  readonly fullPatchSha256: string;
  readonly fullPatchByteLength: number;
  readonly fileManifestSha256: string;
}

export type WorkflowGitAncestryProofErrorCode =
  | "INVALID_INPUT"
  | "NOT_ANCESTOR"
  | "GIT_EXECUTION_FAILED";

const workflowGitAncestryProofErrorMessages: Record<WorkflowGitAncestryProofErrorCode, string> = {
  INVALID_INPUT: "Workflow Git ancestry proof input is invalid.",
  NOT_ANCESTOR: "The before commit is not an ancestor of the after commit.",
  GIT_EXECUTION_FAILED: "Workflow Git ancestry proof Git verification failed.",
};

export class WorkflowGitAncestryProofError extends Error {
  readonly code: WorkflowGitAncestryProofErrorCode;

  constructor(code: WorkflowGitAncestryProofErrorCode) {
    super(workflowGitAncestryProofErrorMessages[code]);
    this.name = "WorkflowGitAncestryProofError";
    this.code = code;
  }
}

type ValidatedWorkflowGitAncestryProofInput = Readonly<WorkflowGitAncestryProofInput>;

interface GitFilesystemObjectFacts {
  canonicalPath: string;
  device: string;
  inode: string;
  birthtimeNs: string | null;
}

interface LiveWorkflowGitAncestryFacts {
  context: WorkflowGitAncestryProofContext;
  snapshot: string;
  worktreePath: string;
}

export async function createLiveWorkflowGitAncestryProofContext(
  input: WorkflowGitAncestryProofInput,
): Promise<WorkflowGitAncestryProofContext> {
  const validatedInput = validateWorkflowGitAncestryProofInput(input);
  return (await resolveLiveWorkflowGitAncestryFacts(validatedInput)).context;
}

export async function createWorkflowGitAncestryProof(
  input: WorkflowGitAncestryProofInput,
): Promise<string> {
  const validatedInput = validateWorkflowGitAncestryProofInput(input);
  const before = await resolveLiveWorkflowGitAncestryFacts(validatedInput);
  const ancestry = await executeWorkflowGitAncestryCheck(before, validatedInput);
  const after = await resolveLiveWorkflowGitAncestryFacts(validatedInput);
  assertWorkflowGitAncestryFactsUnchanged(before, after);
  assertWorkflowGitAncestryResult(ancestry);
  return JSON.stringify({
    protocolVersion: 1,
    method: "git-merge-base-is-ancestor",
    ...after.context,
  });
}

export async function verifyWorkflowGitAncestryProof(
  serializedProof: unknown,
  input: WorkflowGitAncestryProofInput,
): Promise<WorkflowGitAncestryProof> {
  const validatedInput = validateWorkflowGitAncestryProofInput(input);
  const before = await resolveLiveWorkflowGitAncestryFacts(validatedInput);
  parseSerializedWorkflowGitAncestryProof(serializedProof, before.context, "INVALID_INPUT");
  const ancestry = await executeWorkflowGitAncestryCheck(before, validatedInput);
  const after = await resolveLiveWorkflowGitAncestryFacts(validatedInput);
  assertWorkflowGitAncestryFactsUnchanged(before, after);
  const confirmedProof = parseSerializedWorkflowGitAncestryProof(
    serializedProof,
    after.context,
    "GIT_EXECUTION_FAILED",
  );
  assertWorkflowGitAncestryResult(ancestry);
  return confirmedProof;
}

function validateWorkflowGitAncestryProofInput(
  input: WorkflowGitAncestryProofInput,
): ValidatedWorkflowGitAncestryProofInput {
  try {
    if (typeof input !== "object" || input === null || Array.isArray(input)) {
      throw new Error("invalid input");
    }
    const repositoryPath = input.repositoryPath;
    const worktreePath = input.worktreePath;
    const beforeHeadCommit = input.beforeHeadCommit;
    const afterHeadCommit = input.afterHeadCommit;
    if (
      typeof repositoryPath !== "string"
      || repositoryPath.length === 0
      || repositoryPath.includes("\0")
      || typeof worktreePath !== "string"
      || worktreePath.length === 0
      || worktreePath.includes("\0")
      || typeof beforeHeadCommit !== "string"
      || !/^[0-9a-f]{40}$/.test(beforeHeadCommit)
      || typeof afterHeadCommit !== "string"
      || !/^[0-9a-f]{40}$/.test(afterHeadCommit)
    ) {
      throw new Error("invalid input");
    }
    return Object.freeze({ repositoryPath, worktreePath, beforeHeadCommit, afterHeadCommit });
  } catch {
    throwWorkflowGitAncestryProofError("INVALID_INPUT");
  }
}

async function resolveLiveWorkflowGitAncestryFacts(
  input: ValidatedWorkflowGitAncestryProofInput,
): Promise<LiveWorkflowGitAncestryFacts> {
  try {
    return await resolveWorkflowGitAncestryFacts(input);
  } catch {
    throwWorkflowGitAncestryProofError("GIT_EXECUTION_FAILED");
  }
}

async function resolveWorkflowGitAncestryFacts(
  input: ValidatedWorkflowGitAncestryProofInput,
): Promise<LiveWorkflowGitAncestryFacts> {
  const repositoryTopLevel = await resolveConcreteGitTopLevel(input.repositoryPath);
  const worktreeTopLevel = await resolveConcreteGitTopLevel(input.worktreePath);
  const repositoryCommonDirectory = await resolveGitFilesystemObject(
    repositoryTopLevel.canonicalPath,
    ["rev-parse", "--path-format=absolute", "--git-common-dir"],
  );
  const worktreeCommonDirectory = await resolveGitFilesystemObject(
    worktreeTopLevel.canonicalPath,
    ["rev-parse", "--path-format=absolute", "--git-common-dir"],
  );
  if (!sameGitFilesystemObject(repositoryCommonDirectory, worktreeCommonDirectory)) {
    throw new Error("Git common directory identity mismatch");
  }

  const repositoryObjectDirectory = await resolveGitFilesystemObject(
    repositoryTopLevel.canonicalPath,
    ["rev-parse", "--path-format=absolute", "--git-path", "objects"],
  );
  const worktreeObjectDirectory = await resolveGitFilesystemObject(
    worktreeTopLevel.canonicalPath,
    ["rev-parse", "--path-format=absolute", "--git-path", "objects"],
  );
  if (!sameGitFilesystemObject(repositoryObjectDirectory, worktreeObjectDirectory)) {
    throw new Error("Git object directory identity mismatch");
  }

  const worktreeGitDirectory = await resolveGitFilesystemObject(
    worktreeTopLevel.canonicalPath,
    ["rev-parse", "--path-format=absolute", "--git-dir"],
  );
  await verifyWorkflowGitCommit(repositoryTopLevel.canonicalPath, input.beforeHeadCommit);
  await verifyWorkflowGitCommit(repositoryTopLevel.canonicalPath, input.afterHeadCommit);
  await verifyWorkflowGitCommit(worktreeTopLevel.canonicalPath, input.beforeHeadCommit);
  await verifyWorkflowGitCommit(worktreeTopLevel.canonicalPath, input.afterHeadCommit);

  const repositoryIdentity = hashWorkflowGitIdentity(
    "skyturn.workflow-git-ancestry-proof.repository.v1",
    directoryIdentityFields("top-level", repositoryTopLevel),
    directoryIdentityFields("common-directory", repositoryCommonDirectory),
    directoryIdentityFields("object-directory", repositoryObjectDirectory),
  );
  const worktreeIdentity = hashWorkflowGitIdentity(
    "skyturn.workflow-git-ancestry-proof.worktree.v1",
    directoryIdentityFields("top-level", worktreeTopLevel),
    directoryIdentityFields("git-directory", worktreeGitDirectory),
  );
  const context = createWorkflowGitAncestryProofContext(
    input.beforeHeadCommit,
    input.afterHeadCommit,
    repositoryIdentity,
    worktreeIdentity,
  );
  const snapshot = JSON.stringify({
    repositoryTopLevel,
    worktreeTopLevel,
    repositoryCommonDirectory,
    worktreeCommonDirectory,
    repositoryObjectDirectory,
    worktreeObjectDirectory,
    worktreeGitDirectory,
    beforeHeadCommit: input.beforeHeadCommit,
    afterHeadCommit: input.afterHeadCommit,
  });
  return { context, snapshot, worktreePath: worktreeTopLevel.canonicalPath };
}

async function resolveConcreteGitTopLevel(candidatePath: string): Promise<GitFilesystemObjectFacts> {
  const candidate = await realpath(candidatePath);
  const reportedTopLevel = await realpath((await runGit(candidate, [
    "rev-parse",
    "--path-format=absolute",
    "--show-toplevel",
  ])).stdout);
  if (candidate !== reportedTopLevel) throw new Error("Git top-level mismatch");
  return resolveGitFilesystemObjectAtPath(reportedTopLevel);
}

async function resolveGitFilesystemObject(cwd: string, args: string[]): Promise<GitFilesystemObjectFacts> {
  const result = await runGit(cwd, args);
  return resolveGitFilesystemObjectAtPath(result.stdout);
}

async function resolveGitFilesystemObjectAtPath(path: string): Promise<GitFilesystemObjectFacts> {
  const canonicalPath = await realpath(path);
  const facts = await stat(canonicalPath, { bigint: true });
  if (!facts.isDirectory()) throw new Error("Git identity object is not a directory");
  const birthtimeNs = facts.birthtimeNs > 0n ? facts.birthtimeNs.toString() : null;
  if (facts.ino === 0n && birthtimeNs === null) {
    throw new Error("Git identity object has no replacement-sensitive filesystem identity");
  }
  return {
    canonicalPath,
    device: facts.dev.toString(),
    inode: facts.ino.toString(),
    birthtimeNs,
  };
}

async function verifyWorkflowGitCommit(cwd: string, commit: string): Promise<void> {
  await runGit(cwd, ["cat-file", "-e", `${commit}^{commit}`]);
}

function sameGitFilesystemObject(
  left: GitFilesystemObjectFacts,
  right: GitFilesystemObjectFacts,
): boolean {
  return left.canonicalPath === right.canonicalPath
    && left.device === right.device
    && left.inode === right.inode
    && left.birthtimeNs === right.birthtimeNs;
}

function directoryIdentityFields(label: string, facts: GitFilesystemObjectFacts): string[] {
  return [
    label,
    "canonical-path",
    facts.canonicalPath,
    "device",
    facts.device,
    "inode",
    facts.inode,
    "birthtime-ns",
    facts.birthtimeNs ?? "unavailable",
  ];
}

function hashWorkflowGitIdentity(domain: string, ...fieldGroups: string[][]): string {
  const hash = createHash("sha256");
  for (const value of [domain, ...fieldGroups.flat()]) {
    const bytes = Buffer.from(value, "utf8");
    const length = Buffer.alloc(8);
    length.writeBigUInt64BE(BigInt(bytes.byteLength));
    hash.update(length);
    hash.update(bytes);
  }
  return hash.digest("hex");
}

async function executeWorkflowGitAncestryCheck(
  facts: LiveWorkflowGitAncestryFacts,
  input: ValidatedWorkflowGitAncestryProofInput,
): Promise<GitResult> {
  try {
    return await runGit(facts.worktreePath, [
      "merge-base",
      "--is-ancestor",
      input.beforeHeadCommit,
      input.afterHeadCommit,
    ], { allowFailure: true, unknownFailureExitCode: -1 });
  } catch {
    throwWorkflowGitAncestryProofError("GIT_EXECUTION_FAILED");
  }
}

function assertWorkflowGitAncestryFactsUnchanged(
  before: LiveWorkflowGitAncestryFacts,
  after: LiveWorkflowGitAncestryFacts,
): void {
  if (before.snapshot !== after.snapshot) {
    throwWorkflowGitAncestryProofError("GIT_EXECUTION_FAILED");
  }
}

function assertWorkflowGitAncestryResult(result: GitResult): void {
  if (result.exitCode === 0) return;
  if (result.exitCode === 1) throwWorkflowGitAncestryProofError("NOT_ANCESTOR");
  throwWorkflowGitAncestryProofError("GIT_EXECUTION_FAILED");
}

function parseSerializedWorkflowGitAncestryProof(
  serializedProof: unknown,
  context: WorkflowGitAncestryProofContext,
  failureCode: "INVALID_INPUT" | "GIT_EXECUTION_FAILED",
): WorkflowGitAncestryProof {
  try {
    return parseWorkflowGitAncestryProof(serializedProof, context);
  } catch (error) {
    const contextMismatch = error instanceof Error
      && error.message === "Workflow Git ancestry proof context mismatch.";
    throwWorkflowGitAncestryProofError(contextMismatch ? "GIT_EXECUTION_FAILED" : failureCode);
  }
}

function throwWorkflowGitAncestryProofError(code: WorkflowGitAncestryProofErrorCode): never {
  throw new WorkflowGitAncestryProofError(code);
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

  async adoptVariant(
    input: WorkflowVariantAdoption,
    options: VariantAdoptionOptions = {},
  ): Promise<WorkflowVariantAdoption> {
    const requested: WorkflowVariantAdoption = { ...input, status: "requested" };
    await this.record("workflow.variant.adopt_requested", {
      adoption: requested,
    }, `variant:${input.adoptionId}:adopt-requested`);

    const eventWorktree = this.findCreatedWorktree(input.worktreeId);
    try {
      if (!eventWorktree) throw new Error(`No created worktree event for ${input.worktreeId}.`);
      verifyAdoptionRecord(input, eventWorktree);
      const worktree = await this.reconcileManagedWorktree(eventWorktree, { expectedHeadCommit: input.headCommit });
      await assertCleanWorktree(worktree.realPath, "variant worktree");
      await validateTargetBranch(worktree.repoRoot, input.targetBranchName);
      await checkoutTargetBranch(worktree.repoRoot, input.targetBranchName);
      await assertCleanWorktree(worktree.repoRoot, "target worktree");
      await assertTargetHeadMatchesBase(worktree.repoRoot, input);
      const candidateCommit = await prepareAdoptionCandidate(worktree.repoRoot, input);
      const requiredFreshWorktrees = options.requiredFreshWorktrees ?? [worktree];
      const reconciledFreshWorktrees = await Promise.all(requiredFreshWorktrees.map((required) => (
        this.reconcileManagedWorktree(required, { expectedHeadCommit: required.headCommit })
      )));
      if (reconciledFreshWorktrees.some((required) => required.branchName === input.targetBranchName)) {
        throw new Error("Adoption target branch must not be a compared worktree branch.");
      }
      await withLockedFreshWorktreeHeads(worktree.repoRoot, reconciledFreshWorktrees, () => (
        publishPreparedCandidateRef(worktree.repoRoot, {
          branchRef: `refs/heads/${input.targetBranchName}`,
          candidateCommit,
          expectedHeadCommit: input.baseCommit,
        })
      ));
      await runGit(worktree.repoRoot, ["read-tree", "--reset", "-u", candidateCommit]);
      const adopted: WorkflowVariantAdoption = { ...input, status: "adopted", adoptedCommit: candidateCommit };
      await this.record("workflow.variant.adopted", {
        adoption: adopted,
      }, `variant:${input.adoptionId}:adopted`);
      return adopted;
    } catch (error) {
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
  maxFullPatchBytes?: number;
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

export interface GitCheckpointSnapshot {
  branchName: string;
  headCommit: string;
  worktreeState: "clean" | "dirty";
}

export async function getGitCheckpointSnapshot(repoRoot: string): Promise<GitCheckpointSnapshot> {
  await assertGitWorktree(repoRoot);
  const [branch, head, status] = await Promise.all([
    runGit(repoRoot, ["branch", "--show-current"]),
    runGit(repoRoot, ["rev-parse", "--verify", "HEAD^{commit}"]),
    git(repoRoot, ["status", "--porcelain=v1", "--untracked-files=all", "--", ...skyturnGitEvidencePathspecs]),
  ]);
  if (status.truncated) throw new Error("Git status output exceeded the checkpoint evidence limit.");
  return {
    branchName: branch.stdout,
    headCommit: head.stdout.toLowerCase(),
    worktreeState: status.stdout.trim() ? "dirty" : "clean",
  };
}

export async function evaluateRollbackWorktreeState(input: RollbackWorktreeInput): Promise<RollbackWorktreeState> {
  const restoreCommitRef = input.restoreCommitRef;
  const expectedHeadCommit = input.expectedHeadCommit;
  if (!isFullCommitSha(restoreCommitRef)) {
    return rollbackManualRepair("invalid_restore_commit", "Rollback restore target must be a recorded full commit SHA.");
  }
  if (!isFullCommitSha(expectedHeadCommit)) {
    return rollbackManualRepair("invalid_recorded_commit", "Rollback recorded HEAD must be a full commit SHA.", {
      restoreCommitRef,
    });
  }

  const context = await resolveRollbackWorktreeContext(input);
  if (!context.ok) return context.result;
  const { repoRoot, worktreePath } = context;

  if (!await commitObjectExists(worktreePath, restoreCommitRef)) {
    return rollbackManualRepair("missing_restore_commit", "Rollback restore commit is not present in the worktree repository.", {
      worktreePath,
      restoreCommitRef,
    });
  }
  if (!await commitObjectExists(worktreePath, expectedHeadCommit)) {
    return rollbackManualRepair("missing_recorded_commit", "Rollback recorded HEAD commit is not present in the worktree repository.", {
      worktreePath,
      restoreCommitRef,
    });
  }

  const listed = await findListedRollbackWorktree(repoRoot, worktreePath);
  if (!listed.ok) return listed.result;
  const expectedBranchRef = `refs/heads/${input.expectedBranchName}`;
  const branchName = await currentBranch(worktreePath).catch(() => "");
  if (branchName !== input.expectedBranchName || listed.entry.branch !== expectedBranchRef) {
    return rollbackManualRepair("branch_mismatch", "Worktree branch does not match the SkyTurn-managed branch.", {
      worktreePath,
      branchName: branchName || undefined,
      restoreCommitRef,
    });
  }
  const headCommit = await currentHead(worktreePath).catch(() => "");
  if (!isFullCommitSha(headCommit) || listed.entry.head?.toLowerCase() !== headCommit.toLowerCase()) {
    return rollbackManualRepair("head_mismatch", "Worktree HEAD does not match git worktree list evidence.", {
      worktreePath,
      branchName,
      headCommit: headCommit || undefined,
      restoreCommitRef,
    });
  }

  const dirtyStatus = await runGit(
    worktreePath,
    ["status", "--porcelain=v1", "--untracked-files=all", "--", ...skyturnGitEvidencePathspecs],
    { allowFailure: true },
  );
  if (dirtyStatus.exitCode !== 0) {
    return rollbackManualRepair("dirty_worktree", "Worktree clean status could not be verified.", {
      worktreePath,
      branchName,
      headCommit,
      restoreCommitRef,
    });
  }
  if (dirtyStatus.stdout.trim()) {
    return rollbackManualRepair("dirty_worktree", "Worktree has uncommitted changes.", {
      worktreePath,
      branchName,
      headCommit,
      restoreCommitRef,
    });
  }
  if (headCommit.toLowerCase() === expectedHeadCommit.toLowerCase()) {
    return {
      status: "safe",
      worktreePath,
      branchName,
      headCommit,
      restoreCommitRef,
    };
  }
  if (headCommit.toLowerCase() === restoreCommitRef.toLowerCase()) {
    return {
      status: "already_restored",
      worktreePath,
      branchName,
      headCommit,
      restoreCommitRef,
    };
  }
  return rollbackManualRepair("head_mismatch", "Worktree HEAD does not match the SkyTurn-recorded local commit.", {
    worktreePath,
    branchName,
    headCommit,
    restoreCommitRef,
  });
}

export async function resetRollbackWorktreeToCommit(input: RollbackWorktreeInput): Promise<RollbackWorktreeResetResult> {
  const before = await evaluateRollbackWorktreeState(input);
  if (before.status !== "safe") return before;

  const reset = await runGit(before.worktreePath, ["reset", "--hard", input.restoreCommitRef], { allowFailure: true });
  if (reset.exitCode !== 0) {
    return rollbackManualRepair("git_reset_failed", `Git reset failed; manual repair is required. ${errorMessage(reset.stderr || reset.stdout)}`.trim(), {
      worktreePath: before.worktreePath,
      branchName: before.branchName,
      headCommit: before.headCommit,
      restoreCommitRef: before.restoreCommitRef,
    });
  }

  const after = await evaluateRollbackWorktreeState({
    ...input,
    expectedHeadCommit: input.restoreCommitRef,
  });
  if (after.status !== "safe") {
    return rollbackManualRepair("post_reset_mismatch", "Git reset completed but post-reset worktree evidence is ambiguous.", {
      worktreePath: "worktreePath" in after ? after.worktreePath : before.worktreePath,
      branchName: "branchName" in after ? after.branchName : before.branchName,
      headCommit: "headCommit" in after ? after.headCommit : undefined,
      restoreCommitRef: input.restoreCommitRef,
    });
  }
  return {
    status: "applied",
    worktreePath: after.worktreePath,
    branchName: after.branchName,
    headCommit: after.headCommit,
    restoreCommitRef: after.restoreCommitRef,
  };
}

export async function createDeliveryCommit(input: DeliveryCommitInput): Promise<DeliveryCommitEvidence> {
  assertDeliveryReconciliationStatus(input.reconciliationStatus, input.acceptMismatch === true);
  const subject = normalizeCommitSubject(input.subject);
  const body = normalizeCommitBody(input.body);
  const worktreePath = await resolveDeliveryWorktreePath(input.projectRoot, input.worktreePath);
  const files = await normalizeDeliveryFileList(worktreePath, input.files);
  const statusLines = parseStatusLines((await git(
    worktreePath,
    ["status", "--porcelain=v1", "--untracked-files=all", "--", ...skyturnGitEvidencePathspecs],
  )).stdout);
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

export async function createCandidateDeliveryCommit(
  input: CandidateDeliveryCommitInput,
): Promise<CandidateDeliveryCommitEvidence> {
  const parsedInput = parseCandidateDeliveryCommitInput(input);
  const preparation = await prepareParsedCandidateDeliveryCommit(parsedInput);
  return publishParsedCandidateDeliveryCommit({
    projectRoot: parsedInput.projectRoot,
    worktreePath: parsedInput.worktreePath,
    preparation,
  }, false);
}

export async function prepareCandidateDeliveryCommit(
  input: CandidateDeliveryCommitInput,
): Promise<CandidateDeliveryCommitPreparation> {
  const parsedInput = parseCandidateDeliveryCommitInput(input);
  return prepareParsedCandidateDeliveryCommit(parsedInput);
}

async function prepareParsedCandidateDeliveryCommit(
  parsedInput: ParsedCandidateDeliveryCommitInput,
): Promise<CandidateDeliveryCommitPreparation> {
  try {
    const { projectRoot, worktreePath, snapshot } = await collectVerifiedCandidateSnapshot(parsedInput);

    const temporaryRoot = await mkdtemp(join(tmpdir(), "skyturn-candidate-commit-"));
    try {
      await chmod(temporaryRoot, 0o700);
      const indexFile = resolve(temporaryRoot, "index");
      return await prepareCandidateSnapshot(
        projectRoot,
        worktreePath,
        indexFile,
        snapshot,
        parsedInput.expected,
        parsedInput.message,
      );
    } finally {
      try {
        await rm(temporaryRoot, { recursive: true, force: true });
      } catch {
        await rm(temporaryRoot, { recursive: true, force: true });
      }
    }
  } catch (error) {
    if (error instanceof DeliveryCommitError && error.message === candidateRejectedMessage) throw error;
    throwDelivery("DELIVERY_REJECTED", candidateRejectedMessage);
  }
}

export async function publishPreparedCandidateDeliveryCommit(
  input: PublishPreparedCandidateDeliveryCommitInput,
): Promise<CandidateDeliveryCommitEvidence> {
  const parsedInput = parsePublishPreparedCandidateDeliveryCommitInput(input);
  return publishParsedCandidateDeliveryCommit(parsedInput, true);
}

async function publishParsedCandidateDeliveryCommit(
  parsedInput: ParsedPublishPreparedCandidateDeliveryCommitInput,
  allowAlreadyPublished: boolean,
): Promise<CandidateDeliveryCommitEvidence> {
  try {
    const projectRoot = await assertGitRepo(parsedInput.projectRoot);
    const worktreePath = await resolveDeliveryWorktreePath(projectRoot, parsedInput.worktreePath);
    const preparation = parsedInput.preparation;
    await assertCandidateBranchName(worktreePath, preparation.branch);
    await assertCandidateSha1Repository(worktreePath);
    await assertCandidateIdentityStillMatches(projectRoot, worktreePath, preparation.expected);
    await assertPreparedCandidateCommitFacts(worktreePath, preparation);

    const branchRef = candidateBranchRef(preparation.branch);
    await assertCandidateBranchRefIsDirect(worktreePath, branchRef);
    const branchHead = await candidateGitCommit(worktreePath, [
      "rev-parse",
      "--verify",
      "--end-of-options",
      `${branchRef}^{commit}`,
    ]);
    if (branchHead === preparation.parentCommit) {
      try {
        await publishPreparedCandidateRef(worktreePath, {
          branchRef,
          candidateCommit: preparation.commitSha,
          expectedHeadCommit: preparation.parentCommit,
        });
      } catch (error) {
        const recoveredHead = await candidateGitCommit(worktreePath, [
          "rev-parse",
          "--verify",
          "--end-of-options",
          `${branchRef}^{commit}`,
        ]);
        if (!allowAlreadyPublished || recoveredHead !== preparation.commitSha) throw error;
      }
    } else if (branchHead !== preparation.commitSha || !allowAlreadyPublished) {
      throw new Error("Candidate branch conflicts with prepared publication.");
    }

    await assertPublishedCandidateCommitFacts(worktreePath, preparation);
    return Object.freeze({
      status: "committed",
      commitSha: preparation.commitSha,
      branch: preparation.branch,
      parentCommit: preparation.parentCommit,
    });
  } catch (error) {
    if (error instanceof DeliveryCommitError && error.message === candidateRejectedMessage) throw error;
    throwDelivery("DELIVERY_REJECTED", candidateRejectedMessage);
  }
}

export async function captureCandidateDeliveryReviewSnapshot(
  input: CandidateDeliveryReviewSnapshotInput,
): Promise<CandidateDeliveryReviewSnapshot> {
  try {
    const parsedInput = parseCandidateDeliveryReviewSnapshotInput(input);
    const { snapshot } = await collectVerifiedCandidateSnapshot(parsedInput);
    return Object.freeze({
      baselineCommit: snapshot.baselineCommit,
      headCommit: snapshot.headCommit!,
      fullPatchBase64: snapshot.fullPatch.toString("base64"),
      fullPatchSha256: snapshot.fullPatchSha256!,
      fullPatchByteLength: snapshot.fullPatchByteLength,
      fileManifestSha256: snapshot.fileManifestSha256!,
    });
  } catch (error) {
    if (error instanceof DeliveryCommitError && error.message === candidateRejectedMessage) throw error;
    throwDelivery("DELIVERY_REJECTED", candidateRejectedMessage);
  }
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
  assertPullRequestReviewAllowsMerge(checksEvidence.review);
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

function assertPullRequestReviewAllowsMerge(review: DeliveryPullRequestReviewGate): void {
  if (review.status === "approved" || review.status === "pending") return;
  if (review.status === "changes_requested") {
    throwRemote("DELIVERY_REJECTED", "Pull request review requested changes before merge.");
  }
  throwRemote(
    "DELIVERY_REJECTED",
    `Pull request review evidence must be approved or pending before merge; got ${review.status || "unknown"}.`,
  );
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
  const status = reviewStatusFromDecision(decision)
    ?? reviewStatusFromDecision(latestReview?.state)
    ?? (hasOnlyExplicitNonActionableReviews(value.reviewDecision, value.reviews) ? "pending" : "unknown");
  return {
    status,
    decision: sanitizeCommandOutput(decision ?? latestReview?.state ?? "UNKNOWN"),
    ...(latestReview?.detail ? { detail: sanitizeCommandOutput(latestReview.detail) } : {}),
    ...(latestReview?.reviewer ? { reviewer: sanitizeCommandOutput(latestReview.reviewer) } : {}),
    ...(latestReview?.link ? { link: sanitizeCommandOutput(latestReview.link) } : {}),
  };
}

function hasOnlyExplicitNonActionableReviews(decision: unknown, value: unknown): boolean {
  if (decision !== "" || !Array.isArray(value)) return false;
  return value.every((review) => {
    if (!isRecord(review)) return false;
    const state = textFromUnknown(review.state) ?? textFromUnknown(review.reviewDecision);
    if (!state) return false;
    const normalizedState = state.toLowerCase();
    return normalizedState === "commented"
      || normalizedState === "dismissed"
      || normalizedState === "pending";
  });
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
      ...(command === "git" ? { env: sanitizedGitEnvironment() } : {}),
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

function normalizeCommitBody(value: string | undefined): string | undefined {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : undefined;
}

interface ParsedCandidateDeliveryCommitInput {
  readonly projectRoot: string;
  readonly worktreePath: string;
  readonly expected: CandidateCommitExpectation;
  readonly message: Buffer;
}

interface ParsedPublishPreparedCandidateDeliveryCommitInput {
  readonly projectRoot: string;
  readonly worktreePath: string;
  readonly preparation: CandidateDeliveryCommitPreparation;
}

interface ParsedCandidateDeliveryReviewSnapshotInput {
  readonly projectRoot: string;
  readonly worktreePath: string;
  readonly expected: CandidateCommitExpectation;
}

function parseCandidateDeliveryReviewSnapshotInput(value: unknown): ParsedCandidateDeliveryReviewSnapshotInput {
  try {
    if (typeof value !== "object" || value === null || Array.isArray(value)) {
      throw new Error("Invalid candidate review snapshot input.");
    }
    const record = value as Record<string, unknown>;
    if (
      typeof record.projectRoot !== "string" ||
      record.projectRoot.length === 0 ||
      record.projectRoot.includes("\0") ||
      typeof record.worktreePath !== "string" ||
      record.worktreePath.length === 0 ||
      record.worktreePath.includes("\0")
    ) {
      throw new Error("Invalid candidate review snapshot path input.");
    }
    return Object.freeze({
      projectRoot: record.projectRoot,
      worktreePath: record.worktreePath,
      expected: validateCandidateCommitExpectation(record.expected),
    });
  } catch {
    throwDelivery("INVALID_INPUT", candidateInvalidMessage);
  }
}

async function collectVerifiedCandidateSnapshot(
  input: ParsedCandidateDeliveryReviewSnapshotInput,
): Promise<{ projectRoot: string; worktreePath: string; snapshot: AtomicGitChangesetSnapshot }> {
  const projectRoot = await assertGitRepo(input.projectRoot);
  const worktreePath = await resolveDeliveryWorktreePath(projectRoot, input.worktreePath);
  await assertCandidateBranchName(worktreePath, input.expected.branchName);
  await assertCandidateSha1Repository(worktreePath);
  await assertCandidateLiveCheckout(worktreePath, input.expected);
  await assertCandidateAncestryExpectation(projectRoot, worktreePath, input.expected);
  const snapshot = await collectAtomicGitChangesetSnapshot({
    repoRoot: worktreePath,
    baseline: { kind: "ref", ref: input.expected.beforeHeadCommit },
    maxPatchPreviewBytes: 1,
    maxFullPatchBytes: DEFAULT_MAX_FULL_PATCH_BYTES,
  });
  assertCandidateSnapshot(snapshot, input.expected);
  return { projectRoot, worktreePath, snapshot };
}

function parseCandidateDeliveryCommitInput(value: unknown): ParsedCandidateDeliveryCommitInput {
  try {
    if (typeof value !== "object" || value === null || Array.isArray(value)) {
      throw new Error("Invalid candidate input.");
    }
    const record = value as Record<string, unknown>;
    const projectRoot = record.projectRoot;
    const worktreePath = record.worktreePath;
    const expectedValue = record.expected;
    const subjectValue = record.subject;
    const bodyValue = record.body;
    if (
      typeof projectRoot !== "string"
      || projectRoot.length === 0
      || projectRoot.includes("\0")
      || typeof worktreePath !== "string"
      || worktreePath.length === 0
      || worktreePath.includes("\0")
    ) {
      throw new Error("Invalid candidate path input.");
    }
    return Object.freeze({
      projectRoot,
      worktreePath,
      expected: validateCandidateCommitExpectation(expectedValue),
      message: candidateCommitMessage(subjectValue, bodyValue),
    });
  } catch {
    throwDelivery("INVALID_INPUT", candidateInvalidMessage);
  }
}

function parsePublishPreparedCandidateDeliveryCommitInput(
  value: unknown,
): ParsedPublishPreparedCandidateDeliveryCommitInput {
  try {
    if (!isOrdinaryCandidateRecord(value, ["preparation", "projectRoot", "worktreePath"])) {
      throw new Error("Invalid prepared candidate publication input.");
    }
    if (
      typeof value.projectRoot !== "string" ||
      value.projectRoot.length === 0 ||
      value.projectRoot.includes("\0") ||
      typeof value.worktreePath !== "string" ||
      value.worktreePath.length === 0 ||
      value.worktreePath.includes("\0")
    ) {
      throw new Error("Invalid prepared candidate publication path.");
    }
    return Object.freeze({
      projectRoot: value.projectRoot,
      worktreePath: value.worktreePath,
      preparation: validateCandidateDeliveryCommitPreparation(value.preparation),
    });
  } catch {
    throwDelivery("INVALID_INPUT", candidateInvalidMessage);
  }
}

function validateCandidateDeliveryCommitPreparation(value: unknown): CandidateDeliveryCommitPreparation {
  const parsed = parseCandidateDeliveryCommitPreparation(value);
  if (!parsed) throw new Error("Invalid candidate commit preparation.");
  return parsed;
}

function isOrdinaryCandidateRecord(
  value: unknown,
  expectedKeys: readonly string[],
): value is Record<string, unknown> {
  return !!value &&
    typeof value === "object" &&
    !Array.isArray(value) &&
    Object.getPrototypeOf(value) === Object.prototype &&
    sameOrderedStrings(Object.keys(value).sort(), expectedKeys);
}

function validateCandidateCommitExpectation(value: unknown): CandidateCommitExpectation {
  if (!value || typeof value !== "object" || Array.isArray(value) || Object.getPrototypeOf(value) !== Object.prototype) {
    throwDelivery("INVALID_INPUT", candidateInvalidMessage);
  }
  const record = value as Record<string, unknown>;
  const keys = Object.keys(record).sort();
  if (
    keys.length !== candidateExpectationKeys.length
    || keys.some((key, index) => key !== candidateExpectationKeys[index])
    || !isCanonicalLowercaseHex(record.repositoryIdentity, 64)
    || !isCanonicalLowercaseHex(record.worktreeIdentity, 64)
    || !isBoundedCandidateBranch(record.branchName)
    || !isCanonicalLowercaseHex(record.beforeHeadCommit, 40)
    || !isCanonicalLowercaseHex(record.afterHeadCommit, 40)
    || !isCanonicalLowercaseHex(record.ancestryProofSha256, 64)
    || !isCanonicalLowercaseHex(record.fullPatchSha256, 64)
    || !Number.isSafeInteger(record.fullPatchByteLength)
    || (record.fullPatchByteLength as number) <= 0
    || (record.fullPatchByteLength as number) > DEFAULT_MAX_FULL_PATCH_BYTES
    || !isCanonicalLowercaseHex(record.fileManifestSha256, 64)
  ) {
    throwDelivery("INVALID_INPUT", candidateInvalidMessage);
  }
  return Object.freeze({
    repositoryIdentity: record.repositoryIdentity as string,
    worktreeIdentity: record.worktreeIdentity as string,
    branchName: record.branchName as string,
    beforeHeadCommit: record.beforeHeadCommit as string,
    afterHeadCommit: record.afterHeadCommit as string,
    ancestryProofSha256: record.ancestryProofSha256 as string,
    fullPatchSha256: record.fullPatchSha256 as string,
    fullPatchByteLength: record.fullPatchByteLength as number,
    fileManifestSha256: record.fileManifestSha256 as string,
  });
}

function isCanonicalLowercaseHex(value: unknown, length: number): value is string {
  return typeof value === "string" && new RegExp(`^[0-9a-f]{${length}}$`).test(value);
}

function isBoundedCandidateBranch(value: unknown): value is string {
  return typeof value === "string"
    && value.length > 0
    && Buffer.byteLength(value, "utf8") <= 1_024
    && !value.includes("\0")
    && !value.includes("\r")
    && !value.includes("\n");
}

function candidateCommitMessage(subjectValue: unknown, bodyValue: unknown): Buffer {
  if (
    typeof subjectValue !== "string"
    || subjectValue.length > candidateCommitMessageMaxBytes
    || Buffer.byteLength(subjectValue, "utf8") > candidateCommitMessageMaxBytes
    || (bodyValue !== undefined && (
      typeof bodyValue !== "string"
      || bodyValue.length > candidateCommitMessageMaxBytes
      || Buffer.byteLength(bodyValue, "utf8") > candidateCommitMessageMaxBytes
    ))
  ) {
    throwDelivery("INVALID_INPUT", candidateInvalidMessage);
  }
  const subject = normalizeCommitSubject(subjectValue);
  const normalizedBody = bodyValue === undefined ? undefined : bodyValue.trim();
  const body = normalizedBody && normalizedBody.length > 0 ? normalizedBody : undefined;
  const messageByteLength = Buffer.byteLength(subject, "utf8")
    + 1
    + (body === undefined ? 0 : Buffer.byteLength(body, "utf8") + 2);
  if (messageByteLength > candidateCommitMessageMaxBytes) {
    throwDelivery("INVALID_INPUT", candidateInvalidMessage);
  }
  return Buffer.from(body === undefined ? `${subject}\n` : `${subject}\n\n${body}\n`, "utf8");
}

async function assertCandidateBranchName(cwd: string, branchName: string): Promise<void> {
  await runCandidateGit(cwd, ["check-ref-format", "--branch", branchName]);
}

async function assertCandidateSha1Repository(cwd: string): Promise<void> {
  const objectFormat = await candidateGitLine(cwd, ["rev-parse", "--show-object-format"]);
  if (objectFormat !== "sha1") throw new Error("Unsupported Git object format.");
}

async function assertCandidateLiveCheckout(
  cwd: string,
  expected: CandidateCommitExpectation,
): Promise<void> {
  const branch = await candidateGitLine(cwd, ["symbolic-ref", "--quiet", "--short", "HEAD"]);
  const headCommit = await candidateGitCommit(cwd, [
    "rev-parse",
    "--verify",
    "--end-of-options",
    "HEAD^{commit}",
  ]);
  const branchCommit = await candidateGitCommit(cwd, [
    "rev-parse",
    "--verify",
    "--end-of-options",
    `${candidateBranchRef(expected.branchName)}^{commit}`,
  ]);
  if (
    branch !== expected.branchName
    || headCommit !== expected.afterHeadCommit
    || branchCommit !== expected.afterHeadCommit
  ) {
    throw new Error("Candidate checkout facts differ from the expectation.");
  }
}

async function assertCandidateAncestryExpectation(
  projectRoot: string,
  worktreePath: string,
  expected: CandidateCommitExpectation,
): Promise<void> {
  const serializedProof = await createWorkflowGitAncestryProof({
    repositoryPath: projectRoot,
    worktreePath,
    beforeHeadCommit: expected.beforeHeadCommit,
    afterHeadCommit: expected.afterHeadCommit,
  });
  const expectedContext = createWorkflowGitAncestryProofContext(
    expected.beforeHeadCommit,
    expected.afterHeadCommit,
    expected.repositoryIdentity,
    expected.worktreeIdentity,
  );
  parseWorkflowGitAncestryProof(serializedProof, expectedContext);
  if (sha256CandidateBytes(Buffer.from(serializedProof, "utf8")) !== expected.ancestryProofSha256) {
    throw new Error("Candidate ancestry proof digest differs from the expectation.");
  }
}

function assertCandidateSnapshot(
  snapshot: AtomicGitChangesetSnapshot,
  expected: CandidateCommitExpectation,
): void {
  if (
    snapshot.baselineCommit !== expected.beforeHeadCommit
    || snapshot.headCommit !== expected.afterHeadCommit
    || snapshot.files.length === 0
    || snapshot.fullPatch.byteLength === 0
    || snapshot.fullPatchSha256 !== expected.fullPatchSha256
    || snapshot.fullPatchByteLength !== expected.fullPatchByteLength
    || snapshot.fileManifestSha256 !== expected.fileManifestSha256
  ) {
    throw new Error("Candidate changeset differs from the expectation.");
  }
}

async function prepareCandidateSnapshot(
  projectRoot: string,
  worktreePath: string,
  indexFile: string,
  snapshot: AtomicGitChangesetSnapshot,
  expected: CandidateCommitExpectation,
  message: Buffer,
): Promise<CandidateDeliveryCommitPreparation> {
  const indexOptions = { internalGitIndexFile: indexFile } as const;
  await runCandidateGit(worktreePath, ["read-tree", expected.beforeHeadCommit], indexOptions);
  await runCandidateGit(worktreePath, [
    "apply",
    "--cached",
    "--binary",
    "--whitespace=nowarn",
    "-",
  ], {
    ...indexOptions,
    stdin: snapshot.fullPatch,
    stdinMaxBytes: DEFAULT_MAX_FULL_PATCH_BYTES,
  });
  if (expected.beforeHeadCommit !== expected.afterHeadCommit) {
    await runCandidateGit(worktreePath, [
      "reset",
      "--quiet",
      "--no-refresh",
      expected.afterHeadCommit,
      "--",
      ...candidateVolatilePathspecs(),
    ], indexOptions);
  }

  const manifestOutput = await runCandidateGit(worktreePath, [
    "diff",
    "--cached",
    "--name-only",
    "-z",
    "--no-renames",
    "--no-ext-diff",
    "--no-textconv",
    expected.beforeHeadCommit,
    "--",
    ...skyturnGitEvidencePathspecs,
  ], indexOptions);
  const files = parseCandidateFileManifest(manifestOutput);
  if (
    !sameOrderedStrings(files, snapshot.files)
    || hashCandidateFileManifest(files) !== expected.fileManifestSha256
  ) {
    throw new Error("Candidate isolated index manifest differs from the expectation.");
  }

  const tree = await candidateGitCommit(worktreePath, ["write-tree"], indexOptions);
  const parentTree = await candidateGitCommit(worktreePath, [
    "rev-parse",
    "--verify",
    "--end-of-options",
    `${expected.afterHeadCommit}^{tree}`,
  ]);
  if (tree === parentTree) throw new Error("Candidate tree is empty relative to its parent.");

  const commitSha = await candidateGitCommit(worktreePath, [
    "commit-tree",
    tree,
    "-p",
    expected.afterHeadCommit,
    "-F",
    "-",
  ], {
    stdin: message,
    stdinMaxBytes: candidateCommitMessageMaxBytes,
  });

  await assertCandidateIdentityStillMatches(projectRoot, worktreePath, expected);
  const branchHead = await candidateGitCommit(worktreePath, [
    "rev-parse",
    "--verify",
    "--end-of-options",
    `${candidateBranchRef(expected.branchName)}^{commit}`,
  ]);
  if (branchHead !== expected.afterHeadCommit) throw new Error("Candidate branch advanced.");
  return Object.freeze({
    status: "prepared",
    commitSha,
    treeSha: tree,
    branch: expected.branchName,
    parentCommit: expected.afterHeadCommit,
    expected,
  });
}

async function assertPreparedCandidateCommitFacts(
  worktreePath: string,
  preparation: CandidateDeliveryCommitPreparation,
): Promise<void> {
  const commitType = await candidateGitLine(worktreePath, [
    "cat-file",
    "-t",
    preparation.commitSha,
  ]);
  const parentLine = await candidateGitLine(worktreePath, [
    "rev-list",
    "--parents",
    "-n",
    "1",
    preparation.commitSha,
  ]);
  const tree = await candidateGitCommit(worktreePath, [
    "rev-parse",
    "--verify",
    "--end-of-options",
    `${preparation.commitSha}^{tree}`,
  ]);
  const parentTree = await candidateGitCommit(worktreePath, [
    "rev-parse",
    "--verify",
    "--end-of-options",
    `${preparation.parentCommit}^{tree}`,
  ]);
  if (
    commitType !== "commit" ||
    parentLine !== `${preparation.commitSha} ${preparation.parentCommit}` ||
    tree !== preparation.treeSha ||
    tree === parentTree
  ) {
    throw new Error("Prepared candidate commit facts conflict.");
  }
}

async function assertPublishedCandidateCommitFacts(
  worktreePath: string,
  preparation: CandidateDeliveryCommitPreparation,
): Promise<void> {
  const publishedCommit = await candidateGitCommit(worktreePath, [
    "rev-parse",
    "--verify",
    "--end-of-options",
    `${candidateBranchRef(preparation.branch)}^{commit}`,
  ]);
  if (publishedCommit !== preparation.commitSha) {
    throw new Error("Candidate publication verification failed.");
  }
  await assertPreparedCandidateCommitFacts(worktreePath, preparation);
}

async function assertCandidateBranchRefIsDirect(cwd: string, branchRef: string): Promise<void> {
  const symref = await candidateGitLine(cwd, [
    "for-each-ref",
    "--format=%(symref)",
    "--count=1",
    branchRef,
  ]);
  if (symref !== "") throw new Error("Candidate branch ref is symbolic.");
}

async function assertCandidateIdentityStillMatches(
  projectRoot: string,
  worktreePath: string,
  expected: CandidateCommitExpectation,
): Promise<void> {
  const live = await createLiveWorkflowGitAncestryProofContext({
    repositoryPath: projectRoot,
    worktreePath,
    beforeHeadCommit: expected.beforeHeadCommit,
    afterHeadCommit: expected.afterHeadCommit,
  });
  if (
    live.repositoryIdentity !== expected.repositoryIdentity
    || live.worktreeIdentity !== expected.worktreeIdentity
  ) {
    throw new Error("Candidate Git identity changed.");
  }
}

function candidateBranchRef(branchName: string): string {
  return `refs/heads/${branchName}`;
}

function candidateVolatilePathspecs(): string[] {
  return SKYTURN_VOLATILE_GIT_PATHS.map((path) => (
    path.includes("**") ? `:(top,glob)${path}` : `:(top,literal)${path}`
  ));
}

function parseCandidateFileManifest(raw: Buffer): string[] {
  if (raw.byteLength === 0 || raw[raw.byteLength - 1] !== 0) {
    throw new Error("Candidate file manifest is malformed.");
  }
  const files: string[] = [];
  let start = 0;
  for (let index = 0; index < raw.byteLength; index += 1) {
    if (raw[index] !== 0) continue;
    const bytes = raw.subarray(start, index);
    const file = bytes.toString("utf8");
    if (
      bytes.byteLength === 0
      || !Buffer.from(file, "utf8").equals(bytes)
      || isAbsolute(file)
      || /^[A-Za-z]:[\\/]/.test(file)
      || file.split("/").some((part) => part === "" || part === "." || part === "..")
    ) {
      throw new Error("Candidate file manifest is malformed.");
    }
    files.push(file);
    start = index + 1;
  }
  const canonical = [...new Set(files)].sort(compareCandidateUtf8);
  if (canonical.length !== files.length) throw new Error("Candidate file manifest contains duplicates.");
  return canonical;
}

function hashCandidateFileManifest(files: string[]): string {
  return hashWorkflowGitIdentity("skyturn-git-file-manifest-v1", files);
}

function sha256CandidateBytes(value: Buffer): string {
  return createHash("sha256").update(value).digest("hex");
}

function compareCandidateUtf8(left: string, right: string): number {
  return Buffer.compare(Buffer.from(left, "utf8"), Buffer.from(right, "utf8"));
}

function sameOrderedStrings(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length && left.every((value, index) => value === right[index]);
}

interface CandidateGitOptions {
  readonly stdin?: Buffer;
  readonly stdinMaxBytes?: number;
  readonly internalGitIndexFile?: string;
}

async function runCandidateGit(
  cwd: string,
  args: readonly string[],
  options: CandidateGitOptions = {},
): Promise<Buffer> {
  const result = await spawnBoundedGit(cwd, args, {
    stdoutMaxBytes: candidateGitMetadataMaxBytes,
    stderrMaxBytes: candidateGitStderrMaxBytes,
    ...options,
  });
  if (
    result.spawnError
    || result.terminationError
    || result.stdoutTruncated
    || result.stderrTruncated
    || result.exitCode !== 0
  ) {
    throwDelivery("DELIVERY_REJECTED", candidateRejectedMessage);
  }
  return result.stdout;
}

async function candidateGitLine(
  cwd: string,
  args: readonly string[],
  options: CandidateGitOptions = {},
): Promise<string> {
  const raw = await runCandidateGit(cwd, args, options);
  const value = raw.toString("utf8");
  if (
    !Buffer.from(value, "utf8").equals(raw)
    || !value.endsWith("\n")
    || value.includes("\r")
    || value.slice(0, -1).includes("\n")
  ) {
    throw new Error("Candidate Git output is malformed.");
  }
  return value.slice(0, -1);
}

async function candidateGitCommit(
  cwd: string,
  args: readonly string[],
  options: CandidateGitOptions = {},
): Promise<string> {
  const commit = await candidateGitLine(cwd, args, options);
  if (!isCanonicalLowercaseHex(commit, 40)) throw new Error("Candidate Git object ID is malformed.");
  return commit;
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
      env: sanitizedGitEnvironment(),
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
  constructor(private readonly options: GitChangesetServiceOptions) {
    if (options.maxFullPatchBytes !== undefined) {
      assertPositiveSafeInteger(options.maxFullPatchBytes, "maxFullPatchBytes");
    }
  }

  async getChangeset(node: CanvasNode): Promise<Changeset> {
    try {
      const repoRoot = await this.resolveRepoRoot(node);
      await assertGitWorktree(repoRoot);
      const snapshot = await this.collect(repoRoot, { kind: "current-head" });
      return this.changesetFor(node, snapshot);
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
      const snapshot = await this.collect(repoRoot, { kind: "ref", ref: baselineRef });
      const changeset = this.changesetFor(input.node, snapshot);
      const mismatches = mismatchAgainstLiveChanges(input.liveChanges, snapshot.files);
      return {
        status: mismatches.length > 0 ? "mismatch" : snapshot.files.length === 0 ? "empty" : "available",
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
      const repoRoot = await realpath(worktree.realPath);
      await assertGitWorktree(repoRoot);
      const snapshot = await this.collect(repoRoot, {
        kind: "committed",
        baseCommit: worktree.baseCommit,
        headCommit: worktree.headCommit,
      });
      return {
        ...this.evidenceFor(
          worktreeNode,
          snapshot.files.length === 0 ? "empty" : "available",
          snapshot.files,
          snapshot.diffStat,
          snapshot.previewTruncated,
          snapshot,
        ),
        worktreeId: worktree.worktreeId,
      };
    } catch (error) {
      return {
        ...this.evidenceFor(worktreeNode, "failed", [], { added: 0, changed: 0, deleted: 0 }, false),
        worktreeId: worktree.worktreeId,
        errorReason: boundedReason(errorMessage(error)),
      };
    }
  }

  private async resolveRepoRoot(node: CanvasNode): Promise<string> {
    const candidate = isAbsolute(node.worktree.path)
      ? node.worktree.path
      : this.options.repoRoot ?? resolve(process.cwd(), node.worktree.path);
    return realpath(candidate);
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
    snapshot?: AtomicGitChangesetSnapshot,
  ): ChangesetEvidence {
    const digest = snapshot?.fullPatchSha256
      && snapshot.fileManifestSha256
      && snapshot.fullPatchByteLength > 0
      && status === "available"
      && files.length > 0
      ? {
          fullPatchSha256: snapshot.fullPatchSha256,
          fullPatchByteLength: snapshot.fullPatchByteLength,
          fileManifestSha256: snapshot.fileManifestSha256,
        }
      : {};
    return {
      evidenceId: `changeset-evidence-${node.changesetId}`,
      changesetId: node.changesetId,
      source: "git",
      status,
      files,
      diffStat,
      patchPreviewTruncated,
      collectedAt: new Date().toISOString(),
      ...digest,
    };
  }

  private async collect(
    repoRoot: string,
    baseline: GitChangesetBaseline,
  ): Promise<AtomicGitChangesetSnapshot> {
    return collectAtomicGitChangesetSnapshot({
      repoRoot,
      baseline,
      maxPatchPreviewBytes: this.options.maxPatchPreviewBytes ?? defaultMaxPatchPreviewBytes,
      maxFullPatchBytes: this.options.maxFullPatchBytes ?? DEFAULT_MAX_FULL_PATCH_BYTES,
    });
  }

  private changesetFor(node: CanvasNode, snapshot: AtomicGitChangesetSnapshot): Changeset {
    const status = snapshot.files.length === 0 ? "empty" : "available";
    return {
      id: node.changesetId,
      files: snapshot.files,
      diffStat: snapshot.diffStat,
      patchPreview: snapshot.patchPreview,
      source: "git",
      evidence: this.evidenceFor(
        node,
        status,
        snapshot.files,
        snapshot.diffStat,
        snapshot.previewTruncated,
        snapshot,
      ),
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

function isFullCommitSha(value: string): boolean {
  return /^[0-9a-fA-F]{40}$/.test(value);
}

async function commitObjectExists(cwd: string, commit: string): Promise<boolean> {
  const result = await runGit(cwd, ["rev-parse", "--verify", `${commit}^{commit}`], { allowFailure: true });
  return result.exitCode === 0 && result.stdout.toLowerCase() === commit.toLowerCase();
}

async function resolveRollbackWorktreeContext(input: RollbackWorktreeInput): Promise<
  | { ok: true; repoRoot: string; worktreePath: string }
  | { ok: false; result: RollbackWorktreeManualRepairState }
> {
  let repoRoot = "";
  let worktreePath = "";
  try {
    repoRoot = await assertGitRepo(input.projectRoot);
    worktreePath = await realpath(input.worktreePath);
    const managedRoot = await realpath(resolve(dirname(repoRoot), `${basename(repoRoot)}.worktrees`));
    assertPathInside(worktreePath, managedRoot, "rollback worktree path");
  } catch {
    return {
      ok: false,
      result: rollbackManualRepair("unmanaged_worktree", "Rollback requires a SkyTurn-managed worktree."),
    };
  }
  return { ok: true, repoRoot, worktreePath };
}

async function findListedRollbackWorktree(repoRoot: string, worktreePath: string): Promise<
  | { ok: true; entry: GitWorktreeListEntry }
  | { ok: false; result: RollbackWorktreeManualRepairState }
> {
  try {
    return { ok: true, entry: await findListedWorktree(repoRoot, worktreePath) };
  } catch {
    return {
      ok: false,
      result: rollbackManualRepair("unmanaged_worktree", "Rollback worktree is not listed by git.", {
        worktreePath,
      }),
    };
  }
}

function rollbackManualRepair(
  reasonCode: RollbackWorktreeManualRepairReasonCode,
  message: string,
  facts: Partial<Pick<RollbackWorktreeManualRepairState, "worktreePath" | "branchName" | "headCommit" | "restoreCommitRef">> = {},
): RollbackWorktreeManualRepairState {
  return {
    status: "manual_repair_required",
    reasonCode,
    message,
    manualRepairRequired: true,
    ...(facts.worktreePath ? { worktreePath: facts.worktreePath } : {}),
    ...(facts.branchName ? { branchName: facts.branchName } : {}),
    ...(facts.headCommit ? { headCommit: facts.headCommit } : {}),
    ...(facts.restoreCommitRef ? { restoreCommitRef: facts.restoreCommitRef } : {}),
  };
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
  const status = (await runGit(cwd, [
    "status",
    "--porcelain=v1",
    "--untracked-files=all",
    "--",
    ...skyturnGitEvidencePathspecs,
  ])).stdout;
  if (status.trim()) throw new Error(`${label} has uncommitted changes.`);
}

async function checkoutTargetBranch(repoRoot: string, branchName: string): Promise<void> {
  const current = await currentBranch(repoRoot);
  if (current === branchName) return;
  await runGit(repoRoot, ["switch", "--", branchName]);
}

async function prepareAdoptionCandidate(
  repoRoot: string,
  adoption: WorkflowVariantAdoption,
): Promise<string> {
  const temporaryRoot = await mkdtemp(join(tmpdir(), "skyturn-adoption-candidate-"));
  const candidatePath = join(temporaryRoot, "worktree");
  let added = false;
  try {
    await chmod(temporaryRoot, 0o700);
    await runGit(repoRoot, ["worktree", "add", "--detach", candidatePath, adoption.baseCommit]);
    added = true;
    await applyAdoption(candidatePath, adoption);
    return currentHead(candidatePath);
  } finally {
    if (added) {
      await abortAdoption(candidatePath);
      await runGit(repoRoot, ["worktree", "remove", "--force", "--", candidatePath]);
    }
    await rm(temporaryRoot, { recursive: true, force: true });
  }
}

async function applyAdoption(repoRoot: string, adoption: WorkflowVariantAdoption): Promise<void> {
  if (adoption.strategy === "merge") {
    await runGit(repoRoot, ["merge", "--ff-only", adoption.headCommit]);
    return;
  }
  await runGit(repoRoot, ["cherry-pick", adoption.headCommit]);
}

async function withLockedFreshWorktreeHeads<T>(
  repoRoot: string,
  worktrees: readonly WorkflowWorktreeIdentity[],
  operation: () => Promise<T>,
): Promise<T> {
  const expectedRefs = new Map<string, string>();
  for (const worktree of worktrees) {
    const ref = `refs/heads/${worktree.branchName}`;
    const existing = expectedRefs.get(ref);
    if (existing && existing !== worktree.headCommit) {
      throw new Error("Conflicting expected worktree HEADs.");
    }
    expectedRefs.set(ref, worktree.headCommit);
  }
  if (expectedRefs.size === 0) throw new Error("At least one fresh worktree is required for adoption.");

  const child = spawn("git", ["-C", repoRoot, "update-ref", "--stdin"], {
    env: sanitizedGitEnvironment(),
    stdio: ["pipe", "pipe", "pipe"],
  });
  child.stdout.setEncoding("utf8");
  child.stderr.resume();
  child.stdin.on("error", () => undefined);
  const lines = createInterface({ input: child.stdout, crlfDelay: Number.POSITIVE_INFINITY });
  const iterator = lines[Symbol.asyncIterator]();
  const closePromise = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolve, reject) => {
    child.once("error", reject);
    child.once("close", (code, signal) => resolve({ code, signal }));
  });
  let prepared = false;
  let operationCompleted = false;
  let operationError: unknown;
  try {
    child.stdin.write("start\n");
    for (const [ref, headCommit] of expectedRefs) {
      child.stdin.write(`verify ${ref} ${headCommit}\n`);
    }
    child.stdin.write("prepare\n");
    await expectUpdateRefResponse(iterator, "start: ok");
    await expectUpdateRefResponse(iterator, "prepare: ok");
    prepared = true;
    const result = await operation();
    operationCompleted = true;
    return result;
  } catch (error) {
    operationError = error;
    throw error;
  } finally {
    try {
      if (prepared) {
        child.stdin.write("abort\n");
        await expectUpdateRefResponse(iterator, "abort: ok");
      }
      child.stdin.end();
      const closed = await closePromise;
      if (closed.code !== 0 || closed.signal !== null) {
        throw new Error("Git worktree freshness lock failed.");
      }
    } catch (error) {
      child.kill("SIGKILL");
      await closePromise.catch(() => undefined);
      if (!operationCompleted && operationError === undefined) throw error;
    } finally {
      lines.close();
    }
  }
}

async function expectUpdateRefResponse(
  iterator: AsyncIterator<string>,
  expected: string,
): Promise<void> {
  const next = await iterator.next();
  if (next.done || next.value !== expected) {
    throw new Error("Git worktree freshness lock failed.");
  }
}

async function assertTargetHeadMatchesBase(repoRoot: string, adoption: WorkflowVariantAdoption): Promise<void> {
  const targetHead = await currentHead(repoRoot);
  if (targetHead !== adoption.baseCommit) {
    throw new AdoptionTargetBaseMismatchError(adoption.targetBranchName, adoption.baseCommit, targetHead);
  }
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
      env: sanitizedGitEnvironment(),
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
        exitCode: typeof failure.code === "number" ? failure.code : (options.unknownFailureExitCode ?? 1),
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
  const requestedRoot = await realpath(repoRoot);
  const result = await git(requestedRoot, ["rev-parse", "--is-inside-work-tree", "--show-toplevel"]);
  const [insideWorktree, reportedRoot] = result.stdout.trim().split(/\r?\n/, 2);
  if (insideWorktree !== "true") throw new Error("Path is not inside a git worktree.");
  if (!reportedRoot || await realpath(reportedRoot) !== requestedRoot) {
    throw new Error("Path must be the git worktree top-level directory.");
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

function boundedReason(reason: string): string {
  const maxLength = 1000;
  if (reason.length <= maxLength) return reason;
  return `${reason.slice(0, maxLength).trimEnd()}...`;
}

function assertPositiveSafeInteger(value: number, name: string): void {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new TypeError(`${name} must be a positive safe integer.`);
  }
}

async function git(
  cwd: string,
  args: string[],
  options: { maxBytes?: number; allowExitCodes?: number[] } = {},
): Promise<{ stdout: string; truncated: boolean }> {
  const maxBytes = options.maxBytes ?? defaultMaxGitOutputBytes;
  const allowExitCodes = new Set([0, ...(options.allowExitCodes ?? [])]);
  const result = await spawnBoundedGit(cwd, args, {
    stdoutMaxBytes: maxBytes,
    stderrMaxBytes: defaultMaxGitOutputBytes,
  });
  const stdout = result.stdout.toString("utf8");
  const stderr = result.stderr.toString("utf8");
  if (result.spawnError) {
    throw new Error(result.spawnError.message || `git ${args[0]} failed to spawn.`);
  }
  if (result.terminationError) {
    throw new Error(result.terminationError.message || `git ${args[0]} failed to terminate after exceeding the output limit.`);
  }
  if (result.stderrTruncated) {
    throw new Error(`git ${args[0]} stderr exceeded the git output limit.`);
  }
  if (!allowExitCodes.has(result.exitCode ?? -1) && !result.stdoutTruncated) {
    throw new Error(stderr.trim() || `git ${args[0]} failed with exit code ${result.exitCode ?? "unknown"}.`);
  }
  return { stdout, truncated: result.stdoutTruncated };
}
