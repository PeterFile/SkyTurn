import { realpath } from "node:fs/promises";

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
  listRuns?(): unknown[];
}

interface RecoveryStore {
  listRunningSegments(): RunningSegment[];
  listPendingPlannerIntentReconciliations(): RunSegmentIdentity[];
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

type ExactRunCatalogState =
  | "exact-running"
  | "exact-terminal-evidence-pending"
  | "known-absent-or-conflict"
  | "unknown-unavailable";

const TERMINAL_STATUSES = new Set(["succeeded", "failed", "cancelled", "timed-out"]);
const INVALID_RUN_START_CLAIM_REASON = "run-start-claim-invalid";
const INTERRUPTED_RUN_RECOVERY_REASON = "run-recovery-interrupted";

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
  reconcilePendingPlannerIntent?: (segment: RunSegmentIdentity) => Promise<void>,
  reconcileTerminalRun?: (segment: RunSegmentIdentity, evidence: unknown) => Promise<void>,
): Promise<void> {
  for (const segment of store.listRunningSegments()) {
    try {
      const initialEvidence = await bridge.getEvidence(projectRoot, segment.runId);
      let terminalEvidence = isTerminalEvidence(initialEvidence, segment.runId) ? initialEvidence : null;
      if (!terminalEvidence) {
        const catalogState = await exactRunCatalogState(bridge, projectRoot, segment);
        if (catalogState === "exact-running" || catalogState === "unknown-unavailable") continue;
        const refreshedEvidence = await bridge.getEvidence(projectRoot, segment.runId);
        if (isTerminalEvidence(refreshedEvidence, segment.runId)) {
          terminalEvidence = refreshedEvidence;
        } else {
          const refreshedCatalogState = await exactRunCatalogState(bridge, projectRoot, segment);
          if (refreshedCatalogState !== "known-absent-or-conflict") continue;
          compensateFailedWorkflowRun(store, segment, new Error(INTERRUPTED_RUN_RECOVERY_REASON), now);
          try {
            store.appendWorkflowEvent({
              sessionId: segment.sessionId,
              kind: "workflow.run.recovery_failed",
              source: "electron-main",
              laneId: segment.laneId,
              segmentId: segment.segmentId,
              idempotencyKey: `run-recovery:${segment.runId}:interrupted`,
              payload: {
                runId: segment.runId,
                status: "failed",
                reason: INTERRUPTED_RUN_RECOVERY_REASON,
              },
              now: now(),
            });
          } catch {
            // Terminal compensation is authoritative; recovery audit is best-effort.
          }
          continue;
        }
      }
      if (reconcileTerminalRun) {
        await reconcileTerminalRun(segment, terminalEvidence);
      } else {
        const events = await bridge.loadEvents(projectRoot, segment.runId);
        store.recordRunResult({
          ...segment,
          outputSummary: summarizeOutput(events) ?? "",
          runEvents: events,
          evidence: terminalEvidence,
          now: completedAt(terminalEvidence) ?? now(),
        });
      }
    } catch (error) {
      const invalidRunStartClaim = isInvalidRunStartClaimError(error);
      const catalogState = invalidRunStartClaim
        ? "known-absent-or-conflict"
        : await exactRunCatalogState(bridge, projectRoot, segment);
      const shouldCompensate = invalidRunStartClaim || catalogState === "known-absent-or-conflict";
      const reason = recoveryFailureReason(catalogState, invalidRunStartClaim);
      if (shouldCompensate) compensateFailedWorkflowRun(store, segment, new Error(reason), now);
      store.appendWorkflowEvent({
        sessionId: segment.sessionId,
        kind: "workflow.run.recovery_failed",
        source: "electron-main",
        laneId: segment.laneId,
        segmentId: segment.segmentId,
        idempotencyKey: `run-recovery:${segment.runId}:failed`,
        payload: {
          runId: segment.runId,
          status: shouldCompensate ? "failed" : "running",
          reason,
          ...(!shouldCompensate ? { retryable: true, terminalRunPreserved: true } : {}),
        },
        now: now(),
      });
    }
  }
  if (reconcilePendingPlannerIntent) {
    await recoverPendingPlannerIntentReconciliations(store, reconcilePendingPlannerIntent, now);
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

export async function recoverPendingPlannerIntentReconciliations(
  store: RecoveryStore,
  reconcilePendingPlannerIntent: (segment: RunSegmentIdentity) => Promise<void>,
  now: () => string = () => new Date().toISOString(),
): Promise<void> {
  for (const segment of store.listPendingPlannerIntentReconciliations()) {
    try {
      await reconcilePendingPlannerIntent(segment);
    } catch {
      store.appendWorkflowEvent({
        sessionId: segment.sessionId,
        kind: "workflow.run.recovery_failed",
        source: "electron-main",
        laneId: segment.laneId,
        segmentId: segment.segmentId,
        idempotencyKey: `planner-intent-recovery:${segment.runId}:failed`,
        payload: { runId: segment.runId, status: "failed", reason: "planner-intent-recovery-failed" },
        now: now(),
      });
    }
  }
}

function recoveryFailureReason(catalogState: ExactRunCatalogState, invalidRunStartClaim: boolean): string {
  if (invalidRunStartClaim) return INVALID_RUN_START_CLAIM_REASON;
  if (catalogState === "known-absent-or-conflict") return INTERRUPTED_RUN_RECOVERY_REASON;
  if (catalogState === "exact-terminal-evidence-pending") return "terminal-evidence-pending";
  if (catalogState === "unknown-unavailable") return "terminal-recovery-unavailable";
  return "terminal-recovery-failed";
}

async function exactRunCatalogState(
  bridge: RecoveryBridge,
  projectRoot: string,
  segment: RunningSegment,
): Promise<ExactRunCatalogState> {
  let runs: unknown;
  try {
    runs = bridge.listRuns?.();
  } catch {
    return "unknown-unavailable";
  }
  if (!Array.isArray(runs)) return "unknown-unavailable";

  let canonicalProjectRoot: string;
  try {
    canonicalProjectRoot = await realpath(projectRoot);
  } catch {
    return "unknown-unavailable";
  }

  let exactState: ExactRunCatalogState | null = null;
  for (const run of runs) {
    if (!isRecord(run)) continue;
    const hasId = Object.hasOwn(run, "id");
    const hasRunId = Object.hasOwn(run, "runId");
    if (!hasId && !hasRunId) continue;
    const mentionsRunId = (hasId && run.id === segment.runId) || (hasRunId && run.runId === segment.runId);
    if (!mentionsRunId) continue;
    if (
      (hasId && run.id !== segment.runId) ||
      (hasRunId && run.runId !== segment.runId) ||
      run.sessionId !== segment.sessionId ||
      run.nodeId !== segment.laneId ||
      run.agentKind !== segment.agentKind ||
      typeof run.projectRoot !== "string"
    ) {
      return "known-absent-or-conflict";
    }
    let runProjectRoot: string;
    try {
      runProjectRoot = await realpath(run.projectRoot);
    } catch {
      return "unknown-unavailable";
    }
    if (runProjectRoot !== canonicalProjectRoot) return "known-absent-or-conflict";
    const candidateState = run.status === "running"
      ? "exact-running"
      : TERMINAL_STATUSES.has(String(run.status))
        ? "exact-terminal-evidence-pending"
        : "unknown-unavailable";
    if (exactState !== null) return "known-absent-or-conflict";
    exactState = candidateState;
  }
  return exactState ?? "known-absent-or-conflict";
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
