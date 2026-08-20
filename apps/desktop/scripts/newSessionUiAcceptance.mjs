import { spawn } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { constants as fsConstants } from "node:fs";
import { createRequire } from "node:module";
import { lstat, mkdtemp, open, readFile, rm, stat, writeFile } from "node:fs/promises";
import net from "node:net";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { inflateSync } from "node:zlib";

import {
  RENDERER_HOST,
  DEFAULT_RENDERER_PORT,
  findAvailablePort,
  makeDevServerUrl,
  rendererDevCommand,
} from "./devServer.mjs";

const require = createRequire(import.meta.url);
const desktopRoot = dirname(dirname(fileURLToPath(import.meta.url)));
const waitTimeoutMs = Number(process.env.SKYTURN_NEW_SESSION_UI_WAIT_TIMEOUT_MS ?? 25 * 60 * 1_000);
const agentWatchdogTimeoutMs = Math.max(1_000, Math.min(12 * 60 * 1_000, waitTimeoutMs - 60_000));
const pollIntervalMs = Number(process.env.SKYTURN_NEW_SESSION_UI_POLL_MS ?? 2_000);
const commandOutputLimitBytes = Number(process.env.SKYTURN_NEW_SESSION_UI_OUTPUT_LIMIT_BYTES ?? 4_000);
const managedStreamOutputLimitBytes = 1024 * 1024;
const managedCombinedOutputLimitBytes = 2 * 1024 * 1024;
const capturedStreamOutputLimitBytes = 8 * 1024 * 1024;
const capturedCombinedOutputLimitBytes = 8 * 1024 * 1024;
const defaultCdpRequestTimeoutMs = 30_000;
const controlPlaneUiTimeoutMs = 15_000;
const controlPlaneCdpRequestTimeoutMs = 20_000;
const failureShutdownTimeoutMs = 30_000;
const dangerAuthorizationAcknowledgmentBudgetMs = 10_000;
const dangerAuthorizationOption = "Authorize this run";
const expectedChangedFiles = ["src/App.css", "src/App.jsx"];

export const MANAGED_OUTPUT_OVERFLOW_DIAGNOSTIC = "Acceptance child output exceeded the fixed byte limit.";

export function waitForBrowserProbe(probe, label, {
  deadline,
  now = () => Date.now(),
  schedule = (callback) => setTimeout(callback, 16),
} = {}) {
  return new Promise((resolve, reject) => {
    const tick = () => {
      if (now() >= deadline) {
        reject(new Error(`Timed out waiting for ${label}`));
        return;
      }
      const value = probe();
      if (value) {
        resolve(value);
        return;
      }
      schedule(tick);
    };
    tick();
  });
}

export function assertBrowserDeadline(deadline, {
  now = () => Date.now(),
} = {}) {
  if (now() >= deadline) {
    throw new Error("Danger authorization deadline expired.");
  }
}
const requiredLaneKinds = ["implementation", "validation", "review", "commit"];
const browserScreenshotArtifact = ".devflow/acceptance/react-app.png";
const independentBrowserScreenshotArtifact = ".devflow/acceptance/react-app.verify.png";
const minimumScreenshotBytes = 1_000;
const maximumPngFileBytes = 64 * 1024 * 1024;
const pngReadChunkBytes = 64 * 1024;
const maximumPngDimension = 16_384;
const maximumInflatedPngBytes = 256 * 1024 * 1024;
const maximumPngChunkCount = 4_096;
const pngSignature = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const pngCrcTable = Uint32Array.from({ length: 256 }, (_, value) => {
  let crc = value;
  for (let bit = 0; bit < 8; bit += 1) {
    crc = (crc >>> 1) ^ (crc & 1 ? 0xedb88320 : 0);
  }
  return crc >>> 0;
});

const requirement = [
  "Turn this fresh blank React app into a visible SkyTurn delivery status screen.",
  "The page must show exactly: SkyTurn delivery complete, Hermes -> Codex, and Ready for verification.",
  "All three strings must render with exact case; CSS text-transform must not alter them.",
  "Keep the app in src/App.jsx and styling in src/App.css.",
  "Only src/App.jsx and src/App.css may be changed or committed.",
  "Do not modify the fixed verification or screenshot-capture contract scripts.",
  "Use exactly these three workflow operations in this order: AnalyzeRequirement, DiscoverProject, then ProposeLanes. Do not emit any other operation.",
  "ProposeLanes must omit its lanes field so the Kernel selects the trusted code-change policy pack.",
  "The trusted policy pack must produce the initial serial chain implementation -> validation -> review -> commit.",
  "Do not emit StartImplementation, RequestValidation, RequestReview, Commit, or DeclareEdge; do not request browser validation in this turn.",
  "The trusted delivery commit must include only src/App.jsx and src/App.css after review succeeds.",
].join("\n");

const followUpRequirement = [
  "Use exactly one WorkflowIntent operation in this turn: ProposeLanes. Do not emit any other operation.",
  "ProposeLanes must include an explicit lanes array containing exactly one unprivileged Codex browser-validation suggestion.",
  "That single suggestion must use laneKind validation and semanticSubtype browser_validation, depend only on the completed commit lane, and require browser plus screenshot evidence.",
  "Let the Kernel's authoritative artifact contract provide the concrete screenshot declaration; do not name a capture helper or artifact path in planner output.",
  "The executable lane may write only its Kernel-declared screenshot artifact; it must not modify tracked source or contract scripts, create another commit, push, or open a pull request.",
  "Keep the planner root stable and add only the minimum verification work needed.",
].join("\n");

const expectedFirstPlannerOperationSummary = [
  { type: "AnalyzeRequirement" },
  { type: "DiscoverProject" },
  { type: "ProposeLanes", lanesMode: "omitted" },
];
const expectedSecondPlannerOperationSummary = [
  { type: "ProposeLanes", lanesMode: "explicit" },
];

export async function runNewSessionUiAcceptance() {
  const demo = await loadDemoHelpers();
  const { demoReadinessPreflight, readinessFailureResult } = demo;
  const bridgeModule = await import("@skyturn/agent-bridge");
  const projectRoot = await mkdtemp(join(tmpdir(), "skyturn-new-session-ui-react-"));
  const userData = await mkdtemp(join(tmpdir(), "skyturn-new-session-ui-user-data-"));
  const durableRunClaimStore = bridgeModule.createDurableRunClaimStore({ root: join(userData, "run-claims") });
  const bridge = new bridgeModule.AgentBridge({
    adapters: [bridgeModule.createHermesCliAdapter(), bridgeModule.createCodexCliAdapter()],
    durableRunClaimStore,
    privateRunEventStore: bridgeModule.createPrivateRunEventStore({ durableRunClaimStore }),
  });
  let cleanupProject = process.env.SKYTURN_NEW_SESSION_UI_CLEANUP === "1";
  let cleanupUserData = process.env.SKYTURN_NEW_SESSION_UI_KEEP_USER_DATA !== "1";

  try {
    await demo.seedBlankReactProject(projectRoot);
    const baselineCommitSha = await gitHeadSha(demo, projectRoot);
    const expectedVerifyScriptHash = await fileSha256(join(projectRoot, "scripts", "verify.mjs"));
    const expectedCaptureScriptHash = await fileSha256(join(projectRoot, "scripts", "capture-screenshot.mjs"));
    const workspacePath = join(userData, "workspace.json");

    const readinessPreflight = await demoReadinessPreflight(bridge);
    if (readinessPreflight.failFast) {
      const failure = readinessFailureResult(readinessPreflight.readiness);
      console.log(JSON.stringify({
        ...emptyAcceptanceResult(projectRoot, readinessPreflight.readiness),
        ...failure,
        projectRoot,
        baselineCommitSha,
        headCommitSha: baselineCommitSha,
        commitSha: baselineCommitSha,
        userData,
        workspacePath,
      }, null, 2));
      process.exitCode = 1;
      return;
    }

    let app = null;
    let liveCdp = null;
    let automationCleanupDiagnostic = null;
    let failureCollection = null;
    try {
      app = await launchElectronAcceptanceApp({ userData, projectRoot });
    } catch (error) {
      console.log(JSON.stringify({
        ...emptyAcceptanceResult(projectRoot, readinessPreflight.readiness),
        baselineCommitSha,
        headCommitSha: baselineCommitSha,
        commitSha: baselineCommitSha,
        failure: {
          code: "ELECTRON_LAUNCH_FAILED",
          message: "Electron did not reach the renderer automation target.",
          diagnostic: error instanceof Error ? error.message : String(error),
        },
        userData,
        workspacePath,
      }, null, 2));
      process.exitCode = 1;
      return;
    }
    try {
      liveCdp = await connectToReadySkyTurnRenderer({
        cdpPort: app.cdpPort,
        devServerUrl: app.devServerUrl,
        projectRoot,
        processDiagnostics: app.diagnostics,
      });
      try {
        await openProjectThroughUi(liveCdp, projectRoot);
        await fillTextareaAndClickCreate(liveCdp, requirement);
        const firstAuthoritative = await waitForWorkflowCompletion({
          cdp: liveCdp,
          baselineCommitSha,
          workspacePath,
          projectRoot,
          graphSummary: demo.flowKernelGraphSummary,
          readiness: readinessPreflight.readiness,
        });
        const firstSession = firstAuthoritative.canvasSession;
        if (!firstSession) throw new Error("New Session did not create an authoritative CanvasSession.");

        await submitCanvasInput(liveCdp, followUpRequirement);
        const secondAuthoritative = await waitForAuthoritativePlannerTurns({
          cdp: liveCdp,
          projectRoot,
          sessionId: firstSession.id,
          expectedTurns: 2,
        });
        await waitForWorkspaceSession(workspacePath, secondAuthoritative.canvasSession);
        liveCdp.close();
        liveCdp = null;
        await app.close();
        app = null;
        await overwriteWorkspaceSessionWithStaleClone(workspacePath, secondAuthoritative.canvasSession);

        app = await launchElectronAcceptanceApp({ userData, projectRoot });
        liveCdp = await connectToReadySkyTurnRenderer({
          cdpPort: app.cdpPort,
          devServerUrl: app.devServerUrl,
          projectRoot,
          processDiagnostics: app.diagnostics,
        });
        await waitForStoredProjectRegistration(liveCdp, projectRoot);
        const reopenedAuthoritative = await waitForAuthoritativePlannerTurns({
          cdp: liveCdp,
          projectRoot,
          sessionId: firstSession.id,
          expectedTurns: 2,
        });
        const rendererReplay = await inspectRendererProjection(liveCdp, reopenedAuthoritative.canvasSession);

        const replay = plannerTurnReplayVerification({
          first: firstAuthoritative,
          second: secondAuthoritative,
          reopened: reopenedAuthoritative,
        });
        const session = reopenedAuthoritative.canvasSession;
        const verification = await collectFinalVerification({
          authoritativeEvidence: reopenedAuthoritative.authoritativeEvidence,
          baselineCommitSha,
          demo,
          expectedCaptureScriptHash,
          expectedVerifyScriptHash,
          projectRoot,
          projection: reopenedAuthoritative.projection,
          replay,
          secondTurnLaneIds: replay.secondTurnLaneIds,
          session,
        });
        const mockFallback = mockFallbackForReadiness(readinessPreflight.readiness);
        const predicateOk = verification.ok && replay.ok && rendererReplay.ok && mockFallback === false;
        const outcomeCleanup = await finalizeAcceptanceOutcome({ app, liveCdp, ok: predicateOk });
        if (!outcomeCleanup.cleanupConfirmed) {
          cleanupProject = false;
          cleanupUserData = false;
        }
        app = null;
        liveCdp = null;
        const ok = predicateOk && outcomeCleanup.ok;
        cleanupProject = cleanupProject && ok;

        console.log(JSON.stringify({
          ok,
          mockFallback,
          readiness: readinessPreflight.readiness,
          failure: ok
            ? null
            : {
                code: "NEW_SESSION_UI_ACCEPTANCE_FAILED",
                message: "Real Electron New Session UI acceptance predicates did not all pass.",
                diagnostic: [
                  verification.diagnostic,
                  replay.ok ? null : replay.diagnostic,
                  rendererReplay.ok ? null : rendererReplay.diagnostic,
                  mockFallback === false ? null : "mock-fallback-enabled",
                  outcomeCleanup.diagnostic,
                ]
                  .filter(Boolean)
                  .join(", "),
              },
          projectRoot,
          userData,
          workspacePath,
          sessionId: session?.id ?? null,
          sessionTarget: verification.sessionTarget,
          requirement,
          followUpRequirement,
          plannerTurnReplay: replay,
          rendererReplay,
          laneStatuses: laneStatuses(session),
          laneKindEvidence: verification.laneKindEvidence,
          strictWorkflow: verification.strictWorkflow,
          cleanup: outcomeCleanup,
          runEvidence: runEvidenceSummary(reopenedAuthoritative.authoritativeEvidence),
          agentRunEvidence: agentRunEvidenceSummary(session, reopenedAuthoritative.authoritativeEvidence),
          screenshot: {
            path: verification.screenshotPath,
            bytes: verification.screenshotBytes,
          },
          screenshotVerification: verification.screenshotVerification,
          verificationCommand: verification.verificationCommand,
          verificationScript: verification.verificationScript,
          captureScript: verification.captureScript,
          verificationScriptHashUnchanged: verification.verificationScript.unchanged,
          captureScriptHashUnchanged: verification.captureScript.unchanged,
          commitCount: verification.commitCount,
          deliveryCommitCount: verification.deliveryCommitCount,
          commitSha: verification.commitSha,
          baselineCommitSha: verification.baselineCommitSha,
          headCommitSha: verification.headCommitSha,
          changedFiles: verification.changedFiles,
          allChangedFilesSinceBaseline: verification.changedFiles,
          expectedChangedFiles,
          unexpectedChangedFiles: verification.unexpectedChangedFiles,
          missingChangedFiles: verification.missingChangedFiles,
          gitStatus: verification.gitStatus,
          graph: verification.graph,
        }, null, 2));

        if (!ok) process.exitCode = 1;
      } catch (error) {
        let outcomeCleanup;
        try {
          const failureOutcome = await shutdownAndCollectFailure({
            app,
            liveCdp,
            collect: (precloseSnapshot) => collectFailureAcceptanceResult({
              baselineCommitSha,
              demo,
              expectedCaptureScriptHash,
              expectedVerifyScriptHash,
              precloseSnapshot,
              projectRoot,
              readiness: readinessPreflight.readiness,
              userData,
            }),
          });
          failureCollection = failureOutcome.collection;
          outcomeCleanup = {
            ok: true,
            cleanupConfirmed: true,
            resourcesKeptAlive: false,
            cancelledRunIds: [],
            diagnostic: failureOutcome.diagnostic,
          };
        } catch (shutdownError) {
          outcomeCleanup = {
            ok: false,
            cleanupConfirmed: shutdownError?.electronShutdownCompleted === true,
            resourcesKeptAlive: shutdownError?.electronShutdownCompleted !== true,
            cancelledRunIds: [],
            diagnostic: `failure-shutdown-or-collection-failed:${errorText(shutdownError)}`,
          };
        }
        if (!outcomeCleanup.cleanupConfirmed) {
          cleanupProject = false;
          cleanupUserData = false;
        }
        app = null;
        liveCdp = null;
        automationCleanupDiagnostic = outcomeCleanup.diagnostic;
        throw error;
      }
    } catch (error) {
      if (error instanceof WorkflowTerminalFailureError) {
        const failure = appendFailureDiagnostic(error.result.failure, automationCleanupDiagnostic);
        console.log(JSON.stringify({
          ...mergeWorkflowTerminalFailureResult(error.result, failureCollection, failure),
          userData,
          workspacePath,
        }, null, 2));
        process.exitCode = 1;
        return;
      }
      const headCommitSha = await gitHeadShaOrNull(projectRoot);
      console.log(JSON.stringify({
        ...emptyAcceptanceResult(projectRoot, readinessPreflight.readiness),
        ...failureCollection,
        baselineCommitSha,
        headCommitSha: failureCollection?.headCommitSha ?? headCommitSha,
        commitSha: failureCollection?.commitSha ?? headCommitSha,
        failure: {
          code: "RENDERER_AUTOMATION_FAILED",
          message: "Electron renderer automation failed before workflow completion.",
          diagnostic: [
            error instanceof Error ? error.message : String(error),
            automationCleanupDiagnostic,
          ].filter(Boolean).join(", "),
        },
        userData,
        workspacePath,
      }, null, 2));
      process.exitCode = 1;
    } finally {
      await app?.close();
    }
  } finally {
    if (cleanupProject) await rm(projectRoot, { recursive: true, force: true });
    if (cleanupUserData) await rm(userData, { recursive: true, force: true });
  }
}

export async function cancelActiveAgentRuns(cdp, reason) {
  const result = await cdp.evaluate(`
    (async () => {
      const terminalStatuses = new Set(["succeeded", "failed", "cancelled", "timed-out"]);
      const activeRunsFrom = (listed) => {
        if (!Array.isArray(listed?.runs)) throw new Error("Agent run list was not authoritative.");
        const active = listed.runs.filter((run) => !terminalStatuses.has(run?.status));
        if (active.some((run) => typeof run?.id !== "string" || run.id.length === 0)) {
          throw new Error("Active agent run was missing an id.");
        }
        return active;
      };
      const active = activeRunsFrom(await window.devflow.listAgentRuns());
      const outcomes = await Promise.allSettled(active.map((run) =>
        window.devflow.cancelAgentRun(run.id, ${JSON.stringify(reason)})
      ));
      const failedRunIds = outcomes.flatMap((outcome, index) =>
        outcome.status === "rejected" ? [active[index].id] : []
      );
      if (failedRunIds.length > 0) {
        throw new Error("Failed to cancel active agent runs: " + failedRunIds.join(", "));
      }
      const remaining = activeRunsFrom(await window.devflow.listAgentRuns());
      return {
        cancelledRunIds: active.map((run) => run.id),
        activeRunIds: remaining.map((run) => run.id),
      };
    })()
  `, { awaitPromise: true, returnByValue: true });

  if (
    !Array.isArray(result?.cancelledRunIds) ||
    !result.cancelledRunIds.every((runId) => typeof runId === "string" && runId.length > 0) ||
    !Array.isArray(result?.activeRunIds) ||
    !result.activeRunIds.every((runId) => typeof runId === "string" && runId.length > 0)
  ) {
    throw new Error("Invalid agent cleanup barrier result.");
  }
  if (result.activeRunIds.length > 0) {
    const cleanupError = new Error(`active-agent-runs-remain:${result.activeRunIds.join(",")}`);
    cleanupError.cancelledRunIds = result.cancelledRunIds;
    throw cleanupError;
  }
  return result.cancelledRunIds;
}

export async function capturePrecloseFailureSnapshot(cdp) {
  if (!cdp) throw new Error("live-cdp-unavailable");
  return cdp.evaluate(`
    (async () => {
      const workspace = await window.devflow.loadWorkspace();
      const visibleNodes = [...document.querySelectorAll('.react-flow__node[data-id]')].map((node) => ({
        id: node.getAttribute('data-id'),
        text: node.textContent?.replace(/\\s+/g, ' ').trim() ?? '',
      }));
      return {
        workspace,
        ui: {
          href: location.origin + location.pathname,
          title: document.title,
          visibleNodes,
          failureBanner: document.querySelector('[role="alert"]')?.textContent?.replace(/\\s+/g, ' ').trim() ?? null,
        },
      };
    })()
  `, {
    awaitPromise: true,
    returnByValue: true,
    requestTimeoutMs: controlPlaneCdpRequestTimeoutMs,
  });
}

export async function shutdownAndCollectFailure({
  app,
  liveCdp,
  collect,
  capture = capturePrecloseFailureSnapshot,
}) {
  if (!app || typeof app.shutdownForFailureCollection !== "function") {
    throw new Error("Electron failure shutdown is unavailable.");
  }
  if (typeof collect !== "function") throw new TypeError("Failure collector is required.");

  let precloseSnapshot;
  let snapshotDiagnostic = null;
  try {
    precloseSnapshot = await capture(liveCdp);
  } catch (error) {
    snapshotDiagnostic = `preclose-snapshot-failed:${errorText(error)}`;
    precloseSnapshot = { workspace: null, ui: null, diagnostic: snapshotDiagnostic };
  }

  const shutdown = await app.shutdownForFailureCollection(liveCdp);
  try {
    const collection = await collect(precloseSnapshot);
    return {
      collection,
      diagnostic: [snapshotDiagnostic, shutdown?.diagnostic].filter(Boolean).join(", ") || null,
      precloseSnapshot,
    };
  } catch (error) {
    if (error && typeof error === "object") error.electronShutdownCompleted = true;
    throw error;
  }
}

