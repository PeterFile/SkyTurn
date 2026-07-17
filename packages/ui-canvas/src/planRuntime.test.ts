import { describe, expect, it } from "vitest";

import {
  parsePlanBootstrapSession,
  type PlanEvent,
  type PlanSession,
  type PlanStage,
  type PlanStageState,
  type PlanStateSnapshot,
} from "@skyturn/project-core";
import { normalizeWorkspaceState, type WorkspaceState } from "@skyturn/persistence";
import * as planRuntime from "./planRuntime.js";
import {
  acceptPlanStage,
  applyPlanEvent,
  applyPlanRunStartFailure,
  bindPlanRunStart,
  canFinishPlan,
  canStartPlanRequest,
  createInMemoryPlanAdapter,
  createPlanMutationQueue,
  editPlanStage,
  initialPlanRuntimeRecovery,
  loadPlanRuntimeState,
  PLAN_RUNTIME_BUSY_ERROR,
  PLAN_RUNTIME_STATE_ERROR,
  planRuntimeRecoveryReducer,
  reconcilePlanRuntimeState,
  undoPlanStage,
} from "./planRuntime.js";

const baseSession: PlanSession = {
  id: "plan-1",
  projectId: "project-1",
  title: "Plan",
  goal: "Build staged Plan mode",
  mode: "plan",
  kind: "plan",
  target: { executionTarget: "current_branch", selectedBranch: "main" },
  createdAt: "2026-07-16T00:00:00.000Z",
  updatedAt: "2026-07-16T00:00:00.000Z",
  plan: { requirements: "# Requirements\n\nOld.", design: "", tasks: "" },
  stateVersion: 0,
  activeStage: "requirements",
  plannerConversationId: "hermes-plan-plan-1",
  conversationStarted: false,
  stages: {
    requirements: {
      status: "ready",
      accepted: false,
      draft: "",
      error: null,
      runId: null,
      operation: null,
      checkpoints: [],
    },
    design: {
      status: "pending",
      accepted: false,
      draft: "",
      error: null,
      runId: null,
      operation: null,
      checkpoints: [],
    },
    tasks: {
      status: "pending",
      accepted: false,
      draft: "",
      error: null,
      runId: null,
      operation: null,
      checkpoints: [],
    },
  },
  nodes: [],
  edges: [],
  activeNodeId: null,
};

const emptyCheckpoints = { requirements: [], design: [], tasks: [] } as const;

