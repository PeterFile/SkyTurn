import { EventEmitter } from "node:events";
import type { ChildProcess } from "node:child_process";
import { constants as fsConstants, writeFileSync } from "node:fs";
import { join } from "node:path";
import { PassThrough } from "node:stream";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const accessMock = vi.hoisted(() => vi.fn());
const spawnMock = vi.hoisted(() => vi.fn());

vi.mock("node:child_process", () => ({ spawn: spawnMock }));
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

  it("waits for actual probe close when the timeout kill throws", async () => {
    vi.useFakeTimers();
    const status = new PassThrough();
    const kill = vi.fn(() => {
      throw new Error("injected kill failure");
    });
    const child = Object.assign(new EventEmitter(), {
      kill,
      stdio: [null, null, null, null, status],
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

    expect(kill).toHaveBeenCalledExactlyOnceWith("SIGKILL");
    expect(settled).toBe(false);

    child.emit("close", 0, null);
    await expect(capability).resolves.toBe(true);
  });
});
