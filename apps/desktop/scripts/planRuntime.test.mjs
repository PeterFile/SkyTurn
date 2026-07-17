import assert from "node:assert/strict";
import {
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  realpath,
  rm,
  stat,
  symlink,
  unlink,
  writeFile,
} from "node:fs/promises";
import { createRequire } from "node:module";
import { createHash } from "node:crypto";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import vm from "node:vm";

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const require = createRequire(import.meta.url);

test("missing Plan state requires explicit bootstrap without writing an empty snapshot", async () => {
  const { createPlanRuntime, planStateFileName } = await loadPlanRuntime();
  const stateRoot = await mkdtemp(join(tmpdir(), "skyturn-plan-bootstrap-"));
  const request = { planSessionId: "plan-session-legacy", projectRoot: "/repo" };
  const legacySnapshot = {
    version: 0,
    plan: {
      requirements: "legacy requirements",
      design: "legacy design",
      tasks: "legacy tasks",
    },
    accepted: { requirements: false, design: false, tasks: false },
    checkpoints: {
      requirements: [],
      design: [],
      tasks: [],
    },
  };
  try {
    const client = new FakeAcpClient();
    const runtime = createPlanRuntime(runtimeOptions(stateRoot, client, []));
    const missing = await runtime.getState(request);
    assert.equal(missing.needsBootstrap, true);
    assert.deepEqual(toPlain(missing.snapshot), {
      version: 0,
      plan: { requirements: "", design: "", tasks: "" },
      accepted: { requirements: false, design: false, tasks: false },
      checkpoints: { requirements: [], design: [], tasks: [] },
    });
    await assert.rejects(stat(join(stateRoot, planStateFileName(request.planSessionId))), { code: "ENOENT" });

    const bootstrapped = await runtime.bootstrap(request, legacySnapshot);
    assert.equal(bootstrapped.needsBootstrap, false);
    assert.deepEqual(toPlain(bootstrapped.snapshot), legacySnapshot);
    const target = join(stateRoot, planStateFileName(request.planSessionId));
    const originalBytes = await readFile(target, "utf8");
    const retried = await runtime.bootstrap(request, legacySnapshot);
    assert.deepEqual(toPlain(retried.snapshot), legacySnapshot);
    assert.equal(await readFile(target, "utf8"), originalBytes);

    await assert.rejects(runtime.bootstrap(request, {
      ...legacySnapshot,
      plan: { ...legacySnapshot.plan, requirements: "forged replacement" },
    }), /Plan state bootstrap conflict\./);
    assert.equal(await readFile(target, "utf8"), originalBytes);
    await assert.rejects(runtime.generate({
      operation: "generate",
      ...request,
      stage: "design",
      goal: "Do not auto-execute migrated drafts",
      expectedStateVersion: 0,
    }), /Plan state transition is invalid\./);
    assert.equal(client.newSessionCalls, 0);
    const requirementsAccepted = await runtime.acceptStage({
      ...request,
      stage: "requirements",
      expectedStateVersion: 0,
    });
    const designAccepted = await runtime.acceptStage({
      ...request,
      stage: "design",
      expectedStateVersion: requirementsAccepted.snapshot.version,
    });
    const tasksAccepted = await runtime.acceptStage({
      ...request,
      stage: "tasks",
      expectedStateVersion: designAccepted.snapshot.version,
    });
    assert.deepEqual(toPlain(tasksAccepted.snapshot.accepted), {
      requirements: true,
      design: true,
      tasks: true,
    });
    assert.equal(client.newSessionCalls, 0);
    await runtime.close();
  } finally {
    await rm(stateRoot, { recursive: true, force: true });
  }
});

test("missing private state bootstraps one strict current Plan snapshot exactly", async () => {
  const { createPlanRuntime } = await loadPlanRuntime();
  const stateRoot = await mkdtemp(join(tmpdir(), "skyturn-plan-current-bootstrap-"));
  const request = { planSessionId: "plan-current", projectRoot: "/repo" };
  const snapshot = {
    version: 12,
    plan: {
      requirements: "requirements-v2",
      design: "design-v1",
      tasks: "tasks-v1",
    },
    accepted: { requirements: true, design: true, tasks: true },
    checkpoints: {
      requirements: ["requirements-v0", "requirements-v1"],
      design: ["design-v0"],
      tasks: ["tasks-v0"],
    },
  };
  try {
    const runtime = createPlanRuntime(runtimeOptions(stateRoot, new FakeAcpClient(), []));
    const bootstrapped = await runtime.bootstrap(request, snapshot);
    assert.deepEqual(toPlain(bootstrapped.snapshot), snapshot);
    await runtime.close();

    const restarted = createPlanRuntime(runtimeOptions(stateRoot, new FakeAcpClient(), []));
    const recovered = await restarted.getState(request);
    assert.deepEqual(toPlain(recovered.snapshot), snapshot);
    await restarted.close();
  } finally {
    await rm(stateRoot, { recursive: true, force: true });
  }
});

test("partial initial Plan temp writes never publish an invalid final and restart cleanly", async () => {
  const fsPromises = require("node:fs/promises");
  let failPartialWrite = true;
  const instrumentedFs = {
    ...fsPromises,
    open: async (...args) => {
      const handle = await fsPromises.open(...args);
      const openedPath = String(args[0]);
      return new Proxy(handle, {
        get(target, property) {
          if (property === "writeFile") {
            return async (data, options) => {
              if (failPartialWrite && (openedPath.endsWith(".json") || openedPath.endsWith(".state.tmp"))) {
                failPartialWrite = false;
                const value = String(data);
                await target.writeFile(value.slice(0, Math.max(1, Math.floor(value.length / 3))), options);
                throw new Error("injected partial initial write");
              }
              return target.writeFile(data, options);
            };
          }
          const value = Reflect.get(target, property, target);
          return typeof value === "function" ? value.bind(target) : value;
        },
      });
    },
  };
  const { createPlanRuntime, planStateFileName } = await loadPlanRuntime({
    "node:fs/promises": instrumentedFs,
  });
  const stateRoot = await mkdtemp(join(tmpdir(), "skyturn-plan-initial-partial-"));
  const request = { planSessionId: "plan-partial", projectRoot: "/repo" };
  const snapshot = {
    version: 0,
    plan: { requirements: "requirements", design: "", tasks: "" },
    accepted: { requirements: false, design: false, tasks: false },
    checkpoints: { requirements: [], design: [], tasks: [] },
  };
  try {
    const runtime = createPlanRuntime(runtimeOptions(stateRoot, new FakeAcpClient(), []));
    await assert.rejects(runtime.bootstrap(request, snapshot), /Plan state persistence is unavailable\./);
    await runtime.close();
    await assert.rejects(stat(join(stateRoot, planStateFileName(request.planSessionId))), { code: "ENOENT" });
    assert.deepEqual((await readdir(stateRoot)).filter((name) => name.endsWith(".tmp")), []);

    const restarted = createPlanRuntime(runtimeOptions(stateRoot, new FakeAcpClient(), []));
    const recovered = await restarted.bootstrap(request, snapshot);
    assert.deepEqual(toPlain(recovered.snapshot), snapshot);
    await restarted.close();
  } finally {
    await rm(stateRoot, { recursive: true, force: true });
  }
});

test("an exact retry accepts and re-syncs a complete initial Plan after publication sync uncertainty", async () => {
  const { createPlanRuntime, planStateFileName } = await loadPlanRuntime();
  const stateRoot = await mkdtemp(join(tmpdir(), "skyturn-plan-initial-sync-"));
  const request = { planSessionId: "plan-sync-retry", projectRoot: "/repo" };
  const snapshot = {
    version: 0,
    plan: { requirements: "requirements", design: "", tasks: "" },
    accepted: { requirements: false, design: false, tasks: false },
    checkpoints: { requirements: [], design: [], tasks: [] },
  };
  let failedSyncs = 0;
  try {
    const uncertain = createPlanRuntime({
      ...runtimeOptions(stateRoot, new FakeAcpClient(), []),
      syncDirectory: async () => {
        failedSyncs += 1;
        throw new Error("injected initial publication sync failure");
      },
    });
    await assert.rejects(
      uncertain.bootstrap(request, snapshot),
      /Plan session state is indeterminate\. Restart SkyTurn\./,
    );
    await uncertain.close();
    assert.equal(failedSyncs >= 2, true);
    const final = JSON.parse(await readFile(join(stateRoot, planStateFileName(request.planSessionId)), "utf8"));
    assert.deepEqual(final.snapshot, snapshot);
    assert.deepEqual((await readdir(stateRoot)).filter((name) => name.endsWith(".tmp")), []);

    const restarted = createPlanRuntime(runtimeOptions(stateRoot, new FakeAcpClient(), []));
    const recovered = await restarted.bootstrap(request, snapshot);
    assert.deepEqual(toPlain(recovered.snapshot), snapshot);
    await restarted.close();
  } finally {
    await rm(stateRoot, { recursive: true, force: true });
  }
});

test("concurrent exact initializers publish one Plan state and conflicting retries never replace it", async () => {
  const { createPlanRuntime, planStateFileName } = await loadPlanRuntime();
  const stateRoot = await mkdtemp(join(tmpdir(), "skyturn-plan-initial-race-"));
  const request = { planSessionId: "plan-race", projectRoot: "/repo" };
  const snapshot = {
    version: 0,
    plan: { requirements: "winner", design: "", tasks: "" },
    accepted: { requirements: false, design: false, tasks: false },
    checkpoints: { requirements: [], design: [], tasks: [] },
  };
  try {
    const first = createPlanRuntime(runtimeOptions(stateRoot, new FakeAcpClient(), []));
    const second = createPlanRuntime(runtimeOptions(stateRoot, new FakeAcpClient(), []));
    const [left, right] = await Promise.all([
      first.bootstrap(request, snapshot),
      second.bootstrap(request, snapshot),
    ]);
    assert.deepEqual(toPlain(left.snapshot), snapshot);
    assert.deepEqual(toPlain(right.snapshot), snapshot);
    const target = join(stateRoot, planStateFileName(request.planSessionId));
    const winnerBytes = await readFile(target, "utf8");

    const conflicting = createPlanRuntime(runtimeOptions(stateRoot, new FakeAcpClient(), []));
    await assert.rejects(conflicting.bootstrap(request, {
      ...snapshot,
      plan: { ...snapshot.plan, requirements: "loser" },
    }), /Plan state bootstrap conflict\./);
    assert.equal(await readFile(target, "utf8"), winnerBytes);
    await Promise.all([first.close(), second.close(), conflicting.close()]);
  } finally {
    await rm(stateRoot, { recursive: true, force: true });
  }
});

test("Plan bootstrap preserves an existing valid conversation mapping", async () => {
  const { createPlanRuntime, planMappingFileName, planStateFileName } = await loadPlanRuntime();
  const stateRoot = await mkdtemp(join(tmpdir(), "skyturn-plan-bootstrap-mapping-"));
  const planSessionId = "plan-session-mapped";
  const projectRoot = "/repo";
  try {
    await writeFile(join(stateRoot, planMappingFileName(planSessionId)), JSON.stringify({
      version: 1,
      planKey: createHash("sha256").update("skyturn-plan-session\0").update(planSessionId).digest("hex"),
      projectKey: createHash("sha256").update("skyturn-plan-project\0").update(projectRoot).digest("hex"),
      acpSessionId: "existing-private-mapping",
    }), { mode: 0o600 });
    const runtime = createPlanRuntime(runtimeOptions(stateRoot, new FakeAcpClient(), []));
    await runtime.bootstrap({ planSessionId, projectRoot }, {
      version: 0,
      plan: { requirements: "", design: "", tasks: "" },
      accepted: { requirements: false, design: false, tasks: false },
      checkpoints: { requirements: [], design: [], tasks: [] },
    });

    const persisted = JSON.parse(await readFile(join(stateRoot, planStateFileName(planSessionId)), "utf8"));
    assert.equal(persisted.conversationEstablished, true);
    await runtime.close();
  } finally {
    await rm(stateRoot, { recursive: true, force: true });
  }
});

test("Plan runtime persists a private opaque mapping and reuses it after restart", async () => {
  const { createPlanRuntime } = await loadPlanRuntime();
  const stateRoot = await mkdtemp(join(tmpdir(), "skyturn-plan-runtime-"));
  const firstClient = new FakeAcpClient();
  const firstEvents = [];
  try {
    const firstRuntime = createPlanRuntime(runtimeOptions(stateRoot, firstClient, firstEvents));
    const firstTerminal = terminalEvent(firstEvents);
    const result = await firstRuntime.generate(generateRequest());
    await firstTerminal;

    assert.equal(result.duplicate, false);
    assert.equal(firstClient.newSessionCalls, 1);
    assert.equal(firstClient.promptCalls.length, 1);
    assert.ok(firstEvents.some((event) => event.kind === "delta" && event.text === "# Requirements"));
    assert.ok(firstEvents.some((event) => event.kind === "completed" && event.markdown === "# Requirements"));
    assert.ok(firstEvents.every((event) => JSON.stringify(event).includes(firstClient.sessionId) === false));

    const files = await readdir(stateRoot);
    assert.equal(files.length, 2);
    assert.ok(files.every((file) => /^[a-f0-9]{64}\.json$/.test(file)));
    assert.ok(files.every((file) => !file.includes("plan-session-1")));
    const persistedTexts = await Promise.all(files.map((file) => readFile(join(stateRoot, file), "utf8")));
    const mappingText = persistedTexts.find((text) => text.includes("acpSessionId"));
    const terminalText = persistedTexts.find((text) => text.includes('"kind":"completed"'));
    assert.equal(typeof mappingText, "string");
    assert.equal(typeof terminalText, "string");
    const mapping = JSON.parse(mappingText);
    assert.match(mapping.projectKey, /^[a-f0-9]{64}$/);
    assert.equal(mappingText.includes("/repo"), false);
    assert.equal(terminalText.includes("/repo"), false);
    assert.equal(terminalText.includes("plan-session-1"), false);
    assert.equal(terminalText.includes(firstClient.sessionId), false);
    if (process.platform !== "win32") {
      for (const file of files) assert.equal((await stat(join(stateRoot, file))).mode & 0o077, 0);
    }

    await firstRuntime.acceptStage({
      planSessionId: "plan-session-1",
      projectRoot: "/repo",
      stage: "requirements",
      expectedStateVersion: 1,
    });

    await firstRuntime.close();
    const secondClient = new FakeAcpClient();
    const secondEvents = [];
    const secondRuntime = createPlanRuntime(runtimeOptions(stateRoot, secondClient, secondEvents));
    const secondTerminal = terminalEvent(secondEvents);
    await secondRuntime.generate({ ...generateRequest(), stage: "design", expectedStateVersion: 2 });
    await secondTerminal;

    assert.equal(secondClient.newSessionCalls, 0);
    assert.deepEqual(secondClient.loadSessionCalls, [{ cwd: "/repo", sessionId: firstClient.sessionId }]);
    assert.equal(secondClient.promptCalls[0]?.sessionId, firstClient.sessionId);
    await secondRuntime.close();
  } finally {
    await rm(stateRoot, { recursive: true, force: true });
  }
});

