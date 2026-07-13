import { spawn, type ChildProcess } from "node:child_process";
import { createHash } from "node:crypto";
import { access, mkdir, open, readFile, realpath, stat, writeFile, type FileHandle } from "node:fs/promises";
import { constants as fsConstants, realpathSync } from "node:fs";
import { homedir } from "node:os";
import { delimiter, join } from "node:path";
import { createInterface, type Interface } from "node:readline";
import { StringDecoder } from "node:string_decoder";
import { fileURLToPath } from "node:url";

import type {
  AgentRunHandle,
  LocalAgentAdapterContract,
  RunEventDraft,
  RunEventSink,
} from "@skyturn/agent-runtime";
import { agentAdapterContracts } from "@skyturn/agent-runtime";
import {
  DEFAULT_AGENT_TRANSPORT_FEATURE_FLAGS,
  RUN_EVENT_PROTOCOL_VERSION,
  canonicalExpectedArtifactDeclarationKeys,
  deriveRunEvidenceFromRunEvents,
  isSuccessfulRunEvidence,
  isTerminalAgentRunStatus,
  parseExpectedArtifactDeclaration,
  parseExpectedArtifactDeclarations,
  parseRunEvent,
  parseRunEvidence,
  parseRunEvidenceArtifacts,
  sanitizePublicEvidenceText,
  sanitizePublicPayloadText,
  reduceAgentRunStatus,
  type AgentDescriptor,
  type AgentKind,
  type AgentRun,
  type AgentRunSandbox,
  type AgentRunStatus,
  type AgentSupportLevel,
  type AgentReadinessCategory,
  type AgentTransportKind,
  type AgentTransportFeatureFlags,
  type AgentTerminalSession,
  type EvidenceCheck,
  type HermesPlannerTransport,
  type RunEvent,
  type RunEvidence,
  type StartAgentRunInput,
  type StructuredRunChange,
  type TerminalOutputStream,
  type TerminalSessionEventDraft,
  type TerminalSessionStatus,
} from "@skyturn/project-core";
import type { FlowEvent } from "@skyturn/workflow-kernel";
import {
  DurableRunClaimPublicationError,
  createDurableRunClaimStore,
  defaultDurableRunClaimRoot,
  type DurableRunClaimStore,
  type DurableRunStartClaim,
  type DurableRunStartClaimRead,
} from "./durableRunClaim.js";
import {
  createPrivateRunEventStore,
  type PrivateRunEventStore,
} from "./privateRunEventStore.js";
import {
  assertWindowsExpectedArtifactVerifierCapability,
  openWindowsExpectedArtifactVerifierSession,
  type WindowsExpectedArtifactVerifierSession,
} from "./internal/windowsExpectedArtifactVerifier.js";
import {
  artifactVerificationHooksFrom,
  type ArtifactVerificationHooks,
} from "./internal/artifactVerificationHooks.js";
import {
  StreamingSensitiveOutputRedactor,
  type RedactedTerminalChunk,
} from "./internal/streamingSensitiveOutputRedactor.js";

export { RUN_EVENT_PROTOCOL_VERSION } from "@skyturn/project-core";
export {
  createDurableRunClaimStore,
  defaultDurableRunClaimRoot,
  type DurableRunClaimStore,
  type DurableRunClaimStoreOptions,
} from "./durableRunClaim.js";
export {
  createPrivateRunEventStore,
  type PrivateRunEventFileSystem,
  type PrivateRunEventRead,
  type PrivateRunEventStore,
  type PrivateRunEventStoreOptions,
} from "./privateRunEventStore.js";

const commandCandidates: Record<AgentKind, string[]> = {
  hermes: ["hermes"],
  codex: ["codex"],
  agy: ["agy"],
  gemini: ["gemini"],
  "claude-code": ["claude", "claude-code"],
  openclaw: ["openclaw"],
};
const defaultKillTimeoutMs = 5_000;
const defaultStallTelemetryMs = 60_000;
const defaultRunWatchdogTimeoutMs = 30 * 60_000;
const cliProbeTimeoutMs = 1_500;
const maxStructuredChangeDiffBytes = 64_000;
const codexAuthEnvNames = ["OPENAI_API_KEY"];
const hermesAuthEnvNames = ["HERMES_API_KEY"];
const codexAuthFileName = "auth.json";
const defaultTerminalCols = 80;
const defaultTerminalRows = 24;
const defaultTerminalScrollbackBytes = 256_000;
const artifactHelperTimeoutMs = 2_000;

type CliFailureCategory =
  | "cli-missing"
  | "auth-missing"
  | "invalid-cwd"
  | "process-timeout"
  | "non-zero-exit"
  | "output-parse-error";

interface AgentRunWatchdogPolicy {
  source: AgentKind;
  commandLabel: string;
  timeoutCheckName: string;
  timeoutMs: number;
  stallTelemetryMs: number;
  killTimeoutMs: number;
}

export interface DiscoveryOptions {
  pathValue?: string;
  env?: NodeJS.ProcessEnv;
  codexConfigRoot?: string | null;
  codexAuthFilePath?: string | null;
}

export interface DiscoveryService {
  discover(): Promise<AgentDescriptor[]>;
}

export interface AgentBridgeOptions {
  adapters?: LocalAgentAdapterContract[];
  pathValue?: string;
  codexConfigRoot?: string | null;
  codexAuthFilePath?: string | null;
  appendEvent?: (projectRoot: string, event: RunEvent) => Promise<void>;
  onTerminalPersistenceFailure?: (failure: TerminalPersistenceFailure) => Promise<void>;
  durableRunClaimStore?: DurableRunClaimStore;
  privateRunEventStore?: PrivateRunEventStore;
}

export interface TerminalPersistenceFailure {
  projectRoot: string;
  runId: string;
  nodeId: string;
  sessionId: string;
  agentKind: AgentKind;
  reason: "terminal-persistence-failed";
  evidence: RunEvidence;
}

export type CodexCliSandbox = AgentRunSandbox;

const ownedRunStartInternalError = Symbol.for("skyturn.agent-bridge.owned-run-start-internal-error");
const retryTerminalPersistence = Symbol("skyturn.agent-bridge.retry-terminal-persistence");
type TerminalRunEventDraft = RunEventDraft & { [retryTerminalPersistence]?: true };

export class OwnedAgentRunStartError extends Error {
  readonly durableRunClaimOwned = true;
  readonly cause: unknown;
  readonly terminalPersistenceError?: unknown;

  constructor(cause: unknown, terminalPersistenceError?: unknown, publicCauseMessage?: string) {
    const message = publicCauseMessage ?? (sanitizePublicEvidenceText(errorMessage(cause)) || "Agent run start failed.");
    super(message);
    this.name = "OwnedAgentRunStartError";
    this.cause = new Error(message);
    if (terminalPersistenceError !== undefined) {
      const persistenceMessage = sanitizePublicEvidenceText(errorMessage(terminalPersistenceError)) || "Terminal persistence failed.";
      this.terminalPersistenceError = new Error(persistenceMessage);
    }
    Object.defineProperty(this, ownedRunStartInternalError, {
      value: { cause, terminalPersistenceError },
      enumerable: false,
    });
  }
}

export interface AgentRunStartFingerprintInput {
  protocolVersion: unknown;
  runId?: unknown;
  nodeId: unknown;
  sessionId: unknown;
  plannerSessionId?: unknown;
  plannerInputId?: unknown;
  hermesSessionHandle?: unknown;
  projectRoot: unknown;
  worktreePath: unknown;
  agentKind: unknown;
  transport?: unknown;
  sandbox?: unknown;
  expectedArtifacts?: unknown;
  prompt: unknown;
}

export function createAgentRunStartFingerprint(input: AgentRunStartFingerprintInput): string {
  const projectRootInput = fingerprintRequiredString(input.projectRoot, "projectRoot");
  const worktreePathInput = fingerprintRequiredString(input.worktreePath, "worktreePath");
  const projectRoot = realpathSync(projectRootInput);
  const worktreePath = realpathSync(worktreePathInput);
  const semantics = {
    version: 1,
    protocolVersion: fingerprintProtocolVersion(input.protocolVersion),
    projectRoot,
    sessionId: fingerprintRequiredString(input.sessionId, "sessionId"),
    nodeId: fingerprintRequiredString(input.nodeId, "nodeId"),
    runId: fingerprintOptionalString(input.runId, "runId"),
    agentKind: fingerprintAgentKind(input.agentKind),
    transport: fingerprintTransport(input.transport),
    worktreePath,
    sandbox: fingerprintSandbox(input.sandbox),
    prompt: fingerprintRequiredString(input.prompt, "prompt", true),
    expectedArtifacts: fingerprintExpectedArtifacts(input.expectedArtifacts),
    plannerSessionId: fingerprintOptionalString(input.plannerSessionId, "plannerSessionId"),
    plannerInputId: fingerprintOptionalString(input.plannerInputId, "plannerInputId"),
    hermesSessionHandle: fingerprintOptionalString(input.hermesSessionHandle, "hermesSessionHandle"),
  };
  return createHash("sha256").update(JSON.stringify(semantics), "utf8").digest("hex");
}

function fingerprintProtocolVersion(value: unknown): number {
  if (value !== RUN_EVENT_PROTOCOL_VERSION) throw new Error("Run start fingerprint protocolVersion is invalid.");
  return RUN_EVENT_PROTOCOL_VERSION;
}

function fingerprintRequiredString(value: unknown, field: string, allowEmpty = false): string {
  if (typeof value !== "string" || (!allowEmpty && value.length === 0)) {
    throw new Error(`Run start fingerprint ${field} is invalid.`);
  }
  return value;
}

function fingerprintOptionalString(value: unknown, field: string): string | null {
  if (value === undefined || value === null) return null;
  return fingerprintRequiredString(value, field);
}

function fingerprintExpectedArtifacts(value: unknown): string[] {
  if (value === undefined) return [];
  const canonicalKeys = canonicalExpectedArtifactDeclarationKeys(value);
  if (!canonicalKeys) {
    throw new Error("Run start fingerprint expectedArtifacts is invalid.");
  }
  return canonicalKeys;
}

function fingerprintAgentKind(value: unknown): AgentKind {
  if (
    value === "hermes" ||
    value === "codex" ||
    value === "agy" ||
    value === "gemini" ||
    value === "claude-code" ||
    value === "openclaw"
  ) {
    return value;
  }
  throw new Error("Run start fingerprint agentKind is invalid.");
}

function fingerprintTransport(value: unknown): AgentTransportKind | null {
  if (value === undefined || value === null) return null;
  if (value === "exec-json" || value === "pty-interactive") return value;
  throw new Error("Run start fingerprint transport is invalid.");
}

function fingerprintSandbox(value: unknown): AgentRunSandbox | null {
  if (value === undefined || value === null) return null;
  if (value === "read-only" || value === "workspace-write" || value === "danger-full-access") return value;
  throw new Error("Run start fingerprint sandbox is invalid.");
}

export interface CodexCliAdapterOptions {
  executablePath?: string;
  sandbox?: CodexCliSandbox;
  timeoutMs?: number;
  defaultWatchdogTimeoutMs?: number;
  killTimeoutMs?: number;
  stallTelemetryMs?: number;
  env?: NodeJS.ProcessEnv;
  extraArgs?: string[];
  pathValue?: string;
  codexConfigRoot?: string | null;
  codexAuthFilePath?: string | null;
}

export interface HermesCliAdapterOptions {
  executablePath?: string;
  timeoutMs?: number;
  defaultWatchdogTimeoutMs?: number;
  killTimeoutMs?: number;
  stallTelemetryMs?: number;
  env?: NodeJS.ProcessEnv;
  extraArgs?: string[];
  pathValue?: string;
  source?: string;
}

function strictExpectedArtifactDeclarations(value: unknown): string[] {
  const artifacts = parseExpectedArtifactDeclarations(value === undefined ? [] : value);
  if (!artifacts) throw new Error("Run start expectedArtifacts declaration is invalid.");
  return artifacts;
}

export async function assertExpectedArtifactVerifierCapability(expectedArtifacts?: unknown): Promise<void> {
  const artifacts = strictExpectedArtifactDeclarations(expectedArtifacts);
  if (artifacts.length === 0) return;
  if (process.platform !== "win32") return;
  await assertWindowsExpectedArtifactVerifierCapability();
}

export type HermesPlannerPtyContinuity = "resume-handle" | "process-level";

export interface HermesPlannerPtyLaunchOptions {
  executablePath?: string;
  extraArgs?: string[];
  source?: string;
}

export interface StartHermesPlannerPtySessionInput {
  id?: string;
  runId: string;
  canvasSessionId: string;
  plannerSessionId?: string;
  plannerInputId?: string;
  hermesSessionHandle?: string;
  projectRoot: string;
  worktreePath?: string;
  cols?: number;
  rows?: number;
  env?: NodeJS.ProcessEnv;
}

export interface HermesPlannerPtySessionMetadata {
  transport: HermesPlannerTransport;
  continuity: HermesPlannerPtyContinuity;
  degraded: boolean;
  plannerSessionId: string | null;
  plannerInputId: string | null;
  opaqueHandle: string | null;
  recoveryReason?: string;
}

export interface HermesPlannerPtyLaunch {
  command: string;
  args: string[];
  cwd: string;
  commandLabel: string;
  metadata: HermesPlannerPtySessionMetadata;
}

export interface HermesPlannerPtySession {
  terminalSession: AgentTerminalSession;
  metadata: HermesPlannerPtySessionMetadata;
}

export interface PtyExitEvent {
  exitCode: number | null;
  signal: string | null;
}

export interface PtyDisposable {
  dispose(): void;
}

export interface PtyProcess {
  write(data: string): void;
  resize(cols: number, rows: number): void;
  kill(signal?: string): void;
  onData(listener: (chunk: string) => void): PtyDisposable;
  onStderr?(listener: (chunk: string) => void): PtyDisposable;
  onExit(listener: (event: PtyExitEvent) => void): PtyDisposable;
}

export interface PtySpawnInput {
  command: string;
  args: string[];
  cwd: string;
  env: NodeJS.ProcessEnv;
  cols: number;
  rows: number;
}

export interface PtyProcessFactory {
  spawn(input: PtySpawnInput): PtyProcess;
}

export interface StartPtyTerminalSessionInput {
  id?: string;
  runId: string;
  canvasSessionId: string;
  agentKind: AgentKind;
  cwd: string;
  command: string;
  args?: string[];
  commandLabel?: string;
  cols?: number;
  rows?: number;
  env?: NodeJS.ProcessEnv;
  /** @internal Values that may enter the child process but must never cross the public output boundary. */
  sensitiveValues?: string[];
}

export interface PtyTerminalSessionManagerOptions {
  ptyFactory: PtyProcessFactory;
  emitEvent?: (event: TerminalSessionEventDraft) => void | Promise<void>;
  timeoutMs?: number;
  killTimeoutMs?: number;
  stallTelemetryMs?: number;
  maxScrollbackBytes?: number;
  env?: NodeJS.ProcessEnv;
  now?: () => Date;
}

export interface TerminalScrollbackChunk {
  timestamp: string;
  stream: TerminalOutputStream;
  text: string;
}

export interface TerminalSessionExitEvidence {
  exitCode: number | null;
  signal: string | null;
  checks: EvidenceCheck[];
}

export interface PtyTerminalSessionManager {
  startSession(input: StartPtyTerminalSessionInput): Promise<AgentTerminalSession>;
  writeStdin(sessionId: string, data: string): Promise<void>;
  resize(sessionId: string, size: { cols: number; rows: number }): Promise<void>;
  cancelSession(sessionId: string, reason?: string): Promise<TerminalSessionExitEvidence | null>;
  terminateSession(sessionId: string, reason?: string): Promise<TerminalSessionExitEvidence | null>;
  getSession(sessionId: string): AgentTerminalSession | null;
  getScrollback(sessionId: string): TerminalScrollbackChunk[];
  getExitEvidence(sessionId: string): TerminalSessionExitEvidence | null;
}

export interface HermesPlannerPtyTransportOptions extends PtyTerminalSessionManagerOptions {
  executablePath?: string;
  extraArgs?: string[];
  source?: string;
  featureFlags?: AgentTransportFeatureFlags;
}

