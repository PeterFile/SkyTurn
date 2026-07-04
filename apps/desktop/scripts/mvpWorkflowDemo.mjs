import { createRequire } from "node:module";
import { spawn } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, stat, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { createServer } from "vite";

import {
  AgentBridge,
  RUN_EVENT_PROTOCOL_VERSION,
  createCodexCliAdapter,
  createHermesCliAdapter,
  loadRunEvents,
} from "@skyturn/agent-bridge";
import { parseHermesWorkflowIntent } from "@skyturn/orchestrator";
import { createFastCanvasSession } from "@skyturn/planner";
import { summarizeAgentReadiness } from "@skyturn/project-core";
import { addRequirementPlanningNode } from "@skyturn/ui-canvas/composer";
import { buildPromptForNodeRun, mergeRunEventsIntoWorkspace, sandboxForNodeRun } from "@skyturn/ui-canvas/workflow-runtime";

const require = createRequire(import.meta.url);
const desktopRoot = dirname(dirname(fileURLToPath(import.meta.url)));
const waitTimeoutMs = Number(process.env.SKYTURN_DEMO_WAIT_TIMEOUT_MS ?? 20 * 60 * 1_000);
const maxWorkflowRuns = Number(process.env.SKYTURN_DEMO_MAX_RUNS ?? 12);

