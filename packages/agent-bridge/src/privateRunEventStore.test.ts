import {
  appendFile,
  chmod,
  lstat,
  mkdir,
  mkdtemp,
  open,
  readFile,
  rm,
  symlink,
  truncate,
  writeFile,
  type FileHandle,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";

import { afterEach, expect, it } from "vitest";

import { RUN_EVENT_PROTOCOL_VERSION, type RunEvent } from "@skyturn/project-core";
import { createDurableRunClaimStore } from "./durableRunClaim.js";
import { createPrivateRunEventStore } from "./privateRunEventStore.js";

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.map((root) => rm(root, { recursive: true, force: true })));
  roots.length = 0;
});

it("stores one exact private event replay under framed project and run hashes", async () => {
  const projectRoot = await tempRoot("project-sensitive-name");
  const privateRoot = await tempRoot("private-state");
  const claimStore = createDurableRunClaimStore({ root: privateRoot });
  const store = createPrivateRunEventStore({ durableRunClaimStore: claimStore });
  const runId = "run-sensitive-name";
  const event = runEvent(runId, 1, { text: "public output" });

  await store.prepare(projectRoot, projectRoot);
  await expect(Promise.all([
    store.append(projectRoot, event),
    store.append(projectRoot, event),
  ])).resolves.toEqual(["appended", "exists"]);
  await expect(store.append(projectRoot, event)).resolves.toBe("exists");

  const eventPath = await store.eventPath(projectRoot, runId);
  const bytes = await readFile(eventPath, "utf8");
  expect(basename(eventPath)).toMatch(/^[a-f0-9]{64}\.events\.ndjson$/);
  expect(eventPath).not.toContain(runId);
  expect(eventPath).not.toContain(basename(projectRoot));
  expect(bytes.split("\n").filter(Boolean)).toHaveLength(1);
  await expect(store.read(projectRoot, runId)).resolves.toEqual({ kind: "valid", events: [event] });

  await expect(store.append(projectRoot, runEvent(runId, 1, { text: "conflict" }))).rejects.toThrow(
    /event.*conflict/i,
  );
});

it("appends sequential events and preserves exact duplicate and conflict behavior", async () => {
  const projectRoot = await tempRoot("project-sequential-events");
  const privateRoot = await tempRoot("private-sequential-events");
  const store = createPrivateRunEventStore({
    durableRunClaimStore: createDurableRunClaimStore({ root: privateRoot }),
  });
  const events = [
    runEvent("run-sequential-events", 1, { text: "one" }),
    runEvent("run-sequential-events", 2, { text: "two" }),
    runEvent("run-sequential-events", 3, { text: "three" }),
  ];

  await store.prepare(projectRoot, projectRoot);
  await expect(store.append(projectRoot, events[0]!)).resolves.toBe("appended");
  await expect(store.append(projectRoot, events[1]!)).resolves.toBe("appended");
  await expect(store.append(projectRoot, events[2]!)).resolves.toBe("appended");
  await expect(store.append(projectRoot, events[0]!)).resolves.toBe("exists");
  await expect(store.append(projectRoot, runEvent(events[0]!.runId, 2, { text: "conflict" })))
    .rejects.toThrow(/event.*conflict/i);
  await expect(store.read(projectRoot, events[0]!.runId)).resolves.toEqual({ kind: "valid", events });
});

it("validates current bytes for latest retries and fully inspects older sequences", async () => {
  const projectRoot = await tempRoot("project-retry-validation");
  const privateRoot = await tempRoot("private-retry-validation");
  const instrumented = readCountingFileSystem();
  const store = createPrivateRunEventStore({
    durableRunClaimStore: createDurableRunClaimStore({ root: privateRoot }),
    fileSystem: instrumented.fileSystem,
  });
  const events = [
    runEvent("run-retry-validation", 1, { text: "one" }),
    runEvent("run-retry-validation", 2, { text: "two" }),
    runEvent("run-retry-validation", 3, { text: "three" }),
  ];
  await store.prepare(projectRoot, projectRoot);
  for (const event of events) await store.append(projectRoot, event);

  await expect(store.append(projectRoot, events[2]!)).resolves.toBe("exists");
  expect(instrumented.readFileCalls).toBe(0);
  expect(instrumented.readCalls).toBeGreaterThan(0);
  expect(instrumented.readBytes).toBe(Buffer.byteLength(`${JSON.stringify(events[2])}\n`));

  instrumented.readBytes = 0;
  instrumented.readCalls = 0;
  await expect(store.append(projectRoot, events[0]!)).resolves.toBe("exists");
  expect(instrumented.readFileCalls).toBe(1);
  expect(instrumented.readBytes).toBe(Buffer.byteLength(`${events.map(JSON.stringify).join("\n")}\n`));

  instrumented.readBytes = 0;
  instrumented.readFileCalls = 0;
  await expect(store.append(projectRoot, runEvent(events[0]!.runId, 2, { text: "conflict" })))
    .rejects.toThrow(/event.*conflict/i);
  expect(instrumented.readFileCalls).toBe(1);
  expect(instrumented.readBytes).toBe(Buffer.byteLength(`${events.map(JSON.stringify).join("\n")}\n`));
});

