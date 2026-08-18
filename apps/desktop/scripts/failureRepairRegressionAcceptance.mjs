import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { createRequire } from "node:module";
import { mkdir, mkdtemp, readFile, realpath, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import {
  connectToReadySkyTurnRenderer,
  fillTextareaAndClickCreate,
  finalizeAcceptanceOutcome,
  launchElectronAcceptanceApp,
  openProjectThroughUi,
  overwriteWorkspaceSessionWithStaleClone,
  waitForStoredProjectRegistration,
} from "./newSessionUiAcceptance.mjs";

const require = createRequire(import.meta.url);
const scriptPath = fileURLToPath(import.meta.url);
const waitTimeoutMs = Number(process.env.SKYTURN_FAILURE_REPAIR_WAIT_TIMEOUT_MS ?? 20 * 60 * 1_000);
const pollIntervalMs = Number(process.env.SKYTURN_FAILURE_REPAIR_POLL_MS ?? 2_000);
const diagnosticLimitBytes = Number(process.env.SKYTURN_FAILURE_REPAIR_DIAGNOSTIC_LIMIT_BYTES ?? 4_096);
const resultLimitBytes = 8_192;
const inspectResultPrefix = "SKYTURN_FAILURE_REPAIR_INSPECT=";
const handoffCollectorKey = "__skyturnFailureRepairHandoffCollector";
const handoffCollectorLimit = 256;
const terminalRunStatuses = new Set(["succeeded", "failed", "cancelled", "timed-out"]);
const expectedArtifactBytes = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=",
  "base64",
);

export const failureRepairRegressionFixture = Object.freeze({
  projectId: "project-failure-repair-regression",
  sessionId: "session-failure-repair-regression",
  failedLaneId: "lane-validation-failed",
  failedRunId: "run-session-failure-repair-regression-lane-validation-failed",
  failedSegmentId: "segment-session-failure-repair-regression-lane-validation-failed",
  answerFile: "answer.js",
  testFile: "test/answer.test.js",
  repairScript: "scripts/repair-fixture.mjs",
  expectedArtifact: ".devflow/acceptance/react-app.png",
  expectedAnswerSource: "export const answer = 42;\n",
  brokenAnswerSource: "export const answer = 41;\n",
  expectedArtifactByteLength: expectedArtifactBytes.byteLength,
  expectedArtifactSha256: createHash("sha256").update(expectedArtifactBytes).digest("hex"),
  repairInstruction: [
    "Run `node scripts/repair-fixture.mjs`, then run `node --test`.",
    "Do not modify any other tracked file and do not create a commit.",
  ].join(" "),
  sessionGoal: [
    "Create exactly one executable non-planner lane and no other lane or user decision.",
    "Use a Codex validation lane with no dependencies, title `Verify deterministic acceptance gate`,",
    "semanticSubtype `validation`, and requiredEvidence exactly [`browser`, `screenshot`].",
    "Its brief must tell Codex to run `node --test`, report the exact result, and not create or modify any file.",
    "Do not create implementation, review, commit, planning, scope, intake, or follow-up lanes.",
  ].join(" "),
});

export function repairChainTerminalState(session, failedLaneId = failureRepairRegressionFixture.failedLaneId) {
  const nodes = Array.isArray(session?.nodes) ? session.nodes : [];
  const failed = nodes.filter((node) => node?.id === failedLaneId);
  const repairs = nodes.filter((node) => node?.semanticSubtype === "repair");
  const regressions = nodes.filter((node) => node?.semanticSubtype === "regression_check");
  const repair = repairs[0] ?? null;
  const regression = regressions[0] ?? null;
  const failures = [];
  if (failed.length !== 1 || failed[0]?.status !== "failed") failures.push("original-lane-not-preserved-failed");
  if (repairs.length !== 1) failures.push(`repair-lane-count:${repairs.length}`);
  if (regressions.length !== 1) failures.push(`regression-lane-count:${regressions.length}`);
  if (repair && !exactStringArray(repair.context?.dependencies, [failedLaneId])) {
    failures.push("repair-dependency-invalid");
  }
  if (regression && !exactStringArray(regression.context?.dependencies, [repair?.id])) {
    failures.push("regression-dependency-invalid");
  }
  if (repair && repair.runtimePolicy?.sandbox !== "workspace-write") failures.push("repair-sandbox-invalid");
  if (regression && regression.runtimePolicy?.sandbox !== "read-only") failures.push("regression-sandbox-invalid");
  if (repair && !exactStringArray(repair.requiredEvidence, ["browser", "screenshot"])) {
    failures.push("repair-required-evidence-invalid");
  }
  if (regression && !exactStringArray(regression.requiredEvidence, ["test"])) {
    failures.push("regression-required-evidence-invalid");
  }
  if (repair && !repair.context?.brief?.includes(failureRepairRegressionFixture.repairInstruction)) {
    failures.push("repair-instruction-missing");
  }
  if (regression && !regression.context?.brief?.includes(failureRepairRegressionFixture.repairInstruction)) {
    failures.push("regression-instruction-missing");
  }
  const edges = Array.isArray(session?.edges) ? session.edges : [];
  if (repair && edges.filter((edge) => edge?.source === failedLaneId && edge?.target === repair.id).length !== 1) {
    failures.push("failed-repair-edge-invalid");
  }
  if (repair && regression && edges.filter((edge) => edge?.source === repair.id && edge?.target === regression.id).length !== 1) {
    failures.push("repair-regression-edge-invalid");
  }
  const terminalFailure = [repair, regression].find((node) =>
    node && ["failed", "cancelled", "timed-out"].includes(node.status)
  ) ?? null;
  const completed = !!repair && !!regression && repair.status === "completed" && regression.status === "completed";
  return { completed, terminalFailure, failures, failed: failed[0] ?? null, repair, regression };
}

export function automaticRepairHandoffState(
  broadcasts,
  failedLaneId = failureRepairRegressionFixture.failedLaneId,
) {
  const failures = [];
  const addFailure = (failure) => {
    if (!failures.includes(failure)) failures.push(failure);
  };
  let repairHandoff = null;
  let regressionHandoff = null;
  let completedBroadcast = null;
  let lastRelevantBroadcast = null;
  for (const [index, broadcast] of (Array.isArray(broadcasts) ? broadcasts : []).entries()) {
    const session = broadcast?.canvasSession;
    const projection = broadcast?.projection;
    const nodes = Array.isArray(session?.nodes) ? session.nodes : [];
    const repairCount = nodes.filter((node) => node?.semanticSubtype === "repair").length;
    const regressionCount = nodes.filter((node) => node?.semanticSubtype === "regression_check").length;
    if (repairCount === 0 && regressionCount === 0) continue;
    lastRelevantBroadcast = { index, session, projection };
    const chain = repairChainTerminalState(session, failedLaneId);
    for (const failure of chain.failures) addFailure(failure);
    if (chain.terminalFailure) addFailure(`successor-terminal-failure:${chain.terminalFailure.id}`);

    if (!repairHandoff) {
      if (chain.repair && hasStartedLaneProjection(chain.repair, projection)) {
        if (broadcast?.cause === "repair-request") {
          repairHandoff = { index, laneId: chain.repair.id, status: chain.repair.status, cause: broadcast.cause };
        } else {
          addFailure(`repair-handoff-cause:${String(broadcast?.cause)}`);
        }
      } else {
        addFailure("repair-handoff-not-running-or-started");
      }
    }

    if (!regressionHandoff && chain.repair && isTerminalNodeStatus(chain.repair.status)) {
      if (chain.repair.status === "completed" && chain.regression && hasStartedLaneProjection(chain.regression, projection)) {
        if (broadcast?.cause === "terminal-reconciliation") {
          regressionHandoff = {
            index,
            laneId: chain.regression.id,
            status: chain.regression.status,
            cause: broadcast.cause,
          };
        } else {
          addFailure(`regression-handoff-cause:${String(broadcast?.cause)}`);
        }
      } else {
        addFailure("regression-handoff-not-running-or-started-with-repair-terminal");
      }
    }
    if (chain.completed) completedBroadcast = { index };
  }
  return {
    ok: failures.length === 0,
    failures,
    repairHandoff,
    regressionHandoff,
    completedBroadcast,
    lastRelevantBroadcast,
    readyForFinalRead: failures.length === 0 &&
      repairHandoff !== null && regressionHandoff !== null && completedBroadcast !== null,
  };
}

