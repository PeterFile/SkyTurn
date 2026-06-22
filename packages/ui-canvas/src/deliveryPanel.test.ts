import { describe, expect, it } from "vitest";
import { buildDeliveryPanelState, type DeliveryPanelInput } from "./deliveryPanel.js";

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
