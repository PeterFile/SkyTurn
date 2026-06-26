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
    "workflow:checkpoints",
    "workflow:rollback:eligibility",
    "workflow:rollback:apply",
    "workflow:repair:create",
    "workflow:variant:create",
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
  assert.match(main, /listNodeCheckpoints/);
  assert.match(main, /getNodeRollbackEligibility/);
  assert.match(main, /applyNodeRollback/);
  assert.match(main, /requestNodeRepair/);
  assert.match(main, /requestNodeVariant/);
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
    main.indexOf('ipcMain.handle("workflow:checkpoints"'),
  );
  assert.match(workflowEventsHandler, /redactWorkflowEventForRenderer/);
  assert.doesNotMatch(workflowEventsHandler, /events:\s*store\.listEvents\(sessionId\)\.filter/);

  const checkpointHandler = main.slice(
    main.indexOf('ipcMain.handle("workflow:checkpoints"'),
    main.indexOf('ipcMain.handle("workflow:rollback:eligibility"'),
  );
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
  assert.match(repairHandler, /broadcastWorkflowProjection/);

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
    "getCheckpoints",
    "getRollbackEligibility",
    "applyRollback",
    "requestRepair",
    "requestVariant",
    "getChangeset",
    "createSession",
    "appendUserInput",
    "getLedger",
    "applyIntent",
    "scheduleReady",
    "recordRunResult",
    "getProjection",
    "getEvents",
    "getCheckpoints",
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

function extractFunction(source, name) {
  const start = source.indexOf(`function ${name}`);
  assert.ok(start >= 0, `missing function ${name}`);
  const braceStart = source.indexOf("{", start);
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

function legacyMethodResultType(method) {
  return {
    pushWorkflowDeliveryBranch: "WorkflowDeliveryPushResult",
    createWorkflowPullRequest: "WorkflowPullRequestCreateResult",
    mergeWorkflowPullRequest: "WorkflowPullRequestMergeResult",
    syncWorkflowMain: "WorkflowDeliveryMainSyncResult",
  }[method];
}
