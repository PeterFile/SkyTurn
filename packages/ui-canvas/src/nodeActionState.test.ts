import { describe, expect, it } from "vitest";
import type { CanvasNode } from "@skyturn/project-core";
import { reduceWorkflowEvents, type FlowEvent, type FlowProjection } from "@skyturn/workflow-kernel";

import { buildSelectedNodeActionState, hydrateSelectedNodeActionStateFromEvents } from "./nodeActionState.js";

const sessionId = "session-1";
const selectedNode = node("lane-implementation");
let eventSeq = 0;

describe("buildSelectedNodeActionState", () => {
  it("disables rollback when the selected node has no before checkpoint", () => {
    const state = buildSelectedNodeActionState({
      sessionId,
      selectedNode,
      projection: projection(),
      composerMode: "rollback-selected-node-and-downstream",
    });

    expect(state.composerMode).toBe("global");
    expect(state.checkpoints.hasBefore).toBe(false);
    expect(state.canRollback).toBe(false);
    expect(state.blockedReasons).toContain("Rollback requires an existing before checkpoint.");
    expect(state.rollbackPayload).toBeNull();
  });

  it("enables variants from the selected node before checkpoint", () => {
    const state = buildSelectedNodeActionState({
      sessionId,
      selectedNode,
      projection: projection(checkpoint("checkpoint-before-implementation", "lane-implementation", "before", "base-sha")),
      composerMode: "variant-from-before-checkpoint",
    });

    expect(state.composerMode).toBe("variant-from-before-checkpoint");
    expect(state.checkpoints.beforeCheckpointId).toBe("checkpoint-before-implementation");
    expect(state.canRollback).toBe(true);
    expect(state.canCreateVariant).toBe(true);
    expect(state.rollbackPayload).toMatchObject({
      sessionId,
      nodeId: "lane-implementation",
      laneId: "lane-implementation",
      checkpointId: "checkpoint-before-implementation",
    });
    expect(state.variantPayload).toMatchObject({
      sessionId,
      nodeId: "lane-implementation",
      laneId: "lane-implementation",
      checkpointId: "checkpoint-before-implementation",
      successorLaneId: "lane-implementation-variant",
      successorSemanticKey: "variant:lane-implementation:manual",
    });
  });

  it("enables repair from the selected node after checkpoint", () => {
    const state = buildSelectedNodeActionState({
      sessionId,
      selectedNode,
      projection: projection(
        ...terminalRunEvents("lane-implementation", "failed"),
        checkpoint("checkpoint-after-implementation", "lane-implementation", "after", "head-sha"),
      ),
      composerMode: "repair-selected-node-from-after-checkpoint",
    });

    expect(state.composerMode).toBe("repair-selected-node-from-after-checkpoint");
    expect(state.checkpoints.afterCheckpointId).toBe("checkpoint-after-implementation");
    expect(state.canCreateRepair).toBe(true);
    expect(state.repairPayload).toMatchObject({
      sessionId,
      nodeId: "lane-implementation",
      laneId: "lane-implementation",
      checkpointId: "checkpoint-after-implementation",
      successorLaneId: "lane-implementation-repair",
      successorSemanticKey: "repair:lane-implementation:manual",
    });
  });

  it("disables variants from a dirty before checkpoint", () => {
    const state = buildSelectedNodeActionState({
      sessionId,
      selectedNode,
      projection: projection(
        checkpoint("checkpoint-before-implementation", "lane-implementation", "before", "base-sha", sessionId, "dirty"),
      ),
      composerMode: "variant-from-before-checkpoint",
    });

    expect(state.composerMode).toBe("global");
    expect(state.canCreateVariant).toBe(false);
    expect(state.variantPayload).toBeNull();
  });

  it.each(["succeeded", "cancelled", "timed-out"] as const)(
    "keeps repair available for %s terminal evidence",
    (status) => {
      const state = buildSelectedNodeActionState({
        sessionId,
        selectedNode,
        projection: projection(
          ...terminalRunEvents("lane-implementation", status),
          checkpoint("checkpoint-after-implementation", "lane-implementation", "after", "head-sha"),
        ),
        composerMode: "repair-selected-node-from-after-checkpoint",
      });

      expect(state.composerMode).toBe("repair-selected-node-from-after-checkpoint");
      expect(state.canCreateRepair).toBe(true);
      expect(state.repairPayload).toMatchObject({
        checkpointId: "checkpoint-after-implementation",
        successorLaneId: "lane-implementation-repair",
      });
    },
  );

  it("keeps repair available when failed terminal evidence does not match the after checkpoint run", () => {
    const mismatchedCheckpoint = checkpoint(
      "checkpoint-after-implementation",
      "lane-implementation",
      "after",
      "head-sha",
    );
    const checkpointPayload = mismatchedCheckpoint.payload.checkpoint as Record<string, unknown>;
    checkpointPayload.runId = "run-other";
    const state = buildSelectedNodeActionState({
      sessionId,
      selectedNode,
      projection: projection(...terminalRunEvents("lane-implementation", "failed"), mismatchedCheckpoint),
      composerMode: "repair-selected-node-from-after-checkpoint",
    });

    expect(state.composerMode).toBe("repair-selected-node-from-after-checkpoint");
    expect(state.canCreateRepair).toBe(true);
    expect(state.repairPayload).toMatchObject({ checkpointId: "checkpoint-after-implementation" });
  });

  it("keeps node actions available when durable fault audit is excluded from projection events", () => {
    const flowProjection = projection(
      checkpoint("checkpoint-before-implementation", "lane-implementation", "before", "base-sha"),
    );
    const state = buildSelectedNodeActionState({
      sessionId,
      selectedNode,
      projection: {
        ...flowProjection,
        auditEvents: [
          rawEvent("workflow.run.recovery_failed", { status: "failed" }),
          rawEvent("workflow.run.start_reconciliation_failed", { status: "failed" }),
          rawEvent("workflow.node.checkpoint_failed", { status: "failed" }),
        ],
      },
      composerMode: "variant-from-before-checkpoint",
    });

    expect(state.composerMode).toBe("variant-from-before-checkpoint");
    expect(state.canCreateVariant).toBe(true);
    expect(state.variantPayload).not.toBeNull();
  });

  it("fails closed when the projection belongs to another session", () => {
    const state = buildSelectedNodeActionState({
      sessionId,
      selectedNode,
      projection: {
        ...projection(checkpoint("checkpoint-before-implementation", "lane-implementation", "before", "base-sha")),
        sessionId: "session-2",
      },
      composerMode: "variant-from-before-checkpoint",
    });

    expect(state.composerMode).toBe("global");
    expect(state.canRollback).toBe(false);
    expect(state.canCreateRepair).toBe(false);
    expect(state.canCreateVariant).toBe(false);
    expect(state.blockedReasons).toContain("Selected node is stale or malformed.");
    expect(state.rollbackPayload).toBeNull();
    expect(state.repairPayload).toBeNull();
    expect(state.variantPayload).toBeNull();
  });

  it("ignores selected-node checkpoints from another session", () => {
    const state = buildSelectedNodeActionState({
      sessionId,
      selectedNode,
      projection: projection(
        checkpoint("checkpoint-before-implementation", "lane-implementation", "before", "base-sha", "session-2"),
      ),
      composerMode: "variant-from-before-checkpoint",
    });

    expect(state.composerMode).toBe("global");
    expect(state.checkpoints.hasBefore).toBe(false);
    expect(state.canRollback).toBe(false);
    expect(state.canCreateVariant).toBe(false);
    expect(state.rollbackPayload).toBeNull();
    expect(state.variantPayload).toBeNull();
  });

  it("fails closed when direct projection events mix remote side-effect sessions", () => {
    const state = buildSelectedNodeActionState({
      sessionId,
      selectedNode,
      projection: projection(
        checkpoint("checkpoint-before-implementation", "lane-implementation", "before", "base-sha"),
        event("workflow.remote_side_effect.requested", {
          operationId: "remote-push-1",
          eventKind: "workflow.delivery.pushed",
          laneId: "lane-implementation",
          affectedLaneIds: ["lane-implementation"],
        }),
        eventForSession("session-2", "workflow.remote_side_effect.completed", {
          operationId: "remote-push-1",
          status: "succeeded",
        }),
      ),
      composerMode: "rollback-selected-node-and-downstream",
    });

    expect(state.composerMode).toBe("global");
    expect(state.canRollback).toBe(false);
    expect(state.rollbackPayload).toBeNull();
    expect(state.blockedReasons).toContain("Selected node is stale or malformed.");
  });

  it("disables rollback when a downstream lane created a pull request", () => {
    const state = buildSelectedNodeActionState({
      sessionId,
      selectedNode,
      projection: projection(
        checkpoint("checkpoint-before-implementation", "lane-implementation", "before", "base-sha"),
        event("workflow.pull_request.created", {
          laneId: "lane-review",
          evidence: { number: 42, url: "https://example.test/pull/42", headSha: "remote-sha" },
        }),
      ),
    });

    expect(state.canRollback).toBe(false);
    expect(state.blockedByRemoteSideEffect).toBe(true);
    expect(state.remoteSideEffects.map((item) => item.eventKind)).toEqual(["workflow.pull_request.created"]);
    expect(state.rollbackPayload).toBeNull();
  });

  it("disables rollback when the selected node pushed a branch", () => {
    const state = buildSelectedNodeActionState({
      sessionId,
      selectedNode,
      projection: projection(
        checkpoint("checkpoint-before-implementation", "lane-implementation", "before", "base-sha"),
        event("workflow.delivery.pushed", {
          laneId: "lane-implementation",
          evidence: { remote: "origin", branch: "feature/node-action-state-helpers", commitSha: "remote-sha" },
        }),
      ),
    });

    expect(state.canRollback).toBe(false);
    expect(state.blockedByRemoteSideEffect).toBe(true);
    expect(state.remoteSideEffects.map((item) => item.eventKind)).toEqual(["workflow.delivery.pushed"]);
    expect(state.rollbackPayload).toBeNull();
  });

  it.each([
    [
      "workflow.pull_request.merged",
      {
        targetLaneId: "lane-review",
        mergeCommitSha: "merge-sha",
      },
    ],
    [
      "workflow.delivery.main_synced",
      {
        affectedLaneIds: ["lane-review"],
        headSha: "main-sha",
      },
    ],
  ] as const)("disables rollback when a downstream lane records %s", (kind, payload) => {
    const state = buildSelectedNodeActionState({
      sessionId,
      selectedNode,
      projection: projection(
        checkpoint("checkpoint-before-implementation", "lane-implementation", "before", "base-sha"),
        event(kind, payload),
      ),
    });

    expect(state.canRollback).toBe(false);
    expect(state.blockedByRemoteSideEffect).toBe(true);
    expect(state.remoteSideEffects.map((item) => item.eventKind)).toEqual([kind]);
    expect(state.rollbackPayload).toBeNull();
  });

  it("disables rollback when main sync records no lane scope", () => {
    const state = buildSelectedNodeActionState({
      sessionId,
      selectedNode,
      projection: projection(
        checkpoint("checkpoint-before-implementation", "lane-implementation", "before", "base-sha"),
        event("workflow.delivery.main_synced", { headSha: "main-sha" }),
      ),
    });

    expect(state.canRollback).toBe(false);
    expect(state.blockedByRemoteSideEffect).toBe(true);
    expect(state.remoteSideEffects).toEqual([
      expect.objectContaining({
        eventKind: "workflow.delivery.main_synced",
        sessionWide: true,
      }),
    ]);
    expect(state.rollbackPayload).toBeNull();
  });

  it("keeps rollback available when the selected node only has a local commit", () => {
    const state = buildSelectedNodeActionState({
      sessionId,
      selectedNode,
      projection: projection(
        checkpoint("checkpoint-before-implementation", "lane-implementation", "before", "base-sha"),
        event("workflow.commit.created", {
          laneId: "lane-implementation",
          delivery: { commitSha: "local-sha", branch: "feature/node-action-state-helpers" },
        }),
      ),
      composerMode: "rollback-selected-node-and-downstream",
    });

    expect(state.composerMode).toBe("rollback-selected-node-and-downstream");
    expect(state.blockedByRemoteSideEffect).toBe(false);
    expect(state.needsBackendCheck).toBe(false);
    expect(state.canRollback).toBe(true);
    expect(state.rollbackPayload).toMatchObject({
      sessionId,
      nodeId: "lane-implementation",
      laneId: "lane-implementation",
      checkpointId: "checkpoint-before-implementation",
    });
  });

  it("surfaces backend caution for local commit rollback safety without marking it remote-blocked", () => {
    const state = buildSelectedNodeActionState({
      sessionId,
      selectedNode,
      projection: projection(
        checkpoint("checkpoint-before-implementation", "lane-implementation", "before", "base-sha"),
        event("workflow.commit.created", {
          laneId: "lane-implementation",
          delivery: { commitSha: "local-sha", branch: "feature/node-action-state-helpers" },
        }),
      ),
      backendEligibility: {
        eligible: false,
        localRollbackSafe: false,
        reason: "Local rollback requires backend manual repair.",
      },
    });

    expect(state.blockedByRemoteSideEffect).toBe(false);
    expect(state.needsBackendCheck).toBe(true);
    expect(state.canRollback).toBe(false);
    expect(state.blockedReasons).toContain("Local rollback requires backend manual repair.");
  });

  it("uses backend blocking remote side effects as definitive rollback blocks", () => {
    const state = buildSelectedNodeActionState({
      sessionId,
      selectedNode,
      projection: projection(checkpoint("checkpoint-before-implementation", "lane-implementation", "before", "base-sha")),
      backendEligibility: {
        eligibility: {
          eligible: false,
          targetLaneId: "lane-implementation",
          checkpointId: "checkpoint-before-implementation",
          affectedLaneIds: ["lane-implementation"],
          blockingRemoteSideEffects: [
            {
              eventKind: "workflow.delivery.pushed",
              eventId: "remote-side-effect-requested-1",
              laneId: "lane-implementation",
              affectedLaneIds: ["lane-implementation"],
            },
          ],
          localRollbackSafe: true,
          reason: "Remote side effects exist.",
        },
      },
    });

    expect(state.blockedByRemoteSideEffect).toBe(true);
    expect(state.needsBackendCheck).toBe(false);
    expect(state.canRollback).toBe(false);
    expect(state.remoteSideEffects).toEqual([
      expect.objectContaining({
        eventKind: "workflow.delivery.pushed",
        eventId: "remote-side-effect-requested-1",
        laneId: "lane-implementation",
      }),
    ]);
    expect(state.blockedReasons).toContain("Remote side effects exist.");
    expect(state.rollbackPayload).toBeNull();
  });

  it("fails closed for stale or malformed selected-node payloads", () => {
    const state = buildSelectedNodeActionState({
      sessionId,
      selectedNode: { id: "missing-lane" },
      projection: projection(checkpoint("checkpoint-before-implementation", "lane-implementation", "before", "base-sha")),
    });

    expect(state.composerMode).toBe("global");
    expect(state.canRollback).toBe(false);
    expect(state.canCreateRepair).toBe(false);
    expect(state.canCreateVariant).toBe(false);
    expect(state.blockedReasons).toContain("Selected node is stale or malformed.");
    expect(state.rollbackPayload).toBeNull();
    expect(state.repairPayload).toBeNull();
    expect(state.variantPayload).toBeNull();
  });

  it("fails closed for malformed projection events passed directly", () => {
    const state = buildSelectedNodeActionState({
      sessionId,
      selectedNode,
      projection: {
        ...projection(checkpoint("checkpoint-before-implementation", "lane-implementation", "before", "base-sha")),
        events: [
          ...workflowEvents(checkpoint("checkpoint-before-implementation", "lane-implementation", "before", "base-sha")),
          rawEvent("workflow.delivery.pushedd", {
            laneId: "lane-implementation",
            evidence: { remote: "origin", branch: "feature/node-action-state-helpers", commitSha: "remote-sha" },
          }),
        ],
      },
      composerMode: "rollback-selected-node-and-downstream",
    });

    expect(state.composerMode).toBe("global");
    expect(state.canRollback).toBe(false);
    expect(state.canCreateRepair).toBe(false);
    expect(state.canCreateVariant).toBe(false);
    expect(state.rollbackPayload).toBeNull();
    expect(state.repairPayload).toBeNull();
    expect(state.variantPayload).toBeNull();
  });

  it("fails closed for malformed projection checkpoints passed directly", () => {
    const validProjection = projection(
      checkpoint("checkpoint-before-implementation", "lane-implementation", "before", "base-sha"),
    );
    const state = buildSelectedNodeActionState({
      sessionId,
      selectedNode,
      projection: {
        ...validProjection,
        checkpoints: validProjection.checkpoints.map((item) => ({
          ...item,
          source: "unknown",
        })),
      },
      composerMode: "variant-from-before-checkpoint",
    });

    expect(state.composerMode).toBe("global");
    expect(state.canRollback).toBe(false);
    expect(state.canCreateRepair).toBe(false);
    expect(state.canCreateVariant).toBe(false);
    expect(state.rollbackPayload).toBeNull();
    expect(state.repairPayload).toBeNull();
    expect(state.variantPayload).toBeNull();
  });

  it("fails closed for malformed rollback intents passed directly", () => {
    const state = buildSelectedNodeActionState({
      sessionId,
      selectedNode,
      projection: {
        ...projection(checkpoint("checkpoint-before-implementation", "lane-implementation", "before", "base-sha")),
        rollbackIntents: [null],
      },
      composerMode: "rollback-selected-node-and-downstream",
    });

    expect(state.composerMode).toBe("global");
    expect(state.canRollback).toBe(false);
    expect(state.canCreateRepair).toBe(false);
    expect(state.canCreateVariant).toBe(false);
    expect(state.rollbackPayload).toBeNull();
    expect(state.repairPayload).toBeNull();
    expect(state.variantPayload).toBeNull();
    expect(state.blockedReasons).toContain("Selected node is stale or malformed.");
  });
});