function hasStartedLaneProjection(node, projection) {
  if (!node?.id || !node?.runId) return false;
  const expectedSegmentStatus = node.status === "running"
    ? "running"
    : node.status === "completed" ? "succeeded" : null;
  if (!expectedSegmentStatus) return false;
  const segments = (projection?.segments ?? []).filter((segment) =>
    segment?.laneId === node.id && segment?.runId === node.runId
  );
  return segments.length === 1 && segments[0]?.status === expectedSegmentStatus;
}

function isTerminalNodeStatus(status) {
  return ["completed", "failed", "cancelled", "timed-out"].includes(status);
}

export function hasSuccessfulCodexCliExitEvidence(runId, evidence) {
  if (!evidence || evidence.runId !== runId || evidence.status !== "succeeded" || evidence.exitCode !== 0) {
    return false;
  }
  const exits = (evidence.checks ?? []).filter((check) =>
    check?.kind === "run-exit" && check.name === "Codex CLI exit" && check.status === "passed"
  );
  return exits.length === 1;
}

export function hasFailedCodexCliExitEvidence(runId, evidence) {
  if (
    !evidence || evidence.runId !== runId || evidence.status !== "failed" || evidence.exitCode !== 0
  ) return false;
  const checks = Array.isArray(evidence.checks) ? evidence.checks : [];
  const runExit = checks.filter((check) => check?.kind === "run-exit");
  if (
    runExit.length !== 1 || runExit[0]?.name !== "Codex CLI exit" || runExit[0]?.status !== "passed"
  ) return false;
  const artifactChecks = checks.filter((check) => check?.kind === "artifact");
  if (!exactStringArray(evidence.artifacts, [])) return false;
  return artifactChecks.length === 1 && artifactChecks[0]?.name === "Expected artifacts" &&
    artifactChecks[0]?.status === "failed";
}

export function initialCodexFailureState({ session, projection, runFacts }) {
  const nodes = Array.isArray(session?.nodes) ? session.nodes : [];
  const candidates = nodes.filter((node) =>
    node?.id !== session?.plannerNodeId &&
    node?.semanticSubtype !== "repair" &&
    node?.semanticSubtype !== "regression_check"
  );
  const failures = [];
  if (candidates.length !== 1) failures.push(`initial-codex-lane-count:${candidates.length}`);
  const node = candidates[0] ?? null;
  if (node?.agent !== "codex") failures.push("initial-lane-agent-invalid");
  if (node?.laneKind !== "validation") failures.push("initial-lane-kind-invalid");
  if (!exactStringArray(node?.requiredEvidence, ["browser", "screenshot"])) {
    failures.push("initial-required-evidence-invalid");
  }
  if (!exactStringArray(node?.context?.dependencies, [])) failures.push("initial-dependencies-invalid");
  if (node?.runtimePolicy?.sandbox !== "read-only") failures.push("initial-sandbox-invalid");
  const runState = codexLaneRunState({
    node,
    projection,
    runFacts,
    sessionId: session?.id,
    label: "failure",
    nodeStatus: "failed",
    segmentStatus: "failed",
    evidenceStatus: "failed",
    runStatus: "failed",
  });
  failures.push(...runState.failures);
  return { ...runState, ok: failures.length === 0, failures };
}

function codexLaneRunState({
  node,
  projection,
  runFacts,
  sessionId,
  label,
  nodeStatus,
  segmentStatus,
  evidenceStatus,
  runStatus,
  expectedArtifactStatus = null,
}) {
  const failures = [];
  if (!node?.id || !node?.runId) failures.push(`${label}-node-identity-invalid`);
  if (node?.status !== nodeStatus) failures.push(`${label}-node-status:${String(node?.status)}`);
  const segments = (projection?.segments ?? []).filter((segment) =>
    segment?.laneId === node?.id && segment?.runId === node?.runId
  );
  if (segments.length !== 1) failures.push(`${label}-segment-count:${segments.length}`);
  const segment = segments[0] ?? null;
  const expectedRunId = typeof sessionId === "string" && typeof node?.id === "string"
    ? `run-${sessionId}-${node.id}`
    : null;
  const expectedSegmentId = typeof sessionId === "string" && typeof node?.id === "string"
    ? `segment-${sessionId}-${node.id}`
    : null;
  if (node?.runId !== expectedRunId || segment?.id !== expectedSegmentId) {
    failures.push(`${label}-scheduled-identity-invalid`);
  }
  if (segment && segment.status !== segmentStatus) failures.push(`${label}-segment-status:${String(segment.status)}`);
  const evidenceRecords = (projection?.evidence ?? []).filter((candidate) =>
    candidate?.laneId === node?.id && candidate?.segmentId === segment?.id &&
    candidate?.runEvidence?.runId === node?.runId
  );
  if (evidenceRecords.length !== 1) failures.push(`${label}-run-evidence-invalid`);
  const projectedEvidence = evidenceRecords[0]?.runEvidence ?? null;
  if (evidenceRecords[0] && evidenceRecords[0].status !== evidenceStatus) {
    failures.push(`${label}-projection-evidence-status:${String(evidenceRecords[0].status)}`);
  }
  const privateEvidenceMatches = stableJson(projectedEvidence) === stableJson(runFacts?.evidence);
  if (!privateEvidenceMatches) failures.push("private-run-evidence-mismatch");
  const evidenceValid = runStatus === "succeeded"
    ? hasSuccessfulCodexCliExitEvidence(node?.runId, projectedEvidence)
    : hasFailedCodexCliExitEvidence(node?.runId, projectedEvidence);
  if (!evidenceValid && !failures.includes(`${label}-run-evidence-invalid`)) {
    failures.push(`${label}-run-evidence-invalid`);
  }
  const run = runFacts?.run;
  if (
    run?.id !== node?.runId || run?.nodeId !== node?.id || run?.sessionId !== sessionId ||
    run?.agentKind !== "codex" || run?.status !== runStatus
  ) failures.push("agent-run-identity-invalid");
  const events = Array.isArray(runFacts?.events) ? runFacts.events : [];
  if (events.some((event) => event?.runId !== node?.runId)) failures.push("run-event-identity-invalid");
  const starts = events.filter((event) =>
    event?.kind === "progress" && event.payload?.source === "codex" &&
    event.payload?.phase === "started" && event.payload?.command === "codex exec"
  );
  if (starts.length !== 1) failures.push("codex-process-start-invalid");
  const terminalStatuses = events.filter((event) =>
    event?.kind === "status" && terminalRunStatuses.has(event.payload?.status)
  );
  if (
    terminalStatuses.length !== 1 || terminalStatuses[0]?.payload?.status !== runStatus ||
    terminalStatuses[0]?.payload?.exitCode !== projectedEvidence?.exitCode
  ) failures.push("codex-terminal-event-invalid");
  const evidenceEvents = events.filter((event) => event?.kind === "evidence");
  const evidencePayload = evidenceEvents[0]?.payload;
  if (
    evidenceEvents.length !== 1 || evidencePayload?.exitCode !== projectedEvidence?.exitCode ||
    stableJson(evidencePayload?.checks ?? []) !== stableJson(projectedEvidence?.checks ?? []) ||
    stableJson(evidencePayload?.artifacts ?? []) !== stableJson(projectedEvidence?.artifacts ?? [])
  ) {
    failures.push("codex-evidence-event-invalid");
  }
  const runExit = projectedEvidence?.checks?.find((check) =>
    check?.kind === "run-exit" && check.name === "Codex CLI exit"
  );
  const artifactChecks = projectedEvidence?.checks?.filter((check) =>
    check?.kind === "artifact" && check.name === "Expected artifacts"
  ) ?? [];
  const artifact = artifactChecks[0];
  if (
    expectedArtifactStatus !== null &&
    (artifactChecks.length !== 1 || artifact?.status !== expectedArtifactStatus ||
      !exactStringArray(projectedEvidence?.artifacts, [failureRepairRegressionFixture.expectedArtifact]))
  ) failures.push(`${label}-artifact-evidence-invalid`);
  return {
    ok: failures.length === 0,
    failures,
    laneId: node?.id ?? null,
    segmentId: segment?.id ?? null,
    runId: node?.runId ?? null,
    nodeStatus: node?.status ?? null,
    segmentStatus: segment?.status ?? null,
    projectionEvidenceStatus: evidenceRecords[0]?.status ?? null,
    status: projectedEvidence?.status ?? null,
    exitCode: projectedEvidence?.exitCode ?? null,
    runExitCheck: runExit?.status ?? null,
    artifactCheck: artifact?.status ?? null,
  };
}

