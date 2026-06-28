import {
  makeHermesPlannerSessionId,
  normalizeSessionTarget,
  type AgentKind,
  type CanvasEdge,
  type CanvasNode,
  type CanvasNodeDisplay,
  type CanvasSession,
  type NodeRuntimeState,
  type PlanMarkdown,
  type PlanSession,
  type SessionTarget,
  type WorktreeMetadata,
} from "@skyturn/project-core";

interface CreateSessionInput {
  projectId: string;
  goal: string;
  createdAt: string;
  target?: SessionTarget;
}

interface TaskSeed {
  id: string;
  title: string;
  agent: AgentKind;
  progress: string;
  brief: string;
  dependencies: string[];
  position: {
    x: number;
    y: number;
  };
  status?: CanvasNode["status"];
  runtime?: NodeRuntimeState;
  display?: CanvasNodeDisplay;
}

const plan: PlanMarkdown = {
  requirements: [
    "## Requirements",
    "",
    "- Keep the workspace canvas-first.",
    "- Use Hermes as the orchestrator boundary.",
    "- Keep node details inside Output, Changes, and Context.",
  ].join("\n"),
  design: [
    "## Design",
    "",
    "- Electron main process owns filesystem, git, processes, and editor launch.",
    "- React renderer owns tabs, canvas, modals, and interaction state.",
    "- Agent CLIs are accessed through adapter interfaces.",
  ].join("\n"),
  tasks: [
    "## Tasks",
    "",
    "- [ ] Confirm requirements",
    "- [ ] Implement canvas shell",
    "- [ ] Verify completion evidence",
  ].join("\n"),
};

const fastSeeds: TaskSeed[] = [
  {
    id: "node-1",
    title: "Plan workflow cards",
    agent: "hermes",
    progress: "Calling workflow-card tools",
    brief: "Decompose the user goal into workflow-card tool calls.",
    dependencies: [],
    position: { x: 72, y: 148 },
    status: "running",
    runtime: {
      phase: "Planning",
      message: "正在拆解任务",
      action: "calling workflow-card tools",
    },
    display: {
      agentLabel: "Hermes",
      meta: ["workflow-card-tools", "TSK-0001"],
    },
  },
];

const planSeeds: TaskSeed[] = [
  {
    id: "node-1",
    title: "Confirm requirements",
    agent: "hermes",
    progress: "Ready",
    brief: "Confirm the rendered requirements before execution.",
    dependencies: [],
    position: { x: 72, y: 148 },
  },
  {
    id: "node-2",
    title: "Implement canvas shell",
    agent: "codex",
    progress: "Pending",
    brief: "Build the Electron React canvas-first app shell.",
    dependencies: ["node-1"],
    position: { x: 640, y: 148 },
  },
  {
    id: "node-3",
    title: "Verify completion evidence",
    agent: "gemini",
    progress: "Pending",
    brief: "Tie completion to git/worktree, tests, and concrete evidence.",
    dependencies: ["node-2"],
    position: { x: 1208, y: 148 },
  },
];

export function createFastCanvasSession(input: CreateSessionInput): CanvasSession {
  const sessionId = makeSessionId("fast", input.createdAt);
  return createCanvasSession({
    input,
    sessionId,
    mode: "fast",
    seeds: fastSeeds,
    title: shortTitle(input.goal),
  });
}

export function createPlanSession(input: CreateSessionInput): PlanSession {
  const sessionId = makeSessionId("plan", input.createdAt);
  const target = normalizeSessionTarget(input.target);
  return {
    id: sessionId,
    projectId: input.projectId,
    title: shortTitle(input.goal),
    goal: input.goal,
    mode: "plan",
    kind: "plan",
    target,
    createdAt: input.createdAt,
    updatedAt: input.createdAt,
    plan,
    nodes: [],
    edges: [],
    activeNodeId: null,
  };
}

export function convertPlanToCanvas(session: PlanSession): CanvasSession {
  return createCanvasSession({
    input: {
      projectId: session.projectId,
      goal: session.goal,
      createdAt: session.createdAt,
      target: session.target,
    },
    sessionId: session.id,
    mode: "plan",
    seeds: planSeeds,
    title: session.title,
    plan: session.plan,
  });
}

