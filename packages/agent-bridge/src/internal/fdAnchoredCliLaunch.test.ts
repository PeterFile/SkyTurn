import { EventEmitter } from "node:events";
import type { ChildProcess } from "node:child_process";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { PassThrough } from "node:stream";

import { afterEach, describe, expect, it, vi } from "vitest";

const spawnMock = vi.hoisted(() => vi.fn());

vi.mock("node:child_process", () => ({ spawn: spawnMock }));

describe("fd-anchored CLI launch", () => {
  afterEach(() => {
    vi.useRealTimers();
    vi.resetModules();
    spawnMock.mockReset();
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
    expect(spawnMock).not.toHaveBeenCalled();
  });

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
