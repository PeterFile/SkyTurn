import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import vm from "node:vm";

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const require = createRequire(import.meta.url);

test("terminal runtime returns disabled unsupported without spawning PTY", async () => {
  const { createTerminalRuntime } = await loadTerminalRuntime();
  let spawnCount = 0;
  const runtime = createTerminalRuntime({
    protocolVersion: 1,
    featureEnabled: () => false,
    ptyFactory: {
      spawn() {
        spawnCount += 1;
        return new FakePtyProcess();
      },
    },
  });

  const result = await runtime.start({
    projectRoot: "/repo",
    canvasSessionId: "canvas-session-1",
    runId: "run-1",
    agentKind: "hermes",
  });

  assert.deepEqual(toPlain(result), {
    protocolVersion: 1,
    ok: false,
    status: "unsupported",
    reasonCode: "PTY_INTERACTIVE_DISABLED",
    message: "PTY interactive terminal sessions are disabled.",
  });
  assert.equal(spawnCount, 0);
});

test("terminal runtime degrades explicitly when feature is enabled without PTY factory", async () => {
  const { createTerminalRuntime } = await loadTerminalRuntime();
  const runtime = createTerminalRuntime({
    protocolVersion: 1,
    featureEnabled: () => true,
  });

  const result = await runtime.start({
    projectRoot: "/repo",
    canvasSessionId: "canvas-session-1",
    runId: "run-1",
    agentKind: "hermes",
  });

  assert.deepEqual(toPlain(result), {
    protocolVersion: 1,
    ok: false,
    status: "degraded",
    reasonCode: "PTY_MANAGER_UNAVAILABLE",
    message: "PTY terminal session manager is not available.",
  });
});

test("terminal runtime starts Hermes PTY, captures snapshots, broadcasts events, and delegates controls", async () => {
  const { createTerminalRuntime } = await loadTerminalRuntime();
  const projectRoot = await mkdtemp(join(tmpdir(), "skyturn-terminal-runtime-"));
  const pty = new FakePtyProcess();
  const spawnInputs = [];
  const broadcasts = [];
  const runtime = createTerminalRuntime({
    protocolVersion: 1,
    featureEnabled: () => true,
    ptyFactory: {
      spawn(input) {
        spawnInputs.push(input);
        return pty;
      },
    },
    loadAgentBridge: () => import("@skyturn/agent-bridge"),
    broadcastEvent: (event) => {
      broadcasts.push(event);
    },
  });

  try {
    const result = await runtime.start({
      projectRoot,
      canvasSessionId: "canvas-session-1",
      runId: "run-1",
      agentKind: "hermes",
      rows: 25,
      cols: 90,
    });

    assert.equal(result.ok, true);
    assert.equal(result.status, "accepted");
    assert.equal(result.terminalSessionId, "hermes-planner-canvas-session-1");
    assert.notEqual(result.terminalSessionId, "canvas-session-1");
    assert.equal(result.session?.id, result.terminalSessionId);
    assert.equal(spawnInputs.length, 1);
    assert.equal(spawnInputs[0].command, "hermes");
    assert.equal(spawnInputs[0].cols, 90);
    assert.equal(spawnInputs[0].rows, 25);

    pty.emitStdout("hello from Hermes\n");
    await waitUntil(async () => {
      const snapshot = await runtime.snapshot({ terminalSessionId: result.terminalSessionId });
      return snapshot.lines.some((line) => line.text === "hello from Hermes\n");
    });

    const snapshot = await runtime.snapshot({ terminalSessionId: result.terminalSessionId });
    assert.equal(snapshot.status, "running");
    assert.equal(snapshot.rows, 25);
    assert.equal(snapshot.cols, 90);
    assert.equal(snapshot.lines.at(-1).stream, "stdout");
    assert.equal(snapshot.lines.at(-1).text, "hello from Hermes\n");
    assert.ok(snapshot.sequence >= 3);
    assert.ok(broadcasts.some((event) => event.kind === "output" && event.terminalSessionId === result.terminalSessionId));

    await runtime.write({ terminalSessionId: result.terminalSessionId, data: "continue\n" });
    await runtime.resize({ terminalSessionId: result.terminalSessionId, cols: 120, rows: 40 });
    await runtime.cancel({ terminalSessionId: result.terminalSessionId, reason: "User stopped terminal" });

    assert.deepEqual(pty.writes, ["continue\n"]);
    assert.deepEqual(pty.resizes, [{ cols: 120, rows: 40 }]);
    assert.ok(pty.killedSignals.includes("SIGTERM"));
    await waitUntil(async () => {
      const cancelled = await runtime.snapshot({ terminalSessionId: result.terminalSessionId });
      return cancelled.status === "cancelled";
    });
  } finally {
    await rm(projectRoot, { recursive: true, force: true });
  }
});

