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
import {
  isTrustedPlannerRootStartInput,
  normalizeWorkflowIpcError,
  rejectMissingWorkflowProjectionNode,
  workflowIpcError,
  workflowStartInputError,
  type WorkflowIpcErrorCode,
} from "./workflowIpcContracts";

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
  }>;
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

interface WorkflowWorktreeIdentityLike {
  worktreeId: string;
  variantId: string;
  path: string;
  realPath: string;
  gitdir: string;
  repoRoot: string;
  branchName: string;
  baseCommit: string;
  headCommit: string;
  parentLaneId: string;
  parentSegmentId?: string;
}

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
    target: normalizeWorkflowSessionTarget(input.target),
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
    case "workflow.commit.created":
      return "Commit created.";
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

function deliveryCommitIpcErrorCode(value: unknown): WorkflowIpcErrorCode | null {
  if (value === "INVALID_INPUT" || value === "UNSAFE_WORKTREE_PATH" || value === "DELIVERY_REJECTED") return value;
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
