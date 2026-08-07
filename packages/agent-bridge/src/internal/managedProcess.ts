import type { ChildProcess } from "node:child_process";
import type { Writable } from "node:stream";

import type { AgentRunSandbox } from "@skyturn/project-core";
import { spawnPosixManagedProcess } from "./posixManagedProcess.js";
import { spawnWindowsJobObjectProcess } from "./windowsJobObjectProcess.js";

export interface ManagedProcessCloseResult {
  exitCode: number | null;
  signalCode: NodeJS.Signals | null;
}

export interface ManagedProcess {
  child: ChildProcess;
  ready: Promise<void>;
  closed: Promise<ManagedProcessCloseResult>;
  targetInput: Writable | null;
  terminateAndReap(): Promise<void>;
}

export interface SpawnManagedProcessInput {
  agentKind: "codex" | "hermes";
  args: string[];
  cleanupTimeoutMs: number;
  cwd: string;
  env: NodeJS.ProcessEnv;
  executablePath: string;
  platform?: NodeJS.Platform;
  preserveWorktreeFd?: boolean;
  sandbox: AgentRunSandbox;
  targetStdin?: "null" | "pipe";
  worktreeFd: number | null;
}

export async function spawnManagedProcess(input: SpawnManagedProcessInput): Promise<ManagedProcess> {
  const platform = input.platform ?? process.platform;
  const targetStdin = input.targetStdin ?? "null";
  if (platform === "win32") {
    if (targetStdin === "pipe") {
      throw new Error("Interactive managed target stdin is unavailable on Windows.");
    }
    if (input.sandbox !== "danger-full-access") {
      throw new Error("Restricted Windows CLI launch is unavailable.");
    }
    const windowsProcess = await spawnWindowsJobObjectProcess(input.executablePath, input.args, {
      cwd: input.cwd,
      env: input.env,
      cleanupTimeoutMs: input.cleanupTimeoutMs,
    });
    return {
      ...windowsProcess,
      ready: Promise.resolve(),
      targetInput: null,
    };
  }
  if (input.worktreeFd === null) throw new Error("CLI worktree descriptor is unavailable.");
  return spawnPosixManagedProcess({
    agentKind: input.agentKind,
    args: input.args,
    cleanupTimeoutMs: input.cleanupTimeoutMs,
    env: input.env,
    executablePath: input.executablePath,
    platform,
    preserveWorktreeFd: input.preserveWorktreeFd ?? false,
    projectRoot: input.cwd,
    sandbox: input.sandbox,
    targetStdin,
    worktreeFd: input.worktreeFd,
  });
}
