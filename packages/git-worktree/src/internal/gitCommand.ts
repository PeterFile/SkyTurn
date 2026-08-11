import { spawn } from "node:child_process";
import { isAbsolute } from "node:path";

const identityGitEnvironmentNames = [
  "GIT_AUTHOR_DATE",
  "GIT_AUTHOR_EMAIL",
  "GIT_AUTHOR_NAME",
  "GIT_COMMITTER_DATE",
  "GIT_COMMITTER_EMAIL",
  "GIT_COMMITTER_NAME",
] as const;

// These variables preserve credential prompting and explicit transport policy. None
// can relocate Git repository, worktree, index, object, config, or path semantics.
const transportGitEnvironmentNames = [
  "GIT_ALLOW_PROTOCOL",
  "GIT_ASKPASS",
  "GIT_HTTP_LOW_SPEED_LIMIT",
  "GIT_HTTP_LOW_SPEED_TIME",
  "GIT_HTTP_MAX_REQUESTS",
  "GIT_HTTP_USER_AGENT",
  "GIT_PROTOCOL_FROM_USER",
  "GIT_PROXY_COMMAND",
  "GIT_SSH",
  "GIT_SSH_COMMAND",
  "GIT_SSH_VARIANT",
  "GIT_SSL_CAINFO",
  "GIT_SSL_CAPATH",
  "GIT_SSL_CERT",
  "GIT_SSL_CERT_PASSWORD_PROTECTED",
  "GIT_SSL_CIPHER_LIST",
  "GIT_SSL_KEY",
  "GIT_SSL_NO_VERIFY",
  "GIT_SSL_VERSION",
  "GIT_TERMINAL_PROMPT",
] as const;

const compatibilityGitEnvironmentNames = [
  "GIT_LFS_SKIP_SMUDGE",
  "GIT_OPTIONAL_LOCKS",
] as const;

const allowedGitEnvironmentNames = new Set<string>([
  ...identityGitEnvironmentNames,
  ...transportGitEnvironmentNames,
  ...compatibilityGitEnvironmentNames,
]);

const preparedRefStdoutMaxBytes = 4 * 1024;
const preparedRefStderrMaxBytes = 64 * 1024;
const preparedRefAcknowledgementTimeoutMs = 5_000;
const preparedRefValidationTimeoutMs = 5_000;
const candidateRefUpdateMessage = "skyturn: publish reviewed candidate";

export function sanitizedGitEnvironment(
  source: Readonly<Record<string, string | undefined>> = process.env,
  platform: NodeJS.Platform = process.platform,
): NodeJS.ProcessEnv {
  const environment: NodeJS.ProcessEnv = {};
  const allowedGitEntries = new Map<string, { sourceName: string; value: string }>();

  for (const [name, value] of Object.entries(source)) {
    if (value === undefined) continue;
    if (!/^git_/i.test(name)) {
      environment[name] = value;
      continue;
    }
    const canonicalName = name.toUpperCase();
    if (!allowedGitEnvironmentNames.has(canonicalName)) continue;
    if (platform !== "win32" && name !== canonicalName) continue;

    const existing = allowedGitEntries.get(canonicalName);
    const isExact = name === canonicalName;
    const existingIsExact = existing?.sourceName === canonicalName;
    if (!existing || (isExact && !existingIsExact) || (isExact === existingIsExact && name < existing.sourceName)) {
      allowedGitEntries.set(canonicalName, { sourceName: name, value });
    }
  }

  for (const [name, entry] of allowedGitEntries) environment[name] = entry.value;
  return environment;
}

export interface BoundedGitSpawnOptions {
  stdoutMaxBytes: number;
  stderrMaxBytes: number;
  stdin?: Buffer;
  stdinMaxBytes?: number;
  internalGitIndexFile?: string;
  timeoutMs?: number;
}

export interface BoundedGitSpawnError {
  name: string;
  message: string;
  code?: string;
}

export interface BoundedGitSpawnResult {
  stdout: Buffer;
  stderr: Buffer;
  stdoutTruncated: boolean;
  stderrTruncated: boolean;
  exitCode: number | null;
  signal: NodeJS.Signals | null;
  spawnError: BoundedGitSpawnError | null;
  terminationRequested: boolean;
  terminationAccepted: boolean | null;
  terminationError: BoundedGitSpawnError | null;
}

export interface PreparedCandidateRefUpdate {
  readonly branchRef: string;
  readonly candidateCommit: string;
  readonly expectedHeadCommit: string;
}