describe("hydrateSelectedNodeActionStateFromEvents", () => {
  it("hydrates valid workflow events into selected-node action state", () => {
    const state = hydrateSelectedNodeActionStateFromEvents({
      sessionId,
      selectedNode,
      events: workflowEvents(checkpoint("checkpoint-before-implementation", "lane-implementation", "before", "base-sha")),
      composerMode: "rollback-selected-node-and-downstream",
    });

    expect(state.composerMode).toBe("rollback-selected-node-and-downstream");
    expect(state.canRollback).toBe(true);
    expect(state.canCreateVariant).toBe(true);
    expect(state.checkpoints.beforeCheckpointId).toBe("checkpoint-before-implementation");
    expect(state.rollbackPayload).toMatchObject({
      sessionId,
      nodeId: "lane-implementation",
      laneId: "lane-implementation",
      checkpointId: "checkpoint-before-implementation",
    });
  });

  it("fails closed for malformed remote side-effect request payloads", () => {
    const state = hydrateSelectedNodeActionStateFromEvents({
      sessionId,
      selectedNode,
      events: workflowEvents(
        checkpoint("checkpoint-before-implementation", "lane-implementation", "before", "base-sha"),
        event("workflow.remote_side_effect.requested", {
          operationId: "remote-push-1",
          eventKind: "workflow.delivery.pushed",
        }),
      ),
      composerMode: "rollback-selected-node-and-downstream",
    });

    expect(state.composerMode).toBe("global");
    expect(state.canRollback).toBe(false);
    expect(state.canCreateVariant).toBe(false);
    expect(state.rollbackPayload).toBeNull();
    expect(state.blockedReasons).toContain("Workflow events are stale or malformed.");
  });

  it("fails closed when a successful remote side-effect completion has no concrete remote event", () => {
    const state = hydrateSelectedNodeActionStateFromEvents({
      sessionId,
      selectedNode,
      events: workflowEvents(
        checkpoint("checkpoint-before-implementation", "lane-implementation", "before", "base-sha"),
        event("workflow.remote_side_effect.requested", {
          operationId: "remote-push-1",
          eventKind: "workflow.delivery.pushed",
          laneId: "lane-implementation",
          affectedLaneIds: ["lane-implementation"],
        }),
        event("workflow.remote_side_effect.completed", {
          operationId: "remote-push-1",
          status: "succeeded",
        }),
      ),
      composerMode: "rollback-selected-node-and-downstream",
    });

    expect(state.composerMode).toBe("global");
    expect(state.canRollback).toBe(false);
    expect(state.canCreateVariant).toBe(false);
    expect(state.blockedByRemoteSideEffect).toBe(false);
    expect(state.remoteSideEffects).toEqual([]);
    expect(state.rollbackPayload).toBeNull();
    expect(state.blockedReasons).toContain("Workflow events are stale or malformed.");
  });

  it("keeps rollback blocked when a successful remote completion has a matching concrete event", () => {
    const state = hydrateSelectedNodeActionStateFromEvents({
      sessionId,
      selectedNode,
      events: workflowEvents(
        checkpoint("checkpoint-before-implementation", "lane-implementation", "before", "base-sha"),
        event("workflow.remote_side_effect.requested", {
          operationId: "remote-push-1",
          eventKind: "workflow.delivery.pushed",
          laneId: "lane-implementation",
          affectedLaneIds: ["lane-implementation"],
        }),
        event("workflow.remote_side_effect.completed", {
          operationId: "remote-push-1",
          status: "succeeded",
        }),
        event("workflow.delivery.pushed", {
          laneId: "lane-implementation",
          evidence: { remote: "origin", branch: "feature/node-action-state-helpers", commitSha: "remote-sha" },
        }),
      ),
      composerMode: "rollback-selected-node-and-downstream",
    });

    expect(state.composerMode).toBe("global");
    expect(state.canRollback).toBe(false);
    expect(state.canCreateVariant).toBe(true);
    expect(state.blockedByRemoteSideEffect).toBe(true);
    expect(state.remoteSideEffects).toEqual([
      expect.objectContaining({
        eventKind: "workflow.delivery.pushed",
        laneId: "lane-implementation",
      }),
    ]);
    expect(state.rollbackPayload).toBeNull();
  });

  it("disables rollback when a downstream lane pushed a branch", () => {
    const state = hydrateSelectedNodeActionStateFromEvents({
      sessionId,
      selectedNode,
      events: workflowEvents(
        checkpoint("checkpoint-before-implementation", "lane-implementation", "before", "base-sha"),
        event("workflow.delivery.pushed", {
          laneId: "lane-review",
          evidence: { remote: "origin", branch: "feature/node-action-state-helpers", commitSha: "remote-sha" },
        }),
      ),
      composerMode: "rollback-selected-node-and-downstream",
    });

    expect(state.composerMode).toBe("global");
    expect(state.canRollback).toBe(false);
    expect(state.blockedByRemoteSideEffect).toBe(true);
    expect(state.remoteSideEffects).toEqual([
      expect.objectContaining({
        eventKind: "workflow.delivery.pushed",
        laneId: "lane-review",
      }),
    ]);
    expect(state.rollbackPayload).toBeNull();
  });

  it("fails closed when hydrated events mix remote side-effect sessions", () => {
    const state = hydrateSelectedNodeActionStateFromEvents({
      sessionId,
      selectedNode,
      events: workflowEvents(
        checkpoint("checkpoint-before-implementation", "lane-implementation", "before", "base-sha"),
        event("workflow.remote_side_effect.requested", {
          operationId: "remote-push-1",
          eventKind: "workflow.delivery.pushed",
          laneId: "lane-implementation",
          affectedLaneIds: ["lane-implementation"],
        }),
        eventForSession("session-2", "workflow.remote_side_effect.completed", {
          operationId: "remote-push-1",
          status: "succeeded",
        }),
      ),
      composerMode: "rollback-selected-node-and-downstream",
    });

    expect(state.composerMode).toBe("global");
    expect(state.canRollback).toBe(false);
    expect(state.rollbackPayload).toBeNull();
    expect(state.blockedReasons).toContain("Workflow events are stale or malformed.");
  });

  it("hydrates main sync without lane scope as a session-wide remote block", () => {
    const state = hydrateSelectedNodeActionStateFromEvents({
      sessionId,
      selectedNode,
      events: workflowEvents(
        checkpoint("checkpoint-before-implementation", "lane-implementation", "before", "base-sha"),
        event("workflow.delivery.main_synced", { headSha: "main-sha" }),
      ),
      composerMode: "rollback-selected-node-and-downstream",
    });

    expect(state.composerMode).toBe("global");
    expect(state.canRollback).toBe(false);
    expect(state.blockedByRemoteSideEffect).toBe(true);
    expect(state.remoteSideEffects).toEqual([
      expect.objectContaining({
        eventKind: "workflow.delivery.main_synced",
        sessionWide: true,
      }),
    ]);
    expect(state.rollbackPayload).toBeNull();
  });

  it("fails closed for unknown workflow event kinds", () => {
    const state = hydrateSelectedNodeActionStateFromEvents({
      sessionId,
      selectedNode,
      events: workflowEvents(
        checkpoint("checkpoint-before-implementation", "lane-implementation", "before", "base-sha"),
        rawEvent("workflow.delivery.pushedd", {
          laneId: "lane-implementation",
          evidence: { remote: "origin", branch: "feature/node-action-state-helpers", commitSha: "remote-sha" },
        }),
      ),
      composerMode: "rollback-selected-node-and-downstream",
    });

    expect(state.composerMode).toBe("global");
    expect(state.canRollback).toBe(false);
    expect(state.canCreateVariant).toBe(false);
    expect(state.rollbackPayload).toBeNull();
    expect(state.blockedReasons).toContain("Workflow events are stale or malformed.");
  });

  it("fails closed for malformed workflow event payloads", () => {
    const state = hydrateSelectedNodeActionStateFromEvents({
      sessionId,
      selectedNode,
      events: [
        event("workflow.user_input", { text: "Build the feature." }),
        event("workflow.lane.declared", { lane: "lane-implementation" }),
        event("workflow.node.checkpoint_recorded", {
          checkpoint: {
            id: "checkpoint-before-implementation",
            sessionId,
            nodeId: "lane-implementation",
            phase: "before",
          },
        }),
      ],
      composerMode: "rollback-selected-node-and-downstream",
    });

    expect(state.composerMode).toBe("global");
    expect(state.canRollback).toBe(false);
    expect(state.canCreateRepair).toBe(false);
    expect(state.canCreateVariant).toBe(false);
    expect(state.rollbackPayload).toBeNull();
    expect(state.repairPayload).toBeNull();
    expect(state.variantPayload).toBeNull();
  });

  it("fails closed for non-array workflow events", () => {
    const state = hydrateSelectedNodeActionStateFromEvents({
      sessionId,
      selectedNode,
      events: null as unknown as readonly unknown[],
      composerMode: "rollback-selected-node-and-downstream",
    });

    expect(state.composerMode).toBe("global");
    expect(state.canRollback).toBe(false);
    expect(state.canCreateRepair).toBe(false);
    expect(state.canCreateVariant).toBe(false);
    expect(state.rollbackPayload).toBeNull();
    expect(state.repairPayload).toBeNull();
    expect(state.variantPayload).toBeNull();
    expect(state.blockedReasons).toContain("Workflow events are stale or malformed.");
  });
});

