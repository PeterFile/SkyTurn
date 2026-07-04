import {
  applyWorkflowCardToolCalls,
  buildHermesWorkflowPrompt,
  parseHermesWorkflowIntent,
  parseHermesWorkflowToolCalls,
} from "@skyturn/orchestrator";
import type { WorkspaceState } from "@skyturn/persistence";
import {
  RUN_EVENT_PROTOCOL_VERSION,
  deriveNodeStatusFromEvidence,
  hasConcreteRunEvidence,
  makeHermesPlannerSessionId,
  type AgentRun,
  type AgentRunSandbox,
  type AgentRunStatus,
  type CanvasNode,
  type CanvasSession,
  type ImportedProject,
  type NodeRuntimeState,
  type RunEvent,
  type RunEvidence,
  type StartAgentRunInput,
  type UserDecisionProjection,
  type WorkflowLedgerSummary,
  type WorkflowWorktreeIdentity,
} from "@skyturn/project-core";
import {
  compileWorkflowIntent,
  createDefaultFlowPolicy,
  reduceWorkflowEvents,
  scheduleReadyLanes,
  type FlowEvent,
  type FlowLane,
  type FlowProjection,
} from "@skyturn/workflow-kernel";

import { safeCompactPhrase } from "./safeNodePhrase.js";
import { workflowLanePosition } from "./canvasLayout.js";

export interface BridgeRunResult {
  run: AgentRun;
  events: RunEvent[];
  evidence: RunEvidence;
  workflowSession?: CanvasSession | null;
}

export interface CompletedBridgeRunPersistenceResult {
  events: RunEvent[];
  evidence: RunEvidence;
  workflowSession?: CanvasSession | null;
}

export interface CompletedBridgeRunPersistenceClaim {
  project: ImportedProject;
  session: CanvasSession;
  node: CanvasNode;
  runId: string;
}

export interface WorkflowSchedulingPolicy {
  allowedParallelism: number;
  runningScopes: Array<{ fileScopes: string[]; packageScopes: string[] }>;
}

const SERIAL_WORKFLOW_PARALLELISM = 1;
const MAX_WORKFLOW_PARALLELISM = 4;
const CURRENT_BRANCH_WORKTREE_KEY = "current_branch";
const BROWSER_SCREENSHOT_ARTIFACT = ".devflow/acceptance/react-app.png";

export async function startBridgeRun(
  project: ImportedProject,
  session: CanvasSession,
  node: CanvasNode,
): Promise<BridgeRunResult | null> {
  if (!canStartNodeRun(node)) return null;
  const sandbox = sandboxForNodeRun(node);
  const ledger = node.agent === "hermes" ? await loadWorkflowLedger(project, session.id) : undefined;
  const worktreePath = await ensureRunWorktreePath(project, session, node);
  if (!worktreePath) return null;
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
    worktreePath,
    agentKind: node.agent,
    ...(sandbox ? { sandbox } : {}),
    ...expectedArtifactsInputForNode(node),
    prompt: promptForNodeRun(session, node, ledger),
  });
  if (!result || !window.devflow) return null;
  const [eventsResult, evidenceResult] = await Promise.all([
    window.devflow.getRunEvents(project.rootPath, node.runId),
    window.devflow.getRunEvidence(project.rootPath, node.runId),
  ]);
  const workflowSession = await persistWorkflowRunResult(project, session, node, eventsResult.events, evidenceResult.evidence);
  return { run: result.run, events: eventsResult.events, evidence: evidenceResult.evidence, workflowSession };
}

export async function persistCompletedBridgeRunResult(
  project: ImportedProject,
  session: CanvasSession,
  node: CanvasNode,
): Promise<CompletedBridgeRunPersistenceResult | null> {
  if (!canStartNodeRun(node) || !window.devflow) return null;
  const [eventsResult, evidenceResult] = await Promise.all([
    window.devflow.getRunEvents(project.rootPath, node.runId),
    window.devflow.getRunEvidence(project.rootPath, node.runId),
  ]);
  if (!hasTerminalRunEvidence(evidenceResult.evidence)) return null;
  const workflowSession = await persistWorkflowRunResult(
    project,
    session,
    node,
    eventsResult.events,
    evidenceResult.evidence,
  );
  return { events: eventsResult.events, evidence: evidenceResult.evidence, workflowSession };
}

export function claimCompletedBridgeRunPersistence(
  workspace: WorkspaceState,
  event: RunEvent,
  claims: Set<string>,
): CompletedBridgeRunPersistenceClaim | null {
  if (!isTerminalRunPersistenceEvent(event) || claims.has(event.runId)) return null;
  for (const session of workspace.sessions) {
    if (session.kind !== "canvas") continue;
    const node = session.nodes.find((candidate) => candidate.runId === event.runId);
    if (!node || !canStartNodeRun(node)) continue;
    if (node.status !== "running" && node.status !== "retrying") continue;
    const project = workspace.projects.find((candidate) => candidate.id === session.projectId);
    if (!project) continue;
    claims.add(event.runId);
    return { project, session, node, runId: event.runId };
  }
  return null;
}

export function applyCompletedBridgeRunPersistenceResult(
  workspace: WorkspaceState,
  runId: string,
  result: CompletedBridgeRunPersistenceResult,
): WorkspaceState {
  const withEvents = mergeRunEventsIntoWorkspace(workspace, runId, result.events);
  return {
    ...withEvents,
    sessions: result.workflowSession
      ? withEvents.sessions.map((session) =>
          session.id === result.workflowSession?.id ? result.workflowSession : session,
        )
      : withEvents.sessions,
    runEvidence: { ...withEvents.runEvidence, [runId]: result.evidence },
  };
}

