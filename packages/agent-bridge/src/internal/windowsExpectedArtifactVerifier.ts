import { spawn, type ChildProcess, type SpawnOptions } from "node:child_process";
import { constants as fsConstants } from "node:fs";
import { access, realpath, stat } from "node:fs/promises";
import { resolve, win32 } from "node:path";
import { fileURLToPath } from "node:url";

import { parseExpectedArtifactDeclarations } from "@skyturn/project-core";

const verifierProtocolVersion = 1;
const defaultTimeoutMs = 10_000;
const maxArtifactCount = 32;
const maxArtifactLength = 1_024;
const maxRootLength = 32_767;
const maxInputChars = 65_536;
const maxOutputChars = 65_536;
const maxHelperBytes = 512_000;
const capabilityError = "Windows expected-artifact verifier capability is unavailable.";
const verificationError = "Windows expected-artifact verification failed.";
interface VerifierResources {
  helperPath: string;
  powershellPath: string;
}

interface ChildCloseResult {
  exitCode: number | null;
  signalCode: NodeJS.Signals | null;
}

interface ChildTermination {
  closed: Promise<ChildCloseResult>;
  terminate(): Promise<ChildCloseResult>;
}

let productionCapability: { key: string; promise: Promise<void> } | null = null;
const injectedCapabilities = new WeakMap<WindowsArtifactVerifierDependencies, Promise<void>>();

export interface WindowsArtifactVerificationCounts {
  verified: number;
  missing: number;
  empty: number;
  unsafe: number;
}

export interface WindowsArtifactVerificationResult {
  passed: boolean;
  artifacts: string[];
  counts: WindowsArtifactVerificationCounts;
}

export interface WindowsExpectedArtifactVerifierSession {
  verify(): Promise<WindowsArtifactVerificationResult>;
  abort(): Promise<void>;
}

type SpawnProcess = (command: string, args: string[], options: SpawnOptions) => ChildProcess;

export interface WindowsArtifactVerifierDependencies {
  platform?: NodeJS.Platform;
  env?: NodeJS.ProcessEnv;
  helperPath?: string;
  powershellPath?: string;
  timeoutMs?: number;
  spawnProcess?: SpawnProcess;
  validateHelper?: (path: string) => Promise<void>;
  afterRootOpen?: () => Promise<void> | void;
  afterArtifactsOpen?: (helperPid: number) => Promise<void> | void;
}

export async function assertWindowsExpectedArtifactVerifierCapability(
  dependencies: WindowsArtifactVerifierDependencies = {},
): Promise<void> {
  if ((dependencies.platform ?? process.platform) !== "win32") return;
  if (!usesDefaultVerifierDependencies(dependencies)) {
    const cached = injectedCapabilities.get(dependencies);
    if (cached) return cached;
    const probe = probeVerifierCapability(dependencies);
    injectedCapabilities.set(dependencies, probe);
    void probe.catch(() => {
      if (injectedCapabilities.get(dependencies) === probe) injectedCapabilities.delete(dependencies);
    });
    return probe;
  }
  let resources: VerifierResources;
  try {
    resources = await resolveVerifierResources(dependencies);
  } catch {
    throw new Error(capabilityError);
  }
  const key = `${resources.powershellPath}\0${resources.helperPath}`;
  if (!productionCapability || productionCapability.key !== key) {
    const probe = probeVerifierCapability(dependencies, resources);
    productionCapability = { key, promise: probe };
    void probe.catch(() => {
      if (productionCapability?.promise === probe) productionCapability = null;
    });
  }
  return productionCapability.promise;
}

async function probeVerifierCapability(
  dependencies: WindowsArtifactVerifierDependencies,
  resolvedResources?: VerifierResources,
): Promise<void> {
  try {
    const resources = resolvedResources ?? await resolveVerifierResources(dependencies);
    const result = await runBoundedProcess(
      resources.powershellPath,
      powerShellArgs(resources.helperPath, true),
      "",
      dependencies,
      4_096,
    );
    if (result.exitCode !== 0 || !isCapabilityReadyOutput(result.output)) {
      throw new Error(capabilityError);
    }
  } catch {
    throw new Error(capabilityError);
  }
}

