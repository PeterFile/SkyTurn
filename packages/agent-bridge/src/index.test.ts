import { appendFile, chmod, mkdir, mkdtemp, readFile, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";

import { afterEach, describe, expect, it, vi } from "vitest";
import type { AgentRun, RunEvent } from "@skyturn/project-core";
import type { TerminalSessionEventDraft } from "@skyturn/project-core";
import { reduceWorkflowEvents, type FlowEvent } from "@skyturn/workflow-kernel";

import {
  AgentBridge,
  RUN_EVENT_PROTOCOL_VERSION,
  createCodexCliAdapter,
  createDiscoveryService,
  createHermesCliAdapter,
  buildHermesPlannerPtyLaunch,
  createHermesPlannerPtyTransport,
  createMockAgentAdapter,
  createPtyTerminalSessionManager,
  deriveEvidenceFromEvents,
  flowEventsFromAgentRun,
  loadRunEvents,
  readTaskOutput,
  type PtyExitEvent,
  type PtyProcess,
  type PtyProcessFactory,
} from "./index";

const roots: string[] = [];
const testDefaultWatchdogTimeoutMs = 250;

async function appendRunEventForTest(projectRoot: string, event: RunEvent): Promise<void> {
  const directory = join(projectRoot, ".devflow", "runs", event.runId);
  await mkdir(directory, { recursive: true });
  await appendFile(join(directory, "events.ndjson"), `${JSON.stringify(event)}\n`, "utf8");
}

afterEach(async () => {
  vi.useRealTimers();
  await Promise.all(roots.map((root) => rm(root, { force: true, recursive: true })));
  roots.length = 0;
});

describe("agent bridge", () => {
  it("single-flights concurrent starts for one explicit run id", async () => {
    const projectRoot = await makeTempRoot();
    const baseAdapter = createMockAgentAdapter({ holdOpen: true });
    let starts = 0;
    const bridge = new AgentBridge({
      adapters: [{
        ...baseAdapter,
        async startRun(input, sink) {
          const claim = await readFile(
            join(projectRoot, ".devflow", "runs", input.runId, "start-claim.json"),
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
    expect(starts).toBe(1);
    expect(bridge.listRuns()).toEqual([expect.objectContaining({
      id: input.runId,
      status: "running",
    })]);
    await bridge.cancelRun(input.runId, "test cleanup");
  });

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

  it("rejects a durable non-terminal explicit run claim after restart without relaunching", async () => {
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

    await expect(restartedBridge.startRun(input)).rejects.toThrow(/already (active|claimed)|non-terminal/i);
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

      await expect(bridge.startRun(input)).rejects.toThrow(`${failedKind} append failed`);
      expect(bridge.listRuns()).toContainEqual(expect.objectContaining({ id: input.runId, status: "failed" }));
      await expect(bridge.getEvidence(projectRoot, input.runId)).resolves.toMatchObject({
        runId: input.runId,
        status: "failed",
        errorReason: `${failedKind} append failed`,
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

  it("keeps persisted custom review evidence kinds", () => {
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

    expect(deriveEvidenceFromEvents(run, events).review).toEqual({
      kind: "policy-review",
      name: "Architecture review",
      status: "failed",
      detail: "Preserved from older persisted events.",
    });
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

  it("records verified expected Codex artifacts in RunEvidence", async () => {
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
        "const artifact = path.join(process.cwd(), '.devflow/acceptance/react-app.png');",
        "fs.mkdirSync(path.dirname(artifact), { recursive: true });",
        "fs.writeFileSync(artifact, 'png-bytes');",
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
      expectedArtifacts: [".devflow/acceptance/react-app.png"],
    });
    await completed;

    const events = await loadRunEvents(projectRoot, run.id);
    const evidence = deriveEvidenceFromEvents(run, events);

    expect(evidence.status).toBe("succeeded");
    expect(evidence.artifacts).toEqual([".devflow/acceptance/react-app.png"]);
  });

  it("does not record missing, empty, or unsafe expected Codex artifacts", async () => {
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
        "const empty = path.join(process.cwd(), '.devflow/acceptance/empty.png');",
        "const unsafe = path.join(process.cwd(), '.devflow/acceptance/token-secret.png');",
        "fs.mkdirSync(path.dirname(empty), { recursive: true });",
        "fs.writeFileSync(empty, '');",
        "fs.writeFileSync(unsafe, 'png-bytes');",
        "process.stdout.write('{\"type\":\"item.completed\",\"item\":{\"type\":\"agent_message\",\"text\":\"done\"}}\\n');",
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
        ".devflow/acceptance/missing.png",
        ".devflow/acceptance/empty.png",
        ".devflow/acceptance/token-secret.png",
      ],
    });
    await completed;

    const events = await loadRunEvents(projectRoot, run.id);
    const evidence = deriveEvidenceFromEvents(run, events);

    expect(evidence.status).toBe("succeeded");
    expect(evidence.artifacts).toEqual([]);
  });

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

  it("fails Codex runs with invalid-cwd category for an invalid worktreePath", async () => {
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
      worktreePath: join(projectRoot, "missing-worktree"),
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

  it("kills Codex child processes even when cancel event persistence fails", async () => {
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
      await expect(bridge.cancelRun(run.id, "User stopped the run")).rejects.toThrow();
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

    await bridge.startRun({
      protocolVersion: RUN_EVENT_PROTOCOL_VERSION,
      nodeId: "node-hermes",
      sessionId: "session-1",
      plannerSessionId: "hermes-planner-session-1",
      hermesSessionHandle: "opaque-hermes-session-1",
      projectRoot,
      worktreePath: projectRoot,
      agentKind: "hermes",
      prompt: "Continue the workflow",
    });
    await completed;

    const events = await loadRunEvents(projectRoot, "run-session-1-node-hermes");
    const args = JSON.parse(await readFile(argsPath, "utf8")) as { argv: string[]; cwd: string };

    expect(args.argv).toEqual([
      "chat",
      "-q",
      "Continue the workflow",
      "--quiet",
      "--source",
      "skyturn",
      "--resume",
      "opaque-hermes-session-1",
    ]);
    expect(args.argv).not.toContain("-z");
    expect(events).toContainEqual(
      expect.objectContaining({
        kind: "progress",
        payload: expect.objectContaining({
          source: "hermes",
          transport: "hermes_session_resume",
          opaqueHandle: "opaque-hermes-session-1",
        }),
      }),
    );
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

  it("uses Hermes public session resume in PTY launch when an opaque handle is provided", async () => {
    const projectRoot = await makeTempRoot();

    const launch = await buildHermesPlannerPtyLaunch(
      {
        runId: "run-hermes-pty-resume",
        canvasSessionId: "canvas-session-1",
        plannerSessionId: "hermes-planner-session-1",
        hermesSessionHandle: "opaque-hermes-session-1",
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
      "opaque-hermes-session-1",
    ]);
    expect(launch.metadata).toMatchObject({
      transport: "hermes_session_resume",
      continuity: "resume-handle",
      degraded: false,
      opaqueHandle: "opaque-hermes-session-1",
    });
    expect(launch.metadata.recoveryReason).toBeUndefined();
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

  it("captures and redacts stdout and stderr chunks in terminal events and scrollback", async () => {
    const { events, manager, pty } = makePtyManager();
    const session = await manager.startSession(ptySessionInput());

    pty.emitStdout("Bearer very-secret-token\n");
    pty.emitStderr("OPENAI_API_KEY=sk-test-secret-token\n");
    await waitForTerminalEvent(
      events,
      (event) => event.kind === "output" && event.stream === "stderr" && event.text === "OPENAI_API_KEY=[redacted]\n",
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
        text: "OPENAI_API_KEY=[redacted]\n",
      }),
    );
    const serialized = JSON.stringify({ events, scrollback: manager.getScrollback(session.id) });
    expect(serialized).not.toContain("very-secret-token");
    expect(serialized).not.toContain("sk-test-secret-token");
  });

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

function isPidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
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

function killPid(pid: number): void {
  try {
    process.kill(pid, "SIGKILL");
  } catch {
    // Already gone.
  }
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
