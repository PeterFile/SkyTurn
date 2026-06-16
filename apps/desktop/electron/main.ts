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
  applyWorkflowIntent(intent: unknown, now: string): unknown;
  materializeFlowProjection(sessionId: string): unknown;
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
  if (typeof intent?.sessionId !== "string") throw new Error("WorkflowIntent sessionId is required.");
  const store = await getWorkflowStore(projectRoot);
  const result = store.applyWorkflowIntent(intent, new Date().toISOString());
  const projection = store.materializeFlowProjection(intent.sessionId);
  for (const window of BrowserWindow.getAllWindows()) {
    window.webContents.send("workflow:event", { projectRoot, sessionId: intent.sessionId, projection });
  }
  return { protocolVersion: RUN_PROTOCOL_VERSION, result, projection };
});

ipcMain.handle("workflow:projection", async (_event, projectRoot: string, sessionId: string) => {
  assertKnownProjectRoot(projectRoot);
  const store = await getWorkflowStore(projectRoot);
  return {
    protocolVersion: RUN_PROTOCOL_VERSION,
    projection: store.materializeFlowProjection(sessionId),
  };
});

ipcMain.handle("workflow:events", async (_event, projectRoot: string, sessionId: string) => {
  assertKnownProjectRoot(projectRoot);
  const store = await getWorkflowStore(projectRoot);
  return {
    protocolVersion: RUN_PROTOCOL_VERSION,
    events: store.listEvents(sessionId).filter((event) => {
      const kind = (event as { kind?: unknown }).kind;
      return typeof kind === "string" && kind.startsWith("workflow.");
    }),
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
