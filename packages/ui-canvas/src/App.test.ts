import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";
import {
  changeReviewSummary,
  deriveSessionTarget,
  hasAvailableChangeEvidence,
  hasFinalGitEvidence,
} from "./App.js";
import type { CanvasNode, Changeset, FinalChangesetReconciliation } from "@skyturn/project-core";

function mockNode(agent: "hermes" | "codex" = "codex"): CanvasNode {
  return {
    id: "test-node",
    title: "Test",
    agent,
    status: "pending",
    progress: "",
    runId: "run-1",
    changesetId: "cs-1",
    position: { x: 0, y: 0 },
    output: ["Some prose output that should not be diffed"],
    context: {
      brief: "",
      sessionGoal: "",
      relatedRequirements: "",
      relatedDesign: "",
      relatedTasks: "",
      dependencies: [],
      constraints: [],
    },
    worktree: {
      path: "",
      branchName: "branch",
      baselineRef: "base",
    },
  };
}

describe("deriveSessionTarget", () => {
  it("uses current_branch executionTarget and selectedBranch", () => {
    const target = deriveSessionTarget("current_branch", "main");
    expect(target).toEqual({
      executionTarget: "current_branch",
      selectedBranch: "main",
    });
  });

  it("uses new_worktree executionTarget with baseRef semantics", () => {
    const target = deriveSessionTarget("new_worktree", "feature");
    expect(target).toEqual({
      executionTarget: "new_worktree",
      selectedBranch: "feature",
      baseRef: "feature",
    });
  });
});

describe("changes logic", () => {
  const node = mockNode("codex");

  describe("changeReviewSummary", () => {
    it("returns unknown for unknown status", () => {
      const summary = changeReviewSummary(node, {
        id: "cs-1",
        files: [],
        diffStat: { added: 0, changed: 0, deleted: 0 },
        patchPreview: "",
        source: "git",
        evidence: {
          evidenceId: "ev-1",
          changesetId: "cs-1",
          source: "git",
          status: "unknown",
          files: [],
          diffStat: { added: 0, changed: 0, deleted: 0 },
          patchPreviewTruncated: false,
        },
      });
      expect(summary).toBe("Codex has unknown change evidence for cs-1.");
    });

    it("returns empty for empty status", () => {
      const summary = changeReviewSummary(node, {
        id: "cs-1",
        files: [],
        diffStat: { added: 0, changed: 0, deleted: 0 },
        patchPreview: "",
        source: "git",
        evidence: {
          evidenceId: "ev-1",
          changesetId: "cs-1",
          source: "git",
          status: "empty",
          files: [],
          diffStat: { added: 0, changed: 0, deleted: 0 },
          patchPreviewTruncated: false,
        },
      });
      expect(summary).toBe("Codex has no available change evidence for cs-1.");
    });
  });

  describe("hasFinalGitEvidence", () => {
    it("returns true when reconciliation has available status", () => {
      const reconciliation: FinalChangesetReconciliation = {
        status: "available",
        changeset: {
          id: "cs-1",
          files: ["test.ts"],
          diffStat: { added: 1, changed: 1, deleted: 0 },
          patchPreview: "diff",
          source: "git",
        },
        metadata: {
          source: "git",
          executionTarget: "current_branch",
          selectedBranch: "main",
          baselineRef: "main",
        },
      };
      expect(hasFinalGitEvidence(reconciliation, null)).toBe(true);
    });

    it("returns true when reconciliation has mismatch status", () => {
      const reconciliation: FinalChangesetReconciliation = {
        status: "mismatch",
        changeset: {
          id: "cs-1",
          files: ["test.ts"],
          diffStat: { added: 1, changed: 1, deleted: 0 },
          patchPreview: "diff",
          source: "git",
        },
        metadata: {
          source: "git",
          executionTarget: "current_branch",
          selectedBranch: "main",
          baselineRef: "main",
        },
        mismatches: [
          { kind: "file-set", liveFiles: ["other.ts"], gitFiles: ["test.ts"] },
        ],
      };
      expect(hasFinalGitEvidence(reconciliation, null)).toBe(true);
    });

    it("returns false when reconciliation has empty or failed status", () => {
      const reconciliation: FinalChangesetReconciliation = {
        status: "empty",
        changeset: {
          id: "cs-1",
          files: [],
          diffStat: { added: 0, changed: 0, deleted: 0 },
          patchPreview: "",
          source: "git",
        },
        metadata: {
          source: "git",
          executionTarget: "current_branch",
          selectedBranch: "main",
          baselineRef: "main",
        },
      };
      expect(hasFinalGitEvidence(reconciliation, null)).toBe(false);
    });

    it("falls back to changeset evidence if reconciliation is null", () => {
      expect(
        hasFinalGitEvidence(null, {
          id: "cs-1",
          files: ["test.ts"],
          diffStat: { added: 1, changed: 1, deleted: 0 },
          patchPreview: "diff",
          source: "git",
          evidence: {
            evidenceId: "ev-1",
            changesetId: "cs-1",
            source: "git",
            status: "available",
            files: ["test.ts"],
            diffStat: { added: 1, changed: 1, deleted: 0 },
            patchPreviewTruncated: false,
          },
        })
      ).toBe(true);
    });
  });
});

