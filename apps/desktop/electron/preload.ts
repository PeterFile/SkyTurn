import { contextBridge, ipcRenderer } from "electron";
import type { WorktreeComparisonRequest } from "@skyturn/git-worktree" with { "resolution-mode": "import" };
import type {
  PlanApi,
  WorkflowApi,
  WorkflowLaneReassignRequest,
  WorkflowLaneReassignResult,
  WorkflowNodePositionUpdateRequest,
} from "@skyturn/persistence" with { "resolution-mode": "import" };
import type { PlanEvent } from "@skyturn/project-core" with { "resolution-mode": "import" };
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
import type {
  WorkflowInsertBeforeRequest,
  WorkflowInsertBeforeResult,
  WorkflowPendingInsertBeforeRequest,
  WorkflowPendingInsertBeforeResult,
} from "@skyturn/persistence" with { "resolution-mode": "import" };
import {
  WORKFLOW_EVENT_CHANNEL,
  parseWorkflowBroadcastEnvelope,
  parseWorkflowProjectionResponseEnvelope,
  parseWorkflowResponseEnvelope,
} from "./workflowIpcContracts";

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

const plan = {
  generate: (input) => ipcRenderer.invoke("plan:generate", input),
  revise: (input) => ipcRenderer.invoke("plan:revise", input),
  updateStage: (input) => ipcRenderer.invoke("plan:updateStage", input),
  acceptStage: (input) => ipcRenderer.invoke("plan:acceptStage", input),
  undoStage: (input) => ipcRenderer.invoke("plan:undoStage", input),
  cancel: (input) => ipcRenderer.invoke("plan:cancel", input),
  bootstrap: (input) => ipcRenderer.invoke("plan:bootstrap", input),
  getState: (input) => ipcRenderer.invoke("plan:getState", input),
} satisfies PlanApi;

type WorkflowEnvelopeExpectation = "none" | "optional" | "required" | "projection";

async function invokeWorkflow<T>(
  channel: string,
  projectRoot: string,
  requestArgs: readonly unknown[],
  envelopeExpectation: WorkflowEnvelopeExpectation = "none",
): Promise<T> {
  const expectedSessionId = workflowRequestSessionId(requestArgs[0]);
  const result: unknown = await ipcRenderer.invoke(channel, projectRoot, ...requestArgs);
  if (envelopeExpectation === "none") return result as T;
  if (envelopeExpectation === "projection") {
    return parseWorkflowProjectionResponseEnvelope(result, expectedSessionId) as T;
  }
  if (
    envelopeExpectation === "optional" &&
    isRecord(result) &&
    result.status !== "blocked" &&
    !Object.hasOwn(result, "canvasSession")
  ) {
    return result as T;
  }
  return parseWorkflowResponseEnvelope(result, expectedSessionId) as T;
}

function workflowRequestSessionId(value: unknown): string | undefined {
  if (typeof value === "string" && value.trim()) return value.trim();
  if (!isRecord(value)) return undefined;
  const direct = typeof value.id === "string"
    ? value.id
    : typeof value.sessionId === "string"
      ? value.sessionId
      : undefined;
  if (direct?.trim()) return direct.trim();
  return isRecord(value.session) && typeof value.session.id === "string" && value.session.id.trim()
    ? value.session.id.trim()
    : undefined;
}

const reassignWorkflowLane = (
  projectRoot: string,
  input: WorkflowLaneReassignRequest,
): Promise<WorkflowLaneReassignResult> =>
  invokeWorkflow("workflow:lane:reassign", projectRoot, [input], "required");

const reassignLane: WorkflowApi["reassignLane"] = reassignWorkflowLane;