export interface HermesPlannerPtyTransport {
  startSession(input: StartHermesPlannerPtySessionInput): Promise<HermesPlannerPtySession>;
  sendUserInput(canvasSessionId: string, data: string): Promise<void>;
  resizeSession(canvasSessionId: string, size: { cols: number; rows: number }): Promise<void>;
  cancelSession(canvasSessionId: string, reason?: string): Promise<TerminalSessionExitEvidence | null>;
  terminateSession(canvasSessionId: string, reason?: string): Promise<TerminalSessionExitEvidence | null>;
  getSession(canvasSessionId: string): HermesPlannerPtySession | null;
}

export function createDiscoveryService(options: DiscoveryOptions = {}): DiscoveryService {
  return {
    async discover() {
      const pathValue = options.pathValue ?? process.env.PATH ?? "";
      return Promise.all(
        agentAdapterContracts.map(async (contract) => {
          return detectCliDescriptor({
            kind: contract.kind,
            label: contract.label,
            candidates: commandCandidates[contract.kind],
            pathValue,
            supportLevel: contract.supportLevel,
            capabilities: contract.capabilities,
            configFiles: contract.nativeConfigFiles,
            env: options.env ?? process.env,
            authEnvNames: authEnvNamesForAgent(contract.kind),
            codexConfigRoot: options.codexConfigRoot,
            codexAuthFilePath: options.codexAuthFilePath,
          });
        }),
      );
    },
  };
}

export class AgentBridge {
  private readonly adapters: Map<AgentKind, LocalAgentAdapterContract>;
  private readonly discovery: DiscoveryService;
  private readonly runs = new Map<string, AgentRun>();
  private readonly handles = new Map<string, AgentRunHandle>();
  private readonly startFlights = new Map<string, { fingerprint: string; promise: Promise<AgentRun> }>();
  private readonly runStartFingerprints = new Map<string, string>();
  private readonly terminalPersistenceEvidence = new Map<string, RunEvidence>();
  private readonly listeners = new Set<(event: RunEvent) => void>();
  private readonly beforePrivateEventAppend?: (projectRoot: string, event: RunEvent) => Promise<void>;
  private readonly onTerminalPersistenceFailure?: (failure: TerminalPersistenceFailure) => Promise<void>;
  private readonly durableRunClaimStore: DurableRunClaimStore;
  private readonly privateRunEventStore: PrivateRunEventStore;

  constructor(options: AgentBridgeOptions = {}) {
    this.adapters = new Map((options.adapters ?? [createMockAgentAdapter()]).map((adapter) => [adapter.kind, adapter]));
    this.discovery = createDiscoveryService({
      pathValue: options.pathValue,
      codexConfigRoot: options.codexConfigRoot,
      codexAuthFilePath: options.codexAuthFilePath,
    });
    this.beforePrivateEventAppend = options.appendEvent;
    this.onTerminalPersistenceFailure = options.onTerminalPersistenceFailure;
    this.durableRunClaimStore = options.durableRunClaimStore ?? createDurableRunClaimStore({
      root: defaultDurableRunClaimRoot(),
    });
    this.privateRunEventStore = options.privateRunEventStore ?? createPrivateRunEventStore({
      durableRunClaimStore: this.durableRunClaimStore,
    });
  }

  async discoverAgents(): Promise<AgentDescriptor[]> {
    const discovered = await this.discovery.discover();
    const runnable = await Promise.all([...this.adapters.values()].map((adapter) => adapter.detect()));
    const runnableByKind = new Map(runnable.map((agent) => [agent.kind, agent]));
    return discovered.map((agent) => runnableByKind.get(agent.kind) ?? agent);
  }

  listRuns(): AgentRun[] {
    return [...this.runs.values()];
  }

  onRunEvent(listener: (event: RunEvent) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  startRun(input: StartAgentRunInput): Promise<AgentRun> {
    let expectedArtifacts: string[];
    try {
      expectedArtifacts = strictExpectedArtifactDeclarations(input.expectedArtifacts);
    } catch (error) {
      return Promise.reject(error);
    }
    const safeInput = input.expectedArtifacts === undefined ? input : { ...input, expectedArtifacts };
    if (!safeInput.runId) return this.startRunOnce(safeInput);
    let fingerprint: string;
    try {
      fingerprint = createAgentRunStartFingerprint(safeInput);
    } catch (error) {
      return Promise.reject(error);
    }
    const inFlight = this.startFlights.get(safeInput.runId);
    if (inFlight) {
      if (inFlight.fingerprint !== fingerprint) {
        return Promise.reject(new Error(`Run ${safeInput.runId} is already claimed with different identity.`));
      }
      return inFlight.promise;
    }
    const existing = this.runs.get(safeInput.runId);
    if (existing) {
      const existingFingerprint = this.runStartFingerprints.get(safeInput.runId);
      if (existingFingerprint && existingFingerprint !== fingerprint) {
        return Promise.reject(new Error(`Run ${safeInput.runId} is already claimed with different identity.`));
      }
      if (isFinalRunStatus(existing.status)) {
        return Promise.reject(new Error(`Run ${safeInput.runId} is already terminal (${existing.status}).`));
      }
      return Promise.resolve(existing);
    }

    const flight = this.startRunOnce(safeInput, fingerprint);
    this.startFlights.set(safeInput.runId, { fingerprint, promise: flight });
    void flight.then(
      () => this.clearStartFlight(safeInput.runId!, flight),
      () => this.clearStartFlight(safeInput.runId!, flight),
    );
    return flight;
  }

  private async startRunOnce(input: StartAgentRunInput, explicitFingerprint?: string): Promise<AgentRun> {
    await assertExpectedArtifactVerifierCapability(input.expectedArtifacts);
    await this.privateRunEventStore.prepare(input.projectRoot, input.worktreePath);
    await this.durableRunClaimStore.prepare(input.projectRoot, input.worktreePath);
    const now = new Date().toISOString();
    const runId = input.runId ?? (await nextAttemptRunId(
      this.durableRunClaimStore,
      input.projectRoot,
      input.sessionId,
      input.nodeId,
      this.runs,
    ));
    const run: AgentRun = {
      id: runId,
      nodeId: input.nodeId,
      sessionId: input.sessionId,
      ...(input.plannerSessionId ? { plannerSessionId: input.plannerSessionId } : {}),
      ...(input.plannerInputId ? { plannerInputId: input.plannerInputId } : {}),
      projectRoot: input.projectRoot,
      worktreePath: input.worktreePath,
      agentKind: input.agentKind,
      status: "running",
      startedAt: now,
    };
    let persistedEvents: RunEvent[];
    try {
      persistedEvents = await this.loadRunEventsStrict(run.projectRoot, run.id);
    } catch {
      const recoveredTerminal = await claimedRunRecoveryEvidence(this.durableRunClaimStore, run.projectRoot, run.id);
      if (recoveredTerminal) {
        await assertDurableRunStartFingerprint(this.durableRunClaimStore, run, explicitFingerprint);
        if (explicitFingerprint) this.runStartFingerprints.set(run.id, explicitFingerprint);
        this.terminalPersistenceEvidence.set(runTerminalKey(run.projectRoot, run.id), recoveredTerminal);
        this.runs.set(run.id, {
          ...run,
          status: recoveredTerminal.status,
          endedAt: recoveredTerminal.completedAt ?? undefined,
        });
        throw new Error(`Run ${run.id} is already terminal (${recoveredTerminal.status}).`);
      }
      throw new Error("Run durable state is invalid.");
    }
    const durableClaim = await loadDurableRunStartClaim(this.durableRunClaimStore, run.projectRoot, run.id);
    if (durableClaim.kind === "invalid") throw new InvalidDurableRunStartClaimError();
    if (durableClaim.kind === "valid") {
      assertDurableRunStartClaimIdentity(run, explicitFingerprint, durableClaim.claim);
    }
    const persisted = deriveEvidenceFromEvents(run, persistedEvents);
    if (isFinalRunStatus(persisted.status)) {
      if (explicitFingerprint) this.runStartFingerprints.set(run.id, explicitFingerprint);
      this.runs.set(run.id, {
        ...run,
        status: persisted.status,
        ...(persisted.completedAt ? { endedAt: persisted.completedAt } : {}),
      });
      throw new Error(`Run ${run.id} is already terminal (${persisted.status}).`);
    }
    const recoveredTerminal = claimedRunRecoveryEvidenceFromRead(durableClaim);
    if (recoveredTerminal) {
      if (explicitFingerprint) this.runStartFingerprints.set(run.id, explicitFingerprint);
      this.terminalPersistenceEvidence.set(runTerminalKey(run.projectRoot, run.id), recoveredTerminal);
      this.runs.set(run.id, {
        ...run,
        status: recoveredTerminal.status,
        ...(recoveredTerminal.completedAt ? { endedAt: recoveredTerminal.completedAt } : {}),
      });
      throw new Error(`Run ${run.id} is already terminal (${recoveredTerminal.status}).`);
    }
    if (persistedEvents.length > 0) {
      if (explicitFingerprint) this.runStartFingerprints.set(run.id, explicitFingerprint);
      this.runs.set(run.id, {
        ...run,
        status: persisted.status,
        ...(persisted.completedAt ? { endedAt: persisted.completedAt } : {}),
      });
      throw new Error(`Run ${run.id} is already active or durably claimed.`);
    }
    const claimed = input.runId
      ? await claimExplicitRunStart(
          this.durableRunClaimStore,
          run,
          explicitFingerprint ?? createAgentRunStartFingerprint(input),
        )
      : true;
    if (!claimed) {
      await assertDurableRunStartFingerprint(this.durableRunClaimStore, run, explicitFingerprint);
      throw new Error(`Run ${run.id} is already active or durably claimed.`);
    }
    if (explicitFingerprint) this.runStartFingerprints.set(run.id, explicitFingerprint);
    this.runs.set(run.id, run);

    const sink: RunEventSink = {
      emit: (event) => this.recordEvent(run.id, event),
    };
    let handle: AgentRunHandle;
    try {
      const fallbackAdapter = input.agentKind === "agy" ? undefined : this.adapters.get("codex");
      const adapter = this.adapters.get(input.agentKind) ?? fallbackAdapter;
      if (!adapter) throw new Error(`No local adapter registered for ${input.agentKind}`);
      handle = await adapter.startRun({ ...input, runId: run.id }, sink);
    } catch (error) {
      const message = sanitizePublicProcessTextWithSensitiveValues(
        errorMessage(error),
        input.hermesSessionHandle ? [input.hermesSessionHandle] : [],
      ) || "Agent run start failed.";
      let terminalPersistenceError: unknown;
      try {
        const persisted = deriveEvidenceFromEvents(run, await this.loadRunEvents(run.projectRoot, run.id));
        if (isFinalRunStatus(persisted.status)) {
          this.runs.set(run.id, {
            ...run,
            status: persisted.status,
            ...(persisted.completedAt ? { endedAt: persisted.completedAt } : {}),
          });
        } else {
          await this.failRunStart(run, message);
        }
      } catch (persistenceError) {
        terminalPersistenceError = persistenceError;
      }
      throw new OwnedAgentRunStartError(error, terminalPersistenceError, message);
    }
    this.handles.set(run.id, handle);
    return this.runs.get(run.id) ?? run;
  }

  private clearStartFlight(runId: string, flight: Promise<AgentRun>): void {
    if (this.startFlights.get(runId)?.promise !== flight) return;
    this.startFlights.delete(runId);
  }

  async send(runId: string, message: string): Promise<void> {
    const run = this.runs.get(runId);
    if (!run) throw new Error(`Unknown run ${runId}`);
    const adapter = this.adapters.get(run.agentKind);
    await adapter?.send?.(runId, message);
  }

  async cancelRun(runId: string, reason = "Run cancelled"): Promise<RunEvidence> {
    const run = this.runs.get(runId);
    if (!run) throw new Error(`Unknown run ${runId}`);
    let cancelError: unknown = null;
    try {
      await this.handles.get(runId)?.cancel(reason);
    } catch (error) {
      cancelError = error;
    }
    const terminalRun = this.runs.get(runId);
    if (terminalRun && isFinalRunStatus(terminalRun.status)) {
      return this.getEvidence(run.projectRoot, runId);
    }
    let events = await this.loadRunEvents(run.projectRoot, runId);
    if (!events.some(isFinalStatusEvent)) {
      try {
        await this.recordEvent(runId, {
          kind: "status",
          payload: { status: "cancelled", reason },
        });
      } catch (statusError) {
        throw cancelError ?? statusError;
      }
      events = await this.loadRunEvents(run.projectRoot, runId);
    }
    return deriveEvidenceFromEvents(this.runs.get(runId) ?? run, events);
  }

  async loadEvents(projectRoot: string, runId: string): Promise<RunEvent[]> {
    return this.loadRunEvents(projectRoot, runId);
  }

  async getEvidence(projectRoot: string, runId: string): Promise<RunEvidence> {
    const durableClaim = await loadDurableRunStartClaim(this.durableRunClaimStore, projectRoot, runId);
    if (durableClaim.kind === "invalid") throw new InvalidDurableRunStartClaimError();
    const volatileTerminal = this.terminalPersistenceEvidence.get(runTerminalKey(projectRoot, runId));
    if (volatileTerminal) return volatileTerminal;
    const liveRun = this.runs.get(runId);
    const run = liveRun ?? makePersistedRun(projectRoot, runId);
    let events: RunEvent[];
    try {
      events = await this.loadRunEventsStrict(projectRoot, runId);
    } catch {
      if (liveRun) throw new Error("Run durable state is invalid.");
      const recoveredTerminal = claimedRunRecoveryEvidenceFromRead(durableClaim);
      if (recoveredTerminal) return recoveredTerminal;
      throw new Error("Run durable state is invalid.");
    }
    const persisted = deriveEvidenceFromEvents(
      events.length > 0 ? { ...run, status: "running", endedAt: undefined } : run,
      events,
    );
    if (liveRun || isFinalRunStatus(persisted.status)) return persisted;
    const recoveredTerminal = claimedRunRecoveryEvidenceFromRead(durableClaim);
    if (recoveredTerminal) return recoveredTerminal;
    return persisted;
  }

  private async recordEvent(runId: string, draft: RunEventDraft): Promise<RunEvent> {
    const run = this.runs.get(runId);
    if (!run) throw new Error(`Unknown run ${runId}`);
    const event = parseRunEvent({
      protocolVersion: RUN_EVENT_PROTOCOL_VERSION,
      runId,
      seq: (await this.loadRunEventsStrict(run.projectRoot, runId)).length + 1,
      timestamp: draft.timestamp ?? new Date().toISOString(),
      kind: draft.kind,
      payload: draft.payload,
    });
    if (!event) throw new Error("Invalid RunEvent.");
    const retryTerminal =
      isFinalStatusEvent(event) ||
      (draft as TerminalRunEventDraft)[retryTerminalPersistence] === true;
    try {
      await this.persistEvent(run.projectRoot, event, retryTerminal);
    } catch (error) {
      if (isFinalStatusEvent(event)) {
        return this.recordTerminalPersistenceFailure(run, event, error);
      }
      throw error;
    }
    if (event.kind === "output") {
      const events = await this.loadRunEvents(run.projectRoot, runId);
      await writeTaskOutputFromEvents(run.projectRoot, run.nodeId, events).catch(() => undefined);
    }
    this.updateRunFromEvent(run, event);
    for (const listener of this.listeners) {
      try {
        listener(event);
      } catch {
        // Listener failures must not affect durable run state.
      }
    }
    return event;
  }

  private async persistEvent(projectRoot: string, event: RunEvent, retry: boolean): Promise<void> {
    try {
      const appended = await this.appendPrivateEvent(projectRoot, event);
      if (appended === "appended") await appendWorkspaceRunEventMirror(projectRoot, event).catch(() => undefined);
      return;
    } catch (firstError) {
      if (!retry) throw firstError;
      try {
        await this.appendPrivateEvent(projectRoot, event);
        await appendWorkspaceRunEventMirror(projectRoot, event).catch(() => undefined);
      } catch (secondError) {
        throw secondError ?? firstError;
      }
    }
  }

  private async appendPrivateEvent(projectRoot: string, event: RunEvent): Promise<"appended" | "exists"> {
    await this.beforePrivateEventAppend?.(projectRoot, event);
    return this.privateRunEventStore.append(projectRoot, event);
  }

  private async recordTerminalPersistenceFailure(
    run: AgentRun,
    attemptedEvent: RunEvent,
    _persistenceError: unknown,
  ): Promise<RunEvent> {
    const failureEvent = parseRunEvent({
      protocolVersion: RUN_EVENT_PROTOCOL_VERSION,
      runId: run.id,
      seq: attemptedEvent.seq,
      timestamp: attemptedEvent.timestamp,
      kind: "status",
      payload: {
        status: "failed",
        exitCode: null,
        reason: "terminal-persistence-failed",
        errorReason: "terminal-persistence-failed",
        checks: [{
          kind: "run-exit",
          name: "Terminal persistence",
          status: "failed",
          detail: "terminal-persistence-failed",
        }],
      },
    });
    if (!failureEvent) throw new Error("Invalid terminal persistence failure event.");
    const failureEvidence = deriveEvidenceFromEvents(run, [failureEvent]);

    this.terminalPersistenceEvidence.set(runTerminalKey(run.projectRoot, run.id), failureEvidence);
    this.updateRunFromEvent(run, failureEvent);
    if (this.onTerminalPersistenceFailure) {
      try {
        await this.onTerminalPersistenceFailure({
          projectRoot: run.projectRoot,
          runId: run.id,
          nodeId: run.nodeId,
          sessionId: run.sessionId,
          agentKind: run.agentKind,
          reason: "terminal-persistence-failed",
          evidence: failureEvidence,
        });
      } catch {
        throw new Error("terminal-persistence-failed");
      }
    }
    return failureEvent;
  }

  private updateRunFromEvent(run: AgentRun, event: RunEvent): void {
    if (event.kind !== "status") return;
    const status = event.payload.status;
    if (!isRunStatus(status)) return;
    const nextStatus = reduceAgentRunStatus(run.status, status);
    if (nextStatus === run.status) return;
    this.runs.set(run.id, {
      ...run,
      status: nextStatus,
      endedAt: isTerminalAgentRunStatus(nextStatus) ? event.timestamp : run.endedAt,
    });
  }

  private async failRunStart(run: AgentRun, message: string): Promise<void> {
    const timestamp = new Date().toISOString();
    const publicMessage = sanitizePublicEvidenceText(message) || "Agent start failed.";
    this.runs.set(run.id, { ...run, status: "failed", endedAt: timestamp });
    const payload = {
      status: "failed",
      reason: publicMessage,
      errorReason: publicMessage,
      category: "start-failed",
      exitCode: null,
      checks: [{ kind: "run-exit", name: "Agent start", status: "failed", detail: publicMessage }],
    };
    try {
      await this.recordEvent(run.id, { kind: "status", payload, timestamp });
      return;
    } catch {
      const events = await this.loadRunEvents(run.projectRoot, run.id);
      if (events.some(isFinalStatusEvent)) return;
      const event: RunEvent = {
        protocolVersion: RUN_EVENT_PROTOCOL_VERSION,
        runId: run.id,
        seq: events.length + 1,
        timestamp,
        kind: "status",
        payload,
      };
      await this.persistEvent(run.projectRoot, event, true);
    }
  }

  private async loadRunEvents(projectRoot: string, runId: string): Promise<RunEvent[]> {
    try {
      return await this.loadRunEventsStrict(projectRoot, runId);
    } catch {
      return [];
    }
  }

  private async loadRunEventsStrict(projectRoot: string, runId: string): Promise<RunEvent[]> {
    const stored = await this.privateRunEventStore.read(projectRoot, runId);
    if (stored.kind === "missing") return [];
    if (stored.kind === "invalid") throw new Error("Run durable state is invalid.");
    return stored.events;
  }
}

export function createMockAgentAdapter(options: { holdOpen?: boolean } = {}): LocalAgentAdapterContract {
  return {
    kind: "codex",
    label: "Mock Codex Agent",
    nativeConfigFiles: ["AGENTS.md"],
    supportLevel: "mock-only",
    capabilities: ["chat", "file-read", "file-write", "worktree"],
    async detect() {
      return {
        kind: "codex",
        label: "Mock Codex Agent",
        executablePath: null,
        version: null,
        status: "available",
        supportLevel: "mock-only",
        capabilities: ["chat", "file-read", "file-write", "worktree"],
        configFiles: ["AGENTS.md"],
      };
    },
    async startRun(input, sink) {
      let finalized = false;
      await sink.emit({
        kind: "output",
        payload: { text: `Mock run accepted for ${input.nodeId}.` },
      });
      await sink.emit({
        kind: "output",
        payload: { text: "Agent text says completed; RunEvidence still decides node status." },
      });
      if (!options.holdOpen) {
        await sink.emit({
          kind: "evidence",
          payload: {
            exitCode: 0,
            checks: [{ kind: "run-exit", name: "Mock adapter exit", status: "passed" }],
          },
        });
        await sink.emit({ kind: "status", payload: { status: "succeeded", exitCode: 0 } });
        finalized = true;
      }
      return {
        async cancel(reason) {
          if (finalized) return;
          finalized = true;
          await sink.emit({
            kind: "evidence",
            payload: {
              exitCode: null,
              checks: [{ kind: "run-exit", name: "Mock adapter exit", status: "skipped", detail: reason }],
            },
          });
          await sink.emit({ kind: "status", payload: { status: "cancelled", reason } });
        },
      };
    },
  };
}

export async function loadRunEvents(
  projectRoot: string,
  runId: string,
  store: PrivateRunEventStore = defaultPrivateRunEventStore(),
): Promise<RunEvent[]> {
  try {
    return await loadRunEventsStrict(projectRoot, runId, store);
  } catch {
    return [];
  }
}

async function loadRunEventsStrict(
  projectRoot: string,
  runId: string,
  store: PrivateRunEventStore = defaultPrivateRunEventStore(),
): Promise<RunEvent[]> {
  const stored = await store.read(projectRoot, runId);
  if (stored.kind === "missing") return [];
  if (stored.kind === "invalid") throw new Error("Run durable state is invalid.");
  return stored.events;
}

function defaultPrivateRunEventStore(): PrivateRunEventStore {
  const durableRunClaimStore = createDurableRunClaimStore({ root: defaultDurableRunClaimRoot() });
  return createPrivateRunEventStore({ durableRunClaimStore });
}

type TerminalSessionEventInput =
  | {
      kind: "output";
      stream: TerminalOutputStream;
      text: string;
      timestamp?: string;
    }
  | {
      kind: "progress";
      message: string;
      timestamp?: string;
    }
  | {
      kind: "lifecycle";
      status: TerminalSessionStatus;
      message?: string;
      timestamp?: string;
    };

interface ManagedPtyTerminalSession {
  session: AgentTerminalSession;
  process: PtyProcess;
  outputDisposables: PtyDisposable[];
  exitDisposable: PtyDisposable | null;
  scrollback: TerminalScrollbackChunk[];
  scrollbackBytes: number;
  outputRedactor: StreamingSensitiveOutputRedactor;
  eventQueue: Promise<void>;
  timeoutTimer: NodeJS.Timeout | null;
  stallTimer: NodeJS.Timeout | null;
  killTimer: NodeJS.Timeout | null;
  lastActivityAt: number;
  finalized: boolean;
  processExited: boolean;
  exitEvidence: TerminalSessionExitEvidence | null;
}

export function createPtyTerminalSessionManager(
  options: PtyTerminalSessionManagerOptions,
): PtyTerminalSessionManager {
  return new PtyTerminalSessionManagerImpl(options);
}

class PtyTerminalSessionManagerImpl implements PtyTerminalSessionManager {
  private readonly sessions = new Map<string, ManagedPtyTerminalSession>();
  private readonly timeoutMs: number;
  private readonly killTimeoutMs: number;
  private readonly stallTelemetryMs: number;
  private readonly maxScrollbackBytes: number;