function usesDefaultVerifierDependencies(dependencies: WindowsArtifactVerifierDependencies): boolean {
  return Object.values(dependencies).every((value) => value === undefined);
}

export async function openWindowsExpectedArtifactVerifierSession(
  rootPath: string,
  artifactDeclarations: string[],
  dependencies: WindowsArtifactVerifierDependencies = {},
): Promise<WindowsExpectedArtifactVerifierSession> {
  if ((dependencies.platform ?? process.platform) !== "win32") throw new Error(verificationError);
  const artifacts = validateRequest(rootPath, artifactDeclarations);
  let child: ChildProcess | null = null;
  let termination: ChildTermination | null = null;
  let session: WindowsVerifierSession | null = null;
  try {
    const resources = await resolveVerifierResources(dependencies);
    child = (dependencies.spawnProcess ?? spawn)(
      resources.powershellPath,
      powerShellArgs(resources.helperPath, false),
      {
        env: dependencies.env ?? process.env,
        shell: false,
        stdio: ["pipe", "pipe", "ignore"],
        windowsHide: true,
      },
    );
    termination = createChildTermination(child);
    if (!child.stdin || !child.stdout) {
      await termination.terminate();
      throw new Error(verificationError);
    }
    session = new WindowsVerifierSession(
      child,
      child.stdin,
      child.stdout,
      termination,
      artifacts,
      dependencies,
    );
    await session.open(rootPath);
    return session;
  } catch {
    if (session) await session.abort();
    else if (termination) await termination.terminate();
    throw new Error(verificationError);
  }
}

class WindowsVerifierSession implements WindowsExpectedArtifactVerifierSession {
  private readonly artifacts: string[];
  private readonly dependencies: WindowsArtifactVerifierDependencies;
  private outputBuffer = "";
  private totalOutputChars = 0;
  private ready = deferred<void>();
  private result = deferred<WindowsArtifactVerificationResult>();
  private timer: NodeJS.Timeout | null = null;
  private phase: "opening" | "ready" | "verifying" | "result" | "complete" | "failed" = "opening";
  private verifyStarted = false;
  private pendingResult: WindowsArtifactVerificationResult | null = null;
  private failure: Promise<void> | null = null;
  private readonly onProcessError = () => { void this.fail(); };
  private readonly onOutputData = (chunk: string) => this.consumeOutput(chunk);

  constructor(
    private readonly child: ChildProcess,
    private readonly input: NonNullable<ChildProcess["stdin"]>,
    private readonly output: NonNullable<ChildProcess["stdout"]>,
    private readonly termination: ChildTermination,
    artifacts: string[],
    dependencies: WindowsArtifactVerifierDependencies,
  ) {
    this.artifacts = artifacts;
    this.dependencies = dependencies;
    this.input.on("error", this.onProcessError);
    this.output.setEncoding("utf8");
    this.output.on("data", this.onOutputData);
    this.output.on("error", this.onProcessError);
    this.child.once("error", this.onProcessError);
    void this.termination.closed.then(({ exitCode }) => {
      this.removeProcessListeners();
      if (this.phase === "result" && exitCode === 0 && this.pendingResult && this.outputBuffer.length === 0) {
        this.phase = "complete";
        this.clearTimeout();
        this.result.resolve(this.pendingResult);
        return;
      }
      if (this.phase !== "complete") void this.fail();
    });
  }

  async open(rootPath: string): Promise<void> {
    const request = `${JSON.stringify({ version: verifierProtocolVersion, root: rootPath, artifacts: this.artifacts })}\n`;
    if (request.length > maxInputChars) {
      await this.fail();
      throw new Error(verificationError);
    }
    this.armTimeout();
    this.input.write(request);
    await this.ready.promise;
  }

