import { spawn, type ChildProcess } from "node:child_process";
import { access, appendFile, mkdir, readFile, realpath, writeFile } from "node:fs/promises";
import { constants as fsConstants } from "node:fs";
import { delimiter, join } from "node:path";
import { createInterface, type Interface } from "node:readline";

import type {
  AgentRunHandle,
  LocalAgentAdapterContract,
  RunEventDraft,
  RunEventSink,
} from "@skyturn/agent-runtime";
import { agentAdapterContracts } from "@skyturn/agent-runtime";
import {
  RUN_EVENT_PROTOCOL_VERSION,
  type AgentDescriptor,
  type AgentKind,
  type AgentRun,
  type AgentRunSandbox,
  type AgentRunStatus,
  type RunEvent,
  type RunEvidence,
  type StartAgentRunInput,
  type StructuredRunChange,
} from "@skyturn/project-core";
import type { FlowEvent } from "@skyturn/workflow-kernel";

export { RUN_EVENT_PROTOCOL_VERSION } from "@skyturn/project-core";

const commandCandidates: Record<AgentKind, string[]> = {
  hermes: ["hermes"],
  codex: ["codex"],
  gemini: ["gemini"],
  "claude-code": ["claude", "claude-code"],
  openclaw: ["openclaw"],
};
const defaultKillTimeoutMs = 5_000;
const defaultStallTelemetryMs = 60_000;
const defaultRunWatchdogTimeoutMs = 30 * 60_000;
const maxStructuredChangeDiffBytes = 64_000;

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
}

export interface DiscoveryService {
  discover(): Promise<AgentDescriptor[]>;
}

export interface AgentBridgeOptions {
  adapters?: LocalAgentAdapterContract[];
  pathValue?: string;
}

export type CodexCliSandbox = AgentRunSandbox;

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

