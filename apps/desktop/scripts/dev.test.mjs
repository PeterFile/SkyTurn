import net from "node:net";
import test from "node:test";
import assert from "node:assert/strict";

import { findAvailablePort, makeDevServerUrl, rendererDevCommand } from "./devServer.mjs";

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
