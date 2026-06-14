import type { HermesOrchestratorAdapter } from "@skyturn/agent-runtime";
import type {
  AgentKind,
  CanvasEdge,
  CanvasNode,
  CanvasSession,
  NodeRuntimeState,
  NodeStatus,
  PlanSession,
  WorkflowCardToolName,
} from "@skyturn/project-core";

export interface TaskGraphScheduler {
  nextRunnableNodes(session: CanvasSession): CanvasNode[];
}

export interface Orchestrator {
  hermes: HermesOrchestratorAdapter;
  scheduler: TaskGraphScheduler;
  createFastSession(input: { projectId: string; goal: string; createdAt: string }): CanvasSession;
  createPlanSession(input: { projectId: string; goal: string; createdAt: string }): PlanSession;
  confirmPlan(session: PlanSession): CanvasSession;
}

export const dependencyAwareScheduler: TaskGraphScheduler = {
  nextRunnableNodes(session) {
    const completed = new Set(
      session.nodes.filter((node) => node.status === "completed").map((node) => node.id),
    );
    return session.nodes.filter((node) => {
      if (node.status !== "pending") return false;
      return node.context.dependencies.every((dependency) => completed.has(dependency));
    });
  },
};

export interface WorkflowCardToolContext {
  sourceRunId: string;
  now: string;
  authoritativeNodeStatuses?: Record<string, NodeStatus>;
}

export interface WorkflowCardToolResult {
  tool: WorkflowCardToolName;
  nodeId: string;
  status: "applied" | "skipped";
  message: string;
}

export interface WorkflowCardToolApplication {
  session: CanvasSession;
  results: WorkflowCardToolResult[];
}

export interface WorkflowCardCreateInput {
  id?: string;
  taskKey?: string;
  title: string;
  agent: AgentKind;
  status?: NodeStatus;
  progress?: string;
  brief: string;
  dependencies?: string[];
  position?: CanvasNode["position"];
  output?: string | string[];
  worktreePath?: string;
}

export interface WorkflowCardUpdateInput {
  id: string;
  taskKey?: string;
  title?: string;
  agent?: AgentKind;
  status?: NodeStatus;
  progress?: string;
  brief?: string;
  dependencies?: string[];
  output?: string | string[];
  worktreePath?: string;
}

export interface WorkflowCardDeleteInput {
  id: string;
  reason?: string;
}

export type WorkflowCardToolCall =
  | {
      tool: "createWorkflowCard";
      toolCallId?: string;
      input: WorkflowCardCreateInput;
    }
  | {
      tool: "updateWorkflowCard";
      toolCallId?: string;
      input: WorkflowCardUpdateInput;
    }
  | {
      tool: "deleteWorkflowCard";
      toolCallId?: string;
      input: WorkflowCardDeleteInput;
    };

export interface HermesWorkflowPromptInput {
  goal: string;
  sessionId: string;
  plannerSessionId: string;
  nodeId: string;
  existingNodes: Array<Pick<CanvasNode, "id" | "title" | "agent" | "status"> & {
    taskKey?: string;
    dependencies?: string[];
  }>;
}

export function buildHermesWorkflowPrompt(input: HermesWorkflowPromptInput): string {
  return [
    "You are Hermes-agent planning a SkyTurn workflow canvas.",
    "Return ONLY one JSON object. No markdown. No prose.",
    "Schema: {\"toolCalls\":[{\"tool\":\"createWorkflowCard|updateWorkflowCard|deleteWorkflowCard\",\"toolCallId\":\"string\",\"input\":{\"id\":\"string\",\"taskKey\":\"string\",\"title\":\"string\",\"agent\":\"hermes|codex|gemini|claude-code|openclaw\",\"status\":\"pending|running|retrying|completed|failed\",\"brief\":\"string\",\"dependencies\":[\"node-id\"],\"worktreePath\":\"string\"}}]}",
    "Use these exact tools: createWorkflowCard, updateWorkflowCard, deleteWorkflowCard.",
    "Card is SkyTurn task state, not the agent itself.",
    "Hermes cards are planner/verifier tasks; Codex cards are executor tasks.",
    "runId connects a card to a concrete local agent run.",
    "The planner session identity is stable for this CanvasSession; runId is not a planner identity.",
    "Continue the same planner session for new requirements in this CanvasSession.",
    "Dependencies define xyflow edges and scheduling order.",
    "Use stable card IDs or stable taskKey values for semantically identical cards.",
    "Use updateWorkflowCard instead of createWorkflowCard when an equivalent card already exists.",
    "Every verification card must depend on the Codex implementation card it verifies.",
    "No disconnected cards except the root planning card.",
    "Do not set a verifier running until its dependencies are completed; create it pending when implementation is still running.",
    "At most one primary Codex implementation card and one Hermes verification card for a simple single-file task.",
    "Required vertical slice: create at least one running Codex code task.",
    "Allowed agents: hermes, codex, gemini, claude-code, openclaw.",
    "Allowed statuses: pending, running, retrying, completed, failed.",
    "For the running Codex task, set worktreePath to \".\" and brief to a concrete software-development task.",
    `Session: ${input.sessionId}`,
    `Planner session identity: ${input.plannerSessionId}`,
    `Planning node: ${input.nodeId}`,
    `Existing nodes: ${JSON.stringify(input.existingNodes)}`,
    `User goal: ${input.goal}`,
  ].join("\n");
}

