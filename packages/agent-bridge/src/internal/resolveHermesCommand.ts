import { constants as fsConstants } from "node:fs";
import { access, open, realpath, stat } from "node:fs/promises";
import { dirname, join } from "node:path";

export interface ResolveHermesCommandOptions {
  canonicalizeNonShimExecutable?: boolean;
  platform: NodeJS.Platform;
}

export async function resolveHermesCommand(
  executablePath: string,
  args: string[],
  options: ResolveHermesCommandOptions,
): Promise<{ args: string[]; executablePath: string }> {
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

  const interpreterPath = join(dirname(canonicalExecutablePath), interpreterName);
  await access(interpreterPath, fsConstants.X_OK);
  return {
    args: [canonicalExecutablePath, ...args],
    executablePath: interpreterPath,
  };
}
