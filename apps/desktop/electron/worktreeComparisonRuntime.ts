import path from "node:path";

import type {
  VariantComparisonEvidence,
  WorktreeComparisonRequest,
} from "@skyturn/git-worktree" with { "resolution-mode": "import" };
import type { WorkflowWorktreeIdentity } from "@skyturn/project-core" with { "resolution-mode": "import" };
import { workflowIpcError } from "./workflowIpcContracts";
import type { WorkflowIpcErrorCode } from "./workflowIpcContracts";

class WorktreeComparisonError extends Error {
  constructor(
    readonly code: WorkflowIpcErrorCode,
    message: string,
  ) {
    super(message);
  }
}

interface WorktreeComparisonStore {
  materializeCanvasSession(sessionId: string): unknown;
  listEvents(sessionId: string): unknown[];
}

interface GitWorktreeComparisonModule {
  parseWorktreeComparisonRequest(value: unknown): WorktreeComparisonRequest;
  parseVariantComparisonEvidence(value: unknown): VariantComparisonEvidence;
  createNodeGitWorktreeService(options?: unknown): {
    compareVariants(input: {
      left: WorkflowWorktreeIdentity;
      right: WorkflowWorktreeIdentity;
    }): Promise<VariantComparisonEvidence>;
  };
}

export interface WorktreeComparisonRuntimeDependencies {
  assertKnownProjectRoot(projectRoot: string): void;
  getWorkflowStore(projectRoot: string): Promise<WorktreeComparisonStore>;
  loadGitWorktreeModule(): Promise<GitWorktreeComparisonModule>;
  canonicalPath(value: string): Promise<string>;
  protocolVersion?: number;
}

export async function compareWorkflowWorktrees(
  dependencies: WorktreeComparisonRuntimeDependencies,
  projectRoot: string,
  input: unknown,
): Promise<{ protocolVersion: number; comparison: VariantComparisonEvidence }> {
  try {
    dependencies.assertKnownProjectRoot(projectRoot);
    const gitWorktree = await dependencies.loadGitWorktreeModule();
    const request = gitWorktree.parseWorktreeComparisonRequest(input);
    const store = await dependencies.getWorkflowStore(projectRoot);
    assertKnownSession(store, request.sessionId);
    const events = store.listEvents(request.sessionId);
    const [left, right] = await Promise.all([
      resolveDurableWorktreeIdentity(dependencies, projectRoot, request.sessionId, request.leftWorktreeId, events),
      resolveDurableWorktreeIdentity(dependencies, projectRoot, request.sessionId, request.rightWorktreeId, events),
    ]);
    const service = gitWorktree.createNodeGitWorktreeService();
    const comparison = sanitizeComparisonEvidence(gitWorktree.parseVariantComparisonEvidence(
      await service.compareVariants({ left, right }),
    ));
    return { protocolVersion: dependencies.protocolVersion ?? 1, comparison };
  } catch (error) {
    if (error instanceof WorktreeComparisonError) {
      throw workflowIpcError(error.code, error.message);
    }
    throw workflowIpcError("INVALID_INPUT", "Worktree comparison failed.");
  }
}

function sanitizeComparisonEvidence(comparison: VariantComparisonEvidence): VariantComparisonEvidence {
  return {
    ...comparison,
    variants: comparison.variants.map((variant) => {
      if (variant.changeset.status !== "failed") return variant;
      return {
        ...variant,
        changeset: {
          ...variant.changeset,
          errorReason: "Git changeset collection failed.",
        },
        metrics: variant.metrics.map((metric) => (
          metric.kind === "diff-summary"
            ? { ...metric, detail: "Git changeset collection failed." }
            : metric
        )),
      };
    }),
  };
}

