import { app, BrowserWindow, dialog, ipcMain, shell } from "electron";
import fs from "node:fs/promises";
import path from "node:path";

import {
  DEVFLOW_DIRECTORIES,
  DEVFLOW_FILES,
  defaultDevflowFileContent,
} from "@skyturn/project-memory";
import {
  normalizeWorkflowIpcError,
  rejectMissingWorkflowProjectionNode,
  workflowIpcError,
  workflowStartInputError,
} from "./workflowIpcContracts";

interface OpenProjectResult {
  canceled: boolean;
  project?: {
    name: string;
    rootPath: string;
    devflowPath: string;
  };
}

interface StartAgentRunInput {
  projectRoot: string;
  sessionId?: string;
  nodeId?: string;
  [key: string]: unknown;
}

interface WorkflowSessionCreateInput {
  id?: unknown;
  sessionId?: unknown;
  projectId?: unknown;
  title?: unknown;
  goal?: unknown;
  mode?: unknown;
  plannerProfile?: unknown;
  transport?: unknown;
  processId?: unknown;
  opaqueHandle?: unknown;
  recoveryReason?: unknown;
}

interface WorkflowAppendUserInput {
  sessionId?: unknown;
  inputId?: unknown;
  text?: unknown;
  idempotencyKey?: unknown;
  now?: unknown;
}

interface WorkflowRecordRunResultInput {
  sessionId?: unknown;
  laneId?: unknown;
  segmentId?: unknown;
  runId?: unknown;
  agentKind?: unknown;
  now?: unknown;
}

interface FlowProjectionLike {
  projectionNodes: Array<{
    id: string;
    laneId?: string;
    decisionId?: string;
    executable: boolean;
  }>;
}

const RUN_PROTOCOL_VERSION = 1;
const openedProjectRoots = new Set<string>();
let agentBridge: AgentBridgeHost | null = null;
const workflowStores = new Map<string, WorkflowStoreHost>();

interface AgentBridgeHost {
  discoverAgents(): Promise<unknown[]>;
  listRuns(): unknown[];
  onRunEvent(listener: (event: unknown) => void): () => void;
  startRun(input: unknown): Promise<unknown>;
  send(runId: string, message: string): Promise<void>;
  cancelRun(runId: string, reason: string): Promise<unknown>;
  loadEvents(projectRoot: string, runId: string): Promise<unknown[]>;
  getEvidence(projectRoot: string, runId: string): Promise<unknown>;
}

interface WorkflowStoreHost {
  createWorkflowSession(input: unknown): unknown;
  appendUserInput(input: unknown): unknown;
  buildLedgerSummary(sessionId: string): unknown;
  appendWorkflowEvent(input: unknown): unknown;
  applyWorkflowIntent(intent: unknown, now: string): unknown;
  scheduleReadyLanes(sessionId: string, input: unknown): unknown;
  recordRunResult(input: unknown): unknown;
  materializeFlowProjection(sessionId: string): unknown;
  materializeCanvasSession(sessionId: string): unknown;
  listEvents(sessionId: string): unknown[];
  close(): void;
}

async function createMainWindow(): Promise<void> {
  const mainWindow = new BrowserWindow({
    width: 1320,
    height: 860,
    minWidth: 980,
    minHeight: 680,
    title: "SkyTurn",
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      preload: path.join(__dirname, "preload.js"),
    },
  });

  if (process.env.VITE_DEV_SERVER_URL) {
    await mainWindow.loadURL(process.env.VITE_DEV_SERVER_URL);
    return;
  }

  await mainWindow.loadFile(path.join(__dirname, "..", "..", "dist", "index.html"));
}

ipcMain.handle("project:open", async (): Promise<OpenProjectResult> => {
  const result = await dialog.showOpenDialog({
    title: "Open Project",
    properties: ["openDirectory"],
  });

  if (result.canceled || result.filePaths.length === 0) {
    return { canceled: true };
  }

  const rootPath = result.filePaths[0];
  openedProjectRoots.add(rootPath);
  return {
    canceled: false,
    project: {
      name: path.basename(rootPath),
      rootPath,
      devflowPath: path.join(rootPath, ".devflow"),
    },
  };
});

ipcMain.handle("project:initDevflow", async (_event, rootPath: string) => {
  assertKnownProjectRoot(rootPath);
  const projectName = path.basename(rootPath);
  for (const directory of DEVFLOW_DIRECTORIES) {
    await fs.mkdir(path.join(rootPath, directory), { recursive: true });
  }
  for (const file of DEVFLOW_FILES) {
    const target = path.join(rootPath, file);
    try {
      await fs.access(target);
    } catch {
      await fs.writeFile(target, defaultDevflowFileContent(file, projectName), "utf8");
    }
  }
  return { ok: true, devflowPath: path.join(rootPath, ".devflow") };
});

ipcMain.handle("editor:openWorktree", async (_event, editor: string, worktreePath: string) => {
  if (editor === "finder") {
    const error = await shell.openPath(worktreePath);
    return { ok: !error, message: error || "Opened worktree path." };
  }
  return {
    ok: true,
    message: `${editor} launch is mocked in the MVP; target: ${worktreePath}`,
  };
});

ipcMain.handle("agent:discover", async () => {
  const bridge = await getAgentBridge();
  return {
    protocolVersion: RUN_PROTOCOL_VERSION,
    agents: await bridge.discoverAgents(),
  };
});

ipcMain.handle("agent:health", async () => {
  const bridge = await getAgentBridge();
  return {
    protocolVersion: RUN_PROTOCOL_VERSION,
    agents: await bridge.discoverAgents(),
  };
});