export async function runMvpWorkflowDemo() {
  const bridge = new AgentBridge({
    adapters: [createHermesCliAdapter(), createCodexCliAdapter()],
  });

  const readinessPreflight = await demoReadinessPreflight(bridge);
  if (readinessPreflight.failFast) {
    console.log(JSON.stringify(readinessFailureResult(readinessPreflight.readiness), null, 2));
    process.exitCode = 1;
    return;
  }

  const root = await mkdtemp(join(tmpdir(), "skyturn-react-demo-"));
  let cleanupRoot = process.env.SKYTURN_DEMO_CLEANUP === "1";

  try {
    await seedBlankReactProject(root);
    const request = [
      "Turn this fresh blank React app into a visible SkyTurn delivery status screen.",
      "The page must show exactly: SkyTurn delivery complete, Hermes -> Codex, and Ready for verification.",
      "Keep the app in src/App.jsx and styling in src/App.css.",
      "Run node scripts/verify.mjs, capture browser screenshot evidence, review evidence, and commit the verified change.",
    ].join("\n");
    const project = {
      id: "project-react-demo",
      name: "skyturn-blank-react-demo",
      rootPath: root,
      devflowPath: join(root, ".devflow"),
      openedAt: new Date().toISOString(),
    };
    const seedSession = createFastCanvasSession({
      projectId: project.id,
      goal: request,
      createdAt: new Date().toISOString(),
    });
    const input = addRequirementPlanningNode(completeSeedPlanningNode(seedSession), request, {
      projectName: project.name,
      now: new Date().toISOString(),
    });
    let session = input.session;
    let workspace = {
      projects: [project],
      sessions: [session],
      changesets: {},
      agents: [],
      runs: {},
      runEvents: {},
      runEvidence: {},
      activeProjectId: project.id,
      activeSessionId: session.id,
      sidebarCollapsed: false,
      collapsedProjectIds: [],
    };
    const startedRunIds = new Set();
    const runGitDeltas = [];

    for (let iteration = 0; iteration < maxWorkflowRuns; iteration += 1) {
      session = canvasSession(workspace, session.id);
      const runnable = session.nodes.filter(
        (node) =>
          (node.status === "running" || node.status === "retrying") &&
          !startedRunIds.has(node.runId),
      );
      if (runnable.length === 0) break;

      for (const node of runnable) {
        startedRunIds.add(node.runId);
        const commitCountBefore = await gitCommitCount(root);
        const run = await startNodeRun(bridge, root, session, node);
        await waitForFinalStatus(bridge, run.id);
        const commitCountAfter = await gitCommitCount(root);
        runGitDeltas.push({
          runId: run.id,
          nodeId: node.id,
          laneKind: node.display?.meta[0] ?? "",
          commitCountBefore,
          commitCountAfter,
        });
        const events = await loadRunEvents(root, run.id);
        workspace = mergeRunEventsIntoWorkspace(workspace, run.id, events);
      }
    }

    session = canvasSession(workspace, session.id);
    const testResult = await runCapture(process.execPath, ["scripts/verify.mjs"], root, { allowFailure: true });
    const screenshotPath = join(root, ".devflow", "acceptance", "react-app.png");
    await captureReactScreenshot(root, screenshotPath);
    const screenshotBytes = (await stat(screenshotPath)).size;
    const commitCount = Number((await runCapture("git", ["rev-list", "--count", "HEAD"], root)).stdout.trim());
    const changedFiles = commitCount > 1
      ? (await runCapture("git", ["diff", "--name-only", "HEAD~1..HEAD"], root)).stdout.split("\n").filter(Boolean)
      : [];
    const gitStatus = (await runCapture("git", ["status", "--short"], root)).stdout.trim();
    const appSource = await readFile(join(root, "src", "App.jsx"), "utf8");
    const intents = Object.values(workspace.runEvents).flatMap(workflowIntentsFromEvents);
    const graph = flowKernelGraphSummary(session, session.plannerNodeId);
    const flowNodes = session.nodes.filter((node) => node.display?.meta.includes("flow-kernel"));
    const completedFlow = flowNodes.length > 0 && flowNodes.every((node) => node.status === "completed");
    const runEvidenceValues = Object.values(workspace.runEvidence);
    const commitDeltas = runGitDeltas.filter((delta) => delta.commitCountAfter > delta.commitCountBefore);
    const commitDeltaOnlyFromCommitLane =
      commitDeltas.length > 0 &&
      commitDeltas.every((delta) => delta.laneKind === "commit");
    const ok =
      intents.length > 0 &&
      completedFlow &&
      graph.connected &&
      graph.rootDependencyIds.length === 0 &&
      graph.rootIncomingEdgeIds.length === 0 &&
      graph.codexLaneCount > 0 &&
      graph.duplicateSemanticKeys.length === 0 &&
      testResult.code === 0 &&
      screenshotBytes > 1_000 &&
      commitCount > 1 &&
      commitDeltaOnlyFromCommitLane &&
      changedFiles.includes("src/App.jsx") &&
      appSource.includes("SkyTurn delivery complete") &&
      appSource.includes("Hermes -> Codex") &&
      appSource.includes("Ready for verification") &&
      runEvidenceValues.some((evidence) => evidence.checks.some((check) => check.status === "passed"));

    cleanupRoot = cleanupRoot && ok;
    console.log(JSON.stringify({
      ok,
      readiness: readinessPreflight.readiness,
      failure: ok
        ? null
        : {
            code: "DEMO_ACCEPTANCE_FAILED",
            message: "Desktop MVP demo acceptance predicates did not all pass.",
            diagnostic: acceptanceFailureDiagnostic({
              appSource,
              changedFiles,
              commitCount,
              commitDeltaOnlyFromCommitLane,
              completedFlow,
              graph,
              intents,
              runEvidenceValues,
              screenshotBytes,
              testResult,
            }),
          },
      projectRoot: root,
      request,
      planner: {
        plannerSessionId: session.hermesPlannerSessionId,
        plannerNodeId: session.plannerNodeId,
        intentIds: intents.map((intent) => intent.intentId),
      },
      verification: {
        testCommand: `${process.execPath} scripts/verify.mjs`,
        testExitCode: testResult.code,
        screenshotPath,
        screenshotBytes,
        commitCount,
        changedFiles,
        gitStatus,
        runGitDeltas,
      },
      cards: session.nodes.map((node) => ({
        id: node.id,
        agent: node.agent,
        status: node.status,
        title: node.title,
        runId: node.runId,
        dependencies: node.context.dependencies,
        meta: node.display?.meta ?? [],
      })),
      runEvidence: Object.fromEntries(
        Object.entries(workspace.runEvidence).map(([runId, evidence]) => [
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
      ),
      graph,
    }, null, 2));

    if (!ok) process.exitCode = 1;
  } finally {
    if (cleanupRoot) await rm(root, { recursive: true, force: true });
  }
}

if (process.argv[1] && process.argv[1] === fileURLToPath(import.meta.url)) {
  runMvpWorkflowDemo().catch((error) => {
    console.error(error);
    process.exitCode = 1;
  });
}

export async function demoReadinessPreflight(bridge, summarize = summarizeAgentReadiness) {
  const agents = await bridge.discoverAgents();
  const readiness = summarize(agents);
  return {
    agents,
    readiness,
    failFast: shouldFailFastForReadiness(readiness),
  };
}

export function shouldFailFastForReadiness(readiness) {
  return readiness.status === "blocked" || readiness.status === "mock-only";
}

export function readinessFailureResult(readiness) {
  const code = readiness.status === "mock-only" ? "AGENT_READINESS_MOCK_ONLY" : "AGENT_READINESS_BLOCKED";
  const diagnostic = Array.isArray(readiness.reasons) && readiness.reasons.length > 0
    ? readiness.reasons.join(", ")
    : readiness.status;
  return {
    ok: false,
    readiness,
    failure: {
      code,
      message: readiness.message,
      diagnostic,
    },
  };
}

function acceptanceFailureDiagnostic(input) {
  const failures = [];
  if (input.intents.length === 0) failures.push("no-workflow-intent");
  if (!input.completedFlow) failures.push("flow-not-completed");
  if (!input.graph.connected) failures.push("graph-disconnected");
  if (input.graph.rootDependencyIds.length > 0) failures.push("planner-root-has-dependencies");
  if (input.graph.rootIncomingEdgeIds.length > 0) failures.push("planner-root-has-incoming-edges");
  if (input.graph.codexLaneCount <= 0) failures.push("no-codex-lane");
  if (input.graph.duplicateSemanticKeys.length > 0) failures.push("duplicate-semantic-keys");
  if (input.testResult.code !== 0) failures.push(`verify-exit-${input.testResult.code}`);
  if (input.screenshotBytes <= 1_000) failures.push("screenshot-too-small");
  if (input.commitCount <= 1) failures.push("no-delivery-commit");
  if (!input.commitDeltaOnlyFromCommitLane) failures.push("commit-outside-commit-lane");
  if (!input.changedFiles.includes("src/App.jsx")) failures.push("app-file-not-changed");
  if (!input.appSource.includes("SkyTurn delivery complete")) failures.push("missing-delivery-text");
  if (!input.appSource.includes("Hermes -> Codex")) failures.push("missing-agent-chain-text");
  if (!input.appSource.includes("Ready for verification")) failures.push("missing-verification-text");
  if (!input.runEvidenceValues.some((evidence) => evidence.checks.some((check) => check.status === "passed"))) {
    failures.push("no-passed-run-evidence-check");
  }
  return failures.length > 0 ? failures.join(", ") : "unknown";
}

export async function seedBlankReactProject(projectRoot) {
  await mkdir(join(projectRoot, "src"), { recursive: true });
  await mkdir(join(projectRoot, "scripts"), { recursive: true });
  await writeFile(join(projectRoot, ".gitignore"), ["node_modules", ".devflow", "dist", ""].join("\n"));
  await writeFile(join(projectRoot, "package.json"), JSON.stringify({
    name: "skyturn-blank-react-demo",
    version: "0.0.0",
    private: true,
    type: "module",
    scripts: {
      dev: "vite --host 127.0.0.1",
      test: "node scripts/verify.mjs",
    },
    dependencies: {
      "@vitejs/plugin-react": "^6.0.2",
      vite: "^8.0.16",
      react: "^19.2.7",
      "react-dom": "^19.2.3",
    },
  }, null, 2));
  await writeFile(join(projectRoot, "index.html"), [
    '<!doctype html>',
    '<html lang="en">',
    "  <head>",
    '    <meta charset="UTF-8" />',
    '    <meta name="viewport" content="width=device-width, initial-scale=1.0" />',
    "    <title>SkyTurn Blank React Demo</title>",
    "  </head>",
    "  <body>",
    '    <div id="root"></div>',
    '    <script type="module" src="/src/main.jsx"></script>',
    "  </body>",
    "</html>",
    "",
  ].join("\n"));
  await writeFile(join(projectRoot, "src", "main.jsx"), [
    "import React from 'react';",
    "import { createRoot } from 'react-dom/client';",
    "import App from './App.jsx';",
    "import './App.css';",
    "",
    "createRoot(document.getElementById('root')).render(<App />);",
    "",
  ].join("\n"));
  await writeFile(join(projectRoot, "src", "App.jsx"), [
    "export default function App() {",
    "  return (",
    '    <main className="app-shell">',
    "      <p>Blank React project</p>",
    "    </main>",
    "  );",
    "}",
    "",
  ].join("\n"));
  await writeFile(join(projectRoot, "src", "App.css"), [
    ":root {",
    "  font-family: Inter, system-ui, sans-serif;",
    "}",
    "",
    "body {",
    "  margin: 0;",
    "}",
    "",
    ".app-shell {",
    "  min-height: 100vh;",
    "  display: grid;",
    "  place-items: center;",
    "}",
    "",
  ].join("\n"));
  await writeFile(join(projectRoot, "scripts", "verify.mjs"), [
    "import assert from 'node:assert/strict';",
    "import { readFile } from 'node:fs/promises';",
    "",
    "const app = await readFile(new URL('../src/App.jsx', import.meta.url), 'utf8');",
    "assert.match(app, /SkyTurn delivery complete/);",
    "assert.match(app, /Hermes -> Codex/);",
    "assert.match(app, /Ready for verification/);",
    "console.log('SkyTurn React delivery verification passed');",
    "",
  ].join("\n"));
  await writeFile(join(projectRoot, "scripts", "capture-screenshot.mjs"), [
    "import { createRequire } from 'node:module';",
    "import { spawn } from 'node:child_process';",
    "import { mkdir, writeFile } from 'node:fs/promises';",
    "import { dirname, resolve } from 'node:path';",
    "import { createServer } from 'vite';",
    "",
    "const require = createRequire(import.meta.url);",
    "const out = resolve(process.argv[2] ?? '.devflow/acceptance/react-app.png');",
    "await mkdir(dirname(out), { recursive: true });",
    "const server = await createServer({",
    "  root: process.cwd(),",
    "  logLevel: 'silent',",
    "  clearScreen: false,",
    "  server: { host: '127.0.0.1', port: 0 },",
    "});",
    "try {",
    "  await server.listen();",
    "  const address = server.httpServer?.address();",
    "  if (!address || typeof address !== 'object') throw new Error('Vite server did not expose a TCP port.');",
    "  const url = `http://127.0.0.1:${address.port}/`;",
    "  const scriptPath = resolve('.devflow/acceptance/capture.cjs');",
    "  await writeFile(scriptPath, [",
    "    \"const { app, BrowserWindow } = require('electron');\",",
    "    \"const fs = require('node:fs');\",",
    "    \"const [url, out] = process.argv.slice(2);\",",
    "    \"app.commandLine.appendSwitch('disable-gpu');\",",
    "    \"app.commandLine.appendSwitch('no-sandbox');\",",
    "    \"app.whenReady().then(async () => {\",",
    "    \"  const timeout = setTimeout(() => { console.error('capture timeout'); app.exit(1); }, 30000);\",",
    "    \"  const win = new BrowserWindow({ width: 1280, height: 800, show: false });\",",
    "    \"  await win.loadURL(url);\",",
    "    \"  const text = await win.webContents.executeJavaScript('document.body.innerText');\",",
    "    \"  for (const expected of ['SkyTurn delivery complete', 'Hermes -> Codex', 'Ready for verification']) {\",",
    "    \"    if (!text.includes(expected)) throw new Error(`missing rendered text: ${expected}`);\",",
    "    \"  }\",",
    "    \"  await new Promise((resolve) => setTimeout(resolve, 1200));\",",
    "    \"  const image = await win.webContents.capturePage();\",",
    "    \"  fs.writeFileSync(out, image.toPNG());\",",
    "    \"  clearTimeout(timeout);\",",
    "    \"  app.quit();\",",
    "    \"}).catch((error) => { console.error(error); app.exit(1); });\",",
    "    \"\",",
    "  ].join('\\n'));",
    "  const electron = require('electron');",
    "  await run(electron, [scriptPath, url, out]);",
    "  console.log(`SkyTurn React screenshot saved ${out}`);",
    "} finally {",
    "  await server.close();",
    "}",
    "",
    "function run(command, args) {",
    "  return new Promise((resolveRun, rejectRun) => {",
    "    const child = spawn(command, args, {",
    "      cwd: process.cwd(),",
    "      env: { ...process.env, ELECTRON_DISABLE_SECURITY_WARNINGS: '1' },",
    "      detached: process.platform !== 'win32',",
    "      stdio: ['ignore', 'pipe', 'pipe'],",
    "    });",
    "    let stdout = '';",
    "    let stderr = '';",
    "    const timeout = setTimeout(() => {",
    "      terminate(child, 'SIGTERM');",
    "      setTimeout(() => terminate(child, 'SIGKILL'), 2000).unref();",
    "      rejectRun(new Error(`screenshot command timed out: ${stderr || stdout}`));",
    "    }, 45000);",
    "    child.stdout.on('data', (chunk) => { stdout += chunk.toString(); });",
    "    child.stderr.on('data', (chunk) => { stderr += chunk.toString(); });",
    "    child.once('error', (error) => { clearTimeout(timeout); rejectRun(error); });",
    "    child.once('close', (code) => {",
    "      clearTimeout(timeout);",
    "      if (code === 0) resolveRun();",
    "      else rejectRun(new Error(`screenshot command exited ${code}: ${stderr || stdout}`));",
    "    });",
    "  });",
    "}",
    "",
    "function terminate(child, signal) {",
    "  if (!child.pid) return;",
    "  if (process.platform === 'win32') {",
    "    child.kill(signal);",
    "    return;",
    "  }",
    "  try {",
    "    process.kill(-child.pid, signal);",
    "  } catch {",
    "    child.kill(signal);",
    "  }",
    "}",
    "",
  ].join("\n"));
  await linkWorkspaceNodeModules(projectRoot);
  await runCapture("git", ["init"], projectRoot);
  await runCapture("git", ["config", "user.name", "SkyTurn Demo"], projectRoot);
  await runCapture("git", ["config", "user.email", "skyturn-demo@example.invalid"], projectRoot);
  await runCapture("git", ["add", "."], projectRoot);
  await runCapture("git", ["commit", "-m", "Initialize blank React app"], projectRoot);
}

async function linkWorkspaceNodeModules(projectRoot) {
  try {
    await symlink(join(desktopRoot, "node_modules"), join(projectRoot, "node_modules"), "dir");
  } catch {
    // The project can still be edited and tested with node scripts.
  }
}

function completeSeedPlanningNode(session) {
  return {
    ...session,
    nodes: session.nodes.map((node) => ({
      ...node,
      status: "completed",
      progress: "Seed canvas ready",
      runtime: {
        phase: "Completed",
        message: "Seed canvas ready",
        action: "ready for workflow input",
      },
      output: ["Seed canvas ready for workflow input."],
    })),
    activeNodeId: null,
  };
}

function canvasSession(workspace, sessionId) {
  const session = workspace.sessions.find((item) => item.id === sessionId);
  if (!session || session.kind !== "canvas") throw new Error("Workflow did not keep a canvas session.");
  return session;
}

function startNodeRun(bridge, projectRoot, session, node) {
  const sandbox = sandboxForNodeRun(node);
  return bridge.startRun({
    protocolVersion: RUN_EVENT_PROTOCOL_VERSION,
    runId: node.runId,
    nodeId: node.id,
    sessionId: session.id,
    ...(node.agent === "hermes"
      ? {
          plannerSessionId: session.hermesPlannerSessionId,
          plannerInputId: node.runId,
        }
      : {}),
    projectRoot,
    worktreePath: projectRoot,
    agentKind: node.agent,
    ...(sandbox ? { sandbox } : {}),
    prompt: buildPromptForNodeRun(session, node),
  });
}

function waitForFinalStatus(bridge, runId) {
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      unsubscribe();
      reject(new Error(`Timed out waiting for ${runId} after ${waitTimeoutMs}ms`));
    }, waitTimeoutMs);
    const unsubscribe = bridge.onRunEvent((event) => {
      if (event.runId !== runId || event.kind !== "status") return;
      const status = event.payload.status;
      if (status !== "succeeded" && status !== "failed" && status !== "cancelled" && status !== "timed-out") return;
      clearTimeout(timeout);
      unsubscribe();
      resolve(event);
    });
  });
}

