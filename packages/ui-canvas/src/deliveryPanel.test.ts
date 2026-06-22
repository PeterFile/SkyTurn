import { describe, expect, it } from "vitest";
import {
  buildDeliveryPanelState,
  hydrateDeliveryLifecycleFromWorkflowEvents,
  type DeliveryPanelInput,
} from "./deliveryPanel.js";

function input(overrides: Partial<DeliveryPanelInput> = {}): DeliveryPanelInput {
  return {
    isCommitLane: true,
    hasGitEvidence: true,
    hasGitChanges: true,
    backend: {
      commit: true,
      push: true,
      createPr: true,
      checkPr: true,
      merge: true,
      sync: true,
      cleanup: true,
    },
    commitEvidence: null,
    pushEvidence: null,
    pullRequest: null,
    checks: null,
    mergeTitle: "",
    mergeConfirmed: false,
    mergeComplete: false,
    syncComplete: false,
    cleanupExplicitlyAllowed: false,
    cleanupConfirmed: false,
    deleteBranch: false,
    deleteBranchConfirmed: false,
    busyAction: null,
    ...overrides,
  };
}

describe("buildDeliveryPanelState", () => {
  it("enables commit only for commit lanes with git evidence", () => {
    expect(buildDeliveryPanelState(input()).canCommit).toBe(true);
    expect(buildDeliveryPanelState(input({ isCommitLane: false })).canCommit).toBe(false);
    expect(buildDeliveryPanelState(input({ hasGitEvidence: false })).canCommit).toBe(false);
    expect(buildDeliveryPanelState(input({ hasGitChanges: false })).canCommit).toBe(false);
  });

  it("gates push, PR creation, and PR checks in delivery order", () => {
    const committed = input({ commitEvidence: { commitSha: "abc1234", branch: "feature/x" } });
    expect(buildDeliveryPanelState(committed).canPush).toBe(true);
    expect(buildDeliveryPanelState(committed).canCreatePr).toBe(false);

    const pushed = input({
      commitEvidence: { commitSha: "abc1234", branch: "feature/x" },
      pushEvidence: { remote: "origin", branch: "feature/x", commitSha: "abc1234" },
    });
    expect(buildDeliveryPanelState(pushed).canCreatePr).toBe(true);
    expect(buildDeliveryPanelState(pushed).canCheckPr).toBe(false);

    const prCreated = input({
      commitEvidence: { commitSha: "abc1234", branch: "feature/x" },
      pushEvidence: { remote: "origin", branch: "feature/x", commitSha: "abc1234" },
      pullRequest: { number: 42, url: "https://example.test/pull/42", headSha: "abc1234", title: "feat(ui): add panel" },
    });
    expect(buildDeliveryPanelState(prCreated).canCreatePr).toBe(false);
    expect(buildDeliveryPanelState(prCreated).canCheckPr).toBe(true);
    expect(buildDeliveryPanelState(prCreated).prCreatedCompletesTask).toBe(false);
  });

  it("disables push after a pull request exists", () => {
    const prCreated = input({
      commitEvidence: { commitSha: "abc1234", branch: "feature/x" },
      pushEvidence: { remote: "origin", branch: "feature/x", commitSha: "abc1234" },
      pullRequest: { number: 42, url: "https://example.test/pull/42", headSha: "abc1234", title: "feat(ui): add panel" },
    });

    const state = buildDeliveryPanelState(prCreated);

    expect(state.canPush).toBe(false);
    expect(state.canCreatePr).toBe(false);
  });

  it("requires exact-head green checks before merge readiness", () => {
    const pr = {
      number: 42,
      url: "https://example.test/pull/42",
      headSha: "abc1234",
      title: "feat(ui): add panel",
    };
    expect(buildDeliveryPanelState(input({
      pullRequest: pr,
      checks: { checkStatus: "passing", expectedHeadSha: "def9999", mergeable: true },
      mergeTitle: "feat(ui): add panel",
      mergeConfirmed: true,
    })).mergeReady).toBe(false);
    expect(buildDeliveryPanelState(input({
      pullRequest: pr,
      checks: { checkStatus: "pending", expectedHeadSha: "abc1234", mergeable: true },
      mergeTitle: "feat(ui): add panel",
      mergeConfirmed: true,
    })).mergeReady).toBe(false);
    expect(buildDeliveryPanelState(input({
      pullRequest: pr,
      checks: { checkStatus: "passing", expectedHeadSha: "abc1234", mergeable: true },
      mergeTitle: "feat(ui): add panel",
      mergeConfirmed: true,
    })).mergeReady).toBe(true);
  });

  it("requires explicit merge confirmation and title", () => {
    const ready = input({
      pullRequest: { number: 42, url: "https://example.test/pull/42", headSha: "abc1234", title: "feat(ui): add panel" },
      checks: { checkStatus: "passing", expectedHeadSha: "abc1234", mergeable: true },
    });
    expect(buildDeliveryPanelState(ready).canMerge).toBe(false);
    expect(buildDeliveryPanelState({ ...ready, mergeTitle: "feat(ui): add panel" }).canMerge).toBe(false);
    expect(buildDeliveryPanelState({ ...ready, mergeTitle: "feat(ui): add panel", mergeConfirmed: true }).canMerge).toBe(true);
  });

  it("disables cleanup until merge or sync unless explicitly allowed", () => {
    expect(buildDeliveryPanelState(input({ cleanupConfirmed: true })).canCleanup).toBe(false);
    expect(buildDeliveryPanelState(input({ mergeComplete: true, cleanupConfirmed: true })).canCleanup).toBe(true);
    expect(buildDeliveryPanelState(input({ syncComplete: true, cleanupConfirmed: true })).canCleanup).toBe(true);
    expect(buildDeliveryPanelState(input({ cleanupExplicitlyAllowed: true, cleanupConfirmed: true })).canCleanup).toBe(true);
  });

  it("keeps branch deletion off by default and requires second confirmation", () => {
    expect(buildDeliveryPanelState(input()).deleteBranchRequested).toBe(false);
    expect(buildDeliveryPanelState(input({ deleteBranch: true, cleanupExplicitlyAllowed: true, cleanupConfirmed: true })).canCleanup).toBe(false);
    expect(buildDeliveryPanelState(input({
      deleteBranch: true,
      deleteBranchConfirmed: true,
      cleanupExplicitlyAllowed: true,
      cleanupConfirmed: true,
    })).canCleanup).toBe(true);
  });
});

