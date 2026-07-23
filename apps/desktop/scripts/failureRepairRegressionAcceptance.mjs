import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { createRequire } from "node:module";
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import {
  connectToReadySkyTurnRenderer,
  finalizeAcceptanceOutcome,
  launchElectronAcceptanceApp,
  waitForStoredProjectRegistration,
} from "./newSessionUiAcceptance.mjs";

const require = createRequire(import.meta.url);
const scriptPath = fileURLToPath(import.meta.url);
const waitTimeoutMs = Number(process.env.SKYTURN_FAILURE_REPAIR_WAIT_TIMEOUT_MS ?? 20 * 60 * 1_000);
const pollIntervalMs = Number(process.env.SKYTURN_FAILURE_REPAIR_POLL_MS ?? 2_000);
const diagnosticLimitBytes = Number(process.env.SKYTURN_FAILURE_REPAIR_DIAGNOSTIC_LIMIT_BYTES ?? 8_000);
const seedResultPrefix = "SKYTURN_FAILURE_REPAIR_SEED=";
const inspectResultPrefix = "SKYTURN_FAILURE_REPAIR_INSPECT=";
const handoffCollectorKey = "__skyturnFailureRepairHandoffCollector";
const handoffCollectorLimit = 256;

export const failureRepairRegressionFixture = Object.freeze({
  projectId: "project-failure-repair-regression",
  sessionId: "session-failure-repair-regression",
  failedLaneId: "lane-validation-failed",
  failedRunId: "run-session-failure-repair-regression-lane-validation-failed",
  failedSegmentId: "segment-session-failure-repair-regression-lane-validation-failed",
  repairInstruction: "Change answer.js so answer is 42; do not edit test; run node --test",
  testFile: "answer.test.js",
});

export function createSeedWorkspaceState({ projectRoot, canvasSession, failedEvidence, openedAt }) {
  const project = {
    id: failureRepairRegressionFixture.projectId,
    name: basename(projectRoot),
    rootPath: projectRoot,
    canonicalRootPath: projectRoot,
    devflowPath: join(projectRoot, ".devflow"),
    openedAt,
  };
  const failedRun = {
    id: failureRepairRegressionFixture.failedRunId,
    nodeId: failureRepairRegressionFixture.failedLaneId,
    sessionId: failureRepairRegressionFixture.sessionId,
    projectRoot,
    worktreePath: projectRoot,
    agentKind: "codex",
    status: "failed",
    startedAt: openedAt,
    endedAt: failedEvidence.completedAt,
  };
  return {
    projects: [project],
    sessions: [canvasSession],
    changesets: {},
    agents: [],
    runs: { [failedRun.id]: failedRun },
    runEvents: { [failedRun.id]: [] },
    runEvidence: { [failedRun.id]: failedEvidence },
    activeProjectId: project.id,
    activeSessionId: canvasSession.id,
    sidebarCollapsed: false,
    collapsedProjectIds: [],
  };
}

export function repairChainTerminalState(session) {
  const nodes = Array.isArray(session?.nodes) ? session.nodes : [];
  const failed = nodes.filter((node) => node?.id === failureRepairRegressionFixture.failedLaneId);
  const repairs = nodes.filter((node) => node?.semanticSubtype === "repair");
  const regressions = nodes.filter((node) => node?.semanticSubtype === "regression_check");
  const repair = repairs[0] ?? null;
  const regression = regressions[0] ?? null;
  const failures = [];
  if (failed.length !== 1 || failed[0]?.status !== "failed") failures.push("original-lane-not-preserved-failed");
  if (repairs.length !== 1) failures.push(`repair-lane-count:${repairs.length}`);
  if (regressions.length !== 1) failures.push(`regression-lane-count:${regressions.length}`);
  if (repair && !exactStringArray(repair.context?.dependencies, [failureRepairRegressionFixture.failedLaneId])) {
    failures.push("repair-dependency-invalid");
  }
  if (regression && !exactStringArray(regression.context?.dependencies, [repair?.id])) {
    failures.push("regression-dependency-invalid");
  }
  if (repair && repair.runtimePolicy?.sandbox !== "workspace-write") failures.push("repair-sandbox-invalid");
  if (regression && regression.runtimePolicy?.sandbox !== "read-only") failures.push("regression-sandbox-invalid");
  if (repair && !repair.context?.brief?.includes(failureRepairRegressionFixture.repairInstruction)) {
    failures.push("repair-instruction-missing");
  }
  if (regression && !regression.context?.brief?.includes(failureRepairRegressionFixture.repairInstruction)) {
    failures.push("regression-instruction-missing");
  }
  const edges = Array.isArray(session?.edges) ? session.edges : [];
  if (repair && edges.filter((edge) =>
    edge?.source === failureRepairRegressionFixture.failedLaneId && edge?.target === repair.id
  ).length !== 1) failures.push("failed-repair-edge-invalid");
  if (repair && regression && edges.filter((edge) =>
    edge?.source === repair.id && edge?.target === regression.id
  ).length !== 1) failures.push("repair-regression-edge-invalid");
  const terminalFailure = [repair, regression].find((node) =>
    node && ["failed", "cancelled", "timed-out"].includes(node.status)
  ) ?? null;
  const completed = !!repair && !!regression && repair.status === "completed" && regression.status === "completed";
  return { completed, terminalFailure, failures, failed: failed[0] ?? null, repair, regression };
}

