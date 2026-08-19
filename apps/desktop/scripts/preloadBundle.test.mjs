import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const desktopRoot = dirname(dirname(fileURLToPath(import.meta.url)));
const preloadPath = join(desktopRoot, "dist-electron", "electron", "preload.js");
const approvedRuntimeEdges = new Set(["electron"]);

test("compiled preload is a sandbox-compatible single-file CommonJS bundle", async () => {
  const source = await readFile(preloadPath, "utf8");
  const runtimeEdges = collectRuntimeEdges(source);
  const unapprovedRuntimeEdges = runtimeEdges.filter((specifier) => !approvedRuntimeEdges.has(specifier));

  assert.deepEqual(
    unapprovedRuntimeEdges,
    [],
    `Sandboxed preload contains unapproved runtime edges: ${unapprovedRuntimeEdges.join(", ")}`,
  );
  assert.match(source, /\brequire\s*\(\s*["'`]electron["'`]\s*\)/);
  assert.ok(
    /contextBridge\.exposeInMainWorld\(\s*["'`]devflow["'`]/.test(source),
    "Sandboxed preload must expose window.devflow through contextBridge.",
  );
});

function collectRuntimeEdges(source) {
  const edges = new Set();
  const callPattern = /\b(?:require|import)\s*\(\s*(["'`])([^"'`]+)\1\s*\)/g;
  const staticImportPattern = /\b(?:import|export)\s+(?:[^"';]*?\s+from\s+)?(["'])([^"']+)\1/g;

  for (const pattern of [callPattern, staticImportPattern]) {
    for (const match of source.matchAll(pattern)) edges.add(match[2]);
  }

  return [...edges].sort();
}
