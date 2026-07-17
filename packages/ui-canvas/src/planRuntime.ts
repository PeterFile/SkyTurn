import type {
  PlanBootstrapRequest,
  PlanCancelRequest,
  PlanAcceptStageRequest,
  PlanCheckpointState,
  PlanEvent,
  PlanGenerateRequest,
  PlanGetStateRequest,
  PlanOperation,
  PlanReviseRequest,
  PlanRunStartResult,
  PlanRuntimeStateResult,
  PlanSession,
  PlanStage,
  PlanStageState,
  PlanStateSnapshot,
  PlanStateTransitionResult,
  PlanUndoStageRequest,
  PlanUpdateStageRequest,
} from "@skyturn/project-core";
import { parsePlanStateSnapshot } from "@skyturn/project-core";

const stageOrder: PlanStage[] = ["requirements", "design", "tasks"];
const maxCheckpoints = 20;

export function applyPlanEvent(session: PlanSession, event: PlanEvent): PlanSession {
  if (event.planSessionId !== session.id) return session;
  if ((event.kind === "completed" || event.kind === "failed") && event.snapshot.version < session.stateVersion) {
    return session;
  }
  if (event.kind === "started") return beginPlanRun(session, event.stage, event.operation, event.runId);

  const current = session.stages[event.stage];
  if (current.runId !== event.runId || current.operation !== event.operation) return session;
  if (event.kind === "conversation_ready") {
    return session.conversationStarted ? session : { ...session, conversationStarted: true };
  }
  if (event.kind === "delta") {
    return updateStage(session, event.stage, { ...current, draft: current.draft + event.text });
  }
  return applyAuthoritativePlanTerminal(session, event);
}

export function applyPlanStateSnapshot(
  session: PlanSession,
  snapshot: PlanStateSnapshot,
): PlanSession {
  const stages = Object.fromEntries(stageOrder.map((stage) => {
    const current = session.stages[stage];
    const markdown = snapshot.plan[stage];
    return [stage, {
      ...current,
      status: markdown.trim() ? "ready" : "pending",
      accepted: snapshot.accepted[stage],
      draft: "",
      error: null,
      runId: null,
      lastRunId: null,
      operation: null,
      checkpoints: [...snapshot.checkpoints[stage]],
    }];
  })) as PlanSession["stages"];
  return {
    ...session,
    stateVersion: snapshot.version,
    plan: { ...snapshot.plan },
    stages,
    updatedAt: new Date().toISOString(),
  };
}

export function acceptPlanStage(session: PlanSession, stage: PlanStage): PlanSession {
  const state = session.stages[stage];
  if (state.status !== "ready" || state.runId || !session.plan[stage].trim()) return session;
  return updateStage(session, stage, { ...state, accepted: true });
}

export function undoPlanStage(session: PlanSession, stage: PlanStage): PlanSession {
  const state = session.stages[stage];
  if (state.runId || state.checkpoints.length === 0) return session;
  const checkpoints = state.checkpoints.slice(0, -1);
  const markdown = state.checkpoints[state.checkpoints.length - 1] ?? session.plan[stage];
  return invalidateDownstreamStages(updateStage(
    { ...session, plan: { ...session.plan, [stage]: markdown } },
    stage,
    { ...state, status: "ready", accepted: false, checkpoints, error: null },
  ), stage);
}

export function canFinishPlan(session: PlanSession): boolean {
  return stageOrder.every((stage) => {
    const state = session.stages[stage];
    return state.status === "ready" && state.accepted && !state.runId && !!session.plan[stage].trim();
  });
}

export function setActivePlanStage(session: PlanSession, stage: PlanStage): PlanSession {
  return session.activeStage === stage ? session : { ...session, activeStage: stage };
}

export function editPlanStage(session: PlanSession, stage: PlanStage, markdown: string): PlanSession {
  const current = session.stages[stage];
  let result = updateStage(
    { ...session, plan: { ...session.plan, [stage]: markdown } },
    stage,
    {
      ...current,
      status: markdown.trim() ? "ready" : "pending",
      accepted: false,
      error: null,
      operation: null,
    },
  );
  result = invalidateDownstreamStages(result, stage);
  return result;
}

export function failPlanRunStart(
  session: PlanSession,
  stage: PlanStage,
  operation: PlanOperation,
): PlanSession {
  const current = session.stages[stage];
  return updateStage(session, stage, {
    ...current,
    status: "failed",
    accepted: operation === "revise" ? current.accepted : false,
    draft: "",
    error: "Plan generation could not start. Retry to continue.",
    runId: null,
    operation,
  });
}

export function isPlanRuntimeBusyError(error: unknown): boolean {
  if (!(error instanceof Error)) return false;
  if (error.message === PLAN_RUNTIME_BUSY_ERROR) return true;
  const wrapped = /^Error invoking remote method '[^'\r\n]+': Error: (.+)$/.exec(error.message);
  return wrapped?.[1] === PLAN_RUNTIME_BUSY_ERROR;
}

