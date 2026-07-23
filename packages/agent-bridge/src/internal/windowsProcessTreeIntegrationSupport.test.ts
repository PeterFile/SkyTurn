import { mkdir, mkdtemp, readFile, realpath, rm, symlink, writeFile } from "node:fs/promises";
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
  validateWindowsFixtureArgv,
} from "./windowsProcessTreeIntegrationSupport.js";

describe("Windows process-tree integration support", () => {
  const canonicalWorkdir = "C:\\Users\\runneradmin\\AppData\\Local\\Temp\\skyturn case 雪";
  const prompt = "Quoted \"prompt\" with trailing slash\\ and Unicode 雪\nsecond line";
  const resumeHandle = "resume \"capability\" with slash\\ and Unicode 水";
  const argumentMarker = "marker \"argument\" with slash\\ and Unicode 火";

  it("places the explicit Codex fixture at the adapter extra-argument boundary", () => {
    expect(buildWindowsFixtureInvocation({
      agentKind: "codex",
      argumentMarker,
      canonicalWorkdir,
      prompt,
      resumeHandle,
    })).toEqual({
      entryPoint: "exec",
      extraArgs: [argumentMarker],
      expectedFixtureArgv: [
        "--json",
        "--ephemeral",
        "--color",
        "never",
        "--sandbox",
        "read-only",
        "-c",
        "approval_policy=never",
        argumentMarker,
        "-C",
        canonicalWorkdir,
        prompt,
      ],
      pathArgumentIndexes: [10],
    });
  });

  it("places the explicit Hermes fixture after the resume argument", () => {
    expect(buildWindowsFixtureInvocation({
      agentKind: "hermes",
      argumentMarker,
      canonicalWorkdir,
      prompt,
      resumeHandle,
    })).toEqual({
      entryPoint: "chat",
      extraArgs: [argumentMarker],
      expectedFixtureArgv: [
        "-q",
        prompt,
        "--quiet",
        "--source",
        "skyturn",
        "--resume",
        resumeHandle,
        argumentMarker,
      ],
      pathArgumentIndexes: [],
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
        const invocation = buildWindowsFixtureInvocation({
          agentKind,
          argumentMarker,
          canonicalWorkdir: canonicalRoot,
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

        const actualArgs = JSON.parse(await readFile(argsPath, "utf8")) as string[];
        expect(actualArgs.shift()).toBe(invocation.entryPoint);
        expect(() => validateWindowsFixtureArgv({
          actualArgs,
          expectedArgs: invocation.expectedFixtureArgv,
          pathArgumentIndexes: invocation.pathArgumentIndexes,
        })).not.toThrow();
      } finally {
        await Promise.all([
          rm(projectRoot, { recursive: true, force: true }),
          rm(binRoot, { recursive: true, force: true }),
        ]);
      }
    },
  );

  it("accepts filesystem aliases only for declared path arguments", async () => {
    const root = await mkdtemp(join(tmpdir(), "skyturn-windows-fixture-path-"));
    const alias = `${root}-alias`;
    try {
      await symlink(root, alias, "dir");
      const canonicalRoot = await realpath(root);
      expect(() => validateWindowsFixtureArgv({
        actualArgs: ["-C", alias, argumentMarker],
        expectedArgs: ["-C", canonicalRoot, argumentMarker],
        pathArgumentIndexes: [1],
      })).not.toThrow();
      expect(() => validateWindowsFixtureArgv({
        actualArgs: ["-C", root, alias],
        expectedArgs: ["-C", root, canonicalRoot],
        pathArgumentIndexes: [1],
      })).toThrow("Windows fixture argv mismatch at index 2.");
    } finally {
      await Promise.all([
        rm(alias, { force: true }),
        rm(root, { recursive: true, force: true }),
      ]);
    }
  });

  it("reports only bounded generic fixture validation mismatches", () => {
    const privateActual = `${prompt}${resumeHandle}${argumentMarker}`;
    const failures = [
      () => validateWindowsFixtureArgv({
        actualArgs: [privateActual],
        expectedArgs: [],
        pathArgumentIndexes: [],
      }),
      () => validateWindowsFixtureArgv({
        actualArgs: [privateActual],
        expectedArgs: [argumentMarker],
        pathArgumentIndexes: [],
      }),
      () => validateWindowsFixtureArgv({
        actualArgs: [canonicalWorkdir],
        expectedArgs: ["Z:\\private\\absolute\\path"],
        pathArgumentIndexes: [0],
        resolvePathIdentity: (value) => value,
      }),
    ];

    expect(failures.map((failure) => captureErrorMessage(failure))).toEqual([
      "Windows fixture argv length mismatch (actual 1, expected 0).",
      "Windows fixture argv mismatch at index 0.",
      "Windows fixture argv path identity mismatch at index 0.",
    ]);
    for (const failure of failures) {
      const message = captureErrorMessage(failure);
      expect(message.length).toBeLessThan(128);
      expect(message).not.toContain(prompt);
      expect(message).not.toContain(resumeHandle);
      expect(message).not.toContain(argumentMarker);
      expect(message).not.toContain(canonicalWorkdir);
    }
  });

  it("bounds authoritative fixture-start diagnostics and redacts every private marker", () => {
    const rawRoot = "C:\\Users\\RUNNER~1\\AppData\\Local\\Temp\\skyturn-codex-cancel-secret";
    const environmentMarker = "env value with \"quotes\", slash\\, spaces, and Unicode 火";
    const fixturePath = `${canonicalWorkdir}\\agent-fixture.cjs`;
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

function captureErrorMessage(callback: () => void): string {
  try {
    callback();
  } catch (error) {
    return error instanceof Error ? error.message : String(error);
  }
  throw new Error("Expected fixture validation to fail.");
}

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