async function readSource(path: string): Promise<string> {
  return readFile(new URL(path, import.meta.url), "utf8");
}

describe("UI source validation", () => {
  it("does not use inline styles in Session controls and ChangesTab", async () => {
    const appSource = await readSource("./App.tsx");
    // Ensure we do not use inline styles in the target-selector
    const sessionComposer = appSource.slice(appSource.indexOf("function SessionComposer"), appSource.indexOf("function formatRelativeTime"));
    expect(sessionComposer).not.toContain("style={{");

    // Ensure we do not use inline styles in ChangesTab
    const changesTab = appSource.slice(appSource.indexOf("function ChangesTab"));
    expect(changesTab).not.toContain("style={{");
  });

  it("includes visible copy for new session target selection", async () => {
    const appSource = await readSource("./App.tsx");
    expect(appSource).toContain("Develop directly on the selected branch.");
    expect(appSource).toContain("Create a candidate worktree from the selected branch.");
  });

  it("does not parse agent prose for changed-file truth in ChangesTab", async () => {
    const appSource = await readSource("./App.tsx");
    const changesTab = appSource.slice(appSource.indexOf("function ChangesTab"), appSource.indexOf("export function changeReviewSummary"));
    expect(changesTab).not.toContain("node.output");
    expect(changesTab).not.toContain("node.progress");
    expect(changesTab).toContain("reconcileFinalChangeset");
  });

  it("falls back to legacy changesets only when final reconciliation is unavailable", async () => {
    const appSource = await readSource("./App.tsx");
    const changesTab = appSource.slice(appSource.indexOf("function ChangesTab"), appSource.indexOf("export function changeReviewSummary"));
    expect(changesTab).toContain('typeof devflow.reconcileFinalChangeset === "function"');
    expect(changesTab).toContain('typeof devflow.getChangeset === "function"');
    expect(changesTab.indexOf("devflow.reconcileFinalChangeset")).toBeLessThan(changesTab.indexOf("devflow.getChangeset"));
  });

  it("implements answerUserDecision with write-through to desktop and browser fallback", async () => {
    const appSource = await readSource("./App.tsx");
    const fnBody = appSource.slice(appSource.indexOf("function answerUserDecision"), appSource.indexOf("function reassignNode"));

    expect(fnBody).toContain("window.devflow.workflow.answerUserDecision(");
    expect(fnBody).toContain("sessionId: activeSession.id");
    expect(fnBody).toContain("decisionId: nodeId");
    expect(fnBody).toContain("selectedOption");
    expect(fnBody).toContain("action");

    expect(fnBody).toContain("const { canvasSession } = result");
    expect(fnBody).toContain("if (canvasSession)");
    expect(fnBody).toContain("setWorkspace((current) =>");

    const devflowCheck = fnBody.indexOf("if (window.devflow");
    const fallbackUpdate = fnBody.indexOf("updateCanvasSession(activeSession.id");
    expect(fallbackUpdate).toBeGreaterThan(devflowCheck);
    expect(fnBody.slice(devflowCheck, fallbackUpdate)).toContain("return;");
  });

  it("ChangesTab calls createDeliveryCommit without renderer shell imports", async () => {
    const appSource = await readSource("./App.tsx");
    const handleCommit = appSource.slice(appSource.indexOf("async function handleCommit()"), appSource.indexOf("if (!changeset) return <p>Loading changes...</p>;"));
    expect(handleCommit).toContain("window.devflow");
    expect(handleCommit).toContain("devflow.workflow.createDeliveryCommit");
    expect(appSource).not.toContain("import fs from ");
    expect(appSource).not.toContain("import child_process");
  });

  it("ChangesTab commit action is gated on laneKind and evidence", async () => {
    const appSource = await readSource("./App.tsx");
    const changesTab = appSource.slice(appSource.indexOf("function ChangesTab("), appSource.indexOf("export function changeReviewSummary("));
    expect(changesTab).toContain("node.laneKind === \"commit\"");
    expect(changesTab).toContain("hasFinalGitEvidence");
  });

  it("ChangesTab requires window.confirm when reconciliation status is mismatch", async () => {
    const appSource = await readSource("./App.tsx");
    const handleCommit = appSource.slice(appSource.indexOf("async function handleCommit()"), appSource.indexOf("if (!changeset) return <p>Loading changes...</p>;"));
    expect(handleCommit).toContain('reconciliation?.status === "mismatch"');
    expect(handleCommit).toContain("window.confirm");
  });

  it("ChangesTab sends explicit mismatch acceptance only after mismatch confirmation", async () => {
    const appSource = await readSource("./App.tsx");
    const handleCommit = appSource.slice(appSource.indexOf("async function handleCommit()"), appSource.indexOf("if (!changeset) return <p>Loading changes...</p>;"));
    const confirmIndex = handleCommit.indexOf("window.confirm");
    const commitIndex = handleCommit.indexOf("devflow.workflow.createDeliveryCommit");
    const acceptIndex = handleCommit.indexOf("acceptMismatch: true");

    expect(confirmIndex).toBeGreaterThanOrEqual(0);
    expect(acceptIndex).toBeGreaterThan(confirmIndex);
    expect(acceptIndex).toBeGreaterThan(commitIndex);
  });

  it("ChangesTab requires window.prompt for subject and checks devflow availability", async () => {
    const appSource = await readSource("./App.tsx");
    const handleCommit = appSource.slice(appSource.indexOf("async function handleCommit()"), appSource.indexOf("if (!changeset) return <p>Loading changes...</p>;"));
    expect(handleCommit).toContain("window.prompt");
    expect(handleCommit).toContain("if (!devflow?.workflow?.createDeliveryCommit)");
  });

  it("WorktreeActions adopt is disabled and shows error when metadata is missing", async () => {
    const appSource = await readSource("./App.tsx");
    const worktreeActions = appSource.slice(appSource.indexOf("function WorktreeActions"));
    expect(worktreeActions).toContain("const missingMetadata =");
    expect(worktreeActions).toContain("!node.worktree.worktreeId");
    expect(worktreeActions).toContain("const canAdopt = devflowAvailable && !missingMetadata;");
    expect(worktreeActions).toContain("disabled={!canAdopt || adopting}");
    expect(worktreeActions).toContain("Missing required metadata for adoption.");
  });

  it("WorktreeActions adopt does not fallback to HEAD and main", async () => {
    const appSource = await readSource("./App.tsx");
    const worktreeActions = appSource.slice(appSource.indexOf("function WorktreeActions"));
    expect(worktreeActions).not.toContain("|| \"HEAD\"");
    expect(worktreeActions).not.toContain("|| \"main\"");
  });

  it("WorktreeActions uses stable adoptionId, not Date.now()", async () => {
    const appSource = await readSource("./App.tsx");
    const worktreeActions = appSource.slice(appSource.indexOf("function WorktreeActions"));
    expect(worktreeActions).not.toContain("Date.now()");
    expect(worktreeActions).toContain("adoptionId: `adopt-${node.worktree.worktreeId}-${node.worktree.headCommit}`");
  });

  it("WorktreeActions requires real managed worktree to show lifecycle", async () => {
    const appSource = await readSource("./App.tsx");
    const worktreeActions = appSource.slice(appSource.indexOf("function WorktreeActions"));
    expect(worktreeActions).toContain("const isNewWorktree = node.worktree.executionTarget === \"new_worktree\" && !!node.worktree.worktreeId;");
  });

  it("WorktreeActions cleanWorktree constructs complete identity payload with parentLaneId", async () => {
    const appSource = await readSource("./App.tsx");
    const handleClean = appSource.slice(appSource.indexOf("const handleClean = async () => {"), appSource.indexOf("setCleanStatus(\"Worktree cleaned successfully.\");"));

    expect(handleClean).toContain("parentLaneId: node.id");
    expect(handleClean).toContain("worktreeId: node.worktree.worktreeId");
    expect(handleClean).toContain("variantId: node.worktree.variantId");
    expect(handleClean).toContain("realPath: node.worktree.realPath");
    expect(handleClean).toContain("gitdir: node.worktree.gitdir");
    expect(handleClean).toContain("repoRoot: node.worktree.repoRoot");
    expect(handleClean).toContain("branchName: node.worktree.branchName");
    expect(handleClean).toContain("baseCommit: node.worktree.baseCommit");
    expect(handleClean).toContain("headCommit: node.worktree.headCommit");
  });

  it("WorktreeActions disables clean unless all identity fields exist", async () => {
    const appSource = await readSource("./App.tsx");
    const worktreeActions = appSource.slice(appSource.indexOf("function WorktreeActions"));
    expect(worktreeActions).toContain("const missingCleanMetadata =");
    expect(worktreeActions).toContain("!node.worktree.realPath");
    expect(worktreeActions).toContain("!node.worktree.gitdir");
    expect(worktreeActions).toContain("!node.worktree.repoRoot");
    expect(worktreeActions).toContain("const canClean = devflowAvailable && !missingCleanMetadata;");
    expect(worktreeActions).toContain("disabled={!canClean || cleaning}");
  });

  it("WorktreeActions Clean defaults to deleteBranch false if second confirmation is cancelled", async () => {
    const appSource = await readSource("./App.tsx");
    const handleClean = appSource.slice(appSource.indexOf("const handleClean = async () => {"), appSource.indexOf("setCleaning(true);"));

    expect(handleClean).toContain("const deleteBranch = window.confirm");
    expect(handleClean).not.toMatch(/if\s*\(!deleteBranch\)\s*return/);
  });
});
