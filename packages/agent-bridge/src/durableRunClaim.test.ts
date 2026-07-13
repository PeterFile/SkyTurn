import {
  chmod,
  lstat,
  mkdir,
  mkdtemp,
  open,
  readFile,
  realpath,
  rm,
  stat,
  symlink,
  type FileHandle,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, relative, join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import * as durableClaimModule from "./durableRunClaim.js";

interface TestClaim {
  runId: string;
  nodeId: string;
  sessionId: string;
  agentKind: "codex";
  startFingerprint: string;
  startedAt: string;
}

interface TestClaimStore {
  initialize(): Promise<void>;
  prepare(projectRoot: string, worktreePath?: string): Promise<void>;
  markerPath(projectRoot: string, runId: string): Promise<string>;
  publish(projectRoot: string, claim: TestClaim): Promise<"published" | "exists">;
  read(projectRoot: string, runId: string): Promise<
    { kind: "missing" } | { kind: "invalid" } | { kind: "valid"; claim: TestClaim }
  >;
}

interface TestFileSystem {
  realpath(path: string): Promise<string>;
  mkdir(path: string, options: { recursive?: boolean; mode: number }): Promise<unknown>;
  chmod(path: string, mode: number): Promise<void>;
  lstat(path: string): ReturnType<typeof lstat>;
  open(path: string, flags: string | number, mode?: number): Promise<FileHandle>;
}

type CreateStore = (options: {
  root: string;
  platform?: NodeJS.Platform;
  fileSystem?: TestFileSystem;
  getUid?: () => number | undefined;
}) => TestClaimStore;

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.map((root) => rm(root, { recursive: true, force: true })));
  roots.length = 0;
});

