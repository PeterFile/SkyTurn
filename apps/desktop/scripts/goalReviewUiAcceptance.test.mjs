import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { test } from "node:test";
import { assertGoalReviewAcceptance, clickOriginalGoalReview } from "./goalReviewUiAcceptance.mjs";

test("acceptance activates only visible More and Review buttons", async () => {
  const calls = [];
  await clickOriginalGoalReview({ evaluate: async source => { calls.push(source); } }, "source-implementation");
  assert.equal(calls.length, 2);
  assert.match(calls[0], /More details for/);
  assert.match(calls[1], /Review original goal/);
  assert.ok(calls.every(source => !source.includes("window.devflow")));
  const source = await readFile(new URL("./goalReviewUiAcceptance.mjs", import.meta.url), "utf8");
  assert.match(source, /finalizeAcceptanceOutcome/);
  assert.match(source, /ELECTRON_RUN_AS_NODE/);
  assert.match(source, /ownedProcessLeftovers: 0/);
  assert.doesNotMatch(source, /startAgentRun\(|reviewOriginalGoal\(/);
});

test("acceptance rejects a process-success claim without actual advisory or terminal facts", () => {
  assert.throws(() => assertGoalReviewAcceptance({ session: { nodes: [] }, projection: {}, evidence: { status: "succeeded" }, runs: [] }));
});

test("acceptance seed and inspect workers use a disposable real Git candidate without a verifier result", async (t) => {
  const { mkdtemp, mkdir, rm } = await import("node:fs/promises");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");
  const { execFile } = await import("node:child_process");
  const { promisify } = await import("node:util");
  const { fileURLToPath } = await import("node:url");
  const root = await mkdtemp(join(tmpdir(), "skyturn-goal-harness-test-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const config = { projectRoot: join(root, "project"), userData: join(root, "private") };
  await mkdir(config.projectRoot); await mkdir(config.userData);
  const script = fileURLToPath(new URL("./goalReviewUiAcceptance.mjs", import.meta.url));
  const run = async mode => {
    const result = await promisify(execFile)(process.execPath, [script, mode, JSON.stringify(config)], { timeout: 30000, maxBuffer: 2 * 1024 * 1024 });
    return JSON.parse(result.stdout.split("\n").find(line => line.startsWith("GOAL_REVIEW_FACTS=")).slice("GOAL_REVIEW_FACTS=".length));
  };
  const seeded = await run("--seed");
  const inspected = await run("--inspect");
  assert.equal(inspected.session.nodes.filter(node => node.goalReview).length, 0);
  assert.equal(inspected.projection.segments.filter(segment => segment.status === "running").length, 0);
  const source = inspected.session.nodes.find(node => node.id === "source-implementation");
  assert.equal(source.goalReviewSource.sourceRunId, seeded.sourceRunId);
  const workspace = JSON.parse(await readFile(join(config.userData, "workspace.json"), "utf8"));
  assert.equal(workspace.activeSessionId, inspected.session.id);
  assert.deepEqual(workspace.runEvents, {});
  assert.deepEqual(workspace.runEvidence, {});
});
