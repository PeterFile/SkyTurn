import { chmod, mkdir, mkdtemp, readFile, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
  NodeEditorAdapter,
  type TrustedEditorLauncher,
  type TrustedEditorLauncherResult,
} from "./node.js";
import type { EditorKind } from "./index.js";

const tempRoots: string[] = [];

afterEach(async () => {
  await Promise.all(tempRoots.splice(0).map((root) => rm(root, { force: true, recursive: true })));
});

async function createDirectory(name = "worktree"): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "skyturn-editor-"));
  tempRoots.push(root);
  const directory = join(root, name);
  await mkdir(directory);
  return directory;
}

function successfulLaunch(): TrustedEditorLauncherResult {
  return { exitCode: 0, signal: null, stderr: "", spawnError: null, timedOut: false, outputLimitExceeded: false };
}

async function createLauncher(source: string): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "skyturn-editor-launcher-"));
  tempRoots.push(root);
  const launcher = join(root, "launcher.mjs");
  await writeFile(launcher, `#!${process.execPath}\n${source}\n`, "utf8");
  await chmod(launcher, 0o700);
  return launcher;
}

describe("NodeEditorAdapter", () => {
  it("uses fixed macOS app names and passes the worktree as one argv element", async () => {
    const worktree = await createDirectory();
    const canonicalWorktree = await realpath(worktree);
    const calls: Array<{ file: string; args: readonly string[] }> = [];
    const runLauncher: TrustedEditorLauncher = async (file, args) => {
      calls.push({ file, args });
      return successfulLaunch();
    };
    const adapter = new NodeEditorAdapter({ platform: "darwin", runLauncher });

    await expect(adapter.openWorktree("vscode", worktree)).resolves.toEqual({
      ok: true,
      message: "Launch request accepted by Visual Studio Code.",
    });
    await adapter.openWorktree("cursor", worktree);
    await adapter.openWorktree("zed", worktree);

    expect(calls).toEqual([
      { file: "/usr/bin/open", args: ["-a", "Visual Studio Code", canonicalWorktree] },
      { file: "/usr/bin/open", args: ["-a", "Cursor", canonicalWorktree] },
      { file: "/usr/bin/open", args: ["-a", "Zed", canonicalWorktree] },
    ]);
  });

  it("rejects unsupported editors and platforms without launching", async () => {
    const worktree = await createDirectory();
    const calls: string[] = [];
    const runLauncher: TrustedEditorLauncher = async (file) => {
      calls.push(file);
      return successfulLaunch();
    };
    const macAdapter = new NodeEditorAdapter({ platform: "darwin", runLauncher });

    const unsupported: EditorKind[] = ["antigravity", "finder", "terminal", "iterm2", "xcode"];
    for (const editor of unsupported) {
      const result = await macAdapter.openWorktree(editor, worktree);
      expect(result).toEqual({
        ok: false,
        message: `Editor "${editor}" is not supported. Supported editors: vscode, cursor, zed.`,
      });
    }
    for (const platform of ["linux", "win32"] as const) {
      await expect(new NodeEditorAdapter({ platform, runLauncher }).openWorktree("vscode", worktree)).resolves.toEqual({
        ok: false,
        message: `Editor launching is not supported on platform "${platform}".`,
      });
    }
    expect(calls).toEqual([]);
  });

  it("canonicalizes a symlink and preserves every legal path character exactly", async () => {
    const targetName = " worktree '\"$&;[]\n雪 ";
    const target = await createDirectory(targetName);
    const canonicalTarget = await realpath(target);
    const root = join(target, "..");
    const link = join(root, "linked-worktree");
    const output = join(root, "argv.json");
    await symlink(target, link, "dir");
    const launcher = await createLauncher(
      `import { writeFileSync } from "node:fs";\nwriteFileSync(${JSON.stringify(output)}, JSON.stringify(process.argv.slice(2)));`,
    );
    const adapter = new NodeEditorAdapter({
      platform: "darwin",
      macOpenExecutable: launcher,
    });

    await expect(adapter.openWorktree("cursor", link)).resolves.toEqual({
      ok: true,
      message: "Launch request accepted by Cursor.",
    });

    const recorded = JSON.parse(await readFile(output, "utf8"));
    expect(basename(canonicalTarget)).toBe(targetName);
    expect(recorded).toEqual(["-a", "Cursor", canonicalTarget]);
  });

  it("rejects invalid, missing, non-directory, NUL, and URI targets without launching", async () => {
    const directory = await createDirectory();
    const file = join(directory, "file.txt");
    await writeFile(file, "not a directory", "utf8");
    let launches = 0;
    const runLauncher: TrustedEditorLauncher = async () => {
      launches += 1;
      return successfulLaunch();
    };
    const adapter = new NodeEditorAdapter({ platform: "darwin", runLauncher });
    const cases: Array<{ path: string; message: string }> = [
      { path: "relative/worktree", message: "Worktree path must be an absolute local directory path." },
      { path: "file:///tmp/worktree", message: "Worktree path must be an absolute local directory path." },
      { path: `${directory}\0tail`, message: "Worktree path must not contain NUL bytes." },
      { path: join(directory, "missing"), message: "Worktree path does not exist." },
      { path: file, message: "Worktree path must resolve to a directory." },
    ];

    for (const testCase of cases) {
      await expect(adapter.openWorktree("vscode", testCase.path)).resolves.toEqual({
        ok: false,
        message: testCase.message,
      });
    }
    await expect(adapter.openWorktree("vscode", null as unknown as string)).resolves.toEqual({
      ok: false,
      message: "Worktree path must be a string.",
    });
    expect(launches).toBe(0);
  });

  it("reports a missing launcher and a missing app truthfully", async () => {
    const worktree = await createDirectory();
    const missingLauncher = join(worktree, "missing-open");
    const adapter = new NodeEditorAdapter({
      platform: "darwin",
      macOpenExecutable: missingLauncher,
    });

    await expect(adapter.openWorktree("zed", worktree)).resolves.toEqual({
      ok: false,
      message: `Zed launch failed: launcher is unavailable (${missingLauncher}). Check the configured launcher path and macOS system open availability, then retry.`,
    });

    const missingApp: TrustedEditorLauncher = async () => ({
      ...successfulLaunch(),
      exitCode: 1,
      stderr: "Unable to find application named 'Zed'",
    });
    await expect(new NodeEditorAdapter({ platform: "darwin", runLauncher: missingApp })
      .openWorktree("zed", worktree)).resolves.toEqual({
      ok: false,
      message: "Zed launch failed: launcher exited with code 1: Unable to find application named 'Zed'. Check that Zed is installed in Applications and opens manually, then retry.",
    });
  });

  it.each([
    {
      name: "nonzero exit",
      source: 'process.stderr.write("fixture failure\\n"); process.exit(23);',
      timeoutMs: 1_000,
      expected: "Visual Studio Code launch failed: launcher exited with code 23: fixture failure. Check that Visual Studio Code is installed in Applications and opens manually, then retry.",
    },
    {
      name: "signal",
      source: 'process.kill(process.pid, "SIGTERM");',
      timeoutMs: 1_000,
      expected: "Visual Studio Code launch failed: launcher terminated by signal SIGTERM.",
    },
    {
      name: "timeout",
      source: "setInterval(() => {}, 1_000);",
      timeoutMs: 50,
      expected: "Visual Studio Code launch failed: launcher timed out after 50 ms.",
    },
    {
      name: "output overflow",
      source: 'process.stdout.write("x".repeat(65 * 1024));',
      timeoutMs: 1_000,
      expected: "Visual Studio Code launch failed: launcher output exceeded 64 KiB.",
    },
  ])("awaits the real launcher and reports $name", async ({ source, timeoutMs, expected }) => {
    const worktree = await createDirectory();
    const launcher = await createLauncher(source);
    const adapter = new NodeEditorAdapter({
      platform: "darwin",
      macOpenExecutable: launcher,
      timeoutMs,
    });

    await expect(adapter.openWorktree("vscode", worktree)).resolves.toEqual({
      ok: false,
      message: expected,
    });
  });
});