test("Plan runtime rejects a mapping from another project before any ACP session call", async () => {
  const { createPlanRuntime } = await loadPlanRuntime();
  const stateRoot = await mkdtemp(join(tmpdir(), "skyturn-plan-runtime-"));
  const firstClient = new FakeAcpClient();
  const firstEvents = [];
  try {
    const firstRuntime = createPlanRuntime(runtimeOptions(stateRoot, firstClient, firstEvents));
    const firstTerminal = terminalEvent(firstEvents);
    await firstRuntime.generate(generateRequest());
    await firstTerminal;
    await firstRuntime.close();

    const before = await directoryBytes(stateRoot);
    const secondClient = new FakeAcpClient();
    const secondEvents = [];
    const secondRuntime = createPlanRuntime(runtimeOptions(stateRoot, secondClient, secondEvents));
    await assert.rejects(secondRuntime.generate({
      ...generateRequest(),
      projectRoot: "/different-repo",
      conversationStarted: true,
    }), /Plan conversation mapping project does not match\./);

    assert.deepEqual(secondEvents, []);
    assert.equal(secondClient.newSessionCalls, 0);
    assert.deepEqual(secondClient.loadSessionCalls, []);
    assert.deepEqual(secondClient.promptCalls, []);
    assert.deepEqual(await directoryBytes(stateRoot), before);
    await secondRuntime.close();
  } finally {
    await rm(stateRoot, { recursive: true, force: true });
  }
});

test("Plan mapping creation syncs its new root parent before syncing the replacement", async () => {
  const { createPlanRuntime } = await loadPlanRuntime();
  const parent = await mkdtemp(join(tmpdir(), "skyturn-plan-runtime-parent-"));
  const stateRoot = join(parent, "plan-state");
  const client = new FakeAcpClient();
  const events = [];
  const syncedDirectories = [];
  try {
    const runtime = createPlanRuntime({
      ...runtimeOptions(stateRoot, client, events),
      syncDirectory: async (directory) => {
        syncedDirectories.push(directory);
      },
    });
    const terminal = terminalEvent(events);
    await runtime.generate(generateRequest());
    await terminal;

    assert.deepEqual(syncedDirectories, [parent, stateRoot, stateRoot, stateRoot, stateRoot]);
    await runtime.close();
  } finally {
    await rm(parent, { recursive: true, force: true });
  }
});

test("Plan runtime deduplicates the same in-flight request and rejects a different one", async () => {
  const { createPlanRuntime } = await loadPlanRuntime();
  const stateRoot = await mkdtemp(join(tmpdir(), "skyturn-plan-runtime-"));
  const client = new FakeAcpClient({ deferred: true });
  const events = [];
  try {
    const runtime = createPlanRuntime(runtimeOptions(stateRoot, client, events));
    const first = await runtime.generate(generateRequest());
    const duplicate = await runtime.generate(generateRequest());

    assert.equal(duplicate.runId, first.runId);
    assert.equal(duplicate.duplicate, true);
    await assert.rejects(
      runtime.revise({
        ...generateRequest(),
        operation: "revise",
        currentMarkdown: "# Requirements",
        instruction: "Change it.",
      }),
      /already active/,
    );
    await waitFor(() => client.promptCalls.length === 1);
    client.completePrompt();
    await terminalEvent(events);
    assert.equal(client.promptCalls.length, 1);
    await runtime.close();
  } finally {
    await rm(stateRoot, { recursive: true, force: true });
  }
});

test("Plan runtime claims globally before terminal cleanup and shares successful preflight", async () => {
  const { createPlanRuntime, planTerminalFileName } = await loadPlanRuntime();
  const stateRoot = await mkdtemp(join(tmpdir(), "skyturn-plan-runtime-"));
  const client = new FakeAcpClient({ deferred: true });
  const events = [];
  let releaseCleanup;
  let cleanupStarted;
  let nextRun = 0;
  const cleanupEntered = new Promise((resolve) => { cleanupStarted = resolve; });
  const cleanupRelease = new Promise((resolve) => { releaseCleanup = resolve; });
  try {
    await writeFile(
      join(stateRoot, planTerminalFileName("plan-session-1")),
      JSON.stringify(legacyPlanTerminal()),
      { mode: 0o600 },
    );
    const runtime = createPlanRuntime({
      ...runtimeOptions(stateRoot, client, events),
      randomUUID: () => `run-${++nextRun}`,
      syncDirectory: async () => {
        cleanupStarted();
        await cleanupRelease;
      },
    });
    const firstPending = runtime.generate(generateRequest());
    await cleanupEntered;
    const duplicatePending = runtime.generate(generateRequest());

    await assert.rejects(runtime.generate({
      ...generateRequest(),
      planSessionId: "plan-session-2",
    }), /Plan runtime is busy\./);
    await assert.rejects(runtime.revise({
      ...generateRequest(),
      operation: "revise",
      currentMarkdown: "# Requirements",
      instruction: "Change it.",
    }), /already active/);
    assert.deepEqual(events, []);
    assert.equal(client.newSessionCalls, 0);
    releaseCleanup();
    const [first, duplicate] = await Promise.all([firstPending, duplicatePending]);
    assert.equal(first.duplicate, false);
    assert.equal(duplicate.duplicate, true);
    assert.equal(duplicate.runId, first.runId);
    await waitFor(() => client.promptCalls.length === 1);
    client.completePrompt();
    await terminalEvent(events, first.runId);
    assert.equal(client.promptCalls.length, 1);
    await runtime.close();
  } finally {
    releaseCleanup?.();
    await rm(stateRoot, { recursive: true, force: true });
  }
});

test("Plan runtime shares cleanup failure without publishing a phantom run", async () => {
  const { createPlanRuntime, planTerminalFileName } = await loadPlanRuntime();
  const stateRoot = await mkdtemp(join(tmpdir(), "skyturn-plan-runtime-"));
  const client = new FakeAcpClient();
  const events = [];
  const privatePath = "/private/plan-state/terminal.json";
  let releaseCleanup;
  let cleanupStarted;
  let failCleanup = true;
  let nextRun = 0;
  const cleanupEntered = new Promise((resolve) => { cleanupStarted = resolve; });
  const cleanupRelease = new Promise((resolve) => { releaseCleanup = resolve; });
  try {
    await writeFile(
      join(stateRoot, planTerminalFileName("plan-session-1")),
      JSON.stringify(legacyPlanTerminal()),
      { mode: 0o600 },
    );
    const runtime = createPlanRuntime({
      ...runtimeOptions(stateRoot, client, events),
      randomUUID: () => `run-${++nextRun}`,
      syncDirectory: async () => {
        if (!failCleanup) return;
        cleanupStarted();
        await cleanupRelease;
        failCleanup = false;
        throw new Error(`fsync failed for ${privatePath}`);
      },
    });
    const firstPending = runtime.generate(generateRequest());
    await cleanupEntered;
    const duplicatePending = runtime.generate(generateRequest());
    releaseCleanup();

    const failures = await Promise.all([
      firstPending.catch((error) => error),
      duplicatePending.catch((error) => error),
    ]);
    assert.deepEqual(failures.map((error) => error.message), [
      "Plan state persistence is unavailable.",
      "Plan state persistence is unavailable.",
    ]);
    assert.equal(JSON.stringify(failures).includes(privatePath), false);
    assert.deepEqual(events, []);
    assert.equal(client.newSessionCalls, 0);

    const retry = await runtime.generate(generateRequest());
    assert.equal(retry.duplicate, false);
    assert.equal(retry.runId, "run-2");
    await terminalEvent(events, retry.runId);
    await runtime.close();
  } finally {
    releaseCleanup?.();
    await rm(stateRoot, { recursive: true, force: true });
  }
});

test("Plan runtime allows only one globally active Plan generation", async () => {
  const { createPlanRuntime } = await loadPlanRuntime();
  const stateRoot = await mkdtemp(join(tmpdir(), "skyturn-plan-runtime-"));
  const client = new FakeAcpClient({ deferredNewSession: true });
  const events = [];
  try {
    const runtime = createPlanRuntime(runtimeOptions(stateRoot, client, events));
    await runtime.generate(generateRequest());
    await waitFor(() => client.newSessionCalls === 1);

    await assert.rejects(runtime.generate({
      ...generateRequest(),
      planSessionId: "plan-session-2",
    }), /Plan runtime is busy\./);
    assert.equal(client.newSessionCalls, 1);

    const active = events.find((event) => event.kind === "started");
    const cancelling = runtime.cancel({
      planSessionId: "plan-session-1",
      projectRoot: "/repo",
      runId: active.runId,
    });
    client.completeNewSession();
    await cancelling;
    await runtime.close();
  } finally {
    await rm(stateRoot, { recursive: true, force: true });
  }
});

test("Plan runtime fails explicitly for an invalid existing mapping without creating a conversation", async () => {
  const { createPlanRuntime, planMappingFileName } = await loadPlanRuntime();
  const stateRoot = await mkdtemp(join(tmpdir(), "skyturn-plan-runtime-"));
  const client = new FakeAcpClient();
  const events = [];
  try {
    await writeFile(join(stateRoot, planMappingFileName("plan-session-1")), "not-json", { mode: 0o600 });
    const runtime = createPlanRuntime(runtimeOptions(stateRoot, client, events));
    await assert.rejects(
      runtime.generate({ ...generateRequest(), conversationStarted: true }),
      /Plan conversation mapping is invalid\./,
    );

    assert.deepEqual(events, []);
    assert.equal(client.newSessionCalls, 0);
    assert.equal(client.promptCalls.length, 0);
    await runtime.close();
  } finally {
    await rm(stateRoot, { recursive: true, force: true });
  }
});

test("Plan cancel keeps ownership until deferred newSession settles and blocks immediate retry", async () => {
  const { createPlanRuntime } = await loadPlanRuntime();
  const stateRoot = await mkdtemp(join(tmpdir(), "skyturn-plan-runtime-"));
  const client = new FakeAcpClient({ deferredNewSession: true });
  const events = [];
  try {
    const runtime = createPlanRuntime(runtimeOptions(stateRoot, client, events));
    const first = await runtime.generate(generateRequest());
    await waitFor(() => client.newSessionCalls === 1);

    const cancelling = runtime.cancel({ planSessionId: "plan-session-1", projectRoot: "/repo", runId: first.runId });
    const duplicate = await runtime.generate(generateRequest());

    assert.equal(duplicate.duplicate, true);
    assert.equal(duplicate.runId, first.runId);
    assert.equal(client.newSessionCalls, 1);
    assert.equal(client.promptCalls.length, 0);
    const cancelled = await cancelling;
    assert.equal(cancelled.cancelled, true);
    assert.deepEqual(events.filter((event) => event.kind === "failed").map((event) => event.error), [
      "Plan generation was cancelled.",
    ]);
    assert.equal(client.promptCalls.length, 0);
    assert.equal(client.closed, true);

    const retryClient = new FakeAcpClient();
    client.replacement = retryClient;
    const retry = await runtime.generate(generateRequest());
    assert.equal(retry.duplicate, false);
    await terminalEvent(events, retry.runId);
    assert.equal(retryClient.newSessionCalls, 1);
    await runtime.close();
  } finally {
    await rm(stateRoot, { recursive: true, force: true });
  }
});

test("Plan cancel ignores late prompt callbacks and completion", async () => {
  const { createPlanRuntime } = await loadPlanRuntime();
  const stateRoot = await mkdtemp(join(tmpdir(), "skyturn-plan-runtime-"));
  const client = new FakeAcpClient({ deferred: true });
  const events = [];
  try {
    const runtime = createPlanRuntime(runtimeOptions(stateRoot, client, events));
    const run = await runtime.generate(generateRequest());
    await waitFor(() => client.promptCalls.length === 1);
    await runtime.cancel({ planSessionId: "plan-session-1", projectRoot: "/repo", runId: run.runId });

    client.emitPromptText("late secret output");
    client.completePrompt();
    await new Promise((resolve) => setTimeout(resolve, 20));

    assert.equal(events.some((event) => event.kind === "delta" && event.text.includes("late")), false);
    assert.equal(events.some((event) => event.kind === "completed"), false);
    assert.equal(events.filter((event) => event.kind === "failed").length, 1);
    await runtime.close();
  } finally {
    await rm(stateRoot, { recursive: true, force: true });
  }
});

test("Plan cancel closes a prompt that ignores cancellation and returns only after ownership releases", async () => {
  const { createPlanRuntime } = await loadPlanRuntime();
  const stateRoot = await mkdtemp(join(tmpdir(), "skyturn-plan-runtime-"));
  const firstClient = new FakeAcpClient({ deferred: true });
  const secondClient = new FakeAcpClient();
  const clients = [firstClient, secondClient];
  const events = [];
  try {
    const runtime = createPlanRuntime({
      ...runtimeOptions(stateRoot, firstClient, events),
      createClient: async () => clients.shift(),
      cancelSettlementGraceMs: 20,
    });
    const run = await runtime.generate(generateRequest());
    await waitFor(() => firstClient.promptCalls.length === 1);
    const startedAt = Date.now();
    const cancelling = runtime.cancel({ planSessionId: "plan-session-1", projectRoot: "/repo", runId: run.runId });
    const duplicate = await runtime.generate(generateRequest());

    assert.equal(duplicate.duplicate, true);
    assert.equal(duplicate.runId, run.runId);
    assert.deepEqual(toPlain(await cancelling), { protocolVersion: 1, cancelled: true });
    assert.ok(Date.now() - startedAt < 500);
    assert.equal(firstClient.cancelCalls, 1);
    assert.equal(firstClient.closeCalls, 1);

    const retry = await runtime.generate(generateRequest());
    assert.equal(retry.duplicate, false);
    await terminalEvent(events, retry.runId);
    assert.deepEqual(secondClient.loadSessionCalls, [{ cwd: "/repo", sessionId: firstClient.sessionId }]);
    await runtime.close();
  } finally {
    await rm(stateRoot, { recursive: true, force: true });
  }
});