describe("Plan renderer state", () => {
  it("streams into a draft without changing canonical Markdown", () => {
    const started = applyPlanEvent(baseSession, {
      protocolVersion: 1,
      planSessionId: "plan-1",
      runId: "run-1",
      stage: "requirements",
      operation: "generate",
      kind: "started",
    });
    const streamed = applyPlanEvent(started, {
      protocolVersion: 1,
      planSessionId: "plan-1",
      runId: "run-1",
      stage: "requirements",
      operation: "generate",
      kind: "delta",
      text: "# Requirements\n\nNew.",
    });

    expect(streamed.plan.requirements).toBe("# Requirements\n\nOld.");
    expect(streamed.stages.requirements).toMatchObject({
      status: "generating",
      draft: "# Requirements\n\nNew.",
      runId: "run-1",
    });
  });

  it("commits only successful output and checkpoints the previous revision", () => {
    const revising = applyPlanEvent(baseSession, {
      protocolVersion: 1,
      planSessionId: "plan-1",
      runId: "run-2",
      stage: "requirements",
      operation: "revise",
      kind: "started",
    });
    const completed = applyPlanEvent(revising, {
      protocolVersion: 1,
      planSessionId: "plan-1",
      runId: "run-2",
      stage: "requirements",
      operation: "revise",
      kind: "completed",
      markdown: "# Requirements\n\nRevised.",
      checkpoints: { requirements: ["# Requirements\n\nOld."], design: [], tasks: [] },
      snapshot: snapshotFor(1, "# Requirements\n\nRevised.", {
        requirements: ["# Requirements\n\nOld."], design: [], tasks: [],
      }),
    });

    expect(completed.plan.requirements).toContain("Revised");
    expect(completed.stages.requirements.checkpoints).toEqual(["# Requirements\n\nOld."]);
    expect(completed.stages.requirements).toMatchObject({ lastRunId: "run-2" });
    expect(completed.stages.design.status).toBe("pending");
  });

  it("preserves canonical Markdown and adds no checkpoint on failure", () => {
    const revising = applyPlanEvent(baseSession, {
      protocolVersion: 1,
      planSessionId: "plan-1",
      runId: "run-3",
      stage: "requirements",
      operation: "revise",
      kind: "started",
    });
    const failed = applyPlanEvent(revising, {
      protocolVersion: 1,
      planSessionId: "plan-1",
      runId: "run-3",
      stage: "requirements",
      operation: "revise",
      kind: "failed",
      error: "Hermes ACP prompt failed.",
      checkpoints: emptyCheckpoints,
      snapshot: snapshotFor(0, "# Requirements\n\nOld."),
    });

    expect(failed.plan.requirements).toContain("Old");
    expect(failed.stages.requirements).toMatchObject({
      status: "failed",
      draft: "",
      error: "Hermes ACP prompt failed.",
      operation: "revise",
      checkpoints: [],
    });
  });

  it.each(["requirements", "design"] as const)(
    "preserves the accepted chain when a %s revision is rejected before start",
    (stage) => {
      const accepted = acceptedPlanChain();
      const before = planMaterial(accepted);

      const failed = applyPlanRunStartFailure(
        accepted,
        stage,
        "revise",
        new Error("Plan preflight rejected the request."),
      );

      expect(planMaterial(failed)).toEqual(before);
      expect(failed.stages[stage]).toMatchObject({
        status: "failed",
        accepted: true,
        draft: "",
        error: "Plan generation could not start. Retry to continue.",
        runId: null,
        operation: "revise",
      });
      const reopened = expectStrictWorkspaceRoundTrip(failed);
      expect(planMaterial(reopened)).toEqual(before);
      expect(reopened.stages[stage].status === "failed" && reopened.stages[stage].operation === "revise").toBe(true);
    },
  );

  it("keeps generate rejection unaccepted without changing valid pending downstream state", () => {
    const pending = pendingPlanSession();
    const downstream = {
      design: pending.stages.design,
      tasks: pending.stages.tasks,
    };

    const failed = applyPlanRunStartFailure(
      pending,
      "requirements",
      "generate",
      new Error("Plan preflight rejected the request."),
    );

    expect(failed.stages.requirements).toMatchObject({
      status: "failed",
      accepted: false,
      draft: "",
      error: "Plan generation could not start. Retry to continue.",
      runId: null,
      operation: "generate",
    });
    expect({ design: failed.stages.design, tasks: failed.stages.tasks }).toEqual(downstream);
    expectStrictWorkspaceRoundTrip(failed);
  });

  it.each([
    PLAN_RUNTIME_BUSY_ERROR,
    "Error invoking remote method 'plan:generate': Error: Plan runtime is busy.",
    "Error invoking remote method 'plan:revise': Error: Plan runtime is busy.",
    "Error invoking remote method 'plan:updateStage': Error: Plan runtime is busy.",
  ])("recognizes the canonical or Electron-wrapped busy error %s", (message) => {
    expect(planRuntime.isPlanRuntimeBusyError(new Error(message))).toBe(true);
  });

  it.each([
    "Plan preflight failed because Plan runtime is busy. Retry later.",
    "Plan runtime is busy. Retry later.",
    "Unrelated error: Plan runtime is busy.",
    "Error invoking remote method 'plan:generate': Error: Plan runtime is busy. Retry later.",
    "Error invoking remote method 'plan:generate': Plan runtime is busy.",
  ])("does not treat a nearby non-busy error as canonical busy: %s", (message) => {
    expect(planRuntime.isPlanRuntimeBusyError(new Error(message))).toBe(false);
  });

  it("leaves the complete Plan session unchanged for an Electron-wrapped busy start failure", () => {
    const before = JSON.parse(JSON.stringify(baseSession)) as PlanSession;
    const result = applyPlanRunStartFailure(
      baseSession,
      "requirements",
      "revise",
      new Error("Error invoking remote method 'plan:revise': Error: Plan runtime is busy."),
    );

    expect(result).toBe(baseSession);
    expect(result).toEqual(before);
  });

  it.each(["requirements", "design"] as const)(
    "keeps %s revision active state strict while preserving downstream Markdown",
    (stage) => {
      const accepted = acceptedPlanChain();
      const before = planMaterial(accepted);
      const runId = `run-active-${stage}-revise`;

      const active = applyPlanEvent(accepted, {
        protocolVersion: 1,
        planSessionId: accepted.id,
        runId,
        stage,
        operation: "revise",
        kind: "started",
      });

      expect(active.plan).toEqual(before.plan);
      expect(active.stages[stage]).toMatchObject({
        status: "revising",
        accepted: false,
        runId,
        operation: "revise",
      });
      expectDownstreamPlanMaterialCleared(active, accepted, stage);
      expectStrictWorkspaceRoundTrip(active);
    },
  );

  it.each(["requirements", "design"] as const)(
    "keeps reachable %s generation active state strict without clearing documents",
    (stage) => {
      const session = generationReadyPlan(stage);
      const before = planMaterial(session);
      const runId = `run-active-${stage}-generate`;

      const active = bindPlanRunStart(session, {
        protocolVersion: 1,
        planSessionId: session.id,
        runId,
        stage,
        operation: "generate",
        duplicate: false,
      });

      expect(active.plan).toEqual(before.plan);
      expect(active.stages[stage]).toMatchObject({
        status: "generating",
        accepted: false,
        runId,
        operation: "generate",
      });
      expectDownstreamPlanMaterialCleared(active, session, stage);
      expectStrictWorkspaceRoundTrip(active);
    },
  );

  it.each(["requirements", "design"] as const)(
    "restores the exact accepted chain after an active %s revision fails",
    (stage) => {
      const accepted = acceptedPlanChain();
      const snapshot = snapshotFromSession(accepted);
      const runId = `run-failed-${stage}-revise`;
      const active = applyPlanEvent(accepted, {
        protocolVersion: 1,
        planSessionId: accepted.id,
        runId,
        stage,
        operation: "revise",
        kind: "started",
      });

      const failed = applyPlanEvent(active, {
        protocolVersion: 1,
        planSessionId: accepted.id,
        runId,
        stage,
        operation: "revise",
        kind: "failed",
        error: "Hermes ACP prompt failed.",
        checkpoints: snapshot.checkpoints,
        snapshot,
      });

      expect(planMaterial(failed)).toEqual(planMaterial(accepted));
      expect(failed.stages[stage]).toMatchObject({
        status: "failed",
        accepted: true,
        operation: "revise",
        error: "Hermes ACP prompt failed.",
        runId: null,
        lastRunId: runId,
      });
      expectStrictWorkspaceRoundTrip(failed);
    },
  );

  it.each(["requirements", "design"] as const)(
    "applies the exact authoritative snapshot after an active %s revision completes",
    (stage) => {
      const accepted = acceptedPlanChain();
      const runId = `run-completed-${stage}-revise`;
      const active = applyPlanEvent(accepted, {
        protocolVersion: 1,
        planSessionId: accepted.id,
        runId,
        stage,
        operation: "revise",
        kind: "started",
      });
      const snapshot = completedRevisionSnapshot(accepted, stage);

      const completed = applyPlanEvent(active, {
        protocolVersion: 1,
        planSessionId: accepted.id,
        runId,
        stage,
        operation: "revise",
        kind: "completed",
        markdown: snapshot.plan[stage],
        checkpoints: snapshot.checkpoints,
        snapshot,
      });

      expect(planMaterial(completed)).toEqual({
        plan: snapshot.plan,
        accepted: snapshot.accepted,
        checkpoints: snapshot.checkpoints,
      });
      expect(completed.stages[stage]).toMatchObject({
        status: "ready",
        accepted: false,
        runId: null,
        lastRunId: runId,
      });
      expectStrictWorkspaceRoundTrip(completed);
    },
  );

  it("clears downstream plan material during active runtime recovery", () => {
    const accepted = acceptedPlanChain();
    const snapshot = snapshotFromSession(accepted);

    const recovered = reconcilePlanRuntimeState(accepted, {
      protocolVersion: 1,
      needsBootstrap: false,
      snapshot,
      active: {
        planSessionId: accepted.id,
        runId: "run-recovered-requirements-revise",
        stage: "requirements",
        operation: "revise",
        conversationReady: true,
        draft: "# Requirements\n\nPartial revision.",
        checkpoints: snapshot.checkpoints,
      },
      terminal: null,
    });

    expect(recovered.plan).toEqual(accepted.plan);
    expect(recovered.stages.requirements).toMatchObject({
      status: "revising",
      accepted: false,
      draft: "# Requirements\n\nPartial revision.",
    });
    expectDownstreamPlanMaterialCleared(recovered, accepted, "requirements");
    expectStrictWorkspaceRoundTrip(recovered);
  });

  it("reopens a failed generate event through persistence and strict bootstrap for generate retry", async () => {
    const pending: PlanSession = {
      ...baseSession,
      plan: { requirements: "", design: "", tasks: "" },
      stages: {
        ...baseSession.stages,
        requirements: { ...baseSession.stages.requirements, status: "pending" },
      },
    };
    const terminal = {
      protocolVersion: 1 as const,
      planSessionId: pending.id,
      runId: "run-failed-generate",
      stage: "requirements" as const,
      operation: "generate" as const,
      kind: "failed" as const,
      error: "Hermes ACP prompt failed.",
      checkpoints: emptyCheckpoints,
      snapshot: snapshotFor(0, ""),
    };
    const failed = applyPlanEvent(applyPlanEvent(pending, {
      ...terminal,
      kind: "started",
    }), terminal);

    const { reopened, calls } = await reopenAndRetryFailedPlan(failed, terminal);

    expect(reopened.stages.requirements).toMatchObject({
      status: "failed",
      accepted: false,
      operation: "generate",
      error: terminal.error,
      lastRunId: terminal.runId,
    });
    expect(calls).toEqual(["update:generate", "generate"]);
  });

  it("reopens an accepted failed revision with its authoritative document for revise retry", async () => {
    const accepted: PlanSession = {
      ...baseSession,
      stateVersion: 4,
      plan: { requirements: "requirements-v4", design: "", tasks: "" },
      stages: {
        ...baseSession.stages,
        requirements: {
          ...baseSession.stages.requirements,
          accepted: true,
          checkpoints: ["requirements-v2", "requirements-v3"],
        },
      },
    };
    const snapshot = {
      version: 4,
      plan: { ...accepted.plan },
      accepted: { requirements: true, design: false, tasks: false },
      checkpoints: {
        requirements: ["requirements-v2", "requirements-v3"],
        design: [],
        tasks: [],
      },
    };
    const terminal = {
      protocolVersion: 1 as const,
      planSessionId: accepted.id,
      runId: "run-failed-revise",
      stage: "requirements" as const,
      operation: "revise" as const,
      kind: "failed" as const,
      error: "Hermes ACP prompt failed.",
      checkpoints: snapshot.checkpoints,
      snapshot,
    };
    const active = reconcilePlanRuntimeState(accepted, {
      protocolVersion: 1,
      needsBootstrap: false,
      snapshot,
      terminal: null,
      active: {
        planSessionId: accepted.id,
        runId: terminal.runId,
        stage: terminal.stage,
        operation: terminal.operation,
        conversationReady: true,
        draft: "requirements-v4\n\npartial revision",
        checkpoints: snapshot.checkpoints,
      },
    });
    const persistedActive = JSON.parse(JSON.stringify(active)) as PlanSession;
    const activeBootstrap = parsePlanBootstrapSession(persistedActive);
    const failed = applyPlanEvent(active, terminal);

    const { reopened, calls } = await reopenAndRetryFailedPlan(failed, terminal);

    expect(activeBootstrap.snapshot).toEqual({
      ...snapshot,
      accepted: { requirements: false, design: false, tasks: false },
    });
    expect(active.stages.requirements).toMatchObject({
      status: "revising",
      accepted: false,
      operation: "revise",
      runId: terminal.runId,
    });
    expect(reopened.stateVersion).toBe(snapshot.version);
    expect(reopened.plan).toEqual(snapshot.plan);
    expect(reopened.stages.requirements).toMatchObject({
      status: "failed",
      accepted: true,
      operation: "revise",
      error: terminal.error,
      lastRunId: terminal.runId,
      checkpoints: snapshot.checkpoints.requirements,
    });
    expect(calls).toEqual(["update:revise", "revise"]);
  });

  it("undoes one stage-local checkpoint in deterministic LIFO order", () => {
    const session: PlanSession = {
      ...baseSession,
      plan: { ...baseSession.plan, requirements: "third" },
      stages: {
        ...baseSession.stages,
        requirements: {
          ...baseSession.stages.requirements,
          checkpoints: ["first", "second"],
        },
      },
    };

    const undone = undoPlanStage(session, "requirements");
    expect(undone.plan.requirements).toBe("second");
    expect(undone.stages.requirements.checkpoints).toEqual(["first"]);
  });

  it("invalidates every downstream stage and checkpoint when Requirements is undone", () => {
    const session: PlanSession = {
      ...baseSession,
      plan: { requirements: "requirements-v2", design: "design-v2", tasks: "tasks-v2" },
      stages: {
        requirements: {
          ...baseSession.stages.requirements,
          checkpoints: ["requirements-v1"],
        },
        design: {
          ...baseSession.stages.design,
          status: "ready",
          accepted: true,
          checkpoints: ["design-v1"],
        },
        tasks: {
          ...baseSession.stages.tasks,
          status: "ready",
          accepted: true,
          checkpoints: ["tasks-v1"],
        },
      },
    };

    const undone = undoPlanStage(session, "requirements");

    expect(undone.plan).toEqual({ requirements: "requirements-v1", design: "", tasks: "" });
    expect(undone.stages.design).toMatchObject({ status: "pending", accepted: false, checkpoints: [] });
    expect(undone.stages.tasks).toMatchObject({ status: "pending", accepted: false, checkpoints: [] });
    expect(canFinishPlan(undone)).toBe(false);
    expect(undoPlanStage(undone, "design")).toBe(undone);
    expect(undoPlanStage(undone, "tasks")).toBe(undone);
  });

  it("clears stale Tasks content and checkpoints when Design is revised", () => {
    const session: PlanSession = {
      ...baseSession,
      plan: { requirements: "requirements", design: "design-v1", tasks: "tasks-v1" },
      stages: {
        ...baseSession.stages,
        design: { ...baseSession.stages.design, status: "revising", runId: "run-design", operation: "revise" },
        tasks: {
          ...baseSession.stages.tasks,
          status: "ready",
          accepted: true,
          checkpoints: ["tasks-v0"],
        },
      },
    };

    const revised = applyPlanEvent(session, {
      protocolVersion: 1,
      planSessionId: session.id,
      runId: "run-design",
      stage: "design",
      operation: "revise",
      kind: "completed",
      markdown: "design-v2",
      checkpoints: { requirements: [], design: ["design-v1"], tasks: [] },
      snapshot: {
        version: 1,
        plan: { requirements: "requirements", design: "design-v2", tasks: "" },
        accepted: { requirements: false, design: false, tasks: false },
        checkpoints: { requirements: [], design: ["design-v1"], tasks: [] },
      },
    });

    expect(revised.plan.tasks).toBe("");
    expect(revised.stages.tasks).toMatchObject({ status: "pending", accepted: false, checkpoints: [] });
    expect(undoPlanStage(revised, "tasks")).toBe(revised);
  });

  it("finishes only after every ready stage is accepted and no run is active", () => {
    const requirementsAccepted = acceptPlanStage(baseSession, "requirements");
    const allAccepted: PlanSession = {
      ...requirementsAccepted,
      plan: { requirements: "# Requirements", design: "# Design", tasks: "# Tasks" },
      stages: Object.fromEntries(
        Object.entries(requirementsAccepted.stages).map(([stage, state]) => [
          stage,
          { ...state, status: "ready", accepted: true },
        ]),
      ) as PlanSession["stages"],
    };

    expect(canFinishPlan(requirementsAccepted)).toBe(false);
    expect(canFinishPlan(allAccepted)).toBe(true);
  });

  it("keeps migrated legacy documents unapproved until every normal acceptance", () => {
    const migrated = reconcilePlanRuntimeState(baseSession, {
      protocolVersion: 1,
      needsBootstrap: false,
      snapshot: {
        version: 0,
        plan: {
          requirements: "# Requirements\n\nLegacy.",
          design: "# Design\n\nLegacy.",
          tasks: "# Tasks\n\n- [ ] Legacy.",
        },
        accepted: { requirements: false, design: false, tasks: false },
        checkpoints: { requirements: [], design: [], tasks: [] },
      },
      active: null,
      terminal: null,
    });

    expect(canFinishPlan(migrated)).toBe(false);
    const requirementsAccepted = acceptPlanStage(migrated, "requirements");
    expect(canFinishPlan(requirementsAccepted)).toBe(false);
    const designAccepted = acceptPlanStage(requirementsAccepted, "design");
    expect(canFinishPlan(designAccepted)).toBe(false);
    expect(canFinishPlan(acceptPlanStage(designAccepted, "tasks"))).toBe(true);
  });

  it("never accepts or finishes with whitespace-only canonical Markdown", () => {
    const session: PlanSession = {
      ...baseSession,
      plan: { requirements: "# Requirements", design: "# Design", tasks: " \n\t " },
      stages: Object.fromEntries(
        Object.entries(baseSession.stages).map(([stage, state]) => [
          stage,
          { ...state, status: "ready", accepted: stage !== "tasks" },
        ]),
      ) as PlanSession["stages"],
    };

    expect(acceptPlanStage(session, "tasks")).toBe(session);
    expect(canFinishPlan({
      ...session,
      stages: {
        ...session.stages,
        tasks: { ...session.stages.tasks, accepted: true },
      },
    })).toBe(false);
  });

  it("keeps the browser adapter deterministic and separate from desktop IPC", async () => {
    const events: Parameters<typeof applyPlanEvent>[1][] = [];
    const adapter = createInMemoryPlanAdapter((event) => events.push(event));

    await adapter.generate({
      operation: "generate",
      planSessionId: "plan-1",
      projectRoot: "/mock/project",
      stage: "requirements",
      goal: "Build staged Plan mode",
      expectedStateVersion: 0,
    });
    await Promise.resolve();

    expect(events.map((event) => event.kind)).toEqual([
      "started",
      "conversation_ready",
      "delta",
      "completed",
    ]);
    expect(events.at(-1)).toMatchObject({
      kind: "completed",
      markdown: "# Requirements\n\n## Goal\n\nBuild staged Plan mode",
    });
  });

  it("enforces the same authoritative versions and upstream gates in the browser adapter", async () => {
    const emptyAdapter = createInMemoryPlanAdapter(() => undefined);
    for (const stage of ["design", "tasks"] as const) {
      await expect(emptyAdapter.updateStage({
        planSessionId: `plan-browser-${stage}`,
        projectRoot: "/mock/project",
        stage,
        expectedStateVersion: 0,
        markdown: `${stage}-without-upstream`,
      })).rejects.toThrow("Plan state transition is invalid.");
    }

    const adapter = createInMemoryPlanAdapter(() => undefined);
    const base = {
      planSessionId: "plan-browser-gates",
      projectRoot: "/mock/project",
    };
    await adapter.generate({
      ...base,
      operation: "generate",
      stage: "requirements",
      goal: "Build staged Plan mode",
      expectedStateVersion: 0,
    });
    await Promise.resolve();

    await expect(adapter.generate({
      ...base,
      operation: "generate",
      stage: "design",
      goal: "Build staged Plan mode",
      expectedStateVersion: 1,
    })).rejects.toThrow("Plan state transition is invalid.");
    await expect(adapter.updateStage({
      ...base,
      stage: "requirements",
      expectedStateVersion: 0,
      markdown: "stale",
    })).rejects.toThrow("Plan state version conflict.");

    const accepted = await adapter.acceptStage({
      ...base,
      stage: "requirements",
      expectedStateVersion: 1,
    });
    expect(accepted.snapshot.accepted.requirements).toBe(true);
    await expect(adapter.generate({
      ...base,
      operation: "generate",
      stage: "design",
      goal: "Build staged Plan mode",
      expectedStateVersion: 2,
    })).resolves.toMatchObject({ stage: "design", operation: "generate" });
  });

  it("rejects generate for an accepted browser stage before creating a run", async () => {
    const events: PlanEvent[] = [];
    const adapter = createInMemoryPlanAdapter((event) => events.push(event));
    const identity = { planSessionId: "plan-browser-accepted", projectRoot: "/mock/project" };
    const edited = await adapter.updateStage({
      ...identity,
      stage: "requirements",
      expectedStateVersion: 0,
      markdown: "# Requirements\n\nAccepted.",
    });
    const accepted = await adapter.acceptStage({
      ...identity,
      stage: "requirements",
      expectedStateVersion: edited.snapshot.version,
    });
    const before = await adapter.getState(identity);

    await expect(adapter.generate({
      ...identity,
      operation: "generate",
      stage: "requirements",
      goal: "Do not replace accepted requirements.",
      expectedStateVersion: accepted.snapshot.version,
    })).rejects.toThrow(/^Plan state transition is invalid\.$/);

    expect(await adapter.getState(identity)).toEqual(before);
    expect(before).toMatchObject({
      active: null,
      terminal: null,
      snapshot: { accepted: { requirements: true } },
    });
    await expect(adapter.cancel({ ...identity, runId: "unreachable-run" })).resolves.toEqual({
      protocolVersion: 1,
      cancelled: false,
    });
    expect(events).toEqual([]);
  });

  it("aligns the browser adapter ledger before revising an Undo-selected checkpoint", async () => {
    const events: Parameters<typeof applyPlanEvent>[1][] = [];
    const adapter = createInMemoryPlanAdapter((event) => events.push(event));
    const request = {
      operation: "generate" as const,
      planSessionId: "plan-browser-history",
      projectRoot: "/mock/project",
      stage: "requirements" as const,
      goal: "Build staged Plan mode",
      expectedStateVersion: 0,
    };
    await adapter.generate(request);
    await Promise.resolve();
    const v0 = events.at(-1);
    expect(v0?.kind).toBe("completed");
    if (v0?.kind !== "completed") return;

    await adapter.revise({
      ...request,
      operation: "revise",
      expectedStateVersion: 1,
      instruction: "Create v1.",
    });
    await Promise.resolve();
    const v1 = events.at(-1);
    expect(v1?.kind).toBe("completed");
    if (v1?.kind !== "completed") return;

    await adapter.revise({
      ...request,
      operation: "revise",
      expectedStateVersion: 2,
      instruction: "Create v2.",
    });
    await Promise.resolve();
    await adapter.undoStage({
      planSessionId: request.planSessionId,
      projectRoot: request.projectRoot,
      stage: "requirements",
      expectedStateVersion: 3,
    });
    await adapter.revise({
      ...request,
      operation: "revise",
      expectedStateVersion: 4,
      instruction: "Create v1-prime from Undo.",
    });
    await Promise.resolve();

    const revised = events.at(-1);
    expect(revised?.kind).toBe("completed");
    if (revised?.kind !== "completed") return;
    expect(revised.checkpoints.requirements).toEqual([v0.markdown, v1.markdown]);
  });

  it("fails closed when a desktop bridge exists without a complete Plan API", async () => {
    const factory = Reflect.get(planRuntime, "createPlanAdapter") as undefined | ((
      bridge: unknown,
      emit: (event: Parameters<typeof applyPlanEvent>[1]) => void,
    ) => ReturnType<typeof createInMemoryPlanAdapter>);
    expect(factory).toBeTypeOf("function");
    const events: Parameters<typeof applyPlanEvent>[1][] = [];
    const adapter = factory!({ plan: { generate: async () => ({}) } }, (event) => events.push(event));

    await expect(adapter.generate({
      operation: "generate",
      planSessionId: "plan-1",
      projectRoot: "/repo",
      stage: "requirements",
      goal: "Do not synthesize success",
      expectedStateVersion: 0,
    })).rejects.toThrow("Plan backend is unavailable.");
    expect(events).toEqual([]);
  });

  it("recovers a completed terminal result once through getState", () => {
    const reconcile = Reflect.get(planRuntime, "reconcilePlanRuntimeState") as undefined | ((
      session: PlanSession,
      state: unknown,
    ) => PlanSession);
    expect(reconcile).toBeTypeOf("function");
    const terminal = {
      protocolVersion: 1 as const,
      planSessionId: baseSession.id,
      runId: "run-recovered",
      stage: "requirements" as const,
      operation: "generate" as const,
      kind: "completed" as const,
      markdown: "# Requirements\n\nRecovered exactly.",
      checkpoints: emptyCheckpoints,
      snapshot: snapshotFor(1, "# Requirements\n\nRecovered exactly."),
    };
    const state = { protocolVersion: 1 as const, snapshot: terminal.snapshot, active: null, terminal };

    const recovered = reconcile!(baseSession, state);
    const replayed = reconcile!(recovered, state);

    expect(recovered.plan.requirements).toBe(terminal.markdown);
    expect(recovered.stages.requirements).toMatchObject({
      status: "ready",
      runId: null,
      lastRunId: terminal.runId,
    });
    expect(replayed).toBe(recovered);
  });

  it("recovers an active run with its exact bounded draft", () => {
    const reconcile = Reflect.get(planRuntime, "reconcilePlanRuntimeState") as undefined | ((
      session: PlanSession,
      state: unknown,
    ) => PlanSession);
    expect(reconcile).toBeTypeOf("function");
    const draft = "# Requirements\n\nExact partial draft.";

    const recovered = reconcile!(baseSession, {
      protocolVersion: 1,
      snapshot: snapshotFor(0, baseSession.plan.requirements),
      terminal: null,
      active: {
        planSessionId: baseSession.id,
        runId: "run-active",
        stage: "requirements",
        operation: "generate",
        conversationReady: true,
        draft,
        checkpoints: emptyCheckpoints,
      },
    });

    expect(recovered.conversationStarted).toBe(true);
    expect(recovered.stages.requirements).toMatchObject({
      status: "generating",
      runId: "run-active",
      draft,
    });
  });

  it("replaces forged workspace authority and binds the exact backend active draft", () => {
    const activeSnapshot = {
      version: 4,
      plan: {
        requirements: "backend requirements",
        design: "backend design",
        tasks: "",
      },
      accepted: { requirements: true, design: true, tasks: false },
      checkpoints: {
        requirements: ["backend requirements v0"],
        design: ["backend design v0"],
        tasks: [],
      },
    };
    const forged: PlanSession = {
      ...baseSession,
      stateVersion: 99,
      plan: { requirements: "forged requirements", design: "forged design", tasks: "forged tasks" },
      stages: {
        requirements: {
          ...baseSession.stages.requirements,
          accepted: false,
          checkpoints: ["forged requirements checkpoint"],
        },
        design: {
          ...baseSession.stages.design,
          status: "ready",
          accepted: true,
          draft: "forged active draft",
          lastRunId: "run-forged-active",
          checkpoints: ["forged design checkpoint"],
        },
        tasks: {
          ...baseSession.stages.tasks,
          status: "ready",
          accepted: true,
          checkpoints: ["forged tasks checkpoint"],
        },
      },
    };

    const recovered = reconcilePlanRuntimeState(forged, {
      protocolVersion: 1,
      snapshot: activeSnapshot,
      terminal: null,
      active: {
        planSessionId: baseSession.id,
        runId: "run-forged-active",
        stage: "design",
        operation: "generate",
        conversationReady: true,
        draft: "backend active draft",
        checkpoints: activeSnapshot.checkpoints,
      },
    });

    expect(recovered.stateVersion).toBe(activeSnapshot.version);
    expect(recovered.plan).toEqual(activeSnapshot.plan);
    expect(recovered.stages.requirements).toMatchObject({
      status: "ready",
      accepted: true,
      checkpoints: activeSnapshot.checkpoints.requirements,
    });
    expect(recovered.stages.design).toMatchObject({
      status: "generating",
      accepted: false,
      draft: "backend active draft",
      runId: "run-forged-active",
      lastRunId: null,
      operation: "generate",
      checkpoints: activeSnapshot.checkpoints.design,
    });
    expect(recovered.stages.tasks).toMatchObject({
      status: "pending",
      accepted: false,
      checkpoints: [],
    });
    expect(recovered.conversationStarted).toBe(true);
  });

  it("uses the exact backend active draft instead of a newer matching local draft", () => {
    const started = applyPlanEvent(baseSession, {
      protocolVersion: 1,
      planSessionId: baseSession.id,
      runId: "run-race",
      stage: "requirements",
      operation: "generate",
      kind: "started",
    });
    const snapshotDraft = "# Requirements";
    const local = applyPlanEvent(started, {
      protocolVersion: 1,
      planSessionId: baseSession.id,
      runId: "run-race",
      stage: "requirements",
      operation: "generate",
      kind: "delta",
      text: `${snapshotDraft}\n\nNewer local delta.`,
    });

    const reconciled = reconcilePlanRuntimeState(local, {
      protocolVersion: 1,
      snapshot: snapshotFor(0, baseSession.plan.requirements),
      terminal: null,
      active: {
        planSessionId: baseSession.id,
        runId: "run-race",
        stage: "requirements",
        operation: "generate",
        conversationReady: true,
        draft: snapshotDraft,
        checkpoints: emptyCheckpoints,
      },
    });

    expect(reconciled.stages.requirements.draft).toBe(snapshotDraft);
    expect(reconciled.conversationStarted).toBe(true);
  });

  it("replaces a locally terminal run with the authoritative backend active state", () => {
    const started = applyPlanEvent(baseSession, {
      protocolVersion: 1,
      planSessionId: baseSession.id,
      runId: "run-terminal-race",
      stage: "requirements",
      operation: "generate",
      kind: "started",
    });
    const completed = applyPlanEvent(started, {
      protocolVersion: 1,
      planSessionId: baseSession.id,
      runId: "run-terminal-race",
      stage: "requirements",
      operation: "generate",
      kind: "completed",
      markdown: "# Requirements\n\nCompleted.",
      checkpoints: emptyCheckpoints,
      snapshot: snapshotFor(1, "# Requirements\n\nCompleted."),
    });

    const reconciled = reconcilePlanRuntimeState(completed, {
      protocolVersion: 1,
      snapshot: snapshotFor(0, baseSession.plan.requirements),
      terminal: null,
      active: {
        planSessionId: baseSession.id,
        runId: "run-terminal-race",
        stage: "requirements",
        operation: "generate",
        conversationReady: true,
        draft: "# Requirements",
        checkpoints: emptyCheckpoints,
      },
    });

    expect(reconciled.stateVersion).toBe(0);
    expect(reconciled.plan.requirements).toBe(baseSession.plan.requirements);
    expect(reconciled.stages.requirements).toMatchObject({
      status: "generating",
      runId: "run-terminal-race",
      lastRunId: null,
      draft: "# Requirements",
    });
  });

  it("uses the exact backend active draft instead of a divergent matching local draft", () => {
    const local = applyPlanEvent(applyPlanEvent(baseSession, {
      protocolVersion: 1,
      planSessionId: baseSession.id,
      runId: "run-diverged",
      stage: "requirements",
      operation: "generate",
      kind: "started",
    }), {
      protocolVersion: 1,
      planSessionId: baseSession.id,
      runId: "run-diverged",
      stage: "requirements",
      operation: "generate",
      kind: "delta",
      text: "local draft",
    });

    const reconciled = reconcilePlanRuntimeState(local, {
      protocolVersion: 1,
      snapshot: snapshotFor(0, baseSession.plan.requirements),
      terminal: null,
      active: {
        planSessionId: baseSession.id,
        runId: "run-diverged",
        stage: "requirements",
        operation: "generate",
        conversationReady: true,
        draft: "remote divergence",
        checkpoints: emptyCheckpoints,
      },
    });
    expect(local.plan.requirements).toBe(baseSession.plan.requirements);
    expect(local.stages.requirements.draft).toBe("local draft");
    expect(reconciled.stages.requirements.draft).toBe("remote divergence");
  });

  it("rebinds a missed started event from a duplicate start result before later events", () => {
    const startResult = {
      protocolVersion: 1 as const,
      planSessionId: baseSession.id,
      runId: "run-duplicate",
      stage: "requirements" as const,
      operation: "generate" as const,
      duplicate: true,
    };
    const rebound = bindPlanRunStart(baseSession, startResult);
    const snapshot = reconcilePlanRuntimeState(rebound, {
      protocolVersion: 1,
      snapshot: snapshotFor(0, baseSession.plan.requirements),
      terminal: null,
      active: {
        planSessionId: baseSession.id,
        runId: startResult.runId,
        stage: startResult.stage,
        operation: startResult.operation,
        conversationReady: true,
        draft: "# Requirements",
        checkpoints: emptyCheckpoints,
      },
    });
    const withDelta = applyPlanEvent(snapshot, {
      ...startResult,
      kind: "delta",
      text: "\n\nLater delta.",
    });
    const terminal = applyPlanEvent(withDelta, {
      ...startResult,
      kind: "completed",
      markdown: "# Requirements\n\nComplete.",
      checkpoints: emptyCheckpoints,
      snapshot: snapshotFor(1, "# Requirements\n\nComplete."),
    });

    expect(rebound.stages.requirements.runId).toBe(startResult.runId);
    expect(withDelta.stages.requirements.draft).toBe("# Requirements\n\nLater delta.");
    expect(terminal.stages.requirements).toMatchObject({ status: "ready", lastRunId: startResult.runId });
  });

  it("reconciles backend checkpoints over a stale workspace and undoes twice without duplicates", () => {
    const stale: PlanSession = {
      ...baseSession,
      plan: { ...baseSession.plan, requirements: "requirements-v1" },
      stages: {
        ...baseSession.stages,
        requirements: {
          ...baseSession.stages.requirements,
          lastRunId: "run-second-revision",
          checkpoints: ["local-duplicate-must-be-replaced"],
        },
      },
    };
    const terminal = {
      protocolVersion: 1 as const,
      planSessionId: stale.id,
      runId: "run-second-revision",
      stage: "requirements" as const,
      operation: "revise" as const,
      kind: "completed" as const,
      markdown: "requirements-v2",
      checkpoints: {
        requirements: ["requirements-v0", "requirements-v1"],
        design: [],
        tasks: [],
      },
      snapshot: snapshotFor(2, "requirements-v2", {
        requirements: ["requirements-v0", "requirements-v1"], design: [], tasks: [],
      }),
    };

    const recovered = reconcilePlanRuntimeState(stale, {
      protocolVersion: 1, snapshot: terminal.snapshot, active: null, terminal,
    });
    const v1 = undoPlanStage(recovered, "requirements");
    const v0 = undoPlanStage(v1, "requirements");

    expect(recovered.plan.requirements).toBe("requirements-v2");
    expect(recovered.stages.requirements.checkpoints).toEqual(["requirements-v0", "requirements-v1"]);
    expect(v1.plan.requirements).toBe("requirements-v1");
    expect(v1.stages.requirements.checkpoints).toEqual(["requirements-v0"]);
    expect(v0.plan.requirements).toBe("requirements-v0");
    expect(v0.stages.requirements.checkpoints).toEqual([]);
  });

  it("reconciles every authoritative terminal field before preserving duplicate UI state", () => {
    const terminalSnapshot = {
      version: 7,
      plan: {
        requirements: "backend requirements",
        design: "backend design",
        tasks: "backend tasks",
      },
      accepted: { requirements: true, design: true, tasks: false },
      checkpoints: {
        requirements: ["backend requirements v0"],
        design: ["backend design v0"],
        tasks: ["backend tasks v0"],
      },
    };
    const terminal = {
      protocolVersion: 1 as const,
      planSessionId: baseSession.id,
      runId: "run-forged-terminal",
      stage: "tasks" as const,
      operation: "generate" as const,
      kind: "completed" as const,
      markdown: terminalSnapshot.plan.tasks,
      checkpoints: terminalSnapshot.checkpoints,
      snapshot: terminalSnapshot,
    };
    const forged: PlanSession = {
      ...baseSession,
      stateVersion: terminalSnapshot.version,
      conversationStarted: true,
      plan: {
        requirements: "forged requirements",
        design: "forged design",
        tasks: terminal.markdown,
      },
      stages: {
        requirements: {
          ...baseSession.stages.requirements,
          status: "failed",
          accepted: false,
          error: "forged error",
          checkpoints: terminalSnapshot.checkpoints.requirements,
        },
        design: {
          ...baseSession.stages.design,
          status: "pending",
          accepted: false,
          checkpoints: terminalSnapshot.checkpoints.design,
        },
        tasks: {
          ...baseSession.stages.tasks,
          status: "ready",
          accepted: false,
          lastRunId: terminal.runId,
          checkpoints: terminalSnapshot.checkpoints.tasks,
        },
      },
    };

    const recovered = reconcilePlanRuntimeState(forged, {
      protocolVersion: 1,
      snapshot: terminalSnapshot,
      active: null,
      terminal,
    });

    expect(recovered.stateVersion).toBe(terminalSnapshot.version);
    expect(recovered.plan).toEqual(terminalSnapshot.plan);
    expect(recovered.stages.requirements).toMatchObject({
      status: "ready",
      accepted: true,
      error: null,
      checkpoints: terminalSnapshot.checkpoints.requirements,
    });
    expect(recovered.stages.design).toMatchObject({
      status: "ready",
      accepted: true,
      checkpoints: terminalSnapshot.checkpoints.design,
    });
    expect(recovered.stages.tasks).toMatchObject({
      status: "ready",
      accepted: false,
      lastRunId: terminal.runId,
      checkpoints: terminalSnapshot.checkpoints.tasks,
    });
  });

  it("recovers the prior backend checkpoint ledger from a failed terminal", () => {
    const stale: PlanSession = {
      ...baseSession,
      plan: { ...baseSession.plan, requirements: "requirements-v1" },
      stages: {
        ...baseSession.stages,
        requirements: {
          ...baseSession.stages.requirements,
          lastRunId: "run-failed-revision",
          checkpoints: [],
        },
      },
    };

    const recovered = reconcilePlanRuntimeState(stale, {
      protocolVersion: 1,
      snapshot: snapshotFor(1, "requirements-v1", {
        requirements: ["requirements-v0"], design: [], tasks: [],
      }),
      active: null,
      terminal: {
        protocolVersion: 1,
        planSessionId: stale.id,
        runId: "run-failed-revision",
        stage: "requirements",
        operation: "revise",
        kind: "failed",
        error: "Hermes ACP prompt failed.",
        checkpoints: { requirements: ["requirements-v0"], design: [], tasks: [] },
        snapshot: snapshotFor(1, "requirements-v1", {
          requirements: ["requirements-v0"], design: [], tasks: [],
        }),
      },
    });

    expect(recovered.plan.requirements).toBe("requirements-v1");
    expect(recovered.stages.requirements).toMatchObject({
      status: "failed",
      error: "Hermes ACP prompt failed.",
      checkpoints: ["requirements-v0"],
    });
    const undone = undoPlanStage(recovered, "requirements");
    expect(undone.plan.requirements).toBe("requirements-v0");
    expect(undone.stages.requirements.checkpoints).toEqual([]);
  });

  it("keeps backend state unknown after getState rejection until explicit retry succeeds", async () => {
    const failedAdapter = {
      ...createInMemoryPlanAdapter(() => undefined),
      getState: () => Promise.reject(new Error("secret backend detail")),
    };
    let recovery = planRuntimeRecoveryReducer(initialPlanRuntimeRecovery, {
      type: "begin",
      planSessionId: baseSession.id,
    });

    await expect(loadPlanRuntimeState(failedAdapter, baseSession.id, "/repo")).rejects.toThrow(
      PLAN_RUNTIME_STATE_ERROR,
    );
    recovery = planRuntimeRecoveryReducer(recovery, { type: "failed", planSessionId: baseSession.id });
    expect(recovery).toEqual({
      planSessionId: baseSession.id,
      status: "failed",
      error: PLAN_RUNTIME_STATE_ERROR,
    });
    expect(canStartPlanRequest(recovery, baseSession.id)).toBe(false);

    recovery = planRuntimeRecoveryReducer(recovery, { type: "begin", planSessionId: baseSession.id });
    recovery = planRuntimeRecoveryReducer(recovery, { type: "succeeded", planSessionId: baseSession.id });
    expect(canStartPlanRequest(recovery, baseSession.id)).toBe(true);
  });

  it("locks edits through delayed recovery and unlocks only for the exact ready session", async () => {
    const isPlanInteractionLocked = Reflect.get(planRuntime, "isPlanInteractionLocked") as undefined | ((
      recovery: typeof initialPlanRuntimeRecovery,
      planSessionId: string,
      finishInFlight?: boolean,
    ) => boolean);
    expect(isPlanInteractionLocked).toBeTypeOf("function");
    let resolveState: ((value: Awaited<ReturnType<typeof loadPlanRuntimeState>>) => void) | undefined;
    const delayed = new Promise<Awaited<ReturnType<typeof loadPlanRuntimeState>>>((resolve) => {
      resolveState = resolve;
    });
    const adapter = {
      ...createInMemoryPlanAdapter(() => undefined),
      getState: () => delayed,
    };
    let recovery = planRuntimeRecoveryReducer(initialPlanRuntimeRecovery, {
      type: "begin",
      planSessionId: baseSession.id,
    });
    const pending = loadPlanRuntimeState(adapter, baseSession.id, "/repo");
    let session = baseSession;

    if (!isPlanInteractionLocked!(recovery, baseSession.id)) {
      session = editPlanStage(session, "requirements", "lost edit");
    }
    expect(session.plan.requirements).toBe(baseSession.plan.requirements);
    expect(isPlanInteractionLocked!(initialPlanRuntimeRecovery, baseSession.id)).toBe(true);
    expect(isPlanInteractionLocked!({ planSessionId: "other", status: "ready", error: null }, baseSession.id))
      .toBe(true);
    expect(isPlanInteractionLocked!({ planSessionId: baseSession.id, status: "failed", error: "failed" }, baseSession.id))
      .toBe(true);

    resolveState!({
      protocolVersion: 1,
      needsBootstrap: false,
      snapshot: {
        version: 0,
        plan: { ...baseSession.plan },
        accepted: { requirements: false, design: false, tasks: false },
        checkpoints: { requirements: [], design: [], tasks: [] },
      },
      active: null,
      terminal: null,
    });
    await pending;
    recovery = planRuntimeRecoveryReducer(recovery, { type: "succeeded", planSessionId: baseSession.id });
    expect(isPlanInteractionLocked!(recovery, baseSession.id)).toBe(false);
    expect(isPlanInteractionLocked!(recovery, baseSession.id, true)).toBe(true);
  });

  it("bootstraps missing durable state through the narrow adapter request before returning authority", async () => {
    const calls: Array<{ kind: string; input: unknown }> = [];
    const authoritative = {
      protocolVersion: 1 as const,
      needsBootstrap: false,
      snapshot: {
        version: 0,
        plan: {
          requirements: "legacy requirements",
          design: "legacy design",
          tasks: "legacy tasks",
        },
        accepted: { requirements: true, design: true, tasks: true },
        checkpoints: {
          requirements: ["requirements-v0"],
          design: ["design-v0"],
          tasks: ["tasks-v0"],
        },
      },
      active: null,
      terminal: null,
    };
    let reads = 0;
    const adapter = {
      ...createInMemoryPlanAdapter(() => undefined),
      async getState(input: unknown) {
        calls.push({ kind: "getState", input });
        reads += 1;
        return reads === 1
          ? {
              protocolVersion: 1 as const,
              needsBootstrap: true,
              snapshot: {
                version: 0,
                plan: { requirements: "", design: "", tasks: "" },
                accepted: { requirements: false, design: false, tasks: false },
                checkpoints: { requirements: [], design: [], tasks: [] },
              },
              active: null,
              terminal: null,
            }
          : authoritative;
      },
      async bootstrap(input: unknown) {
        calls.push({ kind: "bootstrap", input });
        return authoritative;
      },
    };

    const loaded = await loadPlanRuntimeState(adapter, baseSession.id, "/repo");

    expect(loaded).toEqual(authoritative);
    expect(calls).toEqual([
      { kind: "getState", input: { planSessionId: baseSession.id, projectRoot: "/repo" } },
      { kind: "bootstrap", input: { planSessionId: baseSession.id, projectRoot: "/repo" } },
      { kind: "getState", input: { planSessionId: baseSession.id, projectRoot: "/repo" } },
    ]);
    expect(Object.keys(calls[1]?.input as object).sort()).toEqual(["planSessionId", "projectRoot"]);
  });

  it("initializes a new browser Plan once through the same bootstrap contract", async () => {
    const adapter = createInMemoryPlanAdapter(() => undefined);
    const first = await loadPlanRuntimeState(adapter, "plan-new", "/repo");
    const second = await loadPlanRuntimeState(adapter, "plan-new", "/repo");

    expect(first.needsBootstrap).toBe(false);
    expect(first.snapshot.plan).toEqual({ requirements: "", design: "", tasks: "" });
    expect(second).toEqual(first);
  });

  it("polls active Plan recovery without overlap and stops after terminal state", async () => {
    const createWatchdog = Reflect.get(planRuntime, "createPlanRuntimeWatchdog") as undefined | ((options: {
      recover: () => Promise<boolean>;
      isActive: () => boolean;
      schedule: (callback: () => void, delay: number) => number;
      cancel: (handle: number) => void;
      intervalMs: number;
    }) => () => void);
    expect(createWatchdog).toBeTypeOf("function");
    if (!createWatchdog) return;
    const scheduled: Array<{ callback: () => void; delay: number; handle: number }> = [];
    const cancelled: number[] = [];
    let active = true;
    let attempts = 0;
    let release: (() => void) | null = null;
    const stop = createWatchdog({
      recover: () => {
        attempts += 1;
        return new Promise<boolean>((resolve) => {
          release = () => resolve(true);
        });
      },
      isActive: () => active,
      schedule: (callback, delay) => {
        const handle = scheduled.length + 1;
        scheduled.push({ callback, delay, handle });
        return handle;
      },
      cancel: (handle) => cancelled.push(handle),
      intervalMs: 250,
    });

    expect(scheduled).toHaveLength(1);
    scheduled.shift()!.callback();
    scheduled.forEach((item) => item.callback());
    expect(attempts).toBe(1);
    expect(scheduled).toHaveLength(0);
    active = false;
    release?.();
    await Promise.resolve();
    await Promise.resolve();
    expect(scheduled).toHaveLength(0);
    stop();
    expect(cancelled.length).toBeLessThanOrEqual(1);
  });

  it("keeps a wrapped-busy Plan pending and retries it through the serialized mutation queue", async () => {
    const createController = Reflect.get(planRuntime, "createPlanAutoStartController") as undefined | ((options: {
      retryDelayMs: number;
      schedule: (callback: () => void, delay: number) => number;
      cancel: (handle: number) => void;
    }) => {
      setScope: (scope: string | null) => void;
      start: (input: {
        key: string;
        isEligible: () => boolean;
        start: () => Promise<void>;
        onFailure: (error: unknown) => void;
      }) => void;
    });
    const applyFailure = Reflect.get(planRuntime, "applyPlanRunStartFailure") as undefined | ((
      session: PlanSession,
      stage: "requirements",
      operation: "generate",
      error: unknown,
    ) => PlanSession);
    expect(createController).toBeTypeOf("function");
    expect(applyFailure).toBeTypeOf("function");
    if (!createController || !applyFailure) return;
    const scheduled: Array<{ callback: () => void; delay: number }> = [];
    let runtimeBusy = true;
    let attempts = 0;
    let secondPlan: PlanSession = {
      ...baseSession,
      id: "plan-2",
      plan: { requirements: "", design: "", tasks: "" },
      stages: {
        ...baseSession.stages,
        requirements: { ...baseSession.stages.requirements, status: "pending", accepted: false },
      },
    };
    const initialSecondPlan = secondPlan;
    const mutationCalls: string[] = [];
    let resolveRetry!: () => void;
    const retryCompleted = new Promise<void>((resolve) => { resolveRetry = resolve; });
    const mutationQueue = createPlanMutationQueue({
      updateStage: async () => {
        mutationCalls.push("updateStage");
        if (runtimeBusy) {
          throw new Error(
            "Error invoking remote method 'plan:updateStage': Error: Plan runtime is busy.",
          );
        }
        return { protocolVersion: 1, snapshot: snapshotFor(0, "") };
      },
      generate: async () => {
        mutationCalls.push("generate");
        return {
          protocolVersion: 1,
          planSessionId: secondPlan.id,
          runId: "run-plan-2",
          stage: "requirements",
          operation: "generate",
          duplicate: false,
        };
      },
    } as never, () => secondPlan, (next) => { secondPlan = next; });
    const controller = createController({
      retryDelayMs: 500,
      schedule: (callback, delay) => {
        scheduled.push({ callback, delay });
        return scheduled.length;
      },
      cancel: () => undefined,
    });
    const request = {
      key: "plan-2:requirements:generate",
      isEligible: () => (
        secondPlan.stages.requirements.status === "pending" &&
        secondPlan.stages.requirements.runId === null
      ),
      start: async () => {
        attempts += 1;
        const result = await mutationQueue.generate(
          "/repo",
          secondPlan.id,
          "requirements",
          secondPlan.goal,
        );
        secondPlan = bindPlanRunStart(secondPlan, result);
        resolveRetry();
      },
      onFailure: (error: unknown) => {
        secondPlan = applyFailure(secondPlan, "requirements", "generate", error);
      },
    };
    controller.setScope("project-1:plan-2");
    controller.start(request);
    controller.start(request);
    for (let index = 0; index < 8; index += 1) await Promise.resolve();

    expect(attempts).toBe(1);
    expect(secondPlan).toBe(initialSecondPlan);
    expect(secondPlan.stages.requirements.status).toBe("pending");
    expect(secondPlan.stages.requirements.error).toBeNull();
    expect(mutationCalls).toEqual(["updateStage"]);
    expect(scheduled).toEqual([{ callback: expect.any(Function), delay: 500 }]);

    runtimeBusy = false;
    scheduled.shift()!.callback();
    await retryCompleted;
    expect(attempts).toBe(2);
    expect(secondPlan.stages.requirements).toMatchObject({
      status: "generating",
      runId: "run-plan-2",
      error: null,
    });
    expect(mutationCalls).toEqual(["updateStage", "updateStage", "generate"]);
  });

  it.each([
    ["edit", (session: PlanSession) => editPlanStage(session, "requirements", "# Requirements\n\nUser edit.")],
    ["accept", (session: PlanSession) => acceptPlanStage(
      editPlanStage(session, "requirements", "# Requirements\n\nUser accepted."),
      "requirements",
    )],
  ])("drops a wrapped-busy retry after the user chooses to %s Requirements", async (_label, changeSession) => {
    const createController = Reflect.get(planRuntime, "createPlanAutoStartController") as undefined | ((options: {
      retryDelayMs: number;
      schedule: (callback: () => void, delay: number) => number;
      cancel: (handle: number) => void;
    }) => {
      setScope: (scope: string | null) => void;
      start: (input: {
        key: string;
        isEligible: () => boolean;
        start: () => Promise<void>;
        onFailure: (error: unknown) => void;
      }) => void;
    });
    expect(createController).toBeTypeOf("function");
    if (!createController) return;
    const scheduled: Array<{ callback: () => void; delay: number }> = [];
    const mutationCalls: string[] = [];
    let attempts = 0;
    let session: PlanSession = {
      ...baseSession,
      plan: { ...baseSession.plan, requirements: "" },
      stages: {
        ...baseSession.stages,
        requirements: {
          ...baseSession.stages.requirements,
          status: "pending",
          accepted: false,
          runId: null,
        },
      },
    };
    const controller = createController({
      retryDelayMs: 500,
      schedule: (callback, delay) => {
        scheduled.push({ callback, delay });
        return scheduled.length;
      },
      cancel: () => undefined,
    });
    controller.setScope("project-1:plan-1");
    controller.start({
      key: "plan-1:requirements:generate",
      isEligible: () => (
        session.stages.requirements.status === "pending" &&
        session.stages.requirements.runId === null
      ),
      start: async () => {
        attempts += 1;
        mutationCalls.push("updateStage");
        if (attempts === 1) {
          throw new Error(
            "Error invoking remote method 'plan:updateStage': Error: Plan runtime is busy.",
          );
        }
        mutationCalls.push("generate");
        session = bindPlanRunStart(session, {
          protocolVersion: 1,
          planSessionId: session.id,
          runId: "stale-run",
          stage: "requirements",
          operation: "generate",
          duplicate: false,
        });
      },
      onFailure: () => undefined,
    });
    for (let index = 0; index < 8; index += 1) await Promise.resolve();
    expect(scheduled).toHaveLength(1);

    session = changeSession(session);
    const userState = session;
    scheduled.shift()!.callback();
    for (let index = 0; index < 8; index += 1) await Promise.resolve();

    expect(attempts).toBe(1);
    expect(mutationCalls).toEqual(["updateStage"]);
    expect(session).toBe(userState);
    expect(session.stages.requirements.status).toBe("ready");
    expect(session.stages.requirements.runId).toBeNull();
    expect(scheduled).toHaveLength(0);
  });

  it("does not retain a retry when eligibility turns false during the busy rejection", async () => {
    const createController = Reflect.get(planRuntime, "createPlanAutoStartController") as undefined | ((options: {
      retryDelayMs: number;
      schedule: (callback: () => void, delay: number) => number;
      cancel: (handle: number) => void;
    }) => {
      setScope: (scope: string | null) => void;
      start: (input: {
        key: string;
        isEligible: () => boolean;
        start: () => Promise<void>;
        onFailure: (error: unknown) => void;
      }) => void;
    });
    expect(createController).toBeTypeOf("function");
    if (!createController) return;
    const scheduled: Array<() => void> = [];
    let eligible = true;
    let rejectStart!: (error: unknown) => void;
    const controller = createController({
      retryDelayMs: 500,
      schedule: (callback) => {
        scheduled.push(callback);
        return scheduled.length;
      },
      cancel: () => undefined,
    });
    controller.setScope("project-1:plan-1");
    controller.start({
      key: "plan-1:requirements:generate",
      isEligible: () => eligible,
      start: () => new Promise<void>((_resolve, reject) => { rejectStart = reject; }),
      onFailure: () => undefined,
    });

    eligible = false;
    rejectStart(new Error("Error invoking remote method 'plan:generate': Error: Plan runtime is busy."));
    for (let index = 0; index < 8; index += 1) await Promise.resolve();

    expect(scheduled).toHaveLength(0);
  });

  it("cancels a retained retry when the active Plan scope changes", async () => {
    const createController = Reflect.get(planRuntime, "createPlanAutoStartController") as undefined | ((options: {
      retryDelayMs: number;
      schedule: (callback: () => void, delay: number) => number;
      cancel: (handle: number) => void;
    }) => {
      setScope: (scope: string | null) => void;
      start: (input: {
        key: string;
        isEligible: () => boolean;
        start: () => Promise<void>;
        onFailure: (error: unknown) => void;
      }) => void;
    });
    expect(createController).toBeTypeOf("function");
    if (!createController) return;
    const scheduled: Array<{ callback: () => void; handle: number }> = [];
    const cancelled: number[] = [];
    let attempts = 0;
    const controller = createController({
      retryDelayMs: 500,
      schedule: (callback) => {
        const handle = scheduled.length + 1;
        scheduled.push({ callback, handle });
        return handle;
      },
      cancel: (handle) => cancelled.push(handle),
    });
    controller.setScope("project-1:plan-1");
    controller.start({
      key: "plan-1:requirements:generate",
      isEligible: () => true,
      start: async () => {
        attempts += 1;
        throw new Error("Error invoking remote method 'plan:generate': Error: Plan runtime is busy.");
      },
      onFailure: () => undefined,
    });
    for (let index = 0; index < 8; index += 1) await Promise.resolve();

    controller.setScope("project-1:plan-2");
    expect(cancelled).toEqual([1]);
    scheduled[0]!.callback();
    for (let index = 0; index < 4; index += 1) await Promise.resolve();
    expect(attempts).toBe(1);
  });

  it("applies the backend snapshot as the only document, acceptance, checkpoint, and version authority", () => {
    const applySnapshot = (planRuntime as unknown as {
      applyPlanStateSnapshot?: (session: PlanSession, snapshot: unknown) => PlanSession;
    }).applyPlanStateSnapshot;
    expect(typeof applySnapshot).toBe("function");
    if (!applySnapshot) return;
    const forged: PlanSession = {
      ...baseSession,
      stateVersion: 99,
      plan: { requirements: "forged", design: "forged", tasks: "forged" },
      stages: {
        requirements: { ...baseSession.stages.requirements, accepted: true, lastRunId: "forged-requirements", checkpoints: ["forged"] },
        design: { ...baseSession.stages.design, status: "ready", accepted: true, lastRunId: "forged-design", checkpoints: ["forged"] },
        tasks: { ...baseSession.stages.tasks, status: "ready", accepted: true, lastRunId: "forged-tasks", checkpoints: ["forged"] },
      },
    };
    const authoritative = applySnapshot(forged, {
      version: 4,
      plan: { requirements: "requirements-v1", design: "", tasks: "" },
      accepted: { requirements: false, design: false, tasks: false },
      checkpoints: { requirements: ["requirements-v0"], design: [], tasks: [] },
    });

    expect(authoritative.stateVersion).toBe(4);
    expect(authoritative.plan).toEqual({ requirements: "requirements-v1", design: "", tasks: "" });
    expect(authoritative.stages.requirements).toMatchObject({ accepted: false, checkpoints: ["requirements-v0"] });
    expect(authoritative.stages.design).toMatchObject({ status: "pending", accepted: false, checkpoints: [] });
    expect(authoritative.stages.tasks).toMatchObject({ status: "pending", accepted: false, checkpoints: [] });
    expect(Object.values(authoritative.stages).map((stage) => stage.lastRunId)).toEqual([null, null, null]);
  });

  it("serializes edits before actions and never lets a stale persistence response overwrite newer input", async () => {
    const createQueue = (planRuntime as unknown as {
      createPlanMutationQueue?: (
        adapter: unknown,
        getSession: (id: string) => PlanSession | null,
        applySession: (session: PlanSession) => void,
      ) => {
        persistStage: (projectRoot: string, id: string, stage: "requirements") => Promise<unknown>;
        revise: (projectRoot: string, id: string, stage: "requirements", goal: string, instruction: string) => Promise<unknown>;
      };
    }).createPlanMutationQueue;
    expect(typeof createQueue).toBe("function");
    if (!createQueue) return;
    let session = { ...baseSession, plan: { ...baseSession.plan, requirements: "edit-a" } };
    const calls: Array<{ kind: string; markdown?: string; version: number }> = [];
    let durableMarkdown = "# Requirements\n\nOld.";
    let durableVersion = 0;
    let releaseFirst: ((value: unknown) => void) | null = null;
    const adapter = {
      updateStage: (input: { markdown: string; expectedStateVersion: number }) => {
        calls.push({ kind: "update", markdown: input.markdown, version: input.expectedStateVersion });
        if (calls.length === 1) return new Promise((resolve) => { releaseFirst = resolve; });
        if (input.markdown !== durableMarkdown) {
          durableMarkdown = input.markdown;
          durableVersion += 1;
        }
        return Promise.resolve({
          protocolVersion: 1,
          snapshot: snapshotFor(durableVersion, durableMarkdown),
        });
      },
      revise: (input: { expectedStateVersion: number }) => {
        calls.push({ kind: "revise", version: input.expectedStateVersion });
        return Promise.resolve({
          protocolVersion: 1, planSessionId: session.id, runId: "run-revise",
          stage: "requirements", operation: "revise", duplicate: false,
        });
      },
    };
    const queue = createQueue(adapter, () => session, (next) => { session = next; });
    const persisting = queue.persistStage("/repo", session.id, "requirements");
    while (!releaseFirst) await Promise.resolve();
    session = { ...session, plan: { ...session.plan, requirements: "edit-b" } };
    durableMarkdown = "edit-a";
    durableVersion = 1;
    releaseFirst({ protocolVersion: 1, snapshot: snapshotFor(1, "edit-a") });
    await persisting;

    expect(session.plan.requirements).toBe("edit-b");
    expect(session.stateVersion).toBe(2);
    await queue.revise("/repo", session.id, "requirements", session.goal, "Revise it.");
    expect(calls).toEqual([
      { kind: "update", markdown: "edit-a", version: 0 },
      { kind: "update", markdown: "edit-b", version: 1 },
      { kind: "update", markdown: "edit-b", version: 2 },
      { kind: "revise", version: 2 },
    ]);
  });

  it("replays an upstream edit made while Design persistence is pending and clears invalidated Design", async () => {
    const createQueue = planRuntime.createPlanMutationQueue;
    let session: PlanSession = {
      ...baseSession,
      stateVersion: 2,
      plan: { requirements: "R0", design: "D1", tasks: "" },
      stages: {
        ...baseSession.stages,
        requirements: { ...baseSession.stages.requirements, accepted: true },
        design: { ...baseSession.stages.design, status: "ready" },
      },
    };
    const calls: Array<{ stage: string; markdown: string; version: number }> = [];
    let releaseDesign: ((value: unknown) => void) | null = null;
    const adapter = {
      updateStage: (input: { stage: "requirements" | "design" | "tasks"; markdown: string; expectedStateVersion: number }) => {
        calls.push({ stage: input.stage, markdown: input.markdown, version: input.expectedStateVersion });
        if (calls.length === 1) return new Promise((resolve) => { releaseDesign = resolve; });
        return Promise.resolve({
          protocolVersion: 1 as const,
          snapshot: documentSnapshot(4, "R1", "", false),
        });
      },
    };
    const queue = createQueue(adapter as never, () => session, (next) => { session = next; });
    const pending = queue.persistStage("/repo", session.id, "design");
    while (!releaseDesign) await Promise.resolve();
    session = editPlanStage(session, "requirements", "R1");
    releaseDesign({ protocolVersion: 1, snapshot: documentSnapshot(3, "R0", "D1", true) });
    await pending;

    expect(session.plan).toEqual({ requirements: "R1", design: "", tasks: "" });
    expect(session.stateVersion).toBe(4);
    expect(calls).toEqual([
      { stage: "design", markdown: "D1", version: 2 },
      { stage: "requirements", markdown: "R1", version: 3 },
    ]);
  });

  it("keeps replaying whole-document edits across rapid persistence responses", async () => {
    const createQueue = planRuntime.createPlanMutationQueue;
    let session: PlanSession = {
      ...baseSession,
      stateVersion: 2,
      plan: { requirements: "R0", design: "D1", tasks: "" },
      stages: {
        ...baseSession.stages,
        requirements: { ...baseSession.stages.requirements, accepted: true },
        design: { ...baseSession.stages.design, status: "ready" },
      },
    };
    const calls: Array<{ stage: string; markdown: string; version: number }> = [];
    const releases: Array<(value: unknown) => void> = [];
    const adapter = {
      updateStage: (input: { stage: "requirements" | "design" | "tasks"; markdown: string; expectedStateVersion: number }) => {
        calls.push({ stage: input.stage, markdown: input.markdown, version: input.expectedStateVersion });
        if (calls.length <= 2) return new Promise((resolve) => { releases.push(resolve); });
        return Promise.resolve({ protocolVersion: 1 as const, snapshot: documentSnapshot(5, "R2", "", false) });
      },
    };
    const queue = createQueue(adapter as never, () => session, (next) => { session = next; });
    const pending = queue.persistStage("/repo", session.id, "design");
    while (releases.length < 1) await Promise.resolve();
    session = editPlanStage(session, "requirements", "R1");
    releases[0]?.({ protocolVersion: 1, snapshot: documentSnapshot(3, "R0", "D1", true) });
    while (releases.length < 2) await Promise.resolve();
    session = editPlanStage(session, "requirements", "R2");
    releases[1]?.({ protocolVersion: 1, snapshot: documentSnapshot(4, "R1", "", false) });
    await pending;

    expect(session.plan).toEqual({ requirements: "R2", design: "", tasks: "" });
    expect(calls).toEqual([
      { stage: "design", markdown: "D1", version: 2 },
      { stage: "requirements", markdown: "R1", version: 3 },
      { stage: "requirements", markdown: "R2", version: 4 },
    ]);
  });

  it.each(["acceptStage", "undoStage"] as const)(
    "replays whole-document edits across a pending %s response",
    async (operation) => {
      const createQueue = planRuntime.createPlanMutationQueue;
      let session: PlanSession = {
        ...baseSession,
        stateVersion: 2,
        plan: { requirements: "R0", design: "D0", tasks: "" },
        stages: {
          ...baseSession.stages,
          requirements: { ...baseSession.stages.requirements, accepted: true },
          design: {
            ...baseSession.stages.design,
            status: "ready",
            checkpoints: operation === "undoStage" ? ["D-1"] : [],
          },
        },
      };
      let releaseTransition: ((value: unknown) => void) | null = null;
      const updates: Array<{ stage: string; markdown: string; version: number }> = [];
      const adapter = {
        updateStage: (input: { stage: "requirements" | "design" | "tasks"; markdown: string; expectedStateVersion: number }) => {
          updates.push({ stage: input.stage, markdown: input.markdown, version: input.expectedStateVersion });
          const snapshot = updates.length === 1
            ? documentSnapshot(2, "R0", "D0", true, operation === "undoStage" ? ["D-1"] : [])
            : documentSnapshot(4, "R1", "", false);
          return Promise.resolve({ protocolVersion: 1 as const, snapshot });
        },
        [operation]: () => new Promise((resolve) => { releaseTransition = resolve; }),
      };
      const queue = createQueue(adapter as never, () => session, (next) => { session = next; });
      const pending = queue[operation]("/repo", session.id, "design");
      while (!releaseTransition) await Promise.resolve();
      session = editPlanStage(session, "requirements", "R1");
      releaseTransition({
        protocolVersion: 1,
        snapshot: operation === "acceptStage"
          ? {
              ...documentSnapshot(3, "R0", "D0", true),
              accepted: { requirements: true, design: true, tasks: false },
            }
          : documentSnapshot(3, "R0", "D-1", true),
      });
      await pending;

      expect(session.plan).toEqual({ requirements: "R1", design: "", tasks: "" });
      expect(updates.at(-1)).toEqual({ stage: "requirements", markdown: "R1", version: 3 });
    },
  );
});

