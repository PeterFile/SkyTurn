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
    syncConfirmed: false,
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
      checks: { checkStatus: "passing", reviewStatus: "pending", expectedHeadSha: "def9999", mergeable: true },
      mergeTitle: "feat(ui): add panel",
      mergeConfirmed: true,
    })).mergeReady).toBe(false);
    expect(buildDeliveryPanelState(input({
      pullRequest: pr,
      checks: { checkStatus: "pending", reviewStatus: "pending", expectedHeadSha: "abc1234", mergeable: true },
      mergeTitle: "feat(ui): add panel",
      mergeConfirmed: true,
    })).mergeReady).toBe(false);
    expect(buildDeliveryPanelState(input({
      pullRequest: pr,
      checks: { checkStatus: "passing", reviewStatus: "pending", expectedHeadSha: "abc1234", mergeable: true },
      mergeTitle: "feat(ui): add panel",
      mergeConfirmed: true,
    })).mergeReady).toBe(true);
  });

  it("fails closed when review evidence is missing", () => {
    const pr = { number: 42, url: "https://example.test/pull/42", headSha: "abc1234", title: "feat(ui): add panel" };
    expect(buildDeliveryPanelState(input({
      pullRequest: pr,
      checks: { checkStatus: "passing", expectedHeadSha: "abc1234", mergeable: true } as any,
      mergeTitle: "feat(ui): add panel",
      mergeConfirmed: true,
    })).mergeReady).toBe(false);
  });

  it("requires explicit merge confirmation and title", () => {
    const ready = input({
      pullRequest: { number: 42, url: "https://example.test/pull/42", headSha: "abc1234", title: "feat(ui): add panel" },
      checks: { checkStatus: "passing", reviewStatus: "approved", expectedHeadSha: "abc1234", mergeable: true },
    });
    expect(buildDeliveryPanelState(ready).canMerge).toBe(false);
    expect(buildDeliveryPanelState({ ...ready, mergeTitle: "feat(ui): add panel" }).canMerge).toBe(false);
    expect(buildDeliveryPanelState({ ...ready, mergeTitle: "feat(ui): add panel", mergeConfirmed: true }).canMerge).toBe(true);
  });

  it("blocks merge when reviewStatus is changes_requested", () => {
    const pr = { number: 42, url: "https://example.test/pull/42", headSha: "abc1234", title: "feat(ui): add panel" };
    expect(buildDeliveryPanelState(input({
      pullRequest: pr,
      checks: { checkStatus: "passing", reviewStatus: "changes_requested", expectedHeadSha: "abc1234", mergeable: true },
      mergeTitle: "feat(ui): add panel",
      mergeConfirmed: true,
    })).mergeReady).toBe(false);
  });

  it("blocks merge when mergeable is false", () => {
    const pr = { number: 42, url: "https://example.test/pull/42", headSha: "abc1234", title: "feat(ui): add panel" };
    expect(buildDeliveryPanelState(input({
      pullRequest: pr,
      checks: { checkStatus: "passing", reviewStatus: "approved", expectedHeadSha: "abc1234", mergeable: false },
      mergeTitle: "feat(ui): add panel",
      mergeConfirmed: true,
    })).mergeReady).toBe(false);
  });

  it("blocks merge when expectedHeadSha is missing", () => {
    const pr = { number: 42, url: "https://example.test/pull/42", headSha: "abc1234", title: "feat(ui): add panel" };
    expect(buildDeliveryPanelState(input({
      pullRequest: pr,
      checks: { checkStatus: "passing", reviewStatus: "approved", mergeable: true } as any,
      mergeTitle: "feat(ui): add panel",
      mergeConfirmed: true,
    })).mergeReady).toBe(false);
  });

  it("blocks merge when current PR headSha is missing", () => {
    const pr = { number: 42, url: "https://example.test/pull/42", title: "feat(ui): add panel" };
    expect(buildDeliveryPanelState(input({
      commitEvidence: { commitSha: "abc1234", branch: "feature/x" },
      pullRequest: pr,
      checks: { checkStatus: "passing", reviewStatus: "approved", expectedHeadSha: "abc1234", mergeable: true },
      mergeTitle: "feat(ui): add panel",
      mergeConfirmed: true,
    })).mergeReady).toBe(false);
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

  it("describes commit gate availability and completion", () => {
    const ready = buildDeliveryPanelState(input()).gateList.find((gate) => gate.key === "commit");
    expect(ready).toMatchObject({
      status: "ready",
      label: "Local commit",
      summary: "Ready to create a local commit from verified git changes.",
    });

    const done = buildDeliveryPanelState(input({
      commitEvidence: { commitSha: "abc1234", branch: "feature/x" },
    })).gateList.find((gate) => gate.key === "commit");
    expect(done).toMatchObject({
      status: "done",
      summary: "Local commit recorded: abc1234.",
    });
  });

  it("describes push gate availability, completion, and blockers", () => {
    const blocked = buildDeliveryPanelState(input()).gateList.find((gate) => gate.key === "push");
    expect(blocked).toMatchObject({
      status: "blocked",
      summary: "Blocked until local commit evidence exists.",
    });

    const ready = buildDeliveryPanelState(input({
      commitEvidence: { commitSha: "abc1234", branch: "feature/x" },
    })).gateList.find((gate) => gate.key === "push");
    expect(ready).toMatchObject({
      status: "ready",
      summary: "Ready to push feature/x for commit abc1234.",
    });

    const done = buildDeliveryPanelState(input({
      commitEvidence: { commitSha: "abc1234", branch: "feature/x" },
      pushEvidence: { remote: "origin", branch: "feature/x", commitSha: "abc1234" },
    })).gateList.find((gate) => gate.key === "push");
    expect(done).toMatchObject({
      status: "done",
      summary: "Pushed origin/feature/x at abc1234.",
    });

    const prExists = buildDeliveryPanelState(input({
      commitEvidence: { commitSha: "abc1234", branch: "feature/x" },
      pushEvidence: { remote: "origin", branch: "feature/x", commitSha: "abc1234" },
      pullRequest: { number: 42, headSha: "abc1234" },
    })).gateList.find((gate) => gate.key === "push");
    expect(prExists).toMatchObject({
      status: "blocked",
      summary: "Push is closed because PR #42 already exists.",
    });
  });

  it("describes PR creation without treating it as task completion", () => {
    const ready = buildDeliveryPanelState(input({
      commitEvidence: { commitSha: "abc1234", branch: "feature/x" },
      pushEvidence: { remote: "origin", branch: "feature/x", commitSha: "abc1234" },
    })).gateList.find((gate) => gate.key === "pr");
    expect(ready).toMatchObject({
      status: "ready",
      summary: "Ready to create a PR from pushed branch feature/x.",
    });

    const done = buildDeliveryPanelState(input({
      commitEvidence: { commitSha: "abc1234", branch: "feature/x" },
      pushEvidence: { remote: "origin", branch: "feature/x", commitSha: "abc1234" },
      pullRequest: { number: 42, url: "https://example.test/pull/42", headSha: "abc1234" },
    })).gateList.find((gate) => gate.key === "pr");
    expect(done).toMatchObject({
      status: "done",
      summary: "PR #42 created. This is delivery evidence, not task completion.",
    });
  });

  it("describes exact-head checks stale, pass, fail, and pending states", () => {
    const pr = { number: 42, headSha: "abc1234", title: "feat(ui): add panel" };

    expect(buildDeliveryPanelState(input({
      pullRequest: pr,
      checks: { checkStatus: "passing", reviewStatus: "approved", expectedHeadSha: "def9999", mergeable: true },
    })).gateList.find((gate) => gate.key === "checks")).toMatchObject({
      status: "stale",
      summary: "Checks are stale: checked def9999, PR head is abc1234.",
    });

    expect(buildDeliveryPanelState(input({
      pullRequest: pr,
      checks: { checkStatus: "passing", reviewStatus: "approved", expectedHeadSha: "abc1234", mergeable: true },
    })).gateList.find((gate) => gate.key === "checks")).toMatchObject({
      status: "done",
      summary: "Exact-head checks passed for abc1234. Green checks do not auto-merge.",
    });

    expect(buildDeliveryPanelState(input({
      pullRequest: pr,
      checks: { checkStatus: "failing", reviewStatus: "approved", expectedHeadSha: "abc1234", mergeable: false },
    })).gateList.find((gate) => gate.key === "checks")).toMatchObject({
      status: "blocked",
      summary: "Checks failed for abc1234; merge is blocked.",
    });

    expect(buildDeliveryPanelState(input({
      pullRequest: pr,
      checks: { checkStatus: "pending", reviewStatus: "pending", expectedHeadSha: "abc1234", mergeable: false },
    })).gateList.find((gate) => gate.key === "checks")).toMatchObject({
      status: "pending",
      summary: "Checks are pending for abc1234; re-check before merge.",
    });
  });

  it("describes merge confirmation as an explicit manual gate", () => {
    const readyForConfirmation = input({
      pullRequest: { number: 42, headSha: "abc1234", title: "feat(ui): add panel" },
      checks: { checkStatus: "passing", reviewStatus: "approved", expectedHeadSha: "abc1234", mergeable: true },
      mergeTitle: "feat(ui): add panel",
      mergeConfirmed: false,
    });
    expect(buildDeliveryPanelState(readyForConfirmation).gateList.find((gate) => gate.key === "merge")).toMatchObject({
      status: "blocked",
      summary: "Manual gate: confirm PR number, exact head SHA, and squash title.",
    });

    expect(buildDeliveryPanelState({ ...readyForConfirmation, mergeConfirmed: true }).gateList.find((gate) => gate.key === "merge")).toMatchObject({
      status: "ready",
      summary: "Explicit squash merge confirmation is complete.",
    });
  });

  it("requires explicit sync confirmation after merge", () => {
    expect(buildDeliveryPanelState(input({
      mergeComplete: true,
      syncConfirmed: false,
    })).gateList.find((gate) => gate.key === "sync")).toMatchObject({
      status: "blocked",
      summary: "Manual gate: confirm post-merge main sync.",
    });
    expect(buildDeliveryPanelState(input({
      mergeComplete: true,
      syncConfirmed: true,
    })).canSync).toBe(true);
  });

  it("describes cleanup confirmation and branch deletion default-off", () => {
    const cleanup = buildDeliveryPanelState(input({
      mergeComplete: true,
      cleanupConfirmed: false,
    })).gateList.find((gate) => gate.key === "cleanup");
    expect(cleanup).toMatchObject({
      status: "blocked",
      summary: "Manual gate: confirm cleanup after merge or sync.",
    });

    const deleteBranchOff = buildDeliveryPanelState(input()).gateList.find((gate) => gate.key === "delete-branch");
    expect(deleteBranchOff).toMatchObject({
      status: "safe",
      summary: "Branch deletion is off by default.",
    });

    const deleteBranchBlocked = buildDeliveryPanelState(input({
      mergeComplete: true,
      cleanupConfirmed: true,
      deleteBranch: true,
    })).gateList.find((gate) => gate.key === "delete-branch");
    expect(deleteBranchBlocked).toMatchObject({
      status: "blocked",
      summary: "Branch deletion needs a second explicit confirmation.",
    });
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
            review: { status: "pending" },
            gate: { reviewStatus: "pending", mergeable: true },
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
      reviewStatus: "pending",
      expectedHeadSha: "sha-b",
      mergeable: true,
    });
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
    expect(panelState.exactHeadChecksPassed).toBe(true);
    expect(panelState.mergeReady).toBe(true);
    expect(restored.mergeComplete).toBe(true);
    expect(restored.syncComplete).toBe(true);
  });

  it("keeps renderer-safe hydrated checks blocked when their exact head is stale after restart", () => {
    const restored = hydrateDeliveryLifecycleFromWorkflowEvents([
      {
        kind: "workflow.commit.created",
        payload: {
          redacted: true,
          delivery: { kind: "commit", laneId: "lane-commit", commitSha: "sha-new", branch: "feature/slice-c" },
        },
      },
      {
        kind: "workflow.pull_request.created",
        payload: {
          redacted: true,
          delivery: {
            kind: "pull_request",
            laneId: "lane-pr",
            commitLaneId: "lane-commit",
            prNumber: 42,
            url: "https://example.test/pull/42",
            headSha: "sha-new",
          },
        },
      },
      {
        kind: "workflow.pull_request.checks_recorded",
        payload: {
          redacted: true,
          delivery: {
            kind: "checks",
            laneId: "lane-pr",
            prNumber: 42,
            url: "https://example.test/pull/42",
            status: "passed",
            headSha: "sha-old",
            checks: [],
            review: { status: "approved" },
            gate: { mergeable: true },
          },
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
    expect(restored.checks).toEqual({
      checkStatus: "passing",
      reviewStatus: "approved",
      expectedHeadSha: "sha-old",
      mergeable: true,
    });
    expect(panelState.prCreatedCompletesTask).toBe(false);
    expect(panelState.exactHeadChecksPassed).toBe(false);
    expect(panelState.mergeReady).toBe(false);
    expect(panelState.canMerge).toBe(false);
  });

  it("blocks merge when hydrated review.status is changes_requested", () => {
    const restored = hydrateDeliveryLifecycleFromWorkflowEvents([
      {
        kind: "workflow.pull_request.created",
        payload: {
          laneId: "lane-pr",
          evidence: { number: 42, headSha: "sha-a" },
        },
      },
      {
        kind: "workflow.pull_request.checks_recorded",
        payload: {
          laneId: "lane-pr",
          evidence: {
            status: "passed",
            headSha: "sha-a",
            review: { status: "changes_requested" },
            gate: { reviewStatus: "changes_requested", mergeable: false },
          },
        },
      },
    ], { commitLaneId: "lane-commit", pullRequestLaneId: "lane-pr" });

    const panelState = buildDeliveryPanelState(input({
      pullRequest: restored.pullRequest,
      checks: restored.checks,
      mergeTitle: "Title",
      mergeConfirmed: true,
    }));
    expect(panelState.mergeReady).toBe(false);
    expect(restored.checks?.reviewStatus).toBe("changes_requested");
  });

  it("fails closed (merge blocked) when hydrated missing review evidence", () => {
    const restored = hydrateDeliveryLifecycleFromWorkflowEvents([
      {
        kind: "workflow.pull_request.created",
        payload: {
          laneId: "lane-pr",
          evidence: { number: 42, headSha: "sha-a" },
        },
      },
      {
        kind: "workflow.pull_request.checks_recorded",
        payload: {
          laneId: "lane-pr",
          evidence: { status: "passed", headSha: "sha-a" }, // No review/gate.
        },
      },
    ], { commitLaneId: "lane-commit", pullRequestLaneId: "lane-pr" });

    const panelState = buildDeliveryPanelState(input({
      pullRequest: restored.pullRequest,
      checks: restored.checks,
      mergeTitle: "Title",
      mergeConfirmed: true,
    }));
    expect(panelState.mergeReady).toBe(false);
    expect(restored.checks?.reviewStatus).toBe("unknown");
    expect(restored.checks?.mergeable).toBe(false);
  });
});