ipcMain.handle("run:start", async (_event, input: StartAgentRunInput) => {
  assertKnownProjectRoot(input.projectRoot);
  await assertExecutableStartInput(input);
  const bridge = await getAgentBridge();
  const run = await bridge.startRun(input);
  return { protocolVersion: RUN_PROTOCOL_VERSION, run };
});

ipcMain.handle("run:send", async (_event, runId: string, message: string) => {
  const bridge = await getAgentBridge();
  await bridge.send(runId, message);
  return { protocolVersion: RUN_PROTOCOL_VERSION, ok: true };
});

ipcMain.handle("run:cancel", async (_event, runId: string, reason: string) => {
  const bridge = await getAgentBridge();
  const evidence = await bridge.cancelRun(runId, reason);
  return { protocolVersion: RUN_PROTOCOL_VERSION, evidence };
});

ipcMain.handle("run:events", async (_event, projectRoot: string, runId: string) => {
  assertKnownProjectRoot(projectRoot);
  const bridge = await getAgentBridge();
  return {
    protocolVersion: RUN_PROTOCOL_VERSION,
    events: await bridge.loadEvents(projectRoot, runId),
  };
});

ipcMain.handle("run:list", async () => {
  const bridge = await getAgentBridge();
  return { protocolVersion: RUN_PROTOCOL_VERSION, runs: bridge.listRuns() };
});

ipcMain.handle("run:evidence", async (_event, projectRoot: string, runId: string) => {
  assertKnownProjectRoot(projectRoot);
  const bridge = await getAgentBridge();
  return {
    protocolVersion: RUN_PROTOCOL_VERSION,
    evidence: await bridge.getEvidence(projectRoot, runId),
  };
});

ipcMain.handle("workflow:createSession", async (_event, projectRoot: string, input: WorkflowSessionCreateInput) => {
  assertKnownProjectRoot(projectRoot);
  const sessionId = assertWorkflowSessionId(input.id ?? input.sessionId);
  const store = await getWorkflowStore(projectRoot);
  const session = store.createWorkflowSession({
    id: sessionId,
    projectId: optionalText(input.projectId) ?? path.basename(projectRoot),
    title: optionalText(input.title) ?? "Workflow session",
    goal: requireText(input.goal, "workflow session goal"),
    mode: input.mode === "plan" ? "plan" : "fast",
    plannerProfile: optionalText(input.plannerProfile) ?? "default",
    transport: normalizeHermesTransport(input.transport),
    processId: typeof input.processId === "number" ? input.processId : undefined,
    opaqueHandle: optionalText(input.opaqueHandle) ?? `skyturn-ipc:${sessionId}`,
    recoveryReason: optionalText(input.recoveryReason),
    now: optionalText(readField(input, "now")) ?? new Date().toISOString(),
  });
  return {
    protocolVersion: RUN_PROTOCOL_VERSION,
    session,
    projection: store.materializeFlowProjection(sessionId),
    canvasSession: store.materializeCanvasSession(sessionId),
  };
});

ipcMain.handle("workflow:appendUserInput", async (_event, projectRoot: string, input: WorkflowAppendUserInput) => {
  assertKnownProjectRoot(projectRoot);
  const sessionId = assertWorkflowSessionId(input.sessionId);
  const store = await getWorkflowStore(projectRoot);
  const event = store.appendUserInput({
    sessionId,
    inputId: optionalText(input.inputId) ?? optionalText(input.idempotencyKey) ?? `input-${Date.now()}`,
    text: requireText(input.text, "workflow user input"),
    now: optionalText(input.now) ?? new Date().toISOString(),
  });
  broadcastWorkflowProjection(projectRoot, sessionId, store);
  return {
    protocolVersion: RUN_PROTOCOL_VERSION,
    event,
    ledger: store.buildLedgerSummary(sessionId),
    projection: store.materializeFlowProjection(sessionId),
    canvasSession: store.materializeCanvasSession(sessionId),
  };
});

ipcMain.handle("workflow:ledger", async (_event, projectRoot: string, sessionId: string) => {
  assertKnownProjectRoot(projectRoot);
  const workflowSessionId = assertWorkflowSessionId(sessionId);
  const store = await getWorkflowStore(projectRoot);
  return {
    protocolVersion: RUN_PROTOCOL_VERSION,
    ledger: store.buildLedgerSummary(workflowSessionId),
  };
});

ipcMain.handle("changeset:get", async (_event, projectRoot: string, node: unknown) => {
  assertKnownProjectRoot(projectRoot);
  const { createGitChangesetService } = await import("@skyturn/git-worktree/node");
  const realProjectRoot = await fs.realpath(projectRoot);
  const service = createGitChangesetService({ repoRoot: realProjectRoot });
  const normalizedNode = await normalizeChangesetNodeForProject(realProjectRoot, node) as Parameters<typeof service.getChangeset>[0];
  const changeset = await service.getChangeset(normalizedNode);
  return { protocolVersion: RUN_PROTOCOL_VERSION, changeset };
});

ipcMain.handle("workflow:applyIntent", async (_event, projectRoot: string, intent: { sessionId?: unknown }) => {
  assertKnownProjectRoot(projectRoot);
  const sessionId = assertWorkflowSessionId(intent?.sessionId);
  const store = await getWorkflowStore(projectRoot);
  const result = store.applyWorkflowIntent(intent, new Date().toISOString());
  const projection = store.materializeFlowProjection(sessionId);
  broadcastWorkflowProjection(projectRoot, sessionId, store);
  return {
    protocolVersion: RUN_PROTOCOL_VERSION,
    result,
    projection,
    canvasSession: store.materializeCanvasSession(sessionId),
  };
});