export function applyPlanRunStartFailure(
  session: PlanSession,
  stage: PlanStage,
  operation: PlanOperation,
  error: unknown,
): PlanSession {
  return isPlanRuntimeBusyError(error) ? session : failPlanRunStart(session, stage, operation);
}

export function activePlanMarkdown(session: PlanSession, stage: PlanStage): string {
  const state = session.stages[stage];
  return state.status === "generating" || state.status === "revising"
    ? state.draft
    : session.plan[stage];
}

export interface InMemoryPlanAdapter {
  generate(input: PlanGenerateRequest): Promise<PlanRunStartResult>;
  revise(input: PlanReviseRequest): Promise<PlanRunStartResult>;
  updateStage(input: PlanUpdateStageRequest): Promise<PlanStateTransitionResult>;
  acceptStage(input: PlanAcceptStageRequest): Promise<PlanStateTransitionResult>;
  undoStage(input: PlanUndoStageRequest): Promise<PlanStateTransitionResult>;
  cancel(input: PlanCancelRequest): Promise<{ protocolVersion: 1; cancelled: boolean }>;
  bootstrap(input: PlanBootstrapRequest): Promise<PlanRuntimeStateResult>;
  getState(input: PlanGetStateRequest): Promise<PlanRuntimeStateResult>;
}

export const PLAN_BACKEND_UNAVAILABLE_ERROR = "Plan backend is unavailable.";
export const PLAN_RUNTIME_STATE_ERROR = "Plan runtime state is unavailable. Retry recovery.";
export const PLAN_RUNTIME_BUSY_ERROR = "Plan runtime is busy.";

export interface PlanRuntimeRecoveryState {
  planSessionId: string | null;
  status: "idle" | "loading" | "ready" | "failed";
  error: string | null;
}

export type PlanRuntimeRecoveryAction =
  | { type: "reset" }
  | { type: "begin"; planSessionId: string }
  | { type: "succeeded"; planSessionId: string }
  | { type: "failed"; planSessionId: string };

export const initialPlanRuntimeRecovery: PlanRuntimeRecoveryState = {
  planSessionId: null,
  status: "idle",
  error: null,
};

export function planRuntimeRecoveryReducer(
  state: PlanRuntimeRecoveryState,
  action: PlanRuntimeRecoveryAction,
): PlanRuntimeRecoveryState {
  if (action.type === "reset") return initialPlanRuntimeRecovery;
  if (action.type === "begin") {
    return { planSessionId: action.planSessionId, status: "loading", error: null };
  }
  if (state.planSessionId !== action.planSessionId) return state;
  return action.type === "succeeded"
    ? { planSessionId: action.planSessionId, status: "ready", error: null }
    : { planSessionId: action.planSessionId, status: "failed", error: PLAN_RUNTIME_STATE_ERROR };
}

export function canStartPlanRequest(state: PlanRuntimeRecoveryState, planSessionId: string): boolean {
  return state.planSessionId === planSessionId && state.status === "ready";
}

export function isPlanInteractionLocked(
  state: PlanRuntimeRecoveryState,
  planSessionId: string,
  finishInFlight = false,
): boolean {
  return finishInFlight || !canStartPlanRequest(state, planSessionId);
}

type PlanTimerHandle = ReturnType<typeof globalThis.setTimeout>;

export function createPlanRuntimeWatchdog(options: {
  recover: () => Promise<boolean>;
  isActive: () => boolean;
  schedule?: (callback: () => void, delay: number) => PlanTimerHandle;
  cancel?: (handle: PlanTimerHandle) => void;
  intervalMs?: number;
}): () => void {
  const schedule = options.schedule ?? ((callback, delay) => globalThis.setTimeout(callback, delay));
  const cancel = options.cancel ?? ((handle) => globalThis.clearTimeout(handle));
  const intervalMs = Math.max(1, options.intervalMs ?? 1_000);
  let timer: PlanTimerHandle | null = null;
  let stopped = false;
  let inFlight = false;

  const scheduleNext = () => {
    if (stopped || inFlight || !options.isActive()) return;
    timer = schedule(() => {
      timer = null;
      if (stopped || inFlight || !options.isActive()) return;
      inFlight = true;
      void options.recover().catch(() => false).finally(() => {
        inFlight = false;
        scheduleNext();
      });
    }, intervalMs);
  };
  scheduleNext();
  return () => {
    stopped = true;
    if (timer !== null) cancel(timer);
    timer = null;
  };
}

