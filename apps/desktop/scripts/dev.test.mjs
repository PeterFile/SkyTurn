import net from "node:net";
import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { createServer, loadConfigFromFile } from "vite";

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

test("root dev refreshes desktop dependencies and the ui-canvas source root", async () => {
  const repositoryRoot = join(root, "..", "..");
  const turboJson = JSON.parse(await readFile(join(repositoryRoot, "turbo.json"), "utf8"));

  assert.deepEqual(turboJson.tasks.dev.dependsOn, ["^build"]);

  const loadedConfig = await loadConfigFromFile(
    { command: "serve", mode: "development" },
    join(root, "vite.config.ts"),
  );
  assert.ok(loadedConfig);

  const aliases = loadedConfig.config.resolve?.alias;
  assert.ok(Array.isArray(aliases));
  const uiCanvasAlias = aliases.find(
    (alias) => alias.find instanceof RegExp && alias.find.test("@skyturn/ui-canvas"),
  );
  assert.ok(uiCanvasAlias);
  assert.equal(
    uiCanvasAlias.replacement,
    join(repositoryRoot, "packages", "ui-canvas", "src", "index.ts"),
  );
  assert.equal(uiCanvasAlias.find.test("@skyturn/ui-canvas/workflow-runtime"), false);

  const loadedBuildConfig = await loadConfigFromFile(
    { command: "build", mode: "production" },
    join(root, "vite.config.ts"),
  );
  assert.ok(loadedBuildConfig);
  assert.equal(loadedBuildConfig.config.resolve?.alias, undefined);
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
