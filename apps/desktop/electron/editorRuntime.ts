import { realpath, stat } from "node:fs/promises";
import path from "node:path";
import type { WorkflowWorktreeIdentity } from "@skyturn/project-core" with { "resolution-mode": "import" };

type NativeEditor = "vscode" | "cursor" | "zed";
type OpenResult = { ok: boolean; message: string };
type WorktreeEvent = { kind: string; payload: Record<string, unknown> };

interface EditorRuntimeDependencies {
  openedProjectRoots: ReadonlySet<string>;
  canonicalizeProjectRoot(root: string): Promise<string>;
  listWorktreeEvents(root: string): Promise<WorktreeEvent[]>;
  reconcileWorktree(identity: WorkflowWorktreeIdentity): Promise<WorkflowWorktreeIdentity>;
  openEditor(editor: NativeEditor, target: string): Promise<OpenResult>;
  openPath(target: string): Promise<string>;
}

const deniedMessage = "Editor target is unavailable or is not an authorized project or managed worktree.";

export function createEditorRuntime(deps: EditorRuntimeDependencies) {
  async function authorize(candidate: string): Promise<string> {
    // A registered alias must still match its original identity, even if retargeted
    // to another otherwise-authorized project.
    if (deps.openedProjectRoots.has(candidate)) {
      const canonical = await deps.canonicalizeProjectRoot(candidate);
      await assertCanonicalDirectory(canonical);
      return canonical;
    }
    await assertCanonicalDirectory(candidate);
    for (const registeredRoot of deps.openedProjectRoots) {
      let projectRoot: string;
      try {
        projectRoot = await deps.canonicalizeProjectRoot(registeredRoot);
      } catch {
        continue;
      }
      if (candidate === projectRoot) return projectRoot;
      const managedRoot = path.join(path.dirname(projectRoot), `${path.basename(projectRoot)}.worktrees`);
      if (!isInside(candidate, managedRoot)) continue;
      await assertCanonicalDirectory(managedRoot);
      // Containment is only a cheap prefilter. Ownership comes from the store,
      // followed by a fresh Git worktree/repository/branch/gitdir/ancestry check.
      const identity = ownedIdentity(await deps.listWorktreeEvents(projectRoot), candidate, projectRoot);
      const reconciled = await deps.reconcileWorktree(identity);
      if (reconciled.realPath !== candidate || reconciled.path !== candidate || reconciled.repoRoot !== projectRoot) {
        throw new Error(deniedMessage);
      }
      const current = ownedIdentity(await deps.listWorktreeEvents(projectRoot), candidate, projectRoot);
      if (JSON.stringify(current) !== JSON.stringify(identity) ||
        !deps.openedProjectRoots.has(registeredRoot) ||
        await deps.canonicalizeProjectRoot(registeredRoot) !== projectRoot) throw new Error(deniedMessage);
      await assertCanonicalDirectory(candidate);
      return candidate;
    }
    throw new Error(deniedMessage);
  }

  return {
    async open(editor: unknown, target: unknown): Promise<OpenResult> {
      if (editor !== "vscode" && editor !== "cursor" && editor !== "zed" && editor !== "finder") {
        return { ok: false, message: "Supported editors: vscode, cursor, zed, finder." };
      }
      if (typeof target !== "string" || !target || !path.isAbsolute(target) ||
        target.includes("\0") || target.split(path.sep).includes("..")) {
        return { ok: false, message: deniedMessage };
      }
      try {
        const canonical = await authorize(target);
        if (editor === "finder") {
          const error = await deps.openPath(canonical);
          return { ok: !error, message: error || "Opened worktree path." };
        }
        return await deps.openEditor(editor, canonical);
      } catch {
        // Auth, filesystem and module-load exceptions can contain private paths.
        return { ok: false, message: "Unable to open editor target. Verify project access and editor availability, then retry." };
      }
    },
  };
}

async function assertCanonicalDirectory(target: string): Promise<void> {
  if (await realpath(target) !== target || !(await stat(target)).isDirectory()) throw new Error(deniedMessage);
}

function isInside(candidate: string, parent: string): boolean {
  const relative = path.relative(parent, candidate);
  return relative !== "" && relative !== ".." && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative);
}

function ownedIdentity(events: WorktreeEvent[], target: string, projectRoot: string): WorkflowWorktreeIdentity {
  const revoked = new Set<unknown>();
  for (const event of events) {
    if (event.kind !== "workflow.worktree.cleaned") continue;
    for (const value of [event.payload.result, event.payload.worktree]) {
      if (isRecord(value)) revoked.add(value.worktreeId);
    }
  }
  let identity: WorkflowWorktreeIdentity | undefined;
  for (const event of events) {
    if (event.kind !== "workflow.worktree.created" || !isRecord(event.payload.worktree)) continue;
    const value = event.payload.worktree;
    if (value.path !== target && value.realPath !== target) continue;
    if (value.path !== target || value.realPath !== target || value.repoRoot !== projectRoot || revoked.has(value.worktreeId)) {
      throw new Error(deniedMessage);
    }
    // Preserve identity strings exactly; general workflow text parsers trim them.
    const parsed = {} as WorkflowWorktreeIdentity;
    for (const key of ["worktreeId", "variantId", "path", "realPath", "gitdir", "repoRoot", "branchName",
      "baseCommit", "headCommit", "parentLaneId"] as const) {
      const field = value[key];
      if (typeof field !== "string" || !field || field.includes("\0")) throw new Error(deniedMessage);
      parsed[key] = field;
    }
    if (value.parentSegmentId !== undefined) {
      if (typeof value.parentSegmentId !== "string" || !value.parentSegmentId) throw new Error(deniedMessage);
      parsed.parentSegmentId = value.parentSegmentId;
    }
    if (identity && JSON.stringify(identity) !== JSON.stringify(parsed)) throw new Error(deniedMessage);
    identity = parsed;
  }
  if (!identity) throw new Error(deniedMessage);
  return identity;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
