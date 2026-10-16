import assert from "node:assert/strict";
import { readFileSync, existsSync } from "node:fs";
import { mkdir, mkdtemp, realpath, rm, writeFile, symlink, link } from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import vm from "node:vm";
import { createSourceModuleLoader } from "./sourceModuleLoader.mjs";

const require = createRequire(import.meta.url);
const ts = require("typescript");
const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");
const now = "2026-09-17T00:00:00.000Z";
const globals = { process, console, Buffer, Error, URL, TextEncoder, TextDecoder, setTimeout, clearTimeout };
// Workspace dependencies must resolve through this checkout's built package exports.
// Missing builds fail the suite; there is no foreign reader or source alias fallback.
const externals = new Map(await Promise.all([
  "@skyturn/project-core", "@skyturn/persistence", "@skyturn/persistence/workflow-store",
  "@skyturn/orchestrator", "@skyturn/agent-bridge/bounded-file-reader",
].map(async (specifier) => [specifier, await import(specifier)])));
const loader = createSourceModuleLoader({ typescript: ts, globals,
  loadExternal(specifier, importer) {
    return externals.get(specifier) ?? createRequire(importer)(specifier);
  },
});
const contracts = externals.get("@skyturn/persistence");
const refs = (name = "notes.txt") => [{ kind: "file", path: name }];
const plain = (value) => JSON.parse(JSON.stringify(value));

function freezeTree(value) {
  if (value && typeof value === "object") {
    Object.values(value).forEach(freezeTree);
    Object.freeze(value);
  }
  return value;
}

function referenceBoundaryFixture() {
  const text = "\ufeff  PRIVATE-SNAPSHOT-MARKER\r\n\t中文\n ";
  const event = { id: "input-event", sessionId: "session", seq: 3, kind: "workflow.user_input", source: "user",
    laneId: null, segmentId: null, causationId: null, correlationId: null, idempotencyKey: "user-input:input", createdAt: now,
    payload: { inputId: "input", text: "  Read these files.\r\n\t ", references: [...refs(), ...refs("context.txt")],
      resolvedReferences: [text, "\t second\r\n "].map((text, index) => ({ kind: "file", path: index ? "context.txt" : "notes.txt", text, byteLength: Buffer.byteLength(text) })) } };
  const legacy = { ...event, id: "legacy", payload: { inputId: "legacy", text: " plain\r\n " } };
  const other = { ...event, id: "other", kind: "workflow.user_decision.answered", payload: { resolvedReferences: "unrelated public data" } };
  const output = { ...event, id: "output", kind: "workflow.segment.output_delta",
    payload: { text: "\ufeff exact public output\r\n\t ", delta: { protocolVersion: 1, timestamp: now, kind: "output", runId: "run", seq: 1,
      payload: { stream: "stdout", text: "\ufeff exact public output\r\n\t ", resolvedReferences: "public output metadata" } } } };
  const delivered = { ...event, id: "delivered", kind: "workflow.user_input.delivered", source: "workflow_store",
    causationId: event.id, payload: { inputId: "input" } };
  const projection = { sessionId: "session", events: [event, legacy, other, output, delivered], lanes: [], segments: [] };
  const canvasSession = { id: "session", projectId: "project", title: "Reference boundary", goal: "Read files", mode: "fast",
    target: { executionTarget: "current_branch", branch: "main" }, createdAt: now, updatedAt: now, kind: "canvas",
    hermesPlannerSessionId: "planner-session", plannerNodeId: "planner", nodes: [], edges: [], activeNodeId: null };
  const nextAction = { kind: "none", reason: "No work." };
  const original = freezeTree({ event, projection, canvasSession, nextAction });
  const expectedEvent = plain(event); delete expectedEvent.payload.resolvedReferences;
  return { ...original, text, expectedEvent, before: JSON.stringify(original) };
}

