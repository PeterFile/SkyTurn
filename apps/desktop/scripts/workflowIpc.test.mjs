import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { readFile } from "node:fs/promises";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import vm from "node:vm";

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const require = createRequire(import.meta.url);

test("Electron main owns natural workflow IPC channels", async () => {
  const main = await readFile(join(root, "electron", "main.ts"), "utf8");

  assert.match(main, /createWorkflowStore/);
  for (const channel of [
    "workflow:createSession",
    "workflow:appendUserInput",
    "workflow:ledger",
    "workflow:applyIntent",
    "workflow:scheduleReady",
    "workflow:recordRunResult",
    "workflow:projection",
    "workflow:events",
    "workflow:userDecision:answer",
    "workflow:worktree:create",
    "workflow:worktree:compare",
    "workflow:worktree:adopt",
    "workflow:worktree:clean",
    "workflow:changeset",
    "changeset:get",
  ]) {
    assert.match(main, new RegExp(`ipcMain\\.handle\\("${escapeRegExp(channel)}"`));
  }
  assert.match(main, /applyWorkflowIntent/);
  assert.match(main, /buildLedgerSummary/);
  assert.match(main, /scheduleReadyLanes/);
  assert.match(main, /recordRunResult/);
  assert.match(main, /materializeFlowProjection/);
  assert.match(main, /isTrustedPlannerRootStartInput/);
  assert.match(main, /assertExecutableStartInput/);
  assert.match(main, /rejectMissingWorkflowProjectionNode/);

  const recordRunResultHandler = main.slice(
    main.indexOf('ipcMain.handle("workflow:recordRunResult"'),
    main.indexOf('ipcMain.handle("workflow:projection"'),
  );
  assert.match(recordRunResultHandler, /bridge\.getEvidence\(projectRoot,\s*runId\)/);
  assert.match(recordRunResultHandler, /bridge\.loadEvents\(projectRoot,\s*runId\)/);
  assert.doesNotMatch(recordRunResultHandler, /store\.recordRunResult\(input\)/);

  const workflowEventsHandler = main.slice(
    main.indexOf('ipcMain.handle("workflow:events"'),
    main.indexOf('ipcMain.handle("workflow:userDecision:answer"'),
  );
  assert.match(workflowEventsHandler, /redactWorkflowEventForRenderer/);
  assert.doesNotMatch(workflowEventsHandler, /events:\s*store\.listEvents\(sessionId\)\.filter/);
});

test("Electron project memory IPC does not register arbitrary renderer paths", async () => {
  const main = await readFile(join(root, "electron", "main.ts"), "utf8");
  const initHandler = main.match(/ipcMain\.handle\("project:initDevflow"[\s\S]*?\n\}\);/)?.[0] ?? "";
  const saveHandler = main.match(/ipcMain\.handle\("workspace:save"[\s\S]*?\n\}\);/)?.[0] ?? "";

  assert.match(initHandler, /assertKnownProjectRoot\(rootPath\)/);
  assert.doesNotMatch(initHandler, /openedProjectRoots\.add\(rootPath\)/);
  assert.doesNotMatch(saveHandler, /rememberProjectRoots/);
  assert.match(saveHandler, /sanitizeWorkspaceStateForKnownProjects\(state\)/);
});

test("preload exposes narrow natural workflow wrappers", async () => {
  const preload = await readFile(join(root, "electron", "preload.ts"), "utf8");

  for (const wrapper of [
    "createWorkflowSession",
    "appendWorkflowUserInput",
    "getWorkflowLedger",
    "applyWorkflowIntent",
    "scheduleWorkflowReadyLanes",
    "recordWorkflowRunResult",
    "getWorkflowProjection",
    "getWorkflowEvents",
    "getChangeset",
    "createSession",
    "appendUserInput",
    "getLedger",
    "applyIntent",
    "scheduleReady",
    "recordRunResult",
    "getProjection",
    "getEvents",
    "answerUserDecision",
    "createWorktree",
    "compareWorktrees",
    "adoptWorktree",
    "cleanWorktree",
  ]) {
    assert.match(preload, new RegExp(`${wrapper}\\s*:`));
  }
  assert.doesNotMatch(preload, /ipcRenderer\s*:/);
  assert.doesNotMatch(preload, /return\s+ipcRenderer/);
  assert.doesNotMatch(preload, /execFile|spawn|shell|fs\./);
});