export function parseHermesWorkflowToolCalls(output: string): WorkflowCardToolCall[] {
  const parsed = parseFirstJsonObject(output);
  const calls = parsed?.toolCalls;
  if (!Array.isArray(calls)) return [];

  return calls.flatMap((value): WorkflowCardToolCall[] => {
    if (!isRecord(value) || !isWorkflowCardToolName(value.tool) || !isRecord(value.input)) return [];
    const toolCallId = typeof value.toolCallId === "string" ? value.toolCallId : undefined;
    if (value.tool === "createWorkflowCard") {
      return [{ tool: value.tool, toolCallId, input: value.input as unknown as WorkflowCardCreateInput }];
    }
    if (value.tool === "updateWorkflowCard") {
      return [{ tool: value.tool, toolCallId, input: value.input as unknown as WorkflowCardUpdateInput }];
    }
    return [{ tool: value.tool, toolCallId, input: value.input as unknown as WorkflowCardDeleteInput }];
  });
}

export function applyWorkflowCardToolCalls(
  session: CanvasSession,
  calls: WorkflowCardToolCall[],
  context: WorkflowCardToolContext,
): WorkflowCardToolApplication {
  return calls.reduce<WorkflowCardToolApplication>(
    (current, call) => {
      let next: { session: CanvasSession; result: WorkflowCardToolResult };
      try {
        next = applyWorkflowCardToolCall(current.session, call, context);
      } catch (error) {
        next = {
          session: current.session,
          result: {
            tool: call.tool,
            nodeId: skippedNodeId(call),
            status: "skipped",
            message: error instanceof Error ? error.message : "Workflow card tool call failed.",
          },
        };
      }
      return {
        session: next.session,
        results: [...current.results, next.result],
      };
    },
    { session, results: [] },
  );
}

function applyWorkflowCardToolCall(
  session: CanvasSession,
  call: WorkflowCardToolCall,
  context: WorkflowCardToolContext,
): { session: CanvasSession; result: WorkflowCardToolResult } {
  const next =
    call.tool === "createWorkflowCard"
      ? createWorkflowCard(session, call, context)
      : call.tool === "updateWorkflowCard"
        ? updateWorkflowCard(session, call, context)
        : deleteWorkflowCard(session, call, context);
  return {
    ...next,
    session: applyVerifierGraphHygiene(applyPlannerRootGraphHygiene(next.session), context),
  };
}

function applyPlannerRootGraphHygiene(session: CanvasSession): CanvasSession {
  const plannerNodeId = session.plannerNodeId;
  const planner = session.nodes.find((node) => node.id === plannerNodeId);
  if (!planner) return session;

  const nodes =
    planner.context.dependencies.length === 0
      ? session.nodes
      : session.nodes.map((node) =>
          node.id === plannerNodeId
            ? {
                ...node,
                context: {
                  ...node.context,
                  dependencies: [],
                },
              }
            : node,
        );
  const edges = session.edges.filter((edge) => edge.target !== plannerNodeId);
  if (nodes === session.nodes && edges.length === session.edges.length) return session;
  return {
    ...session,
    nodes,
    edges,
  };
}

