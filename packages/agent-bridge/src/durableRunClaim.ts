import { createHash } from "node:crypto";
import { constants as fsConstants, type Stats } from "node:fs";
import {
  chmod,
  lstat,
  mkdir,
  open,
  realpath,
  type FileHandle,
} from "node:fs/promises";
import { homedir } from "node:os";
import { basename, dirname, isAbsolute, join, relative, resolve } from "node:path";

import type { AgentKind } from "@skyturn/project-core";
import {
  ensureDurablePrivateDirectory,
  syncDirectoryIfSupported,
  type PrivateDirectoryFileSystem,
} from "./privateDirectory.js";

export interface DurableRunStartClaim {
  runId: string;
  nodeId: string;
  sessionId: string;
  agentKind: AgentKind;
  startFingerprint: string;
  startedAt: string;
}

export type DurableRunStartClaimRead =
  | { kind: "missing" }
  | { kind: "invalid" }
  | { kind: "valid"; claim: DurableRunStartClaim };

export interface DurableRunClaimFileSystem extends PrivateDirectoryFileSystem {
  realpath(path: string): Promise<string>;
}

export interface DurableRunClaimStoreOptions {
  root: string;
  platform?: NodeJS.Platform;
  fileSystem?: DurableRunClaimFileSystem;
  getUid?: () => number | undefined;
}

export interface DurableRunClaimStore {
  initialize(): Promise<void>;
  prepare(projectRoot: string, worktreePath?: string): Promise<void>;
  markerPath(projectRoot: string, runId: string): Promise<string>;
  runStatePath(projectRoot: string, runId: string, kind: "events"): Promise<string>;
  publish(projectRoot: string, claim: DurableRunStartClaim): Promise<"published" | "exists">;
  read(projectRoot: string, runId: string): Promise<DurableRunStartClaimRead>;
}

export class DurableRunClaimPublicationError extends Error {
  readonly owned: boolean;

  constructor(owned: boolean) {
    super("run-start-claim-publication-failed");
    this.name = "DurableRunClaimPublicationError";
    this.owned = owned;
  }
}

class DurableRunClaimBoundaryError extends Error {
  constructor() {
    super("run-start-claim-boundary-invalid");
    this.name = "DurableRunClaimBoundaryError";
  }
}

const claimFileMode = 0o600;
const claimDirectoryMode = 0o700;
const maxClaimBytes = 16_384;
const nodeFileSystem: DurableRunClaimFileSystem = { realpath, mkdir, chmod, lstat, open };

export function createDurableRunClaimStore(options: DurableRunClaimStoreOptions): DurableRunClaimStore {
  if (!isAbsolute(options.root)) throw new Error("Durable run claim root must be absolute.");
  const fileSystem = options.fileSystem ?? nodeFileSystem;
  const platform = options.platform ?? process.platform;
  const getUid = options.getUid ?? (() => process.getuid?.());
  return new FileDurableRunClaimStore(resolve(options.root), fileSystem, platform, getUid);
}

export function defaultDurableRunClaimRoot(
  env: NodeJS.ProcessEnv = process.env,
  platform: NodeJS.Platform = process.platform,
): string {
  const configured = env.SKYTURN_STATE_HOME;
  if (configured) {
    if (!isAbsolute(configured)) throw new Error("SKYTURN_STATE_HOME must be absolute.");
    return join(configured, "run-claims");
  }
  if (platform === "win32") {
    return join(env.LOCALAPPDATA ?? join(homedir(), "AppData", "Local"), "SkyTurn", "run-claims");
  }
  if (platform === "darwin") {
    return join(homedir(), "Library", "Application Support", "SkyTurn", "run-claims");
  }
  return join(env.XDG_STATE_HOME ?? join(homedir(), ".local", "state"), "skyturn", "run-claims");
}

class FileDurableRunClaimStore implements DurableRunClaimStore {
  private initialization: Promise<string> | null = null;

  constructor(
    private readonly root: string,
    private readonly fileSystem: DurableRunClaimFileSystem,
    private readonly platform: NodeJS.Platform,
    private readonly getUid: () => number | undefined,
  ) {}

  async initialize(): Promise<void> {
    await this.canonicalRoot();
  }

  async prepare(projectRoot: string, worktreePath = projectRoot): Promise<void> {
    await this.resolveBoundary(projectRoot, worktreePath);
  }

  async markerPath(projectRoot: string, runId: string): Promise<string> {
    const { markerPath } = await this.resolvePaths(projectRoot, runId);
    return markerPath;
  }

  async runStatePath(projectRoot: string, runId: string, kind: "events"): Promise<string> {
    const paths = await this.resolvePaths(projectRoot, runId);
    if (kind !== "events") throw new Error("Private run state kind is invalid.");
    return join(paths.directory, `${paths.runKey}.events.ndjson`);
  }

