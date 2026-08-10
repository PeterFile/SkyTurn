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
const readOnlyProfile = "(version 1) (allow default) (deny file-write*) (deny process-fork)";
const hermesRuntimeStatePaths = [
  ".mcp-discovery.lock",
  "state.db",
  "state.db-wal",
  "state.db-shm",
  "state.db-journal",
  "kanban.db",
  "kanban.db-wal",
  "kanban.db-shm",
  "kanban.db-journal",
  "logs/agent.log",
  "logs/errors.log",
  "logs/mcp-stderr.log",
  "skills/.usage.json",
] as const;
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
  hermesStateRoot?: string;
  preserveWorktreeFd?: boolean;
  worktreeFd: number;
}

export interface FdAnchoredCliProcess {
  child: ChildProcess;
  launchFailure: Promise<Error | null>;
}

export interface FdAnchoredCliLaunchPlan {
  fdLaunchArgs: string[];
  fdLaunchPath: string;
  wrapper: {
    args: string[];
    executablePath: string;
  } | null;
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
    await access(posixProcessOwnerHelperPath(), fsConstants.X_OK);
  } catch {
    return false;
  }
  if (input.sandbox === "danger-full-access") return true;
  if (input.agentKind === "codex") return supportedCodexRestrictedPlatforms.has(input.platform);
  if (input.platform !== "darwin") return false;
  return probeMacOsReadOnlySandbox(helperPath);
}

export function spawnFdAnchoredCli(input: SpawnFdAnchoredCliInput): FdAnchoredCliProcess {
  const plan = buildFdAnchoredCliLaunchPlan(input);
  const executablePath = plan.wrapper?.executablePath ?? plan.fdLaunchPath;
  const args = plan.wrapper
    ? [...plan.wrapper.args, plan.fdLaunchPath, ...plan.fdLaunchArgs]
    : plan.fdLaunchArgs;
  const child = spawn(executablePath, args, {
    env: input.env,
    detached: true,
    shell: false,
    stdio: ["ignore", "pipe", "pipe", input.worktreeFd, "pipe"],
  });
  return { child, launchFailure: readLaunchFailure(child) };
}

export function buildFdAnchoredCliLaunchPlan(
  input: SpawnFdAnchoredCliInput,
): FdAnchoredCliLaunchPlan {
  if (input.agentKind === "hermes" && input.sandbox === "workspace-write") {
    throw new Error("Hermes workspace-write sandbox is unavailable.");
  }
  const helperPath = fdLaunchHelperPath();
  const fdLaunchArgs = input.agentKind === "codex"
    ? ["--require-git", ...(input.preserveWorktreeFd ? ["--preserve-worktree-fd"] : []), input.executablePath, ...input.args]
    : [...(input.preserveWorktreeFd ? ["--preserve-worktree-fd"] : []), input.executablePath, ...input.args];
  const sandboxedHermes = input.agentKind === "hermes" && input.sandbox !== "danger-full-access";
  return {
    fdLaunchArgs,
    fdLaunchPath: helperPath,
    wrapper: sandboxedHermes
      ? {
          args: ["-p", input.hermesStateRoot
            ? hermesReadOnlyProfile(input.hermesStateRoot)
            : readOnlyProfile],
          executablePath: sandboxExecutablePath,
        }
      : null,
  };
}

function hermesReadOnlyProfile(stateRoot: string): string {
  const writableFiles = hermesRuntimeStatePaths
    .map((relativePath) => `(literal ${JSON.stringify(join(stateRoot, relativePath))})`)
    .join(" ");
  return `${readOnlyProfile} (allow file-write* ${writableFiles})`;
}

function fdLaunchHelperPath(): string {
  return fileURLToPath(new URL("../native/fd-launch", import.meta.url));
}

function posixProcessOwnerHelperPath(): string {
  return fileURLToPath(new URL("../native/posix-process-owner", import.meta.url));
}

function macOsReadOnlySandboxArgs(helperArgs: string[]): string[] {
  return ["-p", readOnlyProfile, ...helperArgs];
}

function macOsReadOnlySandboxProbeEnv(
  env: NodeJS.ProcessEnv,
  versions: NodeJS.ProcessVersions,
): NodeJS.ProcessEnv {
  if (versions.electron === undefined) return env;
  return { ...env, ELECTRON_RUN_AS_NODE: "1" };
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
    const probeScript = [
      'const { spawnSync } = require("node:child_process");',
      'const { writeFileSync } = require("node:fs");',
      "let unsafe = false;",
      'try { writeFileSync("inside", "probe"); unsafe = true; } catch {}',
      'try { writeFileSync(process.argv[1], "probe"); unsafe = true; } catch {}',
      'const child = spawnSync("/usr/bin/true");',
      'if (!child.error || child.error.code !== "EPERM") unsafe = true;',
      "process.exit(unsafe ? 82 : 0);",
    ].join("");
    const helperArgs = [helperPath, process.execPath, "-e", probeScript, outsidePath];
    const targetArgs = [sandboxExecutablePath, ...macOsReadOnlySandboxArgs(helperArgs)];
    const child = spawn(posixProcessOwnerHelperPath(), [String(sandboxProbeTimeoutMs), ...targetArgs], {
      detached: true,
      env: macOsReadOnlySandboxProbeEnv(process.env, process.versions),
      shell: false,
      stdio: ["pipe", "ignore", "ignore", worktree.fd, "pipe"],
    });
    if (!(await waitForManagedProbeClose(child))) return false;
    const insidePath = join(worktreePath, "inside");
    if (await pathExists(insidePath)) return false;
    return !(await pathExists(outsidePath));
  } finally {
    await worktree?.close().catch(() => undefined);
    await rm(probeRoot, { force: true, recursive: true });
  }
}

function waitForManagedProbeClose(child: ChildProcess): Promise<boolean> {
  return new Promise((resolve) => {
    let settled = false;
    let timedOut = false;
    let protocol = "";
    let protocolInvalid = false;
    const status = child.stdio[4];
    const finish = (exitCode: number | null, signalCode: NodeJS.Signals | null) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      resolve(
        !timedOut &&
        !protocolInvalid &&
        exitCode === 0 &&
        signalCode === null &&
        /^R [1-9][0-9]*\nC 0 0\n$/.test(protocol),
      );
    };
    const timeout = setTimeout(() => {
      timedOut = true;
      try {
        child.stdin?.write("T\n", (error) => {
          if (error) child.stdin?.destroy();
        });
      } catch {
        child.stdin?.destroy();
      }
    }, sandboxProbeTimeoutMs);
    if (status instanceof Readable) {
      status.setEncoding("utf8");
      status.on("data", (chunk: string) => {
        if (protocolInvalid) return;
        protocol += chunk;
        if (protocol.length > 128) {
          protocolInvalid = true;
          protocol = "";
        }
      });
      status.once("error", () => {
        protocolInvalid = true;
      });
    } else {
      protocolInvalid = true;
    }
    child.once("error", () => undefined);
    child.once("close", finish);
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
