import { createHash } from "node:crypto";
import { open } from "node:fs/promises";
import { devNull } from "node:os";
import { posix, win32 } from "node:path";
import { TextDecoder } from "node:util";

import { spawnBoundedGit } from "./gitCommand.js";

export const DEFAULT_MAX_FULL_PATCH_BYTES = 16 * 1024 * 1024;

export const SKYTURN_VOLATILE_GIT_PATHS = [
  ".devflow/skyturn-workflow.sqlite",
  ".devflow/skyturn-workflow.sqlite-wal",
  ".devflow/skyturn-workflow.sqlite-shm",
  ".devflow/runs/**",
  ".devflow/tasks/**/output.md",
] as const;

export const SKYTURN_GIT_EVIDENCE_PATHSPECS = [
  ".",
  ...SKYTURN_VOLATILE_GIT_PATHS.map((path) => (
    path.includes("**") ? `:(top,glob,exclude)${path}` : `:(top,exclude)${path}`
  )),
] as const;

export type GitChangesetBaseline =
  | { kind: "current-head" }
  | { kind: "ref"; ref: string }
  | { kind: "committed"; baseCommit: string; headCommit: string };

export interface CollectAtomicGitChangesetSnapshotOptions {
  repoRoot: string;
  baseline: GitChangesetBaseline;
  maxPatchPreviewBytes: number;
  maxFullPatchBytes?: number;
}

export interface AtomicGitChangesetSnapshot {
  readonly baselineCommit: string;
  readonly headCommit: string | null;
  readonly files: string[];
  readonly diffStat: {
    added: number;
    changed: number;
    deleted: number;
  };
  readonly fullPatch: Buffer;
  readonly patchPreview: string;
  readonly previewTruncated: boolean;
  readonly fullPatchSha256: string | null;
  readonly fullPatchByteLength: number;
  readonly fileManifestSha256: string | null;
}

interface CompleteGitChangesetSnapshot extends AtomicGitChangesetSnapshot {
  readonly liveHeadCommit: string | null;
  readonly headAuthority: Buffer[];
  readonly baselineAuthority: Buffer[];
  readonly statusRaw: Buffer;
  readonly unmergedRaw: Buffer;
  readonly untrackedRaw: Buffer;
  readonly infoAttributesAuthority: Buffer;
  readonly numstatSections: Buffer[];
  readonly patchSections: Buffer[];
}

interface LiveHeadResolution {
  readonly commit: string | null;
  readonly emptyTree: string | null;
  readonly authority: Buffer[];
}

interface BaselineResolution {
  readonly baselineCommit: string;
  readonly headCommit: string | null;
  readonly authority: Buffer[];
}

interface GitCommandResult {
  readonly stdout: Buffer;
  readonly exitCode: number;
}

interface GitCommandOptions {
  readonly stdoutMaxBytes?: number;
  readonly allowedExitCodes?: readonly number[];
  readonly fullPatchOutput?: boolean;
}

interface NumstatFacts {
  readonly added: number;
  readonly deleted: number;
  readonly files: string[];
}

interface DiffSection {
  readonly numstat: Buffer;
  readonly patchArgs: string[];
  readonly allowedExitCodes: readonly number[];
  readonly expectedUntrackedFile?: string;
}

const metadataMaxBytes = 16 * 1024 * 1024;
const stderrMaxBytes = 1024 * 1024;
const utf8Decoder = new TextDecoder("utf-8", { fatal: true });
const manifestVersion = Buffer.from("skyturn-git-file-manifest-v1", "utf8");
const unmergedStatusCodes = new Set(["DD", "AU", "UD", "UA", "DU", "AA", "UU"]);
const canonicalObjectIdPattern = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/;
const nullDeviceAliases = new Set(
  process.platform === "win32" ? [devNull, "/dev/null", "NUL", "nul"] : [devNull],
);

