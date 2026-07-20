import { createHash, randomUUID as nodeRandomUUID } from "node:crypto";
import {
  chmod,
  link,
  lstat,
  mkdir,
  open,
  readFile,
  rename,
  unlink,
} from "node:fs/promises";
import path from "node:path";

import type { HermesAcpClient } from "@skyturn/agent-bridge" with { "resolution-mode": "import" };
import type {
  PlanAcceptStageRequest,
  PlanBootstrapRequest,
  PlanCancelRequest,
  PlanCheckpointState,
  PlanEvent,
  PlanGenerateRequest,
  PlanGetStateRequest,
  PlanOperation,
  PlanReviseRequest,
  PlanRunRequest,
  PlanRunStartResult,
  PlanRuntimeStateResult,
  PlanStage,
  PlanStateSnapshot,
  PlanStateTransitionResult,
  PlanUndoStageRequest,
  PlanUpdateStageRequest,
} from "@skyturn/project-core" with { "resolution-mode": "import" };

interface PlanPromptInput {
  operation: PlanOperation;
  stage: PlanStage;
  goal: string;
  projectContext: string;
  requirements: string;
  design: string;
  currentMarkdown?: string;
  instruction?: string;
}

interface PlanRuntimeOptions {
  stateRoot: string;
  createClient?: (signal: AbortSignal) => Promise<HermesAcpClient>;
  buildPrompt?: (input: PlanPromptInput) => Promise<string>;
  emit: (event: PlanEvent) => void;
  randomUUID?: () => string;
  promptTimeoutMs?: number;
  cancelSettlementGraceMs?: number;
  syncDirectory?: (directory: string) => Promise<void>;
}

interface DurableActivePlanRun {
  runId: string;
  stage: PlanStage;
  operation: PlanOperation;
  baseVersion: number;
}

interface DurablePlanTerminal {
  runId: string;
  stage: PlanStage;
  operation: PlanOperation;
  kind: "completed" | "failed";
  error?: string;
}

interface DurablePlanState {
  version: 3;
  planKey: string;
  projectKey: string;
  conversationEstablished: boolean;
  snapshot: PlanStateSnapshot;
  active: DurableActivePlanRun | null;
  terminal: DurablePlanTerminal | null;
}

interface ActivePlanRun {
  request: PlanRunRequest;
  fingerprint: string;
  runId: string;
  rawSessionId: string | null;
  conversationReady: boolean;
  draft: string;
  snapshot: PlanStateSnapshot;
  accepted: boolean;
  acceptance: Promise<void> | null;
  settlement: Promise<void> | null;
  terminal: boolean;
  terminalization: Promise<boolean> | null;
  cancelling: boolean;
}

interface PlanMapping {
  version: 1;
  planKey: string;
  projectKey: string;
  acpSessionId: string;
}

type MappingRead = { status: "missing" } | { status: "valid"; mapping: PlanMapping };
type PlanStateRead = { status: "missing" } | { status: "valid"; state: DurablePlanState; legacy: boolean };
type PlanTerminalEvent = Extract<PlanEvent, { kind: "completed" | "failed" }>;

const protocolVersion = 1 as const;
const recordVersion = 3 as const;
const planStages: PlanStage[] = ["requirements", "design", "tasks"];
const defaultPromptTimeoutMs = 5 * 60_000;
const defaultCancelSettlementGraceMs = 250;
const runtimeShutdownError = "Plan runtime is shut down.";
const planBusyError = "Plan runtime is busy.";
const planStateVersionError = "Plan state version conflict.";
const planStateTransitionError = "Plan state transition is invalid.";
const planStatePersistenceError = "Plan state persistence is unavailable.";
const planStateBootstrapConflictError = "Plan state bootstrap conflict.";
const planSessionRestartError = "Plan session state is indeterminate. Restart SkyTurn.";
const orphanedRunError = "Plan generation was interrupted. Retry to continue.";
const maxPlanMarkdownLength = 2_000_000;
const maxPlanCheckpoints = 20;
const maxAcpSessionIdLength = 4_096;
const maxPlanStateFileBytes = maxPlanMarkdownLength * (3 + maxPlanCheckpoints * 3) * 6 + 20_000;
const maxPlanMappingFileBytes = maxAcpSessionIdLength * 6 + 1_024;

