import { constants as fsConstants } from "node:fs";
import { access, lstat, open, realpath, stat } from "node:fs/promises";
import { basename, dirname, isAbsolute, join } from "node:path";

export interface ResolveHermesCommandOptions {
  canonicalizeNonShimExecutable?: boolean;
  platform: NodeJS.Platform;
}

export interface HermesCommandExecutableIdentity {
  readonly launchPath: string;
  readonly launchDevice: string;
  readonly launchInode: string;
  readonly launchBirthtimeNs: string | null;
  readonly canonicalPath: string;
  readonly device: string;
  readonly inode: string;
  readonly birthtimeNs: string | null;
}

export interface ResolvedHermesCommand {
  readonly args: string[];
  readonly executablePath: string;
  readonly executableIdentity?: HermesCommandExecutableIdentity;
}

export async function resolveHermesCommand(
  executablePath: string,
  args: string[],
  options: ResolveHermesCommandOptions,
): Promise<ResolvedHermesCommand> {
  if (options.platform !== "darwin") {
    return {
      args,
      executablePath: options.canonicalizeNonShimExecutable
        ? await realpath(executablePath)
        : executablePath,
    };
  }

  const canonicalExecutablePath = await realpath(executablePath);
  if (
    !options.canonicalizeNonShimExecutable &&
    !(await stat(canonicalExecutablePath)).isFile()
  ) {
    return { args, executablePath };
  }
  const executable = await open(
    canonicalExecutablePath,
    fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW,
  );
  let prefix = "";
  try {
    const buffer = Buffer.alloc(512);
    const { bytesRead } = await executable.read(buffer, 0, buffer.length, 0);
    prefix = buffer.subarray(0, bytesRead).toString("utf8");
  } finally {
    await executable.close();
  }
  const interpreterName = (["python", "python3"] as const).find((candidate) => {
    const uvShimPrefix = [
      "#!/bin/sh",
      `'''exec' "$(dirname -- "$(realpath -- "$0")")"/'${candidate}' "$0" "$@"`,
      "' '''",
    ].join("\n");
    return prefix.startsWith(`${uvShimPrefix}\n`);
  });
  if (!interpreterName) {
    return {
      args,
      executablePath: options.canonicalizeNonShimExecutable
        ? canonicalExecutablePath
        : executablePath,
    };
  }

  const canonicalShimParent = dirname(canonicalExecutablePath);
  const interpreterPath = join(canonicalShimParent, interpreterName);
  const canonicalInterpreterPath = await realpath(interpreterPath);
  const executableIdentity = await resolveExecutableIdentity(interpreterPath, canonicalInterpreterPath);
  return {
    args: [canonicalExecutablePath, ...args],
    executablePath: interpreterPath,
    executableIdentity,
  };
}

export async function revalidateHermesCommandExecutable(
  expected: HermesCommandExecutableIdentity,
): Promise<string> {
  const canonicalPath = await realpath(expected.launchPath);
  if (canonicalPath !== expected.canonicalPath) {
    throw new Error("Hermes shim interpreter path identity changed.");
  }
  const current = await resolveExecutableIdentity(expected.launchPath, canonicalPath);
  if (
    current.launchDevice !== expected.launchDevice ||
    current.launchInode !== expected.launchInode ||
    current.launchBirthtimeNs !== expected.launchBirthtimeNs ||
    current.device !== expected.device ||
    current.inode !== expected.inode ||
    current.birthtimeNs !== expected.birthtimeNs
  ) {
    throw new Error("Hermes shim interpreter filesystem identity changed.");
  }
  return expected.launchPath;
}

async function resolveExecutableIdentity(
  launchPath: string,
  canonicalPath: string,
): Promise<HermesCommandExecutableIdentity> {
  const launchMetadata = await lstat(launchPath, { bigint: true });
  if (!launchMetadata.isFile() && !launchMetadata.isSymbolicLink()) {
    throw new Error("Hermes shim interpreter is not a file or symbolic link.");
  }
  const metadata = await stat(canonicalPath, { bigint: true });
  if (!metadata.isFile()) throw new Error("Hermes shim interpreter is not a regular file.");
  await access(launchPath, fsConstants.X_OK);
  if (dirname(canonicalPath) !== dirname(launchPath)) {
    await assertAttestedRelocatableVenvInterpreter(launchPath, canonicalPath, launchMetadata.uid, metadata.uid);
  }
  const launchBirthtimeNs = launchMetadata.birthtimeNs > 0n
    ? launchMetadata.birthtimeNs.toString()
    : null;
  const birthtimeNs = metadata.birthtimeNs > 0n ? metadata.birthtimeNs.toString() : null;
  if (launchMetadata.ino === 0n && launchBirthtimeNs === null) {
    throw new Error("Hermes shim interpreter launch path has no replacement-sensitive identity.");
  }
  if (metadata.ino === 0n && birthtimeNs === null) {
    throw new Error("Hermes shim interpreter has no replacement-sensitive identity.");
  }
  return Object.freeze({
    launchPath,
    launchDevice: launchMetadata.dev.toString(),
    launchInode: launchMetadata.ino.toString(),
    launchBirthtimeNs,
    canonicalPath,
    device: metadata.dev.toString(),
    inode: metadata.ino.toString(),
    birthtimeNs,
  });
}

async function assertAttestedRelocatableVenvInterpreter(
  launchPath: string,
  canonicalPath: string,
  launchOwner: bigint,
  interpreterOwner: bigint,
): Promise<void> {
  if (!/^python(?:3(?:\.\d+)*)?$/.test(basename(canonicalPath))) {
    throw new Error("Hermes shim interpreter target is not CPython.");
  }
  const configPath = join(dirname(dirname(launchPath)), "pyvenv.cfg");
  const config = await open(configPath, fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW);
  let source = "";
  try {
    const metadata = await config.stat({ bigint: true });
    if (!metadata.isFile() || metadata.size <= 0n || metadata.size > 4096n) {
      throw new Error("Hermes virtual environment metadata is invalid.");
    }
    if (metadata.uid !== launchOwner || metadata.uid !== interpreterOwner) {
      throw new Error("Hermes virtual environment ownership is inconsistent.");
    }
    const buffer = Buffer.alloc(Number(metadata.size));
    const { bytesRead } = await config.read(buffer, 0, buffer.length, 0);
    if (bytesRead !== buffer.length) throw new Error("Hermes virtual environment metadata is truncated.");
    source = new TextDecoder("utf-8", { fatal: true }).decode(buffer);
  } finally {
    await config.close();
  }
  const entries = new Map<string, string>();
  for (const line of source.split(/\r?\n/)) {
    if (!line) continue;
    const match = /^([a-z][a-z0-9_-]*) = ([^\u0000-\u001f\u007f]+)$/.exec(line);
    if (!match || entries.has(match[1])) {
      throw new Error("Hermes virtual environment metadata is malformed.");
    }
    entries.set(match[1], match[2]);
  }
  const home = entries.get("home");
  if (
    !home ||
    !isAbsolute(home) ||
    entries.get("implementation") !== "CPython" ||
    entries.get("include-system-site-packages") !== "false" ||
    await realpath(home) !== dirname(canonicalPath)
  ) {
    throw new Error("Hermes shim interpreter escaped its attested virtual environment.");
  }
}
