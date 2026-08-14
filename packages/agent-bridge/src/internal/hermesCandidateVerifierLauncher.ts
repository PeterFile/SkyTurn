import { spawn } from "node:child_process";
import { constants as fsConstants } from "node:fs";
import {
  access,
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
  type FileHandle,
} from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { dirname, isAbsolute, join, relative, sep } from "node:path";
import { type Readable, type Writable } from "node:stream";
import { fileURLToPath } from "node:url";

import {
  attachPosixManagedProcessProtocol,
  type PosixManagedProcessCloseResult,
} from "./posixManagedProcess.js";
import { resolveCliExecutable } from "./resolveCliExecutable.js";
import { resolveHermesCommand } from "./resolveHermesCommand.js";

const failureMessage = "Hermes candidate verifier failed.";
const maximumPromptBytes = 24 * 1024 * 1024;
const maximumResponseBytes = 1_024;
const maximumFrameBytes = 8_192;
const maximumTimeoutMs = 5 * 60_000;
const cleanupTimeoutMs = 5_000;
const stateFileNames = ["config.yaml", ".env", "auth.json", ".anthropic_oauth.json"] as const;
const isolatedStateDirectoryNames = [
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
] as const;
const isolatedSoul = "SkyTurn isolated candidate verifier state.\n";

export interface HermesCandidateVerifierManagedProcess {
  readonly ready: Promise<void>;
  readonly closed: Promise<PosixManagedProcessCloseResult>;
  readonly stdout: Readable | null;
  readonly stderr: Readable | null;
  readonly input: Writable | null;
  terminateAndReap(): Promise<void>;
  cleanup(): Promise<void>;
}

export type LaunchHermesCandidateVerifierProcess = (input: {
  readonly signal: AbortSignal;
}) => Promise<HermesCandidateVerifierManagedProcess>;

interface LaunchHermesCandidateVerifierDependencies {
  readonly platform?: NodeJS.Platform;
  readonly createTemporaryRoot?: () => Promise<string>;
  readonly spawnProcess?: typeof spawn;
}

interface HermesCandidateVerifierTemporaryRoot {
  readonly root: string;
  readonly ownedDirectories: readonly string[];
}

export interface RunHermesCandidateVerifierInput {
  readonly prompt: string;
  readonly timeoutMs: number;
}

export async function runHermesCandidateVerifier(
  input: RunHermesCandidateVerifierInput,
  dependencies: { readonly launchProcess?: LaunchHermesCandidateVerifierProcess } = {},
): Promise<string> {
  const prompt = validatePrompt(input.prompt);
  const timeoutMs = validateTimeout(input.timeoutMs);
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  let process: HermesCandidateVerifierManagedProcess | null = null;
  let reap: Promise<void> | null = null;
  let removeAbortListener: () => void = () => undefined;
  const terminateAndReap = (): Promise<void> => {
    if (!process) return Promise.resolve();
    reap ??= process.terminateAndReap();
    return reap;
  };
  const aborted = new Promise<never>((_resolve, reject) => {
    const onAbort = () => {
      if (!process) return;
      void terminateAndReap().then(
        () => reject(new Error(failureMessage)),
        () => reject(new Error(failureMessage)),
      );
    };
    controller.signal.addEventListener("abort", onAbort, { once: true });
    removeAbortListener = () => controller.signal.removeEventListener("abort", onAbort);
    if (controller.signal.aborted) onAbort();
  });

  try {
    const launchProcess = dependencies.launchProcess ?? launchHermesCandidateVerifierProcess;
    process = await launchProcess({ signal: controller.signal });
    if (controller.signal.aborted) {
      await terminateAndReap();
      throw new Error(failureMessage);
    }
    if (!process.stdout || !process.stderr || !process.input) throw new Error(failureMessage);
    void process.ready.catch(() => undefined);
    void process.closed.catch(() => undefined);

    const stdout = collectBoundedOutput(process.stdout, maximumFrameBytes, () => controller.abort());
    const stderr = collectBoundedOutput(process.stderr, 0, () => controller.abort());
    void stdout.catch(() => undefined);
    void stderr.catch(() => undefined);

    await Promise.race([process.ready, aborted]);
    await Promise.race([writePrompt(process.input, prompt), aborted]);
    const closeResult = await Promise.race([process.closed, aborted]);
    const [stdoutValue, stderrValue] = await Promise.race([
      Promise.all([stdout, stderr]),
      aborted,
    ]);
    await terminateAndReap();
    if (
      closeResult.exitCode !== 0 ||
      closeResult.signalCode !== null ||
      stderrValue.byteLength !== 0
    ) {
      throw new Error(failureMessage);
    }
    return parseResultFrame(stdoutValue);
  } catch {
    controller.abort();
    try {
      await terminateAndReap();
    } catch {
      // The public boundary remains one fixed failure.
    }
    throw new Error(failureMessage);
  } finally {
    clearTimeout(timer);
    removeAbortListener();
    if (process) {
      let finalizationFailed = false;
      try {
        await terminateAndReap();
      } catch {
        finalizationFailed = true;
      }
      try {
        await process.cleanup();
      } catch {
        finalizationFailed = true;
      }
      if (finalizationFailed) {
        throw new Error(failureMessage);
      }
    }
  }
}