ipcMain.handle("workflow:scheduleReady", async (_event, projectRoot: string, sessionIdOrInput: unknown, maybeInput?: unknown) => {
  assertKnownProjectRoot(projectRoot);
  const workflowSessionId = typeof sessionIdOrInput === "string"
    ? assertWorkflowSessionId(sessionIdOrInput)
    : assertWorkflowSessionId(readField(sessionIdOrInput, "sessionId"));
  const input = typeof sessionIdOrInput === "string" ? maybeInput : sessionIdOrInput;
  const store = await getWorkflowStore(projectRoot);
  const result = store.scheduleReadyLanes(workflowSessionId, {
    ...(isRecord(input) ? input : {}),
    now: optionalText(readField(input, "now")) ?? new Date().toISOString(),
  });
  broadcastWorkflowProjection(projectRoot, workflowSessionId, store);
  return {
    protocolVersion: RUN_PROTOCOL_VERSION,
    result,
    projection: store.materializeFlowProjection(workflowSessionId),
    canvasSession: store.materializeCanvasSession(workflowSessionId),
  };
});

ipcMain.handle("workflow:recordRunResult", async (_event, projectRoot: string, input: WorkflowRecordRunResultInput) => {
  assertKnownProjectRoot(projectRoot);
  const sessionId = assertWorkflowSessionId(input.sessionId);
  const laneId = assertRequiredText(input.laneId, "Workflow laneId is required.");
  const segmentId = assertRequiredText(input.segmentId, "Workflow segmentId is required.");
  const runId = assertRequiredText(input.runId, "Workflow runId is required.");
  const agentKind = assertWorkflowAgentKind(input.agentKind);
  const now = typeof input.now === "string" && input.now.trim() ? input.now : new Date().toISOString();
  const bridge = await getAgentBridge();
  const [events, evidence] = await Promise.all([
    bridge.loadEvents(projectRoot, runId),
    bridge.getEvidence(projectRoot, runId),
  ]);
  const store = await getWorkflowStore(projectRoot);
  const projection = store.recordRunResult({
    sessionId,
    laneId,
    segmentId,
    runId,
    agentKind,
    outputSummary: summarizeRunOutput(events),
    evidence,
    now,
  });
  broadcastWorkflowProjection(projectRoot, sessionId, store);
  return {
    protocolVersion: RUN_PROTOCOL_VERSION,
    projection,
    canvasSession: store.materializeCanvasSession(sessionId),
  };
});

ipcMain.handle("workflow:projection", workflowHandler(async (projectRoot: string, sessionId: string) => {
  assertKnownProjectRoot(projectRoot);
  const workflowSessionId = assertWorkflowSessionId(sessionId);
  const store = await getWorkflowStore(projectRoot);
  return {
    protocolVersion: RUN_PROTOCOL_VERSION,
    projection: store.materializeFlowProjection(workflowSessionId),
    canvasSession: store.materializeCanvasSession(workflowSessionId),
  };
}));

ipcMain.handle("workflow:events", workflowHandler(async (projectRoot: string, sessionId: string) => {
  assertKnownProjectRoot(projectRoot);
  const workflowSessionId = assertWorkflowSessionId(sessionId);
  const store = await getWorkflowStore(projectRoot);
  return {
    protocolVersion: RUN_PROTOCOL_VERSION,
    events: store.listEvents(workflowSessionId)
      .filter(isWorkflowEventRecord)
      .map(redactWorkflowEventForRenderer),
  };
}));

ipcMain.handle("workflow:userDecision:answer", workflowHandler(async (projectRoot: string, input: unknown) => {
  assertKnownProjectRoot(projectRoot);
  const sessionId = requireText(readField(input, "sessionId"), "workflow session id");
  const decisionId = requireText(readField(input, "decisionId"), "decision id");
  const selectedOption = requireText(readField(input, "selectedOption"), "selected option");
  const action = normalizeUserDecisionAction(readField(input, "action"));
  const payload = {
    decisionId,
    selectedOption,
    action,
    ...(optionalText(readField(input, "comment")) ? { comment: optionalText(readField(input, "comment")) } : {}),
    ...(optionalText(readField(input, "targetLaneId")) ? { targetLaneId: optionalText(readField(input, "targetLaneId")) } : {}),
    ...(optionalText(readField(input, "targetSegmentId")) ? { targetSegmentId: optionalText(readField(input, "targetSegmentId")) } : {}),
  };
  const store = await getWorkflowStore(projectRoot);
  const event = store.appendWorkflowEvent({
    sessionId,
    kind: "workflow.user_decision.answered",
    source: "renderer",
    idempotencyKey: `decision:${decisionId}:answered`,
    payload,
    now: new Date().toISOString(),
  });
  const projection = store.materializeFlowProjection(sessionId);
  broadcastWorkflowProjection(projectRoot, sessionId, store);
  return {
    protocolVersion: RUN_PROTOCOL_VERSION,
    event,
    projection,
    canvasSession: store.materializeCanvasSession(sessionId),
  };
}));

ipcMain.handle("workflow:worktree:create", workflowHandler(async (projectRoot: string, input: unknown) => {
  assertKnownProjectRoot(projectRoot);
  const sessionId = requireText(readField(input, "sessionId"), "workflow session id");
  const variantId = requireText(readField(input, "variantId"), "workflow variant id");
  const baseCommit = requireText(readField(input, "baseCommit"), "worktree base commit");
  const parentLaneId = requireText(readField(input, "parentLaneId"), "parent lane id");
  const parentSegmentId = optionalText(readField(input, "parentSegmentId"));
  const repoRoot = path.resolve(optionalText(readField(input, "repoRoot")) ?? projectRoot);
  if (repoRoot !== path.resolve(projectRoot)) throw workflowIpcError("UNKNOWN_PROJECT", "Worktree repoRoot must match the open project root.");
  const worktree = managedWorktreeIdentity(projectRoot, {
    sessionId,
    variantId,
    baseCommit,
    parentLaneId,
    ...(parentSegmentId ? { parentSegmentId } : {}),
  });
  const store = await getWorkflowStore(projectRoot);
  const event = store.appendWorkflowEvent({
    sessionId,
    kind: "workflow.worktree.create_requested",
    source: "electron-main",
    idempotencyKey: `worktree:${worktree.worktreeId}:create-requested`,
    payload: { worktree },
    now: new Date().toISOString(),
  });
  return { protocolVersion: RUN_PROTOCOL_VERSION, status: "requested", event, worktree };
}));