test("Plan cancel retains ownership until aborted client initialization is reaped", async () => {
  const { createPlanRuntime } = await loadPlanRuntime();
  const stateRoot = await mkdtemp(join(tmpdir(), "skyturn-plan-runtime-"));
  const retryClient = new FakeAcpClient();
  const events = [];
  let creationSignal;
  let releaseFactoryCleanup;
  let factoryCalls = 0;
  const factoryCleanupRelease = new Promise((resolve) => { releaseFactoryCleanup = resolve; });
  let runtime;
  try {
    runtime = createPlanRuntime({
      ...runtimeOptions(stateRoot, retryClient, events),
      createClient: async (signal) => {
        factoryCalls += 1;
        if (factoryCalls > 1) return retryClient;
        creationSignal = signal;
        await new Promise((resolve) => signal.addEventListener("abort", resolve, { once: true }));
        await factoryCleanupRelease;
        throw new Error("private initialization abort");
      },
      cancelSettlementGraceMs: 20,
    });
    const run = await runtime.generate(generateRequest());
    await waitFor(() => creationSignal !== undefined);
    const cancelling = runtime.cancel({
      planSessionId: "plan-session-1",
      projectRoot: "/repo",
      runId: run.runId,
    });
    let cancelSettled = false;
    void cancelling.then(
      () => { cancelSettled = true; },
      () => { cancelSettled = true; },
    );
    await waitFor(() => creationSignal.aborted);
    await terminalEvent(events, run.runId);
    await new Promise((resolve) => setImmediate(resolve));
    const duplicate = await runtime.generate(generateRequest());

    assert.equal(cancelSettled, false);
    assert.equal(duplicate.duplicate, true);
    assert.equal(duplicate.runId, run.runId);
    assert.equal(factoryCalls, 1);
    releaseFactoryCleanup();
    assert.deepEqual(toPlain(await cancelling), { protocolVersion: 1, cancelled: true });
    assert.deepEqual(events.filter((event) => event.kind === "failed").map((event) => event.error), [
      "Plan generation was cancelled.",
    ]);
    const retry = await runtime.generate(generateRequest());
    await terminalEvent(events, retry.runId);
    assert.equal(factoryCalls, 2);
    await runtime.close();
  } finally {
    releaseFactoryCleanup?.();
    await runtime?.close();
    await rm(stateRoot, { recursive: true, force: true });
  }
});

test("Plan runtime closes a client returned after cancelled initialization", async () => {
  const { createPlanRuntime } = await loadPlanRuntime();
  const stateRoot = await mkdtemp(join(tmpdir(), "skyturn-plan-runtime-"));
  const lateClient = new FakeAcpClient();
  const events = [];
  let creationSignal;
  let resolveClient;
  const pendingClient = new Promise((resolve) => { resolveClient = resolve; });
  try {
    const runtime = createPlanRuntime({
      ...runtimeOptions(stateRoot, lateClient, events),
      createClient: (signal) => {
        creationSignal = signal;
        return pendingClient;
      },
      cancelSettlementGraceMs: 20,
    });
    const run = await runtime.generate(generateRequest());
    await waitFor(() => creationSignal !== undefined);
    const cancelling = runtime.cancel({
      planSessionId: "plan-session-1",
      projectRoot: "/repo",
      runId: run.runId,
    });
    let cancelSettled = false;
    void cancelling.then(
      () => { cancelSettled = true; },
      () => { cancelSettled = true; },
    );
    await terminalEvent(events, run.runId);
    await new Promise((resolve) => setImmediate(resolve));

    assert.equal(cancelSettled, false);
    resolveClient(lateClient);
    await cancelling;
    assert.equal(creationSignal.aborted, true);
    await waitFor(() => lateClient.closeCalls === 1);
    assert.equal(lateClient.newSessionCalls, 0);
    assert.equal(lateClient.promptCalls.length, 0);
    await runtime.close();
  } finally {
    resolveClient?.(lateClient);
    await rm(stateRoot, { recursive: true, force: true });
  }
});

test("Plan runtime close rejects a blocked unaccepted preflight without a phantom terminal", async () => {
  const { createPlanRuntime, planTerminalFileName } = await loadPlanRuntime();
  const stateRoot = await mkdtemp(join(tmpdir(), "skyturn-plan-runtime-"));
  const events = [];
  let releaseCleanup;
  let cleanupStarted;
  const cleanupEntered = new Promise((resolve) => { cleanupStarted = resolve; });
  const cleanupRelease = new Promise((resolve) => { releaseCleanup = resolve; });
  let runtime;
  try {
    await writeFile(
      join(stateRoot, planTerminalFileName("plan-session-1")),
      JSON.stringify(legacyPlanTerminal()),
      { mode: 0o600 },
    );
    runtime = createPlanRuntime({
      ...runtimeOptions(stateRoot, new FakeAcpClient(), events),
      syncDirectory: async () => {
        cleanupStarted();
        await cleanupRelease;
      },
    });
    const starting = runtime.generate(generateRequest());
    await cleanupEntered;
    const closing = runtime.close();

    assert.deepEqual(events, []);
    releaseCleanup();
    await assert.rejects(starting, /Plan runtime is shut down\./);
    await closing;
    assert.deepEqual(events, []);
    const files = await readdir(stateRoot);
    assert.equal(files.length, 1);
    const persisted = JSON.parse(await readFile(join(stateRoot, files[0]), "utf8"));
    assert.equal(persisted.active.runId, "run-1");
    assert.equal(persisted.terminal.kind, "completed");
    assert.equal(persisted.snapshot.plan.requirements, "# Legacy Requirements");
  } finally {
    releaseCleanup?.();
    await runtime?.close();
    await rm(stateRoot, { recursive: true, force: true });
  }
});

test("Plan cancel rejects a matching run from another canonical project", async () => {
  const { createPlanRuntime } = await loadPlanRuntime();
  const stateRoot = await mkdtemp(join(tmpdir(), "skyturn-plan-runtime-"));
  const client = new FakeAcpClient({ deferred: true });
  const events = [];
  try {
    const runtime = createPlanRuntime(runtimeOptions(stateRoot, client, events));
    const run = await runtime.generate(generateRequest());
    await waitFor(() => client.promptCalls.length === 1);

    await assert.rejects(runtime.cancel({
      planSessionId: "plan-session-1",
      projectRoot: "/different-repo",
      runId: run.runId,
    }), /Plan conversation mapping project does not match\./);
    assert.equal(client.cancelCalls, 0);

    await runtime.cancel({ planSessionId: "plan-session-1", projectRoot: "/repo", runId: run.runId });
    await runtime.close();
  } finally {
    await rm(stateRoot, { recursive: true, force: true });
  }
});

test("Plan runtime closes a client that finishes creation after runtime shutdown", async () => {
  const { createPlanRuntime } = await loadPlanRuntime();
  const stateRoot = await mkdtemp(join(tmpdir(), "skyturn-plan-runtime-"));
  const client = new FakeAcpClient();
  const events = [];
  let creationSignal;
  let resolveClient;
  const clientCreation = new Promise((resolve) => { resolveClient = resolve; });
  try {
    const runtime = createPlanRuntime({
      ...runtimeOptions(stateRoot, client, events),
      createClient: (signal) => {
        creationSignal = signal;
        return clientCreation;
      },
    });
    await runtime.generate(generateRequest());
    const closing = runtime.close();
    assert.equal(typeof closing?.then, "function");

    resolveClient(client);
    await closing;

    assert.equal(creationSignal.aborted, true);
    assert.equal(client.closed, true);
    assert.equal(client.closeCalls, 1);
    assert.equal(client.newSessionCalls, 0);
    assert.equal(client.promptCalls.length, 0);
    const files = await readdir(stateRoot);
    assert.equal(files.length, 1);
    const terminalText = await readFile(join(stateRoot, files[0]), "utf8");
    assert.equal(terminalText.includes("plan-session-1"), false);
  } finally {
    await rm(stateRoot, { recursive: true, force: true });
  }
});

test("Plan getState recovers a missed sanitized terminal event and an exact active draft", async () => {
  const { createPlanRuntime } = await loadPlanRuntime();
  const stateRoot = await mkdtemp(join(tmpdir(), "skyturn-plan-runtime-"));
  const terminalClient = new FakeAcpClient();
  const terminalEvents = [];
  try {
    const runtime = createPlanRuntime(runtimeOptions(stateRoot, terminalClient, terminalEvents));
    await runtime.generate(generateRequest());
    const completed = await terminalEvent(terminalEvents);
    const recovered = await runtime.getState({ planSessionId: "plan-session-1", projectRoot: "/repo" });

    assert.deepEqual(toPlain(recovered), {
      protocolVersion: 1,
      needsBootstrap: false,
      snapshot: toPlain(completed.snapshot),
      active: null,
      terminal: toPlain(completed),
    });
    assert.equal(JSON.stringify(recovered).includes(terminalClient.sessionId), false);
    await runtime.close();

    const activeStateRoot = await mkdtemp(join(tmpdir(), "skyturn-plan-runtime-"));
    const activeClient = new FakeAcpClient({ deferred: true });
    const activeEvents = [];
    try {
      const activeRuntime = createPlanRuntime(runtimeOptions(activeStateRoot, activeClient, activeEvents));
      await activeRuntime.generate(generateRequest());
      await waitFor(() => activeClient.promptCalls.length === 1);

      assert.deepEqual(toPlain((await activeRuntime.getState({
        planSessionId: "plan-session-1",
        projectRoot: "/repo",
      })).active), {
        planSessionId: "plan-session-1",
        runId: "run-1",
        stage: "requirements",
        operation: "generate",
        conversationReady: true,
        draft: "# Requirements",
        checkpoints: { requirements: [], design: [], tasks: [] },
      });
      activeClient.completePrompt();
      await terminalEvent(activeEvents);
      await activeRuntime.close();
    } finally {
      await rm(activeStateRoot, { recursive: true, force: true });
    }
  } finally {
    await rm(stateRoot, { recursive: true, force: true });
  }
});

test("Plan runtime keeps client-redacted values and terminal prefixes out of every public state", async () => {
  const { createPlanRuntime } = await loadPlanRuntime();
  const stateRoot = await mkdtemp(join(tmpdir(), "skyturn-plan-runtime-"));
  const projectRoot = "/private/projects/skyturn-plan-secret";
  const prompt = [
    "/private planning only.",
    `Project root: ${projectRoot}`,
    "Return only the complete Requirements document.",
  ].join("\n\n");
  const sessionId = "/private/acp-session-secret";
  const terminalPrefix = "/priv";
  const ordinaryMarkdown = "# Requirements\n\nKeep **ordinary** Markdown and `/docs/example` intact.\n\n";
  const rawOutput = [ordinaryMarkdown, prompt, projectRoot, sessionId, "Complete.", terminalPrefix].join("\n\n");
  const publicOutput = [
    ordinaryMarkdown,
    "[redacted]",
    "[redacted]",
    "[redacted]",
    "Complete.",
    "[redacted]",
  ].join("\n\n");
  const client = new FakeAcpClient({ chunks: Array.from(publicOutput), deferred: true, resultMarkdown: rawOutput });
  client.sessionId = sessionId;
  const events = [];
  const request = { ...generateRequest(), projectRoot };
  try {
    const runtime = createPlanRuntime({
      ...runtimeOptions(stateRoot, client, events),
      buildPrompt: async () => prompt,
    });
    const start = await runtime.generate(request);
    await waitFor(() => client.promptCalls.length === 1);
    assert.equal(client.promptCalls[0].redactProjectRoot, projectRoot);

    const active = await runtime.getState({ planSessionId: request.planSessionId, projectRoot });
    const publicBeforeCompletion = JSON.stringify({ events, active });
    assert.equal(publicBeforeCompletion.includes(prompt), false);
    assert.equal(publicBeforeCompletion.includes(projectRoot), false);
    assert.equal(publicBeforeCompletion.includes(client.sessionId), false);
    assert.equal(publicBeforeCompletion.includes(terminalPrefix), false);
    assert.equal(active.active.draft.startsWith(ordinaryMarkdown), true);

    client.completePrompt();
    const completed = await terminalEvent(events, start.runId);
    const deltaText = events
      .filter((event) => event.runId === start.runId && event.kind === "delta")
      .map((event) => event.text)
      .join("");
    assert.equal(deltaText, completed.markdown);
    assert.equal(completed.markdown.startsWith(ordinaryMarkdown), true);
    assert.equal(completed.markdown.includes(prompt), false);
    assert.equal(completed.markdown.includes(projectRoot), false);
    assert.equal(completed.markdown.includes(client.sessionId), false);
    assert.equal(completed.markdown.includes(terminalPrefix), false);
    await runtime.close();
    const persistedState = await Promise.all(
      (await readdir(stateRoot)).map((file) => readFile(join(stateRoot, file), "utf8")),
    );
    const persistedTerminal = persistedState.find((text) => text.includes('"kind":"completed"'));
    assert.equal(typeof persistedTerminal, "string");
    assert.equal(persistedTerminal.includes(terminalPrefix), false);

    const reopened = createPlanRuntime(runtimeOptions(stateRoot, new FakeAcpClient(), []));
    const recovered = await reopened.getState({ planSessionId: request.planSessionId, projectRoot });
    assert.deepEqual(toPlain(recovered.terminal), toPlain(completed));
    assert.equal(JSON.stringify(recovered).includes(prompt), false);
    assert.equal(JSON.stringify(recovered).includes(projectRoot), false);
    assert.equal(JSON.stringify(recovered).includes(client.sessionId), false);
    assert.equal(JSON.stringify(recovered).includes(terminalPrefix), false);
    await reopened.close();
  } finally {
    await rm(stateRoot, { recursive: true, force: true });
  }
});

test("Plan runtime durably recovers completed and failed terminals after close and reopen", async () => {
  const { createPlanRuntime } = await loadPlanRuntime();
  for (const promptError of [undefined, new Error("Hermes ACP prompt failed.")]) {
    const stateRoot = await mkdtemp(join(tmpdir(), "skyturn-plan-runtime-"));
    const firstClient = new FakeAcpClient({ promptError });
    const firstEvents = [];
    try {
      const firstRuntime = createPlanRuntime(runtimeOptions(stateRoot, firstClient, firstEvents));
      const start = await firstRuntime.generate(generateRequest());
      const terminal = await terminalEvent(firstEvents, start.runId);
      await firstRuntime.close();

      const reopened = createPlanRuntime(runtimeOptions(stateRoot, new FakeAcpClient(), []));
      const recovered = await reopened.getState({ planSessionId: "plan-session-1", projectRoot: "/repo" });
      assert.deepEqual(toPlain(recovered.terminal), toPlain(terminal));
      assert.equal(JSON.stringify(recovered).includes(firstClient.sessionId), false);
      await assert.rejects(
        reopened.getState({ planSessionId: "plan-session-1", projectRoot: "/different-repo" }),
        /Plan conversation mapping project does not match\./,
      );
      await reopened.close();
    } finally {
      await rm(stateRoot, { recursive: true, force: true });
    }
  }
});

test("Plan terminal publication failure cannot contradict a durably completed terminal", async () => {
  const { createPlanRuntime } = await loadPlanRuntime();
  const stateRoot = await mkdtemp(join(tmpdir(), "skyturn-plan-runtime-"));
  const client = new FakeAcpClient();
  const events = [];
  try {
    const runtime = createPlanRuntime({
      ...runtimeOptions(stateRoot, client, events),
      emit: (event) => {
        if (event.kind === "completed") throw new Error("renderer broadcast failed");
        events.push(event);
      },
    });
    await runtime.generate(generateRequest());
    const persisted = await waitForTerminalState(runtime);
    await runtime.close();

    assert.equal(persisted.kind, "completed");
    assert.equal(events.some((event) =>
      event.kind === "failed" && event.error === "Plan terminal persistence failed."), false);

    const reopened = createPlanRuntime(runtimeOptions(stateRoot, new FakeAcpClient(), []));
    const recovered = await reopened.getState({ planSessionId: "plan-session-1", projectRoot: "/repo" });
    assert.deepEqual(toPlain(recovered.terminal), toPlain(persisted));
    await reopened.close();
  } finally {
    await rm(stateRoot, { recursive: true, force: true });
  }
});

