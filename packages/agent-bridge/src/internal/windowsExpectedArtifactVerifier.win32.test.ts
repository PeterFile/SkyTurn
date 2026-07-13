import { mkdir, mkdtemp, rename, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
  assertWindowsExpectedArtifactVerifierCapability,
  openWindowsExpectedArtifactVerifierSession,
} from "./windowsExpectedArtifactVerifier.js";

const roots: string[] = [];
const acceptance = ".devflow/acceptance";

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe.runIf(process.platform === "win32")("native Windows expected-artifact handles", () => {
  it("verifies a non-empty file and preserves the exact case-normalized declaration", async () => {
    const root = await makeRoot();
    await writeFile(join(root, acceptance, "Case.PNG"), "png");
    await assertWindowsExpectedArtifactVerifierCapability();
    const session = await openWindowsExpectedArtifactVerifierSession(
      root,
      [".devflow/acceptance/case.png"],
    );

    await expect(session.verify()).resolves.toMatchObject({
      passed: true,
      artifacts: [".devflow/acceptance/case.png"],
      counts: { verified: 1, missing: 0, empty: 0, unsafe: 0 },
    });
  });

  it.each(["empty", "missing", "directory", "device"] as const)("rejects a native %s target", async (kind) => {
    const root = await makeRoot();
    const declaration = kind === "device"
      ? ".devflow/acceptance/CON.png"
      : `.devflow/acceptance/${kind}.png`;
    if (kind === "empty") await writeFile(join(root, declaration), "");
    if (kind === "directory") await mkdir(join(root, declaration));
    const session = await openWindowsExpectedArtifactVerifierSession(root, [declaration]);

    const result = await session.verify();
    expect(result.passed).toBe(false);
    expect(result.artifacts).toEqual([]);
  });

  it("rejects final and parent junctions that resolve outside the held root", async () => {
    const root = await makeRoot();
    const outside = await makeRoot();
    await writeFile(join(outside, acceptance, "outside.png"), "png");
    await symlink(join(outside, acceptance), join(root, acceptance, "junction"), "junction");
    await symlink(join(outside, acceptance), join(root, acceptance, "final.png"), "junction");

    for (const declaration of [
      ".devflow/acceptance/junction/outside.png",
      ".devflow/acceptance/final.png",
    ]) {
      const session = await openWindowsExpectedArtifactVerifierSession(root, [declaration]);
      await expect(session.verify()).resolves.toMatchObject({ passed: false, artifacts: [] });
    }
  });

  it.each([
    ".devflow/acceptance/file.png:$DATA",
    "\\\\server\\share\\file.png",
    "D:\\file.png",
  ])("rejects alternate, UNC, and drive-qualified declaration %s before helper launch", async (declaration) => {
    const root = await makeRoot();
    await expect(openWindowsExpectedArtifactVerifierSession(root, [declaration])).rejects.toThrow(/verification failed/i);
  });

  it("holds the final handle against rename-swap until the verdict", async () => {
    const root = await makeRoot();
    const declaration = ".devflow/acceptance/rename.png";
    const artifactPath = join(root, declaration);
    await writeFile(artifactPath, "png");
    let renameRejected = false;
    const session = await openWindowsExpectedArtifactVerifierSession(root, [declaration], {
      afterArtifactsOpen: async () => {
        try {
          await rename(artifactPath, `${artifactPath}.swapped`);
        } catch {
          renameRejected = true;
        }
      },
    });

    await expect(session.verify()).resolves.toMatchObject({ passed: true, artifacts: [declaration] });
    expect(renameRejected).toBe(true);
  });

  it("holds the trusted root handle against rename replacement", async () => {
    const root = await makeRoot();
    const swapped = `${root}-swapped`;
    roots.push(swapped);
    const declaration = ".devflow/acceptance/root-held.png";
    await writeFile(join(root, declaration), "png");
    let renameRejected = false;

    const session = await openWindowsExpectedArtifactVerifierSession(root, [declaration], {
      afterRootOpen: async () => {
        try {
          await rename(root, swapped);
        } catch {
          renameRejected = true;
        }
      },
    });

    await expect(session.verify()).resolves.toMatchObject({ passed: true, artifacts: [declaration] });
    expect(renameRejected).toBe(true);
  });
});

async function makeRoot(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "skyturn-windows-artifact-"));
  roots.push(root);
  await mkdir(join(root, acceptance), { recursive: true });
  return root;
}