export async function launchHermesCandidateVerifierProcess(input: {
  readonly signal: AbortSignal;
}, dependencies: LaunchHermesCandidateVerifierDependencies = {}): Promise<HermesCandidateVerifierManagedProcess> {
  if ((dependencies.platform ?? process.platform) !== "darwin") throw new Error(failureMessage);
  const environment = process.env;
  let temporaryRoot: string | null = null;
  const ownedDirectories: string[] = [];
  let rootHandle: FileHandle | null = null;
  let managed: ReturnType<typeof attachPosixManagedProcessProtocol> | null = null;
  try {
    assertNotAborted(input.signal);
    await access("/usr/bin/sandbox-exec", fsConstants.X_OK);
    const ownerPath = fileURLToPath(new URL("../native/posix-process-owner", import.meta.url));
    const fdLaunchPath = fileURLToPath(new URL("../native/fd-launch", import.meta.url));
    await access(ownerPath, fsConstants.X_OK);
    await access(fdLaunchPath, fsConstants.X_OK);
    const configuredExecutable = await resolveCliExecutable(
      undefined,
      ["hermes"],
      environment.PATH ?? "",
    );
    if (!configuredExecutable) throw new Error(failureMessage);
    const canonicalHermes = await realpath(configuredExecutable);
    const command = await resolveHermesCommand(configuredExecutable, [], {
      canonicalizeNonShimExecutable: true,
      platform: "darwin",
    });
    const interpreter = command.executablePath;
    if (
      command.args.length !== 1 ||
      command.args[0] !== canonicalHermes ||
      dirname(interpreter) !== dirname(canonicalHermes)
    ) {
      throw new Error(failureMessage);
    }
    await access(interpreter, fsConstants.X_OK);
    assertNotAborted(input.signal);

    const canonicalStateRoot = await resolveHermesStateRoot(environment);
    const createdRoot = await (
      dependencies.createTemporaryRoot ?? (() => mkdtemp(join(tmpdir(), "skyturn-hermes-review-")))
    )();
    temporaryRoot = createdRoot;
    ownedDirectories.push(createdRoot);
    const createdRootMetadata = await lstat(createdRoot);
    if (createdRootMetadata.isSymbolicLink() || !createdRootMetadata.isDirectory()) {
      throw new Error(failureMessage);
    }
    temporaryRoot = await realpath(temporaryRoot);
    ownedDirectories[0] = temporaryRoot;
    if (pathsOverlap(temporaryRoot, canonicalStateRoot)) throw new Error(failureMessage);
    const isolatedStateRoot = join(temporaryRoot, "state");
    const scratchRoot = join(temporaryRoot, "scratch");
    await mkdir(isolatedStateRoot, { mode: 0o700 });
    ownedDirectories.push(isolatedStateRoot);
    await mkdir(scratchRoot, { mode: 0o700 });
    ownedDirectories.push(scratchRoot);
    const isolatedStateDirectories = [isolatedStateRoot];
    for (const directory of isolatedStateDirectoryNames) {
      const ownedDirectory = join(isolatedStateRoot, directory);
      await mkdir(ownedDirectory, { mode: 0o700 });
      ownedDirectories.push(ownedDirectory);
      isolatedStateDirectories.push(ownedDirectory);
    }
    await writeFile(join(isolatedStateRoot, "SOUL.md"), isolatedSoul, { flag: "wx", mode: 0o400 });
    await linkReadableHermesState(canonicalStateRoot, isolatedStateRoot);
    for (const directory of isolatedStateDirectories) await chmod(directory, 0o500);

    const runnerPath = join(temporaryRoot, "verifier.py");
    const runnerSource = await readVerifierRunnerSource();
    await writeFile(runnerPath, runnerSource, { flag: "wx", mode: 0o400 });
    rootHandle = await open(
      temporaryRoot,
      fsConstants.O_RDONLY | fsConstants.O_DIRECTORY | fsConstants.O_NOFOLLOW,
    );
    assertNotAborted(input.signal);

    const sandboxProfile = buildHermesCandidateVerifierSandboxProfile(
      scratchRoot,
      isolatedStateDirectories,
    );
    const childEnvironment = verifierEnvironment(environment, isolatedStateRoot, scratchRoot);
    const child = (dependencies.spawnProcess ?? spawn)(ownerPath, [
      String(cleanupTimeoutMs),
      "--target-stdin",
      fdLaunchPath,
      "/usr/bin/sandbox-exec",
      "-p",
      sandboxProfile,
      interpreter,
      "-I",
      runnerPath,
    ], {
      cwd: temporaryRoot,
      detached: true,
      env: childEnvironment,
      shell: false,
      stdio: ["pipe", "pipe", "pipe", rootHandle.fd, "pipe", "pipe"],
    });
    managed = attachPosixManagedProcessProtocol(child);
    void managed.ready.catch(() => undefined);
    void managed.closed.catch(() => undefined);
    await rootHandle.close();
    rootHandle = null;
    if (input.signal.aborted) {
      await managed.terminateAndReap();
      throw new Error(failureMessage);
    }
    const retainedRoot = temporaryRoot;
    const retainedOwnedDirectories = [...ownedDirectories];
    return {
      ready: managed.ready,
      closed: managed.closed,
      stdout: child.stdout,
      stderr: child.stderr,
      input: managed.targetInput,
      terminateAndReap: () => managed!.terminateAndReap(),
      async cleanup() {
        await cleanupHermesCandidateVerifierTemporaryRoot({
          root: retainedRoot,
          ownedDirectories: retainedOwnedDirectories,
        });
      },
    };
  } catch (error) {
    if (managed) {
      try {
        await managed.terminateAndReap();
      } catch {
        // Preserve the fixed boundary below.
      }
    }
    if (rootHandle) await rootHandle.close().catch(() => undefined);
    if (temporaryRoot) {
      await cleanupHermesCandidateVerifierTemporaryRoot({
        root: temporaryRoot,
        ownedDirectories,
      }).catch(() => undefined);
    }
    throw new Error(failureMessage, { cause: error });
  }
}

