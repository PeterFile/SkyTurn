import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { devNull } from "node:os";
import { isAbsolute } from "node:path";
import { TextDecoder } from "node:util";

const manifestMagic = Buffer.from("skyturn-git-changeset-manifest-v1\0", "ascii");
const utf8Decoder = new TextDecoder("utf-8", { fatal: true });
const canonicalDiffConfig = [
  "-c",
  "color.ui=false",
  "-c",
  `core.attributesFile=${devNull}`,
  "-c",
  "core.bigFileThreshold=512m",
  "-c",
  "core.quotePath=true",
  "-c",
  "diff.context=3",
  "-c",
  "diff.interHunkContext=0",
  "-c",
  "diff.outputIndicatorNew=+",
  "-c",
  "diff.outputIndicatorOld=-",
  "-c",
  "diff.outputIndicatorContext= ",
  "-c",
  "diff.suppressBlankEmpty=false",
  "-c",
  "diff.autoRefreshIndex=false",
  "-c",
  "diff.compactionHeuristic=false",
  "-c",
  "diff.mnemonicPrefix=false",
  "-c",
  "diff.noPrefix=false",
  "-c",
  "diff.srcPrefix=a/",
  "-c",
  "diff.dstPrefix=b/",
  "-c",
  "diff.relative=false",
  "-c",
  "diff.submodule=short",
  "-c",
  "diff.ignoreSubmodules=none",
  "-c",
  "diff.renames=true",
  "-c",
  "diff.algorithm=myers",
  "-c",
  "diff.indentHeuristic=false",
  "-c",
  "diff.renameLimit=0",
] as const;
const canonicalDiffArgs = [
  "--binary",
  "--full-index",
  "--unified=3",
  "--inter-hunk-context=0",
  "--output-indicator-new=+",
  "--output-indicator-old=-",
  "--output-indicator-context= ",
  "--no-color",
  "--no-ext-diff",
  "--no-textconv",
  "--no-relative",
  "--line-prefix=",
  "--submodule=short",
  "--ignore-submodules=none",
  "--find-renames=50%",
  "--diff-algorithm=myers",
  "--no-indent-heuristic",
  "--src-prefix=a/",
  "--dst-prefix=b/",
  `-O${devNull}`,
] as const;
const commitPattern = /^[0-9a-f]{40}(?:[0-9a-f]{24})?$/;

export interface FullPatchEvidenceFields {
  fullPatchSha256: string;
  fullPatchByteLength: number;
  fileManifestSha256: string;
}

export interface StableGitChangesetSnapshot {
  files: string[];
  untrackedFiles: string[];
  baselineCommit: string | null;
  fullPatchEvidence?: FullPatchEvidenceFields;
}

interface SnapshotOptionsBase {
  repoRoot: string;
  pathspecs: readonly string[];
  maxFullPatchBytes: number;
  maxDiscoveryBytes: number;
}

export type GitChangesetSnapshotOptions = SnapshotOptionsBase & (
  | {
    mode: "live";
    baselineRef?: string;
    allowUnbornHead: boolean;
  }
  | {
    mode: "recorded";
    baseCommit: string;
    headCommit: string;
  }
);

type ChangeLayer = "committed" | "staged" | "unstaged" | "untracked";

interface ChangeRecord {
  layer: ChangeLayer;
  status: string;
  pathBytes: Buffer[];
  paths: string[];
  untracked: boolean;
}

interface CanonicalSnapshot {
  headBefore: string | null;
  headAfter: string | null;
  baselineCommit: string | null;
  files: string[];
  untrackedFiles: string[];
  manifest: Buffer;
  patch: Buffer | null;
}

interface RawGitResult {
  stdout: Buffer;
  stderr: Buffer;
  exitCode: number;
  stdoutOverflow: boolean;
  stderrOverflow: boolean;
}

