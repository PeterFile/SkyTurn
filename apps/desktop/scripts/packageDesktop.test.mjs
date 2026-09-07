import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { cp, lstat, mkdtemp, mkdir, readFile, readlink, rm, symlink, writeFile, chmod } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

const scriptPath = join(dirname(fileURLToPath(import.meta.url)), "packageDesktop.mjs");
const smokeScriptPath = join(dirname(fileURLToPath(import.meta.url)), "packageDesktopSmoke.mjs");

let packaging;
try {
  packaging = await import("./packageDesktop.mjs");
} catch {}

test("renderer assets must be relative for file URLs", () => {
  assert.ok(packaging, "packageDesktop.mjs must provide the packaging validators");
  assert.doesNotThrow(() =>
    packaging.assertRelativeRendererAssets(
      '<script type="module" src="./assets/index.js"></script><link href="./assets/index.css">',
    ),
  );
  assert.throws(
    () => packaging.assertRelativeRendererAssets('<script type="module" src="/assets/index.js"></script>'),
    /absolute renderer asset URL/,
  );
});

test("build metadata records pinned inputs without checkout paths", () => {
  assert.equal(typeof packaging.createBuildMetadata, "function", "createBuildMetadata must be implemented");
  const metadata = packaging.createBuildMetadata({
    version: "0.1.0",
    electronVersion: "41.5.1",
    platform: "darwin",
    arch: "x64",
    sourceRevision: "2d719b1fcdd57d331a27802e53a46fc94c28135b",
    sourceDirty: true,
    lockfileSha256: "a".repeat(64),
  });

  assert.deepEqual(metadata, {
    schemaVersion: 1,
    productName: "SkyTurn",
    version: "0.1.0",
    electronVersion: "41.5.1",
    platform: "darwin",
    arch: "x64",
    sourceRevision: "2d719b1fcdd57d331a27802e53a46fc94c28135b",
    sourceDirty: true,
    lockfileSha256: "a".repeat(64),
    dependencySource: "pnpm-lock.yaml",
    signed: false,
  });
  assert.doesNotMatch(JSON.stringify(metadata), /Volumes|Users|workspaceRoot/);
});

