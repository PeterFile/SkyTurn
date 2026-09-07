import { spawn, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { constants } from "node:fs";
import { access, lstat, mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";

import { assertContainedSymlinks, copyAppVerbatim } from "./packageDesktop.mjs";

const SCRIPT_PATH = fileURLToPath(import.meta.url);
const DESKTOP_ROOT = dirname(dirname(SCRIPT_PATH));

if (process.argv.includes("--help")) {
  process.stdout.write("Launch an installed SkyTurn.app and verify file:// rendering, preload workspace IPC, better-sqlite3, helpers, and a screenshot.\n");
} else if (typeof WebSocket === "undefined") {
  const result = spawnSync(process.execPath, ["--experimental-websocket", SCRIPT_PATH, ...process.argv.slice(2)], {
    stdio: "inherit",
  });
  process.exitCode = result.status ?? 1;
} else {
  smokeInstalledApp().catch((error) => {
    process.stderr.write(`${error instanceof Error ? error.stack ?? error.message : String(error)}\n`);
    process.exitCode = 1;
  });
}

async function smokeInstalledApp() {
  if (process.platform !== "darwin") throw new Error("The packaged desktop smoke runs on macOS only.");
  const appSource = resolve(readOption("--app", join(DESKTOP_ROOT, "release/SkyTurn.app")));
  const artifactRoot = resolve(readOption("--artifacts", join(DESKTOP_ROOT, "release/smoke")));
  await access(join(appSource, "Contents/Info.plist"), constants.R_OK);
  const runRoot = join(artifactRoot, `run-${Date.now()}-${process.pid}`);
  await mkdir(runRoot, { recursive: true });
  const installRoot = await mkdtemp(join(tmpdir(), "skyturn-installed-smoke-"));
  const installedApp = join(installRoot, "SkyTurn.app");
  await assertContainedSymlinks(appSource);
  await copyAppVerbatim(appSource, installedApp);
  await assertContainedSymlinks(installedApp);
  const executable = join(installedApp, "Contents/MacOS/SkyTurn");
  const payload = join(installedApp, "Contents/Resources/app");
  await access(executable, constants.X_OK);
  const helperModes = await verifyHelpers(payload);
  const runtime = verifyPackagedRuntime(executable, payload, installRoot);

  const port = await reservePort();
  const environment = { ...process.env };
  delete environment.VITE_DEV_SERVER_URL;
  delete environment.ELECTRON_RUN_AS_NODE;
  const child = spawn(executable, [
    `--remote-debugging-port=${port}`,
    `--user-data-dir=${join(installRoot, "user-data")}`,
  ], { cwd: installRoot, env: environment, stdio: ["ignore", "pipe", "pipe"] });
  const output = [];
  child.stdout.on("data", (chunk) => output.push(chunk));
  child.stderr.on("data", (chunk) => output.push(chunk));
  const closed = new Promise((resolveClose) => child.once("close", (code, signal) => resolveClose({ code, signal })));
  const rendererErrors = [];
  let session;
  let closeEvidence;
  try {
    const target = await waitForPageTarget(port, child);
    session = await connectCdp(target.webSocketDebuggerUrl);
    session.on("Runtime.exceptionThrown", ({ exceptionDetails }) => {
      rendererErrors.push(exceptionDetails.exception?.description ?? exceptionDetails.text ?? "Renderer exception");
    });
    session.on("Log.entryAdded", ({ entry }) => {
      if (entry.level === "error") rendererErrors.push(entry.text);
    });
    await Promise.all([
      session.command("Runtime.enable"),
      session.command("Log.enable"),
      session.command("Page.enable"),
    ]);
    const evaluation = await session.command("Runtime.evaluate", {
      expression: `(async () => {
        let shell = null;
        let rect = null;
        let ready = false;
        for (let attempt = 0; attempt < 200; attempt += 1) {
          shell = document.querySelector(".home-panel, .app-shell");
          rect = shell?.getBoundingClientRect();
          const style = shell ? getComputedStyle(shell) : null;
          if (
            location.protocol === "file:" &&
            window.devflow?.loadWorkspace &&
            document.readyState === "complete" &&
            document.querySelector("#root")?.childElementCount > 0 &&
            rect?.width > 0 && rect?.height > 0 &&
            style?.display !== "none" && style?.visibility !== "hidden" && style?.opacity !== "0" &&
            shell.textContent?.trim()
          ) {
            ready = true;
            break;
          }
          await new Promise((resolve) => setTimeout(resolve, 50));
        }
        if (!ready || !shell || !rect) throw new Error("Visible SkyTurn shell did not mount.");
        return {
          url: location.href,
          preloadApi: "window.devflow",
          workspace: await window.devflow.loadWorkspace(),
          dom: {
            selector: shell.matches(".home-panel") ? ".home-panel" : ".app-shell",
            rootChildCount: document.querySelector("#root").childElementCount,
            width: Math.round(rect.width),
            height: Math.round(rect.height),
            text: shell.textContent.trim().slice(0, 240),
          },
        };
      })()`,
      awaitPromise: true,
      returnByValue: true,
    });
    if (evaluation.exceptionDetails) throw new Error(`Renderer evaluation failed: ${JSON.stringify(evaluation.exceptionDetails)}`);
    const renderer = evaluation.result?.value;
    if (!renderer?.url?.startsWith("file://") || !renderer.url.includes("/dist/index.html")) {
      throw new Error(`Packaged renderer did not load from dist/index.html: ${renderer?.url ?? "missing"}`);
    }
    await delay(100);
    if (rendererErrors.length > 0) throw new Error(`Packaged renderer reported errors: ${rendererErrors.join(" | ")}`);
    const screenshot = await session.command("Page.captureScreenshot", { format: "png" });
    const screenshotPath = join(runRoot, "skyturn.png");
    const screenshotBytes = Buffer.from(screenshot.data, "base64");
    await writeFile(screenshotPath, screenshotBytes);
    session.notify("Browser.close");
    session.close();
    closeEvidence = await ensureClosed(child, closed);
    const result = {
      installedApp,
      executableSha256: await sha256File(executable),
      screenshotPath,
      screenshotSha256: createHash("sha256").update(screenshotBytes).digest("hex"),
      renderer,
      rendererErrors,
      sqlite: runtime.sqlite,
      vite: runtime.vite,
      helperModes,
      closeEvidence,
    };
    await writeFile(join(runRoot, "result.json"), `${JSON.stringify(result, null, 2)}\n`);
    process.stdout.write(`${JSON.stringify({ resultPath: join(runRoot, "result.json"), ...result }, null, 2)}\n`);
  } catch (error) {
    await writeFile(join(runRoot, "failure.json"), `${JSON.stringify({
      error: error instanceof Error ? error.stack ?? error.message : String(error),
      rendererErrors,
    }, null, 2)}\n`);
    throw error;
  } finally {
    session?.close();
    if (!closeEvidence) closeEvidence = await ensureClosed(child, closed);
    await writeFile(join(runRoot, "electron.log"), Buffer.concat(output));
  }
}

function verifyPackagedRuntime(executable, payload, cwd) {
  const script = `const fs=require("node:fs");const path=require("node:path");const {createRequire}=require("node:module");const {pathToFileURL}=require("node:url");(async()=>{const appRequire=createRequire(${JSON.stringify(join(payload, "package.json"))});const vite=await import(pathToFileURL(appRequire.resolve("vite")).href);fs.mkdirSync(path.join(${JSON.stringify(cwd)},"vite-runtime-probe"),{recursive:true});const probeRoot=fs.realpathSync(path.join(${JSON.stringify(cwd)},"vite-runtime-probe"));fs.writeFileSync(path.join(probeRoot,"main.ts"),"export const answer: number = 42;\\n");const server=await vite.createServer({root:probeRoot,configFile:false,logLevel:"silent",server:{middlewareMode:true}});let transformed;try{transformed=await server.transformRequest("/main.ts");}finally{await server.close();}if(!transformed?.code.includes("42")||transformed.code.includes(": number"))throw new Error("Packaged Vite transform failed.");const r=createRequire(fs.realpathSync(${JSON.stringify(join(payload, "node_modules/@skyturn/persistence/package.json"))}));const Database=r("better-sqlite3");const db=new Database(":memory:");const value=db.prepare("select 40 + 2 as value").get().value;db.close();console.log(JSON.stringify({electron:process.versions.electron,modules:process.versions.modules,sqlite:{value},vite:{version:vite.version,transformed:true}}));})().catch((error)=>{console.error(error);process.exitCode=1;});`;
  const environment = { ...process.env, ELECTRON_RUN_AS_NODE: "1" };
  delete environment.VITE_DEV_SERVER_URL;
  const result = spawnSync(executable, ["-e", script], { cwd, env: environment, encoding: "utf8", timeout: 30_000 });
  if (result.error || result.status !== 0) {
    throw new Error(`Packaged runtime probe failed:\n${result.error?.message ?? result.stderr}`);
  }
  const evidence = JSON.parse(result.stdout.trim().split("\n").at(-1));
  if (evidence.sqlite?.value !== 42 || !evidence.vite?.transformed || evidence.electron !== "41.5.1") {
    throw new Error(`Unexpected packaged runtime evidence: ${result.stdout}`);
  }
  return evidence;
}

async function verifyHelpers(payload) {
  const root = join(payload, "node_modules/@skyturn/agent-bridge/dist");
  await Promise.all([
    access(join(root, "internal/hermesCandidateVerifier.py"), constants.R_OK),
    access(join(root, "native/artifact-gate.ps1"), constants.R_OK),
    access(join(root, "native/job-object-host.ps1"), constants.R_OK),
  ]);
  const modes = {};
  for (const name of ["artifact-gate", "fd-launch", "posix-process-owner"]) {
    const stats = await lstat(join(root, "native", name));
    if ((stats.mode & 0o111) === 0) throw new Error(`Packaged helper is not executable: ${name}`);
    modes[name] = (stats.mode & 0o777).toString(8).padStart(3, "0");
  }
  return modes;
}

async function connectCdp(url) {
  const socket = new WebSocket(url);
  await new Promise((resolveOpen, reject) => {
    socket.addEventListener("open", resolveOpen, { once: true });
    socket.addEventListener("error", () => reject(new Error("Could not connect to Electron DevTools.")), { once: true });
  });
  let nextId = 1;
  const pending = new Map();
  const listeners = new Map();
  socket.addEventListener("message", (event) => {
    const message = JSON.parse(event.data);
    if (!message.id) {
      for (const listener of listeners.get(message.method) ?? []) listener(message.params ?? {});
      return;
    }
    if (!pending.has(message.id)) return;
    const { resolveResult, reject } = pending.get(message.id);
    pending.delete(message.id);
    message.error ? reject(new Error(message.error.message)) : resolveResult(message.result);
  });
  return {
    command(method, params = {}) {
      const id = nextId++;
      return new Promise((resolveResult, reject) => {
        pending.set(id, { resolveResult, reject });
        socket.send(JSON.stringify({ id, method, params }));
      });
    },
    on(method, listener) {
      const methodListeners = listeners.get(method) ?? [];
      methodListeners.push(listener);
      listeners.set(method, methodListeners);
    },
    notify(method, params = {}) { socket.send(JSON.stringify({ id: nextId++, method, params })); },
    close() { if (socket.readyState < WebSocket.CLOSING) socket.close(); },
  };
}

async function waitForPageTarget(port, child) {
  for (let attempt = 0; attempt < 200; attempt += 1) {
    if (child.exitCode !== null) throw new Error(`Packaged Electron exited before DevTools became ready: ${child.exitCode}`);
    try {
      const targets = await fetch(`http://127.0.0.1:${port}/json/list`).then((response) => response.json());
      const page = targets.find((target) => target.type === "page");
      if (page?.webSocketDebuggerUrl) return page;
    } catch {}
    await delay(50);
  }
  throw new Error("Timed out waiting for the packaged renderer target.");
}

async function reservePort() {
  const { createServer } = await import("node:net");
  const server = createServer();
  await new Promise((resolveListen, reject) => server.once("error", reject).listen(0, "127.0.0.1", resolveListen));
  const address = server.address();
  await new Promise((resolveClose) => server.close(resolveClose));
  return address.port;
}

async function ensureClosed(child, closed) {
  const first = await Promise.race([closed, delay(5000).then(() => null)]);
  if (first) return first;
  child.kill("SIGTERM");
  const second = await Promise.race([closed, delay(5000).then(() => null)]);
  if (second) return second;
  child.kill("SIGKILL");
  return closed;
}

function readOption(name, fallback) {
  const index = process.argv.indexOf(name);
  if (index < 0) return fallback;
  if (!process.argv[index + 1] || process.argv[index + 1].startsWith("--")) throw new Error(`${name} requires a path.`);
  return process.argv[index + 1];
}

async function sha256File(path) {
  return createHash("sha256").update(await readFile(path)).digest("hex");
}
