import { chmod, mkdir, mkdtemp, realpath, rm, stat, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { resolveHermesCommand } from "./resolveHermesCommand.js";

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { force: true, recursive: true })));
});

describe("resolveHermesCommand", () => {
  it.each(["python", "python3"] as const)(
    "returns the canonical regular executable identity for a strict %s uv shim",
    async (interpreterName) => {
      const root = await makeRoot("skyturn-hermes-command-");
      const hermesPath = join(root, "hermes");
      const interpreterPath = join(root, interpreterName);
      await writeUvShim(hermesPath, interpreterName);
      await writeFile(interpreterPath, "interpreter", { mode: 0o755 });

      const resolved = await resolveHermesCommand(hermesPath, ["chat"], {
        canonicalizeNonShimExecutable: true,
        platform: "darwin",
      });
      const canonicalInterpreter = await realpath(interpreterPath);
      const metadata = await stat(canonicalInterpreter, { bigint: true });

      expect(resolved).toMatchObject({
        args: [await realpath(hermesPath), "chat"],
        executablePath: canonicalInterpreter,
        executableIdentity: {
          canonicalPath: canonicalInterpreter,
          device: metadata.dev.toString(),
          inode: metadata.ino.toString(),
          birthtimeNs: metadata.birthtimeNs > 0n ? metadata.birthtimeNs.toString() : null,
        },
      });
    },
  );

  it("rejects a sibling interpreter symlink whose canonical target escapes the shim directory", async () => {
    const shimRoot = await makeRoot("skyturn-hermes-command-shim-");
    const outsideRoot = await makeRoot("skyturn-hermes-command-outside-");
    const hermesPath = join(shimRoot, "hermes");
    const outsideInterpreter = join(outsideRoot, "python");
    await writeUvShim(hermesPath, "python");
    await writeFile(outsideInterpreter, "outside interpreter", { mode: 0o755 });
    await symlink(outsideInterpreter, join(shimRoot, "python"), "file");

    await expect(resolveHermesCommand(hermesPath, [], {
      canonicalizeNonShimExecutable: true,
      platform: "darwin",
    })).rejects.toThrow();
  });

  it("accepts a relocatable uv venv interpreter attested by strict pyvenv metadata", async () => {
    const venvRoot = await makeRoot("skyturn-hermes-command-venv-");
    const binaryRoot = join(venvRoot, "bin");
    const runtimeRoot = await makeRoot("skyturn-hermes-command-runtime-");
    const runtimeBin = join(runtimeRoot, "bin");
    await mkdir(binaryRoot);
    await mkdir(runtimeBin);
    const hermesPath = join(binaryRoot, "hermes");
    const interpreterPath = join(binaryRoot, "python");
    const canonicalInterpreter = join(runtimeBin, "python3.11");
    await writeUvShim(hermesPath, "python");
    await writeFile(canonicalInterpreter, "interpreter", { mode: 0o755 });
    await symlink(canonicalInterpreter, interpreterPath, "file");
    await writeFile(join(venvRoot, "pyvenv.cfg"), [
      `home = ${runtimeBin}`,
      "implementation = CPython",
      "version_info = 3.11",
      "include-system-site-packages = false",
      "relocatable = true",
      "",
    ].join("\n"));

    const resolved = await resolveHermesCommand(hermesPath, [], {
      canonicalizeNonShimExecutable: true,
      platform: "darwin",
    });

    const canonicalLaunchPath = join(dirname(await realpath(hermesPath)), "python");
    expect(resolved.executablePath).toBe(canonicalLaunchPath);
    expect(resolved.executableIdentity).toMatchObject({
      launchPath: canonicalLaunchPath,
      canonicalPath: await realpath(canonicalInterpreter),
    });
  });

  it("rejects an executable sibling interpreter that is not a regular file", async () => {
    const root = await makeRoot("skyturn-hermes-command-directory-");
    const hermesPath = join(root, "hermes");
    const interpreterPath = join(root, "python3");
    await writeUvShim(hermesPath, "python3");
    await mkdir(interpreterPath, { mode: 0o755 });
    await chmod(interpreterPath, 0o755);

    await expect(resolveHermesCommand(hermesPath, [], {
      canonicalizeNonShimExecutable: true,
      platform: "darwin",
    })).rejects.toThrow();
  });
});

async function makeRoot(prefix: string): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), prefix));
  roots.push(root);
  return root;
}

async function writeUvShim(path: string, interpreterName: "python" | "python3"): Promise<void> {
  await writeFile(path, [
    "#!/bin/sh",
    `'''exec' "$(dirname -- "$(realpath -- "$0")")"/'${interpreterName}' "$0" "$@"`,
    "' '''",
    "from hermes_cli.main import main",
  ].join("\n"), { mode: 0o755 });
}
