import { ChildProcess, execFile, execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, readdirSync, readFileSync, realpathSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { chmod, mkdir, mkdtemp, rm, symlink as fsSymlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { promisify } from "node:util";

import { afterEach, describe, expect, it } from "vitest";

import type { CanvasNode, LiveRunChangesEvidence, WorkflowVariantAdoption, WorkflowWorktreeIdentity } from "@skyturn/project-core";
import {
  checkDeliveryPullRequest,
  captureCandidateDeliveryReviewSnapshot,
  createCandidateDeliveryCommit,
  createDeliveryCommit,
  createDeliveryPullRequest,
  createGitChangesetService,
  createLiveWorkflowGitAncestryProofContext,
  createNodeGitWorktreeService,
  createWorkflowGitAncestryProof,
  DeliveryCommitError,
  evaluateRollbackWorktreeState,
  getGitCheckpointSnapshot,
  mergeDeliveryPullRequest,
  pushDeliveryBranch,
  getGitBranchFacts,
  SKYTURN_VOLATILE_GIT_PATHS,
  resetRollbackWorktreeToCommit,
  syncDeliveryMain,
  verifyWorkflowGitAncestryProof,
  WorkflowGitAncestryProofError,
  type WorkflowGitAncestryProofInput,
  type ManagedWorktreeWorkflowEvent,
  worktreeMetadataForVariant,
} from "./node.js";
import type { CandidateCommitExpectation } from "./index.js";

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

function gitBuffer(cwd: string, args: string[]): Buffer {
  return execFileSync("git", args, {
    cwd,
    encoding: "buffer",
    maxBuffer: 2 * 1024 * 1024,
    stdio: ["ignore", "pipe", "pipe"],
  });
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

async function createRollbackWorktreeFixture(tempRoots: string[]): Promise<{
  repo: TestRepo;
  worktree: WorkflowWorktreeIdentity;
  headCommit: string;
}> {
  const repo = await createTestRepo("skyturn-rollback-worktree-");
  tempRoots.push(repo.tempRoot);
  const service = createNodeGitWorktreeService();
  const worktree = await service.createManagedWorktree({
    sessionId: "session-1",
    variantId: "rollback",
    repoRoot: repo.repoRoot,
    baseCommit: repo.baseCommit,
    branchName: "skyturn/rollback",
    parentLaneId: "lane-implementation",
  });
  const headCommit = commitVariant(worktree.realPath, "rollback-head");
  return { repo, worktree, headCommit };
}

function ancestryInput(
  repo: TestRepo,
  overrides: Partial<WorkflowGitAncestryProofInput> = {},
): WorkflowGitAncestryProofInput {
  return {
    repositoryPath: repo.repoRoot,
    worktreePath: repo.repoRoot,
    beforeHeadCommit: repo.baseCommit,
    afterHeadCommit: repo.baseCommit,
    ...overrides,
  };
}

function directoryIdentity(path: string): {
  dev: string;
  ino: string;
  birthtimeNs: string;
} {
  const facts = statSync(path, { bigint: true });
  return {
    dev: facts.dev.toString(),
    ino: facts.ino.toString(),
    birthtimeNs: facts.birthtimeNs.toString(),
  };
}

function reinitializeRepositoryContents(repoRoot: string): string {
  const gitDirectory = join(repoRoot, ".git");
  for (const entry of readdirSync(gitDirectory)) {
    rmSync(join(gitDirectory, entry), { recursive: true, force: true });
  }
  git(repoRoot, ["init"]);
  git(repoRoot, ["config", "user.email", "skyturn@example.test"]);
  git(repoRoot, ["config", "user.name", "SkyTurn Test"]);
  writeFileSync(join(repoRoot, "replacement.txt"), "replacement\n");
  git(repoRoot, ["add", "replacement.txt"]);
  git(repoRoot, ["commit", "-m", "replacement"]);
  return git(repoRoot, ["rev-parse", "HEAD"]);
}

async function expectAncestryError(
  operation: Promise<unknown>,
  code: WorkflowGitAncestryProofError["code"],
  forbiddenPaths: string[] = [],
): Promise<WorkflowGitAncestryProofError> {
  let caught: unknown;
  try {
    await operation;
  } catch (error) {
    caught = error;
  }
  expect(caught).toBeInstanceOf(WorkflowGitAncestryProofError);
  const ancestryError = caught as WorkflowGitAncestryProofError;
  expect(ancestryError.code).toBe(code);
  for (const path of forbiddenPaths) {
    expect(ancestryError.message).not.toContain(path);
    expect(JSON.stringify(ancestryError)).not.toContain(path);
  }
  return ancestryError;
}

describe("workflow Git ancestry proof service", () => {
  const tempRoots: string[] = [];

  afterEach(() => {
    for (const root of tempRoots.splice(0)) {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("creates exact canonical bytes for an equal commit with stable alias-safe identities", async () => {
    const repo = await createTestRepo("skyturn-ancestry-equal-");
    tempRoots.push(repo.tempRoot);
    const repositoryAlias = join(repo.tempRoot, "repository-alias");
    const worktreeAlias = join(repo.tempRoot, "worktree-alias");
    await fsSymlink(repo.repoRoot, repositoryAlias, "dir");
    await fsSymlink(repo.repoRoot, worktreeAlias, "dir");

    const directContext = await createLiveWorkflowGitAncestryProofContext(ancestryInput(repo));
    const aliasContext = await createLiveWorkflowGitAncestryProofContext(ancestryInput(repo, {
      repositoryPath: repositoryAlias,
      worktreePath: worktreeAlias,
    }));
    const repeatedContext = await createLiveWorkflowGitAncestryProofContext(ancestryInput(repo));
    commitVariant(repo.repoRoot, "identity-update");
    const postCommitContext = await createLiveWorkflowGitAncestryProofContext(ancestryInput(repo));
    const serializedProof = await createWorkflowGitAncestryProof(ancestryInput(repo));
    const expectedBytes = JSON.stringify({
      protocolVersion: 1,
      method: "git-merge-base-is-ancestor",
      ...directContext,
    });

    expect(aliasContext).toEqual(directContext);
    expect(repeatedContext).toEqual(directContext);
    expect(postCommitContext).toEqual(directContext);
    expect(serializedProof).toBe(expectedBytes);
    expect(serializedProof).toHaveLength(356);
    expect(serializedProof).not.toContain(repo.tempRoot);
    await expect(verifyWorkflowGitAncestryProof(serializedProof, ancestryInput(repo))).resolves.toEqual(
      JSON.parse(serializedProof),
    );
  });

  it("proves linear ancestry through a real linked worktree", async () => {
    const repo = await createTestRepo("skyturn-ancestry-linear-");
    tempRoots.push(repo.tempRoot);
    const worktreePath = join(repo.tempRoot, "linked-worktree");
    git(repo.repoRoot, ["worktree", "add", "-b", "test/linear", worktreePath, repo.baseCommit]);
    const afterHeadCommit = commitVariant(worktreePath, "linear");
    const input = ancestryInput(repo, { worktreePath, afterHeadCommit });

    const serializedProof = await createWorkflowGitAncestryProof(input);

    await expect(verifyWorkflowGitAncestryProof(serializedProof, input)).resolves.toMatchObject({
      beforeHeadCommit: repo.baseCommit,
      afterHeadCommit,
      method: "git-merge-base-is-ancestor",
    });
  });

  it("returns NOT_ANCESTOR and no proof for divergent real commits", async () => {
    const repo = await createTestRepo("skyturn-ancestry-divergent-");
    tempRoots.push(repo.tempRoot);
    const leftPath = join(repo.tempRoot, "left");
    const rightPath = join(repo.tempRoot, "right");
    git(repo.repoRoot, ["worktree", "add", "-b", "test/left", leftPath, repo.baseCommit]);
    git(repo.repoRoot, ["worktree", "add", "-b", "test/right", rightPath, repo.baseCommit]);
    const leftCommit = commitVariant(leftPath, "left-commit");
    const rightCommit = commitVariant(rightPath, "right-commit");

    await expectAncestryError(
      createWorkflowGitAncestryProof(ancestryInput(repo, {
        worktreePath: rightPath,
        beforeHeadCommit: leftCommit,
        afterHeadCommit: rightCommit,
      })),
      "NOT_ANCESTOR",
      [repo.tempRoot],
    );
  });

  it("fails closed for invalid input and repository, worktree, commit, and ownership failures", async () => {
    const repo = await createTestRepo("skyturn-ancestry-failures-");
    const otherRepo = await createTestRepo("skyturn-ancestry-other-");
    tempRoots.push(repo.tempRoot, otherRepo.tempRoot);
    const nestedPath = join(repo.repoRoot, "nested");
    await mkdir(nestedPath);
    const cases: Array<{
      input: WorkflowGitAncestryProofInput;
      code: WorkflowGitAncestryProofError["code"];
    }> = [
      {
        input: ancestryInput(repo, { beforeHeadCommit: repo.baseCommit.toUpperCase() }),
        code: "INVALID_INPUT",
      },
      {
        input: ancestryInput(repo, { repositoryPath: join(repo.tempRoot, "missing-repository") }),
        code: "GIT_EXECUTION_FAILED",
      },
      {
        input: ancestryInput(repo, { repositoryPath: join(repo.repoRoot, "feature.txt") }),
        code: "GIT_EXECUTION_FAILED",
      },
      {
        input: ancestryInput(repo, { repositoryPath: nestedPath }),
        code: "GIT_EXECUTION_FAILED",
      },
      {
        input: ancestryInput(repo, { worktreePath: join(repo.tempRoot, "missing-worktree") }),
        code: "GIT_EXECUTION_FAILED",
      },
      {
        input: ancestryInput(repo, { worktreePath: nestedPath }),
        code: "GIT_EXECUTION_FAILED",
      },
      {
        input: ancestryInput(repo, { worktreePath: otherRepo.repoRoot }),
        code: "GIT_EXECUTION_FAILED",
      },
      {
        input: ancestryInput(repo, { afterHeadCommit: "f".repeat(40) }),
        code: "GIT_EXECUTION_FAILED",
      },
    ];

    for (const testCase of cases) {
      await expectAncestryError(
        createWorkflowGitAncestryProof(testCase.input),
        testCase.code,
        [repo.tempRoot, otherRepo.tempRoot],
      );
    }
  });

  it("rejects replay in another repository or another worktree through live context parsing", async () => {
    const repo = await createTestRepo("skyturn-ancestry-replay-source-");
    const otherRepo = await createTestRepo("skyturn-ancestry-replay-target-");
    tempRoots.push(repo.tempRoot, otherRepo.tempRoot);
    const serializedProof = await createWorkflowGitAncestryProof(ancestryInput(repo));
    git(otherRepo.repoRoot, ["fetch", repo.repoRoot, repo.baseCommit]);
    const otherWorktree = join(repo.tempRoot, "other-worktree");
    git(repo.repoRoot, ["worktree", "add", "--detach", otherWorktree, repo.baseCommit]);

    await expectAncestryError(
      verifyWorkflowGitAncestryProof(serializedProof, ancestryInput(otherRepo, {
        beforeHeadCommit: repo.baseCommit,
        afterHeadCommit: repo.baseCommit,
      })),
      "GIT_EXECUTION_FAILED",
    );
    await expectAncestryError(
      verifyWorkflowGitAncestryProof(serializedProof, ancestryInput(repo, { worktreePath: otherWorktree })),
      "GIT_EXECUTION_FAILED",
    );
  });

  it("rejects an old proof after the repository is destroyed and recreated at the exact path", async () => {
    const repo = await createTestRepo("skyturn-ancestry-recreated-");
    tempRoots.push(repo.tempRoot);
    const serializedProof = await createWorkflowGitAncestryProof(ancestryInput(repo));
    const oldRepositoryIdentity = directoryIdentity(repo.repoRoot);
    rmSync(repo.repoRoot, { recursive: true, force: true });
    git(repo.tempRoot, ["init", "project"]);
    git(repo.repoRoot, ["config", "user.email", "skyturn@example.test"]);
    git(repo.repoRoot, ["config", "user.name", "SkyTurn Test"]);
    writeFileSync(join(repo.repoRoot, "new.txt"), "new\n");
    git(repo.repoRoot, ["add", "new.txt"]);
    git(repo.repoRoot, ["commit", "-m", "new repository"]);

    expect(directoryIdentity(repo.repoRoot)).not.toEqual(oldRepositoryIdentity);
    await expectAncestryError(
      verifyWorkflowGitAncestryProof(serializedProof, ancestryInput(repo)),
      "GIT_EXECUTION_FAILED",
    );
  });

  it("rejects an old linked-worktree proof after only the repository top-level object is replaced", async () => {
    const repo = await createTestRepo("skyturn-ancestry-linked-repository-root-replaced-");
    tempRoots.push(repo.tempRoot);
    const worktreePath = join(repo.tempRoot, "linked-worktree");
    git(repo.repoRoot, ["worktree", "add", "-b", "test/root-replacement", worktreePath, repo.baseCommit]);
    const afterHeadCommit = commitVariant(worktreePath, "linked-root-replacement");
    const input = ancestryInput(repo, { worktreePath, afterHeadCommit });
    const serializedProof = await createWorkflowGitAncestryProof(input);
    const oldRepositoryIdentity = directoryIdentity(repo.repoRoot);
    const gitDirectory = join(repo.repoRoot, ".git");
    const objectDirectory = join(gitDirectory, "objects");
    const oldGitDirectoryIdentity = directoryIdentity(gitDirectory);
    const oldObjectDirectoryIdentity = directoryIdentity(objectDirectory);
    const preservedGitDirectory = join(repo.tempRoot, "preserved.git");

    renameSync(gitDirectory, preservedGitDirectory);
    rmSync(repo.repoRoot, { recursive: true, force: true });
    await mkdir(repo.repoRoot);
    renameSync(preservedGitDirectory, gitDirectory);

    expect(directoryIdentity(repo.repoRoot)).not.toEqual(oldRepositoryIdentity);
    expect(directoryIdentity(gitDirectory)).toEqual(oldGitDirectoryIdentity);
    expect(directoryIdentity(objectDirectory)).toEqual(oldObjectDirectoryIdentity);
    expect(git(repo.repoRoot, ["rev-parse", "HEAD"])).toBe(repo.baseCommit);
    expect(git(worktreePath, ["rev-parse", "HEAD"])).toBe(afterHeadCommit);
    expect(git(repo.repoRoot, ["worktree", "list", "--porcelain"])).toContain(realpathSync(worktreePath));
    await expectAncestryError(
      verifyWorkflowGitAncestryProof(serializedProof, input),
      "GIT_EXECUTION_FAILED",
    );
  });

  it("rejects an old proof after a linked worktree is removed and re-added at the exact path", async () => {
    const repo = await createTestRepo("skyturn-ancestry-worktree-readded-");
    tempRoots.push(repo.tempRoot);
    const worktreePath = join(repo.tempRoot, "reusable-worktree");
    git(repo.repoRoot, ["worktree", "add", "-b", "test/reusable", worktreePath, repo.baseCommit]);
    const input = ancestryInput(repo, { worktreePath });
    const serializedProof = await createWorkflowGitAncestryProof(input);
    const oldWorktreeIdentity = directoryIdentity(worktreePath);
    git(repo.repoRoot, ["worktree", "remove", "--force", worktreePath]);
    git(repo.repoRoot, ["worktree", "add", worktreePath, "test/reusable"]);

    expect(directoryIdentity(worktreePath)).not.toEqual(oldWorktreeIdentity);
    await expectAncestryError(
      verifyWorkflowGitAncestryProof(serializedProof, input),
      "GIT_EXECUTION_FAILED",
    );
  });

  it("rejects in-place repository re-init even when root and .git directory objects survive", async () => {
    const repo = await createTestRepo("skyturn-ancestry-in-place-reinit-");
    tempRoots.push(repo.tempRoot);
    const serializedProof = await createWorkflowGitAncestryProof(ancestryInput(repo));
    const rootIdentity = directoryIdentity(repo.repoRoot);
    const gitDirectoryIdentity = directoryIdentity(join(repo.repoRoot, ".git"));

    reinitializeRepositoryContents(repo.repoRoot);

    expect(directoryIdentity(repo.repoRoot)).toEqual(rootIdentity);
    expect(directoryIdentity(join(repo.repoRoot, ".git"))).toEqual(gitDirectoryIdentity);
    await expectAncestryError(
      verifyWorkflowGitAncestryProof(serializedProof, ancestryInput(repo)),
      "GIT_EXECUTION_FAILED",
    );
  });

  it("returns no proof when in-place replacement happens after successful merge-base", async () => {
    const repo = await createTestRepo("skyturn-ancestry-command-race-");
    tempRoots.push(repo.tempRoot);
    const rootIdentity = directoryIdentity(repo.repoRoot);
    const gitDirectoryIdentity = directoryIdentity(join(repo.repoRoot, ".git"));
    const fakeGit = await installAncestryGitWrapper(repo.tempRoot, {
      mode: "reinitialize-after-success",
      repositoryPath: repo.repoRoot,
    });

    await withFakeGit(fakeGit.binDir, async () => {
      await expectAncestryError(
        createWorkflowGitAncestryProof(ancestryInput(repo)),
        "GIT_EXECUTION_FAILED",
        [repo.tempRoot],
      );
    });
    expect(directoryIdentity(repo.repoRoot)).toEqual(rootIdentity);
    expect(directoryIdentity(join(repo.repoRoot, ".git"))).toEqual(gitDirectoryIdentity);
  });

  it("rejects tampered commit, repository, and worktree proof fields", async () => {
    const repo = await createTestRepo("skyturn-ancestry-tampered-");
    tempRoots.push(repo.tempRoot);
    const input = ancestryInput(repo);
    const serializedProof = await createWorkflowGitAncestryProof(input);
    const proof = JSON.parse(serializedProof) as Record<string, unknown>;
    await expectAncestryError(
      verifyWorkflowGitAncestryProof("{}", input),
      "INVALID_INPUT",
    );
    const tampered = [
      { ...proof, beforeHeadCommit: "f".repeat(40) },
      { ...proof, afterHeadCommit: "e".repeat(40) },
      { ...proof, repositoryIdentity: "0".repeat(64) },
      { ...proof, worktreeIdentity: "1".repeat(64) },
    ];

    for (const value of tampered) {
      await expectAncestryError(
        verifyWorkflowGitAncestryProof(JSON.stringify(value), input),
        "GIT_EXECUTION_FAILED",
      );
    }
  });

  it("distinguishes verifier NOT_ANCESTOR from Git command execution failure", async () => {
    const repo = await createTestRepo("skyturn-ancestry-verifier-codes-");
    tempRoots.push(repo.tempRoot);
    const leftPath = join(repo.tempRoot, "verifier-left");
    const rightPath = join(repo.tempRoot, "verifier-right");
    git(repo.repoRoot, ["worktree", "add", "-b", "test/verifier-left", leftPath, repo.baseCommit]);
    git(repo.repoRoot, ["worktree", "add", "-b", "test/verifier-right", rightPath, repo.baseCommit]);
    const leftCommit = commitVariant(leftPath, "verifier-left");
    const rightCommit = commitVariant(rightPath, "verifier-right");
    const divergentInput = ancestryInput(repo, {
      worktreePath: rightPath,
      beforeHeadCommit: leftCommit,
      afterHeadCommit: rightCommit,
    });
    const divergentContext = await createLiveWorkflowGitAncestryProofContext(divergentInput);
    const canonicalButUnattested = JSON.stringify({
      protocolVersion: 1,
      method: "git-merge-base-is-ancestor",
      ...divergentContext,
    });
    await expectAncestryError(
      verifyWorkflowGitAncestryProof(canonicalButUnattested, divergentInput),
      "NOT_ANCESTOR",
    );

    const validProof = await createWorkflowGitAncestryProof(ancestryInput(repo));
    const fakeGit = await installAncestryGitWrapper(repo.tempRoot, {
      mode: "fail-after-success",
      repositoryPath: repo.repoRoot,
    });
    await withFakeGit(fakeGit.binDir, async () => {
      await expectAncestryError(
        verifyWorkflowGitAncestryProof(validProof, ancestryInput(repo)),
        "GIT_EXECUTION_FAILED",
      );
    });
  });
});

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

  it("blocks rollback reset when the managed worktree has dirty or untracked files", async () => {
    const { repo, worktree, headCommit } = await createRollbackWorktreeFixture(tempRoots);
    writeFileSync(join(worktree.realPath, "untracked.txt"), "dirty\n");

    const result = await evaluateRollbackWorktreeState({
      projectRoot: repo.repoRoot,
      worktreePath: worktree.realPath,
      expectedBranchName: worktree.branchName,
      expectedHeadCommit: headCommit,
      restoreCommitRef: repo.baseCommit,
    });

    expect(result).toMatchObject({
      status: "manual_repair_required",
      reasonCode: "dirty_worktree",
      manualRepairRequired: true,
    });
    expect(git(worktree.realPath, ["rev-parse", "HEAD"])).toBe(headCommit);
  });

  it("blocks rollback reset on the wrong branch before changing HEAD", async () => {
    const { repo, worktree, headCommit } = await createRollbackWorktreeFixture(tempRoots);
    git(worktree.realPath, ["checkout", "-b", "skyturn/rollback-other"]);

    const result = await evaluateRollbackWorktreeState({
      projectRoot: repo.repoRoot,
      worktreePath: worktree.realPath,
      expectedBranchName: worktree.branchName,
      expectedHeadCommit: headCommit,
      restoreCommitRef: repo.baseCommit,
    });

    expect(result).toMatchObject({
      status: "manual_repair_required",
      reasonCode: "branch_mismatch",
      manualRepairRequired: true,
    });
    expect(git(worktree.realPath, ["rev-parse", "HEAD"])).toBe(headCommit);
  });

  it("blocks rollback reset when the path is not the recorded managed worktree", async () => {
    const { repo, worktree, headCommit } = await createRollbackWorktreeFixture(tempRoots);

    const result = await evaluateRollbackWorktreeState({
      projectRoot: repo.repoRoot,
      worktreePath: repo.repoRoot,
      expectedBranchName: worktree.branchName,
      expectedHeadCommit: headCommit,
      restoreCommitRef: repo.baseCommit,
    });

    expect(result).toMatchObject({
      status: "manual_repair_required",
      reasonCode: "unmanaged_worktree",
      manualRepairRequired: true,
    });
    expect(git(worktree.realPath, ["rev-parse", "HEAD"])).toBe(headCommit);
  });

  it("requires full reachable commit evidence before rollback reset", async () => {
    const { repo, worktree, headCommit } = await createRollbackWorktreeFixture(tempRoots);

    const shortRestore = await evaluateRollbackWorktreeState({
      projectRoot: repo.repoRoot,
      worktreePath: worktree.realPath,
      expectedBranchName: worktree.branchName,
      expectedHeadCommit: headCommit,
      restoreCommitRef: repo.baseCommit.slice(0, 12),
    });
    const missingRestore = await evaluateRollbackWorktreeState({
      projectRoot: repo.repoRoot,
      worktreePath: worktree.realPath,
      expectedBranchName: worktree.branchName,
      expectedHeadCommit: headCommit,
      restoreCommitRef: "f".repeat(40),
    });

    expect(shortRestore).toMatchObject({
      status: "manual_repair_required",
      reasonCode: "invalid_restore_commit",
      manualRepairRequired: true,
    });
    expect(missingRestore).toMatchObject({
      status: "manual_repair_required",
      reasonCode: "missing_restore_commit",
      manualRepairRequired: true,
    });
    expect(git(worktree.realPath, ["rev-parse", "HEAD"])).toBe(headCommit);
  });

  it("recovers idempotent rollback retry when HEAD is already restored", async () => {
    const { repo, worktree, headCommit } = await createRollbackWorktreeFixture(tempRoots);

    const applied = await resetRollbackWorktreeToCommit({
      projectRoot: repo.repoRoot,
      worktreePath: worktree.realPath,
      expectedBranchName: worktree.branchName,
      expectedHeadCommit: headCommit,
      restoreCommitRef: repo.baseCommit,
    });
    const retry = await evaluateRollbackWorktreeState({
      projectRoot: repo.repoRoot,
      worktreePath: worktree.realPath,
      expectedBranchName: worktree.branchName,
      expectedHeadCommit: headCommit,
      restoreCommitRef: repo.baseCommit,
    });

    expect(applied).toMatchObject({
      status: "applied",
      headCommit: repo.baseCommit,
    });
    expect(retry).toMatchObject({
      status: "already_restored",
      headCommit: repo.baseCommit,
    });
  });

  it("reports manual repair when git reset fails after rollback request evidence would be durable", async () => {
    const { repo, worktree, headCommit } = await createRollbackWorktreeFixture(tempRoots);
    const fakeGit = await installFakeGit(repo.tempRoot, { resetExitCode: 23 });

    await withFakeGit(fakeGit.binDir, async () => {
      const result = await resetRollbackWorktreeToCommit({
        projectRoot: repo.repoRoot,
        worktreePath: worktree.realPath,
        expectedBranchName: worktree.branchName,
        expectedHeadCommit: headCommit,
        restoreCommitRef: repo.baseCommit,
      });

      expect(result).toMatchObject({
        status: "manual_repair_required",
        reasonCode: "git_reset_failed",
        manualRepairRequired: true,
      });
      expect(git(worktree.realPath, ["rev-parse", "HEAD"])).toBe(headCommit);
    });
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

describe("candidate delivery commits", () => {
  const tempRoots: string[] = [];
  const candidateMessageMaxBytes = 1024 * 1024;

  afterEach(() => {
    for (const root of tempRoots.splice(0)) {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it.skipIf(process.platform === "win32")("captures the exact reviewed binary, symlink, and executable patch without exposing files", async () => {
    const repo = await createTestRepo("skyturn-candidate-review-snapshot-");
    tempRoots.push(repo.tempRoot);
    await writeFile(join(repo.repoRoot, "binary.dat"), Buffer.from([0, 1, 2, 0xff, 0, 3]));
    await writeFile(join(repo.repoRoot, "run.sh"), "#!/bin/sh\necho reviewed\n");
    await chmod(join(repo.repoRoot, "run.sh"), 0o755);
    await fsSymlink("run.sh", join(repo.repoRoot, "run-link"));
    const headCommit = git(repo.repoRoot, ["rev-parse", "HEAD"]);
    const expected = await candidateExpectationFor(repo.repoRoot, headCommit, headCommit);

    const snapshot = await captureCandidateDeliveryReviewSnapshot({
      projectRoot: repo.repoRoot,
      worktreePath: repo.repoRoot,
      expected,
    });
    const patch = Buffer.from(snapshot.fullPatchBase64, "base64");

    expect(snapshot).toEqual({
      baselineCommit: headCommit,
      headCommit,
      fullPatchBase64: expect.any(String),
      fullPatchSha256: expected.fullPatchSha256,
      fullPatchByteLength: expected.fullPatchByteLength,
      fileManifestSha256: expected.fileManifestSha256,
    });
    expect(snapshot).not.toHaveProperty("files");
    expect(patch.byteLength).toBe(expected.fullPatchByteLength);
    expect(createHash("sha256").update(patch).digest("hex")).toBe(expected.fullPatchSha256);
    expect(patch.toString("utf8")).toContain("GIT binary patch");
    expect(patch.toString("utf8")).toContain("new file mode 120000");
    expect(patch.toString("utf8")).toContain("new file mode 100755");
  });

  it("rejects a stale review snapshot expectation with the bounded candidate error", async () => {
    const repo = await createTestRepo("skyturn-candidate-review-stale-");
    tempRoots.push(repo.tempRoot);
    await writeFile(join(repo.repoRoot, "feature.txt"), "reviewed once\n");
    const headCommit = git(repo.repoRoot, ["rev-parse", "HEAD"]);
    const expected = await candidateExpectationFor(repo.repoRoot, headCommit, headCommit);
    await writeFile(join(repo.repoRoot, "feature.txt"), "changed after manifest\n");

    await expect(captureCandidateDeliveryReviewSnapshot({
      projectRoot: repo.repoRoot,
      worktreePath: repo.repoRoot,
      expected,
    })).rejects.toThrow("Candidate delivery commit was rejected.");
  });

  it("publishes the reviewed tree with minimal evidence without changing the real index", async () => {
    const repo = await createTestRepo("skyturn-candidate-commit-");
    tempRoots.push(repo.tempRoot);
    await writeFile(join(repo.repoRoot, "feature.txt"), "reviewed\n");
    const headCommit = git(repo.repoRoot, ["rev-parse", "HEAD"]);
    const expected = await candidateExpectationFor(repo.repoRoot, headCommit, headCommit);
    const indexPath = git(repo.repoRoot, ["rev-parse", "--path-format=absolute", "--git-path", "index"]);
    const indexBefore = readFileSync(indexPath);

    const evidence = await createCandidateDeliveryCommit({
      projectRoot: repo.repoRoot,
      worktreePath: repo.repoRoot,
      expected,
      subject: "feat(delivery): publish reviewed candidate",
      body: "Build the commit from reviewed patch bytes.",
    });

    expect(evidence).toEqual({
      status: "committed",
      commitSha: expect.stringMatching(/^[0-9a-f]{40}$/),
      branch: "main",
      parentCommit: headCommit,
    });
    expect(git(repo.repoRoot, ["show", `${evidence.commitSha}:feature.txt`])).toBe("reviewed");
    expect(readFileSync(indexPath)).toEqual(indexBefore);
  });

  it("sanitizes candidate input proxy traps and throwing getters", async () => {
    const sensitive = "/private/review/SENSITIVE_FILE.txt: SENSITIVE_REVIEWED_CONTENT";
    const trap = () => {
      throw new Error(sensitive);
    };
    const expected = {
      repositoryIdentity: "0".repeat(64),
      worktreeIdentity: "1".repeat(64),
      branchName: "main",
      beforeHeadCommit: "2".repeat(40),
      afterHeadCommit: "3".repeat(40),
      ancestryProofSha256: "4".repeat(64),
      fullPatchSha256: "5".repeat(64),
      fullPatchByteLength: 1,
      fileManifestSha256: "6".repeat(64),
    };
    const expectedWithGetter = { ...expected };
    Object.defineProperty(expectedWithGetter, "repositoryIdentity", { enumerable: true, get: trap });
    const cases: unknown[] = [
      new Proxy({}, { get: trap }),
      { get expected() { return trap(); } },
      {
        projectRoot: "/unused",
        worktreePath: "/unused",
        expected: new Proxy(expected, { getPrototypeOf: trap }),
        subject: "feat(delivery): reject trapped expectation",
      },
      {
        projectRoot: "/unused",
        worktreePath: "/unused",
        expected: expectedWithGetter,
        subject: "feat(delivery): reject trapped expectation field",
      },
      {
        projectRoot: "/unused",
        worktreePath: "/unused",
        expected,
        get subject() { return trap(); },
      },
      {
        projectRoot: "/unused",
        worktreePath: "/unused",
        expected,
        subject: "feat(delivery): reject trapped body",
        get body() { return trap(); },
      },
    ];

    for (const candidateInput of cases) {
      let caught: unknown;
      try {
        await createCandidateDeliveryCommit(
          candidateInput as Parameters<typeof createCandidateDeliveryCommit>[0],
        );
      } catch (error) {
        caught = error;
      }
      expect(caught).toBeInstanceOf(DeliveryCommitError);
      expect((caught as DeliveryCommitError).code).toBe("INVALID_INPUT");
      expect((caught as DeliveryCommitError).message).toBe("Candidate delivery commit input is invalid.");
      expect(String(caught)).toBe("DeliveryCommitError: Candidate delivery commit input is invalid.");
      expect(JSON.stringify(caught)).not.toContain(sensitive);
    }
  });

  it("rejects malformed or oversized raw message fields before normalization or Git side effects", async () => {
    const repo = await createTestRepo("skyturn-candidate-raw-message-limit-");
    tempRoots.push(repo.tempRoot);
    await writeFile(join(repo.repoRoot, "feature.txt"), "reviewed raw limit\n");
    const headCommit = git(repo.repoRoot, ["rev-parse", "HEAD"]);
    const expected = await candidateExpectationFor(repo.repoRoot, headCommit, headCommit);
    const indexBefore = gitBuffer(repo.repoRoot, ["ls-files", "--stage", "-z"]);
    const objectsBefore = git(repo.repoRoot, ["count-objects", "-v"]);
    const statusBefore = git(repo.repoRoot, ["status", "--porcelain=v1", "--untracked-files=all"]);

    const validInput = {
      projectRoot: repo.repoRoot,
      worktreePath: repo.repoRoot,
      expected,
      subject: "feat(delivery): reject oversized raw body",
    };
    const invalidInputs: unknown[] = [
      { ...validInput, subject: 42 },
      { ...validInput, body: null },
      {
        ...validInput,
        subject: `${" ".repeat(candidateMessageMaxBytes)}feat(delivery): reject oversized raw subject`,
      },
      { ...validInput, body: " ".repeat(candidateMessageMaxBytes + 1) },
    ];

    for (const invalidInput of invalidInputs) {
      await expect(createCandidateDeliveryCommit(
        invalidInput as Parameters<typeof createCandidateDeliveryCommit>[0],
      )).rejects.toMatchObject({
        code: "INVALID_INPUT",
        message: "Candidate delivery commit input is invalid.",
      });
    }

    expect(git(repo.repoRoot, ["rev-parse", "refs/heads/main"])).toBe(headCommit);
    expect(gitBuffer(repo.repoRoot, ["ls-files", "--stage", "-z"])).toEqual(indexBefore);
    expect(git(repo.repoRoot, ["count-objects", "-v"])).toBe(objectsBefore);
    expect(git(repo.repoRoot, ["status", "--porcelain=v1", "--untracked-files=all"])).toBe(statusBefore);
  });

  it("enforces the exact final candidate message byte limit before Git side effects", async () => {
    const repo = await createTestRepo("skyturn-candidate-final-message-limit-");
    tempRoots.push(repo.tempRoot);
    await writeFile(join(repo.repoRoot, "feature.txt"), "reviewed exact limit\n");
    const headCommit = git(repo.repoRoot, ["rev-parse", "HEAD"]);
    const expected = await candidateExpectationFor(repo.repoRoot, headCommit, headCommit);
    const subject = "feat(delivery): enforce exact candidate message limit";
    const exactBody = "b".repeat(candidateMessageMaxBytes - Buffer.byteLength(subject, "utf8") - 3);
    const rejectedBodies = [
      "b".repeat(candidateMessageMaxBytes + 1),
      `${exactBody}b`,
    ];
    const indexBefore = gitBuffer(repo.repoRoot, ["ls-files", "--stage", "-z"]);
    const objectsBefore = git(repo.repoRoot, ["count-objects", "-v"]);
    const statusBefore = git(repo.repoRoot, ["status", "--porcelain=v1", "--untracked-files=all"]);

    for (const body of rejectedBodies) {
      await expect(createCandidateDeliveryCommit({
        projectRoot: repo.repoRoot,
        worktreePath: repo.repoRoot,
        expected,
        subject,
        body,
      })).rejects.toMatchObject({
        code: "INVALID_INPUT",
        message: "Candidate delivery commit input is invalid.",
      });
      expect(git(repo.repoRoot, ["rev-parse", "refs/heads/main"])).toBe(headCommit);
      expect(gitBuffer(repo.repoRoot, ["ls-files", "--stage", "-z"])).toEqual(indexBefore);
      expect(git(repo.repoRoot, ["count-objects", "-v"])).toBe(objectsBefore);
      expect(git(repo.repoRoot, ["status", "--porcelain=v1", "--untracked-files=all"])).toBe(statusBefore);
    }

    const evidence = await createCandidateDeliveryCommit({
      projectRoot: repo.repoRoot,
      worktreePath: repo.repoRoot,
      expected,
      subject,
      body: exactBody,
    });
    const commitBytes = gitBuffer(repo.repoRoot, ["cat-file", "commit", evidence.commitSha]);
    const messageOffset = commitBytes.indexOf("\n\n") + 2;
    expect(messageOffset).toBeGreaterThan(1);
    expect(commitBytes.subarray(messageOffset)).toHaveLength(candidateMessageMaxBytes);
  });

  it.skipIf(process.platform === "win32")("rejects a delivery branch converted to symbolic when prepared publication begins", async () => {
    const repo = await createTestRepo("skyturn-candidate-symbolic-branch-");
    tempRoots.push(repo.tempRoot);
    await writeFile(join(repo.repoRoot, "feature.txt"), "reviewed symbolic candidate\n");
    const headCommit = git(repo.repoRoot, ["rev-parse", "HEAD"]);
    git(repo.repoRoot, ["branch", "victim", headCommit]);
    const expected = await candidateExpectationFor(repo.repoRoot, headCommit, headCommit);
    const wrapper = await installCandidateSymbolicBranchWrapper(repo.repoRoot, "refs/heads/main", "refs/heads/victim");

    await expect(withFakeGit(wrapper.binDir, () => createCandidateDeliveryCommit({
      projectRoot: repo.repoRoot,
      worktreePath: repo.repoRoot,
      expected,
      subject: "feat(delivery): reject symbolic delivery branch",
    }))).rejects.toThrow("Candidate delivery commit was rejected.");

    expect(git(repo.repoRoot, ["symbolic-ref", "refs/heads/main"])).toBe("refs/heads/victim");
    expect(git(repo.repoRoot, ["rev-parse", "refs/heads/victim"])).toBe(headCommit);
    expect(readFileSync(wrapper.protocolPath, "utf8").trim().split("\n")).toEqual([
      "start",
      "option no-deref",
      expect.stringMatching(new RegExp(`^update refs/heads/main [0-9a-f]{40} ${headCommit}$`)),
      "prepare",
      "abort",
    ]);
    const unreachableCommits = git(repo.repoRoot, [
      "fsck",
      "--unreachable",
      "--no-reflogs",
      "--no-progress",
    ]).split("\n").flatMap((line) => {
      const match = /^unreachable commit ([0-9a-f]{40})$/.exec(line);
      return match ? [match[1]] : [];
    });
    expect(unreachableCommits).toHaveLength(1);
    const candidateCommit = unreachableCommits[0];
    expect(git(repo.repoRoot, ["show", `${candidateCommit}:feature.txt`])).toBe("reviewed symbolic candidate");
    const branchCommits = git(repo.repoRoot, [
      "for-each-ref",
      "--format=%(objectname)",
      "refs/heads",
    ]).split("\n");
    expect(branchCommits).not.toContain(candidateCommit);
  });

  it.skipIf(process.platform === "win32")("aborts a malformed prepared-transaction protocol without changing the branch", async () => {
    const repo = await createTestRepo("skyturn-candidate-protocol-failure-");
    tempRoots.push(repo.tempRoot);
    await writeFile(join(repo.repoRoot, "feature.txt"), "reviewed protocol failure\n");
    const headCommit = git(repo.repoRoot, ["rev-parse", "HEAD"]);
    const expected = await candidateExpectationFor(repo.repoRoot, headCommit, headCommit);
    const wrapper = await installCandidateProtocolFailureWrapper(repo.repoRoot);

    let exposed = "";
    try {
      await withFakeGit(wrapper.binDir, () => createCandidateDeliveryCommit({
        projectRoot: repo.repoRoot,
        worktreePath: repo.repoRoot,
        expected,
        subject: "feat(delivery): reject malformed publication protocol",
      }));
    } catch (error) {
      exposed = String(error);
    }

    expect(exposed).toBe("DeliveryCommitError: Candidate delivery commit was rejected.");
    expect(exposed.length).toBeLessThan(128);
    expect(git(repo.repoRoot, ["rev-parse", "refs/heads/main"])).toBe(headCommit);
    expect(readFileSync(wrapper.protocolPath, "utf8").trim().split("\n")).toEqual([
      "start",
      "abort",
    ]);
  });

  it.skipIf(process.platform === "win32")("terminates a silent prepared transaction and releases its lock", async () => {
    const repo = await createTestRepo("skyturn-candidate-silent-prepare-");
    tempRoots.push(repo.tempRoot);
    await writeFile(join(repo.repoRoot, "feature.txt"), "reviewed silent candidate\n");
    const headCommit = git(repo.repoRoot, ["rev-parse", "HEAD"]);
    const expected = await candidateExpectationFor(repo.repoRoot, headCommit, headCommit);
    const wrapper = await installCandidateSilentPrepareWrapper(repo.repoRoot);

    const startedAt = Date.now();
    let exposed = "";
    try {
      await withFakeGit(wrapper.binDir, () => createCandidateDeliveryCommit({
        projectRoot: repo.repoRoot,
        worktreePath: repo.repoRoot,
        expected,
        subject: "feat(delivery): reject silent prepared publication",
      }));
    } catch (error) {
      exposed = String(error);
    }
    const elapsedMs = Date.now() - startedAt;

    expect(exposed).toBe("DeliveryCommitError: Candidate delivery commit was rejected.");
    expect(elapsedMs).toBeLessThan(12_000);
    expect(readFileSync(wrapper.protocolPath, "utf8").trim().split("\n")).toEqual([
      "start",
      "option no-deref",
      expect.stringMatching(new RegExp(`^update refs/heads/main [0-9a-f]{40} ${headCommit}$`)),
      "prepare",
    ]);
    expect(existsSync(wrapper.terminationPath)).toBe(true);
    expect(existsSync(wrapper.lockMarkerPath)).toBe(false);
    expect(git(repo.repoRoot, ["rev-parse", "refs/heads/main"])).toBe(headCommit);
    const unreachableCommits = git(repo.repoRoot, [
      "fsck",
      "--unreachable",
      "--no-reflogs",
      "--no-progress",
    ]).split("\n").flatMap((line) => {
      const match = /^unreachable commit ([0-9a-f]{40})$/.exec(line);
      return match ? [match[1]] : [];
    });
    expect(unreachableCommits).toHaveLength(1);
    const branchCommits = git(repo.repoRoot, [
      "for-each-ref",
      "--format=%(objectname)",
      "refs/heads",
    ]).split("\n");
    expect(branchCommits).not.toContain(unreachableCommits[0]);
  }, 25_000);

  it.skipIf(process.platform === "win32")("terminates and reaps silent prepared-ref validation before aborting publication", async () => {
    const repo = await createTestRepo("skyturn-candidate-silent-validation-");
    tempRoots.push(repo.tempRoot);
    await writeFile(join(repo.repoRoot, "feature.txt"), "reviewed silent validation\n");
    const headCommit = git(repo.repoRoot, ["rev-parse", "HEAD"]);
    const expected = await candidateExpectationFor(repo.repoRoot, headCommit, headCommit);
    const wrapper = await installCandidateSilentValidationWrapper(repo.repoRoot);

    const startedAt = Date.now();
    await expect(withFakeGit(wrapper.binDir, () => createCandidateDeliveryCommit({
      projectRoot: repo.repoRoot,
      worktreePath: repo.repoRoot,
      expected,
      subject: "feat(delivery): reject silent prepared-ref validation",
    }))).rejects.toThrow("Candidate delivery commit was rejected.");
    const elapsedMs = Date.now() - startedAt;

    expect(elapsedMs).toBeLessThan(10_000);
    expect(readFileSync(wrapper.protocolPath, "utf8").trim().split("\n")).toEqual([
      "start",
      "option no-deref",
      expect.stringMatching(new RegExp(`^update refs/heads/main [0-9a-f]{40} ${headCommit}$`)),
      "prepare",
      "abort",
    ]);
    expect(existsSync(wrapper.validationTerminationPath)).toBe(true);
    expect(existsSync(wrapper.validationLivePath)).toBe(false);
    expect(existsSync(wrapper.validationClosedPath)).toBe(true);
    expect(existsSync(wrapper.abortAfterValidationClosePath)).toBe(true);
    expect(existsSync(wrapper.updateRefClosedPath)).toBe(true);
    expect(existsSync(wrapper.lockMarkerPath)).toBe(false);
    expect(git(repo.repoRoot, ["rev-parse", "refs/heads/main"])).toBe(headCommit);
    const unreachableCommits = git(repo.repoRoot, [
      "fsck",
      "--unreachable",
      "--no-reflogs",
      "--no-progress",
    ]).split("\n").flatMap((line) => {
      const match = /^unreachable commit ([0-9a-f]{40})$/.exec(line);
      return match ? [match[1]] : [];
    });
    expect(unreachableCommits).toHaveLength(1);
    const branchCommits = git(repo.repoRoot, [
      "for-each-ref",
      "--format=%(objectname)",
      "refs/heads",
    ]).split("\n");
    expect(branchCommits).not.toContain(unreachableCommits[0]);
  }, 20_000);

  it.skipIf(process.platform === "win32")("bounds prepared-transaction output and leaves the branch unchanged", async () => {
    const repo = await createTestRepo("skyturn-candidate-protocol-overflow-");
    tempRoots.push(repo.tempRoot);
    await writeFile(join(repo.repoRoot, "feature.txt"), "reviewed protocol overflow\n");
    const headCommit = git(repo.repoRoot, ["rev-parse", "HEAD"]);
    const expected = await candidateExpectationFor(repo.repoRoot, headCommit, headCommit);
    const wrapper = await installCandidateProtocolOverflowWrapper(repo.repoRoot);

    let exposed = "";
    try {
      await withFakeGit(wrapper.binDir, () => createCandidateDeliveryCommit({
        projectRoot: repo.repoRoot,
        worktreePath: repo.repoRoot,
        expected,
        subject: "feat(delivery): reject oversized publication output",
      }));
    } catch (error) {
      exposed = String(error);
    }

    expect(exposed).toBe("DeliveryCommitError: Candidate delivery commit was rejected.");
    expect(exposed.length).toBeLessThan(128);
    expect(exposed).not.toContain("SENSITIVE_PROTOCOL_OUTPUT");
    expect(git(repo.repoRoot, ["rev-parse", "refs/heads/main"])).toBe(headCommit);
  });

  it.skipIf(process.platform === "win32")("rebuilds a mixed B-to-H candidate tree and inherits volatile paths from H", async () => {
    const repo = await createTestRepo("skyturn-candidate-mixed-");
    tempRoots.push(repo.tempRoot);
    await writeFile(join(repo.repoRoot, "text.txt"), "base text\n");
    await writeFile(join(repo.repoRoot, "binary.bin"), Buffer.from([0, 1, 2, 0, 3]));
    await writeFile(join(repo.repoRoot, "delete.txt"), "delete me\n");
    await writeFile(join(repo.repoRoot, "mode.sh"), "#!/bin/sh\nexit 0\n");
    await fsSymlink("old-target", join(repo.repoRoot, "link"));
    const volatileBaseFiles = new Map([
      [".devflow/skyturn-workflow.sqlite", "base sqlite\n"],
      [".devflow/skyturn-workflow.sqlite-wal", "base wal\n"],
      [".devflow/skyturn-workflow.sqlite-shm", "base shm\n"],
      [".devflow/tasks/task-1/output.md", "base output\n"],
    ]);
    for (const [file, contents] of volatileBaseFiles) {
      await mkdir(dirname(join(repo.repoRoot, file)), { recursive: true });
      await writeFile(join(repo.repoRoot, file), contents);
    }
    git(repo.repoRoot, ["add", "-A"]);
    git(repo.repoRoot, ["commit", "-m", "candidate base"]);
    const beforeHeadCommit = git(repo.repoRoot, ["rev-parse", "HEAD"]);

    await writeFile(join(repo.repoRoot, "head-only.txt"), "from H\n");
    const volatileHeadFiles = new Map([
      [".devflow/skyturn-workflow.sqlite", "from H: sqlite\n"],
      [".devflow/skyturn-workflow.sqlite-wal", "from H: wal\n"],
      [".devflow/runs/run-1/events.ndjson", "from H: events\n"],
      [".devflow/tasks/task-1/output.md", "from H: output\n"],
    ]);
    await rm(join(repo.repoRoot, ".devflow/skyturn-workflow.sqlite-shm"));
    for (const [file, contents] of volatileHeadFiles) {
      await mkdir(dirname(join(repo.repoRoot, file)), { recursive: true });
      await writeFile(join(repo.repoRoot, file), contents);
    }
    git(repo.repoRoot, ["add", "-A"]);
    git(repo.repoRoot, ["commit", "-m", "advance parent"]);
    const afterHeadCommit = git(repo.repoRoot, ["rev-parse", "HEAD"]);

    await writeFile(join(repo.repoRoot, "text.txt"), "reviewed text\n");
    await writeFile(join(repo.repoRoot, "binary.bin"), Buffer.from([255, 0, 9, 8, 0, 7]));
    await rm(join(repo.repoRoot, "delete.txt"));
    await writeFile(join(repo.repoRoot, "untracked.txt"), "reviewed untracked\n");
    await chmod(join(repo.repoRoot, "mode.sh"), 0o755);
    await rm(join(repo.repoRoot, "link"));
    await fsSymlink("reviewed-target", join(repo.repoRoot, "link"));

    const expected = await candidateExpectationFor(repo.repoRoot, beforeHeadCommit, afterHeadCommit);
    const indexPath = git(repo.repoRoot, ["rev-parse", "--path-format=absolute", "--git-path", "index"]);
    const indexBefore = readFileSync(indexPath);
    const evidence = await createCandidateDeliveryCommit({
      projectRoot: repo.repoRoot,
      worktreePath: repo.repoRoot,
      expected,
      subject: "feat(delivery): publish mixed reviewed candidate",
    });

    expect(evidence.parentCommit).toBe(afterHeadCommit);
    expect(git(repo.repoRoot, ["show", `${evidence.commitSha}:text.txt`])).toBe("reviewed text");
    expect(gitBuffer(repo.repoRoot, ["show", `${evidence.commitSha}:binary.bin`])).toEqual(
      Buffer.from([255, 0, 9, 8, 0, 7]),
    );
    expect(() => git(repo.repoRoot, ["cat-file", "-e", `${evidence.commitSha}:delete.txt`])).toThrow();
    expect(git(repo.repoRoot, ["show", `${evidence.commitSha}:untracked.txt`])).toBe("reviewed untracked");
    expect(git(repo.repoRoot, ["ls-tree", evidence.commitSha, "mode.sh"]).split(" ")[0]).toBe("100755");
    expect(git(repo.repoRoot, ["ls-tree", evidence.commitSha, "link"]).split(" ")[0]).toBe("120000");
    expect(git(repo.repoRoot, ["show", `${evidence.commitSha}:link`])).toBe("reviewed-target");
    expect(git(repo.repoRoot, ["show", `${evidence.commitSha}:head-only.txt`])).toBe("from H");
    for (const [file, contents] of volatileHeadFiles) {
      expect(git(repo.repoRoot, ["show", `${evidence.commitSha}:${file}`])).toBe(contents.trim());
    }
    expect(() => git(repo.repoRoot, [
      "cat-file",
      "-e",
      `${evidence.commitSha}:.devflow/skyturn-workflow.sqlite-shm`,
    ])).toThrow();
    expect(readFileSync(indexPath)).toEqual(indexBefore);
  });

  it.skipIf(process.platform === "win32")("ignores live file and real-index mutations after capture", async () => {
    const repo = await createTestRepo("skyturn-candidate-post-capture-");
    tempRoots.push(repo.tempRoot);
    const reviewedBytes = "reviewed bytes\n";
    const externalBytes = "EXTERNAL MUTATION AFTER CAPTURE\n";
    await writeFile(join(repo.repoRoot, "feature.txt"), reviewedBytes);
    const headCommit = git(repo.repoRoot, ["rev-parse", "HEAD"]);
    const expected = await candidateExpectationFor(repo.repoRoot, headCommit, headCommit);
    const wrapper = await installCandidatePostCaptureMutationWrapper(repo.repoRoot, externalBytes);

    const evidence = await withFakeGit(wrapper.binDir, () => createCandidateDeliveryCommit({
      projectRoot: repo.repoRoot,
      worktreePath: repo.repoRoot,
      expected,
      subject: "feat(delivery): isolate reviewed bytes",
    }));

    expect(git(repo.repoRoot, ["show", `${evidence.commitSha}:feature.txt`])).toBe(reviewedBytes.trim());
    expect(readFileSync(join(repo.repoRoot, "feature.txt"), "utf8")).toBe(externalBytes);
    expect(git(repo.repoRoot, ["show", ":feature.txt"])).toBe(externalBytes.trim());
  });

  it.skipIf(process.platform === "win32")("rejects a stale CAS and leaves the competing branch update authoritative", async () => {
    const repo = await createTestRepo("skyturn-candidate-cas-");
    tempRoots.push(repo.tempRoot);
    await writeFile(join(repo.repoRoot, "feature.txt"), "reviewed candidate\n");
    const headCommit = git(repo.repoRoot, ["rev-parse", "HEAD"]);
    const expected = await candidateExpectationFor(repo.repoRoot, headCommit, headCommit);
    const parentTree = git(repo.repoRoot, ["rev-parse", `${headCommit}^{tree}`]);
    const competingCommit = git(repo.repoRoot, ["commit-tree", parentTree, "-p", headCommit, "-m", "competing update"]);
    const wrapper = await installCandidateCasWrapper(repo.repoRoot, "refs/heads/main", headCommit, competingCommit);

    await expect(withFakeGit(wrapper.binDir, () => createCandidateDeliveryCommit({
      projectRoot: repo.repoRoot,
      worktreePath: repo.repoRoot,
      expected,
      subject: "feat(delivery): lose stale candidate race",
    }))).rejects.toThrow("Candidate delivery commit was rejected.");

    const candidateCommit = git(repo.repoRoot, [
      "fsck",
      "--unreachable",
      "--no-reflogs",
      "--no-progress",
    ]).split("\n").flatMap((line) => {
      const match = /^unreachable commit ([0-9a-f]{40})$/.exec(line);
      return match ? [match[1]] : [];
    })[0];
    expect(candidateCommit).toMatch(/^[0-9a-f]{40}$/);
    expect(git(repo.repoRoot, ["rev-parse", "refs/heads/main"])).toBe(competingCommit);
    expect(git(repo.repoRoot, ["rev-parse", "refs/heads/main"])).not.toBe(candidateCommit);
    expect(git(repo.repoRoot, ["cat-file", "-t", candidateCommit])).toBe("commit");
  });

  it.skipIf(process.platform === "win32")("allows at most one concurrent secure publication", async () => {
    const repo = await createTestRepo("skyturn-candidate-concurrent-");
    tempRoots.push(repo.tempRoot);
    await writeFile(join(repo.repoRoot, "feature.txt"), "concurrent reviewed bytes\n");
    const headCommit = git(repo.repoRoot, ["rev-parse", "HEAD"]);
    const expected = await candidateExpectationFor(repo.repoRoot, headCommit, headCommit);
    const wrapper = await installCandidateConcurrentCasWrapper(repo.repoRoot);
    const publish = () => createCandidateDeliveryCommit({
      projectRoot: repo.repoRoot,
      worktreePath: repo.repoRoot,
      expected,
      subject: "feat(delivery): publish one concurrent candidate",
    });

    const results = await withFakeGit(wrapper.binDir, () => Promise.allSettled([publish(), publish()]));

    expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(1);
    expect(results.filter((result) => result.status === "rejected")).toHaveLength(1);
    const winner = results.find((result): result is PromiseFulfilledResult<Awaited<ReturnType<typeof publish>>> => (
      result.status === "fulfilled"
    ));
    expect(winner?.value.commitSha).toBe(git(repo.repoRoot, ["rev-parse", "refs/heads/main"]));
  });

  it.skipIf(process.platform === "win32")("publishes only to R when HEAD switches to another branch at H before CAS", async () => {
    const repo = await createTestRepo("skyturn-candidate-head-switch-");
    tempRoots.push(repo.tempRoot);
    await writeFile(join(repo.repoRoot, "feature.txt"), "reviewed for named branch\n");
    const headCommit = git(repo.repoRoot, ["rev-parse", "HEAD"]);
    git(repo.repoRoot, ["branch", "other", headCommit]);
    const expected = await candidateExpectationFor(repo.repoRoot, headCommit, headCommit);
    const wrapper = await installCandidateHeadSwitchWrapper(repo.repoRoot, "other");

    const evidence = await withFakeGit(wrapper.binDir, () => createCandidateDeliveryCommit({
      projectRoot: repo.repoRoot,
      worktreePath: repo.repoRoot,
      expected,
      subject: "feat(delivery): target manifest branch",
    }));

    expect(evidence.branch).toBe("main");
    expect(git(repo.repoRoot, ["branch", "--show-current"])).toBe("other");
    expect(git(repo.repoRoot, ["rev-parse", "refs/heads/main"])).toBe(evidence.commitSha);
    expect(git(repo.repoRoot, ["rev-parse", "refs/heads/other"])).toBe(headCommit);
  });

  it("rejects malformed expectations and all bound fact mismatches without mutating refs, index, or worktree", async () => {
    const repo = await createTestRepo("skyturn-candidate-rejections-");
    tempRoots.push(repo.tempRoot);
    await writeFile(join(repo.repoRoot, "anchor.txt"), "second commit\n");
    git(repo.repoRoot, ["add", "anchor.txt"]);
    git(repo.repoRoot, ["commit", "-m", "add rejection anchor"]);
    await writeFile(join(repo.repoRoot, "feature.txt"), "reviewed rejection fixture\n");
    const headCommit = git(repo.repoRoot, ["rev-parse", "HEAD"]);
    const ancestorCommit = git(repo.repoRoot, ["rev-parse", "HEAD^"]);
    git(repo.repoRoot, ["branch", "alternate", headCommit]);
    const expected = await candidateExpectationFor(repo.repoRoot, headCommit, headCommit);
    const { fullPatchSha256: _removedDigest, ...missingDigest } = expected;
    const variants: unknown[] = [
      missingDigest,
      { ...expected, unexpected: true },
      { ...expected, beforeHeadCommit: "A".repeat(40) },
      { ...expected, fullPatchSha256: "A".repeat(64) },
      { ...expected, fullPatchByteLength: 0 },
      { ...expected, fullPatchByteLength: Number.MAX_SAFE_INTEGER },
      { ...expected, branchName: "-unsafe" },
      { ...expected, branchName: "x".repeat(1_025) },
      { ...expected, repositoryIdentity: "0".repeat(64) },
      { ...expected, worktreeIdentity: "1".repeat(64) },
      { ...expected, ancestryProofSha256: "2".repeat(64) },
      { ...expected, fullPatchSha256: "3".repeat(64) },
      { ...expected, fullPatchByteLength: expected.fullPatchByteLength + 1 },
      { ...expected, fileManifestSha256: "4".repeat(64) },
      { ...expected, beforeHeadCommit: ancestorCommit },
      { ...expected, afterHeadCommit: ancestorCommit },
      { ...expected, branchName: "alternate" },
    ];
    const indexPath = git(repo.repoRoot, ["rev-parse", "--path-format=absolute", "--git-path", "index"]);
    const indexBefore = readFileSync(indexPath);
    const statusBefore = git(repo.repoRoot, ["status", "--porcelain=v1", "--untracked-files=all"]);

    for (const variant of variants) {
      await expect(createCandidateDeliveryCommit({
        projectRoot: repo.repoRoot,
        worktreePath: repo.repoRoot,
        expected: variant as CandidateCommitExpectation,
        subject: "feat(delivery): reject mismatched candidate",
      })).rejects.toThrow(/Candidate delivery commit (?:input is invalid|was rejected)\./);
      expect(git(repo.repoRoot, ["rev-parse", "refs/heads/main"])).toBe(headCommit);
      expect(git(repo.repoRoot, ["rev-parse", "refs/heads/alternate"])).toBe(headCommit);
      expect(readFileSync(indexPath)).toEqual(indexBefore);
      expect(git(repo.repoRoot, ["status", "--porcelain=v1", "--untracked-files=all"])).toBe(statusBefore);
    }
  });

  it("returns bounded evidence and errors without paths, filenames, or reviewed bytes", async () => {
    const repo = await createTestRepo("skyturn-candidate-sensitive-path-");
    tempRoots.push(repo.tempRoot);
    const sensitiveFile = "SENSITIVE_FILE_SENTINEL.txt";
    const sensitiveBytes = "SENSITIVE_REVIEWED_BYTES_SENTINEL\n";
    await writeFile(join(repo.repoRoot, sensitiveFile), sensitiveBytes);
    const headCommit = git(repo.repoRoot, ["rev-parse", "HEAD"]);
    const expected = await candidateExpectationFor(repo.repoRoot, headCommit, headCommit);

    let exposed = "";
    try {
      await createCandidateDeliveryCommit({
        projectRoot: repo.repoRoot,
        worktreePath: repo.repoRoot,
        expected: { ...expected, fullPatchSha256: "0".repeat(64) },
        subject: "feat(delivery): reject sensitive candidate",
      });
    } catch (error) {
      exposed = String(error);
    }

    expect(exposed).toBe("DeliveryCommitError: Candidate delivery commit was rejected.");
    expect(exposed.length).toBeLessThan(128);
    expect(exposed).not.toContain(repo.repoRoot);
    expect(exposed).not.toContain(sensitiveFile);
    expect(exposed).not.toContain(sensitiveBytes.trim());
  });

  it("rejects an empty live snapshot before creating candidate objects", async () => {
    const repo = await createTestRepo("skyturn-candidate-empty-");
    tempRoots.push(repo.tempRoot);
    await writeFile(join(repo.repoRoot, "feature.txt"), "temporarily reviewed\n");
    const headCommit = git(repo.repoRoot, ["rev-parse", "HEAD"]);
    const expected = await candidateExpectationFor(repo.repoRoot, headCommit, headCommit);
    await writeFile(join(repo.repoRoot, "feature.txt"), "base\n");
    const indexBefore = gitBuffer(repo.repoRoot, ["ls-files", "--stage", "-z"]);
    const objectsBefore = git(repo.repoRoot, ["count-objects", "-v"]);

    await expect(createCandidateDeliveryCommit({
      projectRoot: repo.repoRoot,
      worktreePath: repo.repoRoot,
      expected,
      subject: "feat(delivery): reject empty candidate",
    })).rejects.toThrow("Candidate delivery commit was rejected.");

    expect(git(repo.repoRoot, ["rev-parse", "refs/heads/main"])).toBe(headCommit);
    expect(gitBuffer(repo.repoRoot, ["ls-files", "--stage", "-z"])).toEqual(indexBefore);
    expect(git(repo.repoRoot, ["count-objects", "-v"])).toBe(objectsBefore);
    expect(git(repo.repoRoot, ["status", "--porcelain=v1", "--untracked-files=all"])).toBe("");
  });
});

describe("delivery remote actions", () => {
  const tempRoots: string[] = [];

  afterEach(() => {
    for (const root of tempRoots.splice(0)) {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("pushes the current delivery HEAD to the configured remote branch", async () => {
    const repo = await createTestRepo("skyturn-delivery-push-");
    tempRoots.push(repo.tempRoot);
    const remotePath = join(repo.tempRoot, "remote.git");
    git(repo.tempRoot, ["init", "--bare", "remote.git"]);
    git(repo.repoRoot, ["remote", "add", "origin", remotePath]);
    await writeFile(join(repo.repoRoot, "feature.txt"), "changed\n");
    const commit = await createDeliveryCommit({
      projectRoot: repo.repoRoot,
      worktreePath: repo.repoRoot,
      files: ["feature.txt"],
      subject: "feat(delivery): add remote push",
    });

    const pushed = await pushDeliveryBranch({
      projectRoot: repo.repoRoot,
      worktreePath: repo.repoRoot,
      commitSha: commit.commitSha,
    });

    expect(pushed).toMatchObject({
      status: "pushed",
      remote: "origin",
      branch: "main",
      commitSha: commit.commitSha,
      command: {
        command: "git",
        ok: true,
        exitCode: 0,
      },
    });
    expect(git(remotePath, ["rev-parse", "refs/heads/main"])).toBe(commit.commitSha);
  });

  it("rejects push requests when the requested commit is not the delivery HEAD", async () => {
    const repo = await createTestRepo("skyturn-delivery-push-head-");
    tempRoots.push(repo.tempRoot);
    const remotePath = join(repo.tempRoot, "remote.git");
    git(repo.tempRoot, ["init", "--bare", "remote.git"]);
    git(repo.repoRoot, ["remote", "add", "origin", remotePath]);
    await writeFile(join(repo.repoRoot, "feature.txt"), "changed\n");
    await createDeliveryCommit({
      projectRoot: repo.repoRoot,
      worktreePath: repo.repoRoot,
      files: ["feature.txt"],
      subject: "feat(delivery): add remote push",
    });

    await expect(pushDeliveryBranch({
      projectRoot: repo.repoRoot,
      worktreePath: repo.repoRoot,
      commitSha: repo.baseCommit,
    })).rejects.toThrow(/HEAD/i);
  });

  it("creates a pull request through authenticated GitHub CLI and returns the real PR URL", async () => {
    const repo = await createTestRepo("skyturn-delivery-pr-");
    tempRoots.push(repo.tempRoot);
    const remotePath = join(repo.tempRoot, "remote.git");
    git(repo.tempRoot, ["init", "--bare", "remote.git"]);
    git(repo.repoRoot, ["remote", "add", "origin", remotePath]);
    git(repo.repoRoot, ["checkout", "-b", "feature/delivery"]);
    await writeFile(join(repo.repoRoot, "feature.txt"), "changed\n");
    const commit = await createDeliveryCommit({
      projectRoot: repo.repoRoot,
      worktreePath: repo.repoRoot,
      files: ["feature.txt"],
      subject: "feat(delivery): add remote pr",
    });
    await pushDeliveryBranch({
      projectRoot: repo.repoRoot,
      worktreePath: repo.repoRoot,
      commitSha: commit.commitSha,
      branch: "feature/delivery",
    });
    const fakeGh = await installFakeGh(repo.tempRoot, {
      prUrl: "https://github.com/acme/skyturn/pull/42",
    });

    await withFakeGh(fakeGh.binDir, fakeGh.argsPath, async () => {
      const pr = await createDeliveryPullRequest({
        projectRoot: repo.repoRoot,
        worktreePath: repo.repoRoot,
        commitSha: commit.commitSha,
        baseBranch: "main",
        headBranch: "feature/delivery",
        title: "feat(delivery): add remote pr",
      });

      expect(pr).toMatchObject({
        status: "created",
        url: "https://github.com/acme/skyturn/pull/42",
        number: 42,
        head: "feature/delivery",
        base: "main",
        commitSha: commit.commitSha,
      });
      const ghArgs = readFileSync(fakeGh.argsPath, "utf8");
      expect(ghArgs).toContain("--base\nmain");
      expect(ghArgs).toContain("--head\nfeature/delivery");
      expect(ghArgs).toContain("--title\nfeat(delivery): add remote pr");
      expect(ghArgs).toContain("**What changed?**");
      expect(ghArgs).toContain("**Why?**");
      expect(ghArgs).toContain("**Breaking changes?**");
      expect(ghArgs).toContain("**Server PR**");
    });
  });

  it("rejects pull request creation when the remote head does not match the delivery commit", async () => {
    const repo = await createTestRepo("skyturn-delivery-pr-stale-head-");
    tempRoots.push(repo.tempRoot);
    const remotePath = join(repo.tempRoot, "remote.git");
    git(repo.tempRoot, ["init", "--bare", "remote.git"]);
    git(repo.repoRoot, ["remote", "add", "origin", remotePath]);
    git(repo.repoRoot, ["checkout", "-b", "feature/delivery"]);
    await writeFile(join(repo.repoRoot, "feature.txt"), "changed\n");
    const commit = await createDeliveryCommit({
      projectRoot: repo.repoRoot,
      worktreePath: repo.repoRoot,
      files: ["feature.txt"],
      subject: "feat(delivery): add remote pr",
    });
    git(repo.repoRoot, ["push", "origin", `${repo.baseCommit}:refs/heads/feature/delivery`]);
    const fakeGh = await installFakeGh(repo.tempRoot, {
      prUrl: "https://github.com/acme/skyturn/pull/42",
    });

    await withFakeGh(fakeGh.binDir, fakeGh.argsPath, async () => {
      await expect(createDeliveryPullRequest({
        projectRoot: repo.repoRoot,
        worktreePath: repo.repoRoot,
        commitSha: commit.commitSha,
        baseBranch: "main",
        headBranch: "feature/delivery",
        title: "feat(delivery): add remote pr",
      })).rejects.toMatchObject({
        code: "REMOTE_HEAD_MISMATCH",
        message: expect.stringContaining("Remote branch head does not match delivery commit"),
      });
      expect(existsSync(fakeGh.argsPath)).toBe(false);
    });
  });

  it("returns AUTH_REQUIRED when GitHub CLI is installed but not authenticated", async () => {
    const repo = await createTestRepo("skyturn-delivery-pr-auth-");
    tempRoots.push(repo.tempRoot);
    const remotePath = join(repo.tempRoot, "remote.git");
    git(repo.tempRoot, ["init", "--bare", "remote.git"]);
    git(repo.repoRoot, ["remote", "add", "origin", remotePath]);
    git(repo.repoRoot, ["checkout", "-b", "feature/delivery"]);
    await writeFile(join(repo.repoRoot, "feature.txt"), "changed\n");
    const commit = await createDeliveryCommit({
      projectRoot: repo.repoRoot,
      worktreePath: repo.repoRoot,
      files: ["feature.txt"],
      subject: "feat(delivery): add remote pr",
    });
    await pushDeliveryBranch({
      projectRoot: repo.repoRoot,
      worktreePath: repo.repoRoot,
      commitSha: commit.commitSha,
      branch: "feature/delivery",
    });
    const fakeGh = await installFakeGh(repo.tempRoot, {
      authStatus: 1,
      authStderr: "not logged in; token=secret-value",
    });

    await withFakeGh(fakeGh.binDir, fakeGh.argsPath, async () => {
      await expect(createDeliveryPullRequest({
        projectRoot: repo.repoRoot,
        worktreePath: repo.repoRoot,
        commitSha: commit.commitSha,
        baseBranch: "main",
        headBranch: "feature/delivery",
        title: "feat(delivery): add remote pr",
      })).rejects.toMatchObject({
        code: "AUTH_REQUIRED",
      });
    });
  });

  it("records passed pull request checks only for the exact expected head sha", async () => {
    const repo = await createTestRepo("skyturn-delivery-pr-checks-pass-");
    tempRoots.push(repo.tempRoot);
    const fakeGh = await installFakeGh(repo.tempRoot, {
      prUrl: "https://github.com/acme/skyturn/pull/42",
      prHeadSha: repo.baseCommit,
      reviewDecision: "APPROVED",
      checksJson: [
        { name: "unit", state: "SUCCESS", workflow: "ci", link: "https://github.com/acme/skyturn/actions/runs/1" },
        { name: "typecheck", bucket: "pass", workflow: "ci" },
      ],
    });

    await withFakeGh(fakeGh.binDir, fakeGh.argsPath, async () => {
      const evidence = await checkDeliveryPullRequest({
        projectRoot: repo.repoRoot,
        prNumber: 42,
        expectedHeadSha: repo.baseCommit,
      });

      expect(evidence).toMatchObject({
        status: "passed",
        number: 42,
        headSha: repo.baseCommit,
        checks: [
          { name: "unit", status: "passed" },
          { name: "typecheck", status: "passed" },
        ],
        review: { status: "approved" },
        command: { command: "gh", ok: true, exitCode: 0 },
      });
      expect(evidence.summary).toContain("2 passed");
      expect(evidence.summary).toContain("review approved");
    });
  });

  it("distinguishes approved, changes requested, pending, and unknown pull request review gates", async () => {
    const repo = await createTestRepo("skyturn-delivery-pr-review-gates-");
    tempRoots.push(repo.tempRoot);
    const cases = [
      { label: "approved", reviewDecision: "APPROVED", expected: "approved" },
      { label: "changes", reviewDecision: "CHANGES_REQUESTED", expected: "changes_requested" },
      { label: "pending", reviewDecision: "REVIEW_REQUIRED", expected: "pending" },
      { label: "unknown", reviewDecision: undefined, expected: "unknown" },
    ] as const;

    for (const item of cases) {
      const fakeGh = await installFakeGh(join(repo.tempRoot, item.label), {
        prHeadSha: repo.baseCommit,
        ...(item.reviewDecision ? { reviewDecision: item.reviewDecision } : {}),
        checksJson: [{ name: "unit", state: "SUCCESS", workflow: "ci" }],
      });

      await withFakeGh(fakeGh.binDir, fakeGh.argsPath, async () => {
        await expect(checkDeliveryPullRequest({
          projectRoot: repo.repoRoot,
          prNumber: 1,
          expectedHeadSha: repo.baseCommit,
        })).resolves.toMatchObject({
          status: "passed",
          review: { status: item.expected },
          gate: {
            checksStatus: "passed",
            reviewStatus: item.expected,
            headSha: repo.baseCommit,
          },
        });
      });
    }
  });

  it("reports failed and pending pull request checks without merging", async () => {
    const repo = await createTestRepo("skyturn-delivery-pr-checks-status-");
    tempRoots.push(repo.tempRoot);
    const failedGh = await installFakeGh(join(repo.tempRoot, "failed"), {
      prHeadSha: repo.baseCommit,
      checksJson: [
        { name: "unit", state: "FAILURE", workflow: "ci" },
        { name: "typecheck", state: "SUCCESS", workflow: "ci" },
      ],
      checksExitCode: 1,
    });
    const pendingGh = await installFakeGh(join(repo.tempRoot, "pending"), {
      prHeadSha: repo.baseCommit,
      checksJson: [
        { name: "unit", state: "PENDING", workflow: "ci" },
      ],
      checksExitCode: 8,
    });

    await withFakeGh(failedGh.binDir, failedGh.argsPath, async () => {
      await expect(checkDeliveryPullRequest({
        projectRoot: repo.repoRoot,
        prNumber: 1,
        expectedHeadSha: repo.baseCommit,
      })).resolves.toMatchObject({
        status: "failed",
        checks: expect.arrayContaining([{ name: "unit", status: "failed", state: "FAILURE", workflow: "ci" }]),
        command: { ok: false, exitCode: 1 },
      });
      expect(existsSync(failedGh.argsPath)).toBe(false);
    });

    await withFakeGh(pendingGh.binDir, pendingGh.argsPath, async () => {
      await expect(checkDeliveryPullRequest({
        projectRoot: repo.repoRoot,
        prNumber: 1,
        expectedHeadSha: repo.baseCommit,
      })).resolves.toMatchObject({
        status: "pending",
        checks: [{ name: "unit", status: "pending" }],
        command: { ok: false, exitCode: 8 },
      });
      expect(existsSync(pendingGh.argsPath)).toBe(false);
    });
  });

  it("rejects pull request checks when GitHub reports a stale head sha", async () => {
    const repo = await createTestRepo("skyturn-delivery-pr-checks-stale-");
    tempRoots.push(repo.tempRoot);
    await writeFile(join(repo.repoRoot, "feature.txt"), "changed\n");
    const commit = await createDeliveryCommit({
      projectRoot: repo.repoRoot,
      worktreePath: repo.repoRoot,
      files: ["feature.txt"],
      subject: "feat(delivery): add exact head check",
    });
    const fakeGh = await installFakeGh(repo.tempRoot, {
      prHeadSha: repo.baseCommit,
      checksJson: [{ name: "unit", state: "SUCCESS", workflow: "ci" }],
    });

    await withFakeGh(fakeGh.binDir, fakeGh.argsPath, async () => {
      await expect(checkDeliveryPullRequest({
        projectRoot: repo.repoRoot,
        prNumber: 1,
        expectedHeadSha: commit.commitSha,
      })).rejects.toMatchObject({
        code: "REMOTE_HEAD_MISMATCH",
      });
      expect(existsSync(fakeGh.argsPath)).toBe(false);
    });
  });

  it("rejects pull request checks when the PR head changes after checks are read", async () => {
    const repo = await createTestRepo("skyturn-delivery-pr-checks-race-");
    tempRoots.push(repo.tempRoot);
    await writeFile(join(repo.repoRoot, "feature.txt"), "force pushed\n");
    const forcePushCommit = await createDeliveryCommit({
      projectRoot: repo.repoRoot,
      worktreePath: repo.repoRoot,
      files: ["feature.txt"],
      subject: "feat(delivery): force push after checks",
    });
    const fakeGh = await installFakeGh(repo.tempRoot, {
      prHeadShas: [repo.baseCommit, forcePushCommit.commitSha],
      checksJson: [{ name: "unit", state: "SUCCESS", workflow: "ci" }],
    });

    await withFakeGh(fakeGh.binDir, fakeGh.argsPath, async () => {
      await expect(checkDeliveryPullRequest({
        projectRoot: repo.repoRoot,
        prNumber: 1,
        expectedHeadSha: repo.baseCommit,
      })).rejects.toMatchObject({
        code: "REMOTE_HEAD_MISMATCH",
      });
      expect(existsSync(fakeGh.argsPath)).toBe(false);
    });
  });

  it("parses raw checks JSON before redacting secret-like descriptions and stderr", async () => {
    const repo = await createTestRepo("skyturn-delivery-pr-checks-secrets-");
    tempRoots.push(repo.tempRoot);
    const fakeGh = await installFakeGh(repo.tempRoot, {
      prHeadSha: repo.baseCommit,
      checksJson: [
        {
          name: "unit",
          state: "SUCCESS",
          workflow: "ci",
          description: "Token line: token=secret-value",
        },
      ],
      checksStderr: "Authorization: Bearer ghp_checks_secret",
    });

    await withFakeGh(fakeGh.binDir, fakeGh.argsPath, async () => {
      const evidence = await checkDeliveryPullRequest({
        projectRoot: repo.repoRoot,
        prNumber: 1,
        expectedHeadSha: repo.baseCommit,
      });

      expect(evidence.checks).toMatchObject([
        { name: "unit", status: "passed", detail: "Token line: token=[REDACTED]" },
      ]);
      expect(evidence.command.stderr).toContain("Authorization: Bearer [REDACTED]");
      expect(JSON.stringify(evidence)).not.toContain("secret-value");
      expect(JSON.stringify(evidence)).not.toContain("ghp_checks_secret");
    });
  });

  it("rejects squash merge when pull request checks are pending or failing", async () => {
    const repo = await createTestRepo("skyturn-delivery-pr-merge-checks-");
    tempRoots.push(repo.tempRoot);
    const cases = [
      {
        label: "pending",
        checksJson: [{ name: "unit", state: "PENDING", workflow: "ci" }],
        checksExitCode: 8,
        expectedStatus: "pending",
      },
      {
        label: "failing",
        checksJson: [{ name: "unit", state: "FAILURE", workflow: "ci" }],
        checksExitCode: 1,
        expectedStatus: "failed",
      },
    ] as const;

    for (const item of cases) {
      const fakeGh = await installFakeGh(join(repo.tempRoot, item.label), {
        prHeadSha: repo.baseCommit,
        checksJson: item.checksJson,
        checksExitCode: item.checksExitCode,
      });

      await withFakeGh(fakeGh.binDir, fakeGh.argsPath, async () => {
        await expect(mergeDeliveryPullRequest({
          projectRoot: repo.repoRoot,
          prNumber: 1,
          expectedHeadSha: repo.baseCommit,
          subject: "feat(delivery): merge exact checked pr",
          body: "Merge after checks pass.",
        })).rejects.toMatchObject({
          code: "DELIVERY_REJECTED",
          message: expect.stringContaining(item.expectedStatus),
        });
        expect(existsSync(fakeGh.argsPath)).toBe(false);
      });
    }
  });

  it("rejects squash merge when review requested changes", async () => {
    const repo = await createTestRepo("skyturn-delivery-pr-merge-review-");
    tempRoots.push(repo.tempRoot);
    const fakeGh = await installFakeGh(repo.tempRoot, {
      prHeadSha: repo.baseCommit,
      reviewDecision: "CHANGES_REQUESTED",
      checksJson: [{ name: "unit", state: "SUCCESS", workflow: "ci" }],
    });

    await withFakeGh(fakeGh.binDir, fakeGh.argsPath, async () => {
      await expect(mergeDeliveryPullRequest({
        projectRoot: repo.repoRoot,
        prNumber: 1,
        expectedHeadSha: repo.baseCommit,
        subject: "feat(delivery): merge exact checked pr",
      })).rejects.toMatchObject({
        code: "DELIVERY_REJECTED",
        message: expect.stringContaining("review requested changes"),
      });
      expect(existsSync(fakeGh.argsPath)).toBe(false);
    });
  });

  it("rejects squash merge when review evidence is unknown or missing", async () => {
    const repo = await createTestRepo("skyturn-delivery-pr-merge-review-missing-");
    tempRoots.push(repo.tempRoot);
    const cases = [
      { label: "missing" },
      { label: "unknown", reviewDecision: "UNKNOWN" },
    ] as const;

    for (const item of cases) {
      const fakeGh = await installFakeGh(join(repo.tempRoot, item.label), {
        prHeadSha: repo.baseCommit,
        ...(item.reviewDecision ? { reviewDecision: item.reviewDecision } : {}),
        checksJson: [{ name: "unit", state: "SUCCESS", workflow: "ci" }],
      });

      await withFakeGh(fakeGh.binDir, fakeGh.argsPath, async () => {
        await expect(mergeDeliveryPullRequest({
          projectRoot: repo.repoRoot,
          prNumber: 1,
          expectedHeadSha: repo.baseCommit,
          subject: "feat(delivery): merge exact checked pr",
        })).rejects.toMatchObject({
          code: "DELIVERY_REJECTED",
          message: expect.stringContaining("review evidence must be approved or pending"),
        });
        expect(existsSync(fakeGh.argsPath)).toBe(false);
      });
    }
  });

  it("rejects squash merge when the expected head sha does not match the PR", async () => {
    const repo = await createTestRepo("skyturn-delivery-pr-merge-stale-");
    tempRoots.push(repo.tempRoot);
    await writeFile(join(repo.repoRoot, "feature.txt"), "changed\n");
    const commit = await createDeliveryCommit({
      projectRoot: repo.repoRoot,
      worktreePath: repo.repoRoot,
      files: ["feature.txt"],
      subject: "feat(delivery): add exact merge head",
    });
    const fakeGh = await installFakeGh(repo.tempRoot, {
      prHeadSha: repo.baseCommit,
      checksJson: [{ name: "unit", state: "SUCCESS", workflow: "ci" }],
    });

    await withFakeGh(fakeGh.binDir, fakeGh.argsPath, async () => {
      await expect(mergeDeliveryPullRequest({
        projectRoot: repo.repoRoot,
        prNumber: 1,
        expectedHeadSha: commit.commitSha,
        subject: "feat(delivery): merge exact checked pr",
      })).rejects.toMatchObject({
        code: "REMOTE_HEAD_MISMATCH",
      });
      expect(existsSync(fakeGh.argsPath)).toBe(false);
    });
  });

  it("squash merges with a Conventional Commit subject and redacted command evidence", async () => {
    const repo = await createTestRepo("skyturn-delivery-pr-merge-");
    tempRoots.push(repo.tempRoot);
    const fakeGh = await installFakeGh(repo.tempRoot, {
      prHeadSha: repo.baseCommit,
      reviewDecision: "APPROVED",
      checksJson: [{ name: "unit", state: "SUCCESS", workflow: "ci" }],
    });

    await withFakeGh(fakeGh.binDir, fakeGh.argsPath, async () => {
      await expect(mergeDeliveryPullRequest({
        projectRoot: repo.repoRoot,
        prNumber: 1,
        expectedHeadSha: repo.baseCommit,
        subject: "merge this",
      })).rejects.toMatchObject({
        code: "INVALID_INPUT",
      });

      const evidence = await mergeDeliveryPullRequest({
        projectRoot: repo.repoRoot,
        prUrl: "https://github.com/acme/skyturn/pull/1",
        expectedHeadSha: repo.baseCommit,
        subject: "feat(delivery): merge exact checked pr",
        body: "Token line: token=secret-value",
      });

      expect(evidence).toMatchObject({
        status: "merged",
        number: 1,
        headSha: repo.baseCommit,
        subject: "feat(delivery): merge exact checked pr",
        checks: [{ name: "unit", status: "passed" }],
        review: { status: "approved" },
        command: { command: "gh", ok: true, exitCode: 0 },
      });
      expect(evidence.command.args).toContain("--squash");
      expect(evidence.command.args).not.toContain("--delete-branch");
      expect(evidence.command.args.join("\n")).not.toContain("secret-value");
      expect(evidence.command.args.join("\n")).toContain("token=[REDACTED]");
    });
  });

  it("passes the expected head sha to gh merge's native match guard", async () => {
    const repo = await createTestRepo("skyturn-delivery-pr-merge-match-head-");
    tempRoots.push(repo.tempRoot);
    const fakeGh = await installFakeGh(repo.tempRoot, {
      prHeadSha: repo.baseCommit,
      reviewDecision: "APPROVED",
      checksJson: [{ name: "unit", state: "SUCCESS", workflow: "ci" }],
      mergeRequiresMatchHead: repo.baseCommit,
    });

    await withFakeGh(fakeGh.binDir, fakeGh.argsPath, async () => {
      const evidence = await mergeDeliveryPullRequest({
        projectRoot: repo.repoRoot,
        prNumber: 1,
        expectedHeadSha: repo.baseCommit,
        subject: "feat(delivery): merge exact checked pr",
      });

      const matchIndex = evidence.command.args.indexOf("--match-head-commit");
      expect(matchIndex).toBeGreaterThan(-1);
      expect(evidence.command.args[matchIndex + 1]).toBe(repo.baseCommit);
    });
  });

  it("syncs local main with fetch and pull --ff-only", async () => {
    const repo = await createTestRepo("skyturn-delivery-sync-main-");
    tempRoots.push(repo.tempRoot);
    const remotePath = join(repo.tempRoot, "remote.git");
    const upstreamPath = join(repo.tempRoot, "upstream");
    git(repo.tempRoot, ["init", "--bare", "remote.git"]);
    git(repo.repoRoot, ["remote", "add", "origin", remotePath]);
    git(repo.repoRoot, ["push", "origin", "main"]);
    git(repo.tempRoot, ["clone", remotePath, upstreamPath]);
    git(upstreamPath, ["checkout", "-b", "main", "origin/main"]);
    git(upstreamPath, ["config", "user.email", "skyturn@example.test"]);
    git(upstreamPath, ["config", "user.name", "SkyTurn Test"]);
    writeFileSync(join(upstreamPath, "remote.txt"), "remote\n");
    git(upstreamPath, ["add", "remote.txt"]);
    git(upstreamPath, ["commit", "-m", "feat(delivery): update remote main"]);
    git(upstreamPath, ["push", "origin", "main"]);

    const evidence = await syncDeliveryMain({ projectRoot: repo.repoRoot });

    expect(evidence).toMatchObject({
      status: "synced",
      mainBranch: "main",
      commands: [
        { command: "git", args: ["fetch", "origin", "main"], ok: true },
        { command: "git", args: ["pull", "--ff-only", "origin", "main"], ok: true },
      ],
    });
    expect(readFileSync(join(repo.repoRoot, "remote.txt"), "utf8")).toBe("remote\n");
  });

  it("reports sync main ff-only failures cleanly", async () => {
    const repo = await createTestRepo("skyturn-delivery-sync-main-fail-");
    tempRoots.push(repo.tempRoot);
    const remotePath = join(repo.tempRoot, "remote.git");
    const upstreamPath = join(repo.tempRoot, "upstream");
    git(repo.tempRoot, ["init", "--bare", "remote.git"]);
    git(repo.repoRoot, ["remote", "add", "origin", remotePath]);
    git(repo.repoRoot, ["push", "origin", "main"]);
    git(repo.tempRoot, ["clone", remotePath, upstreamPath]);
    git(upstreamPath, ["checkout", "-b", "main", "origin/main"]);
    git(upstreamPath, ["config", "user.email", "skyturn@example.test"]);
    git(upstreamPath, ["config", "user.name", "SkyTurn Test"]);
    writeFileSync(join(upstreamPath, "remote.txt"), "remote\n");
    git(upstreamPath, ["add", "remote.txt"]);
    git(upstreamPath, ["commit", "-m", "feat(delivery): update remote main"]);
    git(upstreamPath, ["push", "origin", "main"]);
    writeFileSync(join(repo.repoRoot, "local.txt"), "local\n");
    git(repo.repoRoot, ["add", "local.txt"]);
    git(repo.repoRoot, ["commit", "-m", "feat(delivery): update local main"]);

    await expect(syncDeliveryMain({ projectRoot: repo.repoRoot })).rejects.toMatchObject({
      code: "DELIVERY_REJECTED",
      message: expect.stringContaining("pull"),
    });
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

  it("ignores hostile Git redirect environments for checkpoint and changeset evidence", async () => {
    const target = await createTestRepo("skyturn-git-environment-target-");
    const hostile = await createTestRepo("skyturn-git-environment-hostile-");
    changesetTempRoots.push(target.tempRoot, hostile.tempRoot);
    await writeFile(join(target.repoRoot, "feature.txt"), "target change\n", "utf8");
    const expectedHead = git(target.repoRoot, ["rev-parse", "HEAD"]);

    await withProcessEnvironment({
      GIT_DIR: join(hostile.repoRoot, ".git"),
      GIT_WORK_TREE: hostile.repoRoot,
      GIT_INDEX_FILE: join(hostile.repoRoot, ".git", "index"),
      GIT_OBJECT_DIRECTORY: join(hostile.repoRoot, ".git", "objects"),
      GIT_CONFIG_COUNT: "1",
      GIT_CONFIG_KEY_0: "status.showUntrackedFiles",
      GIT_CONFIG_VALUE_0: "no",
      Git_Future_Redirect: hostile.repoRoot,
      git_work_tree: hostile.repoRoot,
    }, async () => {
      await expect(getGitCheckpointSnapshot(target.repoRoot)).resolves.toEqual({
        branchName: "main",
        headCommit: expectedHead,
        worktreeState: "dirty",
      });

      const changeset = await createGitChangesetService().getChangeset(nodeForRepo(target.repoRoot));
      expect(changeset.evidence?.status).toBe("available");
      expect(changeset.files).toEqual(["feature.txt"]);
      expect(changeset.patchPreview).toContain("+target change");
    });
  });

  it("fails full-patch evidence when bounded Git termination throws before actual close", async () => {
    const target = await createTestRepo("skyturn-git-termination-error-");
    changesetTempRoots.push(target.tempRoot);
    await writeFile(join(target.repoRoot, "feature.txt"), `base\n${"changed\n".repeat(128)}`, "utf8");
    const originalKill = ChildProcess.prototype.kill;
    ChildProcess.prototype.kill = function (signal?: NodeJS.Signals | number): boolean {
      if (signal === "SIGTERM") throw new Error("test termination failure");
      return originalKill.call(this, signal);
    };

    try {
      const changeset = await createGitChangesetService({ maxFullPatchBytes: 4 })
        .getChangeset(nodeForRepo(target.repoRoot));

      expect(changeset.evidence?.status).toBe("failed");
      expect(changeset.evidence?.errorReason).toContain("test termination failure");
    } finally {
      ChildProcess.prototype.kill = originalKill;
    }
  });

  it("fails full-patch evidence when close follows a rejected termination", async () => {
    const target = await createTestRepo("skyturn-git-termination-rejected-");
    changesetTempRoots.push(target.tempRoot);
    await writeFile(join(target.repoRoot, "feature.txt"), `base\n${"changed\n".repeat(128)}`, "utf8");
    const originalKill = ChildProcess.prototype.kill;
    let terminationCalls = 0;
    ChildProcess.prototype.kill = function (signal?: NodeJS.Signals | number): boolean {
      const accepted = originalKill.call(this, signal);
      if (signal !== "SIGTERM") return accepted;
      terminationCalls += 1;
      return false;
    };

    try {
      const changeset = await createGitChangesetService({ maxFullPatchBytes: 4 })
        .getChangeset(nodeForRepo(target.repoRoot));

      expect(changeset.evidence).toMatchObject({
        status: "failed",
        patchPreviewTruncated: false,
      });
      expect(changeset.evidence).not.toHaveProperty("fullPatchSha256");
      expect(terminationCalls).toBe(1);
    } finally {
      ChildProcess.prototype.kill = originalKill;
    }
  });

  it("rejects a nested checkout path but accepts a linked worktree top level", async () => {
    const repo = await createTestRepo("skyturn-checkpoint-top-level-");
    changesetTempRoots.push(repo.tempRoot);
    const nestedPath = join(repo.repoRoot, "nested");
    const linkedPath = join(repo.tempRoot, "linked");
    await mkdir(nestedPath);
    await gitAsync(repo.repoRoot, "worktree", "add", "-b", "feature/linked", linkedPath, repo.baseCommit);

    await expect(getGitCheckpointSnapshot(nestedPath)).rejects.toThrow(/top-level/i);
    await expect(getGitCheckpointSnapshot(linkedPath)).resolves.toEqual({
      branchName: "feature/linked",
      headCommit: repo.baseCommit,
      worktreeState: "clean",
    });
  });

  it("defines only SkyTurn-generated volatile .devflow paths as Git evidence exclusions", () => {
    expect(SKYTURN_VOLATILE_GIT_PATHS).toEqual([
      ".devflow/skyturn-workflow.sqlite",
      ".devflow/skyturn-workflow.sqlite-wal",
      ".devflow/skyturn-workflow.sqlite-shm",
      ".devflow/runs/**",
      ".devflow/tasks/**/output.md",
    ]);
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
    expect(changeset.evidence).toMatchObject({
      fullPatchSha256: expect.stringMatching(/^[0-9a-f]{64}$/),
      fullPatchByteLength: Buffer.byteLength(changeset.patchPreview),
      fileManifestSha256: expect.stringMatching(/^[0-9a-f]{64}$/),
    });
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

  it("collects empty, binary, whitespace, newline, tab, and Unicode untracked paths", async () => {
    const repoRoot = await createRepo();
    const files = [
      "binary.bin",
      "empty file.txt",
      "line\nbreak.txt",
      "tab\tname.txt",
      "unicodé-雪.txt",
    ];
    await writeFile(join(repoRoot, files[0]!), Buffer.from([0, 1, 2, 255, 0, 3]));
    await writeFile(join(repoRoot, files[1]!), "", "utf8");
    for (const file of files.slice(2)) await writeFile(join(repoRoot, file), `${file}\n`, "utf8");

    const changeset = await createGitChangesetService().getChangeset(nodeForRepo(repoRoot));

    expect(changeset.evidence?.status).toBe("available");
    expect(changeset.files).toEqual([...files].sort(compareUtf8));
    expect(changeset.diffStat).toEqual({ added: 4, changed: 5, deleted: 0 });
    expect(changeset.patchPreview).toContain("GIT binary patch");
    expect(changeset.evidence).toHaveProperty("fullPatchSha256");
  });

  it("accepts the exact full-patch cap and fails cap minus one without digest fields", async () => {
    const repoRoot = await createRepo();
    await writeFile(join(repoRoot, "src.ts"), `export const value = 2;\n${"extra line\n".repeat(32)}`, "utf8");
    await writeFile(join(repoRoot, "cap-untracked.txt"), "untracked cap section\n", "utf8");
    const initial = await createGitChangesetService().getChangeset(nodeForRepo(repoRoot));
    const exactLength = initial.evidence?.fullPatchByteLength;
    expect(exactLength).toBeTypeOf("number");
    expect(exactLength).toBeGreaterThan(1);

    const exact = await createGitChangesetService({ maxFullPatchBytes: exactLength })
      .getChangeset(nodeForRepo(repoRoot));
    const overflow = await createGitChangesetService({ maxFullPatchBytes: exactLength! - 1 })
      .getChangeset(nodeForRepo(repoRoot));

    expect(exact.evidence).toMatchObject({ status: "available", fullPatchByteLength: exactLength });
    expect(overflow.evidence).toMatchObject({
      status: "failed",
      errorReason: expect.stringMatching(/full patch|byte limit/i),
    });
    expect(overflow.evidence).not.toHaveProperty("fullPatchSha256");
    expect(overflow.evidence).not.toHaveProperty("fullPatchByteLength");
    expect(overflow.evidence).not.toHaveProperty("fileManifestSha256");
    for (const invalidLimit of [0, -1, Number.MAX_SAFE_INTEGER + 1]) {
      expect(() => createGitChangesetService({ maxFullPatchBytes: invalidLimit })).toThrow(/positive safe integer/i);
    }
  });

  it("accepts the exact full-patch cap for a staged-only unborn repository", async () => {
    const repoRoot = await mkdtemp(join(tmpdir(), "skyturn-git-unborn-staged-cap-"));
    changesetTempRoots.push(repoRoot);
    await gitAsync(repoRoot, "init");
    await writeFile(join(repoRoot, "staged.txt"), `${"staged line\n".repeat(16)}`, "utf8");
    await gitAsync(repoRoot, "add", "staged.txt");
    const initial = await createGitChangesetService().getChangeset(nodeForRepo(repoRoot));
    const exactLength = initial.evidence?.fullPatchByteLength;
    expect(exactLength).toBeTypeOf("number");
    expect(exactLength).toBeGreaterThan(1);

    const exact = await createGitChangesetService({ maxFullPatchBytes: exactLength })
      .getChangeset(nodeForRepo(repoRoot));
    const overflow = await createGitChangesetService({ maxFullPatchBytes: exactLength! - 1 })
      .getChangeset(nodeForRepo(repoRoot));

    expect(exact.evidence).toMatchObject({
      status: "available",
      fullPatchSha256: expect.stringMatching(/^[0-9a-f]{64}$/),
      fullPatchByteLength: exactLength,
      fileManifestSha256: expect.stringMatching(/^[0-9a-f]{64}$/),
    });
    expect(overflow.evidence).toMatchObject({ status: "failed" });
    expect(overflow.evidence).not.toHaveProperty("fullPatchSha256");
    expect(overflow.evidence).not.toHaveProperty("fullPatchByteLength");
    expect(overflow.evidence).not.toHaveProperty("fileManifestSha256");
  });

  it("collects ordered staged, unstaged, and untracked evidence in an unborn repository", async () => {
    const repoRoot = await mkdtemp(join(tmpdir(), "skyturn-git-unborn-"));
    changesetTempRoots.push(repoRoot);
    await gitAsync(repoRoot, "init");
    await writeFile(join(repoRoot, "staged.txt"), "staged\n", "utf8");
    await gitAsync(repoRoot, "add", "staged.txt");
    await writeFile(join(repoRoot, "staged.txt"), "staged\nunstaged\n", "utf8");
    await writeFile(join(repoRoot, "untracked.txt"), "untracked\n", "utf8");

    const changeset = await createGitChangesetService().getChangeset(nodeForRepo(repoRoot));

    expect(changeset.evidence?.status).toBe("available");
    expect(changeset.files).toEqual(["staged.txt", "untracked.txt"]);
    expect(changeset.diffStat).toEqual({ added: 3, changed: 2, deleted: 0 });
    expect(changeset.patchPreview.match(/diff --git a\/staged\.txt b\/staged\.txt/g)).toHaveLength(2);
    expect(changeset.patchPreview.indexOf("a/untracked.txt")).toBeGreaterThan(
      changeset.patchPreview.lastIndexOf("a/staged.txt"),
    );
    expect(changeset.evidence).toHaveProperty("fullPatchSha256");
  });

  it("fails closed on unmerged entries without atomic digest fields", async () => {
    const repoRoot = await createRepo();
    const mainBranch = git(repoRoot, ["branch", "--show-current"]);
    await gitAsync(repoRoot, "checkout", "-b", "conflict-side");
    await writeFile(join(repoRoot, "src.ts"), "side\n", "utf8");
    await gitAsync(repoRoot, "add", "src.ts");
    await gitAsync(repoRoot, "commit", "-m", "side");
    await gitAsync(repoRoot, "checkout", mainBranch);
    await writeFile(join(repoRoot, "src.ts"), "main\n", "utf8");
    await gitAsync(repoRoot, "add", "src.ts");
    await gitAsync(repoRoot, "commit", "-m", "main");
    await expect(execFileAsync("git", ["merge", "conflict-side"], { cwd: repoRoot })).rejects.toBeDefined();

    const changeset = await createGitChangesetService().getChangeset(nodeForRepo(repoRoot));

    expect(changeset.evidence).toMatchObject({
      status: "failed",
      errorReason: expect.stringMatching(/unmerged|conflict/i),
    });
    expect(changeset.evidence).not.toHaveProperty("fullPatchSha256");
  });

  it("fails atomic publication when the worktree mutates between complete snapshots", async () => {
    const repoRoot = await createRepo();
    await writeFile(join(repoRoot, "src.ts"), "export const value = 2;\n", "utf8");
    const fakeGit = await installChangesetMutationGitWrapper(repoRoot);

    const changeset = await withFakeGit(fakeGit.binDir, () => (
      createGitChangesetService().getChangeset(nodeForRepo(repoRoot))
    ));

    expect(changeset.evidence).toMatchObject({
      status: "failed",
      errorReason: expect.stringMatching(/atomic|drift|changed/i),
    });
    expect(changeset.evidence).not.toHaveProperty("fullPatchSha256");
  });

  it.skipIf(process.platform === "win32")("keeps chmod-only evidence visible despite hostile core.fileMode", async () => {
    const repoRoot = await createRepo();
    await gitAsync(repoRoot, "config", "core.fileMode", "false");
    await chmod(join(repoRoot, "src.ts"), 0o755);

    const changeset = await createGitChangesetService().getChangeset(nodeForRepo(repoRoot));

    expect(changeset.evidence?.status).toBe("available");
    expect(changeset.files).toEqual(["src.ts"]);
    expect(changeset.diffStat).toEqual({ added: 0, changed: 1, deleted: 0 });
    expect(changeset.patchPreview).toContain("old mode 100644");
    expect(changeset.patchPreview).toContain("new mode 100755");
  });

  it("fails closed on nonempty common info attributes and recovers after removal", async () => {
    const target = await createTestRepo("skyturn-git-info-attributes-");
    changesetTempRoots.push(target.tempRoot);
    const linkedRoot = join(target.tempRoot, "linked");
    await gitAsync(target.repoRoot, "worktree", "add", "-b", "feature/info-attributes", linkedRoot, target.baseCommit);
    await writeFile(join(linkedRoot, "feature.txt"), "changed\n", "utf8");
    const infoAttributes = git(linkedRoot, ["rev-parse", "--path-format=absolute", "--git-path", "info/attributes"]);
    await writeFile(infoAttributes, "feature.txt -diff\n", "utf8");

    const blocked = await createGitChangesetService().getChangeset(nodeForRepo(linkedRoot));

    expect(blocked.evidence).toMatchObject({
      status: "failed",
      errorReason: expect.stringMatching(/attributes|canonical/i),
    });
    expect(blocked.evidence?.errorReason).not.toContain(target.repoRoot);
    expect(blocked.evidence?.errorReason).not.toContain("feature.txt -diff");
    expect(blocked.evidence).not.toHaveProperty("fullPatchSha256");

    await rm(infoAttributes);
    const restored = await createGitChangesetService().getChangeset(nodeForRepo(linkedRoot));
    expect(restored.evidence).toMatchObject({
      status: "available",
      fullPatchSha256: expect.stringMatching(/^[0-9a-f]{64}$/),
    });
    expect(restored.files).toEqual(["feature.txt"]);
    expect(restored.patchPreview).toContain("+changed");
  });

  it("collects committed variant evidence only for the recorded clean base-to-head range", async () => {
    const repoRoot = await createRepo();
    const baseCommit = git(repoRoot, ["rev-parse", "HEAD"]);
    await writeFile(join(repoRoot, "src.ts"), "export const value = 2;\n", "utf8");
    await gitAsync(repoRoot, "add", "src.ts");
    await gitAsync(repoRoot, "commit", "-m", "variant");
    const headCommit = git(repoRoot, ["rev-parse", "HEAD"]);
    const worktree = worktreeIdentityFor(repoRoot, baseCommit, headCommit);
    const service = createGitChangesetService();

    const clean = await service.collectChangesetEvidence({ node: nodeForRepo(repoRoot), worktree });
    expect(clean).toMatchObject({
      status: "available",
      files: ["src.ts"],
      worktreeId: worktree.worktreeId,
      fullPatchSha256: expect.stringMatching(/^[0-9a-f]{64}$/),
    });

    for (const nonCanonical of [
      worktreeIdentityFor(repoRoot, "HEAD~1", "HEAD"),
      worktreeIdentityFor(repoRoot, baseCommit.slice(0, 12), headCommit.slice(0, 12)),
    ]) {
      const rejected = await service.collectChangesetEvidence({ node: nodeForRepo(repoRoot), worktree: nonCanonical });
      expect(rejected).toMatchObject({
        status: "failed",
        errorReason: expect.stringMatching(/canonical|object ID|commit/i),
      });
      expect(rejected).not.toHaveProperty("fullPatchSha256");
      expect(rejected).not.toHaveProperty("fullPatchByteLength");
      expect(rejected).not.toHaveProperty("fileManifestSha256");
    }

    const dirtySentinel = "DIRTY BYTES MUST NOT ENTER RECORDED EVIDENCE";
    await writeFile(join(repoRoot, "src.ts"), `${dirtySentinel}\n`, "utf8");
    const dirty = await service.collectChangesetEvidence({ node: nodeForRepo(repoRoot), worktree });
    expect(dirty).toMatchObject({ status: "failed", errorReason: expect.stringMatching(/clean|dirty/i) });
    expect(dirty).not.toHaveProperty("fullPatchSha256");
    expect(JSON.stringify(dirty)).not.toContain(dirtySentinel);

    await writeFile(join(repoRoot, "src.ts"), "export const value = 2;\n", "utf8");
    const driftedHead = commitVariant(repoRoot, "head-drift");
    expect(driftedHead).not.toBe(headCommit);
    const drifted = await service.collectChangesetEvidence({ node: nodeForRepo(repoRoot), worktree });
    expect(drifted).toMatchObject({ status: "failed", errorReason: expect.stringMatching(/head/i) });
    expect(drifted).not.toHaveProperty("fullPatchSha256");
  });

  it("excludes only volatile SkyTurn evidence while retaining legitimate .devflow memory", async () => {
    const repoRoot = await createRepo();
    const files = new Map([
      [".devflow/skyturn-workflow.sqlite", "volatile\n"],
      [".devflow/skyturn-workflow.sqlite-wal", "volatile\n"],
      [".devflow/skyturn-workflow.sqlite-shm", "volatile\n"],
      [".devflow/runs/run-1/events.ndjson", "volatile\n"],
      [".devflow/tasks/task-1/output.md", "volatile\n"],
      [".devflow/memory/decisions.md", "keep\n"],
    ]);
    for (const [file, contents] of files) {
      await mkdir(dirname(join(repoRoot, file)), { recursive: true });
      await writeFile(join(repoRoot, file), contents, "utf8");
    }

    const changeset = await createGitChangesetService().getChangeset(nodeForRepo(repoRoot));

    expect(changeset.files).toEqual([".devflow/memory/decisions.md"]);
    expect(changeset.patchPreview).toContain(".devflow/memory/decisions.md");
    expect(changeset.patchPreview).not.toContain("skyturn-workflow.sqlite");
    expect(changeset.patchPreview).not.toContain("events.ndjson");
    expect(changeset.patchPreview).not.toContain("tasks/task-1/output.md");
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
    expect(reconciliation.changeset.evidence).toHaveProperty("fullPatchSha256");
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

async function withProcessEnvironment<T>(
  values: Record<string, string>,
  callback: () => Promise<T>,
): Promise<T> {
  const previous = new Map<string, string | undefined>();
  for (const [name, value] of Object.entries(values)) {
    previous.set(name, process.env[name]);
    process.env[name] = value;
  }
  try {
    return await callback();
  } finally {
    for (const [name, value] of previous) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
  }
}

async function installFakeGh(
  tempRoot: string,
  options: {
    prUrl?: string;
    authStatus?: number;
    authStderr?: string;
    prHeadSha?: string;
    prState?: string;
    prMergeable?: string | boolean;
    reviewDecision?: string;
    reviewsJson?: unknown;
    prHeadShas?: string[];
    checksJson?: unknown;
    checksExitCode?: number;
    checksStderr?: string;
    mergeExitCode?: number;
    mergeStderr?: string;
    mergeRequiresMatchHead?: string;
  },
): Promise<{ binDir: string; argsPath: string }> {
  const binDir = join(tempRoot, "fake-bin");
  const argsPath = join(tempRoot, "gh-args.txt");
  const viewCountPath = join(tempRoot, "gh-view-count.txt");
  await mkdir(binDir, { recursive: true });
  const prUrl = options.prUrl ?? "https://github.com/acme/skyturn/pull/1";
  const prNumber = Number(prUrl.match(/\/pull\/(\d+)$/)?.[1] ?? "1");
  const prHeadShas = options.prHeadShas && options.prHeadShas.length > 0
    ? options.prHeadShas
    : [options.prHeadSha ?? "0000000000000000000000000000000000000000"];
  const prViewJsons = prHeadShas.map((headSha) => JSON.stringify({
    number: prNumber,
    url: prUrl,
    headRefOid: headSha,
    state: options.prState ?? "OPEN",
    mergeable: options.prMergeable ?? "MERGEABLE",
    ...(options.reviewDecision !== undefined ? { reviewDecision: options.reviewDecision } : {}),
    ...(options.reviewsJson !== undefined ? { reviews: options.reviewsJson } : {}),
  }));
  const checksJson = JSON.stringify(options.checksJson ?? [
    { name: "unit", state: "SUCCESS", workflow: "ci", link: "https://github.com/acme/skyturn/actions/runs/1" },
  ]);
  const viewCases = prViewJsons.map((json, index) => [
    `    ${index + 1}) cat <<'JSON'`,
    json,
    "JSON",
    "      ;;",
  ].join("\n"));
  const lastViewJson = prViewJsons[prViewJsons.length - 1];
  const script = [
    "#!/bin/sh",
    "if [ \"$1\" = \"--version\" ]; then echo \"gh version 2.0.0\"; exit 0; fi",
    "if [ \"$1\" = \"auth\" ] && [ \"$2\" = \"status\" ]; then",
    `  echo "${options.authStderr ?? "Logged in"}" >&2`,
    `  exit ${options.authStatus ?? 0}`,
    "fi",
    "if [ \"$1\" = \"pr\" ] && [ \"$2\" = \"create\" ]; then",
      "  printf '%s\\n' \"$@\" > \"$SKYTURN_FAKE_GH_ARGS\"",
    `  echo "${prUrl}"`,
    "  exit 0",
    "fi",
    "if [ \"$1\" = \"pr\" ] && [ \"$2\" = \"view\" ]; then",
    `  count="$(cat "${viewCountPath}" 2>/dev/null || echo 0)"`,
    "  count=$((count + 1))",
    `  echo "$count" > "${viewCountPath}"`,
    "  case \"$count\" in",
    ...viewCases,
    "    *) cat <<'JSON'",
    lastViewJson,
    "JSON",
    "      ;;",
    "  esac",
    "  exit 0",
    "fi",
    "if [ \"$1\" = \"pr\" ] && [ \"$2\" = \"checks\" ]; then",
    `  cat <<'JSON'\n${checksJson}\nJSON`,
    `  echo "${options.checksStderr ?? ""}" >&2`,
    `  exit ${options.checksExitCode ?? 0}`,
    "fi",
    "if [ \"$1\" = \"pr\" ] && [ \"$2\" = \"merge\" ]; then",
    "  printf '%s\\n' \"$@\" > \"$SKYTURN_FAKE_GH_ARGS\"",
    ...(options.mergeRequiresMatchHead ? [
      "  found_match_head=0",
      "  previous_arg=",
      "  for arg in \"$@\"; do",
      `    if [ "$previous_arg" = "--match-head-commit" ] && [ "$arg" = "${options.mergeRequiresMatchHead}" ]; then found_match_head=1; fi`,
      "    previous_arg=\"$arg\"",
      "  done",
      "  if [ \"$found_match_head\" -ne 1 ]; then echo \"missing --match-head-commit\" >&2; exit 7; fi",
    ] : []),
    `  echo "${options.mergeStderr ?? ""}" >&2`,
    `  exit ${options.mergeExitCode ?? 0}`,
    "fi",
    "exit 2",
    "",
  ].join("\n");
  const ghPath = join(binDir, "gh");
  await writeFile(ghPath, script, "utf8");
  await chmod(ghPath, 0o755);
  return { binDir, argsPath };
}

async function installFakeGit(
  tempRoot: string,
  options: {
    resetExitCode: number;
  },
): Promise<{ binDir: string }> {
  const binDir = join(tempRoot, "fake-git-bin");
  await mkdir(binDir, { recursive: true });
  const gitPath = join(binDir, "git");
  const script = [
    "#!/bin/sh",
    "if [ \"$1\" = \"reset\" ] && [ \"$2\" = \"--hard\" ]; then",
    "  echo \"forced git reset failure\" >&2",
    `  exit ${options.resetExitCode}`,
    "fi",
    `exec ${shellSingleQuote(resolveExecutable("git"))} "$@"`,
    "",
  ].join("\n");
  await writeFile(gitPath, script, "utf8");
  await chmod(gitPath, 0o755);
  return { binDir };
}

async function installAncestryGitWrapper(
  tempRoot: string,
  options: {
    mode: "fail-after-success" | "reinitialize-after-success";
    repositoryPath: string;
  },
): Promise<{ binDir: string }> {
  const binDir = join(tempRoot, `ancestry-git-${options.mode}`);
  await mkdir(binDir, { recursive: true });
  const gitPath = join(binDir, "git");
  const realGit = shellSingleQuote(resolveExecutable("git"));
  const repositoryPath = shellSingleQuote(realpathSync(options.repositoryPath));
  const afterSuccess = options.mode === "fail-after-success"
    ? ["  if [ \"$status\" -eq 0 ]; then exit 23; fi"]
    : [
      `  if [ "$status" -eq 0 ] && [ "$(pwd -P)" = ${repositoryPath} ]; then`,
      `    find ${repositoryPath}/.git -mindepth 1 -maxdepth 1 -exec rm -rf -- {} +`,
      `    ${realGit} -C ${repositoryPath} init -q >/dev/null 2>&1 || exit 24`,
      "  fi",
    ];
  const script = [
    "#!/bin/sh",
    "if [ \"$1\" = \"merge-base\" ] && [ \"$2\" = \"--is-ancestor\" ]; then",
    `  ${realGit} "$@"`,
    "  status=$?",
    ...afterSuccess,
    "  exit \"$status\"",
    "fi",
    `exec ${realGit} "$@"`,
    "",
  ].join("\n");
  await writeFile(gitPath, script, "utf8");
  await chmod(gitPath, 0o755);
  return { binDir };
}

async function installChangesetMutationGitWrapper(repoRoot: string): Promise<{ binDir: string }> {
  const binDir = join(repoRoot, ".git", "changeset-mutation-git");
  const countPath = join(binDir, "status-count.txt");
  const mutatedPath = join(repoRoot, "src.ts");
  await mkdir(binDir, { recursive: true });
  const script = [
    "#!/bin/sh",
    "command_name=",
    "for arg in \"$@\"; do",
    "  if [ \"$arg\" = \"status\" ]; then command_name=status; break; fi",
    "done",
    "if [ \"$command_name\" = \"status\" ]; then",
    `  count="$(cat ${shellSingleQuote(countPath)} 2>/dev/null || echo 0)"`,
    "  count=$((count + 1))",
    `  echo "$count" > ${shellSingleQuote(countPath)}`,
    "  if [ \"$count\" -eq 2 ]; then",
    `    printf '\\nmutation between snapshots\\n' >> ${shellSingleQuote(mutatedPath)}`,
    "  fi",
    "fi",
    `exec ${shellSingleQuote(resolveExecutable("git"))} "$@"`,
    "",
  ].join("\n");
  const gitPath = join(binDir, "git");
  await writeFile(gitPath, script, "utf8");
  await chmod(gitPath, 0o755);
  return { binDir };
}

async function installCandidatePostCaptureMutationWrapper(
  repoRoot: string,
  externalBytes: string,
): Promise<{ binDir: string }> {
  const binDir = join(repoRoot, ".git", "candidate-post-capture-git");
  const markerPath = join(binDir, "mutated");
  const liveFile = join(repoRoot, "feature.txt");
  await mkdir(binDir, { recursive: true });
  const script = [
    "#!/bin/sh",
    "if [ \"$1\" = \"read-tree\" ] && [ ! -e " + shellSingleQuote(markerPath) + " ]; then",
    `  : > ${shellSingleQuote(markerPath)}`,
    "  candidate_index=$GIT_INDEX_FILE",
    "  unset GIT_INDEX_FILE",
    `  printf %s ${shellSingleQuote(externalBytes)} > ${shellSingleQuote(liveFile)}`,
    `  ${shellSingleQuote(resolveExecutable("git"))} -C ${shellSingleQuote(repoRoot)} add -- feature.txt`,
    "  GIT_INDEX_FILE=$candidate_index",
    "  export GIT_INDEX_FILE",
    "fi",
    `exec ${shellSingleQuote(resolveExecutable("git"))} "$@"`,
    "",
  ].join("\n");
  const gitPath = join(binDir, "git");
  await writeFile(gitPath, script, "utf8");
  await chmod(gitPath, 0o755);
  return { binDir };
}

async function installCandidateCasWrapper(
  repoRoot: string,
  branchRef: string,
  expectedOldCommit: string,
  competingCommit: string,
): Promise<{ binDir: string }> {
  const binDir = join(repoRoot, ".git", "candidate-cas-git");
  const markerPath = join(binDir, "competed");
  await mkdir(binDir, { recursive: true });
  const realGit = resolveExecutable("git");
  const script = [
    "#!/bin/sh",
    "if [ \"$1\" = \"update-ref\" ] && [ \"$2\" = \"--stdin\" ] && [ ! -e " + shellSingleQuote(markerPath) + " ]; then",
    `  : > ${shellSingleQuote(markerPath)}`,
    `  ${shellSingleQuote(realGit)} -C ${shellSingleQuote(repoRoot)} update-ref ${shellSingleQuote(branchRef)} ${shellSingleQuote(competingCommit)} ${shellSingleQuote(expectedOldCommit)}`,
    "fi",
    `exec ${shellSingleQuote(realGit)} "$@"`,
    "",
  ].join("\n");
  const gitPath = join(binDir, "git");
  await writeFile(gitPath, script, "utf8");
  await chmod(gitPath, 0o755);
  return { binDir };
}

async function installCandidateSymbolicBranchWrapper(
  repoRoot: string,
  branchRef: string,
  targetRef: string,
): Promise<{ binDir: string; protocolPath: string }> {
  const binDir = join(repoRoot, ".git", "candidate-symbolic-branch-git");
  const markerPath = join(binDir, "converted");
  const protocolPath = join(binDir, "protocol.txt");
  await mkdir(binDir, { recursive: true });
  const realGit = resolveExecutable("git");
  const script = [
    "#!/bin/sh",
    "if [ \"$1\" = \"update-ref\" ] && [ \"$2\" = \"--stdin\" ] && [ ! -e " + shellSingleQuote(markerPath) + " ]; then",
    `  : > ${shellSingleQuote(markerPath)}`,
    `  ${shellSingleQuote(realGit)} -C ${shellSingleQuote(repoRoot)} symbolic-ref ${shellSingleQuote(branchRef)} ${shellSingleQuote(targetRef)}`,
    `  tee ${shellSingleQuote(protocolPath)} | ${shellSingleQuote(realGit)} "$@"`,
    "  exit $?",
    "fi",
    `exec ${shellSingleQuote(realGit)} "$@"`,
    "",
  ].join("\n");
  const gitPath = join(binDir, "git");
  await writeFile(gitPath, script, "utf8");
  await chmod(gitPath, 0o755);
  return { binDir, protocolPath };
}

async function installCandidateProtocolFailureWrapper(
  repoRoot: string,
): Promise<{ binDir: string; protocolPath: string }> {
  const binDir = join(repoRoot, ".git", "candidate-protocol-failure-git");
  const protocolPath = join(binDir, "protocol.txt");
  await mkdir(binDir, { recursive: true });
  const script = [
    "#!/bin/sh",
    "if [ \"$1\" = \"update-ref\" ] && [ \"$2\" = \"--stdin\" ]; then",
    "  IFS= read -r command || exit 1",
    `  printf '%s\\n' "$command" > ${shellSingleQuote(protocolPath)}`,
    "  printf 'start: malformed\\n'",
    `  while IFS= read -r command; do printf '%s\\n' "$command" >> ${shellSingleQuote(protocolPath)}; done`,
    "  exit 1",
    "fi",
    `exec ${shellSingleQuote(resolveExecutable("git"))} "$@"`,
    "",
  ].join("\n");
  const gitPath = join(binDir, "git");
  await writeFile(gitPath, script, "utf8");
  await chmod(gitPath, 0o755);
  return { binDir, protocolPath };
}

async function installCandidateProtocolOverflowWrapper(repoRoot: string): Promise<{ binDir: string }> {
  const binDir = join(repoRoot, ".git", "candidate-protocol-overflow-git");
  await mkdir(binDir, { recursive: true });
  const script = [
    "#!/bin/sh",
    "if [ \"$1\" = \"update-ref\" ] && [ \"$2\" = \"--stdin\" ]; then",
    "  IFS= read -r command || exit 1",
    "  i=0",
    "  while [ \"$i\" -lt 1024 ]; do printf 'SENSITIVE_PROTOCOL_OUTPUT'; i=$((i + 1)); done",
    "  printf '\\n'",
    "  while IFS= read -r command; do :; done",
    "  exit 1",
    "fi",
    `exec ${shellSingleQuote(resolveExecutable("git"))} "$@"`,
    "",
  ].join("\n");
  const gitPath = join(binDir, "git");
  await writeFile(gitPath, script, "utf8");
  await chmod(gitPath, 0o755);
  return { binDir };
}

async function installCandidateSilentPrepareWrapper(repoRoot: string): Promise<{
  binDir: string;
  lockMarkerPath: string;
  protocolPath: string;
  terminationPath: string;
}> {
  const binDir = join(repoRoot, ".git", "candidate-silent-prepare-git");
  const lockMarkerPath = join(binDir, "prepared.lock");
  const protocolPath = join(binDir, "protocol.txt");
  const terminationPath = join(binDir, "terminated");
  await mkdir(binDir, { recursive: true });
  const script = [
    "#!/bin/sh",
    `lock_marker=${shellSingleQuote(lockMarkerPath)}`,
    `termination_marker=${shellSingleQuote(terminationPath)}`,
    "if [ \"$1\" = \"update-ref\" ] && [ \"$2\" = \"--stdin\" ]; then",
    "  trap 'rm -f \"$lock_marker\"' EXIT",
    "  trap 'printf terminated > \"$termination_marker\"; exit 143' TERM",
    "  IFS= read -r command || exit 1",
    `  printf '%s\\n' \"$command\" > ${shellSingleQuote(protocolPath)}`,
    "  [ \"$command\" = \"start\" ] || exit 1",
    "  printf 'start: ok\\n'",
    "  while IFS= read -r command; do",
    `    printf '%s\\n' \"$command\" >> ${shellSingleQuote(protocolPath)}`,
    "    if [ \"$command\" = \"prepare\" ]; then",
    `      : > ${shellSingleQuote(lockMarkerPath)}`,
    "      i=0",
    "      while [ \"$i\" -lt 15 ]; do sleep 1; i=$((i + 1)); done",
    "      exit 1",
    "    fi",
    "  done",
    "  exit 1",
    "fi",
    `exec ${shellSingleQuote(resolveExecutable("git"))} "$@"`,
    "",
  ].join("\n");
  const gitPath = join(binDir, "git");
  await writeFile(gitPath, script, "utf8");
  await chmod(gitPath, 0o755);
  return { binDir, lockMarkerPath, protocolPath, terminationPath };
}

async function installCandidateSilentValidationWrapper(repoRoot: string): Promise<{
  binDir: string;
  lockMarkerPath: string;
  protocolPath: string;
  validationLivePath: string;
  validationTerminationPath: string;
  validationClosedPath: string;
  abortAfterValidationClosePath: string;
  updateRefClosedPath: string;
}> {
  const binDir = join(repoRoot, ".git", "candidate-silent-validation-git");
  const lockMarkerPath = join(binDir, "prepared.lock");
  const protocolPath = join(binDir, "protocol.txt");
  const validationLivePath = join(binDir, "validation.live");
  const validationTerminationPath = join(binDir, "validation.terminated");
  const validationClosedPath = join(binDir, "validation.closed");
  const abortAfterValidationClosePath = join(binDir, "abort-after-validation-close");
  const updateRefClosedPath = join(binDir, "update-ref.closed");
  await mkdir(binDir, { recursive: true });
  const script = [
    "#!/bin/sh",
    `lock_marker=${shellSingleQuote(lockMarkerPath)}`,
    `validation_live=${shellSingleQuote(validationLivePath)}`,
    `validation_terminated=${shellSingleQuote(validationTerminationPath)}`,
    `validation_closed=${shellSingleQuote(validationClosedPath)}`,
    `abort_after_validation_close=${shellSingleQuote(abortAfterValidationClosePath)}`,
    `update_ref_closed=${shellSingleQuote(updateRefClosedPath)}`,
    "if [ \"$1\" = \"update-ref\" ] && [ \"$2\" = \"--stdin\" ]; then",
    "  trap 'rm -f \"$lock_marker\"; : > \"$update_ref_closed\"' EXIT",
    "  IFS= read -r command || exit 1",
    `  printf '%s\\n' "$command" > ${shellSingleQuote(protocolPath)}`,
    "  [ \"$command\" = \"start\" ] || exit 1",
    "  printf 'start: ok\\n'",
    "  while IFS= read -r command; do",
    `    printf '%s\\n' "$command" >> ${shellSingleQuote(protocolPath)}`,
    "    if [ \"$command\" = \"prepare\" ]; then",
    "      : > \"$lock_marker\"",
    "      printf 'prepare: ok\\n'",
    "    elif [ \"$command\" = \"abort\" ]; then",
    "      [ -e \"$validation_closed\" ] && : > \"$abort_after_validation_close\"",
    "      printf 'abort: ok\\n'",
    "      exit 0",
    "    else",
    "      :",
    "    fi",
    "  done",
    "  exit 1",
    "fi",
    "if [ \"$1\" = \"for-each-ref\" ] && [ -e \"$lock_marker\" ]; then",
    "  : > \"$validation_live\"",
    "  trap ': > \"$validation_terminated\"; exit 0' TERM",
    "  trap 'rm -f \"$validation_live\"; : > \"$validation_closed\"' EXIT",
    "  i=0",
    "  while [ \"$i\" -lt 120 ]; do sleep 0.1; i=$((i + 1)); done",
    "  exit 0",
    "fi",
    `exec ${shellSingleQuote(resolveExecutable("git"))} "$@"`,
    "",
  ].join("\n");
  const gitPath = join(binDir, "git");
  await writeFile(gitPath, script, "utf8");
  await chmod(gitPath, 0o755);
  return {
    binDir,
    lockMarkerPath,
    protocolPath,
    validationLivePath,
    validationTerminationPath,
    validationClosedPath,
    abortAfterValidationClosePath,
    updateRefClosedPath,
  };
}

async function installCandidateConcurrentCasWrapper(repoRoot: string): Promise<{ binDir: string }> {
  const binDir = join(repoRoot, ".git", "candidate-concurrent-git");
  const firstPath = join(binDir, "first");
  const secondPath = join(binDir, "second");
  await mkdir(binDir, { recursive: true });
  const realGit = resolveExecutable("git");
  const script = [
    "#!/bin/sh",
    "if [ \"$1\" = \"update-ref\" ] && [ \"$2\" = \"--stdin\" ]; then",
    `  if mkdir ${shellSingleQuote(firstPath)} 2>/dev/null; then`,
    `    while [ ! -e ${shellSingleQuote(secondPath)} ]; do sleep 0.01; done`,
    "  else",
    `    : > ${shellSingleQuote(secondPath)}`,
    "  fi",
    "fi",
    `exec ${shellSingleQuote(realGit)} "$@"`,
    "",
  ].join("\n");
  const gitPath = join(binDir, "git");
  await writeFile(gitPath, script, "utf8");
  await chmod(gitPath, 0o755);
  return { binDir };
}

async function installCandidateHeadSwitchWrapper(
  repoRoot: string,
  branchName: string,
): Promise<{ binDir: string }> {
  const binDir = join(repoRoot, ".git", "candidate-head-switch-git");
  const markerPath = join(binDir, "switched");
  await mkdir(binDir, { recursive: true });
  const realGit = resolveExecutable("git");
  const script = [
    "#!/bin/sh",
    "if [ \"$1\" = \"update-ref\" ] && [ \"$2\" = \"--stdin\" ] && [ ! -e " + shellSingleQuote(markerPath) + " ]; then",
    `  : > ${shellSingleQuote(markerPath)}`,
    `  ${shellSingleQuote(realGit)} -C ${shellSingleQuote(repoRoot)} switch ${shellSingleQuote(branchName)} >/dev/null`,
    "fi",
    `exec ${shellSingleQuote(realGit)} "$@"`,
    "",
  ].join("\n");
  const gitPath = join(binDir, "git");
  await writeFile(gitPath, script, "utf8");
  await chmod(gitPath, 0o755);
  return { binDir };
}

async function withFakeGh<T>(binDir: string, argsPath: string, callback: () => Promise<T>): Promise<T> {
  const previousPath = process.env.PATH;
  const previousArgs = process.env.SKYTURN_FAKE_GH_ARGS;
  process.env.PATH = `${binDir}${process.env.PATH ? `:${process.env.PATH}` : ""}`;
  process.env.SKYTURN_FAKE_GH_ARGS = argsPath;
  try {
    return await callback();
  } finally {
    if (previousPath === undefined) delete process.env.PATH;
    else process.env.PATH = previousPath;
    if (previousArgs === undefined) delete process.env.SKYTURN_FAKE_GH_ARGS;
    else process.env.SKYTURN_FAKE_GH_ARGS = previousArgs;
  }
}

async function withFakeGit<T>(binDir: string, callback: () => Promise<T>): Promise<T> {
  const previousPath = process.env.PATH;
  process.env.PATH = `${binDir}${process.env.PATH ? `:${process.env.PATH}` : ""}`;
  try {
    return await callback();
  } finally {
    if (previousPath === undefined) delete process.env.PATH;
    else process.env.PATH = previousPath;
  }
}

function resolveExecutable(command: string): string {
  for (const pathEntry of (process.env.PATH ?? "").split(":")) {
    if (!pathEntry) continue;
    const candidate = join(pathEntry, command);
    if (existsSync(candidate)) return realpathSync(candidate);
  }
  throw new Error(`Cannot find executable: ${command}.`);
}

function shellSingleQuote(value: string): string {
  return `'${value.replaceAll("'", "'\\''")}'`;
}

function compareUtf8(left: string, right: string): number {
  return Buffer.compare(Buffer.from(left, "utf8"), Buffer.from(right, "utf8"));
}

async function candidateExpectationFor(
  repoRoot: string,
  beforeHeadCommit: string,
  afterHeadCommit: string,
): Promise<CandidateCommitExpectation> {
  const serializedProof = await createWorkflowGitAncestryProof({
    repositoryPath: repoRoot,
    worktreePath: repoRoot,
    beforeHeadCommit,
    afterHeadCommit,
  });
  const proof = JSON.parse(serializedProof) as {
    repositoryIdentity: string;
    worktreeIdentity: string;
  };
  const reconciliation = await createGitChangesetService().reconcileFinalChangeset({
    node: nodeForRepo(repoRoot),
    target: {
      executionTarget: "current_branch",
      selectedBranch: git(repoRoot, ["branch", "--show-current"]),
    },
    baselineRef: beforeHeadCommit,
  });
  const evidence = reconciliation.changeset.evidence;
  if (
    reconciliation.status !== "available"
    || !evidence?.fullPatchSha256
    || !evidence.fullPatchByteLength
    || !evidence.fileManifestSha256
  ) {
    throw new Error("Candidate test fixture did not produce complete changeset evidence.");
  }
  return {
    repositoryIdentity: proof.repositoryIdentity,
    worktreeIdentity: proof.worktreeIdentity,
    branchName: git(repoRoot, ["branch", "--show-current"]),
    beforeHeadCommit,
    afterHeadCommit,
    ancestryProofSha256: createHash("sha256").update(serializedProof, "utf8").digest("hex"),
    fullPatchSha256: evidence.fullPatchSha256,
    fullPatchByteLength: evidence.fullPatchByteLength,
    fileManifestSha256: evidence.fileManifestSha256,
  };
}

function worktreeIdentityFor(
  repoRoot: string,
  baseCommit: string,
  headCommit: string,
): WorkflowWorktreeIdentity {
  return {
    worktreeId: "worktree-variant-1",
    variantId: "variant-1",
    path: repoRoot,
    realPath: repoRoot,
    gitdir: realpathSync(join(repoRoot, ".git")),
    repoRoot,
    branchName: git(repoRoot, ["branch", "--show-current"]),
    baseCommit,
    headCommit,
    parentLaneId: "lane-parent",
  };
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
