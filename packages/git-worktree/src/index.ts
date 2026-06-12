import type { CanvasNode, Changeset, WorktreeMetadata } from "@skyturn/project-core";

export type EditorKind = "vscode" | "cursor" | "zed";

export interface GitService {
  getBaseCommit(projectId: string): Promise<string>;
}

export interface WorktreeService {
  createWorktree(node: CanvasNode): Promise<WorktreeMetadata>;
  cancelRun(runId: string): Promise<{ ok: boolean; persisted: boolean }>;
}

export interface ChangesetService {
  getChangeset(node: CanvasNode): Promise<Changeset>;
}

export interface EditorAdapter {
  openWorktree(editor: EditorKind, worktreePath: string): Promise<{ ok: boolean; message: string }>;
}

export const mockGitService: GitService = {
  async getBaseCommit() {
    return "mock-base-commit";
  },
};

export const mockWorktreeService: WorktreeService = {
  async createWorktree(node) {
    return node.worktree;
  },
  async cancelRun() {
    return { ok: true, persisted: true };
  },
};

export const mockChangesetService: ChangesetService = {
  async getChangeset(node) {
    return createMockChangeset(node);
  },
};

export function createMockChangeset(node: CanvasNode): Changeset {
  return {
    id: node.changesetId,
    files: [`src/tasks/${node.id}.ts`, `.devflow/tasks/${node.id}/result.md`],
    diffStat: {
      added: 42,
      changed: 3,
      deleted: 0,
    },
    patchPreview: [
      `diff --git a/.devflow/tasks/${node.id}/result.md b/.devflow/tasks/${node.id}/result.md`,
      "+ Mock task-local output persisted.",
      "+ Verification evidence remains required before completion.",
    ].join("\n"),
    source: "mock",
  };
}
