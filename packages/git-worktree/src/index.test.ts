import { describe, expect, it } from "vitest";

import type {
  CanvasNode,
  ChangesetEvidence,
  WorkflowVariantAdoption,
  WorkflowWorktreeIdentity,
} from "@skyturn/project-core";
import { GIT_WORKTREE_CONTRACT_VERSION, createMockChangeset, mockWorktreeService } from "./index";
import type {
  ChangesetEvidenceService,
  ManagedWorktreeService,
  VariantAdoptionService,
} from "./index";

describe("git worktree services", () => {
  it("versions the root contract ABI", () => {
    expect(GIT_WORKTREE_CONTRACT_VERSION).toBe(1);
  });

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

  it("publishes managed worktree, variant adoption, and changeset evidence service contracts", async () => {
    const identity: WorkflowWorktreeIdentity = {
      worktreeId: "worktree-a",
      variantId: "variant-a",
      path: "/repo.worktrees/session-1-variant-a",
      realPath: "/repo.worktrees/session-1-variant-a",
      gitdir: "/repo/.git/worktrees/session-1-variant-a",
      repoRoot: "/repo",
      branchName: "skyturn/session-1/variant-a",
      baseCommit: "abc123",
      headCommit: "def456",
      parentLaneId: "lane-implementation",
    };
    const evidence: ChangesetEvidence = {
      evidenceId: "changeset-evidence-a",
      changesetId: "changeset-a",
      source: "git",
      status: "available",
      files: ["src/index.ts"],
      diffStat: { added: 1, changed: 0, deleted: 0 },
      patchPreviewTruncated: true,
      worktreeId: identity.worktreeId,
    };
    const adoption: WorkflowVariantAdoption = {
      adoptionId: "adopt-a",
      variantId: identity.variantId,
      worktreeId: identity.worktreeId,
      strategy: "merge",
      status: "requested",
      baseCommit: identity.baseCommit,
      headCommit: identity.headCommit,
      targetBranchName: "main",
    };
    const worktrees: ManagedWorktreeService = {
      async createManagedWorktree() {
        return identity;
      },
      async compareVariants() {
        return {
          comparisonId: "comparison-a",
          variants: [{ variantId: identity.variantId, worktreeId: identity.worktreeId, changeset: evidence }],
          collectedAt: "2026-06-16T00:00:00.000Z",
        };
      },
      async cleanManagedWorktree(input) {
        return { ok: true, worktreeId: input.worktree.worktreeId, cleanedAt: "2026-06-16T00:00:00.000Z" };
      },
    };
    const adopter: VariantAdoptionService = {
      async adoptVariant(input) {
        return { ...input, status: "adopted", adoptedCommit: "789abc" };
      },
    };
    const changesets: ChangesetEvidenceService = {
      async collectChangesetEvidence() {
        return evidence;
      },
    };

    await expect(worktrees.createManagedWorktree({
      sessionId: "session-1",
      variantId: identity.variantId,
      repoRoot: identity.repoRoot,
      baseCommit: identity.baseCommit,
      branchName: identity.branchName,
      parentLaneId: identity.parentLaneId,
    })).resolves.toEqual(identity);
    await expect(adopter.adoptVariant(adoption)).resolves.toMatchObject({ status: "adopted" });
    await expect(changesets.collectChangesetEvidence({ node: { id: "node-1" } as CanvasNode, worktree: identity })).resolves.toEqual(evidence);
  });
});