ipcMain.handle("workflow:worktree:compare", workflowHandler(async (projectRoot: string, input: unknown) => {
  assertKnownProjectRoot(projectRoot);
  const left = requireRecord(readField(input, "left"), "left worktree");
  const right = requireRecord(readField(input, "right"), "right worktree");
  const comparison = {
    comparisonId: `comparison-${requireText(left.worktreeId, "left worktree id")}-${requireText(right.worktreeId, "right worktree id")}`,
    variants: [
      await collectChangesetEvidenceForWorktree(projectRoot, left),
      await collectChangesetEvidenceForWorktree(projectRoot, right),
    ],
    collectedAt: new Date().toISOString(),
  };
  return { protocolVersion: RUN_PROTOCOL_VERSION, comparison };
}));

ipcMain.handle("workflow:worktree:adopt", workflowHandler(async (projectRoot: string, input: unknown) => {
  assertKnownProjectRoot(projectRoot);
  const sessionId = requireText(readField(input, "sessionId"), "workflow session id");
  const adoption = requireRecord(readField(input, "adoption"), "variant adoption");
  const store = await getWorkflowStore(projectRoot);
  const event = store.appendWorkflowEvent({
    sessionId,
    kind: "workflow.variant.adopt_requested",
    source: "electron-main",
    idempotencyKey: `variant:${requireText(adoption.adoptionId, "adoption id")}:adopt-requested`,
    payload: { adoption: { ...adoption, status: "requested" } },
    now: new Date().toISOString(),
  });
  return { protocolVersion: RUN_PROTOCOL_VERSION, status: "requested", event };
}));

ipcMain.handle("workflow:worktree:clean", workflowHandler(async (projectRoot: string, input: unknown) => {
  assertKnownProjectRoot(projectRoot);
  const sessionId = requireText(readField(input, "sessionId"), "workflow session id");
  const worktree = requireRecord(readField(input, "worktree"), "worktree identity");
  assertManagedWorktreePath(projectRoot, requireText(worktree.realPath ?? worktree.path, "worktree path"));
  const store = await getWorkflowStore(projectRoot);
  const event = store.appendWorkflowEvent({
    sessionId,
    kind: "workflow.worktree.clean_requested",
    source: "electron-main",
    idempotencyKey: `worktree:${requireText(worktree.worktreeId, "worktree id")}:clean-requested`,
    payload: { worktree, deleteBranch: readField(input, "deleteBranch") === true },
    now: new Date().toISOString(),
  });
  return { protocolVersion: RUN_PROTOCOL_VERSION, status: "requested", event };
}));

ipcMain.handle("workflow:changeset", workflowHandler(async (projectRoot: string, input: unknown) => {
  assertKnownProjectRoot(projectRoot);
  const nodeId = requireText(readField(input, "nodeId"), "node id");
  const changesetId = optionalText(readField(input, "changesetId")) ?? `changeset-${nodeId}`;
  const worktreePath = path.resolve(optionalText(readField(input, "worktreePath")) ?? projectRoot);
  return {
    protocolVersion: RUN_PROTOCOL_VERSION,
    changeset: await collectGitChangeset(projectRoot, worktreePath, changesetId),
  };
}));

ipcMain.handle("workspace:load", async () => {
  try {
    const value = await fs.readFile(workspaceStorePath(), "utf8");
    const state = JSON.parse(value) as unknown;
    rememberProjectRoots(state);
    return state;
  } catch {
    return null;
  }
});

ipcMain.handle("workspace:save", async (_event, state: unknown) => {
  const safeState = sanitizeWorkspaceStateForKnownProjects(state);
  const target = workspaceStorePath();
  await fs.mkdir(path.dirname(target), { recursive: true });
  await fs.writeFile(target, JSON.stringify(safeState, null, 2), "utf8");
  return { ok: true };
});

function workspaceStorePath(): string {
  return path.join(app.getPath("userData"), "workspace.json");
}

async function getAgentBridge(): Promise<AgentBridgeHost> {
  if (!agentBridge) {
    const { AgentBridge, createCodexCliAdapter, createHermesCliAdapter } = await import("@skyturn/agent-bridge");
    const codexOptions = {
      ...(process.env.SKYTURN_CODEX_SANDBOX === "workspace-write" ? { sandbox: "workspace-write" as const } : {}),
      ...(process.env.SKYTURN_CODEX_IGNORE_USER_CONFIG === "1" ? { extraArgs: ["--ignore-user-config"] } : {}),
    };
    const bridge = new AgentBridge({
      adapters: [createHermesCliAdapter(), createCodexCliAdapter(codexOptions)],
    }) as AgentBridgeHost;
    bridge.onRunEvent((event) => {
      for (const window of BrowserWindow.getAllWindows()) {
        window.webContents.send("run:event", event);
      }
    });
    agentBridge = bridge;
  }
  return agentBridge;
}

async function getWorkflowStore(projectRoot: string): Promise<WorkflowStoreHost> {
  const existing = workflowStores.get(projectRoot);
  if (existing) return existing;
  const { createWorkflowStore } = await import("@skyturn/persistence/workflow-store");
  const store = createWorkflowStore({ projectRoot }) as WorkflowStoreHost;
  workflowStores.set(projectRoot, store);
  return store;
}