const deterministicGitConfig = [
  "--no-optional-locks",
  "-c", `core.attributesFile=${devNull}`,
  "-c", "core.bigFileThreshold=512m",
  "-c", "core.checkStat=default",
  "-c", `core.excludesFile=${devNull}`,
  "-c", `core.fileMode=${process.platform === "win32" ? "false" : "true"}`,
  "-c", "core.fsmonitor=false",
  "-c", "core.ignoreStat=false",
  "-c", "core.quotePath=false",
  "-c", "core.trustctime=true",
  "-c", "core.untrackedCache=false",
  "-c", "color.ui=false",
  "-c", "diff.algorithm=myers",
  "-c", "diff.colorMoved=false",
  "-c", "diff.external=",
  "-c", "diff.ignoreSubmodules=none",
  "-c", "diff.indentHeuristic=false",
  "-c", "diff.mnemonicPrefix=false",
  "-c", "diff.noprefix=false",
  "-c", `diff.orderFile=${devNull}`,
  "-c", "diff.renames=false",
  "-c", "diff.submodule=short",
  "-c", "diff.suppressBlankEmpty=false",
  "-c", "status.renames=false",
] as const;

const canonicalDiffBehaviorFlags = [
  "--no-renames",
  "--no-ext-diff",
  "--no-textconv",
  "--no-color",
  "--no-relative",
  "--no-indent-heuristic",
  "--diff-algorithm=myers",
  "--inter-hunk-context=0",
  `-O${devNull}`,
  "--ignore-submodules=none",
  "--submodule=short",
] as const;

const canonicalPatchFlags = [
  "--binary",
  "--full-index",
  ...canonicalDiffBehaviorFlags,
  "--unified=3",
  "--output-indicator-new=+",
  "--output-indicator-old=-",
  "--output-indicator-context= ",
  "--src-prefix=a/",
  "--dst-prefix=b/",
] as const;

const canonicalNumstatFlags = [
  "--numstat",
  "-z",
  ...canonicalDiffBehaviorFlags,
] as const;

export async function collectAtomicGitChangesetSnapshot(
  options: CollectAtomicGitChangesetSnapshotOptions,
): Promise<AtomicGitChangesetSnapshot> {
  assertPositiveSafeInteger(options.maxPatchPreviewBytes, "maxPatchPreviewBytes");
  const maxFullPatchBytes = options.maxFullPatchBytes ?? DEFAULT_MAX_FULL_PATCH_BYTES;
  assertPositiveSafeInteger(maxFullPatchBytes, "maxFullPatchBytes");
  validateBaseline(options.baseline);

  const normalizedOptions = { ...options, maxFullPatchBytes };
  const first = await collectCompleteSnapshot(normalizedOptions);
  const second = await collectCompleteSnapshot(normalizedOptions);
  assertCompleteSnapshotsEqual(first, second);
  return publicSnapshot(second);
}

