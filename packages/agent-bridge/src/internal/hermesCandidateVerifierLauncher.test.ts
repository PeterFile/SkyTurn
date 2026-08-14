import { spawn } from "node:child_process";
import { lstatSync, readFileSync, statSync, writeFileSync } from "node:fs";
import {
  chmod,
  lstat,
  mkdir,
  mkdtemp,
  open,
  readFile,
  realpath,
  rm,
  stat,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough, type Readable, type Writable } from "node:stream";

import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("node:fs/promises", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs/promises")>();
  return {
    ...actual,
    async access(path: Parameters<typeof actual.access>[0], mode?: number) {
      const value = String(path);
      if (
        value === "/usr/bin/sandbox-exec" ||
        value.endsWith("/posix-process-owner") ||
        value.endsWith("/fd-launch")
      ) return;
      return actual.access(path, mode);
    },
  };
});

import {
  buildHermesCandidateVerifierSandboxProfile,
  cleanupHermesCandidateVerifierTemporaryRoot,
  launchHermesCandidateVerifierProcess,
  runHermesCandidateVerifier,
  type HermesCandidateVerifierManagedProcess,
  type LaunchHermesCandidateVerifierProcess,
} from "./hermesCandidateVerifierLauncher.js";

const prompt = "bounded canonical review prompt";
const response = JSON.stringify({
  version: 1,
  requestSha256: "8".repeat(64),
  manifestSha256: "7".repeat(64),
  disposition: "allow",
});
const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map(async (root) => {
    await chmod(root, 0o700).catch(() => undefined);
    await rm(root, { recursive: true, force: true }).catch(() => undefined);
  }));
});