describe("backend rollback eligibility hydration", () => {
  it("forces a backend check for malformed blocking remote side effects", () => {
    const state = buildSelectedNodeActionState({
      sessionId,
      selectedNode,
      projection: projection(checkpoint("checkpoint-before-implementation", "lane-implementation", "before", "base-sha")),
      backendEligibility: {
        eligibility: {
          eligible: true,
          targetLaneId: "lane-implementation",
          checkpointId: "checkpoint-before-implementation",
          affectedLaneIds: ["lane-implementation"],
          blockingRemoteSideEffects: [
            {
              eventKind: "workflow.delivery.pushed",
              laneId: "lane-implementation",
              affectedLaneIds: ["lane-implementation"],
            },
          ],
          localRollbackSafe: true,
        },
      },
      composerMode: "rollback-selected-node-and-downstream",
    });

    expect(state.composerMode).toBe("global");
    expect(state.needsBackendCheck).toBe(true);
    expect(state.canRollback).toBe(false);
    expect(state.rollbackPayload).toBeNull();
    expect(state.blockedReasons).toContain("Backend rollback eligibility is stale or malformed.");
  });
});

function projection(...events: FlowEvent[]): FlowProjection {
  return reduceWorkflowEvents(workflowEvents(...events));
}

function workflowEvents(...events: FlowEvent[]): FlowEvent[] {
  return [
    event("workflow.user_input", { text: "Build the feature." }),
    event("workflow.lane.declared", { lane: lane("lane-implementation") }),
    event("workflow.lane.declared", { lane: lane("lane-review", "review") }),
    event("workflow.edge.declared", {
      edge: { id: "edge-implementation-review", sourceLaneId: "lane-implementation", targetLaneId: "lane-review" },
    }),
    ...events,
  ];
}

