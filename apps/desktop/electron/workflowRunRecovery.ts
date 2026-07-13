interface RunSegmentIdentity {
  sessionId: string;
  laneId: string;
  segmentId: string;
  runId: string;
  agentKind: string;
}

type RunningSegment = RunSegmentIdentity & { status?: "running" };

interface RecoveryBridge {
  getEvidence(projectRoot: string, runId: string): Promise<unknown>;
  loadEvents(projectRoot: string, runId: string): Promise<unknown[]>;
}

interface RecoveryStore {
  listRunningSegments(): RunningSegment[];
  listPendingRunCheckpointEnrichments(): RunSegmentIdentity[];
  recordRunResult(input: {
    sessionId: string;
    laneId: string;
    segmentId: string;
    runId: string;
    agentKind: string;
    outputSummary: string;
    runEvents?: unknown[];
    evidence: unknown;
    now: string;
  }): unknown;
  appendWorkflowEvent(input: Record<string, unknown>): unknown;
}

const TERMINAL_STATUSES = new Set(["succeeded", "failed", "cancelled", "timed-out"]);
const INVALID_RUN_START_CLAIM_REASON = "run-start-claim-invalid";

export function compensateFailedWorkflowRun(
  store: RecoveryStore,
  segment: RunningSegment,
  error: unknown,
  now: () => string = () => new Date().toISOString(),
): void {
  const stillRunning = store.listRunningSegments().some((candidate) =>
    candidate.sessionId === segment.sessionId &&
    candidate.laneId === segment.laneId &&
    candidate.segmentId === segment.segmentId &&
    candidate.runId === segment.runId &&
    candidate.agentKind === segment.agentKind
  );
  if (!stillRunning) return;
  const completedAt = now();
  const reason = error instanceof Error ? error.message : String(error);
  store.recordRunResult({
    ...segment,
    outputSummary: "Agent run failed before durable terminal events were available.",
    evidence: {
      runId: segment.runId,
      status: "failed",
      exitCode: 1,
      changesetId: null,
      checks: [{ kind: "run-exit", name: "Agent run start", status: "failed", detail: reason }],
      artifacts: [],
      review: null,
      errorReason: reason,
      cancelReason: null,
      completedAt,
    },
    now: completedAt,
  });
}

export async function recoverTerminalWorkflowRuns(
  projectRoot: string,
  store: RecoveryStore,
  bridge: RecoveryBridge,
  summarizeOutput: (events: unknown[]) => string | undefined,
  now: () => string = () => new Date().toISOString(),
  enrichAfterCheckpoint?: (segment: RunSegmentIdentity) => Promise<void>,
): Promise<void> {
  for (const segment of store.listRunningSegments()) {
    try {
      const evidence = await bridge.getEvidence(projectRoot, segment.runId);
      if (!isTerminalEvidence(evidence, segment.runId)) continue;
      const events = await bridge.loadEvents(projectRoot, segment.runId);
      store.recordRunResult({
        ...segment,
        outputSummary: summarizeOutput(events) ?? "",
        runEvents: events,
        evidence,
        now: completedAt(evidence) ?? now(),
      });
    } catch (error) {
      const invalidRunStartClaim = isInvalidRunStartClaimError(error);
      if (invalidRunStartClaim) {
        compensateFailedWorkflowRun(store, segment, new Error(INVALID_RUN_START_CLAIM_REASON), now);
      }
      store.appendWorkflowEvent({
        sessionId: segment.sessionId,
        kind: "workflow.run.recovery_failed",
        source: "electron-main",
        laneId: segment.laneId,
        segmentId: segment.segmentId,
        idempotencyKey: `run-recovery:${segment.runId}:failed`,
        payload: {
          runId: segment.runId,
          status: "failed",
          reason: invalidRunStartClaim ? INVALID_RUN_START_CLAIM_REASON : "terminal-recovery-failed",
        },
        now: now(),
      });
    }
  }
  if (!enrichAfterCheckpoint) return;
  for (const segment of store.listPendingRunCheckpointEnrichments()) {
    try {
      await enrichAfterCheckpoint(segment);
    } catch (error) {
      store.appendWorkflowEvent({
        sessionId: segment.sessionId,
        kind: "workflow.node.checkpoint_failed",
        source: "electron-main",
        laneId: segment.laneId,
        segmentId: segment.segmentId,
        idempotencyKey: `checkpoint:${segment.runId}:after:failed`,
        payload: {
          runId: segment.runId,
          phase: "after",
          status: "failed",
          retryable: true,
          terminalRunPreserved: true,
          reason: error instanceof Error ? error.message : String(error),
        },
        now: now(),
      });
    }
  }
}

function isInvalidRunStartClaimError(error: unknown): boolean {
  return error instanceof Error &&
    error.name === "InvalidDurableRunStartClaimError" &&
    error.message === INVALID_RUN_START_CLAIM_REASON;
}

function isTerminalEvidence(evidence: unknown, runId: string): evidence is Record<string, unknown> {
  return isRecord(evidence) &&
    evidence.runId === runId &&
    TERMINAL_STATUSES.has(String(evidence.status)) &&
    typeof evidence.completedAt === "string" &&
    evidence.completedAt.length > 0;
}

function completedAt(evidence: Record<string, unknown>): string | null {
  return typeof evidence.completedAt === "string" && evidence.completedAt ? evidence.completedAt : null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