describe("managed Hermes candidate verifier launcher", () => {
  it("writes one prompt to stdin and accepts one exact bounded result frame after verified close", async () => {
    const fixture = successfulManagedProcess(response);
    const launchProcess = vi.fn<LaunchHermesCandidateVerifierProcess>(async () => fixture.process);

    await expect(runHermesCandidateVerifier({ prompt, timeoutMs: 1_000 }, { launchProcess }))
      .resolves.toBe(response);

    expect(fixture.input).toBe(prompt);
    expect(fixture.terminateCalls()).toBe(1);
    expect(fixture.cleanupCalls()).toBe(1);
    expect(launchProcess).toHaveBeenCalledOnce();
  });

  it("uses one end-to-end timeout and does not settle before a real child is terminated and reaped", async () => {
    const fixture = stubbornManagedProcess();
    const startedAt = Date.now();

    await expect(runHermesCandidateVerifier({ prompt, timeoutMs: 40 }, {
      launchProcess: async () => fixture.process,
    })).rejects.toThrow("Hermes candidate verifier failed.");

    expect(Date.now() - startedAt).toBeGreaterThanOrEqual(30);
    expect(fixture.terminateCalls()).toBe(1);
    expect(fixture.closed()).toBe(true);
    expect(fixture.cleanupCalls()).toBe(1);
  }, 10_000);

  it("terminates and reaps before rejecting malformed, oversized, or stderr-bearing output", async () => {
    for (const fixture of [
      completedManagedProcess("not a frame", ""),
      completedManagedProcess("x".repeat(8_193), ""),
      completedManagedProcess(resultFrame(response), "private provider failure"),
    ]) {
      await expect(runHermesCandidateVerifier({ prompt, timeoutMs: 1_000 }, {
        launchProcess: async () => fixture.process,
      })).rejects.toThrow("Hermes candidate verifier failed.");
      expect(fixture.terminateCalls()).toBe(1);
      expect(fixture.cleanupCalls()).toBe(1);
    }
  });

  it("aborts launch work with the same timeout signal before a process exists", async () => {
    let aborted = false;
    const launchProcess: LaunchHermesCandidateVerifierProcess = async ({ signal }) => {
      await new Promise<void>((resolve) => {
        signal.addEventListener("abort", () => {
          aborted = true;
          resolve();
        }, { once: true });
      });
      throw new Error("launch aborted");
    };

    await expect(runHermesCandidateVerifier({ prompt, timeoutMs: 20 }, { launchProcess }))
      .rejects.toThrow("Hermes candidate verifier failed.");
    expect(aborted).toBe(true);
  });

  it("aborts promptly at the deadline but waits for a late launch, real reap, and cleanup", async () => {
    const launch = deferred<HermesCandidateVerifierManagedProcess>();
    const aborted = deferred<void>();
    const fixture = controlledLateManagedProcess();
    const startedAt = Date.now();
    const verification = runHermesCandidateVerifier({ prompt, timeoutMs: 20 }, {
      launchProcess: async ({ signal }) => {
        const observeAbort = () => aborted.resolve(undefined);
        signal.addEventListener("abort", observeAbort, { once: true });
        if (signal.aborted) observeAbort();
        return launch.promise;
      },
    });

    await settleWithin(aborted.promise, 250);
    expect(Date.now() - startedAt).toBeLessThan(250);
    await expectPromisePending(verification);
    expect(fixture.terminateCalls()).toBe(0);
    expect(fixture.cleanupCalls()).toBe(0);

    launch.resolve(fixture.process);
    await waitForCondition(() => fixture.terminateCalls() === 1, 250);
    await expectPromisePending(verification);

    fixture.releaseReap();
    await waitForCondition(() => fixture.cleanupCalls() === 1, 250);
    expect(fixture.reaped()).toBe(true);
    await expectPromisePending(verification);

    fixture.releaseCleanup();
    await expect(verification).rejects.toThrow("Hermes candidate verifier failed.");
    expect(fixture.terminateCalls()).toBe(1);
    expect(fixture.cleanupCalls()).toBe(1);
  });

  it("removes its exact 0500 temporary tree without following state symlinks", async () => {
    const root = await mkdtemp(join(tmpdir(), "skyturn-hermes-review-"));
    const canonicalRoot = await mkdtemp(join(tmpdir(), "skyturn-hermes-canonical-"));
    roots.push(root, canonicalRoot);
    const stateRoot = join(root, "state");
    const scratchRoot = join(root, "scratch");
    const logsRoot = join(stateRoot, "logs");
    const sessionsRoot = join(stateRoot, "sessions");
    const skillsRoot = join(stateRoot, "skills");
    await mkdir(stateRoot, { mode: 0o700 });
    await mkdir(scratchRoot, { mode: 0o700 });
    await mkdir(logsRoot, { mode: 0o500 });
    await mkdir(sessionsRoot, { mode: 0o500 });
    await mkdir(skillsRoot, { mode: 0o500 });
    const canonicalConfig = join(canonicalRoot, "config.yaml");
    await writeFile(canonicalConfig, "canonical-config-sentinel", { mode: 0o400 });
    await symlink(canonicalConfig, join(stateRoot, "config.yaml"), "file");
    await chmod(stateRoot, 0o500);

    await cleanupHermesCandidateVerifierTemporaryRoot({
      root,
      ownedDirectories: [root, stateRoot, scratchRoot, logsRoot, sessionsRoot, skillsRoot],
    });

    await expect(lstat(root)).rejects.toMatchObject({ code: "ENOENT" });
    expect(await readFile(canonicalConfig, "utf8")).toBe("canonical-config-sentinel");
    expect((await stat(canonicalConfig)).mode & 0o777).toBe(0o400);
  });

  it("fails closed on non-darwin before temporary-root or spawn side effects", async () => {
    const createTemporaryRoot = vi.fn(async () => "/unreachable/temp/root");
    const spawnProcess = vi.fn() as unknown as typeof spawn;

    await expect(launchHermesCandidateVerifierProcess(
      { signal: new AbortController().signal },
      { platform: "linux", createTemporaryRoot, spawnProcess },
    )).rejects.toThrow("Hermes candidate verifier failed.");

    expect(createTemporaryRoot).not.toHaveBeenCalled();
    expect(spawnProcess).not.toHaveBeenCalled();
  });

  it("builds the nested isolated state tree before sealing every state directory read-only", async () => {
    const binaryRoot = await mkdtemp(join(tmpdir(), "skyturn-hermes-review-bin-"));
    const canonicalStateRoot = await mkdtemp(join(tmpdir(), "skyturn-hermes-review-state-"));
    const temporaryRoot = await mkdtemp(join(tmpdir(), "skyturn-hermes-review-launch-"));
    roots.push(binaryRoot, canonicalStateRoot, temporaryRoot);
    const hermesPath = join(binaryRoot, "hermes");
    await writeFile(hermesPath, [
      "#!/bin/sh",
      `'''exec' "$(dirname -- "$(realpath -- "$0")")"/'python' "$0" "$@"`,
      "' '''",
      "",
    ].join("\n"), { mode: 0o755 });
    await writeFile(join(binaryRoot, "python"), "#!/bin/sh\nexit 0\n", { mode: 0o755 });
    await writeFile(join(canonicalStateRoot, "config.yaml"), "model: isolated-test\n", {
      mode: 0o400,
    });
    const originalPath = process.env.PATH;
    const originalHermesHome = process.env.HERMES_HOME;
    process.env.PATH = binaryRoot;
    process.env.HERMES_HOME = canonicalStateRoot;
    let managed: HermesCandidateVerifierManagedProcess | null = null;
    const spawnProcess = vi.fn(((ownerPath: string, args: readonly string[]) => {
      expect(ownerPath).toMatch(/\/posix-process-owner$/);
      expect(args[2]).toMatch(/\/fd-launch$/);
      expect(args[3]).toBe("/usr/bin/sandbox-exec");
      const stateRoot = join(temporaryRoot, "state");
      for (const directory of [
        "",
        "cron",
        "sessions",
        "logs",
        "logs/curator",
        "memories",
        "pairing",
        "hooks",
        "image_cache",
        "audio_cache",
        "skills",
      ]) {
        expect(statSync(join(stateRoot, directory)).mode & 0o777).toBe(0o500);
      }
      expect(readFileSync(join(stateRoot, "SOUL.md"), "utf8"))
        .toBe("SkyTurn isolated candidate verifier state.\n");
      expect(lstatSync(join(stateRoot, "config.yaml")).isSymbolicLink()).toBe(true);
      return spawnProtocolFixture();
    }) as unknown as typeof spawn);

    try {
      managed = await launchHermesCandidateVerifierProcess(
        { signal: new AbortController().signal },
        { platform: "darwin", createTemporaryRoot: async () => temporaryRoot, spawnProcess },
      );
      await managed.ready;
      await managed.terminateAndReap();
      await managed.cleanup();
    } finally {
      if (managed) await managed.terminateAndReap().catch(() => undefined);
      if (originalPath === undefined) delete process.env.PATH;
      else process.env.PATH = originalPath;
      if (originalHermesHome === undefined) delete process.env.HERMES_HOME;
      else process.env.HERMES_HOME = originalHermesHome;
    }

    expect(spawnProcess).toHaveBeenCalledOnce();
  });

  it("executes a sealed owned interpreter copy whose bytes survive source replacement before spawn", async () => {
    const binaryRoot = await mkdtemp(join(tmpdir(), "skyturn-hermes-review-bin-"));
    const canonicalStateRoot = await mkdtemp(join(tmpdir(), "skyturn-hermes-review-state-"));
    const temporaryRoot = await mkdtemp(join(tmpdir(), "skyturn-hermes-review-launch-"));
    roots.push(binaryRoot, canonicalStateRoot, temporaryRoot);
    const canonicalTemporaryRoot = await realpath(temporaryRoot);
    const hermesPath = join(binaryRoot, "hermes");
    const interpreterPath = join(binaryRoot, "python");
    const originalInterpreter = "#!/bin/sh\n# original-interpreter\nexit 0\n";
    await writeFile(hermesPath, [
      "#!/bin/sh",
      `'''exec' "$(dirname -- "$(realpath -- "$0")")"/'python' "$0" "$@"`,
      "' '''",
      "",
    ].join("\n"), { mode: 0o755 });
    await writeFile(interpreterPath, originalInterpreter, { mode: 0o755 });
    const canonicalInterpreterPath = await realpath(interpreterPath);
    await writeFile(join(canonicalStateRoot, "config.yaml"), "model: isolated-test\n", { mode: 0o400 });
    const originalPath = process.env.PATH;
    const originalHermesHome = process.env.HERMES_HOME;
    process.env.PATH = binaryRoot;
    process.env.HERMES_HOME = canonicalStateRoot;
    let managed: HermesCandidateVerifierManagedProcess | null = null;
    const spawnProcess = vi.fn(((
      _ownerPath: string,
      args: readonly string[],
      options: { readonly env?: NodeJS.ProcessEnv },
    ) => {
      const launchInterpreter = args[6];
      expect(launchInterpreter).toBe(join(canonicalTemporaryRoot, "python"));
      expect(launchInterpreter).not.toBe(canonicalInterpreterPath);
      expect(statSync(canonicalTemporaryRoot).mode & 0o777).toBe(0o500);
      expect(statSync(launchInterpreter).mode & 0o777).toBe(0o500);
      expect(readFileSync(launchInterpreter, "utf8")).toBe(originalInterpreter);
      expect(options.env?.__PYVENV_LAUNCHER__).toBe(canonicalInterpreterPath);

      writeFileSync(interpreterPath, "#!/bin/sh\n# replacement-interpreter\nexit 82\n", { mode: 0o755 });
      expect(readFileSync(launchInterpreter, "utf8")).toBe(originalInterpreter);
      return spawnProtocolFixture();
    }) as unknown as typeof spawn);

    try {
      managed = await launchHermesCandidateVerifierProcess(
        { signal: new AbortController().signal },
        { platform: "darwin", createTemporaryRoot: async () => temporaryRoot, spawnProcess },
      );
      await managed.ready;
      await managed.terminateAndReap();
      await managed.cleanup();
    } finally {
      if (managed) await managed.terminateAndReap().catch(() => undefined);
      if (originalPath === undefined) delete process.env.PATH;
      else process.env.PATH = originalPath;
      if (originalHermesHome === undefined) delete process.env.HERMES_HOME;
      else process.env.HERMES_HOME = originalHermesHome;
    }

    expect(spawnProcess).toHaveBeenCalledOnce();
  });

  it.each([
    {
      name: "empty",
      async create(path: string) {
        await writeFile(path, "", { mode: 0o755 });
      },
    },
    {
      name: "oversized",
      async create(path: string) {
        const handle = await open(path, "wx", 0o755);
        try {
          await handle.truncate(256 * 1024 * 1024);
        } finally {
          await handle.close();
        }
      },
    },
    {
      name: "non-regular",
      async create(path: string) {
        await mkdir(path, { mode: 0o755 });
      },
    },
  ])("fails closed before spawn for a $name interpreter source", async ({ create }) => {
    const binaryRoot = await mkdtemp(join(tmpdir(), "skyturn-hermes-review-invalid-bin-"));
    const canonicalStateRoot = await mkdtemp(join(tmpdir(), "skyturn-hermes-review-invalid-state-"));
    const temporaryRoot = await mkdtemp(join(tmpdir(), "skyturn-hermes-review-invalid-launch-"));
    roots.push(binaryRoot, canonicalStateRoot, temporaryRoot);
    const hermesPath = join(binaryRoot, "hermes");
    await writeFile(hermesPath, [
      "#!/bin/sh",
      `'''exec' "$(dirname -- "$(realpath -- "$0")")"/'python' "$0" "$@"`,
      "' '''",
      "",
    ].join("\n"), { mode: 0o755 });
    await create(join(binaryRoot, "python"));
    await writeFile(join(canonicalStateRoot, "config.yaml"), "model: isolated-test\n", { mode: 0o400 });
    const originalPath = process.env.PATH;
    const originalHermesHome = process.env.HERMES_HOME;
    process.env.PATH = binaryRoot;
    process.env.HERMES_HOME = canonicalStateRoot;
    const spawnProcess = vi.fn() as unknown as typeof spawn;

    try {
      await expect(launchHermesCandidateVerifierProcess(
        { signal: new AbortController().signal },
        { platform: "darwin", createTemporaryRoot: async () => temporaryRoot, spawnProcess },
      )).rejects.toThrow("Hermes candidate verifier failed.");
    } finally {
      if (originalPath === undefined) delete process.env.PATH;
      else process.env.PATH = originalPath;
      if (originalHermesHome === undefined) delete process.env.HERMES_HOME;
      else process.env.HERMES_HOME = originalHermesHome;
    }

    expect(spawnProcess).not.toHaveBeenCalled();
  });

  it("rejects interpreter identity replacement between resolution and launch", async () => {
    const binaryRoot = await mkdtemp(join(tmpdir(), "skyturn-hermes-review-bin-"));
    const canonicalStateRoot = await mkdtemp(join(tmpdir(), "skyturn-hermes-review-state-"));
    const temporaryRoot = await mkdtemp(join(tmpdir(), "skyturn-hermes-review-launch-"));
    roots.push(binaryRoot, canonicalStateRoot, temporaryRoot);
    const hermesPath = join(binaryRoot, "hermes");
    const interpreterPath = join(binaryRoot, "python");
    await writeFile(hermesPath, [
      "#!/bin/sh",
      `'''exec' "$(dirname -- "$(realpath -- "$0")")"/'python' "$0" "$@"`,
      "' '''",
      "",
    ].join("\n"), { mode: 0o755 });
    await writeFile(interpreterPath, "original interpreter", { mode: 0o755 });
    await writeFile(join(canonicalStateRoot, "config.yaml"), "model: isolated-test\n", { mode: 0o400 });
    const originalPath = process.env.PATH;
    const originalHermesHome = process.env.HERMES_HOME;
    process.env.PATH = binaryRoot;
    process.env.HERMES_HOME = canonicalStateRoot;
    const spawnProcess = vi.fn() as unknown as typeof spawn;

    try {
      await expect(launchHermesCandidateVerifierProcess(
        { signal: new AbortController().signal },
        {
          platform: "darwin",
          async createTemporaryRoot() {
            await rm(interpreterPath);
            await writeFile(interpreterPath, "replacement interpreter", { mode: 0o755 });
            return temporaryRoot;
          },
          spawnProcess,
        },
      )).rejects.toThrow("Hermes candidate verifier failed.");
    } finally {
      if (originalPath === undefined) delete process.env.PATH;
      else process.env.PATH = originalPath;
      if (originalHermesHome === undefined) delete process.env.HERMES_HOME;
      else process.env.HERMES_HOME = originalHermesHome;
    }

    expect(spawnProcess).not.toHaveBeenCalled();
  });

  it("allows only scratch writes and exact isolated-state directory metadata", () => {
    const profile = buildHermesCandidateVerifierSandboxProfile(
      "/private/tmp/review/scratch",
      ["/private/tmp/review/state", "/private/tmp/review/state/logs"],
    );

    expect(profile).toBe([
      "(version 1)",
      "(allow default)",
      "(deny process-fork)",
      "(deny file-write*)",
      '(allow file-write* (literal "/dev/null"))',
      '(allow file-write* (subpath "/private/tmp/review/scratch"))',
      '(allow file-write-create (literal "/private/tmp/review/state"))',
      '(allow file-write-mode (literal "/private/tmp/review/state"))',
      '(allow file-write-create (literal "/private/tmp/review/state/logs"))',
      '(allow file-write-mode (literal "/private/tmp/review/state/logs"))',
    ].join("\n"));
    expect(profile).not.toContain('(subpath "/private/tmp/review/state")');
  });
});