test("a newly started Plan run preserves then replaces its durable predecessor", async () => {
  const { createPlanRuntime } = await loadPlanRuntime();
  const stateRoot = await mkdtemp(join(tmpdir(), "skyturn-plan-runtime-"));
  const client = new FakeAcpClient();
  const events = [];
  try {
    const runtime = createPlanRuntime(runtimeOptions(stateRoot, client, events));
    const first = await runtime.generate(generateRequest());
    const firstTerminal = await terminalEvent(events, first.runId);
    assert.equal(firstTerminal.stage, "requirements");
    client.deferred = true;
    const second = await runtime.generate({
      ...generateRequest(),
      expectedStateVersion: 1,
    });
    await waitFor(() => client.promptCalls.length === 2);
    const active = await runtime.getState({ planSessionId: "plan-session-1", projectRoot: "/repo" });
    assert.equal(active.active.runId, second.runId);
    assert.equal(active.terminal.runId, firstTerminal.runId);
    assert.equal(active.terminal.kind, "completed");
    assert.deepEqual(toPlain(active.terminal.snapshot), toPlain(firstTerminal.snapshot));

    client.completePrompt();
    const secondTerminal = await terminalEvent(events, second.runId);
    await runtime.close();
    const reopened = createPlanRuntime(runtimeOptions(stateRoot, new FakeAcpClient(), []));
    const recovered = await reopened.getState({ planSessionId: "plan-session-1", projectRoot: "/repo" });
    assert.deepEqual(toPlain(recovered.terminal), toPlain(secondTerminal));
    await reopened.close();
  } finally {
    await rm(stateRoot, { recursive: true, force: true });
  }
});

test("Plan runtime atomically recovers two exact revision checkpoints after immediate reopen", async () => {
  const { createPlanRuntime } = await loadPlanRuntime();
  const stateRoot = await mkdtemp(join(tmpdir(), "skyturn-plan-checkpoints-"));
  const client = new FakeAcpClient({ chunks: ["requirements-v0"] });
  const events = [];
  try {
    const runtime = createPlanRuntime(runtimeOptions(stateRoot, client, events));
    const generated = await runtime.generate(generateRequest());
    assert.deepEqual(toPlain((await terminalEvent(events, generated.runId)).checkpoints), {
      requirements: [], design: [], tasks: [],
    });

    client.chunks = ["requirements-v1"];
    const firstRevision = await runtime.revise({
      ...generateRequest(),
      operation: "revise",
      expectedStateVersion: 1,
      instruction: "Create v1.",
    });
    assert.deepEqual(toPlain((await terminalEvent(events, firstRevision.runId)).checkpoints), {
      requirements: ["requirements-v0"], design: [], tasks: [],
    });

    client.chunks = ["requirements-v2"];
    const secondRevision = await runtime.revise({
      ...generateRequest(),
      operation: "revise",
      expectedStateVersion: 2,
      instruction: "Create v2.",
    });
    const completed = await terminalEvent(events, secondRevision.runId);
    assert.equal(completed.markdown, "requirements-v2");
    assert.deepEqual(toPlain(completed.checkpoints), {
      requirements: ["requirements-v0", "requirements-v1"], design: [], tasks: [],
    });
    await runtime.close();

    const reopened = createPlanRuntime(runtimeOptions(stateRoot, new FakeAcpClient(), []));
    const recovered = await reopened.getState({ planSessionId: "plan-session-1", projectRoot: "/repo" });
    assert.deepEqual(toPlain(recovered.terminal), toPlain(completed));
    await reopened.close();
  } finally {
    await rm(stateRoot, { recursive: true, force: true });
  }
});

test("a successful revision from an Undo-selected checkpoint truncates the durable branch", async () => {
  const { createPlanRuntime } = await loadPlanRuntime();
  const stateRoot = await mkdtemp(join(tmpdir(), "skyturn-plan-checkpoints-"));
  const initialClient = new FakeAcpClient({ chunks: ["requirements-v0"] });
  const initialEvents = [];
  try {
    const initial = createPlanRuntime(runtimeOptions(stateRoot, initialClient, initialEvents));
    await buildRequirementHistory(initial, initialClient, initialEvents);
    await initial.close();

    const revisionClient = new FakeAcpClient({ chunks: ["requirements-v1-prime"] });
    const revisionEvents = [];
    const revision = createPlanRuntime(runtimeOptions(stateRoot, revisionClient, revisionEvents));
    const undone = await revision.undoStage({
      planSessionId: "plan-session-1",
      projectRoot: "/repo",
      stage: "requirements",
      expectedStateVersion: 3,
    });
    assert.equal(undone.snapshot.plan.requirements, "requirements-v1");
    const completed = await terminalEvent(revisionEvents, (await revision.revise({
      ...generateRequest(),
      operation: "revise",
      expectedStateVersion: 4,
      instruction: "Create v1-prime from the selected checkpoint.",
    })).runId);
    assert.equal(completed.markdown, "requirements-v1-prime");
    assert.deepEqual(toPlain(completed.checkpoints), {
      requirements: ["requirements-v0", "requirements-v1"], design: [], tasks: [],
    });
    await revision.close();

    const reopened = createPlanRuntime(runtimeOptions(stateRoot, new FakeAcpClient(), []));
    const recovered = await reopened.getState({ planSessionId: "plan-session-1", projectRoot: "/repo" });
    assert.deepEqual(toPlain(recovered.terminal.checkpoints), {
      requirements: ["requirements-v0", "requirements-v1"], design: [], tasks: [],
    });
    await reopened.close();
  } finally {
    await rm(stateRoot, { recursive: true, force: true });
  }
});

test("a failed revision from an Undo-selected checkpoint preserves only its aligned prefix", async () => {
  const { createPlanRuntime, planTerminalFileName } = await loadPlanRuntime();
  const stateRoot = await mkdtemp(join(tmpdir(), "skyturn-plan-checkpoints-"));
  const initialClient = new FakeAcpClient({ chunks: ["requirements-v0"] });
  const initialEvents = [];
  try {
    const initial = createPlanRuntime(runtimeOptions(stateRoot, initialClient, initialEvents));
    await buildRequirementHistory(initial, initialClient, initialEvents);
    await initial.acceptStage({
      planSessionId: "plan-session-1", projectRoot: "/repo", stage: "requirements", expectedStateVersion: 3,
    });
    initialClient.chunks = ["design-v0"];
    await terminalEvent(initialEvents, (await initial.generate({
      ...generateRequest(),
      stage: "design",
      expectedStateVersion: 4,
    })).runId);
    initialClient.chunks = ["design-v1"];
    await terminalEvent(initialEvents, (await initial.revise({
      ...generateRequest(),
      operation: "revise",
      stage: "design",
      expectedStateVersion: 5,
      instruction: "Create design v1.",
    })).runId);
    await initial.close();

    const failedClient = new FakeAcpClient({ promptError: new Error("Hermes ACP prompt failed.") });
    const failedEvents = [];
    const revision = createPlanRuntime(runtimeOptions(stateRoot, failedClient, failedEvents));
    const undone = await revision.undoStage({
      planSessionId: "plan-session-1", projectRoot: "/repo", stage: "requirements", expectedStateVersion: 6,
    });
    assert.equal(undone.snapshot.plan.requirements, "requirements-v1");
    const failed = await terminalEvent(failedEvents, (await revision.revise({
      ...generateRequest(),
      operation: "revise",
      expectedStateVersion: 7,
      instruction: "Fail from the selected checkpoint.",
    })).runId);
    assert.equal(failed.kind, "failed");
    assert.deepEqual(toPlain(failed.checkpoints), {
      requirements: ["requirements-v0"], design: [], tasks: [],
    });
    await revision.close();
    const persisted = JSON.parse(await readFile(join(stateRoot, planTerminalFileName("plan-session-1")), "utf8"));
    assert.equal(persisted.snapshot.plan.requirements, "requirements-v1");
    assert.equal(persisted.snapshot.plan.design, "");

    const reopened = createPlanRuntime(runtimeOptions(stateRoot, new FakeAcpClient(), []));
    const recovered = await reopened.getState({ planSessionId: "plan-session-1", projectRoot: "/repo" });
    assert.deepEqual(toPlain(recovered.terminal.checkpoints), {
      requirements: ["requirements-v0"], design: [], tasks: [],
    });
    await reopened.close();
  } finally {
    await rm(stateRoot, { recursive: true, force: true });
  }
});

test("cancelling a revision from an Undo-selected checkpoint preserves its aligned prefix", async () => {
  const { createPlanRuntime } = await loadPlanRuntime();
  const stateRoot = await mkdtemp(join(tmpdir(), "skyturn-plan-checkpoints-"));
  const initialClient = new FakeAcpClient({ chunks: ["requirements-v0"] });
  const initialEvents = [];
  try {
    const initial = createPlanRuntime(runtimeOptions(stateRoot, initialClient, initialEvents));
    await buildRequirementHistory(initial, initialClient, initialEvents);
    await initial.close();

    const cancelClient = new FakeAcpClient({ deferred: true });
    const cancelEvents = [];
    const revision = createPlanRuntime(runtimeOptions(stateRoot, cancelClient, cancelEvents));
    const undone = await revision.undoStage({
      planSessionId: "plan-session-1", projectRoot: "/repo", stage: "requirements", expectedStateVersion: 3,
    });
    assert.equal(undone.snapshot.plan.requirements, "requirements-v1");
    const started = await revision.revise(
      reviseRequirementsRequest("requirements-v1", "Cancel from the selected checkpoint.", 4),
    );
    await waitFor(() => cancelClient.promptCalls.length === 1);
    const active = await revision.getState({ planSessionId: "plan-session-1", projectRoot: "/repo" });
    assert.deepEqual(toPlain(active.active.checkpoints), {
      requirements: ["requirements-v0"], design: [], tasks: [],
    });

    const terminalPromise = terminalEvent(cancelEvents, started.runId);
    assert.deepEqual(toPlain(await revision.cancel({
      planSessionId: "plan-session-1",
      projectRoot: "/repo",
      runId: started.runId,
    })), { protocolVersion: 1, cancelled: true });
    const cancelled = await terminalPromise;
    assert.deepEqual(toPlain(cancelled.checkpoints), {
      requirements: ["requirements-v0"], design: [], tasks: [],
    });
    assert.deepEqual(toPlain(cancelled.snapshot), toPlain(active.snapshot));
    await revision.close();
  } finally {
    await rm(stateRoot, { recursive: true, force: true });
  }
});

test("per-stage heads survive a later-stage terminal and preserve ordinary failed revision history", async () => {
  const { createPlanRuntime, planTerminalFileName } = await loadPlanRuntime();
  const stateRoot = await mkdtemp(join(tmpdir(), "skyturn-plan-heads-"));
  const client = new FakeAcpClient({ chunks: ["requirements-v0"] });
  const events = [];
  try {
    const runtime = createPlanRuntime(runtimeOptions(stateRoot, client, events));
    await terminalEvent(events, (await runtime.generate(generateRequest())).runId);
    client.chunks = ["requirements-v1"];
    await terminalEvent(events, (await runtime.revise(reviseRequirementsRequest("requirements-v0", "Create v1."))).runId);
    client.chunks = ["requirements-v0"];
    await terminalEvent(events, (await runtime.revise(
      reviseRequirementsRequest("requirements-v1", "Return to v0.", 2),
    )).runId);
    await runtime.acceptStage({
      planSessionId: "plan-session-1", projectRoot: "/repo", stage: "requirements", expectedStateVersion: 3,
    });
    client.chunks = ["design-v0"];
    await terminalEvent(events, (await runtime.generate({
      ...generateRequest(),
      stage: "design",
      expectedStateVersion: 4,
    })).runId);
    client.chunks = ["design-v1"];
    await terminalEvent(events, (await runtime.revise({
      ...generateRequest(),
      operation: "revise",
      stage: "design",
      expectedStateVersion: 5,
      instruction: "Create design v1.",
    })).runId);
    await runtime.close();
    const persisted = JSON.parse(await readFile(join(stateRoot, planTerminalFileName("plan-session-1")), "utf8"));
    assert.equal(persisted.snapshot.plan.requirements, "requirements-v0");
    assert.equal(persisted.snapshot.plan.design, "design-v1");

    const failedClient = new FakeAcpClient({ promptError: new Error("Hermes ACP prompt failed.") });
    const failedEvents = [];
    const reopened = createPlanRuntime(runtimeOptions(stateRoot, failedClient, failedEvents));
    const failed = await terminalEvent(failedEvents, (await reopened.revise(
      reviseRequirementsRequest("requirements-v0", "Fail from the current requirements head.", 6),
    )).runId);
    assert.deepEqual(toPlain(failed.checkpoints), {
      requirements: ["requirements-v0", "requirements-v1"],
      design: ["design-v0"],
      tasks: [],
    });
    await reopened.close();
  } finally {
    await rm(stateRoot, { recursive: true, force: true });
  }
});

test("a manual revision candidate appends without deleting unrelated history", async () => {
  const { createPlanRuntime } = await loadPlanRuntime();
  const stateRoot = await mkdtemp(join(tmpdir(), "skyturn-plan-heads-"));
  const client = new FakeAcpClient({ chunks: ["requirements-v0"] });
  const events = [];
  try {
    const runtime = createPlanRuntime(runtimeOptions(stateRoot, client, events));
    await buildRequirementHistory(runtime, client, events);
    await runtime.updateStage({
      planSessionId: "plan-session-1", projectRoot: "/repo", stage: "requirements",
      expectedStateVersion: 3, markdown: "requirements-manual",
    });
    client.chunks = ["requirements-manual-result"];
    const completed = await terminalEvent(events, (await runtime.revise(
      reviseRequirementsRequest("requirements-manual", "Revise from a manual edit.", 4),
    )).runId);
    assert.deepEqual(toPlain(completed.checkpoints), {
      requirements: ["requirements-v0", "requirements-v1", "requirements-manual"], design: [], tasks: [],
    });
    await runtime.close();
  } finally {
    await rm(stateRoot, { recursive: true, force: true });
  }
});

