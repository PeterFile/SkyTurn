import { spawn, type ChildProcess } from "node:child_process";
import { randomBytes, randomUUID } from "node:crypto";
import { constants as fsConstants } from "node:fs";
import { access, realpath, stat } from "node:fs/promises";
import { createServer } from "node:net";
import { resolve, win32 } from "node:path";
import type { Duplex } from "node:stream";
import { fileURLToPath } from "node:url";

const protocolVersion = 1;
const maxControlOutputChars = 16_384;
const maxHelperBytes = 1_000_000;
const defaultSetupTimeoutMs = 15_000;
const cleanupVerificationError = "Windows agent process tree cleanup could not be verified.";
const capabilityError = "Windows Job Object process host is unavailable.";

interface WindowsJobObjectReady {
  rootPid: number;
}

interface WindowsJobObjectCloseResult {
  exitCode: number | null;
  signalCode: NodeJS.Signals | null;
}

export interface WindowsJobObjectProtocol {
  ready: Promise<WindowsJobObjectReady>;
  closed: Promise<WindowsJobObjectCloseResult>;
  terminateAndReap(): Promise<void>;
}

export interface WindowsJobObjectProcess {
  child: ChildProcess;
  closed: Promise<WindowsJobObjectCloseResult>;
  terminateAndReap(): Promise<void>;
}

interface WindowsJobObjectLaunchOptions {
  cwd: string;
  env: NodeJS.ProcessEnv;
  cleanupTimeoutMs: number;
}

interface HelperProcessLifecycle {
  closed: Promise<WindowsJobObjectCloseResult>;
  terminateAndReap(): Promise<void>;
}

const helperProcessLifecycles = new WeakMap<ChildProcess, HelperProcessLifecycle>();

export function assertVerifiedPtyProcessBoundary(platform: NodeJS.Platform = process.platform): void {
  if (platform === "win32") {
    throw new Error("PTY agent sessions are unavailable on Windows without a verified Job Object boundary.");
  }
}

export async function spawnWindowsJobObjectProcess(
  executablePath: string,
  args: string[],
  options: WindowsJobObjectLaunchOptions,
): Promise<WindowsJobObjectProcess> {
  if (process.platform !== "win32") throw new Error(capabilityError);
  const helperPath = fileURLToPath(new URL("../native/job-object-host.ps1", import.meta.url));
  const [powershellPath] = await Promise.all([
    findSystemPowerShell(options.env),
    validatePackagedHelper(helperPath),
  ]);
  if (!powershellPath) throw new Error(capabilityError);

  const token = randomBytes(32).toString("hex");
  const pipeName = `skyturn-job-${process.pid}-${randomUUID()}`;
  const pipePath = `\\\\.\\pipe\\${pipeName}`;
  const server = createServer();
  const connection = deferred<Duplex>();
  server.once("connection", (socket) => connection.resolve(socket));
  server.once("error", connection.reject);
  await listen(server, pipePath);

  let child: ChildProcess;
  try {
    child = spawn(powershellPath, powerShellArgs(helperPath), {
      cwd: options.cwd,
      env: options.env,
      shell: false,
      stdio: ["pipe", "pipe", "pipe"],
      windowsHide: true,
    });
  } catch {
    server.close();
    throw new Error(capabilityError);
  }
  const helperProcess = helperProcessLifecycle(child);
  const rawClose = helperProcess.closed.then(() => undefined);
  const startupFailure = deferred<never>();
  const onStartupError = () => startupFailure.reject(new Error(capabilityError));
  child.once("error", onStartupError);
  void rawClose.then(() => startupFailure.reject(new Error(capabilityError)));
  const setupTimer = setTimeout(() => startupFailure.reject(new Error(capabilityError)), defaultSetupTimeoutMs);
  setupTimer.unref?.();

  try {
    if (!child.stdin || !child.stdout || !child.stderr) throw new Error(capabilityError);
    child.stdin.once("error", onStartupError);
    child.stdin.end(`${JSON.stringify({
      version: protocolVersion,
      token,
      pipeName,
      executablePath,
      args,
      cwd: options.cwd,
      cleanupTimeoutMs: boundedCleanupTimeout(options.cleanupTimeoutMs),
    })}\n`);
    const control = await Promise.race([connection.promise, startupFailure.promise]);
    server.close();
    const protocol = attachWindowsJobObjectProtocol(
      child,
      control,
      token,
      Math.max(defaultSetupTimeoutMs, boundedCleanupTimeout(options.cleanupTimeoutMs) + 5_000),
    );
    void protocol.closed.catch(() => undefined);
    await protocol.ready;
    clearTimeout(setupTimer);
    child.off("error", onStartupError);
    child.stdin.off("error", onStartupError);
    return {
      child,
      closed: protocol.closed,
      terminateAndReap: () => protocol.terminateAndReap(),
    };
  } catch (error) {
    clearTimeout(setupTimer);
    server.close();
    await helperProcess.terminateAndReap();
    if (error instanceof Error) throw error;
    throw new Error(capabilityError, { cause: error });
  }
}