export async function finalizeAcceptanceOutcome({
  app,
  liveCdp,
  ok,
  error = null,
  afterRunCleanup = null,
}) {
  const shouldCancel = error !== null || ok === false;
  const diagnostics = [];
  let cancelledRunIds = [];
  let cleanupConfirmed = !shouldCancel;
  let cleanupError = null;

  if (app && typeof app.shutdownForFailureCollection === "function" && liveCdp) {
    try {
      const shutdown = await app.shutdownForFailureCollection(liveCdp);
      return {
        ok: true,
        cleanupConfirmed: true,
        resourcesKeptAlive: false,
        cancelledRunIds: [],
        diagnostic: shutdown?.diagnostic ?? null,
      };
    } catch (shutdownError) {
      return {
        ok: false,
        cleanupConfirmed: false,
        resourcesKeptAlive: true,
        cancelledRunIds: [],
        diagnostic: `electron-graceful-shutdown-failed:${errorText(shutdownError)}`,
      };
    }
  }

  if (shouldCancel) {
    if (!liveCdp) {
      cleanupError = new Error("live-cdp-unavailable");
    } else {
      for (let attempt = 0; attempt < 2; attempt += 1) {
        try {
          const attemptCancelledRunIds = await cancelActiveAgentRuns(
            liveCdp,
            error === null
              ? "New Session UI acceptance predicates failed."
              : "New Session UI acceptance aborted.",
          );
          cancelledRunIds = [...new Set([...cancelledRunIds, ...attemptCancelledRunIds])];
          cleanupConfirmed = true;
          cleanupError = null;
          break;
        } catch (cancellationError) {
          if (Array.isArray(cancellationError?.cancelledRunIds)) {
            cancelledRunIds = [...new Set([...cancelledRunIds, ...cancellationError.cancelledRunIds])];
          }
          cleanupError = cancellationError;
        }
      }
    }
  }

  if (!cleanupConfirmed) {
    diagnostics.push(`run-cleanup-fail-closed:${errorText(cleanupError)}`);
    return {
      ok: false,
      cleanupConfirmed: false,
      resourcesKeptAlive: true,
      cancelledRunIds,
      diagnostic: diagnostics.join(", "),
    };
  }

  if (typeof afterRunCleanup === "function") {
    try {
      await afterRunCleanup();
    } catch (collectionError) {
      diagnostics.push(`failure-collection-failed:${errorText(collectionError)}`);
    }
  }

  try {
    liveCdp?.close();
  } catch (closeError) {
    diagnostics.push(`cdp-close-failed:${errorText(closeError)}`);
  }
  try {
    await app?.close();
  } catch (closeError) {
    diagnostics.push(`electron-close-failed:${errorText(closeError)}`);
  }

  return {
    ok: diagnostics.length === 0,
    cleanupConfirmed: true,
    resourcesKeptAlive: false,
    cancelledRunIds,
    diagnostic: diagnostics.length === 0 ? null : diagnostics.join(", "),
  };
}

export function mergeWorkflowTerminalFailureResult(
  authoritativeResult,
  failureCollection,
  failure = authoritativeResult?.failure,
) {
  return {
    ...(failureCollection ?? {}),
    ...(authoritativeResult ?? {}),
    failure,
  };
}

function appendFailureDiagnostic(failure, diagnostic) {
  if (!diagnostic) return failure;
  return {
    ...(failure ?? {}),
    diagnostic: [failure?.diagnostic, diagnostic].filter(Boolean).join(", "),
  };
}

function errorText(error) {
  return error instanceof Error ? error.message : String(error);
}

function hasManagedOutputOverflow(error) {
  if (error instanceof Error && error.message === MANAGED_OUTPUT_OVERFLOW_DIAGNOSTIC) return true;
  return error instanceof AggregateError && error.errors.some(hasManagedOutputOverflow);
}

export async function fileSha256(filePath) {
  return createHash("sha256").update(await readFile(filePath)).digest("hex");
}

export async function verifyScreenshotCausalBinding({
  demo,
  expectedCaptureScriptHash,
  projectRoot,
}) {
  const captureScriptPath = join(projectRoot, "scripts", "capture-screenshot.mjs");
  const lanePath = join(projectRoot, browserScreenshotArtifact);
  const independentPath = join(projectRoot, independentBrowserScreenshotArtifact);
  const captureScriptBeforeSha256 = await fileSha256OrNull(captureScriptPath);
  const captureScriptPreflightValid = captureScriptBeforeSha256 === expectedCaptureScriptHash;
  const laneBefore = await inspectPngArtifact(lanePath);
  const independentBefore = await inspectPngArtifact(independentPath);
  const canCapture = captureScriptPreflightValid && !independentBefore.exists &&
    laneBefore.bytes > minimumScreenshotBytes && laneBefore.validPng;
  const command = `${process.execPath} scripts/capture-screenshot.mjs ${independentPath}`;
  const captureResult = canCapture
    ? await demo.runCapture(
        process.execPath,
        ["scripts/capture-screenshot.mjs", independentPath],
        projectRoot,
        { allowFailure: true },
      )
    : skippedCommandResult("lane screenshot or fixed capture helper failed preflight");
  const captureScriptAfterSha256 = await fileSha256OrNull(captureScriptPath);
  const captureScriptUnchanged = captureScriptPreflightValid &&
    captureScriptAfterSha256 === expectedCaptureScriptHash;
  const laneAfter = await inspectPngArtifact(lanePath);
  const independent = captureResult.code === 0
    ? await inspectPngArtifact(independentPath)
    : emptyPngArtifact(independentPath);
  const laneUnchanged = samePngArtifactSnapshot(laneBefore, laneAfter);
  const independentStableRegularFile = independent.exists && independent.identity !== null;
  const contentIdentity = laneBefore.validPng && independent.validPng && independentStableRegularFile &&
    laneBefore.sha256 !== null && laneBefore.sha256 === independent.sha256;
  const failures = [];

  if (!captureScriptUnchanged) failures.push("capture-script-changed");
  if (independentBefore.exists) failures.push("independent-screenshot-preexisting");
  if (!laneBefore.exists) failures.push("lane-screenshot-missing");
  if (laneBefore.exists && laneBefore.bytes <= minimumScreenshotBytes) failures.push("lane-screenshot-too-small");
  if (laneBefore.exists && !laneBefore.validPng) failures.push("lane-screenshot-invalid-png");
  if (canCapture && captureResult.code !== 0) failures.push(`capture-exit-${captureResult.code}`);
  if (captureResult.code === 0) {
    if (!independent.exists) failures.push("independent-screenshot-missing");
    if (independent.exists && independent.bytes <= minimumScreenshotBytes) failures.push("independent-screenshot-too-small");
    if (independent.exists && !independent.validPng) failures.push("independent-screenshot-invalid-png");
    if (laneBefore.validPng && independent.validPng && !contentIdentity) {
      failures.push("screenshot-content-mismatch");
    }
  }
  if (!laneUnchanged) failures.push("lane-screenshot-mutated");

  return {
    ok: failures.length === 0,
    failures,
    command,
    captureResult: boundedCommandOutput(captureResult, commandOutputLimitBytes),
    captureScript: {
      path: captureScriptPath,
      unchanged: captureScriptUnchanged,
      expectedSha256: expectedCaptureScriptHash,
      actualSha256: captureScriptAfterSha256,
      beforeSha256: captureScriptBeforeSha256,
      afterSha256: captureScriptAfterSha256,
    },
    lane: {
      path: lanePath,
      exists: laneBefore.exists,
      bytes: laneBefore.bytes,
      sha256: laneBefore.sha256,
      validPng: laneBefore.validPng,
      identity: laneBefore.identity,
      unchanged: laneUnchanged,
      afterExists: laneAfter.exists,
      afterBytes: laneAfter.bytes,
      afterSha256: laneAfter.sha256,
      afterIdentity: laneAfter.identity,
    },
    independent,
    contentIdentity,
  };
}

async function inspectPngArtifact(path) {
  const noFollow = fsConstants.O_NOFOLLOW;
  if (
    process.platform === "win32" ||
    typeof noFollow !== "number" ||
    noFollow === 0
  ) {
    return inspectUnsafePathArtifact(path);
  }

  let handle;
  let descriptorBefore = null;
  let result;
  try {
    const nonBlocking = typeof fsConstants.O_NONBLOCK === "number" ? fsConstants.O_NONBLOCK : 0;
    handle = await open(path, fsConstants.O_RDONLY | noFollow | nonBlocking);
    descriptorBefore = await handle.stat({ bigint: true });
    result = await inspectOpenedPngArtifact(path, handle, descriptorBefore);
  } catch {
    result = descriptorBefore
      ? invalidPngArtifact(path, descriptorBefore)
      : await inspectUnsafePathArtifact(path);
  } finally {
    if (handle) {
      try {
        await handle.close();
      } catch {
        result = descriptorBefore
          ? invalidPngArtifact(path, descriptorBefore)
          : await inspectUnsafePathArtifact(path);
      }
    }
  }
  return result ?? emptyPngArtifact(path);
}

async function inspectOpenedPngArtifact(path, handle, descriptorBefore) {
  if (!descriptorBefore.isFile() || descriptorBefore.size > BigInt(maximumPngFileBytes)) {
    const descriptorAfter = await handle.stat({ bigint: true });
    const pathAfter = await lstat(path, { bigint: true });
    const identity = sameStableStat(descriptorBefore, descriptorAfter) &&
      samePathObject(descriptorAfter, pathAfter)
      ? pngArtifactIdentity(descriptorAfter)
      : null;
    return invalidPngArtifact(path, descriptorAfter, identity);
  }

  const chunks = [];
  let totalBytes = 0;
  while (totalBytes <= maximumPngFileBytes) {
    const remaining = maximumPngFileBytes + 1 - totalBytes;
    if (remaining <= 0) break;
    const buffer = Buffer.allocUnsafe(Math.min(pngReadChunkBytes, remaining));
    const { bytesRead } = await handle.read(buffer, 0, buffer.length, totalBytes);
    if (bytesRead === 0) break;
    chunks.push(buffer.subarray(0, bytesRead));
    totalBytes += bytesRead;
  }

  const descriptorAfter = await handle.stat({ bigint: true });
  const pathAfter = await lstat(path, { bigint: true });
  const stable = sameStableStat(descriptorBefore, descriptorAfter) &&
    descriptorAfter.isFile() && pathAfter.isFile() &&
    sameStableStat(descriptorAfter, pathAfter);
  if (
    !stable ||
    descriptorAfter.size > BigInt(maximumPngFileBytes) ||
    totalBytes !== Number(descriptorAfter.size)
  ) {
    return invalidPngArtifact(path, descriptorAfter);
  }

  const bytes = Buffer.concat(chunks, totalBytes);
  return {
    path,
    exists: true,
    bytes: totalBytes,
    sha256: createHash("sha256").update(bytes).digest("hex"),
    validPng: validPng(bytes),
    identity: pngArtifactIdentity(descriptorAfter),
  };
}

async function inspectUnsafePathArtifact(path) {
  try {
    return invalidPngArtifact(path, await lstat(path, { bigint: true }));
  } catch {
    return emptyPngArtifact(path);
  }
}

function invalidPngArtifact(path, metadata, identity = null) {
  return {
    path,
    exists: true,
    bytes: boundedStatSize(metadata.size),
    sha256: null,
    validPng: false,
    identity,
  };
}

function boundedStatSize(size) {
  const maximum = BigInt(Number.MAX_SAFE_INTEGER);
  return Number(size > maximum ? maximum : size);
}

function pngArtifactIdentity(metadata) {
  return {
    device: metadata.dev.toString(),
    inode: metadata.ino.toString(),
    size: metadata.size.toString(),
    mtimeNs: metadata.mtimeNs.toString(),
    ctimeNs: metadata.ctimeNs.toString(),
  };
}

function sameStableStat(left, right) {
  return left.dev === right.dev && left.ino === right.ino && left.mode === right.mode &&
    left.size === right.size && left.mtimeNs === right.mtimeNs && left.ctimeNs === right.ctimeNs;
}

function samePathObject(descriptor, pathMetadata) {
  return descriptor.dev === pathMetadata.dev && descriptor.ino === pathMetadata.ino;
}

function samePngArtifactSnapshot(before, after) {
  if (before.exists !== after.exists) return false;
  if (!before.exists) return true;
  if (before.identity === null || after.identity === null) return false;
  return before.bytes === after.bytes && before.sha256 === after.sha256 &&
    before.identity.device === after.identity.device &&
    before.identity.inode === after.identity.inode &&
    before.identity.size === after.identity.size &&
    before.identity.mtimeNs === after.identity.mtimeNs &&
    before.identity.ctimeNs === after.identity.ctimeNs;
}

function validPng(bytes) {
  if (bytes.length < 45 || !bytes.subarray(0, pngSignature.length).equals(pngSignature)) return false;

  let offset = pngSignature.length;
  let chunkIndex = 0;
  let ihdr = null;
  let paletteEntries = null;
  let sawIdat = false;
  let endedIdat = false;
  let sawIend = false;
  let compressedBytes = 0;
  const idatParts = [];

  while (offset < bytes.length) {
    if (sawIend || chunkIndex >= maximumPngChunkCount || bytes.length - offset < 12) return false;
    const length = bytes.readUInt32BE(offset);
    const dataStart = offset + 8;
    const dataEnd = dataStart + length;
    const chunkEnd = dataEnd + 4;
    if (length > maximumPngFileBytes || chunkEnd > bytes.length) return false;

    const typeBytes = bytes.subarray(offset + 4, dataStart);
    const type = typeBytes.toString("ascii");
    if (!/^[A-Za-z]{4}$/.test(type) || (typeBytes[2] & 0x20) !== 0) return false;
    const data = bytes.subarray(dataStart, dataEnd);
    if (pngCrc32(typeBytes, data) !== bytes.readUInt32BE(dataEnd)) return false;
    if (chunkIndex === 0 && type !== "IHDR") return false;

    if (type === "IHDR") {
      if (chunkIndex !== 0 || ihdr !== null || length !== 13) return false;
      ihdr = parsePngHeader(data);
      if (ihdr === null) return false;
    } else if (type === "PLTE") {
      if (ihdr === null || paletteEntries !== null || sawIdat || length === 0 || length % 3 !== 0 || length > 768) {
        return false;
      }
      if (ihdr.colorType === 0 || ihdr.colorType === 4) return false;
      paletteEntries = length / 3;
      if (ihdr.colorType === 3 && paletteEntries > 2 ** ihdr.bitDepth) return false;
    } else if (type === "IDAT") {
      if (ihdr === null || endedIdat) return false;
      if (ihdr.colorType === 3 && paletteEntries === null) return false;
      sawIdat = true;
      compressedBytes += length;
      if (compressedBytes > maximumPngFileBytes) return false;
      idatParts.push(data);
    } else if (type === "IEND") {
      if (ihdr === null || !sawIdat || length !== 0) return false;
      sawIend = true;
    } else {
      if ((typeBytes[0] & 0x20) === 0) return false;
      if (sawIdat) endedIdat = true;
    }

    if (sawIdat && type !== "IDAT" && type !== "IEND") endedIdat = true;
    offset = chunkEnd;
    chunkIndex += 1;
  }

  if (!sawIend || offset !== bytes.length || ihdr === null) return false;
  return validInflatedPngData(Buffer.concat(idatParts, compressedBytes), ihdr);
}

function parsePngHeader(data) {
  const width = data.readUInt32BE(0);
  const height = data.readUInt32BE(4);
  const bitDepth = data[8];
  const colorType = data[9];
  const legalBitDepths = {
    0: [1, 2, 4, 8, 16],
    2: [8, 16],
    3: [1, 2, 4, 8],
    4: [8, 16],
    6: [8, 16],
  };
  if (
    width === 0 || height === 0 ||
    width > maximumPngDimension || height > maximumPngDimension ||
    data[10] !== 0 || data[11] !== 0 || data[12] !== 0 ||
    !legalBitDepths[colorType]?.includes(bitDepth)
  ) {
    return null;
  }
  return { width, height, bitDepth, colorType };
}

function validInflatedPngData(compressed, header) {
  const channelsByColorType = { 0: 1, 2: 3, 3: 1, 4: 2, 6: 4 };
  const channels = channelsByColorType[header.colorType];
  const rowBytes = Math.ceil((header.width * channels * header.bitDepth) / 8);
  const expectedBytes = header.height * (rowBytes + 1);
  if (expectedBytes === 0 || expectedBytes > maximumInflatedPngBytes) return false;

  try {
    const inflated = inflateSync(compressed, { maxOutputLength: expectedBytes });
    if (inflated.length !== expectedBytes) return false;
    for (let row = 0; row < header.height; row += 1) {
      if (inflated[row * (rowBytes + 1)] > 4) return false;
    }
    return true;
  } catch {
    return false;
  }
}