  async publish(projectRoot: string, claim: DurableRunStartClaim): Promise<"published" | "exists"> {
    const canonicalClaim = parseDurableRunStartClaim(claim);
    if (!canonicalClaim) throw new DurableRunClaimPublicationError(false);
    const bytes = Buffer.from(JSON.stringify(canonicalClaim), "utf8");
    if (bytes.byteLength === 0 || bytes.byteLength > maxClaimBytes) {
      throw new DurableRunClaimPublicationError(false);
    }
    let paths: ClaimPaths;
    try {
      paths = await this.resolvePaths(projectRoot, claim.runId);
    } catch {
      throw new DurableRunClaimPublicationError(false);
    }
    try {
      await this.ensurePrivateDirectory(paths.directory);
    } catch {
      throw new DurableRunClaimPublicationError(false);
    }

    let handle: FileHandle;
    try {
      handle = await this.fileSystem.open(paths.markerPath, "wx", claimFileMode);
    } catch (error) {
      if (errorCode(error) === "EEXIST") return "exists";
      throw new DurableRunClaimPublicationError(false);
    }

    let closed = false;
    try {
      await handle.writeFile(bytes);
      await handle.sync();
      await handle.close();
      closed = true;
      await syncDirectoryIfSupported(paths.directory, this.platform, this.fileSystem);
      return "published";
    } catch {
      if (!closed) await handle.close().catch(() => undefined);
      throw new DurableRunClaimPublicationError(true);
    }
  }

  async read(projectRoot: string, runId: string): Promise<DurableRunStartClaimRead> {
    let paths: ClaimPaths;
    try {
      paths = await this.resolvePaths(projectRoot, runId);
    } catch {
      return { kind: "invalid" };
    }
    let pathStat: Stats;
    try {
      pathStat = await this.fileSystem.lstat(paths.markerPath);
    } catch (error) {
      return errorCode(error) === "ENOENT" ? { kind: "missing" } : { kind: "invalid" };
    }
    if (!this.isPrivateRegularFile(pathStat)) return { kind: "invalid" };

    let handle: FileHandle | null = null;
    try {
      handle = await this.fileSystem.open(
        paths.markerPath,
        fsConstants.O_RDONLY | optionalFlag(fsConstants.O_NOFOLLOW),
      );
      const handleStat = await handle.stat();
      if (!this.isPrivateRegularFile(handleStat) || !sameFile(pathStat, handleStat)) return { kind: "invalid" };
      const bytes = await handle.readFile();
      if (bytes.byteLength === 0 || bytes.byteLength > maxClaimBytes || bytes.byteLength !== handleStat.size) {
        return { kind: "invalid" };
      }
      const text = bytes.toString("utf8");
      const value = parseDurableRunStartClaim(JSON.parse(text) as unknown);
      if (!value || value.runId !== runId || JSON.stringify(value) !== text) return { kind: "invalid" };
      return { kind: "valid", claim: value };
    } catch {
      return { kind: "invalid" };
    } finally {
      await handle?.close().catch(() => undefined);
    }
  }

  private async resolvePaths(projectRoot: string, runId: string): Promise<ClaimPaths> {
    if (!runId || /[\x00-\x1f\x7f]/.test(runId)) throw new Error("Run id is invalid.");
    const { canonicalProjectRoot, canonicalClaimRoot } = await this.resolveBoundary(projectRoot, projectRoot);
    const projectKey = canonicalSha256(["skyturn-project-claim-v1", canonicalProjectRoot]);
    const runKey = canonicalSha256(["skyturn-run-claim-v1", projectKey, runId]);
    const directory = join(canonicalClaimRoot, projectKey);
    return { directory, runKey, markerPath: join(directory, `${runKey}.json`) };
  }

  private async resolveBoundary(
    projectRoot: string,
    worktreePath: string,
  ): Promise<{ canonicalProjectRoot: string; canonicalClaimRoot: string }> {
    try {
      const [canonicalClaimRoot, canonicalProjectRoot, canonicalWorktreePath] = await Promise.all([
        this.canonicalRoot(),
        canonicalizePath(projectRoot, this.fileSystem),
        canonicalizePath(worktreePath, this.fileSystem),
      ]);
      if (
        pathsOverlap(canonicalClaimRoot, canonicalProjectRoot) ||
        pathsOverlap(canonicalClaimRoot, canonicalWorktreePath)
      ) throw new DurableRunClaimBoundaryError();
      return { canonicalProjectRoot, canonicalClaimRoot };
    } catch (error) {
      if (error instanceof DurableRunClaimBoundaryError) throw error;
      throw new DurableRunClaimBoundaryError();
    }
  }

  private canonicalRoot(): Promise<string> {
    if (!this.initialization) {
      const initialization = this.initializeRoot();
      this.initialization = initialization;
      void initialization.catch(() => {
        if (this.initialization === initialization) this.initialization = null;
      });
    }
    return this.initialization;
  }