export function attachWindowsJobObjectProtocol(
  child: ChildProcess,
  control: Duplex,
  token: string,
  timeoutMs: number,
): WindowsJobObjectProtocol {
  const helperProcess = helperProcessLifecycle(child);
  const ready = deferred<WindowsJobObjectReady>();
  const closed = deferred<WindowsJobObjectCloseResult>();
  let buffer = "";
  let helperClosed = false;
  let readySettled = false;
  let closedSettled = false;
  let failure: Error | null = null;
  let closeAcknowledgement: WindowsJobObjectCloseResult | null = null;
  let termination: Promise<void> | null = null;
  let timer: NodeJS.Timeout | null = setTimeout(() => fail(), timeoutMs);
  timer.unref?.();

  const cleanup = () => {
    if (timer) clearTimeout(timer);
    timer = null;
    control.off("data", onData);
    control.off("error", fail);
    control.off("end", onControlEnd);
    child.off("error", fail);
    control.once("error", () => undefined);
    control.destroy();
  };
  const stopControl = () => {
    control.off("data", onData);
    control.off("error", fail);
    control.off("end", onControlEnd);
    control.once("error", () => undefined);
    control.destroy();
  };
  const rejectReady = (error: Error) => {
    if (readySettled) return;
    readySettled = true;
    ready.reject(error);
  };
  const rejectClosed = (error: Error) => {
    if (closedSettled) return;
    closedSettled = true;
    closed.reject(error);
  };
  function fail(cause?: unknown): void {
    const error = cause === undefined
      ? new Error(cleanupVerificationError)
      : new Error(cleanupVerificationError, { cause });
    beginFailure(error);
  }
  function beginFailure(error: Error): void {
    if (failure) return;
    failure = error;
    if (timer) clearTimeout(timer);
    timer = null;
    stopControl();
    void helperProcess.terminateAndReap();
    finishFailureIfClosed();
  }
  function finishFailureIfClosed(): void {
    if (!failure || !helperClosed || closedSettled) return;
    rejectReady(failure);
    rejectClosed(failure);
    cleanup();
  }
  function finishIfVerified(): void {
    if (!helperClosed || !closeAcknowledgement || closedSettled) return;
    closedSettled = true;
    cleanup();
    closed.resolve(closeAcknowledgement);
  }
  function onHelperClose(exitCode: number | null, signalCode: NodeJS.Signals | null): void {
    helperClosed = true;
    if (failure) {
      finishFailureIfClosed();
      return;
    }
    if (exitCode !== 0 || signalCode !== null) {
      fail();
      return;
    }
    scheduleTimeout();
    finishIfVerified();
  }
  function onControlEnd(): void {
    if (!closeAcknowledgement) fail();
  }
  function onData(chunk: Buffer | string): void {
    buffer += chunk.toString();
    if (buffer.length > maxControlOutputChars) {
      fail();
      return;
    }
    for (;;) {
      const newline = buffer.indexOf("\n");
      if (newline < 0) return;
      const line = buffer.slice(0, newline);
      buffer = buffer.slice(newline + 1);
      const message = parseProtocolMessage(line, token);
      if (!message) {
        fail();
        return;
      }
      if (message.kind === "ready") {
        if (readySettled || closeAcknowledgement) {
          fail();
          return;
        }
        readySettled = true;
        if (timer) clearTimeout(timer);
        timer = null;
        ready.resolve({ rootPid: message.rootPid });
        continue;
      }
      if (message.kind === "failed") {
        if (readySettled || closeAcknowledgement || failure) {
          fail();
          return;
        }
        if (!message.treeEmpty) {
          fail();
          return;
        }
        beginFailure(new Error(capabilityError));
        return;
      }
      if (!readySettled || closeAcknowledgement || !message.treeEmpty) {
        fail();
        return;
      }
      closeAcknowledgement = { exitCode: message.exitCode, signalCode: null };
      finishIfVerified();
    }
  }

  control.setEncoding("utf8");
  control.on("data", onData);
  control.once("error", fail);
  control.once("end", onControlEnd);
  child.on("error", fail);
  void helperProcess.closed.then(({ exitCode, signalCode }) => onHelperClose(exitCode, signalCode));

  return {
    ready: ready.promise,
    closed: closed.promise,
    terminateAndReap() {
      if (termination) return termination;
      termination = closed.promise.then(() => undefined);
      if (!closedSettled) {
        scheduleTimeout();
        control.write(`${JSON.stringify({ version: protocolVersion, token, kind: "terminate" })}\n`, (error) => {
          if (error) fail();
        });
      }
      return termination;
    },
  };

  function scheduleTimeout(): void {
    if (timer || closedSettled) return;
    timer = setTimeout(() => fail(), timeoutMs);
    timer.unref?.();
  }
}

type ProtocolMessage =
  | { kind: "ready"; rootPid: number }
  | { kind: "failed"; stage: "setup"; treeEmpty: boolean }
  | {
      kind: "closed";
      exitCode: number | null;
      termination: "normal" | "cancelled" | "descendants-terminated";
      treeEmpty: boolean;
    };

