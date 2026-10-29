// Experimental no-credential fixtures only. No production output or RunEvidence API.
import { spawn } from "node:child_process";
import { randomBytes, createHash } from "node:crypto";
import { constants } from "node:fs";
import { lstat, mkdir, open, readdir, rename } from "node:fs/promises";
import { join } from "node:path";
import { isDeepStrictEqual as equal } from "node:util";
import { parseArguments, checkPaths, readPin, verifyImage, dockerCommand } from "./prepareHermesRuntimeImage.mjs";

const label = "dev.skyturn.experimental-hermes-operation";
const hex = /^[a-f0-9]{64}$/;
const identityCheck = 'test "$(id -u)" = 10000 && test "$(id -g)" = 10000 && '
  + 'for cap in CapEff CapPrm CapAmb; do grep -Eq "^$cap:[[:space:]]+0+$" /proc/self/status || exit 74; done && '
  + 'grep -Eq "^NoNewPrivs:[[:space:]]+1$" /proc/self/status && test -f /opt/data/config.yaml';
export const fixtures = Object.freeze({
  bootstrap: ["sh", "-c", `${identityCheck} && hermes --help >/tmp/hermes-help && printf 'SKYTURN_FIXTURE_BOOTSTRAP_OK\\n'`],
  fork: ["sh", "-c", `${identityCheck} || exit 72; sleep 600 &\nwaiter=$!; kill -0 "$waiter" || exit 71; printf 'SKYTURN_FIXTURE_CHILD=%s\\n' "$waiter"; exit 0`],
  hold: ["sh", "-c", `${identityCheck} || exit 72; sleep 600 & child=$!; kill -0 "$child" || exit 73; printf 'SKYTURN_FIXTURE_HOLD=%s\\n' "$child"; wait "$child"`],
});
for (const args of Object.values(fixtures)) Object.freeze(args);
const requireValue = (condition, code) => { if (!condition) throw new Error(code); };
const codeOf = (error) => /^[A-Z_]+$/.test(error?.message) ? error.message : "LOCAL_IO_ERROR";
async function durable(path, value, exclusive = false, stateIO = { open, rename }) {
  const temporary = exclusive ? path : `${path}.${randomBytes(8).toString("hex")}`;
  const handle = await stateIO.open(temporary, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
  try { await handle.writeFile(`${JSON.stringify(value)}\n`); await handle.sync(); } finally { await handle.close(); }
  if (!exclusive) await stateIO.rename(temporary, path);
  const parent = await stateIO.open(join(path, ".."), constants.O_RDONLY | constants.O_DIRECTORY);
  try { await parent.sync(); } finally { await parent.close(); }
}
async function readPrivate(path) {
  const file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const s = await file.stat();
    requireValue(s.isFile() && s.uid === process.getuid() && (s.mode & 0o777) === 0o600 && s.size < 8_388_608, "INVALID_JOURNAL");
    return JSON.parse(await file.readFile("utf8"));
  } finally { await file.close(); }
}
function processAlive(pid) {
  requireValue(Number.isSafeInteger(pid) && pid > 0, "INVALID_JOURNAL");
  try { process.kill(pid, 0); return true; } catch (error) { requireValue(error.code === "ESRCH", "OWNER_UNCONFIRMED"); return false; }
}
async function reserve(root, reconcile, stateIO) {
  const names = (await readdir(root)).filter((name) => /^owner-[0-9]+\.json$/.test(name));
  if (!reconcile) requireValue(names.length === 0, "ADMISSION_CLOSED");
  else {
    requireValue(names.length > 0, "INVALID_JOURNAL");
    for (const name of names) requireValue(!processAlive((await readPrivate(join(root, name))).pid), "OWNER_LIVE");
  }
  // Concurrent callers select the same next ticket; exclusive creation admits only one.
  const index = names.length ? Math.max(...names.map((name) => Number(name.slice(6, -5)))) + 1 : 0;
  try { await durable(join(root, `owner-${index}.json`), { pid: process.pid }, true, stateIO); }
  catch (error) { if (error.code === "EEXIST") throw new Error("ADMISSION_CLOSED"); throw new Error("STATE_PERSISTENCE_FAILED"); }
  return index;
}
export function createArguments(record, pin) {
  return ["create", "--pull", "never", "--platform", "linux/amd64", "--name", record.name,
    "--label", `${label}=${record.id}`, "--init", "--network", "none", "--read-only", "--restart", "no",
    "--cap-drop", "ALL", ...["CHOWN", "DAC_OVERRIDE", "SETUID", "SETGID", "KILL"].flatMap((cap) => ["--cap-add", cap]),
    "--security-opt", "no-new-privileges", "--tmpfs", "/run:rw,noexec,nosuid,nodev,mode=0755",
    "--tmpfs", "/tmp:rw,nosuid,nodev,mode=1777", "--mount", `type=volume,src=${record.volume},dst=/opt/data`,
    pin.image, ...fixtures[record.fixture]];
}

