import { createHash } from "node:crypto";
import path from "node:path";

import type {
  VariantComparisonEvidence,
  WorktreeAdoptionRequest,
  WorktreeComparisonRequest,
} from "@skyturn/git-worktree" with { "resolution-mode": "import" };
import type {
  WorkflowVariantAdoption,
  WorkflowVariantComparisonRecordedEvidence,
  WorkflowVariantComparisonSideIdentity,
  WorkflowWorktreeIdentity,
} from "@skyturn/project-core" with { "resolution-mode": "import" };
import { workflowIpcError } from "./workflowIpcContracts";
import type { WorkflowIpcErrorCode } from "./workflowIpcContracts";

class WorktreeMutationError extends Error {
  constructor(
    readonly code: WorkflowIpcErrorCode,
    message: string,
  ) {
    super(message);
  }
}

interface WorktreeWorkflowStore {
  materializeCanvasSession(sessionId: string): unknown;
  listEvents(sessionId: string): unknown[];
  appendWorkflowEvent(input: {
    sessionId: string;
    kind: string;
    source: string;
    idempotencyKey: string;
    payload: Record<string, unknown>;
    now: string;
  }): unknown;
}

interface ManagedWorktreeWorkflowEventLike {
  kind:
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
  source: "git-worktree";
  payload: Record<string, unknown>;
  createdAt: string;
  idempotencyKey: string;
  sessionId?: string;
}

interface GitWorktreeRuntimeModule {
  parseWorktreeComparisonRequest(value: unknown): WorktreeComparisonRequest;
  parseWorktreeAdoptionRequest(value: unknown): WorktreeAdoptionRequest;
  parseVariantComparisonEvidence(value: unknown): VariantComparisonEvidence;
  parseWorkflowVariantComparisonRecordedEvidence(value: unknown): WorkflowVariantComparisonRecordedEvidence;
  createNodeGitWorktreeService(options?: {
    initialEvents?: ManagedWorktreeWorkflowEventLike[];
    eventSink?: {
      append(event: ManagedWorktreeWorkflowEventLike): Promise<void>;
    };
  }): {
    reconcileManagedWorktree(
      worktree: WorkflowWorktreeIdentity,
      options?: { expectedHeadCommit?: string; allowHeadAdvance?: boolean },
    ): Promise<WorkflowWorktreeIdentity>;
    compareVariants(input: {
      left: WorkflowWorktreeIdentity;
      right: WorkflowWorktreeIdentity;
    }): Promise<VariantComparisonEvidence>;
    adoptVariant(
      input: WorkflowVariantAdoption,
      options?: { requiredFreshWorktrees?: readonly WorkflowWorktreeIdentity[] },
    ): Promise<WorkflowVariantAdoption>;
  };
}

