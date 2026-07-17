import assert from "node:assert/strict";
import * as realFs from "node:fs/promises";
import { mkdir, mkdtemp, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import vm from "node:vm";

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const require = createRequire(import.meta.url);

test("Plan IPC contracts strictly parse runs, transitions, cancel, and state requests", async () => {
  const contracts = await loadContracts();
  assert.deepEqual(toPlain(contracts.parsePlanGenerateRequest({
    operation: "generate",
    planSessionId: "plan-1",
    projectRoot: "/repo",
    stage: "design",
    goal: "Build it",
    expectedStateVersion: 3,
  })), {
    operation: "generate",
    planSessionId: "plan-1",
    projectRoot: "/repo",
    stage: "design",
    goal: "Build it",
    expectedStateVersion: 3,
  });
  assert.equal(contracts.parsePlanReviseRequest({
    operation: "revise",
    planSessionId: "plan-1",
    projectRoot: "/repo",
    stage: "requirements",
    goal: "Build it",
    expectedStateVersion: 3,
    instruction: "Add recovery.",
  }).instruction, "Add recovery.");
  assert.deepEqual(toPlain(contracts.parsePlanUpdateStageRequest({
    planSessionId: "plan-1",
    projectRoot: "/repo",
    stage: "requirements",
    expectedStateVersion: 3,
    markdown: "# Explicit edit",
  })), {
    planSessionId: "plan-1",
    projectRoot: "/repo",
    stage: "requirements",
    expectedStateVersion: 3,
    markdown: "# Explicit edit",
  });
  for (const parser of [contracts.parsePlanAcceptStageRequest, contracts.parsePlanUndoStageRequest]) {
    assert.deepEqual(toPlain(parser({
      planSessionId: "plan-1",
      projectRoot: "/repo",
      stage: "requirements",
      expectedStateVersion: 3,
    })), {
      planSessionId: "plan-1",
      projectRoot: "/repo",
      stage: "requirements",
      expectedStateVersion: 3,
    });
  }
  assert.deepEqual(toPlain(contracts.parsePlanCancelRequest({
    planSessionId: "plan-1",
    projectRoot: "/repo",
    runId: "run-1",
  })), {
    planSessionId: "plan-1",
    projectRoot: "/repo",
    runId: "run-1",
  });
  assert.deepEqual(toPlain(contracts.parsePlanGetStateRequest({
    planSessionId: "plan-1",
    projectRoot: "/repo",
  })), {
    planSessionId: "plan-1",
    projectRoot: "/repo",
  });
  assert.deepEqual(toPlain(contracts.parsePlanBootstrapRequest({
    planSessionId: "plan-1",
    projectRoot: "/repo",
  })), {
    planSessionId: "plan-1",
    projectRoot: "/repo",
  });
  for (const forbidden of ["snapshot", "plan", "markdown", "accepted", "checkpoints", "currentHead", "stateVersion"]) {
    assert.throws(() => contracts.parsePlanBootstrapRequest({
      planSessionId: "plan-1",
      projectRoot: "/repo",
      [forbidden]: forbidden === "stateVersion" ? 0 : "forged",
    }), /invalid/i);
  }

  assert.throws(() => contracts.parsePlanGenerateRequest({}), /invalid/i);
  const validRevise = {
    operation: "revise",
    planSessionId: "plan-1",
    projectRoot: "/repo",
    stage: "requirements",
    goal: "Build it",
    expectedStateVersion: 3,
    instruction: "Change it.",
  };
  for (const forbidden of ["currentMarkdown", "requirements", "design", "conversationStarted", "rawAcpSessionId", "unknown"]) {
    assert.throws(() => contracts.parsePlanReviseRequest({ ...validRevise, [forbidden]: "forged" }), /invalid/i);
  }
  for (const version of [Number.NaN, Number.POSITIVE_INFINITY, -1, 1.5]) {
    assert.throws(() => contracts.parsePlanReviseRequest({ ...validRevise, expectedStateVersion: version }), /invalid/i);
  }
  assert.throws(() => contracts.parsePlanReviseRequest({ ...validRevise, planSessionId: " plan-1" }), /invalid/i);
  assert.throws(() => contracts.parsePlanReviseRequest({ ...validRevise, projectRoot: "/repo " }), /invalid/i);
  for (const [parser, request] of [
    [contracts.parsePlanGenerateRequest, {
      operation: "generate", planSessionId: "plan-1", projectRoot: "/repo",
      stage: "requirements", goal: "Goal", expectedStateVersion: 0,
    }],
    [contracts.parsePlanUpdateStageRequest, {
      planSessionId: "plan-1", projectRoot: "/repo", stage: "requirements",
      expectedStateVersion: 0, markdown: "",
    }],
    [contracts.parsePlanAcceptStageRequest, {
      planSessionId: "plan-1", projectRoot: "/repo", stage: "requirements", expectedStateVersion: 0,
    }],
    [contracts.parsePlanUndoStageRequest, {
      planSessionId: "plan-1", projectRoot: "/repo", stage: "requirements", expectedStateVersion: 0,
    }],
    [contracts.parsePlanCancelRequest, { planSessionId: "plan-1", projectRoot: "/repo", runId: "run-1" }],
    [contracts.parsePlanGetStateRequest, { planSessionId: "plan-1", projectRoot: "/repo" }],
  ]) {
    assert.throws(() => parser({ ...request, unknown: true }), /invalid/i);
  }
});

test("invalid Plan revise prerequisites never acquire or call the runtime", async () => {
  let factoryCalls = 0;
  let reviseCalls = 0;
  const { exports, ipcHandlers } = await loadMainModule([], {
    createPlanRuntime: () => {
      factoryCalls += 1;
      return {
        revise: async () => {
          reviseCalls += 1;
        },
      };
    },
  });
  exports.openedProjectRoots.add("/repo");
  const revise = ipcHandlers.get("plan:revise");

  await assert.rejects(revise({}, {
    operation: "revise",
    planSessionId: "plan-1",
    projectRoot: "/repo",
    stage: "design",
    goal: "Build it",
    conversationStarted: false,
    requirements: " ",
    design: "",
    currentMarkdown: "# Design",
    instruction: "Change it.",
  }), /invalid/i);
  assert.equal(factoryCalls, 0);
  assert.equal(reviseCalls, 0);
});

test("preload and Electron main expose only typed Plan operations and events", async () => {
  const [preload, main] = await Promise.all([
    readFile(join(root, "electron", "preload.ts"), "utf8"),
    readFile(join(root, "electron", "main.ts"), "utf8"),
  ]);

  assert.match(preload, /const plan = \{/);
  assert.match(preload, /satisfies PlanApi/);
  assert.match(preload, /onPlanEvent:/);
  assert.doesNotMatch(preload, /acpSessionId|rawAcpSessionId|resumeHandle/);
  for (const channel of [
    "plan:generate",
    "plan:revise",
    "plan:updateStage",
    "plan:acceptStage",
    "plan:undoStage",
    "plan:cancel",
    "plan:getState",
    "plan:bootstrap",
  ]) {
    assert.match(main, new RegExp(`ipcMain\\.handle\\("${channel.replace(":", "\\:")}"`));
  }
  assert.match(main, /window\.webContents\.send\("plan:event", event\)/);
  assert.match(main, /canonicalizePlanRequest\(request\)/);
  assert.match(main, /getPlanRuntime\(\)\.(generate|revise)\(await canonicalizePlanRequest\(request\)\)/);
  assert.match(main, /getPlanRuntime\(\)\.cancel\(await canonicalizePlanCancelRequest\(request\)\)/);
});

test("workspace load bootstraps active and inactive raw Plans before an immediate normalized save", async () => {
  const userDataPath = await mkdtemp(join(tmpdir(), "skyturn-plan-bootstrap-ipc-"));
  const projectRoot = join(userDataPath, "project");
  const planSessionId = "plan-legacy";
  const workspace = legacyPlanWorkspace(projectRoot, planSessionId);
  const inactive = structuredClone(workspace.sessions[0]);
  inactive.id = "plan-inactive";
  inactive.title = "Inactive Plan";
  inactive.goal = "Keep the inactive legacy Plan";
  inactive.plan = {
    requirements: "",
    design: "# Design\n\nInactive legacy design.",
    tasks: "# Tasks\n\n- [ ] Inactive legacy task.",
  };
  workspace.sessions.push(inactive);
  const durableSnapshots = new Map();
  const bootstrapCalls = [];
  try {
    await mkdir(projectRoot);
    await writeFile(join(userDataPath, "workspace.json"), JSON.stringify(workspace, null, 2), "utf8");
    const { ipcHandlers } = await loadMainModule([], {
      userDataPath,
      createPlanRuntime: () => ({
        async getState(request) {
          const snapshot = durableSnapshots.get(request.planSessionId);
          return {
            protocolVersion: 1,
            needsBootstrap: snapshot === undefined,
            snapshot: snapshot ?? {
              version: 0,
              plan: { requirements: "", design: "", tasks: "" },
              accepted: { requirements: false, design: false, tasks: false },
              checkpoints: { requirements: [], design: [], tasks: [] },
            },
            active: null,
            terminal: null,
          };
        },
        async bootstrap(request, snapshot) {
          bootstrapCalls.push({ request, snapshot });
          durableSnapshots.set(request.planSessionId, snapshot);
          return { protocolVersion: 1, needsBootstrap: false, snapshot, active: null, terminal: null };
        },
      }),
    });
    const loaded = await ipcHandlers.get("workspace:load")();
    assert.equal(durableSnapshots.size, 2);
    assert.equal(bootstrapCalls.length, 2);
    assert.deepEqual(toPlain(durableSnapshots.get("plan-inactive")), {
      version: 0,
      plan: inactive.plan,
      accepted: { requirements: false, design: false, tasks: false },
      checkpoints: { requirements: [], design: [], tasks: [] },
    });

    const persistence = await import("@skyturn/persistence");
    const normalized = persistence.normalizeWorkspaceState(toPlain(loaded));
    await ipcHandlers.get("workspace:save")({}, normalized);
    const request = { planSessionId, projectRoot };
    const bootstrapped = await ipcHandlers.get("plan:bootstrap")({}, request);

    assert.deepEqual(toPlain(bootstrapped.snapshot), {
      version: 0,
      plan: {
        requirements: "# Requirements\n\nLegacy requirements.",
        design: "# Design\n\nLegacy design.",
        tasks: "# Tasks\n\n- [ ] Legacy task.",
      },
      accepted: { requirements: false, design: false, tasks: false },
      checkpoints: {
        requirements: [],
        design: [],
        tasks: [],
      },
    });
    assert.equal(bootstrapCalls.length, 2);
    assert.deepEqual(Object.keys(bootstrapCalls[0].request).sort(), ["planSessionId", "projectRoot"]);
    await assert.rejects(ipcHandlers.get("plan:bootstrap")({}, {
      ...request,
      snapshot: { plan: { requirements: "forged renderer content" } },
    }), /invalid/i);
    assert.equal(bootstrapCalls.length, 2);
  } finally {
    await rm(userDataPath, { recursive: true, force: true });
  }
});

test("Plan bootstrap preserves one valid current persisted snapshot exactly", async () => {
  const userDataPath = await mkdtemp(join(tmpdir(), "skyturn-plan-bootstrap-current-"));
  const projectRoot = join(userDataPath, "project");
  const planSessionId = "plan-current";
  const workspace = currentPlanWorkspace(projectRoot, planSessionId);
  let bootstrapCalls = 0;
  let durableSnapshot;
  try {
    await mkdir(projectRoot);
    await writeFile(join(userDataPath, "workspace.json"), JSON.stringify(workspace, null, 2), "utf8");
    const { ipcHandlers } = await loadMainModule([], {
      userDataPath,
      createPlanRuntime: () => ({
        async getState() {
          return {
            protocolVersion: 1,
            needsBootstrap: durableSnapshot === undefined,
            snapshot: durableSnapshot ?? {
              version: 0,
              plan: { requirements: "", design: "", tasks: "" },
              accepted: { requirements: false, design: false, tasks: false },
              checkpoints: { requirements: [], design: [], tasks: [] },
            },
            active: null,
            terminal: null,
          };
        },
        async bootstrap(_request, snapshot) {
          bootstrapCalls += 1;
          durableSnapshot = snapshot;
          return { protocolVersion: 1, needsBootstrap: false, snapshot, active: null, terminal: null };
        },
      }),
    });
    await ipcHandlers.get("workspace:load")();

    const result = await ipcHandlers.get("plan:bootstrap")({}, { planSessionId, projectRoot });
    assert.deepEqual(toPlain(result.snapshot), {
      version: 12,
      plan: workspace.sessions[0].plan,
      accepted: { requirements: true, design: true, tasks: true },
      checkpoints: {
        requirements: ["requirements-v0"],
        design: ["design-v0"],
        tasks: ["tasks-v0"],
      },
    });
    assert.equal(bootstrapCalls, 1);
  } finally {
    await rm(userDataPath, { recursive: true, force: true });
  }
});

test("workspace save and reopen bootstrap failed Plan operations for the correct retry", async () => {
  const userDataPath = await mkdtemp(join(tmpdir(), "skyturn-plan-failed-retry-bootstrap-"));
  const projectRoot = join(userDataPath, "project");
  const workspace = currentPlanWorkspace(projectRoot, "plan-failed-generate");
  const failedGenerate = workspace.sessions[0];
  const pendingStage = {
    status: "pending",
    accepted: false,
    draft: "",
    error: null,
    runId: null,
    lastRunId: null,
    operation: null,
    checkpoints: [],
  };
  Object.assign(failedGenerate, {
    stateVersion: 0,
    activeStage: "requirements",
    conversationStarted: false,
    plan: { requirements: "", design: "", tasks: "" },
    stages: {
      requirements: {
        ...pendingStage,
        status: "failed",
        error: "Hermes ACP prompt failed.",
        lastRunId: "run-failed-generate",
        operation: "generate",
      },
      design: { ...pendingStage },
      tasks: { ...pendingStage },
    },
  });
  const failedRevise = structuredClone(currentPlanWorkspace(projectRoot, "plan-failed-revise").sessions[0]);
  failedRevise.stages.tasks = {
    ...failedRevise.stages.tasks,
    status: "failed",
    accepted: true,
    error: "Hermes ACP prompt failed.",
    lastRunId: "run-failed-revise",
    operation: "revise",
  };
  workspace.sessions.push(failedRevise);
  const durableSnapshots = new Map();
  const runtime = {
    async getState(request) {
      const snapshot = durableSnapshots.get(request.planSessionId);
      return {
        protocolVersion: 1,
        needsBootstrap: snapshot === undefined,
        snapshot: snapshot ?? {
          version: 0,
          plan: { requirements: "", design: "", tasks: "" },
          accepted: { requirements: false, design: false, tasks: false },
          checkpoints: { requirements: [], design: [], tasks: [] },
        },
        active: null,
        terminal: null,
      };
    },
    async bootstrap(request, snapshot) {
      durableSnapshots.set(request.planSessionId, snapshot);
      return { protocolVersion: 1, needsBootstrap: false, snapshot, active: null, terminal: null };
    },
    async close() {},
  };
  try {
    await mkdir(projectRoot);
    const first = await loadMainModule([], { userDataPath, createPlanRuntime: () => runtime });
    first.exports.openedProjectRoots.add(projectRoot);
    await first.ipcHandlers.get("workspace:save")({}, workspace);

    const reopened = await loadMainModule([], { userDataPath, createPlanRuntime: () => runtime });
    const loaded = await reopened.ipcHandlers.get("workspace:load")();
    assert.equal(loaded.sessions[0].stages.requirements.operation, "generate");
    assert.equal(loaded.sessions[1].stages.tasks.operation, "revise");
    assert.equal(loaded.sessions[1].stages.tasks.accepted, true);
    assert.deepEqual(toPlain(durableSnapshots.get("plan-failed-generate")), {
      version: 0,
      plan: { requirements: "", design: "", tasks: "" },
      accepted: { requirements: false, design: false, tasks: false },
      checkpoints: { requirements: [], design: [], tasks: [] },
    });
    assert.deepEqual(toPlain(durableSnapshots.get("plan-failed-revise")), {
      version: 12,
      plan: failedRevise.plan,
      accepted: { requirements: true, design: true, tasks: true },
      checkpoints: {
        requirements: ["requirements-v0"],
        design: ["design-v0"],
        tasks: ["tasks-v0"],
      },
    });
    await reopened.exports.closeWorkflowStores();
  } finally {
    await rm(userDataPath, { recursive: true, force: true });
  }
});

test("workspace load keeps existing valid private Plan state authoritative over stale workspace bytes", async () => {
  const userDataPath = await mkdtemp(join(tmpdir(), "skyturn-plan-bootstrap-authority-"));
  const projectRoot = join(userDataPath, "project");
  const planSessionId = "plan-authoritative";
  const workspace = currentPlanWorkspace(projectRoot, planSessionId);
  const authoritative = {
    protocolVersion: 1,
    needsBootstrap: false,
    snapshot: {
      version: 19,
      plan: {
        requirements: "# Requirements\n\nPrivate authority.",
        design: "",
        tasks: "",
      },
      accepted: { requirements: true, design: false, tasks: false },
      checkpoints: { requirements: ["requirements-v18"], design: [], tasks: [] },
    },
    active: null,
    terminal: null,
  };
  let bootstrapCalls = 0;
  try {
    await mkdir(projectRoot);
    await writeFile(join(userDataPath, "workspace.json"), JSON.stringify(workspace, null, 2), "utf8");
    const { ipcHandlers } = await loadMainModule([], {
      userDataPath,
      createPlanRuntime: () => ({
        async getState() {
          return authoritative;
        },
        async bootstrap() {
          bootstrapCalls += 1;
          throw new Error("stale workspace bytes were compared");
        },
      }),
    });

    await ipcHandlers.get("workspace:load")();
    const recovered = await ipcHandlers.get("plan:bootstrap")({}, { planSessionId, projectRoot });
    assert.deepEqual(toPlain(recovered), authoritative);
    assert.equal(bootstrapCalls, 0);
  } finally {
    await rm(userDataPath, { recursive: true, force: true });
  }
});

test("malformed and duplicate raw Plan bootstrap identities fail before runtime bootstrap or state writes", async () => {
  const cases = [
    ["numeric checkpoint", (workspace) => {
      workspace.sessions[0].stages.tasks.checkpoints.push(7);
    }],
    ["wrong document type", (workspace) => {
      workspace.sessions[0].plan.design = 7;
    }],
    ["malformed target", (workspace) => {
      workspace.sessions[0].target.selectedBranch = 7;
    }],
    ["duplicate session", (workspace) => {
      workspace.sessions.push(structuredClone(workspace.sessions[0]));
    }],
    ["duplicate project", (workspace) => {
      workspace.projects.push(structuredClone(workspace.projects[0]));
    }],
  ];

  for (const [label, mutate] of cases) {
    const userDataPath = await mkdtemp(join(tmpdir(), "skyturn-plan-bootstrap-invalid-"));
    const projectRoot = join(userDataPath, "project");
    const planSessionId = `plan-${label.replaceAll(" ", "-")}`;
    const workspace = currentPlanWorkspace(projectRoot, planSessionId);
    mutate(workspace);
    const originalBytes = JSON.stringify(workspace, null, 2);
    let getStateCalls = 0;
    let bootstrapCalls = 0;
    let workspaceWrites = 0;
    try {
      await mkdir(projectRoot);
      await writeFile(join(userDataPath, "workspace.json"), originalBytes, "utf8");
      const { ipcHandlers } = await loadMainModule([], {
        userDataPath,
        fsPromises: instrumentWorkspaceWrites({ onPayload: () => { workspaceWrites += 1; } }),
        createPlanRuntime: () => ({
          async getState() {
            getStateCalls += 1;
            return { needsBootstrap: true };
          },
          async bootstrap() {
            bootstrapCalls += 1;
          },
        }),
      });
      let loaded;
      await assert.rejects(
        async () => { loaded = await ipcHandlers.get("workspace:load")(); },
        /^Error: Workspace could not be loaded\.$/,
        label,
      );
      if (loaded !== undefined) await ipcHandlers.get("workspace:save")({}, loaded);
      assert.equal(getStateCalls, 0, label);
      assert.equal(bootstrapCalls, 0, label);
      assert.equal(workspaceWrites, 0, label);
      assert.equal(await readFile(join(userDataPath, "workspace.json"), "utf8"), originalBytes, label);
      await assert.rejects(stat(join(userDataPath, "plan-acp-sessions")), { code: "ENOENT" }, label);
    } finally {
      await rm(userDataPath, { recursive: true, force: true });
    }
  }
});

test("workspace load rejects Plan discriminator disagreement without persistence side effects", async () => {
  const userDataPath = await mkdtemp(join(tmpdir(), "skyturn-plan-bootstrap-discriminator-"));
  const projectRoot = join(userDataPath, "project");
  const workspace = legacyPlanWorkspace(projectRoot, "plan-disagreement");
  workspace.sessions[0].kind = "canvas";
  const originalBytes = JSON.stringify(workspace, null, 2);
  let runtimeFactoryCalls = 0;
  let workspaceWrites = 0;
  let workspaceRenames = 0;
  try {
    await mkdir(projectRoot);
    await writeFile(join(userDataPath, "workspace.json"), originalBytes, "utf8");
    const { exports, ipcHandlers } = await loadMainModule([], {
      userDataPath,
      fsPromises: instrumentWorkspaceWrites({
        onPayload: () => { workspaceWrites += 1; },
        onRename: () => { workspaceRenames += 1; },
      }),
      createPlanRuntime: () => {
        runtimeFactoryCalls += 1;
        return {};
      },
    });

    await assert.rejects(
      ipcHandlers.get("workspace:load")(),
      /^Error: Workspace could not be loaded\.$/,
    );
    assert.equal(runtimeFactoryCalls, 0);
    assert.equal(workspaceWrites, 0);
    assert.equal(workspaceRenames, 0);
    assert.equal(exports.openedProjectRoots.has(projectRoot), false);
    assert.equal(await readFile(join(userDataPath, "workspace.json"), "utf8"), originalBytes);
    await assert.rejects(stat(join(userDataPath, "plan-acp-sessions")), { code: "ENOENT" });
  } finally {
    await rm(userDataPath, { recursive: true, force: true });
  }
});

test("workspace load rejects every malformed raw record before Plan state access or root publication", async () => {
  const cases = [
    ["non-record session", (workspace) => {
      workspace.sessions.push(7);
    }],
    ["non-record project", (workspace) => {
      workspace.projects.push(null);
    }],
    ["unknown session kind", (workspace) => {
      workspace.sessions.push({
        id: "unknown-session",
        projectId: "project-1",
        kind: "unknown",
        mode: "fast",
      });
    }],
    ["canvas references missing project", (workspace) => {
      workspace.sessions.push({
        id: "missing-project-canvas",
        projectId: "missing-project",
        kind: "canvas",
        mode: "fast",
      });
    }],
    ["malformed project mixed with valid Plan", (workspace) => {
      workspace.projects.push({ id: "malformed-project" });
    }],
  ];

  for (const [label, mutate] of cases) {
    const userDataPath = await mkdtemp(join(tmpdir(), "skyturn-workspace-raw-barrier-"));
    const projectRoot = join(userDataPath, "project");
    const workspace = currentPlanWorkspace(projectRoot, `plan-${label.replaceAll(" ", "-")}`);
    mutate(workspace);
    const originalBytes = JSON.stringify(workspace, null, 2);
    let getStateCalls = 0;
    let bootstrapCalls = 0;
    let rememberCalls = 0;
    let workspaceWrites = 0;
    try {
      await mkdir(projectRoot);
      await writeFile(join(userDataPath, "workspace.json"), originalBytes, "utf8");
      const { exports, ipcHandlers } = await loadMainModule([], {
        userDataPath,
        fsPromises: instrumentWorkspaceWrites({ onPayload: () => { workspaceWrites += 1; } }),
        projectIdentityRegistry: {
          async remember(rootPath) {
            rememberCalls += 1;
            return rootPath;
          },
          async canonicalize(rootPath) {
            return rootPath;
          },
        },
        createPlanRuntime: () => ({
          async getState() {
            getStateCalls += 1;
            return { needsBootstrap: true };
          },
          async bootstrap() {
            bootstrapCalls += 1;
          },
        }),
      });

      await assert.rejects(
        ipcHandlers.get("workspace:load")(),
        /^Error: Workspace could not be loaded\.$/,
        label,
      );
      assert.equal(getStateCalls, 0, label);
      assert.equal(bootstrapCalls, 0, label);
      assert.equal(rememberCalls, 0, label);
      assert.equal(workspaceWrites, 0, label);
      assert.equal(exports.openedProjectRoots.has(projectRoot), false, label);
      assert.equal(await readFile(join(userDataPath, "workspace.json"), "utf8"), originalBytes, label);
      await assert.rejects(stat(join(userDataPath, "plan-acp-sessions")), { code: "ENOENT" }, label);
    } finally {
      await rm(userDataPath, { recursive: true, force: true });
    }
  }
});

test("workspace load rejects a Plan identity shared with a canvas before private state access", async () => {
  const userDataPath = await mkdtemp(join(tmpdir(), "skyturn-plan-bootstrap-duplicate-canvas-"));
  const projectRoot = join(userDataPath, "project");
  const planSessionId = "plan-duplicate-canvas";
  const workspace = currentPlanWorkspace(projectRoot, planSessionId);
  workspace.sessions.push({ id: planSessionId, projectId: "project-1", kind: "canvas" });
  const originalBytes = JSON.stringify(workspace, null, 2);
  let getStateCalls = 0;
  let bootstrapCalls = 0;
  try {
    await mkdir(projectRoot);
    await writeFile(join(userDataPath, "workspace.json"), originalBytes, "utf8");
    const { exports, ipcHandlers } = await loadMainModule([], {
      userDataPath,
      createPlanRuntime: () => ({
        async getState() {
          getStateCalls += 1;
          return { needsBootstrap: true };
        },
        async bootstrap() {
          bootstrapCalls += 1;
        },
      }),
    });

    await assert.rejects(
      ipcHandlers.get("workspace:load")(),
      /^Error: Workspace could not be loaded\.$/,
    );
    assert.equal(getStateCalls, 0);
    assert.equal(bootstrapCalls, 0);
    assert.equal(exports.openedProjectRoots.has(projectRoot), false);
    assert.equal(await readFile(join(userDataPath, "workspace.json"), "utf8"), originalBytes);
    await assert.rejects(stat(join(userDataPath, "plan-acp-sessions")), { code: "ENOENT" });
  } finally {
    await rm(userDataPath, { recursive: true, force: true });
  }
});

test("failed workspace load preserves old root trust and never authorizes its unseen root", async () => {
  const cases = [
    ["numeric checkpoint", (workspace) => {
      workspace.sessions[0].stages.tasks.checkpoints.push(7);
    }, false],
    ["bootstrap fault", () => undefined, true],
  ];

  for (const [label, mutate, failBootstrap] of cases) {
    const userDataPath = await mkdtemp(join(tmpdir(), "skyturn-workspace-load-root-rollback-"));
    const projectRoot = join(userDataPath, "project");
    const existingRoot = join(userDataPath, "already-trusted");
    const workspace = currentPlanWorkspace(projectRoot, `plan-${label.replaceAll(" ", "-")}`);
    mutate(workspace);
    let getStateCalls = 0;
    try {
      await mkdir(projectRoot);
      await writeFile(join(userDataPath, "workspace.json"), JSON.stringify(workspace, null, 2), "utf8");
      const loaded = await loadMainModule([], {
        userDataPath,
        createPlanRuntime: () => ({
          async getState() {
            getStateCalls += 1;
            if (failBootstrap && getStateCalls === 1) throw new Error("injected bootstrap fault");
            return { needsBootstrap: false };
          },
        }),
      });
      loaded.exports.openedProjectRoots.add(existingRoot);

      await assert.rejects(
        loaded.ipcHandlers.get("workspace:load")(),
        /^Error: Workspace could not be loaded\.$/,
        label,
      );
      assert.equal(loaded.exports.openedProjectRoots.has(existingRoot), true, label);
      assert.equal(loaded.exports.openedProjectRoots.has(projectRoot), false, label);
      const callsAfterLoad = getStateCalls;
      await assert.rejects(
        loaded.ipcHandlers.get("plan:getState")({}, {
          planSessionId: workspace.sessions[0].id,
          projectRoot,
        }),
        /^Error: Project root is not open in SkyTurn\.$/,
        label,
      );
      assert.equal(getStateCalls, callsAfterLoad, label);
    } finally {
      await rm(userDataPath, { recursive: true, force: true });
    }
  }
});

test("workspace load publishes project roots only after every Plan bootstrap succeeds", async () => {
  const userDataPath = await mkdtemp(join(tmpdir(), "skyturn-workspace-load-root-publish-"));
  const projectRoot = join(userDataPath, "project");
  const workspace = legacyPlanWorkspace(projectRoot, "plan-active");
  const inactive = structuredClone(workspace.sessions[0]);
  inactive.id = "plan-inactive";
  inactive.title = "Inactive Plan";
  workspace.sessions.push(inactive);
  const bootstrapTrust = [];
  let loaded;
  try {
    await mkdir(projectRoot);
    await writeFile(join(userDataPath, "workspace.json"), JSON.stringify(workspace, null, 2), "utf8");
    loaded = await loadMainModule([], {
      userDataPath,
      createPlanRuntime: () => ({
        async getState() {
          assert.equal(loaded.exports.openedProjectRoots.has(projectRoot), false);
          return { needsBootstrap: true };
        },
        async bootstrap(request, snapshot) {
          bootstrapTrust.push({
            planSessionId: request.planSessionId,
            trusted: loaded.exports.openedProjectRoots.has(projectRoot),
          });
          return { needsBootstrap: false, snapshot };
        },
      }),
    });

    await loaded.ipcHandlers.get("workspace:load")();
    assert.deepEqual(bootstrapTrust, [
      { planSessionId: "plan-active", trusted: false },
      { planSessionId: "plan-inactive", trusted: false },
    ]);
    assert.equal(loaded.exports.openedProjectRoots.has(projectRoot), true);
  } finally {
    await rm(userDataPath, { recursive: true, force: true });
  }
});

test("missing Plan bootstrap identity initializes only the canonical empty snapshot", async () => {
  const userDataPath = await mkdtemp(join(tmpdir(), "skyturn-plan-bootstrap-new-"));
  const projectRoot = join(userDataPath, "project");
  const workspace = legacyPlanWorkspace(projectRoot, "another-plan");
  let snapshot;
  const states = new Map();
  try {
    await mkdir(projectRoot);
    await writeFile(join(userDataPath, "workspace.json"), JSON.stringify(workspace, null, 2), "utf8");
    const { ipcHandlers } = await loadMainModule([], {
      userDataPath,
      createPlanRuntime: () => ({
        async getState(request) {
          const existing = states.get(request.planSessionId);
          return existing ?? {
            protocolVersion: 1,
            needsBootstrap: true,
            snapshot: {
              version: 0,
              plan: { requirements: "", design: "", tasks: "" },
              accepted: { requirements: false, design: false, tasks: false },
              checkpoints: { requirements: [], design: [], tasks: [] },
            },
            active: null,
            terminal: null,
          };
        },
        async bootstrap(_request, value) {
          snapshot = value;
          const result = { protocolVersion: 1, needsBootstrap: false, snapshot: value, active: null, terminal: null };
          states.set(_request.planSessionId, result);
          return result;
        },
      }),
    });
    await ipcHandlers.get("workspace:load")();
    await ipcHandlers.get("plan:bootstrap")({}, { planSessionId: "brand-new-plan", projectRoot });
    assert.deepEqual(toPlain(snapshot), {
      version: 0,
      plan: { requirements: "", design: "", tasks: "" },
      accepted: { requirements: false, design: false, tasks: false },
      checkpoints: { requirements: [], design: [], tasks: [] },
    });
  } finally {
    await rm(userDataPath, { recursive: true, force: true });
  }
});

test("workspace load returns null only for ENOENT and bounds parse or Plan persistence failures", async () => {
  const missingRoot = await mkdtemp(join(tmpdir(), "skyturn-workspace-load-missing-"));
  const malformedRoot = await mkdtemp(join(tmpdir(), "skyturn-workspace-load-malformed-"));
  const persistenceRoot = await mkdtemp(join(tmpdir(), "skyturn-workspace-load-plan-failure-"));
  const projectRoot = join(persistenceRoot, "project");
  try {
    const missing = await loadMainModule([], { userDataPath: missingRoot });
    assert.equal(await missing.ipcHandlers.get("workspace:load")(), null);

    const malformedBytes = "{\"projects\":[";
    await writeFile(join(malformedRoot, "workspace.json"), malformedBytes, "utf8");
    const malformed = await loadMainModule([], { userDataPath: malformedRoot });
    await assert.rejects(
      malformed.ipcHandlers.get("workspace:load")(),
      /^Error: Workspace could not be loaded\.$/,
    );
    assert.equal(await readFile(join(malformedRoot, "workspace.json"), "utf8"), malformedBytes);

    await mkdir(projectRoot);
    const workspace = legacyPlanWorkspace(projectRoot, "plan-persistence-failure");
    const persistenceBytes = JSON.stringify(workspace, null, 2);
    await writeFile(join(persistenceRoot, "workspace.json"), persistenceBytes, "utf8");
    const persistenceFailure = await loadMainModule([], {
      userDataPath: persistenceRoot,
      createPlanRuntime: () => ({
        async getState() {
          throw new Error("/private/runtime-persistence-detail");
        },
      }),
    });
    await assert.rejects(
      persistenceFailure.ipcHandlers.get("workspace:load")(),
      /^Error: Workspace could not be loaded\.$/,
    );
    assert.equal(await readFile(join(persistenceRoot, "workspace.json"), "utf8"), persistenceBytes);
  } finally {
    await Promise.all([
      rm(missingRoot, { recursive: true, force: true }),
      rm(malformedRoot, { recursive: true, force: true }),
      rm(persistenceRoot, { recursive: true, force: true }),
    ]);
  }
});

test("Plan broadcasts isolate destroyed and throwing windows", async () => {
  const received = [];
  const windows = [
    {
      isDestroyed: () => true,
      webContents: { isDestroyed: () => false, send: () => assert.fail("destroyed window was used") },
    },
    {
      isDestroyed: () => false,
      webContents: { isDestroyed: () => true, send: () => assert.fail("destroyed webContents was used") },
    },
    {
      isDestroyed: () => false,
      webContents: { isDestroyed: () => false, send: () => { throw new Error("send failed"); } },
    },
    {
      isDestroyed: () => false,
      webContents: { isDestroyed: () => false, send: (...args) => received.push(args) },
    },
  ];
  const { exports } = await loadMainModule(windows);
  const event = { protocolVersion: 1, planSessionId: "plan-1", runId: "run-1", kind: "started" };

  assert.equal(typeof exports.broadcastPlanEvent, "function");
  assert.doesNotThrow(() => exports.broadcastPlanEvent(event));
  assert.deepEqual(received, [["plan:event", event]]);
});

test("workspace persistence preserves unavailable projects without trusting them for Plan IPC", async () => {
  const userDataPath = await mkdtemp(join(tmpdir(), "skyturn-workspace-preservation-"));
  const reachableRoot = join(userDataPath, "reachable-project");
  const unavailableRoot = join(userDataPath, "unavailable-volume", "project");
  const workspace = {
    projects: [
      {
        id: "project-reachable",
        name: "Reachable",
        rootPath: reachableRoot,
        canonicalRootPath: reachableRoot,
        devflowPath: join(reachableRoot, ".devflow"),
        openedAt: "2026-07-16T00:00:00.000Z",
      },
      {
        id: "project-unavailable",
        name: "Unavailable",
        rootPath: unavailableRoot,
        canonicalRootPath: unavailableRoot,
        devflowPath: join(unavailableRoot, ".devflow"),
        openedAt: "2026-07-16T00:00:00.000Z",
      },
    ],
    sessions: [
      { id: "canvas-unavailable", projectId: "project-unavailable", kind: "canvas", mode: "fast" },
      {
        ...currentPlanWorkspace(reachableRoot, "plan-reachable").sessions[0],
        projectId: "project-reachable",
      },
    ],
    activeProjectId: "project-unavailable",
    activeSessionId: "canvas-unavailable",
    changesets: {},
    agents: [],
    runs: {},
    runEvents: {},
    runEvidence: {},
    sidebarCollapsed: false,
    collapsedProjectIds: ["project-unavailable"],
  };
  const serialized = JSON.stringify(workspace, null, 2);
  try {
    await mkdir(reachableRoot);
    await writeFile(join(userDataPath, "workspace.json"), serialized, "utf8");
    const { exports, ipcHandlers } = await loadMainModule([], {
      userDataPath,
      projectIdentityRegistry: {
        async remember(rootPath, persistedCanonicalRoot) {
          if (rootPath !== reachableRoot) throw new Error("temporarily unavailable");
          return persistedCanonicalRoot ?? reachableRoot;
        },
        async canonicalize(rootPath) {
          if (rootPath !== reachableRoot) throw new Error("Project root is not open in SkyTurn.");
          return reachableRoot;
        },
      },
      createPlanRuntime: () => ({
        getState: async (request) => ({ protocolVersion: 1, active: null, terminal: null, projectRoot: request.projectRoot }),
      }),
    });

    const loaded = await ipcHandlers.get("workspace:load")();
    assert.deepEqual(toPlain(loaded), workspace);
    assert.equal(exports.openedProjectRoots.has(reachableRoot), true);
    assert.equal(exports.openedProjectRoots.has(unavailableRoot), false);

    await ipcHandlers.get("workspace:save")({}, loaded);
    assert.equal(await readFile(join(userDataPath, "workspace.json"), "utf8"), serialized);
    assert.equal(exports.openedProjectRoots.has(unavailableRoot), false);

    await assert.rejects(
      ipcHandlers.get("plan:getState")({}, { planSessionId: "plan-unavailable", projectRoot: unavailableRoot }),
      /Project root is not open in SkyTurn\./,
    );
    const reachable = await ipcHandlers.get("plan:getState")({}, {
      planSessionId: "plan-reachable",
      projectRoot: reachableRoot,
    });
    assert.equal(reachable.projectRoot, reachableRoot);
  } finally {
    await rm(userDataPath, { recursive: true, force: true });
  }
});

test("workspace load skips inaccessible current and legacy Plans without weakening Plan trust", async (t) => {
  for (const [label, createWorkspace] of [
    ["current", currentPlanWorkspace],
    ["legacy", legacyPlanWorkspace],
  ]) {
    await t.test(label, async () => {
      const userDataPath = await mkdtemp(join(tmpdir(), `skyturn-workspace-plan-unavailable-${label}-`));
      const reachableRoot = join(userDataPath, "reachable-project");
      const unavailableRoot = join(userDataPath, "missing-volume", "project");
      const reachable = createWorkspace(reachableRoot, `plan-reachable-${label}`);
      const unavailable = createWorkspace(unavailableRoot, `plan-unavailable-${label}`);
      reachable.projects[0].id = "project-reachable";
      reachable.sessions[0].projectId = "project-reachable";
      unavailable.projects[0].id = "project-unavailable";
      unavailable.sessions[0].projectId = "project-unavailable";
      const workspace = {
        ...reachable,
        projects: [...reachable.projects, ...unavailable.projects],
        sessions: [...reachable.sessions, ...unavailable.sessions],
        activeProjectId: "project-unavailable",
        activeSessionId: `plan-unavailable-${label}`,
        collapsedProjectIds: ["project-unavailable"],
      };
      const serialized = JSON.stringify(workspace, null, 2);
      const snapshots = new Map();
      const getStateCalls = [];
      const bootstrapCalls = [];
      try {
        await mkdir(reachableRoot);
        await writeFile(join(userDataPath, "workspace.json"), serialized, "utf8");
        const { exports, ipcHandlers } = await loadMainModule([], {
          userDataPath,
          projectIdentityRegistry: {
            async remember(rootPath, persistedCanonicalRoot) {
              if (rootPath !== reachableRoot) throw new Error("temporarily unavailable");
              return persistedCanonicalRoot ?? reachableRoot;
            },
            async canonicalize(rootPath) {
              if (rootPath !== reachableRoot) throw new Error("Project root is not open in SkyTurn.");
              return reachableRoot;
            },
          },
          createPlanRuntime: () => ({
            async getState(request) {
              getStateCalls.push(toPlain(request));
              const snapshot = snapshots.get(request.planSessionId);
              return {
                protocolVersion: 1,
                needsBootstrap: snapshot === undefined,
                snapshot: snapshot ?? {
                  version: 0,
                  plan: { requirements: "", design: "", tasks: "" },
                  accepted: { requirements: false, design: false, tasks: false },
                  checkpoints: { requirements: [], design: [], tasks: [] },
                },
                active: null,
                terminal: null,
              };
            },
            async bootstrap(request, snapshot) {
              bootstrapCalls.push({ request: toPlain(request), snapshot: toPlain(snapshot) });
              snapshots.set(request.planSessionId, snapshot);
              return { protocolVersion: 1, needsBootstrap: false, snapshot, active: null, terminal: null };
            },
          }),
        });

        const loaded = await ipcHandlers.get("workspace:load")();
        assert.deepEqual(toPlain(loaded), workspace);
        assert.equal(await readFile(join(userDataPath, "workspace.json"), "utf8"), serialized);
        const normalized = (await import("@skyturn/persistence")).normalizeWorkspaceState(toPlain(loaded));
        assert.equal(normalized.projects.length, 2);
        assert.deepEqual(normalized.sessions.map((session) => [session.id, session.kind]), [
          [`plan-reachable-${label}`, "plan"],
          [`plan-unavailable-${label}`, "plan"],
        ]);
        assert.deepEqual(getStateCalls.map((request) => request.planSessionId), [`plan-reachable-${label}`]);
        assert.deepEqual(bootstrapCalls.map((call) => call.request.planSessionId), [`plan-reachable-${label}`]);
        assert.equal(exports.openedProjectRoots.has(reachableRoot), true);
        assert.equal(exports.openedProjectRoots.has(unavailableRoot), false);

        await ipcHandlers.get("plan:bootstrap")({}, {
          planSessionId: `plan-reachable-${label}`,
          projectRoot: reachableRoot,
        });
        assert.deepEqual(getStateCalls.map((request) => request.planSessionId), [
          `plan-reachable-${label}`,
          `plan-reachable-${label}`,
        ]);
        assert.deepEqual(bootstrapCalls.map((call) => call.request.planSessionId), [`plan-reachable-${label}`]);
        await assert.rejects(
          ipcHandlers.get("plan:getState")({}, {
            planSessionId: `plan-unavailable-${label}`,
            projectRoot: unavailableRoot,
          }),
          /Project root is not open in SkyTurn\./,
        );
        await assert.rejects(
          ipcHandlers.get("plan:bootstrap")({}, {
            planSessionId: `plan-unavailable-${label}`,
            projectRoot: reachableRoot,
          }),
          /Plan bootstrap (source is invalid|project does not match)\./,
        );
        assert.deepEqual(getStateCalls.map((request) => request.planSessionId), [
          `plan-reachable-${label}`,
          `plan-reachable-${label}`,
        ]);
      } finally {
        await rm(userDataPath, { recursive: true, force: true });
      }
    });
  }
});

test("workspace save rejects renderer-forged project authorization without changing trusted bytes", async () => {
  const userDataPath = await mkdtemp(join(tmpdir(), "skyturn-workspace-forgery-"));
  const trustedRoot = join(userDataPath, "trusted-project");
  const arbitraryRoot = join(userDataPath, "arbitrary-project");
  const trustedWorkspace = {
    projects: [{
      id: "project-trusted",
      name: "Trusted",
      rootPath: trustedRoot,
      canonicalRootPath: trustedRoot,
      devflowPath: join(trustedRoot, ".devflow"),
      openedAt: "2026-07-16T00:00:00.000Z",
    }],
    sessions: [],
    changesets: {},
    agents: [],
    runs: {},
    runEvents: {},
    runEvidence: {},
    activeProjectId: "project-trusted",
    activeSessionId: null,
    sidebarCollapsed: false,
    collapsedProjectIds: [],
  };
  const trustedBytes = JSON.stringify(trustedWorkspace, null, 2);
  try {
    await Promise.all([mkdir(trustedRoot), mkdir(arbitraryRoot)]);
    await writeFile(join(userDataPath, "workspace.json"), trustedBytes, "utf8");
    const first = await loadMainModule([], { userDataPath });
    await first.ipcHandlers.get("workspace:load")();
    const forged = {
      ...trustedWorkspace,
      projects: [...trustedWorkspace.projects, {
        id: "project-forged",
        name: "Forged",
        rootPath: arbitraryRoot,
        canonicalRootPath: arbitraryRoot,
        devflowPath: join(arbitraryRoot, ".devflow"),
        openedAt: "2026-07-16T00:00:01.000Z",
      }],
    };

    await assert.rejects(
      first.ipcHandlers.get("workspace:save")({}, forged),
      /^Error: Workspace contains a project that is not open in SkyTurn\.$/,
    );
    assert.equal(await readFile(join(userDataPath, "workspace.json"), "utf8"), trustedBytes);

    let runtimeCalls = 0;
    const restarted = await loadMainModule([], {
      userDataPath,
      createPlanRuntime: () => ({
        getState: async () => {
          runtimeCalls += 1;
          return {};
        },
      }),
    });
    const loaded = await restarted.ipcHandlers.get("workspace:load")();
    assert.deepEqual(toPlain(loaded), trustedWorkspace);
    assert.equal(restarted.exports.openedProjectRoots.has(arbitraryRoot), false);
    await assert.rejects(
      restarted.ipcHandlers.get("plan:getState")({}, {
        planSessionId: "plan-forged",
        projectRoot: arbitraryRoot,
      }),
      /Project root is not open in SkyTurn\./,
    );
    assert.equal(runtimeCalls, 0);
  } finally {
    await rm(userDataPath, { recursive: true, force: true });
  }
});

test("workspace save rejects malformed envelopes and sessions without replacing trusted bytes", async () => {
  const cases = [
    ["null envelope", () => null],
    ["missing projects", (projectRoot) => {
      const candidate = workspaceSnapshot(projectRoot, "missing-projects");
      delete candidate.projects;
      return candidate;
    }],
    ["malformed Plan checkpoint", (projectRoot) => {
      const candidate = currentPlanWorkspace(projectRoot, "plan-bad-checkpoint");
      candidate.sessions[0].stages.tasks.checkpoints.push(7);
      return candidate;
    }],
    ["malformed Plan document", (projectRoot) => {
      const candidate = currentPlanWorkspace(projectRoot, "plan-bad-document");
      candidate.sessions[0].plan.design = 7;
      return candidate;
    }],
    ["Plan discriminator disagreement", (projectRoot) => {
      const candidate = currentPlanWorkspace(projectRoot, "plan-bad-discriminator");
      candidate.sessions[0].kind = "canvas";
      return candidate;
    }],
    ["unknown session", (projectRoot) => ({
      ...workspaceSnapshot(projectRoot, "unknown-session"),
      sessions: [{ id: "unknown", projectId: "project-1", kind: "unknown", mode: "fast" }],
    })],
    ["duplicate project identity", (projectRoot) => {
      const candidate = workspaceSnapshot(projectRoot, "duplicate-project");
      candidate.projects.push(structuredClone(candidate.projects[0]));
      return candidate;
    }],
    ["duplicate Plan session identity", (projectRoot) => {
      const candidate = currentPlanWorkspace(projectRoot, "duplicate-plan");
      candidate.sessions.push(structuredClone(candidate.sessions[0]));
      return candidate;
    }],
  ];

  for (const [label, candidateFor] of cases) {
    const userDataPath = await mkdtemp(join(tmpdir(), "skyturn-workspace-save-invalid-"));
    const projectRoot = join(userDataPath, "project");
    const target = join(userDataPath, "workspace.json");
    const prior = workspaceSnapshot(projectRoot, "trusted-prior");
    const priorBytes = JSON.stringify(prior, null, 2);
    let workspaceWrites = 0;
    let workspaceRenames = 0;
    try {
      await mkdir(projectRoot);
      await writeFile(target, priorBytes, { mode: 0o600 });
      const loaded = await loadMainModule([], {
        userDataPath,
        fsPromises: instrumentWorkspaceWrites({
          onPayload: () => { workspaceWrites += 1; },
          onRename: () => { workspaceRenames += 1; },
        }),
      });
      await loaded.ipcHandlers.get("workspace:load")();

      await assert.rejects(
        loaded.ipcHandlers.get("workspace:save")({}, candidateFor(projectRoot)),
        /^Error: Workspace could not be saved\.$/,
        label,
      );
      assert.equal(workspaceWrites, 0, label);
      assert.equal(workspaceRenames, 0, label);
      assert.equal(await readFile(target, "utf8"), priorBytes, label);
      assert.deepEqual(
        (await readdir(userDataPath)).filter((name) => name.includes("workspace.json.") && name.endsWith(".tmp")),
        [],
        label,
      );
    } finally {
      await rm(userDataPath, { recursive: true, force: true });
    }
  }
});

test("Open Project roots can be added to the trusted workspace", async () => {
  const userDataPath = await mkdtemp(join(tmpdir(), "skyturn-workspace-open-project-"));
  const openedRoot = join(userDataPath, "opened-project");
  try {
    await mkdir(openedRoot);
    const { ipcHandlers } = await loadMainModule([], { userDataPath, openProjectRoot: openedRoot });
    const opened = await ipcHandlers.get("project:open")();
    const workspace = {
      projects: [{
        id: "project-opened",
        ...opened.project,
        openedAt: "2026-07-16T00:00:00.000Z",
      }],
      sessions: [],
      changesets: {},
      agents: [],
      runs: {},
      runEvents: {},
      runEvidence: {},
      activeProjectId: "project-opened",
      activeSessionId: null,
      sidebarCollapsed: false,
      collapsedProjectIds: [],
    };

    await assert.doesNotReject(ipcHandlers.get("workspace:save")({}, workspace));
    assert.deepEqual(
      JSON.parse(await readFile(join(userDataPath, "workspace.json"), "utf8")),
      workspace,
    );
  } finally {
    await rm(userDataPath, { recursive: true, force: true });
  }
});

test("workflow user input durable delivery suppresses a response-loss retry", async () => {
  const projectRoot = await mkdtemp(join(tmpdir(), "skyturn-workflow-input-retry-"));
  const terminalWrites = [];
  const terminalRuntime = workflowTerminalRuntime(async (sessionId, text) => {
    terminalWrites.push({ sessionId, text });
  });
  let loaded;
  try {
    loaded = await loadMainModule([], { terminalRuntime });
    loaded.exports.openedProjectRoots.add(projectRoot);
    await createWorkflowSessionThroughMain(loaded.ipcHandlers, projectRoot);
    const input = {
      sessionId: "session-1",
      inputId: "input-1",
      text: "Deliver this once.",
      now: "2026-07-17T00:00:01.000Z",
    };

    const first = await loaded.ipcHandlers.get("workflow:appendUserInput")({}, projectRoot, input);
    const retry = await loaded.ipcHandlers.get("workflow:appendUserInput")({}, projectRoot, {
      ...input,
      now: "2026-07-17T00:00:02.000Z",
    });

    assert.deepEqual(toPlain(retry.event), toPlain(first.event));
    assert.deepEqual(terminalWrites, [{ sessionId: "session-1", text: "Deliver this once.\n" }]);
  } finally {
    await loaded?.exports.closeWorkflowStores();
    await rm(projectRoot, { recursive: true, force: true });
  }
});

test("workflow user input conflicting retry never writes conflicting terminal text", async () => {
  const projectRoot = await mkdtemp(join(tmpdir(), "skyturn-workflow-input-conflict-"));
  const terminalWrites = [];
  const terminalRuntime = workflowTerminalRuntime(async (sessionId, text) => {
    terminalWrites.push({ sessionId, text });
  });
  let loaded;
  try {
    loaded = await loadMainModule([], { terminalRuntime });
    loaded.exports.openedProjectRoots.add(projectRoot);
    await createWorkflowSessionThroughMain(loaded.ipcHandlers, projectRoot);
    await loaded.ipcHandlers.get("workflow:appendUserInput")({}, projectRoot, {
      sessionId: "session-1",
      inputId: "input-1",
      text: "Original durable text.",
      now: "2026-07-17T00:00:01.000Z",
    });

    await assert.rejects(
      loaded.ipcHandlers.get("workflow:appendUserInput")({}, projectRoot, {
        sessionId: "session-1",
        inputId: "input-1",
        text: "Conflicting PTY text.",
        now: "2026-07-17T00:00:02.000Z",
      }),
      /already used with different input/,
    );
    assert.deepEqual(terminalWrites, [{ sessionId: "session-1", text: "Original durable text.\n" }]);
    await loaded.exports.closeWorkflowStores();
    const { createWorkflowStore } = await import("@skyturn/persistence/workflow-store");
    const reopened = createWorkflowStore({ projectRoot });
    const userInputs = reopened.listEvents("session-1")
      .filter((event) => event.idempotencyKey === "user-input:input-1");
    assert.equal(userInputs.length, 1);
    assert.equal(userInputs[0].payload.text, "Original durable text.");
    reopened.close();
  } finally {
    await loaded?.exports.closeWorkflowStores();
    await rm(projectRoot, { recursive: true, force: true });
  }
});

test("workflow user input rejects a conflicting delivered fact before terminal delivery or broadcast", async () => {
  const projectRoot = await mkdtemp(join(tmpdir(), "skyturn-workflow-input-delivered-conflict-"));
  const input = {
    sessionId: "session-1",
    inputId: "input-delivered-conflict",
    text: "Do not suppress this pending delivery.",
    now: "2026-07-17T00:00:01.000Z",
  };
  const broadcasts = [];
  const windows = [{ webContents: { send: (...args) => broadcasts.push(args) } }];
  const terminalWrites = [];
  let loaded;
  try {
    const { createWorkflowStore } = await import("@skyturn/persistence/workflow-store");
    const store = createWorkflowStore({ projectRoot });
    store.createWorkflowSession({
      id: input.sessionId,
      projectId: "project-1",
      title: "Workflow",
      goal: "Deliver one input",
      mode: "plan",
      target: { executionTarget: "current_branch", selectedBranch: "main" },
      plannerProfile: "default",
      transport: "hermes_replay_recovery",
      recoveryReason: "Test setup has no live Hermes session.",
      now: "2026-07-17T00:00:00.000Z",
    });
    store.claimUserInput(input);
    store.appendWorkflowEvent({
      sessionId: input.sessionId,
      kind: "workflow.user_input.delivered",
      source: "workflow_store",
      causationId: "wrong-pending-event-id",
      idempotencyKey: `user-input-delivered:${input.inputId}`,
      payload: { inputId: input.inputId },
      now: "2026-07-17T00:00:02.000Z",
    });
    store.close();

    loaded = await loadMainModule(windows, {
      terminalRuntime: workflowTerminalRuntime(async (sessionId, text) => {
        terminalWrites.push({ sessionId, text });
      }),
    });
    loaded.exports.openedProjectRoots.add(projectRoot);

    await assert.rejects(
      loaded.ipcHandlers.get("workflow:appendUserInput")({}, projectRoot, {
        ...input,
        now: "2026-07-17T00:00:03.000Z",
      }),
      /^Error: Workflow user input delivery id conflicts with existing state: input-delivered-conflict\.$/,
    );
    assert.deepEqual(terminalWrites, []);
    assert.deepEqual(broadcasts, []);
  } finally {
    await loaded?.exports.closeWorkflowStores();
    await rm(projectRoot, { recursive: true, force: true });
  }
});

test("workflow user input thrown delivery failure remains pending and retries", async () => {
  const projectRoot = await mkdtemp(join(tmpdir(), "skyturn-workflow-input-send-failure-"));
  const secretFailure = "terminal failed at /Users/private/project with token=secret-value";
  const broadcasts = [];
  const windows = [{ webContents: { send: (...args) => broadcasts.push(args) } }];
  let terminalWrites = 0;
  const terminalRuntime = workflowTerminalRuntime(async () => {
    terminalWrites += 1;
    if (terminalWrites === 1) throw new Error(secretFailure);
  });
  let loaded;
  const input = {
    sessionId: "session-1",
    inputId: "input-1",
    text: "Ledger remains authoritative.",
    now: "2026-07-17T00:00:01.000Z",
  };
  try {
    loaded = await loadMainModule(windows, { terminalRuntime });
    loaded.exports.openedProjectRoots.add(projectRoot);
    await createWorkflowSessionThroughMain(loaded.ipcHandlers, projectRoot);

    await assert.rejects(
      loaded.ipcHandlers.get("workflow:appendUserInput")({}, projectRoot, input),
      (error) => {
        assert.equal(String(error), "Error: Workflow user input could not be delivered.");
        assert.doesNotMatch(String(error), /private|secret-value/);
        return true;
      },
    );
    assert.deepEqual(broadcasts, []);
    const retry = await loaded.ipcHandlers.get("workflow:appendUserInput")({}, projectRoot, {
      ...input,
      now: "2026-07-17T00:00:02.000Z",
    });
    assert.equal(retry.event.payload.text, input.text);
    assert.equal(terminalWrites, 2);
    assert.equal(broadcasts.filter(([channel]) => channel === "workflow:event").length, 1);
  } finally {
    await loaded?.exports.closeWorkflowStores();
    await rm(projectRoot, { recursive: true, force: true });
  }
});

test("workflow user input unavailable result remains pending and retries without a false broadcast", async () => {
  const projectRoot = await mkdtemp(join(tmpdir(), "skyturn-workflow-input-unavailable-"));
  const broadcasts = [];
  const windows = [{ webContents: { send: (...args) => broadcasts.push(args) } }];
  let terminalWrites = 0;
  const terminalRuntime = workflowTerminalRuntime(async (sessionId) => {
    terminalWrites += 1;
    if (terminalWrites === 1) {
      return {
        protocolVersion: 1,
        ok: false,
        status: "degraded",
        terminalSessionId: sessionId,
        reasonCode: "PTY_MANAGER_UNAVAILABLE",
        message: "raw adapter detail must not escape",
      };
    }
  });
  let loaded;
  try {
    loaded = await loadMainModule(windows, { terminalRuntime });
    loaded.exports.openedProjectRoots.add(projectRoot);
    await createWorkflowSessionThroughMain(loaded.ipcHandlers, projectRoot);
    const input = {
      sessionId: "session-1",
      inputId: "input-unavailable",
      text: "Retry unavailable delivery.",
      now: "2026-07-17T00:00:01.000Z",
    };

    await assert.rejects(
      loaded.ipcHandlers.get("workflow:appendUserInput")({}, projectRoot, input),
      /^Error: Workflow user input could not be delivered\.$/,
    );
    assert.deepEqual(broadcasts, []);
    await loaded.ipcHandlers.get("workflow:appendUserInput")({}, projectRoot, {
      ...input,
      now: "2026-07-17T00:00:02.000Z",
    });

    assert.equal(terminalWrites, 2);
    assert.equal(broadcasts.filter(([channel]) => channel === "workflow:event").length, 1);
  } finally {
    await loaded?.exports.closeWorkflowStores();
    await rm(projectRoot, { recursive: true, force: true });
  }
});

test("workflow user input pending delivery survives store reopen and retries", async () => {
  const projectRoot = await mkdtemp(join(tmpdir(), "skyturn-workflow-input-pending-reopen-"));
  let terminalWrites = 0;
  const terminalRuntime = workflowTerminalRuntime(async () => {
    terminalWrites += 1;
    if (terminalWrites === 1) throw new Error("terminal unavailable");
  });
  let firstLoaded;
  let reopenedLoaded;
  const input = {
    sessionId: "session-1",
    inputId: "input-pending-reopen",
    text: "Retry after reopening SQLite.",
    now: "2026-07-17T00:00:01.000Z",
  };
  try {
    firstLoaded = await loadMainModule([], { terminalRuntime });
    firstLoaded.exports.openedProjectRoots.add(projectRoot);
    await createWorkflowSessionThroughMain(firstLoaded.ipcHandlers, projectRoot);
    await assert.rejects(
      firstLoaded.ipcHandlers.get("workflow:appendUserInput")({}, projectRoot, input),
      /^Error: Workflow user input could not be delivered\.$/,
    );
    await firstLoaded.exports.closeWorkflowStores();

    reopenedLoaded = await loadMainModule([], { terminalRuntime });
    reopenedLoaded.exports.openedProjectRoots.add(projectRoot);
    await reopenedLoaded.ipcHandlers.get("workflow:appendUserInput")({}, projectRoot, {
      ...input,
      now: "2026-07-17T00:00:02.000Z",
    });
    assert.equal(terminalWrites, 2);
  } finally {
    await reopenedLoaded?.exports.closeWorkflowStores();
    await firstLoaded?.exports.closeWorkflowStores();
    await rm(projectRoot, { recursive: true, force: true });
  }
});

test("workflow user input durable delivery survives store reopen and suppresses retry", async () => {
  const projectRoot = await mkdtemp(join(tmpdir(), "skyturn-workflow-input-delivered-reopen-"));
  let terminalWrites = 0;
  const terminalRuntime = workflowTerminalRuntime(async () => {
    terminalWrites += 1;
  });
  let firstLoaded;
  let reopenedLoaded;
  const input = {
    sessionId: "session-1",
    inputId: "input-delivered-reopen",
    text: "Suppress this after reopening SQLite.",
    now: "2026-07-17T00:00:01.000Z",
  };
  try {
    firstLoaded = await loadMainModule([], { terminalRuntime });
    firstLoaded.exports.openedProjectRoots.add(projectRoot);
    await createWorkflowSessionThroughMain(firstLoaded.ipcHandlers, projectRoot);
    await firstLoaded.ipcHandlers.get("workflow:appendUserInput")({}, projectRoot, input);
    await firstLoaded.exports.closeWorkflowStores();

    reopenedLoaded = await loadMainModule([], { terminalRuntime });
    reopenedLoaded.exports.openedProjectRoots.add(projectRoot);
    await reopenedLoaded.ipcHandlers.get("workflow:appendUserInput")({}, projectRoot, {
      ...input,
      now: "2026-07-17T00:00:02.000Z",
    });
    assert.equal(terminalWrites, 1);
  } finally {
    await reopenedLoaded?.exports.closeWorkflowStores();
    await firstLoaded?.exports.closeWorkflowStores();
    await rm(projectRoot, { recursive: true, force: true });
  }
});

test("workflow user input concurrent exact retries serialize one terminal delivery", async () => {
  const projectRoot = await mkdtemp(join(tmpdir(), "skyturn-workflow-input-concurrent-retry-"));
  const gate = deferred();
  let terminalWrites = 0;
  const terminalRuntime = workflowTerminalRuntime(async () => {
    terminalWrites += 1;
    gate.started.resolve();
    await gate.release.promise;
  });
  let loaded;
  const input = {
    sessionId: "session-1",
    inputId: "input-concurrent",
    text: "Serialize this delivery.",
    now: "2026-07-17T00:00:01.000Z",
  };
  try {
    loaded = await loadMainModule([], { terminalRuntime });
    loaded.exports.openedProjectRoots.add(projectRoot);
    await createWorkflowSessionThroughMain(loaded.ipcHandlers, projectRoot);

    const first = loaded.ipcHandlers.get("workflow:appendUserInput")({}, projectRoot, input);
    await gate.started.promise;
    const retry = loaded.ipcHandlers.get("workflow:appendUserInput")({}, projectRoot, {
      ...input,
      now: "2026-07-17T00:00:02.000Z",
    });
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(terminalWrites, 1);
    gate.release.resolve();
    await Promise.all([first, retry]);
    assert.equal(terminalWrites, 1);
  } finally {
    gate.release.resolve();
    await loaded?.exports.closeWorkflowStores();
    await rm(projectRoot, { recursive: true, force: true });
  }
});

test("denied Electron single-instance lock quits before creating a window or Plan runtime", async () => {
  let runtimeCalls = 0;
  const windows = [];
  const loaded = await loadMainModule(windows, {
    singleInstanceLock: false,
    createPlanRuntime: () => {
      runtimeCalls += 1;
      return {};
    },
  });

  assert.equal(loaded.appState.quitCalls, 1);
  assert.equal(loaded.appState.whenReadyCalls, 0);
  assert.equal(windows.length, 0);
  assert.equal(runtimeCalls, 0);
});

test("accepted Electron single-instance lock restores and focuses the existing window", async () => {
  let restores = 0;
  let focuses = 0;
  const existingWindow = {
    isMinimized: () => true,
    restore: () => { restores += 1; },
    focus: () => { focuses += 1; },
  };
  const loaded = await loadMainModule([existingWindow], { singleInstanceLock: true });

  assert.equal(typeof loaded.appListeners.get("second-instance"), "function");
  loaded.appListeners.get("second-instance")();
  assert.equal(restores, 1);
  assert.equal(focuses, 1);
});

test("workspace saves are generation ordered so an older deferred save cannot finish last", async () => {
  const userDataPath = await mkdtemp(join(tmpdir(), "skyturn-workspace-save-order-"));
  const projectRoot = join(userDataPath, "project");
  const gate = deferred();
  const newerObserved = deferred();
  const fsPromises = instrumentWorkspaceWrites({
    blockPayload: '"label": "older"',
    onBlocked: gate.started,
    onPayload: (payload) => {
      if (payload.includes('"label": "newer"')) newerObserved.started.resolve();
    },
    release: gate.release,
  });
  try {
    await mkdir(projectRoot);
    const loaded = await loadMainModule([], { userDataPath, fsPromises });
    loaded.exports.openedProjectRoots.add(projectRoot);
    const older = loaded.ipcHandlers.get("workspace:save")({}, workspaceSnapshot(projectRoot, "older"));
    await gate.started.promise;
    const newer = loaded.ipcHandlers.get("workspace:save")({}, workspaceSnapshot(projectRoot, "newer"));
    await Promise.race([
      newerObserved.started.promise,
      new Promise((resolve) => setTimeout(resolve, 50)),
    ]);
    gate.release.resolve();
    await Promise.all([older, newer]);

    assert.equal(JSON.parse(await readFile(join(userDataPath, "workspace.json"), "utf8")).label, "newer");
  } finally {
    gate.release.resolve();
    await rm(userDataPath, { recursive: true, force: true });
  }
});

test("workspace save burst coalesces to the latest final bytes", async () => {
  const userDataPath = await mkdtemp(join(tmpdir(), "skyturn-workspace-save-burst-"));
  const projectRoot = join(userDataPath, "project");
  const writes = [];
  const fsPromises = instrumentWorkspaceWrites({ onPayload: (payload) => writes.push(payload) });
  try {
    await mkdir(projectRoot);
    const loaded = await loadMainModule([], { userDataPath, fsPromises });
    loaded.exports.openedProjectRoots.add(projectRoot);
    await Promise.all([
      loaded.ipcHandlers.get("workspace:save")({}, workspaceSnapshot(projectRoot, "one")),
      loaded.ipcHandlers.get("workspace:save")({}, workspaceSnapshot(projectRoot, "two")),
      loaded.ipcHandlers.get("workspace:save")({}, workspaceSnapshot(projectRoot, "three")),
    ]);

    assert.equal(writes.length, 1);
    assert.equal(JSON.parse(await readFile(join(userDataPath, "workspace.json"), "utf8")).label, "three");
  } finally {
    await rm(userDataPath, { recursive: true, force: true });
  }
});

test("win32 workspace save skips directory sync and drains before quit", async () => {
  const userDataPath = await mkdtemp(join(tmpdir(), "skyturn-workspace-save-win32-"));
  const projectRoot = join(userDataPath, "project");
  const target = join(userDataPath, "workspace.json");
  const workspace = workspaceSnapshot(projectRoot, "win32-atomic-save");
  let directoryOpenAttempts = 0;
  let temporaryOpenAttempts = 0;
  const fsPromises = {
    ...realFs,
    async open(file, flags, mode) {
      if (file === userDataPath && flags === "r") {
        directoryOpenAttempts += 1;
        throw new Error("win32 directory open is unsupported");
      }
      if (flags === "wx" && String(file).includes("workspace.json.")) {
        temporaryOpenAttempts += 1;
      }
      return realFs.open(file, flags, mode);
    },
  };
  try {
    await mkdir(projectRoot);
    const loaded = await loadMainModule([], { platform: "win32", userDataPath, fsPromises });
    loaded.exports.openedProjectRoots.add(projectRoot);

    await loaded.ipcHandlers.get("workspace:save")({}, workspace);
    assert.equal(await readFile(target, "utf8"), JSON.stringify(workspace, null, 2));
    await loaded.exports.workspaceSaveWriter.drain();

    let prevented = 0;
    loaded.appListeners.get("before-quit")({ preventDefault: () => { prevented += 1; } });
    await loaded.exports.closeWorkflowStores();
    await new Promise((resolve) => setImmediate(resolve));

    assert.equal(prevented, 1);
    assert.equal(loaded.appState.quitCalls, 1);
    assert.equal(directoryOpenAttempts, 0);
    assert.equal(temporaryOpenAttempts, 1);
    assert.deepEqual(
      (await readdir(userDataPath)).filter((name) => name.includes("workspace.json.") && name.endsWith(".tmp")),
      [],
    );
  } finally {
    await rm(userDataPath, { recursive: true, force: true });
  }
});

test("workspace atomic save failure preserves prior JSON and removes private temp files", async () => {
  const userDataPath = await mkdtemp(join(tmpdir(), "skyturn-workspace-save-atomic-"));
  const projectRoot = join(userDataPath, "project");
  const target = join(userDataPath, "workspace.json");
  const prior = workspaceSnapshot(projectRoot, "prior-valid");
  const fsPromises = instrumentWorkspaceWrites({ failPayload: '"label": "broken-new"' });
  try {
    await mkdir(projectRoot);
    await writeFile(target, JSON.stringify(prior, null, 2), { mode: 0o600 });
    const loaded = await loadMainModule([], { userDataPath, fsPromises });
    await loaded.ipcHandlers.get("workspace:load")();

    await assert.rejects(
      loaded.ipcHandlers.get("workspace:save")({}, workspaceSnapshot(projectRoot, "broken-new")),
      /injected workspace write failure/,
    );
    assert.deepEqual(JSON.parse(await readFile(target, "utf8")), prior);
    assert.deepEqual((await readdir(userDataPath)).filter((name) => name.includes("workspace.json.") && name.endsWith(".tmp")), []);
  } finally {
    await rm(userDataPath, { recursive: true, force: true });
  }
});

test("workspace drain retries the retained latest snapshot and persists its exact state", async () => {
  const userDataPath = await mkdtemp(join(tmpdir(), "skyturn-workspace-save-retry-"));
  const projectRoot = join(userDataPath, "project");
  const target = join(userDataPath, "workspace.json");
  const prior = workspaceSnapshot(projectRoot, "prior-valid");
  const latest = workspaceSnapshot(projectRoot, "latest-retry");
  const fsPromises = instrumentWorkspaceWrites({
    failPayload: '"label": "latest-retry"',
    failTimes: 1,
  });
  try {
    await mkdir(projectRoot);
    await writeFile(target, JSON.stringify(prior, null, 2), { mode: 0o600 });
    const loaded = await loadMainModule([], { userDataPath, fsPromises });
    await loaded.ipcHandlers.get("workspace:load")();

    await assert.rejects(
      loaded.ipcHandlers.get("workspace:save")({}, latest),
      /injected workspace write failure/,
    );
    assert.deepEqual(JSON.parse(await readFile(target, "utf8")), prior);
    await loaded.exports.workspaceSaveWriter.drain();
    assert.deepEqual(JSON.parse(await readFile(target, "utf8")), latest);
  } finally {
    await rm(userDataPath, { recursive: true, force: true });
  }
});

test("workspace quit drain waits for its bounded retained-snapshot retry", async () => {
  const userDataPath = await mkdtemp(join(tmpdir(), "skyturn-workspace-save-quit-retry-"));
  const projectRoot = join(userDataPath, "project");
  const target = join(userDataPath, "workspace.json");
  const gate = deferred();
  const prior = workspaceSnapshot(projectRoot, "prior-valid");
  const latest = workspaceSnapshot(projectRoot, "quit-retry");
  const fsPromises = instrumentWorkspaceWrites({
    blockAttempt: 2,
    blockPayload: '"label": "quit-retry"',
    failPayload: '"label": "quit-retry"',
    failTimes: 1,
    onBlocked: gate.started,
    release: gate.release,
  });
  try {
    await mkdir(projectRoot);
    await writeFile(target, JSON.stringify(prior, null, 2), { mode: 0o600 });
    const loaded = await loadMainModule([], { userDataPath, fsPromises });
    await loaded.ipcHandlers.get("workspace:load")();
    await assert.rejects(loaded.ipcHandlers.get("workspace:save")({}, latest));

    loaded.appListeners.get("before-quit")({ preventDefault: () => undefined });
    const cleanup = loaded.exports.closeWorkflowStores();
    await gate.started.promise;
    assert.equal(loaded.appState.quitCalls, 0);
    gate.release.resolve();
    await cleanup;
    assert.equal(loaded.appState.quitCalls, 1);
    assert.deepEqual(JSON.parse(await readFile(target, "utf8")), latest);
  } finally {
    gate.release.resolve();
    await rm(userDataPath, { recursive: true, force: true });
  }
});

test("workspace shutdown rejects saves after admission closes and never writes them", async () => {
  const userDataPath = await mkdtemp(join(tmpdir(), "skyturn-workspace-shutdown-admission-"));
  const projectRoot = join(userDataPath, "project");
  const target = join(userDataPath, "workspace.json");
  const gate = deferred();
  const accepted = workspaceSnapshot(projectRoot, "accepted-before-shutdown");
  const rejected = workspaceSnapshot(projectRoot, "rejected-after-shutdown");
  const fsPromises = instrumentWorkspaceWrites({
    blockPayload: '"label": "accepted-before-shutdown"',
    onBlocked: gate.started,
    release: gate.release,
  });
  try {
    await mkdir(projectRoot);
    const loaded = await loadMainModule([], { userDataPath, fsPromises });
    loaded.exports.openedProjectRoots.add(projectRoot);
    const acceptedSave = loaded.ipcHandlers.get("workspace:save")({}, accepted);
    await gate.started.promise;

    const cleanup = loaded.exports.closeWorkflowStores();
    const rejectedSave = loaded.ipcHandlers.get("workspace:save")({}, rejected);
    const rejectedAssertion = assert.rejects(
      rejectedSave,
      /^Error: Workspace saving is unavailable while SkyTurn is shutting down\.$/,
    );
    await new Promise((resolve) => setImmediate(resolve));
    gate.release.resolve();
    await acceptedSave;
    await cleanup;
    await rejectedAssertion;

    assert.deepEqual(JSON.parse(await readFile(target, "utf8")), accepted);
    assert.doesNotMatch(await readFile(target, "utf8"), /rejected-after-shutdown/);
  } finally {
    gate.release.resolve();
    await rm(userDataPath, { recursive: true, force: true });
  }
});

test("workspace drain rejects while the retained latest snapshot still cannot persist", async () => {
  const userDataPath = await mkdtemp(join(tmpdir(), "skyturn-workspace-save-permanent-failure-"));
  const projectRoot = join(userDataPath, "project");
  const target = join(userDataPath, "workspace.json");
  const prior = workspaceSnapshot(projectRoot, "prior-valid");
  const latest = workspaceSnapshot(projectRoot, "permanent-failure");
  const fsPromises = instrumentWorkspaceWrites({ failPayload: '"label": "permanent-failure"' });
  try {
    await mkdir(projectRoot);
    await writeFile(target, JSON.stringify(prior, null, 2), { mode: 0o600 });
    const loaded = await loadMainModule([], { userDataPath, fsPromises });
    await loaded.ipcHandlers.get("workspace:load")();
    await assert.rejects(loaded.ipcHandlers.get("workspace:save")({}, latest));
    await assert.rejects(
      loaded.exports.workspaceSaveWriter.drain(),
      /injected workspace write failure/,
    );
    assert.deepEqual(JSON.parse(await readFile(target, "utf8")), prior);
  } finally {
    await rm(userDataPath, { recursive: true, force: true });
  }
});

test("before-quit keeps a failed workspace drain retryable without detaching the Plan runtime", async () => {
  const userDataPath = await mkdtemp(join(tmpdir(), "skyturn-workspace-quit-failure-retry-"));
  const projectRoot = join(userDataPath, "project");
  const latest = workspaceSnapshot(projectRoot, "quit-failure-retry");
  let writeAttempts = 0;
  let runtimeFactoryCalls = 0;
  let runtimeStateCalls = 0;
  let runtimeCloseCalls = 0;
  const fsPromises = instrumentWorkspaceWrites({
    failPayload: '"label": "quit-failure-retry"',
    failTimes: 2,
    onPayload: () => { writeAttempts += 1; },
  });
  try {
    await mkdir(projectRoot);
    const loaded = await loadMainModule([], {
      userDataPath,
      fsPromises,
      createPlanRuntime: () => {
        runtimeFactoryCalls += 1;
        return {
          async getState() {
            runtimeStateCalls += 1;
            return { protocolVersion: 1, needsBootstrap: false, snapshot: null, active: null, terminal: null };
          },
          async close() {
            runtimeCloseCalls += 1;
          },
        };
      },
    });
    loaded.exports.openedProjectRoots.add(projectRoot);
    const request = { planSessionId: "plan-retry", projectRoot };
    await loaded.ipcHandlers.get("plan:getState")({}, request);
    await assert.rejects(loaded.ipcHandlers.get("workspace:save")({}, latest));

    let prevented = 0;
    loaded.appListeners.get("before-quit")({ preventDefault: () => { prevented += 1; } });
    const failedCleanup = loaded.exports.closeWorkflowStores();
    await assert.rejects(failedCleanup, /injected workspace write failure/);
    assert.equal(loaded.appState.quitCalls, 0);
    assert.equal(runtimeCloseCalls, 0);
    const recovered = workspaceSnapshot(projectRoot, "recovered-after-failed-drain");
    await loaded.ipcHandlers.get("workspace:save")({}, recovered);
    await loaded.ipcHandlers.get("plan:getState")({}, request);
    assert.equal(runtimeFactoryCalls, 1);

    loaded.appListeners.get("before-quit")({ preventDefault: () => { prevented += 1; } });
    const recoveredCleanup = loaded.exports.closeWorkflowStores();
    await recoveredCleanup;
    assert.equal(loaded.appState.quitCalls, 1);
    assert.equal(prevented, 2);
    assert.equal(writeAttempts, 3);
    assert.equal(runtimeStateCalls, 2);
    assert.equal(runtimeCloseCalls, 1);
    assert.deepEqual(
      JSON.parse(await readFile(join(userDataPath, "workspace.json"), "utf8")),
      recovered,
    );
  } finally {
    await rm(userDataPath, { recursive: true, force: true });
  }
});

test("Plan runtime close-triggered workspace save is rejected after the shutdown barrier", async () => {
  const userDataPath = await mkdtemp(join(tmpdir(), "skyturn-workspace-runtime-close-save-"));
  const projectRoot = join(userDataPath, "project");
  let loaded;
  let lateSaveError = null;
  let runtimeCloseCalls = 0;
  try {
    await mkdir(projectRoot);
    loaded = await loadMainModule([], {
      userDataPath,
      createPlanRuntime: () => ({
        async getState() {
          return { protocolVersion: 1, needsBootstrap: false, snapshot: null, active: null, terminal: null };
        },
        async close() {
          runtimeCloseCalls += 1;
          try {
            await loaded.ipcHandlers.get("workspace:save")({}, workspaceSnapshot(projectRoot, "runtime-close-late-save"));
          } catch (error) {
            lateSaveError = error;
          }
        },
      }),
    });
    loaded.exports.openedProjectRoots.add(projectRoot);
    await loaded.ipcHandlers.get("plan:getState")({}, { planSessionId: "plan-close-save", projectRoot });

    await loaded.exports.closeWorkflowStores();

    assert.equal(runtimeCloseCalls, 1);
    assert.match(String(lateSaveError), /^Error: Workspace saving is unavailable while SkyTurn is shutting down\.$/);
    await assert.rejects(readFile(join(userDataPath, "workspace.json")), { code: "ENOENT" });
  } finally {
    await rm(userDataPath, { recursive: true, force: true });
  }
});

test("window-all-closed never quits after a workspace drain rejection", async () => {
  const userDataPath = await mkdtemp(join(tmpdir(), "skyturn-workspace-window-close-failure-"));
  const projectRoot = join(userDataPath, "project");
  let writeAttempts = 0;
  const fsPromises = instrumentWorkspaceWrites({
    failPayload: '"label": "window-close-failure"',
    onPayload: () => { writeAttempts += 1; },
  });
  try {
    await mkdir(projectRoot);
    const loaded = await loadMainModule([], { userDataPath, fsPromises, platform: "linux" });
    loaded.exports.openedProjectRoots.add(projectRoot);
    await assert.rejects(
      loaded.ipcHandlers.get("workspace:save")({}, workspaceSnapshot(projectRoot, "window-close-failure")),
    );

    loaded.appListeners.get("window-all-closed")();
    await assert.rejects(loaded.exports.closeWorkflowStores(), /injected workspace write failure/);
    assert.equal(writeAttempts, 2);
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(loaded.appState.quitCalls, 0);
  } finally {
    await rm(userDataPath, { recursive: true, force: true });
  }
});

test("activate and second-instance share one failed window-close recovery before recreating runtime", async () => {
  const userDataPath = await mkdtemp(join(tmpdir(), "skyturn-workspace-window-close-recovery-"));
  const projectRoot = join(userDataPath, "project");
  const target = join(userDataPath, "workspace.json");
  const prior = workspaceSnapshot(projectRoot, "prior-valid");
  const latest = workspaceSnapshot(projectRoot, "retained-latest");
  const gate = deferred();
  const windows = [];
  let runtimeFactoryCalls = 0;
  let runtimeCloseCalls = 0;
  let writeAttempts = 0;
  const fsPromises = instrumentWorkspaceWrites({
    blockAttempt: 3,
    blockPayload: '"label": "retained-latest"',
    failPayload: '"label": "retained-latest"',
    failTimes: 2,
    onBlocked: gate.started,
    onPayload: () => { writeAttempts += 1; },
    release: gate.release,
  });
  try {
    await mkdir(projectRoot);
    await writeFile(target, JSON.stringify(prior, null, 2), { mode: 0o600 });
    const loaded = await loadMainModule(windows, {
      userDataPath,
      fsPromises,
      platform: "linux",
      createPlanRuntime: () => {
        runtimeFactoryCalls += 1;
        return {
          async getState() {
            return { protocolVersion: 1, needsBootstrap: false, snapshot: null, active: null, terminal: null };
          },
          async close() {
            runtimeCloseCalls += 1;
          },
        };
      },
    });
    loaded.exports.openedProjectRoots.add(projectRoot);
    await loaded.ipcHandlers.get("workspace:load")();
    await loaded.ipcHandlers.get("plan:getState")({}, { planSessionId: "plan-1", projectRoot });
    await assert.rejects(loaded.ipcHandlers.get("workspace:save")({}, latest));

    loaded.appListeners.get("window-all-closed")();
    await assert.rejects(loaded.exports.closeWorkflowStores(), /injected workspace write failure/);
    loaded.appListeners.get("second-instance")();
    await waitForCondition(() => writeAttempts === 3, "second-instance did not start window-close recovery");
    loaded.appListeners.get("activate")();
    loaded.appListeners.get("second-instance")();
    assert.equal(windows.length, 0);

    gate.release.resolve();
    await waitForCondition(() => windows.length === 1, "window-close recovery did not recreate one window");
    assert.equal(loaded.appState.quitCalls, 0);
    assert.equal(writeAttempts, 3);
    assert.equal(runtimeFactoryCalls, 1);
    assert.equal(runtimeCloseCalls, 1);
    assert.deepEqual(JSON.parse(await readFile(target, "utf8")), latest);

    await loaded.ipcHandlers.get("workspace:load")();
    await loaded.ipcHandlers.get("plan:getState")({}, { planSessionId: "plan-1", projectRoot });
    assert.equal(runtimeFactoryCalls, 2);
    loaded.appListeners.get("activate")();
    loaded.appListeners.get("second-instance")();
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(windows.length, 1);
    assert.equal(runtimeFactoryCalls, 2);
  } finally {
    gate.release.resolve();
    await rm(userDataPath, { recursive: true, force: true });
  }
});

test("macOS activate cannot reopen stale workspace while retained latest drain fails", async () => {
  const userDataPath = await mkdtemp(join(tmpdir(), "skyturn-workspace-macos-activate-failure-"));
  const projectRoot = join(userDataPath, "project");
  const target = join(userDataPath, "workspace.json");
  const prior = workspaceSnapshot(projectRoot, "prior-valid");
  const latest = workspaceSnapshot(projectRoot, "retained-latest");
  const windows = [];
  const unhandledRejections = [];
  let runtimeFactoryCalls = 0;
  let writeAttempts = 0;
  const fsPromises = instrumentWorkspaceWrites({
    failPayload: '"label": "retained-latest"',
    onPayload: () => { writeAttempts += 1; },
  });
  const onUnhandledRejection = (error) => { unhandledRejections.push(error); };
  process.prependListener("unhandledRejection", onUnhandledRejection);
  try {
    await mkdir(projectRoot);
    await writeFile(target, JSON.stringify(prior, null, 2), { mode: 0o600 });
    const loaded = await loadMainModule(windows, {
      userDataPath,
      fsPromises,
      platform: "darwin",
      createPlanRuntime: () => {
        runtimeFactoryCalls += 1;
        return {
          async getState() {
            return { protocolVersion: 1, needsBootstrap: false, snapshot: null, active: null, terminal: null };
          },
          async close() {},
        };
      },
    });
    await loaded.ipcHandlers.get("workspace:load")();
    await loaded.ipcHandlers.get("plan:getState")({}, { planSessionId: "plan-1", projectRoot });
    await assert.rejects(loaded.ipcHandlers.get("workspace:save")({}, latest));

    loaded.appListeners.get("window-all-closed")();
    loaded.appListeners.get("activate")();
    await assert.rejects(loaded.exports.closeWorkflowStores(), /injected workspace write failure/);
    assert.equal(loaded.appState.quitCalls, 0);
    await new Promise((resolve) => setImmediate(resolve));
    loaded.appListeners.get("activate")();
    await waitForCondition(() => writeAttempts === 3, "activate did not retry failed window-close cleanup");

    assert.equal(windows.length, 0);
    assert.equal(runtimeFactoryCalls, 1);
    assert.equal(writeAttempts, 3);
    assert.deepEqual(JSON.parse(await readFile(target, "utf8")), prior);
    assert.deepEqual(unhandledRejections, []);
  } finally {
    process.removeListener("unhandledRejection", onUnhandledRejection);
    await rm(userDataPath, { recursive: true, force: true });
  }
});

test("a newer authorized workspace generation supersedes a retained failed snapshot", async () => {
  const userDataPath = await mkdtemp(join(tmpdir(), "skyturn-workspace-save-supersede-"));
  const projectRoot = join(userDataPath, "project");
  const target = join(userDataPath, "workspace.json");
  const prior = workspaceSnapshot(projectRoot, "prior-valid");
  const failed = workspaceSnapshot(projectRoot, "failed-old");
  const newer = workspaceSnapshot(projectRoot, "newer-success");
  const fsPromises = instrumentWorkspaceWrites({ failPayload: '"label": "failed-old"' });
  try {
    await mkdir(projectRoot);
    await writeFile(target, JSON.stringify(prior, null, 2), { mode: 0o600 });
    const loaded = await loadMainModule([], { userDataPath, fsPromises });
    await loaded.ipcHandlers.get("workspace:load")();
    await assert.rejects(loaded.ipcHandlers.get("workspace:save")({}, failed));
    await loaded.ipcHandlers.get("workspace:save")({}, newer);
    await loaded.exports.workspaceSaveWriter.drain();
    assert.deepEqual(JSON.parse(await readFile(target, "utf8")), newer);
  } finally {
    await rm(userDataPath, { recursive: true, force: true });
  }
});

test("direct quit waits for a pending workspace save to drain", async () => {
  const userDataPath = await mkdtemp(join(tmpdir(), "skyturn-workspace-save-quit-"));
  const projectRoot = join(userDataPath, "project");
  const gate = deferred();
  const fsPromises = instrumentWorkspaceWrites({
    blockPayload: '"label": "pending"',
    onBlocked: gate.started,
    release: gate.release,
  });
  try {
    await mkdir(projectRoot);
    const loaded = await loadMainModule([], { userDataPath, fsPromises });
    loaded.exports.openedProjectRoots.add(projectRoot);
    const save = loaded.ipcHandlers.get("workspace:save")({}, workspaceSnapshot(projectRoot, "pending"));
    await gate.started.promise;

    loaded.appListeners.get("before-quit")({ preventDefault: () => undefined });
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(loaded.appState.quitCalls, 0);
    gate.release.resolve();
    await save;
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(loaded.appState.quitCalls, 1);
  } finally {
    gate.release.resolve();
    await rm(userDataPath, { recursive: true, force: true });
  }
});

test("direct quit waits for one cleanup before allowing the final quit", async () => {
  const { exports } = await loadMainModule([]);
  let cleanupCalls = 0;
  let resolveCleanup;
  let quitCalls = 0;
  let finalPrevented = 0;
  const cleanup = new Promise((resolve) => { resolveCleanup = resolve; });
  let beforeQuit;
  const quit = () => {
    quitCalls += 1;
    beforeQuit({ preventDefault: () => { finalPrevented += 1; } });
  };
  beforeQuit = exports.createBeforeQuitHandler(async () => {
    cleanupCalls += 1;
    await cleanup;
  }, quit);
  let firstPrevented = 0;
  let secondPrevented = 0;

  beforeQuit({ preventDefault: () => { firstPrevented += 1; } });
  beforeQuit({ preventDefault: () => { secondPrevented += 1; } });
  assert.equal(firstPrevented, 1);
  assert.equal(secondPrevented, 1);
  assert.equal(cleanupCalls, 1);
  assert.equal(quitCalls, 0);

  resolveCleanup();
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(quitCalls, 1);
  assert.equal(finalPrevented, 0);
  assert.equal(cleanupCalls, 1);
});

test("synchronous before-quit cleanup failure blocks quit and permits a later retry", async () => {
  const { exports } = await loadMainModule([]);
  let cleanupCalls = 0;
  let quitCalls = 0;
  let prevented = 0;
  const beforeQuit = exports.createBeforeQuitHandler(() => {
    cleanupCalls += 1;
    if (cleanupCalls === 1) throw new Error("synchronous cleanup failure");
    return Promise.resolve();
  }, () => {
    quitCalls += 1;
  });

  beforeQuit({ preventDefault: () => { prevented += 1; } });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(cleanupCalls, 1);
  assert.equal(quitCalls, 0);

  beforeQuit({ preventDefault: () => { prevented += 1; } });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(cleanupCalls, 2);
  assert.equal(quitCalls, 1);
  assert.equal(prevented, 2);
});

test("direct shutdown rejects concurrent Plan IPC without creating a replacement runtime", async () => {
  let factoryCalls = 0;
  let generateCalls = 0;
  let releaseClose;
  const closePending = new Promise((resolve) => { releaseClose = resolve; });
  const { appListeners, exports, ipcHandlers } = await loadMainModule([], {
    createPlanRuntime: () => {
      factoryCalls += 1;
      return {
        close: async () => closePending,
        generate: async () => {
          generateCalls += 1;
          return { runId: `run-${generateCalls}` };
        },
      };
    },
  });
  exports.openedProjectRoots.add("/repo");
  const generate = ipcHandlers.get("plan:generate");
  const request = {
    operation: "generate",
    planSessionId: "plan-1",
    projectRoot: "/repo",
    stage: "requirements",
    goal: "Build it",
    expectedStateVersion: 0,
  };

  await generate({}, request);
  appListeners.get("before-quit")({ preventDefault: () => undefined });
  await assert.rejects(generate({}, request), /^Error: Plan runtime is unavailable while SkyTurn is shutting down\.$/);
  assert.equal(factoryCalls, 1);
  assert.equal(generateCalls, 1);

  releaseClose();
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(factoryCalls, 1);
});

test("macOS activate creates one replacement runtime only after the shared close barrier clears", async (t) => {
  const userDataPath = await mkdtemp(join(tmpdir(), "skyturn-workspace-macos-reactivate-"));
  const projectRoot = join(userDataPath, "project");
  const windows = [];
  let factoryCalls = 0;
  let releaseClose;
  t.after(async () => {
    releaseClose?.();
    await rm(userDataPath, { recursive: true, force: true });
  });
  const closePending = new Promise((resolve) => { releaseClose = resolve; });
  const { appListeners, exports, ipcHandlers } = await loadMainModule(windows, {
    platform: "darwin",
    userDataPath,
    createPlanRuntime: () => {
      factoryCalls += 1;
      return {
        close: async () => closePending,
        generate: async () => ({ runId: `run-${factoryCalls}` }),
      };
    },
  });
  await mkdir(projectRoot);
  exports.openedProjectRoots.add(projectRoot);
  const request = {
    operation: "generate",
    planSessionId: "plan-1",
    projectRoot,
    stage: "requirements",
    goal: "Build it",
    expectedStateVersion: 0,
  };
  await ipcHandlers.get("plan:generate")({}, request);

  appListeners.get("window-all-closed")();
  appListeners.get("activate")();
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(windows.length, 0);
  await assert.rejects(
    ipcHandlers.get("plan:generate")({}, request),
    /^Error: Plan runtime is unavailable while SkyTurn is shutting down\.$/,
  );
  assert.equal(factoryCalls, 1);

  releaseClose();
  await new Promise((resolve) => setImmediate(resolve));
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(windows.length, 0);
  appListeners.get("activate")();
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(windows.length, 1);
  appListeners.get("activate")();
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(windows.length, 1);

  await ipcHandlers.get("plan:generate")({}, request);
  assert.equal(factoryCalls, 2);
  const restoredWorkspace = workspaceSnapshot(projectRoot, "macos-reactivated");
  await ipcHandlers.get("workspace:save")({}, restoredWorkspace);
  assert.deepEqual(
    JSON.parse(await readFile(join(userDataPath, "workspace.json"), "utf8")),
    restoredWorkspace,
  );
});

async function loadContracts() {
  const source = await readFile(join(root, "electron", "planIpcContracts.ts"), "utf8");
  const ts = require("typescript");
  const output = ts.transpileModule(source, {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
  }).outputText;
  const module = { exports: {} };
  vm.runInNewContext(output, { module, exports: module.exports }, { filename: "planIpcContracts.ts" });
  return module.exports;
}

async function loadMainModule(windows, options = {}) {
  const contracts = await loadContracts();
  const persistence = await import("@skyturn/persistence");
  const workflowStore = await import("@skyturn/persistence/workflow-store");
  const projectCore = await import("@skyturn/project-core");
  const source = `${await readFile(join(root, "electron", "main.ts"), "utf8")}
export { broadcastPlanEvent, closeWorkflowStores, createBeforeQuitHandler, createMainWindow, openedProjectRoots, workspaceSaveWriter };`;
  const ts = require("typescript");
  const output = ts.transpileModule(source, {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
  }).outputText;
  const module = { exports: {} };
  const appListeners = new Map();
  const ipcHandlers = new Map();
  const appState = { quitCalls: 0, whenReadyCalls: 0 };
  const vmProcess = Object.create(process);
  Object.defineProperty(vmProcess, "platform", { value: options.platform ?? process.platform });
  const terminalRuntime = options.terminalRuntime ?? new Proxy({}, { get: () => () => undefined });
  class AgentBridge {
    onRunEvent() { return () => undefined; }
    listRuns() { return []; }
    async loadEvents() { return []; }
    async getEvidence() { return null; }
    async discoverAgents() { return []; }
  }
  const agentBridgeModule = {
    AgentBridge,
    createCodexCliAdapter: () => ({}),
    createHermesCliAdapter: () => ({}),
    createDurableRunClaimStore: () => ({ initialize: async () => undefined }),
    createPrivateRunEventStore: () => ({}),
  };
  const genericModule = new Proxy({}, {
    get: (_target, property) => {
      if (property === "createTerminalRuntime") return () => terminalRuntime;
      if (property === "createRunStartHandler") return () => async () => ({});
      if (property === "createPlanProjectIdentityRegistry") {
        return () => options.projectIdentityRegistry ?? {
          canonicalize: async (value) => value,
          remember: async (value) => value,
        };
      }
      if (property === "DEVFLOW_DIRECTORIES" || property === "DEVFLOW_FILES") return [];
      return () => undefined;
    },
  });
  const electron = {
    app: {
      getPath: () => options.userDataPath ?? "/tmp",
      on: (event, listener) => appListeners.set(event, listener),
      quit: () => { appState.quitCalls += 1; },
      requestSingleInstanceLock: () => options.singleInstanceLock ?? true,
      whenReady: () => {
        appState.whenReadyCalls += 1;
        return { then: (listener) => { if (options.runWhenReady) void listener(); } };
      },
    },
    BrowserWindow: class BrowserWindow {
      constructor() {
        windows.push(this);
      }

      static getAllWindows() {
        return windows;
      }

      async loadURL() {}

      async loadFile() {}

      isMinimized() { return false; }

      restore() {}

      focus() {}
    },
    dialog: {
      showOpenDialog: async () => options.openProjectRoot
        ? { canceled: false, filePaths: [options.openProjectRoot] }
        : { canceled: true, filePaths: [] },
    },
    ipcMain: { handle: (channel, handler) => ipcHandlers.set(channel, handler) },
    shell: {},
  };
  vm.runInNewContext(
    output,
    {
      module,
      exports: module.exports,
      require: (specifier) => {
        if (specifier === "electron") return electron;
        if (specifier === "node:fs/promises" && options.fsPromises) return options.fsPromises;
        if (specifier.startsWith("node:")) return require(specifier);
        if (specifier === "./planIpcContracts") return contracts;
        if (specifier === "./planRuntime" && options.createPlanRuntime) {
          return { createPlanRuntime: options.createPlanRuntime };
        }
        if (specifier === "@skyturn/persistence") return persistence;
        if (specifier === "@skyturn/persistence/workflow-store") return workflowStore;
        if (specifier === "@skyturn/project-core") return projectCore;
        if (specifier === "@skyturn/agent-bridge") return agentBridgeModule;
        return genericModule;
      },
      process: vmProcess,
      console,
      Buffer,
      AbortController,
      AbortSignal,
      setTimeout,
      clearTimeout,
      setImmediate,
      __dirname: join(root, "electron"),
      __filename: join(root, "electron", "main.ts"),
    },
    { filename: "main.ts" },
  );
  return { appListeners, appState, exports: module.exports, ipcHandlers };
}

function legacyPlanWorkspace(projectRoot, planSessionId) {
  return {
    projects: [{
      id: "project-1",
      name: "Project",
      rootPath: projectRoot,
      canonicalRootPath: projectRoot,
      devflowPath: join(projectRoot, ".devflow"),
      openedAt: "2026-07-15T00:00:00.000Z",
    }],
    sessions: [{
      id: planSessionId,
      projectId: "project-1",
      title: "Legacy Plan",
      goal: "Keep the legacy Plan",
      mode: "plan",
      kind: "plan",
      target: { executionTarget: "current_branch", selectedBranch: "main" },
      createdAt: "2026-07-15T00:00:00.000Z",
      updatedAt: "2026-07-15T00:00:00.000Z",
      plan: {
        requirements: "# Requirements\n\nLegacy requirements.",
        design: "# Design\n\nLegacy design.",
        tasks: "# Tasks\n\n- [ ] Legacy task.",
      },
      nodes: [],
      edges: [],
      activeNodeId: null,
    }],
    changesets: {},
    agents: [],
    runs: {},
    runEvents: {},
    runEvidence: {},
    activeProjectId: "project-1",
    activeSessionId: planSessionId,
    sidebarCollapsed: false,
    collapsedProjectIds: [],
  };
}

function currentPlanWorkspace(projectRoot, planSessionId) {
  const workspace = legacyPlanWorkspace(projectRoot, planSessionId);
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
  Object.assign(workspace.sessions[0], {
    stateVersion: 12,
    activeStage: "tasks",
    plannerConversationId: `hermes-plan-${planSessionId}`,
    conversationStarted: true,
    stages: {
      requirements: { ...readyStage, checkpoints: ["requirements-v0"] },
      design: { ...readyStage, checkpoints: ["design-v0"] },
      tasks: { ...readyStage, checkpoints: ["tasks-v0"] },
    },
  });
  return workspace;
}

function workflowTerminalRuntime(sendWorkflowUserInput) {
  return {
    startHermesPlannerForWorkflowSession: async () => undefined,
    async sendWorkflowUserInput(sessionId, text) {
      return await sendWorkflowUserInput(sessionId, text) ?? {
        protocolVersion: 1,
        ok: true,
        status: "accepted",
        terminalSessionId: sessionId,
      };
    },
    hermesPlannerTerminalSessionId: () => null,
    close: async () => undefined,
  };
}

async function createWorkflowSessionThroughMain(ipcHandlers, projectRoot) {
  return ipcHandlers.get("workflow:createSession")({}, projectRoot, {
    id: "session-1",
    projectId: "project-1",
    title: "Workflow",
    goal: "Deliver one input",
    mode: "plan",
    target: { executionTarget: "current_branch", selectedBranch: "main" },
    plannerProfile: "default",
    transport: "hermes_replay_recovery",
    recoveryReason: "Test setup has no live Hermes session.",
    now: "2026-07-17T00:00:00.000Z",
  });
}

function workspaceSnapshot(projectRoot, label) {
  return {
    label,
    projects: [{
      id: "project-1",
      name: "Project",
      rootPath: projectRoot,
      canonicalRootPath: projectRoot,
      devflowPath: join(projectRoot, ".devflow"),
      openedAt: "2026-07-17T00:00:00.000Z",
    }],
    sessions: [],
    changesets: {},
    agents: [],
    runs: {},
    runEvents: {},
    runEvidence: {},
    activeProjectId: "project-1",
    activeSessionId: null,
    sidebarCollapsed: false,
    collapsedProjectIds: [],
  };
}

function deferred() {
  const makeGate = () => {
    let resolve;
    const promise = new Promise((done) => { resolve = done; });
    return { promise, resolve };
  };
  return { started: makeGate(), release: makeGate() };
}

async function waitForCondition(condition, message) {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    if (condition()) return;
    await new Promise((resolve) => setTimeout(resolve, 2));
  }
  throw new Error(message);
}

function instrumentWorkspaceWrites({
  blockAttempt = 1,
  blockPayload,
  failPayload,
  failTimes = Number.POSITIVE_INFINITY,
  onBlocked,
  onPayload,
  onRename,
  release,
} = {}) {
  let blocked = false;
  let blockMatches = 0;
  let failures = 0;
  async function intercept(data, write) {
    const payload = String(data);
    onPayload?.(payload);
    if (blockPayload && payload.includes(blockPayload)) {
      blockMatches += 1;
      if (!blocked && blockMatches === blockAttempt) {
        blocked = true;
        onBlocked.resolve();
        await release.promise;
      }
    }
    if (failPayload && payload.includes(failPayload) && failures < failTimes) {
      failures += 1;
      await write(payload.slice(0, Math.max(1, Math.floor(payload.length / 3))));
      throw new Error("injected workspace write failure");
    }
    return write(data);
  }
  return {
    ...realFs,
    async rename(oldPath, newPath) {
      onRename?.(oldPath, newPath);
      return realFs.rename(oldPath, newPath);
    },
    async writeFile(file, data, options) {
      return intercept(data, (next) => realFs.writeFile(file, next, options));
    },
    async open(file, flags, mode) {
      const handle = await realFs.open(file, flags, mode);
      return new Proxy(handle, {
        get(target, property) {
          if (property === "writeFile") {
            return (data, options) => intercept(data, (next) => target.writeFile(next, options));
          }
          const value = Reflect.get(target, property, target);
          return typeof value === "function" ? value.bind(target) : value;
        },
      });
    },
  };
}

function toPlain(value) {
  return JSON.parse(JSON.stringify(value));
}