function applyVerifierGraphHygiene(session: CanvasSession, context: WorkflowCardToolContext): CanvasSession {
  const sourceNodeId = sourceNodeIdForContext(session, context);
  const changedIds = new Set<string>();
  const nodes = session.nodes.map((node) => {
    if (!isVerifierCard(node.agent, node.title, node.context.brief)) return node;
    const dependencies = repairDependencies(session, {
      id: node.id,
      agent: node.agent,
      title: node.title,
      brief: node.context.brief,
      dependencies: node.context.dependencies,
      sourceNodeId,
    });
    const status = statusForExistingNode(session.nodes, node, context, {
      agent: node.agent,
      title: node.title,
      brief: node.context.brief,
      requestedStatus: node.status,
      dependencies,
    });
    if (arraysEqual(dependencies, node.context.dependencies) && status === node.status) return node;

    changedIds.add(node.id);
    return {
      ...node,
      status,
      runtime: runtimeForStatus(status),
      progress: status === node.status ? node.progress : progressForStatus(status),
      context: {
        ...node.context,
        dependencies,
      },
    };
  });

  if (changedIds.size === 0) return session;

  let edges = session.edges;
  for (const id of changedIds) {
    const node = nodes.find((candidate) => candidate.id === id);
    if (!node) continue;
    edges = addDependencyEdges(removeTargetEdges(edges, id), id, node.context.dependencies);
  }
  const activeNodeId =
    nodes.find((node) => node.id === session.activeNodeId && node.status === "running")?.id ??
    nodes.find((node) => node.status === "running")?.id ??
    session.activeNodeId;

  return {
    ...session,
    nodes,
    edges,
    activeNodeId,
  };
}

function createWorkflowCard(
  session: CanvasSession,
  call: Extract<WorkflowCardToolCall, { tool: "createWorkflowCard" }>,
  context: WorkflowCardToolContext,
): { session: CanvasSession; result: WorkflowCardToolResult } {
  const input = call.input;
  const id = cleanId(input.id) || nextNodeId(session.nodes);
  const title = requireText(input.title, "title");
  const brief = requireText(input.brief, "brief");
  const agent = requireAgent(input.agent);
  const taskKey = normalizeTaskKey(input.taskKey);
  const semanticKey = semanticKeyForCard({ agent, title, brief, taskKey });
  const equivalent = findEquivalentCard(session.nodes, { id, agent, title, brief, taskKey, semanticKey });
  if (equivalent) {
    return mergeWorkflowCard(session, equivalent, call, context);
  }

  const sourceNodeId = sourceNodeIdForContext(session, context);
  const requestedStatus = input.status ? requireStatus(input.status) : "pending";
  const dependencies = repairDependencies(session, {
    id,
    agent,
    title,
    brief,
    dependencies: uniqueIds(input.dependencies ?? []),
    sourceNodeId,
  });
  const status = gateVerifierStatus(session.nodes, { agent, title, brief, requestedStatus, dependencies });
  const node: CanvasNode = {
    id,
    title,
    agent,
    progress: progressForInput(input.progress, requestedStatus, status),
    runtime: runtimeForStatus(status),
    display: {
      agentLabel: agentLabel(agent),
      meta: workflowCardMeta(id, taskKey),
    },
    workflowTrace: {
      source: "hermes" as const,
      sourceRunId: context.sourceRunId,
      toolCallId: call.toolCallId,
      lastTool: call.tool,
      ...(taskKey ? { taskKey } : {}),
      semanticKey,
    },
    status,
    position: input.position ?? nextNodePosition(session.nodes),
    runId: `run-${session.id}-${id}`,
    changesetId: `changeset-${session.id}-${id}`,
    output: [
      "Created by Hermes workflow-card tool createWorkflowCard.",
      ...normalizeOutput(input.output),
    ],
    worktree: {
      path: input.worktreePath?.trim() || ".",
      branchName: `skyturn/${session.id}/${id}`,
      baseCommit: "pending-base-commit",
    },
    context: {
      brief,
      sessionGoal: session.goal,
      relatedRequirements: "Created from Hermes workflow-card tool output.",
      relatedDesign: "Hermes decomposes the goal; local agents execute task cards.",
      relatedTasks: `Hermes tool call ${call.toolCallId ?? id}`,
      dependencies,
      constraints: [
        "Renderer does not spawn local processes.",
        "Completion follows RunEvidence, not agent prose.",
      ],
    },
  };
  const edges = addDependencyEdges(session.edges, id, dependencies);

  return {
    session: {
      ...session,
      nodes: [...session.nodes, node],
      edges,
      activeNodeId: status === "running" ? id : session.activeNodeId,
      updatedAt: context.now,
    },
    result: { tool: call.tool, nodeId: id, status: "applied", message: "Card created." },
  };
}