export interface WorktreeComparisonRuntimeDependencies {
  assertKnownProjectRoot(projectRoot: string): void;
  getWorkflowStore(projectRoot: string): Promise<WorktreeWorkflowStore>;
  loadGitWorktreeModule(): Promise<GitWorktreeRuntimeModule>;
  canonicalPath(value: string): Promise<string>;
  workflowStoreIdentity(projectRoot: string): Promise<string>;
  withSessionMutationLock<T>(projectRoot: string, sessionId: string, action: () => Promise<T>): Promise<T>;
  broadcastWorkflowProjection?(projectRoot: string, sessionId: string, store: WorktreeWorkflowStore): void;
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
    const projectIdentity = await dependencies.workflowStoreIdentity(projectRoot);
    return await dependencies.withSessionMutationLock(projectIdentity, request.sessionId, async () => {
      const store = await dependencies.getWorkflowStore(projectRoot);
      assertKnownSession(store, request.sessionId);
      const events = store.listEvents(request.sessionId);
      const [durableLeft, durableRight] = await Promise.all([
        resolveDurableWorktreeIdentity(dependencies, projectRoot, request.sessionId, request.leftWorktreeId, events),
        resolveDurableWorktreeIdentity(dependencies, projectRoot, request.sessionId, request.rightWorktreeId, events),
      ]);
      const service = gitWorktree.createNodeGitWorktreeService();
      const [left, right] = await Promise.all([
        reconcileCurrentWorktree(service, durableLeft),
        reconcileCurrentWorktree(service, durableRight),
      ]);
      const leftIdentity = comparisonSideIdentity(left);
      const rightIdentity = comparisonSideIdentity(right);
      const existing = findExactComparisonRecording(
        gitWorktree,
        events,
        request.sessionId,
        leftIdentity,
        rightIdentity,
      );
      if (existing) {
        return { protocolVersion: dependencies.protocolVersion ?? 1, comparison: existing.comparison };
      }

      const comparison = sanitizeComparisonEvidence(gitWorktree.parseVariantComparisonEvidence(
        await service.compareVariants({ left, right }),
      ));
      const recording = gitWorktree.parseWorkflowVariantComparisonRecordedEvidence({
        sessionId: request.sessionId,
        comparison,
        left: leftIdentity,
        right: rightIdentity,
      });
      const idempotencyKey = comparisonIdempotencyKey(recording);
      const appended = store.appendWorkflowEvent({
        sessionId: request.sessionId,
        kind: "workflow.variant.comparison_recorded",
        source: "electron-main",
        idempotencyKey,
        payload: { recording },
        now: recording.comparison.collectedAt,
      });
      const persisted = parseComparisonRecordingEvent(gitWorktree, appended, request.sessionId);
      if (!sameRecording(persisted, recording)) {
        throw new WorktreeMutationError("INVALID_INPUT", "Persisted worktree comparison conflicts with the live comparison.");
      }
      return { protocolVersion: dependencies.protocolVersion ?? 1, comparison: persisted.comparison };
    });
  } catch (error) {
    throw normalizeRuntimeError(error, "Worktree comparison failed.");
  }
}