  private async initializeRoot(): Promise<string> {
    try {
      await this.assertNoSymlinkedConfiguredComponents(this.root);
      const canonicalCandidate = await canonicalizePath(this.root, this.fileSystem);
      await this.ensurePrivateDirectory(canonicalCandidate);
      const canonicalRoot = await this.fileSystem.realpath(canonicalCandidate);
      await this.assertNoSymlinkedDirectoryComponents(canonicalRoot);
      return canonicalRoot;
    } catch (error) {
      if (error instanceof DurableRunClaimBoundaryError) throw error;
      throw new DurableRunClaimBoundaryError();
    }
  }

  private async assertNoSymlinkedConfiguredComponents(path: string): Promise<void> {
    const components: string[] = [];
    let component = path;
    for (;;) {
      components.unshift(component);
      const parent = dirname(component);
      if (parent === component) break;
      component = parent;
    }
    for (const value of components) {
      const stat = await this.fileSystem.lstat(value).catch((error: unknown) => {
        if (errorCode(error) === "ENOENT") return null;
        throw error;
      });
      if (!stat) continue;
      if (stat.isSymbolicLink()) {
        const rootOwnedPosixAlias = process.platform !== "win32" && stat.uid === 0;
        if (!rootOwnedPosixAlias) throw new DurableRunClaimBoundaryError();
        continue;
      }
      if (!stat.isDirectory()) throw new DurableRunClaimBoundaryError();
    }
  }

  private async ensurePrivateDirectory(path: string): Promise<void> {
    await ensureDurablePrivateDirectory(path, {
      mode: claimDirectoryMode,
      platform: this.platform,
      fileSystem: this.fileSystem,
      getUid: this.getUid,
      invalidMessage: "Durable claim directory is invalid.",
    });
  }

  private async assertNoSymlinkedDirectoryComponents(path: string): Promise<void> {
    let component = path;
    for (;;) {
      const value = await this.fileSystem.lstat(component);
      if (!value.isDirectory() || value.isSymbolicLink()) throw new DurableRunClaimBoundaryError();
      const parent = dirname(component);
      if (parent === component) return;
      component = parent;
    }
  }

  private isPrivateRegularFile(value: Stats): boolean {
    if (!value.isFile() || value.isSymbolicLink()) return false;
    if (value.size <= 0 || value.size > maxClaimBytes) return false;
    if (this.platform === "win32") return true;
    return this.hasExpectedOwner(value) && (value.mode & 0o777) === claimFileMode;
  }

  private hasExpectedOwner(value: Stats): boolean {
    const expectedUid = this.getUid();
    return expectedUid === undefined || value.uid === expectedUid;
  }

}

interface ClaimPaths {
  directory: string;
  runKey: string;
  markerPath: string;
}

async function canonicalizePath(path: string, fileSystem: DurableRunClaimFileSystem): Promise<string> {
  let candidate = resolve(path);
  const suffix: string[] = [];
  for (;;) {
    try {
      return resolve(await fileSystem.realpath(candidate), ...suffix);
    } catch (error) {
      if (errorCode(error) !== "ENOENT") throw error;
      const parent = dirname(candidate);
      if (parent === candidate) throw error;
      suffix.unshift(basename(candidate));
      candidate = parent;
    }
  }
}

function pathsOverlap(left: string, right: string): boolean {
  return sameOrInside(left, right) || sameOrInside(right, left);
}

function sameOrInside(candidate: string, parent: string): boolean {
  const path = relative(parent, candidate);
  return path === "" || (!path.startsWith("..") && !isAbsolute(path));
}

function parseDurableRunStartClaim(value: unknown): DurableRunStartClaim | null {
  if (!isRecord(value)) return null;
  const keys = Object.keys(value).sort();
  if (keys.join("\0") !== ["agentKind", "nodeId", "runId", "sessionId", "startFingerprint", "startedAt"].join("\0")) {
    return null;
  }
  if (
    typeof value.runId !== "string" || !value.runId ||
    typeof value.nodeId !== "string" || !value.nodeId ||
    typeof value.sessionId !== "string" || !value.sessionId ||
    !isAgentKind(value.agentKind) ||
    typeof value.startFingerprint !== "string" || !/^[a-f0-9]{64}$/.test(value.startFingerprint) ||
    typeof value.startedAt !== "string" || !Number.isFinite(Date.parse(value.startedAt))
  ) return null;
  return {
    runId: value.runId,
    nodeId: value.nodeId,
    sessionId: value.sessionId,
    agentKind: value.agentKind,
    startFingerprint: value.startFingerprint,
    startedAt: value.startedAt,
  };
}

function isAgentKind(value: unknown): value is AgentKind {
  return value === "hermes" || value === "codex" || value === "agy" || value === "gemini" ||
    value === "claude-code" || value === "openclaw";
}

function canonicalSha256(value: readonly string[]): string {
  return createHash("sha256").update(JSON.stringify(value), "utf8").digest("hex");
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

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