it("validates a reopened log once without rereading growing history on steady-state appends", async () => {
  const projectRoot = await tempRoot("project-incremental-events");
  const privateRoot = await tempRoot("private-incremental-events");
  const claimStore = createDurableRunClaimStore({ root: privateRoot });
  const initial = createPrivateRunEventStore({ durableRunClaimStore: claimStore });
  const runId = "run-incremental-events";
  await initial.prepare(projectRoot, projectRoot);
  for (let seq = 1; seq <= 12; seq += 1) {
    await initial.append(projectRoot, runEvent(runId, seq, { text: `initial-${seq}` }));
  }

  const instrumented = readCountingFileSystem();
  const reopened = createPrivateRunEventStore({
    durableRunClaimStore: claimStore,
    fileSystem: instrumented.fileSystem,
  });
  await expect(reopened.append(projectRoot, runEvent(runId, 13, { text: "first validated append" })))
    .resolves.toBe("appended");
  const validationBytes = instrumented.readBytes;
  expect(validationBytes).toBeGreaterThan(0);
  expect(instrumented.readFileCalls).toBe(1);
  expect(instrumented.readCalls).toBe(0);

  for (let seq = 14; seq <= 24; seq += 1) {
    await reopened.append(projectRoot, runEvent(runId, seq, { text: `steady-${seq}` }));
  }

  expect(instrumented.readFileCalls).toBe(1);
  expect(instrumented.readCalls).toBe(0);
  expect(instrumented.readBytes).toBe(validationBytes);
});

it("evicts least-recently-used append cursors while retaining active runs", async () => {
  const projectRoot = await tempRoot("project-cursor-eviction");
  const privateRoot = await tempRoot("private-cursor-eviction");
  const instrumented = readCountingFileSystem();
  const store = createPrivateRunEventStore({
    durableRunClaimStore: createDurableRunClaimStore({ root: privateRoot }),
    fileSystem: instrumented.fileSystem,
  });
  const runIds = Array.from({ length: 65 }, (_, index) => `run-cursor-${index + 1}`);
  await store.prepare(projectRoot, projectRoot);
  for (const runId of runIds.slice(0, 64)) {
    await store.append(projectRoot, runEvent(runId, 1, { text: runId }));
  }
  await store.append(projectRoot, runEvent(runIds[0]!, 2, { text: "recently used" }));

  instrumented.readBytes = 0;
  instrumented.readCalls = 0;
  instrumented.readFileCalls = 0;
  await store.append(projectRoot, runEvent(runIds[64]!, 1, { text: "force eviction" }));
  await store.append(projectRoot, runEvent(runIds[1]!, 2, { text: "evicted" }));
  expect(instrumented.readFileCalls).toBe(1);
  expect(instrumented.readBytes).toBeGreaterThan(0);
  const bytesAfterEvictedRun = instrumented.readBytes;

  await store.append(projectRoot, runEvent(runIds[0]!, 3, { text: "still cached" }));
  expect(instrumented.readFileCalls).toBe(1);
  expect(instrumented.readBytes).toBe(bytesAfterEvictedRun);
});

it("invalidates the append cursor after an external same-size mutation", async () => {
  const projectRoot = await tempRoot("project-mutated-events");
  const privateRoot = await tempRoot("private-mutated-events");
  const store = createPrivateRunEventStore({
    durableRunClaimStore: createDurableRunClaimStore({ root: privateRoot }),
  });
  const runId = "run-mutated-events";
  const original = runEvent(runId, 1, { text: "original" });
  const mutated = runEvent(runId, 1, { text: "tampered" });
  await store.prepare(projectRoot, projectRoot);
  await store.append(projectRoot, original);
  const eventPath = await store.eventPath(projectRoot, runId);
  const originalBytes = `${JSON.stringify(original)}\n`;
  const mutatedBytes = `${JSON.stringify(mutated)}\n`;
  expect(Buffer.byteLength(mutatedBytes)).toBe(Buffer.byteLength(originalBytes));
  await writeFile(eventPath, mutatedBytes, { mode: 0o600 });

  await expect(store.append(projectRoot, original)).rejects.toThrow(/event.*conflict/i);
  await expect(store.read(projectRoot, runId)).resolves.toEqual({ kind: "valid", events: [mutated] });
});

