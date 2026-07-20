import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import {
  AgentBridge,
  RUN_EVENT_PROTOCOL_VERSION,
  createDurableRunClaimStore,
  createHermesCliAdapter,
} from "@skyturn/agent-bridge";
import { createWorkflowStore } from "@skyturn/persistence/workflow-store";

import { recoverTerminalWorkflowRuns } from "../dist-electron/electron/workflowRunRecovery.js";

const requireFromPersistence = createRequire(import.meta.resolve("@skyturn/persistence/workflow-store"));
const Database = requireFromPersistence("better-sqlite3");

test("production Desktop materialization receives physically upgraded historical output", async () => {
  const projectRoot = await mkdtemp(join(tmpdir(), "skyturn-historical-workflow-output-"));
  const content = "  historical Desktop output\r\n\tline two  \n\n";
  let store;
  try {
    store = seedRunningStore(projectRoot);
    const segmentId = "segment-session-1-lane-implementation";
    const runId = "run-session-1-lane-implementation";
    const inserted = store.appendWorkflowEvent({
      sessionId: "session-1",
      kind: "workflow.segment.output_delta",
      source: "codex",
      laneId: "lane-implementation",
      segmentId,
      idempotencyKey: "historical-desktop-output",
      payload: {
        laneId: "lane-implementation",
        segmentId,
        delta: {
          protocolVersion: 1,
          runId,
          seq: 1,
          timestamp: "2026-07-15T00:00:03.000Z",
          kind: "output",
          payload: { text: "typed before migration" },
        },
      },
      now: "2026-07-15T00:00:03.000Z",
    });
    store.close();
    store = undefined;

    const databasePath = join(projectRoot, ".devflow", "skyturn-workflow.sqlite");
    const legacy = new Database(databasePath);
    legacy.prepare("UPDATE workflow_events SET payload_json = ? WHERE id = ?").run(JSON.stringify({
      laneId: "lane-implementation",
      segmentId,
      text: content,
      compatibilitySource: "legacy-disk",
    }), inserted.id);
    legacy.prepare("DELETE FROM schema_migrations WHERE version = 6").run();
    legacy.pragma("wal_checkpoint(TRUNCATE)");
    legacy.close();

    store = createWorkflowStore({ projectRoot });
    const outputEvent = store.listEvents("session-1").find((event) => event.id === inserted.id);
    const projection = store.materializeFlowProjection("session-1");
    const canvasSession = store.materializeCanvasSession("session-1");
    const desktopPayload = { projectRoot, sessionId: "session-1", projection, canvasSession };
    const lane = projection.lanes.find((candidate) => candidate.id === "lane-implementation");
    const node = desktopPayload.canvasSession?.nodes.find((candidate) => candidate.id === "lane-implementation");

    assert.equal(outputEvent?.payload.text, content);
    assert.deepEqual(outputEvent?.payload.delta, {
      protocolVersion: 1,
      runId,
      seq: inserted.seq,
      timestamp: inserted.createdAt,
      kind: "output",
      payload: { text: content },
    });
    assert.equal(Object.hasOwn(outputEvent?.payload ?? {}, "compatibilitySource"), false);
    assert.deepEqual(lane?.output, [content]);
    assert.deepEqual(lane?.outputDeltas, [outputEvent?.payload.delta]);
    assert.deepEqual(node?.output, [content]);
    assert.deepEqual(node?.outputDeltas, [outputEvent?.payload.delta]);

    const raw = new Database(databasePath, { readonly: true });
    const payloadJson = raw.prepare("SELECT payload_json FROM workflow_events WHERE id = ?").pluck().get(inserted.id);
    raw.close();
    assert.doesNotMatch(payloadJson, /compatibilitySource/);
  } finally {
    store?.close();
    await rm(projectRoot, { recursive: true, force: true });
  }
});