test("payload validation enforces runtime-only files, helpers, and contained links", async (t) => {
  assert.equal(typeof packaging.validatePayload, "function", "validatePayload must be implemented");
  const root = await mkdtemp(join(tmpdir(), "skyturn-package-test-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  await createPayloadFixture(root);

  await assert.doesNotReject(() => packaging.validatePayload(root, { inspectNativeArchitecture: false }));

  const privatePath = join(root, ".devflow");
  await mkdir(privatePath);
  await assert.rejects(
    () => packaging.validatePayload(root, { inspectNativeArchitecture: false }),
    /private or development payload/,
  );
  await rm(privatePath, { recursive: true });

  const sourcePath = join(root, "node_modules/@skyturn/agent-bridge/src");
  await mkdir(sourcePath);
  await assert.rejects(
    () => packaging.validatePayload(root, { inspectNativeArchitecture: false }),
    /workspace package contains non-runtime files/,
  );
  await rm(sourcePath, { recursive: true });

  const outside = await mkdtemp(join(tmpdir(), "skyturn-package-outside-"));
  t.after(() => rm(outside, { recursive: true, force: true }));
  const escapingLink = join(root, "node_modules/escaping-link");
  await symlink(outside, escapingLink);
  await assert.rejects(
    () => packaging.validatePayload(root, { inspectNativeArchitecture: false }),
    /link escapes packaged payload/,
  );
});

test("staging pins direct dependencies and inventories conflicting third-party versions", async (t) => {
  assert.equal(typeof packaging.createRuntimeManifest, "function", "createRuntimeManifest must be implemented");
  assert.equal(typeof packaging.collectThirdPartyLicenses, "function", "collectThirdPartyLicenses must be implemented");
  const root = await mkdtemp(join(tmpdir(), "skyturn-package-deps-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  await createPayloadFixture(root);
  for (const version of ["1.0.0", "2.0.0"]) {
    const dependencyRoot = join(root, `node_modules/.pnpm/example@${version}/node_modules/example`);
    await mkdir(dependencyRoot, { recursive: true });
    await writeFile(
      join(dependencyRoot, "package.json"),
      `${JSON.stringify({ name: "example", version, license: "MIT" })}\n`,
    );
    await writeFile(join(dependencyRoot, "LICENSE"), `example ${version}\n`);
  }
  const fixtureRoot = join(root, "node_modules/.pnpm/example@1.0.0/node_modules/example/test/node_modules/beep-boop");
  await mkdir(fixtureRoot, { recursive: true });
  await writeFile(join(fixtureRoot, "package.json"), '{"name":"beep-boop","version":"1.2.3"}\n');

  const manifest = await packaging.createRuntimeManifest(
    {
      name: "@skyturn/desktop",
      version: "0.1.0",
      productName: "SkyTurn",
      main: "dist-electron/electron/main.js",
      dependencies: { "@skyturn/agent-bridge": "workspace:*", "better-sqlite3": "^12.10.1" },
      devDependencies: { electron: "41.5.1" },
    },
    root,
  );
  assert.deepEqual(manifest.dependencies, {
    "@skyturn/agent-bridge": "0.1.0",
    "better-sqlite3": "12.10.1",
  });
  assert.equal(manifest.productName, "SkyTurn");
  assert.equal("devDependencies" in manifest, false);

  const licenses = await packaging.collectThirdPartyLicenses(root);
  assert.deepEqual(
    licenses.filter((entry) => entry.name === "example").map((entry) => `${entry.name}@${entry.version}`),
    ["example@1.0.0", "example@2.0.0"],
  );
  assert.equal(licenses.some((entry) => entry.name === "beep-boop"), false);
  assert.ok(licenses.every((entry) => entry.license && Array.isArray(entry.licenseFiles)));
});

test("workspace staging removes source and development configuration", async (t) => {
  assert.equal(typeof packaging.trimWorkspacePackages, "function", "trimWorkspacePackages must be implemented");
  const root = await mkdtemp(join(tmpdir(), "skyturn-package-trim-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  await createPayloadFixture(root);
  const bridgeRoot = join(root, "node_modules/@skyturn/agent-bridge");
  const nestedRoot = join(root, "node_modules/.pnpm/project-core/node_modules/@skyturn/project-core");
  const selfLink = join(root, "node_modules/.pnpm/node_modules/@skyturn/desktop");
  await mkdir(join(nestedRoot, "dist"), { recursive: true });
  await mkdir(dirname(selfLink), { recursive: true });
  await symlink(tmpdir(), selfLink);
  await Promise.all([
    mkdir(join(bridgeRoot, "src")),
    writeFile(join(bridgeRoot, "tsconfig.json"), "{}\n"),
    writeFile(join(bridgeRoot, "README.md"), "development notes\n"),
    writeFile(join(nestedRoot, "package.json"), '{"name":"@skyturn/project-core","version":"0.1.0"}\n'),
    writeFile(join(nestedRoot, "tsconfig.json"), "{}\n"),
  ]);

  await packaging.trimWorkspacePackages(root);

  assert.deepEqual((await readdirNames(bridgeRoot)).sort(), ["dist", "package.json"]);
  assert.deepEqual((await readdirNames(nestedRoot)).sort(), ["dist", "package.json"]);
  await assert.rejects(() => lstat(selfLink), /ENOENT/);
});

test("dependency staging excludes published nanoid agent metadata while retaining the runtime closure", async (t) => {
  assert.equal(typeof packaging.excludePrivateDependencyPayloads, "function");
  const root = await mkdtemp(join(tmpdir(), "skyturn-package-private-deps-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  await createPayloadFixture(root);
  // Match the published nanoid@3.3.12 package-root .claude layout with synthetic contents.
  const nanoidRoot = join(root, "node_modules/.pnpm/nanoid@3.3.12/node_modules/nanoid");
  const privateRoot = join(nanoidRoot, ".claude");
  await mkdir(privateRoot, { recursive: true });
  await writeFile(join(privateRoot, "package.json"), "unreadable synthetic agent metadata", { mode: 0o000 });
  const retained = new Map([
    [join(nanoidRoot, "package.json"), '{"name":"nanoid","version":"3.3.12","license":"MIT"}\n'],
    [join(nanoidRoot, "LICENSE"), "synthetic license fixture\n"],
    [join(nanoidRoot, "index.js"), "export const nanoid = () => 'fixture';\n"],
    [join(nanoidRoot, "src/runtime.js"), "export const runtime = true;\n"],
    [join(nanoidRoot, "test/fixture.js"), "export const fixture = true;\n"],
    [join(nanoidRoot, ".envoy"), "unrelated dotfile\n"],
    [join(root, "node_modules/vite/package.json"), '{"name":"vite","version":"8.0.16"}\n'],
    [join(root, "node_modules/vite/dist/node/index.js"), "export const createServer = () => {};\n"],
    [join(root, "node_modules/@rolldown/binding-darwin-x64/rolldown-binding.darwin-x64.node"), "synthetic native transform binding\n"],
    [join(root, "node_modules/better-sqlite3/build/Release/better_sqlite3.node"), "fixture"],
  ]);
  for (const [path, contents] of retained) {
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, contents);
  }
  const nanoidLink = join(root, "node_modules/nanoid");
  await symlink(".pnpm/nanoid@3.3.12/node_modules/nanoid", nanoidLink);

  await packaging.excludePrivateDependencyPayloads(root);
  await packaging.trimWorkspacePackages(root);

  await assert.rejects(() => lstat(privateRoot), /ENOENT/);
  for (const [path, contents] of retained) assert.equal(await readFile(path, "utf8"), contents);
  assert.equal(await readlink(nanoidLink), ".pnpm/nanoid@3.3.12/node_modules/nanoid");
  const licenses = await packaging.collectThirdPartyLicenses(root);
  assert.deepEqual(licenses.find((entry) => entry.name === "nanoid"), {
    name: "nanoid", version: "3.3.12", license: "MIT",
    licenseFiles: ["node_modules/.pnpm/nanoid@3.3.12/node_modules/nanoid/LICENSE"],
  });
  await assert.doesNotReject(() => packaging.validatePayload(root, { inspectNativeArchitecture: false }));
});

test("dependency exclusions use forbidden names at any depth, independent of package identity", async (t) => {
  assert.equal(typeof packaging.excludePrivateDependencyPayloads, "function");
  const root = await mkdtemp(join(tmpdir(), "skyturn-package-private-names-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  await createPayloadFixture(root);
  const dependencyRoot = join(root, "node_modules/.pnpm/example@9.8.7/node_modules/example/nested");
  await mkdir(dependencyRoot, { recursive: true });
  const directoryNames = [".git", ".devflow", ".codex", ".claude", ".gemini", ".hermes"];
  const fileNames = ["AGENTS.md", "CLAUDE.md", "GEMINI.md", ".env", ".env.production"];
  for (const name of directoryNames) {
    await mkdir(join(dependencyRoot, name));
    await writeFile(join(dependencyRoot, name, "package.json"), "not JSON", { mode: 0o000 });
  }
  for (const name of fileNames) await writeFile(join(dependencyRoot, name), "synthetic fixture", { mode: 0o000 });

  await packaging.excludePrivateDependencyPayloads(root);

  assert.deepEqual(await readdirNames(dependencyRoot), []);
  await assert.doesNotReject(() => packaging.validatePayload(root, { inspectNativeArchitecture: false }));
  for (const path of [join(dependencyRoot, ".claude"), join(root, "dist/.env.local")]) {
    await writeFile(path, "synthetic injected payload");
    if (path.includes("dist/")) await packaging.excludePrivateDependencyPayloads(root);
    await assert.rejects(
      () => packaging.validatePayload(root, { inspectNativeArchitecture: false }),
      /private or development payload/,
    );
    await rm(path);
  }
});

test("dependency exclusions preserve escaped and dangling links for final rejection", async (t) => {
  assert.equal(typeof packaging.excludePrivateDependencyPayloads, "function");
  const root = await mkdtemp(join(tmpdir(), "skyturn-package-dep-links-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const stage = join(root, "stage");
  const outside = join(root, "outside");
  await createPayloadFixture(stage);
  await mkdir(join(outside, ".claude"), { recursive: true });
  const sentinel = join(outside, ".claude/keep");
  await writeFile(sentinel, "outside fixture");
  const linkPath = join(stage, "node_modules/linked-package");
  for (const [target, error] of [[outside, /link escapes/], [join(outside, "missing"), /ENOENT/]]) {
    await symlink(target, linkPath);
    await packaging.excludePrivateDependencyPayloads(stage);
    assert.equal(await readlink(linkPath), target);
    await assert.rejects(() => packaging.validatePayload(stage, { inspectNativeArchitecture: false }), error);
    await assert.rejects(() => packaging.assertContainedSymlinks(stage), error);
    assert.equal(await readFile(sentinel, "utf8"), "outside fixture");
    await rm(linkPath);
  }
  await symlink(".", linkPath);
  await assert.doesNotReject(() => packaging.excludePrivateDependencyPayloads(stage));
  assert.equal(await readlink(linkPath), ".");
});

test("dependency exclusions refuse linked roots and links hidden inside excluded payloads", async (t) => {
  assert.equal(typeof packaging.excludePrivateDependencyPayloads, "function");
  const root = await mkdtemp(join(tmpdir(), "skyturn-package-exclusion-links-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const stage = join(root, "stage");
  const outside = join(root, "outside");
  await mkdir(stage);
  await mkdir(join(outside, "node_modules/.claude"), { recursive: true });
  const sentinel = join(outside, "node_modules/.claude/keep");
  await writeFile(sentinel, "outside fixture");
  const stageLink = join(root, "stage-link");
  await symlink(outside, stageLink);
  await assert.rejects(() => packaging.excludePrivateDependencyPayloads(stageLink), /real director/);
  const modules = join(stage, "node_modules");
  await symlink(join(outside, "node_modules"), modules);
  await assert.rejects(() => packaging.excludePrivateDependencyPayloads(stage), /real director/);
  await rm(modules);
  await mkdir(modules);
  for (const name of [".claude", "example/.claude/nested-link"]) {
    const path = join(modules, name);
    await mkdir(dirname(path), { recursive: true });
    for (const target of [outside, join(outside, "missing"), modules]) {
      await symlink(target, path);
      await assert.rejects(() => packaging.excludePrivateDependencyPayloads(stage), /symbolic link.*excluded payload/i);
      assert.equal(await readlink(path), target);
      assert.equal(await readFile(sentinel, "utf8"), "outside fixture");
      await rm(path);
    }
  }
});

test("dependency exclusion traversal bounds depth even inside a forbidden directory", async (t) => {
  assert.equal(typeof packaging.excludePrivateDependencyPayloads, "function");
  const root = await mkdtemp(join(tmpdir(), "skyturn-package-exclusion-depth-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const privateRoot = join(root, "node_modules/example/.claude");
  await mkdir(join(privateRoot, ...Array(65).fill("nested")), { recursive: true });
  await assert.rejects(() => packaging.excludePrivateDependencyPayloads(root), /traversal limit/);
  assert.equal((await lstat(privateRoot)).isDirectory(), true);
});

test("packaging entrypoint documents the pinned current-host artifact command", () => {
  const result = spawnSync(process.execPath, [scriptPath, "--help"], { encoding: "utf8" });
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /SkyTurn\.app/);
  assert.match(result.stdout, /Electron 41\.5\.1/);
  assert.match(result.stdout, /unsigned macOS current-host/);
});

test("installed-app smoke entrypoint documents real file and preload IPC checks", () => {
  const result = spawnSync(process.execPath, [smokeScriptPath, "--help"], { encoding: "utf8" });
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /file:\/\//);
  assert.match(result.stdout, /preload workspace IPC/);
  assert.match(result.stdout, /better-sqlite3/);
});

test("native rebuild is rooted inside staging and cannot walk checkout node_modules", () => {
  assert.equal(typeof packaging.createNativeRebuildOptions, "function");
  assert.deepEqual(packaging.createNativeRebuildOptions("/isolated/stage"), {
    buildPath: "/isolated/stage",
    projectRootPath: "/isolated/stage",
    electronVersion: "41.5.1",
    arch: process.arch,
    force: true,
    onlyModules: ["better-sqlite3"],
    mode: "sequential",
    buildFromSource: true,
  });
});

test("SQLite smoke resolves the workspace package through its bundled pnpm realpath", async () => {
  const source = await readFile(smokeScriptPath, "utf8");
  assert.match(source, /realpathSync\([^)]*persistence\/package\.json/);
});

test("Packager preserves the validated internal pnpm symlink graph", async () => {
  const source = await readFile(scriptPath, "utf8");
  assert.match(source, /derefSymlinks:\s*false/);
});

test("the app bundle retains Electron and Chromium license notices", async () => {
  const source = await readFile(scriptPath, "utf8");
  assert.match(source, /LICENSE\.electron\.txt/);
  assert.match(source, /LICENSES\.chromium\.html/);
});

test("Vite is deployed as an exact production runtime dependency", async () => {
  const manifest = JSON.parse(await readFile(join(dirname(dirname(scriptPath)), "package.json"), "utf8"));
  assert.equal(manifest.dependencies.vite, "^8.0.16");
  assert.equal(manifest.devDependencies.vite, undefined);
});

test("installed app copying preserves relative links and rejects rewritten source links", async (t) => {
  assert.equal(typeof packaging.copyAppVerbatim, "function", "copyAppVerbatim must be implemented");
  assert.equal(typeof packaging.assertContainedSymlinks, "function", "assertContainedSymlinks must be implemented");
  const root = await mkdtemp(join(tmpdir(), "skyturn-copy-regression-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const source = join(root, "source");
  const badCopy = join(root, "bad-copy");
  const goodCopy = join(root, "good-copy");
  await mkdir(source);
  await writeFile(join(source, "target"), "fixture\n");
  await symlink("target", join(source, "link"));

  await cp(source, badCopy, { recursive: true, dereference: false });
  await assert.rejects(() => packaging.assertContainedSymlinks(badCopy), /link escapes/);

  await packaging.copyAppVerbatim(source, goodCopy);
  assert.equal(await readlink(join(goodCopy, "link")), "target");
  await assert.doesNotReject(() => packaging.assertContainedSymlinks(goodCopy));
  assert.match(await readFile(scriptPath, "utf8"), /assertContainedSymlinks\(appPath\)/);
});

test("smoke proves Vite host transforms and a visible mounted SkyTurn shell", async () => {
  const source = await readFile(smokeScriptPath, "utf8");
  assert.match(source, /createServer/);
  assert.match(source, /probeRoot=fs\.realpathSync\(path\.join/);
  assert.match(source, /transformRequest\("\/main\.ts"\)/);
  assert.match(source, /document\.querySelector\("\.home-panel, \.app-shell"\)/);
  assert.match(source, /getBoundingClientRect\(\)/);
  assert.match(source, /rendererErrors/);
  assert.match(source, /assertContainedSymlinks\(appSource\)/);
  assert.match(source, /assertContainedSymlinks\(installedApp\)/);
});

test("documented root smoke command uses package-relative arguments", async () => {
  const docs = await readFile(join(dirname(dirname(dirname(scriptPath))), "..", "docs/desktop-distribution.md"), "utf8");
  assert.match(docs, /--app release\/SkyTurn\.app/);
  assert.match(docs, /--artifacts release\/smoke/);
  assert.doesNotMatch(docs, /--app apps\/desktop\/release\/SkyTurn\.app/);
});

async function createPayloadFixture(root) {
  const bridgeRoot = join(root, "node_modules/@skyturn/agent-bridge");
  const nativeRoot = join(bridgeRoot, "dist/native");
  const internalRoot = join(bridgeRoot, "dist/internal");
  const sqliteRoot = join(root, "node_modules/better-sqlite3/build/Release");
  await Promise.all([
    mkdir(join(root, "dist"), { recursive: true }),
    mkdir(join(root, "dist-electron/electron"), { recursive: true }),
    mkdir(nativeRoot, { recursive: true }),
    mkdir(internalRoot, { recursive: true }),
    mkdir(sqliteRoot, { recursive: true }),
  ]);
  await Promise.all([
    writeFile(join(root, "dist/index.html"), '<script src="./assets/index.js"></script>'),
    writeFile(join(root, "dist-electron/electron/main.js"), "module.exports = {};\n"),
    writeFile(join(root, "dist-electron/electron/preload.js"), "module.exports = {};\n"),
    writeFile(
      join(root, "package.json"),
      `${JSON.stringify({
        name: "@skyturn/desktop",
        version: "0.1.0",
        productName: "SkyTurn",
        main: "dist-electron/electron/main.js",
        dependencies: { "@skyturn/agent-bridge": "0.1.0", "better-sqlite3": "12.10.1" },
      })}\n`,
    ),
    writeFile(join(bridgeRoot, "package.json"), '{"name":"@skyturn/agent-bridge","version":"0.1.0"}\n'),
    writeFile(join(root, "node_modules/better-sqlite3/package.json"), '{"name":"better-sqlite3","version":"12.10.1"}\n'),
    writeFile(join(sqliteRoot, "better_sqlite3.node"), "fixture"),
    writeFile(join(internalRoot, "hermesCandidateVerifier.py"), "# fixture\n"),
    writeFile(join(root, "skyturn-build.json"), '{"productName":"SkyTurn"}\n'),
    writeFile(join(root, "third-party-licenses.json"), "[]\n"),
  ]);
  for (const helper of ["artifact-gate", "fd-launch", "posix-process-owner"]) {
    const helperPath = join(nativeRoot, helper);
    await writeFile(helperPath, "fixture");
    await chmod(helperPath, 0o755);
  }
  await Promise.all([
    writeFile(join(nativeRoot, "artifact-gate.ps1"), "# fixture\n"),
    writeFile(join(nativeRoot, "job-object-host.ps1"), "# fixture\n"),
  ]);
  assert.equal(JSON.parse(await readFile(join(root, "package.json"), "utf8")).version, "0.1.0");
}

async function readdirNames(path) {
  const { readdir } = await import("node:fs/promises");
  return readdir(path);
}