export function automaticRepairHandoffState(broadcasts) {
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
    const chain = repairChainTerminalState(session);
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
  if (!evidence || evidence.runId !== runId) return false;
  if (evidence.status !== "succeeded" || evidence.exitCode !== 0) return false;
  return (evidence.checks ?? []).some((check) =>
    check?.kind === "run-exit" &&
    check.status === "passed" &&
    typeof check.name === "string" &&
    check.name.includes("Codex CLI exit")
  );
}

export function assertSeededCheckpointAuthority(projection) {
  const runId = failureRepairRegressionFixture.failedRunId;
  const expectedBaseRefs = [
    { kind: "run", id: runId },
    { kind: "segment", id: failureRepairRegressionFixture.failedSegmentId },
  ];
  for (const phase of ["before", "after"]) {
    const evidenceId = `changeset-evidence:${runId}:${phase}`;
    const evidenceRecords = (projection?.changesetEvidence ?? []).filter((evidence) =>
      evidence?.evidenceId === evidenceId
    );
    if (evidenceRecords.length !== 1 || !isEmptyGitChangesetEvidence(evidenceRecords[0], evidenceId)) {
      throw new Error(`Seeded ${phase} checkpoint changeset evidence is not uniquely valid.`);
    }
    const checkpoints = (projection?.checkpoints ?? []).filter((checkpoint) =>
      checkpoint?.runId === runId && checkpoint?.phase === phase
    );
    const expectedRefs = [
      ...expectedBaseRefs,
      { kind: "changeset", id: evidenceId },
      ...(phase === "after"
        ? [{ kind: "evidence", id: `evidence-${failureRepairRegressionFixture.failedSegmentId}` }]
        : []),
    ];
    if (checkpoints.length !== 1 || stableJson(checkpoints[0]?.evidenceRefs) !== stableJson(expectedRefs)) {
      throw new Error(`Seeded ${phase} checkpoint evidence refs are not exact.`);
    }
    if (phase === "before" && checkpoints[0].evidenceRefs.some((ref) => ref?.kind === "evidence")) {
      throw new Error("Seeded before checkpoint must not reference terminal RunEvidence.");
    }
  }
  return true;
}