interface BoundedStreamState {
  readonly chunks: Buffer[];
  readonly maxBytes: number;
  retainedBytes: number;
  truncated: boolean;
}

export async function spawnBoundedGit(
  cwd: string,
  args: readonly string[],
  options: BoundedGitSpawnOptions,
): Promise<BoundedGitSpawnResult> {
  assertPositiveByteLimit(options.stdoutMaxBytes, "stdoutMaxBytes");
  assertPositiveByteLimit(options.stderrMaxBytes, "stderrMaxBytes");
  if (options.timeoutMs !== undefined) assertExecutionTimeout(options.timeoutMs);
  const stdin = boundedStdin(options);
  const environment = sanitizedGitEnvironment();
  if (options.internalGitIndexFile !== undefined) {
    assertInternalGitIndexFile(options.internalGitIndexFile);
    environment.GIT_INDEX_FILE = options.internalGitIndexFile;
  }

  const stdout = streamState(options.stdoutMaxBytes);
  const stderr = streamState(options.stderrMaxBytes);
  let spawnError: BoundedGitSpawnError | null = null;
  let terminationRequested = false;
  let terminationAccepted: boolean | null = null;
  let terminationError: BoundedGitSpawnError | null = null;

  let child: ReturnType<typeof spawn>;
  try {
    child = spawn("git", [...args], {
      cwd,
      env: environment,
      shell: false,
      stdio: [stdin ? "pipe" : "ignore", "pipe", "pipe"],
    });
  } catch (error) {
    return failedSpawnResult(normalizeSpawnError(error));
  }
  const closedPromise = new Promise<{ exitCode: number | null; signal: NodeJS.Signals | null }>((resolve) => {
    child.once("close", (exitCode, signal) => resolve({ exitCode, signal }));
  });

  const requestTermination = (): void => {
    if (terminationRequested) return;
    terminationRequested = true;
    try {
      terminationAccepted = child.kill("SIGTERM");
    } catch (error) {
      terminationError = normalizeSpawnError(error);
    }
  };

  child.stdout!.on("data", (chunk: Buffer) => {
    retainBoundedChunk(stdout, chunk, requestTermination);
  });
  child.stderr!.on("data", (chunk: Buffer) => {
    retainBoundedChunk(stderr, chunk, requestTermination);
  });
  child.on("error", (error) => {
    spawnError ??= normalizeSpawnError(error);
  });
  if (stdin) {
    child.stdin!.on("error", (error) => {
      spawnError ??= normalizeSpawnError(error);
      requestTermination();
    });
    try {
      child.stdin!.end(stdin);
    } catch (error) {
      spawnError ??= normalizeSpawnError(error);
      requestTermination();
    }
  }

  const timeout = options.timeoutMs === undefined
    ? null
    : setTimeout(requestTermination, options.timeoutMs);
  let closed: { exitCode: number | null; signal: NodeJS.Signals | null };
  try {
    closed = await closedPromise;
  } finally {
    if (timeout !== null) clearTimeout(timeout);
  }

  return {
    stdout: Buffer.concat(stdout.chunks, stdout.retainedBytes),
    stderr: Buffer.concat(stderr.chunks, stderr.retainedBytes),
    stdoutTruncated: stdout.truncated,
    stderrTruncated: stderr.truncated,
    exitCode: closed.exitCode,
    signal: closed.signal,
    spawnError,
    terminationRequested,
    terminationAccepted,
    terminationError,
  };
}

