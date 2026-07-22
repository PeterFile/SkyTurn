import { spawn } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { createRequire } from "node:module";
import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import net from "node:net";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

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
const defaultCdpRequestTimeoutMs = 30_000;
const expectedChangedFiles = ["src/App.css", "src/App.jsx"];
const requiredLaneKinds = ["implementation", "validation", "browser_validation", "review", "commit"];
const browserScreenshotArtifact = ".devflow/acceptance/react-app.png";

const requirement = [
  "Turn this fresh blank React app into a visible SkyTurn delivery status screen.",
  "The page must show exactly: SkyTurn delivery complete, Hermes -> Codex, and Ready for verification.",
  "All three strings must render with exact case; CSS text-transform must not alter them.",
  "Keep the app in src/App.jsx and styling in src/App.css.",
  "Only src/App.jsx and src/App.css may be changed or committed.",
  "Do not modify scripts/verify.mjs or scripts/capture-screenshot.mjs; they are fixed validation contracts.",
  "Plan exactly this serial lane chain: implementation -> validation -> browser_validation -> review -> commit.",
  "The browser_validation lane must declare browser and screenshot evidence, run the fixed capture helper, and produce .devflow/acceptance/react-app.png.",
  "The commit lane must commit only src/App.jsx and src/App.css after review succeeds.",
].join("\n");