  async verify(): Promise<WindowsArtifactVerificationResult> {
    if (this.phase === "failed") {
      await this.failure;
      throw new Error(verificationError);
    }
    if (this.phase !== "ready" || this.verifyStarted) throw new Error(verificationError);
    this.verifyStarted = true;
    this.phase = "verifying";
    this.armTimeout();
    this.input.write("VERIFY\n");
    try {
      return await this.result.promise;
    } catch {
      throw new Error(verificationError);
    }
  }

  async abort(): Promise<void> {
    if (this.phase === "complete") {
      await this.termination.closed;
      return;
    }
    await this.fail();
  }

  private consumeOutput(chunk: string): void {
    if (this.phase === "failed" || this.phase === "complete") return;
    this.totalOutputChars += chunk.length;
    if (this.totalOutputChars > maxOutputChars) {
      this.fail();
      return;
    }
    this.outputBuffer += chunk;
    let newline = this.outputBuffer.indexOf("\n");
    while (newline >= 0) {
      const line = this.outputBuffer.slice(0, newline).replace(/\r$/, "");
      this.outputBuffer = this.outputBuffer.slice(newline + 1);
      this.consumeLine(line);
      if (isTerminalVerifierPhase(this.phase)) return;
      newline = this.outputBuffer.indexOf("\n");
    }
  }

  private consumeLine(line: string): void {
    if (this.phase === "opening" && line === "READY") {
      void Promise.resolve(this.dependencies.afterRootOpen?.())
        .then(() => {
          if (this.phase !== "opening") return;
          this.phase = "ready";
          this.clearTimeout();
          this.ready.resolve();
        })
        .catch(() => { void this.fail(); });
      return;
    }
    if (this.phase === "verifying" && line === "OPENED") {
      void Promise.resolve(this.dependencies.afterArtifactsOpen?.(this.child.pid ?? -1))
        .then(() => {
          if (this.phase === "verifying") this.input.write("COMMIT\n");
        })
        .catch(() => { void this.fail(); });
      return;
    }
    if (this.phase !== "verifying") {
      this.fail();
      return;
    }
    const parsed = parseVerificationResult(line, this.artifacts);
    if (!parsed) {
      this.fail();
      return;
    }
    this.phase = "result";
    this.pendingResult = parsed;
    this.input.end();
  }

  private armTimeout(): void {
    this.clearTimeout();
    this.timer = setTimeout(() => { void this.fail(); }, this.dependencies.timeoutMs ?? defaultTimeoutMs);
    this.timer.unref?.();
  }

  private clearTimeout(): void {
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
  }

  private fail(): Promise<void> {
    if (this.failure) return this.failure;
    if (this.phase === "complete") return this.termination.closed.then(() => undefined);
    this.phase = "failed";
    this.clearTimeout();
    const error = new Error(verificationError);
    void this.ready.promise.catch(() => undefined);
    void this.result.promise.catch(() => undefined);
    const failure = deferred<void>();
    this.failure = failure.promise;
    void this.termination.terminate().then(() => {
      this.ready.reject(error);
      this.result.reject(error);
      failure.resolve();
    });
    return this.failure;
  }

  private removeProcessListeners(): void {
    this.input.off("error", this.onProcessError);
    this.output.off("data", this.onOutputData);
    this.output.off("error", this.onProcessError);
    this.child.off("error", this.onProcessError);
  }
}

function validateRequest(rootPath: string, artifactDeclarations: string[]): string[] {
  if (
    typeof rootPath !== "string" ||
    rootPath.length === 0 ||
    rootPath.length > maxRootLength ||
    /[\x00-\x1f\x7f]/.test(rootPath) ||
    !win32.isAbsolute(rootPath) ||
    rootPath.startsWith("\\\\") ||
    rootPath.slice(2).includes(":")
  ) {
    throw new Error(verificationError);
  }
  const artifacts = parseExpectedArtifactDeclarations(artifactDeclarations);
  if (
    !artifacts ||
    artifacts.length === 0 ||
    artifacts.length > maxArtifactCount ||
    artifacts.some((artifact) => artifact.length > maxArtifactLength)
  ) {
    throw new Error(verificationError);
  }
  return artifacts;
}

