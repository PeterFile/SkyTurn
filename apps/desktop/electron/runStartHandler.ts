export interface TrustedRunStartIdentity {
  projectRoot: string;
  sessionId: string;
  laneId: string;
  runId: string;
  agentKind: string;
  worktreePath: string;
  startFingerprint: string;
  plannerSessionId?: string;
  plannerInputId?: string;
  hermesSessionHandle?: string;
  transport?: string;
}

export interface ScheduledRunSegment {
  sessionId: string;
  laneId: string;
  segmentId: string;
  runId: string;
  agentKind: string;
}

export interface ClaimedRunStartSegment {
  segment: ScheduledRunSegment;
  created: boolean;
}

interface RunStartStore {
  listRunningSegments(): ScheduledRunSegment[];
}

interface RunStartDependencies<Input, Run, Store extends RunStartStore> {
  preAuthorizeStart?(input: Input): void | Promise<void>;
  authorizeStartInput?(input: Input): Input | Promise<Input>;
  resolveIdentity(input: Input): TrustedRunStartIdentity | Promise<TrustedRunStartIdentity>;
  acquireStore(identity: TrustedRunStartIdentity): Promise<Store>;
  reopenStore(identity: TrustedRunStartIdentity): Promise<Store>;
  assertStartInput(input: Input, store: Store): Promise<void>;
  claimUnscheduledStart?(
    input: Input,
    store: Store,
    identity: TrustedRunStartIdentity,
  ): ClaimedRunStartSegment | null | Promise<ClaimedRunStartSegment | null>;
  prepareBeforeCheckpoint(input: Input, store: Store, segment: ScheduledRunSegment): Promise<boolean>;
  startRun(input: Input): Promise<Run>;
  reconcileTerminal(store: Store, segment: ScheduledRunSegment, identity: TrustedRunStartIdentity): Promise<void>;
  recordReconciliationFailure?(store: Store, segment: ScheduledRunSegment, error: unknown): void;
  compensateTerminal(store: Store, segment: ScheduledRunSegment, error: unknown): void;
  enrichAfterCheckpoint(store: Store, segment: ScheduledRunSegment, identity: TrustedRunStartIdentity): Promise<void>;
  recordBeforeCheckpointFailure(store: Store, segment: ScheduledRunSegment, error: unknown): void;
  recordAfterCheckpointFailure(store: Store, segment: ScheduledRunSegment, error: unknown): void;
}

export function createRunStartHandler<Input, Run, Store extends RunStartStore>(
  dependencies: RunStartDependencies<Input, Run, Store>,
): (input: Input) => Promise<Run> {
  const startFlights = new Map<string, { fingerprint: string; promise: Promise<Run> }>();
  return async (input) => {
    let authorizedInput: Input;
    let identity: TrustedRunStartIdentity;
    try {
      await dependencies.preAuthorizeStart?.(input);
      authorizedInput = dependencies.authorizeStartInput
        ? await dependencies.authorizeStartInput(input)
        : input;
      identity = await dependencies.resolveIdentity(authorizedInput);
    } catch (error) {
      return Promise.reject(error);
    }
    const active = startFlights.get(identity.runId);
    if (active) {
      if (active.fingerprint !== identity.startFingerprint) {
        return Promise.reject(new Error(`Run ${identity.runId} is already claimed with different identity.`));
      }
      return active.promise;
    }
    const promise = runStartOnce(dependencies, authorizedInput, identity);
    startFlights.set(identity.runId, { fingerprint: identity.startFingerprint, promise });
    void promise.then(
      () => clearStartFlight(startFlights, identity.runId, promise),
      () => clearStartFlight(startFlights, identity.runId, promise),
    );
    return promise;
  };
}

async function runStartOnce<Input, Run, Store extends RunStartStore>(
  dependencies: RunStartDependencies<Input, Run, Store>,
  input: Input,
  identity: TrustedRunStartIdentity,
): Promise<Run> {
  let store: Store | null = null;
  let segment: ScheduledRunSegment | null = null;
  let compensationOwned = false;
  try {
    store = await dependencies.acquireStore(identity);
    await dependencies.assertStartInput(input, store);
    const target = await findOrClaimStartSegment(dependencies, input, store, identity);
    segment = target.segment;
    compensationOwned = target.claimed;
    try {
      await dependencies.prepareBeforeCheckpoint(input, store, segment);
    } catch (error) {
      try {
        dependencies.recordBeforeCheckpointFailure(store, segment, error);
      } catch {
        // Checkpoint audit enrichment is best-effort.
      }
      throw error;
    }
    try {
      return await dependencies.startRun(input);
    } catch (error) {
      compensationOwned ||= isOwnedRunStartFailure(error);
      throw error;
    }
  } catch (error) {
    if (!store || !segment || !compensationOwned) {
      throw isOwnedRunStartFailure(error) ? await publicOwnedRunStartError(error) : error;
    }
    try {
      await dependencies.reconcileTerminal(store, segment, identity);
    } catch (reconciliationError) {
      await persistCompensation(dependencies, identity, store, segment, runStartCompensationError(error));
      try {
        dependencies.recordReconciliationFailure?.(store, segment, reconciliationError);
      } catch {
        // Terminal state is already durable; audit enrichment is best-effort.
      }
    }
    try {
      await dependencies.enrichAfterCheckpoint(store, segment, identity);
    } catch (enrichmentError) {
      try {
        dependencies.recordAfterCheckpointFailure(store, segment, enrichmentError);
      } catch {
        // Terminal state is already durable; checkpoint enrichment is best-effort.
      }
    }
    throw await publicOwnedRunStartError(error);
  }
}

