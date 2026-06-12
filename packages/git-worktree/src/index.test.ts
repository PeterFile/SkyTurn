import { describe, expect, it } from "vitest";

import type { CanvasNode } from "@skyturn/project-core";
import { createMockChangeset, mockWorktreeService } from "./index";

describe("git worktree services", () => {
  it("keeps mock changesets tied to node completion evidence", () => {
    const node = {
      id: "node-1",
      changesetId: "changeset-1",
      worktree: {
        path: "../project.worktrees/node-1",
        branchName: "skyturn/session/node-1",
        baseCommit: "base",
      },
    } as CanvasNode;

    const changeset = createMockChangeset(node);

    expect(changeset.id).toBe("changeset-1");
    expect(changeset.files).toContain(".devflow/tasks/node-1/result.md");
    expect(changeset.patchPreview).toContain("Verification evidence");
  });

  it("returns the node-bound worktree in mock mode", async () => {
    const node = {
      worktree: {
        path: "../project.worktrees/node-1",
        branchName: "skyturn/session/node-1",
        baseCommit: "base",
      },
    } as CanvasNode;

    await expect(mockWorktreeService.createWorktree(node)).resolves.toEqual(node.worktree);
  });
});