function broadcastWorkflowProjection(projectRoot: string, sessionId: string, store: WorkflowStoreHost): void {
  const projection = store.materializeFlowProjection(sessionId);
  const canvasSession = store.materializeCanvasSession(sessionId);
  for (const window of BrowserWindow.getAllWindows()) {
    window.webContents.send("workflow:event", { projectRoot, sessionId, projection, canvasSession });
  }
}

function assertWorkflowSessionId(value: unknown): string {
  if (typeof value !== "string" || !value.trim()) throw new Error("Workflow sessionId is required.");
  return value;
}

function assertRequiredText(value: unknown, message: string): string {
  if (typeof value !== "string" || !value.trim()) throw new Error(message);
  return value;
}

function assertWorkflowAgentKind(value: unknown): string {
  if (
    value === "hermes" ||
    value === "codex" ||
    value === "gemini" ||
    value === "claude-code" ||
    value === "openclaw"
  ) {
    return value;
  }
  throw new Error("Workflow agentKind is required.");
}

function summarizeRunOutput(events: unknown[]): string | undefined {
  const output = events
    .map((event) => {
      if (!event || typeof event !== "object") return null;
      const candidate = event as { kind?: unknown; payload?: { text?: unknown } };
      return candidate.kind === "output" && typeof candidate.payload?.text === "string"
        ? candidate.payload.text
        : null;
    })
    .filter((text): text is string => Boolean(text))
    .join("\n")
    .trim();
  if (!output) return undefined;
  return output.length > 1_000 ? output.slice(0, 1_000) : output;
}

function isWorkflowEventRecord(event: unknown): event is Record<string, unknown> & { kind: string } {
  return Boolean(event) && typeof event === "object" && typeof (event as { kind?: unknown }).kind === "string" &&
    (event as { kind: string }).kind.startsWith("workflow.");
}

function redactWorkflowEventForRenderer(event: Record<string, unknown> & { kind: string }): Record<string, unknown> {
  return {
    id: event.id,
    sessionId: event.sessionId,
    seq: event.seq,
    kind: event.kind,
    source: event.source,
    laneId: event.laneId,
    segmentId: event.segmentId,
    causationId: event.causationId,
    correlationId: event.correlationId,
    createdAt: event.createdAt,
    payload: {
      redacted: true,
      summary: workflowEventSummary(event.kind),
    },
  };
}

function workflowEventSummary(kind: string): string {
  switch (kind) {
    case "workflow.user_input":
      return "User input recorded.";
    case "workflow.intent.accepted":
      return "WorkflowIntent accepted.";
    case "workflow.intent.rejected":
      return "WorkflowIntent rejected.";
    case "workflow.lane.declared":
      return "Lane declared.";
    case "workflow.edge.declared":
      return "Edge declared.";
    case "workflow.segment.started":
      return "Run segment started.";
    case "workflow.segment.output_delta":
      return "Run output summary recorded.";
    case "workflow.segment.finished":
      return "Run segment finished.";
    case "workflow.evidence.recorded":
      return "Run evidence recorded.";
    case "workflow.user_decision.requested":
      return "User decision requested.";
    case "workflow.user_decision.answered":
      return "User decision answered.";
    default:
      return "Workflow event recorded.";
  }
}

function assertKnownProjectRoot(projectRoot: string): void {
  if (!path.isAbsolute(projectRoot) || !openedProjectRoots.has(projectRoot)) {
    throw new Error("Project root is not open in SkyTurn.");
  }
}

async function normalizeChangesetNodeForProject(
  realProjectRoot: string,
  node: unknown,
): Promise<unknown> {
  if (!node || typeof node !== "object") throw new Error("Canvas node is required.");
  const value = node as { worktree?: unknown };
  const worktree = value.worktree && typeof value.worktree === "object" ? value.worktree as { path?: unknown } : null;
  if (!worktree || typeof worktree.path !== "string") throw new Error("Canvas node worktree path is required.");
  const worktreePath = await resolveChangesetWorktreePath(realProjectRoot, worktree.path);
  return {
    ...value,
    worktree: {
      ...worktree,
      path: worktreePath,
    },
  };
}

async function resolveChangesetWorktreePath(
  realProjectRoot: string,
  worktreePath: string,
): Promise<string> {
  if (!path.isAbsolute(worktreePath)) return realProjectRoot;
  const resolved = await fs.realpath(worktreePath);
  const projectWorktreesRoot = `${realProjectRoot}.worktrees`;
  const realProjectWorktreesRoot = await fs.realpath(projectWorktreesRoot).catch(() => null);
  if (
    resolved === realProjectRoot ||
    isPathInside(resolved, realProjectRoot) ||
    (
      realProjectWorktreesRoot !== null &&
      realProjectWorktreesRoot === projectWorktreesRoot &&
      isPathInside(resolved, realProjectWorktreesRoot)
    )
  ) {
    return resolved;
  }
  throw new Error("Changeset worktree path is outside the opened project boundary.");
}

function isPathInside(candidate: string, parent: string): boolean {
  const relative = path.relative(parent, candidate);
  return relative !== "" && !relative.startsWith("..") && !path.isAbsolute(relative);
}

function rememberProjectRoots(state: unknown): void {
  if (!state || typeof state !== "object") return;
  const projects = (state as { projects?: unknown }).projects;
  if (!Array.isArray(projects)) return;
  for (const project of projects) {
    const rootPath = (project as { rootPath?: unknown }).rootPath;
    if (typeof rootPath === "string" && path.isAbsolute(rootPath)) openedProjectRoots.add(rootPath);
  }
}

