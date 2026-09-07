import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { mkdir, mkdtemp, realpath, rename, rm, symlink, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import vm from "node:vm";

const require = createRequire(import.meta.url);
const ts = require("typescript");
const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");
const electron = path.join(repo, "apps/desktop/electron");
const modules = new Map();
const compilerOptions = { esModuleInterop: true, module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 };
const globals = { process, Buffer, setTimeout, clearTimeout, URL, TextDecoder, AbortController };

// Load production sources without building the workspace or launching Electron.
function load(file) {
  if (modules.has(file)) return modules.get(file).exports;
  const module = { exports: {} };
  modules.set(file, module);
  const localRequire = (name) => {
    if (name.startsWith("@skyturn/")) return load(path.join(repo, "packages", name.slice(9), "src/index.ts"));
    if (name.startsWith(".")) return load(path.resolve(path.dirname(file), name.replace(/\.js$/, ".ts")));
    return require(name);
  };
  vm.runInNewContext(ts.transpileModule(readFileSync(file, "utf8"), { compilerOptions }).outputText,
    { ...globals, module, exports: module.exports, require: localRequire }, { filename: file });
  return module.exports;
}

async function fixture(t) {
  const temporary = await realpath(await mkdtemp(path.join(tmpdir(), "skyturn-editor-")));
  t.after(() => rm(temporary, { recursive: true, force: true }));
  const root = path.join(temporary, "项目 with spaces");
  await mkdir(root);
  const registry = load(path.join(electron, "planProjectIdentity.ts")).createPlanProjectIdentityRegistry();
  await registry.remember(root);
  const opened = new Set([root]);
  const events = [];
  const launches = [];
  const stores = [];
  const backend = load(path.join(repo, "packages/git-worktree/src/node.ts"));
  const state = {
    platform: "darwin", finderResult: "", loadError: false, storeError: false,
    launcherResult: { exitCode: 0, signal: null, stderr: "", spawnError: null, timedOut: false, outputLimitExceeded: false },
  };
  const source = readFileSync(path.join(electron, "main.ts"), "utf8");
  assert.match(source, /import \{ createEditorRuntime \} from "\.\/editorRuntime"/);
  assert.match(readFileSync(path.join(electron, "preload.ts"), "utf8"),
    /openEditor: \(editor: string, worktreePath: string\) =>\s*ipcRenderer.invoke\("editor:openWorktree", editor, worktreePath\)/);
  const ast = ts.createSourceFile("main.ts", source, ts.ScriptTarget.Latest, true);
  const helperNames = new Set(["managedWorktreeEventsFromStore", "isManagedWorktreeEventKind", "isRecord", "optionalText"]);
  const selected = ast.statements.filter((node) =>
    (ts.isVariableStatement(node) && node.declarationList.declarations.some((entry) => entry.name.getText(ast) === "editorRuntime")) ||
    (ts.isFunctionDeclaration(node) && helperNames.has(node.name?.text)) ||
    (ts.isExpressionStatement(node) && node.getText(ast).startsWith('ipcMain.handle("editor:openWorktree"')),
  ).map((node) => node.getText(ast)).join("\n");
  let handler;
  const runtimeFile = path.join(electron, "editorRuntime.ts");
  vm.runInNewContext(ts.transpileModule(selected, { compilerOptions }).outputText, {
    ...globals,
    ...(existsSync(runtimeFile) ? load(runtimeFile) : {}),
    ipcMain: { handle: (channel, fn) => { assert.equal(channel, "editor:openWorktree"); handler = fn; } },
    openedProjectRoots: opened, planProjectIdentities: registry,
    getWorkflowStore: async (projectRoot) => {
      stores.push(projectRoot);
      if (state.storeError) throw new Error("private store details");
      return { listWorkflowSessionIds: () => ["session"], listEvents: () => events };
    },
    shell: { openPath: async (target) => { launches.push(["finder", target]); return state.finderResult; } },
    require: (name) => {
      assert.equal(name, "@skyturn/git-worktree/node");
      if (state.loadError) throw new Error("private load details");
      return { ...backend, NodeEditorAdapter: class extends backend.NodeEditorAdapter {
        constructor() { super({ platform: state.platform, runLauncher: async (exe, args) => {
          launches.push([exe, ...args]);
          return state.launcherResult;
        } }); }
      } };
    },
  });
  assert.equal(typeof handler, "function", "production IPC must be registered");
  return { temporary, root, registry, opened, events, launches, stores, state,
    open: (editor, target = root) => handler({}, editor, target),
    event: (kind, payload) => events.push({ kind, payload, sessionId: "session", idempotencyKey: `${kind}:${events.length}`, createdAt: "2026-09-07T00:00:00Z" }),
  };
}

function git(root, ...args) {
  return execFileSync("git", ["-c", "user.name=Editor Test", "-c", "user.email=editor@example.invalid",
    "-c", "commit.gpgsign=false", "-C", root, ...args], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
}

async function owned(f) {
  git(f.root, "init", "-b", "main");
  git(f.root, "commit", "--allow-empty", "-m", "fixture");
  const target = path.join(`${f.root}.worktrees`, "session-variant 空格 ");
  git(f.root, "worktree", "add", "-b", "skyturn/session/variant", target);
  const identity = {
    worktreeId: "worktree-session-variant", variantId: "variant", path: target, realPath: target,
    repoRoot: f.root, gitdir: git(target, "rev-parse", "--absolute-git-dir"), branchName: "skyturn/session/variant",
    baseCommit: git(target, "rev-parse", "HEAD"), headCommit: git(target, "rev-parse", "HEAD"), parentLaneId: "lane",
  };
  f.event("workflow.worktree.created", { worktree: identity });
  return identity;
}

test("production IPC dispatches exact non-Git project paths to real adapter and preserves failures", async (t) => {
  const f = await fixture(t);
  for (const [editor, app] of [["vscode", "Visual Studio Code"], ["cursor", "Cursor"], ["zed", "Zed"]]) {
    assert.equal((await f.open(editor)).ok, true);
    assert.deepEqual(f.launches.pop(), ["/usr/bin/open", "-a", app, f.root]);
  }
  const spaced = path.join(f.temporary, " 项目 ");
  await mkdir(spaced);
  await f.registry.remember(spaced);
  f.opened.add(spaced);
  assert.equal((await f.open("vscode", spaced)).ok, true);
  assert.equal(f.launches.pop().at(-1), spaced);
  f.state.launcherResult.exitCode = 1;
  assert.equal((await f.open("vscode")).ok, false);
  f.state.launcherResult.spawnError = { code: "ENOENT", message: "private launch details" };
  const failed = await f.open("cursor");
  assert.equal(failed.ok, false);
  assert.doesNotMatch(failed.message, /private launch details/);
  f.state.platform = "linux";
  f.launches.length = 0;
  assert.match((await f.open("zed")).message, /not supported.*linux/);
  assert.equal(f.launches.length, 0);
  assert.equal(f.stores.length, 0);
});

test("Finder shares authorization and preserves shell.openPath success and error strings", async (t) => {
  const f = await fixture(t);
  assert.equal((await f.open("finder")).ok, true);
  assert.deepEqual(f.launches.pop(), ["finder", f.root]);
  f.state.finderResult = "File manager refused the request.";
  assert.equal((await f.open("finder")).message, f.state.finderResult);
  assert.equal((await f.open("finder")).ok, false);
  f.launches.length = 0;
  assert.equal((await f.open("finder", f.temporary)).ok, false);
  assert.equal(f.launches.length, 0);
});

test("registered project aliases launch canonical paths and fail after retargeting", async (t) => {
  const f = await fixture(t);
  const alias = path.join(f.temporary, "alias");
  await symlink(f.root, alias);
  await f.registry.remember(alias);
  f.opened.clear();
  f.opened.add(alias);
  assert.equal((await f.open("vscode", alias)).ok, true);
  assert.equal(f.launches.pop().at(-1), f.root);
  assert.equal((await f.open("finder", f.root)).ok, true);
  await rm(alias);
  await symlink(f.temporary, alias);
  f.launches.length = 0;
  assert.equal((await f.open("finder", alias)).ok, false);
  assert.equal((await f.open("vscode", f.root)).ok, false);
  assert.equal(f.launches.length, 0);
});

test("invalid editors and paths never launch or initialize unrelated workflow stores", async (t) => {
  const f = await fixture(t);
  const subdir = path.join(f.root, "subdir");
  const file = path.join(f.temporary, "file");
  const sibling = `${f.root}.worktrees-evil/tree`;
  await mkdir(subdir);
  await mkdir(sibling, { recursive: true });
  await writeFile(file, "fixture");
  await f.registry.remember(file);
  f.opened.add(file);
  for (const editor of [undefined, null, {}, "", "terminal", "VSCODE", " finder", "__proto__"]) {
    assert.equal((await f.open(editor)).ok, false);
  }
  for (const target of [null, {}, "", " ", "relative", "file:///tmp", "vscode://tmp", `${f.root}\0`,
    `${f.root}/../${path.basename(f.root)}`, subdir, file, path.join(f.root, "missing"), sibling]) {
    for (const editor of ["vscode", "finder"]) assert.equal((await f.open(editor, target)).ok, false, String(target));
  }
  const alias = path.join(f.temporary, "unregistered-alias");
  await symlink(f.root, alias);
  assert.equal((await f.open("finder", alias)).ok, false);
  await rm(f.root, { recursive: true });
  assert.equal((await f.open("finder")).ok, false);
  assert.equal(f.launches.length, 0);
  assert.equal(f.stores.length, 0);
});

test("owned worktrees require persisted creation plus fresh Git identity and allow advanced HEAD", async (t) => {
  const f = await fixture(t);
  const identity = await owned(f);
  git(identity.path, "commit", "--allow-empty", "-m", "advanced");
  assert.equal((await f.open("zed", identity.path)).ok, true);
  assert.equal(f.launches.pop().at(-1), identity.realPath);
  assert.equal((await f.open("finder", identity.path)).ok, true);
  f.launches.length = 0;
  for (const key of ["gitdir", "branchName", "baseCommit", "repoRoot"]) {
    const original = identity[key];
    identity[key] = key === "repoRoot" ? f.temporary : "wrong";
    assert.equal((await f.open("vscode", identity.path)).ok, false, key);
    identity[key] = original;
  }
  f.event("workflow.worktree.cleaned", { result: { worktreeId: identity.worktreeId } });
  assert.equal((await f.open("vscode", identity.path)).ok, false);
  assert.equal(f.launches.length, 0);
});

test("fake, escaped, removed and recreated worktrees cannot inherit authorization", async (t) => {
  const f = await fixture(t);
  const identity = await owned(f);
  const fake = path.join(`${f.root}.worktrees`, "fake");
  await mkdir(fake);
  assert.equal((await f.open("finder", fake)).ok, false);
  const saved = `${identity.path}-saved`;
  await rename(identity.path, saved);
  await symlink(f.temporary, identity.path);
  assert.equal((await f.open("vscode", identity.path)).ok, false);
  await rm(identity.path);
  await rename(saved, identity.path);
  git(f.root, "worktree", "remove", identity.path);
  assert.equal((await f.open("finder", identity.path)).ok, false);
  await mkdir(identity.path);
  assert.equal((await f.open("vscode", identity.path)).ok, false);
  await rm(identity.path, { recursive: true });
  f.event("workflow.worktree.cleaned", { worktree: identity });
  git(f.root, "worktree", "add", identity.path, identity.branchName);
  assert.equal((await f.open("finder", identity.path)).ok, false);
  assert.equal(f.launches.length, 0);
});

test("authorization and backend load errors return sanitized failures", async (t) => {
  const f = await fixture(t);
  f.state.loadError = true;
  const unavailable = await f.open("vscode");
  assert.equal(unavailable.ok, false);
  assert.doesNotMatch(unavailable.message, /private load details/);
  f.state.loadError = false;
  const identity = await owned(f);
  f.state.storeError = true;
  const denied = await f.open("finder", identity.path);
  assert.equal(denied.ok, false);
  assert.doesNotMatch(denied.message, /private store details/);
  assert.equal(f.launches.length, 0);
});

test("a different repository's real worktree inside the managed root is not owned", async (t) => {
  const f = await fixture(t);
  const identity = await owned(f);
  git(f.root, "worktree", "remove", identity.path);
  const other = path.join(f.temporary, "other-repo");
  await mkdir(other);
  git(other, "init", "-b", "main");
  git(other, "commit", "--allow-empty", "-m", "other fixture");
  git(other, "worktree", "add", "-b", identity.branchName, identity.path);
  identity.gitdir = git(identity.path, "rev-parse", "--absolute-git-dir");
  identity.baseCommit = identity.headCommit = git(identity.path, "rev-parse", "HEAD");
  assert.equal((await f.open("vscode", identity.path)).ok, false);
  assert.equal((await f.open("finder", identity.path)).ok, false);
  assert.equal(f.launches.length, 0);
});