function snapshotFor(
  version: number,
  requirements: string,
  checkpoints = { requirements: [] as string[], design: [] as string[], tasks: [] as string[] },
) {
  return {
    version,
    plan: { requirements, design: "", tasks: "" },
    accepted: { requirements: false, design: false, tasks: false },
    checkpoints,
  };
}

function documentSnapshot(
  version: number,
  requirements: string,
  design: string,
  requirementsAccepted: boolean,
  designCheckpoints: string[] = [],
) {
  return {
    version,
    plan: { requirements, design, tasks: "" },
    accepted: { requirements: requirementsAccepted, design: false, tasks: false },
    checkpoints: { requirements: [], design: designCheckpoints, tasks: [] },
  };
}

const planStages: PlanStage[] = ["requirements", "design", "tasks"];

function acceptedPlanChain(): PlanSession {
  const stage = (name: PlanStage): PlanStageState => ({
    status: "ready",
    accepted: true,
    draft: "",
    error: null,
    runId: null,
    lastRunId: null,
    operation: null,
    checkpoints: [`${name}-v0`],
  });
  return {
    ...baseSession,
    stateVersion: 7,
    activeStage: "tasks",
    conversationStarted: true,
    plan: {
      requirements: "# Requirements\n\nAccepted requirements.",
      design: "# Design\n\nAccepted design.",
      tasks: "# Tasks\n\n- [ ] Accepted task.",
    },
    stages: {
      requirements: stage("requirements"),
      design: stage("design"),
      tasks: stage("tasks"),
    },
  };
}

