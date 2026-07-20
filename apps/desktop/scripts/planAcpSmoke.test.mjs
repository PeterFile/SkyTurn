import assert from "node:assert/strict";
import { test } from "node:test";

import { runPlanAcpSmoke } from "./planAcpSmoke.mjs";

test("live ACP seam runs one Requirements prompt without exposing the raw session id", async () => {
  const calls = [];
  const client = {
    async newSession(cwd) {
      calls.push(["new", cwd]);
      return "opaque-session-secret";
    },
    async prompt(sessionId, prompt, options) {
      calls.push(["prompt", sessionId, prompt]);
      options.onText("# Requirements");
      return { stopReason: "end_turn", markdown: "# Requirements" };
    },
    close() {
      calls.push(["close"]);
    },
  };

  const result = await runPlanAcpSmoke({
    projectRoot: "/repo",
    createClient: async () => client,
    buildPrompt: () => "safe smoke prompt",
  });

  assert.deepEqual(result, {
    status: "ok",
    stopReason: "end_turn",
    markdownLength: 14,
    chunkCount: 1,
  });
  assert.equal(JSON.stringify(result).includes("opaque-session-secret"), false);
  assert.deepEqual(calls, [
    ["new", "/repo"],
    ["prompt", "opaque-session-secret", "safe smoke prompt"],
    ["close"],
  ]);
});

test("live ACP seam does not resolve before the client is reaped", async () => {
  let releaseClose;
  const client = {
    async newSession() {
      return "opaque-session-secret";
    },
    async prompt() {
      return { stopReason: "end_turn", markdown: "# Requirements" };
    },
    close() {
      return new Promise((resolve) => {
        releaseClose = resolve;
      });
    },
  };
  let settled = false;

  const smoke = runPlanAcpSmoke({
    projectRoot: "/repo",
    createClient: async () => client,
    buildPrompt: () => "safe smoke prompt",
  }).then((result) => {
    settled = true;
    return result;
  });
  await new Promise((resolve) => setImmediate(resolve));

  assert.equal(typeof releaseClose, "function");
  assert.equal(settled, false);
  releaseClose();
  await smoke;
});
