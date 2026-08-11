interface RunCheckpointRecord {
  id: string;
  sessionId: string;
  nodeId: string;
  laneId: string;
  segmentId: string;
  runId: string;
  phase: "before" | "after";
  executionTarget: "current_branch" | "new_worktree";
  worktreeId?: string;
  worktreePath: string;
  branchName: string;
  headCommit: string;
  ancestryProof?: string;
}

interface RunCheckpointStore {
  listNodeCheckpoints(input: {
    sessionId: string;
    laneId?: string;
    runId?: string;
    phase?: "before" | "after";
  }): unknown[];
}

interface WorkflowCheckpointAuditStore {
  appendWorkflowEvent(input: Record<string, unknown>): unknown;
}

interface WorkflowGitAncestryProofContextLike {
  readonly beforeHeadCommit: string;
  readonly afterHeadCommit: string;
  readonly repositoryIdentity: string;
  readonly worktreeIdentity: string;
}

interface WorkflowGitAncestryProofInputLike {
  repositoryPath: string;
  worktreePath: string;
  beforeHeadCommit: string;
  afterHeadCommit: string;
}

interface WorkflowGitAncestryProofAuthority {
  createProof(input: WorkflowGitAncestryProofInputLike): Promise<string>;
  createContext(input: WorkflowGitAncestryProofInputLike): Promise<WorkflowGitAncestryProofContextLike>;
  verify(serializedProof: unknown, input: WorkflowGitAncestryProofInputLike): Promise<unknown>;
}

interface WorkflowCheckpointLiveGateAuthority {
  resolveCanonicalPaths(pair: WorkflowCheckpointPair): Promise<{
    repositoryPath: string;
    worktreePath: string;
  }>;
  verify(serializedProof: unknown, input: WorkflowGitAncestryProofInputLike): Promise<unknown>;
}

interface AfterCheckpointIdentity {
  sessionId: string;
  nodeId: string;
  laneId: string;
  segmentId: string;
  runId: string;
  executionTarget: "current_branch" | "new_worktree";
  worktreeId?: string;
  worktreePath: string;
  branchName: string;
  headCommit: string;
  repositoryPath: string;
}

export interface WorkflowCheckpointPair {
  beforeCheckpoint: RunCheckpointRecord;
  afterCheckpoint: RunCheckpointRecord;
  sourceCheckpoint: RunCheckpointRecord;
}

export type WorkflowCheckpointAction = "repair" | "variant" | "rollback";

export const WORKFLOW_CHECKPOINT_ANCESTRY_UNAVAILABLE_REASON =
  "Checkpoint Git ancestry proof is unavailable or no longer valid.";

interface ExecutableRunBaselineInput {
  sessionId: string;
  nodeId: string;
  laneId: string;
  segmentId: string;
  runId: string;
  phase: "before" | "after";
  executionTarget: "current_branch" | "new_worktree";
  worktreeId?: string;
  worktreePath: string;
  branchName: string;
  headCommit: string;
}

export function resolveExecutableRunBaseline(
  store: RunCheckpointStore,
  input: ExecutableRunBaselineInput,
): string {
  if (input.phase === "before") return fullCommit(input.headCommit);
  const candidates = store.listNodeCheckpoints({
    sessionId: input.sessionId,
    laneId: input.laneId,
    runId: input.runId,
    phase: "before",
  }).map(runCheckpointRecord);
  if (candidates.length !== 1) {
    throw new Error("After run changeset requires exactly one matching before checkpoint.");
  }
  const before = candidates[0]!;
  const after: RunCheckpointRecord = {
    id: `checkpoint:${input.runId}:after`,
    sessionId: input.sessionId,
    nodeId: input.nodeId,
    laneId: input.laneId,
    segmentId: input.segmentId,
    runId: input.runId,
    phase: "after",
    executionTarget: input.executionTarget,
    ...(input.worktreeId ? { worktreeId: input.worktreeId } : {}),
    worktreePath: input.worktreePath,
    branchName: input.branchName,
    headCommit: fullCommit(input.headCommit),
  };
  assertMatchingCheckpointPair(before, after);
  return fullCommit(before.headCommit);
}

export async function createAfterCheckpointAncestryProof(
  store: RunCheckpointStore,
  after: AfterCheckpointIdentity,
  authority: WorkflowGitAncestryProofAuthority,
): Promise<{
  ancestryProof: string;
  ancestryProofContext: WorkflowGitAncestryProofContextLike;
}> {
  const before = matchingBeforeCheckpoint(store, after);
  const input = ancestryProofInput(after.repositoryPath, after.worktreePath, before.headCommit, after.headCommit);
  const ancestryProof = await authority.createProof(input);
  const ancestryProofContext = await authority.createContext(input);
  await authority.verify(ancestryProof, input);
  return { ancestryProof, ancestryProofContext };
}