export function assertRunCheckpointAuthority(projection, identity) {
  for (const key of [
    "sessionId",
    "nodeId",
    "laneId",
    "runId",
    "segmentId",
    "executionTarget",
    "worktreePath",
    "branchName",
    "headCommit",
  ]) {
    if (typeof identity?.[key] !== "string" || !identity[key]) {
      throw new Error(`checkpoint expected identity is invalid:${key}`);
    }
  }
  if (!/^[0-9a-f]{40}$/.test(identity.headCommit)) {
    throw new Error("checkpoint expected identity is invalid:headCommit");
  }
  if (
    !identity.worktreeStates ||
    !["clean", "dirty"].includes(identity.worktreeStates.before) ||
    !["clean", "dirty"].includes(identity.worktreeStates.after)
  ) throw new Error("checkpoint expected identity is invalid:worktreeState");
  if (
    !identity.changedFiles ||
    !["before", "after"].every((phase) =>
      Array.isArray(identity.changedFiles[phase]) &&
      identity.changedFiles[phase].every((file) => typeof file === "string" && file.length > 0)
    )
  ) throw new Error("checkpoint expected identity is invalid:changedFiles");
  const expectedBaseRefs = [
    { kind: "run", id: identity.runId },
    { kind: "segment", id: identity.segmentId },
  ];
  const pair = [];
  for (const phase of ["before", "after"]) {
    const evidenceId = `changeset-evidence:${identity.runId}:${phase}`;
    const evidenceRecords = (projection?.changesetEvidence ?? []).filter((evidence) => evidence?.evidenceId === evidenceId);
    if (evidenceRecords.length !== 1 || !isGitChangesetEvidence(evidenceRecords[0], evidenceId)) {
      throw new Error(`${phase} checkpoint changeset evidence is not uniquely valid.`);
    }
    const expectedWorktreeState = identity.worktreeStates[phase];
    const expectedFiles = identity.changedFiles[phase];
    const evidenceRecord = evidenceRecords[0];
    const expectedChangesetStatus = expectedWorktreeState === "dirty" ? "available" : "empty";
    const diffCount = evidenceRecord.diffStat.added + evidenceRecord.diffStat.changed + evidenceRecord.diffStat.deleted;
    if (
      evidenceRecord.status !== expectedChangesetStatus ||
      !exactStringArray(evidenceRecord.files, expectedFiles) ||
      (expectedWorktreeState === "dirty" ? diffCount < 1 : diffCount !== 0)
    ) throw new Error(`${phase} checkpoint changeset does not match worktree state.`);
    const checkpoints = (projection?.checkpoints ?? []).filter((checkpoint) =>
      checkpoint?.laneId === identity.laneId && checkpoint?.runId === identity.runId &&
      checkpoint?.segmentId === identity.segmentId && checkpoint?.phase === phase
    );
    const expectedRefs = [
      ...expectedBaseRefs,
      { kind: "changeset", id: evidenceId },
      ...(phase === "after" ? [{ kind: "evidence", id: `evidence-${identity.segmentId}` }] : []),
    ];
    if (checkpoints.length !== 1 || stableJson(checkpoints[0]?.evidenceRefs) !== stableJson(expectedRefs)) {
      throw new Error(`${phase} checkpoint evidence refs are not exact.`);
    }
    for (const key of [
      "sessionId",
      "nodeId",
      "laneId",
      "runId",
      "segmentId",
      "executionTarget",
      "worktreePath",
      "branchName",
      "headCommit",
    ]) {
      if (checkpoints[0]?.[key] !== identity[key]) throw new Error(`checkpoint identity mismatch:${key}`);
    }
    if ((checkpoints[0]?.worktreeId ?? undefined) !== (identity.worktreeId ?? undefined)) {
      throw new Error("checkpoint identity mismatch:worktreeId");
    }
    if (checkpoints[0]?.worktreeState !== identity.worktreeStates[phase]) {
      throw new Error("checkpoint identity mismatch:worktreeState");
    }
    if (phase === "before" && checkpoints[0].ancestryProof !== undefined) {
      throw new Error("before checkpoint must not carry an ancestry proof.");
    }
    if (phase === "after" && (typeof checkpoints[0].ancestryProof !== "string" || !checkpoints[0].ancestryProof)) {
      throw new Error("after checkpoint must carry a canonical ancestry proof.");
    }
    if (phase === "before" && checkpoints[0].evidenceRefs.some((ref) => ref?.kind === "evidence")) {
      throw new Error("before checkpoint must not reference terminal RunEvidence.");
    }
    pair.push(checkpoints[0]);
  }
  for (const key of ["sessionId", "nodeId", "laneId", "runId", "segmentId", "executionTarget", "worktreeId", "worktreePath", "branchName", "headCommit"]) {
    if (pair[0]?.[key] !== pair[1]?.[key]) throw new Error(`checkpoint identity mismatch:${key}`);
  }
  return true;
}

function isGitChangesetEvidence(evidence, expectedEvidenceId) {
  return evidence?.evidenceId === expectedEvidenceId &&
    typeof evidence.changesetId === "string" && evidence.changesetId.length > 0 &&
    evidence.source === "git" && (evidence.status === "available" || evidence.status === "empty") &&
    Array.isArray(evidence.files) && evidence.files.every((file) => typeof file === "string") &&
    ["added", "changed", "deleted"].every((key) => Number.isInteger(evidence.diffStat?.[key]) && evidence.diffStat[key] >= 0) &&
    evidence.patchPreviewTruncated === false && typeof evidence.collectedAt === "string" && evidence.collectedAt.length > 0;
}

