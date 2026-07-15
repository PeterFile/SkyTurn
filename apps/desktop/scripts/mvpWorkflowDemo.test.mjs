import assert from "node:assert/strict";
import { dirname, join } from "node:path";
import { readFile } from "node:fs/promises";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

const root = dirname(dirname(fileURLToPath(import.meta.url)));

test("MVP demo fails fast on blocked readiness before starting agent runs", async () => {
  const { demoReadinessPreflight, readinessFailureResult } = await loadReadinessHelpers();
  const fakeAgents = [
    { kind: "hermes", status: "available" },
    { kind: "codex", status: "missing" },
  ];
  const blockedReadiness = {
    status: "blocked",
    runSupport: "unavailable",
    message: "Codex CLI missing; install Codex before starting real executor runs.",
    reasons: ["codex-cli-missing"],
    checks: {
      hermesCli: "ready",
      codexCli: "missing",
      hermesAuth: "available",
      codexAuth: "unknown",
      mockFallback: false,
    },
  };
  let startRunCalled = false;
  const bridge = {
    async discoverAgents() {
      return fakeAgents;
    },
    async startRun() {
      startRunCalled = true;
      throw new Error("startRun must not be called by readiness preflight.");
    },
  };

  const preflight = await demoReadinessPreflight(bridge, (agents) => {
    assert.equal(agents, fakeAgents);
    return blockedReadiness;
  });
  const failure = readinessFailureResult(preflight.readiness);

  assert.equal(preflight.failFast, true);
  assert.equal(startRunCalled, false);
  assert.equal(failure.ok, false);
  assert.equal(failure.readiness, blockedReadiness);
  assert.equal(failure.failure.code, "AGENT_READINESS_BLOCKED");
  assert.match(failure.failure.diagnostic, /codex-cli-missing/);
});

test("MVP demo keeps degraded readiness running and reports readiness in final JSON", async () => {
  const source = await readFile(join(root, "scripts", "mvpWorkflowDemo.mjs"), "utf8");
  const { demoReadinessPreflight } = await loadReadinessHelpers();
  const degradedReadiness = {
    status: "degraded",
    runSupport: "experimental-run",
    message: "Real loop available in experimental mode; verify agent auth before relying on long runs.",
    reasons: ["codex-auth-unknown", "experimental-run"],
    checks: {
      hermesCli: "ready",
      codexCli: "ready",
      hermesAuth: "available",
      codexAuth: "unknown",
      mockFallback: false,
    },
  };

  const preflight = await demoReadinessPreflight({
    async discoverAgents() {
      return [{ kind: "codex", status: "available" }];
    },
  }, () => degradedReadiness);

  assert.equal(preflight.failFast, false);
  assert.match(source, /readiness:\s*readinessPreflight\.readiness/);
});

test("MVP demo bounds agent watchdogs before the workflow wait timeout", async () => {
  const { demoTimeoutsFromEnv } = await loadReadinessHelpers();

  assert.deepEqual(demoTimeoutsFromEnv({ SKYTURN_DEMO_WAIT_TIMEOUT_MS: "60000" }), {
    waitTimeoutMs: 60000,
    agentWatchdogTimeoutMs: 55000,
  });
  assert.deepEqual(
    demoTimeoutsFromEnv({ SKYTURN_DEMO_WAIT_TIMEOUT_MS: "60000", SKYTURN_DEMO_AGENT_TIMEOUT_MS: "10000" }),
    {
      waitTimeoutMs: 60000,
      agentWatchdogTimeoutMs: 10000,
    },
  );
  assert.deepEqual(
    demoTimeoutsFromEnv({ SKYTURN_DEMO_WAIT_TIMEOUT_MS: "60000", SKYTURN_DEMO_AGENT_TIMEOUT_MS: "90000" }),
    {
      waitTimeoutMs: 60000,
      agentWatchdogTimeoutMs: 55000,
    },
  );
});

test("MVP demo passes bounded watchdogs into Hermes and Codex adapters", async () => {
  const source = await readFile(join(root, "scripts", "mvpWorkflowDemo.mjs"), "utf8");

  assert.match(source, /createHermesCliAdapter\(\{ defaultWatchdogTimeoutMs: agentWatchdogTimeoutMs \}\)/);
  assert.match(source, /createCodexCliAdapter\(\{ defaultWatchdogTimeoutMs: agentWatchdogTimeoutMs \}\)/);
  assert.match(source, /createDurableRunClaimStore/);
  assert.match(source, /durableRunClaimStore/);
  assert.match(source, /skyturn-demo-claims-/);
});

test("MVP demo verification script checks renderable Vite output", async () => {
  const source = await readFile(join(root, "scripts", "mvpWorkflowDemo.mjs"), "utf8");

  assert.match(source, /import \{ build \} from 'vite';/);
  assert.match(source, /await build\(\{ root: fileURLToPath\(new URL\('\.\.', import\.meta\.url\)\), logLevel: 'silent', build: \{ write: false \} \}\);/);
});

test("MVP demo readiness preflight runs before workflow node execution", async () => {
  const source = await readFile(join(root, "scripts", "mvpWorkflowDemo.mjs"), "utf8");
  const preflightIndex = source.indexOf("const readinessPreflight = await demoReadinessPreflight(bridge)");
  const failFastIndex = source.indexOf("if (readinessPreflight.failFast)");
  const loopIndex = source.indexOf("for (let iteration = 0; iteration < maxWorkflowRuns; iteration += 1)");
  const startNodeRunIndex = source.indexOf("await startNodeRun(bridge, root, session, node)");

  assert.ok(preflightIndex >= 0, "demo must discover and summarize agent readiness.");
  assert.ok(failFastIndex > preflightIndex, "demo must evaluate fail-fast readiness after discovery.");
  assert.ok(failFastIndex < loopIndex, "readiness fail-fast must run before the workflow loop.");
  assert.ok(failFastIndex < startNodeRunIndex, "readiness fail-fast must run before startNodeRun.");
});

test("MVP demo module loads through real workspace exports", async () => {
  const { demoReadinessPreflight, readinessFailureResult } = await loadReadinessHelpers();

  assert.equal(typeof demoReadinessPreflight, "function");
  assert.equal(typeof readinessFailureResult, "function");
});

async function loadReadinessHelpers() {
  const demoModule = await import("./mvpWorkflowDemo.mjs");
  return {
    demoTimeoutsFromEnv: demoModule.demoTimeoutsFromEnv,
    demoReadinessPreflight: demoModule.demoReadinessPreflight,
    readinessFailureResult: demoModule.readinessFailureResult,
  };
}
