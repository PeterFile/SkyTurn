import type { CanvasNode, Changeset, WorktreeMetadata } from "@skyturn/project-core";

export type EditorKind =
  | "vscode"
  | "cursor"
  | "zed"
  | "antigravity"
  | "finder"
  | "terminal"
  | "iterm2"
  | "xcode";

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
      added: 6,
      changed: 2,
      deleted: 2,
    },
    patchPreview: [
      `diff --git a/src/tasks/${node.id}.ts b/src/tasks/${node.id}.ts`,
      "index 1111111..2222222 100644",
      `--- a/src/tasks/${node.id}.ts`,
      `+++ b/src/tasks/${node.id}.ts`,
      "@@ -1,5 +1,7 @@",
      " export async function runTask() {",
      '-  return "pending";',
      "+  const evidence = await collectRunEvidence();",
      "+  return evidence.status;",
      " }",
      `diff --git a/.devflow/tasks/${node.id}/result.md b/.devflow/tasks/${node.id}/result.md`,
      "index 3333333..4444444 100644",
      `--- a/.devflow/tasks/${node.id}/result.md`,
      `+++ b/.devflow/tasks/${node.id}/result.md`,
      "@@ -1,4 +1,8 @@",
      " # Task result",
      "- Status: pending",
      "+ Status: verified",
      "+ Mock task-local output persisted.",
      "+ Verification evidence remains required before completion.",
      "+ Review summary is ready.",
    ].join("\n"),
    source: "mock",
  };
}
