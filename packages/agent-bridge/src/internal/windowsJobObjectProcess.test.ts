import { EventEmitter } from "node:events";
import { readFile, stat } from "node:fs/promises";
import { Duplex, PassThrough, Writable } from "node:stream";
import type { ChildProcess } from "node:child_process";

import { describe, expect, it, vi } from "vitest";

import {
  assertVerifiedPtyProcessBoundary,
  attachWindowsJobObjectProtocol,
} from "./windowsJobObjectProcess.js";

describe("Windows Job Object host protocol", () => {
  it("fails closed for PTY launches on Windows", () => {
    expect(() => assertVerifiedPtyProcessBoundary("win32")).toThrow(
      "PTY agent sessions are unavailable on Windows without a verified Job Object boundary.",
    );
    expect(() => assertVerifiedPtyProcessBoundary("darwin")).not.toThrow();
  });

  it("resolves only after a close-before-ack sequence has both the verified ack and helper close", async () => {
    const token = "test-token";
    const { child, emitClose } = fakeChild();
    const { control, inbound, outbound } = fakeControlChannel();
    const protocol = attachWindowsJobObjectProtocol(child, control, token, 1_000);

    inbound.write(protocolLine(token, { kind: "ready", rootPid: 4242 }));
    await expect(protocol.ready).resolves.toEqual({ rootPid: 4242 });

    let settled = false;
    const termination = protocol.terminateAndReap().then(() => {
      settled = true;
    });
    await flushPromises();
    expect(outbound.join("")).toContain(`"kind":"terminate"`);

    emitClose(0, null);
    await flushPromises();
    expect(settled).toBe(false);

    inbound.write(protocolLine(token, {
      kind: "closed",
      exitCode: null,
      termination: "cancelled",
      treeEmpty: true,
    }));
    await termination;
    expect(settled).toBe(true);
  });

  it("rejects helper close without an acknowledgement after the control channel ends", async () => {
    const token = "test-token";
    const { child, emitClose } = fakeChild();
    const { control, inbound } = fakeControlChannel();
    const protocol = attachWindowsJobObjectProtocol(child, control, token, 1_000);

    inbound.write(protocolLine(token, { kind: "ready", rootPid: 4242 }));
    await expect(protocol.ready).resolves.toEqual({ rootPid: 4242 });
    emitClose(70, null);
    inbound.end();

    await expect(settleWithin(protocol.closed)).rejects.toThrow(
      "Windows agent process tree cleanup could not be verified.",
    );
  });

  it("rejects a malformed acknowledgement after helper close", async () => {
    const token = "test-token";
    const { child, emitClose } = fakeChild();
    const { control, inbound } = fakeControlChannel();
    const protocol = attachWindowsJobObjectProtocol(child, control, token, 1_000);

    inbound.write(protocolLine(token, { kind: "ready", rootPid: 4242 }));
    await expect(protocol.ready).resolves.toEqual({ rootPid: 4242 });
    inbound.write(`${JSON.stringify({ version: 1, token, kind: "closed", treeEmpty: true })}\n`);
    await expectPending(protocol.closed);
    emitClose(70, null);

    await expect(settleWithin(protocol.closed)).rejects.toThrow(
      "Windows agent process tree cleanup could not be verified.",
    );
  });

  it("uses the verified root-process result instead of the helper exit code", async () => {
    const token = "test-token";
    const { child, emitClose } = fakeChild();
    const { control, inbound } = fakeControlChannel();
    const protocol = attachWindowsJobObjectProtocol(child, control, token, 1_000);

    inbound.write(protocolLine(token, { kind: "ready", rootPid: 4242 }));
    inbound.write(protocolLine(token, {
      kind: "closed",
      exitCode: 17,
      termination: "normal",
      treeEmpty: true,
    }));
    emitClose(0, null);

    await expect(protocol.closed).resolves.toEqual({ exitCode: 17, signalCode: null });
  });

  it("rejects after helper close when the host reports treeEmpty false", async () => {
    const token = "test-token";
    const { child, emitClose } = fakeChild();
    const { control, inbound } = fakeControlChannel();
    const protocol = attachWindowsJobObjectProtocol(child, control, token, 1_000);
    inbound.write(protocolLine(token, { kind: "ready", rootPid: 4242 }));
    await expect(protocol.ready).resolves.toEqual({ rootPid: 4242 });
    inbound.write(protocolLine(token, {
      kind: "closed",
      exitCode: null,
      termination: "cancelled",
      treeEmpty: false,
    }));
    await expectPending(protocol.closed);

    emitClose(1, null);
    await expect(settleWithin(protocol.closed)).rejects.toThrow(
      "Windows agent process tree cleanup could not be verified.",
    );
  });

  it("rejects setup only after a verified tree-empty failure acknowledgement and helper close", async () => {
    const token = "test-token";
    const { child, emitClose } = fakeChild();
    const { control, inbound } = fakeControlChannel();
    const protocol = attachWindowsJobObjectProtocol(child, control, token, 1_000);
    let settled = false;
    void protocol.ready.catch(() => {
      settled = true;
    });

    inbound.write(protocolLine(token, {
      kind: "failed",
      stage: "setup",
      treeEmpty: true,
    }));
    await flushIo();
    expect(settled).toBe(false);

    emitClose(70, null);
    await expect(protocol.ready).rejects.toThrow("Windows Job Object process host is unavailable.");
    await expect(protocol.closed).rejects.toThrow("Windows Job Object process host is unavailable.");
  });

  it("waits for helper close when the verified acknowledgement arrives first", async () => {
    const token = "test-token";
    const { child, emitClose } = fakeChild();
    const { control, inbound } = fakeControlChannel();
    const protocol = attachWindowsJobObjectProtocol(child, control, token, 1_000);

    inbound.write(protocolLine(token, { kind: "ready", rootPid: 4242 }));
    await expect(protocol.ready).resolves.toEqual({ rootPid: 4242 });
    inbound.write(protocolLine(token, {
      kind: "closed",
      exitCode: 23,
      termination: "descendants-terminated",
      treeEmpty: true,
    }));
    await expectPending(protocol.closed);

    emitClose(0, null);
    await expect(protocol.closed).resolves.toEqual({ exitCode: 23, signalCode: null });
  });

  it("kills a hung helper once after the close acknowledgement timeout and rejects only after close", async () => {
    vi.useFakeTimers();
    try {
      const token = "test-token";
      const { child, emitClose, killSignals } = fakeChild({
        closeOnKill: false,
        killResult: false,
      });
      const { control, inbound } = fakeControlChannel();
      const protocol = attachWindowsJobObjectProtocol(child, control, token, 25);

      inbound.write(protocolLine(token, { kind: "ready", rootPid: 4242 }));
      await expect(protocol.ready).resolves.toEqual({ rootPid: 4242 });

      let rejectionCount = 0;
      let settled = false;
      const outcome = protocol.terminateAndReap().then(
        () => ({ status: "resolved" as const }),
        (error: unknown) => {
          rejectionCount += 1;
          return { status: "rejected" as const, error };
        },
      );
      void outcome.then(() => {
        settled = true;
      });

      await vi.advanceTimersByTimeAsync(25);
      await flushPromises();
      expect(killSignals).toEqual(["SIGKILL"]);
      expect(settled).toBe(false);
      expect(rejectionCount).toBe(0);

      emitClose(null, "SIGKILL");
      await expect(outcome).resolves.toEqual({
        status: "rejected",
        error: expect.objectContaining({
          message: "Windows agent process tree cleanup could not be verified.",
        }),
      });
      expect(rejectionCount).toBe(1);
      expect(killSignals).toEqual(["SIGKILL"]);
    } finally {
      vi.useRealTimers();
    }
  });

  it("does not kill more than once when terminate, malformed input, and helper errors race", async () => {
    const token = "test-token";
    const { child, emitClose, killSignals } = fakeChild({
      closeOnKill: false,
      killError: new Error("kill failed"),
    });
    const { control, inbound } = fakeControlChannel();
    const protocol = attachWindowsJobObjectProtocol(child, control, token, 1_000);

    inbound.write(protocolLine(token, { kind: "ready", rootPid: 4242 }));
    await expect(protocol.ready).resolves.toEqual({ rootPid: 4242 });

    const firstTermination = protocol.terminateAndReap();
    expect(protocol.terminateAndReap()).toBe(firstTermination);
    inbound.write("not-json\n");
    child.emit("error", new Error("helper failed"));
    child.emit("error", new Error("helper failed again"));
    await flushIo();

    expect(killSignals).toEqual(["SIGKILL"]);
    await expectPending(firstTermination);

    emitClose(null, "SIGKILL");
    await expect(firstTermination).rejects.toThrow(
      "Windows agent process tree cleanup could not be verified.",
    );
    expect(killSignals).toEqual(["SIGKILL"]);
  });

  it("rejects a non-zero helper exit even after a verified acknowledgement", async () => {
    const token = "test-token";
    const { child, emitClose } = fakeChild();
    const { control, inbound } = fakeControlChannel();
    const protocol = attachWindowsJobObjectProtocol(child, control, token, 1_000);

    inbound.write(protocolLine(token, { kind: "ready", rootPid: 4242 }));
    await expect(protocol.ready).resolves.toEqual({ rootPid: 4242 });
    inbound.write(protocolLine(token, {
      kind: "closed",
      exitCode: 0,
      termination: "normal",
      treeEmpty: true,
    }));
    await expectPending(protocol.closed);

    emitClose(70, null);
    await expect(settleWithin(protocol.closed)).rejects.toThrow(
      "Windows agent process tree cleanup could not be verified.",
    );
  });

  it.each([
    ["duplicate", { kind: "closed", exitCode: 17, termination: "normal", treeEmpty: true }],
    ["conflicting", { kind: "closed", exitCode: 18, termination: "normal", treeEmpty: true }],
  ] as const)("rejects %s terminal acknowledgements before helper close", async (_name, repeatedMessage) => {
    const token = "test-token";
    const { child, emitClose } = fakeChild();
    const { control, inbound } = fakeControlChannel();
    const protocol = attachWindowsJobObjectProtocol(child, control, token, 1_000);

    inbound.write(protocolLine(token, { kind: "ready", rootPid: 4242 }));
    await expect(protocol.ready).resolves.toEqual({ rootPid: 4242 });
    inbound.write(protocolLine(token, {
      kind: "closed",
      exitCode: 17,
      termination: "normal",
      treeEmpty: true,
    }));
    inbound.write(protocolLine(token, repeatedMessage));
    await expectPending(protocol.closed);

    emitClose(70, null);
    await expect(settleWithin(protocol.closed)).rejects.toThrow(
      "Windows agent process tree cleanup could not be verified.",
    );
  });

  it("packages the PowerShell Job Object host with AgentBridge", async () => {
    const helperUrl = new URL("../native/job-object-host.ps1", import.meta.url);
    const [helper, buildScript, packageJson] = await Promise.all([
      readFile(helperUrl, "utf8"),
      readFile(new URL("../../scripts/buildArtifactGate.mjs", import.meta.url), "utf8"),
      readFile(new URL("../../package.json", import.meta.url), "utf8"),
    ]);

    expect(helper).toContain("AssignProcessToJobObject");
    expect(helper).toContain("JobObjectBasicAccountingInformation");
    expect(helper).toContain("WriteFailed(controlWriter, token, treeEmpty);");
    expect(helper).not.toContain("Environment.TickCount64");
    expect(helper).not.toMatch(/DateTime\.(?:Now|UtcNow)|Environment\.TickCount/);
    expect(helper).toContain("System.Diagnostics.Stopwatch.GetTimestamp()");
    expect(helper).toContain("MonotonicDeadline");
    expect(helper).toContain("while (!deadline.IsReached())");
    expect(helper).toContain("Int64.MaxValue / frequency");
    expect(helper).toContain("Int64.MaxValue - timeoutTicks");
    const suspendedCreate = helper.indexOf("CREATE_SUSPENDED | CREATE_NO_WINDOW | CREATE_UNICODE_ENVIRONMENT");
    const assignment = helper.indexOf("Ensure(NativeMethods.AssignProcessToJobObject(job, processHandle));");
    const membershipCheck = helper.indexOf("if (QueryActiveProcesses(job) != 1) throw new InvalidOperationException();");
    const resume = helper.indexOf("if (NativeMethods.ResumeThread(threadHandle) == UInt32.MaxValue)");
    expect(suspendedCreate).toBeGreaterThan(-1);
    expect(suspendedCreate).toBeLessThan(assignment);
    expect(assignment).toBeLessThan(membershipCheck);
    expect(membershipCheck).toBeLessThan(resume);
    expect(buildScript).toMatch(/job-object-host\.ps1/);
    expect(packageJson).toMatch(/dist\/native\/job-object-host\.ps1/);
    await expect(stat(new URL("../../dist/native/job-object-host.ps1", import.meta.url)))
      .resolves.toEqual(expect.objectContaining({ size: expect.any(Number) }));
  });
});

