import { execFile, execFileSync } from "node:child_process";
import { existsSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { promisify } from "node:util";

import { afterEach, describe, expect, it } from "vitest";

import type { CanvasNode, LiveRunChangesEvidence, WorkflowVariantAdoption } from "@skyturn/project-core";
import {
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
