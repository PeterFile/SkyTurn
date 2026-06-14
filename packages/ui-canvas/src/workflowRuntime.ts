import {
  applyWorkflowCardToolCalls,
  buildHermesWorkflowPrompt,
  parseHermesWorkflowToolCalls,
} from "@skyturn/orchestrator";
import type { WorkspaceState } from "@skyturn/persistence";
import {
  RUN_EVENT_PROTOCOL_VERSION,
  deriveNodeStatusFromEvidence,
  makeHermesPlannerSessionId,
  type AgentRun,
  type AgentRunStatus,
  type CanvasNode,
  type CanvasSession,
  type ImportedProject,
  type NodeRuntimeState,
  type RunEvent,
  type RunEvidence,
} from "@skyturn/project-core";

export interface BridgeRunResult {
  run: AgentRun;
  events: RunEvent[];
  evidence: RunEvidence;
}

export async function startBridgeRun(
  project: ImportedProject,
  session: CanvasSession,
  node: CanvasNode,
): Promise<BridgeRunResult | null> {
  const result = await window.devflow?.startAgentRun({
    protocolVersion: RUN_EVENT_PROTOCOL_VERSION,
    runId: node.runId,
    nodeId: node.id,
    sessionId: session.id,
    ...(node.agent === "hermes"
      ? {
          plannerSessionId: session.hermesPlannerSessionId || makeHermesPlannerSessionId(session.id),
          plannerInputId: node.runId,
        }
      : {}),
    projectRoot: project.rootPath,
    worktreePath: resolveRunWorktreePath(project, node),
    agentKind: node.agent,
    prompt: promptForNodeRun(session, node),
  });
  if (!result || !window.devflow) return null;
  const [eventsResult, evidenceResult] = await Promise.all([
    window.devflow.getRunEvents(project.rootPath, node.runId),
    window.devflow.getRunEvidence(project.rootPath, node.runId),
  ]);
  return { run: result.run, events: eventsResult.events, evidence: evidenceResult.evidence };
}

export function applyBridgeRunResult(workspace: WorkspaceState, result: BridgeRunResult): WorkspaceState {
  const withEvents = mergeRunEventsIntoWorkspace(workspace, result.run.id, result.events);
  return {
    ...withEvents,
    runs: { ...withEvents.runs, [result.run.id]: result.run },
    runEvidence: { ...withEvents.runEvidence, [result.run.id]: result.evidence },
  };
}

export function applyRunEventToWorkspace(workspace: WorkspaceState, event: RunEvent): WorkspaceState {
  return mergeRunEventsIntoWorkspace(workspace, event.runId, [...(workspace.runEvents[event.runId] ?? []), event]);
}

export function mergeRunEventsIntoWorkspace(
  workspace: WorkspaceState,
  runId: string,
  events: RunEvent[],
): WorkspaceState {
  const deduped = dedupeRunEvents(events);
  const evidence = evidenceFromRunEvents(runId, deduped);
  const sessions = workspace.sessions.map((session) => {
    if (session.kind !== "canvas") return session;
    const target = session.nodes.find((node) => node.runId === runId);
    if (!target) return session;

    const updatedSession = {
      ...session,
      nodes: session.nodes.map((node) => (node.runId === runId ? applyRunEventsToNode(node, session, deduped) : node)),
    };
    return target.agent === "hermes" ? applyHermesWorkflowOutput(updatedSession, target, deduped) : updatedSession;
  });

  return {
    ...workspace,
    sessions,
    runEvents: { ...workspace.runEvents, [runId]: deduped },
    runEvidence: evidence ? { ...workspace.runEvidence, [runId]: evidence } : workspace.runEvidence,
  };
}

function applyRunEventsToNode(node: CanvasNode, session: CanvasSession, events: RunEvent[]): CanvasNode {
  const output = outputFromEvents(events);
  const evidence = evidenceFromRunEvents(node.runId, events);
  const run = runFromEvents(node, session, events);
  const status = run ? deriveNodeStatusFromEvidence(run, evidence) : node.status;
  return {
    ...node,
    status,
    runtime: runtimeForStatus(status, node.progress),
    output: output.length > 0 ? output : node.output,
    progress: progressFromEvents(status, events, node.progress),
  };
}

function applyHermesWorkflowOutput(
  session: CanvasSession,
  hermesNode: CanvasNode,
  events: RunEvent[],
): CanvasSession {
  const text = outputFromEvents(events).join("\n");
  const calls = parseHermesWorkflowToolCalls(text);
  if (calls.length === 0) return session;
  const sourceNode = session.nodes.find((node) => node.runId === hermesNode.runId);
  const applied = applyWorkflowCardToolCalls(session, calls, {
    sourceRunId: hermesNode.runId,
    now: latestEventTimestamp(events) ?? new Date().toISOString(),
  }).session;
  if (!sourceNode) return applied;
  return {
    ...applied,
    nodes: applied.nodes.map((node) =>
      node.runId === sourceNode.runId
        ? {
            ...node,
            status: sourceNode.status,
            runtime: sourceNode.runtime,
            progress: sourceNode.progress,
            output: sourceNode.output,
          }
        : node,
    ),
  };
}