function mergeWorkflowCard(
  session: CanvasSession,
  target: CanvasNode,
  call: Extract<WorkflowCardToolCall, { tool: "createWorkflowCard" }>,
  context: WorkflowCardToolContext,
): { session: CanvasSession; result: WorkflowCardToolResult } {
  const input = call.input;
  const title = requireText(input.title, "title");
  const brief = requireText(input.brief, "brief");
  const agent = requireAgent(input.agent);
  const taskKey = normalizeTaskKey(input.taskKey) ?? target.workflowTrace?.taskKey;
  const semanticKey = semanticKeyForCard({ agent, title, brief, taskKey });
  const requestedStatus = input.status ? requireStatus(input.status) : target.status;
  const sourceNodeId = sourceNodeIdForContext(session, context);
  const dependencies = repairDependencies(session, {
    id: target.id,
    agent,
    title,
    brief,
    dependencies: uniqueIds([...target.context.dependencies, ...(input.dependencies ?? [])]),
    sourceNodeId,
  });
  const status = statusForExistingNode(session.nodes, target, context, {
    agent,
    title,
    brief,
    requestedStatus,
    dependencies,
  });
  const nodes = session.nodes.map((node) => {
    if (node.id !== target.id) return node;
    return {
      ...node,
      title,
      agent,
      status,
      progress: progressForInput(input.progress, requestedStatus, status, node.progress),
      runtime: runtimeForStatus(status),
      display: {
        ...node.display,
        agentLabel: agentLabel(agent),
        meta: workflowCardMeta(target.id, taskKey),
      },
      workflowTrace: {
        source: "hermes" as const,
        sourceRunId: context.sourceRunId,
        toolCallId: call.toolCallId,
        lastTool: call.tool,
        ...(taskKey ? { taskKey } : {}),
        semanticKey,
      },
      output: [...node.output, ...normalizeOutput(input.output)],
      worktree: {
        ...node.worktree,
        path: input.worktreePath?.trim() || node.worktree.path,
      },
      context: {
        ...node.context,
        brief,
        dependencies,
        relatedTasks: `Hermes tool call ${call.toolCallId ?? target.id}`,
      },
    };
  });
  const edges = addDependencyEdges(removeTargetEdges(session.edges, target.id), target.id, dependencies);

  return {
    session: {
      ...session,
      nodes,
      edges,
      activeNodeId: status === "running" ? target.id : session.activeNodeId,
      updatedAt: context.now,
    },
    result: { tool: call.tool, nodeId: target.id, status: "applied", message: "Equivalent card merged." },
  };
}

function updateWorkflowCard(
  session: CanvasSession,
  call: Extract<WorkflowCardToolCall, { tool: "updateWorkflowCard" }>,
  context: WorkflowCardToolContext,
): { session: CanvasSession; result: WorkflowCardToolResult } {
  const id = requireText(call.input.id, "id");
  const sourceNodeId = sourceNodeIdForContext(session, context);
  let changed = false;
  const nodes = session.nodes.map((node) => {
    if (node.id !== id) return node;
    changed = true;
    const agent = call.input.agent ? requireAgent(call.input.agent) : node.agent;
    const title = call.input.title?.trim() || node.title;
    const brief = call.input.brief?.trim() || node.context.brief;
    const taskKey = normalizeTaskKey(call.input.taskKey) ?? node.workflowTrace?.taskKey;
    const semanticKey = semanticKeyForCard({ agent, title, brief, taskKey });
    const requestedStatus = call.input.status ? requireStatus(call.input.status) : node.status;
    const dependencies = repairDependencies(session, {
      id,
      agent,
      title,
      brief,
      dependencies: call.input.dependencies ? uniqueIds(call.input.dependencies) : node.context.dependencies,
      sourceNodeId,
    });
    const status = statusForExistingNode(session.nodes, node, context, {
      agent,
      title,
      brief,
      requestedStatus,
      dependencies,
    });
    return {
      ...node,
      title,
      agent,
      status,
      progress: progressForInput(call.input.progress, requestedStatus, status, node.progress),
      runtime: runtimeForStatus(status),
      workflowTrace: {
        source: "hermes" as const,
        sourceRunId: context.sourceRunId,
        toolCallId: call.toolCallId,
        lastTool: call.tool,
        ...(taskKey ? { taskKey } : {}),
        semanticKey,
      },
      output: [...node.output, ...normalizeOutput(call.input.output)],
      worktree: {
        ...node.worktree,
        path: call.input.worktreePath?.trim() || node.worktree.path,
      },
      context: {
        ...node.context,
        brief,
        dependencies,
        relatedTasks: `Hermes tool call ${call.toolCallId ?? id}`,
      },
    };
  });

  if (!changed) {
    return {
      session,
      result: { tool: call.tool, nodeId: id, status: "skipped", message: "Card not found." },
    };
  }

  const target = nodes.find((node) => node.id === id);
  const edges = target
    ? addDependencyEdges(removeTargetEdges(session.edges, id), id, target.context.dependencies)
    : session.edges;

  return {
    session: {
      ...session,
      nodes,
      edges,
      activeNodeId: target?.status === "running" ? id : session.activeNodeId,
      updatedAt: context.now,
    },
    result: { tool: call.tool, nodeId: id, status: "applied", message: "Card updated." },
  };
}

