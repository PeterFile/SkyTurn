import { describe, expect, it } from "vitest";

import {
  emptyPlanCheckpointState,
  makeHermesPlanConversationId,
  parsePlanCheckpointState,
} from "./index.js";
import * as projectCore from "./index.js";

type BootstrapParser = (value: unknown) => {
  schemaVersion: 0 | 1;
  snapshot: unknown;
};

function planBootstrapParser(): BootstrapParser {
  const parser = Reflect.get(projectCore, "parsePlanBootstrapSession") as BootstrapParser | undefined;
  expect(parser).toBeTypeOf("function");
  return parser!;
}

function baseLegacyPlanSession() {
  return {
    id: "plan-legacy",
    projectId: "project-1",
    title: "Legacy Plan",
    goal: "Keep the exact base Plan",
    mode: "plan",
    kind: "plan",
    target: { executionTarget: "current_branch", selectedBranch: "main" },
    createdAt: "2026-07-15T00:00:00.000Z",
    updatedAt: "2026-07-15T00:00:00.000Z",
    plan: {
      requirements: "# Requirements\n\nExact requirements.",
      design: "# Design\n\nExact design.",
      tasks: "# Tasks\n\n- [ ] Exact task.",
    },
    nodes: [],
    edges: [],
    activeNodeId: null,
  };
}

function currentPlanSession() {
  const readyStage = {
    status: "ready",
    accepted: true,
    draft: "",
    error: null,
    runId: null,
    lastRunId: null,
    operation: null,
    checkpoints: [],
  };
  return {
    ...baseLegacyPlanSession(),
    stateVersion: 12,
    activeStage: "tasks",
    plannerConversationId: "hermes-plan-plan-legacy",
    conversationStarted: true,
    stages: {
      requirements: { ...readyStage, checkpoints: ["requirements-v0"] },
      design: { ...readyStage, checkpoints: ["design-v0"] },
      tasks: { ...readyStage, checkpoints: ["tasks-v0"] },
    },
  };
}