it("does not cache stale history rewritten at the pre-write race boundary", async () => {
  const projectRoot = await tempRoot("project-pre-write-mutation");
  const privateRoot = await tempRoot("private-pre-write-mutation");
  const claimStore = createDurableRunClaimStore({ root: privateRoot });
  const runId = "run-pre-write-mutation";
  const original = runEvent(runId, 1, { text: "original" });
  const mutated = runEvent(runId, 1, { text: "tampered" });
  const second = runEvent(runId, 2, { text: "second" });
  const eventPath = await claimStore.runStatePath(projectRoot, runId, "events");
  const originalBytes = `${JSON.stringify(original)}\n`;
  const mutatedBytes = `${JSON.stringify(mutated)}\n`;
  expect(Buffer.byteLength(mutatedBytes)).toBe(Buffer.byteLength(originalBytes));
  const mutation = preWriteMutationFileSystem(eventPath, mutatedBytes, 2);
  const store = createPrivateRunEventStore({
    durableRunClaimStore: claimStore,
    fileSystem: mutation.fileSystem,
  });
  await store.prepare(projectRoot, projectRoot);
  await store.append(projectRoot, original);

  await expect(store.append(projectRoot, second)).resolves.toBe("appended");
  expect(mutation.mutations).toBe(1);
  await expect(store.append(projectRoot, original)).rejects.toThrow(/event.*conflict/i);
  await expect(store.read(projectRoot, runId)).resolves.toEqual({
    kind: "valid",
    events: [mutated, second],
  });
});

it("invalidates the append cursor after external truncation", async () => {
  const projectRoot = await tempRoot("project-truncated-events");
  const privateRoot = await tempRoot("private-truncated-events");
  const store = createPrivateRunEventStore({
    durableRunClaimStore: createDurableRunClaimStore({ root: privateRoot }),
  });
  const runId = "run-truncated-events";
  await store.prepare(projectRoot, projectRoot);
  await store.append(projectRoot, runEvent(runId, 1, { text: "complete" }));
  const eventPath = await store.eventPath(projectRoot, runId);
  const bytes = await readFile(eventPath);
  await truncate(eventPath, bytes.byteLength - 1);

  await expect(store.append(projectRoot, runEvent(runId, 2, { text: "must fail" }))).rejects.toThrow(
    /private run event state is invalid/i,
  );
});

it("reopens, validates, and continues the next sequence", async () => {
  const projectRoot = await tempRoot("project-reopen-sequence");
  const privateRoot = await tempRoot("private-reopen-sequence");
  const claimStore = createDurableRunClaimStore({ root: privateRoot });
  const first = runEvent("run-reopen-sequence", 1, { text: "first" });
  const second = runEvent(first.runId, 2, { text: "second" });
  const initial = createPrivateRunEventStore({ durableRunClaimStore: claimStore });
  await initial.prepare(projectRoot, projectRoot);
  await initial.append(projectRoot, first);

  const reopened = createPrivateRunEventStore({ durableRunClaimStore: claimStore });
  await expect(reopened.append(projectRoot, second)).resolves.toBe("appended");
  await expect(reopened.read(projectRoot, first.runId)).resolves.toEqual({
    kind: "valid",
    events: [first, second],
  });
});

it("syncs the shared project directory hierarchy before the first private event file", async () => {
  const projectRoot = await tempRoot("project-event-hierarchy");
  const privateRoot = await tempRoot("private-event-hierarchy");
  const operations: string[] = [];
  const store = createPrivateRunEventStore({
    durableRunClaimStore: createDurableRunClaimStore({ root: privateRoot }),
    platform: "linux",
    fileSystem: pathRecordingFileSystem(operations),
  });
  const event = runEvent("run-event-hierarchy", 1, { text: "durable hierarchy" });
  const eventPath = await store.eventPath(projectRoot, event.runId);

  await expect(store.append(projectRoot, event)).resolves.toBe("appended");

  expect(operations.filter((operation) => operation.startsWith("sync:"))).toEqual([
    `sync:directory:${dirname(dirname(eventPath))}`,
    `sync:file:${eventPath}`,
    `sync:directory:${dirname(eventPath)}`,
  ]);
});