test("an upstream revision clears downstream backend checkpoints", async () => {
  const { createPlanRuntime } = await loadPlanRuntime();
  const stateRoot = await mkdtemp(join(tmpdir(), "skyturn-plan-checkpoints-"));
  const client = new FakeAcpClient({ chunks: ["requirements-v0"] });
  const events = [];
  try {
    const runtime = createPlanRuntime(runtimeOptions(stateRoot, client, events));
    await terminalEvent(events, (await runtime.generate(generateRequest())).runId);
    await runtime.acceptStage({
      planSessionId: "plan-session-1", projectRoot: "/repo", stage: "requirements", expectedStateVersion: 1,
    });

    client.chunks = ["design-v0"];
    await terminalEvent(events, (await runtime.generate({
      ...generateRequest(),
      stage: "design",
      expectedStateVersion: 2,
    })).runId);
    client.chunks = ["design-v1"];
    await terminalEvent(events, (await runtime.revise({
      ...generateRequest(),
      operation: "revise",
      stage: "design",
      expectedStateVersion: 3,
      instruction: "Create design v1.",
    })).runId);
    await runtime.acceptStage({
      planSessionId: "plan-session-1", projectRoot: "/repo", stage: "design", expectedStateVersion: 4,
    });

    client.chunks = ["tasks-v0"];
    await terminalEvent(events, (await runtime.generate({
      ...generateRequest(),
      stage: "tasks",
      expectedStateVersion: 5,
    })).runId);
    client.chunks = ["tasks-v1"];
    const tasksRevision = await terminalEvent(events, (await runtime.revise({
      ...generateRequest(),
      operation: "revise",
      stage: "tasks",
      expectedStateVersion: 6,
      instruction: "Create tasks v1.",
    })).runId);
    assert.deepEqual(toPlain(tasksRevision.checkpoints), {
      requirements: [], design: ["design-v0"], tasks: ["tasks-v0"],
    });

    client.chunks = ["requirements-v1"];
    const requirementsRevision = await terminalEvent(events, (await runtime.revise({
      ...generateRequest(),
      operation: "revise",
      expectedStateVersion: 7,
      instruction: "Create requirements v1.",
    })).runId);
    assert.deepEqual(toPlain(requirementsRevision.checkpoints), {
      requirements: ["requirements-v0"], design: [], tasks: [],
    });
    await runtime.close();
  } finally {
    await rm(stateRoot, { recursive: true, force: true });
  }
});

test("a failed revision preserves the prior authoritative checkpoint ledger", async () => {
  const { createPlanRuntime } = await loadPlanRuntime();
  const stateRoot = await mkdtemp(join(tmpdir(), "skyturn-plan-checkpoints-"));
  const client = new FakeAcpClient({ chunks: ["requirements-v0"] });
  const events = [];
  try {
    const runtime = createPlanRuntime(runtimeOptions(stateRoot, client, events));
    await terminalEvent(events, (await runtime.generate(generateRequest())).runId);
    client.chunks = ["requirements-v1"];
    await terminalEvent(events, (await runtime.revise({
      ...generateRequest(),
      operation: "revise",
      expectedStateVersion: 1,
      instruction: "Create v1.",
    })).runId);

    client.promptError = new Error("Hermes ACP prompt failed.");
    const beforeFailure = await runtime.getState({ planSessionId: "plan-session-1", projectRoot: "/repo" });
    const failed = await terminalEvent(events, (await runtime.revise({
      ...generateRequest(),
      operation: "revise",
      expectedStateVersion: 2,
      instruction: "This revision fails.",
    })).runId);
    assert.equal(failed.kind, "failed");
    assert.deepEqual(toPlain(failed.checkpoints), {
      requirements: ["requirements-v0"], design: [], tasks: [],
    });
    assert.deepEqual(toPlain(failed.snapshot), toPlain(beforeFailure.snapshot));
    await runtime.close();

    const reopened = createPlanRuntime(runtimeOptions(stateRoot, new FakeAcpClient(), []));
    const recovered = await reopened.getState({ planSessionId: "plan-session-1", projectRoot: "/repo" });
    assert.deepEqual(toPlain(recovered.terminal.checkpoints), toPlain(failed.checkpoints));
    assert.deepEqual(toPlain(recovered.snapshot), toPlain(beforeFailure.snapshot));
    await reopened.close();
  } finally {
    await rm(stateRoot, { recursive: true, force: true });
  }
});

test("Plan snapshots, active markers, and terminals fail closed while legacy terminals migrate conservatively", async () => {
  const { createPlanRuntime, planTerminalFileName } = await loadPlanRuntime();
  const stateRoot = await mkdtemp(join(tmpdir(), "skyturn-plan-checkpoints-"));
  const events = [];
  try {
    const runtime = createPlanRuntime(runtimeOptions(stateRoot, new FakeAcpClient(), events));
    await terminalEvent(events, (await runtime.generate(generateRequest())).runId);
    await runtime.close();
    const terminalPath = join(stateRoot, planTerminalFileName("plan-session-1"));
    const persisted = JSON.parse(await readFile(terminalPath, "utf8"));

    const malformedRecords = [
      {
        ...persisted,
        snapshot: {
          ...persisted.snapshot,
          checkpoints: { requirements: [], design: [], tasks: "invalid" },
        },
      },
      {
        ...persisted,
        snapshot: { ...persisted.snapshot, version: -1 },
      },
      {
        ...persisted,
        snapshot: {
          ...persisted.snapshot,
          plan: { ...persisted.snapshot.plan, design: "accepted design without accepted requirements" },
          accepted: { ...persisted.snapshot.accepted, design: true },
        },
      },
      {
        ...persisted,
        active: { runId: "run-2", stage: "requirements", operation: "generate", baseVersion: -1 },
      },
      {
        ...persisted,
        active: {
          runId: "run-2",
          stage: "requirements",
          operation: "generate",
          baseVersion: persisted.snapshot.version + 1,
        },
      },
      {
        ...persisted,
        terminal: { ...persisted.terminal, extra: true },
      },
      {
        ...persisted,
        terminal: { runId: "run-2", stage: "design", operation: "generate", kind: "completed" },
      },
    ];
    for (const malformedRecord of malformedRecords) {
      await writeFile(terminalPath, JSON.stringify(malformedRecord), "utf8");
      const malformed = createPlanRuntime(runtimeOptions(stateRoot, new FakeAcpClient(), []));
      await assert.rejects(
        malformed.getState({ planSessionId: "plan-session-1", projectRoot: "/repo" }),
        /Plan state is invalid\./,
      );
      await malformed.close();
    }

    await writeFile(terminalPath, JSON.stringify({
      ...legacyPlanTerminal(),
      kind: "failed",
      error: "/private/persistence/detail",
      markdown: undefined,
    }), "utf8");
    const unsafeLegacy = createPlanRuntime(runtimeOptions(stateRoot, new FakeAcpClient(), []));
    await assert.rejects(
      unsafeLegacy.getState({ planSessionId: "plan-session-1", projectRoot: "/repo" }),
      /Plan state is invalid\./,
    );
    await unsafeLegacy.close();

    await writeFile(terminalPath, JSON.stringify(legacyPlanTerminal()), "utf8");
    const legacyRuntime = createPlanRuntime(runtimeOptions(stateRoot, new FakeAcpClient(), []));
    const recovered = await legacyRuntime.getState({ planSessionId: "plan-session-1", projectRoot: "/repo" });
    assert.equal(recovered.snapshot.version, 0);
    assert.equal(recovered.snapshot.plan.requirements, "# Legacy Requirements");
    assert.deepEqual(toPlain(recovered.snapshot.accepted), {
      requirements: false, design: false, tasks: false,
    });
    assert.deepEqual(toPlain(recovered.terminal.checkpoints), { requirements: [], design: [], tasks: [] });
    await legacyRuntime.close();
  } finally {
    await rm(stateRoot, { recursive: true, force: true });
  }
});

test("Plan runtime exposes only the fixed output-limit error", async () => {
  const { createPlanRuntime } = await loadPlanRuntime();
  const stateRoot = await mkdtemp(join(tmpdir(), "skyturn-plan-runtime-"));
  const client = new FakeAcpClient({ promptError: new Error("Hermes ACP output limit exceeded.") });
  const events = [];
  try {
    const runtime = createPlanRuntime(runtimeOptions(stateRoot, client, events));
    await runtime.generate(generateRequest());
    const failed = await terminalEvent(events);

    assert.equal(failed.error, "Hermes ACP output limit exceeded.");
    await runtime.close();
  } finally {
    await rm(stateRoot, { recursive: true, force: true });
  }
});

test("Plan completion persistence failure emits no terminal and recovers the durable active marker", async () => {
  const injection = terminalReplacementFailureFs();
  const { createPlanRuntime } = await loadPlanRuntime({ "node:fs/promises": injection.fs });
  const stateRoot = await mkdtemp(join(tmpdir(), "skyturn-plan-runtime-"));
  const client = new FakeAcpClient();
  const events = [];
  try {
    const runtime = createPlanRuntime(runtimeOptions(stateRoot, client, events));
    const run = await runtime.generate(generateRequest());
    await waitFor(() => events.some((event) => event.kind === "conversation_ready"));
    await waitForBounded(injection.failureObserved, "Terminal replacement failure deadline exceeded.");
    assert.equal(events.some((event) => event.kind === "completed" || event.kind === "failed"), false);
    injection.recover();
    const recovered = await runtime.getState({ planSessionId: "plan-session-1", projectRoot: "/repo" });
    assert.equal(recovered.terminal.runId, run.runId);
    assert.equal(recovered.terminal.kind, "failed");
    assert.equal(recovered.terminal.error, "Plan generation was interrupted. Retry to continue.");
    assert.equal(recovered.snapshot.version, 0);
    await runtime.close();
  } finally {
    await rm(stateRoot, { recursive: true, force: true });
  }
});

test("Plan failed terminal persistence failure emits no terminal and preserves the prior snapshot", async () => {
  const injection = terminalReplacementFailureFs();
  const { createPlanRuntime } = await loadPlanRuntime({ "node:fs/promises": injection.fs });
  const stateRoot = await mkdtemp(join(tmpdir(), "skyturn-plan-runtime-"));
  const client = new FakeAcpClient({ promptError: new Error("Hermes ACP prompt failed.") });
  const events = [];
  try {
    const runtime = createPlanRuntime(runtimeOptions(stateRoot, client, events));
    const run = await runtime.generate(generateRequest());
    await waitFor(() => events.some((event) => event.kind === "conversation_ready"));
    await waitForBounded(injection.failureObserved, "Terminal replacement failure deadline exceeded.");
    assert.equal(events.some((event) => event.kind === "completed" || event.kind === "failed"), false);
    injection.recover();
    const recovered = await runtime.getState({ planSessionId: "plan-session-1", projectRoot: "/repo" });
    assert.equal(recovered.terminal.runId, run.runId);
    assert.equal(recovered.terminal.error, "Plan generation was interrupted. Retry to continue.");
    assert.equal(recovered.snapshot.plan.requirements, "");
    await runtime.close();
  } finally {
    await rm(stateRoot, { recursive: true, force: true });
  }
});

test("Plan cancel reaps the prompt and settles when failed terminal persistence is unavailable", async () => {
  const injection = terminalReplacementFailureFs();
  const { createPlanRuntime } = await loadPlanRuntime({ "node:fs/promises": injection.fs });
  const stateRoot = await mkdtemp(join(tmpdir(), "skyturn-plan-runtime-"));
  const client = new FakeAcpClient({ deferred: true });
  const events = [];
  try {
    const runtime = createPlanRuntime({
      ...runtimeOptions(stateRoot, client, events),
      cancelSettlementGraceMs: 20,
    });
    const run = await runtime.generate(generateRequest());
    await waitFor(() => client.promptCalls.length === 1);

    await assert.rejects(runtime.cancel({
      planSessionId: "plan-session-1",
      projectRoot: "/repo",
      runId: run.runId,
    }), /Plan state persistence is unavailable\./);

    assert.equal(client.cancelCalls, 1);
    assert.equal(client.closeCalls, 1);
    assert.equal(client.closed, true);
    assert.equal(events.some((event) => event.kind === "completed" || event.kind === "failed"), false);
    injection.recover();
    const recovered = await runtime.getState({ planSessionId: "plan-session-1", projectRoot: "/repo" });
    assert.equal(recovered.terminal.runId, run.runId);
    assert.equal(recovered.terminal.error, "Plan generation was interrupted. Retry to continue.");
    await runtime.close();
  } finally {
    await rm(stateRoot, { recursive: true, force: true });
  }
});

test("Plan runtime rejects oversized terminal and mapping files before reading them", async () => {
  const realFs = require("node:fs/promises");
  let readCalls = 0;
  const fsWithReadProbe = {
    ...realFs,
    lstat: async (...args) => {
      const fileInfo = await realFs.lstat(...args);
      return fileInfo.isFile()
        ? {
            isDirectory: () => false,
            isFile: () => true,
            isSymbolicLink: () => fileInfo.isSymbolicLink(),
            mode: fileInfo.mode,
            size: 1_000_000_000,
          }
        : fileInfo;
    },
    readFile: async (...args) => {
      readCalls += 1;
      return realFs.readFile(...args);
    },
  };
  const { createPlanRuntime, planMappingFileName, planTerminalFileName } = await loadPlanRuntime({
    "node:fs/promises": fsWithReadProbe,
  });
  const terminalRoot = await mkdtemp(join(tmpdir(), "skyturn-plan-runtime-"));
  const mappingRoot = await mkdtemp(join(tmpdir(), "skyturn-plan-runtime-"));
  try {
    await writeFile(
      join(terminalRoot, planTerminalFileName("plan-session-1")),
      "oversized-by-lstat",
      { mode: 0o600 },
    );
    const terminalRuntime = createPlanRuntime(runtimeOptions(terminalRoot, new FakeAcpClient(), []));
    await assert.rejects(
      terminalRuntime.getState({ planSessionId: "plan-session-1", projectRoot: "/repo" }),
      /Plan state is invalid\./,
    );
    assert.equal(readCalls, 0);
    await terminalRuntime.close();

    await writeFile(
      join(mappingRoot, planMappingFileName("plan-session-1")),
      "oversized-by-lstat",
      { mode: 0o600 },
    );
    const mappingEvents = [];
    const mappingClient = new FakeAcpClient();
    const mappingRuntime = createPlanRuntime(runtimeOptions(mappingRoot, mappingClient, mappingEvents));
    await assert.rejects(mappingRuntime.generate(generateRequest()), /Plan conversation mapping is invalid\./);
    assert.deepEqual(mappingEvents, []);
    assert.equal(readCalls, 0);
    assert.equal(mappingClient.newSessionCalls, 0);
    await mappingRuntime.close();
  } finally {
    await rm(terminalRoot, { recursive: true, force: true });
    await rm(mappingRoot, { recursive: true, force: true });
  }
});

