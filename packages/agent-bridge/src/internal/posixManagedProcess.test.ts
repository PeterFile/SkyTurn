import { spawn, spawnSync } from "node:child_process";
import { constants as fsConstants } from "node:fs";
import { chmod, mkdir, mkdtemp, open, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { afterEach, describe, expect, it } from "vitest";

import { spawnPosixManagedProcess } from "./posixManagedProcess.js";

const posixIt = process.platform === "win32" ? it.skip : it;
const roots: string[] = [];
const pids = new Set<number>();

afterEach(async () => {
  for (const pid of pids) killPid(pid);
  pids.clear();
  await Promise.all(roots.splice(0).map((root) => rm(root, { force: true, recursive: true })));
});

describe("POSIX managed process ownership", () => {
  it("includes dist without a redundant owner-helper package entry", async () => {
    const packageJson = JSON.parse(await readFile(
      new URL("../../package.json", import.meta.url),
      "utf8",
    ));

    expect(packageJson.files).toContain("dist");
    expect(packageJson.files).not.toContain("dist/native/posix-process-owner");
  });

  posixIt("copies the executable owner helper into the published dist package", async () => {
    const packageRoot = fileURLToPath(new URL("../../", import.meta.url));
    const buildScript = fileURLToPath(new URL("../../scripts/buildArtifactGate.mjs", import.meta.url));
    const built = spawnSync(process.execPath, [buildScript, "--copy-dist"], {
      cwd: packageRoot,
      encoding: "utf8",
    });
    expect(built.status, built.stderr).toBe(0);

    const helper = await stat(join(packageRoot, "dist/native/posix-process-owner"));
    expect(helper.isFile()).toBe(true);
    expect(helper.size).toBeGreaterThan(0);
    expect(helper.mode & 0o111).not.toBe(0);

    const packed = spawnSync("pnpm", ["pack", "--dry-run", "--json"], {
      cwd: packageRoot,
      encoding: "utf8",
    });
    expect(packed.status, packed.stderr).toBe(0);
    const packedFiles = JSON.parse(packed.stdout).files.map(({ path }: { path: string }) => path);
    expect(packedFiles).toContain("dist/native/posix-process-owner");
  });

  posixIt("kills a stubborn process tree when a separate Node owner dies", async () => {
    const root = await makeRoot(true);
    const parentPidPath = join(root, "parent.pid");
    const childPidPath = join(root, "child.pid");
    const childReadyPath = join(root, "child.ready");
    const helperPidPath = join(root, "helper.pid");
    const ownerReadyPath = join(root, "owner.ready");
    const heartbeatPath = join(root, "heartbeat.log");
    const targetPath = join(root, "codex");
    await writeExecutable(targetPath, stubbornTreeScript());

    const fixturePath = fileURLToPath(new URL("../../scripts/posixOwnerDeathFixture.mjs", import.meta.url));
    const owner = spawn(process.execPath, [fixturePath, root, targetPath, "150"], {
      detached: false,
      env: {
        ...process.env,
        SKYTURN_PARENT_PID_PATH: parentPidPath,
        SKYTURN_CHILD_PID_PATH: childPidPath,
        SKYTURN_CHILD_READY_PATH: childReadyPath,
        SKYTURN_HEARTBEAT_PATH: heartbeatPath,
        SKYTURN_HELPER_PID_PATH: helperPidPath,
        SKYTURN_OWNER_READY_PATH: ownerReadyPath,
      },
      shell: false,
      stdio: "ignore",
    });
    if (!owner.pid) throw new Error("Owner fixture did not start.");
    pids.add(owner.pid);

    const [parentPid, childPid, helperPid] = await Promise.all([
      waitForPid(parentPidPath),
      waitForPid(childPidPath),
      waitForPid(helperPidPath),
      waitForFile(childReadyPath),
      waitForFile(ownerReadyPath),
    ]).then(([parent, child, helper]) => [parent, child, helper]);
    pids.add(parentPid);
    pids.add(childPid);
    pids.add(helperPid);

    process.kill(owner.pid, "SIGKILL");
    await waitForPidGone(owner.pid, "Node owner");
    pids.delete(owner.pid);
    await Promise.all([
      waitForPidGone(parentPid, "managed root"),
      waitForPidGone(childPid, "managed descendant"),
      waitForPidGone(helperPid, "POSIX owner helper"),
    ]);
    pids.delete(parentPid);
    pids.delete(childPid);
    pids.delete(helperPid);

    const heartbeatSize = (await stat(heartbeatPath)).size;
    await delay(200);
    expect((await stat(heartbeatPath)).size).toBe(heartbeatSize);
  }, 15_000);

  posixIt("joins repeated termination at one escalation and waits for reap and stdio completion", async () => {
    const root = await makeRoot(true);
    const worktree = await openDirectory(root);
    const parentPidPath = join(root, "parent.pid");
    const childPidPath = join(root, "child.pid");
    const childReadyPath = join(root, "child.ready");
    const rootTermPath = join(root, "root-term.log");
    const childTermPath = join(root, "child-term.log");
    let output = "";
    let errorOutput = "";

    try {
      const managed = await spawnPosixManagedProcess({
        agentKind: "codex",
        args: ["-e", stubbornInlineTreeScript()],
        cleanupTimeoutMs: 200,
        env: {
          ...process.env,
          SKYTURN_PARENT_PID_PATH: parentPidPath,
          SKYTURN_CHILD_PID_PATH: childPidPath,
          SKYTURN_CHILD_READY_PATH: childReadyPath,
          SKYTURN_ROOT_TERM_PATH: rootTermPath,
          SKYTURN_CHILD_TERM_PATH: childTermPath,
        },
        executablePath: process.execPath,
        platform: process.platform,
        sandbox: "danger-full-access",
        worktreeFd: worktree.fd,
      });
      await managed.ready;
      managed.child.stdout?.on("data", (chunk: Buffer | string) => {
        output += chunk.toString();
      });
      managed.child.stderr?.on("data", (chunk: Buffer | string) => {
        errorOutput += chunk.toString();
      });
      const parentPid = await waitForPid(parentPidPath);
      const childPid = await waitForPid(childPidPath);
      await waitForFile(childReadyPath);
      pids.add(parentPid);
      pids.add(childPid);

      let settled = false;
      const first = managed.terminateAndReap().finally(() => {
        settled = true;
      });
      const second = managed.terminateAndReap();
      const third = managed.terminateAndReap();
      expect(second).toBe(third);
      await delay(75);
      expect(settled).toBe(false);

      await Promise.all([first, second, third, managed.closed]);
      await Promise.all([
        waitForPidGone(parentPid, "managed root"),
        waitForPidGone(childPid, "managed descendant"),
      ]);
      pids.delete(parentPid);
      pids.delete(childPid);
      expect((await readFile(rootTermPath, "utf8")).trim().split("\n")).toHaveLength(1);
      expect((await readFile(childTermPath, "utf8")).trim().split("\n")).toHaveLength(1);

      const completedOutput = output;
      const completedErrorOutput = errorOutput;
      await delay(100);
      expect(output).toBe(completedOutput);
      expect(errorOutput).toBe(completedErrorOutput);
      expect(completedOutput).toContain("root-ready\n");
      expect(completedOutput).toContain("child-ready\n");
      expect(completedErrorOutput).toContain("root-error-ready\n");
      expect(completedErrorOutput).toContain("child-error-ready\n");
    } finally {
      await worktree.close();
    }
  }, 15_000);

  posixIt("cleans a stubborn descendant after natural root exit and preserves root evidence", async () => {
    const root = await makeRoot(true);
    const worktree = await openDirectory(root);
    const childPidPath = join(root, "child.pid");
    const childReadyPath = join(root, "child.ready");

    try {
      const managed = await spawnPosixManagedProcess({
        agentKind: "codex",
        args: ["-e", naturalExitWithStubbornChildScript()],
        cleanupTimeoutMs: 150,
        env: {
          ...process.env,
          SKYTURN_CHILD_PID_PATH: childPidPath,
          SKYTURN_CHILD_READY_PATH: childReadyPath,
        },
        executablePath: process.execPath,
        platform: process.platform,
        sandbox: "danger-full-access",
        worktreeFd: worktree.fd,
      });
      await managed.ready;
      const childPid = await waitForPid(childPidPath);
      await waitForFile(childReadyPath);
      pids.add(childPid);

      const result = await managed.closed;

      expect(result).toEqual({ exitCode: 23, signalCode: null });
      await waitForPidGone(childPid, "natural-exit descendant");
      pids.delete(childPid);
    } finally {
      await worktree.close();
    }
  }, 15_000);

  posixIt("fails a malformed control protocol only after the owned tree is empty", async () => {
    const root = await makeRoot(true);
    const worktree = await openDirectory(root);
    const parentPidPath = join(root, "protocol-parent.pid");
    const childPidPath = join(root, "protocol-child.pid");
    const childReadyPath = join(root, "protocol-child.ready");
    const heartbeatPath = join(root, "protocol-heartbeat.log");
    const targetPath = join(root, "codex");
    await writeExecutable(targetPath, stubbornTreeScript());
    const ownerPath = fileURLToPath(new URL("../native/posix-process-owner", import.meta.url));
    const fdLaunchPath = fileURLToPath(new URL("../native/fd-launch", import.meta.url));
    let protocol = "";

    try {
      const owner = spawn(ownerPath, ["100", fdLaunchPath, "--require-git", targetPath], {
        detached: true,
        env: {
          ...process.env,
          SKYTURN_PARENT_PID_PATH: parentPidPath,
          SKYTURN_CHILD_PID_PATH: childPidPath,
          SKYTURN_CHILD_READY_PATH: childReadyPath,
          SKYTURN_HEARTBEAT_PATH: heartbeatPath,
        },
        shell: false,
        stdio: ["pipe", "pipe", "pipe", worktree.fd, "pipe"],
      });
      if (!owner.pid || !owner.stdin || !owner.stdio[4]) throw new Error("Raw owner did not start.");
      pids.add(owner.pid);
      owner.stdout?.resume();
      owner.stderr?.resume();
      owner.stdio[4].setEncoding("utf8");
      owner.stdio[4].on("data", (chunk: Buffer | string) => {
        protocol += chunk.toString();
      });
      const ownerClose = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolve) => {
        owner.once("close", (code, signal) => resolve({ code, signal }));
      });

      const parentPid = await waitForPid(parentPidPath);
      const childPid = await waitForPid(childPidPath);
      await waitForFile(childReadyPath);
      await waitForCondition(() => protocol.startsWith("R "), "owner readiness");
      pids.add(parentPid);
      pids.add(childPid);

      owner.stdin.write("invalid\n");
      const result = await ownerClose;
      pids.delete(owner.pid);
      expect(result).toEqual({ code: 70, signal: null });
      expect(protocol).toMatch(/^R [1-9][0-9]*\nF\n$/);
      await Promise.all([
        waitForPidGone(parentPid, "protocol-failure root"),
        waitForPidGone(childPid, "protocol-failure descendant"),
      ]);
      pids.delete(parentPid);
      pids.delete(childPid);
    } finally {
      await worktree.close();
    }
  }, 15_000);

  posixIt("rejects readiness when retained git identity is invalid before fd-launch exec", async () => {
    const projectRoot = await makeRoot(false);
    const worktreePath = join(projectRoot, "worktree");
    const retainedPath = join(projectRoot, "retained-worktree");
    const targetStartedPath = join(projectRoot, "target-started");
    await mkdir(join(worktreePath, ".git"), { recursive: true });
    const worktree = await openDirectory(worktreePath);

    try {
      await rename(worktreePath, retainedPath);
      await rm(join(retainedPath, ".git"), { recursive: true });
      await mkdir(join(worktreePath, ".git"), { recursive: true });

      const managed = await spawnPosixManagedProcess({
        agentKind: "codex",
        args: ["-e", "require('node:fs').writeFileSync(process.env.SKYTURN_TARGET_STARTED_PATH, 'started')"],
        cleanupTimeoutMs: 100,
        env: { ...process.env, SKYTURN_TARGET_STARTED_PATH: targetStartedPath },
        executablePath: process.execPath,
        platform: process.platform,
        sandbox: "danger-full-access",
        worktreeFd: worktree.fd,
      });
      await expect(managed.ready).rejects.toThrow("POSIX managed process owner is unavailable.");
      await expect(managed.terminateAndReap()).resolves.toBeUndefined();
      await expect(stat(targetStartedPath)).rejects.toMatchObject({ code: "ENOENT" });
    } finally {
      await worktree.close();
    }
  }, 15_000);
});