export function failureRepairRegressionSummary({
  session,
  projection,
  runFacts = {},
  failedLaneId = failureRepairRegressionFixture.failedLaneId,
  projectRoot,
  baselineHead,
  currentHead,
  answerSource,
  testHashUnchanged,
  gitStatusFiles,
  verificationExitCode,
  artifactSha256,
  artifactByteLength,
}) {
  const chain = repairChainTerminalState(session, failedLaneId);
  const failures = [...chain.failures];
  if (!chain.completed) failures.push("repair-chain-not-completed");
  if (chain.terminalFailure) failures.push(`successor-terminal-failure:${chain.terminalFailure.id}`);
  const specs = [
    ["failure", chain.failed, "failed", "failed", "failed", "failed", null, { before: "dirty", after: "dirty" }, { before: [failureRepairRegressionFixture.answerFile], after: [failureRepairRegressionFixture.answerFile] }],
    ["repair", chain.repair, "completed", "succeeded", "passed", "succeeded", "passed", { before: "dirty", after: "clean" }, { before: [failureRepairRegressionFixture.answerFile], after: [] }],
    ["regression", chain.regression, "completed", "succeeded", "passed", "succeeded", null, { before: "clean", after: "clean" }, { before: [], after: [] }],
  ];
  const runs = {};
  for (const [
    label,
    node,
    nodeStatus,
    segmentStatus,
    evidenceStatus,
    runStatus,
    expectedArtifactStatus,
    worktreeStates,
    changedFiles,
  ] of specs) {
    const state = codexLaneRunState({
      node,
      projection,
      runFacts: node?.runId ? runFacts[node.runId] : null,
      sessionId: session?.id,
      label,
      nodeStatus,
      segmentStatus,
      evidenceStatus,
      runStatus,
      expectedArtifactStatus,
    });
    failures.push(...state.failures.filter((failure) => !failures.includes(failure)));
    runs[label] = state;
    if (state.laneId && state.runId && state.segmentId) {
      try {
        assertRunCheckpointAuthority(projection, checkpointIdentityForRun(state, {
          session,
          projectRoot,
          headCommit: baselineHead,
          worktreeStates,
          changedFiles,
        }));
      } catch {
        failures.push(`${label}-checkpoint-authority-invalid`);
      }
    }
  }
  if (baselineHead !== currentHead) failures.push("head-moved");
  if (answerSource !== failureRepairRegressionFixture.expectedAnswerSource) failures.push("answer-source-invalid");
  if (testHashUnchanged !== true) failures.push("test-file-changed");
  if (!exactStringArray(gitStatusFiles, [])) failures.push("git-state-not-clean");
  if (verificationExitCode !== 0) failures.push(`verification-exit:${String(verificationExitCode)}`);
  if (artifactSha256 !== failureRepairRegressionFixture.expectedArtifactSha256) failures.push("artifact-hash-invalid");
  if (artifactByteLength !== failureRepairRegressionFixture.expectedArtifactByteLength) failures.push("artifact-size-invalid");
  return {
    ok: failures.length === 0,
    failures,
    chain: {
      failedLaneId: chain.failed?.id ?? null,
      repairLaneId: chain.repair?.id ?? null,
      regressionLaneId: chain.regression?.id ?? null,
    },
    runs,
  };
}

function checkpointIdentityForRun(state, { session, projectRoot, headCommit, worktreeStates, changedFiles }) {
  return {
    sessionId: session?.id,
    nodeId: state.laneId,
    laneId: state.laneId,
    runId: state.runId,
    segmentId: state.segmentId,
    executionTarget: session?.target?.executionTarget,
    worktreePath: projectRoot,
    branchName: session?.target?.selectedBranch,
    headCommit,
    worktreeStates,
    changedFiles,
  };
}

export function authoritativeStateDifference(live, reopened) {
  if (stableJson(live) === stableJson(reopened)) return null;
  const liveEvents = Array.isArray(live?.projection?.events) ? live.projection.events : [];
  const reopenedEvents = Array.isArray(reopened?.projection?.events) ? reopened.projection.events : [];
  const eventCount = Math.max(liveEvents.length, reopenedEvents.length);
  let firstDifferentEvent = null;
  for (let index = 0; index < eventCount; index += 1) {
    const liveEvent = liveEvents[index];
    const reopenedEvent = reopenedEvents[index];
    if (stableJson(liveEvent) === stableJson(reopenedEvent)) continue;
    firstDifferentEvent = {
      index,
      liveSequence: liveEvent?.seq ?? null,
      reopenedSequence: reopenedEvent?.seq ?? null,
      liveKind: liveEvent?.kind ?? null,
      reopenedKind: reopenedEvent?.kind ?? null,
      liveIdempotencyKey: liveEvent?.idempotencyKey ?? null,
      reopenedIdempotencyKey: reopenedEvent?.idempotencyKey ?? null,
      differingFields: differingFields(liveEvent, reopenedEvent),
    };
    break;
  }
  return {
    firstDifferentEvent,
    canvasSessionDifferingFields: differingFields(live?.canvasSession, reopened?.canvasSession),
    projectionDifferingFields: differingFields(live?.projection, reopened?.projection),
  };
}

export function rendererReplayDifference(authoritativeSession, rendered) {
  const expectedNodes = (authoritativeSession?.nodes ?? [])
    .map((node) => ({ id: node.id, status: node.status }))
    .sort(compareById);
  const renderedNodes = (rendered?.nodes ?? []).map((node) => ({ id: node.id, status: node.status })).sort(compareById);
  const expectedEdges = (authoritativeSession?.edges ?? []).map((edge) => edge.id).sort();
  const renderedEdges = [...(rendered?.edges ?? [])].sort();
  if (stableJson(expectedNodes) === stableJson(renderedNodes) && stableJson(expectedEdges) === stableJson(renderedEdges)) {
    return null;
  }
  return { expectedEdges, renderedEdges, expectedNodes, renderedNodes };
}

export async function inspectFailureRepairRegressionStore(config) {
  const { createWorkflowStore } = await import("@skyturn/persistence/workflow-store");
  const store = createWorkflowStore({ projectRoot: config.projectRoot });
  try {
    return {
      projection: store.materializeFlowProjection(config.sessionId),
      canvasSession: store.materializeCanvasSession(config.sessionId),
    };
  } finally {
    store.close();
  }
}

export async function submitRepairThroughUi(cdp, { laneId, instruction = failureRepairRegressionFixture.repairInstruction }) {
  const result = await cdp.evaluate(`
    (async () => {
      const laneId = ${JSON.stringify(laneId)};
      const instruction = ${JSON.stringify(instruction)};
      const waitFor = (probe, label) => new Promise((resolve, reject) => {
        const deadline = Date.now() + 15000;
        const tick = () => {
          const value = probe();
          if (value) return resolve(value);
          if (Date.now() >= deadline) return reject(new Error('Timed out waiting for ' + label));
          requestAnimationFrame(tick);
        };
        tick();
      });
      const node = await waitFor(
        () => document.querySelector('.react-flow__node[data-id="' + laneId + '"] .agent-card-select'),
        'failed validation node',
      );
      node.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, view: window }));
      let repair;
      try {
        repair = await waitFor(
          () => [...document.querySelectorAll('.composer-actions button')]
            .find((button) => button.textContent?.trim() === 'Repair' && !button.disabled),
          'enabled Repair action',
        );
      } catch (error) {
        const candidate = [...document.querySelectorAll('.composer-actions button')]
          .find((button) => button.textContent?.trim() === 'Repair');
        throw new Error(error.message + ': ' + JSON.stringify({
          nodePressed: node.getAttribute('aria-pressed'),
          repairFound: Boolean(candidate),
          repairDisabled: candidate?.disabled ?? null,
          repairTitle: candidate?.getAttribute('title') ?? null,
        }));
      }
      repair.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, view: window }));
      const input = await waitFor(
        () => document.querySelector('input[aria-label="Tell the agent how to fix this node result…"]'),
        'Repair instruction input',
      );
      const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set;
      input.focus();
      setter.call(input, instruction);
      input.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'insertText', data: instruction }));
      input.dispatchEvent(new Event('change', { bubbles: true }));
      const submit = await waitFor(
        () => document.querySelector('button[aria-label="Submit node action"]:not(:disabled)'),
        'Repair submit button',
      );
      submit.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, view: window }));
      await waitFor(() => input.value === '', 'Repair submission');
      return { laneId, instruction, submitted: true };
    })()
  `, { awaitPromise: true, returnByValue: true });
  if (result?.submitted !== true || result.laneId !== laneId || result.instruction !== instruction) {
    throw new Error("Repair UI did not confirm the exact instruction submission.");
  }
  return result;
}

