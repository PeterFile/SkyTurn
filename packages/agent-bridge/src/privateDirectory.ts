import type { Stats } from "node:fs";
import type { FileHandle } from "node:fs/promises";
import { dirname, resolve } from "node:path";

export interface PrivateDirectoryFileSystem {
  mkdir(path: string, options: { mode: number }): Promise<unknown>;
  chmod(path: string, mode: number): Promise<void>;
  lstat(path: string): Promise<Stats>;
  open(path: string, flags: string | number, mode?: number): Promise<FileHandle>;
}

interface PrivateDirectoryOptions {
  mode: number;
  platform: NodeJS.Platform;
  fileSystem: PrivateDirectoryFileSystem;
  getUid: () => number | undefined;
  invalidMessage: string;
}

export async function ensureDurablePrivateDirectory(
  path: string,
  options: PrivateDirectoryOptions,
): Promise<void> {
  const target = resolve(path);
  const missing: string[] = [];
  let existing = target;
  for (;;) {
    const value = await lstatIfPresent(existing, options.fileSystem);
    if (value) {
      assertDirectory(value, options.invalidMessage);
      break;
    }
    missing.unshift(existing);
    const parent = dirname(existing);
    if (parent === existing) throw new Error(options.invalidMessage);
    existing = parent;
  }

  if (missing.length === 0) {
    await securePrivateDirectory(target, options);
    await syncDirectoryIfSupported(dirname(target), options.platform, options.fileSystem);
    return;
  }

  for (const component of missing) {
    try {
      await options.fileSystem.mkdir(component, { mode: options.mode });
    } catch (error) {
      if (errorCode(error) !== "EEXIST") throw error;
    }
    await securePrivateDirectory(component, options);
    await syncDirectoryIfSupported(dirname(component), options.platform, options.fileSystem);
  }
}

export async function syncDirectoryIfSupported(
  directory: string,
  platform: NodeJS.Platform,
  fileSystem: Pick<PrivateDirectoryFileSystem, "open">,
): Promise<void> {
  if (platform === "win32") return;
  let handle: FileHandle | null = null;
  try {
    handle = await fileSystem.open(directory, "r");
    await handle.sync();
  } catch (error) {
    if (!directorySyncUnsupported(error)) throw error;
  } finally {
    await handle?.close().catch(() => undefined);
  }
}

async function securePrivateDirectory(path: string, options: PrivateDirectoryOptions): Promise<void> {
  const before = await options.fileSystem.lstat(path);
  assertDirectory(before, options.invalidMessage);
  if (options.platform === "win32") return;
  assertOwner(before, options.getUid(), options.invalidMessage);
  await options.fileSystem.chmod(path, options.mode);
  const after = await options.fileSystem.lstat(path);
  assertDirectory(after, options.invalidMessage);
  assertOwner(after, options.getUid(), options.invalidMessage);
  if ((after.mode & 0o777) !== options.mode) throw new Error(options.invalidMessage);
}

async function lstatIfPresent(path: string, fileSystem: PrivateDirectoryFileSystem): Promise<Stats | null> {
  try {
    return await fileSystem.lstat(path);
  } catch (error) {
    if (errorCode(error) === "ENOENT") return null;
    throw error;
  }
}

function assertDirectory(value: Stats, message: string): void {
  if (!value.isDirectory() || value.isSymbolicLink()) throw new Error(message);
}

function assertOwner(value: Stats, expectedUid: number | undefined, message: string): void {
  if (expectedUid !== undefined && value.uid !== expectedUid) throw new Error(message);
}

function errorCode(error: unknown): string | null {
  return typeof error === "object" && error !== null && "code" in error && typeof error.code === "string"
    ? error.code
    : null;
}

function directorySyncUnsupported(error: unknown): boolean {
  return ["EBADF", "EINVAL", "EISDIR", "ENOSYS", "ENOTSUP", "EOPNOTSUPP"].includes(errorCode(error) ?? "");
}
