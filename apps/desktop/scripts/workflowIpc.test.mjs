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
  assert.match(worktreeAdoptHandler, /catch\s*\(error\)\s*\{[\s\S]*broadcastWorkflowProjection\(projectRoot,\s*sessionId,\s*store\);[\s\S]*throw normalizeWorkflowIpcError\(error\);[\s\S]*\}/);
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
  const importIndex = pullRequestHandler.indexOf('await import("@skyturn/git-worktree/node")');
  const createIndex = pullRequestHandler.indexOf("createDeliveryPullRequest({");

  assert.ok(sessionIndex >= 0, "pull request IPC must require a workflow sessionId");
  assert.ok(canvasIndex > sessionIndex, "pull request IPC must validate the CanvasSession");
  assert.ok(prLaneIndex > canvasIndex, "pull request IPC must validate a pull_request lane");
  assert.ok(commitLaneIndex > prLaneIndex, "pull request IPC must validate the source commit lane");
  assert.ok(evidenceIndex > commitLaneIndex, "pull request IPC must load recorded commit evidence");
  assert.ok(baseIndex > evidenceIndex, "pull request IPC must validate base/head before gh create");
  assert.ok(importIndex > baseIndex, "pull request IPC must validate inputs before importing gh implementation");
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
  const checksEvidenceIndex = mergeHandler.indexOf("findDeliveryPullRequestChecksEvidence");
  const matchIndex = mergeHandler.indexOf("assertDeliveryPullRequestEvidenceInputMatches");
  const importIndex = mergeHandler.indexOf('await import("@skyturn/git-worktree/node")');
  const mergeIndex = mergeHandler.indexOf("mergeDeliveryPullRequest({");
  const eventIndex = mergeHandler.indexOf("workflow.pull_request.merged");

  assert.ok(sessionIndex >= 0, "merge IPC must require a workflow sessionId");
  assert.ok(laneIndex > sessionIndex, "merge IPC must validate an explicit pull_request lane");
  assert.ok(evidenceIndex > laneIndex, "merge IPC must load recorded PR evidence");
  assert.ok(checksEvidenceIndex > evidenceIndex, "merge IPC must require previously recorded passed checks");
  assert.ok(matchIndex > checksEvidenceIndex, "merge IPC must reject stale expectedHeadSha before gh merge");
  assert.ok(importIndex > matchIndex, "merge IPC must validate recorded evidence before importing gh implementation");
  assert.ok(mergeIndex > importIndex, "gh merge must only happen inside the explicit merge IPC");
  assert.ok(eventIndex > mergeIndex, "merged event must be appended only after gh merge returns");
  assert.doesNotMatch(mergeHandler, /workflow:worktree:clean/);
  assert.doesNotMatch(mergeHandler, /cleanManagedWorktree/);
  assert.doesNotMatch(mergeHandler, /deleteBranch:\s*true/);
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
  const eventIndex = syncHandler.indexOf("workflow.delivery.main_synced");

  assert.ok(sessionIndex >= 0, "sync main IPC must require a workflow sessionId to append evidence");
  assert.ok(canvasIndex > sessionIndex, "sync main IPC must validate the CanvasSession");
  assert.ok(importIndex > canvasIndex, "sync main IPC must validate session before importing git implementation");
  assert.ok(syncIndex > importIndex, "git sync must stay after server-side guards");
  assert.ok(eventIndex > syncIndex, "main_synced event must be appended after ff-only sync");
  assert.match(syncHandler, /mainBranch:\s*optionalText\(readField\(input,\s*"mainBranch"\)\)\s*\?\?\s*"main"/);
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
    main.indexOf("async function collectChangesetEvidenceForWorktree"),
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
    main.indexOf("async function collectChangesetEvidenceForWorktree"),
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

test("workflow createSession persists a normalized session target", async () => {
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
  assert.match(createSessionHandler, /target:\s*normalizeWorkflowSessionTarget\(input\.target\)/);
  assert.match(main, /function normalizeWorkflowSessionTarget\(value: unknown\): FinalSessionTarget/);
  assert.match(main, /return \{ executionTarget: "current_branch", selectedBranch: "HEAD" \};/);
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
  assert.doesNotMatch(preload, /ipcRenderer\s*:/);
  assert.doesNotMatch(preload, /return\s+ipcRenderer/);
  assert.doesNotMatch(preload, /execFile|spawn|shell|fs\./);
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

  assert.match(workflowContract, /status:\s*"pushed"/);
  assert.match(workflowContract, /evidence:\s*DeliveryPushEvidence/);
  assert.match(workflowContract, /status:\s*"created"/);
  assert.match(workflowContract, /evidence:\s*DeliveryPullRequestEvidence/);
  assert.match(devflowContract, /status:\s*"pushed"/);
  assert.match(devflowContract, /status:\s*"created"/);
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
  assert.match(workflowContract, /status:\s*"merged"/);
  assert.match(workflowContract, /evidence:\s*DeliveryPullRequestMergeEvidence/);
  assert.match(workflowContract, /status:\s*"synced"/);
  assert.match(workflowContract, /evidence:\s*DeliveryMainSyncEvidence/);
  assert.match(devflowContract, /status:\s*"checks_recorded"/);
  assert.match(devflowContract, /status:\s*"merged"/);
  assert.match(devflowContract, /status:\s*"synced"/);
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
  const throwIndex = worktreeAdoptHandler.indexOf("throw normalizeWorkflowIpcError");
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
  const throwIndex = preService.indexOf("throw normalizeWorkflowIpcError");

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
  const throwIndex = preService.indexOf("throw normalizeWorkflowIpcError");

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
  assert.equal(contracts.WORKFLOW_IPC_CHANNELS.deliveryCommit, "workflow:delivery:commit");
  assert.equal(
    contracts.formatWorkflowIpcError("DELIVERY_REJECTED", "Commit rejected."),
    "SKYTURN_WORKFLOW_IPC_ERROR:DELIVERY_REJECTED: Commit rejected.",
  );
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
