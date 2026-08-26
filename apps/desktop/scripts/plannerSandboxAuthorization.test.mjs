import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  AgentBridge,
  createAgentRunStartFingerprint,
  createDurableRunClaimStore,
} from "../../../packages/agent-bridge/dist/index.js";
import * as runStartContracts from "../dist-electron/electron/runStartHandler.js";

const authorizeEffectiveRunStartSandbox = runStartContracts.authorizeEffectiveRunStartSandbox ??
  (async (input) => input);
const createRunStartHandler = runStartContracts.createRunStartHandler;
const invalidHermesSandboxes = [
  ["null", null],
  ["empty string", ""],
  ["typo", "danger-full-acess"],
  ["non-string", 1],
];

test("planner sandbox authorization resolves the Hermes default before exact danger authorization", async () => {
  const base = plannerRunInput(tmpdir(), "run-planner-policy");

  for (const sandbox of ["read-only", "workspace-write"]) {
    let dangerousAuthorizations = 0;
    const authorized = await authorizeEffectiveRunStartSandbox(
      { ...base, sandbox },
      () => {
        dangerousAuthorizations += 1;
      },
    );

    assert.equal(authorized.sandbox, sandbox);
    assert.equal(dangerousAuthorizations, 0);
  }

  for (const sandbox of [undefined, "danger-full-access"]) {
    const dangerousInputs = [];
    const submitted = sandbox === undefined ? base : { ...base, sandbox };
    const authorized = await authorizeEffectiveRunStartSandbox(
      submitted,
      (effectiveInput) => dangerousInputs.push(effectiveInput),
    );

    assert.equal(authorized.sandbox, "danger-full-access");
    assert.equal(dangerousInputs.length, 1);
    assert.equal(dangerousInputs[0], authorized);
    assert.equal(
      createAgentRunStartFingerprint(dangerousInputs[0]),
      createAgentRunStartFingerprint({ ...base, sandbox: "danger-full-access" }),
    );
  }

  await assert.rejects(
    authorizeEffectiveRunStartSandbox(base, () => {
      throw new Error("exact durable danger authorization is missing");
    }),
    /exact durable danger authorization is missing/,
  );
});

test("planner sandbox authorization rejects every explicit invalid Hermes sandbox without danger authorization", async (t) => {
  const base = plannerRunInput(tmpdir(), "run-planner-invalid-policy");

  for (const [name, sandbox] of invalidHermesSandboxes) {
    await t.test(name, async () => {
      let dangerousAuthorizations = 0;
      let rejection;

      try {
        await authorizeEffectiveRunStartSandbox({ ...base, sandbox }, () => {
          dangerousAuthorizations += 1;
        });
      } catch (error) {
        rejection = error;
      }
      assert.deepEqual(
        { error: rejection?.message, dangerousAuthorizations },
        { error: "Hermes run start sandbox is invalid.", dangerousAuthorizations: 0 },
      );
    });
  }
});

