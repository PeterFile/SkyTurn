import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  RUN_EVENT_PROTOCOL_VERSION,
  createCodexCliAdapter,
  createHermesCliAdapter,
} from "../dist/index.js";
import {
  buildWindowsFixtureInvocation,
  formatWindowsFixtureStartFailure,
} from "../dist/internal/windowsProcessTreeIntegrationSupport.js";

if (process.platform !== "win32") {
  throw new Error("Windows process-tree integration tests require Windows.");
}

for (const agentKind of ["codex", "hermes"]) {
  await runProcessTreeCase(agentKind, "cancel");
  await runProcessTreeCase(agentKind, "timeout");
  await runProcessTreeCase(agentKind, "normal-root-exit");
}

console.log("Windows AgentBridge Job Object integration tests passed.");

async function runProcessTreeCase(agentKind, terminalPath) {
  const root = await mkdtemp(join(tmpdir(), `skyturn-${agentKind}-${terminalPath}-`));
  const parentPidPath = join(root, "parent.pid");
  const childPidPath = join(root, "child.pid");
  let parentPid = null;
  let childPid = null;
  let terminalTimer = null;
  try {
    await mkdir(join(root, ".git"));
    const canonicalRoot = await realpath(root);
    const prompt = "Quoted \"prompt\" with trailing slash\\ and Unicode 雪\nsecond line";
    const resumeHandle = "resume \"capability\" with slash\\ and Unicode 水";
    const argumentMarker = "marker \"argument\" with slash\\, spaces, and Unicode 火";
    const stdoutMarker = `stdout-${agentKind}-${terminalPath}-雪`;
    const stderrMarker = `stderr-${agentKind}-${terminalPath}-火`;
    const fixturePath = join(canonicalRoot, "agent-fixture.cjs");
    const invocation = buildWindowsFixtureInvocation({
      agentKind,
      argumentMarker,
      canonicalWorkdir: canonicalRoot,
      prompt,
      resumeHandle,
    });
    const fixture = fixtureSource({
      expectedArgs: invocation.expectedFixtureArgv,
      pathArgumentIndexes: invocation.pathArgumentIndexes,
      stderrMarker,
      stdoutMarker,
      terminalPath,
    });
    await writeFile(fixturePath, fixture, "utf8");
    await writeFile(join(canonicalRoot, invocation.entryPoint), fixtureLauncherSource(), "utf8");
    const events = [];
    let resolveTerminal;
    let rejectTerminal;
    const terminal = new Promise((resolve, reject) => {
      resolveTerminal = resolve;
      rejectTerminal = reject;
    });
    terminalTimer = setTimeout(
      () => rejectTerminal(new Error(`${agentKind} ${terminalPath} terminal event timed out.`)),
      20_000,
    );
    const options = {
      executablePath: process.execPath,
      extraArgs: invocation.extraArgs,
      env: {
        SKYTURN_PARENT_PID_PATH: parentPidPath,
        SKYTURN_CHILD_PID_PATH: childPidPath,
        SKYTURN_WINDOWS_FIXTURE_CJS_PATH: fixturePath,
      },
      timeoutMs: terminalPath === "timeout" ? 1_500 : 20_000,
      killTimeoutMs: 1_000,
      stallTelemetryMs: 0,
    };
    const adapter = agentKind === "codex"
      ? createCodexCliAdapter(options)
      : createHermesCliAdapter(options);
    const handle = await adapter.startRun({
      protocolVersion: RUN_EVENT_PROTOCOL_VERSION,
      runId: `run-${agentKind}-${terminalPath}`,
      nodeId: `node-${agentKind}-${terminalPath}`,
      sessionId: "session-windows-process-tree",
      projectRoot: root,
      worktreePath: root,
      agentKind,
      prompt,
      ...(agentKind === "hermes" ? { hermesSessionHandle: resumeHandle } : {}),
    }, {
      async emit(event) {
        events.push(event);
        if (
          event.kind === "status" &&
          (
            event.payload.status === "cancelled" ||
            event.payload.status === "timed-out" ||
            (terminalPath === "normal-root-exit" && event.payload.status === "failed")
          )
        ) {
          resolveTerminal(event);
        }
        return event;
      },
    });
    const diagnosticInput = {
      agentKind,
      terminalPath,
      events,
      sensitiveValues: [prompt, resumeHandle, argumentMarker, root, canonicalRoot, fixturePath],
    };
    parentPid = Number(await waitForFixtureFile(parentPidPath, "parent.pid", diagnosticInput));
    childPid = Number(await waitForFixtureFile(childPidPath, "child.pid", diagnosticInput));
    assert.ok(isPidAlive(parentPid), `${agentKind} fixture parent did not stay alive.`);
    assert.ok(isPidAlive(childPid), `${agentKind} fixture descendant did not stay alive.`);
    await waitForCondition(
      () => JSON.stringify(events).includes(stdoutMarker) && JSON.stringify(events).includes(stderrMarker),
      `${agentKind} ${terminalPath} output forwarding`,
    );

    const cancellation = terminalPath === "cancel"
      ? handle.cancel("Windows integration cancellation")
      : null;
    const terminalEvent = await terminal;
    clearTimeout(terminalTimer);

    const expectedStatus = terminalPath === "cancel"
      ? "cancelled"
      : terminalPath === "timeout"
        ? "timed-out"
        : "failed";
    assert.equal(terminalEvent.payload.status, expectedStatus);
    assert.equal(isPidAlive(parentPid), false, `${agentKind} parent survived ${terminalPath} resolution.`);
    assert.equal(isPidAlive(childPid), false, `${agentKind} descendant survived ${terminalPath} resolution.`);
    await cancellation;
    assert.equal(JSON.stringify(events).includes(prompt), false, `${agentKind} leaked the raw prompt.`);
    assert.equal(JSON.stringify(events).includes(resumeHandle), false, `${agentKind} leaked the resume capability.`);
    assert.equal(JSON.stringify(events).includes(argumentMarker), false, `${agentKind} leaked the argument marker.`);
    if (terminalPath === "normal-root-exit") {
      const exitEvidence = events.find((event) => event.kind === "evidence" && event.payload.exitCode === 17);
      assert.ok(exitEvidence, `${agentKind} did not preserve the actual root exit code.`);
    }
    assert.equal(
      events.filter((event) => event.kind === "status" && event.payload.status === expectedStatus).length,
      1,
      `${agentKind} emitted an invalid terminal status sequence.`,
    );
  } finally {
    if (terminalTimer) clearTimeout(terminalTimer);
    killPid(parentPid);
    killPid(childPid);
    await rm(root, { recursive: true, force: true });
  }
}