async function makeRoot(git: boolean): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "skyturn-posix-owner-"));
  roots.push(root);
  if (git) await mkdir(join(root, ".git"));
  return root;
}

async function openDirectory(path: string) {
  return open(path, fsConstants.O_RDONLY | fsConstants.O_DIRECTORY | fsConstants.O_NOFOLLOW);
}

async function writeExecutable(path: string, source: string): Promise<void> {
  await writeFile(path, source);
  await chmod(path, 0o755);
}

function stubbornTreeScript(): string {
  const child = [
    "const fs = require('node:fs');",
    "process.on('SIGTERM', () => {});",
    "fs.writeFileSync(process.env.SKYTURN_CHILD_READY_PATH, 'ready');",
    "setInterval(() => fs.appendFileSync(process.env.SKYTURN_HEARTBEAT_PATH, 'c'), 20);",
  ].join("\n");
  return [
    "#!/usr/bin/env node",
    "const fs = require('node:fs');",
    "const { spawn } = require('node:child_process');",
    "fs.writeFileSync(process.env.SKYTURN_PARENT_PID_PATH, String(process.pid));",
    `const child = spawn(process.execPath, ['-e', ${JSON.stringify(child)}], { env: process.env, stdio: 'ignore' });`,
    "fs.writeFileSync(process.env.SKYTURN_CHILD_PID_PATH, String(child.pid));",
    "process.on('SIGTERM', () => {});",
    "setInterval(() => fs.appendFileSync(process.env.SKYTURN_HEARTBEAT_PATH, 'r'), 20);",
  ].join("\n");
}