function loadReferenceBoundaryRuntime(f) {
  const source = readFileSync(path.join(repo, "apps/desktop/electron/main.ts"), "utf8");
  const ast = ts.createSourceFile("main.ts", source, ts.ScriptTarget.Latest, true);
  const functions = ["isRecord", "decorateWorkflowResponseEnvelope", "workflowHandler", "publishedWorkflowStoreIdentity", "broadcastWorkflowProjection"];
  const channels = ["workflow:appendUserInput", "workflow:projection", "workflow:nodePosition:update"];
  const statements = ast.statements.filter(node => ts.isFunctionDeclaration(node) && functions.includes(node.name?.text) ||
    ts.isExpressionStatement(node) && ts.isCallExpression(node.expression) && node.expression.expression?.name?.text === "handle" && channels.includes(node.expression.arguments[0]?.text));
  assert.equal(statements.length, functions.length + channels.length);
  const handlers = new Map(), broadcasts = [], module = { exports: {} };
  const store = { materializeFlowProjection: () => f.projection, materializeWorkflowView: () => ({ projection: f.projection,
    canvasSession: f.canvasSession, loopState: { nextAction: f.nextAction } }), recordCanvasNodePosition: () => f.projection.events[2], buildLedgerSummary: () => ({}) };
  const runtimeModule = loader.load(path.join(repo, "apps/desktop/electron/projectReferenceRuntime.ts"));
  const ipcContracts = loader.load(path.join(repo, "apps/desktop/electron/workflowIpcContracts.ts"));
  vm.runInNewContext(ts.transpileModule(`${statements.map(node => node.getText(ast)).join("\n")}\nmodule.exports = { workflowHandler, broadcastWorkflowProjection };`, {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
  }).outputText, { ...globals, ...runtimeModule, ...ipcContracts, module, RUN_PROTOCOL_VERSION: 1,
    ipcMain: { handle: (channel, handler) => handlers.set(channel, handler) },
    BrowserWindow: { getAllWindows: () => [{ webContents: { send: (channel, value) => broadcasts.push({ channel, value }) } }] },
    workflowStores: new Map([["/project", store]]), planProjectIdentities: { canonicalize: async root => root },
    registerWorkflowStoreOperation: task => Promise.resolve().then(task), assertKnownProjectRoot() {}, assertKnownWorkflowCanvasSession() {},
    assertWorkflowSessionId: id => id, requireText: text => text.trim(), optionalText: text => text?.trim(),
    workflowStoreIdentity: async root => root, withWorkflowSessionMutationLock: async (_root, _session, task) => task(),
    getWorkflowStore: async () => store, requireWorkflowCanvasSession: () => f.canvasSession,
    materializeRendererCanvasSession: () => f.canvasSession, workflowPlannerProjectIdentity: root => root,
    advanceWorkflowSession: async () => {}, normalizeWorkflowNodePositionUpdate: value => value,
    deliverWorkflowUserInputToPlanner: async () => ({ event: f.event, created: true, ownsDelivery: true }),
  });
  return { ...module.exports, handlers, broadcasts, store, runtimeModule };
}

test("renderer snapshot boundary strips only private input snapshots from production responses", async () => {
  const f = referenceBoundaryFixture(), runtime = loadReferenceBoundaryRuntime(f);
  const delta = f.projection.events[3].payload.delta;
  assert.deepEqual(plain(externals.get("@skyturn/project-core").parseRunEvent(delta)), plain(delta));
  const requests = [
    ["workflow:appendUserInput", { sessionId: "session", inputId: "input", text: f.event.payload.text, references: f.event.payload.references }],
    ["workflow:projection", "session"],
    ["workflow:nodePosition:update", { sessionId: "session", nodeId: "node", position: { x: 1, y: 2 } }],
  ];
  for (const [channel, input] of requests) {
    const response = await runtime.handlers.get(channel)({}, "/project", input);
    assert.equal(response.protocolVersion, 1); assert.equal(response.projectRoot, "/project"); assert.equal(response.sessionId, "session");
    assert.deepEqual(plain(response.projection.events[0]), f.expectedEvent, channel);
    assert.equal(Object.hasOwn(response.projection.events[0].payload, "resolvedReferences"), false, channel);
    assert.deepEqual(plain(response.projection.events.slice(1)), plain(f.projection.events.slice(1)));
    assert.equal(response.projection.events[3], f.projection.events[3], "Typed public output must not be rewritten");
    if (channel === "workflow:appendUserInput") assert.deepEqual(plain(response.event), f.expectedEvent);
    if (channel === "workflow:nodePosition:update") assert.equal(response.event, f.projection.events[2]);
    assert.equal(JSON.stringify(response).includes("PRIVATE-SNAPSHOT-MARKER"), false);
  }
  // The common decorator also protects responses without a Canvas envelope.
  const raw = freezeTree({ event: f.event, events: f.projection.events, mutation: { eventId: f.event.id, created: false } });
  const direct = await runtime.workflowHandler(() => raw)({}, "/project");
  assert.deepEqual(plain(direct.event), f.expectedEvent);
  assert.deepEqual(plain(direct.events[0]), f.expectedEvent);
  assert.equal(direct.mutation, raw.mutation);
  const legacy = { event: f.projection.events[1], events: f.projection.events.slice(1) };
  assert.equal(await runtime.workflowHandler(() => legacy)({}, "/project"), legacy);
  const goal = await runtime.runtimeModule.projectReferencePlannerGoal(f.event);
  assert.deepEqual(JSON.parse(goal.slice(goal.lastIndexOf("\n") + 1)).projectFileReferences, plain(f.event.payload.resolvedReferences));
  assert.equal(f.event.payload.resolvedReferences[0].text, f.text);
  assert.equal(JSON.stringify({ event: f.event, projection: f.projection, canvasSession: f.canvasSession, nextAction: f.nextAction }), f.before);
});