export function createPlanRuntime(options: PlanRuntimeOptions) {
  const activeRuns = new Map<string, ActivePlanRun>();
  const poisonedPlanSessions = new Set<string>();
  let loadedPlanSessionId: string | null = null;
  let client: HermesAcpClient | null = null;
  let clientPromise: Promise<HermesAcpClient> | null = null;
  let clientFactoryCleanup: Promise<void> | null = null;
  let clientCreationAbort: AbortController | null = null;
  let stateQueue: Promise<void> = Promise.resolve();
  let closed = false;
  let closePromise: Promise<void> | null = null;

  function serializeState<T>(operation: () => Promise<T>): Promise<T> {
    const result = stateQueue.then(operation, operation);
    stateQueue = result.then(() => undefined, () => undefined);
    return result;
  }

  function assertSessionAvailable(planSessionId: string): void {
    if (poisonedPlanSessions.has(planSessionId)) throw new Error(planSessionRestartError);
  }

  async function persistPlanState(planSessionId: string, state: DurablePlanState): Promise<void> {
    assertSessionAvailable(planSessionId);
    try {
      await writePlanState(options.stateRoot, planSessionId, state, options.syncDirectory);
    } catch (error) {
      if (error instanceof IndeterminatePlanStateError) {
        poisonedPlanSessions.add(planSessionId);
        throw new Error(planSessionRestartError);
      }
      throw error;
    }
  }

  async function initializePlanState(planSessionId: string, state: DurablePlanState): Promise<boolean> {
    assertSessionAvailable(planSessionId);
    try {
      return await writeInitialPlanState(options.stateRoot, planSessionId, state, options.syncDirectory);
    } catch (error) {
      if (error instanceof IndeterminatePlanStateError) {
        poisonedPlanSessions.add(planSessionId);
        throw new Error(planSessionRestartError);
      }
      throw error;
    }
  }

  async function getClient(): Promise<HermesAcpClient> {
    if (closed) throw new Error(runtimeShutdownError);
    if (client && !client.isClosed()) return client;
    if (client?.isClosed()) {
      client = null;
      loadedPlanSessionId = null;
    }
    if (!clientPromise) {
      const controller = new AbortController();
      let createdClose: Promise<void> | null = null;
      const closeCreated = (created: HermesAcpClient): Promise<void> => {
        if (!createdClose) createdClose = created.close();
        return createdClose;
      };
      const created = Promise.resolve().then(() => (
        options.createClient ? options.createClient(controller.signal) : defaultClientFactory(controller.signal)
      ));
      let rejectAbort = (_error: Error): void => {};
      const abort = (): void => rejectAbort(
        new Error(closed ? runtimeShutdownError : "Plan generation was cancelled."),
      );
      const aborted = new Promise<never>((_resolve, reject) => {
        rejectAbort = reject;
      });
      controller.signal.addEventListener("abort", abort, { once: true });
      const pending = Promise.race([created, aborted]).then(async (createdClient) => {
        if (controller.signal.aborted || closed) {
          await closeCreated(createdClient);
          throw new Error(closed ? runtimeShutdownError : "Plan generation was cancelled.");
        }
        client = createdClient;
        loadedPlanSessionId = null;
        return createdClient;
      });
      clientPromise = pending;
      void pending.then(
        () => controller.signal.removeEventListener("abort", abort),
        () => controller.signal.removeEventListener("abort", abort),
      );
      clientCreationAbort = controller;
      const cleanup = created.then(async (createdClient) => {
        if (controller.signal.aborted || closed) await closeCreated(createdClient);
      }, () => undefined).finally(() => {
        if (clientPromise === pending) clientPromise = null;
        if (clientFactoryCleanup === cleanup) clientFactoryCleanup = null;
        if (clientCreationAbort === controller) clientCreationAbort = null;
      });
      clientFactoryCleanup = cleanup;
    }
    return clientPromise;
  }

  async function start(input: PlanRunRequest): Promise<PlanRunStartResult> {
    if (closed) throw new Error(runtimeShutdownError);
    const request = narrowRunRequest(input);
    assertSessionAvailable(request.planSessionId);
    const fingerprint = requestFingerprint(request);
    const existing = activeRuns.get(request.planSessionId);
    if (existing) {
      if (existing.fingerprint !== fingerprint) throw new Error("A Plan request is already active for this session.");
      await existing.acceptance;
      return startResult(existing, true);
    }
    if (activeRuns.size > 0) throw new Error(planBusyError);

    const active: ActivePlanRun = {
      request,
      fingerprint,
      runId: (options.randomUUID ?? nodeRandomUUID)(),
      rawSessionId: null,
      conversationReady: false,
      draft: "",
      snapshot: emptySnapshot(),
      accepted: false,
      acceptance: null,
      settlement: null,
      terminal: false,
      terminalization: null,
      cancelling: false,
    };
    activeRuns.set(request.planSessionId, active);
    active.acceptance = serializeState(() => acceptRun(active));
    await active.acceptance;
    return startResult(active, false);
  }

  async function acceptRun(active: ActivePlanRun): Promise<void> {
    try {
      assertSessionAvailable(active.request.planSessionId);
      const bound = await readBoundPlanState(active.request.planSessionId, active.request.projectRoot);
      const state = bound.state;
      if (state.active) throw new Error(planBusyError);
      assertExpectedVersion(state.snapshot, active.request.expectedStateVersion);
      assertRunTransition(state.snapshot, active.request);
      active.snapshot = cloneSnapshot(state.snapshot);
      const durableActive: DurableActivePlanRun = {
        runId: active.runId,
        stage: active.request.stage,
        operation: active.request.operation,
        baseVersion: active.snapshot.version,
      };
      await persistPlanState(active.request.planSessionId, {
        ...state,
        snapshot: cloneSnapshot(active.snapshot),
        active: durableActive,
      });
      if (closed) throw new Error(runtimeShutdownError);
      active.accepted = true;
      emitTransient(active, { kind: "started" });
      active.settlement = execute(active);
      void active.settlement;
    } catch (error) {
      if (activeRuns.get(active.request.planSessionId) === active) activeRuns.delete(active.request.planSessionId);
      throw fixedStartError(error);
    }
  }

  async function execute(active: ActivePlanRun): Promise<void> {
    try {
      const acp = await getClient();
      await assertRunMayContinue(active, acp);
      const rawSessionId = await ensureConversation(acp, active);
      active.rawSessionId = rawSessionId;
      await assertRunMayContinue(active, acp);
      active.conversationReady = true;
      emitTransient(active, { kind: "conversation_ready" });
      const promptInput = promptInputFor(active.request, active.snapshot);
      const prompt = await (options.buildPrompt ? options.buildPrompt(promptInput) : defaultPromptBuilder(promptInput));
      await assertRunMayContinue(active, acp);
      await acp.prompt(rawSessionId, prompt, {
        timeoutMs: options.promptTimeoutMs ?? defaultPromptTimeoutMs,
        redactProjectRoot: active.request.projectRoot,
        onText: (text) => {
          if (active.terminal || closed) return;
          active.draft += text;
          emitTransient(active, { kind: "delta", text });
        },
      });
      if (active.terminal || closed) return;
      if (!active.draft.trim()) throw new Error("Hermes ACP returned empty Markdown.");
      await terminalize(active, { kind: "completed" });
    } catch (error) {
      if (client?.isClosed()) {
        client = null;
        loadedPlanSessionId = null;
      }
      await terminalize(active, { kind: "failed", error: publicPlanError(error) });
    } finally {
      if (!active.cancelling && activeRuns.get(active.request.planSessionId) === active) {
        activeRuns.delete(active.request.planSessionId);
      }
    }
  }

  async function ensureConversation(acp: HermesAcpClient, active: ActivePlanRun): Promise<string> {
    const request = active.request;
    const bound = await serializeState(() => readBoundPlanState(request.planSessionId, request.projectRoot));
    await assertRunMayContinue(active, acp);
    if (bound.mapping.status === "missing") {
      const acpSessionId = await acp.newSession(request.projectRoot);
      await assertRunMayContinue(active, acp);
      await writePlanMapping(
        options.stateRoot,
        request.planSessionId,
        request.projectRoot,
        acpSessionId,
        options.syncDirectory,
      );
      await serializeState(async () => {
        const established = await readBoundPlanState(request.planSessionId, request.projectRoot);
        if (!sameDurableRun(established.state.active, active)) throw new Error(planStatePersistenceError);
        if (established.conversationUpgrade) {
          await persistPlanState(request.planSessionId, established.state);
        }
      });
      loadedPlanSessionId = request.planSessionId;
      return acpSessionId;
    }
    if (bound.conversationUpgrade) {
      await serializeState(() => persistPlanState(request.planSessionId, bound.state));
    }
    if (loadedPlanSessionId !== request.planSessionId) {
      await acp.loadSession(request.projectRoot, bound.mapping.mapping.acpSessionId);
      await assertRunMayContinue(active, acp);
      loadedPlanSessionId = request.planSessionId;
    }
    return bound.mapping.mapping.acpSessionId;
  }

  async function assertRunMayContinue(active: ActivePlanRun, acp: HermesAcpClient): Promise<void> {
    if (!closed && !active.terminal) return;
    await acp.close();
    if (client === acp) client = null;
    loadedPlanSessionId = null;
    throw new Error(closed ? runtimeShutdownError : "Plan generation was cancelled.");
  }

  function terminalize(
    active: ActivePlanRun,
    result: { kind: "completed" } | { kind: "failed"; error: string },
  ): Promise<boolean> {
    if (active.terminalization) return active.terminalization;
    active.terminal = true;
    const snapshot = result.kind === "completed"
      ? completedSnapshot(active.snapshot, active.request, active.draft)
      : cloneSnapshot(active.snapshot);
    const terminal: DurablePlanTerminal = {
      runId: active.runId,
      stage: active.request.stage,
      operation: active.request.operation,
      kind: result.kind,
      ...(result.kind === "failed" ? { error: result.error } : {}),
    };
    const event = terminalEvent(active.request.planSessionId, terminal, snapshot);
    const terminalization = serializeState(async () => {
      try {
        const read = await readPlanState(
          options.stateRoot,
          active.request.planSessionId,
          active.request.projectRoot,
          options.syncDirectory,
        );
        if (read.status !== "valid" || !sameDurableRun(read.state.active, active)) {
          throw new Error(planStatePersistenceError);
        }
        await persistPlanState(active.request.planSessionId, {
          ...read.state,
          snapshot,
          active: null,
          terminal,
        });
      } catch {
        return false;
      }
      try {
        options.emit(event);
      } catch {}
      return true;
    });
    active.terminalization = terminalization;
    return terminalization;
  }

  function emitTransient(
    active: ActivePlanRun,
    payload: { kind: "started" } | { kind: "conversation_ready" } | { kind: "delta"; text: string },
  ): void {
    try {
      options.emit({
        protocolVersion,
        planSessionId: active.request.planSessionId,
        runId: active.runId,
        stage: active.request.stage,
        operation: active.request.operation,
        ...payload,
      });
    } catch {}
  }

  async function mutateState(
    request: PlanAcceptStageRequest,
    transition: (snapshot: PlanStateSnapshot) => PlanStateSnapshot,
  ): Promise<PlanStateTransitionResult> {
    return serializeState(async () => {
      if (closed) throw new Error(runtimeShutdownError);
      assertSessionAvailable(request.planSessionId);
      if (activeRuns.size > 0) throw new Error(planBusyError);
      const bound = await readBoundPlanState(request.planSessionId, request.projectRoot);
      const { read, state } = bound;
      if (state.active) throw new Error(planBusyError);
      assertExpectedVersion(state.snapshot, request.expectedStateVersion);
      const snapshot = transition(cloneSnapshot(state.snapshot));
      if (!snapshotEquals(snapshot, state.snapshot)) {
        await persistPlanState(request.planSessionId, {
          ...state,
          snapshot,
          terminal: null,
        });
      } else if ((read.status === "valid" && read.legacy) || bound.conversationUpgrade) {
        await persistPlanState(request.planSessionId, state);
      }
      return { protocolVersion, snapshot: cloneSnapshot(snapshot) };
    });
  }

  async function readBoundPlanState(
    planSessionId: string,
    projectRoot: string,
  ): Promise<{
    read: PlanStateRead;
    state: DurablePlanState;
    mapping: MappingRead;
    conversationUpgrade: boolean;
  }> {
    assertSessionAvailable(planSessionId);
    const read = await readPlanState(options.stateRoot, planSessionId, projectRoot, options.syncDirectory);
    const state = read.status === "valid" ? read.state : initialState(planSessionId, projectRoot);
    const mapping = await readPlanMapping(options.stateRoot, planSessionId, projectRoot, options.syncDirectory);
    if (state.conversationEstablished && mapping.status === "missing") {
      throw new Error("Plan conversation mapping is missing.");
    }
    const conversationUpgrade = !state.conversationEstablished && mapping.status === "valid";
    return {
      read,
      state: conversationUpgrade ? { ...state, conversationEstablished: true } : state,
      mapping,
      conversationUpgrade,
    };
  }

  return {
    async readFinishPlanHandoff(request: { planSessionId: string; projectRoot: string }): Promise<{
      hermesSessionHandle: string;
      snapshot: PlanStateSnapshot;
    }> {
      return serializeState(async () => {
        if (closed) throw new Error(runtimeShutdownError);
        const bound = await readBoundPlanState(request.planSessionId, request.projectRoot);
        if (bound.read.status !== "valid" || bound.state.active) {
          throw new Error("Approved Plan handoff is unavailable.");
        }
        if (bound.mapping.status !== "valid") throw new Error("Plan conversation mapping is missing.");
        const snapshot = bound.state.snapshot;
        if (planStages.some((stage) => !snapshot.accepted[stage] || !snapshot.plan[stage].trim())) {
          throw new Error("Approved Plan handoff is unavailable.");
        }
        return {
          hermesSessionHandle: bound.mapping.mapping.acpSessionId,
          snapshot: cloneSnapshot(snapshot),
        };
      });
    },
    generate(request: PlanGenerateRequest): Promise<PlanRunStartResult> {
      return start(request);
    },
    revise(request: PlanReviseRequest): Promise<PlanRunStartResult> {
      return start(request);
    },
    updateStage(request: PlanUpdateStageRequest): Promise<PlanStateTransitionResult> {
      return mutateState(request, (snapshot) => updateStageSnapshot(snapshot, request.stage, request.markdown));
    },
    acceptStage(request: PlanAcceptStageRequest): Promise<PlanStateTransitionResult> {
      return mutateState(request, (snapshot) => acceptStageSnapshot(snapshot, request.stage));
    },
    undoStage(request: PlanUndoStageRequest): Promise<PlanStateTransitionResult> {
      return mutateState(request, (snapshot) => undoStageSnapshot(snapshot, request.stage));
    },
    async cancel(request: PlanCancelRequest): Promise<{ protocolVersion: 1; cancelled: boolean }> {
      assertSessionAvailable(request.planSessionId);
      const active = activeRuns.get(request.planSessionId);
      if (!active || active.runId !== request.runId) {
        return serializeState(async () => {
          const bound = await readBoundPlanState(request.planSessionId, request.projectRoot);
          if ((bound.read.status === "valid" && bound.read.legacy) || bound.conversationUpgrade) {
            await persistPlanState(request.planSessionId, bound.state);
          }
          return { protocolVersion, cancelled: false };
        });
      }
      if (active.request.projectRoot !== request.projectRoot) {
        throw new Error("Plan conversation mapping project does not match.");
      }
      active.cancelling = true;
      const terminalization = terminalize(active, { kind: "failed", error: "Plan generation was cancelled." });
      const factoryCleanup = clientFactoryCleanup;
      abortClientCreation();
      try {
        if (active.rawSessionId && client && !client.isClosed()) {
          try {
            await client.cancel(active.rawSessionId);
          } catch {
            await client.close();
          }
        }
        const settlement = active.settlement;
        if (settlement && !await settlesWithin(settlement, options.cancelSettlementGraceMs ?? defaultCancelSettlementGraceMs)) {
          await closePlanClient();
        }
        const [, persisted] = await Promise.all([settlement, terminalization, factoryCleanup]);
        if (!persisted) throw new Error(planStatePersistenceError);
        return { protocolVersion, cancelled: true };
      } finally {
        if (activeRuns.get(request.planSessionId) === active) activeRuns.delete(request.planSessionId);
      }
    },
    bootstrap(
      request: PlanBootstrapRequest,
      bootstrapSnapshot: PlanStateSnapshot,
    ): Promise<PlanRuntimeStateResult> {
      return serializeState(async () => {
        if (closed) throw new Error(runtimeShutdownError);
        assertSessionAvailable(request.planSessionId);
        const snapshot = await parseSnapshot(bootstrapSnapshot);
        const bound = await readBoundPlanState(request.planSessionId, request.projectRoot);
        if (bound.read.status === "valid") {
          if (!snapshotEquals(bound.state.snapshot, snapshot)) {
            throw new Error(planStateBootstrapConflictError);
          }
          try {
            await (options.syncDirectory ?? syncPlanDirectory)(options.stateRoot);
          } catch {
            throw new Error(planStatePersistenceError);
          }
          return runtimeStateResult(request.planSessionId, bound.state, null, false);
        }
        const state: DurablePlanState = {
          ...initialState(request.planSessionId, request.projectRoot),
          conversationEstablished: bound.mapping.status === "valid",
          snapshot: cloneSnapshot(snapshot),
        };
        const created = await initializePlanState(request.planSessionId, state);
        if (created) return runtimeStateResult(request.planSessionId, state, null, false);
        const raced = await readPlanState(
          options.stateRoot,
          request.planSessionId,
          request.projectRoot,
          options.syncDirectory,
        );
        if (raced.status !== "valid" || !snapshotEquals(raced.state.snapshot, snapshot)) {
          throw new Error(planStateBootstrapConflictError);
        }
        return runtimeStateResult(request.planSessionId, raced.state, null, false);
      });
    },
    getState(request: PlanGetStateRequest): Promise<PlanRuntimeStateResult> {
      return serializeState(async () => {
        assertSessionAvailable(request.planSessionId);
        const bound = await readBoundPlanState(request.planSessionId, request.projectRoot);
        const { read } = bound;
        if (read.status === "missing") {
          return runtimeStateResult(
            request.planSessionId,
            initialState(request.planSessionId, request.projectRoot),
            null,
            true,
          );
        }
        let state = bound.state;
        let mustPersist = read.legacy ||
          bound.conversationUpgrade;
        const active = activeRuns.get(request.planSessionId);
        if (active && active.request.projectRoot !== request.projectRoot) {
          throw new Error("Plan conversation mapping project does not match.");
        }
        const liveActive = state.active && active?.accepted && sameDurableRun(state.active, active)
          ? active
          : null;
        if (state.active && !liveActive) {
          const terminal: DurablePlanTerminal = {
            runId: state.active.runId,
            stage: state.active.stage,
            operation: state.active.operation,
            kind: "failed",
            error: orphanedRunError,
          };
          state = { ...state, active: null, terminal };
          mustPersist = true;
        }
        if (mustPersist) await persistPlanState(request.planSessionId, state);
        return runtimeStateResult(request.planSessionId, state, liveActive, false);
      });
    },
    close(): Promise<void> {
      if (closePromise) return closePromise;
      closed = true;
      abortClientCreation();
      const active = [...activeRuns.values()];
      const terminalizations = active
        .filter((run) => run.accepted)
        .map((run) => terminalize(run, { kind: "failed", error: runtimeShutdownError }));
      const acceptances = active
        .filter((run) => !run.accepted)
        .map((run) => run.acceptance?.catch(() => undefined));
      const settlements = active
        .map((run) => run.settlement)
        .filter((settlement): settlement is Promise<void> => settlement !== null);
      closePromise = (async () => {
        await Promise.all([closePlanClient(), ...terminalizations, ...acceptances, ...settlements]);
        client = null;
        clientPromise = null;
        activeRuns.clear();
        loadedPlanSessionId = null;
      })();
      return closePromise;
    },
  };

  async function closePlanClient(): Promise<void> {
    const current = client;
    const factoryCleanup = clientFactoryCleanup;
    abortClientCreation();
    await current?.close();
    await factoryCleanup;
    if (client === current || client?.isClosed()) client = null;
    loadedPlanSessionId = null;
  }

  function abortClientCreation(): void {
    clientCreationAbort?.abort();
  }
}

