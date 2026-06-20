import net from "node:net";
import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { createServer } from "vite";

import { findAvailablePort, makeDevServerUrl, rendererDevCommand } from "./devServer.mjs";

const root = dirname(dirname(fileURLToPath(import.meta.url)));

test("makeDevServerUrl targets the local renderer host", () => {
  assert.equal(makeDevServerUrl(5173), "http://127.0.0.1:5173");
});

test("findAvailablePort skips an occupied renderer port", async () => {
  const server = net.createServer();
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });

  try {
    const address = server.address();
    assert.equal(typeof address, "object");
    const port = address.port;
    assert.equal(await findAvailablePort(port), port + 1);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});

test("rendererDevCommand starts Vite with an exact strict port", () => {
  assert.deepEqual(rendererDevCommand(5175), [
    "pnpm",
    ["exec", "vite", "--host", "127.0.0.1", "--port", "5175", "--strictPort"],
  ]);
});

test("desktop Electron build script force-rebuilds stale incremental output", async () => {
  const packageJson = JSON.parse(await readFile(join(root, "package.json"), "utf8"));

  assert.equal(packageJson.scripts["build:electron"], "tsc -b tsconfig.electron.json --force");
});

test("desktop dev HTML initializes Vite React refresh before the renderer entry", async () => {
  const html = await readFile(join(root, "index.html"), "utf8");
  const server = await createServer({
    root,
    configFile: join(root, "vite.config.ts"),
    optimizeDeps: {
      include: [],
      noDiscovery: true,
    },
    server: {
      middlewareMode: true,
    },
  });

  try {
    const transformed = await server.transformIndexHtml("/", html);
    const preambleIndex = transformed.indexOf("window.$RefreshSig$");
    const entryIndex = transformed.indexOf('src="/src/main.tsx"');

    assert.notEqual(preambleIndex, -1);
    assert.notEqual(entryIndex, -1);
    assert.ok(preambleIndex < entryIndex);
  } finally {
    await server.close();
  }
});
