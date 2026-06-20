import type { DeliveryCommitEvidence, EditorAdapter, EditorKind, GitBranchFacts, ManagedWorktreeCleanupResult } from "@skyturn/git-worktree";
import {
  makeHermesPlannerSessionId,
  normalizeSessionTarget,
  type AgentDescriptor,
  type AgentKind,
  type AgentRun,
  type CanvasNode,
  type CanvasSession,
  type CanvasSessionTab,
  type Changeset,
  type FinalChangesetReconciliation,
  type ImportedProject,
  type RunEvent,
  type RunEvidence,
  type SessionTarget,
  type StartAgentRunInput,
  type WorkflowLedgerSummary,
  type WorkflowVariantAdoption,
  type WorkflowWorktreeIdentity,
} from "@skyturn/project-core";

export interface OpenProjectResult {
  canceled: boolean;
  project?: {
    name: string;
    rootPath: string;
    devflowPath: string;
  };
}

export interface WorkflowRunResultRecordRequest {
  sessionId: string;
  laneId: string;
  segmentId: string;
  runId: string;
  agentKind: AgentKind;
  now: string;
}

export interface FinalChangesetReconciliationRequest {
  node: CanvasNode;
  target: SessionTarget;
  baselineRef?: string;
  runEvents?: RunEvent[];
}

export interface WorkflowApi {
  createSession: (projectRoot: string, input: unknown) => Promise<{ protocolVersion: number; session: unknown; projection: unknown; canvasSession: CanvasSession | null }>;
  appendUserInput: (projectRoot: string, input: unknown) => Promise<{ protocolVersion: number; event: unknown; ledger: unknown; projection: unknown; canvasSession: CanvasSession | null }>;
  getLedger: (projectRoot: string, sessionId: string) => Promise<{ protocolVersion: number; ledger: WorkflowLedgerSummary }>;
  applyIntent: (projectRoot: string, intent: unknown) => Promise<{ protocolVersion: number; result: unknown; projection: unknown; canvasSession: CanvasSession | null }>;
  scheduleReady: (projectRoot: string, input: unknown) => Promise<{ protocolVersion: number; result: unknown; projection: unknown; canvasSession: CanvasSession | null }>;
  recordRunResult: (projectRoot: string, input: WorkflowRunResultRecordRequest) => Promise<{ protocolVersion: number; projection: unknown; canvasSession: CanvasSession | null }>;
  getProjection: (projectRoot: string, sessionId: string) => Promise<{ protocolVersion: number; projection: unknown; canvasSession: CanvasSession | null }>;
  getEvents: (projectRoot: string, sessionId: string) => Promise<{ protocolVersion: number; events: unknown[] }>;
  answerUserDecision: (projectRoot: string, input: unknown) => Promise<{ protocolVersion: number; event: unknown; projection: unknown; canvasSession: CanvasSession | null }>;
  createWorktree: (projectRoot: string, input: unknown) => Promise<{ protocolVersion: number; status: "created"; event: unknown; worktree: WorkflowWorktreeIdentity }>;
  compareWorktrees: (projectRoot: string, input: unknown) => Promise<{ protocolVersion: number; comparison: unknown }>;
  adoptWorktree: (projectRoot: string, input: unknown) => Promise<{ protocolVersion: number; status: "adopted" | "failed"; event: unknown | null; adoption: WorkflowVariantAdoption & { status: "adopted" | "failed" } }>;
  cleanWorktree: (projectRoot: string, input: unknown) => Promise<{ protocolVersion: number; status: "cleaned"; event: unknown | null; result: ManagedWorktreeCleanupResult }>;
  createDeliveryCommit: (projectRoot: string, input: unknown) => Promise<{ protocolVersion: number; status: "committed"; event: unknown | null; evidence: DeliveryCommitEvidence }>;
  getChangeset: (projectRoot: string, input: unknown) => Promise<{ protocolVersion: number; changeset: Changeset }>;
  reconcileFinalChangeset: (projectRoot: string, input: FinalChangesetReconciliationRequest) => Promise<{ protocolVersion: number; reconciliation: FinalChangesetReconciliation }>;
}