export async function runFailureRepairRegressionAcceptance() {
  const projectRoot = await realpath(await mkdtemp(join(tmpdir(), "skyturn-failure-repair-regression-")));
  const userData = await mkdtemp(join(tmpdir(), "skyturn-failure-repair-user-data-"));
  const workspacePath = join(userData, "workspace.json");
  let app = null;
  let liveCdp = null;
  let succeeded = false;
  let cleanupConfirmed = true;
  let stage = "fixture";

  try {
    const fixture = await createDisposableFailureProject(projectRoot);
    stage = "electron-launch";
    app = await launchElectronAcceptanceApp({ userData, projectRoot });
    liveCdp = await connectToReadySkyTurnRenderer({
      cdpPort: app.cdpPort,
      devServerUrl: app.devServerUrl,
      projectRoot,
      processDiagnostics: app.diagnostics,
    });
    await installRepairHandoffCollector(liveCdp, projectRoot);
    stage = "project-open";
    await openProjectThroughUi(liveCdp, projectRoot);
    await waitForStoredProjectRegistration(liveCdp, projectRoot);
    const readiness = await readRealWorkflowReadiness(liveCdp);
    if (readiness.checks?.mockFallback !== false) throw new Error("Mock fallback must be false.");
    stage = "initial-real-codex-failure";
    await fillTextareaAndClickCreate(liveCdp, failureRepairRegressionFixture.sessionGoal);
    const initial = await waitForInitialCodexFailure(liveCdp, projectRoot);
    assertRunCheckpointAuthority(initial.authoritative.projection, checkpointIdentityForRun(initial.state, {
      session: initial.authoritative.canvasSession,
      projectRoot,
      headCommit: fixture.baselineHead,
      worktreeStates: { before: "dirty", after: "dirty" },
      changedFiles: {
        before: [failureRepairRegressionFixture.answerFile],
        after: [failureRepairRegressionFixture.answerFile],
      },
    }));
    stage = "repair-regression";
    await submitRepairThroughUi(liveCdp, {
      laneId: initial.state.laneId,
      instruction: failureRepairRegressionFixture.repairInstruction,
    });
    await waitForRepairChain(liveCdp, initial.sessionId, initial.state.laneId);
    const completed = await readStableAuthoritativeState(liveCdp, projectRoot, initial.sessionId);
    const completedChain = repairChainTerminalState(completed.canvasSession, initial.state.laneId);
    if (!completedChain.completed || completedChain.terminalFailure || completedChain.failures.length > 0) {
      throw new Error(`Final authoritative chain is invalid: ${boundedDiagnostic(JSON.stringify(completedChain))}`);
    }
    const runFacts = await readChainRunFacts(liveCdp, projectRoot, completedChain);
    const verification = await collectProjectVerification(projectRoot, fixture);
    const summary = failureRepairRegressionSummary({
      session: completed.canvasSession,
      projection: completed.projection,
      runFacts,
      failedLaneId: initial.state.laneId,
      projectRoot,
      ...verification,
    });
    if (!summary.ok) throw new Error(`Acceptance predicates failed: ${summary.failures.join(", ")}`);
    await waitForWorkspaceSession(liveCdp, completed.canvasSession);
    await uninstallRepairHandoffCollector(liveCdp);

    stage = "sqlite-reopen";
    const firstClose = await finalizeAcceptanceOutcome({ app, liveCdp, ok: true });
    app = null;
    liveCdp = null;
    if (!firstClose.ok) throw new Error(firstClose.diagnostic ?? "First Electron close failed.");
    const reopened = await runElectronNodeInspect({ projectRoot, sessionId: initial.sessionId });
    const reopenDifference = authoritativeStateDifference(completed, reopened);
    if (reopenDifference) {
      throw new Error(`SQLite reopen changed authoritative state: ${boundedDiagnostic(JSON.stringify(reopenDifference))}`);
    }
    await overwriteWorkspaceSessionWithStaleClone(workspacePath, completed.canvasSession);

    stage = "electron-restart";
    app = await launchElectronAcceptanceApp({ userData, projectRoot });
    liveCdp = await connectToReadySkyTurnRenderer({
      cdpPort: app.cdpPort,
      devServerUrl: app.devServerUrl,
      projectRoot,
      processDiagnostics: app.diagnostics,
    });
    await waitForStoredProjectRegistration(liveCdp, projectRoot);
    const rendered = await readRendererReplayState(liveCdp, reopened.canvasSession);
    const rendererDifference = rendererReplayDifference(reopened.canvasSession, rendered);
    if (rendererDifference) {
      throw new Error(`Renderer replay differs from SQLite: ${boundedDiagnostic(JSON.stringify(rendererDifference))}`);
    }
    const restarted = await readAuthoritativeState(liveCdp, projectRoot, initial.sessionId);
    const restartDifference = authoritativeStateDifference(reopened, restarted);
    if (restartDifference) {
      throw new Error(`Electron restart changed authoritative state: ${boundedDiagnostic(JSON.stringify(restartDifference))}`);
    }
    const activeRuns = await readActiveRunIds(liveCdp);
    if (activeRuns.length > 0) throw new Error(`Electron restart relaunched terminal runs: ${activeRuns.join(",")}`);
    const finalClose = await finalizeAcceptanceOutcome({ app, liveCdp, ok: true });
    app = null;
    liveCdp = null;
    if (!finalClose.ok) throw new Error(finalClose.diagnostic ?? "Restarted Electron close failed.");

    succeeded = true;
    printBoundedResult({
      ok: true,
      failure: null,
      realElectronApi: true,
      mockFallback: false,
      runs: compactRunEvidence(summary.runs),
      checkpointAuthority: { failure: true, repair: true, regression: true },
      sqliteReopen: { preserved: true, eventCount: reopened.projection.events?.length ?? 0 },
      electronRestart: { preserved: true, rendererReplay: true, activeRunIds: [] },
      git: {
        clean: true,
        headUnchanged: true,
        answer: { path: failureRepairRegressionFixture.answerFile, line: 1, value: "export const answer = 42;" },
        testHashUnchanged: true,
        artifact: {
          path: failureRepairRegressionFixture.expectedArtifact,
          byteLength: verification.artifactByteLength,
          sha256: verification.artifactSha256,
        },
      },
    });
  } catch (error) {
    const cleanup = await finalizeAcceptanceOutcome({ app, liveCdp, error });
    cleanupConfirmed = cleanup.cleanupConfirmed;
    app = null;
    liveCdp = null;
    printBoundedResult({
      ok: false,
      failure: {
        code: "FAILURE_REPAIR_REGRESSION_ACCEPTANCE_FAILED",
        stage,
        message: "Real Electron failure to Repair to regression acceptance failed.",
        diagnostic: boundedDiagnostic(error instanceof Error ? error.message : String(error)),
      },
      mockFallback: null,
      cleanup: {
        confirmed: cleanup.cleanupConfirmed,
        resourcesKeptAlive: cleanup.resourcesKeptAlive,
        cancelledRunIds: cleanup.cancelledRunIds,
        diagnostic: cleanup.diagnostic ? boundedDiagnostic(cleanup.diagnostic) : null,
      },
    });
    process.exitCode = 1;
  } finally {
    if (succeeded && process.env.SKYTURN_FAILURE_REPAIR_CLEANUP === "1") {
      await rm(projectRoot, { recursive: true, force: true });
    }
    if (succeeded && process.env.SKYTURN_FAILURE_REPAIR_KEEP_USER_DATA !== "1") {
      await rm(userData, { recursive: true, force: true });
    }
    if (!succeeded && !cleanupConfirmed) process.exitCode = 1;
  }
}

