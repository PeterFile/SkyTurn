import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import type { WorkflowVariantAdoption } from "@skyturn/project-core";
import {
  createNodeGitWorktreeService,
  type ManagedWorktreeWorkflowEvent,
  worktreeMetadataForVariant,
} from "./node";

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
    await expect(busyService.cleanManagedWorktree({ worktree: refreshedRight })).rejects.toThrow(/running tasks/i);
    expect(existsSync(refreshedRight.realPath)).toBe(true);

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