function lane(id: string, laneKind: "implementation" | "review" = "implementation"): Record<string, unknown> {
  return {
    id,
    semanticKey: id,
    kind: laneKind,
    laneKind,
    semanticSubtype: laneKind === "review" ? "review" : "code",
    title: id,
    agentKind: "codex",
    executable: true,
    runtimePolicy: {
      source: "workflow_projection",
      trusted: true,
      executable: true,
      sandbox: "workspace-write",
      sideEffects: ["filesystem", "git"],
      reason: "test lane",
    },
  };
}

function checkpoint(
  id: string,
  laneId: string,
  phase: "before" | "after",
  headCommit: string,
  checkpointSessionId = sessionId,
  worktreeState: "clean" | "dirty" = "clean",
): FlowEvent {
  const runId = `run-${laneId}`;
  const segmentId = `segment-${laneId}`;
  return event("workflow.node.checkpoint_recorded", {
    checkpoint: {
      id,
      sessionId: checkpointSessionId,
      nodeId: laneId,
      laneId,
      phase,
      executionTarget: "new_worktree",
      runId,
      segmentId,
      worktreeState,
      headCommit,
      createdAt: "2026-06-23T00:00:00.000Z",
      source: "agent_bridge",
      evidenceRefs: [
        { kind: "run", id: runId },
        { kind: "segment", id: segmentId },
        ...(phase === "after" ? [{ kind: "evidence", id: `evidence-${segmentId}` }] : []),
      ],
    },
  });
}