function sanitizeWorkspaceStateForKnownProjects(state: unknown): unknown {
  if (!isRecord(state) || !Array.isArray(state.projects)) return state;
  const projects = state.projects.filter((project) => {
    if (!isRecord(project) || typeof project.rootPath !== "string") return false;
    return openedProjectRoots.has(project.rootPath);
  });
  const projectIds = new Set(projects.map((project) => isRecord(project) ? optionalText(project.id) : null).filter(Boolean));
  const sessions = Array.isArray(state.sessions)
    ? state.sessions.filter((session) => isRecord(session) && typeof session.projectId === "string" && projectIds.has(session.projectId))
    : [];
  const activeProjectId = typeof state.activeProjectId === "string" && projectIds.has(state.activeProjectId)
    ? state.activeProjectId
    : null;
  const activeSessionId = activeProjectId && typeof state.activeSessionId === "string" &&
    sessions.some((session) => isRecord(session) && session.id === state.activeSessionId && session.projectId === activeProjectId)
    ? state.activeSessionId
    : null;
  return {
    ...state,
    projects,
    sessions,
    activeProjectId,
    activeSessionId,
    collapsedProjectIds: Array.isArray(state.collapsedProjectIds)
      ? state.collapsedProjectIds.filter((id): id is string => typeof id === "string" && projectIds.has(id))
      : [],
  };
}

async function assertExecutableStartInput(input: StartAgentRunInput): Promise<void> {
  const inputError = workflowStartInputError(input);
  if (inputError === "NON_EXECUTABLE_NODE") {
    throw workflowIpcError("NON_EXECUTABLE_NODE", "Workflow projection node is not executable.");
  }
  if (inputError) throw workflowIpcError(inputError, "Workflow run start requires both sessionId and nodeId.");
  if (!input.sessionId || !input.nodeId) return;
  const store = await getWorkflowStore(input.projectRoot);
  const workflowEventCount = store.listEvents(input.sessionId).length;
  const projection = store.materializeFlowProjection(input.sessionId) as FlowProjectionLike;
  const projectedNode = projection.projectionNodes.find((node) =>
    node.id === input.nodeId || node.laneId === input.nodeId || node.decisionId === input.nodeId
  );
  if (projectedNode?.executable === false) {
    throw workflowIpcError("NON_EXECUTABLE_NODE", "Workflow projection node is not executable.");
  }
  if (!projectedNode && rejectMissingWorkflowProjectionNode(input, workflowEventCount)) {
    throw workflowIpcError("INVALID_INPUT", "Workflow projection node is not known.");
  }
}

function workflowHandler<T extends unknown[], R>(
  handler: (...args: T) => Promise<R> | R,
): (_event: Electron.IpcMainInvokeEvent, ...args: T) => Promise<R> {
  return async (_event, ...args) => {
    try {
      return await handler(...args);
    } catch (error) {
      throw normalizeWorkflowIpcError(error);
    }
  };
}

function broadcastWorkflowProjection(projectRoot: string, sessionId: string, projection: unknown): void {
  for (const window of BrowserWindow.getAllWindows()) {
    window.webContents.send("workflow:event", { projectRoot, sessionId, projection });
  }
}

function workflowEventsOnly(events: unknown[]): unknown[] {
  return events.filter((event) => {
    const kind = (event as { kind?: unknown }).kind;
    return typeof kind === "string" && kind.startsWith("workflow.");
  });
}

function buildWorkflowLedger(events: unknown[]) {
  const workflowEvents = workflowEventsOnly(events) as Array<{
    seq?: unknown;
    kind?: unknown;
    laneId?: unknown;
    payload?: unknown;
  }>;
  const answered = new Set<string>();
  const requestedQuestions = new Map<string, string>();
  const summaries = workflowEvents.map((event) => {
    const payload = isRecord(event.payload) ? event.payload : {};
    if (event.kind === "workflow.user_decision.answered" && typeof payload.decisionId === "string") {
      answered.add(payload.decisionId);
    }
    if (event.kind === "workflow.user_decision.requested" && typeof payload.decisionId === "string") {
      requestedQuestions.set(payload.decisionId, sanitizeSnippet(payload.prompt));
    }
    return {
      seq: typeof event.seq === "number" ? event.seq : 0,
      kind: typeof event.kind === "string" ? event.kind : "workflow.unknown",
      summary: summarizeWorkflowEvent(event.kind, payload),
      ...(typeof event.laneId === "string" ? { laneId: event.laneId } : laneIdFromPayload(payload) ? { laneId: laneIdFromPayload(payload) } : {}),
    };
  });
  return {
    throughSeq: summaries.at(-1)?.seq ?? 0,
    checkpointSummary: null,
    facts: summaries
      .filter((event) => event.kind !== "workflow.segment.output_delta")
      .slice(-8)
      .map((event) => event.summary),
    recentEvents: summaries.slice(-12),
    openQuestions: [...requestedQuestions.entries()]
      .filter(([decisionId]) => !answered.has(decisionId))
      .map(([, prompt]) => prompt),
  };
}