export function createDiscoveryService(options: DiscoveryOptions = {}): DiscoveryService {
  return {
    async discover() {
      const pathValue = options.pathValue ?? process.env.PATH ?? "";
      return Promise.all(
        agentAdapterContracts.map(async (contract) => {
          const executablePath = await findExecutable(commandCandidates[contract.kind], pathValue);
          return {
            kind: contract.kind,
            label: contract.label,
            executablePath,
            version: null,
            status: executablePath ? "available" : "missing",
            supportLevel: contract.supportLevel,
            capabilities: contract.capabilities,
            configFiles: contract.nativeConfigFiles,
          } satisfies AgentDescriptor;
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
  private readonly listeners = new Set<(event: RunEvent) => void>();

  constructor(options: AgentBridgeOptions = {}) {
    this.adapters = new Map((options.adapters ?? [createMockAgentAdapter()]).map((adapter) => [adapter.kind, adapter]));
    this.discovery = createDiscoveryService({ pathValue: options.pathValue });
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

  async startRun(input: StartAgentRunInput): Promise<AgentRun> {
    const adapter = this.adapters.get(input.agentKind) ?? this.adapters.get("codex");
    if (!adapter) throw new Error(`No local adapter registered for ${input.agentKind}`);

    const now = new Date().toISOString();
    const runId = input.runId ?? (await nextAttemptRunId(input.projectRoot, input.sessionId, input.nodeId, this.runs));
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
    this.runs.set(run.id, run);

    const sink: RunEventSink = {
      emit: (event) => this.recordEvent(run.id, event),
    };
    const handle = await adapter.startRun({ ...input, runId: run.id }, sink);
    this.handles.set(run.id, handle);
    return this.runs.get(run.id) ?? run;
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
    let events = await loadRunEvents(run.projectRoot, runId);
    if (!events.some(isFinalStatusEvent)) {
      try {
        await this.recordEvent(runId, {
          kind: "status",
          payload: { status: "cancelled", reason },
        });
      } catch (statusError) {
        throw cancelError ?? statusError;
      }
      events = await loadRunEvents(run.projectRoot, runId);
    }
    return deriveEvidenceFromEvents(this.runs.get(runId) ?? run, events);
  }

  async loadEvents(projectRoot: string, runId: string): Promise<RunEvent[]> {
    return loadRunEvents(projectRoot, runId);
  }

  async getEvidence(projectRoot: string, runId: string): Promise<RunEvidence> {
    const run = this.runs.get(runId) ?? makePersistedRun(projectRoot, runId);
    const events = await loadRunEvents(projectRoot, runId);
    return deriveEvidenceFromEvents(run, events);
  }

  private async recordEvent(runId: string, draft: RunEventDraft): Promise<RunEvent> {
    const run = this.runs.get(runId);
    if (!run) throw new Error(`Unknown run ${runId}`);
    const event: RunEvent = {
      protocolVersion: RUN_EVENT_PROTOCOL_VERSION,
      runId,
      seq: (await loadRunEvents(run.projectRoot, runId)).length + 1,
      timestamp: draft.timestamp ?? new Date().toISOString(),
      kind: draft.kind,
      payload: draft.payload,
    };
    await appendRunEvent(run.projectRoot, event);
    if (event.kind === "output") await writeTaskOutputFromEvents(run.projectRoot, run.nodeId, runId);
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

  private updateRunFromEvent(run: AgentRun, event: RunEvent): void {
    if (event.kind !== "status") return;
    const status = event.payload.status;
    if (!isRunStatus(status)) return;
    if (isFinalRunStatus(run.status) && !isFinalRunStatus(status)) return;
    this.runs.set(run.id, {
      ...run,
      status,
      endedAt: isFinalRunStatus(status) ? event.timestamp : run.endedAt,
    });
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

export async function loadRunEvents(projectRoot: string, runId: string): Promise<RunEvent[]> {
  try {
    const value = await readFile(runEventsPath(projectRoot, runId), "utf8");
    return value
      .split("\n")
      .filter(Boolean)
      .map((line) => JSON.parse(line) as RunEvent);
  } catch {
    return [];
  }
}

class AgentRunWatchdog {
  private finalized = false;
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
    if (!this.tryFinalize()) return;
    this.scheduleKill();
    await this.drain();
    await this.emit({
      kind: "evidence",
      payload: {
        exitCode: null,
        checks: [
          {
            kind: "run-exit",
            name: `${this.policy.commandLabel} exit`,
            status: "skipped",
            detail: reason,
          },
        ],
      },
    });
    await this.emit({ kind: "status", payload: { status: "cancelled", reason } });
  }

  async finalizeChildClose(): Promise<boolean> {
    await this.drain();
    return this.tryFinalize();
  }

  tryFinalize(): boolean {
    if (this.finalized) return false;
    this.finalized = true;
    this.clearLifecycleTimers();
    this.stopChildOutput();
    return true;
  }

  private async expire(): Promise<void> {
    if (!this.tryFinalize()) return;
    this.scheduleKill();
    await this.drain();
    await this.emit({
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
    await this.emit({
      kind: "status",
      payload: {
        status: "timed-out",
        reason: `${this.policy.commandLabel} timed out after ${this.policy.timeoutMs}ms`,
      },
    });
  }

  private scheduleStallTelemetry(): void {
    if (this.policy.stallTelemetryMs <= 0 || this.finalized) return;
    this.stallTimer = setTimeout(() => {
      void (async () => {
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
        this.scheduleStallTelemetry();
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
  return {
    kind: "codex",
    label: "Codex CLI",
    nativeConfigFiles: ["AGENTS.md", "skills"],
    supportLevel: "experimental-run",
    capabilities: ["chat", "file-read", "file-write", "shell", "mcp", "worktree"],
    async detect() {
      const executablePath =
        options.executablePath ?? (await findExecutable(commandCandidates.codex, options.pathValue ?? process.env.PATH ?? ""));
      return {
        kind: "codex",
        label: "Codex CLI",
        executablePath,
        version: null,
        status: executablePath ? "available" : "missing",
        supportLevel: executablePath ? "experimental-run" : "detected-only",
        capabilities: ["chat", "file-read", "file-write", "shell", "mcp", "worktree"],
        configFiles: ["AGENTS.md", "skills"],
      };
    },
    async startRun(input, sink) {
      const workdir = await realpath(input.worktreePath || input.projectRoot);
      if (!(await hasGitMetadata(workdir))) {
        await sink.emit({
          kind: "error",
          payload: {
            source: "codex",
            code: "missing-git-repository",
            message: "Codex CLI requires a git repository.",
          },
        });
        await sink.emit({ kind: "status", payload: { status: "failed", reason: "missing-git-repository" } });
        return { async cancel() {} };
      }

      const executablePath = options.executablePath ?? "codex";
      const sandbox = isCodexCliSandbox(input.sandbox) ? input.sandbox : defaultSandbox;
      const args = makeCodexExecArgs({
        prompt: input.prompt,
        sandbox,
        workdir,
        extraArgs: options.extraArgs,
      });
      const child = spawn(executablePath, args, {
        cwd: workdir,
        env: { ...process.env, ...options.env },
        detached: process.platform !== "win32",
        shell: false,
        stdio: ["ignore", "pipe", "pipe"],
      });
      let spawnFailed = false;
      const { emit, drain } = createQueuedRunEventEmitter(sink);
      const outputReaders: Interface[] = [];
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
      );

      await emit({
        kind: "progress",
        payload: { source: "codex", phase: "started", command: "codex exec" },
      });
      watchdog.start();

      if (child.stdout) {
        const stdout = createInterface({ input: child.stdout, crlfDelay: Infinity });
        outputReaders.push(stdout);
        stdout.on("line", (line) => {
          if (watchdog.isFinalized()) return;
          watchdog.markActivity();
          for (const draft of codexStdoutLineToDrafts(line)) {
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
          void emit({
            kind: "progress",
            payload: { source: "codex", stream: "stderr", format: "text", text: line },
          });
        });
      }

      child.once("error", (error) => {
        spawnFailed = true;
        if (!watchdog.tryFinalize()) return;
        void emit({
          kind: "error",
          payload: { source: "codex", message: error.message, code: error.name },
        });
        void emit({ kind: "status", payload: { status: "failed", reason: error.message } });
      });

      child.once("close", (code, signal) => {
        void (async () => {
          if (!(await watchdog.finalizeChildClose())) return;
          if (spawnFailed) return;
          const exitCode = typeof code === "number" ? code : null;
          const checkStatus = exitCode === 0 ? "passed" : "failed";
          await emit({
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
              ],
            },
          });
          await emit({
            kind: "status",
            payload: {
              status: exitCode === 0 ? "succeeded" : "failed",
              exitCode,
              signal,
            },
          });
        })();
      });

      return {
        async cancel(reason) {
          await watchdog.cancel(reason);
        },
      };
    },
  };
}

export function createHermesCliAdapter(options: HermesCliAdapterOptions = {}): LocalAgentAdapterContract {
  return {
    kind: "hermes",
    label: "Hermes CLI",
    nativeConfigFiles: ["AGENTS.md"],
    supportLevel: "experimental-run",
    capabilities: ["chat", "file-read", "file-write", "shell", "worktree", "resume"],
    async detect() {
      const executablePath =
        options.executablePath ?? (await findExecutable(commandCandidates.hermes, options.pathValue ?? process.env.PATH ?? ""));
      return {
        kind: "hermes",
        label: "Hermes CLI",
        executablePath,
        version: null,
        status: executablePath ? "available" : "missing",
        supportLevel: executablePath ? "experimental-run" : "detected-only",
        capabilities: ["chat", "file-read", "file-write", "shell", "worktree", "resume"],
        configFiles: ["AGENTS.md"],
      };
    },
    async startRun(input, sink) {
      const workdir = await realpath(input.worktreePath || input.projectRoot);
      const executablePath = options.executablePath ?? "hermes";
      const args = makeHermesChatArgs({
        prompt: input.prompt,
        opaqueHandle: input.hermesSessionHandle,
        extraArgs: options.extraArgs,
        source: options.source ?? "skyturn",
      });
      const transport = input.hermesSessionHandle ? "hermes_session_resume" : "hermes_replay_recovery";
      const child = spawn(executablePath, args, {
        cwd: workdir,
        env: { ...process.env, ...options.env },
        detached: process.platform !== "win32",
        shell: false,
        stdio: ["ignore", "pipe", "pipe"],
      });
      let spawnFailed = false;
      const { emit, drain } = createQueuedRunEventEmitter(sink);
      const outputReaders: Interface[] = [];
      const watchdog = new AgentRunWatchdog(
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
        () => closeReadlineInterfaces(outputReaders),
      );

      await emit({
        kind: "progress",
        payload: {
          source: "hermes",
          phase: "started",
          command: "hermes chat -q",
          transport,
          plannerSessionId: input.plannerSessionId ?? null,
          plannerInputId: input.plannerInputId ?? null,
          opaqueHandle: input.hermesSessionHandle ?? null,
          ...(transport === "hermes_replay_recovery"
            ? {
                recoveryReason:
                  "This is not the same Hermes native session; continuity comes from SkyTurn workflow events and checkpoints.",
              }
            : {}),
        },
      });
      watchdog.start();

      if (child.stdout) {
        const stdout = createInterface({ input: child.stdout, crlfDelay: Infinity });
        outputReaders.push(stdout);
        stdout.on("line", (line) => {
          if (watchdog.isFinalized()) return;
          if (!line.trim()) return;
          watchdog.markActivity();
          void emit({
            kind: "output",
            payload: { source: "hermes", text: line },
          });
        });
      }

      if (child.stderr) {
        const stderr = createInterface({ input: child.stderr, crlfDelay: Infinity });
        outputReaders.push(stderr);
        stderr.on("line", (line) => {
          if (watchdog.isFinalized()) return;
          if (!line.trim()) return;
          watchdog.markActivity();
          void emit({
            kind: "progress",
            payload: { source: "hermes", stream: "stderr", format: "text", text: line },
          });
        });
      }

      child.once("error", (error) => {
        spawnFailed = true;
        if (!watchdog.tryFinalize()) return;
        void emit({
          kind: "error",
          payload: { source: "hermes", message: error.message, code: error.name },
        });
        void emit({ kind: "status", payload: { status: "failed", reason: error.message } });
      });

      child.once("close", (code, signal) => {
        void (async () => {
          if (!(await watchdog.finalizeChildClose())) return;
          if (spawnFailed) return;
          const exitCode = typeof code === "number" ? code : null;
          const checkStatus = exitCode === 0 ? "passed" : "failed";
          await emit({
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
              ],
            },
          });
          await emit({
            kind: "status",
            payload: {
              status: exitCode === 0 ? "succeeded" : "failed",
              exitCode,
              signal,
            },
          });
        })();
      });

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

export async function readTaskOutput(projectRoot: string, nodeId: string): Promise<string> {
  try {
    return await readFile(taskOutputPath(projectRoot, nodeId), "utf8");
  } catch {
    return "";
  }
}

export function deriveEvidenceFromEvents(run: AgentRun, events: RunEvent[]): RunEvidence {
  let status: AgentRunStatus = run.status;
  let exitCode: number | null = null;
  let errorReason: string | null = null;
  let cancelReason: string | null = null;
  let completedAt: string | null = run.endedAt ?? null;
  const checks: RunEvidence["checks"] = [];
  const artifacts: string[] = [];
  let changesetId: string | null = null;
  let review: RunEvidence["review"] = null;

  for (const event of events) {
    if (event.kind === "status" && isRunStatus(event.payload.status)) {
      const nextStatus = event.payload.status;
      if (!isFinalRunStatus(status) || isFinalRunStatus(nextStatus)) {
        status = nextStatus;
        exitCode = typeof event.payload.exitCode === "number" ? event.payload.exitCode : exitCode;
        cancelReason =
          status === "cancelled" && typeof event.payload.reason === "string" ? event.payload.reason : cancelReason;
        completedAt = isFinalRunStatus(status) ? event.timestamp : completedAt;
      }
    }
    if (event.kind === "error") {
      status = "failed";
      errorReason = typeof event.payload.message === "string" ? event.payload.message : "Adapter error";
      completedAt = event.timestamp;
    }
    if (event.kind === "evidence") {
      exitCode = typeof event.payload.exitCode === "number" ? event.payload.exitCode : exitCode;
      changesetId = typeof event.payload.changesetId === "string" ? event.payload.changesetId : changesetId;
      if (Array.isArray(event.payload.checks)) checks.push(...(event.payload.checks as RunEvidence["checks"]));
      if (Array.isArray(event.payload.artifacts)) artifacts.push(...(event.payload.artifacts as string[]));
      if (isEvidenceCheck(event.payload.review)) review = event.payload.review;
    }
  }

  return {
    runId: run.id,
    status,
    exitCode,
    changesetId,
    checks,
    artifacts,
    review,
    errorReason,
    cancelReason,
    completedAt,
  };
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
  const outputEvents = input.events.filter((event) => event.kind === "output" && typeof event.payload.text === "string");
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
      text: event.payload.text,
    }),
  );
  const evidenceSeq = output.length + 2;
  const evidence = makeFlowEvent(input, evidenceSeq, "workflow.evidence.recorded", {
    laneId: input.laneId,
    segmentId: input.segmentId,
    evidence: {
      id: `evidence-${input.segmentId}`,
      kind: "run-exit",
      status: input.evidence.status === "succeeded" && input.evidence.exitCode === 0 ? "passed" : "failed",
      checks: input.evidence.checks.map((check) => check.name),
      artifacts: input.evidence.artifacts,
      detail: input.evidence.errorReason ?? input.evidence.cancelReason ?? undefined,
    },
  });
  const finished = makeFlowEvent(input, evidenceSeq + 1, "workflow.segment.finished", {
    laneId: input.laneId,
    segmentId: input.segmentId,
    status: flowSegmentStatusFromRunEvidence(input.evidence),
    exitCode: input.evidence.exitCode,
    errorReason: input.evidence.errorReason,
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
  if (evidence.status === "succeeded" && evidence.exitCode === 0) return "succeeded";
  return "failed";
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

async function appendRunEvent(projectRoot: string, event: RunEvent): Promise<void> {
  const target = runEventsPath(projectRoot, event.runId);
  await mkdir(join(projectRoot, ".devflow", "runs", event.runId), { recursive: true });
  await appendFile(target, `${JSON.stringify(event)}\n`, "utf8");
}

async function writeTaskOutputFromEvents(projectRoot: string, nodeId: string, runId: string): Promise<void> {
  const events = await loadRunEvents(projectRoot, runId);
  const output = events
    .filter((event) => event.kind === "output")
    .map((event) => (typeof event.payload.text === "string" ? event.payload.text : ""))
    .filter(Boolean)
    .join("\n");
  await mkdir(join(projectRoot, ".devflow", "tasks", nodeId), { recursive: true });
  await writeFile(taskOutputPath(projectRoot, nodeId), `${output}\n`, "utf8");
}

function runEventsPath(projectRoot: string, runId: string): string {
  return join(projectRoot, ".devflow", "runs", runId, "events.ndjson");
}

function taskOutputPath(projectRoot: string, nodeId: string): string {
  return join(projectRoot, ".devflow", "tasks", nodeId, "output.md");
}

function makeRunId(sessionId: string, nodeId: string): string {
  return `run-${sessionId}-${nodeId}`;
}

async function nextAttemptRunId(
  projectRoot: string,
  sessionId: string,
  nodeId: string,
  runs: ReadonlyMap<string, AgentRun>,
): Promise<string> {
  const base = makeRunId(sessionId, nodeId);
  for (let attempt = 1; ; attempt += 1) {
    const candidate = attempt === 1 ? base : `${base}-attempt-${attempt}`;
    if (!runs.has(candidate) && !(await hasRunEvents(projectRoot, candidate))) return candidate;
  }
}

async function hasRunEvents(projectRoot: string, runId: string): Promise<boolean> {
  try {
    await access(runEventsPath(projectRoot, runId), fsConstants.F_OK);
    return true;
  } catch {
    return false;
  }
}

function makePersistedRun(projectRoot: string, runId: string): AgentRun {
  return {
    id: runId,
    nodeId: "unknown",
    sessionId: "unknown",
    projectRoot,
    worktreePath: projectRoot,
    agentKind: "codex",
    status: "failed",
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

function isEvidenceCheck(value: unknown): value is NonNullable<RunEvidence["review"]> {
  if (!value || typeof value !== "object") return false;
  const candidate = value as { name?: unknown; kind?: unknown; status?: unknown };
  return typeof candidate.name === "string" && typeof candidate.kind === "string" && typeof candidate.status === "string";
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

function codexStdoutLineToDrafts(line: string): RunEventDraft[] {
  if (!line.trim()) return [];
  const event = parseJsonObject(line);
  if (!event) {
    return [{ kind: "progress", payload: { source: "codex", stream: "stdout", format: "text", text: line } }];
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
    return [
      {
        kind: "error",
        payload: { source: "codex", eventType, message: getCodexErrorMessage(event) },
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

function formatExitDetail(code: number | null, signal: NodeJS.Signals | null): string {
  if (typeof code === "number") return `exit ${code}`;
  if (signal) return `signal ${signal}`;
  return "process closed";
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}
