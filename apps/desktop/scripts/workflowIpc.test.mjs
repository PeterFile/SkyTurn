import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const root = dirname(dirname(fileURLToPath(import.meta.url)));

test("Electron main owns Flow Kernel workflow store IPC", async () => {
  const main = await readFile(join(root, "electron", "main.ts"), "utf8");

  assert.match(main, /createWorkflowStore/);
  assert.match(main, /workflow:applyIntent/);
  assert.match(main, /workflow:projection/);
  assert.match(main, /workflow:events/);
  assert.match(main, /applyWorkflowIntent/);
  assert.match(main, /materializeFlowProjection/);
});

test("preload exposes narrow Flow Kernel workflow wrappers", async () => {
  const preload = await readFile(join(root, "electron", "preload.ts"), "utf8");

  assert.match(preload, /applyWorkflowIntent/);
  assert.match(preload, /getWorkflowProjection/);
  assert.match(preload, /getWorkflowEvents/);
  assert.doesNotMatch(preload, /ipcRenderer\s*:/);
  assert.doesNotMatch(preload, /return\s+ipcRenderer/);
});
