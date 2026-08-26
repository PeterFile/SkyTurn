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

interface AppendCursor {
  eventCount: number;
  latestRecordBytes: number;
  latestRecordOffset: number;
  stat: EventFileStat;
}

interface EventFileStat {
  birthtimeMs: number;
  ctimeMs: number;
  dev: number;
  ino: number;
  mode: number;
  mtimeMs: number;
  size: number;
  uid: number;
}

type InspectedRunEventLog =
  | { kind: "missing" }
  | { kind: "invalid" }
  | { kind: "valid"; cursor: AppendCursor; events: RunEvent[] };

type AppendState =
  | { kind: "missing" }
  | { kind: "invalid" }
  | { kind: "valid"; cursor: AppendCursor };

const eventFileMode = 0o600;
const eventDirectoryMode = 0o700;
const maxEventLogBytes = 64 * 1024 * 1024;
const maxAppendCursors = 64;
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
  private readonly appendCursors = new Map<string, AppendCursor>();
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
      let existing = await this.appendState(path, event.runId);
      if (existing.kind === "invalid") throw new Error("Private run event state is invalid.");
      const serializedEvent = JSON.stringify(event);
      if (existing.kind === "valid" && event.seq <= existing.cursor.eventCount) {
        const current = await this.currentRecord(path, event.runId, event.seq, existing.cursor);
        if (current.kind !== "valid") throw new Error("Private run event state is invalid.");
        existing = { kind: "valid", cursor: current.cursor };
        if (current.record !== undefined) {
          if (current.record === serializedEvent) {
            return "exists";
          }
          throw new Error("Private run event conflict.");
        }
      }
      const eventCount = existing.kind === "valid" ? existing.cursor.eventCount : 0;
      if (event.seq !== eventCount + 1) throw new Error("Private run event sequence is invalid.");

      const directory = dirname(path);
      await this.ensurePrivateDirectory(directory);
      const existed = existing.kind !== "missing";
      let handle: FileHandle | null = null;
      let durableStat: Stats;
      let latestRecordOffset: number;
      const bytes = Buffer.from(`${serializedEvent}\n`, "utf8");
      try {
        handle = await this.fileSystem.open(
          path,
          fsConstants.O_WRONLY |
            fsConstants.O_APPEND |
            fsConstants.O_CREAT |
            optionalFlag(fsConstants.O_NOFOLLOW),
          eventFileMode,
        );
        const opened = await handle.stat();
        if (
          existed &&
          (existing.kind !== "valid" || !this.matchesCursor(existing.cursor, opened))
        ) throw new Error("Private run event state is invalid.");
        await handle.chmod(eventFileMode);
        const before = await handle.stat();
        if (!this.isPrivateRegularFile(before, true)) throw new Error("Private run event file is invalid.");
        if (before.size + bytes.byteLength > maxEventLogBytes) throw new Error("Private run event log is too large.");
        latestRecordOffset = before.size;
        const result = await handle.write(bytes);
        if (result.bytesWritten !== bytes.byteLength) throw new Error("Private run event append was incomplete.");
        await handle.sync();
        durableStat = await handle.stat();
        if (
          !this.isPrivateRegularFile(durableStat, false) ||
          !sameFile(before, durableStat) ||
          durableStat.size !== before.size + bytes.byteLength
        ) throw new Error("Private run event append was incomplete.");
      } catch (error) {
        this.appendCursors.delete(path);
        throw error;
      } finally {
        await handle?.close().catch(() => undefined);
      }
      try {
        if (!existed) await syncDirectoryIfSupported(directory, this.platform, this.fileSystem);
      } catch (error) {
        this.appendCursors.delete(path);
        throw error;
      }
      this.rememberCursor(path, {
        eventCount: event.seq,
        latestRecordBytes: bytes.byteLength,
        latestRecordOffset,
        stat: eventFileStat(durableStat),
      });
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
    const inspected = await this.inspect(path, runId);
    return inspected.kind === "valid"
      ? { kind: "valid", events: inspected.events }
      : inspected;
  }

  private async appendState(path: string, runId: string): Promise<AppendState> {
    const cursor = this.appendCursors.get(path);
    if (cursor) {
      if (await this.resyncCursor(path, cursor)) {
        this.rememberCursor(path, cursor);
        return { kind: "valid", cursor };
      }
      this.appendCursors.delete(path);
    }

    const inspected = await this.inspect(path, runId);
    if (inspected.kind !== "valid") return inspected;
    this.rememberCursor(path, inspected.cursor);
    return { kind: "valid", cursor: inspected.cursor };
  }

  private async currentRecord(
    path: string,
    runId: string,
    sequence: number,
    cursor: AppendCursor,
  ): Promise<{ kind: "invalid" } | { kind: "valid"; cursor: AppendCursor; record?: string }> {
    if (sequence === cursor.eventCount) {
      const latestRecord = await this.readLatestRecord(path, runId, cursor);
      if (latestRecord !== null) return { kind: "valid", cursor, record: latestRecord };
      this.appendCursors.delete(path);
    }

    const inspected = await this.inspect(path, runId);
    if (inspected.kind !== "valid") return { kind: "invalid" };
    this.rememberCursor(path, inspected.cursor);
    const event = inspected.events[sequence - 1];
    return {
      kind: "valid",
      cursor: inspected.cursor,
      ...(event ? { record: JSON.stringify(event) } : {}),
    };
  }

  private async readLatestRecord(path: string, runId: string, cursor: AppendCursor): Promise<string | null> {
    let handle: FileHandle | null = null;
    try {
      handle = await this.fileSystem.open(path, fsConstants.O_RDONLY | optionalFlag(fsConstants.O_NOFOLLOW));
      const before = await handle.stat();
      if (
        !this.isPrivateRegularFile(before, false) ||
        !this.matchesCursor(cursor, before) ||
        cursor.latestRecordOffset + cursor.latestRecordBytes !== before.size
      ) return null;
      const bytes = Buffer.alloc(cursor.latestRecordBytes);
      let offset = 0;
      while (offset < bytes.byteLength) {
        const result = await handle.read(
          bytes,
          offset,
          bytes.byteLength - offset,
          cursor.latestRecordOffset + offset,
        );
        if (result.bytesRead === 0) return null;
        offset += result.bytesRead;
      }
      const after = await handle.stat();
      if (!this.isPrivateRegularFile(after, false) || !this.matchesCursor(cursor, after)) return null;
      const record = bytes.toString("utf8");
      if (!record.endsWith("\n")) return null;
      const line = record.slice(0, -1);
      const event = parseRunEvent(JSON.parse(line) as unknown);
      return event &&
        event.runId === runId &&
        event.seq === cursor.eventCount &&
        JSON.stringify(event) === line
        ? line
        : null;
    } catch {
      return null;
    } finally {
      await handle?.close().catch(() => undefined);
    }
  }

  private rememberCursor(path: string, cursor: AppendCursor): void {
    this.appendCursors.delete(path);
    this.appendCursors.set(path, cursor);
    if (this.appendCursors.size <= maxAppendCursors) return;
    const leastRecentlyUsed = this.appendCursors.keys().next().value as string | undefined;
    if (leastRecentlyUsed !== undefined) this.appendCursors.delete(leastRecentlyUsed);
  }

  private async inspect(path: string, runId: string): Promise<InspectedRunEventLog> {
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
      const records = text.slice(0, -1).split("\n");
      const events = records.map((line, index) => {
        const event = parseRunEvent(JSON.parse(line) as unknown);
        if (
          !event || event.runId !== runId || event.seq !== index + 1 ||
          JSON.stringify(event) !== line
        ) throw new Error("Private RunEvent is invalid.");
        return event;
      });
      const latestRecord = records[records.length - 1]!;
      const latestRecordBytes = Buffer.byteLength(`${latestRecord}\n`);
      return {
        kind: "valid",
        cursor: {
          eventCount: records.length,
          latestRecordBytes,
          latestRecordOffset: bytes.byteLength - latestRecordBytes,
          stat: eventFileStat(durableStat),
        },
        events,
      };
    } catch {
      return { kind: "invalid" };
    } finally {
      await handle?.close().catch(() => undefined);
    }
  }

  private async resyncCursor(path: string, cursor: AppendCursor): Promise<boolean> {
    let handle: FileHandle | null = null;
    try {
      let pathStat: Stats;
      try {
        pathStat = await this.fileSystem.lstat(path);
      } catch {
        return false;
      }
      if (!this.isPrivateRegularFile(pathStat, false) || !this.matchesCursor(cursor, pathStat)) {
        return false;
      }
      handle = await this.fileSystem.open(path, fsConstants.O_RDWR | optionalFlag(fsConstants.O_NOFOLLOW));
      const handleStat = await handle.stat();
      if (
        !this.isPrivateRegularFile(handleStat, false) ||
        !sameFile(pathStat, handleStat) ||
        !this.matchesCursor(cursor, handleStat)
      ) return false;
      await handle.sync();
      await syncDirectoryIfSupported(dirname(path), this.platform, this.fileSystem);
      const durableStat = await handle.stat();
      if (!this.isPrivateRegularFile(durableStat, false) || !this.matchesCursor(cursor, durableStat)) {
        return false;
      }
      cursor.stat = eventFileStat(durableStat);
      return true;
    } catch {
      this.appendCursors.delete(path);
      throw new Error("Private run event state is invalid.");
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

  private matchesCursor(cursor: AppendCursor, value: Stats): boolean {
    const expected = cursor.stat;
    return sameFile(expected, value) &&
      expected.size === value.size &&
      expected.mode === value.mode &&
      expected.uid === value.uid &&
      expected.birthtimeMs === value.birthtimeMs &&
      expected.mtimeMs === value.mtimeMs &&
      expected.ctimeMs === value.ctimeMs;
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

function eventFileStat(value: Stats): EventFileStat {
  return {
    birthtimeMs: value.birthtimeMs,
    ctimeMs: value.ctimeMs,
    dev: value.dev,
    ino: value.ino,
    mode: value.mode,
    mtimeMs: value.mtimeMs,
    size: value.size,
    uid: value.uid,
  };
}

function sameFile(left: Pick<Stats, "dev" | "ino">, right: Pick<Stats, "dev" | "ino">): boolean {
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