test("production Electron recovery preserves typed AgentBridge output through SQLite and Desktop materialization", async () => {
  const projectRoot = await mkdtemp(join(tmpdir(), "skyturn-lossless-workflow-output-"));
  const claimRoot = await mkdtemp(join(tmpdir(), "skyturn-lossless-workflow-claims-"));
  const content = "  first\r\n\tsecond  \n\n";
  const progress = "  progress\r\n\tthird  \n\n";
  const sensitive = "  patch\r\n\tAPI_KEY=nested-secret cwd=/Users/alice/private/repo  \n\n";
  const expectedSensitive = "  patch\r\n\tAPI_KEY=[redacted] cwd=[redacted-path]  \n\n";
  const input = runInput(projectRoot);
  let store;
  try {
    store = seedRunningStore(projectRoot);
    const bridge = new AgentBridge({
      durableRunClaimStore: createDurableRunClaimStore({ root: claimRoot }),
      adapters: [{
        kind: "codex",
        async detect() {
          throw new Error("Discovery is not part of this test.");
        },
        async startRun(_input, sink) {
          await sink.emit({
            kind: "output",
            payload: {
              text: content,
              patch: { body: sensitive },
              diff: { lines: [sensitive] },
              code: { body: sensitive },
            },
          });
          await sink.emit({
            kind: "progress",
            payload: { source: "codex", phase: "running", text: progress },
          });
          await sink.emit({
            kind: "evidence",
            payload: {
              exitCode: 0,
              checks: [{ kind: "run-exit", name: "Agent exit", status: "passed" }],
            },
          });
          await sink.emit({ kind: "status", payload: { status: "succeeded", exitCode: 0 } });
          return { async cancel() {} };
        },
      }],
    });
    await bridge.startRun(input);

    await recoverTerminalWorkflowRuns(
      projectRoot,
      store,
      bridge,
      (events) => events
        .filter((event) => event.kind === "output" && typeof event.payload?.text === "string")
        .map((event) => event.payload.text)
        .join(""),
    );
    store.close();
    store = undefined;

    const reopened = createWorkflowStore({ projectRoot });
    store = reopened;
    const outputEvents = reopened.listEvents("session-1")
      .filter((event) => event.kind === "workflow.segment.output_delta");
    const projection = reopened.materializeFlowProjection("session-1");
    const canvasSession = reopened.materializeCanvasSession("session-1");
    const desktopPayload = { projectRoot, sessionId: "session-1", projection, canvasSession };
    const lane = projection.lanes.find((candidate) => candidate.id === "lane-implementation");
    const node = canvasSession?.nodes.find((candidate) => candidate.id === "lane-implementation");

    assert.deepEqual(outputEvents.map((event) => event.payload.text), [content, progress]);
    assert.deepEqual(lane?.output, [content, progress]);
    assert.deepEqual(node?.output, [content, progress]);
    assert.deepEqual(desktopPayload.canvasSession?.nodes.find((candidate) => candidate.id === "lane-implementation")?.output, [content, progress]);
    assert.deepEqual(outputEvents[0]?.payload.delta?.payload, {
      text: content,
      patch: { body: expectedSensitive },
      diff: { lines: [expectedSensitive] },
      code: { body: expectedSensitive },
    });
    assert.deepEqual(lane?.outputDeltas, outputEvents.map((event) => event.payload.delta));
    assert.deepEqual(node?.outputDeltas, outputEvents.map((event) => event.payload.delta));
    assert.deepEqual(
      desktopPayload.canvasSession?.nodes.find((candidate) => candidate.id === "lane-implementation")?.outputDeltas,
      outputEvents.map((event) => event.payload.delta),
    );
    const publicBytes = JSON.stringify({ outputEvents, projection, canvasSession, desktopPayload });
    assert.doesNotMatch(publicBytes, /nested-secret|alice|private\/repo/);
    assert.match(publicBytes, /\[redacted\]/);
  } finally {
    store?.close();
    await rm(projectRoot, { recursive: true, force: true });
    await rm(claimRoot, { recursive: true, force: true });
  }
});