export async function adoptWorkflowWorktree(
  dependencies: WorktreeComparisonRuntimeDependencies,
  projectRoot: string,
  input: unknown,
): Promise<{
  protocolVersion: number;
  status: "adopted" | "failed";
  event: unknown | null;
  adoption: WorkflowVariantAdoption & { status: "adopted" | "failed" };
}> {
  try {
    dependencies.assertKnownProjectRoot(projectRoot);
    const gitWorktree = await dependencies.loadGitWorktreeModule();
    const request = gitWorktree.parseWorktreeAdoptionRequest(input);
    const projectIdentity = await dependencies.workflowStoreIdentity(projectRoot);
    return await dependencies.withSessionMutationLock(projectIdentity, request.sessionId, async () => {
      const store = await dependencies.getWorkflowStore(projectRoot);
      try {
        const session = assertKnownSession(store, request.sessionId);
        const events = store.listEvents(request.sessionId);
        const terminal = terminalAdoptionRetry(events, request);
        if (terminal) return terminalResponse(dependencies, terminal.event, terminal.adoption);
        if (hasUnresolvedAdoptionRequest(events, request.adoption.adoptionId)) {
          throw new WorktreeMutationError(
            "INVALID_INPUT",
            "Variant adoption has an unresolved durable request and cannot be relaunched.",
          );
        }

        const recording = findRequiredComparisonRecording(gitWorktree, events, request);
        const adoptedSide = recording.left.worktreeId === request.adoption.worktreeId
          ? recording.left
          : recording.right.worktreeId === request.adoption.worktreeId
            ? recording.right
            : null;
        if (!adoptedSide || !adoptionDeclarationMatchesSide(request.adoption, adoptedSide)) {
          throw new WorktreeMutationError("INVALID_INPUT", "Variant adoption does not match the recorded comparison.");
        }
        const targetBranchName = authoritativeTargetBranch(session);
        if (request.adoption.targetBranchName !== targetBranchName) {
          throw new WorktreeMutationError("INVALID_INPUT", "Variant adoption target does not match the workflow session.");
        }

        const [durableLeft, durableRight] = await Promise.all([
          resolveDurableWorktreeIdentity(dependencies, projectRoot, request.sessionId, recording.left.worktreeId, events),
          resolveDurableWorktreeIdentity(dependencies, projectRoot, request.sessionId, recording.right.worktreeId, events),
        ]);
        const appendedEvents: unknown[] = [];
        const service = gitWorktree.createNodeGitWorktreeService({
          initialEvents: managedWorktreeEventsFromStore(events),
          eventSink: {
            append: async (event) => {
              appendedEvents.push(store.appendWorkflowEvent({
                sessionId: event.sessionId ?? request.sessionId,
                kind: event.kind,
                source: event.source,
                idempotencyKey: event.idempotencyKey,
                payload: event.payload,
                now: event.createdAt,
              }));
            },
          },
        });
        const [currentLeft, currentRight] = await Promise.all([
          reconcileCurrentWorktree(service, durableLeft),
          reconcileCurrentWorktree(service, durableRight),
        ]);
        assertFreshComparisonSide(recording.left, currentLeft);
        assertFreshComparisonSide(recording.right, currentRight);

        const authoritativeAdoption: WorkflowVariantAdoption = {
          adoptionId: request.adoption.adoptionId,
          variantId: adoptedSide.variantId,
          worktreeId: adoptedSide.worktreeId,
          strategy: request.adoption.strategy,
          status: "requested",
          baseCommit: adoptedSide.baseCommit,
          headCommit: adoptedSide.headCommit,
          targetBranchName,
        };
        const result = await service.adoptVariant(authoritativeAdoption, {
          requiredFreshWorktrees: [currentLeft, currentRight],
        });
        const terminalResult = requireTerminalAdoptionResult(result, authoritativeAdoption);
        const event = findVariantAdoptionEvent(appendedEvents, result.adoptionId, result.status)
          ?? findVariantAdoptionEvent(store.listEvents(request.sessionId), result.adoptionId, result.status);
        dependencies.broadcastWorkflowProjection?.(projectRoot, request.sessionId, store);
        return terminalResponse(dependencies, event, terminalResult);
      } catch (error) {
        recordVariantAdoptFailure(store, request, error);
        dependencies.broadcastWorkflowProjection?.(projectRoot, request.sessionId, store);
        throw error;
      }
    });
  } catch (error) {
    throw normalizeRuntimeError(error, "Worktree adoption failed.");
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
        metrics: variant.metrics.map((metric) => ({
          ...metric,
          detail: "Git changeset collection failed.",
        })),
      };
    }),
  };
}

async function reconcileCurrentWorktree(
  service: ReturnType<GitWorktreeRuntimeModule["createNodeGitWorktreeService"]>,
  durable: WorkflowWorktreeIdentity,
): Promise<WorkflowWorktreeIdentity> {
  const current = await service.reconcileManagedWorktree(durable, { allowHeadAdvance: true });
  if (
    current.worktreeId !== durable.worktreeId ||
    current.variantId !== durable.variantId ||
    current.branchName !== durable.branchName ||
    current.baseCommit !== durable.baseCommit ||
    current.parentLaneId !== durable.parentLaneId ||
    (current.parentSegmentId ?? null) !== (durable.parentSegmentId ?? null)
  ) {
    throw new WorktreeMutationError("INVALID_INPUT", "Managed worktree identity changed; compare again.");
  }
  return current;
}

function comparisonSideIdentity(worktree: WorkflowWorktreeIdentity): WorkflowVariantComparisonSideIdentity {
  return {
    laneId: worktree.parentLaneId,
    variantId: worktree.variantId,
    worktreeId: worktree.worktreeId,
    branchName: worktree.branchName,
    baseCommit: worktree.baseCommit,
    headCommit: worktree.headCommit,
  };
}

