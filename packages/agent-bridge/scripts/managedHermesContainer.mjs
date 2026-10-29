// Developer-only controller/owner protocol. Task stdout is never this channel.
import { spawn } from "node:child_process";
import { createWriteStream } from "node:fs";
import { Socket } from "node:net";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { ownLifecycle, fixtures } from "./hermesContainerLifecycle.mjs";

export function startController(args, fixture, { reconcile = false, timeoutMs = 120_000, onStatus = async () => {}, spawnProcess = spawn } = {}) {
  if (!Object.hasOwn(fixtures, fixture) || !Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 600_000) throw new Error("INVALID_ARGUMENTS");
  const owner = spawnProcess(process.execPath, [fileURLToPath(import.meta.url), "--owner", JSON.stringify({ args, fixture, reconcile, timeoutMs })],
    { detached: true, shell: false, env: { PATH: "/usr/bin:/bin", LANG: "C", LC_ALL: "C" },
      stdio: ["ignore", "ignore", "ignore", "pipe", "pipe"] });
  const control = owner.stdio[3]; const status = owner.stdio[4];
  let result; let failure; let buffer = ""; let chain = Promise.resolve(); let ready = false; let armed = false;
  const cancel = () => { if (!control.destroyed) control.end("cancel\n"); };
  control.on("error", () => { failure ??= new Error("CONTROL_LOST"); });
  status.on("error", () => { failure ??= new Error("STATUS_LOST"); cancel(); });
  owner.on("error", () => { failure ??= new Error("OWNER_START_FAILED"); cancel(); });
  status.on("data", (chunk) => {
    buffer += chunk.toString("utf8");
    if (buffer.length > 1_048_576) { buffer = ""; failure ??= new Error("INVALID_OWNER_PROTOCOL"); cancel(); status.destroy(); return; }
    while (buffer.includes("\n")) {
      const index = buffer.indexOf("\n"); const line = buffer.slice(0, index); buffer = buffer.slice(index + 1);
      chain = chain.then(async () => {
        const event = JSON.parse(line);
        if (result || !["ready", "armed", "running", "terminal"].includes(event.kind)) throw new Error("INVALID_OWNER_PROTOCOL");
        if (event.kind === "ready") {
          if (ready) throw new Error("INVALID_OWNER_PROTOCOL");
          ready = true;
        } else if (!ready) throw new Error("INVALID_OWNER_PROTOCOL");
        await onStatus(event);
        if (event.kind === "ready" && !control.writableEnded) control.write("prepare\n");
        if (event.kind === "armed") {
          if (armed || reconcile) throw new Error("INVALID_OWNER_PROTOCOL");
          armed = true;
          if (!control.writableEnded) control.write("launch\n");
        }
        if (event.kind === "terminal") result = event.result;
      }).catch(() => { failure ??= new Error("OWNER_PROTOCOL_FAILED"); cancel(); });
    }
  });
  const closed = new Promise((resolveClosed, rejectClosed) => {
    owner.once("close", async (code, signal) => {
      await chain;
      if (failure || code !== 0 || signal !== null || !result || buffer !== "") rejectClosed(failure ?? new Error("OWNER_UNCONFIRMED"));
      else resolveClosed(result);
    });
  });
  // An external controller kill is handled independently by owner control EOF.
  void closed.catch(() => {});
  return { owner, closed, cancel };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  if (process.argv[2] === "--owner") {
    const control = new Socket({ fd: 3, readable: true, writable: false });
    const status = createWriteStream(null, { fd: 4 });
    const cancel = () => control.emit("data", Buffer.from("cancel\n"));
    status.on("error", cancel);
    process.on("SIGINT", cancel); process.on("SIGTERM", cancel);
    try {
      const payload = JSON.parse(process.argv[3]);
      await ownLifecycle(payload.args, payload.fixture, { control, reconcile: payload.reconcile, timeoutMs: payload.timeoutMs,
        send: (event) => { if (!status.destroyed) status.write(`${JSON.stringify(event)}\n`); } });
    } catch { process.exitCode = 1; }
    finally { control.destroy(); status.end(); process.off("SIGINT", cancel); process.off("SIGTERM", cancel); }
  } else {
    let handle;
    const cancel = () => handle?.cancel();
    process.on("SIGINT", cancel); process.on("SIGTERM", cancel);
    process.stdout.on("error", cancel); process.stderr.on("error", cancel);
    try {
      const argv = process.argv.slice(2); const reconcile = argv[0] === "--reconcile";
      if (reconcile) argv.shift();
      const fixture = argv.shift();
      handle = startController(argv, fixture, { reconcile });
      const result = await handle.closed;
      process.stdout.write(`${JSON.stringify({ experimental: true, plannerReady: false, ...result })}\n`);
      if (reconcile ? result.cleanup !== "confirmed" : result.outcome !== "succeeded") process.exitCode = 1;
    } catch { process.stderr.write('{"status":"failed","code":"LIFECYCLE_UNCONFIRMED"}\n'); process.exitCode = 1; }
    finally { process.off("SIGINT", cancel); process.off("SIGTERM", cancel); }
  }
}
