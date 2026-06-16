import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const root = dirname(dirname(fileURLToPath(import.meta.url)));

test("Electron main owns Flow Kernel workflow store IPC", async () => {
  const main = await readFile(join(root, "electron", "main.ts"), "utf8");

  assert.match(main, /createWorkflowStore/);
  assert.match(main, /workflow:createSession/);
  assert.match(main, /workflow:appendUserInput/);
  assert.match(main, /workflow:ledger/);
  assert.match(main, /workflow:applyIntent/);
  assert.match(main, /workflow:scheduleReady/);
  assert.match(main, /workflow:recordRunResult/);
  assert.match(main, /workflow:projection/);
  assert.match(main, /workflow:events/);
  assert.match(main, /applyWorkflowIntent/);
  assert.match(main, /buildLedgerSummary/);
  assert.match(main, /scheduleReadyLanes/);
  assert.match(main, /recordRunResult/);
  assert.match(main, /materializeFlowProjection/);

  const recordRunResultHandler = main.slice(
    main.indexOf('ipcMain.handle("workflow:recordRunResult"'),
    main.indexOf('ipcMain.handle("workflow:projection"'),
  );
  assert.match(recordRunResultHandler, /bridge\.getEvidence\(projectRoot,\s*runId\)/);
  assert.match(recordRunResultHandler, /bridge\.loadEvents\(projectRoot,\s*runId\)/);
  assert.doesNotMatch(recordRunResultHandler, /store\.recordRunResult\(input\)/);

  const workflowEventsHandler = main.slice(
    main.indexOf('ipcMain.handle("workflow:events"'),
    main.indexOf('ipcMain.handle("workspace:load"'),
  );
  assert.match(workflowEventsHandler, /redactWorkflowEventForRenderer/);
  assert.doesNotMatch(workflowEventsHandler, /events:\s*store\.listEvents\(sessionId\)\.filter/);
});

test("preload exposes narrow Flow Kernel workflow wrappers", async () => {
  const preload = await readFile(join(root, "electron", "preload.ts"), "utf8");

  assert.match(preload, /createWorkflowSession/);
  assert.match(preload, /appendWorkflowUserInput/);
  assert.match(preload, /getWorkflowLedger/);
  assert.match(preload, /applyWorkflowIntent/);
  assert.match(preload, /scheduleWorkflowReadyLanes/);
  assert.match(preload, /recordWorkflowRunResult/);
  assert.match(preload, /getWorkflowProjection/);
  assert.match(preload, /getWorkflowEvents/);
  assert.doesNotMatch(preload, /ipcRenderer\s*:/);
  assert.doesNotMatch(preload, /return\s+ipcRenderer/);
});

test("changeset IPC resolves real paths before project boundary checks", async () => {
  const main = await readFile(join(root, "electron", "main.ts"), "utf8");

  assert.match(main, /changeset:get/);
  assert.match(main, /await fs\.realpath\(projectRoot\)/);
  assert.match(main, /await fs\.realpath\(worktreePath\)/);
  assert.match(main, /createGitChangesetService\(\{ repoRoot: realProjectRoot \}\)/);
  assert.match(main, /const projectWorktreesRoot = `\$\{realProjectRoot\}\.worktrees`/);
  assert.match(main, /realProjectWorktreesRoot === projectWorktreesRoot/);
});