async function gitCommitCount(projectRoot) {
  return Number((await runCapture("git", ["rev-list", "--count", "HEAD"], projectRoot)).stdout.trim());
}

export async function captureReactScreenshot(projectRoot, screenshotPath) {
  await mkdir(dirname(screenshotPath), { recursive: true });
  const server = await createServer({
    root: projectRoot,
    logLevel: "silent",
    clearScreen: false,
    server: {
      host: "127.0.0.1",
      port: 0,
    },
  });
  try {
    await server.listen();
    const address = server.httpServer?.address();
    if (!address || typeof address !== "object") throw new Error("Vite server did not expose a TCP port.");
    const url = `http://127.0.0.1:${address.port}/`;
    await captureWithElectron(url, screenshotPath, projectRoot);
  } finally {
    await server.close();
  }
}

async function captureWithElectron(url, screenshotPath, projectRoot) {
  const electronBinary = require("electron");
  const captureScript = join(projectRoot, ".devflow", "acceptance", "capture.cjs");
  await writeFile(captureScript, [
    "const { app, BrowserWindow } = require('electron');",
    "const fs = require('node:fs');",
    "const [url, out] = process.argv.slice(2);",
    "app.commandLine.appendSwitch('disable-gpu');",
    "app.whenReady().then(async () => {",
    "  const timeout = setTimeout(() => { console.error('capture timeout'); app.exit(1); }, 30000);",
    "  const win = new BrowserWindow({ width: 1280, height: 800, show: false });",
    "  await win.loadURL(url);",
    "  await new Promise((resolve) => setTimeout(resolve, 1200));",
    "  const image = await win.webContents.capturePage();",
    "  fs.writeFileSync(out, image.toPNG());",
    "  clearTimeout(timeout);",
    "  app.quit();",
    "}).catch((error) => { console.error(error); app.exit(1); });",
    "",
  ].join("\n"));
  const result = await runCapture(electronBinary, [captureScript, url, screenshotPath], projectRoot, {
    env: { ...process.env, ELECTRON_DISABLE_SECURITY_WARNINGS: "1" },
  });
  if (result.code !== 0) {
    throw new Error(`Electron screenshot failed: ${result.stderr || result.stdout}`);
  }
}

