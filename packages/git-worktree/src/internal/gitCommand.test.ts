import { readFileSync } from "node:fs";
import { access, chmod, copyFile, link, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { sanitizedGitEnvironment, spawnBoundedGit } from "./gitCommand.js";

const tempRoots: string[] = [];

describe("sanitizedGitEnvironment", () => {
  it("preserves ordinary and allowlisted compatibility variables while removing Git semantic redirects", () => {
    const environment = sanitizedGitEnvironment({
      PATH: "/safe/bin",
      HOME: "/safe/home",
      SystemRoot: "C:\\Windows",
      SKYTURN_TEST_VALUE: "ordinary",
      GIT_AUTHOR_NAME: "SkyTurn Author",
      GIT_AUTHOR_EMAIL: "author@example.test",
      GIT_COMMITTER_NAME: "SkyTurn Committer",
      GIT_COMMITTER_EMAIL: "committer@example.test",
      GIT_ASKPASS: "/safe/askpass",
      GIT_SSH_COMMAND: "ssh -F /safe/ssh-config",
      GIT_TERMINAL_PROMPT: "0",
      GIT_HTTP_LOW_SPEED_LIMIT: "128",
      GIT_LFS_SKIP_SMUDGE: "1",
      GIT_OPTIONAL_LOCKS: "0",
      GIT_DIR: "/hostile/repository",
      GIT_WORK_TREE: "/hostile/worktree",
      GIT_INDEX_FILE: "/hostile/index",
      GIT_OBJECT_DIRECTORY: "/hostile/objects",
      GIT_CONFIG_COUNT: "1",
      GIT_CONFIG_KEY_0: "core.hooksPath",
      GIT_CONFIG_VALUE_0: "/hostile/hooks",
      Git_Alternate_Object_Directories: "/hostile/alternates",
      git_no_replace_objects: "1",
      GIT_FUTURE_REDIRECT: "/hostile/future",
    });

    expect(environment).toMatchObject({
      PATH: "/safe/bin",
      HOME: "/safe/home",
      SystemRoot: "C:\\Windows",
      SKYTURN_TEST_VALUE: "ordinary",
      GIT_AUTHOR_NAME: "SkyTurn Author",
      GIT_AUTHOR_EMAIL: "author@example.test",
      GIT_COMMITTER_NAME: "SkyTurn Committer",
      GIT_COMMITTER_EMAIL: "committer@example.test",
      GIT_ASKPASS: "/safe/askpass",
      GIT_SSH_COMMAND: "ssh -F /safe/ssh-config",
      GIT_TERMINAL_PROMPT: "0",
      GIT_HTTP_LOW_SPEED_LIMIT: "128",
      GIT_LFS_SKIP_SMUDGE: "1",
      GIT_OPTIONAL_LOCKS: "0",
    });
    expect(Object.keys(environment).filter((name) => /^git_/i.test(name)).sort()).toEqual([
      "GIT_ASKPASS",
      "GIT_AUTHOR_EMAIL",
      "GIT_AUTHOR_NAME",
      "GIT_COMMITTER_EMAIL",
      "GIT_COMMITTER_NAME",
      "GIT_HTTP_LOW_SPEED_LIMIT",
      "GIT_LFS_SKIP_SMUDGE",
      "GIT_OPTIONAL_LOCKS",
      "GIT_SSH_COMMAND",
      "GIT_TERMINAL_PROMPT",
    ]);
  });

  it("removes lower and mixed-case Git names on POSIX instead of activating them", () => {
    const environment = sanitizedGitEnvironment({
      GIT_SSH_COMMAND: "exact transport",
      git_author_name: "lower identity",
      Git_Optional_Locks: "mixed compatibility",
      git_lfs_skip_smudge: "lower compatibility",
      Git_Dir: "/hostile/repository",
    }, "linux");

    expect(environment).toEqual({ GIT_SSH_COMMAND: "exact transport" });
  });

  it("canonicalizes Windows allowlisted aliases deterministically and prefers exact uppercase", () => {
    const first = sanitizedGitEnvironment({
      git_optional_locks: "lower compatibility",
      Git_Optional_Locks: "mixed compatibility",
      git_ssh_command: "lower transport",
      GIT_SSH_COMMAND: "exact transport",
      Git_Dir: "/hostile/repository",
      GIT_FUTURE_REDIRECT: "/hostile/future",
    }, "win32");
    const reversed = sanitizedGitEnvironment({
      GIT_FUTURE_REDIRECT: "/hostile/future",
      Git_Dir: "/hostile/repository",
      GIT_SSH_COMMAND: "exact transport",
      git_ssh_command: "lower transport",
      Git_Optional_Locks: "mixed compatibility",
      git_optional_locks: "lower compatibility",
    }, "win32");

    expect(first).toEqual(reversed);
    expect(first).toEqual({
      GIT_OPTIONAL_LOCKS: "mixed compatibility",
      GIT_SSH_COMMAND: "exact transport",
    });
  });
});

describe("spawnBoundedGit", () => {
  afterEach(async () => {
    await Promise.all(tempRoots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
  });

  it("treats output exactly equal to each byte cap as complete", async () => {
    const fixture = await installGitFixture();

    const result = await withFixturePath(fixture, () => spawnBoundedGit(
      fixture.tempRoot,
      ["exact", "4"],
      { stdoutMaxBytes: 4, stderrMaxBytes: 4 },
    ));

    expect(result).toMatchObject({
      stdout: Buffer.from("oooo"),
      stderr: Buffer.from("eeee"),
      stdoutTruncated: false,
      stderrTruncated: false,
      exitCode: 0,
      signal: null,
      spawnError: null,
      terminationRequested: false,
    });
  });

  it("terminates once on a split stdout cap plus one byte and waits for actual close", async () => {
    const fixture = await installGitFixture();
    let settled = false;
    const execution = withFixturePath(fixture, () => spawnBoundedGit(
      fixture.tempRoot,
      ["stdout-overflow", "4", fixture.signalPath, fixture.readyPath, fixture.releasePath],
      { stdoutMaxBytes: 4, stderrMaxBytes: 4 },
    ));
    void execution.then(
      () => { settled = true; },
      () => { settled = true; },
    );

    await waitForPath(fixture.readyPath);
    expect(settled).toBe(false);
    expect(readFileSync(fixture.signalPath, "utf8")).toBe("SIGTERM\n");
    await writeFile(fixture.releasePath, "release\n", "utf8");

    const result = await execution;
    expect(result.stdout).toEqual(Buffer.from("oooo"));
    expect(result.stdout.byteLength).toBe(4);
    expect(result.stdoutTruncated).toBe(true);
    expect(result.stderrTruncated).toBe(true);
    expect(result.terminationRequested).toBe(true);
    expect(readFileSync(fixture.signalPath, "utf8")).toBe("SIGTERM\n");
  });

  it("marks stderr overflow only after the terminated child is reaped", async () => {
    const fixture = await installGitFixture();
    let settled = false;
    const execution = withFixturePath(fixture, () => spawnBoundedGit(
      fixture.tempRoot,
      ["stderr-overflow", "4", fixture.signalPath, fixture.readyPath, fixture.releasePath],
      { stdoutMaxBytes: 8, stderrMaxBytes: 4 },
    ));
    void execution.then(
      () => { settled = true; },
      () => { settled = true; },
    );

    await waitForPath(fixture.readyPath);
    expect(settled).toBe(false);
    await writeFile(fixture.releasePath, "release\n", "utf8");

    const result = await execution;
    expect(result.stderr).toEqual(Buffer.from("eeee"));
    expect(result.stderrTruncated).toBe(true);
    expect(result.terminationRequested).toBe(true);
    expect(readFileSync(fixture.signalPath, "utf8")).toBe("SIGTERM\n");
  });

  it("reports spawn failure through a closed structured result", async () => {
    const tempRoot = await mkdtemp(join(tmpdir(), "skyturn-missing-git-"));
    tempRoots.push(tempRoot);
    const previousPath = process.env.PATH;
    process.env.PATH = tempRoot;
    try {
      const result = await spawnBoundedGit(tempRoot, ["status"], {
        stdoutMaxBytes: 4,
        stderrMaxBytes: 4,
      });
      expect(result.spawnError).toMatchObject({ code: "ENOENT" });
      expect(result.exitCode).toBe(-2);
      expect(result.stdout).toEqual(Buffer.alloc(0));
      expect(result.stderr).toEqual(Buffer.alloc(0));
    } finally {
      if (previousPath === undefined) delete process.env.PATH;
      else process.env.PATH = previousPath;
    }
  });

  it("preserves raw NUL and invalid UTF-8 bytes on stdout and stderr", async () => {
    const fixture = await installGitFixture();

    const result = await withFixturePath(fixture, () => spawnBoundedGit(
      fixture.tempRoot,
      ["raw-bytes", "8"],
      { stdoutMaxBytes: 8, stderrMaxBytes: 8 },
    ));

    expect(result.stdout).toEqual(Buffer.from([0x00, 0xff, 0xc3, 0x28, 0x41]));
    expect(result.stderr).toEqual(Buffer.from([0x80, 0x00, 0xfe, 0x42]));
    expect(result.stdoutTruncated).toBe(false);
    expect(result.stderrTruncated).toBe(false);
    expect(result.exitCode).toBe(0);
  });
});

async function installGitFixture(): Promise<{
  tempRoot: string;
  binDir: string;
  signalPath: string;
  readyPath: string;
  releasePath: string;
  nodeOptions: string | undefined;
}> {
  const tempRoot = await mkdtemp(join(tmpdir(), "skyturn-bounded-git-"));
  tempRoots.push(tempRoot);
  const binDir = join(tempRoot, "bin");
  const signalPath = join(tempRoot, "signal.txt");
  const readyPath = join(tempRoot, "ready.txt");
  const releasePath = join(tempRoot, "release.txt");
  await mkdir(binDir, { recursive: true });
  const scriptBody = `
const { appendFileSync, existsSync, writeFileSync } = require("node:fs");
const { basename } = require("node:path");

const [rawMode, rawLimit, signalPath, readyPath, releasePath] = process.argv.slice(ARGUMENT_OFFSET);
const mode = basename(rawMode);
const limit = Number(rawLimit);

function holdForTermination(writeOverflow) {
  process.on("SIGTERM", () => {
    appendFileSync(signalPath, "SIGTERM\\n");
    writeOverflow?.();
    setImmediate(() => writeFileSync(readyPath, "ready\\n"));
    const release = setInterval(() => {
      if (!existsSync(releasePath)) return;
      clearInterval(release);
      process.exit(0);
    }, 1);
    setTimeout(() => process.exit(3), 10_000).unref();
  });
}

if (mode === "exact") {
  process.stdout.write(Buffer.alloc(limit, "o"));
  process.stderr.write(Buffer.alloc(limit, "e"));
} else if (mode === "raw-bytes") {
  process.stdout.write(Buffer.from([0x00, 0xff, 0xc3, 0x28, 0x41]));
  process.stderr.write(Buffer.from([0x80, 0x00, 0xfe, 0x42]));
} else if (mode === "stdout-overflow") {
  holdForTermination(() => process.stderr.write(Buffer.alloc(limit + 1, "e")));
  process.stdout.write(Buffer.alloc(limit, "o"), () => {
    setImmediate(() => process.stdout.write("x"));
  });
  setInterval(() => {}, 1_000);
} else if (mode === "stderr-overflow") {
  holdForTermination();
  process.stderr.write(Buffer.alloc(limit, "e"), () => {
    setImmediate(() => process.stderr.write("x"));
  });
  setInterval(() => {}, 1_000);
} else {
  process.exitCode = 2;
}
`;
  let nodeOptions: string | undefined;
  if (process.platform === "win32") {
    const gitPath = join(binDir, "git.exe");
    try {
      await link(process.execPath, gitPath);
    } catch {
      await copyFile(process.execPath, gitPath);
    }
    const bootstrapName = "git-bootstrap.cjs";
    await writeFile(join(tempRoot, bootstrapName), [
      "const Module = require(\"node:module\");",
      "Module.runMain = () => {};",
      scriptBody.replace("ARGUMENT_OFFSET", "1"),
    ].join("\n"), "utf8");
    nodeOptions = `--require=./${bootstrapName}`;
  } else {
    const gitPath = join(binDir, "git");
    await writeFile(gitPath, `#!/usr/bin/env node\n${scriptBody.replace("ARGUMENT_OFFSET", "2")}`, "utf8");
    await chmod(gitPath, 0o755);
  }
  return { tempRoot, binDir, signalPath, readyPath, releasePath, nodeOptions };
}

async function withFixturePath<T>(
  fixture: { binDir: string; nodeOptions: string | undefined },
  callback: () => Promise<T>,
): Promise<T> {
  const previousPath = process.env.PATH;
  const previousNodeOptions = process.env.NODE_OPTIONS;
  process.env.PATH = `${fixture.binDir}${process.env.PATH ? `${process.platform === "win32" ? ";" : ":"}${process.env.PATH}` : ""}`;
  if (fixture.nodeOptions === undefined) delete process.env.NODE_OPTIONS;
  else process.env.NODE_OPTIONS = fixture.nodeOptions;
  try {
    return await callback();
  } finally {
    if (previousPath === undefined) delete process.env.PATH;
    else process.env.PATH = previousPath;
    if (previousNodeOptions === undefined) delete process.env.NODE_OPTIONS;
    else process.env.NODE_OPTIONS = previousNodeOptions;
  }
}

async function waitForPath(targetPath: string): Promise<void> {
  const deadline = Date.now() + 4_000;
  while (Date.now() < deadline) {
    try {
      await access(targetPath);
      return;
    } catch {
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
  }
  throw new Error(`Timed out waiting for ${targetPath}.`);
}
