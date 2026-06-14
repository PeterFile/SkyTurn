import type { EditorAdapter, EditorKind } from "@skyturn/git-worktree";
import {
  makeHermesPlannerSessionId,
  type AgentDescriptor,
  type AgentRun,
  type CanvasNode,
  type CanvasSession,
  type CanvasSessionTab,
  type Changeset,
  type ImportedProject,
  type RunEvent,
  type RunEvidence,
  type StartAgentRunInput,
} from "@skyturn/project-core";

export interface OpenProjectResult {
  canceled: boolean;
  project?: {
    name: string;
    rootPath: string;
    devflowPath: string;
  };
}

export interface DevflowApi {
  openProject: () => Promise<OpenProjectResult>;
  initializeProjectMemory: (rootPath: string) => Promise<{ ok: boolean; devflowPath: string }>;
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
  onRunEvent: (listener: (event: RunEvent) => void) => () => void;
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
  return {
    ...session,
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