export async function collectStableGitChangesetSnapshot(
  options: GitChangesetSnapshotOptions,
): Promise<StableGitChangesetSnapshot> {
  assertPositiveSafeInteger(options.maxFullPatchBytes, "full patch limit");
  assertPositiveSafeInteger(options.maxDiscoveryBytes, "Git discovery limit");
  const first = await collectCanonicalSnapshot(options);
  const second = await collectCanonicalSnapshot(options);
  const result: StableGitChangesetSnapshot = {
    files: [...second.files],
    untrackedFiles: [...second.untrackedFiles],
    baselineCommit: second.baselineCommit,
  };
  if (!completeSnapshotsMatch(first, second)) return result;
  if (second.files.length === 0 || !second.patch || second.patch.byteLength === 0) return result;
  return {
    ...result,
    fullPatchEvidence: {
      fullPatchSha256: sha256(second.patch),
      fullPatchByteLength: second.patch.byteLength,
      fileManifestSha256: sha256(second.manifest),
    },
  };
}

async function collectCanonicalSnapshot(
  options: GitChangesetSnapshotOptions,
): Promise<CanonicalSnapshot> {
  const headBefore = await readExactHead(options.repoRoot, options.maxDiscoveryBytes);
  if (options.mode === "recorded" && headBefore !== options.headCommit) {
    throw new Error("Recorded worktree HEAD does not match the live Git HEAD.");
  }
  const baselineCommit = await resolveBaselineCommit(options, headBefore);
  const records = await discoverChangeRecords(options, baselineCommit, headBefore);
  const manifest = frameManifest(records);
  const patch = await collectCanonicalPatch(options, baselineCommit, headBefore, records);
  const headAfter = await readExactHead(options.repoRoot, options.maxDiscoveryBytes);
  if (options.mode === "recorded" && headAfter !== options.headCommit) {
    throw new Error("Recorded worktree HEAD changed during changeset collection.");
  }
  return {
    headBefore,
    headAfter,
    baselineCommit,
    files: filesFromRecords(records),
    untrackedFiles: records.filter((record) => record.untracked).map((record) => record.paths[0] as string),
    manifest,
    patch,
  };
}

async function resolveBaselineCommit(
  options: GitChangesetSnapshotOptions,
  headCommit: string | null,
): Promise<string | null> {
  if (options.mode === "recorded") {
    assertCommitIdentity(options.baseCommit, "recorded base commit");
    assertCommitIdentity(options.headCommit, "recorded head commit");
    const baseCommit = await resolveCommit(options.repoRoot, options.baseCommit, options.maxDiscoveryBytes);
    const recordedHead = await resolveCommit(options.repoRoot, options.headCommit, options.maxDiscoveryBytes);
    if (baseCommit !== options.baseCommit || recordedHead !== options.headCommit) {
      throw new Error("Recorded changeset commits did not resolve to their exact identities.");
    }
    return baseCommit;
  }
  if (options.baselineRef !== undefined) {
    return resolveCommit(options.repoRoot, options.baselineRef, options.maxDiscoveryBytes);
  }
  if (headCommit !== null) return headCommit;
  if (!options.allowUnbornHead) throw new Error("Git HEAD does not identify a commit.");
  return readCanonicalEmptyTreeObject(options.repoRoot, options.maxDiscoveryBytes);
}

async function discoverChangeRecords(
  options: GitChangesetSnapshotOptions,
  baselineCommit: string | null,
  headCommit: string | null,
): Promise<ChangeRecord[]> {
  if (options.mode === "recorded") {
    if (baselineCommit === null || headCommit === null) {
      throw new Error("Recorded changeset commit identity was unavailable.");
    }
    return sortRecords(await discoverDiffRecords(
      options,
      "committed",
      [baselineCommit, headCommit],
    ));
  }
  const records: ChangeRecord[] = [];
  if (baselineCommit !== null && headCommit !== null) {
    records.push(...await discoverDiffRecords(options, "committed", [baselineCommit, headCommit]));
  }
  records.push(...await discoverDiffRecords(
    options,
    "staged",
    headCommit === null ? ["--cached", "--root"] : ["--cached", headCommit],
  ));
  records.push(...await discoverDiffRecords(options, "unstaged", []));
  const untracked = await discoverUntrackedRecords(options);
  return sortRecords([...records, ...untracked]);
}