function findExactComparisonRecording(
  gitWorktree: GitWorktreeRuntimeModule,
  events: unknown[],
  sessionId: string,
  left: WorkflowVariantComparisonSideIdentity,
  right: WorkflowVariantComparisonSideIdentity,
): WorkflowVariantComparisonRecordedEvidence | null {
  for (let index = events.length - 1; index >= 0; index -= 1) {
    const event = events[index];
    if (!isRecord(event) || event.kind !== "workflow.variant.comparison_recorded") continue;
    const recording = parseComparisonRecordingEvent(gitWorktree, event, sessionId);
    if (sameSide(recording.left, left) && sameSide(recording.right, right)) return recording;
  }
  return null;
}

function findRequiredComparisonRecording(
  gitWorktree: GitWorktreeRuntimeModule,
  events: unknown[],
  request: WorktreeAdoptionRequest,
): WorkflowVariantComparisonRecordedEvidence {
  for (let index = events.length - 1; index >= 0; index -= 1) {
    const event = events[index];
    if (!isRecord(event) || event.kind !== "workflow.variant.comparison_recorded") continue;
    const recording = parseComparisonRecordingEvent(gitWorktree, event, request.sessionId);
    if (request.comparisonId !== undefined) {
      if (recording.comparison.comparisonId === request.comparisonId) return recording;
      continue;
    }
    if (
      recording.left.worktreeId === request.adoption.worktreeId ||
      recording.right.worktreeId === request.adoption.worktreeId
    ) return recording;
  }
  throw new WorktreeMutationError("INVALID_INPUT", "A fresh variant comparison is required before adoption.");
}

function parseComparisonRecordingEvent(
  gitWorktree: GitWorktreeRuntimeModule,
  value: unknown,
  sessionId: string,
): WorkflowVariantComparisonRecordedEvidence {
  if (
    !isRecord(value) ||
    value.kind !== "workflow.variant.comparison_recorded" ||
    value.sessionId !== sessionId ||
    value.source !== "electron-main" ||
    !isRecord(value.payload) ||
    Object.keys(value.payload).length !== 1 ||
    !Object.prototype.hasOwnProperty.call(value.payload, "recording")
  ) {
    throw new WorktreeMutationError("INVALID_INPUT", "Persisted variant comparison is malformed.");
  }
  const recording = gitWorktree.parseWorkflowVariantComparisonRecordedEvidence(value.payload.recording);
  if (recording.sessionId !== sessionId) {
    throw new WorktreeMutationError("INVALID_INPUT", "Persisted variant comparison belongs to another session.");
  }
  return recording;
}

function comparisonIdempotencyKey(recording: WorkflowVariantComparisonRecordedEvidence): string {
  const authority = JSON.stringify({
    sessionId: recording.sessionId,
    left: recording.left,
    right: recording.right,
  });
  return `variant-comparison:${createHash("sha256").update(authority, "utf8").digest("hex")}`;
}

function sameRecording(
  left: WorkflowVariantComparisonRecordedEvidence,
  right: WorkflowVariantComparisonRecordedEvidence,
): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

function sameSide(
  left: WorkflowVariantComparisonSideIdentity,
  right: WorkflowVariantComparisonSideIdentity,
): boolean {
  return left.laneId === right.laneId &&
    left.variantId === right.variantId &&
    left.worktreeId === right.worktreeId &&
    left.branchName === right.branchName &&
    left.baseCommit === right.baseCommit &&
    left.headCommit === right.headCommit;
}

function assertFreshComparisonSide(
  recorded: WorkflowVariantComparisonSideIdentity,
  current: WorkflowWorktreeIdentity,
): void {
  if (!sameSide(recorded, comparisonSideIdentity(current))) {
    throw new WorktreeMutationError(
      "INVALID_INPUT",
      "Variant comparison is stale because a worktree identity or HEAD changed; compare again.",
    );
  }
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
      throw new WorktreeMutationError("INVALID_INPUT", "Worktree ledger event belongs to another session.");
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
    throw new WorktreeMutationError("INVALID_INPUT", "Worktree identity is not available in this workflow session.");
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
    throw new WorktreeMutationError("INVALID_INPUT", "Worktree ledger identity is incomplete.");
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
    throw new WorktreeMutationError("UNKNOWN_PROJECT", "Worktree identity belongs to another project.");
  }
  const [canonicalPath, canonicalRealPath] = await Promise.all([
    dependencies.canonicalPath(identity.path),
    dependencies.canonicalPath(identity.realPath),
  ]);
  const managedRoot = path.resolve(`${canonicalProjectRoot}.worktrees`);
  if (canonicalPath !== canonicalRealPath || !isInsidePath(managedRoot, canonicalRealPath)) {
    throw new WorktreeMutationError("INVALID_INPUT", "Worktree identity is outside the managed project worktrees.");
  }
}

