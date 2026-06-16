import { spawn } from "node:child_process";
import { realpath } from "node:fs/promises";
import path from "node:path";

import type {
  CanvasNode,
  Changeset,
  ChangesetEvidence,
  WorkflowWorktreeIdentity,
} from "@skyturn/project-core";

import {
  buildAdjudicationMetrics,
  type ChangesetEvidenceInput,
  type ChangesetEvidenceService,
  type ChangesetService,
  type ManagedWorktreeService,
  type VariantComparisonEvidence,
  type VariantComparisonInput,
} from "./index.js";

export interface GitChangesetServiceOptions {
  repoRoot?: string;
  maxPatchPreviewBytes?: number;
}

const DEFAULT_MAX_PATCH_PREVIEW_BYTES = 64 * 1024;
const DEFAULT_MAX_GIT_OUTPUT_BYTES = 1024 * 1024;

export function createGitChangesetService(
  options: GitChangesetServiceOptions = {},
): ChangesetService & ChangesetEvidenceService {
  return new GitChangesetService(options);
}

export function createGitVariantComparisonService(
  options: GitChangesetServiceOptions = {},
): Pick<ManagedWorktreeService, "compareVariants"> {
  return new GitVariantComparisonService(options);
}

class GitChangesetService implements ChangesetService, ChangesetEvidenceService {
  constructor(private readonly options: GitChangesetServiceOptions) {}

  async getChangeset(node: CanvasNode): Promise<Changeset> {
    try {
      const repoRoot = await this.resolveRepoRoot(node);
      await assertGitWorktree(repoRoot);
      const status = await git(repoRoot, ["status", "--porcelain=v1", "--untracked-files=all", "--"]);
      if (status.truncated) throw new Error("Git status output exceeded the changeset evidence limit.");
      const statusLines = parseStatusLines(status.stdout);
      const files = filesFromStatus(statusLines);
      if (files.length === 0) return this.emptyChangeset(node);

      const untrackedFiles = untrackedFilesFromStatus(statusLines);
      const diffStat = await diffStatForRepo(repoRoot, files.length, untrackedFiles);
      const patch = await diffPreviewForRepo(
        repoRoot,
        this.options.maxPatchPreviewBytes ?? DEFAULT_MAX_PATCH_PREVIEW_BYTES,
        untrackedFiles,
      );
      const evidence = this.evidenceFor(node, "available", files, diffStat, patch.truncated);
      return {
        id: node.changesetId,
        files,
        diffStat,
        patchPreview: patch.value,
        source: "git",
        evidence,
      };
    } catch (error: unknown) {
      return this.failedChangeset(node, boundedReason(error instanceof Error ? error.message : "Unable to collect git changeset."));
    }
  }

  async collectChangesetEvidence(input: ChangesetEvidenceInput): Promise<ChangesetEvidence> {
    const node = input.worktree ? nodeWithWorktree(input.node, input.worktree) : input.node;
    const changeset = await this.getChangeset(node);
    return changeset.evidence ?? this.evidenceFor(node, "unknown", [], changeset.diffStat, false);
  }

  private async resolveRepoRoot(node: CanvasNode): Promise<string> {
    const candidate = path.isAbsolute(node.worktree.path)
      ? node.worktree.path
      : this.options.repoRoot ?? path.resolve(process.cwd(), node.worktree.path);
    return realpath(candidate);
  }

  private emptyChangeset(node: CanvasNode): Changeset {
    return {
      id: node.changesetId,
      files: [],
      diffStat: { added: 0, changed: 0, deleted: 0 },
      patchPreview: "",
      source: "git",
      evidence: this.evidenceFor(node, "empty", [], { added: 0, changed: 0, deleted: 0 }, false),
    };
  }

  private failedChangeset(node: CanvasNode, reason: string): Changeset {
    return {
      id: node.changesetId,
      files: [],
      diffStat: { added: 0, changed: 0, deleted: 0 },
      patchPreview: "",
      source: "git",
      evidence: {
        ...this.evidenceFor(node, "failed", [], { added: 0, changed: 0, deleted: 0 }, false),
        errorReason: reason,
      },
    };
  }

  private evidenceFor(
    node: CanvasNode,
    status: ChangesetEvidence["status"],
    files: string[],
    diffStat: Changeset["diffStat"],
    patchPreviewTruncated: boolean,
  ): ChangesetEvidence {
    return {
      evidenceId: `changeset-evidence-${node.changesetId}`,
      changesetId: node.changesetId,
      source: "git",
      status,
      files,
      diffStat,
      patchPreviewTruncated,
      collectedAt: new Date().toISOString(),
    };
  }
}

