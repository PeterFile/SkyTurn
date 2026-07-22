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

export interface OwnedScheduledRunStart<Store> {
  store: Store;
  segment: ScheduledRunSegment;
  identity: TrustedRunStartIdentity;
}

interface RunStartStore {
  listRunningSegments(): ScheduledRunSegment[];
}

interface PublicRunStartTarget {
  sessionId?: unknown;
  nodeId?: unknown;
  runId?: unknown;
}

const scheduledRunStartAuthorityError = "Electron main owns workflow-scheduled run starts.";

export function assertPublicRunStartIsNotScheduled(
  input: unknown,
  store: RunStartStore,
): void {
  if (typeof input !== "object" || input === null) return;
  const target = input as PublicRunStartTarget;
  if (
    typeof target.sessionId !== "string" ||
    typeof target.nodeId !== "string" ||
    typeof target.runId !== "string"
  ) return;
  if (store.listRunningSegments().some((segment) =>
    segment.sessionId === target.sessionId &&
    segment.laneId === target.nodeId &&
    segment.runId === target.runId
  )) {
    throw new Error(scheduledRunStartAuthorityError);
  }
}

export interface RunStartDependencies<Input, Run, Store extends RunStartStore> {
  preAuthorizeStart?(input: Input): void | Promise<void>;
  authorizeStartInput?(input: Input, knownStore?: Store): Input | Promise<Input>;
  scheduledStartsRequireOwnership?: boolean;
  resolveIdentity(input: Input, knownStore?: Store): TrustedRunStartIdentity | Promise<TrustedRunStartIdentity>;
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
): (input: Input, ownership?: OwnedScheduledRunStart<Store>) => Promise<Run> {
  const startFlights = new Map<string, { fingerprint: string; promise: Promise<Run> }>();
  return async (input, ownership) => {
    let authorizedInput: Input;
    let identity: TrustedRunStartIdentity;
    try {
      await dependencies.preAuthorizeStart?.(input);
      authorizedInput = dependencies.authorizeStartInput
        ? await dependencies.authorizeStartInput(input, ownership?.store)
        : input;
      identity = await dependencies.resolveIdentity(authorizedInput, ownership?.store);
      if (ownership) assertOwnedStartIdentity(ownership, identity);
    } catch (error) {
      if (!ownership || isRunStartIdentityConflict(error)) return Promise.reject(error);
      await settleOwnedStartFailure(dependencies, ownership.store, ownership.segment, ownership.identity, error);
      return Promise.reject(await publicOwnedRunStartError(error));
    }
    const active = startFlights.get(identity.runId);
    if (active) {
      if (active.fingerprint !== identity.startFingerprint) {
        return Promise.reject(new Error(`Run ${identity.runId} is already claimed with different identity.`));
      }
      return active.promise;
    }
    const promise = runStartOnce(dependencies, authorizedInput, identity, ownership);
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
  ownership?: OwnedScheduledRunStart<Store>,
): Promise<Run> {
  let store: Store | null = ownership?.store ?? null;
  let segment: ScheduledRunSegment | null = ownership?.segment ?? null;
  let compensationOwned = ownership !== undefined;
  try {
    store ??= await dependencies.acquireStore(identity);
    if (!ownership && dependencies.scheduledStartsRequireOwnership) {
      assertPublicRunStartIsNotScheduled(input, store);
    }
    await dependencies.assertStartInput(input, store);
    const target = ownership
      ? findOwnedScheduledSegment(store, ownership, identity)
      : await findOrClaimStartSegment(dependencies, input, store, identity);
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
    if (isRunStartIdentityConflict(error)) throw error;
    if (!store || !segment || !compensationOwned) {
      throw isOwnedRunStartFailure(error) ? await publicOwnedRunStartError(error) : error;
    }
    await settleOwnedStartFailure(dependencies, store, segment, identity, error);
    throw await publicOwnedRunStartError(error);
  }
}

function assertOwnedStartIdentity<Store>(
  ownership: OwnedScheduledRunStart<Store>,
  identity: TrustedRunStartIdentity,
): void {
  if (
    ownership.identity.projectRoot !== identity.projectRoot ||
    ownership.identity.sessionId !== identity.sessionId ||
    ownership.identity.laneId !== identity.laneId ||
    ownership.identity.runId !== identity.runId ||
    ownership.identity.agentKind !== identity.agentKind ||
    ownership.identity.startFingerprint !== identity.startFingerprint ||
    ownership.segment.sessionId !== identity.sessionId ||
    ownership.segment.laneId !== identity.laneId ||
    ownership.segment.runId !== identity.runId ||
    ownership.segment.agentKind !== identity.agentKind
  ) {
    throw new Error("Main-owned workflow run start identity mismatch.");
  }
}

function findOwnedScheduledSegment<Store extends RunStartStore>(
  store: Store,
  ownership: OwnedScheduledRunStart<Store>,
  identity: TrustedRunStartIdentity,
): { segment: ScheduledRunSegment; claimed: boolean } {
  const scheduled = findScheduledSegment(store, identity);
  if (scheduled.segmentId !== ownership.segment.segmentId) {
    throw new Error("Main-owned workflow run segment identity mismatch.");
  }
  return { segment: scheduled, claimed: true };
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
    if (dependencies.scheduledStartsRequireOwnership) {
      throw new Error(scheduledRunStartAuthorityError);
    }
    if (scheduled.agentKind !== identity.agentKind) throw new Error("Workflow run agent identity mismatch.");
    return { segment: scheduled, claimed: false };
  }
  throw new Error("Workflow run segment is not scheduled for start.");
}

function isOwnedRunStartFailure(error: unknown): boolean {
  return typeof error === "object" && error !== null &&
    "durableRunClaimOwned" in error && error.durableRunClaimOwned === true;
}

function isRunStartIdentityConflict(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return /^Run .+ is already (?:claimed with different identity|active or durably claimed)\.$/.test(message);
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

async function settleOwnedStartFailure<Input, Run, Store extends RunStartStore>(
  dependencies: RunStartDependencies<Input, Run, Store>,
  store: Store,
  segment: ScheduledRunSegment,
  identity: TrustedRunStartIdentity,
  error: unknown,
): Promise<void> {
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