export function failureRepairRegressionSummary({
  session,
  projection,
  baselineHead,
  currentHead,
  answerSource,
  testHashUnchanged,
  gitStatusFiles,
  verificationExitCode,
}) {
  const chain = repairChainTerminalState(session);
  const failures = [...chain.failures];
  if (!chain.completed) failures.push("repair-chain-not-completed");
  if (chain.terminalFailure) failures.push(`successor-terminal-failure:${chain.terminalFailure.id}`);
  for (const [kind, node] of [["repair", chain.repair], ["regression", chain.regression]]) {
    const matchingSegments = (projection?.segments ?? []).filter((segment) =>
      segment?.laneId === node?.id && segment?.runId === node?.runId
    );
    if (matchingSegments.length !== 1 || matchingSegments[0]?.status !== "succeeded") {
      failures.push(`${kind}-segment-invalid`);
      continue;
    }
    const segment = matchingSegments[0];
    const evidence = (projection?.evidence ?? []).filter((candidate) =>
      candidate?.laneId === node.id && candidate?.segmentId === segment.id &&
      candidate?.status === "passed" && candidate?.runEvidence?.runId === node.runId
    );
    if (evidence.length !== 1 || !hasSuccessfulCodexCliExitEvidence(node.runId, evidence[0]?.runEvidence)) {
      failures.push(`${kind}-run-evidence-invalid`);
    }
  }
  if (baselineHead !== currentHead) failures.push("head-moved");
  if (!/answer\s*=\s*42\b/.test(answerSource ?? "")) failures.push("answer-not-42");
  if (testHashUnchanged !== true) failures.push("test-file-changed");
  if (!exactStringArray(gitStatusFiles, ["answer.js"])) failures.push("git-dirty-files-invalid");
  if (verificationExitCode !== 0) failures.push(`verification-exit:${String(verificationExitCode)}`);
  return {
    ok: failures.length === 0,
    failures,
    chain: {
      failedLaneId: chain.failed?.id ?? null,
      repairLaneId: chain.repair?.id ?? null,
      regressionLaneId: chain.regression?.id ?? null,
    },
  };
}