test("production Electron recovery keeps evidence-only summaries out of Canvas Output across replay and reopen", async () => {
  const projectRoot = await mkdtemp(join(tmpdir(), "skyturn-metadata-only-workflow-output-"));
  const claimRoot = await mkdtemp(join(tmpdir(), "skyturn-metadata-only-workflow-claims-"));
  const input = runInput(projectRoot);
  let store;
  try {
    store = seedRunningStore(projectRoot);
    const bridge = new AgentBridge({
      durableRunClaimStore: createDurableRunClaimStore({ root: claimRoot }),
      adapters: [{
        kind: "codex",
        async detect() {
          throw new Error("Discovery is not part of this test.");
        },
        async startRun(_input, sink) {
          await sink.emit({
            kind: "evidence",
            payload: {
              exitCode: 0,
              checks: [{ kind: "run-exit", name: "Agent exit", status: "passed" }],
            },
          });
          await sink.emit({ kind: "status", payload: { status: "succeeded", exitCode: 0 } });
          return { async cancel() {} };
        },
      }],
    });
    await bridge.startRun(input);

    const summarize = () => "Generated compact recovery summary.";
    await recoverTerminalWorkflowRuns(projectRoot, store, bridge, summarize);
    const eventsAfterFirstRecovery = store.listEvents("session-1");
    await recoverTerminalWorkflowRuns(projectRoot, store, bridge, summarize);
    assert.deepEqual(store.listEvents("session-1"), eventsAfterFirstRecovery);
    store.close();
    store = undefined;

    const reopened = createWorkflowStore({ projectRoot });
    store = reopened;
    const outputEvents = reopened.listEvents("session-1")
      .filter((event) => event.kind === "workflow.segment.output_delta");
    const projection = reopened.materializeFlowProjection("session-1");
    const canvasSession = reopened.materializeCanvasSession("session-1");
    const desktopPayload = { projectRoot, sessionId: "session-1", projection, canvasSession };
    const lane = projection.lanes.find((candidate) => candidate.id === "lane-implementation");
    const node = canvasSession?.nodes.find((candidate) => candidate.id === "lane-implementation");
    const evidenceEvent = reopened.listEvents("session-1")
      .find((event) => event.kind === "workflow.evidence.recorded");

    assert.deepEqual(outputEvents, []);
    assert.deepEqual(lane?.output, []);
    assert.equal(lane?.outputDeltas, undefined);
    assert.deepEqual(node?.output, []);
    assert.equal(node?.outputDeltas, undefined);
    assert.deepEqual(
      desktopPayload.canvasSession?.nodes.find((candidate) => candidate.id === "lane-implementation")?.output,
      [],
    );
    assert.equal(evidenceEvent?.payload.summary, "Generated compact recovery summary.");
    assert.doesNotMatch(JSON.stringify({
      outputEvents,
      laneOutput: lane?.output,
      nodeOutput: node?.output,
      desktopOutput: desktopPayload.canvasSession?.nodes.find((candidate) => candidate.id === "lane-implementation")?.output,
    }), /Run succeeded|compact recovery summary/);

    const reopenedEvents = reopened.listEvents("session-1");
    await recoverTerminalWorkflowRuns(projectRoot, reopened, bridge, summarize);
    assert.deepEqual(reopened.listEvents("session-1"), reopenedEvents);
  } finally {
    store?.close();
    await rm(projectRoot, { recursive: true, force: true });
    await rm(claimRoot, { recursive: true, force: true });
  }
});

