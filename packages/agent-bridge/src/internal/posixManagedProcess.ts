import { spawn, type ChildProcess } from "node:child_process";
import { constants as osConstants } from "node:os";
import { type Readable, type Writable } from "node:stream";
import { fileURLToPath } from "node:url";

import type { AgentRunSandbox } from "@skyturn/project-core";
import { buildFdAnchoredCliLaunchPlan } from "./fdAnchoredCliLaunch.js";

const capabilityError = "POSIX managed process owner is unavailable.";
const maxProtocolChars = 4_096;
const setupTimeoutMs = 30_000;

export interface PosixManagedProcessCloseResult {
  exitCode: number | null;
  signalCode: NodeJS.Signals | null;
}

export interface PosixManagedProcess {
  child: ChildProcess;
  ready: Promise<void>;
  closed: Promise<PosixManagedProcessCloseResult>;
  terminateAndReap(): Promise<void>;
}

export interface SpawnPosixManagedProcessInput {
  agentKind: "codex" | "hermes";
  args: string[];
  cleanupTimeoutMs: number;
  env: NodeJS.ProcessEnv;
  executablePath: string;
  platform: NodeJS.Platform;
  sandbox: AgentRunSandbox;
  worktreeFd: number;
}

export async function spawnPosixManagedProcess(
  input: SpawnPosixManagedProcessInput,
): Promise<PosixManagedProcess> {
  if (input.platform === "win32") throw new Error(capabilityError);
  const ownerPath = fileURLToPath(new URL("../native/posix-process-owner", import.meta.url));
  const launch = buildFdAnchoredCliLaunchPlan(input);
  const ownerArgs = [
    String(boundedCleanupTimeout(input.cleanupTimeoutMs)),
    launch.fdLaunchPath,
    ...launch.fdLaunchArgs,
  ];
  const executablePath = launch.wrapper?.executablePath ?? ownerPath;
  const args = launch.wrapper
    ? [...launch.wrapper.args, ownerPath, ...ownerArgs]
    : ownerArgs;
  let child: ChildProcess;
  try {
    child = spawn(executablePath, args, {
      detached: true,
      env: input.env,
      shell: false,
      stdio: ["pipe", "pipe", "pipe", input.worktreeFd, "pipe"],
    });
  } catch (error) {
    throw new Error(capabilityError, { cause: error });
  }
  const protocol = attachPosixManagedProcessProtocol(child);
  void protocol.ready.catch(() => undefined);
  void protocol.closed.catch(() => undefined);
  return protocol;
}

