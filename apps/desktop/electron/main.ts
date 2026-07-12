import { app, BrowserWindow, dialog, ipcMain, shell } from "electron";
import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";

import {
  DEVFLOW_DIRECTORIES,
  DEVFLOW_FILES,
  defaultDevflowFileContent,
} from "@skyturn/project-memory";
import type { AgentDescriptor, WorkflowWorktreeIdentity } from "@skyturn/project-core" with { "resolution-mode": "import" };
import {
  isTrustedPlannerRootStartInput,
  normalizeWorkflowIpcError,
  rejectMissingWorkflowProjectionNode,
  workflowIpcError,
  workflowStartInputError,
  type WorkflowIpcErrorCode,
} from "./workflowIpcContracts";
import { compareWorkflowWorktrees } from "./worktreeComparisonRuntime";
import { createTerminalRuntime } from "./terminalRuntime";
import {
  normalizeTerminalIpcError,
  terminalCancelInputError,
  terminalIpcError,
  terminalResizeInputError,
  terminalSnapshotInputError,
  terminalStartInputError,
  terminalWriteInputError,
  type TerminalActionResult,
  type TerminalCancelInput,
  type TerminalRendererEvent,
  type TerminalResizeInput,
  type TerminalSnapshotInput,
  type TerminalSnapshotResult,
  type TerminalStartInput,
  type TerminalStartResult,
  type TerminalWriteInput,
} from "./terminalIpcContracts";

const execFileAsync = promisify(execFile);

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
  target?: unknown;
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

interface WorkflowFinalChangesetInput {
  node?: unknown;
  target?: unknown;
  baselineRef?: unknown;
  runEvents?: unknown;
}

interface WorkflowDeliveryCommitInput {
  sessionId?: unknown;
  laneId?: unknown;
  segmentId?: unknown;
  worktreePath?: unknown;
  files?: unknown;
  subject?: unknown;
  body?: unknown;
  acceptMismatch?: unknown;
}

interface WorkflowDeliveryPushInput {
  sessionId?: unknown;
  laneId?: unknown;
  segmentId?: unknown;
  worktreePath?: unknown;
  remote?: unknown;
  commitSha?: unknown;
  branch?: unknown;
}

interface WorkflowPullRequestCreateInput {
  sessionId?: unknown;
  laneId?: unknown;
  commitLaneId?: unknown;
  segmentId?: unknown;
  worktreePath?: unknown;
  remote?: unknown;
  baseBranch?: unknown;
  headBranch?: unknown;
  commitSha?: unknown;
  title?: unknown;
  body?: unknown;
  whatChanged?: unknown;
  why?: unknown;
  breakingChanges?: unknown;
  serverPr?: unknown;
}

interface WorkflowPullRequestChecksInput {
  sessionId?: unknown;
  laneId?: unknown;
  prNumber?: unknown;
  prUrl?: unknown;
  expectedHeadSha?: unknown;
}

interface WorkflowPullRequestMergeInput {
  sessionId?: unknown;
  laneId?: unknown;
  prNumber?: unknown;
  prUrl?: unknown;
  expectedHeadSha?: unknown;
  subject?: unknown;
  title?: unknown;
  body?: unknown;
}

interface WorkflowDeliverySyncMainInput {
  sessionId?: unknown;
  laneId?: unknown;
  prNumber?: unknown;
  prUrl?: unknown;
  expectedHeadSha?: unknown;
  mainBranch?: unknown;
  remote?: unknown;
}

interface WorkflowCheckpointInput {
  sessionId?: unknown;
  nodeId?: unknown;
  laneId?: unknown;
  runId?: unknown;
  phase?: unknown;
}

interface WorkflowRollbackInput {
  sessionId?: unknown;
  nodeId?: unknown;
  laneId?: unknown;
  checkpointId?: unknown;
  requestId?: unknown;
  now?: unknown;
}

interface WorkflowCheckpointSuccessorInput {
  sessionId?: unknown;
  nodeId?: unknown;
  laneId?: unknown;
  checkpointId?: unknown;
  intentId?: unknown;
  successorLaneId?: unknown;
  successorSemanticKey?: unknown;
  title?: unknown;
  instruction?: unknown;
  text?: unknown;
  now?: unknown;
}

interface FinalSessionTarget {
  executionTarget: "current_branch" | "new_worktree";
  selectedBranch: string;
  baseRef?: string;
}

interface StructuredRunChange {
  operation: "add" | "delete" | "update" | "move";
  path: string;
  previousPath?: string;
  unifiedDiff?: string;
}

interface LiveRunChangesEvidence {
  source: "codex";
  status: "available";
  files: string[];
  changes: StructuredRunChange[];
  patchPreview?: string;
  patchPreviewTruncated?: boolean;
  collectedAt?: string;
}

interface FlowProjectionLike {
  projectionNodes: Array<{
    id: string;
    laneId?: string;
    decisionId?: string;
    executable: boolean;
  }>;
}

interface WorkflowDeliveryFlowProjectionLike {
  lanes: Array<{
    id: string;
    laneKind?: string;
    rollbackStatus?: string;
  }>;
  edges?: Array<{
    sourceLaneId?: string;
    targetLaneId?: string;
  }>;
  laneRollbackStatuses?: Record<string, unknown>;
}

interface DeliveryCommitEvidenceLike {
  commitSha: string;
  branch: string;
  worktreePath: string;
}

interface RecordedRollbackHead {
  commitSha: string;
  branchName?: string;
}

interface DeliveryPushEvidenceLike {
  remote: string;
  branch: string;
  commitSha: string;
}

interface DeliveryPullRequestEvidenceLike {
  number: number;
  url: string;
  commitSha: string;
  commitLaneId?: string;
  headBranch?: string;
}

interface DeliveryPullRequestCurrentHeadEvidenceLike {
  headSha: string;
  headBranch?: string;
}

interface DeliveryPullRequestChecksEvidenceLike {
  status: string;
  headSha: string;
  reviewStatus: string;
}

interface DeliveryPullRequestMergeEvidenceLike {
  status: "merged";
  number: number;
  headSha: string;
}

interface GitChangesetLike {
  id: string;
  files: string[];
  diffStat: {
    added: number;
    changed: number;
    deleted: number;
  };
  patchPreview: string;
  source: "git";
}

type ManagedWorktreeWorkflowEventKind =
  | "workflow.worktree.create_requested"
  | "workflow.worktree.created"
  | "workflow.worktree.create_failed"
  | "workflow.worktree.clean_requested"
  | "workflow.worktree.cleaned"
  | "workflow.worktree.clean_failed"
  | "workflow.variant.adopt_requested"
  | "workflow.variant.adopted"
  | "workflow.variant.adopt_failed"
  | "workflow.variant.rejected";

interface ManagedWorktreeWorkflowEventLike {
  kind: ManagedWorktreeWorkflowEventKind;
  source: "git-worktree";
  payload: Record<string, unknown>;
  createdAt: string;
  idempotencyKey: string;
  sessionId?: string;
}

type WorkflowWorktreeIdentityLike = WorkflowWorktreeIdentity;

interface WorkflowVariantAdoptionLike {
  adoptionId: string;
  variantId: string;
  worktreeId: string;
  strategy: "merge" | "cherry-pick";
  status: "requested" | "adopted" | "failed" | "rejected";
  baseCommit: string;
  headCommit: string;
  targetBranchName: string;
  adoptedCommit?: string;
  failureReason?: string;
}

interface LocalRollbackSafety {
  status: "safe" | "manual_repair_required" | "not_required" | "already_restored" | "already_applied";
  reasonCode?: string;
  message?: string;
  worktreePath?: string;
  restoreCommitRef?: string;
  expectedBranchName?: string;
  expectedHeadCommit?: string;
  requestId?: string;
  requestedEvent?: unknown;
  event?: unknown;
}

interface WorkflowRollbackEligibilityLike {
  eligible?: boolean;
  targetLaneId?: string;
  targetNodeId?: string;
  checkpointId?: string;
  checkpointPhase?: string;
  restoreCommitRef?: string;
  affectedLaneIds?: string[];
  affectedNodeIds?: string[];
  downstreamInactiveLaneIds?: string[];
  downstreamInactiveNodeIds?: string[];
  blockingRemoteSideEffects?: unknown[];
  localRollbackSafe?: boolean;
  localSafetyStatus?: string;
  manualRepairReason?: string;
  reason?: string;
}

interface WorkflowRollbackResultLike {
  status?: unknown;
  event?: unknown;
  requestedEvent?: unknown;
  eligibility?: WorkflowRollbackEligibilityLike;
  blockedReason?: unknown;
  manualRepairRequired?: unknown;
}

interface WorkflowCheckpointSuccessorResultLike {
  event?: unknown;
  projection?: unknown;
}

type InFlightRemoteSideEffectKind =
  | "workflow.delivery.pushed"
  | "workflow.pull_request.created"
  | "workflow.pull_request.merged"
  | "workflow.delivery.main_synced";

interface InFlightRemoteSideEffect {
  eventKind: InFlightRemoteSideEffectKind;
  status: "in_flight";
  eventId: string;
  projectRoot: string;
  sessionId: string;
  laneId?: string;
  affectedLaneIds?: string[];
  sessionWide?: boolean;
  createdAt: string;
}

interface DurableRemoteSideEffect {
  operationId: string;
  requestedEvent: unknown;
  complete(status: "succeeded" | "failed", details?: Record<string, unknown>): unknown;
  endInFlight(): void;
}

interface RemoteSideEffectOperation {
  projectRoot: string;
  sessionId: string;
  eventKind: InFlightRemoteSideEffectKind;
  operationKey: string;
  laneId?: string;
  affectedLaneIds?: string[];
  sessionWide?: boolean;
  details?: Record<string, unknown>;
}

interface UnresolvedRemoteSideEffectBlock {
  requestedEvent: unknown;
  operationId: string;
  operationKey?: string;
  eventKind: InFlightRemoteSideEffectKind;
  laneId?: string;
  affectedLaneIds?: string[];
  sessionWide?: boolean;
  createdAt?: string;
}

interface RollbackRequestedEventMatch {
  requestId: string;
  event: unknown;
}

interface RollbackAppliedEventMatch extends RollbackRequestedEventMatch {
  requestedEvent: unknown;
}

interface RollbackRequestedEventValidation {
  valid: boolean;
  message?: string;
}

interface ManagedRollbackWorktree {
  path: string;
  branchName?: string;
}

const RUN_PROTOCOL_VERSION = 1;
const openedProjectRoots = new Set<string>();
let agentBridge: AgentBridgeHost | null = null;
const workflowStores = new Map<string, WorkflowStoreHost>();
const inFlightRemoteSideEffects = new Map<string, InFlightRemoteSideEffect>();
const workflowSessionMutationLocks = new Map<string, Promise<void>>();
let remoteSideEffectSequence = 0;
const terminalRuntime = createTerminalRuntime({
  protocolVersion: RUN_PROTOCOL_VERSION,
  featureEnabled: terminalPtyFeatureEnabled,
  broadcastEvent: broadcastTerminalEvent,
});

