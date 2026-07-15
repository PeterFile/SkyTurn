import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { spawnSync, type ChildProcess } from "node:child_process";
import { readFile, stat } from "node:fs/promises";
import { fileURLToPath } from "node:url";

import { describe, expect, it, vi } from "vitest";

import {
  assertWindowsExpectedArtifactVerifierCapability,
  openWindowsExpectedArtifactVerifierSession,
  type WindowsArtifactVerifierDependencies,
} from "./windowsExpectedArtifactVerifier.js";

const artifact = ".devflow/acceptance/react-app.png";

describe("Windows expected-artifact verifier process protocol", () => {
  it("accepts one exact all-or-nothing artifact list through bounded argv/stdin", async () => {
    const spawnProcess = protocolSpawn({
      status: "passed",
      artifacts: [artifact],
      counts: { verified: 1, missing: 0, empty: 0, unsafe: 0 },
    });
    const dependencies = testDependencies(spawnProcess);

    await expect(assertWindowsExpectedArtifactVerifierCapability(dependencies)).resolves.toBeUndefined();
    const session = await openWindowsExpectedArtifactVerifierSession("C:\\repo", [artifact], dependencies);
    await expect(session.verify()).resolves.toEqual({
      passed: true,
      artifacts: [artifact],
      counts: { verified: 1, missing: 0, empty: 0, unsafe: 0 },
    });

    expect(spawnProcess).toHaveBeenCalledTimes(2);
    for (const [executable, args, options] of spawnProcess.mock.calls) {
      expect(executable).toBe("C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe");
      expect(args).toContain("C:\\app\\artifact-gate.ps1");
      expect(args.join(" ")).not.toContain("C:\\repo");
      expect(args.join(" ")).not.toContain(artifact);
      expect(options).toMatchObject({ shell: false, windowsHide: true });
    }
  });

  it.each([
    ["accepts the held original", true],
    ["rejects a replacement-only artifact", false],
  ])("keeps one READY root identity and %s", async (_name, originalExists) => {
    let visibleReplacementExists = originalExists;
    const result = originalExists
      ? {
          status: "passed",
          artifacts: [artifact],
          counts: { verified: 1, missing: 0, empty: 0, unsafe: 0 },
        }
      : {
          status: "failed",
          artifacts: [],
          counts: { verified: 0, missing: 1, empty: 0, unsafe: 0 },
        };
    const spawnProcess = protocolSpawn(result);
    const dependencies = {
      ...testDependencies(spawnProcess),
      afterRootOpen: () => {
        visibleReplacementExists = !visibleReplacementExists;
      },
    };
    const session = await openWindowsExpectedArtifactVerifierSession("C:\\repo", [artifact], dependencies);

    await expect(session.verify()).resolves.toMatchObject({ passed: originalExists });
    expect(visibleReplacementExists).toBe(!originalExists);
    expect(spawnProcess).toHaveBeenCalledTimes(1);
  });

  it.each([
    ["empty", { verified: 0, missing: 0, empty: 1, unsafe: 0 }],
    ["missing", { verified: 0, missing: 1, empty: 0, unsafe: 0 }],
    ["directory", { verified: 0, missing: 0, empty: 0, unsafe: 1 }],
    ["final reparse", { verified: 0, missing: 0, empty: 0, unsafe: 1 }],
    ["junction parent", { verified: 0, missing: 0, empty: 0, unsafe: 1 }],
    ["outside root", { verified: 0, missing: 0, empty: 0, unsafe: 1 }],
    ["ADS", { verified: 0, missing: 0, empty: 0, unsafe: 1 }],
    ["device", { verified: 0, missing: 0, empty: 0, unsafe: 1 }],
    ["UNC", { verified: 0, missing: 0, empty: 0, unsafe: 1 }],
    ["drive mismatch", { verified: 0, missing: 0, empty: 0, unsafe: 1 }],
    ["prefix collision", { verified: 0, missing: 0, empty: 0, unsafe: 1 }],
    ["rename swap", { verified: 0, missing: 0, empty: 0, unsafe: 1 }],
  ])("fails closed for %s without returning a partial artifact list", async (_name, counts) => {
    const dependencies = testDependencies(protocolSpawn({ status: "failed", artifacts: [], counts }));
    const session = await openWindowsExpectedArtifactVerifierSession("C:\\repo", [artifact], dependencies);

    await expect(session.verify()).resolves.toEqual({ passed: false, artifacts: [], counts });
  });

  it.each([
    ["nonzero", protocolSpawn({ status: "passed", artifacts: [artifact], counts: { verified: 1, missing: 0, empty: 0, unsafe: 0 } }, { exitCode: 9 })],
    ["malformed", protocolSpawnRaw("not-json\n")],
    ["trailing protocol bytes", protocolSpawnRaw(`${JSON.stringify({
      version: 1,
      status: "passed",
      artifacts: [artifact],
      counts: { verified: 1, missing: 0, empty: 0, unsafe: 0 },
    })}\ntrailing`)],
    ["oversized stdout", protocolSpawnRaw("x".repeat(70_000))],
    ["extra artifact", protocolSpawn({
      status: "passed",
      artifacts: [artifact, ".devflow/acceptance/extra.png"],
      counts: { verified: 1, missing: 0, empty: 0, unsafe: 0 },
    })],
  ])("fails closed on %s helper completion", async (_name, spawnProcess) => {
    const session = await openWindowsExpectedArtifactVerifierSession(
      "C:\\repo",
      [artifact],
      testDependencies(spawnProcess),
    );
    await expect(session.verify()).rejects.toThrow(/verification failed/i);
  });

  it("rejects unsafe or duplicate declarations before spawning the verifier", async () => {
    for (const artifacts of [
      ["../outside.png"],
      [artifact, artifact],
      [".devflow/acceptance/file.png:$DATA"],
      ["\\\\server\\share\\file.png"],
      ["D:\\file.png"],
    ]) {
      const spawnProcess = protocolSpawn({
        status: "passed",
        artifacts: [artifact],
        counts: { verified: 1, missing: 0, empty: 0, unsafe: 0 },
      });
      await expect(openWindowsExpectedArtifactVerifierSession(
        "C:\\repo",
        artifacts,
        testDependencies(spawnProcess),
      )).rejects.toThrow(/verification failed/i);
      expect(spawnProcess).not.toHaveBeenCalled();
    }
  });

  it.each(["session", "capability"] as const)(
    "kills and reaps a %s helper with missing protocol pipes",
    async (operation) => {
      const child = fakeChild({ stdio: false, closeOnKill: false });
      const dependencies = testDependencies(vi.fn(() => child as ChildProcess));
      const pending = operation === "session"
        ? openWindowsExpectedArtifactVerifierSession("C:\\repo", [artifact], dependencies)
        : assertWindowsExpectedArtifactVerifierCapability(dependencies);
      const settlement = trackSettlement(pending);

      await flushMicrotasks();
      expect(child.kill).toHaveBeenCalledTimes(1);
      expect(settlement.count).toBe(0);

      child.emit("close", null, "SIGKILL");
      await settlement.done;
      await expect(pending).rejects.toThrow(operation === "session" ? /verification failed/i : /capability is unavailable/i);
      expect(settlement.count).toBe(1);
    },
  );

  it.each([
    ["nonzero", '{"version":1,"status":"ready"}\n', 9],
    ["malformed", "not-json\n", 0],
    ["extra fields", '{"version":1,"status":"ready","extra":true}\n', 0],
    ["oversized", "x".repeat(5_000), 0],
  ])("fails capability detection on %s output", async (_name, output, exitCode) => {
    const spawnProcess = capabilitySpawnRaw(output, exitCode);
    await expect(assertWindowsExpectedArtifactVerifierCapability(testDependencies(spawnProcess)))
      .rejects.toThrow("Windows expected-artifact verifier capability is unavailable.");
  });

  it("fails capability detection when the helper runtime is unavailable", async () => {
    const spawnProcess = vi.fn(() => {
      throw Object.assign(new Error("ENOENT C:\\private\\powershell.exe"), { code: "ENOENT" });
    });
    await expect(assertWindowsExpectedArtifactVerifierCapability(testDependencies(spawnProcess)))
      .rejects.toThrow("Windows expected-artifact verifier capability is unavailable.");
  });

  it("caches one successful capability probe per resolved dependency boundary", async () => {
    const spawnProcess = protocolSpawn({
      status: "passed",
      artifacts: [artifact],
      counts: { verified: 1, missing: 0, empty: 0, unsafe: 0 },
    });
    const dependencies = testDependencies(spawnProcess);

    await Promise.all([
      assertWindowsExpectedArtifactVerifierCapability(dependencies),
      assertWindowsExpectedArtifactVerifierCapability(dependencies),
    ]);
    await assertWindowsExpectedArtifactVerifierCapability(dependencies);

    expect(spawnProcess).toHaveBeenCalledTimes(1);
  });

  it.each(["capability", "open", "verify", "abort"] as const)(
    "keeps a timed-out %s operation pending until the helper closes",
    async (operation) => {
      vi.useFakeTimers();
      try {
        const child = fakeChild({ closeOnKill: false });
        const dependencies = testDependencies(vi.fn(() => child as ChildProcess), 25);
        let pending: Promise<unknown>;
        if (operation === "capability") {
          pending = assertWindowsExpectedArtifactVerifierCapability(dependencies);
        } else if (operation === "open") {
          pending = openWindowsExpectedArtifactVerifierSession("C:\\repo", [artifact], dependencies);
        } else {
          queueMicrotask(() => child.stdout.write("READY\n"));
          const session = await openWindowsExpectedArtifactVerifierSession("C:\\repo", [artifact], dependencies);
          pending = operation === "verify" ? session.verify() : session.abort();
        }
        const settlement = trackSettlement(pending);

        await vi.advanceTimersByTimeAsync(operation === "open" ? 51 : 26);
        expect(child.kill).toHaveBeenCalledTimes(1);
        expect(settlement.count).toBe(0);

        child.stdout?.end();
        child.emit("close", null, "SIGKILL");
        await settlement.done;
        if (operation === "abort") await expect(pending).resolves.toBeUndefined();
        else await expect(pending).rejects.toThrow(operation === "capability" ? /capability is unavailable/i : /verification failed/i);
        expect(settlement.count).toBe(1);
      } finally {
        vi.useRealTimers();
      }
    },
  );

  it.each([
    ["session", "returns false"],
    ["session", "throws"],
    ["capability", "returns false"],
    ["capability", "throws"],
  ] as const)(
    "awaits close exactly once when a %s helper kill %s",
    async (operation, killBehavior) => {
      vi.useFakeTimers();
      try {
        const child = fakeChild({
          closeOnKill: false,
          killBehavior: killBehavior === "throws" ? "throw" : "false",
        });
        const dependencies = testDependencies(vi.fn(() => child as ChildProcess), 25);
        const pending = operation === "session"
          ? openWindowsExpectedArtifactVerifierSession("C:\\repo", [artifact], dependencies)
          : assertWindowsExpectedArtifactVerifierCapability(dependencies);
        const settlement = trackSettlement(pending);

        await vi.advanceTimersByTimeAsync(26);
        expect(child.kill).toHaveBeenCalledTimes(1);
        expect(settlement.count).toBe(0);

        child.stdout.end();
        child.emit("close", null, "SIGKILL");
        await settlement.done;
        await expect(pending).rejects.toThrow(operation === "session" ? /verification failed/i : /capability is unavailable/i);
        expect(child.kill).toHaveBeenCalledTimes(1);
        expect(settlement.count).toBe(1);
      } finally {
        vi.useRealTimers();
      }
    },
  );

  it("shares one termination when kill synchronously triggers another failure path", async () => {
    vi.useFakeTimers();
    try {
      const child = fakeChild({ closeOnKill: false, errorOnFirstKill: true });
      const dependencies = testDependencies(vi.fn(() => child as ChildProcess), 25);
      const pending = openWindowsExpectedArtifactVerifierSession("C:\\repo", [artifact], dependencies);
      const settlement = trackSettlement(pending);

      await vi.advanceTimersByTimeAsync(26);
      expect(child.kill).toHaveBeenCalledTimes(1);
      expect(settlement.count).toBe(0);

      child.stdout.end();
      child.emit("close", null, "SIGKILL");
      await settlement.done;
      await expect(pending).rejects.toThrow(/verification failed/i);
      expect(child.kill).toHaveBeenCalledTimes(1);
      expect(settlement.count).toBe(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it.each(["session", "capability"] as const)(
    "waits for close after a %s child error",
    async (operation) => {
      const child = fakeChild({ closeOnKill: false });
      const dependencies = testDependencies(vi.fn(() => child as ChildProcess));
      const pending = operation === "session"
        ? openWindowsExpectedArtifactVerifierSession("C:\\repo", [artifact], dependencies)
        : assertWindowsExpectedArtifactVerifierCapability(dependencies);
      const settlement = trackSettlement(pending);

      await flushMicrotasks();
      child.emit("error", new Error("injected child failure"));
      await flushMicrotasks();
      expect(child.kill).toHaveBeenCalledTimes(1);
      expect(settlement.count).toBe(0);

      child.stdout.end();
      child.emit("close", null, "SIGKILL");
      await settlement.done;
      await expect(pending).rejects.toThrow(operation === "session" ? /verification failed/i : /capability is unavailable/i);
      expect(settlement.count).toBe(1);
    },
  );

  it.each([
    ["capability", "malformed", "not-json\n"],
    ["capability", "oversized", "x".repeat(5_000)],
    ["session", "malformed", "not-json\n"],
    ["session", "oversized", "x".repeat(70_000)],
  ] as const)(
    "terminates a %s helper on %s output but rejects only after close",
    async (operation, _failure, output) => {
      const child = fakeChild({ closeOnKill: false });
      if (operation === "session") {
        let input = "";
        child.stdin.on("data", (chunk) => {
          input += chunk.toString("utf8");
          if (input.includes("\n") && !input.includes("VERIFY\n")) child.stdout.write("READY\n");
          if (input.includes("VERIFY\n") && !input.includes("COMMIT\n")) child.stdout.write("OPENED\n");
          if (input.includes("COMMIT\n")) child.stdout.write(output);
        });
      }
      const dependencies = testDependencies(vi.fn(() => child as ChildProcess));
      let pending: Promise<unknown>;
      if (operation === "capability") {
        pending = assertWindowsExpectedArtifactVerifierCapability(dependencies);
        await flushMicrotasks();
        child.stdout.write(output);
      } else {
        const session = await openWindowsExpectedArtifactVerifierSession("C:\\repo", [artifact], dependencies);
        pending = session.verify();
      }
      const settlement = trackSettlement(pending);

      await flushMicrotasks();
      expect(child.kill).toHaveBeenCalledTimes(1);
      expect(settlement.count).toBe(0);

      child.stdout.end();
      child.emit("close", null, "SIGKILL");
      await settlement.done;
      await expect(pending).rejects.toThrow(operation === "session" ? /verification failed/i : /capability is unavailable/i);
      expect(settlement.count).toBe(1);
    },
  );

  it("ships a checked-in PowerShell 5.1-compatible handle verifier and package build rule", async () => {
    const helperUrl = new URL("../native/artifact-gate.ps1", import.meta.url);
    const buildScriptUrl = new URL("../../scripts/buildArtifactGate.mjs", import.meta.url);
    const [source, helperStat, packageJson, buildScript] = await Promise.all([
      readFile(helperUrl, "utf8"),
      stat(helperUrl),
      readFile(new URL("../../package.json", import.meta.url), "utf8"),
      readFile(buildScriptUrl, "utf8"),
    ]);

    expect(helperStat.isFile()).toBe(true);
    expect(source).toMatch(/CreateFileW/);
    expect(source).toMatch(/GetFileInformationByHandleEx/);
    expect(source).toMatch(/GetFinalPathNameByHandleW/);
    expect(source).toMatch(/FILE_FLAG_OPEN_REPARSE_POINT/);
    expect(source).toMatch(/FileAttributeTagInfo/);
    expect(source).toMatch(/FileIdInfo/);
    expect(source).toMatch(/GetIdentity\(rootHandle\)/);
    expect(source).toMatch(/retained\.ExpectedIdentity/);
    expect(source).toMatch(/IsExactChildPath/);
    expect(source).toMatch(/MaxComponentCount/);
    expect(source).toMatch(/FILE_SHARE_READ\s*\|\s*FILE_SHARE_WRITE/);
    expect(source).not.toMatch(/FILE_SHARE_DELETE/);
    expect(source).toMatch(/ConvertFrom-Json/);
    expect(source).toMatch(/\[Console\]::In\.ReadLine\(\)/);
    expect(source).not.toMatch(/Invoke-Expression|\biex\b/);
    expect(JSON.parse(packageJson).files).toEqual(expect.arrayContaining([
      "dist/native/artifact-gate.ps1",
      "src",
    ]));
    expect(buildScript).toMatch(/artifact-gate\.ps1/);
    const built = spawnSync(process.execPath, [fileURLToPath(buildScriptUrl), "--copy-dist"], {
      cwd: fileURLToPath(new URL("../../", import.meta.url)),
      encoding: "utf8",
    });
    expect(built.status, built.stderr).toBe(0);
    await expect(stat(new URL("../../dist/native/artifact-gate.ps1", import.meta.url)))
      .resolves.toMatchObject({ size: helperStat.size });
  });
});

function testDependencies(
  spawnProcess: ReturnType<typeof vi.fn>,
  timeoutMs = 1_000,
): WindowsArtifactVerifierDependencies {
  return {
    platform: "win32",
    helperPath: "C:\\app\\artifact-gate.ps1",
    powershellPath: "C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe",
    timeoutMs,
    spawnProcess,
    validateHelper: async () => {},
  };
}

function protocolSpawn(
  result: unknown,
  options: { exitCode?: number } = {},
): ReturnType<typeof vi.fn> {
  return vi.fn((_executable, args: string[]) => {
    const child = fakeChild();
    if (args.includes("-Capability")) {
      queueMicrotask(() => {
        child.stdout.write('{"version":1,"status":"ready"}\n');
        child.stdout.end();
        child.emit("close", options.exitCode ?? 0);
      });
      return child as ChildProcess;
    }
    let input = "";
    child.stdin.on("data", (chunk) => {
      input += chunk.toString("utf8");
      if (input.includes("\n") && !input.includes("VERIFY\n")) child.stdout.write("READY\n");
      if (input.includes("VERIFY\n") && !input.includes("COMMIT\n")) child.stdout.write("OPENED\n");
      if (input.includes("COMMIT\n")) {
        child.stdout.write(`${JSON.stringify({ version: 1, ...result })}\n`);
        child.stdout.end();
        child.emit("close", options.exitCode ?? 0);
      }
    });
    return child as ChildProcess;
  });
}

function protocolSpawnRaw(output: string): ReturnType<typeof vi.fn> {
  return vi.fn(() => {
    const child = fakeChild();
    let input = "";
    child.stdin.on("data", (chunk) => {
      input += chunk.toString("utf8");
      if (input.includes("\n") && !input.includes("VERIFY\n")) child.stdout.write("READY\n");
      if (input.includes("VERIFY\n") && !input.includes("COMMIT\n")) child.stdout.write("OPENED\n");
      if (input.includes("COMMIT\n")) {
        child.stdout.write(output);
        child.stdout.end();
        child.emit("close", 0);
      }
    });
    return child as ChildProcess;
  });
}

function capabilitySpawnRaw(output: string, exitCode: number): ReturnType<typeof vi.fn> {
  return vi.fn(() => {
    const child = fakeChild();
    queueMicrotask(() => {
      child.stdout.write(output);
      child.stdout.end();
      child.emit("close", exitCode);
    });
    return child as ChildProcess;
  });
}

function fakeChild(options: {
  closeOnKill?: boolean;
  errorOnFirstKill?: boolean;
  killBehavior?: "true" | "false" | "throw";
  stdio?: boolean;
} = {}): ChildProcess & { stdin: PassThrough; stdout: PassThrough } {
  const child = new EventEmitter() as ChildProcess & { stdin: PassThrough; stdout: PassThrough };
  let killCalls = 0;
  child.stdin = options.stdio === false ? null! : new PassThrough();
  child.stdout = options.stdio === false ? null! : new PassThrough();
  Object.assign(child, {
    stderr: null,
    pid: 1234,
    exitCode: null,
    signalCode: null,
    kill: vi.fn(() => {
      killCalls += 1;
      if (options.killBehavior === "throw") throw new Error("injected kill failure");
      if (options.errorOnFirstKill && killCalls === 1) {
        child.emit("error", new Error("injected synchronous child failure"));
      }
      child.signalCode = "SIGKILL";
      if (options.closeOnKill !== false) queueMicrotask(() => child.emit("close", null, "SIGKILL"));
      return options.killBehavior !== "false";
    }),
  });
  return child;
}

function trackSettlement(promise: Promise<unknown>): {
  readonly count: number;
  done: Promise<void>;
} {
  let count = 0;
  return {
    get count() {
      return count;
    },
    done: promise.then(
      () => { count += 1; },
      () => { count += 1; },
    ),
  };
}

async function flushMicrotasks(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
}
