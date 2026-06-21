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

  it("ChangesTab handleCreatePr verifies PR lane dependency and conventional commit title", async () => {
    const appSource = await readSource("./App.tsx");
    const changesTab = appSource.slice(appSource.indexOf("function ChangesTab("), appSource.indexOf("export function changeReviewSummary("));
    expect(changesTab).toContain("session.edges");
    expect(changesTab).toContain('=== "pull_request"');
    expect(changesTab).toContain("Cannot create PR: No dependent pull_request lane found.");
    expect(changesTab).toContain("Conventional Commits format");
    expect(changesTab).toContain("^(feat|fix|docs|style|refactor|perf|test|build|ci|chore|revert)");
  });

  it("ChangesTab handleCreatePr derives baseBranch properly and prevents fallback to main", async () => {
    const appSource = await readSource("./App.tsx");
    const changesTab = appSource.slice(appSource.indexOf("function ChangesTab("), appSource.indexOf("export function changeReviewSummary("));

    const prBaseBranchDef = changesTab.slice(changesTab.indexOf("const prBaseBranch ="), changesTab.indexOf(";", changesTab.indexOf("const prBaseBranch =")));
    expect(prBaseBranchDef).toMatch(/const prBaseBranch = node\.worktree\.baseRef \|\| session\.target\.baseRef/);
    expect(prBaseBranchDef).not.toContain("node.worktree.baselineRef");
    expect(prBaseBranchDef).not.toContain("selectedBranch");
    expect(prBaseBranchDef).not.toContain('"main"');

    const handleCreatePr = changesTab.slice(changesTab.indexOf("async function handleCreatePr()"), changesTab.indexOf("if (!changeset) return <p>Loading changes...</p>;"));
    expect(handleCreatePr).not.toContain("node.worktree.baselineRef");
    expect(handleCreatePr).not.toContain("selectedBranch");
    expect(handleCreatePr).not.toContain('"main"');
    expect(handleCreatePr).toContain("Cannot create PR: Base branch could not be derived.");
  });

  it("ChangesTab handleCreatePr verifies base branch is not the same as the delivery branch", async () => {
    const appSource = await readSource("./App.tsx");
    const changesTab = appSource.slice(appSource.indexOf("function ChangesTab("), appSource.indexOf("export function changeReviewSummary("));
    expect(changesTab).toContain("!commitEvidence?.branch");
    expect(changesTab).toContain("prBaseBranch === commitEvidence.branch");
    expect(changesTab).toContain("Base branch cannot be the same as the delivery branch");
  });

  it("ChangesTab handleCreatePr trims and revalidates confirmed prompt base branch", async () => {
    const appSource = await readSource("./App.tsx");
    const changesTab = appSource.slice(appSource.indexOf("function ChangesTab("), appSource.indexOf("export function changeReviewSummary("));
    expect(changesTab).toContain("const trimmedBaseBranch = confirmedBaseBranch.trim();");
    expect(changesTab).toContain("if (!trimmedBaseBranch || trimmedBaseBranch === commitEvidence.branch) {");
    expect(changesTab).toContain("baseBranch: trimmedBaseBranch,");
  });

  it("ChangesTab early-return does not hide toolbar when commitEvidence exists", async () => {
    const appSource = await readSource("./App.tsx");
    const changesTab = appSource.slice(appSource.indexOf("function ChangesTab("), appSource.indexOf("export function changeReviewSummary("));
    expect(changesTab).toContain("if (!hasGitEvidence && !reconciliation?.liveChanges && !commitEvidence) {");
  });

  it("ChangesTab hydrates commitEvidence from persisted workflow events without requiring evidence payload", async () => {
    const appSource = await readSource("./App.tsx");
    const changesTab = appSource.slice(appSource.indexOf("function ChangesTab("), appSource.indexOf("export function changeReviewSummary("));
    expect(changesTab).toContain("window.devflow.workflow.getEvents(");
    expect(changesTab).toContain('e.kind === "workflow.commit.created"');
    expect(changesTab).toContain('e.laneId === node.id ||');
    expect(changesTab).toContain('(e.payload as Record<string, unknown>).laneId === node.id');
    expect(changesTab).not.toContain('typeof evidence.commitSha === "string"');
  });

  it("ChangesTab Push call does not require renderer-visible commitSha/branch/worktreePath", async () => {
    const appSource = await readSource("./App.tsx");
    const changesTab = appSource.slice(appSource.indexOf("function ChangesTab("), appSource.indexOf("export function changeReviewSummary("));
    const handlePush = changesTab.slice(changesTab.indexOf("async function handlePush()"), changesTab.indexOf("async function handleCreatePr()"));
    expect(handlePush).toContain("sessionId: session.id,");
    expect(handlePush).toContain("laneId: node.id,");
    expect(handlePush).not.toContain("if (!commitEvidence.commitSha)");
    expect(handlePush).not.toContain("if (!commitEvidence.branch)");
  });

  it("ChangesTab resets delivery state on node/session/project identity change", async () => {
    const appSource = await readSource("./App.tsx");
    const changesTab = appSource.slice(appSource.indexOf("function ChangesTab("), appSource.indexOf("export function changeReviewSummary("));
    expect(changesTab).toContain('setCommitEvidence(null);');
    expect(changesTab).toContain('setPushStatus("idle");');
    expect(changesTab).toContain('setPrStatus("idle");');
    expect(changesTab).toContain('setPrUrl(null);');
    expect(changesTab).toContain('setDeliveryStatus("idle");');
    expect(changesTab).toMatch(/useEffect\(\(\) => \{[\s\S]*setCommitEvidence\(null\);[\s\S]*\}, \[node\.id, session\.id, projectRoot\]\);/);
  });

  it("ChangesTab clears commitEvidence if getEvents is unavailable or unmatched", async () => {
    const appSource = await readSource("./App.tsx");
    const changesTab = appSource.slice(appSource.indexOf("function ChangesTab("), appSource.indexOf("export function changeReviewSummary("));
    expect(changesTab).toMatch(/if \(!window\.devflow\?\.workflow\?\.getEvents\) \{\s*setCommitEvidence\(null\);\s*return;\s*\}/);
    expect(changesTab).toMatch(/else \{\s*setCommitEvidence\(null\);\s*\}/);
  });
});