function stubbornInlineTreeScript(): string {
  const child = [
    "const fs = require('node:fs');",
    "process.on('SIGTERM', () => fs.appendFileSync(process.env.SKYTURN_CHILD_TERM_PATH, 'term\\n'));",
    "fs.writeFileSync(process.env.SKYTURN_CHILD_READY_PATH, 'ready');",
    "process.stdout.write('child-ready\\n');",
    "process.stderr.write('child-error-ready\\n');",
    "setInterval(() => process.stdout.write('child-tick\\n'), 20);",
    "setInterval(() => process.stderr.write('child-error-tick\\n'), 20);",
  ].join("\n");
  return [
    "const fs = require('node:fs');",
    "const { spawn } = require('node:child_process');",
    "fs.writeFileSync(process.env.SKYTURN_PARENT_PID_PATH, String(process.pid));",
    `const child = spawn(process.execPath, ['-e', ${JSON.stringify(child)}], { env: process.env, stdio: ['ignore', 'inherit', 'inherit'] });`,
    "fs.writeFileSync(process.env.SKYTURN_CHILD_PID_PATH, String(child.pid));",
    "process.on('SIGTERM', () => fs.appendFileSync(process.env.SKYTURN_ROOT_TERM_PATH, 'term\\n'));",
    "process.stdout.write('root-ready\\n');",
    "process.stderr.write('root-error-ready\\n');",
    "setInterval(() => process.stdout.write('root-tick\\n'), 20);",
    "setInterval(() => process.stderr.write('root-error-tick\\n'), 20);",
  ].join("\n");
}

