import { spawn } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { createRequire } from "node:module";
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import net from "node:net";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
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
const pollIntervalMs = Number(process.env.SKYTURN_NEW_SESSION_UI_POLL_MS ?? 2_000);

const requirement = [
  "Turn this fresh blank React app into a visible SkyTurn delivery status screen.",
  "The page must show exactly: SkyTurn delivery complete, Hermes -> Codex, and Ready for verification.",
  "Keep the app in src/App.jsx and styling in src/App.css.",
  "Only src/App.jsx and src/App.css may be changed or committed.",
  "Do not modify scripts/verify.mjs or scripts/capture-screenshot.mjs; they are fixed validation contracts.",
  "Run node scripts/verify.mjs, capture browser screenshot evidence, review evidence, and commit the verified change.",
].join("\n");

export async function runNewSessionUiAcceptance() {
  const demo = await loadDemoHelpers();
  const { demoReadinessPreflight, readinessFailureResult } = demo;
  const bridgeModule = await import("@skyturn/agent-bridge");
  const bridge = new bridgeModule.AgentBridge({
    adapters: [bridgeModule.createHermesCliAdapter(), bridgeModule.createCodexCliAdapter()],
  });

  const projectRoot = await mkdtemp(join(tmpdir(), "skyturn-new-session-ui-react-"));
  const userData = await mkdtemp(join(tmpdir(), "skyturn-new-session-ui-user-data-"));
  let cleanupProject = process.env.SKYTURN_NEW_SESSION_UI_CLEANUP === "1";
  let cleanupUserData = process.env.SKYTURN_NEW_SESSION_UI_KEEP_USER_DATA !== "1";

  try {
    await demo.seedBlankReactProject(projectRoot);
    const expectedVerifyScriptHash = await fileSha256(join(projectRoot, "scripts", "verify.mjs"));
    const project = makeImportedProject(projectRoot);
    const workspacePath = await preseedWorkspaceState(userData, project);

    const readinessPreflight = await demoReadinessPreflight(bridge);
    if (readinessPreflight.failFast) {
      const failure = readinessFailureResult(readinessPreflight.readiness);
      console.log(JSON.stringify({
        ...emptyAcceptanceResult(projectRoot, readinessPreflight.readiness),
        ...failure,
        projectRoot,
        userData,
        workspacePath,
      }, null, 2));
      process.exitCode = 1;
      return;
    }

    let app;
    try {
      app = await launchElectronAcceptanceApp({ userData });
    } catch (error) {
      console.log(JSON.stringify({
        ...emptyAcceptanceResult(projectRoot, readinessPreflight.readiness),
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
      const cdp = await connectToSkyTurnRenderer(app.cdpPort, app.devServerUrl);
      try {
        await assertPreseededProjectLoaded(cdp, project.rootPath);
        await fillTextareaAndClickCreate(cdp, requirement);
        const workspace = await waitForWorkflowCompletion({
          workspacePath,
          projectRoot,
          graphSummary: demo.flowKernelGraphSummary,
        });
        const session = activeCanvasSession(workspace);
        const verification = await collectFinalVerification({
          demo,
          expectedVerifyScriptHash,
          projectRoot,
          session,
          workspace,
        });
        const ok = verification.ok;
        cleanupProject = cleanupProject && ok;

        console.log(JSON.stringify({
          ok,
          readiness: readinessPreflight.readiness,
          failure: ok
            ? null
            : {
                code: "NEW_SESSION_UI_ACCEPTANCE_FAILED",
                message: "Real Electron New Session UI acceptance predicates did not all pass.",
                diagnostic: verification.diagnostic,
              },
          projectRoot,
          userData,
          workspacePath,
          sessionId: session?.id ?? null,
          requirement,
          laneStatuses: laneStatuses(session),
          runEvidence: runEvidenceSummary(workspace),
          screenshot: {
            path: verification.screenshotPath,
            bytes: verification.screenshotBytes,
          },
          verificationScript: verification.verificationScript,
          commitCount: verification.commitCount,
          changedFiles: verification.changedFiles,
          expectedChangedFiles: verification.expectedChangedFiles,
          unexpectedChangedFiles: verification.unexpectedChangedFiles,
          missingChangedFiles: verification.missingChangedFiles,
          gitStatus: verification.gitStatus,
          graph: verification.graph,
        }, null, 2));

        if (!ok) process.exitCode = 1;
      } finally {
        cdp.close();
      }
    } catch (error) {
      console.log(JSON.stringify({
        ...emptyAcceptanceResult(projectRoot, readinessPreflight.readiness),
        failure: {
          code: "RENDERER_AUTOMATION_FAILED",
          message: "Electron renderer automation failed before workflow completion.",
          diagnostic: error instanceof Error ? error.message : String(error),
        },
        userData,
        workspacePath,
      }, null, 2));
      process.exitCode = 1;
    } finally {
      await app.close();
    }
  } finally {
    if (cleanupProject) await rm(projectRoot, { recursive: true, force: true });
    if (cleanupUserData) await rm(userData, { recursive: true, force: true });
  }
}

export function makeImportedProject(projectRoot) {
  return {
    id: `project-${stableId(projectRoot)}`,
    name: basename(projectRoot),
    rootPath: projectRoot,
    devflowPath: join(projectRoot, ".devflow"),
    openedAt: new Date().toISOString(),
  };
}

export async function preseedWorkspaceState(userData, project) {
  await mkdir(userData, { recursive: true });
  const workspacePath = join(userData, "workspace.json");
  await writeFile(workspacePath, JSON.stringify({
    projects: [project],
    sessions: [],
    changesets: {},
    agents: [],
    runs: {},
    runEvents: {},
    runEvidence: {},
    activeProjectId: project.id,
    activeSessionId: null,
    sidebarCollapsed: false,
    collapsedProjectIds: [],
  }, null, 2));
  return workspacePath;
}

export async function fileSha256(filePath) {
  return createHash("sha256").update(await readFile(filePath)).digest("hex");
}

export async function launchElectronAcceptanceApp({ userData }) {
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
    async close() {
      await Promise.allSettled([electron.close(), vite.close()]);
    },
  };
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

async function loadDemoHelpers() {
  return import("./mvpWorkflowDemo.mjs");
}

async function connectToSkyTurnRenderer(cdpPort, devServerUrl) {
  const targets = await waitForJsonTargets(cdpPort);
  const target = targets.find((item) => typeof item.url === "string" && item.url.startsWith(devServerUrl))
    ?? targets.find((item) => item.type === "page" && typeof item.webSocketDebuggerUrl === "string");
  if (!target?.webSocketDebuggerUrl) {
    throw new Error(`Could not find SkyTurn renderer CDP target at ${devServerUrl}.`);
  }
  const cdp = await CdpClient.connect(target.webSocketDebuggerUrl);
  await cdp.call("Runtime.enable");
  await cdp.call("Page.enable");
  return cdp;
}

async function assertPreseededProjectLoaded(cdp, projectRoot) {
  const result = await cdp.evaluate(`
    (async () => {
      await waitFor(() => window.devflow && document.querySelector('textarea[aria-label="New task goal"]'), 'New Session UI');
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
  const projects = Array.isArray(result?.projects) ? result.projects : [];
  if (!projects.some((project) => project?.rootPath === projectRoot)) {
    throw new Error("Isolated workspace preseed was not loaded by Electron renderer.");
  }
}

async function waitForWorkflowCompletion({ workspacePath, projectRoot, graphSummary }) {
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

async function collectFinalVerification({ demo, expectedVerifyScriptHash, projectRoot, session, workspace }) {
  const verifyScriptPath = join(projectRoot, "scripts", "verify.mjs");
  const testResult = await demo.runCapture(process.execPath, ["scripts/verify.mjs"], projectRoot, { allowFailure: true });
  const actualVerifyScriptHash = await fileSha256(verifyScriptPath);
  const verifyScriptUnchanged = actualVerifyScriptHash === expectedVerifyScriptHash;
  const screenshotPath = join(projectRoot, ".devflow", "acceptance", "react-app.png");
  await demo.captureReactScreenshot(projectRoot, screenshotPath);
  const screenshotBytes = (await stat(screenshotPath)).size;
  const commitCount = await gitCommitCount(projectRoot);
  const changedFiles = commitCount > 1
    ? (await demo.runCapture("git", ["diff", "--name-only", "HEAD~1..HEAD"], projectRoot)).stdout.split("\n").filter(Boolean)
    : [];
  const allowedChangedFiles = ["src/App.css", "src/App.jsx"];
  const unexpectedChangedFiles = changedFiles.filter((file) => !allowedChangedFiles.includes(file));
  const missingChangedFiles = allowedChangedFiles.filter((file) => !changedFiles.includes(file));
  const gitStatus = (await demo.runCapture("git", ["status", "--short"], projectRoot)).stdout.trim();
  const appSource = await readFile(join(projectRoot, "src", "App.jsx"), "utf8");
  const graph = session ? demo.flowKernelGraphSummary(session, session.plannerNodeId) : null;
  const flowNodes = session?.nodes.filter((node) => node.display?.meta?.includes("flow-kernel")) ?? [];
  const runEvidenceValues = Object.values(workspace.runEvidence ?? {});
  const ok =
    !!session &&
    flowNodes.length > 0 &&
    flowNodes.every((node) => node.status === "completed") &&
    graph.connected &&
    graph.codexLaneCount > 0 &&
    graph.rootDependencyIds.length === 0 &&
    graph.rootIncomingEdgeIds.length === 0 &&
    testResult.code === 0 &&
    screenshotBytes > 1_000 &&
    verifyScriptUnchanged &&
    commitCount > 1 &&
    unexpectedChangedFiles.length === 0 &&
    missingChangedFiles.length === 0 &&
    changedFiles.includes("src/App.jsx") &&
    gitStatus === "" &&
    appSource.includes("SkyTurn delivery complete") &&
    appSource.includes("Hermes -> Codex") &&
    appSource.includes("Ready for verification") &&
    runEvidenceValues.some((evidence) => evidence.checks?.some((check) => check.status === "passed"));

  return {
    ok,
    diagnostic: ok
      ? null
      : acceptanceFailureDiagnostic({
          appSource,
          changedFiles,
          commitCount,
          flowNodes,
          gitStatus,
          graph,
          runEvidenceValues,
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
    screenshotPath,
    screenshotBytes,
    commitCount,
    changedFiles,
    expectedChangedFiles: allowedChangedFiles,
    unexpectedChangedFiles,
    missingChangedFiles,
    gitStatus,
    graph,
  };
}

function acceptanceFailureDiagnostic(input) {
  const failures = [];
  if (input.flowNodes.length === 0) failures.push("no-flow-kernel-lanes");
  if (input.flowNodes.some((node) => node.status !== "completed")) failures.push("flow-not-completed");
  if (!input.graph?.connected) failures.push("graph-disconnected");
  if ((input.graph?.codexLaneCount ?? 0) <= 0) failures.push("no-codex-lane");
  if ((input.graph?.rootDependencyIds ?? []).length > 0) failures.push("planner-root-has-dependencies");
  if ((input.graph?.rootIncomingEdgeIds ?? []).length > 0) failures.push("planner-root-has-incoming-edges");
  if (input.testResult.code !== 0) failures.push(`verify-exit-${input.testResult.code}`);
  if (!input.verifyScriptUnchanged) failures.push("verification-script-changed");
  if ((input.unexpectedChangedFiles ?? []).length > 0) failures.push(`unexpected-delivery-files:${input.unexpectedChangedFiles.join("|")}`);
  if ((input.missingChangedFiles ?? []).length > 0) failures.push(`missing-delivery-files:${input.missingChangedFiles.join("|")}`);
  if (input.screenshotBytes <= 1_000) failures.push("screenshot-too-small");
  if (input.commitCount <= 1) failures.push("no-delivery-commit");
  if (!input.changedFiles.includes("src/App.jsx")) failures.push("app-file-not-changed");
  if (input.gitStatus !== "") failures.push("git-status-not-clean");
  if (!input.appSource.includes("SkyTurn delivery complete")) failures.push("missing-delivery-text");
  if (!input.appSource.includes("Hermes -> Codex")) failures.push("missing-agent-chain-text");
  if (!input.appSource.includes("Ready for verification")) failures.push("missing-verification-text");
  if (!input.runEvidenceValues.some((evidence) => evidence.checks?.some((check) => check.status === "passed"))) {
    failures.push("no-passed-run-evidence-check");
  }
  return failures.length > 0 ? failures.join(", ") : "unknown";
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
        status: evidence.status,
        exitCode: evidence.exitCode,
        checks: evidence.checks,
        artifacts: evidence.artifacts,
        errorReason: evidence.errorReason,
        cancelReason: evidence.cancelReason,
      },
    ]),
  );
}

function emptyAcceptanceResult(projectRoot, readiness) {
  return {
    ok: false,
    readiness,
    projectRoot,
    sessionId: null,
    laneStatuses: [],
    runEvidence: {},
    screenshot: { path: null, bytes: 0 },
    commitCount: 0,
    changedFiles: [],
  };
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
  if (!child.pid || child.killed) return;
  if (process.platform === "win32") {
    child.kill();
  } else {
    try {
      process.kill(-child.pid, "SIGTERM");
    } catch {
      child.kill("SIGTERM");
    }
  }
  await delay(500);
  if (!child.killed && child.exitCode === null && child.signalCode === null) {
    try {
      process.kill(process.platform === "win32" ? child.pid : -child.pid, "SIGKILL");
    } catch {}
  }
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

async function waitForJsonTargets(port) {
  const deadline = Date.now() + 30_000;
  const url = `http://${RENDERER_HOST}:${port}/json/list`;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(url);
      if (response.ok) {
        const targets = await response.json();
        if (Array.isArray(targets) && targets.length > 0) return targets;
      }
    } catch {}
    await delay(250);
  }
  throw new Error(`Timed out waiting for Electron CDP targets at ${url}.`);
}

class CdpClient {
  static async connect(webSocketUrl) {
    const client = new CdpClient(webSocketUrl);
    await client.open();
    return client;
  }

  constructor(webSocketUrl) {
    this.url = new URL(webSocketUrl);
    this.socket = null;
    this.nextId = 1;
    this.pending = new Map();
    this.buffer = Buffer.alloc(0);
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
      const onData = (chunk) => {
        this.buffer = Buffer.concat([this.buffer, chunk]);
        const headerEnd = this.buffer.indexOf("\r\n\r\n");
        if (headerEnd === -1) return;
        this.socket.off("data", onData);
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
      this.socket.once("error", reject);
    });
  }

  call(method, params = {}) {
    const id = this.nextId;
    this.nextId += 1;
    const payload = JSON.stringify({ id, method, params });
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.writeFrame(Buffer.from(payload));
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
    if (!message.id) return;
    const pending = this.pending.get(message.id);
    if (!pending) return;
    this.pending.delete(message.id);
    if (message.error) pending.reject(new Error(message.error.message));
    else pending.resolve(message);
  }

  rejectAll(error) {
    for (const { reject } of this.pending.values()) reject(error);
    this.pending.clear();
  }

  close() {
    if (!this.socket || this.socket.destroyed) return;
    this.socket.end();
  }
}

function connectTcp(host, port) {
  return new Promise((resolve, reject) => {
    const socket = net.createConnection({ host, port });
    socket.once("connect", () => resolve(socket));
    socket.once("error", reject);
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

function stableId(value) {
  let hash = 0;
  for (let index = 0; index < value.length; index += 1) {
    hash = (hash * 31 + value.charCodeAt(index)) >>> 0;
  }
  return hash.toString(36);
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