test("renderer snapshot boundary protects the actual production workflow broadcast", () => {
  const f = referenceBoundaryFixture(), runtime = loadReferenceBoundaryRuntime(f);
  runtime.broadcastWorkflowProjection("/project", "session", runtime.store);
  assert.equal(runtime.broadcasts.length, 1);
  const { channel, value } = runtime.broadcasts[0];
  assert.equal(channel, "workflow:event"); assert.equal(value.projectRoot, "/project"); assert.equal(value.sessionId, "session");
  assert.equal(value.cause, "workflow-mutation"); assert.equal(value.nextAction, f.nextAction);
  assert.deepEqual(plain(value.projection.events[0]), f.expectedEvent);
  assert.equal(Object.hasOwn(value.projection.events[0].payload, "resolvedReferences"), false);
  assert.deepEqual(plain(value.projection.events.slice(1)), plain(f.projection.events.slice(1)));
  assert.equal(value.projection.events[3], f.projection.events[3]);
  assert.equal(JSON.stringify(value).includes("PRIVATE-SNAPSHOT-MARKER"), false);
  assert.equal(JSON.stringify({ event: f.event, projection: f.projection, canvasSession: f.canvasSession, nextAction: f.nextAction }), f.before);
});

async function fixture(t) {
  const temporary = await realpath(await mkdtemp(path.join(tmpdir(), "skyturn-project-reference-")));
  const root = path.join(temporary, "project"); await mkdir(root);
  const registry = loader.load(path.join(repo, "apps/desktop/electron/planProjectIdentity.ts")).createPlanProjectIdentityRegistry();
  await registry.remember(root);
  const openedProjectRoots = new Set([root]);
  const { createWorkflowStore } = externals.get("@skyturn/persistence/workflow-store");
  let store = createWorkflowStore({ projectRoot: root });
  for (const id of ["session", "other"]) store.createWorkflowSession({ id, projectId: "project", title: id,
    goal: "Read reference", mode: "fast", plannerProfile: "default", transport: "hermes_replay_recovery",
    recoveryReason: "Isolated reference test.", now });
  t.after(async () => { store.close(); await rm(temporary, { recursive: true, force: true }); });
  const input = { projectRoot: root, sessionId: "session", inputId: "input", text: "  Read this.\r\n\t ", references: refs(), now };
  const runtime = () => {
    const filename = path.join(repo, "apps/desktop/electron/projectReferenceRuntime.ts");
    assert.ok(existsSync(filename), "project reference runtime must exist");
    return loader.load(filename).createProjectReferenceRuntime({ openedProjectRoots,
      canonicalizeProjectRoot: (value) => registry.canonicalize(value) });
  };
  return { root, temporary, openedProjectRoots, input, runtime, get store() { return store; },
    reopen() { store.close(); store = createWorkflowStore({ projectRoot: root }); },
    claim(value = input) { return runtime().claimInput({ ...value, store }); } };
}

test("parses bounded canonical descriptors and reuses the shared sensitive-name policy", () => {
  assert.equal(typeof contracts.parseProjectFileReferences, "function");
  for (const value of [null, {}, ["notes.txt"], [{ kind: "run", path: "notes.txt" }],
    [{ kind: "file", path: "notes.txt", text: "untrusted caller bytes" }], Array(9).fill(refs()[0]),
    [...refs(), ...refs()], ...["", "../outside", "/etc/hosts", "C:notes.txt", "a\\b", "a//b", "a/./b", "a/../b",
      "a\u0000b", ".env", ".ＥＮＶ.local", ".netrc", ".ＰＹＰＩＲＣ.backup", "credentials.json", "api_key_backup.json", "serviceaccountreport.json",
      "id_ed25519", "private-key.pem", ".git/config", ".ssh/config", ".codex/config.toml", ".hermes/sessions/session.txt",
      ".claude/settings.json", ".gemini/settings.json", ".openclaw/settings.json", ".agents/memory.md",
      ".config/tool/settings.json", "docs/.ＣＯＤＥＸ/config.toml", "a".repeat(1025)].map(refs)]) {
    assert.throws(() => contracts.parseProjectFileReferences(value), /reference/i);
  }
  assert.deepEqual(plain(contracts.parseProjectFileReferences(refs("docs/service-account-audit-report.json"))),
    refs("docs/service-account-audit-report.json"));
  assert.deepEqual(plain(contracts.parseProjectFileReferences(undefined)), []);
  assert.deepEqual(plain(contracts.parseProjectFileReferences([])), []);
});