function naturalExitWithStubbornChildScript(): string {
  const child = [
    "const fs = require('node:fs');",
    "process.on('SIGTERM', () => {});",
    "fs.writeFileSync(process.env.SKYTURN_CHILD_READY_PATH, 'ready');",
    "setInterval(() => {}, 1000);",
  ].join("\n");
  return [
    "const fs = require('node:fs');",
    "const { spawn } = require('node:child_process');",
    `const child = spawn(process.execPath, ['-e', ${JSON.stringify(child)}], { env: process.env, stdio: ['ignore', 'inherit', 'inherit'] });`,
    "fs.writeFileSync(process.env.SKYTURN_CHILD_PID_PATH, String(child.pid));",
    "const timer = setInterval(() => {",
    "  if (!fs.existsSync(process.env.SKYTURN_CHILD_READY_PATH)) return;",
    "  clearInterval(timer);",
    "  process.exit(23);",
    "}, 5);",
  ].join("\n");
}

async function waitForPid(path: string): Promise<number> {
  const pid = Number(await waitForFile(path));
  if (!Number.isSafeInteger(pid) || pid <= 0) throw new Error(`Invalid PID in ${path}.`);
  return pid;
}

async function waitForFile(path: string): Promise<string> {
  const deadline = Date.now() + 5_000;
  for (;;) {
    try {
      return await readFile(path, "utf8");
    } catch {
      if (Date.now() >= deadline) throw new Error(`Timed out waiting for ${path}.`);
      await delay(20);
    }
  }
}

async function waitForPidGone(pid: number, label: string): Promise<void> {
  const deadline = Date.now() + 5_000;
  while (isPidAlive(pid)) {
    if (Date.now() >= deadline) throw new Error(`${label} ${pid} remained alive.`);
    await delay(20);
  }
}

async function waitForCondition(predicate: () => boolean, label: string): Promise<void> {
  const deadline = Date.now() + 5_000;
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error(`Timed out waiting for ${label}.`);
    await delay(20);
  }
}

function isPidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return !(typeof error === "object" && error !== null && "code" in error && error.code === "ESRCH");
  }
}

function killPid(pid: number): void {
  try {
    process.kill(pid, "SIGKILL");
  } catch {
    // Already gone.
  }
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