describe("backend-owned durable run claims", () => {
  it("publishes a complete private claim under bounded canonical project and run keys", async () => {
    const { root, projectRoot, store } = await makeStore();

    await expect(store.publish(projectRoot, claim())).resolves.toBe("published");

    const markerPath = await store.markerPath(projectRoot, claim().runId);
    const markerRelativePath = relative(root, markerPath);
    const markerText = await readFile(markerPath, "utf8");
    expect(markerRelativePath).toMatch(/^[a-f0-9]{64}\/[a-f0-9]{64}\.json$/);
    expect(markerRelativePath).not.toContain(projectRoot);
    expect(markerRelativePath).not.toContain(claim().runId);
    expect(markerText).not.toContain(projectRoot);
    expect(markerText).not.toContain("prompt-secret");
    expect(markerText).not.toContain("resume-secret");
    expect(JSON.parse(markerText)).toEqual(claim());
    expect((await stat(root)).mode & 0o777).toBe(0o700);
    expect((await stat(markerPath)).mode & 0o777).toBe(0o600);
    expect((await stat(join(root, markerRelativePath.split("/")[0]!))).mode & 0o777).toBe(0o700);
    await expect(store.read(projectRoot, claim().runId)).resolves.toEqual({ kind: "valid", claim: claim() });
  });

  it.each(["project", "worktree"] as const)(
    "rejects a configured claim root inside the canonical %s tree",
    async (boundary) => {
      const base = await makeRoot("skyturn-claim-boundary-");
      const projectRoot = join(base, "project");
      const worktreePath = join(base, "worktree");
      await mkdir(projectRoot);
      await mkdir(worktreePath);
      const claimRoot = join(boundary === "project" ? projectRoot : worktreePath, ".private", "run-claims");
      const store = createStore({ root: claimRoot });

      const failure = await store.prepare(projectRoot, worktreePath).catch((error: unknown) => error);

      expect(String(failure)).toContain("run-start-claim-boundary-invalid");
      expect(String(failure)).not.toContain(projectRoot);
      expect(String(failure)).not.toContain(worktreePath);
    },
  );

  it("rejects a configured claim root that is itself a symlink", async () => {
    const base = await makeRoot("skyturn-claim-root-symlink-");
    const projectRoot = join(base, "project");
    const actualRoot = join(base, "actual-claims");
    const linkedRoot = join(base, "linked-claims");
    await mkdir(projectRoot);
    await mkdir(actualRoot, { mode: 0o700 });
    await symlink(actualRoot, linkedRoot);
    const store = createStore({ root: linkedRoot });

    await expect(store.prepare(projectRoot)).rejects.toThrow("run-start-claim-boundary-invalid");
  });

  it("rejects symlinked components in the configured claim root", async () => {
    const base = await makeRoot("skyturn-claim-root-component-symlink-");
    const projectRoot = join(base, "project");
    const actualParent = join(base, "actual-private-state");
    const linkedParent = join(base, "linked-private-state");
    await mkdir(projectRoot);
    await mkdir(actualParent, { mode: 0o700 });
    await symlink(actualParent, linkedParent);
    const store = createStore({ root: join(linkedParent, "run-claims") });

    await expect(store.prepare(projectRoot)).rejects.toThrow("run-start-claim-boundary-invalid");
  });

  it("canonicalizes typed claim property order before publishing", async () => {
    const { projectRoot, store } = await makeStore();
    const value = claim();
    const reordered = {
      startedAt: value.startedAt,
      startFingerprint: value.startFingerprint,
      agentKind: value.agentKind,
      sessionId: value.sessionId,
      nodeId: value.nodeId,
      runId: value.runId,
    };

    await expect(store.publish(projectRoot, reordered)).resolves.toBe("published");
    await expect(store.read(projectRoot, value.runId)).resolves.toEqual({ kind: "valid", claim: value });
  });

  it("uses the same claim key for canonical project aliases and reopened stores", async () => {
    const { root, projectRoot, store } = await makeStore();
    const alias = join(root, "project-alias");
    await mkdir(root, { recursive: true, mode: 0o700 });
    await symlink(projectRoot, alias);
    const reopened = createStore({ root });

    expect(await store.markerPath(projectRoot, claim().runId)).toBe(
      await reopened.markerPath(alias, claim().runId),
    );
  });

  it("keeps the claim discoverable when the project directory is replaced at the same path", async () => {
    const { root, projectRoot, store } = await makeStore();
    await store.publish(projectRoot, claim());
    const markerPath = await store.markerPath(projectRoot, claim().runId);
    const runDirectory = join(projectRoot, ".devflow", "runs", claim().runId);
    await mkdir(runDirectory, { recursive: true });
    await rm(runDirectory, { recursive: true });
    await mkdir(runDirectory, { recursive: true });
    await rm(projectRoot, { recursive: true });
    await mkdir(projectRoot);

    expect(await store.markerPath(projectRoot, claim().runId)).toBe(markerPath);
    expect(relative(root, markerPath)).toMatch(/^[a-f0-9]{64}\/[a-f0-9]{64}\.json$/);
    await expect(createStore({ root }).read(projectRoot, claim().runId)).resolves.toEqual({
      kind: "valid",
      claim: claim(),
    });
  });

  it.each(["darwin", "linux", "win32"] as const)(
    "uses exclusive final creation without a platform capability failure for %s semantics",
    async (platform) => {
      const root = await makeRoot("skyturn-claim-platform-");
      const projectRoot = join(root, "project");
      const claimRoot = join(root, "claims");
      await mkdir(projectRoot);
      const operations: string[] = [];
      const fileSystem = recordingFileSystem(operations);
      const store = createStore({ root: claimRoot, platform, fileSystem });

      await expect(store.publish(projectRoot, claim())).resolves.toBe("published");

      expect(operations).toContain("open:wx:384");
      expect(operations).toContain("file-sync");
      expect(operations).toContain("file-close");
      expect(operations.includes("directory-sync")).toBe(platform !== "win32");
    },
  );

  it("syncs each exact hierarchy entry before publishing a marker", async () => {
    const base = await makeRoot("skyturn-claim-hierarchy-");
    const projectRoot = join(base, "project");
    const claimRoot = join(base, "claims");
    await mkdir(projectRoot);
    await mkdir(claimRoot, { mode: 0o700 });
    const operations: string[] = [];
    const store = createStore({
      root: claimRoot,
      platform: "linux",
      fileSystem: pathRecordingFileSystem(operations),
    });

    await expect(store.publish(projectRoot, claim())).resolves.toBe("published");

    const markerPath = await store.markerPath(projectRoot, claim().runId);
    expect(operations.filter((operation) => operation.startsWith("sync:"))).toEqual([
      `sync:directory:${dirname(claimRoot)}`,
      `sync:directory:${claimRoot}`,
      `sync:file:${markerPath}`,
      `sync:directory:${dirname(markerPath)}`,
    ]);
  });

  it("creates multiple missing root components and syncs each containing parent in order", async () => {
    const base = await makeRoot("skyturn-claim-missing-hierarchy-");
    const projectRoot = join(base, "project");
    const privateState = join(base, "private-state");
    const skyturnState = join(privateState, "skyturn");
    const claimRoot = join(skyturnState, "claims");
    await mkdir(projectRoot);
    const operations: string[] = [];
    const store = createStore({
      root: claimRoot,
      platform: "linux",
      fileSystem: pathRecordingFileSystem(operations),
    });

    await expect(store.publish(projectRoot, claim())).resolves.toBe("published");

    const markerPath = await store.markerPath(projectRoot, claim().runId);
    expect(operations.filter((operation) => operation.startsWith("mkdir:") || operation.startsWith("sync:")))
      .toEqual([
        `mkdir:${privateState}`,
        `sync:directory:${base}`,
        `mkdir:${skyturnState}`,
        `sync:directory:${privateState}`,
        `mkdir:${claimRoot}`,
        `sync:directory:${skyturnState}`,
        `mkdir:${dirname(markerPath)}`,
        `sync:directory:${claimRoot}`,
        `sync:file:${markerPath}`,
        `sync:directory:${dirname(markerPath)}`,
      ]);
  });

  it("re-syncs a visible root whose containing-parent sync failed on the previous attempt", async () => {
    const base = await makeRoot("skyturn-claim-visible-root-retry-");
    const projectRoot = join(base, "project");
    const claimRoot = join(base, "claims");
    await mkdir(projectRoot);
    const operations: string[] = [];
    let failed = false;
    const store = createStore({
      root: claimRoot,
      platform: "linux",
      fileSystem: pathRecordingFileSystem(operations, ({ path, directory }) => {
        if (!failed && directory && path === base) {
          failed = true;
          return "EIO";
        }
        return null;
      }),
    });

    await expect(store.initialize()).rejects.toThrow("run-start-claim-boundary-invalid");
    await expect(lstat(claimRoot)).resolves.toMatchObject({});
    await expect(store.publish(projectRoot, claim())).resolves.toBe("published");

    expect(operations.filter((operation) => operation === `sync:directory:${base}`)).toHaveLength(2);
  });

  it.each(["EIO", "EPERM"])(
    "fails before marker ownership when the project-directory entry cannot be synced with %s",
    async (code) => {
      const base = await makeRoot(`skyturn-claim-project-sync-${code.toLowerCase()}-`);
      const projectRoot = join(base, "project");
      const claimRoot = join(base, "claims");
      await mkdir(projectRoot);
      await mkdir(claimRoot, { mode: 0o700 });
      const operations: string[] = [];
      const store = createStore({
        root: claimRoot,
        platform: "linux",
        fileSystem: pathRecordingFileSystem(operations, ({ path, directory }) =>
          directory && path === claimRoot ? code : null),
      });

      await expect(store.publish(projectRoot, claim())).rejects.toMatchObject({
        name: "DurableRunClaimPublicationError",
        owned: false,
      });
      expect(operations.some((operation) => operation.startsWith("open:wx:"))).toBe(false);
    },
  );

  it("keeps concurrent matching and conflicting publishers race-safe", async () => {
    const { projectRoot, store } = await makeStore();
    const winner = claim();
    const conflict = { ...winner, startFingerprint: "b".repeat(64) };

    const candidates = [winner, winner, conflict];
    const results = await Promise.all(candidates.map((candidate) => store.publish(projectRoot, candidate)));

    expect(results.filter((result) => result === "published")).toHaveLength(1);
    expect(results.filter((result) => result === "exists")).toHaveLength(2);
    const published = results.findIndex((result) => result === "published");
    await expect(store.read(projectRoot, winner.runId)).resolves.toEqual({
      kind: "valid",
      claim: candidates[published],
    });
  });

  it.each([
    ["crash-before-content", "crash"],
    ["partial-write", "write"],
    ["file-fsync", "sync"],
    ["file-close", "close"],
  ] as const)("preserves ownership after exclusive creation when %s fails", async (_label, fault) => {
    const root = await makeRoot("skyturn-claim-owned-failure-");
    const projectRoot = join(root, "project");
    await mkdir(projectRoot);
    const store = createStore({
      root: join(root, "claims"),
      fileSystem: faultingFileSystem(fault),
    });

    await expect(store.publish(projectRoot, claim())).rejects.toMatchObject({
      name: "DurableRunClaimPublicationError",
      message: "run-start-claim-publication-failed",
      owned: true,
    });

    const markerPath = await store.markerPath(projectRoot, claim().runId);
    await expect(lstat(markerPath)).resolves.toMatchObject({});
    const read = await store.read(projectRoot, claim().runId);
    expect(read.kind).toBe(fault === "sync" || fault === "close" ? "valid" : "invalid");
  });

  it("never overwrites an existing winner", async () => {
    const { projectRoot, store } = await makeStore();
    const winner = claim();
    const loser = { ...winner, startFingerprint: "b".repeat(64) };
    await store.publish(projectRoot, winner);
    const markerPath = await store.markerPath(projectRoot, winner.runId);
    const before = await readFile(markerPath);

    await expect(store.publish(projectRoot, loser)).resolves.toBe("exists");
    expect(await readFile(markerPath)).toEqual(before);
  });

  it.each(["zero", "truncated", "symlink", "directory", "permissions"] as const)(
    "classifies an existing %s final marker as owned-invalid",
    async (markerCase) => {
      const { root, projectRoot, store } = await makeStore();
      const markerPath = await store.markerPath(projectRoot, claim().runId);
      await mkdir(join(markerPath, ".."), { recursive: true, mode: 0o700 });
      if (markerCase === "zero") {
        await open(markerPath, "wx", 0o600).then((handle) => handle.close());
      } else if (markerCase === "truncated") {
        const handle = await open(markerPath, "wx", 0o600);
        await handle.writeFile('{"runId":');
        await handle.close();
      } else if (markerCase === "symlink") {
        const target = join(root, "claim-target");
        const handle = await open(target, "wx", 0o600);
        await handle.writeFile(JSON.stringify(claim()));
        await handle.close();
        await symlink(target, markerPath);
      } else if (markerCase === "directory") {
        await mkdir(markerPath);
      } else {
        const handle = await open(markerPath, "wx", 0o600);
        await handle.writeFile(JSON.stringify(claim()));
        await handle.close();
        await chmod(markerPath, 0o644);
      }

      await expect(store.read(projectRoot, claim().runId)).resolves.toEqual({ kind: "invalid" });
      await expect(store.publish(projectRoot, claim())).resolves.toBe("exists");
      await expect(lstat(markerPath)).resolves.toMatchObject({});
    },
  );
});

