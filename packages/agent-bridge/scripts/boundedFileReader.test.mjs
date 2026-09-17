import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { EventEmitter } from "node:events";
import { constants, existsSync, readFileSync } from "node:fs";
import { link, mkdir, mkdtemp, open, realpath, rename, rm, symlink, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import path from "node:path";
import { PassThrough } from "node:stream";
import test from "node:test";
import { fileURLToPath } from "node:url";
import vm from "node:vm";

const require = createRequire(import.meta.url);
const posixTest = process.platform === "win32" ? test.skip : test;
const ts = require("typescript");
const source = fileURLToPath(new URL("../src/boundedFileReader.ts", import.meta.url));
const helper = fileURLToPath(new URL("../src/native/artifact-gate", import.meta.url));

function reader(spawnOverride, platform = spawnOverride ? "darwin" : process.platform) {
  assert.ok(existsSync(source), "bounded file reader must be implemented");
  const module = { exports: {} };
  const code = readFileSync(source, "utf8").replaceAll("import.meta.url", JSON.stringify(new URL("../src/boundedFileReader.ts", import.meta.url).href));
  vm.runInNewContext(ts.transpileModule(code, { compilerOptions: {
    module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, esModuleInterop: true,
  } }).outputText, {
    module, exports: module.exports, Buffer, URL, setTimeout, clearTimeout,
    process: { platform },
    require: (name) => name === "node:child_process" && spawnOverride ? { spawn: spawnOverride } : require(name),
  });
  return module.exports.readBoundedFile;
}

async function fixture(t) {
  const root = await realpath(await mkdtemp(path.join(tmpdir(), "skyturn-bounded-read-")));
  await mkdir(path.join(root, "reports"));
  const directory = await open(root, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
  t.after(async () => { await directory.close(); await rm(root, { recursive: true, force: true }); });
  return { root, directory, input: { rootFd: directory.fd, relativePath: "reports/report.txt", maxBytes: 16 } };
}

posixTest("reads exact bounded bytes and allows a generic caller-owned relative path", async (t) => {
  const f = await fixture(t);
  await writeFile(path.join(f.root, f.input.relativePath), Buffer.from([0, 255, 1, 2]));
  const result = await reader()(f.input);
  assert.equal(result.ok, true);
  assert.deepEqual(result.bytes, Buffer.from([0, 255, 1, 2]));
  await writeFile(path.join(f.root, "single.txt"), "");
  assert.equal((await reader()({ ...f.input, relativePath: "single.txt" })).bytes.length, 0);
});

test("rejects invalid inputs before spawn and fails unavailable on Windows", async () => {
  let launches = 0;
  const read = reader(() => { launches++; throw new Error("must not launch"); });
  for (const relativePath of ["../x", "/x", "a/../x", "a//b", "a\\b", "a\0b", "x".repeat(4097), "字".repeat(1366)]) {
    assert.equal((await read({ rootFd: 3, relativePath, maxBytes: 1 })).code, "INVALID_INPUT");
  }
  for (const maxBytes of [0, -1, 1.5, NaN, 32 * 1024 * 1024 + 1]) {
    assert.equal((await read({ rootFd: 3, relativePath: "a", maxBytes })).code, "INVALID_INPUT");
  }
  assert.equal((await reader(undefined, "win32")({ rootFd: 3, relativePath: "a", maxBytes: 1 })).code, "UNAVAILABLE");
  assert.equal(launches, 0);
});

posixTest("enforces exact byte limit, missing, symlink, hardlink and directory rejection", async (t) => {
  const f = await fixture(t);
  const read = reader();
  assert.equal((await read(f.input)).code, "MISSING");
  const target = path.join(f.root, f.input.relativePath);
  await writeFile(target, "a".repeat(16));
  assert.equal((await read(f.input)).bytes.length, 16);
  await writeFile(target, "a".repeat(17));
  assert.equal((await read(f.input)).code, "OVERSIZE");
  await rm(target);
  await writeFile(path.join(f.root, "other"), "secret");
  await symlink("../other", target);
  assert.equal((await read(f.input)).code, "UNSAFE_FILE");
  await rm(target);
  await link(path.join(f.root, "other"), target);
  assert.equal((await read(f.input)).code, "UNSAFE_FILE");
  await rm(target);
  await mkdir(target);
  assert.equal((await read(f.input)).code, "UNSAFE_FILE");
});

async function nativeRead(f, afterReady, afterOpened) {
  const child = spawn(helper, ["read", f.input.relativePath, String(f.input.maxBytes)], {
    stdio: ["pipe", "pipe", "pipe", f.directory.fd],
  });
  const chunks = [];
  let handshake = "";
  let stage = 0;
  let failure;
  child.stdout.on("data", (chunk) => {
    chunks.push(chunk);
    handshake += chunk.toString();
    if (stage === 0 && handshake.startsWith("READY\n")) {
      stage = 1;
      Promise.resolve(afterReady?.()).then(() => child.stdin.write("\n")).catch((error) => { failure = error; child.kill(); });
    }
    if (stage === 1 && handshake.startsWith("READY\nOPENED\n")) {
      stage = 2;
      Promise.resolve(afterOpened?.()).then(() => child.stdin.end("\n")).catch((error) => { failure = error; child.kill(); });
    }
  });
  child.stdin.on("error", () => {});
  await new Promise((resolve, reject) => { child.on("error", reject); child.on("close", resolve); });
  if (failure) throw failure;
  return Buffer.concat(chunks).toString();
}

posixTest("native read retains the opened ancestor through replacement", async (t) => {
  const f = await fixture(t);
  await writeFile(path.join(f.root, f.input.relativePath), "original");
  const output = await nativeRead(f, async () => {
    await rename(path.join(f.root, "reports"), path.join(f.root, "old"));
    await mkdir(path.join(f.root, "outside"));
    await writeFile(path.join(f.root, "outside/report.txt"), "private");
    await symlink("outside", path.join(f.root, "reports"));
  });
  assert.equal(output, "READY\nOPENED\nRESULT ok 8\noriginal");
});

posixTest("native read rejects final symlink swaps and changed open files without content", async (t) => {
  const f = await fixture(t);
  const target = path.join(f.root, f.input.relativePath);
  await writeFile(target, "original");
  assert.equal(await nativeRead(f, async () => {
    await rename(target, `${target}.old`);
    await symlink("report.txt.old", target);
  }), "READY\nRESULT unsafe\n");
  await rm(target);
  await rename(`${target}.old`, target);
  const output = await nativeRead(f, undefined, () => writeFile(target, "new"));
  assert.equal(output, "READY\nOPENED\nRESULT changed\n");
});

posixTest("native read rejects FIFO without blocking", async (t) => {
  const f = await fixture(t);
  const child = spawn("mkfifo", [path.join(f.root, f.input.relativePath)]);
  assert.equal(await new Promise((resolve) => child.on("close", resolve)), 0);
  assert.equal((await reader()(f.input)).code, "UNSAFE_FILE");
});

test("waits for actual close and discards partial, failed or excess stdout", async () => {
  for (const [output, exitCode] of [
    ["READY\nOPENED\nRESULT ok 4\nprivate", 0],
    ["READY\nOPENED\nRESULT ok 4\npriv", 1],
    ["READY\nOPENED\nRESULT ok 4\npr", 0],
    [Buffer.concat([Buffer.from([0xd2]), Buffer.from("EADY\nOPENED\nRESULT ok 4\npriv")]), 0],
    ["private".repeat(100), 0],
  ]) {
    const child = new EventEmitter();
    child.stdin = new PassThrough(); child.stdout = new PassThrough();
    let kills = 0;
    child.kill = () => { kills++; throw new Error("private kill error"); };
    let settled = false;
    const resultPromise = reader(() => child)({ rootFd: 3, relativePath: "a", maxBytes: 4 })
      .then((result) => { settled = true; return result; });
    child.stdout.write(output);
    child.emit("exit", exitCode);
    if (exitCode !== 0) child.emit("error", new Error("private spawn error"));
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(settled, false);
    child.emit("close", exitCode);
    const result = await resultPromise;
    assert.equal(result.ok, false);
    assert.equal(JSON.stringify(result).includes("private"), false);
    assert.ok(kills <= 1);
  }
});

test("aborts once and still waits for close when kill returns false", async () => {
  const child = new EventEmitter(); child.stdin = new PassThrough(); child.stdout = new PassThrough();
  let kills = 0, settled = false;
  child.kill = () => { kills++; return false; };
  const controller = new AbortController();
  const pending = reader(() => child)({ rootFd: 3, relativePath: "a", maxBytes: 4, signal: controller.signal })
    .then((result) => { settled = true; return result; });
  controller.abort(); child.emit("error", new Error("private")); child.emit("exit", 0);
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(settled, false); assert.equal(kills, 1);
  child.emit("close", 0);
  assert.equal((await pending).ok, false);
});

posixTest("existing verify and publication protocol remain compatible", async (t) => {
  const f = await fixture(t);
  const run = (args, input) => new Promise((resolve, reject) => {
    const child = spawn(helper, args, { stdio: ["pipe", "pipe", "pipe", f.directory.fd] });
    let output = ""; child.stdout.on("data", (data) => { output += data; });
    child.on("error", reject); child.on("close", (code) => resolve({ code, output }));
    child.stdin.end(input);
  });
  const published = await run(["write", f.input.relativePath], "report");
  assert.deepEqual(published, { code: 0, output: "RESULT published\n" });
  const verified = await run([f.input.relativePath], "\n\n");
  assert.equal(verified.code, 0); assert.match(verified.output, /^READY\nOPENED\nRESULT present \d+:\d+\n$/);
  assert.equal((await reader()(f.input)).bytes.toString(), "report");
});
