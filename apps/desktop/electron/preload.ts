import { contextBridge, ipcRenderer } from "electron";
import type { WorktreeComparisonRequest } from "@skyturn/git-worktree" with { "resolution-mode": "import" };
import type {
  TerminalActionResult,
  TerminalCancelInput,
  TerminalRendererEvent,
  TerminalResizeInput,
  TerminalSnapshotInput,
  TerminalSnapshotResult,
  TerminalStartInput,
  TerminalStartResult,
  TerminalWriteInput,
} from "./terminalIpcContracts";

const terminal = {
  start: (input: TerminalStartInput): Promise<TerminalStartResult> => ipcRenderer.invoke("terminal:start", input),
  write: (input: TerminalWriteInput): Promise<TerminalActionResult> => ipcRenderer.invoke("terminal:write", input),
  resize: (input: TerminalResizeInput): Promise<TerminalActionResult> => ipcRenderer.invoke("terminal:resize", input),
  cancel: (input: TerminalCancelInput): Promise<TerminalActionResult> => ipcRenderer.invoke("terminal:cancel", input),
  snapshot: (input: TerminalSnapshotInput): Promise<TerminalSnapshotResult> => ipcRenderer.invoke("terminal:snapshot", input),
  onEvent: (listener: (event: TerminalRendererEvent) => void) => {
    const handler = (_event: Electron.IpcRendererEvent, value: TerminalRendererEvent) => listener(value);
    ipcRenderer.on("terminal:event", handler);
    return () => ipcRenderer.removeListener("terminal:event", handler);
  },
};