function pendingPlanSession(): PlanSession {
  const stage = (): PlanStageState => ({
    status: "pending",
    accepted: false,
    draft: "",
    error: null,
    runId: null,
    lastRunId: null,
    operation: null,
    checkpoints: [],
  });
  return {
    ...baseSession,
    plan: { requirements: "", design: "", tasks: "" },
    stages: {
      requirements: stage(),
      design: stage(),
      tasks: stage(),
    },
  };
}

function generationReadyPlan(stage: "requirements" | "design"): PlanSession {
  const session = acceptedPlanChain();
  const start = planStages.indexOf(stage);
  const stages = { ...session.stages };
  for (const current of planStages.slice(start)) {
    stages[current] = {
      ...stages[current],
      accepted: false,
      checkpoints: [],
    };
  }
  return { ...session, activeStage: stage, stages };
}

function planMaterial(session: PlanSession) {
  return {
    plan: { ...session.plan },
    accepted: Object.fromEntries(planStages.map((stage) => [stage, session.stages[stage].accepted])),
    checkpoints: Object.fromEntries(planStages.map((stage) => [stage, [...session.stages[stage].checkpoints]])),
  };
}

function snapshotFromSession(session: PlanSession): PlanStateSnapshot {
  const material = planMaterial(session);
  return {
    version: session.stateVersion,
    plan: material.plan,
    accepted: material.accepted as PlanStateSnapshot["accepted"],
    checkpoints: material.checkpoints as PlanStateSnapshot["checkpoints"],
  };
}

