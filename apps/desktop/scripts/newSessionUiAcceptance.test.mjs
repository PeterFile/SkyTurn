import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import net from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

const root = new URL("..", import.meta.url);
const strictNodeIds = {
  implementation: "n-7f3a",
  validation: "n-a910",
  browserValidation: "n-02cd",
  review: "n-d44e",
  commit: "n-5be1",
  followUp: "n-c08f",
};
const strictRunIds = {
  implementation: "r-18b2",
  validation: "r-f06c",
  browserValidation: "r-991d",
  review: "r-3ae7",
  commit: "r-742f",
  followUp: "r-b511",
};
const baselineHead = "a".repeat(40);
const finalHead = "b".repeat(40);

test("New Session UI acceptance opens the project and drives both real renderer inputs", async () => {
  const source = await readFile(new URL("newSessionUiAcceptance.mjs", import.meta.url), "utf8");

  assert.match(source, /button[^\n]*Open Project|findButtonByText\(['"]Open Project['"]\)/);
  assert.match(source, /openProjectThroughUi/);
  assert.match(source, /textarea\[aria-label="New task goal"\]/);
  assert.match(source, /button\[aria-label="Create"\]/);
  assert.match(source, /fillTextareaAndClickCreate/);
  assert.match(source, /input\[aria-label="Insert requirement or node"\]/);
  assert.match(source, /submitCanvasInput/);
  assert.match(source, /launchElectronAcceptanceApp/);
  assert.match(source, /--remote-debugging-port=/);
  assert.match(source, /--user-data-dir=/);
  assert.doesNotMatch(source, /createWorkflowSession\(/);
});

test("New Session UI acceptance clears the selected node through the pane before submitting a follow-up", async () => {
  const { submitCanvasInput } = await import("./newSessionUiAcceptance.mjs");
  let expression = "";
  const cdp = {
    async evaluate(value) {
      expression = value;
    },
  };

  await submitCanvasInput(cdp, "Follow-up requirement");

  const paneIndex = expression.indexOf("document.querySelector('.react-flow__pane')");
  const paneClickIndex = expression.indexOf("pane.dispatchEvent(new MouseEvent('click'");
  const modalClosedIndex = expression.indexOf("!document.querySelector('.node-modal')");
  const genericComposerIndex = expression.indexOf(
    "document.querySelector('input[aria-label=\"Insert requirement or node\"]')",
  );

  assert.ok(paneIndex >= 0);
  assert.ok(paneClickIndex > paneIndex);
  assert.ok(modalClosedIndex > paneClickIndex);
  assert.ok(genericComposerIndex > modalClosedIndex);
  assert.match(expression, /'Canvas pane'/);
  assert.match(expression, /'node modal close'/);
  assert.match(expression, /'generic Canvas input'/);
  assert.match(expression, /const deadline = Date\.now\(\) \+ 15000/);
  assert.match(expression, /reject\(new Error\('Timed out waiting for ' \+ label\)\)/);
  assert.match(expression, /new InputEvent\('input'/);
  assert.match(expression, /new Event\('change'/);
  assert.match(expression, /button\.dispatchEvent\(new MouseEvent\('click'/);
  assert.doesNotMatch(
    expression,
    /window\.devflow|workflow:|session:|decision:|answerUserDecision|createWorkflowSession/,
  );
});

test("New Session UI acceptance selects only exact pending danger run authorizations", async () => {
  const { pendingDangerAuthorizationNodes } = await import("./newSessionUiAcceptance.mjs");
  const exact = pendingDangerAuthorizationNode();
  const session = {
    kind: "canvas",
    nodes: [
      exact,
      pendingDangerAuthorizationNode({
        id: "decision-answered",
        userDecision: { status: "answered" },
      }),
      pendingDangerAuthorizationNode({
        id: "decision-ordinary",
        userDecision: { runAuthorization: undefined },
      }),
      pendingDangerAuthorizationNode({
        id: "decision-workspace-write",
        userDecision: { runAuthorization: { sandbox: "workspace-write" } },
      }),
      pendingDangerAuthorizationNode({
        id: "decision-inexact-option",
        userDecision: { options: ["Authorize this run "] },
      }),
    ],
  };

  assert.deepEqual(pendingDangerAuthorizationNodes(session), [exact]);
});

test("New Session UI acceptance rejects unbound danger run authorizations", async () => {
  const { pendingDangerAuthorizationNodes } = await import("./newSessionUiAcceptance.mjs");
  const cases = [
    ["decision id", { userDecision: { decisionId: "decision-stale" } }],
    ["lane", { userDecision: { targetLaneId: undefined } }],
    ["segment", { userDecision: { targetSegmentId: undefined } }],
    ["run", { userDecision: { runAuthorization: { runId: undefined } } }],
    ["fingerprint", { userDecision: { runAuthorization: { startFingerprint: undefined } } }],
  ];

  for (const [name, overrides] of cases) {
    const session = { kind: "canvas", nodes: [pendingDangerAuthorizationNode(overrides)] };
    assert.deepEqual(pendingDangerAuthorizationNodes(session), [], name);
  }
});

test("New Session UI acceptance passes live CDP into workflow completion and drives the real decision DOM", async () => {
  const { authorizePendingDangerRunThroughUi } = await import("./newSessionUiAcceptance.mjs");
  const source = await readFile(new URL("newSessionUiAcceptance.mjs", import.meta.url), "utf8");
  let expression = "";
  let evaluationOptions = null;
  const cdp = {
    async evaluate(value, options) {
      expression = value;
      evaluationOptions = options;
      return { outcome: "submitted", modalClosed: true };
    },
  };

  await authorizePendingDangerRunThroughUi(cdp, pendingDangerAuthorizationNode(), {
    now: () => 1_000,
  });

  assert.match(source, /waitForWorkflowCompletion\(\{\s*\n\s*cdp: liveCdp,/);
  assert.match(source, /async function waitForWorkflowCompletion\(\{ cdp,/);
  assert.match(source, /authorizePendingDangerRunThroughUi\(cdp, pendingDangerNodes\[0\]\)/);
  assert.match(expression, /querySelectorAll\('button\[aria-label\]'\)/);
  assert.match(expression, /More details for/);
  assert.match(expression, /querySelectorAll\('\.react-flow__node\[data-id\]'\)/);
  assert.match(expression, /findExactAriaLabel\('\.node-modal\[aria-label\]', title\)/);
  assert.match(expression, /querySelectorAll\('\.decision-panel\[aria-label\]'\)/);
  assert.match(expression, /Authorize this run/);
  assert.match(expression, /const authorizationDeadline = 76000/);
  assert.doesNotMatch(expression, /const authorizationDeadline = Date\.now\(\)/);
  assert.doesNotMatch(expression, /const deadline = Date\.now\(\) \+ 15000/);
  assert.doesNotMatch(expression, /requestAnimationFrame/);
  assert.match(expression, /setTimeout\(callback, 16\)/);
  assert.match(expression, /if \(now\(\) >= deadline\)/);
  assert.ok(expression.indexOf("if (now() >= deadline)") < expression.indexOf("const value = probe()"));
  assert.ok(
    expression.indexOf("assertBeforeDeadline(authorizationDeadline)") <
      expression.indexOf("authorizationButton.dispatchEvent"),
  );
  assert.match(expression, /if \(!authorizationButton\.disabled\)/);
  assert.match(expression, /authorizationButton\.disabled/);
  assert.deepEqual(evaluationOptions, {
    awaitPromise: true,
    returnByValue: true,
    requestTimeoutMs: 90_000,
  });
  assert.doesNotMatch(expression, /workflow:userDecision:answer|answerUserDecision|createWorkflowSession/);
});

test("danger authorization wait rejects an expired deadline before probing or scheduling", async () => {
  const { assertBrowserDeadline, waitForBrowserProbe } = await import("./newSessionUiAcceptance.mjs");
  let probeCalls = 0;
  let scheduleCalls = 0;

  await assert.rejects(
    waitForBrowserProbe(
      () => {
        probeCalls += 1;
        return true;
      },
      "danger authorization",
      {
        deadline: 75,
        now: () => 75,
        schedule: () => {
          scheduleCalls += 1;
        },
      },
    ),
    /Timed out waiting for danger authorization/,
  );
  assert.equal(probeCalls, 0);
  assert.equal(scheduleCalls, 0);
  assert.throws(
    () => assertBrowserDeadline(75, { now: () => 75 }),
    /Danger authorization deadline expired/,
  );
  assert.doesNotThrow(() => assertBrowserDeadline(75, { now: () => 74 }));
});

test("New Session UI acceptance disables PTY and scopes the dialog override to its temporary project", async () => {
  const source = await readFile(new URL("newSessionUiAcceptance.mjs", import.meta.url), "utf8");

  assert.match(source, /SKYTURN_ENABLE_PTY_INTERACTIVE: "0"/);
  assert.match(source, /Math\.min\(12 \* 60 \* 1_000, waitTimeoutMs - 60_000\)/);
  assert.match(source, /SKYTURN_AGENT_WATCHDOG_TIMEOUT_MS: String\(agentWatchdogTimeoutMs\)/);
  assert.match(source, /SKYTURN_NEW_SESSION_UI_ACCEPTANCE:\s*"1"/);
  assert.match(source, /SKYTURN_NEW_SESSION_UI_PROJECT_ROOT:\s*projectRoot/);
});

test("New Session UI acceptance verifies stable planner identity and deterministic reopened projection", async () => {
  const { authoritativePlannerTurnCount, plannerTurnReplayVerification } = await import("./newSessionUiAcceptance.mjs");
  const first = authoritativePlannerState("run-planner-1", "First input", ["lane-1"]);
  const second = authoritativePlannerState("run-planner-2", "Second input", ["lane-1", "lane-2"]);
  const reopened = structuredClone(second);

  const result = plannerTurnReplayVerification({ first, second, reopened });

  assert.equal(first.projection.segments.some((segment) => segment.laneId === first.canvasSession.plannerNodeId), false);
  assert.equal(second.projection.segments.some((segment) => segment.laneId === second.canvasSession.plannerNodeId), false);
  assert.equal(authoritativePlannerTurnCount(first), 1);
  assert.equal(authoritativePlannerTurnCount(second), 2);
  assert.equal(result.ok, true);
  assert.equal(result.plannerSessionId, "planner-session-1");
  assert.equal(result.plannerNodeId, "planner-node-1");
  assert.deepEqual(result.plannerRunIds, ["run-planner-1", "run-planner-2"]);
  assert.deepEqual(result.inputReplay, ["First input", "Second input"]);
  assert.equal(result.reopenedProjectionMatches, true);
});

test("New Session UI acceptance waits for terminal checkpoint enrichment before restart", async () => {
  const { authoritativeWorkflowSettled } = await import("./newSessionUiAcceptance.mjs");
  const runId = "run-lane-1";
  const segmentId = "segment-lane-1";
  const evidenceId = "opaque-evidence-lane-1";
  const state = {
    canvasSession: {
      plannerNodeId: "planner",
      nodes: [
        { id: "planner", status: "completed" },
        { id: "lane-1", runId, status: "completed" },
        {
          id: "manual-decision",
          nodeKind: "user_decision",
          laneKind: "decision",
          status: "pending",
          userDecision: { status: "waiting_input" },
        },
      ],
    },
    projection: {
      segments: [{ id: segmentId, laneId: "lane-1", runId, status: "succeeded", exitCode: 0 }],
      evidence: [{
        id: evidenceId,
        laneId: "lane-1",
        segmentId,
        status: "passed",
        runEvidence: { runId, status: "succeeded", exitCode: 0, checks: [], artifacts: [] },
      }],
      changesetEvidence: [],
      checkpoints: [],
    },
  };

  assert.equal(authoritativeWorkflowSettled(state), false);
  state.projection.checkpoints.push({
    laneId: "lane-1",
    runId,
    segmentId,
    phase: "after",
    evidenceRefs: [
      { kind: "run", id: runId },
      { kind: "segment", id: segmentId },
      { kind: "changeset", id: `changeset-evidence:${runId}:after` },
      { kind: "evidence", id: evidenceId },
    ],
  });
  state.projection.changesetEvidence.push(checkpointChangesetEvidence(runId, "after"));
  assert.equal(authoritativeWorkflowSettled(state), false);
  state.canvasSession.nodes[2].status = "completed";
  state.canvasSession.nodes[2].userDecision.status = "answered";
  assert.equal(authoritativeWorkflowSettled(state), true);
  state.canvasSession.nodes.push({
    id: "lane-follow-up",
    nodeKind: "agent_task",
    agent: "codex",
    status: "pending",
  });
  assert.equal(authoritativeWorkflowSettled(state), false);
});

test("New Session UI acceptance rejects malformed authoritative after-checkpoint references", async () => {
  const { authoritativeWorkflowSettled } = await import("./newSessionUiAcceptance.mjs");

  for (const [name, mutate] of checkpointReferenceMutationCases("lane-1", "after")) {
    const state = authoritativeSettledFixture();
    assert.equal(authoritativeWorkflowSettled(state), true, `${name}: valid fixture`);
    mutate(state);
    assert.equal(authoritativeWorkflowSettled(state), false, name);
  }
});

test("New Session UI acceptance builds its evidence map only from passed authoritative projection evidence", async () => {
  const { authoritativeProjectionEvidenceState } = await import("./newSessionUiAcceptance.mjs");
  const passed = successfulOpaqueEvidence("run-projection-passed", "codex");
  const failed = {
    ...successfulOpaqueEvidence("run-projection-failed", "codex"),
    status: "failed",
    exitCode: 1,
  };
  const state = authoritativeProjectionEvidenceState({
    evidence: [
      {
        id: "evidence-passed",
        laneId: "lane-passed",
        segmentId: "segment-passed",
        status: "passed",
        runEvidence: passed,
      },
      {
        id: "evidence-failed",
        laneId: "lane-failed",
        segmentId: "segment-failed",
        status: "failed",
        runEvidence: failed,
      },
      {
        id: "evidence-invalid-run-id",
        laneId: "lane-invalid",
        segmentId: "segment-invalid",
        status: "passed",
        runEvidence: { ...passed, runId: "" },
      },
    ],
  });

  assert.equal(state.ok, true);
  assert.deepEqual(Object.keys(state.runEvidence), ["run-projection-passed"]);
  assert.equal(state.runEvidence["run-projection-passed"], passed);
  assert.deepEqual(state.records.map((record) => record.runEvidence.runId), [
    "run-projection-passed",
    "run-projection-failed",
  ]);
});

test("New Session UI acceptance fails closed on duplicate or conflicting projection evidence for one run", async () => {
  const { authoritativeProjectionEvidenceState } = await import("./newSessionUiAcceptance.mjs");
  const evidence = successfulOpaqueEvidence("run-projection-duplicate", "codex");
  const cases = [
    ["duplicate", structuredClone(evidence)],
    ["conflict", { ...structuredClone(evidence), exitCode: 9 }],
  ];

  for (const [kind, second] of cases) {
    const state = authoritativeProjectionEvidenceState({
      evidence: [
        {
          id: "evidence-first",
          laneId: "lane-first",
          segmentId: "segment-first",
          status: "passed",
          runEvidence: evidence,
        },
        {
          id: "evidence-second",
          laneId: "lane-first",
          segmentId: "segment-first",
          status: "passed",
          runEvidence: second,
        },
      ],
    });

    assert.equal(state.ok, false, kind);
    assert.equal(
      state.failures.includes(`projection-run-evidence-${kind}:run-projection-duplicate`),
      true,
      kind,
    );
  }
});

test("New Session UI acceptance ignores empty or forged workspace evidence and requires projection evidence", async () => {
  const {
    authoritativeProjectionEvidenceState,
    strictWorkflowAcceptanceSummary,
  } = await import("./newSessionUiAcceptance.mjs");
  const fixture = strictWorkflowFixture();
  const authoritativeEvidence = authoritativeProjectionEvidenceState(fixture.projection);

  const emptyWorkspaceResult = strictWorkflowAcceptanceSummary({
    ...fixture,
    authoritativeEvidence,
    workspace: { runEvidence: {} },
  });
  assert.equal(emptyWorkspaceResult.ok, true);

  const forgedFailureWorkspace = structuredClone(fixture.workspace);
  for (const evidence of Object.values(forgedFailureWorkspace.runEvidence)) {
    evidence.status = "failed";
    evidence.exitCode = 99;
  }
  const forgedFailureResult = strictWorkflowAcceptanceSummary({
    ...fixture,
    authoritativeEvidence,
    workspace: forgedFailureWorkspace,
  });
  assert.equal(forgedFailureResult.ok, true);

  const missingProjection = structuredClone(fixture.projection);
  missingProjection.evidence = missingProjection.evidence.filter(
    (evidence) => evidence.laneId !== strictNodeIds.implementation,
  );
  const forgedSuccessResult = strictWorkflowAcceptanceSummary({
    ...fixture,
    authoritativeEvidence: authoritativeProjectionEvidenceState(missingProjection),
    projection: missingProjection,
    workspace: structuredClone(fixture.workspace),
  });
  assert.equal(forgedSuccessResult.ok, false);
  assert.equal(forgedSuccessResult.failures.includes("initial-lane-evidence-invalid"), true);
});

test("New Session UI acceptance replaces only the persisted authoritative session with a stale clone", async () => {
  const { overwriteWorkspaceSessionWithStaleClone } = await import("./newSessionUiAcceptance.mjs");
  const userData = await mkdtemp(join(tmpdir(), "skyturn-new-session-stale-workspace-"));
  const workspacePath = join(userData, "workspace.json");
  const authoritativeSession = authoritativePlannerState(
    "run-planner-2",
    "Second input",
    ["lane-1", "lane-2"],
  ).canvasSession;
  const otherSession = {
    id: "session-other",
    kind: "canvas",
    nodes: [{ id: "other-node", status: "completed", progress: "Other session is untouched" }],
    edges: [],
  };
  const workspace = {
    activeSessionId: authoritativeSession.id,
    sessions: [authoritativeSession, otherSession],
    runEvidence: { "run-planner-2": { status: "succeeded" } },
  };

  try {
    await writeFile(workspacePath, `${JSON.stringify(workspace, null, 2)}\n`);
    const staleSession = await overwriteWorkspaceSessionWithStaleClone(workspacePath, authoritativeSession);
    const persisted = JSON.parse(await readFile(workspacePath, "utf8"));

    assert.equal(staleSession.id, authoritativeSession.id);
    assert.equal(staleSession.hermesPlannerSessionId, authoritativeSession.hermesPlannerSessionId);
    assert.equal(staleSession.plannerNodeId, authoritativeSession.plannerNodeId);
    assert.notDeepEqual(staleSession, authoritativeSession);
    assert.equal(staleSession.nodes.every((node) => node.status === "pending"), true);
    assert.equal(staleSession.nodes.every((node) => node.progress === "Stale renderer workspace snapshot"), true);
    assert.deepEqual(persisted.sessions, [staleSession, otherSession]);
    assert.deepEqual(persisted.runEvidence, workspace.runEvidence);
  } finally {
    await rm(userData, { recursive: true, force: true });
  }
});

test("New Session UI acceptance injects the stale workspace only after persistence and before restart", async () => {
  const source = await readFile(new URL("newSessionUiAcceptance.mjs", import.meta.url), "utf8");
  const persistedIndex = source.indexOf("await waitForWorkspaceSession(workspacePath, secondAuthoritative.canvasSession)");
  const closeIndex = source.indexOf("await app.close()", persistedIndex);
  const staleIndex = source.indexOf("await overwriteWorkspaceSessionWithStaleClone", closeIndex);
  const relaunchIndex = source.indexOf("app = await launchElectronAcceptanceApp", staleIndex);

  assert.ok(persistedIndex >= 0);
  assert.ok(closeIndex > persistedIndex);
  assert.ok(staleIndex > closeIndex);
  assert.ok(relaunchIndex > staleIndex);
  assert.match(source, /inspectRendererProjection\(liveCdp, reopenedAuthoritative\.canvasSession\)/);
  assert.match(source, /stableJson\(reopened\) === stableJson\(second\)/);
});

test("New Session UI acceptance registers the stored project through public workspace loading", async () => {
  const { waitForStoredProjectRegistration } = await import("./newSessionUiAcceptance.mjs");
  const projectRoot = "/tmp/project-exact";
  const evaluations = [];
  const workspace = {
    projects: [
      { rootPath: "/tmp/project" },
      { rootPath: projectRoot },
    ],
  };
  const cdp = {
    async evaluate(expression, options) {
      evaluations.push({ expression, options });
      return workspace;
    },
  };

  const loaded = await waitForStoredProjectRegistration(cdp, projectRoot);

  assert.equal(loaded, workspace);
  assert.equal(evaluations.length, 1);
  assert.match(evaluations[0].expression, /window\.devflow\.loadWorkspace\(\)/);
  assert.doesNotMatch(evaluations[0].expression, /project:open|getWorkflowProjection|getWorkflowEvents/);
  assert.deepEqual(evaluations[0].options, { awaitPromise: true, returnByValue: true });
});

test("New Session UI acceptance requires exact stored project root membership", async () => {
  const { waitForStoredProjectRegistration } = await import("./newSessionUiAcceptance.mjs");
  const cdp = {
    async evaluate() {
      return {
        projects: [
          { rootPath: "/tmp/project" },
          { rootPath: "/tmp/project-exact/child" },
        ],
      };
    },
  };

  await assert.rejects(
    waitForStoredProjectRegistration(cdp, "/tmp/project-exact"),
    /Stored project was not registered by workspace loading/,
  );
});

test("New Session UI acceptance registers the stored project before reopened workflow reads", async () => {
  const source = await readFile(new URL("newSessionUiAcceptance.mjs", import.meta.url), "utf8");
  const restartBoundary = source.indexOf("await overwriteWorkspaceSessionWithStaleClone");
  const launchIndex = source.indexOf("app = await launchElectronAcceptanceApp", restartBoundary);
  const connectIndex = source.indexOf("liveCdp = await connectToReadySkyTurnRenderer", launchIndex);
  const registrationIndex = source.indexOf("await waitForStoredProjectRegistration(liveCdp, projectRoot)", connectIndex);
  const plannerTurnsIndex = source.indexOf("const reopenedAuthoritative = await waitForAuthoritativePlannerTurns", connectIndex);
  const projectionIndex = source.indexOf("const rendererReplay = await inspectRendererProjection", plannerTurnsIndex);

  assert.ok(restartBoundary >= 0);
  assert.ok(launchIndex > restartBoundary);
  assert.ok(connectIndex > launchIndex);
  assert.ok(registrationIndex > connectIndex);
  assert.ok(plannerTurnsIndex > registrationIndex);
  assert.ok(projectionIndex > plannerTurnsIndex);
});

test("New Session UI acceptance requires exact-case delivery strings without CSS text transformation", async () => {
  const source = await readFile(new URL("newSessionUiAcceptance.mjs", import.meta.url), "utf8");

  assert.match(source, /All three strings must render with exact case; CSS text-transform must not alter them\./);
  assert.match(source, /appSource\.includes\("SkyTurn delivery complete"\)/);
  assert.match(source, /appSource\.includes\("Hermes -> Codex"\)/);
  assert.match(source, /appSource\.includes\("Ready for verification"\)/);
});

test("New Session UI acceptance rejects a reconciled planner event with missing safe turn facts", async () => {
  const { plannerTurnReplayVerification } = await import("./newSessionUiAcceptance.mjs");
  const first = authoritativePlannerState("run-planner-1", "First input", ["lane-1"]);
  const second = authoritativePlannerState("run-planner-2", "Second input", ["lane-1", "lane-2"]);
  const reconciled = second.events.find((event) => event.segmentId === "segment-planner-2");
  delete reconciled.payload.plannerTurn;

  const result = plannerTurnReplayVerification({ first, second, reopened: structuredClone(second) });

  assert.equal(result.ok, false);
  assert.match(result.diagnostic, /planner-run-evidence-invalid/);
});

test("New Session UI acceptance rejects safe planner turn facts whose segmentId mismatches the event", async () => {
  const { plannerTurnReplayVerification } = await import("./newSessionUiAcceptance.mjs");
  const first = authoritativePlannerState("run-planner-1", "First input", ["lane-1"]);
  const second = authoritativePlannerState("run-planner-2", "Second input", ["lane-1", "lane-2"]);
  const reconciled = second.events.find((event) => event.segmentId === "segment-planner-2");
  reconciled.payload.plannerTurn.segmentId = "segment-planner-stale";

  const result = plannerTurnReplayVerification({ first, second, reopened: structuredClone(second) });

  assert.equal(result.ok, false);
  assert.match(result.diagnostic, /planner-run-evidence-invalid/);
});

test("New Session UI acceptance rejects successful planner reconciliation without accepted intent", async () => {
  const { plannerTurnReplayVerification } = await import("./newSessionUiAcceptance.mjs");
  const first = authoritativePlannerState("run-planner-1", "First input", ["lane-1"]);
  const second = authoritativePlannerState("run-planner-2", "Second input", ["lane-1", "lane-2"]);
  second.events = second.events.filter((event) => event.kind !== "workflow.intent.accepted");

  const result = plannerTurnReplayVerification({ first, second, reopened: structuredClone(second) });

  assert.equal(result.ok, false);
  assert.match(result.diagnostic, /planner-intent-not-accepted/);
});

test("New Session UI acceptance rejects accepted intent outside the second turn sequence window", async () => {
  const { plannerTurnReplayVerification } = await import("./newSessionUiAcceptance.mjs");
  const first = authoritativePlannerState("run-planner-1", "First input", ["lane-1"]);
  const second = authoritativePlannerState("run-planner-2", "Second input", ["lane-1", "lane-2"]);
  const accepted = second.events.filter((event) => event.kind === "workflow.intent.accepted")[1];
  accepted.seq = 45;

  const result = plannerTurnReplayVerification({ first, second, reopened: structuredClone(second) });

  assert.equal(result.ok, false);
  assert.match(result.diagnostic, /planner-intent-not-accepted/);
});

test("New Session UI acceptance rejects unrelated accepted intent and completed lane inside the turn window", async () => {
  const { plannerTurnReplayVerification } = await import("./newSessionUiAcceptance.mjs");
  const first = authoritativePlannerState("run-planner-1", "First input", ["lane-1"]);
  const second = authoritativePlannerState("run-planner-2", "Second input", ["lane-1", "lane-2"]);
  for (const event of second.events) {
    if (event.seq > 50 && event.seq < 80 &&
      (event.kind === "workflow.intent.accepted" || event.kind === "workflow.lane.declared")) {
      event.causationId = "run-unrelated-interleaved";
    }
  }

  const result = plannerTurnReplayVerification({ first, second, reopened: structuredClone(second) });

  assert.equal(second.canvasSession.nodes.find((node) => node.id === "lane-2").status, "completed");
  assert.equal(second.projection.segments.find((segment) => segment.laneId === "lane-2").status, "succeeded");
  assert.equal(result.ok, false);
  assert.match(result.diagnostic, /planner-intent-not-accepted/);
});

test("New Session UI acceptance ignores interleaved semantic facts from another planner run", async () => {
  const { plannerTurnReplayVerification } = await import("./newSessionUiAcceptance.mjs");
  const first = authoritativePlannerState("run-planner-1", "First input", ["lane-1"]);
  const second = authoritativePlannerState("run-planner-2", "Second input", ["lane-1", "lane-2"]);
  second.events.push(
    safeWorkflowEvent(61, "workflow.intent.accepted", "planner-node-1", "run-interleaved"),
    safeWorkflowEvent(71, "workflow.lane.declared", "lane-spoof", "run-interleaved"),
  );

  const result = plannerTurnReplayVerification({ first, second, reopened: structuredClone(second) });

  assert.equal(result.ok, true);
  assert.deepEqual(result.secondTurnLaneIds, ["lane-2"]);
});

test("New Session UI acceptance requires a lane declaration in the second turn", async () => {
  const { plannerTurnReplayVerification } = await import("./newSessionUiAcceptance.mjs");
  const first = authoritativePlannerState("run-planner-1", "First input", ["lane-1"]);
  const second = authoritativePlannerState("run-planner-2", "Second input", ["lane-1", "lane-2"]);
  second.events = second.events.filter((event) =>
    event.kind !== "workflow.lane.declared" || event.laneId !== "lane-2"
  );

  const result = plannerTurnReplayVerification({ first, second, reopened: structuredClone(second) });

  assert.equal(result.ok, false);
  assert.match(result.diagnostic, /second-turn-operation-not-declared/);
});

test("New Session UI acceptance requires exactly one unique authoritative second-turn lane", async () => {
  const { plannerTurnReplayVerification } = await import("./newSessionUiAcceptance.mjs");
  const cases = [
    ["zero", (state) => {
      state.events = state.events.filter((event) =>
        event.kind !== "workflow.lane.declared" || event.seq < 50
      );
    }],
    ["two", (state) => {
      state.canvasSession.nodes.push(completedOpaqueNode({
        id: "opaque-follow-up-second",
        runId: "opaque-run-follow-up-second",
        laneKind: "review",
        agent: "hermes",
        dependencies: ["opaque-commit"],
      }));
      state.projection.segments.push(successfulOpaqueSegment(
        "opaque-follow-up-second",
        "opaque-run-follow-up-second",
        "hermes",
      ));
      state.events.push(safeWorkflowEvent(
        72,
        "workflow.lane.declared",
        "opaque-follow-up-second",
        "run-planner-2",
      ));
    }],
    ["duplicate", (state) => {
      state.events.push(safeWorkflowEvent(72, "workflow.lane.declared", "lane-2", "run-planner-2"));
    }],
  ];

  for (const [name, mutate] of cases) {
    const first = authoritativePlannerState("run-planner-1", "First input", ["lane-1"]);
    const second = authoritativePlannerState("run-planner-2", "Second input", ["lane-1", "lane-2"]);
    mutate(second);
    const result = plannerTurnReplayVerification({ first, second, reopened: structuredClone(second) });

    assert.equal(result.ok, false, name);
    assert.match(result.diagnostic, /second-turn-lane-set-invalid/, name);
  }
});

test("New Session UI acceptance rejects a second-turn declaration that reuses an existing lane", async () => {
  const { plannerTurnReplayVerification } = await import("./newSessionUiAcceptance.mjs");
  const first = authoritativePlannerState("run-planner-1", "First input", ["lane-1"]);
  const second = authoritativePlannerState("run-planner-2", "Second input", ["lane-1", "lane-2"]);
  second.events.find((event) => event.seq === 70).laneId = "lane-1";

  const result = plannerTurnReplayVerification({ first, second, reopened: structuredClone(second) });

  assert.equal(result.ok, false);
  assert.match(result.diagnostic, /second-turn-operation-not-declared/);
});

test("New Session UI acceptance rejects a declared second-turn lane absent from projection", async () => {
  const { plannerTurnReplayVerification } = await import("./newSessionUiAcceptance.mjs");
  const first = authoritativePlannerState("run-planner-1", "First input", ["lane-1"]);
  const second = authoritativePlannerState("run-planner-2", "Second input", ["lane-1", "lane-2"]);
  second.projection.segments = second.projection.segments.filter((segment) => segment.laneId !== "lane-2");

  const result = plannerTurnReplayVerification({ first, second, reopened: structuredClone(second) });

  assert.equal(result.ok, false);
  assert.match(result.diagnostic, /second-turn-operation-projection-mismatch/);
});

test("New Session UI acceptance requires the declared second-turn lane to complete after reopen", async () => {
  const { plannerTurnReplayVerification } = await import("./newSessionUiAcceptance.mjs");
  const first = authoritativePlannerState("run-planner-1", "First input", ["lane-1"]);
  const second = authoritativePlannerState("run-planner-2", "Second input", ["lane-1", "lane-2"]);
  second.projection.segments.find((segment) => segment.laneId === "lane-2").status = "running";
  second.canvasSession.nodes.find((node) => node.id === "lane-2").status = "running";

  const result = plannerTurnReplayVerification({ first, second, reopened: structuredClone(second) });

  assert.equal(result.ok, false);
  assert.match(result.diagnostic, /second-turn-operation-not-completed/);
});

test("New Session UI acceptance fail-fast readiness runs before Electron launch", async () => {
  const source = await readFile(new URL("newSessionUiAcceptance.mjs", import.meta.url), "utf8");
  const preflightIndex = source.indexOf("const readinessPreflight = await demoReadinessPreflight(bridge)");
  const failFastIndex = source.indexOf("if (readinessPreflight.failFast)");
  const launchIndex = source.indexOf("await launchElectronAcceptanceApp");

  assert.ok(preflightIndex >= 0, "script must discover Hermes/Codex readiness.");
  assert.ok(failFastIndex > preflightIndex, "script must evaluate readiness after discovery.");
  assert.ok(launchIndex > failFastIndex, "script must not launch Electron before readiness passes.");
});

test("New Session UI acceptance keeps the verification script as fixed evidence", async () => {
  const { fileSha256 } = await import("./newSessionUiAcceptance.mjs");
  const source = await readFile(new URL("newSessionUiAcceptance.mjs", import.meta.url), "utf8");
  const projectRoot = await mkdtemp(join(tmpdir(), "skyturn-new-session-fixed-verify-test-"));
  const verifyScript = join(projectRoot, "verify.mjs");

  try {
    await writeFile(verifyScript, "console.log('fixed contract');\n");
    const firstHash = await fileSha256(verifyScript);
    await writeFile(verifyScript, "console.log('tampered contract');\n");
    const secondHash = await fileSha256(verifyScript);

    assert.notEqual(firstHash, secondHash);
    assert.match(source, /Do not modify scripts\/verify\.mjs/);
    assert.match(source, /scripts\/capture-screenshot\.mjs/);
    assert.match(source, /Only src\/App\.jsx and src\/App\.css may be changed or committed/);
    assert.match(source, /verification-script-changed/);
    assert.match(source, /unexpected-delivery-files/);
    assert.match(source, /verificationScript: verification\.verificationScript/);
  } finally {
    await rm(projectRoot, { recursive: true, force: true });
  }
});

test("New Session UI acceptance reports required real-run acceptance fields", async () => {
  const source = await readFile(new URL("newSessionUiAcceptance.mjs", import.meta.url), "utf8");

  assert.match(source, /mockFallback/);
  assert.match(source, /sessionTarget/);
  assert.match(source, /verificationCommand/);
  assert.match(source, /commitSha/);
  assert.match(source, /gitStatus/);
  assert.match(source, /clean/);
  assert.match(source, /verificationScriptHashUnchanged/);
  assert.match(source, /captureScriptHashUnchanged/);
  assert.match(source, /unexpectedChangedFiles/);
});

test("New Session UI acceptance guards both fixed validation scripts by checksum", async () => {
  const source = await readFile(new URL("newSessionUiAcceptance.mjs", import.meta.url), "utf8");

  assert.match(source, /expectedVerifyScriptHash/);
  assert.match(source, /expectedCaptureScriptHash/);
  assert.match(source, /actualVerifyScriptHash/);
  assert.match(source, /actualCaptureScriptHash/);
  assert.match(source, /captureScriptHashUnchanged/);
});

test("New Session UI acceptance requires the explicit five-lane delivery chain", async () => {
  const source = await readFile(new URL("newSessionUiAcceptance.mjs", import.meta.url), "utf8");

  assert.match(source, /sessionTarget\?\.executionTarget === "current_branch"/);
  assert.match(source, /implementation -> validation -> browser_validation -> review -> commit/);
  assert.match(source, /do not emit StartImplementation, RequestValidation, RequestReview, or Commit operations/);
  assert.match(source, /\.devflow\/acceptance\/react-app\.png/);
  assert.match(source, /laneKindEvidence/);
  assert.match(source, /secondTurnLaneIds: replay\.secondTurnLaneIds/);
  assert.match(source, /requiredLaneEvidenceSummary\(session, authoritativeEvidence, secondTurnLaneIds\)/);
  assert.doesNotMatch(source, /workspace\??\.runEvidence/);
});

test("New Session UI acceptance bounds verification command output", async () => {
  const { boundedCommandOutput } = await import("./newSessionUiAcceptance.mjs");
  const summary = boundedCommandOutput({
    code: 7,
    stdout: "a".repeat(5200),
    stderr: "b".repeat(5201),
  }, 128);

  assert.equal(summary.code, 7);
  assert.equal(summary.stdout.length, 128);
  assert.equal(summary.stderr.length, 128);
  assert.equal(summary.stdoutBytes, 5200);
  assert.equal(summary.stderrBytes, 5201);
  assert.equal(summary.stdoutTruncated, true);
  assert.equal(summary.stderrTruncated, true);
});

test("New Session UI acceptance rejects unexpected files from any delivery commit since baseline", async () => {
  const { deliveryFileRangeVerification } = await import("./newSessionUiAcceptance.mjs");
  const baselineCommitSha = "a".repeat(40);
  const headCommitSha = "b".repeat(40);

  const result = deliveryFileRangeVerification({
    baselineCommitSha,
    headCommitSha,
    changedFilesSinceBaseline: [
      "src/App.jsx",
      "package.json",
      "src/App.css",
      "src/App.jsx",
    ],
    expectedChangedFiles: ["src/App.css", "src/App.jsx"],
  });

  assert.equal(result.baselineCommitSha, baselineCommitSha);
  assert.equal(result.headCommitSha, headCommitSha);
  assert.deepEqual(result.changedFiles, ["package.json", "src/App.css", "src/App.jsx"]);
  assert.deepEqual(result.unexpectedChangedFiles, ["package.json"]);
  assert.deepEqual(result.missingChangedFiles, []);
  assert.equal(result.ok, false);
});

test("New Session UI acceptance collects delivery files from baseline range, not the last commit", async () => {
  const source = await readFile(new URL("newSessionUiAcceptance.mjs", import.meta.url), "utf8");

  assert.match(source, /baselineCommitSha/);
  assert.doesNotMatch(source, /HEAD~1\.\.HEAD/);
});

test("New Session UI acceptance omits renderer workspace evidence from terminal failure results", async () => {
  const {
    authoritativeProjectionEvidenceState,
    workflowTerminalFailureResult,
  } = await import("./newSessionUiAcceptance.mjs");
  const failedEvidence = {
    runId: "run-codex-1",
    status: "failed",
    exitCode: 1,
    changesetId: null,
    checks: [{ kind: "run-exit", name: "Codex CLI exit", status: "failed", detail: "exit 1" }],
    artifacts: [],
    review: null,
    errorReason: "tests failed",
    cancelReason: null,
    completedAt: "2026-07-06T00:00:00.000Z",
  };
  const workspace = {
    activeSessionId: "session-1",
    sessions: [{
      id: "session-1",
      kind: "canvas",
      plannerNodeId: "node-hermes",
      target: { executionTarget: "current_branch", selectedBranch: "main" },
      nodes: [{
        id: "node-codex",
        runId: "run-codex-1",
        agent: "codex",
        title: "Implement UI",
        status: "failed",
        display: { meta: ["flow-kernel", "implementation"] },
      }],
    }],
    runEvidence: {
      "run-codex-1": {
        ...failedEvidence,
        status: "succeeded",
        exitCode: 0,
        rendererForgery: "forged-workspace-evidence",
      },
    },
  };
  const session = workspace.sessions[0];
  const projection = {
    segments: [{
      id: "segment-codex-1",
      laneId: "node-codex",
      runId: "run-codex-1",
      status: "failed",
      exitCode: 1,
    }],
    evidence: [{
      id: "evidence-codex-1",
      laneId: "node-codex",
      segmentId: "segment-codex-1",
      status: "failed",
      runEvidence: failedEvidence,
    }],
  };
  const authoritativeEvidence = authoritativeProjectionEvidenceState(projection);

  const result = workflowTerminalFailureResult({
    authoritativeEvidence,
    projection,
    projectRoot: "/tmp/project",
    readiness: { status: "ready", checks: { mockFallback: false } },
    session,
    workspacePath: "/tmp/workspace.json",
  });

  assert.equal(result.ok, false);
  assert.equal(result.failure.code, "WORKFLOW_RUN_FAILED");
  assert.equal(result.projectRoot, "/tmp/project");
  assert.equal(result.workspacePath, "/tmp/workspace.json");
  const serializedResult = JSON.stringify(result);
  assert.equal(Object.hasOwn(result, "latestWorkspace"), false);
  assert.equal(serializedResult.includes("\"latestWorkspace\""), false);
  assert.equal(serializedResult.includes("forged-workspace-evidence"), false);
  assert.equal(result.runEvidence["run-codex-1"].status, "failed");
  assert.equal(result.runEvidence["run-codex-1"].exitCode, 1);
  assert.equal(result.agentRunEvidence.codex[0].runId, "run-codex-1");
  assert.equal(result.agentRunEvidence.codex[0].evidenceRunId, "run-codex-1");
  assert.deepEqual(result.laneStatuses.map((node) => node.status), ["failed"]);
  assert.deepEqual(Object.keys(result.laneKindEvidence.lanes), [
    "implementation",
    "validation",
    "browser_validation",
    "review",
    "commit",
  ]);
});

test("New Session UI acceptance agent evidence requires matching runId and CLI exit check", async () => {
  const { hasSuccessfulRunEvidenceForAgent } = await import("./newSessionUiAcceptance.mjs");
  const session = {
    plannerNodeId: "node-hermes",
    nodes: [{
      id: "node-hermes",
      runId: "run-hermes-1",
      agent: "hermes",
      title: "Plan workflow",
      status: "completed",
      display: { meta: ["flow-kernel", "planner"] },
    }],
  };
  const baseEvidence = {
    runId: "run-hermes-1",
    status: "succeeded",
    exitCode: 0,
    changesetId: null,
    checks: [{ kind: "run-exit", name: "Hermes CLI exit", status: "passed", detail: "exit 0" }],
    artifacts: [],
    review: null,
    errorReason: null,
    cancelReason: null,
    completedAt: "2026-07-06T00:00:00.000Z",
  };

  assert.equal(hasSuccessfulRunEvidenceForAgent(session, authoritativeEvidenceFixture({
    "run-hermes-1": { ...baseEvidence, runId: "run-stale" },
  }), "hermes"), false);
  assert.equal(hasSuccessfulRunEvidenceForAgent(session, authoritativeEvidenceFixture({
    "run-hermes-1": { ...baseEvidence, checks: [{ kind: "test", name: "unit", status: "passed" }] },
  }), "hermes"), false);
  assert.equal(hasSuccessfulRunEvidenceForAgent(session, authoritativeEvidenceFixture({
    "run-hermes-1": {
      ...baseEvidence,
      checks: [{ kind: "run-exit", name: "Mock adapter exit", status: "passed" }],
    },
  }), "hermes"), false);
  assert.equal(hasSuccessfulRunEvidenceForAgent(session, authoritativeEvidenceFixture({
    "run-hermes-1": baseEvidence,
  }), "hermes"), true);
});

test("New Session UI acceptance validates production-shaped terminal evidence for every required lane kind", async () => {
  const { requiredLaneEvidenceSummary } = await import("./newSessionUiAcceptance.mjs");
  const { session, authoritativeEvidence } = completeRequiredLaneEvidenceFixture();

  const result = requiredLaneEvidenceSummary(session, authoritativeEvidence);

  assert.equal(result.ok, true);
  assert.deepEqual(Object.keys(result.lanes), [
    "implementation",
    "validation",
    "browser_validation",
    "review",
    "commit",
  ]);
  assert.equal(Object.values(result.lanes).every((lane) => lane.ok), true);
  assert.equal(Object.values(result.lanes).every((lane) => lane.candidateCount === 1), true);
  assert.equal(result.lanes.validation.nodeId, "lane-validation");
  assert.equal(result.lanes.browser_validation.nodeId, "lane-browser-validation");
  assert.deepEqual(result.lanes.browser_validation.requiredEvidence, ["browser", "screenshot"]);
  assert.deepEqual(result.lanes.browser_validation.artifacts, [".devflow/acceptance/react-app.png"]);
});

test("New Session UI acceptance rejects a duplicate required lane kind even when one candidate succeeded", async () => {
  const { requiredLaneEvidenceSummary } = await import("./newSessionUiAcceptance.mjs");
  const { session, authoritativeEvidence } = completeRequiredLaneEvidenceFixture();
  const implementation = requiredLaneFixtureNode(session, "implementation");
  const duplicate = structuredClone(implementation);
  duplicate.id = "lane-implementation-duplicate";
  duplicate.runId = "run-implementation-duplicate";
  duplicate.status = "failed";
  session.nodes.push(duplicate);
  authoritativeEvidence.runEvidence[duplicate.runId] = {
    ...structuredClone(authoritativeEvidence.runEvidence[implementation.runId]),
    runId: duplicate.runId,
    status: "failed",
    exitCode: 1,
  };

  const result = requiredLaneEvidenceSummary(session, authoritativeEvidence);

  assert.equal(result.ok, false);
  assert.equal(result.lanes.implementation.candidateCount, 2);
  assert.equal(result.lanes.implementation.failures.includes("duplicate-lane-kind"), true);
});

test("New Session UI acceptance rejects parallel required lanes", async () => {
  const { requiredLaneEvidenceSummary } = await import("./newSessionUiAcceptance.mjs");
  const { session, authoritativeEvidence } = completeRequiredLaneEvidenceFixture();
  requiredLaneFixtureNode(session, "validation").context.dependencies = [];

  const result = requiredLaneEvidenceSummary(session, authoritativeEvidence);

  assert.equal(result.ok, false);
  assert.equal(result.lanes.validation.failures.includes("dependency-mismatch"), true);
});

test("New Session UI acceptance rejects a required lane wired to the wrong predecessor", async () => {
  const { requiredLaneEvidenceSummary } = await import("./newSessionUiAcceptance.mjs");
  const { session, authoritativeEvidence } = completeRequiredLaneEvidenceFixture();
  requiredLaneFixtureNode(session, "review").context.dependencies = [
    requiredLaneFixtureNode(session, "implementation").id,
  ];

  const result = requiredLaneEvidenceSummary(session, authoritativeEvidence);

  assert.equal(result.ok, false);
  assert.equal(result.lanes.review.failures.includes("dependency-mismatch"), true);
});

test("New Session UI acceptance rejects a second-turn review candidate without an exclusion", async () => {
  const { requiredLaneEvidenceSummary } = await import("./newSessionUiAcceptance.mjs");
  const { session, authoritativeEvidence } = completeRequiredLaneEvidenceFixture();
  session.nodes.push({
    id: "lane-evidence-recheck",
    agent: "codex",
    title: "Evidence recheck",
    status: "pending",
    laneKind: "review",
    semanticSubtype: "evidence_recheck",
    requiredEvidence: [],
    display: { meta: ["review", "lane-evidence-recheck", "flow-kernel"] },
    context: { dependencies: [requiredLaneFixtureNode(session, "commit").id] },
  });

  const result = requiredLaneEvidenceSummary(session, authoritativeEvidence);

  assert.equal(result.ok, false);
  assert.equal(result.lanes.review.candidateCount, 2);
  assert.equal(result.lanes.review.failures.includes("duplicate-lane-kind"), true);
});

test("New Session UI acceptance excludes an authoritative second-turn lane id", async () => {
  const { requiredLaneEvidenceSummary } = await import("./newSessionUiAcceptance.mjs");
  const { session, authoritativeEvidence } = completeRequiredLaneEvidenceFixture();
  session.nodes.push({
    id: "lane-evidence-recheck",
    agent: "codex",
    title: "Evidence recheck",
    status: "pending",
    laneKind: "review",
    semanticSubtype: "evidence_recheck",
    requiredEvidence: [],
    display: { meta: ["review", "lane-evidence-recheck", "flow-kernel"] },
    context: { dependencies: [requiredLaneFixtureNode(session, "commit").id] },
  });

  const result = requiredLaneEvidenceSummary(session, authoritativeEvidence, ["lane-evidence-recheck"]);

  assert.equal(result.ok, true);
  assert.equal(result.lanes.review.candidateCount, 1);
  assert.equal(result.lanes.review.nodeId, "lane-review");
});

test("New Session UI acceptance strict oracle accepts opaque ids and arbitrary titles", async () => {
  const { strictWorkflowAcceptanceSummary } = await import("./newSessionUiAcceptance.mjs");
  const fixture = strictWorkflowFixture();

  const result = strictWorkflowAcceptanceSummary(fixture);

  assert.equal(result.ok, true);
  assert.deepEqual(result.failures, []);
  assert.equal(result.nonPlannerNodeCount, 6);
  assert.equal(result.initialNodeCount, 5);
  assert.equal(result.followUp.nodeId, fixture.secondTurnLaneIds[0]);
  assert.equal(result.deliveryCheckpoints.ok, true);
  assert.equal(result.deliveryCheckpoints.deliveryCommitCount, 1);
});

test("New Session UI acceptance excludes authorization decisions from executable graph and strict lane oracles", async () => {
  const {
    executableWorkflowSession,
    strictWorkflowAcceptanceSummary,
  } = await import("./newSessionUiAcceptance.mjs");
  const { flowKernelGraphSummary } = await import("./mvpWorkflowDemo.mjs");
  const graphSession = {
    plannerNodeId: "planner",
    nodes: [
      {
        id: "planner",
        agent: "hermes",
        title: "Planner",
        context: { brief: "planner", dependencies: [] },
        display: { meta: ["planner"] },
      },
      {
        id: "implementation",
        nodeKind: "agent_task",
        agent: "codex",
        title: "Implementation",
        context: { brief: "implementation", dependencies: [] },
        display: { meta: ["implementation", "flow-kernel"] },
      },
      {
        id: "validation",
        nodeKind: "agent_task",
        agent: "codex",
        title: "Validation",
        context: { brief: "validation", dependencies: ["implementation"] },
        display: { meta: ["validation", "flow-kernel"] },
      },
      {
        id: "danger-full-access-decision",
        nodeKind: "user_decision",
        agent: "hermes",
        context: { brief: "authorization", dependencies: ["implementation"] },
        display: { meta: ["decision", "flow-kernel"] },
      },
      {
        id: "disabled-node",
        nodeKind: "agent_task",
        executable: false,
        agent: "codex",
        title: "Disabled",
        context: { brief: "disabled", dependencies: [] },
        display: { meta: ["implementation", "flow-kernel"] },
      },
      {
        id: "runtime-disabled-node",
        nodeKind: "agent_task",
        runtimePolicy: { executable: false, sandbox: "read-only" },
        agent: "codex",
        title: "Runtime disabled",
        context: { brief: "runtime disabled", dependencies: [] },
        display: { meta: ["validation", "flow-kernel"] },
      },
    ],
    edges: [{ id: "edge-implementation-validation", source: "implementation", target: "validation" }],
  };

  const executableSession = executableWorkflowSession(graphSession);
  const graph = flowKernelGraphSummary(executableSession, graphSession.plannerNodeId);
  assert.deepEqual(executableSession.nodes.map((node) => node.id), ["planner", "implementation", "validation"]);
  assert.equal(graph.connected, true);
  assert.deepEqual(graph.dependencyMismatchIds, []);

  const fixture = strictWorkflowFixture();
  fixture.session.nodes.push(
    pendingDangerAuthorizationNode({
      id: "danger-full-access-browser",
      status: "completed",
      runId: "decision-run-browser",
      userDecision: { status: "answered" },
    }),
    pendingDangerAuthorizationNode({
      id: "danger-full-access-commit",
      status: "completed",
      runId: "decision-run-commit",
      userDecision: { status: "answered" },
    }),
    {
      id: "disabled-node",
      nodeKind: "agent_task",
      executable: false,
    },
    {
      id: "runtime-disabled-node",
      nodeKind: "agent_task",
      runtimePolicy: { executable: false, sandbox: "read-only" },
    },
  );

  const result = strictWorkflowAcceptanceSummary(fixture);
  assert.equal(result.ok, true);
  assert.equal(result.nonPlannerNodeCount, 6);
  assert.equal(result.initialNodeCount, 5);
});

test("New Session UI acceptance rejects an unresolved ordinary user decision", async () => {
  const { strictWorkflowAcceptanceSummary } = await import("./newSessionUiAcceptance.mjs");
  const fixture = strictWorkflowFixture();
  fixture.session.nodes.push({
    id: "manual-decision",
    nodeKind: "user_decision",
    status: "pending",
    userDecision: {
      decisionId: "manual-decision",
      prompt: "Choose a delivery option.",
      options: ["Continue"],
      reason: "A user choice is required.",
      status: "waiting_input",
    },
  });

  const result = strictWorkflowAcceptanceSummary(fixture);
  assert.equal(result.ok, false);
  assert.equal(result.failures.includes("user-decisions-not-settled"), true);
});

test("New Session UI acceptance rejects an implementation commit followed by a commit-lane no-op", async () => {
  const { strictWorkflowAcceptanceSummary } = await import("./newSessionUiAcceptance.mjs");
  const fixture = strictWorkflowFixture();

  for (const nodeId of [
    strictNodeIds.implementation,
    strictNodeIds.validation,
    strictNodeIds.browserValidation,
    strictNodeIds.review,
    strictNodeIds.commit,
  ]) {
    setLaneCheckpointHeads(fixture, nodeId, finalHead, finalHead);
  }
  setLaneCheckpointHeads(fixture, strictNodeIds.implementation, baselineHead, finalHead);

  const result = strictWorkflowAcceptanceSummary(fixture);

  assert.equal(result.ok, false);
  assert.equal(result.failures.includes("delivery-checkpoints-invalid"), true);
  assert.equal(result.deliveryCheckpoints.lanes.implementation.failures.includes("head-moved"), true);
  assert.equal(result.deliveryCheckpoints.lanes.commit.failures.includes("before-head-mismatch"), true);
});

test("New Session UI acceptance rejects multiple delivery commits", async () => {
  const { strictWorkflowAcceptanceSummary } = await import("./newSessionUiAcceptance.mjs");
  const fixture = strictWorkflowFixture();
  fixture.deliveryCommitCount = 2;

  const result = strictWorkflowAcceptanceSummary(fixture);

  assert.equal(result.ok, false);
  assert.deepEqual(result.deliveryCheckpoints.failures, ["delivery-commit-count:2"]);
});

test("New Session UI acceptance rejects a non-commit lane HEAD move", async () => {
  const { strictWorkflowAcceptanceSummary } = await import("./newSessionUiAcceptance.mjs");
  const fixture = strictWorkflowFixture();
  setLaneCheckpointHeads(fixture, strictNodeIds.validation, baselineHead, "c".repeat(40));

  const result = strictWorkflowAcceptanceSummary(fixture);

  assert.equal(result.ok, false);
  assert.deepEqual(result.deliveryCheckpoints.lanes.validation.failures, ["after-head-mismatch", "head-moved"]);
});

test("New Session UI acceptance rejects missing or mismatched checkpoint run identity", async () => {
  const { strictWorkflowAcceptanceSummary } = await import("./newSessionUiAcceptance.mjs");
  const cases = [
    ["missing before", (fixture) => {
      fixture.projection.checkpoints = fixture.projection.checkpoints.filter((checkpoint) =>
        !(checkpoint.laneId === strictNodeIds.review && checkpoint.phase === "before")
      );
    }],
    ["mismatched run", (fixture) => {
      laneCheckpoint(fixture, strictNodeIds.review, "after").runId = "r-mismatched";
    }],
  ];

  for (const [name, mutate] of cases) {
    const fixture = strictWorkflowFixture();
    mutate(fixture);
    const result = strictWorkflowAcceptanceSummary(fixture);
    assert.equal(result.ok, false, name);
    assert.equal(result.failures.includes("delivery-checkpoints-invalid"), true, name);
    assert.equal(result.deliveryCheckpoints.lanes.review.ok, false, name);
  }
});

test("New Session UI acceptance strict delivery gate rejects malformed checkpoint references", async () => {
  const { strictWorkflowAcceptanceSummary } = await import("./newSessionUiAcceptance.mjs");

  for (const phase of ["before", "after"]) {
    for (const [name, mutate] of checkpointReferenceMutationCases(strictNodeIds.review, phase)) {
      const fixture = strictWorkflowFixture();
      assert.equal(strictWorkflowAcceptanceSummary(fixture).ok, true, `${phase} ${name}: valid fixture`);
      mutate(fixture);
      const result = strictWorkflowAcceptanceSummary(fixture);
      assert.equal(result.ok, false, `${phase} ${name}`);
      assert.equal(result.failures.includes("delivery-checkpoints-invalid"), true, `${phase} ${name}`);
      assert.equal(result.deliveryCheckpoints.lanes.review.ok, false, `${phase} ${name}`);
    }
  }
});

test("New Session UI acceptance rejects a follow-up HEAD move", async () => {
  const { strictWorkflowAcceptanceSummary } = await import("./newSessionUiAcceptance.mjs");
  const fixture = strictWorkflowFixture();
  setLaneCheckpointHeads(fixture, strictNodeIds.followUp, finalHead, "d".repeat(40));

  const result = strictWorkflowAcceptanceSummary(fixture);

  assert.equal(result.ok, false);
  assert.deepEqual(result.deliveryCheckpoints.lanes.followUp.failures, ["after-head-mismatch", "head-moved"]);
});

test("New Session UI acceptance strict oracle rejects extra and duplicate initial lanes", async () => {
  const { strictWorkflowAcceptanceSummary } = await import("./newSessionUiAcceptance.mjs");
  const cases = [
    ["extra standalone", (fixture) => {
      fixture.session.nodes.push(completedOpaqueNode({
        id: "opaque-extra-standalone",
        runId: "opaque-run-extra-standalone",
        laneKind: "analysis",
        agent: "codex",
        dependencies: [],
      }));
    }],
    ["extra connected", (fixture) => {
      fixture.session.nodes.push(completedOpaqueNode({
        id: "opaque-extra-connected",
        runId: "opaque-run-extra-connected",
        laneKind: "analysis",
        agent: "codex",
        dependencies: ["opaque-commit"],
      }));
      fixture.session.edges.push({ id: "arbitrary-extra-edge", source: "opaque-commit", target: "opaque-extra-connected" });
    }],
    ["duplicate role", (fixture) => {
      fixture.session.nodes.push(completedOpaqueNode({
        id: "opaque-implementation-copy",
        runId: "opaque-run-implementation-copy",
        laneKind: "implementation",
        agent: "codex",
        dependencies: [],
      }));
    }],
  ];

  for (const [name, mutate] of cases) {
    const fixture = strictWorkflowFixture();
    mutate(fixture);
    const result = strictWorkflowAcceptanceSummary(fixture);
    assert.equal(result.ok, false, name);
    assert.equal(result.failures.includes("initial-lane-set-invalid"), true, name);
  }
});

test("New Session UI acceptance strict oracle rejects every required agent swap", async () => {
  const { strictWorkflowAcceptanceSummary } = await import("./newSessionUiAcceptance.mjs");
  const cases = [
    ["implementation", strictNodeIds.implementation, "hermes"],
    ["validation", strictNodeIds.validation, "hermes"],
    ["browser validation", strictNodeIds.browserValidation, "hermes"],
    ["initial review", strictNodeIds.review, "codex"],
    ["commit", strictNodeIds.commit, "hermes"],
    ["follow-up validation", strictNodeIds.followUp, "hermes"],
  ];

  for (const [name, nodeId, agent] of cases) {
    const fixture = strictWorkflowFixture();
    fixture.session.nodes.find((node) => node.id === nodeId).agent = agent;
    const result = strictWorkflowAcceptanceSummary(fixture);
    assert.equal(result.ok, false, name);
    assert.equal(result.failures.includes(nodeId === strictNodeIds.followUp
      ? "follow-up-invalid"
      : "agent-mapping-invalid"), true, name);
  }
});

test("New Session UI acceptance strict oracle rejects every dependency mutation", async () => {
  const { strictWorkflowAcceptanceSummary } = await import("./newSessionUiAcceptance.mjs");
  const chain = [
    [strictNodeIds.implementation, []],
    [strictNodeIds.validation, [strictNodeIds.implementation]],
    [strictNodeIds.browserValidation, [strictNodeIds.validation]],
    [strictNodeIds.review, [strictNodeIds.browserValidation]],
    [strictNodeIds.commit, [strictNodeIds.review]],
    [strictNodeIds.followUp, [strictNodeIds.commit]],
  ];
  const mutations = [
    ["missing", () => []],
    ["wrong", () => ["opaque-wrong-predecessor"]],
    ["extra", (expected) => [...expected, "opaque-extra-predecessor"]],
    ["duplicate", (expected) => expected.length === 0 ? ["opaque-wrong-predecessor", "opaque-wrong-predecessor"] : [...expected, ...expected]],
  ];

  for (const [nodeId, expected] of chain) {
    for (const [mutation, dependencies] of mutations) {
      if (mutation === "missing" && expected.length === 0) continue;
      const fixture = strictWorkflowFixture();
      fixture.session.nodes.find((node) => node.id === nodeId).context.dependencies = dependencies(expected);
      const result = strictWorkflowAcceptanceSummary(fixture);
      assert.equal(result.ok, false, `${nodeId}:${mutation}`);
      assert.equal(result.failures.includes(nodeId === strictNodeIds.followUp
        ? "follow-up-invalid"
        : "dependency-chain-invalid"), true, `${nodeId}:${mutation}`);
    }
  }
});

test("New Session UI acceptance strict oracle rejects non-exact edge sets", async () => {
  const { strictWorkflowAcceptanceSummary } = await import("./newSessionUiAcceptance.mjs");
  const cases = [
    ["missing", (fixture) => fixture.session.edges.pop()],
    ["extra", (fixture) => fixture.session.edges.push({ id: "opaque-edge-extra", source: strictNodeIds.implementation, target: strictNodeIds.review })],
    ["duplicate", (fixture) => fixture.session.edges.push({ id: "unrelated-edge-id", source: strictNodeIds.implementation, target: strictNodeIds.validation })],
    ["planner", (fixture) => fixture.session.edges.push({ id: "opaque-planner-edge", source: fixture.session.plannerNodeId, target: strictNodeIds.implementation })],
  ];

  for (const [name, mutate] of cases) {
    const fixture = strictWorkflowFixture();
    mutate(fixture);
    const result = strictWorkflowAcceptanceSummary(fixture);
    assert.equal(result.ok, false, name);
    assert.equal(result.failures.includes("edge-set-invalid"), true, name);
  }
});

test("New Session UI acceptance strict oracle rejects malformed follow-up structure", async () => {
  const { strictWorkflowAcceptanceSummary } = await import("./newSessionUiAcceptance.mjs");
  const cases = [
    ["wrong kind", (fixture) => { fixture.session.nodes.find((node) => node.id === strictNodeIds.followUp).laneKind = "review"; }],
    ["no dependency", (fixture) => { fixture.session.nodes.find((node) => node.id === strictNodeIds.followUp).context.dependencies = []; }],
    ["wrong dependency", (fixture) => { fixture.session.nodes.find((node) => node.id === strictNodeIds.followUp).context.dependencies = [strictNodeIds.review]; }],
    ["extra dependency", (fixture) => { fixture.session.nodes.find((node) => node.id === strictNodeIds.followUp).context.dependencies = [strictNodeIds.commit, strictNodeIds.review]; }],
  ];

  for (const [name, mutate] of cases) {
    const fixture = strictWorkflowFixture();
    mutate(fixture);
    const result = strictWorkflowAcceptanceSummary(fixture);
    assert.equal(result.ok, false, name);
    assert.equal(result.failures.includes("follow-up-invalid"), true, name);
  }
});

test("New Session UI acceptance strict oracle requires independent follow-up terminal evidence", async () => {
  const { strictWorkflowAcceptanceSummary } = await import("./newSessionUiAcceptance.mjs");
  const cases = [
    ["missing authoritative evidence", (fixture) => { delete fixture.authoritativeEvidence.runEvidence[strictRunIds.followUp]; }],
    ["node run mismatch", (fixture) => { fixture.session.nodes.find((node) => node.id === strictNodeIds.followUp).runId = "r-stale"; }],
    ["projection run mismatch", (fixture) => { fixture.projection.segments.find((segment) => segment.laneId === strictNodeIds.followUp).runId = "r-stale"; }],
    ["failed", (fixture) => { fixture.authoritativeEvidence.runEvidence[strictRunIds.followUp].status = "failed"; }],
    ["nonzero", (fixture) => { fixture.authoritativeEvidence.runEvidence[strictRunIds.followUp].exitCode = 1; }],
    ["missing cli check", (fixture) => { fixture.authoritativeEvidence.runEvidence[strictRunIds.followUp].checks = []; }],
    ["wrong cli check", (fixture) => { fixture.authoritativeEvidence.runEvidence[strictRunIds.followUp].checks[0].name = "Hermes CLI exit"; }],
    ["absent projection", (fixture) => { fixture.projection.segments = fixture.projection.segments.filter((segment) => segment.laneId !== strictNodeIds.followUp); }],
    ["duplicate projection", (fixture) => { fixture.projection.segments.push(structuredClone(fixture.projection.segments.at(-1))); }],
    ["missing projection evidence", (fixture) => { fixture.projection.evidence = fixture.projection.evidence.filter((evidence) => evidence.laneId !== strictNodeIds.followUp); }],
    ["duplicate projection evidence", (fixture) => { fixture.projection.evidence.push(structuredClone(fixture.projection.evidence.at(-1))); }],
    ["projection evidence segment mismatch", (fixture) => { fixture.projection.evidence.at(-1).segmentId = "s-stale"; }],
    ["projection evidence run mismatch", (fixture) => { fixture.projection.evidence.at(-1).runEvidence.runId = "r-stale"; }],
    ["reopened node incomplete", (fixture) => { fixture.session.nodes.find((node) => node.id === strictNodeIds.followUp).status = "running"; }],
  ];

  for (const [name, mutate] of cases) {
    const fixture = strictWorkflowFixture();
    mutate(fixture);
    const result = strictWorkflowAcceptanceSummary(fixture);
    assert.equal(result.ok, false, name);
    assert.equal(result.failures.includes("follow-up-evidence-invalid"), true, name);
  }
});

test("New Session UI acceptance rejects disconnected, mismatched, and duplicate-semantic-key graphs", async () => {
  const { workflowGraphAcceptanceSummary } = await import("./newSessionUiAcceptance.mjs");
  const cases = [
    [
      "disconnected",
      { disconnectedCardIds: ["lane-review"], dependencyMismatchIds: [], duplicateSemanticKeys: [] },
      "graph-disconnected:lane-review",
    ],
    [
      "dependency mismatch",
      { disconnectedCardIds: [], dependencyMismatchIds: ["lane-commit"], duplicateSemanticKeys: [] },
      "graph-dependency-mismatch:lane-commit",
    ],
    [
      "duplicate semantic key",
      { disconnectedCardIds: [], dependencyMismatchIds: [], duplicateSemanticKeys: ["task-key:implementation"] },
      "duplicate-semantic-keys:task-key:implementation",
    ],
  ];

  for (const [name, graph, expectedFailure] of cases) {
    const result = workflowGraphAcceptanceSummary(graph);
    assert.equal(result.ok, false, name);
    assert.equal(result.failures.includes(expectedFailure), true, name);
  }
});

test("New Session UI acceptance fails when any required lane kind is missing", async () => {
  const { requiredLaneEvidenceSummary } = await import("./newSessionUiAcceptance.mjs");
  const requiredKinds = ["implementation", "validation", "browser_validation", "review", "commit"];

  for (const kind of requiredKinds) {
    const { session, authoritativeEvidence } = completeRequiredLaneEvidenceFixture();
    const removed = requiredLaneFixtureNode(session, kind);
    session.nodes = session.nodes.filter((node) => node !== removed);
    delete authoritativeEvidence.runEvidence[removed.runId];

    const result = requiredLaneEvidenceSummary(session, authoritativeEvidence);

    assert.equal(result.ok, false, kind);
    assert.deepEqual(result.lanes[kind].failures, ["missing-lane"], kind);
  }
});

test("New Session UI acceptance rejects lane evidence with a mismatched run id", async () => {
  const { requiredLaneEvidenceSummary } = await import("./newSessionUiAcceptance.mjs");
  const { session, authoritativeEvidence } = completeRequiredLaneEvidenceFixture();
  authoritativeEvidence.runEvidence["run-validation"].runId = "run-stale-validation";

  const result = requiredLaneEvidenceSummary(session, authoritativeEvidence);

  assert.equal(result.ok, false);
  assert.deepEqual(result.lanes.validation.failures, ["run-id-mismatch"]);
});

test("New Session UI acceptance requires browser declarations, artifact check, and fixed screenshot artifact", async () => {
  const { requiredLaneEvidenceSummary } = await import("./newSessionUiAcceptance.mjs");
  const cases = [
    ["requiredEvidence", (session, authoritativeEvidence) => {
      const browserNode = requiredLaneFixtureNode(session, "browser_validation");
      browserNode.semanticSubtype = "browser_validation";
      browserNode.requiredEvidence = ["browser"];
    }, "missing-required-evidence:screenshot"],
    ["artifact check", (session, authoritativeEvidence) => {
      authoritativeEvidence.runEvidence["run-browser_validation"].checks =
        authoritativeEvidence.runEvidence["run-browser_validation"].checks
        .filter((check) => check.kind !== "artifact");
    }, "missing-passed-artifact-check"],
    ["artifact path", (session, authoritativeEvidence) => {
      authoritativeEvidence.runEvidence["run-browser_validation"].artifacts = [];
    }, "missing-screenshot-artifact"],
  ];

  for (const [name, mutate, expectedFailure] of cases) {
    const { session, authoritativeEvidence } = completeRequiredLaneEvidenceFixture();
    mutate(session, authoritativeEvidence);
    const result = requiredLaneEvidenceSummary(session, authoritativeEvidence);
    assert.equal(result.ok, false, name);
    assert.equal(result.lanes.browser_validation.failures.includes(expectedFailure), true, name);
  }
});

test("New Session UI acceptance does not classify ordinary validation as browser validation", async () => {
  const { requiredLaneEvidenceSummary } = await import("./newSessionUiAcceptance.mjs");
  const { session, authoritativeEvidence } = completeRequiredLaneEvidenceFixture();

  const result = requiredLaneEvidenceSummary(session, authoritativeEvidence);

  assert.equal(result.lanes.validation.nodeId, "lane-validation");
  assert.equal(result.lanes.validation.candidateCount, 1);
  assert.equal(result.lanes.browser_validation.nodeId, "lane-browser-validation");
  assert.equal(result.lanes.browser_validation.candidateCount, 1);
});

test("New Session UI acceptance does not infer browser validation from evidence when subtype is absent", async () => {
  const { requiredLaneEvidenceSummary } = await import("./newSessionUiAcceptance.mjs");
  const { session, authoritativeEvidence } = completeRequiredLaneEvidenceFixture();
  delete requiredLaneFixtureNode(session, "browser_validation").semanticSubtype;

  const result = requiredLaneEvidenceSummary(session, authoritativeEvidence);

  assert.deepEqual(result.lanes.browser_validation.failures, ["missing-lane"]);
  assert.equal(result.lanes.browser_validation.candidateCount, 0);
  assert.equal(result.lanes.validation.candidateCount, 2);
});

test("New Session UI acceptance lets browser subtype override canonical validation lane kind", async () => {
  const { requiredLaneEvidenceSummary } = await import("./newSessionUiAcceptance.mjs");
  const { session, authoritativeEvidence } = completeRequiredLaneEvidenceFixture();
  const browserNode = requiredLaneFixtureNode(session, "browser_validation");
  browserNode.semanticSubtype = "browser_validation";
  browserNode.requiredEvidence = ["browser"];

  const result = requiredLaneEvidenceSummary(session, authoritativeEvidence);

  assert.equal(result.lanes.browser_validation.nodeId, "lane-browser-validation");
  assert.equal(result.lanes.browser_validation.candidateCount, 1);
  assert.equal(result.lanes.validation.candidateCount, 1);
  assert.equal(result.lanes.browser_validation.failures.includes("missing-required-evidence:screenshot"), true);
});

test("New Session UI acceptance rejects review and commit lanes without their own terminal evidence", async () => {
  const { requiredLaneEvidenceSummary } = await import("./newSessionUiAcceptance.mjs");

  for (const kind of ["review", "commit"]) {
    const { session, authoritativeEvidence } = completeRequiredLaneEvidenceFixture();
    delete authoritativeEvidence.runEvidence[`run-${kind}`];
    const result = requiredLaneEvidenceSummary(session, authoritativeEvidence);
    assert.equal(result.ok, false, kind);
    assert.deepEqual(result.lanes[kind].failures, ["missing-run-evidence"], kind);
  }
});

test("New Session UI acceptance reports and cleans Electron launch failures", async () => {
  const source = await readFile(new URL("newSessionUiAcceptance.mjs", import.meta.url), "utf8");

  assert.match(source, /ELECTRON_LAUNCH_FAILED/);
  assert.match(source, /RENDERER_AUTOMATION_FAILED/);
  assert.match(source, /Promise\.allSettled\(\[electron\.close\(\), vite\.close\(\)\]\)/);
  assert.match(source, /waitForChildClose\(child/);
});

test("New Session UI acceptance cancels active runs before failed renderer cleanup", async () => {
  const { cancelActiveAgentRuns } = await import("./newSessionUiAcceptance.mjs");
  let expression = "";
  let evaluationOptions = null;
  const cdp = {
    async evaluate(value, options) {
      expression = value;
      evaluationOptions = options;
      return { cancelledRunIds: ["run-active"], activeRunIds: [] };
    },
  };

  assert.deepEqual(await cancelActiveAgentRuns(cdp, "Acceptance aborted."), ["run-active"]);
  assert.deepEqual(evaluationOptions, { awaitPromise: true, returnByValue: true });
  assert.equal([...expression.matchAll(/listAgentRuns/g)].length, 2);
  assert.match(expression, /cancelAgentRun/);
  assert.match(expression, /Promise\.allSettled/);
  assert.match(expression, /Acceptance aborted\./);
  assert.match(expression, /"timed-out"/);
});

test("New Session UI acceptance cancels reopened runs before cleanup after a post-relaunch throw", async () => {
  const { finalizeAcceptanceOutcome } = await import("./newSessionUiAcceptance.mjs");
  const source = await readFile(new URL("newSessionUiAcceptance.mjs", import.meta.url), "utf8");
  const events = [];
  const liveCdp = acceptanceCleanupCdp(events);
  const app = { async close() { events.push("electron:close"); } };

  const result = await finalizeAcceptanceOutcome({
    app,
    liveCdp,
    error: new Error("post-relaunch failure"),
  });

  assert.deepEqual(events, ["run:list", "run:cancel", "run:relist", "cdp:close", "electron:close"]);
  assert.equal(result.ok, true);
  assert.deepEqual(result.cancelledRunIds, ["run-reopened"]);
  const relaunchIndex = source.indexOf("app = await launchElectronAcceptanceApp", source.indexOf("overwriteWorkspaceSessionWithStaleClone"));
  const liveReconnectIndex = source.indexOf("liveCdp = await connectToReadySkyTurnRenderer", relaunchIndex);
  const thrownCleanupIndex = source.indexOf("finalizeAcceptanceOutcome({ app, liveCdp, error })", liveReconnectIndex);
  assert.ok(liveReconnectIndex > relaunchIndex);
  assert.ok(thrownCleanupIndex > liveReconnectIndex);
});

test("New Session UI acceptance cancels active runs before cleanup for a false predicate result", async () => {
  const { finalizeAcceptanceOutcome } = await import("./newSessionUiAcceptance.mjs");
  const source = await readFile(new URL("newSessionUiAcceptance.mjs", import.meta.url), "utf8");
  const events = [];
  const liveCdp = acceptanceCleanupCdp(events);
  const app = { async close() { events.push("electron:close"); } };

  const result = await finalizeAcceptanceOutcome({ app, liveCdp, ok: false });

  assert.deepEqual(events, ["run:list", "run:cancel", "run:relist", "cdp:close", "electron:close"]);
  assert.equal(result.ok, true);
  assert.deepEqual(result.cancelledRunIds, ["run-reopened"]);
  const predicateIndex = source.indexOf("const predicateOk =");
  const failedResultCleanupIndex = source.indexOf("finalizeAcceptanceOutcome({ app, liveCdp, ok: predicateOk })", predicateIndex);
  assert.ok(predicateIndex >= 0);
  assert.ok(failedResultCleanupIndex > predicateIndex);
});

test("New Session UI acceptance retries one transient cleanup failure before closing", async () => {
  const { finalizeAcceptanceOutcome } = await import("./newSessionUiAcceptance.mjs");
  const events = [];
  let attempt = 0;
  const liveCdp = {
    async evaluate(expression) {
      attempt += 1;
      events.push(`cleanup:${attempt}`);
      if (attempt === 1) throw new Error("synthetic transient list failure");
      assert.equal([...expression.matchAll(/listAgentRuns/g)].length, 2);
      return { cancelledRunIds: ["run-transient"], activeRunIds: [] };
    },
    close() {
      events.push("cdp:close");
    },
  };
  const app = { async close() { events.push("electron:close"); } };

  const result = await finalizeAcceptanceOutcome({ app, liveCdp, ok: false });

  assert.deepEqual(events, ["cleanup:1", "cleanup:2", "cdp:close", "electron:close"]);
  assert.equal(result.ok, true);
  assert.equal(result.cleanupConfirmed, true);
  assert.deepEqual(result.cancelledRunIds, ["run-transient"]);
  assert.equal(result.diagnostic, null);
});

test("New Session UI acceptance fails closed after persistent cleanup failure", async () => {
  const { finalizeAcceptanceOutcome } = await import("./newSessionUiAcceptance.mjs");
  const source = await readFile(new URL("newSessionUiAcceptance.mjs", import.meta.url), "utf8");
  const events = [];
  const liveCdp = {
    async evaluate() {
      events.push("cleanup:attempt");
      throw new Error("synthetic persistent cancellation failure");
    },
    close() {
      events.push("cdp:close");
    },
  };
  const app = { async close() { events.push("electron:close"); } };

  const result = await finalizeAcceptanceOutcome({ app, liveCdp, ok: false });

  assert.deepEqual(events, ["cleanup:attempt", "cleanup:attempt"]);
  assert.equal(result.ok, false);
  assert.equal(result.cleanupConfirmed, false);
  assert.equal(result.resourcesKeptAlive, true);
  assert.match(result.diagnostic, /run-cleanup-fail-closed:synthetic persistent cancellation failure/);
  assert.equal([...source.matchAll(/if \(!outcomeCleanup\.cleanupConfirmed\)/g)].length, 2);
});

test("New Session UI acceptance fails closed when an active run remains after cancellation", async () => {
  const { finalizeAcceptanceOutcome } = await import("./newSessionUiAcceptance.mjs");
  const events = [];
  const liveCdp = {
    async evaluate() {
      events.push("cleanup:attempt");
      return { cancelledRunIds: ["run-stubborn"], activeRunIds: ["run-stubborn"] };
    },
    close() {
      events.push("cdp:close");
    },
  };
  const app = { async close() { events.push("electron:close"); } };

  const result = await finalizeAcceptanceOutcome({ app, liveCdp, ok: false });

  assert.deepEqual(events, ["cleanup:attempt", "cleanup:attempt"]);
  assert.equal(result.ok, false);
  assert.equal(result.cleanupConfirmed, false);
  assert.equal(result.resourcesKeptAlive, true);
  assert.deepEqual(result.cancelledRunIds, ["run-stubborn"]);
  assert.match(result.diagnostic, /run-cleanup-fail-closed:active-agent-runs-remain:run-stubborn/);
});

test("New Session UI acceptance selects only the exact renderer target", async () => {
  const { selectSkyTurnRendererTarget } = await import("./newSessionUiAcceptance.mjs");
  const devServerUrl = "http://127.0.0.1:5173";
  const unrelated = {
    type: "page",
    url: "devtools://devtools/bundled/inspector.html",
    webSocketDebuggerUrl: "ws://127.0.0.1:5223/devtools/page/unrelated",
  };
  const adjacentPort = {
    type: "page",
    url: "http://127.0.0.1:51730/",
    webSocketDebuggerUrl: "ws://127.0.0.1:5223/devtools/page/adjacent-port",
  };
  const nestedPath = {
    type: "page",
    url: "http://127.0.0.1:5173/other",
    webSocketDebuggerUrl: "ws://127.0.0.1:5223/devtools/page/nested-path",
  };
  const renderer = {
    type: "page",
    url: `${devServerUrl}/`,
    webSocketDebuggerUrl: "ws://127.0.0.1:5223/devtools/page/renderer",
  };

  assert.equal(selectSkyTurnRendererTarget([unrelated], devServerUrl), null);
  assert.equal(selectSkyTurnRendererTarget([adjacentPort, nestedPath], devServerUrl), null);
  assert.equal(selectSkyTurnRendererTarget([adjacentPort, nestedPath, renderer], devServerUrl), renderer);
});

test("New Session UI acceptance reacquires the renderer once before the Create click", async () => {
  const { connectToReadySkyTurnRenderer } = await import("./newSessionUiAcceptance.mjs");
  const source = await readFile(new URL("newSessionUiAcceptance.mjs", import.meta.url), "utf8");
  const closed = [];
  const first = {
    close() {
      closed.push("first");
    },
    diagnosticEvents() {
      return [{ method: "Runtime.executionContextsCleared" }];
    },
  };
  const second = {
    close() {
      closed.push("second");
    },
    diagnosticEvents() {
      return [];
    },
  };
  const connections = [first, second];
  let connectCount = 0;
  let assertCount = 0;

  const result = await connectToReadySkyTurnRenderer({
    cdpPort: 5223,
    devServerUrl: "http://127.0.0.1:5173/",
    projectRoot: "/tmp/project",
    connect: async () => connections[connectCount++],
    assertLoaded: async () => {
      assertCount += 1;
      if (assertCount === 1) throw new Error("Inspected target navigated or closed");
    },
    processDiagnostics: () => "Electron and Vite remained alive.",
    retryDelayMs: 0,
  });

  assert.equal(result, second);
  assert.equal(connectCount, 2);
  assert.equal(assertCount, 2);
  assert.deepEqual(closed, ["first"]);
  assert.ok(
    source.indexOf("liveCdp = await connectToReadySkyTurnRenderer") <
      source.indexOf("await fillTextareaAndClickCreate(liveCdp, requirement)"),
    "renderer reacquisition must finish before the non-idempotent Create click.",
  );
});

test("New Session UI acceptance retries context loss during renderer acquisition", async () => {
  const { connectToReadySkyTurnRenderer } = await import("./newSessionUiAcceptance.mjs");
  const renderer = {
    close() {},
    diagnosticEvents() {
      return [];
    },
  };
  let connectCount = 0;
  let assertCount = 0;

  const result = await connectToReadySkyTurnRenderer({
    cdpPort: 5223,
    devServerUrl: "http://127.0.0.1:5173/",
    projectRoot: "/tmp/project",
    connect: async () => {
      connectCount += 1;
      if (connectCount === 1) throw new Error("Execution context was destroyed");
      return renderer;
    },
    assertLoaded: async () => {
      assertCount += 1;
    },
    retryDelayMs: 0,
  });

  assert.equal(result, renderer);
  assert.equal(connectCount, 2);
  assert.equal(assertCount, 1);
});

test("New Session UI acceptance retries transient CDP acquisition failures", async () => {
  const { connectToReadySkyTurnRenderer } = await import("./newSessionUiAcceptance.mjs");
  const failures = [
    new Error("CDP socket closed."),
    Object.assign(new Error("read ECONNRESET"), { code: "ECONNRESET" }),
  ];

  for (const failure of failures) {
    const renderer = {
      close() {},
      diagnosticEvents() {
        return [];
      },
    };
    let connectCount = 0;
    const result = await connectToReadySkyTurnRenderer({
      cdpPort: 5223,
      devServerUrl: "http://127.0.0.1:5173/",
      projectRoot: "/tmp/project",
      connect: async () => {
        connectCount += 1;
        if (connectCount === 1) throw failure;
        return renderer;
      },
      assertLoaded: async () => {},
      retryDelayMs: 0,
    });

    assert.equal(result, renderer);
    assert.equal(connectCount, 2);
  }
});

async function assertRealCdpHandshakeFailure({ failUpgrade, expectedError }) {
  const { connectToReadySkyTurnRenderer } = await import("./newSessionUiAcceptance.mjs");
  const clientSockets = [];
  const upgradeSockets = [];
  let upgradeCount = 0;
  const originalCreateConnection = net.createConnection;
  const server = createServer((request, response) => {
    if (request.url !== "/json/list") {
      response.writeHead(404).end();
      return;
    }
    const address = server.address();
    response.setHeader("content-type", "application/json");
    response.end(JSON.stringify([{
      type: "page",
      url: "http://127.0.0.1:5173/",
      webSocketDebuggerUrl: `ws://127.0.0.1:${address.port}/devtools/page/stale`,
    }]));
  });
  server.on("upgrade", (_request, socket) => {
    upgradeCount += 1;
    upgradeSockets.push(socket);
    failUpgrade(socket);
  });
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  net.createConnection = (...args) => {
    const socket = originalCreateConnection(...args);
    clientSockets.push(socket);
    return socket;
  };

  try {
    await assert.rejects(
      connectToReadySkyTurnRenderer({
        cdpPort: address.port,
        devServerUrl: "http://127.0.0.1:5173/",
        projectRoot: "/tmp/project",
        retryDelayMs: 0,
      }),
      expectedError,
    );
    assert.equal(upgradeCount, 2);
    assert.equal(clientSockets.length, 2);
    assert.equal(clientSockets.every((socket) => socket.destroyed), true);
    assert.equal(clientSockets.every((socket) => socket.listenerCount("error") === 0), true);
    assert.equal(clientSockets.every((socket) => socket.listenerCount("close") === 0), true);
  } finally {
    net.createConnection = originalCreateConnection;
    for (const socket of upgradeSockets) socket.destroy();
    await new Promise((resolve) => server.close(resolve));
  }
}

test("New Session UI acceptance retries real failed upgrades and destroys their sockets", async () => {
  await assertRealCdpHandshakeFailure({
    expectedError: /CDP WebSocket upgrade failed/,
    failUpgrade(socket) {
      socket.write("HTTP/1.1 400 Bad Request\r\nConnection: keep-alive\r\nContent-Length: 0\r\n\r\n");
      socket.resume();
    },
  });
});

test("New Session UI acceptance retries real reset sockets before Create", async () => {
  await assertRealCdpHandshakeFailure({
    expectedError: /ECONNRESET|CDP socket closed/,
    failUpgrade(socket) {
      if (typeof socket.resetAndDestroy === "function") socket.resetAndDestroy();
      else socket.destroy();
    },
  });
});

test("CDP requests time out and drain only their pending entry", async () => {
  const { CdpClient } = await import("./newSessionUiAcceptance.mjs");
  const peer = await createCdpWebSocketPeer(() => {});
  let client = null;

  try {
    client = await CdpClient.connect(peer.url, 40);
    await assert.rejects(
      client.evaluate("'never replies'"),
      /CDP request Runtime\.evaluate timed out after 40 ms\./,
    );
    assert.equal(client.pending.size, 0);
  } finally {
    client?.destroy();
    await peer.close();
  }
});

test("CDP evaluate supports a bounded per-request timeout without changing the client default", async () => {
  const { CdpClient } = await import("./newSessionUiAcceptance.mjs");
  const peer = await createCdpWebSocketPeer((request, reply) => {
    setTimeout(() => reply(request.id, { result: { value: "ready" } }), 50);
  });
  let client = null;
  const defaultClient = new CdpClient(peer.url);

  try {
    assert.equal(defaultClient.requestTimeoutMs, 30_000);
    client = await CdpClient.connect(peer.url, 30);
    assert.equal(
      await client.evaluate("'ready'", { requestTimeoutMs: 80 }),
      "ready",
    );
    await assert.rejects(
      client.evaluate("'uses default'"),
      /CDP request Runtime\.evaluate timed out after 30 ms\./,
    );
    for (const requestTimeoutMs of [0, -0, -1, Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY]) {
      await assert.rejects(
        client.evaluate("'invalid override'", { requestTimeoutMs }),
        /CDP request timeout must be a positive finite number\./,
      );
    }
    assert.equal(client.pending.size, 0);
  } finally {
    defaultClient.destroy();
    client?.destroy();
    await peer.close();
  }
});

test("CDP normal replies clear the request timeout and succeed", async () => {
  const { CdpClient } = await import("./newSessionUiAcceptance.mjs");
  const peer = await createCdpWebSocketPeer((request, reply) => {
    reply(request.id, { result: { value: "ready" } });
  });
  let client = null;

  try {
    client = await CdpClient.connect(peer.url, 80);
    assert.equal(await client.evaluate("'ready'"), "ready");
    await new Promise((resolve) => setTimeout(resolve, 100));
    assert.equal(client.pending.size, 0);
  } finally {
    client?.destroy();
    await peer.close();
  }
});

test("CDP ignores a late timed-out reply without affecting the next request", async () => {
  const { CdpClient } = await import("./newSessionUiAcceptance.mjs");
  let requestCount = 0;
  const peer = await createCdpWebSocketPeer((request, reply) => {
    requestCount += 1;
    const delayMs = requestCount === 1 ? 80 : 40;
    setTimeout(() => reply(request.id, { result: { value: `reply-${request.id}` } }), delayMs);
  });
  let client = null;

  try {
    client = await CdpClient.connect(peer.url, 60);
    await assert.rejects(client.call("Page.enable"), /timed out after 60 ms/);
    const response = await client.call("Runtime.enable");

    assert.equal(response.result.result.value, "reply-2");
    assert.equal(client.pending.size, 0);
  } finally {
    client?.destroy();
    await peer.close();
  }
});

test("CDP synchronous write failure drains its pending request", async () => {
  const { CdpClient } = await import("./newSessionUiAcceptance.mjs");
  const peer = await createCdpWebSocketPeer(() => {});
  let client = null;
  let write = null;

  try {
    client = await CdpClient.connect(peer.url, 80);
    write = client.socket.write;
    client.socket.write = () => {
      throw new Error("synthetic write failure");
    };
    await assert.rejects(client.call("Page.enable"), /synthetic write failure/);
    assert.equal(client.pending.size, 0);
  } finally {
    if (client && write) client.socket.write = write;
    client?.destroy();
    await peer.close();
  }
});

test("CDP close and destroy reject pending requests", async () => {
  const { CdpClient } = await import("./newSessionUiAcceptance.mjs");

  for (const method of ["close", "destroy"]) {
    const peer = await createCdpWebSocketPeer(() => {});
    let client = null;

    try {
      client = await CdpClient.connect(peer.url, 1_000);
      const pending = client.call("Page.enable");
      client[method]();
      await assert.rejects(pending, /CDP client (?:closed|destroyed)\./);
      assert.equal(client.pending.size, 0);
    } finally {
      client?.destroy();
      await peer.close();
    }
  }
});

test("New Session UI acceptance bounds diagnostics and strips URL capabilities", async () => {
  const { connectToReadySkyTurnRenderer } = await import("./newSessionUiAcceptance.mjs");
  const secret = "secret-capability-value";
  const renderer = {
    close() {},
    diagnosticEvents() {
      return [{
        method: "Page.frameNavigated",
        frameId: "frame-1",
        url: `http://127.0.0.1:5173/app?token=${secret}#capability`,
      }];
    },
  };

  await assert.rejects(
    connectToReadySkyTurnRenderer({
      cdpPort: 5223,
      devServerUrl: "http://127.0.0.1:5173/",
      projectRoot: "/tmp/project",
      connect: async () => renderer,
      assertLoaded: async () => {
        throw new Error("Inspected target navigated or closed");
      },
      processDiagnostics: () => [
        `Vite loaded http://127.0.0.1:5173/?token=${secret}#capability`,
        `GET /?token=${secret}#capability`,
        `WebSocket ws://127.0.0.1:5223/devtools/page/1?token=${secret}#capability`,
        `File file:///tmp/renderer.html?token=${secret}#capability`,
        "x".repeat(10_000),
      ].join("\n"),
      retryDelayMs: 0,
      diagnosticLimitBytes: 1_024,
    }),
    (error) => {
      assert.ok(Buffer.byteLength(error.message) <= 1_024);
      assert.doesNotMatch(error.message, /secret-|token=|capability/);
      assert.match(error.message, /http:\/\/127\.0\.0\.1:5173\/app/);
      assert.match(error.message, /GET \/(?:;|\s)/);
      assert.match(error.message, /ws:\/\/127\.0\.0\.1:5223\/devtools\/page\/1/);
      assert.match(error.message, /file:\/\/\/tmp\/renderer\.html/);
      return true;
    },
  );
});

async function createCdpWebSocketPeer(onRequest) {
  const sockets = new Set();
  const server = createServer();
  server.on("upgrade", (request, socket) => {
    sockets.add(socket);
    socket.once("close", () => sockets.delete(socket));
    const key = request.headers["sec-websocket-key"];
    const accept = createHash("sha1")
      .update(`${key}258EAFA5-E914-47DA-95CA-C5AB0DC85B11`)
      .digest("base64");
    socket.write([
      "HTTP/1.1 101 Switching Protocols",
      "Upgrade: websocket",
      "Connection: Upgrade",
      `Sec-WebSocket-Accept: ${accept}`,
      "",
      "",
    ].join("\r\n"));

    let buffer = Buffer.alloc(0);
    socket.on("data", (chunk) => {
      buffer = Buffer.concat([buffer, chunk]);
      while (true) {
        const frame = readClientTextFrame(buffer);
        if (!frame) return;
        buffer = buffer.subarray(frame.bytes);
        const message = JSON.parse(frame.payload.toString("utf8"));
        onRequest(message, (id, result) => {
          if (!socket.destroyed) socket.write(serverTextFrame(JSON.stringify({ id, result })));
        });
      }
    });
  });
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();

  return {
    url: `ws://127.0.0.1:${address.port}/devtools/page/test`,
    async close() {
      for (const socket of sockets) socket.destroy();
      await new Promise((resolve) => server.close(resolve));
    },
  };
}

function readClientTextFrame(buffer) {
  if (buffer.length < 2) return null;
  let length = buffer[1] & 0x7f;
  let offset = 2;
  if (length === 126) {
    if (buffer.length < 4) return null;
    length = buffer.readUInt16BE(2);
    offset = 4;
  } else if (length === 127) {
    if (buffer.length < 10 || buffer.readUInt32BE(2) !== 0) return null;
    length = buffer.readUInt32BE(6);
    offset = 10;
  }
  const masked = (buffer[1] & 0x80) !== 0;
  const maskBytes = masked ? 4 : 0;
  if (buffer.length < offset + maskBytes + length) return null;
  const mask = masked ? buffer.subarray(offset, offset + 4) : null;
  const payloadStart = offset + maskBytes;
  const payload = Buffer.from(buffer.subarray(payloadStart, payloadStart + length));
  if (mask) {
    for (let index = 0; index < payload.length; index += 1) payload[index] ^= mask[index % 4];
  }
  return { bytes: payloadStart + length, payload };
}

function serverTextFrame(text) {
  const payload = Buffer.from(text);
  if (payload.length < 126) return Buffer.concat([Buffer.from([0x81, payload.length]), payload]);
  const header = Buffer.alloc(4);
  header[0] = 0x81;
  header[1] = 126;
  header.writeUInt16BE(payload.length, 2);
  return Buffer.concat([header, payload]);
}

test("New Session UI acceptance is exposed as an explicit desktop package script", async () => {
  const packageJson = JSON.parse(await readFile(new URL("package.json", root), "utf8"));

  assert.equal(packageJson.scripts["acceptance:new-session-ui"], "node scripts/newSessionUiAcceptance.mjs");
  assert.equal(packageJson.scripts["acceptance:new-session"], "pnpm run acceptance:new-session-ui");
});

function authoritativePlannerState(runId, input, laneIds) {
  const plannerNodeId = "planner-node-1";
  const plannerTurns = input === "Second input"
    ? [
        { runId: "run-planner-1", segmentId: "segment-planner-1" },
        { runId, segmentId: "segment-planner-2" },
      ]
    : [{ runId, segmentId: "segment-planner-1" }];
  const canvasSession = {
    id: "session-1",
    kind: "canvas",
    hermesPlannerSessionId: "planner-session-1",
    plannerNodeId,
    nodes: [
      {
        id: plannerNodeId,
        runId,
        agent: "hermes",
        status: "completed",
        context: { brief: input, dependencies: [] },
      },
      ...laneIds.map((id) => ({
        id,
        runId: `run-${id}`,
        agent: "codex",
        status: "completed",
        context: { brief: id, dependencies: [] },
      })),
    ],
    edges: laneIds.map((id) => ({ id: `edge-${id}`, source: plannerNodeId, target: id })),
  };
  return {
    canvasSession,
    projection: {
      segments: laneIds.map((laneId) => ({
        laneId,
        runId: `run-${laneId}`,
        status: "succeeded",
        evidence: {
          runId: `run-${laneId}`,
          status: "succeeded",
          exitCode: 0,
          checks: [{ kind: "run-exit", name: "Codex CLI exit", status: "passed" }],
        },
      })),
    },
    events: [
      safeWorkflowEvent(10, "workflow.user_input"),
      safeWorkflowEvent(20, "workflow.intent.accepted", plannerNodeId, plannerTurns[0].runId),
      safeWorkflowEvent(30, "workflow.lane.declared", "lane-1", plannerTurns[0].runId),
      ...plannerTurnEvents(40, plannerNodeId, plannerTurns[0]),
      ...(plannerTurns.length === 2
        ? [
            safeWorkflowEvent(50, "workflow.user_input"),
            safeWorkflowEvent(60, "workflow.intent.accepted", plannerNodeId, plannerTurns[1].runId),
            safeWorkflowEvent(70, "workflow.lane.declared", "lane-2", plannerTurns[1].runId),
            ...plannerTurnEvents(80, plannerNodeId, plannerTurns[1]),
          ]
        : []),
    ],
  };
}

function strictWorkflowFixture() {
  const plannerNodeId = "n-33aa";
  const nodeSpecs = [
    [strictNodeIds.implementation, strictRunIds.implementation, "implementation", "frontend_delivery", "codex", []],
    [strictNodeIds.validation, strictRunIds.validation, "validation", "unit_checks", "codex", [strictNodeIds.implementation]],
    [strictNodeIds.browserValidation, strictRunIds.browserValidation, "validation", "browser_validation", "codex", [strictNodeIds.validation]],
    [strictNodeIds.review, strictRunIds.review, "review", "evidence_review", "hermes", [strictNodeIds.browserValidation]],
    [strictNodeIds.commit, strictRunIds.commit, "commit", "git_commit", "codex", [strictNodeIds.review]],
    [strictNodeIds.followUp, strictRunIds.followUp, "validation", "anything", "codex", [strictNodeIds.commit]],
  ];
  const nodes = nodeSpecs.map(([id, runId, laneKind, semanticSubtype, agent, dependencies], index) => ({
    ...completedOpaqueNode({ id, runId, laneKind, semanticSubtype, agent, dependencies }),
    title: `Random title ${91 - index}`,
    requiredEvidence: id === strictNodeIds.browserValidation ? ["browser", "screenshot"] : [],
  }));
  const runEvidence = Object.fromEntries(nodes.map((node) => [
    node.runId,
    successfulOpaqueEvidence(node.runId, node.agent, node.id === strictNodeIds.browserValidation),
  ]));
  const projection = {
    segments: nodes.map((node) => ({
      id: `s-${node.id}`,
      laneId: node.id,
      runId: node.runId,
      status: "succeeded",
      exitCode: 0,
    })),
    evidence: nodes.map((node) => ({
      id: `e-${node.id}`,
      laneId: node.id,
      segmentId: `s-${node.id}`,
      kind: "run-exit",
      status: "passed",
      checks: [`run-exit:${node.agent === "hermes" ? "Hermes" : "Codex"} CLI exit:passed`],
      artifacts: node.id === strictNodeIds.browserValidation ? [".devflow/acceptance/react-app.png"] : [],
      runEvidence: structuredClone(runEvidence[node.runId]),
    })),
    changesetEvidence: nodes.flatMap((node) => [
      checkpointChangesetEvidence(node.runId, "before"),
      checkpointChangesetEvidence(node.runId, "after"),
    ]),
    checkpoints: nodes.flatMap((node) => {
      const segmentId = `s-${node.id}`;
      const evidenceId = `e-${node.id}`;
      const isCommit = node.id === strictNodeIds.commit;
      const isFollowUp = node.id === strictNodeIds.followUp;
      const beforeHead = isFollowUp ? finalHead : baselineHead;
      const afterHead = isCommit || isFollowUp ? finalHead : baselineHead;
      return ["before", "after"].map((phase) => ({
        id: `checkpoint-${node.id}-${phase}`,
        sessionId: "opaque-session",
        nodeId: node.id,
        laneId: node.id,
        runId: node.runId,
        segmentId,
        phase,
        executionTarget: "current_branch",
        branchName: "main",
        headCommit: phase === "before" ? beforeHead : afterHead,
        createdAt: "2026-07-22T00:00:00.000Z",
        source: "system",
        evidenceRefs: [
          { kind: "run", id: node.runId },
          { kind: "segment", id: segmentId },
          { kind: "changeset", id: `changeset-evidence:${node.runId}:${phase}` },
          ...(phase === "after" ? [{ kind: "evidence", id: evidenceId }] : []),
        ],
      }));
    }),
  };
  return {
    session: {
      id: "opaque-session",
      plannerNodeId,
      nodes: [{
        id: plannerNodeId,
        runId: "r-0cc4",
        laneKind: "planner",
        agent: "hermes",
        status: "completed",
        title: "Random title 104",
        context: { brief: "opaque", dependencies: [] },
      }, ...nodes],
      edges: nodes.slice(1).map((node, index) => ({
        id: `meaningless-edge-${index}`,
        source: nodes[index].id,
        target: node.id,
      })),
    },
    authoritativeEvidence: authoritativeEvidenceFixture(projection),
    workspace: { runEvidence: structuredClone(runEvidence) },
    projection,
    replay: { ok: true, secondTurnLaneIds: [strictNodeIds.followUp] },
    secondTurnLaneIds: [strictNodeIds.followUp],
    baselineCommitSha: baselineHead,
    finalHeadCommitSha: finalHead,
    deliveryCommitCount: 1,
  };
}

function pendingDangerAuthorizationNode(overrides = {}) {
  const id = overrides.id ?? "decision-danger-run";
  const runAuthorization = {
    sandbox: "danger-full-access",
    runId: "run-danger",
    startFingerprint: "a".repeat(64),
    ...(overrides.userDecision?.runAuthorization ?? {}),
  };
  const userDecision = {
    decisionId: id,
    prompt: "Authorize full host access for Commit verified changes?",
    options: ["Authorize this run"],
    reason: "This run can modify host state outside the project.",
    status: "waiting_input",
    targetLaneId: "lane-commit",
    targetSegmentId: "segment-commit",
    runAuthorization,
    ...overrides.userDecision,
  };
  if (overrides.userDecision && Object.hasOwn(overrides.userDecision, "runAuthorization")) {
    userDecision.runAuthorization = overrides.userDecision.runAuthorization === undefined
      ? undefined
      : runAuthorization;
  }
  return {
    id,
    title: "User decision required",
    status: "pending",
    nodeKind: "user_decision",
    ...overrides,
    userDecision,
  };
}

function acceptanceCleanupCdp(events) {
  return {
    async evaluate(expression) {
      assert.ok(expression.indexOf("listAgentRuns") < expression.indexOf("cancelAgentRun"));
      assert.ok(expression.lastIndexOf("listAgentRuns") > expression.indexOf("cancelAgentRun"));
      events.push("run:list", "run:cancel", "run:relist");
      return { cancelledRunIds: ["run-reopened"], activeRunIds: [] };
    },
    close() {
      events.push("cdp:close");
    },
  };
}

function laneCheckpoint(fixture, nodeId, phase) {
  return fixture.projection.checkpoints.find((checkpoint) =>
    checkpoint.laneId === nodeId && checkpoint.phase === phase
  );
}

function authoritativeSettledFixture() {
  const runId = "opaque-run-lane-1";
  const segmentId = "opaque-segment-lane-1";
  const evidenceId = "opaque-evidence-record-lane-1";
  return {
    canvasSession: {
      plannerNodeId: "opaque-planner",
      nodes: [
        { id: "opaque-planner", status: "completed" },
        { id: "lane-1", runId, status: "completed" },
      ],
    },
    projection: {
      segments: [{ id: segmentId, laneId: "lane-1", runId, status: "succeeded", exitCode: 0 }],
      evidence: [{
        id: evidenceId,
        laneId: "lane-1",
        segmentId,
        status: "passed",
        runEvidence: {
          runId,
          status: "succeeded",
          exitCode: 0,
          checks: [],
          artifacts: [],
        },
      }],
      changesetEvidence: [checkpointChangesetEvidence(runId, "after")],
      checkpoints: [{
        id: "opaque-checkpoint-after",
        sessionId: "opaque-session",
        nodeId: "lane-1",
        laneId: "lane-1",
        runId,
        segmentId,
        phase: "after",
        executionTarget: "current_branch",
        branchName: "main",
        headCommit: baselineHead,
        createdAt: "2026-07-22T00:00:00.000Z",
        source: "system",
        evidenceRefs: [
          { kind: "run", id: runId },
          { kind: "segment", id: segmentId },
          { kind: "changeset", id: `changeset-evidence:${runId}:after` },
          { kind: "evidence", id: evidenceId },
        ],
      }],
    },
  };
}

function checkpointReferenceMutationCases(nodeId, phase) {
  const requiredKinds = phase === "after"
    ? ["run", "segment", "changeset", "evidence"]
    : ["run", "segment", "changeset"];
  const cases = [];
  for (const kind of requiredKinds) {
    cases.push(
      [`missing ${kind} ref`, (fixture) => {
        const checkpoint = laneCheckpoint(fixture, nodeId, phase);
        checkpoint.evidenceRefs = checkpoint.evidenceRefs.filter((reference) => reference.kind !== kind);
      }],
      [`wrong ${kind} ref`, (fixture) => {
        laneCheckpoint(fixture, nodeId, phase).evidenceRefs
          .find((reference) => reference.kind === kind).id = `wrong-${kind}-id`;
      }],
      [`duplicate ${kind} ref`, (fixture) => {
        const checkpoint = laneCheckpoint(fixture, nodeId, phase);
        checkpoint.evidenceRefs.push(structuredClone(
          checkpoint.evidenceRefs.find((reference) => reference.kind === kind),
        ));
      }],
    );
  }
  if (phase === "before") {
    cases.push(["unexpected evidence ref", (fixture) => {
      const checkpoint = laneCheckpoint(fixture, nodeId, phase);
      const segment = fixture.projection.segments.find((candidate) => candidate.id === checkpoint.segmentId);
      const evidence = fixture.projection.evidence.find((candidate) =>
        candidate.laneId === nodeId && candidate.segmentId === segment.id
      );
      checkpoint.evidenceRefs.push({ kind: "evidence", id: evidence.id });
    }]);
  }
  cases.push(
    ["missing changeset evidence record", (fixture) => {
      const checkpoint = laneCheckpoint(fixture, nodeId, phase);
      const evidenceId = `changeset-evidence:${checkpoint.runId}:${phase}`;
      fixture.projection.changesetEvidence = fixture.projection.changesetEvidence
        .filter((record) => record.evidenceId !== evidenceId);
    }],
    ["wrong changeset evidence record", (fixture) => {
      const checkpoint = laneCheckpoint(fixture, nodeId, phase);
      const evidenceId = `changeset-evidence:${checkpoint.runId}:${phase}`;
      fixture.projection.changesetEvidence
        .find((record) => record.evidenceId === evidenceId).evidenceId = `wrong-${evidenceId}`;
    }],
    ["duplicate changeset evidence record", (fixture) => {
      const checkpoint = laneCheckpoint(fixture, nodeId, phase);
      const evidenceId = `changeset-evidence:${checkpoint.runId}:${phase}`;
      fixture.projection.changesetEvidence.push(structuredClone(
        fixture.projection.changesetEvidence.find((record) => record.evidenceId === evidenceId),
      ));
    }],
  );
  return cases;
}

function checkpointChangesetEvidence(runId, phase) {
  const available = phase === "after";
  return {
    evidenceId: `changeset-evidence:${runId}:${phase}`,
    changesetId: `changeset-${runId}-${phase}`,
    source: "git",
    status: available ? "available" : "empty",
    files: available ? ["src/App.jsx"] : [],
    diffStat: available
      ? { added: 1, changed: 0, deleted: 0 }
      : { added: 0, changed: 0, deleted: 0 },
    patchPreviewTruncated: false,
    collectedAt: "2026-07-22T00:00:00.000Z",
  };
}

function setLaneCheckpointHeads(fixture, nodeId, beforeHead, afterHead) {
  laneCheckpoint(fixture, nodeId, "before").headCommit = beforeHead;
  laneCheckpoint(fixture, nodeId, "after").headCommit = afterHead;
}

function completedOpaqueNode({
  id,
  runId,
  laneKind,
  semanticSubtype = "opaque_subtype",
  agent,
  dependencies,
}) {
  return {
    id,
    runId,
    laneKind,
    semanticSubtype,
    agent,
    status: "completed",
    title: "Random title 38",
    display: { meta: ["misleading", "values"] },
    context: { brief: "Misleading prose", dependencies: [...dependencies] },
  };
}

function successfulOpaqueSegment(laneId, runId, agent) {
  return {
    laneId,
    runId,
    status: "succeeded",
    evidence: successfulOpaqueEvidence(runId, agent),
  };
}

function successfulOpaqueEvidence(runId, agent, browser = false) {
  return {
    runId,
    status: "succeeded",
    exitCode: 0,
    changesetId: null,
    checks: [
      { kind: "run-exit", name: agent === "hermes" ? "Hermes CLI exit" : "Codex CLI exit", status: "passed" },
      ...(browser ? [{ kind: "artifact", name: "Expected artifacts", status: "passed" }] : []),
    ],
    artifacts: browser ? [".devflow/acceptance/react-app.png"] : [],
    review: null,
    errorReason: null,
    cancelReason: null,
    completedAt: "2026-07-22T00:00:00.000Z",
  };
}

function completeRequiredLaneEvidenceFixture() {
  const kinds = ["implementation", "validation", "browser_validation", "review", "commit"];
  const semanticSubtypes = {
    implementation: "frontend_implementation",
    validation: "regression_check",
    browser_validation: "browser_validation",
    review: "evidence_review",
    commit: "git_commit",
  };
  const nodeIds = kinds.map((kind) => kind === "browser_validation" ? "lane-browser-validation" : `lane-${kind}`);
  const nodes = kinds.map((kind, index) => {
    const agent = kind === "review" ? "hermes" : "codex";
    const browserValidation = kind === "browser_validation";
    return {
      id: nodeIds[index],
      runId: `run-${kind}`,
      agent,
      title: kind,
      status: "completed",
      laneKind: browserValidation ? "validation" : kind,
      semanticSubtype: semanticSubtypes[kind],
      requiredEvidence: browserValidation ? ["browser", "screenshot"] : [],
      display: {
        meta: [browserValidation ? "validation" : kind, `lane-${kind}`, "flow-kernel"],
      },
      context: { dependencies: index === 0 ? [] : [nodeIds[index - 1]] },
    };
  });
  const runEvidence = Object.fromEntries(nodes.map((node) => [node.runId, {
    runId: node.runId,
    status: "succeeded",
    exitCode: 0,
    changesetId: null,
    checks: [
      {
        kind: "run-exit",
        name: node.agent === "hermes" ? "Hermes CLI exit" : "Codex CLI exit",
        status: "passed",
      },
      ...(node.runId === "run-browser_validation"
        ? [{ kind: "artifact", name: "Expected artifacts", status: "passed" }]
        : []),
    ],
    artifacts: node.runId === "run-browser_validation"
      ? [".devflow/acceptance/react-app.png"]
      : [],
    review: null,
    errorReason: null,
    cancelReason: null,
    completedAt: "2026-07-22T00:00:00.000Z",
  }]));
  return {
    session: {
      id: "session-lane-evidence",
      plannerNodeId: "planner",
      nodes,
      edges: nodes.slice(1).map((node, index) => ({
        id: `edge-${nodes[index].id}-${node.id}`,
        source: nodes[index].id,
        target: node.id,
      })),
    },
    authoritativeEvidence: authoritativeEvidenceFixture(runEvidence),
  };
}

function authoritativeEvidenceFixture(runEvidenceOrProjection) {
  const records = Array.isArray(runEvidenceOrProjection?.evidence)
    ? runEvidenceOrProjection.evidence.flatMap((evidence) => {
        if (!evidence?.runEvidence?.runId) return [];
        return [{
          evidenceId: evidence.id ?? null,
          laneId: evidence.laneId ?? null,
          segmentId: evidence.segmentId ?? null,
          status: evidence.status ?? null,
          runEvidence: evidence.runEvidence,
        }];
      })
    : Object.values(runEvidenceOrProjection ?? {}).map((runEvidence) => ({
        evidenceId: null,
        laneId: null,
        segmentId: null,
        status: "passed",
        runEvidence,
      }));
  return {
    ok: true,
    failures: [],
    runEvidence: Object.fromEntries(
      records
        .filter((record) => record.status === "passed")
        .map((record) => [record.runEvidence.runId, record.runEvidence]),
    ),
    records,
  };
}

function requiredLaneFixtureNode(session, kind) {
  return session.nodes.find((node) => node.runId === `run-${kind}`);
}

function safeWorkflowEvent(seq, kind, laneId, causationId) {
  return {
    seq,
    kind,
    ...(laneId ? { laneId } : {}),
    ...(causationId ? { causationId } : {}),
    payload: { redacted: true, summary: "Workflow event recorded." },
  };
}

function plannerTurnEvents(seq, laneId, { runId, segmentId }) {
  return [{
    seq,
    kind: "workflow.planner_intent.reconciled",
    source: "electron-main",
    laneId,
    segmentId,
    payload: {
      redacted: true,
      summary: "Workflow event recorded.",
      plannerTurn: {
        runId,
        segmentId,
        status: "succeeded",
        exitCode: 0,
        hermesCliExitPassed: true,
        intentDisposition: "applied",
      },
    },
  }];
}