export function createPlanAutoStartController(options: {
  retryDelayMs?: number;
  schedule?: (callback: () => void, delay: number) => PlanTimerHandle;
  cancel?: (handle: PlanTimerHandle) => void;
}) {
  const schedule = options.schedule ?? ((callback, delay) => globalThis.setTimeout(callback, delay));
  const cancel = options.cancel ?? ((handle) => globalThis.clearTimeout(handle));
  const retryDelayMs = Math.max(1, options.retryDelayMs ?? 750);
  let scope: string | null = null;
  const entries = new Map<string, {
    scope: string;
    isEligible: () => boolean;
    start: () => Promise<void>;
    onFailure: (error: unknown) => void;
    inFlight: boolean;
    timer: PlanTimerHandle | null;
  }>();

  const attempt = (key: string) => {
    const entry = entries.get(key);
    if (!entry || entry.inFlight || entry.timer !== null || scope !== entry.scope) return;
    if (!entry.isEligible()) {
      entries.delete(key);
      return;
    }
    entry.inFlight = true;
    void entry.start().then(() => {
      entry.inFlight = false;
      entries.delete(key);
    }, (error) => {
      entry.inFlight = false;
      if (scope !== entry.scope) {
        entries.delete(key);
        return;
      }
      if (!isPlanRuntimeBusyError(error)) {
        entries.delete(key);
        entry.onFailure(error);
        return;
      }
      if (!entry.isEligible()) {
        entries.delete(key);
        return;
      }
      entry.timer = schedule(() => {
        entry.timer = null;
        attempt(key);
      }, retryDelayMs);
    });
  };

  return {
    setScope(nextScope: string | null): void {
      scope = nextScope;
      for (const [key, entry] of entries) {
        if (entry.scope === nextScope) continue;
        if (entry.timer !== null) cancel(entry.timer);
        entry.timer = null;
        if (!entry.inFlight) entries.delete(key);
      }
    },
    start(input: {
      key: string;
      isEligible: () => boolean;
      start: () => Promise<void>;
      onFailure: (error: unknown) => void;
    }): void {
      if (!scope) return;
      const existing = entries.get(input.key);
      if (existing) {
        existing.isEligible = input.isEligible;
        existing.start = input.start;
        existing.onFailure = input.onFailure;
        if (existing.scope !== scope && !existing.inFlight) existing.scope = scope;
      } else {
        entries.set(input.key, {
          scope,
          isEligible: input.isEligible,
          start: input.start,
          onFailure: input.onFailure,
          inFlight: false,
          timer: null,
        });
      }
      attempt(input.key);
    },
  };
}

export async function loadPlanRuntimeState(
  adapter: InMemoryPlanAdapter,
  planSessionId: string,
  projectRoot: string,
): Promise<PlanRuntimeStateResult> {
  try {
    const request = { planSessionId, projectRoot };
    const state = await adapter.getState(request);
    if (!state.needsBootstrap) return state;
    await adapter.bootstrap(request);
    const bootstrapped = await adapter.getState(request);
    if (bootstrapped.needsBootstrap) throw runtimeStateError();
    return bootstrapped;
  } catch {
    throw new Error(PLAN_RUNTIME_STATE_ERROR);
  }
}

export function createPlanAdapter(
  desktopBridge: unknown,
  emit: (event: PlanEvent) => void,
): InMemoryPlanAdapter {
  if (desktopBridge === undefined) return createInMemoryPlanAdapter(emit);
  if (isRecord(desktopBridge) && isPlanAdapter(desktopBridge.plan)) return desktopBridge.plan;
  return unavailablePlanAdapter();
}

