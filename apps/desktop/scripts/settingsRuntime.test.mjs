import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { chmod, lstat, mkdir, mkdtemp, readFile, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import vm from "node:vm";

const desktopRoot = dirname(dirname(fileURLToPath(import.meta.url)));
const repoRoot = dirname(dirname(desktopRoot));
const require = createRequire(import.meta.url);
const execFileAsync = promisify(execFile);
const maxSettingsBytes = 1024 * 1024;

test("settings persist strict defaults and validated values across restart without executing commands", async () => {
  const { createDefaultSkyTurnSettings, parseSkyTurnSettings } = await loadTypeScriptModule(
    join(repoRoot, "packages", "persistence", "src", "settings.ts"),
  );
  const { createSettingsRuntime } = await loadTypeScriptModule(join(desktopRoot, "electron", "settingsRuntime.ts"));
  const root = await mkdtemp(join(tmpdir(), "skyturn-settings-"));
  const projectRoot = await realpath(await mkdir(join(root, "project"), { recursive: true }).then(() => join(root, "project")));
  const marker = join(root, "command-ran");
  const options = {
    filePath: join(root, "userData", "settings.json"),
    canonicalizeProjectRoot: async (value) => {
      if (value !== projectRoot) throw new Error("Project root is not open in SkyTurn.");
      return realpath(value);
    },
    defaultProjectBranch: async () => "功能/测试",
    createDefaultSettings: createDefaultSkyTurnSettings,
    parseSettings: parseSkyTurnSettings,
  };
  try {
    const runtime = createSettingsRuntime(options);
    const first = await runtime.get(projectRoot);
    assert.deepEqual(plain(first.settings), plain(createDefaultSkyTurnSettings("功能/测试")));
    await runtime.save(projectRoot, first.settings);
    assert.equal((await createSettingsRuntime(options).get(projectRoot)).settings.project.defaultExecutionTarget.selectedBranch, "功能/测试");

    const underscore = plain(first.settings);
    underscore.project.defaultExecutionTarget.selectedBranch = "_feature";
    await runtime.save(projectRoot, underscore);
    assert.equal((await createSettingsRuntime(options).get(projectRoot)).settings.project.defaultExecutionTarget.selectedBranch, "_feature");

    const settings = plain(underscore);
    settings.app.executableOverrides.codex = "/opt/codex-custom";
    settings.app.externalEditor = "zed";
    settings.app.notifications.desktop = true;
    settings.project.commands.test = `${process.execPath} -e "require('node:fs').writeFileSync('${marker}','bad')"`;
    settings.project.defaultExecutionTarget = {
      executionTarget: "new_worktree",
      selectedBranch: "main",
      baseRef: "origin/main",
    };
    await createSettingsRuntime(options).save(projectRoot, settings);

    const reopened = await createSettingsRuntime(options).get(projectRoot);
    assert.deepEqual(plain(reopened.settings), settings);
    await assert.rejects(lstat(marker), { code: "ENOENT" });
    assert.equal((await lstat(options.filePath)).mode & 0o077, 0);
    assert.equal((await readFile(options.filePath, "utf8")).includes("command-ran"), true);
    assert.deepEqual((await readdirSafe(join(root, "userData"))).filter((name) => name.endsWith(".tmp")), []);

    await assert.rejects(
      createSettingsRuntime(options).save(projectRoot, { ...settings, unexpected: true }),
      /Settings input is invalid/,
    );
    await assert.rejects(
      createSettingsRuntime(options).save(projectRoot, {
        ...settings,
        app: { ...settings.app, defaultExecutor: "gemini" },
      }),
      /Settings input is invalid/,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("settings reject malformed persisted data and a registered symlink retarget", { skip: process.platform === "win32" }, async () => {
  const persistence = await loadTypeScriptModule(join(repoRoot, "packages", "persistence", "src", "settings.ts"));
  const { createSettingsRuntime } = await loadTypeScriptModule(join(desktopRoot, "electron", "settingsRuntime.ts"));
  const { createPlanProjectIdentityRegistry } = await loadTypeScriptModule(join(desktopRoot, "electron", "planProjectIdentity.ts"));
  const root = await mkdtemp(join(tmpdir(), "skyturn-settings-symlink-"));
  const first = join(root, "first");
  const second = join(root, "second");
  const link = join(root, "project-link");
  const filePath = join(root, "userData", "settings.json");
  try {
    await mkdir(first);
    await mkdir(second);
    await symlink(first, link);
    const registry = createPlanProjectIdentityRegistry();
    await registry.remember(link);
    await registry.remember(first);
    const runtime = createSettingsRuntime({
      filePath,
      canonicalizeProjectRoot: registry.canonicalize,
      defaultProjectBranch: async () => "main",
      createDefaultSettings: persistence.createDefaultSkyTurnSettings,
      parseSettings: persistence.parseSkyTurnSettings,
    });
    await runtime.get(link);
    await rm(link);
    await symlink(second, link);
    await assert.rejects(runtime.get(link), /Project root is not open in SkyTurn/);

    await mkdir(dirname(filePath), { recursive: true });
    await writeFile(filePath, JSON.stringify({ schemaVersion: 1, app: {}, projects: {}, extra: true }));
    await assert.rejects(runtime.get(first), /Persisted settings are invalid/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("settings accept Git-compatible Unicode and underscore refs and reject unsafe refs", async () => {
  const { createDefaultSkyTurnSettings, parseSkyTurnSettings } = await loadTypeScriptModule(
    join(repoRoot, "packages", "persistence", "src", "settings.ts"),
  );
  for (const ref of ["HEAD", "功能/测试", "_feature", "feature/éclair", "origin/main"]) {
    assert.equal(createDefaultSkyTurnSettings(ref).project.defaultExecutionTarget.selectedBranch, ref);
  }
  for (const ref of [
    "-bad", ".hidden", "foo/.hidden", "foo/bar.lock", "bad..ref", "bad@{ref", "bad ref",
    "bad~ref", "bad^ref", "bad:ref", "bad?ref", "bad*ref", "bad[ref", "bad\\ref",
    "bad.", "bad/", "/bad", "bad//ref", "@",
  ]) {
    assert.throws(() => createDefaultSkyTurnSettings(ref), /Settings input is invalid/);
  }
  const settings = createDefaultSkyTurnSettings("main");
  settings.project.defaultExecutionTarget = {
    executionTarget: "new_worktree",
    selectedBranch: "_feature",
    baseRef: "origin/功能/测试",
  };
  assert.deepEqual(plain(parseSkyTurnSettings(settings).project.defaultExecutionTarget), settings.project.defaultExecutionTarget);
});

test("settings reject an over-limit document before rename and preserve a readable prior state", async () => {
  const persistence = await loadTypeScriptModule(join(repoRoot, "packages", "persistence", "src", "settings.ts"));
  const { createSettingsRuntime } = await loadTypeScriptModule(join(desktopRoot, "electron", "settingsRuntime.ts"));
  const root = await mkdtemp(join(tmpdir(), "skyturn-settings-bytes-"));
  const filePath = join(root, "settings.json");
  const baselineRoot = join(root, "project-baseline");
  const candidateRoot = join(root, "project-over-limit");
  try {
    const baseline = persistence.createDefaultSkyTurnSettings("main");
    baseline.app.externalEditor = "finder";
    baseline.project.commands.start = "before";
    const large = largeSettings(persistence.createDefaultSkyTurnSettings("main"));
    const document = settingsDocument(baseline.app, [[baselineRoot, baseline.project]]);
    for (let index = 0; index < 1024; index += 1) {
      const fillerRoot = join(root, `filler-${index}`);
      document.projects[settingsProjectKey(fillerRoot)] = settingsProjectEntry(fillerRoot, large.project);
      const candidate = structuredClone(document);
      candidate.app = large.app;
      candidate.projects[settingsProjectKey(candidateRoot)] = settingsProjectEntry(candidateRoot, large.project);
      if (Buffer.byteLength(JSON.stringify(candidate, null, 2), "utf8") > maxSettingsBytes) break;
    }
    const fixture = JSON.stringify(document, null, 2);
    assert.ok(Buffer.byteLength(fixture, "utf8") <= maxSettingsBytes);
    await writeFile(filePath, fixture);
    const runtime = createSettingsRuntime(runtimeOptions(filePath, persistence));
    assert.equal((await runtime.get(baselineRoot)).settings.project.commands.start, "before");
    const before = await readFile(filePath);

    await assert.rejects(runtime.save(candidateRoot, large), /capacity/i);
    assert.deepEqual(await readFile(filePath), before);
    const reopened = await createSettingsRuntime(runtimeOptions(filePath, persistence)).get(baselineRoot);
    assert.equal(reopened.settings.app.externalEditor, "finder");
    assert.equal(reopened.settings.project.commands.start, "before");

    reopened.settings.project.commands.start = "after";
    await runtime.save(baselineRoot, reopened.settings);
    assert.equal((await createSettingsRuntime(runtimeOptions(filePath, persistence)).get(baselineRoot)).settings.project.commands.start, "after");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("settings enforce project capacity before rename while allowing updates at capacity", async () => {
  const persistence = await loadTypeScriptModule(join(repoRoot, "packages", "persistence", "src", "settings.ts"));
  const { createSettingsRuntime } = await loadTypeScriptModule(join(desktopRoot, "electron", "settingsRuntime.ts"));
  const root = await mkdtemp(join(tmpdir(), "skyturn-settings-project-capacity-"));
  const filePath = join(root, "settings.json");
  const defaults = persistence.createDefaultSkyTurnSettings("main");
  const entries = Array.from({ length: 1024 }, (_, index) => [join(root, `project-${index}`), defaults.project]);
  const document = settingsDocument(defaults.app, entries);
  try {
    await writeFile(filePath, JSON.stringify(document, null, 2));
    const runtime = createSettingsRuntime(runtimeOptions(filePath, persistence));
    const existingRoot = entries[0][0];
    const before = await readFile(filePath);
    await assert.rejects(runtime.save(join(root, "project-over-capacity"), defaults), /capacity/i);
    assert.deepEqual(await readFile(filePath), before);

    const update = plain((await runtime.get(existingRoot)).settings);
    update.project.commands.build = "pnpm build";
    await runtime.save(existingRoot, update);
    assert.equal((await createSettingsRuntime(runtimeOptions(filePath, persistence)).get(existingRoot)).settings.project.commands.build, "pnpm build");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("missing and unknown configured CLIs can be saved but remain truthful and fail launches", async () => {
  const persistence = await loadTypeScriptModule(join(repoRoot, "packages", "persistence", "src", "settings.ts"));
  const settingsModule = await loadTypeScriptModule(join(desktopRoot, "electron", "settingsRuntime.ts"));
  const { AgentBridge, createCodexCliAdapter, createConfiguredCliAdapter, createDurableRunClaimStore } = await loadAgentBridge();
  const root = await mkdtemp(join(tmpdir(), "skyturn-settings-unready-cli-"));
  const projectRoot = join(root, "project");
  const missingExecutable = join(root, "missing-codex");
  const unknownExecutable = join(root, "unknown-codex");
  try {
    await mkdir(projectRoot);
    await mkdir(join(projectRoot, ".git"));
    await writeUnknownCodex(unknownExecutable);
    const runtime = settingsModule.createSettingsRuntime(runtimeOptions(join(root, "settings.json"), persistence));
    const adapterOptions = (executablePath) => ({
      executablePath,
      sandbox: "danger-full-access",
      codexAuthFilePath: null,
      env: { PATH: process.env.PATH },
    });
    const configured = createConfiguredCliAdapter(
      createCodexCliAdapter(adapterOptions(missingExecutable)),
      async () => createCodexCliAdapter(adapterOptions((await runtime.getAppSettings()).executableOverrides.codex ?? missingExecutable)),
    );
    const claimStore = createDurableRunClaimStore({ root: join(root, "private", "run-claims") });
    await claimStore.initialize();
    const bridge = new AgentBridge({ adapters: [configured], durableRunClaimStore: claimStore, discoveryEnv: { PATH: process.env.PATH }, codexAuthFilePath: null });

    for (const [label, executablePath] of [["missing", missingExecutable], ["unknown", unknownExecutable]]) {
      const settings = persistence.createDefaultSkyTurnSettings("main");
      settings.app.executableOverrides.codex = executablePath;
      const saved = await runtime.save(projectRoot, settings);
      assert.equal((await settingsModule.createSettingsRuntime(runtimeOptions(join(root, "settings.json"), persistence)).get(projectRoot)).settings.app.executableOverrides.codex, executablePath);
      const agents = await bridge.discoverAgents();
      const snapshot = settingsModule.createSettingsSnapshot(saved, { status: "ready", currentBranch: "main", branches: ["main"] }, agents);
      assert.equal(snapshot.prerequisites.defaultExecutorRunnable, false);
      assert.equal(snapshot.prerequisites.agents.find((agent) => agent.kind === "codex").cli, label);

      const runId = `run-${label}`;
      const failed = waitForEvent(bridge, (event) => event.runId === runId && event.kind === "status" && event.payload.status === "failed");
      await bridge.startRun(runInput(projectRoot, runId));
      await failed;
      assert.equal((await bridge.getEvidence(projectRoot, runId)).status, "failed");
    }
    await bridge.close();
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("configured CLI changes affect discovery and new launches while an earlier run remains cancellable and evidenced", async () => {
  const {
    AgentBridge,
    createCodexCliAdapter,
    createConfiguredCliAdapter,
    createDurableRunClaimStore,
  } = await loadAgentBridge();
  const root = await mkdtemp(join(tmpdir(), "skyturn-settings-bridge-"));
  const projectRoot = join(root, "project");
  const launches = join(root, "launches.ndjson");
  const firstExecutable = join(root, "codex-a");
  const secondExecutable = join(root, "codex-b");
  try {
    await mkdir(projectRoot);
    await mkdir(join(projectRoot, ".git"));
    await writeFakeCodex(firstExecutable, "codex-a", launches, true);
    await writeFakeCodex(secondExecutable, "codex-b", launches, false);
    let configuredExecutable = firstExecutable;
    const adapterOptions = (executablePath) => ({
      executablePath,
      sandbox: "danger-full-access",
      codexAuthFilePath: null,
      env: { PATH: process.env.PATH },
    });
    const configured = createConfiguredCliAdapter(
      createCodexCliAdapter(adapterOptions(firstExecutable)),
      async () => createCodexCliAdapter(adapterOptions(configuredExecutable)),
    );
    const claimStore = createDurableRunClaimStore({ root: join(root, "private", "run-claims") });
    await claimStore.initialize();
    const bridge = new AgentBridge({
      adapters: [configured],
      durableRunClaimStore: claimStore,
      discoveryEnv: { PATH: process.env.PATH },
      codexAuthFilePath: null,
    });

    const firstRun = await bridge.startRun(runInput(projectRoot, "run-a"));
    configuredExecutable = secondExecutable;
    const codex = (await bridge.discoverAgents()).find((agent) => agent.kind === "codex");
    assert.equal(codex.executablePath, secondExecutable);
    assert.equal(codex.version, "codex-b 1.0.0");
    assert.equal(codex.readiness.auth.status, "unknown");

    const completed = waitForEvent(bridge, (event) => event.runId === "run-b" && event.kind === "status" && event.payload.status === "succeeded");
    await bridge.startRun(runInput(projectRoot, "run-b"));
    await completed;
    const cancelled = await bridge.cancelRun(firstRun.id, "settings changed");
    assert.equal(cancelled.status, "cancelled");
    assert.equal((await bridge.getEvidence(projectRoot, "run-a")).status, "cancelled");
    assert.deepEqual((await readFile(launches, "utf8")).trim().split("\n"), ["codex-a", "codex-b"]);
    await bridge.close();
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("settings IPC and public Devflow types expose one typed get/save namespace", async () => {
  const [main, preload, contracts, persistence, architecture] = await Promise.all([
    readFile(join(desktopRoot, "electron", "main.ts"), "utf8"),
    readFile(join(desktopRoot, "electron", "preload.ts"), "utf8"),
    readFile(join(desktopRoot, "electron", "settingsIpcContracts.ts"), "utf8"),
    readFile(join(repoRoot, "packages", "persistence", "src", "index.ts"), "utf8"),
    readFile(join(repoRoot, "docs", "architecture.md"), "utf8"),
  ]);
  assert.match(contracts, /get:\s*"settings:get"/);
  assert.match(contracts, /save:\s*"settings:save"/);
  assert.match(main, /planProjectIdentities\.canonicalize/);
  assert.match(main, /createConfiguredCliAdapter/);
  assert.match(main, /codexAuthFilePath:\s*null/);
  assert.match(preload, /const settings = \{[\s\S]*SettingsApi/);
  assert.match(preload, /settings,\s*\n/);
  assert.match(persistence, /export \* from "\.\/settings\.js"/);
  assert.match(persistence, /settings:\s*SettingsApi/);
  assert.match(architecture, /settings:get/);
  assert.doesNotMatch(main, /execFile[^\n]*(startCommand|testCommand|buildCommand)/);
});

function runInput(projectRoot, runId) {
  return { protocolVersion: 1, runId, nodeId: `node-${runId}`, sessionId: "session-1", projectRoot, worktreePath: projectRoot, agentKind: "codex", sandbox: "danger-full-access", prompt: "fixture" };
}

function waitForEvent(bridge, predicate) {
  return new Promise((resolve) => {
    const unsubscribe = bridge.onRunEvent((event) => {
      if (!predicate(event)) return;
      unsubscribe();
      resolve(event);
    });
  });
}

async function writeFakeCodex(target, version, launches, holdOpen) {
  await writeFile(target, [
    "#!/usr/bin/env node",
    "const fs = require('node:fs');",
    `if (process.argv.includes('--version')) { console.log('${version} 1.0.0'); process.exit(0); }`,
    `fs.appendFileSync(${JSON.stringify(launches)}, ${JSON.stringify(`${version}\n`)});`,
    holdOpen
      ? "process.on('SIGTERM', () => process.exit(0)); setInterval(() => {}, 1000);"
      : "process.stdout.write('{\"type\":\"turn.completed\"}\\n');",
  ].join("\n"));
  await chmod(target, 0o755);
}

async function writeUnknownCodex(target) {
  await writeFile(target, [
    "#!/usr/bin/env node",
    "if (process.argv.includes('--version')) process.exit(1);",
    "process.stderr.write('fixture failed\\n');",
    "process.exit(7);",
  ].join("\n"));
  await chmod(target, 0o755);
}

let agentBridgePromise;
async function loadAgentBridge() {
  if (!agentBridgePromise) {
    agentBridgePromise = execFileAsync(join(repoRoot, "node_modules", ".bin", "turbo"), [
      "run", "build", "--filter=@skyturn/agent-bridge",
    ], { cwd: repoRoot, env: process.env }).then(() =>
      import(`../../../packages/agent-bridge/dist/index.js?settings=${Date.now()}`)
    );
  }
  return agentBridgePromise;
}

function runtimeOptions(filePath, persistence) {
  return {
    filePath,
    canonicalizeProjectRoot: async (projectRoot) => projectRoot,
    defaultProjectBranch: async () => "main",
    createDefaultSettings: persistence.createDefaultSkyTurnSettings,
    parseSettings: persistence.parseSkyTurnSettings,
  };
}

function largeSettings(settings) {
  settings.project.commands = { start: "s".repeat(4096), test: "t".repeat(4096), build: "b".repeat(4096) };
  return settings;
}

function settingsDocument(app, entries) {
  return {
    schemaVersion: 1,
    app: plain(app),
    projects: Object.fromEntries(entries.map(([projectRoot, settings]) => [
      settingsProjectKey(projectRoot), settingsProjectEntry(projectRoot, settings),
    ])),
  };
}

function settingsProjectEntry(projectRoot, settings) {
  return { canonicalRootPath: projectRoot, settings: plain(settings) };
}

function settingsProjectKey(projectRoot) {
  return createHash("sha256").update(projectRoot, "utf8").digest("hex");
}

async function loadTypeScriptModule(filePath) {
  const source = await readFile(filePath, "utf8");
  const ts = require("typescript");
  const output = ts.transpileModule(source, {
    compilerOptions: { esModuleInterop: true, module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
  }).outputText;
  const module = { exports: {} };
  vm.runInNewContext(output, { module, exports: module.exports, require, process, Buffer, setTimeout, clearTimeout }, { filename: filePath });
  return module.exports;
}

async function readdirSafe(directory) {
  const { readdir } = await import("node:fs/promises");
  return readdir(directory);
}

function plain(value) {
  return JSON.parse(JSON.stringify(value));
}