it("re-syncs the file and parent directory before a steady-state append", async () => {
  const projectRoot = await tempRoot("project-steady-sync");
  const privateRoot = await tempRoot("private-steady-sync");
  const operations: string[] = [];
  const store = createPrivateRunEventStore({
    durableRunClaimStore: createDurableRunClaimStore({ root: privateRoot }),
    platform: "linux",
    fileSystem: pathRecordingFileSystem(operations),
  });
  const first = runEvent("run-steady-sync", 1, { text: "first" });
  const eventPath = await store.eventPath(projectRoot, first.runId);
  await store.append(projectRoot, first);
  operations.length = 0;

  await expect(store.append(projectRoot, runEvent(first.runId, 2, { text: "second" })))
    .resolves.toBe("appended");

  expect(operations.filter((operation) => operation.startsWith("sync:"))).toEqual([
    `sync:file:${eventPath}`,
    `sync:directory:${dirname(eventPath)}`,
    `sync:directory:${dirname(dirname(eventPath))}`,
    `sync:file:${eventPath}`,
  ]);
});

it("fails closed on a torn private final line without consulting project state", async () => {
  const projectRoot = await tempRoot("project-torn-state");
  const privateRoot = await tempRoot("private-torn-state");
  const store = createPrivateRunEventStore({
    durableRunClaimStore: createDurableRunClaimStore({ root: privateRoot }),
  });
  const runId = "run-torn-private-state";
  await store.prepare(projectRoot, projectRoot);
  await store.append(projectRoot, runEvent(runId, 1, { text: "complete" }));
  await appendFile(await store.eventPath(projectRoot, runId), '{"protocolVersion":1');

  await expect(store.read(projectRoot, runId)).resolves.toEqual({ kind: "invalid" });
  await expect(store.append(projectRoot, runEvent(runId, 2, { text: "must fail" }))).rejects.toThrow(
    /private run event state is invalid/i,
  );
});

it("does not treat readable page-cache bytes as durable when file re-sync fails", async () => {
  const projectRoot = await tempRoot("project-readable-unsynced");
  const privateRoot = await tempRoot("private-readable-unsynced");
  const fault = syncFaultFileSystem(({ target }) => target === "file" ? "EIO" : null);
  const options = {
    durableRunClaimStore: createDurableRunClaimStore({ root: privateRoot }),
    fileSystem: fault.fileSystem,
  };
  const store = createPrivateRunEventStore(options);
  const event = runEvent("run-readable-unsynced", 1, { text: "page-cache bytes" });
  await store.prepare(projectRoot, projectRoot);

  await expect(store.append(projectRoot, event)).rejects.toMatchObject({ code: "EIO" });
  await expect(store.read(projectRoot, event.runId)).resolves.toEqual({ kind: "invalid" });
  expect(fault.syncTargets).toEqual(["directory", "file", "file"]);
  expect((await readFile(await store.eventPath(projectRoot, event.runId), "utf8")).split("\n").filter(Boolean)).toHaveLength(1);
});

it.each(["EIO", "EPERM"])(
  "rejects valid readable private events when authoritative file sync returns %s",
  async (code) => {
    const projectRoot = await tempRoot(`project-read-file-${code.toLowerCase()}`);
    const privateRoot = await tempRoot(`private-read-file-${code.toLowerCase()}`);
    const claimStore = createDurableRunClaimStore({ root: privateRoot });
    const event = terminalRunEvent(`run-read-file-${code.toLowerCase()}`);
    const initial = createPrivateRunEventStore({ durableRunClaimStore: claimStore });
    await initial.prepare(projectRoot, projectRoot);
    await initial.append(projectRoot, event);
    const fault = syncFaultFileSystem(({ target }) => target === "file" ? code : null);
    const reopened = createPrivateRunEventStore({ durableRunClaimStore: claimStore, fileSystem: fault.fileSystem });

    await expect(reopened.read(projectRoot, event.runId)).resolves.toEqual({ kind: "invalid" });
    expect(fault.syncTargets).toEqual(["file"]);
  },
);

