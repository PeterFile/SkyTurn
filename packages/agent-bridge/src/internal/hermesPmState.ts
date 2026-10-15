import { createHash } from "node:crypto";
import { constants as fsConstants, type BigIntStats } from "node:fs";
import { lstat, open, opendir, realpath } from "node:fs/promises";
import { basename, dirname, isAbsolute, join, relative, sep } from "node:path";

const failure = "Hermes PM startup state is unsafe or changed; launch refused.";
const maxMetadataBytes = 65_536;
const uuid = /^[0-9a-f]{32}$/;
const brand: unique symbol = Symbol("HermesPmState");

// Only this module can mint a policy. Public adapter options and environment
// variables cannot supply additional writable paths.
export interface HermesPmState { readonly [brand]: true }
interface Snapshot { path: string; identity: string | null; digest?: string; target?: string }
interface State { snapshots: Snapshot[]; leases?: string; rules: string }
const states = new WeakMap<HermesPmState, State>();

export async function resolveHermesPmState(input: {
  executablePath: string;
  projectRoot: string;
  hermesStateRoot: string;
  env: NodeJS.ProcessEnv;
}): Promise<HermesPmState | undefined> {
  try {
    const snapshots: Snapshot[] = [];
    const original = await realpath(input.executablePath);
    let launcher = original;
    let wrapperTarget: string | undefined;
    const originalSource = await launcherSource(launcher);
    let source = originalSource;
    let words = execWords(source);
    if (words?.length === 1 && isAbsolute(words[0])) {
      wrapperTarget = words[0];
      launcher = await realpath(wrapperTarget);
      assertPath(launcher);
      source = await launcherSource(launcher);
      words = execWords(source);
    }
    // Unknown and legacy launchers retain their original launch contract and no PM grant.
    if (words?.length !== 4 || words[1] !== "-I" || words[2] !== "-c") return undefined;
    if (!words[3].includes("import hermes_bootstrap")) return undefined;

    const install = dirname(dirname(dirname(launcher)));
    const home = dirname(install);
    const project = await realpath(input.projectRoot);
    const python = words[0];
    const pythonRoot = dirname(dirname(python));
    const code = words[3];
    assertPath(install);
    if (
      launcher !== join(install, ".hermes/bin/hermes") ||
      /['"\\]/.test(install) ||
      !code.split("\n").includes(`sys.path.insert(0, '${install}')`) ||
      code.split("\n").filter((line) => line.startsWith("sys.path.insert(0,")).length !== 1 ||
      !code.split("\n").includes("from hermes_cli.main import main") ||
      dirname(pythonRoot) !== join(home, "tools") ||
      basename(dirname(python)) !== "bin" ||
      !/^python[0-9A-Za-z.+_-]+$/.test(basename(pythonRoot)) ||
      !/^python3(?:\.\d+)?$/.test(basename(python)) ||
      input.env.HERMES_RUNTIME_DIR || input.env.HERMES_DATA_DIR_SUFFIX ||
      !(input.hermesStateRoot === home ||
        dirname(input.hermesStateRoot) === join(home, "profiles"))
    ) throw new Error(failure);

    for (const path of [home, install, join(install, ".hermes"), dirname(launcher), join(home, "tools"), pythonRoot, dirname(python)]) {
      await capture(path, true, snapshots, project);
    }
    if (await capture(original, false, snapshots, project) !== originalSource) throw new Error(failure);
    if (original !== launcher && await capture(launcher, false, snapshots, project) !== source) throw new Error(failure);
    // The PM Python may have its ordinary python3 -> python3.x alias, but it must
    // stay in this exact tool entry; no environment-selected tool store is followed.
    const canonicalPython = await realpath(python);
    if (dirname(canonicalPython) !== dirname(python)) throw new Error(failure);
    await captureAlias(python, canonicalPython, snapshots, project);
    if (input.executablePath !== original) {
      await captureAlias(input.executablePath, original, snapshots, project);
    }
    if (wrapperTarget && wrapperTarget !== launcher) {
      await captureAlias(wrapperTarget, launcher, snapshots, project);
    }

    const key = hash(install).slice(0, 16);
    const stateRoot = join(home, "installs", key);
    await capture(join(home, "installs"), true, snapshots, project);
    await capture(stateRoot, true, snapshots, project);
    const lock = join(stateRoot, ".install.lock");
    await capture(lock, false, snapshots, project, { privateFile: true, readContents: false });
    const factsPath = join(stateRoot, "facts.json");
    const facts = parseFacts(await capture(factsPath, false, snapshots, project));
    const environment = facts.packages.venv.environment;
    assertPath(environment);
    const generation = dirname(environment);
    if (basename(environment) !== "venv" || !uuid.test(basename(generation)) ||
      dirname(generation) !== join(stateRoot, "environments")) throw new Error(failure);
    for (const path of [dirname(generation), generation, environment]) {
      await capture(path, true, snapshots, project);
    }
    await capture(join(environment, "pyvenv.cfg"), false, snapshots, project, { readContents: false });
    const managed = await capture(join(generation, ".lease-managed"), false, snapshots, project, { optional: true, readContents: false });
    const leases = managed === undefined ? undefined : join(generation, ".leases");
    if (leases) {
      await capture(leases, true, snapshots, project, { optional: true });
      await validateLeases(leases);
    }

    // SBPL does not implement counted repetition. Keep this exact-width family
    // explicit; successful JavaScript RegExp matching is not native policy proof.
    const leasePattern = leases ? `^${escapeRegex(leases)}/${"[0-9a-f]".repeat(32)}$` : undefined;
    // SBPL #"..." is a regex literal, not a JSON/Scheme string: preserve regex
    // backslashes (as in macOS's shipped profiles). The install path above excludes
    // quotes, backslashes and controls, so this cannot terminate the literal.
    // Never authorize unlink/rename: removing a peer's held lock or live lease
    // would break PM lifetime protection. Upstream lease cleanup is best-effort.
    const rules = `(allow file-write-data (literal ${JSON.stringify(lock)}))${leasePattern
      ? ` (allow file-write-create file-write-data (regex #"${leasePattern}"))` : ""}${leases
      ? ` (allow file-write-create (literal ${JSON.stringify(leases)}))` : ""}`;
    const token: HermesPmState = Object.freeze({ [brand]: true as const });
    states.set(token, { snapshots, leases, rules });
    return token;
  } catch {
    // Do not publish launcher source, metadata, local paths, or platform error text.
    throw new Error(failure);
  }
}

export function hermesPmSandboxRules(state: HermesPmState): string {
  const validated = states.get(state);
  if (!validated) throw new Error(failure);
  return validated.rules;
}

export async function revalidateHermesPmState(state: HermesPmState): Promise<void> {
  try {
    const validated = states.get(state);
    if (!validated) throw new Error(failure);
    for (const snapshot of validated.snapshots) {
      if (snapshot.identity === null) {
        try { await lstat(snapshot.path); }
        catch (error) {
          if ((error as NodeJS.ErrnoException).code === "ENOENT") continue;
          throw error;
        }
        throw new Error(failure);
      }
      const metadata = await lstat(snapshot.path, { bigint: true });
      if (identity(metadata) !== snapshot.identity) throw new Error(failure);
      if (snapshot.target !== undefined) {
        if (await realpath(snapshot.path) !== snapshot.target) throw new Error(failure);
      } else if (await realpath(snapshot.path) !== snapshot.path) throw new Error(failure);
      if (snapshot.digest !== undefined && hash(await boundedRead(snapshot.path)) !== snapshot.digest) {
        throw new Error(failure);
      }
    }
    if (validated.leases) await validateLeases(validated.leases);
  } catch { throw new Error(failure); }
}

async function capture(
  path: string, directory: boolean, snapshots: Snapshot[], project: string,
  options: { optional?: boolean; privateFile?: boolean; readContents?: boolean } = {},
): Promise<string | undefined> {
  assertPath(path);
  if (overlaps(path, project)) throw new Error(failure);
  let metadata: BigIntStats;
  try { metadata = await lstat(path, { bigint: true }); }
  catch (error) {
    if (options.optional && (error as NodeJS.ErrnoException).code === "ENOENT") {
      snapshots.push({ path, identity: null });
      return undefined;
    }
    throw error;
  }
  assertOwned(metadata);
  if (await realpath(path) !== path || (directory ? !metadata.isDirectory() :
    !metadata.isFile() || metadata.nlink !== 1n || metadata.size > BigInt(maxMetadataBytes) ||
    options.privateFile && (metadata.mode & 0o777n) !== 0o600n)) {
    throw new Error(failure);
  }
  const source = directory || options.readContents === false ? undefined : await boundedRead(path);
  snapshots.push({ path, identity: identity(metadata), ...(source === undefined ? {} : { digest: hash(source) }) });
  return directory ? undefined : source ?? "";
}

async function captureAlias(path: string, target: string, snapshots: Snapshot[], project: string): Promise<void> {
  assertPath(path);
  if (overlaps(path, project)) throw new Error(failure);
  const metadata = await lstat(path, { bigint: true });
  if (metadata.uid !== BigInt(process.getuid!()) || !metadata.isFile() && !metadata.isSymbolicLink()) throw new Error(failure);
  snapshots.push({ path, target, identity: identity(metadata) });
  // Executables can be large. Retain their replacement-sensitive filesystem
  // identity; launcher text and small metadata additionally get content digests.
  const canonical = await lstat(target, { bigint: true });
  assertOwned(canonical);
  if (!canonical.isFile() || canonical.nlink !== 1n || overlaps(target, project)) throw new Error(failure);
  snapshots.push({ path: target, identity: identity(canonical) });
}

function assertOwned(metadata: BigIntStats): void {
  if (metadata.uid !== BigInt(process.getuid!()) || (metadata.mode & 0o022n) !== 0n) throw new Error(failure);
}

function identity(metadata: BigIntStats): string {
  if (metadata.ino === 0n && metadata.birthtimeNs === 0n) throw new Error(failure);
  return [metadata.dev, metadata.ino, metadata.birthtimeNs, metadata.uid, metadata.mode,
    ...(metadata.isDirectory() ? [] : [metadata.nlink, metadata.size, metadata.mtimeNs, metadata.ctimeNs])].join(":");
}

async function boundedRead(path: string): Promise<string> {
  const handle = await open(path, fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW | fsConstants.O_NONBLOCK);
  try {
    const before = await handle.stat({ bigint: true });
    if (!before.isFile() || before.size > BigInt(maxMetadataBytes)) throw new Error(failure);
    const buffer = Buffer.alloc(Number(before.size) + 1);
    const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
    if (BigInt(bytesRead) !== before.size || identity(before) !== identity(await handle.stat({ bigint: true })) ||
      identity(before) !== identity(await lstat(path, { bigint: true }))) throw new Error(failure);
    return new TextDecoder("utf-8", { fatal: true }).decode(buffer.subarray(0, bytesRead));
  } finally { await handle.close(); }
}

async function launcherSource(path: string): Promise<string> {
  const handle = await open(path, fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW | fsConstants.O_NONBLOCK);
  try {
    const metadata = await handle.stat();
    if (!metadata.isFile() || metadata.size > maxMetadataBytes) return "";
    const prefix = Buffer.alloc(20);
    await handle.read(prefix, 0, prefix.length, 0);
    if (!prefix.toString().startsWith("#!/bin/sh\nexec ")) return "";
  } finally { await handle.close(); }
  return boundedRead(path);
}

function execWords(source: string): string[] | undefined {
  if (!source.startsWith("#!/bin/sh\nexec ") || !source.endsWith(' "$@"\n')) return undefined;
  const command = source.slice("#!/bin/sh\nexec ".length, -' "$@"\n'.length);
  const pm = /^(.*?) -I -c ('[\s\S]*')$/.exec(command);
  const literals = pm ? [pm[1], "-I", "-c", pm[2]] : [command];
  const words = literals.map((word) => {
    if (/^[a-zA-Z0-9_/.+:=@%,-]+$/.test(word)) return word;
    if (!word.startsWith("'") || !word.endsWith("'")) return undefined;
    const decoded = word.slice(1, -1).replaceAll(`'"'"'`, "'");
    return `'${decoded.replaceAll("'", `'"'"'`)}'` === word ? decoded : undefined;
  });
  return words.every((word) => word !== undefined) ? words as string[] : undefined;
}

function parseFacts(source: string | undefined): { packages: { venv: { environment: string } } } {
  if (!source) throw new Error(failure);
  const result = JSON.parse(source);
  // JSON.parse accepts duplicate members; reject them, including escaped aliases,
  // in every object before interpreting any path from this bounded metadata.
  const stack: Array<{ keys?: Set<string>; key: boolean }> = [];
  for (const token of source.match(/"(?:[^"\\]|\\.)*"|[{}\[\]:,]|[^\s{}\[\]:,]+/g) ?? []) {
    if (token === "{" || token === "[") {
      if (stack.length >= 32) throw new Error(failure);
      stack.push({ ...(token === "{" ? { keys: new Set<string>() } : {}), key: true });
    } else if (token === "}" || token === "]") stack.pop();
    else {
      const context = stack.at(-1);
      if (token === "," && context) context.key = true;
      else if (token.startsWith('"') && context?.keys && context.key) {
        const key = JSON.parse(token) as string;
        if (context.keys.has(key)) throw new Error(failure);
        context.keys.add(key);
        context.key = false;
      }
    }
  }
  if (result?.schema !== 1 || typeof result?.packages?.venv?.environment !== "string") throw new Error(failure);
  return result;
}

async function validateLeases(path: string): Promise<void> {
  let directory;
  try { directory = await opendir(path); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
    throw error;
  }
  let count = 0;
  for await (const entry of directory) {
    if (++count > 1024 || !uuid.test(entry.name)) throw new Error(failure);
    const lease = join(path, entry.name);
    let metadata: BigIntStats;
    try { metadata = await lstat(lease, { bigint: true }); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") continue;
      throw error;
    }
    assertOwned(metadata);
    if (!metadata.isFile() || metadata.size !== 0n || metadata.nlink !== 1n ||
      (metadata.mode & 0o777n) !== 0o600n || await realpath(lease) !== lease) throw new Error(failure);
  }
}

function assertPath(path: string): void {
  if (!isAbsolute(path) || path.length > 4096 || /[\u0000-\u001f\u007f]/.test(path)) throw new Error(failure);
}

function overlaps(left: string, right: string): boolean {
  const within = (parent: string, child: string) => {
    const value = relative(parent, child);
    return value === "" || value !== ".." && !value.startsWith(`..${sep}`) && !isAbsolute(value);
  };
  return within(left, right) || within(right, left);
}

function hash(value: string): string { return createHash("sha256").update(value).digest("hex"); }
function escapeRegex(value: string): string { return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"); }
