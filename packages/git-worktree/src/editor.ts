import { spawn } from "node:child_process";
import { realpath, stat } from "node:fs/promises";
import { isAbsolute } from "node:path";

import type { EditorAdapter, EditorKind } from "./index.js";

const macAppNames = {
  vscode: "Visual Studio Code",
  cursor: "Cursor",
  zed: "Zed",
} as const;

type CoreEditorKind = keyof typeof macAppNames;

const defaultLauncherTimeoutMs = 10_000;
const maxLauncherOutputBytes = 64 * 1024;
const launcherRecovery = "Check the configured launcher path and macOS system open availability, then retry.";

export interface TrustedEditorLauncherError {
  readonly code?: string;
  readonly message: string;
}

export interface TrustedEditorLauncherResult {
  readonly exitCode: number | null;
  readonly signal: NodeJS.Signals | null;
  readonly stderr: string;
  readonly spawnError: TrustedEditorLauncherError | null;
  readonly timedOut: boolean;
  readonly outputLimitExceeded: boolean;
}

export type TrustedEditorLauncher = (
  executable: string,
  args: readonly string[],
  timeoutMs: number,
) => Promise<TrustedEditorLauncherResult>;

export interface NodeEditorAdapterOptions {
  /** Trusted backend/test injection only. Never populate this from renderer input. */
  readonly platform?: NodeJS.Platform;
  /** Trusted backend/test injection only. Production uses the fixed /usr/bin/open path. */
  readonly macOpenExecutable?: string;
  /** Trusted backend/test injection only. Production executes without a shell. */
  readonly runLauncher?: TrustedEditorLauncher;
  readonly timeoutMs?: number;
}

export class NodeEditorAdapter implements EditorAdapter {
  readonly #platform: NodeJS.Platform;
  readonly #macOpenExecutable: string;
  readonly #runLauncher: TrustedEditorLauncher;
  readonly #timeoutMs: number;

  constructor(options: NodeEditorAdapterOptions = {}) {
    this.#platform = options.platform ?? process.platform;
    const macOpenExecutable = options.macOpenExecutable ?? "/usr/bin/open";
    if (!isAbsolute(macOpenExecutable) || macOpenExecutable.includes("\0")) {
      throw new TypeError("macOpenExecutable must be an absolute local executable path.");
    }
    this.#macOpenExecutable = macOpenExecutable;
    this.#runLauncher = options.runLauncher ?? runEditorLauncher;
    this.#timeoutMs = validTimeout(options.timeoutMs) ? options.timeoutMs : defaultLauncherTimeoutMs;
  }

  async openWorktree(editor: EditorKind, worktreePath: string): Promise<{ ok: boolean; message: string }> {
    if (!isCoreEditor(editor)) {
      return {
        ok: false,
        message: `Editor "${String(editor)}" is not supported. Supported editors: vscode, cursor, zed.`,
      };
    }
    if (this.#platform !== "darwin") {
      return {
        ok: false,
        message: `Editor launching is not supported on platform "${this.#platform}".`,
      };
    }

    const target = await canonicalDirectory(worktreePath);
    if (!target.ok) return target;

    const appName = macAppNames[editor];
    let result: TrustedEditorLauncherResult;
    try {
      result = await this.#runLauncher(
        this.#macOpenExecutable,
        ["-a", appName, target.path],
        this.#timeoutMs,
      );
    } catch (error) {
      return {
        ok: false,
        message: `${appName} launch failed: launcher failed to start${errorCodeSuffix(error)}. ${launcherRecovery}`,
      };
    }

    return launchResult(appName, this.#macOpenExecutable, this.#timeoutMs, result);
  }
}

function isCoreEditor(editor: EditorKind): editor is CoreEditorKind {
  return typeof editor === "string" && Object.hasOwn(macAppNames, editor);
}

async function canonicalDirectory(
  worktreePath: string,
): Promise<{ ok: true; path: string } | { ok: false; message: string }> {
  if (typeof worktreePath !== "string") {
    return { ok: false, message: "Worktree path must be a string." };
  }
  if (worktreePath.includes("\0")) {
    return { ok: false, message: "Worktree path must not contain NUL bytes." };
  }
  if (!isAbsolute(worktreePath)) {
    return { ok: false, message: "Worktree path must be an absolute local directory path." };
  }

  let canonicalPath: string;
  try {
    canonicalPath = await realpath(worktreePath);
  } catch (error) {
    const code = nodeErrorCode(error);
    if (code === "ENOENT" || code === "ENOTDIR") {
      return { ok: false, message: "Worktree path does not exist." };
    }
    return { ok: false, message: `Worktree path could not be resolved${errorCodeSuffix(error)}.` };
  }

  try {
    if (!(await stat(canonicalPath)).isDirectory()) {
      return { ok: false, message: "Worktree path must resolve to a directory." };
    }
  } catch (error) {
    return { ok: false, message: `Worktree path could not be inspected${errorCodeSuffix(error)}.` };
  }
  return { ok: true, path: canonicalPath };
}