function createStore(options: Parameters<CreateStore>[0]): TestClaimStore {
  const candidate = (durableClaimModule as unknown as { createDurableRunClaimStore?: CreateStore })
    .createDurableRunClaimStore;
  expect(candidate, "createDurableRunClaimStore must be implemented").toBeTypeOf("function");
  return candidate!(options);
}

async function makeStore(): Promise<{ root: string; projectRoot: string; store: TestClaimStore }> {
  const root = await makeRoot("skyturn-durable-claim-");
  const projectRoot = join(root, "project");
  await mkdir(projectRoot);
  return { root: join(root, "claims"), projectRoot, store: createStore({ root: join(root, "claims") }) };
}

async function makeRoot(prefix: string): Promise<string> {
  const root = await realpath(await mkdtemp(join(tmpdir(), prefix)));
  roots.push(root);
  return root;
}

function claim(): TestClaim {
  return {
    runId: "run-claim",
    nodeId: "node-claim",
    sessionId: "session-claim",
    agentKind: "codex",
    startFingerprint: "a".repeat(64),
    startedAt: "2026-07-15T00:00:00.000Z",
  };
}

function recordingFileSystem(operations: string[]): TestFileSystem {
  return {
    realpath,
    mkdir: async (path, options) => {
      operations.push(`mkdir:${options.mode}`);
      return mkdir(path, options);
    },
    chmod: async (path, mode) => {
      operations.push(`chmod:${mode}`);
      await chmod(path, mode);
    },
    lstat,
    async open(path, flags, mode) {
      operations.push(`open:${String(flags)}:${mode ?? "none"}`);
      const handle = await open(path, flags, mode);
      const directory = (await handle.stat()).isDirectory();
      return wrapHandle(handle, {
        sync: async () => {
          operations.push(directory ? "directory-sync" : "file-sync");
          await handle.sync();
        },
        close: async () => {
          operations.push(directory ? "directory-close" : "file-close");
          await handle.close();
        },
      });
    },
  };
}