function runtimeStateResult(
  planSessionId: string,
  state: DurablePlanState,
  active: ActivePlanRun | null,
  needsBootstrap: boolean,
): PlanRuntimeStateResult {
  return {
    protocolVersion,
    needsBootstrap,
    snapshot: cloneSnapshot(state.snapshot),
    active: active
      ? {
          planSessionId: active.request.planSessionId,
          runId: active.runId,
          stage: active.request.stage,
          operation: active.request.operation,
          conversationReady: active.conversationReady,
          draft: active.draft,
          checkpoints: cloneCheckpointState(state.snapshot.checkpoints),
        }
      : null,
    terminal: state.terminal ? terminalEvent(planSessionId, state.terminal, state.snapshot) : null,
  };
}

export function planMappingFileName(planSessionId: string): string {
  return `${planKey(planSessionId)}.json`;
}

export function planTerminalFileName(planSessionId: string): string {
  return `${createHash("sha256").update("skyturn-plan-terminal\0").update(planSessionId).digest("hex")}.json`;
}

export const planStateFileName = planTerminalFileName;

async function readPlanState(
  stateRoot: string,
  planSessionId: string,
  projectRoot: string,
  syncDirectory = syncPlanDirectory,
): Promise<PlanStateRead> {
  await ensurePrivateRoot(stateRoot, syncDirectory);
  const target = path.join(stateRoot, planStateFileName(planSessionId));
  let fileInfo;
  try {
    fileInfo = await lstat(target);
  } catch (error) {
    if (isMissingFileError(error)) return { status: "missing" };
    throw new Error("Plan state is unreadable.");
  }
  if (!fileInfo.isFile() || fileInfo.isSymbolicLink() || fileInfo.size > maxPlanStateFileBytes) {
    throw new Error("Plan state is invalid.");
  }
  if (process.platform !== "win32" && (fileInfo.mode & 0o077) !== 0) {
    throw new Error("Plan state permissions are invalid.");
  }
  try {
    const value = JSON.parse(await readFile(target, "utf8")) as unknown;
    if (!isRecord(value)) throw new Error("invalid");
    assertPersistedIdentity(value, planSessionId, projectRoot);
    if (value.version === 1) {
      return { status: "valid", state: await migrateLegacyTerminal(value, planSessionId, projectRoot), legacy: true };
    }
    const legacyCurrent = value.version === 2;
    const keys = legacyCurrent
      ? ["version", "planKey", "projectKey", "snapshot", "active", "terminal"]
      : ["version", "planKey", "projectKey", "conversationEstablished", "snapshot", "active", "terminal"];
    if ((!legacyCurrent && value.version !== recordVersion) || !hasExactKeys(value, keys)) throw new Error("invalid");
    if (!legacyCurrent && typeof value.conversationEstablished !== "boolean") throw new Error("invalid");
    const snapshot = await parseSnapshot(value.snapshot);
    const active = parseDurableActive(value.active);
    const terminal = parseDurableTerminal(value.terminal);
    if (active && active.baseVersion !== snapshot.version) throw new Error("invalid");
    if (terminal?.kind === "completed" && !snapshot.plan[terminal.stage].trim()) throw new Error("invalid");
    return {
      status: "valid",
      state: {
        version: recordVersion,
        planKey: planKey(planSessionId),
        projectKey: projectKey(projectRoot),
        conversationEstablished: legacyCurrent ? false : value.conversationEstablished as boolean,
        snapshot,
        active,
        terminal,
      },
      legacy: legacyCurrent,
    };
  } catch (error) {
    if (isProjectMismatch(error)) throw error;
    throw new Error("Plan state is invalid.");
  }
}