async function collectCompleteSnapshot(
  options: CollectAtomicGitChangesetSnapshotOptions & { maxFullPatchBytes: number },
): Promise<CompleteGitChangesetSnapshot> {
  const liveHead = await resolveLiveHead(options.repoRoot);
  const baseline = await resolveBaseline(options.repoRoot, options.baseline, liveHead);
  const infoAttributesAuthority = await verifyInfoAttributesAuthority(options.repoRoot);
  const statusRaw = (await runGit(options.repoRoot, [
    ...deterministicGitConfig,
    "status",
    "--porcelain=v1",
    "-z",
    "--untracked-files=no",
    "--no-renames",
    "--ignore-submodules=none",
    "--",
    ...SKYTURN_GIT_EVIDENCE_PATHSPECS,
  ])).stdout;
  validateStatusPaths(statusRaw);

  const unmergedRaw = (await runGit(options.repoRoot, [
    ...deterministicGitConfig,
    "ls-files",
    "--unmerged",
    "-z",
    "--",
    ...SKYTURN_GIT_EVIDENCE_PATHSPECS,
  ])).stdout;
  validateUnmergedPaths(unmergedRaw);
  if (unmergedRaw.byteLength > 0) {
    throw new Error("Git changeset contains unmerged conflict entries.");
  }

  const untrackedRaw = (await runGit(options.repoRoot, [
    ...deterministicGitConfig,
    "ls-files",
    "--others",
    "--exclude-per-directory=.gitignore",
    "-z",
    "--",
    ...SKYTURN_GIT_EVIDENCE_PATHSPECS,
  ])).stdout;
  const untrackedFiles = parsePathList(untrackedRaw).sort(compareUtf8);

  if (options.baseline.kind === "committed") {
    if (statusRaw.byteLength > 0 || untrackedRaw.byteLength > 0) {
      throw new Error("Committed variant changeset requires a clean worktree.");
    }
    if (liveHead.commit !== baseline.headCommit) {
      throw new Error("Committed variant worktree HEAD differs from the recorded head commit.");
    }
  }

  const sectionArgs = trackedSectionArguments(options.baseline, baseline);
  const sections: DiffSection[] = [];
  for (const args of sectionArgs) {
    const numstat = (await runGit(options.repoRoot, [
      ...deterministicGitConfig,
      "diff",
      ...canonicalNumstatFlags,
      ...args,
      "--",
      ...SKYTURN_GIT_EVIDENCE_PATHSPECS,
    ])).stdout;
    sections.push({
      numstat,
      patchArgs: [
        ...deterministicGitConfig,
        "diff",
        ...canonicalPatchFlags,
        ...args,
        "--",
        ...SKYTURN_GIT_EVIDENCE_PATHSPECS,
      ],
      allowedExitCodes: [0],
    });
  }

  if (options.baseline.kind !== "committed") {
    for (const file of untrackedFiles) {
      const numstat = (await runGit(options.repoRoot, [
        ...deterministicGitConfig,
        "diff",
        "--no-index",
        ...canonicalNumstatFlags,
        "--",
        devNull,
        file,
      ], { allowedExitCodes: [0, 1] })).stdout;
      sections.push({
        numstat,
        patchArgs: [
          ...deterministicGitConfig,
          "diff",
          "--no-index",
          ...canonicalPatchFlags,
          "--",
          devNull,
          file,
        ],
        allowedExitCodes: [0, 1],
        expectedUntrackedFile: file,
      });
    }
  }

  const numstatSections = sections.map((section) => section.numstat);
  const patchSections: Buffer[] = [];
  let retainedPatchBytes = 0;

  for (const section of sections) {
    const patch = section.numstat.byteLength === 0
      ? Buffer.alloc(0)
      : await collectPatchSection(
          options.repoRoot,
          section.patchArgs,
          options.maxFullPatchBytes - retainedPatchBytes,
          section.allowedExitCodes,
        );
    assertSectionSemantics(section.numstat, patch);
    retainedPatchBytes += patch.byteLength;
    patchSections.push(patch);
  }

  const numstatFacts = sections.map((section) => (
    parseNumstat(section.numstat, section.expectedUntrackedFile)
  ));
  const files = canonicalFiles(numstatFacts.flatMap((facts) => facts.files));
  const diffStat = {
    added: safeTotal(numstatFacts.map((facts) => facts.added), "added line total"),
    changed: files.length,
    deleted: safeTotal(numstatFacts.map((facts) => facts.deleted), "deleted line total"),
  };
  const fullPatch = Buffer.concat(patchSections, retainedPatchBytes);
  if ((files.length === 0) !== (fullPatch.byteLength === 0)) {
    throw new Error("Git changeset patch and file manifest disagree.");
  }
  const preview = derivePatchPreview(fullPatch, options.maxPatchPreviewBytes);
  const available = files.length > 0 && fullPatch.byteLength > 0;

  return {
    baselineCommit: baseline.baselineCommit,
    headCommit: baseline.headCommit,
    liveHeadCommit: liveHead.commit,
    files,
    diffStat,
    fullPatch,
    patchPreview: preview.value,
    previewTruncated: preview.truncated,
    fullPatchSha256: available ? sha256(fullPatch) : null,
    fullPatchByteLength: fullPatch.byteLength,
    fileManifestSha256: available ? hashFileManifest(files) : null,
    headAuthority: liveHead.authority,
    baselineAuthority: baseline.authority,
    statusRaw,
    unmergedRaw,
    untrackedRaw,
    infoAttributesAuthority,
    numstatSections,
    patchSections,
  };
}