  constructor(private readonly options: PtyTerminalSessionManagerOptions) {
    this.timeoutMs = options.timeoutMs ?? defaultRunWatchdogTimeoutMs;
    this.killTimeoutMs = options.killTimeoutMs ?? defaultKillTimeoutMs;
    this.stallTelemetryMs = options.stallTelemetryMs ?? defaultStallTelemetryMs;
    this.maxScrollbackBytes = options.maxScrollbackBytes ?? defaultTerminalScrollbackBytes;
  }

  async startSession(input: StartPtyTerminalSessionInput): Promise<AgentTerminalSession> {
    const id = input.id ?? `terminal-${input.runId}`;
    if (this.sessions.has(id)) throw new Error(`Terminal session already exists: ${id}`);
    const cols = input.cols ?? defaultTerminalCols;
    const rows = input.rows ?? defaultTerminalRows;
    const ptyProcess = this.options.ptyFactory.spawn({
      command: input.command,
      args: input.args ?? [],
      cwd: input.cwd,
      env: { ...process.env, ...this.options.env, ...input.env },
      cols,
      rows,
    });
    const session: AgentTerminalSession = {
      id,
      runId: input.runId,
      canvasSessionId: input.canvasSessionId,
      agentKind: input.agentKind,
      cwd: input.cwd,
      commandLabel: input.commandLabel ?? input.command,
      transport: "pty-interactive",
      status: "starting",
      createdAt: this.isoNow(),
    };
    const state: ManagedPtyTerminalSession = {
      session,
      process: ptyProcess,
      outputDisposables: [],
      exitDisposable: null,
      scrollback: [],
      scrollbackBytes: 0,
      outputRedactor: new StreamingSensitiveOutputRedactor(input.sensitiveValues),
      eventQueue: Promise.resolve(),
      timeoutTimer: null,
      stallTimer: null,
      killTimer: null,
      lastActivityAt: Date.now(),
      finalized: false,
      processExited: false,
      exitEvidence: null,
    };
    this.sessions.set(id, state);
    this.attachProcessListeners(state);
    await this.enqueueTerminalEvent(state, { kind: "lifecycle", status: "starting" });
    if (state.finalized) return { ...state.session };
    this.updateStatus(state, "running");
    await this.enqueueTerminalEvent(state, { kind: "lifecycle", status: "running" });
    if (state.finalized) return { ...state.session };
    this.markActivity(state);
    this.startStallTelemetry(state);
    this.startTimeout(state);
    return { ...state.session };
  }

  async writeStdin(sessionId: string, data: string): Promise<void> {
    const state = this.requireOpenSession(sessionId);
    state.process.write(data);
  }

  async resize(sessionId: string, size: { cols: number; rows: number }): Promise<void> {
    const state = this.requireOpenSession(sessionId);
    if (size.cols <= 0 || size.rows <= 0) throw new Error("Terminal size must use positive cols and rows.");
    state.process.resize(size.cols, size.rows);
    await this.enqueueTerminalEvent(state, {
      kind: "progress",
      message: `resized to ${size.cols}x${size.rows}`,
    });
  }

  async cancelSession(sessionId: string, reason = "Terminal cancelled"): Promise<TerminalSessionExitEvidence | null> {
    const state = this.requireSession(sessionId);
    if (state.finalized) return state.exitEvidence;
    const publicReason = sanitizePublicProcessText(reason) || "Terminal cancelled";
    const evidence = this.finalizeSession(state, {
      status: "cancelled",
      message: publicReason,
      evidence: {
        exitCode: null,
        signal: null,
        checks: [
          {
            kind: "run-exit",
            name: `${state.session.commandLabel} terminal exit`,
            status: "skipped",
            detail: publicReason,
          },
        ],
      },
    });
    this.scheduleKill(state);
    return evidence;
  }

  async terminateSession(sessionId: string, reason = "Terminal terminated"): Promise<TerminalSessionExitEvidence | null> {
    const state = this.requireSession(sessionId);
    if (state.finalized) return state.exitEvidence;
    const publicReason = sanitizePublicProcessText(reason) || "Terminal terminated";
    const evidence = this.finalizeSession(state, {
      status: "failed",
      message: publicReason,
      evidence: {
        exitCode: null,
        signal: null,
        checks: [
          {
            kind: "run-exit",
            name: `${state.session.commandLabel} terminal exit`,
            status: "failed",
            detail: publicReason,
          },
        ],
      },
    });
    this.scheduleKill(state);
    return evidence;
  }

  getSession(sessionId: string): AgentTerminalSession | null {
    const session = this.sessions.get(sessionId)?.session;
    return session ? { ...session } : null;
  }

  getScrollback(sessionId: string): TerminalScrollbackChunk[] {
    const state = this.requireSession(sessionId);
    return state.scrollback.map((chunk) => ({ ...chunk }));
  }

  getExitEvidence(sessionId: string): TerminalSessionExitEvidence | null {
    const evidence = this.requireSession(sessionId).exitEvidence;
    return evidence
      ? {
          exitCode: evidence.exitCode,
          signal: evidence.signal,
          checks: evidence.checks.map((check) => ({ ...check })),
        }
      : null;
  }

  private attachProcessListeners(state: ManagedPtyTerminalSession): void {
    state.outputDisposables.push(
      state.process.onData((chunk) => {
        this.captureOutput(state, "stdout", chunk);
      }),
    );
    if (state.process.onStderr) {
      state.outputDisposables.push(
        state.process.onStderr((chunk) => {
          this.captureOutput(state, "stderr", chunk);
        }),
      );
    }
    state.exitDisposable = state.process.onExit((event) => {
      void this.handleProcessExit(state, event);
    });
  }

  private captureOutput(state: ManagedPtyTerminalSession, stream: TerminalOutputStream, chunk: string): void {
    if (state.finalized) return;
    this.markActivity(state);
    this.publishOutputChunks(state, state.outputRedactor.push(stream, chunk));
  }

  private publishOutputChunks(state: ManagedPtyTerminalSession, chunks: RedactedTerminalChunk[]): void {
    for (const chunk of chunks) this.publishOutput(state, chunk.stream, chunk.text);
  }

  private publishOutput(state: ManagedPtyTerminalSession, stream: TerminalOutputStream, text: string): void {
    if (!text) return;
    const timestamp = this.isoNow();
    this.appendScrollback(state, { timestamp, stream, text });
    void this.enqueueTerminalEvent(state, { kind: "output", stream, text, timestamp });
  }

  private flushOutput(state: ManagedPtyTerminalSession): void {
    this.publishOutputChunks(state, state.outputRedactor.flush());
  }

  private async handleProcessExit(state: ManagedPtyTerminalSession, event: PtyExitEvent): Promise<void> {
    state.processExited = true;
    this.clearKillTimer(state);
    if (state.finalized) {
      this.disposeExitListener(state);
      return;
    }
    const exitCode = typeof event.exitCode === "number" ? event.exitCode : null;
    const signal = event.signal ?? null;
    const passed = exitCode === 0;
    await this.finalizeSession(state, {
      status: passed ? "exited" : "failed",
      evidence: {
        exitCode,
        signal,
        checks: [
          {
            kind: "run-exit",
            name: `${state.session.commandLabel} terminal exit`,
            status: passed ? "passed" : "failed",
            detail: formatExitDetail(exitCode, signal),
          },
        ],
      },
    });
    this.disposeExitListener(state);
  }

  private async expireSession(state: ManagedPtyTerminalSession): Promise<void> {
    if (state.finalized) return;
    const evidence = this.finalizeSession(state, {
      status: "timed-out",
      message: `${state.session.commandLabel} terminal timed out after ${this.timeoutMs}ms`,
      evidence: {
        exitCode: null,
        signal: null,
        checks: [
          {
            kind: "run-timeout",
            name: `${state.session.commandLabel} terminal watchdog`,
            status: "failed",
            detail: `timed out after ${this.timeoutMs}ms`,
          },
        ],
      },
    });
    this.scheduleKill(state);
    await evidence;
  }

  private async finalizeSession(
    state: ManagedPtyTerminalSession,
    input: {
      status: TerminalSessionStatus;
      message?: string;
      evidence: TerminalSessionExitEvidence;
    },
  ): Promise<TerminalSessionExitEvidence> {
    if (state.finalized) return state.exitEvidence ?? input.evidence;
    this.flushOutput(state);
    state.finalized = true;
    this.clearLifecycleTimers(state);
    this.disposeOutputListeners(state);
    state.exitEvidence = input.evidence;
    this.updateStatus(state, input.status);
    await this.enqueueTerminalEvent(state, {
      kind: "lifecycle",
      status: input.status,
      ...(input.message ? { message: input.message } : {}),
    });
    return this.getExitEvidence(state.session.id) ?? input.evidence;
  }

