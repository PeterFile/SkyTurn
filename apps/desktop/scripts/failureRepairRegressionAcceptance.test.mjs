import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import {
  assertSeededCheckpointAuthority,
  automaticRepairHandoffState,
  createSeedWorkspaceState,
  failureRepairRegressionFixture,
  failureRepairRegressionSummary,
  hasSuccessfulCodexCliExitEvidence,
  repairChainTerminalState,
} from "./failureRepairRegressionAcceptance.mjs";

const baselineHead = "a".repeat(40);

test("failure repair acceptance reuses the shared Electron and CDP lifecycle", async () => {
  const source = await readFile(new URL("failureRepairRegressionAcceptance.mjs", import.meta.url), "utf8");

  assert.match(source, /launchElectronAcceptanceApp/);
  assert.match(source, /connectToReadySkyTurnRenderer/);
  assert.match(source, /waitForStoredProjectRegistration/);
  assert.match(source, /finalizeAcceptanceOutcome/);
  assert.match(source, /ELECTRON_RUN_AS_NODE:\s*"1"/);
  assert.match(source, /import\("@skyturn\/persistence\/workflow-store"\)/);
  assert.match(source, /\.react-flow__node\[data-id=.*\.agent-card-select/);
  assert.match(source, /projectRoot = await realpath\(await mkdtemp/);
  assert.match(source, /window\.devflow\.onWorkflowEvent/);
  assert.match(source, /collector\.unsubscribe\(\)/);
  assert.ok(source.indexOf("installRepairHandoffCollector") < source.indexOf("submitRepairThroughUi(liveCdp)"));
  const waitSource = source.slice(
    source.indexOf("async function waitForRepairChain"),
    source.indexOf("async function readAuthoritativeState"),
  );
  assert.doesNotMatch(waitSource, /getProjection/);
  assert.doesNotMatch(source, /class CdpClient|createConnection\(|WebSocket Protocol/);
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

test("failure repair acceptance workspace seeds one authoritative failed run", () => {
  const failedEvidence = runEvidence(failureRepairRegressionFixture.failedRunId, "failed", 1);
  const canvasSession = {
    id: failureRepairRegressionFixture.sessionId,
    projectId: failureRepairRegressionFixture.projectId,
    kind: "canvas",
    nodes: [{ id: failureRepairRegressionFixture.failedLaneId, status: "failed" }],
    edges: [],
  };
  const workspace = createSeedWorkspaceState({
    projectRoot: "/tmp/fixture-project",
    canvasSession,
    failedEvidence,
    openedAt: "2026-07-23T00:00:00.000Z",
  });

  assert.equal(workspace.projects.length, 1);
  assert.equal(workspace.projects[0].rootPath, "/tmp/fixture-project");
  assert.equal(workspace.activeProjectId, failureRepairRegressionFixture.projectId);
  assert.equal(workspace.activeSessionId, failureRepairRegressionFixture.sessionId);
  assert.deepEqual(workspace.sessions, [canvasSession]);
  assert.deepEqual(Object.keys(workspace.runs), [failureRepairRegressionFixture.failedRunId]);
  assert.equal(workspace.runs[failureRepairRegressionFixture.failedRunId].status, "failed");
  assert.equal(workspace.runEvidence[failureRepairRegressionFixture.failedRunId], failedEvidence);
  assert.deepEqual(workspace.runEvents[failureRepairRegressionFixture.failedRunId], []);
});

test("failure repair acceptance oracle requires the exact failed to repair to regression chain", () => {
  const fixture = completedFixture();
  const result = failureRepairRegressionSummary(fixture);

  assert.equal(result.ok, true);
  assert.deepEqual(result.failures, []);
  assert.deepEqual(result.chain, {
    failedLaneId: failureRepairRegressionFixture.failedLaneId,
    repairLaneId: "lane-repair-opaque",
    regressionLaneId: "lane-regression-opaque",
  });
  const chain = repairChainTerminalState(fixture.session);
  assert.equal(chain.completed, true);
  assert.equal(chain.terminalFailure, null);
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
  assert.equal(result.failures.includes("git-dirty-files-invalid"), true);
});

test("failure repair acceptance requires exact successful Codex CLI exit evidence", () => {
  const evidence = runEvidence("run-codex", "succeeded", 0);

  assert.equal(hasSuccessfulCodexCliExitEvidence("run-codex", evidence), true);
  assert.equal(hasSuccessfulCodexCliExitEvidence("another-run", evidence), false);
  assert.equal(hasSuccessfulCodexCliExitEvidence("run-codex", { ...evidence, status: "failed" }), false);
  assert.equal(hasSuccessfulCodexCliExitEvidence("run-codex", { ...evidence, exitCode: 1 }), false);
});

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

test("seeded checkpoint authority requires exact unique empty Git evidence and refs", () => {
  const projection = seededCheckpointProjection();

  assert.equal(assertSeededCheckpointAuthority(projection), true);

  const duplicate = structuredClone(projection);
  duplicate.changesetEvidence.push(structuredClone(duplicate.changesetEvidence[0]));
  assert.throws(
    () => assertSeededCheckpointAuthority(duplicate),
    /before checkpoint changeset evidence is not uniquely valid/,
  );

  const terminalBefore = structuredClone(projection);
  terminalBefore.checkpoints[0].evidenceRefs.push({ kind: "evidence", id: "forged-terminal-evidence" });
  assert.throws(
    () => assertSeededCheckpointAuthority(terminalBefore),
    /before checkpoint evidence refs are not exact/,
  );
});

function seededCheckpointProjection() {
  const runId = failureRepairRegressionFixture.failedRunId;
  const segmentId = failureRepairRegressionFixture.failedSegmentId;
  const changesetEvidence = ["before", "after"].map((phase) => ({
    evidenceId: `changeset-evidence:${runId}:${phase}`,
    changesetId: `changeset:${runId}:${phase}`,
    source: "git",
    status: "empty",
    files: [],
    diffStat: { added: 0, changed: 0, deleted: 0 },
    patchPreviewTruncated: false,
    collectedAt: `2026-07-23T00:00:0${phase === "before" ? "3" : "6"}.000Z`,
  }));
  const checkpoints = ["before", "after"].map((phase) => ({
    runId,
    segmentId,
    phase,
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
    runId: "run-repair-opaque",
    semanticSubtype: "repair",
    dependencies: [failureRepairRegressionFixture.failedLaneId],
    output: ["Ran node --test; passed 1 test."],
  });
  const regression = successorNode({
    id: "lane-regression-opaque",
    runId: "run-regression-opaque",
    semanticSubtype: "regression_check",
    dependencies: [repair.id],
    output: ["node --test passed successfully."],
  });
  const session = {
    id: failureRepairRegressionFixture.sessionId,
    kind: "canvas",
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
      segment(repair.id, repair.runId),
      segment(regression.id, regression.runId),
    ],
    evidence: [
      projectedEvidence(repair.id, repair.runId),
      projectedEvidence(regression.id, regression.runId),
    ],
  };
  return {
    session,
    projection,
    baselineHead,
    currentHead: baselineHead,
    answerSource: "export const answer = 42;\n",
    testHashUnchanged: true,
    gitStatusFiles: ["answer.js"],
    verificationExitCode: 0,
  };
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
  return { id: `segment-${runId}`, laneId, runId, status: "succeeded", exitCode: 0 };
}

function projectedEvidence(laneId, runId) {
  return {
    id: `evidence-${runId}`,
    laneId,
    segmentId: `segment-${runId}`,
    status: "passed",
    runEvidence: runEvidence(runId, "succeeded", 0),
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