export interface DevflowApi {
  openProject: () => Promise<OpenProjectResult>;
  initializeProjectMemory: (rootPath: string) => Promise<{ ok: boolean; devflowPath: string }>;
  getProjectBranchFacts: (projectRoot: string) => Promise<{ protocolVersion: number } & GitBranchFacts>;
  loadWorkspace: () => Promise<unknown | null>;
  saveWorkspace: (state: unknown) => Promise<{ ok: boolean }>;
  openEditor: (editor: EditorKind, worktreePath: string) => Promise<{ ok: boolean; message: string }>;
  discoverAgents: () => Promise<{ protocolVersion: number; agents: AgentDescriptor[] }>;
  getAgentHealth: () => Promise<{ protocolVersion: number; agents: AgentDescriptor[] }>;
  startAgentRun: (input: StartAgentRunInput) => Promise<{ protocolVersion: number; run: AgentRun }>;
  sendRunMessage: (runId: string, message: string) => Promise<{ protocolVersion: number; ok: boolean }>;
  cancelAgentRun: (runId: string, reason: string) => Promise<{ protocolVersion: number; evidence: RunEvidence }>;
  getRunEvents: (projectRoot: string, runId: string) => Promise<{ protocolVersion: number; events: RunEvent[] }>;
  listAgentRuns: () => Promise<{ protocolVersion: number; runs: AgentRun[] }>;
  getRunEvidence: (projectRoot: string, runId: string) => Promise<{ protocolVersion: number; evidence: RunEvidence }>;
  createWorkflowSession: (projectRoot: string, input: unknown) => Promise<{ protocolVersion: number; session: unknown; projection: unknown; canvasSession: CanvasSession | null }>;
  appendWorkflowUserInput: (projectRoot: string, input: unknown) => Promise<{ protocolVersion: number; event: unknown; ledger: unknown; projection: unknown; canvasSession: CanvasSession | null }>;
  getWorkflowLedger: (projectRoot: string, sessionId: string) => Promise<{ protocolVersion: number; ledger: unknown }>;
  getChangeset: (projectRoot: string, node: CanvasNode) => Promise<{ protocolVersion: number; changeset: Changeset }>;
  reconcileFinalChangeset: (projectRoot: string, input: FinalChangesetReconciliationRequest) => Promise<{ protocolVersion: number; reconciliation: FinalChangesetReconciliation }>;
  applyWorkflowIntent: (projectRoot: string, intent: unknown) => Promise<{ protocolVersion: number; result: unknown; projection: unknown; canvasSession: CanvasSession | null }>;
  scheduleWorkflowReadyLanes: (projectRoot: string, sessionId: string, input: unknown) => Promise<{ protocolVersion: number; result: unknown; projection: unknown; canvasSession: CanvasSession | null }>;
  recordWorkflowRunResult: (projectRoot: string, input: WorkflowRunResultRecordRequest) => Promise<{ protocolVersion: number; projection: unknown; canvasSession: CanvasSession | null }>;
  getWorkflowProjection: (projectRoot: string, sessionId: string) => Promise<{ protocolVersion: number; projection: unknown; canvasSession: CanvasSession | null }>;
  workflow: WorkflowApi;
  getWorkflowEvents: (projectRoot: string, sessionId: string) => Promise<{ protocolVersion: number; events: unknown[] }>;
  createWorkflowDeliveryCommit: (projectRoot: string, input: unknown) => Promise<{ protocolVersion: number; status: "committed"; event: unknown | null; evidence: DeliveryCommitEvidence }>;
  onRunEvent: (listener: (event: RunEvent) => void) => () => void;
  onWorkflowEvent: (listener: (event: unknown) => void) => () => void;
}

declare global {
  interface Window {
    devflow?: DevflowApi;
  }
}

export interface WorkspaceState {
  projects: ImportedProject[];
  sessions: CanvasSessionTab[];
  changesets: Record<string, Changeset>;
  agents: AgentDescriptor[];
  runs: Record<string, AgentRun>;
  runEvents: Record<string, RunEvent[]>;
  runEvidence: Record<string, RunEvidence>;
  activeProjectId: string | null;
  activeSessionId: string | null;
  sidebarCollapsed: boolean;
  collapsedProjectIds: string[];
}