async function migrateLegacyTerminal(
  value: Record<string, unknown>,
  planSessionId: string,
  projectRoot: string,
): Promise<DurablePlanState> {
  const runId = persistedRunId(value.runId);
  const stage = parseStage(value.stage);
  const operation = parseOperation(value.operation);
  if (value.kind !== "completed" && value.kind !== "failed") throw new Error("invalid");
  const allowed = [
    "version", "planKey", "projectKey", "runId", "stage", "operation", "kind",
    value.kind === "completed" ? "markdown" : "error", "checkpoints", "heads",
  ];
  if (Object.keys(value).some((key) => !allowed.includes(key))) throw new Error("invalid");
  const snapshot = emptySnapshot();
  snapshot.checkpoints = await parseCheckpoints(value.checkpoints ?? emptyCheckpoints());
  if (value.heads !== undefined) {
    const heads = parseLegacyHeads(value.heads);
    for (const item of planStages) snapshot.plan[item] = heads[item] ?? "";
  }
  let terminal: DurablePlanTerminal;
  if (value.kind === "completed") {
    const markdown = nonblankMarkdown(value.markdown);
    if (snapshot.plan[stage] && snapshot.plan[stage] !== markdown) throw new Error("invalid");
    snapshot.plan[stage] = markdown;
    terminal = { runId, stage, operation, kind: "completed" };
  } else {
    const error = publicTerminalError(value.error);
    terminal = { runId, stage, operation, kind: "failed", error };
  }
  return {
    version: recordVersion,
    planKey: planKey(planSessionId),
    projectKey: projectKey(projectRoot),
    conversationEstablished: false,
    snapshot: await parseSnapshot(snapshot),
    active: null,
    terminal,
  };
}