it.each(["EIO", "EPERM"])(
  "rejects valid readable private events when authoritative directory sync returns %s",
  async (code) => {
    const projectRoot = await tempRoot(`project-read-directory-${code.toLowerCase()}`);
    const privateRoot = await tempRoot(`private-read-directory-${code.toLowerCase()}`);
    const claimStore = createDurableRunClaimStore({ root: privateRoot });
    const event = terminalRunEvent(`run-read-directory-${code.toLowerCase()}`);
    const initial = createPrivateRunEventStore({ durableRunClaimStore: claimStore });
    await initial.prepare(projectRoot, projectRoot);
    await initial.append(projectRoot, event);
    const fault = syncFaultFileSystem(({ target }) => target === "directory" ? code : null);
    const reopened = createPrivateRunEventStore({ durableRunClaimStore: claimStore, fileSystem: fault.fileSystem });

    await expect(reopened.read(projectRoot, event.runId)).resolves.toEqual({ kind: "invalid" });
    expect(fault.syncTargets).toEqual(["file", "directory"]);
  },
);

it.each(["file", "directory"] as const)(
  "repairs readable terminal bytes after a crashed %s sync failure only when authoritative re-sync succeeds",
  async (target) => {
    const projectRoot = await tempRoot(`project-crash-${target}`);
    const privateRoot = await tempRoot(`private-crash-${target}`);
    const claimStore = createDurableRunClaimStore({ root: privateRoot });
    const event = terminalRunEvent(`run-crash-${target}`);
    const eventPath = await claimStore.runStatePath(projectRoot, event.runId, "events");
    const writeFault = syncFaultFileSystem(({ target: syncTarget, path }) =>
      syncTarget === target && (target === "file" || path === dirname(eventPath)) ? "EIO" : null);
    const writer = createPrivateRunEventStore({ durableRunClaimStore: claimStore, fileSystem: writeFault.fileSystem });
    await writer.prepare(projectRoot, projectRoot);
    await expect(writer.append(projectRoot, event)).rejects.toMatchObject({ code: "EIO" });

    const readFault = syncFaultFileSystem(({ target: syncTarget, path }) =>
      syncTarget === target && (target === "file" || path === dirname(eventPath)) ? "EIO" : null);
    const unavailable = createPrivateRunEventStore({ durableRunClaimStore: claimStore, fileSystem: readFault.fileSystem });
    await expect(unavailable.read(projectRoot, event.runId)).resolves.toEqual({ kind: "invalid" });

    const repairedFault = syncFaultFileSystem(() => null);
    const repaired = createPrivateRunEventStore({ durableRunClaimStore: claimStore, fileSystem: repairedFault.fileSystem });
    await expect(repaired.read(projectRoot, event.runId)).resolves.toEqual({ kind: "valid", events: [event] });
    expect(repairedFault.syncTargets).toEqual(["file", "directory"]);
    expect((await readFile(await repaired.eventPath(projectRoot, event.runId), "utf8")).split("\n").filter(Boolean)).toHaveLength(1);
  },
);

it("allows a later authoritative read to repair a one-shot re-sync failure", async () => {
  const projectRoot = await tempRoot("project-read-one-shot");
  const privateRoot = await tempRoot("private-read-one-shot");
  const claimStore = createDurableRunClaimStore({ root: privateRoot });
  const event = terminalRunEvent("run-read-one-shot");
  const initial = createPrivateRunEventStore({ durableRunClaimStore: claimStore });
  await initial.prepare(projectRoot, projectRoot);
  await initial.append(projectRoot, event);
  const fault = syncFaultFileSystem(({ target, attempt }) => target === "file" && attempt === 1 ? "EIO" : null);
  const reopened = createPrivateRunEventStore({ durableRunClaimStore: claimStore, fileSystem: fault.fileSystem });

  await expect(reopened.read(projectRoot, event.runId)).resolves.toEqual({ kind: "invalid" });
  await expect(reopened.read(projectRoot, event.runId)).resolves.toEqual({ kind: "valid", events: [event] });
  expect(fault.syncTargets).toEqual(["file", "file", "directory"]);
});

it.each(["symlink", "directory"] as const)("fails closed when the private event path is a %s", async (state) => {
  const projectRoot = await tempRoot(`project-read-${state}`);
  const privateRoot = await tempRoot(`private-read-${state}`);
  const store = createPrivateRunEventStore({
    durableRunClaimStore: createDurableRunClaimStore({ root: privateRoot }),
  });
  const event = terminalRunEvent(`run-read-${state}`);
  await store.prepare(projectRoot, projectRoot);
  await store.append(projectRoot, event);
  const eventPath = await store.eventPath(projectRoot, event.runId);
  await rm(eventPath);
  if (state === "symlink") {
    const target = join(privateRoot, "forged-events.ndjson");
    await writeFile(target, `${JSON.stringify(event)}\n`, { mode: 0o600 });
    await symlink(target, eventPath);
  } else {
    await mkdir(eventPath);
  }

  await expect(store.read(projectRoot, event.runId)).resolves.toEqual({ kind: "invalid" });
});

