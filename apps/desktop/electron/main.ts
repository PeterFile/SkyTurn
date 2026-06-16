import { app, BrowserWindow, dialog, ipcMain, shell } from "electron";
import fs from "node:fs/promises";
import path from "node:path";

import {
  DEVFLOW_DIRECTORIES,
  DEVFLOW_FILES,
  defaultDevflowFileContent,
} from "@skyturn/project-memory";

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
  [key: string]: unknown;
}

interface WorkflowRunResultInput {
  sessionId?: unknown;
  laneId?: unknown;
  segmentId?: unknown;
  runId?: unknown;
  agentKind?: unknown;
  now?: unknown;
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
  openedProjectRoots.add(rootPath);
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

ipcMain.handle("workflow:createSession", async (_event, projectRoot: string, input: { id?: unknown }) => {
  assertKnownProjectRoot(projectRoot);
  const sessionId = assertWorkflowSessionId(input.id);
  const store = await getWorkflowStore(projectRoot);
  const session = store.createWorkflowSession(input);
  return {
    protocolVersion: RUN_PROTOCOL_VERSION,
    session,
    projection: store.materializeFlowProjection(sessionId),
    canvasSession: store.materializeCanvasSession(sessionId),
  };
});

ipcMain.handle("workflow:appendUserInput", async (_event, projectRoot: string, input: { sessionId?: unknown }) => {
  assertKnownProjectRoot(projectRoot);
  const sessionId = assertWorkflowSessionId(input.sessionId);
  const store = await getWorkflowStore(projectRoot);
  const event = store.appendUserInput(input);
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

ipcMain.handle("workflow:scheduleReady", async (_event, projectRoot: string, sessionId: string, input: unknown) => {
  assertKnownProjectRoot(projectRoot);
  const workflowSessionId = assertWorkflowSessionId(sessionId);
  const store = await getWorkflowStore(projectRoot);
  const result = store.scheduleReadyLanes(workflowSessionId, input);
  broadcastWorkflowProjection(projectRoot, workflowSessionId, store);
  return {
    protocolVersion: RUN_PROTOCOL_VERSION,
    result,
    projection: store.materializeFlowProjection(workflowSessionId),
    canvasSession: store.materializeCanvasSession(workflowSessionId),
  };
});

ipcMain.handle("workflow:recordRunResult", async (_event, projectRoot: string, input: WorkflowRunResultInput) => {
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

ipcMain.handle("workflow:projection", async (_event, projectRoot: string, sessionId: string) => {
  assertKnownProjectRoot(projectRoot);
  const workflowSessionId = assertWorkflowSessionId(sessionId);
  const store = await getWorkflowStore(projectRoot);
  return {
    protocolVersion: RUN_PROTOCOL_VERSION,
    projection: store.materializeFlowProjection(workflowSessionId),
    canvasSession: store.materializeCanvasSession(workflowSessionId),
  };
});

ipcMain.handle("workflow:events", async (_event, projectRoot: string, sessionId: string) => {
  assertKnownProjectRoot(projectRoot);
  const workflowSessionId = assertWorkflowSessionId(sessionId);
  const store = await getWorkflowStore(projectRoot);
  return {
    protocolVersion: RUN_PROTOCOL_VERSION,
    events: store.listEvents(workflowSessionId)
      .filter(isWorkflowEventRecord)
      .map(redactWorkflowEventForRenderer),
  };
});

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
  rememberProjectRoots(state);
  const target = workspaceStorePath();
  await fs.mkdir(path.dirname(target), { recursive: true });
  await fs.writeFile(target, JSON.stringify(state, null, 2), "utf8");
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

function rememberProjectRoots(state: unknown): void {
  if (!state || typeof state !== "object") return;
  const projects = (state as { projects?: unknown }).projects;
  if (!Array.isArray(projects)) return;
  for (const project of projects) {
    const rootPath = (project as { rootPath?: unknown }).rootPath;
    if (typeof rootPath === "string" && path.isAbsolute(rootPath)) openedProjectRoots.add(rootPath);
  }
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