async function writePlanState(
  stateRoot: string,
  planSessionId: string,
  state: DurablePlanState,
  syncDirectory = syncPlanDirectory,
): Promise<void> {
  await ensurePrivateRoot(stateRoot, syncDirectory);
  if (state.planKey !== planKey(planSessionId)) throw new Error(planStatePersistenceError);
  const target = path.join(stateRoot, planStateFileName(planSessionId));
  const previous = await readFile(target).catch((error) => {
    if (isMissingFileError(error)) return null;
    throw error;
  });
  const temporary = path.join(stateRoot, `.${state.planKey}.${nodeRandomUUID()}.state.tmp`);
  let handle: Awaited<ReturnType<typeof open>> | undefined;
  let replaced = false;
  try {
    const persisted = await strictStateForWrite(state);
    handle = await open(temporary, "wx", 0o600);
    await handle.writeFile(JSON.stringify(persisted), "utf8");
    if (process.platform !== "win32") await handle.chmod(0o600);
    await handle.sync();
    await handle.close();
    handle = undefined;
    await rename(temporary, target);
    replaced = true;
    await syncDirectory(stateRoot);
  } catch {
    await handle?.close().catch(() => {});
    await unlink(temporary).catch(() => {});
    if (replaced) {
      try {
        await restorePreviousState(target, previous, stateRoot, state.planKey, syncDirectory);
      } catch {
        throw new IndeterminatePlanStateError();
      }
    }
    throw new Error(planStatePersistenceError);
  }
}

async function writeInitialPlanState(
  stateRoot: string,
  planSessionId: string,
  state: DurablePlanState,
  syncDirectory = syncPlanDirectory,
): Promise<boolean> {
  await ensurePrivateRoot(stateRoot, syncDirectory);
  if (state.planKey !== planKey(planSessionId)) throw new Error(planStatePersistenceError);
  const persisted = await strictStateForWrite(state);
  const target = path.join(stateRoot, planStateFileName(planSessionId));
  const temporary = path.join(stateRoot, `.${state.planKey}.${nodeRandomUUID()}.state.tmp`);
  let handle: Awaited<ReturnType<typeof open>> | undefined;
  let temporaryExists = false;
  let published = false;
  try {
    handle = await open(temporary, "wx", 0o600);
    temporaryExists = true;
    await handle.writeFile(JSON.stringify(persisted), "utf8");
    if (process.platform !== "win32") await handle.chmod(0o600);
    await handle.sync();
    await handle.close();
    handle = undefined;
    try {
      await link(temporary, target);
      published = true;
    } catch (error) {
      if (!isFileExistsError(error)) throw error;
      await unlink(temporary);
      temporaryExists = false;
      await syncDirectory(stateRoot);
      return false;
    }
    try {
      await syncDirectory(stateRoot);
    } catch {
      await unlink(temporary);
      temporaryExists = false;
      await syncDirectory(stateRoot);
      return true;
    }
    await unlink(temporary);
    temporaryExists = false;
    await syncDirectory(stateRoot);
    return true;
  } catch {
    await handle?.close().catch(() => {});
    if (temporaryExists) {
      try {
        await unlink(temporary);
        await syncDirectory(stateRoot);
      } catch {}
    }
    if (published) throw new IndeterminatePlanStateError();
    throw new Error(planStatePersistenceError);
  }
}