test("the run-start handler rejects invalid Hermes sandboxes before every start side effect", async (t) => {
  const base = plannerRunInput(tmpdir(), "run-planner-invalid-handler");

  for (const [name, sandbox] of invalidHermesSandboxes) {
    await t.test(name, async () => {
      const sideEffects = {
        artifactPreflights: 0,
        dangerAuthorizations: 0,
        identityResolutions: 0,
        storeAcquisitions: 0,
        inputAssertions: 0,
        segmentClaims: 0,
        checkpoints: 0,
        persistenceWrites: 0,
        adapterStarts: 0,
      };
      const store = { listRunningSegments: () => [] };
      const count = (name) => {
        sideEffects[name] += 1;
      };
      const handler = createRunStartHandler({
        preAuthorizeStart: () => count("artifactPreflights"),
        authorizeStartInput: (submitted) => authorizeEffectiveRunStartSandbox(submitted, () => {
          count("dangerAuthorizations");
        }),
        resolveIdentity: () => {
          count("identityResolutions");
          return productionIdentityFromRunInput(base);
        },
        acquireStore: async () => {
          count("storeAcquisitions");
          return store;
        },
        reopenStore: async () => store,
        assertStartInput: async () => count("inputAssertions"),
        claimUnscheduledStart: () => {
          count("segmentClaims");
          return null;
        },
        prepareBeforeCheckpoint: async () => {
          count("checkpoints");
          return false;
        },
        startRun: async () => {
          count("adapterStarts");
          return { id: base.runId, status: "running" };
        },
        reconcileTerminal: async () => count("persistenceWrites"),
        compensateTerminal: () => count("persistenceWrites"),
        enrichAfterCheckpoint: async () => count("persistenceWrites"),
        recordBeforeCheckpointFailure: () => count("persistenceWrites"),
        recordAfterCheckpointFailure: () => count("persistenceWrites"),
      });

      let rejection;
      try {
        await handler({ ...base, sandbox });
      } catch (error) {
        rejection = error;
      }
      assert.deepEqual(
        { error: rejection?.message, sideEffects },
        {
          error: "Hermes run start sandbox is invalid.",
          sideEffects: {
            artifactPreflights: 0,
            dangerAuthorizations: 0,
            identityResolutions: 0,
            storeAcquisitions: 0,
            inputAssertions: 0,
            segmentClaims: 0,
            checkpoints: 0,
            persistenceWrites: 0,
            adapterStarts: 0,
          },
        },
      );
    });
  }
});

test("omitted and explicit Hermes danger requests share one authorized in-process start", async () => {
  const input = plannerRunInput(tmpdir(), "run-planner-duplicate");
  const releaseStart = deferred();
  const startEntered = deferred();
  const bothAuthorized = deferred();
  const authorizationFingerprints = [];
  let starts = 0;
  const segment = {
    sessionId: input.sessionId,
    laneId: input.nodeId,
    segmentId: `planner-segment-${input.runId}`,
    runId: input.runId,
    agentKind: input.agentKind,
  };
  const store = { listRunningSegments: () => [segment] };
  const handler = createRunStartHandler({
    authorizeStartInput: (submitted) => authorizeEffectiveRunStartSandbox(submitted, (effectiveInput) => {
      authorizationFingerprints.push(createAgentRunStartFingerprint(effectiveInput));
      if (authorizationFingerprints.length === 2) bothAuthorized.resolve();
    }),
    resolveIdentity: productionIdentityFromRunInput,
    acquireStore: async () => store,
    reopenStore: async () => store,
    assertStartInput: async () => {},
    prepareBeforeCheckpoint: async () => false,
    startRun: async (authorizedInput) => {
      starts += 1;
      assert.equal(authorizedInput.sandbox, "danger-full-access");
      startEntered.resolve();
      await releaseStart.promise;
      return { id: input.runId, status: "running" };
    },
    reconcileTerminal: async () => {},
    compensateTerminal: () => {},
    enrichAfterCheckpoint: async () => {},
    recordBeforeCheckpointFailure: () => {},
    recordAfterCheckpointFailure: () => {},
  });

  const omittedAttempt = handler(input);
  await startEntered.promise;
  const explicitAttempt = handler({ ...input, sandbox: "danger-full-access" });
  await bothAuthorized.promise;
  releaseStart.resolve();
  const results = await Promise.allSettled([omittedAttempt, explicitAttempt]);

  assert.deepEqual(results.map((result) => result.status), ["fulfilled", "fulfilled"]);
  assert.equal(starts, 1);
  assert.equal(authorizationFingerprints.length, 2);
  assert.equal(authorizationFingerprints[0], authorizationFingerprints[1]);
});