function deleteWorkflowCard(
  session: CanvasSession,
  call: Extract<WorkflowCardToolCall, { tool: "deleteWorkflowCard" }>,
  context: WorkflowCardToolContext,
): { session: CanvasSession; result: WorkflowCardToolResult } {
  const id = requireText(call.input.id, "id");
  const exists = session.nodes.some((node) => node.id === id);
  if (!exists) {
    return {
      session,
      result: { tool: call.tool, nodeId: id, status: "skipped", message: "Card not found." },
    };
  }

  const nodes = session.nodes.filter((node) => node.id !== id);
  return {
    session: {
      ...session,
      nodes,
      edges: session.edges.filter((edge) => edge.source !== id && edge.target !== id),
      activeNodeId: session.activeNodeId === id ? nodes.find((node) => node.status === "running")?.id ?? nodes[0]?.id ?? null : session.activeNodeId,
      updatedAt: context.now,
    },
    result: {
      tool: call.tool,
      nodeId: id,
      status: "applied",
      message: call.input.reason?.trim() || "Card deleted.",
    },
  };
}

function parseFirstJsonObject(output: string): { toolCalls?: unknown } | null {
  const first = output.indexOf("{");
  const last = output.lastIndexOf("}");
  if (first === -1 || last < first) return null;
  try {
    const value = JSON.parse(output.slice(first, last + 1)) as unknown;
    return isRecord(value) ? value : null;
  } catch {
    return null;
  }
}

function isWorkflowCardToolName(value: unknown): value is WorkflowCardToolName {
  return value === "createWorkflowCard" || value === "updateWorkflowCard" || value === "deleteWorkflowCard";
}

function requireText(value: unknown, field: string): string {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new Error(`Workflow card ${field} must be a non-empty string.`);
  }
  return value.trim();
}

function requireAgent(value: unknown): AgentKind {
  if (
    value === "hermes" ||
    value === "codex" ||
    value === "gemini" ||
    value === "claude-code" ||
    value === "openclaw"
  ) {
    return value;
  }
  throw new Error("Workflow card agent is not supported.");
}

function requireStatus(value: unknown): NodeStatus {
  if (value === "pending" || value === "running" || value === "retrying" || value === "completed" || value === "failed") {
    return value;
  }
  throw new Error("Workflow card status is not supported.");
}

function uniqueIds(values: string[]): string[] {
  return [...new Set(values.map((value) => cleanId(value)).filter((value): value is string => Boolean(value)))];
}

function cleanId(value: unknown): string | null {
  return typeof value === "string" && /^[A-Za-z0-9._:-]+$/.test(value.trim()) ? value.trim() : null;
}

function normalizeTaskKey(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const normalized = normalizeText(value);
  return normalized || undefined;
}

function semanticKeyForCard(input: {
  agent: AgentKind;
  title: string;
  brief: string;
  taskKey?: string;
}): string {
  if (input.taskKey) return `task-key:${input.taskKey}`;
  return [
    `agent:${input.agent}`,
    `role:${cardRole(input.agent, input.title, input.brief)}`,
    `title:${normalizeText(input.title)}`,
    `brief:${normalizeText(input.brief)}`,
  ].join("|");
}