function parseVerificationResult(line: string, expectedArtifacts: string[]): WindowsArtifactVerificationResult | null {
  const value = parseJsonRecord(line);
  if (
    !value ||
    !hasExactKeys(value, ["version", "status", "artifacts", "counts"]) ||
    value.version !== verifierProtocolVersion ||
    (value.status !== "passed" && value.status !== "failed")
  ) {
    return null;
  }
  const counts = parseCounts(value.counts);
  const artifacts = parseExpectedArtifactDeclarations(value.artifacts);
  if (!counts || !artifacts) return null;
  const total = counts.verified + counts.missing + counts.empty + counts.unsafe;
  if (total !== expectedArtifacts.length) return null;
  if (value.status === "passed") {
    if (counts.verified !== expectedArtifacts.length || artifacts.length !== expectedArtifacts.length) return null;
    if (artifacts.some((artifact, index) => artifact !== expectedArtifacts[index])) return null;
    return { passed: true, artifacts, counts };
  }
  if (artifacts.length !== 0 || counts.verified === expectedArtifacts.length) return null;
  return { passed: false, artifacts: [], counts };
}

function parseCounts(value: unknown): WindowsArtifactVerificationCounts | null {
  const record = isRecord(value) ? value : null;
  if (!record) return null;
  const names = ["verified", "missing", "empty", "unsafe"] as const;
  if (Object.keys(record).length !== names.length) return null;
  for (const name of names) {
    if (!Number.isSafeInteger(record[name]) || (record[name] as number) < 0 || (record[name] as number) > maxArtifactCount) {
      return null;
    }
  }
  return {
    verified: record.verified as number,
    missing: record.missing as number,
    empty: record.empty as number,
    unsafe: record.unsafe as number,
  };
}

async function resolveVerifierResources(dependencies: WindowsArtifactVerifierDependencies): Promise<VerifierResources> {
  const helperPath = dependencies.helperPath ?? fileURLToPath(new URL("../native/artifact-gate.ps1", import.meta.url));
  await (dependencies.validateHelper ?? validatePackagedHelper)(helperPath);
  const powershellPath = dependencies.powershellPath ?? await findSystemPowerShell(dependencies.env ?? process.env);
  if (!powershellPath) throw new Error(capabilityError);
  return { helperPath, powershellPath };
}

