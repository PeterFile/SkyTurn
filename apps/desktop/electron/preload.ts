import { contextBridge, ipcRenderer } from "electron";

contextBridge.exposeInMainWorld("devflow", {
  openProject: () => ipcRenderer.invoke("project:open"),
  initializeProjectMemory: (rootPath: string) => ipcRenderer.invoke("project:initDevflow", rootPath),
  loadWorkspace: () => ipcRenderer.invoke("workspace:load"),
  saveWorkspace: (state: unknown) => ipcRenderer.invoke("workspace:save", state),
  openEditor: (editor: string, worktreePath: string) =>
    ipcRenderer.invoke("editor:openWorktree", editor, worktreePath),
  discoverAgents: () => ipcRenderer.invoke("agent:discover"),
  getAgentHealth: () => ipcRenderer.invoke("agent:health"),
  startAgentRun: (input: unknown) => ipcRenderer.invoke("run:start", input),
  sendRunMessage: (runId: string, message: string) => ipcRenderer.invoke("run:send", runId, message),
  cancelAgentRun: (runId: string, reason: string) => ipcRenderer.invoke("run:cancel", runId, reason),
  getRunEvents: (projectRoot: string, runId: string) => ipcRenderer.invoke("run:events", projectRoot, runId),
  listAgentRuns: () => ipcRenderer.invoke("run:list"),
  getRunEvidence: (projectRoot: string, runId: string) => ipcRenderer.invoke("run:evidence", projectRoot, runId),
  createWorkflowSession: (projectRoot: string, input: unknown) => ipcRenderer.invoke("workflow:createSession", projectRoot, input),
  appendWorkflowUserInput: (projectRoot: string, input: unknown) => ipcRenderer.invoke("workflow:appendUserInput", projectRoot, input),
  getWorkflowLedger: (projectRoot: string, sessionId: string) => ipcRenderer.invoke("workflow:ledger", projectRoot, sessionId),
  applyWorkflowIntent: (projectRoot: string, intent: unknown) => ipcRenderer.invoke("workflow:applyIntent", projectRoot, intent),
  scheduleWorkflowReadyLanes: (projectRoot: string, sessionId: string, input: unknown) => ipcRenderer.invoke("workflow:scheduleReady", projectRoot, sessionId, input),
  recordWorkflowRunResult: (projectRoot: string, input: unknown) => ipcRenderer.invoke("workflow:recordRunResult", projectRoot, input),
  getWorkflowProjection: (projectRoot: string, sessionId: string) => ipcRenderer.invoke("workflow:projection", projectRoot, sessionId),
  getWorkflowEvents: (projectRoot: string, sessionId: string) => ipcRenderer.invoke("workflow:events", projectRoot, sessionId),
  onRunEvent: (listener: (event: unknown) => void) => {
    const handler = (_event: Electron.IpcRendererEvent, value: unknown) => listener(value);
    ipcRenderer.on("run:event", handler);
    return () => ipcRenderer.removeListener("run:event", handler);
  },
  onWorkflowEvent: (listener: (event: unknown) => void) => {
    const handler = (_event: Electron.IpcRendererEvent, value: unknown) => listener(value);
    ipcRenderer.on("workflow:event", handler);
    return () => ipcRenderer.removeListener("workflow:event", handler);
  },
});