it("keeps reporting permanent file sync failure when the exact final record is readable", async () => {
  const projectRoot = await tempRoot("project-permanent-sync");
  const privateRoot = await tempRoot("private-permanent-sync");
  const fault = syncFaultFileSystem(({ target }) => target === "file" ? "EPERM" : null);
  const options = {
    durableRunClaimStore: createDurableRunClaimStore({ root: privateRoot }),
    fileSystem: fault.fileSystem,
  };
  const store = createPrivateRunEventStore(options);
  const event = runEvent("run-permanent-sync", 1, { text: "not durable" });
  await store.prepare(projectRoot, projectRoot);

  await expect(store.append(projectRoot, event)).rejects.toMatchObject({ code: "EPERM" });
  await expect(store.append(projectRoot, event)).rejects.toThrow(/private run event state is invalid/i);
  expect(fault.syncTargets).toEqual(["directory", "file", "file"]);
  expect((await readFile(await store.eventPath(projectRoot, event.runId), "utf8")).split("\n").filter(Boolean)).toHaveLength(1);
});

it("re-syncs one readable final record after a one-shot file sync failure", async () => {
  const projectRoot = await tempRoot("project-transient-sync");
  const privateRoot = await tempRoot("private-transient-sync");
  const fault = syncFaultFileSystem(({ target, attempt }) => target === "file" && attempt === 1 ? "EIO" : null);
  const options = {
    durableRunClaimStore: createDurableRunClaimStore({ root: privateRoot }),
    fileSystem: fault.fileSystem,
  };
  const store = createPrivateRunEventStore(options);
  const event = runEvent("run-transient-sync", 1, { text: "durable after retry" });
  await store.prepare(projectRoot, projectRoot);

  await expect(store.append(projectRoot, event)).rejects.toMatchObject({ code: "EIO" });
  await expect(store.append(projectRoot, event)).resolves.toBe("exists");
  expect(fault.syncTargets).toEqual(["directory", "file", "file", "directory"]);
  expect((await readFile(await store.eventPath(projectRoot, event.runId), "utf8")).split("\n").filter(Boolean)).toHaveLength(1);
});

it("invalidates the cursor when pre-append re-sync fails and retries without writing early", async () => {
  const projectRoot = await tempRoot("project-cursor-sync-retry");
  const privateRoot = await tempRoot("private-cursor-sync-retry");
  const claimStore = createDurableRunClaimStore({ root: privateRoot });
  const eventPath = await claimStore.runStatePath(projectRoot, "run-cursor-sync-retry", "events");
  const fault = syncFaultFileSystem(({ target, path, attempt }) =>
    target === "file" && path === eventPath && attempt === 2 ? "EIO" : null);
  const store = createPrivateRunEventStore({
    durableRunClaimStore: claimStore,
    fileSystem: fault.fileSystem,
  });
  const first = runEvent("run-cursor-sync-retry", 1, { text: "first" });
  const second = runEvent(first.runId, 2, { text: "second" });
  await store.prepare(projectRoot, projectRoot);
  await store.append(projectRoot, first);

  await expect(store.append(projectRoot, second)).rejects.toThrow(/private run event state is invalid/i);
  expect((await readFile(eventPath, "utf8")).split("\n").filter(Boolean)).toHaveLength(1);
  await expect(store.append(projectRoot, second)).resolves.toBe("appended");
  expect((await readFile(eventPath, "utf8")).split("\n").filter(Boolean)).toHaveLength(2);
});

