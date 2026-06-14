import { spawn, type ChildProcess } from "node:child_process";
import { access, appendFile, mkdir, readFile, realpath, writeFile } from "node:fs/promises";
import { constants as fsConstants } from "node:fs";
import { delimiter, join } from "node:path";
import { createInterface } from "node:readline";

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
const defaultCliTimeoutMs = 5 * 60 * 1_000;
const defaultKillTimeoutMs = 5_000;

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
  killTimeoutMs?: number;
  env?: NodeJS.ProcessEnv;
  extraArgs?: string[];
  pathValue?: string;
}

export interface HermesCliAdapterOptions {
  executablePath?: string;
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
    const run: AgentRun = {
      id: input.runId ?? makeRunId(input.sessionId, input.nodeId),
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
    await this.handles.get(runId)?.cancel(reason);
    await this.recordEvent(runId, {
      kind: "status",
      payload: { status: "cancelled", reason },
    });
    const events = await loadRunEvents(run.projectRoot, runId);
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
    for (const listener of this.listeners) listener(event);
    return event;
  }

  private updateRunFromEvent(run: AgentRun, event: RunEvent): void {
    if (event.kind !== "status") return;
    const status = event.payload.status;
    if (!isRunStatus(status)) return;
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
      }
      return {
        async cancel() {},
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
      let cancelled = false;
      let cancelReason = "";
      let spawnFailed = false;
      let finalized = false;
      const { emit, drain } = createQueuedRunEventEmitter(sink);
      let killTimer: NodeJS.Timeout | null = null;
      const timeoutMs = options.timeoutMs ?? defaultCliTimeoutMs;
      const killTimeoutMs = options.killTimeoutMs ?? defaultKillTimeoutMs;
      let timeoutTimer: NodeJS.Timeout | null = null;

      await emit({
        kind: "progress",
        payload: { source: "codex", phase: "started", command: "codex exec" },
      });

      if (child.stdout) {
        const stdout = createInterface({ input: child.stdout, crlfDelay: Infinity });
        stdout.on("line", (line) => {
          for (const draft of codexStdoutLineToDrafts(line)) void emit(draft);
        });
      }

      if (child.stderr) {
        const stderr = createInterface({ input: child.stderr, crlfDelay: Infinity });
        stderr.on("line", (line) => {
          if (!line.trim()) return;
          void emit({
            kind: "progress",
            payload: { source: "codex", stream: "stderr", format: "text", text: line },
          });
        });
      }

      child.once("error", (error) => {
        spawnFailed = true;
        if (finalized) return;
        finalized = true;
        if (timeoutTimer) clearTimeout(timeoutTimer);
        if (killTimer) clearTimeout(killTimer);
        void emit({
          kind: "error",
          payload: { source: "codex", message: error.message, code: error.name },
        });
        void emit({ kind: "status", payload: { status: "failed", reason: error.message } });
      });

      child.once("close", (code, signal) => {
        void (async () => {
          await drain();
          if (killTimer) clearTimeout(killTimer);
          if (timeoutTimer) clearTimeout(timeoutTimer);
          if (finalized) return;
          finalized = true;
          if (spawnFailed) return;
          if (cancelled) {
            await emit({
              kind: "evidence",
              payload: {
                exitCode: typeof code === "number" ? code : null,
                checks: [
                  {
                    kind: "run-exit",
                    name: "Codex CLI exit",
                    status: "skipped",
                    detail: cancelReason || formatExitDetail(code, signal),
                  },
                ],
              },
            });
            return;
          }
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

      if (timeoutMs > 0) {
        timeoutTimer = setTimeout(() => {
          void (async () => {
            if (finalized) return;
            finalized = true;
            await drain();
            await emit({
              kind: "evidence",
              payload: {
                exitCode: null,
                checks: [
                  {
                    kind: "run-timeout",
                    name: "Codex CLI timeout",
                    status: "failed",
                    detail: `timed out after ${timeoutMs}ms`,
                  },
                ],
              },
            });
            await emit({
              kind: "status",
              payload: { status: "timed-out", reason: `Codex CLI timed out after ${timeoutMs}ms` },
            });
            terminateProcessTree(child, "SIGTERM");
            killTimer = setTimeout(() => {
              terminateProcessTree(child, "SIGKILL");
            }, killTimeoutMs);
          })();
        }, timeoutMs);
        timeoutTimer.unref();
      }

      return {
        async cancel(reason) {
          cancelled = true;
          cancelReason = reason;
          if (timeoutTimer) clearTimeout(timeoutTimer);
          terminateProcessTree(child, "SIGTERM");
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
      const workdir = await realpath(input.projectRoot);
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
      let cancelled = false;
      let cancelReason = "";
      let spawnFailed = false;
      const { emit, drain } = createQueuedRunEventEmitter(sink);

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

      if (child.stdout) {
        const stdout = createInterface({ input: child.stdout, crlfDelay: Infinity });
        stdout.on("line", (line) => {
          if (!line.trim()) return;
          void emit({
            kind: "output",
            payload: { source: "hermes", text: line },
          });
        });
      }

      if (child.stderr) {
        const stderr = createInterface({ input: child.stderr, crlfDelay: Infinity });
        stderr.on("line", (line) => {
          if (!line.trim()) return;
          void emit({
            kind: "progress",
            payload: { source: "hermes", stream: "stderr", format: "text", text: line },
          });
        });
      }

      child.once("error", (error) => {
        spawnFailed = true;
        void emit({
          kind: "error",
          payload: { source: "hermes", message: error.message, code: error.name },
        });
        void emit({ kind: "status", payload: { status: "failed", reason: error.message } });
      });

      child.once("close", (code, signal) => {
        void (async () => {
          await drain();
          if (spawnFailed) return;
          const exitCode = typeof code === "number" ? code : null;
          if (cancelled) {
            await emit({
              kind: "evidence",
              payload: {
                exitCode,
                checks: [
                  {
                    kind: "run-exit",
                    name: "Hermes CLI exit",
                    status: "skipped",
                    detail: cancelReason || formatExitDetail(code, signal),
                  },
                ],
              },
            });
            await emit({ kind: "status", payload: { status: "cancelled", reason: cancelReason } });
            return;
          }
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
          cancelled = true;
          cancelReason = reason;
          terminateProcessTree(child, "SIGTERM");
        },
      };
    },
  };
}

function terminateProcessTree(child: ChildProcess, signal: NodeJS.Signals): void {
  if (child.exitCode !== null || child.signalCode !== null) return;
  const pid = child.pid;
  if (!pid) return;
  if (process.platform === "win32") {
    child.kill(signal);
    return;
  }
  try {
    process.kill(-pid, signal);
  } catch {
    child.kill(signal);
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
      status = event.payload.status;
      exitCode = typeof event.payload.exitCode === "number" ? event.payload.exitCode : exitCode;
      cancelReason = typeof event.payload.reason === "string" ? event.payload.reason : cancelReason;
      completedAt = isFinalRunStatus(status) ? event.timestamp : completedAt;
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
    return [{ kind: "progress", payload: { source: "codex", eventType, usage: event.usage ?? null } }];
  }
  if (eventType === "item.completed") {
    const text = getCodexAgentMessage(event);
    if (text) return [{ kind: "output", payload: { source: "codex", text } }];
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
  return [{ kind: "progress", payload: { source: "codex", eventType } }];
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