export async function publishPreparedCandidateRef(
  cwd: string,
  request: PreparedCandidateRefUpdate,
): Promise<void> {
  assertPreparedCandidateRefUpdate(request);

  let child: ReturnType<typeof spawn>;
  try {
    child = spawn("git", ["update-ref", "--stdin", "-m", candidateRefUpdateMessage], {
      cwd,
      env: sanitizedGitEnvironment(),
      shell: false,
      stdio: ["pipe", "pipe", "pipe"],
    });
  } catch {
    throw new Error("Prepared candidate ref update failed.");
  }

  let stdout = Buffer.alloc(0);
  const stderr = streamState(preparedRefStderrMaxBytes);
  let stdoutTruncated = false;
  let spawnError: BoundedGitSpawnError | null = null;
  let stdinError: BoundedGitSpawnError | null = null;
  let terminationError: BoundedGitSpawnError | null = null;
  let terminationRequested = false;
  let decision: "abort" | "commit" | null = null;
  let closedResult: { exitCode: number | null; signal: NodeJS.Signals | null } | null = null;
  let wakeReader: (() => void) | null = null;
  let activityVersion = 0;
  let acknowledgementTimedOut = false;

  const wake = (): void => {
    activityVersion += 1;
    const resolve = wakeReader;
    wakeReader = null;
    resolve?.();
  };
  const requestTermination = (): void => {
    if (terminationRequested) return;
    terminationRequested = true;
    try {
      child.kill("SIGTERM");
    } catch (error) {
      terminationError = normalizeSpawnError(error);
    }
  };
  const writeDecision = (value: "abort" | "commit"): void => {
    if (decision !== null) return;
    decision = value;
    try {
      child.stdin!.end(`${value}\n`, "utf8");
    } catch (error) {
      stdinError ??= normalizeSpawnError(error);
    }
  };
  const failBoundedOutput = (): void => {
    writeDecision("abort");
    requestTermination();
    wake();
  };

  child.stdout!.on("data", (chunk: Buffer) => {
    if (stdoutTruncated || chunk.byteLength === 0) return;
    const remaining = preparedRefStdoutMaxBytes - stdout.byteLength;
    if (chunk.byteLength <= remaining) {
      stdout = Buffer.concat([stdout, chunk], stdout.byteLength + chunk.byteLength);
      wake();
      return;
    }
    if (remaining > 0) {
      stdout = Buffer.concat([stdout, chunk.subarray(0, remaining)], preparedRefStdoutMaxBytes);
    }
    stdoutTruncated = true;
    failBoundedOutput();
  });
  child.stderr!.on("data", (chunk: Buffer) => {
    retainBoundedChunk(stderr, chunk, failBoundedOutput);
  });
  child.stdin!.on("error", (error) => {
    stdinError ??= normalizeSpawnError(error);
    wake();
  });
  child.on("error", (error) => {
    spawnError ??= normalizeSpawnError(error);
    wake();
  });
  const closed = new Promise<{ exitCode: number | null; signal: NodeJS.Signals | null }>((resolve) => {
    child.once("close", (exitCode, signal) => {
      closedResult = { exitCode, signal };
      wake();
      resolve(closedResult);
    });
  });

  const writeProtocol = (value: string): void => {
    if (decision !== null) throw new Error("Prepared candidate ref update is already finalized.");
    try {
      child.stdin!.write(value, "utf8");
    } catch (error) {
      stdinError ??= normalizeSpawnError(error);
      throw new Error("Prepared candidate ref update failed.");
    }
  };
  const requireAcknowledgement = async (expected: string): Promise<void> => {
    const timeout = setTimeout(() => {
      acknowledgementTimedOut = true;
      writeDecision("abort");
      requestTermination();
      wake();
    }, preparedRefAcknowledgementTimeoutMs);
    try {
      while (true) {
        if (acknowledgementTimedOut) {
          throw new Error("Prepared candidate ref update protocol failed.");
        }
        const newline = stdout.indexOf(0x0a);
        if (newline >= 0) {
          const acknowledgement = stdout.subarray(0, newline + 1);
          stdout = Buffer.from(stdout.subarray(newline + 1));
          if (!acknowledgement.equals(Buffer.from(`${expected}\n`, "utf8"))) {
            throw new Error("Prepared candidate ref update protocol failed.");
          }
          return;
        }
        if (stdoutTruncated || spawnError || stdinError || closedResult) {
          throw new Error("Prepared candidate ref update protocol failed.");
        }
        const observedActivity = activityVersion;
        await new Promise<void>((resolve) => {
          if (activityVersion !== observedActivity) resolve();
          else wakeReader = resolve;
        });
      }
    } finally {
      clearTimeout(timeout);
    }
  };

  let failure: unknown = null;
  try {
    writeProtocol("start\n");
    await requireAcknowledgement("start: ok");
    writeProtocol([
      "option no-deref",
      `update ${request.branchRef} ${request.candidateCommit} ${request.expectedHeadCommit}`,
      "prepare",
      "",
    ].join("\n"));
    await requireAcknowledgement("prepare: ok");
    await assertPreparedBranchRefIsDirect(cwd, request.branchRef);
    writeDecision("commit");
    await requireAcknowledgement("commit: ok");
  } catch (error) {
    failure = error;
    writeDecision("abort");
    if (decision === "abort" && !acknowledgementTimedOut) {
      try {
        await requireAcknowledgement("abort: ok");
      } catch (abortError) {
        failure = abortError;
      }
    }
  }

  const finalClose = await closed;
  if (
    failure
    || decision !== "commit"
    || stdout.byteLength !== 0
    || stdoutTruncated
    || stderr.truncated
    || spawnError
    || stdinError
    || terminationError
    || finalClose.exitCode !== 0
    || finalClose.signal !== null
  ) {
    throw new Error("Prepared candidate ref update failed.");
  }
}