it("retries parent-directory durability after file creation without duplicating the record", async () => {
  const projectRoot = await tempRoot("project-directory-sync");
  const privateRoot = await tempRoot("private-directory-sync");
  const event = runEvent("run-directory-sync", 1, { text: "directory durable after retry" });
  const eventPath = await createDurableRunClaimStore({ root: privateRoot }).runStatePath(
    projectRoot,
    event.runId,
    "events",
  );
  const fault = syncFaultFileSystem(({ target, path, attempt }) =>
    target === "directory" && path === dirname(eventPath) && attempt === 1 ? "EIO" : null);
  const options = {
    durableRunClaimStore: createDurableRunClaimStore({ root: privateRoot }),
    fileSystem: fault.fileSystem,
  };
  const store = createPrivateRunEventStore(options);
  await store.prepare(projectRoot, projectRoot);

  await expect(store.append(projectRoot, event)).rejects.toMatchObject({ code: "EIO" });
  await expect(store.append(projectRoot, event)).resolves.toBe("exists");
  expect(fault.syncTargets).toEqual(["directory", "file", "directory", "file", "directory"]);
  expect((await readFile(await store.eventPath(projectRoot, event.runId), "utf8")).split("\n").filter(Boolean)).toHaveLength(1);
});

it("does not exempt parent-directory EPERM from durability", async () => {
  const projectRoot = await tempRoot("project-directory-eperm");
  const privateRoot = await tempRoot("private-directory-eperm");
  const event = runEvent("run-directory-eperm", 1, { text: "directory not durable" });
  const eventPath = await createDurableRunClaimStore({ root: privateRoot }).runStatePath(
    projectRoot,
    event.runId,
    "events",
  );
  const fault = syncFaultFileSystem(({ target, path }) =>
    target === "directory" && path === dirname(eventPath) ? "EPERM" : null);
  const options = {
    durableRunClaimStore: createDurableRunClaimStore({ root: privateRoot }),
    fileSystem: fault.fileSystem,
  };
  const store = createPrivateRunEventStore(options);
  await store.prepare(projectRoot, projectRoot);

  await expect(store.append(projectRoot, event)).rejects.toMatchObject({ code: "EPERM" });
  await expect(store.append(projectRoot, event)).rejects.toThrow(/private run event state is invalid/i);
  expect(fault.syncTargets).toEqual(["directory", "file", "directory", "file", "directory"]);
  expect((await readFile(await store.eventPath(projectRoot, event.runId), "utf8")).split("\n").filter(Boolean)).toHaveLength(1);
});

it("re-durabilizes an exact duplicate after reopening the private store", async () => {
  const projectRoot = await tempRoot("project-reopen-sync");
  const privateRoot = await tempRoot("private-reopen-sync");
  const claimStore = createDurableRunClaimStore({ root: privateRoot });
  const event = runEvent("run-reopen-sync", 1, { text: "reopened duplicate" });
  const initial = createPrivateRunEventStore({ durableRunClaimStore: claimStore });
  await initial.prepare(projectRoot, projectRoot);
  await initial.append(projectRoot, event);
  const fault = syncFaultFileSystem(() => null);
  const options = { durableRunClaimStore: claimStore, fileSystem: fault.fileSystem };
  const reopened = createPrivateRunEventStore(options);

  await expect(reopened.append(projectRoot, event)).resolves.toBe("exists");
  expect(fault.syncTargets).toEqual(["file", "directory"]);
  expect((await readFile(await reopened.eventPath(projectRoot, event.runId), "utf8")).split("\n").filter(Boolean)).toHaveLength(1);
});

it("serializes concurrent exact duplicates through durable re-sync without duplicate lines", async () => {
  const projectRoot = await tempRoot("project-concurrent-sync");
  const privateRoot = await tempRoot("private-concurrent-sync");
  const fault = syncFaultFileSystem(() => null);
  const options = {
    durableRunClaimStore: createDurableRunClaimStore({ root: privateRoot }),
    fileSystem: fault.fileSystem,
  };
  const store = createPrivateRunEventStore(options);
  const event = runEvent("run-concurrent-sync", 1, { text: "one line" });
  await store.prepare(projectRoot, projectRoot);

  const results = await Promise.all([store.append(projectRoot, event), store.append(projectRoot, event)]);
  expect(results.sort()).toEqual(["appended", "exists"]);
  expect(fault.syncTargets).toEqual(["directory", "file", "directory", "file", "directory"]);
  expect((await readFile(await store.eventPath(projectRoot, event.runId), "utf8")).split("\n").filter(Boolean)).toHaveLength(1);
});

function runEvent(runId: string, seq: number, payload: Record<string, unknown>): RunEvent {
  return {
    protocolVersion: RUN_EVENT_PROTOCOL_VERSION,
    runId,
    seq,
    timestamp: new Date(Date.UTC(2026, 6, 15, 0, 0, seq)).toISOString(),
    kind: "output",
    payload,
  };
}

