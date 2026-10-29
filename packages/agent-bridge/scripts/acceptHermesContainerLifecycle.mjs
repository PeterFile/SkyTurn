// Explicit operator-only real Docker acceptance. Never imported by the product.
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { lstat, mkdir, mkdtemp, readFile, realpath, writeFile } from "node:fs/promises";
import { createServer, request } from "node:http";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { startController } from "./managedHermesContainer.mjs";
import { createArguments } from "./hermesContainerLifecycle.mjs";
import { parseArguments, checkPaths, readPin, verifyImage, dockerCommand } from "./prepareHermesRuntimeImage.mjs";

const readJson = async (path) => JSON.parse(await readFile(path, "utf8"));
const save = (path, value) => writeFile(path, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
async function until(predicate, ms = 180_000) {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) { const value = await predicate(); if (value) return value; await new Promise((r) => setTimeout(r, 100)); }
  throw new Error("ACCEPTANCE_DEADLINE");
}
async function client(args, root) {
  const options = parseArguments(args); await checkPaths(options, lstat);
  const directory = await mkdtemp(join(root, "inspector-"));
  const home = join(directory, "home"); const config = join(directory, "config");
  await mkdir(home, { mode: 0o700 }); await mkdir(config, { mode: 0o700 });
  const commands = [];
  const command = async (a) => {
    await checkPaths(options, lstat);
    const entry = { command: a[0], closed: false }; commands.push(entry);
    try { return await dockerCommand(options.executable, ["--host", options.host, "--config", config, ...a],
      { cwd: directory, shell: false, stdio: ["ignore", "pipe", "pipe"],
        env: { HOME: home, DOCKER_CONFIG: config, PATH: "/usr/bin:/bin", LANG: "C", LC_ALL: "C" } },
      entry, { spawnProcess: spawn, scheduleTimeout: setTimeout }, 60_000);
    } finally { await save(join(directory, "cli-close.json"), commands); }
  };
  assert.equal(JSON.parse(await command(["info", "--format", "{{json .ID}}"])), options.daemonId);
  verifyImage(await command(["image", "inspect", (await readPin()).image]), await readPin());
  return command;
}

// Transport fault injection forwards actual Engine requests. No fake container facts.
export async function faultProxy(socket, root = tmpdir()) {
  const directory = await realpath(await mkdtemp(join(root, "hlp-")));
  const path = join(directory, "s");
  const state = { offline: false, drop: undefined, dropped: 0, requests: [] };
  const server = createServer((incoming, outgoing) => {
    if (state.offline) { incoming.socket.destroy(); return; }
    const mutation = incoming.method === "POST" && /\/containers\/(create|[a-f0-9]+\/start)(\?|$)/.test(incoming.url);
    if (mutation) state.requests.push({ method: incoming.method, path: incoming.url });
    const upstream = request({ socketPath: socket, method: incoming.method, path: incoming.url, headers: incoming.headers }, (response) => {
      const shouldDrop = state.drop && incoming.method === "POST" && response.statusCode < 300
        && (state.drop === "create" ? /\/containers\/create(\?|$)/ : /\/containers\/[a-f0-9]+\/start(\?|$)/).test(incoming.url);
      if (shouldDrop) {
        state.drop = undefined;
        response.resume(); response.once("end", () => { state.dropped++; outgoing.destroy(); });
      } else { outgoing.writeHead(response.statusCode, response.headers); response.pipe(outgoing); }
    });
    upstream.on("error", () => outgoing.destroy());
    incoming.on("error", () => upstream.destroy());
    outgoing.on("close", () => upstream.destroy());
    incoming.pipe(upstream);
  });
  await new Promise((resolveListen, reject) => { server.once("error", reject); server.listen(path, resolveListen); });
  return { state, host: `unix://${path}`, directory, close: () => new Promise((r) => { server.close(r); server.closeAllConnections(); }) };
}
async function waitForChild(command, cid) {
  return until(async () => /SKYTURN_FIXTURE_HOLD=[0-9]+/.test(await command(["logs", cid])));
}