function createCanvasSession({
  input,
  sessionId,
  mode,
  seeds,
  title,
  plan: planMarkdown = plan,
}: {
  input: CreateSessionInput;
  sessionId: string;
  mode: "fast" | "plan";
  seeds: TaskSeed[];
  title: string;
  plan?: PlanMarkdown;
}): CanvasSession {
  const target = normalizeSessionTarget(input.target);
  const nodes = seeds.map((seed, index) =>
    createNode({
      seed,
      input,
      sessionId,
      target,
      status: seed.status ?? (index === 0 ? "running" : "pending"),
      plan: planMarkdown,
      relatedTasks: mode === "plan" ? planMarkdown.tasks : "Mock Hermes graph",
    }),
  );
  return {
    id: sessionId,
    projectId: input.projectId,
    title,
    goal: input.goal,
    mode,
    kind: "canvas",
    target,
    hermesPlannerSessionId: makeHermesPlannerSessionId(sessionId),
    plannerNodeId:
      nodes.find((node) => node.agent === "hermes" && node.context.dependencies.length === 0)?.id ??
      nodes[0]?.id ??
      "node-1",
    createdAt: input.createdAt,
    updatedAt: input.createdAt,
    nodes,
    edges: createEdges(seeds),
    activeNodeId: nodes.find((node) => node.status === "running")?.id ?? nodes[0]?.id ?? null,
  };
}

function createNode({
  seed,
  input,
  sessionId,
  target,
  status,
  plan: planMarkdown,
  relatedTasks,
}: {
  seed: TaskSeed;
  input: CreateSessionInput;
  sessionId: string;
  target: SessionTarget;
  status: CanvasNode["status"];
  plan: PlanMarkdown;
  relatedTasks: string;
}): CanvasNode {
  return {
    id: seed.id,
    title: seed.title,
    agent: seed.agent,
    progress: seed.progress,
    runtime: seed.runtime,
    display: seed.display,
    status,
    position: seed.position,
    runId: `run-${sessionId}-${seed.id}`,
    changesetId: `changeset-${sessionId}-${seed.id}`,
    output: seed.agent === "hermes" ? ["Hermes accepted the session goal."] : [],
    worktree: worktreeForNode(target, sessionId, seed.id),
    context: {
      brief: seed.brief,
      sessionGoal: input.goal,
      relatedRequirements: planMarkdown.requirements,
      relatedDesign: planMarkdown.design,
      relatedTasks:
        seed.agent === "hermes" ? "createWorkflowCard, updateWorkflowCard, deleteWorkflowCard" : relatedTasks,
      dependencies: seed.dependencies,
      constraints: [
        "No file tabs.",
        "No global Agent Console.",
        "Completion requires concrete verification evidence.",
      ],
    },
  };
}

function worktreeForNode(target: SessionTarget, sessionId: string, nodeId: string): WorktreeMetadata {
  if (target.executionTarget === "new_worktree") {
    return {
      path: ".",
      branchName: target.selectedBranch,
      baseCommit: target.baseRef ?? target.selectedBranch,
      executionTarget: target.executionTarget,
      selectedBranch: target.selectedBranch,
      ...(target.baseRef ? { baseRef: target.baseRef } : {}),
      baselineRef: target.baseRef ?? target.selectedBranch,
      worktreeId: `worktree-${sessionId}-${nodeId}`,
      variantId: `variant-${sessionId}-${nodeId}`,
    };
  }
  return {
    path: ".",
    branchName: target.selectedBranch,
    baseCommit: target.selectedBranch,
    executionTarget: target.executionTarget,
    selectedBranch: target.selectedBranch,
    baselineRef: target.selectedBranch,
  };
}

function createEdges(seeds: TaskSeed[]): CanvasEdge[] {
  return seeds.flatMap((seed) =>
    seed.dependencies.map((dependency) => ({
      id: `edge-${dependency}-${seed.id}`,
      source: dependency,
      target: seed.id,
    })),
  );
}

function makeSessionId(prefix: string, createdAt: string): string {
  const suffix = createdAt.replace(/\D/g, "").slice(0, 12) || "session";
  return `${prefix}-${suffix}`;
}

function shortTitle(goal: string): string {
  return goal.trim().slice(0, 48) || "Untitled session";
}
