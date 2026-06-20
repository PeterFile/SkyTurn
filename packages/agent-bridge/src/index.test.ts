import { chmod, mkdir, mkdtemp, readFile, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";

import { afterEach, describe, expect, it, vi } from "vitest";
import type { AgentRun, RunEvent } from "@skyturn/project-core";
import { reduceWorkflowEvents, type FlowEvent } from "@skyturn/workflow-kernel";

import {
  AgentBridge,
  RUN_EVENT_PROTOCOL_VERSION,
  createCodexCliAdapter,
  createDiscoveryService,
  createHermesCliAdapter,
  createMockAgentAdapter,
  deriveEvidenceFromEvents,
  flowEventsFromAgentRun,
  loadRunEvents,
  readTaskOutput,
} from "./index";

const roots: string[] = [];
const testDefaultWatchdogTimeoutMs = 250;

afterEach(async () => {
  vi.useRealTimers();
  await Promise.all(roots.map((root) => rm(root, { force: true, recursive: true })));
  roots.length = 0;
});

describe("agent bridge", () => {
  it("discovers missing real agents without claiming run support", async () => {
    const discovery = createDiscoveryService({ pathValue: "" });

    const agents = await discovery.discover();
    const codex = agents.find((agent) => agent.kind === "codex");

    expect(codex?.status).toBe("missing");
    expect(codex?.supportLevel).toBe("detected-only");
  });

  it("discovers executables but keeps unverified CLI support detected-only", async () => {
    const root = await makeTempRoot();
    const bin = join(root, "codex");
    await writeFile(bin, "#!/bin/sh\nexit 0\n", { mode: 0o755 });
    const discovery = createDiscoveryService({ pathValue: root });

    const agents = await discovery.discover();
    const codex = agents.find((agent) => agent.kind === "codex");

    expect(codex?.status).toBe("available");
    expect(codex?.executablePath).toBe(bin);
    expect(codex?.supportLevel).toBe("detected-only");
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
      if (Date.now() - started > 2_000) throw new Error(`Timed out waiting for ${path}`);
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