function protocolLine(token: string, message: Record<string, unknown>): string {
  return `${JSON.stringify({ version: 1, token, ...message })}\n`;
}

function fakeControlChannel(): {
  control: Duplex;
  inbound: PassThrough;
  outbound: string[];
} {
  const inbound = new PassThrough();
  const outbound: string[] = [];
  const writable = new Writable({
    write(chunk, _encoding, callback) {
      outbound.push(chunk.toString("utf8"));
      callback();
    },
  });
  return {
    control: Duplex.from({ readable: inbound, writable }),
    inbound,
    outbound,
  };
}

function fakeChild(options: {
  closeOnKill?: boolean;
  killResult?: boolean;
  killError?: Error;
} = {}): {
  child: ChildProcess;
  emitClose: (exitCode: number | null, signalCode: NodeJS.Signals | null) => void;
  killSignals: Array<NodeJS.Signals | number | undefined>;
} {
  const emitter = new EventEmitter() as ChildProcess;
  const killSignals: Array<NodeJS.Signals | number | undefined> = [];
  const emitClose = (exitCode: number | null, signalCode: NodeJS.Signals | null) => {
    emitter.exitCode = exitCode;
    emitter.signalCode = signalCode;
    emitter.emit("close", exitCode, signalCode);
  };
  Object.assign(emitter, {
    stdout: new PassThrough(),
    stderr: new PassThrough(),
    stdin: null,
    pid: 1234,
    exitCode: null,
    signalCode: null,
    kill: (signal?: NodeJS.Signals | number) => {
      killSignals.push(signal);
      if (options.killError) throw options.killError;
      if (options.closeOnKill) {
        queueMicrotask(() => emitClose(null, typeof signal === "string" ? signal : null));
      }
      return options.killResult ?? true;
    },
  });
  return {
    child: emitter,
    emitClose,
    killSignals,
  };
}

async function flushPromises(): Promise<void> {
  for (let index = 0; index < 10; index += 1) await Promise.resolve();
}

async function flushIo(): Promise<void> {
  await new Promise<void>((resolve) => setImmediate(resolve));
  await flushPromises();
}

async function expectPending<T>(promise: Promise<T>): Promise<void> {
  let settled = false;
  void promise.then(
    () => {
      settled = true;
    },
    () => {
      settled = true;
    },
  );
  await flushIo();
  expect(settled).toBe(false);
}

function settleWithin<T>(promise: Promise<T>, timeoutMs = 250): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("Protocol promise did not settle.")), timeoutMs);
    void promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (error: unknown) => {
        clearTimeout(timer);
        reject(error);
      },
    );
  });
}
