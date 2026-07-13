import { constants as fsConstants, type Stats } from "node:fs";
import { chmod, lstat, mkdir, open, type FileHandle } from "node:fs/promises";
import { dirname } from "node:path";

import { parseRunEvent, type RunEvent } from "@skyturn/project-core";
import type { DurableRunClaimStore } from "./durableRunClaim.js";
import {
  ensureDurablePrivateDirectory,
  syncDirectoryIfSupported,
  type PrivateDirectoryFileSystem,
} from "./privateDirectory.js";

export type PrivateRunEventRead =
  | { kind: "missing" }
  | { kind: "invalid" }
  | { kind: "valid"; events: RunEvent[] };

export interface PrivateRunEventStore {
  prepare(projectRoot: string, worktreePath?: string): Promise<void>;
  eventPath(projectRoot: string, runId: string): Promise<string>;
  append(projectRoot: string, event: RunEvent): Promise<"appended" | "exists">;
  read(projectRoot: string, runId: string): Promise<PrivateRunEventRead>;
}

export interface PrivateRunEventStoreOptions {
  durableRunClaimStore: DurableRunClaimStore;
  platform?: NodeJS.Platform;
  fileSystem?: PrivateRunEventFileSystem;
  getUid?: () => number | undefined;
}

export interface PrivateRunEventFileSystem extends PrivateDirectoryFileSystem {}

const eventFileMode = 0o600;
const eventDirectoryMode = 0o700;
const maxEventLogBytes = 64 * 1024 * 1024;
const nodeFileSystem: PrivateRunEventFileSystem = { chmod, lstat, mkdir, open };

export function createPrivateRunEventStore(options: PrivateRunEventStoreOptions): PrivateRunEventStore {
  return new FilePrivateRunEventStore(
    options.durableRunClaimStore,
    options.fileSystem ?? nodeFileSystem,
    options.platform ?? process.platform,
    options.getUid ?? (() => process.getuid?.()),
  );
}

class FilePrivateRunEventStore implements PrivateRunEventStore {
  private readonly appendQueues = new Map<string, Promise<void>>();

  constructor(
    private readonly durableRunClaimStore: DurableRunClaimStore,
    private readonly fileSystem: PrivateRunEventFileSystem,
    private readonly platform: NodeJS.Platform,
    private readonly getUid: () => number | undefined,
  ) {}

  async prepare(projectRoot: string, worktreePath = projectRoot): Promise<void> {
    await this.durableRunClaimStore.prepare(projectRoot, worktreePath);
  }

  eventPath(projectRoot: string, runId: string): Promise<string> {
    return this.durableRunClaimStore.runStatePath(projectRoot, runId, "events");
  }

  async append(projectRoot: string, candidate: RunEvent): Promise<"appended" | "exists"> {
    const event = parseRunEvent(candidate);
    if (!event || event.runId !== candidate.runId) throw new Error("Private RunEvent is invalid.");
    const path = await this.eventPath(projectRoot, event.runId);
    return this.withAppendLock(path, async () => {
      const existing = await this.read(projectRoot, event.runId);
      if (existing.kind === "invalid") throw new Error("Private run event state is invalid.");
      const events = existing.kind === "valid" ? existing.events : [];
      const sameSequence = events.find((item) => item.seq === event.seq);
      if (sameSequence) {
        if (JSON.stringify(sameSequence) === JSON.stringify(event)) {
          return "exists";
        }
        throw new Error("Private run event conflict.");
      }
      if (event.seq !== events.length + 1) throw new Error("Private run event sequence is invalid.");

      const directory = dirname(path);
      await this.ensurePrivateDirectory(directory);
      const existed = existing.kind !== "missing";
      let handle: FileHandle | null = null;
      try {
        handle = await this.fileSystem.open(
          path,
          fsConstants.O_WRONLY |
            fsConstants.O_APPEND |
            fsConstants.O_CREAT |
            optionalFlag(fsConstants.O_NOFOLLOW),
          eventFileMode,
        );
        await handle.chmod(eventFileMode);
        const before = await handle.stat();
        if (!this.isPrivateRegularFile(before, true)) throw new Error("Private run event file is invalid.");
        const bytes = Buffer.from(`${JSON.stringify(event)}\n`, "utf8");
        if (before.size + bytes.byteLength > maxEventLogBytes) throw new Error("Private run event log is too large.");
        const result = await handle.write(bytes);
        if (result.bytesWritten !== bytes.byteLength) throw new Error("Private run event append was incomplete.");
        await handle.sync();
      } finally {
        await handle?.close().catch(() => undefined);
      }
      if (!existed) await syncDirectoryIfSupported(directory, this.platform, this.fileSystem);
      return "appended";
    });
  }