async function strictStateForWrite(state: DurablePlanState): Promise<DurablePlanState> {
  if (typeof state.conversationEstablished !== "boolean") throw new Error(planStatePersistenceError);
  return {
    version: recordVersion,
    planKey: persistedHash(state.planKey),
    projectKey: persistedHash(state.projectKey),
    conversationEstablished: state.conversationEstablished,
    snapshot: await parseSnapshot(state.snapshot),
    active: state.active ? parseDurableActive(state.active) : null,
    terminal: state.terminal ? parseDurableTerminal(state.terminal) : null,
  };
}

async function restorePreviousState(
  target: string,
  previous: Buffer | null,
  stateRoot: string,
  key: string,
  syncDirectory: (directory: string) => Promise<void>,
): Promise<void> {
  if (!previous) {
    await unlink(target);
    await syncDirectory(stateRoot);
    return;
  }
  const restore = path.join(stateRoot, `.${key}.${nodeRandomUUID()}.restore.tmp`);
  let handle: Awaited<ReturnType<typeof open>> | undefined;
  try {
    handle = await open(restore, "wx", 0o600);
    await handle.writeFile(previous);
    if (process.platform !== "win32") await handle.chmod(0o600);
    await handle.sync();
    await handle.close();
    handle = undefined;
    await rename(restore, target);
    await syncDirectory(stateRoot);
  } catch (error) {
    await handle?.close().catch(() => {});
    await unlink(restore).catch(() => {});
    throw error;
  }
}

async function readPlanMapping(
  stateRoot: string,
  planSessionId: string,
  projectRoot: string,
  syncDirectory = syncPlanDirectory,
): Promise<MappingRead> {
  await ensurePrivateRoot(stateRoot, syncDirectory);
  const target = path.join(stateRoot, planMappingFileName(planSessionId));
  let fileInfo;
  try {
    fileInfo = await lstat(target);
  } catch (error) {
    if (isMissingFileError(error)) return { status: "missing" };
    throw new Error("Plan conversation mapping is unreadable.");
  }
  if (!fileInfo.isFile() || fileInfo.isSymbolicLink() || fileInfo.size > maxPlanMappingFileBytes) {
    throw new Error("Plan conversation mapping is invalid.");
  }
  if (process.platform !== "win32" && (fileInfo.mode & 0o077) !== 0) {
    throw new Error("Plan conversation mapping permissions are invalid.");
  }
  try {
    const value = JSON.parse(await readFile(target, "utf8")) as unknown;
    if (!hasExactKeys(value, ["version", "planKey", "projectKey", "acpSessionId"])) throw new Error("invalid");
    assertPersistedIdentity(value, planSessionId, projectRoot);
    if (
      value.version !== 1 ||
      typeof value.acpSessionId !== "string" ||
      !value.acpSessionId ||
      value.acpSessionId.length > maxAcpSessionIdLength
    ) throw new Error("invalid");
    return {
      status: "valid",
      mapping: {
        version: 1,
        planKey: planKey(planSessionId),
        projectKey: projectKey(projectRoot),
        acpSessionId: value.acpSessionId,
      },
    };
  } catch (error) {
    if (isProjectMismatch(error)) throw error;
    throw new Error("Plan conversation mapping is invalid.");
  }
}

async function writePlanMapping(
  stateRoot: string,
  planSessionId: string,
  projectRoot: string,
  acpSessionId: string,
  syncDirectory = syncPlanDirectory,
): Promise<void> {
  if (!acpSessionId || acpSessionId.length > maxAcpSessionIdLength) {
    throw new Error("Plan conversation mapping is invalid.");
  }
  await ensurePrivateRoot(stateRoot, syncDirectory);
  const key = planKey(planSessionId);
  const target = path.join(stateRoot, planMappingFileName(planSessionId));
  const temporary = path.join(stateRoot, `.${key}.${nodeRandomUUID()}.tmp`);
  let handle: Awaited<ReturnType<typeof open>> | undefined;
  try {
    handle = await open(temporary, "wx", 0o600);
    await handle.writeFile(JSON.stringify({
      version: 1,
      planKey: key,
      projectKey: projectKey(projectRoot),
      acpSessionId,
    }), "utf8");
    if (process.platform !== "win32") await handle.chmod(0o600);
    await handle.sync();
    await handle.close();
    handle = undefined;
    await rename(temporary, target);
    await syncDirectory(stateRoot);
  } catch {
    await handle?.close().catch(() => {});
    await unlink(temporary).catch(() => {});
    throw new Error("Plan conversation mapping is invalid.");
  }
}

async function syncPlanDirectory(stateRoot: string): Promise<void> {
  if (process.platform === "win32") return;
  const handle = await open(stateRoot, "r");
  try {
    await handle.sync();
  } finally {
    await handle.close();
  }
}

async function ensurePrivateRoot(
  stateRoot: string,
  syncDirectory: (directory: string) => Promise<void>,
): Promise<void> {
  try {
    let created = false;
    try {
      await mkdir(stateRoot, { mode: 0o700 });
      created = true;
    } catch (error) {
      if (!isFileExistsError(error)) throw error;
    }
    const rootInfo = await lstat(stateRoot);
    if (!rootInfo.isDirectory() || rootInfo.isSymbolicLink()) throw new Error("invalid");
    if (process.platform !== "win32") await chmod(stateRoot, 0o700);
    if (created) await syncDirectory(path.dirname(stateRoot));
  } catch {
    throw new Error("Plan conversation mapping root is invalid.");
  }
}

function initialState(planSessionId: string, projectRoot: string): DurablePlanState {
  return {
    version: recordVersion,
    planKey: planKey(planSessionId),
    projectKey: projectKey(projectRoot),
    conversationEstablished: false,
    snapshot: emptySnapshot(),
    active: null,
    terminal: null,
  };
}

function emptySnapshot(): PlanStateSnapshot {
  return {
    version: 0,
    plan: { requirements: "", design: "", tasks: "" },
    accepted: { requirements: false, design: false, tasks: false },
    checkpoints: emptyCheckpoints(),
  };
}

async function parseSnapshot(value: unknown): Promise<PlanStateSnapshot> {
  const { parsePlanStateSnapshot } = await import("@skyturn/project-core");
  return parsePlanStateSnapshot(value);
}

async function parseCheckpoints(value: unknown): Promise<PlanCheckpointState> {
  const { parsePlanCheckpointState } = await import("@skyturn/project-core");
  return parsePlanCheckpointState(value);
}

function cloneSnapshot(snapshot: PlanStateSnapshot): PlanStateSnapshot {
  return {
    version: snapshot.version,
    plan: { ...snapshot.plan },
    accepted: { ...snapshot.accepted },
    checkpoints: cloneCheckpointState(snapshot.checkpoints),
  };
}

