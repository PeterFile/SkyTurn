import { spawn, type ChildProcess } from "node:child_process";
import { fileURLToPath } from "node:url";

export type BoundedFileReadError = "INVALID_INPUT" | "UNAVAILABLE" | "MISSING" | "UNSAFE_FILE" | "OVERSIZE" | "CHANGED";
export type BoundedFileReadResult = { ok: true; bytes: Buffer } | { ok: false; code: BoundedFileReadError };

export interface BoundedFileReadInput {
  /** Caller-owned, authorized directory descriptor. Keep it open until this promise settles. */
  rootFd: number;
  /** Caller must apply its own registration and sensitive-file policy before calling. */
  relativePath: string;
  maxBytes: number;
  signal?: AbortSignal;
}

/** POSIX-only descriptor-relative read. No path fallback, shell, or file writes. */
export async function readBoundedFile(input: BoundedFileReadInput): Promise<BoundedFileReadResult> {
  if (!input || !Number.isSafeInteger(input.rootFd) || input.rootFd < 0 ||
    typeof input.relativePath !== "string" || Buffer.byteLength(input.relativePath, "utf8") > 4096 ||
    /[\\\x00-\x1f\x7f]/.test(input.relativePath) ||
    input.relativePath.split("/").some((part) => !part || part === "." || part === "..") ||
    !Number.isSafeInteger(input.maxBytes) || input.maxBytes < 1 || input.maxBytes > 32 * 1024 * 1024) {
    return { ok: false, code: "INVALID_INPUT" };
  }
  if (process.platform === "win32" || input.signal?.aborted) return { ok: false, code: "UNAVAILABLE" };
  const helper = fileURLToPath(new URL("./native/artifact-gate", import.meta.url));
  return new Promise((resolve) => {
    let child: ChildProcess;
    try {
      child = spawn(helper, ["read", input.relativePath, String(input.maxBytes)], {
        stdio: ["pipe", "pipe", "ignore", input.rootFd],
      });
    } catch {
      resolve({ ok: false, code: "UNAVAILABLE" });
      return;
    }
    const output = Buffer.alloc(input.maxBytes + 128);
    let length = 0;
    let failed = false;
    let killIssued = false;
    const terminate = () => {
      failed = true;
      if (killIssued) return;
      killIssued = true;
      child.stdin!.destroy();
      try { child.kill("SIGKILL"); } catch {}
    };
    const timeout = setTimeout(terminate, 10_000);
    input.signal?.addEventListener("abort", terminate, { once: true });
    child.once("error", terminate);
    child.stdin!.on("error", () => { /* Early native rejection can close stdin. */ });
    child.stdout!.on("error", terminate);
    child.stdout!.on("data", (chunk: Buffer) => {
      if (failed) return;
      if (length + chunk.length > output.length) { terminate(); return; }
      chunk.copy(output, length);
      length += chunk.length;
    });
    // Neither exit nor a failed kill proves stdio completion or child reaping.
    child.once("close", (code, signal) => {
      clearTimeout(timeout);
      input.signal?.removeEventListener("abort", terminate);
      child.stdin!.destroy();
      if (failed || code !== 0 || signal || input.signal?.aborted) {
        resolve({ ok: false, code: "UNAVAILABLE" });
        return;
      }
      resolve(parseReadOutput(output.subarray(0, length), input.maxBytes));
    });
    if (input.signal?.aborted) terminate();
    if (!failed) child.stdin!.end("\n\n");
  });
}

function parseReadOutput(output: Buffer, limit: number): BoundedFileReadResult {
  const prefix = output.subarray(0, 128).toString("latin1");
  const failure = /^(?:READY\n)?(?:OPENED\n)?RESULT (missing|unsafe|oversize|changed)\n$/.exec(prefix);
  if (failure && output.length === Buffer.byteLength(failure[0])) {
    const codes = { missing: "MISSING", unsafe: "UNSAFE_FILE", oversize: "OVERSIZE", changed: "CHANGED" } as const;
    return { ok: false, code: codes[failure[1] as keyof typeof codes] };
  }
  const header = /^READY\nOPENED\nRESULT ok (0|[1-9][0-9]{0,7})\n/.exec(prefix);
  if (header) {
    const size = Number(header[1]);
    const offset = Buffer.byteLength(header[0]);
    if (size <= limit && output.length === offset + size) return { ok: true, bytes: output.subarray(offset) };
  }
  return { ok: false, code: "UNAVAILABLE" };
}
