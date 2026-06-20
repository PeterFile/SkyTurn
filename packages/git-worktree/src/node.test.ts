import { execFile, execFileSync } from "node:child_process";
import { existsSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { mkdir, mkdtemp, rm, symlink as fsSymlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { promisify } from "node:util";

import { afterEach, describe, expect, it } from "vitest";

import type { CanvasNode, LiveRunChangesEvidence, WorkflowVariantAdoption } from "@skyturn/project-core";
import {
  createDeliveryCommit,
  createGitChangesetService,
  createNodeGitWorktreeService,
  getGitBranchFacts,
  type ManagedWorktreeWorkflowEvent,
  worktreeMetadataForVariant,
} from "./node.js";

const execFileAsync = promisify(execFile);
const changesetTempRoots: string[] = [];

interface TestRepo {
  tempRoot: string;
  repoRoot: string;
  baseCommit: string;
}

function git(cwd: string, args: string[]): string {
  return execFileSync("git", args, {
    cwd,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  }).trim();
}

async function createTestRepo(prefix: string): Promise<TestRepo> {
  const tempRoot = await mkdtemp(join(tmpdir(), prefix));
  const repoRoot = join(tempRoot, "project");
  git(tempRoot, ["init", "project"]);
  git(repoRoot, ["checkout", "-b", "main"]);
  git(repoRoot, ["config", "user.email", "skyturn@example.test"]);
  git(repoRoot, ["config", "user.name", "SkyTurn Test"]);
  writeFileSync(join(repoRoot, "feature.txt"), "base\n");
  git(repoRoot, ["add", "feature.txt"]);
  git(repoRoot, ["commit", "-m", "initial"]);
  return { tempRoot, repoRoot, baseCommit: git(repoRoot, ["rev-parse", "HEAD"]) };
}

function commitVariant(worktreePath: string, label: string): string {
  writeFileSync(join(worktreePath, `${label}.txt`), `${label}\n`);
  git(worktreePath, ["add", `${label}.txt`]);
  git(worktreePath, ["commit", "-m", `add ${label}`]);
  return git(worktreePath, ["rev-parse", "HEAD"]);
}

function requestedEventFor(input: {
  sessionId: string;
  variantId: string;
  repoRoot: string;
  baseCommit: string;
  branchName: string;
  parentLaneId: string;
}): ManagedWorktreeWorkflowEvent {
  const worktreeId = `worktree-${input.sessionId}-${input.variantId}`;
  return {
    kind: "workflow.worktree.create_requested",
    source: "git-worktree",
    payload: {
      ...input,
      worktreeId,
      path: join(dirname(input.repoRoot), `${basename(input.repoRoot)}.worktrees`, `session-${input.sessionId}-variant-${input.variantId}`),
      status: "requested",
    },
    createdAt: "2026-06-16T00:00:00.000Z",
    idempotencyKey: `worktree:${worktreeId}:create-requested`,
    sessionId: input.sessionId,
  };
}

function createdEventFor(worktree: {
  worktreeId: string;
  variantId: string;
  path: string;
  realPath: string;
  gitdir: string;
  repoRoot: string;
  branchName: string;
  baseCommit: string;
  headCommit: string;
  parentLaneId: string;
  parentSegmentId?: string;
}, sessionId: string): ManagedWorktreeWorkflowEvent {
  return {
    kind: "workflow.worktree.created",
    source: "git-worktree",
    payload: { worktree },
    createdAt: "2026-06-16T00:00:00.000Z",
    idempotencyKey: `worktree:${worktree.worktreeId}:created`,
    sessionId,
  };
}

describe("node git worktree service", () => {
  const tempRoots: string[] = [];

  afterEach(() => {
    for (const root of tempRoots.splice(0)) {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("creates isolated managed worktrees, adopts one committed variant, and cleans only the rejected worktree", async () => {
    const repo = await createTestRepo("skyturn-worktree-service-");
    tempRoots.push(repo.tempRoot);
    const events: ManagedWorktreeWorkflowEvent[] = [];
    const service = createNodeGitWorktreeService({
      eventSink: { append: async (event) => events.push(event) },
      now: () => "2026-06-16T00:00:00.000Z",
      runState: { hasRunningTasks: async () => false },
    });

    const left = await service.createManagedWorktree({
      sessionId: "session-1",
      variantId: "left",
      repoRoot: repo.repoRoot,
      baseCommit: repo.baseCommit,
      branchName: "skyturn/session-1/left",
      parentLaneId: "lane-decision",
    });
    const right = await service.createManagedWorktree({
      sessionId: "session-1",
      variantId: "right",
      repoRoot: repo.repoRoot,
      baseCommit: repo.baseCommit,
      branchName: "skyturn/session-1/right",
      parentLaneId: "lane-decision",
    });

    expect(left.realPath).toBe(resolve(left.realPath));
    expect(right.realPath).toBe(resolve(right.realPath));
    expect(left.realPath).not.toBe(right.realPath);
    expect(worktreeMetadataForVariant(left).path).toBe(left.realPath);
    expect(readFileSync(join(left.realPath, ".git"), "utf8")).toContain("gitdir:");
    expect(events.map((event) => event.kind)).toEqual([
      "workflow.worktree.create_requested",
      "workflow.worktree.created",
      "workflow.worktree.create_requested",
      "workflow.worktree.created",
    ]);

    const leftHead = commitVariant(left.realPath, "left");
    const rightHead = commitVariant(right.realPath, "right");
    const refreshedLeft = await service.reconcileManagedWorktree(left, { expectedHeadCommit: leftHead });
    const refreshedRight = await service.reconcileManagedWorktree(right, { expectedHeadCommit: rightHead });
    git(repo.repoRoot, ["checkout", "-b", "scratch"]);

    const adoption: WorkflowVariantAdoption = {
      adoptionId: "adopt-left",
      variantId: refreshedLeft.variantId,
      worktreeId: refreshedLeft.worktreeId,
      strategy: "merge",
      status: "requested",
      baseCommit: refreshedLeft.baseCommit,
      headCommit: refreshedLeft.headCommit,
      targetBranchName: "main",
    };

    await expect(service.adoptVariant(adoption)).resolves.toMatchObject({
      adoptionId: "adopt-left",
      status: "adopted",
      adoptedCommit: refreshedLeft.headCommit,
    });
    expect(events.map((event) => event.kind)).toContain("workflow.variant.adopt_requested");
    expect(events.map((event) => event.kind)).toContain("workflow.variant.adopted");
    expect(git(repo.repoRoot, ["branch", "--show-current"])).toBe("main");
    expect(readFileSync(join(repo.repoRoot, "left.txt"), "utf8")).toBe("left\n");

    const busyService = createNodeGitWorktreeService({
      eventSink: { append: async (event) => events.push(event) },
      runState: { hasRunningTasks: async () => true },
    });
    const beforeBusyClean = events.length;
    await expect(busyService.cleanManagedWorktree({ worktree: refreshedRight })).rejects.toThrow(/running tasks/i);
    expect(existsSync(refreshedRight.realPath)).toBe(true);
    expect(events.slice(beforeBusyClean).map((event) => event.kind)).toEqual(["workflow.worktree.clean_failed"]);
    expect(events.at(-1)).toMatchObject({
      kind: "workflow.worktree.clean_failed",
      payload: {
        worktree: refreshedRight,
        result: {
          ok: false,
          worktreeId: refreshedRight.worktreeId,
          branchDeleted: false,
        },
      },
    });

    const statelessService = createNodeGitWorktreeService({
      runState: { hasRunningTasks: async () => false },
    });
    await expect(statelessService.cleanManagedWorktree({ worktree: refreshedRight })).rejects.toThrow(/created worktree event/i);
    expect(existsSync(refreshedRight.realPath)).toBe(true);

    await expect(service.cleanManagedWorktree({ worktree: refreshedRight })).resolves.toMatchObject({
      ok: true,
      worktreeId: refreshedRight.worktreeId,
      branchDeleted: false,
    });
    expect(existsSync(refreshedRight.realPath)).toBe(false);
    expect(existsSync(refreshedLeft.realPath)).toBe(true);
    expect(git(repo.repoRoot, ["rev-parse", "--verify", "refs/heads/skyturn/session-1/right"])).toBe(rightHead);
    expect(events.map((event) => event.kind)).toContain("workflow.worktree.clean_requested");
    expect(events.map((event) => event.kind)).toContain("workflow.worktree.cleaned");
  });

  it("keeps the target checkout clean after a successful cherry-pick adoption preview", async () => {
    const repo = await createTestRepo("skyturn-worktree-cherry-preview-");
    tempRoots.push(repo.tempRoot);
    const events: ManagedWorktreeWorkflowEvent[] = [];
    const service = createNodeGitWorktreeService({
      eventSink: { append: async (event) => events.push(event) },
    });
    const worktree = await service.createManagedWorktree({
      sessionId: "session-1",
      variantId: "cherry",
      repoRoot: repo.repoRoot,
      baseCommit: repo.baseCommit,
      branchName: "skyturn/session-1/cherry",
      parentLaneId: "lane-decision",
    });
    const headCommit = commitVariant(worktree.realPath, "cherry");
    const refreshed = await service.reconcileManagedWorktree(worktree, { expectedHeadCommit: headCommit });

    await expect(service.adoptVariant({
      adoptionId: "adopt-cherry",
      variantId: refreshed.variantId,
      worktreeId: refreshed.worktreeId,
      strategy: "cherry-pick",
      status: "requested",
      baseCommit: refreshed.baseCommit,
      headCommit: refreshed.headCommit,
      targetBranchName: "main",
    })).resolves.toMatchObject({
      adoptionId: "adopt-cherry",
      status: "adopted",
    });

    expect(git(repo.repoRoot, ["branch", "--show-current"])).toBe("main");
    expect(git(repo.repoRoot, ["status", "--porcelain=v1", "--"])).toBe("");
    expect(readFileSync(join(repo.repoRoot, "cherry.txt"), "utf8")).toBe("cherry\n");
    expect(events.map((event) => event.kind)).toContain("workflow.variant.adopted");
  });

  it("rejects target untracked files hidden by git config before adoption preview", async () => {
    const repo = await createTestRepo("skyturn-worktree-adopt-untracked-");
    tempRoots.push(repo.tempRoot);
    const events: ManagedWorktreeWorkflowEvent[] = [];
    const service = createNodeGitWorktreeService({
      eventSink: { append: async (event) => events.push(event) },
    });
    const worktree = await service.createManagedWorktree({
      sessionId: "session-1",
      variantId: "untracked",
      repoRoot: repo.repoRoot,
      baseCommit: repo.baseCommit,
      branchName: "skyturn/session-1/untracked",
      parentLaneId: "lane-decision",
    });
    const headCommit = commitVariant(worktree.realPath, "untracked");
    const refreshed = await service.reconcileManagedWorktree(worktree, { expectedHeadCommit: headCommit });
    const targetHead = git(repo.repoRoot, ["rev-parse", "HEAD"]);
    const sentinelPath = join(repo.repoRoot, "scratch", "keep.txt");
    git(repo.repoRoot, ["config", "status.showUntrackedFiles", "no"]);
    await mkdir(dirname(sentinelPath), { recursive: true });
    writeFileSync(sentinelPath, "do not delete\n");

    await expect(service.adoptVariant({
      adoptionId: "adopt-untracked",
      variantId: refreshed.variantId,
      worktreeId: refreshed.worktreeId,
      strategy: "cherry-pick",
      status: "requested",
      baseCommit: refreshed.baseCommit,
      headCommit: refreshed.headCommit,
      targetBranchName: "main",
    })).resolves.toMatchObject({
      adoptionId: "adopt-untracked",
      status: "failed",
      failureReason: expect.stringMatching(/target worktree has uncommitted changes/i),
    });

    expect(existsSync(sentinelPath)).toBe(true);
    expect(git(repo.repoRoot, ["rev-parse", "HEAD"])).toBe(targetHead);
    expect(existsSync(join(repo.repoRoot, "untracked.txt"))).toBe(false);
    expect(events.map((event) => event.kind)).not.toContain("workflow.variant.adopted");
  });

  it("records adopt_failed and rejects when the target branch drifted from the declared base", async () => {
    const repo = await createTestRepo("skyturn-worktree-adopt-drift-");
    tempRoots.push(repo.tempRoot);
    const events: ManagedWorktreeWorkflowEvent[] = [];
    const service = createNodeGitWorktreeService({
      eventSink: { append: async (event) => events.push(event) },
    });
    const worktree = await service.createManagedWorktree({
      sessionId: "session-1",
      variantId: "drift",
      repoRoot: repo.repoRoot,
      baseCommit: repo.baseCommit,
      branchName: "skyturn/session-1/drift",
      parentLaneId: "lane-decision",
    });
    const headCommit = commitVariant(worktree.realPath, "drift");
    const refreshed = await service.reconcileManagedWorktree(worktree, { expectedHeadCommit: headCommit });
    writeFileSync(join(repo.repoRoot, "target.txt"), "target\n");
    git(repo.repoRoot, ["add", "target.txt"]);
    git(repo.repoRoot, ["commit", "-m", "advance target"]);
    const targetHead = git(repo.repoRoot, ["rev-parse", "HEAD"]);

    await expect(service.adoptVariant({
      adoptionId: "adopt-drift",
      variantId: refreshed.variantId,
      worktreeId: refreshed.worktreeId,
      strategy: "cherry-pick",
      status: "requested",
      baseCommit: refreshed.baseCommit,
      headCommit: refreshed.headCommit,
      targetBranchName: "main",
    })).rejects.toThrow(/target branch HEAD/i);

    expect(git(repo.repoRoot, ["rev-parse", "HEAD"])).toBe(targetHead);
    expect(git(repo.repoRoot, ["status", "--porcelain=v1", "--"])).toBe("");
    expect(events.at(-1)).toMatchObject({
      kind: "workflow.variant.adopt_failed",
      payload: {
        adoption: {
          adoptionId: "adopt-drift",
          status: "failed",
          failureReason: expect.stringMatching(/target branch HEAD/i),
        },
      },
    });
  });

  it("records create_failed when git cannot create the requested worktree", async () => {
    const repo = await createTestRepo("skyturn-worktree-create-failure-");
    tempRoots.push(repo.tempRoot);
    const events: ManagedWorktreeWorkflowEvent[] = [];
    const service = createNodeGitWorktreeService({
      eventSink: { append: async (event) => events.push(event) },
    });

    await expect(service.createManagedWorktree({
      sessionId: "session-1",
      variantId: "broken",
      repoRoot: repo.repoRoot,
      baseCommit: "not-a-commit",
      branchName: "skyturn/session-1/broken",
      parentLaneId: "lane-decision",
    })).rejects.toThrow(/base commit/i);

    expect(events.map((event) => event.kind)).toEqual([
      "workflow.worktree.create_requested",
      "workflow.worktree.create_failed",
    ]);
    expect(events[1]?.payload).toMatchObject({
      worktreeId: "worktree-session-1-broken",
      variantId: "broken",
    });
  });

  it("returns an existing created worktree for duplicate create requests without new events", async () => {
    const repo = await createTestRepo("skyturn-worktree-create-idempotent-");
    tempRoots.push(repo.tempRoot);
    const events: ManagedWorktreeWorkflowEvent[] = [];
    const service = createNodeGitWorktreeService({
      eventSink: { append: async (event) => events.push(event) },
    });
    const input = {
      sessionId: "session-1",
      variantId: "duplicate",
      repoRoot: repo.repoRoot,
      baseCommit: repo.baseCommit,
      branchName: "skyturn/session-1/duplicate",
      parentLaneId: "lane-decision",
    };

    const first = await service.createManagedWorktree(input);
    const eventCount = events.length;
    const second = await service.createManagedWorktree(input);

    expect(second).toEqual(first);
    expect(events).toHaveLength(eventCount);
    expect(events.map((event) => event.kind)).toEqual([
      "workflow.worktree.create_requested",
      "workflow.worktree.created",
    ]);
  });

  it("refreshes an existing created worktree when duplicate create sees an advanced HEAD without new events", async () => {
    const repo = await createTestRepo("skyturn-worktree-create-advanced-head-");
    tempRoots.push(repo.tempRoot);
    const events: ManagedWorktreeWorkflowEvent[] = [];
    const service = createNodeGitWorktreeService({
      eventSink: { append: async (event) => events.push(event) },
    });
    const input = {
      sessionId: "session-1",
      variantId: "duplicate",
      repoRoot: repo.repoRoot,
      baseCommit: repo.baseCommit,
      branchName: "skyturn/session-1/duplicate",
      parentLaneId: "lane-decision",
    };

    const first = await service.createManagedWorktree(input);
    const eventCount = events.length;
    const advancedHead = commitVariant(first.realPath, "advanced");
    const second = await service.createManagedWorktree(input);

    expect(second).toEqual({
      ...first,
      headCommit: advancedHead,
    });
    expect(second.baseCommit).toBe(repo.baseCommit);
    expect(events).toHaveLength(eventCount);
    expect(events.map((event) => event.kind)).toEqual([
      "workflow.worktree.create_requested",
      "workflow.worktree.created",
    ]);
  });

  it("records create_failed instead of reusing a created event when immutable input facts conflict", async () => {
    const repo = await createTestRepo("skyturn-worktree-create-conflict-");
    tempRoots.push(repo.tempRoot);
    const events: ManagedWorktreeWorkflowEvent[] = [];
    const service = createNodeGitWorktreeService({
      eventSink: { append: async (event) => events.push(event) },
    });
    const input = {
      sessionId: "session-1",
      variantId: "duplicate",
      repoRoot: repo.repoRoot,
      baseCommit: repo.baseCommit,
      branchName: "skyturn/session-1/duplicate",
      parentLaneId: "lane-decision",
    };

    await service.createManagedWorktree(input);
    writeFileSync(join(repo.repoRoot, "second.txt"), "second\n");
    git(repo.repoRoot, ["add", "second.txt"]);
    git(repo.repoRoot, ["commit", "-m", "second"]);
    const changedBaseCommit = git(repo.repoRoot, ["rev-parse", "HEAD"]);

    await expect(service.createManagedWorktree({
      ...input,
      baseCommit: changedBaseCommit,
      parentLaneId: "lane-other",
    })).rejects.toThrow(/conflict|mismatch/i);

    expect(events.map((event) => event.kind)).toEqual([
      "workflow.worktree.create_requested",
      "workflow.worktree.created",
      "workflow.worktree.create_failed",
    ]);
    expect(events.at(-1)).toMatchObject({
      kind: "workflow.worktree.create_failed",
      payload: {
        worktreeId: "worktree-session-1-duplicate",
        baseCommit: changedBaseCommit,
        parentLaneId: "lane-other",
        status: "failed",
      },
    });
  });

  it("records create_failed when a stale created event points to a missing worktree", async () => {
    const repo = await createTestRepo("skyturn-worktree-stale-created-");
    tempRoots.push(repo.tempRoot);
    const seedService = createNodeGitWorktreeService();
    const input = {
      sessionId: "session-1",
      variantId: "stale",
      repoRoot: repo.repoRoot,
      baseCommit: repo.baseCommit,
      branchName: "skyturn/session-1/stale",
      parentLaneId: "lane-decision",
    };
    const worktree = await seedService.createManagedWorktree(input);
    rmSync(worktree.realPath, { recursive: true, force: true });
    const events: ManagedWorktreeWorkflowEvent[] = [];
    const service = createNodeGitWorktreeService({
      initialEvents: [createdEventFor(worktree, input.sessionId)],
      eventSink: { append: async (event) => events.push(event) },
    });

    await expect(service.createManagedWorktree(input)).rejects.toThrow(/worktree|no such file|ENOENT/i);

    expect(events.map((event) => event.kind)).toEqual(["workflow.worktree.create_failed"]);
    expect(events[0]?.payload).toMatchObject({
      worktreeId: worktree.worktreeId,
      status: "failed",
    });
  });

  it("records create_failed when planning rejects a non top-level repo root", async () => {
    const repo = await createTestRepo("skyturn-worktree-plan-failure-");
    tempRoots.push(repo.tempRoot);
    const nestedRepoPath = join(repo.repoRoot, "nested");
    await mkdir(nestedRepoPath);
    const events: ManagedWorktreeWorkflowEvent[] = [];
    const service = createNodeGitWorktreeService({
      eventSink: { append: async (event) => events.push(event) },
    });

    await expect(service.createManagedWorktree({
      sessionId: "session-1",
      variantId: "nested",
      repoRoot: nestedRepoPath,
      baseCommit: repo.baseCommit,
      branchName: "skyturn/session-1/nested",
      parentLaneId: "lane-decision",
    })).rejects.toThrow(/Repo root mismatch/i);

    expect(events.map((event) => event.kind)).toEqual(["workflow.worktree.create_failed"]);
    expect(events[0]?.payload).toMatchObject({
      worktreeId: "worktree-session-1-nested",
      variantId: "nested",
      status: "failed",
    });
  });

  it("rejects worktree identity when the recorded base is not an ancestor of HEAD", async () => {
    const repo = await createTestRepo("skyturn-worktree-identity-");
    tempRoots.push(repo.tempRoot);
    const service = createNodeGitWorktreeService();

    git(repo.repoRoot, ["checkout", "-b", "other"]);
    writeFileSync(join(repo.repoRoot, "other.txt"), "other\n");
    git(repo.repoRoot, ["add", "other.txt"]);
    git(repo.repoRoot, ["commit", "-m", "other branch"]);
    const nonAncestorBase = git(repo.repoRoot, ["rev-parse", "HEAD"]);
    git(repo.repoRoot, ["checkout", "main"]);

    const worktree = await service.createManagedWorktree({
      sessionId: "session-1",
      variantId: "identity",
      repoRoot: repo.repoRoot,
      baseCommit: repo.baseCommit,
      branchName: "skyturn/session-1/identity",
      parentLaneId: "lane-decision",
    });

    await expect(service.reconcileManagedWorktree({
      ...worktree,
      baseCommit: nonAncestorBase,
    })).rejects.toThrow(/ancestor/i);
  });

  it("records clean_failed when a stale created event points to a missing cleanup worktree", async () => {
    const repo = await createTestRepo("skyturn-worktree-clean-stale-");
    tempRoots.push(repo.tempRoot);
    const seedService = createNodeGitWorktreeService();
    const input = {
      sessionId: "session-1",
      variantId: "stale-clean",
      repoRoot: repo.repoRoot,
      baseCommit: repo.baseCommit,
      branchName: "skyturn/session-1/stale-clean",
      parentLaneId: "lane-decision",
    };
    const worktree = await seedService.createManagedWorktree(input);
    rmSync(worktree.realPath, { recursive: true, force: true });
    const events: ManagedWorktreeWorkflowEvent[] = [];
    const service = createNodeGitWorktreeService({
      initialEvents: [createdEventFor(worktree, input.sessionId)],
      eventSink: { append: async (event) => events.push(event) },
    });

    await expect(service.cleanManagedWorktree({ worktree })).rejects.toThrow(/worktree|no such file|ENOENT/i);

    expect(events.map((event) => event.kind)).toEqual(["workflow.worktree.clean_failed"]);
    expect(events.at(-1)).toMatchObject({
      kind: "workflow.worktree.clean_failed",
      payload: {
        worktree,
        result: {
          ok: false,
          worktreeId: worktree.worktreeId,
          branchDeleted: false,
        },
      },
    });
  });

  it("records clean_failed when git refuses to remove a dirty managed worktree", async () => {
    const repo = await createTestRepo("skyturn-worktree-clean-failure-");
    tempRoots.push(repo.tempRoot);
    const events: ManagedWorktreeWorkflowEvent[] = [];
    const service = createNodeGitWorktreeService({
      eventSink: { append: async (event) => events.push(event) },
    });
    const worktree = await service.createManagedWorktree({
      sessionId: "session-1",
      variantId: "dirty",
      repoRoot: repo.repoRoot,
      baseCommit: repo.baseCommit,
      branchName: "skyturn/session-1/dirty",
      parentLaneId: "lane-decision",
    });
    writeFileSync(join(worktree.realPath, "dirty.txt"), "dirty\n");

    await expect(service.cleanManagedWorktree({ worktree })).rejects.toThrow(/remove|uncommitted|dirty|not clean/i);

    expect(existsSync(worktree.realPath)).toBe(true);
    expect(events.map((event) => event.kind)).toEqual([
      "workflow.worktree.create_requested",
      "workflow.worktree.created",
      "workflow.worktree.clean_requested",
      "workflow.worktree.clean_failed",
    ]);
    expect(events.at(-1)).toMatchObject({
      kind: "workflow.worktree.clean_failed",
      payload: {
        worktree,
        result: {
          ok: false,
          worktreeId: worktree.worktreeId,
          branchDeleted: false,
        },
      },
    });
  });

  it("records clean_failed when deleteBranch rejects an unsafe branch name", async () => {
    const repo = await createTestRepo("skyturn-worktree-clean-unsafe-branch-");
    tempRoots.push(repo.tempRoot);
    const events: ManagedWorktreeWorkflowEvent[] = [];
    const service = createNodeGitWorktreeService({
      eventSink: { append: async (event) => events.push(event) },
      runState: { hasRunningTasks: async () => false },
    });
    const worktree = await service.createManagedWorktree({
      sessionId: "session-1",
      variantId: "unsafe-branch",
      repoRoot: repo.repoRoot,
      baseCommit: repo.baseCommit,
      branchName: "skyturn/session-1/unsafe-branch",
      parentLaneId: "lane-decision",
    });
    const unsafeWorktree = { ...worktree, branchName: "skyturn/session-1/unsafe branch" };
    const beforeClean = events.length;

    await expect(service.cleanManagedWorktree({
      worktree: unsafeWorktree,
      deleteBranch: true,
    })).rejects.toThrow(/Unsafe branch name/i);

    expect(existsSync(worktree.realPath)).toBe(true);
    expect(events.slice(beforeClean).map((event) => event.kind)).toEqual(["workflow.worktree.clean_failed"]);
    expect(events.at(-1)).toMatchObject({
      kind: "workflow.worktree.clean_failed",
      payload: {
        worktree: unsafeWorktree,
        result: {
          ok: false,
          worktreeId: worktree.worktreeId,
          branchDeleted: false,
          reason: expect.stringMatching(/Unsafe branch name/i),
        },
      },
    });
  });

  it("preflights deleteBranch safety before removing an unmerged managed worktree", async () => {
    const repo = await createTestRepo("skyturn-worktree-clean-unmerged-branch-");
    tempRoots.push(repo.tempRoot);
    const events: ManagedWorktreeWorkflowEvent[] = [];
    const service = createNodeGitWorktreeService({
      eventSink: { append: async (event) => events.push(event) },
      runState: { hasRunningTasks: async () => false },
    });
    const worktree = await service.createManagedWorktree({
      sessionId: "session-1",
      variantId: "unmerged-clean",
      repoRoot: repo.repoRoot,
      baseCommit: repo.baseCommit,
      branchName: "skyturn/session-1/unmerged-clean",
      parentLaneId: "lane-decision",
    });
    const headCommit = commitVariant(worktree.realPath, "unmerged-clean");
    const refreshed = await service.reconcileManagedWorktree(worktree, { expectedHeadCommit: headCommit });
    const beforeClean = events.length;

    await expect(service.cleanManagedWorktree({
      worktree: refreshed,
      deleteBranch: true,
    })).rejects.toThrow(/branch/i);

    expect(existsSync(refreshed.realPath)).toBe(true);
    expect(git(repo.repoRoot, ["rev-parse", "--verify", `refs/heads/${refreshed.branchName}`])).toBe(headCommit);
    expect(events.slice(beforeClean).map((event) => event.kind)).toEqual(["workflow.worktree.clean_failed"]);
    expect(events.at(-1)).toMatchObject({
      kind: "workflow.worktree.clean_failed",
      payload: {
        worktree: refreshed,
        result: {
          ok: false,
          worktreeId: refreshed.worktreeId,
          branchDeleted: false,
          reason: expect.stringMatching(/branch/i),
        },
      },
    });
  });

  it("recovers requested worktree creates from disk state or records an anomalous failure", async () => {
    const repo = await createTestRepo("skyturn-worktree-recovery-");
    tempRoots.push(repo.tempRoot);
    const events: ManagedWorktreeWorkflowEvent[] = [];
    const request = {
      sessionId: "session-1",
      variantId: "recovered",
      repoRoot: repo.repoRoot,
      baseCommit: repo.baseCommit,
      branchName: "skyturn/session-1/recovered",
      parentLaneId: "lane-decision",
    };
    const missingRequest = {
      ...request,
      variantId: "missing",
      branchName: "skyturn/session-1/missing",
    };
    const service = createNodeGitWorktreeService({
      initialEvents: [requestedEventFor(request), requestedEventFor(missingRequest)],
      eventSink: { append: async (event) => events.push(event) },
      now: () => "2026-06-16T00:00:00.000Z",
    });
    const expectedPath = join(dirname(repo.repoRoot), `${basename(repo.repoRoot)}.worktrees`, "session-session-1-variant-recovered");
    git(repo.repoRoot, ["worktree", "add", "-b", request.branchName, expectedPath, repo.baseCommit]);

    await expect(service.recoverManagedWorktreeCreate(request)).resolves.toMatchObject({
      ok: true,
      status: "created",
      worktree: { realPath: realpathSync(expectedPath), branchName: request.branchName },
    });
    expect(events.at(-1)?.kind).toBe("workflow.worktree.created");

    await expect(service.recoverManagedWorktreeCreate(missingRequest)).resolves.toMatchObject({
      ok: false,
      status: "orphaned",
    });
    expect(events.at(-1)).toMatchObject({
      kind: "workflow.worktree.create_failed",
      payload: { status: "orphaned", recovered: true },
    });
  });

  it("refuses recovery when no create_requested event exists", async () => {
    const repo = await createTestRepo("skyturn-worktree-unrequested-recovery-");
    tempRoots.push(repo.tempRoot);
    const request = {
      sessionId: "session-1",
      variantId: "unrequested",
      repoRoot: repo.repoRoot,
      baseCommit: repo.baseCommit,
      branchName: "skyturn/session-1/unrequested",
      parentLaneId: "lane-decision",
    };
    const expectedPath = join(dirname(repo.repoRoot), `${basename(repo.repoRoot)}.worktrees`, "session-session-1-variant-unrequested");
    git(repo.repoRoot, ["worktree", "add", "-b", request.branchName, expectedPath, repo.baseCommit]);

    const service = createNodeGitWorktreeService();

    await expect(service.recoverManagedWorktreeCreate(request)).rejects.toThrow(/create_requested/i);
  });

  it("recovers only unfinished create_requested events and does not duplicate terminal events", async () => {
    const repo = await createTestRepo("skyturn-worktree-requested-recovery-");
    tempRoots.push(repo.tempRoot);
    const request = {
      sessionId: "session-1",
      variantId: "pending",
      repoRoot: repo.repoRoot,
      baseCommit: repo.baseCommit,
      branchName: "skyturn/session-1/pending",
      parentLaneId: "lane-decision",
    };
    const expectedPath = join(dirname(repo.repoRoot), `${basename(repo.repoRoot)}.worktrees`, "session-session-1-variant-pending");
    git(repo.repoRoot, ["worktree", "add", "-b", request.branchName, expectedPath, repo.baseCommit]);
    const events: ManagedWorktreeWorkflowEvent[] = [];
    const service = createNodeGitWorktreeService({
      initialEvents: [requestedEventFor(request)],
      eventSink: { append: async (event) => events.push(event) },
      now: () => "2026-06-16T00:00:00.000Z",
    });

    await expect(service.recoverRequestedWorktreeCreates()).resolves.toMatchObject([
      {
        ok: true,
        status: "created",
        worktree: { realPath: realpathSync(expectedPath), branchName: request.branchName },
      },
    ]);
    expect(events.map((event) => event.kind)).toEqual(["workflow.worktree.created"]);

    await expect(service.recoverRequestedWorktreeCreates()).resolves.toEqual([]);
    expect(events.map((event) => event.kind)).toEqual(["workflow.worktree.created"]);
  });
});

describe("delivery commits", () => {
  const tempRoots: string[] = [];

  afterEach(() => {
    for (const root of tempRoots.splice(0)) {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("stages only verified changed files and returns commit evidence", async () => {
    const repo = await createTestRepo("skyturn-delivery-commit-");
    tempRoots.push(repo.tempRoot);
    await writeFile(join(repo.repoRoot, "feature.txt"), "changed\n");
    await writeFile(join(repo.repoRoot, "scratch.txt"), "scratch\n");

    const evidence = await createDeliveryCommit({
      projectRoot: repo.repoRoot,
      worktreePath: repo.repoRoot,
      files: ["feature.txt"],
      subject: "feat(delivery): add verified commit action",
      body: "Commit only the reconciled file.",
    });

    expect(evidence).toMatchObject({
      branch: "main",
      stagedFiles: ["feature.txt"],
      worktreePath: realpathSync(repo.repoRoot),
      command: {
        ok: true,
        exitCode: 0,
      },
    });
    expect(evidence.commitSha).toMatch(/^[0-9a-f]{40}$/);
    expect(git(repo.repoRoot, ["show", "--name-only", "--format=%s", "--no-renames", evidence.commitSha])).toContain("feature.txt");
    expect(git(repo.repoRoot, ["show", "--name-only", "--format=", "--no-renames", evidence.commitSha])).not.toContain("scratch.txt");
    expect(git(repo.repoRoot, ["status", "--porcelain=v1", "--untracked-files=all", "--"])).toBe("?? scratch.txt");
  });

  it("commits only requested files when unrelated files are already staged", async () => {
    const repo = await createTestRepo("skyturn-delivery-only-");
    tempRoots.push(repo.tempRoot);
    await writeFile(join(repo.repoRoot, "feature.txt"), "changed\n");
    await writeFile(join(repo.repoRoot, "extra.txt"), "extra\n");
    git(repo.repoRoot, ["add", "extra.txt"]);

    const evidence = await createDeliveryCommit({
      projectRoot: repo.repoRoot,
      worktreePath: repo.repoRoot,
      files: ["feature.txt"],
      subject: "feat(delivery): add verified commit action",
    });

    expect(git(repo.repoRoot, ["diff-tree", "--no-commit-id", "--name-only", "-r", evidence.commitSha])).toBe("feature.txt");
    expect(git(repo.repoRoot, ["diff", "--cached", "--name-only", "--"])).toBe("extra.txt");
  });

  it("allows mismatch reconciliation only with explicit mismatch acceptance", async () => {
    const repo = await createTestRepo("skyturn-delivery-mismatch-");
    tempRoots.push(repo.tempRoot);
    await writeFile(join(repo.repoRoot, "feature.txt"), "changed\n");

    await expect(createDeliveryCommit({
      projectRoot: repo.repoRoot,
      worktreePath: repo.repoRoot,
      files: ["feature.txt"],
      subject: "feat(delivery): add verified commit action",
      reconciliationStatus: "mismatch",
    })).rejects.toThrow(/reconciliation|mismatch/i);

    await expect(createDeliveryCommit({
      projectRoot: repo.repoRoot,
      worktreePath: repo.repoRoot,
      files: ["feature.txt"],
      subject: "feat(delivery): add verified commit action",
      reconciliationStatus: "mismatch",
      acceptMismatch: true,
    })).resolves.toMatchObject({
      branch: "main",
      stagedFiles: ["feature.txt"],
    });
  });

  it("rejects git pathspec magic before staging any files", async () => {
    for (const magicPath of [":!feature.txt", ":^feature.txt"]) {
      const repo = await createTestRepo("skyturn-delivery-pathspec-");
      tempRoots.push(repo.tempRoot);
      await writeFile(join(repo.repoRoot, magicPath), "pathspec magic\n");
      await writeFile(join(repo.repoRoot, "unrelated.txt"), "unrelated\n");
      const cachedBefore = git(repo.repoRoot, ["diff", "--cached", "--name-only", "--"]);

      await expect(createDeliveryCommit({
        projectRoot: repo.repoRoot,
        worktreePath: repo.repoRoot,
        files: [magicPath],
        subject: "feat(delivery): add verified commit action",
      })).rejects.toThrow(/ambiguous/i);

      expect(git(repo.repoRoot, ["diff", "--cached", "--name-only", "--"])).toBe(cachedBefore);
    }
  });

  it("rejects empty file lists, missing subjects, unmanaged paths, ambiguous files, and unchanged files", async () => {
    const repo = await createTestRepo("skyturn-delivery-guard-");
    tempRoots.push(repo.tempRoot);
    await writeFile(join(repo.repoRoot, "feature.txt"), "changed\n");
    const outsideRoot = await mkdtemp(join(tmpdir(), "skyturn-delivery-outside-"));
    tempRoots.push(outsideRoot);

    await expect(createDeliveryCommit({
      projectRoot: repo.repoRoot,
      worktreePath: repo.repoRoot,
      files: [],
      subject: "feat(delivery): add verified commit action",
    })).rejects.toThrow(/non-empty/i);

    await expect(createDeliveryCommit({
      projectRoot: repo.repoRoot,
      worktreePath: repo.repoRoot,
      files: ["feature.txt"],
      subject: "   ",
    })).rejects.toThrow(/subject/i);

    await expect(createDeliveryCommit({
      projectRoot: repo.repoRoot,
      worktreePath: outsideRoot,
      files: ["feature.txt"],
      subject: "feat(delivery): add verified commit action",
    })).rejects.toThrow(/managed.*boundary|project boundary/i);

    await expect(createDeliveryCommit({
      projectRoot: repo.repoRoot,
      worktreePath: repo.repoRoot,
      files: ["feature.txt", "./feature.txt"],
      subject: "feat(delivery): add verified commit action",
    })).rejects.toThrow(/ambiguous|duplicate/i);

    await expect(createDeliveryCommit({
      projectRoot: repo.repoRoot,
      worktreePath: repo.repoRoot,
      files: ["missing.txt"],
      subject: "feat(delivery): add verified commit action",
    })).rejects.toThrow(/reconciled|changed/i);

    await expect(createDeliveryCommit({
      projectRoot: repo.repoRoot,
      worktreePath: repo.repoRoot,
      files: ["feature.txt"],
      subject: "feat(delivery): add verified commit action",
      reconciliationStatus: "failed",
    })).rejects.toThrow(/reconciliation/i);
  });

  it("allows managed project worktrees and rejects file paths outside that worktree", async () => {
    const repo = await createTestRepo("skyturn-delivery-managed-");
    tempRoots.push(repo.tempRoot);
    const service = createNodeGitWorktreeService();
    const worktree = await service.createManagedWorktree({
      sessionId: "session-1",
      variantId: "delivery",
      repoRoot: repo.repoRoot,
      baseCommit: repo.baseCommit,
      branchName: "skyturn/session-1/delivery",
      parentLaneId: "lane-commit",
    });
    await writeFile(join(worktree.realPath, "feature.txt"), "managed change\n");

    await expect(createDeliveryCommit({
      projectRoot: repo.repoRoot,
      worktreePath: worktree.realPath,
      files: ["../project/feature.txt"],
      subject: "feat(delivery): add verified commit action",
    })).rejects.toThrow(/inside the worktree/i);

    await expect(createDeliveryCommit({
      projectRoot: repo.repoRoot,
      worktreePath: worktree.realPath,
      files: ["feature.txt"],
      subject: "feat(delivery): add verified commit action",
    })).resolves.toMatchObject({
      branch: "skyturn/session-1/delivery",
      stagedFiles: ["feature.txt"],
      worktreePath: worktree.realPath,
    });
  });

  it("rejects requested file paths traversing through symlinked directories outside the worktree", async () => {
    const repo = await createTestRepo("skyturn-delivery-symlink-");
    tempRoots.push(repo.tempRoot);
    const outsideRoot = await mkdtemp(join(tmpdir(), "skyturn-delivery-outside-"));
    tempRoots.push(outsideRoot);
    await writeFile(join(outsideRoot, "secret.txt"), "outside\n");
    await fsSymlink(outsideRoot, join(repo.repoRoot, "outside-link"), "dir");

    await expect(createDeliveryCommit({
      projectRoot: repo.repoRoot,
      worktreePath: repo.repoRoot,
      files: ["outside-link/secret.txt"],
      subject: "feat(delivery): add verified commit action",
    })).rejects.toThrow(/inside the worktree|symlink/i);
  });
});

describe("GitChangesetService", () => {
  afterEach(async () => {
    await Promise.all(changesetTempRoots.splice(0).map((root) => rm(root, { force: true, recursive: true })));
  });

  it("returns current checkout branch facts from local git refs", async () => {
    const repoRoot = await createRepo();
    await gitAsync(repoRoot, "branch", "-m", "main");
    await gitAsync(repoRoot, "checkout", "-b", "feature/api");

    const facts = await getGitBranchFacts(repoRoot);

    expect(facts.currentBranch).toBe("feature/api");
    expect(facts.branches).toContain("main");
    expect(facts.branches).toContain("feature/api");
  });

  it("uses HEAD as the current branch fallback for detached checkouts", async () => {
    const repoRoot = await createRepo();
    await gitAsync(repoRoot, "branch", "-m", "main");
    const head = execFileSync("git", ["rev-parse", "HEAD"], { cwd: repoRoot, encoding: "utf8" }).trim();
    await gitAsync(repoRoot, "checkout", "--detach", head);

    const facts = await getGitBranchFacts(repoRoot);

    expect(facts.currentBranch).toBe("HEAD");
    expect(facts.branches).toContain("HEAD");
    expect(facts.branches).toContain("main");
  });

  it("returns HEAD fallback facts when branch git commands fail", async () => {
    const root = await mkdtemp(join(tmpdir(), "skyturn-branch-facts-nongit-"));
    changesetTempRoots.push(root);

    await expect(getGitBranchFacts(root)).resolves.toEqual({
      currentBranch: "HEAD",
      branches: ["HEAD"],
    });
  });

  it("collects source git changeset evidence from a modified tracked file", async () => {
    const repoRoot = await createRepo();
    await writeFile(join(repoRoot, "src.ts"), "export const value = 2;\nexport const added = true;\n", "utf8");

    const service = createGitChangesetService();
    const changeset = await service.getChangeset(nodeForRepo(repoRoot));

    expect(changeset.source).toBe("git");
    expect(changeset.evidence?.source).toBe("git");
    expect(changeset.evidence?.status).toBe("available");
    expect(changeset.files).toEqual(["src.ts"]);
    expect(changeset.diffStat.changed).toBe(1);
    expect(changeset.diffStat.added).toBeGreaterThan(0);
    expect(changeset.patchPreview).toContain("diff --git a/src.ts b/src.ts");
  });

  it("returns empty git evidence instead of mock data for a clean repository", async () => {
    const repoRoot = await createRepo();

    const service = createGitChangesetService();
    const changeset = await service.getChangeset(nodeForRepo(repoRoot));

    expect(changeset.source).toBe("git");
    expect(changeset.evidence?.status).toBe("empty");
    expect(changeset.files).toEqual([]);
    expect(changeset.diffStat).toEqual({ added: 0, changed: 0, deleted: 0 });
    expect(changeset.patchPreview).toBe("");
  });

  it("bounds the diff preview without losing the git source marker", async () => {
    const repoRoot = await createRepo();
    await writeFile(join(repoRoot, "src.ts"), Array.from({ length: 80 }, (_, index) => `line ${index}\n`).join(""), "utf8");

    const service = createGitChangesetService({ maxPatchPreviewBytes: 180 });
    const changeset = await service.getChangeset(nodeForRepo(repoRoot));

    expect(changeset.source).toBe("git");
    expect(changeset.patchPreview.length).toBeLessThanOrEqual(240);
    expect(changeset.evidence?.patchPreviewTruncated).toBe(true);
    expect(changeset.patchPreview).toContain("diff --git");
  });

  it("includes untracked files in the diff evidence without staging them", async () => {
    const repoRoot = await createRepo();
    await mkdir(join(repoRoot, "src"));
    await writeFile(join(repoRoot, "src", "new.ts"), "export const created = true;\n", "utf8");

    const service = createGitChangesetService();
    const changeset = await service.getChangeset(nodeForRepo(repoRoot));

    expect(changeset.source).toBe("git");
    expect(changeset.evidence?.status).toBe("available");
    expect(changeset.files).toEqual(["src/new.ts"]);
    expect(changeset.diffStat.added).toBe(1);
    expect(changeset.patchPreview).toContain("diff --git a/src/new.ts b/src/new.ts");
    expect(changeset.patchPreview).toContain("+export const created = true;");
    await gitAsync(repoRoot, "diff", "--quiet", "--cached");
  });

  it("returns empty final reconciliation for a clean current branch target", async () => {
    const repoRoot = await createRepo();

    const service = createGitChangesetService();
    const reconciliation = await service.reconcileFinalChangeset({
      node: nodeForRepo(repoRoot),
      target: {
        executionTarget: "current_branch",
        selectedBranch: "main",
      },
      baselineRef: "HEAD",
    });

    expect(reconciliation.status).toBe("empty");
    expect(reconciliation.metadata).toMatchObject({
      executionTarget: "current_branch",
      selectedBranch: "main",
      baselineRef: "HEAD",
    });
    expect(reconciliation.changeset.files).toEqual([]);
  });

  it("returns available final reconciliation with a bounded git diff preview", async () => {
    const repoRoot = await createRepo();
    await writeFile(join(repoRoot, "src.ts"), "export const value = 2;\n", "utf8");

    const service = createGitChangesetService();
    const reconciliation = await service.reconcileFinalChangeset({
      node: nodeForRepo(repoRoot),
      target: {
        executionTarget: "current_branch",
        selectedBranch: "main",
      },
      baselineRef: "HEAD",
    });

    expect(reconciliation.status).toBe("available");
    expect(reconciliation.changeset.files).toEqual(["src.ts"]);
    expect(reconciliation.changeset.patchPreview).toContain("diff --git a/src.ts b/src.ts");
  });

  it("returns failed final reconciliation when the baseline ref is invalid", async () => {
    const repoRoot = await createRepo();

    const service = createGitChangesetService();
    const reconciliation = await service.reconcileFinalChangeset({
      node: nodeForRepo(repoRoot),
      target: {
        executionTarget: "current_branch",
        selectedBranch: "main",
      },
      baselineRef: "refs/heads/does-not-exist",
    });

    expect(reconciliation.status).toBe("failed");
    expect(reconciliation.errorReason).toMatch(/does-not-exist|unknown revision|ambiguous/i);
    expect(reconciliation.changeset.evidence?.status).toBe("failed");
  });

  it("reports mismatch when live structured changes disagree with git reconciliation", async () => {
    const repoRoot = await createRepo();
    await writeFile(join(repoRoot, "src.ts"), "export const value = 2;\n", "utf8");
    const liveChanges: LiveRunChangesEvidence = {
      source: "codex",
      status: "available",
      files: ["src/other.ts"],
      changes: [{ operation: "update", path: "src/other.ts" }],
      collectedAt: "2026-06-19T00:00:00.000Z",
    };

    const service = createGitChangesetService();
    const reconciliation = await service.reconcileFinalChangeset({
      node: nodeForRepo(repoRoot),
      target: {
        executionTarget: "current_branch",
        selectedBranch: "main",
      },
      baselineRef: "HEAD",
      liveChanges,
    });

    expect(reconciliation.status).toBe("mismatch");
    expect(reconciliation.mismatches).toEqual([
      { kind: "file-set", liveFiles: ["src/other.ts"], gitFiles: ["src.ts"] },
    ]);
    expect(reconciliation.liveChanges).toEqual(liveChanges);
  });
});

async function createRepo(): Promise<string> {
  const repoRoot = await mkdtemp(join(tmpdir(), "skyturn-git-changeset-"));
  changesetTempRoots.push(repoRoot);
  await gitAsync(repoRoot, "init");
  await gitAsync(repoRoot, "config", "user.email", "skyturn@example.test");
  await gitAsync(repoRoot, "config", "user.name", "SkyTurn Test");
  await writeFile(join(repoRoot, "src.ts"), "export const value = 1;\n", "utf8");
  await gitAsync(repoRoot, "add", "src.ts");
  await gitAsync(repoRoot, "commit", "-m", "initial");
  return repoRoot;
}

async function gitAsync(cwd: string, ...args: string[]): Promise<void> {
  await execFileAsync("git", args, { cwd });
}

function nodeForRepo(repoRoot: string): CanvasNode {
  return {
    id: "node-1",
    changesetId: "changeset-node-1",
    worktree: {
      path: repoRoot,
      branchName: "main",
      baseCommit: "HEAD",
    },
  } as CanvasNode;
}
