import {
  appendFile,
  chmod,
  link,
  lstat,
  mkdir,
  mkdtemp,
  open,
  readFile,
  realpath,
  rename,
  rm,
  stat,
  symlink,
  writeFile,
  type FileHandle,
} from "node:fs/promises";
import { spawnSync, type ChildProcess } from "node:child_process";
import { createHash } from "node:crypto";
import { EventEmitter } from "node:events";
import { appendFileSync, existsSync, fstatSync } from "node:fs";
import { dirname, join } from "node:path";
import { tmpdir } from "node:os";
import { PassThrough } from "node:stream";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { RunEventDraft, RunEventSink } from "@skyturn/agent-runtime";
import { summarizeRunEvidence } from "@skyturn/project-core";
import type { AgentRun, RunEvent, RunEvidence } from "@skyturn/project-core";
import type { TerminalSessionEventDraft } from "@skyturn/project-core";
import { reduceWorkflowEvents, scheduleReadyLanes, type FlowEvent } from "@skyturn/workflow-kernel";

import {
  AgentBridge as ProductionAgentBridge,
  RUN_EVENT_PROTOCOL_VERSION,
  assertExpectedArtifactVerifierCapability,
  createAgentRunStartFingerprint,
  createDiscoveryService,
  buildHermesPlannerPtyLaunch,
  createHermesPlannerPtyTransport,
  createMockAgentAdapter,
  createPrivateRunEventStore,
  createPtyTerminalSessionManager,
  deriveEvidenceFromEvents,
  flowEventsFromAgentRun,
  loadRunEvents,
  readTaskOutput,
  type PtyExitEvent,
  type PtyProcess,
  type PtyProcessFactory,
  type AgentBridgeOptions,
  type PrivateRunEventStore,
} from "./index";
import {
  createTestCodexCliAdapter as createCodexCliAdapter,
  createTestHermesCliAdapter as createHermesCliAdapter,
} from "./internal/adapterTestFactories.js";
import { createDurableRunClaimStore, defaultDurableRunClaimRoot } from "./durableRunClaim.js";
import { assertWindowsExpectedArtifactVerifierCapability } from "./internal/windowsExpectedArtifactVerifier.js";

type SpawnWindowsJobObjectProcess = typeof import(
  "./internal/windowsJobObjectProcess.js"
)["spawnWindowsJobObjectProcess"];

const windowsJobObjectProcessMock = vi.hoisted(() => ({
  spawn: null as SpawnWindowsJobObjectProcess | null,
}));

vi.mock("./internal/windowsJobObjectProcess.js", async (importOriginal) => {
  const original = await importOriginal<typeof import("./internal/windowsJobObjectProcess.js")>();
  return {
    ...original,
    spawnWindowsJobObjectProcess: (...args: Parameters<SpawnWindowsJobObjectProcess>) =>
      windowsJobObjectProcessMock.spawn
        ? windowsJobObjectProcessMock.spawn(...args)
        : original.spawnWindowsJobObjectProcess(...args),
  };
});

const roots: string[] = [];
const testDefaultWatchdogTimeoutMs = 250;
const previousStateHome = process.env.SKYTURN_STATE_HOME;

beforeEach(async () => {
  process.env.SKYTURN_STATE_HOME = await makeTempRoot();
});

function testDurableRunClaimStore() {
  return createDurableRunClaimStore({ root: defaultDurableRunClaimRoot() });
}

class AgentBridge extends ProductionAgentBridge {
  constructor(options: AgentBridgeOptions = {}) {
    super({ durableRunClaimStore: testDurableRunClaimStore(), ...options });
  }
}

async function appendRunEventForTest(projectRoot: string, event: RunEvent): Promise<void> {
  const directory = join(projectRoot, ".devflow", "runs", event.runId);
  await mkdir(directory, { recursive: true });
  await appendFile(join(directory, "events.ndjson"), `${JSON.stringify(event)}\n`, "utf8");
}

function readableUnsyncedTerminalStore(mode: "one-shot" | "permanent"): {
  store: PrivateRunEventStore;
  readonly statusAttempts: number;
} {
  const events = new Map<string, RunEvent[]>();
  let statusAttempts = 0;
  let terminalDurable = false;
  return {
    store: {
      async prepare() {},
      async eventPath(_projectRoot, runId) {
        return `/private/${runId}.events.ndjson`;
      },
      async append(_projectRoot, event) {
        const runEvents = events.get(event.runId) ?? [];
        const existing = runEvents.find((candidate) => candidate.seq === event.seq);
        if (existing && JSON.stringify(existing) !== JSON.stringify(event)) {
          throw new Error("Private run event conflict.");
        }
        if (!existing) {
          runEvents.push(event);
          events.set(event.runId, runEvents);
        }
        if (event.kind === "status") {
          statusAttempts += 1;
          if (mode === "permanent" || statusAttempts === 1) {
            throw Object.assign(new Error("injected file sync failure"), { code: "EIO" });
          }
          terminalDurable = true;
        }
        return existing ? "exists" : "appended";
      },
      async read(_projectRoot, runId) {
        const runEvents = events.get(runId);
        if (runEvents?.some((event) => event.kind === "status") && !terminalDurable) {
          return { kind: "invalid" as const };
        }
        return runEvents ? { kind: "valid" as const, events: runEvents } : { kind: "missing" as const };
      },
    },
    get statusAttempts() {
      return statusAttempts;
    },
  };
}

type PrivateSyncTarget = "file" | "directory";

function syncFaultPrivateEventStore(
  durableRunClaimStore: ReturnType<typeof createDurableRunClaimStore>,
  fault: (input: { target: PrivateSyncTarget; path: string; attempt: number }) => string | null,
): { store: PrivateRunEventStore; syncTargets: PrivateSyncTarget[] } {
  const syncTargets: PrivateSyncTarget[] = [];
  const attempts = new Map<string, number>();
  const store = createPrivateRunEventStore({
    durableRunClaimStore,
    fileSystem: {
      chmod,
      lstat,
      mkdir,
      async open(path, flags, mode) {
        const handle = await open(path, flags, mode);
        const target: PrivateSyncTarget = typeof flags === "string" ? "directory" : "file";
        return new Proxy(handle, {
          get(value, property) {
            if (property === "sync") {
              return async () => {
                const key = `${target}:${path}`;
                const attempt = (attempts.get(key) ?? 0) + 1;
                attempts.set(key, attempt);
                syncTargets.push(target);
                const code = fault({ target, path, attempt });
                if (code) throw Object.assign(new Error(`injected ${target} sync failure`), { code });
                await value.sync();
              };
            }
            const member = Reflect.get(value, property, value) as unknown;
            return typeof member === "function" ? member.bind(value) : member;
          },
        }) as FileHandle;
      },
    },
  });
  return { store, syncTargets };
}

function claimDirectorySyncFaultFileSystem(
  fault: (input: { path: string; attempt: number }) => string | null,
): {
  fileSystem: {
    realpath: typeof realpath;
    chmod: typeof chmod;
    lstat: typeof lstat;
    mkdir: typeof mkdir;
    open(path: string, flags: string | number, mode?: number): Promise<FileHandle>;
  };
  syncPaths: string[];
  readonly claimOpens: number;
} {
  const syncPaths: string[] = [];
  const attempts = new Map<string, number>();
  let claimOpens = 0;
  return {
    fileSystem: {
      realpath,
      chmod,
      lstat,
      mkdir,
      async open(path, flags, mode) {
        if (flags === "wx") claimOpens += 1;
        const handle = await open(path, flags, mode);
        const directory = (await handle.stat()).isDirectory();
        if (!directory) return handle;
        return new Proxy(handle, {
          get(value, property) {
            if (property === "sync") {
              return async () => {
                const attempt = (attempts.get(path) ?? 0) + 1;
                attempts.set(path, attempt);
                syncPaths.push(path);
                const code = fault({ path, attempt });
                if (code) throw Object.assign(new Error(`injected directory sync failure for ${path}`), { code });
                await value.sync();
              };
            }
            const member = Reflect.get(value, property, value) as unknown;
            return typeof member === "function" ? member.bind(value) : member;
          },
        }) as FileHandle;
      },
    },
    syncPaths,
    get claimOpens() {
      return claimOpens;
    },
  };
}

async function readWorkspaceRunEvents(projectRoot: string, runId: string): Promise<RunEvent[]> {
  try {
    const text = await readFile(join(projectRoot, ".devflow", "runs", runId, "events.ndjson"), "utf8");
    return text.split("\n").filter(Boolean).map((line) => JSON.parse(line) as RunEvent);
  } catch {
    return [];
  }
}

afterEach(async () => {
  vi.useRealTimers();
  windowsJobObjectProcessMock.spawn = null;
  await Promise.all(roots.map((root) => rm(root, { force: true, recursive: true })));
  roots.length = 0;
  if (previousStateHome === undefined) delete process.env.SKYTURN_STATE_HOME;
  else process.env.SKYTURN_STATE_HOME = previousStateHome;
});

describe("agent bridge", () => {
  it.each(["darwin", "linux", "win32"] as const)(
    "starts an explicit run without expected artifacts under %s claim semantics",
    async (platform) => {
      const projectRoot = await makeTempRoot();
      const durableRunClaimStore = createDurableRunClaimStore({ root: await makeTempRoot(), platform });
      let starts = 0;
      const bridge = new AgentBridge({
        durableRunClaimStore,
        adapters: [{
          ...createMockAgentAdapter({ holdOpen: true }),
          async startRun(input, sink) {
            starts += 1;
            return createMockAgentAdapter({ holdOpen: true }).startRun(input, sink);
          },
        }],
      });
      const input = explicitRunInput(projectRoot, `platform-${platform}`);

      const run = await bridge.startRun(input);

      expect(run.status).toBe("running");
      expect(starts).toBe(1);
      await expect(durableRunClaimStore.read(projectRoot, input.runId)).resolves.toMatchObject({ kind: "valid" });
      await bridge.cancelRun(run.id, "test cleanup");
    },
  );

  it.each([
    ["parent-of-root", "EIO"],
    ["parent-of-root", "EPERM"],
    ["claim-root", "EIO"],
    ["claim-root", "EPERM"],
  ] as const)(
    "does not publish, emit, or spawn when %s directory sync fails with %s",
    async (failureTarget, code) => {
      const projectRoot = await makeTempRoot();
      const appPrivateParent = await realpath(await makeTempRoot());
      const claimRoot = join(appPrivateParent, "run-claims");
      if (failureTarget === "claim-root") await mkdir(claimRoot, { mode: 0o700 });
      const syncTarget = failureTarget === "parent-of-root" ? appPrivateParent : claimRoot;
      const fault = claimDirectorySyncFaultFileSystem(({ path }) => path === syncTarget ? code : null);
      const durableRunClaimStore = createDurableRunClaimStore({
        root: claimRoot,
        platform: "linux",
        fileSystem: fault.fileSystem,
      });
      let starts = 0;
      const liveEvents: RunEvent[] = [];
      const adapter = {
        ...createMockAgentAdapter({ holdOpen: true }),
        async startRun() {
          starts += 1;
          return { async cancel() {} };
        },
      };
      const bridge = new AgentBridge({ durableRunClaimStore, adapters: [adapter] });
      bridge.onRunEvent((event) => liveEvents.push(event));
      const input = explicitRunInput(projectRoot, `sync-failure-${failureTarget}-${code.toLowerCase()}`);

      await expect(bridge.startRun(input)).rejects.toThrow();
      await expect(bridge.startRun(input)).rejects.toThrow();
      const reopened = new AgentBridge({
        durableRunClaimStore: createDurableRunClaimStore({
          root: claimRoot,
          platform: "linux",
          fileSystem: fault.fileSystem,
        }),
        adapters: [adapter],
      });
      await expect(reopened.startRun(input)).rejects.toThrow();

      expect(fault.syncPaths).toContain(syncTarget);
      expect(fault.claimOpens).toBe(0);
      expect(starts).toBe(0);
      expect(liveEvents).toEqual([]);
    },
  );

  it.each(["parent-of-root", "claim-root"] as const)(
    "retries one visible directory after a one-shot %s sync failure and still starts only once",
    async (failureTarget) => {
      const projectRoot = await makeTempRoot();
      const appPrivateParent = await realpath(await makeTempRoot());
      const claimRoot = join(appPrivateParent, "run-claims");
      if (failureTarget === "claim-root") await mkdir(claimRoot, { mode: 0o700 });
      const syncTarget = failureTarget === "parent-of-root" ? appPrivateParent : claimRoot;
      let failed = false;
      const fault = claimDirectorySyncFaultFileSystem(({ path }) => {
        if (!failed && path === syncTarget) {
          failed = true;
          return "EIO";
        }
        return null;
      });
      const durableRunClaimStore = createDurableRunClaimStore({
        root: claimRoot,
        platform: "linux",
        fileSystem: fault.fileSystem,
      });
      let starts = 0;
      const adapter = {
        ...createMockAgentAdapter({ holdOpen: true }),
        async startRun() {
          starts += 1;
          return { async cancel() {} };
        },
      };
      const bridge = new AgentBridge({ durableRunClaimStore, adapters: [adapter] });
      const input = explicitRunInput(projectRoot, `sync-retry-${failureTarget}`);

      await expect(bridge.startRun(input)).rejects.toThrow();
      expect(starts).toBe(0);
      await expect(bridge.startRun(input)).resolves.toMatchObject({ status: "running" });
      await expect(bridge.startRun(input)).resolves.toMatchObject({ status: "running" });

      const reopened = new AgentBridge({
        durableRunClaimStore: createDurableRunClaimStore({
          root: claimRoot,
          platform: "linux",
          fileSystem: fault.fileSystem,
        }),
        adapters: [adapter],
      });
      await expect(reopened.startRun(input)).rejects.toThrow(/active|claimed|terminal|durable state/i);
      expect(fault.syncPaths.filter((path) => path === syncTarget).length).toBeGreaterThanOrEqual(2);
      expect(fault.claimOpens).toBe(1);
      expect(starts).toBe(1);
    },
  );

  it("keeps raw project, prompt, and continuity data out of private paths and records", async () => {
    const projectRoot = await makeTempRoot();
    const privateRoot = await makeTempRoot();
    const durableRunClaimStore = createDurableRunClaimStore({ root: privateRoot });
    const privateRunEventStore = createPrivateRunEventStore({ durableRunClaimStore });
    const input = {
      ...explicitRunInput(projectRoot, "private-record-redaction"),
      prompt: "do not persist this exact private prompt",
      hermesSessionHandle: "private-continuity-handle-123456",
    };
    const bridge = new AgentBridge({
      adapters: [createMockAgentAdapter()],
      durableRunClaimStore,
      privateRunEventStore,
    });

    await bridge.startRun(input);

    const eventPath = await privateRunEventStore.eventPath(projectRoot, input.runId);
    const markerPath = await durableRunClaimStore.markerPath(projectRoot, input.runId);
    const privateState = `${eventPath}\n${markerPath}\n${await readFile(eventPath, "utf8")}\n${await readFile(markerPath, "utf8")}`;
    expect(privateState).not.toContain(projectRoot);
    expect(privateState).not.toContain(input.prompt);
    expect(privateState).not.toContain(input.hermesSessionHandle);
  });

  it("keeps current-branch and worktree claims under one stable imported-project key across reopen", async () => {
    const projectRoot = await makeTempRoot();
    const worktreePath = await makeTempRoot();
    const durableRunClaimStore = createDurableRunClaimStore({ root: await makeTempRoot() });
    const adapter = createMockAgentAdapter({ holdOpen: true });
    const bridge = new AgentBridge({ durableRunClaimStore, adapters: [adapter] });
    const current = explicitRunInput(projectRoot, "current-branch-claim");
    const worktree = {
      ...explicitRunInput(projectRoot, "worktree-claim"),
      worktreePath,
    };

    await bridge.startRun(current);
    await bridge.startRun(worktree);
    const currentMarker = await durableRunClaimStore.markerPath(projectRoot, current.runId);
    const worktreeMarker = await durableRunClaimStore.markerPath(projectRoot, worktree.runId);
    expect(dirname(currentMarker)).toBe(dirname(worktreeMarker));
    await bridge.cancelRun(current.runId, "test cleanup");
    await bridge.cancelRun(worktree.runId, "test cleanup");

    const reopenedStore = createDurableRunClaimStore({ root: dirname(dirname(currentMarker)) });
    const reopened = new AgentBridge({ durableRunClaimStore: reopenedStore, adapters: [adapter] });
    expect(await reopenedStore.markerPath(projectRoot, current.runId)).toBe(currentMarker);
    await expect(reopened.getEvidence(projectRoot, current.runId)).resolves.toMatchObject({ status: "cancelled" });
    await expect(reopened.getEvidence(projectRoot, worktree.runId)).resolves.toMatchObject({ status: "cancelled" });
  });

  it("single-flights concurrent starts for one explicit run id", async () => {
    const projectRoot = await makeTempRoot();
    const baseAdapter = createMockAgentAdapter({ holdOpen: true });
    let starts = 0;
    const bridge = new AgentBridge({
      adapters: [{
        ...baseAdapter,
        async startRun(input, sink) {
          const claim = await readFile(
            await testDurableRunClaimStore().markerPath(projectRoot, input.runId),
            "utf8",
          );
          expect(JSON.parse(claim)).toMatchObject({
            runId: input.runId,
            nodeId: input.nodeId,
            sessionId: input.sessionId,
            agentKind: input.agentKind,
            startFingerprint: expect.stringMatching(/^[a-f0-9]{64}$/),
          });
          expect(claim).not.toContain(input.prompt);
          expect(claim).not.toContain(input.hermesSessionHandle!);
          starts += 1;
          return baseAdapter.startRun(input, sink);
        },
      }],
    });
    const input = {
      protocolVersion: RUN_EVENT_PROTOCOL_VERSION,
      runId: "run-explicit-single-flight",
      nodeId: "node-single-flight",
      sessionId: "session-1",
      projectRoot,
      worktreePath: projectRoot,
      agentKind: "codex" as const,
      hermesSessionHandle: "resume-secret-single-flight",
      prompt: "Start once with prompt-secret-single-flight",
    };

    const [first, duplicate] = await Promise.all([
      bridge.startRun(input),
      bridge.startRun(input),
    ]);

    expect(first).toEqual(duplicate);
    await expect(stat(await testDurableRunClaimStore().markerPath(projectRoot, input.runId))).resolves.toBeDefined();
    await expect(stat(join(projectRoot, ".devflow", "runs", input.runId, "start-claim.json"))).rejects.toThrow();
    expect(starts).toBe(1);
    expect(bridge.listRuns()).toEqual([expect.objectContaining({
      id: input.runId,
      status: "running",
    })]);
    await bridge.cancelRun(input.runId, "test cleanup");
  });

  it("joins cancellation requested before a delayed adapter publishes its handle", async () => {
    const projectRoot = await makeTempRoot();
    const handlePublication = deferred<void>();
    const privateRunEventStore = inMemoryPrivateRunEventStore();
    const liveEvents: RunEvent[] = [];
    let cancelCalls = 0;
    const bridge = new AgentBridge({
      privateRunEventStore,
      adapters: [{
        ...createMockAgentAdapter({ holdOpen: true }),
        async startRun(_input, sink) {
          await handlePublication.promise;
          await sink.emit({ kind: "status", payload: { status: "running" } });
          return {
            async cancel(reason) {
              cancelCalls += 1;
              await sink.emit({
                kind: "evidence",
                payload: {
                  exitCode: null,
                  checks: [{ kind: "run-exit", name: "Delayed adapter exit", status: "skipped", detail: reason }],
                },
              });
              await sink.emit({ kind: "status", payload: { status: "cancelled", reason } });
            },
          };
        },
      }],
    });
    bridge.onRunEvent((event) => liveEvents.push(event));
    const input = explicitRunInput(projectRoot, "cancel-before-handle-publication");

    const start = bridge.startRun(input);
    await waitForCondition(
      () => bridge.listRuns().some((run) => run.id === input.runId && run.status === "running"),
      "starting run publication",
    );
    let cancelSettled = false;
    const cancellation = bridge.cancelRun(input.runId, "cancel during adapter start").then((evidence) => {
      cancelSettled = true;
      return evidence;
    });
    await flushStartCancellation();

    expect(cancelSettled).toBe(false);
    expect(cancelCalls).toBe(0);

    handlePublication.resolve();
    const [started, evidence] = await Promise.all([start, cancellation]);
    await bridge.cancelRun(input.runId, "duplicate cancellation");
    const events = await bridge.loadEvents(projectRoot, input.runId);
    const terminalIndex = events.findIndex(isTerminalRunStatusEvent);

    expect(started.status).toBe("cancelled");
    expect(evidence.status).toBe("cancelled");
    expect(cancelCalls).toBe(1);
    expect(terminalRunStatuses(events)).toHaveLength(1);
    expect(terminalRunStatuses(liveEvents)).toHaveLength(1);
    expect(events.filter((event) => event.kind === "evidence")).toHaveLength(1);
    expect(liveEvents.filter((event) => event.kind === "evidence")).toHaveLength(1);
    expect(events.slice(terminalIndex + 1)).not.toContainEqual(
      expect.objectContaining({ kind: "status", payload: expect.objectContaining({ status: "running" }) }),
    );
    expect(bridge.listRuns()).toEqual([
      expect.objectContaining({ id: input.runId, status: "cancelled" }),
    ]);
  });

  it("joins cancellation requested before a delayed adapter start rejection", async () => {
    const projectRoot = await makeTempRoot();
    const startRejection = deferred<void>();
    const privateRunEventStore = inMemoryPrivateRunEventStore();
    const bridge = new AgentBridge({
      privateRunEventStore,
      adapters: [{
        ...createMockAgentAdapter({ holdOpen: true }),
        async startRun() {
          await startRejection.promise;
          throw new Error("delayed adapter start failed");
        },
      }],
    });
    const input = explicitRunInput(projectRoot, "cancel-before-start-rejection");

    const start = bridge.startRun(input).then(
      (run) => ({ kind: "fulfilled" as const, run }),
      (error: unknown) => ({ kind: "rejected" as const, error }),
    );
    await waitForCondition(
      () => bridge.listRuns().some((run) => run.id === input.runId && run.status === "running"),
      "starting run publication",
    );
    let cancelSettled = false;
    const cancellation = bridge.cancelRun(input.runId, "cancel during adapter start").then((evidence) => {
      cancelSettled = true;
      return evidence;
    });
    await flushStartCancellation();

    expect(cancelSettled).toBe(false);

    startRejection.resolve();
    const [startOutcome, evidence] = await Promise.all([start, cancellation]);
    const events = await bridge.loadEvents(projectRoot, input.runId);

    expect(startOutcome).toMatchObject({
      kind: "rejected",
      error: expect.objectContaining({ message: "delayed adapter start failed" }),
    });
    expect(evidence).toMatchObject({ status: "failed", errorReason: "delayed adapter start failed" });
    expect(terminalRunStatuses(events)).toEqual([
      expect.objectContaining({ kind: "status", payload: expect.objectContaining({ status: "failed" }) }),
    ]);
    expect(bridge.listRuns()).toEqual([
      expect.objectContaining({ id: input.runId, status: "failed" }),
    ]);
  });

  it.each(["codex", "hermes"] as const)(
    "publishes a complete private %s claim before adapter start",
    async (agentKind) => {
      const projectRoot = await makeTempRoot();
      const baseAdapter = createMockAgentAdapter({ holdOpen: true });
      let starts = 0;
      const bridge = new AgentBridge({
        adapters: [{
          ...baseAdapter,
          kind: agentKind,
          async startRun(input, sink) {
            const claimPath = await testDurableRunClaimStore().markerPath(projectRoot, input.runId);
            const claimText = await readFile(claimPath, "utf8");
            expect(JSON.parse(claimText)).toMatchObject({
              runId: input.runId,
              nodeId: input.nodeId,
              sessionId: input.sessionId,
              agentKind,
              startFingerprint: expect.stringMatching(/^[a-f0-9]{64}$/),
            });
            expect((await stat(claimPath)).mode & 0o777).toBe(0o600);
            expect(claimText).not.toContain(input.prompt);
            expect(claimText).not.toContain(input.hermesSessionHandle ?? "not-present");
            starts += 1;
            return baseAdapter.startRun(input, sink);
          },
        }],
      });
      const input = explicitRunInput(projectRoot, `${agentKind}-durable-before-start`, agentKind);

      await bridge.startRun({ ...input, hermesSessionHandle: "resume-secret-before-start" });

      expect(starts).toBe(1);
      await bridge.cancelRun(input.runId, "test cleanup");
    },
  );

  it.each(["codex", "hermes"] as const)(
    "recovers a published %s claim from a crash before adapter spawn without relaunching",
    async (agentKind) => {
      const projectRoot = await makeTempRoot();
      const input = explicitRunInput(projectRoot, `${agentKind}-published-before-spawn`, agentKind);
      const durableRunClaimStore = createDurableRunClaimStore({ root: await makeTempRoot() });
      await durableRunClaimStore.publish(projectRoot, {
        runId: input.runId,
        nodeId: input.nodeId,
        sessionId: input.sessionId,
        agentKind,
        startFingerprint: createAgentRunStartFingerprint(input),
        startedAt: "2026-07-15T00:00:00.000Z",
      });
      let starts = 0;
      const bridge = new AgentBridge({
        durableRunClaimStore,
        adapters: [{
          ...createMockAgentAdapter({ holdOpen: true }),
          kind: agentKind,
          async startRun() {
            starts += 1;
            return { async cancel() {} };
          },
        }],
      });

      await expect(bridge.getEvidence(projectRoot, input.runId)).resolves.toMatchObject({
        status: "failed",
        errorReason: "terminal-persistence-failed",
        completedAt: "2026-07-15T00:00:00.000Z",
      });
      await expect(bridge.startRun(input)).rejects.toThrow(/already terminal/i);
      expect(starts).toBe(0);
    },
  );

  it.each(["same", "conflicting"] as const)(
    "allows only one cross-bridge adapter start for %s concurrent fingerprints",
    async (fingerprintCase) => {
      const projectRoot = await makeTempRoot();
      const input = explicitRunInput(projectRoot, `cross-bridge-${fingerprintCase}`);
      let starts = 0;
      const adapter = {
        ...createMockAgentAdapter({ holdOpen: true }),
        async startRun() {
          starts += 1;
          return { async cancel() {} };
        },
      };
      const first = new AgentBridge({ adapters: [adapter] });
      const second = new AgentBridge({ adapters: [adapter] });

      const results = await Promise.allSettled([
        first.startRun(input),
        second.startRun(fingerprintCase === "same" ? input : { ...input, prompt: "Conflicting prompt" }),
      ]);

      expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(1);
      expect(results.filter((result) => result.status === "rejected")).toHaveLength(1);
      expect(starts).toBe(1);
      expect(String((results.find((result) => result.status === "rejected") as PromiseRejectedResult).reason)).toMatch(
        fingerprintCase === "same"
          ? /active|claimed|run-start-claim-invalid/i
          : /different identity|run-start-claim-invalid/i,
      );
    },
  );

  it("rejects a traversal alias instead of fingerprinting it beside a safe declaration", async () => {
    const projectRoot = await makeTempRoot();
    const bridge = new AgentBridge({
      adapters: [createMockAgentAdapter({ holdOpen: true })],
    });
    const input = {
      protocolVersion: RUN_EVENT_PROTOCOL_VERSION,
      runId: "run-explicit-artifact-alias",
      nodeId: "node-artifact-alias",
      sessionId: "session-1",
      projectRoot,
      worktreePath: projectRoot,
      agentKind: "codex" as const,
      expectedArtifacts: [".devflow/acceptance/result.png"],
      prompt: "Start once",
    };

    const first = bridge.startRun(input);
    await expect(bridge.startRun({
      ...input,
      expectedArtifacts: [".devflow/acceptance/nested/../result.png"],
    })).rejects.toThrow(/expectedArtifacts|artifact declaration/i);
    await first;
    await bridge.cancelRun(input.runId, "test cleanup");
  });

  it("uses the exact sorted case-folded artifact declaration representation in start fingerprints", async () => {
    const projectRoot = await makeTempRoot();
    const canonicalProjectRoot = await realpath(projectRoot);
    const input = {
      protocolVersion: RUN_EVENT_PROTOCOL_VERSION,
      runId: "run-canonical-artifact-fingerprint",
      nodeId: "node-canonical-artifact-fingerprint",
      sessionId: "session-1",
      projectRoot: canonicalProjectRoot,
      worktreePath: canonicalProjectRoot,
      agentKind: "codex" as const,
      expectedArtifacts: [
        ".devflow/acceptance/Zeta.png",
        ".devflow/acceptance/alpha.png",
      ],
      prompt: "Verify canonical artifact fingerprint",
    };
    const expected = createHash("sha256").update(JSON.stringify({
      version: 1,
      protocolVersion: RUN_EVENT_PROTOCOL_VERSION,
      projectRoot: canonicalProjectRoot,
      sessionId: input.sessionId,
      nodeId: input.nodeId,
      runId: input.runId,
      agentKind: input.agentKind,
      transport: null,
      worktreePath: canonicalProjectRoot,
      sandbox: null,
      prompt: input.prompt,
      expectedArtifacts: [
        ".devflow/acceptance/alpha.png",
        ".devflow/acceptance/zeta.png",
      ],
      plannerSessionId: null,
      plannerInputId: null,
      hermesSessionHandle: null,
    }), "utf8").digest("hex");

    expect(createAgentRunStartFingerprint(input)).toBe(expected);
    expect(createAgentRunStartFingerprint({
      ...input,
      expectedArtifacts: [
        ".devflow/acceptance/ALPHA.PNG",
        ".devflow/acceptance/ZETA.PNG",
      ],
    })).toBe(expected);
  });

  it.each([
    ".devflow/acceptance/service-account.json.backup.txt",
    ".devflow/acceptance/service-account.json.orig.1",
    ".devflow/acceptance/SERVICE._-ACCOUNT--JSON__COPY.tar.gz",
    ".devflow/acceptance/service account.json.backup.txt",
    ".devflow/acceptance/service．account.json.orig.1",
    ".devflow/acceptance/service—account.JSON.backup",
    ".devflow/acceptance/serviceaccount.json.orig.1",
    ".devflow/acceptance/service-account.json.report.json",
  ])("rejects service-account credential family %j before creating a start fingerprint", async (artifact) => {
    const projectRoot = await makeTempRoot();
    let failure: unknown;
    try {
      createAgentRunStartFingerprint({
        protocolVersion: RUN_EVENT_PROTOCOL_VERSION,
        runId: "run-sensitive-artifact-fingerprint",
        nodeId: "node-sensitive-artifact-fingerprint",
        sessionId: "session-1",
        projectRoot,
        worktreePath: projectRoot,
        agentKind: "codex",
        expectedArtifacts: [".devflow/acceptance/safe.png", artifact],
        prompt: "Reject before fingerprinting",
      });
    } catch (error) {
      failure = error;
    }

    expect(failure).toBeInstanceOf(Error);
    expect(String(failure)).toMatch(/expectedArtifacts.*invalid/i);
    expect(String(failure)).not.toContain(artifact);
  });

  it.each([
    ".devflow/acceptance/service-accounting-report.txt",
    ".devflow/acceptance/service-accountability-report.txt",
    ".devflow/acceptance/authorized-keyspace-report.txt",
    ".devflow/acceptance/known-hostscope-report.txt",
  ])("includes neighboring non-sensitive artifact %j in a start fingerprint", async (artifact) => {
    const projectRoot = await makeTempRoot();

    expect(createAgentRunStartFingerprint({
      ...explicitRunInput(projectRoot, "neighbor-artifact-fingerprint"),
      expectedArtifacts: [artifact],
    })).toMatch(/^[a-f0-9]{64}$/);
  });

  it.each(["codex", "hermes"] as const)(
    "rejects every unsafe %s artifact declaration before durable claim or adapter start",
    async (agentKind) => {
      const invalidDeclarations = [
        [".devflow/acceptance/nested/../result.png"],
        ["/Users/alice/private/result.png"],
        [".devflow/acceptance/result\n.png"],
        [""],
        [".devflow/acceptance/id_rsa"],
        [".devflow/acceptance/service-account.json.backup"],
        [
          ".devflow/acceptance/safe.png",
          ".devflow/acceptance/service-account.json.backup.txt",
        ],
        [
          ".devflow/acceptance/safe.png",
          ".devflow/acceptance/service-account.json.orig.1",
        ],
        [
          ".devflow/acceptance/safe.png",
          ".devflow/acceptance/SERVICE._-ACCOUNT--JSON__COPY.tar.gz",
        ],
        [
          ".devflow/acceptance/safe.png",
          ".devflow/acceptance/service account.json.backup.txt",
        ],
        [
          ".devflow/acceptance/safe.png",
          ".devflow/acceptance/service．account.json.orig.1",
        ],
        [
          ".devflow/acceptance/safe.png",
          ".devflow/acceptance/service—account.JSON.backup",
        ],
        [
          ".devflow/acceptance/safe.png",
          ".devflow/acceptance/serviceaccount.json.orig.1",
        ],
        [
          ".devflow/acceptance/safe.png",
          ".devflow/acceptance/service-account.json.report.json",
        ],
        [".devflow/acceptance//result.png"],
        [
          ".devflow/acceptance/result.png",
          ".devflow/acceptance/RESULT.PNG",
        ],
      ];

      for (const [index, expectedArtifacts] of invalidDeclarations.entries()) {
        const projectRoot = await makeTempRoot();
        const runId = `run-${agentKind}-invalid-artifact-${index}`;
        let adapterStarts = 0;
        const liveEvents: RunEvent[] = [];
        const bridge = new AgentBridge({
          adapters: [{
            kind: agentKind,
            async detect() {
              throw new Error("Discovery is not part of this test.");
            },
            async startRun() {
              adapterStarts += 1;
              return { async cancel() {} };
            },
          }],
        });
        const unsubscribe = bridge.onRunEvent((event) => liveEvents.push(event));

        const failure = await bridge.startRun({
          protocolVersion: RUN_EVENT_PROTOCOL_VERSION,
          runId,
          nodeId: `node-${agentKind}-invalid-artifact-${index}`,
          sessionId: "session-1",
          projectRoot,
          worktreePath: projectRoot,
          agentKind,
          expectedArtifacts,
          prompt: "Must fail before side effects",
        }).catch((error: unknown) => error);
        unsubscribe();
        expect(failure).toBeInstanceOf(Error);
        expect(String(failure)).toMatch(/expectedArtifacts|artifact declaration/i);
        expect(adapterStarts).toBe(0);
        expect(liveEvents).toEqual([]);
        for (const artifact of expectedArtifacts.filter(Boolean)) expect(String(failure)).not.toContain(artifact);
        await expect(stat(await testDurableRunClaimStore().markerPath(projectRoot, runId))).rejects.toThrow();
      }
    },
  );

  it.each(["codex", "hermes"] as const)(
    "rejects null expectedArtifacts for %s before capability, store, claim, adapter, or events",
    async (agentKind) => {
      const projectRoot = await makeTempRoot();
      const prepare = vi.fn(async () => {
        throw new Error("private store touched");
      });
      let adapterStarts = 0;
      const liveEvents: RunEvent[] = [];
      const bridge = new AgentBridge({
        adapters: [{
          kind: agentKind,
          async detect() {
            throw new Error("Discovery is not part of this test.");
          },
          async startRun() {
            adapterStarts += 1;
            return { async cancel() {} };
          },
        }],
        privateRunEventStore: {
          prepare,
          async eventPath(_root, runId) {
            return `/private/${runId}.events.ndjson`;
          },
          async append() {
            throw new Error("private append touched");
          },
          async read() {
            throw new Error("private read touched");
          },
        },
      });
      bridge.onRunEvent((event) => liveEvents.push(event));

      await expect(bridge.startRun({
        ...explicitRunInput(projectRoot, `${agentKind}-null-artifacts`, agentKind),
        expectedArtifacts: null as unknown as string[],
      })).rejects.toThrow(/expectedArtifacts declaration is invalid/i);

      expect(prepare).not.toHaveBeenCalled();
      expect(adapterStarts).toBe(0);
      expect(liveEvents).toEqual([]);
      await expect(stat(await testDurableRunClaimStore().markerPath(
        projectRoot,
        `run-${agentKind}-null-artifacts`,
      ))).rejects.toThrow();
    },
  );

  it.each(["codex", "hermes"] as const)(
    "fails null expectedArtifacts at the direct %s adapter verifier boundary",
    async (agentKind) => {
      const projectRoot = await makeTempRoot();
      if (agentKind === "codex") await mkdir(join(projectRoot, ".git"));
      const binRoot = await makeTempRoot();
      const executablePath = join(binRoot, agentKind);
      const spawnedMarker = join(binRoot, "spawned");
      await writeFile(executablePath, `#!/bin/sh\nprintf spawned > '${spawnedMarker}'\n`, { mode: 0o755 });
      const events: RunEvent[] = [];
      const terminal = deferred<RunEvent>();
      const sink: RunEventSink = {
        async emit(draft) {
          const event = {
            protocolVersion: RUN_EVENT_PROTOCOL_VERSION,
            runId: `run-${agentKind}-direct-null-artifacts`,
            seq: events.length + 1,
            timestamp: draft.timestamp ?? new Date().toISOString(),
            kind: draft.kind,
            payload: draft.payload,
          } as RunEvent;
          events.push(event);
          if (event.kind === "status") terminal.resolve(event);
          return event;
        },
      };
      const adapter = agentKind === "codex"
        ? createCodexCliAdapter({ executablePath })
        : createHermesCliAdapter({ executablePath });

      await adapter.startRun({
        ...explicitRunInput(projectRoot, `${agentKind}-direct-null-artifacts`, agentKind),
        expectedArtifacts: null as unknown as string[],
      }, sink);
      const terminalEvent = await terminal.promise;

      expect(terminalEvent.payload).toMatchObject({
        status: "failed",
        reason: "expected-artifact-failure",
      });
      expect(events).toContainEqual(expect.objectContaining({
        kind: "evidence",
        payload: expect.objectContaining({
          checks: expect.arrayContaining([expect.objectContaining({
            kind: "artifact",
            status: "failed",
            detail: "verified=0 missing=0 empty=0 unsafe=1",
          })]),
        }),
      }));
      expect(existsSync(spawnedMarker)).toBe(true);
    },
  );

  it.each(["project", "worktree"] as const)(
    "rejects an in-%s durable claim root before ownership or adapter spawn",
    async (boundary) => {
      const projectRoot = await makeTempRoot();
      const worktreePath = boundary === "project" ? projectRoot : await makeTempRoot();
      const claimRoot = join(boundary === "project" ? projectRoot : worktreePath, ".private", "run-claims");
      const durableRunClaimStore = createDurableRunClaimStore({ root: claimRoot });
      let adapterStarts = 0;
      const bridge = new ProductionAgentBridge({
        durableRunClaimStore,
        adapters: [{
          kind: "codex",
          async detect() {
            throw new Error("Discovery is not part of this test.");
          },
          async startRun() {
            adapterStarts += 1;
            return { async cancel() {} };
          },
        }],
      });

      const failure = await bridge.startRun({
        protocolVersion: RUN_EVENT_PROTOCOL_VERSION,
        runId: `run-in-${boundary}-claim-root`,
        nodeId: `node-in-${boundary}-claim-root`,
        sessionId: "session-1",
        projectRoot,
        worktreePath,
        agentKind: "codex",
        prompt: "Must fail before ownership",
      }).catch((error: unknown) => error);

      expect(adapterStarts).toBe(0);
      expect(String(failure)).toContain("run-start-claim-boundary-invalid");
      expect(String(failure)).not.toContain(projectRoot);
      expect(String(failure)).not.toContain(worktreePath);
    },
  );

  it.each([
    ["sandbox", "danger-full-access"],
    ["prompt", "Run a different instruction"],
    ["expectedArtifacts", [".devflow/acceptance/other.png"]],
    ["plannerSessionId", "planner-session-other"],
    ["plannerInputId", "planner-input-other"],
    ["hermesSessionHandle", "resume-handle-other"],
    ["transport", "pty-interactive"],
  ] as const)("rejects a concurrent explicit run id with conflicting %s semantics", async (field, conflictingValue) => {
    const projectRoot = await makeTempRoot();
    const baseAdapter = createMockAgentAdapter({ holdOpen: true });
    let starts = 0;
    const bridge = new AgentBridge({
      adapters: [{
        ...baseAdapter,
        async startRun(input, sink) {
          starts += 1;
          return baseAdapter.startRun(input, sink);
        },
      }],
    });
    const input = {
      protocolVersion: RUN_EVENT_PROTOCOL_VERSION,
      runId: "run-explicit-identity",
      nodeId: "node-original",
      sessionId: "session-1",
      projectRoot,
      worktreePath: projectRoot,
      agentKind: "codex" as const,
      sandbox: "workspace-write" as const,
      expectedArtifacts: [".devflow/acceptance/react-app.png"],
      plannerSessionId: "planner-session-1",
      plannerInputId: "planner-input-1",
      hermesSessionHandle: "resume-handle-1",
      transport: "exec-json" as const,
      prompt: "Start once",
    };

    const first = bridge.startRun(input);
    await expect(bridge.startRun({ ...input, [field]: conflictingValue })).rejects.toThrow(/different identity/i);
    await first;
    expect(starts).toBe(1);
    await bridge.cancelRun(input.runId, "test cleanup");
  });

  it("recovers a durable non-terminal explicit run claim as failed after restart without relaunching", async () => {
    const projectRoot = await makeTempRoot();
    const input = {
      protocolVersion: RUN_EVENT_PROTOCOL_VERSION,
      runId: "run-explicit-restart-claim",
      nodeId: "node-restart-claim",
      sessionId: "session-1",
      projectRoot,
      worktreePath: projectRoot,
      agentKind: "codex" as const,
      prompt: "Keep the first process active",
    };
    const activeBridge = new AgentBridge({
      adapters: [createMockAgentAdapter({ holdOpen: true })],
    });
    await activeBridge.startRun(input);
    const eventsBeforeRestart = await loadRunEvents(projectRoot, input.runId);
    let restartedLaunches = 0;
    const baseAdapter = createMockAgentAdapter({ holdOpen: true });
    const restartedBridge = new AgentBridge({
      adapters: [{
        ...baseAdapter,
        async startRun(nextInput, sink) {
          restartedLaunches += 1;
          return baseAdapter.startRun(nextInput, sink);
        },
      }],
    });

    await expect(restartedBridge.getEvidence(projectRoot, input.runId)).resolves.toMatchObject({
      status: "failed",
      errorReason: "terminal-persistence-failed",
    });
    await expect(restartedBridge.startRun(input)).rejects.toThrow(/already terminal/i);
    expect(restartedLaunches).toBe(0);
    expect(await loadRunEvents(projectRoot, input.runId)).toEqual(eventsBeforeRestart);
    await activeBridge.cancelRun(input.runId, "test cleanup");
  });

  it.each([
    ["sandbox", "danger-full-access"],
    ["prompt", "Run a different instruction after restart"],
    ["expectedArtifacts", [".devflow/acceptance/other.png"]],
    ["plannerSessionId", "planner-session-other"],
    ["plannerInputId", "planner-input-other"],
    ["hermesSessionHandle", "resume-handle-other"],
    ["transport", "pty-interactive"],
  ] as const)("rejects a durable run claim with conflicting %s semantics after restart", async (field, conflictingValue) => {
    const projectRoot = await makeTempRoot();
    const input = {
      protocolVersion: RUN_EVENT_PROTOCOL_VERSION,
      runId: `run-explicit-restart-${field}`,
      nodeId: "node-restart-fingerprint",
      sessionId: "session-1",
      projectRoot,
      worktreePath: projectRoot,
      agentKind: "codex" as const,
      sandbox: "workspace-write" as const,
      expectedArtifacts: [".devflow/acceptance/react-app.png"],
      plannerSessionId: "planner-session-1",
      plannerInputId: "planner-input-1",
      hermesSessionHandle: "resume-handle-1",
      transport: "exec-json" as const,
      prompt: "Keep the first process active",
    };
    const activeBridge = new AgentBridge({
      adapters: [createMockAgentAdapter({ holdOpen: true })],
    });
    await activeBridge.startRun(input);
    let restartedLaunches = 0;
    const baseAdapter = createMockAgentAdapter({ holdOpen: true });
    const restartedBridge = new AgentBridge({
      adapters: [{
        ...baseAdapter,
        async startRun(nextInput, sink) {
          restartedLaunches += 1;
          return baseAdapter.startRun(nextInput, sink);
        },
      }],
    });

    await expect(restartedBridge.startRun({ ...input, [field]: conflictingValue })).rejects.toThrow(/different identity/i);
    expect(restartedLaunches).toBe(0);
    await activeBridge.cancelRun(input.runId, "test cleanup");
  });

  for (const failedKind of ["evidence", "error", "status"] as const) {
    it(`fails closed when ${failedKind} event persistence fails during adapter start`, async () => {
      const projectRoot = await makeTempRoot();
      const bridge = new AgentBridge({
        appendEvent: async (root, event) => {
          if (event.kind === failedKind) throw new Error(`${failedKind} append failed`);
          await appendRunEventForTest(root, event);
        },
        adapters: [{
          ...createMockAgentAdapter(),
          async startRun(_input, sink) {
            await sink.emit({
              kind: failedKind,
              payload: failedKind === "status"
                ? { status: "failed", reason: "adapter failed" }
                : failedKind === "error"
                  ? { message: "adapter failed", category: "start-failed" }
                  : { exitCode: null, checks: [] },
            });
            throw new Error("adapter failed");
          },
        }],
      });
      const input = {
        protocolVersion: RUN_EVENT_PROTOCOL_VERSION,
        runId: `run-${failedKind}-append-failed`,
        nodeId: "node-start-failed",
        sessionId: "session-1",
        projectRoot,
        worktreePath: projectRoot,
        agentKind: "codex" as const,
        prompt: "Start failure",
      };

      await expect(bridge.startRun(input)).rejects.toThrow(
        failedKind === "status" ? "adapter failed" : `${failedKind} append failed`,
      );
      expect(bridge.listRuns()).toContainEqual(expect.objectContaining({ id: input.runId, status: "failed" }));
      await expect(bridge.getEvidence(projectRoot, input.runId)).resolves.toMatchObject({
        runId: input.runId,
        status: "failed",
        errorReason: failedKind === "status" ? "terminal-persistence-failed" : `${failedKind} append failed`,
      });

      const reopened = new AgentBridge({ adapters: [createMockAgentAdapter()] });
      await expect(reopened.startRun(input)).rejects.toThrow(/already terminal/i);
      expect(reopened.listRuns()).toContainEqual(expect.objectContaining({ id: input.runId, status: "failed" }));
    });
  }

  it("persists one terminal failed result when adapter start throws", async () => {
    const projectRoot = await makeTempRoot();
    let starts = 0;
    const bridge = new AgentBridge({
      adapters: [{
        ...createMockAgentAdapter(),
        async startRun() {
          starts += 1;
          throw new Error("spawn failed");
        },
      }],
    });

    await expect(bridge.startRun({
      protocolVersion: RUN_EVENT_PROTOCOL_VERSION,
      runId: "run-start-failed",
      nodeId: "node-start-failed",
      sessionId: "session-1",
      projectRoot,
      worktreePath: projectRoot,
      agentKind: "codex",
      prompt: "Start failure",
    })).rejects.toThrow("spawn failed");
    await expect(bridge.startRun({
      protocolVersion: RUN_EVENT_PROTOCOL_VERSION,
      runId: "run-start-failed",
      nodeId: "node-start-failed",
      sessionId: "session-1",
      projectRoot,
      worktreePath: projectRoot,
      agentKind: "codex",
      prompt: "Start failure",
    })).rejects.toThrow(/already terminal/i);

    const events = await loadRunEvents(projectRoot, "run-start-failed");
    expect(events).toEqual([
      expect.objectContaining({
        kind: "status",
        payload: expect.objectContaining({
          status: "failed",
          errorReason: "spawn failed",
          checks: [expect.objectContaining({ kind: "run-exit", status: "failed" })],
        }),
      }),
    ]);
    expect(starts).toBe(1);
    expect(bridge.listRuns()).toContainEqual(expect.objectContaining({
      id: "run-start-failed",
      status: "failed",
    }));
    await expect(bridge.getEvidence(projectRoot, "run-start-failed")).resolves.toMatchObject({
      runId: "run-start-failed",
      status: "failed",
      errorReason: "spawn failed",
    });
  });

  it("sanitizes owned adapter-start failures before live and durable boundaries", async () => {
    const projectRoot = await makeTempRoot();
    const secret = "adapter-start-secret-123456";
    const unsafeMessage = `spawn failed at /Users/alice/private/repo token=${secret} id_rsa`;
    const bridge = new AgentBridge({
      adapters: [{
        ...createMockAgentAdapter(),
        async startRun() {
          throw new Error(unsafeMessage);
        },
      }],
    });
    const liveEvents: RunEvent[] = [];
    const unsubscribe = bridge.onRunEvent((event) => liveEvents.push(event));

    await expect(bridge.startRun({
      protocolVersion: RUN_EVENT_PROTOCOL_VERSION,
      runId: "run-start-failed-sanitized",
      nodeId: "node-start-failed-sanitized",
      sessionId: "session-1",
      projectRoot,
      worktreePath: projectRoot,
      agentKind: "codex",
      prompt: "Start failure",
    })).rejects.toThrow();
    unsubscribe();

    const persisted = await readFile(
      join(projectRoot, ".devflow", "runs", "run-start-failed-sanitized", "events.ndjson"),
      "utf8",
    );
    const publicEvidence = JSON.stringify({ liveEvents, persisted });
    expect(publicEvidence).not.toMatch(/alice|adapter-start-secret-123456|id_rsa/);
    expect(publicEvidence).toContain("[redacted-path]");
  });

  it("rejects malformed agent-provided evidence before live and durable boundaries", async () => {
    const projectRoot = await makeTempRoot();
    const secret = "adapter-evidence-secret-123456";
    const bridge = new AgentBridge({
      adapters: [{
        ...createMockAgentAdapter(),
        async startRun(input, sink) {
          await sink.emit({
            kind: "evidence",
            payload: {
              exitCode: 1,
              changesetId: `changeset /Users/alice/private/repo token=${secret}`,
              errorReason: `failed at /Users/alice/private/repo token=${secret}`,
              cancelReason: `cancelled at /Users/alice/private/repo token=${secret}`,
              checks: [
                { kind: "test", name: "Unit /Users/alice/private/repo", status: "failed", detail: `token=${secret}` },
                { kind: "unknown-kind", name: "Unsafe", status: "passed" },
              ],
              artifacts: [".devflow/acceptance/result.png", "/Users/alice/.ssh/id_rsa"],
              review: { kind: "review", name: "Review id_rsa", status: "failed", detail: `token=${secret}` },
            },
          });
          await sink.emit({
            kind: "status",
            payload: {
              status: "failed",
              exitCode: 1,
              reason: `failed at /Users/alice/private/repo token=${secret}`,
              errorReason: `failed at /Users/alice/private/repo token=${secret}`,
              checks: [
                { kind: "run-exit", name: "Exit /Users/alice/private/repo", status: "failed", detail: `token=${secret}` },
                { kind: "unknown-kind", name: "Unsafe", status: "passed" },
              ],
            },
          });
          return { runId: input.runId, async cancel() {} };
        },
      }],
    });
    const liveEvents: RunEvent[] = [];
    const unsubscribe = bridge.onRunEvent((event) => liveEvents.push(event));

    await expect(bridge.startRun({
      protocolVersion: RUN_EVENT_PROTOCOL_VERSION,
      runId: "run-agent-evidence-sanitized",
      nodeId: "node-agent-evidence-sanitized",
      sessionId: "session-1",
      projectRoot,
      worktreePath: projectRoot,
      agentKind: "codex",
      prompt: "Publish evidence",
    })).rejects.toThrow();
    unsubscribe();

    const persisted = await readFile(
      join(projectRoot, ".devflow", "runs", "run-agent-evidence-sanitized", "events.ndjson"),
      "utf8",
    );
    const evidence = await bridge.getEvidence(projectRoot, "run-agent-evidence-sanitized");
    const publicEvidence = JSON.stringify({ liveEvents, persisted, evidence });
    expect(publicEvidence).not.toMatch(/alice|adapter-evidence-secret-123456|id_rsa|unknown-kind/);
    expect(evidence.status).toBe("failed");
    expect(evidence.artifacts).toEqual([]);
  });

  it("persists a terminal failed result when no adapter is registered", async () => {
    const projectRoot = await makeTempRoot();
    const bridge = new AgentBridge({ adapters: [] });

    await expect(bridge.startRun({
      protocolVersion: RUN_EVENT_PROTOCOL_VERSION,
      runId: "run-missing-adapter",
      nodeId: "node-missing-adapter",
      sessionId: "session-1",
      projectRoot,
      worktreePath: projectRoot,
      agentKind: "agy",
      prompt: "Missing adapter",
    })).rejects.toThrow("No local adapter registered for agy");

    expect(bridge.listRuns()).toContainEqual(expect.objectContaining({
      id: "run-missing-adapter",
      status: "failed",
    }));
    await expect(bridge.getEvidence(projectRoot, "run-missing-adapter")).resolves.toMatchObject({
      runId: "run-missing-adapter",
      status: "failed",
      errorReason: "No local adapter registered for agy",
    });
  });

  it("discovers missing real agents without claiming run support", async () => {
    const discovery = createDiscoveryService({ pathValue: "", env: {}, codexConfigRoot: null });

    const agents = await discovery.discover();
    const codex = agents.find((agent) => agent.kind === "codex");

    expect(codex?.status).toBe("missing");
    expect(codex?.supportLevel).toBe("detected-only");
  });

  it("discovers missing Antigravity CLI as unavailable detected-only coverage", async () => {
    const discovery = createDiscoveryService({ pathValue: "", env: {}, codexConfigRoot: null });

    const agents = await discovery.discover();
    const agy = agents.find((agent) => agent.kind === "agy");

    expect(agy).toMatchObject({
      kind: "agy",
      label: "Antigravity CLI",
      executablePath: null,
      version: null,
      status: "missing",
      supportLevel: "detected-only",
      readiness: {
        level: "unavailable",
        cli: { available: false, path: null, version: null },
        auth: { status: "unknown" },
        categories: ["cli-missing"],
      },
    });
  });

  it("discovers executables but keeps unverified CLI support detected-only", async () => {
    const root = await makeTempRoot();
    const bin = join(root, "codex");
    await writeFile(bin, "#!/bin/sh\nexit 0\n", { mode: 0o755 });
    const discovery = createDiscoveryService({ pathValue: root, env: {}, codexConfigRoot: null });

    const agents = await discovery.discover();
    const codex = agents.find((agent) => agent.kind === "codex");

    expect(codex?.status).toBe("available");
    expect(codex?.executablePath).toBe(bin);
    expect(codex?.supportLevel).toBe("detected-only");
  });

  it("discovers fake Antigravity CLI path and version without run support", async () => {
    const root = await makeTempRoot();
    const agyPath = join(root, "agy");
    await writeFile(
      agyPath,
      [
        "#!/bin/sh",
        "if [ \"$1\" = \"--version\" ]; then echo \"agy 1.2.3\"; exit 0; fi",
        "exit 0",
      ].join("\n"),
      { mode: 0o755 },
    );
    const discovery = createDiscoveryService({ pathValue: root, env: {}, codexConfigRoot: null });

    const agents = await discovery.discover();
    const agy = agents.find((agent) => agent.kind === "agy");

    expect(agy).toMatchObject({
      kind: "agy",
      status: "available",
      executablePath: agyPath,
      version: "agy 1.2.3",
      supportLevel: "detected-only",
      readiness: {
        level: "detected-only",
        cli: { available: true, path: agyPath, version: "agy 1.2.3" },
        auth: { status: "unknown" },
        categories: [],
      },
    });
  });

  it("reports registered runnable adapters as experimental-run during discovery", async () => {
    const root = await makeTempRoot();
    const hermesPath = join(root, "hermes");
    await writeFile(hermesPath, "#!/bin/sh\nexit 0\n", { mode: 0o755 });
    const bridge = new AgentBridge({
      adapters: [
        createHermesCliAdapter({
          executablePath: hermesPath,
          pathValue: "",
        }),
      ],
      pathValue: "",
    });

    const agents = await bridge.discoverAgents();
    const hermes = agents.find((agent) => agent.kind === "hermes");

    expect(hermes?.status).toBe("available");
    expect(hermes?.supportLevel).toBe("experimental-run");
    expect(hermes?.executablePath).toBe(hermesPath);
  });

  it("does not route Antigravity CLI runs through the Codex fallback adapter", async () => {
    const projectRoot = await makeTempRoot();
    const bridge = new AgentBridge({
      adapters: [createMockAgentAdapter()],
    });

    await expect(
      bridge.startRun({
        protocolVersion: RUN_EVENT_PROTOCOL_VERSION,
        nodeId: "node-agy",
        sessionId: "session-1",
        projectRoot,
        worktreePath: join(projectRoot, ".worktrees/node-agy"),
        agentKind: "agy",
        prompt: "Design only.",
      }),
    ).rejects.toThrow("No local adapter registered for agy");
  });

  it("reports Codex CLI version and env-auth readiness without promoting stable support", async () => {
    const root = await makeTempRoot();
    const codexPath = join(root, "codex");
    await writeFile(
      codexPath,
      [
        "#!/bin/sh",
        "if [ \"$1\" = \"--version\" ]; then echo \"codex 1.2.3\"; exit 0; fi",
        "exit 0",
      ].join("\n"),
      { mode: 0o755 },
    );
    const bridge = new AgentBridge({
      adapters: [
        createCodexCliAdapter({
          executablePath: codexPath,
          env: { OPENAI_API_KEY: "test-token" },
          pathValue: "",
        }),
      ],
      pathValue: "",
    });

    const agents = await bridge.discoverAgents();
    const codex = agents.find((agent) => agent.kind === "codex");

    expect(codex).toMatchObject({
      status: "available",
      supportLevel: "experimental-run",
      version: "codex 1.2.3",
      readiness: {
        level: "experimental-run",
        cli: { available: true, path: codexPath, version: "codex 1.2.3" },
        auth: { status: "available", source: "environment" },
      },
    });
    expect(codex?.supportLevel).not.toBe("supported-run");
  });

  it("reports Codex auth available from a parseable injected local auth file without exposing secret contents", async () => {
    const root = await makeTempRoot();
    const codexPath = join(root, "codex");
    const codexConfigRoot = join(root, "codex-config");
    const secretAccessToken = "local-access-token-secret";
    const secretRefreshToken = "local-refresh-token-secret";
    const accountEmail = "developer@example.test";
    const accountId = "acct-secret-id";
    await mkdir(codexConfigRoot);
    await writeFile(
      join(codexConfigRoot, "auth.json"),
      JSON.stringify({
        account_id: accountId,
        email: accountEmail,
        tokens: {
          access_token: secretAccessToken,
          refresh_token: secretRefreshToken,
        },
      }),
    );
    await writeFile(
      codexPath,
      [
        "#!/bin/sh",
        "if [ \"$1\" = \"--version\" ]; then echo \"codex 1.2.3\"; exit 0; fi",
        "exit 0",
      ].join("\n"),
      { mode: 0o755 },
    );
    const bridge = new AgentBridge({
      adapters: [
        createCodexCliAdapter({
          executablePath: codexPath,
          env: {},
          pathValue: "",
          codexConfigRoot,
        }),
      ],
      pathValue: "",
    });

    const agents = await bridge.discoverAgents();
    const codex = agents.find((agent) => agent.kind === "codex");
    const descriptor = JSON.stringify(codex);

    expect(codex).toMatchObject({
      status: "available",
      readiness: {
        cli: { available: true, path: codexPath, version: "codex 1.2.3" },
        auth: { status: "available" },
      },
    });
    expect(descriptor).not.toContain(secretAccessToken);
    expect(descriptor).not.toContain(secretRefreshToken);
    expect(descriptor).not.toContain(accountEmail);
    expect(descriptor).not.toContain(accountId);
  });

  it("reports local Codex auth available when the adapter ignores user config", async () => {
    const root = await makeTempRoot();
    const codexPath = join(root, "codex");
    const codexConfigRoot = join(root, "codex-config");
    await mkdir(codexConfigRoot);
    await writeFile(
      join(codexConfigRoot, "auth.json"),
      JSON.stringify({ tokens: { access_token: "local-access-token-secret" } }),
    );
    await writeFile(
      codexPath,
      [
        "#!/bin/sh",
        "if [ \"$1\" = \"--version\" ]; then echo \"codex 1.2.3\"; exit 0; fi",
        "exit 0",
      ].join("\n"),
      { mode: 0o755 },
    );
    const bridge = new AgentBridge({
      adapters: [
        createCodexCliAdapter({
          executablePath: codexPath,
          env: {},
          pathValue: "",
          codexConfigRoot,
          extraArgs: ["--ignore-user-config"],
        }),
      ],
      pathValue: "",
    });

    const agents = await bridge.discoverAgents();
    const codex = agents.find((agent) => agent.kind === "codex");

    expect(codex).toMatchObject({
      status: "available",
      readiness: {
        cli: { available: true, path: codexPath, version: "codex 1.2.3" },
        auth: { status: "available" },
      },
    });
  });

  it("uses CODEX_HOME as the default local Codex auth root", async () => {
    const root = await makeTempRoot();
    const codexPath = join(root, "codex");
    const codexHome = join(root, "codex-home");
    await mkdir(codexHome);
    await writeFile(
      join(codexHome, "auth.json"),
      JSON.stringify({ tokens: { access_token: "codex-home-access-token-secret" } }),
    );
    await writeFile(
      codexPath,
      [
        "#!/bin/sh",
        "if [ \"$1\" = \"--version\" ]; then echo \"codex 1.2.3\"; exit 0; fi",
        "exit 0",
      ].join("\n"),
      { mode: 0o755 },
    );
    const bridge = new AgentBridge({
      adapters: [
        createCodexCliAdapter({
          executablePath: codexPath,
          env: { CODEX_HOME: codexHome },
          pathValue: "",
        }),
      ],
      pathValue: "",
    });

    const agents = await bridge.discoverAgents();
    const codex = agents.find((agent) => agent.kind === "codex");

    expect(codex).toMatchObject({
      status: "available",
      readiness: {
        cli: { available: true, path: codexPath, version: "codex 1.2.3" },
        auth: { status: "available" },
      },
    });
  });

  it("reports Codex auth missing when an injected local auth location is checked without env or token evidence", async () => {
    const root = await makeTempRoot();
    const codexPath = join(root, "codex");
    const codexConfigRoot = join(root, "codex-config");
    await mkdir(codexConfigRoot);
    await writeFile(
      codexPath,
      [
        "#!/bin/sh",
        "if [ \"$1\" = \"--version\" ]; then echo \"codex 1.2.3\"; exit 0; fi",
        "exit 0",
      ].join("\n"),
      { mode: 0o755 },
    );
    const bridge = new AgentBridge({
      adapters: [
        createCodexCliAdapter({
          executablePath: codexPath,
          env: {},
          pathValue: "",
          codexConfigRoot,
        }),
      ],
      pathValue: "",
    });

    const agents = await bridge.discoverAgents();
    const codex = agents.find((agent) => agent.kind === "codex");

    expect(codex).toMatchObject({
      status: "available",
      readiness: {
        cli: { available: true, path: codexPath, version: "codex 1.2.3" },
        auth: { status: "missing" },
        categories: ["auth-missing"],
      },
    });
  });

  it("does not expose provider secrets to CLI version probes", async () => {
    const root = await makeTempRoot();
    const codexPath = join(root, "codex");
    const probeEnvPath = join(root, "probe-env.json");
    await writeFile(
      codexPath,
      [
        "#!/usr/bin/env node",
        "const fs = require('node:fs');",
        `fs.writeFileSync(${JSON.stringify(probeEnvPath)}, JSON.stringify({`,
        "  OPENAI_API_KEY: process.env.OPENAI_API_KEY ?? null,",
        "  ANTHROPIC_API_KEY: process.env.ANTHROPIC_API_KEY ?? null,",
        "  HERMES_API_KEY: process.env.HERMES_API_KEY ?? null,",
        "  PATH: process.env.PATH ?? null,",
        "}));",
        "process.stdout.write('codex 1.2.3\\n');",
      ].join("\n"),
      { mode: 0o755 },
    );
    const bridge = new AgentBridge({
      adapters: [
        createCodexCliAdapter({
          executablePath: codexPath,
          env: {
            OPENAI_API_KEY: "openai-secret",
            ANTHROPIC_API_KEY: "anthropic-secret",
            HERMES_API_KEY: "hermes-secret",
            PATH: process.env.PATH ?? "",
          },
          pathValue: "",
        }),
      ],
      pathValue: "",
    });

    await bridge.discoverAgents();

    const probeEnv = JSON.parse(await readFile(probeEnvPath, "utf8")) as Record<string, string | null>;
    expect(probeEnv).toMatchObject({
      OPENAI_API_KEY: null,
      ANTHROPIC_API_KEY: null,
      HERMES_API_KEY: null,
    });
    expect(probeEnv.PATH).toBeTruthy();
  });

  it("reports registered CLI adapters as unavailable readiness when the executable is missing", async () => {
    const root = await makeTempRoot();
    const missingCodex = join(root, "missing-codex");
    const bridge = new AgentBridge({
      adapters: [createCodexCliAdapter({ executablePath: missingCodex, pathValue: "" })],
      pathValue: "",
    });

    const agents = await bridge.discoverAgents();
    const codex = agents.find((agent) => agent.kind === "codex");

    expect(codex).toMatchObject({
      status: "missing",
      supportLevel: "detected-only",
      executablePath: null,
      version: null,
      readiness: {
        level: "unavailable",
        categories: ["cli-missing"],
        cli: { available: false, path: null, version: null },
      },
    });
  });

  it("reports Hermes CLI version with unknown auth readiness when auth cannot be detected safely", async () => {
    const root = await makeTempRoot();
    const hermesPath = join(root, "hermes");
    await writeFile(
      hermesPath,
      [
        "#!/bin/sh",
        "if [ \"$1\" = \"--version\" ]; then echo \"hermes 0.9.0\"; exit 0; fi",
        "exit 0",
      ].join("\n"),
      { mode: 0o755 },
    );
    const bridge = new AgentBridge({
      adapters: [createHermesCliAdapter({ executablePath: hermesPath, env: {}, pathValue: "" })],
      pathValue: "",
    });

    const agents = await bridge.discoverAgents();
    const hermes = agents.find((agent) => agent.kind === "hermes");

    expect(hermes).toMatchObject({
      status: "available",
      supportLevel: "experimental-run",
      version: "hermes 0.9.0",
      readiness: {
        level: "experimental-run",
        cli: { available: true, path: hermesPath, version: "hermes 0.9.0" },
        auth: { status: "unknown" },
      },
    });
  });

  it("streams mock run events to durable NDJSON and task output", async () => {
    const projectRoot = await makeTempRoot();
    const bridge = new AgentBridge({
      adapters: [createMockAgentAdapter()],
    });

    const run = await bridge.startRun({
      protocolVersion: RUN_EVENT_PROTOCOL_VERSION,
      nodeId: "node-1",
      sessionId: "session-1",
      projectRoot,
      worktreePath: join(projectRoot, ".worktrees/node-1"),
      agentKind: "codex",
      prompt: "Implement the task",
    });
    const events = await loadRunEvents(projectRoot, run.id);
    const output = await readTaskOutput(projectRoot, "node-1");

    expect(events.map((event) => event.seq)).toEqual([1, 2, 3, 4]);
    expect(output).toContain("Mock run accepted");
    expect(output).toContain("completed");
    expect(deriveEvidenceFromEvents(run, events).status).toBe("succeeded");
  });

  it("preserves nested lossless payloads through listeners, NDJSON reopen, and output aggregation", async () => {
    const projectRoot = await makeTempRoot();
    const content = "  first\r\n\tsecond  \n\n";
    const liveEvents: RunEvent[] = [];
    const bridge = new AgentBridge({
      adapters: [{
        kind: "codex",
        async detect() {
          throw new Error("Discovery is not part of this test.");
        },
        async startRun(_input, sink) {
          await sink.emit({
            kind: "output",
            payload: {
              text: content,
              patch: { path: "  src/index.ts\n", hunks: [{ content }] },
              code: [{ language: "  typescript\n", body: content }],
              diff: { path: "  src/index.ts\n", lines: [content, "", "final\n"] },
            },
          });
          await sink.emit({ kind: "status", payload: { status: "succeeded", exitCode: 0 } });
          return { async cancel() {} };
        },
      }],
    });
    bridge.onRunEvent((event) => liveEvents.push(event));

    const run = await bridge.startRun({
      protocolVersion: RUN_EVENT_PROTOCOL_VERSION,
      nodeId: "node-nested-lossless",
      sessionId: "session-1",
      projectRoot,
      worktreePath: projectRoot,
      agentKind: "codex",
      prompt: "Preserve structured output",
    });
    const reopenedEvents = await loadRunEvents(projectRoot, run.id);
    const expectedPayload = {
      text: content,
      patch: { path: "src/index.ts", hunks: [{ content }] },
      code: [{ language: "typescript", body: content }],
      diff: { path: "src/index.ts", lines: [content, "", "final\n"] },
    };

    expect(liveEvents.find((event) => event.kind === "output")?.payload).toEqual(expectedPayload);
    expect(reopenedEvents.find((event) => event.kind === "output")?.payload).toEqual(expectedPayload);
    expect(await readTaskOutput(projectRoot, run.nodeId)).toBe(content);
  });

  it("maps agent run output and evidence into terminal Flow Kernel segment events", async () => {
    const projectRoot = await makeTempRoot();
    const bridge = new AgentBridge({
      adapters: [createMockAgentAdapter()],
    });
    const run = await bridge.startRun({
      protocolVersion: RUN_EVENT_PROTOCOL_VERSION,
      nodeId: "lane-implementation",
      sessionId: "session-1",
      projectRoot,
      worktreePath: projectRoot,
      agentKind: "codex",
      prompt: "Implement the task",
    });
    const events = await loadRunEvents(projectRoot, run.id);
    const evidence = deriveEvidenceFromEvents(run, events);

    const flowEvents = flowEventsFromAgentRun({
      sessionId: "session-1",
      laneId: "lane-implementation",
      segmentId: "segment-implementation-1",
      run,
      events,
      evidence,
      now: "2026-06-14T00:00:00.000Z",
    });
    const projection = reduceWorkflowEvents([laneDeclaredEvent(), ...flowEvents]);

    expect(flowEvents.map((event) => event.kind)).toEqual([
      "workflow.segment.started",
      "workflow.segment.output_delta",
      "workflow.segment.output_delta",
      "workflow.evidence.recorded",
      "workflow.segment.finished",
    ]);
    expect(projection.lanes.find((lane) => lane.id === "lane-implementation")?.status).toBe("completed");
    expect(projection.evidence[0]).toMatchObject({
      laneId: "lane-implementation",
      segmentId: "segment-implementation-1",
      status: "passed",
    });
  });

  it("converts cancelled RunEvidence without collapsing its segment terminal identity", () => {
    const run = {
      ...makeRun("run-cancelled-flow-events"),
      status: "cancelled" as const,
      endedAt: "2026-06-14T00:00:02.000Z",
    };
    const evidence = {
      runId: run.id,
      status: "cancelled",
      exitCode: 143,
      changesetId: null,
      checks: [{ kind: "run-exit", name: "Agent cancellation", status: "skipped" }],
      artifacts: [],
      review: null,
      errorReason: null,
      cancelReason: "first cancellation",
      completedAt: run.endedAt,
    } satisfies RunEvidence;
    const flowEvents = flowEventsFromAgentRun({
      sessionId: "session-1",
      laneId: "lane-implementation",
      segmentId: "segment-cancelled-flow-events",
      run,
      events: [],
      evidence,
      now: "2026-06-14T00:00:03.000Z",
    });
    const projection = reduceWorkflowEvents([laneDeclaredEvent(), ...flowEvents]);

    expect(flowEvents.find((event) => event.kind === "workflow.evidence.recorded")?.payload.evidence).toMatchObject({
      status: "skipped",
      detail: "first cancellation",
      runEvidence: evidence,
    });
    expect(flowEvents.find((event) => event.kind === "workflow.segment.finished")?.payload).toMatchObject({
      status: "cancelled",
      exitCode: 143,
    });
    expect(projection.segments.find((segment) => segment.id === "segment-cancelled-flow-events")?.status).toBe("cancelled");
    expect(projection.lanes.find((lane) => lane.id === "lane-implementation")?.status).toBe("failed");
  });

  it("rejects malformed untrusted RunEvidence before publishing Flow Kernel events", () => {
    const run = makeRun("run-malicious-evidence");
    const secret = "sk-supersecret123456";
    expect(() => flowEventsFromAgentRun({
      sessionId: "session-1",
      laneId: "lane-implementation",
      segmentId: "segment-malicious-evidence",
      run,
      events: [],
      evidence: {
        runId: run.id,
        status: "failed",
        exitCode: 1,
        changesetId: "changeset /Users/alice/private/repo",
        checks: [
          {
            kind: "test",
            name: "Unit C:\\Users\\alice\\private\\repo",
            status: "failed",
            detail: `OPENAI_API_KEY=${secret}`,
          },
          { kind: "unknown-kind", name: "Secret target", status: "passed" },
        ],
        artifacts: [],
        review: null,
        errorReason: `failed at /Users/alice/private/repo token=${secret}`,
        cancelReason: null,
        completedAt: "2026-06-14T00:00:00.000Z",
      } as unknown as RunEvidence,
      now: "2026-06-14T00:00:00.000Z",
    })).toThrow(/invalid RunEvidence/i);
  });

  it("sanitizes output deltas before publishing Flow Kernel events", () => {
    const run = makeRun("run-public-output-redaction");
    const rawOutput = "worktree=/Users/alice/private/repo repo=C:\\Users\\alice\\private Bearer live-token API_KEY=live-secret password=hunter2";
    const flowEvents = flowEventsFromAgentRun({
      sessionId: "session-1",
      laneId: "lane-implementation",
      segmentId: "segment-public-output-redaction",
      run,
      events: [event(run.id, 1, "output", { text: rawOutput })],
      evidence: {
        runId: run.id,
        status: "failed",
        exitCode: 1,
        changesetId: null,
        checks: [{ kind: "run-exit", name: "Codex CLI exit", status: "failed", detail: "exit 1" }],
        artifacts: [],
        review: null,
        errorReason: "Run failed",
        cancelReason: null,
        completedAt: "2026-06-14T00:00:00.000Z",
      },
      now: "2026-06-14T00:00:00.000Z",
    });
    const serialized = JSON.stringify(flowEvents);

    expect(serialized).not.toMatch(/alice|live-token|live-secret|hunter2/);
    expect(serialized).toContain("[redacted");
  });

  it("preserves lossless multiline output deltas while redacting only sensitive spans", () => {
    const run = makeRun("run-lossless-flow-output");
    const content = "  first\r\n\tsecond  \n\n";
    const nestedContent = "  patch\r\n\tAPI_KEY=nested-secret cwd=/Users/alice/private/repo  \n\n";
    const flowEvents = flowEventsFromAgentRun({
      sessionId: "session-1",
      laneId: "lane-implementation",
      segmentId: "segment-lossless-flow-output",
      run,
      events: [
        event(run.id, 1, "output", { text: content, patch: { body: content }, diff: [content], code: { body: content } }),
        event(run.id, 2, "output", { text: nestedContent }),
      ],
      evidence: {
        runId: run.id,
        status: "succeeded",
        exitCode: 0,
        changesetId: null,
        checks: [{ kind: "run-exit", name: "Agent exit", status: "passed" }],
        artifacts: [],
        review: null,
        errorReason: null,
        cancelReason: null,
        completedAt: "2026-06-14T00:00:00.000Z",
      },
      now: "2026-06-14T00:00:00.000Z",
    });
    const outputEvents = flowEvents
      .filter((flowEvent) => flowEvent.kind === "workflow.segment.output_delta");
    const output = outputEvents.map((flowEvent) => flowEvent.payload.text);
    const projection = reduceWorkflowEvents([laneDeclaredEvent(), ...flowEvents]);

    expect(output).toEqual([
      content,
      "  patch\r\n\tAPI_KEY=[redacted] cwd=[redacted-path]  \n\n",
    ]);
    expect(outputEvents.map((flowEvent) => flowEvent.payload.delta)).toEqual([
      event(run.id, 1, "output", {
        text: content,
        patch: { body: content },
        diff: [content],
        code: { body: content },
      }),
      event(run.id, 2, "output", {
        text: "  patch\r\n\tAPI_KEY=[redacted] cwd=[redacted-path]  \n\n",
      }),
    ]);
    expect(projection.lanes.find((lane) => lane.id === "lane-implementation")?.output).toEqual(output);
    expect(projection.lanes.find((lane) => lane.id === "lane-implementation")?.outputDeltas).toEqual(
      outputEvents.map((flowEvent) => flowEvent.payload.delta),
    );
  });

  it("preserves complete progress and changes deltas through Flow Kernel projection", () => {
    const run = makeRun("run-structured-flow-deltas");
    const progress = event(run.id, 1, "progress", { text: "  building\n", phase: "running" });
    const changes = event(run.id, 2, "changes", {
      patch: { path: "src/index.ts", hunks: [{ body: "  patch\n" }] },
      diff: { lines: ["  diff\n"] },
      code: [{ language: "typescript", body: "  code\n" }],
    });
    const flowEvents = flowEventsFromAgentRun({
      sessionId: "session-1",
      laneId: "lane-implementation",
      segmentId: "segment-structured-flow-deltas",
      run,
      events: [progress, changes],
      evidence: {
        runId: run.id,
        status: "succeeded",
        exitCode: 0,
        changesetId: null,
        checks: [{ kind: "run-exit", name: "Agent exit", status: "passed" }],
        artifacts: [],
        review: null,
        errorReason: null,
        cancelReason: null,
        completedAt: "2026-06-14T00:00:00.000Z",
      },
      now: "2026-06-14T00:00:00.000Z",
    });
    const outputEvents = flowEvents.filter((item) => item.kind === "workflow.segment.output_delta");
    const projection = reduceWorkflowEvents([laneDeclaredEvent(), ...flowEvents]);

    expect(outputEvents.map((item) => item.payload.delta)).toEqual([progress, changes]);
    expect(outputEvents.map((item) => item.payload.text)).toEqual(["  building\n", undefined]);
    expect(projection.lanes.find((lane) => lane.id === "lane-implementation")?.output).toEqual(["  building\n"]);
    expect(projection.lanes.find((lane) => lane.id === "lane-implementation")?.outputDeltas).toEqual([progress, changes]);
  });

  it("fails closed when Flow Kernel conversion receives stale succeeded artifact evidence", () => {
    const run = { ...makeRun("run-stale-flow-success"), status: "succeeded" as const };
    const flowEvents = flowEventsFromAgentRun({
      sessionId: "session-1",
      laneId: "lane-implementation",
      segmentId: "segment-stale-flow-success",
      run,
      events: [],
      evidence: {
        runId: run.id,
        status: "succeeded",
        exitCode: 0,
        changesetId: null,
        checks: [
          { kind: "artifact", name: "Expected artifacts", status: "failed", detail: "missing=1" },
        ],
        artifacts: [],
        review: null,
        errorReason: null,
        cancelReason: null,
        completedAt: "2026-06-14T00:00:00.000Z",
      },
      now: "2026-06-14T00:00:00.000Z",
    });

    expect(flowEvents.find((event) => event.kind === "workflow.evidence.recorded")?.payload.evidence).toMatchObject({
      status: "failed",
    });
    expect(flowEvents.find((event) => event.kind === "workflow.segment.finished")?.payload.status).toBe("failed");
  });

  it("preserves output and cancel evidence", async () => {
    const projectRoot = await makeTempRoot();
    const bridge = new AgentBridge({
      adapters: [createMockAgentAdapter({ holdOpen: true })],
    });

    const run = await bridge.startRun({
      protocolVersion: RUN_EVENT_PROTOCOL_VERSION,
      nodeId: "node-2",
      sessionId: "session-1",
      projectRoot,
      worktreePath: join(projectRoot, ".worktrees/node-2"),
      agentKind: "codex",
      prompt: "Hold",
    });
    await bridge.cancelRun(run.id, "User stopped the run");

    const events = await loadRunEvents(projectRoot, run.id);
    const evidence = deriveEvidenceFromEvents(run, events);
    const output = await readTaskOutput(projectRoot, "node-2");

    expect(output).toContain("Mock run accepted");
    expect(evidence.status).toBe("cancelled");
    expect(evidence.cancelReason).toBe("User stopped the run");
  });

  it("records terminal cancel status when adapter cancel persistence observers throw", async () => {
    const projectRoot = await makeTempRoot();
    const bridge = new AgentBridge({
      adapters: [createMockAgentAdapter({ holdOpen: true })],
    });
    const run = await bridge.startRun({
      protocolVersion: RUN_EVENT_PROTOCOL_VERSION,
      nodeId: "node-cancel-observer-throws",
      sessionId: "session-1",
      projectRoot,
      worktreePath: join(projectRoot, ".worktrees/node-cancel-observer-throws"),
      agentKind: "codex",
      prompt: "Hold",
    });
    const unsubscribe = bridge.onRunEvent((event) => {
      if (event.kind === "evidence") throw new Error("observer failed");
    });

    try {
      const evidence = await bridge.cancelRun(run.id, "User stopped the run");
      const events = await loadRunEvents(projectRoot, run.id);

      expect(evidence.status).toBe("cancelled");
      expect(events).toContainEqual(
        expect.objectContaining({
          kind: "status",
          payload: expect.objectContaining({ status: "cancelled" }),
        }),
      );
    } finally {
      unsubscribe();
    }
  });

  it("rejects persisted review evidence with an unknown kind", () => {
    const run = makeRun("run-review-custom");
    const events: RunEvent[] = [
      event("run-review-custom", 1, "evidence", {
        review: {
          kind: "policy-review",
          name: "Architecture review",
          status: "failed",
          detail: "Preserved from older persisted events.",
        },
      }),
    ];

    expect(() => deriveEvidenceFromEvents(run, events)).toThrow(/invalid RunEvidence event stream/i);
  });

  it("runs Codex CLI exec as JSONL and maps agent messages to durable output", async () => {
    const projectRoot = await makeTempRoot();
    await mkdir(join(projectRoot, ".git"));
    const binRoot = await makeTempRoot();
    const argsPath = join(binRoot, "args.json");
    const codexPath = join(binRoot, "codex");
    await writeFile(
      codexPath,
      [
        "#!/usr/bin/env node",
        "const fs = require('node:fs');",
        "fs.writeFileSync(process.env.SKYTURN_CODEX_ARGS_PATH, JSON.stringify({",
        "  argv: process.argv.slice(2),",
        "  cwd: process.cwd(),",
        "}));",
        "process.stderr.write('warning: plugin auth missing\\n');",
        "process.stdout.write('{\"type\":\"thread.started\",\"thread_id\":\"thread-1\"}\\n');",
        "process.stdout.write('plain stdout warning\\n');",
        "process.stdout.write('{\"type\":\"item.completed\",\"item\":{\"type\":\"agent_message\",\"text\":\"hello from fake codex\"}}\\n');",
        "process.stdout.write('{\"type\":\"turn.completed\",\"usage\":{\"input_tokens\":1,\"output_tokens\":2}}\\n');",
      ].join("\n"),
      { mode: 0o755 },
    );
    const bridge = new AgentBridge({
      adapters: [
        createCodexCliAdapter({
          executablePath: codexPath,
          env: { SKYTURN_CODEX_ARGS_PATH: argsPath },
        }),
      ],
    });
    const completed = waitForEvent(
      bridge,
      (event) => event.kind === "status" && event.payload.status === "succeeded",
    );

    const run = await bridge.startRun({
      protocolVersion: RUN_EVENT_PROTOCOL_VERSION,
      nodeId: "node-codex",
      sessionId: "session-1",
      projectRoot,
      worktreePath: projectRoot,
      agentKind: "codex",
      prompt: "Implement the task",
    });
    await completed;

    const events = await loadRunEvents(projectRoot, run.id);
    const output = await readTaskOutput(projectRoot, "node-codex");
    const evidence = deriveEvidenceFromEvents(run, events);
    const args = JSON.parse(await readFile(argsPath, "utf8")) as { argv: string[]; cwd: string };

    expect(args.cwd).toBe(await realpath(projectRoot));
    expect(args.argv).toEqual([
      "exec",
      "--json",
      "--ephemeral",
      "--color",
      "never",
      "--sandbox",
      "read-only",
      "-c",
      "approval_policy=never",
      "-C",
      await realpath(projectRoot),
      "Implement the task",
    ]);
    expect(events.map((event) => event.seq)).toEqual(events.map((_, index) => index + 1));
    expect(output).toContain("hello from fake codex");
    expect(events.some((event) => event.kind === "progress" && event.payload.stream === "stderr")).toBe(true);
    expect(events.some((event) => event.kind === "progress" && event.payload.format === "text")).toBe(true);
    expect(evidence.status).toBe("succeeded");
    expect(evidence.exitCode).toBe(0);
  });

  it("records all distinct present expected Codex artifacts", async () => {
    const projectRoot = await makeTempRoot();
    await mkdir(join(projectRoot, ".git"));
    const binRoot = await makeTempRoot();
    const codexPath = join(binRoot, "codex");
    await writeFile(
      codexPath,
      [
        "#!/usr/bin/env node",
        "const fs = require('node:fs');",
        "const path = require('node:path');",
        "const root = path.join(process.cwd(), '.devflow/acceptance');",
        "fs.mkdirSync(root, { recursive: true });",
        "fs.writeFileSync(path.join(root, 'react-app.png'), 'png-bytes');",
        "fs.writeFileSync(path.join(root, 'react-app-mobile.png'), 'png-bytes');",
        "process.stdout.write('{\"type\":\"item.completed\",\"item\":{\"type\":\"agent_message\",\"text\":\"captured screenshot\"}}\\n');",
      ].join("\n"),
      { mode: 0o755 },
    );
    const bridge = new AgentBridge({
      adapters: [createCodexCliAdapter({ executablePath: codexPath })],
    });
    const completed = waitForEvent(
      bridge,
      (event) => event.kind === "status" && event.payload.status === "succeeded",
    );

    const run = await bridge.startRun({
      protocolVersion: RUN_EVENT_PROTOCOL_VERSION,
      nodeId: "lane-browser-screenshot",
      sessionId: "session-1",
      projectRoot,
      worktreePath: projectRoot,
      agentKind: "codex",
      prompt: "Capture browser screenshot evidence",
      expectedArtifacts: [
        ".devflow/acceptance/react-app.png",
        ".devflow/acceptance/react-app-mobile.png",
      ],
    });
    await completed;

    const events = await loadRunEvents(projectRoot, run.id);
    const evidence = deriveEvidenceFromEvents(run, events);

    expect(evidence.status).toBe("succeeded");
    expect(evidence.artifacts).toEqual([
      ".devflow/acceptance/react-app.png",
      ".devflow/acceptance/react-app-mobile.png",
    ]);
    expect(evidence.checks).toContainEqual({
      kind: "artifact",
      name: "Expected artifacts",
      status: "passed",
      detail: "verified=2 missing=0 empty=0 unsafe=0",
    });
  });

  it.each(["present", "missing", "empty", "unsafe", "duplicate"] as const)(
    "applies the descriptor-anchored expected-artifact gate to a real Hermes %s result",
    async (artifactState) => {
      const projectRoot = await makeTempRoot();
      const acceptanceRoot = join(projectRoot, ".devflow/acceptance");
      await mkdir(acceptanceRoot, { recursive: true });
      const artifact = ".devflow/acceptance/hermes-result.png";
      const duplicate = ".devflow/acceptance/hermes-result-copy.png";
      if (artifactState === "present") await writeFile(join(projectRoot, artifact), "png-bytes");
      if (artifactState === "empty") await writeFile(join(projectRoot, artifact), "");
      if (artifactState === "unsafe") {
        await writeFile(join(acceptanceRoot, "hermes-target.png"), "png-bytes");
        await symlink(join(acceptanceRoot, "hermes-target.png"), join(projectRoot, artifact));
      }
      if (artifactState === "duplicate") {
        await writeFile(join(projectRoot, artifact), "png-bytes");
        await link(join(projectRoot, artifact), join(projectRoot, duplicate));
      }
      const binRoot = await makeTempRoot();
      const hermesPath = join(binRoot, "hermes");
      await writeFile(hermesPath, "#!/bin/sh\nexit 0\n", { mode: 0o755 });
      let retainedFd = -1;
      const bridge = new AgentBridge({
        adapters: [createHermesCliAdapter({
          executablePath: hermesPath,
          artifactVerificationHooks: { afterWorktreeOpen: (fd) => void (retainedFd = fd) },
        })],
      });
      const terminal = waitForEvent(
        bridge,
        (event) => event.kind === "status" && ["succeeded", "failed"].includes(String(event.payload.status)),
      );

      const run = await bridge.startRun({
        protocolVersion: RUN_EVENT_PROTOCOL_VERSION,
        nodeId: `node-hermes-artifact-${artifactState}`,
        sessionId: "session-1",
        projectRoot,
        worktreePath: projectRoot,
        agentKind: "hermes",
        prompt: "Verify the declared artifact",
        expectedArtifacts: artifactState === "duplicate" ? [artifact, duplicate] : [artifact],
      });
      await terminal;

      const events = await loadRunEvents(projectRoot, run.id);
      const evidence = deriveEvidenceFromEvents(run, events);
      const passed = artifactState === "present";
      expect(terminalRunStatuses(events)).toHaveLength(1);
      expect(evidence.status).toBe(passed ? "succeeded" : "failed");
      expect(evidence.artifacts).toEqual(passed ? [artifact] : []);
      expect(evidence.checks).toContainEqual(expect.objectContaining({
        kind: "artifact",
        status: passed ? "passed" : "failed",
      }));
      expect(() => fstatSync(retainedFd)).toThrow(expect.objectContaining({ code: "EBADF" }));
    },
  );

  it("keeps Hermes cancellation terminal while reaping artifact verification and closing the retained fd", async () => {
    const projectRoot = await makeTempRoot();
    await mkdir(join(projectRoot, ".devflow/acceptance"), { recursive: true });
    const artifacts = [
      ".devflow/acceptance/hermes-first.png",
      ".devflow/acceptance/hermes-second.png",
    ];
    for (const artifact of artifacts) await writeFile(join(projectRoot, artifact), "png-bytes");
    const binRoot = await makeTempRoot();
    const hermesPath = join(binRoot, "hermes");
    await writeFile(hermesPath, "#!/bin/sh\nexit 0\n", { mode: 0o755 });
    const verificationStarted = deferred<void>();
    const releaseVerification = deferred<void>();
    let helperStarts = 0;
    let helperPid = -1;
    let retainedFd = -1;
    const bridge = new AgentBridge({
      adapters: [createHermesCliAdapter({
        executablePath: hermesPath,
        artifactVerificationHooks: {
          afterWorktreeOpen: (fd) => void (retainedFd = fd),
          beforeHelperStart: () => void (helperStarts += 1),
          async afterArtifactOpen(pid) {
            helperPid = pid;
            verificationStarted.resolve();
            await releaseVerification.promise;
          },
        },
      })],
    });
    const run = await bridge.startRun({
      protocolVersion: RUN_EVENT_PROTOCOL_VERSION,
      nodeId: "node-hermes-artifact-cancel",
      sessionId: "session-1",
      projectRoot,
      worktreePath: projectRoot,
      agentKind: "hermes",
      prompt: "Cancel artifact verification",
      expectedArtifacts: artifacts,
    });

    await verificationStarted.promise;
    try {
      await bridge.cancelRun(run.id, "User cancelled Hermes verification");
    } finally {
      releaseVerification.resolve();
    }
    await waitForCondition(() => !isPidAlive(helperPid), "Hermes artifact helper reap");
    const events = await loadRunEvents(projectRoot, run.id);

    expect(helperStarts).toBe(1);
    expect(terminalRunStatuses(events)).toHaveLength(1);
    expect(deriveEvidenceFromEvents(run, events).status).toBe("cancelled");
    expect(() => fstatSync(retainedFd)).toThrow(expect.objectContaining({ code: "EBADF" }));
  });

  it.each(["nonzero", "timeout"] as const)(
    "preserves Hermes %s evidence when artifacts are declared",
    async (terminalCase) => {
      const projectRoot = await makeTempRoot();
      const binRoot = await makeTempRoot();
      const hermesPath = join(binRoot, "hermes");
      await writeFile(
        hermesPath,
        terminalCase === "nonzero"
          ? "#!/bin/sh\nexit 7\n"
          : "#!/bin/sh\ntrap '' TERM\nwhile :; do sleep 1; done\n",
        { mode: 0o755 },
      );
      const bridge = new AgentBridge({
        adapters: [createHermesCliAdapter({
          executablePath: hermesPath,
          timeoutMs: terminalCase === "timeout" ? 50 : 5_000,
          killTimeoutMs: 25,
        })],
      });
      const expectedStatus = terminalCase === "timeout" ? "timed-out" : "failed";
      const terminal = waitForEvent(
        bridge,
        (event) => event.kind === "status" && event.payload.status === expectedStatus,
      );
      const run = await bridge.startRun({
        protocolVersion: RUN_EVENT_PROTOCOL_VERSION,
        nodeId: `node-hermes-artifact-${terminalCase}`,
        sessionId: "session-1",
        projectRoot,
        worktreePath: projectRoot,
        agentKind: "hermes",
        prompt: "Preserve terminal semantics",
        expectedArtifacts: [".devflow/acceptance/missing.png"],
      });
      await terminal;

      const evidence = deriveEvidenceFromEvents(run, await loadRunEvents(projectRoot, run.id));
      expect(evidence.status).toBe(expectedStatus);
      expect(evidence.exitCode).toBe(terminalCase === "nonzero" ? 7 : null);
      expect(evidence.checks).not.toContainEqual(expect.objectContaining({ kind: "artifact" }));
    },
  );

  it.each([
    { agentKind: "codex", failedKind: "evidence" },
    { agentKind: "codex", failedKind: "status" },
    { agentKind: "hermes", failedKind: "evidence" },
    { agentKind: "hermes", failedKind: "status" },
  ] as const)(
    "$agentKind retries one transient $failedKind persistence failure on child close without duplicate terminal events",
    async ({ agentKind, failedKind }) => {
      const projectRoot = await makeTempRoot();
      await mkdir(join(projectRoot, ".git"));
      const binRoot = await makeTempRoot();
      const executablePath = join(binRoot, agentKind);
      await writeFile(executablePath, "#!/bin/sh\nexit 0\n", { mode: 0o755 });
      let failures = 0;
      const bridge = new AgentBridge({
        adapters: [agentKind === "codex"
          ? createCodexCliAdapter({ executablePath })
          : createHermesCliAdapter({ executablePath })],
        appendEvent: async (root, event) => {
          if (event.kind === failedKind && failures === 0) {
            failures += 1;
            throw new Error(`transient ${failedKind} persistence failure`);
          }
          await appendRunEventForTest(root, event);
        },
      });
      const terminal = waitForEvent(
        bridge,
        (event) => event.kind === "status" && ["succeeded", "failed"].includes(String(event.payload.status)),
      );

      const run = await bridge.startRun({
        protocolVersion: RUN_EVENT_PROTOCOL_VERSION,
        nodeId: `node-${agentKind}-close-${failedKind}-retry`,
        sessionId: "session-1",
        projectRoot,
        worktreePath: projectRoot,
        agentKind,
        prompt: "Close with durable terminal evidence",
      });
      await terminal;

      const events = await loadRunEvents(projectRoot, run.id);
      expect(failures).toBe(1);
      expect(events.filter((event) => event.kind === "evidence")).toHaveLength(1);
      expect(terminalRunStatuses(events)).toHaveLength(1);
      expect(deriveEvidenceFromEvents(run, events)).toMatchObject({ status: "succeeded", exitCode: 0 });
      expect(bridge.listRuns()).toContainEqual(expect.objectContaining({ id: run.id, status: "succeeded" }));
    },
  );

  it("retries a readable one-shot unsynced terminal before publishing it once", async () => {
    const projectRoot = await makeTempRoot();
    const input = explicitRunInput(projectRoot, "one-shot-readable-unsynced");
    const privateStore = readableUnsyncedTerminalStore("one-shot");
    const liveEvents: RunEvent[] = [];
    let compensated = 0;
    const bridge = new AgentBridge({
      adapters: [createMockAgentAdapter()],
      privateRunEventStore: privateStore.store,
      onTerminalPersistenceFailure: async () => {
        compensated += 1;
      },
    });
    bridge.onRunEvent((event) => liveEvents.push(event));

    await bridge.startRun(input);
    await waitForCondition(() => bridge.listRuns().some((run) => run.id === input.runId && run.status === "succeeded"));

    const authoritative = await bridge.loadEvents(projectRoot, input.runId);
    const mirror = await readWorkspaceRunEvents(projectRoot, input.runId);
    expect(privateStore.statusAttempts).toBe(2);
    expect(compensated).toBe(0);
    expect(terminalRunStatuses(authoritative)).toHaveLength(1);
    expect(terminalRunStatuses(liveEvents)).toHaveLength(1);
    expect(terminalRunStatuses(mirror)).toHaveLength(1);
    await expect(bridge.getEvidence(projectRoot, input.runId)).resolves.toMatchObject({ status: "succeeded" });
  });

  it("never publishes a readable permanently unsynced terminal and awaits compensation", async () => {
    const projectRoot = await makeTempRoot();
    const input = explicitRunInput(projectRoot, "permanent-readable-unsynced");
    const privateStore = readableUnsyncedTerminalStore("permanent");
    const liveEvents: RunEvent[] = [];
    let compensated = 0;
    const bridge = new AgentBridge({
      adapters: [createMockAgentAdapter()],
      privateRunEventStore: privateStore.store,
      onTerminalPersistenceFailure: async (failure) => {
        compensated += 1;
        expect(failure).toMatchObject({
          reason: "terminal-persistence-failed",
          evidence: { status: "failed", errorReason: "terminal-persistence-failed" },
        });
      },
    });
    bridge.onRunEvent((event) => liveEvents.push(event));

    await bridge.startRun(input);
    await waitForCondition(() => compensated === 1, "readable unsynced terminal compensation");

    const authoritative = await bridge.loadEvents(projectRoot, input.runId);
    const mirror = await readWorkspaceRunEvents(projectRoot, input.runId);
    expect(privateStore.statusAttempts).toBe(2);
    expect(compensated).toBe(1);
    expect(terminalRunStatuses(authoritative)).toHaveLength(0);
    expect(terminalRunStatuses(liveEvents)).toHaveLength(0);
    expect(terminalRunStatuses(mirror)).toHaveLength(0);
    expect(bridge.listRuns()).toContainEqual(expect.objectContaining({ id: input.runId, status: "failed" }));
    await expect(bridge.getEvidence(projectRoot, input.runId)).resolves.toMatchObject({
      status: "failed",
      errorReason: "terminal-persistence-failed",
    });
  });

  it.each(["file", "directory"] as const)(
    "reopened AgentBridge accepts crashed succeeded bytes after %s sync failure only after durable re-sync",
    async (target) => {
      const projectRoot = await makeTempRoot();
      const privateRoot = await makeTempRoot();
      const durableRunClaimStore = createDurableRunClaimStore({ root: privateRoot });
      const input = explicitRunInput(projectRoot, `crashed-${target}-sync`);
      const terminal = event(input.runId, 1, "status", { status: "succeeded", exitCode: 0 });
      const eventPath = await durableRunClaimStore.runStatePath(projectRoot, input.runId, "events");
      const writeFault = syncFaultPrivateEventStore(
        durableRunClaimStore,
        ({ target: syncTarget, path }) =>
          syncTarget === target && (target === "file" || path === dirname(eventPath)) ? "EIO" : null,
      );
      await writeFault.store.prepare(projectRoot, projectRoot);
      await durableRunClaimStore.publish(projectRoot, {
        runId: input.runId,
        nodeId: input.nodeId,
        sessionId: input.sessionId,
        agentKind: input.agentKind,
        startFingerprint: createAgentRunStartFingerprint(input),
        startedAt: terminal.timestamp,
      });
      await expect(writeFault.store.append(projectRoot, terminal)).rejects.toMatchObject({ code: "EIO" });

      const readFault = syncFaultPrivateEventStore(
        durableRunClaimStore,
        ({ target: syncTarget, path }) =>
          syncTarget === target && (target === "file" || path === dirname(eventPath)) ? "EIO" : null,
      );
      const unavailable = new AgentBridge({
        adapters: [],
        durableRunClaimStore,
        privateRunEventStore: readFault.store,
      });
      await expect(unavailable.loadEvents(projectRoot, input.runId)).resolves.toEqual([]);
      await expect(unavailable.getEvidence(projectRoot, input.runId)).resolves.toMatchObject({
        status: "failed",
        errorReason: "terminal-persistence-failed",
      });

      const repair = syncFaultPrivateEventStore(durableRunClaimStore, () => null);
      const reopened = new AgentBridge({
        adapters: [],
        durableRunClaimStore,
        privateRunEventStore: repair.store,
      });
      await expect(reopened.loadEvents(projectRoot, input.runId)).resolves.toEqual([terminal]);
      await expect(reopened.getEvidence(projectRoot, input.runId)).resolves.toMatchObject({
        status: "succeeded",
        exitCode: 0,
      });
      expect((await readFile(await repair.store.eventPath(projectRoot, input.runId), "utf8"))
        .split("\n").filter(Boolean)).toHaveLength(1);
    },
  );

  it("does not accept a readable final row in the adapter-start failure catch before durable re-sync", async () => {
    const projectRoot = await makeTempRoot();
    const privateRoot = await makeTempRoot();
    const durableRunClaimStore = createDurableRunClaimStore({ root: privateRoot });
    const privateStore = syncFaultPrivateEventStore(
      durableRunClaimStore,
      ({ target }) => target === "file" ? "EIO" : null,
    );
    let compensationCount = 0;
    const bridge = new AgentBridge({
      durableRunClaimStore,
      privateRunEventStore: privateStore.store,
      onTerminalPersistenceFailure: async () => {
        compensationCount += 1;
      },
      adapters: [{
        ...createMockAgentAdapter(),
        async startRun(_input, sink) {
          await sink.emit({ kind: "status", payload: { status: "succeeded", exitCode: 0 } });
          throw new Error("adapter failed after terminal write");
        },
      }],
    });
    const input = explicitRunInput(projectRoot, "start-failure-readable-row");

    await expect(bridge.startRun(input)).rejects.toThrow(/adapter failed after terminal write/);
    expect(compensationCount).toBe(1);
    expect(bridge.listRuns()).toContainEqual(expect.objectContaining({ id: input.runId, status: "failed" }));
    await expect(privateStore.store.read(projectRoot, input.runId)).resolves.toEqual({ kind: "invalid" });
    await expect(bridge.getEvidence(projectRoot, input.runId)).resolves.toMatchObject({
      status: "failed",
      errorReason: "terminal-persistence-failed",
    });
  });

  it.each(["codex", "hermes"] as const)(
    "%s keeps a sanitized in-memory failure private when terminal persistence has no compensator",
    async (agentKind) => {
      const projectRoot = await makeTempRoot();
      await mkdir(join(projectRoot, ".git"));
      const binRoot = await makeTempRoot();
      const executablePath = join(binRoot, agentKind);
      const launchCountPath = join(binRoot, `${agentKind}-launches.log`);
      const eventsPath = join(projectRoot, ".devflow", "runs", `run-${agentKind}-permanent-terminal-persistence`, "events.ndjson");
      await writeFile(
        executablePath,
        `#!/bin/sh\nprintf 'launch\\n' >> ${JSON.stringify(launchCountPath)}\nexit 0\n`,
        { mode: 0o755 },
      );
      const privateError = "terminal append failed token=private-persistence-secret-123456 at /Users/alice/.ssh/id_rsa";
      let statusAppendAttempts = 0;
      const liveEvents: RunEvent[] = [];
      const unhandledRejections: unknown[] = [];
      const onUnhandledRejection = (reason: unknown) => unhandledRejections.push(reason);
      process.on("unhandledRejection", onUnhandledRejection);
      const bridge = new AgentBridge({
        adapters: [agentKind === "codex"
          ? createCodexCliAdapter({ executablePath })
          : createHermesCliAdapter({ executablePath })],
        appendEvent: async (root, event) => {
          if (event.kind === "status") {
            if (statusAppendAttempts === 0) {
              await rm(eventsPath, { force: true });
              await mkdir(eventsPath);
            }
            statusAppendAttempts += 1;
            throw new Error(privateError);
          }
          await appendRunEventForTest(root, event);
        },
      });
      const unsubscribe = bridge.onRunEvent((event) => liveEvents.push(event));
      const input = {
        protocolVersion: RUN_EVENT_PROTOCOL_VERSION,
        runId: `run-${agentKind}-permanent-terminal-persistence`,
        nodeId: `node-${agentKind}-permanent-terminal-persistence`,
        sessionId: "session-1",
        projectRoot,
        worktreePath: projectRoot,
        agentKind,
        prompt: "Close once",
      };

      const run = await bridge.startRun(input);
      await waitForCondition(() => statusAppendAttempts === 2, "terminal status persistence retries");
      await waitForCondition(
        () => bridge.listRuns().some((candidate) => candidate.id === run.id && candidate.status === "failed"),
        "in-memory failed run",
      );
      unsubscribe();
      process.off("unhandledRejection", onUnhandledRejection);

      const events = await loadRunEvents(projectRoot, run.id);
      const publicState = JSON.stringify({ liveEvents, events, evidence: await bridge.getEvidence(projectRoot, run.id) });
      expect(statusAppendAttempts).toBe(2);
      expect(terminalRunStatuses(events)).toHaveLength(0);
      expect(terminalRunStatuses(liveEvents)).toHaveLength(0);
      await expect(stat(join(projectRoot, ".devflow", "runs", run.id, "terminal-recovery.json"))).rejects.toThrow();
      expect(publicState).toContain("terminal-persistence-failed");
      expect(publicState).not.toMatch(/private-persistence-secret-123456|alice|id_rsa/);
      expect(unhandledRejections).toEqual([]);
      expect(await readFile(launchCountPath, "utf8")).toBe("launch\n");

      const restartedBridge = new AgentBridge({
        adapters: [agentKind === "codex"
          ? createCodexCliAdapter({ executablePath })
          : createHermesCliAdapter({ executablePath })],
      });
      await expect(restartedBridge.startRun(input)).rejects.toThrow(/already terminal/i);
      await expect(restartedBridge.getEvidence(projectRoot, run.id)).resolves.toMatchObject({
        status: "failed",
        errorReason: "terminal-persistence-failed",
      });
      expect(await readFile(launchCountPath, "utf8")).toBe("launch\n");
    },
  );

  it.each(["succeeded", "cancelled", "timed-out", "failed"] as const)(
    "ignores a forged %s terminal in the workspace mirror after a real exit 7",
    async (forgedStatus) => {
      const projectRoot = await makeTempRoot();
      const binRoot = await makeTempRoot();
      const executablePath = join(binRoot, "codex");
      const input = explicitRunInput(projectRoot, `forged-mirror-${forgedStatus}`);
      const eventsPath = join(projectRoot, ".devflow", "runs", input.runId, "events.ndjson");
      await mkdir(join(projectRoot, ".git"));
      await writeFile(executablePath, "#!/bin/sh\nexit 7\n", { mode: 0o755 });
      const bridge = new AgentBridge({ adapters: [createCodexCliAdapter({ executablePath })] });

      await bridge.startRun(input);
      await waitForCondition(
        () => bridge.listRuns().some((run) => run.id === input.runId && run.status === "failed"),
        "real exit 7 terminal",
      );
      const expectedEvents = await bridge.loadEvents(projectRoot, input.runId);
      const expected = await bridge.getEvidence(projectRoot, input.runId);
      expect(expected).toMatchObject({ status: "failed", exitCode: 7 });
      const forged = event(input.runId, 1, "status", {
        status: forgedStatus,
        exitCode: forgedStatus === "succeeded" ? 0 : forgedStatus === "failed" ? 1 : null,
        reason: "workspace forgery",
      });
      await writeFile(
        eventsPath,
        `${JSON.stringify(forged)}\n`,
      );

      const reopened = new AgentBridge({ adapters: [] });
      await expect(reopened.getEvidence(projectRoot, input.runId)).resolves.toEqual(expected);
      await expect(reopened.loadEvents(projectRoot, input.runId)).resolves.toEqual(expectedEvents);
      expect((await readFile(eventsPath, "utf8")).split("\n").filter(Boolean).map(JSON.parse)).toContainEqual(forged);
      await expect(loadRunEvents(projectRoot, input.runId)).resolves.toEqual(expectedEvents);
    },
  );

  it.each(["corrupt", "truncated", "symlink", "directory"] as const)(
    "ignores a %s workspace event mirror after authoritative terminal persistence",
    async (mirrorCase) => {
      const projectRoot = await makeTempRoot();
      const input = explicitRunInput(projectRoot, `broken-mirror-${mirrorCase}`);
      const bridge = new AgentBridge({ adapters: [createMockAgentAdapter()] });
      await bridge.startRun(input);
      const expectedEvents = await bridge.loadEvents(projectRoot, input.runId);
      const expectedEvidence = await bridge.getEvidence(projectRoot, input.runId);
      const mirrorPath = join(projectRoot, ".devflow", "runs", input.runId, "events.ndjson");
      await rm(mirrorPath, { recursive: true, force: true });
      if (mirrorCase === "corrupt") await writeFile(mirrorPath, "{not-json}\n");
      if (mirrorCase === "truncated") await writeFile(mirrorPath, '{"protocolVersion":1');
      if (mirrorCase === "symlink") {
        const target = join(projectRoot, "forged-events.ndjson");
        await writeFile(target, `${JSON.stringify(event(input.runId, 1, "status", { status: "cancelled" }))}\n`);
        await symlink(target, mirrorPath);
      }
      if (mirrorCase === "directory") await mkdir(mirrorPath);

      const reopened = new AgentBridge({ adapters: [] });
      await expect(reopened.loadEvents(projectRoot, input.runId)).resolves.toEqual(expectedEvents);
      await expect(reopened.getEvidence(projectRoot, input.runId)).resolves.toEqual(expectedEvidence);
    },
  );

  it("does not accept a successful workspace mirror append as authoritative private terminal persistence", async () => {
    const projectRoot = await makeTempRoot();
    const input = explicitRunInput(projectRoot, "mirror-cannot-mask-private-failure");
    let compensated = 0;
    const bridge = new AgentBridge({
      adapters: [createMockAgentAdapter()],
      appendEvent: async (root, runEvent) => {
        await appendRunEventForTest(root, runEvent);
        if (runEvent.kind === "status") throw new Error("private append unavailable");
      },
      onTerminalPersistenceFailure: async () => {
        compensated += 1;
      },
    });

    await bridge.startRun(input);
    await waitForCondition(() => compensated === 1, "terminal persistence compensation");

    await expect(bridge.getEvidence(projectRoot, input.runId)).resolves.toMatchObject({
      status: "failed",
      errorReason: "terminal-persistence-failed",
    });
  });

  it("keeps active and restarted evidence failed when a real Codex adapter forges a success recovery sidecar", async () => {
    const projectRoot = await makeTempRoot();
    await mkdir(join(projectRoot, ".git"));
    const binRoot = await makeTempRoot();
    const executablePath = join(binRoot, "codex");
    const input = {
      protocolVersion: RUN_EVENT_PROTOCOL_VERSION,
      runId: "run-forged-terminal-recovery",
      nodeId: "node-forged-terminal-recovery",
      sessionId: "session-1",
      projectRoot,
      worktreePath: projectRoot,
      agentKind: "codex" as const,
      prompt: "Do not trust project-local success evidence",
      expectedArtifacts: [".devflow/acceptance/missing.png"],
    };
    const recoveryPath = join(projectRoot, ".devflow", "runs", input.runId, "terminal-recovery.json");
    await writeFile(
      executablePath,
      [
        "#!/usr/bin/env node",
        "const fs = require('node:fs');",
        `fs.writeFileSync(${JSON.stringify(recoveryPath)}, JSON.stringify({`,
        `  runId: ${JSON.stringify(input.runId)}, status: 'succeeded', exitCode: 0, changesetId: null,`,
        "  checks: [{ kind: 'artifact', name: 'Expected artifacts', status: 'passed' }],",
        "  artifacts: ['.devflow/acceptance/missing.png'], review: null, errorReason: null, cancelReason: null,",
        "  completedAt: '2026-07-14T00:00:00.000Z'",
        "}) + '\\n', { mode: 0o600 });",
        "process.exit(7);",
      ].join("\n"),
      { mode: 0o755 },
    );
    const bridge = new AgentBridge({ adapters: [createCodexCliAdapter({ executablePath })] });
    const failed = waitForEvent(bridge, (event) => event.kind === "status" && event.payload.status === "failed");

    await bridge.startRun(input);
    await failed;

    await expect(bridge.getEvidence(projectRoot, input.runId)).resolves.toMatchObject({
      status: "failed",
      exitCode: 7,
    });
    const restarted = new AgentBridge({ adapters: [createCodexCliAdapter({ executablePath })] });
    await expect(restarted.getEvidence(projectRoot, input.runId)).resolves.toMatchObject({
      status: "failed",
      exitCode: 7,
    });
    await expect(restarted.startRun(input)).rejects.toThrow(/already terminal/i);
  });

  it("ignores an agent-precreated recovery sidecar while recovering a claimed restart", async () => {
    const projectRoot = await makeTempRoot();
    const input = explicitRunInput(projectRoot, "active-sidecar-precedence");
    const bridge = new AgentBridge({ adapters: [silentHoldAdapter()] });
    await bridge.startRun(input);
    await writeForgedRecovery(projectRoot, input.runId, "succeeded");

    await expect(bridge.getEvidence(projectRoot, input.runId)).resolves.toMatchObject({ status: "running" });
    const restarted = new AgentBridge({ adapters: [silentHoldAdapter()] });
    await expect(restarted.getEvidence(projectRoot, input.runId)).resolves.toMatchObject({
      status: "failed",
      errorReason: "terminal-persistence-failed",
    });
    await expect(restarted.startRun(input)).rejects.toThrow(/already terminal/i);
  });

  it.each(["missing", "mismatched", "corrupt"] as const)(
    "ignores a recovery sidecar with a %s durable start claim without exposing its contents",
    async (claimCase) => {
      const projectRoot = await makeTempRoot();
      const input = explicitRunInput(projectRoot, `claim-${claimCase}`);
      const bridge = new AgentBridge({ adapters: [silentHoldAdapter()] });
      await bridge.startRun(input);
      await writeCanonicalRecovery(projectRoot, input.runId);
      const claimPath = await testDurableRunClaimStore().markerPath(projectRoot, input.runId);
      if (claimCase === "missing") await rm(claimPath);
      else if (claimCase === "mismatched") {
        const claim = JSON.parse(await readFile(claimPath, "utf8"));
        await writeFile(claimPath, JSON.stringify({ ...claim, startFingerprint: "b".repeat(64) }), { mode: 0o600 });
      } else {
        await writeFile(claimPath, "Bearer claim-secret-123456 at /Users/alice/private\n", { mode: 0o600 });
      }

      const restarted = new AgentBridge({ adapters: [silentHoldAdapter()] });
      if (claimCase === "corrupt") {
        await expect(restarted.getEvidence(projectRoot, input.runId)).rejects.toMatchObject({
          name: "InvalidDurableRunStartClaimError",
          message: "run-start-claim-invalid",
        });
      } else {
        const evidence = await restarted.getEvidence(projectRoot, input.runId);
        expect(evidence.status).toBe(claimCase === "mismatched" ? "failed" : "running");
        expect(JSON.stringify(evidence)).not.toMatch(/claim-secret|alice|private/);
      }
    },
  );

  it.each(["zero-byte", "truncated", "secret-json"] as const)(
    "maps a %s recovery record with a valid claim to the fixed failed terminal state",
    async (recordCase) => {
      const projectRoot = await makeTempRoot();
      const input = explicitRunInput(projectRoot, `record-${recordCase}`);
      const bridge = new AgentBridge({ adapters: [silentHoldAdapter()] });
      await bridge.startRun(input);
      await mkdir(join(projectRoot, ".devflow", "runs", input.runId), { recursive: true });
      const recoveryPath = join(projectRoot, ".devflow", "runs", input.runId, "terminal-recovery.json");
      const content = recordCase === "zero-byte"
        ? ""
        : recordCase === "truncated"
          ? '{"version":1'
          : '{"secret":"Bearer recovery-secret-123456 at /Users/alice/private"';
      await writeFile(recoveryPath, content, { mode: 0o600 });

      const restarted = new AgentBridge({ adapters: [silentHoldAdapter()] });
      const evidence = await restarted.getEvidence(projectRoot, input.runId);
      expect(evidence).toMatchObject({ status: "failed", errorReason: "terminal-persistence-failed" });
      expect(JSON.stringify(evidence)).not.toMatch(/recovery-secret|alice|private|Unexpected|JSON/);
      await expect(restarted.startRun(input)).rejects.toThrow(/already terminal/i);
    },
  );

  it.each(["symlink", "directory", "permissions"] as const)(
    "ignores a %s recovery record and recovers only from the durable claim",
    async (recordCase) => {
      const projectRoot = await makeTempRoot();
      const input = explicitRunInput(projectRoot, `record-file-${recordCase}`);
      const bridge = new AgentBridge({ adapters: [silentHoldAdapter()] });
      await bridge.startRun(input);
      await mkdir(join(projectRoot, ".devflow", "runs", input.runId), { recursive: true });
      const recoveryPath = join(projectRoot, ".devflow", "runs", input.runId, "terminal-recovery.json");
      if (recordCase === "symlink") {
        const target = join(projectRoot, "Bearer-recovery-secret-123456");
        await writeFile(target, "secret");
        await symlink(target, recoveryPath);
      } else if (recordCase === "directory") {
        await mkdir(recoveryPath);
      } else {
        await writeForgedRecovery(projectRoot, input.runId, "failed");
        await chmod(recoveryPath, 0o644);
      }

      const restarted = new AgentBridge({ adapters: [silentHoldAdapter()] });
      const evidence = await restarted.getEvidence(projectRoot, input.runId);
      expect(evidence).toMatchObject({ status: "failed", errorReason: "terminal-persistence-failed" });
      expect(JSON.stringify(evidence)).not.toMatch(/recovery-secret|terminal-recovery\.json|Users/);
    },
  );

  it.each(["codex", "hermes"] as const)(
    "%s awaits terminal compensation without broadcasting an unpersisted triple-failure terminal",
    async (agentKind) => {
      const projectRoot = await makeTempRoot();
      await mkdir(join(projectRoot, ".git"));
      const binRoot = await makeTempRoot();
      const executablePath = join(binRoot, agentKind);
      const input = explicitRunInput(projectRoot, `${agentKind}-triple-failure`, agentKind);
      const eventsPath = join(projectRoot, ".devflow", "runs", input.runId, "events.ndjson");
      const recoveryPath = join(projectRoot, ".devflow", "runs", input.runId, "terminal-recovery.json");
      const precreateRecovery = agentKind === "codex"
        ? `printf '%s\\n' '{"runId":"${input.runId}","status":"succeeded","exitCode":0}' > ${JSON.stringify(recoveryPath)}\nchmod 600 ${JSON.stringify(recoveryPath)}`
        : `mkdir ${JSON.stringify(recoveryPath)}`;
      await writeFile(
        executablePath,
        `#!/bin/sh\n${precreateRecovery}\nexit 0\n`,
        { mode: 0o755 },
      );
      const order: string[] = [];
      let callbackCount = 0;
      let statusAttempts = 0;
      const options = {
        adapters: [agentKind === "codex"
          ? createCodexCliAdapter({ executablePath })
          : createHermesCliAdapter({ executablePath })],
        appendEvent: async (root: string, event: RunEvent) => {
          if (event.kind === "status") {
            if (statusAttempts === 0) {
              await rm(eventsPath, { force: true });
              await mkdir(eventsPath);
            }
            statusAttempts += 1;
            throw new Error("token=triple-failure-secret-123456 at /Users/alice/private");
          }
          await appendRunEventForTest(root, event);
        },
        onTerminalPersistenceFailure: async (failure: {
          runId: string;
          reason: string;
          evidence: RunEvidence;
        }) => {
          callbackCount += 1;
          expect(failure).toMatchObject({
            runId: input.runId,
            reason: "terminal-persistence-failed",
            evidence: { status: "failed", errorReason: "terminal-persistence-failed" },
          });
          order.push("callback");
        },
      };
      const bridge = new AgentBridge(options);
      bridge.onRunEvent((event) => {
        if (event.kind === "status") order.push("listener");
      });

      await bridge.startRun(input);
      await waitForCondition(() => callbackCount === 1, "terminal persistence callback");

      expect(statusAttempts).toBe(2);
      expect(callbackCount).toBe(1);
      expect(order).toEqual(["callback"]);
      await expect(bridge.getEvidence(projectRoot, input.runId)).resolves.toMatchObject({
        status: "failed",
        errorReason: "terminal-persistence-failed",
      });
      expect(JSON.stringify({ order, evidence: await bridge.getEvidence(projectRoot, input.runId) }))
        .not.toMatch(/triple-failure-secret|alice|private/);
    },
  );

  it.each([
    ["codex", "cancelled", "succeeds"],
    ["codex", "cancelled", "fails"],
    ["codex", "timed-out", "succeeds"],
    ["codex", "timed-out", "fails"],
    ["hermes", "cancelled", "succeeds"],
    ["hermes", "cancelled", "fails"],
    ["hermes", "timed-out", "succeeds"],
    ["hermes", "timed-out", "fails"],
  ] as const)(
    "%s %s uses terminal retry, standard fallback, and awaited compensation when the compensator %s",
    async (agentKind, terminalStatus, compensationOutcome) => {
      const projectRoot = await makeTempRoot();
      if (agentKind === "codex") await mkdir(join(projectRoot, ".git"));
      const binRoot = await makeTempRoot();
      const executablePath = join(binRoot, agentKind);
      const launchCountPath = join(binRoot, `${agentKind}-${terminalStatus}-${compensationOutcome}.log`);
      await writeFile(
        executablePath,
        `#!/bin/sh\nprintf 'launch\\n' >> ${JSON.stringify(launchCountPath)}\ntrap '' TERM\nwhile :; do sleep 1; done\n`,
        { mode: 0o755 },
      );
      const input = explicitRunInput(projectRoot, `${agentKind}-${terminalStatus}-${compensationOutcome}`, agentKind);
      const eventsPath = join(projectRoot, ".devflow", "runs", input.runId, "events.ndjson");
      let terminalAppendAttempts = 0;
      let compensationCount = 0;
      const liveEvents: RunEvent[] = [];
      const adapter = agentKind === "codex"
        ? createCodexCliAdapter({
            executablePath,
            timeoutMs: terminalStatus === "timed-out" ? 50 : 5_000,
            killTimeoutMs: 25,
          })
        : createHermesCliAdapter({
            executablePath,
            timeoutMs: terminalStatus === "timed-out" ? 50 : 5_000,
            killTimeoutMs: 25,
          });
      const bridge = new AgentBridge({
        adapters: [adapter],
        appendEvent: async (root, event) => {
          if (event.kind === "status" && event.payload.status === terminalStatus) {
            if (terminalAppendAttempts === 0) {
              await rm(eventsPath, { force: true });
              await mkdir(eventsPath);
            }
            terminalAppendAttempts += 1;
            throw new Error("token=terminal-route-secret-123456 at /Users/alice/private");
          }
          await appendRunEventForTest(root, event);
        },
        onTerminalPersistenceFailure: async () => {
          compensationCount += 1;
          if (compensationOutcome === "fails") {
            throw new Error("password=compensator-secret-123456 C:\\Users\\alice\\private");
          }
        },
      });
      bridge.onRunEvent((event) => liveEvents.push(event));
      const run = await bridge.startRun(input);
      await waitForFile(launchCountPath);

      if (terminalStatus === "cancelled") {
        await expect(bridge.cancelRun(run.id, "Cancel with permanent persistence failure")).resolves.toMatchObject({
          status: "failed",
          errorReason: "terminal-persistence-failed",
        });
      } else {
        await waitForCondition(() => compensationCount === 1, `${agentKind} timeout compensation`);
      }

      await waitForCondition(
        () => bridge.listRuns().some((candidate) => candidate.id === run.id && candidate.status === "failed"),
        `${agentKind} ${terminalStatus} in-memory failure`,
      );
      expect(terminalAppendAttempts).toBe(2);
      expect(compensationCount).toBe(1);
      expect(await bridge.getEvidence(projectRoot, run.id)).toMatchObject({
        status: "failed",
        errorReason: "terminal-persistence-failed",
      });
      expect(terminalRunStatuses(liveEvents)).toHaveLength(0);
      expect(JSON.stringify({ liveEvents, evidence: await bridge.getEvidence(projectRoot, run.id) }))
        .not.toMatch(/terminal-route-secret|compensator-secret|alice|private/);
      await expect(stat(join(projectRoot, ".devflow", "runs", run.id, "terminal-recovery.json"))).rejects.toThrow();

      const reopened = new AgentBridge({ adapters: [adapter] });
      await expect(reopened.getEvidence(projectRoot, run.id)).resolves.toMatchObject({
        status: "failed",
        errorReason: "terminal-persistence-failed",
      });
      await expect(reopened.startRun(input)).rejects.toThrow(/already terminal|durably claimed|durable state/i);
      expect(await readFile(launchCountPath, "utf8")).toBe("launch\n");
    },
    10_000,
  );

  it("rejects an exact duplicate expected artifact before adapter start without exposing its path", async () => {
    const projectRoot = await makeTempRoot();
    await mkdir(join(projectRoot, ".git"));
    await mkdir(join(projectRoot, ".devflow/acceptance"), { recursive: true });
    const artifact = ".devflow/acceptance/react-app.png";
    await writeFile(join(projectRoot, artifact), "png-bytes");

    const result = await rejectCodexArtifactDeclarations(projectRoot, [artifact, artifact]);

    expect(result.adapterStarts).toBe(0);
    expect(result.events).toEqual([]);
    expect(String(result.error)).toMatch(/expectedArtifacts|artifact declaration/i);
    expect(JSON.stringify(result)).not.toContain(artifact);
  });

  it("rejects case-fold duplicate declarations before launching the adapter or helper", async () => {
    const projectRoot = await makeTempRoot();
    await mkdir(join(projectRoot, ".git"));
    const binRoot = await makeTempRoot();
    const codexPath = join(binRoot, "codex");
    const helperPath = join(binRoot, "artifact-helper");
    const helperLogPath = join(binRoot, "helper-launches.log");
    const artifact = ".devflow/acceptance/result.png";
    const caseFoldDuplicate = ".devflow/acceptance/RESULT.png";
    await writeFile(codexPath, "#!/bin/sh\nexit 0\n", { mode: 0o755 });
    await writeFile(
      helperPath,
      [
        "#!/usr/bin/env node",
        "const fs = require('node:fs');",
        `fs.appendFileSync(${JSON.stringify(helperLogPath)}, process.argv[2] + "\\n");`,
        `const identity = process.argv[2] === ${JSON.stringify(artifact)} ? "101:201" : "102:202";`,
        "process.stdout.write(`RESULT present ${identity}\\n`);",
      ].join("\n"),
      { mode: 0o755 },
    );
    const bridge = new AgentBridge({
      adapters: [createCodexCliAdapter({ executablePath: codexPath, artifactVerificationHooks: { helperPath } })],
    });
    const liveEvents: RunEvent[] = [];
    const unsubscribe = bridge.onRunEvent((event) => liveEvents.push(event));

    await expect(bridge.startRun({
      protocolVersion: RUN_EVENT_PROTOCOL_VERSION,
      runId: "run-case-fold-declaration",
      nodeId: "node-case-fold-declaration",
      sessionId: "session-1",
      projectRoot,
      worktreePath: projectRoot,
      agentKind: "codex",
      prompt: "Verify case-fold duplicate artifacts",
      expectedArtifacts: [artifact, caseFoldDuplicate],
    })).rejects.toThrow(/expectedArtifacts|artifact declaration/i);
    unsubscribe();

    expect(liveEvents).toEqual([]);
    expect(await readFile(helperLogPath, "utf8").catch(() => "")).toBe("");
    await expect(stat(await testDurableRunClaimStore().markerPath(projectRoot, "run-case-fold-declaration"))).rejects.toThrow();
  });

  it("rejects equivalent expected artifact paths before adapter start without exposing either path", async () => {
    const artifact = ".devflow/acceptance/react-app.png";
    const equivalentArtifact = `./${artifact}`;
    const attempts = await Promise.all(
      Array.from({ length: 20 }, async () => {
        const projectRoot = await makeTempRoot();
        await mkdir(join(projectRoot, ".git"));
        await mkdir(join(projectRoot, ".devflow/acceptance"), { recursive: true });
        await writeFile(join(projectRoot, artifact), "png-bytes");
        return rejectCodexArtifactDeclarations(projectRoot, [artifact, equivalentArtifact]);
      }),
    );

    for (const result of attempts) {
      expect(result.adapterStarts).toBe(0);
      expect(result.events).toEqual([]);
      expect(String(result.error)).toMatch(/expectedArtifacts|artifact declaration/i);
      expect(JSON.stringify(result)).not.toContain(artifact);
      expect(JSON.stringify(result)).not.toContain(equivalentArtifact);
    }
  });

  it("accepts RESULT before READY and closes artifact helper stdin", async () => {
    const projectRoot = await makeTempRoot();
    await mkdir(join(projectRoot, ".git"));
    const binRoot = await makeTempRoot();
    const codexPath = join(binRoot, "codex");
    const helperPath = join(binRoot, "artifact-helper");
    await writeFile(codexPath, "#!/bin/sh\nexit 0\n", { mode: 0o755 });
    await writeFile(
      helperPath,
      [
        "#!/usr/bin/env node",
        "process.stdout.write('RESULT missing\\n');",
        "process.stdin.resume();",
        "process.stdin.on('end', () => process.exit(0));",
      ].join("\n"),
      { mode: 0o755 },
    );
    const bridge = new AgentBridge({
      adapters: [
        createCodexCliAdapter({
          executablePath: codexPath,
          artifactVerificationHooks: { helperPath, helperTimeoutMs: 1_000 },
        }),
      ],
    });
    const failed = waitForEvent(bridge, (event) => event.kind === "status" && event.payload.status === "failed");
    const run = await bridge.startRun({
      protocolVersion: RUN_EVENT_PROTOCOL_VERSION,
      nodeId: "node-result-before-ready",
      sessionId: "session-1",
      projectRoot,
      worktreePath: projectRoot,
      agentKind: "codex",
      prompt: "Verify missing artifact",
      expectedArtifacts: [".devflow/acceptance/missing.png"],
    });

    await failed;
    expect(deriveEvidenceFromEvents(run, await loadRunEvents(projectRoot, run.id)).checks).toContainEqual({
      kind: "artifact",
      name: "Expected artifacts",
      status: "failed",
      detail: "verified=0 missing=1 empty=0 unsafe=0",
    });
  });

  it("rejects case aliases before adapter start regardless of filesystem identity", async () => {
    const projectRoot = await makeTempRoot();
    await mkdir(join(projectRoot, ".git"));
    await mkdir(join(projectRoot, ".devflow/acceptance"), { recursive: true });
    const artifact = ".devflow/acceptance/result.png";
    const caseAlias = ".devflow/acceptance/RESULT.png";
    await writeFile(join(projectRoot, artifact), "png-bytes");
    try {
      await link(join(projectRoot, artifact), join(projectRoot, caseAlias));
    } catch (error) {
      if (!(error instanceof Error && "code" in error && error.code === "EEXIST")) throw error;
    }

    const result = await rejectCodexArtifactDeclarations(projectRoot, [artifact, caseAlias]);

    expect(result.adapterStarts).toBe(0);
    expect(result.events).toEqual([]);
    expect(JSON.stringify(result)).not.toContain(artifact);
    expect(JSON.stringify(result)).not.toContain(caseAlias);
  });

  it("rejects case-fold duplicate declarations for distinct files on case-sensitive filesystems", async ({ skip }) => {
    const projectRoot = await makeTempRoot();
    await mkdir(join(projectRoot, ".git"));
    await mkdir(join(projectRoot, ".devflow/acceptance"), { recursive: true });
    const artifact = ".devflow/acceptance/result.png";
    const caseFoldDuplicate = ".devflow/acceptance/RESULT.png";
    await writeFile(join(projectRoot, artifact), "lower-file");
    try {
      await writeFile(join(projectRoot, caseFoldDuplicate), "upper-file", { flag: "wx" });
    } catch (error) {
      if (error instanceof Error && "code" in error && error.code === "EEXIST") {
        skip();
        return;
      }
      throw error;
    }
    const [lowerIdentity, upperIdentity] = await Promise.all([
      stat(join(projectRoot, artifact)),
      stat(join(projectRoot, caseFoldDuplicate)),
    ]);
    expect(`${lowerIdentity.dev}:${lowerIdentity.ino}`).not.toBe(`${upperIdentity.dev}:${upperIdentity.ino}`);

    const result = await rejectCodexArtifactDeclarations(projectRoot, [artifact, caseFoldDuplicate]);

    expect(result.adapterStarts).toBe(0);
    expect(result.events).toEqual([]);
    expect(JSON.stringify(result)).not.toContain(artifact);
    expect(JSON.stringify(result)).not.toContain(caseFoldDuplicate);
  });

  it("fails closed for hard-linked expected artifact aliases", async () => {
    const projectRoot = await makeTempRoot();
    await mkdir(join(projectRoot, ".git"));
    await mkdir(join(projectRoot, ".devflow/acceptance"), { recursive: true });
    const artifact = ".devflow/acceptance/desktop.png";
    const hardLink = ".devflow/acceptance/mobile.png";
    await writeFile(join(projectRoot, artifact), "png-bytes");
    await link(join(projectRoot, artifact), join(projectRoot, hardLink));

    const events = await runCodexArtifactCheck(projectRoot, [artifact, hardLink]);
    const evidence = deriveEvidenceFromEvents(makeRunFromEvents(events, projectRoot), events);
    const serializedEvents = JSON.stringify(events);

    expect(evidence.status).toBe("failed");
    expect(evidence.artifacts).toEqual([]);
    expect(evidence.checks).toContainEqual({
      kind: "artifact",
      name: "Expected artifacts",
      status: "failed",
      detail: "verified=1 missing=0 empty=0 unsafe=1",
    });
    expect(serializedEvents).not.toContain(artifact);
    expect(serializedEvents).not.toContain(hardLink);
  });

  it("treats an empty expectedArtifacts declaration as no requirements", async () => {
    const projectRoot = await makeTempRoot();
    await mkdir(join(projectRoot, ".git"));
    const binRoot = await makeTempRoot();
    const codexPath = join(binRoot, "codex");
    await writeFile(codexPath, "#!/bin/sh\nexit 0\n", { mode: 0o755 });
    const bridge = new AgentBridge({ adapters: [createCodexCliAdapter({ executablePath: codexPath })] });
    const succeeded = waitForEvent(bridge, (event) => event.kind === "status" && event.payload.status === "succeeded");

    const run = await bridge.startRun({
      protocolVersion: RUN_EVENT_PROTOCOL_VERSION,
      nodeId: "node-no-artifact-requirements",
      sessionId: "session-1",
      projectRoot,
      worktreePath: projectRoot,
      agentKind: "codex",
      prompt: "Run without artifact requirements",
      expectedArtifacts: [],
    });
    await succeeded;

    const evidence = deriveEvidenceFromEvents(run, await loadRunEvents(projectRoot, run.id));

    expect(evidence.status).toBe("succeeded");
    expect(evidence.artifacts).toEqual([]);
    expect(evidence.checks).not.toContainEqual(expect.objectContaining({ kind: "artifact" }));
  });

  it("rejects an expected artifact symlink outside the worktree", async () => {
    const projectRoot = await makeTempRoot();
    await mkdir(join(projectRoot, ".git"));
    await mkdir(join(projectRoot, ".devflow/acceptance"), { recursive: true });
    const outsideRoot = await makeTempRoot();
    const outsideArtifact = join(outsideRoot, "screenshot.png");
    await writeFile(outsideArtifact, "png-bytes");
    await symlink(outsideArtifact, join(projectRoot, ".devflow/acceptance/screenshot.png"));
    const events = await runCodexArtifactCheck(projectRoot, [".devflow/acceptance/screenshot.png"]);

    const evidence = deriveEvidenceFromEvents(makeRunFromEvents(events, projectRoot), events);

    expect(evidence.status).toBe("failed");
    expect(evidence.artifacts).toEqual([]);
    expect(evidence.checks).toContainEqual(
      expect.objectContaining({ kind: "artifact", status: "failed", detail: expect.stringContaining("unsafe=1") }),
    );
  });

  it("rejects a final-component symlink to an internal ordinary file without publishing partial artifacts", async () => {
    const projectRoot = await makeTempRoot();
    await mkdir(join(projectRoot, ".git"));
    await mkdir(join(projectRoot, ".devflow/acceptance"), { recursive: true });
    const present = ".devflow/acceptance/present.png";
    const target = ".devflow/acceptance/internal-target.png";
    const alias = ".devflow/acceptance/result.png";
    await writeFile(join(projectRoot, present), "png-bytes");
    await writeFile(join(projectRoot, target), "png-bytes");
    await symlink("internal-target.png", join(projectRoot, alias));

    const events = await runCodexArtifactCheck(projectRoot, [present, alias]);
    const evidence = deriveEvidenceFromEvents(makeRunFromEvents(events, projectRoot), events);
    const serialized = JSON.stringify(events);

    expect(evidence.status).toBe("failed");
    expect(evidence.artifacts).toEqual([]);
    expect(summarizeRunEvidence({ runEvidence: evidence }).artifactSummary).toBe("None");
    expect(evidence.checks).toContainEqual({
      kind: "artifact",
      name: "Expected artifacts",
      status: "failed",
      detail: "verified=1 missing=0 empty=0 unsafe=1",
    });
    expect(serialized).not.toContain(present);
    expect(serialized).not.toContain(target);
    expect(serialized).not.toContain("internal-target.png");
  });

  it("rejects a final-component symlink to an internal sensitive file with aggregate-only diagnostics", async () => {
    const projectRoot = await makeTempRoot();
    await mkdir(join(projectRoot, ".git"));
    await mkdir(join(projectRoot, ".devflow/acceptance"), { recursive: true });
    const sensitiveTarget = join(projectRoot, ".env");
    const alias = ".devflow/acceptance/result.png";
    await writeFile(sensitiveTarget, "API_KEY=never-publish");
    await symlink("../../.env", join(projectRoot, alias));

    const events = await runCodexArtifactCheck(projectRoot, [alias]);
    const evidence = deriveEvidenceFromEvents(makeRunFromEvents(events, projectRoot), events);
    const serialized = JSON.stringify(events);

    expect(evidence.status).toBe("failed");
    expect(evidence.artifacts).toEqual([]);
    expect(evidence.checks).toContainEqual({
      kind: "artifact",
      name: "Expected artifacts",
      status: "failed",
      detail: "verified=0 missing=0 empty=0 unsafe=1",
    });
    expect(serialized).not.toMatch(/\.env|never-publish/);
  });

  it("rejects an expected artifact symlink inside the worktree but outside acceptance", async () => {
    const projectRoot = await makeTempRoot();
    await mkdir(join(projectRoot, ".git"));
    await mkdir(join(projectRoot, ".devflow/acceptance"), { recursive: true });
    const outsideAcceptance = join(projectRoot, ".devflow/outside-acceptance");
    await mkdir(outsideAcceptance);
    await writeFile(join(outsideAcceptance, "screenshot.png"), "png-bytes");
    await symlink(outsideAcceptance, join(projectRoot, ".devflow/acceptance/linked"));
    const events = await runCodexArtifactCheck(projectRoot, [".devflow/acceptance/linked/screenshot.png"]);

    const evidence = deriveEvidenceFromEvents(makeRunFromEvents(events, projectRoot), events);

    expect(evidence.status).toBe("failed");
    expect(evidence.artifacts).toEqual([]);
    expect(evidence.checks).toContainEqual(
      expect.objectContaining({ kind: "artifact", status: "failed", detail: expect.stringContaining("unsafe=1") }),
    );
  });

  it("rejects a preexisting intermediate symlink that stays inside acceptance", async () => {
    const projectRoot = await makeTempRoot();
    await mkdir(join(projectRoot, ".git"));
    const acceptanceRoot = join(projectRoot, ".devflow/acceptance");
    await mkdir(join(acceptanceRoot, "real"), { recursive: true });
    await writeFile(join(acceptanceRoot, "real/screenshot.png"), "png-bytes");
    await symlink("real", join(acceptanceRoot, "linked"));

    const events = await runCodexArtifactCheck(projectRoot, [
      ".devflow/acceptance/linked/screenshot.png",
    ]);
    const evidence = deriveEvidenceFromEvents(makeRunFromEvents(events, projectRoot), events);

    expect(evidence.status).toBe("failed");
    expect(evidence.artifacts).toEqual([]);
    expect(evidence.checks).toContainEqual(
      expect.objectContaining({ kind: "artifact", status: "failed", detail: expect.stringContaining("unsafe=1") }),
    );
  });

  it("rejects a symlink used as the acceptance root", async () => {
    const projectRoot = await makeTempRoot();
    await mkdir(join(projectRoot, ".git"));
    const realAcceptanceRoot = join(projectRoot, ".devflow/real-acceptance");
    await mkdir(realAcceptanceRoot, { recursive: true });
    await writeFile(join(realAcceptanceRoot, "screenshot.png"), "png-bytes");
    await symlink("real-acceptance", join(projectRoot, ".devflow/acceptance"));

    const events = await runCodexArtifactCheck(projectRoot, [".devflow/acceptance/screenshot.png"]);
    const evidence = deriveEvidenceFromEvents(makeRunFromEvents(events, projectRoot), events);

    expect(evidence.status).toBe("failed");
    expect(evidence.artifacts).toEqual([]);
    expect(evidence.checks).toContainEqual(
      expect.objectContaining({ kind: "artifact", status: "failed", detail: expect.stringContaining("unsafe=1") }),
    );
  });

  it("rejects a secret-like expected artifact target before adapter start", async () => {
    const projectRoot = await makeTempRoot();
    await mkdir(join(projectRoot, ".git"));
    await mkdir(join(projectRoot, ".devflow/acceptance"), { recursive: true });
    await writeFile(join(projectRoot, ".devflow/acceptance/session-secret.png"), "secret-bytes");
    const candidate = ".devflow/acceptance/session-secret.png";
    const result = await rejectCodexArtifactDeclarations(projectRoot, [candidate]);

    expect(result.adapterStarts).toBe(0);
    expect(result.events).toEqual([]);
    expect(JSON.stringify(result)).not.toContain(candidate);
  });

  it("verifies neighboring non-sensitive artifact families as one atomic declaration set", async () => {
    const projectRoot = await makeTempRoot();
    await mkdir(join(projectRoot, ".git"));
    const artifacts = [
      ".devflow/acceptance/service-accounting-report.txt",
      ".devflow/acceptance/service-accountability-report.txt",
      ".devflow/acceptance/authorized-keyspace-report.txt",
      ".devflow/acceptance/known-hostscope-report.txt",
    ];
    await mkdir(join(projectRoot, ".devflow", "acceptance"), { recursive: true });
    await Promise.all(artifacts.map((artifact) => writeFile(join(projectRoot, artifact), "verified\n")));

    const events = await runCodexArtifactCheck(projectRoot, artifacts);
    const run = makeRunFromEvents(events, projectRoot);
    const evidence = deriveEvidenceFromEvents(run, events);
    expect(evidence).toMatchObject({
      status: "succeeded",
      artifacts,
    });
    expect(evidence.checks).toContainEqual(expect.objectContaining({ kind: "artifact", status: "passed" }));
  });

  it("rejects explicit sensitive expected artifact names without exposing candidates", async () => {
    const projectRoot = await makeTempRoot();
    await mkdir(join(projectRoot, ".git"));
    const candidates = [
      ".devflow/acceptance/.env",
      ".devflow/acceptance/.ENV.local",
      ".devflow/acceptance/id_rsa",
      ".devflow/acceptance/ID-RSA.pub",
      ".devflow/acceptance/id_ed25519",
      ".devflow/acceptance/id_ecdsa",
      ".devflow/acceptance/authorized_keys",
      ".devflow/acceptance/known_hosts",
      ".devflow/acceptance/shadow",
      ".devflow/acceptance/token",
      ".devflow/acceptance/credential.json",
      ".devflow/acceptance/key.txt",
      ".devflow/acceptance/password.log",
      ".devflow/acceptance/secret.png",
      ".devflow/acceptance/.npmrc",
      ".devflow/acceptance/COOKIES_SQLITE",
      ".devflow/acceptance/service_account.JSON",
      ".devflow/acceptance/service-account.backup.json",
      ".devflow/acceptance/service-account.json.backup.old",
      ".devflow/acceptance/service account.json.backup.txt",
      ".devflow/acceptance/service．account.json.orig.1",
      ".devflow/acceptance/service—account.JSON.backup",
      ".devflow/acceptance/serviceaccount.json.orig.1",
      ".devflow/acceptance/service-account.json.report.json",
      ".devflow/acceptance/authorized keys.backup.txt",
      ".devflow/acceptance/known\u2014hosts",
      ".devflow/acceptance/credentials json.backup",
      ".devflow/acceptance/access token.report",
      ".devflow/acceptance/certificate\uff0epem",
      ".devflow/acceptance/report.PRIVATE_PEM",
    ];

    const result = await rejectCodexArtifactDeclarations(projectRoot, candidates);

    expect(result.adapterStarts).toBe(0);
    expect(result.events).toEqual([]);
    expect(String(result.error)).toMatch(/expectedArtifacts|artifact declaration/i);
    for (const candidate of candidates) expect(JSON.stringify(result)).not.toContain(candidate);
  });

  it.each([
    ".devflow/acceptance/service account.json.backup.txt",
    ".devflow/acceptance/service．account.json.orig.1",
    ".devflow/acceptance/service—account.JSON.backup",
    ".devflow/acceptance/serviceaccount.json.orig.1",
    ".devflow/acceptance/service-account.json.report.json",
    ".devflow/acceptance/authorized keys.backup.txt",
    ".devflow/acceptance/known\u2014hosts",
    ".devflow/acceptance/credentials json.backup",
    ".devflow/acceptance/access token.report",
    ".devflow/acceptance/certificate\uff0epem",
  ])("fails the real artifact verifier atomically for a sensitive Unicode alias %j", async (artifact) => {
    const projectRoot = await makeTempRoot();
    const binRoot = await makeTempRoot();
    const codexPath = join(binRoot, "codex");
    await mkdir(join(projectRoot, ".git"));
    await mkdir(join(projectRoot, ".devflow/acceptance"), { recursive: true });
    await writeFile(join(projectRoot, ".devflow/acceptance/safe.png"), "safe");
    await writeFile(join(projectRoot, artifact), "credential");
    await writeFile(codexPath, "#!/bin/sh\nexit 0\n", { mode: 0o755 });
    const realAdapter = createCodexCliAdapter({ executablePath: codexPath });
    const bridge = new AgentBridge({
      adapters: [{
        ...realAdapter,
        async startRun(input, sink) {
          return realAdapter.startRun({ ...input, expectedArtifacts: [artifact] }, sink);
        },
      }],
    });
    const terminal = waitForEvent(
      bridge,
      (event) => event.kind === "status" && (event.payload.status === "failed" || event.payload.status === "succeeded"),
    );

    const run = await bridge.startRun({
      protocolVersion: RUN_EVENT_PROTOCOL_VERSION,
      nodeId: "node-verifier-sensitive-alias",
      sessionId: "session-1",
      projectRoot,
      worktreePath: projectRoot,
      agentKind: "codex",
      prompt: "Verify a backend-mutated declaration",
      expectedArtifacts: [".devflow/acceptance/safe.png"],
    });
    await terminal;

    const events = await loadRunEvents(projectRoot, run.id);
    const evidence = await bridge.getEvidence(projectRoot, run.id);
    expect(evidence.status).toBe("failed");
    expect(evidence.artifacts).toEqual([]);
    expect(evidence.checks).toContainEqual(expect.objectContaining({ kind: "artifact", status: "failed" }));
    expect(JSON.stringify({ events, evidence })).not.toContain(artifact);
  });

  it.each(["\n", "\r", "\u0001", "\u001f", "\u007f"])(
    "rejects expected artifact declarations containing control character %j without live disclosure",
    async (control) => {
      const projectRoot = await makeTempRoot();
      await mkdir(join(projectRoot, ".git"));
      const candidate = `.devflow/acceptance/a${control}b.png`;
      const result = await rejectCodexArtifactDeclarations(projectRoot, [candidate]);

      expect(result.adapterStarts).toBe(0);
      expect(result.events).toEqual([]);
      expect(JSON.stringify(result)).not.toContain(candidate);
    },
  );

  it("rejects an unsafe artifact declaration before a nonzero process can start", async () => {
    const projectRoot = await makeTempRoot();
    await mkdir(join(projectRoot, ".git"));
    const candidate = ".devflow/acceptance/authorized_keys";
    const result = await rejectCodexArtifactDeclarations(projectRoot, [candidate]);

    expect(result.adapterStarts).toBe(0);
    expect(result.events).toEqual([]);
    expect(JSON.stringify(result)).not.toContain(candidate);
  });

  it("uses the anchored parent when its path is swapped after the last path-side check", async () => {
    const projectRoot = await makeTempRoot();
    await mkdir(join(projectRoot, ".git"));
    const acceptanceRoot = join(projectRoot, ".devflow/acceptance");
    const originalParent = join(acceptanceRoot, "browser");
    const movedParent = join(acceptanceRoot, "browser-original");
    await mkdir(originalParent, { recursive: true });
    await writeFile(join(originalParent, "screenshot.png"), "trusted-bytes");
    const outsideRoot = await makeTempRoot();
    await writeFile(join(outsideRoot, "screenshot.png"), "outside-bytes");
    const binRoot = await makeTempRoot();
    const codexPath = join(binRoot, "codex");
    await writeFile(codexPath, "#!/bin/sh\nexit 0\n", { mode: 0o755 });
    let swapped = false;
    const bridge = new AgentBridge({
      adapters: [
        createCodexCliAdapter({
          executablePath: codexPath,
          artifactVerificationHooks: {
            async afterParentOpen() {
              await rename(originalParent, movedParent);
              await symlink(outsideRoot, originalParent);
              swapped = true;
            },
          },
        }),
      ],
    });
    const succeeded = waitForEvent(bridge, (event) => event.kind === "status" && event.payload.status === "succeeded");

    const run = await bridge.startRun({
      protocolVersion: RUN_EVENT_PROTOCOL_VERSION,
      nodeId: "node-parent-swap",
      sessionId: "session-1",
      projectRoot,
      worktreePath: projectRoot,
      agentKind: "codex",
      prompt: "Verify artifact under a stable parent",
      expectedArtifacts: [".devflow/acceptance/browser/screenshot.png"],
    });
    await succeeded;

    const evidence = deriveEvidenceFromEvents(run, await loadRunEvents(projectRoot, run.id));

    expect(swapped).toBe(true);
    expect(evidence.status).toBe("succeeded");
    expect(evidence.artifacts).toEqual([".devflow/acceptance/browser/screenshot.png"]);
    expect(evidence.checks).toContainEqual({
      kind: "artifact",
      name: "Expected artifacts",
      status: "passed",
      detail: "verified=1 missing=0 empty=0 unsafe=0",
    });
  });

  it.each(["regular-file", "symlink"] as const)(
    "uses the already-open artifact when its pathname becomes a %s before fstat/read",
    async (replacementKind) => {
      const projectRoot = await makeTempRoot();
      await mkdir(join(projectRoot, ".git"));
      const acceptanceRoot = join(projectRoot, ".devflow/acceptance");
      const artifact = ".devflow/acceptance/opened-object.png";
      const artifactPath = join(projectRoot, artifact);
      const movedArtifactPath = join(acceptanceRoot, "opened-object-original.png");
      await mkdir(acceptanceRoot, { recursive: true });
      await writeFile(artifactPath, "trusted-opened-bytes");
      const outsideRoot = await makeTempRoot();
      const replacementTarget = join(outsideRoot, "replacement-target.png");
      await writeFile(replacementTarget, "");
      const binRoot = await makeTempRoot();
      const codexPath = join(binRoot, "codex");
      await writeFile(codexPath, "#!/bin/sh\nexit 0\n", { mode: 0o755 });
      let replaced = false;
      const bridge = new AgentBridge({
        adapters: [
          createCodexCliAdapter({
            executablePath: codexPath,
            artifactVerificationHooks: {
              async afterOpen() {
                await rename(artifactPath, movedArtifactPath);
                if (replacementKind === "symlink") await symlink(replacementTarget, artifactPath);
                else await writeFile(artifactPath, "");
                replaced = true;
              },
            },
          }),
        ],
      });
      const terminal = waitForEvent(bridge, (event) => event.kind === "status" && ["succeeded", "failed"].includes(String(event.payload.status)));

      const run = await bridge.startRun({
        protocolVersion: RUN_EVENT_PROTOCOL_VERSION,
        nodeId: `node-opened-object-${replacementKind}`,
        sessionId: "session-1",
        projectRoot,
        worktreePath: projectRoot,
        agentKind: "codex",
        prompt: "Verify the opened artifact object",
        expectedArtifacts: [artifact],
      });
      await terminal;

      const events = await loadRunEvents(projectRoot, run.id);
      const evidence = deriveEvidenceFromEvents(run, events);
      expect(replaced).toBe(true);
      expect(evidence.status).toBe("succeeded");
      expect(evidence.artifacts).toEqual([artifact]);
      expect(evidence.checks).toContainEqual(expect.objectContaining({ kind: "artifact", status: "passed" }));
      expect(JSON.stringify(events)).not.toContain(replacementTarget);
      expect(JSON.stringify(events)).not.toContain(outsideRoot);
    },
  );

  it("does not accept an artifact from a replacement worktree installed after the run fd is opened", async () => {
    const projectRoot = await makeTempRoot();
    const originalRoot = `${projectRoot}-original`;
    await mkdir(join(projectRoot, ".git"));
    const binRoot = await makeTempRoot();
    const codexPath = join(binRoot, "codex");
    await writeFile(
      codexPath,
      [
        "#!/usr/bin/env node",
        "const fs = require('node:fs');",
        "fs.mkdirSync('.devflow/acceptance', { recursive: true });",
        "fs.writeFileSync('.devflow/acceptance/replacement.png', 'replacement-bytes');",
      ].join("\n"),
      { mode: 0o755 },
    );
    let retainedFd = -1;
    const bridge = new AgentBridge({
      adapters: [
        createCodexCliAdapter({
          executablePath: codexPath,
          artifactVerificationHooks: {
            async afterWorktreeOpen(fd) {
              retainedFd = fd;
              await rename(projectRoot, originalRoot);
              await mkdir(join(projectRoot, ".git"), { recursive: true });
            },
          },
        }),
      ],
    });
    const failed = waitForEvent(bridge, (event) => event.kind === "status" && event.payload.status === "failed");

    const run = await bridge.startRun({
      protocolVersion: RUN_EVENT_PROTOCOL_VERSION,
      nodeId: "node-replaced-worktree",
      sessionId: "session-1",
      projectRoot,
      worktreePath: projectRoot,
      agentKind: "codex",
      prompt: "Create replacement artifact",
      expectedArtifacts: [".devflow/acceptance/replacement.png"],
    });
    await failed;

    const evidence = deriveEvidenceFromEvents(run, await loadRunEvents(projectRoot, run.id));
    expect(retainedFd).toBeGreaterThan(2);
    expect(evidence.status).toBe("failed");
    expect(evidence.artifacts).toEqual([]);
    expect(evidence.checks).toContainEqual({
      kind: "artifact",
      name: "Expected artifacts",
      status: "failed",
      detail: "verified=0 missing=1 empty=0 unsafe=0",
    });
    expect(() => fstatSync(retainedFd)).toThrow(expect.objectContaining({ code: "EBADF" }));
  });

  it.each(["cancelled", "timed-out"] as const)(
    "reaps the child and closes the retained worktree fd when a run is %s",
    async (terminalStatus) => {
      const projectRoot = await makeTempRoot();
      await mkdir(join(projectRoot, ".git"));
      const binRoot = await makeTempRoot();
      const codexPath = join(binRoot, "codex");
      const pidPath = join(binRoot, `codex-${terminalStatus}.pid`);
      await writeFile(
        codexPath,
        [
          "#!/usr/bin/env node",
          "const fs = require('node:fs');",
          `fs.writeFileSync(${JSON.stringify(pidPath)}, String(process.pid));`,
          terminalStatus === "cancelled"
            ? "process.on('SIGTERM', () => process.exit(0));"
            : "process.on('SIGTERM', () => {});",
          "setInterval(() => {}, 1000);",
        ].join("\n"),
        { mode: 0o755 },
      );
      let retainedFd = -1;
      const bridge = new AgentBridge({
        adapters: [
          createCodexCliAdapter({
            executablePath: codexPath,
            timeoutMs: terminalStatus === "timed-out" ? 50 : 5_000,
            killTimeoutMs: 25,
            artifactVerificationHooks: { afterWorktreeOpen: (fd) => void (retainedFd = fd) },
          }),
        ],
      });
      const terminal = waitForEvent(
        bridge,
        (event) => event.kind === "status" && event.payload.status === terminalStatus,
      );
      const run = await bridge.startRun({
        protocolVersion: RUN_EVENT_PROTOCOL_VERSION,
        nodeId: `node-fd-${terminalStatus}`,
        sessionId: "session-1",
        projectRoot,
        worktreePath: projectRoot,
        agentKind: "codex",
        prompt: terminalStatus,
        expectedArtifacts: [".devflow/acceptance/missing.png"],
      });
      const childPid = Number(await waitForFile(pidPath));
      if (terminalStatus === "cancelled") await bridge.cancelRun(run.id, "Cancel fd test");
      await terminal;

      expect(retainedFd).toBeGreaterThan(2);
      expect(() => fstatSync(retainedFd)).toThrow(expect.objectContaining({ code: "EBADF" }));
      expect(isPidAlive(childPid)).toBe(false);
    },
    15_000,
  );

  it("closes the retained worktree fd after a successful run", async () => {
    const projectRoot = await makeTempRoot();
    await mkdir(join(projectRoot, ".git"));
    const binRoot = await makeTempRoot();
    const codexPath = join(binRoot, "codex");
    await writeFile(codexPath, "#!/bin/sh\nexit 0\n", { mode: 0o755 });
    let retainedFd = -1;
    const bridge = new AgentBridge({
      adapters: [
        createCodexCliAdapter({
          executablePath: codexPath,
          artifactVerificationHooks: { afterWorktreeOpen: (fd) => void (retainedFd = fd) },
        }),
      ],
    });
    const succeeded = waitForEvent(bridge, (event) => event.kind === "status" && event.payload.status === "succeeded");

    await bridge.startRun({
      protocolVersion: RUN_EVENT_PROTOCOL_VERSION,
      nodeId: "node-fd-success",
      sessionId: "session-1",
      projectRoot,
      worktreePath: projectRoot,
      agentKind: "codex",
      prompt: "Succeed",
      expectedArtifacts: [],
    });
    await succeeded;

    expect(() => fstatSync(retainedFd)).toThrow(expect.objectContaining({ code: "EBADF" }));
  });

  it.each(["codex", "hermes"] as const)(
    "%s persists one sanitized failed terminal when the process boundary rejects after helper close",
    async (agentKind) => {
      const durableRunClaimStore = testDurableRunClaimStore();
      await durableRunClaimStore.initialize();
      const privateRunEventStore = createPrivateRunEventStore({
        durableRunClaimStore,
        platform: process.platform,
      });
      await withProcessPlatform("win32", async () => {
        const projectRoot = await makeTempRoot();
        if (agentKind === "codex") await mkdir(join(projectRoot, ".git"));
        const binRoot = await makeTempRoot();
        const executablePath = join(binRoot, agentKind);
        await writeFile(executablePath, "#!/bin/sh\nexit 0\n", { mode: 0o755 });
        const boundary = rejectedWindowsProcessBoundary();
        windowsJobObjectProcessMock.spawn = boundary.spawn;
        let retainedFd = -1;
        const adapterOptions = {
          executablePath,
          timeoutMs: 0,
          artifactVerificationHooks: {
            platform: "linux" as const,
            afterWorktreeOpen: (fd: number) => void (retainedFd = fd),
          },
        };
        const bridge = new AgentBridge({
          durableRunClaimStore,
          privateRunEventStore,
          adapters: [agentKind === "codex"
            ? createCodexCliAdapter(adapterOptions)
            : createHermesCliAdapter(adapterOptions)],
        });
        const liveEvents: RunEvent[] = [];
        const unsubscribe = bridge.onRunEvent((event) => liveEvents.push(event));
        const unhandledRejections: unknown[] = [];
        const onUnhandledRejection = (reason: unknown) => unhandledRejections.push(reason);
        process.on("unhandledRejection", onUnhandledRejection);
        const rawCause = "helper protocol token=private-boundary-secret at C:\\Users\\alice\\private\\repo";
        const prompt = "Do not expose prompt-secret-123456";
        const input = {
          ...explicitRunInput(projectRoot, `${agentKind}-process-boundary-failure`, agentKind),
          prompt,
          ...(agentKind === "hermes" ? { hermesSessionHandle: "hermes-resume-secret-123456" } : {}),
        };

        try {
          const run = await bridge.startRun(input);
          boundary.rejectAfterHelperClose(new Error(rawCause));
          await waitForCondition(
            () => liveEvents.some((event) => event.kind === "status" && event.payload.status === "failed"),
            `${agentKind} process-boundary terminal`,
          );
          await flushAsyncEvents();
          await flushAsyncEvents();

          const events = await bridge.loadEvents(projectRoot, run.id);
          const evidence = await bridge.getEvidence(projectRoot, run.id);
          const repeatedCompletion = await bridge.cancelRun(run.id, "late cancel must not replace boundary failure");
          const publicState = JSON.stringify({ events, liveEvents, evidence, repeatedCompletion });

          expect(boundary.helperClosed).toBe(true);
          expect(boundary.terminateAndReap).not.toHaveBeenCalled();
          expect(boundary.child.kill).not.toHaveBeenCalled();
          expect(terminalRunStatuses(events)).toEqual([
            expect.objectContaining({
              payload: expect.objectContaining({
                status: "failed",
                exitCode: null,
                category: "process-boundary-failure",
                reason: "process-boundary-failure",
              }),
            }),
          ]);
          expect(terminalRunStatuses(liveEvents)).toHaveLength(1);
          expect(evidence).toMatchObject({
            status: "failed",
            exitCode: null,
            errorReason: "process-boundary-failure",
            checks: expect.arrayContaining([
              expect.objectContaining({
                kind: "run-exit",
                status: "failed",
                detail: "process-boundary-failure",
              }),
            ]),
          });
          expect(repeatedCompletion.status).toBe("failed");
          expect(() => fstatSync(retainedFd)).toThrow(expect.objectContaining({ code: "EBADF" }));
          expect(boundary.child.stdout?.listenerCount("data")).toBe(0);
          expect(boundary.child.stderr?.listenerCount("data")).toBe(0);
          expect(publicState).not.toMatch(
            /private-boundary-secret|alice|prompt-secret-123456|hermes-resume-secret-123456/,
          );
          expect(unhandledRejections).toEqual([]);
        } finally {
          unsubscribe();
          process.off("unhandledRejection", onUnhandledRejection);
        }
      });
    },
  );

  it.each(["codex", "hermes"] as const)(
    "%s keeps an owned cancellation authoritative when process-boundary rejection races helper close",
    async (agentKind) => {
      const durableRunClaimStore = testDurableRunClaimStore();
      await durableRunClaimStore.initialize();
      const privateRunEventStore = createPrivateRunEventStore({
        durableRunClaimStore,
        platform: process.platform,
      });
      await withProcessPlatform("win32", async () => {
        const projectRoot = await makeTempRoot();
        if (agentKind === "codex") await mkdir(join(projectRoot, ".git"));
        const binRoot = await makeTempRoot();
        const executablePath = join(binRoot, agentKind);
        await writeFile(executablePath, "#!/bin/sh\nexit 0\n", { mode: 0o755 });
        const boundary = rejectedWindowsProcessBoundary();
        windowsJobObjectProcessMock.spawn = boundary.spawn;
        let retainedFd = -1;
        const adapterOptions = {
          executablePath,
          timeoutMs: 0,
          artifactVerificationHooks: {
            platform: "linux" as const,
            afterWorktreeOpen: (fd: number) => void (retainedFd = fd),
          },
        };
        const bridge = new AgentBridge({
          durableRunClaimStore,
          privateRunEventStore,
          adapters: [agentKind === "codex"
            ? createCodexCliAdapter(adapterOptions)
            : createHermesCliAdapter(adapterOptions)],
        });
        const unhandledRejections: unknown[] = [];
        const onUnhandledRejection = (reason: unknown) => unhandledRejections.push(reason);
        process.on("unhandledRejection", onUnhandledRejection);

        try {
          const run = await bridge.startRun(
            explicitRunInput(projectRoot, `${agentKind}-cancel-boundary-race`, agentKind),
          );
          const cancellation = bridge.cancelRun(run.id, "User cancelled first");
          await waitForCondition(
            () => boundary.terminateAndReap.mock.calls.length === 1,
            `${agentKind} cancellation ownership`,
          );
          boundary.rejectAfterHelperClose(new Error("raw helper failure token=race-secret-123456"));
          const evidence = await cancellation;
          await flushAsyncEvents();
          await flushAsyncEvents();

          const events = await bridge.loadEvents(projectRoot, run.id);
          expect(evidence.status).toBe("cancelled");
          expect(terminalRunStatuses(events)).toEqual([
            expect.objectContaining({ payload: expect.objectContaining({ status: "cancelled" }) }),
          ]);
          expect(boundary.terminateAndReap).toHaveBeenCalledTimes(1);
          expect(boundary.child.kill).not.toHaveBeenCalled();
          expect(() => fstatSync(retainedFd)).toThrow(expect.objectContaining({ code: "EBADF" }));
          expect(JSON.stringify({ events, evidence })).not.toMatch(/race-secret-123456|process-boundary-failure/);
          expect(unhandledRejections).toEqual([]);
        } finally {
          process.off("unhandledRejection", onUnhandledRejection);
        }
      });
    },
  );

  it("closes the retained worktree fd when executable preflight fails", async () => {
    const projectRoot = await makeTempRoot();
    await mkdir(join(projectRoot, ".git"));
    const binRoot = await makeTempRoot();
    const codexPath = join(binRoot, "codex");
    await writeFile(codexPath, "#!/bin/sh\nexit 0\n", { mode: 0o755 });
    let retainedFd = -1;
    const bridge = new AgentBridge({
      adapters: [
        createCodexCliAdapter({
          executablePath: codexPath,
          artifactVerificationHooks: {
            async afterWorktreeOpen(fd) {
              retainedFd = fd;
              await rm(codexPath);
            },
          },
        }),
      ],
    });
    const failed = waitForEvent(bridge, (event) => event.kind === "status" && event.payload.status === "failed");

    await bridge.startRun({
      protocolVersion: RUN_EVENT_PROTOCOL_VERSION,
      nodeId: "node-fd-start-failure",
      sessionId: "session-1",
      projectRoot,
      worktreePath: projectRoot,
      agentKind: "codex",
      prompt: "Fail preflight",
      expectedArtifacts: [],
    });
    await failed;

    expect(() => fstatSync(retainedFd)).toThrow(expect.objectContaining({ code: "EBADF" }));
  });

  it.each(["prompt", "extra-arg"] as const)(
    "sanitizes an owned %s synchronous spawn rejection and closes the retained fd",
    async (failureSource) => {
    const projectRoot = await makeTempRoot();
    await mkdir(join(projectRoot, ".git"));
    const binRoot = await makeTempRoot();
    const codexPath = join(binRoot, "codex");
    await writeFile(codexPath, "#!/bin/sh\nexit 0\n", { mode: 0o755 });
    let retainedFd = -1;
    const rawValue = "Bearer spawn-secret path=/Users/alice/private password=hunter2";
    const bridge = new AgentBridge({
      adapters: [
        createCodexCliAdapter({
          executablePath: codexPath,
          ...(failureSource === "extra-arg" ? { extraArgs: [`${rawValue}\0extra`] } : {}),
          artifactVerificationHooks: { afterWorktreeOpen: (fd) => void (retainedFd = fd) },
        }),
      ],
    });
    const runId = `run-sync-spawn-throw-${failureSource}`;

    let rejection: unknown;
    try {
      await bridge.startRun({
      protocolVersion: RUN_EVENT_PROTOCOL_VERSION,
      runId,
      nodeId: `node-sync-spawn-throw-${failureSource}`,
      sessionId: "session-1",
      projectRoot,
      worktreePath: projectRoot,
      agentKind: "codex",
      prompt: failureSource === "prompt" ? `${rawValue}\0prompt` : "Run with an invalid extra argument",
      expectedArtifacts: [],
      });
    } catch (error) {
      rejection = error;
    }

    const events = await loadRunEvents(projectRoot, runId);
    expect(rejection).toMatchObject({ durableRunClaimOwned: true });
    expect(String(rejection)).not.toContain(rawValue);
    expect(terminalRunStatuses(events)).toHaveLength(1);
    expect(terminalRunStatuses(events)[0]?.payload.status).toBe("failed");
    expect(JSON.stringify(events)).not.toMatch(/spawn-secret|alice|hunter2/);
    expect(() => fstatSync(retainedFd)).toThrow(expect.objectContaining({ code: "EBADF" }));
    },
  );

  it.each(["codex", "hermes"] as const)(
    "%s closes the spawned process and retained worktree fd when started-event persistence fails",
    async (agentKind) => {
      const projectRoot = await makeTempRoot();
      if (agentKind === "codex") await mkdir(join(projectRoot, ".git"));
      const binRoot = await makeTempRoot();
      const executablePath = join(binRoot, agentKind);
      const pidPath = join(binRoot, `${agentKind}-started-event.pid`);
      await writeFile(
        executablePath,
        [
          "#!/usr/bin/env node",
          "const fs = require('node:fs');",
          `fs.writeFileSync(${JSON.stringify(pidPath)}, String(process.pid));`,
          "process.on('SIGTERM', () => {});",
          "setInterval(() => {}, 1000);",
        ].join("\n"),
        { mode: 0o755 },
      );
      let retainedFd = -1;
      const adapterOptions = {
        executablePath,
        killTimeoutMs: 25,
        artifactVerificationHooks: { afterWorktreeOpen: (fd: number) => void (retainedFd = fd) },
      };
      const bridge = new AgentBridge({
        adapters: [agentKind === "codex"
          ? createCodexCliAdapter(adapterOptions)
          : createHermesCliAdapter(adapterOptions)],
        appendEvent: async (root, event) => {
          if (event.kind === "progress" && event.payload.phase === "started") {
            await waitForFile(pidPath);
            throw new Error("started event persistence failed");
          }
          await appendRunEventForTest(root, event);
        },
      });
      let childPid = -1;
      try {
        await expect(bridge.startRun(explicitRunInput(projectRoot, `${agentKind}-started-event-failure`, agentKind)))
          .rejects.toThrow(/started event persistence failed/i);
        childPid = Number(await waitForFile(pidPath));
        await waitForCondition(() => !isPidAlive(childPid), `${agentKind} process cleanup`);
        expect(() => fstatSync(retainedFd)).toThrow(expect.objectContaining({ code: "EBADF" }));
      } finally {
        if (childPid > 0) killPid(childPid);
      }
    },
  );

  it.each(["missing", "empty"] as const)(
    "publishes zero artifacts when one declaration is present and another is %s",
    async (failureState) => {
      const projectRoot = await makeTempRoot();
      await mkdir(join(projectRoot, ".git"));
      await mkdir(join(projectRoot, ".devflow/acceptance"), { recursive: true });
      const present = ".devflow/acceptance/present.png";
      const failed = `.devflow/acceptance/${failureState}.png`;
      await writeFile(join(projectRoot, present), "png-bytes");
      if (failureState === "empty") await writeFile(join(projectRoot, failed), "");

      const events = await runCodexArtifactCheck(projectRoot, [present, failed]);
      const evidence = deriveEvidenceFromEvents(makeRunFromEvents(events, projectRoot), events);
      const serialized = JSON.stringify(events);

      expect(evidence.status).toBe("failed");
      expect(evidence.artifacts).toEqual([]);
      expect(summarizeRunEvidence({ runEvidence: evidence }).artifactSummary).toBe("None");
      expect(evidence.checks).toContainEqual(expect.objectContaining({
        kind: "artifact",
        status: "failed",
        detail: failureState === "missing"
          ? "verified=1 missing=1 empty=0 unsafe=0"
          : "verified=1 missing=0 empty=1 unsafe=0",
      }));
      expect(serialized).not.toContain(present);
    },
  );

  it("fails a successful Codex process when an expected artifact is missing", async () => {
    const projectRoot = await makeTempRoot();
    await mkdir(join(projectRoot, ".git"));
    const binRoot = await makeTempRoot();
    const codexPath = join(binRoot, "codex");
    await writeFile(codexPath, "#!/bin/sh\nsleep 0.05\nexit 0\n", { mode: 0o755 });
    const bridge = new AgentBridge({
      adapters: [createCodexCliAdapter({ executablePath: codexPath })],
    });
    const failed = waitForEvent(bridge, (event) => event.kind === "status" && event.payload.status === "failed");

    const run = await bridge.startRun({
      protocolVersion: RUN_EVENT_PROTOCOL_VERSION,
      nodeId: "lane-browser-screenshot",
      sessionId: "session-1",
      projectRoot,
      worktreePath: projectRoot,
      agentKind: "codex",
      prompt: "Capture browser screenshot evidence",
      expectedArtifacts: [".devflow/acceptance/missing.png"],
    });
    await failed;

    const events = await loadRunEvents(projectRoot, run.id);
    const evidence = deriveEvidenceFromEvents(run, events);

    expect(events).not.toContainEqual(
      expect.objectContaining({ kind: "status", payload: expect.objectContaining({ status: "succeeded" }) }),
    );
    expect(evidence.status).toBe("failed");
    expect(evidence.artifacts).toEqual([]);
    expect(evidence.checks).toContainEqual({
      kind: "artifact",
      name: "Expected artifacts",
      status: "failed",
      detail: "verified=0 missing=1 empty=0 unsafe=0",
    });
  });

  it("fails a successful Codex process when an expected artifact is empty", async () => {
    const projectRoot = await makeTempRoot();
    await mkdir(join(projectRoot, ".git"));
    await mkdir(join(projectRoot, ".devflow/acceptance"), { recursive: true });
    await writeFile(join(projectRoot, ".devflow/acceptance/empty.png"), "");
    const binRoot = await makeTempRoot();
    const codexPath = join(binRoot, "codex");
    await writeFile(codexPath, "#!/bin/sh\nsleep 0.05\nexit 0\n", { mode: 0o755 });
    const bridge = new AgentBridge({
      adapters: [createCodexCliAdapter({ executablePath: codexPath })],
    });
    const failed = waitForEvent(bridge, (event) => event.kind === "status" && event.payload.status === "failed");

    const run = await bridge.startRun({
      protocolVersion: RUN_EVENT_PROTOCOL_VERSION,
      nodeId: "lane-browser-screenshot",
      sessionId: "session-1",
      projectRoot,
      worktreePath: projectRoot,
      agentKind: "codex",
      prompt: "Capture browser screenshot evidence",
      expectedArtifacts: [".devflow/acceptance/empty.png"],
    });
    await failed;

    const evidence = deriveEvidenceFromEvents(run, await loadRunEvents(projectRoot, run.id));

    expect(evidence.status).toBe("failed");
    expect(evidence.checks).toContainEqual({
      kind: "artifact",
      name: "Expected artifacts",
      status: "failed",
      detail: "verified=0 missing=0 empty=1 unsafe=0",
    });
  });

  it.runIf(process.platform !== "win32")(
    "rejects a FIFO artifact with exactly one failed terminal state and no path leakage",
    async () => {
      const projectRoot = await makeTempRoot();
      await mkdir(join(projectRoot, ".git"));
      await mkdir(join(projectRoot, ".devflow/acceptance"), { recursive: true });
      const artifact = ".devflow/acceptance/blocked-pipe.png";
      const created = spawnSync("mkfifo", [join(projectRoot, artifact)]);
      expect(created.status).toBe(0);

      const events = await runCodexArtifactCheck(projectRoot, [artifact]);
      const terminalStatuses = terminalRunStatuses(events);

      expect(terminalStatuses).toHaveLength(1);
      expect(terminalStatuses[0]?.payload.status).toBe("failed");
      expect(JSON.stringify(events)).not.toContain(artifact);
    },
  );

  it.runIf(process.platform === "linux" && process.getuid?.() === 0)(
    "rejects a character-device artifact with exactly one failed terminal state and no path leakage",
    async () => {
      const projectRoot = await makeTempRoot();
      await mkdir(join(projectRoot, ".git"));
      await mkdir(join(projectRoot, ".devflow/acceptance"), { recursive: true });
      const artifact = ".devflow/acceptance/device.png";
      const created = spawnSync("mknod", [join(projectRoot, artifact), "c", "1", "3"]);
      expect(created.status).toBe(0);

      const events = await runCodexArtifactCheck(projectRoot, [artifact]);
      const terminalStatuses = terminalRunStatuses(events);

      expect(terminalStatuses).toHaveLength(1);
      expect(terminalStatuses[0]?.payload.status).toBe("failed");
      expect(JSON.stringify(events)).not.toContain(artifact);
    },
  );

  it("times out and reaps a stuck artifact helper with one sanitized failed terminal state", async () => {
    const projectRoot = await makeTempRoot();
    await mkdir(join(projectRoot, ".git"));
    await mkdir(join(projectRoot, ".devflow/acceptance"), { recursive: true });
    const artifact = ".devflow/acceptance/stuck-helper.png";
    await writeFile(join(projectRoot, artifact), "png-bytes");
    const binRoot = await makeTempRoot();
    const codexPath = join(binRoot, "codex");
    await writeFile(codexPath, "#!/bin/sh\nexit 0\n", { mode: 0o755 });
    const bridge = new AgentBridge({
      adapters: [
        createCodexCliAdapter({
          executablePath: codexPath,
          artifactVerificationHooks: {
            helperTimeoutMs: 25,
            afterParentOpen: () => new Promise(() => undefined),
          },
        }),
      ],
    });
    const completed = waitForEvent(
      bridge,
      (event) => event.kind === "status" && event.payload.status === "failed",
    );
    const run = await bridge.startRun({
      protocolVersion: RUN_EVENT_PROTOCOL_VERSION,
      nodeId: "node-stuck-artifact-helper",
      sessionId: "session-1",
      projectRoot,
      worktreePath: projectRoot,
      agentKind: "codex",
      prompt: "Verify artifact",
      expectedArtifacts: [artifact],
    });

    await completed;
    const events = await loadRunEvents(projectRoot, run.id);
    const terminalStatuses = terminalRunStatuses(events);

    expect(terminalStatuses).toHaveLength(1);
    expect(terminalStatuses[0]?.payload.status).toBe("failed");
    expect(JSON.stringify(events)).not.toContain(artifact);
    expect(deriveEvidenceFromEvents(run, events).checks).toContainEqual({
      kind: "artifact",
      name: "Expected artifacts",
      status: "failed",
      detail: "verified=0 missing=0 empty=0 unsafe=1",
    });
  });

  it.each([
    ["codex", "succeeded", {
      status: "passed",
      artifacts: [".devflow/acceptance/windows-only.png"],
      counts: { verified: 1, missing: 0, empty: 0, unsafe: 0 },
    }],
    ["codex", "failed", {
      status: "failed",
      artifacts: [],
      counts: { verified: 0, missing: 0, empty: 0, unsafe: 1 },
    }],
    ["hermes", "succeeded", {
      status: "passed",
      artifacts: [".devflow/acceptance/windows-only.png"],
      counts: { verified: 1, missing: 0, empty: 0, unsafe: 0 },
    }],
    ["hermes", "failed", {
      status: "failed",
      artifacts: [],
      counts: { verified: 0, missing: 0, empty: 0, unsafe: 1 },
    }],
  ] as const)("derives %s %s evidence and downstream scheduling from the Windows verifier", async (
    agentKind,
    status,
    result,
  ) => {
    const projectRoot = await makeTempRoot();
    await mkdir(join(projectRoot, ".git"));
    const artifact = ".devflow/acceptance/windows-only.png";
    const binRoot = await makeTempRoot();
    const executablePath = join(binRoot, agentKind);
    await writeFile(executablePath, "#!/bin/sh\nexit 0\n", { mode: 0o755 });
    const adapter = agentKind === "codex"
      ? createCodexCliAdapter({
          executablePath,
          artifactVerificationHooks: {
            platform: "win32",
            windowsVerifierDependencies: fakeWindowsVerifierDependencies(result),
          },
        })
      : createHermesCliAdapter({
          executablePath,
          artifactVerificationHooks: {
            platform: "win32",
            windowsVerifierDependencies: fakeWindowsVerifierDependencies(result),
          },
        });
    const bridge = new AgentBridge({
      adapters: [adapter],
    });
    const completed = waitForEvent(
      bridge,
      (event) => event.kind === "status" && event.payload.status === status,
    );
    const run = await bridge.startRun({
      protocolVersion: RUN_EVENT_PROTOCOL_VERSION,
      nodeId: `node-windows-artifact-${agentKind}-${status}`,
      sessionId: "session-1",
      projectRoot,
      worktreePath: projectRoot,
      agentKind,
      prompt: "Verify artifact",
      expectedArtifacts: [artifact],
    });

    await completed;
    const events = await loadRunEvents(projectRoot, run.id);
    const evidence = deriveEvidenceFromEvents(run, events);

    expect(terminalRunStatuses(events)).toHaveLength(1);
    expect(evidence.status).toBe(status);
    expect(evidence.artifacts).toEqual(status === "succeeded" ? [artifact] : []);
    expect(evidence.checks).toContainEqual({
      kind: "artifact",
      name: "Expected artifacts",
      status: status === "succeeded" ? "passed" : "failed",
      detail: status === "succeeded"
        ? "verified=1 missing=0 empty=0 unsafe=0"
        : "verified=0 missing=0 empty=0 unsafe=1",
    });
    const flowEvents = flowEventsFromAgentRun({
      sessionId: "session-1",
      laneId: "lane-implementation",
      segmentId: `segment-windows-artifact-${agentKind}-${status}`,
      run,
      events,
      evidence,
      now: "2026-06-14T00:00:03.000Z",
    }).map((event) => ({ ...event, seq: event.seq + 3 }));
    const downstreamLane: FlowEvent = {
      ...laneDeclaredEvent(),
      id: "session-1:flow-event:00000002",
      seq: 2,
      payload: {
        lane: {
          id: "lane-validation",
          semanticKey: "lane-validation",
          kind: "validation",
          title: "Validate",
          agentKind: "codex",
          status: "pending",
          fileScopes: [],
          packageScopes: [],
          requiredEvidence: ["test"],
        },
      },
      idempotencyKey: "lane:validation",
    };
    const dependency: FlowEvent = {
      ...laneDeclaredEvent(),
      id: "session-1:flow-event:00000003",
      seq: 3,
      kind: "workflow.edge.declared",
      payload: {
        edge: {
          id: "edge-implementation-validation",
          sourceLaneId: "lane-implementation",
          targetLaneId: "lane-validation",
        },
      },
      idempotencyKey: "edge:implementation-validation",
    };
    const projection = reduceWorkflowEvents([laneDeclaredEvent(), downstreamLane, dependency, ...flowEvents]);
    expect(scheduleReadyLanes(projection, { allowedParallelism: 1 }).map((lane) => lane.id)).toEqual(
      status === "succeeded" ? ["lane-validation"] : [],
    );
  });

  it.each(["codex", "hermes"] as const)(
    "anchors the Windows artifact verifier before the %s process and keeps one session through COMMIT",
    async (agentKind) => {
    const projectRoot = await makeTempRoot();
    if (agentKind === "codex") await mkdir(join(projectRoot, ".git"));
    const artifact = `.devflow/acceptance/windows-${agentKind}.png`;
    const binRoot = await makeTempRoot();
    const executablePath = join(binRoot, agentKind);
    const tracePath = join(binRoot, "lifecycle.log");
    await writeFile(executablePath, [
      "#!/bin/sh",
      `printf 'adapter-spawn\\n' >> '${tracePath}'`,
      "sleep 0.05",
      `printf 'adapter-exit\\n' >> '${tracePath}'`,
      "exit 0",
    ].join("\n"), { mode: 0o755 });
    const windowsVerifierDependencies = fakeWindowsVerifierDependencies({
      status: "passed",
      artifacts: [artifact],
      counts: { verified: 1, missing: 0, empty: 0, unsafe: 0 },
    }, {
      onCapability: () => appendFileSync(tracePath, "capability\n"),
      onReady: () => appendFileSync(tracePath, "verifier-ready\n"),
      onVerify: () => appendFileSync(tracePath, "verify\n"),
      onOpened: () => appendFileSync(tracePath, "opened\n"),
      onCommit: () => appendFileSync(tracePath, "commit\n"),
    });
    await assertWindowsExpectedArtifactVerifierCapability({
      ...windowsVerifierDependencies,
      platform: "win32",
    });
    const bridge = new AgentBridge({
      adapters: [
        agentKind === "codex"
          ? createCodexCliAdapter({
              executablePath,
              artifactVerificationHooks: {
                platform: "win32",
                windowsVerifierDependencies,
                afterParentOpen: () => windowsVerifierDependencies.onReady(),
                afterArtifactOpen: () => windowsVerifierDependencies.onOpened(),
              },
            })
          : createHermesCliAdapter({
              executablePath,
              artifactVerificationHooks: {
                platform: "win32",
                windowsVerifierDependencies,
                afterParentOpen: () => windowsVerifierDependencies.onReady(),
                afterArtifactOpen: () => windowsVerifierDependencies.onOpened(),
              },
            }),
      ],
    });
    const completed = waitForEvent(
      bridge,
      (event) => event.kind === "status" && event.payload.status === "succeeded",
    );

    const run = await bridge.startRun({
      protocolVersion: RUN_EVENT_PROTOCOL_VERSION,
      nodeId: `node-windows-verifier-${agentKind}`,
      sessionId: "session-1",
      projectRoot,
      worktreePath: projectRoot,
      agentKind,
      prompt: "Verify artifact",
      expectedArtifacts: [artifact],
    });
    await completed;
    const repeatedCleanup = await Promise.all([
      bridge.cancelRun(run.id, "Repeated cleanup after normal completion"),
      bridge.cancelRun(run.id, "Repeated cleanup after normal completion"),
    ]);

    expect((await readFile(tracePath, "utf8")).trim().split("\n")).toEqual([
      "capability",
      "verifier-ready",
      "adapter-spawn",
      "adapter-exit",
      "verify",
      "opened",
      "commit",
    ]);
    expect(repeatedCleanup.map((evidence) => evidence.status)).toEqual(["succeeded", "succeeded"]);
  });

  it.each(["codex", "hermes"] as const)(
    "does not spawn %s when the Windows verifier cannot anchor the root",
    async (agentKind) => {
      const projectRoot = await makeTempRoot();
      if (agentKind === "codex") await mkdir(join(projectRoot, ".git"));
      const binRoot = await makeTempRoot();
      const executablePath = join(binRoot, agentKind);
      const spawnedMarker = join(binRoot, "spawned");
      await writeFile(executablePath, `#!/bin/sh\nprintf spawned > '${spawnedMarker}'\n`, { mode: 0o755 });
      const windowsVerifierDependencies = fakeWindowsVerifierDependencies({
        status: "passed",
        artifacts: [".devflow/acceptance/preopen.png"],
        counts: { verified: 1, missing: 0, empty: 0, unsafe: 0 },
      }, { openingOutput: "MALFORMED\n" });
      const adapter = agentKind === "codex"
        ? createCodexCliAdapter({
            executablePath,
            artifactVerificationHooks: { platform: "win32", windowsVerifierDependencies },
          })
        : createHermesCliAdapter({
            executablePath,
            artifactVerificationHooks: { platform: "win32", windowsVerifierDependencies },
          });
      const bridge = new AgentBridge({ adapters: [adapter] });

      await expect(bridge.startRun({
        protocolVersion: RUN_EVENT_PROTOCOL_VERSION,
        nodeId: `node-windows-preopen-${agentKind}`,
        sessionId: "session-1",
        projectRoot,
        worktreePath: projectRoot,
        agentKind,
        prompt: "Verify artifact",
        expectedArtifacts: [".devflow/acceptance/preopen.png"],
      })).rejects.toThrow(/verification failed/i);

      expect(existsSync(spawnedMarker)).toBe(false);
      const events = await loadRunEvents(
        projectRoot,
        `run-session-1-node-windows-preopen-${agentKind}`,
      );
      expect(terminalRunStatuses(events)).toEqual([
        expect.objectContaining({ payload: expect.objectContaining({ status: "failed" }) }),
      ]);
    },
  );

  it.each(["omitted", "empty"] as const)(
    "does not require the global Windows verifier capability when expected artifacts are %s",
    async (declaration) => {
      await withProcessPlatform("win32", async () => {
        const expectedArtifacts = declaration === "empty" ? [] : undefined;
        await expect(assertExpectedArtifactVerifierCapability(expectedArtifacts)).resolves.toBeUndefined();
      });
    },
  );

  it.each([
    null,
    "",
    {},
    [""],
    [".devflow/acceptance/safe.png", 1],
  ])("rejects invalid artifact declaration %j before a Windows capability probe", async (expectedArtifacts) => {
    await withProcessPlatform("win32", async () => {
      await expect(assertExpectedArtifactVerifierCapability(expectedArtifacts))
        .rejects.toThrow(/expectedArtifacts declaration is invalid/i);
    });
  });

  it.each([
    ["codex", "omitted"],
    ["codex", "empty"],
    ["hermes", "omitted"],
    ["hermes", "empty"],
  ] as const)(
    "does not start a Windows verifier for a %s run with expected artifacts %s",
    async (agentKind, declaration) => {
      const projectRoot = await makeTempRoot();
      if (agentKind === "codex") await mkdir(join(projectRoot, ".git"));
      const binRoot = await makeTempRoot();
      const executablePath = join(binRoot, agentKind);
      await writeFile(executablePath, "#!/bin/sh\nexit 0\n", { mode: 0o755 });
      const dependencies = fakeWindowsVerifierDependencies({
        status: "passed",
        artifacts: [],
        counts: { verified: 0, missing: 0, empty: 0, unsafe: 0 },
      });
      const adapter = agentKind === "codex"
        ? createCodexCliAdapter({
            executablePath,
            artifactVerificationHooks: { platform: "win32", windowsVerifierDependencies: dependencies },
          })
        : createHermesCliAdapter({
            executablePath,
            artifactVerificationHooks: { platform: "win32", windowsVerifierDependencies: dependencies },
          });
      const bridge = new AgentBridge({ adapters: [adapter] });
      const completed = waitForEvent(
        bridge,
        (event) => event.kind === "status" && event.payload.status === "succeeded",
      );

      await bridge.startRun({
        protocolVersion: RUN_EVENT_PROTOCOL_VERSION,
        nodeId: `node-windows-no-artifact-${agentKind}`,
        sessionId: "session-1",
        projectRoot,
        worktreePath: projectRoot,
        agentKind,
        prompt: "No artifacts",
        ...(declaration === "empty" ? { expectedArtifacts: [] } : {}),
      });
      await completed;

      expect(dependencies.spawnProcess).not.toHaveBeenCalled();
    },
  );

  it.each([
    ["codex", "spawn-error"],
    ["codex", "cancel"],
    ["codex", "timeout"],
    ["hermes", "spawn-error"],
    ["hermes", "cancel"],
    ["hermes", "timeout"],
  ] as const)("kills and reaps one Windows verifier for %s %s", async (agentKind, terminalPath) => {
    const projectRoot = await makeTempRoot();
    if (agentKind === "codex") await mkdir(join(projectRoot, ".git"));
    const binRoot = await makeTempRoot();
    const executablePath = join(binRoot, agentKind);
    const startedMarker = join(binRoot, "started");
    await writeFile(executablePath, [
      "#!/bin/sh",
      `printf started > '${startedMarker}'`,
      terminalPath === "spawn-error" ? "exit 0" : "while true; do sleep 1; done",
    ].join("\n"), { mode: 0o755 });
    let verifierKills = 0;
    let verifierChild: (ChildProcess & { stdout: PassThrough }) | null = null;
    const verifierKilled = deferred<void>();
    const windowsVerifierDependencies = fakeWindowsVerifierDependencies({
      status: "passed",
      artifacts: [".devflow/acceptance/lifecycle.png"],
      counts: { verified: 1, missing: 0, empty: 0, unsafe: 0 },
    }, {
      closeOnKill: false,
      onKill: (child) => {
        verifierKills += 1;
        verifierChild = child;
        verifierKilled.resolve();
      },
    });
    const artifactVerificationHooks = {
      platform: "win32" as const,
      helperTimeoutMs: 25,
      windowsVerifierDependencies,
      ...(terminalPath === "spawn-error"
        ? { afterParentOpen: async () => rm(executablePath) }
        : {}),
    };
    const adapter = agentKind === "codex"
      ? createCodexCliAdapter({
          executablePath,
          timeoutMs: terminalPath === "timeout" ? 50 : 5_000,
          killTimeoutMs: 10,
          artifactVerificationHooks,
        })
      : createHermesCliAdapter({
          executablePath,
          timeoutMs: terminalPath === "timeout" ? 50 : 5_000,
          killTimeoutMs: 10,
          artifactVerificationHooks,
        });
    const bridge = new AgentBridge({ adapters: [adapter] });
    const liveEvents: RunEvent[] = [];
    const unsubscribe = bridge.onRunEvent((event) => liveEvents.push(event));
    const failed = waitForEvent(
      bridge,
      (event) => event.kind === "status" && (
        event.payload.status === "failed" || event.payload.status === "timed-out" || event.payload.status === "cancelled"
      ),
    );

    const run = await bridge.startRun({
      protocolVersion: RUN_EVENT_PROTOCOL_VERSION,
      nodeId: `node-windows-lifecycle-${agentKind}-${terminalPath}`,
      sessionId: "session-1",
      projectRoot,
      worktreePath: projectRoot,
      agentKind,
      prompt: "Verify lifecycle",
      expectedArtifacts: [".devflow/acceptance/lifecycle.png"],
    });
    let cancellation: Promise<RunEvidence> | null = null;
    if (terminalPath === "cancel") {
      await waitForFile(startedMarker);
      cancellation = bridge.cancelRun(run.id, "cancel verifier");
    }
    await verifierKilled.promise;
    await new Promise((resolve) => setTimeout(resolve, 250));

    expect(verifierKills).toBe(1);
    expect(terminalRunStatuses(liveEvents)).toEqual([]);

    verifierChild?.stdout.end();
    verifierChild?.emit("close", null, "SIGKILL");
    await cancellation;
    await failed;
    unsubscribe();
    expect(verifierKills).toBe(1);
    expect(terminalRunStatuses(liveEvents)).toHaveLength(1);
  });

  it.each(["codex", "hermes"] as const)(
    "keeps %s start and caller compensation pending until a concurrent Windows verifier close",
    async (agentKind) => {
      const projectRoot = await makeTempRoot();
      if (agentKind === "codex") await mkdir(join(projectRoot, ".git"));
      const binRoot = await makeTempRoot();
      const executablePath = join(binRoot, agentKind);
      await writeFile(executablePath, "#!/bin/sh\nexit 0\n", { mode: 0o755 });
      let verifierKills = 0;
      let verifierChild: (ChildProcess & { stdout: PassThrough }) | null = null;
      const verifierKilled = deferred<void>();
      const windowsVerifierDependencies = fakeWindowsVerifierDependencies({
        status: "passed",
        artifacts: [".devflow/acceptance/review18.png"],
        counts: { verified: 1, missing: 0, empty: 0, unsafe: 0 },
      }, {
        closeOnKill: false,
        onKill: (child) => {
          verifierKills += 1;
          verifierChild = child;
          verifierKilled.resolve();
        },
      });
      const adapterOptions = {
        executablePath,
        artifactVerificationHooks: {
          platform: "win32" as const,
          windowsVerifierDependencies,
          afterParentOpen: async () => rm(executablePath),
        },
      };
      const bridge = new AgentBridge({
        adapters: [agentKind === "codex"
          ? createCodexCliAdapter(adapterOptions)
          : createHermesCliAdapter(adapterOptions)],
        appendEvent: async (_root, event) => {
          if (event.kind === "progress" && event.payload.phase === "started") {
            await verifierKilled.promise;
            throw new Error("started event persistence failed");
          }
        },
      });
      const liveEvents: RunEvent[] = [];
      bridge.onRunEvent((event) => liveEvents.push(event));
      let compensationCalls = 0;
      const startOutcome = bridge.startRun({
        ...explicitRunInput(projectRoot, `${agentKind}-review18-close-race`, agentKind),
        expectedArtifacts: [".devflow/acceptance/review18.png"],
      }).then(
        () => ({ status: "fulfilled" as const }),
        (error: unknown) => {
          compensationCalls += 1;
          return { status: "rejected" as const, error };
        },
      );

      await verifierKilled.promise;
      const earlyOutcome = await Promise.race([
        startOutcome.then(() => "settled" as const),
        new Promise<"pending">((resolve) => setTimeout(() => resolve("pending"), 100)),
      ]);

      expect(verifierKills).toBe(1);
      expect(earlyOutcome).toBe("pending");
      expect(compensationCalls).toBe(0);
      expect(terminalRunStatuses(liveEvents)).toEqual([]);

      verifierChild?.stdout.end();
      verifierChild?.emit("close", null, "SIGKILL");
      const outcome = await startOutcome;

      expect(outcome.status).toBe("rejected");
      if (outcome.status === "rejected") {
        expect(String(outcome.error)).toMatch(/started event persistence failed/i);
      }
      expect(verifierKills).toBe(1);
      expect(compensationCalls).toBe(1);
      await waitForCondition(
        () => terminalRunStatuses(liveEvents).length === 1,
        `${agentKind} Review18 terminal settlement`,
      );
      expect(terminalRunStatuses(liveEvents)).toHaveLength(1);
    },
  );

  it.each([
    ["codex", "error"],
    ["codex", "evidence"],
    ["codex", "status"],
    ["hermes", "error"],
    ["hermes", "evidence"],
    ["hermes", "status"],
  ] as const)(
    "%s spawn-error absorbs a detached %s persistence rejection without an unhandled rejection",
    async (agentKind, rejectedDraft) => {
      const projectRoot = await makeTempRoot();
      const stateRoot = await makeTempRoot();
      await mkdir(join(projectRoot, ".git"));

      const probe = spawnSync(
        process.execPath,
        ["--unhandled-rejections=strict", "--input-type=module", "--eval", detachedSpawnErrorProbeScript],
        {
          encoding: "utf8",
          env: {
            ...process.env,
            SKYTURN_PROBE_AGENT_KIND: agentKind,
            SKYTURN_PROBE_MODULE_URL: new URL("../dist/index.js", import.meta.url).href,
            SKYTURN_PROBE_PROJECT_ROOT: projectRoot,
            SKYTURN_PROBE_REJECT_KIND: rejectedDraft,
            SKYTURN_STATE_HOME: stateRoot,
          },
          timeout: 10_000,
        },
      );

      expect(probe.error).toBeUndefined();
      expect(probe.signal).toBeNull();
      expect(probe.status, probe.stderr).toBe(0);
      expect(probe.stderr).toBe("");
      expect(probe.stdout).not.toContain(detachedSpawnErrorProbeSecret);
      expect(JSON.parse(probe.stdout)).toEqual({
        attempts: { error: 1, evidence: 1, status: 1 },
        compensatable: true,
        evidenceStatus: "failed",
        order: ["error", "evidence", "status"],
        publicState: agentKind === "codex" && rejectedDraft === "status"
          ? {
              compensatable: true,
              errorReason: "terminal-persistence-failed",
              evidenceStatus: "failed",
              runStatus: "failed",
              statusPersistenceAttempts: 2,
            }
          : null,
      });
    },
  );

  it.each([
    ["codex", "sync", "complete"],
    ["codex", "async", "cancel"],
    ["hermes", "sync", "cancel"],
    ["hermes", "async", "complete"],
  ] as const)(
    "%s stall telemetry survives a detached %s persistence rejection and stops after %s",
    async (agentKind, rejectionMode, finalizationMode) => {
      const projectRoot = await makeTempRoot();
      const binRoot = await makeTempRoot();
      const executablePath = join(binRoot, agentKind);
      const exitPath = join(binRoot, `${agentKind}-${rejectionMode}-exit`);
      await mkdir(join(projectRoot, ".git"));
      await writeFile(
        executablePath,
        [
          "#!/usr/bin/env node",
          "const { existsSync } = require('node:fs');",
          "const originalParent = process.ppid;",
          "setInterval(() => {",
          "  if (process.ppid !== originalParent || existsSync(process.env.SKYTURN_PROBE_EXIT_PATH)) process.exit(0);",
          "}, 5);",
          "setTimeout(() => process.exit(0), 1000);",
        ].join("\n"),
        { mode: 0o755 },
      );

      const probe = spawnSync(
        process.execPath,
        ["--input-type=module", "--eval", detachedStallTelemetryProbeScript],
        {
          encoding: "utf8",
          env: {
            ...process.env,
            NODE_OPTIONS: "",
            SKYTURN_PROBE_AGENT_KIND: agentKind,
            SKYTURN_PROBE_EXECUTABLE_PATH: executablePath,
            SKYTURN_PROBE_EXIT_PATH: exitPath,
            SKYTURN_PROBE_FINALIZATION_MODE: finalizationMode,
            SKYTURN_PROBE_MODULE_URL: new URL("../dist/index.js", import.meta.url).href,
            SKYTURN_PROBE_PROJECT_ROOT: projectRoot,
            SKYTURN_PROBE_REJECTION_MODE: rejectionMode,
          },
          timeout: 10_000,
        },
      );

      expect(probe.error).toBeUndefined();
      expect(probe.signal).toBeNull();
      expect(probe.status, probe.stderr).toBe(0);
      expect(probe.stderr).toBe("");
      expect(probe.stderr).not.toContain(detachedStallTelemetryProbeSecret);
      expect(probe.stdout).not.toContain(detachedStallTelemetryProbeSecret);
      expect(JSON.parse(probe.stdout)).toEqual({
        attemptSequence: [
          `${agentKind}:started`,
          `${agentKind}:stalled:1:${rejectionMode}`,
          `${agentKind}:stalled:2:${rejectionMode}`,
          "evidence",
          `status:${finalizationMode === "complete" ? "succeeded" : "cancelled"}`,
        ],
        attemptsAfterFinalization: 2,
        attemptsAtFinalization: 2,
        evidenceEvents: 1,
        persistedStallEvents: 0,
        terminalStatuses: [finalizationMode === "complete" ? "succeeded" : "cancelled"],
      });
    },
  );

  it.each(["codex", "hermes"] as const)(
    "waits for Windows verifier close before absorbing %s spawn-error status rejection",
    async (agentKind) => {
      const projectRoot = await makeTempRoot();
      if (agentKind === "codex") await mkdir(join(projectRoot, ".git"));
      const binRoot = await makeTempRoot();
      const executablePath = join(binRoot, agentKind);
      await writeFile(executablePath, "#!/bin/sh\nexit 0\n", { mode: 0o755 });
      let verifierChild: (ChildProcess & { stdout: PassThrough }) | null = null;
      let verifierClosed = false;
      const verifierKilled = deferred<void>();
      const statusAttempted = deferred<void>();
      const terminalDrafts: RunEventDraft["kind"][] = [];
      let statusAttempts = 0;
      let statusAttemptedAfterVerifierClose = false;
      let seq = 0;
      const windowsVerifierDependencies = fakeWindowsVerifierDependencies({
        status: "passed",
        artifacts: [".devflow/acceptance/spawn-error-close.png"],
        counts: { verified: 1, missing: 0, empty: 0, unsafe: 0 },
      }, {
        closeOnKill: false,
        onKill: (child) => {
          verifierChild = child;
          verifierKilled.resolve();
        },
      });
      const adapterOptions = {
        executablePath,
        artifactVerificationHooks: {
          platform: "win32" as const,
          windowsVerifierDependencies,
          afterParentOpen: async () => rm(executablePath),
        },
      };
      const adapter = agentKind === "codex"
        ? createCodexCliAdapter(adapterOptions)
        : createHermesCliAdapter(adapterOptions);
      const runId = `run-${agentKind}-spawn-error-close-rejection`;
      const sink: RunEventSink = {
        async emit(draft) {
          if (draft.kind === "error" || draft.kind === "evidence" || draft.kind === "status") {
            terminalDrafts.push(draft.kind);
          }
          if (draft.kind === "status") {
            statusAttempts += 1;
            statusAttemptedAfterVerifierClose = verifierClosed;
            statusAttempted.resolve();
            throw new Error("probe-status-persistence-failure");
          }
          seq += 1;
          return {
            protocolVersion: RUN_EVENT_PROTOCOL_VERSION,
            runId,
            seq,
            timestamp: draft.timestamp ?? new Date().toISOString(),
            kind: draft.kind,
            payload: draft.payload,
          } as RunEvent;
        },
      };

      await adapter.startRun({
        protocolVersion: RUN_EVENT_PROTOCOL_VERSION,
        runId,
        nodeId: `node-${agentKind}-spawn-error-close-rejection`,
        sessionId: "session-1",
        projectRoot,
        worktreePath: projectRoot,
        agentKind,
        prompt: "Exercise spawn-error close ordering",
        expectedArtifacts: [".devflow/acceptance/spawn-error-close.png"],
      }, sink);
      await verifierKilled.promise;
      await waitForCondition(
        () => terminalDrafts.includes("error") && terminalDrafts.includes("evidence"),
        `${agentKind} spawn-error drafts before verifier close`,
      );
      await new Promise((resolve) => setTimeout(resolve, 100));

      expect(statusAttempts).toBe(0);
      expect(terminalDrafts).toEqual(["error", "evidence"]);

      verifierClosed = true;
      verifierChild?.stdout.end();
      verifierChild?.emit("close", null, "SIGKILL");
      await statusAttempted.promise;
      await flushAsyncEvents();

      expect(statusAttemptedAfterVerifierClose).toBe(true);
      expect(statusAttempts).toBe(1);
      expect(terminalDrafts).toEqual(["error", "evidence", "status"]);
    },
  );

  it("keeps artifact verifier injection behind unexported internal adapter test factories", async () => {
    const internalPath = "./internal/adapterTestFactories.js";
    const testFactories = await import(/* @vite-ignore */ internalPath).catch(() => null);
    expect(testFactories).not.toBeNull();
    expect(testFactories?.createTestCodexCliAdapter({
      artifactVerificationHooks: { platform: process.platform },
    }).kind).toBe("codex");
    expect(testFactories?.createTestHermesCliAdapter({
      artifactVerificationHooks: { platform: process.platform },
    }).kind).toBe("hermes");

    const source = await readFile(new URL("./index.ts", import.meta.url), "utf8");
    const publicAdapterOptions = source.slice(
      source.indexOf("export interface CodexCliAdapterOptions"),
      source.indexOf("export async function assertExpectedArtifactVerifierCapability"),
    );
    expect(publicAdapterOptions).not.toContain("artifactVerificationHooks");

    const packageJson = JSON.parse(await readFile(new URL("../package.json", import.meta.url), "utf8"));
    expect(Object.keys(packageJson.exports)).toEqual(["."]);
  });

  it("rejects unsafe expected artifact paths before adapter start without exposing them", async () => {
    const projectRoot = await makeTempRoot();
    await mkdir(join(projectRoot, ".git"));
    const unsafePaths = [
      "../outside.png",
      ".devflow\\acceptance\\..\\..\\outside.png",
      "/private/secret/screenshot.png",
      ".devflow/acceptance/token-secret.png",
      ".devflow/acceptance/screenshot.png\0ignored",
    ];

    const result = await rejectCodexArtifactDeclarations(projectRoot, [
      ".devflow/acceptance/screenshot.png",
      ".devflow/acceptance/../acceptance/screenshot.png",
      ...unsafePaths,
      unsafePaths[0]!,
    ]);

    expect(result.adapterStarts).toBe(0);
    expect(result.events).toEqual([]);
    expect(String(result.error)).toMatch(/expectedArtifacts|artifact declaration/i);
    for (const unsafePath of unsafePaths) expect(JSON.stringify(result)).not.toContain(unsafePath);
  });

  it("rejects before starting or inspecting a safe artifact when another declaration is unsafe", async () => {
    const projectRoot = await makeTempRoot();
    await mkdir(join(projectRoot, ".git"));
    await mkdir(join(projectRoot, ".devflow/acceptance"), { recursive: true });
    const artifact = ".devflow/acceptance/screenshot.png";
    await writeFile(join(projectRoot, artifact), "png-bytes");
    const result = await rejectCodexArtifactDeclarations(projectRoot, [artifact, "../unsafe.png"]);

    expect(result.adapterStarts).toBe(0);
    expect(result.events).toEqual([]);
    expect(JSON.stringify(result)).not.toContain(artifact);
  });

  it("preserves nonzero Codex exit evidence when artifacts are expected", async () => {
    const projectRoot = await makeTempRoot();
    await mkdir(join(projectRoot, ".git"));
    const binRoot = await makeTempRoot();
    const codexPath = join(binRoot, "codex");
    await writeFile(codexPath, "#!/bin/sh\nsleep 0.05\nexit 7\n", { mode: 0o755 });
    const bridge = new AgentBridge({
      adapters: [createCodexCliAdapter({ executablePath: codexPath })],
    });
    const failed = waitForEvent(bridge, (event) => event.kind === "status" && event.payload.status === "failed");

    const run = await bridge.startRun({
      protocolVersion: RUN_EVENT_PROTOCOL_VERSION,
      nodeId: "lane-browser-screenshot",
      sessionId: "session-1",
      projectRoot,
      worktreePath: projectRoot,
      agentKind: "codex",
      prompt: "Capture browser screenshot evidence",
      expectedArtifacts: [".devflow/acceptance/missing.png"],
    });
    await failed;

    const evidence = deriveEvidenceFromEvents(run, await loadRunEvents(projectRoot, run.id));

    expect(evidence.status).toBe("failed");
    expect(evidence.exitCode).toBe(7);
    expect(evidence.checks).toContainEqual(
      expect.objectContaining({ kind: "run-exit", name: "Codex CLI exit", status: "failed" }),
    );
    expect(evidence.checks).not.toContainEqual(expect.objectContaining({ kind: "artifact" }));
  });

  it("keeps cancellation terminal when expected artifacts are missing", async () => {
    const projectRoot = await makeTempRoot();
    await mkdir(join(projectRoot, ".git"));
    const binRoot = await makeTempRoot();
    const codexPath = join(binRoot, "codex");
    await writeFile(codexPath, "#!/bin/sh\ntrap 'exit 0' TERM\nwhile :; do sleep 1; done\n", { mode: 0o755 });
    const bridge = new AgentBridge({ adapters: [createCodexCliAdapter({ executablePath: codexPath })] });
    const run = await bridge.startRun({
      protocolVersion: RUN_EVENT_PROTOCOL_VERSION,
      nodeId: "node-expected-artifact-cancel",
      sessionId: "session-1",
      projectRoot,
      worktreePath: projectRoot,
      agentKind: "codex",
      prompt: "Wait for cancellation",
      expectedArtifacts: [".devflow/acceptance/missing.png"],
    });

    await bridge.cancelRun(run.id, "User cancelled artifact run");
    await new Promise((resolve) => setTimeout(resolve, 100));
    const events = await loadRunEvents(projectRoot, run.id);
    const evidence = deriveEvidenceFromEvents(run, events);

    expect(evidence.status).toBe("cancelled");
    expect(events).not.toContainEqual(
      expect.objectContaining({
        kind: "status",
        payload: expect.objectContaining({ status: "failed", reason: "expected-artifact-failure" }),
      }),
    );
  });

  it("keeps timeout terminal when expected artifacts are missing", async () => {
    const projectRoot = await makeTempRoot();
    await mkdir(join(projectRoot, ".git"));
    const binRoot = await makeTempRoot();
    const codexPath = join(binRoot, "codex");
    await writeFile(codexPath, "#!/bin/sh\ntrap '' TERM\nwhile :; do sleep 1; done\n", { mode: 0o755 });
    const bridge = new AgentBridge({
      adapters: [createCodexCliAdapter({ executablePath: codexPath, timeoutMs: 50, killTimeoutMs: 25 })],
    });
    const timedOut = waitForEvent(
      bridge,
      (event) => event.kind === "status" && event.payload.status === "timed-out",
    );
    const run = await bridge.startRun({
      protocolVersion: RUN_EVENT_PROTOCOL_VERSION,
      nodeId: "node-expected-artifact-timeout",
      sessionId: "session-1",
      projectRoot,
      worktreePath: projectRoot,
      agentKind: "codex",
      prompt: "Time out",
      expectedArtifacts: [".devflow/acceptance/missing.png"],
    });

    await timedOut;
    await new Promise((resolve) => setTimeout(resolve, 100));
    const evidence = deriveEvidenceFromEvents(run, await loadRunEvents(projectRoot, run.id));

    expect(evidence.status).toBe("timed-out");
    expect(evidence.checks).not.toContainEqual(expect.objectContaining({ kind: "artifact" }));
  });

  it("does not let child close artifact verification overwrite cancellation", async () => {
    const projectRoot = await makeTempRoot();
    await mkdir(join(projectRoot, ".git"));
    const binRoot = await makeTempRoot();
    const codexPath = join(binRoot, "codex");
    await writeFile(
      codexPath,
      ["#!/usr/bin/env node", "process.on('SIGTERM', () => process.exit(0));", "setInterval(() => {}, 1000);"].join(
        "\n",
      ),
      { mode: 0o755 },
    );
    const bridge = new AgentBridge({ adapters: [createCodexCliAdapter({ executablePath: codexPath })] });
    const run = await bridge.startRun({
      protocolVersion: RUN_EVENT_PROTOCOL_VERSION,
      nodeId: "node-expected-artifact-close-race",
      sessionId: "session-1",
      projectRoot,
      worktreePath: projectRoot,
      agentKind: "codex",
      prompt: "Race cancellation with close",
      expectedArtifacts: [".devflow/acceptance/missing.png"],
    });

    await bridge.cancelRun(run.id, "User cancelled before close");
    await new Promise((resolve) => setTimeout(resolve, 100));
    const events = await loadRunEvents(projectRoot, run.id);

    expect(deriveEvidenceFromEvents(run, events).status).toBe("cancelled");
    expect(events).not.toContainEqual(
      expect.objectContaining({
        kind: "status",
        payload: expect.objectContaining({ status: "failed", reason: "expected-artifact-failure" }),
      }),
    );
  });

  it("emits exactly one cancelled terminal status when cancellation races artifact verification", async () => {
    const projectRoot = await makeTempRoot();
    await mkdir(join(projectRoot, ".git"));
    await mkdir(join(projectRoot, ".devflow/acceptance"), { recursive: true });
    await writeFile(join(projectRoot, ".devflow/acceptance/screenshot.png"), "png-bytes");
    const binRoot = await makeTempRoot();
    const codexPath = join(binRoot, "codex");
    await writeFile(codexPath, "#!/bin/sh\nexit 0\n", { mode: 0o755 });
    const verificationStarted = deferred<void>();
    const releaseVerification = deferred<void>();
    const bridge = new AgentBridge({
      adapters: [
        createCodexCliAdapter({
          executablePath: codexPath,
          artifactVerificationHooks: {
            async afterOpen() {
              verificationStarted.resolve();
              await releaseVerification.promise;
            },
          },
        }),
      ],
    });
    const run = await bridge.startRun({
      protocolVersion: RUN_EVENT_PROTOCOL_VERSION,
      nodeId: "node-artifact-verification-cancel-race",
      sessionId: "session-1",
      projectRoot,
      worktreePath: projectRoot,
      agentKind: "codex",
      prompt: "Race cancellation with artifact verification",
      expectedArtifacts: [".devflow/acceptance/screenshot.png"],
    });

    await verificationStarted.promise;
    await bridge.cancelRun(run.id, "User cancelled during artifact verification");
    await waitForPersistedEvent(
      projectRoot,
      run.id,
      (event) =>
        event.kind === "status" &&
        ["succeeded", "failed", "cancelled", "timed-out"].includes(String(event.payload.status)),
    );
    releaseVerification.resolve();
    await new Promise((resolve) => setTimeout(resolve, 100));
    const events = await loadRunEvents(projectRoot, run.id);
    const terminalStatuses = events.filter(
      (event) =>
        event.kind === "status" &&
        ["succeeded", "failed", "cancelled", "timed-out"].includes(String(event.payload.status)),
    );

    expect(terminalStatuses).toHaveLength(1);
    expect(terminalStatuses[0]?.payload.status).toBe("cancelled");
    expect(deriveEvidenceFromEvents(run, events).status).toBe("cancelled");
  });

  it("does not start a later artifact helper after cancellation and closes all run resources", async () => {
    const projectRoot = await makeTempRoot();
    await mkdir(join(projectRoot, ".git"));
    await mkdir(join(projectRoot, ".devflow/acceptance"), { recursive: true });
    const artifacts = [
      ".devflow/acceptance/first.png",
      ".devflow/acceptance/second.png",
    ];
    for (const artifact of artifacts) await writeFile(join(projectRoot, artifact), "png-bytes");
    const binRoot = await makeTempRoot();
    const codexPath = join(binRoot, "codex");
    await writeFile(codexPath, "#!/bin/sh\nexit 0\n", { mode: 0o755 });
    const firstHelperReady = deferred<void>();
    const releaseFirstHelper = deferred<void>();
    let helperStarts = 0;
    let openedHelpers = 0;
    let helperPid = -1;
    let retainedFd = -1;
    const bridge = new AgentBridge({
      adapters: [
        createCodexCliAdapter({
          executablePath: codexPath,
          artifactVerificationHooks: {
            afterWorktreeOpen: (fd) => void (retainedFd = fd),
            beforeHelperStart() {
              helperStarts += 1;
            },
            async afterOpen(...args: unknown[]) {
              openedHelpers += 1;
              if (openedHelpers !== 1) return;
              helperPid = Number(args[0]);
              firstHelperReady.resolve();
              await releaseFirstHelper.promise;
            },
          },
        }),
      ],
    });
    const run = await bridge.startRun({
      protocolVersion: RUN_EVENT_PROTOCOL_VERSION,
      nodeId: "node-cancel-multiple-artifacts",
      sessionId: "session-1",
      projectRoot,
      worktreePath: projectRoot,
      agentKind: "codex",
      prompt: "Verify multiple artifacts",
      expectedArtifacts: artifacts,
    });

    const cancelled = waitForEvent(
      bridge,
      (event) => event.kind === "status" && event.payload.status === "cancelled",
    );
    await firstHelperReady.promise;
    try {
      await Promise.all([
        bridge.cancelRun(run.id, "Cancel before the second helper"),
        cancelled,
      ]);
    } finally {
      releaseFirstHelper.resolve();
    }
    const events = await loadRunEvents(projectRoot, run.id);

    expect(helperStarts).toBe(1);
    expect(helperPid).toBeGreaterThan(0);
    expect(isPidAlive(helperPid)).toBe(false);
    expect(() => fstatSync(retainedFd)).toThrow(expect.objectContaining({ code: "EBADF" }));
    expect(events.filter((event) => event.kind === "evidence")).toHaveLength(1);
    expect(terminalRunStatuses(events)).toHaveLength(1);
    expect(terminalRunStatuses(events)[0]?.payload.status).toBe("cancelled");
  });

  it("rejects a persisted evidence event when any check is malformed", () => {
    const run = makeRun("run-strict-check-boundary");
    expect(() => deriveEvidenceFromEvents(run, [
      event(run.id, 1, "evidence", {
        checks: [
          { kind: "test", name: "Unit", status: "passed" },
          { kind: "verification", name: "Unknown", status: "passed" },
        ],
      }),
    ])).toThrow(/invalid RunEvidence event stream/i);
  });

  it("rejects a persisted status event when any check is malformed", () => {
    const run = makeRun("run-status-check-boundary");
    expect(() => deriveEvidenceFromEvents(run, [
      event(run.id, 1, "status", {
        status: "failed",
        exitCode: 1,
        checks: [
          { kind: "run-exit", name: "Exit", status: "failed" },
          { kind: "unknown-kind", name: "Unsafe", status: "passed" },
        ],
      }),
    ])).toThrow(/invalid RunEvidence event stream/i);
  });

  it("rejects adversarial persisted artifact lists at bridge derivation", () => {
    const run = makeRun("run-hostile-evidence");
    expect(() => deriveEvidenceFromEvents(run, [
      event(run.id, 1, "evidence", {
        artifacts: ["/Users/alice/.ssh/id_rsa", "..\\secret", ".devflow/acceptance/result.png"],
      }),
    ])).toThrow(/invalid RunEvidence event stream/i);
  });

  it.each([
    ["codex", "/Users/alice/private/sk-live-secret/codex"],
    ["codex", "C:\\Users\\alice\\private\\sk-live-secret\\codex.exe"],
    ["hermes", "/Users/alice/private/sk-live-secret/hermes"],
    ["hermes", "C:\\Users\\alice\\private\\sk-live-secret\\hermes.exe"],
  ] as const)("sanitizes %s spawn errors before the first live event for %s", async (agentKind, executablePath) => {
    const projectRoot = await makeTempRoot();
    await mkdir(join(projectRoot, ".git"));
    const adapter = agentKind === "codex"
      ? createCodexCliAdapter({ executablePath })
      : createHermesCliAdapter({ executablePath });
    const bridge = new AgentBridge({ adapters: [adapter] });
    const liveEvents: RunEvent[] = [];
    const unsubscribe = bridge.onRunEvent((event) => liveEvents.push(event));
    const failed = waitForEvent(bridge, (event) => event.kind === "status" && event.payload.status === "failed");

    try {
      await bridge.startRun({
        protocolVersion: RUN_EVENT_PROTOCOL_VERSION,
        nodeId: `node-${agentKind}-spawn-redaction`,
        sessionId: "session-1",
        projectRoot,
        worktreePath: projectRoot,
        agentKind,
        prompt: "Spawn missing executable",
      });
      await failed;
    } finally {
      unsubscribe();
    }

    const serialized = JSON.stringify(liveEvents);
    expect(liveEvents.some((event) => event.kind === "error")).toBe(true);
    expect(serialized).not.toContain(executablePath);
    expect(serialized).not.toContain("alice");
    expect(serialized).not.toContain("sk-live-secret");
  });

  it("sanitizes a cancel reason once before live evidence and status events", async () => {
    const projectRoot = await makeTempRoot();
    await mkdir(join(projectRoot, ".git"));
    const binRoot = await makeTempRoot();
    const codexPath = join(binRoot, "codex");
    await writeFile(
      codexPath,
      "#!/usr/bin/env node\nprocess.on('SIGTERM', () => process.exit(0));\nsetInterval(() => {}, 1000);\n",
      { mode: 0o755 },
    );
    const bridge = new AgentBridge({
      adapters: [createCodexCliAdapter({ executablePath: codexPath, killTimeoutMs: 100 })],
    });
    const liveEvents: RunEvent[] = [];
    const unsubscribe = bridge.onRunEvent((event) => liveEvents.push(event));
    const reason = "cancel /Users/alice/private/repo token=cancel-secret authorized_keys";

    try {
      const run = await bridge.startRun({
        protocolVersion: RUN_EVENT_PROTOCOL_VERSION,
        nodeId: "node-cancel-live-redaction",
        sessionId: "session-1",
        projectRoot,
        worktreePath: projectRoot,
        agentKind: "codex",
        prompt: "Wait",
      });
      await bridge.cancelRun(run.id, reason);
    } finally {
      unsubscribe();
    }

    const terminalEvents = liveEvents.filter((event) =>
      event.kind === "evidence" || (event.kind === "status" && event.payload.status === "cancelled"),
    );
    const serialized = JSON.stringify(terminalEvents);
    expect(terminalEvents.some((event) => event.kind === "evidence")).toBe(true);
    expect(terminalEvents.some((event) => event.kind === "status")).toBe(true);
    expect(serialized).not.toMatch(/alice|cancel-secret|authorized_keys/);
  });

  it.each(["cancelled", "timed-out"] as const)(
    "keeps %s sticky across mixed expected-artifact events",
    (terminalStatus) => {
      const run = makeRun(`run-artifact-${terminalStatus}`);
      const events: RunEvent[] = [
        event(run.id, 1, "evidence", {
          exitCode: 0,
          checks: [{ kind: "run-exit", name: "Codex CLI exit", status: "passed", detail: "exit 0" }],
        }),
        event(run.id, 2, "status", { status: terminalStatus, reason: `Run ${terminalStatus}` }),
        event(run.id, 3, "evidence", {
          exitCode: 0,
          checks: [{ kind: "artifact", name: "Expected artifacts", status: "failed", detail: "missing=1" }],
        }),
        event(run.id, 4, "status", { status: "failed", exitCode: 0, reason: "expected-artifact-failure" }),
      ];

      expect(deriveEvidenceFromEvents(run, events).status).toBe(terminalStatus);
    },
  );

  it("keeps a failed expected-artifact gate terminal across a stale succeeded status", () => {
    const run = makeRun("run-artifact-failed-before-stale-success");
    const events: RunEvent[] = [
      event(run.id, 1, "evidence", {
        exitCode: 0,
        checks: [
          { kind: "artifact", name: "Expected artifacts", status: "failed", detail: "missing=1" },
        ],
      }),
      event(run.id, 2, "status", { status: "succeeded", exitCode: 0 }),
    ];

    expect(deriveEvidenceFromEvents(run, events)).toMatchObject({
      status: "failed",
      exitCode: 0,
      completedAt: "2026-06-10T00:00:02.000Z",
    });
  });

  it("keeps the first terminal error reason across late failed and succeeded statuses", () => {
    const run = makeRun("run-first-terminal-reason");
    const evidence = deriveEvidenceFromEvents(run, [
      event(run.id, 1, "status", { status: "failed", exitCode: 7, errorReason: "first" }),
      event(run.id, 2, "status", { status: "failed", exitCode: 9, errorReason: "late failed" }),
      event(run.id, 3, "status", { status: "succeeded", exitCode: 0, errorReason: "late succeeded" }),
    ]);

    expect(evidence).toMatchObject({
      status: "failed",
      exitCode: 7,
      errorReason: "first",
      completedAt: "2026-06-10T00:00:01.000Z",
    });
  });

  it.each(["succeeded", "failed", "cancelled", "timed-out"] as const)(
    "keeps terminal run-record status %s across conflicting late events",
    (terminalStatus) => {
      const base = makeRun(`run-record-terminal-${terminalStatus}`);
      const run: AgentRun = { ...base, status: terminalStatus, endedAt: "2026-01-01T00:00:00.000Z" };
      const events: RunEvent[] = [
        event(run.id, 1, "status", { status: "running" }),
        event(run.id, 2, "error", { message: "late adapter error" }),
        event(run.id, 3, "status", { status: terminalStatus === "succeeded" ? "failed" : "succeeded", exitCode: 0 }),
      ];

      const evidence = deriveEvidenceFromEvents(run, events);
      expect(evidence.status).toBe(terminalStatus);
      expect(evidence.completedAt).toBe(run.endedAt);
    },
  );

  it.each([
    ["cancelled", null],
    ["timed-out", null],
    ["failed", 7],
  ] as const)("keeps terminal %s evidence sticky across later event kinds", (terminalStatus, exitCode) => {
    const run = makeRun(`run-sticky-${terminalStatus}`);
    const events: RunEvent[] = [
      event(run.id, 1, "status", {
        status: terminalStatus,
        ...(exitCode === null ? {} : { exitCode }),
        reason: `Run ${terminalStatus}`,
      }),
      event(run.id, 2, "output", { text: "late output" }),
      event(run.id, 3, "progress", { phase: "late-progress" }),
      event(run.id, 4, "evidence", { exitCode: 0, checks: [] }),
      event(run.id, 5, "error", { message: "late adapter error" }),
      event(run.id, 6, "status", { status: "running" }),
      event(run.id, 7, "status", { status: "succeeded", exitCode: 0 }),
    ];

    const evidence = deriveEvidenceFromEvents(run, events);

    expect(evidence.status).toBe(terminalStatus);
    expect(evidence.exitCode).toBe(exitCode);
  });

  it.each(["succeeded", "cancelled", "timed-out", "failed"] as const)(
    "keeps materialized bridge run at first terminal %s across every later terminal status",
    async (firstStatus) => {
      for (const lateStatus of ["succeeded", "failed", "cancelled", "timed-out"] as const) {
        const projectRoot = await makeTempRoot();
        const bridge = new AgentBridge({
          adapters: [
            {
              ...createMockAgentAdapter(),
              async startRun(input, sink) {
                await sink.emit({
                  kind: "status",
                  payload: {
                    status: firstStatus,
                    ...(firstStatus === "failed" ? { exitCode: 7 } : firstStatus === "succeeded" ? { exitCode: 0 } : {}),
                  },
                });
                await sink.emit({ kind: "status", payload: { status: lateStatus, exitCode: 0 } });
                await sink.emit({ kind: "error", payload: { message: "late adapter error" } });
                return { runId: input.runId, async cancel() {} };
              },
            },
          ],
        });
        const run = await bridge.startRun({
          protocolVersion: RUN_EVENT_PROTOCOL_VERSION,
          nodeId: `node-${firstStatus}-${lateStatus}`,
          sessionId: "session-1",
          projectRoot,
          worktreePath: projectRoot,
          agentKind: "codex",
          prompt: "Test first terminal wins",
        });

        expect(run.status).toBe(firstStatus);
        expect((await bridge.getEvidence(projectRoot, run.id)).status).toBe(firstStatus);
        expect(await bridge.loadEvents(projectRoot, run.id)).toHaveLength(3);
      }
    },
  );

  it("fails Codex runs with cli-missing category when the executable is unavailable", async () => {
    const projectRoot = await makeTempRoot();
    await mkdir(join(projectRoot, ".git"));
    const missingCodex = join(projectRoot, "missing-codex");
    const bridge = new AgentBridge({
      adapters: [createCodexCliAdapter({ executablePath: missingCodex, pathValue: "" })],
    });

    const run = await bridge.startRun({
      protocolVersion: RUN_EVENT_PROTOCOL_VERSION,
      nodeId: "node-codex-missing",
      sessionId: "session-1",
      projectRoot,
      worktreePath: projectRoot,
      agentKind: "codex",
      prompt: "Implement the task",
    });

    const events = await loadRunEvents(projectRoot, run.id);
    const evidence = deriveEvidenceFromEvents(run, events);

    expect(events).toContainEqual(
      expect.objectContaining({
        kind: "error",
        payload: expect.objectContaining({ source: "codex", category: "cli-missing" }),
      }),
    );
    expect(evidence.status).toBe("failed");
    expect(evidence.checks).toContainEqual(
      expect.objectContaining({ kind: "run-exit", name: "Codex CLI preflight", status: "failed" }),
    );
  });

  it.each([
    ["Unix", "/Users/alice/private/credentials.json/missing-worktree", "/Users/alice", "credentials.json"],
    ["Windows-looking", "C:\\Users\\alice\\private\\secret-target\\missing-worktree", "C:\\\\Users", "secret-target"],
  ])("fails Codex runs without leaking an invalid %s worktreePath", async (_label, invalidWorktree, pathMarker, targetMarker) => {
    const projectRoot = await makeTempRoot();
    await mkdir(join(projectRoot, ".git"));
    const binRoot = await makeTempRoot();
    const codexPath = join(binRoot, "codex");
    await writeFile(codexPath, "#!/bin/sh\nexit 0\n", { mode: 0o755 });
    const bridge = new AgentBridge({
      adapters: [createCodexCliAdapter({ executablePath: codexPath })],
    });

    const run = await bridge.startRun({
      protocolVersion: RUN_EVENT_PROTOCOL_VERSION,
      nodeId: "node-codex-invalid-cwd",
      sessionId: "session-1",
      projectRoot,
      worktreePath: invalidWorktree,
      agentKind: "codex",
      prompt: "Implement the task",
    });

    const events = await loadRunEvents(projectRoot, run.id);
    const evidence = deriveEvidenceFromEvents(run, events);

    expect(events).toContainEqual(
      expect.objectContaining({
        kind: "error",
        payload: expect.objectContaining({ source: "codex", category: "invalid-cwd" }),
      }),
    );
    expect(evidence.status).toBe("failed");
    expect(evidence.checks).toContainEqual(
      expect.objectContaining({ kind: "run-exit", name: "Codex CLI preflight", status: "failed" }),
    );
    const serialized = JSON.stringify({ events, evidence });
    expect(serialized).not.toContain(invalidWorktree);
    expect(serialized).not.toContain(pathMarker);
    expect(serialized).not.toContain(targetMarker);
  });

  it("classifies Codex auth failures from non-zero CLI exits", async () => {
    const projectRoot = await makeTempRoot();
    await mkdir(join(projectRoot, ".git"));
    const binRoot = await makeTempRoot();
    const codexPath = join(binRoot, "codex");
    await writeFile(
      codexPath,
      [
        "#!/usr/bin/env node",
        "process.stderr.write('not logged in; authentication required\\n');",
        "process.exit(1);",
      ].join("\n"),
      { mode: 0o755 },
    );
    const bridge = new AgentBridge({
      adapters: [createCodexCliAdapter({ executablePath: codexPath })],
    });
    const failed = waitForEvent(bridge, (event) => event.kind === "status" && event.payload.status === "failed");

    const run = await bridge.startRun({
      protocolVersion: RUN_EVENT_PROTOCOL_VERSION,
      nodeId: "node-codex-auth",
      sessionId: "session-1",
      projectRoot,
      worktreePath: projectRoot,
      agentKind: "codex",
      prompt: "Implement the task",
    });
    await failed;

    const events = await loadRunEvents(projectRoot, run.id);
    const evidence = deriveEvidenceFromEvents(run, events);

    expect(events).toContainEqual(
      expect.objectContaining({
        kind: "error",
        payload: expect.objectContaining({ source: "codex", category: "auth-missing" }),
      }),
    );
    expect(events).toContainEqual(
      expect.objectContaining({
        kind: "status",
        payload: expect.objectContaining({ status: "failed", reason: "auth-missing" }),
      }),
    );
    expect(evidence.status).toBe("failed");
    expect(evidence.exitCode).toBe(1);
  });

  it("redacts secret-like values from Codex stderr progress and failure events", async () => {
    const projectRoot = await makeTempRoot();
    await mkdir(join(projectRoot, ".git"));
    const binRoot = await makeTempRoot();
    const codexPath = join(binRoot, "codex");
    const accessToken = "access-token-secret-123456";
    const apiKey = "sk-secretvalue123456";
    await writeFile(
      codexPath,
      [
        "#!/usr/bin/env node",
        `process.stderr.write('not logged in; OPENAI_API_KEY="${apiKey}" access_token="${accessToken}"\\n');`,
        `process.stderr.write(JSON.stringify({ OPENAI_API_KEY: "${apiKey}", access_token: "${accessToken}" }) + '\\n');`,
        "process.exit(1);",
      ].join("\n"),
      { mode: 0o755 },
    );
    const bridge = new AgentBridge({
      adapters: [createCodexCliAdapter({ executablePath: codexPath })],
    });
    const failed = waitForEvent(bridge, (event) => event.kind === "status" && event.payload.status === "failed");

    const run = await bridge.startRun({
      protocolVersion: RUN_EVENT_PROTOCOL_VERSION,
      nodeId: "node-codex-secret-stderr",
      sessionId: "session-1",
      projectRoot,
      worktreePath: projectRoot,
      agentKind: "codex",
      prompt: "Implement the task",
    });
    await failed;

    const serializedEvents = JSON.stringify(await loadRunEvents(projectRoot, run.id));

    expect(serializedEvents).not.toContain(apiKey);
    expect(serializedEvents).not.toContain(accessToken);
    expect(serializedEvents).toContain("[redacted]");
  });

  it("preserves Codex JSON stdout auth failures after non-zero close", async () => {
    const projectRoot = await makeTempRoot();
    await mkdir(join(projectRoot, ".git"));
    const binRoot = await makeTempRoot();
    const codexPath = join(binRoot, "codex");
    const secretAccessToken = "stdout-access-token-secret-123456";
    await writeFile(
      codexPath,
      [
        "#!/usr/bin/env node",
        "process.stdout.write(JSON.stringify({",
        "  type: 'turn.failed',",
        `  error: { message: 'not logged in; authentication required {"access_token":"${secretAccessToken}"}' },`,
        "}) + '\\n');",
        "process.exit(1);",
      ].join("\n"),
      { mode: 0o755 },
    );
    const bridge = new AgentBridge({
      adapters: [createCodexCliAdapter({ executablePath: codexPath })],
    });
    const failed = waitForEvent(bridge, (event) => event.kind === "status" && event.payload.status === "failed");

    const run = await bridge.startRun({
      protocolVersion: RUN_EVENT_PROTOCOL_VERSION,
      nodeId: "node-codex-json-auth",
      sessionId: "session-1",
      projectRoot,
      worktreePath: projectRoot,
      agentKind: "codex",
      prompt: "Implement the task",
    });
    await failed;

    const events = await loadRunEvents(projectRoot, run.id);
    const evidence = deriveEvidenceFromEvents(run, events);

    expect(events).toContainEqual(
      expect.objectContaining({
        kind: "error",
        payload: expect.objectContaining({ source: "codex", category: "auth-missing" }),
      }),
    );
    expect(events).not.toContainEqual(
      expect.objectContaining({
        kind: "error",
        payload: expect.objectContaining({ source: "codex", category: "non-zero-exit" }),
      }),
    );
    expect(events).toContainEqual(
      expect.objectContaining({
        kind: "status",
        payload: expect.objectContaining({ status: "failed", reason: "auth-missing" }),
      }),
    );
    expect(evidence.status).toBe("failed");
    expect(evidence.exitCode).toBe(1);
    expect(evidence.errorReason).toContain("not logged in");
    expect(evidence.errorReason).not.toContain(secretAccessToken);
    expect(JSON.stringify(events)).not.toContain(secretAccessToken);
  });

  it("sanitizes paths and secrets before emitting Codex non-zero-exit events", async () => {
    await assertPublicFailureSanitized("codex");
  });

  it("classifies Codex non-zero exits separately from auth failures", async () => {
    const projectRoot = await makeTempRoot();
    await mkdir(join(projectRoot, ".git"));
    const binRoot = await makeTempRoot();
    const codexPath = join(binRoot, "codex");
    await writeFile(
      codexPath,
      ["#!/usr/bin/env node", "process.stderr.write('syntax error\\n');", "process.exit(2);"].join("\n"),
      { mode: 0o755 },
    );
    const bridge = new AgentBridge({
      adapters: [createCodexCliAdapter({ executablePath: codexPath })],
    });
    const failed = waitForEvent(bridge, (event) => event.kind === "status" && event.payload.status === "failed");

    const run = await bridge.startRun({
      protocolVersion: RUN_EVENT_PROTOCOL_VERSION,
      nodeId: "node-codex-nonzero",
      sessionId: "session-1",
      projectRoot,
      worktreePath: projectRoot,
      agentKind: "codex",
      prompt: "Implement the task",
    });
    await failed;

    const events = await loadRunEvents(projectRoot, run.id);

    expect(events).toContainEqual(
      expect.objectContaining({
        kind: "error",
        payload: expect.objectContaining({ source: "codex", category: "non-zero-exit" }),
      }),
    );
    expect(deriveEvidenceFromEvents(run, events).exitCode).toBe(2);
  });

  it("marks invalid Codex JSON stdout as an output-parse-error progress category", async () => {
    const projectRoot = await makeTempRoot();
    await mkdir(join(projectRoot, ".git"));
    const binRoot = await makeTempRoot();
    const codexPath = join(binRoot, "codex");
    await writeFile(
      codexPath,
      [
        "#!/usr/bin/env node",
        "process.stdout.write('not-json\\n');",
        "process.stdout.write('{\"type\":\"turn.completed\"}\\n');",
      ].join("\n"),
      { mode: 0o755 },
    );
    const bridge = new AgentBridge({
      adapters: [createCodexCliAdapter({ executablePath: codexPath })],
    });
    const completed = waitForEvent(
      bridge,
      (event) => event.kind === "status" && event.payload.status === "succeeded",
    );

    const run = await bridge.startRun({
      protocolVersion: RUN_EVENT_PROTOCOL_VERSION,
      nodeId: "node-codex-parse",
      sessionId: "session-1",
      projectRoot,
      worktreePath: projectRoot,
      agentKind: "codex",
      prompt: "Implement the task",
    });
    await completed;

    const events = await loadRunEvents(projectRoot, run.id);

    expect(events).toContainEqual(
      expect.objectContaining({
        kind: "progress",
        payload: expect.objectContaining({ source: "codex", category: "output-parse-error" }),
      }),
    );
  });

  it("maps Codex structured file changes to change events without treating agent prose as truth", async () => {
    const projectRoot = await makeTempRoot();
    await mkdir(join(projectRoot, ".git"));
    const binRoot = await makeTempRoot();
    const codexPath = join(binRoot, "codex");
    await writeFile(
      codexPath,
      [
        "#!/usr/bin/env node",
        "process.stdout.write('{\"type\":\"item.completed\",\"item\":{\"type\":\"agent_message\",\"text\":\"I changed src/prose.ts\"}}\\n');",
        "process.stdout.write(JSON.stringify({type:\"item.completed\",item:{type:\"file_change\",operation:\"update\",path:\"src/index.ts\",diff:\"diff --git a/src/index.ts b/src/index.ts\"}}) + \"\\n\");",
        "process.stdout.write(JSON.stringify({type:\"turn.diff\",changes:[{operation:\"add\",path:\"src/new.ts\",unified_diff:\"diff --git a/src/new.ts b/src/new.ts\"}]}) + \"\\n\");",
        "process.stdout.write('{\"type\":\"turn.completed\"}\\n');",
      ].join("\n"),
      { mode: 0o755 },
    );
    const bridge = new AgentBridge({
      adapters: [createCodexCliAdapter({ executablePath: codexPath })],
    });
    const completed = waitForEvent(
      bridge,
      (event) => event.kind === "status" && event.payload.status === "succeeded",
    );

    const run = await bridge.startRun({
      protocolVersion: RUN_EVENT_PROTOCOL_VERSION,
      nodeId: "node-codex-changes",
      sessionId: "session-1",
      projectRoot,
      worktreePath: projectRoot,
      agentKind: "codex",
      prompt: "Implement the task",
    });
    await completed;

    const events = await loadRunEvents(projectRoot, run.id);
    const changeEvents = events.filter((event) => event.kind === "changes");
    const changedFiles = changeEvents.flatMap((event) => event.payload.files as string[]);

    expect(events.find((event) => event.kind === "output")?.payload.text).toBe("I changed src/prose.ts");
    expect(changedFiles).toEqual(["src/index.ts", "src/new.ts"]);
    expect(JSON.stringify(changeEvents)).not.toContain("src/prose.ts");
    expect(changeEvents[0]?.payload.changes).toEqual([
      {
        operation: "update",
        path: "src/index.ts",
        unifiedDiff: "diff --git a/src/index.ts b/src/index.ts",
      },
    ]);
  });

  it("runs Codex from the canonical workdir so sandboxed git writes can reach .git", async () => {
    const root = await makeTempRoot();
    const projectRoot = join(root, "project");
    const projectLink = join(root, "project-link");
    await mkdir(join(projectRoot, ".git"), { recursive: true });
    await symlink(projectRoot, projectLink);
    const binRoot = await makeTempRoot();
    const argsPath = join(binRoot, "args.json");
    const codexPath = join(binRoot, "codex");
    await writeFile(
      codexPath,
      [
        "#!/usr/bin/env node",
        "const fs = require('node:fs');",
        "fs.writeFileSync(process.env.SKYTURN_CODEX_ARGS_PATH, JSON.stringify({",
        "  argv: process.argv.slice(2),",
        "  cwd: process.cwd(),",
        "}));",
        "process.stdout.write('{\"type\":\"turn.completed\"}\\n');",
      ].join("\n"),
      { mode: 0o755 },
    );
    const bridge = new AgentBridge({
      adapters: [
        createCodexCliAdapter({
          executablePath: codexPath,
          env: { SKYTURN_CODEX_ARGS_PATH: argsPath },
          sandbox: "workspace-write",
        }),
      ],
    });
    const completed = waitForEvent(
      bridge,
      (event) => event.kind === "status" && event.payload.status === "succeeded",
    );

    await bridge.startRun({
      protocolVersion: RUN_EVENT_PROTOCOL_VERSION,
      nodeId: "node-codex-link",
      sessionId: "session-1",
      projectRoot: projectLink,
      worktreePath: projectLink,
      agentKind: "codex",
      prompt: "Commit the task",
    });
    await completed;

    const args = JSON.parse(await readFile(argsPath, "utf8")) as { argv: string[]; cwd: string };
    const canonicalRoot = await realpath(projectRoot);

    expect(args.cwd).toBe(canonicalRoot);
    expect(args.argv).toContain(canonicalRoot);
    expect(args.argv).not.toContain(projectLink);
  });

  it("lets a single Codex run override the adapter sandbox", async () => {
    const projectRoot = await makeTempRoot();
    await mkdir(join(projectRoot, ".git"));
    const binRoot = await makeTempRoot();
    const argsPath = join(binRoot, "args.json");
    const codexPath = join(binRoot, "codex");
    await writeFile(
      codexPath,
      [
        "#!/usr/bin/env node",
        "const fs = require('node:fs');",
        "fs.writeFileSync(process.env.SKYTURN_CODEX_ARGS_PATH, JSON.stringify({",
        "  argv: process.argv.slice(2),",
        "}));",
        "process.stdout.write('{\"type\":\"turn.completed\"}\\n');",
      ].join("\n"),
      { mode: 0o755 },
    );
    const bridge = new AgentBridge({
      adapters: [
        createCodexCliAdapter({
          executablePath: codexPath,
          env: { SKYTURN_CODEX_ARGS_PATH: argsPath },
          sandbox: "read-only",
        }),
      ],
    });
    const completed = waitForEvent(
      bridge,
      (event) => event.kind === "status" && event.payload.status === "succeeded",
    );

    await bridge.startRun({
      protocolVersion: RUN_EVENT_PROTOCOL_VERSION,
      nodeId: "node-codex-commit",
      sessionId: "session-1",
      projectRoot,
      worktreePath: projectRoot,
      agentKind: "codex",
      sandbox: "danger-full-access",
      prompt: "Commit the task",
    });
    await completed;

    const args = JSON.parse(await readFile(argsPath, "utf8")) as { argv: string[] };
    const sandboxIndex = args.argv.indexOf("--sandbox");

    expect(sandboxIndex).toBeGreaterThanOrEqual(0);
    expect(args.argv[sandboxIndex + 1]).toBe("danger-full-access");
  });

  it("emits non-terminal stalled telemetry before the Codex CLI hard timeout", async () => {
    const projectRoot = await makeTempRoot();
    await mkdir(join(projectRoot, ".git"));
    const binRoot = await makeTempRoot();
    const codexPath = join(binRoot, "codex");
    await writeFile(
      codexPath,
      [
        "#!/usr/bin/env node",
        "process.stdout.write('{\"type\":\"turn.started\"}\\n');",
        "setInterval(() => {}, 1000);",
      ].join("\n"),
      { mode: 0o755 },
    );
    const bridge = new AgentBridge({
      adapters: [
        createCodexCliAdapter({
          executablePath: codexPath,
          stallTelemetryMs: 25,
        }),
      ],
    });
    const events: RunEvent[] = [];
    const unsubscribe = bridge.onRunEvent((event) => events.push(event));
    const stalled = waitForEvent(
      bridge,
      (event) => event.kind === "progress" && event.payload.phase === "stalled",
    );

    const run = await bridge.startRun({
      protocolVersion: RUN_EVENT_PROTOCOL_VERSION,
      nodeId: "node-codex-long",
      sessionId: "session-1",
      projectRoot,
      worktreePath: projectRoot,
      agentKind: "codex",
      prompt: "Run as long as needed",
    });
    await stalled;

    expect(events).toContainEqual(
      expect.objectContaining({
        kind: "progress",
        payload: expect.objectContaining({
          source: "codex",
          phase: "stalled",
          status: "running",
        }),
      }),
    );
    expect(events).not.toContainEqual(
      expect.objectContaining({
        kind: "status",
        payload: expect.objectContaining({ status: "timed-out" }),
      }),
    );

    unsubscribe();
    await bridge.cancelRun(run.id, "test cleanup");
  });

  it("times out a Codex CLI run through the default watchdog", async () => {
    const projectRoot = await makeTempRoot();
    await mkdir(join(projectRoot, ".git"));
    const binRoot = await makeTempRoot();
    const codexPath = join(binRoot, "codex");
    await writeFile(
      codexPath,
      [
        "#!/usr/bin/env node",
        "process.stdout.write('{\"type\":\"turn.started\"}\\n');",
        "setInterval(() => {}, 1000);",
      ].join("\n"),
      { mode: 0o755 },
    );
    const bridge = new AgentBridge({
      adapters: [
        createCodexCliAdapter({
          executablePath: codexPath,
          defaultWatchdogTimeoutMs: testDefaultWatchdogTimeoutMs,
          killTimeoutMs: 100,
        }),
      ],
    });
    const events: RunEvent[] = [];
    const unsubscribe = bridge.onRunEvent((event) => events.push(event));
    const timedOut = waitForEvent(
      bridge,
      (event) => event.kind === "status" && event.payload.status === "timed-out",
    );
    let run: Awaited<ReturnType<AgentBridge["startRun"]>> | null = null;

    try {
      run = await bridge.startRun({
        protocolVersion: RUN_EVENT_PROTOCOL_VERSION,
        nodeId: "node-codex-default-timeout",
        sessionId: "session-1",
        projectRoot,
        worktreePath: projectRoot,
        agentKind: "codex",
        prompt: "Hang forever",
      });
      await timedOut;

      expect(events).toContainEqual(
        expect.objectContaining({
          kind: "evidence",
          payload: expect.objectContaining({
            exitCode: null,
            checks: [
              {
                kind: "run-timeout",
                name: "Codex CLI watchdog",
                status: "failed",
                detail: `timed out after ${testDefaultWatchdogTimeoutMs}ms`,
              },
            ],
          }),
        }),
      );
      expect(events).toContainEqual(
        expect.objectContaining({
          kind: "status",
          payload: expect.objectContaining({ status: "timed-out" }),
        }),
      );
    } finally {
      unsubscribe();
      if (run && !events.some((event) => event.kind === "status" && event.payload.status === "timed-out")) {
        await bridge.cancelRun(run.id, "test cleanup");
      }
    }
  });

  it("allocates a new attempt run id and event path when retrying the same node", async () => {
    const projectRoot = await makeTempRoot();
    await mkdir(join(projectRoot, ".git"));
    const binRoot = await makeTempRoot();
    const codexPath = join(binRoot, "codex");
    await writeFile(
      codexPath,
      [
        "#!/usr/bin/env node",
        "process.stdout.write('{\"type\":\"turn.completed\"}\\n');",
      ].join("\n"),
      { mode: 0o755 },
    );
    const bridge = new AgentBridge({
      adapters: [createCodexCliAdapter({ executablePath: codexPath })],
    });
    const input = {
      protocolVersion: RUN_EVENT_PROTOCOL_VERSION,
      nodeId: "node-codex-retry",
      sessionId: "session-1",
      projectRoot,
      worktreePath: projectRoot,
      agentKind: "codex" as const,
      prompt: "Try again",
    };

    const firstDone = waitForEvent(
      bridge,
      (event) => event.kind === "status" && event.payload.status === "succeeded",
    );
    const first = await bridge.startRun(input);
    await firstDone;
    const secondDone = waitForEvent(
      bridge,
      (event) => event.kind === "status" && event.payload.status === "succeeded",
    );
    const second = await bridge.startRun(input);
    await secondDone;

    expect(first.id).toBe("run-session-1-node-codex-retry");
    expect(second.id).toBe("run-session-1-node-codex-retry-attempt-2");
    const firstEvents = await loadRunEvents(projectRoot, first.id);
    const secondEvents = await loadRunEvents(projectRoot, second.id);
    expect(firstEvents.length).toBeGreaterThan(0);
    expect(secondEvents.length).toBeGreaterThan(0);
    expect(new Set(firstEvents.map((event) => event.runId))).toEqual(new Set([first.id]));
    expect(new Set(secondEvents.map((event) => event.runId))).toEqual(new Set([second.id]));
  });

  it("times out a stalled Codex CLI run instead of leaving the card running", async () => {
    const projectRoot = await makeTempRoot();
    await mkdir(join(projectRoot, ".git"));
    const binRoot = await makeTempRoot();
    const codexPath = join(binRoot, "codex");
    await writeFile(
      codexPath,
      [
        "#!/usr/bin/env node",
        "process.stdout.write('{\"type\":\"turn.started\"}\\n');",
        "process.stdout.write('{\"type\":\"item.completed\",\"item\":{\"type\":\"agent_message\",\"text\":\"started but never closed\"}}\\n');",
        "process.on('SIGTERM', () => {});",
        "setInterval(() => {}, 1000);",
      ].join("\n"),
      { mode: 0o755 },
    );
    const bridge = new AgentBridge({
      adapters: [
        createCodexCliAdapter({
          executablePath: codexPath,
          defaultWatchdogTimeoutMs: 5_000,
          timeoutMs: 500,
          killTimeoutMs: 100,
        }),
      ],
    });
    const timedOut = waitForEvent(
      bridge,
      (event) => event.kind === "status" && event.payload.status === "timed-out",
    );
    const outputStarted = waitForEvent(
      bridge,
      (event) =>
        event.kind === "output" &&
        typeof event.payload.text === "string" &&
        event.payload.text.includes("started but never closed"),
    );

    const run = await bridge.startRun({
      protocolVersion: RUN_EVENT_PROTOCOL_VERSION,
      nodeId: "node-codex-timeout",
      sessionId: "session-1",
      projectRoot,
      worktreePath: projectRoot,
      agentKind: "codex",
      prompt: "Hang forever",
    });
    await outputStarted;
    await timedOut;

    const events = await loadRunEvents(projectRoot, run.id);
    const evidence = deriveEvidenceFromEvents(run, events);
    const output = await readTaskOutput(projectRoot, "node-codex-timeout");

    expect(output).toContain("started but never closed");
    expect(evidence.status).toBe("timed-out");
    expect(evidence.checks).toContainEqual({
      kind: "run-timeout",
      name: "Codex CLI watchdog",
      status: "failed",
      detail: "timed out after 500ms",
    });
    expect(events.filter((event) => event.kind === "evidence").length).toBe(1);
    expect(events.filter((event) => event.kind === "status" && event.payload.status === "timed-out").length).toBe(1);
  });

  it("does not let late Codex stdout status overwrite a timed-out run", async () => {
    const projectRoot = await makeTempRoot();
    await mkdir(join(projectRoot, ".git"));
    const binRoot = await makeTempRoot();
    const codexPath = join(binRoot, "codex");
    await writeFile(
      codexPath,
      [
        "#!/usr/bin/env node",
        "process.stdout.write('{\"type\":\"turn.started\"}\\n');",
        "process.on('SIGTERM', () => {",
        "  process.stdout.write('{\"type\":\"turn.started\"}\\n');",
        "});",
        "setInterval(() => {}, 1000);",
      ].join("\n"),
      { mode: 0o755 },
    );
    const bridge = new AgentBridge({
      adapters: [
        createCodexCliAdapter({
          executablePath: codexPath,
          timeoutMs: 250,
          killTimeoutMs: 1_000,
        }),
      ],
    });
    const timedOut = waitForEvent(
      bridge,
      (event) => event.kind === "status" && event.payload.status === "timed-out",
    );

    const run = await bridge.startRun({
      protocolVersion: RUN_EVENT_PROTOCOL_VERSION,
      nodeId: "node-codex-late-output-timeout",
      sessionId: "session-1",
      projectRoot,
      worktreePath: projectRoot,
      agentKind: "codex",
      prompt: "Hang then emit after timeout",
    });
    await timedOut;
    await new Promise((resolve) => setTimeout(resolve, 250));

    const events = await loadRunEvents(projectRoot, run.id);
    const timedOutIndex = events.findIndex((event) => event.kind === "status" && event.payload.status === "timed-out");
    expect(timedOutIndex).toBeGreaterThanOrEqual(0);
    expect(events.slice(timedOutIndex + 1)).not.toContainEqual(
      expect.objectContaining({
        kind: "status",
        payload: expect.objectContaining({ status: "running" }),
      }),
    );
    expect(deriveEvidenceFromEvents(run, events).status).toBe("timed-out");
  });

  it("records timed-out status when timeout evidence listeners throw", async () => {
    const projectRoot = await makeTempRoot();
    await mkdir(join(projectRoot, ".git"));
    const binRoot = await makeTempRoot();
    const codexPath = join(binRoot, "codex");
    await writeFile(
      codexPath,
      [
        "#!/usr/bin/env node",
        "process.stdout.write('{\"type\":\"turn.started\"}\\n');",
        "setInterval(() => {}, 1000);",
      ].join("\n"),
      { mode: 0o755 },
    );
    const bridge = new AgentBridge({
      adapters: [
        createCodexCliAdapter({
          executablePath: codexPath,
          timeoutMs: 250,
          killTimeoutMs: 100,
        }),
      ],
    });
    const unsubscribe = bridge.onRunEvent((event) => {
      if (event.kind === "evidence") throw new Error("listener failed");
    });

    try {
      const run = await bridge.startRun({
        protocolVersion: RUN_EVENT_PROTOCOL_VERSION,
        nodeId: "node-codex-timeout-listener-throws",
        sessionId: "session-1",
        projectRoot,
        worktreePath: projectRoot,
        agentKind: "codex",
        prompt: "Hang forever",
      });
      await waitForPersistedEvent(projectRoot, run.id, (event) => event.kind === "evidence");
      await new Promise((resolve) => setTimeout(resolve, 100));

      const events = await loadRunEvents(projectRoot, run.id);
      expect(events).toContainEqual(
        expect.objectContaining({
          kind: "status",
          payload: expect.objectContaining({ status: "timed-out" }),
        }),
      );
      expect(deriveEvidenceFromEvents(run, events).status).toBe("timed-out");
    } finally {
      unsubscribe();
    }
  });

  it("kills Codex child process groups on timeout", async () => {
    if (process.platform === "win32") return;
    const projectRoot = await makeTempRoot();
    await mkdir(join(projectRoot, ".git"));
    const binRoot = await makeTempRoot();
    const childPidPath = join(binRoot, "child.pid");
    const codexPath = join(binRoot, "codex");
    await writeFile(
      codexPath,
      [
        "#!/usr/bin/env node",
        "const fs = require('node:fs');",
        "const { spawn } = require('node:child_process');",
        "const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore' });",
        "fs.writeFileSync(process.env.SKYTURN_CHILD_PID_PATH, String(child.pid));",
        "process.stdout.write('{\"type\":\"turn.started\"}\\n');",
        "setInterval(() => {}, 1000);",
      ].join("\n"),
      { mode: 0o755 },
    );
    const bridge = new AgentBridge({
      adapters: [
        createCodexCliAdapter({
          executablePath: codexPath,
          env: { SKYTURN_CHILD_PID_PATH: childPidPath },
          timeoutMs: 500,
          killTimeoutMs: 250,
        }),
      ],
    });
    const timedOut = waitForEvent(
      bridge,
      (event) => event.kind === "status" && event.payload.status === "timed-out",
    );

    await bridge.startRun({
      protocolVersion: RUN_EVENT_PROTOCOL_VERSION,
      nodeId: "node-codex-process-group-timeout",
      sessionId: "session-1",
      projectRoot,
      worktreePath: projectRoot,
      agentKind: "codex",
      prompt: "Hang with a child process",
    });
    const childPid = Number(await waitForFile(childPidPath));
    await timedOut;
    await new Promise((resolve) => setTimeout(resolve, 500));

    expect(isPidAlive(childPid)).toBe(false);
  });

  it("kills Codex child processes when the workspace event mirror is read-only", async () => {
    if (process.platform === "win32") return;
    const projectRoot = await makeTempRoot();
    await mkdir(join(projectRoot, ".git"));
    const binRoot = await makeTempRoot();
    const parentPidPath = join(binRoot, "parent.pid");
    const codexPath = join(binRoot, "codex");
    await writeFile(
      codexPath,
      [
        "#!/usr/bin/env node",
        "const fs = require('node:fs');",
        "fs.writeFileSync(process.env.SKYTURN_PARENT_PID_PATH, String(process.pid));",
        "process.on('SIGTERM', () => {});",
        "process.stdout.write('{\"type\":\"turn.started\"}\\n');",
        "setInterval(() => {}, 1000);",
      ].join("\n"),
      { mode: 0o755 },
    );
    const bridge = new AgentBridge({
      adapters: [
        createCodexCliAdapter({
          executablePath: codexPath,
          env: { SKYTURN_PARENT_PID_PATH: parentPidPath },
          killTimeoutMs: 100,
        }),
      ],
    });
    const run = await bridge.startRun({
      protocolVersion: RUN_EVENT_PROTOCOL_VERSION,
      nodeId: "node-codex-cancel-persistence-fails",
      sessionId: "session-1",
      projectRoot,
      worktreePath: projectRoot,
      agentKind: "codex",
      prompt: "Cancel me",
    });
    const parentPid = Number(await waitForFile(parentPidPath));
    const eventsPath = join(projectRoot, ".devflow", "runs", run.id, "events.ndjson");
    await chmod(eventsPath, 0o400);

    try {
      await expect(bridge.cancelRun(run.id, "User stopped the run")).resolves.toMatchObject({
        status: "cancelled",
        cancelReason: "User stopped the run",
      });
      await new Promise((resolve) => setTimeout(resolve, 350));

      expect(isPidAlive(parentPid)).toBe(false);
    } finally {
      await chmod(eventsPath, 0o600);
      killPid(parentPid);
    }
  });

  it("kills Codex child process groups on explicit cancel", async () => {
    if (process.platform === "win32") return;
    const projectRoot = await makeTempRoot();
    await mkdir(join(projectRoot, ".git"));
    const binRoot = await makeTempRoot();
    const parentPidPath = join(binRoot, "parent.pid");
    const childPidPath = join(binRoot, "child.pid");
    const codexPath = join(binRoot, "codex");
    await writeFile(
      codexPath,
      [
        "#!/usr/bin/env node",
        "const fs = require('node:fs');",
        "const { spawn } = require('node:child_process');",
        "fs.writeFileSync(process.env.SKYTURN_PARENT_PID_PATH, String(process.pid));",
        "const child = spawn(process.execPath, ['-e', 'process.on(\"SIGTERM\", () => {}); setInterval(() => {}, 1000)'], { stdio: 'ignore' });",
        "fs.writeFileSync(process.env.SKYTURN_CHILD_PID_PATH, String(child.pid));",
        "process.on('SIGTERM', () => {});",
        "process.stdout.write('{\"type\":\"turn.started\"}\\n');",
        "setInterval(() => {}, 1000);",
      ].join("\n"),
      { mode: 0o755 },
    );
    const bridge = new AgentBridge({
      adapters: [
        createCodexCliAdapter({
          executablePath: codexPath,
          env: {
            SKYTURN_PARENT_PID_PATH: parentPidPath,
            SKYTURN_CHILD_PID_PATH: childPidPath,
          },
          killTimeoutMs: 100,
        }),
      ],
    });

    const run = await bridge.startRun({
      protocolVersion: RUN_EVENT_PROTOCOL_VERSION,
      nodeId: "node-codex-cancel",
      sessionId: "session-1",
      projectRoot,
      worktreePath: projectRoot,
      agentKind: "codex",
      prompt: "Cancel me",
    });
    const parentPid = Number(await waitForFile(parentPidPath));
    const childPid = Number(await waitForFile(childPidPath));

    try {
      await bridge.cancelRun(run.id, "User stopped the run");
      await new Promise((resolve) => setTimeout(resolve, 350));

      expect(isPidAlive(parentPid)).toBe(false);
      expect(isPidAlive(childPid)).toBe(false);
    } finally {
      killPid(parentPid);
      killPid(childPid);
    }
  });

  it("keeps killing the Codex process group after the parent exits on cancel", async () => {
    if (process.platform === "win32") return;
    const projectRoot = await makeTempRoot();
    await mkdir(join(projectRoot, ".git"));
    const binRoot = await makeTempRoot();
    const childPidPath = join(binRoot, "child.pid");
    const childReadyPath = join(binRoot, "child.ready");
    const childPath = join(binRoot, "stubborn-child.js");
    const codexPath = join(binRoot, "codex");
    await writeFile(
      childPath,
      [
        "const fs = require('node:fs');",
        "process.on('SIGTERM', () => {});",
        "fs.writeFileSync(process.env.SKYTURN_CHILD_READY_PATH, 'ready');",
        "setInterval(() => {}, 1000);",
      ].join("\n"),
    );
    await writeFile(
      codexPath,
      [
        "#!/usr/bin/env node",
        "const fs = require('node:fs');",
        "const { spawn } = require('node:child_process');",
        "const child = spawn(process.execPath, [process.env.SKYTURN_CHILD_PATH], {",
        "  env: process.env,",
        "  stdio: 'ignore',",
        "});",
        "fs.writeFileSync(process.env.SKYTURN_CHILD_PID_PATH, String(child.pid));",
        "process.stdout.write('{\"type\":\"turn.started\"}\\n');",
        "setInterval(() => {}, 1000);",
      ].join("\n"),
      { mode: 0o755 },
    );
    const bridge = new AgentBridge({
      adapters: [
        createCodexCliAdapter({
          executablePath: codexPath,
          env: {
            SKYTURN_CHILD_PATH: childPath,
            SKYTURN_CHILD_PID_PATH: childPidPath,
            SKYTURN_CHILD_READY_PATH: childReadyPath,
          },
          killTimeoutMs: 100,
        }),
      ],
    });

    const run = await bridge.startRun({
      protocolVersion: RUN_EVENT_PROTOCOL_VERSION,
      nodeId: "node-codex-parent-exits",
      sessionId: "session-1",
      projectRoot,
      worktreePath: projectRoot,
      agentKind: "codex",
      prompt: "Cancel me",
    });
    const childPid = Number(await waitForFile(childPidPath));
    await waitForFile(childReadyPath);

    try {
      await bridge.cancelRun(run.id, "User stopped the run");
      await new Promise((resolve) => setTimeout(resolve, 350));

      expect(isPidAlive(childPid)).toBe(false);
    } finally {
      killPid(childPid);
    }
  });

  it("joins cancel to an in-flight timeout until the parent and stubborn child are reaped", async () => {
    if (process.platform === "win32") return;
    const projectRoot = await makeTempRoot();
    await mkdir(join(projectRoot, ".git"));
    const binRoot = await makeTempRoot();
    const parentPidPath = join(binRoot, "timeout-parent.pid");
    const childPidPath = join(binRoot, "timeout-child.pid");
    const childReadyPath = join(binRoot, "timeout-child.ready");
    const childPath = join(binRoot, "timeout-stubborn-child.js");
    const codexPath = join(binRoot, "codex-timeout-race");
    await writeFile(
      childPath,
      [
        "const fs = require('node:fs');",
        "process.on('SIGTERM', () => {});",
        "fs.writeFileSync(process.env.SKYTURN_CHILD_READY_PATH, 'ready');",
        "setInterval(() => {}, 1000);",
      ].join("\n"),
    );
    await writeFile(
      codexPath,
      [
        "#!/usr/bin/env node",
        "const fs = require('node:fs');",
        "const { spawn } = require('node:child_process');",
        "fs.writeFileSync(process.env.SKYTURN_PARENT_PID_PATH, String(process.pid));",
        "const child = spawn(process.execPath, [process.env.SKYTURN_CHILD_PATH], { env: process.env, stdio: 'ignore' });",
        "fs.writeFileSync(process.env.SKYTURN_CHILD_PID_PATH, String(child.pid));",
        "process.stdout.write('{\"type\":\"turn.started\"}\\n');",
        "setInterval(() => {}, 1000);",
      ].join("\n"),
      { mode: 0o755 },
    );
    let retainedFd = -1;
    const bridge = new AgentBridge({
      adapters: [
        createCodexCliAdapter({
          executablePath: codexPath,
          env: {
            SKYTURN_PARENT_PID_PATH: parentPidPath,
            SKYTURN_CHILD_PATH: childPath,
            SKYTURN_CHILD_PID_PATH: childPidPath,
            SKYTURN_CHILD_READY_PATH: childReadyPath,
          },
          timeoutMs: 500,
          killTimeoutMs: 500,
          artifactVerificationHooks: { afterWorktreeOpen: (fd) => void (retainedFd = fd) },
        }),
      ],
    });
    const liveEvents: RunEvent[] = [];
    const unsubscribe = bridge.onRunEvent((event) => liveEvents.push(event));
    const timedOut = waitForEvent(
      bridge,
      (event) => event.kind === "status" && event.payload.status === "timed-out",
    );
    const run = await bridge.startRun({
      protocolVersion: RUN_EVENT_PROTOCOL_VERSION,
      nodeId: "node-codex-cancel-during-timeout",
      sessionId: "session-1",
      projectRoot,
      worktreePath: projectRoot,
      agentKind: "codex",
      prompt: "Timeout before cancellation",
    });
    const parentPid = Number(await waitForFile(parentPidPath));
    const childPid = Number(await waitForFile(childPidPath));
    await waitForFile(childReadyPath);

    try {
      await waitForCondition(
        () => !isPidAlive(parentPid) && isPidAlive(childPid),
        "timeout parent exit before stubborn child",
      );
      let cancelSettled = false;
      const cancelPromise = bridge.cancelRun(run.id, "Cancel during timeout").then((evidence) => {
        cancelSettled = true;
        return evidence;
      });
      await new Promise((resolve) => setTimeout(resolve, 50));
      const cancelSettledBeforeReap = cancelSettled;
      const fdClosedBeforeReap = isFileDescriptorClosed(retainedFd);

      const cancelEvidence = await cancelPromise;
      await timedOut;
      unsubscribe();
      const persistedEvents = await loadRunEvents(projectRoot, run.id);

      expect(cancelSettledBeforeReap).toBe(false);
      expect(fdClosedBeforeReap).toBe(false);
      expect(isPidAlive(parentPid)).toBe(false);
      expect(isPidAlive(childPid)).toBe(false);
      expect(() => fstatSync(retainedFd)).toThrow(expect.objectContaining({ code: "EBADF" }));
      expect(cancelEvidence.status).toBe("timed-out");
      for (const events of [liveEvents, persistedEvents]) {
        expect(events.filter((event) => event.kind === "evidence")).toHaveLength(1);
        expect(terminalRunStatuses(events).map((event) => event.payload.status)).toEqual(["timed-out"]);
      }
    } finally {
      unsubscribe();
      killPid(parentPid);
      killPid(childPid);
    }
  }, 15_000);

  it("keeps cancel authoritative when the timeout deadline passes before a stubborn child is reaped", async () => {
    if (process.platform === "win32") return;
    const projectRoot = await makeTempRoot();
    await mkdir(join(projectRoot, ".git"));
    const binRoot = await makeTempRoot();
    const parentPidPath = join(binRoot, "cancel-parent.pid");
    const childPidPath = join(binRoot, "cancel-child.pid");
    const childReadyPath = join(binRoot, "cancel-child.ready");
    const childPath = join(binRoot, "cancel-stubborn-child.js");
    const codexPath = join(binRoot, "codex-cancel-race");
    await writeFile(
      childPath,
      [
        "const fs = require('node:fs');",
        "process.on('SIGTERM', () => {});",
        "fs.writeFileSync(process.env.SKYTURN_CHILD_READY_PATH, 'ready');",
        "setInterval(() => {}, 1000);",
      ].join("\n"),
    );
    await writeFile(
      codexPath,
      [
        "#!/usr/bin/env node",
        "const fs = require('node:fs');",
        "const { spawn } = require('node:child_process');",
        "fs.writeFileSync(process.env.SKYTURN_PARENT_PID_PATH, String(process.pid));",
        "const child = spawn(process.execPath, [process.env.SKYTURN_CHILD_PATH], { env: process.env, stdio: 'ignore' });",
        "fs.writeFileSync(process.env.SKYTURN_CHILD_PID_PATH, String(child.pid));",
        "process.stdout.write('{\"type\":\"turn.started\"}\\n');",
        "setInterval(() => {}, 1000);",
      ].join("\n"),
      { mode: 0o755 },
    );
    let retainedFd = -1;
    const bridge = new AgentBridge({
      adapters: [
        createCodexCliAdapter({
          executablePath: codexPath,
          env: {
            SKYTURN_PARENT_PID_PATH: parentPidPath,
            SKYTURN_CHILD_PATH: childPath,
            SKYTURN_CHILD_PID_PATH: childPidPath,
            SKYTURN_CHILD_READY_PATH: childReadyPath,
          },
          timeoutMs: 500,
          killTimeoutMs: 800,
          artifactVerificationHooks: { afterWorktreeOpen: (fd) => void (retainedFd = fd) },
        }),
      ],
    });
    const liveEvents: RunEvent[] = [];
    const unsubscribe = bridge.onRunEvent((event) => liveEvents.push(event));
    const run = await bridge.startRun({
      protocolVersion: RUN_EVENT_PROTOCOL_VERSION,
      nodeId: "node-codex-timeout-during-cancel",
      sessionId: "session-1",
      projectRoot,
      worktreePath: projectRoot,
      agentKind: "codex",
      prompt: "Cancel before timeout",
    });
    const parentPid = Number(await waitForFile(parentPidPath));
    const childPid = Number(await waitForFile(childPidPath));
    await waitForFile(childReadyPath);

    try {
      let cancelSettled = false;
      const cancelStartedAt = Date.now();
      const cancelPromise = bridge.cancelRun(run.id, "Cancel before timeout").then((evidence) => {
        cancelSettled = true;
        return evidence;
      });
      await waitForCondition(
        () => !isPidAlive(parentPid) && isPidAlive(childPid),
        "cancelled parent exit before stubborn child",
      );
      const timeoutDeadlineDelay = Math.max(0, 550 - (Date.now() - cancelStartedAt));
      await new Promise((resolve) => setTimeout(resolve, timeoutDeadlineDelay));
      const cancelSettledBeforeReap = cancelSettled;
      const fdClosedBeforeReap = isFileDescriptorClosed(retainedFd);

      const cancelEvidence = await cancelPromise;
      unsubscribe();
      const persistedEvents = await loadRunEvents(projectRoot, run.id);

      expect(cancelSettledBeforeReap).toBe(false);
      expect(fdClosedBeforeReap).toBe(false);
      expect(isPidAlive(parentPid)).toBe(false);
      expect(isPidAlive(childPid)).toBe(false);
      expect(() => fstatSync(retainedFd)).toThrow(expect.objectContaining({ code: "EBADF" }));
      expect(cancelEvidence.status).toBe("cancelled");
      for (const events of [liveEvents, persistedEvents]) {
        expect(events.filter((event) => event.kind === "evidence")).toHaveLength(1);
        expect(terminalRunStatuses(events).map((event) => event.payload.status)).toEqual(["cancelled"]);
      }
    } finally {
      unsubscribe();
      killPid(parentPid);
      killPid(childPid);
    }
  }, 15_000);

  it("runs Hermes chat planning without oneshot -z and marks replay recovery honestly", async () => {
    const projectRoot = await makeTempRoot();
    const binRoot = await makeTempRoot();
    const argsPath = join(binRoot, "args.json");
    const hermesPath = join(binRoot, "hermes");
    await writeFile(
      hermesPath,
      [
        "#!/usr/bin/env node",
        "const fs = require('node:fs');",
        "fs.writeFileSync(process.env.SKYTURN_HERMES_ARGS_PATH, JSON.stringify({",
        "  argv: process.argv.slice(2),",
        "  cwd: process.cwd(),",
        "}));",
        "process.stderr.write('planning warning\\n');",
        "process.stdout.write('{\"toolCalls\":[{\"tool\":\"createWorkflowCard\",\"input\":{\"id\":\"node-code\",\"title\":\"Code\",\"agent\":\"codex\",\"brief\":\"Implement\"}}]}\\n');",
      ].join("\n"),
      { mode: 0o755 },
    );
    const bridge = new AgentBridge({
      adapters: [
        createHermesCliAdapter({
          executablePath: hermesPath,
          env: { SKYTURN_HERMES_ARGS_PATH: argsPath },
        }),
      ],
    });
    const completed = waitForEvent(
      bridge,
      (event) => event.kind === "status" && event.payload.status === "succeeded",
    );

    const run = await bridge.startRun({
      protocolVersion: RUN_EVENT_PROTOCOL_VERSION,
      nodeId: "node-hermes",
      sessionId: "session-1",
      plannerSessionId: "hermes-planner-session-1",
      plannerInputId: "requirement-1",
      projectRoot,
      worktreePath: projectRoot,
      agentKind: "hermes",
      prompt: "Plan a workflow",
    });
    await completed;

    const events = await loadRunEvents(projectRoot, run.id);
    const output = await readTaskOutput(projectRoot, "node-hermes");
    const evidence = deriveEvidenceFromEvents(run, events);
    const args = JSON.parse(await readFile(argsPath, "utf8")) as { argv: string[]; cwd: string };

    expect(args.cwd).toBe(await realpath(projectRoot));
    expect(args.argv).toEqual(["chat", "-q", "Plan a workflow", "--quiet", "--source", "skyturn"]);
    expect(args.argv).not.toContain("-z");
    expect(run).toMatchObject({
      plannerSessionId: "hermes-planner-session-1",
      plannerInputId: "requirement-1",
    });
    expect(events).toContainEqual(
      expect.objectContaining({
        kind: "progress",
        payload: expect.objectContaining({
          source: "hermes",
          plannerSessionId: "hermes-planner-session-1",
          plannerInputId: "requirement-1",
          transport: "hermes_replay_recovery",
          recoveryReason: expect.stringContaining("not the same Hermes native session"),
        }),
      }),
    );
    expect(output).toContain("createWorkflowCard");
    expect(events.some((event) => event.kind === "progress" && event.payload.stream === "stderr")).toBe(true);
    expect(evidence.status).toBe("succeeded");
    expect(evidence.exitCode).toBe(0);
    expect(evidence.checks).toContainEqual({
      kind: "run-exit",
      name: "Hermes CLI exit",
      status: "passed",
      detail: "exit 0",
    });
  });

  it("runs Hermes from the canonical worktree path when provided", async () => {
    const root = await makeTempRoot();
    const projectRoot = join(root, "project");
    const worktreeRoot = join(root, "managed-worktree");
    const worktreeLink = join(root, "managed-worktree-link");
    await mkdir(projectRoot);
    await mkdir(worktreeRoot);
    await symlink(worktreeRoot, worktreeLink);
    const binRoot = await makeTempRoot();
    const argsPath = join(binRoot, "args.json");
    const hermesPath = join(binRoot, "hermes");
    await writeFile(
      hermesPath,
      [
        "#!/usr/bin/env node",
        "const fs = require('node:fs');",
        "fs.writeFileSync(process.env.SKYTURN_HERMES_ARGS_PATH, JSON.stringify({",
        "  argv: process.argv.slice(2),",
        "  cwd: process.cwd(),",
        "}));",
        "process.stdout.write('{\"toolCalls\":[]}\\n');",
      ].join("\n"),
      { mode: 0o755 },
    );
    const bridge = new AgentBridge({
      adapters: [
        createHermesCliAdapter({
          executablePath: hermesPath,
          env: { SKYTURN_HERMES_ARGS_PATH: argsPath },
        }),
      ],
    });
    const completed = waitForEvent(
      bridge,
      (event) => event.kind === "status" && event.payload.status === "succeeded",
    );

    await bridge.startRun({
      protocolVersion: RUN_EVENT_PROTOCOL_VERSION,
      nodeId: "node-hermes-worktree",
      sessionId: "session-1",
      projectRoot,
      worktreePath: worktreeLink,
      agentKind: "hermes",
      prompt: "Implement in the managed worktree",
    });
    await completed;

    const args = JSON.parse(await readFile(argsPath, "utf8")) as { argv: string[]; cwd: string };
    const canonicalWorktree = await realpath(worktreeRoot);

    expect(args.cwd).toBe(canonicalWorktree);
    expect(args.cwd).not.toBe(await realpath(projectRoot));
  });

  it("classifies Hermes non-zero exits with terminal evidence", async () => {
    const projectRoot = await makeTempRoot();
    const binRoot = await makeTempRoot();
    const hermesPath = join(binRoot, "hermes");
    await writeFile(
      hermesPath,
      ["#!/usr/bin/env node", "process.stderr.write('planner crashed\\n');", "process.exit(3);"].join("\n"),
      { mode: 0o755 },
    );
    const bridge = new AgentBridge({
      adapters: [createHermesCliAdapter({ executablePath: hermesPath })],
    });
    const failed = waitForEvent(bridge, (event) => event.kind === "status" && event.payload.status === "failed");

    const run = await bridge.startRun({
      protocolVersion: RUN_EVENT_PROTOCOL_VERSION,
      nodeId: "node-hermes-nonzero",
      sessionId: "session-1",
      projectRoot,
      worktreePath: projectRoot,
      agentKind: "hermes",
      prompt: "Plan a workflow",
    });
    await failed;

    const events = await loadRunEvents(projectRoot, run.id);
    const evidence = deriveEvidenceFromEvents(run, events);

    expect(events).toContainEqual(
      expect.objectContaining({
        kind: "error",
        payload: expect.objectContaining({ source: "hermes", category: "non-zero-exit" }),
      }),
    );
    expect(evidence.status).toBe("failed");
    expect(evidence.exitCode).toBe(3);
    expect(evidence.checks).toContainEqual({
      kind: "run-exit",
      name: "Hermes CLI exit",
      status: "failed",
      detail: "exit 3",
    });
  });

  it("redacts secret-like values from Hermes output and failure events", async () => {
    const projectRoot = await makeTempRoot();
    const binRoot = await makeTempRoot();
    const hermesPath = join(binRoot, "hermes");
    const apiKey = "hermes-api-key-secret-123456";
    const token = "hermes-token-secret-123456";
    await writeFile(
      hermesPath,
      [
        "#!/usr/bin/env node",
        `process.stdout.write('planning with HERMES_API_KEY="${apiKey}"\\n');`,
        `process.stdout.write(JSON.stringify({ HERMES_API_KEY: "${apiKey}" }) + '\\n');`,
        `process.stderr.write('planner crashed token="${token}"\\n');`,
        `process.stderr.write(JSON.stringify({ token: "${token}" }) + '\\n');`,
        "process.exit(3);",
      ].join("\n"),
      { mode: 0o755 },
    );
    const bridge = new AgentBridge({
      adapters: [createHermesCliAdapter({ executablePath: hermesPath })],
    });
    const failed = waitForEvent(bridge, (event) => event.kind === "status" && event.payload.status === "failed");

    const run = await bridge.startRun({
      protocolVersion: RUN_EVENT_PROTOCOL_VERSION,
      nodeId: "node-hermes-secret-output",
      sessionId: "session-1",
      projectRoot,
      worktreePath: projectRoot,
      agentKind: "hermes",
      prompt: "Plan a workflow",
    });
    await failed;

    const serializedEvents = JSON.stringify(await loadRunEvents(projectRoot, run.id));
    const output = await readTaskOutput(projectRoot, "node-hermes-secret-output");

    expect(serializedEvents).not.toContain(apiKey);
    expect(serializedEvents).not.toContain(token);
    expect(output).not.toContain(apiKey);
    expect(output).toContain("[redacted]");
  });

  it("sanitizes paths and secrets before emitting Hermes non-zero-exit events", async () => {
    await assertPublicFailureSanitized("hermes");
  });

  it("emits non-terminal stalled telemetry before the Hermes CLI hard timeout", async () => {
    const projectRoot = await makeTempRoot();
    const binRoot = await makeTempRoot();
    const hermesPath = join(binRoot, "hermes");
    await writeFile(
      hermesPath,
      [
        "#!/usr/bin/env node",
        "process.stdout.write('planning started\\n');",
        "setInterval(() => {}, 1000);",
      ].join("\n"),
      { mode: 0o755 },
    );
    const bridge = new AgentBridge({
      adapters: [
        createHermesCliAdapter({
          executablePath: hermesPath,
          stallTelemetryMs: 25,
        }),
      ],
    });
    const events: RunEvent[] = [];
    const unsubscribe = bridge.onRunEvent((event) => events.push(event));
    const stalled = waitForEvent(
      bridge,
      (event) => event.kind === "progress" && event.payload.phase === "stalled",
    );

    const run = await bridge.startRun({
      protocolVersion: RUN_EVENT_PROTOCOL_VERSION,
      nodeId: "node-hermes-long",
      sessionId: "session-1",
      projectRoot,
      worktreePath: projectRoot,
      agentKind: "hermes",
      prompt: "Plan as long as needed",
    });
    await stalled;

    expect(events).toContainEqual(
      expect.objectContaining({
        kind: "progress",
        payload: expect.objectContaining({
          source: "hermes",
          phase: "stalled",
          status: "running",
        }),
      }),
    );
    expect(events).not.toContainEqual(
      expect.objectContaining({
        kind: "status",
        payload: expect.objectContaining({ status: "timed-out" }),
      }),
    );

    unsubscribe();
    await bridge.cancelRun(run.id, "test cleanup");
  });

  it("times out a Hermes CLI run through the default watchdog", async () => {
    const projectRoot = await makeTempRoot();
    const binRoot = await makeTempRoot();
    const hermesPath = join(binRoot, "hermes");
    await writeFile(
      hermesPath,
      [
        "#!/usr/bin/env node",
        "process.stdout.write('planning started\\n');",
        "setInterval(() => {}, 1000);",
      ].join("\n"),
      { mode: 0o755 },
    );
    const bridge = new AgentBridge({
      adapters: [
        createHermesCliAdapter({
          executablePath: hermesPath,
          defaultWatchdogTimeoutMs: testDefaultWatchdogTimeoutMs,
          killTimeoutMs: 100,
        }),
      ],
    });
    const events: RunEvent[] = [];
    const unsubscribe = bridge.onRunEvent((event) => events.push(event));
    const timedOut = waitForEvent(
      bridge,
      (event) => event.kind === "status" && event.payload.status === "timed-out",
    );
    let run: Awaited<ReturnType<AgentBridge["startRun"]>> | null = null;

    try {
      run = await bridge.startRun({
        protocolVersion: RUN_EVENT_PROTOCOL_VERSION,
        nodeId: "node-hermes-default-timeout",
        sessionId: "session-1",
        projectRoot,
        worktreePath: projectRoot,
        agentKind: "hermes",
        prompt: "Hang forever",
      });
      await timedOut;

      expect(events).toContainEqual(
        expect.objectContaining({
          kind: "evidence",
          payload: expect.objectContaining({
            exitCode: null,
            checks: [
              {
                kind: "run-timeout",
                name: "Hermes CLI watchdog",
                status: "failed",
                detail: `timed out after ${testDefaultWatchdogTimeoutMs}ms`,
              },
            ],
          }),
        }),
      );
      expect(events).toContainEqual(
        expect.objectContaining({
          kind: "status",
          payload: expect.objectContaining({ status: "timed-out" }),
        }),
      );
    } finally {
      unsubscribe();
      if (run && !events.some((event) => event.kind === "status" && event.payload.status === "timed-out")) {
        await bridge.cancelRun(run.id, "test cleanup");
      }
    }
  });

  it("lets Hermes CLI timeoutMs override the default watchdog", async () => {
    const projectRoot = await makeTempRoot();
    const binRoot = await makeTempRoot();
    const hermesPath = join(binRoot, "hermes");
    await writeFile(
      hermesPath,
      [
        "#!/usr/bin/env node",
        "process.stdout.write('planning started\\n');",
        "process.on('SIGTERM', () => {});",
        "setInterval(() => {}, 1000);",
      ].join("\n"),
      { mode: 0o755 },
    );
    const bridge = new AgentBridge({
      adapters: [
        createHermesCliAdapter({
          executablePath: hermesPath,
          defaultWatchdogTimeoutMs: 5_000,
          timeoutMs: 250,
          killTimeoutMs: 100,
        }),
      ],
    });
    const timedOut = waitForEvent(
      bridge,
      (event) => event.kind === "status" && event.payload.status === "timed-out",
    );

    const run = await bridge.startRun({
      protocolVersion: RUN_EVENT_PROTOCOL_VERSION,
      nodeId: "node-hermes-timeout",
      sessionId: "session-1",
      projectRoot,
      worktreePath: projectRoot,
      agentKind: "hermes",
      prompt: "Hang forever",
    });
    await timedOut;
    await new Promise((resolve) => setTimeout(resolve, 250));

    const events = await loadRunEvents(projectRoot, run.id);
    const evidence = deriveEvidenceFromEvents(run, events);

    expect(evidence.status).toBe("timed-out");
    expect(evidence.checks).toContainEqual({
      kind: "run-timeout",
      name: "Hermes CLI watchdog",
      status: "failed",
      detail: "timed out after 250ms",
    });
    expect(events.filter((event) => event.kind === "evidence").length).toBe(1);
    expect(events.filter((event) => event.kind === "status" && event.payload.status === "timed-out").length).toBe(1);
  });

  it("kills Hermes child process groups on explicit cancel", async () => {
    if (process.platform === "win32") return;
    const projectRoot = await makeTempRoot();
    const binRoot = await makeTempRoot();
    const parentPidPath = join(binRoot, "hermes-parent.pid");
    const childPidPath = join(binRoot, "hermes-child.pid");
    const hermesPath = join(binRoot, "hermes");
    await writeFile(
      hermesPath,
      [
        "#!/usr/bin/env node",
        "const fs = require('node:fs');",
        "const { spawn } = require('node:child_process');",
        "fs.writeFileSync(process.env.SKYTURN_PARENT_PID_PATH, String(process.pid));",
        "const child = spawn(process.execPath, ['-e', 'process.on(\"SIGTERM\", () => {}); setInterval(() => {}, 1000)'], { stdio: 'ignore' });",
        "fs.writeFileSync(process.env.SKYTURN_CHILD_PID_PATH, String(child.pid));",
        "process.on('SIGTERM', () => {});",
        "process.stdout.write('planning started\\n');",
        "setInterval(() => {}, 1000);",
      ].join("\n"),
      { mode: 0o755 },
    );
    const bridge = new AgentBridge({
      adapters: [
        createHermesCliAdapter({
          executablePath: hermesPath,
          env: {
            SKYTURN_PARENT_PID_PATH: parentPidPath,
            SKYTURN_CHILD_PID_PATH: childPidPath,
          },
          killTimeoutMs: 100,
        }),
      ],
    });

    const run = await bridge.startRun({
      protocolVersion: RUN_EVENT_PROTOCOL_VERSION,
      nodeId: "node-hermes-cancel",
      sessionId: "session-1",
      projectRoot,
      worktreePath: projectRoot,
      agentKind: "hermes",
      prompt: "Cancel me",
    });
    const parentPid = Number(await waitForFile(parentPidPath));
    const childPid = Number(await waitForFile(childPidPath));

    try {
      await bridge.cancelRun(run.id, "User stopped the run");
      await new Promise((resolve) => setTimeout(resolve, 350));

      expect(isPidAlive(parentPid)).toBe(false);
      expect(isPidAlive(childPid)).toBe(false);
      const events = await loadRunEvents(projectRoot, run.id);
      const evidence = deriveEvidenceFromEvents(run, events);
      expect(evidence.status).toBe("cancelled");
      expect(evidence.checks).not.toContainEqual(expect.objectContaining({ kind: "run-timeout" }));
    } finally {
      killPid(parentPid);
      killPid(childPid);
    }
  });

  it("uses Hermes public session resume when an opaque Hermes session handle is provided", async () => {
    const projectRoot = await makeTempRoot();
    const binRoot = await makeTempRoot();
    const argsPath = join(binRoot, "args.json");
    const hermesPath = join(binRoot, "hermes");
    await writeFile(
      hermesPath,
      [
        "#!/usr/bin/env node",
        "const fs = require('node:fs');",
        "fs.writeFileSync(process.env.SKYTURN_HERMES_ARGS_PATH, JSON.stringify({",
        "  argv: process.argv.slice(2),",
        "  cwd: process.cwd(),",
        "}));",
        "process.stdout.write('{\"toolCalls\":[]}\\n');",
      ].join("\n"),
      { mode: 0o755 },
    );
    const bridge = new AgentBridge({
      adapters: [
        createHermesCliAdapter({
          executablePath: hermesPath,
          env: { SKYTURN_HERMES_ARGS_PATH: argsPath },
        }),
      ],
    });
    const completed = waitForEvent(
      bridge,
      (event) => event.kind === "status" && event.payload.status === "succeeded",
    );
    const liveEvents: RunEvent[] = [];
    const unsubscribe = bridge.onRunEvent((event) => liveEvents.push(event));
    const opaqueHandle = "Bearer resume-capability worktree=/Users/alice/private/repo API_KEY=resume-secret";

    try {
      await bridge.startRun({
        protocolVersion: RUN_EVENT_PROTOCOL_VERSION,
        nodeId: "node-hermes",
        sessionId: "session-1",
        plannerSessionId: "repo=C:\\Users\\alice\\private",
        plannerInputId: "path=/private/secret/result",
        hermesSessionHandle: opaqueHandle,
        projectRoot,
        worktreePath: projectRoot,
        agentKind: "hermes",
        prompt: "Continue the workflow",
      });
      await completed;
    } finally {
      unsubscribe();
    }

    const events = await loadRunEvents(projectRoot, "run-session-1-node-hermes");
    const args = JSON.parse(await readFile(argsPath, "utf8")) as { argv: string[]; cwd: string };
    const replay = deriveEvidenceFromEvents(makeRun("run-session-1-node-hermes"), events);

    expect(args.argv).toEqual([
      "chat",
      "-q",
      "Continue the workflow",
      "--quiet",
      "--source",
      "skyturn",
      "--resume",
      opaqueHandle,
    ]);
    expect(args.argv).not.toContain("-z");
    expect(liveEvents).toContainEqual(
      expect.objectContaining({
        kind: "progress",
        payload: expect.objectContaining({
          source: "hermes",
          transport: "hermes_session_resume",
          opaqueHandle: "[redacted]",
        }),
      }),
    );
    for (const serialized of [JSON.stringify(liveEvents), JSON.stringify(events), JSON.stringify(replay)]) {
      expect(serialized).not.toMatch(/resume-capability|resume-secret|alice|private\/secret/);
    }
  });

  it("keeps canonical ASCII-escaped Unicode non-PTY Hermes resume handles out of every public surface", async () => {
    const projectRoot = await makeTempRoot();
    const binRoot = await makeTempRoot();
    const hermesPath = join(binRoot, "hermes");
    const rawHandle = `${"s".repeat(128)}💥e\u0301\r\n\tCAPABILITY-SUFFIX/'single'/"double"\\punctuation?=7&x=[1]`;
    const representations = [
      ...new Set([
        ...canonicalSensitiveValueRepresentationsForTest(rawHandle),
        ...mixedUnicodeSensitiveValueRepresentationsForTest(rawHandle),
      ]),
    ];
    await writeFile(
      hermesPath,
      [
        "#!/usr/bin/env node",
        "const args = process.argv.slice(2);",
        "const handle = args[args.indexOf('--resume') + 1];",
        "if (handle !== process.env.SKYTURN_EXPECTED_HANDLE) process.exit(9);",
        "const values = JSON.parse(process.env.SKYTURN_EMITTED_VALUES);",
        "const wait = () => new Promise((resolve) => setTimeout(resolve, 2));",
        "(async () => {",
        "  for (const [valueIndex, value] of values.entries()) {",
        "    process.stdout.write(`before-${valueIndex} ${value} after-${valueIndex}\\r\\n`);",
        "    await wait();",
        "  }",
        "  const crossStream = Array.from(values[2]);",
        "  const split = Math.floor(crossStream.length / 2);",
        "  process.stdout.write(`before-X ${crossStream.slice(0, split).join('')}`);",
        "  await new Promise((resolve) => setTimeout(resolve, 50));",
        "  process.stderr.write(`${crossStream.slice(split).join('')} after-X\\r\\n`);",
        "  await new Promise((resolve) => setTimeout(resolve, 50));",
        "  process.stdout.write('  indented\\toutput  \\r\\n\\r\\n');",
        "})();",
      ].join("\n"),
      { mode: 0o755 },
    );
    const liveEvents: RunEvent[] = [];
    const bridge = new AgentBridge({
      adapters: [createHermesCliAdapter({
        executablePath: hermesPath,
        env: {
          SKYTURN_EXPECTED_HANDLE: rawHandle,
          SKYTURN_EMITTED_VALUES: JSON.stringify(representations),
        },
      })],
    });
    bridge.onRunEvent((event) => liveEvents.push(event));
    const completed = waitForEvent(bridge, (event) => event.kind === "status" && event.payload.status === "succeeded");

    const run = await bridge.startRun({
      protocolVersion: RUN_EVENT_PROTOCOL_VERSION,
      nodeId: "node-hermes-stream-redaction",
      sessionId: "session-1",
      hermesSessionHandle: rawHandle,
      projectRoot,
      worktreePath: projectRoot,
      agentKind: "hermes",
      prompt: "Continue",
    });
    await completed;

    const events = await loadRunEvents(projectRoot, run.id);
    const evidence = await bridge.getEvidence(projectRoot, run.id);
    const taskOutput = await readTaskOutput(projectRoot, run.nodeId);
    const publicText = events
      .map((event) => typeof event.payload.text === "string" ? event.payload.text : "")
      .join("");
    const persistedBytes = await readFile(join(projectRoot, ".devflow", "runs", run.id, "events.ndjson"), "utf8");
    const flowEvents = flowEventsFromAgentRun({
      sessionId: "session-1",
      laneId: "lane-implementation",
      segmentId: "segment-hermes-stream-redaction",
      run,
      events,
      evidence,
      now: "2026-07-15T00:00:00.000Z",
    });
    const projection = reduceWorkflowEvents([laneDeclaredEvent(), ...flowEvents]);
    const publicSurfaces = JSON.stringify({ liveEvents, events, evidence, flowEvents, projection });
    for (const privateValue of representations) {
      expect(publicText).not.toContain(privateValue);
      expect(taskOutput).not.toContain(privateValue);
      expect(publicSurfaces).not.toContain(privateValue);
      expect(persistedBytes).not.toContain(JSON.stringify(privateValue).slice(1, -1));
      expect(Buffer.from(publicText, "utf8").includes(Buffer.from(privateValue, "utf8"))).toBe(false);
      expect(Buffer.from(taskOutput, "utf8").includes(Buffer.from(privateValue, "utf8"))).toBe(false);
    }
    expect(publicSurfaces).not.toContain("CAPABILITY-SUFFIX");
    expect(persistedBytes).not.toContain("CAPABILITY-SUFFIX");
    expect(publicText).toContain("[redacted]");
    expect(taskOutput.slice(-23)).toBe("  indented\toutput  \r\n\r\n");
    for (const valueIndex of representations.keys()) {
      expect(publicText).toContain(`before-${valueIndex} [redacted] after-${valueIndex}\r\n`);
    }
    expect(publicText).toContain("before-X [redacted] after-X\r\n");
    expect(liveEvents.some((event) => event.payload.stream === "stdout" &&
      typeof event.payload.text === "string" && event.payload.text.includes("before-X "))).toBe(true);
    expect(liveEvents.some((event) => event.payload.stream === "stderr" &&
      typeof event.payload.text === "string" && event.payload.text.includes(" after-X\r\n"))).toBe(true);
  }, 60_000);

  it("redacts canonical Unicode escape representations across every prefix and stdout/stderr split", async () => {
    const rawHandle = `${"s".repeat(128)}💥e\u0301\r\n\tCAPABILITY-SUFFIX/'single'/"double"\\punctuation`;
    const representations = canonicalSensitiveValueRepresentationsForTest(rawHandle);
    const { events, manager, pty } = makePtyManager();
    const session = await manager.startSession({
      ...ptySessionInput(),
      runId: "run-all-unicode-escape-splits",
      sensitiveValues: [rawHandle],
    });

    for (const [valueIndex, value] of representations.entries()) {
      const codePoints = Array.from(value);
      for (let split = 1; split < codePoints.length; split += 1) {
        pty.emitStdout(`before-${valueIndex}-${split} ${codePoints.slice(0, split).join("")}`);
        pty.emitStderr(`${codePoints.slice(split).join("")} after-${valueIndex}-${split}\n`);
      }
    }
    pty.emitExit({ exitCode: 0, signal: null });
    await waitForTerminalEvent(events, (event) => event.kind === "lifecycle" && event.status === "exited");

    const listenerOutput = events.filter((event) => event.kind === "output").map((event) => event.text ?? "").join("");
    const scrollbackOutput = manager.getScrollback(session.id).map((chunk) => chunk.text).join("");
    for (const privateValue of representations) {
      expect(listenerOutput).not.toContain(privateValue);
      expect(scrollbackOutput).not.toContain(privateValue);
    }
    expect(listenerOutput).not.toContain("CAPABILITY-SUFFIX");
    expect(scrollbackOutput).not.toContain("CAPABILITY-SUFFIX");
    expect(scrollbackOutput).toBe(listenerOutput);
  });

  it("redacts every mixed raw, JSON, and Python Unicode capability representation across every stream split", async () => {
    const rawHandle = "opaque-💥-e\u1ab0-雪-CAPABILITY-SUFFIX";
    const representations = mixedUnicodeSensitiveValueRepresentationsForTest(rawHandle);
    expect(representations).toHaveLength(45);
    const { events, manager, pty } = makePtyManager();
    const session = await manager.startSession({
      ...ptySessionInput(),
      runId: "run-mixed-unicode-capability-matrix",
      sensitiveValues: [rawHandle],
    });

    let matrixCases = 0;
    for (const [valueIndex, value] of representations.entries()) {
      const codePoints = Array.from(value);
      for (let split = 1; split < codePoints.length; split += 1) {
        matrixCases += 1;
        pty.emitStdout(`before-${valueIndex}-${split} ${codePoints.slice(0, split).join("")}`);
        pty.emitStderr(`${codePoints.slice(split).join("")} after-${valueIndex}-${split}\n`);
      }
    }
    pty.emitExit({ exitCode: 0, signal: null });
    await waitForTerminalEvent(events, (event) => event.kind === "lifecycle" && event.status === "exited");

    const listenerOutput = events.filter((event) => event.kind === "output").map((event) => event.text ?? "").join("");
    const scrollbackOutput = manager.getScrollback(session.id).map((chunk) => chunk.text).join("");
    expect(matrixCases).toBe(2_010);
    for (const privateValue of representations) {
      expect(listenerOutput).not.toContain(privateValue);
      expect(scrollbackOutput).not.toContain(privateValue);
    }
    expect(listenerOutput).not.toContain("CAPABILITY-SUFFIX");
    expect(scrollbackOutput).toBe(listenerOutput);
  });

  it.each(["exit", "cancel", "timeout", "error"] as const)(
    "conservatively flushes a mixed Unicode capability prefix ending in an incomplete escape on %s",
    async (terminalPath) => {
      vi.useFakeTimers();
      const rawHandle = "opaque-💥-e\u1ab0-雪-CAPABILITY-SUFFIX";
      const mixedIncompletePrefix = String.raw`opaque-💥-e\u1A`;
      const { events, manager, pty } = makePtyManager({ timeoutMs: 25 });
      const session = await manager.startSession({
        ...ptySessionInput(),
        runId: `run-mixed-incomplete-${terminalPath}`,
        sensitiveValues: [rawHandle],
      });
      pty.emitStdout(mixedIncompletePrefix);

      if (terminalPath === "exit") pty.emitExit({ exitCode: 0, signal: null });
      else if (terminalPath === "cancel") await manager.cancelSession(session.id, "cancelled");
      else if (terminalPath === "timeout") await vi.advanceTimersByTimeAsync(25);
      else await manager.terminateSession(session.id, "pty error");
      await flushMicrotasks();

      const listenerOutput = events.filter((event) => event.kind === "output").map((event) => event.text ?? "").join("");
      const scrollbackOutput = manager.getScrollback(session.id).map((chunk) => chunk.text).join("");
      expect(listenerOutput).toBe("[redacted]");
      expect(scrollbackOutput).toBe("[redacted]");
      expect(JSON.stringify({ events, scrollback: manager.getScrollback(session.id) })).not.toContain("opaque-");
    },
  );

  it("conservatively redacts a standalone incomplete recognized escape on terminal flush", async () => {
    const { events, manager, pty } = makePtyManager();
    const session = await manager.startSession({
      ...ptySessionInput(),
      runId: "run-standalone-incomplete-escape",
      sensitiveValues: ["é-capability"],
    });

    pty.emitStdout(String.raw`\u00`);
    pty.emitExit({ exitCode: 0, signal: null });
    await waitForTerminalEvent(events, (event) => event.kind === "lifecycle" && event.status === "exited");

    const listenerOutput = events.filter((event) => event.kind === "output").map((event) => event.text ?? "").join("");
    expect(listenerOutput).toBe("[redacted]");
    expect(manager.getScrollback(session.id).map((chunk) => chunk.text).join("")).toBe("[redacted]");
  });

  it("preserves malformed escapes and ordinary literal backslash text byte-for-byte when non-sensitive", async () => {
    const ordinary = String.raw`literal \q \u12G4 \U00110000 \\ \" \' \n` + "\r\n\tend  \n\n";
    const { events, manager, pty } = makePtyManager();
    const session = await manager.startSession({
      ...ptySessionInput(),
      runId: "run-ordinary-literal-escapes",
      sensitiveValues: ["unrelated-sensitive-value"],
    });

    for (const character of Array.from(ordinary)) pty.emitStdout(character);
    pty.emitExit({ exitCode: 0, signal: null });
    await waitForTerminalEvent(events, (event) => event.kind === "lifecycle" && event.status === "exited");

    const listenerOutput = events.filter((event) => event.kind === "output").map((event) => event.text ?? "").join("");
    expect(listenerOutput).toBe(ordinary);
    expect(manager.getScrollback(session.id).map((chunk) => chunk.text).join("")).toBe(ordinary);
  });

  it("redacts raw literal escape-family capabilities across every chunk and stream split", async () => {
    const sensitiveValues = [
      String.raw`literal-\n-CAPABILITY-N`,
      String.raw`literal-\t-CAPABILITY-T`,
      String.raw`literal-\u1234-CAPABILITY-U`,
      "literal-\\-CAPABILITY-SLASH",
      "literal-ending-CAPABILITY-\\",
    ];
    const { events, manager, pty } = makePtyManager();
    const session = await manager.startSession({
      ...ptySessionInput(),
      runId: "run-literal-escape-family-splits",
      sensitiveValues,
    });
    const expected: string[] = [];

    for (const [valueIndex, sensitiveValue] of sensitiveValues.entries()) {
      const codePoints = Array.from(sensitiveValue);
      for (let split = 1; split < codePoints.length; split += 1) {
        const prefix = `before-${valueIndex}-${split} `;
        const suffix = ` after-${valueIndex}-${split}\n`;
        pty.emitStdout(`${prefix}${codePoints.slice(0, split).join("")}`);
        pty.emitStderr(`${codePoints.slice(split).join("")}${suffix}`);
        expected.push(`${prefix}[redacted]${suffix}`);
      }
    }
    pty.emitExit({ exitCode: 0, signal: null });
    await waitForTerminalEvent(events, (event) => event.kind === "lifecycle" && event.status === "exited");

    const listenerOutput = events.filter((event) => event.kind === "output").map((event) => event.text ?? "").join("");
    const scrollbackOutput = manager.getScrollback(session.id).map((chunk) => chunk.text).join("");
    expect(listenerOutput).toBe(expected.join(""));
    expect(scrollbackOutput).toBe(listenerOutput);
    for (const fragment of ["CAPABILITY-N", "CAPABILITY-T", "CAPABILITY-U", "CAPABILITY-SLASH"]) {
      expect(JSON.stringify({ events, scrollback: manager.getScrollback(session.id) })).not.toContain(fragment);
    }
  });

  it("keeps a harmless preceding backslash and public escape-like suffix outside capability redaction", async () => {
    for (const initial of ["n", "t", "u"] as const) {
      const leadingCapability = `${initial}Opaque-CAPABILITY-${initial.toUpperCase()}`;
      const trailingCapability = `opaque-CAPABILITY-ending-${initial}-\\`;
      const { events, manager, pty } = makePtyManager();
      const session = await manager.startSession({
        ...ptySessionInput(),
        runId: `run-ambiguous-boundaries-${initial}`,
        sensitiveValues: [leadingCapability, trailingCapability],
      });

      pty.emitStdout(`before-${initial}\\`);
      pty.emitStderr(`${leadingCapability} middle-${initial}\n`);
      pty.emitStdout(trailingCapability);
      pty.emitStderr(`${initial}-public-after-secret\n`);
      pty.emitExit({ exitCode: 0, signal: null });
      await waitForTerminalEvent(events, (event) => event.kind === "lifecycle" && event.status === "exited");

      const outputEvents = events
        .filter((event) => event.kind === "output")
        .map((event) => ({ stream: event.stream, text: event.text ?? "" }));
      const listenerOutput = outputEvents.map((event) => event.text).join("");
      expect(listenerOutput).toBe(
        `before-${initial}\\[redacted] middle-${initial}\n[redacted]${initial}-public-after-secret\n`,
      );
      expect(outputEvents.some((event) => event.stream === "stdout" && event.text.includes(`before-${initial}\\`))).toBe(true);
      expect(outputEvents.some((event) => event.stream === "stderr" && event.text.includes(`${initial}-public-after-secret`))).toBe(true);
      expect(manager.getScrollback(session.id).map(({ stream, text }) => ({ stream, text }))).toEqual(outputEvents);
      expect(JSON.stringify({ events, scrollback: manager.getScrollback(session.id) })).not.toMatch(
        new RegExp(`CAPABILITY-(?:${initial.toUpperCase()}|ending-${initial})`),
      );
    }
  });

  it("deduplicates an ambiguous frontier while keeping one 128-span carry bound", async () => {
    const sensitiveValue = `frontier-${String.raw`\n`.repeat(80)}-CAPABILITY-TAIL`;
    const { events, manager, pty } = makePtyManager();
    const session = await manager.startSession({
      ...ptySessionInput(),
      runId: "run-bounded-deduplicated-frontier",
      sensitiveValues: Array.from({ length: 256 }, () => sensitiveValue),
    });

    for (const [index, character] of Array.from(sensitiveValue).entries()) {
      if (index % 2 === 0) pty.emitStdout(character);
      else pty.emitStderr(character);
    }
    pty.emitStdout("after-frontier\n");
    pty.emitExit({ exitCode: 0, signal: null });
    await waitForTerminalEvent(events, (event) => event.kind === "lifecycle" && event.status === "exited");

    const listenerOutput = events.filter((event) => event.kind === "output").map((event) => event.text ?? "").join("");
    expect(listenerOutput).toBe("[redacted]after-frontier\n");
    expect(manager.getScrollback(session.id).map((chunk) => chunk.text).join("")).toBe(listenerOutput);
    expect(JSON.stringify({ events, scrollback: manager.getScrollback(session.id) })).not.toMatch(/CAPABILITY-TAIL|frontier-\\n/);
  });

  it.each(["exit", "error", "cancel", "timeout"] as const)(
    "flushes an unresolved non-PTY Hermes resume handle prefix safely on %s",
    async (terminalPath) => {
      const projectRoot = await makeTempRoot();
      const binRoot = await makeTempRoot();
      const hermesPath = join(binRoot, "hermes");
      const readyPath = join(binRoot, "ready");
      const rawHandle = `opaque-nonpty-${terminalPath}-💥-e\u0301-CAPABILITY-SUFFIX`;
      const escapedHandle = canonicalSensitiveValueRepresentationsForTest(rawHandle)
        .find((value) => value.includes("\\ud83d\\udca5"));
      if (!escapedHandle) throw new Error("Expected a JSON UTF-16 test representation.");
      await writeFile(
        hermesPath,
        [
          "#!/usr/bin/env node",
          "const args = process.argv.slice(2);",
          "const handle = args[args.indexOf('--resume') + 1];",
          "if (handle !== process.env.SKYTURN_EXPECTED_HANDLE) process.exit(9);",
          "const escaped = process.env.SKYTURN_ESCAPED_HANDLE;",
          "process.stdout.write(escaped.slice(0, Math.floor(escaped.length / 2)));",
          "require('node:fs').writeFileSync(process.env.SKYTURN_READY_PATH, 'ready');",
          terminalPath === "exit" ? "process.exit(0);" : terminalPath === "error" ? "process.exit(7);" : "setInterval(() => {}, 1000);",
        ].join("\n"),
        { mode: 0o755 },
      );
      const bridge = new AgentBridge({
        adapters: [createHermesCliAdapter({
          executablePath: hermesPath,
          timeoutMs: terminalPath === "timeout" ? 250 : 5_000,
          killTimeoutMs: 20,
          env: {
            SKYTURN_READY_PATH: readyPath,
            SKYTURN_EXPECTED_HANDLE: rawHandle,
            SKYTURN_ESCAPED_HANDLE: escapedHandle,
          },
        })],
      });
      const terminal = waitForEvent(
        bridge,
        (event) => event.kind === "status" && event.payload.status === (
          terminalPath === "cancel" ? "cancelled" : terminalPath === "timeout" ? "timed-out" : terminalPath === "error" ? "failed" : "succeeded"
        ),
      );
      const run = await bridge.startRun({
        protocolVersion: RUN_EVENT_PROTOCOL_VERSION,
        nodeId: `node-hermes-${terminalPath}-flush`,
        sessionId: "session-1",
        hermesSessionHandle: rawHandle,
        projectRoot,
        worktreePath: projectRoot,
        agentKind: "hermes",
        prompt: "Continue",
      });
      if (terminalPath === "cancel") {
        await waitForFile(readyPath);
        await bridge.cancelRun(run.id, "cancelled");
      }
      await terminal;

      const events = await loadRunEvents(projectRoot, run.id);
      const publicState = JSON.stringify({ events, evidence: await bridge.getEvidence(projectRoot, run.id) });
      const output = events
        .filter((event) => event.kind === "output")
        .map((event) => event.payload.text)
        .join("");
      expect(output).toBe("[redacted]");
      expect(publicState).not.toContain(rawHandle);
      expect(publicState).not.toContain(escapedHandle);
      expect(publicState).not.toContain("CAPABILITY-SUFFIX");
      expect(await readFile(join(projectRoot, ".devflow", "runs", run.id, "events.ndjson"), "utf8"))
        .not.toContain("CAPABILITY-SUFFIX");
    },
  );

  it("redacts the non-PTY Hermes resume handle from synchronous spawn errors", async () => {
    const projectRoot = await makeTempRoot();
    const binRoot = await makeTempRoot();
    const hermesPath = join(binRoot, "hermes");
    const rawHandle = "opaque-spawn-error-capability";
    await writeFile(hermesPath, "#!/bin/sh\nexit 0\n", { mode: 0o755 });
    const durableRunClaimStore = createDurableRunClaimStore({ root: await makeTempRoot() });
    const bridge = new AgentBridge({
      durableRunClaimStore,
      adapters: [createHermesCliAdapter({
        executablePath: hermesPath,
        extraArgs: [`invalid\0${rawHandle}`],
      })],
    });

    const failure = await bridge.startRun({
      protocolVersion: RUN_EVENT_PROTOCOL_VERSION,
      runId: "run-hermes-spawn-error-redaction",
      nodeId: "node-hermes-spawn-error-redaction",
      sessionId: "session-1",
      hermesSessionHandle: rawHandle,
      projectRoot,
      worktreePath: projectRoot,
      agentKind: "hermes",
      prompt: "Continue",
    }).catch((error: unknown) => error);

    expect(failure).toMatchObject({ durableRunClaimOwned: true });
    expect(String(failure)).not.toContain(rawHandle);
    const eventsPath = join(projectRoot, ".devflow", "runs", "run-hermes-spawn-error-redaction", "events.ndjson");
    expect(await readFile(eventsPath, "utf8")).not.toContain(rawHandle);
  });

  it("builds Hermes planner PTY launch args for the interactive CLI mode", async () => {
    const projectRoot = await makeTempRoot();

    const launch = await buildHermesPlannerPtyLaunch(
      {
        runId: "run-hermes-pty-1",
        canvasSessionId: "canvas-session-1",
        plannerSessionId: "hermes-planner-session-1",
        plannerInputId: "requirement-1",
        projectRoot,
        worktreePath: projectRoot,
      },
      {
        executablePath: "/usr/local/bin/hermes",
        source: "skyturn",
      },
    );

    expect(launch).toMatchObject({
      command: "/usr/local/bin/hermes",
      cwd: await realpath(projectRoot),
      commandLabel: "Hermes CLI PTY",
      args: ["chat", "--cli", "--source", "skyturn"],
      metadata: {
        transport: "hermes_live_chat",
        continuity: "process-level",
        degraded: true,
        plannerSessionId: "hermes-planner-session-1",
        plannerInputId: "requirement-1",
        opaqueHandle: null,
      },
    });
    expect(launch.args).not.toContain("-q");
    expect(launch.args).not.toContain("-z");
    expect(launch.args).not.toContain("--yolo");
    expect(launch.metadata.recoveryReason).toContain("process-level");
  });

  it("keeps Hermes resume capability out of the public PTY launch description", async () => {
    const projectRoot = await makeTempRoot();
    const opaqueHandle = "Bearer pty-resume-secret path=/Users/alice/private password=hunter2";

    const launch = await buildHermesPlannerPtyLaunch(
      {
        runId: "run-hermes-pty-resume",
        canvasSessionId: "canvas-session-1",
        plannerSessionId: "hermes-planner-session-1",
        hermesSessionHandle: opaqueHandle,
        projectRoot,
        worktreePath: projectRoot,
      },
      {
        executablePath: "/usr/local/bin/hermes",
      },
    );

    expect(launch.args).toEqual([
      "chat",
      "--cli",
      "--source",
      "skyturn",
      "--resume",
      "[redacted]",
    ]);
    expect(launch.metadata).toMatchObject({
      transport: "hermes_session_resume",
      continuity: "resume-handle",
      degraded: false,
      opaqueHandle: "[redacted]",
    });
    expect(JSON.stringify(launch)).not.toMatch(/pty-resume-secret|alice|hunter2/);
    expect(launch.metadata.recoveryReason).toBeUndefined();
  });

  it("passes a raw Hermes handle only to PTY spawn argv and redacts arbitrary output chunk splits", async () => {
    const projectRoot = await makeTempRoot();
    const rawHandle = "opaque-hermes-resume-capability-7e4f9b2c";
    const events: TerminalSessionEventDraft[] = [];
    const spawnInputs: Array<{ args: string[] }> = [];
    const pty = new FakePtyProcess();
    const transport = createHermesPlannerPtyTransport({
      ptyFactory: {
        spawn(input) {
          spawnInputs.push(input);
          return pty;
        },
      },
      executablePath: "hermes",
      featureFlags: { ptyInteractiveSessions: true },
      emitEvent: async (event) => {
        events.push(event);
      },
    });

    const started = await transport.startSession({
      runId: "run-hermes-pty-private-handle",
      canvasSessionId: "canvas-session-private-handle",
      plannerSessionId: "planner-session-private-handle",
      hermesSessionHandle: rawHandle,
      projectRoot,
      worktreePath: projectRoot,
    });
    const stored = transport.getSession("canvas-session-private-handle");
    for (let split = 1; split < rawHandle.length; split += 1) {
      pty.emitStdout(`before-${split} ${rawHandle.slice(0, split)}`);
      pty.emitStdout(`${rawHandle.slice(split)} after-${split}\n`);
    }
    pty.emitExit({ exitCode: 0, signal: null });
    await waitForTerminalEvent(
      events,
      (event) => event.kind === "lifecycle" && event.status === "exited",
    );

    expect(spawnInputs).toHaveLength(1);
    expect(spawnInputs[0]?.args).toEqual(["chat", "--cli", "--source", "skyturn", "--resume", rawHandle]);
    const publicState = JSON.stringify({ started, stored, events });
    const listenerOutput = events
      .filter((event) => event.kind === "output")
      .map((event) => event.text ?? "")
      .join("");
    expect(publicState).not.toContain(rawHandle);
    expect(listenerOutput).not.toContain(rawHandle);
    expect(started.metadata.opaqueHandle).toBe("[redacted]");
    expect(stored?.metadata.opaqueHandle).toBe("[redacted]");
  });

  it("publishes one exact sanitized event for a large Hermes PTY onData chunk", async () => {
    const projectRoot = await makeTempRoot();
    const events: TerminalSessionEventDraft[] = [];
    const pty = new FakePtyProcess();
    const transportOptions = {
      ptyFactory: { spawn: vi.fn(() => pty) },
      executablePath: "hermes",
      featureFlags: { ptyInteractiveSessions: true },
      emitEvent: async (event: TerminalSessionEventDraft) => {
        events.push(event);
      },
    };
    const transport = createHermesPlannerPtyTransport(transportOptions);

    await transport.startSession({
      runId: "run-hermes-pty-large-output",
      canvasSessionId: "canvas-session-large-output",
      hermesSessionHandle: "opaque-hermes-large-output-capability",
      projectRoot,
      worktreePath: projectRoot,
    });
    pty.emitStdout("probe");

    const ordinary = "x".repeat(65_536);
    pty.emitStdout(ordinary);
    await flushAsyncEvents();

    const outputEvents = events.filter((event) => event.kind === "output");
    expect(outputEvents.map((event) => event.text)).toEqual(["probe", ordinary]);
    expect(outputEvents.filter((event) => event.text === ordinary)).toHaveLength(1);
  });

  it("keeps Hermes planner PTY transport disabled unless the feature flag is enabled", async () => {
    const projectRoot = await makeTempRoot();
    const factory: PtyProcessFactory = {
      spawn: vi.fn(() => new FakePtyProcess()),
    };
    const transport = createHermesPlannerPtyTransport({
      ptyFactory: factory,
      executablePath: "hermes",
    });

    await expect(
      transport.startSession({
        runId: "run-hermes-pty-disabled",
        canvasSessionId: "canvas-session-disabled",
        projectRoot,
        worktreePath: projectRoot,
      }),
    ).rejects.toThrow("disabled by feature flag");
    expect(factory.spawn).not.toHaveBeenCalled();
  });

  it("keeps follow-up Hermes planner input on the same PTY session for one CanvasSession", async () => {
    const projectRoot = await makeTempRoot();
    const events: TerminalSessionEventDraft[] = [];
    const pty = new FakePtyProcess();
    const factory: PtyProcessFactory = {
      spawn: vi.fn(() => pty),
    };
    const transport = createHermesPlannerPtyTransport({
      ptyFactory: factory,
      executablePath: "hermes",
      featureFlags: { ptyInteractiveSessions: true },
      emitEvent: async (event) => {
        events.push(event);
      },
    });

    const first = await transport.startSession({
      runId: "run-hermes-pty-1",
      canvasSessionId: "canvas-session-1",
      plannerSessionId: "hermes-planner-session-1",
      plannerInputId: "requirement-1",
      projectRoot,
      worktreePath: projectRoot,
    });
    await transport.sendUserInput("canvas-session-1", "Plan first requirement\n");
    const second = await transport.startSession({
      runId: "run-hermes-pty-2",
      canvasSessionId: "canvas-session-1",
      plannerSessionId: "hermes-planner-session-1",
      plannerInputId: "requirement-2",
      projectRoot,
      worktreePath: projectRoot,
    });
    await transport.sendUserInput("canvas-session-1", "Plan follow-up requirement\n");

    expect(factory.spawn).toHaveBeenCalledTimes(1);
    expect(first.terminalSession.id).toBe(second.terminalSession.id);
    expect(first.terminalSession.canvasSessionId).toBe("canvas-session-1");
    expect(pty.writes).toEqual(["Plan first requirement\n", "Plan follow-up requirement\n"]);
    expect(events).toContainEqual(
      expect.objectContaining({
        kind: "progress",
        terminalSessionId: first.terminalSession.id,
        message: expect.stringContaining("process-level"),
      }),
    );
  });

  it("resizes the open Hermes planner PTY session by CanvasSession", async () => {
    const projectRoot = await makeTempRoot();
    const pty = new FakePtyProcess();
    const transport = createHermesPlannerPtyTransport({
      ptyFactory: { spawn: vi.fn(() => pty) },
      executablePath: "hermes",
      featureFlags: { ptyInteractiveSessions: true },
    });

    await transport.startSession({
      runId: "run-hermes-pty-resize",
      canvasSessionId: "canvas-session-resize",
      projectRoot,
      worktreePath: projectRoot,
    });
    await transport.resizeSession("canvas-session-resize", { cols: 132, rows: 43 });

    expect(pty.resizes).toEqual([{ cols: 132, rows: 43 }]);
  });

  it("keeps Hermes planner PTY session when metadata progress observer rejects", async () => {
    const projectRoot = await makeTempRoot();
    const events: TerminalSessionEventDraft[] = [];
    const pty = new FakePtyProcess();
    const factory: PtyProcessFactory = {
      spawn: vi.fn(() => pty),
    };
    const transport = createHermesPlannerPtyTransport({
      ptyFactory: factory,
      executablePath: "hermes",
      featureFlags: { ptyInteractiveSessions: true },
      emitEvent: async (event) => {
        events.push(event);
        if (event.kind === "progress" && event.message?.includes("Hermes planner PTY started")) {
          throw new Error("observer failed");
        }
      },
    });

    const first = await transport.startSession({
      runId: "run-hermes-pty-observer-1",
      canvasSessionId: "canvas-session-observer",
      plannerSessionId: "hermes-planner-session-observer",
      plannerInputId: "requirement-1",
      projectRoot,
      worktreePath: projectRoot,
    });

    const stored = transport.getSession("canvas-session-observer");
    const second = await transport.startSession({
      runId: "run-hermes-pty-observer-2",
      canvasSessionId: "canvas-session-observer",
      plannerSessionId: "hermes-planner-session-observer",
      plannerInputId: "requirement-2",
      projectRoot,
      worktreePath: projectRoot,
    });

    expect(first.terminalSession.status).toBe("running");
    expect(stored?.terminalSession.id).toBe(first.terminalSession.id);
    expect(second.terminalSession.id).toBe(first.terminalSession.id);
    expect(factory.spawn).toHaveBeenCalledTimes(1);
    expect(
      events.filter((event) => event.kind === "progress" && event.message?.includes("Hermes planner PTY started")),
    ).toHaveLength(1);
  });

  it("redacts Hermes planner PTY output chunks", async () => {
    const projectRoot = await makeTempRoot();
    const events: TerminalSessionEventDraft[] = [];
    const pty = new FakePtyProcess();
    const transport = createHermesPlannerPtyTransport({
      ptyFactory: { spawn: vi.fn(() => pty) },
      executablePath: "hermes",
      featureFlags: { ptyInteractiveSessions: true },
      emitEvent: async (event) => {
        events.push(event);
      },
    });
    const apiKey = "sk-hermes-pty-secret-token";

    const session = await transport.startSession({
      runId: "run-hermes-pty-secret",
      canvasSessionId: "canvas-session-secret",
      projectRoot,
      worktreePath: projectRoot,
    });
    pty.emitStdout(`HERMES_API_KEY=${apiKey}\n`);
    await waitForTerminalEvent(
      events,
      (event) => event.kind === "output" && event.terminalSessionId === session.terminalSession.id,
    );

    expect(JSON.stringify(events)).not.toContain(apiKey);
    expect(events).toContainEqual(
      expect.objectContaining({
        kind: "output",
        terminalSessionId: session.terminalSession.id,
        text: "HERMES_API_KEY=[redacted]\n",
      }),
    );
  });
});

describe("PTY terminal session manager", () => {
  it("starts a session and emits terminal lifecycle events", async () => {
    const { events, manager } = makePtyManager();

    const session = await manager.startSession(ptySessionInput());

    expect(session).toMatchObject({
      id: "terminal-run-pty-1",
      runId: "run-pty-1",
      canvasSessionId: "session-1",
      agentKind: "codex",
      cwd: "/repo",
      commandLabel: "codex",
      transport: "pty-interactive",
      status: "running",
    });
    expect(events).toContainEqual(
      expect.objectContaining({
        kind: "lifecycle",
        terminalSessionId: session.id,
        runId: "run-pty-1",
        status: "starting",
      }),
    );
    expect(events).toContainEqual(
      expect.objectContaining({
        kind: "lifecycle",
        terminalSessionId: session.id,
        runId: "run-pty-1",
        status: "running",
      }),
    );
  });

  it("sanitizes stdout secrets and stderr public evidence in terminal events and scrollback", async () => {
    const { events, manager, pty } = makePtyManager();
    const session = await manager.startSession(ptySessionInput());

    pty.emitStdout("Bearer very-secret-token\n");
    const stderrPath = "/Users/alice/private/terminal repo";
    pty.emitStderr(`OPENAI_API_KEY=sk-test-secret-token cwd=${stderrPath}\n`);
    await waitForTerminalEvent(
      events,
      (event) => event.kind === "output" && event.stream === "stderr",
    );

    expect(events).toContainEqual(
      expect.objectContaining({
        kind: "output",
        terminalSessionId: session.id,
        stream: "stdout",
        text: "Bearer [redacted]\n",
      }),
    );
    expect(events).toContainEqual(
      expect.objectContaining({
        kind: "output",
        terminalSessionId: session.id,
        stream: "stderr",
        text: "OPENAI_API_KEY=[redacted] cwd=[redacted-path]\n",
      }),
    );
    const serialized = JSON.stringify({ events, scrollback: manager.getScrollback(session.id) });
    expect(serialized).not.toContain("very-secret-token");
    expect(serialized).not.toContain("sk-test-secret-token");
    expect(serialized).not.toContain(stderrPath);
    expect(serialized).not.toContain("terminal repo");
  });

  it("preserves interleaved normal PTY chunks and whitespace in listener events and scrollback", async () => {
    const { events, manager, pty } = makePtyManager();
    const session = await manager.startSession({ ...ptySessionInput(), sensitiveValues: ["test-secret"] });

    pty.emitStdout("t");
    pty.emitStderr("notice\n");
    pty.emitStdout("est complete\n");
    pty.emitStdout("  const value = 1;  \n");
    await waitForTerminalEvent(
      events,
      (event) => event.kind === "output" && event.text === "  const value = 1;  \n",
    );

    const outputEvents = events
      .filter((event) => event.kind === "output")
      .map((event) => ({ stream: event.stream, text: event.text }));
    expect(outputEvents).toEqual([
      { stream: "stdout", text: "t" },
      { stream: "stderr", text: "notice\n" },
      { stream: "stdout", text: "est complete\n" },
      { stream: "stdout", text: "  const value = 1;  \n" },
    ]);
    expect(manager.getScrollback(session.id).map(({ stream, text }) => ({ stream, text }))).toEqual(outputEvents);
  });

  it("redacts sensitive sequences across every stdout/stderr boundary without reordering normal output", async () => {
    const values = [
      "token=abcXYZ",
      "Bearer abcXYZ",
      "/Users/alice/private/repo",
      "C:\\Users\\alice\\private\\repo",
    ];
    for (const value of values) {
      for (let split = 1; split < value.length; split += 1) {
        const { events, manager, pty } = makePtyManager();
        const session = await manager.startSession({
          ...ptySessionInput(),
          runId: `run-cross-stream-${values.indexOf(value)}-${split}`,
        });

        pty.emitStdout(value.slice(0, split));
        pty.emitStderr(`${value.slice(split)}\n`);
        pty.emitStdout("  normal trailing output  \n");
        pty.emitExit({ exitCode: 0, signal: null });
        await waitForTerminalEvent(events, (event) => event.kind === "lifecycle" && event.status === "exited");

        const outputEvents = events
          .filter((event) => event.kind === "output")
          .map((event) => ({ stream: event.stream, text: event.text ?? "" }));
        const publicOutput = outputEvents.map((event) => event.text).join("");
        const scrollback = manager.getScrollback(session.id);
        expect(publicOutput).not.toContain("abcXYZ");
        expect(publicOutput).not.toMatch(/alice[\\/]private/);
        expect(publicOutput).toContain("[redacted");
        expect(publicOutput.endsWith("  normal trailing output  \n")).toBe(true);
        expect(scrollback.map(({ stream, text }) => ({ stream, text }))).toEqual(outputEvents);
      }
    }
  });

  it("bounds globally ordered carry after a cross-stream character resolves the sensitive prefix", async () => {
    const { events, manager, pty } = makePtyManager();
    const session = await manager.startSession({ ...ptySessionInput(), sensitiveValues: ["test-secret"] });
    const queuedStderr = `${"x".repeat(128)}\n`;

    pty.emitStdout("t");
    pty.emitStderr(queuedStderr);
    await waitForTerminalEvent(events, (event) => event.kind === "output" && event.stream === "stderr");

    const outputEvents = events
      .filter((event) => event.kind === "output")
      .map((event) => ({ stream: event.stream, text: event.text }));
    expect(outputEvents).toEqual([
      { stream: "stdout", text: "t" },
      { stream: "stderr", text: queuedStderr },
    ]);
    expect(manager.getScrollback(session.id).map(({ stream, text }) => ({ stream, text }))).toEqual(outputEvents);
  });

  it("keeps explicit sensitive carry bounded when the configured value exceeds the cap", async () => {
    const sensitiveValue = `${"s".repeat(512)}-terminal-secret`;
    const { events, manager, pty } = makePtyManager();
    const session = await manager.startSession({ ...ptySessionInput(), sensitiveValues: [sensitiveValue] });

    pty.emitStdout(sensitiveValue.slice(0, 128));
    pty.emitStdout(sensitiveValue.slice(128));
    pty.emitExit({ exitCode: 0, signal: null });
    await waitForTerminalEvent(events, (event) => event.kind === "lifecycle" && event.status === "exited");

    const listenerOutput = events.filter((event) => event.kind === "output").map((event) => event.text ?? "").join("");
    const scrollbackOutput = manager.getScrollback(session.id).map((chunk) => chunk.text).join("");
    expect(listenerOutput).toBe("[redacted]");
    expect(scrollbackOutput).toBe("[redacted]");
    expect(JSON.stringify({ events, scrollback: manager.getScrollback(session.id) })).not.toContain("terminal-secret");
  });

  it.each(["exit", "cancel", "timeout", "error"] as const)(
    "never flushes unresolved handle, token, path, or assignment prefixes on %s",
    async (terminalPath) => {
      vi.useFakeTimers();
      const explicit = "opaque-resume-handle-secret";
      const cases = [
        { value: explicit, firstSensitiveLength: 1, expected: "[redacted]" },
        { value: "token=abcXYZ", firstSensitiveLength: "token=a".length, expected: "token=[redacted]" },
        { value: "Bearer abcXYZ", firstSensitiveLength: "Bearer a".length, expected: "Bearer [redacted]" },
        { value: "/Users/alice/private", firstSensitiveLength: 2, expected: "[redacted-path]" },
      ];
      for (const { value, firstSensitiveLength, expected } of cases) {
        for (let prefixLength = firstSensitiveLength; prefixLength < value.length; prefixLength += 1) {
          const { events, manager, pty } = makePtyManager({ timeoutMs: 25 });
          const session = await manager.startSession({
            ...ptySessionInput(),
            runId: `run-${terminalPath}-${prefixLength}-${value.length}`,
            sensitiveValues: [explicit],
          });
          const prefix = value.slice(0, prefixLength);
          pty.emitStdout(prefix);

          if (terminalPath === "exit") pty.emitExit({ exitCode: 0, signal: null });
          else if (terminalPath === "cancel") await manager.cancelSession(session.id, "cancelled");
          else if (terminalPath === "timeout") await vi.advanceTimersByTimeAsync(25);
          else await manager.terminateSession(session.id, "pty error");
          await flushMicrotasks();

          const listenerOutput = events
            .filter((event) => event.kind === "output")
            .map((event) => event.text ?? "")
            .join("");
          const scrollbackOutput = manager.getScrollback(session.id).map((chunk) => chunk.text).join("");
          expect(listenerOutput).toBe(expected);
          expect(scrollbackOutput).toBe(expected);
        }
      }
    },
  );

  it.each(["stdout", "stderr"] as const)(
    "redacts every %s chunk split before listener, scrollback, and final public surfaces",
    async (stream) => {
      const rawResumeHandle = `${"s".repeat(128)}💥e\u0301\r\nCAPABILITY-SUFFIX/"quoted"\\punctuation?=7`;
      const rawValues = [
        rawResumeHandle,
        "Bearer bearer-capability-123456789",
        "OPENAI_API_KEY=sk-split-api-token-123456789",
        "password=split-password-123456789",
        "/Users/alice/private/split-repo",
        "C:\\Users\\alice\\private\\split-repo",
      ];
      const privatePayloads = [
        rawResumeHandle,
        "bearer-capability-123456789",
        "sk-split-api-token-123456789",
        "split-password-123456789",
        "alice/private/split-repo",
        "alice\\private\\split-repo",
      ];
      const { events, manager, pty } = makePtyManager();
      const input = { ...ptySessionInput(), sensitiveValues: [rawResumeHandle] };
      const session = await manager.startSession(input);
      const emit = stream === "stdout"
        ? (chunk: string) => pty.emitStdout(chunk)
        : (chunk: string) => pty.emitStderr(chunk);

      for (const [valueIndex, rawValue] of rawValues.entries()) {
        const codePoints = Array.from(rawValue);
        for (let split = 1; split < codePoints.length; split += 1) {
          emit(`before-${valueIndex}-${split} ${codePoints.slice(0, split).join("")}`);
          emit(`${codePoints.slice(split).join("")} after-${valueIndex}-${split}\n`);
        }
      }
      const finalRaw = rawValues[0]!;
      const finalCodePoints = Array.from(finalRaw);
      const finalSplit = Math.floor(finalCodePoints.length / 2);
      emit(`before-final ${finalCodePoints.slice(0, finalSplit).join("")}`);
      emit(`${finalCodePoints.slice(finalSplit).join("")} after-final`);
      pty.emitExit({ exitCode: 0, signal: null });
      await waitForTerminalEvent(
        events,
        (event) => event.kind === "lifecycle" && event.status === "exited",
      );

      const listenerOutput = events
        .filter((event) => event.kind === "output")
        .map((event) => event.text ?? "")
        .join("");
      const scrollbackOutput = manager.getScrollback(session.id).map((chunk) => chunk.text).join("");
      const publicState = JSON.stringify({
        events,
        scrollback: manager.getScrollback(session.id),
        session: manager.getSession(session.id),
        evidence: manager.getExitEvidence(session.id),
      });
      for (const privatePayload of privatePayloads) {
        expect(listenerOutput).not.toContain(privatePayload);
        expect(scrollbackOutput).not.toContain(privatePayload);
        expect(publicState).not.toContain(privatePayload);
      }
      expect(listenerOutput.indexOf("before-0-1")).toBeLessThan(listenerOutput.indexOf("after-final"));
      expect(scrollbackOutput.indexOf("before-0-1")).toBeLessThan(scrollbackOutput.indexOf("after-final"));
    },
  );

  it.each(["cancel", "terminate"] as const)(
    "flushes a split private suffix safely before %s lifecycle evidence",
    async (action) => {
      const rawResumeHandle = "opaque-resume-capability-terminal-flush";
      const { events, manager, pty } = makePtyManager();
      const input = { ...ptySessionInput(), runId: `run-pty-${action}-flush`, sensitiveValues: [rawResumeHandle] };
      const session = await manager.startSession(input);
      const split = Math.floor(rawResumeHandle.length / 2);
      pty.emitStdout(`before-flush ${rawResumeHandle.slice(0, split)}`);
      pty.emitStdout(`${rawResumeHandle.slice(split)} after-flush`);

      const evidence = action === "cancel"
        ? await manager.cancelSession(session.id, "User cancelled")
        : await manager.terminateSession(session.id, "PTY error");
      const publicState = JSON.stringify({
        events,
        scrollback: manager.getScrollback(session.id),
        session: manager.getSession(session.id),
        evidence,
        storedEvidence: manager.getExitEvidence(session.id),
      });

      expect(publicState).not.toContain(rawResumeHandle);
      const output = events.filter((event) => event.kind === "output").map((event) => event.text ?? "").join("");
      expect(output).not.toContain(rawResumeHandle);
      expect(output.indexOf("before-flush")).toBeLessThan(output.indexOf("after-flush"));
    },
  );

  it.each(["cancel", "terminate"] as const)(
    "sanitizes PTY stdout and %s reason before events, scrollback, session, and exit evidence",
    async (action) => {
      const { events, manager, pty } = makePtyManager();
      const session = await manager.startSession({ ...ptySessionInput(), runId: `run-pty-${action}` });
      const rawValues = [
        "Bearer terminal-secret",
        "/Users/alice/private/terminal",
        "C:\\Users\\alice\\private",
        "password=hunter2",
      ];
      pty.emitStdout(`${rawValues.join(" ")}\n`);
      await waitForTerminalEvent(events, (event) => event.kind === "output");
      const reason = `${rawValues.join(" ")} reason`;
      const evidence = action === "cancel"
        ? await manager.cancelSession(session.id, reason)
        : await manager.terminateSession(session.id, reason);

      const serialized = JSON.stringify({
        events,
        scrollback: manager.getScrollback(session.id),
        session: manager.getSession(session.id),
        evidence,
        storedEvidence: manager.getExitEvidence(session.id),
      });
      for (const raw of ["terminal-secret", ...rawValues.slice(1)]) expect(serialized).not.toContain(raw);
    },
  );

  it("forwards stdin writes to the PTY process", async () => {
    const { manager, pty } = makePtyManager();
    const session = await manager.startSession(ptySessionInput());

    await manager.writeStdin(session.id, "continue\n");

    expect(pty.writes).toEqual(["continue\n"]);
  });

  it("forwards terminal resize dimensions to the PTY process", async () => {
    const { manager, pty } = makePtyManager();
    const session = await manager.startSession(ptySessionInput());

    await manager.resize(session.id, { cols: 120, rows: 42 });

    expect(pty.resizes).toEqual([{ cols: 120, rows: 42 }]);
  });

  it("cancels a session with terminal lifecycle and run-exit evidence skeleton", async () => {
    const { events, manager, pty } = makePtyManager();
    const session = await manager.startSession(ptySessionInput());

    const evidence = await manager.cancelSession(session.id, "User stopped the terminal");

    expect(pty.killedSignals).toContain("SIGTERM");
    expect(events).toContainEqual(
      expect.objectContaining({
        kind: "lifecycle",
        terminalSessionId: session.id,
        status: "cancelled",
        message: "User stopped the terminal",
      }),
    );
    expect(evidence).toEqual({
      exitCode: null,
      signal: null,
      checks: [
        {
          kind: "run-exit",
          name: "codex terminal exit",
          status: "skipped",
          detail: "User stopped the terminal",
        },
      ],
    });
  });

  it("times out a session and kills the PTY process", async () => {
    vi.useFakeTimers();
    const { events, manager, pty } = makePtyManager({ timeoutMs: 250, killTimeoutMs: 50 });
    const session = await manager.startSession(ptySessionInput());

    await vi.advanceTimersByTimeAsync(250);
    await vi.advanceTimersByTimeAsync(50);

    expect(pty.killedSignals).toEqual(["SIGTERM", "SIGKILL"]);
    expect(events).toContainEqual(
      expect.objectContaining({
        kind: "lifecycle",
        terminalSessionId: session.id,
        status: "timed-out",
      }),
    );
    expect(manager.getExitEvidence(session.id)).toEqual({
      exitCode: null,
      signal: null,
      checks: [
        {
          kind: "run-timeout",
          name: "codex terminal watchdog",
          status: "failed",
          detail: "timed out after 250ms",
        },
      ],
    });
  });

  it("emits stalled terminal progress before a PTY hard timeout", async () => {
    vi.useFakeTimers();
    const { events, manager, pty } = makePtyManager({
      stallTelemetryMs: 50,
      timeoutMs: 250,
      killTimeoutMs: 50,
    });
    const session = await manager.startSession(ptySessionInput());

    await vi.advanceTimersByTimeAsync(50);

    expect(events).toContainEqual(
      expect.objectContaining({
        kind: "progress",
        terminalSessionId: session.id,
        message: expect.stringContaining("stalled"),
      }),
    );
    expect(manager.getSession(session.id)?.status).toBe("running");

    await manager.cancelSession(session.id, "test cleanup");
    pty.emitExit({ exitCode: null, signal: "SIGTERM" });
  });

  it("marks non-zero PTY exits as failed evidence", async () => {
    const { events, manager, pty } = makePtyManager();
    const session = await manager.startSession(ptySessionInput());

    pty.emitExit({ exitCode: 2, signal: null });
    await waitForTerminalEvent(events, (event) => event.kind === "lifecycle" && event.status === "failed");

    expect(events).toContainEqual(
      expect.objectContaining({
        kind: "lifecycle",
        terminalSessionId: session.id,
        status: "failed",
      }),
    );
    expect(manager.getExitEvidence(session.id)).toEqual({
      exitCode: 2,
      signal: null,
      checks: [
        {
          kind: "run-exit",
          name: "codex terminal exit",
          status: "failed",
          detail: "exit 2",
        },
      ],
    });
  });

  it("caps terminal scrollback bytes and evicts old chunks", async () => {
    const { manager, pty } = makePtyManager({ maxScrollbackBytes: 10 });
    const session = await manager.startSession(ptySessionInput());

    pty.emitStdout("0123456789abcdef");

    expect(manager.getScrollback(session.id).map((chunk) => chunk.text)).toEqual(["6789abcdef"]);

    pty.emitStdout("XYZ");

    expect(manager.getScrollback(session.id).map((chunk) => chunk.text)).toEqual(["XYZ"]);
  });

  it("orders queued output before final lifecycle events with async sinks", async () => {
    const outputGate = deferred<void>();
    const events: TerminalSessionEventDraft[] = [];
    const { manager, pty } = makePtyManager({
      emitEvent: async (event) => {
        if (event.kind === "output") await outputGate.promise;
        events.push(event);
      },
    });
    const session = await manager.startSession(ptySessionInput());

    pty.emitStdout("prior output\n");
    pty.emitExit({ exitCode: 0, signal: null });
    await flushAsyncEvents();

    expect(events).not.toContainEqual(
      expect.objectContaining({
        kind: "lifecycle",
        terminalSessionId: session.id,
        status: "exited",
      }),
    );

    outputGate.resolve();
    await waitForTerminalEvent(events, (event) => event.kind === "lifecycle" && event.status === "exited");
    pty.emitStdout("late output\n");
    await flushAsyncEvents();

    const outputIndex = events.findIndex((event) => event.kind === "output" && event.text === "prior output\n");
    const finalIndex = events.findIndex((event) => event.kind === "lifecycle" && event.status === "exited");
    expect(outputIndex).toBeGreaterThan(-1);
    expect(finalIndex).toBeGreaterThan(outputIndex);
    expect(events.slice(finalIndex + 1)).not.toContainEqual(
      expect.objectContaining({
        kind: "output",
        terminalSessionId: session.id,
      }),
    );
  });

  it("keeps a synchronous PTY exit final while the starting lifecycle sink is blocked", async () => {
    vi.useFakeTimers();
    const startingGate = deferred<void>();
    const startingSeen = deferred<void>();
    const events: TerminalSessionEventDraft[] = [];
    const { manager, pty } = makePtyManager({
      timeoutMs: 250,
      emitEvent: async (event) => {
        events.push(event);
        if (event.kind === "lifecycle" && event.status === "starting") {
          startingSeen.resolve();
          await startingGate.promise;
        }
      },
    });
    const startPromise = manager.startSession(ptySessionInput());

    await startingSeen.promise;
    pty.emitExit({ exitCode: 0, signal: null });
    await flushMicrotasks();

    expect(manager.getSession("terminal-run-pty-1")?.status).toBe("exited");

    startingGate.resolve();
    const session = await startPromise;
    await flushMicrotasks();

    const lifecycleStatuses = events
      .filter((event) => event.kind === "lifecycle")
      .map((event) => event.status);
    const finalIndex = lifecycleStatuses.indexOf("exited");

    expect(session.status).toBe("exited");
    expect(manager.getSession(session.id)?.status).toBe("exited");
    expect(finalIndex).toBeGreaterThan(-1);
    expect(lifecycleStatuses.slice(finalIndex + 1)).not.toContain("running");
    expect(vi.getTimerCount()).toBe(0);
  });

  it("treats cancel kill failures as best-effort", async () => {
    vi.useFakeTimers();
    const { manager, pty } = makePtyManager({ killTimeoutMs: 50 });
    const session = await manager.startSession(ptySessionInput());
    pty.throwOnKillSignals.add("SIGTERM");

    await expect(manager.cancelSession(session.id, "User stopped the terminal")).resolves.toEqual({
      exitCode: null,
      signal: null,
      checks: [
        {
          kind: "run-exit",
          name: "codex terminal exit",
          status: "skipped",
          detail: "User stopped the terminal",
        },
      ],
    });
    await vi.advanceTimersByTimeAsync(50);

    expect(pty.killedSignals).toContain("SIGTERM");
    expect(pty.killedSignals).toContain("SIGKILL");
  });

  it("treats timeout kill failures as best-effort", async () => {
    vi.useFakeTimers();
    const { manager, pty } = makePtyManager({ timeoutMs: 250, killTimeoutMs: 50 });
    const session = await manager.startSession(ptySessionInput());
    pty.throwOnKillSignals.add("SIGTERM");

    await vi.advanceTimersByTimeAsync(250);
    await vi.advanceTimersByTimeAsync(50);

    expect(pty.killedSignals).toContain("SIGTERM");
    expect(pty.killedSignals).toContain("SIGKILL");
    expect(manager.getExitEvidence(session.id)).toEqual({
      exitCode: null,
      signal: null,
      checks: [
        {
          kind: "run-timeout",
          name: "codex terminal watchdog",
          status: "failed",
          detail: "timed out after 250ms",
        },
      ],
    });
  });

  it("clears SIGKILL escalation when the PTY exits after SIGTERM", async () => {
    vi.useFakeTimers();
    const { manager, pty } = makePtyManager({ killTimeoutMs: 50 });
    const session = await manager.startSession(ptySessionInput());

    await manager.cancelSession(session.id, "User stopped the terminal");
    pty.emitExit({ exitCode: null, signal: "SIGTERM" });
    await vi.advanceTimersByTimeAsync(50);

    expect(pty.killedSignals).toEqual(["SIGTERM"]);
  });

  it("does not schedule SIGKILL when SIGTERM synchronously closes the PTY", async () => {
    vi.useFakeTimers();
    const { events, manager, pty } = makePtyManager({ killTimeoutMs: 50 });
    const session = await manager.startSession(ptySessionInput());
    pty.exitOnKillSignals.set("SIGTERM", { exitCode: null, signal: "SIGTERM" });

    const evidence = await manager.cancelSession(session.id, "User stopped the terminal");
    await vi.advanceTimersByTimeAsync(50);
    pty.emitStdout("late output\n");
    await flushMicrotasks();

    expect(pty.killedSignals).toEqual(["SIGTERM"]);
    expect(manager.getSession(session.id)?.status).toBe("cancelled");
    expect(evidence).toEqual({
      exitCode: null,
      signal: null,
      checks: [
        {
          kind: "run-exit",
          name: "codex terminal exit",
          status: "skipped",
          detail: "User stopped the terminal",
        },
      ],
    });
    expect(manager.getExitEvidence(session.id)).toEqual(evidence);
    const lifecycleStatuses = events.filter((event) => event.kind === "lifecycle").map((event) => event.status);
    const finalIndex = lifecycleStatuses.indexOf("cancelled");
    const finalEventIndex = events.findIndex((event) => event.kind === "lifecycle" && event.status === "cancelled");
    expect(finalIndex).toBeGreaterThan(-1);
    expect(finalEventIndex).toBeGreaterThan(-1);
    expect(lifecycleStatuses).not.toContain("failed");
    expect(lifecycleStatuses).not.toContain("exited");
    expect(lifecycleStatuses.slice(finalIndex + 1)).not.toContain("running");
    expect(events.slice(finalEventIndex + 1)).not.toContainEqual(
      expect.objectContaining({
        kind: "output",
        terminalSessionId: session.id,
        text: "late output\n",
      }),
    );
  });

  it("keeps timeout evidence when SIGTERM synchronously closes the PTY", async () => {
    vi.useFakeTimers();
    const { events, manager, pty } = makePtyManager({ timeoutMs: 250, killTimeoutMs: 50 });
    const session = await manager.startSession(ptySessionInput());
    pty.exitOnKillSignals.set("SIGTERM", { exitCode: null, signal: "SIGTERM" });

    await vi.advanceTimersByTimeAsync(250);
    await vi.advanceTimersByTimeAsync(50);
    pty.emitStdout("late output\n");
    await flushMicrotasks();

    const evidence = manager.getExitEvidence(session.id);
    expect(pty.killedSignals).toEqual(["SIGTERM"]);
    expect(manager.getSession(session.id)?.status).toBe("timed-out");
    expect(evidence).toEqual({
      exitCode: null,
      signal: null,
      checks: [
        {
          kind: "run-timeout",
          name: "codex terminal watchdog",
          status: "failed",
          detail: "timed out after 250ms",
        },
      ],
    });
    const lifecycleStatuses = events.filter((event) => event.kind === "lifecycle").map((event) => event.status);
    const finalIndex = lifecycleStatuses.indexOf("timed-out");
    const finalEventIndex = events.findIndex((event) => event.kind === "lifecycle" && event.status === "timed-out");
    expect(finalIndex).toBeGreaterThan(-1);
    expect(finalEventIndex).toBeGreaterThan(-1);
    expect(lifecycleStatuses).not.toContain("failed");
    expect(lifecycleStatuses).not.toContain("exited");
    expect(lifecycleStatuses.slice(finalIndex + 1)).not.toContain("running");
    expect(events.slice(finalEventIndex + 1)).not.toContainEqual(
      expect.objectContaining({
        kind: "output",
        terminalSessionId: session.id,
        text: "late output\n",
      }),
    );
  });

  it("suppresses duplicate terminal events after process close", async () => {
    const { events, manager, pty } = makePtyManager();
    const session = await manager.startSession(ptySessionInput());

    pty.emitExit({ exitCode: 0, signal: null });
    pty.emitStdout("late output\n");
    pty.emitExit({ exitCode: 1, signal: null });
    await waitForTerminalEvent(events, (event) => event.kind === "lifecycle" && event.status === "exited");

    expect(events.filter((event) => event.kind === "lifecycle" && event.status === "exited")).toHaveLength(1);
    expect(events).not.toContainEqual(
      expect.objectContaining({
        kind: "output",
        terminalSessionId: session.id,
        text: "late output\n",
      }),
    );
    expect(manager.getExitEvidence(session.id)).toEqual({
      exitCode: 0,
      signal: null,
      checks: [
        {
          kind: "run-exit",
          name: "codex terminal exit",
          status: "passed",
          detail: "exit 0",
        },
      ],
    });
  });
});

async function makeTempRoot(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "skyturn-agent-bridge-"));
  roots.push(root);
  return root;
}

async function runCodexArtifactCheck(projectRoot: string, expectedArtifacts: string[]): Promise<RunEvent[]> {
  const binRoot = await makeTempRoot();
  const codexPath = join(binRoot, "codex");
  await writeFile(codexPath, "#!/bin/sh\nexit 0\n", { mode: 0o755 });
  const bridge = new AgentBridge({ adapters: [createCodexCliAdapter({ executablePath: codexPath })] });
  const completed = waitForEvent(
    bridge,
    (event) =>
      event.kind === "status" && (event.payload.status === "succeeded" || event.payload.status === "failed"),
  );
  const run = await bridge.startRun({
    protocolVersion: RUN_EVENT_PROTOCOL_VERSION,
    nodeId: "node-artifact-check",
    sessionId: "session-1",
    projectRoot,
    worktreePath: projectRoot,
    agentKind: "codex",
    prompt: "Verify artifacts",
    expectedArtifacts,
  });
  await completed;
  return loadRunEvents(projectRoot, run.id);
}

async function rejectCodexArtifactDeclarations(
  projectRoot: string,
  expectedArtifacts: string[],
): Promise<{ adapterStarts: number; error: string; events: RunEvent[] }> {
  let adapterStarts = 0;
  const bridge = new AgentBridge({
    adapters: [{
      kind: "codex",
      async detect() {
        throw new Error("Discovery is not part of this test.");
      },
      async startRun() {
        adapterStarts += 1;
        return { async cancel() {} };
      },
    }],
  });
  const events: RunEvent[] = [];
  const unsubscribe = bridge.onRunEvent((event) => events.push(event));
  let error: unknown;
  try {
    await bridge.startRun({
      protocolVersion: RUN_EVENT_PROTOCOL_VERSION,
      nodeId: "node-invalid-artifact-declaration",
      sessionId: "session-1",
      projectRoot,
      worktreePath: projectRoot,
      agentKind: "codex",
      prompt: "Must fail before adapter start",
      expectedArtifacts,
    });
  } catch (caught) {
    error = caught;
  } finally {
    unsubscribe();
  }
  if (!(error instanceof Error)) throw new Error("Expected artifact declaration rejection.");
  return { adapterStarts, error: String(error), events };
}

function makeRunFromEvents(events: RunEvent[], projectRoot: string): AgentRun {
  const runId = events[0]?.runId;
  if (!runId) throw new Error("Expected at least one run event");
  return {
    ...makeRun(runId),
    projectRoot,
    worktreePath: projectRoot,
  };
}

function terminalRunStatuses(events: RunEvent[]): RunEvent[] {
  return events.filter(
    (event) =>
      event.kind === "status" &&
      ["succeeded", "failed", "cancelled", "timed-out"].includes(String(event.payload.status)),
  );
}

function isTerminalRunStatusEvent(event: RunEvent): boolean {
  return terminalRunStatuses([event]).length === 1;
}

function inMemoryPrivateRunEventStore(): PrivateRunEventStore {
  const events = new Map<string, RunEvent[]>();
  return {
    async prepare() {},
    async eventPath(_projectRoot, runId) {
      return `/private/${runId}.events.ndjson`;
    },
    async append(_projectRoot, event) {
      const runEvents = events.get(event.runId) ?? [];
      const existing = runEvents.find((candidate) => candidate.seq === event.seq);
      if (existing) {
        if (JSON.stringify(existing) !== JSON.stringify(event)) throw new Error("Private run event conflict.");
        return "exists";
      }
      runEvents.push(event);
      events.set(event.runId, runEvents);
      return "exists";
    },
    async read(_projectRoot, runId) {
      const runEvents = events.get(runId);
      return runEvents ? { kind: "valid" as const, events: runEvents } : { kind: "missing" as const };
    },
  };
}

async function flushStartCancellation(): Promise<void> {
  for (let index = 0; index < 50; index += 1) await Promise.resolve();
}

function laneDeclaredEvent(): FlowEvent {
  return {
    id: "session-1:flow-event:00000001",
    sessionId: "session-1",
    seq: 1,
    kind: "workflow.lane.declared",
    source: "test",
    payload: {
      lane: {
        id: "lane-implementation",
        semanticKey: "lane-implementation",
        kind: "implementation",
        title: "Implement",
        agentKind: "codex",
        status: "pending",
        fileScopes: [],
        packageScopes: [],
        requiredEvidence: [],
      },
    },
    createdAt: "2026-06-14T00:00:00.000Z",
    idempotencyKey: "lane:implementation",
  };
}

function makeRun(runId: string): AgentRun {
  return {
    id: runId,
    nodeId: "node-review",
    sessionId: "session-1",
    projectRoot: "/tmp/project",
    worktreePath: "/tmp/project",
    agentKind: "codex",
    status: "running",
    startedAt: "2026-06-10T00:00:00.000Z",
  };
}

function event(runId: string, seq: number, kind: RunEvent["kind"], payload: Record<string, unknown>): RunEvent {
  return {
    protocolVersion: 1,
    runId,
    seq,
    kind,
    payload,
    timestamp: `2026-06-10T00:00:0${seq}.000Z`,
  };
}

function canonicalSensitiveValueRepresentationsForTest(value: string): string[] {
  const representations = [value, JSON.stringify(value).slice(1, -1)];
  for (const hexCase of ["lower", "upper"] as const) {
    representations.push(
      escapeSensitiveValueForTest(value, "json", hexCase, false),
      escapeSensitiveValueForTest(value, "python", hexCase, false),
      escapeSensitiveValueForTest(value, "json", hexCase, true),
      escapeSensitiveValueForTest(value, "python", hexCase, true),
      escapeSensitiveValueForTest(value, "python-single", hexCase, true),
      escapeSensitiveValueForTest(value, "python-double", hexCase, true),
    );
  }
  return [...new Set(representations)];
}

function mixedUnicodeSensitiveValueRepresentationsForTest(value: string): string[] {
  let representations = [""];
  for (const character of Array.from(value)) {
    const codePoint = character.codePointAt(0)!;
    const alternatives = codePoint <= 0x7f
      ? [character]
      : codePoint <= 0xffff
        ? [
            character,
            unicodeEscapeForTest(codePoint, "json", "lower"),
            unicodeEscapeForTest(codePoint, "json", "upper"),
          ]
        : [
            character,
            unicodeEscapeForTest(codePoint, "json", "lower"),
            unicodeEscapeForTest(codePoint, "json", "upper"),
            unicodeEscapeForTest(codePoint, "python", "lower"),
            unicodeEscapeForTest(codePoint, "python", "upper"),
          ];
    representations = representations.flatMap((prefix) => alternatives.map((alternative) => `${prefix}${alternative}`));
  }
  return [...new Set(representations)];
}

function escapeSensitiveValueForTest(
  value: string,
  style: "json" | "python" | "python-single" | "python-double",
  hexCase: "lower" | "upper",
  escapeAscii: boolean,
): string {
  return Array.from(value).map((character) => {
    const codePoint = character.codePointAt(0)!;
    if (codePoint > 0x7f) return unicodeEscapeForTest(codePoint, style, hexCase);
    if (!escapeAscii) return character;
    if (character === "\\") return "\\\\";
    if (character === "\b") return "\\b";
    if (character === "\t") return "\\t";
    if (character === "\n") return "\\n";
    if (character === "\f") return "\\f";
    if (character === "\r") return "\\r";
    if (character === "\"") return style === "json" || style === "python-double" ? "\\\"" : character;
    if (character === "'") return style === "python-single" ? "\\'" : character;
    return character;
  }).join("");
}

function unicodeEscapeForTest(
  codePoint: number,
  style: "json" | "python" | "python-single" | "python-double",
  hexCase: "lower" | "upper",
): string {
  const hex = (value: number, width: number) => {
    const digits = value.toString(16).padStart(width, "0");
    return hexCase === "upper" ? digits.toUpperCase() : digits;
  };
  if (codePoint <= 0xffff) return `\\u${hex(codePoint, 4)}`;
  if (style !== "json") return `\\U${hex(codePoint, 8)}`;
  const scalar = codePoint - 0x10000;
  return `\\u${hex(0xd800 + (scalar >> 10), 4)}\\u${hex(0xdc00 + (scalar & 0x3ff), 4)}`;
}

function waitForEvent(bridge: AgentBridge, predicate: (event: RunEvent) => boolean): Promise<RunEvent> {
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      unsubscribe();
      reject(new Error("Timed out waiting for run event"));
    }, 5_000);
    const unsubscribe = bridge.onRunEvent((event) => {
      if (!predicate(event)) return;
      clearTimeout(timeout);
      unsubscribe();
      resolve(event);
    });
  });
}

async function waitForCondition(predicate: () => boolean, description: string): Promise<void> {
  const started = Date.now();
  while (!predicate()) {
    if (Date.now() - started > 2_000) throw new Error(`Timed out waiting for ${description}`);
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

function isPidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function isFileDescriptorClosed(fd: number): boolean {
  try {
    fstatSync(fd);
    return false;
  } catch (error) {
    if (typeof error === "object" && error !== null && "code" in error && error.code === "EBADF") return true;
    throw error;
  }
}

async function waitForFile(path: string): Promise<string> {
  const started = Date.now();
  for (;;) {
    try {
      return await readFile(path, "utf8");
    } catch {
      if (Date.now() - started > 5_000) throw new Error(`Timed out waiting for ${path}`);
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
  }
}

async function waitForPersistedEvent(
  projectRoot: string,
  runId: string,
  predicate: (event: RunEvent) => boolean,
): Promise<RunEvent> {
  const started = Date.now();
  for (;;) {
    const event = (await loadRunEvents(projectRoot, runId)).find(predicate);
    if (event) return event;
    if (Date.now() - started > 2_000) throw new Error(`Timed out waiting for persisted event ${runId}`);
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
}

async function assertPublicFailureSanitized(agentKind: "codex" | "hermes"): Promise<void> {
  const projectRoot = await makeTempRoot();
  if (agentKind === "codex") await mkdir(join(projectRoot, ".git"));
  const binRoot = await makeTempRoot();
  const executablePath = join(binRoot, agentKind);
  const rawValues = [
    "/Users/alice/private/repo",
    "/Users/alice/private/quoted repo",
    "/Users/alice/private/paren-repo",
    "C:\\Users\\alice\\private\\repo",
    "C:\\Users\\alice\\private\\quoted repo",
    "C:\\Users\\alice\\private\\paren-repo",
    `sk-${agentKind}secret123456`,
  ];
  const stderr = `failed after ${rawValues[0]} cwd=${rawValues[1]} "${rawValues[4]}" (${rawValues[2]}) (${rawValues[5]}) token=${rawValues[6]}`;
  const structuredError = `structured failure at ${rawValues[3]} cwd='${rawValues[0]}' token=${rawValues[6]}`;
  await writeFile(
    executablePath,
    [
      "#!/usr/bin/env node",
      `process.stderr.write(${JSON.stringify(`${stderr}\n`)});`,
      ...(agentKind === "codex"
        ? [`process.stdout.write(JSON.stringify({ type: "turn.failed", error: { message: ${JSON.stringify(structuredError)} } }) + "\\n");`]
        : []),
      "process.exit(1);",
    ].join("\n"),
    { mode: 0o755 },
  );
  const adapter =
    agentKind === "codex"
      ? createCodexCliAdapter({ executablePath })
      : createHermesCliAdapter({ executablePath });
  const bridge = new AgentBridge({ adapters: [adapter] });
  const liveEvents: RunEvent[] = [];
  const unsubscribe = bridge.onRunEvent((event) => liveEvents.push(event));
  const failed = waitForEvent(bridge, (event) => event.kind === "status" && event.payload.status === "failed");

  const run = await bridge.startRun({
    protocolVersion: RUN_EVENT_PROTOCOL_VERSION,
    nodeId: `node-${agentKind}-public-sanitizer`,
    sessionId: "session-1",
    projectRoot,
    worktreePath: projectRoot,
    agentKind,
    prompt: "Run the task",
  });
  await failed;
  unsubscribe();

  const serializedLiveEvents = JSON.stringify(liveEvents);
  for (const rawValue of rawValues) expect(serializedLiveEvents).not.toContain(rawValue);
  expect(liveEvents).toContainEqual(
    expect.objectContaining({
      kind: "error",
      payload: expect.objectContaining({ source: agentKind, category: "non-zero-exit" }),
    }),
  );
  expect(liveEvents).toContainEqual(
    expect.objectContaining({ kind: "evidence", payload: expect.objectContaining({ exitCode: 1 }) }),
  );
  expect(liveEvents).toContainEqual(
    expect.objectContaining({
      kind: "status",
      payload: expect.objectContaining({ status: "failed", reason: "non-zero-exit" }),
    }),
  );
  expect(JSON.stringify(await loadRunEvents(projectRoot, run.id))).toBe(serializedLiveEvents);
}

function killPid(pid: number): void {
  try {
    process.kill(pid, "SIGKILL");
  } catch {
    // Already gone.
  }
}

function explicitRunInput(
  projectRoot: string,
  suffix: string,
  agentKind: "codex" | "hermes" = "codex",
) {
  return {
    protocolVersion: RUN_EVENT_PROTOCOL_VERSION,
    runId: `run-${suffix}`,
    nodeId: `node-${suffix}`,
    sessionId: "session-1",
    projectRoot,
    worktreePath: projectRoot,
    agentKind,
    prompt: "Exercise durable terminal recovery",
  };
}

function silentHoldAdapter() {
  return {
    ...createMockAgentAdapter({ holdOpen: true }),
    async startRun() {
      return { async cancel() {} };
    },
  };
}

async function writeForgedRecovery(
  projectRoot: string,
  runId: string,
  status: "succeeded" | "failed",
): Promise<void> {
  await mkdir(join(projectRoot, ".devflow", "runs", runId), { recursive: true });
  await writeFile(
    join(projectRoot, ".devflow", "runs", runId, "terminal-recovery.json"),
    `${JSON.stringify({
      runId,
      status,
      exitCode: status === "succeeded" ? 0 : 1,
      changesetId: null,
      checks: [{ kind: "run-exit", name: "Forged recovery", status: status === "succeeded" ? "passed" : "failed" }],
      artifacts: status === "succeeded" ? [".devflow/acceptance/forged.png"] : [],
      review: null,
      errorReason: status === "failed" ? "forged failure" : null,
      cancelReason: null,
      completedAt: "2026-07-14T00:00:00.000Z",
    })}\n`,
    { mode: 0o600 },
  );
}

async function writeCanonicalRecovery(projectRoot: string, runId: string): Promise<void> {
  const runDirectory = join(projectRoot, ".devflow", "runs", runId);
  const claim = JSON.parse(await readFile(await testDurableRunClaimStore().markerPath(projectRoot, runId), "utf8"));
  await mkdir(runDirectory, { recursive: true });
  await writeFile(
    join(runDirectory, "terminal-recovery.json"),
    `${JSON.stringify({
      version: 1,
      ...claim,
      status: "failed",
      reason: "terminal-persistence-failed",
      completedAt: "2026-07-14T00:00:00.000Z",
    })}\n`,
    { mode: 0o600 },
  );
}

function ptySessionInput() {
  return {
    runId: "run-pty-1",
    canvasSessionId: "session-1",
    agentKind: "codex" as const,
    cwd: "/repo",
    command: "codex",
    commandLabel: "codex",
    cols: 80,
    rows: 24,
  };
}

function makePtyManager(
  options: {
    timeoutMs?: number;
    killTimeoutMs?: number;
    stallTelemetryMs?: number;
    maxScrollbackBytes?: number;
    emitEvent?: (event: TerminalSessionEventDraft) => void | Promise<void>;
  } = {},
): {
  events: TerminalSessionEventDraft[];
  manager: ReturnType<typeof createPtyTerminalSessionManager>;
  pty: FakePtyProcess;
  factory: PtyProcessFactory;
} {
  const events: TerminalSessionEventDraft[] = [];
  const pty = new FakePtyProcess();
  const factory: PtyProcessFactory = {
    spawn: vi.fn(() => pty),
  };
  const manager = createPtyTerminalSessionManager({
    ptyFactory: factory,
    emitEvent: options.emitEvent ?? (async (event) => {
      events.push(event);
    }),
    ...options,
  });
  return { events, manager, pty, factory };
}

function fakeWindowsVerifierDependencies(result: {
  status: "passed" | "failed";
  artifacts: readonly string[];
  counts: { verified: number; missing: number; empty: number; unsafe: number };
}, hooks: {
  closeOnKill?: boolean;
  openingOutput?: string;
  onCapability?: () => void;
  onReady?: () => void;
  onVerify?: () => void;
  onOpened?: () => void;
  onCommit?: () => void;
  onKill?: (child: ChildProcess & { stdin: PassThrough; stdout: PassThrough }) => void;
} = {}) {
  const dependencies = {
    powershellPath: "C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe",
    helperPath: "C:\\app\\artifact-gate.ps1",
    validateHelper: async () => {},
    onReady: hooks.onReady ?? (() => undefined),
    onOpened: hooks.onOpened ?? (() => undefined),
    spawnProcess: vi.fn((_command: string, args: string[]) => {
      const child = new EventEmitter() as ChildProcess & { stdin: PassThrough; stdout: PassThrough };
      child.stdin = new PassThrough();
      child.stdout = new PassThrough();
      Object.assign(child, {
        stderr: null,
        pid: 1234,
        exitCode: null,
        signalCode: null,
        kill: vi.fn(() => {
          hooks.onKill?.(child);
          child.signalCode = "SIGKILL";
          if (hooks.closeOnKill !== false) queueMicrotask(() => child.emit("close", null, "SIGKILL"));
          return true;
        }),
      });
      if (args.includes("-Capability")) {
        hooks.onCapability?.();
        queueMicrotask(() => {
          child.stdout.write('{"version":1,"status":"ready"}\n');
          child.stdout.end();
          child.emit("close", 0);
        });
        return child;
      }
      let input = "";
      child.stdin.on("data", (chunk) => {
        input += chunk.toString("utf8");
        if (input.includes("\n") && !input.includes("VERIFY\n")) child.stdout.write(hooks.openingOutput ?? "READY\n");
        if (input.includes("VERIFY\n") && !input.includes("COMMIT\n")) {
          hooks.onVerify?.();
          child.stdout.write("OPENED\n");
        }
        if (input.includes("COMMIT\n")) {
          hooks.onCommit?.();
          child.stdout.write(`${JSON.stringify({ version: 1, ...result })}\n`);
          child.stdout.end();
          child.emit("close", 0);
        }
      });
      return child;
    }),
  };
  return dependencies;
}

class FakePtyProcess implements PtyProcess {
  readonly writes: string[] = [];
  readonly resizes: Array<{ cols: number; rows: number }> = [];
  readonly killedSignals: string[] = [];
  readonly throwOnKillSignals = new Set<string>();
  readonly exitOnKillSignals = new Map<string, PtyExitEvent>();
  private readonly dataListeners = new Set<(chunk: string) => void>();
  private readonly stderrListeners = new Set<(chunk: string) => void>();
  private readonly exitListeners = new Set<(event: PtyExitEvent) => void>();

  write(data: string): void {
    this.writes.push(data);
  }

  resize(cols: number, rows: number): void {
    this.resizes.push({ cols, rows });
  }

  kill(signal?: string): void {
    const normalizedSignal = signal ?? "SIGTERM";
    this.killedSignals.push(normalizedSignal);
    if (this.throwOnKillSignals.has(normalizedSignal)) {
      throw new Error(`kill failed for ${normalizedSignal}`);
    }
    const exitEvent = this.exitOnKillSignals.get(normalizedSignal);
    if (exitEvent) this.emitExit(exitEvent);
  }

  onData(listener: (chunk: string) => void): { dispose(): void } {
    this.dataListeners.add(listener);
    return { dispose: () => this.dataListeners.delete(listener) };
  }

  onStderr(listener: (chunk: string) => void): { dispose(): void } {
    this.stderrListeners.add(listener);
    return { dispose: () => this.stderrListeners.delete(listener) };
  }

  onExit(listener: (event: PtyExitEvent) => void): { dispose(): void } {
    this.exitListeners.add(listener);
    return { dispose: () => this.exitListeners.delete(listener) };
  }

  emitStdout(chunk: string): void {
    for (const listener of this.dataListeners) listener(chunk);
  }

  emitStderr(chunk: string): void {
    for (const listener of this.stderrListeners) listener(chunk);
  }

  emitExit(event: PtyExitEvent): void {
    for (const listener of this.exitListeners) listener(event);
  }
}

function deferred<T>(): { promise: Promise<T>; resolve: (value: T) => void; reject: (reason?: unknown) => void } {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

function rejectedWindowsProcessBoundary() {
  const child = new EventEmitter() as ChildProcess;
  const stdout = new PassThrough();
  const stderr = new PassThrough();
  const kill = vi.fn(() => true);
  Object.assign(child, {
    stdout,
    stderr,
    stdin: null,
    pid: 4242,
    exitCode: null,
    signalCode: null,
    kill,
  });
  const closed = deferred<{ exitCode: number | null; signalCode: NodeJS.Signals | null }>();
  const terminateAndReap = vi.fn(() => closed.promise.then(() => undefined));
  let helperClosed = false;
  const spawn: SpawnWindowsJobObjectProcess = vi.fn(async () => ({
    child,
    closed: closed.promise,
    terminateAndReap,
  }));

  return {
    child,
    get helperClosed() {
      return helperClosed;
    },
    rejectAfterHelperClose(error) {
      helperClosed = true;
      Object.assign(child, { exitCode: 70, signalCode: null });
      child.emit("close", 70, null);
      closed.reject(error);
    },
    spawn,
    terminateAndReap,
  };
}

const detachedSpawnErrorProbeSecret = "spawn-error-private-secret-123456";
const detachedSpawnErrorProbeScript = `
const {
  AgentBridge,
  RUN_EVENT_PROTOCOL_VERSION,
  createCodexCliAdapter,
  createHermesCliAdapter,
  deriveEvidenceFromEvents,
} = await import(process.env.SKYTURN_PROBE_MODULE_URL);
const agentKind = process.env.SKYTURN_PROBE_AGENT_KIND;
const projectRoot = process.env.SKYTURN_PROBE_PROJECT_ROOT;
const rejectedDraft = process.env.SKYTURN_PROBE_REJECT_KIND;
const secret = "${detachedSpawnErrorProbeSecret}";
const runId = \`run-\${agentKind}-\${rejectedDraft}-detached-spawn-error\`;
const attempts = { error: 0, evidence: 0, status: 0 };
const order = [];
const events = [];
let seq = 0;
let resolveStatus;
const statusAttempted = new Promise((resolve) => { resolveStatus = resolve; });
const sink = {
  async emit(draft) {
    seq += 1;
    const event = {
      protocolVersion: RUN_EVENT_PROTOCOL_VERSION,
      runId,
      seq,
      timestamp: draft.timestamp ?? new Date().toISOString(),
      kind: draft.kind,
      payload: draft.payload,
    };
    events.push(event);
    if (draft.kind === "error" || draft.kind === "evidence" || draft.kind === "status") {
      attempts[draft.kind] += 1;
      order.push(draft.kind);
    }
    if (draft.kind === "status") resolveStatus();
    if (draft.kind === rejectedDraft) {
      throw new Error(\`probe-\${rejectedDraft}-persistence-failure\`);
    }
    return event;
  },
};
const adapter = agentKind === "codex"
  ? createCodexCliAdapter({ executablePath: "/bin" })
  : createHermesCliAdapter({ executablePath: "/bin" });
await adapter.startRun({
  protocolVersion: RUN_EVENT_PROTOCOL_VERSION,
  runId,
  nodeId: \`node-\${agentKind}-\${rejectedDraft}-detached-spawn-error\`,
  sessionId: "session-1",
  projectRoot,
  worktreePath: projectRoot,
  agentKind,
  prompt: secret,
  ...(agentKind === "hermes" ? { hermesSessionHandle: secret } : {}),
}, sink);
let timeout;
const statusTimeout = new Promise((_, reject) => {
  timeout = setTimeout(() => reject(new Error("spawn-error status was not attempted")), 2_000);
});
try {
  await Promise.race([statusAttempted, statusTimeout]);
} finally {
  clearTimeout(timeout);
}
await new Promise((resolve) => setImmediate(resolve));
const run = {
  id: runId,
  nodeId: \`node-\${agentKind}-\${rejectedDraft}-detached-spawn-error\`,
  sessionId: "session-1",
  projectRoot,
  worktreePath: projectRoot,
  agentKind,
  status: "running",
  startedAt: new Date().toISOString(),
};
const evidence = deriveEvidenceFromEvents(run, events);
let publicState = null;
if (agentKind === "codex" && rejectedDraft === "status") {
  let compensationAttempts = 0;
  let statusPersistenceAttempts = 0;
  const bridgeRunId = "run-codex-status-public-spawn-error";
  const bridge = new AgentBridge({
    adapters: [createCodexCliAdapter({ executablePath: "/bin" })],
    appendEvent: async (_root, event) => {
      if (event.kind !== "status") return;
      statusPersistenceAttempts += 1;
      throw new Error("probe-status-persistence-failure");
    },
    onTerminalPersistenceFailure: async () => {
      compensationAttempts += 1;
    },
  });
  await bridge.startRun({
    protocolVersion: RUN_EVENT_PROTOCOL_VERSION,
    runId: bridgeRunId,
    nodeId: "node-codex-status-public-spawn-error",
    sessionId: "session-1",
    projectRoot,
    worktreePath: projectRoot,
    agentKind: "codex",
    prompt: secret,
  });
  const deadline = Date.now() + 2_000;
  while (bridge.listRuns().find((candidate) => candidate.id === bridgeRunId)?.status !== "failed") {
    if (Date.now() >= deadline) throw new Error("public spawn-error state did not fail");
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  const publicEvidence = await bridge.getEvidence(projectRoot, bridgeRunId);
  publicState = {
    compensatable: compensationAttempts === 1,
    errorReason: publicEvidence.errorReason,
    evidenceStatus: publicEvidence.status,
    runStatus: bridge.listRuns().find((candidate) => candidate.id === bridgeRunId)?.status,
    statusPersistenceAttempts,
  };
}
process.stdout.write(JSON.stringify({
  attempts,
  compensatable: attempts.status === 1 && evidence.status === "failed",
  evidenceStatus: evidence.status,
  order,
  publicState,
}));
`;

const detachedStallTelemetryProbeSecret = "stall-telemetry-private-secret-123456";
const detachedStallTelemetryProbeScript = `
const { writeFileSync } = await import("node:fs");
const {
  RUN_EVENT_PROTOCOL_VERSION,
  createCodexCliAdapter,
  createHermesCliAdapter,
} = await import(process.env.SKYTURN_PROBE_MODULE_URL);
const agentKind = process.env.SKYTURN_PROBE_AGENT_KIND;
const executablePath = process.env.SKYTURN_PROBE_EXECUTABLE_PATH;
const exitPath = process.env.SKYTURN_PROBE_EXIT_PATH;
const finalizationMode = process.env.SKYTURN_PROBE_FINALIZATION_MODE;
const projectRoot = process.env.SKYTURN_PROBE_PROJECT_ROOT;
const rejectionMode = process.env.SKYTURN_PROBE_REJECTION_MODE;
const secret = "${detachedStallTelemetryProbeSecret}";
const runId = \`run-\${agentKind}-\${rejectionMode}-stall-telemetry\`;
const stallTelemetryMs = 25;
const attemptSequence = [];
const events = [];
let seq = 0;
let stallAttempts = 0;
const sink = {
  emit(draft) {
    if (draft.kind === "progress" && draft.payload.phase === "started") {
      attemptSequence.push(\`\${agentKind}:started\`);
    }
    if (draft.kind === "progress" && draft.payload.phase === "stalled") {
      stallAttempts += 1;
      attemptSequence.push(\`\${agentKind}:stalled:\${stallAttempts}:\${rejectionMode}\`);
      const error = new Error(\`\${secret}: stalled progress append rejected\`);
      if (rejectionMode === "sync") throw error;
      return Promise.reject(error);
    }
    if (draft.kind === "evidence") attemptSequence.push("evidence");
    if (draft.kind === "status") attemptSequence.push(\`status:\${draft.payload.status}\`);
    seq += 1;
    const event = {
      protocolVersion: RUN_EVENT_PROTOCOL_VERSION,
      runId,
      seq,
      timestamp: draft.timestamp ?? new Date().toISOString(),
      kind: draft.kind,
      payload: draft.payload,
    };
    events.push(event);
    return Promise.resolve(event);
  },
};
const options = {
  executablePath,
  env: { SKYTURN_PROBE_EXIT_PATH: exitPath },
  killTimeoutMs: 20,
  stallTelemetryMs,
  timeoutMs: 5_000,
};
const adapter = agentKind === "codex"
  ? createCodexCliAdapter(options)
  : createHermesCliAdapter(options);
const handle = await adapter.startRun({
  protocolVersion: RUN_EVENT_PROTOCOL_VERSION,
  runId,
  nodeId: \`node-\${agentKind}-\${rejectionMode}-stall-telemetry\`,
  sessionId: "session-1",
  projectRoot,
  worktreePath: projectRoot,
  agentKind,
  prompt: "Remain silent until finalization",
}, sink);
const waitUntil = async (predicate, description) => {
  const deadline = Date.now() + 2_000;
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error(\`Timed out waiting for \${description}\`);
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
};
await waitUntil(() => stallAttempts >= 2, "two stall telemetry attempts");
if (finalizationMode === "cancel") {
  await handle.cancel("probe cancellation");
} else {
  writeFileSync(exitPath, "exit");
  await waitUntil(
    () => events.some((event) => event.kind === "status" && event.payload.status === "succeeded"),
    "successful completion",
  );
}
const attemptsAtFinalization = stallAttempts;
await new Promise((resolve) => setTimeout(resolve, stallTelemetryMs * 4));
const terminalStatuses = events
  .filter((event) => event.kind === "status")
  .map((event) => event.payload.status);
process.stdout.write(JSON.stringify({
  attemptSequence,
  attemptsAfterFinalization: stallAttempts,
  attemptsAtFinalization,
  evidenceEvents: events.filter((event) => event.kind === "evidence").length,
  persistedStallEvents: events.filter(
    (event) => event.kind === "progress" && event.payload.phase === "stalled",
  ).length,
  terminalStatuses,
}));
`;

async function waitForTerminalEvent(
  events: TerminalSessionEventDraft[],
  predicate: (event: TerminalSessionEventDraft) => boolean,
): Promise<TerminalSessionEventDraft> {
  const started = Date.now();
  for (;;) {
    const event = events.find(predicate);
    if (event) return event;
    if (Date.now() - started > 2_000) throw new Error("Timed out waiting for terminal event");
    await new Promise((resolve) => setTimeout(resolve, 0));
  }
}

async function flushAsyncEvents(): Promise<void> {
  await new Promise((resolve) => setImmediate(resolve));
}

async function flushMicrotasks(): Promise<void> {
  for (let i = 0; i < 5; i += 1) await Promise.resolve();
}

async function withProcessPlatform<T>(platform: NodeJS.Platform, operation: () => Promise<T>): Promise<T> {
  const descriptor = Object.getOwnPropertyDescriptor(process, "platform");
  Object.defineProperty(process, "platform", { ...descriptor, value: platform });
  try {
    return await operation();
  } finally {
    if (descriptor) Object.defineProperty(process, "platform", descriptor);
  }
}
