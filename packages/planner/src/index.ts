import type {
  AgentKind,
  CanvasEdge,
  CanvasNode,
  CanvasSession,
  PlanMarkdown,
  PlanSession,
} from "@skyturn/project-core";

interface CreateSessionInput {
  projectId: string;
  goal: string;
  createdAt: string;
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
    title: "Orchestrate task graph",
    agent: "hermes",
    progress: "Mapping graph",
    brief: "Hermes converts the request into executable task nodes.",
    dependencies: [],
    position: { x: 80, y: 110 },
  },
  {
    id: "node-2",
    title: "Implement app slice",
    agent: "codex",
    progress: "Waiting for graph",
    brief: "Codex implements the smallest runnable vertical slice.",
    dependencies: ["node-1"],
    position: { x: 400, y: 40 },
  },
  {
    id: "node-3",
    title: "Review plan coverage",
    agent: "claude-code",
    progress: "Pending",
    brief: "ClaudeCode reviews whether scope matches the session goal.",
    dependencies: ["node-1"],
    position: { x: 400, y: 210 },
  },
  {
    id: "node-4",
    title: "Verify worktree evidence",
    agent: "gemini",
    progress: "Pending",
    brief: "Gemini checks changes, tests, and completion evidence.",
    dependencies: ["node-2", "node-3"],
    position: { x: 730, y: 125 },
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
    position: { x: 100, y: 120 },
  },
  {
    id: "node-2",
    title: "Implement canvas shell",
    agent: "codex",
    progress: "Pending",
    brief: "Build the Electron React canvas-first app shell.",
    dependencies: ["node-1"],
    position: { x: 430, y: 120 },
  },
  {
    id: "node-3",
    title: "Verify completion evidence",
    agent: "gemini",
    progress: "Pending",
    brief: "Tie completion to git/worktree, tests, and concrete evidence.",
    dependencies: ["node-2"],
    position: { x: 760, y: 120 },
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
  return {
    id: sessionId,
    projectId: input.projectId,
    title: shortTitle(input.goal),
    goal: input.goal,
    mode: "plan",
    kind: "plan",
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
    },
    sessionId: session.id,
    mode: "plan",
    seeds: planSeeds,
    title: session.title,
  });
}

function createCanvasSession({
  input,
  sessionId,
  mode,
  seeds,
  title,
}: {
  input: CreateSessionInput;
  sessionId: string;
  mode: "fast" | "plan";
  seeds: TaskSeed[];
  title: string;
}): CanvasSession {
  const nodes = seeds.map((seed, index) =>
    createNode({
      seed,
      input,
      sessionId,
      status: index === 0 ? "running" : "pending",
      relatedTasks: mode === "plan" ? plan.tasks : "Mock Hermes graph",
    }),
  );
  return {
    id: sessionId,
    projectId: input.projectId,
    title,
    goal: input.goal,
    mode,
    kind: "canvas",
    createdAt: input.createdAt,
    updatedAt: input.createdAt,
    nodes,
    edges: createEdges(seeds),
    activeNodeId: nodes[0]?.id ?? null,
  };
}

function createNode({
  seed,
  input,
  sessionId,
  status,
  relatedTasks,
}: {
  seed: TaskSeed;
  input: CreateSessionInput;
  sessionId: string;
  status: CanvasNode["status"];
  relatedTasks: string;
}): CanvasNode {
  return {
    id: seed.id,
    title: seed.title,
    agent: seed.agent,
    progress: seed.progress,
    status,
    position: seed.position,
    runId: `run-${sessionId}-${seed.id}`,
    changesetId: `changeset-${sessionId}-${seed.id}`,
    output: seed.agent === "hermes" ? ["Hermes accepted the session goal."] : [],
    worktree: {
      path: `../${input.projectId}.worktrees/session-${sessionId}-task-${seed.id}`,
      branchName: `skyturn/${sessionId}/${seed.id}`,
      baseCommit: "mock-base-commit",
    },
    context: {
      brief: seed.brief,
      sessionGoal: input.goal,
      relatedRequirements: plan.requirements,
      relatedDesign: plan.design,
      relatedTasks,
      dependencies: seed.dependencies,
      constraints: [
        "No file tabs.",
        "No global Agent Console.",
        "Completion requires concrete verification evidence.",
      ],
    },
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
