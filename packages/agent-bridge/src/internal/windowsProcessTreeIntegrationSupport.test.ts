import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { RunEventSink } from "@skyturn/agent-runtime";
import type { RunEvent } from "@skyturn/project-core";
import { describe, expect, it } from "vitest";

import {
  RUN_EVENT_PROTOCOL_VERSION,
  createCodexCliAdapter,
  createHermesCliAdapter,
} from "../index.js";
import {
  buildWindowsFixtureInvocation,
  formatWindowsFixtureStartFailure,
} from "./windowsProcessTreeIntegrationSupport.js";

describe("Windows process-tree integration support", () => {
  const canonicalWorkdir = "C:\\Users\\runneradmin\\AppData\\Local\\Temp\\skyturn case 雪";
  const fixturePath = `${canonicalWorkdir}\\agent-fixture.cjs`;
  const prompt = "Quoted \"prompt\" with trailing slash\\ and Unicode 雪\nsecond line";
  const resumeHandle = "resume \"capability\" with slash\\ and Unicode 水";

  it("places the explicit Codex fixture at the adapter extra-argument boundary", () => {
    expect(buildWindowsFixtureInvocation({
      agentKind: "codex",
      canonicalWorkdir,
      fixturePath,
      prompt,
      resumeHandle,
    })).toEqual({
      entryPoint: "exec",
      extraArgs: [fixturePath],
      expectedFixtureArgv: [
        "--json",
        "--ephemeral",
        "--color",
        "never",
        "--sandbox",
        "read-only",
        "-c",
        "approval_policy=never",
        fixturePath,
        "-C",
        canonicalWorkdir,
        prompt,
      ],
    });
  });

  it("places the explicit Hermes fixture after the resume argument", () => {
    expect(buildWindowsFixtureInvocation({
      agentKind: "hermes",
      canonicalWorkdir,
      fixturePath,
      prompt,
      resumeHandle,
    })).toEqual({
      entryPoint: "chat",
      extraArgs: [fixturePath],
      expectedFixtureArgv: [
        "-q",
        prompt,
        "--quiet",
        "--source",
        "skyturn",
        "--resume",
        resumeHandle,
        fixturePath,
      ],
    });
  });

  it.each(["codex", "hermes"] as const)(
    "matches the generated %s fixture argv to the real adapter ordering",
    async (agentKind) => {
      const projectRoot = await mkdtemp(join(tmpdir(), "skyturn-windows-fixture-argv-"));
      const binRoot = await mkdtemp(join(tmpdir(), "skyturn-windows-fixture-bin-"));
      try {
        await mkdir(join(projectRoot, ".git"));
        const canonicalRoot = await realpath(projectRoot);
        const argsPath = join(binRoot, "args.json");
        const executablePath = join(binRoot, "agent");
        const fixturePath = join(canonicalRoot, "agent-fixture.cjs");
        const invocation = buildWindowsFixtureInvocation({
          agentKind,
          canonicalWorkdir: canonicalRoot,
          fixturePath,
          prompt,
          resumeHandle,
        });
        await writeFile(executablePath, [
          "#!/usr/bin/env node",
          "const { writeFileSync } = require('node:fs');",
          "writeFileSync(process.env.SKYTURN_ARGS_PATH, JSON.stringify(process.argv.slice(2)));",
          "process.stdout.write(process.argv[2] === 'exec' ? '{\"type\":\"turn.completed\"}\\n' : '{\"toolCalls\":[]}\\n');",
        ].join("\n"), { mode: 0o755 });
        const adapterOptions = {
          executablePath,
          extraArgs: invocation.extraArgs,
          env: { SKYTURN_ARGS_PATH: argsPath },
          stallTelemetryMs: 0,
        };
        const adapter = agentKind === "codex"
          ? createCodexCliAdapter(adapterOptions)
          : createHermesCliAdapter(adapterOptions);
        const terminal = deferredRunEvent();
        const events: RunEvent[] = [];
        const sink: RunEventSink = {
          async emit(draft) {
            const event = {
              protocolVersion: RUN_EVENT_PROTOCOL_VERSION,
              runId: `run-${agentKind}-fixture-argv`,
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

        await adapter.startRun({
          protocolVersion: RUN_EVENT_PROTOCOL_VERSION,
          runId: `run-${agentKind}-fixture-argv`,
          nodeId: `node-${agentKind}-fixture-argv`,
          sessionId: "session-windows-fixture-argv",
          projectRoot,
          worktreePath: projectRoot,
          agentKind,
          prompt,
          ...(agentKind === "hermes" ? { hermesSessionHandle: resumeHandle } : {}),
        }, sink);
        await terminal.promise;

        expect(JSON.parse(await readFile(argsPath, "utf8"))).toEqual([
          invocation.entryPoint,
          ...invocation.expectedFixtureArgv,
        ]);
      } finally {
        await Promise.all([
          rm(projectRoot, { recursive: true, force: true }),
          rm(binRoot, { recursive: true, force: true }),
        ]);
      }
    },
  );

  it("bounds authoritative fixture-start diagnostics and redacts every private marker", () => {
    const rawRoot = "C:\\Users\\RUNNER~1\\AppData\\Local\\Temp\\skyturn-codex-cancel-secret";
    const environmentMarker = "env value with \"quotes\", slash\\, spaces, and Unicode 火";
    const events = [
      {
        kind: "progress",
        payload: {
          source: "codex",
          stream: "stderr",
          text: `argv mismatch actual=${JSON.stringify([prompt, fixturePath])} env=${environmentMarker} cwd=${rawRoot}`,
        },
      },
      {
        kind: "evidence",
        payload: {
          exitCode: 17,
          checks: [{ kind: "run-exit", name: "Codex CLI exit", status: "failed", detail: "exit 17" }],
        },
      },
      { kind: "status", payload: { status: "failed", reason: "x".repeat(10_000) } },
    ];

    const diagnostic = formatWindowsFixtureStartFailure({
      agentKind: "codex",
      terminalPath: "cancel",
      missingMarker: "parent.pid",
      events,
      sensitiveValues: [prompt, resumeHandle, environmentMarker, rawRoot, canonicalWorkdir, fixturePath],
    });

    expect(diagnostic.length).toBeLessThanOrEqual(4_096);
    expect(diagnostic).toContain("codex cancel fixture did not create parent.pid");
    expect(diagnostic).toContain('"kind":"evidence"');
    expect(diagnostic).toContain('"exitCode":17');
    expect(diagnostic).not.toContain(prompt);
    expect(diagnostic).not.toContain(JSON.stringify(prompt).slice(1, -1));
    expect(diagnostic).not.toContain(resumeHandle);
    expect(diagnostic).not.toContain(environmentMarker);
    expect(diagnostic).not.toContain(rawRoot);
    expect(diagnostic).not.toContain(canonicalWorkdir);
    expect(diagnostic).not.toContain(fixturePath);
  });
});

function deferredRunEvent(): {
  promise: Promise<RunEvent>;
  resolve: (event: RunEvent) => void;
} {
  let resolve!: (event: RunEvent) => void;
  const promise = new Promise<RunEvent>((resolvePromise) => {
    resolve = resolvePromise;
  });
  return { promise, resolve };
}