function fixtureLauncherSource() {
  return [
    "const fixturePath = process.env.SKYTURN_WINDOWS_FIXTURE_CJS_PATH;",
    "if (typeof fixturePath !== 'string' || !fixturePath.toLowerCase().endsWith('.cjs')) {",
    "  process.stderr.write('Windows integration fixture path is unavailable.\\n');",
    "  process.exit(1);",
    "}",
    "try {",
    "  require(fixturePath);",
    "} catch {",
    "  process.stderr.write('Windows integration fixture failed to load.\\n');",
    "  process.exit(1);",
    "}",
  ].join("\n");
}

function fixtureSource({ expectedArgs, pathArgumentIndexes, stderrMarker, stdoutMarker, terminalPath }) {
  const supportModuleUrl = new URL("../dist/internal/windowsProcessTreeIntegrationSupport.js", import.meta.url).href;
  return [
    "const { spawn } = require('node:child_process');",
    "const { writeFileSync } = require('node:fs');",
    "void (async () => {",
    `const { validateWindowsFixtureArgv } = await import(${JSON.stringify(supportModuleUrl)});`,
    "validateWindowsFixtureArgv({",
    "  actualArgs: process.argv.slice(2),",
    `  expectedArgs: ${JSON.stringify(expectedArgs)},`,
    `  pathArgumentIndexes: ${JSON.stringify(pathArgumentIndexes)},`,
    "});",
    "writeFileSync(process.env.SKYTURN_PARENT_PID_PATH, String(process.pid));",
    "const child = spawn(process.execPath, ['-e', \"process.on('SIGTERM', () => {}); setInterval(() => {}, 1000)\"], { detached: true, stdio: 'ignore' });",
    "child.unref();",
    "writeFileSync(process.env.SKYTURN_CHILD_PID_PATH, String(child.pid));",
    "process.stdout.write('{\"type\":\"turn.started\"}\\n');",
    `process.stdout.write(${JSON.stringify(`${JSON.stringify({
      type: "item.completed",
      item: { type: "agent_message", text: stdoutMarker },
    })}\n`)});`,
    `process.stderr.write(${JSON.stringify(`${stderrMarker}\n`)});`,
    terminalPath === "normal-root-exit"
      ? "setTimeout(() => process.exit(17), 1000);"
      : "process.on('SIGTERM', () => {}); setInterval(() => {}, 1000);",
    "})().catch((error) => {",
    "  const message = error instanceof Error ? error.message : '';",
    "  const safeMessage = /^Windows fixture argv (?:length mismatch \\(actual \\d+, expected \\d+\\)|mismatch at index \\d+|path identity mismatch at index \\d+)\\.$/.test(message)",
    "    ? message",
    "    : 'Windows fixture setup failed.';",
    "  process.stderr.write(`${safeMessage}\\n`);",
    "  process.exit(1);",
    "});",
  ].join("\n");
}

async function waitForFile(path) {
  const deadline = Date.now() + 10_000;
  for (;;) {
    try {
      return await readFile(path, "utf8");
    } catch (error) {
      if (Date.now() >= deadline) throw error;
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
  }
}

async function waitForFixtureFile(path, missingMarker, diagnosticInput) {
  try {
    return await waitForFile(path);
  } catch {
    throw new Error(formatWindowsFixtureStartFailure({
      ...diagnosticInput,
      missingMarker,
    }));
  }
}

async function waitForCondition(predicate, label) {
  const deadline = Date.now() + 10_000;
  for (;;) {
    if (predicate()) return;
    if (Date.now() >= deadline) throw new Error(`Timed out waiting for ${label}.`);
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
}

function isPidAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function killPid(pid) {
  if (!pid) return;
  try {
    process.kill(pid, "SIGKILL");
  } catch {
    // Best-effort cleanup after a failed assertion.
  }
}
