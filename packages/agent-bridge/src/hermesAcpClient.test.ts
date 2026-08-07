import { spawn as spawnChildProcess } from "node:child_process";
import { PassThrough } from "node:stream";
import { afterEach, describe, expect, it, vi } from "vitest";
import { chmod, mkdtemp, mkdir, readFile, realpath, rename, rm, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

type SpawnManagedProcess = typeof import("./internal/managedProcess.js")["spawnManagedProcess"];
type SpawnManagedProcessInput = Parameters<SpawnManagedProcess>[0];
type ManagedProcess = Awaited<ReturnType<SpawnManagedProcess>>;

const managedProcessMock = vi.hoisted(() => ({
  spawn: null as SpawnManagedProcess | null,
}));
const fdAnchoredCapabilityMock = vi.hoisted(() => ({
  available: true,
}));

vi.mock("./internal/managedProcess.js", async (importOriginal) => {
  const original = await importOriginal<typeof import("./internal/managedProcess.js")>();
  return {
    ...original,
    spawnManagedProcess: (...args: Parameters<SpawnManagedProcess>) =>
      managedProcessMock.spawn
        ? managedProcessMock.spawn(...args)
        : spawnManagedProcessFallback(...args),
  };
});
vi.mock("./internal/fdAnchoredCliLaunch.js", async (importOriginal) => {
  const original = await importOriginal<typeof import("./internal/fdAnchoredCliLaunch.js")>();
  return {
    ...original,
    hasFdAnchoredCliLaunchCapability: async () => fdAnchoredCapabilityMock.available,
  };
});

import {
  createHermesAcpClient,
  denyHermesAcpPermission,
  type HermesAcpClient,
  type HermesAcpClientOptions,
} from "./hermesAcpClient.js";

const clients: HermesAcpClient[] = [];
const clientProjectRoots = new WeakMap<HermesAcpClient, string>();
const projectRoots: string[] = [];
const require = createRequire(import.meta.url);
const acpSdkModuleUrl = pathToFileURL(require.resolve("@agentclientprotocol/sdk")).href;

afterEach(async () => {
  managedProcessMock.spawn = null;
  fdAnchoredCapabilityMock.available = true;
  await Promise.all(clients.splice(0).map((client) => client.close()));
  await Promise.all(projectRoots.splice(0).map((projectRoot) => rm(projectRoot, { force: true, recursive: true })));
});

describe("Hermes ACP client", () => {
  it("uses one typed stdio connection for new, load, prompt, and text-only updates", async () => {
    const client = await testClient(agentScript());
    const sessionId = await client.newSession(clientProjectRoot(client));
    const chunks: string[] = [];

    const result = await client.prompt(sessionId, "Generate requirements.", {
      timeoutMs: 2_000,
      onText: (text) => chunks.push(text),
    });
    await client.loadSession(clientProjectRoot(client), sessionId);

    expect(sessionId).toBe("opaque-session-do-not-publish");
    expect(result).toEqual({ stopReason: "end_turn", markdown: "# Requirements\n\nComplete." });
    expect(chunks).toEqual(["# Requirements", "\n\nComplete."]);
  });

  it("denies every permission request", () => {
    expect(denyHermesAcpPermission()).toEqual({ outcome: { outcome: "cancelled" } });
  });

  it("cancels and reports a bounded safe timeout error", async () => {
    const client = await testClient(agentScript({ hangPrompt: true }));
    const sessionId = await client.newSession(clientProjectRoot(client));

    await expect(client.prompt(sessionId, "Do not expose this prompt.", { timeoutMs: 20 })).rejects.toThrow(
      "Hermes ACP prompt timed out.",
    );
    expect(client.isClosed()).toBe(true);
  });

  it("reports a bounded safe session creation timeout", async () => {
    const client = await testClient(agentScript({ hangNew: true }), { sessionRequestTimeoutMs: 20 });

    await expect(client.newSession(clientProjectRoot(client))).rejects.toThrow(
      /^Hermes ACP session creation timed out\.$/,
    );
    expect(client.isClosed()).toBe(true);
  });

  it("aborts pending initialization and reaps the child before rejecting", async () => {
    const projectRoot = await makeProjectRoot();
    const controller = new AbortController();
    const startedAt = Date.now();
    const pending = createHermesAcpClient({
      executablePath: process.execPath,
      args: ["--input-type=module", "--eval", agentScript({ hangInitialize: true })],
      processCwd: projectRoot,
      initializationTimeoutMs: 1_000,
      terminationGraceMs: 20,
      signal: controller.signal,
    });
    await new Promise((resolve) => setTimeout(resolve, 20));

    controller.abort();
    const outcome = await Promise.race([
      pending.catch((error: unknown) => error),
      new Promise((resolve) => setTimeout(() => resolve(new Error("abort deadline exceeded")), 200)),
    ]);
    await pending.catch(() => undefined);

    expect(outcome).toEqual(new Error("Hermes ACP initialization failed."));
    expect(Date.now() - startedAt).toBeLessThan(500);
  });

  it("aborts before managed readiness and waits for exactly one reap", async () => {
    const projectRoot = await makeProjectRoot();
    let releaseReap!: () => void;
    const targetInput = new PassThrough();
    const child = {
      stderr: new PassThrough(),
      stdin: new PassThrough(),
      stdout: new PassThrough(),
      once: vi.fn(),
      on: vi.fn(),
    };
    const terminateAndReap = vi.fn(() => new Promise<void>((resolve) => {
      releaseReap = resolve;
    }));
    managedProcessMock.spawn = vi.fn(async () => ({
      child: child as never,
      ready: new Promise<void>(() => {}),
      closed: Promise.resolve({ exitCode: 0, signalCode: null }),
      targetInput,
      terminateAndReap,
    }));
    const controller = new AbortController();
    const pending = createHermesAcpClient({
      executablePath: process.execPath,
      projectRoot,
      initializationTimeoutMs: 2_000,
      signal: controller.signal,
    });
    await vi.waitFor(() => expect(managedProcessMock.spawn).toHaveBeenCalledOnce());
    controller.abort();

    let settled = false;
    const outcome = pending.catch((error: unknown) => {
      settled = true;
      return error;
    });
    await new Promise((resolve) => setImmediate(resolve));

    expect(settled).toBe(false);
    expect(terminateAndReap).toHaveBeenCalledTimes(1);
    releaseReap();
    await expect(outcome).resolves.toEqual(new Error("Hermes ACP initialization failed."));
  });

  it("bounds managed readiness with the initialization timeout and reaps before rejecting", async () => {
    const projectRoot = await makeProjectRoot();
    const terminateAndReap = vi.fn(async () => {});
    managedProcessMock.spawn = vi.fn(async () => ({
      child: {
        stderr: new PassThrough(),
        stdin: new PassThrough(),
        stdout: new PassThrough(),
      } as never,
      ready: new Promise<void>(() => {}),
      closed: Promise.resolve({ exitCode: 0, signalCode: null }),
      targetInput: new PassThrough(),
      terminateAndReap,
    }));
    const pending = createHermesAcpClient({
      executablePath: process.execPath,
      initializationTimeoutMs: 20,
      projectRoot,
    });

    const outcome = await Promise.race([
      pending.catch((error: unknown) => error),
      new Promise((resolve) => setTimeout(() => resolve(new Error("readiness deadline exceeded")), 200)),
    ]);

    expect(outcome).toEqual(new Error("Hermes ACP initialization failed."));
    expect(terminateAndReap).toHaveBeenCalledOnce();
  });

  it("reports cleanup failure when pre-readiness initialization cannot verify reap", async () => {
    const projectRoot = await makeProjectRoot();
    const terminateAndReap = vi.fn(async () => {
      throw new Error("private managed reap failure");
    });
    managedProcessMock.spawn = vi.fn(async () => ({
      child: {
        stderr: new PassThrough(),
        stdin: new PassThrough(),
        stdout: new PassThrough(),
      } as never,
      ready: Promise.reject(new Error("private readiness failure")),
      closed: Promise.resolve({ exitCode: 0, signalCode: null }),
      targetInput: new PassThrough(),
      terminateAndReap,
    }));

    await expect(createHermesAcpClient({
      executablePath: process.execPath,
      projectRoot,
    })).rejects.toThrow("Hermes ACP process cleanup could not be verified.");
    expect(terminateAndReap).toHaveBeenCalledOnce();
  });

  it("keeps a verified pre-readiness reap distinct from the setup failure", async () => {
    const projectRoot = await makeProjectRoot();
    const terminateAndReap = vi.fn(async () => {});
    managedProcessMock.spawn = vi.fn(async () => ({
      child: {
        stderr: new PassThrough(),
        stdin: new PassThrough(),
        stdout: new PassThrough(),
      } as never,
      ready: Promise.reject(new Error("private readiness failure")),
      closed: Promise.reject(new Error("private setup failure")),
      targetInput: new PassThrough(),
      terminateAndReap,
    }));

    await expect(createHermesAcpClient({
      executablePath: process.execPath,
      projectRoot,
    })).rejects.toThrow("Hermes ACP initialization failed.");
    expect(terminateAndReap).toHaveBeenCalledOnce();
  });

  it("launches the strict Hermes uv shim through its sibling interpreter without shell forks", async () => {
    const projectRoot = await makeProjectRoot();
    const executablePath = join(projectRoot, "hermes");
    const interpreterPath = join(projectRoot, "python3");
    await writeFile(executablePath, [
      "#!/bin/sh",
      `'''exec' "$(dirname -- "$(realpath -- "$0")")"/'python3' "$0" "$@"`,
      "' '''",
      "from hermes_cli.main import main",
    ].join("\n"));
    await writeFile(interpreterPath, "interpreter");
    await Promise.all([chmod(executablePath, 0o755), chmod(interpreterPath, 0o755)]);
    const terminateAndReap = vi.fn(async () => {});
    const spawn = vi.fn(async (_input: SpawnManagedProcessInput) => ({
      child: {
        stderr: new PassThrough(),
        stdin: new PassThrough(),
        stdout: new PassThrough(),
      } as never,
      ready: Promise.reject(new Error("private readiness failure")),
      closed: Promise.reject(new Error("private setup failure")),
      targetInput: new PassThrough(),
      terminateAndReap,
    }));
    managedProcessMock.spawn = spawn;

    await expect(createHermesAcpClient({
      env: {},
      executablePath,
      projectRoot,
    })).rejects.toThrow("Hermes ACP initialization failed.");
    const launch = spawn.mock.calls[0]?.[0];
    expect(launch?.args).toEqual([await realpath(executablePath), "acp"]);
    expect(launch?.executablePath).toBe(await realpath(interpreterPath));
  });

  it("fails closed on Windows capability absence without spawning", async () => {
    const spawn = vi.fn();
    fdAnchoredCapabilityMock.available = false;
    managedProcessMock.spawn = spawn;

    await expect(createHermesAcpClient({
      executablePath: process.execPath,
      platform: "win32",
      projectRoot: "C:\\repo",
    })).rejects.toThrow("Hermes ACP initialization failed.");
    expect(spawn).not.toHaveBeenCalled();
  });

  it("reports a distinct bounded safe session loading timeout", async () => {
    const client = await testClient(agentScript({ hangLoad: true }), { sessionRequestTimeoutMs: 500 });
    const sessionId = await client.newSession(clientProjectRoot(client));

    await expect(client.loadSession(clientProjectRoot(client), sessionId)).rejects.toThrow(
      /^Hermes ACP session loading timed out\.$/,
    );
    expect(client.isClosed()).toBe(true);
  });

  it("binds session creation to /dev/fd/3 and survives path replacement after the retained directory was opened", async () => {
    const projectRoot = await mkdtemp(join(tmpdir(), "skyturn-acp-fd3-"));
    projectRoots.push(projectRoot);
    const retainedRoot = `${projectRoot}-retained`;
    await mkdir(join(projectRoot, ".git"), { recursive: true });
    await writeFile(join(projectRoot, ".git", "anchor.txt"), "retained-anchor");
    let capturedSpawnInput: SpawnManagedProcessInput | null = null;
    managedProcessMock.spawn = vi.fn(async (input) => {
      capturedSpawnInput = input;
      return spawnManagedProcessFallback(input);
    });
    const client = await testClient(agentScript({ reflectFd3SessionNew: true }), {
      projectRoot,
      initializationTimeoutMs: 2_000,
    });

    await rename(projectRoot, retainedRoot);
    projectRoots.push(retainedRoot);
    await mkdir(join(projectRoot, ".git"), { recursive: true });
    await writeFile(join(projectRoot, ".git", "anchor.txt"), "replacement-anchor");
    const sessionId = await client.newSession(projectRoot);

    expect(capturedSpawnInput).toMatchObject({
      preserveWorktreeFd: true,
      targetStdin: "pipe",
      worktreeFd: expect.any(Number),
    });
    expect(sessionId).toContain("param:/dev/fd/3|");
    expect(sessionId).toContain("|anchor:retained-anchor");
  });

  it("rejects session requests for a different project before ACP dispatch", async () => {
    const projectRoot = await makeProjectRoot();
    const client = await testClient(agentScript(), { projectRoot });
    const sessionId = await client.newSession(projectRoot);

    await expect(client.newSession("/other-repo")).rejects.toThrow(/project/i);
    await expect(client.loadSession("/other-repo", sessionId)).rejects.toThrow(/project/i);
  });

  it("redacts an echoed opaque session id across arbitrary text chunks", async () => {
    const client = await testClient(agentScript({
      chunks: ["# Requirements\n\nopaque-sess", "ion-do-not-publish\n\nComplete."],
    }));
    const sessionId = await client.newSession(clientProjectRoot(client));
    const chunks: string[] = [];

    const result = await client.prompt(sessionId, "Generate requirements.", {
      onText: (text) => chunks.push(text),
    });

    expect(result.markdown).toBe("# Requirements\n\n[redacted]\n\nComplete.");
    expect(chunks.join("")).toBe(result.markdown);
    expect(JSON.stringify({ chunks, result })).not.toContain(sessionId);
  });

  it("redacts the complete prompt and caller values before public output accounting", async () => {
    const privateProjectRoot = "/private/projects/skyturn-plan-secret";
    const prompt = `Generate Requirements for Project root: ${privateProjectRoot}`;
    const ordinaryMarkdown = "# Requirements\n\nKeep **ordinary** Markdown intact.\n\n";
    const rawOutput = [
      ordinaryMarkdown,
      prompt,
      privateProjectRoot,
      "opaque-session-do-not-publish",
      "Complete.",
    ].join("\n\n");
    const client = await testClient(agentScript({ chunks: Array.from(rawOutput) }));
    const sessionId = await client.newSession(clientProjectRoot(client));
    const chunks: string[] = [];

    const result = await client.prompt(sessionId, prompt, {
      redactProjectRoot: privateProjectRoot,
      onText: (text) => chunks.push(text),
    });

    expect(chunks.join("")).toBe(result.markdown);
    expect(result.markdown.startsWith(ordinaryMarkdown)).toBe(true);
    expect(JSON.stringify({ chunks, result })).not.toContain(prompt);
    expect(JSON.stringify({ chunks, result })).not.toContain(privateProjectRoot);
    expect(JSON.stringify({ chunks, result })).not.toContain(sessionId);
  });

  it("redacts an astral session id split between its UTF-16 surrogates", async () => {
    const sessionId = "opaque-\u{1f600}-session-secret";
    const client = await testClient(agentScript({
      sessionId,
      chunks: ["# Requirements\n\nopaque-\ud83d", "\ude00-session-secret\n\nComplete."],
    }));
    const rawSessionId = await client.newSession(clientProjectRoot(client));

    const result = await client.prompt(rawSessionId, "Generate requirements.");

    expect(result.markdown).toBe("# Requirements\n\n[redacted]\n\nComplete.");
    expect(result.markdown).not.toContain(sessionId);
  });

  it("fails closed when output ends with an unresolved session id prefix", async () => {
    const client = await testClient(agentScript({ chunks: ["# Requirements\n\nopaque-sess"] }));
    const sessionId = await client.newSession(clientProjectRoot(client));

    const result = await client.prompt(sessionId, "Generate requirements.");

    expect(result.markdown).toBe("# Requirements\n\n[redacted]");
    expect(result.markdown).not.toContain("opaque-sess");
  });

  it("fails closed when output ends with an unresolved prompt or project-root prefix", async () => {
    const cases = [
      {
        chunks: ["# Requirements\n\nGenerate private \ud83d", "\ude00 req"],
        prompt: "Generate private \u{1f600} requirements.",
        projectRoot: "/tmp",
        terminalPrefix: "Generate private \u{1f600} req",
      },
      {
        chunks: ["# Requirements\n\n/private/projects/sky", "turn-plan"],
        prompt: "Generate requirements.",
        projectRoot: "/private/projects/skyturn-plan-secret",
        terminalPrefix: "/private/projects/skyturn-plan",
      },
    ];

    for (const testCase of cases) {
      const client = await testClient(agentScript({ chunks: testCase.chunks }));
      const sessionId = await client.newSession(clientProjectRoot(client));
      const chunks: string[] = [];

      const result = await client.prompt(sessionId, testCase.prompt, {
        redactProjectRoot: testCase.projectRoot,
        onText: (text) => chunks.push(text),
      });

      expect(result.markdown).toBe("# Requirements\n\n[redacted]");
      expect(chunks.join("")).toBe(result.markdown);
      expect(JSON.stringify({ chunks, result })).not.toContain(testCase.terminalPrefix);
    }
  });

  it("terminates the client without emitting a UTF-8 output chunk that exceeds the limit", async () => {
    const client = await testClient(agentScript({ chunks: ["ééééé"] }), { maxOutputBytes: 7 });
    const sessionId = await client.newSession(clientProjectRoot(client));
    const chunks: string[] = [];

    await expect(client.prompt(sessionId, "Generate requirements.", {
      onText: (text) => chunks.push(text),
    })).rejects.toThrow("Hermes ACP output limit exceeded.");

    expect(chunks).toEqual([]);
    expect(client.isClosed()).toBe(true);
  });

  it("applies the output byte limit after project-root redaction", async () => {
    const client = await testClient(agentScript({ chunks: ["/r/r/r"] }), { maxOutputBytes: 20 });
    const sessionId = await client.newSession(clientProjectRoot(client));
    const chunks: string[] = [];

    await expect(client.prompt(sessionId, "Generate requirements.", {
      redactProjectRoot: "/r",
      onText: (text) => chunks.push(text),
    })).rejects.toThrow("Hermes ACP output limit exceeded.");

    expect(chunks).toEqual([]);
    expect(client.isClosed()).toBe(true);
  });

  it("contains a throwing output consumer and fully reaps the child without exposing raw updates", async () => {
    const directory = await mkdtemp(join(tmpdir(), "skyturn-acp-consumer-"));
    const exitMarkerPath = join(directory, "closed");
    const secrets = {
      consumer: "consumer-callback-secret",
      sessionId: "raw-session-update-secret",
      update: "raw-sensitive-update-text",
    };
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const consoleWarn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    let client: HermesAcpClient | undefined;
    try {
      client = await testClient(agentScript({
        chunks: [secrets.update],
        exitMarkerPath,
        sessionId: secrets.sessionId,
      }), { terminationGraceMs: 100 });
      const sessionId = await client.newSession(clientProjectRoot(client));

      const failure = await client.prompt(sessionId, "Generate requirements.", {
        timeoutMs: 500,
        onText: () => {
          throw new Error(secrets.consumer);
        },
      }).catch((error: unknown) => error);
      const exposed = `${String(failure)}${JSON.stringify([...consoleError.mock.calls, ...consoleWarn.mock.calls])}`;

      expect(failure).toEqual(new Error("Hermes ACP prompt failed."));
      expect(client.isClosed()).toBe(true);
      expect(await readFile(exitMarkerPath, "utf8")).toBe("closed");
      for (const secret of Object.values(secrets)) expect(exposed).not.toContain(secret);
    } finally {
      consoleError.mockRestore();
      consoleWarn.mockRestore();
      await client?.close();
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("contains an output consumer exception raised while flushing a redacted terminal prefix", async () => {
    const client = await testClient(agentScript({ chunks: ["opaque-sess"] }), { terminationGraceMs: 20 });
    const sessionId = await client.newSession(clientProjectRoot(client));

    const failure = await client.prompt(sessionId, "Generate requirements.", {
      onText: () => {
        throw new Error("terminal-flush-consumer-secret");
      },
    }).catch((error: unknown) => error);

    expect(failure).toEqual(new Error("Hermes ACP prompt failed."));
    expect(client.isClosed()).toBe(true);
  });

  it("rejects an invalid inbound limit before spawning a child", async () => {
    const directory = await mkdtemp(join(tmpdir(), "skyturn-acp-preflight-"));
    const pidMarkerPath = join(directory, "pid");
    let spawnedPid: number | null = null;
    try {
      const failure = await createHermesAcpClient({
        executablePath: process.execPath,
        args: ["--input-type=module", "--eval", processMarkerScript(pidMarkerPath)],
        processCwd: process.cwd(),
        maxInboundLineBytes: 0,
        terminationGraceMs: 20,
      }).catch((error: unknown) => error);

      spawnedPid = await readMarkerPid(pidMarkerPath, 300);
      expect(failure).toEqual(new Error("Hermes ACP initialization failed."));
      expect(spawnedPid).toBeNull();
    } finally {
      if (spawnedPid !== null) {
        try {
          process.kill(spawnedPid, "SIGKILL");
        } catch {}
      }
      await rm(directory, { recursive: true, force: true });
    }
  });

  it.each([
    ["Infinity", Number.POSITIVE_INFINITY],
    ["NaN", Number.NaN],
    ["zero", 0],
    ["negative", -1],
    ["noninteger", 1.5],
    ["above the public cap", 2_000_001],
  ])("rejects maxOutputBytes %s before spawning a child", async (_case, maxOutputBytes) => {
    const directory = await mkdtemp(join(tmpdir(), "skyturn-acp-output-preflight-"));
    const pidMarkerPath = join(directory, "pid");
    let spawnedClient: HermesAcpClient | undefined;
    let spawnedPid: number | null = null;
    try {
      const failure = await createHermesAcpClient({
        executablePath: process.execPath,
        args: ["--input-type=module", "--eval", agentScript({ pidMarkerPath })],
        processCwd: process.cwd(),
        initializationTimeoutMs: 2_000,
        maxOutputBytes,
        terminationGraceMs: 20,
      }).then((client) => {
        spawnedClient = client;
        return client;
      }).catch((error: unknown) => error);

      spawnedPid = await readMarkerPid(pidMarkerPath, 300);
      expect(failure).toEqual(new Error("Hermes ACP initialization failed."));
      expect(spawnedPid).toBeNull();
    } finally {
      await spawnedClient?.close();
      if (spawnedPid !== null) {
        try {
          process.kill(spawnedPid, "SIGKILL");
        } catch {}
      }
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("rejects an inbound limit above the public cap before spawning a child", async () => {
    const directory = await mkdtemp(join(tmpdir(), "skyturn-acp-inbound-preflight-"));
    const pidMarkerPath = join(directory, "pid");
    let spawnedClient: HermesAcpClient | undefined;
    let spawnedPid: number | null = null;
    try {
      const failure = await createHermesAcpClient({
        executablePath: process.execPath,
        args: ["--input-type=module", "--eval", agentScript({ pidMarkerPath })],
        processCwd: process.cwd(),
        initializationTimeoutMs: 2_000,
        maxInboundLineBytes: 2_000_001,
        terminationGraceMs: 20,
      }).then((client) => {
        spawnedClient = client;
        return client;
      }).catch((error: unknown) => error);

      spawnedPid = await readMarkerPid(pidMarkerPath, 300);
      expect(failure).toEqual(new Error("Hermes ACP initialization failed."));
      expect(spawnedPid).toBeNull();
    } finally {
      await spawnedClient?.close();
      if (spawnedPid !== null) {
        try {
          process.kill(spawnedPid, "SIGKILL");
        } catch {}
      }
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("rejects an oversized raw inbound line before JSON parsing", async () => {
    const startedAt = Date.now();
    await expect(createHermesAcpClient({
      executablePath: process.execPath,
      args: ["--input-type=module", "--eval", rawAgentScript({ oversizedNoNewline: true })],
      processCwd: process.cwd(),
      initializationTimeoutMs: 1_000,
      terminationGraceMs: 20,
      maxInboundLineBytes: 128,
    } as HermesAcpClientOptions & { maxInboundLineBytes: number })).rejects.toThrow(
      /^Hermes ACP initialization failed\.$/,
    );
    expect(Date.now() - startedAt).toBeLessThan(500);
  });

  it("never exposes a malformed inbound payload through errors or console diagnostics", async () => {
    const secret = "opaque-session-secret-must-not-escape";
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const consoleWarn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    try {
      const failure = await createHermesAcpClient({
        executablePath: process.execPath,
        args: ["--input-type=module", "--eval", rawAgentScript({ malformedSecret: secret })],
        processCwd: process.cwd(),
        initializationTimeoutMs: 2_000,
        terminationGraceMs: 20,
      }).catch((error: unknown) => error);

      expect(failure).toEqual(new Error("Hermes ACP initialization failed."));
      expect(JSON.stringify([...consoleError.mock.calls, ...consoleWarn.mock.calls])).not.toContain(secret);
    } finally {
      consoleError.mockRestore();
      consoleWarn.mockRestore();
    }
  });

  it("rejects semantic-invalid ACP notifications before SDK diagnostics", async () => {
    const secrets = {
      path: "/private/projects/semantic-invalid-secret",
      prompt: "raw-prompt-secret-must-not-escape",
      sessionId: "raw-session-secret-must-not-escape",
    };
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const consoleWarn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    try {
      const failure = await createHermesAcpClient({
        executablePath: process.execPath,
        args: ["--input-type=module", "--eval", rawAgentScript({ semanticInvalid: secrets })],
        processCwd: process.cwd(),
        initializationTimeoutMs: 2_000,
        terminationGraceMs: 20,
      }).catch((error: unknown) => error);
      const publicFailure = String(failure);
      const diagnostics = JSON.stringify([...consoleError.mock.calls, ...consoleWarn.mock.calls]);

      expect(failure).toEqual(new Error("Hermes ACP initialization failed."));
      for (const secret of Object.values(secrets)) {
        expect(publicFailure).not.toContain(secret);
        expect(diagnostics).not.toContain(secret);
      }
    } finally {
      consoleError.mockRestore();
      consoleWarn.mockRestore();
    }
  });

  it("rejects semantic-invalid ACP requests before SDK dispatch", async () => {
    const secrets = {
      path: "/private/projects/request-secret",
      prompt: "raw-request-prompt-secret",
      sessionId: "raw-request-session-secret",
    };
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const consoleWarn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    try {
      const failure = await createHermesAcpClient({
        executablePath: process.execPath,
        args: ["--input-type=module", "--eval", rawAgentScript({ semanticInvalidRequest: secrets })],
        processCwd: process.cwd(),
        initializationTimeoutMs: 2_000,
        terminationGraceMs: 20,
      }).catch((error: unknown) => error);
      const exposed = `${String(failure)}${JSON.stringify([...consoleError.mock.calls, ...consoleWarn.mock.calls])}`;

      expect(failure).toEqual(new Error("Hermes ACP initialization failed."));
      for (const secret of Object.values(secrets)) expect(exposed).not.toContain(secret);
    } finally {
      consoleError.mockRestore();
      consoleWarn.mockRestore();
    }
  });

  it.each([
    {
      family: "permission",
      method: "session/request_permission",
      params: {
        sessionId: "permission-session-capability-secret",
        toolCall: {
          toolCallId: "permission-tool",
          title: "permission-command-secret",
          locations: [{ path: "/private/permission-path-secret" }],
          rawInput: { env: "permission-env-secret", rawInput: "permission-raw-input-secret" },
        },
        options: [{ optionId: "reject", name: "Reject", kind: "reject_once" }],
      },
    },
    {
      family: "terminal",
      method: "terminal/create",
      params: {
        sessionId: "terminal-session-capability-secret",
        command: "terminal-command-secret",
        args: ["terminal-argument-secret"],
        env: [{ name: "TOKEN", value: "terminal-env-secret" }],
        cwd: "/private/terminal-path-secret",
      },
    },
  ])("intercepts a valid $family request and reaps before a failed safe response rejects", async ({ method, params }) => {
    const directory = await mkdtemp(join(tmpdir(), "skyturn-acp-intercepted-request-"));
    const exitMarkerPath = join(directory, "closed");
    const pidMarkerPath = join(directory, "pid");
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const consoleWarn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    let client: HermesAcpClient | undefined;
    try {
      client = await testClient(rawAgentScript({
        exitMarkerPath,
        interceptedRequest: { method, params },
        pidMarkerPath,
      }), { terminationGraceMs: 100 });
      const pid = await readMarkerPid(pidMarkerPath, 300);
      expect(pid).not.toBeNull();
      expect(isProcessAlive(pid!)).toBe(true);

      const failure = await client.newSession(clientProjectRoot(client)).catch((error: unknown) => error);
      const exposed = `${String(failure)}${JSON.stringify([...consoleError.mock.calls, ...consoleWarn.mock.calls])}`;

      expect(failure).toEqual(new Error("Hermes ACP session creation failed."));
      expect(await readFile(exitMarkerPath, "utf8")).toBe("closed");
      expect(isProcessAlive(pid!)).toBe(false);
      for (const secret of deepStrings(params)) expect(exposed).not.toContain(secret);
    } finally {
      consoleError.mockRestore();
      consoleWarn.mockRestore();
      await client?.close();
      await rm(directory, { recursive: true, force: true });
    }
  });

  it.each([
    {
      family: "permission",
      method: "session/request_permission",
      params: {
        sessionId: "permission-session-secret",
        toolCall: { toolCallId: "tool-1", rawInput: { command: "permission-command-secret" } },
        options: [{ optionId: "reject", name: "Reject", kind: "reject_once" }],
      },
      response: {
        jsonrpc: "2.0",
        id: "intercepted-client-request",
        result: { outcome: { outcome: "cancelled" } },
      },
    },
    {
      family: "filesystem",
      method: "fs/read_text_file",
      params: { sessionId: "filesystem-session-secret", path: "/private/filesystem-path-secret" },
      response: {
        jsonrpc: "2.0",
        id: "intercepted-client-request",
        error: { code: -32601, message: "ACP client method is unsupported." },
      },
    },
    {
      family: "terminal",
      method: "terminal/create",
      params: {
        sessionId: "terminal-session-secret",
        command: "terminal-command-secret",
        env: [{ name: "TOKEN", value: "terminal-env-secret" }],
      },
      response: {
        jsonrpc: "2.0",
        id: "intercepted-client-request",
        error: { code: -32601, message: "ACP client method is unsupported." },
      },
    },
    {
      family: "MCP",
      method: "mcp/message",
      params: {
        connectionId: "mcp-connection-secret",
        method: "secret/method",
        params: { token: "mcp-params-secret" },
      },
      response: {
        jsonrpc: "2.0",
        id: "intercepted-client-request",
        error: { code: -32601, message: "ACP client method is unsupported." },
      },
    },
  ])("answers a valid $family request with only the canonical safe transport response", async ({ method, params, response }) => {
    const directory = await mkdtemp(join(tmpdir(), "skyturn-acp-safe-response-"));
    const responseMarkerPath = join(directory, "response.json");
    try {
      const client = await testClient(rawAgentScript({
        interceptedRequest: { method, params },
        responseMarkerPath,
      }));

      await expect(client.newSession(clientProjectRoot(client))).resolves.toBe("chunked-session");
      const recorded = JSON.parse(await readFile(responseMarkerPath, "utf8"));
      expect(recorded).toEqual(response);
      for (const secret of deepStrings(params)) expect(JSON.stringify(recorded)).not.toContain(secret);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("rejects unknown inbound methods before SDK diagnostics", async () => {
    const secrets = {
      path: "/private/projects/unknown-method-secret",
      prompt: "unknown-method-prompt-secret",
      sessionId: "unknown-method-session-secret",
    };
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const consoleWarn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    try {
      const failure = await createHermesAcpClient({
        executablePath: process.execPath,
        args: ["--input-type=module", "--eval", rawAgentScript({ unknownInbound: secrets })],
        processCwd: process.cwd(),
        initializationTimeoutMs: 2_000,
        terminationGraceMs: 20,
      }).catch((error: unknown) => error);
      const exposed = `${String(failure)}${JSON.stringify([...consoleError.mock.calls, ...consoleWarn.mock.calls])}`;

      expect(failure).toEqual(new Error("Hermes ACP initialization failed."));
      for (const secret of Object.values(secrets)) expect(exposed).not.toContain(secret);
    } finally {
      consoleError.mockRestore();
      consoleWarn.mockRestore();
    }
  });

  it("reaps an aborted post-initialize ACP connection before returning its fixed failure", async () => {
    const directory = await mkdtemp(join(tmpdir(), "skyturn-acp-aborted-request-"));
    const exitMarkerPath = join(directory, "closed");
    const pidMarkerPath = join(directory, "pid");
    const secrets = {
      path: "/private/projects/response-secret",
      prompt: "raw-response-prompt-secret",
      sessionId: "raw-response-session-secret",
    };
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const consoleWarn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    let client: HermesAcpClient | undefined;
    try {
      client = await testClient(rawAgentScript({
        exitMarkerPath,
        pidMarkerPath,
        semanticInvalidResponse: secrets,
      }), { terminationGraceMs: 100 });
      const pid = await readMarkerPid(pidMarkerPath, 300);
      expect(pid).not.toBeNull();
      expect(isProcessAlive(pid!)).toBe(true);

      const failure = await client.newSession(clientProjectRoot(client)).catch((error: unknown) => error);
      const exposed = `${String(failure)}${JSON.stringify([...consoleError.mock.calls, ...consoleWarn.mock.calls])}`;

      expect(failure).toEqual(new Error("Hermes ACP session creation failed."));
      expect(await readFile(exitMarkerPath, "utf8")).toBe("closed");
      expect(isProcessAlive(pid!)).toBe(false);
      for (const secret of Object.values(secrets)) expect(exposed).not.toContain(secret);
    } finally {
      consoleError.mockRestore();
      consoleWarn.mockRestore();
      await client?.close();
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("replaces agent error response details before SDK diagnostics", async () => {
    const secrets = {
      message: "agent-error-message-secret",
      data: "agent-error-data-secret",
    };
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const consoleWarn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    try {
      const client = await testClient(rawAgentScript({ sessionNewError: secrets }));
      const failure = await client.newSession(clientProjectRoot(client)).catch((error: unknown) => error);
      const exposed = `${String(failure)}${JSON.stringify([...consoleError.mock.calls, ...consoleWarn.mock.calls])}`;

      expect(failure).toEqual(new Error("Hermes ACP session creation failed."));
      expect(client.isClosed()).toBe(false);
      await client.loadSession(clientProjectRoot(client), "chunked-session");
      for (const secret of Object.values(secrets)) expect(exposed).not.toContain(secret);
    } finally {
      consoleError.mockRestore();
      consoleWarn.mockRestore();
    }
  });

  it("preserves valid ACP messages split across arbitrary raw chunks", async () => {
    const client = await testClient(rawAgentScript({
      chunkValidMessages: true,
      validNonTextNotifications: true,
    }));
    const sessionId = await client.newSession(clientProjectRoot(client));

    const result = await client.prompt(sessionId, "Generate requirements.");

    expect(result).toEqual({ stopReason: "end_turn", markdown: "# Chunked\n\nValid." });
  });

  it("matches concurrent ACP responses by request id when they arrive in reverse order", async () => {
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const consoleWarn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    try {
      const client = await testClient(rawAgentScript({ reverseConcurrentResponses: true }));
      const projectRoot = clientProjectRoot(client);

      const [sessionId] = await Promise.all([
        client.newSession(projectRoot),
        client.loadSession(projectRoot, "chunked-session"),
      ]);
      const diagnostics = JSON.stringify([...consoleError.mock.calls, ...consoleWarn.mock.calls]);

      expect(sessionId).toBe("chunked-session");
      expect(diagnostics).not.toMatch(/unknown[^\n]*response|response[^\n]*unknown/i);
    } finally {
      consoleError.mockRestore();
      consoleWarn.mockRestore();
    }
  });

  it("bounds a cancellation write that the child never reads and fully closes the client", async () => {
    const client = await testClient(rawAgentScript({ stopReadingAfterNew: true }), {
      maxInboundLineBytes: 400_000,
      cancelTimeoutMs: 20,
      terminationGraceMs: 20,
    } as HermesAcpClientOptions & { maxInboundLineBytes: number; cancelTimeoutMs: number });
    const sessionId = await client.newSession(clientProjectRoot(client));
    const prompt = client.prompt(sessionId, "p".repeat(256_000), { timeoutMs: 5_000 }).catch(() => undefined);
    await new Promise((resolve) => setTimeout(resolve, 10));
    const testDeadline = new Promise<never>((_resolve, reject) => {
      setTimeout(() => reject(new Error("Cancellation exceeded the test deadline.")), 500);
    });

    await expect(Promise.race([client.cancel(sessionId), testDeadline])).rejects.toThrow(
      "Hermes ACP cancellation timed out.",
    );
    expect(client.isClosed()).toBe(true);
    await prompt;
  });

  it("closes idempotently and escalates an ignored graceful signal before resolving", async () => {
    const client = await testClient(agentScript({ ignoreSigterm: true }), { terminationGraceMs: 20 });
    const startedAt = Date.now();

    const firstClose = client.close();
    const secondClose = client.close();

    expect(firstClose).toBeInstanceOf(Promise);
    expect(secondClose).toBe(firstClose);
    await firstClose;
    expect(Date.now() - startedAt).toBeGreaterThanOrEqual(10);
  });

  it("rejects close when managed process cleanup cannot be verified", async () => {
    managedProcessMock.spawn = vi.fn(async (input) => {
      const managed = await spawnManagedProcessFallback(input);
      return {
        ...managed,
        closed: managed.closed.then(() => {
          throw new Error("private managed close failure");
        }),
        terminateAndReap: vi.fn(async () => {
          await managed.terminateAndReap();
          throw new Error("private managed reap failure");
        }),
      };
    });
    const client = await testClient(agentScript());
    clients.splice(clients.indexOf(client), 1);

    const closing = client.close();

    await expect(closing).rejects.toThrow("Hermes ACP process cleanup could not be verified.");
    expect(client.close()).toBe(closing);
  });
});

async function testClient(
  script: string,
  options: HermesAcpClientOptions = {},
): Promise<HermesAcpClient> {
  const projectRoot = options.projectRoot ? options.projectRoot : await makeProjectRoot();
  const client = await createHermesAcpClient({
    executablePath: process.execPath,
    args: ["--input-type=module", "--eval", script],
    processCwd: projectRoot,
    initializationTimeoutMs: 2_000,
    projectRoot,
    ...options,
  });
  clientProjectRoots.set(client, projectRoot);
  clients.push(client);
  return client;
}

function clientProjectRoot(client: HermesAcpClient): string {
  const projectRoot = clientProjectRoots.get(client);
  if (!projectRoot) throw new Error("Missing test project root.");
  return projectRoot;
}

async function makeProjectRoot(): Promise<string> {
  const projectRoot = await mkdtemp(join(tmpdir(), "skyturn-acp-project-"));
  projectRoots.push(projectRoot);
  await mkdir(join(projectRoot, ".git"), { recursive: true });
  return projectRoot;
}

async function spawnManagedProcessFallback(input: SpawnManagedProcessInput): Promise<ManagedProcess> {
  const child = spawnChildProcess(input.executablePath, input.args, {
    cwd: input.cwd,
    env: input.env,
    shell: false,
    stdio: ["pipe", "pipe", "pipe"],
  });
  const closed = new Promise<{ exitCode: number | null; signalCode: NodeJS.Signals | null }>((resolve, reject) => {
    child.once("error", reject);
    child.once("close", (exitCode, signalCode) => resolve({ exitCode, signalCode }));
  });
  let termination: Promise<void> | null = null;
  return {
    child,
    ready: Promise.resolve(),
    closed,
    targetInput: child.stdin,
    terminateAndReap() {
      if (!termination) {
        termination = (async () => {
          if (child.exitCode === null && child.signalCode === null) {
            try {
              child.kill("SIGTERM");
            } catch {}
          }
          const settled = await Promise.race([
            closed.then(() => true, () => true),
            new Promise<false>((resolve) => setTimeout(() => resolve(false), input.cleanupTimeoutMs)),
          ]);
          if (!settled && child.exitCode === null && child.signalCode === null) {
            try {
              child.kill("SIGKILL");
            } catch {}
          }
          await closed.catch(() => undefined);
        })();
      }
      return termination;
    },
  };
}

function agentScript(options: {
  chunks?: string[];
  exitMarkerPath?: string;
  reflectFd3SessionNew?: boolean;
  hangLoad?: boolean;
  hangInitialize?: boolean;
  hangNew?: boolean;
  hangPrompt?: boolean;
  ignoreSigterm?: boolean;
  pidMarkerPath?: string;
  sessionId?: string;
} = {}): string {
  const chunks = options.chunks ?? ["# Requirements", "\n\nComplete."];
  const notifications = chunks.map((chunk) => `
        await client.notify(acp.methods.client.session.update, {
          sessionId: params.sessionId,
          update: {
            sessionUpdate: "agent_message_chunk",
            content: { type: "text", text: ${JSON.stringify(chunk)} },
          },
        });`).join("");
  return `
    import { Readable, Writable } from "node:stream";
    import { writeFileSync } from "node:fs";
    import * as acp from ${JSON.stringify(acpSdkModuleUrl)};
    const sessionId = ${JSON.stringify(options.sessionId ?? "opaque-session-do-not-publish")};
    ${options.pidMarkerPath ? `writeFileSync(${JSON.stringify(options.pidMarkerPath)}, String(process.pid));` : ""}
    ${options.exitMarkerPath ? `
    let markedClosed = false;
    const markClosed = () => {
      if (markedClosed) return;
      markedClosed = true;
      writeFileSync(${JSON.stringify(options.exitMarkerPath)}, "closed");
    };
    process.on("exit", markClosed);
    process.on("SIGTERM", () => {
      markClosed();
      process.exit(0);
    });` : ""}
    const app = acp.agent({ name: "skyturn-test-agent" })
      .onRequest(acp.methods.agent.initialize, async ({ params }) => {
        ${options.hangInitialize ? "await new Promise(() => {});" : ""}
        return {
          protocolVersion: params.protocolVersion,
          agentCapabilities: { loadSession: true },
        };
      })
      .onRequest(acp.methods.agent.session.new, async ({ params }) => {
        ${options.hangNew ? "await new Promise(() => {});" : options.reflectFd3SessionNew ? `
        const fs = await import("node:fs");
        return {
          sessionId: \`param:\${params.cwd}|cwd:\${process.cwd()}|fd3dir:\${fs.fstatSync(3).isDirectory()}|anchor:\${fs.readFileSync(".git/anchor.txt", "utf8")}\`,
        };` : "return { sessionId };"}
      })
      .onRequest(acp.methods.agent.session.load, async ({ params }) => {
        ${options.hangLoad ? "await new Promise(() => {});" : ""}
        if (params.sessionId !== sessionId) throw new Error("missing session");
        return {};
      })
      .onRequest(acp.methods.agent.session.prompt, async ({ params, client }) => {
        ${options.hangPrompt ? "await new Promise(() => {});" : `
        ${notifications}
        await client.notify(acp.methods.client.session.update, {
          sessionId: params.sessionId,
          update: {
            sessionUpdate: "agent_thought_chunk",
            content: { type: "text", text: "private thought" },
          },
        });
        return { stopReason: "end_turn" };`}
      })
      .onNotification(acp.methods.agent.session.cancel, () => {});
    const stream = acp.ndJsonStream(
      Writable.toWeb(process.stdout),
      Readable.toWeb(process.stdin),
    );
    const connection = app.connect(stream);
    ${options.ignoreSigterm ? `
    process.on("SIGTERM", () => {
      setTimeout(() => process.exit(0), 200);
    });` : ""}
    await connection.closed;
    ${options.ignoreSigterm ? "await new Promise(() => {});" : ""}
  `;
}

function rawAgentScript(options: {
  chunkValidMessages?: boolean;
  exitMarkerPath?: string;
  interceptedRequest?: { method: string; params: Record<string, unknown> };
  malformedSecret?: string;
  oversizedNoNewline?: boolean;
  pidMarkerPath?: string;
  reverseConcurrentResponses?: boolean;
  responseMarkerPath?: string;
  semanticInvalid?: { path: string; prompt: string; sessionId: string };
  semanticInvalidRequest?: { path: string; prompt: string; sessionId: string };
  semanticInvalidResponse?: { path: string; prompt: string; sessionId: string };
  sessionNewError?: { data: string; message: string };
  stopReadingAfterNew?: boolean;
  unknownInbound?: { path: string; prompt: string; sessionId: string };
  validNonTextNotifications?: boolean;
}): string {
  if (options.oversizedNoNewline) {
    return `
      process.stdout.write("x".repeat(1_024));
      setInterval(() => {}, 1_000);
      await new Promise(() => {});
    `;
  }
  if (options.malformedSecret) {
    return `
      process.stdout.write(${JSON.stringify(`{"secret":"${options.malformedSecret}"`)});
      setInterval(() => {}, 1_000);
      await new Promise(() => {});
    `;
  }
  return `
    ${options.exitMarkerPath || options.pidMarkerPath || options.interceptedRequest || options.responseMarkerPath
      ? 'import { closeSync, writeFileSync } from "node:fs";'
      : ""}
    ${options.pidMarkerPath ? `writeFileSync(${JSON.stringify(options.pidMarkerPath)}, String(process.pid));` : ""}
    ${options.exitMarkerPath ? `process.on("SIGTERM", () => {
      writeFileSync(${JSON.stringify(options.exitMarkerPath)}, "closed");
      process.exit(0);
    });` : ""}
    const sessionId = "chunked-session";
    let input = "";
    let stopped = false;
    let interceptedSessionNew = null;
    const concurrentRequests = [];
    const send = async (message) => {
      const line = JSON.stringify(message) + "\\n";
      const split = ${options.chunkValidMessages ? "Math.max(1, Math.floor(line.length / 2))" : "line.length"};
      process.stdout.write(line.slice(0, split));
      if (split < line.length) {
        await new Promise((resolve) => setTimeout(resolve, 1));
        process.stdout.write(line.slice(split));
      }
    };
    const respondToConcurrentRequests = async () => {
      if (concurrentRequests.length !== 2) return;
      for (const request of [...concurrentRequests].reverse()) {
        await send({
          jsonrpc: "2.0",
          id: request.id,
          result: request.method === "session/new" ? { sessionId } : {},
        });
      }
    };
    const onData = async (chunk) => {
      if (stopped) return;
      input += chunk.toString("utf8");
      while (true) {
        const newline = input.indexOf("\\n");
        if (newline < 0) return;
        const line = input.slice(0, newline);
        input = input.slice(newline + 1);
        const message = JSON.parse(line);
        ${options.responseMarkerPath ? `
        if (message.id === "intercepted-client-request" && !("method" in message)) {
          writeFileSync(${JSON.stringify(options.responseMarkerPath)}, JSON.stringify(message));
          await send({ jsonrpc: "2.0", id: interceptedSessionNew.id, result: { sessionId } });
          continue;
        }` : ""}
        if (message.method === "initialize") {
          ${options.unknownInbound ? `await send({ jsonrpc: "2.0", method: "skyturn/unknown", params: {
            path: ${JSON.stringify(options.unknownInbound.path)},
            prompt: ${JSON.stringify(options.unknownInbound.prompt)},
            sessionId: ${JSON.stringify(options.unknownInbound.sessionId)},
          } });` : ""}
          ${options.semanticInvalid ? `await send({ jsonrpc: "2.0", method: "session/update", params: {
            sessionId: ${JSON.stringify(options.semanticInvalid.sessionId)},
            update: {
              sessionUpdate: "agent_message_chunk",
              content: {
                type: "text",
                text: {
                  path: ${JSON.stringify(options.semanticInvalid.path)},
                  prompt: ${JSON.stringify(options.semanticInvalid.prompt)},
                },
              },
            },
          } });` : ""}
          ${options.semanticInvalidRequest ? `await send({ jsonrpc: "2.0", id: "invalid-request", method: "session/request_permission", params: {
            sessionId: ${JSON.stringify(options.semanticInvalidRequest.sessionId)},
            toolCall: {
              path: ${JSON.stringify(options.semanticInvalidRequest.path)},
              prompt: ${JSON.stringify(options.semanticInvalidRequest.prompt)},
            },
            options: "invalid",
          } });` : ""}
          await send({ jsonrpc: "2.0", id: message.id, result: {
            protocolVersion: message.params.protocolVersion,
            agentCapabilities: { loadSession: true },
          } });
        } else if (message.method === "session/new") {
          ${options.interceptedRequest && options.responseMarkerPath ? `
          interceptedSessionNew = message;
          await send({
            jsonrpc: "2.0",
            id: "intercepted-client-request",
            method: ${JSON.stringify(options.interceptedRequest.method)},
            params: ${JSON.stringify(options.interceptedRequest.params)},
          });` : options.interceptedRequest ? `
          process.stdin.destroy();
          try { closeSync(0); } catch {}
          await send({
            jsonrpc: "2.0",
            id: "intercepted-client-request",
            method: ${JSON.stringify(options.interceptedRequest.method)},
            params: ${JSON.stringify(options.interceptedRequest.params)},
          });` : ""}
          ${options.interceptedRequest && options.responseMarkerPath ? "" : options.reverseConcurrentResponses ? `
          concurrentRequests.push(message);
          await respondToConcurrentRequests();` : `
          ${options.sessionNewError
            ? `await send({ jsonrpc: "2.0", id: message.id, error: {
              code: -32001,
              message: ${JSON.stringify(options.sessionNewError.message)},
              data: ${JSON.stringify(options.sessionNewError.data)},
            } });`
            : `await send({ jsonrpc: "2.0", id: message.id, result: ${options.semanticInvalidResponse
            ? `{ sessionId: { path: ${JSON.stringify(options.semanticInvalidResponse.path)}, prompt: ${JSON.stringify(options.semanticInvalidResponse.prompt)}, sessionId: ${JSON.stringify(options.semanticInvalidResponse.sessionId)} } }`
            : "{ sessionId }"} });`}
          if (${options.stopReadingAfterNew === true}) {
            stopped = true;
            process.stdin.pause();
          }`}
        } else if (message.method === "session/load") {
          ${options.reverseConcurrentResponses ? `
          concurrentRequests.push(message);
          await respondToConcurrentRequests();` : `
          await send({ jsonrpc: "2.0", id: message.id, result: {} });`}
        } else if (message.method === "session/prompt") {
          ${options.validNonTextNotifications ? `await send({ jsonrpc: "2.0", method: "session/update", params: {
            sessionId,
            update: {
              sessionUpdate: "tool_call",
              toolCallId: "tool-1",
              title: "Inspect project",
              kind: "read",
              status: "completed",
            },
          } });
          await send({ jsonrpc: "2.0", method: "session/update", params: {
            sessionId,
            update: {
              sessionUpdate: "current_mode_update",
              currentModeId: "plan",
            },
          } });` : ""}
          await send({ jsonrpc: "2.0", method: "session/update", params: {
            sessionId,
            update: {
              sessionUpdate: "agent_message_chunk",
              content: { type: "text", text: "# Chunked\\n\\nValid." },
            },
          } });
          await send({ jsonrpc: "2.0", id: message.id, result: { stopReason: "end_turn" } });
        }
      }
    };
    process.stdin.on("data", (chunk) => { void onData(chunk); });
    setInterval(() => {}, 1_000);
    await new Promise(() => {});
  `;
}

function processMarkerScript(pidMarkerPath: string): string {
  return `
    import { writeFileSync } from "node:fs";
    writeFileSync(${JSON.stringify(pidMarkerPath)}, String(process.pid));
    setInterval(() => {}, 1_000);
    await new Promise(() => {});
  `;
}

async function readMarkerPid(pidMarkerPath: string, timeoutMs: number): Promise<number | null> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      return Number.parseInt(await readFile(pidMarkerPath, "utf8"), 10);
    } catch {
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
  }
  return null;
}

function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function deepStrings(value: unknown): string[] {
  if (typeof value === "string") return value.length >= 8 ? [value] : [];
  if (Array.isArray(value)) return value.flatMap(deepStrings);
  if (!value || typeof value !== "object") return [];
  return Object.values(value).flatMap(deepStrings);
}
