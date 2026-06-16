import { execFile } from "node:child_process";
import { mkdir, readFile, realpath, stat } from "node:fs/promises";
import { basename, dirname, join, resolve, sep } from "node:path";
import { promisify } from "node:util";

import type {
  CanvasNode,
  ChangesetEvidence,
  WorkflowVariantAdoption,
  WorkflowWorktreeIdentity,
  WorktreeMetadata,
} from "@skyturn/project-core";

import type {
  ChangesetEvidenceInput,
  ChangesetEvidenceService,
  ManagedWorktreeCleanupInput,
  ManagedWorktreeCleanupResult,
  ManagedWorktreeCreateInput,
  ManagedWorktreeService,
  VariantComparisonEvidence,
  VariantComparisonInput,
  VariantAdoptionService,
} from "./index";

export type ManagedWorktreeWorkflowEventKind =
  | "workflow.worktree.create_requested"
  | "workflow.worktree.created"
  | "workflow.worktree.create_failed"
  | "workflow.worktree.clean_requested"
  | "workflow.worktree.cleaned"
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
}

const execFileAsync = promisify(execFile);
const gitOutputLimit = 8 * 1024 * 1024;
const patchPreviewLimit = 24 * 1024;

export class GitCommandError extends Error {
  readonly stderr: string;

  constructor(message: string, stderr: string) {
    super(message);
    this.name = "GitCommandError";
    this.stderr = stderr;
  }
}