function successfulManagedProcess(value: string) {
  const stdin = new PassThrough();
  const stdout = new PassThrough();
  const stderr = new PassThrough();
  const closed = deferred<{ exitCode: number | null; signalCode: NodeJS.Signals | null }>();
  let input = "";
  let terminated = 0;
  let cleaned = 0;
  stdin.on("data", (chunk: Buffer | string) => {
    input += chunk.toString();
  });
  stdin.once("finish", () => {
    stdout.end(resultFrame(value));
    stderr.end();
    closed.resolve({ exitCode: 0, signalCode: null });
  });
  return {
    process: {
      ready: Promise.resolve(),
      closed: closed.promise,
      stdout,
      stderr,
      input: stdin,
      async terminateAndReap() {
        terminated += 1;
        await closed.promise;
      },
      async cleanup() {
        cleaned += 1;
      },
    } satisfies HermesCandidateVerifierManagedProcess,
    get input() {
      return input;
    },
    terminateCalls: () => terminated,
    cleanupCalls: () => cleaned,
  };
}

function completedManagedProcess(output: string, errorOutput: string) {
  const stdin = new PassThrough();
  const stdout = new PassThrough();
  const stderr = new PassThrough();
  let terminated = 0;
  let cleaned = 0;
  queueMicrotask(() => {
    stdout.end(output);
    stderr.end(errorOutput);
  });
  return {
    process: {
      ready: Promise.resolve(),
      closed: Promise.resolve({ exitCode: 0, signalCode: null }),
      stdout,
      stderr,
      input: stdin,
      async terminateAndReap() {
        terminated += 1;
      },
      async cleanup() {
        cleaned += 1;
      },
    } satisfies HermesCandidateVerifierManagedProcess,
    terminateCalls: () => terminated,
    cleanupCalls: () => cleaned,
  };
}

