import { spawn, type ChildProcess } from "node:child_process";
import { constants as fsConstants } from "node:fs";
import { access, mkdir, mkdtemp, open, rm, stat, type FileHandle } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Readable } from "node:stream";
import { fileURLToPath } from "node:url";

import type { AgentRunSandbox } from "@skyturn/project-core";

const sandboxExecutablePath = "/usr/bin/sandbox-exec";
const sandboxProbeTimeoutMs = 2_000;
const readOnlyProfile = "(version 1) (allow default) (deny file-write*)";
const supportedCodexRestrictedPlatforms = new Set<NodeJS.Platform>(["darwin", "linux"]);
const sandboxCapability = new Map<string, Promise<boolean>>();

export interface FdAnchoredCliLaunchCapabilityInput {
  agentKind: "codex" | "hermes";
  platform: NodeJS.Platform;
  sandbox: AgentRunSandbox;
}

export interface SpawnFdAnchoredCliInput extends FdAnchoredCliLaunchCapabilityInput {
  args: string[];
  env: NodeJS.ProcessEnv;
  executablePath: string;
  worktreeFd: number;
}

export interface FdAnchoredCliProcess {
  child: ChildProcess;
  launchFailure: Promise<Error | null>;
}

export async function hasFdAnchoredCliLaunchCapability(
  input: FdAnchoredCliLaunchCapabilityInput,
): Promise<boolean> {
  if (input.agentKind === "hermes" && input.sandbox === "workspace-write") {
    // A pathname sandbox rule cannot authorize the same directory retained by worktreeFd.
    return false;
  }
  if (input.platform === "win32") return input.sandbox === "danger-full-access";
  const helperPath = fdLaunchHelperPath();
  try {
    await access(helperPath, fsConstants.X_OK);
  } catch {
    return false;
  }
  if (input.sandbox === "danger-full-access") return true;
  if (input.agentKind === "codex") return supportedCodexRestrictedPlatforms.has(input.platform);
  if (input.platform !== "darwin") return false;
  return probeMacOsReadOnlySandbox(helperPath);
}

export function spawnFdAnchoredCli(input: SpawnFdAnchoredCliInput): FdAnchoredCliProcess {
  if (input.agentKind === "hermes" && input.sandbox === "workspace-write") {
    throw new Error("Hermes workspace-write sandbox is unavailable.");
  }
  const helperPath = fdLaunchHelperPath();
  const helperArgs = [helperPath, input.executablePath, ...input.args];
  const sandboxedHermes = input.agentKind === "hermes" && input.sandbox !== "danger-full-access";
  const executablePath = sandboxedHermes ? sandboxExecutablePath : helperPath;
  const args = sandboxedHermes
    ? macOsReadOnlySandboxArgs(helperArgs)
    : [input.executablePath, ...input.args];
  const child = spawn(executablePath, args, {
    env: input.env,
    detached: true,
    shell: false,
    stdio: ["ignore", "pipe", "pipe", input.worktreeFd, "pipe"],
  });
  return { child, launchFailure: readLaunchFailure(child) };
}

function fdLaunchHelperPath(): string {
  return fileURLToPath(new URL("../native/fd-launch", import.meta.url));
}

function macOsReadOnlySandboxArgs(helperArgs: string[]): string[] {
  return ["-p", readOnlyProfile, ...helperArgs];
}

function probeMacOsReadOnlySandbox(helperPath: string): Promise<boolean> {
  const key = `${helperPath}:read-only`;
  const existing = sandboxCapability.get(key);
  if (existing) return existing;
  const probe = runMacOsReadOnlySandboxProbe(helperPath).catch(() => false);
  sandboxCapability.set(key, probe);
  return probe;
}

async function runMacOsReadOnlySandboxProbe(helperPath: string): Promise<boolean> {
  const probeRoot = await mkdtemp(join(tmpdir(), "skyturn-cli-sandbox-"));
  const worktreePath = join(probeRoot, "worktree");
  const outsidePath = join(probeRoot, "outside");
  let worktree: FileHandle | null = null;
  try {
    await mkdir(worktreePath);
    worktree = await open(
      worktreePath,
      fsConstants.O_RDONLY | fsConstants.O_DIRECTORY | fsConstants.O_NOFOLLOW,
    );
    const shellScript = "if printf probe > inside 2>/dev/null; then exit 82; fi";
    const helperArgs = [helperPath, "/bin/sh", "-c", shellScript, "skyturn-sandbox-probe", outsidePath];
    const args = macOsReadOnlySandboxArgs(helperArgs);
    const child = spawn(sandboxExecutablePath, args, {
      detached: false,
      shell: false,
      stdio: ["ignore", "ignore", "ignore", worktree.fd, "pipe"],
    });
    if (child.stdio[4] instanceof Readable) child.stdio[4].resume();
    const result = await waitForProbeClose(child);
    if (result !== 0) return false;
    const insidePath = join(worktreePath, "inside");
    if (await pathExists(insidePath)) return false;
    return !(await pathExists(outsidePath));
  } finally {
    await worktree?.close().catch(() => undefined);
    await rm(probeRoot, { force: true, recursive: true });
  }
}

function waitForProbeClose(child: ChildProcess): Promise<number | null> {
  return new Promise((resolve) => {
    let settled = false;
    const finish = (status: number | null) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      resolve(status);
    };
    const timeout = setTimeout(() => {
      try {
        child.kill("SIGKILL");
      } catch {
        // A thrown kill does not replace the helper's actual close boundary.
      }
    }, sandboxProbeTimeoutMs);
    child.once("error", () => undefined);
    child.once("close", (code) => finish(code));
  });
}

async function pathExists(path: string): Promise<boolean> {
  try {
    await stat(path);
    return true;
  } catch {
    return false;
  }
}

function readLaunchFailure(child: ChildProcess): Promise<Error | null> {
  const status = child.stdio[4];
  if (!(status instanceof Readable)) {
    return Promise.resolve(new Error("CLI launcher status channel is unavailable."));
  }
  return new Promise((resolve) => {
    let marker = "";
    let settled = false;
    const finish = (failure: Error | null) => {
      if (settled) return;
      settled = true;
      resolve(failure);
    };
    status.setEncoding("utf8");
    status.on("data", (chunk: string) => {
      marker = `${marker}${chunk}`.slice(0, 2);
      if (marker !== "") finish(new Error("CLI launcher failed before exec."));
    });
    status.once("error", () => finish(new Error("CLI launcher status channel failed.")));
    status.once("end", () => {
      if (marker === "") finish(null);
      else finish(new Error("CLI launcher failed before exec."));
    });
  });
}