export function applyBridgeRunResult(workspace: WorkspaceState, result: BridgeRunResult): WorkspaceState {
  const withEvents = mergeRunEventsIntoWorkspace(workspace, result.run.id, result.events);
  if (result.workflowSession) {
    return {
      ...withEvents,
      sessions: withEvents.sessions.map((session) =>
        session.id === result.workflowSession?.id ? result.workflowSession : session,
      ),
      runs: { ...withEvents.runs, [result.run.id]: result.run },
      runEvidence: { ...withEvents.runEvidence, [result.run.id]: result.evidence },
    };
  }
  return {
    ...withEvents,
    runs: { ...withEvents.runs, [result.run.id]: result.run },
    runEvidence: { ...withEvents.runEvidence, [result.run.id]: result.evidence },
  };
}

async function loadWorkflowLedger(
  project: ImportedProject,
  sessionId: string,
): Promise<WorkflowLedgerSummary | undefined> {
  if (!window.devflow || typeof window.devflow.getWorkflowLedger !== "function") return undefined;
  const result = await window.devflow.getWorkflowLedger(project.rootPath, sessionId);
  return isWorkflowLedgerSummary(result.ledger) ? result.ledger : undefined;
}

async function persistWorkflowRunResult(
  project: ImportedProject,
  session: CanvasSession,
  node: CanvasNode,
  events: RunEvent[],
  evidence: RunEvidence,
): Promise<CanvasSession | null> {
  if (!window.devflow) return null;
  if (!hasTerminalRunEvidence(evidence)) return null;
  const now = evidence.completedAt ?? latestEventTimestamp(events) ?? new Date().toISOString();
  if (isPlannerRootNode(session, node)) {
    if (evidence.status !== "succeeded") return null;
    if (
      typeof window.devflow.applyWorkflowIntent !== "function" ||
      typeof window.devflow.recordWorkflowRunResult !== "function" ||
      typeof window.devflow.scheduleWorkflowReadyLanes !== "function"
    ) {
      return null;
    }
    const intent = parseHermesWorkflowIntent(outputFromEvents(events).join("\n"));
    if (!intent.ok) return null;
    if (intent.intent.sessionId !== session.id) return null;
    const recorded = await window.devflow.recordWorkflowRunResult(project.rootPath, {
      sessionId: session.id,
      laneId: node.id,
      segmentId: segmentIdForNode(session.id, node.id),
      runId: node.runId,
      agentKind: node.agent,
      now,
    });
    const applied = await window.devflow.applyWorkflowIntent(project.rootPath, intent.intent);
    const schedulingPolicy = workflowSchedulingPolicyForSession(applied.canvasSession ?? recorded.canvasSession ?? session);
    const scheduled = await window.devflow.scheduleWorkflowReadyLanes(project.rootPath, session.id, {
      allowedParallelism: schedulingPolicy.allowedParallelism,
      now,
    });
    return scheduled.canvasSession ?? applied.canvasSession ?? recorded.canvasSession ?? null;
  }

  if (!node.display?.meta.includes("flow-kernel") || node.executable === false) return null;
  if (
    typeof window.devflow.recordWorkflowRunResult !== "function" ||
    typeof window.devflow.scheduleWorkflowReadyLanes !== "function"
  ) {
    return null;
  }
  const recorded = await window.devflow.recordWorkflowRunResult(project.rootPath, {
    sessionId: session.id,
    laneId: node.id,
    segmentId: segmentIdForNode(session.id, node.id),
    runId: node.runId,
    agentKind: node.agent,
    now,
  });
  const schedulingSession = applyTerminalEvidenceToSessionNode(recorded.canvasSession ?? session, node.id, evidence);
  const schedulingPolicy = workflowSchedulingPolicyForSession(schedulingSession);
  const scheduled = await window.devflow.scheduleWorkflowReadyLanes(project.rootPath, session.id, {
    allowedParallelism: schedulingPolicy.allowedParallelism,
    now,
  });
  return scheduled.canvasSession ?? recorded.canvasSession ?? null;
}

function applyTerminalEvidenceToSessionNode(
  session: CanvasSession,
  nodeId: string,
  evidence: RunEvidence,
): CanvasSession {
  if (!isFinalRunStatus(evidence.status)) return session;
  const status: CanvasNode["status"] = evidence.status === "succeeded" ? "completed" : "failed";
  return {
    ...session,
    nodes: session.nodes.map((node) => (node.id === nodeId ? { ...node, status } : node)),
  };
}

function isPlannerRootNode(session: CanvasSession, node: CanvasNode): boolean {
  return node.agent === "hermes" && node.id === session.plannerNodeId;
}

function shouldUseRendererWorkflowProjection(): boolean {
  return typeof window === "undefined" || !window.devflow;
}

