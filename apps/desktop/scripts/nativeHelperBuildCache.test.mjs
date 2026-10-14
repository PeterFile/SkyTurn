import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join, resolve } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

const repo = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");
const require = createRequire(import.meta.url);
const turboRequire = createRequire(require.resolve("turbo/package.json"));
const platform = process.platform === "win32" ? "windows" : process.platform;
const arch = process.arch === "x64" ? "64" : process.arch;
// Resolve the installed binary directly so missing dependencies cannot trigger installation.
const turbo = turboRequire.resolve(`@turbo/${platform}-${arch}/bin/turbo${process.platform === "win32" ? ".exe" : ""}`);

test("desktop-only tests cache source native helpers through the dependency build graph", () => {
  const plan = JSON.parse(execFileSync(turbo, [
    "run", "test", "--filter=@skyturn/desktop", "--dry-run=json",
    "--cache=local:rw", "--no-update-notifier",
  ], {
    cwd: repo,
    encoding: "utf8",
    env: { ...process.env, TURBO_TELEMETRY_DISABLED: "1" },
  }));
  const tasks = new Map(plan.tasks.map((task) => [task.taskId, task]));
  const bridgeBuild = tasks.get("@skyturn/agent-bridge#build");
  const desktopBuild = tasks.get("@skyturn/desktop#build");
  const desktopTest = tasks.get("@skyturn/desktop#test");
  assert.ok(bridgeBuild);
  assert.ok(desktopBuild);
  assert.ok(desktopTest);

  const rootConfig = JSON.parse(readFileSync(join(repo, "turbo.json"), "utf8"));
  const nativeOutputs = [
    "src/native/artifact-gate",
    "src/native/fd-launch",
    "src/native/posix-process-owner",
  ];
  assert.deepEqual(bridgeBuild.resolvedTaskDefinition.outputs, [
    ...rootConfig.tasks.build.outputs, ...nativeOutputs,
  ].sort());
  assert.equal(bridgeBuild.resolvedTaskDefinition.cache, true);
  assert.deepEqual(bridgeBuild.resolvedTaskDefinition.dependsOn, ["^build"]);
  assert.deepEqual(desktopTest.dependencies, ["@skyturn/desktop#build"]);
  assert.ok(desktopBuild.dependencies.includes("@skyturn/agent-bridge#build"));
  assert.equal(tasks.has("@skyturn/agent-bridge#test"), false);
  assert.ok(plan.tasks.every((task) => task.taskId.endsWith("#build") || task.taskId === desktopTest.taskId));

  for (const task of plan.tasks) {
    if (task.taskId.endsWith("#build") && task !== bridgeBuild) {
      assert.deepEqual(task.resolvedTaskDefinition.outputs, [...rootConfig.tasks.build.outputs].sort());
    }
  }
});