async function resolveDurableWorktreeIdentity(
  dependencies: WorktreeComparisonRuntimeDependencies,
  projectRoot: string,
  sessionId: string,
  worktreeId: string,
  events: unknown[],
): Promise<WorkflowWorktreeIdentity> {
  let identity: WorkflowWorktreeIdentity | null = null;
  for (const candidate of events) {
    if (!isRecord(candidate)) continue;
    const eventSessionId = optionalString(candidate.sessionId);
    if (eventSessionId && eventSessionId !== sessionId) {
      throw new WorktreeComparisonError("INVALID_INPUT", "Worktree ledger event belongs to another session.");
    }
    if (candidate.kind === "workflow.worktree.cleaned" && worktreeIdFromPayload(candidate.payload) === worktreeId) {
      identity = null;
      continue;
    }
    if (candidate.kind !== "workflow.worktree.created" && candidate.kind !== "workflow.worktree.reconciled") continue;
    if (!isRecord(candidate.payload) || !isRecord(candidate.payload.worktree)) continue;
    if (candidate.payload.worktree.worktreeId !== worktreeId) continue;
    identity = parseCompleteWorktreeIdentity(candidate.payload.worktree);
  }
  if (!identity) {
    throw new WorktreeComparisonError("INVALID_INPUT", "Worktree identity is not available in this workflow session.");
  }
  await assertProjectWorktreeIdentity(dependencies, projectRoot, identity);
  return identity;
}

function parseCompleteWorktreeIdentity(value: Record<string, unknown>): WorkflowWorktreeIdentity {
  const required = [
    "worktreeId",
    "variantId",
    "path",
    "realPath",
    "gitdir",
    "repoRoot",
    "branchName",
    "baseCommit",
    "headCommit",
    "parentLaneId",
  ] as const;
  if (required.some((field) => !optionalString(value[field]))) {
    throw new WorktreeComparisonError("INVALID_INPUT", "Worktree ledger identity is incomplete.");
  }
  const parentSegmentId = optionalString(value.parentSegmentId);
  return {
    worktreeId: value.worktreeId as string,
    variantId: value.variantId as string,
    path: value.path as string,
    realPath: value.realPath as string,
    gitdir: value.gitdir as string,
    repoRoot: value.repoRoot as string,
    branchName: value.branchName as string,
    baseCommit: value.baseCommit as string,
    headCommit: value.headCommit as string,
    parentLaneId: value.parentLaneId as string,
    ...(parentSegmentId ? { parentSegmentId } : {}),
  };
}

async function assertProjectWorktreeIdentity(
  dependencies: WorktreeComparisonRuntimeDependencies,
  projectRoot: string,
  identity: WorkflowWorktreeIdentity,
): Promise<void> {
  const [canonicalProjectRoot, canonicalRepoRoot] = await Promise.all([
    dependencies.canonicalPath(projectRoot),
    dependencies.canonicalPath(identity.repoRoot),
  ]);
  if (canonicalRepoRoot !== canonicalProjectRoot) {
    throw new WorktreeComparisonError("UNKNOWN_PROJECT", "Worktree identity belongs to another project.");
  }
  const [canonicalPath, canonicalRealPath] = await Promise.all([
    dependencies.canonicalPath(identity.path),
    dependencies.canonicalPath(identity.realPath),
  ]);
  const managedRoot = path.resolve(`${canonicalProjectRoot}.worktrees`);
  if (canonicalPath !== canonicalRealPath || !isInsidePath(managedRoot, canonicalRealPath)) {
    throw new WorktreeComparisonError("INVALID_INPUT", "Worktree identity is outside the managed project worktrees.");
  }
}

function assertKnownSession(store: WorktreeComparisonStore, sessionId: string): void {
  const session = store.materializeCanvasSession(sessionId);
  if (!isRecord(session) || session.id !== sessionId) {
    throw new WorktreeComparisonError("UNKNOWN_SESSION", "Workflow session is not known.");
  }
}

function worktreeIdFromPayload(value: unknown): string | null {
  if (!isRecord(value)) return null;
  return optionalString(value.worktreeId) ??
    (isRecord(value.worktree) ? optionalString(value.worktree.worktreeId) : null);
}

function isInsidePath(parent: string, candidate: string): boolean {
  const relative = path.relative(parent, candidate);
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}

function optionalString(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value : null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}