export async function verifyWorkflowCheckpointActionGate(
  store: RunCheckpointStore,
  input: {
    action: WorkflowCheckpointAction;
    sessionId: string;
    checkpointId?: string;
    nodeId?: string;
    laneId?: string;
  },
  authority: WorkflowCheckpointLiveGateAuthority,
): Promise<
  | ({ available: true } & WorkflowCheckpointPair)
  | { available: false; reason: typeof WORKFLOW_CHECKPOINT_ANCESTRY_UNAVAILABLE_REASON }
> {
  try {
    const pair = selectWorkflowCheckpointActionPair(store, input);
    const paths = await authority.resolveCanonicalPaths(pair);
    await authority.verify(pair.afterCheckpoint.ancestryProof, ancestryProofInput(
      paths.repositoryPath,
      paths.worktreePath,
      pair.beforeCheckpoint.headCommit,
      pair.afterCheckpoint.headCommit,
    ));
    return { available: true, ...pair };
  } catch {
    return {
      available: false,
      reason: WORKFLOW_CHECKPOINT_ANCESTRY_UNAVAILABLE_REASON,
    };
  }
}

export async function requireCheckpointBoundWorktreeBase(
  store: RunCheckpointStore,
  input: {
    sessionId: string;
    sourceCheckpointId: string;
    sourceHeadCommit: string;
    action: "repair" | "variant";
  },
  authority: WorkflowCheckpointLiveGateAuthority,
): Promise<string> {
  const gate = await verifyWorkflowCheckpointActionGate(store, {
    action: input.action,
    sessionId: input.sessionId,
    checkpointId: input.sourceCheckpointId,
  }, authority);
  if (!gate.available || gate.sourceCheckpoint.headCommit !== fullCommit(input.sourceHeadCommit)) {
    throw new Error(WORKFLOW_CHECKPOINT_ANCESTRY_UNAVAILABLE_REASON);
  }
  return gate.sourceCheckpoint.headCommit;
}

export function recordWorkflowCheckpointFailure(
  store: WorkflowCheckpointAuditStore,
  input: {
    sessionId: string;
    laneId: string;
    segmentId: string;
    runId: string;
    phase: "before" | "after";
    retryable?: boolean;
    now: string;
  },
): void {
  store.appendWorkflowEvent({
    sessionId: input.sessionId,
    kind: "workflow.node.checkpoint_failed",
    source: "electron-main",
    laneId: input.laneId,
    segmentId: input.segmentId,
    idempotencyKey: `checkpoint:${input.runId}:${input.phase}:failed`,
    payload: {
      runId: input.runId,
      phase: input.phase,
      status: "failed",
      ...(input.retryable === true ? { retryable: true } : {}),
      ...(input.phase === "after" ? { terminalRunPreserved: true } : {}),
      reason: `Workflow ${input.phase} checkpoint could not be recorded.`,
    },
    now: input.now,
  });
}

export function selectWorkflowCheckpointActionPair(
  store: RunCheckpointStore,
  input: {
    action: WorkflowCheckpointAction;
    sessionId: string;
    checkpointId?: string;
    nodeId?: string;
    laneId?: string;
  },
): WorkflowCheckpointPair {
  const checkpoints = store.listNodeCheckpoints({
    sessionId: input.sessionId,
    ...(input.laneId ? { laneId: input.laneId } : {}),
  }).map(runCheckpointRecord);
  const requiredPhase = input.action === "repair" ? "after" : "before";
  const sourceCandidates = input.checkpointId
    ? checkpoints.filter((checkpoint) => checkpoint.id === input.checkpointId)
    : [...checkpoints].reverse().filter((checkpoint) =>
        checkpoint.phase === requiredPhase &&
        (!input.nodeId || checkpoint.nodeId === input.nodeId) &&
        (!input.laneId || checkpoint.laneId === input.laneId)
      ).slice(0, 1);
  if (sourceCandidates.length !== 1) throw new Error("Checkpoint action source is unavailable.");
  const sourceCheckpoint = sourceCandidates[0]!;
  if (
    sourceCheckpoint.phase !== requiredPhase ||
    (input.nodeId && sourceCheckpoint.nodeId !== input.nodeId) ||
    (input.laneId && sourceCheckpoint.laneId !== input.laneId)
  ) {
    throw new Error("Checkpoint action source phase or identity is invalid.");
  }
  const pairCandidates = checkpoints.filter((checkpoint) =>
    checkpoint.sessionId === sourceCheckpoint.sessionId &&
    checkpoint.laneId === sourceCheckpoint.laneId &&
    checkpoint.segmentId === sourceCheckpoint.segmentId &&
    checkpoint.runId === sourceCheckpoint.runId
  );
  const beforeCandidates = pairCandidates.filter((checkpoint) => checkpoint.phase === "before");
  const afterCandidates = pairCandidates.filter((checkpoint) => checkpoint.phase === "after");
  if (beforeCandidates.length !== 1 || afterCandidates.length !== 1) {
    throw new Error("Checkpoint action requires exactly one immutable before and after pair.");
  }
  const beforeCheckpoint = beforeCandidates[0]!;
  const afterCheckpoint = afterCandidates[0]!;
  assertMatchingCheckpointPair(beforeCheckpoint, afterCheckpoint);
  if (typeof afterCheckpoint.ancestryProof !== "string" || afterCheckpoint.ancestryProof.length === 0) {
    throw new Error("Checkpoint action requires an ancestry proof on the after checkpoint.");
  }
  return { beforeCheckpoint, afterCheckpoint, sourceCheckpoint };
}