function launchResult(
  appName: string,
  executable: string,
  timeoutMs: number,
  result: TrustedEditorLauncherResult,
): { ok: boolean; message: string } {
  if (result.timedOut) {
    return { ok: false, message: `${appName} launch failed: launcher timed out after ${timeoutMs} ms.` };
  }
  if (result.outputLimitExceeded) {
    return { ok: false, message: `${appName} launch failed: launcher output exceeded 64 KiB.` };
  }
  if (result.spawnError) {
    if (result.spawnError.code === "ENOENT") {
      return {
        ok: false,
        message: `${appName} launch failed: launcher is unavailable (${executable}). ${launcherRecovery}`,
      };
    }
    return {
      ok: false,
      message: `${appName} launch failed: launcher failed to start${codeSuffix(result.spawnError.code)}. ${launcherRecovery}`,
    };
  }
  if (result.signal) {
    return { ok: false, message: `${appName} launch failed: launcher terminated by signal ${result.signal}.` };
  }
  if (result.exitCode !== 0) {
    const detail = result.stderr.trim();
    return {
      ok: false,
      message: `${appName} launch failed: launcher exited with code ${result.exitCode}${detail ? `: ${detail}` : ""}. Check that ${appName} is installed in Applications and opens manually, then retry.`,
    };
  }
  return { ok: true, message: `Launch request accepted by ${appName}.` };
}

async function runEditorLauncher(
  executable: string,
  args: readonly string[],
  timeoutMs: number,
): Promise<TrustedEditorLauncherResult> {
  return new Promise((resolve) => {
    let spawnError: TrustedEditorLauncherError | null = null;
    let timedOut = false;
    let outputLimitExceeded = false;
    let outputBytes = 0;
    const stderrChunks: Buffer[] = [];
    let stderrBytes = 0;
    let child: ReturnType<typeof spawn>;

    try {
      child = spawn(executable, [...args], {
        shell: false,
        stdio: ["ignore", "pipe", "pipe"],
        windowsHide: true,
      });
    } catch (error) {
      resolve(failedSpawn(error));
      return;
    }

    const stopForOutput = (): void => {
      if (outputLimitExceeded) return;
      outputLimitExceeded = true;
      child.kill("SIGKILL");
    };
    child.stdout!.on("data", (chunk: Buffer) => {
      outputBytes += chunk.byteLength;
      if (outputBytes > maxLauncherOutputBytes) stopForOutput();
    });
    child.stderr!.on("data", (chunk: Buffer) => {
      outputBytes += chunk.byteLength;
      const remaining = maxLauncherOutputBytes - stderrBytes;
      if (remaining > 0) {
        const retained = chunk.subarray(0, remaining);
        stderrChunks.push(retained);
        stderrBytes += retained.byteLength;
      }
      if (outputBytes > maxLauncherOutputBytes) stopForOutput();
    });
    child.once("error", (error) => {
      spawnError = normalizeError(error);
    });
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill("SIGKILL");
    }, timeoutMs);
    timer.unref();
    child.once("close", (exitCode, signal) => {
      clearTimeout(timer);
      resolve({
        exitCode,
        signal,
        stderr: Buffer.concat(stderrChunks, stderrBytes).toString("utf8"),
        spawnError,
        timedOut,
        outputLimitExceeded,
      });
    });
  });
}

function failedSpawn(error: unknown): TrustedEditorLauncherResult {
  return {
    exitCode: null,
    signal: null,
    stderr: "",
    spawnError: normalizeError(error),
    timedOut: false,
    outputLimitExceeded: false,
  };
}

function normalizeError(error: unknown): TrustedEditorLauncherError {
  return {
    ...(nodeErrorCode(error) ? { code: nodeErrorCode(error) } : {}),
    message: error instanceof Error ? error.message : "Unknown launcher error",
  };
}

function nodeErrorCode(error: unknown): string | undefined {
  if (!error || typeof error !== "object" || !("code" in error)) return undefined;
  return typeof error.code === "string" ? error.code : undefined;
}

function errorCodeSuffix(error: unknown): string {
  return codeSuffix(nodeErrorCode(error));
}

function codeSuffix(code: string | undefined): string {
  return code ? ` (${code})` : "";
}

function validTimeout(value: number | undefined): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0 && value <= 30_000;
}
