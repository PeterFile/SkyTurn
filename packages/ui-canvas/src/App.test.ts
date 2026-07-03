import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";
import { formatTerminalTitle, formatTerminalBadge, formatTerminalMessage } from "./terminalInspector.js";
import type { TerminalSnapshotResult } from "@skyturn/persistence";
import {
  REMOTE_SIDE_EFFECT_ROLLBACK_BLOCK_MESSAGE,
  selectedNodeActionAvailability,
  rollbackLabelForNode,
  buildWorktreeAdoptionConfirmation,
  buildWorktreeCleanConfirmation,
  buildWorktreeDeleteBranchConfirmation,
  changeReviewSummary,
  changeEvidenceFactsForDisplay,
  deriveSessionTarget,
  hasAvailableChangeEvidence,
  hasFinalGitEvidence,
  runEvidenceFactsForDisplay,
  summarizeWorktreeComparisonEvidence,
} from "./App.js";
import type { CanvasNode, Changeset, FinalChangesetReconciliation, RunEvidence } from "@skyturn/project-core";
import type { DeliveryCommitSummary } from "./deliveryPanel.js";
import type { SelectedNodeActionState } from "./nodeActionState.js";

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
      baseCommit: "base",
    },
  };
}

function mockRunEvidence(overrides: Partial<RunEvidence> = {}): RunEvidence {
  return {
    runId: "run-1",
    status: "succeeded",
    exitCode: 0,
    changesetId: "cs-1",
    checks: [{ kind: "test", name: "unit", status: "passed" }],
    artifacts: ["patch", "screenshot"],
    review: null,
    errorReason: null,
    cancelReason: null,
    completedAt: "2026-06-27T00:00:00.000Z",
    ...overrides,
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

  it("ContextTab renders run evidence facts and handles missing evidence", async () => {
    const appSource = await readSource("./App.tsx");
    const contextTab = appSource.slice(appSource.indexOf("function ContextTab("), appSource.indexOf("function WorktreeActions"));
    expect(contextTab).toContain("RunEvidenceFacts runEvidence={runEvidence}");
    expect(contextTab).toContain("No run evidence yet");
  });

  it("formats succeeded run evidence without output logs", () => {
    expect(runEvidenceFactsForDisplay(mockRunEvidence())).toEqual([
      { label: "Run ID", value: "run-1" },
      { label: "Run status", value: "succeeded" },
      { label: "Exit code", value: "0" },
      { label: "Checks", value: "test [unit]: passed" },
      { label: "Artifacts", value: "2 (patch, screenshot)" },
    ]);
  });

  it("formats completed validation evidence with screenshot artifact paths", () => {
    expect(
      runEvidenceFactsForDisplay(mockRunEvidence({
        checks: [
          {
            kind: "test",
            name: "corepack pnpm --filter @skyturn/ui-canvas run test",
            status: "passed",
            detail: "118 tests passed",
          },
          {
            kind: "build",
            name: "ui-canvas build",
            status: "passed",
            detail: "tsc -p tsconfig.json",
          },
        ],
        artifacts: ["artifacts/node-modal/context-screenshot.png"],
      })),
    ).toEqual([
      { label: "Run ID", value: "run-1" },
      { label: "Run status", value: "succeeded" },
      { label: "Exit code", value: "0" },
      {
        label: "Checks",
        value: "test [corepack pnpm --filter @skyturn/ui-canvas run test]: passed - 118 tests passed, build [ui-canvas build]: passed - tsc -p tsconfig.json",
      },
      { label: "Artifacts", value: "1 (artifacts/node-modal/context-screenshot.png)" },
    ]);
  });

  it("formats commit node change evidence without output logs", () => {
    const changeset: Changeset = {
      id: "cs-commit",
      files: ["packages/ui-canvas/src/App.tsx", "packages/ui-canvas/src/App.test.ts"],
      diffStat: { added: 12, changed: 2, deleted: 3 },
      patchPreview: "diff --git",
      source: "git",
      evidence: {
        evidenceId: "ev-commit",
        changesetId: "cs-commit",
        source: "git",
        status: "available",
        files: ["packages/ui-canvas/src/App.tsx", "packages/ui-canvas/src/App.test.ts"],
        diffStat: { added: 12, changed: 2, deleted: 3 },
        patchPreviewTruncated: false,
      },
    };
    const commitEvidence: DeliveryCommitSummary = {
      commitSha: "abc123456789",
      branch: "feat/node-modal-evidence-density",
      subject: "feat(ui-canvas): clarify node completion evidence",
    };

    expect(changeEvidenceFactsForDisplay(null, changeset, commitEvidence)).toEqual([
      { label: "Changeset status", value: "available" },
      {
        label: "Changed files",
        value: "2 (packages/ui-canvas/src/App.tsx, packages/ui-canvas/src/App.test.ts)",
      },
      { label: "Diff stat", value: "+12 / -3 across 2 files" },
      { label: "Repo state", value: "Git changes recorded" },
      { label: "Commit", value: "abc1234 on feat/node-modal-evidence-density" },
    ]);
  });

  it("formats clean repo changeset evidence as an explicit empty state", () => {
    const changeset: Changeset = {
      id: "cs-clean",
      files: [],
      diffStat: { added: 0, changed: 0, deleted: 0 },
      patchPreview: "",
      source: "git",
      evidence: {
        evidenceId: "ev-clean",
        changesetId: "cs-clean",
        source: "git",
        status: "empty",
        files: [],
        diffStat: { added: 0, changed: 0, deleted: 0 },
        patchPreviewTruncated: false,
      },
    };
    const reconciliation: FinalChangesetReconciliation = {
      status: "empty",
      changeset,
      metadata: {
        source: "git",
        executionTarget: "current_branch",
        selectedBranch: "feat/node-modal-evidence-density",
        baselineRef: "main",
      },
    };

    expect(changeEvidenceFactsForDisplay(reconciliation, changeset, null)).toEqual([
      { label: "Changeset status", value: "empty" },
      { label: "Changed files", value: "None" },
      { label: "Diff stat", value: "+0 / -0 across 0 files" },
      { label: "Repo state", value: "Clean at collection" },
    ]);
  });

  it("ChangesTab renders structured changeset facts in the existing Changes tab", async () => {
    const appSource = await readSource("./App.tsx");
    const changesTab = appSource.slice(appSource.indexOf("function ChangesTab("), appSource.indexOf("export function changeReviewSummary("));
    expect(changesTab).toContain("changeEvidenceFactsForDisplay(reconciliation, changeset, commitEvidence)");
    expect(appSource).toContain('aria-label="Changeset evidence facts"');
    expect(changesTab).not.toContain("node.output");
  });

  it("formats failed, timed-out, and cancelled run evidence reasons", () => {
    expect(runEvidenceFactsForDisplay(mockRunEvidence({ status: "failed", exitCode: 1, errorReason: "tests failed" }))).toContainEqual({
      label: "Reason",
      value: "Error: tests failed",
    });
    expect(runEvidenceFactsForDisplay(mockRunEvidence({
      status: "timed-out",
      exitCode: null,
      errorReason: null,
      checks: [{ kind: "run-timeout", name: "watchdog", status: "failed", detail: "watchdog expired" }],
    }))).toContainEqual({
      label: "Reason",
      value: "Timeout: watchdog expired",
    });
    expect(runEvidenceFactsForDisplay(mockRunEvidence({ status: "cancelled", exitCode: null, cancelReason: "user stopped run" }))).toContainEqual({
      label: "Reason",
      value: "Cancelled: user stopped run",
    });
  });

  it("includes visible copy for new session target selection and uses custom listbox controls", async () => {
    const appSource = await readSource("./App.tsx");
    expect(appSource).toContain("Develop directly on the selected branch.");
    expect(appSource).toContain("Create a candidate worktree from the selected branch.");

    const sessionComposer = appSource.slice(appSource.indexOf("function SessionComposer("), appSource.indexOf("function formatRelativeTime("));
    expect(sessionComposer).not.toContain("<select");
    expect(sessionComposer).toContain("<CustomSelect");
    expect(sessionComposer).toContain("options={[");
  });

  it("PlanView is a single-page editor instead of three simultaneous markdown articles", async () => {
    const appSource = await readSource("./App.tsx");
    const planView = appSource.slice(appSource.indexOf("function PlanView("), appSource.indexOf("function CanvasView("));

    expect(planView).toContain("Review one plan page at a time");
    expect(planView).toContain("Ask agent to revise this page");
    expect(planView).toContain("disabled={!allApproved}");
    expect(planView).toContain('setActiveSection("design")');
    expect(planView).toContain('setActiveSection("tasks")');
    expect(planView).not.toContain('changeActiveSection("design")');
    expect(planView).not.toContain('changeActiveSection("tasks")');
    expect(planView).toContain("<textarea");
    expect(planView).not.toContain("markdown-grid");
    expect(planView).not.toContain("<article");
    expect((planView.match(/<ReactMarkdown/g) ?? [])).toHaveLength(1);
  });

  it("loads agent health through desktop IPC and stores discovered agents", async () => {
    const appSource = await readSource("./App.tsx");
    const healthEffect = appSource.slice(
      appSource.indexOf("window.devflow.getAgentHealth"),
      appSource.indexOf("window.devflow.onRunEvent"),
    );

    expect(healthEffect).toContain("window.devflow.getAgentHealth()");
    expect(healthEffect).toContain("agents: result.agents");
    expect(healthEffect).toContain("setAgentReadiness");
    expect(healthEffect).not.toContain("window.devflow.discoverAgents()");
  });

  it("renders compact agent readiness near session creation and canvas composer", async () => {
    const appSource = await readSource("./App.tsx");
    const projectStart = appSource.slice(appSource.indexOf("function ProjectStartPage"), appSource.indexOf("export type ComposerAction"));
    const canvasView = appSource.slice(appSource.indexOf("function CanvasView("), appSource.indexOf("function CanvasViewportController"));

    expect(projectStart).toContain("<AgentReadinessBlock");
    expect(projectStart).toContain("readiness={agentReadiness}");
    expect(canvasView).toContain("<AgentReadinessBlock");
    expect(canvasView).toContain("readiness={agentReadiness}");
    expect(appSource).toContain("function AgentReadinessBlock");
    expect(appSource).toContain("Real loop ready");
    expect(appSource).toContain("Mock fallback only");
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

  it("ChangesTab requires explicit mismatch confirmation when reconciliation status is mismatch", async () => {
    const appSource = await readSource("./App.tsx");
    const changesTab = appSource.slice(appSource.indexOf("function ChangesTab("), appSource.indexOf("export function changeReviewSummary("));
    expect(changesTab).toContain('reconciliation?.status === "mismatch"');
    expect(changesTab).toContain("acceptMismatch");
  });

  it("ChangesTab sends explicit mismatch acceptance only after mismatch confirmation", async () => {
    const appSource = await readSource("./App.tsx");
    const handleCommit = appSource.slice(appSource.indexOf("async function handleCommit()"), appSource.indexOf("if (!changeset) return <p>Loading changes...</p>;"));
    const commitIndex = handleCommit.indexOf("devflow.workflow.createDeliveryCommit");
    const acceptIndex = handleCommit.indexOf("acceptMismatch: true");

    expect(handleCommit).not.toContain("window.confirm");
    expect(handleCommit).toContain("mismatchRequiresAcceptance && !acceptMismatch");
    expect(acceptIndex).toBeGreaterThan(commitIndex);
  });

  it("ChangesTab requires explicit form subject and checks devflow availability", async () => {
    const appSource = await readSource("./App.tsx");
    const changesTab = appSource.slice(appSource.indexOf("function ChangesTab("), appSource.indexOf("export function changeReviewSummary("));
    expect(changesTab).toContain("commitSubject");
    expect(changesTab).not.toContain("window.prompt");
    expect(changesTab).toContain("if (!devflow?.workflow?.createDeliveryCommit)");
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

  it("DeliveryLifecyclePanel disables Create PR after a pull request exists", async () => {
    const appSource = await readSource("./App.tsx");
    const panel = appSource.slice(appSource.indexOf("function DeliveryLifecyclePanel("), appSource.indexOf("function shortSha("));
    const createPrDisabled = panel.slice(panel.indexOf("const createPrDisabled ="), panel.indexOf("const mergeRequestDisabled"));
    expect(createPrDisabled).toContain("!!pullRequest");
    expect(panel).toContain('disabled={createPrDisabled}');
  });

  it("ChangesTab clears stale PR checks when PR status refresh starts or fails", async () => {
    const appSource = await readSource("./App.tsx");
    const handleCheckPrStatus = appSource.slice(appSource.indexOf("async function handleCheckPrStatus()"), appSource.indexOf("async function handleMergePullRequest()"));
    const checkingIndex = handleCheckPrStatus.indexOf('setPrCheckStatus("checking");');
    const clearBeforeTryIndex = handleCheckPrStatus.indexOf("setPrChecks(null);");
    const tryIndex = handleCheckPrStatus.indexOf("try {");
    const catchIndex = handleCheckPrStatus.indexOf("catch (e)");
    const clearInCatchIndex = handleCheckPrStatus.indexOf("setPrChecks(null);", catchIndex);

    expect(clearBeforeTryIndex).toBeGreaterThan(checkingIndex);
    expect(clearBeforeTryIndex).toBeLessThan(tryIndex);
    expect(clearInCatchIndex).toBeGreaterThan(catchIndex);
  });

  it("ChangesTab handleCreatePr trims and revalidates prompt base branch", async () => {
    const appSource = await readSource("./App.tsx");
    const changesTab = appSource.slice(appSource.indexOf("function ChangesTab("), appSource.indexOf("export function changeReviewSummary("));
    expect(changesTab).toContain("trimmedBaseBranch");
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
    expect(changesTab).toContain("hydrateDeliveryLifecycleFromWorkflowEvents(eventsList");
    expect(changesTab).toContain("commitLaneId: node.id");
    expect(changesTab).toContain("pullRequestLaneId: dependentPrLaneId");
    expect(changesTab).toContain("setCommitEvidence(restored.commitEvidence)");
    expect(changesTab).not.toContain('typeof evidence.commitSha === "string"');
  });

  it("ChangesTab hydrates delivery lifecycle state from workflow events", async () => {
    const appSource = await readSource("./App.tsx");
    const changesTab = appSource.slice(appSource.indexOf("function ChangesTab("), appSource.indexOf("export function changeReviewSummary("));
    expect(changesTab).toContain("hydrateDeliveryLifecycleFromWorkflowEvents");
    expect(changesTab).toContain("setPushEvidence(restored.pushEvidence)");
    expect(changesTab).toContain("setPrEvidence(restored.pullRequest)");
    expect(changesTab).toContain("setPrChecks(restored.checks)");
    expect(changesTab).toContain('setMergeStatus(restored.mergeComplete ? "merged" : "idle")');
    expect(changesTab).toContain('setSyncStatus(restored.syncComplete ? "synced" : "idle")');
  });

  it("ChangesTab Push call does not require renderer-visible commitSha/branch/worktreePath", async () => {
    const appSource = await readSource("./App.tsx");
    const changesTab = appSource.slice(appSource.indexOf("function ChangesTab("), appSource.indexOf("export function changeReviewSummary("));
    expect(changesTab).toContain("sessionId: session.id,");
    expect(changesTab).toContain("laneId: node.id,");
  });

  it("ChangesTab resets delivery state on node/session/project identity change", async () => {
    const appSource = await readSource("./App.tsx");
    const changesTab = appSource.slice(appSource.indexOf("function ChangesTab("), appSource.indexOf("export function changeReviewSummary("));
    expect(changesTab).toContain('setCommitEvidence(null);');
    expect(changesTab).toContain('setPushEvidence(null);');
    expect(changesTab).toContain('setPushStatus("idle");');
    expect(changesTab).toContain('setPrStatus("idle");');
    expect(changesTab).toContain('setPrEvidence(null);');
    expect(changesTab).toContain('setPrChecks(null);');
    expect(changesTab).toContain('setMergeStatus("idle");');
    expect(changesTab).toContain('setSyncStatus("idle");');
    expect(changesTab).toContain('setCleanupStatus("idle");');
    expect(changesTab).toContain('setDeliveryStatus("idle");');
    expect(changesTab).toMatch(/useEffect\(\(\) => \{[\s\S]*setCommitEvidence\(null\);[\s\S]*\}, \[node\.id, session\.id, projectRoot, prBaseBranch\]\);/);
  });

  it("ChangesTab clears restored delivery state if getEvents is unavailable", async () => {
    const appSource = await readSource("./App.tsx");
    const changesTab = appSource.slice(appSource.indexOf("function ChangesTab("), appSource.indexOf("export function changeReviewSummary("));
    const unavailableBranch = changesTab.slice(
      changesTab.indexOf("if (!window.devflow?.workflow?.getEvents)"),
      changesTab.indexOf("let active = true;"),
    );
    expect(unavailableBranch).toContain("setCommitEvidence(null);");
    expect(unavailableBranch).toContain("setPushEvidence(null);");
    expect(unavailableBranch).toContain('setPushStatus("idle");');
    expect(unavailableBranch).toContain("setPrEvidence(null);");
    expect(unavailableBranch).toContain("setPrChecks(null);");
    expect(unavailableBranch).toContain('setMergeStatus("idle");');
    expect(unavailableBranch).toContain('setSyncStatus("idle");');
    expect(unavailableBranch).toContain("return;");
  });

  it("WorktreeActions adopt is disabled and shows error when metadata is missing", async () => {
    const appSource = await readSource("./App.tsx");
    const worktreeActions = appSource.slice(appSource.indexOf("function WorktreeActions"));
    expect(worktreeActions).toContain("const missingMetadata =");
    expect(worktreeActions).toContain("!node.worktree.worktreeId");
    expect(worktreeActions).toContain("const canAdopt = devflowAvailable && !missingMetadata;");
    expect(worktreeActions).toContain("disabled={!canAdopt || adopting || !adoptConfirmed}");
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

  it("WorktreeActions adopt stays merge strategy without cherry-pick UI", async () => {
    const appSource = await readSource("./App.tsx");
    const worktreeActions = appSource.slice(appSource.indexOf("function WorktreeActions"));
    expect(worktreeActions).toContain('strategy: "merge"');
    expect(worktreeActions.toLowerCase()).not.toContain("cherry");
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
    expect(worktreeActions).toContain("disabled={!canClean || cleaning || !cleanConfirmed || (deleteBranch && !deleteBranchConfirmed)}");
  });

  it("WorktreeActions Clean handles deleteBranch correctly", async () => {
    const appSource = await readSource("./App.tsx");
    const worktreeActions = appSource.slice(appSource.indexOf("function WorktreeActions"));

    expect(worktreeActions).toContain("deleteBranch");
    expect(worktreeActions).toContain("deleteBranchConfirmed");
    expect(worktreeActions).not.toContain("window.confirm");
  });

  it("formats worktree comparison evidence without rendering raw JSON", async () => {
    const summary = summarizeWorktreeComparisonEvidence({
      comparisonId: "comparison-a-b",
      collectedAt: "2026-06-22T07:20:00.000Z",
      variants: [
        {
          variantId: "variant-a",
          worktreeId: "wt-a",
          changeset: {
            status: "available",
            files: ["src/a.ts", "src/b.ts"],
            diffStat: { added: 12, changed: 2, deleted: 3 },
            patchPreviewTruncated: false,
          },
          metrics: [
            { kind: "test", label: "Tests", status: "passed", detail: "vitest --run" },
            { kind: "build", label: "Build", status: "failed", detail: "tsc failed" },
            { kind: "diff-summary", label: "Diff summary", status: "recorded", detail: "+12 / -3 across 2 files" },
            { kind: "conflict-check", label: "Conflict check", status: "passed", detail: "No conflicts detected." },
          ],
        },
      ],
    });

    expect(summary.variants).toEqual([
      expect.objectContaining({
        variantId: "variant-a",
        worktreeId: "wt-a",
        changedFileCount: "2",
        diffSummary: "+12 / -3 across 2 files",
        conflictStatus: "passed",
        checks: [
          { label: "Tests", status: "passed", detail: "vitest --run" },
          { label: "Build", status: "failed", detail: "tsc failed" },
        ],
      }),
    ]);

    const appSource = await readSource("./App.tsx");
    const worktreeActions = appSource.slice(appSource.indexOf("function WorktreeActions"));
    expect(worktreeActions).not.toContain("JSON.stringify(compareResult");
    expect(worktreeActions).toContain("worktree-comparison-grid");
  });

  it("builds explicit merge-only adoption confirmation copy", () => {
    const message = buildWorktreeAdoptionConfirmation({
      targetBranchName: "main",
      worktreeBranchName: "skyturn/session-1",
      baseCommit: "abc123",
      headCommit: "def456",
    });

    expect(message).toContain("Target branch: main");
    expect(message).toContain("Worktree branch: skyturn/session-1");
    expect(message).toContain("Base commit: abc123");
    expect(message).toContain("Head commit: def456");
    expect(message).toContain("Strategy: merge");
    expect(message).not.toContain("cherry-pick");
  });

  it("builds clean confirmation copy with delete branch defaulting to false", () => {
    const cleanMessage = buildWorktreeCleanConfirmation({
      path: "/repo.worktrees/wt-a",
      branchName: "skyturn/session-1",
    });
    const deleteBranchMessage = buildWorktreeDeleteBranchConfirmation("skyturn/session-1");

    expect(cleanMessage).toContain("Path to remove: /repo.worktrees/wt-a");
    expect(cleanMessage).toContain("Branch name: skyturn/session-1");
    expect(cleanMessage).toContain("Delete branch requested: false");
    expect(deleteBranchMessage).toContain("Second confirmation");
    expect(deleteBranchMessage).toContain("Delete branch: skyturn/session-1");
  });

});

describe("Slice C UI behavior", () => {
  it("clicking a node selects it and does not open modal/details", async () => {
    const appSource = await readSource("./App.tsx");
    const nodeCard = appSource.slice(appSource.indexOf('className="agent-card-select"'), appSource.indexOf('className="evidence-marker"'));
    expect(nodeCard).toContain('event.stopPropagation()');
    expect(nodeCard).toContain('data.onSelect(node.id)');
    expect(nodeCard).not.toContain('data.onInspect');
    expect(nodeCard).toContain('role="button"');
    expect(nodeCard).toContain('aria-pressed={composerSelected}');
  });

  it("clicking the node card More button opens modal/details", async () => {
    const appSource = await readSource("./App.tsx");
    const menuButton = appSource.slice(appSource.indexOf('className="agent-node-menu nodrag"'), appSource.indexOf('<MoreHorizontal'));
    expect(menuButton).toContain('onClick={(event) => {');
    expect(menuButton).toContain('event.stopPropagation()');
    expect(menuButton).toContain('data.onInspect(node.id)');
  });

  it("opening More synchronizes the selected composer node", async () => {
    const appSource = await readSource("./App.tsx");
    const canvasView = appSource.slice(appSource.indexOf("<CanvasView"), appSource.indexOf("</main>"));
    expect(canvasView).toContain("setSelectedNodeId(nodeId)");
    expect(canvasView).toContain("setInspectedNodeId(nodeId)");
    expect(canvasView).toContain("setInspectedNodeId((current) => (current === nodeId ? current : null))");
  });

  it("node visual target state follows the selected composer node without driving React Flow selection", async () => {
    const appSource = await readSource("./App.tsx");
    const nodesSource = appSource.slice(appSource.indexOf("const nodesSource"), appSource.indexOf("const edges ="));
    const mergeNodes = appSource.slice(appSource.indexOf("function mergeFlowNodeState"), appSource.indexOf("const AGENT_HANDLE_SIZE"));
    const reactFlow = appSource.slice(appSource.indexOf("<ReactFlow"), appSource.indexOf("<CanvasViewportController"));
    expect(nodesSource).toContain("composerSelected: node.id === selectedNodeId");
    expect(nodesSource).toContain("selectedNodeId");
    expect(mergeNodes).toContain("return changed ? merged : current");
    expect(mergeNodes).toContain("selected: existing.selected");
    expect(reactFlow).toContain("onPaneClick={() => onSelectNode(null)}");
    expect(reactFlow).not.toContain("onSelectionChange");
    expect(reactFlow).not.toContain('role="listbox"');
  });

  it("node-scoped composer actions submit through workflow node-action APIs", async () => {
    const appSource = await readSource("./App.tsx");
    const submitHandler = appSource.slice(appSource.indexOf("async function appendRequirementNode"), appSource.indexOf("function retryNode"));
    const composer = appSource.slice(appSource.indexOf("function CanvasComposer("));
    expect(submitHandler).toContain("async function appendRequirementNode(action?: ComposerAction)");
    expect(submitHandler).toContain("await submitSelectedNodeAction(action, text)");
    expect(appSource).toContain("workflow.requestRepair(projectRoot");
    expect(appSource).toContain("workflow.requestVariant(projectRoot");
    expect(appSource).toContain("workflow.applyRollback(projectRoot");
    expect(appSource).toContain("instruction: requestText");
    expect(appSource).toContain("activeSession?.updatedAt, selectedNode]");
    expect(appSource).not.toContain("activeSession?.updatedAt, selectedNode?.id");
    expect(appSource).toContain("workflow.getProjection(projectRoot, sessionId)");
    expect(appSource).toContain("const projectionState = buildSelectedNodeActionState");
    expect(appSource).toContain("const rollbackPayload = projectionState.rollbackPayload");
    expect(appSource).not.toContain("hydrateSelectedNodeActionStateFromEvents");
    expect(appSource).toContain("laneId: rollbackPayload.laneId");
    expect(appSource).toContain("checkpointId: rollbackPayload.checkpointId");
    expect(submitHandler).toContain("nodeActionPayloadMatchesSelection(repairPayload, activeSession.id, selectedNode.id)");
    expect(submitHandler).toContain("nodeActionPayloadMatchesSelection(variantPayload, activeSession.id, selectedNode.id)");
    expect(submitHandler).toContain("nodeActionPayloadMatchesSelection(rollbackPayload, activeSession.id, selectedNode.id)");
    expect(appSource).toContain("const selectedNodeActionGenerationRef = useRef(0);");
    expect(appSource).toContain("selectedNodeActionGenerationRef.current += 1;");
    expect(submitHandler).toContain("const actionGeneration = selectedNodeActionGenerationRef.current + 1;");
    expect(submitHandler).toContain("selectedNodeActionGenerationRef.current = actionGeneration;");
    expect(submitHandler).toContain("nodeActionPayloadMatchesSelection(selectedNodeActionScopeRef.current, actionScope.sessionId, actionScope.nodeId) &&");
    expect(submitHandler).toContain("selectedNodeActionGenerationRef.current === actionGeneration");
    expect(submitHandler).toContain("if (!actionStillCurrent()) return;");
    expect(submitHandler).toContain("applyWorkflowActionResult(result, actionStillCurrent)");
    expect(submitHandler).toContain("await refreshWorkflowProjection(actionStillCurrent)");
    expect(submitHandler).toContain("if (actionStillCurrent()) setNodeActionError");
    expect(submitHandler).toContain("if (actionStillCurrent()) setNodeActionBusy(null)");
    expect(submitHandler).toContain("Selected node action is stale. Reselect the node and try again.");
    expect(appSource).toContain("const selectedNodeActionScopeKey = activeSession?.kind === \"canvas\" && selectedNode");
    expect(appSource).toContain("}, [selectedNodeActionScopeKey]);");
    expect(composer).toContain("selectedNodeActionScopeKey: string | null");
    expect(composer).toContain("}, [selectedNodeActionScopeKey]);");
    expect(composer).toContain("const actionAvailability = selectedNodeActionAvailability");
    expect(composer).toContain("disabled={disabled || nodeActionBusy !== null || !actionAvailability.repair.enabled}");
  });

  it("More button remains outside the node selection target", async () => {
    const appSource = await readSource("./App.tsx");
    const selectTarget = appSource.slice(appSource.indexOf('className="agent-card-select"'), appSource.indexOf('<AgentStreamPreview'));
    const menuButton = appSource.slice(appSource.indexOf('className="agent-node-menu nodrag"'), appSource.indexOf('<MoreHorizontal'));
    expect(selectTarget).not.toContain('className="agent-node-menu nodrag"');
    expect(menuButton).toContain('type="button"');
    expect(menuButton).toContain("event.stopPropagation()");
  });

  it("selected node appears in the bottom composer and cards", async () => {
    const appSource = await readSource("./App.tsx");
    const composer = appSource.slice(appSource.indexOf('function CanvasComposer('));
    expect(composer).toContain('selectedNode && (');
    expect(composer).toContain('className="composer-selected-dock"');
    expect(composer).toContain('className="composer-context-header"');
    expect(composer).toContain('Target:');
    expect(composer).toContain('className="context-title"');
    expect(appSource).toContain('className="agent-node-target-badge"');
    expect(appSource).toContain('Composer target');
    expect(appSource).toContain('has-selected-node');
    expect(appSource).toContain('shouldAutoFitCanvas(session.nodes) || Boolean(selectedNodeId)');
    expect(appSource).toContain('selectedNodeId ?? "none"');
  });

  it("action chips change composer mode/placeholder", async () => {
    const appSource = await readSource("./App.tsx");
    const composer = appSource.slice(appSource.indexOf('function CanvasComposer('));
    expect(composer).toContain('className={`action-chip ${action === "repair" ? "selected" : ""}`}');
    expect(composer).toContain('onClick={() => setAction("repair")}');
    expect(composer).toContain('if (action === "repair") placeholder =');
    expect(composer).toContain('else if (action === "variant") placeholder =');
  });

  it("no selected node keeps existing global bottom input behavior", async () => {
    const appSource = await readSource("./App.tsx");
    const composer = appSource.slice(appSource.indexOf('function CanvasComposer('), appSource.indexOf('const hasValue =', appSource.indexOf('function CanvasComposer(')));
    expect(composer).toContain('let placeholder = "Insert requirement or node"');
    expect(composer).toContain('if (selectedNode) {');
  });

  it("modal still has exactly Output / Changes / Context tabs", async () => {
    const appSource = await readSource("./App.tsx");
    const modalTabs = appSource.slice(appSource.indexOf('<nav className="modal-tabs"'), appSource.indexOf('</nav>', appSource.indexOf('<nav className="modal-tabs"')));
    expect(modalTabs).toContain('NODE_MODAL_TABS.map');

    const modalBodyIndex = appSource.indexOf('<div className="modal-body">');
    const modalBody = appSource.slice(modalBodyIndex, appSource.indexOf('</section>', modalBodyIndex));
    expect(modalBody).toContain('tab === "Output"');
    expect(modalBody).toContain('tab === "Changes"');
    expect(modalBody).toContain('tab === "Context"');
    expect(modalBody).not.toContain('tab === "Logs"');
  });

  it("More button has an accessible label", async () => {
    const appSource = await readSource("./App.tsx");
    const menuButton = appSource.slice(appSource.indexOf('className="agent-node-menu nodrag"'), appSource.indexOf('<MoreHorizontal'));
    expect(menuButton).toContain('aria-label={`More details for ${node.title}`}');
  });

  it("node selection target keeps a visible keyboard focus style", async () => {
    const styleSource = await readSource("./styles.css");
    expect(styleSource).toContain(".agent-card-select:focus-visible");
    expect(styleSource).toContain("outline: 2px solid var(--sk-cobalt)");
  });
});

describe("Slice E node rollback/repair/variant UI wiring", () => {
  const actionState = (overrides: Partial<SelectedNodeActionState> = {}): SelectedNodeActionState => ({
    composerMode: "global",
    canRollback: true,
    blockedByRemoteSideEffect: false,
    needsBackendCheck: false,
    canCreateRepair: true,
    canCreateVariant: true,
    checkpoints: {
      hasBefore: true,
      hasAfter: true,
      beforeCheckpointId: "checkpoint-before-node",
      afterCheckpointId: "checkpoint-after-node",
      beforeCommitSha: null,
      afterCommitSha: null,
      beforeSource: null,
      afterSource: null,
    },
    remoteSideEffects: [],
    blockedReasons: [],
    rollbackPayload: {
      sessionId: "session-1",
      nodeId: "node-1",
      laneId: "lane-1",
      checkpointId: "checkpoint-before-node",
    },
    repairPayload: {
      sessionId: "session-1",
      nodeId: "node-1",
      laneId: "lane-1",
      checkpointId: "checkpoint-after-node",
      successorLaneId: "lane-1-repair",
      successorSemanticKey: "repair:lane-1:manual",
    },
    variantPayload: {
      sessionId: "session-1",
      nodeId: "node-1",
      laneId: "lane-1",
      checkpointId: "checkpoint-before-node",
      successorLaneId: "lane-1-variant",
      successorSemanticKey: "variant:lane-1:manual",
    },
    rollbackEligibility: null,
    ...overrides,
  });

  it("enables repair only with after checkpoint and backend", () => {
    expect(selectedNodeActionAvailability(actionState(), true).repair).toEqual({ enabled: true, reason: null });
    expect(selectedNodeActionAvailability(actionState({
      canCreateRepair: false,
      checkpoints: {
        hasBefore: true,
        hasAfter: false,
        beforeCheckpointId: "checkpoint-before-node",
        afterCheckpointId: null,
        beforeCommitSha: null,
        afterCommitSha: null,
        beforeSource: null,
        afterSource: null,
      },
      repairPayload: null,
    }), true).repair).toEqual({
      enabled: false,
      reason: "Repair requires an after checkpoint.",
    });
    expect(selectedNodeActionAvailability(actionState(), false).repair).toEqual({
      enabled: false,
      reason: "Workflow backend unavailable.",
    });
  });

  it("enables variant only with before checkpoint and backend", () => {
    expect(selectedNodeActionAvailability(actionState(), true).variant).toEqual({ enabled: true, reason: null });
    expect(selectedNodeActionAvailability(actionState({
      canCreateVariant: false,
      canRollback: false,
      checkpoints: {
        hasBefore: false,
        hasAfter: true,
        beforeCheckpointId: null,
        afterCheckpointId: "checkpoint-after-node",
        beforeCommitSha: null,
        afterCommitSha: null,
        beforeSource: null,
        afterSource: null,
      },
      variantPayload: null,
      rollbackPayload: null,
    }), true).variant).toEqual({
      enabled: false,
      reason: "Variant requires a before checkpoint.",
    });
    expect(selectedNodeActionAvailability(actionState(), false).variant).toEqual({
      enabled: false,
      reason: "Workflow backend unavailable.",
    });
  });

  it("disables rollback when helper reports remote side effects", () => {
    expect(selectedNodeActionAvailability(actionState({
      canRollback: false,
      blockedByRemoteSideEffect: true,
      rollbackPayload: null,
      blockedReasons: ["Remote side effects exist."],
    }), true).rollback).toEqual({
      enabled: false,
      reason: REMOTE_SIDE_EFFECT_ROLLBACK_BLOCK_MESSAGE,
    });
  });

  it("allows rollback only when helper marks it eligible and backend is available", () => {
    expect(selectedNodeActionAvailability(actionState(), true).rollback).toEqual({ enabled: true, reason: null });
    expect(selectedNodeActionAvailability(actionState(), false).rollback).toEqual({
      enabled: false,
      reason: "Workflow backend unavailable.",
    });
    expect(selectedNodeActionAvailability(actionState({
      canRollback: false,
      rollbackPayload: null,
      blockedReasons: ["Rollback requires an existing before checkpoint."],
    }), true).rollback).toEqual({
      enabled: false,
      reason: "Rollback requires an existing before checkpoint.",
    });
  });

  it("shows backend rollback failure through user-visible error state", async () => {
    const appSource = await readSource("./App.tsx");
    expect(appSource).toContain("rollbackBlockedMessage(result)");
    expect(appSource).toContain("setNodeActionError(blockedMessage)");
    expect(appSource).toContain("actionFailureMessage(error");
  });

  it("renders rolled-back and inactive nodes from existing rollbackStatus", async () => {
    expect(rollbackLabelForNode({ rollbackStatus: "rolled_back" })).toBe("Rolled back");
    expect(rollbackLabelForNode({ rollbackStatus: "inactive" })).toBe("Inactive");

    const appSource = await readSource("./App.tsx");
    expect(appSource).toContain("rollbackStatusForNode(node)");
    expect(appSource).toContain("data-rollback-status={rollbackStatus || undefined}");
    expect(appSource).toContain("rollback-badge");

    const styleSource = await readSource("./styles.css");
    expect(styleSource).toContain(".agent-node-shell.rollback-rolled_back");
    expect(styleSource).toContain(".agent-node-shell.rollback-inactive");
  });

  it("states rollback scope without claiming evidence/history deletion", async () => {
    const appSource = await readSource("./App.tsx");
    expect(appSource).toContain("Rollback affects selected and downstream workflow state, not evidence/history.");
    expect(appSource).not.toContain("delete evidence");
    expect(appSource).not.toContain("delete history");
  });

  it("selected node scope change clears stale action state", async () => {
    const appSource = await readSource("./App.tsx");
    const useEffectSource = appSource.slice(appSource.indexOf("const workflow = window.devflow?.workflow;"), appSource.indexOf("const projectRoot = activeProject.rootPath;"));
    expect(appSource).toContain("const selectedNodeActionScopeKey = activeSession?.kind === \"canvas\" && selectedNode");
    expect(appSource).not.toContain("}, [selectedNode?.id]);");
    expect(appSource).toContain("selectedNodeActionGenerationRef.current += 1;");
    expect(appSource).toContain("setNodeActionBusy(null);");
    expect(appSource).toContain("}, [selectedNodeActionScopeKey]);");
    expect(useEffectSource).toContain("setSelectedNodeActionState(null);");
  });

  it("eligible rollback shows selected plus downstream summary", async () => {
    const appSource = await readSource("./App.tsx");
    expect(appSource).toContain("downstream nodes affected");
    expect(appSource).toContain("evidence-chip impact");
    expect(appSource).toContain("selectedNodeActionState.rollbackEligibility.affectedLaneIds.length");
  });

  it("checkpoint summary renders checkpoint/restore commit/source", async () => {
    const appSource = await readSource("./App.tsx");
    expect(appSource).toContain("Before Checkpoint");
    expect(appSource).toContain("After Checkpoint");
    expect(appSource).toContain("selectedNodeActionState.checkpoints.beforeCheckpointId");
    expect(appSource).toContain("selectedNodeActionState.checkpoints.afterCheckpointId");
    expect(appSource).toContain("selectedNodeActionState.rollbackEligibility.restoreCommitRef");
  });

  it("remote blocker/manual repair disables rollback and shows correct message", async () => {
    const appSource = await readSource("./App.tsx");
    expect(appSource).toContain("Remote blockers:");
    expect(appSource).toContain("selectedNodeActionState.remoteSideEffects.length");
    expect(appSource).toContain("selectedNodeActionState.rollbackEligibility?.manualRepairReason");
    expect(appSource).toContain("Backend check required");
  });
});

describe("Terminal Inspector UI Helper", () => {
  const mockSnapshot: TerminalSnapshotResult = {
    protocolVersion: 1,
    terminalSessionId: "session-123",
    status: "running",
    sequence: 42,
    rows: 24,
    cols: 80,
    cursor: { row: 0, col: 0 },
    lines: [],
    message: "Test error",
    reasonCode: "TERMINAL_SESSION_NOT_FOUND"
  };

  it("formats title correctly", () => {
    expect(formatTerminalTitle(null)).toBe("Hermes Terminal");
    expect(formatTerminalTitle(mockSnapshot)).toBe("Hermes Terminal (session-123)");
  });

  it("formats badge correctly", () => {
    expect(formatTerminalBadge(null)).toBe("connecting...");
    expect(formatTerminalBadge(mockSnapshot)).toBe("running [seq: 42]");
  });

  it("formats message correctly", () => {
    expect(formatTerminalMessage(null)).toBeNull();
    expect(formatTerminalMessage(mockSnapshot)).toBe("Test error (TERMINAL_SESSION_NOT_FOUND)");
  });
});

describe("Terminal Inspector Source Code Analysis", () => {
  it("terminal content defaults hidden and toggle wiring exists in TopBar", async () => {
    const appSource = await readSource("./App.tsx");
    expect(appSource).toContain("const [terminalOpen, setTerminalOpen] = useState(false);");
    // Verify TopBar toggle wiring exists
    expect(appSource).toContain("onToggleTerminal={() => setTerminalOpen(!terminalOpen)}");
  });

  it("Node Modal tabs still only Output/Changes/Context", async () => {
    const appSource = await readSource("./App.tsx");
    const modalTabs = appSource.slice(appSource.indexOf('<nav className="modal-tabs"'), appSource.indexOf('</nav>', appSource.indexOf('<nav className="modal-tabs"')));
    // NODE_MODAL_TABS is used, and it shouldn't contain terminal tabs
    expect(appSource).toContain("NODE_MODAL_TABS");
    // Ensure we don't render terminal logs inside node modal
    const modalBodyIndex = appSource.indexOf('<div className="modal-body">');
    if (modalBodyIndex !== -1) {
      const modalBody = appSource.slice(modalBodyIndex, appSource.indexOf('</section>', modalBodyIndex));
      expect(modalBody).toContain('tab === "Output"');
      expect(modalBody).toContain('tab === "Changes"');
      expect(modalBody).toContain('tab === "Context"');
      expect(modalBody).not.toContain('tab === "Logs"');
      expect(modalBody).not.toContain('tab === "Terminal"');
    }
  });

  it("selecting node does not auto-open terminal", async () => {
    const appSource = await readSource("./App.tsx");
    // Expect no effect that sets terminal open on node select unconditionally
    expect(appSource).not.toMatch(/setSelectedNodeId\([^)]+\)[\s\S]*?setTerminalOpen\(true\)/);
  });

  it("renderer does not call terminal.start / terminal.write; read-only only", async () => {
    const appSource = await readSource("./App.tsx");
    expect(appSource).not.toContain("terminal.start");
    expect(appSource).not.toContain("terminal.write");
    expect(appSource).toContain("disabled");
    expect(appSource).toContain("Terminal is read-only in this mode...");
  });

  it("Terminal Inspector placement avoids composer safe area and Node Modal overlaps it", async () => {
    const styleSource = await readSource("./styles.css");
    const terminalInspectorStyle = styleSource.slice(styleSource.indexOf(".terminal-inspector {"));

    // Assert placement is top-right, avoiding bottom composer zone
    expect(terminalInspectorStyle).toMatch(/top:\s*64px;/);
    expect(terminalInspectorStyle).toMatch(/right:\s*20px;/);
    expect(terminalInspectorStyle).toMatch(/bottom:\s*(1[8-9][0-9]|2[0-9]{2})px;/); // >= 180px inset

    // Assert z-index logic allows modal to cover it and stays under composer
    expect(terminalInspectorStyle).toMatch(/z-index:\s*7;/);
    const modalBackdropStyle = styleSource.slice(styleSource.indexOf(".modal-backdrop {"));
    expect(modalBackdropStyle).toMatch(/z-index:\s*20;/);
  });

  it("Terminal Inspector only renders for active session/canvas (not Project Start)", async () => {
    const appSource = await readSource("./App.tsx");
    // Ensure it renders scoped to activeSession canvas
    expect(appSource).toMatch(/\{terminalOpen && activeSession\?.kind === "canvas" && \(\s*<TerminalInspector/);
  });

  it("source wiring uses activeSession.kind === 'canvas' before rendering inspector", async () => {
    const appSource = await readSource("./App.tsx");
    expect(appSource).toContain('terminalOpen && activeSession?.kind === "canvas" && (');
  });

  it("terminal id resolver returns null when no binding exists", async () => {
    const appSource = await readSource("./App.tsx");
    expect(appSource).toContain('terminalSessionId={(activeSession as CanvasSession & { hermesPlannerTerminalSessionId?: string }).hermesPlannerTerminalSessionId ?? null}');
  });

  it("terminal id resolver returns hermesPlannerTerminalSessionId when present, even if it differs from canvas session id", async () => {
    const appSource = await readSource("./App.tsx");
    expect(appSource).toContain('terminalSessionId={(activeSession as CanvasSession & { hermesPlannerTerminalSessionId?: string }).hermesPlannerTerminalSessionId ?? null}');
  });

  it("source does not use session.id as terminalSessionId for snapshot/event filtering", async () => {
    const appSource = await readSource("./App.tsx");
    const inspectorSource = appSource.slice(appSource.indexOf("function TerminalInspector"));
    expect(inspectorSource).not.toMatch(/terminalSessionId:\s*session\.id/);
    expect(inspectorSource).not.toMatch(/event\.terminalSessionId === session\.id/);

    // Ensure terminalSessionId is used correctly
    expect(inspectorSource).toMatch(/\[.*terminalSessionId.*\]/);
    expect(inspectorSource).toMatch(/snapshot\(\{\s*terminalSessionId\s*\}\)/);
    expect(inspectorSource).toMatch(/event\.terminalSessionId === terminalSessionId/);
  });

  it("unbound state does not call snapshot/start/write", async () => {
    const appSource = await readSource("./App.tsx");
    const inspectorSource = appSource.slice(appSource.indexOf("function TerminalInspector"));
    expect(inspectorSource).toMatch(/if \(!terminalSessionId\) \{/);
    expect(inspectorSource).toMatch(/terminalSessionId: "unbound"/);
    expect(appSource).not.toContain("terminal.start");
    expect(appSource).not.toContain("terminal.write");
  });
});