export function buildHermesCandidateVerifierSandboxProfile(
  scratchRoot: string,
  isolatedStateDirectories: readonly string[],
): string {
  if (!isAbsolute(scratchRoot) || isolatedStateDirectories.length === 0) {
    throw new Error(failureMessage);
  }
  const stateMetadataRules: string[] = [];
  for (const directory of isolatedStateDirectories) {
    if (!isAbsolute(directory)) throw new Error(failureMessage);
    stateMetadataRules.push(
      `(allow file-write-create (literal ${JSON.stringify(directory)}))`,
      `(allow file-write-mode (literal ${JSON.stringify(directory)}))`,
    );
  }
  return [
    "(version 1)",
    "(allow default)",
    "(deny process-fork)",
    "(deny file-write*)",
    '(allow file-write* (literal "/dev/null"))',
    `(allow file-write* (subpath ${JSON.stringify(scratchRoot)}))`,
    ...stateMetadataRules,
  ].join("\n");
}

export async function cleanupHermesCandidateVerifierTemporaryRoot(
  input: HermesCandidateVerifierTemporaryRoot,
): Promise<void> {
  if (!isAbsolute(input.root)) throw new Error(failureMessage);
  let rootMetadata;
  try {
    rootMetadata = await lstat(input.root);
  } catch (error) {
    if (isMissing(error)) return;
    throw error;
  }
  if (rootMetadata.isSymbolicLink() || !rootMetadata.isDirectory()) {
    throw new Error(failureMessage);
  }

  const owned = new Set(input.ownedDirectories);
  if (!owned.has(input.root)) throw new Error(failureMessage);
  for (const directory of owned) {
    if (!isAbsolute(directory) || !isWithin(input.root, directory)) {
      throw new Error(failureMessage);
    }
    for (let component = directory; component !== input.root; component = dirname(component)) {
      if (!owned.has(component)) throw new Error(failureMessage);
    }
    const metadata = await lstat(directory);
    if (metadata.isSymbolicLink() || !metadata.isDirectory()) {
      throw new Error(failureMessage);
    }
  }

  for (const directory of owned) await chmod(directory, 0o700);
  await rm(input.root, { recursive: true, force: true });
  try {
    await lstat(input.root);
    throw new Error(failureMessage);
  } catch (error) {
    if (!isMissing(error)) throw error;
  }
}