export class NodeGitWorktreeService implements ManagedWorktreeService, VariantAdoptionService, ChangesetEvidenceService {
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
    const plan = await this.planCreate(input);
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
      await this.record("workflow.worktree.create_failed", {
        ...eventPlan(plan),
        status: "failed",
        reason: errorMessage(error),
      }, `worktree:${plan.worktreeId}:create-failed`, plan.sessionId);
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
    const expectedHead = options.expectedHeadCommit ?? worktree.headCommit;
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
    return {
      comparisonId: `comparison-${left.variantId}-${right.variantId}-${collectedAt}`,
      collectedAt,
      variants: [
        {
          variantId: left.variantId,
          worktreeId: left.worktreeId,
          changeset: await this.collectChangesetEvidence({ node: minimalNode(left), worktree: left }),
        },
        {
          variantId: right.variantId,
          worktreeId: right.worktreeId,
          changeset: await this.collectChangesetEvidence({ node: minimalNode(right), worktree: right }),
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
      return failed;
    }
  }

  async cleanManagedWorktree(input: ManagedWorktreeCleanupInput): Promise<ManagedWorktreeCleanupResult> {
    if (input.deleteBranch) {
      validateBranchName(input.worktree.branchName, { requireSkyTurnPrefix: true });
    }
    if (await this.runState.hasRunningTasks(input.worktree)) {
      throw new Error(`Cannot clean ${input.worktree.worktreeId}: running tasks still target this worktree.`);
    }
    const eventWorktree = this.findCreatedWorktree(input.worktree.worktreeId);
    if (!eventWorktree) throw new Error(`No created worktree event for ${input.worktree.worktreeId}.`);
    verifyCleanupRecord(input.worktree, eventWorktree);
    const worktree = await this.reconcileManagedWorktree(eventWorktree, { expectedHeadCommit: input.worktree.headCommit });
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
  }

  async collectChangesetEvidence(input: ChangesetEvidenceInput): Promise<ChangesetEvidence> {
    const worktree = input.worktree ? await this.reconcileManagedWorktree(input.worktree) : null;
    const cwd = worktree?.realPath ?? input.node.worktree.path;
    try {
      const diffRange = worktree ? [`${worktree.baseCommit}..${worktree.headCommit}`] : [];
      const files = stringLines((await runGit(cwd, ["diff", "--name-only", ...diffRange, "--"])).stdout);
      const numstat = (await runGit(cwd, ["diff", "--numstat", ...diffRange, "--"])).stdout;
      const patch = (await runGit(cwd, ["diff", ...diffRange, "--"], { maxBuffer: gitOutputLimit })).stdout;
      const diffStat = parseNumstat(numstat);
      return {
        evidenceId: `changeset-evidence-${worktree?.worktreeId ?? input.node.id}`,
        changesetId: input.node.changesetId,
        source: "git",
        status: files.length === 0 ? "empty" : "available",
        files,
        diffStat,
        patchPreviewTruncated: patch.length > patchPreviewLimit,
        ...(worktree ? { worktreeId: worktree.worktreeId } : {}),
        collectedAt: this.now(),
      };
    } catch (error) {
      return {
        evidenceId: `changeset-evidence-${worktree?.worktreeId ?? input.node.id}`,
        changesetId: input.node.changesetId,
        source: "git",
        status: "failed",
        files: [],
        diffStat: { added: 0, changed: 0, deleted: 0 },
        patchPreviewTruncated: false,
        ...(worktree ? { worktreeId: worktree.worktreeId } : {}),
        collectedAt: this.now(),
        errorReason: errorMessage(error),
      };
    }
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

  private findCreatedWorktree(worktreeId: string): WorkflowWorktreeIdentity | null {
    for (let index = this.eventLog.length - 1; index >= 0; index -= 1) {
      const event = this.eventLog[index];
      if (event?.kind !== "workflow.worktree.created") continue;
      const worktree = event.payload.worktree;
      if (isWorktreeIdentity(worktree) && worktree.worktreeId === worktreeId) return worktree;
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

async function validateSkyTurnBranch(repoRoot: string, branchName: string): Promise<void> {
  validateBranchName(branchName, { requireSkyTurnPrefix: true });
  await runGit(repoRoot, ["check-ref-format", "--branch", branchName]);
}

async function validateTargetBranch(repoRoot: string, branchName: string): Promise<void> {
  validateBranchName(branchName, { requireSkyTurnPrefix: false });
  await runGit(repoRoot, ["rev-parse", "--verify", `refs/heads/${branchName}^{commit}`]);
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
  const status = (await runGit(cwd, ["status", "--porcelain=v1", "--"])).stdout;
  if (status.trim()) throw new Error(`${label} has uncommitted changes.`);
}

async function checkoutTargetBranch(repoRoot: string, branchName: string): Promise<void> {
  const current = await currentBranch(repoRoot);
  if (current === branchName) return;
  await runGit(repoRoot, ["switch", "--", branchName]);
}

async function previewAdoption(repoRoot: string, adoption: WorkflowVariantAdoption): Promise<void> {
  if (adoption.strategy === "merge") {
    await runGit(repoRoot, ["merge", "--no-commit", "--no-ff", adoption.headCommit]);
    await abortAdoption(repoRoot);
    return;
  }
  await runGit(repoRoot, ["cherry-pick", "--no-commit", adoption.headCommit]);
  await abortAdoption(repoRoot);
}

async function applyAdoption(repoRoot: string, adoption: WorkflowVariantAdoption): Promise<void> {
  if (adoption.strategy === "merge") {
    await runGit(repoRoot, ["merge", "--ff-only", adoption.headCommit]);
    return;
  }
  await runGit(repoRoot, ["cherry-pick", adoption.headCommit]);
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

function eventPlan(plan: ManagedWorktreePlan): Record<string, unknown> {
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

function safeId(value: string, field: string): string {
  if (!/^[A-Za-z0-9._-]+$/.test(value)) {
    throw new Error(`${field} must contain only letters, numbers, dot, underscore, or dash.`);
  }
  return value;
}

function assertPathInside(path: string, root: string, label: string): void {
  if (path !== root && !path.startsWith(`${root}${sep}`)) {
    throw new Error(`${label} escapes the SkyTurn managed worktree root.`);
  }
}

function assertSamePath(left: string, right: string, label: string): void {
  if (resolve(left) !== resolve(right)) throw new Error(`${label} mismatch: expected ${right}, got ${left}.`);
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

function errorMessage(error: unknown): string {
  if (error instanceof GitCommandError && error.stderr) return truncate(error.stderr);
  if (error instanceof Error) return truncate(error.message);
  return truncate(String(error));
}

function truncate(value: string): string {
  return value.length > 1200 ? `${value.slice(0, 1200)}...` : value;
}
