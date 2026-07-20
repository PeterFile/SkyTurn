import {
  PLAN_MARKDOWN_MAX_LENGTH,
  makeHermesPlanConversationId,
  makeHermesPlannerSessionId,
  normalizeSessionTarget,
  type AgentKind,
  type CanvasEdge,
  type CanvasNode,
  type CanvasNodeDisplay,
  type CanvasSession,
  type NodeRuntimeState,
  type PlanMarkdown,
  type PlanOperation,
  type PlanStage,
  type PlanStageState,
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

export interface CreatePlanSessionOptions {
  randomUUID?: () => string;
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
    "## Requirements Document",
    "",
    "### Introduction",
    "Describe the purpose and scope of this task.",
    "",
    "### Glossary",
    "- **Term**: Definition",
    "",
    "### Requirements (EARS)",
    "- **While** [precondition], **when** [trigger], **the system shall** [response].",
    "- **If** [condition], **then the system shall** [response].",
  ].join("\n"),
  design: [
    "## Design",
    "",
    "### Architecture & Components",
    "- Describe structural changes and components involved.",
    "",
    "### Correctness Properties",
    "- State what must hold true (e.g., invariants, invariants across transitions).",
    "",
    "### Testing Strategy",
    "- Outline how the correctness properties will be verified.",
  ].join("\n"),
  tasks: [
    "## Tasks",
    "",
    "### Implementation Checklist",
    "- [ ] Task 1 (ref: Requirement 1)",
    "- [ ] Task 2 (ref: Requirement 2)",
  ].join("\n"),
};

const emptyPlan: PlanMarkdown = {
  requirements: "",
  design: "",
  tasks: "",
};

const maxPlanGoalLength = 100_000;
const maxApprovedPlanWorkflowInputLength = maxPlanGoalLength + PLAN_MARKDOWN_MAX_LENGTH * 3 + 256;

function pendingPlanStage(): PlanStageState {
  return {
    status: "pending",
    accepted: false,
    draft: "",
    error: null,
    runId: null,
    lastRunId: null,
    operation: null,
    checkpoints: [],
  };
}

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

export function createPlanSession(
  input: CreateSessionInput,
  options: CreatePlanSessionOptions = {},
): PlanSession {
  const sessionId = `${makeSessionId("plan", input.createdAt)}-${(options.randomUUID ?? defaultRandomUUID)()}`;
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
    plan: { ...emptyPlan },
    stateVersion: 0,
    activeStage: "requirements",
    plannerConversationId: makeHermesPlanConversationId(sessionId),
    conversationStarted: false,
    stages: {
      requirements: pendingPlanStage(),
      design: pendingPlanStage(),
      tasks: pendingPlanStage(),
    },
    nodes: [],
    edges: [],
    activeNodeId: null,
  };
}

function defaultRandomUUID(): string {
  return globalThis.crypto.randomUUID();
}

export interface BuildPlanPromptInput {
  operation: PlanOperation;
  stage: PlanStage;
  goal: string;
  projectContext: string;
  requirements: string;
  design: string;
  currentMarkdown?: string;
  instruction?: string;
}

export function buildPlanPrompt(input: BuildPlanPromptInput): string {
  const stageName = stageLabel(input.stage);
  const rules = [
    "You are planning only. Do not modify files or execute commands.",
    `Return only Markdown for the complete ${stageName} document.`,
    "Do not wrap the document in a code fence and do not add commentary.",
  ];

  const context = [
    ...rules,
    `Goal:\n${input.goal}`,
    `Project context:\n${input.projectContext}`,
  ];
  if (input.stage !== "requirements") context.push(`Completed Requirements:\n${input.requirements}`);
  if (input.stage === "tasks") context.push(`Completed Design:\n${input.design}`);
  if (input.operation === "revise") {
    context.push(
      `Revise the ${stageName} stage and return a full replacement Markdown document for that stage only.`,
      `Current completed Markdown:\n${input.currentMarkdown ?? ""}`,
      `User revision instruction:\n${input.instruction ?? ""}`,
    );
  } else if (input.stage === "requirements") {
    context.push("Produce Requirements only.");
  } else if (input.stage === "design") {
    context.push("Produce Design only.");
  } else {
    context.push("Produce Tasks only.");
  }
  return context.join("\n\n");
}

export function formatApprovedPlanWorkflowInput(session: PlanSession): string {
  if (
    !session.goal.trim() ||
    session.goal.length > maxPlanGoalLength ||
    (["requirements", "design", "tasks"] as const).some((stage) => (
      session.stages[stage].status !== "ready" ||
      !session.stages[stage].accepted ||
      session.stages[stage].runId !== null ||
      !session.plan[stage].trim() ||
      session.plan[stage].length > PLAN_MARKDOWN_MAX_LENGTH
    ))
  ) {
    throw new Error("Approved Plan is invalid.");
  }
  const formatted = [
    "# Approved Plan",
    "",
    "## Goal",
    session.goal,
    "",
    "## Requirements",
    session.plan.requirements,
    "",
    "## Design",
    session.plan.design,
    "",
    "## Tasks",
    session.plan.tasks,
  ].join("\n");
  if (formatted.length > maxApprovedPlanWorkflowInputLength) {
    throw new Error("Approved Plan is invalid.");
  }
  return formatted;
}

function stageLabel(stage: PlanStage): string {
  return stage[0].toUpperCase() + stage.slice(1);
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