async function discoverDiffRecords(
  options: SnapshotOptionsBase,
  layer: Exclude<ChangeLayer, "untracked">,
  revisionArgs: string[],
): Promise<ChangeRecord[]> {
  const result = await runGitRaw(options.repoRoot, [
    ...canonicalDiffConfig,
    "diff",
    "--name-status",
    "-z",
    "--no-ext-diff",
    "--no-textconv",
    "--no-relative",
    "--submodule=short",
    "--ignore-submodules=none",
    "--find-renames=50%",
    "--diff-algorithm=myers",
    "--no-indent-heuristic",
    `-O${devNull}`,
    ...revisionArgs,
    "--",
    ...options.pathspecs,
  ], {
    maxStdoutBytes: options.maxDiscoveryBytes,
  });
  assertSuccessfulCompleteOutput(result, `Git ${layer} file discovery`);
  return parseNameStatus(result.stdout, layer);
}

async function discoverUntrackedRecords(
  options: SnapshotOptionsBase,
): Promise<ChangeRecord[]> {
  const listed = await runGitRaw(options.repoRoot, [
    "ls-files",
    "--others",
    "--exclude-standard",
    "-z",
    "--",
    ...options.pathspecs,
  ], {
    maxStdoutBytes: options.maxDiscoveryBytes,
  });
  assertSuccessfulCompleteOutput(listed, "Git untracked-file discovery");
  return parseNulPaths(listed.stdout, "Git untracked-file discovery").map((path) => ({
    layer: "untracked",
    status: "A",
    pathBytes: [path.bytes],
    paths: [path.text],
    untracked: true,
  }));
}

async function collectCanonicalPatch(
  options: GitChangesetSnapshotOptions,
  baselineCommit: string | null,
  headCommit: string | null,
  records: ChangeRecord[],
): Promise<Buffer | null> {
  const chunks: Buffer[] = [];
  let byteLength = 0;
  const trackedLayers: Array<{ label: string; revisionArgs: string[] }> = [];
  if (options.mode === "recorded") {
    if (baselineCommit === null || headCommit === null) {
      throw new Error("Recorded changeset commit identity was unavailable.");
    }
    trackedLayers.push({ label: "committed", revisionArgs: [baselineCommit, headCommit] });
  } else {
    if (baselineCommit !== null && headCommit !== null) {
      trackedLayers.push({ label: "committed", revisionArgs: [baselineCommit, headCommit] });
    }
    trackedLayers.push({
      label: "staged",
      revisionArgs: headCommit === null ? ["--cached", "--root"] : ["--cached", headCommit],
    });
    trackedLayers.push({ label: "unstaged", revisionArgs: [] });
  }
  for (const layer of trackedLayers) {
    const remaining = options.maxFullPatchBytes - byteLength;
    if (remaining <= 0) return null;
    const patch = await collectTrackedPatch(options, layer.label, layer.revisionArgs, remaining);
    if (patch === null) return null;
    chunks.push(patch);
    byteLength += patch.byteLength;
  }
  for (const record of records) {
    if (!record.untracked) continue;
    const path = record.paths[0];
    if (!path) throw new Error("Canonical Git patch contained an empty untracked path.");
    const remaining = options.maxFullPatchBytes - byteLength;
    if (remaining <= 0) return null;
    const untracked = await runGitRaw(options.repoRoot, [
      ...canonicalDiffConfig,
      "diff",
      "--no-index",
      ...canonicalDiffArgs,
      "--",
      devNull,
      path,
    ], {
      allowedExitCodes: [0, 1],
      maxStdoutBytes: remaining,
    });
    assertSuccessfulOutput(untracked, "Canonical untracked Git patch");
    if (untracked.stdoutOverflow) return null;
    if (untracked.stdout.byteLength === 0) {
      throw new Error("Canonical untracked Git patch was unexpectedly empty.");
    }
    chunks.push(untracked.stdout);
    byteLength += untracked.stdout.byteLength;
  }
  return Buffer.concat(chunks, byteLength);
}