function updateStageSnapshot(snapshot: PlanStateSnapshot, stage: PlanStage, markdown: string): PlanStateSnapshot {
  if (snapshot.plan[stage] === markdown) return snapshot;
  assertUpstreamAccepted(snapshot, stage);
  snapshot.version += 1;
  snapshot.plan[stage] = markdown;
  snapshot.accepted[stage] = false;
  clearDownstream(snapshot, stage);
  return snapshot;
}

function acceptStageSnapshot(snapshot: PlanStateSnapshot, stage: PlanStage): PlanStateSnapshot {
  assertStageReady(snapshot, stage);
  if (snapshot.accepted[stage]) return snapshot;
  snapshot.version += 1;
  snapshot.accepted[stage] = true;
  return snapshot;
}

function undoStageSnapshot(snapshot: PlanStateSnapshot, stage: PlanStage): PlanStateSnapshot {
  const checkpoints = snapshot.checkpoints[stage];
  if (checkpoints.length === 0) throw new Error(planStateTransitionError);
  const markdown = checkpoints[checkpoints.length - 1];
  snapshot.version += 1;
  snapshot.plan[stage] = markdown;
  snapshot.accepted[stage] = false;
  snapshot.checkpoints[stage] = checkpoints.slice(0, -1);
  clearDownstream(snapshot, stage);
  return snapshot;
}

function completedSnapshot(
  base: PlanStateSnapshot,
  request: PlanRunRequest,
  markdown: string,
): PlanStateSnapshot {
  const snapshot = cloneSnapshot(base);
  snapshot.version += 1;
  if (request.operation === "revise") {
    snapshot.checkpoints[request.stage] = [
      ...snapshot.checkpoints[request.stage],
      snapshot.plan[request.stage],
    ].slice(-maxPlanCheckpoints);
  }
  snapshot.plan[request.stage] = markdown;
  snapshot.accepted[request.stage] = false;
  clearDownstream(snapshot, request.stage);
  return snapshot;
}

function clearDownstream(snapshot: PlanStateSnapshot, stage: PlanStage): void {
  for (const downstream of planStages.slice(planStages.indexOf(stage) + 1)) {
    snapshot.plan[downstream] = "";
    snapshot.accepted[downstream] = false;
    snapshot.checkpoints[downstream] = [];
  }
}

function assertExpectedVersion(snapshot: PlanStateSnapshot, expected: number): void {
  if (!Number.isSafeInteger(expected) || expected < 0 || snapshot.version !== expected) {
    throw new Error(planStateVersionError);
  }
}

function assertRunTransition(snapshot: PlanStateSnapshot, request: PlanRunRequest): void {
  assertUpstreamAccepted(snapshot, request.stage);
  if (request.operation === "generate" && snapshot.accepted[request.stage]) {
    throw new Error(planStateTransitionError);
  }
  if (request.operation === "revise" && !snapshot.plan[request.stage].trim()) {
    throw new Error(planStateTransitionError);
  }
}

function assertStageReady(snapshot: PlanStateSnapshot, stage: PlanStage): void {
  assertUpstreamAccepted(snapshot, stage);
  if (!snapshot.plan[stage].trim()) throw new Error(planStateTransitionError);
}

function assertUpstreamAccepted(snapshot: PlanStateSnapshot, stage: PlanStage): void {
  for (const upstream of planStages.slice(0, planStages.indexOf(stage))) {
    if (!snapshot.accepted[upstream] || !snapshot.plan[upstream].trim()) {
      throw new Error(planStateTransitionError);
    }
  }
}

function promptInputFor(request: PlanRunRequest, snapshot: PlanStateSnapshot): PlanPromptInput {
  return {
    operation: request.operation,
    stage: request.stage,
    goal: request.goal,
    projectContext: `Project root: ${request.projectRoot}`,
    requirements: snapshot.plan.requirements,
    design: snapshot.plan.design,
    ...(request.operation === "revise"
      ? { currentMarkdown: snapshot.plan[request.stage], instruction: request.instruction }
      : {}),
  };
}

function narrowRunRequest(input: PlanRunRequest): PlanRunRequest {
  const base = {
    operation: input.operation,
    planSessionId: input.planSessionId,
    projectRoot: input.projectRoot,
    stage: input.stage,
    goal: input.goal,
    expectedStateVersion: input.expectedStateVersion,
  };
  return input.operation === "revise" ? { ...base, operation: "revise", instruction: input.instruction } : {
    ...base,
    operation: "generate",
  };
}

function terminalEvent(
  planSessionId: string,
  terminal: DurablePlanTerminal,
  snapshot: PlanStateSnapshot,
): PlanTerminalEvent {
  const base = {
    protocolVersion,
    planSessionId,
    runId: terminal.runId,
    stage: terminal.stage,
    operation: terminal.operation,
    checkpoints: cloneCheckpointState(snapshot.checkpoints),
    snapshot: cloneSnapshot(snapshot),
  };
  return terminal.kind === "completed"
    ? { ...base, kind: "completed", markdown: snapshot.plan[terminal.stage] }
    : { ...base, kind: "failed", error: terminal.error ?? "Plan generation failed." };
}

function parseDurableActive(value: unknown): DurableActivePlanRun | null {
  if (value === null) return null;
  if (!hasExactKeys(value, ["runId", "stage", "operation", "baseVersion"])) throw new Error("invalid");
  const baseVersion = value.baseVersion;
  if (!Number.isSafeInteger(baseVersion) || (baseVersion as number) < 0) throw new Error("invalid");
  return {
    runId: persistedRunId(value.runId),
    stage: parseStage(value.stage),
    operation: parseOperation(value.operation),
    baseVersion: baseVersion as number,
  };
}

function parseDurableTerminal(value: unknown): DurablePlanTerminal | null {
  if (value === null) return null;
  if (!isRecord(value)) throw new Error("invalid");
  if (value.kind === "completed") {
    if (!hasExactKeys(value, ["runId", "stage", "operation", "kind"])) throw new Error("invalid");
    return {
      runId: persistedRunId(value.runId),
      stage: parseStage(value.stage),
      operation: parseOperation(value.operation),
      kind: "completed",
    };
  }
  if (value.kind !== "failed" || !hasExactKeys(value, ["runId", "stage", "operation", "kind", "error"])) {
    throw new Error("invalid");
  }
  return {
    runId: persistedRunId(value.runId),
    stage: parseStage(value.stage),
    operation: parseOperation(value.operation),
    kind: "failed",
    error: publicTerminalError(value.error),
  };
}