describe("hydrateDeliveryLifecycleFromWorkflowEvents", () => {
  it("restores delivery lifecycle state from renderer-safe Electron workflow events", () => {
    const restored = hydrateDeliveryLifecycleFromWorkflowEvents([
      {
        kind: "workflow.commit.created",
        laneId: "lane-commit",
        payload: {
          redacted: true,
          summary: "Commit created.",
          delivery: {
            kind: "commit",
            laneId: "lane-commit",
            commitSha: "sha-b",
            branch: "feature/slice-c",
            subject: "feat(workflow): ship slice c",
          },
        },
      },
      {
        kind: "workflow.delivery.pushed",
        laneId: "lane-commit",
        payload: {
          redacted: true,
          summary: "Delivery branch pushed.",
          delivery: {
            kind: "push",
            laneId: "lane-commit",
            status: "pushed",
            remote: "origin",
            branch: "feature/slice-c",
            commitSha: "sha-b",
          },
        },
      },
      {
        kind: "workflow.pull_request.created",
        laneId: "lane-pr",
        payload: {
          redacted: true,
          summary: "Pull request created.",
          delivery: {
            kind: "pull_request",
            laneId: "lane-pr",
            commitLaneId: "lane-commit",
            prNumber: 42,
            url: "https://example.test/pull/42",
            headSha: "sha-b",
            title: "feat(workflow): ship slice c",
          },
        },
      },
      {
        kind: "workflow.pull_request.checks_recorded",
        laneId: "lane-pr",
        payload: {
          redacted: true,
          summary: "Pull request checks recorded.",
          delivery: {
            kind: "checks",
            laneId: "lane-pr",
            status: "passed",
            prNumber: 42,
            url: "https://example.test/pull/42",
            headSha: "sha-b",
            checks: [{ name: "Build and test", status: "passed", link: "https://example.test/checks/1" }],
          },
        },
      },
      {
        kind: "workflow.pull_request.merged",
        laneId: "lane-pr",
        payload: {
          redacted: true,
          summary: "Pull request merged.",
          delivery: {
            kind: "merge",
            laneId: "lane-pr",
            status: "merged",
            prNumber: 42,
            url: "https://example.test/pull/42",
            headSha: "sha-b",
            subject: "feat(workflow): ship slice c",
          },
        },
      },
      {
        kind: "workflow.delivery.main_synced",
        laneId: "lane-pr",
        payload: {
          redacted: true,
          summary: "Main branch synced.",
          delivery: {
            kind: "main_synced",
            laneId: "lane-pr",
            status: "synced",
            prNumber: 42,
            headSha: "sha-b",
            mainBranch: "main",
            remote: "origin",
          },
        },
      },
    ], { commitLaneId: "lane-commit", pullRequestLaneId: "lane-pr" });

    expect(restored.commitEvidence).toEqual({
      commitSha: "sha-b",
      branch: "feature/slice-c",
      subject: "feat(workflow): ship slice c",
    });
    expect(restored.pushEvidence).toEqual({
      remote: "origin",
      branch: "feature/slice-c",
      commitSha: "sha-b",
    });
    expect(restored.pullRequest).toEqual({
      number: 42,
      url: "https://example.test/pull/42",
      headSha: "sha-b",
      title: "feat(workflow): ship slice c",
    });
    expect(restored.checks).toEqual({
      checkStatus: "passing",
      expectedHeadSha: "sha-b",
      mergeable: true,
    });
    expect(restored.mergeComplete).toBe(true);
    expect(restored.syncComplete).toBe(true);
  });

  it("does not treat PR creation or stale checks as merge readiness", () => {
    const restored = hydrateDeliveryLifecycleFromWorkflowEvents([
      {
        kind: "workflow.commit.created",
        payload: {
          laneId: "lane-commit",
          evidence: { commitSha: "sha-new", branch: "feature/slice-c" },
        },
      },
      {
        kind: "workflow.pull_request.created",
        payload: {
          laneId: "lane-pr",
          commitLaneId: "lane-commit",
          evidence: { number: 42, url: "https://example.test/pull/42", commitSha: "sha-new" },
        },
      },
      {
        kind: "workflow.pull_request.checks_recorded",
        payload: {
          laneId: "lane-pr",
          evidence: { status: "passed", number: 42, url: "https://example.test/pull/42", headSha: "sha-old", checks: [] },
        },
      },
    ], { commitLaneId: "lane-commit", pullRequestLaneId: "lane-pr" });

    const panelState = buildDeliveryPanelState(input({
      commitEvidence: restored.commitEvidence,
      pushEvidence: restored.pushEvidence,
      pullRequest: restored.pullRequest,
      checks: restored.checks,
      mergeTitle: "feat(workflow): ship slice c",
      mergeConfirmed: true,
      mergeComplete: restored.mergeComplete,
      syncComplete: restored.syncComplete,
    }));

    expect(restored.pullRequest).not.toBeNull();
    expect(panelState.prCreatedCompletesTask).toBe(false);
    expect(panelState.mergeReady).toBe(false);
    expect(panelState.canMerge).toBe(false);
  });
});
