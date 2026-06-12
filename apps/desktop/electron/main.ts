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
    const { AgentBridge } = await import("@skyturn/agent-bridge");
    const bridge = new AgentBridge() as AgentBridgeHost;
    bridge.onRunEvent((event) => {
      for (const window of BrowserWindow.getAllWindows()) {
        window.webContents.send("run:event", event);
      }
    });
    agentBridge = bridge;
  }
  return agentBridge;
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
  if (process.platform !== "darwin") app.quit();
});

app.on("activate", () => {
  if (BrowserWindow.getAllWindows().length === 0) {
    void createMainWindow();
  }
});