async function resolveHermesStateRoot(environment: NodeJS.ProcessEnv): Promise<string> {
  const configured = environment.HERMES_HOME?.trim();
  const requested = configured || join(environment.HOME?.trim() || homedir(), ".hermes");
  if (!isAbsolute(requested)) throw new Error(failureMessage);
  const canonical = await realpath(requested);
  if (!(await stat(canonical)).isDirectory()) throw new Error(failureMessage);
  return canonical;
}

async function linkReadableHermesState(sourceRoot: string, targetRoot: string): Promise<void> {
  for (const name of stateFileNames) {
    const source = join(sourceRoot, name);
    try {
      const canonical = await realpath(source);
      if (!(await stat(canonical)).isFile()) throw new Error(failureMessage);
      await symlink(canonical, join(targetRoot, name), "file");
    } catch (error) {
      if (!isMissing(error)) throw error;
    }
  }
}

async function readVerifierRunnerSource(): Promise<Buffer> {
  const candidates = [
    new URL("./hermesCandidateVerifier.py", import.meta.url),
    new URL("../../src/internal/hermesCandidateVerifier.py", import.meta.url),
  ];
  for (const candidate of candidates) {
    try {
      return await readFile(candidate);
    } catch (error) {
      if (!isMissing(error)) throw error;
    }
  }
  throw new Error(failureMessage);
}

function verifierEnvironment(
  inherited: NodeJS.ProcessEnv,
  stateRoot: string,
  scratchRoot: string,
): NodeJS.ProcessEnv {
  const inheritedNames = [
    "HOME",
    "USER",
    "LOGNAME",
    "LANG",
    "LC_ALL",
    "TZ",
    "SSL_CERT_FILE",
    "SSL_CERT_DIR",
    "REQUESTS_CA_BUNDLE",
    "CURL_CA_BUNDLE",
    "HTTP_PROXY",
    "HTTPS_PROXY",
    "ALL_PROXY",
    "NO_PROXY",
    "http_proxy",
    "https_proxy",
    "all_proxy",
    "no_proxy",
    "ANTHROPIC_API_KEY",
    "OPENAI_API_KEY",
    "OPENROUTER_API_KEY",
    "GOOGLE_API_KEY",
    "GEMINI_API_KEY",
    "GROQ_API_KEY",
    "CEREBRAS_API_KEY",
    "MISTRAL_API_KEY",
    "TOGETHER_API_KEY",
    "DEEPSEEK_API_KEY",
    "XAI_API_KEY",
    "KIMI_API_KEY",
    "MINIMAX_API_KEY",
    "AZURE_OPENAI_API_KEY",
    "AZURE_OPENAI_ENDPOINT",
    "AWS_ACCESS_KEY_ID",
    "AWS_SECRET_ACCESS_KEY",
    "AWS_SESSION_TOKEN",
    "AWS_BEARER_TOKEN_BEDROCK",
    "AWS_REGION",
    "AWS_DEFAULT_REGION",
    "HERMES_API_KEY",
    "HERMES_INFERENCE_MODEL",
    "HERMES_INFERENCE_PROVIDER",
    "NOUS_INFERENCE_BASE_URL",
    "NOUS_PORTAL_BASE_URL",
    "HERMES_PORTAL_BASE_URL",
  ] as const;
  const result: NodeJS.ProcessEnv = {};
  for (const name of inheritedNames) {
    if (inherited[name] !== undefined) result[name] = inherited[name];
  }
  result.HERMES_HOME = stateRoot;
  result.HERMES_SAFE_MODE = "1";
  result.HERMES_SKIP_CONTEXT_FILES = "1";
  result.HERMES_SKIP_MEMORY = "1";
  result.HERMES_SKIP_BACKGROUND_REVIEW = "1";
  result.TMPDIR = scratchRoot;
  result.TMP = scratchRoot;
  result.TEMP = scratchRoot;
  result.DARWIN_USER_TEMP_DIR = scratchRoot;
  result.XDG_CACHE_HOME = scratchRoot;
  result.XDG_CONFIG_HOME = scratchRoot;
  result.XDG_DATA_HOME = scratchRoot;
  result.PYTHONDONTWRITEBYTECODE = "1";
  result.PYTHONNOUSERSITE = "1";
  result.PYTHONPYCACHEPREFIX = join(scratchRoot, "pycache");
  result.PATH = "/usr/bin:/bin:/usr/sbin:/sbin";
  return result;
}