async function waitForInitialCodexFailure(cdp, projectRoot) {
  const deadline = Date.now() + waitTimeoutMs;
  let last = null;
  while (Date.now() < deadline) {
    const collector = await readRepairHandoffCollector(cdp);
    assertCollectorUsable(collector);
    const broadcasts = collector.broadcasts.filter((event) => event?.projectRoot === projectRoot);
    for (const broadcast of [...broadcasts].reverse()) {
      const session = broadcast?.canvasSession;
      const projection = broadcast?.projection;
      const sourceNodes = (session?.nodes ?? []).filter((node) =>
        node?.id !== session?.plannerNodeId && node?.semanticSubtype !== "repair" && node?.semanticSubtype !== "regression_check"
      );
      if (sourceNodes.length !== 1 || sourceNodes[0]?.status !== "failed" || !sourceNodes[0]?.runId) continue;
      const runFacts = await readAgentRunFacts(cdp, projectRoot, sourceNodes[0].runId);
      const state = initialCodexFailureState({ session, projection, runFacts });
      last = state;
      if (broadcast.cause !== "terminal-reconciliation") {
        throw new Error(`Initial failure broadcast cause is ${String(broadcast.cause)}.`);
      }
      if (!state.ok) throw new Error(`Initial Codex failure is invalid: ${boundedDiagnostic(JSON.stringify(state))}`);
      return { authoritative: { canvasSession: session, projection }, broadcast, runFacts, sessionId: session.id, state };
    }
    await delay(pollIntervalMs);
  }
  throw new Error(`Timed out waiting for a real Codex failure: ${boundedDiagnostic(JSON.stringify(last))}`);
}

async function installRepairHandoffCollector(cdp, projectRoot) {
  const installed = await cdp.evaluate(`
    (() => {
      const key = ${JSON.stringify(handoffCollectorKey)};
      const existing = window[key];
      if (existing?.unsubscribe) existing.unsubscribe();
      const state = { broadcasts: [], overflow: false, cloneFailure: false };
      const unsubscribe = window.devflow.onWorkflowEvent((event) => {
        if (event?.projectRoot !== ${JSON.stringify(projectRoot)} || !event?.projection || !event?.canvasSession) return;
        if (state.broadcasts.length >= ${handoffCollectorLimit}) {
          state.overflow = true;
          return;
        }
        try {
          state.broadcasts.push(structuredClone(event));
        } catch {
          state.cloneFailure = true;
        }
      });
      window[key] = { state, unsubscribe };
      return true;
    })()
  `, { returnByValue: true });
  if (installed !== true) throw new Error("Workflow broadcast collector was not installed.");
}

async function uninstallRepairHandoffCollector(cdp) {
  const removed = await cdp.evaluate(`
    (() => {
      const key = ${JSON.stringify(handoffCollectorKey)};
      const collector = window[key];
      if (!collector) return false;
      try {
        collector.unsubscribe();
      } finally {
        delete window[key];
      }
      return true;
    })()
  `, { returnByValue: true });
  if (removed !== true) throw new Error("Workflow broadcast collector was not removed.");
}

async function readRepairHandoffCollector(cdp) {
  return await cdp.evaluate(`
    (() => {
      const collector = window[${JSON.stringify(handoffCollectorKey)}];
      return collector ? collector.state : null;
    })()
  `, { returnByValue: true });
}

function assertCollectorUsable(collector) {
  if (!collector) throw new Error("Workflow broadcast collector disappeared.");
  if (collector.overflow) throw new Error("Workflow broadcast collector overflowed.");
  if (collector.cloneFailure) throw new Error("Workflow broadcast collector could not snapshot an event.");
}

async function waitForRepairChain(cdp, sessionId, failedLaneId) {
  const deadline = Date.now() + waitTimeoutMs;
  let last = null;
  while (Date.now() < deadline) {
    const collector = await readRepairHandoffCollector(cdp);
    assertCollectorUsable(collector);
    const state = automaticRepairHandoffState(
      collector.broadcasts.filter((broadcast) => broadcast?.sessionId === sessionId),
      failedLaneId,
    );
    last = state;
    if (state.failures.length > 0) {
      throw new Error(`Automatic handoff broadcast invalid: ${boundedDiagnostic(JSON.stringify(state))}`);
    }
    if (state.readyForFinalRead) return state;
    await delay(pollIntervalMs);
  }
  throw new Error(`Timed out waiting for automatic Repair and regression: ${boundedDiagnostic(JSON.stringify(last))}`);
}

async function readRealWorkflowReadiness(cdp) {
  const result = await cdp.evaluate("window.devflow.getAgentHealth()", { awaitPromise: true, returnByValue: true });
  const readiness = result?.readiness;
  const failures = [];
  if (readiness?.checks?.mockFallback !== false) failures.push("mock-fallback-enabled-or-unknown");
  if (readiness?.checks?.hermesCli !== "ready") failures.push("hermes-cli-not-ready");
  if (readiness?.checks?.codexCli !== "ready") failures.push("codex-cli-not-ready");
  if (readiness?.checks?.hermesAuth === "missing") failures.push("hermes-auth-missing");
  if (readiness?.checks?.codexAuth === "missing") failures.push("codex-auth-missing");
  if (failures.length > 0) throw new Error(`Real agent readiness failed: ${failures.join(", ")}`);
  return readiness;
}

async function readAgentRunFacts(cdp, projectRoot, runId) {
  const value = await cdp.evaluate(`
    Promise.all([
      window.devflow.listAgentRuns(),
      window.devflow.getRunEvents(${JSON.stringify(projectRoot)}, ${JSON.stringify(runId)}),
      window.devflow.getRunEvidence(${JSON.stringify(projectRoot)}, ${JSON.stringify(runId)})
    ]).then(([runs, events, evidence]) => ({
      run: runs.runs.find((candidate) => candidate.id === ${JSON.stringify(runId)}) ?? null,
      events: events.events,
      evidence: evidence.evidence
    }))
  `, { awaitPromise: true, returnByValue: true });
  if (!value?.run || !Array.isArray(value.events) || !value.evidence) {
    throw new Error(`AgentBridge facts are unavailable for ${runId}.`);
  }
  return value;
}

async function readChainRunFacts(cdp, projectRoot, chain) {
  const nodes = [chain.failed, chain.repair, chain.regression];
  const entries = await Promise.all(nodes.map(async (node) => [
    node.runId,
    await readAgentRunFacts(cdp, projectRoot, node.runId),
  ]));
  return Object.fromEntries(entries);
}

async function readAuthoritativeState(cdp, projectRoot, sessionId) {
  const value = await cdp.evaluate(`
    window.devflow.workflow.getProjection(
      ${JSON.stringify(projectRoot)},
      ${JSON.stringify(sessionId)}
    ).then((result) => ({ projection: result.projection, canvasSession: result.canvasSession }))
  `, { awaitPromise: true, returnByValue: true });
  if (!value?.projection || !value?.canvasSession) throw new Error("Authoritative workflow projection is unavailable.");
  return value;
}

async function readStableAuthoritativeState(cdp, projectRoot, sessionId) {
  const deadline = Date.now() + waitTimeoutMs;
  let previous = null;
  let stableReads = 0;
  while (Date.now() < deadline) {
    const current = await readAuthoritativeState(cdp, projectRoot, sessionId);
    if (stableJson(current) === stableJson(previous)) {
      stableReads += 1;
      if (stableReads >= 2) return current;
    } else {
      previous = current;
      stableReads = 0;
    }
    await delay(pollIntervalMs);
  }
  throw new Error("Timed out waiting for a stable terminal authoritative projection.");
}