export function createPlanMutationQueue(
  adapter: Pick<
    InMemoryPlanAdapter,
    "generate" | "revise" | "updateStage" | "acceptStage" | "undoStage"
  >,
  getSession: (planSessionId: string) => PlanSession | null,
  applySession: (session: PlanSession) => void,
) {
  const tails = new Map<string, Promise<unknown>>();
  const editTrackers = new Map<string, {
    document: PlanSession["plan"];
    generations: Record<PlanStage, number>;
  }>();

  function enqueue<T>(planSessionId: string, operation: () => Promise<T>): Promise<T> {
    const previous = tails.get(planSessionId) ?? Promise.resolve();
    const result = previous.catch(() => undefined).then(operation);
    const settled = result.then(() => undefined, () => undefined);
    tails.set(planSessionId, settled);
    void settled.finally(() => {
      if (tails.get(planSessionId) === settled) tails.delete(planSessionId);
    });
    return result;
  }

  function current(planSessionId: string): PlanSession {
    const session = getSession(planSessionId);
    if (!session) throw runtimeStateError();
    return session;
  }

  function observe(session: PlanSession) {
    const existing = editTrackers.get(session.id);
    if (!existing) {
      const created = {
        document: { ...session.plan },
        generations: { requirements: 0, design: 0, tasks: 0 },
      };
      editTrackers.set(session.id, created);
      return created;
    }
    for (const stage of stageOrder) {
      if (existing.document[stage] !== session.plan[stage]) existing.generations[stage] += 1;
    }
    existing.document = { ...session.plan };
    return existing;
  }

  function captureBoundary(planSessionId: string) {
    const session = current(planSessionId);
    const tracker = observe(session);
    return {
      session,
      document: { ...session.plan },
      generations: { ...tracker.generations },
    };
  }

  function applyResponse(
    planSessionId: string,
    boundary: ReturnType<typeof captureBoundary>,
    result: PlanStateTransitionResult,
  ): PlanSession {
    const live = current(planSessionId);
    const tracker = observe(live);
    const desired = { ...live.plan };
    let next = applyPlanStateSnapshot(live, result.snapshot);
    for (const stage of stageOrder) {
      if (tracker.generations[stage] > boundary.generations[stage] && next.plan[stage] !== desired[stage]) {
        next = editPlanStage(next, stage, desired[stage]);
      }
    }
    applySession(next);
    tracker.document = { ...next.plan };
    return next;
  }

  async function submitUpdate(
    projectRoot: string,
    planSessionId: string,
    stage: PlanStage,
  ): Promise<{ result: PlanStateTransitionResult; next: PlanSession }> {
    const boundary = captureBoundary(planSessionId);
    const result = await adapter.updateStage({
      planSessionId,
      projectRoot,
      stage,
      expectedStateVersion: boundary.session.stateVersion,
      markdown: boundary.document[stage],
    });
    return { result, next: applyResponse(planSessionId, boundary, result) };
  }

  async function persistDifferences(
    projectRoot: string,
    planSessionId: string,
    result: PlanStateTransitionResult,
    next: PlanSession,
  ): Promise<PlanStateTransitionResult> {
    let authoritative = result;
    let currentSession = next;
    while (true) {
      const changedStage = stageOrder.find((stage) => (
        currentSession.plan[stage] !== authoritative.snapshot.plan[stage]
      ));
      if (!changedStage) {
        return { protocolVersion: 1, snapshot: clonePlanSnapshot(authoritative.snapshot) };
      }
      const submitted = await submitUpdate(projectRoot, planSessionId, changedStage);
      authoritative = submitted.result;
      currentSession = submitted.next;
    }
  }

  async function persistStable(
    projectRoot: string,
    planSessionId: string,
    stage: PlanStage,
  ): Promise<PlanStateTransitionResult> {
    const submitted = await submitUpdate(projectRoot, planSessionId, stage);
    return persistDifferences(projectRoot, planSessionId, submitted.result, submitted.next);
  }

  async function applyTransition(
    planSessionId: string,
    boundary: ReturnType<typeof captureBoundary>,
    result: PlanStateTransitionResult,
    projectRoot: string,
  ): Promise<PlanStateTransitionResult> {
    const next = applyResponse(planSessionId, boundary, result);
    return persistDifferences(projectRoot, planSessionId, result, next);
  }

  return {
    persistStage(projectRoot: string, planSessionId: string, stage: PlanStage) {
      return enqueue(planSessionId, () => persistStable(projectRoot, planSessionId, stage));
    },
    generate(projectRoot: string, planSessionId: string, stage: PlanStage, goal: string) {
      return enqueue(planSessionId, async () => {
        const persisted = await persistStable(projectRoot, planSessionId, stage);
        return adapter.generate({
          operation: "generate",
          planSessionId,
          projectRoot,
          stage,
          goal,
          expectedStateVersion: persisted.snapshot.version,
        });
      });
    },
    revise(
      projectRoot: string,
      planSessionId: string,
      stage: PlanStage,
      goal: string,
      instruction: string,
    ) {
      return enqueue(planSessionId, async () => {
        const persisted = await persistStable(projectRoot, planSessionId, stage);
        return adapter.revise({
          operation: "revise",
          planSessionId,
          projectRoot,
          stage,
          goal,
          expectedStateVersion: persisted.snapshot.version,
          instruction,
        });
      });
    },
    acceptStage(projectRoot: string, planSessionId: string, stage: PlanStage) {
      return enqueue(planSessionId, async () => {
        const persisted = await persistStable(projectRoot, planSessionId, stage);
        const boundary = captureBoundary(planSessionId);
        const result = await adapter.acceptStage({
          planSessionId,
          projectRoot,
          stage,
          expectedStateVersion: persisted.snapshot.version,
        });
        return applyTransition(planSessionId, boundary, result, projectRoot);
      });
    },
    undoStage(projectRoot: string, planSessionId: string, stage: PlanStage) {
      return enqueue(planSessionId, async () => {
        const persisted = await persistStable(projectRoot, planSessionId, stage);
        const boundary = captureBoundary(planSessionId);
        const result = await adapter.undoStage({
          planSessionId,
          projectRoot,
          stage,
          expectedStateVersion: persisted.snapshot.version,
        });
        return applyTransition(planSessionId, boundary, result, projectRoot);
      });
    },
  };
}