export async function seedFailureRepairRegressionStore(config) {
  const { createWorkflowStore } = await import("@skyturn/persistence/workflow-store");
  const now = "2026-07-23T00:00:00.000Z";
  const store = createWorkflowStore({ projectRoot: config.projectRoot });
  try {
    store.createWorkflowSession({
      id: failureRepairRegressionFixture.sessionId,
      projectId: failureRepairRegressionFixture.projectId,
      title: "Failure repair regression acceptance",
      goal: failureRepairRegressionFixture.repairInstruction,
      mode: "fast",
      target: { executionTarget: "current_branch", selectedBranch: config.branchName },
      plannerProfile: "default",
      transport: "hermes_replay_recovery",
      recoveryReason: "Acceptance fixture starts from durable failed validation evidence.",
      now,
    });
    store.appendWorkflowEvent({
      sessionId: failureRepairRegressionFixture.sessionId,
      kind: "workflow.lane.declared",
      source: "acceptance-fixture",
      idempotencyKey: "acceptance:failed-validation:declared",
      payload: {
        lane: {
          id: failureRepairRegressionFixture.failedLaneId,
          semanticKey: "validation:answer-contract",
          semanticSubtype: "validation",
          kind: "validation",
          title: "Validate answer contract",
          brief: "Run node --test without modifying files.",
          agentKind: "codex",
          status: "pending",
          requiredEvidence: ["test"],
          fileScopes: ["answer.js", failureRepairRegressionFixture.testFile],
          packageScopes: [],
        },
      },
      now: "2026-07-23T00:00:01.000Z",
    });
    const scheduled = store.scheduleReadyLanes(failureRepairRegressionFixture.sessionId, {
      allowedParallelism: 1,
      now: "2026-07-23T00:00:02.000Z",
    });
    if (scheduled.readyLanes.length !== 1) throw new Error("Failed acceptance lane was not scheduled exactly once.");
    const scheduledLane = scheduled.readyLanes[0];
    if (
      scheduledLane.id !== failureRepairRegressionFixture.failedLaneId ||
      scheduledLane.runId !== failureRepairRegressionFixture.failedRunId ||
      scheduledLane.segmentId !== failureRepairRegressionFixture.failedSegmentId
    ) throw new Error("Failed acceptance lane schedule identity changed.");
    const checkpointBase = {
      sessionId: failureRepairRegressionFixture.sessionId,
      nodeId: failureRepairRegressionFixture.failedLaneId,
      laneId: failureRepairRegressionFixture.failedLaneId,
      runId: failureRepairRegressionFixture.failedRunId,
      segmentId: failureRepairRegressionFixture.failedSegmentId,
      executionTarget: "current_branch",
      worktreePath: config.projectRoot,
      branchName: config.branchName,
      headCommit: config.baselineHead,
      worktreeState: "clean",
    };
    const beforeChangesetEvidence = emptyGitChangesetEvidence(
      failureRepairRegressionFixture.failedRunId,
      "before",
      "2026-07-23T00:00:03.000Z",
    );
    appendCheckpointChangesetEvidence(store, checkpointBase, "before", beforeChangesetEvidence);
    store.recordRunCheckpoint({
      ...checkpointBase,
      phase: "before",
      evidenceRefs: [
        { kind: "run", id: failureRepairRegressionFixture.failedRunId },
        { kind: "segment", id: failureRepairRegressionFixture.failedSegmentId },
        { kind: "changeset", id: beforeChangesetEvidence.evidenceId },
      ],
      now: "2026-07-23T00:00:04.000Z",
    });
    const failedEvidence = {
      runId: failureRepairRegressionFixture.failedRunId,
      status: "failed",
      exitCode: 1,
      changesetId: null,
      checks: [
        { kind: "test", name: "node --test", status: "failed", detail: "Expected 42 but received 41." },
        { kind: "run-exit", name: "Codex CLI exit", status: "failed", detail: "exit 1" },
      ],
      artifacts: [],
      review: null,
      errorReason: "node --test failed: expected 42 but received 41.",
      cancelReason: null,
      completedAt: "2026-07-23T00:00:05.000Z",
    };
    store.recordRunResult({
      sessionId: failureRepairRegressionFixture.sessionId,
      laneId: failureRepairRegressionFixture.failedLaneId,
      segmentId: failureRepairRegressionFixture.failedSegmentId,
      runId: failureRepairRegressionFixture.failedRunId,
      agentKind: "codex",
      outputSummary: "node --test failed: expected 42 but received 41.",
      evidence: failedEvidence,
      now: failedEvidence.completedAt,
    });
    const failedProjection = store.materializeFlowProjection(failureRepairRegressionFixture.sessionId);
    const projectedEvidence = failedProjection.evidence.find((candidate) =>
      candidate?.laneId === failureRepairRegressionFixture.failedLaneId &&
      candidate?.segmentId === failureRepairRegressionFixture.failedSegmentId &&
      candidate?.runEvidence?.runId === failureRepairRegressionFixture.failedRunId
    );
    if (!projectedEvidence?.id) throw new Error("Failed RunEvidence did not materialize.");
    const afterChangesetEvidence = emptyGitChangesetEvidence(
      failureRepairRegressionFixture.failedRunId,
      "after",
      "2026-07-23T00:00:06.000Z",
    );
    appendCheckpointChangesetEvidence(store, checkpointBase, "after", afterChangesetEvidence);
    store.recordRunCheckpoint({
      ...checkpointBase,
      phase: "after",
      evidenceRefs: [
        { kind: "run", id: failureRepairRegressionFixture.failedRunId },
        { kind: "segment", id: failureRepairRegressionFixture.failedSegmentId },
        { kind: "changeset", id: afterChangesetEvidence.evidenceId },
        { kind: "evidence", id: projectedEvidence.id },
      ],
      now: "2026-07-23T00:00:07.000Z",
    });
    const seededProjection = store.materializeFlowProjection(failureRepairRegressionFixture.sessionId);
    assertSeededCheckpointAuthority(seededProjection);
    const canvasSession = store.materializeCanvasSession(failureRepairRegressionFixture.sessionId);
    if (!canvasSession) throw new Error("Failed acceptance CanvasSession did not materialize.");
    const workspace = createSeedWorkspaceState({
      projectRoot: config.projectRoot,
      canvasSession,
      failedEvidence,
      openedAt: now,
    });
    await mkdir(dirname(config.workspacePath), { recursive: true });
    await writeFile(config.workspacePath, `${JSON.stringify(workspace, null, 2)}\n`);
    return {
      sessionId: canvasSession.id,
      projection: seededProjection,
      canvasSession,
      workspace,
    };
  } finally {
    store.close();
  }
}

function emptyGitChangesetEvidence(runId, phase, collectedAt) {
  return {
    evidenceId: `changeset-evidence:${runId}:${phase}`,
    changesetId: `changeset:${runId}:${phase}`,
    source: "git",
    status: "empty",
    files: [],
    diffStat: { added: 0, changed: 0, deleted: 0 },
    patchPreviewTruncated: false,
    collectedAt,
  };
}

