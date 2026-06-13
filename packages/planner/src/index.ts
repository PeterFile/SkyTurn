import type {
  AgentKind,
  CanvasEdge,
  CanvasNode,
  CanvasNodeDisplay,
  CanvasSession,
  NodeRuntimeState,
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
    title: "Ingest Customer Data",
    agent: "hermes",
    progress: "waiting for dependency",
    brief: "Data agent waits for upstream data readiness before ingesting customer records.",
    dependencies: [],
    position: { x: 20, y: 96 },
    status: "pending",
    runtime: {
      phase: "Queued",
      message: "正在等待调度",
      action: "waiting for dependency",
    },
    display: {
      agentLabel: "Data Agent",
      meta: ["main/data-ingest", "TSK-1024"],
    },
  },
  {
    id: "node-2",
    title: "Analyze Customer Intent",
    agent: "codex",
    progress: "analyzing requirements.json",
    brief: "NLP agent analyzes customer intent from the normalized requirements input.",
    dependencies: ["node-1"],
    position: { x: 440, y: 96 },
    status: "running",
    runtime: {
      phase: "Think",
      message: "正在思考策略",
      action: "analyzing requirements.json",
    },
    display: {
      agentLabel: "NLP Agent",
      meta: ["feat/intent-nlp", "TSK-1025"],
    },
  },
  {
    id: "node-3",
    title: "Fetch Knowledge Context",
    agent: "gemini",
    progress: "fetching repo context again",
    brief: "Knowledge agent retries context retrieval with bounded backoff.",
    dependencies: ["node-2"],
    position: { x: 860, y: 96 },
    status: "retrying",
    runtime: {
      phase: "Retrying",
      message: "正在重新尝试",
      action: "fetching repo context again",
    },
    display: {
      agentLabel: "Knowledge Agent",
      meta: ["feat/knowledge-retrieval", "TSK-1026"],
    },
  },
  {
    id: "node-4",
    title: "Generate Response",
    agent: "claude-code",
    progress: "final output verified",
    brief: "LLM agent generates and verifies the response output.",
    dependencies: ["node-2"],
    position: { x: 250, y: 340 },
    status: "completed",
    runtime: {
      phase: "Completed",
      message: "已完成验证",
      action: "final output verified",
    },
    display: {
      agentLabel: "LLM Agent",
      meta: ["feat/response-gen", "TSK-1027"],
    },
  },
  {
    id: "node-5",
    title: "Send Response",
    agent: "openclaw",
    progress: "delivery timeout persisted",
    brief: "Delivery agent records a persistent timeout that requires manual handling.",
    dependencies: ["node-2"],
    position: { x: 700, y: 340 },
    status: "failed",
    runtime: {
      phase: "Failed",
      message: "等待人工处理",
      action: "delivery timeout persisted",
    },
    display: {
      agentLabel: "Delivery Agent",
      meta: ["fix/delivery-timeout", "TSK-1028"],
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
      status: seed.status ?? (index === 0 ? "running" : "pending"),
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
    activeNodeId: nodes.find((node) => node.status === "running")?.id ?? nodes[0]?.id ?? null,
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
    runtime: seed.runtime,
    display: seed.display,
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