test("claims persist exact bounded snapshots and reject identity or content mismatch after reopen", async (t) => {
  const f = await fixture(t);
  const text = "\ufeff  unique-marker\r\n\t中文\n\n ";
  const resolvedReferences = [{ ...refs()[0], text, byteLength: Buffer.byteLength(text) }];
  const input = { ...f.input, resolvedReferences };
  const first = f.store.claimUserInput(input);
  assert.ok(first.event.payload.resolvedReferences, "claim must freeze resolved content");
  assert.deepEqual(plain(first.event.payload.resolvedReferences), resolvedReferences);
  assert.equal(first.event.payload.text, input.text);
  f.reopen();
  assert.equal(f.store.claimUserInput(input).created, false);
  for (const changed of [{ text: input.text.trim() }, { references: refs("other.txt") },
    { resolvedReferences: [{ ...resolvedReferences[0], text: "changed", byteLength: 7 }] }, { references: undefined }]) {
    assert.throws(() => f.store.claimUserInput({ ...input, ...changed }));
  }
  f.store.recordUserInputDelivered(input); f.reopen();
  assert.equal(f.store.claimUserInput(input).ownsDelivery, false);
  const legacy = { sessionId: "session", inputId: "legacy", text: "plain", now };
  assert.deepEqual(plain(f.store.claimUserInput(legacy).event.payload), { inputId: "legacy", text: "plain" });
  assert.equal(f.store.claimUserInput({ ...legacy, references: [] }).created, false);
});

test("resolves only on first submission and replays immutable content after edits, removal and restart", async (t) => {
  const f = await fixture(t); const original = "\ufeff \tunique-reference\r\n中文\n\n ";
  await writeFile(path.join(f.root, "notes.txt"), original);
  const first = await f.claim();
  assert.equal(first.event.payload.resolvedReferences[0].text, original);
  await writeFile(path.join(f.root, "notes.txt"), "new content");
  assert.deepEqual(plain((await f.claim()).event), plain(first.event));
  await rm(path.join(f.root, "notes.txt")); f.reopen();
  assert.deepEqual(plain((await f.claim()).event), plain(first.event));
  for (const changed of [{ text: "other" }, { references: refs("other.txt") }, { references: [] }]) {
    await assert.rejects(f.claim({ ...f.input, ...changed }), /different input/i);
  }
  await assert.rejects(f.claim({ ...f.input, sessionId: "other" }), /missing/i);
  f.openedProjectRoots.clear();
  await assert.rejects(f.claim(), /not open|identity/i);
});

test("rejects unsafe filesystem and content atomically without creating input claims", async (t) => {
  const f = await fixture(t);
  await writeFile(path.join(f.temporary, "outside.txt"), "outside");
  await symlink(f.temporary, path.join(f.root, "escape"));
  await symlink(path.join(f.temporary, "outside.txt"), path.join(f.root, "symlink.txt"));
  await link(path.join(f.temporary, "outside.txt"), path.join(f.root, "hardlink.txt"));
  await mkdir(path.join(f.root, "directory"));
  for (const [name, bytes] of [["invalid.txt", Buffer.from([0xc3, 0x28])], ["binary.txt", Buffer.from([0, 1])],
    ["large.txt", "x".repeat(32 * 1024 + 1)], ["a.txt", "a".repeat(32 * 1024)], ["b.txt", "b".repeat(32 * 1024)],
    ["c.txt", "c"], ["private.txt", "-----BEGIN PRIVATE KEY-----\nsecret material"]]) await writeFile(path.join(f.root, name), bytes);
  for (const value of [null, {}, "notes.txt", ...["missing", "escape/outside.txt", "symlink.txt", "hardlink.txt", "directory", "invalid.txt", "binary.txt", "large.txt", "private.txt"].map(refs),
    [...refs("a.txt"), ...refs("b.txt"), ...refs("c.txt")]]) {
    await assert.rejects(f.claim({ ...f.input, references: value }));
    assert.equal(f.store.listEvents("session").filter((event) => event.kind === "workflow.user_input").length, 0);
  }
  await assert.rejects(f.claim({ ...f.input, sessionId: "missing" }));
});