function collectBoundedOutput(
  stream: Readable,
  maximumBytes: number,
  reject: () => void,
): Promise<Buffer> {
  return new Promise((resolve, rejectPromise) => {
    const chunks: Buffer[] = [];
    let bytes = 0;
    stream.on("data", (chunk: Buffer | string) => {
      const value = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      bytes += value.byteLength;
      if (bytes > maximumBytes) {
        reject();
        return;
      }
      chunks.push(value);
    });
    stream.once("error", () => {
      reject();
      rejectPromise(new Error(failureMessage));
    });
    stream.once("end", () => resolve(Buffer.concat(chunks, bytes)));
  });
}

function writePrompt(input: Writable, prompt: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const onError = () => reject(new Error(failureMessage));
    input.once("error", onError);
    input.end(prompt, () => {
      input.off("error", onError);
      resolve();
    });
  });
}

function parseResultFrame(value: Buffer): string {
  if (value.byteLength === 0 || value.byteLength > maximumFrameBytes) throw new Error(failureMessage);
  const newline = value.indexOf(0x0a);
  if (newline < 0) throw new Error(failureMessage);
  const header = value.subarray(0, newline).toString("ascii");
  const match = /^SKYTURN_HERMES_REVIEW_V1 (0|[1-9][0-9]*)$/.exec(header);
  if (!match) throw new Error(failureMessage);
  const payload = value.subarray(newline + 1);
  if (Number(match[1]) !== payload.byteLength) throw new Error(failureMessage);
  let parsed: unknown;
  try {
    parsed = JSON.parse(payload.toString("utf8"));
  } catch {
    throw new Error(failureMessage);
  }
  if (!isPlainObject(parsed) || parsed.version !== 1) throw new Error(failureMessage);
  if (parsed.status === "rejected" && exactKeys(parsed, ["version", "status"])) {
    throw new Error(failureMessage);
  }
  if (
    parsed.status !== "ok" ||
    !exactKeys(parsed, ["version", "status", "response"]) ||
    typeof parsed.response !== "string" ||
    Buffer.byteLength(parsed.response, "utf8") === 0 ||
    Buffer.byteLength(parsed.response, "utf8") > maximumResponseBytes
  ) {
    throw new Error(failureMessage);
  }
  return parsed.response;
}

function validatePrompt(value: unknown): string {
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    value.includes("\0") ||
    Buffer.byteLength(value, "utf8") > maximumPromptBytes
  ) {
    throw new Error(failureMessage);
  }
  return value;
}

function validateTimeout(value: unknown): number {
  if (!Number.isSafeInteger(value) || (value as number) <= 0 || (value as number) > maximumTimeoutMs) {
    throw new Error(failureMessage);
  }
  return value as number;
}

function exactKeys(value: Record<string, unknown>, keys: string[]): boolean {
  const actual = Object.keys(value);
  return actual.length === keys.length && actual.every((key, index) => key === keys[index]);
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value) &&
    Object.getPrototypeOf(value) === Object.prototype;
}

function pathsOverlap(left: string, right: string): boolean {
  return isWithin(left, right) || isWithin(right, left);
}

function isWithin(parent: string, child: string): boolean {
  const path = relative(parent, child);
  return path === "" || path !== ".." && !path.startsWith(`..${sep}`) && !isAbsolute(path);
}

function assertNotAborted(signal: AbortSignal): void {
  if (signal.aborted) throw new Error(failureMessage);
}

function isMissing(error: unknown): boolean {
  return typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT";
}
