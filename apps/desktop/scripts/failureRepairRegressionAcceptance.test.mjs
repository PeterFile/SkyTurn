import assert from "node:assert/strict";
import { once } from "node:events";
import { access, mkdtemp, readFile, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import test from "node:test";

import * as acceptance from "./failureRepairRegressionAcceptance.mjs";
import {
  authoritativeStateDifference,
  automaticRepairHandoffState,
  collectProcessOutput,
  failureRepairRegressionFixture,
  failureRepairRegressionSummary,
  hasSuccessfulCodexCliExitEvidence,
  repairChainTerminalState,
} from "./failureRepairRegressionAcceptance.mjs";

const baselineHead = "a".repeat(40);

test("failure repair process output preserves UTF-8 split across stream chunks", async () => {
  const stream = new PassThrough();
  let output = "";
  collectProcessOutput(stream, (chunk) => { output += chunk; });
  const bytes = Buffer.from("修复，回归", "utf8");
  const punctuationOffset = Buffer.from("修复", "utf8").length;

  stream.write(bytes.subarray(0, punctuationOffset + 1));
  stream.write(bytes.subarray(punctuationOffset + 1, punctuationOffset + 2));
  stream.end(bytes.subarray(punctuationOffset + 2));
  await once(stream, "end");

  assert.equal(output, "修复，回归");
  assert.doesNotMatch(output, /\uFFFD/);
});

test("failure repair public result is strict and bounded", () => {
  assert.equal(typeof acceptance.serializeBoundedAcceptanceResult, "function");
  const serialized = acceptance.serializeBoundedAcceptanceResult({
    ok: false,
    failure: { diagnostic: `Bearer secret-token ${"x".repeat(1_000_000)}` },
  });
  const result = JSON.parse(serialized);

  assert.ok(Buffer.byteLength(serialized) <= 8_192);
  assert.equal(result.ok, false);
  assert.equal(result.failure.code, "FAILURE_REPAIR_REGRESSION_RESULT_OVERFLOW");
  assert.doesNotMatch(serialized, /secret-token|x{100}/);

  const short = acceptance.serializeBoundedAcceptanceResult({
    ok: false,
    failure: { diagnostic: "Bearer short-secret API_KEY=also-secret /Users/alice/private" },
  });
  assert.doesNotMatch(short, /short-secret|also-secret|alice/);
  assert.match(short, /redacted/);
});

test("failure repair acceptance uses the ordinary Electron workflow path without terminal seeding", async () => {
  const source = await readFile(new URL("failureRepairRegressionAcceptance.mjs", import.meta.url), "utf8");

  assert.match(source, /launchElectronAcceptanceApp/);
  assert.match(source, /connectToReadySkyTurnRenderer/);
  assert.match(source, /waitForStoredProjectRegistration/);
  assert.match(source, /finalizeAcceptanceOutcome/);
  assert.match(source, /openProjectThroughUi/);
  assert.match(source, /fillTextareaAndClickCreate/);
  assert.match(source, /overwriteWorkspaceSessionWithStaleClone/);
  assert.match(source, /ELECTRON_RUN_AS_NODE:\s*"1"/);
  assert.match(source, /import\("@skyturn\/persistence\/workflow-store"\)/);
  assert.match(source, /\.react-flow__node\[data-id=.*\.agent-card-select/);
  assert.match(source, /projectRoot = await realpath\(await mkdtemp/);
  assert.match(source, /window\.devflow\.onWorkflowEvent/);
  assert.match(source, /collector\.unsubscribe\(\)/);
  assert.doesNotMatch(source, /--seed|seedFailureRepairRegressionStore|createSeedWorkspaceState/);
  const inspectStart = source.indexOf("export async function inspectFailureRepairRegressionStore");
  const inspectEnd = source.indexOf("export async function submitRepairThroughUi", inspectStart);
  assert.ok(inspectStart >= 0 && inspectEnd > inspectStart);
  const nonInspectorSource = source.slice(0, inspectStart) + source.slice(inspectEnd);
  assert.doesNotMatch(
    nonInspectorSource,
    /scheduleReadyLanes|recordRunResult|recordRunCheckpoint|createWorkflowGitAncestryProof/,
  );
  assert.doesNotMatch(source, /appendWorkflowEvent|createWorkflowSession|writeFile\([^\n]*workspacePath/);
  const collectorIndex = source.indexOf("installRepairHandoffCollector");
  const createIndex = source.indexOf("fillTextareaAndClickCreate(liveCdp");
  const failureIndex = source.indexOf("waitForInitialCodexFailure");
  const repairIndex = source.indexOf("submitRepairThroughUi(liveCdp");
  assert.ok(collectorIndex >= 0 && createIndex > collectorIndex);
  assert.ok(failureIndex > createIndex && repairIndex > failureIndex);
  assert.match(source, /mockFallback\s*!==\s*false/);
  const waitSource = source.slice(
    source.indexOf("async function waitForRepairChain"),
    source.indexOf("async function readAuthoritativeState"),
  );
  assert.doesNotMatch(waitSource, /getProjection/);
  assert.doesNotMatch(source, /class CdpClient|createConnection\(|WebSocket Protocol/);
});

test("disposable failure project contains no pre-created SkyTurn authority", async () => {
  assert.equal(typeof acceptance.createDisposableFailureProject, "function");
  const projectRoot = await realpath(await mkdtemp(join(tmpdir(), "skyturn-failure-project-test-")));
  try {
    const fixture = await acceptance.createDisposableFailureProject(projectRoot);

    assert.notEqual(fixture.initialTestExitCode, 0);
    assert.deepEqual(fixture.initialDirtyFiles, [failureRepairRegressionFixture.answerFile]);
    assert.equal(
      await readFile(join(projectRoot, failureRepairRegressionFixture.answerFile), "utf8"),
      failureRepairRegressionFixture.brokenAnswerSource,
    );
    await assert.rejects(access(join(projectRoot, ".devflow")), { code: "ENOENT" });
  } finally {
    await rm(projectRoot, { recursive: true, force: true });
  }
});

test("failure repair acceptance reports the first different event and exact field values", () => {
  const live = {
    canvasSession: { id: "session", nodes: [{ id: "repair", status: "completed" }] },
    projection: {
      events: [
        { seq: 1, kind: "workflow.lane.declared", idempotencyKey: "lane:declared", payload: { laneId: "repair" } },
        { seq: 2, kind: "workflow.segment.finished", idempotencyKey: "segment:finished", payload: { status: "succeeded" } },
      ],
    },
  };
  const reopened = structuredClone(live);
  reopened.canvasSession.nodes[0].status = "running";
  reopened.projection.events[1].payload.status = "failed";

  const difference = authoritativeStateDifference(live, reopened);

  assert.deepEqual(difference.firstDifferentEvent, {
    index: 1,
    liveSequence: 2,
    reopenedSequence: 2,
    liveKind: "workflow.segment.finished",
    reopenedKind: "workflow.segment.finished",
    liveIdempotencyKey: "segment:finished",
    reopenedIdempotencyKey: "segment:finished",
    differingFields: [{
      path: "$.payload.status",
      liveValue: "succeeded",
      reopenedValue: "failed",
    }],
  });
  assert.deepEqual(difference.canvasSessionDifferingFields, [{
    path: "$.nodes[0].status",
    liveValue: "completed",
    reopenedValue: "running",
  }]);
  assert.deepEqual(difference.projectionDifferingFields, [{
    path: "$.events[1].payload.status",
    liveValue: "succeeded",
    reopenedValue: "failed",
  }]);
  assert.equal(authoritativeStateDifference(live, structuredClone(live)), null);
});

test("failure repair acceptance observes both automatic handoffs from authoritative broadcasts", () => {
  const result = automaticRepairHandoffState(handoffBroadcasts());

  assert.equal(result.ok, true);
  assert.equal(result.readyForFinalRead, true);
  assert.deepEqual(result.failures, []);
  assert.deepEqual(result.repairHandoff, {
    index: 0,
    laneId: "lane-repair-opaque",
    status: "running",
    cause: "repair-request",
  });
  assert.deepEqual(result.regressionHandoff, {
    index: 1,
    laneId: "lane-regression-opaque",
    status: "running",
    cause: "terminal-reconciliation",
  });
});

for (const [handoff, broadcastIndex, expectedFailure] of [
  ["repair", 0, "repair-handoff-cause:projection-query"],
  ["regression", 1, "regression-handoff-cause:projection-query"],
]) {
  test(`failure repair acceptance rejects projection-query as the ${handoff} handoff cause`, () => {
    const broadcasts = handoffBroadcasts();
    broadcasts[broadcastIndex].cause = "projection-query";

    const result = automaticRepairHandoffState(broadcasts);

    assert.equal(result.ok, false);
    assert.equal(result.readyForFinalRead, false);
    assert.equal(result.failures.includes(expectedFailure), true);
  });
}

test("failure repair acceptance fails closed when the first repair broadcast has no started repair", () => {
  const broadcasts = handoffBroadcasts();
  broadcasts[0].canvasSession.nodes.find((node) => node.id === "lane-repair-opaque").status = "pending";
  broadcasts[0].projection.segments = [];

  const result = automaticRepairHandoffState(broadcasts);

  assert.equal(result.ok, false);
  assert.equal(result.readyForFinalRead, false);
  assert.equal(result.failures.includes("repair-handoff-not-running-or-started"), true);
});

test("failure repair acceptance fails closed when repair terminal broadcast has no started regression", () => {
  const broadcasts = handoffBroadcasts();
  broadcasts[1].canvasSession.nodes.find((node) => node.id === "lane-regression-opaque").status = "pending";
  broadcasts[1].projection.segments = broadcasts[1].projection.segments.filter((segment) =>
    segment.laneId !== "lane-regression-opaque"
  );

  const result = automaticRepairHandoffState(broadcasts);

  assert.equal(result.ok, false);
  assert.equal(result.readyForFinalRead, false);
  assert.equal(
    result.failures.includes("regression-handoff-not-running-or-started-with-repair-terminal"),
    true,
  );
});

test("failure repair acceptance fails closed on duplicate successor broadcasts", () => {
  for (const [sourceLaneId, duplicateLaneId, duplicateRunId, failure] of [
    ["lane-repair-opaque", "lane-repair-duplicate", "run-repair-duplicate", "repair-lane-count:2"],
    ["lane-regression-opaque", "lane-regression-duplicate", "run-regression-duplicate", "regression-lane-count:2"],
  ]) {
    const broadcasts = handoffBroadcasts();
    broadcasts[0].canvasSession.nodes.push({
      ...structuredClone(broadcasts[0].canvasSession.nodes.find((node) => node.id === sourceLaneId)),
      id: duplicateLaneId,
      runId: duplicateRunId,
    });

    const result = automaticRepairHandoffState(broadcasts);

    assert.equal(result.ok, false);
    assert.equal(result.readyForFinalRead, false);
    assert.equal(result.failures.includes(failure), true);
  }
});

test("initial failure oracle requires one real Codex process and exact authoritative identities", () => {
  assert.equal(typeof acceptance.initialCodexFailureState, "function");
  const fixture = initialFailureFixture();

  const result = acceptance.initialCodexFailureState(fixture);

  assert.equal(result.ok, true);
  assert.deepEqual(result.failures, []);
  assert.equal(result.laneId, failureRepairRegressionFixture.failedLaneId);
  assert.equal(result.runId, failureRepairRegressionFixture.failedRunId);
  assert.equal(result.segmentId, failureRepairRegressionFixture.failedSegmentId);
  assert.equal(result.nodeStatus, "failed");
  assert.equal(result.segmentStatus, "failed");
  assert.equal(result.projectionEvidenceStatus, "failed");
  assert.equal(result.status, "failed");
  assert.equal(result.exitCode, 0);
  assert.equal(result.runExitCheck, "passed");
  assert.equal(result.artifactCheck, "failed");
});

test("initial failure oracle rejects prose, missing process start, and identity conflicts", () => {
  assert.equal(typeof acceptance.initialCodexFailureState, "function");
  const missingStart = initialFailureFixture();
  missingStart.runFacts.events = missingStart.runFacts.events.filter((event) => event.kind !== "progress");
  missingStart.session.nodes.find((node) => node.id === failureRepairRegressionFixture.failedLaneId)
    .output = ["Codex ran and failed exactly as requested."];

  const missingStartResult = acceptance.initialCodexFailureState(missingStart);

  assert.equal(missingStartResult.ok, false);
  assert.equal(missingStartResult.failures.includes("codex-process-start-invalid"), true);

  const duplicateSegment = initialFailureFixture();
  duplicateSegment.projection.segments.push(structuredClone(duplicateSegment.projection.segments[0]));
  const duplicateResult = acceptance.initialCodexFailureState(duplicateSegment);
  assert.equal(duplicateResult.ok, false);
  assert.equal(duplicateResult.failures.includes("failure-segment-count:2"), true);

  const mismatchedEvidence = initialFailureFixture();
  mismatchedEvidence.runFacts.evidence = {
    ...mismatchedEvidence.runFacts.evidence,
    runId: "run-conflict",
  };
  const mismatchResult = acceptance.initialCodexFailureState(mismatchedEvidence);
  assert.equal(mismatchResult.ok, false);
  assert.equal(mismatchResult.failures.includes("private-run-evidence-mismatch"), true);

  const mismatchedSession = initialFailureFixture();
  mismatchedSession.runFacts.run.sessionId = "session-conflict";
  const sessionMismatchResult = acceptance.initialCodexFailureState(mismatchedSession);
  assert.equal(sessionMismatchResult.ok, false);
  assert.equal(sessionMismatchResult.failures.includes("agent-run-identity-invalid"), true);

  const nonCanonical = initialFailureFixture();
  const node = nonCanonical.session.nodes.find((candidate) => candidate.id === failureRepairRegressionFixture.failedLaneId);
  const runId = "run-opaque";
  const segmentId = "segment-opaque";
  node.runId = runId;
  nonCanonical.projection.segments[0].runId = runId;
  nonCanonical.projection.segments[0].id = segmentId;
  nonCanonical.projection.evidence[0].segmentId = segmentId;
  nonCanonical.projection.evidence[0].runEvidence.runId = runId;
  nonCanonical.runFacts.run.id = runId;
  nonCanonical.runFacts.events.forEach((event) => { event.runId = runId; });
  nonCanonical.runFacts.evidence.runId = runId;
  const nonCanonicalResult = acceptance.initialCodexFailureState(nonCanonical);
  assert.equal(nonCanonicalResult.ok, false);
  assert.equal(nonCanonicalResult.failures.includes("failure-scheduled-identity-invalid"), true);

  const fabricatedEvidenceEvent = initialFailureFixture();
  const event = fabricatedEvidenceEvent.runFacts.events.find((candidate) => candidate.kind === "evidence");
  event.payload.checks = [{ kind: "run-exit", name: "Fabricated", status: "passed" }];
  event.payload.artifacts = [".devflow/acceptance/fabricated.png"];
  const fabricatedResult = acceptance.initialCodexFailureState(fabricatedEvidenceEvent);
  assert.equal(fabricatedResult.ok, false);
  assert.equal(fabricatedResult.failures.includes("codex-evidence-event-invalid"), true);
});

test("Electron restart validates pure renderer replay before an explicit projection read", async () => {
  const source = await readFile(new URL("failureRepairRegressionAcceptance.mjs", import.meta.url), "utf8");
  const staleIndex = source.indexOf("await overwriteWorkspaceSessionWithStaleClone");
  const relaunchIndex = source.indexOf("app = await launchElectronAcceptanceApp", staleIndex);
  const rendererIndex = source.indexOf("await readRendererReplayState", relaunchIndex);
  const projectionIndex = source.indexOf("await readAuthoritativeState", rendererIndex);
  assert.ok(staleIndex >= 0 && relaunchIndex > staleIndex);
  assert.ok(rendererIndex > relaunchIndex && projectionIndex > rendererIndex);

  const readerStart = source.indexOf("async function readRendererReplayState");
  const readerEnd = source.indexOf("async function readActiveRunIds", readerStart);
  const reader = source.slice(readerStart, readerEnd);
  assert.doesNotMatch(reader, /window\.devflow|getProjection|getWorkflowProjection/);
  assert.match(reader, /\.react-flow__node\[data-id\]/);
  assert.match(reader, /\.react-flow__edge\[data-id\]/);
});

test("failure repair acceptance oracle requires the exact failed to repair to regression chain", () => {
  const fixture = completedFixture();
  const result = failureRepairRegressionSummary(fixture);

  assert.equal(result.ok, true);
  assert.deepEqual(result.failures, []);
  assert.equal(result.runs.repair.artifactCheck, "passed");
  assert.deepEqual(
    fixture.projection.evidence.find((evidence) => evidence.laneId === "lane-repair-opaque").runEvidence.artifacts,
    [failureRepairRegressionFixture.expectedArtifact],
  );
  assert.deepEqual(result.chain, {
    failedLaneId: failureRepairRegressionFixture.failedLaneId,
    repairLaneId: "lane-repair-opaque",
    regressionLaneId: "lane-regression-opaque",
  });
  const chain = repairChainTerminalState(fixture.session);
  assert.equal(chain.completed, true);
  assert.equal(chain.terminalFailure, null);
});

test("failure repair acceptance oracle requires the original failed RunEvidence and private run facts", () => {
  const fixture = completedFixture();

  assert.equal(failureRepairRegressionSummary(fixture).ok, true);

  fixture.projection.evidence = fixture.projection.evidence.filter((candidate) =>
    candidate.laneId !== failureRepairRegressionFixture.failedLaneId
  );
  const result = failureRepairRegressionSummary(fixture);
  assert.equal(result.ok, false);
  assert.equal(result.failures.includes("failure-run-evidence-invalid"), true);
});

test("failure repair acceptance oracle rejects duplicates, weak evidence, test tampering, and moved HEAD", () => {
  const fixture = completedFixture();
  fixture.session.nodes.push({
    ...structuredClone(fixture.session.nodes[1]),
    id: "lane-repair-duplicate",
    runId: "run-repair-duplicate",
  });
  fixture.projection.evidence.find((evidence) => evidence.laneId === "lane-regression-opaque").runEvidence.status = "failed";
  fixture.currentHead = "b".repeat(40);
  fixture.testHashUnchanged = false;
  fixture.gitStatusFiles = ["answer.js", "answer.test.js"];

  const result = failureRepairRegressionSummary(fixture);

  assert.equal(result.ok, false);
  assert.equal(result.failures.includes("repair-lane-count:2"), true);
  assert.equal(result.failures.includes("regression-run-evidence-invalid"), true);
  assert.equal(result.failures.includes("head-moved"), true);
  assert.equal(result.failures.includes("test-file-changed"), true);
  assert.equal(result.failures.includes("git-state-not-clean"), true);
});

test("failure repair acceptance requires exact successful Codex CLI exit evidence", () => {
  const evidence = runEvidence("run-codex", "succeeded", 0);

  assert.equal(hasSuccessfulCodexCliExitEvidence("run-codex", evidence), true);
  assert.equal(hasSuccessfulCodexCliExitEvidence("another-run", evidence), false);
  assert.equal(hasSuccessfulCodexCliExitEvidence("run-codex", { ...evidence, status: "failed" }), false);
  assert.equal(hasSuccessfulCodexCliExitEvidence("run-codex", { ...evidence, exitCode: 1 }), false);
  assert.equal(hasSuccessfulCodexCliExitEvidence("run-codex", {
    ...evidence,
    checks: [...evidence.checks, structuredClone(evidence.checks[0])],
  }), false);
});

test("failure repair acceptance requires exact failed Codex CLI exit and artifact evidence", () => {
  const evidence = failedArtifactEvidence("run-codex-failed");

  assert.equal(acceptance.hasFailedCodexCliExitEvidence("run-codex-failed", evidence), true);
  assert.equal(acceptance.hasFailedCodexCliExitEvidence("run-codex-failed", {
    ...evidence,
    checks: [...evidence.checks, structuredClone(evidence.checks[1])],
  }), false);
});

for (const [name, mutateEvidence] of [
  ["nonzero exit without an artifact check", (evidence) => {
    evidence.exitCode = 1;
    evidence.checks = [{ ...evidence.checks[0], status: "failed", detail: "exit 1" }];
  }],
  ["nonzero exit with a failed artifact check", (evidence) => {
    evidence.exitCode = 1;
    evidence.checks[0] = { ...evidence.checks[0], status: "failed", detail: "exit 1" };
  }],
  ["exit zero without an artifact check", (evidence) => {
    evidence.checks = [evidence.checks[0]];
  }],
  ["a wrongly named run-exit check", (evidence) => {
    evidence.checks[0] = { ...evidence.checks[0], name: "Codex process exit" };
  }],
  ["a failed run-exit check", (evidence) => {
    evidence.checks[0] = { ...evidence.checks[0], status: "failed" };
  }],
  ["a wrongly named artifact check", (evidence) => {
    evidence.checks[1] = { ...evidence.checks[1], name: "Browser artifact" };
  }],
  ["a passed artifact check", (evidence) => {
    evidence.checks[1] = { ...evidence.checks[1], status: "passed" };
  }],
  ["duplicate run-exit checks", (evidence) => {
    evidence.checks.splice(1, 0, structuredClone(evidence.checks[0]));
  }],
  ["a published expected artifact", (evidence) => {
    evidence.artifacts = [failureRepairRegressionFixture.expectedArtifact];
  }],
]) {
  test(`initial failure oracle fails closed for ${name}`, () => {
    const fixture = initialFailureFixture();
    const evidence = structuredClone(fixture.runFacts.evidence);
    mutateEvidence(evidence);
    fixture.projection.segments[0].exitCode = evidence.exitCode;
    fixture.projection.evidence[0].runEvidence = structuredClone(evidence);
    fixture.runFacts.run.status = evidence.status;
    fixture.runFacts.evidence = structuredClone(evidence);
    const evidenceEvent = fixture.runFacts.events.find((event) => event.kind === "evidence");
    evidenceEvent.payload = {
      exitCode: evidence.exitCode,
      checks: structuredClone(evidence.checks),
      artifacts: structuredClone(evidence.artifacts),
    };
    const statusEvent = fixture.runFacts.events.find((event) => event.kind === "status");
    statusEvent.payload = { status: evidence.status, exitCode: evidence.exitCode };

    const result = acceptance.initialCodexFailureState(fixture);

    assert.equal(result.ok, false);
    assert.equal(result.failures.includes("failure-run-evidence-invalid"), true);
  });
}

for (const [name, mutateChecks] of [
  ["missing", () => []],
  ["failed", (checks) => [{ ...checks[0], status: "failed" }]],
  ["wrong-name", (checks) => [{ ...checks[0], name: "Node test passed" }]],
]) {
  test(`failure repair acceptance fails closed for ${name} Codex CLI exit checks despite success prose`, () => {
    const fixture = completedFixture();
    const repair = fixture.session.nodes.find((node) => node.id === "lane-repair-opaque");
    repair.output = ["Ran node --test; all tests passed successfully."];
    const evidence = fixture.projection.evidence.find((candidate) => candidate.laneId === repair.id).runEvidence;
    evidence.checks = mutateChecks(evidence.checks);

    const result = failureRepairRegressionSummary(fixture);

    assert.equal(result.ok, false);
    assert.equal(result.failures.includes("repair-run-evidence-invalid"), true);
  });
}

test("real-run checkpoint authority requires exact unique Git evidence and refs", () => {
  assert.equal(typeof acceptance.assertRunCheckpointAuthority, "function");
  const projection = seededCheckpointProjection();
  const identity = checkpointIdentity();

  assert.equal(acceptance.assertRunCheckpointAuthority(projection, identity), true);

  const duplicate = structuredClone(projection);
  duplicate.changesetEvidence.push(structuredClone(duplicate.changesetEvidence[0]));
  assert.throws(
    () => acceptance.assertRunCheckpointAuthority(duplicate, identity),
    /before checkpoint changeset evidence is not uniquely valid/,
  );

  const terminalBefore = structuredClone(projection);
  terminalBefore.checkpoints[0].evidenceRefs.push({ kind: "evidence", id: "forged-terminal-evidence" });
  assert.throws(
    () => acceptance.assertRunCheckpointAuthority(terminalBefore, identity),
    /before checkpoint evidence refs are not exact/,
  );

  const missingAfterProof = structuredClone(projection);
  delete missingAfterProof.checkpoints[1].ancestryProof;
  assert.throws(
    () => acceptance.assertRunCheckpointAuthority(missingAfterProof, identity),
    /after checkpoint must carry a canonical ancestry proof/,
  );

  const forgedBeforeProof = structuredClone(projection);
  forgedBeforeProof.checkpoints[0].ancestryProof = "forged-before-proof";
  assert.throws(
    () => acceptance.assertRunCheckpointAuthority(forgedBeforeProof, identity),
    /before checkpoint must not carry an ancestry proof/,
  );

  const wrongNode = structuredClone(projection);
  wrongNode.checkpoints.forEach((checkpoint) => { checkpoint.nodeId = "wrong-node"; });
  assert.throws(
    () => acceptance.assertRunCheckpointAuthority(wrongNode, identity),
    /checkpoint identity mismatch:nodeId/,
  );

  const missingGitIdentity = structuredClone(projection);
  missingGitIdentity.checkpoints.forEach((checkpoint) => {
    delete checkpoint.worktreePath;
    delete checkpoint.branchName;
    delete checkpoint.headCommit;
  });
  assert.throws(
    () => acceptance.assertRunCheckpointAuthority(missingGitIdentity, identity),
    /checkpoint identity mismatch:worktreePath/,
  );

  const wrongWorktreeState = structuredClone(projection);
  wrongWorktreeState.checkpoints[0].worktreeState = "dirty";
  assert.throws(
    () => acceptance.assertRunCheckpointAuthority(wrongWorktreeState, identity),
    /checkpoint identity mismatch:worktreeState/,
  );

  const dirtyWithoutChanges = structuredClone(projection);
  dirtyWithoutChanges.checkpoints[0].worktreeState = "dirty";
  assert.throws(
    () => acceptance.assertRunCheckpointAuthority(dirtyWithoutChanges, {
      ...identity,
      worktreeStates: { before: "dirty", after: "clean" },
      changedFiles: { before: [failureRepairRegressionFixture.answerFile], after: [] },
    }),
    /before checkpoint changeset does not match worktree state/,
  );
});

test("renderer replay oracle compares exact node statuses and edge identities", () => {
  assert.equal(typeof acceptance.rendererReplayDifference, "function");
  const authoritative = completedFixture().session;
  const rendered = {
    nodes: authoritative.nodes.map((node) => ({ id: node.id, status: node.status })),
    edges: authoritative.edges.map((edge) => edge.id),
  };

  assert.equal(acceptance.rendererReplayDifference(authoritative, rendered), null);

  rendered.nodes.find((node) => node.id === "lane-repair-opaque").status = "pending";
  assert.deepEqual(acceptance.rendererReplayDifference(authoritative, rendered), {
    expectedEdges: ["edge-failed-repair", "edge-repair-regression"],
    renderedEdges: ["edge-failed-repair", "edge-repair-regression"],
    expectedNodes: [
      { id: "lane-regression-opaque", status: "completed" },
      { id: "lane-repair-opaque", status: "completed" },
      { id: failureRepairRegressionFixture.failedLaneId, status: "failed" },
    ],
    renderedNodes: [
      { id: "lane-regression-opaque", status: "completed" },
      { id: "lane-repair-opaque", status: "pending" },
      { id: failureRepairRegressionFixture.failedLaneId, status: "failed" },
    ],
  });
});

function seededCheckpointProjection() {
  return checkpointAuthorityForRun(
    failureRepairRegressionFixture.failedLaneId,
    failureRepairRegressionFixture.failedRunId,
    failureRepairRegressionFixture.failedSegmentId,
  );
}

function checkpointIdentity() {
  return {
    sessionId: failureRepairRegressionFixture.sessionId,
    nodeId: failureRepairRegressionFixture.failedLaneId,
    laneId: failureRepairRegressionFixture.failedLaneId,
    runId: failureRepairRegressionFixture.failedRunId,
    segmentId: failureRepairRegressionFixture.failedSegmentId,
    executionTarget: "current_branch",
    worktreePath: "/tmp/fixture-project",
    branchName: "main",
    headCommit: baselineHead,
    worktreeStates: { before: "clean", after: "clean" },
    changedFiles: { before: [], after: [] },
  };
}

function checkpointAuthorityForRun(
  laneId,
  runId,
  segmentId = `segment-${failureRepairRegressionFixture.sessionId}-${laneId}`,
  worktreeStates = { before: "clean", after: "clean" },
  changedFiles = { before: [], after: [] },
) {
  const changesetEvidence = ["before", "after"].map((phase) => ({
    evidenceId: `changeset-evidence:${runId}:${phase}`,
    changesetId: `changeset:${runId}:${phase}`,
    source: "git",
    status: worktreeStates[phase] === "dirty" ? "available" : "empty",
    files: changedFiles[phase],
    diffStat: { added: 0, changed: worktreeStates[phase] === "dirty" ? 1 : 0, deleted: 0 },
    patchPreviewTruncated: false,
    collectedAt: `2026-07-23T00:00:0${phase === "before" ? "3" : "6"}.000Z`,
  }));
  const checkpoints = ["before", "after"].map((phase) => ({
    sessionId: failureRepairRegressionFixture.sessionId,
    nodeId: laneId,
    laneId,
    runId,
    segmentId,
    phase,
    executionTarget: "current_branch",
    worktreePath: "/tmp/fixture-project",
    branchName: "main",
    headCommit: baselineHead,
    worktreeState: worktreeStates[phase],
    ...(phase === "after" ? { ancestryProof: "canonical-after-proof" } : {}),
    evidenceRefs: [
      { kind: "run", id: runId },
      { kind: "segment", id: segmentId },
      { kind: "changeset", id: `changeset-evidence:${runId}:${phase}` },
      ...(phase === "after" ? [{ kind: "evidence", id: `evidence-${segmentId}` }] : []),
    ],
  }));
  return { changesetEvidence, checkpoints };
}

function completedFixture() {
  const repair = successorNode({
    id: "lane-repair-opaque",
    runId: `run-${failureRepairRegressionFixture.sessionId}-lane-repair-opaque`,
    semanticSubtype: "repair",
    dependencies: [failureRepairRegressionFixture.failedLaneId],
    output: ["Ran node --test; passed 1 test."],
  });
  const regression = successorNode({
    id: "lane-regression-opaque",
    runId: `run-${failureRepairRegressionFixture.sessionId}-lane-regression-opaque`,
    semanticSubtype: "regression_check",
    dependencies: [repair.id],
    output: ["node --test passed successfully."],
  });
  const session = {
    id: failureRepairRegressionFixture.sessionId,
    kind: "canvas",
    target: { executionTarget: "current_branch", selectedBranch: "main" },
    nodes: [
      {
        id: failureRepairRegressionFixture.failedLaneId,
        runId: failureRepairRegressionFixture.failedRunId,
        status: "failed",
        semanticSubtype: "validation",
        context: { dependencies: [] },
      },
      repair,
      regression,
    ],
    edges: [
      { id: "edge-failed-repair", source: failureRepairRegressionFixture.failedLaneId, target: repair.id },
      { id: "edge-repair-regression", source: repair.id, target: regression.id },
    ],
  };
  const projection = {
    segments: [
      {
        id: failureRepairRegressionFixture.failedSegmentId,
        laneId: failureRepairRegressionFixture.failedLaneId,
        runId: failureRepairRegressionFixture.failedRunId,
        status: "failed",
        exitCode: 0,
      },
      segment(repair.id, repair.runId),
      segment(regression.id, regression.runId),
    ],
    evidence: [
      {
        id: `evidence-${failureRepairRegressionFixture.failedSegmentId}`,
        laneId: failureRepairRegressionFixture.failedLaneId,
        segmentId: failureRepairRegressionFixture.failedSegmentId,
        status: "failed",
        runEvidence: failedArtifactEvidence(failureRepairRegressionFixture.failedRunId),
      },
      projectedEvidence(repair.id, repair.runId, true),
      projectedEvidence(regression.id, regression.runId),
    ],
    changesetEvidence: [],
    checkpoints: [],
  };
  for (const node of session.nodes) {
    const worktreeStates = node.id === failureRepairRegressionFixture.failedLaneId
      ? { before: "dirty", after: "dirty" }
      : node.semanticSubtype === "repair"
        ? { before: "dirty", after: "clean" }
        : { before: "clean", after: "clean" };
    const changedFiles = node.id === failureRepairRegressionFixture.failedLaneId
      ? {
          before: [failureRepairRegressionFixture.answerFile],
          after: [failureRepairRegressionFixture.answerFile],
        }
      : node.semanticSubtype === "repair"
        ? { before: [failureRepairRegressionFixture.answerFile], after: [] }
        : { before: [], after: [] };
    const authority = checkpointAuthorityForRun(
      node.id,
      node.runId,
      node.id === failureRepairRegressionFixture.failedLaneId
        ? failureRepairRegressionFixture.failedSegmentId
        : `segment-${failureRepairRegressionFixture.sessionId}-${node.id}`,
      worktreeStates,
      changedFiles,
    );
    projection.changesetEvidence.push(...authority.changesetEvidence);
    projection.checkpoints.push(...authority.checkpoints);
  }
  const fixture = {
    session,
    projection,
    projectRoot: "/tmp/fixture-project",
    baselineHead,
    currentHead: baselineHead,
    answerSource: failureRepairRegressionFixture.expectedAnswerSource,
    testHashUnchanged: true,
    gitStatusFiles: [],
    verificationExitCode: 0,
    artifactSha256: failureRepairRegressionFixture.expectedArtifactSha256,
    artifactByteLength: failureRepairRegressionFixture.expectedArtifactByteLength,
  };
  fixture.runFacts = runFactsForCompletedFixture(fixture);
  return fixture;
}

function handoffBroadcasts() {
  const completed = completedFixture();
  const repairRunning = structuredClone(completed);
  repairRunning.session.nodes.find((node) => node.id === "lane-repair-opaque").status = "running";
  repairRunning.session.nodes.find((node) => node.id === "lane-regression-opaque").status = "pending";
  repairRunning.projection.segments = repairRunning.projection.segments
    .filter((segment) => segment.laneId === "lane-repair-opaque")
    .map((segment) => ({ ...segment, status: "running" }));
  repairRunning.projection.evidence = [];

  const regressionRunning = structuredClone(completed);
  regressionRunning.session.nodes.find((node) => node.id === "lane-regression-opaque").status = "running";
  regressionRunning.projection.segments = regressionRunning.projection.segments.map((segment) => ({
    ...segment,
    status: segment.laneId === "lane-regression-opaque" ? "running" : "succeeded",
  }));
  regressionRunning.projection.evidence = regressionRunning.projection.evidence.filter((evidence) =>
    evidence.laneId === "lane-repair-opaque"
  );

  return [repairRunning, regressionRunning, completed].map(({ session, projection }, index) => ({
    projectRoot: "/tmp/fixture-project",
    sessionId: failureRepairRegressionFixture.sessionId,
    cause: index === 0 ? "repair-request" : "terminal-reconciliation",
    canvasSession: session,
    projection,
  }));
}

function successorNode({ id, runId, semanticSubtype, dependencies, output }) {
  return {
    id,
    runId,
    status: "completed",
    semanticSubtype,
    requiredEvidence: semanticSubtype === "repair" ? ["browser", "screenshot"] : ["test"],
    context: {
      dependencies,
      brief: `Acceptance successor: ${failureRepairRegressionFixture.repairInstruction}`,
    },
    runtimePolicy: {
      trusted: true,
      source: "workflow_projection",
      sandbox: semanticSubtype === "repair" ? "workspace-write" : "read-only",
    },
    output,
  };
}

function segment(laneId, runId) {
  return {
    id: `segment-${failureRepairRegressionFixture.sessionId}-${laneId}`,
    laneId,
    runId,
    status: "succeeded",
    exitCode: 0,
  };
}

function projectedEvidence(laneId, runId, artifactRequired = false) {
  const evidence = runEvidence(runId, "succeeded", 0);
  if (artifactRequired) {
    evidence.checks.push({
      kind: "artifact",
      name: "Expected artifacts",
      status: "passed",
      detail: "verified=1 missing=0 empty=0 unsafe=0",
    });
    evidence.artifacts = [failureRepairRegressionFixture.expectedArtifact];
  }
  return {
    id: `evidence-segment-${failureRepairRegressionFixture.sessionId}-${laneId}`,
    laneId,
    segmentId: `segment-${failureRepairRegressionFixture.sessionId}-${laneId}`,
    status: "passed",
    runEvidence: evidence,
  };
}

function runEvidence(runId, status, exitCode) {
  return {
    runId,
    status,
    exitCode,
    changesetId: null,
    checks: [{ kind: "run-exit", name: "Codex CLI exit", status: status === "succeeded" ? "passed" : "failed" }],
    artifacts: [],
    review: null,
    errorReason: status === "succeeded" ? null : "failed",
    cancelReason: null,
    completedAt: "2026-07-23T00:00:10.000Z",
  };
}

function initialFailureFixture() {
  const failedEvidence = failedArtifactEvidence(failureRepairRegressionFixture.failedRunId);
  const failedNode = {
    id: failureRepairRegressionFixture.failedLaneId,
    runId: failureRepairRegressionFixture.failedRunId,
    agent: "codex",
    laneKind: "validation",
    semanticSubtype: "validation",
    status: "failed",
    requiredEvidence: ["browser", "screenshot"],
    runtimePolicy: {
      trusted: true,
      source: "workflow_projection",
      executable: true,
      sandbox: "read-only",
    },
    context: { dependencies: [], brief: "Run node --test without modifying files." },
    output: [],
  };
  const session = {
    id: failureRepairRegressionFixture.sessionId,
    projectId: failureRepairRegressionFixture.projectId,
    kind: "canvas",
    plannerNodeId: "lane-planner",
    nodes: [
      {
        id: "lane-planner",
        runId: "run-planner",
        agent: "hermes",
        laneKind: "planner",
        status: "completed",
        context: { dependencies: [] },
      },
      failedNode,
    ],
    edges: [],
  };
  const segment = {
    id: failureRepairRegressionFixture.failedSegmentId,
    laneId: failedNode.id,
    runId: failedNode.runId,
    status: "failed",
    exitCode: 0,
  };
  const evidence = {
    id: `evidence-${segment.id}`,
    laneId: failedNode.id,
    segmentId: segment.id,
    kind: "run-exit",
    status: "failed",
    checks: ["run-exit:Codex CLI exit:passed", "artifact:Expected artifacts:failed"],
    artifacts: [],
    runEvidence: failedEvidence,
  };
  return {
    session,
    projection: { segments: [segment], evidence: [evidence] },
    runFacts: runFacts(failedNode, failedEvidence),
  };
}

function addInitialFailureAuthority(fixture) {
  const initial = initialFailureFixture();
  fixture.projection.segments.unshift(initial.projection.segments[0]);
  fixture.projection.evidence.unshift(initial.projection.evidence[0]);
}

function runFactsForCompletedFixture(fixture) {
  return Object.fromEntries(fixture.session.nodes
    .filter((node) => typeof node.runId === "string")
    .map((node) => {
      const evidence = structuredClone(fixture.projection.evidence.find((candidate) =>
        candidate.laneId === node.id
      ).runEvidence);
      return [node.runId, runFacts(node, evidence)];
    }));
}

function runFacts(node, evidence) {
  return {
    run: {
      id: node.runId,
      nodeId: node.id,
      sessionId: failureRepairRegressionFixture.sessionId,
      agentKind: "codex",
      status: evidence.status,
    },
    events: [
      {
        runId: node.runId,
        kind: "progress",
        payload: { source: "codex", phase: "started", command: "codex exec" },
      },
      {
        runId: node.runId,
        kind: "evidence",
        payload: { exitCode: evidence.exitCode, checks: evidence.checks, artifacts: evidence.artifacts },
      },
      {
        runId: node.runId,
        kind: "status",
        payload: { status: evidence.status, exitCode: evidence.exitCode },
      },
    ],
    evidence,
  };
}

function failedArtifactEvidence(runId) {
  return {
    runId,
    status: "failed",
    exitCode: 0,
    changesetId: null,
    checks: [
      { kind: "run-exit", name: "Codex CLI exit", status: "passed", detail: "exit 0" },
      { kind: "artifact", name: "Expected artifacts", status: "failed", detail: "verified=0 missing=1 empty=0 unsafe=0" },
    ],
    artifacts: [],
    review: null,
    errorReason: null,
    cancelReason: null,
    completedAt: "2026-07-23T00:00:10.000Z",
  };
}