async function waitForWorkspaceSession(cdp, authoritativeSession) {
  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline) {
    const session = await cdp.evaluate(`
      window.devflow.loadWorkspace().then((workspace) =>
        workspace?.sessions?.find((candidate) => candidate?.id === ${JSON.stringify(authoritativeSession.id)}) ?? null
      )
    `, { awaitPromise: true, returnByValue: true });
    if (stableJson(session) === stableJson(authoritativeSession)) return;
    await delay(100);
  }
  throw new Error("Workspace persistence did not capture the authoritative CanvasSession.");
}

async function readRendererReplayState(cdp, authoritativeSession) {
  const expected = {
    nodes: (authoritativeSession?.nodes ?? []).map((node) => ({ id: node.id, status: node.status })).sort(compareById),
    edges: (authoritativeSession?.edges ?? []).map((edge) => edge.id).sort(),
  };
  const value = await cdp.evaluate(`
    (async () => {
      const expected = ${JSON.stringify(expected)};
      const stable = (value) => JSON.stringify(value);
      const read = () => ({
        nodes: [...document.querySelectorAll('.react-flow__node[data-id]')]
          .map((element) => ({
            id: element.getAttribute('data-id'),
            status: element.querySelector('.agent-node-shell')?.getAttribute('data-state') ?? null,
          }))
          .sort((left, right) => left.id.localeCompare(right.id)),
        edges: [...document.querySelectorAll('.react-flow__edge[data-id]')]
          .map((element) => element.getAttribute('data-id'))
          .sort(),
      });
      return await new Promise((resolve, reject) => {
        const deadline = Date.now() + 15000;
        const tick = () => {
          const current = read();
          if (stable(current) === stable(expected)) return resolve(current);
          if (Date.now() >= deadline) return reject(new Error('Timed out waiting for exact renderer replay: ' + stable(current)));
          requestAnimationFrame(tick);
        };
        tick();
      });
    })()
  `, { awaitPromise: true, returnByValue: true });
  if (!Array.isArray(value?.nodes) || !Array.isArray(value?.edges)) throw new Error("Renderer replay state is unavailable.");
  return value;
}

async function readActiveRunIds(cdp) {
  return await cdp.evaluate(`
    window.devflow.listAgentRuns().then((result) => result.runs
      .filter((run) => !['succeeded', 'failed', 'cancelled', 'timed-out'].includes(run.status))
      .map((run) => run.id)
      .sort())
  `, { awaitPromise: true, returnByValue: true });
}

async function collectProjectVerification(projectRoot, fixture) {
  const artifactPath = join(projectRoot, failureRepairRegressionFixture.expectedArtifact);
  const [head, statusResult, test, answerSource, actualTestHash, artifactSha256, artifactStats] = await Promise.all([
    runCommand("git", ["rev-parse", "HEAD"], projectRoot),
    runCommand("git", ["status", "--short"], projectRoot),
    runCommand(process.execPath, ["--test"], projectRoot, { allowFailure: true }),
    readFile(join(projectRoot, failureRepairRegressionFixture.answerFile), "utf8"),
    sha256File(join(projectRoot, failureRepairRegressionFixture.testFile)),
    sha256File(artifactPath),
    stat(artifactPath),
  ]);
  return {
    baselineHead: fixture.baselineHead,
    currentHead: head.stdout.trim(),
    answerSource,
    testHashUnchanged: actualTestHash === fixture.testHash,
    gitStatusFiles: parseGitStatusFiles(statusResult.stdout),
    verificationExitCode: test.code,
    artifactSha256,
    artifactByteLength: artifactStats.size,
  };
}

export async function createDisposableFailureProject(projectRoot) {
  await Promise.all([
    mkdir(join(projectRoot, "scripts"), { recursive: true }),
    mkdir(join(projectRoot, "test"), { recursive: true }),
  ]);
  await writeFile(join(projectRoot, "package.json"), `${JSON.stringify({
    name: "skyturn-failure-repair-fixture",
    private: true,
    type: "module",
    scripts: { test: "node --test" },
  }, null, 2)}\n`);
  await writeFile(join(projectRoot, ".gitignore"), ".devflow/\n");
  await writeFile(join(projectRoot, failureRepairRegressionFixture.answerFile), failureRepairRegressionFixture.expectedAnswerSource);
  await writeFile(join(projectRoot, failureRepairRegressionFixture.testFile), [
    'import assert from "node:assert/strict";',
    'import test from "node:test";',
    'import { answer } from "../answer.js";',
    "",
    'test("answer is 42", () => {',
    "  assert.equal(answer, 42);",
    "});",
    "",
  ].join("\n"));
  await writeFile(join(projectRoot, failureRepairRegressionFixture.repairScript), repairFixtureScript());
  await runCommand("git", ["init", "-b", "main"], projectRoot);
  await runCommand("git", ["config", "user.name", "SkyTurn Acceptance"], projectRoot);
  await runCommand("git", ["config", "user.email", "acceptance@skyturn.local"], projectRoot);
  await runCommand("git", ["add", ".gitignore", "package.json", failureRepairRegressionFixture.answerFile, failureRepairRegressionFixture.testFile, failureRepairRegressionFixture.repairScript], projectRoot);
  await runCommand("git", ["commit", "-m", "test: seed repair acceptance contract"], projectRoot);
  const baselineHead = (await runCommand("git", ["rev-parse", "HEAD"], projectRoot)).stdout.trim();
  const testHash = await sha256File(join(projectRoot, failureRepairRegressionFixture.testFile));
  await writeFile(join(projectRoot, failureRepairRegressionFixture.answerFile), failureRepairRegressionFixture.brokenAnswerSource);
  const initialTest = await runCommand(process.execPath, ["--test"], projectRoot, {
    allowFailure: true,
    env: standaloneNodeEnvironment(),
  });
  const initialStatus = parseGitStatusFiles((await runCommand("git", ["status", "--short"], projectRoot)).stdout);
  if (initialTest.code === 0 || !exactStringArray(initialStatus, [failureRepairRegressionFixture.answerFile])) {
    throw new Error(
      `Disposable project does not start from the exact failing dirty fixture ` +
      `(testExit=${initialTest.code}, dirty=${JSON.stringify(initialStatus)}, ` +
      `output=${boundedDiagnostic(`${initialTest.stdout}\n${initialTest.stderr}`)}).`,
    );
  }
  return { baselineHead, testHash, initialTestExitCode: initialTest.code, initialDirtyFiles: initialStatus };
}

function repairFixtureScript() {
  return [
    'import { mkdir, readFile, writeFile } from "node:fs/promises";',
    'import { dirname, join } from "node:path";',
    'import { fileURLToPath } from "node:url";',
    "",
    'const root = dirname(dirname(fileURLToPath(import.meta.url)));',
    `const answerPath = join(root, ${JSON.stringify(failureRepairRegressionFixture.answerFile)});`,
    `const expectedAnswer = ${JSON.stringify(failureRepairRegressionFixture.expectedAnswerSource)};`,
    `const artifactPath = join(root, ${JSON.stringify(failureRepairRegressionFixture.expectedArtifact)});`,
    `const expectedArtifact = Buffer.from(${JSON.stringify(expectedArtifactBytes.toString("base64"))}, "base64");`,
    "",
    'if (await readFile(answerPath, "utf8") !== expectedAnswer) await writeFile(answerPath, expectedAnswer);',
    "let artifact = null;",
    "try { artifact = await readFile(artifactPath); } catch {}",
    "if (!artifact?.equals(expectedArtifact)) {",
    "  await mkdir(dirname(artifactPath), { recursive: true });",
    "  await writeFile(artifactPath, expectedArtifact);",
    "}",
    "",
  ].join("\n");
}