export interface WorkspaceStore {
  load(): Promise<WorkspaceState>;
  save(state: WorkspaceState): Promise<void>;
}

const storageKey = "skyturn.workspace.v1";

export function emptyWorkspace(): WorkspaceState {
  return {
    projects: [],
    sessions: [],
    changesets: {},
    agents: [],
    runs: {},
    runEvents: {},
    runEvidence: {},
    activeProjectId: null,
    activeSessionId: null,
    sidebarCollapsed: false,
    collapsedProjectIds: [],
  };
}

export const localWorkspaceStore: WorkspaceStore = {
  async load() {
    try {
      const value = window.localStorage.getItem(storageKey);
      return normalizeWorkspaceState(value ? (JSON.parse(value) as Partial<WorkspaceState>) : null);
    } catch {
      return emptyWorkspace();
    }
  },
  async save(state) {
    window.localStorage.setItem(storageKey, JSON.stringify(state));
  },
};

export const fileBackedWorkspaceStore: WorkspaceStore = {
  async load() {
    if (!window.devflow) return localWorkspaceStore.load();
    const value = await window.devflow.loadWorkspace();
    return normalizeWorkspaceState(value as Partial<WorkspaceState> | null);
  },
  async save(state) {
    if (!window.devflow) {
      await localWorkspaceStore.save(state);
      return;
    }
    await window.devflow.saveWorkspace(state);
  },
};

export async function loadWorkspaceState(): Promise<WorkspaceState> {
  return fileBackedWorkspaceStore.load();
}

export async function saveWorkspaceState(state: WorkspaceState): Promise<void> {
  await fileBackedWorkspaceStore.save(state);
}

export const browserEditorAdapter: EditorAdapter = {
  async openWorktree(editor, worktreePath) {
    if (window.devflow) return window.devflow.openEditor(editor, worktreePath);
    return {
      ok: true,
      message: `${editor} launch is mocked in browser mode; target: ${worktreePath}`,
    };
  },
};

export function normalizeWorkspaceState(value: Partial<WorkspaceState> | null): WorkspaceState {
  return {
    ...emptyWorkspace(),
    ...value,
    projects: value?.projects ?? [],
    sessions: (value?.sessions ?? []).map(normalizeSession),
    changesets: value?.changesets ?? {},
    agents: value?.agents ?? [],
    runs: value?.runs ?? {},
    runEvents: value?.runEvents ?? {},
    runEvidence: value?.runEvidence ?? {},
    collapsedProjectIds: Array.isArray(value?.collapsedProjectIds) ? value.collapsedProjectIds : [],
  };
}

function normalizeSession(session: CanvasSessionTab): CanvasSessionTab {
  if (session.kind !== "canvas") return session;
  return normalizeCanvasSession(session);
}

function normalizeCanvasSession(session: CanvasSession): CanvasSession {
  const nodes = Array.isArray(session.nodes) ? session.nodes : [];
  const edges = Array.isArray(session.edges) ? session.edges : [];
  const legacyTarget = session as unknown as {
    target?: unknown;
    executionTarget?: unknown;
    selectedBranch?: unknown;
    baseRef?: unknown;
  };
  return {
    ...session,
    target: normalizeSessionTarget(legacyTarget.target ?? legacyTarget),
    hermesPlannerSessionId: session.hermesPlannerSessionId || makeHermesPlannerSessionId(session.id),
    plannerNodeId: session.plannerNodeId || inferPlannerNodeId(nodes, session.activeNodeId),
    nodes,
    edges,
  };
}

function inferPlannerNodeId(nodes: CanvasNode[], activeNodeId: string | null): string {
  const activeNode = nodes.find((node) => node.id === activeNodeId);
  if (activeNode?.agent === "hermes") return activeNode.id;
  return (
    nodes.find((node) => node.agent === "hermes" && node.context.dependencies.length === 0)?.id ??
    nodes.find((node) => node.agent === "hermes")?.id ??
    nodes[0]?.id ??
    "node-1"
  );
}
