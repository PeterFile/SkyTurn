import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { readFile } from "node:fs/promises";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import vm from "node:vm";

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const require = createRequire(import.meta.url);

test("Electron main exposes feature-gated terminal IPC through terminal runtime", async () => {
  const main = await readFile(join(root, "electron", "main.ts"), "utf8");
  const runtime = await readFile(join(root, "electron", "terminalRuntime.ts"), "utf8");

  for (const channel of [
    "terminal:start",
    "terminal:write",
    "terminal:resize",
    "terminal:cancel",
    "terminal:snapshot",
  ]) {
    assert.match(main, new RegExp(`ipcMain\\.handle\\("${escapeRegExp(channel)}"`));
  }

  assert.match(main, /createTerminalRuntime\(/);
  assert.match(runtime, /terminalUnsupportedResult\(.*false\)/);
  assert.match(runtime, /terminalUnsupportedResult\(.*true\)/);
  assert.match(runtime, /createHermesPlannerPtyTransport/);
  assert.match(runtime, /const snapshots = new Map<string, TerminalSnapshotState>\(\)/);
  assert.match(main, /window\.webContents\.send\("terminal:event", event\)/);

  const startHandler = main.slice(
    main.indexOf('ipcMain.handle("terminal:start"'),
    main.indexOf('ipcMain.handle("terminal:write"'),
  );
  assert.match(startHandler, /assertTerminalStartInput\(input\)/);
  assert.match(startHandler, /assertKnownProjectRoot\(normalized\.projectRoot\)/);
  assert.match(startHandler, /terminalRuntime\.start\(normalized\)/);
  assert.doesNotMatch(startHandler, /startRun|spawn|execFile|createCodex/);
});

test("terminal IPC contracts validate input and return stable disabled snapshots", async () => {
  const contracts = await loadTerminalIpcContracts();

  assert.equal(contracts.TERMINAL_IPC_CHANNELS.start, "terminal:start");
  assert.equal(contracts.TERMINAL_IPC_CHANNELS.snapshot, "terminal:snapshot");
  assert.equal(contracts.TERMINAL_IPC_EVENT_CHANNEL, "terminal:event");
  assert.equal(
    contracts.terminalStartInputError({
      projectRoot: "/repo",
      canvasSessionId: "session-1",
      runId: "run-1",
      agentKind: "codex",
      rows: 24,
      cols: 80,
    }),
    null,
  );
  assert.equal(
    contracts.terminalStartInputError({
      projectRoot: "/repo",
      canvasSessionId: "session-1",
      runId: "run-1",
      agentKind: "unknown-agent",
    }),
    "INVALID_INPUT",
  );
  assert.equal(contracts.terminalWriteInputError({ terminalSessionId: "term-1", data: "ls\n" }), null);
  assert.equal(contracts.terminalWriteInputError({ terminalSessionId: "term-1", data: "" }), "INVALID_INPUT");
  assert.equal(contracts.terminalResizeInputError({ terminalSessionId: "term-1", rows: 24, cols: 80 }), null);
  assert.equal(contracts.terminalResizeInputError({ terminalSessionId: "term-1", rows: 0, cols: 80 }), "INVALID_INPUT");

  assert.deepEqual(toPlain(contracts.terminalUnsupportedResult(1, false)), {
    protocolVersion: 1,
    ok: false,
    status: "unsupported",
    reasonCode: "PTY_INTERACTIVE_DISABLED",
    message: "PTY interactive terminal sessions are disabled.",
  });
  assert.deepEqual(toPlain(contracts.emptyTerminalSnapshot(1, "term-1")), {
    protocolVersion: 1,
    terminalSessionId: "term-1",
    status: "unavailable",
    sequence: 0,
    rows: 0,
    cols: 0,
    cursor: { row: 0, col: 0 },
    lines: [],
    reasonCode: "TERMINAL_SESSION_NOT_FOUND",
    message: "Terminal session is not available.",
  });
});

test("preload exposes a narrow terminal namespace with safe subscriptions", async () => {
  const preload = await readFile(join(root, "electron", "preload.ts"), "utf8");
  const terminalBlock = preload.slice(
    preload.indexOf("const terminal ="),
    preload.indexOf("const workflow ="),
  );

  assert.match(preload, /import type \{[\s\S]*\} from "\.\/terminalIpcContracts"/);
  assert.match(preload, /TerminalStartInput/);
  assert.match(preload, /TerminalRendererEvent/);
  assert.match(terminalBlock, /start:\s*\(input: TerminalStartInput\).*ipcRenderer\.invoke\("terminal:start", input\)/);
  assert.match(terminalBlock, /write:\s*\(input: TerminalWriteInput\).*ipcRenderer\.invoke\("terminal:write", input\)/);
  assert.match(terminalBlock, /resize:\s*\(input: TerminalResizeInput\).*ipcRenderer\.invoke\("terminal:resize", input\)/);
  assert.match(terminalBlock, /cancel:\s*\(input: TerminalCancelInput\).*ipcRenderer\.invoke\("terminal:cancel", input\)/);
  assert.match(terminalBlock, /snapshot:\s*\(input: TerminalSnapshotInput\).*ipcRenderer\.invoke\("terminal:snapshot", input\)/);
  assert.match(terminalBlock, /ipcRenderer\.on\("terminal:event", handler\)/);
  assert.match(terminalBlock, /return \(\) => ipcRenderer\.removeListener\("terminal:event", handler\)/);
  assert.doesNotMatch(terminalBlock, /ipcRenderer\s*:|return\s+ipcRenderer|listener\(_event|ipcRenderer\.on\("terminal:event", listener\)/);
  assert.match(preload, /terminal,\n\s+onRunEvent/);
});

test("renderer public types expose terminal API without backend internals", async () => {
  const persistence = await readFile(join(root, "..", "..", "packages", "persistence", "src", "index.ts"), "utf8");

  assert.match(persistence, /export interface TerminalApi/);
  assert.match(persistence, /start:\s*\(input: TerminalStartInput\) => Promise<TerminalStartResult>/);
  assert.match(persistence, /snapshot:\s*\(input: TerminalSnapshotInput\) => Promise<TerminalSnapshotResult>/);
  assert.match(persistence, /onEvent:\s*\(listener: \(event: TerminalRendererEvent\) => void\) => \(\) => void/);
  assert.match(persistence, /terminal:\s*TerminalApi/);
  assert.doesNotMatch(persistence, /TerminalManager|ChildProcess|IPty|node-pty|Buffer/);
});

async function loadTerminalIpcContracts() {
  let source;
  try {
    source = await readFile(join(root, "electron", "terminalIpcContracts.ts"), "utf8");
  } catch (error) {
    assert.fail(`terminalIpcContracts.ts must exist: ${error.message}`);
  }
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

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function toPlain(value) {
  return JSON.parse(JSON.stringify(value));
}
