import assert from "node:assert/strict";
import { execFile, execFileSync } from "node:child_process";
import fs from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import path, { dirname, join } from "node:path";
import { readFile } from "node:fs/promises";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import vm from "node:vm";

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const require = createRequire(import.meta.url);

test("Electron workflow shutdown awaits bridge reap before closing SQLite and preserves bridge identity", async () => {
  const main = await readFile(join(root, "electron", "main.ts"), "utf8");
  const start = main.indexOf("function closeWorkflowStores(): Promise<void>");
  const end = main.indexOf("function closeWorkflowAdvanceAdmission", start);
  assert.ok(start >= 0 && end > start);
  const source = `${main.slice(start, end)}\nmodule.exports = { closeWorkflowStores };`;
  const ts = require("typescript");
  const output = ts.transpileModule(source, {
    compilerOptions: {
      module: ts.ModuleKind.CommonJS,
      target: ts.ScriptTarget.ES2022,
    },
  }).outputText;
  const events = [];
  let releaseBridgeClose;
  let bridgeCloseEnteredResolve;
  const bridgeCloseEntered = new Promise((resolve) => {
    bridgeCloseEnteredResolve = resolve;
  });
  const originalBridge = {
    close(reason) {
      events.push(`bridge:close:${reason}`);
      bridgeCloseEnteredResolve();
      return new Promise((resolve) => {
        releaseBridgeClose = resolve;
      });
    },
  };
  const replacementBridge = { close: async () => undefined };
  const store = { close: () => events.push("store:close") };
  let drainCount = 0;
  const module = { exports: {} };
  const context = {
    module,
    exports: module.exports,
    Promise,
    agentBridge: originalBridge,
    agentBridgeAdmissionOpen: true,
    agentBridgeInitialization: null,
    appShutdownRequested: true,
    closeWorkflowAdvanceAdmission: () => events.push("workflow:admission-close"),
    closeWorkflowTerminalReconciliationAdmission: () => events.push("terminal:admission-close"),
    drainWorkflowTasks: async () => events.push(`workflow:drain:${++drainCount}`),
    planRuntime: { close: async () => events.push("plan:close") },
    reopenWorkflowAdvanceAdmission: () => events.push("workflow:admission-reopen"),
    reopenWorkflowTerminalReconciliationAdmission: () => events.push("terminal:admission-reopen"),
    workflowStores: new Map([["/project", store]]),
    workflowStoresClosePromise: null,
    workflowTerminalReconciliationFailures: [],
    workspaceSaveWriter: {
      closeAdmission: () => events.push("workspace:admission-close"),
      drain: async () => events.push("workspace:drain"),
      reopenAdmission: () => events.push("workspace:admission-reopen"),
    },
  };
  vm.runInNewContext(output, context, { filename: "closeWorkflowStores.ts" });

  const closing = module.exports.closeWorkflowStores();
  assert.equal(module.exports.closeWorkflowStores(), closing);
  await bridgeCloseEntered;
  assert.deepEqual(events, [
    "workflow:admission-close",
    "workspace:admission-close",
    "workspace:drain",
    "workflow:drain:1",
    "plan:close",
    "workflow:drain:2",
    "bridge:close:SkyTurn is shutting down.",
  ]);
  assert.equal(events.includes("store:close"), false);

  context.agentBridge = replacementBridge;
  releaseBridgeClose();
  await closing;

  assert.deepEqual(events.slice(-3), [
    "workflow:drain:3",
    "terminal:admission-close",
    "store:close",
  ]);
  assert.equal(context.agentBridge, replacementBridge);
  assert.equal(events.some((event) => event.endsWith("admission-reopen")), false);

  const windowCloseHandler = main.slice(
    main.indexOf('app.on("window-all-closed"'),
    main.indexOf('app.on("activate"'),
  );
  assert.match(windowCloseHandler, /SKYTURN_NEW_SESSION_UI_ACCEPTANCE === "1"/);
  const shutdownCatch = main.slice(start, end);
  assert.match(shutdownCatch, /if \(!appShutdownRequested\) \{\s*workspaceSaveWriter\.reopenAdmission\(\);/);
});

test("Electron main tracks every top-level workflow store operation, not only workflow IPC", async () => {
  const main = await readFile(join(root, "electron", "main.ts"), "utf8");

  assert.match(main, /createWorkflowStore/);
  for (const channel of [
    "workflow:createSession",
    "workflow:appendUserInput",
    "workflow:ledger",
    "workflow:nodePosition:update",
    "workflow:projection",
    "workflow:events",
    "workflow:checkpoints",
    "workflow:insertBefore:pending",
    "workflow:insertBefore",
    "workflow:rollback:eligibility",
    "workflow:rollback:apply",
    "workflow:repair:create",
    "workflow:variant:create",
    "workflow:userDecision:answer",
    "workflow:lane:reassign",
    "workflow:worktree:create",
    "workflow:worktree:compare",
    "workflow:worktree:adopt",
    "workflow:worktree:clean",
    "workflow:delivery:commit",
    "workflow:delivery:push",
    "workflow:pullRequest:create",
    "workflow:pullRequest:checks",
    "workflow:pullRequest:merge",
    "workflow:delivery:syncMain",
    "workflow:changeset",
    "workflow:changeset:reconcileFinal",
    "changeset:get",
    "project:branchFacts",
  ]) {
    assert.match(main, new RegExp(`ipcMain\\.handle\\("${escapeRegExp(channel)}"`));
  }
  const workflowChannels = [...main.matchAll(/ipcMain\.handle\("workflow:[^"]+"/g)];
  const registeredWorkflowHandlers = [
    ...main.matchAll(/ipcMain\.handle\("workflow:[^"]+",\s*workflowHandler\(/g),
  ];
  assert.equal(workflowChannels.length, 28);
  assert.equal(registeredWorkflowHandlers.length, workflowChannels.length);
  assert.match(main, /const workflowStoreOperationTasks = new Set<Promise<unknown>>\(\)/);
  assert.match(main, /return await registerWorkflowStoreOperation\(\(\) => handler\(\.\.\.args\)\)/);
  assert.match(main, /workflowStoreOperationTasks\.add\(operation\)/);
  const workflowOperationRegistry = main.slice(
    main.indexOf("function registerWorkflowStoreOperation"),
    main.indexOf("function terminalHandler"),
  );
  assert.match(workflowOperationRegistry, /const admissionEpoch = assertWorkflowAdvanceAdmissionOpen\(\)/);
  assert.match(workflowOperationRegistry, /Promise\.resolve\(\)\.then\(async \(\) => \{/);
  assert.match(workflowOperationRegistry, /assertWorkflowAdvanceAdmissionOpen\(admissionEpoch\)/);
  assert.match(workflowOperationRegistry, /return await task\(\)/);
  assert.doesNotMatch(workflowOperationRegistry, /normalizeWorkflowIpcError/);
  const runStartHandler = main.slice(
    main.indexOf('ipcMain.handle("run:start"'),
    main.indexOf('ipcMain.handle("run:send"'),
  );
  assert.match(runStartHandler, /registerWorkflowStoreOperation\(async \(\) => \{/);
  assert.match(runStartHandler, /publicRunStartHandler\(input\)/);
  assert.doesNotMatch(runStartHandler, /normalizeWorkflowIpcError/);
  const workspaceLoadHandler = main.slice(
    main.indexOf('ipcMain.handle("workspace:load"'),
    main.indexOf('ipcMain.handle("workspace:save"'),
  );
  assert.match(workspaceLoadHandler, /registerWorkflowStoreOperation\(async \(\) => \{\s*const value = await fs\.readFile/);
  assert.match(workspaceLoadHandler, /error\.code === "ENOENT"\) return null/);
  assert.match(workspaceLoadHandler, /throw new Error\(workspaceLoadError\)/);
  for (const channel of ["workflow:applyIntent", "workflow:scheduleReady", "workflow:recordRunResult"]) {
    assert.doesNotMatch(main, new RegExp(`ipcMain\\.handle\\("${escapeRegExp(channel)}"`));
  }
  assert.match(main, /applyWorkflowIntent/);
  assert.match(main, /buildLedgerSummary/);
  assert.match(main, /scheduleReadyLanes/);
  assert.match(main, /recordRunResult/);
  assert.match(main, /materializeFlowProjection/);
  assert.match(main, /listNodeCheckpoints/);
  assert.match(main, /insertClarificationBefore/);
  assert.match(main, /getNodeRollbackEligibility/);
  assert.match(main, /applyNodeRollback/);
  assert.match(main, /requestNodeRepair/);
  assert.match(main, /requestNodeVariant/);
  assert.match(main, /reassignWorkflowLane/);
  assert.match(main, /isTrustedPlannerRootStartInput/);
  assert.match(main, /assertExecutableStartInput/);
  assert.match(main, /rejectMissingWorkflowProjectionNode/);

  const agentHealthHandler = main.slice(
    main.indexOf('ipcMain.handle("agent:health"'),
    main.indexOf('ipcMain.handle("run:start"'),
  );
  assert.match(agentHealthHandler, /bridge\.discoverAgents\(\)/);
  assert.match(agentHealthHandler, /summarizeAgentReadiness\(agents\)/);
  assert.match(agentHealthHandler, /readiness/);
  assert.doesNotMatch(agentHealthHandler, /spawn|execFile|createWorkflowStore|better-sqlite3/);

  const terminalReconciliation = main.slice(
    main.indexOf("async function reconcileTerminalWorkflowRun"),
    main.indexOf("async function advanceWorkflowSession"),
  );
  assert.match(terminalReconciliation, /bridge\.getEvidence\(projectRoot,\s*segment\.runId\)/);
  assert.match(terminalReconciliation, /bridge\.loadEvents\(projectRoot,\s*segment\.runId\)/);
  assert.match(terminalReconciliation, /store\.recordRunResult/);
  assert.match(terminalReconciliation, /reconcilePendingPlannerWorkflowIntent/);
  assert.match(terminalReconciliation, /store\.completePlannerIntentReconciliation/);
  assert.match(terminalReconciliation, /await advanceWorkflowSession/);

  const workflowStoreFactory = main.slice(
    main.indexOf("async function getWorkflowStore"),
    main.indexOf("async function workflowStoreIdentity"),
  );
  assert.match(workflowStoreFactory, /recoverTerminalWorkflowRuns/);
  const recoverySource = await readFile(join(root, "electron", "workflowRunRecovery.ts"), "utf8");
  assert.match(recoverySource, /store\.listRunningSegments\(\)/);
  assert.match(recoverySource, /store\.listPendingRunCheckpointEnrichments\(\)/);
  assert.match(recoverySource, /bridge\.getEvidence\(projectRoot,\s*segment\.runId\)/);
  const agentBridgeFactory = main.slice(
    main.indexOf("async function getAgentBridge"),
    main.indexOf("async function getWorkflowStore"),
  );
  assert.match(agentBridgeFactory, /reconcileTerminalRunEvent/);
  assert.match(agentBridgeFactory, /createDurableRunClaimStore/);
  assert.match(agentBridgeFactory, /path\.join\(app\.getPath\("userData"\), "run-claims"\)/);
  assert.match(agentBridgeFactory, /durableRunClaimStore/);
  assert.match(agentBridgeFactory, /await durableRunClaimStore\.initialize\(\)/);
  assert.match(agentBridgeFactory, /window\.webContents\.send\("run:event", event\)/);
  assert.match(main, /event\.kind !== "status"/);
  const outputSummary = main.slice(
    main.indexOf("function summarizeRunOutput"),
    main.indexOf("function liveChangesFromRunEvents"),
  );
  assert.match(outputSummary, /\.join\(""\)/);
  assert.doesNotMatch(outputSummary, /\.trim\(\)|\.join\("\\n"\)/);

  const workflowEventsHandler = main.slice(
    main.indexOf('ipcMain.handle("workflow:events"'),
    main.indexOf('ipcMain.handle("workflow:checkpoints"'),
  );
  assert.match(workflowEventsHandler, /redactWorkflowEventForRenderer/);
  assert.doesNotMatch(workflowEventsHandler, /events:\s*store\.listEvents\(sessionId\)\.filter/);

  const projectionHandler = main.slice(
    main.indexOf('ipcMain.handle("workflow:projection"'),
    main.indexOf('ipcMain.handle("workflow:events"'),
  );
  assert.match(
    projectionHandler,
    /advanceWorkflowSession\(projectRoot,\s*store,\s*workflowSessionId,\s*false,\s*"projection-query"\)/,
  );
  const workflowBroadcast = main.slice(
    main.indexOf("function terminalWorkflowBroadcastCause"),
    main.indexOf("function broadcastTerminalEvent"),
  );
  assert.match(workflowBroadcast, /cause:\s*WorkflowBroadcastCause\s*=\s*"workflow-mutation"/);
  assert.match(
    workflowBroadcast,
    /send\("workflow:event",\s*\{\s*projectRoot,\s*sessionId,\s*cause,\s*projection,\s*canvasSession\s*\}\)/,
  );

  const checkpointHandler = main.slice(
    main.indexOf('ipcMain.handle("workflow:checkpoints"'),
    main.indexOf('ipcMain.handle("workflow:rollback:eligibility"'),
  );

  const reassignHandler = main.slice(
    main.indexOf('ipcMain.handle("workflow:lane:reassign"'),
    main.indexOf('ipcMain.handle("workflow:checkpoints"'),
  );
  assert.match(reassignHandler, /assertKnownProjectRoot\(projectRoot\)/);
  assert.match(reassignHandler, /requestId/);
  assert.match(reassignHandler, /reassignWorkflowLane/);
  assert.match(reassignHandler, /broadcastWorkflowProjection/);
  assert.match(reassignHandler, /materializeRendererCanvasSession/);
  assert.match(checkpointHandler, /assertKnownProjectRoot\(projectRoot\)/);
  assert.match(checkpointHandler, /assertWorkflowSessionId/);
  assert.match(checkpointHandler, /assertKnownWorkflowCanvasSession/);
  assert.match(checkpointHandler, /listNodeCheckpoints/);

  const rollbackEligibilityHandler = main.slice(
    main.indexOf('ipcMain.handle("workflow:rollback:eligibility"'),
    main.indexOf('ipcMain.handle("workflow:rollback:apply"'),
  );
  assert.match(rollbackEligibilityHandler, /getNodeRollbackEligibility/);
  assert.match(rollbackEligibilityHandler, /evaluateLocalRollbackSafetyForRollback/);
  assert.match(rollbackEligibilityHandler, /manualRepairRequired/);
  assert.doesNotMatch(rollbackEligibilityHandler, /appendWorkflowEvent|applyNodeRollback|gitResetHard/);

  const rollbackApplyHandler = main.slice(
    main.indexOf('ipcMain.handle("workflow:rollback:apply"'),
    main.indexOf('ipcMain.handle("workflow:repair:create"'),
  );
  const rollbackRemoteBlockHelper = main.slice(
    main.indexOf("function evaluateRollbackRemoteBlocksForRollback"),
    main.indexOf("async function withWorkflowSessionMutationLock"),
  );
  assert.match(rollbackApplyHandler, /evaluateRollbackRemoteBlocksForRollback/);
  assert.match(rollbackRemoteBlockHelper, /getNodeRollbackEligibility/);
  assert.match(rollbackRemoteBlockHelper, /blockingRemoteSideEffects/);
  assert.match(rollbackApplyHandler, /evaluateLocalRollbackSafetyForRollback/);
  assert.match(rollbackApplyHandler, /resetRollbackWorktreeToCommit/);
  assert.match(rollbackApplyHandler, /applyNodeRollback/);
  assert.match(rollbackApplyHandler, /broadcastWorkflowProjection/);
  assert.doesNotMatch(rollbackApplyHandler, /pushDeliveryBranch|createDeliveryPullRequest|mergeDeliveryPullRequest|syncDeliveryMain/);

  const repairHandler = main.slice(
    main.indexOf('ipcMain.handle("workflow:repair:create"'),
    main.indexOf('ipcMain.handle("workflow:variant:create"'),
  );
  assert.match(repairHandler, /requestNodeRepair/);
  assert.match(repairHandler, /workflow\.node\.repair_requested|requestNodeRepair/);
  assert.match(
    repairHandler,
    /await advanceWorkflowSession\(projectRoot,\s*store,\s*normalized\.sessionId,\s*true,\s*"repair-request"\)/,
  );
  assert.match(repairHandler, /const projection = store\.materializeFlowProjection\(normalized\.sessionId\)/);
  assert.match(
    repairHandler,
    /broadcastWorkflowProjection\(projectRoot,\s*normalized\.sessionId,\s*store,\s*"repair-request"\)/,
  );
  assert.doesNotMatch(repairHandler, /projection:\s*result\.projection/);
  const repairRequestIndex = repairHandler.indexOf("store.requestNodeRepair(normalized)");
  const repairAdvanceIndex = repairHandler.indexOf("await advanceWorkflowSession");
  const repairProjectionIndex = repairHandler.indexOf("store.materializeFlowProjection(normalized.sessionId)");
  const repairBroadcastIndex = repairHandler.indexOf("broadcastWorkflowProjection");
  const repairReturnIndex = repairHandler.indexOf("return {");
  assert.ok(repairRequestIndex >= 0, "repair intent must be durable before scheduling");
  assert.ok(repairAdvanceIndex > repairRequestIndex, "repair scheduling must follow durable repair creation");
  assert.ok(repairProjectionIndex > repairAdvanceIndex, "repair response must materialize after scheduling");
  assert.ok(repairBroadcastIndex > repairProjectionIndex, "repair broadcast must use advanced authoritative state");
  assert.ok(repairReturnIndex > repairBroadcastIndex, "repair response must follow the authoritative broadcast");

  const variantHandler = main.slice(
    main.indexOf('ipcMain.handle("workflow:variant:create"'),
    main.indexOf('ipcMain.handle("workflow:userDecision:answer"'),
  );
  assert.match(variantHandler, /requestNodeVariant/);
  assert.match(variantHandler, /workflow\.node\.variant_requested|requestNodeVariant/);
  assert.match(variantHandler, /broadcastWorkflowProjection/);

  const successorNormalizer = main.slice(
    main.indexOf("function normalizeCheckpointSuccessorInput"),
    main.indexOf("function appendRollbackRequestedEvent"),
  );
  assert.match(successorNormalizer, /optionalText\(readField\(input,\s*"instruction"\)\)/);
  assert.match(successorNormalizer, /optionalText\(readField\(input,\s*"text"\)\)/);
  assert.match(successorNormalizer, /instruction:\s*\(optionalText\(readField\(input,\s*"instruction"\)\)\s*\?\?\s*optionalText\(readField\(input,\s*"text"\)\)\)!/);

  const worktreeCreateHandler = main.slice(
    main.indexOf('ipcMain.handle("workflow:worktree:create"'),
    main.indexOf('ipcMain.handle("workflow:worktree:compare"'),
  );
  assert.match(worktreeCreateHandler, /createNodeGitWorktreeService/);
  assert.match(worktreeCreateHandler, /eventSink/);
  assert.match(worktreeCreateHandler, /appendWorkflowEvent/);
  assert.match(worktreeCreateHandler, /resolveGitCommit/);
  assert.match(worktreeCreateHandler, /createManagedWorktree/);
  assert.doesNotMatch(worktreeCreateHandler, /status:\s*"requested"/);

  const worktreeAdoptHandler = main.slice(
    main.indexOf('ipcMain.handle("workflow:worktree:adopt"'),
    main.indexOf('ipcMain.handle("workflow:worktree:clean"'),
  );
  assert.match(worktreeAdoptHandler, /createNodeGitWorktreeService/);
  assert.match(worktreeAdoptHandler, /eventSink/);
  assert.match(worktreeAdoptHandler, /appendWorkflowEvent/);
  const adoptBoundaryIndex = worktreeAdoptHandler.indexOf("assertAdoptedWorktreeBelongsToProject");
  const adoptVariantIndex = worktreeAdoptHandler.indexOf("service.adoptVariant");
  assert.ok(adoptBoundaryIndex >= 0, "adopt IPC must validate the created worktree project boundary");
  assert.ok(adoptBoundaryIndex < adoptVariantIndex, "adopt IPC must validate the boundary before adoptVariant");
  assert.match(worktreeAdoptHandler, /findCreatedWorktreeIdentity\(existingEvents,\s*adoption\.worktreeId\)/);
  assert.match(worktreeAdoptHandler, /recordVariantAdoptFailure/);
  assert.match(worktreeAdoptHandler, /adoptVariant/);
  assert.match(worktreeAdoptHandler, /findVariantAdoptionEvent/);
  assert.match(worktreeAdoptHandler, /catch\s*\(error\)\s*\{[\s\S]*broadcastWorkflowProjection\(projectRoot,\s*sessionId,\s*store\);[\s\S]*throw error;[\s\S]*\}/);
  assert.doesNotMatch(worktreeAdoptHandler, /normalizeWorkflowIpcError/);
  assert.doesNotMatch(worktreeAdoptHandler, /status:\s*"requested"/);

  const worktreeCleanHandler = main.slice(
    main.indexOf('ipcMain.handle("workflow:worktree:clean"'),
    main.indexOf('ipcMain.handle("workflow:changeset"'),
  );
  assert.match(worktreeCleanHandler, /createNodeGitWorktreeService/);
  assert.match(worktreeCleanHandler, /eventSink/);
  assert.match(worktreeCleanHandler, /appendWorkflowEvent/);
  assert.match(worktreeCleanHandler, /runState/);
  assert.match(worktreeCleanHandler, /hasRunningTasksForWorktree/);
  assert.match(worktreeCleanHandler, /cleanManagedWorktree/);
  assert.match(worktreeCleanHandler, /deleteBranch:\s*readField\(input,\s*"deleteBranch"\)\s*===\s*true/);
  assert.match(worktreeCleanHandler, /findWorktreeCleanedEvent/);
  assert.doesNotMatch(worktreeCleanHandler, /status:\s*"requested"/);

  const deliveryCommitHandler = main.slice(
    main.indexOf('ipcMain.handle("workflow:delivery:commit"'),
    main.indexOf('ipcMain.handle("workflow:changeset"'),
  );
  assert.match(deliveryCommitHandler, /createDeliveryCommit/);
  assert.match(deliveryCommitHandler, /normalizeDeliveryCommitIpcError/);
  assert.match(deliveryCommitHandler, /deliveryReconciliationStatus/);
  assert.match(deliveryCommitHandler, /workflow\.commit\.created/);
  assert.match(deliveryCommitHandler, /appendWorkflowEvent/);
  assert.match(deliveryCommitHandler, /status:\s*"committed"/);
  assert.doesNotMatch(deliveryCommitHandler, /status:\s*"requested"/);

  const deliveryPushHandler = main.slice(
    main.indexOf('ipcMain.handle("workflow:delivery:push"'),
    main.indexOf('ipcMain.handle("workflow:pullRequest:create"'),
  );
  assert.match(deliveryPushHandler, /pushDeliveryBranch/);
  assert.match(deliveryPushHandler, /findDeliveryCommitEvidence/);
  assert.match(deliveryPushHandler, /workflow\.delivery\.pushed/);
  assert.match(deliveryPushHandler, /appendWorkflowEvent/);
  assert.match(deliveryPushHandler, /status:\s*"pushed"/);
  assert.doesNotMatch(deliveryPushHandler, /status:\s*"requested"/);

  const pullRequestHandler = main.slice(
    main.indexOf('ipcMain.handle("workflow:pullRequest:create"'),
    main.indexOf('ipcMain.handle("workflow:changeset"'),
  );
  assert.match(pullRequestHandler, /createDeliveryPullRequest/);
  assert.match(pullRequestHandler, /assertWorkflowPullRequestLane/);
  assert.match(pullRequestHandler, /findDeliveryCommitEvidence/);
  assert.match(pullRequestHandler, /validatePullRequestBaseBranch/);
  assert.match(pullRequestHandler, /workflow\.pull_request\.created/);
  assert.match(pullRequestHandler, /appendWorkflowEvent/);
  assert.match(pullRequestHandler, /status:\s*"created"/);
  assert.doesNotMatch(pullRequestHandler, /status:\s*"requested"/);

  const pullRequestChecksHandler = main.slice(
    main.indexOf('ipcMain.handle("workflow:pullRequest:checks"'),
    main.indexOf('ipcMain.handle("workflow:pullRequest:merge"'),
  );
  assert.match(pullRequestChecksHandler, /checkDeliveryPullRequest/);
  assert.match(pullRequestChecksHandler, /findDeliveryPullRequestEvidence/);
  assert.match(pullRequestChecksHandler, /workflow\.pull_request\.checks_recorded/);
  assert.match(pullRequestChecksHandler, /appendWorkflowEvent/);
  assert.match(pullRequestChecksHandler, /status:\s*"checks_recorded"/);
  assert.doesNotMatch(pullRequestChecksHandler, /mergeDeliveryPullRequest/);
  assert.doesNotMatch(pullRequestChecksHandler, /cleanManagedWorktree/);

  const pullRequestMergeHandler = main.slice(
    main.indexOf('ipcMain.handle("workflow:pullRequest:merge"'),
    main.indexOf('ipcMain.handle("workflow:delivery:syncMain"'),
  );
  assert.match(pullRequestMergeHandler, /mergeDeliveryPullRequest/);
  assert.match(pullRequestMergeHandler, /findDeliveryPullRequestEvidence/);
  assert.match(pullRequestMergeHandler, /findDeliveryPullRequestChecksEvidence/);
  assert.match(pullRequestMergeHandler, /workflow\.pull_request\.merged/);
  assert.match(pullRequestMergeHandler, /appendWorkflowEvent/);
  assert.match(pullRequestMergeHandler, /status:\s*"merged"/);
  assert.doesNotMatch(pullRequestMergeHandler, /cleanManagedWorktree/);
  assert.doesNotMatch(pullRequestMergeHandler, /deleteBranch/);

  const deliverySyncMainHandler = main.slice(
    main.indexOf('ipcMain.handle("workflow:delivery:syncMain"'),
    main.indexOf('ipcMain.handle("workflow:changeset"'),
  );
  assert.match(deliverySyncMainHandler, /syncDeliveryMain/);
  assert.match(deliverySyncMainHandler, /workflow\.delivery\.main_synced/);
  assert.match(deliverySyncMainHandler, /appendWorkflowEvent/);
  assert.match(deliverySyncMainHandler, /status:\s*"synced"/);
  assert.doesNotMatch(deliverySyncMainHandler, /cleanManagedWorktree/);
  assert.doesNotMatch(deliverySyncMainHandler, /deleteBranch/);
});

test("Electron main owns trusted checkpoint proof production and re-verifies every live action mutation", async () => {
  const main = await readFile(join(root, "electron", "main.ts"), "utf8");
  assert.doesNotMatch(main, /from\s+["']@skyturn\/git-worktree\/node["']/);

  const enrichment = main.slice(
    main.indexOf("async function enrichTerminalWorkflowRun"),
    main.indexOf("async function workflowStoreIdentity"),
  );
  assert.match(enrichment, /createAfterCheckpointAncestryProof/);
  assert.ok(
    enrichment.indexOf("createAfterCheckpointAncestryProof") < enrichment.indexOf("recordRunChangesetEvidence"),
    "proof production must precede authoritative after changeset evidence",
  );
  assert.match(enrichment, /const ancestry = await createAfterCheckpointAncestryProof/);
  assert.match(enrichment, /runCheckpointInput\([\s\S]*ancestry,/);

  const ancestryAuthority = main.slice(
    main.indexOf("async function workflowGitAncestryProofAuthority"),
    main.indexOf("async function resolveWorkflowCheckpointGitPaths"),
  );
  for (const name of [
    "createWorkflowGitAncestryProof",
    "createLiveWorkflowGitAncestryProofContext",
    "verifyWorkflowGitAncestryProof",
  ]) {
    assert.match(ancestryAuthority, new RegExp(name));
  }
  assert.match(ancestryAuthority, /await import\("@skyturn\/git-worktree\/node"\)/);

  const executableIdentity = main.slice(
    main.indexOf("async function resolveExecutableRunIdentity"),
    main.indexOf("function isExecutableCheckpointLane"),
  );
  assert.match(
    executableIdentity,
    /executionTarget === "new_worktree"[\s\S]*assertManagedRollbackWorktree/,
    "new-worktree checkpoint production must reuse persisted managed-worktree ownership checks",
  );

  const rollbackEligibility = main.slice(
    main.indexOf('ipcMain.handle("workflow:rollback:eligibility"'),
    main.indexOf('ipcMain.handle("workflow:rollback:apply"'),
  );
  assert.match(rollbackEligibility, /verifyLiveWorkflowCheckpointAction/);
  assert.match(rollbackEligibility, /rollbackEligibilityWithInvalidAncestry/);
  assert.match(rollbackEligibility, /workflowCheckpointAncestryBlockReason/);
  assert.ok(
    rollbackEligibility.indexOf("verifyLiveWorkflowCheckpointAction") <
      rollbackEligibility.indexOf("blockingInFlightRemoteSideEffects"),
    "rollback eligibility must report invalid ancestry even when another rollback block also exists",
  );

  const rollbackApply = main.slice(
    main.indexOf('ipcMain.handle("workflow:rollback:apply"'),
    main.indexOf('ipcMain.handle("workflow:repair:create"'),
  );
  assert.match(rollbackApply, /workflowRollbackAncestryBlock/);
  assert.ok(
    rollbackApply.indexOf("workflowRollbackAncestryBlock") <
      rollbackApply.indexOf("evaluateRollbackRemoteBlocksForRollback"),
    "rollback apply must verify before a remote-block path can record a rejected mutation",
  );
  const resetIndex = rollbackApply.indexOf("const resetResult = await resetRollbackWorktreeToCommit");
  const verifyBeforeReset = rollbackApply.lastIndexOf("workflowRollbackAncestryBlock", resetIndex);
  assert.ok(resetIndex > 0);
  assert.ok(
    verifyBeforeReset > 0 && verifyBeforeReset < resetIndex,
    "rollback apply must re-verify before Git reset",
  );

  const repair = main.slice(
    main.indexOf('ipcMain.handle("workflow:repair:create"'),
    main.indexOf('ipcMain.handle("workflow:variant:create"'),
  );
  assert.ok(repair.indexOf("requireLiveWorkflowCheckpointAction") < repair.indexOf("requestNodeRepair"));
  const variant = main.slice(
    main.indexOf('ipcMain.handle("workflow:variant:create"'),
    main.indexOf('ipcMain.handle("workflow:userDecision:answer"'),
  );
  assert.ok(variant.indexOf("requireLiveWorkflowCheckpointAction") < variant.indexOf("requestNodeVariant"));

  const delayedWorktree = main.slice(
    main.indexOf("async function resolveScheduledWorkflowWorktree"),
    main.indexOf("async function requireScheduledWorkflowCandidateBinding"),
  );
  assert.match(delayedWorktree, /requireCheckpointBoundWorktreeBase/);
  assert.match(delayedWorktree, /baseRef:\s*checkpointBaseRef\s*\?\?/);
  assert.ok(
    delayedWorktree.indexOf("requireCheckpointBoundWorktreeBase") < delayedWorktree.indexOf("createManagedWorkflowWorktreeForRun"),
    "delayed worktree source verification must precede Git worktree mutation",
  );
});

test("public run:start and private planner delivery have separate main-only authority", async () => {
  const main = await readFile(join(root, "electron", "main.ts"), "utf8");
  const privatePlanner = main.slice(
    main.indexOf("const plannerRunStartHandler"),
    main.indexOf("const scheduledWorkflowRunStartHandler"),
  );
  const privateScheduler = main.slice(
    main.indexOf("const scheduledWorkflowRunStartHandler"),
    main.indexOf("const publicRunStartHandler"),
  );
  const publicStart = main.slice(
    main.indexOf("const publicRunStartHandler"),
    main.indexOf('ipcMain.handle("run:start"'),
  );
  const publicIpc = main.slice(
    main.indexOf('ipcMain.handle("run:start"'),
    main.indexOf('ipcMain.handle("run:send"'),
  );

  assert.match(privatePlanner, /claimUnscheduledStart/);
  assert.match(privatePlanner, /claimPlannerRunStart/);
  assert.doesNotMatch(privateScheduler, /claimUnscheduledStart|claimPlannerRunStart/);
  assert.doesNotMatch(publicStart, /claimUnscheduledStart|claimPlannerRunStart/);
  assert.match(publicStart, /isWorkflowPlannerRootStartTarget/);
  assert.match(publicStart, /assertPublicRunStartIsNotScheduled\(input, store\)/);
  assert.match(publicStart, /renderer.*workflow|workflow.*renderer/i);
  assert.match(publicIpc, /publicRunStartHandler\(input\)/);
  assert.doesNotMatch(publicIpc, /plannerRunStartHandler|scheduledWorkflowRunStartHandler/);
  const plannerDelivery = main.slice(
    main.indexOf("async function deliverWorkflowUserInputToPlanner"),
    main.indexOf("function workflowPlannerProjectIdentity"),
  );
  assert.match(plannerDelivery, /plannerRunStartHandler/);
  assert.doesNotMatch(plannerDelivery, /publicRunStartHandler|scheduledWorkflowRunStartHandler/);

  const scheduler = main.slice(
    main.indexOf("async function advanceOneWorkflowSession"),
    main.indexOf("async function compensateScheduledWorkflowStartBuildFailure"),
  );
  assert.match(scheduler, /buildScheduledWorkflowRunStartInput/);
  assert.match(scheduler, /scheduledWorkflowRunStartHandler\(input, \{ store, segment, identity \}\)/);
  assert.doesNotMatch(scheduler, /publicRunStartHandler|plannerRunStartHandler/);
  const scheduledInputBuilder = main.slice(
    main.indexOf("async function buildScheduledWorkflowRunStartInput"),
    main.indexOf("async function resolveScheduledWorkflowWorktree"),
  );
  assert.match(scheduledInputBuilder, /runtime\.sandboxForNodeRun\(node\)/);
  assert.match(scheduledInputBuilder, /prompt:\s*runtime\.buildPromptForNodeRun\(session, node, ledger\)/);
});

test("scheduled New-worktree lanes use the real Git service to create, reuse, reopen, and separate durable candidates", async (t) => {
  const harness = await createRealScheduledWorktreeHarness(t);
  const firstPath = await harness.resolve(
    harness.projectRoot,
    harness.store,
    scheduledWorktreeSession(),
    scheduledWorktreeNode("lane-implementation", candidateBinding("lane-implementation")),
    "segment-implementation",
  );
  const created = harness.createdEvents()[0].payload.worktree;

  assert.equal(firstPath, created.realPath);
  assert.equal(created.path, created.realPath);
  assert.equal(await fs.realpath(created.path), created.path);
  assert.equal(git(harness.projectRoot, ["worktree", "list", "--porcelain"]).includes(firstPath), true);
  assert.deepEqual(harness.createCalls.map((call) => toPlain(call)), [{
    sessionId: "session-1",
    variantId: "candidate",
    repoRoot: harness.projectRoot,
    baseCommit: harness.baseCommit,
    branchName: "skyturn/session-1/candidate",
    parentLaneId: "lane-implementation",
    parentSegmentId: "segment-implementation",
  }]);

  const advancedHead = await commitWorktree(firstPath, "serial-head");
  const serialNode = scheduledWorktreeNode(
    "lane-validation",
    candidateBinding("lane-validation", {
      reason: "serial",
      predecessorLaneIds: ["lane-implementation"],
    }),
  );
  const serialPath = await harness.resolve(
    harness.projectRoot,
    harness.store,
    scheduledWorktreeSession(),
    serialNode,
    "segment-validation",
  );

  assert.equal(serialPath, firstPath);
  assert.equal(git(firstPath, ["rev-parse", "HEAD"]), advancedHead);
  assert.equal(harness.createCalls.length, 1);
  assert.equal(harness.createdEvents().length, 1);
  assert.equal(harness.reconcileCalls.length, 1);
  assert.deepEqual(toPlain(harness.reconcileCalls[0].options), { allowHeadAdvance: true });

  const persistedEvents = structuredClone(harness.events);
  const reopened = await loadScheduledWorkflowWorktreeRuntime(harness.createService);
  assert.equal(
    await reopened.resolveScheduledWorkflowWorktree(
      harness.projectRoot,
      storeWithMutableEvents(persistedEvents),
      scheduledWorktreeSession(),
      serialNode,
      "segment-validation-reopened",
    ),
    firstPath,
  );
  assert.equal(harness.createCalls.length, 1);
  assert.equal(harness.reconcileCalls.length, 2);

  const variantPath = await reopened.resolveScheduledWorkflowWorktree(
    harness.projectRoot,
    storeWithMutableEvents(persistedEvents),
    scheduledWorktreeSession(),
    scheduledWorktreeNode("lane-variant", candidateBinding("lane-variant", {
      variantId: "variant-a",
      lineageId: "lineage-session-1-variant-a",
      reason: "variant",
      sourceCheckpointId: "checkpoint-before-a",
      sourceHeadCommit: harness.baseCommit,
    })),
    "segment-variant",
  );
  assert.notEqual(variantPath, firstPath);
  assert.equal(git(variantPath, ["branch", "--show-current"]), "skyturn/session-1/variant-a");
  assert.deepEqual(harness.createCalls.map((call) => call.variantId), ["candidate", "variant-a"]);
  assert.equal(persistedEvents.filter((event) => event.kind === "workflow.worktree.created").length, 2);
});

test("scheduled New-worktree reuse rejects aliased and tampered durable identities through the real Git resolver", async (t) => {
  const harness = await createRealScheduledWorktreeHarness(t);
  const binding = candidateBinding("lane-implementation");
  const node = scheduledWorktreeNode("lane-implementation", binding);
  const worktreePath = await harness.resolve(
    harness.projectRoot,
    harness.store,
    scheduledWorktreeSession(),
    node,
    "segment-implementation",
  );
  const advancedHead = await commitWorktree(worktreePath, "tamper-head");
  const createdEvent = harness.createdEvents()[0];
  const created = createdEvent.payload.worktree;
  const aliasPath = join(harness.tempRoot, "candidate-alias");
  await fs.symlink(created.realPath, aliasPath, process.platform === "win32" ? "junction" : "dir");
  const canonicalAliasPath = await fs.realpath(aliasPath);
  assert.equal(canonicalAliasPath, created.realPath);

  const corruptions = [
    {
      label: "symlink alias",
      events: replaceCreatedWorktree(harness.events, { path: aliasPath, realPath: aliasPath }),
      reconcile: false,
    },
    {
      label: "alternate path spelling",
      events: replaceCreatedWorktree(harness.events, { path: `${created.path}${path.sep}.` }),
      reconcile: false,
    },
    {
      label: "branch",
      events: replaceCreatedWorktree(harness.events, { branchName: "skyturn/session-1/forged" }),
      reconcile: false,
    },
    {
      label: "gitdir",
      events: replaceCreatedWorktree(harness.events, { gitdir: join(harness.projectRoot, ".git") }),
      reconcile: true,
    },
    {
      label: "path",
      events: replaceCreatedWorktree(harness.events, { path: aliasPath }),
      reconcile: false,
    },
    {
      label: "head",
      events: replaceCreatedWorktree(harness.events, { headCommit: advancedHead }),
      reconcile: false,
    },
    {
      label: "conflicting",
      events: [
        ...structuredClone(harness.events),
        createdWorktreeEventWith(createdEvent, {
          baseCommit: advancedHead,
          headCommit: advancedHead,
        }),
      ],
      reconcile: false,
    },
    {
      label: "cleaned",
      events: [
        ...structuredClone(harness.events),
        {
          sessionId: "session-1",
          kind: "workflow.worktree.cleaned",
          source: "git-worktree",
          idempotencyKey: `worktree:${created.worktreeId}:cleaned`,
          createdAt: "2026-07-30T00:00:00.000Z",
          payload: {
            worktree: created,
            result: { ok: true, worktreeId: created.worktreeId },
          },
        },
      ],
      reconcile: false,
    },
  ];
  const varAlias = created.realPath.replace(/^\/private\/var(?=\/)/, "/var");
  if (varAlias !== created.realPath) {
    assert.equal(await fs.realpath(varAlias), created.realPath);
    corruptions.push({
      label: "/var alias",
      events: replaceCreatedWorktree(harness.events, { path: varAlias, realPath: varAlias }),
      reconcile: false,
    });
  }

  for (const corruption of corruptions) {
    const reconcileCount = harness.reconcileCalls.length;
    await assert.rejects(
      harness.resolve(
        harness.projectRoot,
        storeWithMutableEvents(corruption.events),
        scheduledWorktreeSession(),
        node,
        `segment-${corruption.label}`,
      ),
      /worktree|candidate|branch|gitdir|path|head|identity|cleaned/i,
      corruption.label,
    );
    assert.equal(
      harness.reconcileCalls.length,
      reconcileCount + (corruption.reconcile ? 1 : 0),
      `${corruption.label} reached an unexpected production reconciliation boundary`,
    );
  }
  assert.equal(harness.createCalls.length, 1);
});

test("scheduled New-worktree lanes reject invalid durable candidate bindings before real Git creation", async (t) => {
  const harness = await createRealScheduledWorktreeHarness(t);
  const valid = candidateBinding("lane-implementation");
  for (const [label, binding] of [
    ["missing", undefined],
    ["malformed", { ...valid, unexpected: true }],
    ["cross-session", { ...valid, sessionId: "session-other" }],
    ["cross-lane", { ...valid, laneId: "lane-other" }],
    ["mismatched-worktree", { ...valid, worktreeId: "worktree-session-1-other" }],
  ]) {
    await assert.rejects(
      harness.resolve(
        harness.projectRoot,
        harness.store,
        scheduledWorktreeSession(),
        scheduledWorktreeNode("lane-implementation", binding),
        `segment-${label}`,
      ),
      /candidate binding/i,
      label,
    );
  }
  assert.equal(harness.createCalls.length, 0);
  assert.equal(harness.reconcileCalls.length, 0);
});

test("scheduled Current-branch lanes still resolve only the canonical project root", async (t) => {
  const harness = await createRealScheduledWorktreeHarness(t);
  const session = scheduledWorktreeSession();
  session.target.executionTarget = "current_branch";
  const node = scheduledWorktreeNode("lane-current", undefined);
  node.worktree.executionTarget = "current_branch";
  node.worktree.path = join(harness.tempRoot, "forged");
  node.worktree.realPath = join(harness.tempRoot, "forged");

  assert.equal(
    await harness.resolve(harness.projectRoot, harness.store, session, node, "segment-current"),
    harness.projectRoot,
  );
  assert.equal(harness.createCalls.length, 0);
  assert.equal(harness.reconcileCalls.length, 0);
});

test("scheduler compensates the exact durable segment when scheduled worktree resolution rejects", async () => {
  const segment = {
    sessionId: "session-1",
    laneId: "lane-implementation",
    segmentId: "segment-implementation",
    runId: "run-implementation",
    agentKind: "codex",
  };
  const result = await runScheduledResolverFailure(segment);

  assert.deepEqual(toPlain(result.resolveCalls), [{
    projectRoot: "/canonical/project",
    sessionId: "session-1",
    laneId: "lane-implementation",
    segmentId: "segment-implementation",
  }]);
  assert.deepEqual(toPlain(result.compensations), [{
    segment,
    message: "Scheduled worktree reconciliation rejected.",
  }]);
  assert.equal(result.scheduledStartCalls, 0);
  assert.equal(result.adapterLaunches, 0);
  assert.equal(result.reopenCalls, 0);
});

test("desktop scheduler backfills a read-only observer when another session owns the current-branch writer", async () => {
  const result = await runBlockedWriterObserverBackfill();

  assert.deepEqual(toPlain(result.previewCalls), [
    { allowedParallelism: 1 },
    { allowedParallelism: 1 },
  ]);
  assert.deepEqual(toPlain(result.scheduleCalls), [{
    allowedParallelism: 1,
    authorizedLaneIds: ["lane-writer"],
  }]);
  assert.deepEqual(result.startedLaneIds, ["lane-observer"]);
});

test("MVP demo links the temporary React app to desktop package dependencies", async () => {
  const demo = await readFile(join(root, "scripts", "mvpWorkflowDemo.mjs"), "utf8");
  assert.match(demo, /const desktopRoot = dirname\(dirname\(fileURLToPath\(import\.meta\.url\)\)\)/);
  assert.match(demo, /symlink\(join\(desktopRoot,\s*"node_modules"\),\s*join\(projectRoot,\s*"node_modules"\),\s*"dir"\)/);
  assert.doesNotMatch(demo, /symlink\(join\(repoRoot,\s*"node_modules"\),\s*join\(projectRoot,\s*"node_modules"\),\s*"dir"\)/);
});

test("workflow delivery commit validates known sessions before creating git commits", async () => {
  const main = await readFile(join(root, "electron", "main.ts"), "utf8");
  const deliveryCommitHandler = main.slice(
    main.indexOf('ipcMain.handle("workflow:delivery:commit"'),
    main.indexOf('ipcMain.handle("workflow:changeset"'),
  );
  const helperSource = main.slice(
    main.indexOf("function assertKnownWorkflowCanvasSession"),
    main.indexOf("async function collectChangesetEvidenceForWorktree"),
  );

  const sessionIndex = deliveryCommitHandler.indexOf("const sessionId = assertWorkflowSessionId");
  const storeIndex = deliveryCommitHandler.indexOf("const store = await getWorkflowStore");
  const canvasIndex = deliveryCommitHandler.indexOf("assertKnownWorkflowCanvasSession");
  const importIndex = deliveryCommitHandler.indexOf('await import("@skyturn/git-worktree/node")');
  const commitIndex = deliveryCommitHandler.indexOf("createDeliveryCommit({");

  assert.ok(sessionIndex >= 0, "delivery commit IPC must require a workflow sessionId");
  assert.ok(storeIndex > sessionIndex, "delivery commit IPC must open the workflow store after resolving sessionId");
  assert.ok(canvasIndex > storeIndex, "delivery commit IPC must validate the CanvasSession before git commit");
  assert.ok(importIndex > canvasIndex, "delivery commit IPC must validate stale sessions before importing commit implementation");
  assert.ok(commitIndex > importIndex, "git commit creation must stay after session validation");
  assert.match(helperSource, /store\.materializeCanvasSession\(sessionId\)/);
  assert.match(helperSource, /workflowIpcError\("UNKNOWN_SESSION"/);
});

test("workflow delivery commit takes the session mutation lock before local git mutation evidence", async () => {
  const main = await readFile(join(root, "electron", "main.ts"), "utf8");
  const deliveryCommitHandler = main.slice(
    main.indexOf('ipcMain.handle("workflow:delivery:commit"'),
    main.indexOf('ipcMain.handle("workflow:delivery:push"'),
  );

  const workflowProjectRootIndex = deliveryCommitHandler.indexOf("const workflowProjectRoot = await workflowStoreIdentity(projectRoot)");
  const lockIndex = deliveryCommitHandler.indexOf("withWorkflowSessionMutationLock(workflowProjectRoot, sessionId");
  const storeIndex = deliveryCommitHandler.indexOf("const store = await getWorkflowStore");
  const canvasIndex = deliveryCommitHandler.indexOf("assertKnownWorkflowCanvasSession");
  const laneGuardIndex = deliveryCommitHandler.indexOf("assertWorkflowDeliveryCommitLane");
  const worktreeIndex = deliveryCommitHandler.indexOf("resolveDeliveryCommitWorktreePath");
  const importIndex = deliveryCommitHandler.indexOf('await import("@skyturn/git-worktree/node")');
  const commitIndex = deliveryCommitHandler.indexOf("createDeliveryCommit({");
  const eventIndex = deliveryCommitHandler.indexOf('kind: "workflow.commit.created"');
  const broadcastIndex = deliveryCommitHandler.indexOf("broadcastWorkflowProjection");

  assert.ok(workflowProjectRootIndex >= 0, "delivery commit must use the workflow store identity as the lock key root");
  assert.ok(lockIndex > workflowProjectRootIndex, "delivery commit must enter the session mutation lock");
  assert.ok(storeIndex > lockIndex, "delivery commit must re-open/revalidate the workflow store inside the lock");
  assert.ok(canvasIndex > storeIndex, "delivery commit must validate the CanvasSession inside the lock");
  assert.ok(laneGuardIndex > canvasIndex, "delivery commit must validate the delivery lane inside the lock");
  assert.ok(worktreeIndex > laneGuardIndex, "delivery commit must resolve the worktree only after locked lane validation");
  assert.ok(importIndex > worktreeIndex, "delivery commit must import the git helper inside the lock");
  assert.ok(commitIndex > importIndex, "delivery commit must call the local git mutation after the lock is held");
  assert.ok(eventIndex > commitIndex, "workflow.commit.created must be written only after the locked git commit succeeds");
  assert.ok(broadcastIndex > eventIndex, "delivery commit broadcast must happen after locked event materialization");
});

test("workflow events expose renderer-safe delivery lifecycle facts without raw payloads", async () => {
  const main = await readFile(join(root, "electron", "main.ts"), "utf8");
  const workflowEventsHandler = main.slice(
    main.indexOf('ipcMain.handle("workflow:events"'),
    main.indexOf('ipcMain.handle("workflow:userDecision:answer"'),
  );
  const redactor = main.slice(
    main.indexOf("function redactWorkflowEventForRenderer"),
    main.indexOf("function workflowEventSummary"),
  );
  const deliveryFactsHelper = main.slice(
    main.indexOf("function deliveryLifecycleFactsForRenderer"),
    main.indexOf("function workflowEventSummary"),
  );

  assert.match(workflowEventsHandler, /redactWorkflowEventForRenderer/);
  assert.match(redactor, /deliveryLifecycleFactsForRenderer\(event\)/);
  assert.match(redactor, /payload:\s*\{[\s\S]*redacted:\s*true[\s\S]*summary:\s*workflowEventSummary\(event\.kind\)[\s\S]*\.\.\.\(delivery \? \{ delivery \} : \{\}\)/);
  for (const eventKind of [
    "workflow.commit.created",
    "workflow.delivery.pushed",
    "workflow.pull_request.created",
    "workflow.pull_request.checks_recorded",
    "workflow.pull_request.merged",
    "workflow.delivery.main_synced",
  ]) {
    assert.match(deliveryFactsHelper, new RegExp(`case "${escapeRegExp(eventKind)}"`));
  }
  assert.match(deliveryFactsHelper, /kind:\s*"commit"/);
  assert.match(deliveryFactsHelper, /kind:\s*"push"/);
  assert.match(deliveryFactsHelper, /kind:\s*"pull_request"/);
  assert.match(deliveryFactsHelper, /kind:\s*"checks"/);
  assert.match(deliveryFactsHelper, /kind:\s*"merge"/);
  assert.match(deliveryFactsHelper, /kind:\s*"main_synced"/);
  assert.doesNotMatch(deliveryFactsHelper, /worktreePath|command|commands|stdout|stderr|rawStdout/);
});

test("workflow checks projection preserves only renderer-safe review and mergeability facts", async () => {
  const { redactWorkflowEventForRenderer } = await loadMainDeliveryRendererHelpers();
  const projected = toPlain(redactWorkflowEventForRenderer({
    id: "event-checks-1",
    sessionId: "session-1",
    seq: 4,
    kind: "workflow.pull_request.checks_recorded",
    source: "electron-main",
    laneId: "lane-pr",
    createdAt: "2026-07-11T00:00:00.000Z",
    payload: {
      laneId: "lane-pr",
      prNumber: 42,
      url: "https://example.test/pull/42",
      headSha: "sha-b",
      status: "passed",
      checks: [{
        name: "Build and test",
        status: "passed",
        link: "https://example.test/checks/1",
        detail: "must stay private",
      }],
      review: {
        status: "approved",
        reviewer: "octocat",
        detail: "private review comment",
      },
      gate: {
        headSha: "sha-b",
        checksStatus: "passed",
        reviewStatus: "approved",
        state: "OPEN",
        mergeable: true,
      },
      evidence: {
        command: { stdout: "raw gh output", stderr: "secret" },
        summary: "agent prose",
      },
    },
  }));

  assert.deepEqual(projected.payload.delivery, {
    kind: "checks",
    laneId: "lane-pr",
    prNumber: 42,
    url: "https://example.test/pull/42",
    headSha: "sha-b",
    status: "passed",
    checks: [{ name: "Build and test", status: "passed", link: "https://example.test/checks/1" }],
    review: { status: "approved" },
    gate: { mergeable: true },
  });
  assert.doesNotMatch(JSON.stringify(projected), /octocat|private review comment|raw gh output|secret|agent prose/);
});

test("workflow delivery push validates session, commit lane, worktree, and commit evidence before git push", async () => {
  const main = await readFile(join(root, "electron", "main.ts"), "utf8");
  const deliveryPushHandler = main.slice(
    main.indexOf('ipcMain.handle("workflow:delivery:push"'),
    main.indexOf('ipcMain.handle("workflow:pullRequest:create"'),
  );

  const sessionIndex = deliveryPushHandler.indexOf("const sessionId = assertWorkflowSessionId");
  const canvasIndex = deliveryPushHandler.indexOf("assertKnownWorkflowCanvasSession");
  const laneGuardIndex = deliveryPushHandler.indexOf("assertWorkflowDeliveryCommitLane");
  const resolveIndex = deliveryPushHandler.indexOf("resolveDeliveryCommitWorktreePath");
  const evidenceIndex = deliveryPushHandler.indexOf("findDeliveryCommitEvidence");
  const importIndex = deliveryPushHandler.indexOf('await import("@skyturn/git-worktree/node")');
  const pushIndex = deliveryPushHandler.indexOf("pushDeliveryBranch({");

  assert.ok(sessionIndex >= 0, "delivery push IPC must require a workflow sessionId");
  assert.ok(canvasIndex > sessionIndex, "delivery push IPC must validate the CanvasSession");
  assert.ok(laneGuardIndex > canvasIndex, "delivery push IPC must validate a commit lane");
  assert.ok(resolveIndex > laneGuardIndex, "delivery push IPC must resolve the trusted lane worktree");
  assert.ok(evidenceIndex > resolveIndex, "delivery push IPC must load recorded commit evidence before git push");
  assert.ok(importIndex > evidenceIndex, "delivery push IPC must validate evidence before importing push implementation");
  assert.ok(pushIndex > importIndex, "git push must stay after server-side guards");
});

test("workflow pull request creation validates PR lane, commit evidence, and base branch before gh create", async () => {
  const main = await readFile(join(root, "electron", "main.ts"), "utf8");
  const pullRequestHandler = main.slice(
    main.indexOf('ipcMain.handle("workflow:pullRequest:create"'),
    main.indexOf('ipcMain.handle("workflow:changeset"'),
  );

  const sessionIndex = pullRequestHandler.indexOf("const sessionId = assertWorkflowSessionId");
  const canvasIndex = pullRequestHandler.indexOf("assertKnownWorkflowCanvasSession");
  const prLaneIndex = pullRequestHandler.indexOf("assertWorkflowPullRequestLane");
  const commitLaneIndex = pullRequestHandler.indexOf("assertWorkflowDeliveryCommitLane");
  const evidenceIndex = pullRequestHandler.indexOf("findDeliveryCommitEvidence");
  const baseIndex = pullRequestHandler.indexOf("validatePullRequestBaseBranch");
  const pushEvidenceIndex = pullRequestHandler.indexOf("findDeliveryPushEvidenceForPullRequest");
  const importIndex = pullRequestHandler.indexOf('await import("@skyturn/git-worktree/node")');
  const createIndex = pullRequestHandler.indexOf("createDeliveryPullRequest({");

  assert.ok(sessionIndex >= 0, "pull request IPC must require a workflow sessionId");
  assert.ok(canvasIndex > sessionIndex, "pull request IPC must validate the CanvasSession");
  assert.ok(prLaneIndex > canvasIndex, "pull request IPC must validate a pull_request lane");
  assert.ok(commitLaneIndex > prLaneIndex, "pull request IPC must validate the source commit lane");
  assert.ok(evidenceIndex > commitLaneIndex, "pull request IPC must load recorded commit evidence");
  assert.ok(baseIndex > evidenceIndex, "pull request IPC must validate base/head before gh create");
  assert.ok(pushEvidenceIndex > baseIndex, "pull request IPC must require recorded push evidence before gh create");
  assert.ok(importIndex > pushEvidenceIndex, "pull request IPC must validate inputs before importing gh implementation");
  assert.ok(createIndex > importIndex, "gh pr create must stay after server-side guards");
});

test("workflow pull request checks validates recorded PR evidence before polling gh checks", async () => {
  const main = await readFile(join(root, "electron", "main.ts"), "utf8");
  const checksHandler = main.slice(
    main.indexOf('ipcMain.handle("workflow:pullRequest:checks"'),
    main.indexOf('ipcMain.handle("workflow:pullRequest:merge"'),
  );

  const sessionIndex = checksHandler.indexOf("const sessionId = assertWorkflowSessionId");
  const canvasIndex = checksHandler.indexOf("assertKnownWorkflowCanvasSession");
  const laneIndex = checksHandler.indexOf("assertWorkflowPullRequestLaneKind");
  const evidenceIndex = checksHandler.indexOf("findDeliveryPullRequestEvidence");
  const matchIndex = checksHandler.indexOf("assertDeliveryPullRequestEvidenceInputMatches");
  const importIndex = checksHandler.indexOf('await import("@skyturn/git-worktree/node")');
  const checksIndex = checksHandler.indexOf("checkDeliveryPullRequest({");

  assert.ok(sessionIndex >= 0, "checks IPC must require a workflow sessionId");
  assert.ok(canvasIndex > sessionIndex, "checks IPC must validate the CanvasSession");
  assert.ok(laneIndex > canvasIndex, "checks IPC must validate a pull_request lane");
  assert.ok(evidenceIndex > laneIndex, "checks IPC must load recorded PR evidence");
  assert.ok(matchIndex > evidenceIndex, "checks IPC must reject stale expectedHeadSha before gh checks");
  assert.ok(importIndex > matchIndex, "checks IPC must validate PR evidence before importing gh implementation");
  assert.ok(checksIndex > importIndex, "gh checks must stay after server-side guards");
});

test("workflow pull request merge stays explicit and separate from cleanup", async () => {
  const main = await readFile(join(root, "electron", "main.ts"), "utf8");
  const mergeHandler = main.slice(
    main.indexOf('ipcMain.handle("workflow:pullRequest:merge"'),
    main.indexOf('ipcMain.handle("workflow:delivery:syncMain"'),
  );

  const sessionIndex = mergeHandler.indexOf("const sessionId = assertWorkflowSessionId");
  const laneIndex = mergeHandler.indexOf("assertWorkflowPullRequestLaneKind");
  const evidenceIndex = mergeHandler.indexOf("findDeliveryPullRequestEvidence");
  const currentHeadIndex = mergeHandler.indexOf("findDeliveryPullRequestCurrentHeadEvidence");
  const checksEvidenceIndex = mergeHandler.indexOf("findDeliveryPullRequestChecksEvidence");
  const matchIndex = mergeHandler.indexOf("assertDeliveryPullRequestEvidenceInputMatches");
  const subjectGuardIndex = mergeHandler.indexOf("assertConventionalCommitSubjectForIpc");
  const importIndex = mergeHandler.indexOf('await import("@skyturn/git-worktree/node")');
  const mergeIndex = mergeHandler.indexOf("mergeDeliveryPullRequest({");
  const eventIndex = mergeHandler.indexOf('kind: "workflow.pull_request.merged"');

  assert.ok(sessionIndex >= 0, "merge IPC must require a workflow sessionId");
  assert.ok(laneIndex > sessionIndex, "merge IPC must validate an explicit pull_request lane");
  assert.ok(evidenceIndex > laneIndex, "merge IPC must load recorded PR evidence");
  assert.ok(currentHeadIndex > evidenceIndex, "merge IPC must derive the current PR head from recorded delivery evidence");
  assert.ok(checksEvidenceIndex > currentHeadIndex, "merge IPC must require previously recorded exact-head checks and review gate");
  assert.ok(matchIndex > checksEvidenceIndex, "merge IPC must reject stale expectedHeadSha before gh merge");
  assert.ok(subjectGuardIndex > matchIndex, "merge IPC must reject a non-Conventional merge subject before gh merge");
  assert.ok(importIndex > matchIndex, "merge IPC must validate recorded evidence before importing gh implementation");
  assert.ok(mergeIndex > importIndex, "gh merge must only happen inside the explicit merge IPC");
  assert.ok(eventIndex > mergeIndex, "merged event must be appended only after gh merge returns");
  assert.doesNotMatch(mergeHandler, /workflow:worktree:clean/);
  assert.doesNotMatch(mergeHandler, /cleanManagedWorktree/);
  assert.doesNotMatch(mergeHandler, /deleteBranch:\s*true/);
});

test("workflow pull request merge helper enforces stale, pending, failed, and review gates", async () => {
  const main = await readFile(join(root, "electron", "main.ts"), "utf8");
  const helperSource = main.slice(
    main.indexOf("function findDeliveryPullRequestChecksEvidence"),
    main.indexOf("function findDeliveryPullRequestMergeEvidence"),
  );

  assert.match(helperSource, /checks are stale/i);
  assert.match(helperSource, /checks must be passed before merge/i);
  assert.match(helperSource, /review requested changes/i);
  assert.match(helperSource, /reviewStatus|review\.status/);
  assert.match(helperSource, /review evidence must be approved or pending/i);
  assert.match(helperSource, /reviewStatus !== "approved" && evidence\.reviewStatus !== "pending"/);
});

test("workflow pull request merge helper rejects unknown or missing review evidence", async () => {
  const { findDeliveryPullRequestChecksEvidence } = await loadMainMergeGateHelpers();
  const expectedHeadSha = "abc123";
  const baseEvent = {
    kind: "workflow.pull_request.checks_recorded",
    laneId: "pr-lane",
    payload: {
      laneId: "pr-lane",
      evidence: {
        status: "passed",
        headSha: expectedHeadSha,
      },
    },
  };

  for (const reviewStatus of ["approved", "pending"]) {
    const evidence = findDeliveryPullRequestChecksEvidence(
      storeWithEvents([{
        ...baseEvent,
        payload: {
          ...baseEvent.payload,
          evidence: {
            ...baseEvent.payload.evidence,
            gate: { reviewStatus },
          },
        },
      }]),
      "session-1",
      "pr-lane",
      expectedHeadSha,
    );
    assert.equal(evidence.reviewStatus, reviewStatus);
  }

  for (const event of [
    baseEvent,
    {
      ...baseEvent,
      payload: {
        ...baseEvent.payload,
        evidence: {
          ...baseEvent.payload.evidence,
          gate: { reviewStatus: "unknown" },
        },
      },
    },
  ]) {
    assert.throws(
      () => findDeliveryPullRequestChecksEvidence(storeWithEvents([event]), "session-1", "pr-lane", expectedHeadSha),
      (error) => error?.code === "DELIVERY_REJECTED" &&
        /review evidence must be approved or pending/i.test(error.message),
    );
  }
});

test("workflow delivery sync main requires recorded PR merge evidence for the requested head", async () => {
  const main = await readFile(join(root, "electron", "main.ts"), "utf8");
  const syncHandler = main.slice(
    main.indexOf('ipcMain.handle("workflow:delivery:syncMain"'),
    main.indexOf('ipcMain.handle("workflow:changeset"'),
  );
  const helperSource = main.slice(
    main.indexOf("function findDeliveryPullRequestMergeEvidence"),
    main.indexOf("function assertDeliveryEvidenceInputMatches"),
  );

  const sessionIndex = syncHandler.indexOf("const sessionId = assertWorkflowSessionId");
  const canvasIndex = syncHandler.indexOf("assertKnownWorkflowCanvasSession");
  const laneIndex = syncHandler.indexOf('const laneId = requireText(readField(input, "laneId"), "workflow pull request laneId")');
  const laneGuardIndex = syncHandler.indexOf("assertWorkflowPullRequestLaneKind");
  const prEvidenceIndex = syncHandler.indexOf("findDeliveryPullRequestEvidence");
  const matchIndex = syncHandler.indexOf("assertDeliveryPullRequestEvidenceInputMatches");
  const mergeEvidenceIndex = syncHandler.indexOf("findDeliveryPullRequestMergeEvidence");
  const importIndex = syncHandler.indexOf('await import("@skyturn/git-worktree/node")');
  const syncIndex = syncHandler.indexOf("syncDeliveryMain({");

  assert.ok(laneIndex > canvasIndex, "sync main IPC must require an explicit pull_request lane after session validation");
  assert.ok(laneGuardIndex > laneIndex, "sync main IPC must validate the lane is a pull_request lane");
  assert.ok(prEvidenceIndex > laneGuardIndex, "sync main IPC must load recorded PR evidence");
  assert.ok(matchIndex > prEvidenceIndex, "sync main IPC must reject stale expectedHeadSha before sync");
  assert.ok(mergeEvidenceIndex > matchIndex, "sync main IPC must require recorded merge evidence for that PR/head");
  assert.ok(importIndex > mergeEvidenceIndex, "ff-only sync must stay after post-merge evidence validation");
  assert.ok(syncIndex > importIndex, "git sync must stay after server-side guards");
  assert.match(helperSource, /workflow\.pull_request\.merged/);
  assert.match(helperSource, /prNumber/);
  assert.match(helperSource, /headSha/);
  assert.match(helperSource, /status[^\n]+merged/);
});

test("workflow delivery sync main uses an explicit ff-only IPC and records main_synced", async () => {
  const main = await readFile(join(root, "electron", "main.ts"), "utf8");
  const syncHandler = main.slice(
    main.indexOf('ipcMain.handle("workflow:delivery:syncMain"'),
    main.indexOf('ipcMain.handle("workflow:changeset"'),
  );

  const sessionIndex = syncHandler.indexOf("const sessionId = assertWorkflowSessionId");
  const canvasIndex = syncHandler.indexOf("assertKnownWorkflowCanvasSession");
  const importIndex = syncHandler.indexOf('await import("@skyturn/git-worktree/node")');
  const syncIndex = syncHandler.indexOf("syncDeliveryMain({");
  const eventIndex = syncHandler.indexOf('kind: "workflow.delivery.main_synced"');

  assert.ok(sessionIndex >= 0, "sync main IPC must require a workflow sessionId to append evidence");
  assert.ok(canvasIndex > sessionIndex, "sync main IPC must validate the CanvasSession");
  assert.ok(importIndex > canvasIndex, "sync main IPC must validate session before importing git implementation");
  assert.ok(syncIndex > importIndex, "git sync must stay after server-side guards");
  assert.ok(eventIndex > syncIndex, "main_synced event must be appended after ff-only sync");
  assert.match(syncHandler, /const mainBranch = optionalText\(readField\(input,\s*"mainBranch"\)\)\s*\?\?\s*"main"/);
  assert.match(syncHandler, /mainBranch,/);
  assert.doesNotMatch(syncHandler, /cleanManagedWorktree/);
  assert.doesNotMatch(syncHandler, /deleteBranch/);
});

test("workflow delivery commit validates a commit lane before creating git commits", async () => {
  const main = await readFile(join(root, "electron", "main.ts"), "utf8");
  const deliveryCommitHandler = main.slice(
    main.indexOf('ipcMain.handle("workflow:delivery:commit"'),
    main.indexOf('ipcMain.handle("workflow:changeset"'),
  );
  const helperSource = main.slice(
    main.indexOf("function assertWorkflowDeliveryCommitLane"),
    main.indexOf("async function assertComparedWorktreeBelongsToProject"),
  );

  const canvasIndex = deliveryCommitHandler.indexOf("assertKnownWorkflowCanvasSession");
  const laneIdIndex = deliveryCommitHandler.indexOf('const laneId = requireText(readField(input, "laneId"), "workflow commit laneId")');
  const laneGuardIndex = deliveryCommitHandler.indexOf("assertWorkflowDeliveryCommitLane(store, sessionId, laneId)");
  const importIndex = deliveryCommitHandler.indexOf('await import("@skyturn/git-worktree/node")');
  const commitIndex = deliveryCommitHandler.indexOf("createDeliveryCommit({");

  assert.ok(laneIdIndex > canvasIndex, "delivery commit IPC must require laneId after validating the session");
  assert.ok(laneGuardIndex > laneIdIndex, "delivery commit IPC must resolve laneId through the Flow projection");
  assert.ok(laneGuardIndex < importIndex, "unknown or non-commit laneIds must reject before importing commit implementation");
  assert.ok(commitIndex > laneGuardIndex, "git commit creation must stay after commit-lane validation");
  assert.match(helperSource, /store\.materializeFlowProjection\(sessionId\)/);
  assert.match(helperSource, /\.id === laneId/);
  assert.match(helperSource, /lane\.laneKind !== "commit"/);
});

test("workflow delivery commit resolves commit worktree from CanvasSession before creating git commits", async () => {
  const main = await readFile(join(root, "electron", "main.ts"), "utf8");
  const deliveryCommitHandler = main.slice(
    main.indexOf('ipcMain.handle("workflow:delivery:commit"'),
    main.indexOf('ipcMain.handle("workflow:changeset"'),
  );
  const helperSource = main.slice(
    main.indexOf("async function resolveDeliveryCommitWorktreePath"),
    main.indexOf("async function assertComparedWorktreeBelongsToProject"),
  );

  const laneGuardIndex = deliveryCommitHandler.indexOf("assertWorkflowDeliveryCommitLane(store, sessionId, laneId)");
  const resolveIndex = deliveryCommitHandler.indexOf("resolveDeliveryCommitWorktreePath(");
  const importIndex = deliveryCommitHandler.indexOf('await import("@skyturn/git-worktree/node")');
  const commitIndex = deliveryCommitHandler.indexOf("createDeliveryCommit({");

  assert.ok(resolveIndex > laneGuardIndex, "delivery commit IPC must resolve the worktree after commit-lane validation");
  assert.ok(resolveIndex < importIndex, "renderer worktreePath must be validated before importing git commit implementation");
  assert.ok(commitIndex > resolveIndex, "git commit creation must use the server-resolved worktree path");
  assert.match(deliveryCommitHandler, /const worktreePath = await resolveDeliveryCommitWorktreePath\(store,\s*sessionId,\s*laneId,\s*rawWorktreePath,\s*realProjectRoot\)/);
  assert.match(helperSource, /store\.materializeCanvasSession\(sessionId\)/);
  assert.match(helperSource, /node\.id === laneId/);
  assert.match(helperSource, /node\.worktree/);
  assert.match(helperSource, /await fs\.realpath\(expectedWorktreePath\)/);
  assert.match(helperSource, /await fs\.realpath\(suppliedWorktreePath\)/);
  assert.match(helperSource, /realSuppliedWorktreePath !== realExpectedWorktreePath/);
  assert.match(helperSource, /UNSAFE_WORKTREE_PATH/);
});

test("workflow delivery commit passes explicit mismatch acceptance to git service", async () => {
  const main = await readFile(join(root, "electron", "main.ts"), "utf8");
  const deliveryCommitHandler = main.slice(
    main.indexOf('ipcMain.handle("workflow:delivery:commit"'),
    main.indexOf('ipcMain.handle("workflow:changeset"'),
  );

  assert.match(deliveryCommitHandler, /const acceptMismatch = readField\(input,\s*"acceptMismatch"\) === true/);
  assert.match(deliveryCommitHandler, /\.\.\.\(acceptMismatch \? \{ acceptMismatch \} : \{\}\)/);
});

test("workflow createSession resolves and persists the authoritative current branch target", async () => {
  const main = await readFile(join(root, "electron", "main.ts"), "utf8");
  const createInput = main.slice(
    main.indexOf("interface WorkflowSessionCreateInput"),
    main.indexOf("interface WorkflowAppendUserInput"),
  );
  const createSessionHandler = main.slice(
    main.indexOf('ipcMain.handle("workflow:createSession"'),
    main.indexOf('ipcMain.handle("workflow:appendUserInput"'),
  );

  assert.match(createInput, /target\?:\s*unknown/);
  assert.match(createSessionHandler, /const target = await resolveAuthoritativeWorkflowSessionTarget\(projectRoot, input\.target\)/);
  assert.match(createSessionHandler, /target,/);
  assert.match(main, /function normalizeWorkflowSessionTarget\(value: unknown\): FinalSessionTarget/);
  assert.match(main, /return \{ executionTarget: "current_branch", selectedBranch: "HEAD" \};/);
});

test("workflow checkpoint resolution persists a legacy HEAD branch before identity validation", async () => {
  const main = await readFile(join(root, "electron", "main.ts"), "utf8");
  const resolver = main.slice(
    main.indexOf("async function resolveExecutableRunIdentity"),
    main.indexOf("function isExecutableCheckpointLane"),
  );
  const persistenceIndex = resolver.indexOf("resolveAuthoritativeStoredCurrentBranchTarget");
  const canvasIndex = resolver.indexOf("store.materializeCanvasSession");
  const branchValidationIndex = resolver.indexOf("Workflow run branch mismatch");

  assert.ok(persistenceIndex >= 0, "checkpoint resolution must persist legacy HEAD targets");
  assert.ok(canvasIndex > persistenceIndex, "checkpoint resolution must rematerialize the authoritative target");
  assert.ok(branchValidationIndex > canvasIndex, "checkpoint branch validation must use persisted authority");
});

test("workflow create and append launch Hermes through AgentBridge while PTY stays optional", async () => {
  const main = await readFile(join(root, "electron", "main.ts"), "utf8");
  const createSessionHandler = main.slice(
    main.indexOf('ipcMain.handle("workflow:createSession"'),
    main.indexOf('ipcMain.handle("workflow:finishPlan"'),
  );
  const appendHandler = main.slice(
    main.indexOf('ipcMain.handle("workflow:appendUserInput"'),
    main.indexOf('ipcMain.handle("workflow:ledger"'),
  );
  const deliveryHelper = main.slice(
    main.indexOf("async function deliverWorkflowUserInputToPlanner"),
    main.indexOf("function workflowPlannerProjectIdentity"),
  );
  const projectionBroadcaster = main.slice(
    main.indexOf("function broadcastWorkflowProjection"),
    main.indexOf("function broadcastTerminalEvent"),
  );
  const materializer = main.slice(
    main.indexOf("function materializeRendererCanvasSession"),
    main.indexOf("function assertWorkflowSessionId"),
  );

  assert.match(main, /createTerminalRuntime/);
  assert.match(createSessionHandler, /deliverWorkflowUserInputToPlanner/);
  assert.match(createSessionHandler, /materializeRendererCanvasSession/);
  assert.match(appendHandler, /deliverWorkflowUserInputToPlanner/);
  assert.match(appendHandler, /materializeRendererCanvasSession/);
  assert.match(deliveryHelper, /input\.store\.claimUserInput/);
  assert.match(deliveryHelper, /buildHermesWorkflowPrompt/);
  assert.match(deliveryHelper, /plannerRunStartHandler/);
  assert.doesNotMatch(deliveryHelper, /publicRunStartHandler/);
  assert.match(deliveryHelper, /input\.store\.recordUserInputDelivered/);
  assert.match(projectionBroadcaster, /materializeRendererCanvasSession/);
  assert.match(materializer, /augmentCanvasSessionWithHermesTerminal/);
  assert.match(materializer, /terminalRuntime\.hermesPlannerTerminalSessionId/);
  assert.doesNotMatch(createSessionHandler, /terminalRuntime\.|terminal:start/);
  assert.doesNotMatch(appendHandler, /terminalRuntime\.|terminal:start/);
});

test("ordinary workflow creation never forwards renderer opaque handles to planner runs", async () => {
  const main = await readFile(join(root, "electron", "main.ts"), "utf8");
  const createSessionHandler = main.slice(
    main.indexOf('ipcMain.handle("workflow:createSession"'),
    main.indexOf('ipcMain.handle("workflow:finishPlan"'),
  );
  const appendHandler = main.slice(
    main.indexOf('ipcMain.handle("workflow:appendUserInput"'),
    main.indexOf('ipcMain.handle("workflow:ledger"'),
  );

  assert.match(createSessionHandler, /const inputOpaqueHandle = optionalText\(input\.opaqueHandle\)/);
  assert.match(createSessionHandler, /const opaqueHandle = inputOpaqueHandle \?\? `skyturn-ipc:\$\{sessionId\}`/);
  assert.doesNotMatch(createSessionHandler, /hermesSessionHandle/);
  assert.doesNotMatch(appendHandler, /hermesSessionHandle/);
  assert.doesNotMatch(main, /function explicitHermesSessionHandle/);
});

test("workflow projection responses keep the Hermes planner terminal binding", async () => {
  const helpers = await loadMainRendererCanvasSessionHelpers();
  const store = {
    materializeCanvasSession(sessionId) {
      return { kind: "canvas", id: sessionId, nodes: [] };
    },
  };

  assert.deepEqual(
    toPlain(helpers.materializeRendererCanvasSession(store, "session-1")),
    {
      kind: "canvas",
      id: "session-1",
      nodes: [],
      hermesPlannerTerminalSessionId: "hermes-planner-session-1",
    },
  );
  assert.deepEqual(
    toPlain(helpers.materializeRendererCanvasSession(store, "session-without-terminal")),
    { kind: "canvas", id: "session-without-terminal", nodes: [] },
  );
});

test("workflow projection query materializes one authoritative snapshot under the session mutation lock", async () => {
  const main = await readFile(join(root, "electron", "main.ts"), "utf8");
  const projectionHandler = main.slice(
    main.indexOf('ipcMain.handle("workflow:projection"'),
    main.indexOf('ipcMain.handle("workflow:events"'),
  );
  const workflowStoreIdentityIndex = projectionHandler.indexOf(
    "const workflowProjectRoot = await workflowStoreIdentity(projectRoot)",
  );
  const lockIndex = projectionHandler.indexOf(
    "return await withWorkflowSessionMutationLock(workflowProjectRoot, workflowSessionId, async () => {",
  );
  const storeIndex = projectionHandler.indexOf("const store = await getWorkflowStore(projectRoot)");
  const advanceIndex = projectionHandler.indexOf("await advanceWorkflowSession(");
  const projectionIndex = projectionHandler.indexOf("projection: store.materializeFlowProjection(workflowSessionId)");
  const canvasIndex = projectionHandler.indexOf(
    "canvasSession: materializeRendererCanvasSession(store, workflowSessionId)",
  );
  const lockCloseIndex = projectionHandler.lastIndexOf("  });");

  assert.ok(workflowStoreIdentityIndex >= 0, "projection query must canonicalize the store identity before locking");
  assert.ok(lockIndex > workflowStoreIdentityIndex, "projection query must acquire the canonical session mutation lock");
  assert.ok(storeIndex > lockIndex, "projection query must get the store again inside the lock");
  assert.ok(advanceIndex > storeIndex, "projection query must advance the session inside the lock");
  assert.ok(projectionIndex > advanceIndex, "projection query must materialize the projection after advancing");
  assert.ok(canvasIndex > projectionIndex, "projection query must materialize CanvasSession from the same locked snapshot");
  assert.ok(lockCloseIndex > canvasIndex, "the session mutation lock must cover the authoritative return boundary");
  assert.doesNotMatch(
    projectionHandler.slice(0, lockIndex),
    /getWorkflowStore|advanceWorkflowSession|materializeFlowProjection|materializeRendererCanvasSession/,
  );
  assert.doesNotMatch(
    projectionHandler.slice(lockCloseIndex + "  });".length),
    /getWorkflowStore|advanceWorkflowSession|materializeFlowProjection|materializeRendererCanvasSession/,
  );
});

test("workflow renderer canvas session responses use the terminal-aware materializer", async () => {
  const main = await readFile(join(root, "electron", "main.ts"), "utf8");
  const projectionHandler = main.slice(
    main.indexOf('ipcMain.handle("workflow:projection"'),
    main.indexOf('ipcMain.handle("workflow:events"'),
  );
  const broadcaster = main.slice(
    main.indexOf("function broadcastWorkflowProjection"),
    main.indexOf("function broadcastTerminalEvent"),
  );

  assert.match(projectionHandler, /canvasSession:\s*materializeRendererCanvasSession\(store,\s*workflowSessionId\)/);
  assert.match(broadcaster, /const canvasSession = materializeRendererCanvasSession\(store,\s*sessionId\)/);
  assert.doesNotMatch(main, /canvasSession:\s*store\.materializeCanvasSession\(/);
});

test("Electron project memory IPC does not register arbitrary renderer paths", async () => {
  const main = await readFile(join(root, "electron", "main.ts"), "utf8");
  const initHandler = main.match(/ipcMain\.handle\("project:initDevflow"[\s\S]*?\n\}\);/)?.[0] ?? "";
  const saveHandler = main.match(/ipcMain\.handle\("workspace:save"[\s\S]*?\n\}\);/)?.[0] ?? "";
  const authorizeWorkspaceStateForSave = main.slice(
    main.indexOf("async function authorizeWorkspaceStateForSave"),
    main.indexOf("async function trustedWorkspaceProjectIdentities"),
  );
  const workspaceSaveWriter = main.slice(
    main.indexOf("function createWorkspaceSaveWriter"),
    main.indexOf("async function writeWorkspaceStateAtomically"),
  );

  assert.match(initHandler, /assertKnownProjectRoot\(rootPath\)/);
  assert.doesNotMatch(initHandler, /openedProjectRoots\.add\(rootPath\)/);
  assert.doesNotMatch(saveHandler, /rememberProjectRoots/);
  assert.match(saveHandler, /workspaceSaveWriter\.save\(state\)/);
  assert.match(workspaceSaveWriter, /await authorizeWorkspaceStateForSave\(request\.state\)/);
  assert.match(authorizeWorkspaceStateForSave, /sanitizeWorkspaceStateForPersistence\(state\)/);
  assert.doesNotMatch(saveHandler, /openedProjectRoots/);
});

test("preload exposes narrow natural workflow wrappers", async () => {
  const preload = await readFile(join(root, "electron", "preload.ts"), "utf8");

  for (const wrapper of [
    "createWorkflowSession",
    "appendWorkflowUserInput",
    "getWorkflowLedger",
    "getWorkflowProjection",
    "getWorkflowEvents",
    "getCheckpoints",
    "getPendingInsertBeforeRequest",
    "insertBefore",
    "getRollbackEligibility",
    "applyRollback",
    "requestRepair",
    "requestVariant",
    "getChangeset",
    "createSession",
    "appendUserInput",
    "getLedger",
    "updateNodePosition",
    "getProjection",
    "getEvents",
    "reassignLane",
    "getCheckpoints",
    "getPendingInsertBeforeRequest",
    "insertBefore",
    "getRollbackEligibility",
    "applyRollback",
    "requestRepair",
    "requestVariant",
    "answerUserDecision",
    "createWorktree",
    "compareWorktrees",
    "adoptWorktree",
    "cleanWorktree",
    "createDeliveryCommit",
    "pushDeliveryBranch",
    "createPullRequest",
    "checkPullRequest",
    "mergePullRequest",
    "syncMain",
    "reconcileFinalChangeset",
    "getProjectBranchFacts",
    "createWorkflowDeliveryCommit",
    "pushWorkflowDeliveryBranch",
    "createWorkflowPullRequest",
    "checkWorkflowPullRequest",
    "mergeWorkflowPullRequest",
    "syncWorkflowMain",
  ]) {
    assert.match(preload, new RegExp(`${wrapper}\\s*:`));
  }
  for (const wrapper of [
    "applyWorkflowIntent",
    "scheduleWorkflowReadyLanes",
    "recordWorkflowRunResult",
    "applyIntent",
    "scheduleReady",
    "recordRunResult",
  ]) {
    assert.doesNotMatch(preload, new RegExp(`${wrapper}\\s*:`));
  }
  for (const channel of ["workflow:applyIntent", "workflow:scheduleReady", "workflow:recordRunResult"]) {
    assert.doesNotMatch(preload, new RegExp(escapeRegExp(channel)));
  }
  assert.doesNotMatch(preload, /ipcRenderer\s*:/);
  assert.doesNotMatch(preload, /return\s+ipcRenderer/);
  assert.doesNotMatch(preload, /execFile|spawn|shell|fs\./);
});

test("preload position update wrapper is compile-time checked against WorkflowApi", async () => {
  const preloadSource = await readFile(new URL("../electron/preload.ts", import.meta.url), "utf8");
  assert.match(preloadSource, /WorkflowApi,[\s\S]*WorkflowNodePositionUpdateRequest,[\s\S]*resolution-mode/);
  assert.match(preloadSource, /input: WorkflowNodePositionUpdateRequest/);
  assert.match(preloadSource, /satisfies WorkflowApi/);
});

test("renderer workflow types expose no backend apply, schedule, or result mutators", async () => {
  const source = await readFile(join(root, "..", "..", "packages", "persistence", "src", "index.ts"), "utf8");
  const workflowApi = source.slice(source.indexOf("export interface WorkflowApi"), source.indexOf("export interface DevflowApi"));
  const devflowApi = source.slice(source.indexOf("export interface DevflowApi"), source.indexOf("declare global"));

  for (const mutator of [
    "applyIntent",
    "scheduleReady",
    "recordRunResult",
    "applyWorkflowIntent",
    "scheduleWorkflowReadyLanes",
    "recordWorkflowRunResult",
  ]) {
    assert.doesNotMatch(workflowApi, new RegExp(`${mutator}\\s*:`));
    assert.doesNotMatch(devflowApi, new RegExp(`${mutator}\\s*:`));
  }
});

test("node position IPC returns the authoritative session without a duplicate renderer broadcast", async () => {
  const mainSource = await readFile(new URL("../electron/main.ts", import.meta.url), "utf8");
  const handler = mainSource.slice(
    mainSource.indexOf('ipcMain.handle("workflow:nodePosition:update"'),
    mainSource.indexOf('ipcMain.handle("workflow:projection"'),
  );

  assert.match(handler, /recordCanvasNodePosition/);
  assert.match(handler, /canvasSession: materializeRendererCanvasSession/);
  assert.doesNotMatch(handler, /broadcastWorkflowProjection/);
});

test("workflow createWorktree public type contract returns created status", async () => {
  const persistence = await readFile(join(root, "..", "..", "packages", "persistence", "src", "index.ts"), "utf8");
  const createWorktreeContract = persistence.slice(
    persistence.indexOf("createWorktree:"),
    persistence.indexOf("compareWorktrees:"),
  );

  assert.match(createWorktreeContract, /status:\s*"created"/);
  assert.doesNotMatch(createWorktreeContract, /status:\s*"requested"/);
});

test("workflow compareWorktrees uses IDs only and resolves durable session identities", async () => {
  const main = await readFile(join(root, "electron", "main.ts"), "utf8");
  const preload = await readFile(join(root, "electron", "preload.ts"), "utf8");
  const persistence = await readFile(join(root, "..", "..", "packages", "persistence", "src", "index.ts"), "utf8");
  const compareHandler = main.slice(
    main.indexOf('ipcMain.handle("workflow:worktree:compare"'),
    main.indexOf('ipcMain.handle("workflow:worktree:adopt"'),
  );
  const compareContract = persistence.slice(
    persistence.indexOf("compareWorktrees:"),
    persistence.indexOf("adoptWorktree:"),
  );

  assert.match(compareContract, /input:\s*WorktreeComparisonRequest/);
  assert.match(compareContract, /comparison:\s*VariantComparisonEvidence/);
  assert.doesNotMatch(compareContract, /comparison:\s*unknown/);
  assert.match(compareHandler, /compareWorkflowWorktrees/);
  assert.match(preload, /parseWorktreeComparisonRequest\(input\)/);
  assert.match(preload, /parseVariantComparisonEvidence/);

  const renderer = await readFile(join(root, "..", "..", "packages", "ui-canvas", "src", "App.tsx"), "utf8");
  const handleCompare = renderer.slice(renderer.indexOf("const handleCompare"), renderer.indexOf("const handleAdopt"));
  assert.match(handleCompare, /sessionId:\s*session\.id/);
  assert.match(handleCompare, /leftWorktreeId:\s*node\.worktree\.worktreeId/);
  assert.match(handleCompare, /rightWorktreeId:\s*otherNode\.worktree\.worktreeId/);
  assert.doesNotMatch(handleCompare, /\bleft:\s*node\.worktree|\bright:\s*otherNode\.worktree|realPath|repoRoot|branchName|headCommit/);
});

test("workflow compare runtime rejects untrusted identities and sanitizes unknown failures", async () => {
  const runtime = await loadWorktreeComparisonRuntime();
  const validEvents = [createdWorktreeEvent("session-1", "worktree-left", "variant-left"), createdWorktreeEvent("session-1", "worktree-right", "variant-right")];
  const validInput = { sessionId: "session-1", leftWorktreeId: "worktree-left", rightWorktreeId: "worktree-right" };

  for (const events of [
    [createdWorktreeEvent("session-other", "worktree-left", "variant-left"), validEvents[1]],
    [createdWorktreeEvent("session-1", "forged-left", "variant-left"), validEvents[1]],
    [...validEvents, { sessionId: "session-1", kind: "workflow.worktree.cleaned", payload: { worktreeId: "worktree-left" } }],
    [createdWorktreeEvent("session-1", "worktree-left", "variant-left", "/other-project"), validEvents[1]],
  ]) {
    const harness = comparisonHarness(events);
    await assert.rejects(runtime.compareWorkflowWorktrees(harness.dependencies, "/project", validInput), /SKYTURN_WORKFLOW_IPC_ERROR:(INVALID_INPUT|UNKNOWN_PROJECT):/);
    assert.equal(harness.compareCalls.length, 0);
  }

  for (const failure of [new Error("import failed at /secret/repo"), new Error("service failed at /secret/worktree")]) {
    const harness = comparisonHarness(validEvents, failure);
    await assert.rejects(runtime.compareWorkflowWorktrees(harness.dependencies, "/project", validInput), (error) => {
      assert.equal(error.message, "SKYTURN_WORKFLOW_IPC_ERROR:INVALID_INPUT: Worktree comparison failed.");
      assert.doesNotMatch(error.message, /secret|repo|worktree$/);
      return true;
    });
  }

  const spoofed = comparisonHarness(
    validEvents,
    new Error("SKYTURN_WORKFLOW_IPC_ERROR:INVALID_INPUT: failed at /secret/spoofed-worktree"),
  );
  await assert.rejects(runtime.compareWorkflowWorktrees(spoofed.dependencies, "/project", validInput), (error) => {
    assert.equal(error.message, "SKYTURN_WORKFLOW_IPC_ERROR:INVALID_INPUT: Worktree comparison failed.");
    assert.doesNotMatch(error.message, /secret|spoofed-worktree/);
    return true;
  });
});

test("workflow compare runtime performs a valid side-effect-free comparison and rejects malformed results", async () => {
  const runtime = await loadWorktreeComparisonRuntime();
  const events = [createdWorktreeEvent("session-1", "worktree-left", "variant-left"), createdWorktreeEvent("session-1", "worktree-right", "variant-right")];
  const input = { sessionId: "session-1", leftWorktreeId: "worktree-left", rightWorktreeId: "worktree-right" };
  const harness = comparisonHarness(events);

  const result = await runtime.compareWorkflowWorktrees(harness.dependencies, "/project", input);
  assert.equal(result.comparison.comparisonId, "comparison-left-right");
  assert.equal(harness.compareCalls.length, 1);
  assert.equal(harness.serviceOptions.length, 1);
  assert.equal(harness.serviceOptions[0], undefined);

  const malformed = comparisonHarness(events, null, { comparisonId: 42, variants: [] });
  await assert.rejects(runtime.compareWorkflowWorktrees(malformed.dependencies, "/project", input), {
    message: "SKYTURN_WORKFLOW_IPC_ERROR:INVALID_INPUT: Worktree comparison failed.",
  });

  const failedEvidence = validComparisonEvidence();
  failedEvidence.variants = [{
    variantId: "variant-left",
    worktreeId: "worktree-left",
    changeset: { status: "failed", errorReason: "fatal at /secret/worktree" },
    metrics: [{ kind: "diff-summary", detail: "fatal at /secret/worktree" }],
  }];
  const failed = comparisonHarness(events, null, failedEvidence);
  const sanitized = await runtime.compareWorkflowWorktrees(failed.dependencies, "/project", input);
  assert.equal(sanitized.comparison.variants[0].changeset.errorReason, "Git changeset collection failed.");
  assert.equal(sanitized.comparison.variants[0].metrics[0].detail, "Git changeset collection failed.");
});

test("workflow lane reassignment public contract is typed and returns the authoritative canvas", async () => {
  const persistence = await readFile(join(root, "..", "..", "packages", "persistence", "src", "index.ts"), "utf8");
  const contract = persistence.slice(
    persistence.indexOf("export interface WorkflowLaneReassignRequest"),
    persistence.indexOf("export type WorkflowRollbackBlockCode"),
  );

  assert.match(contract, /sessionId:\s*string/);
  assert.match(contract, /requestId:\s*string/);
  assert.match(contract, /laneId:\s*string/);
  assert.match(contract, /agentKind:\s*AgentKind/);
  assert.match(contract, /kind:\s*"workflow\.lane\.reassigned"/);
  assert.match(contract, /previousAgentKind:\s*AgentKind/);
  assert.match(contract, /canvasSession:\s*CanvasSession/);
});

test("workflow insert-before contract is narrow and returns authoritative lane identity", async () => {
  const persistence = await readFile(join(root, "..", "..", "packages", "persistence", "src", "index.ts"), "utf8");
  const request = persistence.slice(
    persistence.indexOf("export interface WorkflowInsertBeforeRequest"),
    persistence.indexOf("export interface WorkflowInsertBeforeResult"),
  );
  const result = persistence.slice(
    persistence.indexOf("export interface WorkflowInsertBeforeResult"),
    persistence.indexOf("export interface WorkflowNodePositionUpdateRequest"),
  );

  assert.match(request, /sessionId:\s*string/);
  assert.match(request, /targetLaneId:\s*string/);
  assert.match(request, /requestId:\s*string/);
  assert.doesNotMatch(request, /runtimePolicy|executable|sandbox|agentKind/);
  assert.match(result, /status:\s*"inserted"/);
  assert.match(result, /laneId:\s*string/);
  assert.match(result, /canvasSession:\s*CanvasSession \| null/);
});

test("workflow insert-before pending identity is resolved only by Electron backend truth", async () => {
  const main = await readFile(join(root, "electron", "main.ts"), "utf8");
  const handler = main.slice(
    main.indexOf('ipcMain.handle("workflow:insertBefore:pending"'),
    main.indexOf('ipcMain.handle("workflow:insertBefore"'),
  );

  assert.match(handler, /assertKnownProjectRoot\(projectRoot\)/);
  assert.match(handler, /assertKnownWorkflowCanvasSession\(store,\s*sessionId\)/);
  assert.match(handler, /findPendingInsertBeforeRequest/);
  assert.doesNotMatch(handler, /fs\.|better-sqlite3|materializeFlowProjection/);
});

test("workflow insert-before response survives post-commit broadcast failure", async () => {
  const main = await readFile(join(root, "electron", "main.ts"), "utf8");
  const handler = main.slice(
    main.indexOf('ipcMain.handle("workflow:insertBefore"'),
    main.indexOf('ipcMain.handle("workflow:rollback:eligibility"'),
  );
  assert.match(handler, /try\s*\{[\s\S]*broadcastWorkflowProjection[\s\S]*\}\s*catch/);
  assert.match(handler, /result\.canvasSession/);
  assert.doesNotMatch(handler, /canvasSession:\s*materializeRendererCanvasSession/);
});

test("workflow insert-before response preserves the Hermes planner terminal binding", async () => {
  const main = await readFile(join(root, "electron", "main.ts"), "utf8");
  const handler = main.slice(
    main.indexOf('ipcMain.handle("workflow:insertBefore"'),
    main.indexOf('ipcMain.handle("workflow:rollback:eligibility"'),
  );

  assert.match(
    handler,
    /canvasSession:\s*augmentCanvasSessionWithHermesTerminal\(\s*result\.canvasSession,\s*terminalRuntime\.hermesPlannerTerminalSessionId\(sessionId\),?\s*\)/,
  );
  assert.doesNotMatch(handler, /canvasSession:\s*materializeRendererCanvasSession/);
});

test("workflow adopt and clean public type contracts return terminal statuses", async () => {
  const persistence = await readFile(join(root, "..", "..", "packages", "persistence", "src", "index.ts"), "utf8");
  const adoptWorktreeContract = persistence.slice(
    persistence.indexOf("adoptWorktree:"),
    persistence.indexOf("cleanWorktree:"),
  );
  const cleanWorktreeContract = persistence.slice(
    persistence.indexOf("cleanWorktree:"),
    persistence.indexOf("getChangeset:"),
  );

  assert.match(adoptWorktreeContract, /status:\s*"adopted"\s*\|\s*"failed"/);
  assert.match(adoptWorktreeContract, /adoption:/);
  assert.doesNotMatch(adoptWorktreeContract, /status:\s*"requested"/);
  assert.match(cleanWorktreeContract, /status:\s*"cleaned"/);
  assert.match(cleanWorktreeContract, /result:/);
  assert.doesNotMatch(cleanWorktreeContract, /status:\s*"requested"/);
});

test("workflow delivery commit public type contract returns committed evidence", async () => {
  const persistence = await readFile(join(root, "..", "..", "packages", "persistence", "src", "index.ts"), "utf8");
  const workflowContract = persistence.slice(
    persistence.indexOf("createDeliveryCommit:"),
    persistence.indexOf("getChangeset:"),
  );
  const devflowContract = persistence.slice(
    persistence.lastIndexOf("createWorkflowDeliveryCommit:"),
    persistence.indexOf("onRunEvent:"),
  );

  assert.match(workflowContract, /status:\s*"committed"/);
  assert.match(workflowContract, /evidence:\s*DeliveryCommitEvidence/);
  assert.match(devflowContract, /status:\s*"committed"/);
  assert.match(devflowContract, /evidence:\s*DeliveryCommitEvidence/);
});

test("workflow delivery remote public type contracts return push and PR evidence", async () => {
  const persistence = await readFile(join(root, "..", "..", "packages", "persistence", "src", "index.ts"), "utf8");
  const workflowContract = persistence.slice(
    persistence.indexOf("pushDeliveryBranch:"),
    persistence.indexOf("getChangeset:"),
  );
  const devflowContract = persistence.slice(
    persistence.indexOf("createWorkflowDeliveryCommit:"),
    persistence.indexOf("onRunEvent:"),
  );

  assert.match(persistence, /type WorkflowDeliveryPushResult[\s\S]*status:\s*"pushed"[\s\S]*evidence:\s*DeliveryPushEvidence/);
  assert.match(persistence, /type WorkflowPullRequestCreateResult[\s\S]*status:\s*"created"[\s\S]*evidence:\s*DeliveryPullRequestEvidence/);
  assert.match(workflowContract, /pushDeliveryBranch:.*Promise<WorkflowDeliveryPushResult>/);
  assert.match(workflowContract, /createPullRequest:.*Promise<WorkflowPullRequestCreateResult>/);
  assert.match(devflowContract, /pushWorkflowDeliveryBranch:.*Promise<WorkflowDeliveryPushResult>/);
  assert.match(devflowContract, /createWorkflowPullRequest:.*Promise<WorkflowPullRequestCreateResult>/);
});

test("workflow delivery remote public type contracts return checks, merge, and sync evidence", async () => {
  const persistence = await readFile(join(root, "..", "..", "packages", "persistence", "src", "index.ts"), "utf8");
  const workflowContract = persistence.slice(
    persistence.indexOf("pushDeliveryBranch:"),
    persistence.indexOf("getChangeset:"),
  );
  const devflowContract = persistence.slice(
    persistence.indexOf("createWorkflowDeliveryCommit:"),
    persistence.indexOf("onRunEvent:"),
  );

  assert.match(workflowContract, /status:\s*"checks_recorded"/);
  assert.match(workflowContract, /evidence:\s*DeliveryPullRequestChecksEvidence/);
  assert.match(persistence, /type WorkflowPullRequestMergeResult[\s\S]*status:\s*"merged"[\s\S]*evidence:\s*DeliveryPullRequestMergeEvidence/);
  assert.match(persistence, /type WorkflowDeliveryMainSyncResult[\s\S]*status:\s*"synced"[\s\S]*evidence:\s*DeliveryMainSyncEvidence/);
  assert.match(devflowContract, /status:\s*"checks_recorded"/);
  assert.match(workflowContract, /mergePullRequest:.*Promise<WorkflowPullRequestMergeResult>/);
  assert.match(workflowContract, /syncMain:.*Promise<WorkflowDeliveryMainSyncResult>/);
  assert.match(devflowContract, /mergeWorkflowPullRequest:.*Promise<WorkflowPullRequestMergeResult>/);
  assert.match(devflowContract, /syncWorkflowMain:.*Promise<WorkflowDeliveryMainSyncResult>/);
});

test("workflow delivery remote public type contracts include manual-resolution blocked results", async () => {
  const persistence = await readFile(join(root, "..", "..", "packages", "persistence", "src", "index.ts"), "utf8");
  const workflowContract = persistence.slice(
    persistence.indexOf("pushDeliveryBranch:"),
    persistence.indexOf("getChangeset:"),
  );
  const devflowContract = persistence.slice(
    persistence.indexOf("createWorkflowDeliveryCommit:"),
    persistence.indexOf("onRunEvent:"),
  );

  assert.match(persistence, /manual_resolution_required/);
  assert.match(persistence, /interface WorkflowDeliveryBlockedResult[\s\S]*status:\s*"blocked"[\s\S]*event:\s*unknown\s*\|\s*null[\s\S]*blockedReason:\s*WorkflowRollbackBlockReason[\s\S]*manualRepairRequired:\s*true/);
  for (const resultType of [
    "WorkflowDeliveryPushResult",
    "WorkflowPullRequestCreateResult",
    "WorkflowPullRequestMergeResult",
    "WorkflowDeliveryMainSyncResult",
  ]) {
    assert.match(persistence, new RegExp(`type ${resultType}[\\s\\S]*WorkflowDeliveryBlockedResult`));
  }
  for (const method of ["pushDeliveryBranch", "createPullRequest", "mergePullRequest", "syncMain"]) {
    assert.match(workflowContract, new RegExp(`${method}:.*${methodResultType(method)}`));
  }
  for (const method of ["pushWorkflowDeliveryBranch", "createWorkflowPullRequest", "mergeWorkflowPullRequest", "syncWorkflowMain"]) {
    assert.match(devflowContract, new RegExp(`${method}:.*${legacyMethodResultType(method)}`));
  }
});

test("workflow rollback public type contracts expose structured checkpoint results", async () => {
  const persistence = await readFile(join(root, "..", "..", "packages", "persistence", "src", "index.ts"), "utf8");
  const workflowContract = persistence.slice(
    persistence.indexOf("getCheckpoints:"),
    persistence.indexOf("answerUserDecision:"),
  );

  assert.match(workflowContract, /checkpoints:\s*WorkflowNodeCheckpoint\[\]/);
  assert.match(workflowContract, /eligibility:\s*WorkflowRollbackEligibility/);
  assert.match(workflowContract, /blockedReason:\s*WorkflowRollbackBlockReason/);
  assert.match(workflowContract, /manualRepairRequired/);
  assert.match(workflowContract, /status:\s*"applied"\s*\|\s*"blocked"/);
  assert.match(workflowContract, /status:\s*"requested"/);
});

test("workflow rollback IPC keeps local git reset behind exact recorded-head safety", async () => {
  const main = await readFile(join(root, "electron", "main.ts"), "utf8");
  const helperSource = main.slice(
    main.indexOf("async function evaluateLocalRollbackSafetyForRollback"),
    main.indexOf("function localRollbackSafetyResult"),
  );

  assert.match(helperSource, /assertManagedRollbackWorktree/);
  assert.match(helperSource, /findRecordedRollbackHead/);
  assert.match(helperSource, /evaluateRollbackWorktreeState/);
  assert.match(helperSource, /expectedHeadCommit:\s*recordedHead\.commitSha/);
  assert.match(helperSource, /expectedBranchName/);
  assert.match(helperSource, /worktreeState\.status === "manual_repair_required"/);
  assert.match(helperSource, /status:\s*"safe"/);
  assert.match(helperSource, /status:\s*"manual_repair_required"/);
  assert.match(helperSource, /reasonCode:\s*worktreeState\.reasonCode/);
  assert.match(helperSource, /reasonCode:\s*"head_mismatch"/);
  assert.doesNotMatch(helperSource, /ls-remote|push|pull-request|gh\s/);
});

test("workflow rollback IPC requires full recorded commit SHAs before reset", async () => {
  const main = await readFile(join(root, "electron", "main.ts"), "utf8");
  const helperSource = main.slice(
    main.indexOf("async function evaluateLocalRollbackSafetyForRollback"),
    main.indexOf("function localRollbackSafetyResult"),
  );
  const resetHelper = main.slice(
    main.indexOf("function isFullCommitSha"),
    main.indexOf("async function normalizeChangesetNodeForProject"),
  );
  const gitWorktree = await readFile(join(root, "..", "..", "packages", "git-worktree", "src", "node.ts"), "utf8");
  const rollbackHelper = gitWorktree.slice(
    gitWorktree.indexOf("export async function evaluateRollbackWorktreeState"),
    gitWorktree.indexOf("export async function createDeliveryCommit"),
  );

  assert.match(main, /function isFullCommitSha/);
  assert.match(helperSource, /!isFullCommitSha\(restoreCommitRef\)/);
  assert.match(helperSource, /reasonCode:\s*"invalid_restore_commit"/);
  assert.match(helperSource, /!isFullCommitSha\(recordedHead\.commitSha\)/);
  assert.match(helperSource, /reasonCode:\s*"invalid_recorded_commit"/);
  assert.match(rollbackHelper, /!isFullCommitSha\(restoreCommitRef\)/);
  assert.match(rollbackHelper, /!isFullCommitSha\(expectedHeadCommit\)/);
  assert.match(rollbackHelper, /commitObjectExists\(worktreePath,\s*restoreCommitRef\)/);
  assert.doesNotMatch(resetHelper, /validateGitRefText\(restoreCommitRef\)/);
});

test("workflow rollback recorded-head proof requires matching lane and worktree", async () => {
  const main = await readFile(join(root, "electron", "main.ts"), "utf8");
  const recordedHeadHelper = main.slice(
    main.indexOf("async function findRecordedRollbackHead"),
    main.indexOf("function workflowCheckpointById"),
  );

  assert.match(recordedHeadHelper, /Promise<RecordedRollbackHead \| null>/);
  assert.match(recordedHeadHelper, /if \(!laneId \|\| !affected\.has\(laneId\)\) continue/);
  assert.match(recordedHeadHelper, /const evidenceWorktreePath = optionalText\(evidence\.worktreePath\)/);
  assert.match(recordedHeadHelper, /if \(!evidenceWorktreePath\) continue/);
  assert.match(recordedHeadHelper, /realPathsEqual\(evidenceWorktreePath,\s*worktreePath\)/);
  assert.match(recordedHeadHelper, /if \(commitSha && isFullCommitSha\(commitSha\)\) \{/);
  assert.match(recordedHeadHelper, /return \{[\s\S]*commitSha/);
  assert.match(recordedHeadHelper, /continue/);
  assert.doesNotMatch(recordedHeadHelper, /return afterCheckpoint/);
  assert.doesNotMatch(recordedHeadHelper, /return !laneId/);
});

test("workflow rollback local safety rejects branch mismatch before reset", async () => {
  const main = await readFile(join(root, "electron", "main.ts"), "utf8");
  const helperSource = main.slice(
    main.indexOf("async function evaluateLocalRollbackSafetyForRollback"),
    main.indexOf("function localRollbackSafetyResult"),
  );
  const managedWorktreeHelper = main.slice(
    main.indexOf("async function assertManagedRollbackWorktree"),
    main.indexOf("async function findRecordedRollbackHead"),
  );
  const gitWorktree = await readFile(join(root, "..", "..", "packages", "git-worktree", "src", "node.ts"), "utf8");
  const rollbackHelper = gitWorktree.slice(
    gitWorktree.indexOf("export async function evaluateRollbackWorktreeState"),
    gitWorktree.indexOf("export async function createDeliveryCommit"),
  );

  const expectedBranchIndex = helperSource.indexOf("const expectedBranchName");
  const helperCallIndex = helperSource.indexOf("evaluateRollbackWorktreeState");
  const mismatchIndex = rollbackHelper.indexOf('rollbackManualRepair("branch_mismatch"');
  const headIndex = rollbackHelper.indexOf("const headCommit");
  const safeIndex = rollbackHelper.indexOf('status: "safe"');

  assert.match(managedWorktreeHelper, /branchName:\s*optionalText\(worktree\.branchName\)/);
  assert.match(helperSource, /recordedHead\.branchName/);
  assert.ok(expectedBranchIndex >= 0, "rollback safety must derive an expected branch from managed or recorded evidence");
  assert.ok(helperCallIndex > expectedBranchIndex, "rollback safety must pass expected branch evidence into git-worktree validation");
  assert.ok(mismatchIndex >= 0, "branch mismatch must return manual repair evidence");
  assert.ok(headIndex > mismatchIndex, "rollback safety must block branch mismatch before recorded-head checks pass");
  assert.ok(safeIndex > mismatchIndex, "rollback safety must not return safe before exact branch match");
  assert.match(rollbackHelper, /currentBranch\(worktreePath\)/);
  assert.match(rollbackHelper, /listed\.entry\.branch !== expectedBranchRef/);
  assert.doesNotMatch(helperSource, /gitResetHard/);
});

test("workflow rollback apply blocks while affected remote delivery operations are in flight", async () => {
  const main = await readFile(join(root, "electron", "main.ts"), "utf8");
  const rollbackApplyHandler = main.slice(
    main.indexOf('ipcMain.handle("workflow:rollback:apply"'),
    main.indexOf('ipcMain.handle("workflow:repair:create"'),
  );
  const deliveryPushHandler = main.slice(
    main.indexOf('ipcMain.handle("workflow:delivery:push"'),
    main.indexOf('ipcMain.handle("workflow:pullRequest:create"'),
  );
  const pullRequestCreateHandler = main.slice(
    main.indexOf('ipcMain.handle("workflow:pullRequest:create"'),
    main.indexOf('ipcMain.handle("workflow:pullRequest:checks"'),
  );
  const pullRequestMergeHandler = main.slice(
    main.indexOf('ipcMain.handle("workflow:pullRequest:merge"'),
    main.indexOf('ipcMain.handle("workflow:delivery:syncMain"'),
  );
  const syncMainHandler = main.slice(
    main.indexOf('ipcMain.handle("workflow:delivery:syncMain"'),
    main.indexOf('ipcMain.handle("workflow:changeset"'),
  );
  const inFlightHelperSource = main.slice(
    main.indexOf("function beginInFlightRemoteSideEffect"),
    main.indexOf("async function evaluateLocalRollbackSafetyForRollback"),
  );
  const rollbackRemoteBlockHelper = main.slice(
    main.indexOf("function evaluateRollbackRemoteBlocksForRollback"),
    main.indexOf("async function withWorkflowSessionMutationLock"),
  );

  assert.match(main, /const inFlightRemoteSideEffects = new Map<string, InFlightRemoteSideEffect>\(\)/);
  assert.match(main, /function beginDurableRemoteSideEffect/);
  assert.match(main, /function beginInFlightRemoteSideEffect/);
  assert.match(main, /function blockingInFlightRemoteSideEffects/);
  assert.match(rollbackRemoteBlockHelper, /blockingInFlightRemoteSideEffects\(projectRoot,\s*input\.sessionId,\s*eligibility\)/);
  assert.match(rollbackApplyHandler, /evaluateRollbackRemoteBlocksForRollback\(workflowProjectRoot,\s*store,\s*normalized\)/);
  assert.match(inFlightHelperSource, /in_flight_remote_side_effect/);
  assert.match(inFlightHelperSource, /status:\s*"in_flight"/);
  assert.ok(
    rollbackApplyHandler.indexOf("evaluateRollbackRemoteBlocksForRollback") < rollbackApplyHandler.indexOf("evaluateLocalRollbackSafetyForRollback"),
    "rollback must block in-flight remotes before local safety checks and git reset",
  );

  for (const handler of [deliveryPushHandler, pullRequestCreateHandler, pullRequestMergeHandler, syncMainHandler]) {
    assert.match(handler, /const remoteSideEffect = beginDurableRemoteSideEffect/);
    assert.match(handler, /finally\s*\{\s*remoteSideEffect\.endInFlight\(\);\s*\}/);
  }
  for (const [handler, eventKind] of [
    [deliveryPushHandler, "workflow.delivery.pushed"],
    [pullRequestCreateHandler, "workflow.pull_request.created"],
    [pullRequestMergeHandler, "workflow.pull_request.merged"],
    [syncMainHandler, "workflow.delivery.main_synced"],
  ]) {
    const eventAppendIndex = handler.indexOf(`kind: "${eventKind}"`);
    const finallyIndex = handler.indexOf("finally");
    assert.ok(eventAppendIndex >= 0, `${eventKind} must still append durable evidence`);
    assert.ok(finallyIndex > eventAppendIndex, `${eventKind} in-flight marker must clear after durable evidence append`);
  }
});

test("workflow rollback apply rechecks remote blockers under the session mutation lock before git reset", async () => {
  const main = await readFile(join(root, "electron", "main.ts"), "utf8");
  const rollbackApplyHandler = main.slice(
    main.indexOf('ipcMain.handle("workflow:rollback:apply"'),
    main.indexOf('ipcMain.handle("workflow:repair:create"'),
  );
  const remoteHandlers = [
    [
      main.slice(
        main.indexOf('ipcMain.handle("workflow:delivery:push"'),
        main.indexOf('ipcMain.handle("workflow:pullRequest:create"'),
      ),
      "pushDeliveryBranch({",
      "workflow.delivery.pushed",
    ],
    [
      main.slice(
        main.indexOf('ipcMain.handle("workflow:pullRequest:create"'),
        main.indexOf('ipcMain.handle("workflow:pullRequest:checks"'),
      ),
      "createDeliveryPullRequest({",
      "workflow.pull_request.created",
    ],
    [
      main.slice(
        main.indexOf('ipcMain.handle("workflow:pullRequest:merge"'),
        main.indexOf('ipcMain.handle("workflow:delivery:syncMain"'),
      ),
      "mergeDeliveryPullRequest({",
      "workflow.pull_request.merged",
    ],
    [
      main.slice(
        main.indexOf('ipcMain.handle("workflow:delivery:syncMain"'),
        main.indexOf('ipcMain.handle("workflow:changeset"'),
      ),
      "syncDeliveryMain({",
      "workflow.delivery.main_synced",
    ],
  ];

  assert.match(main, /const workflowSessionMutationLocks = new Map<string, Promise<void>>\(\)/);
  assert.match(main, /async function withWorkflowSessionMutationLock/);
  assert.match(main, /function evaluateRollbackRemoteBlocksForRollback/);

  const lockIndex = rollbackApplyHandler.indexOf("withWorkflowSessionMutationLock(workflowProjectRoot, normalized.sessionId");
  const localSafetyIndex = rollbackApplyHandler.indexOf("evaluateLocalRollbackSafetyForRollback");
  const finalCheckIndex = rollbackApplyHandler.lastIndexOf("evaluateRollbackRemoteBlocksForRollback");
  const blockReturnIndex = rollbackApplyHandler.indexOf("if (finalRemoteBlock.result) return workflowRollbackResponse");
  const requestIndex = rollbackApplyHandler.indexOf("appendRollbackRequestedEvent");
  const resetIndex = rollbackApplyHandler.indexOf("const resetResult = await resetRollbackWorktreeToCommit");

  assert.ok(lockIndex >= 0, "rollback apply must enter the same session mutation lock used by remote mutations");
  assert.ok(localSafetyIndex > lockIndex, "local rollback safety must run inside the session mutation lock");
  assert.ok(finalCheckIndex > localSafetyIndex, "rollback apply must re-materialize remote blockers after async local safety");
  assert.ok(blockReturnIndex > finalCheckIndex, "rollback apply must return blocked when a final remote blocker appears");
  assert.ok(requestIndex > blockReturnIndex, "rollback_requested must not be written until final remote blockers are clear");
  assert.ok(resetIndex > requestIndex, "git reset helper must stay after final blocker check and rollback_requested");

  for (const [handler, remoteCall, eventKind] of remoteHandlers) {
    const remoteLockIndex = handler.indexOf("withWorkflowSessionMutationLock(workflowProjectRoot, sessionId");
    const beginIndex = handler.indexOf("beginDurableRemoteSideEffect");
    const callIndex = handler.indexOf(remoteCall);
    assert.ok(remoteLockIndex >= 0, `${eventKind} must share the rollback session mutation lock`);
    assert.ok(beginIndex > remoteLockIndex, `${eventKind} durable intent must be created inside the lock`);
    assert.ok(callIndex > beginIndex, `${eventKind} remote mutation must start after the locked durable intent`);
  }
});

test("workflow remote delivery handlers revalidate evidence and rollback status under the session lock", async () => {
  const main = await readFile(join(root, "electron", "main.ts"), "utf8");
  const handlers = [
    {
      name: "delivery push",
      source: main.slice(
        main.indexOf('ipcMain.handle("workflow:delivery:push"'),
        main.indexOf('ipcMain.handle("workflow:pullRequest:create"'),
      ),
      validators: [
        "assertKnownWorkflowCanvasSession",
        "assertWorkflowDeliveryCommitLane",
        "resolveDeliveryCommitWorktreePath",
        "findDeliveryCommitEvidence",
        "assertDeliveryEvidenceInputMatches",
      ],
      remoteCall: "pushDeliveryBranch({",
      eventKind: "workflow.delivery.pushed",
    },
    {
      name: "pull request create",
      source: main.slice(
        main.indexOf('ipcMain.handle("workflow:pullRequest:create"'),
        main.indexOf('ipcMain.handle("workflow:pullRequest:checks"'),
      ),
      validators: [
        "assertKnownWorkflowCanvasSession",
        "assertWorkflowPullRequestLane",
        "assertWorkflowDeliveryCommitLane",
        "resolveDeliveryCommitWorktreePath",
        "findDeliveryCommitEvidence",
        "assertDeliveryEvidenceInputMatches",
        "validatePullRequestBaseBranch",
      ],
      remoteCall: "createDeliveryPullRequest({",
      eventKind: "workflow.pull_request.created",
    },
    {
      name: "pull request merge",
      source: main.slice(
        main.indexOf('ipcMain.handle("workflow:pullRequest:merge"'),
        main.indexOf('ipcMain.handle("workflow:delivery:syncMain"'),
      ),
      validators: [
        "assertKnownWorkflowCanvasSession",
        "assertWorkflowPullRequestLaneKind",
        "findDeliveryPullRequestEvidence",
        "findDeliveryPullRequestChecksEvidence",
        "assertDeliveryPullRequestEvidenceInputMatches",
      ],
      remoteCall: "mergeDeliveryPullRequest({",
      eventKind: "workflow.pull_request.merged",
    },
    {
      name: "main sync",
      source: main.slice(
        main.indexOf('ipcMain.handle("workflow:delivery:syncMain"'),
        main.indexOf('ipcMain.handle("workflow:changeset"'),
      ),
      validators: [
        "assertKnownWorkflowCanvasSession",
        "assertWorkflowPullRequestLaneKind",
        "findDeliveryPullRequestEvidence",
        "assertDeliveryPullRequestEvidenceInputMatches",
        "findDeliveryPullRequestMergeEvidence",
      ],
      remoteCall: "syncDeliveryMain({",
      eventKind: "workflow.delivery.main_synced",
    },
  ];

  assert.match(main, /function assertWorkflowRemoteMutationLanesActive/);
  for (const { name, source, validators, remoteCall, eventKind } of handlers) {
    const lockIndex = source.indexOf("withWorkflowSessionMutationLock(workflowProjectRoot, sessionId");
    assert.ok(lockIndex >= 0, `${name} must enter the workflow session mutation lock`);

    const preLock = source.slice(0, lockIndex);
    assert.doesNotMatch(preLock, /getWorkflowStore|assertKnownWorkflowCanvasSession/);
    assert.doesNotMatch(preLock, /assertWorkflow(?:DeliveryCommitLane|PullRequestLane|PullRequestLaneKind)/);
    assert.doesNotMatch(preLock, /findDelivery(?:CommitEvidence|PullRequestEvidence|PullRequestChecksEvidence|PullRequestMergeEvidence)/);
    assert.doesNotMatch(preLock, /findDeliveryPushEvidenceForPullRequest|validatePullRequestBaseBranch|const remoteOperation/);

    const locked = source.slice(lockIndex);
    const validatorIndexes = validators.map((validator) => locked.indexOf(validator));
    for (const [index, validator] of validatorIndexes.map((value, index) => [value, validators[index]])) {
      assert.ok(index >= 0, `${eventKind} must validate ${validator} inside the lock`);
    }

    const lastValidationIndex = Math.max(...validatorIndexes);
    const operationIndex = locked.indexOf("const remoteOperation: RemoteSideEffectOperation =");
    const rollbackStatusIndex = locked.indexOf("assertWorkflowRemoteMutationLanesActive(store, remoteOperation)");
    const retryBlockIndex = locked.indexOf("unresolvedRemoteSideEffectBlockForRetry(store, remoteOperation)");
    const beginIndex = locked.indexOf("beginDurableRemoteSideEffect(store, remoteOperation)");
    const remoteCallIndex = locked.indexOf(remoteCall);

    assert.ok(operationIndex > lastValidationIndex, `${eventKind} must construct remote operation from current locked evidence`);
    assert.ok(rollbackStatusIndex > operationIndex, `${eventKind} must check rollbackStatus after affected lanes are known`);
    assert.ok(retryBlockIndex > rollbackStatusIndex, `${eventKind} must reject rolled-back lanes before unresolved retry handling`);
    assert.ok(beginIndex > retryBlockIndex, `${eventKind} must not create durable intent before current rollbackStatus passes`);
    assert.ok(remoteCallIndex > beginIndex, `${eventKind} remote helper must stay after locked validation and durable intent`);
  }
});

test("workflow pull request merge cannot use stale pre-lock evidence after rollback", async () => {
  const main = await readFile(join(root, "electron", "main.ts"), "utf8");
  const mergeHandler = main.slice(
    main.indexOf('ipcMain.handle("workflow:pullRequest:merge"'),
    main.indexOf('ipcMain.handle("workflow:delivery:syncMain"'),
  );
  const lockIndex = mergeHandler.indexOf("withWorkflowSessionMutationLock(workflowProjectRoot, sessionId");
  const preLock = mergeHandler.slice(0, lockIndex);
  const locked = mergeHandler.slice(lockIndex);

  assert.doesNotMatch(preLock, /findDeliveryPullRequestEvidence|findDeliveryPullRequestChecksEvidence|assertDeliveryPullRequestEvidenceInputMatches/);
  assert.doesNotMatch(preLock, /const remoteOperation: RemoteSideEffectOperation/);

  const prEvidenceIndex = locked.indexOf("findDeliveryPullRequestEvidence");
  const checksIndex = locked.indexOf("findDeliveryPullRequestChecksEvidence");
  const operationIndex = locked.indexOf("const remoteOperation: RemoteSideEffectOperation =");
  const rollbackStatusIndex = locked.indexOf("assertWorkflowRemoteMutationLanesActive(store, remoteOperation)");
  const helperIndex = locked.indexOf("mergeDeliveryPullRequest({");

  assert.ok(prEvidenceIndex >= 0, "merge must re-read PR evidence inside the lock");
  assert.ok(checksIndex > prEvidenceIndex, "merge must re-read checks evidence inside the lock");
  assert.ok(operationIndex > checksIndex, "merge remote operation must be built from locked evidence");
  assert.ok(rollbackStatusIndex > operationIndex, "merge must reject current rolled_back or inactive lanes before gh pr merge");
  assert.ok(helperIndex > rollbackStatusIndex, "gh pr merge cannot run before rollbackStatus validation");
});

test("workflow remote rollback locks and in-flight blockers are scoped by project root", async () => {
  const main = await readFile(join(root, "electron", "main.ts"), "utf8");
  const rollbackEligibilityHandler = main.slice(
    main.indexOf('ipcMain.handle("workflow:rollback:eligibility"'),
    main.indexOf('ipcMain.handle("workflow:rollback:apply"'),
  );
  const rollbackApplyHandler = main.slice(
    main.indexOf('ipcMain.handle("workflow:rollback:apply"'),
    main.indexOf('ipcMain.handle("workflow:repair:create"'),
  );
  const deliveryPushHandler = main.slice(
    main.indexOf('ipcMain.handle("workflow:delivery:push"'),
    main.indexOf('ipcMain.handle("workflow:pullRequest:create"'),
  );
  const inFlightHelperSource = main.slice(
    main.indexOf("function beginInFlightRemoteSideEffect"),
    main.indexOf("async function evaluateLocalRollbackSafetyForRollback"),
  );

  assert.match(main, /interface InFlightRemoteSideEffect[\s\S]*projectRoot:\s*string/);
  assert.match(main, /async function workflowStoreIdentity\(projectRoot: string\): Promise<string>/);
  assert.match(rollbackEligibilityHandler, /const workflowProjectRoot = await workflowStoreIdentity\(projectRoot\)/);
  assert.match(rollbackEligibilityHandler, /blockingInFlightRemoteSideEffects\(workflowProjectRoot,\s*normalized\.sessionId,\s*eligibility\)/);
  assert.match(rollbackApplyHandler, /withWorkflowSessionMutationLock\(workflowProjectRoot,\s*normalized\.sessionId/);
  assert.match(rollbackApplyHandler, /evaluateRollbackRemoteBlocksForRollback\(workflowProjectRoot,\s*store,\s*normalized\)/);
  assert.match(deliveryPushHandler, /withWorkflowSessionMutationLock\(workflowProjectRoot,\s*sessionId/);
  assert.match(deliveryPushHandler, /const remoteOperation: RemoteSideEffectOperation = \{[\s\S]*projectRoot:\s*workflowProjectRoot/);
  assert.match(deliveryPushHandler, /beginDurableRemoteSideEffect\(store,\s*remoteOperation\)/);
  assert.match(inFlightHelperSource, /projectRoot:\s*input\.projectRoot/);
  assert.match(inFlightHelperSource, /if \(effect\.projectRoot !== projectRoot\) return false/);
});

test("workflow remote delivery mutations leave attempted failures as durable blockers", async () => {
  const main = await readFile(join(root, "electron", "main.ts"), "utf8");
  const handlers = [
    [
      main.slice(
        main.indexOf('ipcMain.handle("workflow:delivery:push"'),
        main.indexOf('ipcMain.handle("workflow:pullRequest:create"'),
      ),
      "workflow.delivery.pushed",
    ],
    [
      main.slice(
        main.indexOf('ipcMain.handle("workflow:pullRequest:create"'),
        main.indexOf('ipcMain.handle("workflow:pullRequest:checks"'),
      ),
      "workflow.pull_request.created",
    ],
    [
      main.slice(
        main.indexOf('ipcMain.handle("workflow:pullRequest:merge"'),
        main.indexOf('ipcMain.handle("workflow:delivery:syncMain"'),
      ),
      "workflow.pull_request.merged",
    ],
    [
      main.slice(
        main.indexOf('ipcMain.handle("workflow:delivery:syncMain"'),
        main.indexOf('ipcMain.handle("workflow:changeset"'),
      ),
      "workflow.delivery.main_synced",
    ],
  ];

  for (const [handler, eventKind] of handlers) {
    assert.match(handler, /beginDurableRemoteSideEffect/);
    assert.match(handler, /throw normalizeDeliveryRemoteIpcError\(error\)/);
    assert.doesNotMatch(handler, /remoteSideEffect\.complete\("failed"/, `${eventKind} must not clear attempted remote failures`);
  }
});

test("workflow remote delivery mutations clear known pre-mutation failures durably", async () => {
  const main = await readFile(join(root, "electron", "main.ts"), "utf8");
  const handlers = [
    [
      main.slice(
        main.indexOf('ipcMain.handle("workflow:delivery:push"'),
        main.indexOf('ipcMain.handle("workflow:pullRequest:create"'),
      ),
      "workflow.delivery.pushed",
    ],
    [
      main.slice(
        main.indexOf('ipcMain.handle("workflow:pullRequest:create"'),
        main.indexOf('ipcMain.handle("workflow:pullRequest:checks"'),
      ),
      "workflow.pull_request.created",
    ],
    [
      main.slice(
        main.indexOf('ipcMain.handle("workflow:pullRequest:merge"'),
        main.indexOf('ipcMain.handle("workflow:delivery:syncMain"'),
      ),
      "workflow.pull_request.merged",
    ],
    [
      main.slice(
        main.indexOf('ipcMain.handle("workflow:delivery:syncMain"'),
        main.indexOf('ipcMain.handle("workflow:changeset"'),
      ),
      "workflow.delivery.main_synced",
    ],
  ];
  const clearingHelper = main.slice(
    main.indexOf("function completeDurableRemoteSideEffectForKnownPreMutationFailure"),
    main.indexOf("function unresolvedRemoteSideEffectBlockForRetry"),
  );
  const knownFailurePredicate = main.slice(
    main.indexOf("function isKnownPreMutationDeliveryRemoteError"),
    main.indexOf("function deliveryRemoteIpcErrorCode"),
  );

  assert.match(clearingHelper, /remoteSideEffect\.complete\("failed"/);
  assert.match(clearingHelper, /remoteMutationAttempted:\s*false/);
  assert.match(clearingHelper, /normalizeDeliveryRemoteIpcError\(error\)/);
  assert.match(knownFailurePredicate, /GH_UNAVAILABLE|AUTH_REQUIRED|REMOTE_HEAD_MISMATCH/);
  assert.doesNotMatch(knownFailurePredicate, /git push failed|gh pr create failed|gh pr merge failed/);

  for (const [handler, eventKind] of handlers) {
    const catchIndex = handler.indexOf("catch (error)");
    const clearIndex = handler.indexOf("completeDurableRemoteSideEffectForKnownPreMutationFailure(remoteSideEffect, error)");
    const throwIndex = handler.indexOf("throw normalizeDeliveryRemoteIpcError(error)");
    assert.ok(catchIndex >= 0, `${eventKind} must catch remote helper errors`);
    assert.ok(clearIndex > catchIndex, `${eventKind} must complete known pre-mutation failures durably`);
    assert.ok(throwIndex > clearIndex, `${eventKind} must still rethrow normalized IPC errors`);
  }
});

test("workflow remote delivery mutations persist durable blocking intent before remote calls", async () => {
  const main = await readFile(join(root, "electron", "main.ts"), "utf8");
  const handlers = [
    [
      main.slice(
        main.indexOf('ipcMain.handle("workflow:delivery:push"'),
        main.indexOf('ipcMain.handle("workflow:pullRequest:create"'),
      ),
      "pushDeliveryBranch({",
      "workflow.delivery.pushed",
    ],
    [
      main.slice(
        main.indexOf('ipcMain.handle("workflow:pullRequest:create"'),
        main.indexOf('ipcMain.handle("workflow:pullRequest:checks"'),
      ),
      "createDeliveryPullRequest({",
      "workflow.pull_request.created",
    ],
    [
      main.slice(
        main.indexOf('ipcMain.handle("workflow:pullRequest:merge"'),
        main.indexOf('ipcMain.handle("workflow:delivery:syncMain"'),
      ),
      "mergeDeliveryPullRequest({",
      "workflow.pull_request.merged",
    ],
    [
      main.slice(
        main.indexOf('ipcMain.handle("workflow:delivery:syncMain"'),
        main.indexOf('ipcMain.handle("workflow:changeset"'),
      ),
      "syncDeliveryMain({",
      "workflow.delivery.main_synced",
    ],
  ];

  assert.match(main, /workflow\.remote_side_effect\.requested/);
  assert.match(main, /workflow\.remote_side_effect\.completed/);
  assert.match(main, /function beginDurableRemoteSideEffect/);
  for (const [handler, remoteCall, eventKind] of handlers) {
    const requestedIndex = handler.indexOf("beginDurableRemoteSideEffect");
    const remoteCallIndex = handler.indexOf(remoteCall);
    const evidenceIndex = handler.indexOf(`kind: "${eventKind}"`);
    const completedIndex = handler.indexOf('remoteSideEffect.complete("succeeded"');
    assert.ok(requestedIndex >= 0, `${eventKind} must create a durable remote request`);
    assert.ok(remoteCallIndex > requestedIndex, `${eventKind} durable request must be persisted before the remote mutation`);
    assert.ok(evidenceIndex > remoteCallIndex, `${eventKind} evidence must still be recorded after the remote mutation`);
    assert.ok(completedIndex > evidenceIndex, `${eventKind} durable request must complete after evidence is recorded`);
  }
});

test("workflow rollback apply persists rollback request before git reset and rejected evidence on local failure", async () => {
  const main = await readFile(join(root, "electron", "main.ts"), "utf8");
  const rollbackApplyHandler = main.slice(
    main.indexOf('ipcMain.handle("workflow:rollback:apply"'),
    main.indexOf('ipcMain.handle("workflow:repair:create"'),
  );

  const requestIndex = rollbackApplyHandler.indexOf("appendRollbackRequestedEvent");
  const resetIndex = rollbackApplyHandler.indexOf("const resetResult = await resetRollbackWorktreeToCommit");
  const appliedIndex = rollbackApplyHandler.lastIndexOf("appendRollbackAppliedEvent");
  const rejectedIndex = rollbackApplyHandler.indexOf("appendRollbackRejectedEvent");
  assert.ok(requestIndex >= 0, "rollback apply must persist workflow.node.rollback_requested explicitly");
  assert.ok(resetIndex > requestIndex, "git reset helper must run only after rollback_requested is durable");
  assert.ok(appliedIndex > resetIndex, "rollback_applied must be recorded only after git reset helper returns applied/restored");
  assert.ok(rejectedIndex >= 0, "local safety or reset failure must persist workflow.node.rollback_rejected evidence");
  assert.match(rollbackApplyHandler, /resetResult\.status !== "applied" && resetResult\.status !== "already_restored"[\s\S]*appendRollbackRejectedEvent/);
  assert.match(rollbackApplyHandler, /reasonCode:\s*resetResult\.reasonCode/);
  assert.doesNotMatch(rollbackApplyHandler, /resetRollbackWorktreeToCommit[\s\S]*applyNodeRollback/);
});

test("workflow rollback retry recovers crash window when HEAD is already restored", async () => {
  const main = await readFile(join(root, "electron", "main.ts"), "utf8");
  const rollbackApplyHandler = main.slice(
    main.indexOf('ipcMain.handle("workflow:rollback:apply"'),
    main.indexOf('ipcMain.handle("workflow:repair:create"'),
  );
  const localSafetyHelper = main.slice(
    main.indexOf("async function evaluateLocalRollbackSafetyForRollback"),
    main.indexOf("function localRollbackSafetyResult"),
  );

  assert.match(main, /status:\s*"already_restored"/);
  assert.match(main, /function findMatchingRollbackRequestedEvent/);
  assert.match(rollbackApplyHandler, /localSafety\.status === "already_restored"/);
  assert.match(rollbackApplyHandler, /appendRollbackAppliedEvent\(store,\s*normalized,\s*finalEligibility,\s*localSafety\.requestId\)/);
  assert.match(localSafetyHelper, /findMatchingRollbackRequestedEvent/);
  assert.match(localSafetyHelper, /worktreeState\.status === "already_restored"/);
  assert.match(localSafetyHelper, /findMatchingRollbackAppliedEvent/);
  assert.doesNotMatch(localSafetyHelper, /already_restored[\s\S]*resetRollbackWorktreeToCommit/);
});

test("workflow rollback retry after applied is idempotent only with matching restored worktree evidence", async () => {
  const main = await readFile(join(root, "electron", "main.ts"), "utf8");
  const rollbackApplyHandler = main.slice(
    main.indexOf('ipcMain.handle("workflow:rollback:apply"'),
    main.indexOf('ipcMain.handle("workflow:repair:create"'),
  );
  const localSafetyHelper = main.slice(
    main.indexOf("async function evaluateLocalRollbackSafetyForRollback"),
    main.indexOf("function localRollbackSafetyResult"),
  );
  const appliedHelper = main.slice(
    main.indexOf("function findMatchingRollbackAppliedEvent"),
    main.indexOf("function validateRollbackRequestedEventForIpc"),
  );

  const alreadyAppliedIndex = rollbackApplyHandler.indexOf('localSafety.status === "already_applied"');
  const alreadyRestoredIndex = rollbackApplyHandler.indexOf('localSafety.status === "already_restored"');
  const resetIndex = rollbackApplyHandler.indexOf("const resetResult = await resetRollbackWorktreeToCommit");

  assert.ok(alreadyAppliedIndex >= 0, "rollback apply must recognize already-applied retries");
  assert.ok(alreadyAppliedIndex < alreadyRestoredIndex, "already-applied retry must return before crash-window recovery appends a new terminal event");
  assert.ok(resetIndex > alreadyRestoredIndex, "already-applied retry must not run git reset again");
  assert.match(localSafetyHelper, /worktreeState\.status === "already_restored"[\s\S]*findMatchingRollbackAppliedEvent/);
  assert.doesNotMatch(appliedHelper, /if \(!input\.requestId\) return null/);
  assert.match(appliedHelper, /if \(input\.requestId && requestId !== input\.requestId\) continue/);
  assert.match(appliedHelper, /event\.kind !== "workflow\.node\.rollback_applied"/);
  assert.match(appliedHelper, /validateRollbackTerminalEventForIpc\(input,\s*eligibility,\s*restoreCommitRef,\s*applied,\s*"applied"\)/);
  assert.match(appliedHelper, /findMatchingRollbackRequestedHistoryForTerminalEvent/);
});

test("workflow rollback terminal-only applied event requires manual repair instead of success", async () => {
  const main = await readFile(join(root, "electron", "main.ts"), "utf8");
  const localSafetyHelper = main.slice(
    main.indexOf("async function evaluateLocalRollbackSafetyForRollback"),
    main.indexOf("function localRollbackSafetyResult"),
  );
  const appliedHelper = main.slice(
    main.indexOf("function findMatchingRollbackAppliedEvent"),
    main.indexOf("function validateRollbackRequestedEventForIpc"),
  );
  const requestedHistoryHelper = main.slice(
    main.indexOf("function findMatchingRollbackRequestedHistoryForTerminalEvent"),
    main.indexOf("function validateRollbackRequestedEventForIpc"),
  );
  const validationHelper = main.slice(
    main.indexOf("function validateRollbackRequestedEventForIpc"),
    main.indexOf("function validateRollbackTerminalEventForIpc"),
  );

  assert.match(localSafetyHelper, /message:\s*"Worktree HEAD is restored but rollback terminal evidence is missing for this request\."/);
  assert.match(appliedHelper, /const requested = findMatchingRollbackRequestedHistoryForTerminalEvent/);
  assert.match(appliedHelper, /if \(!requested\) continue/);
  assert.match(appliedHelper, /requestedEvent:\s*requested\.event/);
  assert.match(requestedHistoryHelper, /eventIndex >= terminalEventIndex/);
  assert.match(requestedHistoryHelper, /event\.kind !== "workflow\.node\.rollback_requested"/);
  assert.match(requestedHistoryHelper, /validateRollbackRequestedEventForIpc\([\s\S]*allowTerminal:\s*true/);
  assert.match(validationHelper, /allowTerminal\?:\s*boolean/);
  assert.match(validationHelper, /options\?\.allowTerminal !== true && rollbackRequestHasTerminalEvent/);
});

test("workflow rollback retry reuses unresolved rollback request before reset when HEAD is unchanged", async () => {
  const main = await readFile(join(root, "electron", "main.ts"), "utf8");
  const rollbackApplyHandler = main.slice(
    main.indexOf('ipcMain.handle("workflow:rollback:apply"'),
    main.indexOf('ipcMain.handle("workflow:repair:create"'),
  );

  const finalBlockIndex = rollbackApplyHandler.indexOf("const finalRemoteBlock = evaluateRollbackRemoteBlocksForRollback");
  const reuseIndex = rollbackApplyHandler.indexOf("findMatchingRollbackRequestedEvent(store, normalized, finalEligibility, localSafety.restoreCommitRef)");
  const collisionIndex = rollbackApplyHandler.indexOf("findRollbackRequestedEventByIdempotencyKey");
  const appendIndex = rollbackApplyHandler.indexOf("appendRollbackRequestedEvent");
  const validationIndex = rollbackApplyHandler.indexOf("validateRollbackRequestedEventForIpc");
  const resetIndex = rollbackApplyHandler.indexOf("const resetResult = await resetRollbackWorktreeToCommit");

  assert.ok(finalBlockIndex >= 0, "rollback apply must recheck remote blockers before reset");
  assert.ok(reuseIndex > finalBlockIndex, "rollback apply must look for an existing unresolved rollback request after final eligibility");
  assert.ok(collisionIndex > reuseIndex, "rollback apply must check rollback_requested idempotency collisions before append");
  assert.ok(appendIndex > collisionIndex, "rollback apply must only append rollback_requested after reuse and collision lookup miss");
  assert.ok(validationIndex > appendIndex, "rollback apply must validate reused or appended rollback_requested before reset");
  assert.ok(resetIndex > validationIndex, "git reset helper must stay after request reuse, collision lookup, append, and validation");
  assert.match(rollbackApplyHandler, /const requested = existingRollbackRequest[\s\S]*\?\? findRollbackRequestedEventByIdempotencyKey[\s\S]*\?\? appendRollbackRequestedEvent/);
  assert.doesNotMatch(rollbackApplyHandler, /const requested = appendRollbackRequestedEvent\(store,\s*normalized,\s*finalEligibility\);/);
});

test("workflow rollback request id collision is rejected before git reset when requested payload mismatches", async () => {
  const main = await readFile(join(root, "electron", "main.ts"), "utf8");
  const rollbackApplyHandler = main.slice(
    main.indexOf('ipcMain.handle("workflow:rollback:apply"'),
    main.indexOf('ipcMain.handle("workflow:repair:create"'),
  );
  const validationHelper = main.slice(
    main.indexOf("function validateRollbackRequestedEventForIpc"),
    main.indexOf("function localRollbackSafetyResult"),
  );

  const reuseIndex = rollbackApplyHandler.indexOf("findMatchingRollbackRequestedEvent");
  const collisionIndex = rollbackApplyHandler.indexOf("findRollbackRequestedEventByIdempotencyKey");
  const appendIndex = rollbackApplyHandler.indexOf("appendRollbackRequestedEvent");
  const validationIndex = rollbackApplyHandler.indexOf("validateRollbackRequestedEventForIpc");
  const rejectionIndex = rollbackApplyHandler.indexOf('reasonCode: "request_id_conflict"');
  const resetIndex = rollbackApplyHandler.indexOf("const resetResult = await resetRollbackWorktreeToCommit");

  assert.ok(reuseIndex >= 0, "rollback apply must first reuse a matching unresolved request");
  assert.ok(collisionIndex > reuseIndex, "rollback apply must detect idempotency-key collisions before appending");
  assert.ok(appendIndex > collisionIndex, "rollback apply must not append a duplicate requested event on collision");
  assert.ok(validationIndex > appendIndex, "rollback apply must validate the requested event before reset");
  assert.ok(rejectionIndex > validationIndex, "rollback apply must reject mismatched requested events");
  assert.ok(resetIndex > rejectionIndex, "git reset helper must stay unreachable on request-id collision rejection");
  assert.match(rollbackApplyHandler, /appendRollbackRejectedEvent\(store,\s*normalized,\s*finalEligibility,[\s\S]*requested\.requestId\)/);
  assert.match(rollbackApplyHandler, /requestedEvent:\s*requested\.event/);

  assert.match(validationHelper, /payloadRequestId !== requested\.requestId/);
  assert.match(validationHelper, /eventLaneId && eventLaneId !== expectedLaneId/);
  assert.match(validationHelper, /payloadLaneId !== expectedLaneId/);
  assert.match(validationHelper, /payloadCheckpointId !== expectedCheckpointId/);
  assert.match(validationHelper, /payloadNodeId !== expectedNodeId/);
  assert.match(validationHelper, /payloadRestoreCommitRef !== restoreCommitRef/);
  assert.match(validationHelper, /payload\.localRollbackSafe !== true/);
  assert.match(validationHelper, /rollbackRequestHasTerminalEvent/);
});

test("workflow remote delivery retries block unresolved durable requests before helper calls", async () => {
  const main = await readFile(join(root, "electron", "main.ts"), "utf8");
  const handlers = [
    [
      main.slice(
        main.indexOf('ipcMain.handle("workflow:delivery:push"'),
        main.indexOf('ipcMain.handle("workflow:pullRequest:create"'),
      ),
      "pushDeliveryBranch",
      "pushDeliveryBranch({",
      "workflow.delivery.pushed",
    ],
    [
      main.slice(
        main.indexOf('ipcMain.handle("workflow:pullRequest:create"'),
        main.indexOf('ipcMain.handle("workflow:pullRequest:checks"'),
      ),
      "createDeliveryPullRequest",
      "createDeliveryPullRequest({",
      "workflow.pull_request.created",
    ],
    [
      main.slice(
        main.indexOf('ipcMain.handle("workflow:pullRequest:merge"'),
        main.indexOf('ipcMain.handle("workflow:delivery:syncMain"'),
      ),
      "mergeDeliveryPullRequest",
      "mergeDeliveryPullRequest({",
      "workflow.pull_request.merged",
    ],
    [
      main.slice(
        main.indexOf('ipcMain.handle("workflow:delivery:syncMain"'),
        main.indexOf('ipcMain.handle("workflow:changeset"'),
      ),
      "syncDeliveryMain",
      "syncDeliveryMain({",
      "workflow.delivery.main_synced",
    ],
  ];

  assert.match(main, /function unresolvedRemoteSideEffectBlockForRetry/);
  assert.match(main, /function remoteSideEffectManualResolutionResponse/);
  assert.match(main, /function remoteSideEffectSemanticKey/);
  for (const [handler, importName, remoteCall, eventKind] of handlers) {
    const blockIndex = handler.indexOf("unresolvedRemoteSideEffectBlockForRetry");
    const returnIndex = handler.indexOf("remoteSideEffectManualResolutionResponse");
    const importIndex = handler.indexOf(`const { ${importName} } = await import("@skyturn/git-worktree/node")`);
    const beginIndex = handler.indexOf("beginDurableRemoteSideEffect");
    const callIndex = handler.indexOf(remoteCall);
    assert.ok(blockIndex >= 0, `${eventKind} must check unresolved durable requests`);
    assert.ok(returnIndex > blockIndex, `${eventKind} must return manual-resolution for unresolved requests`);
    assert.ok(importIndex > returnIndex, `${eventKind} must not import the remote helper before the unresolved-request block`);
    assert.ok(beginIndex > returnIndex, `${eventKind} must not create a fresh durable request when retry is blocked`);
    assert.ok(callIndex > beginIndex, `${eventKind} remote helper must remain after fresh durable request creation`);
  }
});

test("workflow pull request creation blocks unresolved push request for the same commit lane after restart", async () => {
  const main = await readFile(join(root, "electron", "main.ts"), "utf8");
  const pullRequestHandler = main.slice(
    main.indexOf('ipcMain.handle("workflow:pullRequest:create"'),
    main.indexOf('ipcMain.handle("workflow:pullRequest:checks"'),
  );
  const retryMatcher = main.slice(
    main.indexOf("function remoteSideEffectRequestMatches"),
    main.indexOf("function remoteSideEffectManualResolutionResponse"),
  );
  const pushEvidenceHelper = main.slice(
    main.indexOf("function findDeliveryPushEvidenceForPullRequest"),
    main.indexOf("function findDeliveryPullRequestEvidence"),
  );

  assert.match(main, /function unresolvedRemoteSideEffectBlockForRetry/);
  assert.match(pushEvidenceHelper, /workflow\.delivery\.pushed/);
  assert.match(pushEvidenceHelper, /commitEvidence\.commitSha/);
  assert.match(pushEvidenceHelper, /commitEvidence\.branch/);
  assert.match(pushEvidenceHelper, /remote/);
  assert.match(main, /function missingDeliveryPushEvidenceManualResolutionResponse/);
  assert.match(main, /function missingDeliveryPushEvidenceManualResolutionResponse[\s\S]*event:\s*null/);
  assert.match(main, /status:\s*"blocked"[\s\S]*manualRepairRequired:\s*true/);
  assert.match(retryMatcher, /request\.sessionWide === true \|\| input\.sessionWide === true/);
  assert.doesNotMatch(retryMatcher, /request\.eventKind !== input\.eventKind/);

  const blockIndex = pullRequestHandler.indexOf("unresolvedRemoteSideEffectBlockForRetry");
  const pushEvidenceIndex = pullRequestHandler.indexOf("findDeliveryPushEvidenceForPullRequest");
  const importIndex = pullRequestHandler.indexOf('await import("@skyturn/git-worktree/node")');
  const createIndex = pullRequestHandler.indexOf("createDeliveryPullRequest({");

  assert.ok(blockIndex >= 0, "PR create must check durable remote blockers after restart");
  assert.ok(pushEvidenceIndex > blockIndex, "PR create must require recorded push evidence after unresolved blocker check");
  assert.ok(importIndex > pushEvidenceIndex, "PR create must not import gh helper until push evidence exists");
  assert.ok(createIndex > importIndex, "gh pr create must stay after durable blocker and push-evidence guards");
});

test("workflow remote delivery retries keep ambiguous failed completions unresolved", async () => {
  const main = await readFile(join(root, "electron", "main.ts"), "utf8");
  const retryHelper = main.slice(
    main.indexOf("function unresolvedRemoteSideEffectBlockForRetry"),
    main.indexOf("function remoteSideEffectRequestFromEvent"),
  );
  const completionPredicate = main.slice(
    main.indexOf("function remoteSideEffectCompletionClearsRetryBlock"),
    main.indexOf("function remoteSideEffectRequestFromEvent"),
  );

  assert.match(retryHelper, /workflow\.remote_side_effect\.completed/);
  assert.match(retryHelper, /remoteSideEffectCompletionClearsRetryBlock\(event\)/);
  assert.doesNotMatch(retryHelper, /if \(operationId\) unresolved\.delete\(operationId\)/);
  assert.match(completionPredicate, /status === "succeeded"/);
  assert.match(completionPredicate, /status === "failed"[\s\S]*remoteMutationAttempted === false/);
});

test("workflow kernel knows delivery checks, merge, and main sync event names", async () => {
  const kernel = await readFile(join(root, "..", "..", "packages", "workflow-kernel", "src", "index.ts"), "utf8");
  const eventKinds = kernel.slice(
    kernel.indexOf("export type FlowEventKind"),
    kernel.indexOf("export interface FlowEvent"),
  );

  assert.match(eventKinds, /"workflow\.pull_request\.checks_recorded"/);
  assert.match(eventKinds, /"workflow\.pull_request\.merged"/);
  assert.match(eventKinds, /"workflow\.delivery\.main_synced"/);
  assert.match(eventKinds, /"workflow\.remote_side_effect\.requested"/);
  assert.match(eventKinds, /"workflow\.remote_side_effect\.completed"/);
});

test("workflow adopt IPC records a failed adoption before rejecting boundary violations", async () => {
  const main = await readFile(join(root, "electron", "main.ts"), "utf8");
  const worktreeAdoptHandler = main.slice(
    main.indexOf('ipcMain.handle("workflow:worktree:adopt"'),
    main.indexOf('ipcMain.handle("workflow:worktree:clean"'),
  );
  const helperSource = main.slice(
    main.indexOf("async function assertAdoptedWorktreeBelongsToProject"),
    main.indexOf("function findVariantAdoptionEvent"),
  );

  assert.match(helperSource, /await fs\.realpath\(projectRoot\)/);
  assert.match(helperSource, /await fs\.realpath\(worktree\.repoRoot\)/);
  assert.match(helperSource, /repoRoot !== realProjectRoot/);
  assert.match(helperSource, /await fs\.realpath\(`\$\{realProjectRoot\}\.worktrees`\)/);
  assert.match(helperSource, /await fs\.realpath\(worktree\.realPath \|\| worktree\.path\)/);
  assert.match(helperSource, /isInsidePath\(realManagedRoot,\s*realWorktreePath\)/);
  assert.match(helperSource, /workflow\.variant\.adopt_failed/);

  const failureIndex = worktreeAdoptHandler.indexOf("recordVariantAdoptFailure");
  const throwIndex = worktreeAdoptHandler.indexOf("throw error");
  assert.ok(failureIndex >= 0, "boundary rejection must append workflow.variant.adopt_failed");
  assert.ok(failureIndex < throwIndex, "adopt_failed must be recorded before the normalized IPC error is thrown");
});

test("workflow adopt IPC audits missing created worktree identity before rejecting", async () => {
  const main = await readFile(join(root, "electron", "main.ts"), "utf8");
  const worktreeAdoptHandler = main.slice(
    main.indexOf('ipcMain.handle("workflow:worktree:adopt"'),
    main.indexOf('ipcMain.handle("workflow:worktree:clean"'),
  );
  const preService = worktreeAdoptHandler.slice(
    worktreeAdoptHandler.indexOf("const existingEvents"),
    worktreeAdoptHandler.indexOf("const appendedEvents"),
  );

  const tryIndex = preService.indexOf("try {");
  const lookupIndex = preService.indexOf("findCreatedWorktreeIdentity");
  const boundaryIndex = preService.indexOf("assertAdoptedWorktreeBelongsToProject");
  const catchIndex = preService.indexOf("catch (error)");
  const failureIndex = preService.indexOf("recordVariantAdoptFailure");
  const broadcastIndex = preService.indexOf("broadcastWorkflowProjection");
  const throwIndex = preService.indexOf("throw error");

  assert.ok(tryIndex >= 0, "adopt identity lookup must be inside an audited try/catch");
  assert.ok(lookupIndex > tryIndex, "missing/non-created worktree identity must be caught and audited");
  assert.ok(lookupIndex < boundaryIndex, "identity lookup must happen before boundary validation");
  assert.ok(boundaryIndex < catchIndex, "boundary validation must share the audited catch path");
  assert.ok(failureIndex > catchIndex, "adopt_failed must be recorded in the preflight catch path");
  assert.ok(failureIndex < broadcastIndex, "adopt_failed must be appended before broadcast");
  assert.ok(broadcastIndex < throwIndex, "projection must be broadcast before rejecting");
  assert.ok(
    worktreeAdoptHandler.indexOf("findCreatedWorktreeIdentity") < worktreeAdoptHandler.indexOf("service.adoptVariant"),
    "unknown worktree identity must reject before checkout or merge adoption",
  );
});

test("workflow clean IPC audits boundary rejection before service removal", async () => {
  const main = await readFile(join(root, "electron", "main.ts"), "utf8");
  const worktreeCleanHandler = main.slice(
    main.indexOf('ipcMain.handle("workflow:worktree:clean"'),
    main.indexOf('ipcMain.handle("workflow:changeset"'),
  );
  const preService = worktreeCleanHandler.slice(
    worktreeCleanHandler.indexOf("const store = await getWorkflowStore"),
    worktreeCleanHandler.indexOf('await import("@skyturn/git-worktree/node")'),
  );

  const storeIndex = preService.indexOf("const store = await getWorkflowStore");
  const tryIndex = preService.indexOf("try {");
  const boundaryIndex = preService.indexOf("assertCleanWorktreeBelongsToProject");
  const catchIndex = preService.indexOf("catch (error)");
  const failureIndex = preService.indexOf("recordWorktreeCleanFailure");
  const broadcastIndex = preService.indexOf("broadcastWorkflowProjection");
  const throwIndex = preService.indexOf("throw error");

  assert.ok(storeIndex >= 0, "clean IPC must open the workflow store before auditable boundary preflight");
  assert.ok(tryIndex > storeIndex, "clean boundary preflight must run inside an audited try/catch");
  assert.ok(boundaryIndex > tryIndex, "repoRoot and managed-path checks must be in the audited preflight");
  assert.ok(boundaryIndex < catchIndex, "boundary rejection must enter the audit catch path");
  assert.ok(failureIndex > catchIndex, "clean_failed must be recorded for boundary rejection");
  assert.ok(failureIndex < broadcastIndex, "clean_failed must be appended before broadcast");
  assert.ok(broadcastIndex < throwIndex, "projection must be broadcast before rejecting");
  assert.doesNotMatch(preService, /cleanManagedWorktree|service\.cleanManagedWorktree/);
  assert.ok(
    boundaryIndex < worktreeCleanHandler.indexOf("service.cleanManagedWorktree"),
    "boundary checks must remain before git worktree removal",
  );
});

test("changeset IPC resolves real paths before project boundary checks", async () => {
  const main = await readFile(join(root, "electron", "main.ts"), "utf8");

  assert.match(main, /changeset:get/);
  assert.match(main, /workflow:changeset/);
  assert.match(main, /workflow:changeset:reconcileFinal/);
  assert.match(main, /await fs\.realpath\(projectRoot\)/);
  assert.match(main, /await fs\.realpath\(worktreePath\)/);
  assert.match(main, /createGitChangesetService\(\{ repoRoot: realProjectRoot \}\)/);
  assert.match(main, /reconcileFinalChangeset/);
  assert.match(main, /liveChangesFromRunEvents/);
  assert.match(main, /const projectWorktreesRoot = `\$\{realProjectRoot\}\.worktrees`/);
  assert.match(main, /realProjectWorktreesRoot === projectWorktreesRoot/);
});

test("branch facts IPC stays in Electron main and uses git-worktree node helpers", async () => {
  const main = await readFile(join(root, "electron", "main.ts"), "utf8");
  const preload = await readFile(join(root, "electron", "preload.ts"), "utf8");

  const branchFactsHandler = main.slice(
    main.indexOf('ipcMain.handle("project:branchFacts"'),
    main.indexOf('ipcMain.handle("editor:openWorktree"'),
  );
  assert.match(branchFactsHandler, /assertKnownProjectRoot\(projectRoot\)/);
  assert.match(branchFactsHandler, /getGitBranchFacts/);
  assert.match(branchFactsHandler, /protocolVersion:\s*RUN_PROTOCOL_VERSION/);
  assert.match(preload, /getProjectBranchFacts:\s*\(projectRoot: string\) => ipcRenderer\.invoke\("project:branchFacts", projectRoot\)/);
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
  assert.equal(contracts.WORKFLOW_IPC_CHANNELS.updateNodePosition, "workflow:nodePosition:update");
  assert.equal(contracts.WORKFLOW_IPC_CHANNELS.deliveryCommit, "workflow:delivery:commit");
  assert.equal(Object.hasOwn(contracts.WORKFLOW_IPC_CHANNELS, "applyIntent"), false);
  assert.equal(Object.hasOwn(contracts.WORKFLOW_IPC_CHANNELS, "scheduleReady"), false);
  assert.equal(Object.hasOwn(contracts.WORKFLOW_IPC_CHANNELS, "recordRunResult"), false);
  assert.deepEqual(
    toPlain(contracts.normalizeWorkflowNodePositionUpdate({
      sessionId: " session-1 ",
      updateId: " drag-1 ",
      nodeId: " node-1 ",
      position: { x: 12.5, y: -3 },
    })),
    {
      sessionId: "session-1",
      updateId: "drag-1",
      nodeId: "node-1",
      position: { x: 12.5, y: -3 },
    },
  );
  for (const input of [
    { sessionId: "", updateId: "drag-1", nodeId: "node-1", position: { x: 1, y: 2 } },
    { sessionId: "session-1", updateId: "drag-1", nodeId: "", position: { x: 1, y: 2 } },
    { sessionId: "session-1", updateId: "drag-1", nodeId: "node-1", position: { x: Infinity, y: 2 } },
    { sessionId: "session-1", updateId: "drag-1", nodeId: "node-1", position: { x: 1_000_001, y: 2 } },
  ]) {
    assert.throws(
      () => contracts.normalizeWorkflowNodePositionUpdate(input),
      /SKYTURN_WORKFLOW_IPC_ERROR:INVALID_INPUT/,
    );
  }
  assert.equal(
    contracts.formatWorkflowIpcError("DELIVERY_REJECTED", "Commit rejected."),
    "SKYTURN_WORKFLOW_IPC_ERROR:DELIVERY_REJECTED: Commit rejected.",
  );
});

test("run start guard trusts the raw SQLite planner identity before Canvas materialization", async () => {
  const contracts = await loadWorkflowIpcContracts();
  const input = {
    sessionId: "session-1",
    nodeId: "node-1",
    runId: "run-session-1-node-1-20260713090000",
    agentKind: "hermes",
    plannerSessionId: "hermes-session-1",
    plannerInputId: "run-session-1-node-1-20260713090000",
  };
  const store = {
    getPlannerStartAuthorization(sessionId) {
      assert.equal(sessionId, "session-1");
      return {
        plannerNodeId: "node-1",
        plannerSessionId: "hermes-session-1",
        agentKind: "hermes",
        executable: true,
        dependencies: [],
        hasIncomingEdges: false,
      };
    },
    materializeCanvasSession() {
      throw new Error("Canvas materialization must not authorize an unclaimed planner turn.");
    },
  };

  assert.equal(contracts.rejectMissingWorkflowProjectionNode(input, 1), true);
  assert.equal(contracts.isTrustedPlannerRootStartInput(input, store), true);
});

test("run start guard rejects planner starts without concrete turn identity or graph hygiene", async () => {
  const contracts = await loadWorkflowIpcContracts();
  const validInput = {
    sessionId: "session-1",
    nodeId: "node-1",
    runId: "run-session-1-node-1-20260713090000",
    agentKind: "hermes",
    plannerSessionId: "hermes-session-1",
    plannerInputId: "run-session-1-node-1-20260713090000",
  };
  const makeStore = (overrides = {}) => ({
    getPlannerStartAuthorization() {
      return {
        plannerNodeId: "node-1",
        plannerSessionId: "hermes-session-1",
        agentKind: "hermes",
        executable: true,
        dependencies: [],
        hasIncomingEdges: false,
        ...overrides,
      };
    },
  });

  assert.equal(contracts.isTrustedPlannerRootStartInput({ ...validInput, plannerInputId: "" }, makeStore()), false);
  assert.equal(contracts.isTrustedPlannerRootStartInput({ ...validInput, plannerSessionId: "other" }, makeStore()), false);
  assert.equal(contracts.isTrustedPlannerRootStartInput(validInput, makeStore({ hasIncomingEdges: true })), false);
});

test("run start guard keeps rejecting missing non-planner projection nodes", async () => {
  const contracts = await loadWorkflowIpcContracts();
  const store = {
    getPlannerStartAuthorization: () => null,
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

test("run start guard rejects non-executable raw planner identities", async () => {
  const contracts = await loadWorkflowIpcContracts();
  const makeStore = (authorization) => ({ getPlannerStartAuthorization: () => authorization });
  const input = {
    sessionId: "session-1",
    nodeId: "node-1",
    runId: "run-1",
    agentKind: "hermes",
    plannerSessionId: "hermes-session-1",
    plannerInputId: "run-1",
  };

  for (const authorization of [
    { plannerNodeId: "node-1", plannerSessionId: "hermes-session-1", agentKind: "hermes", executable: false, dependencies: [], hasIncomingEdges: false },
    { plannerNodeId: "node-1", plannerSessionId: "hermes-session-1", agentKind: "hermes", executable: true, dependencies: ["node-2"], hasIncomingEdges: false },
    { plannerNodeId: "node-1", plannerSessionId: "hermes-session-1", agentKind: "hermes", executable: true, dependencies: [], hasIncomingEdges: true },
  ]) {
    assert.equal(contracts.isTrustedPlannerRootStartInput(input, makeStore(authorization)), false);
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

async function loadWorktreeComparisonRuntime() {
  const source = await readFile(join(root, "electron", "worktreeComparisonRuntime.ts"), "utf8");
  const ts = require("typescript");
  const output = ts.transpileModule(source, {
    compilerOptions: {
      module: ts.ModuleKind.CommonJS,
      target: ts.ScriptTarget.ES2022,
    },
  }).outputText;
  const module = { exports: {} };
  const workflowContracts = {
    WORKFLOW_IPC_ERROR_PREFIX: "SKYTURN_WORKFLOW_IPC_ERROR",
    workflowIpcError(code, message) {
      return new Error(`SKYTURN_WORKFLOW_IPC_ERROR:${code}: ${message}`);
    },
  };
  vm.runInNewContext(output, {
    Error,
    module,
    exports: module.exports,
    require(specifier) {
      if (specifier === "./workflowIpcContracts") return workflowContracts;
      return require(specifier);
    },
  }, { filename: "worktreeComparisonRuntime.ts" });
  return module.exports;
}

function createdWorktreeEvent(sessionId, worktreeId, variantId, repoRoot = "/project") {
  const realPath = `${repoRoot}.worktrees/${worktreeId}`;
  return {
    sessionId,
    kind: "workflow.worktree.created",
    payload: {
      worktree: {
        worktreeId,
        variantId,
        path: realPath,
        realPath,
        gitdir: `${repoRoot}/.git/worktrees/${worktreeId}`,
        repoRoot,
        branchName: `skyturn/${sessionId}/${variantId}`,
        baseCommit: "base-commit",
        headCommit: "head-commit",
        parentLaneId: `lane-${variantId}`,
      },
    },
  };
}

function comparisonHarness(events, failure = null, comparison = validComparisonEvidence()) {
  const compareCalls = [];
  const serviceOptions = [];
  const dependencies = {
    assertKnownProjectRoot() {},
    async getWorkflowStore() {
      return {
        materializeCanvasSession(sessionId) {
          return sessionId === "session-1" ? { id: sessionId } : null;
        },
        listEvents() {
          return events;
        },
      };
    },
    async loadGitWorktreeModule() {
      if (failure?.message.startsWith("import")) throw failure;
      return {
        parseWorktreeComparisonRequest(value) {
          return value;
        },
        parseVariantComparisonEvidence(value) {
          if (typeof value?.comparisonId !== "string") throw new Error("invalid result at /secret/result");
          return value;
        },
        createNodeGitWorktreeService(options) {
          serviceOptions.push(options);
          if (failure && !failure.message.startsWith("import")) throw failure;
          return {
            async compareVariants(value) {
              compareCalls.push(value);
              return comparison;
            },
          };
        },
      };
    },
    async canonicalPath(value) {
      return value;
    },
  };
  return { dependencies, compareCalls, serviceOptions };
}

function validComparisonEvidence() {
  return {
    comparisonId: "comparison-left-right",
    collectedAt: "2026-07-12T00:00:00.000Z",
    variants: [],
  };
}

async function loadMainMergeGateHelpers() {
  const main = await readFile(join(root, "electron", "main.ts"), "utf8");
  const source = [
    'function workflowIpcError(code, message) { const error = new Error(message); error.code = code; return error; }',
    'function isRecord(value) { return !!value && typeof value === "object" && !Array.isArray(value); }',
    'function optionalText(value) { return typeof value === "string" && value.trim() ? value.trim() : undefined; }',
    'function requireText(value, field) { const text = optionalText(value); if (!text) throw workflowIpcError("INVALID_INPUT", `${field} is required.`); return text; }',
    extractFunction(main, "findDeliveryPullRequestChecksEvidence"),
    extractFunction(main, "pullRequestReviewStatusForIpc"),
    extractFunction(main, "normalizePullRequestReviewStatusForIpc"),
    "module.exports = { findDeliveryPullRequestChecksEvidence };",
  ].join("\n");
  const ts = require("typescript");
  const output = ts.transpileModule(source, {
    compilerOptions: {
      module: ts.ModuleKind.CommonJS,
      target: ts.ScriptTarget.ES2022,
    },
  }).outputText;
  const module = { exports: {} };
  vm.runInNewContext(output, { module, exports: module.exports }, { filename: "main.mergeGate.ts" });
  return module.exports;
}

async function loadMainRendererCanvasSessionHelpers() {
  const main = await readFile(join(root, "electron", "main.ts"), "utf8");
  const source = [
    'function isRecord(value) { return !!value && typeof value === "object" && !Array.isArray(value); }',
    'const terminalRuntime = { hermesPlannerTerminalSessionId: (sessionId) => sessionId === "session-1" ? "hermes-planner-session-1" : null };',
    extractFunction(main, "augmentCanvasSessionWithHermesTerminal"),
    extractFunction(main, "materializeRendererCanvasSession"),
    "module.exports = { materializeRendererCanvasSession };",
  ].join("\n");
  const ts = require("typescript");
  const output = ts.transpileModule(source, {
    compilerOptions: {
      module: ts.ModuleKind.CommonJS,
      target: ts.ScriptTarget.ES2022,
    },
  }).outputText;
  const module = { exports: {} };
  vm.runInNewContext(output, { module, exports: module.exports }, { filename: "main.rendererCanvasSession.ts" });
  return module.exports;
}

async function loadMainDeliveryRendererHelpers() {
  const main = await readFile(join(root, "electron", "main.ts"), "utf8");
  const source = [
    extractFunction(main, "positiveInteger"),
    extractFunction(main, "optionalText"),
    extractFunction(main, "isRecord"),
    main.slice(
      main.indexOf("function deliveryLifecycleFactsForRenderer"),
      main.indexOf("function workflowEventSummary"),
    ),
    extractFunction(main, "workflowEventSummary"),
    main.slice(
      main.indexOf("function redactWorkflowEventForRenderer"),
      main.indexOf("function deliveryLifecycleFactsForRenderer"),
    ),
    "module.exports = { redactWorkflowEventForRenderer };",
  ].join("\n");
  const ts = require("typescript");
  const output = ts.transpileModule(source, {
    compilerOptions: {
      module: ts.ModuleKind.CommonJS,
      target: ts.ScriptTarget.ES2022,
    },
  }).outputText;
  const module = { exports: {} };
  vm.runInNewContext(output, { module, exports: module.exports }, { filename: "main.deliveryRenderer.ts" });
  return module.exports;
}

function extractFunction(source, name) {
  const functionStart = source.indexOf(`function ${name}`);
  assert.ok(functionStart >= 0, `missing function ${name}`);
  const start = source.slice(Math.max(0, functionStart - 6), functionStart) === "async "
    ? functionStart - 6
    : functionStart;
  const parametersStart = source.indexOf("(", functionStart);
  let parametersDepth = 0;
  let parametersEnd = -1;
  for (let index = parametersStart; index < source.length; index += 1) {
    if (source[index] === "(") parametersDepth += 1;
    if (source[index] === ")") parametersDepth -= 1;
    if (parametersDepth === 0) {
      parametersEnd = index;
      break;
    }
  }
  const braceStart = source.indexOf("{", parametersEnd);
  assert.ok(braceStart > start, `missing function body for ${name}`);
  let depth = 0;
  for (let index = braceStart; index < source.length; index += 1) {
    const char = source[index];
    if (char === "{") depth += 1;
    if (char === "}") depth -= 1;
    if (depth === 0) return source.slice(start, index + 1);
  }
  throw new Error(`unterminated function ${name}`);
}

function storeWithEvents(events) {
  return {
    listEvents() {
      return events;
    },
  };
}

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function methodResultType(method) {
  return {
    pushDeliveryBranch: "WorkflowDeliveryPushResult",
    createPullRequest: "WorkflowPullRequestCreateResult",
    mergePullRequest: "WorkflowPullRequestMergeResult",
    syncMain: "WorkflowDeliveryMainSyncResult",
  }[method];
}

function toPlain(value) {
  return JSON.parse(JSON.stringify(value));
}

let productionGitWorktreeModulePromise;

async function createRealScheduledWorktreeHarness(t) {
  const tempRoot = await fs.mkdtemp(join(tmpdir(), "skyturn-scheduled-worktree-"));
  t.after(() => fs.rm(tempRoot, { recursive: true, force: true }));
  const projectPath = join(tempRoot, "project");
  git(tempRoot, ["init", "project"]);
  git(projectPath, ["checkout", "-b", "main"]);
  git(projectPath, ["config", "user.email", "skyturn@example.test"]);
  git(projectPath, ["config", "user.name", "SkyTurn Test"]);
  await fs.writeFile(join(projectPath, "base.txt"), "base\n");
  git(projectPath, ["add", "base.txt"]);
  git(projectPath, ["commit", "-m", "initial"]);
  const projectRoot = await fs.realpath(projectPath);
  const baseCommit = git(projectRoot, ["rev-parse", "HEAD"]);
  const events = [];
  const createCalls = [];
  const reconcileCalls = [];
  const production = await loadProductionGitWorktreeModule();
  const createService = (options = {}) => {
    const service = production.createNodeGitWorktreeService(options);
    return {
      createManagedWorktree(input) {
        createCalls.push(structuredClone(input));
        return service.createManagedWorktree(input);
      },
      reconcileManagedWorktree(worktree, reconcileOptions) {
        reconcileCalls.push({
          worktree: structuredClone(worktree),
          options: structuredClone(reconcileOptions),
        });
        return service.reconcileManagedWorktree(worktree, reconcileOptions);
      },
    };
  };
  const runtime = await loadScheduledWorkflowWorktreeRuntime(createService);
  const store = storeWithMutableEvents(events);

  return {
    ...runtime,
    resolve: runtime.resolveScheduledWorkflowWorktree,
    tempRoot,
    projectRoot,
    baseCommit,
    events,
    store,
    createCalls,
    reconcileCalls,
    createService,
    createdEvents: () => events.filter((event) => event.kind === "workflow.worktree.created"),
  };
}

async function loadProductionGitWorktreeModule() {
  productionGitWorktreeModulePromise ??= (async () => {
    const ts = require("typescript");
    const projectCore = transpileCommonJsModule(
      await readFile(join(root, "..", "..", "packages", "project-core", "src", "index.ts"), "utf8"),
      "project-core.index.ts",
      require,
      ts,
    );
    const indexModule = transpileCommonJsModule(
      await readFile(join(root, "..", "..", "packages", "git-worktree", "src", "index.ts"), "utf8"),
      "git-worktree.index.ts",
      (specifier) => specifier === "@skyturn/project-core" ? projectCore : require(specifier),
      ts,
    );
    const gitCommandModule = transpileCommonJsModule(
      await readFile(join(root, "..", "..", "packages", "git-worktree", "src", "internal", "gitCommand.ts"), "utf8"),
      "git-worktree.gitCommand.ts",
      require,
      ts,
      { Buffer, process },
    );
    return transpileCommonJsModule(
      await readFile(join(root, "..", "..", "packages", "git-worktree", "src", "node.ts"), "utf8"),
      "git-worktree.node.ts",
      (specifier) => {
        if (specifier === "./index.js") return indexModule;
        if (specifier === "./internal/gitCommand.js") return gitCommandModule;
        return require(specifier);
      },
      ts,
      { Buffer, process },
    );
  })();
  return productionGitWorktreeModulePromise;
}

function transpileCommonJsModule(source, filename, load, ts, globals = {}) {
  const output = ts.transpileModule(source, {
    compilerOptions: {
      module: ts.ModuleKind.CommonJS,
      target: ts.ScriptTarget.ES2022,
    },
  }).outputText;
  const module = { exports: {} };
  vm.runInNewContext(output, {
    module,
    exports: module.exports,
    require: load,
    ...globals,
  }, { filename });
  return module.exports;
}

async function loadScheduledWorkflowWorktreeRuntime(createNodeGitWorktreeService) {
  const main = await readFile(join(root, "electron", "main.ts"), "utf8");
  const projectCore = await readFile(join(root, "..", "..", "packages", "project-core", "src", "index.ts"), "utf8");
  const source = [
    projectCore.slice(
      projectCore.indexOf("const candidateIdentifierMaxLength"),
      projectCore.indexOf("export function parseWorkflowLaneCandidateBinding"),
    ),
    extractFunction(projectCore, "parseWorkflowLaneCandidateBinding"),
    extractFunction(projectCore, "assertExactKeys"),
    extractFunction(projectCore, "candidateIdentifier"),
    extractFunction(projectCore, "candidateVariantId"),
    extractFunction(projectCore, "sortedCandidateIdentifiers"),
    extractFunction(main, "optionalText"),
    extractFunction(main, "isRecord"),
    extractFunction(main, "readField"),
    extractFunction(main, "requireRecord"),
    extractFunction(main, "requireText"),
    extractFunction(main, "isInsidePath"),
    extractFunction(main, "workflowWorktreeIdentityFromRecord"),
    extractFunction(main, "managedWorktreeEventsFromStore"),
    extractFunction(main, "isManagedWorktreeEventKind"),
    extractFunction(main, "findWorktreeCreatedEvent"),
    extractFunction(main, "findCreatedWorktreeIdentity"),
    extractFunction(main, "assertAdoptedWorktreeBelongsToProject"),
    extractFunction(main, "createManagedWorkflowWorktreeForRun"),
    extractFunction(main, "requireScheduledWorkflowCandidateBinding"),
    extractFunction(main, "assertScheduledWorkflowNodeCandidateIdentity"),
    extractFunction(main, "findScheduledWorkflowCreatedIdentity"),
    extractFunction(main, "sameScheduledWorkflowWorktreeIdentity"),
    extractFunction(main, "canonicalScheduledWorkflowWorktreePath"),
    extractFunction(main, "reconcileManagedWorkflowWorktreeForRun"),
    extractFunction(main, "resolveScheduledWorkflowWorktree"),
    main.slice(
      main.indexOf("async function resolveGitCommit"),
      main.indexOf("function recordWorktreeCreateFailure"),
    ),
    "module.exports = { parseWorkflowLaneCandidateBinding, resolveScheduledWorkflowWorktree };",
  ].join("\n");
  const ts = require("typescript");
  const output = ts.transpileModule(source, {
    compilerOptions: {
      module: ts.ModuleKind.CommonJS,
      target: ts.ScriptTarget.ES2022,
    },
  }).outputText;
  const module = { exports: {} };
  vm.runInNewContext(output, {
    module,
    exports: module.exports,
    execFileAsync: promisify(execFile),
    fs,
    path,
    recordWorktreeCreateFailure() {
      throw new Error("Unexpected worktree-create failure path.");
    },
    requireCheckpointBoundWorktreeBase: async (_store, input) => input.sourceHeadCommit,
    workflowCheckpointGateAuthority: () => ({}),
    workflowIpcError(code, message) {
      const error = new Error(message);
      error.code = code;
      return error;
    },
    require(specifier) {
      if (specifier === "@skyturn/project-core") {
        return { parseWorkflowLaneCandidateBinding: module.exports.parseWorkflowLaneCandidateBinding };
      }
      if (specifier === "@skyturn/git-worktree/node") return { createNodeGitWorktreeService };
      return require(specifier);
    },
  }, { filename: "main.scheduledWorkflowWorktree.ts" });
  return module.exports;
}

async function runScheduledResolverFailure(segment) {
  const main = await readFile(join(root, "electron", "main.ts"), "utf8");
  const source = [
    extractFunction(main, "advanceOneWorkflowSession"),
    extractFunction(main, "compensateScheduledWorkflowStartBuildFailure"),
    extractFunction(main, "buildScheduledWorkflowRunStartInput"),
    "module.exports = { advanceOneWorkflowSession };",
  ].join("\n");
  const ts = require("typescript");
  const output = ts.transpileModule(source, {
    compilerOptions: {
      module: ts.ModuleKind.CommonJS,
      target: ts.ScriptTarget.ES2022,
    },
  }).outputText;
  const module = { exports: {} };
  const resolveCalls = [];
  const compensations = [];
  let scheduledStartCalls = 0;
  let adapterLaunches = 0;
  let reopenCalls = 0;
  let runningSegments = [];
  let laneStatus = "pending";
  const node = {
    id: segment.laneId,
    runId: segment.runId,
    agent: segment.agentKind,
    status: laneStatus,
    title: "Implementation",
    context: { dependencies: [] },
    worktree: { executionTarget: "new_worktree" },
  };
  const session = {
    id: segment.sessionId,
    kind: "canvas",
    plannerNodeId: "planner-root",
    target: { executionTarget: "new_worktree" },
    nodes: [node],
  };
  const store = {
    materializeCanvasSession() {
      node.status = laneStatus;
      return session;
    },
    listRunningSegments() {
      return runningSegments;
    },
    previewReadyLanes() {
      return laneStatus === "pending"
        ? { readyLanes: [{ id: segment.laneId, segmentId: segment.segmentId, runId: segment.runId }] }
        : { readyLanes: [] };
    },
    scheduleReadyLanes() {
      runningSegments = [segment];
      return { readyLanes: [{ id: segment.laneId, segmentId: segment.segmentId, runId: segment.runId }] };
    },
  };
  vm.runInNewContext(output, {
    module,
    exports: module.exports,
    MAX_MAIN_WORKFLOW_RUNS_PER_PROJECT: 4,
    isRecord: (value) => value !== null && typeof value === "object" && !Array.isArray(value),
    hasRunningSharedWorkflowWriter: () => false,
    hasReadySharedWorkflowWriter: () => false,
    requireWorkflowCanvasSession: () => session,
    resolveScheduledWorkflowWorktree: async (projectRoot, _store, resolvedSession, resolvedNode, segmentId) => {
      resolveCalls.push({
        projectRoot,
        sessionId: resolvedSession.id,
        laneId: resolvedNode.id,
        segmentId,
      });
      throw new Error("Scheduled worktree reconciliation rejected.");
    },
    compensateFailedWorkflowRun: (_store, compensatedSegment, error) => {
      compensations.push({
        segment: structuredClone(compensatedSegment),
        message: error instanceof Error ? error.message : String(error),
      });
      runningSegments = [];
      laneStatus = "failed";
    },
    reopenWorkflowStore: async () => {
      reopenCalls += 1;
      throw new Error("Unexpected workflow-store reopen.");
    },
    scheduledWorkflowRunStartHandler: async () => {
      scheduledStartCalls += 1;
      adapterLaunches += 1;
    },
    trustedRunStartIdentity: async () => {
      throw new Error("Resolver failure must precede start identity.");
    },
    ensureDangerousRunAuthorization: () => "blocked",
    broadcastWorkflowProjection() {},
    require(specifier) {
      if (specifier === "@skyturn/ui-canvas/workflow-runtime") {
        return {
          sandboxForNodeRun: () => "read-only",
          workflowSchedulingPolicyForSession: () => ({ allowedParallelism: 1 }),
        };
      }
      return require(specifier);
    },
  }, { filename: "main.scheduledResolverFailure.ts" });
  await module.exports.advanceOneWorkflowSession("/canonical/project", store, segment.sessionId, "run_terminal");
  return {
    resolveCalls,
    compensations,
    scheduledStartCalls,
    adapterLaunches,
    reopenCalls,
  };
}

async function runBlockedWriterObserverBackfill() {
  const main = await readFile(join(root, "electron", "main.ts"), "utf8");
  const source = [
    extractFunction(main, "advanceOneWorkflowSession"),
    "module.exports = { advanceOneWorkflowSession };",
  ].join("\n");
  const ts = require("typescript");
  const output = ts.transpileModule(source, {
    compilerOptions: {
      module: ts.ModuleKind.CommonJS,
      target: ts.ScriptTarget.ES2022,
    },
  }).outputText;
  const module = { exports: {} };
  const writer = {
    id: "lane-writer",
    runId: "run-writer",
    agent: "codex",
    status: "pending",
    title: "Implementation",
    context: { dependencies: [] },
    worktree: { executionTarget: "current_branch" },
  };
  const observer = {
    id: "lane-observer",
    runId: "run-observer",
    agent: "codex",
    status: "pending",
    title: "Validation",
    context: { dependencies: [] },
    worktree: { executionTarget: "current_branch" },
  };
  const session = {
    id: "session-contender",
    kind: "canvas",
    plannerNodeId: "planner-root",
    target: { executionTarget: "current_branch" },
    nodes: [writer, observer],
  };
  const externalWriter = {
    sessionId: "session-owner",
    laneId: "lane-owner",
    segmentId: "segment-owner",
    runId: "run-owner",
    agentKind: "codex",
  };
  const observerSegment = {
    sessionId: session.id,
    laneId: observer.id,
    segmentId: "segment-observer",
    runId: observer.runId,
    agentKind: observer.agent,
  };
  let runningSegments = [externalWriter];
  let scheduled = false;
  const previewCalls = [];
  const scheduleCalls = [];
  const startedLaneIds = [];
  const store = {
    materializeCanvasSession() {
      return session;
    },
    listRunningSegments() {
      return runningSegments;
    },
    previewReadyLanes(_sessionId, input) {
      previewCalls.push(structuredClone(input));
      return scheduled
        ? { readyLanes: [] }
        : {
            readyLanes: [{
              id: writer.id,
              segmentId: "segment-writer",
              runId: writer.runId,
            }],
          };
    },
    scheduleReadyLanes(_sessionId, input) {
      scheduleCalls.push({
        allowedParallelism: input.allowedParallelism,
        authorizedLaneIds: [...input.authorizedLaneIds],
      });
      if (scheduled) return { readyLanes: [] };
      scheduled = true;
      observer.status = "running";
      runningSegments = [externalWriter, observerSegment];
      return {
        readyLanes: [{
          id: observer.id,
          segmentId: observerSegment.segmentId,
          runId: observer.runId,
        }],
      };
    },
  };
  vm.runInNewContext(output, {
    module,
    exports: module.exports,
    Date,
    Error,
    MAX_MAIN_WORKFLOW_RUNS_PER_PROJECT: 4,
    isRecord: (value) => value !== null && typeof value === "object" && !Array.isArray(value),
    hasRunningSharedWorkflowWriter: () => true,
    hasReadySharedWorkflowWriter: () => true,
    buildScheduledWorkflowRunStartInput: async (_projectRoot, _store, segment) => ({
      runId: segment.runId,
    }),
    trustedRunStartIdentity: async () => ({}),
    compensateScheduledWorkflowStartBuildFailure: async () => {
      throw new Error("Unexpected start-input compensation.");
    },
    scheduledWorkflowRunStartHandler: async (_input, context) => {
      startedLaneIds.push(context.segment.laneId);
      observer.status = "completed";
      runningSegments = [externalWriter];
    },
    ensureDangerousRunAuthorization: () => "blocked",
    broadcastWorkflowProjection() {},
    require(specifier) {
      if (specifier === "@skyturn/ui-canvas/workflow-runtime") {
        return {
          sandboxForNodeRun: (node) => node.id === writer.id ? "workspace-write" : "read-only",
          workflowSchedulingPolicyForSession: () => ({ allowedParallelism: 1 }),
        };
      }
      return require(specifier);
    },
  }, { filename: "main.blockedWriterObserverBackfill.ts" });
  await module.exports.advanceOneWorkflowSession("/canonical/project", store, session.id, "projection-query");
  return { previewCalls, scheduleCalls, startedLaneIds };
}

function scheduledWorktreeSession() {
  return {
    id: "session-1",
    target: {
      executionTarget: "new_worktree",
      selectedBranch: "main",
      baseRef: "main",
    },
  };
}

function scheduledWorktreeNode(laneId, binding) {
  const variantId = binding?.variantId ?? laneId;
  const worktreeId = binding?.worktreeId ?? `worktree-session-1-${laneId}`;
  return {
    id: laneId,
    candidateBinding: binding,
    worktree: {
      path: ".",
      branchName: "main",
      baseCommit: "main",
      executionTarget: "new_worktree",
      selectedBranch: "main",
      baseRef: "main",
      worktreeId,
      variantId,
      ...(binding ? { lineageId: binding.lineageId } : {}),
    },
  };
}

function candidateBinding(laneId, overrides = {}) {
  const variantId = overrides.variantId ?? "candidate";
  return {
    sessionId: "session-1",
    laneId,
    variantId,
    worktreeId: `worktree-session-1-${variantId}`,
    lineageId: overrides.lineageId ?? "lineage-session-1-candidate",
    reason: overrides.reason ?? "default",
    predecessorLaneIds: overrides.predecessorLaneIds ?? [],
    ...(overrides.sourceCheckpointId ? { sourceCheckpointId: overrides.sourceCheckpointId } : {}),
    ...(overrides.sourceHeadCommit ? { sourceHeadCommit: overrides.sourceHeadCommit } : {}),
  };
}

function storeWithMutableEvents(events) {
  return {
    listEvents() {
      return events;
    },
    appendWorkflowEvent(event) {
      const stored = {
        ...event,
        createdAt: event.now,
      };
      events.push(stored);
      return stored;
    },
  };
}

function git(cwd, args) {
  return execFileSync("git", args, {
    cwd,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  }).trim();
}

async function commitWorktree(worktreePath, label) {
  await fs.writeFile(join(worktreePath, `${label}.txt`), `${label}\n`);
  git(worktreePath, ["add", `${label}.txt`]);
  git(worktreePath, ["commit", "-m", `add ${label}`]);
  return git(worktreePath, ["rev-parse", "HEAD"]);
}

function replaceCreatedWorktree(events, worktreeOverrides) {
  return structuredClone(events).map((event) =>
    event.kind === "workflow.worktree.created"
      ? createdWorktreeEventWith(event, worktreeOverrides)
      : event
  );
}

function createdWorktreeEventWith(event, worktreeOverrides) {
  const clone = structuredClone(event);
  clone.payload.worktree = {
    ...clone.payload.worktree,
    ...worktreeOverrides,
  };
  return clone;
}

function legacyMethodResultType(method) {
  return {
    pushWorkflowDeliveryBranch: "WorkflowDeliveryPushResult",
    createWorkflowPullRequest: "WorkflowPullRequestCreateResult",
    mergeWorkflowPullRequest: "WorkflowPullRequestMergeResult",
    syncWorkflowMain: "WorkflowDeliveryMainSyncResult",
  }[method];
}