function stubbornManagedProcess() {
  const child = spawn(process.execPath, ["-e", "setInterval(() => {}, 1_000)"], {
    detached: false,
    shell: false,
    stdio: ["pipe", "pipe", "pipe"],
  });
  const closed = new Promise<{ exitCode: number | null; signalCode: NodeJS.Signals | null }>((resolve) => {
    child.once("close", (exitCode, signalCode) => resolve({ exitCode, signalCode }));
  });
  let didClose = false;
  void closed.then(() => {
    didClose = true;
  });
  let terminated = 0;
  let cleaned = 0;
  return {
    process: {
      ready: new Promise<void>(() => undefined),
      closed,
      stdout: child.stdout as Readable,
      stderr: child.stderr as Readable,
      input: child.stdin as Writable,
      async terminateAndReap() {
        terminated += 1;
        if (child.exitCode === null && child.signalCode === null) child.kill("SIGTERM");
        await closed;
      },
      async cleanup() {
        cleaned += 1;
      },
    } satisfies HermesCandidateVerifierManagedProcess,
    terminateCalls: () => terminated,
    cleanupCalls: () => cleaned,
    closed: () => didClose,
  };
}

function controlledLateManagedProcess() {
  const reap = deferred<void>();
  const cleanup = deferred<void>();
  let terminated = 0;
  let didReap = false;
  let cleaned = 0;
  return {
    process: {
      ready: Promise.resolve(),
      closed: Promise.resolve({ exitCode: null, signalCode: "SIGTERM" as const }),
      stdout: new PassThrough(),
      stderr: new PassThrough(),
      input: new PassThrough(),
      async terminateAndReap() {
        terminated += 1;
        await reap.promise;
        didReap = true;
      },
      async cleanup() {
        cleaned += 1;
        await cleanup.promise;
      },
    } satisfies HermesCandidateVerifierManagedProcess,
    terminateCalls: () => terminated,
    reaped: () => didReap,
    cleanupCalls: () => cleaned,
    releaseReap: () => reap.resolve(undefined),
    releaseCleanup: () => cleanup.resolve(undefined),
  };
}

