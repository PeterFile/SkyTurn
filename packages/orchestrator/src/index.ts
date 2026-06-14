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
  nodeId: string;
  existingNodes: Array<Pick<CanvasNode, "id" | "title" | "agent" | "status">>;
}

export function buildHermesWorkflowPrompt(input: HermesWorkflowPromptInput): string {
  return [
    "You are Hermes-agent planning a SkyTurn workflow canvas.",
    "Return ONLY one JSON object. No markdown. No prose.",
    "Schema: {\"toolCalls\":[{\"tool\":\"createWorkflowCard|updateWorkflowCard|deleteWorkflowCard\",\"toolCallId\":\"string\",\"input\":{...}}]}",
    "Use these exact tools: createWorkflowCard, updateWorkflowCard, deleteWorkflowCard.",
    "Required vertical slice: use create, update, and delete at least once; create at least one running Codex code task.",
    "Allowed agents: hermes, codex, gemini, claude-code, openclaw.",
    "Allowed statuses: pending, running, retrying, completed, failed.",
    "For the running Codex task, set worktreePath to \".\" and brief to a concrete software-development task.",
    `Session: ${input.sessionId}`,
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
  if (call.tool === "createWorkflowCard") return createWorkflowCard(session, call, context);
  if (call.tool === "updateWorkflowCard") return updateWorkflowCard(session, call, context);
  return deleteWorkflowCard(session, call, context);
}

function createWorkflowCard(
  session: CanvasSession,
  call: Extract<WorkflowCardToolCall, { tool: "createWorkflowCard" }>,
  context: WorkflowCardToolContext,
): { session: CanvasSession; result: WorkflowCardToolResult } {
  const input = call.input;
  const id = cleanId(input.id) || nextNodeId(session.nodes);
  if (session.nodes.some((node) => node.id === id)) {
    return {
      session,
      result: { tool: call.tool, nodeId: id, status: "skipped", message: "Card already exists." },
    };
  }

  const title = requireText(input.title, "title");
  const brief = requireText(input.brief, "brief");
  const agent = requireAgent(input.agent);
  const status = input.status ? requireStatus(input.status) : "pending";
  const dependencies = uniqueIds(input.dependencies ?? []);
  const node: CanvasNode = {
    id,
    title,
    agent,
    progress: input.progress?.trim() || progressForStatus(status),
    runtime: runtimeForStatus(status),
    display: {
      agentLabel: agentLabel(agent),
      meta: ["workflow-card-tools", id],
    },
    workflowTrace: {
      source: "hermes" as const,
      sourceRunId: context.sourceRunId,
      toolCallId: call.toolCallId,
      lastTool: call.tool,
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

function updateWorkflowCard(
  session: CanvasSession,
  call: Extract<WorkflowCardToolCall, { tool: "updateWorkflowCard" }>,
  context: WorkflowCardToolContext,
): { session: CanvasSession; result: WorkflowCardToolResult } {
  const id = requireText(call.input.id, "id");
  let changed = false;
  const nodes = session.nodes.map((node) => {
    if (node.id !== id) return node;
    changed = true;
    const status = call.input.status ? requireStatus(call.input.status) : node.status;
    const dependencies = call.input.dependencies ? uniqueIds(call.input.dependencies) : node.context.dependencies;
    return {
      ...node,
      title: call.input.title?.trim() || node.title,
      agent: call.input.agent ? requireAgent(call.input.agent) : node.agent,
      status,
      progress: call.input.progress?.trim() || node.progress,
      runtime: runtimeForStatus(status),
      workflowTrace: {
        source: "hermes" as const,
        sourceRunId: context.sourceRunId,
        toolCallId: call.toolCallId,
        lastTool: call.tool,
      },
      output: [...node.output, ...normalizeOutput(call.input.output)],
      worktree: {
        ...node.worktree,
        path: call.input.worktreePath?.trim() || node.worktree.path,
      },
      context: {
        ...node.context,
        brief: call.input.brief?.trim() || node.context.brief,
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