const workflow = {
  createSession: (projectRoot: string, input: unknown) =>
    invokeWorkflow("workflow:createSession", projectRoot, [input], "required"),
  finishPlan: (projectRoot: string, input: unknown) =>
    invokeWorkflow("workflow:finishPlan", projectRoot, [input], "required"),
  appendUserInput: (projectRoot: string, input: unknown) =>
    invokeWorkflow("workflow:appendUserInput", projectRoot, [input], "required"),
  getLedger: (projectRoot: string, sessionId: string) => invokeWorkflow("workflow:ledger", projectRoot, [sessionId]),
  updateNodePosition: (projectRoot: string, input: WorkflowNodePositionUpdateRequest) =>
    invokeWorkflow("workflow:nodePosition:update", projectRoot, [input], "required"),
  getProjection: (projectRoot: string, sessionId: string) =>
    invokeWorkflow("workflow:projection", projectRoot, [sessionId], "projection"),
  getEvents: (projectRoot: string, sessionId: string) => invokeWorkflow("workflow:events", projectRoot, [sessionId]),
  reassignLane,
  getCheckpoints: (projectRoot: string, input: unknown) => invokeWorkflow("workflow:checkpoints", projectRoot, [input]),
  getPendingInsertBeforeRequest: (
    projectRoot: string,
    input: WorkflowPendingInsertBeforeRequest,
  ): Promise<WorkflowPendingInsertBeforeResult> => invokeWorkflow("workflow:insertBefore:pending", projectRoot, [input]),
  insertBefore: (projectRoot: string, input: WorkflowInsertBeforeRequest): Promise<WorkflowInsertBeforeResult> =>
    invokeWorkflow("workflow:insertBefore", projectRoot, [input], "required"),
  getRollbackEligibility: (projectRoot: string, input: unknown) =>
    invokeWorkflow("workflow:rollback:eligibility", projectRoot, [input]),
  applyRollback: (projectRoot: string, input: unknown) =>
    invokeWorkflow("workflow:rollback:apply", projectRoot, [input], "required"),
  requestRepair: (projectRoot: string, input: unknown) =>
    invokeWorkflow("workflow:repair:create", projectRoot, [input], "required"),
  requestVariant: (projectRoot: string, input: unknown) =>
    invokeWorkflow("workflow:variant:create", projectRoot, [input], "required"),
  answerUserDecision: (projectRoot: string, input: unknown) =>
    invokeWorkflow("workflow:userDecision:answer", projectRoot, [input], "required"),
  createWorktree: (projectRoot: string, input: unknown) => invokeWorkflow("workflow:worktree:create", projectRoot, [input]),
  compareWorktrees: async (projectRoot: string, input: WorktreeComparisonRequest) => {
    const [{
      INVALID_VARIANT_COMPARISON_EVIDENCE_ERROR,
      parseVariantComparisonEvidence,
      parseWorktreeComparisonRequest,
    }, { parseWorkflowVariantComparisonRecordedEvidence }] = await Promise.all([
      import("@skyturn/git-worktree"),
      import("@skyturn/project-core"),
    ]);
    const request = parseWorktreeComparisonRequest(input);
    const result: unknown = await invokeWorkflow("workflow:worktree:compare", projectRoot, [request]);
    if (
      !isRecord(result) ||
      !hasExactKeys(result, ["protocolVersion", "comparison", "recording"]) ||
      !Number.isSafeInteger(result.protocolVersion) ||
      (result.protocolVersion as number) < 1
    ) {
      throw new Error(INVALID_VARIANT_COMPARISON_EVIDENCE_ERROR);
    }
    const comparison = parseVariantComparisonEvidence(result.comparison);
    const recording = parseWorkflowVariantComparisonRecordedEvidence(result.recording);
    if (
      recording.sessionId !== request.sessionId ||
      recording.left.worktreeId !== request.leftWorktreeId ||
      recording.right.worktreeId !== request.rightWorktreeId ||
      JSON.stringify(recording.comparison) !== JSON.stringify(comparison)
    ) throw new Error(INVALID_VARIANT_COMPARISON_EVIDENCE_ERROR);
    return {
      protocolVersion: result.protocolVersion as number,
      comparison,
      recording,
    };
  },
  adoptWorktree: (projectRoot: string, input: unknown) => invokeWorkflow("workflow:worktree:adopt", projectRoot, [input]),
  cleanWorktree: (projectRoot: string, input: unknown) => invokeWorkflow("workflow:worktree:clean", projectRoot, [input]),
  createDeliveryCommit: (projectRoot: string, input: unknown) =>
    invokeWorkflow("workflow:delivery:commit", projectRoot, [input]),
  pushDeliveryBranch: (projectRoot: string, input: unknown) =>
    invokeWorkflow("workflow:delivery:push", projectRoot, [input], "optional"),
  createPullRequest: (projectRoot: string, input: unknown) =>
    invokeWorkflow("workflow:pullRequest:create", projectRoot, [input], "optional"),
  checkPullRequest: (projectRoot: string, input: unknown) =>
    invokeWorkflow("workflow:pullRequest:checks", projectRoot, [input]),
  mergePullRequest: (projectRoot: string, input: unknown) =>
    invokeWorkflow("workflow:pullRequest:merge", projectRoot, [input], "optional"),
  syncMain: (projectRoot: string, input: unknown) =>
    invokeWorkflow("workflow:delivery:syncMain", projectRoot, [input], "optional"),
  getChangeset: (projectRoot: string, input: unknown) => invokeWorkflow("workflow:changeset", projectRoot, [input]),
  reconcileFinalChangeset: (projectRoot: string, input: unknown) =>
    invokeWorkflow("workflow:changeset:reconcileFinal", projectRoot, [input]),
} satisfies WorkflowApi;

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

function hasExactKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
  const actual = Object.keys(value);
  return actual.length === keys.length && actual.every((key) => keys.includes(key));
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
  createWorkflowSession: workflow.createSession,
  finishPlanWorkflow: workflow.finishPlan,
  appendWorkflowUserInput: workflow.appendUserInput,
  getWorkflowLedger: workflow.getLedger,
  getChangeset: (projectRoot: string, node: unknown) => ipcRenderer.invoke("changeset:get", projectRoot, node),
  reconcileFinalChangeset: workflow.reconcileFinalChangeset,
  getWorkflowProjection: workflow.getProjection,
  getWorkflowEvents: workflow.getEvents,
  createWorkflowDeliveryCommit: workflow.createDeliveryCommit,
  pushWorkflowDeliveryBranch: workflow.pushDeliveryBranch,
  createWorkflowPullRequest: workflow.createPullRequest,
  checkWorkflowPullRequest: workflow.checkPullRequest,
  mergeWorkflowPullRequest: workflow.mergePullRequest,
  syncWorkflowMain: workflow.syncMain,
  workflow,
  terminal,
  plan,
  onRunEvent: (listener: (event: unknown) => void) => {
    const handler = (_event: Electron.IpcRendererEvent, value: unknown) => listener(value);
    ipcRenderer.on("run:event", handler);
    return () => ipcRenderer.removeListener("run:event", handler);
  },
  onWorkflowEvent: (listener: (event: unknown) => void) => {
    const handler = (_event: Electron.IpcRendererEvent, value: unknown) => {
      try {
        listener(parseWorkflowBroadcastEnvelope(value));
      } catch {}
    };
    ipcRenderer.on(WORKFLOW_EVENT_CHANNEL, handler);
    return () => ipcRenderer.removeListener(WORKFLOW_EVENT_CHANNEL, handler);
  },
  onPlanEvent: (listener: (event: PlanEvent) => void) => {
    const handler = (_event: Electron.IpcRendererEvent, value: PlanEvent) => listener(value);
    ipcRenderer.on("plan:event", handler);
    return () => ipcRenderer.removeListener("plan:event", handler);
  },
});