function parseProtocolMessage(line: string, token: string): ProtocolMessage | null {
  let value: unknown;
  try {
    value = JSON.parse(line);
  } catch {
    return null;
  }
  if (!isRecord(value) || value.version !== protocolVersion || value.token !== token) return null;
  if (
    value.kind === "ready" &&
    hasExactKeys(value, ["kind", "rootPid", "token", "version"]) &&
    Number.isSafeInteger(value.rootPid) &&
    (value.rootPid as number) > 0
  ) {
    return { kind: "ready", rootPid: value.rootPid as number };
  }
  if (
    value.kind === "failed" &&
    hasExactKeys(value, ["kind", "stage", "token", "treeEmpty", "version"]) &&
    value.stage === "setup" &&
    typeof value.treeEmpty === "boolean"
  ) {
    return { kind: "failed", stage: "setup", treeEmpty: value.treeEmpty };
  }
  if (
    value.kind === "closed" &&
    hasExactKeys(value, ["exitCode", "kind", "termination", "token", "treeEmpty", "version"]) &&
    (value.exitCode === null || (Number.isSafeInteger(value.exitCode) && (value.exitCode as number) >= 0)) &&
    (value.termination === "normal" ||
      value.termination === "cancelled" ||
      value.termination === "descendants-terminated") &&
    typeof value.treeEmpty === "boolean"
  ) {
    return {
      kind: "closed",
      exitCode: value.exitCode as number | null,
      termination: value.termination,
      treeEmpty: value.treeEmpty,
    };
  }
  return null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function hasExactKeys(value: Record<string, unknown>, expected: string[]): boolean {
  const actual = Object.keys(value).sort();
  const sortedExpected = [...expected].sort();
  return actual.length === sortedExpected.length && actual.every((key, index) => key === sortedExpected[index]);
}

function deferred<T>(): {
  promise: Promise<T>;
  resolve: (value: T | PromiseLike<T>) => void;
  reject: (error: unknown) => void;
} {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

async function validatePackagedHelper(helperPath: string): Promise<void> {
  const expectedPath = resolve(helperPath);
  const [resolvedPath, helperStat] = await Promise.all([realpath(expectedPath), stat(expectedPath)]);
  if (
    !sameLocalPath(expectedPath, resolvedPath) ||
    !helperStat.isFile() ||
    helperStat.size <= 0 ||
    helperStat.size > maxHelperBytes
  ) {
    throw new Error(capabilityError);
  }
}

async function findSystemPowerShell(env: NodeJS.ProcessEnv): Promise<string | null> {
  const candidates: string[] = [];
  if (env.SystemRoot && win32.isAbsolute(env.SystemRoot)) {
    candidates.push(win32.join(env.SystemRoot, "System32", "WindowsPowerShell", "v1.0", "powershell.exe"));
  }
  if (env.ProgramFiles && win32.isAbsolute(env.ProgramFiles)) {
    candidates.push(win32.join(env.ProgramFiles, "PowerShell", "7", "pwsh.exe"));
  }
  for (const candidate of candidates) {
    try {
      await access(candidate, fsConstants.X_OK);
      return candidate;
    } catch {
      // Continue to the next app-independent system runtime.
    }
  }
  return null;
}

function powerShellArgs(helperPath: string): string[] {
  return [
    "-NoLogo",
    "-NoProfile",
    "-NonInteractive",
    "-ExecutionPolicy",
    "Bypass",
    "-File",
    helperPath,
  ];
}

function listen(server: ReturnType<typeof createServer>, pipePath: string): Promise<void> {
  return new Promise((resolveListen, rejectListen) => {
    const onError = (error: Error) => rejectListen(error);
    server.once("error", onError);
    server.listen(pipePath, () => {
      server.off("error", onError);
      resolveListen();
    });
  });
}

function helperProcessLifecycle(child: ChildProcess): HelperProcessLifecycle {
  const existing = helperProcessLifecycles.get(child);
  if (existing) return existing;

  const closeResult = deferred<WindowsJobObjectCloseResult>();
  let helperClosed = false;
  let termination: Promise<void> | null = null;
  child.once("close", (exitCode, signalCode) => {
    helperClosed = true;
    closeResult.resolve({ exitCode, signalCode });
  });
  const lifecycle: HelperProcessLifecycle = {
    closed: closeResult.promise,
    terminateAndReap() {
      if (termination) return termination;
      termination = closeResult.promise.then(() => undefined);
      if (!helperClosed) {
        try {
          child.kill("SIGKILL");
        } catch {
          // Actual helper close remains the only reap boundary.
        }
      }
      return termination;
    },
  };
  helperProcessLifecycles.set(child, lifecycle);
  return lifecycle;
}

function boundedCleanupTimeout(value: number): number {
  if (!Number.isFinite(value)) return 5_000;
  return Math.max(1_000, Math.min(Math.trunc(value), 30_000));
}

function sameLocalPath(left: string, right: string): boolean {
  return win32.normalize(left).toLowerCase() === win32.normalize(right).toLowerCase();
}