async function resolveLiveHead(repoRoot: string): Promise<LiveHeadResolution> {
  const head = await runGit(repoRoot, [
    ...deterministicGitConfig,
    "rev-parse",
    "--verify",
    "--quiet",
    "--end-of-options",
    "HEAD^{commit}",
  ], { allowedExitCodes: [0, 1] });
  if (head.exitCode === 0) {
    return { commit: parseCommit(head.stdout, "HEAD"), emptyTree: null, authority: [head.stdout] };
  }

  const symbolic = await runGit(repoRoot, [
    ...deterministicGitConfig,
    "symbolic-ref",
    "--quiet",
    "HEAD",
  ], { allowedExitCodes: [0, 1] });
  if (symbolic.exitCode !== 0) throw new Error("Git HEAD does not resolve to a commit or unborn branch.");
  const symbolicRef = decodeLine(symbolic.stdout, "symbolic HEAD");
  if (!symbolicRef.startsWith("refs/heads/")) throw new Error("Git unborn HEAD is not a branch reference.");
  const existingRef = await runGit(repoRoot, [
    ...deterministicGitConfig,
    "show-ref",
    "--verify",
    "--quiet",
    symbolicRef,
  ], { allowedExitCodes: [0, 1] });
  if (existingRef.exitCode === 0) throw new Error("Git HEAD reference exists but does not resolve to a commit.");
  const emptyTree = await runGit(repoRoot, [
    ...deterministicGitConfig,
    "hash-object",
    "-t",
    "tree",
    "--stdin",
  ]);
  return {
    commit: null,
    emptyTree: parseCommit(emptyTree.stdout, "empty tree"),
    authority: [head.stdout, symbolic.stdout, existingRef.stdout, emptyTree.stdout],
  };
}

async function resolveBaseline(
  repoRoot: string,
  input: GitChangesetBaseline,
  liveHead: LiveHeadResolution,
): Promise<BaselineResolution> {
  if (input.kind === "current-head") {
    return {
      baselineCommit: liveHead.commit ?? requireEmptyTree(liveHead),
      headCommit: liveHead.commit,
      authority: [],
    };
  }
  if (input.kind === "ref") {
    const resolved = await resolveCommit(repoRoot, input.ref, "baseline ref");
    return {
      baselineCommit: resolved.commit,
      headCommit: liveHead.commit,
      authority: [resolved.raw],
    };
  }
  const base = await resolveCommit(repoRoot, input.baseCommit, "recorded base commit");
  const head = await resolveCommit(repoRoot, input.headCommit, "recorded head commit");
  assertExactResolvedCommit(base.commit, input.baseCommit, "recorded base commit");
  assertExactResolvedCommit(head.commit, input.headCommit, "recorded head commit");
  return {
    baselineCommit: base.commit,
    headCommit: head.commit,
    authority: [base.raw, head.raw],
  };
}

async function resolveCommit(
  repoRoot: string,
  ref: string,
  label: string,
): Promise<{ commit: string; raw: Buffer }> {
  validateRef(ref, label);
  try {
    const result = await runGit(repoRoot, [
      ...deterministicGitConfig,
      "rev-parse",
      "--verify",
      "--end-of-options",
      `${ref}^{commit}`,
    ]);
    return { commit: parseCommit(result.stdout, label), raw: result.stdout };
  } catch (error) {
    const reason = error instanceof Error ? error.message : "Git ref resolution failed.";
    throw new Error(`${label} does not resolve: ${ref}: ${reason}`);
  }
}

async function verifyInfoAttributesAuthority(repoRoot: string): Promise<Buffer> {
  const resolved = await runGit(repoRoot, [
    ...deterministicGitConfig,
    "rev-parse",
    "--path-format=absolute",
    "--git-path",
    "info/attributes",
  ]);
  const attributesPath = decodeLine(resolved.stdout, "Git info attributes path");
  if (
    attributesPath.includes("\0")
    || (!posix.isAbsolute(attributesPath) && !win32.isAbsolute(attributesPath))
  ) {
    throw new Error("Git local attributes authority could not be verified.");
  }

  let handle: Awaited<ReturnType<typeof open>>;
  try {
    handle = await open(attributesPath, "r");
  } catch (error) {
    if (isErrnoCode(error, "ENOENT")) {
      return Buffer.concat([frame(resolved.stdout), Buffer.from([0])]);
    }
    throw new Error("Git local attributes authority could not be verified.");
  }

  let bytesRead = 0;
  let closeFailed = false;
  try {
    bytesRead = (await handle.read(Buffer.alloc(1), 0, 1, 0)).bytesRead;
  } catch {
    throw new Error("Git local attributes authority could not be verified.");
  } finally {
    try {
      await handle.close();
    } catch {
      closeFailed = true;
    }
  }
  if (closeFailed) throw new Error("Git local attributes authority could not be verified.");
  if (bytesRead > 0) {
    throw new Error("Git local attributes must be absent or empty for canonical changeset evidence.");
  }
  return Buffer.concat([frame(resolved.stdout), Buffer.from([1])]);
}

