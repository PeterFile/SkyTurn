import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { mkdir, mkdtemp, readFile, realpath, rename, rm, symlink, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import path from "node:path";
import nodeTest from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";
import vm from "node:vm";

const require = createRequire(import.meta.url);
const test = process.platform === "win32" ? nodeTest.skip : nodeTest;
const ts = require("typescript");
const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");
const electron = path.join(repo, "apps/desktop/electron");
const modules = new Map();
const globals = { process, Buffer, URL, TextDecoder, AbortController, setTimeout, clearTimeout };
const compilerOptions = { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, esModuleInterop: true };
function load(file) {
  if (modules.has(file)) return modules.get(file).exports;
  const module = { exports: {} }; modules.set(file, module);
  const localRequire = (name) => {
    if (name.startsWith("@skyturn/")) {
      const [pkg, subpath] = name.slice(9).split("/");
      const filename = { "workflow-store": "workflowStore", "bounded-file-reader": "boundedFileReader" }[subpath] ?? subpath ?? "index";
      return load(path.join(repo, "packages", pkg, "src", `${filename}.ts`));
    }
    if (name.startsWith(".")) return load(path.resolve(path.dirname(file), name.replace(/\.js$/, ".ts") + (path.extname(name) ? "" : ".ts")));
    return createRequire(file)(name);
  };
  const code = readFileSync(file, "utf8").replaceAll("import.meta.url", JSON.stringify(pathToFileURL(file).href));
  vm.runInNewContext(ts.transpileModule(code, { compilerOptions }).outputText,
    { ...globals, module, exports: module.exports, require: localRequire }, { filename: file });
  return module.exports;
}
const core = () => load(path.join(repo, "packages/project-core/src/index.ts"));
const gitBackend = () => load(path.join(repo, "packages/git-worktree/src/node.ts"));
function git(root, ...args) {
  return execFileSync("git", ["-c", "user.name=Artifact Test", "-c", "user.email=artifact@example.invalid",
    "-c", "commit.gpgsign=false", "-C", root, ...args], { encoding: "utf8" }).trim();
}

async function fixture(t, artifact = ".devflow/acceptance/report.txt", bytes = "Report\n结果\n") {
  const temporary = await realpath(await mkdtemp(path.join(tmpdir(), "skyturn-artifact-view-")));
  t.after(() => rm(temporary, { recursive: true, force: true }));
  const root = path.join(temporary, "project"); await mkdir(root);
  git(root, "init", "-b", "main"); git(root, "commit", "--allow-empty", "-m", "fixture");
  const head = git(root, "rev-parse", "HEAD");
  await mkdir(path.dirname(path.join(root, artifact)), { recursive: true });
  await writeFile(path.join(root, artifact), bytes);
  const registry = load(path.join(electron, "planProjectIdentity.ts")).createPlanProjectIdentityRegistry();
  await registry.remember(root);
  const request = { projectRoot: root, sessionId: "session", nodeId: "lane", runId: "run", artifactPath: artifact };
  const events = [
    { protocolVersion: 1, runId: "run", seq: 1, timestamp: "2026-09-17T00:00:01Z", kind: "evidence", payload: { artifacts: [artifact], exitCode: 0 } },
    { protocolVersion: 1, runId: "run", seq: 2, timestamp: "2026-09-17T00:00:02Z", kind: "status", payload: { status: "succeeded", exitCode: 0 } },
  ];
  const evidence = core().deriveRunEvidenceFromRunEvents({ runId: "run", events });
  const ancestryProof = await gitBackend().createWorkflowGitAncestryProof({ repositoryPath: root, worktreePath: root, beforeHeadCommit: head, afterHeadCommit: head });
  const checkpoint = { sessionId: "session", nodeId: "lane", laneId: "lane", segmentId: "segment", runId: "run",
    executionTarget: "current_branch", worktreePath: root, branchName: "main", headCommit: head, source: "backend",
    createdAt: "2026-09-17T00:00:02Z", evidenceRefs: [{ kind: "run", id: "run" }] };
  const state = {
    projection: { sessionId: "session", lanes: [{ id: "lane", agentKind: "codex", executable: true, status: "completed" }],
      laneRollbackStatuses: {}, segments: [{ id: "segment", laneId: "lane", runId: "run", status: "succeeded", exitCode: 0 }],
      evidence: [{ id: "evidence", laneId: "lane", segmentId: "segment", runEvidence: evidence }], worktrees: [] },
    checkpoints: [{ ...checkpoint, id: "before", phase: "before" }, { ...checkpoint, id: "after", phase: "after", ancestryProof }],
    claim: { runId: "run", sessionId: "session", nodeId: "lane", agentKind: "codex" },
    events, reads: 0, beforeRead: undefined,
  };
  const openedProjectRoots = new Set([root]);
  const store = {
    materializeFlowProjection: (sessionId) => sessionId === "session" ? state.projection : null,
    listNodeCheckpoints: () => state.checkpoints,
  };
  const deps = {
    openedProjectRoots, canonicalizeProjectRoot: (value) => registry.canonicalize(value),
    getStore: async (value) => { assert.equal(value, root); return store; },
    readRunEvents: async (value, runId) => {
      state.reads++; await state.beforeRead?.(); assert.equal(value, root);
      return runId === "run" ? state.events : [];
    },
  };
  deps.readRunAuthority = async (root, runId) => ({ claim: state.claim, events: await deps.readRunEvents(root, runId) });
  const runtimeFile = path.join(electron, "artifactViewRuntime.ts");
  const view = async (input = request) => {
    assert.ok(existsSync(runtimeFile), "artifact viewer runtime must be implemented");
    return load(runtimeFile).createArtifactViewRuntime(deps).read(input);
  };
  return { temporary, root, request, state, deps, store, openedProjectRoots, view, head, ancestryProof };
}

test("returns registered exact UTF-8 text and metadata through fresh runtime instances", async (t) => {
  const f = await fixture(t);
  const first = await f.view();
  assert.equal(first.ok, true, JSON.stringify(first));
  assert.equal(first.artifact.name, "report.txt");
  assert.equal(first.artifact.type, "txt");
  assert.equal(first.artifact.status, "succeeded");
  assert.equal(first.artifact.runId, "run");
  assert.equal(first.content.text, "Report\n结果\n");
  assert.equal(first.content.encoding, "utf8");
  assert.equal(first.contentIdentity, "current-file-unhashed");
  assert.equal(JSON.stringify(await f.view()), JSON.stringify(first));
});

test("rejects hostile requests, traversal, credentials and renderer paths before authority access", async (t) => {
  const f = await fixture(t);
  for (const input of [null, [], {}, { ...f.request, worktreePath: f.root }, { ...f.request, runId: "run\0" },
    ...["../report.txt", "/etc/passwd", ".devflow/acceptance/../report.txt", ".devflow/acceptance/token.json",
      ".devflow/acceptance/aws.credentials.json", ".devflow/acceptance/a\\b.txt"].map((artifactPath) => ({ ...f.request, artifactPath }))]) {
    assert.equal((await f.view(input)).ok, false);
  }
  assert.equal(f.state.reads, 0);
  assert.equal((await f.view({ ...f.request, projectRoot: f.temporary })).code, "UNKNOWN_PROJECT");
});

test("rejects unknown scope, unregistered paths, absent private evidence and conflicting terminal evidence", async (t) => {
  const f = await fixture(t);
  for (const key of ["sessionId", "nodeId", "runId"]) assert.equal((await f.view({ ...f.request, [key]: "other" })).ok, false);
  await writeFile(path.join(f.root, ".devflow/acceptance/other.txt"), "exists only");
  assert.equal((await f.view({ ...f.request, artifactPath: ".devflow/acceptance/other.txt" })).code, "UNREGISTERED_ARTIFACT");
  f.state.events = [];
  assert.equal((await f.view()).code, "EVIDENCE_UNAVAILABLE");
  f.state.events = [{ protocolVersion: 1, runId: "run", seq: 1, timestamp: "2026-09-17T00:00:02Z", kind: "status", payload: { status: "failed" } }];
  assert.equal((await f.view()).code, "EVIDENCE_UNAVAILABLE");
});

test("rejects stale runs, rollback, checkpoint scope mismatch and worktree escapes", async (t) => {
  const f = await fixture(t);
  f.state.projection.segments.push({ id: "new", laneId: "lane", runId: "new", status: "running" });
  assert.equal((await f.view()).code, "STALE_ARTIFACT"); f.state.projection.segments.pop();
  f.state.projection.laneRollbackStatuses.lane = "rolled_back";
  assert.equal((await f.view()).code, "STALE_ARTIFACT"); delete f.state.projection.laneRollbackStatuses.lane;
  f.state.checkpoints[1].segmentId = "other";
  assert.equal((await f.view()).code, "BINDING_UNAVAILABLE"); f.state.checkpoints[1].segmentId = "segment";
  for (const checkpoint of f.state.checkpoints) checkpoint.worktreePath = f.temporary;
  assert.equal((await f.view()).code, "OUTSIDE_ROOT");
});

test("detects missing, symlink, unsupported format and stale Git HEAD", async (t) => {
  const f = await fixture(t);
  const target = path.join(f.root, f.request.artifactPath);
  await rm(target); assert.equal((await f.view()).code, "MISSING");
  await writeFile(path.join(f.temporary, "outside"), "private");
  await symlink(path.join(f.temporary, "outside"), target);
  assert.equal((await f.view()).code, "UNSAFE_FILE");
  await rm(target); await writeFile(target, "report");
  git(f.root, "commit", "--allow-empty", "-m", "changed head");
  assert.equal((await f.view()).code, "STALE_ARTIFACT");
});

test("enforces text byte boundaries and rejects UTF-8 errors, binary and credentials without leaking content", async (t) => {
  const f = await fixture(t);
  const target = path.join(f.root, f.request.artifactPath);
  await writeFile(target, "x".repeat(256 * 1024));
  assert.equal((await f.view()).content.text.length, 256 * 1024);
  await writeFile(target, "x".repeat(256 * 1024 + 1));
  assert.equal((await f.view()).code, "OVERSIZE");
  for (const content of [Buffer.from([0xff]), Buffer.from([0]), "api_key=privateSecretValue", "-----BEGIN PRIVATE KEY-----\nprivateSecretValue"]) {
    await writeFile(target, content);
    const result = await f.view(); assert.equal(result.ok, false);
    assert.equal(JSON.stringify(result).includes("privateSecretValue"), false);
    assert.equal("content" in result, false);
  }
});

test("supports PNG and JSON; rejects HTML, SVG, mismatched images and excessive image dimensions", async (t) => {
  const png = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=", "base64");
  const f = await fixture(t, ".devflow/acceptance/screenshot.png", png);
  const result = await f.view(); assert.equal(result.ok, true, JSON.stringify(result));
  assert.equal(result.content.mimeType, "image/png"); assert.equal(result.content.base64, png.toString("base64"));
  await writeFile(path.join(f.root, f.request.artifactPath), "<svg onload='alert(1)'/>");
  assert.equal((await f.view()).code, "UNSUPPORTED_CONTENT");
  const giant = Buffer.from(png); giant.writeUInt32BE(9000, 16);
  await writeFile(path.join(f.root, f.request.artifactPath), giant);
  assert.equal((await f.view()).code, "OVERSIZE");
  const invalidHeader = Buffer.from(png); invalidHeader[12] |= 0x80;
  await writeFile(path.join(f.root, f.request.artifactPath), invalidHeader);
  assert.equal((await f.view()).code, "UNSUPPORTED_CONTENT");
  await writeFile(path.join(f.root, f.request.artifactPath), Buffer.concat([png.subarray(0, 33), png.subarray(8)]));
  assert.equal((await f.view()).code, "UNSUPPORTED_CONTENT");
  await writeFile(path.join(f.root, f.request.artifactPath), Buffer.alloc(8 * 1024 * 1024 + 1));
  assert.equal((await f.view()).code, "OVERSIZE");
  for (const [name, content, expected] of [["report.json", '{"passed":true}', true], ["report.json", "{broken", false],
    ["report.json", '{"api\\u005fkey":"privateSecretValue"}', false],
    ["report.md", "# Report\n<b>literal text</b>", true], ["report.html", "<b>report</b>", false], ["report.svg", "<svg/>", false]]) {
    const other = await fixture(t, `.devflow/acceptance/${name}`, content);
    assert.equal((await other.view()).ok, expected);
  }
});

test("rechecks authority during read and suppresses already-read content on revocation", async (t) => {
  const f = await fixture(t);
  f.state.beforeRead = () => { if (f.state.reads === 2) f.openedProjectRoots.clear(); };
  const result = await f.view();
  assert.equal(result.ok, false); assert.equal("content" in result, false);
});

test("requires private run claim to bind the exact session, node, run and agent", async (t) => {
  const f = await fixture(t);
  for (const key of ["sessionId", "nodeId", "runId", "agentKind"]) {
    const before = f.state.claim[key]; f.state.claim[key] = "other";
    assert.equal((await f.view()).code, "SCOPE_MISMATCH");
    f.state.claim[key] = before;
  }
  f.state.claim = null;
  assert.equal((await f.view()).code, "EVIDENCE_UNAVAILABLE");
});

test("production main and preload wire the read-only IPC contract", async (t) => {
  const f = await fixture(t);
  const source = readFileSync(path.join(electron, "main.ts"), "utf8");
  const ast = ts.createSourceFile("main.ts", source, ts.ScriptTarget.Latest, true);
  const selected = ast.statements.filter((node) =>
    (ts.isVariableStatement(node) && node.declarationList.declarations.some((entry) => entry.name.getText(ast) === "artifactViewRuntime")) ||
    (ts.isExpressionStatement(node) && node.getText(ast).startsWith('ipcMain.handle("artifact:read"')),
  ).map((node) => node.getText(ast)).join("\n");
  let handler;
  vm.runInNewContext(ts.transpileModule(selected, { compilerOptions }).outputText, {
    ...globals, createArtifactViewRuntime: load(path.join(electron, "artifactViewRuntime.ts")).createArtifactViewRuntime,
    openedProjectRoots: f.openedProjectRoots, planProjectIdentities: { canonicalize: f.deps.canonicalizeProjectRoot },
    workflowStores: new Map([[f.root, f.store]]), workflowStoreInitializations: new Map(),
    workflowStoreIdentity: async (root) => root,
    path, app: { getPath: () => path.join(f.temporary, "private") },
    require: (name) => {
      assert.equal(name, "@skyturn/agent-bridge");
      return {
        createDurableRunClaimStore: () => ({ read: async () => ({ kind: "valid", claim: f.state.claim }) }),
        createPrivateRunEventStore: () => ({ read: async () => ({ kind: "valid", events: f.state.events }) }),
      };
    },
    ipcMain: { handle: (channel, value) => { assert.equal(channel, "artifact:read"); handler = value; } },
  });
  assert.equal(typeof handler, "function", "artifact IPC must be registered");
  assert.equal((await handler({}, f.request)).ok, true);
  const preload = readFileSync(path.join(electron, "preload.ts"), "utf8");
  const preloadAst = ts.createSourceFile("preload.ts", preload, ts.ScriptTarget.Latest, true);
  const declaration = preloadAst.statements.find((node) => ts.isVariableStatement(node) &&
    node.declarationList.declarations.some((entry) => entry.name.getText(preloadAst) === "artifacts"));
  assert.ok(declaration, "preload must expose typed artifacts API");
  const module = { exports: {} };
  vm.runInNewContext(ts.transpileModule(`${declaration.getText(preloadAst)}\nmodule.exports = artifacts;`, { compilerOptions }).outputText, {
    module, ipcRenderer: { invoke: (channel, request) => { assert.equal(channel, "artifact:read"); return handler({}, request); } },
  });
  assert.equal((await module.exports.read(f.request)).ok, true);
  assert.match(preload, /exposeInMainWorld\("devflow", \{\s*artifacts,/);
});

test("reads after real SQLite and private event-store reopen, never from the project mirror", async (t) => {
  const f = await fixture(t);
  const { createWorkflowStore } = load(path.join(repo, "packages/persistence/src/workflowStore.ts"));
  let store = createWorkflowStore({ projectRoot: f.root });
  t.after(() => store.close());
  store.createWorkflowSession({ id: "session", projectId: "project", title: "Reports", goal: "Write report", mode: "fast",
    plannerProfile: "default", transport: "hermes_replay_recovery", recoveryReason: "Isolated test fixture.", target: { executionTarget: "current_branch", selectedBranch: "main" },
    now: "2026-09-17T00:00:00Z" });
  store.applyWorkflowIntent({ intentId: "intent", sessionId: "session", operations: [{ type: "ProposeLanes", lanes: [
    { id: "lane", kind: "implementation", title: "Write report", agentKind: "codex" },
  ] }] }, "2026-09-17T00:00:00Z");
  const scheduled = store.scheduleReadyLanes("session", { allowedParallelism: 1, now: "2026-09-17T00:00:01Z" }).readyLanes;
  assert.equal(scheduled.length, 1);
  const { runId, segmentId } = scheduled[0];
  f.request.runId = runId;
  const events = f.state.events.map((event) => ({ ...event, runId }));
  const evidence = core().deriveRunEvidenceFromRunEvents({ runId, events });
  const checkpoint = { sessionId: "session", nodeId: "lane", laneId: "lane", segmentId, runId,
    executionTarget: "current_branch", worktreePath: f.root, branchName: "main", headCommit: f.head,
    evidenceRefs: [{ kind: "run", id: runId }], now: "2026-09-17T00:00:01Z" };
  store.recordRunCheckpoint({ ...checkpoint, phase: "before" });
  store.recordRunResult({ sessionId: "session", laneId: "lane", segmentId, runId, agentKind: "codex", evidence, now: "2026-09-17T00:00:02Z" });
  const proofInput = { repositoryPath: f.root, worktreePath: f.root, beforeHeadCommit: f.head, afterHeadCommit: f.head };
  store.recordRunCheckpoint({ ...checkpoint, phase: "after", ancestryProof: f.ancestryProof,
    ancestryProofContext: await gitBackend().createLiveWorkflowGitAncestryProofContext(proofInput), now: "2026-09-17T00:00:02Z" });
  const { createDurableRunClaimStore } = load(path.join(repo, "packages/agent-bridge/src/durableRunClaim.ts"));
  const { createPrivateRunEventStore } = load(path.join(repo, "packages/agent-bridge/src/privateRunEventStore.ts"));
  const claimRoot = path.join(f.temporary, "private");
  const claims = createDurableRunClaimStore({ root: claimRoot });
  await claims.prepare(f.root);
  await claims.publish(f.root, { runId, sessionId: "session", nodeId: "lane", agentKind: "codex",
    startFingerprint: "a".repeat(64), startedAt: "2026-09-17T00:00:00Z" });
  let privateStore = createPrivateRunEventStore({ durableRunClaimStore: claims });
  for (const event of events) await privateStore.append(f.root, event);
  f.deps.getStore = async () => store;
  f.deps.readRunEvents = async (root, id) => {
    const read = await privateStore.read(root, id); return read.kind === "valid" ? read.events : [];
  };
  f.deps.readRunAuthority = async (root, id) => {
    const claim = await createDurableRunClaimStore({ root: claimRoot }).read(root, id);
    return { claim: claim.kind === "valid" ? claim.claim : null, events: await f.deps.readRunEvents(root, id) };
  };
  const first = await f.view(); assert.equal(first.ok, true, JSON.stringify(first));
  store.close(); store = createWorkflowStore({ projectRoot: f.root });
  privateStore = createPrivateRunEventStore({ durableRunClaimStore: createDurableRunClaimStore({ root: claimRoot }) });
  assert.equal(JSON.stringify(await f.view()), JSON.stringify(first));
  const eventPath = await privateStore.eventPath(f.root, runId);
  await rename(eventPath, `${eventPath}.removed`);
  const mirror = path.join(f.root, ".devflow/runs", runId, "events.ndjson");
  await mkdir(path.dirname(mirror), { recursive: true });
  await writeFile(mirror, events.map((event) => JSON.stringify(event)).join("\n"));
  assert.equal((await f.view()).code, "EVIDENCE_UNAVAILABLE");
});

test("reads only the checkpoint-bound managed Git worktree and refuses cleaned identities", async (t) => {
  const f = await fixture(t);
  const target = path.join(`${f.root}.worktrees`, "candidate");
  await mkdir(path.dirname(target));
  git(f.root, "worktree", "add", "-b", "candidate", target, "HEAD");
  await mkdir(path.dirname(path.join(target, f.request.artifactPath)), { recursive: true });
  await writeFile(path.join(target, f.request.artifactPath), "Candidate report");
  const identity = { worktreeId: "wt", variantId: "variant", path: target, realPath: target, repoRoot: f.root,
    gitdir: (await readFile(path.join(target, ".git"), "utf8")).trim().slice(8), branchName: "candidate",
    baseCommit: f.head, headCommit: f.head, parentLaneId: "lane" };
  f.state.projection.worktrees = [identity];
  for (const checkpoint of f.state.checkpoints) Object.assign(checkpoint, { executionTarget: "new_worktree", worktreeId: "wt", worktreePath: target, branchName: "candidate" });
  f.state.checkpoints[1].ancestryProof = await gitBackend().createWorkflowGitAncestryProof({
    repositoryPath: f.root, worktreePath: target, beforeHeadCommit: f.head, afterHeadCommit: f.head,
  });
  assert.equal((await f.view()).content.text, "Candidate report");
  f.state.projection.events = [{ kind: "workflow.worktree.cleaned", payload: { result: { worktreeId: "wt" } } }];
  assert.equal((await f.view()).code, "STALE_ARTIFACT");
  f.state.projection.events = [];
  identity.repoRoot = f.temporary;
  assert.equal((await f.view()).code, "OUTSIDE_ROOT");
});

test("accepts bounded baseline JPEG and rejects JPEG without a scan", async (t) => {
  // Minimal framing fixture; image decoding remains the renderer's image decoder's job.
  const jpeg = Buffer.from("ffd8ffc0000b080001000101011100ffda0008010100003f0000ffd9", "hex");
  const f = await fixture(t, ".devflow/acceptance/screenshot.jpg", jpeg);
  const result = await f.view(); assert.equal(result.ok, true, JSON.stringify(result));
  assert.equal(result.artifact.type, "jpeg"); assert.equal(result.content.mimeType, "image/jpeg");
  assert.equal(result.content.width, 1);
  await writeFile(path.join(f.root, f.request.artifactPath), Buffer.from("ffd8ffc0000b080001000101011100ffd9", "hex"));
  assert.equal((await f.view()).code, "UNSUPPORTED_CONTENT");
});