  async read(projectRoot: string, runId: string): Promise<PrivateRunEventRead> {
    let path: string;
    try {
      path = await this.eventPath(projectRoot, runId);
    } catch {
      return { kind: "invalid" };
    }
    let pathStat: Stats;
    try {
      pathStat = await this.fileSystem.lstat(path);
    } catch (error) {
      return errorCode(error) === "ENOENT" ? { kind: "missing" } : { kind: "invalid" };
    }
    if (!this.isPrivateRegularFile(pathStat, false)) return { kind: "invalid" };

    let handle: FileHandle | null = null;
    try {
      handle = await this.fileSystem.open(path, fsConstants.O_RDWR | optionalFlag(fsConstants.O_NOFOLLOW));
      const handleStat = await handle.stat();
      if (!this.isPrivateRegularFile(handleStat, false) || !sameFile(pathStat, handleStat)) return { kind: "invalid" };
      const bytes = await handle.readFile();
      if (bytes.byteLength !== handleStat.size || bytes.byteLength > maxEventLogBytes) return { kind: "invalid" };
      await handle.sync();
      await syncDirectoryIfSupported(dirname(path), this.platform, this.fileSystem);
      const durableStat = await handle.stat();
      if (!this.isPrivateRegularFile(durableStat, false) || durableStat.size !== bytes.byteLength) {
        return { kind: "invalid" };
      }
      const text = bytes.toString("utf8");
      if (!text.endsWith("\n")) return { kind: "invalid" };
      const events = text.slice(0, -1).split("\n").map((line, index) => {
        const event = parseRunEvent(JSON.parse(line) as unknown);
        if (
          !event || event.runId !== runId || event.seq !== index + 1 ||
          JSON.stringify(event) !== line
        ) throw new Error("Private RunEvent is invalid.");
        return event;
      });
      return { kind: "valid", events };
    } catch {
      return { kind: "invalid" };
    } finally {
      await handle?.close().catch(() => undefined);
    }
  }

  private async ensurePrivateDirectory(path: string): Promise<void> {
    await ensureDurablePrivateDirectory(path, {
      mode: eventDirectoryMode,
      platform: this.platform,
      fileSystem: this.fileSystem,
      getUid: this.getUid,
      invalidMessage: "Private run event directory is invalid.",
    });
  }

  private isPrivateRegularFile(value: Stats, allowEmpty: boolean): boolean {
    if (!value.isFile() || value.isSymbolicLink()) return false;
    if ((!allowEmpty && value.size === 0) || value.size > maxEventLogBytes) return false;
    if (this.platform === "win32") return true;
    return this.hasExpectedOwner(value) && (value.mode & 0o777) === eventFileMode;
  }

  private hasExpectedOwner(value: Stats): boolean {
    const expectedUid = this.getUid();
    return expectedUid === undefined || value.uid === expectedUid;
  }

  private async withAppendLock<T>(path: string, operation: () => Promise<T>): Promise<T> {
    const previous = this.appendQueues.get(path) ?? Promise.resolve();
    let release!: () => void;
    const current = new Promise<void>((resolve) => {
      release = resolve;
    });
    const tail = previous.then(() => current);
    this.appendQueues.set(path, tail);
    await previous;
    try {
      return await operation();
    } finally {
      release();
      if (this.appendQueues.get(path) === tail) this.appendQueues.delete(path);
    }
  }
}

function sameFile(left: Stats, right: Stats): boolean {
  if (left.dev === 0 && left.ino === 0 && right.dev === 0 && right.ino === 0) return true;
  return left.dev === right.dev && left.ino === right.ino;
}

function optionalFlag(flag: number | undefined): number {
  return flag ?? 0;
}

function errorCode(error: unknown): string | null {
  return typeof error === "object" && error !== null && "code" in error && typeof error.code === "string"
    ? error.code
    : null;
}
