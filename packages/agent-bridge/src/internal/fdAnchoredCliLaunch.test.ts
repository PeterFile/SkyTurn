import { EventEmitter } from "node:events";
import type { ChildProcess } from "node:child_process";
import { constants as fsConstants, writeFileSync } from "node:fs";
import { chmod, mkdir, mkdtemp, open, readFile, realpath, rename, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const accessMock = vi.hoisted(() => vi.fn());
const spawnMock = vi.hoisted(() => vi.fn());
const posixIt = process.platform === "win32" ? it.skip : it;
const roots: string[] = [];
const originalProcessVersions = process.versions;
const originalElectronRunAsNode = process.env.ELECTRON_RUN_AS_NODE;

vi.mock("node:child_process", async (importOriginal) => {
  const original = await importOriginal<typeof import("node:child_process")>();
  return { ...original, spawn: spawnMock };
});
vi.mock("node:fs/promises", async (importOriginal) => ({
  ...await importOriginal<typeof import("node:fs/promises")>(),
  access: accessMock,
}));

describe("fd-anchored CLI launch", () => {
  beforeEach(() => {
    accessMock.mockResolvedValue(undefined);
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.resetModules();
    accessMock.mockReset();
    spawnMock.mockReset();
    Object.defineProperty(process, "versions", { value: originalProcessVersions });
    if (originalElectronRunAsNode === undefined) {
      delete process.env.ELECTRON_RUN_AS_NODE;
    } else {
      process.env.ELECTRON_RUN_AS_NODE = originalElectronRunAsNode;
    }
  });

  afterEach(async () => {
    await Promise.all(roots.splice(0).map((root) => rm(root, { force: true, recursive: true })));
  });

  it("rejects POSIX readiness when the managed owner helper is unavailable", async () => {
    accessMock.mockImplementation(async (path: string) => {
      if (path.endsWith("posix-process-owner")) {
        throw Object.assign(new Error("owner helper unavailable"), { code: "ENOENT" });
      }
    });
    const { hasFdAnchoredCliLaunchCapability } = await import("./fdAnchoredCliLaunch.js");

    await expect(hasFdAnchoredCliLaunchCapability({
      agentKind: "hermes",
      platform: "darwin",
      sandbox: "read-only",
    })).resolves.toBe(false);
    expect(accessMock).toHaveBeenNthCalledWith(
      1,
      expect.stringMatching(/\/native\/fd-launch$/),
      fsConstants.X_OK,
    );
    expect(accessMock).toHaveBeenNthCalledWith(
      2,
      expect.stringMatching(/\/native\/posix-process-owner$/),
      fsConstants.X_OK,
    );
    expect(spawnMock).not.toHaveBeenCalled();
  });

  it("rejects Hermes workspace-write without probing a pathname sandbox", async () => {
    spawnMock.mockImplementation((_executablePath: string, args: string[]) => {
      const definition = args.find((argument) => argument.startsWith("SKYTURN_WORKTREE="));
      if (!definition) throw new Error("missing sandbox worktree definition");
      writeFileSync(join(definition.slice("SKYTURN_WORKTREE=".length), "inside"), "probe");
      const child = Object.assign(new EventEmitter(), {
        kill: vi.fn(() => true),
        stdio: [null, null, null, null, new PassThrough()],
      }) as unknown as ChildProcess;
      queueMicrotask(() => child.emit("close", 0, null));
      return child;
    });
    const { hasFdAnchoredCliLaunchCapability } = await import("./fdAnchoredCliLaunch.js");

    await expect(hasFdAnchoredCliLaunchCapability({
      agentKind: "hermes",
      platform: "darwin",
      sandbox: "workspace-write",
    })).resolves.toBe(false);
    expect(accessMock).not.toHaveBeenCalled();
    expect(spawnMock).not.toHaveBeenCalled();
  });

  it("accepts the restricted Hermes topology that the managed owner can launch", async () => {
    spawnMock.mockImplementation((executablePath: string) => {
      const control = new PassThrough();
      const status = new PassThrough();
      const child = Object.assign(new EventEmitter(), {
        kill: vi.fn(() => true),
        stdin: control,
        stdio: [control, null, null, null, status],
      }) as unknown as ChildProcess;
      queueMicrotask(() => {
        if (executablePath.endsWith("/posix-process-owner")) {
          status.end("R 41\nC 0 0\n");
          child.emit("close", 0, null);
          return;
        }
        status.end();
        child.emit("close", 71, null);
      });
      return child;
    });
    const { hasFdAnchoredCliLaunchCapability } = await import("./fdAnchoredCliLaunch.js");

    await expect(hasFdAnchoredCliLaunchCapability({
      agentKind: "hermes",
      platform: "darwin",
      sandbox: "read-only",
    })).resolves.toBe(true);
    expect(spawnMock).toHaveBeenCalledOnce();
    expect(spawnMock.mock.calls[0]?.[0]).toMatch(/\/native\/posix-process-owner$/);
  });

  it("runs the Electron sandbox probe with Electron Node CLI semantics", async () => {
    process.env.ELECTRON_RUN_AS_NODE = "inherited-wrong-value";
    Object.defineProperty(process, "versions", {
      value: { ...originalProcessVersions, electron: "41.5.1" },
    });
    spawnMock.mockImplementation(successfulManagedProbe);
    const { hasFdAnchoredCliLaunchCapability } = await import("./fdAnchoredCliLaunch.js");

    await expect(hasFdAnchoredCliLaunchCapability({
      agentKind: "hermes",
      platform: "darwin",
      sandbox: "read-only",
    })).resolves.toBe(true);

    const spawnOptions = spawnMock.mock.calls[0]?.[2];
    expect(spawnOptions?.env).not.toBe(process.env);
    expect(spawnOptions?.env).toMatchObject({ ELECTRON_RUN_AS_NODE: "1" });
    expect(process.env.ELECTRON_RUN_AS_NODE).toBe("inherited-wrong-value");
  });

  it.each([undefined, "existing-node-value"])(
    "preserves the inherited probe environment in a normal Node runtime (%s)",
    async (electronRunAsNode) => {
      if (electronRunAsNode === undefined) {
        delete process.env.ELECTRON_RUN_AS_NODE;
      } else {
        process.env.ELECTRON_RUN_AS_NODE = electronRunAsNode;
      }
      const inheritedEnv = process.env;
      spawnMock.mockImplementation(successfulManagedProbe);
      const { hasFdAnchoredCliLaunchCapability } = await import("./fdAnchoredCliLaunch.js");

      await expect(hasFdAnchoredCliLaunchCapability({
        agentKind: "hermes",
        platform: "darwin",
        sandbox: "read-only",
      })).resolves.toBe(true);

      const spawnOptions = spawnMock.mock.calls[0]?.[2];
      expect(spawnOptions?.env === inheritedEnv).toBe(true);
      expect(spawnOptions?.env?.ELECTRON_RUN_AS_NODE).toBe(electronRunAsNode);
      expect(process.env === inheritedEnv).toBe(true);
      expect(process.env.ELECTRON_RUN_AS_NODE).toBe(electronRunAsNode);
    },
  );

  it("denies descendant creation inside the restricted Hermes sandbox", async () => {
    const { buildFdAnchoredCliLaunchPlan } = await import("./fdAnchoredCliLaunch.js");

    const plan = buildFdAnchoredCliLaunchPlan({
      agentKind: "hermes",
      args: ["acp"],
      env: process.env,
      executablePath: "/usr/local/bin/hermes",
      platform: "darwin",
      preserveWorktreeFd: true,
      sandbox: "read-only",
      worktreeFd: 3,
    });

    expect(plan.wrapper).toEqual({
      args: [
        "-p",
        expect.stringContaining("(deny process-fork)"),
      ],
      executablePath: "/usr/bin/sandbox-exec",
    });
  });

  it.each([
    ["codex", "danger-full-access", true],
    ["hermes", "danger-full-access", true],
    ["codex", "read-only", false],
    ["hermes", "read-only", false],
  ] as const)(
    "preserves Windows %s %s capability without POSIX probes",
    async (agentKind, sandbox, expected) => {
      const { hasFdAnchoredCliLaunchCapability } = await import("./fdAnchoredCliLaunch.js");

      await expect(hasFdAnchoredCliLaunchCapability({
        agentKind,
        platform: "win32",
        sandbox,
      })).resolves.toBe(expected);
      expect(accessMock).not.toHaveBeenCalled();
      expect(spawnMock).not.toHaveBeenCalled();
    },
  );

  it.each(["darwin", "linux", "win32"] as const)(
    "refuses to spawn Hermes workspace-write on %s",
    async (platform) => {
      const child = Object.assign(new EventEmitter(), {
        kill: vi.fn(() => true),
        stdio: [null, null, null, null, new PassThrough()],
      }) as unknown as ChildProcess;
      spawnMock.mockReturnValue(child);
      const { spawnFdAnchoredCli } = await import("./fdAnchoredCliLaunch.js");
      const input = {
        agentKind: "hermes" as const,
        args: [],
        env: {},
        executablePath: "/bin/true",
        platform,
        sandbox: "workspace-write" as const,
        worktreeFd: 3,
        worktreePath: "/worktree",
      };

      expect(() => spawnFdAnchoredCli(input)).toThrow("Hermes workspace-write sandbox is unavailable.");
      expect(spawnMock).not.toHaveBeenCalled();
    },
  );

  it("requests managed probe termination on timeout and waits for actual close", async () => {
    vi.useFakeTimers();
    const control = new PassThrough();
    let controlBytes = "";
    control.on("data", (chunk: Buffer) => {
      controlBytes += chunk.toString("utf8");
    });
    const status = new PassThrough();
    const kill = vi.fn(() => true);
    const child = Object.assign(new EventEmitter(), {
      kill,
      stdin: control,
      stdio: [control, null, null, null, status],
    }) as unknown as ChildProcess;
    spawnMock.mockReturnValue(child);
    const { hasFdAnchoredCliLaunchCapability } = await import("./fdAnchoredCliLaunch.js");
    let settled = false;
    const capability = hasFdAnchoredCliLaunchCapability({
      agentKind: "hermes",
      platform: "darwin",
      sandbox: "read-only",
    }).finally(() => {
      settled = true;
    });

    await vi.waitFor(() => expect(spawnMock).toHaveBeenCalledOnce());
    await vi.advanceTimersByTimeAsync(2_000);

    expect(controlBytes).toBe("T\n");
    expect(kill).not.toHaveBeenCalled();
    expect(settled).toBe(false);

    status.end("R 41\nC 0 0\n");
    child.emit("close", 0, null);
    await expect(capability).resolves.toBe(false);
  });

  posixIt("preserves fd 3 across exec only when explicitly requested and keeps descriptor authority after path replacement", async () => {
    const { buildFdAnchoredCliLaunchPlan } = await import("./fdAnchoredCliLaunch.js");
    const root = await mkdtemp(join(tmpdir(), "skyturn-fd-launch-"));
    roots.push(root);
    const worktreePath = join(root, "worktree");
    const retainedPath = join(root, "retained-worktree");
    const outputPath = join(root, "result.txt");
    const launcherPath = join(root, "launcher.js");
    await mkdir(join(worktreePath, ".git"), { recursive: true });
    await writeFile(join(worktreePath, ".git", "anchor.txt"), "retained-directory");
    await writeFile(launcherPath, fd3ProbeScript(outputPath));
    await chmod(launcherPath, 0o755);
    const worktree = await open(
      worktreePath,
      fsConstants.O_RDONLY | fsConstants.O_DIRECTORY | fsConstants.O_NOFOLLOW,
    );

    try {
      await rename(worktreePath, retainedPath);
      await mkdir(join(worktreePath, ".git"), { recursive: true });
      await writeFile(join(worktreePath, ".git", "anchor.txt"), "replacement-directory");

      const plan = buildFdAnchoredCliLaunchPlan({
        agentKind: "hermes",
        args: [launcherPath, outputPath],
        env: process.env,
        executablePath: process.execPath,
        platform: process.platform,
        preserveWorktreeFd: true,
        sandbox: "danger-full-access",
        worktreeFd: worktree.fd,
      });
      const launched = spawnSync(plan.fdLaunchPath, plan.fdLaunchArgs, {
        env: process.env,
        stdio: ["ignore", "pipe", "pipe", worktree.fd, "pipe"],
      });

      expect(launched.status, launched.stderr?.toString("utf8")).toBe(0);
      const [reportedPath, fd3Dir, anchor, trailing] = (await readFile(outputPath, "utf8")).split("\n");
      expect(await realpath(reportedPath)).toBe(await realpath(retainedPath));
      expect(fd3Dir).toBe("true");
      expect(anchor).toBe("retained-directory");
      expect(trailing).toBe("");
    } finally {
      await worktree.close();
    }
  });

  posixIt("rejects malformed or duplicate fd-launch preserve options fail-closed", async () => {
    const helperPath = fileURLToPath(new URL("../native/fd-launch", import.meta.url));
    const root = await mkdtemp(join(tmpdir(), "skyturn-fd-launch-invalid-"));
    roots.push(root);
    await mkdir(join(root, ".git"), { recursive: true });
    const worktree = await open(root, fsConstants.O_RDONLY | fsConstants.O_DIRECTORY | fsConstants.O_NOFOLLOW);

    try {
      const duplicate = spawnSync(
        helperPath,
        ["--preserve-worktree-fd", "--preserve-worktree-fd", "/bin/pwd"],
        { stdio: ["ignore", "pipe", "pipe", worktree.fd, "pipe"] },
      );
      const malformed = spawnSync(
        helperPath,
        ["--preserve-worktree-fd=yes", "/bin/pwd"],
        { stdio: ["ignore", "pipe", "pipe", worktree.fd, "pipe"] },
      );

      expect(duplicate.status).toBe(64);
      expect(malformed.status).toBe(64);
    } finally {
      await worktree.close();
    }
  });
});

function fd3ProbeScript(outputPath: string): string {
  return [
    "#!/usr/bin/env node",
    "const fs = require('node:fs');",
    "const cwd = process.cwd();",
    "const fd3Dir = String(fs.fstatSync(3).isDirectory());",
    "const anchor = fs.readFileSync('.git/anchor.txt', 'utf8');",
    `fs.writeFileSync(${JSON.stringify(outputPath)}, cwd + "\\n" + fd3Dir + "\\n" + anchor + "\\n");`,
  ].join("\n");
}

function successfulManagedProbe(): ChildProcess {
  const control = new PassThrough();
  const status = new PassThrough();
  const child = Object.assign(new EventEmitter(), {
    kill: vi.fn(() => true),
    stdin: control,
    stdio: [control, null, null, null, status],
  }) as unknown as ChildProcess;
  queueMicrotask(() => {
    status.end("R 41\nC 0 0\n");
    child.emit("close", 0, null);
  });
  return child;
}