function pngCrc32(typeBytes, data) {
  let crc = 0xffffffff;
  for (const bytes of [typeBytes, data]) {
    for (const byte of bytes) {
      crc = (crc >>> 8) ^ pngCrcTable[(crc ^ byte) & 0xff];
    }
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function emptyPngArtifact(path) {
  return { path, exists: false, bytes: 0, sha256: null, validPng: false, identity: null };
}

async function fileSha256OrNull(filePath) {
  try {
    return await fileSha256(filePath);
  } catch {
    return null;
  }
}

export async function launchElectronAcceptanceApp({ userData, projectRoot }) {
  const rendererPort = await findAvailablePort(DEFAULT_RENDERER_PORT, RENDERER_HOST);
  const cdpPort = await findAvailablePort(rendererPort + 50, RENDERER_HOST);
  const devServerUrl = makeDevServerUrl(rendererPort, RENDERER_HOST);
  const [rendererCommand, rendererArgs] = rendererDevCommand(rendererPort, RENDERER_HOST);
  const vite = spawnManaged(rendererCommand, rendererArgs, {
    cwd: desktopRoot,
    env: process.env,
    label: "Vite renderer",
  });
  let electron = null;
  try {
    await waitForHttpOk(devServerUrl, "renderer dev server", vite);

    const electronBinary = require("electron");
    const electronArgs = [
      `--remote-debugging-port=${cdpPort}`,
      `--user-data-dir=${userData}`,
      "--disable-gpu",
      "--no-sandbox",
      join(desktopRoot, "dist-electron", "electron", "main.js"),
    ];
    electron = spawnManaged(electronBinary, electronArgs, {
      cwd: desktopRoot,
      env: {
        ...process.env,
        ELECTRON_DISABLE_SECURITY_WARNINGS: "1",
        SKYTURN_ENABLE_PTY_INTERACTIVE: "0",
        SKYTURN_AGENT_WATCHDOG_TIMEOUT_MS: String(agentWatchdogTimeoutMs),
        SKYTURN_NEW_SESSION_UI_ACCEPTANCE: "1",
        SKYTURN_NEW_SESSION_UI_PROJECT_ROOT: projectRoot,
        VITE_DEV_SERVER_URL: devServerUrl,
      },
      label: "Electron",
    });
    await waitForCdp(cdpPort, electron);
  } catch (error) {
    const cleanupResults = await Promise.allSettled(electron ? [electron.close(), vite.close()] : [vite.close()]);
    const cleanupFailures = cleanupResults.flatMap((result) => result.status === "rejected" ? [result.reason] : []);
    if ([error, ...cleanupFailures].some(hasManagedOutputOverflow)) {
      throw new Error(MANAGED_OUTPUT_OVERFLOW_DIAGNOSTIC);
    }
    if (cleanupFailures.length > 0) {
      throw new AggregateError([error, ...cleanupFailures], "Electron acceptance launch and cleanup failed.");
    }
    throw error;
  }

  return {
    cdpPort,
    devServerUrl,
    diagnostics() {
      const diagnostics = [vite.diagnosticOutput(), electron.diagnosticOutput()].filter(Boolean);
      return diagnostics.includes(MANAGED_OUTPUT_OVERFLOW_DIAGNOSTIC)
        ? MANAGED_OUTPUT_OVERFLOW_DIAGNOSTIC
        : diagnostics.join("\n");
    },
    async close() {
      await Promise.all([electron.close(), vite.close()]);
    },
    async shutdownForFailureCollection(cdp) {
      return shutdownElectronForFailureCollection({ cdp, electron, vite });
    },
  };
}

export async function shutdownElectronForFailureCollection({ cdp, electron, vite }) {
  const closeRequest = Promise.resolve().then(() => cdp.evaluate("window.close()", {
    awaitPromise: false,
    returnByValue: true,
    requestTimeoutMs: controlPlaneCdpRequestTimeoutMs,
  }));
  const closeResult = await electron.waitForClose(failureShutdownTimeoutMs);
  const closeRequestResult = await Promise.allSettled([closeRequest]);
  const gracefulFailures = [];
  if (closeRequestResult[0].status === "rejected") {
    gracefulFailures.push(new Error(`CDP window.close() failed: ${errorText(closeRequestResult[0].reason)}`));
  }
  if (!closeResult) {
    gracefulFailures.push(new Error("Electron did not close after window.close()."));
  } else if (closeResult.code !== 0 || closeResult.signal !== null) {
    gracefulFailures.push(new Error(
      `Electron did not close gracefully (${closeResult.signal ? `signal ${closeResult.signal}` : `exit ${closeResult.code}`}).`,
    ));
  }
  try {
    electron.assertOutputWithinLimit?.();
  } catch (error) {
    gracefulFailures.push(error);
  }
  try {
    cdp.close();
  } catch {}
  if (gracefulFailures.length > 0) {
    const cleanupResults = await Promise.allSettled([electron.close(), vite.close()]);
    const cleanupFailures = cleanupResults.flatMap((result) => result.status === "rejected" ? [result.reason] : []);
    if ([...gracefulFailures, ...cleanupFailures].some(hasManagedOutputOverflow)) {
      throw new Error(MANAGED_OUTPUT_OVERFLOW_DIAGNOSTIC);
    }
    throw new AggregateError(
      [...gracefulFailures, ...cleanupFailures],
      `Electron failure shutdown was not graceful: ${gracefulFailures.map(errorText).join("; ")}`,
    );
  }
  await vite.close();
  return { diagnostic: null };
}

export async function openProjectThroughUi(cdp, projectRoot) {
  await cdp.evaluate(`
    (async () => {
      const button = await waitFor(() => [...document.querySelectorAll('button')]
        .find((candidate) => candidate.textContent?.trim() === 'Open Project'), 'Open Project button');
      button.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, view: window }));
      await waitFor(() => document.querySelector('textarea[aria-label="New task goal"]'), 'New Session UI');
      await waitFor(async () => {
        const workspace = await window.devflow.loadWorkspace();
        return workspace?.projects?.some((project) => project.rootPath === ${JSON.stringify(projectRoot)});
      }, 'opened project persistence');
      return true;

      function waitFor(probe, label) {
        const deadline = Date.now() + 15000;
        return new Promise((resolve, reject) => {
          const tick = async () => {
            const value = await probe();
            if (value) {
              resolve(value);
              return;
            }
            if (Date.now() > deadline) {
              reject(new Error('Timed out waiting for ' + label));
              return;
            }
            requestAnimationFrame(tick);
          };
          void tick();
        });
      }
    })()
  `, { awaitPromise: true });
}

export async function waitForStoredProjectRegistration(cdp, projectRoot) {
  const workspace = await cdp.evaluate(`
    (async () => {
      await waitFor(() => typeof window.devflow?.loadWorkspace === 'function', 'workspace loader');
      return window.devflow.loadWorkspace();

      function waitFor(probe, label) {
        const deadline = Date.now() + 15000;
        return new Promise((resolve, reject) => {
          const tick = () => {
            const value = probe();
            if (value) {
              resolve(value);
              return;
            }
            if (Date.now() > deadline) {
              reject(new Error('Timed out waiting for ' + label));
              return;
            }
            requestAnimationFrame(tick);
          };
          tick();
        });
      }
    })()
  `, { awaitPromise: true, returnByValue: true });
  const projects = Array.isArray(workspace?.projects) ? workspace.projects : [];
  if (!projects.some((project) => project?.rootPath === projectRoot)) {
    throw new Error("Stored project was not registered by workspace loading.");
  }
  return workspace;
}

export async function fillTextareaAndClickCreate(cdp, text) {
  await cdp.evaluate(`
    (async () => {
      const textarea = await waitForElement('textarea[aria-label="New task goal"]');
      const button = await waitForElement('button[aria-label="Create"]');
      const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value').set;
      textarea.focus();
      setter.call(textarea, ${JSON.stringify(text)});
      textarea.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'insertText', data: ${JSON.stringify(text)} }));
      textarea.dispatchEvent(new Event('change', { bubbles: true }));
      await waitFor(() => !button.disabled, 'Create button enabled');
      button.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, view: window }));
      return true;

      function waitForElement(selector) {
        return waitFor(() => document.querySelector(selector), selector);
      }

      function waitFor(probe, label) {
        const deadline = Date.now() + 15000;
        return new Promise((resolve, reject) => {
          const tick = () => {
            const value = probe();
            if (value) {
              resolve(value);
              return;
            }
            if (Date.now() > deadline) {
              reject(new Error('Timed out waiting for ' + label));
              return;
            }
            requestAnimationFrame(tick);
          };
          tick();
        });
      }
    })()
  `, { awaitPromise: true });
}

export async function submitCanvasInput(cdp, text) {
  await cdp.evaluate(`
    (async () => {
      const pane = await waitFor(() => document.querySelector('.react-flow__pane'), 'Canvas pane');
      pane.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, view: window }));
      await waitFor(() => !document.querySelector('.node-modal'), 'node modal close');
      const input = await waitFor(() => document.querySelector('input[aria-label="Insert requirement or node"]'), 'generic Canvas input');
      const button = await waitFor(() => document.querySelector('button[aria-label="Submit"]'), 'Canvas submit button');
      const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set;
      input.focus();
      setter.call(input, ${JSON.stringify(text)});
      input.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'insertText', data: ${JSON.stringify(text)} }));
      input.dispatchEvent(new Event('change', { bubbles: true }));
      await waitFor(() => !button.disabled, 'Canvas submit button enabled');
      button.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, view: window }));
      await waitFor(() => input.value === '', 'Canvas input cleared');
      return true;

      function waitFor(probe, label) {
        const deadline = Date.now() + 15000;
        return new Promise((resolve, reject) => {
          const tick = () => {
            const value = probe();
            if (value) {
              resolve(value);
              return;
            }
            if (Date.now() > deadline) {
              reject(new Error('Timed out waiting for ' + label));
              return;
            }
            requestAnimationFrame(tick);
          };
          tick();
        });
      }
    })()
  `, { awaitPromise: true });
}

export function pendingDangerAuthorizationNodes(session) {
  if (session?.kind !== "canvas" || !Array.isArray(session.nodes)) return [];
  return session.nodes.filter((node) => {
    const decision = node?.userDecision;
    const authorization = decision?.runAuthorization;
    return node?.nodeKind === "user_decision" &&
      node.status === "pending" &&
      typeof node.title === "string" && node.title.length > 0 &&
      decision?.decisionId === node.id &&
      typeof decision.prompt === "string" && decision.prompt.length > 0 &&
      decision.status === "waiting_input" &&
      Array.isArray(decision.options) && decision.options.includes(dangerAuthorizationOption) &&
      typeof decision.targetLaneId === "string" && decision.targetLaneId.length > 0 &&
      typeof decision.targetSegmentId === "string" && decision.targetSegmentId.length > 0 &&
      authorization?.sandbox === "danger-full-access" &&
      typeof authorization.runId === "string" && authorization.runId.length > 0 &&
      typeof authorization.startFingerprint === "string" &&
      /^[0-9a-f]{64}$/.test(authorization.startFingerprint);
  });
}

export function dangerAuthorizationDecisionIdentity(node) {
  const decision = node?.userDecision;
  const authorization = decision?.runAuthorization;
  if (
    typeof node?.id !== "string" ||
    typeof decision?.decisionId !== "string" ||
    typeof decision?.targetLaneId !== "string" ||
    typeof decision?.targetSegmentId !== "string" ||
    typeof authorization?.runId !== "string" ||
    typeof authorization?.startFingerprint !== "string"
  ) return null;
  return stableJson({
    decisionId: decision.decisionId,
    nodeId: node.id,
    runId: authorization.runId,
    startFingerprint: authorization.startFingerprint,
    targetLaneId: decision.targetLaneId,
    targetSegmentId: decision.targetSegmentId,
  });
}

export async function reconcileDangerAuthorizationAcknowledgments(
  session,
  submittedDecisions,
  {
    authorize,
    now = () => Date.now(),
    acknowledgmentBudgetMs = dangerAuthorizationAcknowledgmentBudgetMs,
  } = {},
) {
  if (!(submittedDecisions instanceof Map)) {
    throw new TypeError("Danger authorization submissions must be tracked in a Map.");
  }
  if (typeof authorize !== "function") {
    throw new TypeError("Danger authorization UI callback is required.");
  }
  if (!Number.isFinite(acknowledgmentBudgetMs) || acknowledgmentBudgetMs <= 0) {
    throw new RangeError("Danger authorization acknowledgment budget must be positive and finite.");
  }

  const nodes = Array.isArray(session?.nodes) ? session.nodes : [];
  const decisionsByIdentity = new Map(nodes.flatMap((node) => {
    const identity = dangerAuthorizationDecisionIdentity(node);
    return identity === null ? [] : [[identity, node]];
  }));
  const observedAt = now();
  const acknowledgedDecisionIds = [];
  for (const [identity, submitted] of submittedDecisions) {
    const current = decisionsByIdentity.get(identity);
    if (!current || current.userDecision?.status === "answered") {
      submittedDecisions.delete(identity);
      acknowledgedDecisionIds.push(submitted.decisionId);
      continue;
    }
    if (observedAt - submitted.submittedAt >= acknowledgmentBudgetMs) {
      throw new Error(
        `Danger authorization acknowledgment timeout for decision ${submitted.decisionId} ` +
        `(run ${submitted.runId}) after ${acknowledgmentBudgetMs}ms.`,
      );
    }
  }

  const pendingNodes = pendingDangerAuthorizationNodes(session);
  const pendingControl = pendingNodes.find((node) => {
    const identity = dangerAuthorizationDecisionIdentity(node);
    return identity !== null && !submittedDecisions.has(identity);
  });
  if (pendingControl) {
    const identity = dangerAuthorizationDecisionIdentity(pendingControl);
    const outcome = await authorize(pendingControl);
    submittedDecisions.set(identity, {
      decisionId: pendingControl.userDecision.decisionId,
      nodeId: pendingControl.id,
      runId: pendingControl.userDecision.runAuthorization.runId,
      submittedAt: now(),
      outcome: outcome?.outcome ?? null,
    });
    return {
      acknowledgedDecisionIds,
      pending: true,
      submittedDecisionId: pendingControl.userDecision.decisionId,
    };
  }

  return {
    acknowledgedDecisionIds,
    pending: pendingNodes.length > 0 || submittedDecisions.size > 0,
    submittedDecisionId: null,
  };
}

export async function authorizePendingDangerRunThroughUi(cdp, node, {
  now = () => Date.now(),
} = {}) {
  const authorizationDeadline = now() + controlPlaneUiTimeoutMs;
  const result = await cdp.evaluate(`
    (async () => {
      const nodeId = ${JSON.stringify(node.id)};
      const title = ${JSON.stringify(node.title)};
      const decisionPrompt = ${JSON.stringify(node.userDecision.prompt)};
      const moreDetailsLabel = 'More details for ' + title;
      const authorizationOption = ${JSON.stringify(dangerAuthorizationOption)};
      const authorizationDeadline = ${authorizationDeadline};
      const waitFor = (${waitForBrowserProbe.toString()});
      const assertBeforeDeadline = (${assertBrowserDeadline.toString()});
      const findExactAriaLabel = (selector, label) => [...document.querySelectorAll(selector)]
        .find((element) => element.getAttribute('aria-label') === label);
      const findNodeContainer = () => [...document.querySelectorAll('.react-flow__node[data-id]')]
        .find((element) => element.getAttribute('data-id') === nodeId);
      const findMoreDetailsButton = () => [...(findNodeContainer()?.querySelectorAll('button[aria-label]') ?? [])]
        .find((button) => button.getAttribute('aria-label') === moreDetailsLabel);
      const findModal = () => findExactAriaLabel('.node-modal[aria-label]', title);
      const findDecisionPanel = () => [...(findModal()?.querySelectorAll('.decision-panel[aria-label]') ?? [])]
        .find((panel) => panel.getAttribute('aria-label') === decisionPrompt);
      const findAuthorizationButton = () => {
        const panel = findDecisionPanel();
        if (!panel) return null;
        return [...panel.querySelectorAll('button')]
          .find((button) => button.textContent?.trim() === authorizationOption) ?? null;
      };

      const moreDetailsButton = await waitFor(
        findMoreDetailsButton,
        'decision node More details button for ' + title,
        { deadline: authorizationDeadline },
      );
      moreDetailsButton.dispatchEvent(new MouseEvent('click', {
        bubbles: true,
        cancelable: true,
        view: window,
      }));
      await waitFor(findModal, 'decision modal for ' + title, { deadline: authorizationDeadline });
      const authorizationButton = await waitFor(
        findAuthorizationButton,
        'exact danger authorization option for ' + title,
        { deadline: authorizationDeadline },
      );
      const outcome = authorizationButton.disabled ? 'already-disabled' : 'submitted';
      if (!authorizationButton.disabled) {
        assertBeforeDeadline(authorizationDeadline);
        authorizationButton.dispatchEvent(new MouseEvent('click', {
          bubbles: true,
          cancelable: true,
          view: window,
        }));
      }

      const modal = findModal();
      if (modal) {
        const closeButton = await waitFor(
          () => [...modal.querySelectorAll('button[aria-label]')]
            .find((button) => button.getAttribute('aria-label') === 'Close'),
          'decision modal Close button for ' + title,
          { deadline: authorizationDeadline },
        );
        closeButton.dispatchEvent(new MouseEvent('click', {
          bubbles: true,
          cancelable: true,
          view: window,
        }));
        await waitFor(
          () => !findModal(),
          'decision modal close for ' + title,
          { deadline: authorizationDeadline },
        );
      }
      return { outcome, modalClosed: !findModal() };
    })()
  `, {
    awaitPromise: true,
    returnByValue: true,
    requestTimeoutMs: controlPlaneCdpRequestTimeoutMs,
  });
  if (!result?.modalClosed || !["submitted", "already-disabled"].includes(result.outcome)) {
    throw new Error("Danger authorization UI did not reach a confirmed renderer state.");
  }
  return result;
}

async function loadDemoHelpers() {
  return import("./mvpWorkflowDemo.mjs");
}

async function connectToSkyTurnRenderer(cdpPort, devServerUrl) {
  const target = await waitForSkyTurnRendererTarget(cdpPort, devServerUrl);
  const cdp = await CdpClient.connect(target.webSocketDebuggerUrl);
  try {
    await cdp.call("Runtime.enable");
    await cdp.call("Page.enable");
    return cdp;
  } catch (error) {
    cdp.close();
    throw error;
  }
}

export function selectSkyTurnRendererTarget(targets, devServerUrl) {
  if (!Array.isArray(targets)) return null;
  const expectedUrl = normalizedRendererTargetUrl(devServerUrl);
  if (!expectedUrl) return null;
  return targets.find((item) =>
    item?.type === "page" &&
    typeof item.url === "string" &&
    normalizedRendererTargetUrl(item.url) === expectedUrl &&
    typeof item.webSocketDebuggerUrl === "string"
  ) ?? null;
}

function normalizedRendererTargetUrl(value) {
  if (typeof value !== "string") return null;
  try {
    const url = new URL(value);
    if (url.protocol !== "http:" && url.protocol !== "https:") return null;
    return url.href;
  } catch {
    return null;
  }
}

export async function connectToReadySkyTurnRenderer({
  cdpPort,
  devServerUrl,
  projectRoot,
  connect = connectToSkyTurnRenderer,
  assertLoaded = assertSkyTurnRendererReady,
  processDiagnostics = () => "",
  retryDelayMs = 100,
  diagnosticLimitBytes = commandOutputLimitBytes,
}) {
  const attempts = [];
  for (let attempt = 1; attempt <= 2; attempt += 1) {
    let cdp = null;
    try {
      cdp = await connect(cdpPort, devServerUrl);
      await assertLoaded(cdp, projectRoot);
      return cdp;
    } catch (error) {
      attempts.push({
        attempt,
        error: error instanceof Error ? error.message : String(error),
        events: typeof cdp?.diagnosticEvents === "function" ? cdp.diagnosticEvents() : [],
      });
      cdp?.close();
      if (attempt === 2 || !isRendererAcquisitionRetryable(error)) {
        throw new Error(rendererReadinessDiagnostic({
          error,
          attempts,
          processOutput: processDiagnostics(),
          limitBytes: diagnosticLimitBytes,
        }));
      }
      await delay(retryDelayMs);
    }
  }
  throw new Error("Renderer readiness retry exhausted.");
}

function isRendererAcquisitionRetryable(error) {
  const message = error instanceof Error ? error.message : String(error);
  const code = error && typeof error === "object" && typeof error.code === "string" ? error.code : "";
  return /Inspected target navigated or closed|Execution context was destroyed|Cannot find context with specified id|CDP WebSocket (?:upgrade failed|accept header mismatch)|CDP socket closed|socket hang up/i.test(message)
    || /^(?:ECONNRESET|ECONNREFUSED|EPIPE|ETIMEDOUT)$/.test(code);
}

function rendererReadinessDiagnostic({ error, attempts, processOutput, limitBytes }) {
  const sanitizedAttempts = attempts.map((attempt) => ({
    attempt: attempt.attempt,
    error: sanitizeDiagnosticText(attempt.error),
    events: Array.isArray(attempt.events)
      ? attempt.events.map((event) => sanitizeRendererDiagnosticEvent(event)).filter(Boolean)
      : [],
  }));
  const message = [
    sanitizeDiagnosticText(error instanceof Error ? error.message : String(error)),
    `Renderer readiness attempts: ${JSON.stringify(sanitizedAttempts)}`,
    processOutput ? `Process output: ${sanitizeDiagnosticText(processOutput)}` : "",
  ].filter(Boolean).join("; ");
  return boundedDiagnosticText(message, limitBytes);
}

function sanitizeRendererDiagnosticEvent(event) {
  if (!event || typeof event !== "object" || typeof event.method !== "string") return null;
  if (event.method === "Page.frameNavigated") {
    return {
      method: event.method,
      frameId: event.frameId ?? null,
      url: sanitizeDiagnosticUrl(event.url),
    };
  }
  if (event.method === "Page.loadEventFired") return { method: event.method };
  if (event.method === "Runtime.executionContextDestroyed") {
    return {
      method: event.method,
      executionContextId: event.executionContextId ?? null,
    };
  }
  if (event.method === "Runtime.executionContextsCleared") return { method: event.method };
  return null;
}

function sanitizeDiagnosticText(value) {
  return String(value)
    .replace(/\b[a-z][a-z0-9+.-]*:\/\/[^\s"'<>]+/gi, (url) => sanitizeDiagnosticUrl(url) ?? "[redacted-url]")
    .replace(/(^|[\s("'=])\/[^\s"'<>]*/g, (match, prefix) => {
      const target = match.slice(prefix.length);
      return `${prefix}${stripDiagnosticUrlCapability(target)}`;
    });
}

function sanitizeDiagnosticUrl(value) {
  if (typeof value !== "string") return null;
  try {
    const url = new URL(value);
    if (!/^(?:https?|wss?|file):$/.test(url.protocol)) return null;
    url.username = "";
    url.password = "";
    url.search = "";
    url.hash = "";
    return url.href;
  } catch {
    return null;
  }
}

function stripDiagnosticUrlCapability(value) {
  const capabilityIndex = value.search(/[?#]/);
  return capabilityIndex === -1 ? value : value.slice(0, capabilityIndex);
}

function boundedDiagnosticText(value, limitBytes) {
  const limit = Number.isFinite(limitBytes) ? Math.max(0, Math.floor(limitBytes)) : commandOutputLimitBytes;
  const text = String(value);
  if (Buffer.byteLength(text) <= limit) return text;
  const marker = "... [truncated]";
  const markerBytes = Buffer.byteLength(marker);
  if (limit <= markerBytes) return boundedText(marker, limit).value;
  return `${boundedText(text, limit - markerBytes).value}${marker}`;
}

async function assertSkyTurnRendererReady(cdp) {
  const result = await cdp.evaluate(`
    (async () => {
      await waitFor(() => {
        if (!window.devflow) return false;
        const hasOpenProject = [...document.querySelectorAll('button')]
          .some((button) => button.textContent?.trim() === 'Open Project');
        const hasNewSession = document.querySelector('textarea[aria-label="New task goal"]');
        const hasCanvas = document.querySelector('.react-flow');
        return hasOpenProject || hasNewSession || hasCanvas;
      }, 'SkyTurn renderer');
      return true;

      function waitFor(probe, label) {
        const deadline = Date.now() + 15000;
        return new Promise((resolve, reject) => {
          const tick = () => {
            const value = probe();
            if (value) {
              resolve(value);
              return;
            }
            if (Date.now() > deadline) {
              reject(new Error('Timed out waiting for ' + label));
              return;
            }
            requestAnimationFrame(tick);
          };
          tick();
        });
      }
    })()
  `, { awaitPromise: true, returnByValue: true });
  if (result !== true) throw new Error("SkyTurn renderer did not become ready.");
}

async function readAuthoritativePlannerState(cdp, projectRoot, sessionId) {
  const state = await readSqliteWorkflowState(cdp, projectRoot, sessionId);
  const authoritativeEvidence = authoritativeProjectionEvidenceState(state?.projection);
  if (!authoritativeEvidence.ok) {
    throw new Error(`Authoritative projection evidence is invalid: ${authoritativeEvidence.failures.join(", ")}`);
  }
  return { ...state, authoritativeEvidence };
}

async function readSqliteWorkflowState(cdp, projectRoot, sessionId) {
  return cdp.evaluate(`
    Promise.all([
      window.devflow.getWorkflowProjection(${JSON.stringify(projectRoot)}, ${JSON.stringify(sessionId)}),
      window.devflow.getWorkflowEvents(${JSON.stringify(projectRoot)}, ${JSON.stringify(sessionId)}),
    ]).then(([projectionResult, eventResult]) => ({
      projection: projectionResult.projection,
      canvasSession: projectionResult.canvasSession,
      events: eventResult.events,
    }))
  `, { awaitPromise: true, returnByValue: true });
}

async function waitForAuthoritativePlannerTurns({ cdp, projectRoot, sessionId, expectedTurns }) {
  const deadline = Date.now() + waitTimeoutMs;
  let lastState = null;
  while (Date.now() < deadline) {
    const state = await readAuthoritativePlannerState(cdp, projectRoot, sessionId);
    lastState = state ?? lastState;
    if (authoritativePlannerTurnCount(state) >= expectedTurns && authoritativeWorkflowSettled(state)) {
      return state;
    }
    await delay(pollIntervalMs);
  }
  throw new Error(`Timed out waiting for ${expectedTurns} authoritative planner turns. Last state: ${boundedDiagnosticText(JSON.stringify(lastState), commandOutputLimitBytes)}`);
}

export function authoritativePlannerTurnCount(state) {
  return plannerTurnRecords(state).filter((turn) => terminalSegmentStatus(turn.status)).length;
}

export function executableWorkflowNodes(session) {
  const nodes = Array.isArray(session?.nodes) ? session.nodes : [];
  return nodes.filter((node) =>
    node?.id !== session?.plannerNodeId &&
    node?.nodeKind !== "user_decision" &&
    node?.executable !== false &&
    node?.runtimePolicy?.executable !== false
  );
}

function userDecisionsSettled(session) {
  const nodes = Array.isArray(session?.nodes) ? session.nodes : [];
  return nodes
    .filter((node) => node?.nodeKind === "user_decision")
    .every((node) => node?.status === "completed" && node?.userDecision?.status === "answered");
}

export function executableWorkflowSession(session) {
  if (!session || !Array.isArray(session.nodes)) return session;
  const nodeIds = new Set([
    session.plannerNodeId,
    ...executableWorkflowNodes(session).map((node) => node.id),
  ]);
  return {
    ...session,
    nodes: session.nodes.filter((node) => nodeIds.has(node?.id)),
    edges: Array.isArray(session.edges)
      ? session.edges.filter((edge) => nodeIds.has(edge?.source) && nodeIds.has(edge?.target))
      : [],
  };
}

export function authoritativeWorkflowSettled(state) {
  const nodes = state?.canvasSession?.nodes;
  if (!Array.isArray(nodes) || nodes.length === 0) return false;
  const authoritativeEvidence = state?.authoritativeEvidence ??
    authoritativeProjectionEvidenceState(state?.projection);
  if (!authoritativeEvidence.ok) return false;
  if (!nodes.every((node) => node?.status !== "running" && node?.status !== "retrying")) return false;
  if (!userDecisionsSettled(state?.canvasSession)) return false;
  const planner = nodes.find((node) => node?.id === state?.canvasSession?.plannerNodeId);
  if (!planner || planner.status !== "completed") return false;
  const executableNodes = executableWorkflowNodes(state?.canvasSession);
  return executableNodes.length > 0 && executableNodes.every((node) => {
    if (
      node?.status !== "completed" ||
      typeof node.runId !== "string" ||
      node.runId.length === 0
    ) return false;
    const segments = (state?.projection?.segments ?? []).filter((candidate) =>
      candidate?.laneId === node.id && candidate?.runId === node.runId
    );
    if (segments.length !== 1) return false;
    const segment = segments[0];
    if (
      typeof segment.id !== "string" ||
      (segment.status !== "succeeded" && segment.status !== "completed")
    ) return false;
    const evidenceMatches = (state?.projection?.evidence ?? []).filter((candidate) =>
      candidate?.laneId === node.id && candidate?.segmentId === segment.id &&
      candidate?.status === "passed" && candidate?.runEvidence?.runId === node.runId
    );
    if (evidenceMatches.length !== 1) return false;
    const evidence = evidenceMatches[0];
    if (
      typeof evidence.id !== "string" ||
      stableJson(evidence.runEvidence) !== stableJson(authoritativeEvidence.runEvidence[node.runId])
    ) return false;
    const afterCheckpoints = (state?.projection?.checkpoints ?? []).filter((candidate) =>
      candidate?.laneId === node.id && candidate?.runId === node.runId &&
      candidate?.segmentId === segment.id && candidate?.phase === "after"
    );
    if (afterCheckpoints.length !== 1) return false;
    const afterCheckpoint = afterCheckpoints[0];
    return checkpointReferenceFailures({
      checkpoint: afterCheckpoint,
      laneId: node.id,
      phase: "after",
      projection: state?.projection,
      runId: node.runId,
      segmentId: segment.id,
    }).length === 0;
  });
}

function terminalSegmentStatus(status) {
  return ["succeeded", "failed", "cancelled", "timed-out", "completed"].includes(status);
}

async function waitForWorkspaceSession(workspacePath, authoritativeSession) {
  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline) {
    const workspace = await readWorkspaceFile(workspacePath);
    const session = workspace?.sessions?.find((candidate) => candidate?.id === authoritativeSession?.id);
    if (session && stableJson(session) === stableJson(authoritativeSession)) return;
    await delay(100);
  }
  throw new Error("Workspace persistence did not capture the authoritative CanvasSession before restart.");
}

export async function overwriteWorkspaceSessionWithStaleClone(workspacePath, authoritativeSession) {
  const workspace = await readWorkspaceFile(workspacePath);
  const sessionId = authoritativeSession?.id;
  if (!workspace || !Array.isArray(workspace.sessions) || typeof sessionId !== "string") {
    throw new Error("Workspace does not contain the authoritative CanvasSession.");
  }
  const persistedSession = workspace.sessions.find((session) => session?.id === sessionId);
  if (!persistedSession || stableJson(persistedSession) !== stableJson(authoritativeSession)) {
    throw new Error("Workspace CanvasSession does not match the authoritative session before stale injection.");
  }
  const staleSession = {
    ...structuredClone(authoritativeSession),
    nodes: authoritativeSession.nodes.map((node) => ({
      ...node,
      status: "pending",
      progress: "Stale renderer workspace snapshot",
    })),
  };
  const staleWorkspace = {
    ...workspace,
    sessions: workspace.sessions.map((session) => session?.id === sessionId ? staleSession : session),
  };
  await writeFile(workspacePath, `${JSON.stringify(staleWorkspace, null, 2)}\n`);
  return staleSession;
}

async function inspectRendererProjection(cdp, authoritativeSession) {
  const dom = await cdp.evaluate(`
    (async () => {
      await waitFor(() => document.querySelectorAll('.react-flow__node[data-id]').length > 0, 'replayed canvas nodes');
      return {
        nodes: [...document.querySelectorAll('.react-flow__node[data-id]')].map((element) => ({
          id: element.getAttribute('data-id'),
          status: element.querySelector('.agent-node-shell')?.getAttribute('data-state') ?? null,
        })),
        edges: [...document.querySelectorAll('.react-flow__edge[data-id]')]
          .map((element) => element.getAttribute('data-id')),
      };

      function waitFor(probe, label) {
        const deadline = Date.now() + 15000;
        return new Promise((resolve, reject) => {
          const tick = () => {
            const value = probe();
            if (value) {
              resolve(value);
              return;
            }
            if (Date.now() > deadline) {
              reject(new Error('Timed out waiting for ' + label));
              return;
            }
            requestAnimationFrame(tick);
          };
          tick();
        });
      }
    })()
  `, { awaitPromise: true, returnByValue: true });
  const expectedNodes = (authoritativeSession?.nodes ?? [])
    .map((node) => ({ id: node.id, status: node.status }))
    .sort(compareById);
  const expectedEdges = (authoritativeSession?.edges ?? []).map((edge) => edge.id).sort();
  const actualNodes = (dom?.nodes ?? []).sort(compareById);
  const actualEdges = (dom?.edges ?? []).sort();
  const ok = stableJson(actualNodes) === stableJson(expectedNodes) && stableJson(actualEdges) === stableJson(expectedEdges);
  return {
    ok,
    diagnostic: ok ? null : "renderer-projection-does-not-match-authoritative-canvas",
    nodes: actualNodes,
    edges: actualEdges,
  };
}

export function plannerTurnReplayVerification({ first, second, reopened }) {
  const firstSession = first?.canvasSession;
  const secondSession = second?.canvasSession;
  const reopenedSession = reopened?.canvasSession;
  const plannerNodeId = secondSession?.plannerNodeId ?? null;
  const plannerSessionId = secondSession?.hermesPlannerSessionId ?? null;
  const firstPlannerTurns = plannerTurnRecords(first);
  const plannerTurns = plannerTurnRecords(second);
  const plannerRunIds = plannerTurns
    .map((turn) => turn.runId)
    .filter((runId) => typeof runId === "string");
  const inputReplay = [plannerInputBrief(firstSession), plannerInputBrief(secondSession)]
    .filter((input) => typeof input === "string");
  const identityStable = !!plannerNodeId && !!plannerSessionId &&
    firstSession?.plannerNodeId === plannerNodeId &&
    reopenedSession?.plannerNodeId === plannerNodeId &&
    firstSession?.hermesPlannerSessionId === plannerSessionId &&
    reopenedSession?.hermesPlannerSessionId === plannerSessionId;
  const onePlannerRoot = [firstSession, secondSession, reopenedSession].every((session) =>
    session?.nodes?.filter((node) => node.id === plannerNodeId).length === 1 &&
    session.nodes.find((node) => node.id === plannerNodeId)?.context?.dependencies?.length === 0 &&
    !session.edges?.some((edge) => edge.target === plannerNodeId)
  );
  const distinctTerminalRuns = firstPlannerTurns.length === 1 && plannerRunIds.length === 2 &&
    new Set(plannerRunIds).size === 2 &&
    stableJson(firstPlannerTurns[0]) === stableJson(plannerTurns[0]) &&
    firstPlannerTurns.every(hasSuccessfulPlannerEvidence) &&
    plannerTurns.every(hasSuccessfulPlannerEvidence);
  const turnSemantics = distinctTerminalRuns
    ? plannerTurnSemanticVerification({ first, second, reopened, plannerTurns })
    : emptyPlannerTurnSemanticVerification();
  const reopenedProjectionMatches = stableJson(reopened) === stableJson(second);
  const inputsReplayed = inputReplay.length === 2 && plannerInputBrief(reopenedSession) === inputReplay[1];
  const ok = identityStable && onePlannerRoot && distinctTerminalRuns && turnSemantics.ok &&
    reopenedProjectionMatches && inputsReplayed;
  return {
    ok,
    diagnostic: ok ? null : [
      identityStable ? null : "planner-identity-changed",
      onePlannerRoot ? null : "planner-root-invalid",
      distinctTerminalRuns ? null : "planner-run-evidence-invalid",
      distinctTerminalRuns && !turnSemantics.firstTurnOperationSummaryValid
        ? "first-turn-operation-summary-invalid"
        : null,
      distinctTerminalRuns && !turnSemantics.secondTurnOperationSummaryValid
        ? "second-turn-operation-summary-invalid"
        : null,
      distinctTerminalRuns && !turnSemantics.intentsAccepted ? "planner-intent-not-accepted" : null,
      distinctTerminalRuns && turnSemantics.intentsAccepted && !turnSemantics.secondTurnLaneSetValid
        ? "second-turn-lane-set-invalid"
        : null,
      distinctTerminalRuns && turnSemantics.intentsAccepted && !turnSemantics.secondTurnOperationDeclared
        ? "second-turn-operation-not-declared"
        : null,
      distinctTerminalRuns && turnSemantics.secondTurnOperationDeclared && !turnSemantics.secondTurnOperationProjected
        ? "second-turn-operation-projection-mismatch"
        : null,
      distinctTerminalRuns && turnSemantics.secondTurnOperationProjected && !turnSemantics.secondTurnOperationCompleted
        ? "second-turn-operation-not-completed"
        : null,
      reopenedProjectionMatches ? null : "sqlite-reopen-projection-mismatch",
      inputsReplayed ? null : "workflow-input-replay-invalid",
    ].filter(Boolean).join(", "),
    plannerSessionId,
    plannerNodeId,
    plannerRunIds,
    inputReplay,
    reopenedProjectionMatches,
    plannerOperationSummaries: turnSemantics.operationSummaries,
    secondTurnLaneIds: turnSemantics.secondTurnLaneIds,
  };
}

function plannerTurnSemanticVerification({ first, second, reopened, plannerTurns }) {
  const firstPlannerTurns = plannerTurnRecords(first);
  const firstTurnWindow = plannerTurnWindow(first, firstPlannerTurns[0], null);
  const secondFirstTurnWindow = plannerTurnWindow(second, plannerTurns[0], null);
  const secondTurnWindow = plannerTurnWindow(second, plannerTurns[1], plannerTurns[0]);
  const firstTurnOperationSummaryValid = firstPlannerTurns.length === 1 &&
    exactPlannerOperationSummary(firstPlannerTurns[0]?.operationSummary, expectedFirstPlannerOperationSummary) &&
    exactPlannerOperationSummary(plannerTurns[0]?.operationSummary, expectedFirstPlannerOperationSummary);
  const secondTurnOperationSummaryValid = exactPlannerOperationSummary(
    plannerTurns[1]?.operationSummary,
    expectedSecondPlannerOperationSummary,
  );
  const intentsAccepted = firstTurnWindow.intentAccepted &&
    secondFirstTurnWindow.intentAccepted && secondTurnWindow.intentAccepted;
  const secondTurnLaneIds = secondTurnWindow.declaredLaneIds.filter((laneId) =>
    projectedLaneCount(first, laneId) === 0 && canvasLaneCount(first, laneId) === 0
  );
  const secondTurnLaneSetValid = secondTurnLaneIds.length === 1 &&
    new Set(secondTurnLaneIds).size === secondTurnLaneIds.length;
  const secondTurnOperationDeclared = secondTurnLaneIds.length > 0;
  const secondTurnOperationProjected = secondTurnLaneSetValid && secondTurnLaneIds.every((laneId) =>
    projectedLaneCount(second, laneId) === 1 &&
    projectedLaneCount(reopened, laneId) === 1 &&
    canvasLaneCount(second, laneId) === 1 &&
    canvasLaneCount(reopened, laneId) === 1
  );
  const secondTurnOperationCompleted = secondTurnOperationProjected && secondTurnLaneIds.every((laneId) =>
    successfulProjectedLane(reopened, laneId) &&
    reopened.canvasSession.nodes.find((node) => node?.id === laneId)?.status === "completed"
  );
  return {
    ok: firstTurnOperationSummaryValid && secondTurnOperationSummaryValid &&
      intentsAccepted && secondTurnLaneSetValid && secondTurnOperationDeclared &&
      secondTurnOperationProjected && secondTurnOperationCompleted,
    firstTurnOperationSummaryValid,
    secondTurnOperationSummaryValid,
    intentsAccepted,
    secondTurnLaneSetValid,
    secondTurnOperationDeclared,
    secondTurnOperationProjected,
    secondTurnOperationCompleted,
    operationSummaries: plannerTurns.map((turn) => turn.operationSummary),
    secondTurnLaneIds,
  };
}

function emptyPlannerTurnSemanticVerification() {
  return {
    ok: false,
    firstTurnOperationSummaryValid: false,
    secondTurnOperationSummaryValid: false,
    intentsAccepted: false,
    secondTurnLaneSetValid: false,
    secondTurnOperationDeclared: false,
    secondTurnOperationProjected: false,
    secondTurnOperationCompleted: false,
    operationSummaries: [],
    secondTurnLaneIds: [],
  };
}

function plannerTurnWindow(state, reconciliation, previousReconciliation) {
  if (!reconciliation) return { intentAccepted: false, declaredLaneIds: [] };
  const lowerBound = previousReconciliation?.seq ?? Number.NEGATIVE_INFINITY;
  const input = safeWorkflowMarkerEvents(state, "workflow.user_input")
    .filter((event) => event.seq > lowerBound && event.seq < reconciliation.seq)
    .at(-1);
  if (!input) return { intentAccepted: false, declaredLaneIds: [] };
  const inTurnWindow = (event) => event.seq > input.seq && event.seq < reconciliation.seq;
  const causedByPlannerTurn = (event) => event.causationId === reconciliation.runId;
  const intentAccepted = safeWorkflowMarkerEvents(state, "workflow.intent.accepted")
    .some((event) => inTurnWindow(event) && causedByPlannerTurn(event));
  const declaredLaneIds = safeWorkflowMarkerEvents(state, "workflow.lane.declared")
    .filter((event) => inTurnWindow(event) && causedByPlannerTurn(event))
    .map((event) => event.laneId)
    .filter((laneId) => typeof laneId === "string" && laneId.length > 0)
    .sort();
  return { intentAccepted, declaredLaneIds };
}

function safeWorkflowMarkerEvents(state, kind) {
  return (state?.events ?? [])
    .filter((event) =>
      event?.kind === kind &&
      Number.isSafeInteger(event.seq) && event.seq >= 0 &&
      safeRedactedPayload(event.payload)
    )
    .sort((left, right) => left.seq - right.seq);
}

function safeRedactedPayload(payload) {
  return !!payload && typeof payload === "object" && !Array.isArray(payload) &&
    Object.keys(payload).sort().join(",") === "redacted,summary" &&
    payload.redacted === true && typeof payload.summary === "string";
}

function projectedLaneCount(state, laneId) {
  return state?.projection?.segments?.filter((segment) => segment?.laneId === laneId).length ?? 0;
}

function canvasLaneCount(state, laneId) {
  return state?.canvasSession?.nodes?.filter((node) => node?.id === laneId).length ?? 0;
}

function successfulProjectedLane(state, laneId) {
  const status = state?.projection?.segments?.find((segment) => segment?.laneId === laneId)?.status;
  return status === "succeeded" || status === "completed";
}

function plannerTurnRecords(state) {
  const plannerNodeId = state?.canvasSession?.plannerNodeId;
  if (typeof plannerNodeId !== "string") return [];
  return (state?.events ?? []).flatMap((event) => {
    const payload = event?.payload;
    const turn = payload?.plannerTurn;
    if (
      event?.kind !== "workflow.planner_intent.reconciled" ||
      event.laneId !== plannerNodeId ||
      !Number.isSafeInteger(event.seq) || event.seq < 0 ||
      typeof event.segmentId !== "string" ||
      !payload || typeof payload !== "object" || Array.isArray(payload) ||
      Object.keys(payload).sort().join(",") !== "plannerTurn,redacted,summary" ||
      payload.redacted !== true || typeof payload.summary !== "string" ||
      !turn || typeof turn !== "object" || Array.isArray(turn) ||
      Object.keys(turn).sort().join(",") !== "exitCode,hermesCliExitPassed,intentDisposition,operationSummary,runId,segmentId,status" ||
      turn.segmentId !== event.segmentId ||
      typeof turn.runId !== "string" || !turn.runId ||
      !terminalSegmentStatus(turn.status) ||
      (turn.exitCode !== null && (typeof turn.exitCode !== "number" || !Number.isFinite(turn.exitCode))) ||
      typeof turn.hermesCliExitPassed !== "boolean" ||
      turn.intentDisposition !== "applied"
    ) return [];
    const operationSummary = safePlannerOperationSummary(turn.operationSummary);
    if (!operationSummary) return [];
    return [{ ...turn, operationSummary, seq: event.seq }];
  }).sort((left, right) => left.seq - right.seq);
}

function exactPlannerOperationSummary(actual, expected) {
  const normalized = safePlannerOperationSummary(actual);
  return normalized !== null && stableJson(normalized) === stableJson(expected);
}

function safePlannerOperationSummary(value) {
  if (!Array.isArray(value) || value.length > 64) return null;
  const operationTypes = new Set([
    "AnalyzeRequirement",
    "DiscoverProject",
    "ProposeLanes",
    "SplitLane",
    "JoinLanes",
    "StartImplementation",
    "RequestValidation",
    "RequestReview",
    "RequestUserDecision",
    "ReplanFromEvidence",
    "Commit",
    "DeclareEdge",
  ]);
  const summary = [];
  for (const entry of value) {
    if (
      !entry || typeof entry !== "object" || Array.isArray(entry) ||
      typeof entry.type !== "string" || !operationTypes.has(entry.type)
    ) return null;
    const keys = Object.keys(entry).sort().join(",");
    if (entry.type === "ProposeLanes") {
      if (
        keys !== "lanesMode,type" ||
        (entry.lanesMode !== "omitted" && entry.lanesMode !== "explicit")
      ) return null;
      summary.push({ type: "ProposeLanes", lanesMode: entry.lanesMode });
      continue;
    }
    if (keys !== "type") return null;
    summary.push({ type: entry.type });
  }
  return summary;
}

function hasSuccessfulPlannerEvidence(segment) {
  return segment?.status === "succeeded" &&
    segment.exitCode === 0 &&
    segment.hermesCliExitPassed === true;
}

function plannerInputBrief(session) {
  if (typeof session?.plannerNodeId !== "string") return null;
  const brief = session.nodes?.find((node) => node.id === session.plannerNodeId)?.context?.brief;
  return typeof brief === "string" ? brief : null;
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

export function authoritativeProjectionEvidenceState(projection) {
  const failures = [];
  const records = [];
  const seenByRunId = new Map();
  const passedByRunId = new Map();

  for (const projectedEvidence of Array.isArray(projection?.evidence) ? projection.evidence : []) {
    const runEvidence = projectedEvidence?.runEvidence;
    const runId = runEvidence?.runId;
    if (
      !runEvidence ||
      typeof runEvidence !== "object" ||
      Array.isArray(runEvidence) ||
      typeof runId !== "string" ||
      runId.length === 0
    ) continue;

    const record = {
      evidenceId: projectedEvidence?.id ?? null,
      laneId: projectedEvidence?.laneId ?? null,
      segmentId: projectedEvidence?.segmentId ?? null,
      status: projectedEvidence?.status ?? null,
      runEvidence,
    };
    const previous = seenByRunId.get(runId);
    if (previous) {
      const duplicate = stableJson({
        laneId: previous.laneId,
        segmentId: previous.segmentId,
        status: previous.status,
        runEvidence: previous.runEvidence,
      }) === stableJson({
        laneId: record.laneId,
        segmentId: record.segmentId,
        status: record.status,
        runEvidence: record.runEvidence,
      });
      failures.push(`projection-run-evidence-${duplicate ? "duplicate" : "conflict"}:${runId}`);
    } else {
      seenByRunId.set(runId, record);
    }
    records.push(record);
    if (!previous && projectedEvidence?.status === "passed") {
      passedByRunId.set(runId, runEvidence);
    }
  }

  return {
    ok: failures.length === 0,
    failures,
    runEvidence: Object.fromEntries(passedByRunId),
    records,
  };
}

async function waitForWorkflowCompletion({ cdp, baselineCommitSha, workspacePath, projectRoot, graphSummary, readiness }) {
  const deadline = Date.now() + waitTimeoutMs;
  let lastWorkspace = null;
  let lastAuthoritative = null;
  let sessionId = null;
  const submittedDangerAuthorizations = new Map();
  while (Date.now() < deadline) {
    const workspace = await readWorkspaceFile(workspacePath);
    lastWorkspace = workspace ?? lastWorkspace;
    sessionId ??= activeCanvasSession(workspace)?.id ?? null;
    const authoritative = sessionId
      ? await readAuthoritativePlannerState(cdp, projectRoot, sessionId)
      : null;
    lastAuthoritative = authoritative ?? lastAuthoritative;
    const session = authoritative?.canvasSession;
    if (session) {
      const dangerAuthorizationState = await reconcileDangerAuthorizationAcknowledgments(
        session,
        submittedDangerAuthorizations,
        {
          authorize: (pendingControl) => authorizePendingDangerRunThroughUi(cdp, pendingControl),
        },
      );
      if (dangerAuthorizationState.pending) {
        await delay(pollIntervalMs);
        continue;
      }
      const flowNodes = executableWorkflowNodes(session);
      const graph = graphSummary(executableWorkflowSession(session), session.plannerNodeId);
      const graphAcceptance = workflowGraphAcceptanceSummary(graph);
      const commitCount = await gitCommitCount(projectRoot).catch(() => 0);
      const terminalFailure = terminalWorkflowFailure(
        session,
        authoritative.projection,
        authoritative.authoritativeEvidence,
      );
      if (terminalFailure) {
        const headCommitSha = await gitHeadShaOrNull(projectRoot);
        throw new WorkflowTerminalFailureError(workflowTerminalFailureResult({
          authoritativeEvidence: authoritative.authoritativeEvidence,
          baselineCommitSha,
          headCommitSha,
          projection: authoritative.projection,
          projectRoot,
          readiness,
          session,
          terminalFailure,
          workspacePath,
        }));
      }
      const headCommitSha = await gitHeadShaOrNull(projectRoot);
      const commitAdvanced = isFullGitCommit(headCommitSha) && headCommitSha !== baselineCommitSha;
      const completedFlow = flowNodes.length > 0 && flowNodes.every((node) => node.status === "completed");
      const graphReady = graph.connected &&
        graph.codexLaneCount > 0 &&
        graph.rootDependencyIds.length === 0 &&
        graph.rootIncomingEdgeIds.length === 0 &&
        graphAcceptance.ok;
      if (
        completedFlow &&
        graphReady &&
        commitCount > 1 &&
        commitAdvanced &&
        authoritativePlannerTurnCount(authoritative) >= 1 &&
        authoritativeWorkflowSettled(authoritative)
      ) {
        return authoritative;
      }
    }
    await delay(pollIntervalMs);
  }
  throw new Error(
    `Timed out waiting for New Session workflow completion after ${waitTimeoutMs}ms. ` +
    `Last authoritative state: ${boundedDiagnosticText(JSON.stringify(lastAuthoritative), commandOutputLimitBytes)}. ` +
    `Last workspace: ${summarizeWorkspace(lastWorkspace)}`,
  );
}

export function requiredLaneEvidenceSummary(session, authoritativeEvidence, excludedNodeIds = []) {
  const nodes = Array.isArray(session?.nodes) ? session.nodes : [];
  const excludedNodeIdSet = excludedNodeIds instanceof Set
    ? excludedNodeIds
    : new Set(Array.isArray(excludedNodeIds) ? excludedNodeIds : []);
  const evidenceStateValid = authoritativeEvidence?.ok === true;
  const runEvidence = evidenceStateValid &&
    authoritativeEvidence.runEvidence &&
    typeof authoritativeEvidence.runEvidence === "object"
    ? authoritativeEvidence.runEvidence
    : {};
  const candidatesByKind = Object.fromEntries(requiredLaneKinds.map((kind) => {
    const candidates = nodes
      .filter((node) => !excludedNodeIdSet.has(node?.id))
      .filter((node) => projectedLaneKind(node) === kind)
      .map((node) => summarizeRequiredLaneCandidate(kind, node, runEvidence?.[node?.runId]));
    return [kind, candidates];
  }));
  const lanes = Object.fromEntries(requiredLaneKinds.map((kind) => {
    const candidates = candidatesByKind[kind];
    const summary = candidates[0] ?? missingLaneEvidence(kind);
    const failures = [...summary.failures];
    if (candidates.length > 1) failures.push("duplicate-lane-kind");
    return [kind, {
      ...summary,
      ok: failures.length === 0,
      candidateCount: candidates.length,
      failures,
    }];
  }));
  if (requiredLaneKinds.every((kind) => candidatesByKind[kind].length === 1)) {
    for (const [index, kind] of requiredLaneKinds.entries()) {
      const expectedDependencies = index === 0 ? [] : [lanes[requiredLaneKinds[index - 1]].nodeId];
      const lane = lanes[kind];
      if (!exactStringArray(lane.dependencies, expectedDependencies)) {
        lane.failures.push("dependency-mismatch");
        lane.ok = false;
      }
      lane.expectedDependencies = expectedDependencies;
      const expectedAgent = expectedAgentForLaneKind(kind);
      if (lane.agent !== expectedAgent) {
        lane.failures.push("agent-mismatch");
        lane.ok = false;
      }
      lane.expectedAgent = expectedAgent;
    }
  }
  return {
    ok: evidenceStateValid && requiredLaneKinds.every((kind) => lanes[kind].ok),
    failures: evidenceStateValid
      ? []
      : [...(authoritativeEvidence?.failures ?? ["authoritative-evidence-state-missing"])],
    lanes,
  };
}

function projectedLaneKind(node) {
  if (node?.laneKind === "implementation") return "implementation";
  if (node?.laneKind === "validation" && node.semanticSubtype === "browser_validation") {
    return "browser_validation";
  }
  if (node?.laneKind === "validation") return "validation";
  if (node?.laneKind === "review") return "review";
  if (node?.laneKind === "commit") return "commit";
  return null;
}

function expectedAgentForLaneKind(kind) {
  return kind === "review" ? "hermes" : "codex";
}

function summarizeRequiredLaneCandidate(kind, node, evidence) {
  const failures = [];
  if (node?.status !== "completed") failures.push("lane-not-completed");
  if (typeof node?.runId !== "string" || !node.runId) failures.push("missing-node-run-id");
  if (!evidence || typeof evidence !== "object") {
    failures.push("missing-run-evidence");
  } else {
    if (evidence.runId !== node.runId) {
      failures.push("run-id-mismatch");
    } else {
      if (evidence.status !== "succeeded") failures.push("terminal-status-not-succeeded");
      if (evidence.exitCode !== 0) failures.push("exit-code-not-zero");
      if (!hasSuccessfulCliExitEvidence(node, evidence)) failures.push("missing-passed-cli-exit-check");
    }
  }

  const requiredEvidence = Array.isArray(node?.requiredEvidence) ? [...node.requiredEvidence] : [];
  const artifacts = Array.isArray(evidence?.artifacts) ? [...evidence.artifacts] : [];
  return {
    ok: failures.length === 0,
    kind,
    nodeId: node?.id ?? null,
    agent: node?.agent ?? null,
    runId: node?.runId ?? null,
    evidenceRunId: evidence?.runId ?? null,
    laneStatus: node?.status ?? null,
    evidenceStatus: evidence?.status ?? null,
    exitCode: evidence?.exitCode ?? null,
    requiredEvidence,
    artifacts,
    dependencies: Array.isArray(node?.context?.dependencies) ? [...node.context.dependencies] : [],
    failures,
  };
}

function missingLaneEvidence(kind) {
  return {
    ok: false,
    kind,
    nodeId: null,
    agent: null,
    runId: null,
    evidenceRunId: null,
    laneStatus: null,
    evidenceStatus: null,
    exitCode: null,
    requiredEvidence: [],
    artifacts: [],
    dependencies: [],
    failures: ["missing-lane"],
  };
}

function exactStringArray(actual, expected) {
  return Array.isArray(actual) &&
    actual.length === expected.length &&
    actual.every((value, index) => value === expected[index]);
}

export function strictWorkflowAcceptanceSummary({
  authoritativeEvidence,
  baselineCommitSha,
  deliveryCommitCount,
  finalHeadCommitSha,
  session,
  projection,
  replay,
  secondTurnLaneIds = [],
}) {
  const nodes = Array.isArray(session?.nodes) ? session.nodes : [];
  const projectedEvidenceState = authoritativeProjectionEvidenceState(projection);
  const authoritativeEvidenceMatchesProjection =
    authoritativeEvidence?.ok === true &&
    projectedEvidenceState.ok &&
    stableJson(authoritativeEvidence) === stableJson(projectedEvidenceState);
  const plannerNodeId = typeof session?.plannerNodeId === "string" ? session.plannerNodeId : null;
  const decisionsSettled = userDecisionsSettled(session);
  secondTurnLaneIds = Array.isArray(secondTurnLaneIds) ? secondTurnLaneIds : [];
  const secondTurnLaneSetValid = secondTurnLaneIds.length === 1 &&
    new Set(secondTurnLaneIds).size === secondTurnLaneIds.length &&
    replay?.ok === true &&
    exactStringArray(replay?.secondTurnLaneIds, secondTurnLaneIds);
  const followUpId = secondTurnLaneSetValid ? secondTurnLaneIds[0] : null;
  const nonPlannerNodes = plannerNodeId === null ? [] : executableWorkflowNodes(session);
  const followUpNodes = followUpId === null ? [] : nonPlannerNodes.filter((node) => node?.id === followUpId);
  const initialNodes = followUpId === null ? nonPlannerNodes : nonPlannerNodes.filter((node) => node?.id !== followUpId);
  const initialLaneEvidence = requiredLaneEvidenceSummary(session, authoritativeEvidence, secondTurnLaneIds);
  const roleNodes = Object.fromEntries(requiredLaneKinds.map((kind) => [
    kind,
    initialNodes.filter((node) => projectedLaneKind(node) === kind),
  ]));
  const initialLaneSetValid = nonPlannerNodes.length === 5 && followUpNodes.length === 1 &&
    initialNodes.length === 4 &&
    requiredLaneKinds.every((kind) => roleNodes[kind].length === 1) &&
    initialNodes.every((node) => requiredLaneKinds.includes(projectedLaneKind(node)));
  const initialByRole = Object.fromEntries(requiredLaneKinds.map((kind) => [kind, roleNodes[kind][0] ?? null]));
  const expectedAgents = {
    implementation: "codex",
    validation: "codex",
    review: "hermes",
    commit: "codex",
  };
  const agentMappingValid = initialLaneSetValid && requiredLaneKinds.every((kind) =>
    initialByRole[kind]?.agent === expectedAgents[kind]
  );
  const expectedDependencies = initialLaneSetValid ? {
    implementation: [],
    validation: [initialByRole.implementation.id],
    review: [initialByRole.validation.id],
    commit: [initialByRole.review.id],
  } : null;
  const dependencyChainValid = expectedDependencies !== null && requiredLaneKinds.every((kind) =>
    exactStringArray(initialByRole[kind]?.context?.dependencies, expectedDependencies[kind])
  );
  const followUp = followUpNodes[0] ?? null;
  const followUpStructureValid = initialLaneSetValid && projectedLaneKind(followUp) === "browser_validation" &&
    followUp.agent === "codex" && followUp.status === "completed" &&
    followUp.runtimePolicy?.sandbox === "workspace-write" &&
    exactStringArray(followUp?.context?.dependencies, [initialByRole.commit.id]);
  const expectedEdgePairs = followUpStructureValid && dependencyChainValid
    ? [
        [initialByRole.implementation.id, initialByRole.validation.id],
        [initialByRole.validation.id, initialByRole.review.id],
        [initialByRole.review.id, initialByRole.commit.id],
        [initialByRole.commit.id, followUp.id],
      ]
    : [];
  const executableSession = executableWorkflowSession(session);
  const actualEdgePairs = Array.isArray(executableSession?.edges)
    ? executableSession.edges.map((edge) => [edge?.source, edge?.target])
    : [];
  const encodedExpectedEdgePairs = expectedEdgePairs.map(encodeEdgePair).sort();
  const encodedActualEdgePairs = actualEdgePairs.map(encodeEdgePair).sort();
  const edgeSetValid = expectedEdgePairs.length === 4 && actualEdgePairs.length === 4 &&
    new Set(encodedActualEdgePairs).size === 4 &&
    stableJson(encodedActualEdgePairs) === stableJson(encodedExpectedEdgePairs);
  const matchingSegments = followUpId === null
    ? []
    : (projection?.segments ?? []).filter((segment) => segment?.laneId === followUpId);
  const segment = matchingSegments[0] ?? null;
  const matchingEvidence = !segment
    ? []
    : (projection?.evidence ?? []).filter((evidence) =>
        evidence?.laneId === followUpId && evidence?.segmentId === segment.id
      );
  const projectedRunEvidence = matchingEvidence[0]?.runEvidence ?? null;
  const authoritativeRunEvidence = typeof followUp?.runId === "string"
    ? authoritativeEvidence?.runEvidence?.[followUp.runId]
    : null;
  const projectedBrowserEvidenceFailures = browserLaneEvidenceFailures(followUp, projectedRunEvidence);
  const authoritativeBrowserEvidenceFailures = browserLaneEvidenceFailures(followUp, authoritativeRunEvidence);
  const followUpEvidenceValid = followUpStructureValid && matchingSegments.length === 1 &&
    matchingEvidence.length === 1 && matchingEvidence[0]?.status === "passed" &&
    typeof followUp.runId === "string" && followUp.runId.length > 0 &&
    segment?.runId === followUp.runId && segment.status === "succeeded" &&
    successfulCodexEvidence(projectedRunEvidence, followUp.runId) &&
    successfulCodexEvidence(authoritativeRunEvidence, followUp.runId) &&
    projectedBrowserEvidenceFailures.length === 0 &&
    authoritativeBrowserEvidenceFailures.length === 0 &&
    stableJson(projectedRunEvidence) === stableJson(authoritativeRunEvidence);
  const deliveryCheckpoints = deliveryCheckpointAcceptanceSummary({
    baselineCommitSha,
    deliveryCommitCount,
    finalHeadCommitSha,
    initialByRole,
    followUp,
    projection,
    sessionId: session?.id,
  });
  const failures = [
    authoritativeEvidenceMatchesProjection ? null : "authoritative-evidence-invalid",
    decisionsSettled ? null : "user-decisions-not-settled",
    secondTurnLaneSetValid ? null : "second-turn-lane-set-invalid",
    initialLaneSetValid ? null : "initial-lane-set-invalid",
    agentMappingValid ? null : "agent-mapping-invalid",
    dependencyChainValid ? null : "dependency-chain-invalid",
    edgeSetValid ? null : "edge-set-invalid",
    followUpStructureValid ? null : "follow-up-invalid",
    followUpEvidenceValid ? null : "follow-up-evidence-invalid",
    initialLaneEvidence.ok ? null : "initial-lane-evidence-invalid",
    deliveryCheckpoints.ok ? null : "delivery-checkpoints-invalid",
  ].filter(Boolean);
  return {
    ok: failures.length === 0,
    failures,
    nonPlannerNodeCount: nonPlannerNodes.length,
    initialNodeCount: initialNodes.length,
    secondTurnLaneIds: [...secondTurnLaneIds],
    initialLaneEvidence,
    deliveryCheckpoints,
    expectedEdgePairs,
    actualEdgePairs,
    followUp: {
      nodeId: followUp?.id ?? null,
      runId: followUp?.runId ?? null,
      requiredEvidence: Array.isArray(followUp?.requiredEvidence) ? [...followUp.requiredEvidence] : [],
      artifacts: Array.isArray(authoritativeRunEvidence?.artifacts) ? [...authoritativeRunEvidence.artifacts] : [],
      segmentCount: matchingSegments.length,
      evidenceCount: matchingEvidence.length,
      failures: [
        followUpStructureValid ? null : "follow-up-invalid",
        followUpEvidenceValid ? null : "follow-up-evidence-invalid",
        ...projectedBrowserEvidenceFailures.map((failure) => `projected:${failure}`),
        ...authoritativeBrowserEvidenceFailures.map((failure) => `authoritative:${failure}`),
      ].filter(Boolean),
    },
  };
}

export function deliveryCheckpointAcceptanceSummary({
  baselineCommitSha,
  deliveryCommitCount,
  finalHeadCommitSha,
  initialByRole,
  followUp,
  projection,
  sessionId,
}) {
  const failures = [];
  if (deliveryCommitCount !== 1) failures.push(`delivery-commit-count:${String(deliveryCommitCount)}`);
  if (!isFullGitCommit(baselineCommitSha)) failures.push("baseline-head-invalid");
  if (!isFullGitCommit(finalHeadCommitSha)) failures.push("final-head-invalid");
  if (baselineCommitSha === finalHeadCommitSha) failures.push("delivery-head-not-advanced");

  const laneSpecs = [
    ["implementation", initialByRole?.implementation, baselineCommitSha, baselineCommitSha, false],
    ["validation", initialByRole?.validation, baselineCommitSha, baselineCommitSha, false],
    ["review", initialByRole?.review, baselineCommitSha, baselineCommitSha, false],
    ["commit", initialByRole?.commit, baselineCommitSha, finalHeadCommitSha, true],
    ["followUp", followUp, finalHeadCommitSha, finalHeadCommitSha, false],
  ];
  const lanes = Object.fromEntries(laneSpecs.map(([kind, node, expectedBeforeHead, expectedAfterHead, mustMove]) => [
    kind,
    laneCheckpointAcceptanceSummary({
      expectedAfterHead,
      expectedBeforeHead,
      mustMove,
      node,
      projection,
      sessionId,
    }),
  ]));
  for (const [kind] of laneSpecs) {
    if (!lanes[kind].ok) failures.push(`lane-${kind}-invalid`);
  }

  return {
    ok: failures.length === 0,
    failures,
    baselineCommitSha,
    finalHeadCommitSha,
    deliveryCommitCount,
    lanes,
  };
}

function laneCheckpointAcceptanceSummary({
  expectedAfterHead,
  expectedBeforeHead,
  mustMove,
  node,
  projection,
  sessionId,
}) {
  const failures = [];
  if (!node || typeof node.id !== "string" || typeof node.runId !== "string") {
    return { ok: false, failures: ["missing-node"], beforeHead: null, afterHead: null };
  }

  const segments = (projection?.segments ?? []).filter((segment) => segment?.laneId === node.id);
  const segment = segments[0] ?? null;
  if (segments.length !== 1) failures.push(`segment-count:${segments.length}`);
  if (segment?.runId !== node.runId) failures.push("segment-run-id-mismatch");
  if (typeof segment?.id !== "string" || segment.id.length === 0) failures.push("segment-id-invalid");

  const checkpoints = (projection?.checkpoints ?? []).filter((checkpoint) =>
    checkpoint?.laneId === node.id || checkpoint?.nodeId === node.id
  );
  const before = checkpointForPhase(checkpoints, "before", failures);
  const after = checkpointForPhase(checkpoints, "after", failures);
  validateCheckpointIdentity(before, "before", { failures, node, segment, sessionId });
  validateCheckpointIdentity(after, "after", { failures, node, segment, sessionId });
  failures.push(
    ...checkpointReferenceFailures({
      checkpoint: before,
      laneId: node.id,
      phase: "before",
      projection,
      runId: node.runId,
      segmentId: segment?.id,
    }),
    ...checkpointReferenceFailures({
      checkpoint: after,
      laneId: node.id,
      phase: "after",
      projection,
      runId: node.runId,
      segmentId: segment?.id,
    }),
  );

  const beforeHead = before?.headCommit ?? null;
  const afterHead = after?.headCommit ?? null;
  if (before && !isFullGitCommit(beforeHead)) failures.push("before-head-invalid");
  if (after && !isFullGitCommit(afterHead)) failures.push("after-head-invalid");
  if (before && beforeHead !== expectedBeforeHead) failures.push("before-head-mismatch");
  if (after && afterHead !== expectedAfterHead) failures.push("after-head-mismatch");
  if (before && after && mustMove && beforeHead === afterHead) failures.push("head-not-moved");
  if (before && after && !mustMove && beforeHead !== afterHead) failures.push("head-moved");

  return {
    ok: failures.length === 0,
    failures,
    nodeId: node.id,
    runId: node.runId,
    segmentId: segment?.id ?? null,
    beforeHead,
    afterHead,
  };
}

function checkpointForPhase(checkpoints, phase, failures) {
  const matches = checkpoints.filter((checkpoint) => checkpoint?.phase === phase);
  if (matches.length !== 1) failures.push(`${phase}-checkpoint-count:${matches.length}`);
  return matches[0] ?? null;
}

function validateCheckpointIdentity(checkpoint, phase, { failures, node, segment, sessionId }) {
  if (!checkpoint) return;
  if (checkpoint.sessionId !== sessionId) failures.push(`${phase}-session-id-mismatch`);
  if (checkpoint.nodeId !== node.id) failures.push(`${phase}-node-id-mismatch`);
  if (checkpoint.laneId !== node.id) failures.push(`${phase}-lane-id-mismatch`);
  if (checkpoint.runId !== node.runId) failures.push(`${phase}-run-id-mismatch`);
  if (checkpoint.segmentId !== segment?.id) failures.push(`${phase}-segment-id-mismatch`);
  if (checkpoint.executionTarget !== "current_branch") failures.push(`${phase}-target-mismatch`);
}

function checkpointReferenceFailures({
  checkpoint,
  laneId,
  phase,
  projection,
  runId,
  segmentId,
}) {
  if (!checkpoint) return [];
  const failures = [];
  const references = Array.isArray(checkpoint.evidenceRefs) ? checkpoint.evidenceRefs : [];
  requireCheckpointReference(references, "run", runId, phase, failures);
  requireCheckpointReference(references, "segment", segmentId, phase, failures);

  const changesetEvidenceId = `changeset-evidence:${runId}:${phase}`;
  requireCheckpointReference(references, "changeset", changesetEvidenceId, phase, failures);
  const matchingChangesetEvidence = (projection?.changesetEvidence ?? []).filter((record) =>
    record?.evidenceId === changesetEvidenceId
  );
  if (matchingChangesetEvidence.length !== 1) {
    failures.push(`${phase}-changeset-evidence-count:${matchingChangesetEvidence.length}`);
  } else if (!validCheckpointChangesetEvidence(matchingChangesetEvidence[0], changesetEvidenceId)) {
    failures.push(`${phase}-changeset-evidence-invalid`);
  }

  const evidenceReferences = references.filter((reference) => reference?.kind === "evidence");
  if (phase === "before") {
    if (evidenceReferences.length !== 0) {
      failures.push(`before-evidence-ref-count:${evidenceReferences.length}`);
    }
    return failures;
  }

  const authoritativeEvidence = (projection?.evidence ?? []).filter((record) =>
    record?.laneId === laneId &&
    record?.segmentId === segmentId &&
    record?.status === "passed" &&
    record?.runEvidence?.runId === runId
  );
  if (authoritativeEvidence.length !== 1) {
    failures.push(`after-authoritative-evidence-count:${authoritativeEvidence.length}`);
  }
  const evidenceId = authoritativeEvidence[0]?.id;
  if (authoritativeEvidence.length === 1 && (typeof evidenceId !== "string" || evidenceId.length === 0)) {
    failures.push("after-authoritative-evidence-id-invalid");
  }
  requireCheckpointReference(references, "evidence", evidenceId, phase, failures);
  return failures;
}

function requireCheckpointReference(references, kind, expectedId, phase, failures) {
  const matches = references.filter((reference) => reference?.kind === kind);
  if (matches.length !== 1) {
    failures.push(`${phase}-${kind}-ref-count:${matches.length}`);
    return;
  }
  if (matches[0]?.id !== expectedId) failures.push(`${phase}-${kind}-ref-id-mismatch`);
}

function validCheckpointChangesetEvidence(record, evidenceId) {
  const diffStat = record?.diffStat;
  return !!record &&
    typeof record === "object" &&
    !Array.isArray(record) &&
    record.evidenceId === evidenceId &&
    typeof record.changesetId === "string" &&
    record.changesetId.length > 0 &&
    record.source === "git" &&
    (record.status === "available" || record.status === "empty") &&
    Array.isArray(record.files) &&
    record.files.every((path) => typeof path === "string") &&
    !!diffStat &&
    typeof diffStat === "object" &&
    ["added", "changed", "deleted"].every((key) =>
      Number.isInteger(diffStat[key]) && diffStat[key] >= 0
    ) &&
    typeof record.patchPreviewTruncated === "boolean";
}

function isFullGitCommit(value) {
  return typeof value === "string" && /^[0-9a-f]{40}$/i.test(value);
}

function encodeEdgePair([source, target]) {
  return JSON.stringify([source, target]);
}

function successfulCodexEvidence(evidence, runId) {
  return !!evidence && typeof evidence === "object" &&
    evidence.runId === runId && evidence.status === "succeeded" && evidence.exitCode === 0 &&
    (evidence.checks ?? []).some((check) =>
      check?.kind === "run-exit" && check.name === "Codex CLI exit" && check.status === "passed"
    );
}

function browserLaneEvidenceFailures(node, evidence) {
  const failures = [];
  const requiredEvidence = Array.isArray(node?.requiredEvidence) ? node.requiredEvidence : [];
  for (const required of ["browser", "screenshot"]) {
    if (!requiredEvidence.includes(required)) failures.push(`missing-required-evidence:${required}`);
  }
  if (!(evidence?.checks ?? []).some((check) => check?.kind === "artifact" && check.status === "passed")) {
    failures.push("missing-passed-artifact-check");
  }
  if (!(evidence?.artifacts ?? []).includes(browserScreenshotArtifact)) {
    failures.push("missing-screenshot-artifact");
  }
  return failures;
}

export function workflowGraphAcceptanceSummary(graph) {
  const disconnectedCardIds = Array.isArray(graph?.disconnectedCardIds) ? graph.disconnectedCardIds : [];
  const dependencyMismatchIds = Array.isArray(graph?.dependencyMismatchIds) ? graph.dependencyMismatchIds : [];
  const duplicateSemanticKeys = Array.isArray(graph?.duplicateSemanticKeys) ? graph.duplicateSemanticKeys : [];
  const failures = [];
  if (disconnectedCardIds.length > 0) failures.push(`graph-disconnected:${disconnectedCardIds.join("|")}`);
  if (dependencyMismatchIds.length > 0) failures.push(`graph-dependency-mismatch:${dependencyMismatchIds.join("|")}`);
  if (duplicateSemanticKeys.length > 0) failures.push(`duplicate-semantic-keys:${duplicateSemanticKeys.join("|")}`);
  return { ok: failures.length === 0, failures };
}

export async function collectFailureAcceptanceResult({
  baselineCommitSha,
  demo,
  expectedCaptureScriptHash,
  expectedVerifyScriptHash,
  precloseSnapshot,
  projectRoot,
  readiness,
  userData,
  readSqliteState = readSqliteWorkflowStateAfterClose,
  collectPrivateFacts = collectPrivateRunFactsAfterClose,
  collectProjectFacts = collectProjectFailureFacts,
}) {
  const collectionErrors = [];
  const workspace = precloseSnapshot?.workspace ?? null;
  const workspaceSession = activeCanvasSession(workspace);
  let sqliteState = null;
  if (workspaceSession?.id) {
    try {
      sqliteState = await readSqliteState(projectRoot, workspaceSession.id);
    } catch (error) {
      collectionErrors.push(`sqlite-projection:${errorText(error)}`);
    }
  }

  const session = sqliteState?.canvasSession ?? null;
  const projection = sqliteState?.projection ?? null;
  const authoritativeEvidence = authoritativeProjectionEvidenceState(projection);
  const runIds = uniqueSortedStrings([
    ...(Array.isArray(projection?.segments)
      ? projection.segments.map((segment) => segment?.runId)
      : []),
    ...authoritativeEvidence.records
      .filter((record) => isTerminalCollectedRunStatus(record.runEvidence.status))
      .map((record) => record.runEvidence.runId),
  ]);
  let privateRunFacts = {
    activeRuns: [],
    evidence: {},
    diagnostic: "not-collected-without-authoritative-run-ids",
  };
  if (runIds.length > 0) {
    try {
      privateRunFacts = await collectPrivateFacts({ projectRoot, runIds, userData });
    } catch (error) {
      privateRunFacts = { activeRuns: [], evidence: {}, diagnostic: errorText(error) };
      collectionErrors.push(`private-run-facts:${errorText(error)}`);
    }
  }

  assertNoNonterminalFailureFacts(sqliteState, privateRunFacts);

  let projectFacts = emptyCollectedProjectFacts(projectRoot, baselineCommitSha);
  try {
    projectFacts = await collectProjectFacts({
      baselineCommitSha,
      demo,
      expectedCaptureScriptHash,
      expectedVerifyScriptHash,
      projectRoot,
    });
  } catch (error) {
    collectionErrors.push(`project-facts:${errorText(error)}`);
  }

  const laneKindEvidence = requiredLaneEvidenceSummary(session, authoritativeEvidence);
  return {
    ...projectFacts,
    mockFallback: mockFallbackForReadiness(readiness),
    readiness,
    sessionId: session?.id ?? null,
    sessionTarget: session?.target ?? null,
    laneStatuses: laneStatuses(session),
    laneKindEvidence,
    runEvidence: runEvidenceSummary(authoritativeEvidence),
    agentRunEvidence: agentRunEvidenceSummary(session, authoritativeEvidence),
    failureCollection: {
      sourceAvailability: {
        sqliteProjection: sqliteState !== null,
        workspace: workspace !== null,
        project: projectFacts.projectInspected === true,
        privateRunFacts: privateRunFacts.diagnostic === null,
      },
      errors: collectionErrors,
      preclose: {
        workspace: workspaceProgressSummary(workspace),
        ui: precloseSnapshot?.ui ?? null,
        diagnostic: precloseSnapshot?.diagnostic ?? null,
      },
      sqlite: sqliteProgressSummary(sqliteState),
      privateRuns: privateRunFacts,
    },
  };
}

export async function readSqliteWorkflowStateAfterClose(projectRoot, sessionId) {
  const electronBinary = require("electron");
  const script = `
    (async () => {
      const { createWorkflowStore } = await import("@skyturn/persistence/workflow-store");
      const store = createWorkflowStore({ projectRoot: ${JSON.stringify(projectRoot)} });
      try {
        process.stdout.write(JSON.stringify({
          canvasSession: store.materializeCanvasSession(${JSON.stringify(sessionId)}),
          projection: store.materializeFlowProjection(${JSON.stringify(sessionId)}),
          events: store.listEvents(${JSON.stringify(sessionId)}),
        }));
      } finally {
        store.close();
      }
    })().catch((error) => {
      process.stderr.write(error instanceof Error ? error.stack ?? error.message : String(error));
      process.exitCode = 1;
    });
  `;
  const result = await runCapturedProcess(electronBinary, ["-e", script], {
    cwd: desktopRoot,
    env: { ...process.env, ELECTRON_RUN_AS_NODE: "1" },
    timeoutMs: controlPlaneCdpRequestTimeoutMs,
  });
  return JSON.parse(result.stdout);
}

export async function collectPrivateRunFactsAfterClose({ projectRoot, runIds, userData }) {
  const bridgeModule = await import("@skyturn/agent-bridge");
  const durableRunClaimStore = bridgeModule.createDurableRunClaimStore({ root: join(userData, "run-claims") });
  const privateRunEventStore = bridgeModule.createPrivateRunEventStore({ durableRunClaimStore });
  const bridge = new bridgeModule.AgentBridge({
    adapters: [],
    durableRunClaimStore,
    privateRunEventStore,
  });
  const entries = await Promise.all(runIds.map(async (runId) => {
    try {
      return [runId, await bridge.getEvidence(projectRoot, runId)];
    } catch (error) {
      return [runId, { collectionError: errorText(error) }];
    }
  }));
  const evidence = Object.fromEntries(entries);
  const activeRuns = entries.flatMap(([runId, value]) => (
    value && typeof value === "object" && !isTerminalCollectedRunStatus(value.status)
      ? [{ runId, agent: value.agentKind ?? null, status: value.status ?? null }]
      : []
  ));
  return { activeRuns, evidence, diagnostic: null };
}

export function assertNoNonterminalFailureFacts(sqliteState, privateRunFacts) {
  const projection = sqliteState?.projection;
  const nonterminalSegments = (projection?.segments ?? []).filter((segment) =>
    !new Set(["succeeded", "failed", "cancelled", "timed-out"]).has(segment?.status)
  );
  const nonterminalLanes = (projection?.lanes ?? []).filter((lane) =>
    !new Set(["pending", "ready", "waiting_input", "completed", "failed", "blocked"]).has(lane?.status)
  );
  const nonterminalRuns = Array.isArray(privateRunFacts?.activeRuns) ? privateRunFacts.activeRuns : [];
  if (nonterminalSegments.length > 0 || nonterminalLanes.length > 0 || nonterminalRuns.length > 0) {
    throw new Error(`after-close-nonterminal-facts:${JSON.stringify({
      lanes: nonterminalLanes.map((lane) => ({ id: lane?.id ?? null, status: lane?.status ?? null })),
      runs: nonterminalRuns.map((run) => ({ runId: run?.runId ?? null, status: run?.status ?? null })),
      segments: nonterminalSegments.map((segment) => ({
        segmentId: segment?.id ?? null,
        runId: segment?.runId ?? null,
        status: segment?.status ?? null,
      })),
    })}`);
  }
}

function isTerminalCollectedRunStatus(status) {
  return new Set(["succeeded", "failed", "cancelled", "timed-out"]).has(status);
}

export async function collectProjectFailureFacts({
  baselineCommitSha,
  demo,
  expectedCaptureScriptHash,
  expectedVerifyScriptHash,
  projectRoot,
}) {
  const verifyScriptPath = join(projectRoot, "scripts", "verify.mjs");
  const captureScriptPath = join(projectRoot, "scripts", "capture-screenshot.mjs");
  const actualVerifyScriptHash = await fileSha256OrNull(verifyScriptPath);
  const actualCaptureScriptHash = await fileSha256OrNull(captureScriptPath);
  const verifyScriptUnchanged = actualVerifyScriptHash === expectedVerifyScriptHash;
  const captureScriptUnchanged = actualCaptureScriptHash === expectedCaptureScriptHash;
  const skippedVerify = skippedCommandResult(
    "failure collector reads existing facts only; fixed verification is skipped",
  );
  const skippedCapture = skippedCommandResult(
    "failure collector reads existing facts only; screenshot capture is skipped",
  );
  const screenshotPath = join(projectRoot, browserScreenshotArtifact);
  const screenshotBytes = await fileSizeOrZero(screenshotPath);
  const commitCount = await gitCommitCount(projectRoot).catch(() => 0);
  const headCommitSha = await gitHeadShaOrNull(projectRoot);
  const deliveryFiles = isFullGitCommit(baselineCommitSha) && isFullGitCommit(headCommitSha)
    ? await collectDeliveryFileRange({ baselineCommitSha, demo, projectRoot })
    : {
        deliveryCommitCount: 0,
        changedFiles: [],
        unexpectedChangedFiles: [],
        missingChangedFiles: expectedChangedFiles,
      };
  const gitStatusValue = (await demo.runCapture("git", ["status", "--short"], projectRoot, { allowFailure: true })).stdout.trim();
  return {
    projectInspected: true,
    verificationCommand: {
      verify: {
        command: `${process.execPath} scripts/verify.mjs`,
        ...boundedCommandOutput(skippedVerify, commandOutputLimitBytes),
      },
      captureScreenshot: {
        command: `${process.execPath} scripts/capture-screenshot.mjs ${screenshotPath}`,
        ...boundedCommandOutput(skippedCapture, commandOutputLimitBytes),
      },
    },
    verificationScript: {
      path: verifyScriptPath,
      unchanged: verifyScriptUnchanged,
      expectedSha256: expectedVerifyScriptHash,
      actualSha256: actualVerifyScriptHash,
    },
    captureScript: {
      path: captureScriptPath,
      unchanged: captureScriptUnchanged,
      expectedSha256: expectedCaptureScriptHash,
      actualSha256: actualCaptureScriptHash,
    },
    verificationScriptHashUnchanged: verifyScriptUnchanged,
    captureScriptHashUnchanged: captureScriptUnchanged,
    screenshot: { path: screenshotPath, bytes: screenshotBytes },
    commitCount,
    deliveryCommitCount: deliveryFiles.deliveryCommitCount,
    commitSha: headCommitSha,
    baselineCommitSha,
    headCommitSha,
    changedFiles: deliveryFiles.changedFiles,
    allChangedFilesSinceBaseline: deliveryFiles.changedFiles,
    expectedChangedFiles,
    unexpectedChangedFiles: deliveryFiles.unexpectedChangedFiles,
    missingChangedFiles: deliveryFiles.missingChangedFiles,
    gitStatus: { clean: gitStatusValue === "", value: gitStatusValue },
  };
}

function emptyCollectedProjectFacts(projectRoot, baselineCommitSha) {
  return {
    ...emptyAcceptanceResult(projectRoot, null),
    projectInspected: false,
    baselineCommitSha,
  };
}

function workspaceProgressSummary(workspace) {
  const session = activeCanvasSession(workspace);
  return {
    activeProjectId: workspace?.activeProjectId ?? null,
    activeSessionId: workspace?.activeSessionId ?? null,
    sessionId: session?.id ?? null,
    lanes: laneStatuses(session),
  };
}

function sqliteProgressSummary(state) {
  const projection = state?.projection;
  return {
    sessionId: state?.canvasSession?.id ?? null,
    segments: Array.isArray(projection?.segments)
      ? projection.segments.map((segment) => ({
          segmentId: segment?.id ?? null,
          laneId: segment?.laneId ?? null,
          runId: segment?.runId ?? null,
          status: segment?.status ?? null,
        }))
      : [],
    evidence: authoritativeProjectionEvidenceState(projection).records.map((record) => ({
      evidenceId: record.evidenceId,
      laneId: record.laneId,
      segmentId: record.segmentId,
      runId: record.runEvidence.runId,
      status: record.runEvidence.status,
      exitCode: record.runEvidence.exitCode,
    })),
    eventKinds: uniqueSortedStrings((state?.events ?? []).map((event) => event?.kind)),
  };
}

async function collectFinalVerification({
  authoritativeEvidence,
  baselineCommitSha,
  demo,
  expectedCaptureScriptHash,
  expectedVerifyScriptHash,
  projectRoot,
  projection,
  replay,
  secondTurnLaneIds = [],
  session,
}) {
  const verifyScriptPath = join(projectRoot, "scripts", "verify.mjs");
  const actualVerifyScriptHash = await fileSha256(verifyScriptPath);
  const verifyScriptUnchanged = actualVerifyScriptHash === expectedVerifyScriptHash;
  const verifyCommand = `${process.execPath} scripts/verify.mjs`;
  const testResult = verifyScriptUnchanged
    ? await demo.runCapture(process.execPath, ["scripts/verify.mjs"], projectRoot, { allowFailure: true })
    : skippedCommandResult("fixed verification script hash changed");
  const screenshotVerification = await verifyScreenshotCausalBinding({
    demo,
    expectedCaptureScriptHash,
    projectRoot,
  });
  const captureResult = screenshotVerification.captureResult;
  const captureScriptUnchanged = screenshotVerification.captureScript.unchanged;
  const screenshotPath = screenshotVerification.lane.path;
  const screenshotBytes = screenshotVerification.lane.bytes;
  const commitCount = await gitCommitCount(projectRoot);
  const deliveryFiles = await collectDeliveryFileRange({ baselineCommitSha, demo, projectRoot });
  const {
    changedFiles,
    deliveryCommitCount,
    headCommitSha,
    missingChangedFiles,
    unexpectedChangedFiles,
  } = deliveryFiles;
  const commitSha = headCommitSha;
  const gitStatusValue = (await demo.runCapture("git", ["status", "--short"], projectRoot)).stdout.trim();
  const gitStatus = { clean: gitStatusValue === "", value: gitStatusValue };
  const appSource = await readFile(join(projectRoot, "src", "App.jsx"), "utf8");
  const graph = session
    ? demo.flowKernelGraphSummary(executableWorkflowSession(session), session.plannerNodeId)
    : null;
  const graphAcceptance = workflowGraphAcceptanceSummary(graph);
  const flowNodes = executableWorkflowNodes(session);
  const sessionTarget = session?.target ?? null;
  const strictWorkflow = strictWorkflowAcceptanceSummary({
    authoritativeEvidence,
    baselineCommitSha,
    deliveryCommitCount,
    finalHeadCommitSha: headCommitSha,
    session,
    projection,
    replay,
    secondTurnLaneIds,
  });
  const laneKindEvidence = strictWorkflow.initialLaneEvidence;
  const ok =
    !!session &&
    sessionTarget?.executionTarget === "current_branch" &&
    flowNodes.length > 0 &&
    flowNodes.every((node) => node.status === "completed") &&
    graph.connected &&
    graph.codexLaneCount > 0 &&
    graph.rootDependencyIds.length === 0 &&
    graph.rootIncomingEdgeIds.length === 0 &&
    graph.disconnectedCardIds.length === 0 &&
    graph.dependencyMismatchIds.length === 0 &&
    graph.duplicateSemanticKeys.length === 0 &&
    graphAcceptance.ok &&
    testResult.code === 0 &&
    screenshotVerification.ok &&
    verifyScriptUnchanged &&
    captureScriptUnchanged &&
    commitCount > 1 &&
    deliveryCommitCount === 1 &&
    typeof baselineCommitSha === "string" &&
    baselineCommitSha.length === 40 &&
    typeof commitSha === "string" &&
    commitSha.length === 40 &&
    typeof headCommitSha === "string" &&
    headCommitSha.length === 40 &&
    unexpectedChangedFiles.length === 0 &&
    missingChangedFiles.length === 0 &&
    changedFiles.includes("src/App.jsx") &&
    gitStatus.clean &&
    appSource.includes("SkyTurn delivery complete") &&
    appSource.includes("Hermes -> Codex") &&
    appSource.includes("Ready for verification") &&
    strictWorkflow.ok;

  return {
    ok,
    diagnostic: ok
      ? null
      : acceptanceFailureDiagnostic({
          appSource,
          changedFiles,
          captureResult,
          captureScriptUnchanged,
          commitCount,
          commitSha,
          deliveryCommitCount,
          baselineCommitSha,
          headCommitSha,
          flowNodes,
          gitStatus,
          graph,
          laneKindEvidence,
          strictWorkflow,
          sessionTarget,
          screenshotVerification,
          screenshotBytes,
          testResult,
          verifyScriptUnchanged,
          unexpectedChangedFiles,
          missingChangedFiles,
        }),
    verificationScript: {
      path: verifyScriptPath,
      unchanged: verifyScriptUnchanged,
      expectedSha256: expectedVerifyScriptHash,
      actualSha256: actualVerifyScriptHash,
    },
    captureScript: screenshotVerification.captureScript,
    verificationCommand: {
      verify: {
        command: verifyCommand,
        ...boundedCommandOutput(testResult, commandOutputLimitBytes),
      },
      captureScreenshot: {
        command: screenshotVerification.command,
        ...boundedCommandOutput(captureResult, commandOutputLimitBytes),
      },
    },
    sessionTarget,
    screenshotPath,
    screenshotBytes,
    screenshotVerification,
    commitCount,
    deliveryCommitCount,
    commitSha,
    baselineCommitSha,
    headCommitSha,
    changedFiles,
    allChangedFilesSinceBaseline: changedFiles,
    unexpectedChangedFiles,
    missingChangedFiles,
    gitStatus,
    graph,
    laneKindEvidence,
    strictWorkflow,
  };
}

function acceptanceFailureDiagnostic(input) {
  const failures = [];
  if (input.sessionTarget?.executionTarget !== "current_branch") failures.push("not-current-branch-target");
  if (input.flowNodes.length === 0) failures.push("no-flow-kernel-lanes");
  if (input.flowNodes.some((node) => node.status !== "completed")) failures.push("flow-not-completed");
  if (!input.graph?.connected) failures.push("graph-disconnected");
  failures.push(...workflowGraphAcceptanceSummary(input.graph).failures);
  if ((input.graph?.codexLaneCount ?? 0) <= 0) failures.push("no-codex-lane");
  if ((input.graph?.rootDependencyIds ?? []).length > 0) failures.push("planner-root-has-dependencies");
  if ((input.graph?.rootIncomingEdgeIds ?? []).length > 0) failures.push("planner-root-has-incoming-edges");
  if (input.testResult.code !== 0) failures.push(`verify-exit-${input.testResult.code}`);
  if (input.captureResult.code !== 0) failures.push(`capture-exit-${input.captureResult.code}`);
  if (!input.verifyScriptUnchanged) failures.push("verification-script-changed");
  if (!input.captureScriptUnchanged) failures.push("capture-script-changed");
  if ((input.unexpectedChangedFiles ?? []).length > 0) failures.push(`unexpected-delivery-files:${input.unexpectedChangedFiles.join("|")}`);
  if ((input.missingChangedFiles ?? []).length > 0) failures.push(`missing-delivery-files:${input.missingChangedFiles.join("|")}`);
  if (input.screenshotBytes <= 1_000) failures.push("screenshot-too-small");
  for (const failure of input.screenshotVerification?.failures ?? ["screenshot-verification-missing"]) {
    failures.push(`screenshot:${failure}`);
  }
  if (input.commitCount <= 1) failures.push("no-delivery-commit");
  if (input.deliveryCommitCount !== 1) failures.push(`delivery-commit-count:${input.deliveryCommitCount}`);
  if (typeof input.baselineCommitSha !== "string" || input.baselineCommitSha.length !== 40) failures.push("missing-baseline-sha");
  if (typeof input.commitSha !== "string" || input.commitSha.length !== 40) failures.push("missing-commit-sha");
  if (typeof input.headCommitSha !== "string" || input.headCommitSha.length !== 40) failures.push("missing-head-sha");
  if (!input.changedFiles.includes("src/App.jsx")) failures.push("app-file-not-changed");
  if (!input.gitStatus.clean) failures.push("git-status-not-clean");
  if (!input.appSource.includes("SkyTurn delivery complete")) failures.push("missing-delivery-text");
  if (!input.appSource.includes("Hermes -> Codex")) failures.push("missing-agent-chain-text");
  if (!input.appSource.includes("Ready for verification")) failures.push("missing-verification-text");
  for (const kind of requiredLaneKinds) {
    for (const failure of input.laneKindEvidence?.lanes?.[kind]?.failures ?? ["missing-lane-summary"]) {
      failures.push(`lane-${kind}:${failure}`);
    }
  }
  for (const failure of input.strictWorkflow?.failures ?? ["strict-workflow-summary-missing"]) {
    failures.push(`strict-workflow:${failure}`);
  }
  return failures.length > 0 ? failures.join(", ") : "unknown";
}

async function collectDeliveryFileRange({ baselineCommitSha, demo, projectRoot }) {
  const headCommitSha = await gitHeadSha(demo, projectRoot);
  const deliveryCommitCount = Number((await demo.runCapture(
    "git",
    ["rev-list", "--count", `${baselineCommitSha}..HEAD`],
    projectRoot,
  )).stdout.trim());
  const changedFilesSinceBaseline = deliveryCommitCount > 0
    ? (await demo.runCapture(
        "git",
        ["log", "--name-only", "--format=", `${baselineCommitSha}..HEAD`],
        projectRoot,
      )).stdout.split("\n").filter(Boolean)
    : [];

  return {
    deliveryCommitCount,
    ...deliveryFileRangeVerification({
      baselineCommitSha,
      headCommitSha,
      changedFilesSinceBaseline,
      expectedChangedFiles,
    }),
  };
}

export function deliveryFileRangeVerification({
  baselineCommitSha,
  headCommitSha,
  changedFilesSinceBaseline,
  expectedChangedFiles: expectedFiles,
}) {
  const changedFiles = uniqueSortedStrings(changedFilesSinceBaseline);
  const expected = uniqueSortedStrings(expectedFiles);
  const unexpectedChangedFiles = changedFiles.filter((file) => !expected.includes(file));
  const missingChangedFiles = expected.filter((file) => !changedFiles.includes(file));

  return {
    ok: unexpectedChangedFiles.length === 0 && missingChangedFiles.length === 0,
    baselineCommitSha,
    headCommitSha,
    changedFiles,
    expectedChangedFiles: expected,
    allChangedFilesSinceBaseline: changedFiles,
    unexpectedChangedFiles,
    missingChangedFiles,
  };
}

function activeCanvasSession(workspace) {
  if (!workspace || !Array.isArray(workspace.sessions)) return null;
  const active = workspace.sessions.find((session) => session.id === workspace.activeSessionId);
  if (active?.kind === "canvas") return active;
  return workspace.sessions.find((session) => session.kind === "canvas") ?? null;
}

function laneStatuses(session) {
  if (!session) return [];
  const executableNodeIds = new Set(executableWorkflowNodes(session).map((node) => node.id));
  return session.nodes
    .filter((node) => node.id === session.plannerNodeId || executableNodeIds.has(node.id))
    .map((node) => ({
      id: node.id,
      runId: node.runId,
      agent: node.agent,
      title: node.title,
      status: node.status,
      meta: node.display?.meta ?? [],
    }));
}

function runEvidenceSummary(authoritativeEvidence) {
  return Object.fromEntries(
    (authoritativeEvidence?.records ?? []).map((record) => [
      record.runEvidence.runId,
      {
        projectionEvidenceId: record.evidenceId,
        projectionLaneId: record.laneId,
        projectionSegmentId: record.segmentId,
        projectionStatus: record.status,
        runId: record.runEvidence.runId,
        status: record.runEvidence.status,
        exitCode: record.runEvidence.exitCode,
        checks: record.runEvidence.checks,
        artifacts: record.runEvidence.artifacts,
        errorReason: record.runEvidence.errorReason,
        cancelReason: record.runEvidence.cancelReason,
        completedAt: record.runEvidence.completedAt,
      },
    ]),
  );
}

function agentRunEvidenceSummary(session, authoritativeEvidence) {
  const result = { hermes: [], codex: [] };
  for (const node of laneStatuses(session)) {
    if (node.agent !== "hermes" && node.agent !== "codex") continue;
    const record = authoritativeEvidenceRecord(authoritativeEvidence, node.runId);
    const evidence = record?.runEvidence ?? null;
    result[node.agent].push({
      nodeId: node.id,
      runId: node.runId,
      projectionEvidenceId: record?.evidenceId ?? null,
      projectionStatus: record?.status ?? null,
      evidenceRunId: evidence?.runId ?? null,
      laneStatus: node.status,
      evidenceStatus: evidence?.status ?? null,
      exitCode: evidence?.exitCode ?? null,
      passedChecks: evidence?.checks?.filter((check) => check.status === "passed").map((check) => ({
        kind: check.kind,
        name: check.name,
      })) ?? [],
      hasExpectedCliExit: hasSuccessfulCliExitEvidence(node, evidence),
    });
  }
  return result;
}

export function hasSuccessfulRunEvidenceForAgent(session, authoritativeEvidence, agent) {
  return authoritativeEvidence?.ok === true && laneStatuses(session).some((node) =>
    node.agent === agent &&
    hasSuccessfulCliExitEvidence(node, authoritativeEvidence?.runEvidence?.[node.runId] ?? null),
  );
}

function authoritativeEvidenceRecord(authoritativeEvidence, runId) {
  if (typeof runId !== "string") return null;
  return (authoritativeEvidence?.records ?? []).find((record) =>
    record?.runEvidence?.runId === runId
  ) ?? null;
}

function hasSuccessfulCliExitEvidence(node, evidence) {
  if (!evidence || evidence.runId !== node.runId) return false;
  if (evidence.status !== "succeeded" || evidence.exitCode !== 0) return false;
  const expectedName = node.agent === "hermes"
    ? "Hermes CLI exit"
    : node.agent === "codex"
      ? "Codex CLI exit"
      : null;
  if (!expectedName) return false;
  return (evidence.checks ?? []).some((check) =>
    check?.kind === "run-exit" &&
    check.status === "passed" &&
    typeof check.name === "string" &&
    check.name.includes(expectedName),
  );
}

function emptyAcceptanceResult(projectRoot, readiness) {
  return {
    ok: false,
    mockFallback: mockFallbackForReadiness(readiness),
    readiness,
    projectRoot,
    sessionId: null,
    sessionTarget: null,
    laneStatuses: [],
    laneKindEvidence: requiredLaneEvidenceSummary(null, authoritativeProjectionEvidenceState(null)),
    runEvidence: {},
    agentRunEvidence: { hermes: [], codex: [] },
    screenshot: { path: null, bytes: 0 },
    screenshotVerification: null,
    verificationCommand: {
      verify: {
        command: `${process.execPath} scripts/verify.mjs`,
        ...boundedCommandOutput(skippedCommandResult("not run"), commandOutputLimitBytes),
      },
      captureScreenshot: {
        command: `${process.execPath} scripts/capture-screenshot.mjs`,
        ...boundedCommandOutput(skippedCommandResult("not run"), commandOutputLimitBytes),
      },
    },
    verificationScript: null,
    captureScript: null,
    verificationScriptHashUnchanged: null,
    captureScriptHashUnchanged: null,
    commitCount: 0,
    deliveryCommitCount: 0,
    commitSha: null,
    baselineCommitSha: null,
    headCommitSha: null,
    changedFiles: [],
    allChangedFilesSinceBaseline: [],
    expectedChangedFiles,
    unexpectedChangedFiles: [],
    missingChangedFiles: expectedChangedFiles,
    gitStatus: { clean: null, value: null },
  };
}

export function workflowTerminalFailureResult({
  authoritativeEvidence,
  baselineCommitSha = null,
  headCommitSha = null,
  projection,
  projectRoot,
  readiness,
  session,
  terminalFailure = null,
  workspacePath,
}) {
  const sessionTarget = session?.target ?? null;
  return {
    ...emptyAcceptanceResult(projectRoot, readiness),
    failure: {
      code: "WORKFLOW_RUN_FAILED",
      message: "Workflow reached terminal agent failure evidence before completion.",
      diagnostic: terminalFailure?.diagnostic ??
        workflowFailureDiagnostic(session, projection, authoritativeEvidence),
    },
    workspacePath,
    sessionId: session?.id ?? null,
    sessionTarget,
    laneStatuses: laneStatuses(session),
    laneKindEvidence: requiredLaneEvidenceSummary(session, authoritativeEvidence),
    runEvidence: runEvidenceSummary(authoritativeEvidence),
    agentRunEvidence: agentRunEvidenceSummary(session, authoritativeEvidence),
    baselineCommitSha,
    headCommitSha,
    commitSha: headCommitSha,
  };
}

class WorkflowTerminalFailureError extends Error {
  constructor(result) {
    super(result.failure?.diagnostic ?? result.failure?.message ?? "Workflow terminal failure.");
    this.name = "WorkflowTerminalFailureError";
    this.result = result;
  }
}

function terminalWorkflowFailure(session, projection, authoritativeEvidence) {
  const lanes = laneStatuses(session);
  const failedNode = lanes.find((node) =>
    ["failed", "cancelled", "timed-out"].includes(node.status)
  );
  if (failedNode) {
    return {
      diagnostic: `node-failed:${failedNode.id}:${failedNode.runId}`,
      node: failedNode,
      evidence: authoritativeEvidenceRecord(authoritativeEvidence, failedNode.runId)?.runEvidence ?? null,
    };
  }

  for (const node of lanes) {
    const evidence = authoritativeEvidenceRecord(authoritativeEvidence, node.runId)?.runEvidence ?? null;
    if (isTerminalFailureEvidence(evidence)) {
      return {
        diagnostic: `run-evidence-${evidence.status}:${node.id}:${node.runId}`,
        node,
        evidence,
      };
    }
    const segment = (projection?.segments ?? []).find((candidate) =>
      candidate?.laneId === node.id &&
      candidate?.runId === node.runId &&
      ["failed", "cancelled", "timed-out"].includes(candidate?.status)
    );
    if (segment) {
      return {
        diagnostic: `segment-${segment.status}:${node.id}:${node.runId}`,
        node,
        evidence,
      };
    }
  }
  return null;
}

function workflowFailureDiagnostic(session, projection, authoritativeEvidence) {
  const terminalFailure = terminalWorkflowFailure(session, projection, authoritativeEvidence);
  return terminalFailure?.diagnostic ?? "workflow-terminal-failure";
}

function isTerminalFailureEvidence(evidence) {
  return !!evidence && ["failed", "cancelled", "timed-out"].includes(evidence.status);
}

function mockFallbackForReadiness(readiness) {
  const value = readiness?.checks?.mockFallback;
  return typeof value === "boolean" ? value : "unknown";
}

async function readWorkspaceFile(workspacePath) {
  try {
    return JSON.parse(await readFile(workspacePath, "utf8"));
  } catch {
    return null;
  }
}

async function gitCommitCount(projectRoot) {
  const demo = await loadDemoHelpers();
  return Number((await demo.runCapture("git", ["rev-list", "--count", "HEAD"], projectRoot)).stdout.trim());
}

async function gitHeadSha(demo, projectRoot) {
  return (await demo.runCapture("git", ["rev-parse", "HEAD"], projectRoot)).stdout.trim();
}

async function gitHeadShaOrNull(projectRoot) {
  try {
    const demo = await loadDemoHelpers();
    return await gitHeadSha(demo, projectRoot);
  } catch {
    return null;
  }
}

async function fileSizeOrZero(filePath) {
  try {
    return (await stat(filePath)).size;
  } catch {
    return 0;
  }
}

function skippedCommandResult(reason) {
  return {
    code: null,
    stdout: "",
    stderr: reason,
    skipped: true,
  };
}

export function boundedCommandOutput(result, limitBytes = commandOutputLimitBytes) {
  const stdout = boundedText(result.stdout ?? "", limitBytes);
  const stderr = boundedText(result.stderr ?? "", limitBytes);
  return {
    code: result.code ?? null,
    stdout: stdout.value,
    stderr: stderr.value,
    stdoutBytes: stdout.bytes,
    stderrBytes: stderr.bytes,
    stdoutTruncated: stdout.truncated,
    stderrTruncated: stderr.truncated,
    ...(result.skipped === true ? { skipped: true } : {}),
  };
}

function boundedText(value, limitBytes) {
  const text = String(value);
  const bytes = Buffer.byteLength(text);
  if (bytes <= limitBytes) {
    return { value: text, bytes, truncated: false };
  }
  return {
    value: Buffer.from(text).subarray(0, limitBytes).toString("utf8").replace(/\uFFFD$/, ""),
    bytes,
    truncated: true,
  };
}

function uniqueSortedStrings(values) {
  return [...new Set((values ?? []).filter((value) => typeof value === "string" && value.length > 0))]
    .sort((left, right) => left.localeCompare(right));
}

function summarizeWorkspace(workspace) {
  if (!workspace) return "none";
  const session = activeCanvasSession(workspace);
  return JSON.stringify({
    activeProjectId: workspace.activeProjectId,
    activeSessionId: workspace.activeSessionId,
    sessionId: session?.id ?? null,
    nodes: session?.nodes?.map((node) => ({ id: node.id, agent: node.agent, status: node.status, meta: node.display?.meta ?? [] })) ?? [],
  });
}

export function spawnManaged(command, args, {
  cwd,
  env,
  label,
  outputLimitBytes = managedStreamOutputLimitBytes,
  combinedOutputLimitBytes = managedCombinedOutputLimitBytes,
}) {
  const output = createBoundedProcessOutput({ outputLimitBytes, combinedOutputLimitBytes });
  const child = spawn(command, args, {
    cwd,
    env,
    detached: process.platform !== "win32",
    stdio: ["ignore", "pipe", "pipe"],
  });
  let closed = false;
  let closeResult = null;
  child.stdout.on("data", (chunk) => {
    output.append("stdout", chunk);
  });
  child.stderr.on("data", (chunk) => {
    output.append("stderr", chunk);
  });
  child.once("close", (code, signal) => {
    closed = true;
    closeResult = { code, signal };
  });

  return {
    child,
    label,
    output() {
      const state = output.state();
      return `${state.stderr}${state.stdout}`.trim();
    },
    outputState() {
      return output.state();
    },
    diagnosticOutput() {
      if (output.state().truncated) return MANAGED_OUTPUT_OVERFLOW_DIAGNOSTIC;
      return boundedText(`${label}:\n${this.output()}`.trim(), commandOutputLimitBytes).value;
    },
    assertOutputWithinLimit() {
      if (output.state().truncated) throw new Error(MANAGED_OUTPUT_OVERFLOW_DIAGNOSTIC);
    },
    assertAlive() {
      this.assertOutputWithinLimit();
      if (!closed) return;
      const reason = closeResult?.signal ? `signal ${closeResult.signal}` : `exit ${closeResult?.code}`;
      throw new Error(`${label} exited before readiness (${reason}): ${this.output()}`);
    },
    async close() {
      await terminateChild(child, () => closed);
      this.assertOutputWithinLimit();
    },
    async waitForClose(timeoutMs) {
      if (!closed && !await waitForChildClose(child, timeoutMs, () => closed)) return null;
      return closeResult;
    },
  };
}

function createBoundedProcessOutput({ outputLimitBytes, combinedOutputLimitBytes }) {
  assertPositiveOutputLimit(outputLimitBytes);
  assertPositiveOutputLimit(combinedOutputLimitBytes);
  const streams = {
    stdout: createOutputStreamState(outputLimitBytes),
    stderr: createOutputStreamState(outputLimitBytes),
  };
  let combinedBytes = 0;
  let combinedRetainedBytes = 0;
  let combinedTruncated = false;

  return {
    append(name, chunk) {
      const stream = streams[name];
      if (!stream) throw new Error("Unknown acceptance output stream.");
      const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      stream.bytes = saturatingByteCount(stream.bytes, bytes.byteLength);
      combinedBytes = saturatingByteCount(combinedBytes, bytes.byteLength);
      const retainedBytes = Math.min(
        bytes.byteLength,
        outputLimitBytes - stream.retainedBytes,
        combinedOutputLimitBytes - combinedRetainedBytes,
      );
      if (retainedBytes > 0) {
        bytes.copy(stream.buffer, stream.retainedBytes, 0, retainedBytes);
        stream.retainedBytes += retainedBytes;
        combinedRetainedBytes += retainedBytes;
      }
      if (stream.bytes > outputLimitBytes) stream.truncated = true;
      if (combinedBytes > combinedOutputLimitBytes) combinedTruncated = true;
    },
    state() {
      return {
        stdout: retainedOutputText(streams.stdout),
        stderr: retainedOutputText(streams.stderr),
        stdoutBytes: streams.stdout.bytes,
        stderrBytes: streams.stderr.bytes,
        combinedBytes,
        stdoutRetainedBytes: streams.stdout.retainedBytes,
        stderrRetainedBytes: streams.stderr.retainedBytes,
        combinedRetainedBytes,
        stdoutTruncated: streams.stdout.truncated,
        stderrTruncated: streams.stderr.truncated,
        combinedTruncated,
        truncated: streams.stdout.truncated || streams.stderr.truncated || combinedTruncated,
      };
    },
  };
}

function createOutputStreamState(limitBytes) {
  return {
    buffer: Buffer.allocUnsafe(limitBytes),
    bytes: 0,
    retainedBytes: 0,
    truncated: false,
  };
}

function retainedOutputText(stream) {
  return stream.buffer.subarray(0, stream.retainedBytes).toString("utf8").replace(/\uFFFD+$/, "");
}

function assertPositiveOutputLimit(value) {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new Error("Acceptance output limit must be a positive safe integer.");
  }
}

function saturatingByteCount(current, added) {
  return Math.min(Number.MAX_SAFE_INTEGER, current + added);
}

export async function terminateChild(child, closeObserved = () => false) {
  if (!child.pid || closeObserved()) return;
  const gracefulClose = waitForChildClose(child, 2_000, closeObserved);
  if (child.exitCode === null && child.signalCode === null) {
    if (process.platform === "win32") {
      child.kill();
    } else {
      try {
        process.kill(-child.pid, "SIGTERM");
      } catch {
        child.kill("SIGTERM");
      }
    }
  }
  if (await gracefulClose) return;
  const forcedClose = waitForChildClose(child, 5_000, closeObserved);
  try {
    process.kill(process.platform === "win32" ? child.pid : -child.pid, "SIGKILL");
  } catch {
    child.kill("SIGKILL");
  }
  if (!await forcedClose) throw new Error("Managed child did not emit close after forced termination.");
}

function waitForChildClose(child, timeoutMs, closeObserved = () => false) {
  if (closeObserved()) return Promise.resolve(true);
  return new Promise((resolve) => {
    const finish = (closed) => {
      clearTimeout(timer);
      child.off("close", onClose);
      resolve(closed);
    };
    const onClose = () => finish(true);
    const timer = setTimeout(() => finish(false), timeoutMs);
    child.once("close", onClose);
  });
}

export function runCapturedProcess(command, args, {
  cwd,
  env,
  timeoutMs,
  outputLimitBytes = capturedStreamOutputLimitBytes,
  combinedOutputLimitBytes = capturedCombinedOutputLimitBytes,
}) {
  return new Promise((resolve, reject) => {
    const output = createBoundedProcessOutput({ outputLimitBytes, combinedOutputLimitBytes });
    const child = spawn(command, args, {
      cwd,
      env,
      detached: process.platform !== "win32",
      stdio: ["ignore", "pipe", "pipe"],
    });
    let settled = false;
    let closed = false;
    let timer = null;
    let terminalError = null;
    let termination = null;
    const finish = (error, result) => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      if (error) reject(error);
      else resolve(result);
    };
    const terminateFor = (error) => {
      terminalError ??= error;
      if (!termination) {
        termination = terminateChild(child, () => closed).catch(() => {
          terminalError = new Error("Failure collector subprocess cleanup failed.");
          finish(terminalError);
        });
      }
    };
    child.stdout.on("data", (chunk) => {
      output.append("stdout", chunk);
      if (output.state().truncated) terminateFor(new Error(MANAGED_OUTPUT_OVERFLOW_DIAGNOSTIC));
    });
    child.stderr.on("data", (chunk) => {
      output.append("stderr", chunk);
      if (output.state().truncated) terminateFor(new Error(MANAGED_OUTPUT_OVERFLOW_DIAGNOSTIC));
    });
    child.once("error", (error) => {
      terminalError ??= error;
      if (!child.pid) finish(terminalError);
    });
    child.once("close", async (code, signal) => {
      closed = true;
      if (termination) await termination;
      const state = output.state();
      if (state.truncated) {
        finish(new Error(MANAGED_OUTPUT_OVERFLOW_DIAGNOSTIC));
        return;
      }
      if (terminalError) {
        finish(terminalError);
        return;
      }
      if (code === 0) {
        finish(null, { stdout: state.stdout, stderr: state.stderr, code, signal });
        return;
      }
      finish(new Error(
        `Failure collector subprocess exited with ${signal ?? code}: ${boundedText(state.stderr, commandOutputLimitBytes).value}`,
      ));
    });
    timer = setTimeout(() => {
      terminateFor(new Error(`Failure collector subprocess timed out after ${timeoutMs}ms.`));
    }, timeoutMs);
  });
}

async function waitForHttpOk(url, label, managedProcess = null) {
  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline) {
    managedProcess?.assertAlive();
    try {
      const response = await fetch(url);
      if (response.ok) return;
    } catch {}
    await delay(250);
  }
  managedProcess?.assertAlive();
  throw new Error(`Timed out waiting for ${label} at ${url}.`);
}

async function waitForCdp(port, electronProcess) {
  const deadline = Date.now() + 30_000;
  const url = `http://${RENDERER_HOST}:${port}/json/version`;
  while (Date.now() < deadline) {
    electronProcess.assertAlive();
    try {
      const response = await fetch(url);
      if (response.ok) return;
    } catch {}
    await delay(250);
  }
  electronProcess.assertAlive();
  throw new Error(`Timed out waiting for Electron CDP at ${url}.`);
}

async function waitForSkyTurnRendererTarget(port, devServerUrl) {
  const deadline = Date.now() + 30_000;
  const url = `http://${RENDERER_HOST}:${port}/json/list`;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(url);
      if (response.ok) {
        const targets = await response.json();
        const target = selectSkyTurnRendererTarget(targets, devServerUrl);
        if (target) return target;
      }
    } catch {}
    await delay(250);
  }
  throw new Error(`Timed out waiting for SkyTurn renderer CDP target at ${devServerUrl} via ${url}.`);
}

export class CdpClient {
  static async connect(webSocketUrl, requestTimeoutMs = defaultCdpRequestTimeoutMs) {
    const client = new CdpClient(webSocketUrl, requestTimeoutMs);
    try {
      await client.open();
      return client;
    } catch (error) {
      client.destroy();
      throw error;
    }
  }

  constructor(webSocketUrl, requestTimeoutMs = defaultCdpRequestTimeoutMs) {
    if (!Number.isFinite(requestTimeoutMs) || requestTimeoutMs <= 0) {
      throw new Error("CDP request timeout must be a positive finite number.");
    }
    this.url = new URL(webSocketUrl);
    this.requestTimeoutMs = requestTimeoutMs;
    this.socket = null;
    this.nextId = 1;
    this.pending = new Map();
    this.buffer = Buffer.alloc(0);
    this.events = [];
  }

  async open() {
    this.socket = await connectTcp(this.url.hostname, Number(this.url.port));
    const key = randomBytes(16).toString("base64");
    const path = `${this.url.pathname}${this.url.search}`;
    this.socket.write([
      `GET ${path} HTTP/1.1`,
      `Host: ${this.url.host}`,
      "Upgrade: websocket",
      "Connection: Upgrade",
      `Sec-WebSocket-Key: ${key}`,
      "Sec-WebSocket-Version: 13",
      "",
      "",
    ].join("\r\n"));
    await this.readHandshake(key);
    this.socket.on("data", (chunk) => this.readFrames(chunk));
    this.socket.on("error", (error) => this.rejectAll(error));
    this.socket.on("close", () => this.rejectAll(new Error("CDP socket closed.")));
  }

  readHandshake(key) {
    return new Promise((resolve, reject) => {
      const cleanup = () => {
        this.socket.off("data", onData);
        this.socket.off("error", onError);
        this.socket.off("close", onClose);
      };
      const fail = (error) => {
        cleanup();
        reject(error);
      };
      const onError = (error) => fail(error);
      const onClose = () => fail(new Error("CDP socket closed during WebSocket handshake."));
      const onData = (chunk) => {
        this.buffer = Buffer.concat([this.buffer, chunk]);
        const headerEnd = this.buffer.indexOf("\r\n\r\n");
        if (headerEnd === -1) return;
        cleanup();
        const header = this.buffer.subarray(0, headerEnd).toString("utf8");
        this.buffer = this.buffer.subarray(headerEnd + 4);
        if (!header.startsWith("HTTP/1.1 101")) {
          reject(new Error(`CDP WebSocket upgrade failed: ${header}`));
          return;
        }
        const expected = createHash("sha1")
          .update(`${key}258EAFA5-E914-47DA-95CA-C5AB0DC85B11`)
          .digest("base64");
        if (!header.toLowerCase().includes(`sec-websocket-accept: ${expected.toLowerCase()}`)) {
          reject(new Error("CDP WebSocket accept header mismatch."));
          return;
        }
        if (this.buffer.length > 0) this.readFrames(Buffer.alloc(0));
        resolve();
      };
      this.socket.on("data", onData);
      this.socket.once("error", onError);
      this.socket.once("close", onClose);
    });
  }

  call(method, params = {}, requestTimeoutMs = this.requestTimeoutMs) {
    if (!Number.isFinite(requestTimeoutMs) || requestTimeoutMs <= 0) {
      throw new Error("CDP request timeout must be a positive finite number.");
    }
    const id = this.nextId;
    this.nextId += 1;
    const payload = JSON.stringify({ id, method, params });
    return new Promise((resolve, reject) => {
      const entry = { resolve, reject, timer: null };
      entry.timer = setTimeout(() => {
        if (this.pending.get(id) !== entry) return;
        this.pending.delete(id);
        reject(new Error(`CDP request ${safeCdpMethodName(method)} timed out after ${requestTimeoutMs} ms.`));
      }, requestTimeoutMs);
      this.pending.set(id, entry);
      try {
        this.writeFrame(Buffer.from(payload));
      } catch (error) {
        if (this.pending.get(id) === entry) {
          this.pending.delete(id);
          clearTimeout(entry.timer);
        }
        reject(error);
      }
    });
  }

  async evaluate(expression, options = {}) {
    const response = await this.call("Runtime.evaluate", {
      expression,
      awaitPromise: options.awaitPromise === true,
      returnByValue: options.returnByValue !== false,
    }, options.requestTimeoutMs);
    if (response.result?.exceptionDetails) {
      throw new Error(response.result.exceptionDetails.text ?? "Runtime.evaluate failed.");
    }
    return response.result?.result?.value;
  }

  writeFrame(payload) {
    const length = payload.length;
    const header = length < 126
      ? Buffer.from([0x81, 0x80 | length])
      : length < 65536
        ? Buffer.from([0x81, 0x80 | 126, (length >> 8) & 0xff, length & 0xff])
        : longFrameHeader(length);
    const mask = randomBytes(4);
    const masked = Buffer.alloc(payload.length);
    for (let index = 0; index < payload.length; index += 1) {
      masked[index] = payload[index] ^ mask[index % 4];
    }
    this.socket.write(Buffer.concat([header, mask, masked]));
  }

  readFrames(chunk) {
    if (chunk.length > 0) this.buffer = Buffer.concat([this.buffer, chunk]);
    while (this.buffer.length >= 2) {
      const second = this.buffer[1];
      let length = second & 0x7f;
      let offset = 2;
      if (length === 126) {
        if (this.buffer.length < 4) return;
        length = this.buffer.readUInt16BE(2);
        offset = 4;
      } else if (length === 127) {
        if (this.buffer.length < 10) return;
        const high = this.buffer.readUInt32BE(2);
        const low = this.buffer.readUInt32BE(6);
        if (high !== 0) throw new Error("CDP frame too large.");
        length = low;
        offset = 10;
      }
      const masked = (second & 0x80) !== 0;
      const maskOffset = masked ? 4 : 0;
      if (this.buffer.length < offset + maskOffset + length) return;
      const opcode = this.buffer[0] & 0x0f;
      const mask = masked ? this.buffer.subarray(offset, offset + 4) : null;
      const payloadStart = offset + maskOffset;
      const payload = Buffer.from(this.buffer.subarray(payloadStart, payloadStart + length));
      this.buffer = this.buffer.subarray(payloadStart + length);
      if (mask) {
        for (let index = 0; index < payload.length; index += 1) payload[index] ^= mask[index % 4];
      }
      this.handleFrame(opcode, payload);
    }
  }

  handleFrame(opcode, payload) {
    if (opcode === 0x8) {
      this.close();
      return;
    }
    if (opcode !== 0x1) return;
    const message = JSON.parse(payload.toString("utf8"));
    if (!message.id) {
      this.recordDiagnosticEvent(message);
      return;
    }
    const pending = this.pending.get(message.id);
    if (!pending) return;
    this.pending.delete(message.id);
    clearTimeout(pending.timer);
    if (message.error) pending.reject(new Error(message.error.message));
    else pending.resolve(message);
  }

  recordDiagnosticEvent(message) {
    const event = cdpDiagnosticEvent(message);
    if (!event) return;
    this.events.push(event);
    if (this.events.length > 32) this.events.shift();
  }

  diagnosticEvents() {
    return [...this.events];
  }

  rejectAll(error) {
    const pending = [...this.pending.values()];
    this.pending.clear();
    for (const entry of pending) {
      clearTimeout(entry.timer);
      entry.reject(error);
    }
  }

  close() {
    this.rejectAll(new Error("CDP client closed."));
    if (!this.socket || this.socket.destroyed) return;
    this.socket.end();
  }

  destroy() {
    this.rejectAll(new Error("CDP client destroyed."));
    if (!this.socket || this.socket.destroyed) return;
    this.socket.destroy();
  }
}

function safeCdpMethodName(method) {
  return typeof method === "string" && /^[A-Za-z][A-Za-z0-9_.]{0,127}$/.test(method)
    ? method
    : "[invalid]";
}

function cdpDiagnosticEvent(message) {
  if (message.method === "Page.frameNavigated") {
    return {
      method: message.method,
      frameId: message.params?.frame?.id ?? null,
      url: sanitizeDiagnosticUrl(message.params?.frame?.url),
    };
  }
  if (message.method === "Page.loadEventFired") return { method: message.method };
  if (message.method === "Runtime.executionContextDestroyed") {
    return {
      method: message.method,
      executionContextId: message.params?.executionContextId ?? null,
    };
  }
  if (message.method === "Runtime.executionContextsCleared") return { method: message.method };
  return null;
}

function connectTcp(host, port) {
  return new Promise((resolve, reject) => {
    const socket = net.createConnection({ host, port });
    const cleanup = () => {
      socket.off("connect", onConnect);
      socket.off("error", onError);
      socket.off("close", onClose);
    };
    const fail = (error) => {
      cleanup();
      socket.destroy();
      reject(error);
    };
    const onConnect = () => {
      cleanup();
      resolve(socket);
    };
    const onError = (error) => fail(error);
    const onClose = () => fail(new Error("CDP socket closed before TCP connection completed."));
    socket.once("connect", onConnect);
    socket.once("error", onError);
    socket.once("close", onClose);
  });
}

function longFrameHeader(length) {
  const header = Buffer.alloc(10);
  header[0] = 0x81;
  header[1] = 0x80 | 127;
  header.writeUInt32BE(0, 2);
  header.writeUInt32BE(length, 6);
  return header;
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

if (process.argv[1] && process.argv[1] === fileURLToPath(import.meta.url)) {
  runNewSessionUiAcceptance().catch((error) => {
    console.error(error);
    process.exitCode = 1;
  });
}