function assertKnownSession(store: WorktreeWorkflowStore, sessionId: string): Record<string, unknown> {
  const session = store.materializeCanvasSession(sessionId);
  if (!isRecord(session) || session.id !== sessionId) {
    throw new WorktreeMutationError("UNKNOWN_SESSION", "Workflow session is not known.");
  }
  return session;
}

function authoritativeTargetBranch(session: Record<string, unknown>): string {
  if (!isRecord(session.target)) {
    throw new WorktreeMutationError("INVALID_INPUT", "Workflow session target is unavailable.");
  }
  const branch = optionalString(session.target.selectedBranch);
  if (!branch || branch === "HEAD") {
    throw new WorktreeMutationError("INVALID_INPUT", "Workflow session target branch is unresolved.");
  }
  return branch;
}

function adoptionDeclarationMatchesSide(
  adoption: WorkflowVariantAdoption,
  side: WorkflowVariantComparisonSideIdentity,
): boolean {
  return adoption.variantId === side.variantId &&
    adoption.worktreeId === side.worktreeId &&
    adoption.baseCommit === side.baseCommit &&
    adoption.headCommit === side.headCommit;
}

function terminalAdoptionRetry(
  events: unknown[],
  request: WorktreeAdoptionRequest,
): { event: unknown; adoption: WorkflowVariantAdoption & { status: "adopted" | "failed" } } | null {
  for (let index = events.length - 1; index >= 0; index -= 1) {
    const event = events[index];
    if (!isRecord(event) || (event.kind !== "workflow.variant.adopted" && event.kind !== "workflow.variant.adopt_failed")) continue;
    if (!isRecord(event.payload) || !isRecord(event.payload.adoption)) continue;
    if (event.payload.adoption.adoptionId !== request.adoption.adoptionId) continue;
    const status = event.kind === "workflow.variant.adopted" ? "adopted" : "failed";
    if (status === "failed" && event.source !== "git-worktree") return null;
    const adoption = event.payload.adoption;
    if (
      adoption.variantId !== request.adoption.variantId ||
      adoption.worktreeId !== request.adoption.worktreeId ||
      adoption.strategy !== request.adoption.strategy ||
      adoption.baseCommit !== request.adoption.baseCommit ||
      adoption.headCommit !== request.adoption.headCommit ||
      adoption.targetBranchName !== request.adoption.targetBranchName ||
      adoption.status !== status
    ) {
      throw new WorktreeMutationError("INVALID_INPUT", "Variant adoption id conflicts with durable terminal evidence.");
    }
    return { event, adoption: adoption as unknown as WorkflowVariantAdoption & { status: "adopted" | "failed" } };
  }
  return null;
}

function hasUnresolvedAdoptionRequest(events: unknown[], adoptionId: string): boolean {
  const requested = events.some((event) => isRecord(event) &&
    event.kind === "workflow.variant.adopt_requested" &&
    isRecord(event.payload) &&
    isRecord(event.payload.adoption) &&
    event.payload.adoption.adoptionId === adoptionId);
  if (!requested) return false;
  return !events.some((event) => isRecord(event) &&
    (event.kind === "workflow.variant.adopted" || event.kind === "workflow.variant.adopt_failed") &&
    isRecord(event.payload) &&
    isRecord(event.payload.adoption) &&
    event.payload.adoption.adoptionId === adoptionId);
}

