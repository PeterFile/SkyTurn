import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { collectAtomicGitChangesetSnapshot } from "./gitChangesetSnapshot.js";

const tempRoots: string[] = [];

describe("atomic Git changeset snapshot", () => {
  afterEach(async () => {
    await Promise.all(tempRoots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
  });

  it("derives the preview and digest metadata from canonical raw bytes despite hostile diff config", async () => {
    const repoRoot = await createRepo("skyturn-raw-changeset-");
    await writeFile(join(repoRoot, "tracked.txt"), "base\n\nchanged\n", "utf8");
    await writeFile(join(repoRoot, "untracked.txt"), "new\n", "utf8");
    const options = {
      repoRoot,
      baseline: { kind: "current-head" } as const,
      maxPatchPreviewBytes: 37,
      maxFullPatchBytes: 1024 * 1024,
    };

    const canonical = await collectAtomicGitChangesetSnapshot(options);
    for (const [name, value] of [
      ["color.ui", "always"],
      ["core.bigFileThreshold", "1"],
      ["core.checkStat", "minimal"],
      ["core.fileMode", "false"],
      ["core.fsmonitor", "true"],
      ["core.ignoreStat", "true"],
      ["core.quotePath", "true"],
      ["core.trustctime", "false"],
      ["core.untrackedCache", "true"],
      ["diff.algorithm", "patience"],
      ["diff.dstPrefix", "hostile-dst/"],
      ["diff.external", "/definitely/missing/skyturn-external-diff"],
      ["diff.indentHeuristic", "true"],
      ["diff.mnemonicPrefix", "true"],
      ["diff.noprefix", "true"],
      ["diff.orderFile", "/definitely/missing/skyturn-order"],
      ["diff.renames", "copies"],
      ["diff.srcPrefix", "hostile-src/"],
      ["diff.submodule", "log"],
      ["diff.suppressBlankEmpty", "true"],
    ]) git(repoRoot, ["config", name, value]);
    git(repoRoot, ["update-index", "--force-untracked-cache"]);
    const indexBefore = await readFile(join(repoRoot, ".git", "index"));
    const hostile = await collectAtomicGitChangesetSnapshot(options);
    const indexAfter = await readFile(join(repoRoot, ".git", "index"));

    expect(canonical.fullPatch).toEqual(hostile.fullPatch);
    expect(indexAfter).toEqual(indexBefore);
    expect(canonical.fullPatchSha256).toBe(sha256(canonical.fullPatch));
    expect(canonical.fullPatchByteLength).toBe(canonical.fullPatch.byteLength);
    expect(canonical.fileManifestSha256).toBe(fileManifestSha256(canonical.files));
    expect(canonical.previewTruncated).toBe(true);
    expect(canonical.patchPreview).toBe(
      `${canonical.fullPatch.subarray(0, 37).toString("utf8").trimEnd()}\n[diff truncated]\n`,
    );
    expect(hostile).toMatchObject({
      files: canonical.files,
      diffStat: canonical.diffStat,
      fullPatchSha256: canonical.fullPatchSha256,
      fullPatchByteLength: canonical.fullPatchByteLength,
      fileManifestSha256: canonical.fileManifestSha256,
    });
  });

  it("keeps repository ignore rules authoritative while neutralizing global and info exclusions", async () => {
    const repoRoot = await createRepo("skyturn-untracked-authority-");
    await writeFile(join(repoRoot, ".gitignore"), "ignored-secret.env\nbuild/\n", "utf8");
    git(repoRoot, ["add", ".gitignore"]);
    git(repoRoot, ["commit", "-m", "add repository ignores"]);

    const globalExcludes = join(repoRoot, ".git", "global-excludes");
    const infoExcludes = join(repoRoot, ".git", "info", "exclude");
    await writeFile(globalExcludes, "global-hidden.txt\n", "utf8");
    await writeFile(infoExcludes, "local-hidden.txt\n", "utf8");
    git(repoRoot, ["config", "core.excludesFile", globalExcludes]);
    await mkdir(join(repoRoot, "build"));
    await writeFile(join(repoRoot, "ignored-secret.env"), "secret\n", "utf8");
    await writeFile(join(repoRoot, "build", "bundle.js"), "generated\n", "utf8");
    await writeFile(join(repoRoot, "global-hidden.txt"), "global\n", "utf8");
    await writeFile(join(repoRoot, "local-hidden.txt"), "local\n", "utf8");
    await writeFile(join(repoRoot, "visible.txt"), "visible\n", "utf8");
    const options = {
      repoRoot,
      baseline: { kind: "current-head" } as const,
      maxPatchPreviewBytes: 1024 * 1024,
      maxFullPatchBytes: 1024 * 1024,
    };

    const excluded = await collectAtomicGitChangesetSnapshot(options);
    await writeFile(globalExcludes, "different-global.txt\n", "utf8");
    await writeFile(infoExcludes, "different-local.txt\n", "utf8");
    const changedExclusions = await collectAtomicGitChangesetSnapshot(options);

    expect(excluded.files).toEqual(["global-hidden.txt", "local-hidden.txt", "visible.txt"]);
    expect(changedExclusions.files).toEqual(excluded.files);
    expect(changedExclusions.fullPatch).toEqual(excluded.fullPatch);
    expect(changedExclusions.fullPatchSha256).toBe(excluded.fullPatchSha256);
    expect(changedExclusions.fileManifestSha256).toBe(excluded.fileManifestSha256);
    expect(excluded.fullPatch.toString("utf8")).not.toContain("ignored-secret.env");
    expect(excluded.fullPatch.toString("utf8")).not.toContain("build/bundle.js");
  });

  it("uses the repository object format empty tree and orders unborn staged, unstaged, then untracked patches", async () => {
    const repoRoot = await mkdtemp(join(tmpdir(), "skyturn-raw-unborn-"));
    tempRoots.push(repoRoot);
    git(repoRoot, ["init"]);
    await writeFile(join(repoRoot, "staged.txt"), "staged\n", "utf8");
    git(repoRoot, ["add", "staged.txt"]);
    await writeFile(join(repoRoot, "staged.txt"), "staged\nunstaged\n", "utf8");
    await writeFile(join(repoRoot, "untracked.txt"), "untracked\n", "utf8");

    const snapshot = await collectAtomicGitChangesetSnapshot({
      repoRoot,
      baseline: { kind: "current-head" },
      maxPatchPreviewBytes: 1024 * 1024,
      maxFullPatchBytes: 1024 * 1024,
    });
    const patch = snapshot.fullPatch.toString("utf8");
    const firstStaged = patch.indexOf("diff --git a/staged.txt b/staged.txt");
    const secondStaged = patch.indexOf("diff --git a/staged.txt b/staged.txt", firstStaged + 1);
    const untracked = patch.indexOf("diff --git a/untracked.txt b/untracked.txt");

    expect(snapshot.headCommit).toBeNull();
    expect(snapshot.baselineCommit).toBe(git(repoRoot, ["hash-object", "-t", "tree", "--stdin"]));
    expect(snapshot.files).toEqual(["staged.txt", "untracked.txt"]);
    expect(snapshot.diffStat).toEqual({ added: 3, changed: 2, deleted: 0 });
    expect(firstStaged).toBeGreaterThanOrEqual(0);
    expect(secondStaged).toBeGreaterThan(firstStaged);
    expect(untracked).toBeGreaterThan(secondStaged);
  });
});

async function createRepo(prefix: string): Promise<string> {
  const repoRoot = await mkdtemp(join(tmpdir(), prefix));
  tempRoots.push(repoRoot);
  git(repoRoot, ["init"]);
  git(repoRoot, ["config", "user.email", "skyturn@example.test"]);
  git(repoRoot, ["config", "user.name", "SkyTurn Test"]);
  await writeFile(join(repoRoot, "tracked.txt"), "base\n", "utf8");
  git(repoRoot, ["add", "tracked.txt"]);
  git(repoRoot, ["commit", "-m", "initial"]);
  return repoRoot;
}

function git(cwd: string, args: string[]): string {
  return execFileSync("git", args, {
    cwd,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  }).trim();
}

function sha256(value: Buffer): string {
  return createHash("sha256").update(value).digest("hex");
}

function fileManifestSha256(files: string[]): string {
  return sha256(Buffer.concat([
    frame(Buffer.from("skyturn-git-file-manifest-v1", "utf8")),
    ...files.map((file) => frame(Buffer.from(file, "utf8"))),
  ]));
}

function frame(value: Buffer): Buffer {
  const length = Buffer.alloc(8);
  length.writeBigUInt64BE(BigInt(value.byteLength));
  return Buffer.concat([length, value]);
}