function spawnProtocolFixture() {
  return spawn(process.execPath, ["-e", [
    'const fs = require("node:fs");',
    'fs.writeSync(4, `R ${process.pid}\\n`);',
    'process.stdin.setEncoding("utf8");',
    'process.stdin.on("data", (value) => {',
    '  if (!value.includes("T\\n")) return;',
    '  fs.writeSync(4, "C 0 0\\n");',
    '  process.exit(0);',
    '});',
  ].join("\n")], {
    detached: true,
    shell: false,
    stdio: ["pipe", "pipe", "pipe", "ignore", "pipe", "pipe"],
  });
}

function resultFrame(value: string): string {
  const payload = JSON.stringify({ version: 1, status: "ok", response: value });
  return `SKYTURN_HERMES_REVIEW_V1 ${Buffer.byteLength(payload)}\n${payload}`;
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((resolvePromise) => {
    resolve = resolvePromise;
  });
  return { promise, resolve };
}

async function settleWithin<T>(promise: Promise<T>, timeoutMs: number): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  const deadline = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => reject(new Error("test deadline exceeded")), timeoutMs);
  });
  try {
    return await Promise.race([promise, deadline]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

async function waitForCondition(condition: () => boolean, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!condition()) {
    if (Date.now() >= deadline) throw new Error("test condition deadline exceeded");
    await new Promise<void>((resolve) => setTimeout(resolve, 1));
  }
}

async function expectPromisePending(promise: Promise<unknown>): Promise<void> {
  const settled = promise.then(
    () => "settled",
    () => "settled",
  );
  const state = await Promise.race([
    settled,
    new Promise<"pending">((resolve) => setTimeout(() => resolve("pending"), 10)),
  ]);
  expect(state).toBe("pending");
}
