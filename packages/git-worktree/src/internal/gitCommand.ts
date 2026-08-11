import { spawn } from "node:child_process";

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
      env: sanitizedGitEnvironment(),
      shell: false,
      stdio: ["ignore", "pipe", "pipe"],
    });
  } catch (error) {
    return failedSpawnResult(normalizeSpawnError(error));
  }

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

  const closed = await new Promise<{ exitCode: number | null; signal: NodeJS.Signals | null }>((resolve) => {
    child.once("close", (exitCode, signal) => resolve({ exitCode, signal }));
  });

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

function assertPositiveByteLimit(value: number, name: string): void {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new TypeError(`${name} must be a positive safe integer.`);
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