export function workflowIntentsFromEvents(events) {
  return events.flatMap((event) => {
    if (event.kind !== "output" || typeof event.payload.text !== "string") return [];
    const parsed = parseHermesWorkflowIntent(event.payload.text);
    return parsed.ok ? [parsed.intent] : [];
  });
}

export function runCapture(command, args, cwd, options = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd,
      env: options.env ?? process.env,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => {
      stdout += chunk.toString();
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk.toString();
    });
    child.once("error", reject);
    child.once("close", (code) => {
      if (code === 0 || options.allowFailure) {
        resolve({ code: code ?? -1, stdout, stderr });
        return;
      }
      reject(new Error(`${command} ${args.join(" ")} exited ${code}\n${stderr || stdout}`));
    });
  });
}

export function flowKernelGraphSummary(session, rootCardId) {
  const generated = session.nodes.filter((node) => node.id === rootCardId || node.display?.meta.includes("flow-kernel"));
  const generatedIds = new Set(generated.map((node) => node.id));
  const generatedEdges = session.edges.filter((edge) => generatedIds.has(edge.source) && generatedIds.has(edge.target));
  const rootCard = session.nodes.find((node) => node.id === rootCardId);
  const rootDependencyIds = rootCard?.context.dependencies ?? [];
  const rootIncomingEdgeIds = session.edges.filter((edge) => edge.target === rootCardId).map((edge) => edge.id);
  const flowLaneIds = new Set(generated.filter((node) => node.display?.meta.includes("flow-kernel")).map((node) => node.id));
  const disconnectedCardIds = generated
    .filter((node) => {
      if (node.id === rootCardId) return false;
      if (!flowLaneIds.has(node.id)) return false;
      return node.context.dependencies.some((dependency) => !generatedIds.has(dependency));
    })
    .map((node) => node.id);
  const dependencyMismatchIds = generated
    .filter((node) => flowLaneIds.has(node.id))
    .filter((node) => !arraysEqual([...node.context.dependencies].sort(), incomingDependencies(generatedEdges, node.id)))
    .map((node) => node.id);
  const semanticKeys = generated
    .map((node) => node.workflowTrace?.semanticKey ?? `${node.agent}:${normalizeText(node.title)}:${normalizeText(node.context.brief)}`)
    .filter(Boolean);
  const duplicateSemanticKeys = [...new Set(semanticKeys.filter((key, index) => semanticKeys.indexOf(key) !== index))];

  return {
    connected: disconnectedCardIds.length === 0 && dependencyMismatchIds.length === 0,
    rootCardId,
    rootDependencyIds,
    rootIncomingEdgeIds,
    generatedCardIds: [...generatedIds],
    generatedEdges,
    disconnectedCardIds,
    dependencyMismatchIds,
    duplicateSemanticKeys,
    codexLaneCount: generated.filter((node) => node.agent === "codex" && node.display?.meta.includes("flow-kernel")).length,
  };
}

function incomingDependencies(edges, nodeId) {
  return edges.filter((edge) => edge.target === nodeId).map((edge) => edge.source).sort();
}

function arraysEqual(left, right) {
  if (left.length !== right.length) return false;
  return left.every((value, index) => value === right[index]);
}

function normalizeText(value) {
  return value.trim().toLowerCase().replace(/[^a-z0-9\u4e00-\u9fff]+/g, " ").replace(/\s+/g, " ").trim();
}