export async function ownLifecycle(args, fixtureName, {
  control, send, reconcile = false, spawnProcess = spawn, lstatPath = lstat,
  stateIO = { open, rename },
  timeoutMs = 120_000, commandTimeoutMs = 60_000, pollMs = 250,
} = {}) {
  const options = parseArguments(args);
  requireValue(process.platform !== "win32" && typeof process.getuid === "function", "UNSUPPORTED_HOST");
  requireValue(Object.hasOwn(fixtures, fixtureName), "INVALID_FIXTURE");
  await checkPaths(options, lstatPath);
  const pin = await readPin();
  const attempt = await reserve(options.stateRoot, reconcile, stateIO);
  const journal = join(options.stateRoot, "operation.json");
  const fingerprint = createHash("sha256").update(JSON.stringify([options.executable, options.host, options.daemonId, pin.image])).digest("hex");
  const authorityFingerprint = createHash("sha256").update(JSON.stringify([options.executable, options.daemonId, pin.image])).digest("hex");
  let record; let cleaningUp = false; let persistenceFailed = false;
  const persistenceError = (cause) => Object.assign(new Error("STATE_PERSISTENCE_FAILED", { cause }), { result: record });
  const save = async (path, value, exclusive = false) => {
    try { await durable(path, value, exclusive, stateIO); }
    catch {
      persistenceFailed = true;
      if (record) Object.assign(record, { persistenceFailed: true, evidencePersisted: false,
        cliEvidencePersisted: false, cleanup: "unknown", outcome: "failed" });
      if (!cleaningUp) throw persistenceError();
    }
  };
  if (reconcile) {
    record = await readPrivate(journal);
    requireValue(record.version === 1 && /^[a-f0-9]{32}$/.test(record.id) && hex.test(record.fingerprint)
      && record.authorityFingerprint === authorityFingerprint
      && /^skyturn-hlc-[a-f0-9]{32}$/.test(record.name) && record.volume === `${record.name}-data`
      && Object.hasOwn(fixtures, record.fixture) && (record.cid === undefined || hex.test(record.cid))
      && Array.isArray(record.commands), "INVALID_JOURNAL");
    // A process death before a CLI close receipt cannot be retroactively proven reaped.
    record.historicalCliUnknown ||= record.commands.some((entry) => !entry.closed);
    // Recovery may explicitly select another validated socket, but cannot change authority or launch.
    record.reconcileFingerprint = fingerprint;
    persistenceFailed = record.persistenceFailed === true;
  } else {
    const id = randomBytes(16).toString("hex"); const name = `skyturn-hlc-${randomBytes(16).toString("hex")}`;
    record = { version: 1, id, fingerprint, authorityFingerprint, name, volume: `${name}-data`,
      fixture: fixtureName, commands: [], cleanup: "unknown", outcome: "failed" };
    await save(journal, record, true);
  }
  Object.assign(record, { finished: false, cleanup: "unknown", containerCleanup: "unknown",
    evidencePersisted: false, cliEvidencePersisted: false });
  const persist = () => save(journal, record);
  const ownedCommands = [];
  let reason; let input = ""; let waiter; let prepared = false; let launched = false; let armed = false;
  let controlFailure;
  const emit = (value) => { try { send(value); } catch { /* Lost consumers never bypass cleanup. */ } };
  const cancel = (value) => { reason ??= value; waiter?.(); };
  const onData = (chunk) => {
    input += chunk.toString("utf8");
    if (input.length > 64) { input = ""; control.pause(); cancel("invalid_control"); return; }
    while (input.includes("\n")) {
      const index = input.indexOf("\n"); const line = input.slice(0, index); input = input.slice(index + 1);
      if (line === "prepare" && !prepared) prepared = true;
      else if (line === "launch" && armed && !launched) launched = true;
      else cancel(line === "cancel" ? "cancelled" : "invalid_control");
      waiter?.();
    }
  };
  control.on("data", onData); control.on("end", () => cancel("controller_eof"));
  control.on("error", () => cancel("controller_eof"));
  if (control.readableEnded || control.destroyed) cancel("controller_eof");
  let deadline = setTimeout(() => cancel("start_timeout"), 120_000);
  const waitFor = async (condition) => {
    while (!condition() && !reason) await new Promise((resolve) => { waiter = resolve; });
    waiter = undefined; requireValue(!reason, "CONTROL_ABORTED");
  };
  let config; let home;
  const command = async (stage, commandArgs, { allowFailure = false } = {}) => {
    requireValue(cleaningUp || !persistenceFailed, "STATE_PERSISTENCE_FAILED");
    await checkPaths(options, lstatPath);
    const entry = { stage, closed: false }; record.commands.push(entry); await persist();
    let commandError;
    ownedCommands.push(entry);
    try {
      return await dockerCommand(options.executable, ["--host", options.host, "--config", config, ...commandArgs],
        { cwd: options.stateRoot, shell: false, stdio: ["ignore", "pipe", "pipe"],
          env: { HOME: home, DOCKER_CONFIG: config, PATH: "/usr/bin:/bin", LANG: "C", LC_ALL: "C" } },
        entry, { spawnProcess, scheduleTimeout: setTimeout }, commandTimeoutMs);
    } catch (error) {
      commandError = error;
      entry.failure = codeOf(error);
      if (!allowFailure) throw error;
      return undefined;
    } finally {
      try { await persist(); } catch (error) { if (!commandError) throw error; }
    }
  };
  const daemon = async () => {
    const out = await command("daemon", ["info", "--format", "{{json .ID}}"]);
    let id; try { id = JSON.parse(out); } catch { /* Reject malformed daemon data. */ }
    requireValue(id === options.daemonId, "DAEMON_MISMATCH");
  };
  const find = async () => {
    const ids = (await command("find", ["ps", "--all", "--no-trunc", "--filter", `name=^/${record.name}$`, "--format", "{{.ID}}"])).trim();
    requireValue(ids === "" || hex.test(ids), "OWNERSHIP_CONFLICT");
    return ids || undefined;
  };
  const inspect = async (id) => {
    requireValue(hex.test(id), "OWNERSHIP_CONFLICT");
    const out = await command("inspect", ["inspect", "--type", "container", id]);
    const entries = JSON.parse(out); const c = entries?.[0];
    requireValue(entries.length === 1 && c?.Id === id && c.Name === `/${record.name}`
      && (record.cid === undefined || record.cid === id)
      && [pin.imageId, pin.manifestDescriptor.digest].includes(c.Image)
      && c.Config?.Image === pin.image && equal(c.Config.Entrypoint, pin.entrypoint)
      && equal(c.Config.Cmd, fixtures[record.fixture]) && equal(c.Config.Labels, { [label]: record.id }), "OWNERSHIP_CONFLICT");
    requireValue(c.State && typeof c.State.Running === "boolean" && Number.isInteger(c.State.Pid)
      && Number.isInteger(c.State.ExitCode) && typeof c.State.StartedAt === "string"
      && typeof c.State.FinishedAt === "string", "INVALID_CONTAINER_STATE");
    await save(join(options.stateRoot, "inspect.json"), c);
    return c;
  };
  const terminal = (c) => !c.State.Running && c.State.Pid === 0 && ["exited", "created"].includes(c.State.Status);
  const cleanup = async () => {
    if (!record.createIntent) { record.containerCleanup = "confirmed"; return; }
    await daemon();
    const id = record.cid ?? await find();
    // A failed create without a receipt can still be executing on the daemon.
    requireValue(id !== undefined, "CREATE_UNCONFIRMED");
    let c = await inspect(id); record.cid = id; await persist();
    if (!terminal(c)) {
      await command("stop", ["stop", "--time", "1", id], { allowFailure: true });
      await daemon(); c = await inspect(id);
    }
    requireValue(terminal(c), "STOP_UNCONFIRMED");
    requireValue(!record.startIntent || c.State.Status === "exited", "START_UNCONFIRMED");
    record.containerTerminal = Object.fromEntries(["Status", "Running", "Pid", "ExitCode", "StartedAt", "FinishedAt"].map((key) => [key, c.State[key]]));
    record.containerCleanup = "confirmed";
  };
  let operationError;
  try {
    // Set up cleanup's client context even if the controller disappears before prepare.
    home = join(options.stateRoot, `home-${attempt}`); config = join(options.stateRoot, `config-${attempt}`);
    for (const path of [home, config]) await mkdir(path, { mode: 0o700 });
    emit({ kind: "ready", ownerPid: process.pid });
    await waitFor(() => prepared);
    await daemon();
    verifyImage(await command("image", ["image", "inspect", pin.image]), pin);
    if (reconcile) { reason = "reconcile"; }
    else {
      requireValue(!await find(), "OWNERSHIP_CONFLICT");
      const volumes = await command("volume-find", ["volume", "ls", "--filter", `name=^${record.volume}$`, "--format", "{{.Name}}"]);
      requireValue(volumes.trim() === "", "OWNERSHIP_CONFLICT");
      armed = true; emit({ kind: "armed", name: record.name, volume: record.volume });
      await waitFor(() => launched);
      requireValue(!reason, "CONTROL_ABORTED");
      await command("volume-create", ["volume", "create", "--driver", "local", "--label", `${label}=${record.id}`, record.volume]);
      const volumesReadback = JSON.parse(await command("volume-inspect", ["volume", "inspect", record.volume]));
      const v = volumesReadback?.[0];
      requireValue(volumesReadback.length === 1 && v?.Name === record.volume && v.Driver === "local"
        && equal(v.Options ?? {}, {}) && equal(v.Labels, { [label]: record.id }), "OWNERSHIP_CONFLICT");
      requireValue(!reason, "CONTROL_ABORTED");
      record.createIntent = true; await persist();
      const receipt = (await command("create", createArguments(record, pin))).trim();
      requireValue(hex.test(receipt), "INVALID_CREATE_RECEIPT");
      record.cid = receipt; await persist();
      await inspect(receipt);
      requireValue(!reason, "CONTROL_ABORTED");
      await daemon();
      requireValue(!reason, "CONTROL_ABORTED");
      record.startIntent = true; await persist();
      await command("start", ["start", receipt]);
      let c = await inspect(receipt);
      requireValue(c.State.Status !== "created" && !c.State.StartedAt.startsWith("0001-"), "START_UNCONFIRMED");
      record.accepted = true; await persist();
      clearTimeout(deadline); deadline = setTimeout(() => cancel("timeout"), timeoutMs);
      emit({ kind: "running", cid: receipt });
      while (!reason && !terminal(c)) {
        await new Promise((resolve) => { const timer = setTimeout(resolve, pollMs); waiter = () => { clearTimeout(timer); resolve(); }; });
        waiter = undefined;
        if (!reason) { await daemon(); c = await inspect(receipt); }
      }
      if (!reason) {
        reason = "natural"; record.taskExitCode = c.State.ExitCode;
        const logs = await command("fixture-logs", ["logs", receipt]);
        await save(join(options.stateRoot, "fixture-output.json"), { stdout: logs });
      }
    }
  } catch (error) { operationError = error; controlFailure = codeOf(error); reason ??= "failed"; }
  finally {
    record.reason = reason ?? "failed";
    if (controlFailure) record.failure ??= controlFailure;
    // This is the only cleanup path. No task output can enter it as protocol.
    // Diagnostic writes may fail throughout cleanup, but validation and actual client close remain mandatory.
    cleaningUp = true;
    try { await cleanup(); } catch (error) { record.cleanupFailure = codeOf(error); }
    clearTimeout(deadline); control.removeListener("data", onData);
    record.cliClosed = ownedCommands.every((entry) => entry.closed) && !record.historicalCliUnknown;
    record.cleanup = record.containerCleanup === "confirmed" && record.cliClosed && !persistenceFailed ? "confirmed" : "unknown";
    record.outcome = record.reason === "natural" && !controlFailure && record.taskExitCode === 0
      && record.cleanup === "confirmed" && record.cliClosed ? "succeeded" : "failed";
    record.finished = true;
    // Disk snapshots are unacknowledged drafts. Only completion of every final write permits an acknowledgement.
    await persist(); await save(join(options.stateRoot, `terminal-${attempt}.json`), record, true);
    if (persistenceFailed) { await persist(); throw persistenceError(operationError); }
    record.evidencePersisted = true; record.cliEvidencePersisted = true;
    emit({ kind: "terminal", result: record });
  }
  return record;
}