export function retryCanvasNode(session: CanvasSession, nodeId: string, now: string): CanvasSession {
  const target = session.nodes.find((node) => node.id === nodeId);
  if (!target) return session;
  const runId = uniqueRetryRunId(session.nodes, target.runId, now);
  return {
    ...session,
    activeNodeId: nodeId,
    updatedAt: now,
    nodes: session.nodes.map((node) =>
      node.id === nodeId
        ? {
            ...node,
            status: "retrying",
            runId,
            changesetId: `changeset-${runId}`,
            progress: "Retrying",
            runtime: runtimeForStatus("retrying", node.display?.meta[0] ?? node.progress),
            output: [...node.output, `Retry requested from ${node.runId}.`],
          }
        : node,
    ),
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
    if (!shouldUseRendererWorkflowProjection()) return updatedSession;
    const projected = isPlannerRootNode(updatedSession, target)
      ? applyHermesWorkflowOutput(updatedSession, target, deduped)
      : updatedSession;
    return scheduleFlowKernelLanes(projected);
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
  const progress = progressFromEvents(status, events, node.progress);
  return {
    ...node,
    status,
    runtime: runtimeForStatus(status, progress),
    output: output.length > 0 ? output : node.output,
    progress,
  };
}

function applyHermesWorkflowOutput(
  session: CanvasSession,
  hermesNode: CanvasNode,
  events: RunEvent[],
): CanvasSession {
  let projected = session;
  let appliedIntent = false;
  for (const event of outputEvents(events)) {
    const intent = parseHermesWorkflowIntent(event.text);
    if (!intent.ok) continue;
    projected = applyWorkflowIntentProjection(projected, hermesNode, intent.intent, event.timestamp);
    appliedIntent = true;
  }
  if (appliedIntent) return projected;

  const text = outputFromEvents(events).join("\n");
  const intent = parseHermesWorkflowIntent(text);
  if (intent.ok) {
    return applyWorkflowIntentProjection(
      session,
      hermesNode,
      intent.intent,
      latestEventTimestamp(events) ?? new Date().toISOString(),
    );
  }

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

function applyWorkflowIntentProjection(
  session: CanvasSession,
  hermesNode: CanvasNode,
  intent: Parameters<typeof compileWorkflowIntent>[0],
  now: string,
): CanvasSession {
  const baseProjection = flowProjectionFromSession(session);
  const compiled = compileWorkflowIntent(intent, baseProjection, createDefaultFlowPolicy(), now);
  const projection = reduceWorkflowEvents([...baseProjection.events, ...compiled.events]);
  const planner = session.nodes.find((node) => node.id === session.plannerNodeId) ?? hermesNode;
  const dependenciesByLaneId = dependenciesFromFlowEdges(projection);
  const existingById = new Map(session.nodes.map((node) => [node.id, node]));
  const flowLaneNodes = projection.lanes.map((lane, index) =>
    flowLaneToCanvasNode(session, lane, index, dependenciesByLaneId.get(lane.id) ?? [], existingById.get(lane.id)),
  );
  const decisionNodes = projection.userDecisions.map((decision, index) =>
    userDecisionToCanvasNode(session, decision, projection.lanes.length + index, existingById.get(decision.decisionId)),
  );
  const flowNodes = [...flowLaneNodes, ...decisionNodes];
  const activeProjectedNode = flowNodes.find((node) => node.status === "running" || node.status === "retrying");
  const currentActiveNode = flowNodes.find((node) => node.id === session.activeNodeId) ?? planner;
  return {
    ...session,
    nodes: [planner, ...flowNodes],
    edges: projection.edges.map((edge) => ({
      id: edge.id,
      source: edge.sourceLaneId,
      target: edge.targetLaneId,
    })),
    activeNodeId: activeProjectedNode?.id ?? currentActiveNode.id,
    updatedAt: now,
  };
}

function scheduleFlowKernelLanes(session: CanvasSession): CanvasSession {
  if (!session.nodes.some((node) => node.display?.meta.includes("flow-kernel"))) return session;
  const planner = session.nodes.find((node) => node.id === session.plannerNodeId);
  if (planner && planner.status !== "completed") return session;

  const projection = flowProjectionFromSession(session);
  const schedulingPolicy = workflowSchedulingPolicyForSession(session);
  const ready = scheduleReadyLanes(projection, schedulingPolicy);
  if (ready.length === 0) return session;

  const readyIds = new Set(ready.map((lane) => lane.id));
  const firstReady = ready[0]?.id ?? session.activeNodeId;
  return {
    ...session,
    activeNodeId: firstReady,
    updatedAt: new Date().toISOString(),
    nodes: session.nodes.map((node) => {
      if (!readyIds.has(node.id)) return node;
      const action = node.display?.meta[0] ?? node.progress;
      return {
        ...node,
        status: "running",
        progress: "Scheduled by Flow Kernel",
        runtime: runtimeForStatus("running", action),
      };
    }),
  };
}

export function workflowSchedulingPolicyForSession(session: CanvasSession): WorkflowSchedulingPolicy {
  const projection = flowProjectionFromSession(session);
  const nodesById = new Map(session.nodes.map((node) => [node.id, node]));
  const entries = projection.lanes.map((lane) => ({ lane, node: nodesById.get(lane.id) }));
  const running = entries.filter(isSchedulingRunningLane);
  const candidates = entries.filter(isSchedulingCandidateLane);
  const runningScopes = running.map(({ lane }) => ({ fileScopes: lane.fileScopes, packageScopes: lane.packageScopes }));
  const remainingSlots = Math.max(0, MAX_WORKFLOW_PARALLELISM - running.length);

  if (remainingSlots === 0 || hasUnsafeSharedRunningWrite(session, running)) {
    return { allowedParallelism: 0, runningScopes };
  }
  if (candidates.length === 0) {
    return { allowedParallelism: SERIAL_WORKFLOW_PARALLELISM, runningScopes };
  }

  const sharedWriteCandidates = candidates.filter((entry) =>
    laneHasWriteRisk(entry) && !isKnownManagedWorktreeKey(schedulingWorktreeKey(session, entry.node)),
  );
  if (sharedWriteCandidates.length > 0) {
    return { allowedParallelism: running.length > 0 ? 0 : SERIAL_WORKFLOW_PARALLELISM, runningScopes };
  }

  const runningWorktreeKeys = new Set(
    running
      .map((entry) => schedulingWorktreeKey(session, entry.node))
      .filter((key): key is string => Boolean(key)),
  );
  const candidateWriteKeys: string[] = [];
  for (const entry of candidates) {
    if (!laneHasWriteRisk(entry)) continue;
    const key = schedulingWorktreeKey(session, entry.node);
    if (!isKnownManagedWorktreeKey(key)) {
      return { allowedParallelism: SERIAL_WORKFLOW_PARALLELISM, runningScopes };
    }
    if (runningWorktreeKeys.has(key)) {
      return { allowedParallelism: 0, runningScopes };
    }
    candidateWriteKeys.push(key);
  }

  if (new Set(candidateWriteKeys).size !== candidateWriteKeys.length) {
    return { allowedParallelism: SERIAL_WORKFLOW_PARALLELISM, runningScopes };
  }

  return {
    allowedParallelism: Math.min(MAX_WORKFLOW_PARALLELISM, remainingSlots, candidates.length),
    runningScopes,
  };
}

function isSchedulingRunningLane(entry: { lane: FlowLane; node?: CanvasNode }): boolean {
  return entry.lane.status === "running" || entry.node?.status === "running" || entry.node?.status === "retrying";
}

function isSchedulingCandidateLane(entry: { lane: FlowLane; node?: CanvasNode }): boolean {
  if (!entry.lane.executable || entry.node?.nodeKind === "user_decision") return false;
  if (entry.node && entry.node.status !== "pending") return false;
  return entry.lane.status === "pending" || entry.lane.status === "ready";
}

function hasUnsafeSharedRunningWrite(
  session: CanvasSession,
  entries: Array<{ lane: FlowLane; node?: CanvasNode }>,
): boolean {
  return entries.some((entry) =>
    laneHasWriteRisk(entry) && !isKnownManagedWorktreeKey(schedulingWorktreeKey(session, entry.node)),
  );
}

function laneHasWriteRisk(entry: { lane: FlowLane; node?: CanvasNode }): boolean {
  const policy = entry.node?.runtimePolicy;
  if (!policy || policy.source !== "workflow_projection" || !policy.trusted || !policy.executable) return true;
  if (policy.sandbox !== "read-only") return true;
  return policy.sideEffects.some((effect) => effect === "filesystem" || effect === "git");
}

function schedulingWorktreeKey(session: CanvasSession, node?: CanvasNode): string | null {
  const executionTarget = node?.worktree.executionTarget ?? session.target.executionTarget;
  if (executionTarget === "current_branch") return CURRENT_BRANCH_WORKTREE_KEY;
  if (executionTarget !== "new_worktree") return null;
  const worktree = node?.worktree;
  if (!worktree?.worktreeId || !worktree.realPath || !worktree.gitdir) return null;
  if (!isAbsoluteLocalPath(worktree.realPath)) return null;
  return `worktree:${worktree.realPath.replace(/[/\\]+$/, "")}`;
}

function isKnownManagedWorktreeKey(key: string | null): key is string {
  return Boolean(key && key !== CURRENT_BRANCH_WORKTREE_KEY);
}

function dependenciesFromFlowEdges(projection: FlowProjection): Map<string, string[]> {
  const dependencies = new Map<string, string[]>();
  for (const edge of projection.edges) {
    dependencies.set(edge.targetLaneId, [...(dependencies.get(edge.targetLaneId) ?? []), edge.sourceLaneId]);
  }
  return dependencies;
}

function flowProjectionFromSession(session: CanvasSession): FlowProjection {
  const events: FlowEvent[] = [
    {
      id: `${session.id}:flow-event:00000001`,
      sessionId: session.id,
      seq: 1,
      kind: "workflow.user_input",
      source: "ui-canvas",
      payload: { text: session.goal },
      createdAt: session.createdAt,
      idempotencyKey: `session:${session.id}:user-input`,
    },
  ];
  for (const node of session.nodes) {
    if (!node.display?.meta.includes("flow-kernel")) continue;
    if (node.nodeKind === "user_decision" && node.userDecision) {
      events.push({
        id: `${session.id}:flow-event:${String(events.length + 1).padStart(8, "0")}`,
        sessionId: session.id,
        seq: events.length + 1,
        kind: "workflow.user_decision.requested",
        source: "ui-canvas",
        payload: userDecisionRequestedPayload(node.userDecision),
        createdAt: session.updatedAt,
        idempotencyKey: `session:${session.id}:decision:${node.userDecision.decisionId}:requested`,
      });
      const answeredPayload = userDecisionAnsweredPayload(node.userDecision);
      if (answeredPayload) {
        events.push({
          id: `${session.id}:flow-event:${String(events.length + 1).padStart(8, "0")}`,
          sessionId: session.id,
          seq: events.length + 1,
          kind: "workflow.user_decision.answered",
          source: "ui-canvas",
          payload: answeredPayload,
          createdAt: session.updatedAt,
          idempotencyKey: `session:${session.id}:decision:${node.userDecision.decisionId}:answered`,
        });
      }
      continue;
    }
    events.push({
      id: `${session.id}:flow-event:${String(events.length + 1).padStart(8, "0")}`,
      sessionId: session.id,
      seq: events.length + 1,
      kind: "workflow.lane.declared",
      source: "ui-canvas",
      payload: {
        lane: {
          id: node.id,
          semanticKey: node.workflowTrace?.semanticKey ?? node.id,
          kind: node.display.meta[0] ?? "implementation",
          title: node.title,
          agentKind: node.agent,
          laneKind: node.laneKind,
          semanticSubtype: node.semanticSubtype,
          executable: node.executable,
          runtimePolicy: node.runtimePolicy,
          status: node.status,
          fileScopes: [],
          packageScopes: [],
          requiredEvidence: [],
          output: node.output,
        },
      },
      createdAt: session.updatedAt,
      idempotencyKey: `session:${session.id}:lane:${node.id}`,
    });
  }
  for (const edge of session.edges) {
    events.push({
      id: `${session.id}:flow-event:${String(events.length + 1).padStart(8, "0")}`,
      sessionId: session.id,
      seq: events.length + 1,
      kind: "workflow.edge.declared",
      source: "ui-canvas",
      payload: { edge: { id: edge.id, sourceLaneId: edge.source, targetLaneId: edge.target } },
      createdAt: session.updatedAt,
      idempotencyKey: `session:${session.id}:edge:${edge.source}:${edge.target}`,
    });
  }
  return reduceWorkflowEvents(events);
}

function userDecisionRequestedPayload(decision: UserDecisionProjection): Record<string, unknown> {
  return {
    decisionId: decision.decisionId,
    prompt: decision.prompt,
    options: decision.options,
    reason: decision.reason,
    ...(decision.targetLaneId ? { targetLaneId: decision.targetLaneId } : {}),
    ...(decision.targetSegmentId ? { targetSegmentId: decision.targetSegmentId } : {}),
  };
}

function userDecisionAnsweredPayload(decision: UserDecisionProjection): Record<string, unknown> | null {
  if (decision.status !== "answered" || !decision.selectedOption || !decision.action) return null;
  return {
    decisionId: decision.decisionId,
    selectedOption: decision.selectedOption,
    action: decision.action,
    ...(decision.comment ? { comment: decision.comment } : {}),
    ...(decision.targetLaneId ? { targetLaneId: decision.targetLaneId } : {}),
    ...(decision.targetSegmentId ? { targetSegmentId: decision.targetSegmentId } : {}),
  };
}

function flowLaneToCanvasNode(
  session: CanvasSession,
  lane: FlowLane,
  index: number,
  dependencies: string[],
  existing?: CanvasNode,
): CanvasNode {
  const status = flowLaneStatusToNodeStatus(lane.status);
  const progress = progressForFlowLane(lane, status, existing);
  const fallbackPosition = workflowLanePosition(index);
  return {
    id: lane.id,
    title: lane.title,
    agent: lane.agentKind,
    progress,
    nodeKind: lane.nodeKind,
    executable: lane.executable,
    laneKind: lane.laneKind,
    semanticSubtype: lane.semanticSubtype,
    runtimePolicy: lane.runtimePolicy,
    runtime: runtimeForStatus(status, progress),
    display: {
      agentLabel: lane.agentKind === "hermes" ? "Hermes" : "Codex",
      meta: [lane.kind, lane.id, "flow-kernel"],
    },
    workflowTrace: {
      source: "hermes",
      sourceRunId: "workflow-intent",
      lastTool: "createWorkflowCard",
      semanticKey: lane.semanticKey,
    },
    status,
    position: {
      x: existing?.position.x ?? fallbackPosition.x,
      y: existing?.position.y ?? fallbackPosition.y,
    },
    runId: `run-${session.id}-${lane.id}`,
    changesetId: `changeset-${session.id}-${lane.id}`,
    output: lane.output.length > 0 ? lane.output : existing?.output.length ? existing.output : [`Flow Kernel lane ${lane.kind} is ${lane.status}.`],
    worktree: {
      path: ".",
      branchName: `skyturn/${session.id}/${lane.id}`,
      baseCommit: "flow-kernel",
    },
    context: {
      brief: lane.title,
      sessionGoal: session.goal,
      relatedRequirements: "Compiled from Hermes WorkflowIntent.",
      relatedDesign: "Flow Kernel policy/gate/compiler creates the DAG projection.",
      relatedTasks: lane.semanticKey,
      dependencies,
      constraints: [
        "Renderer renders projection only.",
        "Completion follows evidence events, not agent prose.",
      ],
    },
  };
}

function userDecisionToCanvasNode(
  session: CanvasSession,
  decision: UserDecisionProjection,
  index: number,
  existing?: CanvasNode,
): CanvasNode {
  const status: CanvasNode["status"] = decision.status === "answered" ? "completed" : "pending";
  const fallbackPosition = workflowLanePosition(index);
  return {
    id: decision.decisionId,
    title: "User decision required",
    agent: "hermes",
    progress: decision.status === "answered" ? "Decision answered" : "Waiting for user decision",
    nodeKind: "user_decision",
    executable: false,
    laneKind: "decision",
    semanticSubtype: "user_decision",
    runtimePolicy: {
      source: "workflow_projection",
      trusted: true,
      executable: false,
      sandbox: "read-only",
      sideEffects: [],
      reason: "User decision nodes are not executable.",
    },
    userDecision: decision,
    runtime: runtimeForStatus(status, "decision"),
    display: {
      agentLabel: "User",
      meta: ["decision", decision.decisionId, "flow-kernel"],
    },
    workflowTrace: {
      source: "hermes",
      sourceRunId: "workflow-intent",
      lastTool: "createWorkflowCard",
      semanticKey: decision.decisionId,
    },
    status,
    position: {
      x: existing?.position.x ?? fallbackPosition.x,
      y: existing?.position.y ?? fallbackPosition.y,
    },
    runId: `run-${session.id}-${decision.decisionId}`,
    changesetId: `changeset-${session.id}-${decision.decisionId}`,
    output: existing?.output.length
      ? existing.output
      : [
          decision.prompt,
          `Reason: ${decision.reason}`,
          `Options: ${decision.options.join(", ")}`,
        ],
    worktree: {
      path: ".",
      branchName: `skyturn/${session.id}/${decision.decisionId}`,
      baseCommit: "flow-kernel",
    },
    context: {
      brief: decision.prompt,
      sessionGoal: session.goal,
      relatedRequirements: decision.reason,
      relatedDesign: "Hermes requested a user decision before continuing the workflow.",
      relatedTasks: decision.targetLaneId ?? decision.decisionId,
      dependencies: decision.targetLaneId ? [decision.targetLaneId] : [],
      constraints: ["This node is not executable.", "The answer is restored through Flow Kernel user decision state."],
    },
  };
}

function flowLaneStatusToNodeStatus(status: FlowLane["status"]): CanvasNode["status"] {
  if (status === "completed") return "completed";
  if (status === "failed" || status === "blocked") return "failed";
  if (status === "running" || status === "waiting_input") return "running";
  return "pending";
}

function progressForFlowLaneStatus(status: FlowLane["status"]): string {
  if (status === "completed") return "Evidence ready";
  if (status === "running") return "Streaming output";
  if (status === "failed" || status === "blocked") return "Gate rejected";
  return "Waiting for scheduler";
}

function progressForFlowLane(
  lane: FlowLane,
  status: CanvasNode["status"],
  existing?: CanvasNode,
): string {
  if (status === "completed") return "Evidence ready";
  if (status === "failed") return safeCompactPhrase(existing?.progress ?? "", "Run failed") ?? "Run failed";
  const projected = progressForFlowLaneStatus(lane.status);
  if (!existing || existing.status !== status) return projected;
  return safeCompactPhrase(existing.progress, projected) ?? projected;
}

export function buildPromptForNodeRun(
  session: CanvasSession,
  node: CanvasNode,
  sessionLedger?: WorkflowLedgerSummary,
): string {
  if (node.agent === "hermes") {
    if (node.display?.meta.includes("flow-kernel") && node.id !== session.plannerNodeId) {
      const dependencyEvidence = dependencyEvidenceForPrompt(session, node);
      return [
        `Task: ${node.context.brief}`,
        `Session goal: ${session.goal}`,
        `Node: ${node.id}`,
        dependencyEvidence,
        "Read-only review lane: do not modify files, do not stage changes, do not create commits, and do not create branches.",
        "You may inspect repository state and run verification commands, but the Codex commit lane owns any commit.",
        "Review the repository state, prior evidence, and dependency outcome for this lane.",
        "Return concise findings, blockers, and verification notes. Do not output planner JSON or workflow-card tool JSON.",
      ].filter(Boolean).join("\n");
    }
    return buildHermesWorkflowPrompt({
      goal: hermesGoalForNode(session, node),
      sessionId: session.id,
      plannerSessionId: session.hermesPlannerSessionId || makeHermesPlannerSessionId(session.id),
      nodeId: node.id,
      sessionLedger,
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

  const laneKind = node.display?.meta[0] ?? "";
  const laneInstruction = codexLaneInstruction(laneKind, node.title);
  const screenshotHelperInstruction = /browser|screenshot/.test(`${laneKind} ${node.title}`.toLowerCase())
    ? "If the repository provides `scripts/capture-screenshot.mjs`, run `node scripts/capture-screenshot.mjs .devflow/acceptance/react-app.png` and report that artifact path."
    : "";
  const dependencyEvidence = dependencyEvidenceForPrompt(session, node);
  return [
    `Task: ${node.context.brief}`,
    `Session goal: ${session.goal}`,
    `Node: ${node.id}`,
    `Worktree reference: ${node.worktree.path}`,
    dependencyEvidence,
    laneInstruction,
    screenshotHelperInstruction,
    "Stay inside the current git repository. Do not run broad parent-directory scans such as `find ..`; if checking agent instructions, inspect only repo-local paths.",
    "Return a concise result summary and any blocker or verification evidence. Do not claim completion without evidence.",
  ].filter(Boolean).join("\n");
}

function promptForNodeRun(
  session: CanvasSession,
  node: CanvasNode,
  sessionLedger?: WorkflowLedgerSummary,
): string {
  return buildPromptForNodeRun(session, node, sessionLedger);
}

export function sandboxForNodeRun(node: CanvasNode): AgentRunSandbox | undefined {
  if (node.executable === false || node.runtimePolicy?.executable === false) return undefined;
  if (node.agent !== "codex") return undefined;
  const laneKind = node.display?.meta[0] ?? "";
  const laneText = `${laneKind} ${node.title}`.toLowerCase();
  if (node.runtimePolicy?.source === "workflow_projection" && node.runtimePolicy.trusted) {
    if (node.runtimePolicy.sandbox === "read-only" && /browser|screenshot/.test(laneText)) return "danger-full-access";
    return node.runtimePolicy.sandbox;
  }
  if (laneKind === "commit" || /\bcommit\b/.test(laneText)) return "danger-full-access";
  if (/browser|screenshot/.test(laneText)) return "danger-full-access";
  if (/implementation|implement|change|update|edit/.test(laneText)) return "workspace-write";
  return undefined;
}

function canStartNodeRun(node: CanvasNode): boolean {
  return node.nodeKind !== "user_decision" && node.executable !== false && node.runtimePolicy?.executable !== false;
}

function hermesGoalForNode(session: CanvasSession, node: CanvasNode): string {
  const brief = node.context.brief.trim();
  if (!brief || brief === "Decompose the user goal into workflow-card tool calls.") return session.goal;
  if (brief === session.goal.trim()) return session.goal;
  return `${session.goal}\nCurrent requirement: ${brief}`;
}

function codexLaneInstruction(laneKind: string, title = ""): string {
  const laneText = `${laneKind} ${title}`.toLowerCase();
  if (laneKind === "commit") {
    return [
      "Before committing, read the dependency evidence above.",
      "If review evidence reports blockers, fix them or report blocked; do not commit a known blocker.",
      "Verify the working tree, run the relevant tests if needed, then git add only the relevant changed code/test files and create one commit with a concise message.",
      "If git add, git commit, or verification fails, report the blocker and exit non-zero.",
      "Do not stage `.devflow/`.",
    ].join(" ");
  }
  if (/browser|screenshot/.test(laneText)) {
    return "Capture browser screenshot evidence with a bounded command. Prefer repo-provided screenshot scripts over ad hoc browser automation. Start any dev server only if needed, write the screenshot artifact, and Stop any dev server before exiting. Do not create a git commit in this lane; the commit lane owns commits.";
  }
  if (/implementation|implement|change|update|edit/.test(laneText)) {
    return "Implement the requested code and test change in this git repository. Run the relevant tests. Do not create a git commit in this lane. Do not capture browser screenshots in this lane. Do not start persistent dev servers.";
  }
  if (/validation|test|regression/.test(laneText)) {
    return "Run the relevant verification command and report the exact result. Do not create a git commit in this lane.";
  }
  return "";
}

function expectedArtifactsInputForNode(node: CanvasNode): Pick<StartAgentRunInput, "expectedArtifacts"> | Record<string, never> {
  if (node.agent !== "codex") return {};
  const laneText = `${node.display?.meta[0] ?? ""} ${node.id} ${node.title}`.toLowerCase();
  if (!/browser|screenshot/.test(laneText)) return {};
  return { expectedArtifacts: [BROWSER_SCREENSHOT_ARTIFACT] };
}

function dependencyEvidenceForPrompt(session: CanvasSession, node: CanvasNode): string {
  const dependencies = node.context.dependencies
    .map((dependencyId) => session.nodes.find((candidate) => candidate.id === dependencyId))
    .filter((candidate): candidate is CanvasNode => Boolean(candidate));
  if (dependencies.length === 0) return "";

  const sections = dependencies.map((dependency) => {
    const output = dependency.output.join("\n").trim() || "(no output captured)";
    return [
      `Dependency ${dependency.id} (${dependency.title}, ${dependency.agent}, ${dependency.status}):`,
      trimForPrompt(output, 2_000),
    ].join("\n");
  });
  return ["Dependency evidence:", ...sections].join("\n");
}

function trimForPrompt(value: string, maxLength: number): string {
  if (value.length <= maxLength) return value;
  return `...${value.slice(value.length - maxLength)}`;
}

function segmentIdForNode(sessionId: string, nodeId: string): string {
  return `segment-${sessionId}-${nodeId}`;
}

function isWorkflowLedgerSummary(value: unknown): value is WorkflowLedgerSummary {
  if (!value || typeof value !== "object") return false;
  const candidate = value as Partial<WorkflowLedgerSummary>;
  return (
    typeof candidate.throughSeq === "number" &&
    (candidate.checkpointSummary === null || typeof candidate.checkpointSummary === "string") &&
    Array.isArray(candidate.facts) &&
    Array.isArray(candidate.recentEvents) &&
    Array.isArray(candidate.openQuestions)
  );
}

async function ensureRunWorktreePath(project: ImportedProject, session: CanvasSession, node: CanvasNode): Promise<string | null> {
  const existing = resolveRunWorktreePath(project, session, node);
  if (existing) return existing;
  if (!requiresManagedRunWorktree(session, node)) return null;
  if (typeof window.devflow?.workflow?.createWorktree !== "function") return null;

  const result = await window.devflow.workflow.createWorktree(project.rootPath, {
    sessionId: session.id,
    variantId: node.id,
    repoRoot: project.rootPath,
    baseRef: node.worktree.baseRef ?? session.target.baseRef ?? node.worktree.baseCommit,
    baseCommit: node.worktree.baseCommit,
    parentLaneId: node.id,
  });
  return absolutePathFromWorktree(result.worktree);
}

function resolveRunWorktreePath(project: ImportedProject, session: CanvasSession, node: CanvasNode): string | null {
  if (isPlannerRootNode(session, node)) return project.rootPath;
  const executionTarget = node.worktree.executionTarget ?? session.target.executionTarget;
  if (executionTarget === "current_branch") return project.rootPath;
  const candidate = node.worktree.realPath ?? node.worktree.path;
  return isAbsoluteLocalPath(candidate) ? candidate : null;
}

function requiresManagedRunWorktree(session: CanvasSession, node: CanvasNode): boolean {
  if (isPlannerRootNode(session, node)) return false;
  return (node.worktree.executionTarget ?? session.target.executionTarget) === "new_worktree";
}

function absolutePathFromWorktree(worktree: WorkflowWorktreeIdentity): string | null {
  const candidate = worktree.realPath || worktree.path;
  return isAbsoluteLocalPath(candidate) ? candidate : null;
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
  if (status === "failed") return failurePhraseFromEvents(events) ?? "Run failed";
  if (status === "running") return progressPhraseFromEvents(events) ?? safeCompactPhrase(fallback) ?? "Streaming persisted output";
  if (status === "retrying") return progressPhraseFromEvents(events) ?? safeCompactPhrase(fallback) ?? "Retry checkpoint";
  return fallback;
}

function failurePhraseFromEvents(events: RunEvent[]): string | null {
  for (let index = events.length - 1; index >= 0; index -= 1) {
    const event = events[index];
    if (event?.kind === "evidence") {
      const check = latestEvidenceCheckName(event.payload.checks);
      if (check) return `${check} failed`;
    }
  }
  for (let index = events.length - 1; index >= 0; index -= 1) {
    const event = events[index];
    if (event?.kind !== "error") continue;
    const source = typeof event.payload.source === "string" ? event.payload.source : "Adapter";
    return safeCompactPhrase(`${source} error`, "Run failed") ?? "Run failed";
  }
  return null;
}

function progressPhraseFromEvents(events: RunEvent[]): string | null {
  for (let index = events.length - 1; index >= 0; index -= 1) {
    const event = events[index];
    if (event?.kind !== "progress") continue;
    const phrase = progressPhraseFromPayload(event.payload);
    if (phrase) return phrase;
  }
  return null;
}

function progressPhraseFromPayload(payload: Record<string, unknown>): string | null {
  const command = typeof payload.command === "string" ? safeCompactPhrase(payload.command) : null;
  if (command) return command;
  const action = typeof payload.action === "string" ? safeCompactPhrase(payload.action) : null;
  if (action) return action;
  const check = typeof payload.checkName === "string" ? safeCompactPhrase(payload.checkName) : null;
  if (check) return check;
  const phase = typeof payload.phase === "string" ? safeCompactPhrase(payload.phase) : null;
  return phase ? `${phase}` : null;
}

function latestEvidenceCheckName(value: unknown): string | null {
  if (!Array.isArray(value)) return null;
  for (let index = value.length - 1; index >= 0; index -= 1) {
    const check = value[index] as { name?: unknown; status?: unknown };
    if (typeof check.name !== "string" || check.status !== "failed") continue;
    const phrase = safeCompactPhrase(check.name);
    if (phrase) return phrase;
  }
  return null;
}

function outputFromEvents(events: RunEvent[]): string[] {
  return events
    .filter((event) => event.kind === "output")
    .map((event) => (typeof event.payload.text === "string" ? event.payload.text : ""))
    .filter(Boolean);
}

function outputEvents(events: RunEvent[]): Array<{ text: string; timestamp: string }> {
  return events.flatMap((event) => {
    if (event.kind !== "output" || typeof event.payload.text !== "string") return [];
    return [{ text: event.payload.text, timestamp: event.timestamp }];
  });
}

function dedupeRunEvents(events: RunEvent[]): RunEvent[] {
  return [...new Map(events.map((event) => [event.seq, event])).values()].sort((left, right) => left.seq - right.seq);
}

function latestEventTimestamp(events: RunEvent[]): string | null {
  return events.at(-1)?.timestamp ?? null;
}

function uniqueRetryRunId(nodes: CanvasNode[], currentRunId: string, now: string): string {
  const timestamp = now.replace(/\D/g, "").slice(0, 14) || "retry";
  const base = currentRunId.replace(/-attempt-[0-9A-Za-z-]+$/, "");
  const candidate = `${base}-attempt-${timestamp}`;
  const used = new Set(nodes.map((node) => node.runId));
  if (!used.has(candidate)) return candidate;
  for (let index = 2; ; index += 1) {
    const next = `${candidate}-${index}`;
    if (!used.has(next)) return next;
  }
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

function isTerminalRunPersistenceEvent(event: RunEvent): boolean {
  if (event.kind === "error") return true;
  return event.kind === "status" && isRunStatus(event.payload.status) && isFinalRunStatus(event.payload.status);
}

function hasTerminalRunEvidence(evidence: RunEvidence): boolean {
  if (!isFinalRunStatus(evidence.status)) return false;
  if (evidence.status === "succeeded") return hasConcreteRunEvidence(evidence);
  return Boolean(
    evidence.completedAt ||
      evidence.exitCode !== null ||
      evidence.errorReason ||
      evidence.cancelReason ||
      evidence.checks.length > 0 ||
      evidence.artifacts.length > 0 ||
      evidence.review,
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