async function collectTrackedPatch(
  options: SnapshotOptionsBase,
  label: string,
  revisionArgs: string[],
  maxBytes: number,
): Promise<Buffer | null> {
  const result = await runGitRaw(options.repoRoot, [
    ...canonicalDiffConfig,
    "diff",
    ...canonicalDiffArgs,
    ...revisionArgs,
    "--",
    ...options.pathspecs,
  ], {
    maxStdoutBytes: maxBytes,
  });
  assertSuccessfulOutput(result, `Canonical ${label} Git patch`);
  return result.stdoutOverflow ? null : result.stdout;
}

function parseNameStatus(
  output: Buffer,
  layer: Exclude<ChangeLayer, "untracked">,
): ChangeRecord[] {
  if (output.byteLength === 0) return [];
  const tokens = splitNulOutput(output, "Git name-status output");
  const records: ChangeRecord[] = [];
  for (let index = 0; index < tokens.length;) {
    const status = decodeAscii(tokens[index] as Buffer, "Git change status");
    index += 1;
    const pathCount = status.startsWith("R") || status.startsWith("C") ? 2 : 1;
    if (!/^(?:[ADMT]|[RC](?:100|[1-9]?[0-9]))$/.test(status)) {
      throw new Error("Git name-status output contained an unsupported status.");
    }
    if (index + pathCount > tokens.length) {
      throw new Error("Git name-status output ended inside a change record.");
    }
    const pathTokens = tokens.slice(index, index + pathCount);
    const paths = pathTokens.map((path) => decodeGitPath(path));
    records.push({ layer, status, pathBytes: pathTokens, paths, untracked: false });
    index += pathCount;
  }
  return records;
}

function parseNulPaths(output: Buffer, label: string): Array<{ bytes: Buffer; text: string }> {
  if (output.byteLength === 0) return [];
  return splitNulOutput(output, label).map((bytes) => ({ bytes, text: decodeGitPath(bytes) }));
}

function splitNulOutput(output: Buffer, label: string): Buffer[] {
  if (output.at(-1) !== 0) throw new Error(`${label} was not NUL terminated.`);
  const tokens: Buffer[] = [];
  let start = 0;
  for (let index = 0; index < output.byteLength; index += 1) {
    if (output[index] !== 0) continue;
    if (index === start) throw new Error(`${label} contained an empty field.`);
    tokens.push(output.subarray(start, index));
    start = index + 1;
  }
  if (start !== output.byteLength) throw new Error(`${label} contained trailing bytes.`);
  return tokens;
}

function decodeGitPath(bytes: Buffer): string {
  let path: string;
  try {
    path = utf8Decoder.decode(bytes);
  } catch {
    throw new Error("Git path output was not valid UTF-8.");
  }
  if (
    path.length === 0 ||
    path.includes("\0") ||
    isAbsolute(path) ||
    path.split("/").some((part) => part === "" || part === "." || part === "..")
  ) {
    throw new Error("Git path output was not a safe repository-relative path.");
  }
  return path;
}

function decodeAscii(bytes: Buffer, label: string): string {
  if ([...bytes].some((byte) => byte > 0x7f)) throw new Error(`${label} was not ASCII.`);
  return bytes.toString("ascii");
}

function sortRecords(records: ChangeRecord[]): ChangeRecord[] {
  const identities = new Set<string>();
  for (const record of records) {
    const identity = frameRecord(record).toString("hex");
    if (identities.has(identity)) throw new Error("Git change discovery contained a duplicate record.");
    identities.add(identity);
  }
  return [...records].sort((left, right) => Buffer.compare(frameRecord(left), frameRecord(right)));
}

function frameManifest(records: ChangeRecord[]): Buffer {
  const chunks = [manifestMagic, uint32(records.length, "manifest record count")];
  for (const record of records) chunks.push(frameRecord(record));
  return Buffer.concat(chunks);
}

function frameRecord(record: ChangeRecord): Buffer {
  const layer = Buffer.from(record.layer, "ascii");
  const status = Buffer.from(record.status, "ascii");
  const chunks = [
    uint32(layer.byteLength, "manifest layer length"),
    layer,
    uint32(status.byteLength, "manifest status length"),
    status,
    uint32(record.pathBytes.length, "manifest path count"),
  ];
  for (const path of record.pathBytes) {
    chunks.push(uint32(path.byteLength, "manifest path length"), path);
  }
  return Buffer.concat(chunks);
}