test("production Hermes recovery redacts ambiguous literal escapes before every Desktop surface", async () => {
  const projectRoot = await mkdtemp(join(tmpdir(), "skyturn-ambiguous-hermes-output-"));
  const claimRoot = await mkdtemp(join(tmpdir(), "skyturn-ambiguous-hermes-claims-"));
  const binRoot = await mkdtemp(join(tmpdir(), "skyturn-ambiguous-hermes-bin-"));
  const hermesPath = join(binRoot, "hermes");
  const argvPath = join(binRoot, "argv.json");
  const rawHandle = "nOpaque-\\n-\\t-\\u1234-literal-\\\\-AMBIGUOUS-CAPABILITY-\\";
  const spacedPaths = [
    "/Users/alice/Stealth Roadmap/output.png",
    "C:/Users/alice/Acquisition Target/results.json",
  ];
  const input = runInput(projectRoot, "hermes");
  let store;
  try {
    await writeFile(
      hermesPath,
      [
        "#!/usr/bin/env node",
        "const fs = require('node:fs');",
        "const args = process.argv.slice(2);",
        "const handle = args[args.indexOf('--resume') + 1];",
        "if (handle !== process.env.SKYTURN_EXPECTED_HANDLE) process.exit(9);",
        "fs.writeFileSync(process.env.SKYTURN_ARGV_PATH, JSON.stringify(args));",
        "const wait = () => new Promise((resolve) => setTimeout(resolve, 25));",
        "(async () => {",
        "  process.stdout.write(`raw ${handle} after-raw\\n`);",
        "  await wait();",
        "  process.stdout.write('before\\\\');",
        "  await wait();",
        "  process.stderr.write(`${handle} after-leading\\n`);",
        "  await wait();",
        "  process.stdout.write(handle);",
        "  await wait();",
        "  process.stderr.write('n-public-after-ending\\n');",
        "  process.stdout.write(`cwd=${JSON.parse(process.env.SKYTURN_SPACED_PATHS)[0]}\\n`);",
        "  await wait();",
        "  const windowsPath = JSON.parse(process.env.SKYTURN_SPACED_PATHS)[1];",
        "  const split = Math.floor(windowsPath.length / 2);",
        "  process.stdout.write(`repo=${windowsPath.slice(0, split)}`);",
        "  await wait();",
        "  process.stderr.write(`${windowsPath.slice(split)}\\r\\n`);",
        "})();",
      ].join("\n"),
      { mode: 0o755 },
    );
    store = seedRunningStore(projectRoot, "hermes");
    const liveEvents = [];
    const bridge = new AgentBridge({
      durableRunClaimStore: createDurableRunClaimStore({ root: claimRoot }),
      adapters: [createHermesCliAdapter({
        executablePath: hermesPath,
        env: {
          SKYTURN_ARGV_PATH: argvPath,
          SKYTURN_EXPECTED_HANDLE: rawHandle,
          SKYTURN_SPACED_PATHS: JSON.stringify(spacedPaths),
        },
      })],
    });
    bridge.onRunEvent((event) => liveEvents.push(event));
    const completed = new Promise((resolve) => {
      const unsubscribe = bridge.onRunEvent((event) => {
        if (event.runId !== input.runId || event.kind !== "status" || event.payload.status !== "succeeded") return;
        unsubscribe();
        resolve(event);
      });
    });
    await bridge.startRun({ ...input, hermesSessionHandle: rawHandle });
    await completed;
    await recoverTerminalWorkflowRuns(
      projectRoot,
      store,
      bridge,
      (events) => events
        .filter((event) => (event.kind === "output" || event.kind === "progress") && typeof event.payload?.text === "string")
        .map((event) => event.payload.text)
        .join(""),
    );
    store.close();
    store = undefined;

    const reopened = createWorkflowStore({ projectRoot });
    store = reopened;
    const events = await bridge.loadEvents(projectRoot, input.runId);
    const persistedBytes = await readFile(join(projectRoot, ".devflow", "runs", input.runId, "events.ndjson"), "utf8");
    const taskOutput = await readFile(join(projectRoot, ".devflow", "tasks", input.nodeId, "output.md"), "utf8");
    const workflowEvents = reopened.listEvents("session-1");
    const projection = reopened.materializeFlowProjection("session-1");
    const canvasSession = reopened.materializeCanvasSession("session-1");
    const desktopPayload = { projectRoot, sessionId: "session-1", projection, canvasSession };
    const publicBytes = JSON.stringify({ liveEvents, events, workflowEvents, projection, canvasSession, desktopPayload });
    const outputTextFrom = (runEvents) => runEvents
      .filter((event) => (event.kind === "output" || event.kind === "progress") && typeof event.payload?.text === "string")
      .map((event) => event.payload.text)
      .join("");
    const liveOutputText = outputTextFrom(liveEvents);
    const outputText = outputTextFrom(events);

    assert.deepEqual(JSON.parse(await readFile(argvPath, "utf8")).slice(-2), ["--resume", rawHandle]);
    assert.equal(outputText, liveOutputText);
    for (const token of ["after-raw", "after-leading", "n-public-after-ending", "cwd=", "repo="]) {
      assert.ok(outputText.includes(token), `Expected sanitized output to retain ${token}.`);
    }
    assert.equal(outputText.match(/\[redacted\]/g)?.length, 3);
    assert.equal(outputText.match(/\[redacted-path\]/g)?.length, 2);
    for (const surface of [persistedBytes, taskOutput, publicBytes]) {
      assert.doesNotMatch(surface, /AMBIGUOUS-CAPABILITY|nOpaque|literal-/);
      for (const component of ["alice", "Stealth Roadmap", "output.png", "Acquisition Target", "results.json"]) {
        assert.doesNotMatch(surface, new RegExp(component));
      }
    }
    assert.match(publicBytes, /\[redacted\]/);
    assert.deepEqual(
      desktopPayload.canvasSession?.nodes.find((candidate) => candidate.id === "lane-implementation")?.output,
      reopened.materializeFlowProjection("session-1").lanes.find((candidate) => candidate.id === "lane-implementation")?.output,
    );
  } finally {
    store?.close();
    await rm(projectRoot, { recursive: true, force: true });
    await rm(claimRoot, { recursive: true, force: true });
    await rm(binRoot, { recursive: true, force: true });
  }
});

function runInput(projectRoot, agentKind = "codex") {
  return {
    protocolVersion: RUN_EVENT_PROTOCOL_VERSION,
    runId: "run-session-1-lane-implementation",
    nodeId: "lane-implementation",
    sessionId: "session-1",
    projectRoot,
    worktreePath: projectRoot,
    agentKind,
    prompt: "Persist exact output",
  };
}

function seedRunningStore(projectRoot, agentKind = "codex") {
  const store = createWorkflowStore({ projectRoot });
  store.createWorkflowSession({
    id: "session-1",
    projectId: "project-lossless",
    title: "Lossless output",
    goal: "Preserve output bytes",
    mode: "fast",
    plannerProfile: "default",
    transport: "hermes_replay_recovery",
    recoveryReason: "Test setup has no live Hermes session.",
    now: "2026-07-15T00:00:00.000Z",
  });
  store.appendWorkflowEvent({
    sessionId: "session-1",
    kind: "workflow.lane.declared",
    source: "test",
    idempotencyKey: "lane:implementation",
    payload: {
      lane: {
        id: "lane-implementation",
        semanticKey: "lane-implementation",
        kind: "implementation",
        title: "Implement",
        agentKind,
        status: "pending",
      },
    },
    now: "2026-07-15T00:00:01.000Z",
  });
  store.scheduleReadyLanes("session-1", {
    allowedParallelism: 1,
    now: "2026-07-15T00:00:02.000Z",
  });
  return store;
}