test("main delivery uses persisted quoted reference data through the real Hermes prompt builder before launch", async (t) => {
  const f = await fixture(t); const marker = " \r\nMARKER-C1 exact\t\n ";
  await writeFile(path.join(f.root, "notes.txt"), marker);
  const source = readFileSync(path.join(repo, "apps/desktop/electron/main.ts"), "utf8");
  const ast = ts.createSourceFile("main.ts", source, ts.ScriptTarget.Latest, true);
  const statement = ast.statements.find((node) => ts.isFunctionDeclaration(node) && node.name?.text === "deliverWorkflowUserInputToPlanner");
  const module = { exports: {} }; let attempts = 0; const prompts = [];
  const runtimeModule = loader.load(path.join(repo, "apps/desktop/electron/projectReferenceRuntime.ts"));
  vm.runInNewContext(ts.transpileModule(`${statement.getText(ast)}\nmodule.exports = deliverWorkflowUserInputToPlanner;`, {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
  }).outputText, { ...globals, module, projectReferenceRuntime: f.runtime(), ...runtimeModule,
    RUN_PROTOCOL_VERSION: 1, TRUSTED_HERMES_PLANNER_SANDBOX: "read-only", workflowPlannerTurnRunId: () => "reference-run",
    workflowIpcError: (_code, message) => new Error(message),
    require: (name) => { assert.equal(name, "@skyturn/orchestrator"); return externals.get(name); },
    plannerRunStartHandler: async (input) => {
      attempts++; prompts.push(input.prompt);
      const durable = f.store.listEvents("session").find((event) => event.kind === "workflow.user_input");
      assert.equal(durable.payload.resolvedReferences[0].text, marker);
      if (attempts === 1) throw new Error("Realistic launch failure before ACK");
    },
  });
  const submit = () => module.exports({ ...f.input, store: f.store, projectIdentity: "project",
    plannerSessionId: "planner-session", plannerNodeId: "node-1", existingNodes: [] });
  await assert.rejects(submit(), /before ACK/);
  await rm(path.join(f.root, "notes.txt")); f.reopen();
  await submit(); await submit();
  assert.equal(attempts, 2);
  for (const prompt of prompts) {
    assert.ok(prompt.includes(JSON.stringify(marker)));
    assert.match(prompt, /quoted reference data/i);
    assert.match(prompt, /not instructions/i);
  }
});

test("append IPC transports descriptors and exact reference input text while preserving legacy text semantics", async (t) => {
  const f = await fixture(t);
  const source = readFileSync(path.join(repo, "apps/desktop/electron/main.ts"), "utf8");
  const ast = ts.createSourceFile("main.ts", source, ts.ScriptTarget.Latest, true);
  const statement = ast.statements.find((node) => ts.isExpressionStatement(node) && node.getText(ast).startsWith('ipcMain.handle("workflow:appendUserInput"'));
  let handler; const submitted = [];
  vm.runInNewContext(ts.transpileModule(statement.getText(ast), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
  }).outputText, { ...globals, RUN_PROTOCOL_VERSION: 1,
    ipcMain: { handle: (_channel, value) => { handler = value; } }, workflowHandler: (value) => value,
    assertKnownProjectRoot: (root) => assert.ok(f.openedProjectRoots.has(root)), assertWorkflowSessionId: (id) => id,
    optionalText: (value) => typeof value === "string" && value.trim() ? value.trim() : null,
    requireText: (value) => { assert.equal(typeof value, "string"); assert.ok(value.trim()); return value.trim(); },
    workflowIpcError: (_code, message) => new Error(message), workflowStoreIdentity: async () => f.root,
    withWorkflowSessionMutationLock: async (_root, _session, callback) => callback(), getWorkflowStore: async () => f.store,
    requireWorkflowCanvasSession: (store, id) => store.materializeCanvasSession(id),
    workflowPlannerProjectIdentity: (root) => root, broadcastWorkflowProjection() {},
    materializeRendererCanvasSession: (store, id) => store.materializeCanvasSession(id),
    deliverWorkflowUserInputToPlanner: async (input) => { submitted.push(input); return { event: {} }; },
  });
  await handler(f.root, f.input);
  assert.equal(submitted[0].text, f.input.text);
  assert.deepEqual(plain(submitted[0].references), f.input.references);
  await handler(f.root, { ...f.input, references: undefined });
  assert.equal(submitted[1].text, f.input.text.trim());
  assert.equal("references" in submitted[1], false);
  await handler(f.root, { ...f.input, references: [] });
  assert.equal(submitted[2].text, f.input.text.trim());
  assert.deepEqual(plain(submitted[2].references), []);
  await assert.rejects(handler(f.root, { ...f.input, resolvedReferences: [] }), /descriptors only/);
  assert.equal(submitted.length, 3);
});