function trackedSectionArguments(
  input: GitChangesetBaseline,
  baseline: BaselineResolution,
): string[][] {
  if (input.kind === "committed") return [[baseline.baselineCommit, requireHead(baseline)]];
  if (baseline.headCommit === null) {
    return [
      ["--cached", baseline.baselineCommit],
      [],
    ];
  }
  return [[baseline.baselineCommit]];
}

async function collectPatchSection(
  repoRoot: string,
  args: string[],
  remainingBytes: number,
  allowedExitCodes: readonly number[],
): Promise<Buffer> {
  if (remainingBytes <= 0) throw new Error("Git changeset full patch exceeded the configured byte limit.");
  return (await runGit(repoRoot, args, {
    stdoutMaxBytes: remainingBytes,
    allowedExitCodes,
    fullPatchOutput: true,
  })).stdout;
}

function assertSectionSemantics(numstat: Buffer, patch: Buffer): void {
  if ((numstat.byteLength === 0) !== (patch.byteLength === 0)) {
    throw new Error("Git changeset section numstat and patch disagree.");
  }
}

async function runGit(
  cwd: string,
  args: readonly string[],
  options: GitCommandOptions = {},
): Promise<GitCommandResult> {
  const allowedExitCodes = new Set(options.allowedExitCodes ?? [0]);
  const result = await spawnBoundedGit(cwd, args, {
    stdoutMaxBytes: options.stdoutMaxBytes ?? metadataMaxBytes,
    stderrMaxBytes,
  });
  if (result.spawnError) throw new Error(result.spawnError.message || "Git command failed to spawn.");
  if (result.terminationError) {
    throw new Error(result.terminationError.message || "Git command failed to terminate after output overflow.");
  }
  if (result.stderrTruncated) throw new Error("Git command stderr exceeded the metadata byte limit.");
  if (result.stdoutTruncated) {
    throw new Error(options.fullPatchOutput
      ? "Git changeset full patch exceeded the configured byte limit."
      : "Git changeset metadata exceeded the configured byte limit.");
  }
  const exitCode = result.exitCode ?? -1;
  if (!allowedExitCodes.has(exitCode)) {
    throw new Error(result.stderr.toString("utf8").trim() || `Git command failed with exit code ${exitCode}.`);
  }
  return { stdout: result.stdout, exitCode };
}

function parseNumstat(raw: Buffer, expectedUntrackedFile?: string): NumstatFacts {
  const records = splitNul(raw, "Git numstat");
  const files: string[] = [];
  let added = 0;
  let deleted = 0;
  for (let index = 0; index < records.length; index += 1) {
    const record = records[index]!;
    const firstTab = record.indexOf(0x09);
    const secondTab = firstTab < 0 ? -1 : record.indexOf(0x09, firstTab + 1);
    if (firstTab <= 0 || secondTab <= firstTab + 1) throw new Error("Git numstat record is malformed.");
    added = addSafe(added, parseStat(record.subarray(0, firstTab)), "added line total");
    deleted = addSafe(deleted, parseStat(record.subarray(firstTab + 1, secondTab)), "deleted line total");
    const pathBytes = record.subarray(secondTab + 1);
    let file: string;
    if (pathBytes.byteLength > 0) {
      file = decodeGitPath(pathBytes);
    } else {
      const oldPath = records[index + 1];
      const newPath = records[index + 2];
      if (!oldPath || !newPath) throw new Error("Git numstat path pair is incomplete.");
      const decodedOldPath = decodeUtf8(oldPath, "Git numstat source path");
      if (!nullDeviceAliases.has(decodedOldPath)) throw new Error("Git numstat source path is not the null device.");
      file = decodeGitPath(newPath);
      index += 2;
    }
    if (expectedUntrackedFile !== undefined && file !== expectedUntrackedFile) {
      throw new Error("Git untracked numstat path differs from its declared path.");
    }
    files.push(file);
  }
  return { added, deleted, files };
}