function summarizeWorkflowEvent(kind: unknown, payload: Record<string, unknown>): string {
  if (kind === "workflow.user_input") return `user input: ${sanitizeSnippet(payload.text)}`;
  if (kind === "workflow.intent.accepted") return `intent accepted: ${sanitizeSnippet(payload.intentId)}`;
  if (kind === "workflow.intent.rejected") return `intent rejected: ${sanitizeSnippet(payload.reason)}`;
  if (kind === "workflow.lane.declared" && isRecord(payload.lane)) return `lane declared: ${sanitizeSnippet(payload.lane.title ?? payload.lane.id)}`;
  if (kind === "workflow.edge.declared") return "edge declared";
  if (kind === "workflow.segment.started") return "run segment started";
  if (kind === "workflow.segment.output_delta") return "run output delta recorded";
  if (kind === "workflow.segment.finished") return `run segment finished: ${sanitizeSnippet(payload.status)}`;
  if (kind === "workflow.evidence.recorded" && isRecord(payload.evidence)) {
    return `evidence recorded: ${sanitizeSnippet(payload.evidence.kind)} ${sanitizeSnippet(payload.evidence.status)}`;
  }
  if (kind === "workflow.changeset.evidence_recorded" && isRecord(payload.evidence)) {
    return `changeset evidence: ${sanitizeSnippet(payload.evidence.status)}`;
  }
  if (kind === "workflow.user_decision.requested") return `decision requested: ${sanitizeSnippet(payload.prompt)}`;
  if (kind === "workflow.user_decision.answered") return `decision answered: ${sanitizeSnippet(payload.selectedOption)}`;
  if (kind === "workflow.worktree.create_requested") return "worktree creation requested";
  if (kind === "workflow.worktree.clean_requested") return "worktree cleanup requested";
  if (kind === "workflow.variant.adopt_requested") return "variant adoption requested";
  return typeof kind === "string" ? kind.replace(/^workflow\./, "").replaceAll("_", " ") : "workflow event recorded";
}

function sanitizeSnippet(value: unknown): string {
  const text = typeof value === "string" ? value : "";
  return text
    .replace(/-----BEGIN [^-]+PRIVATE KEY-----[\s\S]*?-----END [^-]+PRIVATE KEY-----/g, "[REDACTED_PRIVATE_KEY]")
    .replace(/\b(token|secret|password|api[_-]?key|authorization|cookie)\b\s*[:=]\s*\S+/gi, "$1=[REDACTED]")
    .replace(/diff --git[\s\S]*/g, "[REDACTED_DIFF]")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 180);
}

function laneIdFromPayload(payload: Record<string, unknown>): string | null {
  if (typeof payload.laneId === "string") return payload.laneId;
  if (isRecord(payload.evidence) && typeof payload.evidence.laneId === "string") return payload.evidence.laneId;
  if (isRecord(payload.segment) && typeof payload.segment.laneId === "string") return payload.segment.laneId;
  return null;
}

function normalizeHermesTransport(value: unknown): string {
  if (value === "hermes_session_resume" || value === "hermes_replay_recovery") return value;
  return "hermes_live_chat";
}

function normalizeAgentKind(value: unknown): string {
  return typeof value === "string" && value.trim() ? value.trim() : "agent";
}

function normalizeSegmentStatus(value: unknown): string {
  if (value === "succeeded" || value === "failed" || value === "cancelled" || value === "timed-out") return value;
  return "failed";
}

function normalizeRunEvidenceForWorkflow(
  segmentId: string,
  evidence: Record<string, unknown>,
  status: string,
  exitCode: number | null,
): Record<string, unknown> {
  return {
    id: optionalText(evidence.id) ?? `evidence-${segmentId}`,
    kind: optionalText(evidence.kind) ?? "run-exit",
    status: status === "succeeded" && exitCode === 0 ? "passed" : "failed",
    checks: Array.isArray(evidence.checks)
      ? evidence.checks.map((check) => isRecord(check) ? optionalText(check.name) ?? optionalText(check.kind) : optionalText(check)).filter(Boolean)
      : [],
    artifacts: Array.isArray(evidence.artifacts) ? evidence.artifacts.filter((artifact): artifact is string => typeof artifact === "string") : [],
    ...(optionalText(evidence.errorReason) ? { detail: optionalText(evidence.errorReason) } : {}),
  };
}

function normalizeUserDecisionAction(value: unknown): string {
  if (value === "backtrack" || value === "parallel_worktree" || value === "continue" || value === "abort") return value;
  throw workflowIpcError("INVALID_INPUT", "User decision action is invalid.");
}

function managedWorktreeIdentity(
  projectRoot: string,
  input: {
    sessionId: string;
    variantId: string;
    baseCommit: string;
    parentLaneId: string;
    parentSegmentId?: string;
  },
): Record<string, string> {
  const safeSessionId = safePathToken(input.sessionId);
  const safeVariantId = safePathToken(input.variantId);
  const managerRoot = `${path.resolve(projectRoot)}.worktrees`;
  const worktreePath = path.join(managerRoot, `session-${safeSessionId}-variant-${safeVariantId}`);
  assertManagedWorktreePath(projectRoot, worktreePath);
  return {
    worktreeId: `worktree-${safeSessionId}-${safeVariantId}`,
    variantId: input.variantId,
    path: worktreePath,
    realPath: worktreePath,
    gitdir: path.join(path.resolve(projectRoot), ".git", "worktrees", `session-${safeSessionId}-variant-${safeVariantId}`),
    repoRoot: path.resolve(projectRoot),
    branchName: `skyturn/${safeSessionId}/${safeVariantId}`,
    baseCommit: input.baseCommit,
    headCommit: input.baseCommit,
    parentLaneId: input.parentLaneId,
    ...(input.parentSegmentId ? { parentSegmentId: input.parentSegmentId } : {}),
  };
}

