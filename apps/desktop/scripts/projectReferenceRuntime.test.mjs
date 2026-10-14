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
  "@skyturn/persistence", "@skyturn/persistence/workflow-store",
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