test("terminal runtime default workflow Hermes PTY launch stays process-level without resume args", async () => {
  const { createTerminalRuntime } = await loadTerminalRuntime();
  const projectRoot = await mkdtemp(join(tmpdir(), "skyturn-terminal-runtime-"));
  const spawnInputs = [];
  const broadcasts = [];
  const runtime = createTerminalRuntime({
    protocolVersion: 1,
    featureEnabled: () => true,
    ptyFactory: {
      spawn(input) {
        spawnInputs.push(input);
        return new FakePtyProcess();
      },
    },
    loadAgentBridge: () => import("@skyturn/agent-bridge"),
    broadcastEvent: (event) => {
      broadcasts.push(event);
    },
  });

  try {
    const result = await runtime.startHermesPlannerForWorkflowSession({
      projectRoot,
      canvasSessionId: "canvas-session-default",
      runId: "run-hermes-planner-default",
      plannerSessionId: "hermes-planner-canvas-session-default",
    });

    assert.equal(result.ok, true);
    assert.equal(spawnInputs.length, 1);
    assert.equal(spawnInputs[0].command, "hermes");
    assert.deepEqual(spawnInputs[0].args, ["chat", "--cli", "--source", "skyturn"]);
    assert.ok(!spawnInputs[0].args.includes("--resume"));
    assert.ok(!spawnInputs[0].args.some((value) => String(value).startsWith("skyturn-ipc:")));
    assert.ok(
      broadcasts.some((event) =>
        event.kind === "progress" &&
        event.terminalSessionId === result.terminalSessionId &&
        /process-level/.test(event.message ?? "")
      ),
    );
  } finally {
    await rm(projectRoot, { recursive: true, force: true });
  }
});

test("terminal runtime sends workflow follow-up input to the existing Hermes planner PTY", async () => {
  const { createTerminalRuntime } = await loadTerminalRuntime();
  const projectRoot = await mkdtemp(join(tmpdir(), "skyturn-terminal-runtime-"));
  const pty = new FakePtyProcess();
  const runtime = createTerminalRuntime({
    protocolVersion: 1,
    featureEnabled: () => true,
    ptyFactory: { spawn: () => pty },
    loadAgentBridge: () => import("@skyturn/agent-bridge"),
  });

  try {
    const start = await runtime.startHermesPlannerForWorkflowSession({
      projectRoot,
      canvasSessionId: "canvas-session-1",
      runId: "run-hermes-planner",
      plannerSessionId: "hermes-planner-canvas-session-1",
      plannerInputId: "input-1",
      hermesSessionHandle: "opaque-hermes-session-1",
    });

    await runtime.sendWorkflowUserInput("canvas-session-1", "follow up\n");

    assert.equal(start.terminalSessionId, "hermes-planner-canvas-session-1");
    assert.equal(runtime.hermesPlannerTerminalSessionId("canvas-session-1"), start.terminalSessionId);
    assert.deepEqual(pty.writes, ["follow up\n"]);
  } finally {
    await rm(projectRoot, { recursive: true, force: true });
  }
});

async function loadTerminalRuntime() {
  const contracts = await loadTerminalIpcContracts();
  const source = await readFile(join(root, "electron", "terminalRuntime.ts"), "utf8");
  const ts = require("typescript");
  const output = ts.transpileModule(source, {
    compilerOptions: {
      module: ts.ModuleKind.CommonJS,
      target: ts.ScriptTarget.ES2022,
    },
  }).outputText;
  const module = { exports: {} };
  const localRequire = (id) => {
    if (id === "./terminalIpcContracts") return contracts;
    return require(id);
  };
  vm.runInNewContext(
    output,
    {
      module,
      exports: module.exports,
      require: localRequire,
      process,
      console,
      Buffer,
      URL,
      setTimeout,
      clearTimeout,
      setImmediate,
      __dirname: join(root, "electron"),
      __filename: join(root, "electron", "terminalRuntime.ts"),
    },
    { filename: "terminalRuntime.ts" },
  );
  return module.exports;
}

async function loadTerminalIpcContracts() {
  const source = await readFile(join(root, "electron", "terminalIpcContracts.ts"), "utf8");
  const ts = require("typescript");
  const output = ts.transpileModule(source, {
    compilerOptions: {
      module: ts.ModuleKind.CommonJS,
      target: ts.ScriptTarget.ES2022,
    },
  }).outputText;
  const module = { exports: {} };
  vm.runInNewContext(output, { module, exports: module.exports }, { filename: "terminalIpcContracts.ts" });
  return module.exports;
}

class FakePtyProcess {
  writes = [];
  resizes = [];
  killedSignals = [];
  dataListeners = new Set();
  stderrListeners = new Set();
  exitListeners = new Set();

  write(data) {
    this.writes.push(data);
  }

  resize(cols, rows) {
    this.resizes.push({ cols, rows });
  }

  kill(signal = "SIGTERM") {
    this.killedSignals.push(signal);
  }

  onData(listener) {
    this.dataListeners.add(listener);
    return { dispose: () => this.dataListeners.delete(listener) };
  }

  onStderr(listener) {
    this.stderrListeners.add(listener);
    return { dispose: () => this.stderrListeners.delete(listener) };
  }

  onExit(listener) {
    this.exitListeners.add(listener);
    return { dispose: () => this.exitListeners.delete(listener) };
  }

  emitStdout(chunk) {
    for (const listener of this.dataListeners) listener(chunk);
  }
}

async function waitUntil(predicate) {
  const started = Date.now();
  while (Date.now() - started < 2_000) {
    if (await predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 0));
  }
  throw new Error("Timed out waiting for condition");
}

function toPlain(value) {
  return JSON.parse(JSON.stringify(value));
}