  private startTimeout(state: ManagedPtyTerminalSession): void {
    if (this.timeoutMs <= 0 || state.finalized) return;
    state.timeoutTimer = setTimeout(() => {
      void this.expireSession(state);
    }, this.timeoutMs);
    state.timeoutTimer.unref();
  }

  private startStallTelemetry(state: ManagedPtyTerminalSession): void {
    if (this.stallTelemetryMs <= 0 || state.finalized) return;
    state.stallTimer = setTimeout(() => {
      void (async () => {
        if (state.finalized) return;
        const idleMs = Date.now() - state.lastActivityAt;
        if (idleMs >= this.stallTelemetryMs) {
          await this.enqueueTerminalEvent(state, {
            kind: "progress",
            message: `${state.session.commandLabel} terminal stalled after ${idleMs}ms without output.`,
          });
        }
        this.startStallTelemetry(state);
      })();
    }, this.stallTelemetryMs);
    state.stallTimer.unref();
  }

  private markActivity(state: ManagedPtyTerminalSession): void {
    state.lastActivityAt = Date.now();
  }

  private scheduleKill(state: ManagedPtyTerminalSession): void {
    if (state.processExited) return;
    this.tryKill(state, "SIGTERM");
    if (state.processExited) return;
    if (state.killTimer) clearTimeout(state.killTimer);
    state.killTimer = setTimeout(() => {
      state.killTimer = null;
      if (state.processExited) return;
      this.tryKill(state, "SIGKILL");
    }, this.killTimeoutMs);
    state.killTimer.unref();
  }

  private clearLifecycleTimers(state: ManagedPtyTerminalSession): void {
    if (state.timeoutTimer) clearTimeout(state.timeoutTimer);
    if (state.stallTimer) clearTimeout(state.stallTimer);
    state.timeoutTimer = null;
    state.stallTimer = null;
  }

  private clearKillTimer(state: ManagedPtyTerminalSession): void {
    if (state.killTimer) clearTimeout(state.killTimer);
    state.killTimer = null;
  }

  private tryKill(state: ManagedPtyTerminalSession, signal: string): void {
    try {
      state.process.kill(signal);
    } catch {
      // PTY teardown is best-effort; terminal evidence is finalized separately.
    }
  }

  private disposeOutputListeners(state: ManagedPtyTerminalSession): void {
    for (const disposable of state.outputDisposables.splice(0)) {
      disposable.dispose();
    }
  }

  private disposeExitListener(state: ManagedPtyTerminalSession): void {
    state.exitDisposable?.dispose();
    state.exitDisposable = null;
  }

  private appendScrollback(state: ManagedPtyTerminalSession, chunk: TerminalScrollbackChunk): void {
    if (this.maxScrollbackBytes <= 0) return;
    let text = chunk.text;
    let bytes = Buffer.byteLength(text);
    if (bytes > this.maxScrollbackBytes) {
      text = Buffer.from(text).subarray(-this.maxScrollbackBytes).toString("utf8");
      bytes = Buffer.byteLength(text);
    }
    state.scrollback.push({ ...chunk, text });
    state.scrollbackBytes += bytes;
    while (state.scrollbackBytes > this.maxScrollbackBytes && state.scrollback.length > 0) {
      const removed = state.scrollback.shift();
      state.scrollbackBytes -= Buffer.byteLength(removed?.text ?? "");
    }
  }

  private updateStatus(state: ManagedPtyTerminalSession, status: TerminalSessionStatus): void {
    state.session = {
      ...state.session,
      status,
      ...(isFinalTerminalSessionStatus(status) ? { endedAt: this.isoNow() } : {}),
    };
  }

  private async emitTerminalEvent(
    state: ManagedPtyTerminalSession,
    input: TerminalSessionEventInput,
  ): Promise<void> {
    const event = {
      ...input,
      terminalSessionId: state.session.id,
      runId: state.session.runId,
      timestamp: input.timestamp ?? this.isoNow(),
    } as TerminalSessionEventDraft;
    try {
      await this.options.emitEvent?.(event);
    } catch {
      // Terminal observers must not decide process lifecycle.
    }
  }

  private enqueueTerminalEvent(state: ManagedPtyTerminalSession, input: TerminalSessionEventInput): Promise<void> {
    state.eventQueue = state.eventQueue.then(
      () => this.emitTerminalEvent(state, input),
      () => this.emitTerminalEvent(state, input),
    );
    return state.eventQueue;
  }

  private requireOpenSession(sessionId: string): ManagedPtyTerminalSession {
    const state = this.requireSession(sessionId);
    if (state.finalized) throw new Error(`Terminal session is closed: ${sessionId}`);
    return state;
  }

  private requireSession(sessionId: string): ManagedPtyTerminalSession {
    const state = this.sessions.get(sessionId);
    if (!state) throw new Error(`Unknown terminal session: ${sessionId}`);
    return state;
  }

  private isoNow(): string {
    return (this.options.now?.() ?? new Date()).toISOString();
  }
}

export async function buildHermesPlannerPtyLaunch(
  input: StartHermesPlannerPtySessionInput,
  options: HermesPlannerPtyLaunchOptions = {},
): Promise<HermesPlannerPtyLaunch> {
  const launch = await buildHermesPlannerPtySpawnLaunch(input, options);
  const resumeIndex = launch.args.indexOf("--resume");
  return {
    ...launch,
    args: launch.args.map((argument, index) => resumeIndex >= 0 && index === resumeIndex + 1 ? "[redacted]" : argument),
  };
}

async function buildHermesPlannerPtySpawnLaunch(
  input: StartHermesPlannerPtySessionInput,
  options: HermesPlannerPtyLaunchOptions = {},
): Promise<HermesPlannerPtyLaunch> {
  const cwd = await realpath(input.worktreePath || input.projectRoot);
  const source = options.source ?? "skyturn";
  const command = options.executablePath ?? "hermes";
  const hasOpaqueHandle = Boolean(input.hermesSessionHandle);
  const metadata: HermesPlannerPtySessionMetadata = hasOpaqueHandle
    ? {
        transport: "hermes_session_resume",
        continuity: "resume-handle",
        degraded: false,
        plannerSessionId: input.plannerSessionId ?? null,
        plannerInputId: input.plannerInputId ?? null,
        opaqueHandle: "[redacted]",
      }
    : {
        transport: "hermes_live_chat",
        continuity: "process-level",
        degraded: true,
        plannerSessionId: input.plannerSessionId ?? null,
        plannerInputId: input.plannerInputId ?? null,
        opaqueHandle: null,
        recoveryReason:
          "No stable Hermes resume handle was supplied; process-level continuity is limited to this live PTY process and SkyTurn state.",
      };

  return {
    command,
    args: makeHermesPlannerPtyArgs({
      opaqueHandle: input.hermesSessionHandle,
      extraArgs: options.extraArgs,
      source,
    }),
    cwd,
    commandLabel: "Hermes CLI PTY",
    metadata,
  };
}

export function createHermesPlannerPtyTransport(
  options: HermesPlannerPtyTransportOptions,
): HermesPlannerPtyTransport {
  return new HermesPlannerPtyTransportImpl(options);
}

class HermesPlannerPtyTransportImpl implements HermesPlannerPtyTransport {
  private readonly terminalManager: PtyTerminalSessionManager;
  private readonly sessionsByCanvasSessionId = new Map<
    string,
    { terminalSessionId: string; metadata: HermesPlannerPtySessionMetadata }
  >();

  constructor(private readonly options: HermesPlannerPtyTransportOptions) {
    this.terminalManager = createPtyTerminalSessionManager(options);
  }

  async startSession(input: StartHermesPlannerPtySessionInput): Promise<HermesPlannerPtySession> {
    this.assertFeatureEnabled();
    const existing = this.openSession(input.canvasSessionId);
    if (existing) return existing;

    const launch = await buildHermesPlannerPtySpawnLaunch(input, {
      executablePath: this.options.executablePath,
      extraArgs: this.options.extraArgs,
      source: this.options.source,
    });
    const terminalSession = await this.terminalManager.startSession({
      id: input.id ?? `hermes-planner-${input.canvasSessionId}`,
      runId: input.runId,
      canvasSessionId: input.canvasSessionId,
      agentKind: "hermes",
      cwd: launch.cwd,
      command: launch.command,
      args: launch.args,
      commandLabel: launch.commandLabel,
      cols: input.cols,
      rows: input.rows,
      env: input.env,
      sensitiveValues: input.hermesSessionHandle ? [input.hermesSessionHandle] : [],
    });
    this.sessionsByCanvasSessionId.set(input.canvasSessionId, {
      terminalSessionId: terminalSession.id,
      metadata: launch.metadata,
    });
    await this.emitPlannerMetadata(terminalSession, launch.metadata);
    return { terminalSession, metadata: { ...launch.metadata } };
  }

  async sendUserInput(canvasSessionId: string, data: string): Promise<void> {
    const session = this.requireOpenSession(canvasSessionId);
    await this.terminalManager.writeStdin(session.terminalSession.id, data);
  }

  async resizeSession(canvasSessionId: string, size: { cols: number; rows: number }): Promise<void> {
    const session = this.requireOpenSession(canvasSessionId);
    await this.terminalManager.resize(session.terminalSession.id, size);
  }

  async cancelSession(canvasSessionId: string, reason?: string): Promise<TerminalSessionExitEvidence | null> {
    const session = this.requireSession(canvasSessionId);
    return this.terminalManager.cancelSession(session.terminalSession.id, reason);
  }

  async terminateSession(canvasSessionId: string, reason?: string): Promise<TerminalSessionExitEvidence | null> {
    const session = this.requireSession(canvasSessionId);
    return this.terminalManager.terminateSession(session.terminalSession.id, reason);
  }

  getSession(canvasSessionId: string): HermesPlannerPtySession | null {
    const session = this.openSession(canvasSessionId);
    if (session) return session;
    this.sessionsByCanvasSessionId.delete(canvasSessionId);
    return null;
  }

  private openSession(canvasSessionId: string): HermesPlannerPtySession | null {
    const stored = this.sessionsByCanvasSessionId.get(canvasSessionId);
    if (!stored) return null;
    const terminalSession = this.terminalManager.getSession(stored.terminalSessionId);
    if (!terminalSession || isFinalTerminalSessionStatus(terminalSession.status)) {
      this.sessionsByCanvasSessionId.delete(canvasSessionId);
      return null;
    }
    return {
      terminalSession,
      metadata: { ...stored.metadata },
    };
  }

  private requireOpenSession(canvasSessionId: string): HermesPlannerPtySession {
    const session = this.openSession(canvasSessionId);
    if (!session) throw new Error(`No open Hermes planner PTY session for CanvasSession: ${canvasSessionId}`);
    return session;
  }

  private requireSession(canvasSessionId: string): HermesPlannerPtySession {
    const stored = this.sessionsByCanvasSessionId.get(canvasSessionId);
    if (!stored) throw new Error(`Unknown Hermes planner PTY session for CanvasSession: ${canvasSessionId}`);
    const terminalSession = this.terminalManager.getSession(stored.terminalSessionId);
    if (!terminalSession) throw new Error(`Unknown Hermes planner terminal session: ${stored.terminalSessionId}`);
    return {
      terminalSession,
      metadata: { ...stored.metadata },
    };
  }

  private assertFeatureEnabled(): void {
    const flags = this.options.featureFlags ?? DEFAULT_AGENT_TRANSPORT_FEATURE_FLAGS;
    if (!flags.ptyInteractiveSessions) {
      throw new Error("Hermes planner PTY transport is disabled by feature flag.");
    }
  }

  private async emitPlannerMetadata(
    terminalSession: AgentTerminalSession,
    metadata: HermesPlannerPtySessionMetadata,
  ): Promise<void> {
    const message = metadata.degraded
      ? `Hermes planner PTY started with process-level continuity: ${metadata.recoveryReason}`
      : "Hermes planner PTY started with a stable Hermes resume handle.";
    try {
      await this.options.emitEvent?.({
        kind: "progress",
        terminalSessionId: terminalSession.id,
        runId: terminalSession.runId,
        message,
      });
    } catch {
      // Planner metadata observers must not decide PTY lifecycle.
    }
  }
}

class AgentRunWatchdog {
  private finalized = false;
  private terminalClaimed = false;
  private killTimer: NodeJS.Timeout | null = null;
  private timeoutTimer: NodeJS.Timeout | null = null;
  private stallTimer: NodeJS.Timeout | null = null;
  private lastActivityAt = Date.now();

  constructor(
    private readonly child: ChildProcess,
    private readonly policy: AgentRunWatchdogPolicy,
    private readonly emit: (draft: RunEventDraft) => Promise<RunEvent>,
    private readonly drain: () => Promise<void>,
    private readonly stopChildOutput: () => void,
    private readonly closeRunResources: () => Promise<void> = async () => undefined,
  ) {}

  start(): void {
    this.markActivity();
    this.scheduleStallTelemetry();
    if (this.policy.timeoutMs <= 0) return;
    this.timeoutTimer = setTimeout(() => {
      void this.expire();
    }, this.policy.timeoutMs);
  }

  markActivity(): void {
    this.lastActivityAt = Date.now();
  }

  isFinalized(): boolean {
    return this.finalized;
  }

  async cancel(reason: string): Promise<void> {
    const publicReason = sanitizePublicEvidenceText(reason) || "Run cancelled";
    this.tryFinalize();
    if (!this.tryClaimTerminal()) {
      await this.closeRunResources();
      return;
    }
    this.scheduleKill();
    await this.drain();
    await this.closeRunResources();
    await emitRunEventBestEffort(this.emit, {
      kind: "evidence",
      payload: {
        exitCode: null,
        checks: [
          {
            kind: "run-exit",
            name: `${this.policy.commandLabel} exit`,
            status: "skipped",
            detail: publicReason,
          },
        ],
      },
    });
    await emitRunEventBestEffort(this.emit, {
      kind: "status",
      payload: { status: "cancelled", reason: publicReason },
    });
  }

  async finalizeChildClose(): Promise<boolean> {
    await this.drain();
    return this.tryFinalize();
  }

  async abortStart(): Promise<void> {
    this.tryFinalize();
    this.scheduleKill();
    await this.drain();
    await this.closeRunResources();
  }

  tryFinalize(): boolean {
    if (this.finalized) return false;
    this.finalized = true;
    this.clearLifecycleTimers();
    this.stopChildOutput();
    return true;
  }

  tryClaimTerminal(): boolean {
    if (this.terminalClaimed) return false;
    this.terminalClaimed = true;
    return true;
  }

  private async expire(): Promise<void> {
    if (!this.tryFinalize() || !this.tryClaimTerminal()) return;
    this.scheduleKill();
    await this.drain();
    await this.closeRunResources();
    await emitRunEventBestEffort(this.emit, {
      kind: "evidence",
      payload: {
        exitCode: null,
        checks: [
          {
            kind: "run-timeout",
            name: this.policy.timeoutCheckName,
            status: "failed",
            detail: `timed out after ${this.policy.timeoutMs}ms`,
          },
        ],
      },
    });
    await emitRunEventBestEffort(this.emit, {
      kind: "status",
      payload: {
        status: "timed-out",
        category: "process-timeout",
        reason: `${this.policy.commandLabel} timed out after ${this.policy.timeoutMs}ms`,
      },
    });
  }

  private scheduleStallTelemetry(): void {
    if (this.policy.stallTelemetryMs <= 0 || this.finalized) return;
    this.stallTimer = setTimeout(() => {
      void (async () => {
        try {
          if (this.finalized) return;
          const idleMs = Date.now() - this.lastActivityAt;
          if (idleMs >= this.policy.stallTelemetryMs) {
            await this.emit({
              kind: "progress",
              payload: {
                source: this.policy.source,
                phase: "stalled",
                status: "running",
                idleMs,
                detail: `${this.policy.commandLabel} still running after ${idleMs}ms without output.`,
              },
            });
          }
        } catch {
          // Non-terminal telemetry must not decide run lifecycle.
        } finally {
          this.scheduleStallTelemetry();
        }
      })();
    }, this.policy.stallTelemetryMs);
  }