function semanticKeyForNode(node: CanvasNode): string {
  return node.workflowTrace?.semanticKey ?? semanticKeyForCard({
    agent: node.agent,
    title: node.title,
    brief: node.context.brief,
    taskKey: node.workflowTrace?.taskKey,
  });
}

function findEquivalentCard(
  nodes: CanvasNode[],
  input: {
    id: string;
    agent: AgentKind;
    title: string;
    brief: string;
    taskKey?: string;
    semanticKey: string;
  },
): CanvasNode | null {
  return nodes.find((node) => node.id === input.id || semanticKeyForNode(node) === input.semanticKey) ?? null;
}

function sourceNodeIdForContext(session: CanvasSession, context: WorkflowCardToolContext): string | null {
  return session.nodes.find((node) => node.runId === context.sourceRunId)?.id ?? null;
}

function repairDependencies(
  session: CanvasSession,
  input: {
    id: string;
    agent: AgentKind;
    title: string;
    brief: string;
    dependencies: string[];
    sourceNodeId: string | null;
  },
): string[] {
  const dependencies = uniqueIds(input.dependencies).filter((dependency) => dependency !== input.id);
  if (dependencies.length === 0 && input.sourceNodeId && input.sourceNodeId !== input.id) {
    dependencies.push(input.sourceNodeId);
  }

  if (isVerifierCard(input.agent, input.title, input.brief)) {
    const target = findVerifiedCodexCard(session, input, dependencies);
    if (target && !dependencies.includes(target.id)) dependencies.push(target.id);
  }

  return dependencies;
}

function findVerifiedCodexCard(
  session: CanvasSession,
  input: {
    id: string;
    title: string;
    brief: string;
  },
  dependencies: string[],
): CanvasNode | null {
  const nodeById = new Map(session.nodes.map((node) => [node.id, node]));
  if (dependencies.some((dependency) => nodeById.get(dependency)?.agent === "codex")) return null;

  const candidates = session.nodes.filter((node) => node.id !== input.id && node.agent === "codex");
  if (candidates.length === 0) return null;
  if (candidates.length === 1) return candidates[0] ?? null;

  const verifierTokens = tokenSet(`${input.title} ${input.brief}`);
  const scored = candidates
    .map((node) => ({
      node,
      score: overlapScore(verifierTokens, tokenSet(`${node.title} ${node.context.brief}`)),
    }))
    .sort((left, right) => right.score - left.score);
  return scored[0]?.score ? scored[0].node : null;
}

function statusForExistingNode(
  nodes: CanvasNode[],
  node: CanvasNode,
  context: WorkflowCardToolContext,
  input: {
    agent: AgentKind;
    title: string;
    brief: string;
    requestedStatus: NodeStatus;
    dependencies: string[];
  },
): NodeStatus {
  const authoritativeStatus = context.authoritativeNodeStatuses?.[node.id];
  if (authoritativeStatus) return authoritativeStatus;
  if (node.status === "completed" || node.status === "failed") return node.status;
  return gateVerifierStatus(nodes, input);
}

function gateVerifierStatus(
  nodes: CanvasNode[],
  input: {
    agent: AgentKind;
    title: string;
    brief: string;
    requestedStatus: NodeStatus;
    dependencies: string[];
  },
): NodeStatus {
  if (
    input.requestedStatus === "running" &&
    isVerifierCard(input.agent, input.title, input.brief) &&
    !dependenciesCompleted(nodes, input.dependencies)
  ) {
    return "pending";
  }
  return input.requestedStatus;
}

function dependenciesCompleted(nodes: CanvasNode[], dependencies: string[]): boolean {
  if (dependencies.length === 0) return true;
  const completed = new Set(nodes.filter((node) => node.status === "completed").map((node) => node.id));
  return dependencies.every((dependency) => completed.has(dependency));
}

function progressForInput(
  value: string | undefined,
  requestedStatus: NodeStatus,
  status: NodeStatus,
  fallback?: string,
): string {
  if (status !== requestedStatus) return progressForStatus(status);
  return value?.trim() || fallback || progressForStatus(status);
}