test("a reopened bridge treats omitted and explicit Hermes danger as the same durable start", async () => {
  const projectRoot = await mkdtemp(join(tmpdir(), "skyturn-planner-sandbox-project-"));
  const privateStateRoot = await mkdtemp(join(tmpdir(), "skyturn-planner-sandbox-state-"));
  const claimRoot = join(privateStateRoot, "run-claims");
  const input = plannerRunInput(projectRoot, "run-planner-restart");
  let firstStarts = 0;
  let restartStarts = 0;
  let firstBridge;
  try {
    firstBridge = new AgentBridge({
      durableRunClaimStore: createDurableRunClaimStore({ root: claimRoot }),
      adapters: [plannerAdapter(() => {
        firstStarts += 1;
      })],
    });
    const firstInput = await authorizeEffectiveRunStartSandbox(input, () => {});
    await firstBridge.startRun(firstInput);
    assert.equal(firstInput.sandbox, "danger-full-access");

    const reopenedBridge = new AgentBridge({
      durableRunClaimStore: createDurableRunClaimStore({ root: claimRoot }),
      adapters: [plannerAdapter(() => {
        restartStarts += 1;
      })],
    });
    const retryInput = await authorizeEffectiveRunStartSandbox(
      { ...input, sandbox: "danger-full-access" },
      () => {},
    );
    await assert.rejects(reopenedBridge.startRun(retryInput), (error) => {
      assert.doesNotMatch(String(error), /different identity/i);
      assert.match(String(error), /already (?:active or durably claimed|terminal)/i);
      return true;
    });
    assert.equal(firstStarts, 1);
    assert.equal(restartStarts, 0);
  } finally {
    await firstBridge?.cancelRun(input.runId, "test cleanup").catch(() => undefined);
    await rm(projectRoot, { recursive: true, force: true });
    await rm(privateStateRoot, { recursive: true, force: true });
  }
});

test("Electron authorizes the effective sandbox and gives every trusted planner launch an explicit restricted policy", async () => {
  const main = await readFile(new URL("../electron/main.ts", import.meta.url), "utf8");
  const authorization = main.slice(
    main.indexOf("async function authorizeWorkflowRunStartInput"),
    main.indexOf("function isWorkflowPlannerRootStartTarget"),
  );
  assert.match(authorization, /authorizeEffectiveRunStartSandbox/);

  const plannerStarts = [...main.matchAll(/await plannerRunStartHandler\(\{([\s\S]*?)\n\s*\}\);/g)];
  assert.equal(plannerStarts.length, 2);
  for (const [, plannerInput] of plannerStarts) {
    assert.match(plannerInput, /sandbox:\s*TRUSTED_HERMES_PLANNER_SANDBOX/);
  }
  assert.equal(runStartContracts.TRUSTED_HERMES_PLANNER_SANDBOX, "read-only");
});

function plannerRunInput(projectRoot, runId) {
  return {
    protocolVersion: 1,
    projectRoot,
    sessionId: "session-1",
    nodeId: "planner-node",
    runId,
    agentKind: "hermes",
    worktreePath: projectRoot,
    plannerSessionId: "hermes-session-1",
    plannerInputId: runId,
    transport: "exec-json",
    prompt: `Plan ${runId}`,
  };
}

function productionIdentityFromRunInput(input) {
  return {
    projectRoot: input.projectRoot,
    sessionId: input.sessionId,
    laneId: input.nodeId,
    runId: input.runId,
    agentKind: input.agentKind,
    worktreePath: input.worktreePath,
    plannerSessionId: input.plannerSessionId,
    plannerInputId: input.plannerInputId,
    transport: input.transport,
    startFingerprint: createAgentRunStartFingerprint(input),
  };
}

function plannerAdapter(onStart) {
  return {
    kind: "hermes",
    async detect() {
      throw new Error("Discovery is not part of this test.");
    },
    async startRun(input) {
      onStart(input);
      return { async cancel() {} };
    },
  };
}

function deferred() {
  let resolve;
  const promise = new Promise((done) => {
    resolve = done;
  });
  return { promise, resolve };
}
