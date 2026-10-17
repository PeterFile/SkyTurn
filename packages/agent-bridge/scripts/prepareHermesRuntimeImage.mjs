import { spawn } from "node:child_process";
import { constants } from "node:fs";
import { access, chmod, lstat, mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { isAbsolute, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { isDeepStrictEqual as equal } from "node:util";

const outputLimit = 1_048_576;
class PreparationError extends Error {
  constructor(code) { super(code); this.code = code; }
}
function requireValue(condition, code) {
  if (!condition) throw new PreparationError(code);
}
function canonicalPath(value) {
  return typeof value === "string" && value !== "/" && Buffer.byteLength(value) <= 4096
    && !/[\x00-\x1f\x7f]/.test(value) && isAbsolute(value) && resolve(value) === value;
}
function parseArguments(args) {
  const names = ["--docker-executable", "--docker-host", "--expected-daemon-id", "--state-root"];
  requireValue(Array.isArray(args) && args.length === 8 && args.every((x) => typeof x === "string"), "INVALID_ARGUMENTS");
  const values = new Map();
  for (let i = 0; i < args.length; i += 2) {
    requireValue(names.includes(args[i]) && !values.has(args[i]), "INVALID_ARGUMENTS");
    values.set(args[i], args[i + 1]);
  }
  const [executable, host, daemonId, stateRoot] = names.map((name) => values.get(name));
  requireValue(canonicalPath(executable) && canonicalPath(stateRoot)
    && /^unix:\/\//.test(host) && canonicalPath(host.slice(7)) && !/[?#%]/.test(host)
    && /^[A-Za-z0-9][A-Za-z0-9:._-]{0,127}$/.test(daemonId), "INVALID_ARGUMENTS");
  return { executable, host, daemonId, stateRoot, socket: host.slice(7) };
}
async function checkPath(path, kind, lstatPath) {
  let current = "/";
  const components = ["", ...path.slice(1).split("/")];
  for (let i = 0; i < components.length; i++) {
    current = join(current, components[i]);
    const stat = await lstatPath(current);
    const last = i === components.length - 1;
    requireValue(!stat.isSymbolicLink() && (stat.uid === 0 || stat.uid === process.getuid()), "UNSAFE_PATH");
    if (!last || kind === "state") requireValue(stat.isDirectory(), "UNSAFE_PATH");
    // Root-owned sticky temporary ancestors are safe for an exclusively created child.
    const sticky = stat.isDirectory() && stat.uid === 0 && (stat.mode & 0o1000) !== 0;
    if (!(last && kind === "socket")) requireValue((stat.mode & 0o022) === 0 || sticky, "UNSAFE_PATH");
    if (last && kind === "state") requireValue(stat.uid === process.getuid() && (stat.mode & 0o7777) === 0o700, "UNSAFE_PATH");
    if (last && kind === "executable") requireValue(stat.isFile() && (stat.mode & 0o6000) === 0, "UNSAFE_PATH");
    if (last && kind === "socket") requireValue(stat.isSocket(), "UNSAFE_PATH");
  }
}
async function checkPaths(options, lstatPath) {
  await checkPath(options.executable, "executable", lstatPath);
  await access(options.executable, constants.X_OK);
  await checkPath(options.stateRoot, "state", lstatPath);
  await checkPath(options.socket, "socket", lstatPath);
}
async function readPin() {
  const pin = JSON.parse(await readFile(new URL("../runtime/hermes-image.json", import.meta.url), "utf8"));
  requireValue(pin.schemaVersion === 1 && /^docker\.io\/nousresearch\/hermes-agent@sha256:[a-f0-9]{64}$/.test(pin.image)
    && /^sha256:[a-f0-9]{64}$/.test(pin.imageId) && equal(pin.platform, { os: "linux", architecture: "amd64" })
    && equal(pin.volumes, ["/opt/data"]) && equal(pin.entrypoint, ["/opt/hermes/docker/entrypoint-dispatch.sh"])
    && equal(pin.labels, {}) && pin.user === "root" && pin.workingDirectory === "/opt/hermes", "INVALID_PIN");
  return pin;
}
function verifyImage(text, pin) {
  let entries;
  try { entries = JSON.parse(text); } catch { throw new PreparationError("IMAGE_MISMATCH"); }
  requireValue(Array.isArray(entries) && entries.length === 1, "IMAGE_MISMATCH");
  const entry = entries[0]; const config = entry?.Config;
  requireValue(entry?.Id === pin.imageId && entry.Os === pin.platform.os && entry.Architecture === pin.platform.architecture
    && Array.isArray(entry.RepoDigests) && entry.RepoDigests.some((digest) => typeof digest === "string"
      && digest.replace(/^docker\.io\//, "") === pin.image.replace(/^docker\.io\//, ""))
    && equal(config?.Volumes, { "/opt/data": {} }) && equal(config?.Entrypoint, pin.entrypoint)
    && equal(config?.Labels ?? {}, pin.labels) && config?.User === pin.user && config?.WorkingDir === pin.workingDirectory, "IMAGE_MISMATCH");
}

function dockerCommand(executable, args, options, evidence, { spawnProcess, scheduleTimeout, signal }, timeoutMs) {
  return new Promise((resolveCommand, rejectCommand) => {
    let child;
    try { child = spawnProcess(executable, args, options); }
    catch { rejectCommand(new PreparationError("COMMAND_ERROR")); return; }
    let failure; let killed = false; let closed = false; let timer;
    const stdout = Buffer.alloc(outputLimit);
    let stdoutLength = 0;
    const terminate = (code) => {
      if (closed) return;
      failure ??= code;
      if (!killed) { killed = true; try { child.kill("SIGKILL"); } catch { /* Still await close and stdio completion. */ } }
    };
    const abort = () => terminate("COMMAND_ABORTED");
    for (const stream of ["stdout", "stderr"]) {
      evidence[`${stream}Bytes`] = 0;
      child[stream].on("data", (data) => {
        const bytes = Buffer.from(data);
        evidence[`${stream}Bytes`] = Math.min(outputLimit + 1, evidence[`${stream}Bytes`] + bytes.length);
        if (evidence[`${stream}Bytes`] > outputLimit) terminate("COMMAND_OUTPUT_LIMIT");
        else if (stream === "stdout" && !failure) { bytes.copy(stdout, stdoutLength); stdoutLength += bytes.length; }
      });
      child[stream].on("error", () => terminate("COMMAND_ERROR"));
    }
    child.on("error", () => terminate("COMMAND_ERROR"));
    child.once("close", (code, closeSignal) => {
      closed = true; clearTimeout(timer); signal?.removeEventListener("abort", abort);
      Object.assign(evidence, { closed: true, exitCode: code, signalled: closeSignal != null });
      if (failure || code !== 0 || closeSignal != null) rejectCommand(new PreparationError(failure ?? "COMMAND_FAILED"));
      else resolveCommand(stdout.toString("utf8", 0, stdoutLength));
    });
    timer = scheduleTimeout(() => terminate("COMMAND_TIMEOUT"), timeoutMs);
    signal?.addEventListener("abort", abort, { once: true });
    if (signal?.aborted) abort();
  });
}

// Only the imported offline test API accepts boundary injection; the CLI has no bypass flags.
export async function prepareHermesRuntimeImage(args, { spawnProcess = spawn, lstatPath = lstat, scheduleTimeout = setTimeout, signal } = {}) {
  let evidenceDirectory; let stage = "arguments"; let pin; let daemonId;
  const commands = [];
  const summary = (status, code) => ({ status, preparationOnly: true, runtimeReady: false, plannerReady: false,
    ...(pin ? { image: pin.image, imageId: pin.imageId, platform: "linux/amd64" } : {}),
    ...(daemonId ? { daemonId } : {}),
    ...(evidenceDirectory ? { evidenceDirectory } : {}), ...(code ? { code, stage } : {}) });
  const persist = (value) => writeFile(join(evidenceDirectory, "preparation.json"), `${JSON.stringify({ ...value, commands })}\n`, { mode: 0o600 });
  try {
    const options = parseArguments(args);
    daemonId = options.daemonId;
    requireValue(process.platform !== "win32" && typeof process.getuid === "function", "UNSUPPORTED_HOST");
    stage = "paths"; await checkPaths(options, lstatPath);
    stage = "pin"; pin = await readPin();
    requireValue(!signal?.aborted, "COMMAND_ABORTED");
    stage = "private-state";
    evidenceDirectory = await mkdtemp(join(options.stateRoot, "hermes-image-"));
    await chmod(evidenceDirectory, 0o700);
    const home = join(evidenceDirectory, "home"); const config = join(evidenceDirectory, "docker-config");
    for (const directory of [home, config]) { await mkdir(directory, { mode: 0o700 }); await chmod(directory, 0o700); }
    const processOptions = { cwd: evidenceDirectory, shell: false, stdio: ["ignore", "pipe", "pipe"],
      env: { HOME: home, DOCKER_CONFIG: config, PATH: "/usr/bin:/bin", LANG: "C", LC_ALL: "C" } };
    const command = async (name, commandArgs, timeoutMs = 60_000) => {
      stage = name;
      await checkPaths(options, lstatPath);
      requireValue(!signal?.aborted, "COMMAND_ABORTED");
      const evidence = { command: name, closed: false }; commands.push(evidence);
      await persist(summary("preparing"));
      requireValue(!signal?.aborted, "COMMAND_ABORTED");
      return dockerCommand(options.executable, ["--host", options.host, "--config", config, ...commandArgs], processOptions,
        evidence, { spawnProcess, scheduleTimeout, signal }, timeoutMs);
    };
    const verifyDaemon = async (name) => {
      const output = await command(name, ["info", "--format", "{{json .ID}}"]);
      let id; try { id = JSON.parse(output); } catch { /* Fail closed without disclosing daemon output. */ }
      requireValue(id === options.daemonId, "DAEMON_MISMATCH");
    };
    await verifyDaemon("daemon-before");
    await command("pull", ["pull", "--quiet", "--platform", "linux/amd64", pin.image], 1_200_000);
    await verifyDaemon("daemon-after");
    verifyImage(await command("image-inspect", ["image", "inspect", pin.image]), pin);
    requireValue(!signal?.aborted, "COMMAND_ABORTED");
    const result = summary("prepared"); await persist(result);
    requireValue(!signal?.aborted, "COMMAND_ABORTED");
    return result;
  } catch (error) {
    const failure = error instanceof PreparationError ? error : new PreparationError("LOCAL_IO_ERROR");
    failure.result = summary("failed", failure.code);
    if (evidenceDirectory) {
      try { await persist(failure.result); } catch { failure.result.evidencePersisted = false; }
    }
    throw failure;
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const controller = new AbortController();
  const abort = () => controller.abort();
  process.on("SIGINT", abort); process.on("SIGTERM", abort);
  try {
    const result = await prepareHermesRuntimeImage(process.argv.slice(2), { signal: controller.signal });
    process.stdout.write(`${JSON.stringify(result)}\n`);
  } catch (error) {
    process.stderr.write(`${JSON.stringify(error.result ?? { status: "failed", code: "PREPARATION_FAILED" })}\n`);
    process.exitCode = 1;
  } finally { process.off("SIGINT", abort); process.off("SIGTERM", abort); }
}