interface AgentBridgeHost {
  discoverAgents(): Promise<AgentDescriptor[]>;
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
  listNodeCheckpoints(input: unknown): unknown[];
  getNodeRollbackEligibility(input: unknown): WorkflowRollbackEligibilityLike;
  applyNodeRollback(input: unknown): WorkflowRollbackResultLike;
  requestNodeRepair(input: unknown): WorkflowCheckpointSuccessorResultLike;
  requestNodeVariant(input: unknown): WorkflowCheckpointSuccessorResultLike;
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

ipcMain.handle("project:branchFacts", async (_event, projectRoot: string) => {
  assertKnownProjectRoot(projectRoot);
  const { getGitBranchFacts } = await import("@skyturn/git-worktree/node");
  const realProjectRoot = await fs.realpath(projectRoot).catch(() => projectRoot);
  const facts = await getGitBranchFacts(realProjectRoot);
  return { protocolVersion: RUN_PROTOCOL_VERSION, ...facts };
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
  const agents = await bridge.discoverAgents();
  const { summarizeAgentReadiness } = await import("@skyturn/project-core");
  return {
    protocolVersion: RUN_PROTOCOL_VERSION,
    agents,
    readiness: summarizeAgentReadiness(agents),
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

ipcMain.handle("terminal:start", terminalHandler(async (input: unknown): Promise<TerminalStartResult> => {
  const normalized = assertTerminalStartInput(input);
  assertKnownProjectRoot(normalized.projectRoot);
  return terminalRuntime.start(normalized);
}));

ipcMain.handle("terminal:write", terminalHandler(async (input: unknown): Promise<TerminalActionResult> => {
  const normalized = assertTerminalWriteInput(input);
  return terminalRuntime.write(normalized);
}));

ipcMain.handle("terminal:resize", terminalHandler(async (input: unknown): Promise<TerminalActionResult> => {
  const normalized = assertTerminalResizeInput(input);
  return terminalRuntime.resize(normalized);
}));

ipcMain.handle("terminal:cancel", terminalHandler(async (input: unknown): Promise<TerminalActionResult> => {
  const normalized = assertTerminalCancelInput(input);
  return terminalRuntime.cancel(normalized);
}));

ipcMain.handle("terminal:snapshot", terminalHandler(async (input: unknown): Promise<TerminalSnapshotResult> => {
  const normalized = assertTerminalSnapshotInput(input);
  return terminalRuntime.snapshot(normalized);
}));

ipcMain.handle("workflow:createSession", async (_event, projectRoot: string, input: WorkflowSessionCreateInput) => {
  assertKnownProjectRoot(projectRoot);
  const sessionId = assertWorkflowSessionId(input.id ?? input.sessionId);
  const store = await getWorkflowStore(projectRoot);
  const inputOpaqueHandle = optionalText(input.opaqueHandle);
  const opaqueHandle = inputOpaqueHandle ?? `skyturn-ipc:${sessionId}`;
  const hermesSessionHandle = explicitHermesSessionHandle(inputOpaqueHandle);
  const session = store.createWorkflowSession({
    id: sessionId,
    projectId: optionalText(input.projectId) ?? path.basename(projectRoot),
    title: optionalText(input.title) ?? "Workflow session",
    goal: requireText(input.goal, "workflow session goal"),
    mode: input.mode === "plan" ? "plan" : "fast",
    target: normalizeWorkflowSessionTarget(input.target),
    plannerProfile: optionalText(input.plannerProfile) ?? "default",
    transport: normalizeHermesTransport(input.transport),
    processId: typeof input.processId === "number" ? input.processId : undefined,
    opaqueHandle,
    recoveryReason: optionalText(input.recoveryReason),
    now: optionalText(readField(input, "now")) ?? new Date().toISOString(),
  });
  const materializedSession = store.materializeCanvasSession(sessionId);
  await terminalRuntime.startHermesPlannerForWorkflowSession({
    projectRoot,
    canvasSessionId: sessionId,
    runId: `hermes-planner-${sessionId}`,
    plannerSessionId: isRecord(materializedSession) ? optionalText(materializedSession.hermesPlannerSessionId) ?? undefined : undefined,
    ...(hermesSessionHandle ? { hermesSessionHandle } : {}),
  });
  return {
    protocolVersion: RUN_PROTOCOL_VERSION,
    session,
    projection: store.materializeFlowProjection(sessionId),
    canvasSession: materializeRendererCanvasSession(store, sessionId),
  };
});

ipcMain.handle("workflow:appendUserInput", async (_event, projectRoot: string, input: WorkflowAppendUserInput) => {
  assertKnownProjectRoot(projectRoot);
  const sessionId = assertWorkflowSessionId(input.sessionId);
  const store = await getWorkflowStore(projectRoot);
  const text = requireText(input.text, "workflow user input");
  const event = store.appendUserInput({
    sessionId,
    inputId: optionalText(input.inputId) ?? optionalText(input.idempotencyKey) ?? `input-${Date.now()}`,
    text,
    now: optionalText(input.now) ?? new Date().toISOString(),
  });
  await terminalRuntime.sendWorkflowUserInput(sessionId, `${text}\n`);
  broadcastWorkflowProjection(projectRoot, sessionId, store);
  return {
    protocolVersion: RUN_PROTOCOL_VERSION,
    event,
    ledger: store.buildLedgerSummary(sessionId),
    projection: store.materializeFlowProjection(sessionId),
    canvasSession: materializeRendererCanvasSession(store, sessionId),
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

ipcMain.handle("workflow:changeset:reconcileFinal", workflowHandler(async (projectRoot: string, input: WorkflowFinalChangesetInput) => {
  assertKnownProjectRoot(projectRoot);
  if (!isRecord(input)) throw workflowIpcError("INVALID_INPUT", "Final changeset input must be an object.");
  if (!isRecord(input.target)) throw workflowIpcError("INVALID_INPUT", "Canvas session target is required.");
  const { createGitChangesetService } = await import("@skyturn/git-worktree/node");
  const realProjectRoot = await fs.realpath(projectRoot);
  const service = createGitChangesetService({ repoRoot: realProjectRoot });
  type ReconcileInput = Parameters<typeof service.reconcileFinalChangeset>[0];
  const node = await normalizeChangesetNodeForProject(realProjectRoot, input.node) as ReconcileInput["node"];
  const target = normalizeFinalSessionTarget(input.target) as ReconcileInput["target"];
  const liveChanges = liveChangesFromRunEvents(input.runEvents) as ReconcileInput["liveChanges"];
  const baselineRef = optionalText(input.baselineRef);
  const reconciliation = await service.reconcileFinalChangeset({
    node,
    target,
    ...(baselineRef ? { baselineRef } : {}),
    ...(liveChanges ? { liveChanges } : {}),
  });
  return { protocolVersion: RUN_PROTOCOL_VERSION, reconciliation };
}));

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
    canvasSession: materializeRendererCanvasSession(store, sessionId),
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
    canvasSession: materializeRendererCanvasSession(store, workflowSessionId),
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
    canvasSession: materializeRendererCanvasSession(store, sessionId),
  };
});

ipcMain.handle("workflow:projection", workflowHandler(async (projectRoot: string, sessionId: string) => {
  assertKnownProjectRoot(projectRoot);
  const workflowSessionId = assertWorkflowSessionId(sessionId);
  const store = await getWorkflowStore(projectRoot);
  return {
    protocolVersion: RUN_PROTOCOL_VERSION,
    projection: store.materializeFlowProjection(workflowSessionId),
    canvasSession: materializeRendererCanvasSession(store, workflowSessionId),
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

ipcMain.handle("workflow:checkpoints", workflowHandler(async (projectRoot: string, input: WorkflowCheckpointInput) => {
  assertKnownProjectRoot(projectRoot);
  if (!isRecord(input)) throw workflowIpcError("INVALID_INPUT", "Workflow checkpoint input must be an object.");
  const sessionId = assertWorkflowSessionId(readField(input, "sessionId"));
  const store = await getWorkflowStore(projectRoot);
  assertKnownWorkflowCanvasSession(store, sessionId);
  return {
    protocolVersion: RUN_PROTOCOL_VERSION,
    checkpoints: store.listNodeCheckpoints({
      sessionId,
      ...(optionalText(readField(input, "nodeId")) ? { nodeId: optionalText(readField(input, "nodeId")) } : {}),
      ...(optionalText(readField(input, "laneId")) ? { laneId: optionalText(readField(input, "laneId")) } : {}),
      ...(optionalText(readField(input, "runId")) ? { runId: optionalText(readField(input, "runId")) } : {}),
      ...(readField(input, "phase") === "before" || readField(input, "phase") === "after" ? { phase: readField(input, "phase") } : {}),
    }),
  };
}));

ipcMain.handle("workflow:rollback:eligibility", workflowHandler(async (projectRoot: string, input: WorkflowRollbackInput) => {
  assertKnownProjectRoot(projectRoot);
  const normalized = normalizeWorkflowRollbackInput(input);
  const store = await getWorkflowStore(projectRoot);
  assertKnownWorkflowCanvasSession(store, normalized.sessionId);
  const workflowProjectRoot = await workflowStoreIdentity(projectRoot);
  const eligibility = store.getNodeRollbackEligibility(normalized);
  const inFlightBlocks = blockingInFlightRemoteSideEffects(workflowProjectRoot, normalized.sessionId, eligibility);
  if (inFlightBlocks.length > 0) {
    const blockedEligibility = rollbackEligibilityWithInFlightRemoteBlocks(eligibility, inFlightBlocks);
    return {
      protocolVersion: RUN_PROTOCOL_VERSION,
      eligibility: blockedEligibility,
      blockedReason: inFlightRemoteSideEffectBlockReason(blockedEligibility, inFlightBlocks),
      manualRepairRequired: false,
    };
  }
  const localSafety = await evaluateLocalRollbackSafetyForRollback(projectRoot, store, normalized, eligibility);
  const manualRepairRequired = localSafety.status === "manual_repair_required";
  const blockedReason = manualRepairRequired
    ? localRollbackSafetyResult(localSafety)
    : workflowRollbackBlockReason(eligibility);
  return {
    protocolVersion: RUN_PROTOCOL_VERSION,
    eligibility: manualRepairRequired ? rollbackEligibilityWithManualRepair(eligibility, localSafety.message) : eligibility,
    blockedReason,
    manualRepairRequired,
  };
}));

ipcMain.handle("workflow:rollback:apply", workflowHandler(async (projectRoot: string, input: WorkflowRollbackInput) => {
  assertKnownProjectRoot(projectRoot);
  const normalized = normalizeWorkflowRollbackInput(input);
  const store = await getWorkflowStore(projectRoot);
  assertKnownWorkflowCanvasSession(store, normalized.sessionId);
  const workflowProjectRoot = await workflowStoreIdentity(projectRoot);
  return await withWorkflowSessionMutationLock(workflowProjectRoot, normalized.sessionId, async () => {
    const initialRemoteBlock = evaluateRollbackRemoteBlocksForRollback(workflowProjectRoot, store, normalized);
    if (initialRemoteBlock.result) return workflowRollbackResponse(store, normalized.sessionId, initialRemoteBlock.result);
    const eligibility = initialRemoteBlock.eligibility;
    const localSafety = await evaluateLocalRollbackSafetyForRollback(projectRoot, store, normalized, eligibility);
    if (localSafety.status === "already_applied" && localSafety.event) {
      broadcastWorkflowProjection(projectRoot, normalized.sessionId, store);
      return workflowRollbackResponse(store, normalized.sessionId, {
        status: "applied",
        event: localSafety.event,
        requestedEvent: localSafety.requestedEvent,
        eligibility,
      });
    }
    if (localSafety.status === "already_restored" && localSafety.requestId) {
      const recoveryRemoteBlock = evaluateRollbackRemoteBlocksForRollback(workflowProjectRoot, store, normalized);
      if (recoveryRemoteBlock.result) return workflowRollbackResponse(store, normalized.sessionId, recoveryRemoteBlock.result);
      const finalEligibility = recoveryRemoteBlock.eligibility;
      const event = appendRollbackAppliedEvent(store, normalized, finalEligibility, localSafety.requestId);
      broadcastWorkflowProjection(projectRoot, normalized.sessionId, store);
      return workflowRollbackResponse(store, normalized.sessionId, {
        status: "applied",
        event,
        requestedEvent: localSafety.requestedEvent,
        eligibility: finalEligibility,
      });
    }
    if (localSafety.status === "manual_repair_required") {
      const event = appendRollbackRejectedEvent(store, normalized, eligibility, localSafety);
      broadcastWorkflowProjection(projectRoot, normalized.sessionId, store);
      return workflowRollbackResponse(store, normalized.sessionId, {
        status: "blocked",
        event,
        eligibility: rollbackEligibilityWithManualRepair(eligibility, localSafety.message),
        blockedReason: localRollbackSafetyResult(localSafety),
        manualRepairRequired: true,
      });
    }
    if (
      localSafety.status !== "safe" ||
      !localSafety.worktreePath ||
      !localSafety.restoreCommitRef ||
      !localSafety.expectedBranchName ||
      !localSafety.expectedHeadCommit
    ) {
      const result = store.applyNodeRollback(normalized);
      return workflowRollbackResponse(store, normalized.sessionId, result);
    }

    const { resetRollbackWorktreeToCommit } = await import("@skyturn/git-worktree/node");
    const finalRemoteBlock = evaluateRollbackRemoteBlocksForRollback(workflowProjectRoot, store, normalized);
    if (finalRemoteBlock.result) return workflowRollbackResponse(store, normalized.sessionId, finalRemoteBlock.result);
    const finalEligibility = finalRemoteBlock.eligibility;
    const existingRollbackRequest = findMatchingRollbackRequestedEvent(store, normalized, finalEligibility, localSafety.restoreCommitRef);
    const requested = existingRollbackRequest
      ?? findRollbackRequestedEventByIdempotencyKey(store, normalized.sessionId, normalized.requestId ?? rollbackRequestIdForIpc(normalized, finalEligibility))
      ?? appendRollbackRequestedEvent(store, normalized, finalEligibility);
    const requestedValidation = validateRollbackRequestedEventForIpc(store, normalized, finalEligibility, localSafety.restoreCommitRef, requested);
    if (!requestedValidation.valid) {
      const message = requestedValidation.message ?? "Rollback request idempotency collision requires manual repair.";
      const rejectedEvent = appendRollbackRejectedEvent(store, normalized, finalEligibility, {
        status: "manual_repair_required",
        reasonCode: "request_id_conflict",
        message,
      }, requested.requestId);
      broadcastWorkflowProjection(projectRoot, normalized.sessionId, store);
      return workflowRollbackResponse(store, normalized.sessionId, {
        status: "blocked",
        event: rejectedEvent,
        requestedEvent: requested.event,
        eligibility: rollbackEligibilityWithManualRepair(finalEligibility, message),
        blockedReason: {
          code: "manual_repair_required",
          message,
          reasonCode: "request_id_conflict",
          manualRepairRequired: true,
        },
        manualRepairRequired: true,
      });
    }
    const resetResult = await resetRollbackWorktreeToCommit({
      projectRoot,
      worktreePath: localSafety.worktreePath,
      expectedBranchName: localSafety.expectedBranchName,
      expectedHeadCommit: localSafety.expectedHeadCommit,
      restoreCommitRef: localSafety.restoreCommitRef,
    });
    if (resetResult.status !== "applied" && resetResult.status !== "already_restored") {
      const message = sanitizeSnippet(resetResult.message) || "Git reset failed; manual repair is required.";
      const rejectedEvent = appendRollbackRejectedEvent(store, normalized, finalEligibility, {
        status: "manual_repair_required",
        reasonCode: resetResult.reasonCode,
        message,
      }, requested.requestId);
      broadcastWorkflowProjection(projectRoot, normalized.sessionId, store);
      return workflowRollbackResponse(store, normalized.sessionId, {
        status: "blocked",
        event: rejectedEvent,
        requestedEvent: requested.event,
        eligibility: rollbackEligibilityWithManualRepair(finalEligibility, message),
        blockedReason: {
          code: "manual_repair_required",
          message,
          reasonCode: resetResult.reasonCode,
          manualRepairRequired: true,
        },
        manualRepairRequired: true,
      });
    }
    const event = appendRollbackAppliedEvent(store, normalized, finalEligibility, requested.requestId);
    broadcastWorkflowProjection(projectRoot, normalized.sessionId, store);
    return workflowRollbackResponse(store, normalized.sessionId, {
      status: "applied",
      event,
      requestedEvent: requested.event,
      eligibility: finalEligibility,
    });
  });
}));

ipcMain.handle("workflow:repair:create", workflowHandler(async (projectRoot: string, input: WorkflowCheckpointSuccessorInput) => {
  assertKnownProjectRoot(projectRoot);
  const normalized = normalizeCheckpointSuccessorInput(input);
  const store = await getWorkflowStore(projectRoot);
  assertKnownWorkflowCanvasSession(store, normalized.sessionId);
  const result = store.requestNodeRepair(normalized);
  broadcastWorkflowProjection(projectRoot, normalized.sessionId, store);
  return {
    protocolVersion: RUN_PROTOCOL_VERSION,
    status: "requested",
    event: result.event,
    projection: result.projection,
    canvasSession: materializeRendererCanvasSession(store, normalized.sessionId),
  };
}));

ipcMain.handle("workflow:variant:create", workflowHandler(async (projectRoot: string, input: WorkflowCheckpointSuccessorInput) => {
  assertKnownProjectRoot(projectRoot);
  const normalized = normalizeCheckpointSuccessorInput(input);
  const store = await getWorkflowStore(projectRoot);
  assertKnownWorkflowCanvasSession(store, normalized.sessionId);
  const result = store.requestNodeVariant(normalized);
  broadcastWorkflowProjection(projectRoot, normalized.sessionId, store);
  return {
    protocolVersion: RUN_PROTOCOL_VERSION,
    status: "requested",
    event: result.event,
    projection: result.projection,
    canvasSession: materializeRendererCanvasSession(store, normalized.sessionId),
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
    canvasSession: materializeRendererCanvasSession(store, sessionId),
  };
}));

ipcMain.handle("workflow:worktree:create", workflowHandler(async (projectRoot: string, input: unknown) => {
  assertKnownProjectRoot(projectRoot);
  const sessionId = requireWorktreeToken(readField(input, "sessionId"), "workflow session id");
  const variantId = requireWorktreeToken(readField(input, "variantId"), "workflow variant id");
  const baseRef = optionalText(readField(input, "baseRef")) ?? requireText(readField(input, "baseCommit"), "worktree base commit");
  const parentLaneId = requireText(readField(input, "parentLaneId"), "parent lane id");
  const parentSegmentId = optionalText(readField(input, "parentSegmentId"));
  const realProjectRoot = await fs.realpath(projectRoot);
  const repoRoot = await fs.realpath(path.resolve(optionalText(readField(input, "repoRoot")) ?? projectRoot));
  if (repoRoot !== realProjectRoot) throw workflowIpcError("UNKNOWN_PROJECT", "Worktree repoRoot must match the open project root.");
  const store = await getWorkflowStore(projectRoot);
  const branchName = `skyturn/${sessionId}/${variantId}`;
  const worktreeId = `worktree-${sessionId}-${variantId}`;
  const baseCommit = await resolveGitCommit(repoRoot, baseRef).catch((error) => {
    recordWorktreeCreateFailure(store, {
      sessionId,
      worktreeId,
      variantId,
      repoRoot,
      branchName,
      baseCommit: baseRef,
      parentLaneId,
      ...(parentSegmentId ? { parentSegmentId } : {}),
      reason: error instanceof Error ? error.message : String(error),
    });
    throw error;
  });
  const existingEvents = store.listEvents(sessionId);
  const appendedEvents: unknown[] = [];
  const { createNodeGitWorktreeService } = await import("@skyturn/git-worktree/node");
  const service = createNodeGitWorktreeService({
    initialEvents: managedWorktreeEventsFromStore(existingEvents),
    eventSink: {
      append: async (event) => {
        appendedEvents.push(store.appendWorkflowEvent({
          sessionId: event.sessionId ?? sessionId,
          kind: event.kind,
          source: event.source,
          idempotencyKey: event.idempotencyKey,
          payload: event.payload,
          now: event.createdAt,
        }));
      },
    },
  });
  try {
    const worktree = await service.createManagedWorktree({
      sessionId,
      variantId,
      repoRoot,
      baseCommit,
      branchName,
      parentLaneId,
      ...(parentSegmentId ? { parentSegmentId } : {}),
    });
    const event = findWorktreeCreatedEvent(appendedEvents, worktree.worktreeId)
      ?? findWorktreeCreatedEvent(store.listEvents(sessionId), worktree.worktreeId);
    broadcastWorkflowProjection(projectRoot, sessionId, store);
    return { protocolVersion: RUN_PROTOCOL_VERSION, status: "created", event, worktree };
  } catch (error) {
    broadcastWorkflowProjection(projectRoot, sessionId, store);
    throw error;
  }
}));

ipcMain.handle("workflow:worktree:compare", workflowHandler(async (projectRoot: string, input: unknown) => {
  return compareWorkflowWorktrees({
    assertKnownProjectRoot,
    getWorkflowStore,
    loadGitWorktreeModule: () => import("@skyturn/git-worktree/node"),
    canonicalPath: (value) => fs.realpath(value),
    protocolVersion: RUN_PROTOCOL_VERSION,
  }, projectRoot, input);
}));

ipcMain.handle("workflow:worktree:adopt", workflowHandler(async (projectRoot: string, input: unknown) => {
  assertKnownProjectRoot(projectRoot);
  const sessionId = requireWorktreeToken(readField(input, "sessionId"), "workflow session id");
  const adoption = workflowVariantAdoptionFromRecord(requireRecord(readField(input, "adoption"), "variant adoption"));
  const store = await getWorkflowStore(projectRoot);
  const existingEvents = store.listEvents(sessionId);
  try {
    const createdWorktree = findCreatedWorktreeIdentity(existingEvents, adoption.worktreeId);
    await assertAdoptedWorktreeBelongsToProject(projectRoot, createdWorktree);
  } catch (error) {
    recordVariantAdoptFailure(store, sessionId, adoption, error);
    broadcastWorkflowProjection(projectRoot, sessionId, store);
    throw normalizeWorkflowIpcError(error);
  }
  const appendedEvents: unknown[] = [];
  const { createNodeGitWorktreeService } = await import("@skyturn/git-worktree/node");
  const service = createNodeGitWorktreeService({
    initialEvents: managedWorktreeEventsFromStore(existingEvents),
    eventSink: {
      append: async (event) => {
        appendedEvents.push(store.appendWorkflowEvent({
          sessionId: event.sessionId ?? sessionId,
          kind: event.kind,
          source: event.source,
          idempotencyKey: event.idempotencyKey,
          payload: event.payload,
          now: event.createdAt,
        }));
      },
    },
  });
  try {
    const result = await service.adoptVariant(adoption);
    const event = findVariantAdoptionEvent(appendedEvents, result.adoptionId, result.status)
      ?? findVariantAdoptionEvent(store.listEvents(sessionId), result.adoptionId, result.status);
    broadcastWorkflowProjection(projectRoot, sessionId, store);
    return { protocolVersion: RUN_PROTOCOL_VERSION, status: result.status, event, adoption: result };
  } catch (error) {
    broadcastWorkflowProjection(projectRoot, sessionId, store);
    throw normalizeWorkflowIpcError(error);
  }
}));

ipcMain.handle("workflow:worktree:clean", workflowHandler(async (projectRoot: string, input: unknown) => {
  assertKnownProjectRoot(projectRoot);
  const sessionId = requireWorktreeToken(readField(input, "sessionId"), "workflow session id");
  const worktree = workflowWorktreeIdentityFromRecord(requireRecord(readField(input, "worktree"), "worktree identity"));
  const store = await getWorkflowStore(projectRoot);
  try {
    await assertCleanWorktreeBelongsToProject(projectRoot, worktree);
  } catch (error) {
    recordWorktreeCleanFailure(store, sessionId, worktree, error);
    broadcastWorkflowProjection(projectRoot, sessionId, store);
    throw normalizeWorkflowIpcError(error);
  }
  const existingEvents = store.listEvents(sessionId);
  const appendedEvents: unknown[] = [];
  const { createNodeGitWorktreeService } = await import("@skyturn/git-worktree/node");
  const service = createNodeGitWorktreeService({
    initialEvents: managedWorktreeEventsFromStore(existingEvents),
    eventSink: {
      append: async (event) => {
        appendedEvents.push(store.appendWorkflowEvent({
          sessionId: event.sessionId ?? sessionId,
          kind: event.kind,
          source: event.source,
          idempotencyKey: event.idempotencyKey,
          payload: event.payload,
          now: event.createdAt,
        }));
      },
    },
    runState: {
      hasRunningTasks: async (candidate) => hasRunningTasksForWorktree(store, sessionId, candidate),
    },
  });
  try {
    const result = await service.cleanManagedWorktree({
      worktree,
      deleteBranch: readField(input, "deleteBranch") === true,
    });
    const event = findWorktreeCleanedEvent(appendedEvents, result.worktreeId)
      ?? findWorktreeCleanedEvent(store.listEvents(sessionId), result.worktreeId);
    broadcastWorkflowProjection(projectRoot, sessionId, store);
    return { protocolVersion: RUN_PROTOCOL_VERSION, status: "cleaned", event, result };
  } catch (error) {
    broadcastWorkflowProjection(projectRoot, sessionId, store);
    throw error;
  }
}));

ipcMain.handle("workflow:delivery:commit", workflowHandler(async (projectRoot: string, input: WorkflowDeliveryCommitInput) => {
  assertKnownProjectRoot(projectRoot);
  if (!isRecord(input)) throw workflowIpcError("INVALID_INPUT", "Delivery commit input must be an object.");
  const sessionId = assertWorkflowSessionId(readField(input, "sessionId"));
  const workflowProjectRoot = await workflowStoreIdentity(projectRoot);
  return await withWorkflowSessionMutationLock(workflowProjectRoot, sessionId, async () => {
    const store = await getWorkflowStore(projectRoot);
    assertKnownWorkflowCanvasSession(store, sessionId);
    const laneId = requireText(readField(input, "laneId"), "workflow commit laneId");
    assertWorkflowDeliveryCommitLane(store, sessionId, laneId);
    const realProjectRoot = await fs.realpath(projectRoot);
    const rawWorktreePath = optionalText(readField(input, "worktreePath"));
    const worktreePath = await resolveDeliveryCommitWorktreePath(store, sessionId, laneId, rawWorktreePath, realProjectRoot);
    const files = deliveryFilesFromInput(readField(input, "files"));
    const subject = requireText(readField(input, "subject"), "commit subject");
    const body = optionalText(readField(input, "body")) ?? undefined;
    const reconciliationStatus = deliveryReconciliationStatus(input);
    const acceptMismatch = readField(input, "acceptMismatch") === true;
    const { createDeliveryCommit } = await import("@skyturn/git-worktree/node");
    let evidence: Awaited<ReturnType<typeof createDeliveryCommit>>;
    try {
      evidence = await createDeliveryCommit({
        projectRoot: realProjectRoot,
        worktreePath,
        files,
        subject,
        ...(body ? { body } : {}),
        ...(reconciliationStatus ? { reconciliationStatus } : {}),
        ...(acceptMismatch ? { acceptMismatch } : {}),
      });
    } catch (error) {
      throw normalizeDeliveryCommitIpcError(error);
    }

    const segmentId = optionalText(readField(input, "segmentId"));
    const event = store.appendWorkflowEvent({
      sessionId,
      kind: "workflow.commit.created",
      source: "electron-main",
      laneId,
      segmentId,
      idempotencyKey: `delivery-commit:${evidence.commitSha}`,
      payload: {
        laneId,
        ...(segmentId ? { segmentId } : {}),
        evidence,
      },
      now: new Date().toISOString(),
    });
    broadcastWorkflowProjection(projectRoot, sessionId, store);

    return { protocolVersion: RUN_PROTOCOL_VERSION, status: "committed", event, evidence };
  });
}));

ipcMain.handle("workflow:delivery:push", workflowHandler(async (projectRoot: string, input: WorkflowDeliveryPushInput) => {
  assertKnownProjectRoot(projectRoot);
  if (!isRecord(input)) throw workflowIpcError("INVALID_INPUT", "Delivery push input must be an object.");
  const sessionId = assertWorkflowSessionId(readField(input, "sessionId"));
  const realProjectRoot = await fs.realpath(projectRoot);
  const workflowProjectRoot = await workflowStoreIdentity(projectRoot);
  return await withWorkflowSessionMutationLock(workflowProjectRoot, sessionId, async () => {
    const store = await getWorkflowStore(projectRoot);
    assertKnownWorkflowCanvasSession(store, sessionId);
    const laneId = requireText(readField(input, "laneId"), "workflow commit laneId");
    assertWorkflowDeliveryCommitLane(store, sessionId, laneId);
    const rawWorktreePath = optionalText(readField(input, "worktreePath"));
    const worktreePath = await resolveDeliveryCommitWorktreePath(store, sessionId, laneId, rawWorktreePath, realProjectRoot);
    const segmentId = optionalText(readField(input, "segmentId"));
    const commitEvidence = await findDeliveryCommitEvidence(store, sessionId, laneId, segmentId, worktreePath);
    assertDeliveryEvidenceInputMatches(input, commitEvidence);
    const remote = optionalText(readField(input, "remote"));
    const remoteEventKind = "workflow.delivery.pushed";
    const remoteDetails = {
      commitSha: commitEvidence.commitSha,
      branch: commitEvidence.branch,
      remote: remote ?? "origin",
    };
    const remoteOperation: RemoteSideEffectOperation = {
      projectRoot: workflowProjectRoot,
      sessionId,
      eventKind: remoteEventKind,
      laneId,
      affectedLaneIds: [laneId],
      operationKey: remoteSideEffectSemanticKey({ sessionId, eventKind: remoteEventKind, laneId, details: remoteDetails }),
      details: remoteDetails,
    };
    assertWorkflowRemoteMutationLanesActive(store, remoteOperation);
    const unresolvedRemoteBlock = unresolvedRemoteSideEffectBlockForRetry(store, remoteOperation);
    if (unresolvedRemoteBlock) return remoteSideEffectManualResolutionResponse(store, sessionId, unresolvedRemoteBlock);
    const { pushDeliveryBranch } = await import("@skyturn/git-worktree/node");
    let evidence: Awaited<ReturnType<typeof pushDeliveryBranch>>;
    const remoteSideEffect = beginDurableRemoteSideEffect(store, remoteOperation);
    try {
      try {
        evidence = await pushDeliveryBranch({
          projectRoot: realProjectRoot,
          worktreePath,
          commitSha: commitEvidence.commitSha,
          branch: commitEvidence.branch,
          ...(remote ? { remote } : {}),
        });
      } catch (error) {
        completeDurableRemoteSideEffectForKnownPreMutationFailure(remoteSideEffect, error);
        throw normalizeDeliveryRemoteIpcError(error);
      }

      const event = store.appendWorkflowEvent({
        sessionId,
        kind: "workflow.delivery.pushed",
        source: "electron-main",
        laneId,
        segmentId,
        idempotencyKey: `delivery-push:${evidence.remote}:${evidence.branch}:${evidence.commitSha}`,
        payload: {
          laneId,
          ...(segmentId ? { segmentId } : {}),
          evidence,
        },
        now: new Date().toISOString(),
      });
      remoteSideEffect.complete("succeeded", {
        ...(isRecord(event) && optionalText(event.id) ? { eventId: optionalText(event.id)! } : {}),
        evidence,
      });
      broadcastWorkflowProjection(projectRoot, sessionId, store);

      return { protocolVersion: RUN_PROTOCOL_VERSION, status: "pushed", event, evidence };
    } finally {
      remoteSideEffect.endInFlight();
    }
  });
}));

ipcMain.handle("workflow:pullRequest:create", workflowHandler(async (projectRoot: string, input: WorkflowPullRequestCreateInput) => {
  assertKnownProjectRoot(projectRoot);
  if (!isRecord(input)) throw workflowIpcError("INVALID_INPUT", "Pull request input must be an object.");
  const sessionId = assertWorkflowSessionId(readField(input, "sessionId"));
  const realProjectRoot = await fs.realpath(projectRoot);
  const workflowProjectRoot = await workflowStoreIdentity(projectRoot);
  return await withWorkflowSessionMutationLock(workflowProjectRoot, sessionId, async () => {
    const store = await getWorkflowStore(projectRoot);
    assertKnownWorkflowCanvasSession(store, sessionId);
    const laneId = requireText(readField(input, "laneId"), "workflow pull request laneId");
    const commitLaneId = requireText(readField(input, "commitLaneId"), "workflow commit laneId");
    assertWorkflowPullRequestLane(store, sessionId, laneId, commitLaneId);
    assertWorkflowDeliveryCommitLane(store, sessionId, commitLaneId);
    const rawWorktreePath = optionalText(readField(input, "worktreePath"));
    const worktreePath = await resolveDeliveryCommitWorktreePath(store, sessionId, commitLaneId, rawWorktreePath, realProjectRoot);
    const segmentId = optionalText(readField(input, "segmentId"));
    const commitEvidence = await findDeliveryCommitEvidence(store, sessionId, commitLaneId, null, worktreePath);
    assertDeliveryEvidenceInputMatches(input, commitEvidence);
    const remote = optionalText(readField(input, "remote"));
    const baseBranch = await validatePullRequestBaseBranch(
      store,
      sessionId,
      realProjectRoot,
      requireText(readField(input, "baseBranch"), "pull request base branch"),
      commitEvidence.branch,
      remote ?? "origin",
    );
    const title = requireText(readField(input, "title"), "pull request title");
    const remoteEventKind = "workflow.pull_request.created";
    const remoteDetails = {
      commitLaneId,
      commitSha: commitEvidence.commitSha,
      baseBranch,
      headBranch: commitEvidence.branch,
      remote: remote ?? "origin",
    };
    const remoteOperation: RemoteSideEffectOperation = {
      projectRoot: workflowProjectRoot,
      sessionId,
      eventKind: remoteEventKind,
      laneId,
      affectedLaneIds: [laneId, commitLaneId],
      operationKey: remoteSideEffectSemanticKey({ sessionId, eventKind: remoteEventKind, laneId, details: remoteDetails }),
      details: remoteDetails,
    };
    assertWorkflowRemoteMutationLanesActive(store, remoteOperation);
    const unresolvedRemoteBlock = unresolvedRemoteSideEffectBlockForRetry(store, remoteOperation);
    if (unresolvedRemoteBlock) return remoteSideEffectManualResolutionResponse(store, sessionId, unresolvedRemoteBlock);
    if (!findDeliveryPushEvidenceForPullRequest(store, sessionId, commitLaneId, commitEvidence, remote ?? "origin")) {
      return missingDeliveryPushEvidenceManualResolutionResponse(store, sessionId, commitLaneId, commitEvidence, remote ?? "origin");
    }
    const { createDeliveryPullRequest } = await import("@skyturn/git-worktree/node");
    let evidence: Awaited<ReturnType<typeof createDeliveryPullRequest>>;
    const remoteSideEffect = beginDurableRemoteSideEffect(store, remoteOperation);
    try {
      try {
        evidence = await createDeliveryPullRequest({
          projectRoot: realProjectRoot,
          worktreePath,
          commitSha: commitEvidence.commitSha,
          baseBranch,
          headBranch: commitEvidence.branch,
          title,
          ...(remote ? { remote } : {}),
          ...(optionalText(readField(input, "body")) ? { body: optionalText(readField(input, "body"))! } : {}),
          ...(optionalText(readField(input, "whatChanged")) ? { whatChanged: optionalText(readField(input, "whatChanged"))! } : {}),
          ...(optionalText(readField(input, "why")) ? { why: optionalText(readField(input, "why"))! } : {}),
          ...(optionalText(readField(input, "breakingChanges")) ? { breakingChanges: optionalText(readField(input, "breakingChanges"))! } : {}),
          ...(optionalText(readField(input, "serverPr")) ? { serverPr: optionalText(readField(input, "serverPr"))! } : {}),
        });
      } catch (error) {
        completeDurableRemoteSideEffectForKnownPreMutationFailure(remoteSideEffect, error);
        throw normalizeDeliveryRemoteIpcError(error);
      }

      const event = store.appendWorkflowEvent({
        sessionId,
        kind: "workflow.pull_request.created",
        source: "electron-main",
        laneId,
        segmentId,
        idempotencyKey: `pull-request:${evidence.url}`,
        payload: {
          laneId,
          commitLaneId,
          ...(segmentId ? { segmentId } : {}),
          evidence,
        },
        now: new Date().toISOString(),
      });
      remoteSideEffect.complete("succeeded", {
        ...(isRecord(event) && optionalText(event.id) ? { eventId: optionalText(event.id)! } : {}),
        evidence,
      });
      broadcastWorkflowProjection(projectRoot, sessionId, store);

      return { protocolVersion: RUN_PROTOCOL_VERSION, status: "created", event, evidence };
    } finally {
      remoteSideEffect.endInFlight();
    }
  });
}));

ipcMain.handle("workflow:pullRequest:checks", workflowHandler(async (projectRoot: string, input: WorkflowPullRequestChecksInput) => {
  assertKnownProjectRoot(projectRoot);
  if (!isRecord(input)) throw workflowIpcError("INVALID_INPUT", "Pull request checks input must be an object.");
  const sessionId = assertWorkflowSessionId(readField(input, "sessionId"));
  const store = await getWorkflowStore(projectRoot);
  assertKnownWorkflowCanvasSession(store, sessionId);
  const laneId = requireText(readField(input, "laneId"), "workflow pull request laneId");
  assertWorkflowPullRequestLaneKind(store, sessionId, laneId);
  const prEvidence = findDeliveryPullRequestEvidence(store, sessionId, laneId);
  const currentHead = findDeliveryPullRequestCurrentHeadEvidence(store, sessionId, laneId, prEvidence);
  const expectedHeadSha = assertDeliveryPullRequestEvidenceInputMatches(input, prEvidence, currentHead.headSha);
  const realProjectRoot = await fs.realpath(projectRoot);
  const { checkDeliveryPullRequest } = await import("@skyturn/git-worktree/node");
  let evidence: Awaited<ReturnType<typeof checkDeliveryPullRequest>>;
  try {
    evidence = await checkDeliveryPullRequest({
      projectRoot: realProjectRoot,
      prNumber: prEvidence.number,
      expectedHeadSha,
    });
  } catch (error) {
    throw normalizeDeliveryRemoteIpcError(error);
  }

  const event = store.appendWorkflowEvent({
    sessionId,
    kind: "workflow.pull_request.checks_recorded",
    source: "electron-main",
    laneId,
    idempotencyKey: `pull-request-checks:${evidence.number}:${evidence.headSha}:${evidence.status}:${evidence.review.status}`,
    payload: {
      laneId,
      prNumber: evidence.number,
      url: evidence.url ?? prEvidence.url,
      headSha: evidence.headSha,
      status: evidence.status,
      checks: evidence.checks,
      review: evidence.review,
      gate: evidence.gate,
      evidence,
    },
    now: new Date().toISOString(),
  });
  broadcastWorkflowProjection(projectRoot, sessionId, store);

  return { protocolVersion: RUN_PROTOCOL_VERSION, status: "checks_recorded", event, evidence };
}));

ipcMain.handle("workflow:pullRequest:merge", workflowHandler(async (projectRoot: string, input: WorkflowPullRequestMergeInput) => {
  assertKnownProjectRoot(projectRoot);
  if (!isRecord(input)) throw workflowIpcError("INVALID_INPUT", "Pull request merge input must be an object.");
  const sessionId = assertWorkflowSessionId(readField(input, "sessionId"));
  const realProjectRoot = await fs.realpath(projectRoot);
  const workflowProjectRoot = await workflowStoreIdentity(projectRoot);
  return await withWorkflowSessionMutationLock(workflowProjectRoot, sessionId, async () => {
    const store = await getWorkflowStore(projectRoot);
    assertKnownWorkflowCanvasSession(store, sessionId);
    const laneId = requireText(readField(input, "laneId"), "workflow pull request laneId");
    assertWorkflowPullRequestLaneKind(store, sessionId, laneId);
    const prEvidence = findDeliveryPullRequestEvidence(store, sessionId, laneId);
    const currentHead = findDeliveryPullRequestCurrentHeadEvidence(store, sessionId, laneId, prEvidence);
    const checksEvidence = findDeliveryPullRequestChecksEvidence(store, sessionId, laneId, currentHead.headSha);
    const expectedHeadSha = assertDeliveryPullRequestEvidenceInputMatches(input, prEvidence, currentHead.headSha);
    if (checksEvidence.headSha !== expectedHeadSha) {
      throw workflowIpcError("INVALID_INPUT", "Recorded pull request checks do not match the requested head SHA.");
    }
    const subject = requireText(readField(input, "subject") ?? readField(input, "title"), "pull request merge subject");
    assertConventionalCommitSubjectForIpc(subject);
    const body = optionalText(readField(input, "body")) ?? undefined;
    const remoteEventKind = "workflow.pull_request.merged";
    const remoteDetails = {
      prNumber: prEvidence.number,
      headSha: expectedHeadSha,
    };
    const remoteOperation: RemoteSideEffectOperation = {
      projectRoot: workflowProjectRoot,
      sessionId,
      eventKind: remoteEventKind,
      laneId,
      affectedLaneIds: [laneId],
      operationKey: remoteSideEffectSemanticKey({ sessionId, eventKind: remoteEventKind, laneId, details: remoteDetails }),
      details: remoteDetails,
    };
    assertWorkflowRemoteMutationLanesActive(store, remoteOperation);
    const unresolvedRemoteBlock = unresolvedRemoteSideEffectBlockForRetry(store, remoteOperation);
    if (unresolvedRemoteBlock) return remoteSideEffectManualResolutionResponse(store, sessionId, unresolvedRemoteBlock);
    const { mergeDeliveryPullRequest } = await import("@skyturn/git-worktree/node");
    let evidence: Awaited<ReturnType<typeof mergeDeliveryPullRequest>>;
    const remoteSideEffect = beginDurableRemoteSideEffect(store, remoteOperation);
    try {
      try {
        evidence = await mergeDeliveryPullRequest({
          projectRoot: realProjectRoot,
          prNumber: prEvidence.number,
          expectedHeadSha,
          subject,
          ...(body ? { body } : {}),
        });
      } catch (error) {
        completeDurableRemoteSideEffectForKnownPreMutationFailure(remoteSideEffect, error);
        throw normalizeDeliveryRemoteIpcError(error);
      }

      const event = store.appendWorkflowEvent({
        sessionId,
        kind: "workflow.pull_request.merged",
        source: "electron-main",
        laneId,
        idempotencyKey: `pull-request-merged:${evidence.number}:${evidence.headSha}`,
        payload: {
          laneId,
          evidence,
        },
        now: new Date().toISOString(),
      });
      remoteSideEffect.complete("succeeded", {
        ...(isRecord(event) && optionalText(event.id) ? { eventId: optionalText(event.id)! } : {}),
        evidence,
      });
      broadcastWorkflowProjection(projectRoot, sessionId, store);

      return { protocolVersion: RUN_PROTOCOL_VERSION, status: "merged", event, evidence };
    } finally {
      remoteSideEffect.endInFlight();
    }
  });
}));

ipcMain.handle("workflow:delivery:syncMain", workflowHandler(async (projectRoot: string, input: WorkflowDeliverySyncMainInput) => {
  assertKnownProjectRoot(projectRoot);
  if (!isRecord(input)) throw workflowIpcError("INVALID_INPUT", "Delivery sync main input must be an object.");
  const sessionId = assertWorkflowSessionId(readField(input, "sessionId"));
  const realProjectRoot = await fs.realpath(projectRoot);
  const workflowProjectRoot = await workflowStoreIdentity(projectRoot);
  return await withWorkflowSessionMutationLock(workflowProjectRoot, sessionId, async () => {
    const store = await getWorkflowStore(projectRoot);
    assertKnownWorkflowCanvasSession(store, sessionId);
    const laneId = requireText(readField(input, "laneId"), "workflow pull request laneId");
    assertWorkflowPullRequestLaneKind(store, sessionId, laneId);
    const prEvidence = findDeliveryPullRequestEvidence(store, sessionId, laneId);
    const currentHead = findDeliveryPullRequestCurrentHeadEvidence(store, sessionId, laneId, prEvidence);
    const expectedHeadSha = assertDeliveryPullRequestEvidenceInputMatches(input, prEvidence, currentHead.headSha);
    const mergeEvidence = findDeliveryPullRequestMergeEvidence(store, sessionId, laneId, prEvidence, expectedHeadSha);
    const remote = optionalText(readField(input, "remote"));
    const mainBranch = optionalText(readField(input, "mainBranch")) ?? "main";
    const remoteEventKind = "workflow.delivery.main_synced";
    const remoteDetails = {
      prNumber: mergeEvidence.number,
      headSha: mergeEvidence.headSha,
      mainBranch,
      remote: remote ?? "origin",
    };
    const remoteOperation: RemoteSideEffectOperation = {
      projectRoot: workflowProjectRoot,
      sessionId,
      eventKind: remoteEventKind,
      laneId,
      affectedLaneIds: [laneId],
      sessionWide: true,
      operationKey: remoteSideEffectSemanticKey({ sessionId, eventKind: remoteEventKind, laneId, sessionWide: true, details: remoteDetails }),
      details: remoteDetails,
    };
    assertWorkflowRemoteMutationLanesActive(store, remoteOperation);
    const unresolvedRemoteBlock = unresolvedRemoteSideEffectBlockForRetry(store, remoteOperation);
    if (unresolvedRemoteBlock) return remoteSideEffectManualResolutionResponse(store, sessionId, unresolvedRemoteBlock);
    const { syncDeliveryMain } = await import("@skyturn/git-worktree/node");
    let evidence: Awaited<ReturnType<typeof syncDeliveryMain>>;
    const remoteSideEffect = beginDurableRemoteSideEffect(store, remoteOperation);
    try {
      try {
        evidence = await syncDeliveryMain({
          projectRoot: realProjectRoot,
          mainBranch,
          ...(remote ? { remote } : {}),
        });
      } catch (error) {
        completeDurableRemoteSideEffectForKnownPreMutationFailure(remoteSideEffect, error);
        throw normalizeDeliveryRemoteIpcError(error);
      }

      const event = store.appendWorkflowEvent({
        sessionId,
        kind: "workflow.delivery.main_synced",
        source: "electron-main",
        laneId,
        payload: {
          sessionWide: true,
          laneId,
          prNumber: mergeEvidence.number,
          headSha: mergeEvidence.headSha,
          evidence,
        },
        now: new Date().toISOString(),
      });
      remoteSideEffect.complete("succeeded", {
        ...(isRecord(event) && optionalText(event.id) ? { eventId: optionalText(event.id)! } : {}),
        evidence,
      });
      broadcastWorkflowProjection(projectRoot, sessionId, store);

      return { protocolVersion: RUN_PROTOCOL_VERSION, status: "synced", event, evidence };
    } finally {
      remoteSideEffect.endInFlight();
    }
  });
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
  const storeIdentity = await workflowStoreIdentity(projectRoot);
  const existing = workflowStores.get(storeIdentity);
  if (existing) return existing;
  const { createWorkflowStore } = await import("@skyturn/persistence/workflow-store");
  const store = createWorkflowStore({ projectRoot: storeIdentity }) as WorkflowStoreHost;
  workflowStores.set(storeIdentity, store);
  return store;
}

async function workflowStoreIdentity(projectRoot: string): Promise<string> {
  return await fs.realpath(projectRoot).catch(() => path.resolve(projectRoot));
}

function broadcastWorkflowProjection(projectRoot: string, sessionId: string, store: WorkflowStoreHost): void {
  const projection = store.materializeFlowProjection(sessionId);
  const canvasSession = materializeRendererCanvasSession(store, sessionId);
  for (const window of BrowserWindow.getAllWindows()) {
    window.webContents.send("workflow:event", { projectRoot, sessionId, projection, canvasSession });
  }
}

function broadcastTerminalEvent(event: TerminalRendererEvent): void {
  for (const window of BrowserWindow.getAllWindows()) {
    window.webContents.send("terminal:event", event);
  }
}

function augmentCanvasSessionWithHermesTerminal(canvasSession: unknown, terminalSessionId: string | null): unknown {
  if (!terminalSessionId || !isRecord(canvasSession) || canvasSession.kind !== "canvas") return canvasSession;
  return {
    ...canvasSession,
    hermesPlannerTerminalSessionId: terminalSessionId,
  };
}

function materializeRendererCanvasSession(store: WorkflowStoreHost, sessionId: string): unknown {
  return augmentCanvasSessionWithHermesTerminal(
    store.materializeCanvasSession(sessionId),
    terminalRuntime.hermesPlannerTerminalSessionId(sessionId),
  );
}

function assertWorkflowSessionId(value: unknown): string {
  if (typeof value !== "string" || !value.trim()) throw new Error("Workflow sessionId is required.");
  return value;
}

function explicitHermesSessionHandle(value: unknown): string | undefined {
  const handle = optionalText(value);
  if (!handle || handle.startsWith("skyturn-ipc:")) return undefined;
  return handle;
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

function liveChangesFromRunEvents(value: unknown): LiveRunChangesEvidence | null {
  if (!Array.isArray(value)) return null;
  const changes: StructuredRunChange[] = [];
  const files: string[] = [];
  const patchPreviewParts: string[] = [];
  let patchPreviewTruncated = false;
  let collectedAt: string | undefined;

  for (const event of value) {
    if (!isRecord(event) || event.kind !== "changes" || !isRecord(event.payload)) continue;
    const payload = event.payload;
    if (payload.source !== "codex" || payload.status !== "available") continue;
    const eventChanges = structuredRunChangesFromValue(payload.changes);
    if (eventChanges.length === 0) continue;
    changes.push(...eventChanges);
    if (Array.isArray(payload.files)) {
      files.push(...payload.files.filter((file): file is string => typeof file === "string" && file.trim().length > 0));
    }
    files.push(...eventChanges.flatMap((change) => [change.previousPath, change.path]).filter((file): file is string => Boolean(file)));
    if (typeof payload.patchPreview === "string" && payload.patchPreview) patchPreviewParts.push(payload.patchPreview);
    if (payload.patchPreviewTruncated === true) patchPreviewTruncated = true;
    if (typeof event.timestamp === "string") collectedAt = event.timestamp;
  }

  const dedupedChanges = dedupeStructuredRunChanges(changes);
  if (dedupedChanges.length === 0) return null;
  const patchPreview = patchPreviewParts.join("\n");
  return {
    source: "codex",
    status: "available",
    files: uniqueStrings(files),
    changes: dedupedChanges,
    ...(patchPreview ? { patchPreview: truncatePatch(patchPreview) } : {}),
    ...(patchPreviewTruncated || patchPreview.length > 12000 ? { patchPreviewTruncated: true } : {}),
    ...(collectedAt ? { collectedAt } : {}),
  };
}

function normalizeFinalSessionTarget(value: Record<string, unknown>): FinalSessionTarget {
  const executionTarget = value.executionTarget === "new_worktree" ? "new_worktree" : "current_branch";
  const selectedBranch = optionalText(value.selectedBranch) ?? "HEAD";
  if (executionTarget === "current_branch") return { executionTarget, selectedBranch };
  const baseRef = optionalText(value.baseRef) ?? selectedBranch;
  return { executionTarget, selectedBranch, baseRef };
}

function normalizeWorkflowSessionTarget(value: unknown): FinalSessionTarget {
  if (!isRecord(value)) return { executionTarget: "current_branch", selectedBranch: "HEAD" };
  return normalizeFinalSessionTarget(value);
}

function structuredRunChangesFromValue(value: unknown): StructuredRunChange[] {
  if (!Array.isArray(value)) return [];
  return value.map(structuredRunChangeFromValue).filter((change): change is StructuredRunChange => Boolean(change));
}

function structuredRunChangeFromValue(value: unknown): StructuredRunChange | null {
  if (!isRecord(value)) return null;
  const operation = normalizeRunChangeOperation(value.operation);
  const pathValue = optionalText(value.path);
  if (!operation || !pathValue) return null;
  const previousPath = optionalText(value.previousPath);
  const unifiedDiff = optionalText(value.unifiedDiff);
  return {
    operation,
    path: pathValue,
    ...(previousPath ? { previousPath } : {}),
    ...(unifiedDiff ? { unifiedDiff } : {}),
  };
}

function normalizeRunChangeOperation(value: unknown): StructuredRunChange["operation"] | null {
  if (value === "add" || value === "delete" || value === "update" || value === "move") return value;
  return null;
}

function dedupeStructuredRunChanges(changes: StructuredRunChange[]): StructuredRunChange[] {
  const seen = new Set<string>();
  return changes.filter((change) => {
    const key = `${change.operation}\0${change.previousPath ?? ""}\0${change.path}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function isWorkflowEventRecord(event: unknown): event is Record<string, unknown> & { kind: string } {
  return Boolean(event) && typeof event === "object" && typeof (event as { kind?: unknown }).kind === "string" &&
    (event as { kind: string }).kind.startsWith("workflow.");
}

function redactWorkflowEventForRenderer(event: Record<string, unknown> & { kind: string }): Record<string, unknown> {
  const delivery = deliveryLifecycleFactsForRenderer(event);
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
      ...(delivery ? { delivery } : {}),
    },
  };
}

function deliveryLifecycleFactsForRenderer(event: Record<string, unknown> & { kind: string }): Record<string, unknown> | null {
  const payload = isRecord(event.payload) ? event.payload : {};
  const evidence = isRecord(payload.evidence) ? payload.evidence : {};
  const laneId = optionalText(event.laneId) ?? optionalText(payload.laneId);

  switch (event.kind) {
    case "workflow.commit.created":
      return {
        kind: "commit",
        ...(laneId ? { laneId } : {}),
        ...(optionalText(evidence.commitSha) ? { commitSha: optionalText(evidence.commitSha)! } : {}),
        ...(optionalText(evidence.branch) ? { branch: optionalText(evidence.branch)! } : {}),
        ...(optionalText(evidence.subject) ? { subject: optionalText(evidence.subject)! } : {}),
      };
    case "workflow.delivery.pushed":
      return {
        kind: "push",
        ...(laneId ? { laneId } : {}),
        ...(optionalText(evidence.status) ? { status: optionalText(evidence.status)! } : {}),
        ...(optionalText(evidence.remote) ? { remote: optionalText(evidence.remote)! } : {}),
        ...(optionalText(evidence.branch) ? { branch: optionalText(evidence.branch)! } : {}),
        ...(optionalText(evidence.commitSha) ? { commitSha: optionalText(evidence.commitSha)! } : {}),
      };
    case "workflow.pull_request.created":
      return {
        kind: "pull_request",
        ...(laneId ? { laneId } : {}),
        ...(optionalText(payload.commitLaneId) ? { commitLaneId: optionalText(payload.commitLaneId)! } : {}),
        ...(positiveInteger(payload.prNumber) ?? positiveInteger(evidence.number) ? { prNumber: (positiveInteger(payload.prNumber) ?? positiveInteger(evidence.number))! } : {}),
        ...(optionalText(payload.url) ?? optionalText(evidence.url) ? { url: (optionalText(payload.url) ?? optionalText(evidence.url))! } : {}),
        ...(optionalText(payload.headSha) ?? optionalText(evidence.headSha) ?? optionalText(evidence.commitSha) ? { headSha: (optionalText(payload.headSha) ?? optionalText(evidence.headSha) ?? optionalText(evidence.commitSha))! } : {}),
        ...(optionalText(evidence.title) ? { title: optionalText(evidence.title)! } : {}),
      };
    case "workflow.pull_request.checks_recorded":
      return {
        kind: "checks",
        ...(laneId ? { laneId } : {}),
        ...(positiveInteger(payload.prNumber) ?? positiveInteger(evidence.number) ? { prNumber: (positiveInteger(payload.prNumber) ?? positiveInteger(evidence.number))! } : {}),
        ...(optionalText(payload.url) ?? optionalText(evidence.url) ? { url: (optionalText(payload.url) ?? optionalText(evidence.url))! } : {}),
        ...(optionalText(payload.headSha) ?? optionalText(evidence.headSha) ? { headSha: (optionalText(payload.headSha) ?? optionalText(evidence.headSha))! } : {}),
        ...(optionalText(payload.status) ?? optionalText(evidence.status) ? { status: (optionalText(payload.status) ?? optionalText(evidence.status))! } : {}),
        checks: rendererSafePullRequestChecks(payload.checks ?? evidence.checks),
      };
    case "workflow.pull_request.merged":
      return {
        kind: "merge",
        ...(laneId ? { laneId } : {}),
        ...(positiveInteger(payload.prNumber) ?? positiveInteger(evidence.number) ? { prNumber: (positiveInteger(payload.prNumber) ?? positiveInteger(evidence.number))! } : {}),
        ...(optionalText(payload.url) ?? optionalText(evidence.url) ? { url: (optionalText(payload.url) ?? optionalText(evidence.url))! } : {}),
        ...(optionalText(payload.headSha) ?? optionalText(evidence.headSha) ? { headSha: (optionalText(payload.headSha) ?? optionalText(evidence.headSha))! } : {}),
        ...(optionalText(payload.status) ?? optionalText(evidence.status) ? { status: (optionalText(payload.status) ?? optionalText(evidence.status))! } : {}),
        ...(optionalText(evidence.subject) ? { subject: optionalText(evidence.subject)! } : {}),
      };
    case "workflow.delivery.main_synced":
      return {
        kind: "main_synced",
        ...(laneId ? { laneId } : {}),
        ...(positiveInteger(payload.prNumber) ? { prNumber: positiveInteger(payload.prNumber)! } : {}),
        ...(optionalText(payload.headSha) ? { headSha: optionalText(payload.headSha)! } : {}),
        ...(optionalText(evidence.status) ? { status: optionalText(evidence.status)! } : {}),
        ...(optionalText(evidence.mainBranch) ? { mainBranch: optionalText(evidence.mainBranch)! } : {}),
        ...(optionalText(evidence.remote) ? { remote: optionalText(evidence.remote)! } : {}),
      };
    default:
      return null;
  }
}

function rendererSafePullRequestChecks(value: unknown): Array<Record<string, unknown>> {
  if (!Array.isArray(value)) return [];
  return value
    .map((check) => {
      if (!isRecord(check)) return null;
      return {
        ...(optionalText(check.name) ? { name: optionalText(check.name)! } : {}),
        ...(optionalText(check.status) ? { status: optionalText(check.status)! } : {}),
        ...(optionalText(check.link) ? { link: optionalText(check.link)! } : {}),
      };
    })
    .filter((check): check is Record<string, unknown> => check !== null);
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
    case "workflow.commit.created":
      return "Commit created.";
    case "workflow.delivery.pushed":
      return "Delivery branch pushed.";
    case "workflow.pull_request.created":
      return "Pull request created.";
    case "workflow.pull_request.checks_recorded":
      return "Pull request checks recorded.";
    case "workflow.pull_request.merged":
      return "Pull request merged.";
    case "workflow.delivery.main_synced":
      return "Main branch synced.";
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

function normalizeWorkflowRollbackInput(input: WorkflowRollbackInput): {
  sessionId: string;
  nodeId?: string;
  laneId?: string;
  checkpointId?: string;
  requestId?: string;
  now: string;
} {
  if (!isRecord(input)) throw workflowIpcError("INVALID_INPUT", "Workflow rollback input must be an object.");
  const sessionId = assertWorkflowSessionId(readField(input, "sessionId"));
  return {
    sessionId,
    ...(optionalText(readField(input, "nodeId")) ? { nodeId: optionalText(readField(input, "nodeId"))! } : {}),
    ...(optionalText(readField(input, "laneId")) ? { laneId: optionalText(readField(input, "laneId"))! } : {}),
    ...(optionalText(readField(input, "checkpointId")) ? { checkpointId: optionalText(readField(input, "checkpointId"))! } : {}),
    ...(optionalText(readField(input, "requestId")) ? { requestId: optionalText(readField(input, "requestId"))! } : {}),
    now: optionalText(readField(input, "now")) ?? new Date().toISOString(),
  };
}

function normalizeCheckpointSuccessorInput(input: WorkflowCheckpointSuccessorInput): {
  sessionId: string;
  nodeId?: string;
  laneId?: string;
  checkpointId: string;
  intentId?: string;
  successorLaneId?: string;
  successorSemanticKey?: string;
  title?: string;
  instruction?: string;
  now: string;
} {
  if (!isRecord(input)) throw workflowIpcError("INVALID_INPUT", "Workflow checkpoint successor input must be an object.");
  const sessionId = assertWorkflowSessionId(readField(input, "sessionId"));
  return {
    sessionId,
    checkpointId: requireText(readField(input, "checkpointId"), "checkpoint id"),
    ...(optionalText(readField(input, "nodeId")) ? { nodeId: optionalText(readField(input, "nodeId"))! } : {}),
    ...(optionalText(readField(input, "laneId")) ? { laneId: optionalText(readField(input, "laneId"))! } : {}),
    ...(optionalText(readField(input, "intentId")) ? { intentId: optionalText(readField(input, "intentId"))! } : {}),
    ...(optionalText(readField(input, "successorLaneId")) ? { successorLaneId: optionalText(readField(input, "successorLaneId"))! } : {}),
    ...(optionalText(readField(input, "successorSemanticKey")) ? { successorSemanticKey: optionalText(readField(input, "successorSemanticKey"))! } : {}),
    ...(optionalText(readField(input, "title")) ? { title: optionalText(readField(input, "title"))! } : {}),
    ...(optionalText(readField(input, "instruction")) ?? optionalText(readField(input, "text"))
      ? { instruction: (optionalText(readField(input, "instruction")) ?? optionalText(readField(input, "text")))! }
      : {}),
    now: optionalText(readField(input, "now")) ?? new Date().toISOString(),
  };
}

function appendRollbackRequestedEvent(
  store: WorkflowStoreHost,
  input: { sessionId: string; nodeId?: string; laneId?: string; checkpointId?: string; requestId?: string; now: string },
  eligibility: WorkflowRollbackEligibilityLike,
): { event: unknown; requestId: string } {
  const requestId = input.requestId ?? rollbackRequestIdForIpc(input, eligibility);
  const laneId = rollbackTargetLaneIdForIpc(input, eligibility);
  const event = store.appendWorkflowEvent({
    sessionId: input.sessionId,
    kind: "workflow.node.rollback_requested",
    source: "electron-main",
    laneId,
    idempotencyKey: `rollback:${requestId}:requested`,
    payload: rollbackEventPayloadForIpc(input, eligibility, requestId, true),
    now: input.now,
  });
  return { event, requestId };
}

function appendRollbackAppliedEvent(
  store: WorkflowStoreHost,
  input: { sessionId: string; nodeId?: string; laneId?: string; checkpointId?: string; now: string },
  eligibility: WorkflowRollbackEligibilityLike,
  requestId: string,
): unknown {
  const laneId = rollbackTargetLaneIdForIpc(input, eligibility);
  return store.appendWorkflowEvent({
    sessionId: input.sessionId,
    kind: "workflow.node.rollback_applied",
    source: "electron-main",
    laneId,
    idempotencyKey: `rollback:${requestId}:applied`,
    payload: {
      ...rollbackEventPayloadForIpc(input, eligibility, requestId, true),
      reason: "Rollback applied.",
    },
    now: new Date().toISOString(),
  });
}

function appendRollbackRejectedEvent(
  store: WorkflowStoreHost,
  input: { sessionId: string; nodeId?: string; laneId?: string; checkpointId?: string; requestId?: string; now: string },
  eligibility: WorkflowRollbackEligibilityLike,
  localSafety: LocalRollbackSafety,
  existingRequestId?: string,
): unknown {
  const requestId = existingRequestId ?? input.requestId ?? rollbackRequestIdForIpc(input, eligibility);
  const laneId = rollbackTargetLaneIdForIpc(input, eligibility);
  return store.appendWorkflowEvent({
    sessionId: input.sessionId,
    kind: "workflow.node.rollback_rejected",
    source: "electron-main",
    laneId,
    idempotencyKey: `rollback:${requestId}:rejected`,
    payload: {
      ...rollbackEventPayloadForIpc(input, eligibility, requestId),
      reason: localSafety.message ?? "Local rollback requires manual repair.",
      reasonCode: localSafety.reasonCode ?? "manual_repair_required",
      manualRepairRequired: true,
    },
    now: new Date().toISOString(),
  });
}

function findRollbackRequestedEventByIdempotencyKey(
  store: WorkflowStoreHost,
  sessionId: string,
  requestId: string,
): RollbackRequestedEventMatch | null {
  const idempotencyKey = `rollback:${requestId}:requested`;
  for (const event of [...store.listEvents(sessionId)].reverse()) {
    if (!isRecord(event)) continue;
    if (event.kind !== "workflow.node.rollback_requested") continue;
    if (optionalText(event.idempotencyKey) !== idempotencyKey) continue;
    return { requestId, event };
  }
  return null;
}

function rollbackRequestIdForIpc(
  input: { sessionId: string; laneId?: string; nodeId?: string; checkpointId?: string; now: string },
  eligibility: WorkflowRollbackEligibilityLike,
): string {
  return `rollback:${input.sessionId}:${rollbackTargetLaneIdForIpc(input, eligibility)}:${eligibility.checkpointId ?? input.checkpointId ?? "checkpoint"}:${input.now}`;
}

function rollbackEventPayloadForIpc(
  input: { nodeId?: string; checkpointId?: string },
  eligibility: WorkflowRollbackEligibilityLike,
  requestId: string,
  localRollbackSafe?: boolean,
): Record<string, unknown> {
  const laneId = rollbackTargetLaneIdForIpc(input, eligibility);
  return {
    requestId,
    laneId,
    ...(input.nodeId ?? eligibility.targetNodeId ? { nodeId: input.nodeId ?? eligibility.targetNodeId } : {}),
    ...(eligibility.checkpointId ?? input.checkpointId ? { checkpointId: eligibility.checkpointId ?? input.checkpointId } : {}),
    ...(eligibility.checkpointPhase ? { checkpointPhase: eligibility.checkpointPhase } : {}),
    ...(eligibility.restoreCommitRef ? { restoreCommitRef: eligibility.restoreCommitRef } : {}),
    ...(Array.isArray(eligibility.affectedLaneIds) ? { affectedLaneIds: eligibility.affectedLaneIds } : {}),
    ...(Array.isArray(eligibility.affectedNodeIds) ? { affectedNodeIds: eligibility.affectedNodeIds } : {}),
    ...(Array.isArray(eligibility.downstreamInactiveLaneIds) ? { downstreamInactiveLaneIds: eligibility.downstreamInactiveLaneIds } : {}),
    ...(Array.isArray(eligibility.downstreamInactiveNodeIds) ? { downstreamInactiveNodeIds: eligibility.downstreamInactiveNodeIds } : {}),
    ...(typeof localRollbackSafe === "boolean" ? { localRollbackSafe } : {}),
    ...(eligibility.localSafetyStatus ? { localSafetyStatus: eligibility.localSafetyStatus } : {}),
    ...(eligibility.manualRepairReason ? { manualRepairReason: eligibility.manualRepairReason } : {}),
  };
}

function rollbackTargetLaneIdForIpc(
  input: { laneId?: string; nodeId?: string },
  eligibility: WorkflowRollbackEligibilityLike,
): string {
  return requireText(eligibility.targetLaneId ?? input.laneId ?? input.nodeId, "rollback lane id");
}

function workflowRollbackResponse(
  store: WorkflowStoreHost,
  sessionId: string,
  result: WorkflowRollbackResultLike,
): Record<string, unknown> {
  const eligibility = result.eligibility ?? {};
  const blockedReason = isRecord(result.blockedReason) ? result.blockedReason : workflowRollbackBlockReason(eligibility);
  return {
    protocolVersion: RUN_PROTOCOL_VERSION,
    status: result.status,
    ...(isRecord(result.event) ? { event: result.event } : {}),
    ...(isRecord(result.requestedEvent) ? { requestedEvent: result.requestedEvent } : {}),
    eligibility,
    blockedReason,
    manualRepairRequired: result.manualRepairRequired === true || (isRecord(blockedReason) && blockedReason.manualRepairRequired === true),
    projection: store.materializeFlowProjection(sessionId),
    canvasSession: materializeRendererCanvasSession(store, sessionId),
  };
}

function workflowRollbackBlockReason(eligibility: WorkflowRollbackEligibilityLike): Record<string, unknown> | null {
  if (eligibility.eligible === true) return null;
  const remoteSideEffects = Array.isArray(eligibility.blockingRemoteSideEffects)
    ? eligibility.blockingRemoteSideEffects.filter(isRecord)
    : [];
  const affectedLaneIds = Array.isArray(eligibility.affectedLaneIds)
    ? eligibility.affectedLaneIds.filter((id): id is string => typeof id === "string")
    : [];
  if (remoteSideEffects.length > 0) {
    return {
      code: "remote_side_effect",
      message: "Rollback is blocked by remote side effects.",
      eventKinds: uniqueStrings(remoteSideEffects.map((effect) => optionalText(effect.eventKind)).filter((kind): kind is string => Boolean(kind))),
      remoteSideEffects,
      affectedLaneIds,
    };
  }
  if (eligibility.localRollbackSafe === false) {
    return {
      code: "manual_repair_required",
      message: optionalText(eligibility.manualRepairReason) ?? optionalText(eligibility.reason) ?? "Local rollback is not safe.",
      affectedLaneIds,
      manualRepairRequired: true,
    };
  }
  return {
    code: affectedLaneIds.length === 0 ? "unknown_target" : "invalid_checkpoint",
    message: optionalText(eligibility.reason) ?? "Rollback is not eligible.",
    affectedLaneIds,
  };
}

function evaluateRollbackRemoteBlocksForRollback(
  projectRoot: string,
  store: WorkflowStoreHost,
  input: { sessionId: string; nodeId?: string; laneId?: string; checkpointId?: string; requestId?: string; now: string },
): { eligibility: WorkflowRollbackEligibilityLike; result: WorkflowRollbackResultLike | null } {
  const eligibility = store.getNodeRollbackEligibility(input);
  if (Array.isArray(eligibility.blockingRemoteSideEffects) && eligibility.blockingRemoteSideEffects.length > 0) {
    return { eligibility, result: store.applyNodeRollback(input) };
  }
  const inFlightBlocks = blockingInFlightRemoteSideEffects(projectRoot, input.sessionId, eligibility);
  if (inFlightBlocks.length === 0) return { eligibility, result: null };
  const blockedEligibility = rollbackEligibilityWithInFlightRemoteBlocks(eligibility, inFlightBlocks);
  return {
    eligibility: blockedEligibility,
    result: {
      status: "blocked",
      eligibility: blockedEligibility,
      blockedReason: inFlightRemoteSideEffectBlockReason(blockedEligibility, inFlightBlocks),
    },
  };
}

async function withWorkflowSessionMutationLock<T>(projectRoot: string, sessionId: string, action: () => Promise<T>): Promise<T> {
  const lockKey = workflowSessionMutationKey(projectRoot, sessionId);
  const previous = workflowSessionMutationLocks.get(lockKey) ?? Promise.resolve();
  let release: () => void = () => undefined;
  const current = new Promise<void>((resolve) => {
    release = resolve;
  });
  const next = previous.catch(() => undefined).then(() => current);
  workflowSessionMutationLocks.set(lockKey, next);
  await previous.catch(() => undefined);
  try {
    return await action();
  } finally {
    release();
    if (workflowSessionMutationLocks.get(lockKey) === next) workflowSessionMutationLocks.delete(lockKey);
  }
}

function workflowSessionMutationKey(projectRoot: string, sessionId: string): string {
  return `${projectRoot}\0${sessionId}`;
}

function beginDurableRemoteSideEffect(
  store: WorkflowStoreHost,
  input: RemoteSideEffectOperation,
): DurableRemoteSideEffect {
  const createdAt = new Date().toISOString();
  const operationId = `remote-side-effect:${input.eventKind}:${input.sessionId}:${input.laneId ?? "session"}:${createdAt}:${remoteSideEffectSequence++}`;
  const affectedLaneIds = input.affectedLaneIds ? uniqueStrings(input.affectedLaneIds) : undefined;
  const payload = {
    operationId,
    operationKey: input.operationKey,
    eventKind: input.eventKind,
    ...(input.laneId ? { laneId: input.laneId } : {}),
    ...(affectedLaneIds && affectedLaneIds.length > 0 ? { affectedLaneIds } : {}),
    ...(input.sessionWide ? { sessionWide: true } : {}),
    ...(input.details ? input.details : {}),
  };
  const requestedEvent = store.appendWorkflowEvent({
    sessionId: input.sessionId,
    kind: "workflow.remote_side_effect.requested",
    source: "electron-main",
    ...(input.laneId ? { laneId: input.laneId } : {}),
    idempotencyKey: `${operationId}:requested`,
    payload,
    now: createdAt,
  });
  const endInFlight = beginInFlightRemoteSideEffect(input);
  let completed = false;
  let ended = false;
  return {
    operationId,
    requestedEvent,
    complete(status, details = {}) {
      if (completed) return null;
      completed = true;
      return store.appendWorkflowEvent({
        sessionId: input.sessionId,
        kind: "workflow.remote_side_effect.completed",
        source: "electron-main",
        ...(input.laneId ? { laneId: input.laneId } : {}),
        idempotencyKey: `${operationId}:completed`,
        payload: {
          ...payload,
          status,
          ...details,
        },
        now: new Date().toISOString(),
      });
    },
    endInFlight() {
      if (ended) return;
      ended = true;
      endInFlight();
    },
  };
}

function completeDurableRemoteSideEffectForKnownPreMutationFailure(
  remoteSideEffect: DurableRemoteSideEffect,
  error: unknown,
): void {
  if (!isKnownPreMutationDeliveryRemoteError(error)) return;
  const normalized = normalizeDeliveryRemoteIpcError(error);
  const code = isRecord(error) ? deliveryRemoteIpcErrorCode(error.code) : null;
  remoteSideEffect.complete("failed", {
    remoteMutationAttempted: false,
    error: {
      ...(code ? { code } : {}),
      message: sanitizeSnippet(normalized.message),
    },
  });
}

function unresolvedRemoteSideEffectBlockForRetry(
  store: WorkflowStoreHost,
  input: RemoteSideEffectOperation,
): UnresolvedRemoteSideEffectBlock | null {
  const unresolved = new Map<string, UnresolvedRemoteSideEffectBlock>();
  for (const event of store.listEvents(input.sessionId)) {
    if (!isRecord(event) || !isRecord(event.payload)) continue;
    if (event.kind === "workflow.remote_side_effect.completed") {
      const operationId = optionalText(event.payload.operationId);
      if (operationId && remoteSideEffectCompletionClearsRetryBlock(event)) unresolved.delete(operationId);
      continue;
    }
    if (event.kind !== "workflow.remote_side_effect.requested") continue;
    const request = remoteSideEffectRequestFromEvent(event);
    if (!request || !remoteSideEffectRequestMatches(input, request)) continue;
    unresolved.set(request.operationId, request);
  }
  const first = unresolved.values().next();
  return first.done ? null : first.value;
}

function remoteSideEffectCompletionClearsRetryBlock(event: Record<string, unknown>): boolean {
  const payload = isRecord(event.payload) ? event.payload : {};
  const status = optionalText(payload.status);
  return status === "succeeded" || (status === "failed" && payload.remoteMutationAttempted === false);
}

function remoteSideEffectRequestFromEvent(event: Record<string, unknown>): UnresolvedRemoteSideEffectBlock | null {
  const payload = isRecord(event.payload) ? event.payload : {};
  const eventKind = remoteSideEffectKind(payload.eventKind);
  const operationId = optionalText(payload.operationId) ?? optionalText(event.id);
  if (!eventKind || !operationId) return null;
  const operationKey = optionalText(payload.operationKey);
  const laneId = optionalText(event.laneId) ?? optionalText(payload.laneId);
  const affectedLaneIds = Array.isArray(payload.affectedLaneIds)
    ? uniqueStrings(payload.affectedLaneIds.filter((id): id is string => typeof id === "string"))
    : undefined;
  return {
    requestedEvent: event,
    operationId,
    ...(operationKey ? { operationKey } : {}),
    eventKind,
    ...(laneId ? { laneId } : {}),
    ...(affectedLaneIds && affectedLaneIds.length > 0 ? { affectedLaneIds } : {}),
    ...(payload.sessionWide === true ? { sessionWide: true } : {}),
    ...(optionalText(event.createdAt) ? { createdAt: optionalText(event.createdAt)! } : {}),
  };
}

function remoteSideEffectRequestMatches(
  input: RemoteSideEffectOperation,
  request: UnresolvedRemoteSideEffectBlock,
): boolean {
  if (request.operationKey && request.operationKey === input.operationKey) return true;
  if (request.sessionWide === true || input.sessionWide === true) return true;
  if (input.laneId && request.laneId && request.laneId !== input.laneId) return false;
  const inputAffectedLaneIds = input.affectedLaneIds ?? (input.laneId ? [input.laneId] : []);
  const requestAffectedLaneIds = request.affectedLaneIds ?? (request.laneId ? [request.laneId] : []);
  if (inputAffectedLaneIds.length === 0 || requestAffectedLaneIds.length === 0) return false;
  const requestLaneIds = new Set(requestAffectedLaneIds);
  return inputAffectedLaneIds.some((laneId) => requestLaneIds.has(laneId));
}

function remoteSideEffectManualResolutionResponse(
  store: WorkflowStoreHost,
  sessionId: string,
  block: UnresolvedRemoteSideEffectBlock,
): Record<string, unknown> {
  return {
    protocolVersion: RUN_PROTOCOL_VERSION,
    status: "blocked",
    event: block.requestedEvent,
    blockedReason: {
      code: "manual_resolution_required",
      message: "A previous remote delivery operation is unresolved; resolve it manually before retrying.",
      eventKind: block.eventKind,
      operationId: block.operationId,
      ...(block.operationKey ? { operationKey: block.operationKey } : {}),
      manualRepairRequired: true,
    },
    manualRepairRequired: true,
    projection: store.materializeFlowProjection(sessionId),
    canvasSession: materializeRendererCanvasSession(store, sessionId),
  };
}

function missingDeliveryPushEvidenceManualResolutionResponse(
  store: WorkflowStoreHost,
  sessionId: string,
  commitLaneId: string,
  commitEvidence: DeliveryCommitEvidenceLike,
  remote: string,
): Record<string, unknown> {
  return {
    protocolVersion: RUN_PROTOCOL_VERSION,
    status: "blocked",
    event: null,
    blockedReason: {
      code: "manual_resolution_required",
      message: "Pull request creation requires recorded push evidence for the delivery commit.",
      eventKind: "workflow.delivery.pushed",
      laneId: commitLaneId,
      commitSha: commitEvidence.commitSha,
      branch: commitEvidence.branch,
      remote,
      manualRepairRequired: true,
    },
    manualRepairRequired: true,
    projection: store.materializeFlowProjection(sessionId),
    canvasSession: materializeRendererCanvasSession(store, sessionId),
  };
}

function remoteSideEffectSemanticKey(input: {
  sessionId: string;
  eventKind: InFlightRemoteSideEffectKind;
  laneId?: string;
  sessionWide?: boolean;
  details?: Record<string, unknown>;
}): string {
  const details = Object.entries(input.details ?? {})
    .filter(([, value]) => value !== undefined && value !== null && String(value).trim().length > 0)
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([key, value]) => `${key}=${remoteSideEffectKeyPart(value)}`);
  return [
    "remote-side-effect",
    input.eventKind,
    `session=${remoteSideEffectKeyPart(input.sessionId)}`,
    ...(input.laneId ? [`lane=${remoteSideEffectKeyPart(input.laneId)}`] : []),
    ...(input.sessionWide ? ["sessionWide=true"] : []),
    ...details,
  ].join("|");
}

function remoteSideEffectKeyPart(value: unknown): string {
  return String(value).trim().replace(/\s+/g, "_").slice(0, 200);
}

function remoteSideEffectKind(value: unknown): InFlightRemoteSideEffectKind | null {
  if (
    value === "workflow.delivery.pushed" ||
    value === "workflow.pull_request.created" ||
    value === "workflow.pull_request.merged" ||
    value === "workflow.delivery.main_synced"
  ) {
    return value;
  }
  return null;
}

function beginInFlightRemoteSideEffect(input: {
  projectRoot: string;
  sessionId: string;
  eventKind: InFlightRemoteSideEffectKind;
  laneId?: string;
  affectedLaneIds?: string[];
  sessionWide?: boolean;
}): () => void {
  const createdAt = new Date().toISOString();
  const eventId = `in-flight:${input.eventKind}:${input.sessionId}:${input.laneId ?? "session"}:${createdAt}:${inFlightRemoteSideEffects.size}`;
  const affectedLaneIds = input.affectedLaneIds ? uniqueStrings(input.affectedLaneIds) : undefined;
  inFlightRemoteSideEffects.set(eventId, {
    eventKind: input.eventKind,
    status: "in_flight",
    eventId,
    projectRoot: input.projectRoot,
    sessionId: input.sessionId,
    createdAt,
    ...(input.laneId ? { laneId: input.laneId } : {}),
    ...(affectedLaneIds && affectedLaneIds.length > 0 ? { affectedLaneIds } : {}),
    ...(input.sessionWide ? { sessionWide: true } : {}),
  });
  return () => {
    inFlightRemoteSideEffects.delete(eventId);
  };
}

function blockingInFlightRemoteSideEffects(
  projectRoot: string,
  sessionId: string,
  eligibility: WorkflowRollbackEligibilityLike,
): InFlightRemoteSideEffect[] {
  const affectedLaneIds = new Set(Array.isArray(eligibility.affectedLaneIds)
    ? eligibility.affectedLaneIds.filter((id): id is string => typeof id === "string")
    : []);
  if (affectedLaneIds.size === 0) return [];
  return [...inFlightRemoteSideEffects.values()].filter((effect) => {
    if (effect.projectRoot !== projectRoot) return false;
    if (effect.sessionId !== sessionId) return false;
    if (effect.sessionWide === true) return true;
    if (effect.laneId && affectedLaneIds.has(effect.laneId)) return true;
    return (effect.affectedLaneIds ?? []).some((laneId) => affectedLaneIds.has(laneId));
  });
}

function rollbackEligibilityWithInFlightRemoteBlocks(
  eligibility: WorkflowRollbackEligibilityLike,
  inFlightBlocks: InFlightRemoteSideEffect[],
): WorkflowRollbackEligibilityLike {
  return {
    ...eligibility,
    eligible: false,
    blockingRemoteSideEffects: [
      ...(Array.isArray(eligibility.blockingRemoteSideEffects) ? eligibility.blockingRemoteSideEffects : []),
      ...inFlightBlocks,
    ],
    reason: "Remote side effects are still in flight.",
  };
}

function rollbackEligibilityWithManualRepair(
  eligibility: WorkflowRollbackEligibilityLike,
  manualRepairReason?: string,
): WorkflowRollbackEligibilityLike {
  const reason = manualRepairReason ?? "Local rollback requires manual repair.";
  return {
    ...eligibility,
    eligible: false,
    localRollbackSafe: false,
    localSafetyStatus: "manual_repair_required",
    manualRepairReason: reason,
    reason,
  };
}

function inFlightRemoteSideEffectBlockReason(
  eligibility: WorkflowRollbackEligibilityLike,
  inFlightBlocks: InFlightRemoteSideEffect[],
): Record<string, unknown> {
  return {
    code: "in_flight_remote_side_effect",
    message: "Rollback is blocked by remote side effects that have not been recorded yet.",
    eventKinds: uniqueStrings(inFlightBlocks.map((effect) => effect.eventKind)),
    remoteSideEffects: inFlightBlocks,
    affectedLaneIds: Array.isArray(eligibility.affectedLaneIds)
      ? eligibility.affectedLaneIds.filter((id): id is string => typeof id === "string")
      : [],
  };
}

async function evaluateLocalRollbackSafetyForRollback(
  projectRoot: string,
  store: WorkflowStoreHost,
  input: { sessionId: string; nodeId?: string; laneId?: string; checkpointId?: string; requestId?: string },
  eligibility: WorkflowRollbackEligibilityLike,
): Promise<LocalRollbackSafety> {
  if (eligibility.eligible !== true) return { status: "not_required" };
  const checkpointId = optionalText(eligibility.checkpointId) ?? input.checkpointId;
  const restoreCommitRef = optionalText(eligibility.restoreCommitRef);
  if (!checkpointId || !restoreCommitRef) {
    return {
      status: "manual_repair_required",
      reasonCode: "missing_restore_commit",
      message: "Rollback requires exact checkpoint restore evidence.",
    };
  }
  if (!isFullCommitSha(restoreCommitRef)) {
    return {
      status: "manual_repair_required",
      reasonCode: "invalid_restore_commit",
      message: "Rollback restore target must be a recorded full commit SHA.",
    };
  }
  const projection = store.materializeFlowProjection(input.sessionId);
  const checkpoint = workflowCheckpointById(projection, checkpointId);
  if (!checkpoint) {
    return {
      status: "manual_repair_required",
      reasonCode: "missing_checkpoint",
      message: "Rollback checkpoint is not recorded in the workflow ledger.",
    };
  }

  let rollbackWorktree: ManagedRollbackWorktree;
  try {
    rollbackWorktree = await assertManagedRollbackWorktree(projectRoot, projection, checkpoint);
  } catch {
    return {
      status: "manual_repair_required",
      reasonCode: "unmanaged_worktree",
      message: "Rollback requires a SkyTurn-managed worktree.",
    };
  }
  const worktreePath = rollbackWorktree.path;

  const affectedLaneIds = Array.isArray(eligibility.affectedLaneIds)
    ? eligibility.affectedLaneIds.filter((id): id is string => typeof id === "string")
    : [];
  const recordedHead = await findRecordedRollbackHead(store, input.sessionId, checkpoint, affectedLaneIds, worktreePath);
  if (!recordedHead) {
    return {
      status: "manual_repair_required",
      reasonCode: "missing_recorded_commit",
      message: "Rollback requires a SkyTurn-recorded local commit.",
    };
  }
  if (!isFullCommitSha(recordedHead.commitSha)) {
    return {
      status: "manual_repair_required",
      reasonCode: "invalid_recorded_commit",
      message: "Rollback recorded HEAD must be a full commit SHA.",
    };
  }
  const expectedBranchName = rollbackWorktree.branchName ?? recordedHead.branchName;
  if (!expectedBranchName) {
    return {
      status: "manual_repair_required",
      reasonCode: "missing_expected_branch",
      message: "Rollback requires a recorded managed branch.",
    };
  }
  const { evaluateRollbackWorktreeState } = await import("@skyturn/git-worktree/node");
  const worktreeState = await evaluateRollbackWorktreeState({
    projectRoot,
    worktreePath,
    expectedBranchName,
    expectedHeadCommit: recordedHead.commitSha,
    restoreCommitRef,
  });
  if (worktreeState.status === "manual_repair_required") {
    return {
      status: "manual_repair_required",
      reasonCode: worktreeState.reasonCode,
      message: worktreeState.message,
    };
  }
  if (worktreeState.status === "already_restored") {
    const matchingApplied = findMatchingRollbackAppliedEvent(store, input, eligibility, restoreCommitRef);
    if (matchingApplied) {
      return {
        status: "already_applied",
        worktreePath,
        restoreCommitRef,
        expectedBranchName,
        expectedHeadCommit: recordedHead.commitSha,
        requestId: matchingApplied.requestId,
        event: matchingApplied.event,
        requestedEvent: matchingApplied.requestedEvent,
      };
    }
    const matchingRequest = findMatchingRollbackRequestedEvent(store, input, eligibility, restoreCommitRef);
    if (matchingRequest) {
      return {
        status: "already_restored",
        worktreePath,
        restoreCommitRef,
        expectedBranchName,
        expectedHeadCommit: recordedHead.commitSha,
        requestId: matchingRequest.requestId,
        requestedEvent: matchingRequest.event,
      };
    }
    return {
      status: "manual_repair_required",
      reasonCode: "head_mismatch",
      message: "Worktree HEAD is restored but rollback terminal evidence is missing for this request.",
    };
  }
  return {
    status: "safe",
    worktreePath,
    restoreCommitRef,
    expectedBranchName,
    expectedHeadCommit: recordedHead.commitSha,
  };
}

function findMatchingRollbackRequestedEvent(
  store: WorkflowStoreHost,
  input: { sessionId: string; nodeId?: string; laneId?: string; checkpointId?: string; requestId?: string },
  eligibility: WorkflowRollbackEligibilityLike,
  restoreCommitRef: string,
): RollbackRequestedEventMatch | null {
  const terminalRequestIds = new Set<string>();
  const requestedEvents: RollbackRequestedEventMatch[] = [];
  for (const event of store.listEvents(input.sessionId)) {
    if (!isRecord(event)) continue;
    const payload = isRecord(event.payload) ? event.payload : {};
    const requestId = optionalText(payload.requestId);
    if (!requestId) continue;
    if (event.kind === "workflow.node.rollback_applied" || event.kind === "workflow.node.rollback_rejected") {
      terminalRequestIds.add(requestId);
      continue;
    }
    if (event.kind !== "workflow.node.rollback_requested") continue;
    if (input.requestId && requestId !== input.requestId) continue;
    const requested = { requestId, event };
    const validation = validateRollbackRequestedEventForIpc(store, input, eligibility, restoreCommitRef, requested);
    if (validation.valid) requestedEvents[requestedEvents.length] = requested;
  }
  for (let index = requestedEvents.length - 1; index >= 0; index -= 1) {
    const requested = requestedEvents[index];
    if (!terminalRequestIds.has(requested.requestId)) return requested;
  }
  return null;
}

function findMatchingRollbackAppliedEvent(
  store: WorkflowStoreHost,
  input: { sessionId: string; nodeId?: string; laneId?: string; checkpointId?: string; requestId?: string },
  eligibility: WorkflowRollbackEligibilityLike,
  restoreCommitRef: string,
): RollbackAppliedEventMatch | null {
  const events = store.listEvents(input.sessionId);
  for (let eventIndex = events.length - 1; eventIndex >= 0; eventIndex -= 1) {
    const event = events[eventIndex];
    if (!isRecord(event) || event.kind !== "workflow.node.rollback_applied") continue;
    const payload = isRecord(event.payload) ? event.payload : {};
    const requestId = optionalText(payload.requestId);
    if (!requestId) continue;
    if (input.requestId && requestId !== input.requestId) continue;
    const applied = { requestId, event };
    if (!validateRollbackTerminalEventForIpc(input, eligibility, restoreCommitRef, applied, "applied")) continue;
    const requested = findMatchingRollbackRequestedHistoryForTerminalEvent(store, input, eligibility, restoreCommitRef, requestId, eventIndex);
    if (!requested) continue;
    return {
      requestId,
      event,
      requestedEvent: requested.event,
    };
  }
  return null;
}

function findMatchingRollbackRequestedHistoryForTerminalEvent(
  store: WorkflowStoreHost,
  input: { sessionId: string; nodeId?: string; laneId?: string; checkpointId?: string; requestId?: string },
  eligibility: WorkflowRollbackEligibilityLike,
  restoreCommitRef: string,
  requestId: string,
  terminalEventIndex: number,
): RollbackRequestedEventMatch | null {
  const events = store.listEvents(input.sessionId);
  for (let eventIndex = events.length - 1; eventIndex >= 0; eventIndex -= 1) {
    if (eventIndex >= terminalEventIndex) continue;
    const event = events[eventIndex];
    if (!isRecord(event) || event.kind !== "workflow.node.rollback_requested") continue;
    const payload = isRecord(event.payload) ? event.payload : {};
    if (optionalText(payload.requestId) !== requestId) continue;
    const requested = { requestId, event };
    const validation = validateRollbackRequestedEventForIpc(store, input, eligibility, restoreCommitRef, requested, {
      allowTerminal: true,
    });
    if (validation.valid) return requested;
  }
  return null;
}

function validateRollbackRequestedEventForIpc(
  store: WorkflowStoreHost,
  input: { sessionId: string; nodeId?: string; laneId?: string; checkpointId?: string; requestId?: string },
  eligibility: WorkflowRollbackEligibilityLike,
  restoreCommitRef: string,
  requested: RollbackRequestedEventMatch,
  options: { allowTerminal?: boolean } = {},
): RollbackRequestedEventValidation {
  const event = requested.event;
  if (!isRecord(event) || event.kind !== "workflow.node.rollback_requested") {
    return invalidRollbackRequestedEventValidation();
  }
  const payload = isRecord(event.payload) ? event.payload : {};
  if (optionalText(event.idempotencyKey) !== `rollback:${requested.requestId}:requested`) {
    return invalidRollbackRequestedEventValidation();
  }
  const expectedLaneId = rollbackTargetLaneIdForIpc(input, eligibility);
  const expectedCheckpointId = optionalText(eligibility.checkpointId) ?? optionalText(input.checkpointId);
  if (!expectedCheckpointId) return invalidRollbackRequestedEventValidation();
  const expectedNodeId = optionalText(input.nodeId) ?? optionalText(eligibility.targetNodeId);
  const payloadRequestId = optionalText(payload.requestId);
  if (payloadRequestId !== requested.requestId) return invalidRollbackRequestedEventValidation();
  const eventLaneId = optionalText(event.laneId);
  if (eventLaneId && eventLaneId !== expectedLaneId) return invalidRollbackRequestedEventValidation();
  const payloadLaneId = optionalText(payload.laneId);
  if (payloadLaneId !== expectedLaneId) return invalidRollbackRequestedEventValidation();
  const payloadCheckpointId = optionalText(payload.checkpointId);
  if (payloadCheckpointId !== expectedCheckpointId) return invalidRollbackRequestedEventValidation();
  const payloadNodeId = optionalText(payload.nodeId);
  if (payloadNodeId !== expectedNodeId) return invalidRollbackRequestedEventValidation();
  const payloadRestoreCommitRef = optionalText(payload.restoreCommitRef);
  if (payloadRestoreCommitRef !== restoreCommitRef) return invalidRollbackRequestedEventValidation();
  if (payload.localRollbackSafe !== true) return invalidRollbackRequestedEventValidation();
  if (options?.allowTerminal !== true && rollbackRequestHasTerminalEvent(store, input.sessionId, requested.requestId)) {
    return invalidRollbackRequestedEventValidation();
  }
  return { valid: true };
}

function validateRollbackTerminalEventForIpc(
  input: { nodeId?: string; laneId?: string; checkpointId?: string },
  eligibility: WorkflowRollbackEligibilityLike,
  restoreCommitRef: string,
  terminal: RollbackRequestedEventMatch,
  terminalStatus: "applied" | "rejected",
): boolean {
  const event = terminal.event;
  const expectedKind = terminalStatus === "applied" ? "workflow.node.rollback_applied" : "workflow.node.rollback_rejected";
  if (!isRecord(event) || event.kind !== expectedKind) return false;
  const payload = isRecord(event.payload) ? event.payload : {};
  if (optionalText(event.idempotencyKey) !== `rollback:${terminal.requestId}:${terminalStatus}`) return false;
  const expectedLaneId = rollbackTargetLaneIdForIpc(input, eligibility);
  const expectedCheckpointId = optionalText(eligibility.checkpointId) ?? optionalText(input.checkpointId);
  if (!expectedCheckpointId) return false;
  const expectedNodeId = optionalText(input.nodeId) ?? optionalText(eligibility.targetNodeId);
  if (optionalText(payload.requestId) !== terminal.requestId) return false;
  const eventLaneId = optionalText(event.laneId);
  if (eventLaneId && eventLaneId !== expectedLaneId) return false;
  if (optionalText(payload.laneId) !== expectedLaneId) return false;
  if (optionalText(payload.checkpointId) !== expectedCheckpointId) return false;
  if (optionalText(payload.nodeId) !== expectedNodeId) return false;
  if (optionalText(payload.restoreCommitRef) !== restoreCommitRef) return false;
  if (payload.localRollbackSafe !== true) return false;
  return true;
}

function rollbackRequestHasTerminalEvent(store: WorkflowStoreHost, sessionId: string, requestId: string): boolean {
  return store.listEvents(sessionId).some((event) => {
    if (!isRecord(event)) return false;
    if (event.kind !== "workflow.node.rollback_applied" && event.kind !== "workflow.node.rollback_rejected") return false;
    const payload = isRecord(event.payload) ? event.payload : {};
    return optionalText(payload.requestId) === requestId;
  });
}

function invalidRollbackRequestedEventValidation(): RollbackRequestedEventValidation {
  return {
    valid: false,
    message: "Rollback request idempotency collision requires manual repair.",
  };
}

function localRollbackSafetyResult(localSafety: LocalRollbackSafety): Record<string, unknown> | null {
  if (localSafety.status !== "manual_repair_required") return null;
  return {
    code: "manual_repair_required",
    message: localSafety.message ?? "Local rollback requires manual repair.",
    reasonCode: localSafety.reasonCode ?? "manual_repair_required",
    manualRepairRequired: true,
  };
}

async function assertManagedRollbackWorktree(
  projectRoot: string,
  projection: unknown,
  checkpoint: Record<string, unknown>,
): Promise<ManagedRollbackWorktree> {
  const worktreeId = requireText(checkpoint.worktreeId, "rollback worktree id");
  const worktrees = isRecord(projection) && Array.isArray(projection.worktrees) ? projection.worktrees.filter(isRecord) : [];
  const worktree = worktrees.find((candidate) => candidate.worktreeId === worktreeId);
  if (!worktree) throw workflowIpcError("INVALID_INPUT", "Rollback worktree is not recorded.");
  const realProjectRoot = await fs.realpath(projectRoot);
  const repoRoot = await fs.realpath(requireText(worktree.repoRoot, "rollback repo root"));
  if (repoRoot !== realProjectRoot) throw workflowIpcError("UNKNOWN_PROJECT", "Rollback worktree repoRoot must match the open project root.");
  const realManagedRoot = await fs.realpath(`${realProjectRoot}.worktrees`);
  const worktreePath = requireText(worktree.realPath ?? worktree.path, "rollback worktree path");
  const realWorktreePath = await fs.realpath(worktreePath);
  if (!isInsidePath(realManagedRoot, realWorktreePath)) {
    throw workflowIpcError("UNSAFE_WORKTREE_PATH", "Rollback worktree path must stay inside the SkyTurn managed worktree directory.");
  }
  const checkpointPath = optionalText(checkpoint.worktreePath);
  if (checkpointPath) {
    const realCheckpointPath = await fs.realpath(checkpointPath);
    if (realCheckpointPath !== realWorktreePath) {
      throw workflowIpcError("UNSAFE_WORKTREE_PATH", "Rollback checkpoint worktree does not match the recorded worktree.");
    }
  }
  return {
    path: realWorktreePath,
    branchName: optionalText(worktree.branchName) ?? undefined,
  };
}

async function findRecordedRollbackHead(
  store: WorkflowStoreHost,
  sessionId: string,
  checkpoint: Record<string, unknown>,
  affectedLaneIds: string[],
  worktreePath: string,
): Promise<RecordedRollbackHead | null> {
  const affected = new Set(affectedLaneIds);
  const checkpointWorktreeId = optionalText(checkpoint.worktreeId);
  for (const event of [...store.listEvents(sessionId)].reverse()) {
    if (!isRecord(event) || event.kind !== "workflow.commit.created") continue;
    const payload = isRecord(event.payload) ? event.payload : {};
    const laneId = optionalText(event.laneId) ?? optionalText(payload.laneId);
    if (!laneId || !affected.has(laneId)) continue;
    const evidence = isRecord(payload.evidence) ? payload.evidence : {};
    const evidenceWorktreeId = optionalText(evidence.worktreeId) ?? optionalText(payload.worktreeId);
    if (evidenceWorktreeId && checkpointWorktreeId && evidenceWorktreeId !== checkpointWorktreeId) continue;
    const evidenceWorktreePath = optionalText(evidence.worktreePath);
    if (!evidenceWorktreePath) continue;
    if (!await realPathsEqual(evidenceWorktreePath, worktreePath)) continue;
    const commitSha = optionalText(evidence.commitSha);
    if (commitSha && isFullCommitSha(commitSha)) {
      const branchName = optionalText(evidence.branch);
      return {
        commitSha,
        ...(branchName ? { branchName } : {}),
      };
    }
  }
  return null;
}

function workflowCheckpointById(projection: unknown, checkpointId: string): Record<string, unknown> | null {
  if (!isRecord(projection) || !Array.isArray(projection.checkpoints)) return null;
  return projection.checkpoints.find((checkpoint) => isRecord(checkpoint) && checkpoint.id === checkpointId) as Record<string, unknown> | undefined ?? null;
}

function isFullCommitSha(value: unknown): value is string {
  return typeof value === "string" && /^[0-9a-fA-F]{40}$/.test(value);
}

async function realPathsEqual(left: string, right: string): Promise<boolean> {
  try {
    const [realLeft, realRight] = await Promise.all([fs.realpath(left), fs.realpath(right)]);
    return realLeft === realRight;
  } catch {
    return false;
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
    if (isTrustedPlannerRootStartInput(input, store)) return;
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

function terminalHandler<T extends unknown[], R>(
  handler: (...args: T) => Promise<R> | R,
): (_event: Electron.IpcMainInvokeEvent, ...args: T) => Promise<R> {
  return async (_event, ...args) => {
    try {
      return await handler(...args);
    } catch (error) {
      throw normalizeTerminalIpcError(error);
    }
  };
}

function assertTerminalStartInput(input: unknown): TerminalStartInput {
  const inputError = terminalStartInputError(input);
  if (inputError) throw terminalIpcError(inputError, "Terminal start input is invalid.");
  return input as TerminalStartInput;
}

function assertTerminalWriteInput(input: unknown): TerminalWriteInput {
  const inputError = terminalWriteInputError(input);
  if (inputError) throw terminalIpcError(inputError, "Terminal write input is invalid.");
  return input as TerminalWriteInput;
}

function assertTerminalResizeInput(input: unknown): TerminalResizeInput {
  const inputError = terminalResizeInputError(input);
  if (inputError) throw terminalIpcError(inputError, "Terminal resize input is invalid.");
  return input as TerminalResizeInput;
}

function assertTerminalCancelInput(input: unknown): TerminalCancelInput {
  const inputError = terminalCancelInputError(input);
  if (inputError) throw terminalIpcError(inputError, "Terminal cancel input is invalid.");
  return input as TerminalCancelInput;
}

function assertTerminalSnapshotInput(input: unknown): TerminalSnapshotInput {
  const inputError = terminalSnapshotInputError(input);
  if (inputError) throw terminalIpcError(inputError, "Terminal snapshot input is invalid.");
  return input as TerminalSnapshotInput;
}

function terminalPtyFeatureEnabled(): boolean {
  return process.env.SKYTURN_ENABLE_PTY_INTERACTIVE === "1";
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
  if (kind === "workflow.commit.created" && isRecord(payload.evidence)) return `commit created: ${sanitizeSnippet(payload.evidence.commitSha)}`;
  if (kind === "workflow.delivery.pushed" && isRecord(payload.evidence)) return `delivery pushed: ${sanitizeSnippet(payload.evidence.branch)}`;
  if (kind === "workflow.pull_request.created" && isRecord(payload.evidence)) return `pull request created: ${sanitizeSnippet(payload.evidence.url)}`;
  if (kind === "workflow.pull_request.checks_recorded" && isRecord(payload.evidence)) return `pull request checks: ${sanitizeSnippet(payload.evidence.status)}`;
  if (kind === "workflow.pull_request.merged" && isRecord(payload.evidence)) return `pull request merged: ${sanitizeSnippet(payload.evidence.number)}`;
  if (kind === "workflow.delivery.main_synced" && isRecord(payload.evidence)) return `main synced: ${sanitizeSnippet(payload.evidence.mainBranch)}`;
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

async function resolveGitCommit(repoRoot: string, ref: string): Promise<string> {
  validateGitRefText(ref);
  try {
    const result = await execFileAsync("git", ["-C", repoRoot, "rev-parse", "--verify", `${ref}^{commit}`], {
      encoding: "utf8",
      maxBuffer: 2_000_000,
      shell: false,
    });
    const commit = String(result.stdout).trim();
    if (!/^[0-9a-fA-F]{40}$/.test(commit)) throw new Error("resolved ref is not a full commit hash");
    return commit;
  } catch {
    throw workflowIpcError("INVALID_INPUT", `Worktree base ref does not resolve to a commit: ${ref}.`);
  }
}

function validateGitRefText(ref: string): void {
  if (!ref || ref.startsWith("-") || /[\s\0-\x1f]/.test(ref)) {
    throw workflowIpcError("INVALID_INPUT", "Worktree base ref is invalid.");
  }
  if (
    ref.includes("..") ||
    ref.includes("@{") ||
    ref.includes("\\") ||
    ref.includes("//") ||
    ref.includes(":") ||
    ref.includes("~") ||
    ref.includes("^") ||
    ref.includes("?") ||
    ref.includes("*") ||
    ref.includes("[") ||
    ref.endsWith(".lock") ||
    ref.startsWith("/") ||
    ref.endsWith("/")
  ) {
    throw workflowIpcError("INVALID_INPUT", "Worktree base ref is invalid.");
  }
}

function recordWorktreeCreateFailure(
  store: WorkflowStoreHost,
  input: {
    sessionId: string;
    worktreeId: string;
    variantId: string;
    repoRoot: string;
    branchName: string;
    baseCommit: string;
    parentLaneId: string;
    parentSegmentId?: string;
    reason: string;
  },
): void {
  store.appendWorkflowEvent({
    sessionId: input.sessionId,
    kind: "workflow.worktree.create_failed",
    source: "electron-main",
    idempotencyKey: `worktree:${input.worktreeId}:create-failed`,
    payload: {
      sessionId: input.sessionId,
      worktreeId: input.worktreeId,
      variantId: input.variantId,
      repoRoot: input.repoRoot,
      branchName: input.branchName,
      baseCommit: input.baseCommit,
      parentLaneId: input.parentLaneId,
      ...(input.parentSegmentId ? { parentSegmentId: input.parentSegmentId } : {}),
      status: "failed",
      reason: sanitizeSnippet(input.reason),
    },
    now: new Date().toISOString(),
  });
}

function managedWorktreeEventsFromStore(events: unknown[]): ManagedWorktreeWorkflowEventLike[] {
  const managedEvents: ManagedWorktreeWorkflowEventLike[] = [];
  for (const event of events) {
    if (!isRecord(event) || !isManagedWorktreeEventKind(event.kind)) continue;
    const idempotencyKey = optionalText(event.idempotencyKey);
    if (!idempotencyKey || !isRecord(event.payload)) continue;
    const eventSessionId = optionalText(event.sessionId);
    managedEvents.push({
      kind: event.kind,
      source: "git-worktree",
      payload: event.payload,
      createdAt: optionalText(event.createdAt) ?? new Date().toISOString(),
      idempotencyKey,
      ...(eventSessionId ? { sessionId: eventSessionId } : {}),
    });
  }
  return managedEvents;
}

function isManagedWorktreeEventKind(kind: unknown): kind is ManagedWorktreeWorkflowEventKind {
  return kind === "workflow.worktree.create_requested" ||
    kind === "workflow.worktree.created" ||
    kind === "workflow.worktree.create_failed" ||
    kind === "workflow.worktree.clean_requested" ||
    kind === "workflow.worktree.cleaned" ||
    kind === "workflow.worktree.clean_failed" ||
    kind === "workflow.variant.adopt_requested" ||
    kind === "workflow.variant.adopted" ||
    kind === "workflow.variant.adopt_failed" ||
    kind === "workflow.variant.rejected";
}

function findWorktreeCreatedEvent(events: unknown[], worktreeId: string): unknown | null {
  for (let index = events.length - 1; index >= 0; index -= 1) {
    const event = events[index];
    if (!isRecord(event) || event.kind !== "workflow.worktree.created") continue;
    if (!isRecord(event.payload) || !isRecord(event.payload.worktree)) continue;
    if (event.payload.worktree.worktreeId === worktreeId) return event;
  }
  return null;
}

function findCreatedWorktreeIdentity(events: unknown[], worktreeId: string): WorkflowWorktreeIdentityLike {
  const event = findWorktreeCreatedEvent(events, worktreeId);
  if (!isRecord(event) || !isRecord(event.payload) || !isRecord(event.payload.worktree)) {
    throw workflowIpcError("INVALID_INPUT", `No created worktree event for ${worktreeId}.`);
  }
  return workflowWorktreeIdentityFromRecord(event.payload.worktree);
}

async function assertAdoptedWorktreeBelongsToProject(
  projectRoot: string,
  worktree: WorkflowWorktreeIdentityLike,
): Promise<void> {
  const realProjectRoot = await fs.realpath(projectRoot);
  const repoRoot = await fs.realpath(worktree.repoRoot);
  if (repoRoot !== realProjectRoot) {
    throw workflowIpcError("UNKNOWN_PROJECT", "Worktree repoRoot must match the open project root.");
  }
  const realManagedRoot = await fs.realpath(`${realProjectRoot}.worktrees`);
  const realWorktreePath = await fs.realpath(worktree.realPath || worktree.path);
  if (!isInsidePath(realManagedRoot, realWorktreePath)) {
    throw workflowIpcError("UNSAFE_WORKTREE_PATH", "Worktree path must stay inside the SkyTurn managed worktree directory.");
  }
}

async function assertCleanWorktreeBelongsToProject(
  projectRoot: string,
  worktree: WorkflowWorktreeIdentityLike,
): Promise<void> {
  const realProjectRoot = await fs.realpath(projectRoot);
  const repoRoot = await fs.realpath(worktree.repoRoot).catch(() => path.resolve(worktree.repoRoot));
  if (repoRoot !== realProjectRoot) {
    throw workflowIpcError("UNKNOWN_PROJECT", "Worktree repoRoot must match the open project root.");
  }
  const realWorktreePath = await fs.realpath(worktree.realPath || worktree.path).catch(() => path.resolve(worktree.realPath || worktree.path));
  assertManagedWorktreePath(realProjectRoot, realWorktreePath);
}

function recordVariantAdoptFailure(
  store: WorkflowStoreHost,
  sessionId: string,
  adoption: WorkflowVariantAdoptionLike,
  error: unknown,
): void {
  store.appendWorkflowEvent({
    sessionId,
    kind: "workflow.variant.adopt_failed",
    source: "electron-main",
    idempotencyKey: `variant:${adoption.adoptionId}:adopt-failed`,
    payload: {
      adoption: {
        ...adoption,
        status: "failed",
        failureReason: sanitizeSnippet(error instanceof Error ? error.message : String(error)),
      },
    },
    now: new Date().toISOString(),
  });
}

function recordWorktreeCleanFailure(
  store: WorkflowStoreHost,
  sessionId: string,
  worktree: WorkflowWorktreeIdentityLike,
  error: unknown,
): void {
  const now = new Date().toISOString();
  store.appendWorkflowEvent({
    sessionId,
    kind: "workflow.worktree.clean_failed",
    source: "electron-main",
    idempotencyKey: `worktree:${worktree.worktreeId}:clean-failed`,
    payload: {
      worktree,
      result: {
        ok: false,
        worktreeId: worktree.worktreeId,
        cleanedAt: now,
        branchDeleted: false,
        reason: sanitizeSnippet(error instanceof Error ? error.message : String(error)),
      },
    },
    now,
  });
}

function findVariantAdoptionEvent(events: unknown[], adoptionId: string, status: string): unknown | null {
  const kind = status === "adopted"
    ? "workflow.variant.adopted"
    : status === "failed"
      ? "workflow.variant.adopt_failed"
      : status === "rejected"
        ? "workflow.variant.rejected"
        : "workflow.variant.adopt_requested";
  for (let index = events.length - 1; index >= 0; index -= 1) {
    const event = events[index];
    if (!isRecord(event) || event.kind !== kind) continue;
    if (!isRecord(event.payload) || !isRecord(event.payload.adoption)) continue;
    if (event.payload.adoption.adoptionId === adoptionId) return event;
  }
  return null;
}

function findWorktreeCleanedEvent(events: unknown[], worktreeId: string): unknown | null {
  for (let index = events.length - 1; index >= 0; index -= 1) {
    const event = events[index];
    if (!isRecord(event) || event.kind !== "workflow.worktree.cleaned") continue;
    if (!isRecord(event.payload) || !isRecord(event.payload.result)) continue;
    if (event.payload.result.worktreeId === worktreeId) return event;
  }
  return null;
}

function workflowVariantAdoptionFromRecord(adoption: Record<string, unknown>): WorkflowVariantAdoptionLike {
  const strategy = adoption.strategy;
  if (strategy !== "merge" && strategy !== "cherry-pick") {
    throw workflowIpcError("INVALID_INPUT", "Variant adoption strategy must be merge or cherry-pick.");
  }
  return {
    adoptionId: requireText(adoption.adoptionId, "adoption id"),
    variantId: requireText(adoption.variantId, "variant id"),
    worktreeId: requireText(adoption.worktreeId, "worktree id"),
    strategy,
    status: "requested",
    baseCommit: requireText(adoption.baseCommit, "adoption base commit"),
    headCommit: requireText(adoption.headCommit, "adoption head commit"),
    targetBranchName: requireText(adoption.targetBranchName, "adoption target branch"),
  };
}

function workflowWorktreeIdentityFromRecord(worktree: Record<string, unknown>): WorkflowWorktreeIdentityLike {
  const worktreePath = requireText(worktree.path ?? worktree.realPath, "worktree path");
  const realPath = requireText(worktree.realPath ?? worktree.path, "worktree realPath");
  return {
    worktreeId: requireText(worktree.worktreeId, "worktree id"),
    variantId: requireText(worktree.variantId, "worktree variant id"),
    path: worktreePath,
    realPath,
    gitdir: requireText(worktree.gitdir, "worktree gitdir"),
    repoRoot: requireText(worktree.repoRoot, "worktree repoRoot"),
    branchName: requireText(worktree.branchName, "worktree branch"),
    baseCommit: requireText(worktree.baseCommit, "worktree base commit"),
    headCommit: requireText(worktree.headCommit, "worktree head commit"),
    parentLaneId: requireText(worktree.parentLaneId, "worktree parent lane"),
    ...(optionalText(worktree.parentSegmentId) ? { parentSegmentId: optionalText(worktree.parentSegmentId)! } : {}),
  };
}

function hasRunningTasksForWorktree(
  store: WorkflowStoreHost,
  sessionId: string,
  worktree: WorkflowWorktreeIdentityLike,
): boolean {
  const session = store.materializeCanvasSession(sessionId);
  if (!isRecord(session) || !Array.isArray(session.nodes)) return false;
  for (const node of session.nodes) {
    if (!isRecord(node) || (node.status !== "running" && node.status !== "retrying")) continue;
    if (!isRecord(node.worktree)) continue;
    if (node.worktree.worktreeId === worktree.worktreeId) return true;
    const nodePath = optionalText(node.worktree.realPath) ?? optionalText(node.worktree.path);
    const worktreePath = worktree.realPath || worktree.path;
    if (nodePath && path.resolve(nodePath) === path.resolve(worktreePath)) return true;
  }
  return false;
}

function assertKnownWorkflowCanvasSession(store: WorkflowStoreHost, sessionId: string): void {
  const canvasSession = store.materializeCanvasSession(sessionId);
  if (!isRecord(canvasSession) || canvasSession.id !== sessionId) {
    throw workflowIpcError("UNKNOWN_SESSION", `Workflow session is not known: ${sessionId}.`);
  }
}

function assertWorkflowDeliveryCommitLane(store: WorkflowStoreHost, sessionId: string, laneId: string): void {
  const projection = store.materializeFlowProjection(sessionId) as WorkflowDeliveryFlowProjectionLike;
  if (!isRecord(projection) || !Array.isArray(projection.lanes)) {
    throw workflowIpcError("INVALID_INPUT", "Workflow projection is unavailable.");
  }
  const lane = projection.lanes.find((candidate) => isRecord(candidate) && candidate.id === laneId);
  if (!lane) throw workflowIpcError("INVALID_INPUT", `Workflow lane is not known: ${laneId}.`);
  if (lane.laneKind !== "commit") throw workflowIpcError("INVALID_INPUT", `Workflow lane is not a commit lane: ${laneId}.`);
}

function assertWorkflowPullRequestLane(store: WorkflowStoreHost, sessionId: string, laneId: string, commitLaneId: string): void {
  const projection = store.materializeFlowProjection(sessionId) as WorkflowDeliveryFlowProjectionLike;
  if (!isRecord(projection) || !Array.isArray(projection.lanes)) {
    throw workflowIpcError("INVALID_INPUT", "Workflow projection is unavailable.");
  }
  const lane = projection.lanes.find((candidate) => isRecord(candidate) && candidate.id === laneId);
  if (!lane) throw workflowIpcError("INVALID_INPUT", `Workflow lane is not known: ${laneId}.`);
  if (lane.laneKind !== "pull_request") {
    throw workflowIpcError("INVALID_INPUT", `Workflow lane is not a pull_request lane: ${laneId}.`);
  }
  const linked = Array.isArray(projection.edges) && projection.edges.some((edge) =>
    edge.sourceLaneId === commitLaneId && edge.targetLaneId === laneId
  );
  if (!linked) throw workflowIpcError("INVALID_INPUT", "Pull request lane must depend on the delivery commit lane.");
}

function assertWorkflowPullRequestLaneKind(store: WorkflowStoreHost, sessionId: string, laneId: string): void {
  const projection = store.materializeFlowProjection(sessionId) as WorkflowDeliveryFlowProjectionLike;
  if (!isRecord(projection) || !Array.isArray(projection.lanes)) {
    throw workflowIpcError("INVALID_INPUT", "Workflow projection is unavailable.");
  }
  const lane = projection.lanes.find((candidate) => isRecord(candidate) && candidate.id === laneId);
  if (!lane) throw workflowIpcError("INVALID_INPUT", `Workflow lane is not known: ${laneId}.`);
  if (lane.laneKind !== "pull_request") {
    throw workflowIpcError("INVALID_INPUT", `Workflow lane is not a pull_request lane: ${laneId}.`);
  }
}

function assertWorkflowRemoteMutationLanesActive(store: WorkflowStoreHost, input: RemoteSideEffectOperation): void {
  const projection = store.materializeFlowProjection(input.sessionId) as WorkflowDeliveryFlowProjectionLike;
  if (!isRecord(projection) || !Array.isArray(projection.lanes)) {
    throw workflowIpcError("INVALID_INPUT", "Workflow projection is unavailable.");
  }
  const affectedLaneIds = uniqueStrings([
    ...(input.laneId ? [input.laneId] : []),
    ...(input.affectedLaneIds ?? []),
  ]);
  const rollbackStatuses = isRecord(projection.laneRollbackStatuses) ? projection.laneRollbackStatuses : {};
  for (const laneId of affectedLaneIds) {
    const lane = projection.lanes.find((candidate) => isRecord(candidate) && candidate.id === laneId);
    const rollbackStatus = optionalText(lane?.rollbackStatus) ?? optionalText(rollbackStatuses[laneId]);
    if (rollbackStatus === "rolled_back" || rollbackStatus === "inactive") {
      throw workflowIpcError("DELIVERY_REJECTED", `Remote delivery operation is blocked because workflow lane ${laneId} is ${rollbackStatus}.`);
    }
  }
}

async function resolveDeliveryCommitWorktreePath(
  store: WorkflowStoreHost,
  sessionId: string,
  laneId: string,
  rawWorktreePath: string | null,
  realProjectRoot: string,
): Promise<string> {
  const canvasSession = store.materializeCanvasSession(sessionId);
  if (!isRecord(canvasSession) || !Array.isArray(canvasSession.nodes)) {
    throw workflowIpcError("UNKNOWN_SESSION", `Workflow session is not known: ${sessionId}.`);
  }
  const node = canvasSession.nodes.find((node) => isRecord(node) && node.id === laneId);
  if (!isRecord(node)) throw workflowIpcError("INVALID_INPUT", `Workflow commit lane node is not known: ${laneId}.`);
  if (!isRecord(node.worktree)) throw workflowIpcError("INVALID_INPUT", `Workflow commit lane has no worktree: ${laneId}.`);

  const storedWorktreePath = optionalText(node.worktree.realPath) ?? optionalText(node.worktree.path);
  if (!storedWorktreePath) throw workflowIpcError("INVALID_INPUT", `Workflow commit lane has no worktree path: ${laneId}.`);
  const expectedWorktreePath = path.isAbsolute(storedWorktreePath)
    ? storedWorktreePath
    : path.resolve(realProjectRoot, storedWorktreePath);
  const suppliedWorktreePath = rawWorktreePath
    ? path.isAbsolute(rawWorktreePath) ? rawWorktreePath : path.resolve(realProjectRoot, rawWorktreePath)
    : expectedWorktreePath;

  let realExpectedWorktreePath: string;
  let realSuppliedWorktreePath: string;
  try {
    realExpectedWorktreePath = await fs.realpath(expectedWorktreePath);
    realSuppliedWorktreePath = await fs.realpath(suppliedWorktreePath);
  } catch {
    throw workflowIpcError("UNSAFE_WORKTREE_PATH", "Delivery worktree path is not readable.");
  }
  if (realSuppliedWorktreePath !== realExpectedWorktreePath) {
    throw workflowIpcError("UNSAFE_WORKTREE_PATH", "Delivery worktree path does not match the commit lane worktree.");
  }
  return realExpectedWorktreePath;
}

async function findDeliveryCommitEvidence(
  store: WorkflowStoreHost,
  sessionId: string,
  laneId: string,
  segmentId: string | null,
  worktreePath: string,
): Promise<DeliveryCommitEvidenceLike> {
  const events = store.listEvents(sessionId);
  for (let index = events.length - 1; index >= 0; index -= 1) {
    const event = events[index];
    if (!isRecord(event) || event.kind !== "workflow.commit.created") continue;
    const payload = isRecord(event.payload) ? event.payload : {};
    const eventLaneId = optionalText(event.laneId) ?? optionalText(payload.laneId);
    if (eventLaneId !== laneId) continue;
    const eventSegmentId = optionalText(event.segmentId) ?? optionalText(payload.segmentId);
    if (segmentId && eventSegmentId !== segmentId) continue;
    if (!isRecord(payload.evidence)) continue;
    const evidence = {
      commitSha: requireText(payload.evidence.commitSha, "delivery commit sha"),
      branch: requireText(payload.evidence.branch, "delivery branch"),
      worktreePath: requireText(payload.evidence.worktreePath, "delivery worktree path"),
    };
    const realEvidenceWorktree = await fs.realpath(evidence.worktreePath).catch(() => path.resolve(evidence.worktreePath));
    const realWorktreePath = await fs.realpath(worktreePath).catch(() => path.resolve(worktreePath));
    if (realEvidenceWorktree !== realWorktreePath) {
      throw workflowIpcError("UNSAFE_WORKTREE_PATH", "Recorded delivery commit worktree does not match the lane worktree.");
    }
    return evidence;
  }
  throw workflowIpcError("INVALID_INPUT", `No delivery commit evidence is recorded for lane ${laneId}.`);
}

function findDeliveryPushEvidenceForPullRequest(
  store: WorkflowStoreHost,
  sessionId: string,
  laneId: string,
  commitEvidence: DeliveryCommitEvidenceLike,
  remote: string,
): DeliveryPushEvidenceLike | null {
  const events = store.listEvents(sessionId);
  for (let index = events.length - 1; index >= 0; index -= 1) {
    const event = events[index];
    if (!isRecord(event) || event.kind !== "workflow.delivery.pushed") continue;
    const payload = isRecord(event.payload) ? event.payload : {};
    const eventLaneId = optionalText(event.laneId) ?? optionalText(payload.laneId);
    if (eventLaneId !== laneId) continue;
    const evidence = isRecord(payload.evidence) ? payload.evidence : {};
    const commitSha = optionalText(payload.commitSha) ?? optionalText(evidence.commitSha);
    const branch = optionalText(payload.branch) ?? optionalText(evidence.branch);
    const eventRemote = optionalText(payload.remote) ?? optionalText(evidence.remote) ?? "origin";
    if (commitSha !== commitEvidence.commitSha || branch !== commitEvidence.branch || eventRemote !== remote) continue;
    return { commitSha, branch, remote: eventRemote };
  }
  return null;
}

function findDeliveryPullRequestEvidence(
  store: WorkflowStoreHost,
  sessionId: string,
  laneId: string,
): DeliveryPullRequestEvidenceLike {
  const events = store.listEvents(sessionId);
  for (let index = events.length - 1; index >= 0; index -= 1) {
    const event = events[index];
    if (!isRecord(event) || event.kind !== "workflow.pull_request.created") continue;
    const payload = isRecord(event.payload) ? event.payload : {};
    const eventLaneId = optionalText(event.laneId) ?? optionalText(payload.laneId);
    if (eventLaneId !== laneId) continue;
    if (!isRecord(payload.evidence)) continue;
    return {
      number: normalizePullRequestNumberForIpc(payload.evidence.number),
      url: requireText(payload.evidence.url, "pull request URL"),
      commitSha: requireText(payload.evidence.commitSha, "pull request head SHA"),
      ...(optionalText(payload.commitLaneId) ? { commitLaneId: optionalText(payload.commitLaneId)! } : {}),
      ...(optionalText(payload.evidence.head) ? { headBranch: optionalText(payload.evidence.head)! } : {}),
    };
  }
  throw workflowIpcError("INVALID_INPUT", `No pull request evidence is recorded for lane ${laneId}.`);
}

function findDeliveryPullRequestCurrentHeadEvidence(
  store: WorkflowStoreHost,
  sessionId: string,
  laneId: string,
  prEvidence: DeliveryPullRequestEvidenceLike,
): DeliveryPullRequestCurrentHeadEvidenceLike {
  let current: DeliveryPullRequestCurrentHeadEvidenceLike = {
    headSha: prEvidence.commitSha,
    ...(prEvidence.headBranch ? { headBranch: prEvidence.headBranch } : {}),
  };
  const events = store.listEvents(sessionId);
  for (const event of events) {
    if (!isRecord(event) || event.kind !== "workflow.delivery.pushed") continue;
    const payload = isRecord(event.payload) ? event.payload : {};
    const eventLaneId = optionalText(event.laneId) ?? optionalText(payload.laneId);
    if (prEvidence.commitLaneId) {
      if (eventLaneId !== prEvidence.commitLaneId) continue;
    } else if (eventLaneId !== laneId) {
      continue;
    }
    const evidence = isRecord(payload.evidence) ? payload.evidence : {};
    const headSha = optionalText(payload.commitSha) ?? optionalText(evidence.commitSha);
    if (!headSha) continue;
    const headBranch = optionalText(payload.branch) ?? optionalText(evidence.branch);
    if (prEvidence.headBranch && headBranch && headBranch !== prEvidence.headBranch) continue;
    current = {
      headSha,
      ...(headBranch ?? current.headBranch ? { headBranch: headBranch ?? current.headBranch } : {}),
    };
  }
  return current;
}

function findDeliveryPullRequestChecksEvidence(
  store: WorkflowStoreHost,
  sessionId: string,
  laneId: string,
  expectedHeadSha: string,
): DeliveryPullRequestChecksEvidenceLike {
  const events = store.listEvents(sessionId);
  let latestEvidence: DeliveryPullRequestChecksEvidenceLike | null = null;
  for (let index = events.length - 1; index >= 0; index -= 1) {
    const event = events[index];
    if (!isRecord(event) || event.kind !== "workflow.pull_request.checks_recorded") continue;
    const payload = isRecord(event.payload) ? event.payload : {};
    const eventLaneId = optionalText(event.laneId) ?? optionalText(payload.laneId);
    if (eventLaneId !== laneId) continue;
    if (!isRecord(payload.evidence)) continue;
    const evidence = {
      status: requireText(payload.evidence.status, "pull request checks status"),
      headSha: requireText(payload.evidence.headSha, "pull request checks head SHA"),
      reviewStatus: pullRequestReviewStatusForIpc(payload, payload.evidence),
    };
    latestEvidence ??= evidence;
    if (evidence.headSha !== expectedHeadSha) continue;
    if (evidence.status !== "passed") {
      throw workflowIpcError("DELIVERY_REJECTED", `Pull request checks must be passed before merge; got ${evidence.status}.`);
    }
    if (evidence.reviewStatus === "changes_requested") {
      throw workflowIpcError("DELIVERY_REJECTED", "Pull request review requested changes before merge.");
    }
    if (evidence.reviewStatus !== "approved" && evidence.reviewStatus !== "pending") {
      throw workflowIpcError(
        "DELIVERY_REJECTED",
        `Pull request review evidence must be approved or pending before merge; got ${evidence.reviewStatus || "unknown"}.`,
      );
    }
    return evidence;
  }
  if (latestEvidence && latestEvidence.headSha !== expectedHeadSha) {
    throw workflowIpcError("DELIVERY_REJECTED", "Pull request checks are stale for the current head.");
  }
  throw workflowIpcError("DELIVERY_REJECTED", "No pull request checks are recorded for this head SHA.");
}

function findDeliveryPullRequestMergeEvidence(
  store: WorkflowStoreHost,
  sessionId: string,
  laneId: string,
  prEvidence: DeliveryPullRequestEvidenceLike,
  expectedHeadSha: string,
): DeliveryPullRequestMergeEvidenceLike {
  const events = store.listEvents(sessionId);
  for (let index = events.length - 1; index >= 0; index -= 1) {
    const event = events[index];
    if (!isRecord(event) || event.kind !== "workflow.pull_request.merged") continue;
    const payload = isRecord(event.payload) ? event.payload : {};
    const eventLaneId = optionalText(event.laneId) ?? optionalText(payload.laneId);
    if (eventLaneId !== laneId) continue;
    if (!isRecord(payload.evidence)) continue;
    const prNumber = positiveInteger(payload.prNumber) ?? positiveInteger(payload.evidence.number);
    const headSha = optionalText(payload.headSha) ?? optionalText(payload.evidence.headSha);
    const status = optionalText(payload.status) ?? optionalText(payload.evidence.status);
    if (prNumber !== prEvidence.number || headSha !== expectedHeadSha) continue;
    if (status !== "merged") {
      throw workflowIpcError("DELIVERY_REJECTED", `Pull request merge evidence must be merged; got ${status ?? "unknown"}.`);
    }
    return {
      status: "merged",
      number: prNumber,
      headSha,
    };
  }
  throw workflowIpcError("DELIVERY_REJECTED", "No pull request merge evidence is recorded for this PR head.");
}

function pullRequestReviewStatusForIpc(
  payload: Record<string, unknown>,
  evidence: Record<string, unknown>,
): string {
  const payloadReview = isRecord(payload.review) ? payload.review : {};
  const evidenceReview = isRecord(evidence.review) ? evidence.review : {};
  const payloadGate = isRecord(payload.gate) ? payload.gate : {};
  const evidenceGate = isRecord(evidence.gate) ? evidence.gate : {};
  const explicit = optionalText(payloadReview.status) ??
    optionalText(evidenceReview.status) ??
    optionalText(payloadGate.reviewStatus) ??
    optionalText(evidenceGate.reviewStatus);
  const normalized = normalizePullRequestReviewStatusForIpc(explicit);
  if (normalized) return normalized;
  const checks = Array.isArray(payload.checks) ? payload.checks : Array.isArray(evidence.checks) ? evidence.checks : [];
  return checks.some((check) => isRecord(check) && normalizePullRequestReviewStatusForIpc(optionalText(check.status)) === "changes_requested")
    ? "changes_requested"
    : "unknown";
}

function normalizePullRequestReviewStatusForIpc(value: string | null | undefined): string | null {
  const status = value?.trim().toLowerCase();
  if (!status) return null;
  if (status === "approved" || status === "approve") return "approved";
  if (status === "changes_requested" || status === "changes requested") return "changes_requested";
  if (status === "review_required" || status === "review required" || status === "pending") return "pending";
  if (status === "unknown") return "unknown";
  return null;
}

function assertConventionalCommitSubjectForIpc(subject: string): void {
  if (!/^[a-z][a-z0-9-]*(?:\([a-z0-9._/-]+\))?!?: .+$/.test(subject)) {
    throw workflowIpcError("INVALID_INPUT", "Pull request merge subject must use Conventional Commits format.");
  }
}

function assertDeliveryEvidenceInputMatches(
  input: Record<string, unknown>,
  evidence: DeliveryCommitEvidenceLike,
): void {
  const commitSha = optionalText(readField(input, "commitSha"));
  if (commitSha && commitSha !== evidence.commitSha) {
    throw workflowIpcError("INVALID_INPUT", "Requested commitSha does not match recorded delivery commit evidence.");
  }
  const branch = optionalText(readField(input, "branch")) ?? optionalText(readField(input, "headBranch"));
  if (branch && branch !== evidence.branch) {
    throw workflowIpcError("INVALID_INPUT", "Requested delivery branch does not match recorded delivery commit evidence.");
  }
}

function assertDeliveryPullRequestEvidenceInputMatches(
  input: Record<string, unknown>,
  evidence: DeliveryPullRequestEvidenceLike,
  currentHeadSha: string = evidence.commitSha,
): string {
  const expectedHeadSha = requireText(readField(input, "expectedHeadSha"), "expected pull request head SHA");
  if (expectedHeadSha !== currentHeadSha) {
    throw workflowIpcError("REMOTE_HEAD_MISMATCH", "Expected head SHA does not match recorded current pull request head evidence.");
  }
  const prNumber = positiveInteger(readField(input, "prNumber"));
  if (prNumber !== null && prNumber !== evidence.number) {
    throw workflowIpcError("INVALID_INPUT", "Requested pull request number does not match recorded pull request evidence.");
  }
  const prUrl = optionalText(readField(input, "prUrl"));
  if (prUrl && prUrl !== evidence.url) {
    throw workflowIpcError("INVALID_INPUT", "Requested pull request URL does not match recorded pull request evidence.");
  }
  return expectedHeadSha;
}

function normalizePullRequestNumberForIpc(value: unknown): number {
  const number = positiveInteger(value);
  if (number === null) throw workflowIpcError("INVALID_INPUT", "Pull request number is invalid.");
  return number;
}

async function validatePullRequestBaseBranch(
  store: WorkflowStoreHost,
  sessionId: string,
  realProjectRoot: string,
  rawBaseBranch: string,
  headBranch: string,
  rawRemote: string,
): Promise<string> {
  const remote = normalizeRemoteNameForIpc(rawRemote);
  const baseBranch = await normalizePullRequestBranchName(realProjectRoot, rawBaseBranch, remote, "pull request base branch");
  const normalizedHead = await normalizePullRequestBranchName(realProjectRoot, headBranch, remote, "pull request head branch");
  if (baseBranch === normalizedHead) {
    throw workflowIpcError("INVALID_INPUT", "Pull request base and head branches must differ.");
  }
  const targetBase = await pullRequestBaseFromSessionTarget(store, sessionId, realProjectRoot, remote);
  if (targetBase && targetBase !== baseBranch) {
    throw workflowIpcError("INVALID_INPUT", `Pull request base must match the session base branch: ${targetBase}.`);
  }
  const local = await gitExitCode(realProjectRoot, ["rev-parse", "--verify", `refs/heads/${baseBranch}^{commit}`]);
  if (local === 0) return baseBranch;
  const remoteTracking = await gitExitCode(realProjectRoot, ["rev-parse", "--verify", `refs/remotes/${remote}/${baseBranch}^{commit}`]);
  if (remoteTracking === 0) return baseBranch;
  const remoteHead = await gitExitCode(realProjectRoot, ["ls-remote", "--exit-code", "--heads", remote, baseBranch]);
  if (remoteHead === 0) return baseBranch;
  throw workflowIpcError("INVALID_INPUT", `Pull request base branch does not resolve: ${baseBranch}.`);
}

async function pullRequestBaseFromSessionTarget(
  store: WorkflowStoreHost,
  sessionId: string,
  realProjectRoot: string,
  remote: string,
): Promise<string | null> {
  const canvasSession = store.materializeCanvasSession(sessionId);
  if (!isRecord(canvasSession) || !isRecord(canvasSession.target)) return null;
  const target = normalizeFinalSessionTarget(canvasSession.target);
  if (target.executionTarget !== "new_worktree") return null;
  const value = target.baseRef ?? target.selectedBranch;
  if (!value || value === "HEAD") return null;
  return normalizePullRequestBranchName(realProjectRoot, value, remote, "session base branch");
}

function normalizeRemoteNameForIpc(value: string): string {
  const remote = value.trim();
  if (!/^[A-Za-z0-9._-]+$/.test(remote)) throw workflowIpcError("INVALID_INPUT", "Git remote name is invalid.");
  return remote;
}

async function normalizePullRequestBranchName(
  repoRoot: string,
  value: string,
  remote: string,
  field: string,
): Promise<string> {
  let branch = value.trim();
  if (branch.startsWith("refs/heads/")) branch = branch.slice("refs/heads/".length);
  if (branch.startsWith(`${remote}/`)) branch = branch.slice(remote.length + 1);
  validateGitRefText(branch);
  const valid = await gitExitCode(repoRoot, ["check-ref-format", "--branch", branch]);
  if (valid !== 0) throw workflowIpcError("INVALID_INPUT", `${field} is invalid.`);
  return branch;
}

async function gitExitCode(repoRoot: string, args: string[]): Promise<number> {
  try {
    await execFileAsync("git", ["-C", repoRoot, ...args], {
      encoding: "utf8",
      maxBuffer: 2_000_000,
      shell: false,
    });
    return 0;
  } catch (error) {
    const failure = error as { code?: number | string };
    return typeof failure.code === "number" ? failure.code : 1;
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

function deliveryFilesFromInput(value: unknown): string[] {
  if (!Array.isArray(value) || value.length === 0) {
    throw workflowIpcError("INVALID_INPUT", "Delivery file list must be non-empty.");
  }
  return value.map((file) => requireText(file, "delivery file path"));
}

function deliveryReconciliationStatus(input: Record<string, unknown>): "available" | "empty" | "failed" | "mismatch" | null {
  const reconciliation = readField(input, "reconciliation");
  const status = optionalText(readField(input, "reconciliationStatus")) ??
    (isRecord(reconciliation) ? optionalText(readField(reconciliation, "status")) : null);
  if (!status) return null;
  if (status === "available" || status === "empty" || status === "failed" || status === "mismatch") return status;
  throw workflowIpcError("INVALID_INPUT", "Delivery reconciliation status is invalid.");
}

function requireText(value: unknown, field: string): string {
  const text = optionalText(value);
  if (!text) throw workflowIpcError("INVALID_INPUT", `${field} is required.`);
  return text;
}

function requireWorktreeToken(value: unknown, field: string): string {
  const text = requireText(value, field);
  if (!/^[A-Za-z0-9._-]+$/.test(text)) {
    throw workflowIpcError("INVALID_INPUT", `${field} must contain only letters, numbers, dot, underscore, or dash.`);
  }
  return text;
}

function optionalText(value: unknown): string | null {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : null;
}

function normalizeDeliveryCommitIpcError(error: unknown): Error {
  const message = error instanceof Error ? error.message : String(error);
  if (isRecord(error)) {
    const code = deliveryCommitIpcErrorCode(error.code);
    if (code) return workflowIpcError(code, message);
  }
  return normalizeWorkflowIpcError(error);
}

function normalizeDeliveryRemoteIpcError(error: unknown): Error {
  const message = error instanceof Error ? error.message : String(error);
  if (isRecord(error)) {
    const code = deliveryRemoteIpcErrorCode(error.code);
    if (code) return workflowIpcError(code, message);
  }
  return normalizeWorkflowIpcError(error);
}

function deliveryCommitIpcErrorCode(value: unknown): WorkflowIpcErrorCode | null {
  if (value === "INVALID_INPUT" || value === "UNSAFE_WORKTREE_PATH" || value === "DELIVERY_REJECTED") return value;
  return null;
}

function isKnownPreMutationDeliveryRemoteError(error: unknown): boolean {
  if (!isRecord(error)) return false;
  const code = deliveryRemoteIpcErrorCode(error.code);
  if (!code) return false;
  if (code === "INVALID_INPUT" || code === "UNSAFE_WORKTREE_PATH") return true;
  if (code === "GH_UNAVAILABLE" || code === "AUTH_REQUIRED" || code === "REMOTE_HEAD_MISMATCH") return true;
  if (code !== "DELIVERY_REJECTED") return false;
  const message = error instanceof Error ? error.message : String(error.message ?? "");
  return knownPreMutationDeliveryRejectedMessage(message);
}

function knownPreMutationDeliveryRejectedMessage(message: string): boolean {
  return [
    "Delivery commit must match worktree HEAD:",
    "Delivery branch must match the current worktree branch:",
    "Pull request base and head branches must differ.",
    "Remote branch was not found after push:",
    "Pull request must be open before merge;",
    "Pull request is not mergeable.",
    "Pull request checks must be passed before merge;",
    "Refusing to sync ",
    "GitHub CLI did not return pull request JSON.",
    "GitHub CLI did not return pull request checks JSON.",
  ].some((prefix) => message.includes(prefix));
}

function deliveryRemoteIpcErrorCode(value: unknown): WorkflowIpcErrorCode | null {
  if (
    value === "INVALID_INPUT" ||
    value === "UNSAFE_WORKTREE_PATH" ||
    value === "DELIVERY_REJECTED" ||
    value === "GH_UNAVAILABLE" ||
    value === "AUTH_REQUIRED" ||
    value === "REMOTE_HEAD_MISMATCH"
  ) {
    return value;
  }
  return null;
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