async function controllerCase(payload) {
  const command = await client(payload.args, payload.root);
  let handle;
  handle = startController(payload.args, "hold", { onStatus: async (event) => {
    if (event.kind === "running") { await waitForChild(command, event.cid); process.send({ kind: "child-ready", cid: event.cid }); }
  } });
  process.once("disconnect", () => handle.cancel());
  const result = await handle.closed;
  process.send({ kind: "terminal", result });
  process.disconnect();
}

export async function acceptLifecycle(args) {
  const options = parseArguments(args); await checkPaths(options, lstat);
  const pin = await readPin();
  const root = await mkdtemp(join(options.stateRoot, "acceptance-"));
  let command; let currentCase = "preflight";
  const cases = [];
  const active = new Set();
  let controller; let controllerClosed;
  const launch = (...input) => {
    const handle = startController(...input); active.add(handle);
    handle.closed.then(() => active.delete(handle), () => active.delete(handle));
    return handle;
  };
  const caseArgs = async (name, host = options.host) => {
    const state = join(root, name); await mkdir(state, { mode: 0o700 });
    const argv = [...args]; argv[argv.indexOf("--state-root") + 1] = state; argv[argv.indexOf("--docker-host") + 1] = host;
    return argv;
  };
  const verify = async (name, argv, result, cleanup = "confirmed") => {
    assert.equal(result.cleanup, cleanup, `${name}: cleanup`);
    assert.equal(result.cliClosed, true, `${name}: actual CLI close`);
    assert.equal(result.evidencePersisted, true, `${name}: final write acknowledgement`);
    assert.equal(result.cliEvidencePersisted, true, `${name}: persisted CLI receipts`);
    assert.ok(result.commands.every((entry) => entry.closed), `${name}: incomplete CLI`);
    const inspect = JSON.parse(await command(["inspect", "--type", "container", result.cid]))[0];
    assert.equal(inspect.Id, result.cid); assert.equal(inspect.Name, `/${result.name}`);
    if (cleanup === "confirmed") { assert.equal(inspect.State.Running, false); assert.equal(inspect.State.Pid, 0); }
    // Retain the independent exact daemon readback, including isolation settings.
    await save(join(argv[argv.indexOf("--state-root") + 1], "parent-inspect.json"), inspect);
    assert.equal(inspect.HostConfig.NetworkMode, "none"); assert.equal(inspect.HostConfig.ReadonlyRootfs, true);
    assert.equal(inspect.HostConfig.Init, true); assert.equal(inspect.HostConfig.Privileged, false);
    assert.equal(inspect.HostConfig.RestartPolicy.Name, "no");
    const caps = (list) => list.map((v) => v.replace(/^CAP_/, "")).sort();
    assert.deepEqual(caps(inspect.HostConfig.CapDrop), ["ALL"]);
    assert.deepEqual(caps(inspect.HostConfig.CapAdd), ["CHOWN", "DAC_OVERRIDE", "KILL", "SETGID", "SETUID"]);
    assert.ok(inspect.HostConfig.SecurityOpt.some((v) => /^no-new-privileges(?::true)?$/.test(v)));
    assert.deepEqual(inspect.HostConfig.Tmpfs, { "/run": "rw,noexec,nosuid,nodev,mode=0755", "/tmp": "rw,nosuid,nodev,mode=1777" });
    assert.deepEqual(inspect.Config.Entrypoint, pin.entrypoint);
    assert.equal(inspect.Mounts.filter((m) => m.Type === "bind").length, 0);
    assert.equal(inspect.Mounts.filter((m) => m.Type === "volume").length, 1);
    assert.ok(inspect.Mounts.some((m) => m.Type === "volume" && m.Name === result.volume && m.Destination === "/opt/data"));
    cases.push({ name, state: argv[argv.indexOf("--state-root") + 1], cid: result.cid, outcome: result.outcome, cleanup: result.cleanup });
    await save(join(root, "acceptance.json"), { experimental: true, plannerReady: false, status: "in_progress", cases });
    return inspect;
  };
  try {
    command = await client(args, root);
    for (const name of ["bootstrap", "fork"]) {
      currentCase = name;
      const argv = await caseArgs(name); const r = await launch(argv, name).closed;
      assert.equal(r.outcome, "succeeded"); assert.equal(r.taskExitCode, 0);
      const logs = await command(["logs", r.cid]);
      assert.match(logs, name === "bootstrap" ? /SKYTURN_FIXTURE_BOOTSTRAP_OK/ : /SKYTURN_FIXTURE_CHILD=[0-9]+/);
      const c = await verify(name, argv, r); assert.equal(c.State.Status, "exited");
    }
    for (const name of ["cancel", "timeout"]) {
      currentCase = name;
      const argv = await caseArgs(name); let handle;
      handle = launch(argv, "hold", { timeoutMs: name === "timeout" ? 30_000 : 120_000,
        onStatus: async (event) => { if (event.kind === "running") { await waitForChild(command, event.cid); if (name === "cancel") handle.cancel(); } } });
      const r = await handle.closed; assert.equal(r.reason, name === "cancel" ? "cancelled" : "timeout");
      assert.equal(r.outcome, "failed"); await verify(name, argv, r);
    }
    currentCase = "controller-sigkill";
    const killedArgs = await caseArgs("controller-sigkill");
    controller = spawn(process.execPath, [fileURLToPath(import.meta.url), "--case-controller", JSON.stringify({ args: killedArgs, root })],
      { env: { PATH: "/usr/bin:/bin" }, shell: false, stdio: ["ignore", "ignore", "ignore", "ipc"] });
    controllerClosed = new Promise((r) => controller.once("close", (code, signal) => r({ code, signal })));
    await new Promise((r, reject) => {
      controller.once("error", reject);
      controller.once("message", (v) => v.kind === "child-ready" ? r() : reject(new Error("CHILD_NOT_READY")));
      controllerClosed.then(() => reject(new Error("CONTROLLER_EARLY_CLOSE")));
    });
    controller.kill("SIGKILL"); assert.equal((await controllerClosed).signal, "SIGKILL");
    const killedRoot = killedArgs[killedArgs.indexOf("--state-root") + 1];
    const killed = await until(async () => { const r = await readJson(join(killedRoot, "operation.json")); return r.finished ? r : undefined; });
    assert.notEqual(killed.outcome, "succeeded"); assert.equal(killed.containerCleanup, "confirmed");
    // Prove the original independent owner stopped the container before recovery can act.
    const beforeRecovery = JSON.parse(await command(["inspect", "--type", "container", killed.cid]))[0];
    assert.equal(beforeRecovery.Id, killed.cid); assert.equal(beforeRecovery.State.Status, "exited");
    assert.equal(beforeRecovery.State.Running, false); assert.equal(beforeRecovery.State.Pid, 0);
    await save(join(killedRoot, "sigkill-before-reconcile-inspect.json"), beforeRecovery);
    const owner = await readJson(join(killedRoot, "owner-0.json"));
    assert.ok(Number.isSafeInteger(owner.pid) && owner.pid > 0);
    await until(() => {
      try { process.kill(owner.pid, 0); return false; }
      catch (error) { if (error.code === "ESRCH") return true; throw error; }
    });
    // Lost consumers cannot acknowledge draft bytes. Obtain a fresh durable cleanup-only receipt.
    const recoveredKill = await launch(killedArgs, "hold", { reconcile: true }).closed;
    for (const stage of ["start", "stop"]) {
      assert.equal(recoveredKill.commands.filter((v) => v.stage === stage).length, killed.commands.filter((v) => v.stage === stage).length);
    }
    await verify("controller-sigkill", killedArgs, recoveredKill);

    for (const stage of ["create", "start", "daemon"]) {
      currentCase = `${stage}-fault`;
      const proxy = await faultProxy(options.socket);
      try {
        const argv = await caseArgs(`${stage}-fault`, proxy.host);
        if (stage !== "daemon") proxy.state.drop = stage;
        let handle;
        handle = launch(argv, "hold", { onStatus: async (event) => {
          if (stage === "daemon" && event.kind === "running") {
            await waitForChild(command, event.cid); proxy.state.offline = true; handle.cancel();
          }
        } });
        const r = await handle.closed;
        assert.equal(r.outcome, "failed");
        if (stage !== "daemon") {
          assert.equal(proxy.state.dropped, 1); assert.equal(r.failure, "COMMAND_FAILED");
          await verify(`${stage}-fault`, argv, r);
          assert.equal(r.accepted, undefined);
        } else {
          assert.equal(r.cleanup, "unknown"); assert.equal(r.cliClosed, true);
          await assert.rejects(launch(argv, "hold").closed);
          const starts = proxy.state.requests.filter((v) => /\/start/.test(v.path)).length;
          const recoveredArgs = [...argv]; recoveredArgs[recoveredArgs.indexOf("--docker-host") + 1] = options.host;
          const reconciled = await launch(recoveredArgs, "hold", { reconcile: true }).closed;
          assert.equal(proxy.state.requests.filter((v) => /\/start/.test(v.path)).length, starts);
          assert.equal(reconciled.commands.filter((v) => v.stage === "start").length, r.commands.filter((v) => v.stage === "start").length);
          assert.equal(reconciled.reason, "reconcile"); assert.equal(reconciled.outcome, "failed");
          await verify("daemon-fault-reconciled", argv, reconciled);
        }
        await save(join(proxy.directory, "transport-fault.json"), proxy.state);
      } finally { await proxy.close(); }
    }
    currentCase = "ownership-conflict";
    const argv = await caseArgs("ownership-conflict"); let collision;
    const conflicting = await launch(argv, "bootstrap", { onStatus: async (event) => {
      if (event.kind !== "armed") return;
      const id = randomBytes(16).toString("hex"); const volume = `skyturn-hlc-${id}-data`;
      await save(join(argv[argv.indexOf("--state-root") + 1], "conflict-plan.json"), { id, name: event.name, volume });
      await command(["volume", "create", "--driver", "local", "--label", `dev.skyturn.experimental-hermes-operation=${id}`, volume]);
      collision = (await command(createArguments({ id, name: event.name, volume, fixture: "bootstrap" }, pin))).trim();
    } }).closed;
    assert.equal(conflicting.cleanup, "unknown"); assert.equal(conflicting.outcome, "failed");
    assert.ok(!conflicting.commands.some((v) => ["start", "stop"].includes(v.stage)));
    const decoy = JSON.parse(await command(["inspect", "--type", "container", collision]))[0];
    assert.equal(decoy.Id, collision); assert.equal(decoy.State.Status, "created");
    await save(join(argv[argv.indexOf("--state-root") + 1], "conflicting-inspect.json"), decoy);
    cases.push({ name: "ownership-conflict", cid: collision, cleanup: "unknown", outcome: "failed" });
    const result = { experimental: true, plannerReady: false, status: "passed", root, cases };
    await save(join(root, "acceptance.json"), result); return result;
  } catch (error) {
    await save(join(root, "acceptance.json"), { experimental: true, plannerReady: false, status: "failed", cases,
      failedCase: currentCase, code: error.code === "ERR_ASSERTION" ? "ASSERTION_FAILED" : "ACCEPTANCE_FAILED" });
    error.evidenceDirectory = root;
    throw error;
  } finally {
    for (const handle of active) handle.cancel();
    if (controller && controller.exitCode === null && controller.signalCode === null) controller.kill("SIGTERM");
    await Promise.allSettled([...active].map((handle) => handle.closed));
    if (controllerClosed) await controllerClosed;
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    if (process.argv[2] === "--case-controller") await controllerCase(JSON.parse(process.argv[3]));
    else process.stdout.write(`${JSON.stringify(await acceptLifecycle(process.argv.slice(2)))}\n`);
  } catch (error) {
    process.stderr.write(`${JSON.stringify({ status: "failed", code: error.code === "INVALID_ARGUMENTS" ? error.code : "ACCEPTANCE_FAILED",
      ...(error.evidenceDirectory ? { evidenceDirectory: error.evidenceDirectory } : {}) })}\n`);
    process.exitCode = 1;
    if (process.connected) process.disconnect();
  }
}