function terminalRunEvents(
  laneId: string,
  status: "succeeded" | "failed" | "cancelled" | "timed-out",
): FlowEvent[] {
  const runId = `run-${laneId}`;
  const segmentId = `segment-${laneId}`;
  return [
    event("workflow.segment.started", {
      segment: { id: segmentId, laneId, runId, status: "running", exitCode: null },
    }),
    event("workflow.evidence.recorded", {
      laneId,
      segmentId,
      evidence: {
        id: `evidence-${segmentId}`,
        laneId,
        segmentId,
        kind: "run",
        status: status === "succeeded" ? "passed" : "failed",
        checks: [],
        artifacts: [],
        runEvidence: {
          runId,
          status,
          exitCode: status === "succeeded" ? 0 : 1,
          changesetId: null,
          checks: [],
          artifacts: [],
          review: null,
          errorReason: status === "failed" ? "failed" : null,
          cancelReason: status === "cancelled" ? "cancelled" : null,
          completedAt: "2026-06-23T00:00:01.000Z",
        },
      },
    }),
    event("workflow.segment.finished", {
      laneId,
      segmentId,
      status,
      exitCode: status === "succeeded" ? 0 : 1,
    }),
  ];
}

function node(id: string): CanvasNode {
  return {
    id,
    title: id,
    agent: "codex",
    progress: "",
    status: "completed",
    position: { x: 0, y: 0 },
    runId: `run-${id}`,
    changesetId: `changeset-${id}`,
    output: [],
    worktree: { path: ".", branchName: `skyturn/${sessionId}/${id}`, baseCommit: "base-sha" },
    context: {
      brief: id,
      sessionGoal: "Build the feature.",
      relatedRequirements: "",
      relatedDesign: "",
      relatedTasks: id,
      dependencies: [],
      constraints: [],
    },
  };
}

function event(kind: FlowEvent["kind"], payload: Record<string, unknown>): FlowEvent {
  return eventForSession(sessionId, kind, payload);
}

function eventForSession(
  eventSessionId: string,
  kind: FlowEvent["kind"],
  payload: Record<string, unknown>,
): FlowEvent {
  eventSeq += 1;
  return {
    id: `${kind}-${eventSeq}`,
    sessionId: eventSessionId,
    seq: eventSeq,
    kind,
    source: "test",
    payload,
    createdAt: "2026-06-23T00:00:00.000Z",
    idempotencyKey: null,
  };
}

function rawEvent(kind: string, payload: Record<string, unknown>): FlowEvent {
  return event(kind as FlowEvent["kind"], payload);
}