describe("Plan public identity", () => {
  it("strictly migrates the exact base Plan shape without runtime fields", () => {
    expect(planBootstrapParser()(baseLegacyPlanSession())).toEqual({
      schemaVersion: 0,
      snapshot: {
        version: 0,
        plan: {
          requirements: "# Requirements\n\nExact requirements.",
          design: "# Design\n\nExact design.",
          tasks: "# Tasks\n\n- [ ] Exact task.",
        },
        accepted: { requirements: false, design: false, tasks: false },
        checkpoints: { requirements: [], design: [], tasks: [] },
      },
    });
  });

  it("preserves exact legacy downstream drafts when Requirements is blank", () => {
    const session = baseLegacyPlanSession();
    session.plan.requirements = "";

    expect(planBootstrapParser()(session)).toEqual({
      schemaVersion: 0,
      snapshot: {
        version: 0,
        plan: {
          requirements: "",
          design: "# Design\n\nExact design.",
          tasks: "# Tasks\n\n- [ ] Exact task.",
        },
        accepted: { requirements: false, design: false, tasks: false },
        checkpoints: { requirements: [], design: [], tasks: [] },
      },
    });
  });

  it("preserves one valid current persisted Plan snapshot exactly", () => {
    expect(planBootstrapParser()(currentPlanSession())).toEqual({
      schemaVersion: 1,
      snapshot: {
        version: 12,
        plan: currentPlanSession().plan,
        accepted: { requirements: true, design: true, tasks: true },
        checkpoints: {
          requirements: ["requirements-v0"],
          design: ["design-v0"],
          tasks: ["tasks-v0"],
        },
      },
    });
  });

  it("strictly preserves failed generate and accepted failed revise bootstrap states", () => {
    const failedGenerate = currentPlanSession();
    failedGenerate.stages.tasks = {
      ...failedGenerate.stages.tasks,
      status: "failed",
      accepted: false,
      error: "Hermes ACP prompt failed.",
      operation: "generate",
    };
    expect(planBootstrapParser()(failedGenerate)).toMatchObject({
      schemaVersion: 1,
      snapshot: { accepted: { tasks: false } },
    });

    const failedRevise = currentPlanSession();
    failedRevise.stages.tasks = {
      ...failedRevise.stages.tasks,
      status: "failed",
      accepted: true,
      error: "Hermes ACP prompt failed.",
      operation: "revise",
    };
    expect(planBootstrapParser()(failedRevise)).toMatchObject({
      schemaVersion: 1,
      snapshot: {
        plan: { tasks: failedRevise.plan.tasks },
        accepted: { tasks: true },
        checkpoints: { tasks: ["tasks-v0"] },
      },
    });
  });

  it.each([
    ["blank failure error", () => {
      const session = currentPlanSession();
      session.stages.tasks = {
        ...session.stages.tasks, status: "failed", accepted: false, error: " ", operation: "generate",
      };
      return session;
    }],
    ["missing failure operation", () => {
      const session = currentPlanSession();
      session.stages.tasks = {
        ...session.stages.tasks, status: "failed", accepted: false, error: "failed", operation: null,
      };
      return session;
    }],
    ["accepted failed generate", () => {
      const session = currentPlanSession();
      session.stages.tasks = {
        ...session.stages.tasks, status: "failed", accepted: true, error: "failed", operation: "generate",
      };
      return session;
    }],
    ["accepted failed revise without Markdown", () => {
      const session = currentPlanSession();
      session.plan.tasks = "";
      session.stages.tasks = {
        ...session.stages.tasks, status: "failed", accepted: true, error: "failed", operation: "revise",
      };
      return session;
    }],
  ])("rejects a nonsensical failed Plan bootstrap stage: %s", (_label, createSession) => {
    expect(() => planBootstrapParser()(createSession())).toThrow("Plan bootstrap session is invalid.");
  });

  it.each([
    ["wrong document type", () => ({
      ...currentPlanSession(),
      plan: { ...currentPlanSession().plan, design: 7 },
    })],
    ["numeric checkpoint", () => ({
      ...currentPlanSession(),
      stages: {
        ...currentPlanSession().stages,
        tasks: { ...currentPlanSession().stages.tasks, checkpoints: ["tasks-v0", 1] },
      },
    })],
    ["invalid accepted flag", () => ({
      ...currentPlanSession(),
      stages: {
        ...currentPlanSession().stages,
        tasks: { ...currentPlanSession().stages.tasks, accepted: "yes" },
      },
    })],
    ["invalid stage status", () => ({
      ...currentPlanSession(),
      stages: {
        ...currentPlanSession().stages,
        tasks: { ...currentPlanSession().stages.tasks, status: "complete" },
      },
    })],
    ["invalid runtime field", () => ({
      ...currentPlanSession(),
      stages: {
        ...currentPlanSession().stages,
        tasks: { ...currentPlanSession().stages.tasks, runId: 99 },
      },
    })],
    ["impossible dependency", () => ({
      ...currentPlanSession(),
      stages: {
        ...currentPlanSession().stages,
        requirements: { ...currentPlanSession().stages.requirements, accepted: false },
      },
    })],
    ["legacy runtime field collision", () => ({
      ...baseLegacyPlanSession(),
      stateVersion: 0,
    })],
  ])("rejects a malformed bootstrap session: %s", (_label, createSession) => {
    expect(() => planBootstrapParser()(createSession())).toThrow("Plan bootstrap session is invalid.");
  });

  it("derives a stable non-capability Hermes conversation identity", () => {
    expect(makeHermesPlanConversationId("plan-202607160945")).toBe(
      "hermes-plan-plan-202607160945",
    );
  });

  it("strictly parses bounded Plan checkpoint state", () => {
    const checkpoints = {
      requirements: ["# Requirements\n\nv0"],
      design: ["# Design\n\nv0"],
      tasks: Array.from({ length: 20 }, (_, index) => `# Tasks ${index}`),
    };

    expect(parsePlanCheckpointState(checkpoints)).toEqual(checkpoints);
    expect(parsePlanCheckpointState(checkpoints)).not.toBe(checkpoints);
    expect(emptyPlanCheckpointState()).toEqual({ requirements: [], design: [], tasks: [] });
  });

  it.each([
    null,
    {},
    { requirements: [], design: [], tasks: "invalid" },
    { requirements: ["valid", 1], design: [], tasks: [] },
    { requirements: [""], design: [], tasks: [] },
    { requirements: [" \n\t "], design: [], tasks: [] },
    { requirements: Array.from({ length: 21 }, () => "bounded"), design: [], tasks: [] },
    { requirements: ["x".repeat(2_000_001)], design: [], tasks: [] },
  ])("fails closed for malformed or unbounded checkpoint state", (value) => {
    expect(() => parsePlanCheckpointState(value)).toThrow("Plan checkpoint state is invalid.");
  });

  it("strictly parses one bounded authoritative Plan snapshot", () => {
    const parse = (projectCore as unknown as {
      parsePlanStateSnapshot?: (value: unknown) => unknown;
    }).parsePlanStateSnapshot;
    expect(typeof parse).toBe("function");
    if (!parse) return;

    const snapshot = {
      version: 7,
      plan: { requirements: "requirements-v2", design: "design-v1", tasks: "" },
      accepted: { requirements: true, design: false, tasks: false },
      checkpoints: { requirements: ["requirements-v0", "requirements-v1"], design: [], tasks: [] },
    };
    expect(parse(snapshot)).toEqual(snapshot);
    expect(() => parse({ ...snapshot, unknown: true })).toThrow("Plan state snapshot is invalid.");
    expect(() => parse({ ...snapshot, version: Number.NaN })).toThrow("Plan state snapshot is invalid.");
    expect(() => parse({ ...snapshot, version: -1 })).toThrow("Plan state snapshot is invalid.");
    expect(() => parse({
      ...snapshot,
      accepted: { requirements: false, design: true, tasks: false },
    })).toThrow("Plan state snapshot is invalid.");
    expect(() => parse({
      ...snapshot,
      accepted: { requirements: true, design: true, tasks: false },
      plan: { ...snapshot.plan, design: "" },
    })).toThrow("Plan state snapshot is invalid.");
  });

  it.each([
    {
      label: "accepted blank Requirements",
      snapshot: {
        version: 1,
        plan: { requirements: " \n\t ", design: "", tasks: "" },
        accepted: { requirements: true, design: false, tasks: false },
        checkpoints: { requirements: [], design: [], tasks: [] },
      },
    },
    {
      label: "Design checkpoints without accepted Requirements",
      snapshot: {
        version: 1,
        plan: { requirements: "requirements", design: "", tasks: "" },
        accepted: { requirements: false, design: false, tasks: false },
        checkpoints: { requirements: [], design: ["design v0"], tasks: [] },
      },
    },
    {
      label: "Tasks checkpoints without nonblank accepted upstream stages",
      snapshot: {
        version: 1,
        plan: { requirements: "requirements", design: "", tasks: "" },
        accepted: { requirements: true, design: false, tasks: false },
        checkpoints: { requirements: [], design: [], tasks: ["tasks v0"] },
      },
    },
  ])("rejects $label with one fixed public error", ({ snapshot }) => {
    expect(() => projectCore.parsePlanStateSnapshot(snapshot)).toThrow(
      new Error("Plan state snapshot is invalid."),
    );
  });

  it("allows exact unapproved downstream drafts while keeping approvals strict", () => {
    const snapshot = {
      version: 2,
      plan: { requirements: "", design: "design draft", tasks: "tasks draft" },
      accepted: { requirements: false, design: false, tasks: false },
      checkpoints: { requirements: [], design: [], tasks: [] },
    };

    expect(projectCore.parsePlanStateSnapshot(snapshot)).toEqual(snapshot);
    expect(() => projectCore.parsePlanStateSnapshot({
      ...snapshot,
      accepted: { requirements: false, design: true, tasks: false },
    })).toThrow("Plan state snapshot is invalid.");
  });

  it.each([
    {
      version: 3,
      plan: { requirements: "", design: "", tasks: "" },
      accepted: { requirements: false, design: false, tasks: false },
      checkpoints: { requirements: ["requirements v0"], design: [], tasks: [] },
    },
    {
      version: 4,
      plan: { requirements: "requirements", design: "", tasks: "" },
      accepted: { requirements: true, design: false, tasks: false },
      checkpoints: { requirements: [], design: ["design v0"], tasks: [] },
    },
    {
      version: 5,
      plan: { requirements: "requirements", design: "design", tasks: "" },
      accepted: { requirements: true, design: true, tasks: false },
      checkpoints: { requirements: [], design: [], tasks: ["tasks v0"] },
    },
  ])("allows a blank current stage to retain its own Undo checkpoints", (snapshot) => {
    expect(projectCore.parsePlanStateSnapshot(snapshot)).toEqual(snapshot);
  });

  it("derives an exact current bootstrap snapshot from a persisted Plan", () => {
    const derive = Reflect.get(projectCore, "derivePlanBootstrapSnapshot") as undefined | ((session: unknown) => unknown);
    expect(derive).toBeTypeOf("function");
    if (!derive) return;
    const readyStage = {
      status: "ready",
      accepted: true,
      draft: "",
      error: null,
      runId: null,
      lastRunId: null,
      operation: null,
      checkpoints: [],
    };
    const snapshot = derive({
      id: "plan-legacy",
      projectId: "project-1",
      title: "Legacy Plan",
      goal: "Keep the approved legacy plan",
      mode: "plan",
      kind: "plan",
      target: { executionTarget: "current_branch", selectedBranch: "main" },
      createdAt: "2026-07-15T00:00:00.000Z",
      updatedAt: "2026-07-15T00:00:00.000Z",
      plan: {
        requirements: "# Requirements\n\nExact requirements.",
        design: "# Design\n\nExact design.",
        tasks: "# Tasks\n\n- [ ] Exact task.",
      },
      stateVersion: 19,
      activeStage: "tasks",
      plannerConversationId: "hermes-plan-plan-legacy",
      conversationStarted: true,
      stages: {
        requirements: { ...readyStage, checkpoints: ["requirements-v0"] },
        design: { ...readyStage, checkpoints: ["design-v0"] },
        tasks: { ...readyStage, checkpoints: ["tasks-v0"] },
      },
      nodes: [],
      edges: [],
      activeNodeId: null,
    });

    expect(snapshot).toEqual({
      version: 19,
      plan: {
        requirements: "# Requirements\n\nExact requirements.",
        design: "# Design\n\nExact design.",
        tasks: "# Tasks\n\n- [ ] Exact task.",
      },
      accepted: { requirements: true, design: true, tasks: true },
      checkpoints: {
        requirements: ["requirements-v0"],
        design: ["design-v0"],
        tasks: ["tasks-v0"],
      },
    });
  });

  it("fails closed when legacy Plan dependencies are semantically malformed", () => {
    const derive = Reflect.get(projectCore, "derivePlanBootstrapSnapshot") as undefined | ((session: unknown) => unknown);
    expect(derive).toBeTypeOf("function");
    if (!derive) return;
    const stage = {
      status: "ready",
      accepted: false,
      draft: "",
      error: null,
      runId: null,
      lastRunId: null,
      operation: null,
      checkpoints: [],
    };

    expect(() => derive({
      kind: "plan",
      plan: { requirements: "requirements", design: "design", tasks: "" },
      stages: {
        requirements: stage,
        design: stage,
        tasks: { ...stage, status: "pending" },
      },
    })).toThrow("Plan state snapshot is invalid.");
  });
});
