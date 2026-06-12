import type { EditorAdapter, EditorKind } from "@skyturn/git-worktree";
import type { CanvasSessionTab, Changeset, ImportedProject } from "@skyturn/project-core";

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
  activeProjectId: string | null;
  activeSessionId: string | null;
  sidebarCollapsed: boolean;
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
    activeProjectId: null,
    activeSessionId: null,
    sidebarCollapsed: false,
  };
}

export const localWorkspaceStore: WorkspaceStore = {
  async load() {
    try {
      const value = window.localStorage.getItem(storageKey);
      return normalizeWorkspace(value ? (JSON.parse(value) as Partial<WorkspaceState>) : null);
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
    return normalizeWorkspace(value as Partial<WorkspaceState> | null);
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

function normalizeWorkspace(value: Partial<WorkspaceState> | null): WorkspaceState {
  return {
    ...emptyWorkspace(),
    ...value,
    projects: value?.projects ?? [],
    sessions: value?.sessions ?? [],
    changesets: value?.changesets ?? {},
  };
}
