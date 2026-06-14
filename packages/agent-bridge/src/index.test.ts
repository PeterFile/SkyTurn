import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";

import { afterEach, describe, expect, it } from "vitest";
import type { RunEvent } from "@skyturn/project-core";

import {
  AgentBridge,
  RUN_EVENT_PROTOCOL_VERSION,
  createCodexCliAdapter,
  createDiscoveryService,
  createHermesCliAdapter,
  createMockAgentAdapter,
  deriveEvidenceFromEvents,
  loadRunEvents,
  readTaskOutput,
} from "./index";

const roots: string[] = [];

afterEach(async () => {
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
      projectRoot,
      "Implement the task",
    ]);
    expect(events.map((event) => event.seq)).toEqual(events.map((_, index) => index + 1));
    expect(output).toContain("hello from fake codex");
    expect(events.some((event) => event.kind === "progress" && event.payload.stream === "stderr")).toBe(true);
    expect(events.some((event) => event.kind === "progress" && event.payload.format === "text")).toBe(true);
    expect(evidence.status).toBe("succeeded");
    expect(evidence.exitCode).toBe(0);
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
