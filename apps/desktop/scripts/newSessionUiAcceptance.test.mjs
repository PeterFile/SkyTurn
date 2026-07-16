import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import net from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

const root = new URL("..", import.meta.url);

test("New Session UI acceptance script drives the real renderer input and Create button", async () => {
  const source = await readFile(new URL("newSessionUiAcceptance.mjs", import.meta.url), "utf8");

  assert.match(source, /textarea\[aria-label="New task goal"\]/);
  assert.match(source, /button\[aria-label="Create"\]/);
  assert.match(source, /fillTextareaAndClickCreate/);
  assert.match(source, /launchElectronAcceptanceApp/);
  assert.match(source, /--remote-debugging-port=/);
  assert.match(source, /--user-data-dir=/);
  assert.doesNotMatch(source, /openProject\(/);
  assert.doesNotMatch(source, /createWorkflowSession\(/);
});

test("New Session UI acceptance pre-seeds isolated workspace state for one real project", async () => {
  const { makeImportedProject, preseedWorkspaceState } = await import("./newSessionUiAcceptance.mjs");
  const userData = await mkdtemp(join(tmpdir(), "skyturn-new-session-user-data-test-"));
  const projectRoot = await mkdtemp(join(tmpdir(), "skyturn-new-session-project-test-"));

  try {
    const project = makeImportedProject(projectRoot);
    const workspacePath = await preseedWorkspaceState(userData, project);
    const workspace = JSON.parse(await readFile(workspacePath, "utf8"));

    assert.equal(workspace.projects.length, 1);
    assert.deepEqual(workspace.projects[0], project);
    assert.equal(workspace.activeProjectId, project.id);
    assert.equal(workspace.activeSessionId, null);
    assert.deepEqual(workspace.sessions, []);
    assert.deepEqual(workspace.runEvidence, {});
  } finally {
    await rm(userData, { recursive: true, force: true });
    await rm(projectRoot, { recursive: true, force: true });
  }
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

test("New Session UI acceptance success requires current branch and real Hermes plus Codex evidence", async () => {
  const source = await readFile(new URL("newSessionUiAcceptance.mjs", import.meta.url), "utf8");

  assert.match(source, /sessionTarget\?\.executionTarget === "current_branch"/);
  assert.match(source, /hasSuccessfulRunEvidenceForAgent\(session, workspace, "hermes"\)/);
  assert.match(source, /hasSuccessfulRunEvidenceForAgent\(session, workspace, "codex"\)/);
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

test("New Session UI acceptance returns structured failed workflow result with latest evidence", async () => {
  const { workflowTerminalFailureResult } = await import("./newSessionUiAcceptance.mjs");
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
    runEvidence: { "run-codex-1": failedEvidence },
  };

  const result = workflowTerminalFailureResult({
    projectRoot: "/tmp/project",
    readiness: { status: "ready", checks: { mockFallback: false } },
    workspacePath: "/tmp/workspace.json",
    workspace,
  });

  assert.equal(result.ok, false);
  assert.equal(result.failure.code, "WORKFLOW_RUN_FAILED");
  assert.equal(result.projectRoot, "/tmp/project");
  assert.equal(result.workspacePath, "/tmp/workspace.json");
  assert.equal(result.latestWorkspace, workspace);
  assert.equal(result.runEvidence["run-codex-1"].status, "failed");
  assert.equal(result.runEvidence["run-codex-1"].exitCode, 1);
  assert.equal(result.agentRunEvidence.codex[0].runId, "run-codex-1");
  assert.equal(result.agentRunEvidence.codex[0].evidenceRunId, "run-codex-1");
  assert.deepEqual(result.laneStatuses.map((node) => node.status), ["failed"]);
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

  assert.equal(hasSuccessfulRunEvidenceForAgent(session, {
    runEvidence: { "run-hermes-1": { ...baseEvidence, runId: "run-stale" } },
  }, "hermes"), false);
  assert.equal(hasSuccessfulRunEvidenceForAgent(session, {
    runEvidence: { "run-hermes-1": { ...baseEvidence, checks: [{ kind: "test", name: "unit", status: "passed" }] } },
  }, "hermes"), false);
  assert.equal(hasSuccessfulRunEvidenceForAgent(session, {
    runEvidence: { "run-hermes-1": { ...baseEvidence, checks: [{ kind: "run-exit", name: "Mock adapter exit", status: "passed" }] } },
  }, "hermes"), false);
  assert.equal(hasSuccessfulRunEvidenceForAgent(session, {
    runEvidence: { "run-hermes-1": baseEvidence },
  }, "hermes"), true);
});

test("New Session UI acceptance reports and cleans Electron launch failures", async () => {
  const source = await readFile(new URL("newSessionUiAcceptance.mjs", import.meta.url), "utf8");

  assert.match(source, /ELECTRON_LAUNCH_FAILED/);
  assert.match(source, /RENDERER_AUTOMATION_FAILED/);
  assert.match(source, /Promise\.allSettled\(\[electron\.close\(\), vite\.close\(\)\]\)/);
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
    source.indexOf("const cdp = await connectToReadySkyTurnRenderer") <
      source.indexOf("await fillTextareaAndClickCreate(cdp, requirement)"),
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

test("New Session UI acceptance is exposed as an explicit desktop package script", async () => {
  const packageJson = JSON.parse(await readFile(new URL("package.json", root), "utf8"));

  assert.equal(packageJson.scripts["acceptance:new-session-ui"], "node scripts/newSessionUiAcceptance.mjs");
});
