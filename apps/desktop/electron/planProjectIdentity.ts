import { realpath } from "node:fs/promises";
import path from "node:path";

const unknownProjectError = "Project root is not open in SkyTurn.";

export function createPlanProjectIdentityRegistry(): {
  remember: (projectRoot: string, persistedCanonicalRoot?: string) => Promise<string>;
  canonicalize: (projectRoot: string) => Promise<string>;
} {
  const canonicalRoots = new Map<string, string>();

  return {
    async remember(projectRoot, persistedCanonicalRoot) {
      const key = openedRootKey(projectRoot);
      const canonicalRoot = await canonicalRootFor(projectRoot);
      if (persistedCanonicalRoot !== undefined && canonicalRoot !== persistedCanonicalRoot) {
        throw new Error(unknownProjectError);
      }
      canonicalRoots.set(key, canonicalRoot);
      return canonicalRoot;
    },
    async canonicalize(projectRoot) {
      const expected = canonicalRoots.get(openedRootKey(projectRoot));
      if (!expected) throw new Error(unknownProjectError);
      const canonicalRoot = await canonicalRootFor(projectRoot);
      if (canonicalRoot !== expected) throw new Error(unknownProjectError);
      return canonicalRoot;
    },
  };
}

function openedRootKey(projectRoot: string): string {
  if (!path.isAbsolute(projectRoot)) throw new Error(unknownProjectError);
  return path.resolve(projectRoot);
}

async function canonicalRootFor(projectRoot: string): Promise<string> {
  try {
    return await realpath(projectRoot);
  } catch {
    throw new Error(unknownProjectError);
  }
}