function parseStat(raw: Buffer): number {
  if (raw.byteLength === 1 && raw[0] === 0x2d) return 0;
  if (raw.byteLength === 0) throw new Error("Git numstat count is empty.");
  for (const byte of raw) {
    if (byte < 0x30 || byte > 0x39) throw new Error("Git numstat count is invalid.");
  }
  const value = Number(raw.toString("ascii"));
  if (!Number.isSafeInteger(value) || value < 0) throw new Error("Git numstat count exceeds the safe range.");
  return value;
}

function validateStatusPaths(raw: Buffer): void {
  for (const record of splitNul(raw, "Git status")) {
    if (record.byteLength < 4 || record[2] !== 0x20) throw new Error("Git status record is malformed.");
    const status = record.subarray(0, 2).toString("ascii");
    if (unmergedStatusCodes.has(status)) throw new Error("Git changeset contains unmerged conflict entries.");
    decodeGitPath(record.subarray(3));
  }
}

function validateUnmergedPaths(raw: Buffer): void {
  for (const record of splitNul(raw, "Git unmerged index")) {
    const tab = record.indexOf(0x09);
    if (tab <= 0 || tab === record.byteLength - 1) throw new Error("Git unmerged index record is malformed.");
    decodeGitPath(record.subarray(tab + 1));
  }
}

function parsePathList(raw: Buffer): string[] {
  const paths = splitNul(raw, "Git path list").map(decodeGitPath);
  const canonical = canonicalFiles(paths);
  if (canonical.length !== paths.length) throw new Error("Git path list contains duplicate entries.");
  return canonical;
}

function splitNul(raw: Buffer, label: string): Buffer[] {
  if (raw.byteLength === 0) return [];
  if (raw[raw.byteLength - 1] !== 0) throw new Error(`${label} is not NUL terminated.`);
  const records: Buffer[] = [];
  let start = 0;
  for (let index = 0; index < raw.byteLength; index += 1) {
    if (raw[index] !== 0) continue;
    records.push(raw.subarray(start, index));
    start = index + 1;
  }
  return records;
}

function decodeGitPath(raw: Buffer): string {
  const path = decodeUtf8(raw, "Git path");
  if (
    path.length === 0
    || path.includes("\0")
    || posix.isAbsolute(path)
    || win32.isAbsolute(path)
    || path.split("/").some((part) => part === "" || part === "." || part === "..")
  ) {
    throw new Error("Git path must be a safe repository-relative path.");
  }
  return path;
}

function decodeUtf8(raw: Buffer, label: string): string {
  try {
    return utf8Decoder.decode(raw);
  } catch {
    throw new Error(`${label} is not valid UTF-8.`);
  }
}

function decodeLine(raw: Buffer, label: string): string {
  const value = decodeUtf8(raw, label);
  if (!value.endsWith("\n") || value.slice(0, -1).includes("\n") || value.includes("\r")) {
    throw new Error(`${label} output is malformed.`);
  }
  return value.slice(0, -1);
}

function parseCommit(raw: Buffer, label: string): string {
  const value = decodeLine(raw, label);
  if (!canonicalObjectIdPattern.test(value)) throw new Error(`${label} is not a canonical commit object ID.`);
  return value;
}

function canonicalFiles(files: string[]): string[] {
  return [...new Set(files)].sort(compareUtf8);
}

function compareUtf8(left: string, right: string): number {
  return Buffer.compare(Buffer.from(left, "utf8"), Buffer.from(right, "utf8"));
}

function derivePatchPreview(fullPatch: Buffer, maxBytes: number): { value: string; truncated: boolean } {
  if (fullPatch.byteLength <= maxBytes) return { value: fullPatch.toString("utf8"), truncated: false };
  const prefix = fullPatch.subarray(0, maxBytes).toString("utf8").trimEnd();
  return { value: `${prefix}\n[diff truncated]\n`, truncated: true };
}

function hashFileManifest(files: string[]): string {
  return sha256(Buffer.concat([
    frame(manifestVersion),
    ...files.map((file) => frame(Buffer.from(file, "utf8"))),
  ]));
}

function frame(value: Buffer): Buffer {
  const length = Buffer.alloc(8);
  length.writeBigUInt64BE(BigInt(value.byteLength));
  return Buffer.concat([length, value]);
}

function sha256(value: Buffer): string {
  return createHash("sha256").update(value).digest("hex");
}

function safeTotal(values: number[], label: string): number {
  return values.reduce((total, value) => addSafe(total, value, label), 0);
}