  private scheduleKill(): void {
    if (this.killTimer) clearTimeout(this.killTimer);
    terminateProcessTree(this.child, "SIGTERM", { forceProcessGroup: true });
    this.killTimer = setTimeout(() => {
      terminateProcessTree(this.child, "SIGKILL", { forceProcessGroup: true });
    }, this.policy.killTimeoutMs);
    this.killTimer.unref();
  }

  private clearLifecycleTimers(): void {
    if (this.timeoutTimer) clearTimeout(this.timeoutTimer);
    if (this.stallTimer) clearTimeout(this.stallTimer);
    this.timeoutTimer = null;
    this.stallTimer = null;
  }
}

export function createCodexCliAdapter(options: CodexCliAdapterOptions = {}): LocalAgentAdapterContract {
  const defaultSandbox = options.sandbox ?? "read-only";
  const artifactVerificationHooks = artifactVerificationHooksFrom(options);
  return {
    kind: "codex",
    label: "Codex CLI",
    nativeConfigFiles: ["AGENTS.md", "skills"],
    supportLevel: "experimental-run",
    capabilities: ["chat", "file-read", "file-write", "shell", "mcp", "worktree"],
    async detect() {
      return detectCliDescriptor({
        kind: "codex",
        label: "Codex CLI",
        executablePath: options.executablePath,
        candidates: commandCandidates.codex,
        pathValue: options.pathValue ?? process.env.PATH ?? "",
        supportLevel: "experimental-run",
        capabilities: ["chat", "file-read", "file-write", "shell", "mcp", "worktree"],
        configFiles: ["AGENTS.md", "skills"],
        env: options.env ?? process.env,
        authEnvNames: codexAuthEnvNames,
        codexConfigRoot: options.codexConfigRoot,
        codexAuthFilePath: options.codexAuthFilePath,
      });
    },
    async startRun(input, sink) {
      const workdir = await resolveRunWorkdir(input, sink, "codex", "Codex CLI");
      if (!workdir) return noopRunHandle();
      let worktreeHandle: FileHandle | null = null;
      try {
        if (artifactVerificationPlatform(artifactVerificationHooks) !== "win32") {
          worktreeHandle = await open(
            workdir,
            fsConstants.O_RDONLY | fsConstants.O_DIRECTORY | fsConstants.O_NOFOLLOW,
          );
          const worktreeStat = await worktreeHandle.stat();
          if (!worktreeStat.isDirectory()) throw new Error("Run worktree is not a directory.");
          await artifactVerificationHooks?.afterWorktreeOpen?.(worktreeHandle.fd);
        }
      } catch {
        await worktreeHandle?.close().catch(() => undefined);
        return failRunPreflight(sink, "codex", "Codex CLI", "invalid-cwd", "Codex CLI worktree could not be anchored.");
      }
      const retainedWorktree = worktreeHandle;
      const artifactVerificationAbort = new AbortController();
      let windowsVerifier: WindowsExpectedArtifactVerifierSession | null = null;
      let closeRunResourcesPromise: Promise<void> | null = null;
      const closeRunResources = (): Promise<void> => {
        if (closeRunResourcesPromise) return closeRunResourcesPromise;
        closeRunResourcesPromise = Promise.resolve().then(async () => {
          artifactVerificationAbort.abort();
          await windowsVerifier?.abort().catch(() => undefined);
          await retainedWorktree?.close().catch(() => undefined);
        });
        return closeRunResourcesPromise;
      };
      if (!(await hasGitMetadata(workdir))) {
        await closeRunResources();
        return failRunPreflight(sink, "codex", "Codex CLI", "invalid-cwd", "Codex CLI requires a git repository.");
      }
      const executablePath = await resolveCliExecutable(
        options.executablePath,
        commandCandidates.codex,
        options.pathValue ?? process.env.PATH ?? "",
      );
      if (!executablePath) {
        await closeRunResources();
        return failRunPreflight(sink, "codex", "Codex CLI", "cli-missing", "Codex CLI executable was not found.");
      }
      try {
        if (artifactVerificationPlatform(artifactVerificationHooks) === "win32") {
          windowsVerifier = await openWindowsArtifactVerifierForRun(
            workdir,
            input,
            artifactVerificationHooks,
          );
        }
      } catch (error) {
        await closeRunResources();
        throw error;
      }

      const sandbox = isCodexCliSandbox(input.sandbox) ? input.sandbox : defaultSandbox;
      const args = makeCodexExecArgs({
        prompt: input.prompt,
        sandbox,
        workdir,
        extraArgs: options.extraArgs,
      });
      let child: ChildProcess;
      try {
        child = spawn(executablePath, args, {
          cwd: workdir,
          env: { ...process.env, ...options.env },
          detached: process.platform !== "win32",
          shell: false,
          stdio: ["ignore", "pipe", "pipe"],
        });
      } catch (error) {
        await closeRunResources();
        throw error;
      }
      let spawnFailed = false;
      const { emit, drain } = createQueuedRunEventEmitter(sink);
      const outputReaders: Interface[] = [];
      const stderrLines: string[] = [];
      let stdoutFailureCategory: CliFailureCategory | null = null;
      const watchdog = new AgentRunWatchdog(
        child,
        {
          source: "codex",
          commandLabel: "Codex CLI",
          timeoutCheckName: "Codex CLI watchdog",
          timeoutMs: options.timeoutMs ?? options.defaultWatchdogTimeoutMs ?? defaultRunWatchdogTimeoutMs,
          stallTelemetryMs: options.stallTelemetryMs ?? defaultStallTelemetryMs,
          killTimeoutMs: options.killTimeoutMs ?? defaultKillTimeoutMs,
        },
        emit,
        drain,
        () => closeReadlineInterfaces(outputReaders),
        async () => {
          await closeRunResources();
        },
      );

      if (child.stdout) {
        const stdout = createInterface({ input: child.stdout, crlfDelay: Infinity });
        outputReaders.push(stdout);
        stdout.on("line", (line) => {
          if (watchdog.isFinalized()) return;
          watchdog.markActivity();
          const drafts = codexStdoutLineToDrafts(line).map(redactRunEventDraft);
          stdoutFailureCategory ??= specificCliFailureCategoryFromDrafts(drafts);
          for (const draft of drafts) {
            if (watchdog.isFinalized()) return;
            void emit(draft);
          }
        });
      }

      if (child.stderr) {
        const stderr = createInterface({ input: child.stderr, crlfDelay: Infinity });
        outputReaders.push(stderr);
        stderr.on("line", (line) => {
          if (watchdog.isFinalized()) return;
          if (!line.trim()) return;
          watchdog.markActivity();
          const safeLine = sanitizePublicProcessText(line);
          stderrLines.push(safeLine);
          void emit({
            kind: "progress",
            payload: { source: "codex", stream: "stderr", format: "text", text: safeLine },
          });
        });
      }

      child.once("error", (error) => {
        spawnFailed = true;
        if (!watchdog.tryFinalize() || !watchdog.tryClaimTerminal()) return;
        const category = errorCategoryFromSpawnError(error);
        const publicMessage = sanitizePublicEvidenceText(error.message) || "Codex CLI spawn failed";
        void emitRunEventBestEffort(emit, {
          kind: "error",
          payload: { source: "codex", message: publicMessage, code: error.name, category },
        });
        void emitRunEventBestEffort(emit, {
          kind: "evidence",
          payload: {
            exitCode: null,
            checks: [
              {
                kind: "run-exit",
                name: "Codex CLI spawn",
                status: "failed",
                detail: `${category}: ${publicMessage}`,
              },
            ],
          },
        });
        void closeRunResources().then(async () => {
          await emitRunEventBestEffort(emit, { kind: "status", payload: { status: "failed", reason: category } });
        });
      });

      child.once("close", (code, signal) => {
        void (async () => {
          if (!(await watchdog.finalizeChildClose())) return;
          if (spawnFailed) return;
          const exitCode = typeof code === "number" ? code : null;
          const checkStatus = exitCode === 0 ? "passed" : "failed";
          const failureCategory = exitCode === 0 ? null : stdoutFailureCategory ?? processFailureCategory(stderrLines);
          if (failureCategory && !stdoutFailureCategory) {
            await emitRunEventBestEffort(emit, {
              kind: "error",
              payload: {
                source: "codex",
                category: failureCategory,
                message: sanitizePublicProcessText(
                  formatProcessFailureMessage("Codex CLI", exitCode, signal, stderrLines),
                ),
              },
            });
          }
          let artifactVerification: ExpectedArtifactVerification;
          try {
            artifactVerification = await verifyExpectedArtifacts(
              input,
              workdir,
              retainedWorktree?.fd ?? null,
              exitCode,
              artifactVerificationHooks,
              windowsVerifier,
              artifactVerificationAbort.signal,
            );
          } catch {
            artifactVerification = expectedArtifactVerificationFailure();
          }
          await closeRunResources();
          if (!watchdog.tryClaimTerminal()) return;
          const succeeded = exitCode === 0 && artifactVerification.passed;
          await emitRunEventBestEffort(emit, {
            kind: "evidence",
            payload: {
              exitCode,
              checks: [
                {
                  kind: "run-exit",
                  name: "Codex CLI exit",
                  status: checkStatus,
                  detail: formatExitDetail(code, signal),
                },
                ...(artifactVerification.check ? [artifactVerification.check] : []),
              ],
              ...(artifactVerification.artifacts.length > 0 ? { artifacts: artifactVerification.artifacts } : {}),
            },
          });
          await emitRunEventBestEffort(emit, {
            kind: "status",
            payload: {
              status: succeeded ? "succeeded" : "failed",
              exitCode,
              signal,
              ...(failureCategory ? { reason: failureCategory } : {}),
              ...(!artifactVerification.passed ? { reason: "expected-artifact-failure" } : {}),
            },
          });
        })();
      });

      const started = emit({
        kind: "progress",
        payload: { source: "codex", phase: "started", command: "codex exec" },
      });
      watchdog.start();
      try {
        await started;
      } catch (error) {
        await watchdog.abortStart();
        throw error;
      }

      return {
        async cancel(reason) {
          await watchdog.cancel(reason);
        },
      };
    },
  };
}

export function createHermesCliAdapter(options: HermesCliAdapterOptions = {}): LocalAgentAdapterContract {
  const artifactVerificationHooks = artifactVerificationHooksFrom(options);
  return {
    kind: "hermes",
    label: "Hermes CLI",
    nativeConfigFiles: ["AGENTS.md"],
    supportLevel: "experimental-run",
    capabilities: ["chat", "file-read", "file-write", "shell", "worktree", "resume"],
    async detect() {
      return detectCliDescriptor({
        kind: "hermes",
        label: "Hermes CLI",
        executablePath: options.executablePath,
        candidates: commandCandidates.hermes,
        pathValue: options.pathValue ?? process.env.PATH ?? "",
        supportLevel: "experimental-run",
        capabilities: ["chat", "file-read", "file-write", "shell", "worktree", "resume"],
        configFiles: ["AGENTS.md"],
        env: options.env ?? process.env,
        authEnvNames: hermesAuthEnvNames,
      });
    },
    async startRun(input, sink) {
      const workdir = await resolveRunWorkdir(input, sink, "hermes", "Hermes CLI");
      if (!workdir) return noopRunHandle();
      let worktreeHandle: FileHandle | null = null;
      try {
        if (artifactVerificationPlatform(artifactVerificationHooks) !== "win32") {
          worktreeHandle = await open(
            workdir,
            fsConstants.O_RDONLY | fsConstants.O_DIRECTORY | fsConstants.O_NOFOLLOW,
          );
          const worktreeStat = await worktreeHandle.stat();
          if (!worktreeStat.isDirectory()) throw new Error("Run worktree is not a directory.");
          await artifactVerificationHooks?.afterWorktreeOpen?.(worktreeHandle.fd);
        }
      } catch {
        await worktreeHandle?.close().catch(() => undefined);
        return failRunPreflight(sink, "hermes", "Hermes CLI", "invalid-cwd", "Hermes CLI worktree could not be anchored.");
      }
      const retainedWorktree = worktreeHandle;
      const artifactVerificationAbort = new AbortController();
      let windowsVerifier: WindowsExpectedArtifactVerifierSession | null = null;
      let closeRunResourcesPromise: Promise<void> | null = null;
      const closeRunResources = (): Promise<void> => {
        if (closeRunResourcesPromise) return closeRunResourcesPromise;
        closeRunResourcesPromise = Promise.resolve().then(async () => {
          artifactVerificationAbort.abort();
          await windowsVerifier?.abort().catch(() => undefined);
          await retainedWorktree?.close().catch(() => undefined);
        });
        return closeRunResourcesPromise;
      };
      const executablePath = await resolveCliExecutable(
        options.executablePath,
        commandCandidates.hermes,
        options.pathValue ?? process.env.PATH ?? "",
      );
      if (!executablePath) {
        await closeRunResources();
        return failRunPreflight(sink, "hermes", "Hermes CLI", "cli-missing", "Hermes CLI executable was not found.");
      }
      try {
        if (artifactVerificationPlatform(artifactVerificationHooks) === "win32") {
          windowsVerifier = await openWindowsArtifactVerifierForRun(
            workdir,
            input,
            artifactVerificationHooks,
          );
        }
      } catch (error) {
        await closeRunResources();
        throw error;
      }
      const args = makeHermesChatArgs({
        prompt: input.prompt,
        opaqueHandle: input.hermesSessionHandle,
        extraArgs: options.extraArgs,
        source: options.source ?? "skyturn",
      });
      const transport = input.hermesSessionHandle ? "hermes_session_resume" : "hermes_replay_recovery";
      let child: ChildProcess;
      try {
        child = spawn(executablePath, args, {
          cwd: workdir,
          env: { ...process.env, ...options.env },
          detached: process.platform !== "win32",
          shell: false,
          stdio: ["ignore", "pipe", "pipe"],
        });
      } catch (error) {
        await closeRunResources();
        throw error;
      }
      let spawnFailed = false;
      const { emit, drain } = createQueuedRunEventEmitter(sink);
      const stderrLines: string[] = [];
      let outputStopped = false;
      let output: StreamingAdapterOutput | null = null;
      let watchdog: AgentRunWatchdog;
      const onStdoutData = (chunk: Buffer | string) => {
        if (!watchdog.isFinalized()) output?.push("stdout", chunk);
      };
      const onStderrData = (chunk: Buffer | string) => {
        if (!watchdog.isFinalized()) output?.push("stderr", chunk);
      };
      const stopOutput = () => {
        if (outputStopped) return;
        outputStopped = true;
        child.stdout?.off("data", onStdoutData);
        child.stderr?.off("data", onStderrData);
        output?.flush();
      };
      watchdog = new AgentRunWatchdog(
        child,
        {
          source: "hermes",
          commandLabel: "Hermes CLI",
          timeoutCheckName: "Hermes CLI watchdog",
          timeoutMs: options.timeoutMs ?? options.defaultWatchdogTimeoutMs ?? defaultRunWatchdogTimeoutMs,
          stallTelemetryMs: options.stallTelemetryMs ?? defaultStallTelemetryMs,
          killTimeoutMs: options.killTimeoutMs ?? defaultKillTimeoutMs,
        },
        emit,
        drain,
        stopOutput,
        async () => {
          await closeRunResources();
        },
      );
      output = createStreamingAdapterOutput({
        emit,
        sensitiveValues: input.hermesSessionHandle ? [input.hermesSessionHandle] : [],
        onActivity: () => watchdog.markActivity(),
        onStderr: (text) => stderrLines.push(text),
      });

      child.stdout?.on("data", onStdoutData);
      child.stderr?.on("data", onStderrData);

      child.once("error", (error) => {
        spawnFailed = true;
        if (!watchdog.tryFinalize() || !watchdog.tryClaimTerminal()) return;
        artifactVerificationAbort.abort();
        const category = errorCategoryFromSpawnError(error);
        const publicMessage = sanitizePublicProcessTextWithSensitiveValues(
          error.message,
          input.hermesSessionHandle ? [input.hermesSessionHandle] : [],
        ) || "Hermes CLI spawn failed";
        void emitRunEventBestEffort(emit, {
          kind: "error",
          payload: { source: "hermes", message: publicMessage, code: error.name, category },
        });
        void emitRunEventBestEffort(emit, {
          kind: "evidence",
          payload: {
            exitCode: null,
            checks: [
              {
                kind: "run-exit",
                name: "Hermes CLI spawn",
                status: "failed",
                detail: `${category}: ${publicMessage}`,
              },
            ],
          },
        });
        void closeRunResources().then(async () => {
          await emitRunEventBestEffort(emit, { kind: "status", payload: { status: "failed", reason: category } });
        });
      });

      child.once("close", (code, signal) => {
        void (async () => {
          if (!(await watchdog.finalizeChildClose())) return;
          if (spawnFailed) return;
          const exitCode = typeof code === "number" ? code : null;
          const checkStatus = exitCode === 0 ? "passed" : "failed";
          const failureCategory = exitCode === 0 ? null : processFailureCategory(stderrLines);
          if (failureCategory) {
            await emitRunEventBestEffort(emit, {
              kind: "error",
              payload: {
                source: "hermes",
                category: failureCategory,
                message: sanitizePublicProcessText(
                  formatProcessFailureMessage("Hermes CLI", exitCode, signal, stderrLines),
                ),
              },
            });
          }
          let artifactVerification: ExpectedArtifactVerification;
          try {
            artifactVerification = await verifyExpectedArtifacts(
              input,
              workdir,
              retainedWorktree?.fd ?? null,
              exitCode,
              artifactVerificationHooks,
              windowsVerifier,
              artifactVerificationAbort.signal,
            );
          } catch {
            artifactVerification = expectedArtifactVerificationFailure();
          }
          await closeRunResources();
          if (!watchdog.tryClaimTerminal()) return;
          const succeeded = exitCode === 0 && artifactVerification.passed;
          await emitRunEventBestEffort(emit, {
            kind: "evidence",
            payload: {
              exitCode,
              checks: [
                {
                  kind: "run-exit",
                  name: "Hermes CLI exit",
                  status: checkStatus,
                  detail: formatExitDetail(code, signal),
                },
                ...(artifactVerification.check ? [artifactVerification.check] : []),
              ],
              ...(artifactVerification.artifacts.length > 0 ? { artifacts: artifactVerification.artifacts } : {}),
            },
          });
          await emitRunEventBestEffort(emit, {
            kind: "status",
            payload: {
              status: succeeded ? "succeeded" : "failed",
              exitCode,
              signal,
              ...(failureCategory ? { reason: failureCategory } : {}),
              ...(!artifactVerification.passed ? { reason: "expected-artifact-failure" } : {}),
            },
          });
        })();
      });

      watchdog.start();
      try {
        await emit({
          kind: "progress",
          payload: {
            source: "hermes",
            phase: "started",
            command: "hermes chat -q",
            transport,
            plannerSessionId: input.plannerSessionId ?? null,
            plannerInputId: input.plannerInputId ?? null,
            opaqueHandle: input.hermesSessionHandle ? "[redacted]" : null,
            ...(transport === "hermes_replay_recovery"
              ? {
                  recoveryReason:
                    "This is not the same Hermes native session; continuity comes from SkyTurn workflow events and checkpoints.",
                }
              : {}),
          },
        });
      } catch (error) {
        await watchdog.abortStart();
        throw error;
      }

      return {
        async cancel(reason) {
          await watchdog.cancel(reason);
        },
      };
    },
  };
}

function terminateProcessTree(
  child: ChildProcess,
  signal: NodeJS.Signals,
  options: { forceProcessGroup?: boolean } = {},
): void {
  const pid = child.pid;
  if (!pid) return;
  if (!options.forceProcessGroup && (child.exitCode !== null || child.signalCode !== null)) return;
  if (process.platform === "win32") {
    if (child.exitCode !== null || child.signalCode !== null) return;
    child.kill(signal);
    return;
  }
  try {
    process.kill(-pid, signal);
  } catch {
    if (child.exitCode === null && child.signalCode === null) child.kill(signal);
  }
}

function closeReadlineInterfaces(readers: Interface[]): void {
  for (const reader of readers) {
    reader.removeAllListeners("line");
    reader.close();
  }
}

interface ExpectedArtifactVerification {
  artifacts: string[];
  check: EvidenceCheck | null;
  passed: boolean;
}

function expectedArtifactVerificationFailure(): ExpectedArtifactVerification {
  return {
    artifacts: [],
    check: {
      kind: "artifact",
      name: "Expected artifacts",
      status: "failed",
      detail: "verified=0 missing=0 empty=0 unsafe=1",
    },
    passed: false,
  };
}

type ExpectedArtifactState = "present" | "missing" | "empty" | "unsafe";

interface ExpectedArtifactInspection {
  state: ExpectedArtifactState;
  identity?: string;
}

function artifactVerificationPlatform(
  hooks: ArtifactVerificationHooks | undefined,
): NodeJS.Platform {
  return hooks?.platform ?? process.platform;
}

async function openWindowsArtifactVerifierForRun(
  workdir: string,
  input: StartAgentRunInput,
  hooks: ArtifactVerificationHooks | undefined,
) {
  const artifacts = strictExpectedArtifactDeclarations(input.expectedArtifacts);
  if (artifacts.length === 0) return null;
  await hooks?.beforeHelperStart?.();
  return openWindowsExpectedArtifactVerifierSession(workdir, artifacts, {
    ...hooks?.windowsVerifierDependencies,
    platform: "win32",
    ...(hooks?.helperPath ? { helperPath: hooks.helperPath } : {}),
    ...(hooks?.helperTimeoutMs ? { timeoutMs: hooks.helperTimeoutMs } : {}),
    afterRootOpen: hooks?.afterParentOpen,
    afterArtifactsOpen: hooks?.afterArtifactOpen ?? hooks?.afterOpen,
  });
}

async function verifyExpectedArtifacts(
  input: StartAgentRunInput,
  workdir: string,
  worktreeFd: number | null,
  exitCode: number | null,
  hooks: ArtifactVerificationHooks = {},
  windowsVerifier: WindowsExpectedArtifactVerifierSession | null = null,
  signal?: AbortSignal,
): Promise<ExpectedArtifactVerification> {
  const declarations = parseExpectedArtifactDeclarations(
    input.expectedArtifacts === undefined ? [] : input.expectedArtifacts,
  );
  if (!declarations) return expectedArtifactVerificationFailure();
  if (declarations.length === 0) {
    return { artifacts: [], check: null, passed: true };
  }
  if (exitCode !== 0) return { artifacts: [], check: null, passed: true };
  const artifacts: string[] = [];
  const counts: Record<ExpectedArtifactState, number> = { present: 0, missing: 0, empty: 0, unsafe: 0 };
  const normalizedArtifacts: string[] = [];
  for (const candidate of declarations) {
    const artifact = parseExpectedArtifactDeclaration(candidate);
    if (!artifact) {
      counts.unsafe += 1;
      continue;
    }
    if (!parseRunEvidenceArtifacts([...normalizedArtifacts, artifact])) {
      counts.unsafe += 1;
      continue;
    }
    normalizedArtifacts.push(artifact);
  }
  if (counts.unsafe > 0) {
    return {
      artifacts: [],
      check: {
        kind: "artifact",
        name: "Expected artifacts",
        status: "failed",
        detail: `verified=0 missing=0 empty=0 unsafe=${counts.unsafe}`,
      },
      passed: false,
    };
  }
  if (artifactVerificationPlatform(hooks) === "win32") {
    if (signal?.aborted) return { artifacts: [], check: null, passed: false };
    if (!windowsVerifier) return expectedArtifactVerificationFailure();
    const result = await windowsVerifier.verify();
    return {
      artifacts: result.passed ? result.artifacts : [],
      check: {
        kind: "artifact",
        name: "Expected artifacts",
        status: result.passed ? "passed" : "failed",
        detail: `verified=${result.counts.verified} missing=${result.counts.missing} empty=${result.counts.empty} unsafe=${result.counts.unsafe}`,
      },
      passed: result.passed,
    };
  }
  if (worktreeFd === null) return expectedArtifactVerificationFailure();
  const seenIdentities = new Set<string>();
  let duplicateIdentity = false;
  for (const artifact of normalizedArtifacts) {
    if (signal?.aborted) return { artifacts: [], check: null, passed: false };
    await hooks.beforeHelperStart?.();
    if (signal?.aborted) return { artifacts: [], check: null, passed: false };
    const inspection = await inspectExpectedArtifact(worktreeFd, artifact, hooks, signal);
    if (signal?.aborted) return { artifacts: [], check: null, passed: false };
    if (inspection.identity && seenIdentities.has(inspection.identity)) {
      counts.unsafe += 1;
      duplicateIdentity = true;
      continue;
    }
    if (inspection.identity) seenIdentities.add(inspection.identity);
    counts[inspection.state] += 1;
    if (inspection.state === "present") artifacts.push(artifact);
  }
  const passed = counts.missing === 0 && counts.empty === 0 && counts.unsafe === 0;
  return {
    artifacts: passed && !duplicateIdentity ? artifacts : [],
    check: {
      kind: "artifact",
      name: "Expected artifacts",
      status: passed ? "passed" : "failed",
      detail: `verified=${counts.present} missing=${counts.missing} empty=${counts.empty} unsafe=${counts.unsafe}`,
    },
    passed,
  };
}

async function inspectExpectedArtifact(
  worktreeFd: number,
  artifact: string,
  hooks: ArtifactVerificationHooks,
  signal?: AbortSignal,
): Promise<ExpectedArtifactInspection> {
  if (signal?.aborted) return { state: "unsafe" };
  const helperPath = hooks.helperPath ?? fileURLToPath(new URL("./native/artifact-gate", import.meta.url));
  return new Promise((resolve) => {
    let child: ChildProcess;
    try {
      child = spawn(helperPath, [artifact], {
        stdio: ["pipe", "pipe", "ignore", worktreeFd],
      });
    } catch {
      resolve({ state: "unsafe" });
      return;
    }
    const helperInput = child.stdin!;
    const helperOutput = child.stdout!;
    let output = "";
    let parentHookStarted = false;
    let artifactHookStarted = false;
    let inputClosed = false;
    let result: ExpectedArtifactInspection = { state: "unsafe" };
    const closeInput = (continueHelper = false) => {
      if (inputClosed) return;
      inputClosed = true;
      helperInput.end(continueHelper ? "\n" : undefined);
    };
    const abortHelper = () => {
      if (!inputClosed) {
        inputClosed = true;
        helperInput.destroy();
      }
      child.kill("SIGKILL");
    };
    signal?.addEventListener("abort", abortHelper, { once: true });
    if (signal?.aborted) abortHelper();
    const timeout = setTimeout(abortHelper, hooks.helperTimeoutMs ?? artifactHelperTimeoutMs);
    helperInput.on("error", () => undefined);
    child.once("error", abortHelper);
    helperOutput.setEncoding("utf8");
    helperOutput.on("data", (chunk: string) => {
      output += chunk;
      if (output.includes("RESULT ")) closeInput();
      if (!parentHookStarted && output.includes("READY\n")) {
        parentHookStarted = true;
        void Promise.resolve(hooks.afterParentOpen?.())
          .then(() => {
            if (!inputClosed) helperInput.write("\n");
          })
          .catch(abortHelper);
      }
      if (!artifactHookStarted && output.includes("OPENED\n")) {
        artifactHookStarted = true;
        const helperPid = child.pid ?? -1;
        void Promise.resolve(hooks.afterArtifactOpen?.(helperPid) ?? hooks.afterOpen?.(helperPid))
          .then(() => closeInput(true))
          .catch(abortHelper);
      }
    });
    child.once("close", (code) => {
      clearTimeout(timeout);
      signal?.removeEventListener("abort", abortHelper);
      closeInput();
      if (code === 0) {
        const match = /(?:^|\n)RESULT (present|missing|empty|unsafe)(?: ([0-9]+:[0-9]+))?\n?$/.exec(output);
        if (match) {
          const state = match[1] as ExpectedArtifactState;
          result = { state, ...(match[2] ? { identity: match[2] } : {}) };
        }
      }
      resolve(result);
    });
  });
}

export async function readTaskOutput(projectRoot: string, nodeId: string): Promise<string> {
  try {
    return await readFile(taskOutputPath(projectRoot, nodeId), "utf8");
  } catch {
    return "";
  }
}

export function deriveEvidenceFromEvents(run: AgentRun, events: RunEvent[]): RunEvidence {
  const evidence = deriveRunEvidenceFromRunEvents({
    runId: run.id,
    events,
    initialStatus: run.status,
    initialCompletedAt: run.endedAt ?? null,
  });
  if (!evidence) throw new Error("Invalid RunEvidence event stream.");
  return evidence;
}

export interface FlowEventsFromAgentRunInput {
  sessionId: string;
  laneId: string;
  segmentId: string;
  run: AgentRun;
  events: RunEvent[];
  evidence: RunEvidence;
  now: string;
}

export function flowEventsFromAgentRun(input: FlowEventsFromAgentRunInput): FlowEvent[] {
  const sanitizedEvidence = parseRunEvidence(input.evidence);
  if (!sanitizedEvidence) throw new Error("Invalid RunEvidence.");
  const outputEvents = input.events.map((candidate) => {
    const event = parseRunEvent(candidate);
    if (!event || event.runId !== input.run.id) throw new Error("Invalid RunEvent output stream.");
    return event;
  }).filter((event) => event.kind === "output" || event.kind === "progress" || event.kind === "changes");
  const started = makeFlowEvent(input, 1, "workflow.segment.started", {
    segment: {
      id: input.segmentId,
      laneId: input.laneId,
      runId: input.run.id,
      status: "running",
      exitCode: null,
    },
  });
  const output = outputEvents.map((event, index) =>
    makeFlowEvent(input, index + 2, "workflow.segment.output_delta", {
      laneId: input.laneId,
      segmentId: input.segmentId,
      ...(typeof event.payload.text === "string" ? { text: event.payload.text } : {}),
      delta: event,
    }),
  );
  const evidenceSeq = output.length + 2;
  const evidence = makeFlowEvent(input, evidenceSeq, "workflow.evidence.recorded", {
    laneId: input.laneId,
    segmentId: input.segmentId,
    evidence: {
      id: `evidence-${input.segmentId}`,
      kind: "run-exit",
      status: sanitizedEvidence.status === "cancelled"
        ? "skipped"
        : isSuccessfulRunEvidence(sanitizedEvidence, { source: "current", expectedArtifactContract: false })
          ? "passed"
          : "failed",
      checks: sanitizedEvidence.checks.map((check) => check.name),
      artifacts: sanitizedEvidence.artifacts,
      detail: sanitizedEvidence.errorReason ?? sanitizedEvidence.cancelReason ?? undefined,
      runEvidence: sanitizedEvidence,
    },
  });
  const finished = makeFlowEvent(input, evidenceSeq + 1, "workflow.segment.finished", {
    laneId: input.laneId,
    segmentId: input.segmentId,
    status: flowSegmentStatusFromRunEvidence(sanitizedEvidence),
    exitCode: sanitizedEvidence.exitCode,
    errorReason: sanitizedEvidence.errorReason,
  });
  return [started, ...output, evidence, finished];
}

function makeFlowEvent(
  input: FlowEventsFromAgentRunInput,
  seq: number,
  kind: FlowEvent["kind"],
  payload: Record<string, unknown>,
): FlowEvent {
  return {
    id: `${input.sessionId}:agent-flow-event:${input.segmentId}:${String(seq).padStart(4, "0")}`,
    sessionId: input.sessionId,
    seq,
    kind,
    source: input.run.agentKind,
    payload,
    createdAt: input.now,
    idempotencyKey: `segment:${input.segmentId}:${kind}:${seq}`,
  };
}

function flowSegmentStatusFromRunEvidence(evidence: RunEvidence): "succeeded" | "failed" | "cancelled" | "timed-out" {
  if (evidence.status === "cancelled") return "cancelled";
  if (evidence.status === "timed-out") return "timed-out";
  if (isSuccessfulRunEvidence(evidence, { source: "current", expectedArtifactContract: false })) return "succeeded";
  return "failed";
}

async function detectCliDescriptor(input: {
  kind: AgentKind;
  label: string;
  executablePath?: string;
  candidates: string[];
  pathValue: string;
  supportLevel: AgentSupportLevel;
  capabilities: AgentDescriptor["capabilities"];
  configFiles: string[];
  env: NodeJS.ProcessEnv;
  authEnvNames: string[];
  codexConfigRoot?: string | null;
  codexAuthFilePath?: string | null;
}): Promise<AgentDescriptor> {
  const executablePath = await resolveCliExecutable(input.executablePath, input.candidates, input.pathValue);
  if (!executablePath) {
    return {
      kind: input.kind,
      label: input.label,
      executablePath: null,
      version: null,
      status: "missing",
      supportLevel: "detected-only",
      capabilities: input.capabilities,
      configFiles: input.configFiles,
      readiness: {
        level: "unavailable",
        cli: { available: false, path: null, version: null },
        auth: { status: "unknown" },
        categories: ["cli-missing"],
      },
    };
  }

  const versionProbe = await probeCliVersion(executablePath, input.env);
  const auth = await authReadiness({
    kind: input.kind,
    env: input.env,
    authEnvNames: input.authEnvNames,
    codexConfigRoot: input.codexConfigRoot,
    codexAuthFilePath: input.codexAuthFilePath,
  });
  const categories: AgentReadinessCategory[] = [];
  if (versionProbe.error) categories.push("version-probe-failed");
  if (auth.status === "missing") categories.push("auth-missing");
  if (auth.status === "unknown" && hasAuthReadinessRequirement(input.kind)) categories.push("auth-unknown");
  return {
    kind: input.kind,
    label: input.label,
    executablePath,
    version: versionProbe.version,
    status: "available",
    supportLevel: runnableSupportLevel(input.supportLevel),
    capabilities: input.capabilities,
    configFiles: input.configFiles,
    readiness: {
      level: readinessLevel(input.supportLevel),
      cli: { available: true, path: executablePath, version: versionProbe.version },
      auth,
      categories,
    },
  };
}

async function resolveCliExecutable(
  executablePath: string | undefined,
  candidates: string[],
  pathValue: string,
): Promise<string | null> {
  if (!executablePath) return findExecutable(candidates, pathValue);
  if (!isPathLikeCommand(executablePath)) return findExecutable([executablePath], pathValue);
  try {
    await access(executablePath, fsConstants.X_OK);
    return executablePath;
  } catch {
    return null;
  }
}

function isPathLikeCommand(value: string): boolean {
  return value.includes("/") || value.includes("\\");
}

async function findExecutable(commands: string[], pathValue: string): Promise<string | null> {
  for (const directory of pathValue.split(delimiter).filter(Boolean)) {
    for (const command of commands) {
      const candidate = join(directory, command);
      try {
        await access(candidate, fsConstants.X_OK);
        return candidate;
      } catch {
        // Try the next candidate.
      }
    }
  }
  return null;
}

function runnableSupportLevel(supportLevel: AgentSupportLevel): AgentSupportLevel {
  return supportLevel === "experimental-run" ? "experimental-run" : "detected-only";
}

function readinessLevel(supportLevel: AgentSupportLevel): "detected-only" | "experimental-run" {
  return supportLevel === "experimental-run" ? "experimental-run" : "detected-only";
}

function authEnvNamesForAgent(kind: AgentKind): string[] {
  if (kind === "codex") return codexAuthEnvNames;
  if (kind === "hermes") return hermesAuthEnvNames;
  return [];
}

async function authReadiness(input: {
  kind: AgentKind;
  env: NodeJS.ProcessEnv;
  authEnvNames: string[];
  codexConfigRoot?: string | null;
  codexAuthFilePath?: string | null;
}): Promise<NonNullable<AgentDescriptor["readiness"]>["auth"]> {
  const hasEnvAuth = input.authEnvNames.some((name) => {
    const value = input.env[name];
    return typeof value === "string" && value.trim().length > 0;
  });
  if (hasEnvAuth) return { status: "available", source: "environment" };
  if (input.kind !== "codex") return { status: "unknown" };

  const authFilePath = codexAuthEvidencePath(input);
  if (!authFilePath) return { status: "unknown" };
  return codexLocalAuthReadiness(authFilePath);
}

function codexAuthEvidencePath(input: {
  env: NodeJS.ProcessEnv;
  codexConfigRoot?: string | null;
  codexAuthFilePath?: string | null;
}): string | null {
  if (input.codexAuthFilePath !== undefined) return input.codexAuthFilePath;
  if (input.codexConfigRoot !== undefined) {
    return input.codexConfigRoot ? join(input.codexConfigRoot, codexAuthFileName) : null;
  }
  const codexHome = input.env.CODEX_HOME;
  if (typeof codexHome === "string" && codexHome.trim()) return join(codexHome, codexAuthFileName);
  return join(homedir(), ".codex", codexAuthFileName);
}

async function codexLocalAuthReadiness(
  authFilePath: string,
): Promise<NonNullable<AgentDescriptor["readiness"]>["auth"]> {
  try {
    const raw = await readFile(authFilePath, "utf8");
    if (!raw.trim()) return { status: "missing" };
    const value = JSON.parse(raw) as unknown;
    return hasCodexAuthTokenShape(value) ? { status: "available" } : { status: "missing" };
  } catch (error) {
    if (error instanceof SyntaxError || isFileMissingError(error)) return { status: "missing" };
    return { status: "unknown" };
  }
}

function hasCodexAuthTokenShape(value: unknown): boolean {
  if (!isRecord(value)) return false;
  if (hasNonEmptyStringField(value, "OPENAI_API_KEY")) return true;
  const tokens = value.tokens;
  return (
    isRecord(tokens) &&
    (hasNonEmptyStringField(tokens, "access_token") ||
      hasNonEmptyStringField(tokens, "id_token") ||
      hasNonEmptyStringField(tokens, "refresh_token"))
  );
}

function hasNonEmptyStringField(record: Record<string, unknown>, field: string): boolean {
  const value = record[field];
  return typeof value === "string" && value.trim().length > 0;
}

function hasAuthReadinessRequirement(kind: AgentKind): boolean {
  return kind === "codex" || kind === "hermes";
}

function isFileMissingError(error: unknown): boolean {
  if (typeof error !== "object" || error === null || !("code" in error)) return false;
  const code = (error as { code?: unknown }).code;
  return code === "ENOENT" || code === "ENOTDIR";
}

function probeCliVersion(executablePath: string, env: NodeJS.ProcessEnv): Promise<{ version: string | null; error: string | null }> {
  return new Promise((resolve) => {
    let done = false;
    let stdout = "";
    let stderr = "";
    const child = spawn(executablePath, ["--version"], {
      env: versionProbeEnv(env),
      shell: false,
      stdio: ["ignore", "pipe", "pipe"],
    });
    const finish = (result: { version: string | null; error: string | null }) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      resolve(result);
    };
    const timer = setTimeout(() => {
      terminateProcessTree(child, "SIGKILL");
      finish({ version: null, error: "version probe timed out" });
    }, cliProbeTimeoutMs);
    timer.unref();
    child.stdout?.on("data", (chunk: Buffer) => {
      stdout = boundProbeOutput(`${stdout}${chunk.toString("utf8")}`);
    });
    child.stderr?.on("data", (chunk: Buffer) => {
      stderr = boundProbeOutput(`${stderr}${chunk.toString("utf8")}`);
    });
    child.once("error", (error) => {
      finish({ version: null, error: error.message });
    });
    child.once("close", (code) => {
      if (code === 0) finish({ version: firstOutputLine(stdout || stderr), error: null });
      else finish({ version: null, error: firstOutputLine(stderr || stdout) ?? `exit ${code ?? "unknown"}` });
    });
  });
}

