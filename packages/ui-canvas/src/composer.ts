import { makeHermesPlannerSessionId, type CanvasNode, type CanvasSession } from "@skyturn/project-core";

import { plannerRootPosition } from "./canvasLayout.js";

export interface RequirementPlanningNodeOptions {
  now: string;
  projectName: string;
}

export interface RequirementPlanningNodeResult {
  session: CanvasSession;
  node: CanvasNode;
}

export function addRequirementPlanningNode(
  session: CanvasSession,
  requirement: string,
  options: RequirementPlanningNodeOptions,
): RequirementPlanningNodeResult {
  const brief = requirement.trim();
  if (!brief) throw new Error("Requirement must be non-empty.");

  const plannerSessionId = session.hermesPlannerSessionId || makeHermesPlannerSessionId(session.id);
  const existingPlanner = findPlannerNode(session);
  const id = session.plannerNodeId || existingPlanner?.id || nextNodeId(session.nodes);
  const node = planningNodeForRequirement({
    session,
    existingPlanner,
    plannerSessionId,
    id,
    brief,
    options,
  });
  const nodes = existingPlanner
    ? session.nodes.map((item) => (item.id === existingPlanner.id ? node : item))
    : [...session.nodes, node];

  return {
    node,
    session: {
      ...session,
      hermesPlannerSessionId: plannerSessionId,
      plannerNodeId: node.id,
      nodes,
      activeNodeId: node.id,
      updatedAt: options.now,
    },
  };
}

function nextNodeId(nodes: CanvasNode[]): string {
  const used = new Set(nodes.map((node) => node.id));
  for (let index = Math.max(1, nodes.length + 1); ; index += 1) {
    const id = `node-${index}`;
    if (!used.has(id)) return id;
  }
}

function findPlannerNode(session: CanvasSession): CanvasNode | null {
  return (
    session.nodes.find((node) => node.id === session.plannerNodeId) ??
    session.nodes.find((node) => node.agent === "hermes" && node.context.dependencies.length === 0) ??
    session.nodes.find((node) => node.agent === "hermes") ??
    null
  );
}

function planningNodeForRequirement(input: {
  session: CanvasSession;
  existingPlanner: CanvasNode | null;
  plannerSessionId: string;
  id: string;
  brief: string;
  options: RequirementPlanningNodeOptions;
}): CanvasNode {
  const runId = plannerRunId(input.session.id, input.id, input.options.now);
  const base = input.existingPlanner;
  return {
    id: input.id,
    title: input.brief.slice(0, 56),
    agent: "hermes",
    progress: "Calling workflow-card tools",
    status: "running",
    runtime: {
      phase: "Planning",
      message: "正在拆解任务",
      action: "calling workflow-card tools",
    },
    display: {
      agentLabel: "Hermes",
      meta: ["workflow-card-tools", input.id, `planner-session:${input.plannerSessionId}`],
    },
    position: base?.position ?? plannerRootPosition(),
    runId,
    changesetId: `changeset-${runId}`,
    output: [
      ...(base?.output ?? []),
      `Requirement appended to Hermes planner session ${input.plannerSessionId}.`,
    ],
    worktree: base?.worktree ?? {
      path: ".",
      branchName: `skyturn/${input.session.id}/${input.id}`,
      baseCommit: "pending-base-commit",
    },
    context: {
      brief: input.brief,
      sessionGoal: input.session.goal,
      relatedRequirements: "Inserted into the CanvasSession planner stream.",
      relatedDesign: "Hermes continues the CanvasSession planner identity through workflow-card tools.",
      relatedTasks: "createWorkflowCard, updateWorkflowCard, deleteWorkflowCard",
      dependencies: base?.context.dependencies ?? [],
      constraints: [
        `Project: ${input.options.projectName}`,
        `Hermes planner session: ${input.plannerSessionId}`,
        "Renderer does not spawn local processes.",
        "Hermes CLI transport is one-shot fallback until native resume is verified.",
        "Completion follows RunEvidence, not agent prose.",
      ],
    },
  };
}

function plannerRunId(sessionId: string, plannerNodeId: string, now: string): string {
  const suffix = now.replace(/\D/g, "").slice(0, 14) || "input";
  return `run-${sessionId}-${plannerNodeId}-${suffix}`;
}