function pathRecordingFileSystem(
  operations: string[],
  fault: (input: { path: string; directory: boolean; attempt: number }) => string | null = () => null,
): TestFileSystem {
  const attempts = new Map<string, number>();
  return {
    realpath,
    mkdir: async (path, options) => {
      operations.push(`mkdir:${path}`);
      return mkdir(path, options);
    },
    chmod,
    lstat,
    async open(path, flags, mode) {
      operations.push(`open:${String(flags)}:${path}`);
      const handle = await open(path, flags, mode);
      const directory = (await handle.stat()).isDirectory();
      return wrapHandle(handle, {
        sync: async () => {
          const key = `${directory ? "directory" : "file"}:${path}`;
          const attempt = (attempts.get(key) ?? 0) + 1;
          attempts.set(key, attempt);
          operations.push(`sync:${key}`);
          const code = fault({ path, directory, attempt });
          if (code) throw Object.assign(new Error(`injected sync failure for ${path}`), { code });
          await handle.sync();
        },
      });
    },
  };
}

function faultingFileSystem(fault: "crash" | "write" | "sync" | "close"): TestFileSystem {
  return {
    realpath,
    mkdir,
    chmod,
    lstat,
    async open(path, flags, mode) {
      const handle = await open(path, flags, mode);
      if (flags !== "wx") return handle;
      return wrapHandle(handle, {
        writeFile: async (data) => {
          if (fault === "crash") throw new Error("simulated parent crash");
          if (fault === "write") {
            const bytes = Buffer.from(data as string | Uint8Array);
            await handle.writeFile(bytes.subarray(0, Math.max(1, Math.floor(bytes.length / 2))));
            throw new Error("injected write failure");
          }
          await handle.writeFile(data);
        },
        sync: async () => {
          if (fault === "sync") throw new Error("injected fsync failure");
          await handle.sync();
        },
        close: async () => {
          await handle.close();
          if (fault === "close") throw new Error("injected close failure");
        },
      });
    },
  };
}

function wrapHandle(
  handle: FileHandle,
  overrides: Partial<Pick<FileHandle, "writeFile" | "sync" | "close">>,
): FileHandle {
  return new Proxy(handle, {
    get(target, property, receiver) {
      const override = overrides[property as keyof typeof overrides];
      if (override) return override;
      const value = Reflect.get(target, property, receiver) as unknown;
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
}