function completedRevisionSnapshot(session: PlanSession, stage: "requirements" | "design"): PlanStateSnapshot {
  const snapshot = snapshotFromSession(session);
  snapshot.version += 1;
  snapshot.checkpoints[stage] = [...snapshot.checkpoints[stage], snapshot.plan[stage]];
  snapshot.plan[stage] = `${snapshot.plan[stage]}\n\nRevised.`;
  snapshot.accepted[stage] = false;
  for (const downstream of planStages.slice(planStages.indexOf(stage) + 1)) {
    snapshot.plan[downstream] = "";
    snapshot.accepted[downstream] = false;
    snapshot.checkpoints[downstream] = [];
  }
  return snapshot;
}

function expectDownstreamPlanMaterialCleared(
  actual: PlanSession,
  before: PlanSession,
  stage: "requirements" | "design",
): void {
  for (const downstream of planStages.slice(planStages.indexOf(stage) + 1)) {
    expect(actual.plan[downstream]).toBe(before.plan[downstream]);
    expect(actual.stages[downstream]).toEqual({
      ...before.stages[downstream],
      accepted: false,
      checkpoints: [],
    });
  }
}

function expectStrictWorkspaceRoundTrip(session: PlanSession): PlanSession {
  const serializedSession = JSON.parse(JSON.stringify(session)) as PlanSession;
  const parsed = parsePlanBootstrapSession(serializedSession);
  const persisted = JSON.parse(JSON.stringify(normalizeWorkspaceState({
    sessions: [serializedSession],
  } as unknown as Partial<WorkspaceState>))) as WorkspaceState;
  const reopenedWorkspace = normalizeWorkspaceState(persisted);
  const reopened = reopenedWorkspace.sessions[0];
  expect(reopened?.kind).toBe("plan");
  if (reopened?.kind !== "plan") throw new Error("Plan session did not reopen.");
  expect(parsePlanBootstrapSession(reopened).snapshot).toEqual(parsed.snapshot);
  return reopened;
}