class GitVariantComparisonService implements Pick<ManagedWorktreeService, "compareVariants"> {
  constructor(private readonly options: GitChangesetServiceOptions) {}

  async compareVariants(input: VariantComparisonInput): Promise<VariantComparisonEvidence> {
    const service = createGitChangesetService(this.options);
    const left = await collectVariantChangeset(service, input.left);
    const right = await collectVariantChangeset(service, input.right);
    const leftRecorded = { ...input.recordedEvidence?.[input.left.variantId], changeset: left };
    const rightRecorded = { ...input.recordedEvidence?.[input.right.variantId], changeset: right };

    return {
      comparisonId: `comparison-${input.left.variantId}-${input.right.variantId}`,
      variants: [
        {
          variantId: input.left.variantId,
          worktreeId: input.left.worktreeId,
          changeset: left,
          metrics: buildAdjudicationMetrics(leftRecorded),
        },
        {
          variantId: input.right.variantId,
          worktreeId: input.right.worktreeId,
          changeset: right,
          metrics: buildAdjudicationMetrics(rightRecorded),
        },
      ],
      collectedAt: new Date().toISOString(),
    };
  }
}

async function collectVariantChangeset(
  service: ChangesetEvidenceService,
  worktree: WorkflowWorktreeIdentity,
): Promise<ChangesetEvidence> {
  return service.collectChangesetEvidence({
    node: {
      id: worktree.parentLaneId,
      changesetId: `changeset-${worktree.variantId}`,
      worktree: {
        path: worktree.realPath,
        branchName: worktree.branchName,
        baseCommit: worktree.baseCommit,
      },
    } as CanvasNode,
    worktree,
  });
}

function nodeWithWorktree(node: CanvasNode, worktree: WorkflowWorktreeIdentity): CanvasNode {
  return {
    ...node,
    worktree: {
      path: worktree.realPath,
      branchName: worktree.branchName,
      baseCommit: worktree.baseCommit,
    },
  };
}

async function assertGitWorktree(repoRoot: string): Promise<void> {
  const result = await git(repoRoot, ["rev-parse", "--is-inside-work-tree"]);
  if (result.stdout.trim() !== "true") throw new Error("Path is not inside a git worktree.");
}

async function diffStatForRepo(
  repoRoot: string,
  changedFileCount: number,
  untrackedFiles: string[],
): Promise<Changeset["diffStat"]> {
  const output = await diffTextAgainstHead(repoRoot, ["--numstat"]);
  let added = 0;
  let deleted = 0;
  for (const line of `${output}${await untrackedNumstat(repoRoot, untrackedFiles)}`.split(/\r?\n/)) {
    if (!line.trim()) continue;
    const [rawAdded, rawDeleted] = line.split(/\s+/, 3);
    added += numericStat(rawAdded);
    deleted += numericStat(rawDeleted);
  }
  return { added, changed: changedFileCount, deleted };
}

async function diffPreviewForRepo(
  repoRoot: string,
  maxPatchPreviewBytes: number,
  untrackedFiles: string[],
): Promise<{ value: string; truncated: boolean }> {
  const result = await diffTextAgainstHeadBounded(repoRoot, ["--no-ext-diff"], maxPatchPreviewBytes);
  if (result.truncated) return { value: `${result.stdout.trimEnd()}\n[diff truncated]\n`, truncated: true };

  let value = result.stdout;
  for (const file of untrackedFiles) {
    const remaining = maxPatchPreviewBytes - Buffer.byteLength(value);
    if (remaining <= 0) return { value: `${value.trimEnd()}\n[diff truncated]\n`, truncated: true };
    const untracked = await untrackedFileDiff(repoRoot, file, ["--no-ext-diff"], remaining);
    value += untracked.stdout;
    if (untracked.truncated) return { value: `${value.trimEnd()}\n[diff truncated]\n`, truncated: true };
  }
  return { value, truncated: false };
}

async function diffTextAgainstHead(repoRoot: string, diffArgs: string[]): Promise<string> {
  const args = ["diff", ...diffArgs, "HEAD", "--"];
  try {
    const result = await git(repoRoot, args);
    return result.stdout;
  } catch {
    const unstaged = await git(repoRoot, ["diff", ...diffArgs, "--"]);
    const staged = await git(repoRoot, ["diff", "--cached", ...diffArgs, "--"]);
    return `${staged.stdout}${unstaged.stdout}`;
  }
}