function standaloneNodeEnvironment() {
  const environment = { ...process.env };
  delete environment.NODE_TEST_CONTEXT;
  return environment;
}

async function runElectronNodeInspect(config) {
  const electronBinary = require("electron");
  const result = await runCommand(electronBinary, [scriptPath, "--inspect", JSON.stringify(config)], dirname(scriptPath), {
    env: { ...process.env, ELECTRON_RUN_AS_NODE: "1" },
  });
  const line = result.stdout.split("\n").find((candidate) => candidate.startsWith(inspectResultPrefix));
  if (!line) throw new Error(`Electron inspector did not return a structured result: ${boundedDiagnostic(result.stdout + result.stderr)}`);
  return JSON.parse(line.slice(inspectResultPrefix.length));
}

function compactRunEvidence(runs) {
  return Object.fromEntries(Object.entries(runs).map(([label, run]) => [label, {
    laneId: run.laneId,
    segmentId: run.segmentId,
    runId: run.runId,
    nodeStatus: run.nodeStatus,
    segmentStatus: run.segmentStatus,
    projectionEvidenceStatus: run.projectionEvidenceStatus,
    status: run.status,
    exitCode: run.exitCode,
    runExitCheck: run.runExitCheck,
    artifactCheck: run.artifactCheck,
  }]));
}

function printBoundedResult(result) {
  const output = serializeBoundedAcceptanceResult(result);
  if (JSON.parse(output)?.failure?.code === "FAILURE_REPAIR_REGRESSION_RESULT_OVERFLOW") {
    process.exitCode = 1;
  }
  console.log(output);
}

export function serializeBoundedAcceptanceResult(result) {
  const output = JSON.stringify(sanitizePublicResult(result), null, 2);
  if (Buffer.byteLength(output) > resultLimitBytes) {
    return JSON.stringify({
      ok: false,
      failure: {
        code: "FAILURE_REPAIR_REGRESSION_RESULT_OVERFLOW",
        message: "Acceptance result exceeded the bounded public schema.",
      },
    });
  }
  return output;
}

function sanitizePublicResult(value, depth = 0) {
  if (typeof value === "string") return sanitizeDiagnostic(value);
  if (value === null || typeof value !== "object") return value;
  if (depth >= 16) return "[truncated]";
  if (Array.isArray(value)) return value.map((item) => sanitizePublicResult(item, depth + 1));
  return Object.fromEntries(Object.entries(value).map(([key, item]) => [
    key,
    sanitizePublicResult(item, depth + 1),
  ]));
}

function parseGitStatusFiles(value) {
  return value.split("\n").filter(Boolean).map((line) => line.slice(3).trim()).sort();
}

function exactStringArray(actual, expected) {
  return Array.isArray(actual) && actual.length === expected.length &&
    actual.every((value, index) => value === expected[index]);
}

function compareById(left, right) {
  return String(left?.id).localeCompare(String(right?.id));
}

function stableJson(value) {
  return JSON.stringify(value, (_key, nested) => {
    if (!nested || typeof nested !== "object" || Array.isArray(nested)) return nested;
    return Object.fromEntries(Object.entries(nested).sort(([left], [right]) => left.localeCompare(right)));
  });
}

function differingFields(live, reopened, path = "$", differences = []) {
  if (differences.length >= 64 || stableJson(live) === stableJson(reopened)) return differences;
  const liveArray = Array.isArray(live);
  const reopenedArray = Array.isArray(reopened);
  if (liveArray || reopenedArray) {
    if (!liveArray || !reopenedArray) {
      differences.push({ path, liveValue: diagnosticValue(live, true), reopenedValue: diagnosticValue(reopened, true) });
      return differences;
    }
    for (let index = 0; index < Math.max(live.length, reopened.length) && differences.length < 64; index += 1) {
      differingFields(live[index], reopened[index], `${path}[${index}]`, differences);
    }
    return differences;
  }
  const liveObject = live !== null && typeof live === "object";
  const reopenedObject = reopened !== null && typeof reopened === "object";
  if (liveObject || reopenedObject) {
    if (!liveObject || !reopenedObject) {
      differences.push({ path, liveValue: diagnosticValue(live, true), reopenedValue: diagnosticValue(reopened, true) });
      return differences;
    }
    const keys = [...new Set([...Object.keys(live), ...Object.keys(reopened)])].sort();
    for (const key of keys) {
      if (differences.length >= 64) break;
      const livePresent = Object.hasOwn(live, key);
      const reopenedPresent = Object.hasOwn(reopened, key);
      if (!livePresent || !reopenedPresent) {
        differences.push({
          path: `${path}.${key}`,
          liveValue: diagnosticValue(live[key], livePresent),
          reopenedValue: diagnosticValue(reopened[key], reopenedPresent),
        });
        continue;
      }
      differingFields(live[key], reopened[key], `${path}.${key}`, differences);
    }
    return differences;
  }
  differences.push({ path, liveValue: diagnosticValue(live, true), reopenedValue: diagnosticValue(reopened, true) });
  return differences;
}

function diagnosticValue(value, present) {
  return present ? value : { missing: true };
}

function boundedDiagnostic(value) {
  const text = sanitizeDiagnostic(value);
  if (Buffer.byteLength(text) <= diagnosticLimitBytes) return text;
  const marker = "... [truncated]";
  return `${Buffer.from(text).subarray(0, diagnosticLimitBytes - Buffer.byteLength(marker)).toString("utf8").replace(/\uFFFD$/, "")}${marker}`;
}

function sanitizeDiagnostic(value) {
  return String(value)
    .replace(/\b(?:Authorization:\s*)?Bearer\s+\S+/gi, "Bearer [redacted]")
    .replace(/\bsk-[A-Za-z0-9_-]{6,}\b/g, "[redacted]")
    .replace(/\b(password|credential|secret|token|api[_-]?key)\s*[:=]\s*\S+/gi, "$1=[redacted]")
    .replace(/(^|[\s("'=])\/(?:Users|Volumes|private|tmp)\/[^\s"'<>)]*/g, "$1[redacted-path]");
}

function sha256File(path) {
  return readFile(path).then((value) => createHash("sha256").update(value).digest("hex"));
}

export function collectProcessOutput(stream, append) {
  stream.setEncoding("utf8");
  stream.on("data", append);
}

function runCommand(command, args, cwd, { allowFailure = false, env = process.env } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { cwd, env, stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    collectProcessOutput(child.stdout, (chunk) => { stdout += chunk; });
    collectProcessOutput(child.stderr, (chunk) => { stderr += chunk; });
    child.once("error", reject);
    child.once("close", (code, signal) => {
      const result = { code: code ?? (signal ? 1 : 0), signal, stdout, stderr };
      if (result.code === 0 || allowFailure) resolve(result);
      else reject(new Error(`${command} failed (${signal ?? result.code}): ${boundedDiagnostic(stderr || stdout)}`));
    });
  });
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function runRuntimeMode() {
  if (process.argv[2] !== "--inspect") return false;
  const config = JSON.parse(process.argv[3] ?? "null");
  console.log(`${inspectResultPrefix}${JSON.stringify(await inspectFailureRepairRegressionStore(config))}`);
  return true;
}

if (process.argv[1] === scriptPath) {
  runRuntimeMode().then((handled) => {
    if (!handled) return runFailureRepairRegressionAcceptance();
  }).catch((error) => {
    console.error(boundedDiagnostic(error instanceof Error ? error.stack ?? error.message : String(error)));
    process.exitCode = 1;
  });
}
