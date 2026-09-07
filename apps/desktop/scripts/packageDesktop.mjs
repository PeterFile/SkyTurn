import { execFileSync, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { constants } from "node:fs";
import { access, copyFile, cp, lstat, mkdir, opendir, readFile, readdir, realpath, rename, rm, rmdir, unlink, writeFile } from "node:fs/promises";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

const NATIVE_HELPERS = ["artifact-gate", "fd-launch", "posix-process-owner"];
const WINDOWS_HELPERS = ["artifact-gate.ps1", "job-object-host.ps1"];
const PRIVATE_NAMES = new Set([".git", ".devflow", ".codex", ".claude", ".gemini", ".hermes", "AGENTS.md", "CLAUDE.md", "GEMINI.md"]);
const DEPENDENCY_ENTRY_LIMIT = 100_000;
const DEPENDENCY_DEPTH_LIMIT = 64;
const ELECTRON_VERSION = "41.5.1";
const SCRIPT_PATH = fileURLToPath(import.meta.url);
const DESKTOP_ROOT = dirname(dirname(SCRIPT_PATH));
const REPOSITORY_ROOT = resolve(DESKTOP_ROOT, "../..");
const OUTPUT_ROOT = join(DESKTOP_ROOT, "release");

export function assertRelativeRendererAssets(html) {
  if (/\b(?:src|href)=["']\//u.test(html)) {
    throw new Error("Found an absolute renderer asset URL; packaged file URLs require relative assets.");
  }
}

export function createBuildMetadata(input) {
  return {
    schemaVersion: 1,
    productName: "SkyTurn",
    version: input.version,
    electronVersion: input.electronVersion,
    platform: input.platform,
    arch: input.arch,
    sourceRevision: input.sourceRevision,
    sourceDirty: input.sourceDirty,
    lockfileSha256: input.lockfileSha256,
    dependencySource: "pnpm-lock.yaml",
    signed: false,
  };
}

export function createNativeRebuildOptions(stageRoot) {
  return {
    buildPath: stageRoot,
    projectRootPath: stageRoot,
    electronVersion: ELECTRON_VERSION,
    arch: process.arch,
    force: true,
    onlyModules: ["better-sqlite3"],
    mode: "sequential",
    buildFromSource: true,
  };
}

export async function createRuntimeManifest(sourceManifest, payloadRoot) {
  const dependencies = {};
  for (const name of Object.keys(sourceManifest.dependencies ?? {}).sort()) {
    const dependency = JSON.parse(
      await readFile(join(payloadRoot, "node_modules", name, "package.json"), "utf8"),
    );
    dependencies[name] = dependency.version;
  }
  return {
    name: sourceManifest.name,
    version: sourceManifest.version,
    productName: sourceManifest.productName ?? "SkyTurn",
    description: sourceManifest.description,
    private: true,
    main: sourceManifest.main,
    dependencies,
  };
}

export async function collectThirdPartyLicenses(payloadRoot) {
  const packages = new Map();
  const virtualStore = join(payloadRoot, "node_modules/.pnpm");
  await walk(virtualStore, async (path, entry) => {
    if (!entry.isFile() || entry.name !== "package.json") return;
    const parts = relative(virtualStore, path).split(sep);
    const isPackageRoot = parts[1] === "node_modules" &&
      (parts.length === 4 || (parts.length === 5 && parts[2].startsWith("@")));
    if (!isPackageRoot) return;
    const manifest = JSON.parse(await readFile(path, "utf8"));
    if (typeof manifest.name !== "string" || typeof manifest.version !== "string" || manifest.name.startsWith("@skyturn/")) return;
    const packageRoot = dirname(path);
    const licenseFiles = (await readdir(packageRoot))
      .filter((name) => /^(?:licen[cs]e|copying|notice)(?:[.-]|$)/iu.test(name))
      .map((name) => relative(payloadRoot, join(packageRoot, name)))
      .sort();
    const license = typeof manifest.license === "string" ? manifest.license : "UNKNOWN";
    const key = `${manifest.name}\0${manifest.version}\0${license}`;
    const previous = packages.get(key);
    if (!previous || previous.licenseFiles.length < licenseFiles.length) {
      packages.set(key, { name: manifest.name, version: manifest.version, license, licenseFiles });
    }
  });
  return [...packages.values()].sort((left, right) =>
    `${left.name}\0${left.version}`.localeCompare(`${right.name}\0${right.version}`, "en"),
  );
}

export async function trimWorkspacePackages(payloadRoot) {
  await rm(join(payloadRoot, "node_modules/.pnpm/node_modules/@skyturn/desktop"), { force: true });
  for (const packageRoot of await findWorkspacePackageRoots(payloadRoot)) {
    for (const name of await readdir(packageRoot)) {
      if (name !== "dist" && name !== "package.json") {
        await rm(join(packageRoot, name), { recursive: true, force: true });
      }
    }
  }
}

export async function excludePrivateDependencyPayloads(payloadRoot) {
  // Only the deploy copy's node_modules is eligible, before any package manifest scan.
  if (!(await lstat(payloadRoot)).isDirectory()) throw new Error("Staged payload must be a real directory.");
  const dependencyRoot = join(await realpath(payloadRoot), "node_modules");
  if (!(await lstat(dependencyRoot)).isDirectory()) throw new Error("Staged node_modules must be a real directory.");
  const excluded = [];
  let entries = 0;
  async function collect(directory, depth, excluding) {
    if (depth > DEPENDENCY_DEPTH_LIMIT) throw new Error("Staged dependency traversal limit exceeded (depth).");
    for await (const entry of await opendir(directory)) {
      entries += 1;
      if (entries > DEPENDENCY_ENTRY_LIMIT) throw new Error("Staged dependency traversal limit exceeded (entries).");
      const path = join(directory, entry.name);
      const exclude = excluding || isPrivatePayloadName(entry.name);
      if (entry.isSymbolicLink()) {
        // Never follow or erase links to make an unsafe tree pass validation.
        if (exclude) throw new Error("Found a symbolic link in an excluded payload.");
        continue;
      }
      if (entry.isDirectory()) {
        await collect(path, depth + 1, exclude);
      } else if (!entry.isFile()) {
        throw new Error("Unsupported staged dependency entry type.");
      }
      if (exclude) excluded.push({ path, directory: entry.isDirectory() });
    }
  }
  // Inventory metadata only, including excluded subtrees, before deleting anything.
  await collect(dependencyRoot, 0, false);
  for (const entry of excluded) {
    // Postorder, nonrecursive removal keeps deletion within the bounded inventory.
    if (entry.directory) await rmdir(entry.path);
    else await unlink(entry.path);
  }
}

export async function copyAppVerbatim(source, destination) {
  await cp(source, destination, {
    recursive: true,
    dereference: false,
    verbatimSymlinks: true,
    preserveTimestamps: true,
  });
}

export async function assertContainedSymlinks(treeRoot) {
  const root = await realpath(treeRoot);
  await walk(root, async (path, entry) => {
    if (!entry.isSymbolicLink()) return;
    const target = await realpath(path);
    const targetRelative = relative(root, target);
    if (targetRelative === ".." || targetRelative.startsWith(`..${sep}`) || isAbsolute(targetRelative)) {
      throw new Error(`Symbolic link escapes packaged payload or app tree: ${relative(root, path)}`);
    }
  });
}

export async function validatePayload(payloadRoot, options = {}) {
  const root = await realpath(payloadRoot);
  const requiredFiles = [
    "dist/index.html",
    "dist-electron/electron/main.js",
    "dist-electron/electron/preload.js",
    "skyturn-build.json",
    "third-party-licenses.json",
    "node_modules/@skyturn/agent-bridge/dist/internal/hermesCandidateVerifier.py",
    ...NATIVE_HELPERS.map((name) => `node_modules/@skyturn/agent-bridge/dist/native/${name}`),
    ...WINDOWS_HELPERS.map((name) => `node_modules/@skyturn/agent-bridge/dist/native/${name}`),
  ];
  await Promise.all(requiredFiles.map((path) => access(join(root, path), constants.R_OK)));
  assertRelativeRendererAssets(await readFile(join(root, "dist/index.html"), "utf8"));

  const manifest = JSON.parse(await readFile(join(root, "package.json"), "utf8"));
  if (manifest.devDependencies) throw new Error("Packaged manifest must not contain devDependencies.");
  for (const [name, version] of Object.entries(manifest.dependencies ?? {})) {
    if (!/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/u.test(version)) {
      throw new Error(`Runtime dependency ${name} is not pinned exactly: ${version}`);
    }
    const dependency = JSON.parse(await readFile(join(root, "node_modules", name, "package.json"), "utf8"));
    if (dependency.version !== version) {
      throw new Error(`Runtime dependency ${name} resolved to ${dependency.version}, expected ${version}.`);
    }
  }

  for (const name of NATIVE_HELPERS) {
    const stats = await lstat(join(root, "node_modules/@skyturn/agent-bridge/dist/native", name));
    if ((stats.mode & 0o111) === 0) throw new Error(`Native helper is not executable: ${name}`);
  }
  await assertWorkspacePackagesAreRuntimeOnly(root);
  await assertTreeIsSafe(root);

  const nativeModules = await findNamedFiles(root, "better_sqlite3.node");
  if (nativeModules.length === 0) throw new Error("Packaged better-sqlite3 native module is missing.");
  if (options.inspectNativeArchitecture !== false) {
    const expected = options.arch === "arm64" ? "arm64" : "x86_64";
    const binaries = [
      ...nativeModules,
      ...NATIVE_HELPERS.map((name) => join(root, "node_modules/@skyturn/agent-bridge/dist/native", name)),
    ];
    for (const binary of binaries) {
      const description = execFileSync("file", [binary], { encoding: "utf8" });
      if (!description.includes("Mach-O") || !description.includes(expected)) {
        throw new Error(`Native module does not match macOS ${expected}: ${description.trim()}`);
      }
    }
  }
  return { nativeModules };
}

async function assertWorkspacePackagesAreRuntimeOnly(root) {
  for (const packageRoot of await findWorkspacePackageRoots(root)) {
    const names = await readdir(packageRoot);
    const unexpected = names.filter((name) => name !== "dist" && name !== "package.json");
    if (unexpected.length > 0) {
      throw new Error(`workspace package contains non-runtime files: ${relative(root, packageRoot)}/${unexpected[0]}`);
    }
  }
}

async function findWorkspacePackageRoots(root) {
  const packageRoots = new Set();
  await walk(join(root, "node_modules"), async (path, entry) => {
    if (!entry.isFile() || entry.name !== "package.json") return;
    const manifest = JSON.parse(await readFile(path, "utf8"));
    if (typeof manifest.name === "string" && manifest.name.startsWith("@skyturn/")) {
      packageRoots.add(dirname(path));
    }
  });
  return [...packageRoots];
}

async function assertTreeIsSafe(root) {
  await walk(root, async (path, entry) => {
    if (isPrivatePayloadName(entry.name)) {
      throw new Error(`Found private or development payload: ${relative(root, path)}`);
    }
  });
  await assertContainedSymlinks(root);
}

function isPrivatePayloadName(name) {
  return PRIVATE_NAMES.has(name) || name === ".env" || name.startsWith(".env.");
}

async function findNamedFiles(root, name) {
  const paths = [];
  await walk(root, async (path, entry) => {
    if (entry.isFile() && entry.name === name) paths.push(path);
  });
  return paths;
}

async function walk(root, visit) {
  for (const entry of await readdir(root, { withFileTypes: true })) {
    const path = join(root, entry.name);
    await visit(path, entry);
    if (entry.isDirectory()) await walk(path, visit);
  }
}

async function packageDesktop() {
  if (process.platform !== "darwin") throw new Error("This command packages the current macOS host only.");
  const rootManifest = JSON.parse(await readFile(join(REPOSITORY_ROOT, "package.json"), "utf8"));
  const sourceManifest = JSON.parse(await readFile(join(DESKTOP_ROOT, "package.json"), "utf8"));
  if (rootManifest.packageManager !== "pnpm@10.28.2") throw new Error("Expected pnpm@10.28.2 in the root manifest.");
  if (sourceManifest.devDependencies?.electron !== ELECTRON_VERSION) throw new Error(`Electron must remain pinned to ${ELECTRON_VERSION}.`);
  if (sourceManifest.devDependencies?.["@electron/packager"] !== "18.3.6") throw new Error("@electron/packager must remain pinned to 18.3.6.");
  const pnpmVersion = execFileSync("pnpm", ["--version"], { cwd: REPOSITORY_ROOT, encoding: "utf8" }).trim();
  if (pnpmVersion !== "10.28.2") throw new Error(`Expected pnpm 10.28.2, received ${pnpmVersion}.`);

  run("pnpm", ["exec", "turbo", "run", "build", "--filter=@skyturn/desktop"]);
  assertRelativeRendererAssets(await readFile(join(DESKTOP_ROOT, "dist/index.html"), "utf8"));

  const sourceRevision = execFileSync("git", ["rev-parse", "HEAD"], { cwd: REPOSITORY_ROOT, encoding: "utf8" }).trim();
  const sourceDirty = execFileSync("git", ["status", "--porcelain=v1", "--untracked-files=normal"], {
    cwd: REPOSITORY_ROOT,
    encoding: "utf8",
  }).trim().length > 0;
  const lockfileSha256 = await sha256File(join(REPOSITORY_ROOT, "pnpm-lock.yaml"));
  const metadata = createBuildMetadata({
    version: sourceManifest.version,
    electronVersion: ELECTRON_VERSION,
    platform: process.platform,
    arch: process.arch,
    sourceRevision,
    sourceDirty,
    lockfileSha256,
  });

  await rm(OUTPUT_ROOT, { recursive: true, force: true });
  await mkdir(OUTPUT_ROOT, { recursive: true });
  const stageRoot = join(OUTPUT_ROOT, ".stage");
  const packagerRoot = join(OUTPUT_ROOT, ".packager");
  run("pnpm", [
    "--package-import-method=copy",
    "--filter", "@skyturn/desktop",
    "--prod",
    "deploy",
    "--legacy",
    stageRoot,
  ], { npm_config_enable_global_virtual_store: "false" });
  await retainEntries(stageRoot, new Set(["dist", "dist-electron", "node_modules", "package.json"]));
  await excludePrivateDependencyPayloads(stageRoot);
  await trimWorkspacePackages(stageRoot);
  await assertTreeIsSafe(await realpath(stageRoot));

  const checkoutNative = await realpath(join(
    REPOSITORY_ROOT,
    "packages/persistence/node_modules/better-sqlite3/build/Release/better_sqlite3.node",
  ));
  const checkoutNativeHash = await sha256File(checkoutNative);
  const { rebuild } = await import("@electron/rebuild");
  await rebuild(createNativeRebuildOptions(stageRoot));
  if (await sha256File(checkoutNative) !== checkoutNativeHash) {
    throw new Error("Native rebuild mutated the checkout better-sqlite3 binary.");
  }

  const runtimeManifest = await createRuntimeManifest(sourceManifest, stageRoot);
  const licenses = await collectThirdPartyLicenses(stageRoot);
  await Promise.all([
    writeJson(join(stageRoot, "package.json"), runtimeManifest),
    writeJson(join(stageRoot, "skyturn-build.json"), metadata),
    writeJson(join(stageRoot, "third-party-licenses.json"), licenses),
  ]);
  await validatePayload(stageRoot, { arch: process.arch });

  const imported = await import("@electron/packager");
  const packager = imported.default;
  if (typeof packager !== "function") throw new Error("@electron/packager did not expose its packaging function.");
  const outputPaths = await packager({
    dir: stageRoot,
    name: "SkyTurn",
    platform: "darwin",
    arch: process.arch,
    electronVersion: ELECTRON_VERSION,
    out: packagerRoot,
    overwrite: true,
    prune: false,
    asar: false,
    derefSymlinks: false,
    appVersion: sourceManifest.version,
    buildVersion: sourceManifest.version,
    appBundleId: "com.skyturn.desktop",
    appCategoryType: "public.app-category.developer-tools",
  });
  if (outputPaths.length !== 1) throw new Error(`Expected one packaged application, received ${outputPaths.length}.`);
  const packagedDirectory = outputPaths[0];
  const packagedApp = join(packagedDirectory, "SkyTurn.app");
  const packagedResources = join(packagedApp, "Contents/Resources");
  await Promise.all([
    copyFile(join(packagedDirectory, "LICENSE"), join(packagedResources, "LICENSE.electron.txt")),
    copyFile(join(packagedDirectory, "LICENSES.chromium.html"), join(packagedResources, "LICENSES.chromium.html")),
  ]);
  const packagedElectronVersion = (await readFile(join(packagedDirectory, "version"), "utf8")).trim();
  if (packagedElectronVersion !== ELECTRON_VERSION) throw new Error(`Packager used Electron ${packagedElectronVersion}.`);
  const appPath = join(OUTPUT_ROOT, "SkyTurn.app");
  await rename(packagedApp, appPath);
  await assertContainedSymlinks(appPath);
  const packagedPayload = join(appPath, "Contents/Resources/app");
  await validatePayload(packagedPayload, { arch: process.arch });
  await Promise.all([
    access(join(appPath, "Contents/Resources/LICENSE.electron.txt"), constants.R_OK),
    access(join(appPath, "Contents/Resources/LICENSES.chromium.html"), constants.R_OK),
  ]);
  const bundleName = execFileSync("plutil", ["-extract", "CFBundleName", "raw", "-o", "-", join(appPath, "Contents/Info.plist")], { encoding: "utf8" }).trim();
  if (bundleName !== "SkyTurn") throw new Error(`Unexpected CFBundleName: ${bundleName}`);

  const zipName = `SkyTurn-${sourceManifest.version}-macos-${process.arch}.zip`;
  const zipPath = join(OUTPUT_ROOT, zipName);
  run("ditto", ["-c", "-k", "--sequesterRsrc", "--keepParent", appPath, zipPath]);
  const archiveSha256 = await sha256File(zipPath);
  await writeJson(join(OUTPUT_ROOT, "artifact-metadata.json"), {
    ...metadata,
    appDirectory: "SkyTurn.app",
    archive: zipName,
    archiveSha256,
  });
  await Promise.all([
    rm(stageRoot, { recursive: true, force: true }),
    rm(packagerRoot, { recursive: true, force: true }),
  ]);
  process.stdout.write(`${JSON.stringify({ appPath, zipPath, archiveSha256, metadata }, null, 2)}\n`);
}

async function retainEntries(root, allowed) {
  for (const name of await readdir(root)) {
    if (!allowed.has(name)) await rm(join(root, name), { recursive: true, force: true });
  }
}

async function sha256File(path) {
  return createHash("sha256").update(await readFile(path)).digest("hex");
}

async function writeJson(path, value) {
  await writeFile(path, `${JSON.stringify(value, null, 2)}\n`);
}

function run(command, args, environment = {}) {
  const result = spawnSync(command, args, {
    cwd: REPOSITORY_ROOT,
    env: { ...process.env, ...environment },
    stdio: "inherit",
  });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(`${command} failed with exit code ${result.status ?? "unknown"}.`);
}

if (process.argv[1] && resolve(process.argv[1]) === SCRIPT_PATH) {
  if (process.argv.includes("--help")) {
    process.stdout.write("Build an unsigned macOS current-host SkyTurn.app and zip with Electron 41.5.1.\n");
  } else {
    packageDesktop().catch((error) => {
      process.stderr.write(`${error instanceof Error ? error.stack ?? error.message : String(error)}\n`);
      process.exitCode = 1;
    });
  }
}