function readCountingFileSystem() {
  const metrics = {
    readBytes: 0,
    readCalls: 0,
    readFileCalls: 0,
    fileSystem: {
      chmod,
      lstat,
      mkdir,
      async open(path: string, flags: string | number, mode?: number): Promise<FileHandle> {
        const handle = await open(path, flags, mode);
        return new Proxy(handle, {
          get(value, property) {
            if (property === "readFile") {
              return async (...args: Parameters<FileHandle["readFile"]>) => {
                const bytes = await value.readFile(...args);
                metrics.readFileCalls += 1;
                metrics.readBytes += Buffer.byteLength(bytes);
                return bytes;
              };
            }
            if (property === "read") {
              return async (...args: Parameters<FileHandle["read"]>) => {
                const result = await value.read(...args);
                metrics.readCalls += 1;
                metrics.readBytes += result.bytesRead;
                return result;
              };
            }
            const member = Reflect.get(value, property, value) as unknown;
            return typeof member === "function" ? member.bind(value) : member;
          },
        });
      },
    },
  };
  return metrics;
}

function preWriteMutationFileSystem(
  targetPath: string,
  replacement: string,
  targetWrite: number,
) {
  const state = {
    fileSystem: {
      chmod,
      lstat,
      mkdir,
      async open(path: string, flags: string | number, mode?: number): Promise<FileHandle> {
        const handle = await open(path, flags, mode);
        return new Proxy(handle, {
          get(value, property) {
            if (property === "write") {
              return async (bytes: Uint8Array) => {
                if (path === targetPath) {
                  state.writes += 1;
                  if (state.writes === targetWrite) {
                    await writeFile(targetPath, replacement, { mode: 0o600 });
                    state.mutations += 1;
                  }
                }
                return value.write(bytes);
              };
            }
            const member = Reflect.get(value, property, value) as unknown;
            return typeof member === "function" ? member.bind(value) : member;
          },
        });
      },
    },
    mutations: 0,
    writes: 0,
  };
  return state;
}

function terminalRunEvent(runId: string): RunEvent {
  return {
    protocolVersion: RUN_EVENT_PROTOCOL_VERSION,
    runId,
    seq: 1,
    timestamp: "2026-07-15T00:00:01.000Z",
    kind: "status",
    payload: { status: "succeeded", exitCode: 0 },
  };
}

async function tempRoot(label: string): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), `skyturn-${label}-`));
  roots.push(root);
  return root;
}

type SyncTarget = "file" | "directory";

function syncFaultFileSystem(
  fault: (input: { target: SyncTarget; path: string; attempt: number }) => string | null,
): {
  fileSystem: {
    chmod: typeof chmod;
    lstat: typeof lstat;
    mkdir: typeof mkdir;
    open(path: string, flags: string | number, mode?: number): Promise<FileHandle>;
  };
  syncTargets: SyncTarget[];
} {
  const syncTargets: SyncTarget[] = [];
  const attempts = new Map<string, number>();
  return {
    fileSystem: {
      chmod,
      lstat,
      mkdir,
      async open(path, flags, mode) {
        const handle = await open(path, flags, mode);
        const target: SyncTarget = typeof flags === "string" ? "directory" : "file";
        return new Proxy(handle, {
          get(value, property) {
            if (property === "sync") {
              return async () => {
                const key = `${target}:${path}`;
                const attempt = (attempts.get(key) ?? 0) + 1;
                attempts.set(key, attempt);
                syncTargets.push(target);
                const code = fault({ target, path, attempt });
                if (code) throw Object.assign(new Error(`injected ${target} sync failure`), { code });
                await value.sync();
              };
            }
            const member = Reflect.get(value, property, value) as unknown;
            return typeof member === "function" ? member.bind(value) : member;
          },
        });
      },
    },
    syncTargets,
  };
}

function pathRecordingFileSystem(operations: string[]) {
  return {
    chmod,
    lstat,
    mkdir,
    async open(path: string, flags: string | number, mode?: number): Promise<FileHandle> {
      const handle = await open(path, flags, mode);
      const directory = (await handle.stat()).isDirectory();
      return new Proxy(handle, {
        get(value, property) {
          if (property === "sync") {
            return async () => {
              operations.push(`sync:${directory ? "directory" : "file"}:${path}`);
              await value.sync();
            };
          }
          const member = Reflect.get(value, property, value) as unknown;
          return typeof member === "function" ? member.bind(value) : member;
        },
      });
    },
  };
}
