import type { CanvasNode, CanvasSession } from "@skyturn/project-core";

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

  const id = nextNodeId(session.nodes);
  const node: CanvasNode = {
    id,
    title: brief.slice(0, 56),
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
      meta: ["workflow-card-tools", id],
    },
    position: { x: 180 + session.nodes.length * 150, y: 360 },
    runId: `run-${session.id}-${id}`,
    changesetId: `changeset-${session.id}-${id}`,
    output: ["Requirement sent to Hermes workflow-card planner."],
    worktree: {
      path: ".",
      branchName: `skyturn/${session.id}/${id}`,
      baseCommit: "pending-base-commit",
    },
    context: {
      brief,
      sessionGoal: session.goal,
      relatedRequirements: "Inserted from the workflow input box.",
      relatedDesign: "Hermes will decompose this into workflow-card tool calls.",
      relatedTasks: "createWorkflowCard, updateWorkflowCard, deleteWorkflowCard",
      dependencies: [],
      constraints: [
        `Project: ${options.projectName}`,
        "Renderer does not spawn local processes.",
        "Completion follows RunEvidence, not agent prose.",
      ],
    },
  };

  return {
    node,
    session: {
      ...session,
      nodes: [...session.nodes, node],
      activeNodeId: node.id,
      updatedAt: options.now,
    },
  };
}

function nextNodeId(nodes: CanvasNode[]): string {
  const used = new Set(nodes.map((node) => node.id));
  for (let index = nodes.length + 1; ; index += 1) {
    const id = `node-input-${index}`;
    if (!used.has(id)) return id;
  }
}