function appendCheckpointChangesetEvidence(store, checkpoint, phase, evidence) {
  store.appendWorkflowEvent({
    sessionId: checkpoint.sessionId,
    kind: "workflow.changeset.evidence_recorded",
    source: "acceptance-fixture",
    laneId: checkpoint.laneId,
    segmentId: checkpoint.segmentId,
    idempotencyKey: `checkpoint-changeset:${checkpoint.runId}:${phase}`,
    payload: { laneId: checkpoint.laneId, segmentId: checkpoint.segmentId, evidence },
    now: evidence.collectedAt,
  });
}

function isEmptyGitChangesetEvidence(evidence, expectedEvidenceId) {
  return evidence?.evidenceId === expectedEvidenceId &&
    typeof evidence.changesetId === "string" && evidence.changesetId.length > 0 &&
    evidence.source === "git" && evidence.status === "empty" &&
    exactStringArray(evidence.files, []) &&
    evidence.diffStat?.added === 0 && evidence.diffStat?.changed === 0 && evidence.diffStat?.deleted === 0 &&
    evidence.patchPreviewTruncated === false &&
    typeof evidence.collectedAt === "string" && evidence.collectedAt.length > 0;
}

export async function inspectFailureRepairRegressionStore(config) {
  const { createWorkflowStore } = await import("@skyturn/persistence/workflow-store");
  const store = createWorkflowStore({ projectRoot: config.projectRoot });
  try {
    return {
      projection: store.materializeFlowProjection(failureRepairRegressionFixture.sessionId),
      canvasSession: store.materializeCanvasSession(failureRepairRegressionFixture.sessionId),
    };
  } finally {
    store.close();
  }
}