function versionProbeEnv(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const output: NodeJS.ProcessEnv = {};
  const pathValue = env.PATH ?? env.Path ?? process.env.PATH ?? process.env.Path;
  if (pathValue) output.PATH = pathValue;

  if (process.platform === "win32") {
    for (const name of ["Path", "SystemRoot", "WINDIR", "COMSPEC", "PATHEXT"]) {
      const value = env[name] ?? process.env[name];
      if (value) output[name] = value;
    }
  }

  return output;
}

function boundProbeOutput(value: string): string {
  return value.length > 8_192 ? value.slice(0, 8_192) : value;
}

function firstOutputLine(value: string): string | null {
  return value
    .split(/\r?\n/)
    .map((line) => line.trim())
    .find(Boolean) ?? null;
}

async function resolveRunWorkdir(
  input: StartAgentRunInput,
  sink: RunEventSink,
  source: AgentKind,
  commandLabel: string,
): Promise<string | null> {
  try {
    return await realpath(input.worktreePath || input.projectRoot);
  } catch {
    await failRunPreflight(
      sink,
      source,
      commandLabel,
      "invalid-cwd",
      "Run worktree could not be resolved.",
    );
    return null;
  }
}

async function failRunPreflight(
  sink: RunEventSink,
  source: AgentKind,
  commandLabel: string,
  category: CliFailureCategory,
  message: string,
): Promise<AgentRunHandle> {
  const publicMessage = sanitizePublicEvidenceText(message) || "Run preflight failed.";
  await sink.emit({
    kind: "error",
    payload: { source, category, message: publicMessage },
  });
  await sink.emit({
    kind: "evidence",
    payload: {
      exitCode: null,
      checks: [
        {
          kind: "run-exit",
          name: `${commandLabel} preflight`,
          status: "failed",
          detail: `${category}: ${publicMessage}`,
        },
      ],
    },
  });
  await sink.emit({ kind: "status", payload: { status: "failed", reason: category } });
  return noopRunHandle();
}