test("Plan project identity rejects a symlink retarget before runtime use", { skip: process.platform === "win32" }, async () => {
  const identityModule = await loadTypeScriptModule("planProjectIdentity.ts").catch(() => null);
  assert.equal(typeof identityModule?.createPlanProjectIdentityRegistry, "function");
  const root = await mkdtemp(join(tmpdir(), "skyturn-plan-identity-"));
  const first = join(root, "first");
  const second = join(root, "second");
  const link = join(root, "project");
  try {
    await mkdir(first);
    await mkdir(second);
    await symlink(first, link, "dir");
    const registry = identityModule.createPlanProjectIdentityRegistry();
    await registry.remember(link);

    assert.equal(await registry.canonicalize(link), await realpath(first));
    await unlink(link);
    await symlink(second, link, "dir");
    await assert.rejects(registry.canonicalize(link), /Project root is not open in SkyTurn\./);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("workspace restore rejects a persisted canonical identity after symlink retarget", { skip: process.platform === "win32" }, async () => {
  const identityModule = await loadTypeScriptModule("planProjectIdentity.ts");
  const root = await mkdtemp(join(tmpdir(), "skyturn-plan-restore-"));
  const first = join(root, "first");
  const second = join(root, "second");
  const link = join(root, "project");
  try {
    await mkdir(first);
    await mkdir(second);
    await symlink(first, link, "dir");
    const initialRegistry = identityModule.createPlanProjectIdentityRegistry();
    const persistedCanonicalRoot = await initialRegistry.remember(link);

    await unlink(link);
    await symlink(second, link, "dir");
    const restoredRegistry = identityModule.createPlanProjectIdentityRegistry();
    await assert.rejects(
      restoredRegistry.remember(link, persistedCanonicalRoot),
      /Project root is not open in SkyTurn\./,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("authoritative Plan state binding rejects another project without changing original bytes", async () => {
  const { createPlanRuntime } = await loadPlanRuntime();
  const stateRoot = await mkdtemp(join(tmpdir(), "skyturn-plan-authority-"));
  const firstEvents = [];
  try {
    const firstClient = new FakeAcpClient({ chunks: ["requirements-v0"] });
    const first = createPlanRuntime(runtimeOptions(stateRoot, firstClient, firstEvents));
    const run = await first.generate({ ...generateRequest(), expectedStateVersion: 0 });
    await terminalEvent(firstEvents, run.runId);
    await first.close();
    const before = await directoryBytes(stateRoot);

    const secondClient = new FakeAcpClient();
    const secondEvents = [];
    const second = createPlanRuntime(runtimeOptions(stateRoot, secondClient, secondEvents));
    await assert.rejects(second.generate({
      ...generateRequest(),
      projectRoot: "/different-repo",
      expectedStateVersion: 1,
    }), /project does not match/);
    assert.equal(secondClient.newSessionCalls, 0);
    assert.deepEqual(secondClient.loadSessionCalls, []);
    assert.deepEqual(secondClient.promptCalls, []);
    assert.deepEqual(secondEvents, []);
    assert.deepEqual(await directoryBytes(stateRoot), before);
    const recovered = await second.getState({ planSessionId: "plan-session-1", projectRoot: "/repo" });
    assert.equal(recovered.snapshot.version, 1);
    assert.equal(recovered.snapshot.plan.requirements, "requirements-v0");
    await second.close();
  } finally {
    await rm(stateRoot, { recursive: true, force: true });
  }
});

test("Plan state mutations enforce versions, gates, idempotent edits, and durable Undo", async () => {
  const { createPlanRuntime } = await loadPlanRuntime();
  const stateRoot = await mkdtemp(join(tmpdir(), "skyturn-plan-mutations-"));
  const client = new FakeAcpClient({ chunks: ["requirements-v1"] });
  const events = [];
  try {
    const runtime = createPlanRuntime(runtimeOptions(stateRoot, client, events));
    assert.equal(typeof runtime.updateStage, "function");
    assert.equal(typeof runtime.acceptStage, "function");
    assert.equal(typeof runtime.undoStage, "function");
    if (!runtime.updateStage || !runtime.acceptStage || !runtime.undoStage) return;

    const edit = await runtime.updateStage({
      planSessionId: "plan-session-1", projectRoot: "/repo", stage: "requirements",
      expectedStateVersion: 0, markdown: "requirements-v0",
    });
    assert.equal(edit.snapshot.version, 1);
    const same = await runtime.updateStage({
      planSessionId: "plan-session-1", projectRoot: "/repo", stage: "requirements",
      expectedStateVersion: 1, markdown: "requirements-v0",
    });
    assert.deepEqual(toPlain(same.snapshot), toPlain(edit.snapshot));
    await assert.rejects(runtime.updateStage({
      planSessionId: "plan-session-1", projectRoot: "/repo", stage: "requirements",
      expectedStateVersion: 0, markdown: "forged-stale-edit",
    }), /Plan state version conflict\./);
    await assert.rejects(runtime.acceptStage({
      planSessionId: "plan-session-1", projectRoot: "/repo", stage: "design", expectedStateVersion: 1,
    }), /Plan state transition is invalid\./);
    await assert.rejects(runtime.acceptStage({
      planSessionId: "plan-session-1", projectRoot: "/repo", stage: "tasks", expectedStateVersion: 1,
    }), /Plan state transition is invalid\./);
    assert.deepEqual(toPlain((await runtime.getState({
      planSessionId: "plan-session-1", projectRoot: "/repo",
    })).snapshot), toPlain(edit.snapshot));
    assert.equal(client.newSessionCalls, 0);

    const accepted = await runtime.acceptStage({
      planSessionId: "plan-session-1", projectRoot: "/repo", stage: "requirements", expectedStateVersion: 1,
    });
    assert.equal(accepted.snapshot.version, 2);
    assert.equal(accepted.snapshot.accepted.requirements, true);
    client.chunks = ["design-v0"];
    const designRun = await runtime.generate({
      operation: "generate", planSessionId: "plan-session-1", projectRoot: "/repo",
      stage: "design", goal: "Build staged Plan mode", expectedStateVersion: 2,
    });
    const designTerminal = await terminalEvent(events, designRun.runId);
    assert.equal(designTerminal.snapshot.plan.design, "design-v0");

    client.chunks = ["requirements-v1"];
    const firstRevision = await runtime.revise({
      operation: "revise", planSessionId: "plan-session-1", projectRoot: "/repo",
      stage: "requirements", goal: "Build staged Plan mode", expectedStateVersion: 3, instruction: "Create v1.",
    });
    await terminalEvent(events, firstRevision.runId);
    client.chunks = ["requirements-v2"];
    const secondRevision = await runtime.revise({
      operation: "revise", planSessionId: "plan-session-1", projectRoot: "/repo",
      stage: "requirements", goal: "Build staged Plan mode", expectedStateVersion: 4, instruction: "Create v2.",
    });
    await terminalEvent(events, secondRevision.runId);
    await runtime.close();

    const reopened = createPlanRuntime(runtimeOptions(stateRoot, new FakeAcpClient(), []));
    const v1 = await reopened.undoStage({
      planSessionId: "plan-session-1", projectRoot: "/repo", stage: "requirements", expectedStateVersion: 5,
    });
    assert.equal(v1.snapshot.plan.requirements, "requirements-v1");
    assert.deepEqual(toPlain(v1.snapshot.checkpoints.requirements), ["requirements-v0"]);
    const v0 = await reopened.undoStage({
      planSessionId: "plan-session-1", projectRoot: "/repo", stage: "requirements", expectedStateVersion: 6,
    });
    assert.equal(v0.snapshot.plan.requirements, "requirements-v0");
    assert.deepEqual(toPlain(v0.snapshot.checkpoints.requirements), []);
    await assert.rejects(reopened.undoStage({
      planSessionId: "plan-session-1", projectRoot: "/repo", stage: "requirements", expectedStateVersion: 7,
    }), /Plan state transition is invalid\./);
    await reopened.close();
  } finally {
    await rm(stateRoot, { recursive: true, force: true });
  }
});

test("accepted Plan stages reject generate before run creation in-process and after reopen", async () => {
  const { createPlanRuntime } = await loadPlanRuntime();
  const stateRoot = await mkdtemp(join(tmpdir(), "skyturn-plan-accepted-generate-"));
  const request = { planSessionId: "plan-session-1", projectRoot: "/repo" };
  const firstClient = new FakeAcpClient();
  const firstEvents = [];
  try {
    const first = createPlanRuntime(runtimeOptions(stateRoot, firstClient, firstEvents));
    const edited = await first.updateStage({
      ...request,
      stage: "requirements",
      expectedStateVersion: 0,
      markdown: "# Requirements\n\nAccepted.",
    });
    const accepted = await first.acceptStage({
      ...request,
      stage: "requirements",
      expectedStateVersion: edited.snapshot.version,
    });
    const before = await directoryBytes(stateRoot);

    await assert.rejects(first.generate({
      ...request,
      operation: "generate",
      stage: "requirements",
      goal: "Do not replace accepted requirements.",
      expectedStateVersion: accepted.snapshot.version,
    }), /^Error: Plan state transition is invalid\.$/);

    assert.deepEqual(firstEvents, []);
    assert.equal(firstClient.newSessionCalls, 0);
    assert.deepEqual(firstClient.loadSessionCalls, []);
    assert.deepEqual(firstClient.promptCalls, []);
    assert.equal(firstClient.cancelCalls, 0);
    assert.deepEqual(await directoryBytes(stateRoot), before);
    assert.deepEqual(toPlain(await first.getState(request)), {
      protocolVersion: 1,
      needsBootstrap: false,
      snapshot: toPlain(accepted.snapshot),
      active: null,
      terminal: null,
    });
    await first.close();

    const reopenedClient = new FakeAcpClient();
    const reopenedEvents = [];
    const reopened = createPlanRuntime(runtimeOptions(stateRoot, reopenedClient, reopenedEvents));
    const reopenedBefore = await directoryBytes(stateRoot);
    const recovered = await reopened.getState(request);
    assert.deepEqual(toPlain(recovered.snapshot), toPlain(accepted.snapshot));
    assert.equal(recovered.active, null);
    assert.equal(recovered.terminal, null);

    await assert.rejects(reopened.generate({
      ...request,
      operation: "generate",
      stage: "requirements",
      goal: "Still do not replace accepted requirements.",
      expectedStateVersion: accepted.snapshot.version,
    }), /^Error: Plan state transition is invalid\.$/);
    assert.deepEqual(toPlain(await reopened.cancel({ ...request, runId: "unreachable-run" })), {
      protocolVersion: 1,
      cancelled: false,
    });

    assert.deepEqual(reopenedEvents, []);
    assert.equal(reopenedClient.newSessionCalls, 0);
    assert.deepEqual(reopenedClient.loadSessionCalls, []);
    assert.deepEqual(reopenedClient.promptCalls, []);
    assert.equal(reopenedClient.cancelCalls, 0);
    assert.deepEqual(await directoryBytes(stateRoot), reopenedBefore);
    assert.deepEqual(toPlain((await reopened.getState(request)).snapshot), toPlain(accepted.snapshot));
    await reopened.close();
  } finally {
    await rm(stateRoot, { recursive: true, force: true });
  }
});

test("Plan updateStage rejects impossible downstream edits before changing durable bytes", async () => {
  const { createPlanRuntime } = await loadPlanRuntime();
  const stateRoot = await mkdtemp(join(tmpdir(), "skyturn-plan-downstream-gates-"));
  try {
    const runtime = createPlanRuntime(runtimeOptions(stateRoot, new FakeAcpClient(), []));
    for (const stage of ["design", "tasks"]) {
      await assert.rejects(runtime.updateStage({
        planSessionId: "plan-session-1",
        projectRoot: "/repo",
        stage,
        expectedStateVersion: 0,
        markdown: `${stage}-without-upstream`,
      }), /^Error: Plan state transition is invalid\.$/);
      assert.deepEqual(await directoryBytes(stateRoot), {});
    }
    assert.equal((await runtime.getState({
      planSessionId: "plan-session-1",
      projectRoot: "/repo",
    })).snapshot.version, 0);
    await runtime.close();
  } finally {
    await rm(stateRoot, { recursive: true, force: true });
  }
});

test("every Plan state write strictly rejects an oversized final snapshot without changing prior bytes", async () => {
  const { createPlanRuntime } = await loadPlanRuntime();
  const stateRoot = await mkdtemp(join(tmpdir(), "skyturn-plan-strict-write-"));
  try {
    const runtime = createPlanRuntime(runtimeOptions(stateRoot, new FakeAcpClient(), []));
    await runtime.updateStage({
      planSessionId: "plan-session-1", projectRoot: "/repo", stage: "requirements",
      expectedStateVersion: 0, markdown: "requirements-v0",
    });
    const before = await directoryBytes(stateRoot);
    await assert.rejects(runtime.updateStage({
      planSessionId: "plan-session-1", projectRoot: "/repo", stage: "requirements",
      expectedStateVersion: 1, markdown: "x".repeat(2_000_001),
    }), /^Error: Plan state persistence is unavailable\.$/);
    assert.deepEqual(await directoryBytes(stateRoot), before);
    assert.equal((await runtime.getState({
      planSessionId: "plan-session-1", projectRoot: "/repo",
    })).snapshot.version, 1);
    await runtime.close();
  } finally {
    await rm(stateRoot, { recursive: true, force: true });
  }
});

test("clearing a current stage preserves its valid checkpoint for durable Undo", async () => {
  const { createPlanRuntime } = await loadPlanRuntime();
  const stateRoot = await mkdtemp(join(tmpdir(), "skyturn-plan-clear-undo-"));
  const client = new FakeAcpClient({ chunks: ["requirements-v0"] });
  const events = [];
  try {
    const runtime = createPlanRuntime(runtimeOptions(stateRoot, client, events));
    await terminalEvent(events, (await runtime.generate(generateRequest())).runId);
    client.chunks = ["requirements-v1"];
    await terminalEvent(events, (await runtime.revise({
      ...generateRequest(), operation: "revise", expectedStateVersion: 1, instruction: "Create v1.",
    })).runId);
    const cleared = await runtime.updateStage({
      planSessionId: "plan-session-1", projectRoot: "/repo", stage: "requirements",
      expectedStateVersion: 2, markdown: "",
    });
    assert.deepEqual(toPlain(cleared.snapshot.checkpoints.requirements), ["requirements-v0"]);
    const undone = await runtime.undoStage({
      planSessionId: "plan-session-1", projectRoot: "/repo", stage: "requirements",
      expectedStateVersion: 3,
    });
    assert.equal(undone.snapshot.plan.requirements, "requirements-v0");
    assert.deepEqual(toPlain(undone.snapshot.checkpoints.requirements), []);
    await runtime.close();
  } finally {
    await rm(stateRoot, { recursive: true, force: true });
  }
});

test("Plan state commit fsync failure restores the exact prior durable bytes", async () => {
  const { createPlanRuntime } = await loadPlanRuntime();
  const stateRoot = await mkdtemp(join(tmpdir(), "skyturn-plan-restore-success-"));
  try {
    const initial = createPlanRuntime(runtimeOptions(stateRoot, new FakeAcpClient(), []));
    await initial.updateStage({
      planSessionId: "plan-session-1", projectRoot: "/repo", stage: "requirements",
      expectedStateVersion: 0, markdown: "requirements-v0",
    });
    await initial.close();
    const before = await directoryBytes(stateRoot);
    let syncCalls = 0;
    const runtime = createPlanRuntime({
      ...runtimeOptions(stateRoot, new FakeAcpClient(), []),
      syncDirectory: async () => {
        syncCalls += 1;
        if (syncCalls === 1) throw new Error("/private/commit-fsync-secret");
      },
    });
    await assert.rejects(runtime.updateStage({
      planSessionId: "plan-session-1", projectRoot: "/repo", stage: "requirements",
      expectedStateVersion: 1, markdown: "requirements-v1",
    }), /^Error: Plan state persistence is unavailable\.$/);
    assert.equal(syncCalls, 2);
    assert.deepEqual(await directoryBytes(stateRoot), before);
    assert.equal((await runtime.getState({
      planSessionId: "plan-session-1", projectRoot: "/repo",
    })).snapshot.plan.requirements, "requirements-v0");
    await runtime.close();
  } finally {
    await rm(stateRoot, { recursive: true, force: true });
  }
});

test("unproven Plan state rollback poisons only that runtime with one restart-required error", async () => {
  const { createPlanRuntime } = await loadPlanRuntime();
  const stateRoot = await mkdtemp(join(tmpdir(), "skyturn-plan-restore-failure-"));
  const poisonError = "Plan session state is indeterminate. Restart SkyTurn.";
  const client = new FakeAcpClient();
  const events = [];
  try {
    const initial = createPlanRuntime(runtimeOptions(stateRoot, new FakeAcpClient(), []));
    await initial.updateStage({
      planSessionId: "plan-session-1", projectRoot: "/repo", stage: "requirements",
      expectedStateVersion: 0, markdown: "requirements-v0",
    });
    await initial.close();
    let syncCalls = 0;
    const runtime = createPlanRuntime({
      ...runtimeOptions(stateRoot, client, events),
      syncDirectory: async () => {
        syncCalls += 1;
        throw new Error(`/private/fsync-secret-${syncCalls}`);
      },
    });
    await assert.rejects(runtime.updateStage({
      planSessionId: "plan-session-1", projectRoot: "/repo", stage: "requirements",
      expectedStateVersion: 1, markdown: "requirements-v1",
    }), new Error(poisonError));
    const operations = [
      () => runtime.generate({ ...generateRequest(), expectedStateVersion: 1 }),
      () => runtime.revise({
        ...generateRequest(), operation: "revise", expectedStateVersion: 1, instruction: "Revise.",
      }),
      () => runtime.updateStage({
        planSessionId: "plan-session-1", projectRoot: "/repo", stage: "requirements",
        expectedStateVersion: 1, markdown: "requirements-v2",
      }),
      () => runtime.acceptStage({
        planSessionId: "plan-session-1", projectRoot: "/repo", stage: "requirements", expectedStateVersion: 1,
      }),
      () => runtime.undoStage({
        planSessionId: "plan-session-1", projectRoot: "/repo", stage: "requirements", expectedStateVersion: 1,
      }),
      () => runtime.getState({ planSessionId: "plan-session-1", projectRoot: "/repo" }),
      () => runtime.cancel({ planSessionId: "plan-session-1", projectRoot: "/repo", runId: "run-missing" }),
    ];
    for (const operation of operations) await assert.rejects(operation(), new Error(poisonError));
    assert.equal(client.newSessionCalls, 0);
    assert.deepEqual(events, []);
    assert.equal(JSON.stringify(events).includes("/private/"), false);
    await runtime.close();

    const restarted = createPlanRuntime(runtimeOptions(stateRoot, new FakeAcpClient(), []));
    await assert.doesNotReject(restarted.getState({ planSessionId: "plan-session-1", projectRoot: "/repo" }));
    await restarted.close();
  } finally {
    await rm(stateRoot, { recursive: true, force: true });
  }
});

test("Plan state and mapping replacements set final permissions before rename", { skip: process.platform === "win32" }, async () => {
  const fsPromises = require("node:fs/promises");
  const chmodBeforeRename = new Set();
  const linkedInitialStates = [];
  const finalPathChmods = [];
  const instrumentedFs = {
    ...fsPromises,
    open: async (...args) => {
      const handle = await fsPromises.open(...args);
      const openedPath = String(args[0]);
      return new Proxy(handle, {
        get(target, property) {
          if (property === "chmod") return async (mode) => {
            assert.equal(mode, 0o600);
            chmodBeforeRename.add(openedPath);
            return target.chmod(mode);
          };
          const value = Reflect.get(target, property, target);
          return typeof value === "function" ? value.bind(target) : value;
        },
      });
    },
    chmod: async (target, mode) => {
      if (String(target).endsWith(".json")) finalPathChmods.push({ target: String(target), mode });
      return fsPromises.chmod(target, mode);
    },
    link: async (source, target) => {
      assert.equal(chmodBeforeRename.has(String(source)), true, `missing pre-link chmod for ${source}`);
      linkedInitialStates.push({ source: String(source), target: String(target) });
      return fsPromises.link(source, target);
    },
    rename: async (source, target) => {
      assert.equal(chmodBeforeRename.has(String(source)), true, `missing pre-rename chmod for ${source}`);
      return fsPromises.rename(source, target);
    },
  };
  const { createPlanRuntime } = await loadPlanRuntime({ "node:fs/promises": instrumentedFs });
  const stateRoot = await mkdtemp(join(tmpdir(), "skyturn-plan-permissions-"));
  const events = [];
  try {
    const runtime = createPlanRuntime(runtimeOptions(stateRoot, new FakeAcpClient(), events));
    await runtime.bootstrap({ planSessionId: "plan-session-1", projectRoot: "/repo" }, {
      version: 0,
      plan: { requirements: "", design: "", tasks: "" },
      accepted: { requirements: false, design: false, tasks: false },
      checkpoints: { requirements: [], design: [], tasks: [] },
    });
    await terminalEvent(events, (await runtime.generate(generateRequest())).runId);
    assert.equal(chmodBeforeRename.size >= 2, true);
    assert.equal(linkedInitialStates.length, 1);
    assert.equal(linkedInitialStates[0].target.endsWith(".json"), true);
    assert.deepEqual(finalPathChmods, []);
    await runtime.close();
  } finally {
    await rm(stateRoot, { recursive: true, force: true });
  }
});

test("manual Plan state can establish its first conversation and persists the durable flag", async () => {
  const { createPlanRuntime, planTerminalFileName } = await loadPlanRuntime();
  const stateRoot = await mkdtemp(join(tmpdir(), "skyturn-plan-first-conversation-"));
  const client = new FakeAcpClient({ chunks: ["requirements-v1"] });
  const events = [];
  try {
    const runtime = createPlanRuntime(runtimeOptions(stateRoot, client, events));
    await runtime.updateStage({
      planSessionId: "plan-session-1", projectRoot: "/repo", stage: "requirements",
      expectedStateVersion: 0, markdown: "requirements-v0",
    });
    const before = JSON.parse(await readFile(join(stateRoot, planTerminalFileName("plan-session-1")), "utf8"));
    assert.equal(before.conversationEstablished, false);
    const run = await runtime.revise({
      ...generateRequest(), operation: "revise", expectedStateVersion: 1, instruction: "Create v1.",
    });
    await terminalEvent(events, run.runId);
    assert.equal(client.newSessionCalls, 1);
    const after = JSON.parse(await readFile(join(stateRoot, planTerminalFileName("plan-session-1")), "utf8"));
    assert.equal(after.conversationEstablished, true);
    await runtime.close();
  } finally {
    await rm(stateRoot, { recursive: true, force: true });
  }
});

test("established Plan state fails closed when its conversation mapping is deleted", async () => {
  const { createPlanRuntime } = await loadPlanRuntime();
  const stateRoot = await mkdtemp(join(tmpdir(), "skyturn-plan-mapping-loss-"));
  const client = new FakeAcpClient({ chunks: ["requirements-v0"] });
  const events = [];
  try {
    const runtime = createPlanRuntime(runtimeOptions(stateRoot, client, events));
    await terminalEvent(events, (await runtime.generate(generateRequest())).runId);
    const files = await readdir(stateRoot);
    const mappingFile = (await Promise.all(files.map(async (name) => ({
      name,
      text: await readFile(join(stateRoot, name), "utf8"),
    })))).find((entry) => entry.text.includes("acpSessionId"));
    assert.ok(mappingFile);
    await unlink(join(stateRoot, mappingFile.name));
    const before = await directoryBytes(stateRoot);
    const eventCount = events.length;
    const newSessionCalls = client.newSessionCalls;
    const operations = [
      () => runtime.getState({ planSessionId: "plan-session-1", projectRoot: "/repo" }),
      () => runtime.generate({ ...generateRequest(), expectedStateVersion: 1 }),
      () => runtime.updateStage({
        planSessionId: "plan-session-1", projectRoot: "/repo", stage: "requirements",
        expectedStateVersion: 1, markdown: "requirements-v1",
      }),
    ];
    for (const operation of operations) {
      await assert.rejects(operation(), /^Error: Plan conversation mapping is missing\.$/);
      assert.deepEqual(await directoryBytes(stateRoot), before);
    }
    assert.equal(client.newSessionCalls, newSessionCalls);
    assert.equal(events.length, eventCount);
    await runtime.close();
  } finally {
    await rm(stateRoot, { recursive: true, force: true });
  }
});

test("an existing mapping upgrades a false conversation flag exactly once without ACP", async () => {
  const { createPlanRuntime, planMappingFileName, planTerminalFileName } = await loadPlanRuntime();
  const stateRoot = await mkdtemp(join(tmpdir(), "skyturn-plan-mapping-upgrade-"));
  const client = new FakeAcpClient();
  try {
    const initial = createPlanRuntime(runtimeOptions(stateRoot, client, []));
    await initial.updateStage({
      planSessionId: "plan-session-1", projectRoot: "/repo", stage: "requirements",
      expectedStateVersion: 0, markdown: "requirements-v0",
    });
    await initial.close();
    await writeFile(join(stateRoot, planMappingFileName("plan-session-1")), JSON.stringify({
      version: 1,
      planKey: createHash("sha256").update("skyturn-plan-session\0").update("plan-session-1").digest("hex"),
      projectKey: createHash("sha256").update("skyturn-plan-project\0").update("/repo").digest("hex"),
      acpSessionId: client.sessionId,
    }), { mode: 0o600 });

    const runtime = createPlanRuntime(runtimeOptions(stateRoot, client, []));
    const state = await runtime.getState({ planSessionId: "plan-session-1", projectRoot: "/repo" });
    assert.equal(JSON.stringify(state).includes(client.sessionId), false);
    const firstBytes = await directoryBytes(stateRoot);
    const persisted = JSON.parse(await readFile(join(stateRoot, planTerminalFileName("plan-session-1")), "utf8"));
    assert.equal(persisted.conversationEstablished, true);
    await runtime.getState({ planSessionId: "plan-session-1", projectRoot: "/repo" });
    assert.deepEqual(await directoryBytes(stateRoot), firstBytes);
    assert.equal(client.newSessionCalls, 0);
    assert.deepEqual(client.loadSessionCalls, []);
    await runtime.close();
  } finally {
    await rm(stateRoot, { recursive: true, force: true });
  }
});

test("mapping deletion during active startup never creates a replacement conversation", async () => {
  const { createPlanRuntime } = await loadPlanRuntime();
  const stateRoot = await mkdtemp(join(tmpdir(), "skyturn-plan-mapping-race-"));
  const initialEvents = [];
  try {
    const initial = createPlanRuntime(runtimeOptions(
      stateRoot,
      new FakeAcpClient({ chunks: ["requirements-v0"] }),
      initialEvents,
    ));
    await terminalEvent(initialEvents, (await initial.generate(generateRequest())).runId);
    await initial.close();

    const client = new FakeAcpClient();
    const events = [];
    let releaseClient;
    const clientPending = new Promise((resolve) => { releaseClient = resolve; });
    const runtime = createPlanRuntime({
      ...runtimeOptions(stateRoot, client, events),
      createClient: async () => clientPending,
    });
    const run = await runtime.generate({ ...generateRequest(), expectedStateVersion: 1 });
    const files = await readdir(stateRoot);
    const mappingFile = (await Promise.all(files.map(async (name) => ({
      name,
      text: await readFile(join(stateRoot, name), "utf8"),
    })))).find((entry) => entry.text.includes("acpSessionId"));
    assert.ok(mappingFile);
    await unlink(join(stateRoot, mappingFile.name));
    releaseClient(client);
    const failed = await terminalEvent(events, run.runId);
    assert.equal(failed.kind, "failed");
    assert.equal(failed.error, "Plan conversation mapping is missing.");
    assert.equal(client.newSessionCalls, 0);
    assert.deepEqual(client.loadSessionCalls, []);
    assert.deepEqual(client.promptCalls, []);
    await runtime.close();
  } finally {
    await rm(stateRoot, { recursive: true, force: true });
  }
});

test("Plan revision derives its current Markdown only from durable state", async () => {
  const { createPlanRuntime } = await loadPlanRuntime();
  const stateRoot = await mkdtemp(join(tmpdir(), "skyturn-plan-durable-revision-"));
  const client = new FakeAcpClient({ chunks: ["requirements-v1"] });
  const events = [];
  const prompts = [];
  try {
    const runtime = createPlanRuntime({
      ...runtimeOptions(stateRoot, client, events),
      buildPrompt: async (input) => {
        prompts.push(toPlain(input));
        return "bounded prompt";
      },
    });
    assert.equal(typeof runtime.updateStage, "function");
    if (!runtime.updateStage) return;
    await runtime.updateStage({
      planSessionId: "plan-session-1", projectRoot: "/repo", stage: "requirements",
      expectedStateVersion: 0, markdown: "durable-requirements-v0",
    });
    const run = await runtime.revise({
      operation: "revise", planSessionId: "plan-session-1", projectRoot: "/repo",
      stage: "requirements", goal: "Build staged Plan mode", expectedStateVersion: 1,
      instruction: "Revise it.", currentMarkdown: "forged-renderer-markdown",
      requirements: "forged-renderer-requirements", design: "forged-renderer-design", conversationStarted: true,
    });
    const terminal = await terminalEvent(events, run.runId);
    assert.equal(prompts[0].currentMarkdown, "durable-requirements-v0");
    assert.equal(prompts[0].requirements, "durable-requirements-v0");
    assert.equal(JSON.stringify(prompts[0]).includes("forged-renderer"), false);
    assert.deepEqual(toPlain(terminal.snapshot.checkpoints.requirements), ["durable-requirements-v0"]);
    await runtime.close();
  } finally {
    await rm(stateRoot, { recursive: true, force: true });
  }
});

test("a first-operation revision in a new ACP conversation receives only complete stage context", async () => {
  const { buildPlanPrompt } = await import("@skyturn/planner");
  const { createPlanRuntime } = await loadPlanRuntime();
  const stateRoot = await mkdtemp(join(tmpdir(), "skyturn-plan-first-revision-context-"));
  const cases = [
    {
      stage: "requirements",
      snapshot: {
        version: 0,
        plan: {
          requirements: "# Requirements\n\nCurrent requirements.",
          design: "# Design\n\nDownstream design must stay out.",
          tasks: "# Tasks\n\nDownstream tasks must stay out.",
        },
        accepted: { requirements: false, design: false, tasks: false },
        checkpoints: { requirements: [], design: [], tasks: [] },
      },
      includes: [],
      excludes: ["Downstream design must stay out.", "Downstream tasks must stay out."],
    },
    {
      stage: "design",
      snapshot: {
        version: 0,
        plan: {
          requirements: "# Requirements\n\nAccepted requirements.",
          design: "# Design\n\nCurrent design.",
          tasks: "# Tasks\n\nDownstream tasks must stay out.",
        },
        accepted: { requirements: true, design: false, tasks: false },
        checkpoints: { requirements: [], design: [], tasks: [] },
      },
      includes: ["Accepted requirements."],
      excludes: ["Downstream tasks must stay out."],
    },
    {
      stage: "tasks",
      snapshot: {
        version: 0,
        plan: {
          requirements: "# Requirements\n\nAccepted requirements.",
          design: "# Design\n\nAccepted design.",
          tasks: "# Tasks\n\nCurrent tasks.",
        },
        accepted: { requirements: true, design: true, tasks: false },
        checkpoints: { requirements: [], design: [], tasks: [] },
      },
      includes: ["Accepted requirements.", "Accepted design."],
      excludes: [],
    },
  ];
  try {
    for (const [index, item] of cases.entries()) {
      const planSessionId = `plan-first-revise-${item.stage}`;
      const client = new FakeAcpClient({ chunks: [`# ${item.stage}`] });
      const events = [];
      const runtime = createPlanRuntime({
        ...runtimeOptions(stateRoot, client, events),
        buildPrompt: async (input) => buildPlanPrompt(input),
      });
      await runtime.bootstrap({ planSessionId, projectRoot: "/repo" }, item.snapshot);
      const started = await runtime.revise({
        operation: "revise",
        planSessionId,
        projectRoot: "/repo",
        stage: item.stage,
        goal: "Goal only for this Plan.",
        expectedStateVersion: 0,
        instruction: `Revision instruction ${index}.`,
      });
      await terminalEvent(events, started.runId);

      assert.equal(client.newSessionCalls, 1);
      assert.equal(client.loadSessionCalls.length, 0);
      const prompt = client.promptCalls[0].prompt;
      assert.match(prompt, /Goal:\nGoal only for this Plan\./);
      assert.match(prompt, /Project context:\nProject root: \/repo/);
      assert.ok(prompt.includes(item.snapshot.plan[item.stage]));
      assert.ok(prompt.includes(`Revision instruction ${index}.`));
      assert.match(prompt, /full replacement Markdown document for that stage only/);
      for (const included of item.includes) assert.ok(prompt.includes(included));
      for (const excluded of item.excludes) assert.equal(prompt.includes(excluded), false);
      await runtime.close();
    }
  } finally {
    await rm(stateRoot, { recursive: true, force: true });
  }
});

test("orphaned active Plan state preserves the exact snapshot and recovers once without relaunch", async () => {
  const { createPlanRuntime } = await loadPlanRuntime();
  const stateRoot = await mkdtemp(join(tmpdir(), "skyturn-plan-orphan-"));
  const firstClient = new FakeAcpClient({ chunks: ["requirements-v1"] });
  const firstEvents = [];
  try {
    const first = createPlanRuntime(runtimeOptions(stateRoot, firstClient, firstEvents));
    assert.equal(typeof first.updateStage, "function");
    if (!first.updateStage) return;
    await first.updateStage({
      planSessionId: "plan-session-1", projectRoot: "/repo", stage: "requirements",
      expectedStateVersion: 0, markdown: "requirements-v0",
    });
    await terminalEvent(firstEvents, (await first.revise({
      operation: "revise", planSessionId: "plan-session-1", projectRoot: "/repo",
      stage: "requirements", goal: "Goal", expectedStateVersion: 1, instruction: "v1",
    })).runId);
    firstClient.chunks = ["requirements-v2"];
    await terminalEvent(firstEvents, (await first.revise({
      operation: "revise", planSessionId: "plan-session-1", projectRoot: "/repo",
      stage: "requirements", goal: "Goal", expectedStateVersion: 2, instruction: "v2",
    })).runId);
    firstClient.deferred = true;
    firstClient.chunks = ["requirements-v3"];
    await first.revise({
      operation: "revise", planSessionId: "plan-session-1", projectRoot: "/repo",
      stage: "requirements", goal: "Goal", expectedStateVersion: 3, instruction: "v3",
    });
    await waitFor(() => firstClient.promptCalls.length === 3);

    const recoveryClient = new FakeAcpClient();
    const recoveredRuntime = createPlanRuntime(runtimeOptions(stateRoot, recoveryClient, []));
    const recovered = await recoveredRuntime.getState({ planSessionId: "plan-session-1", projectRoot: "/repo" });
    assert.equal(recovered.active, null);
    assert.equal(recovered.terminal.kind, "failed");
    assert.equal(recovered.terminal.error, "Plan generation was interrupted. Retry to continue.");
    assert.equal(recovered.snapshot.plan.requirements, "requirements-v2");
    assert.deepEqual(toPlain(recovered.snapshot.checkpoints.requirements), ["requirements-v0", "requirements-v1"]);
    assert.equal(recoveryClient.newSessionCalls, 0);
    assert.deepEqual(recoveryClient.loadSessionCalls, []);
    assert.deepEqual(recoveryClient.promptCalls, []);
    const afterFirstRecovery = await directoryBytes(stateRoot);
    const repeated = await recoveredRuntime.getState({ planSessionId: "plan-session-1", projectRoot: "/repo" });
    assert.deepEqual(toPlain(repeated), toPlain(recovered));
    assert.deepEqual(await directoryBytes(stateRoot), afterFirstRecovery);
    await recoveredRuntime.close();
  } finally {
    await rm(stateRoot, { recursive: true, force: true });
  }
});

test("terminal replacement failure emits no phantom terminal and later recovers the active marker", async () => {
  const fsPromises = require("node:fs/promises");
  let failTerminalReplacement = true;
  let resolveTerminalReplacementFailure;
  const terminalReplacementFailure = new Promise((resolve) => {
    resolveTerminalReplacementFailure = resolve;
  });
  const instrumentedFs = {
    ...fsPromises,
    rename: async (source, target) => {
      if (failTerminalReplacement && String(source).includes(".state.tmp")) {
        const value = JSON.parse(await fsPromises.readFile(source, "utf8"));
        if (value.active === null && value.terminal !== null) {
          resolveTerminalReplacementFailure();
          throw new Error("injected rename failure");
        }
      }
      return fsPromises.rename(source, target);
    },
  };
  const { createPlanRuntime } = await loadPlanRuntime({ "node:fs/promises": instrumentedFs });
  const stateRoot = await mkdtemp(join(tmpdir(), "skyturn-plan-terminal-failure-"));
  const events = [];
  try {
    const runtime = createPlanRuntime(runtimeOptions(stateRoot, new FakeAcpClient(), events));
    const run = await runtime.generate({ ...generateRequest(), expectedStateVersion: 0 });
    await waitFor(() => events.some((event) => event.kind === "conversation_ready"));
    await waitForBounded(terminalReplacementFailure, "Terminal replacement failure deadline exceeded.");
    assert.equal(events.some((event) => event.kind === "completed" || event.kind === "failed"), false);

    failTerminalReplacement = false;
    const recovered = await runtime.getState({ planSessionId: "plan-session-1", projectRoot: "/repo" });
    assert.equal(recovered.active, null);
    assert.equal(recovered.terminal.runId, run.runId);
    assert.equal(recovered.terminal.kind, "failed");
    assert.equal(recovered.terminal.error, "Plan generation was interrupted. Retry to continue.");
    assert.equal(recovered.snapshot.version, 0);
    assert.equal(recovered.snapshot.plan.requirements, "");
    await runtime.close();
  } finally {
    await rm(stateRoot, { recursive: true, force: true });
  }
});

async function directoryBytes(directory) {
  const names = (await readdir(directory)).sort();
  return Object.fromEntries(await Promise.all(
    names.map(async (name) => [name, await readFile(join(directory, name), "utf8")]),
  ));
}

function terminalReplacementFailureFs() {
  const fsPromises = require("node:fs/promises");
  let failing = true;
  let resolveFailureObserved;
  const failureObserved = new Promise((resolve) => {
    resolveFailureObserved = resolve;
  });
  return {
    failureObserved,
    fs: {
      ...fsPromises,
      rename: async (source, target) => {
        if (failing && String(source).includes(".state.tmp")) {
          const value = JSON.parse(await fsPromises.readFile(source, "utf8"));
          if (value.active === null && value.terminal !== null) {
            resolveFailureObserved();
            throw new Error("injected rename failure");
          }
        }
        return fsPromises.rename(source, target);
      },
    },
    recover() {
      failing = false;
    },
  };
}

async function waitForBounded(promise, message) {
  let deadline;
  try {
    await Promise.race([
      promise,
      new Promise((_, reject) => {
        deadline = setTimeout(() => reject(new Error(message)), 2_000);
      }),
    ]);
  } finally {
    clearTimeout(deadline);
  }
}

function generateRequest() {
  return {
    operation: "generate",
    planSessionId: "plan-session-1",
    projectRoot: "/repo",
    stage: "requirements",
    goal: "Build staged Plan mode",
    expectedStateVersion: 0,
  };
}

function reviseRequirementsRequest(_currentMarkdown, instruction, expectedStateVersion = 1) {
  return {
    ...generateRequest(),
    operation: "revise",
    expectedStateVersion,
    instruction,
  };
}

async function buildRequirementHistory(runtime, client, events) {
  await terminalEvent(events, (await runtime.generate(generateRequest())).runId);
  client.chunks = ["requirements-v1"];
  await terminalEvent(events, (await runtime.revise(
    reviseRequirementsRequest("requirements-v0", "Create v1."),
  )).runId);
  client.chunks = ["requirements-v2"];
  await terminalEvent(events, (await runtime.revise(
    reviseRequirementsRequest("requirements-v1", "Create v2.", 2),
  )).runId);
}

function legacyPlanTerminal() {
  return {
    version: 1,
    planKey: createHash("sha256").update("skyturn-plan-session\0").update("plan-session-1").digest("hex"),
    projectKey: createHash("sha256").update("skyturn-plan-project\0").update("/repo").digest("hex"),
    runId: "legacy-run",
    stage: "requirements",
    operation: "generate",
    kind: "completed",
    markdown: "# Legacy Requirements",
  };
}

function runtimeOptions(stateRoot, client, events) {
  return {
    stateRoot,
    createClient: async () => client.replacement ?? client,
    buildPrompt: async (request) => `prompt:${request.stage}:${request.operation}`,
    emit: (event) => events.push(event),
    randomUUID: () => `run-${events.filter((event) => event.kind === "started").length + 1}`,
    promptTimeoutMs: 2_000,
    cancelSettlementGraceMs: 20,
  };
}

function terminalEvent(events, runId) {
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      clearInterval(interval);
      reject(new Error("Plan terminal event deadline exceeded."));
    }, 2_000);
    const interval = setInterval(() => {
      const event = events.find((candidate) =>
        (candidate.kind === "completed" || candidate.kind === "failed") &&
        (!runId || candidate.runId === runId));
      if (!event) return;
      clearTimeout(timeout);
      clearInterval(interval);
      resolve(event);
    }, 1);
  });
}

function waitFor(predicate) {
  return new Promise((resolve) => {
    const interval = setInterval(() => {
      if (!predicate()) return;
      clearInterval(interval);
      resolve();
    }, 1);
  });
}

async function waitForTerminalState(runtime) {
  const deadline = Date.now() + 2_000;
  while (Date.now() < deadline) {
    const state = await runtime.getState({ planSessionId: "plan-session-1", projectRoot: "/repo" });
    if (state.terminal) return state.terminal;
    await new Promise((resolve) => setTimeout(resolve, 1));
  }
  throw new Error("Plan terminal state deadline exceeded.");
}

class FakeAcpClient {
  sessionId = "opaque-acp-session-secret";
  newSessionCalls = 0;
  loadSessionCalls = [];
  promptCalls = [];
  closed = false;
  closeCalls = 0;
  cancelCalls = 0;
  deferred;
  deferredNewSession;
  promptError;
  promptOnText;
  applyRedaction;
  chunks;
  resultMarkdown;
  resolveNewSession;
  resolvePrompt;
  replacement;

  constructor(options = {}) {
    this.applyRedaction = options.applyRedaction === true;
    this.deferred = options.deferred === true;
    this.deferredNewSession = options.deferredNewSession === true;
    this.promptError = options.promptError;
    this.chunks = options.chunks ?? ["# Requirements"];
    this.resultMarkdown = options.resultMarkdown ?? this.chunks.join("");
  }

  async newSession() {
    this.newSessionCalls += 1;
    if (this.deferredNewSession) {
      await new Promise((resolve) => { this.resolveNewSession = resolve; });
    }
    return this.sessionId;
  }

  async loadSession(cwd, sessionId) {
    this.loadSessionCalls.push({ cwd, sessionId });
  }

  async prompt(sessionId, prompt, options) {
    this.promptCalls.push({ sessionId, prompt, redactProjectRoot: options.redactProjectRoot });
    this.promptOnText = options.onText;
    const chunks = this.applyRedaction
      ? Array.from([prompt, options.redactProjectRoot, sessionId].filter(Boolean).reduce(
          (output, value) => output.replaceAll(value, "[redacted]"),
          this.chunks.join(""),
        ))
      : this.chunks;
    for (const chunk of chunks) options.onText?.(chunk);
    if (this.deferred) await new Promise((resolve) => { this.resolvePrompt = resolve; });
    if (this.promptError) throw this.promptError;
    return { stopReason: "end_turn", markdown: this.resultMarkdown };
  }

  async cancel() {
    this.cancelCalls += 1;
  }

  completePrompt() {
    this.resolvePrompt?.();
  }

  completeNewSession() {
    this.resolveNewSession?.();
  }

  emitPromptText(text) {
    this.promptOnText?.(text);
  }

  isClosed() {
    return this.closed;
  }

  async close() {
    this.closeCalls += 1;
    this.closed = true;
    this.resolveNewSession?.();
    this.resolvePrompt?.();
  }
}

function toPlain(value) {
  return JSON.parse(JSON.stringify(value));
}

async function loadPlanRuntime(moduleOverrides = {}) {
  return loadTypeScriptModule("planRuntime.ts", {
    "@skyturn/project-core": await import("@skyturn/project-core"),
    ...moduleOverrides,
  });
}

async function loadTypeScriptModule(fileName, moduleOverrides = {}) {
  const source = await readFile(join(root, "electron", fileName), "utf8");
  const ts = require("typescript");
  const output = ts.transpileModule(source, {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
  }).outputText;
  const module = { exports: {} };
  vm.runInNewContext(
    output,
    {
      module,
      exports: module.exports,
      require: (specifier) => moduleOverrides[specifier] ?? require(specifier),
      process,
      console,
      Buffer,
      AbortController,
      AbortSignal,
      setTimeout,
      clearTimeout,
      crypto: globalThis.crypto,
      __dirname: join(root, "electron"),
      __filename: join(root, "electron", fileName),
    },
    { filename: fileName },
  );
  return module.exports;
}
