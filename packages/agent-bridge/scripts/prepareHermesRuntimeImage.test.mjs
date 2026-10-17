import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { EventEmitter } from "node:events";
import { existsSync, readdirSync } from "node:fs";
import { chmod, lstat, mkdir, mkdtemp, readFile, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import test from "node:test";
import { fileURLToPath } from "node:url";

const source = new URL("./prepareHermesRuntimeImage.mjs", import.meta.url);
const posixTest = (name, run) => test(name, {
  skip: process.platform === "win32" ? "Requires POSIX ownership, permissions, and Unix socket paths" : false,
}, run);
const image = "docker.io/nousresearch/hermes-agent@sha256:a11574b7fe8e1631d7d88d556677dac693bc058abf558cdeb899155688c1bf05";
const imageId = "sha256:02e7aa0e84123fa0e9b22686e7a2bfb7d85fd59821d4d28812a3e07f3061cf41";
const inspection = () => [{ Id: imageId, RepoDigests: [image.replace("docker.io/", "")], Os: "linux", Architecture: "amd64",
  Config: { Volumes: { "/opt/data": {} }, Entrypoint: ["/opt/hermes/docker/entrypoint-dispatch.sh"], Labels: null, User: "root", WorkingDir: "/opt/hermes" } }];
async function prepare(...args) {
  assert.ok(existsSync(source), "preparation script must exist");
  return (await import(source.href)).prepareHermesRuntimeImage(...args);
}
async function fixture(t) {
  const root = await realpath(await mkdtemp(join(tmpdir(), "skyturn-image-")));
  t.after(() => rm(root, { recursive: true, force: true }));
  const executable = join(root, "docker");
  const socket = join(root, "daemon.sock");
  const state = join(root, "state");
  await writeFile(executable, "", { mode: 0o700 });
  await writeFile(socket, "socket type fixture only");
  await mkdir(state, { mode: 0o700 });
  const args = ["--docker-executable", executable, "--docker-host", `unix://${socket}`, "--expected-daemon-id", "test-daemon", "--state-root", state];
  // Classify a local fixture without creating or connecting to any socket.
  const lstatPath = async (path) => { const stat = await lstat(path); if (path === socket && stat.isFile()) stat.isSocket = () => true; return stat; };
  return { root, executable, socket, state, args, lstatPath };
}
function child() {
  const value = new EventEmitter();
  value.stdout = new PassThrough(); value.stderr = new PassThrough();
  value.kill = () => true;
  return value;
}
function boundary(f, outputs = ["\"test-daemon\"", "pulled", JSON.stringify("test-daemon"), JSON.stringify(inspection())], afterClose = () => {}) {
  const calls = [];
  return { calls, lstatPath: f.lstatPath, spawnProcess: (executable, args, options) => {
    const index = calls.length; calls.push({ executable, args, options });
    const value = child();
    queueMicrotask(() => { value.stdout.end(outputs[index]); value.stderr.end(); value.emit("close", 0, null); afterClose(index); });
    return value;
  } };
}
async function failure(f, dependencies, code) {
  await assert.rejects(prepare(f.args, dependencies), (error) => {
    assert.equal(error.code, code);
    assert.ok(!error.message.includes("PRIVATE_RAW_ERROR"));
    return true;
  });
  const directories = await readdirSync(f.state);
  assert.equal(directories.length, 1);
  const evidence = JSON.parse(await readFile(join(f.state, directories[0], "preparation.json"), "utf8"));
  assert.equal(evidence.status, "failed"); assert.equal(evidence.code, code);
  assert.equal(evidence.runtimeReady, false); assert.equal(evidence.plannerReady, false);
  return evidence;
}

posixTest("prepares only the immutable pin using explicit endpoint and empty isolated configuration", async (t) => {
  const f = await fixture(t); const io = boundary(f);
  const deadlines = [];
  io.scheduleTimeout = (callback, ms) => { deadlines.push(ms); return setTimeout(callback, ms); };
  process.env.SKYTURN_PREPARATION_TEST_SECRET = "PRIVATE_RAW_ERROR";
  t.after(() => { delete process.env.SKYTURN_PREPARATION_TEST_SECRET; });
  const spawnProcess = io.spawnProcess;
  io.spawnProcess = (executable, args, options) => {
    assert.deepEqual(Object.keys(options.env).sort(), ["DOCKER_CONFIG", "HOME", "LANG", "LC_ALL", "PATH"]);
    assert.deepEqual(readdirSync(options.env.HOME), []);
    assert.deepEqual(readdirSync(options.env.DOCKER_CONFIG), []);
    assert.equal(options.shell, false); assert.deepEqual(options.stdio, ["ignore", "pipe", "pipe"]);
    return spawnProcess(executable, args, options);
  };
  const result = await prepare(f.args, io);
  assert.equal(result.status, "prepared"); assert.equal(result.image, image); assert.equal(result.imageId, imageId);
  assert.equal(result.daemonId, "test-daemon");
  assert.equal(result.runtimeReady, false); assert.equal(result.plannerReady, false);
  assert.equal((await lstat(result.evidenceDirectory)).mode & 0o777, 0o700);
  assert.equal((await lstat(result.evidenceDirectory)).uid, process.getuid());
  assert.equal((await lstat(join(result.evidenceDirectory, "preparation.json"))).mode & 0o777, 0o600);
  const config = join(result.evidenceDirectory, "docker-config");
  assert.deepEqual(io.calls.map(({ executable, args }) => { assert.equal(executable, f.executable); assert.deepEqual(args.slice(0, 4), ["--host", f.args[3], "--config", config]); return args.slice(4); }), [
    ["info", "--format", "{{json .ID}}"], ["pull", "--quiet", "--platform", "linux/amd64", image],
    ["info", "--format", "{{json .ID}}"], ["image", "inspect", image],
  ]);
  const pin = JSON.parse(await readFile(new URL("../runtime/hermes-image.json", import.meta.url), "utf8"));
  assert.equal(pin.image, image); assert.equal(pin.imageId, imageId);
  assert.deepEqual(pin.labels, {}); assert.deepEqual(pin.volumes, ["/opt/data"]);
  assert.deepEqual(deadlines, [60_000, 1_200_000, 60_000, 60_000]);
});

posixTest("rejects malformed arguments and unsafe paths before any directory creation or process", async (t) => {
  const f = await fixture(t); const io = boundary(f);
  for (const args of [null, {}, [], [1], f.args.slice(0, -1), [...f.args, "--run"], [...f.args, ...f.args.slice(0, 2)],
    f.args.map((v, i) => i === 1 ? "docker" : v), f.args.map((v, i) => i === 3 ? "tcp://localhost:2375" : v),
    f.args.map((v, i) => i === 3 ? `${v}?context=other` : v), f.args.map((v, i) => i === 5 ? " id " : v),
    f.args.map((v, i) => i === 7 ? `${v}/../state` : v)]) {
    await assert.rejects(prepare(args, io), { code: "INVALID_ARGUMENTS" });
    assert.deepEqual(readdirSync(f.state), []);
  }
  for (const target of [f.executable, f.state, f.socket]) {
    const link = `${target}-link`; await symlink(target, link);
    const args = f.args.map((v) => v === target ? link : v === `unix://${target}` ? `unix://${link}` : v);
    await assert.rejects(prepare(args, io));
  }
  const alias = join(f.root, "alias"); await symlink(f.root, alias);
  await assert.rejects(prepare(f.args.map((v) => v.replace(f.root, alias)), io));
  await assert.rejects(prepare(f.args, { ...io, lstatPath: lstat })); // Regular files are not sockets.
  await chmod(f.executable, 0o777); await assert.rejects(prepare(f.args, io)); await chmod(f.executable, 0o700);
  await chmod(f.state, 0o755); await assert.rejects(prepare(f.args, io)); await chmod(f.state, 0o700);
  await chmod(f.root, 0o775); await assert.rejects(prepare(f.args, io), { code: "UNSAFE_PATH" }); await chmod(f.root, 0o700);
  assert.equal(io.calls.length, 0); assert.deepEqual(readdirSync(f.state), []);
});

test("CLI rejects bypass flags without disclosing arguments or launching Docker", () => {
  const result = spawnSync(process.execPath, [fileURLToPath(source), "--skip-validation", "PRIVATE_RAW_ERROR"], { env: {}, encoding: "utf8" });
  assert.equal(result.status, 1); assert.equal(result.stdout, "");
  assert.equal(JSON.parse(result.stderr).code, "INVALID_ARGUMENTS");
  assert.ok(!result.stderr.includes("PRIVATE_RAW_ERROR"));
});

posixTest("abort before launch creates no state; abort after final close cannot publish success", async (t) => {
  const f = await fixture(t); const controller = new AbortController(); controller.abort();
  const io = boundary(f);
  await assert.rejects(prepare(f.args, { ...io, signal: controller.signal }), { code: "COMMAND_ABORTED" });
  assert.equal(io.calls.length, 0); assert.deepEqual(readdirSync(f.state), []);
  const late = new AbortController();
  await failure(f, { ...boundary(f, undefined, (index) => { if (index === 3) late.abort(); }), signal: late.signal }, "COMMAND_ABORTED");
});

posixTest("synchronous launch failure retains sanitized evidence", async (t) => {
  const f = await fixture(t);
  const evidence = await failure(f, { lstatPath: f.lstatPath, spawnProcess: () => { throw new Error("PRIVATE_RAW_ERROR"); } }, "COMMAND_ERROR");
  assert.equal(evidence.commands[0].closed, false);
});

posixTest("fails closed on daemon mismatch both before and after pull", async (t) => {
  for (const index of [0, 2]) {
    const f = await fixture(t); const outputs = ["\"test-daemon\"", "pulled", "\"test-daemon\""];
    outputs[index] = "\"wrong-daemon\"";
    const io = boundary(f, outputs); await failure(f, io, "DAEMON_MISMATCH");
    assert.equal(io.calls.length, index + 1);
  }
});

posixTest("rejects wrong digest, image ID, platform, volume, entrypoint, and invented labels", async (t) => {
  for (const change of [
    (x) => { x.RepoDigests = [image.replace(/.$/, "0")]; }, (x) => { x.Id = imageId.replace(/.$/, "0"); },
    (x) => { x.Os = "darwin"; }, (x) => { x.Architecture = "arm64"; },
    (x) => { x.Config.Volumes = {}; }, (x) => { x.Config.Volumes["/extra"] = {}; },
    (x) => { x.Config.Volumes["/opt/data"] = null; }, (x) => { x.Config.Entrypoint = ["/bin/sh"]; },
    (x) => { x.Config.Labels = { "org.opencontainers.image.revision": "invented" }; },
    (x) => { x.Config.User = "other"; }, (x) => { x.Config.WorkingDir = "/"; },
  ]) {
    const f = await fixture(t); const data = inspection(); change(data[0]);
    await failure(f, boundary(f, ["\"test-daemon\"", "pulled", "\"test-daemon\"", JSON.stringify(data)]), "IMAGE_MISMATCH");
  }
  for (const output of ["PRIVATE_RAW_ERROR", "{}", "[]", JSON.stringify([...inspection(), ...inspection()])]) {
    const f = await fixture(t);
    await failure(f, boundary(f, ["\"test-daemon\"", "pulled", "\"test-daemon\"", output]), "IMAGE_MISMATCH");
  }
});

posixTest("all child outcomes await close; timeout and abort kill once even if kill fails", async (t) => {
  for (const kind of ["success", "failed", "error", "timeout-false", "timeout-throw", "abort", "overflow", "stderr-overflow"]) {
    const f = await fixture(t); const value = child(); const controller = new AbortController();
    let launched; const started = new Promise((resolve) => { launched = resolve; });
    let timeout; let kills = 0; let settled = false;
    value.kill = () => { kills++; if (kind === "timeout-throw") throw new Error("PRIVATE_RAW_ERROR"); return false; };
    const promise = prepare(f.args, { lstatPath: f.lstatPath, signal: controller.signal,
      spawnProcess: () => { launched(); return value; },
      scheduleTimeout: (callback, ms) => { assert.ok(ms >= 60_000 && ms <= 1_200_000); timeout = callback; return setTimeout(() => {}, ms); },
    }).then((result) => { settled = true; return result; }, (error) => { settled = true; throw error; });
    await started;
    if (kind.startsWith("timeout")) { timeout(); controller.abort(); }
    if (kind === "abort") { controller.abort(); timeout(); }
    if (kind === "error") value.emit("error", new Error("PRIVATE_RAW_ERROR"));
    if (kind === "overflow") value.stdout.write("x".repeat(1_048_577));
    if (kind === "stderr-overflow") value.stderr.write("x".repeat(1_048_577));
    value.exitCode = kind === "failed" ? 1 : 0; value.signalCode = "SIGKILL";
    value.emit("exit", value.exitCode, value.signalCode);
    await new Promise(setImmediate); assert.equal(settled, false);
    value.stdout.end("\"wrong-daemon\""); value.stderr.end("PRIVATE_RAW_ERROR");
    value.emit("close", value.exitCode, null);
    const expected = { success: "DAEMON_MISMATCH", failed: "COMMAND_FAILED", error: "COMMAND_ERROR", "timeout-false": "COMMAND_TIMEOUT", "timeout-throw": "COMMAND_TIMEOUT", abort: "COMMAND_ABORTED", overflow: "COMMAND_OUTPUT_LIMIT", "stderr-overflow": "COMMAND_OUTPUT_LIMIT" }[kind];
    await assert.rejects(promise, (error) => { assert.equal(error.code, expected); assert.ok(!error.message.includes("PRIVATE_RAW_ERROR")); return true; });
    assert.equal(kills, ["success", "failed"].includes(kind) ? 0 : 1);
    const evidence = JSON.parse(await readFile(join(f.state, readdirSync(f.state)[0], "preparation.json"), "utf8"));
    assert.equal(evidence.code, expected); assert.equal(evidence.commands[0].closed, true);
    assert.ok(!JSON.stringify(evidence).includes("PRIVATE_RAW_ERROR"));
  }
});