function noopRunHandle(): AgentRunHandle {
  return { async cancel() {} };
}

function errorCategoryFromSpawnError(error: Error): CliFailureCategory {
  const code = "code" in error && typeof error.code === "string" ? error.code : "";
  return code === "ENOENT" ? "cli-missing" : "non-zero-exit";
}

function processFailureCategory(stderrLines: string[]): CliFailureCategory {
  return isAuthMissingMessage(stderrLines.join("\n")) ? "auth-missing" : "non-zero-exit";
}

function isAuthMissingMessage(message: string): boolean {
  return /not logged in|authentication required|login required|unauthorized|missing api key|api key (missing|required|not found)/i.test(
    message,
  );
}

function formatProcessFailureMessage(
  commandLabel: string,
  exitCode: number | null,
  signal: NodeJS.Signals | null,
  stderrLines: string[],
): string {
  const stderr = firstOutputLine(stderrLines.join("\n"));
  const exitDetail = formatExitDetail(exitCode, signal);
  return stderr ? `${commandLabel} failed: ${stderr}` : `${commandLabel} failed: ${exitDetail}`;
}

function redactSecretLikeText(value: string): string {
  return value
    .replace(/\bBearer\s+[A-Za-z0-9._~+/=-]{8,}/gi, "Bearer [redacted]")
    .replace(/\bsk-[A-Za-z0-9_-]{8,}\b/g, "[redacted]")
    .replace(
      /(["']?)\b(api[_-]?key|access[_-]?token|refresh[_-]?token|id[_-]?token|token|OPENAI_API_KEY|HERMES_API_KEY|ANTHROPIC_API_KEY)\1(\s*[:=]\s*)(["']?)[^\s,'\"}]{8,}\4/gi,
      "$1$2$1$3$4[redacted]$4",
    );
}

function sanitizePublicProcessText(value: string): string {
  return sanitizePublicEvidenceText(redactSecretLikeText(value));
}

function sanitizePublicProcessTextWithSensitiveValues(value: string, sensitiveValues: string[]): string {
  const redactor = new StreamingSensitiveOutputRedactor(sensitiveValues);
  return sanitizePublicProcessText([
    ...redactor.push("stdout", value),
    ...redactor.flush(),
  ].map((chunk) => chunk.text).join(""));
}

interface StreamingAdapterOutput {
  push(stream: TerminalOutputStream, chunk: Buffer | string): void;
  flush(): void;
}

function createStreamingAdapterOutput(input: {
  emit: (draft: RunEventDraft) => Promise<RunEvent>;
  sensitiveValues?: string[];
  onActivity: () => void;
  onStderr: (text: string) => void;
}): StreamingAdapterOutput {
  const redactor = new StreamingSensitiveOutputRedactor(input.sensitiveValues);
  const decoders: Record<TerminalOutputStream, StringDecoder> = {
    stdout: new StringDecoder("utf8"),
    stderr: new StringDecoder("utf8"),
  };
  let flushed = false;
  const publish = (chunks: RedactedTerminalChunk[]) => {
    for (const chunk of chunks) {
      if (!chunk.text) continue;
      if (chunk.stream === "stderr") {
        input.onStderr(chunk.text);
        void input.emit({
          kind: "progress",
          payload: { source: "hermes", stream: "stderr", format: "text", text: chunk.text },
        });
      } else {
        void input.emit({
          kind: "output",
          payload: { source: "hermes", stream: "stdout", format: "text", text: chunk.text },
        });
      }
    }
  };
  return {
    push(stream, chunk) {
      if (flushed) return;
      input.onActivity();
      const value = typeof chunk === "string" ? chunk : decoders[stream].write(chunk);
      publish(redactor.push(stream, value));
    },
    flush() {
      if (flushed) return;
      flushed = true;
      for (const stream of ["stdout", "stderr"] as const) {
        const tail = decoders[stream].end();
        if (tail) publish(redactor.push(stream, tail));
      }
      publish(redactor.flush());
    },
  };
}

function redactRunEventDraft(draft: RunEventDraft): RunEventDraft {
  return {
    ...draft,
    payload: redactSecretLikeValue(draft.payload) as RunEventDraft["payload"],
  };
}

function redactSecretLikeValue(value: unknown): unknown {
  if (typeof value === "string") return redactSecretLikeText(value);
  if (Array.isArray(value)) return value.map(redactSecretLikeValue);
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(
    Object.entries(value).map(([key, nested]) => [key, redactSecretLikeValue(nested)]),
  );
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function specificCliFailureCategoryFromDrafts(drafts: RunEventDraft[]): CliFailureCategory | null {
  for (const draft of drafts) {
    if (draft.kind !== "error") continue;
    const category = cliFailureCategory(draft.payload.category);
    if (!category || category === "non-zero-exit") continue;
    return category;
  }
  return null;
}

function cliFailureCategory(value: unknown): CliFailureCategory | null {
  if (
    value === "cli-missing" ||
    value === "auth-missing" ||
    value === "invalid-cwd" ||
    value === "process-timeout" ||
    value === "non-zero-exit" ||
    value === "output-parse-error"
  ) {
    return value;
  }
  return null;
}

async function appendWorkspaceRunEventMirror(projectRoot: string, event: RunEvent): Promise<void> {
  const target = runEventsPath(projectRoot, event.runId);
  await mkdir(join(projectRoot, ".devflow", "runs", event.runId), { recursive: true });
  let handle: FileHandle | null = null;
  try {
    handle = await open(
      target,
      fsConstants.O_WRONLY |
        fsConstants.O_APPEND |
        fsConstants.O_CREAT |
        (fsConstants.O_NOFOLLOW ?? 0),
      0o600,
    );
    const value = await handle.stat();
    if (!value.isFile()) throw new Error("Workspace run event mirror is invalid.");
    await handle.writeFile(`${JSON.stringify(event)}\n`, "utf8");
  } finally {
    await handle?.close().catch(() => undefined);
  }
}

const terminalPersistenceFailureReason = "terminal-persistence-failed" as const;
const runStartClaimInvalidReason = "run-start-claim-invalid" as const;

export class InvalidDurableRunStartClaimError extends Error {
  constructor() {
    super(runStartClaimInvalidReason);
    this.name = "InvalidDurableRunStartClaimError";
  }
}

function terminalPersistenceFailureEvidence(claim: DurableRunStartClaim, completedAt: string): RunEvidence {
  const evidence = parseRunEvidence({
    runId: claim.runId,
    status: "failed",
    exitCode: null,
    changesetId: null,
    checks: [{
      kind: "run-exit",
      name: "Terminal persistence",
      status: "failed",
      detail: terminalPersistenceFailureReason,
    }],
    artifacts: [],
    review: null,
    errorReason: terminalPersistenceFailureReason,
    cancelReason: null,
    completedAt,
  });
  if (!evidence) throw new Error(terminalPersistenceFailureReason);
  return evidence;
}

async function claimedRunRecoveryEvidence(
  store: DurableRunClaimStore,
  projectRoot: string,
  runId: string,
): Promise<RunEvidence | null> {
  const claim = await loadDurableRunStartClaim(store, projectRoot, runId);
  if (claim.kind === "invalid") throw new InvalidDurableRunStartClaimError();
  return claimedRunRecoveryEvidenceFromRead(claim);
}

function claimedRunRecoveryEvidenceFromRead(claim: DurableRunStartClaimRead): RunEvidence | null {
  return claim.kind === "valid"
    ? terminalPersistenceFailureEvidence(claim.claim, claim.claim.startedAt)
    : null;
}

async function writeTaskOutputFromEvents(projectRoot: string, nodeId: string, events: RunEvent[]): Promise<void> {
  const output = events
    .filter((event) => event.kind === "output")
    .map((event) => (typeof event.payload.text === "string" ? event.payload.text : ""))
    .filter(Boolean)
    .join("");
  await mkdir(join(projectRoot, ".devflow", "tasks", nodeId), { recursive: true });
  await writeFile(taskOutputPath(projectRoot, nodeId), output, "utf8");
}

function runEventsPath(projectRoot: string, runId: string): string {
  return join(projectRoot, ".devflow", "runs", runId, "events.ndjson");
}

function runTerminalKey(projectRoot: string, runId: string): string {
  return `${projectRoot}\0${runId}`;
}

function taskOutputPath(projectRoot: string, nodeId: string): string {
  return join(projectRoot, ".devflow", "tasks", nodeId, "output.md");
}

function makeRunId(sessionId: string, nodeId: string): string {
  return `run-${sessionId}-${nodeId}`;
}

async function nextAttemptRunId(
  store: DurableRunClaimStore,
  projectRoot: string,
  sessionId: string,
  nodeId: string,
  runs: ReadonlyMap<string, AgentRun>,
): Promise<string> {
  const base = makeRunId(sessionId, nodeId);
  for (let attempt = 1; ; attempt += 1) {
    const candidate = attempt === 1 ? base : `${base}-attempt-${attempt}`;
    if (!runs.has(candidate) && !(await hasRunState(store, projectRoot, candidate))) return candidate;
  }
}

async function hasRunState(store: DurableRunClaimStore, projectRoot: string, runId: string): Promise<boolean> {
  const privateEvents = await createPrivateRunEventStore({ durableRunClaimStore: store }).read(projectRoot, runId);
  return privateEvents.kind !== "missing" || await hasRunStartClaim(store, projectRoot, runId);
}

async function claimExplicitRunStart(
  store: DurableRunClaimStore,
  run: AgentRun,
  startFingerprint: string,
): Promise<boolean> {
  try {
    return await store.publish(run.projectRoot, {
      runId: run.id,
      nodeId: run.nodeId,
      sessionId: run.sessionId,
      agentKind: run.agentKind,
      startFingerprint,
      startedAt: run.startedAt,
    }) === "published";
  } catch (error) {
    if (error instanceof DurableRunClaimPublicationError && error.owned) {
      throw new OwnedAgentRunStartError(error);
    }
    throw error;
  }
}

async function assertDurableRunStartFingerprint(
  store: DurableRunClaimStore,
  run: AgentRun,
  fingerprint: string | undefined,
): Promise<void> {
  if (!fingerprint) return;
  const claim = await loadDurableRunStartClaim(store, run.projectRoot, run.id);
  if (claim.kind === "invalid") throw new InvalidDurableRunStartClaimError();
  if (claim.kind !== "valid") throw new Error(`Run ${run.id} is already claimed with different identity.`);
  assertDurableRunStartClaimIdentity(run, fingerprint, claim.claim);
}

function assertDurableRunStartClaimIdentity(
  run: AgentRun,
  fingerprint: string | undefined,
  claim: DurableRunStartClaim,
): void {
  if (
    claim.runId !== run.id ||
    claim.nodeId !== run.nodeId ||
    claim.sessionId !== run.sessionId ||
    claim.agentKind !== run.agentKind ||
    (fingerprint !== undefined && claim.startFingerprint !== fingerprint)
  ) throw new Error(`Run ${run.id} is already claimed with different identity.`);
}

async function loadDurableRunStartClaim(
  store: DurableRunClaimStore,
  projectRoot: string,
  runId: string,
): Promise<DurableRunStartClaimRead> {
  return store.read(projectRoot, runId);
}

async function hasRunStartClaim(store: DurableRunClaimStore, projectRoot: string, runId: string): Promise<boolean> {
  return (await loadDurableRunStartClaim(store, projectRoot, runId)).kind !== "missing";
}

function makePersistedRun(projectRoot: string, runId: string): AgentRun {
  return {
    id: runId,
    nodeId: "unknown",
    sessionId: "unknown",
    projectRoot,
    worktreePath: projectRoot,
    agentKind: "codex",
    status: "running",
    startedAt: new Date(0).toISOString(),
  };
}

function isRunStatus(value: unknown): value is AgentRunStatus {
  return (
    value === "queued" ||
    value === "running" ||
    value === "waiting-input" ||
    value === "requires-approval" ||
    value === "succeeded" ||
    value === "failed" ||
    value === "cancelled" ||
    value === "timed-out"
  );
}

function isFinalStatusEvent(event: RunEvent): boolean {
  return event.kind === "status" && isRunStatus(event.payload.status) && isFinalRunStatus(event.payload.status);
}

function isFinalRunStatus(status: AgentRunStatus): boolean {
  return status === "succeeded" || status === "failed" || status === "cancelled" || status === "timed-out";
}

function isFinalTerminalSessionStatus(status: TerminalSessionStatus): boolean {
  return status === "exited" || status === "failed" || status === "cancelled" || status === "timed-out";
}

function isCodexCliSandbox(value: unknown): value is CodexCliSandbox {
  return value === "read-only" || value === "workspace-write" || value === "danger-full-access";
}

function makeCodexExecArgs(input: {
  prompt: string;
  sandbox: CodexCliSandbox;
  workdir: string;
  extraArgs?: string[];
}): string[] {
  return [
    "exec",
    "--json",
    "--ephemeral",
    "--color",
    "never",
    "--sandbox",
    input.sandbox,
    "-c",
    "approval_policy=never",
    ...(input.extraArgs ?? []),
    "-C",
    input.workdir,
    input.prompt,
  ];
}

function makeHermesChatArgs(input: {
  prompt: string;
  opaqueHandle?: string;
  extraArgs?: string[];
  source: string;
}): string[] {
  return [
    "chat",
    "-q",
    input.prompt,
    "--quiet",
    "--source",
    input.source,
    ...(input.opaqueHandle ? ["--resume", input.opaqueHandle] : []),
    ...(input.extraArgs ?? []),
  ];
}

function makeHermesPlannerPtyArgs(input: {
  opaqueHandle?: string;
  extraArgs?: string[];
  source: string;
}): string[] {
  return [
    "chat",
    "--cli",
    "--source",
    input.source,
    ...(input.opaqueHandle ? ["--resume", input.opaqueHandle] : []),
    ...(input.extraArgs ?? []),
  ];
}

function codexStdoutLineToDrafts(line: string): RunEventDraft[] {
  if (!line.trim()) return [];
  const event = parseJsonObject(line);
  if (!event) {
    return [
      {
        kind: "progress",
        payload: {
          source: "codex",
          stream: "stdout",
          format: "text",
          text: sanitizePublicProcessText(line),
          category: "output-parse-error",
        },
      },
    ];
  }

  const eventType = typeof event.type === "string" ? event.type : "unknown";
  const structuredChanges = codexStructuredChangesDraft(event, eventType);
  if (eventType === "thread.started") {
    return [
      {
        kind: "progress",
        payload: {
          source: "codex",
          eventType,
          threadId: typeof event.thread_id === "string" ? event.thread_id : null,
        },
      },
    ];
  }
  if (eventType === "turn.started") {
    return [{ kind: "status", payload: { status: "running", source: "codex", eventType } }];
  }
  if (eventType === "turn.completed") {
    if (structuredChanges) {
      return [structuredChanges, { kind: "progress", payload: { source: "codex", eventType, usage: event.usage ?? null } }];
    }
    return [{ kind: "progress", payload: { source: "codex", eventType, usage: event.usage ?? null } }];
  }
  if (eventType === "item.completed") {
    const text = getCodexAgentMessage(event);
    if (text) return [{ kind: "output", payload: { source: "codex", text } }];
    if (structuredChanges) return [structuredChanges];
    return [{ kind: "progress", payload: { source: "codex", eventType, itemType: getNestedString(event, "item", "type") } }];
  }
  if (eventType === "error" || eventType === "turn.failed") {
    const message = sanitizePublicProcessText(getCodexErrorMessage(event));
    return [
      {
        kind: "error",
        payload: {
          source: "codex",
          eventType,
          message,
          ...(isAuthMissingMessage(message) ? { category: "auth-missing" } : {}),
        },
      },
    ];
  }
  if (structuredChanges) return [structuredChanges];
  return [{ kind: "progress", payload: { source: "codex", eventType } }];
}

function codexStructuredChangesDraft(event: Record<string, unknown>, eventType: string): RunEventDraft | null {
  const changes = extractCodexStructuredChanges(event);
  if (changes.length === 0) return null;
  const files = [...new Set(changes.flatMap((change) => [change.previousPath, change.path]).filter((file): file is string => Boolean(file)))];
  const patchPreview = changes
    .map((change) => change.unifiedDiff)
    .filter((diff): diff is string => Boolean(diff))
    .join("\n");
  const boundedPatchPreview = boundStructuredDiff(patchPreview);
  return {
    kind: "changes",
    payload: {
      source: "codex",
      status: "available",
      eventType,
      files,
      changes,
      ...(boundedPatchPreview.value ? { patchPreview: boundedPatchPreview.value } : {}),
      ...(boundedPatchPreview.truncated ? { patchPreviewTruncated: true } : {}),
    },
  };
}

function extractCodexStructuredChanges(event: Record<string, unknown>): StructuredRunChange[] {
  const candidates = [
    event.item,
    event.patch,
    event.diff,
    event.file_change,
    event.fileChange,
    event.turn_diff,
    event.turnDiff,
    event,
  ].filter(isRecord);
  const changes: StructuredRunChange[] = [];
  for (const candidate of candidates) {
    const nestedChanges = arrayField(candidate, "changes") ?? arrayField(candidate, "file_changes") ?? arrayField(candidate, "fileChanges");
    if (nestedChanges) {
      for (const nested of nestedChanges) {
        if (isRecord(nested)) {
          const change = structuredChangeFromRecord(nested);
          if (change) changes.push(change);
        }
      }
    }
    const change = structuredChangeFromRecord(candidate);
    if (change) changes.push(change);
  }
  return dedupeStructuredChanges(changes);
}

function structuredChangeFromRecord(record: Record<string, unknown>): StructuredRunChange | null {
  const itemType = stringField(record, "type");
  const hasStructuredType = itemType === "file_change" || itemType === "patch" || itemType === "turn_diff";
  const operation = normalizeChangeOperation(
    stringField(record, "operation") ??
      stringField(record, "kind") ??
      stringField(record, "change_type") ??
      stringField(record, "status"),
  );
  const path =
    stringField(record, "path") ??
    stringField(record, "file") ??
    stringField(record, "file_path") ??
    stringField(record, "target_path") ??
    stringField(record, "new_path");
  const unifiedDiff =
    stringField(record, "unifiedDiff") ??
    stringField(record, "unified_diff") ??
    stringField(record, "diff") ??
    stringField(record, "patch");
  const boundedUnifiedDiff = unifiedDiff ? boundStructuredDiff(unifiedDiff).value : null;
  if (!path || (!operation && !unifiedDiff && !hasStructuredType)) return null;
  const previousPath =
    stringField(record, "previousPath") ??
    stringField(record, "previous_path") ??
    stringField(record, "old_path") ??
    stringField(record, "source_path") ??
    stringField(record, "from");
  return {
    operation: operation ?? "update",
    path,
    ...(previousPath ? { previousPath } : {}),
    ...(boundedUnifiedDiff ? { unifiedDiff: boundedUnifiedDiff } : {}),
  };
}

function boundStructuredDiff(value: string): { value: string; truncated: boolean } {
  if (!value || Buffer.byteLength(value) <= maxStructuredChangeDiffBytes) return { value, truncated: false };
  let output = "";
  for (const char of value) {
    if (Buffer.byteLength(`${output}${char}\n[diff truncated]\n`) > maxStructuredChangeDiffBytes) break;
    output += char;
  }
  return { value: `${output.trimEnd()}\n[diff truncated]\n`, truncated: true };
}

function normalizeChangeOperation(value: string | null): StructuredRunChange["operation"] | null {
  const normalized = value?.toLowerCase();
  if (!normalized) return null;
  if (normalized === "add" || normalized === "added" || normalized === "create" || normalized === "created") return "add";
  if (normalized === "delete" || normalized === "deleted" || normalized === "remove" || normalized === "removed") return "delete";
  if (normalized === "move" || normalized === "moved" || normalized === "rename" || normalized === "renamed") return "move";
  if (normalized === "update" || normalized === "updated" || normalized === "modify" || normalized === "modified" || normalized === "change") return "update";
  return null;
}

function stringField(record: Record<string, unknown>, key: string): string | null {
  const value = record[key];
  return typeof value === "string" && value.trim().length > 0 ? value : null;
}

function arrayField(record: Record<string, unknown>, key: string): unknown[] | null {
  const value = record[key];
  return Array.isArray(value) ? value : null;
}

function dedupeStructuredChanges(changes: StructuredRunChange[]): StructuredRunChange[] {
  const seen = new Set<string>();
  return changes.filter((change) => {
    const key = `${change.operation}:${change.previousPath ?? ""}:${change.path}:${change.unifiedDiff ?? ""}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function createQueuedRunEventEmitter(sink: RunEventSink): {
  emit(draft: RunEventDraft): Promise<RunEvent>;
  drain(): Promise<void>;
} {
  let queue = Promise.resolve();
  return {
    emit(draft) {
      const next = queue.then(() => sink.emit(draft));
      queue = next.then(
        () => undefined,
        () => undefined,
      );
      return next;
    },
    async drain() {
      await queue;
    },
  };
}

async function emitRunEventBestEffort(
  emit: (draft: RunEventDraft) => Promise<RunEvent>,
  draft: RunEventDraft,
): Promise<void> {
  try {
    await emit({ ...draft, [retryTerminalPersistence]: true } as TerminalRunEventDraft);
  } catch {
    // A failed terminal draft must not escape a detached lifecycle handler.
  }
}

async function hasGitMetadata(workdir: string): Promise<boolean> {
  try {
    await access(join(workdir, ".git"), fsConstants.F_OK);
    return true;
  } catch {
    return false;
  }
}

function parseJsonObject(line: string): Record<string, unknown> | null {
  try {
    const value = JSON.parse(line) as unknown;
    return isRecord(value) ? value : null;
  } catch {
    return null;
  }
}

function getCodexAgentMessage(event: Record<string, unknown>): string | null {
  const item = isRecord(event.item) ? event.item : null;
  if (!item || item.type !== "agent_message") return null;
  if (typeof item.text === "string") return item.text;
  if (!Array.isArray(item.content)) return null;
  const text = item.content
    .map((part) => (isRecord(part) && typeof part.text === "string" ? part.text : ""))
    .filter(Boolean)
    .join("");
  return text || null;
}

function getCodexErrorMessage(event: Record<string, unknown>): string {
  if (typeof event.message === "string") return event.message;
  if (isRecord(event.error) && typeof event.error.message === "string") return event.error.message;
  return "Codex CLI run failed.";
}

function getNestedString(value: Record<string, unknown>, key: string, nestedKey: string): string | null {
  const nested = isRecord(value[key]) ? value[key] : null;
  if (!nested) return null;
  return typeof nested[nestedKey] === "string" ? nested[nestedKey] : null;
}

function formatExitDetail(code: number | null, signal: NodeJS.Signals | string | null): string {
  if (typeof code === "number") return `exit ${code}`;
  if (signal) return `signal ${signal}`;
  return "process closed";
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}