const followUpRequirement = [
  "Re-check the completed delivery against the existing verification evidence.",
  "Add exactly one validation lane using Codex, dependent only on the completed commit lane.",
  "Do not modify files, create commits, push, or open a pull request.",
  "Keep the planner root stable and add only the minimum verification work needed.",
].join("\n");

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
        const firstWorkspace = await waitForWorkflowCompletion({
          baselineCommitSha,
          workspacePath,
          projectRoot,
          graphSummary: demo.flowKernelGraphSummary,
          readiness: readinessPreflight.readiness,
        });
        const firstSession = activeCanvasSession(firstWorkspace);
        if (!firstSession) throw new Error("New Session did not create an authoritative CanvasSession.");
        const firstAuthoritative = await readAuthoritativePlannerState(liveCdp, projectRoot, firstSession.id);

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
        const workspace = await readWorkspaceFile(workspacePath);
        const session = reopenedAuthoritative.canvasSession;
        const verification = await collectFinalVerification({
          baselineCommitSha,
          demo,
          expectedCaptureScriptHash,
          expectedVerifyScriptHash,
          projectRoot,
          projection: reopenedAuthoritative.projection,
          replay,
          secondTurnLaneIds: replay.secondTurnLaneIds,
          session,
          workspace,
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
          runEvidence: runEvidenceSummary(workspace),
          agentRunEvidence: agentRunEvidenceSummary(session, workspace),
          screenshot: {
            path: verification.screenshotPath,
            bytes: verification.screenshotBytes,
          },
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
        const outcomeCleanup = await finalizeAcceptanceOutcome({ app, liveCdp, error });
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
          ...error.result,
          failure,
          userData,
          workspacePath,
        }, null, 2));
        process.exitCode = 1;
        return;
      }
      const headCommitSha = await gitHeadShaOrNull(projectRoot);
      console.log(JSON.stringify({
        ...emptyAcceptanceResult(projectRoot, readinessPreflight.readiness),
        baselineCommitSha,
        headCommitSha,
        commitSha: headCommitSha,
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

export async function finalizeAcceptanceOutcome({ app, liveCdp, ok, error = null }) {
  const shouldCancel = error !== null || ok === false;
  const diagnostics = [];
  let cancelledRunIds = [];
  let cleanupConfirmed = !shouldCancel;
  let cleanupError = null;

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

export async function fileSha256(filePath) {
  return createHash("sha256").update(await readFile(filePath)).digest("hex");
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
    await waitForHttpOk(devServerUrl, "renderer dev server");

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
    if (electron) await Promise.allSettled([electron.close(), vite.close()]);
    else await vite.close();
    throw error;
  }

  return {
    cdpPort,
    devServerUrl,
    diagnostics() {
      return [vite.diagnosticOutput(), electron.diagnosticOutput()].filter(Boolean).join("\n");
    },
    async close() {
      await Promise.allSettled([electron.close(), vite.close()]);
    },
  };
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
      const input = await waitFor(() => document.querySelector('input[aria-label="Insert requirement or node"]'), 'Canvas input');
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

export function authoritativeWorkflowSettled(state) {
  const nodes = state?.canvasSession?.nodes;
  if (!Array.isArray(nodes) || nodes.length === 0) return false;
  if (!nodes.every((node) => node?.status !== "running" && node?.status !== "retrying")) return false;
  const plannerNodeId = state?.canvasSession?.plannerNodeId;
  const executableNodes = nodes.filter((node) =>
    node?.id !== plannerNodeId && typeof node?.runId === "string" && node.runId.length > 0
  );
  return executableNodes.length > 0 && executableNodes.every((node) => {
    const segment = state?.projection?.segments?.find((candidate) =>
      candidate?.laneId === node.id && candidate?.runId === node.runId &&
      terminalSegmentStatus(candidate.status)
    );
    if (!segment || typeof segment.id !== "string") return false;
    const evidence = state?.projection?.evidence?.find((candidate) =>
      candidate?.laneId === node.id && candidate?.segmentId === segment.id &&
      candidate?.status === "passed" && candidate?.runEvidence?.runId === node.runId
    );
    if (!evidence || typeof evidence.id !== "string") return false;
    const afterCheckpoint = state?.projection?.checkpoints?.find((candidate) =>
      candidate?.laneId === node.id && candidate?.runId === node.runId &&
      candidate?.segmentId === segment.id && candidate?.phase === "after"
    );
    const evidenceRefKinds = new Set((afterCheckpoint?.evidenceRefs ?? []).map((reference) => reference?.kind));
    return evidenceRefKinds.has("run") && evidenceRefKinds.has("evidence") && evidenceRefKinds.has("changeset");
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
    secondTurnLaneIds: turnSemantics.secondTurnLaneIds,
  };
}

function plannerTurnSemanticVerification({ first, second, reopened, plannerTurns }) {
  const firstTurnWindow = plannerTurnWindow(first, plannerTurnRecords(first)[0], null);
  const secondFirstTurnWindow = plannerTurnWindow(second, plannerTurns[0], null);
  const secondTurnWindow = plannerTurnWindow(second, plannerTurns[1], plannerTurns[0]);
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
    ok: intentsAccepted && secondTurnLaneSetValid && secondTurnOperationDeclared &&
      secondTurnOperationProjected && secondTurnOperationCompleted,
    intentsAccepted,
    secondTurnLaneSetValid,
    secondTurnOperationDeclared,
    secondTurnOperationProjected,
    secondTurnOperationCompleted,
    secondTurnLaneIds,
  };
}

function emptyPlannerTurnSemanticVerification() {
  return {
    ok: false,
    intentsAccepted: false,
    secondTurnLaneSetValid: false,
    secondTurnOperationDeclared: false,
    secondTurnOperationProjected: false,
    secondTurnOperationCompleted: false,
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
    const turn = event?.payload?.plannerTurn;
    if (
      event?.kind !== "workflow.planner_intent.reconciled" ||
      event.laneId !== plannerNodeId ||
      !Number.isSafeInteger(event.seq) || event.seq < 0 ||
      typeof event.segmentId !== "string" ||
      !turn || typeof turn !== "object" || Array.isArray(turn) ||
      Object.keys(turn).sort().join(",") !== "exitCode,hermesCliExitPassed,intentDisposition,runId,segmentId,status" ||
      turn.segmentId !== event.segmentId ||
      typeof turn.runId !== "string" || !turn.runId ||
      !terminalSegmentStatus(turn.status) ||
      (turn.exitCode !== null && (typeof turn.exitCode !== "number" || !Number.isFinite(turn.exitCode))) ||
      typeof turn.hermesCliExitPassed !== "boolean" ||
      turn.intentDisposition !== "applied"
    ) return [];
    return [{ ...turn, seq: event.seq }];
  }).sort((left, right) => left.seq - right.seq);
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

async function waitForWorkflowCompletion({ baselineCommitSha, workspacePath, projectRoot, graphSummary, readiness }) {
  const deadline = Date.now() + waitTimeoutMs;
  let lastWorkspace = null;
  while (Date.now() < deadline) {
    const workspace = await readWorkspaceFile(workspacePath);
    lastWorkspace = workspace ?? lastWorkspace;
    const session = activeCanvasSession(workspace);
    if (session) {
      const flowNodes = session.nodes.filter((node) => node.display?.meta?.includes("flow-kernel"));
      const graph = graphSummary(session, session.plannerNodeId);
      const commitCount = await gitCommitCount(projectRoot).catch(() => 0);
      const terminalFailure = terminalWorkflowFailure(session, workspace);
      if (terminalFailure) {
        const headCommitSha = await gitHeadShaOrNull(projectRoot);
        throw new WorkflowTerminalFailureError(workflowTerminalFailureResult({
          baselineCommitSha,
          headCommitSha,
          projectRoot,
          readiness,
          terminalFailure,
          workspacePath,
          workspace,
        }));
      }
      const hasTerminalEvidence = Object.values(workspace.runEvidence ?? {}).some((evidence) =>
        evidence && typeof evidence === "object" &&
        ["succeeded", "failed", "cancelled", "timed-out"].includes(evidence.status),
      );
      const completedFlow = flowNodes.length > 0 && flowNodes.every((node) => node.status === "completed");
      if (completedFlow && graph.codexLaneCount > 0 && commitCount > 1 && hasTerminalEvidence) {
        return workspace;
      }
    }
    await delay(pollIntervalMs);
  }
  throw new Error(`Timed out waiting for New Session workflow completion after ${waitTimeoutMs}ms. Last workspace: ${summarizeWorkspace(lastWorkspace)}`);
}

export function requiredLaneEvidenceSummary(session, workspace, excludedNodeIds = []) {
  const nodes = Array.isArray(session?.nodes) ? session.nodes : [];
  const excludedNodeIdSet = excludedNodeIds instanceof Set
    ? excludedNodeIds
    : new Set(Array.isArray(excludedNodeIds) ? excludedNodeIds : []);
  const runEvidence = workspace?.runEvidence && typeof workspace.runEvidence === "object"
    ? workspace.runEvidence
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
    ok: requiredLaneKinds.every((kind) => lanes[kind].ok),
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
  if (kind === "browser_validation") {
    for (const required of ["browser", "screenshot"]) {
      if (!requiredEvidence.includes(required)) failures.push(`missing-required-evidence:${required}`);
    }
    if (!(evidence?.checks ?? []).some((check) => check?.kind === "artifact" && check.status === "passed")) {
      failures.push("missing-passed-artifact-check");
    }
    if (!artifacts.includes(browserScreenshotArtifact)) failures.push("missing-screenshot-artifact");
  }

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
  baselineCommitSha,
  deliveryCommitCount,
  finalHeadCommitSha,
  session,
  workspace,
  projection,
  replay,
  secondTurnLaneIds = [],
}) {
  const nodes = Array.isArray(session?.nodes) ? session.nodes : [];
  const plannerNodeId = typeof session?.plannerNodeId === "string" ? session.plannerNodeId : null;
  secondTurnLaneIds = Array.isArray(secondTurnLaneIds) ? secondTurnLaneIds : [];
  const secondTurnLaneSetValid = secondTurnLaneIds.length === 1 &&
    new Set(secondTurnLaneIds).size === secondTurnLaneIds.length &&
    replay?.ok === true &&
    exactStringArray(replay?.secondTurnLaneIds, secondTurnLaneIds);
  const followUpId = secondTurnLaneSetValid ? secondTurnLaneIds[0] : null;
  const nonPlannerNodes = plannerNodeId === null ? [] : nodes.filter((node) => node?.id !== plannerNodeId);
  const followUpNodes = followUpId === null ? [] : nonPlannerNodes.filter((node) => node?.id === followUpId);
  const initialNodes = followUpId === null ? nonPlannerNodes : nonPlannerNodes.filter((node) => node?.id !== followUpId);
  const initialLaneEvidence = requiredLaneEvidenceSummary(session, workspace, secondTurnLaneIds);
  const roleNodes = Object.fromEntries(requiredLaneKinds.map((kind) => [
    kind,
    initialNodes.filter((node) => projectedLaneKind(node) === kind),
  ]));
  const initialLaneSetValid = nonPlannerNodes.length === 6 && followUpNodes.length === 1 &&
    initialNodes.length === 5 &&
    requiredLaneKinds.every((kind) => roleNodes[kind].length === 1) &&
    initialNodes.every((node) => requiredLaneKinds.includes(projectedLaneKind(node)));
  const initialByRole = Object.fromEntries(requiredLaneKinds.map((kind) => [kind, roleNodes[kind][0] ?? null]));
  const expectedAgents = {
    implementation: "codex",
    validation: "codex",
    browser_validation: "codex",
    review: "hermes",
    commit: "codex",
  };
  const agentMappingValid = initialLaneSetValid && requiredLaneKinds.every((kind) =>
    initialByRole[kind]?.agent === expectedAgents[kind]
  );
  const expectedDependencies = initialLaneSetValid ? {
    implementation: [],
    validation: [initialByRole.implementation.id],
    browser_validation: [initialByRole.validation.id],
    review: [initialByRole.browser_validation.id],
    commit: [initialByRole.review.id],
  } : null;
  const dependencyChainValid = expectedDependencies !== null && requiredLaneKinds.every((kind) =>
    exactStringArray(initialByRole[kind]?.context?.dependencies, expectedDependencies[kind])
  );
  const followUp = followUpNodes[0] ?? null;
  const followUpStructureValid = initialLaneSetValid && followUp?.laneKind === "validation" &&
    followUp.agent === "codex" && followUp.status === "completed" &&
    exactStringArray(followUp?.context?.dependencies, [initialByRole.commit.id]);
  const expectedEdgePairs = followUpStructureValid && dependencyChainValid
    ? [
        [initialByRole.implementation.id, initialByRole.validation.id],
        [initialByRole.validation.id, initialByRole.browser_validation.id],
        [initialByRole.browser_validation.id, initialByRole.review.id],
        [initialByRole.review.id, initialByRole.commit.id],
        [initialByRole.commit.id, followUp.id],
      ]
    : [];
  const actualEdgePairs = Array.isArray(session?.edges)
    ? session.edges.map((edge) => [edge?.source, edge?.target])
    : [];
  const encodedExpectedEdgePairs = expectedEdgePairs.map(encodeEdgePair).sort();
  const encodedActualEdgePairs = actualEdgePairs.map(encodeEdgePair).sort();
  const edgeSetValid = expectedEdgePairs.length === 5 && actualEdgePairs.length === 5 &&
    new Set(encodedActualEdgePairs).size === 5 &&
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
  const workspaceEvidence = typeof followUp?.runId === "string"
    ? workspace?.runEvidence?.[followUp.runId]
    : null;
  const followUpEvidenceValid = followUpStructureValid && matchingSegments.length === 1 &&
    matchingEvidence.length === 1 && matchingEvidence[0]?.status === "passed" &&
    typeof followUp.runId === "string" && followUp.runId.length > 0 &&
    segment?.runId === followUp.runId && segment.status === "succeeded" &&
    successfulCodexEvidence(projectedRunEvidence, followUp.runId) &&
    successfulCodexEvidence(workspaceEvidence, followUp.runId) &&
    stableJson(projectedRunEvidence) === stableJson(workspaceEvidence);
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
      segmentCount: matchingSegments.length,
      evidenceCount: matchingEvidence.length,
      failures: [
        followUpStructureValid ? null : "follow-up-invalid",
        followUpEvidenceValid ? null : "follow-up-evidence-invalid",
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
    ["browser_validation", initialByRole?.browser_validation, baselineCommitSha, baselineCommitSha, false],
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

async function collectFinalVerification({
  baselineCommitSha,
  demo,
  expectedCaptureScriptHash,
  expectedVerifyScriptHash,
  projectRoot,
  projection,
  replay,
  secondTurnLaneIds = [],
  session,
  workspace,
}) {
  const verifyScriptPath = join(projectRoot, "scripts", "verify.mjs");
  const captureScriptPath = join(projectRoot, "scripts", "capture-screenshot.mjs");
  const actualVerifyScriptHash = await fileSha256(verifyScriptPath);
  const actualCaptureScriptHash = await fileSha256(captureScriptPath);
  const verifyScriptUnchanged = actualVerifyScriptHash === expectedVerifyScriptHash;
  const captureScriptUnchanged = actualCaptureScriptHash === expectedCaptureScriptHash;
  const verifyCommand = `${process.execPath} scripts/verify.mjs`;
  const screenshotPath = join(projectRoot, browserScreenshotArtifact);
  const captureCommand = `${process.execPath} scripts/capture-screenshot.mjs ${screenshotPath}`;
  const testResult = verifyScriptUnchanged
    ? await demo.runCapture(process.execPath, ["scripts/verify.mjs"], projectRoot, { allowFailure: true })
    : skippedCommandResult("fixed verification script hash changed");
  const captureResult = captureScriptUnchanged
    ? await demo.runCapture(process.execPath, ["scripts/capture-screenshot.mjs", screenshotPath], projectRoot, { allowFailure: true })
    : skippedCommandResult("fixed capture script hash changed");
  const screenshotBytes = captureResult.code === 0
    ? await fileSizeOrZero(screenshotPath)
    : 0;
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
  const graph = session ? demo.flowKernelGraphSummary(session, session.plannerNodeId) : null;
  const graphAcceptance = workflowGraphAcceptanceSummary(graph);
  const flowNodes = session?.nodes.filter((node) => node?.id !== session?.plannerNodeId) ?? [];
  const sessionTarget = session?.target ?? null;
  const strictWorkflow = strictWorkflowAcceptanceSummary({
    baselineCommitSha,
    deliveryCommitCount,
    finalHeadCommitSha: headCommitSha,
    session,
    workspace,
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
    captureResult.code === 0 &&
    screenshotBytes > 1_000 &&
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
    captureScript: {
      path: captureScriptPath,
      unchanged: captureScriptUnchanged,
      expectedSha256: expectedCaptureScriptHash,
      actualSha256: actualCaptureScriptHash,
    },
    verificationCommand: {
      verify: {
        command: verifyCommand,
        ...boundedCommandOutput(testResult, commandOutputLimitBytes),
      },
      captureScreenshot: {
        command: captureCommand,
        ...boundedCommandOutput(captureResult, commandOutputLimitBytes),
      },
    },
    sessionTarget,
    screenshotPath,
    screenshotBytes,
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
  return session.nodes
    .filter((node) => node.display?.meta?.includes("flow-kernel") || node.id === session.plannerNodeId)
    .map((node) => ({
      id: node.id,
      runId: node.runId,
      agent: node.agent,
      title: node.title,
      status: node.status,
      meta: node.display?.meta ?? [],
    }));
}

function runEvidenceSummary(workspace) {
  return Object.fromEntries(
    Object.entries(workspace?.runEvidence ?? {}).map(([runId, evidence]) => [
      runId,
      {
        runId: evidence.runId,
        status: evidence.status,
        exitCode: evidence.exitCode,
        checks: evidence.checks,
        artifacts: evidence.artifacts,
        errorReason: evidence.errorReason,
        cancelReason: evidence.cancelReason,
        completedAt: evidence.completedAt,
      },
    ]),
  );
}

function agentRunEvidenceSummary(session, workspace) {
  const result = { hermes: [], codex: [] };
  for (const node of laneStatuses(session)) {
    if (node.agent !== "hermes" && node.agent !== "codex") continue;
    const evidence = workspace?.runEvidence?.[node.runId] ?? null;
    result[node.agent].push({
      nodeId: node.id,
      runId: node.runId,
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

export function hasSuccessfulRunEvidenceForAgent(session, workspace, agent) {
  return laneStatuses(session).some((node) =>
    node.agent === agent &&
    hasSuccessfulCliExitEvidence(node, workspace?.runEvidence?.[node.runId] ?? null),
  );
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
    laneKindEvidence: requiredLaneEvidenceSummary(null, null),
    runEvidence: {},
    agentRunEvidence: { hermes: [], codex: [] },
    latestWorkspace: null,
    screenshot: { path: null, bytes: 0 },
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
  baselineCommitSha = null,
  headCommitSha = null,
  projectRoot,
  readiness,
  terminalFailure = null,
  workspacePath,
  workspace,
}) {
  const session = activeCanvasSession(workspace);
  const sessionTarget = session?.target ?? null;
  return {
    ...emptyAcceptanceResult(projectRoot, readiness),
    failure: {
      code: "WORKFLOW_RUN_FAILED",
      message: "Workflow reached terminal agent failure evidence before completion.",
      diagnostic: terminalFailure?.diagnostic ?? workflowFailureDiagnostic(session, workspace),
    },
    workspacePath,
    sessionId: session?.id ?? null,
    sessionTarget,
    laneStatuses: laneStatuses(session),
    laneKindEvidence: requiredLaneEvidenceSummary(session, workspace),
    runEvidence: runEvidenceSummary(workspace),
    agentRunEvidence: agentRunEvidenceSummary(session, workspace),
    latestWorkspace: workspace ?? null,
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

function terminalWorkflowFailure(session, workspace) {
  const lanes = laneStatuses(session);
  const failedNode = lanes.find((node) => node.status === "failed");
  if (failedNode) {
    return {
      diagnostic: `node-failed:${failedNode.id}:${failedNode.runId}`,
      node: failedNode,
      evidence: workspace?.runEvidence?.[failedNode.runId] ?? null,
    };
  }

  for (const node of lanes) {
    const evidence = workspace?.runEvidence?.[node.runId] ?? null;
    if (isTerminalFailureEvidence(evidence)) {
      return {
        diagnostic: `run-evidence-${evidence.status}:${node.id}:${node.runId}`,
        node,
        evidence,
      };
    }
  }
  return null;
}

function workflowFailureDiagnostic(session, workspace) {
  const terminalFailure = terminalWorkflowFailure(session, workspace);
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

function spawnManaged(command, args, { cwd, env, label }) {
  const child = spawn(command, args, {
    cwd,
    env,
    detached: process.platform !== "win32",
    stdio: ["ignore", "pipe", "pipe"],
  });
  let stdout = "";
  let stderr = "";
  let closed = false;
  let closeResult = null;
  child.stdout.on("data", (chunk) => {
    stdout += chunk.toString();
  });
  child.stderr.on("data", (chunk) => {
    stderr += chunk.toString();
  });
  child.once("close", (code, signal) => {
    closed = true;
    closeResult = { code, signal };
  });

  return {
    child,
    label,
    output() {
      return `${stderr}${stdout}`.trim();
    },
    diagnosticOutput() {
      return boundedText(`${label}:\n${stderr}${stdout}`.trim(), commandOutputLimitBytes).value;
    },
    assertAlive() {
      if (!closed) return;
      const reason = closeResult?.signal ? `signal ${closeResult.signal}` : `exit ${closeResult?.code}`;
      throw new Error(`${label} exited before readiness (${reason}): ${this.output()}`);
    },
    close() {
      return terminateChild(child);
    },
  };
}

async function terminateChild(child) {
  if (!child.pid || child.exitCode !== null || child.signalCode !== null) return;
  const gracefulClose = waitForChildClose(child, 2_000);
  if (process.platform === "win32") {
    child.kill();
  } else {
    try {
      process.kill(-child.pid, "SIGTERM");
    } catch {
      child.kill("SIGTERM");
    }
  }
  if (await gracefulClose) return;
  const forcedClose = waitForChildClose(child, 5_000);
  try {
    process.kill(process.platform === "win32" ? child.pid : -child.pid, "SIGKILL");
  } catch {
    child.kill("SIGKILL");
  }
  await forcedClose;
}

function waitForChildClose(child, timeoutMs) {
  if (child.exitCode !== null || child.signalCode !== null) return Promise.resolve(true);
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

async function waitForHttpOk(url, label) {
  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(url);
      if (response.ok) return;
    } catch {}
    await delay(250);
  }
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

  call(method, params = {}) {
    const id = this.nextId;
    this.nextId += 1;
    const payload = JSON.stringify({ id, method, params });
    return new Promise((resolve, reject) => {
      const entry = { resolve, reject, timer: null };
      entry.timer = setTimeout(() => {
        if (this.pending.get(id) !== entry) return;
        this.pending.delete(id);
        reject(new Error(`CDP request ${safeCdpMethodName(method)} timed out after ${this.requestTimeoutMs} ms.`));
      }, this.requestTimeoutMs);
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
    });
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