function uint32(value: number, label: string): Buffer {
  if (!Number.isSafeInteger(value) || value < 0 || value > 0xffff_ffff) {
    throw new Error(`${label} exceeded the canonical framing limit.`);
  }
  const buffer = Buffer.allocUnsafe(4);
  buffer.writeUInt32BE(value);
  return buffer;
}

function filesFromRecords(records: ChangeRecord[]): string[] {
  const files = records.map((record) => {
    const path = record.paths.at(-1);
    if (!path) throw new Error("Canonical manifest contained an empty path record.");
    return path;
  });
  return [...new Set(files)].sort();
}

function completeSnapshotsMatch(left: CanonicalSnapshot, right: CanonicalSnapshot): boolean {
  return left.headBefore === left.headAfter &&
    right.headBefore === right.headAfter &&
    left.headBefore === right.headBefore &&
    left.baselineCommit === right.baselineCommit &&
    left.manifest.byteLength === right.manifest.byteLength &&
    left.manifest.equals(right.manifest) &&
    left.patch !== null &&
    right.patch !== null &&
    left.patch.byteLength === right.patch.byteLength &&
    left.patch.equals(right.patch);
}

async function readExactHead(repoRoot: string, maxBytes: number): Promise<string | null> {
  const result = await runGitRaw(repoRoot, ["rev-parse", "--verify", "HEAD^{commit}"], {
    allowedExitCodes: [0, 1, 128],
    maxStdoutBytes: maxBytes,
  });
  assertNoOutputOverflow(result, "Git HEAD read");
  if (result.exitCode === 0) return parseCommitOutput(result.stdout, "Git HEAD read");
  const symbolic = await runGitRaw(repoRoot, ["symbolic-ref", "-q", "HEAD"], {
    allowedExitCodes: [0, 1],
    maxStdoutBytes: maxBytes,
  });
  assertNoOutputOverflow(symbolic, "Git unborn HEAD read");
  if (symbolic.exitCode !== 0) throw new Error("Git HEAD did not resolve to a commit.");
  const reference = parseSingleLine(symbolic.stdout, "Git unborn HEAD reference");
  if (!reference.startsWith("refs/heads/")) throw new Error("Git unborn HEAD reference was invalid.");
  const visible = await runGitRaw(repoRoot, ["show-ref", "--verify", "--quiet", reference], {
    allowedExitCodes: [0, 1],
    maxStdoutBytes: maxBytes,
  });
  assertNoOutputOverflow(visible, "Git unborn HEAD verification");
  if (visible.exitCode === 0) throw new Error("Git HEAD reference existed but did not resolve to a commit.");
  return null;
}

async function resolveCommit(repoRoot: string, ref: string, maxBytes: number): Promise<string> {
  const result = await runGitRaw(repoRoot, ["rev-parse", "--verify", `${ref}^{commit}`], {
    maxStdoutBytes: maxBytes,
  });
  assertSuccessfulCompleteOutput(result, "Git commit resolution");
  return parseCommitOutput(result.stdout, "Git commit resolution");
}

async function readCanonicalEmptyTreeObject(repoRoot: string, maxBytes: number): Promise<string> {
  const result = await runGitRaw(repoRoot, ["hash-object", "-t", "tree", "--stdin"], {
    maxStdoutBytes: maxBytes,
  });
  assertSuccessfulCompleteOutput(result, "Git empty-tree object resolution");
  return parseCommitOutput(result.stdout, "Git empty-tree object resolution");
}

function parseCommitOutput(output: Buffer, label: string): string {
  const commit = parseSingleLine(output, label);
  assertCommitIdentity(commit, label);
  return commit;
}