function parseLegacyHeads(value: unknown): Record<PlanStage, string | null> {
  if (!hasExactKeys(value, planStages)) throw new Error("invalid");
  return {
    requirements: legacyHead(value.requirements),
    design: legacyHead(value.design),
    tasks: legacyHead(value.tasks),
  };
}

function legacyHead(value: unknown): string | null {
  if (value === null) return null;
  return nonblankMarkdown(value);
}

function nonblankMarkdown(value: unknown): string {
  if (typeof value !== "string" || !value.trim() || value.length > maxPlanMarkdownLength) throw new Error("invalid");
  return value;
}

function publicTerminalError(value: unknown): string {
  if (
    typeof value !== "string" ||
    !value ||
    value.length > 500 ||
    /[\u0000-\u001f\u007f]/.test(value) ||
    (
      publicPlanError({ message: value }) !== value &&
      value !== "Plan terminal persistence failed." &&
      value !== orphanedRunError
    )
  ) throw new Error("invalid");
  return value;
}

function persistedRunId(value: unknown): string {
  if (typeof value !== "string" || !value || value.length > 256 || /[\u0000-\u001f\u007f]/.test(value)) {
    throw new Error("invalid");
  }
  return value;
}

function persistedHash(value: unknown): string {
  if (typeof value !== "string" || !/^[a-f0-9]{64}$/.test(value)) throw new Error("invalid");
  return value;
}

function assertPersistedIdentity(
  value: Record<string, unknown>,
  planSessionId: string,
  projectRoot: string,
): void {
  if (value.planKey !== planKey(planSessionId) || !/^[a-f0-9]{64}$/.test(String(value.projectKey))) {
    throw new Error("invalid");
  }
  if (value.projectKey !== projectKey(projectRoot)) {
    throw new Error("Plan conversation mapping project does not match.");
  }
}

function parseStage(value: unknown): PlanStage {
  if (value === "requirements" || value === "design" || value === "tasks") return value;
  throw new Error("invalid");
}

function parseOperation(value: unknown): PlanOperation {
  if (value === "generate" || value === "revise") return value;
  throw new Error("invalid");
}

function emptyCheckpoints(): PlanCheckpointState {
  return { requirements: [], design: [], tasks: [] };
}

function cloneCheckpointState(value: PlanCheckpointState): PlanCheckpointState {
  return {
    requirements: [...value.requirements],
    design: [...value.design],
    tasks: [...value.tasks],
  };
}

function snapshotEquals(left: PlanStateSnapshot, right: PlanStateSnapshot): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

function sameDurableRun(value: DurableActivePlanRun | null, active: ActivePlanRun): boolean {
  return !!value &&
    value.runId === active.runId &&
    value.stage === active.request.stage &&
    value.operation === active.request.operation &&
    value.baseVersion === active.snapshot.version;
}

function planKey(planSessionId: string): string {
  return createHash("sha256").update("skyturn-plan-session\0").update(planSessionId).digest("hex");
}

function projectKey(projectRoot: string): string {
  return createHash("sha256").update("skyturn-plan-project\0").update(projectRoot).digest("hex");
}

function requestFingerprint(request: PlanRunRequest): string {
  return createHash("sha256").update(JSON.stringify(request)).digest("hex");
}

function startResult(active: ActivePlanRun, duplicate: boolean): PlanRunStartResult {
  return {
    protocolVersion,
    planSessionId: active.request.planSessionId,
    runId: active.runId,
    stage: active.request.stage,
    operation: active.request.operation,
    duplicate,
  };
}

function fixedStartError(error: unknown): Error {
  if (error instanceof Error && [
    runtimeShutdownError,
    planBusyError,
    planStateVersionError,
    planStateTransitionError,
    planStatePersistenceError,
    planSessionRestartError,
    "Plan state is unreadable.",
    "Plan state is invalid.",
    "Plan state permissions are invalid.",
    "Plan conversation mapping is unreadable.",
    "Plan conversation mapping is invalid.",
    "Plan conversation mapping is missing.",
    "Plan conversation mapping project does not match.",
    "Plan conversation mapping permissions are invalid.",
    "Plan conversation mapping root is invalid.",
  ].includes(error.message)) return error;
  return new Error(planStatePersistenceError);
}

class IndeterminatePlanStateError extends Error {}

function publicPlanError(error: unknown): string {
  const message = isRecord(error) && typeof error.message === "string" ? error.message : "";
  const allowed = [
    "Plan conversation mapping is missing.",
    "Plan conversation mapping is unreadable.",
    "Plan conversation mapping is invalid.",
    "Plan conversation mapping project does not match.",
    "Plan conversation mapping permissions are invalid.",
    "Plan conversation mapping root is invalid.",
    "Hermes ACP initialization failed.",
    "Hermes ACP session creation failed.",
    "Hermes ACP session creation timed out.",
    "Hermes ACP session loading failed.",
    "Hermes ACP session loading timed out.",
    "Hermes ACP session loading is unavailable.",
    "Hermes ACP prompt timed out.",
    "Hermes ACP prompt stopped before completion.",
    "Hermes ACP prompt failed.",
    "Hermes ACP output limit exceeded.",
    "Hermes ACP returned empty Markdown.",
    "Plan generation was cancelled.",
    runtimeShutdownError,
  ];
  return allowed.includes(message) ? message : "Plan generation failed.";
}

async function defaultClientFactory(signal: AbortSignal): Promise<HermesAcpClient> {
  const { createHermesAcpClient } = await import("@skyturn/agent-bridge");
  return createHermesAcpClient({
    ...(process.env.SKYTURN_HERMES_PATH ? { executablePath: process.env.SKYTURN_HERMES_PATH } : {}),
    signal,
  });
}

async function defaultPromptBuilder(input: PlanPromptInput): Promise<string> {
  const { buildPlanPrompt } = await import("@skyturn/planner");
  return buildPlanPrompt(input);
}

async function settlesWithin(settlement: Promise<void>, timeoutMs: number): Promise<boolean> {
  let timeout: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      settlement.then(() => true),
      new Promise<false>((resolve) => {
        timeout = setTimeout(() => resolve(false), Math.max(1, timeoutMs));
      }),
    ]);
  } finally {
    if (timeout) clearTimeout(timeout);
  }
}

function hasExactKeys(value: unknown, keys: readonly string[]): value is Record<string, unknown> {
  if (!isRecord(value)) return false;
  const actual = Object.keys(value);
  return actual.length === keys.length && actual.every((key) => keys.includes(key));
}

function isProjectMismatch(error: unknown): error is Error {
  return error instanceof Error && error.message === "Plan conversation mapping project does not match.";
}

function isMissingFileError(error: unknown): boolean {
  return isRecord(error) && error.code === "ENOENT";
}

function isFileExistsError(error: unknown): boolean {
  return isRecord(error) && error.code === "EEXIST";
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}