test("changeset IPC resolves real paths before project boundary checks", async () => {
  const main = await readFile(join(root, "electron", "main.ts"), "utf8");

  assert.match(main, /changeset:get/);
  assert.match(main, /workflow:changeset/);
  assert.match(main, /await fs\.realpath\(projectRoot\)/);
  assert.match(main, /await fs\.realpath\(worktreePath\)/);
  assert.match(main, /createGitChangesetService\(\{ repoRoot: realProjectRoot \}\)/);
  assert.match(main, /const projectWorktreesRoot = `\$\{realProjectRoot\}\.worktrees`/);
  assert.match(main, /realProjectWorktreesRoot === projectWorktreesRoot/);
});

test("workflow IPC contract errors are recognizable and block decision nodes", async () => {
  const contracts = await loadWorkflowIpcContracts();

  assert.equal(
    contracts.formatWorkflowIpcError("NON_EXECUTABLE_NODE", "Decision nodes are not executable."),
    "SKYTURN_WORKFLOW_IPC_ERROR:NON_EXECUTABLE_NODE: Decision nodes are not executable.",
  );
  assert.equal(contracts.isNonExecutableStartInput({ nodeKind: "user_decision" }), true);
  assert.equal(contracts.isNonExecutableStartInput({ executable: false }), true);
  assert.equal(
    contracts.isNonExecutableStartInput({ runtimePolicy: { executable: false } }),
    true,
  );
  assert.equal(contracts.isNonExecutableStartInput({ nodeKind: "agent_task", executable: true }), false);
  assert.equal(contracts.workflowStartInputError({ sessionId: "session-1" }), "INVALID_INPUT");
  assert.equal(
    contracts.workflowStartInputError({ sessionId: "session-1", nodeId: "node-1" }),
    null,
  );
  assert.equal(
    contracts.rejectMissingWorkflowProjectionNode({ sessionId: "session-1", nodeId: "ghost-node" }, 1),
    true,
  );
  assert.equal(
    contracts.rejectMissingWorkflowProjectionNode({ sessionId: "legacy-session", nodeId: "node-1" }, 0),
    false,
  );
  assert.equal(contracts.WORKFLOW_IPC_CHANNELS.worktreeCreate, "workflow:worktree:create");
});

test("run start guard trusts only the SQLite planner root CanvasSession fallback", async () => {
  const contracts = await loadWorkflowIpcContracts();
  const input = { sessionId: "session-1", nodeId: "node-1" };
  const store = {
    materializeCanvasSession(sessionId) {
      assert.equal(sessionId, "session-1");
      return {
        id: "session-1",
        plannerNodeId: "node-1",
        nodes: [
          {
            id: "node-1",
            agent: "hermes",
            status: "running",
          },
        ],
      };
    },
  };

  assert.equal(contracts.rejectMissingWorkflowProjectionNode(input, 1), true);
  assert.equal(contracts.isTrustedPlannerRootStartInput(input, store), true);
});

test("run start guard keeps rejecting missing non-planner projection nodes", async () => {
  const contracts = await loadWorkflowIpcContracts();
  const store = {
    materializeCanvasSession() {
      return {
        plannerNodeId: "node-1",
        nodes: [
          {
            id: "node-1",
            agent: "hermes",
            status: "running",
          },
        ],
      };
    },
  };

  assert.equal(
    contracts.rejectMissingWorkflowProjectionNode({ sessionId: "session-1", nodeId: "node-2" }, 1),
    true,
  );
  assert.equal(
    contracts.isTrustedPlannerRootStartInput({ sessionId: "session-1", nodeId: "node-2" }, store),
    false,
  );
});

test("run start guard rejects non-executable planner-like fallback nodes", async () => {
  const contracts = await loadWorkflowIpcContracts();
  const makeStore = (node) => ({
    materializeCanvasSession() {
      return {
        plannerNodeId: "node-1",
        nodes: [node],
      };
    },
  });
  const input = { sessionId: "session-1", nodeId: "node-1" };

  for (const node of [
    { id: "node-1", agent: "hermes", nodeKind: "user_decision", status: "running" },
    { id: "node-1", agent: "hermes", executable: false, status: "running" },
    {
      id: "node-1",
      agent: "hermes",
      runtimePolicy: { executable: false },
      status: "running",
    },
  ]) {
    assert.equal(contracts.isTrustedPlannerRootStartInput(input, makeStore(node)), false);
  }
});

async function loadWorkflowIpcContracts() {
  const source = await readFile(join(root, "electron", "workflowIpcContracts.ts"), "utf8");
  const ts = require("typescript");
  const output = ts.transpileModule(source, {
    compilerOptions: {
      module: ts.ModuleKind.CommonJS,
      target: ts.ScriptTarget.ES2022,
    },
  }).outputText;
  const module = { exports: {} };
  vm.runInNewContext(output, { module, exports: module.exports }, { filename: "workflowIpcContracts.ts" });
  return module.exports;
}

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