export function reconcilePlanRuntimeState(
  session: PlanSession,
  state: PlanRuntimeStateResult,
): PlanSession {
  if (state.needsBootstrap) throw runtimeStateError();
  const active = state.active;
  let authoritative = applyPlanStateSnapshot(session, state.snapshot);
  if (!active) {
    const terminal = state.terminal;
    if (!terminal) return authoritative;
    if (terminal.planSessionId !== session.id) return authoritative;
    const reconciled = applyPlanTerminalStatus(authoritative, terminal);
    return planRuntimeStateEquals(session, reconciled) ? session : reconciled;
  }
  if (active.planSessionId !== session.id) return authoritative;
  let recovered = bindPlanRunStart(authoritative, {
    protocolVersion: 1,
    planSessionId: active.planSessionId,
    runId: active.runId,
    stage: active.stage,
    operation: active.operation,
    duplicate: true,
  });
  recovered = { ...recovered, conversationStarted: active.conversationReady };
  return updateStage(recovered, active.stage, {
    ...recovered.stages[active.stage],
    draft: active.draft,
  });
}

export function bindPlanRunStart(session: PlanSession, result: PlanRunStartResult): PlanSession {
  if (result.protocolVersion !== 1 || result.planSessionId !== session.id) throw runtimeStateError();
  const current = session.stages[result.stage];
  if (current.lastRunId === result.runId) return session;
  if (current.runId) {
    if (current.runId === result.runId && current.operation === result.operation) return session;
    throw runtimeStateError();
  }
  if (Object.values(session.stages).some((stage) => stage.runId !== null)) throw runtimeStateError();
  return beginPlanRun(session, result.stage, result.operation, result.runId);
}

export function createInMemoryPlanAdapter(emit: (event: PlanEvent) => void): InMemoryPlanAdapter {
  let sequence = 0;
  const states = new Map<string, {
    projectRoot: string;
    snapshot: PlanStateSnapshot;
    active: {
      request: PlanGenerateRequest | PlanReviseRequest;
      runId: string;
      conversationReady: boolean;
      draft: string;
    } | null;
    terminal: Extract<PlanEvent, { kind: "completed" | "failed" }> | null;
  }>();

  function stateFor(planSessionId: string, projectRoot: string) {
    const existing = states.get(planSessionId);
    if (existing && existing.projectRoot !== projectRoot) {
      throw new Error("Plan conversation mapping project does not match.");
    }
    if (existing) return existing;
    const created = { projectRoot, snapshot: emptyPlanSnapshot(), active: null, terminal: null };
    states.set(planSessionId, created);
    return created;
  }

  async function start(input: PlanGenerateRequest | PlanReviseRequest): Promise<PlanRunStartResult> {
    const state = stateFor(input.planSessionId, input.projectRoot);
    const existing = state.active;
    if (existing) {
      if (JSON.stringify(existing.request) !== JSON.stringify(input)) {
        throw new Error("A Plan request is already active for this session.");
      }
      return {
        protocolVersion: 1,
        planSessionId: input.planSessionId,
        runId: existing.runId,
        stage: existing.request.stage,
        operation: existing.request.operation,
        duplicate: true,
      };
    }
    if ([...states.values()].some((candidate) => candidate.active)) throw new Error("Plan runtime is busy.");
    assertInMemoryVersion(state.snapshot, input.expectedStateVersion);
    assertInMemoryRunReady(state.snapshot, input);
    sequence += 1;
    const runId = `browser-plan-run-${sequence}`;
    const identity = {
      protocolVersion: 1 as const,
      planSessionId: input.planSessionId,
      runId,
      stage: input.stage,
      operation: input.operation,
    };
    state.active = {
      request: input,
      runId,
      conversationReady: false,
      draft: "",
    };
    emit({ ...identity, kind: "started" });
    queueMicrotask(() => {
      if (state.active?.runId !== runId) return;
      const markdown = inMemoryMarkdown(input, state.snapshot);
      state.active = { ...state.active, conversationReady: true, draft: markdown };
      emit({ ...identity, kind: "conversation_ready" });
      emit({ ...identity, kind: "delta", text: markdown });
      state.snapshot = inMemoryCompletedSnapshot(state.snapshot, input, markdown);
      const terminal = {
        ...identity,
        kind: "completed" as const,
        markdown,
        checkpoints: cloneCheckpointState(state.snapshot.checkpoints),
        snapshot: clonePlanSnapshot(state.snapshot),
      };
      state.terminal = terminal;
      state.active = null;
      emit(terminal);
    });
    return {
      protocolVersion: 1,
      planSessionId: input.planSessionId,
      runId,
      stage: input.stage,
      operation: input.operation,
      duplicate: false,
    };
  }

  return {
    generate: start,
    revise: start,
    async updateStage(input) {
      const state = stateFor(input.planSessionId, input.projectRoot);
      assertNoInMemoryActive(states, state);
      assertInMemoryVersion(state.snapshot, input.expectedStateVersion);
      if (state.snapshot.plan[input.stage] !== input.markdown) {
        assertInMemoryUpstream(state.snapshot, input.stage);
        const snapshot = clonePlanSnapshot(state.snapshot);
        snapshot.version += 1;
        snapshot.plan[input.stage] = input.markdown;
        snapshot.accepted[input.stage] = false;
        clearInMemoryDownstream(snapshot, input.stage);
        state.snapshot = parsePlanStateSnapshot(snapshot);
        state.terminal = null;
      }
      return { protocolVersion: 1, snapshot: clonePlanSnapshot(state.snapshot) };
    },
    async acceptStage(input) {
      const state = stateFor(input.planSessionId, input.projectRoot);
      assertNoInMemoryActive(states, state);
      assertInMemoryVersion(state.snapshot, input.expectedStateVersion);
      assertInMemoryStageReady(state.snapshot, input.stage);
      if (!state.snapshot.accepted[input.stage]) {
        state.snapshot = clonePlanSnapshot(state.snapshot);
        state.snapshot.version += 1;
        state.snapshot.accepted[input.stage] = true;
        state.terminal = null;
      }
      return { protocolVersion: 1, snapshot: clonePlanSnapshot(state.snapshot) };
    },
    async undoStage(input) {
      const state = stateFor(input.planSessionId, input.projectRoot);
      assertNoInMemoryActive(states, state);
      assertInMemoryVersion(state.snapshot, input.expectedStateVersion);
      const checkpoints = state.snapshot.checkpoints[input.stage];
      if (checkpoints.length === 0) throw new Error("Plan state transition is invalid.");
      const snapshot = clonePlanSnapshot(state.snapshot);
      snapshot.version += 1;
      snapshot.plan[input.stage] = checkpoints[checkpoints.length - 1] ?? snapshot.plan[input.stage];
      snapshot.accepted[input.stage] = false;
      snapshot.checkpoints[input.stage] = checkpoints.slice(0, -1);
      clearInMemoryDownstream(snapshot, input.stage);
      state.snapshot = snapshot;
      state.terminal = null;
      return { protocolVersion: 1, snapshot: clonePlanSnapshot(state.snapshot) };
    },
    async cancel(input) {
      const state = stateFor(input.planSessionId, input.projectRoot);
      const current = state.active;
      if (!current || current.runId !== input.runId) return { protocolVersion: 1, cancelled: false };
      const terminal = {
        protocolVersion: 1,
        planSessionId: input.planSessionId,
        runId: current.runId,
        stage: current.request.stage,
        operation: current.request.operation,
        kind: "failed",
        error: "Plan generation was cancelled.",
        checkpoints: cloneCheckpointState(state.snapshot.checkpoints),
        snapshot: clonePlanSnapshot(state.snapshot),
      } as const;
      state.active = null;
      state.terminal = terminal;
      emit(terminal);
      return { protocolVersion: 1, cancelled: true };
    },
    async bootstrap(input) {
      const existing = states.get(input.planSessionId);
      if (existing && existing.projectRoot !== input.projectRoot) {
        throw new Error("Plan conversation mapping project does not match.");
      }
      const state = existing ?? {
        projectRoot: input.projectRoot,
        snapshot: emptyPlanSnapshot(),
        active: null,
        terminal: null,
      };
      if (!existing) states.set(input.planSessionId, state);
      return inMemoryStateResult(input.planSessionId, state);
    },
    async getState(input) {
      const state = states.get(input.planSessionId);
      if (!state) {
        return {
          protocolVersion: 1,
          needsBootstrap: true,
          snapshot: emptyPlanSnapshot(),
          active: null,
          terminal: null,
        };
      }
      if (state.projectRoot !== input.projectRoot) {
        throw new Error("Plan conversation mapping project does not match.");
      }
      return inMemoryStateResult(input.planSessionId, state);
    },
  };
}

