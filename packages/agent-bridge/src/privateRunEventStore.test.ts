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
    timestamp: `2026-07-15T00:00:0${seq}.000Z`,
    kind: "output",
    payload,
  };
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