function workflowCardMeta(id: string, taskKey: string | undefined): string[] {
  return taskKey ? ["workflow-card-tools", id, `task-key:${taskKey}`] : ["workflow-card-tools", id];
}

function cardRole(agent: AgentKind, title: string, brief: string): "planner" | "verifier" | "executor" | "task" {
  if (isVerifierCard(agent, title, brief)) return "verifier";
  if (agent === "hermes" && /\b(plan|planning|decompose|orchestrate)\b/.test(normalizeText(`${title} ${brief}`))) {
    return "planner";
  }
  if (agent === "codex") return "executor";
  return "task";
}

function isVerifierCard(agent: AgentKind, title: string, brief: string): boolean {
  if (agent !== "hermes") return false;
  const text = normalizeText(`${title} ${brief}`);
  return /\b(verify|verification|validate|validation|review|check|test|qa|audit)\b/.test(text) ||
    /验证|验收|复核|检查|测试/.test(`${title} ${brief}`);
}

function normalizeText(value: string): string {
  return value.trim().toLowerCase().replace(/[^a-z0-9\u4e00-\u9fff]+/g, " ").replace(/\s+/g, " ").trim();
}

function tokenSet(value: string): Set<string> {
  const ignored = new Set([
    "the",
    "and",
    "for",
    "with",
    "card",
    "task",
    "codex",
    "hermes",
    "verify",
    "verification",
    "implementation",
  ]);
  return new Set(normalizeText(value).split(" ").filter((token) => token.length > 2 && !ignored.has(token)));
}

function overlapScore(left: Set<string>, right: Set<string>): number {
  let score = 0;
  for (const token of left) {
    if (right.has(token)) score += 1;
  }
  return score;
}

function arraysEqual(left: string[], right: string[]): boolean {
  return left.length === right.length && left.every((value, index) => value === right[index]);
}

function skippedNodeId(call: WorkflowCardToolCall): string {
  return cleanId(call.input.id) ?? "unknown";
}

function normalizeOutput(value: string | string[] | undefined): string[] {
  if (!value) return [];
  if (typeof value === "string") return value.trim() ? [value.trim()] : [];
  return value.map((item) => item.trim()).filter(Boolean);
}

function nextNodeId(nodes: CanvasNode[]): string {
  const max = nodes.reduce((value, node) => {
    const match = /^node-(\d+)$/.exec(node.id);
    return match ? Math.max(value, Number(match[1])) : value;
  }, 0);
  return `node-${max + 1}`;
}

function nextNodePosition(nodes: CanvasNode[]): CanvasNode["position"] {
  const index = nodes.length;
  return {
    x: 120 + (index % 3) * 340,
    y: 120 + Math.floor(index / 3) * 220,
  };
}

function addDependencyEdges(edges: CanvasEdge[], target: string, dependencies: string[]): CanvasEdge[] {
  const existing = new Set(edges.map((edge) => edge.id));
  const next = [...edges];
  for (const dependency of dependencies) {
    const id = `edge-${dependency}-${target}`;
    if (!existing.has(id)) next.push({ id, source: dependency, target });
  }
  return next;
}

function removeTargetEdges(edges: CanvasEdge[], target: string): CanvasEdge[] {
  return edges.filter((edge) => edge.target !== target);
}

function runtimeForStatus(status: NodeStatus): NodeRuntimeState {
  switch (status) {
    case "pending":
      return { phase: "Queued", message: "正在等待调度", action: "waiting for dependencies" };
    case "running":
      return { phase: "Executing", message: "正在执行任务", action: "running local agent" };
    case "retrying":
      return { phase: "Retrying", message: "正在重新尝试", action: "retrying from checkpoint" };
    case "completed":
      return { phase: "Completed", message: "已完成验证", action: "evidence ready" };
    case "failed":
      return { phase: "Failed", message: "等待人工处理", action: "blocked by run evidence" };
  }
}

function progressForStatus(status: NodeStatus): string {
  switch (status) {
    case "pending":
      return "Planned";
    case "running":
      return "Running";
    case "retrying":
      return "Retrying";
    case "completed":
      return "Evidence ready";
    case "failed":
      return "Needs attention";
  }
}

function agentLabel(agent: AgentKind): string {
  if (agent === "claude-code") return "ClaudeCode";
  return agent === "codex" ? "Codex" : agent[0].toUpperCase() + agent.slice(1);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}