function parseSingleLine(output: Buffer, label: string): string {
  if (output.byteLength === 0 || output.includes(0)) throw new Error(`${label} was malformed.`);
  const text = decodeAscii(output, label);
  const value = text.endsWith("\n") ? text.slice(0, -1) : text;
  if (value.length === 0 || value.includes("\n") || value.includes("\r")) {
    throw new Error(`${label} was not one canonical line.`);
  }
  return value;
}

function assertCommitIdentity(value: string, label: string): void {
  if (!commitPattern.test(value)) throw new Error(`${label} was not a full lowercase Git commit identity.`);
}

function assertSuccessfulCompleteOutput(result: RawGitResult, label: string): void {
  assertSuccessfulOutput(result, label);
  if (result.stdoutOverflow) throw new Error(`${label} exceeded its output limit.`);
}

function assertSuccessfulOutput(result: RawGitResult, label: string): void {
  assertNoOutputOverflow(result, label);
  if (result.exitCode !== 0 && result.exitCode !== 1) {
    throw new Error(`${label} failed: ${boundedStderr(result.stderr)}`);
  }
}

function assertNoOutputOverflow(result: RawGitResult, label: string): void {
  if (result.stderrOverflow) throw new Error(`${label} stderr exceeded its output limit.`);
}

function boundedStderr(stderr: Buffer): string {
  const message = stderr.toString("utf8").trim();
  return message ? message.slice(0, 1000) : "Git command failed.";
}

function sha256(value: Buffer): string {
  return createHash("sha256").update(value).digest("hex");
}

function assertPositiveSafeInteger(value: number, label: string): void {
  if (!Number.isSafeInteger(value) || value <= 0) throw new Error(`${label} must be a positive safe integer.`);
}

async function runGitRaw(
  cwd: string,
  args: readonly string[],
  options: {
    allowedExitCodes?: readonly number[];
    maxStdoutBytes: number;
    maxStderrBytes?: number;
  },
): Promise<RawGitResult> {
  const allowedExitCodes = new Set(options.allowedExitCodes ?? [0]);
  const maxStderrBytes = options.maxStderrBytes ?? 64 * 1024;
  return new Promise((resolvePromise, reject) => {
    const env: NodeJS.ProcessEnv = {
      ...process.env,
      LANG: "C",
      LC_ALL: "C",
      GIT_ATTR_NOSYSTEM: "1",
    };
    delete env.GIT_DIFF_OPTS;
    delete env.GIT_EXTERNAL_DIFF;
    const child = spawn("git", [...args], {
      cwd,
      env,
      shell: false,
      stdio: ["ignore", "pipe", "pipe"],
    });
    const stdoutChunks: Buffer[] = [];
    const stderrChunks: Buffer[] = [];
    let stdoutBytes = 0;
    let stderrBytes = 0;
    let stdoutOverflow = false;
    let stderrOverflow = false;
    child.stdout.on("data", (chunk: Buffer) => {
      const remaining = options.maxStdoutBytes - stdoutBytes;
      if (remaining > 0) {
        const retained = chunk.byteLength > remaining ? chunk.subarray(0, remaining) : chunk;
        stdoutChunks.push(retained);
        stdoutBytes += retained.byteLength;
      }
      if (chunk.byteLength > remaining) stdoutOverflow = true;
    });
    child.stderr.on("data", (chunk: Buffer) => {
      const remaining = maxStderrBytes - stderrBytes;
      if (remaining > 0) {
        const retained = chunk.byteLength > remaining ? chunk.subarray(0, remaining) : chunk;
        stderrChunks.push(retained);
        stderrBytes += retained.byteLength;
      }
      if (chunk.byteLength > remaining) stderrOverflow = true;
    });
    child.once("error", reject);
    child.once("close", (code) => {
      const exitCode = code ?? -1;
      const result = {
        stdout: Buffer.concat(stdoutChunks, stdoutBytes),
        stderr: Buffer.concat(stderrChunks, stderrBytes),
        exitCode,
        stdoutOverflow,
        stderrOverflow,
      };
      if (!allowedExitCodes.has(exitCode)) {
        reject(new Error(`Git command failed: ${boundedStderr(result.stderr)}`));
        return;
      }
      resolvePromise(result);
    });
  });
}
