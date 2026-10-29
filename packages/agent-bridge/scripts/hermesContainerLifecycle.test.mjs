import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { spawn, spawnSync } from "node:child_process";
import { createWriteStream } from "node:fs";
import { Socket } from "node:net";
import { existsSync } from "node:fs";
import { lstat, mkdtemp, open, readFile, realpath, rename, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { PassThrough } from "node:stream";
import test from "node:test";
import { fileURLToPath } from "node:url";

const source = new URL("./hermesContainerLifecycle.mjs", import.meta.url);
const scratch = tmpdir();
const pin = JSON.parse(await readFile(new URL("../runtime/hermes-image.json", import.meta.url)));
const cid = "a".repeat(64);
const posixTest = (name, fn) => test(name, { skip: process.platform === "win32" }, fn);
async function fixture() {
  const root = await realpath(await mkdtemp(join(scratch, "lifecycle-test-")));
  const executable = join(root, "docker"); const socket = join(root, "docker.sock");
  await writeFile(executable, "", { mode: 0o700 }); await writeFile(socket, "fixture");
  const args = ["--docker-executable", executable, "--docker-host", `unix://${socket}`,
    "--expected-daemon-id", "test-daemon", "--state-root", root];
  const lstatPath = async (path) => { const s = await lstat(path); if (path === socket) s.isSocket = () => true; return s; };
  return { root, args, lstatPath };
}
async function run(f, fault = {}, control = new PassThrough(), externalSend) {
  assert.ok(existsSync(source), "experimental lifecycle implementation must exist");
  const { ownLifecycle } = await import(source.href);
  const calls = []; let container = fault.container; let volume; let pending; let kills = 0;
  const status = [];
  const send = (value) => {
    status.push(value);
    if (externalSend) { externalSend(value); return; }
    if (value.kind === "ready") control.write("prepare\n");
    if (value.kind === "armed") {
      fault.armed?.(value, control);
      control.write("launch\n");
    }
    if (value.kind === "running") {
      fault.running?.(container);
      if (fault.cancel) control.end();
      if (fault.daemonLoss) fault.unavailable = true;
    }
  };
  const spawnProcess = (executable, argv, options) => {
    assert.equal(executable, f.args[1]);
    assert.deepEqual(Object.keys(options.env).sort(), ["DOCKER_CONFIG", "HOME", "LANG", "LC_ALL", "PATH"]);
    assert.deepEqual(options.stdio, ["ignore", "pipe", "pipe"]);
    assert.equal(options.shell, false);
    const a = argv.slice(4); calls.push(a);
    fault.command?.(a);
    const child = new EventEmitter(); child.stdout = new PassThrough(); child.stderr = new PassThrough();
    child.kill = () => { kills++; fault.killed?.(child); return false; };
    pending = child;
    queueMicrotask(() => {
      let out = ""; let code = 0;
      if (fault.unavailable) code = 1;
      else if (a[0] === "info") out = JSON.stringify(fault.wrongDaemon ? "wrong" : "test-daemon");
      else if (a[0] === "image") out = JSON.stringify([{ Id: pin.imageId, RepoDigests: [pin.image], Os: "linux", Architecture: "amd64",
        Config: { Volumes: { "/opt/data": {} }, Entrypoint: pin.entrypoint, Labels: {}, User: "root", WorkingDir: "/opt/hermes" } }]);
      else if (a[0] === "volume" && a[1] === "ls") out = "";
      else if (a[0] === "volume" && a[1] === "create") {
        volume = { Name: a.at(-1), Driver: "local", Options: null, Labels: Object.fromEntries(a.flatMap((v, i) => v === "--label" ? [a[i + 1].split("=")] : [])) };
        out = volume.Name;
      } else if (a[0] === "volume") out = JSON.stringify([volume]);
      else if (a[0] === "ps") out = container ? `${cid}\n` : "";
      else if (a[0] === "create") {
        const value = (key) => a[a.indexOf(key) + 1];
        container = { Id: cid, Name: `/${value("--name")}`, Image: pin.imageId,
          Config: { Image: pin.image, Entrypoint: pin.entrypoint, Cmd: a.slice(a.indexOf(pin.image) + 1),
            Labels: Object.fromEntries(a.flatMap((v, i) => v === "--label" ? [a[i + 1].split("=")] : [])) },
          State: { Status: "created", Running: false, Pid: 0, ExitCode: 0, StartedAt: "0001-01-01T00:00:00Z", FinishedAt: "0001-01-01T00:00:00Z" } };
        if (fault.conflict) container.Config.Labels = {};
        if (fault.createFailure) code = 1; else out = cid;
      } else if (a[0] === "start") {
        container.State = { Status: "running", Running: true, Pid: 42, ExitCode: 0, StartedAt: "2026-10-29T01:00:00Z", FinishedAt: "0001-01-01T00:00:00Z" };
        if (fault.startFailure) code = 1;
      } else if (a[0] === "inspect") {
        if (!fault.cancel && !fault.hold && container.State.Running) container.State = { ...container.State, Status: "exited", Running: false, Pid: 0, ExitCode: fault.taskExit ?? 0, FinishedAt: "2026-10-29T01:00:01Z" };
        if (fault.errorText) container.State.Error = fault.errorText;
        out = JSON.stringify([container]);
      } else if (a[0] === "stop") { if (!fault.stuck) container.State = { ...container.State, Status: "exited", Running: false, Pid: 0, ExitCode: 143, FinishedAt: "2026-10-29T01:00:01Z" }; }
      else if (a[0] === "logs") out = fault.logText ?? "SKYTURN_FIXTURE_BOOTSTRAP_OK\n";
      else assert.fail(`Unexpected Docker command ${a[0]}`);
      if (fault.delay === a[0]) { fault.delayed?.(child); return; }
      child.stdout.end(out); child.stderr.end(); child.emit("close", code, null);
    });
    return child;
  };
  let result; let error;
  try {
    result = await ownLifecycle(f.args, "bootstrap", { control, send, spawnProcess, lstatPath: f.lstatPath,
      timeoutMs: fault.timeoutMs ?? 5000, commandTimeoutMs: fault.commandTimeoutMs ?? 1000, pollMs: 1,
      ...(fault.reconcile ? { reconcile: true } : {}), ...(fault.stateIO ? { stateIO: fault.stateIO } : {}) });
  } catch (cause) { if (!fault.captureFailure) throw cause; error = cause; result = cause.result; }
  return { result, error, calls, status, pending, kills, container };
}

// Exercise real private writes, file/directory fsync, and rename, failing only the selected boundary.
function persistenceFault(root, phase, shouldFail) {
  let failures = 0; const payloads = new Map();
  const fail = (operation, path) => {
    if (operation !== phase || !shouldFail(path, payloads.get(path))) return;
    failures++;
    throw Object.assign(new Error("PRIVATE_IO_FAILURE"), { code: operation === "write" ? "ENOSPC" : "EIO" });
  };
  return { get failures() { return failures; },
    async open(path, ...args) {
      const handle = await open(path, ...args);
      return {
        async writeFile(text) { payloads.set(path, JSON.parse(text)); fail("write", path); return handle.writeFile(text); },
        async sync() { fail(path === root ? "directory-sync" : "file-sync", path); return handle.sync(); },
        close: () => handle.close(),
      };
    },
    async rename(from, to) { fail("rename", from); return rename(from, to); },
  };
}

// Real controller and detached owner processes; only the Docker boundary is offline.
if (process.argv[2] === "--offline-owner") {
  const payload = JSON.parse(process.argv[3]); const f = { args: payload.args };
  f.lstatPath = async (path) => { const s = await lstat(path); if (path === f.args[3].slice(7)) s.isSocket = () => true; return s; };
  const control = new Socket({ fd: 3, readable: true, writable: false });
  const status = createWriteStream(null, { fd: 4 });
  status.on("error", () => control.emit("data", Buffer.from("cancel\n")));
  await run(f, { hold: true, timeoutMs: 10_000 }, control, (v) => { if (!status.destroyed) status.write(`${JSON.stringify(v)}\n`); });
  control.destroy(); status.end();
  process.exitCode = 0;
} else if (process.argv[2] === "--offline-controller") {
  const payload = JSON.parse(process.argv[3]);
  const { startController } = await import("./managedHermesContainer.mjs");
  const handle = startController(payload.args, "bootstrap", {
    spawnProcess: (_exe, argv, options) => spawn(process.execPath, [fileURLToPath(import.meta.url), "--offline-owner", argv.at(-1)], options),
    onStatus: async (v) => { if (v.kind === "running") await writeFile(join(payload.args[7], "controller-ready"), "ready"); },
  });
  await handle.closed;
} else {

posixTest("launches only receipt CID after ready/armed; fixed entrypoint, isolation, no inherited control fd", async () => {
  const f = await fixture(); const { result, calls, status } = await run(f);
  assert.equal(result.cleanup, "confirmed"); assert.equal(result.taskExitCode, 0); assert.equal(result.outcome, "succeeded");
  assert.equal(result.evidencePersisted, true); assert.equal(result.cliEvidencePersisted, true);
  assert.equal(result.finished, true);
  assert.equal(JSON.parse(await readFile(join(f.root, "terminal-0.json"))).id, result.id);
  assert.ok(!result.name.includes(result.id), "ownership label must not be derivable from the public name");
  assert.deepEqual(status.slice(0, 2).map((x) => x.kind), ["ready", "armed"]);
  assert.deepEqual(calls.find((a) => a[0] === "start"), ["start", cid]);
  const create = calls.find((a) => a[0] === "create");
  for (const flag of ["--init", "--read-only", "--pull", "--restart", "--network", "--cap-drop"]) assert.ok(create.includes(flag));
  assert.equal(create[create.indexOf("--pull") + 1], "never"); assert.equal(create[create.indexOf("--network") + 1], "none");
  assert.ok(!create.includes("--entrypoint") && !create.includes("--privileged") && !create.includes("--volume"));
  assert.ok(result.commands.every((x) => x.closed));
  await assert.rejects(run(f), /ADMISSION_CLOSED/);
});
posixTest("create before receipt failure discovers owned object for cleanup but never starts it", async () => {
  const { result, calls } = await run(await fixture(), { createFailure: true });
  assert.equal(result.cleanup, "confirmed"); assert.equal(result.outcome, "failed"); assert.equal(result.cid, cid);
  assert.ok(!calls.some((a) => a[0] === "start"));
});
posixTest("conflicting ownership quarantines and never starts or stops the collision", async () => {
  const { result, calls } = await run(await fixture(), { createFailure: true, conflict: true });
  assert.equal(result.cleanup, "unknown"); assert.equal(result.outcome, "failed");
  assert.ok(!calls.some((a) => ["start", "stop"].includes(a[0])));
});
posixTest("start failure preserves task versus transport outcome and cleans exact CID", async () => {
  const { result, calls } = await run(await fixture(), { startFailure: true, hold: true });
  assert.equal(result.cleanup, "confirmed"); assert.equal(result.outcome, "failed");
  assert.ok(calls.some((a) => a[0] === "stop" && a[3] === cid));
});
posixTest("EOF and deadline use the same exact-owned cleanup path", async () => {
  for (const fault of [{ cancel: true }, { hold: true, timeoutMs: 20 }]) {
    const { result, calls } = await run(await fixture(), fault);
    assert.equal(result.cleanup, "confirmed"); assert.ok(["controller_eof", "timeout"].includes(result.reason));
    assert.equal(calls.filter((a) => a[0] === "stop").length, 1);
  }
});
posixTest("daemon loss is unknown and one-shot admission remains closed", async () => {
  const f = await fixture(); const { result } = await run(f, { daemonLoss: true, hold: true });
  assert.equal(result.cleanup, "unknown"); assert.equal(result.outcome, "failed");
  await assert.rejects(run(f), /ADMISSION_CLOSED/);
});
posixTest("reconcile stops the orphan without relaunch; missing historical CLI close remains quarantined", async () => {
  const f = await fixture(); const { container } = await run(f, { daemonLoss: true, hold: true });
  const owner = join(f.root, "owner-0.json"); await writeFile(owner, JSON.stringify({ pid: 2147483647 }));
  const journal = join(f.root, "operation.json"); const record = JSON.parse(await readFile(journal));
  record.commands.push({ stage: "lost-before-close", closed: false }); await writeFile(journal, JSON.stringify(record));
  const { result, calls } = await run(f, { reconcile: true, container, hold: true });
  assert.equal(result.containerCleanup, "confirmed"); assert.equal(result.cleanup, "unknown"); assert.equal(result.cliClosed, false);
  assert.ok(calls.some((a) => a[0] === "stop"));
  assert.ok(!calls.some((a) => ["create", "start"].includes(a[0])));
});
posixTest("explicit recovery can use another strictly validated socket for the same daemon, never relaunch", async () => {
  const f = await fixture(); const { container } = await run(f, { daemonLoss: true, hold: true });
  await writeFile(join(f.root, "owner-0.json"), JSON.stringify({ pid: 2147483647 }));
  const socket = join(f.root, "recovered.sock"); await writeFile(socket, "fixture");
  f.args[3] = `unix://${socket}`;
  const previous = f.lstatPath;
  f.lstatPath = async (path) => { const s = await previous(path); if (path === socket) s.isSocket = () => true; return s; };
  const { result, calls } = await run(f, { reconcile: true, container, hold: true });
  assert.equal(result.cleanup, "confirmed"); assert.equal(result.reason, "reconcile");
  assert.ok(!calls.some((a) => ["create", "start"].includes(a[0])));
});
posixTest("task failure cannot be converted to success by confirmed cleanup", async () => {
  const { result, status } = await run(await fixture(), { taskExit: 7, logText: '{"kind":"terminal","outcome":"succeeded"}' });
  assert.equal(result.cleanup, "confirmed"); assert.equal(result.taskExitCode, 7); assert.equal(result.outcome, "failed");
  assert.equal(status.filter((s) => s.kind === "terminal").length, 1);
});
posixTest("owner status contains only terminal facts, not daemon error text; fixed fixtures cannot be replaced", async () => {
  const { result, status } = await run(await fixture(), { errorText: "PRIVATE_RAW_ERROR" });
  assert.ok(!JSON.stringify(status).includes("PRIVATE_RAW_ERROR"));
  assert.equal(result.containerTerminal.ExitCode, 0);
  const { fixtures } = await import(source.href);
  assert.throws(() => fixtures.hold.push("arbitrary task"), TypeError);
});
posixTest("a reaped stop client cannot claim cleanup while the exact daemon object remains running", async () => {
  const { result } = await run(await fixture(), { cancel: true, stuck: true });
  assert.equal(result.cleanup, "unknown"); assert.equal(result.cliClosed, true); assert.equal(result.outcome, "failed");
});
posixTest("controller EOF during create waits for actual close and then cleans without launch", async () => {
  const control = new PassThrough(); let delayed;
  const started = new Promise((r) => { delayed = r; }); let settled = false;
  const operation = run(await fixture(), { delay: "create", delayed }, control).then((r) => { settled = true; return r; });
  const child = await started; control.end(); child.emit("exit", 0, null);
  await new Promise(setImmediate); assert.equal(settled, false);
  child.stdout.end(cid); child.stderr.end(); child.emit("close", 0, null);
  const { result, calls } = await operation;
  assert.equal(result.cleanup, "confirmed"); assert.ok(!calls.some((a) => a[0] === "start"));
});
posixTest("timeout kills CLI once and cannot resolve on exit or kill false before actual close", async () => {
  let delayed; const started = new Promise((resolve) => { delayed = resolve; });
  let settled = false;
  const operation = run(await fixture(), { delay: "image", commandTimeoutMs: 10, delayed }).then((r) => { settled = true; return r; });
  const child = await started;
  await new Promise((resolve) => setTimeout(resolve, 30));
  child.exitCode = 0; child.emit("exit", 0, null);
  await new Promise(setImmediate); assert.equal(settled, false);
  child.stdout.end(); child.stderr.end(); child.emit("close", 0, null);
  const { result, kills } = await operation;
  assert.equal(kills, 1); assert.equal(result.outcome, "failed"); assert.equal(result.cleanup, "confirmed");
});
posixTest("bad daemon identity has no volume/container side effects", async () => {
  const { result, calls } = await run(await fixture(), { wrongDaemon: true });
  assert.equal(result.outcome, "failed"); assert.ok(!calls.some((a) => ["volume", "create", "start"].includes(a[0])));
});
for (const phase of ["write", "file-sync", "rename", "directory-sync"]) {
  posixTest(`persistent post-start ${phase} failure still stops once and awaits actual client close`, async () => {
    const f = await fixture(); let active = false;
    const stateIO = persistenceFault(f.root, phase, () => active);
    let delayed; const started = new Promise((r) => { delayed = r; });
    let settled = false;
    const operation = run(f, { hold: true, captureFailure: true, stateIO, running: () => { active = true; },
      delay: "stop", commandTimeoutMs: 60_000, delayed }).then((value) => { settled = true; return value; });
    // If a diagnostic write wrongly blocks stop, the original implementation rejects here first.
    const pending = await Promise.race([started, operation]);
    assert.ok(pending instanceof EventEmitter, "cleanup must attempt the exact-owned stop despite persistent diagnostic failure");
    pending.exitCode = 0; pending.emit("exit", 0, null);
    await new Promise(setImmediate); assert.equal(settled, false);
    pending.stdout.end(); pending.stderr.end(); pending.emit("close", 0, null);
    const { result, error, calls, status, container } = await operation;
    assert.ok(stateIO.failures >= 6, "failure must remain active through cleanup and final records");
    assert.equal(error?.message, "STATE_PERSISTENCE_FAILED");
    assert.equal(result.containerCleanup, "confirmed"); assert.equal(result.containerTerminal.Pid, 0);
    assert.equal(result.cleanup, "unknown"); assert.equal(result.outcome, "failed");
    assert.equal(result.cliClosed, true); assert.equal(result.cliEvidencePersisted, false);
    assert.equal(result.persistenceFailed, true); assert.equal(result.evidencePersisted, false);
    assert.equal(container.State.Running, false);
    assert.equal(calls.filter((a) => a[0] === "stop").length, 1);
    assert.equal(calls.filter((a) => a[0] === "start").length, 1);
    assert.ok(calls.filter((a) => a[0] === "inspect").length >= 3, "cleanup must observe terminal daemon readback");
    assert.ok(!status.some((event) => event.kind === "terminal"));
    await assert.rejects(run(f), /ADMISSION_CLOSED/);
  });
}
for (const point of ["pre-command", "post-command", "inspect", "post-start-inspect", "cid", "cleanup-cid", "final-operation", "final-terminal"]) {
  posixTest(`latched ${point} persistence failure preserves physical cleanup and the original start cause`, async () => {
    const f = await fixture(); let running = false; let trigger = false;
    const stateIO = persistenceFault(f.root, "write", (path, value) => {
      if (trigger) return true;
      const entry = value?.commands?.at(-1);
      trigger = point === "pre-command" ? running && path.includes("operation.json") && entry?.stage === "daemon" && !entry.closed
        : point === "post-command" ? path.includes("operation.json") && entry?.stage === "start" && entry.closed
        : point === "inspect" ? running && path.includes("inspect.json")
        : point === "post-start-inspect" ? path.includes("inspect.json") && value?.State?.Running === true
        : ["cid", "cleanup-cid"].includes(point) ? path.includes("operation.json") && value?.cid === cid && !value?.startIntent
        : point === "final-operation" ? path.includes("operation.json") && value?.finished === true
        : path.includes("terminal-0.json");
      return trigger;
    });
    const { result, error, calls, status, container } = await run(f, { hold: true, cancel: true, captureFailure: true, stateIO,
      running: () => { running = true; }, startFailure: point === "post-command", createFailure: point === "cleanup-cid" });
    assert.ok(trigger); assert.equal(error?.message, "STATE_PERSISTENCE_FAILED");
    assert.equal(result?.containerCleanup, "confirmed", "diagnostic writes must never gate physical cleanup");
    assert.equal(result.cleanup, "unknown"); assert.equal(result.outcome, "failed");
    assert.equal(result.cliClosed, true); assert.equal(result.cliEvidencePersisted, false);
    assert.equal(result.evidencePersisted, false); assert.equal(result.persistenceFailed, true);
    // Readable bytes after a failed final fsync/rename are not a durability acknowledgement.
    const draft = JSON.parse(await readFile(join(f.root, "operation.json")));
    assert.equal(draft.evidencePersisted, false); assert.equal(draft.cliEvidencePersisted, false);
    assert.ok(!status.some((event) => event.kind === "terminal"));
    assert.equal(container.State.Running, false);
    assert.equal(calls.filter((a) => a[0] === "stop").length, ["cid", "cleanup-cid"].includes(point) ? 0 : 1);
    if (["post-command", "cleanup-cid"].includes(point)) {
      assert.equal(result.failure, "COMMAND_FAILED"); assert.equal(error.cause?.message, "COMMAND_FAILED");
    }
    await assert.rejects(run(f), /ADMISSION_CLOSED/);
  });
}
posixTest("failed pre-start durable gate never launches and cleanup still diagnoses the exact created object", async () => {
  const f = await fixture();
  const stateIO = persistenceFault(f.root, "write", (path, value) => path.includes("operation.json") && value?.startIntent);
  const { result, error, calls } = await run(f, { stateIO, captureFailure: true });
  assert.equal(error?.message, "STATE_PERSISTENCE_FAILED");
  assert.ok(!calls.some((a) => a[0] === "start")); assert.equal(calls.filter((a) => a[0] === "inspect").length, 2);
  assert.equal(result.cleanup, "unknown"); assert.equal(result.cliClosed, true);
});
for (const gate of ["initial-operation", "create"]) {
  posixTest(`failed ${gate} durable gate cannot launch or release the ownership reservation`, async () => {
    const f = await fixture();
    const stateIO = persistenceFault(f.root, "write", (path, value) => path.includes("operation.json")
      && (gate === "initial-operation" || value?.commands?.at(-1)?.stage === "create"));
    const { result, error, calls } = await run(f, { captureFailure: true, stateIO });
    assert.equal(error?.message, "STATE_PERSISTENCE_FAILED"); assert.equal(result?.persistenceFailed, true);
    assert.ok(!calls.some((a) => ["create", "start"].includes(a[0])));
    if (gate === "initial-operation") assert.equal(calls.length, 0);
    await assert.rejects(run(f), /ADMISSION_CLOSED/);
  });
}
for (const taskExit of [0, 7]) {
  posixTest(`fixture-output persistence failure retains task exit ${taskExit} without success`, async () => {
    const f = await fixture(); const stateIO = persistenceFault(f.root, "write", (path) => path.includes("fixture-output.json"));
    const { result, error, status } = await run(f, { stateIO, captureFailure: true, taskExit });
    assert.equal(error?.message, "STATE_PERSISTENCE_FAILED"); assert.equal(result.taskExitCode, taskExit);
    assert.equal(result.containerCleanup, "confirmed"); assert.equal(result.outcome, "failed");
    assert.equal(result.cleanup, "unknown"); assert.ok(!status.some((s) => s.kind === "terminal"));
  });
}
for (const target of ["inspect.json", "terminal-0.json"]) {
  posixTest(`one recovered ${target} write failure stays latched and cannot acknowledge success`, async () => {
    const f = await fixture(); let active = false; let fired = false;
    const stateIO = persistenceFault(f.root, "write", (path) => {
      if (active && !fired && path.includes(target)) { fired = true; return true; } return false;
    });
    const { result, error, status } = await run(f, { hold: true, cancel: true, captureFailure: true, stateIO, running: () => { active = true; } });
    assert.equal(stateIO.failures, 1); assert.equal(error?.message, "STATE_PERSISTENCE_FAILED");
    assert.equal(result.containerCleanup, "confirmed"); assert.equal(result.cliClosed, true);
    assert.ok(!status.some((event) => event.kind === "terminal"));
    const persisted = JSON.parse(await readFile(join(f.root, "operation.json")));
    assert.equal(persisted.persistenceFailed, true); assert.equal(persisted.cleanup, "unknown");
    assert.equal(persisted.outcome, "failed"); assert.equal(persisted.evidencePersisted, false);
  });
}
for (const mismatch of ["cid", "image", "labels", "fixture", "daemon", "executable", "socket"]) {
  posixTest(`cleanup after persistent write failure still rejects ${mismatch} mismatch`, async () => {
    const f = await fixture(); let active = false; let unsafe = false;
    const originalLstat = f.lstatPath;
    f.lstatPath = async (path) => {
      const stat = await originalLstat(path);
      if (unsafe && mismatch === "executable" && path === f.args[1]) stat.isFile = () => false;
      if (unsafe && mismatch === "socket" && path === f.args[3].slice(7)) stat.isSocket = () => false;
      return stat;
    };
    const stateIO = persistenceFault(f.root, "write", () => { if (active) unsafe = true; return active; });
    const fault = { hold: true, captureFailure: true, stateIO, running: (container) => {
      active = true;
      if (mismatch === "cid") container.Id = "b".repeat(64);
      if (mismatch === "image") container.Image = "sha256:" + "b".repeat(64);
      if (mismatch === "labels") container.Config.Labels = {};
      if (mismatch === "fixture") container.Config.Cmd = ["arbitrary"];
      if (mismatch === "daemon") fault.wrongDaemon = true;
    } };
    const { result, error, calls } = await run(f, fault);
    assert.ok(stateIO.failures > 0); assert.equal(error?.message, "STATE_PERSISTENCE_FAILED");
    assert.equal(result.cleanup, "unknown"); assert.equal(result.containerCleanup, "unknown");
    assert.ok(!calls.some((a) => a[0] === "stop"), "persistence recovery must never relax private path or exact ownership gates");
  });
}
posixTest("fixed shell fixtures parse and acceptance is an executable reviewed-endpoint command", async () => {
  const { fixtures } = await import(source.href);
  for (const fixture of Object.values(fixtures)) assert.equal(spawnSync("/bin/sh", ["-n", "-c", fixture[2]]).status, 0);
  const acceptance = new URL("./acceptHermesContainerLifecycle.mjs", import.meta.url);
  assert.ok(existsSync(acceptance), "real acceptance command must exist");
  const rejected = spawnSync(process.execPath, [fileURLToPath(acceptance), "--skip-validation"], { env: {}, encoding: "utf8" });
  assert.equal(rejected.status, 1); assert.equal(rejected.stdout, ""); assert.equal(JSON.parse(rejected.stderr).code, "INVALID_ARGUMENTS");
});
posixTest("real detached owner cleans after controller SIGKILL and lost status consumer", async () => {
  const controllerSource = new URL("./managedHermesContainer.mjs", import.meta.url);
  assert.ok(existsSync(controllerSource), "independent controller implementation must exist");
  const f = await fixture();
  const child = spawn(process.execPath, [fileURLToPath(import.meta.url), "--offline-controller", JSON.stringify({ args: f.args })],
    { stdio: ["ignore", "pipe", "pipe"], env: { PATH: "/usr/bin:/bin" } });
  const closed = new Promise((resolve) => child.once("close", resolve));
  const wait = async (predicate) => {
    const until = Date.now() + 15_000;
    while (Date.now() < until) { try { const result = await predicate(); if (result) return result; } catch {} await new Promise((r) => setTimeout(r, 30)); }
    assert.fail("owner state did not converge");
  };
  await wait(() => readFile(join(f.root, "controller-ready")));
  child.kill("SIGKILL"); await closed;
  const final = await wait(async () => { const r = JSON.parse(await readFile(join(f.root, "operation.json"))); return r.cleanup === "confirmed" && r.containerTerminal ? r : undefined; });
  assert.equal(final.cliClosed, true); assert.equal(final.outcome, "failed");
  assert.ok(["controller_eof", "cancelled"].includes(final.reason));
  assert.equal(final.commands.filter((x) => x.stage === "stop").length, 1);
});
}