function inMemoryStateResult(
  planSessionId: string,
  state: {
    snapshot: PlanStateSnapshot;
    active: {
      request: PlanGenerateRequest | PlanReviseRequest;
      runId: string;
      conversationReady: boolean;
      draft: string;
    } | null;
    terminal: Extract<PlanEvent, { kind: "completed" | "failed" }> | null;
  },
): PlanRuntimeStateResult {
  const current = state.active;
  return {
    protocolVersion: 1,
    needsBootstrap: false,
    snapshot: clonePlanSnapshot(state.snapshot),
    active: current
      ? {
          planSessionId,
          runId: current.runId,
          stage: current.request.stage,
          operation: current.request.operation,
          conversationReady: current.conversationReady,
          draft: current.draft,
          checkpoints: cloneCheckpointState(state.snapshot.checkpoints),
        }
      : null,
    terminal: state.terminal,
  };
}

function inMemoryMarkdown(
  input: PlanGenerateRequest | PlanReviseRequest,
  snapshot: PlanStateSnapshot,
): string {
  if (input.operation === "revise") {
    return `${snapshot.plan[input.stage].trimEnd()}\n\n## Revision\n\n${input.instruction.trim()}`;
  }
  if (input.stage === "requirements") return `# Requirements\n\n## Goal\n\n${input.goal}`;
  if (input.stage === "design") return "# Design\n\nDerived from the completed Requirements.";
  return "# Tasks\n\n- [ ] Implement the approved Design.\n- [ ] Verify the completed Requirements.";
}