async function validatePackagedHelper(helperPath: string): Promise<void> {
  const expectedPath = resolve(helperPath);
  const [resolvedPath, helperStat] = await Promise.all([realpath(expectedPath), stat(expectedPath)]);
  if (
    !sameLocalPath(resolvedPath, expectedPath) ||
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

function powerShellArgs(helperPath: string, capability: boolean): string[] {
  return [
    "-NoLogo",
    "-NoProfile",
    "-NonInteractive",
    "-ExecutionPolicy",
    "Bypass",
    "-File",
    helperPath,
    ...(capability ? ["-Capability"] : []),
  ];
}

async function runBoundedProcess(
  executable: string,
  args: string[],
  input: string,
  dependencies: WindowsArtifactVerifierDependencies,
  outputLimit: number,
): Promise<{ exitCode: number | null; output: string }> {
  let child: ChildProcess;
  try {
    child = (dependencies.spawnProcess ?? spawn)(executable, args, {
      env: dependencies.env ?? process.env,
      shell: false,
      stdio: ["pipe", "pipe", "ignore"],
      windowsHide: true,
    });
  } catch {
    throw new Error(capabilityError);
  }
  const termination = createChildTermination(child);
  if (!child.stdin || !child.stdout) {
    await termination.terminate();
    throw new Error(capabilityError);
  }
  const result = deferred<{ exitCode: number | null; output: string }>();
  let output = "";
  let failure: Error | null = null;
  let timer: NodeJS.Timeout | null = null;
  const onFailure = () => fail(new Error(capabilityError));
  const onOutput = (chunk: string) => {
    if (output.length + chunk.length > outputLimit) {
      onFailure();
      return;
    }
    output += chunk;
    if (output.includes("\n") && !isCapabilityReadyOutput(output)) onFailure();
  };
  const removeListeners = () => {
    child.stdin?.off("error", onFailure);
    child.stdout?.off("data", onOutput);
    child.stdout?.off("error", onFailure);
    child.off("error", onFailure);
  };
  const clearProcessTimeout = () => {
    if (timer) clearTimeout(timer);
    timer = null;
  };
  const fail = (error: Error) => {
    if (failure) return;
    failure = error;
    clearProcessTimeout();
    void termination.terminate().then(() => result.reject(error));
  };

  child.stdin.on("error", onFailure);
  child.stdout.setEncoding("utf8");
  child.stdout.on("data", onOutput);
  child.stdout.on("error", onFailure);
  child.once("error", onFailure);
  void termination.closed.then(({ exitCode }) => {
    clearProcessTimeout();
    removeListeners();
    if (!failure) result.resolve({ exitCode, output });
  });
  timer = setTimeout(onFailure, dependencies.timeoutMs ?? defaultTimeoutMs);
  timer.unref?.();
  try {
    child.stdin.end(input);
  } catch {
    onFailure();
  }
  return result.promise;
}

function createChildTermination(child: ChildProcess): ChildTermination {
  const closeResult = deferred<ChildCloseResult>();
  let closed = false;
  let termination: Promise<ChildCloseResult> | null = null;
  child.once("close", (exitCode, signalCode) => {
    closed = true;
    closeResult.resolve({ exitCode, signalCode });
  });
  return {
    closed: closeResult.promise,
    terminate() {
      if (termination) return termination;
      termination = closeResult.promise;
      child.stdin?.destroy();
      if (!closed) {
        try {
          child.kill("SIGKILL");
        } catch {
          // The close event remains the only cleanup authority when termination fails.
        }
      }
      return termination;
    },
  };
}

function parseJsonRecord(value: string): Record<string, unknown> | null {
  try {
    const parsed: unknown = JSON.parse(value);
    return isRecord(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

function isCapabilityReadyOutput(output: string): boolean {
  const parsed = parseJsonRecord(output.trim());
  return Boolean(
    parsed &&
    hasExactKeys(parsed, ["version", "status"]) &&
    parsed.version === verifierProtocolVersion &&
    parsed.status === "ready"
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function hasExactKeys(value: Record<string, unknown>, expected: string[]): boolean {
  const keys = Object.keys(value).sort();
  const expectedKeys = [...expected].sort();
  return keys.length === expectedKeys.length && keys.every((key, index) => key === expectedKeys[index]);
}

function sameLocalPath(left: string, right: string): boolean {
  if (process.platform !== "win32") return left === right;
  return win32.normalize(left).toLowerCase() === win32.normalize(right).toLowerCase();
}

function isTerminalVerifierPhase(value: string): boolean {
  return value === "failed" || value === "complete";
}

function deferred<T>(): {
  promise: Promise<T>;
  resolve: (value: T | PromiseLike<T>) => void;
  reject: (error: unknown) => void;
} {
  let resolvePromise!: (value: T | PromiseLike<T>) => void;
  let rejectPromise!: (error: unknown) => void;
  const promise = new Promise<T>((resolveValue, rejectValue) => {
    resolvePromise = resolveValue;
    rejectPromise = rejectValue;
  });
  return { promise, resolve: resolvePromise, reject: rejectPromise };
}
