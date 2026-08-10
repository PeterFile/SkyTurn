import { spawn, spawnSync } from "node:child_process";
import { constants as fsConstants } from "node:fs";
import { chmod, copyFile, mkdir, mkdtemp, open, readFile, readdir, rename, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { afterEach, describe, expect, it } from "vitest";

import { spawnPosixManagedProcess } from "./posixManagedProcess.js";

const posixIt = process.platform === "win32" ? it.skip : it;
const darwinIt = process.platform === "darwin" ? it : it.skip;
const roots: string[] = [];
const pids = new Set<number>();
const nativeHelperNames = ["artifact-gate", "fd-launch", "posix-process-owner"] as const;

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

  posixIt("keeps published helpers executable until a complete rebuild is atomically published", async () => {
    const fixture = await makeNativeBuildFixture();
    const readyPath = join(fixture.root, "compiler.ready");
    const releasePath = join(fixture.root, "compiler.release");
    const compilerPath = join(fixture.root, "fake-cc");
    await writeExecutable(compilerPath, fakeCompilerScript("pause", readyPath, releasePath));

    const build = spawn(process.execPath, [fixture.buildScript, "--copy-dist"], {
      cwd: fixture.root,
      env: { ...process.env, CC: compilerPath },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stderr = "";
    build.stderr?.on("data", (chunk: Buffer | string) => {
      stderr += chunk.toString();
    });

    const closed = waitForChildClose(build);
    await waitForFile(readyPath);
    try {
      for (const helper of nativeHelperNames) {
        const published = join(fixture.nativeRoot, helper);
        expect(await readFile(published, "utf8")).toBe(nativeHelperScript("old", helper));
        const executed = spawnSync(published, { encoding: "utf8" });
        expect(executed.status, executed.stderr).toBe(0);
        expect(executed.stdout).toBe(`old:${helper}`);
      }
    } finally {
      await writeFile(releasePath, "release");
      await closed;
    }

    const result = await closed;
    expect(result, stderr).toEqual({ code: 0, signal: null });
    for (const helper of nativeHelperNames) {
      const source = join(fixture.nativeRoot, helper);
      const dist = join(fixture.root, "dist/native", helper);
      expect(await readFile(source, "utf8")).toBe(nativeHelperScript("new", helper));
      expect(await readFile(dist, "utf8")).toBe(await readFile(source, "utf8"));
      expect((await stat(source)).mode & 0o111).not.toBe(0);
      expect((await stat(dist)).mode & 0o111).not.toBe(0);
    }
    await expectOnlyFixtureNativeFiles(fixture.nativeRoot);
  });

  posixIt.each([
    ["compiler", "fail"],
    ["chmod", "dangling"],
  ] as const)("preserves published helpers and cleans temporary output after %s failure", async (_stage, mode) => {
    const fixture = await makeNativeBuildFixture();
    const compilerPath = join(fixture.root, "fake-cc");
    await writeExecutable(compilerPath, fakeCompilerScript(mode));

    const built = spawnSync(process.execPath, [fixture.buildScript, "--copy-dist"], {
      cwd: fixture.root,
      encoding: "utf8",
      env: { ...process.env, CC: compilerPath },
    });
    expect(built.status).not.toBe(0);
    for (const helper of nativeHelperNames) {
      expect(await readFile(join(fixture.nativeRoot, helper), "utf8")).toBe(nativeHelperScript("old", helper));
    }
    await expectOnlyFixtureNativeFiles(fixture.nativeRoot);
  });

  darwinIt("keeps the owner outside the restricted target sandbox and denies target descendants", async () => {
    const root = await makeRoot(true);
    const worktree = await openDirectory(root);
    let output = "";
    try {
      const script = [
        'const { spawnSync } = require("node:child_process");',
        'const child = spawnSync("/usr/bin/true");',
        'process.stdout.write(child.error?.code ?? "none");',
        'process.exit(child.error?.code === "EPERM" ? 0 : 82);',
      ].join("");
      const managed = await spawnPosixManagedProcess({
        agentKind: "hermes",
        args: ["-e", script],
        cleanupTimeoutMs: 200,
        env: {},
        executablePath: process.execPath,
        platform: "darwin",
        preserveWorktreeFd: true,
        projectRoot: root,
        sandbox: "read-only",
        targetStdin: "null",
        worktreeFd: worktree.fd,
      });
      managed.child.stdout?.on("data", (chunk: Buffer | string) => {
        output += chunk.toString();
      });

      await managed.ready;
      await expect(managed.closed).resolves.toEqual({ exitCode: 0, signalCode: null });
      expect(output).toBe("EPERM");
      await expect(managed.terminateAndReap()).resolves.toBeUndefined();
    } finally {
      await worktree.close();
    }
  }, 15_000);

  darwinIt("allows only bounded Hermes runtime state writes while keeping the project and config read-only", async () => {
    const root = await makeRoot(true);
    const stateRoot = await mkdtemp(join(tmpdir(), "skyturn-hermes-state-"));
    roots.push(stateRoot);
    await Promise.all([
      mkdir(join(stateRoot, "logs")),
      mkdir(join(stateRoot, "skills")),
    ]);
    const worktree = await openDirectory(root);
    let output = "";
    try {
      const managed = await spawnPosixManagedProcess({
        agentKind: "hermes",
        args: ["-e", boundedHermesStateScript()],
        cleanupTimeoutMs: 200,
        env: { HERMES_HOME: stateRoot },
        executablePath: process.execPath,
        platform: "darwin",
        preserveWorktreeFd: true,
        projectRoot: root,
        sandbox: "read-only",
        targetStdin: "null",
        worktreeFd: worktree.fd,
      });
      managed.child.stdout?.on("data", (chunk: Buffer | string) => {
        output += chunk.toString();
      });
      managed.child.stderr?.resume();

      await managed.ready;
      await expect(managed.closed).resolves.toEqual({ exitCode: 0, signalCode: null });
      expect(output).toBe("bounded");
      expect(await readFile(join(stateRoot, "state.db-wal"), "utf8")).toBe("state");
      expect(await readFile(join(stateRoot, "logs", "agent.log"), "utf8")).toBe("log");
      expect(await readFile(join(stateRoot, "logs", "errors.log"), "utf8")).toBe("errors");
      await expect(stat(join(root, "project-write"))).rejects.toMatchObject({ code: "ENOENT" });
      await expect(stat(join(stateRoot, "config.yaml"))).rejects.toMatchObject({ code: "ENOENT" });
      await expect(managed.terminateAndReap()).resolves.toBeUndefined();
    } finally {
      await worktree.close();
    }
  }, 15_000);

  darwinIt("rejects a Hermes runtime state root inside the retained project", async () => {
    const root = await makeRoot(true);
    const worktree = await openDirectory(root);
    try {
      const outcome = await spawnPosixManagedProcess({
        agentKind: "hermes",
        args: ["-e", "setInterval(() => {}, 1000)"],
        cleanupTimeoutMs: 200,
        env: { HERMES_HOME: root },
        executablePath: process.execPath,
        platform: "darwin",
        preserveWorktreeFd: true,
        projectRoot: root,
        sandbox: "read-only",
        targetStdin: "null",
        worktreeFd: worktree.fd,
      }).then(async (managed) => {
        await managed.terminateAndReap();
        return "launched";
      }, () => "rejected");

      expect(outcome).toBe("rejected");
    } finally {
      await worktree.close();
    }
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
        projectRoot: root,
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

  posixIt("routes target stdin through a dedicated pipe and keeps owner control off the target stream", async () => {
    const root = await makeRoot(true);
    const worktree = await openDirectory(root);
    const stdinCapturePath = join(root, "stdin-capture.txt");

    try {
      const managed = await spawnPosixManagedProcess({
        agentKind: "hermes",
        args: ["-e", interactiveStdinCaptureScript(stdinCapturePath)],
        cleanupTimeoutMs: 150,
        env: process.env,
        executablePath: process.execPath,
        platform: process.platform,
        projectRoot: root,
        sandbox: "danger-full-access",
        targetStdin: "pipe",
        worktreeFd: worktree.fd,
      });
      await managed.ready;

      expect(managed.targetInput).not.toBeNull();
      managed.targetInput!.write("hello-from-target-stdin\n");
      await waitForFile(stdinCapturePath);
      await managed.terminateAndReap();

      expect(await readFile(stdinCapturePath, "utf8")).toBe("hello-from-target-stdin\n");
    } finally {
      await worktree.close();
    }
  }, 15_000);

  posixIt("closes the dedicated target stdin pipe to EOF without leaking control traffic", async () => {
    const root = await makeRoot(true);
    const worktree = await openDirectory(root);
    const stdinCapturePath = join(root, "stdin-eof-capture.txt");

    try {
      const managed = await spawnPosixManagedProcess({
        agentKind: "hermes",
        args: ["-e", interactiveStdinEofCaptureScript(stdinCapturePath)],
        cleanupTimeoutMs: 150,
        env: process.env,
        executablePath: process.execPath,
        platform: process.platform,
        projectRoot: root,
        sandbox: "danger-full-access",
        targetStdin: "pipe",
        worktreeFd: worktree.fd,
      });
      await managed.ready;

      expect(managed.targetInput).not.toBeNull();
      managed.targetInput!.end("hello-before-eof\n");

      expect(await managed.closed).toEqual({ exitCode: 0, signalCode: null });
      expect(await readFile(stdinCapturePath, "utf8")).toBe("hello-before-eof\n<<EOF>>");
    } finally {
      await worktree.close();
    }
  }, 15_000);

  posixIt("keeps existing noninteractive targets on /dev/null stdin", async () => {
    const root = await makeRoot(true);
    const worktree = await openDirectory(root);
    const stdinBytesPath = join(root, "stdin-bytes.txt");
    const fd5StatePath = join(root, "fd5-state.txt");

    try {
      const managed = await spawnPosixManagedProcess({
        agentKind: "codex",
        args: ["-e", nonInteractiveStdinByteCountScript(stdinBytesPath, fd5StatePath)],
        cleanupTimeoutMs: 150,
        env: process.env,
        executablePath: process.execPath,
        platform: process.platform,
        projectRoot: root,
        sandbox: "danger-full-access",
        worktreeFd: worktree.fd,
      });
      await managed.ready;

      expect(managed.targetInput).toBeNull();
      expect(await managed.closed).toEqual({ exitCode: 0, signalCode: null });
      expect(await readFile(stdinBytesPath, "utf8")).toBe("0");
      expect(await readFile(fd5StatePath, "utf8")).not.toBe("inherited-null");
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
        projectRoot: root,
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
        projectRoot: worktreePath,
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

async function makeNativeBuildFixture(): Promise<{
  buildScript: string;
  nativeRoot: string;
  root: string;
}> {
  const root = await makeRoot(false);
  const nativeRoot = join(root, "src/native");
  const scriptsRoot = join(root, "scripts");
  const buildScript = join(scriptsRoot, "buildArtifactGate.mjs");
  await Promise.all([mkdir(nativeRoot, { recursive: true }), mkdir(scriptsRoot, { recursive: true })]);
  await copyFile(fileURLToPath(new URL("../../scripts/buildArtifactGate.mjs", import.meta.url)), buildScript);
  await Promise.all([
    ...nativeHelperNames.flatMap((helper) => [
      writeFile(join(nativeRoot, `${helper}.c`), "int main(void) { return 0; }\n"),
      writeExecutable(join(nativeRoot, helper), nativeHelperScript("old", helper)),
    ]),
    writeFile(join(nativeRoot, "artifact-gate.ps1"), "# fixture\n"),
    writeFile(join(nativeRoot, "job-object-host.ps1"), "# fixture\n"),
  ]);
  return { buildScript, nativeRoot, root };
}

function nativeHelperScript(version: "new" | "old", helper: string): string {
  return `#!/bin/sh\nprintf '${version}:${helper}'\n`;
}

function fakeCompilerScript(
  mode: "dangling" | "fail" | "pause",
  readyPath?: string,
  releasePath?: string,
): string {
  return [
    "#!/usr/bin/env node",
    'const fs = require("node:fs");',
    'const path = require("node:path");',
    `const mode = ${JSON.stringify(mode)};`,
    `const readyPath = ${JSON.stringify(readyPath)};`,
    `const releasePath = ${JSON.stringify(releasePath)};`,
    "const args = process.argv.slice(2);",
    'const outputIndex = args.indexOf("-o");',
    "const output = args[outputIndex + 1];",
    'const helper = path.basename(args[outputIndex - 1], ".c");',
    "if (mode === 'dangling') {",
    "  fs.rmSync(output, { force: true });",
    "  fs.symlinkSync('missing-native-helper-target', output);",
    "  process.exit(0);",
    "}",
    `const complete = ${JSON.stringify(nativeHelperScript("new", "__HELPER__"))}.replace("__HELPER__", helper);`,
    "if (mode === 'fail') {",
    "  fs.writeFileSync(output, complete);",
    "  process.exit(29);",
    "}",
    `fs.writeFileSync(output, ${JSON.stringify("#!/bin/sh\nprintf 'incomplete'\n")});`,
    "if (helper !== 'artifact-gate') {",
    "  fs.writeFileSync(output, complete);",
    "  process.exit(0);",
    "}",
    "fs.writeFileSync(readyPath, output);",
    "const interval = setInterval(() => {",
    "  if (!fs.existsSync(releasePath)) return;",
    "  clearInterval(interval);",
    "  fs.writeFileSync(output, complete);",
    "  process.exit(0);",
    "}, 5);",
  ].join("\n");
}

async function expectOnlyFixtureNativeFiles(nativeRoot: string): Promise<void> {
  expect((await readdir(nativeRoot)).sort()).toEqual([
    "artifact-gate",
    "artifact-gate.c",
    "artifact-gate.ps1",
    "fd-launch",
    "fd-launch.c",
    "job-object-host.ps1",
    "posix-process-owner",
    "posix-process-owner.c",
  ]);
}

function waitForChildClose(child: ReturnType<typeof spawn>): Promise<{
  code: number | null;
  signal: NodeJS.Signals | null;
}> {
  return new Promise((resolve) => {
    child.once("close", (code, signal) => resolve({ code, signal }));
  });
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

function interactiveStdinCaptureScript(stdinCapturePath: string): string {
  return [
    "const fs = require('node:fs');",
    `const outputPath = ${JSON.stringify(stdinCapturePath)};`,
    "let recorded = '';",
    "process.stdin.setEncoding('utf8');",
    "process.stdin.on('data', (chunk) => {",
    "  recorded += chunk;",
    "  fs.writeFileSync(outputPath, recorded);",
    "});",
    "setInterval(() => {}, 1000);",
  ].join("\n");
}

function interactiveStdinEofCaptureScript(stdinCapturePath: string): string {
  return [
    "const fs = require('node:fs');",
    `const outputPath = ${JSON.stringify(stdinCapturePath)};`,
    "let recorded = '';",
    "process.stdin.setEncoding('utf8');",
    "process.stdin.on('data', (chunk) => {",
    "  recorded += chunk;",
    "});",
    "process.stdin.on('end', () => {",
    "  fs.writeFileSync(outputPath, recorded + '<<EOF>>');",
    "  process.exit(0);",
    "});",
    "process.stdin.resume();",
  ].join("\n");
}

function boundedHermesStateScript(): string {
  return [
    "const fs = require('node:fs');",
    "const { spawnSync } = require('node:child_process');",
    "const path = require('node:path');",
    "const home = process.env.HERMES_HOME;",
    "let allowed = true;",
    "for (const [name, value] of [",
    "  ['state.db-wal', 'state'],",
    "  ['kanban.db-shm', 'kanban'],",
    "  ['.mcp-discovery.lock', 'lock'],",
    "  ['logs/agent.log', 'log'],",
    "  ['logs/errors.log', 'errors'],",
    "  ['logs/mcp-stderr.log', 'mcp'],",
    "  ['skills/.usage.json', 'usage'],",
    "]) {",
    "  try { fs.writeFileSync(path.join(home, name), value); } catch { allowed = false; }",
    "}",
    "const denied = (target) => {",
    "  try { fs.writeFileSync(target, 'denied'); return false; } catch { return true; }",
    "};",
    "const projectDenied = denied(path.join(process.cwd(), 'project-write'));",
    "const configDenied = denied(path.join(home, 'config.yaml'));",
    "const child = spawnSync('/usr/bin/true');",
    "const forkDenied = child.error?.code === 'EPERM';",
    "if (allowed && projectDenied && configDenied && forkDenied) {",
    "  process.stdout.write('bounded');",
    "  process.exit(0);",
    "}",
    "process.exit(82);",
  ].join("\n");
}

function nonInteractiveStdinByteCountScript(stdinBytesPath: string, fd5StatePath: string): string {
  return [
    "const fs = require('node:fs');",
    `const outputPath = ${JSON.stringify(stdinBytesPath)};`,
    `const fd5StatePath = ${JSON.stringify(fd5StatePath)};`,
    "try {",
    "  const fd5 = fs.fstatSync(5);",
    "  const nullDevice = fs.statSync('/dev/null');",
    "  const inheritedNull = fd5.isCharacterDevice() && fd5.rdev === nullDevice.rdev;",
    "  fs.writeFileSync(fd5StatePath, inheritedNull ? 'inherited-null' : 'reused');",
    "} catch (error) {",
    "  if (error?.code !== 'EBADF') throw error;",
    "  fs.writeFileSync(fd5StatePath, 'closed');",
    "}",
    "let bytes = 0;",
    "process.stdin.on('data', (chunk) => { bytes += chunk.length; });",
    "process.stdin.on('end', () => {",
    "  fs.writeFileSync(outputPath, String(bytes));",
    "  process.exit(0);",
    "});",
    "process.stdin.resume();",
    "setTimeout(() => process.exit(71), 1000);",
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