function clearStartFlight<Run>(
  startFlights: Map<string, { fingerprint: string; promise: Promise<Run> }>,
  runId: string,
  promise: Promise<Run>,
): void {
  if (startFlights.get(runId)?.promise === promise) startFlights.delete(runId);
}

function findScheduledSegment<Store extends RunStartStore>(
  store: Store,
  identity: TrustedRunStartIdentity,
): ScheduledRunSegment {
  const segment = store.listRunningSegments().find((candidate) =>
    candidate.sessionId === identity.sessionId &&
    candidate.laneId === identity.laneId &&
    candidate.runId === identity.runId
  );
  if (!segment) throw new Error("Workflow run segment is not scheduled for start.");
  if (segment.agentKind !== identity.agentKind) throw new Error("Workflow run agent identity mismatch.");
  return segment;
}

async function findOrClaimStartSegment<Input, Run, Store extends RunStartStore>(
  dependencies: RunStartDependencies<Input, Run, Store>,
  input: Input,
  store: Store,
  identity: TrustedRunStartIdentity,
): Promise<{ segment: ScheduledRunSegment; claimed: boolean }> {
  if (dependencies.claimUnscheduledStart) {
    const claim = await dependencies.claimUnscheduledStart(input, store, identity);
    if (claim) {
      if (claim.segment.agentKind !== identity.agentKind) throw new Error("Workflow run agent identity mismatch.");
      if (!claim.created) throw new Error(`Run ${identity.runId} is already active or durably claimed.`);
      return { segment: claim.segment, claimed: true };
    }
  }
  const scheduled = store.listRunningSegments().find((candidate) =>
    candidate.sessionId === identity.sessionId &&
    candidate.laneId === identity.laneId &&
    candidate.runId === identity.runId
  );
  if (scheduled) {
    if (scheduled.agentKind !== identity.agentKind) throw new Error("Workflow run agent identity mismatch.");
    return { segment: scheduled, claimed: false };
  }
  throw new Error("Workflow run segment is not scheduled for start.");
}

function isOwnedRunStartFailure(error: unknown): boolean {
  return typeof error === "object" && error !== null &&
    "durableRunClaimOwned" in error && error.durableRunClaimOwned === true;
}

function runStartCompensationError(error: unknown): unknown {
  if (typeof error !== "object" || error === null) return error;
  const internal = (error as Record<PropertyKey, unknown>)[
    Symbol.for("skyturn.agent-bridge.owned-run-start-internal-error")
  ];
  return typeof internal === "object" && internal !== null && "cause" in internal
    ? (internal as { cause: unknown }).cause
    : error;
}

async function publicOwnedRunStartError(error: unknown): Promise<Error & { durableRunClaimOwned: true }> {
  const { sanitizePublicEvidenceText } = await import("@skyturn/project-core");
  const rawMessage = error instanceof Error ? error.message : String(error);
  const publicError = new Error(sanitizePublicEvidenceText(rawMessage) || "Agent run start failed.") as Error & {
    durableRunClaimOwned: true;
  };
  publicError.name = error instanceof Error ? error.name : "OwnedAgentRunStartError";
  publicError.durableRunClaimOwned = true;
  return publicError;
}

async function persistCompensation<Input, Run, Store extends RunStartStore>(
  dependencies: RunStartDependencies<Input, Run, Store>,
  identity: TrustedRunStartIdentity,
  store: Store,
  segment: ScheduledRunSegment,
  error: unknown,
): Promise<void> {
  try {
    dependencies.compensateTerminal(store, segment, error);
  } catch {
    const reopened = await dependencies.reopenStore(identity);
    dependencies.compensateTerminal(reopened, findScheduledSegment(reopened, identity), error);
  }
}