function requireTerminalAdoptionResult(
  result: WorkflowVariantAdoption,
  expected: WorkflowVariantAdoption,
): WorkflowVariantAdoption & { status: "adopted" | "failed" } {
  if (
    (result.status !== "adopted" && result.status !== "failed") ||
    result.adoptionId !== expected.adoptionId ||
    result.variantId !== expected.variantId ||
    result.worktreeId !== expected.worktreeId ||
    result.strategy !== expected.strategy ||
    result.baseCommit !== expected.baseCommit ||
    result.headCommit !== expected.headCommit ||
    result.targetBranchName !== expected.targetBranchName
  ) {
    throw new WorktreeMutationError("INVALID_INPUT", "Variant adoption service returned conflicting evidence.");
  }
  return result as WorkflowVariantAdoption & { status: "adopted" | "failed" };
}

function terminalResponse(
  dependencies: WorktreeComparisonRuntimeDependencies,
  event: unknown,
  adoption: WorkflowVariantAdoption & { status: "adopted" | "failed" },
) {
  return {
    protocolVersion: dependencies.protocolVersion ?? 1,
    status: adoption.status,
    event: event ?? null,
    adoption,
  };
}

function recordVariantAdoptFailure(
  store: WorktreeWorkflowStore,
  request: WorktreeAdoptionRequest,
  error: unknown,
): void {
  const reason = publicFailureReason(error);
  store.appendWorkflowEvent({
    sessionId: request.sessionId,
    kind: "workflow.variant.adopt_failed",
    source: "electron-main",
    idempotencyKey: `variant:${request.adoption.adoptionId}:adopt-failed`,
    payload: {
      adoption: {
        ...request.adoption,
        status: "failed",
        failureReason: reason,
      },
    },
    now: new Date().toISOString(),
  });
}

function publicFailureReason(error: unknown): string {
  if (error instanceof WorktreeMutationError) return error.message;
  return "Worktree adoption failed.";
}

function normalizeRuntimeError(error: unknown, fallback: string): Error {
  if (error instanceof WorktreeMutationError) return workflowIpcError(error.code, error.message);
  return workflowIpcError("INVALID_INPUT", fallback);
}

function managedWorktreeEventsFromStore(events: unknown[]): ManagedWorktreeWorkflowEventLike[] {
  const managedEvents: ManagedWorktreeWorkflowEventLike[] = [];
  for (const event of events) {
    if (!isRecord(event) || !isManagedWorktreeEventKind(event.kind)) continue;
    const idempotencyKey = optionalString(event.idempotencyKey);
    if (!idempotencyKey || !isRecord(event.payload)) continue;
    const eventSessionId = optionalString(event.sessionId);
    managedEvents.push({
      kind: event.kind,
      source: "git-worktree",
      payload: event.payload,
      createdAt: optionalString(event.createdAt) ?? new Date().toISOString(),
      idempotencyKey,
      ...(eventSessionId ? { sessionId: eventSessionId } : {}),
    });
  }
  return managedEvents;
}

function isManagedWorktreeEventKind(kind: unknown): kind is ManagedWorktreeWorkflowEventLike["kind"] {
  return kind === "workflow.worktree.create_requested" ||
    kind === "workflow.worktree.created" ||
    kind === "workflow.worktree.create_failed" ||
    kind === "workflow.worktree.clean_requested" ||
    kind === "workflow.worktree.cleaned" ||
    kind === "workflow.worktree.clean_failed" ||
    kind === "workflow.variant.adopt_requested" ||
    kind === "workflow.variant.adopted" ||
    kind === "workflow.variant.adopt_failed" ||
    kind === "workflow.variant.rejected";
}

function findVariantAdoptionEvent(events: unknown[], adoptionId: string, status: string): unknown | null {
  const kind = status === "adopted" ? "workflow.variant.adopted" : "workflow.variant.adopt_failed";
  for (let index = events.length - 1; index >= 0; index -= 1) {
    const event = events[index];
    if (!isRecord(event) || event.kind !== kind) continue;
    if (!isRecord(event.payload) || !isRecord(event.payload.adoption)) continue;
    if (event.payload.adoption.adoptionId === adoptionId) return event;
  }
  return null;
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
