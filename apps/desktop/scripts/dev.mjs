import { spawn } from "node:child_process";

import {
  RENDERER_HOST,
  DEFAULT_RENDERER_PORT,
  findAvailablePort,
  makeDevServerUrl,
  rendererDevCommand,
} from "./devServer.mjs";

const children = [];

function run(command, args, options = {}) {
  const child = spawn(command, args, {
    stdio: "inherit",
    shell: process.platform === "win32",
    ...options,
  });
  children.push(child);
  child.on("exit", (code) => {
    if (code && !shuttingDown) {
      shutdown(code);
    }
  });
  return child;
}

let shuttingDown = false;

function shutdown(code = 0) {
  shuttingDown = true;
  for (const child of children) {
    if (!child.killed) child.kill();
  }
  process.exit(code);
}

async function waitFor(url) {
  for (let attempt = 0; attempt < 80; attempt += 1) {
    try {
      const response = await fetch(url);
      if (response.ok) return;
    } catch {
      await new Promise((resolve) => setTimeout(resolve, 250));
    }
  }
  throw new Error(`Timed out waiting for ${url}`);
}

process.on("SIGINT", () => shutdown(0));
process.on("SIGTERM", () => shutdown(0));

run("pnpm", ["run", "build:electron"]);
await new Promise((resolve, reject) => {
  const build = children[0];
  build.on("exit", (code) => (code === 0 ? resolve() : reject(new Error("Electron build failed"))));
});

const rendererPort = await findAvailablePort(DEFAULT_RENDERER_PORT, RENDERER_HOST);
const devServerUrl = makeDevServerUrl(rendererPort, RENDERER_HOST);
const [rendererCommand, rendererArgs] = rendererDevCommand(rendererPort, RENDERER_HOST);

run(rendererCommand, rendererArgs);
await waitFor(devServerUrl);
run("electron", ["dist-electron/electron/main.js"], {
  env: {
    ...process.env,
    VITE_DEV_SERVER_URL: devServerUrl,
  },
});