const workflow = {
  createSession: (projectRoot: string, input: unknown) => ipcRenderer.invoke("workflow:createSession", projectRoot, input),
  appendUserInput: (projectRoot: string, input: unknown) => ipcRenderer.invoke("workflow:appendUserInput", projectRoot, input),
  getLedger: (projectRoot: string, sessionId: string) => ipcRenderer.invoke("workflow:ledger", projectRoot, sessionId),
  applyIntent: (projectRoot: string, intent: unknown) => ipcRenderer.invoke("workflow:applyIntent", projectRoot, intent),
  scheduleReady: (projectRoot: string, input: unknown) => ipcRenderer.invoke("workflow:scheduleReady", projectRoot, input),
  recordRunResult: (projectRoot: string, input: unknown) => ipcRenderer.invoke("workflow:recordRunResult", projectRoot, input),
  getProjection: (projectRoot: string, sessionId: string) => ipcRenderer.invoke("workflow:projection", projectRoot, sessionId),
  getEvents: (projectRoot: string, sessionId: string) => ipcRenderer.invoke("workflow:events", projectRoot, sessionId),
  getCheckpoints: (projectRoot: string, input: unknown) => ipcRenderer.invoke("workflow:checkpoints", projectRoot, input),
  getRollbackEligibility: (projectRoot: string, input: unknown) => ipcRenderer.invoke("workflow:rollback:eligibility", projectRoot, input),
  applyRollback: (projectRoot: string, input: unknown) => ipcRenderer.invoke("workflow:rollback:apply", projectRoot, input),
  requestRepair: (projectRoot: string, input: unknown) => ipcRenderer.invoke("workflow:repair:create", projectRoot, input),
  requestVariant: (projectRoot: string, input: unknown) => ipcRenderer.invoke("workflow:variant:create", projectRoot, input),
  answerUserDecision: (projectRoot: string, input: unknown) => ipcRenderer.invoke("workflow:userDecision:answer", projectRoot, input),
  createWorktree: (projectRoot: string, input: unknown) => ipcRenderer.invoke("workflow:worktree:create", projectRoot, input),
  compareWorktrees: async (projectRoot: string, input: WorktreeComparisonRequest) => {
    const {
      INVALID_VARIANT_COMPARISON_EVIDENCE_ERROR,
      parseVariantComparisonEvidence,
      parseWorktreeComparisonRequest,
    } = await import("@skyturn/git-worktree");
    const request = parseWorktreeComparisonRequest(input);
    const result: unknown = await ipcRenderer.invoke("workflow:worktree:compare", projectRoot, request);
    if (!isRecord(result) || typeof result.protocolVersion !== "number") {
      throw new Error(INVALID_VARIANT_COMPARISON_EVIDENCE_ERROR);
    }
    return {
      protocolVersion: result.protocolVersion,
      comparison: parseVariantComparisonEvidence(result.comparison),
    };
  },
  adoptWorktree: (projectRoot: string, input: unknown) => ipcRenderer.invoke("workflow:worktree:adopt", projectRoot, input),
  cleanWorktree: (projectRoot: string, input: unknown) => ipcRenderer.invoke("workflow:worktree:clean", projectRoot, input),
  createDeliveryCommit: (projectRoot: string, input: unknown) => ipcRenderer.invoke("workflow:delivery:commit", projectRoot, input),
  pushDeliveryBranch: (projectRoot: string, input: unknown) => ipcRenderer.invoke("workflow:delivery:push", projectRoot, input),
  createPullRequest: (projectRoot: string, input: unknown) => ipcRenderer.invoke("workflow:pullRequest:create", projectRoot, input),
  checkPullRequest: (projectRoot: string, input: unknown) => ipcRenderer.invoke("workflow:pullRequest:checks", projectRoot, input),
  mergePullRequest: (projectRoot: string, input: unknown) => ipcRenderer.invoke("workflow:pullRequest:merge", projectRoot, input),
  syncMain: (projectRoot: string, input: unknown) => ipcRenderer.invoke("workflow:delivery:syncMain", projectRoot, input),
  getChangeset: (projectRoot: string, input: unknown) => ipcRenderer.invoke("workflow:changeset", projectRoot, input),
  reconcileFinalChangeset: (projectRoot: string, input: unknown) => ipcRenderer.invoke("workflow:changeset:reconcileFinal", projectRoot, input),
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

contextBridge.exposeInMainWorld("devflow", {
  openProject: () => ipcRenderer.invoke("project:open"),
  initializeProjectMemory: (rootPath: string) => ipcRenderer.invoke("project:initDevflow", rootPath),
  getProjectBranchFacts: (projectRoot: string) => ipcRenderer.invoke("project:branchFacts", projectRoot),
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
  getChangeset: (projectRoot: string, node: unknown) => ipcRenderer.invoke("changeset:get", projectRoot, node),
  reconcileFinalChangeset: (projectRoot: string, input: unknown) => ipcRenderer.invoke("workflow:changeset:reconcileFinal", projectRoot, input),
  applyWorkflowIntent: (projectRoot: string, intent: unknown) => ipcRenderer.invoke("workflow:applyIntent", projectRoot, intent),
  scheduleWorkflowReadyLanes: (projectRoot: string, sessionId: string, input: unknown) => ipcRenderer.invoke("workflow:scheduleReady", projectRoot, sessionId, input),
  recordWorkflowRunResult: (projectRoot: string, input: unknown) => ipcRenderer.invoke("workflow:recordRunResult", projectRoot, input),
  getWorkflowProjection: (projectRoot: string, sessionId: string) => ipcRenderer.invoke("workflow:projection", projectRoot, sessionId),
  getWorkflowEvents: (projectRoot: string, sessionId: string) => ipcRenderer.invoke("workflow:events", projectRoot, sessionId),
  createWorkflowDeliveryCommit: (projectRoot: string, input: unknown) => ipcRenderer.invoke("workflow:delivery:commit", projectRoot, input),
  pushWorkflowDeliveryBranch: (projectRoot: string, input: unknown) => ipcRenderer.invoke("workflow:delivery:push", projectRoot, input),
  createWorkflowPullRequest: (projectRoot: string, input: unknown) => ipcRenderer.invoke("workflow:pullRequest:create", projectRoot, input),
  checkWorkflowPullRequest: (projectRoot: string, input: unknown) => ipcRenderer.invoke("workflow:pullRequest:checks", projectRoot, input),
  mergeWorkflowPullRequest: (projectRoot: string, input: unknown) => ipcRenderer.invoke("workflow:pullRequest:merge", projectRoot, input),
  syncWorkflowMain: (projectRoot: string, input: unknown) => ipcRenderer.invoke("workflow:delivery:syncMain", projectRoot, input),
  workflow,
  terminal,
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