async function collectChangesetEvidenceForWorktree(
  projectRoot: string,
  worktree: Record<string, unknown>,
): Promise<Record<string, unknown>> {
  const variantId = requireText(worktree.variantId, "worktree variant id");
  const worktreeId = requireText(worktree.worktreeId, "worktree id");
  const worktreePath = requireText(worktree.realPath ?? worktree.path, "worktree path");
  assertManagedWorktreePath(projectRoot, worktreePath);
  const changesetId = `changeset-${worktreeId}`;
  try {
    const changeset = await collectGitChangeset(projectRoot, worktreePath, changesetId);
    return {
      variantId,
      worktreeId,
      changeset: {
        evidenceId: `changeset-evidence-${worktreeId}`,
        changesetId,
        source: "git",
        status: changeset.files.length > 0 ? "available" : "empty",
        files: changeset.files,
        diffStat: changeset.diffStat,
        patchPreviewTruncated: changeset.patchPreview.length >= 12000,
        worktreeId,
      },
    };
  } catch (error) {
    return {
      variantId,
      worktreeId,
      changeset: {
        evidenceId: `changeset-evidence-${worktreeId}`,
        changesetId,
        source: "git",
        status: "failed",
        files: [],
        diffStat: { added: 0, changed: 0, deleted: 0 },
        patchPreviewTruncated: false,
        worktreeId,
        errorReason: sanitizeSnippet(error instanceof Error ? error.message : String(error)),
      },
    };
  }
}

async function collectGitChangeset(projectRoot: string, worktreePath: string, changesetId: string): Promise<GitChangesetLike> {
  const readablePath = await assertReadableGitPath(projectRoot, worktreePath);
  const [status, numstat, cachedNumstat, patch, cachedPatch] = await Promise.all([
    runGit(readablePath, ["status", "--porcelain=v1"]),
    runGit(readablePath, ["diff", "--numstat", "--"]),
    runGit(readablePath, ["diff", "--cached", "--numstat", "--"]),
    runGit(readablePath, ["diff", "--"]),
    runGit(readablePath, ["diff", "--cached", "--"]),
  ]);
  const files = uniqueStrings([...filesFromPorcelain(status), ...filesFromNumstat(numstat), ...filesFromNumstat(cachedNumstat)]);
  const stat = sumNumstat([numstat, cachedNumstat]);
  const patchPreview = truncatePatch([patch, cachedPatch].filter(Boolean).join("\n"));
  return {
    id: changesetId,
    files,
    diffStat: {
      added: stat.added,
      changed: files.length,
      deleted: stat.deleted,
    },
    patchPreview,
    source: "git",
  };
}

async function runGit(worktreePath: string, args: string[]): Promise<string> {
  const result = await execFileAsync("git", ["-C", worktreePath, ...args], { maxBuffer: 2_000_000 });
  return String(result.stdout);
}

function filesFromPorcelain(output: string): string[] {
  return output
    .split("\n")
    .map((line) => line.slice(3).trim())
    .filter(Boolean)
    .map((file) => file.includes(" -> ") ? file.split(" -> ").at(-1) ?? file : file);
}

function filesFromNumstat(output: string): string[] {
  return output
    .split("\n")
    .map((line) => line.split("\t").at(2)?.trim() ?? "")
    .filter(Boolean);
}

function sumNumstat(outputs: string[]): { added: number; deleted: number } {
  let added = 0;
  let deleted = 0;
  for (const output of outputs) {
    for (const line of output.split("\n")) {
      const [rawAdded, rawDeleted] = line.split("\t");
      added += parseNumstatCount(rawAdded);
      deleted += parseNumstatCount(rawDeleted);
    }
  }
  return { added, deleted };
}

function parseNumstatCount(value: string | undefined): number {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : 0;
}

function uniqueStrings(values: string[]): string[] {
  return [...new Set(values)].slice(0, 200);
}

function truncatePatch(value: string): string {
  return value.length > 12000 ? `${value.slice(0, 12000)}\n[TRUNCATED]` : value;
}

async function assertReadableGitPath(projectRoot: string, candidate: string): Promise<string> {
  const resolvedProjectRoot = await fs.realpath(projectRoot).catch(() => path.resolve(projectRoot));
  const resolved = path.resolve(candidate);
  const realCandidate = await fs.realpath(resolved).catch(() => resolved);
  if (realCandidate === resolvedProjectRoot) return realCandidate;
  assertManagedWorktreePath(resolvedProjectRoot, realCandidate);
  return realCandidate;
}

function assertManagedWorktreePath(projectRoot: string, candidate: string): void {
  const managerRoot = `${path.resolve(projectRoot)}.worktrees`;
  const resolved = path.resolve(candidate);
  if (!isInsidePath(managerRoot, resolved)) {
    throw workflowIpcError("UNSAFE_WORKTREE_PATH", "Worktree path must stay inside the SkyTurn managed worktree directory.");
  }
}

function isInsidePath(parent: string, child: string): boolean {
  const relative = path.relative(path.resolve(parent), path.resolve(child));
  return relative.length > 0 && !relative.startsWith("..") && !path.isAbsolute(relative);
}

function safePathToken(value: string): string {
  return value.replace(/[^a-zA-Z0-9._-]+/g, "-").replace(/^-+|-+$/g, "") || "default";
}

function positiveInteger(value: unknown): number | null {
  return typeof value === "number" && Number.isInteger(value) && value > 0 ? value : null;
}

function readField(value: unknown, field: string): unknown {
  return isRecord(value) ? value[field] : undefined;
}

function requireRecord(value: unknown, field: string): Record<string, unknown> {
  if (!isRecord(value)) throw workflowIpcError("INVALID_INPUT", `${field} must be an object.`);
  return value;
}

function requireText(value: unknown, field: string): string {
  const text = optionalText(value);
  if (!text) throw workflowIpcError("INVALID_INPUT", `${field} is required.`);
  return text;
}

function optionalText(value: unknown): string | null {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

app.whenReady().then(createMainWindow);

app.on("window-all-closed", () => {
  closeWorkflowStores();
  if (process.platform !== "darwin") app.quit();
});

app.on("activate", () => {
  if (BrowserWindow.getAllWindows().length === 0) {
    void createMainWindow();
  }
});

function closeWorkflowStores(): void {
  for (const store of workflowStores.values()) store.close();
  workflowStores.clear();
}