async function reopenAndRetryFailedPlan(
  session: PlanSession,
  terminal: Extract<PlanEvent, { kind: "failed" }>,
) {
  const parsed = parsePlanBootstrapSession(session);
  const persisted = JSON.parse(JSON.stringify(normalizeWorkspaceState({
    sessions: [session],
  } as unknown as Partial<WorkspaceState>))) as WorkspaceState;
  const reopenedWorkspace = normalizeWorkspaceState(persisted);
  const reopenedSession = reopenedWorkspace.sessions[0];
  expect(reopenedSession?.kind).toBe("plan");
  if (reopenedSession?.kind !== "plan") throw new Error("Plan session did not reopen.");
  expect(parsePlanBootstrapSession(reopenedSession)).toEqual(parsed);
  const reopened = reconcilePlanRuntimeState(reopenedSession, {
    protocolVersion: 1,
    needsBootstrap: false,
    snapshot: parsed.snapshot,
    active: null,
    terminal,
  });
  const calls: string[] = [];
  let live = reopened;
  const adapter = {
    updateStage: async () => {
      calls.push(`update:${reopened.stages.requirements.operation}`);
      return { protocolVersion: 1 as const, snapshot: terminal.snapshot };
    },
    generate: async () => {
      calls.push("generate");
      return {
        protocolVersion: 1 as const,
        planSessionId: reopened.id,
        runId: "run-retry-generate",
        stage: "requirements" as const,
        operation: "generate" as const,
        duplicate: false,
      };
    },
    revise: async () => {
      calls.push("revise");
      return {
        protocolVersion: 1 as const,
        planSessionId: reopened.id,
        runId: "run-retry-revise",
        stage: "requirements" as const,
        operation: "revise" as const,
        duplicate: false,
      };
    },
  };
  const queue = createPlanMutationQueue(adapter as never, () => live, (next) => { live = next; });
  if (reopened.stages.requirements.operation === "revise") {
    await queue.revise("/repo", reopened.id, "requirements", reopened.goal, "Retry revision.");
  } else {
    await queue.generate("/repo", reopened.id, "requirements", reopened.goal);
  }
  return { reopened, calls };
}