function matchingBeforeCheckpoint(
  store: RunCheckpointStore,
  after: AfterCheckpointIdentity,
): RunCheckpointRecord {
  const candidates = store.listNodeCheckpoints({
    sessionId: after.sessionId,
    laneId: after.laneId,
    runId: after.runId,
    phase: "before",
  }).map(runCheckpointRecord).filter((checkpoint) => checkpoint.segmentId === after.segmentId);
  if (candidates.length !== 1) {
    throw new Error("After checkpoint ancestry proof requires exactly one matching before checkpoint.");
  }
  const before = candidates[0]!;
  const syntheticAfter: RunCheckpointRecord = {
    id: `checkpoint:${after.runId}:after`,
    sessionId: after.sessionId,
    nodeId: after.nodeId,
    laneId: after.laneId,
    segmentId: after.segmentId,
    runId: after.runId,
    phase: "after",
    executionTarget: after.executionTarget,
    ...(after.worktreeId ? { worktreeId: after.worktreeId } : {}),
    worktreePath: after.worktreePath,
    branchName: after.branchName,
    headCommit: fullCommit(after.headCommit),
  };
  assertMatchingCheckpointPair(before, syntheticAfter);
  return before;
}

function assertMatchingCheckpointPair(before: RunCheckpointRecord, after: RunCheckpointRecord): void {
  if (
    before.phase !== "before" ||
    after.phase !== "after" ||
    before.sessionId !== after.sessionId ||
    before.nodeId !== after.nodeId ||
    before.laneId !== after.laneId ||
    before.segmentId !== after.segmentId ||
    before.runId !== after.runId ||
    before.executionTarget !== after.executionTarget ||
    before.worktreeId !== after.worktreeId ||
    before.worktreePath !== after.worktreePath ||
    before.branchName !== after.branchName
  ) {
    throw new Error("Checkpoint action source pair identity is invalid.");
  }
  fullCommit(before.headCommit);
  fullCommit(after.headCommit);
}

function runCheckpointRecord(value: unknown): RunCheckpointRecord {
  if (!isRecord(value)) throw new Error("Run checkpoint is invalid.");
  const executionTarget = value.executionTarget;
  const phase = value.phase;
  if (
    phase !== "before" && phase !== "after" ||
    executionTarget !== "current_branch" && executionTarget !== "new_worktree"
  ) {
    throw new Error("Run checkpoint phase or execution target is invalid.");
  }
  const checkpoint: RunCheckpointRecord = {
    id: checkpointText(value.id),
    sessionId: checkpointText(value.sessionId),
    nodeId: checkpointText(value.nodeId),
    laneId: checkpointText(value.laneId),
    segmentId: checkpointText(value.segmentId),
    runId: checkpointText(value.runId),
    phase,
    executionTarget,
    worktreePath: checkpointText(value.worktreePath),
    branchName: checkpointText(value.branchName),
    headCommit: fullCommit(checkpointText(value.headCommit)),
  };
  if (value.worktreeId !== undefined) checkpoint.worktreeId = checkpointText(value.worktreeId);
  if (Object.prototype.hasOwnProperty.call(value, "ancestryProof")) {
    if (typeof value.ancestryProof !== "string") throw new Error("Run checkpoint ancestry proof is invalid.");
    checkpoint.ancestryProof = value.ancestryProof;
  }
  return checkpoint;
}

function ancestryProofInput(
  repositoryPath: string,
  worktreePath: string,
  beforeHeadCommit: string,
  afterHeadCommit: string,
): WorkflowGitAncestryProofInputLike {
  return {
    repositoryPath: checkpointText(repositoryPath),
    worktreePath: checkpointText(worktreePath),
    beforeHeadCommit: fullCommit(beforeHeadCommit),
    afterHeadCommit: fullCommit(afterHeadCommit),
  };
}

function checkpointText(value: unknown): string {
  if (typeof value !== "string" || value.length === 0 || value.trim() !== value) {
    throw new Error("Run checkpoint text identity is invalid.");
  }
  return value;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function fullCommit(value: string): string {
  if (!/^[0-9a-f]{40}$/i.test(value)) throw new Error("Run changeset baseline requires a full commit SHA.");
  return value.toLowerCase();
}