function emptyPlanSnapshot(): PlanStateSnapshot {
  return {
    version: 0,
    plan: { requirements: "", design: "", tasks: "" },
    accepted: { requirements: false, design: false, tasks: false },
    checkpoints: emptyCheckpointState(),
  };
}

function clonePlanSnapshot(snapshot: PlanStateSnapshot): PlanStateSnapshot {
  return {
    version: snapshot.version,
    plan: { ...snapshot.plan },
    accepted: { ...snapshot.accepted },
    checkpoints: cloneCheckpointState(snapshot.checkpoints),
  };
}

function inMemoryCompletedSnapshot(
  base: PlanStateSnapshot,
  input: PlanGenerateRequest | PlanReviseRequest,
  markdown: string,
): PlanStateSnapshot {
  const snapshot = clonePlanSnapshot(base);
  snapshot.version += 1;
  if (input.operation === "revise") {
    snapshot.checkpoints[input.stage] = [
      ...snapshot.checkpoints[input.stage],
      snapshot.plan[input.stage],
    ].slice(-maxCheckpoints);
  }
  snapshot.plan[input.stage] = markdown;
  snapshot.accepted[input.stage] = false;
  clearInMemoryDownstream(snapshot, input.stage);
  return snapshot;
}

function clearInMemoryDownstream(snapshot: PlanStateSnapshot, stage: PlanStage): void {
  for (const downstream of stageOrder.slice(stageOrder.indexOf(stage) + 1)) {
    snapshot.plan[downstream] = "";
    snapshot.accepted[downstream] = false;
    snapshot.checkpoints[downstream] = [];
  }
}

function assertInMemoryVersion(snapshot: PlanStateSnapshot, expected: number): void {
  if (!Number.isSafeInteger(expected) || expected < 0 || snapshot.version !== expected) {
    throw new Error("Plan state version conflict.");
  }
}

function assertInMemoryRunReady(
  snapshot: PlanStateSnapshot,
  input: PlanGenerateRequest | PlanReviseRequest,
): void {
  assertInMemoryUpstream(snapshot, input.stage);
  if (input.operation === "generate" && snapshot.accepted[input.stage]) {
    throw new Error("Plan state transition is invalid.");
  }
  if (input.operation === "revise" && !snapshot.plan[input.stage].trim()) {
    throw new Error("Plan state transition is invalid.");
  }
}

function assertInMemoryStageReady(snapshot: PlanStateSnapshot, stage: PlanStage): void {
  assertInMemoryUpstream(snapshot, stage);
  if (!snapshot.plan[stage].trim()) throw new Error("Plan state transition is invalid.");
}

function assertInMemoryUpstream(snapshot: PlanStateSnapshot, stage: PlanStage): void {
  for (const upstream of stageOrder.slice(0, stageOrder.indexOf(stage))) {
    if (!snapshot.accepted[upstream] || !snapshot.plan[upstream].trim()) {
      throw new Error("Plan state transition is invalid.");
    }
  }
}

function assertNoInMemoryActive(
  states: ReadonlyMap<string, { active: unknown }>,
  state: { active: unknown },
): void {
  if (state.active || [...states.values()].some((candidate) => candidate.active)) {
    throw new Error("Plan runtime is busy.");
  }
}

function beginPlanRun(
  session: PlanSession,
  stage: PlanStage,
  operation: PlanOperation,
  runId: string,
): PlanSession {
  const current = session.stages[stage];
  return clearDownstreamPlanMaterial(updateStage(
    { ...session, activeStage: stage },
    stage,
    {
      ...current,
      status: operation === "revise" ? "revising" : "generating",
      accepted: false,
      draft: "",
      error: null,
      runId,
      operation,
    },
  ), stage);
}

function applyAuthoritativePlanTerminal(
  session: PlanSession,
  event: Extract<PlanEvent, { kind: "completed" | "failed" }>,
): PlanSession {
  const authoritative = applyPlanStateSnapshot(session, event.snapshot);
  const applied = applyPlanTerminalStatus(authoritative, event);
  return planRuntimeStateEquals(session, applied) ? session : applied;
}

function applyPlanTerminalStatus(
  authoritative: PlanSession,
  event: Extract<PlanEvent, { kind: "completed" | "failed" }>,
): PlanSession {
  if (terminalAlreadyApplied(authoritative, event)) return authoritative;
  const current = authoritative.stages[event.stage];
  if (event.kind === "failed") {
    return updateStage(authoritative, event.stage, {
      ...current,
      status: "failed",
      draft: "",
      error: event.error,
      runId: null,
      lastRunId: event.runId,
      operation: event.operation,
    });
  }
  const result = updateStage(
    {
      ...authoritative,
      conversationStarted: true,
    },
    event.stage,
    {
      ...current,
      status: "ready",
      draft: "",
      error: null,
      runId: null,
      lastRunId: event.runId,
    },
  );
  return result;
}