async function diffTextAgainstHeadBounded(
  repoRoot: string,
  diffArgs: string[],
  maxBytes: number,
): Promise<{ stdout: string; truncated: boolean }> {
  const args = ["diff", ...diffArgs, "HEAD", "--"];
  try {
    return await git(repoRoot, args, { maxBytes });
  } catch {
    return git(repoRoot, ["diff", ...diffArgs, "--"], { maxBytes });
  }
}

function parseStatusLines(output: string): string[] {
  return output.split(/\r?\n/).filter((line) => line.trim().length > 0);
}

function filesFromStatus(lines: string[]): string[] {
  const files = new Set<string>();
  for (const line of lines) {
    const value = line.slice(3).trim();
    const renamed = value.includes(" -> ") ? value.split(" -> ").at(-1) : value;
    if (renamed) files.add(renamed);
  }
  return [...files].sort();
}

function untrackedFilesFromStatus(lines: string[]): string[] {
  return lines
    .filter((line) => line.startsWith("?? "))
    .map((line) => line.slice(3).trim())
    .filter(Boolean)
    .sort();
}

function numericStat(value: string | undefined): number {
  if (!value || value === "-") return 0;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : 0;
}

async function untrackedNumstat(repoRoot: string, files: string[]): Promise<string> {
  const chunks: string[] = [];
  for (const file of files) {
    const result = await untrackedFileDiff(repoRoot, file, ["--numstat"]);
    chunks.push(result.stdout);
  }
  return chunks.join("");
}

async function untrackedFileDiff(
  repoRoot: string,
  file: string,
  diffArgs: string[],
  maxBytes?: number,
): Promise<{ stdout: string; truncated: boolean }> {
  return git(repoRoot, ["diff", "--no-index", ...diffArgs, "--", "/dev/null", file], {
    allowExitCodes: [0, 1],
    ...(maxBytes ? { maxBytes } : {}),
  });
}

function boundedReason(reason: string): string {
  const maxLength = 1000;
  if (reason.length <= maxLength) return reason;
  return `${reason.slice(0, maxLength).trimEnd()}...`;
}

async function git(
  cwd: string,
  args: string[],
  options: { maxBytes?: number; allowExitCodes?: number[] } = {},
): Promise<{ stdout: string; truncated: boolean }> {
  const maxBytes = options.maxBytes ?? DEFAULT_MAX_GIT_OUTPUT_BYTES;
  const allowExitCodes = new Set([0, ...(options.allowExitCodes ?? [])]);
  return new Promise((resolve, reject) => {
    const child = spawn("git", args, { cwd, stdio: ["ignore", "pipe", "pipe"] });
    const stdoutChunks: Buffer[] = [];
    const stderrChunks: Buffer[] = [];
    let stdoutBytes = 0;
    let stderrBytes = 0;
    let truncated = false;

    child.stdout.on("data", (chunk: Buffer) => {
      if (stdoutBytes >= maxBytes) return;
      const remaining = maxBytes - stdoutBytes;
      const value = chunk.byteLength > remaining ? chunk.subarray(0, remaining) : chunk;
      stdoutChunks.push(value);
      stdoutBytes += value.byteLength;
      if (chunk.byteLength >= remaining) {
        truncated = true;
        child.kill("SIGTERM");
      }
    });

    child.stderr.on("data", (chunk: Buffer) => {
      if (stderrBytes >= DEFAULT_MAX_GIT_OUTPUT_BYTES) return;
      const remaining = DEFAULT_MAX_GIT_OUTPUT_BYTES - stderrBytes;
      const value = chunk.byteLength > remaining ? chunk.subarray(0, remaining) : chunk;
      stderrChunks.push(value);
      stderrBytes += value.byteLength;
    });

    child.on("error", reject);
    child.on("close", (code) => {
      const stdout = Buffer.concat(stdoutChunks).toString("utf8");
      const stderr = Buffer.concat(stderrChunks).toString("utf8");
      if (!allowExitCodes.has(code ?? -1) && !truncated) {
        reject(new Error(stderr.trim() || `git ${args[0]} failed with exit code ${code ?? "unknown"}.`));
        return;
      }
      resolve({ stdout, truncated });
    });
  });
}