function addSafe(left: number, right: number, label: string): number {
  const total = left + right;
  if (!Number.isSafeInteger(total)) throw new Error(`Git changeset ${label} exceeds the safe range.`);
  return total;
}

function assertCompleteSnapshotsEqual(
  first: CompleteGitChangesetSnapshot,
  second: CompleteGitChangesetSnapshot,
): void {
  const scalarEqual = first.baselineCommit === second.baselineCommit
    && first.headCommit === second.headCommit
    && first.liveHeadCommit === second.liveHeadCommit
    && first.patchPreview === second.patchPreview
    && first.previewTruncated === second.previewTruncated
    && first.fullPatchSha256 === second.fullPatchSha256
    && first.fullPatchByteLength === second.fullPatchByteLength
    && first.fileManifestSha256 === second.fileManifestSha256
    && first.diffStat.added === second.diffStat.added
    && first.diffStat.changed === second.diffStat.changed
    && first.diffStat.deleted === second.diffStat.deleted
    && sameStrings(first.files, second.files);
  const buffersEqual = first.fullPatch.equals(second.fullPatch)
    && first.statusRaw.equals(second.statusRaw)
    && first.unmergedRaw.equals(second.unmergedRaw)
    && first.untrackedRaw.equals(second.untrackedRaw)
    && first.infoAttributesAuthority.equals(second.infoAttributesAuthority)
    && sameBuffers(first.headAuthority, second.headAuthority)
    && sameBuffers(first.baselineAuthority, second.baselineAuthority)
    && sameBuffers(first.numstatSections, second.numstatSections)
    && sameBuffers(first.patchSections, second.patchSections);
  if (!scalarEqual || !buffersEqual) {
    throw new Error("Git changeset changed between atomic snapshots.");
  }
}

function sameStrings(left: string[], right: string[]): boolean {
  return left.length === right.length && left.every((value, index) => value === right[index]);
}

function sameBuffers(left: Buffer[], right: Buffer[]): boolean {
  return left.length === right.length && left.every((value, index) => value.equals(right[index]!));
}

function publicSnapshot(snapshot: CompleteGitChangesetSnapshot): AtomicGitChangesetSnapshot {
  return {
    baselineCommit: snapshot.baselineCommit,
    headCommit: snapshot.headCommit,
    files: [...snapshot.files],
    diffStat: { ...snapshot.diffStat },
    fullPatch: Buffer.from(snapshot.fullPatch),
    patchPreview: snapshot.patchPreview,
    previewTruncated: snapshot.previewTruncated,
    fullPatchSha256: snapshot.fullPatchSha256,
    fullPatchByteLength: snapshot.fullPatchByteLength,
    fileManifestSha256: snapshot.fileManifestSha256,
  };
}

function validateBaseline(baseline: GitChangesetBaseline): void {
  if (baseline.kind === "ref") validateRef(baseline.ref, "baseline ref");
  if (baseline.kind === "committed") {
    validateCanonicalObjectId(baseline.baseCommit, "recorded base commit");
    validateCanonicalObjectId(baseline.headCommit, "recorded head commit");
  }
}

function validateCanonicalObjectId(value: string, label: string): void {
  if (!canonicalObjectIdPattern.test(value)) {
    throw new Error(`${label} must be an exact lowercase full commit object ID.`);
  }
}

function assertExactResolvedCommit(resolved: string, expected: string, label: string): void {
  if (resolved !== expected) throw new Error(`${label} did not resolve to its exact object ID.`);
}

function validateRef(ref: string, label: string): void {
  if (!ref || ref.startsWith("-") || /[\0\r\n]/.test(ref)) throw new Error(`${label} is invalid.`);
}

function assertPositiveSafeInteger(value: number, label: string): void {
  if (!Number.isSafeInteger(value) || value <= 0) throw new TypeError(`${label} must be a positive safe integer.`);
}

function isErrnoCode(error: unknown, code: string): boolean {
  return typeof error === "object" && error !== null && "code" in error && error.code === code;
}

function requireEmptyTree(head: LiveHeadResolution): string {
  if (!head.emptyTree) throw new Error("Git unborn repository empty tree was not resolved.");
  return head.emptyTree;
}

function requireHead(baseline: BaselineResolution): string {
  if (!baseline.headCommit) throw new Error("Committed changeset head commit was not resolved.");
  return baseline.headCommit;
}