export function buildPromptForNodeRun(session: CanvasSession, node: CanvasNode): string {
  if (node.agent === "hermes") {
    return buildHermesWorkflowPrompt({
      goal: hermesGoalForNode(session, node),
      sessionId: session.id,
      plannerSessionId: session.hermesPlannerSessionId || makeHermesPlannerSessionId(session.id),
      nodeId: node.id,
      existingNodes: session.nodes.map((item) => ({
        id: item.id,
        title: item.title,
        agent: item.agent,
        status: item.status,
        taskKey: item.workflowTrace?.taskKey,
        dependencies: item.context.dependencies,
      })),
    });
  }

  return [
    `Task: ${node.context.brief}`,
    `Session goal: ${session.goal}`,
    `Node: ${node.id}`,
    `Worktree reference: ${node.worktree.path}`,
    "Return a concise result summary and any blocker or verification evidence. Do not claim completion without evidence.",
  ].join("\n");
}

function promptForNodeRun(session: CanvasSession, node: CanvasNode): string {
  return buildPromptForNodeRun(session, node);
}

function hermesGoalForNode(session: CanvasSession, node: CanvasNode): string {
  const brief = node.context.brief.trim();
  if (!brief || brief === "Decompose the user goal into workflow-card tool calls.") return session.goal;
  if (brief === session.goal.trim()) return session.goal;
  return `${session.goal}\nCurrent requirement: ${brief}`;
}

function resolveRunWorktreePath(project: ImportedProject, node: CanvasNode): string {
  if (node.agent === "hermes") return project.rootPath;
  return isAbsoluteLocalPath(node.worktree.path) ? node.worktree.path : project.rootPath;
}

function isAbsoluteLocalPath(value: string): boolean {
  return value.startsWith("/") || /^[A-Za-z]:[\\/]/.test(value);
}

function evidenceFromRunEvents(runId: string, events: RunEvent[]): RunEvidence | null {
  if (events.length === 0) return null;
  let status: AgentRunStatus = "running";
  let exitCode: number | null = null;
  let errorReason: string | null = null;
  let cancelReason: string | null = null;
  let completedAt: string | null = null;
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
    runId,
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

function runFromEvents(node: CanvasNode, session: CanvasSession, events: RunEvent[]): AgentRun | null {
  const evidence = evidenceFromRunEvents(node.runId, events);
  if (!evidence) return null;
  return {
    id: node.runId,
    nodeId: node.id,
    sessionId: session.id,
    projectRoot: session.projectId,
    worktreePath: node.worktree.path,
    agentKind: node.agent,
    status: evidence.status,
    startedAt: session.createdAt,
    endedAt: evidence.completedAt ?? undefined,
  };
}

function progressFromEvents(status: CanvasNode["status"], events: RunEvent[], fallback: string): string {
  if (status === "completed") return "Evidence ready";
  if (status === "failed") return errorMessageFromEvents(events) ?? "Run evidence incomplete";
  if (status === "running") return "Streaming persisted output";
  return fallback;
}

function errorMessageFromEvents(events: RunEvent[]): string | null {
  for (let index = events.length - 1; index >= 0; index -= 1) {
    const event = events[index];
    if (event?.kind !== "error") continue;
    return typeof event.payload.message === "string" ? event.payload.message : null;
  }
  return null;
}

function outputFromEvents(events: RunEvent[]): string[] {
  return events
    .filter((event) => event.kind === "output")
    .map((event) => (typeof event.payload.text === "string" ? event.payload.text : ""))
    .filter(Boolean);
}

function dedupeRunEvents(events: RunEvent[]): RunEvent[] {
  return [...new Map(events.map((event) => [event.seq, event])).values()].sort((left, right) => left.seq - right.seq);
}

function latestEventTimestamp(events: RunEvent[]): string | null {
  return events.at(-1)?.timestamp ?? null;
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

function runtimeForStatus(status: CanvasNode["status"], action: string): NodeRuntimeState {
  switch (status) {
    case "pending":
      return { phase: "Queued", message: "正在等待调度", action };
    case "running":
      return { phase: "Executing", message: "正在执行任务", action };
    case "retrying":
      return { phase: "Retrying", message: "正在重新尝试", action };
    case "completed":
      return { phase: "Completed", message: "已完成验证", action };
    case "failed":
      return { phase: "Failed", message: "等待人工处理", action };
  }
}