async function assertPreparedBranchRefIsDirect(cwd: string, branchRef: string): Promise<void> {
  const result = await spawnBoundedGit(cwd, [
    "for-each-ref",
    "--format=%(symref)",
    "--count=1",
    branchRef,
  ], {
    stdoutMaxBytes: preparedRefStdoutMaxBytes,
    stderrMaxBytes: preparedRefStderrMaxBytes,
    timeoutMs: preparedRefValidationTimeoutMs,
  });
  if (
    result.spawnError
    || result.terminationError
    || result.terminationRequested
    || result.stdoutTruncated
    || result.stderrTruncated
    || result.exitCode !== 0
    || !result.stdout.equals(Buffer.from("\n", "utf8"))
  ) {
    throw new Error("Prepared candidate ref validation failed.");
  }
}

function assertPreparedCandidateRefUpdate(request: PreparedCandidateRefUpdate): void {
  if (
    !request
    || typeof request !== "object"
    || typeof request.branchRef !== "string"
    || !request.branchRef.startsWith("refs/heads/")
    || Buffer.byteLength(request.branchRef, "utf8") > 1_024
    || /[\u0000-\u0020\u007f]/u.test(request.branchRef)
    || !/^[0-9a-f]{40}$/.test(request.candidateCommit)
    || !/^[0-9a-f]{40}$/.test(request.expectedHeadCommit)
  ) {
    throw new TypeError("Prepared candidate ref update is invalid.");
  }
}

function boundedStdin(options: BoundedGitSpawnOptions): Buffer | null {
  if (options.stdin === undefined) {
    if (options.stdinMaxBytes !== undefined) {
      throw new TypeError("stdinMaxBytes requires stdin.");
    }
    return null;
  }
  if (!Buffer.isBuffer(options.stdin)) throw new TypeError("stdin must be a Buffer.");
  if (options.stdinMaxBytes === undefined) {
    throw new TypeError("stdinMaxBytes is required with stdin.");
  }
  assertPositiveByteLimit(options.stdinMaxBytes, "stdinMaxBytes");
  if (options.stdin.byteLength > options.stdinMaxBytes) {
    throw new TypeError("stdin exceeds stdinMaxBytes.");
  }
  return Buffer.from(options.stdin);
}

function assertInternalGitIndexFile(value: string): void {
  if (!isAbsolute(value) || value.includes("\0") || value.includes("\r") || value.includes("\n")) {
    throw new TypeError("internalGitIndexFile must be an absolute path.");
  }
}

function assertPositiveByteLimit(value: number, name: string): void {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new TypeError(`${name} must be a positive safe integer.`);
  }
}

function assertExecutionTimeout(value: number): void {
  if (!Number.isSafeInteger(value) || value <= 0 || value > 2_147_483_647) {
    throw new TypeError("timeoutMs must be a positive supported integer.");
  }
}

function streamState(maxBytes: number): BoundedStreamState {
  return { chunks: [], maxBytes, retainedBytes: 0, truncated: false };
}

function retainBoundedChunk(
  state: BoundedStreamState,
  chunk: Buffer,
  onOverflow: () => void,
): void {
  if (state.truncated || chunk.byteLength === 0) return;
  const remaining = state.maxBytes - state.retainedBytes;
  if (chunk.byteLength <= remaining) {
    state.chunks.push(chunk);
    state.retainedBytes += chunk.byteLength;
    return;
  }
  if (remaining > 0) {
    state.chunks.push(chunk.subarray(0, remaining));
    state.retainedBytes += remaining;
  }
  state.truncated = true;
  onOverflow();
}

function normalizeSpawnError(error: unknown): BoundedGitSpawnError {
  const candidate = error as { name?: unknown; message?: unknown; code?: unknown };
  const message = String(candidate?.message ?? error).slice(0, 1_024);
  return {
    name: typeof candidate?.name === "string" ? candidate.name : "Error",
    message,
    ...(typeof candidate?.code === "string" ? { code: candidate.code } : {}),
  };
}

function failedSpawnResult(spawnError: BoundedGitSpawnError): BoundedGitSpawnResult {
  return {
    stdout: Buffer.alloc(0),
    stderr: Buffer.alloc(0),
    stdoutTruncated: false,
    stderrTruncated: false,
    exitCode: null,
    signal: null,
    spawnError,
    terminationRequested: false,
    terminationAccepted: null,
    terminationError: null,
  };
}