export async function submitRepairThroughUi(cdp, instruction = failureRepairRegressionFixture.repairInstruction) {
  const result = await cdp.evaluate(`
    (async () => {
      const laneId = ${JSON.stringify(failureRepairRegressionFixture.failedLaneId)};
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
        const diagnostic = JSON.stringify({
          nodePressed: node.getAttribute('aria-pressed'),
          repairFound: Boolean(candidate),
          repairDisabled: candidate?.disabled ?? null,
          repairTitle: candidate?.getAttribute('title') ?? null,
        });
        throw new Error(error.message + ': ' + diagnostic);
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
  if (result?.submitted !== true || result.instruction !== instruction) {
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
  let baselineHead = null;
  let testHash = null;

  try {
    await seedNodeProject(projectRoot);
    baselineHead = (await runCommand("git", ["rev-parse", "HEAD"], projectRoot)).stdout.trim();
    const branchName = (await runCommand("git", ["branch", "--show-current"], projectRoot)).stdout.trim();
    testHash = await sha256File(join(projectRoot, failureRepairRegressionFixture.testFile));
    const seeded = await runElectronNodeMode("--seed", { projectRoot, workspacePath, baselineHead, branchName });
    if (seeded.canvasSession?.nodes?.filter((node) => node.id === failureRepairRegressionFixture.failedLaneId).length !== 1) {
      throw new Error("Seeded failed lane was not production-shaped.");
    }

    app = await launchElectronAcceptanceApp({ userData, projectRoot });
    liveCdp = await connectToReadySkyTurnRenderer({
      cdpPort: app.cdpPort,
      devServerUrl: app.devServerUrl,
      projectRoot,
      processDiagnostics: app.diagnostics,
    });
    await waitForStoredProjectRegistration(liveCdp, projectRoot);
    await installRepairHandoffCollector(liveCdp, projectRoot);
    let handoffError = null;
    try {
      await submitRepairThroughUi(liveCdp);
      await waitForRepairChain(liveCdp);
    } catch (error) {
      handoffError = error;
    }
    try {
      await uninstallRepairHandoffCollector(liveCdp);
    } catch (error) {
      handoffError ??= error;
    }
    if (handoffError) throw handoffError;
    const completed = await readStableAuthoritativeState(liveCdp, projectRoot);
    const completedChain = repairChainTerminalState(completed.canvasSession);
    if (!completedChain.completed || completedChain.terminalFailure || completedChain.failures.length > 0) {
      throw new Error(`Final authoritative chain is invalid: ${boundedDiagnostic(JSON.stringify(completedChain))}`);
    }
    const firstClose = await finalizeAcceptanceOutcome({ app, liveCdp, ok: true });
    app = null;
    liveCdp = null;
    if (!firstClose.ok) throw new Error(firstClose.diagnostic ?? "First Electron close failed.");

    const reopened = await runElectronNodeMode("--inspect", { projectRoot });
    if (stableJson(reopened.canvasSession) !== stableJson(completed.canvasSession) ||
        stableJson(reopened.projection) !== stableJson(completed.projection)) {
      throw new Error(`SQLite reopen did not preserve the completed authoritative projection: ${boundedDiagnostic(JSON.stringify({
        canvasSession: differingTopLevelKeys(completed.canvasSession, reopened.canvasSession),
        projection: differingTopLevelKeys(completed.projection, reopened.projection),
      }))}`);
    }

    const verification = await collectProjectVerification(projectRoot, baselineHead, testHash);
    const summary = failureRepairRegressionSummary({
      session: reopened.canvasSession,
      projection: reopened.projection,
      ...verification,
    });
    if (!summary.ok) throw new Error(`Acceptance predicates failed: ${summary.failures.join(", ")}`);

    app = await launchElectronAcceptanceApp({ userData, projectRoot });
    liveCdp = await connectToReadySkyTurnRenderer({
      cdpPort: app.cdpPort,
      devServerUrl: app.devServerUrl,
      projectRoot,
      processDiagnostics: app.diagnostics,
    });
    await waitForStoredProjectRegistration(liveCdp, projectRoot);
    const restarted = await readAuthoritativeState(liveCdp, projectRoot);
    if (stableJson(restarted) !== stableJson(reopened)) {
      throw new Error("Electron restart changed the authoritative session or created duplicate workflow facts.");
    }
    const restartChain = repairChainTerminalState(restarted.canvasSession);
    if (!restartChain.completed || restartChain.failures.length > 0) {
      throw new Error(`Restarted chain is invalid: ${restartChain.failures.join(", ")}`);
    }
    const finalClose = await finalizeAcceptanceOutcome({ app, liveCdp, ok: true });
    app = null;
    liveCdp = null;
    if (!finalClose.ok) throw new Error(finalClose.diagnostic ?? "Restarted Electron close failed.");

    succeeded = true;
    console.log(JSON.stringify({
      ok: true,
      failure: null,
      projectRoot,
      userData,
      workspacePath,
      baselineHead,
      instruction: failureRepairRegressionFixture.repairInstruction,
      summary,
      laneStatuses: restarted.canvasSession.nodes.map((node) => ({
        id: node.id,
        semanticSubtype: node.semanticSubtype ?? null,
        runId: node.runId ?? null,
        status: node.status,
        dependencies: node.context?.dependencies ?? [],
      })),
      verification,
      sqliteReopenPreserved: true,
      electronRestartPreserved: true,
    }, null, 2));
  } catch (error) {
    const cleanup = await finalizeAcceptanceOutcome({ app, liveCdp, error });
    cleanupConfirmed = cleanup.cleanupConfirmed;
    app = null;
    liveCdp = null;
    console.log(JSON.stringify({
      ok: false,
      failure: {
        code: "FAILURE_REPAIR_REGRESSION_ACCEPTANCE_FAILED",
        message: "Real Electron failure to repair to regression acceptance failed.",
        diagnostic: boundedDiagnostic(error instanceof Error ? error.message : String(error)),
      },
      projectRoot,
      userData,
      workspacePath,
      baselineHead,
      instruction: failureRepairRegressionFixture.repairInstruction,
      cleanup,
    }, null, 2));
    process.exitCode = 1;
  } finally {
    if (succeeded && process.env.SKYTURN_FAILURE_REPAIR_CLEANUP === "1") {
      await rm(projectRoot, { recursive: true, force: true });
    }
    if (succeeded && process.env.SKYTURN_FAILURE_REPAIR_KEEP_USER_DATA !== "1") {
      await rm(userData, { recursive: true, force: true });
    }
    if (!succeeded && !cleanupConfirmed) {
      process.exitCode = 1;
    }
  }
}

async function installRepairHandoffCollector(cdp, projectRoot) {
  const installed = await cdp.evaluate(`
    (() => {
      const key = ${JSON.stringify(handoffCollectorKey)};
      const existing = window[key];
      if (existing?.unsubscribe) existing.unsubscribe();
      const state = { broadcasts: [], overflow: false, cloneFailure: false };
      const unsubscribe = window.devflow.onWorkflowEvent((event) => {
        if (event?.projectRoot !== ${JSON.stringify(projectRoot)} ||
            event?.sessionId !== ${JSON.stringify(failureRepairRegressionFixture.sessionId)} ||
            !event?.projection || !event?.canvasSession) return;
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
  if (installed !== true) throw new Error("Automatic handoff broadcast collector was not installed.");
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
  if (removed !== true) throw new Error("Automatic handoff broadcast collector was not removed.");
}

async function readRepairHandoffCollector(cdp) {
  return await cdp.evaluate(`
    (() => {
      const collector = window[${JSON.stringify(handoffCollectorKey)}];
      return collector ? collector.state : null;
    })()
  `, { returnByValue: true });
}

async function waitForRepairChain(cdp) {
  const deadline = Date.now() + waitTimeoutMs;
  let last = null;
  while (Date.now() < deadline) {
    const collector = await readRepairHandoffCollector(cdp);
    if (!collector) throw new Error("Automatic handoff broadcast collector disappeared.");
    if (collector.overflow) throw new Error("Automatic handoff broadcast collector overflowed.");
    if (collector.cloneFailure) throw new Error("Automatic handoff broadcast collector could not snapshot an event.");
    const state = automaticRepairHandoffState(collector.broadcasts);
    last = state;
    if (state.failures.length > 0) {
      throw new Error(`Automatic handoff broadcast invalid: ${boundedDiagnostic(JSON.stringify(state))}`);
    }
    if (state.readyForFinalRead) return state;
    await delay(pollIntervalMs);
  }
  throw new Error(`Timed out waiting for broadcast-only automatic repair and regression: ${boundedDiagnostic(JSON.stringify(last))}`);
}

async function readAuthoritativeState(cdp, projectRoot) {
  const value = await cdp.evaluate(`
    window.devflow.workflow.getProjection(
      ${JSON.stringify(projectRoot)},
      ${JSON.stringify(failureRepairRegressionFixture.sessionId)}
    ).then((result) => ({ projection: result.projection, canvasSession: result.canvasSession }))
  `, { awaitPromise: true, returnByValue: true });
  if (!value?.projection || !value?.canvasSession) throw new Error("Authoritative workflow projection is unavailable.");
  return value;
}

async function readStableAuthoritativeState(cdp, projectRoot) {
  const deadline = Date.now() + waitTimeoutMs;
  let previous = null;
  let stableReads = 0;
  while (Date.now() < deadline) {
    const current = await readAuthoritativeState(cdp, projectRoot);
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

async function collectProjectVerification(projectRoot, baselineHead, expectedTestHash) {
  const [head, status, test, answerSource, actualTestHash] = await Promise.all([
    runCommand("git", ["rev-parse", "HEAD"], projectRoot),
    runCommand("git", ["status", "--short"], projectRoot),
    runCommand(process.execPath, ["--test"], projectRoot, { allowFailure: true }),
    readFile(join(projectRoot, "answer.js"), "utf8"),
    sha256File(join(projectRoot, failureRepairRegressionFixture.testFile)),
  ]);
  return {
    baselineHead,
    currentHead: head.stdout.trim(),
    answerSource,
    testHashUnchanged: actualTestHash === expectedTestHash,
    gitStatusFiles: parseGitStatusFiles(status.stdout),
    gitStatus: status.stdout.trim(),
    verificationExitCode: test.code,
    verificationOutput: boundedDiagnostic(`${test.stdout}\n${test.stderr}`.trim()),
  };
}

async function seedNodeProject(projectRoot) {
  await writeFile(join(projectRoot, "package.json"), `${JSON.stringify({
    name: "skyturn-failure-repair-fixture",
    private: true,
    type: "module",
    scripts: { test: "node --test" },
  }, null, 2)}\n`);
  await writeFile(join(projectRoot, ".gitignore"), ".devflow/\n");
  await writeFile(join(projectRoot, "answer.js"), "export const answer = 41;\n");
  await writeFile(join(projectRoot, failureRepairRegressionFixture.testFile), [
    'import assert from "node:assert/strict";',
    'import test from "node:test";',
    'import { answer } from "./answer.js";',
    "",
    'test("answer is 42", () => {',
    "  assert.equal(answer, 42);",
    "});",
    "",
  ].join("\n"));
  await runCommand("git", ["init", "-b", "main"], projectRoot);
  await runCommand("git", ["config", "user.name", "SkyTurn Acceptance"], projectRoot);
  await runCommand("git", ["config", "user.email", "acceptance@skyturn.local"], projectRoot);
  await runCommand("git", ["add", ".gitignore", "package.json", "answer.js", failureRepairRegressionFixture.testFile], projectRoot);
  await runCommand("git", ["commit", "-m", "test: seed failing answer contract"], projectRoot);
}

async function runElectronNodeMode(mode, config) {
  const electronBinary = require("electron");
  const result = await runCommand(electronBinary, [scriptPath, mode, JSON.stringify(config)], dirname(scriptPath), {
    env: { ...process.env, ELECTRON_RUN_AS_NODE: "1" },
  });
  const prefix = mode === "--seed" ? seedResultPrefix : inspectResultPrefix;
  const line = result.stdout.split("\n").find((candidate) => candidate.startsWith(prefix));
  if (!line) throw new Error(`Electron ${mode} did not return a structured result: ${boundedDiagnostic(result.stdout + result.stderr)}`);
  return JSON.parse(line.slice(prefix.length));
}

function parseGitStatusFiles(value) {
  return value.split("\n").filter(Boolean).map((line) => line.slice(3).trim()).sort();
}

function exactStringArray(actual, expected) {
  return Array.isArray(actual) && actual.length === expected.length &&
    actual.every((value, index) => value === expected[index]);
}

function stableJson(value) {
  return JSON.stringify(value, (_key, nested) => {
    if (!nested || typeof nested !== "object" || Array.isArray(nested)) return nested;
    return Object.fromEntries(Object.entries(nested).sort(([left], [right]) => left.localeCompare(right)));
  });
}

function differingTopLevelKeys(left, right) {
  const leftRecord = left && typeof left === "object" && !Array.isArray(left) ? left : {};
  const rightRecord = right && typeof right === "object" && !Array.isArray(right) ? right : {};
  return [...new Set([...Object.keys(leftRecord), ...Object.keys(rightRecord)])]
    .filter((key) => stableJson(leftRecord[key]) !== stableJson(rightRecord[key]));
}

function boundedDiagnostic(value) {
  const text = String(value);
  if (Buffer.byteLength(text) <= diagnosticLimitBytes) return text;
  const marker = "... [truncated]";
  return `${Buffer.from(text).subarray(0, diagnosticLimitBytes - Buffer.byteLength(marker)).toString("utf8").replace(/\uFFFD$/, "")}${marker}`;
}

function sha256File(path) {
  return readFile(path).then((value) => createHash("sha256").update(value).digest("hex"));
}

function runCommand(command, args, cwd, { allowFailure = false, env = process.env } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { cwd, env, stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => { stdout += chunk.toString(); });
    child.stderr.on("data", (chunk) => { stderr += chunk.toString(); });
    child.once("error", reject);
    child.once("close", (code, signal) => {
      const result = { code: code ?? (signal ? 1 : 0), signal, stdout, stderr };
      if (result.code === 0 || allowFailure) resolve(result);
      else reject(new Error(`${command} ${args.join(" ")} failed (${signal ?? result.code}): ${boundedDiagnostic(stderr || stdout)}`));
    });
  });
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function runRuntimeMode() {
  const mode = process.argv[2];
  const config = JSON.parse(process.argv[3] ?? "null");
  if (mode === "--seed") {
    console.log(`${seedResultPrefix}${JSON.stringify(await seedFailureRepairRegressionStore(config))}`);
    return true;
  }
  if (mode === "--inspect") {
    console.log(`${inspectResultPrefix}${JSON.stringify(await inspectFailureRepairRegressionStore(config))}`);
    return true;
  }
  return false;
}

if (process.argv[1] === scriptPath) {
  runRuntimeMode().then((handled) => {
    if (!handled) return runFailureRepairRegressionAcceptance();
  }).catch((error) => {
    console.error(boundedDiagnostic(error instanceof Error ? error.stack ?? error.message : String(error)));
    process.exitCode = 1;
  });
}