function attachPosixManagedProcessProtocol(child: ChildProcess): PosixManagedProcess {
  const ready = deferred<void>();
  const closed = deferred<PosixManagedProcessCloseResult>();
  const reaped = deferred<void>();
  const control = child.stdin as Writable | null;
  const status = child.stdio[4] as Readable | null;
  let buffer = "";
  let closeAcknowledgement: PosixManagedProcessCloseResult | null = null;
  let closedSettled = false;
  let failure: Error | null = null;
  let helperClosed = false;
  let helperExitCode: number | null = null;
  let helperSignalCode: NodeJS.Signals | null = null;
  let helperSpawnFailed = false;
  let readySettled = false;
  let reapSettled = false;
  let setupFailureAcknowledged = false;
  let termination: Promise<void> | null = null;
  let terminateWritten = false;
  const setupTimer = setTimeout(() => beginFailure(new Error(capabilityError)), setupTimeoutMs);
  setupTimer.unref?.();

  function cleanup(): void {
    clearTimeout(setupTimer);
    status?.off("data", onData);
    status?.off("error", onProtocolFailure);
    status?.off("end", onStatusEnd);
    child.off("error", onProtocolFailure);
    status?.destroy();
    control?.destroy();
  }

  function rejectReady(error: Error): void {
    if (readySettled) return;
    readySettled = true;
    ready.reject(error);
  }

  function rejectClosed(error: Error): void {
    if (closedSettled) return;
    closedSettled = true;
    closed.reject(error);
  }

  function settleReap(): void {
    if (reapSettled || !helperClosed) return;
    reapSettled = true;
    const cleanupVerified =
      helperSpawnFailed ||
      closeAcknowledgement !== null && helperExitCode === 0 && helperSignalCode === null ||
      setupFailureAcknowledged && helperExitCode === 70 && helperSignalCode === null;
    if (cleanupVerified) reaped.resolve();
    else reaped.reject(failure ?? new Error(capabilityError));
  }

  function beginFailure(cause?: unknown): void {
    if (failure) return;
    failure = new Error(capabilityError, cause === undefined ? undefined : { cause });
    requestTermination();
    finishIfPossible();
  }

  function requestTermination(): void {
    if (terminateWritten || helperClosed) return;
    terminateWritten = true;
    if (!control) return;
    control.write("T\n", (error) => {
      if (error && !helperClosed) control.destroy();
    });
  }

  function finishIfPossible(): void {
    if (!helperClosed || closedSettled) return;
    settleReap();
    if (
      failure ||
      !closeAcknowledgement ||
      helperExitCode !== 0 ||
      helperSignalCode !== null
    ) {
      const error = failure ?? new Error(capabilityError);
      rejectReady(error);
      rejectClosed(error);
      cleanup();
      return;
    }
    closedSettled = true;
    cleanup();
    closed.resolve(closeAcknowledgement);
  }

  function onProtocolFailure(error?: unknown): void {
    beginFailure(error);
  }

  function onStatusEnd(): void {
    if (!closeAcknowledgement) beginFailure();
  }

  function onData(chunk: Buffer | string): void {
    buffer += chunk.toString();
    if (buffer.length > maxProtocolChars) {
      beginFailure();
      return;
    }
    for (;;) {
      const newline = buffer.indexOf("\n");
      if (newline < 0) return;
      const line = buffer.slice(0, newline);
      buffer = buffer.slice(newline + 1);
      const readyMatch = /^R ([1-9][0-9]*)$/.exec(line);
      if (readyMatch) {
        const rootPid = Number(readyMatch[1]);
        if (readySettled || !Number.isSafeInteger(rootPid)) {
          beginFailure();
          return;
        }
        readySettled = true;
        clearTimeout(setupTimer);
        ready.resolve();
        continue;
      }
      const closeMatch = /^C (-1|0|[1-9][0-9]*) (0|[1-9][0-9]*)$/.exec(line);
      if (closeMatch) {
        if (!readySettled || closeAcknowledgement) {
          beginFailure();
          return;
        }
        const exitCode = Number(closeMatch[1]);
        const signalNumber = Number(closeMatch[2]);
        const signalCode = signalName(signalNumber);
        if (exitCode > 255 || signalNumber > 0 && !signalCode || exitCode >= 0 && signalNumber !== 0) {
          beginFailure();
          return;
        }
        closeAcknowledgement = {
          exitCode: exitCode < 0 ? null : exitCode,
          signalCode,
        };
        finishIfPossible();
        continue;
      }
      if (line === "F") {
        if (!readySettled && !closeAcknowledgement) setupFailureAcknowledged = true;
        beginFailure();
        continue;
      }
      beginFailure();
      return;
    }
  }

  if (!control || !status) {
    beginFailure();
  } else {
    status.setEncoding("utf8");
    status.on("data", onData);
    status.once("error", onProtocolFailure);
    status.once("end", onStatusEnd);
  }
  child.on("error", onProtocolFailure);
  child.once("error", () => {
    helperSpawnFailed = !child.pid;
  });
  child.once("close", (exitCode, signalCode) => {
    helperClosed = true;
    helperExitCode = exitCode;
    helperSignalCode = signalCode;
    finishIfPossible();
  });

  const terminateAndReap = (): Promise<void> => {
    if (termination) return termination;
    requestTermination();
    termination = reaped.promise;
    return termination;
  };

  return {
    child,
    ready: ready.promise,
    closed: closed.promise,
    terminateAndReap,
  };
}

function signalName(signalNumber: number): NodeJS.Signals | null {
  if (signalNumber === 0) return null;
  for (const [name, value] of Object.entries(osConstants.signals)) {
    if (value === signalNumber) return name as NodeJS.Signals;
  }
  return null;
}

function boundedCleanupTimeout(value: number): number {
  if (!Number.isFinite(value)) return 5_000;
  return Math.max(1, Math.min(Math.trunc(value), 30_000));
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