function planRuntimeStateEquals(left: PlanSession, right: PlanSession): boolean {
  return left.stateVersion === right.stateVersion &&
    left.conversationStarted === right.conversationStarted &&
    stageOrder.every((stage) => {
      const leftStage = left.stages[stage];
      const rightStage = right.stages[stage];
      return left.plan[stage] === right.plan[stage] &&
        leftStage.status === rightStage.status &&
        leftStage.accepted === rightStage.accepted &&
        leftStage.draft === rightStage.draft &&
        leftStage.error === rightStage.error &&
        leftStage.runId === rightStage.runId &&
        leftStage.lastRunId === rightStage.lastRunId &&
        leftStage.operation === rightStage.operation &&
        arraysEqual(leftStage.checkpoints, rightStage.checkpoints);
    });
}

function terminalAlreadyApplied(
  session: PlanSession,
  event: Extract<PlanEvent, { kind: "completed" | "failed" }>,
): boolean {
  const current = session.stages[event.stage];
  if (
    current.lastRunId !== event.runId ||
    current.runId !== null ||
    current.draft !== "" ||
    session.stateVersion !== event.snapshot.version ||
    !checkpointStateEquals(session, event.snapshot.checkpoints)
  ) {
    return false;
  }
  if (event.kind === "failed") return current.status === "failed" && current.error === event.error;
  if (
    current.status !== "ready" ||
    current.error !== null ||
    !session.conversationStarted ||
    session.plan[event.stage] !== event.markdown
  ) return false;
  if (event.operation !== "revise") return true;
  return stageOrder.slice(stageOrder.indexOf(event.stage) + 1).every((stage) => (
    session.plan[stage] === "" &&
    session.stages[stage].status === "pending" &&
    !session.stages[stage].accepted &&
    session.stages[stage].draft === "" &&
    session.stages[stage].error === null &&
    session.stages[stage].runId === null &&
    session.stages[stage].operation === null
  ));
}

function checkpointStateEquals(session: PlanSession, checkpoints: PlanCheckpointState): boolean {
  return stageOrder.every((stage) => arraysEqual(session.stages[stage].checkpoints, checkpoints[stage]));
}

function emptyCheckpointState(): PlanCheckpointState {
  return { requirements: [], design: [], tasks: [] };
}


function cloneCheckpointState(checkpoints: PlanCheckpointState): PlanCheckpointState {
  return {
    requirements: [...checkpoints.requirements],
    design: [...checkpoints.design],
    tasks: [...checkpoints.tasks],
  };
}

function arraysEqual(left: string[], right: string[]): boolean {
  return left.length === right.length && left.every((value, index) => value === right[index]);
}

function clearDownstreamPlanMaterial(session: PlanSession, stage: PlanStage): PlanSession {
  const downstreamStages = stageOrder.slice(stageOrder.indexOf(stage) + 1);
  if (downstreamStages.length === 0) return session;
  const stages = { ...session.stages };
  for (const downstream of downstreamStages) {
    stages[downstream] = {
      ...stages[downstream],
      accepted: false,
      checkpoints: [],
    };
  }
  return { ...session, stages };
}

function invalidateDownstreamStages(session: PlanSession, stage: PlanStage): PlanSession {
  const start = stageOrder.indexOf(stage) + 1;
  if (start <= 0 || start >= stageOrder.length) return session;
  const stages = { ...session.stages };
  const plan = { ...session.plan };
  for (const downstream of stageOrder.slice(start)) {
    const state = stages[downstream];
    stages[downstream] = {
      ...state,
      status: "pending",
      accepted: false,
      draft: "",
      error: null,
      runId: null,
      operation: null,
      checkpoints: [],
    };
    plan[downstream] = "";
  }
  return { ...session, plan, stages };
}

function unavailablePlanAdapter(): InMemoryPlanAdapter {
  const unavailable = () => Promise.reject(new Error(PLAN_BACKEND_UNAVAILABLE_ERROR));
  return {
    generate: unavailable,
    revise: unavailable,
    updateStage: unavailable,
    acceptStage: unavailable,
    undoStage: unavailable,
    cancel: unavailable,
    bootstrap: unavailable,
    getState: unavailable,
  };
}

function isPlanAdapter(value: unknown): value is InMemoryPlanAdapter {
  return isRecord(value) &&
    typeof value.generate === "function" &&
    typeof value.revise === "function" &&
    typeof value.updateStage === "function" &&
    typeof value.acceptStage === "function" &&
    typeof value.undoStage === "function" &&
    typeof value.cancel === "function" &&
    typeof value.bootstrap === "function" &&
    typeof value.getState === "function";
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

function runtimeStateError(): Error {
  return new Error(PLAN_RUNTIME_STATE_ERROR);
}

function updateStage(session: PlanSession, stage: PlanStage, state: PlanStageState): PlanSession {
  return {
    ...session,
    updatedAt: new Date().toISOString(),
    stages: { ...session.stages, [stage]: state },
  };
}
