import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { isValidElement, type ReactElement, type ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import type { CanvasNode, CanvasSession, Changeset, NodeModalTab } from "@skyturn/project-core";
import { NodeModal } from "./App.js";
import { renderChangesetDiffHtmlPreview } from "./diffViewer.js";

interface HookScope { slots: unknown[]; cursor: number; effects: (() => void)[] }
const hooks = vi.hoisted(() => ({ current: null as HookScope | null }));
vi.mock("@gsap/react", () => ({ useGSAP: () => ({ contextSafe: (callback: unknown) => callback }) }));
vi.mock("react", async original => {
  const react = await original<typeof import("react")>();
  const state = (initial: unknown) => {
    const scope = hooks.current!;
    const index = scope.cursor++;
    if (!(index in scope.slots)) scope.slots[index] = typeof initial === "function" ? initial() : initial;
    return [scope.slots[index], (value: unknown) => {
      scope.slots[index] = typeof value === "function" ? value(scope.slots[index]) : value;
    }];
  };
  const effect = (callback: () => void | (() => void), dependencies?: unknown[]) => {
    const scope = hooks.current!, index = scope.cursor++;
    const previous = scope.slots[index] as { dependencies?: unknown[]; cleanup?: () => void } | undefined;
    if (!dependencies || !previous?.dependencies || dependencies.some((value, i) => !Object.is(value, previous.dependencies![i]))) {
      scope.effects.push(() => {
        previous?.cleanup?.();
        scope.slots[index] = { dependencies, cleanup: callback() };
      });
    }
  };
  return { ...react, useState: state, useRef: (current: unknown) => state({ current })[0],
    useId: () => state("filter-test-id")[0], useEffect: effect, useLayoutEffect: () => {},
    useMemo: (callback: () => unknown) => callback(), useCallback: (callback: unknown) => callback };
});
vi.mock("./diffViewer.js", async original => {
  const actual = await original<typeof import("./diffViewer.js")>();
  return { ...actual, renderChangesetDiffHtmlPreview: vi.fn((patch, files, options, query) =>
    actual.renderChangesetDiffHtmlPreview(patch, files, options, query, value => value)) };
});

function scope(): HookScope { return { slots: [], cursor: 0, effects: [] }; }
function dispose(value: HookScope) {
  for (const slot of value.slots) (slot as { cleanup?: () => void } | null)?.cleanup?.();
}
function elements(node: ReactNode): ReactElement<Record<string, unknown>>[] {
  if (Array.isArray(node)) return node.flatMap(elements);
  if (!isValidElement<Record<string, unknown>>(node)) return [];
  return [node, ...elements(node.props.children as ReactNode)];
}
const patch = (file: string) => `diff --git a/${file} b/${file}\n--- a/${file}\n+++ b/${file}\n@@ -1 +1 @@\n-old\n+new\n`;
const makeChangeset = (files = ["src/One [draft].ts", "docs/二 文档.md"]): Changeset => ({
  id: "cs-1", source: "git", files, patchPreview: files.map(patch).join(""), diffStat: { added: 2, changed: files.length, deleted: 2 },
  evidence: { status: "available", evidenceId: "e-1", changesetId: "cs-1", source: "git", files, diffStat: { added: 2, changed: files.length, deleted: 2 } },
});
let node: CanvasNode, session: CanvasSession, projectRoot: string, events: never[];
let changeset: Changeset, reconciliation: Record<string, unknown>;
let modalScope: HookScope, tabScope: HookScope, tabKey: string | null | undefined;
let activeTab: NodeModalTab;
const reconcile = vi.fn(), commit = vi.fn();
const tick = async () => { await vi.dynamicImportSettled(); await new Promise<void>(resolve => setImmediate(resolve)); };
function deferred() {
  let resolve!: (value: Awaited<ReturnType<typeof renderChangesetDiffHtmlPreview>>) => void;
  let reject!: (reason: Error) => void;
  const promise = new Promise<Awaited<ReturnType<typeof renderChangesetDiffHtmlPreview>>>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}
function modalTree() {
  hooks.current = modalScope; modalScope.cursor = 0; modalScope.effects = [];
  return NodeModal({ node, session, projectRoot, runEvents: events, runEvidence: null, tab: activeTab,
    isCurrentScope: () => true, reassignBlockedReason: null, onTab: value => { activeTab = value; }, onClose: vi.fn(), onStop: vi.fn(),
    onRetry: vi.fn(), retryUnavailableReason: null, onReassign: vi.fn(), onInsertBefore: vi.fn(), onOpenEditor: vi.fn(), onDecisionAnswer: vi.fn() });
}
function switchTab(tab: NodeModalTab) {
  const button = elements(modalTree()).find(element => element.type === "button" && element.props.children === tab)!;
  (button.props.onClick as () => void)();
  if (!elements(modalTree()).some(element => typeof element.type === "function" && element.type.name === "ChangesTab")) {
    dispose(tabScope); tabScope = scope(); tabKey = undefined;
  }
}
function render(flush = true) {
  const entry = elements(modalTree()).find(element => typeof element.type === "function" && element.type.name === "ChangesTab")!;
  expect(entry).toBeDefined();
  if (entry.key !== tabKey) { dispose(tabScope); tabScope = scope(); tabKey = entry.key; }
  hooks.current = tabScope; tabScope.cursor = 0; tabScope.effects = [];
  const tree = (entry.type as (props: unknown) => ReactNode)(entry.props);
  const pending = [...tabScope.effects];
  // Render actual children for summary/mismatch/toolbar labels, without mounting their DOM effects.
  const html = renderToStaticMarkup(tree);
  if (flush) pending.forEach(effect => effect());
  const all = elements(tree);
  const input = all.find(element => element.type === "input" && element.props["aria-label"] === "Filter diff by file path");
  const delivery = all.find(element => typeof element.type === "function" && element.type.name === "DeliveryLifecyclePanel");
  const toolbar = all.find(element => typeof element.type === "function" && element.type.name === "ChangesDiffToolbar");
  return { html, input, delivery, toolbar, key: entry.key,
    query(value: string) { expect(input).toBeDefined(); (input!.props.onChange as (event: unknown) => void)({ target: { value } }); },
    clear() { const clear = all.find(element => element.type === "button" && element.props.children === "Clear filter");
      expect(clear).toBeDefined(); (clear!.props.onClick as () => void)(); } };
}
async function loaded() { render(); await tick(); render(); await tick(); return render(); }

beforeEach(() => {
  modalScope = scope(); tabScope = scope(); tabKey = undefined;
  activeTab = "Changes";
  projectRoot = "/project"; events = [];
  node = { id: "n1", title: "Review", agent: "codex", status: "completed", progress: "Done", laneKind: "commit",
    runId: "r1", changesetId: "cs-1", output: [], position: { x: 0, y: 0 }, worktree: { path: "/project", branchName: "main", baseCommit: "a".repeat(40) },
    context: { brief: "Review", sessionGoal: "Review", relatedRequirements: "", relatedDesign: "", relatedTasks: "", dependencies: [], constraints: [] } };
  session = { id: "s1", projectId: "p1", title: "Review", goal: "Review", mode: "fast", kind: "canvas", nodes: [node], edges: [], activeNodeId: node.id,
    target: { executionTarget: "current_branch", selectedBranch: "main" }, createdAt: "2026-10-18", updatedAt: "2026-10-18", hermesPlannerSessionId: "h1", plannerNodeId: "planner" };
  changeset = makeChangeset();
  reconciliation = { status: "mismatch", changeset, mismatches: [{ liveFiles: ["agent-only.txt"], gitFiles: changeset.files }] };
  reconcile.mockReset().mockImplementation(async () => ({ reconciliation }));
  commit.mockReset().mockResolvedValue({ status: "failed", errorReason: "Fixture only" });
  vi.stubGlobal("window", { devflow: { reconcileFinalChangeset: reconcile, workflow: { createDeliveryCommit: commit } } });
  vi.mocked(renderChangesetDiffHtmlPreview).mockClear();
});
afterEach(() => { dispose(tabScope); vi.unstubAllGlobals(); });

describe("actual Changes entrypoint filter wiring", () => {
  it("filters and clears without reconciling or changing full evidence and commit scope", async () => {
    const source = JSON.stringify(changeset);
    let view = await loaded();
    expect(view.html).toContain("2 / 2 preview file blocks");
    view.query("ONE [DRAFT]");
    expect(render(false).html).not.toContain("d2h-file-wrapper");
    render(); await tick(); view = render();
    expect(view.html).toContain("1 / 2 preview file blocks");
    expect(view.html).not.toContain('data-lang="md"');
    expect(view.html).toContain("Delivery uses the entire changeset");
    expect(view.html).toContain("Mismatch detected");
    expect(view.html).toContain("agent-only.txt");
    expect(view.html).toContain("Changeset evidence facts");
    expect(view.html).toContain("Diff statistics");
    await (view.delivery!.props.onCommit as () => Promise<void>)();
    expect(commit).not.toHaveBeenCalled();
    (view.delivery!.props.onAcceptMismatchChange as (value: boolean) => void)(true);
    await (render().delivery!.props.onCommit as () => Promise<void>)();
    expect(commit).toHaveBeenCalledWith(projectRoot, expect.objectContaining({ files: changeset.files, acceptMismatch: true }));
    view = render(); view.query("*.ts"); render(); await tick(); view = render();
    expect(view.html).toContain("0 / 2 preview file blocks");
    expect(view.html).toContain("No preview file paths match this filter.");
    view.clear(); render(); await tick(); view = render();
    expect(view.input!.props.value).toBe("");
    expect(view.html).toContain("2 / 2 preview file blocks");
    expect(reconcile).toHaveBeenCalledTimes(1);
    expect(JSON.stringify(changeset)).toBe(source);
  });

  it("retains query across same-run live updates and recomputes parsed counts", async () => {
    (await loaded()).query("src/"); render(); await tick();
    changeset = makeChangeset(["src/a.ts", "src/b.ts", "docs/c.md"]);
    reconciliation = { status: "available", changeset }; events = [];
    render(); await tick(); render(); await tick();
    const view = render();
    expect(view.input!.props.value).toBe("src/");
    expect(view.html).toContain("2 / 3 preview file blocks");
    expect(reconcile).toHaveBeenCalledTimes(2);
  });

  it.each(["project", "session", "node", "run", "reopen"])("clears query and ignores pending renders after %s switch", async kind => {
    const first = await loaded(), key = first.key;
    first.query("old-query");
    const late = deferred(); vi.mocked(renderChangesetDiffHtmlPreview).mockReturnValueOnce(late.promise);
    render();
    if (kind === "project") { projectRoot = "/other"; session = { ...session, projectId: "p2" }; }
    if (kind === "session") session = { ...session, id: "s2" };
    if (kind === "node") node = { ...node, id: "n2" };
    if (kind === "run") node = { ...node, runId: "r2" };
    if (kind === "reopen") { switchTab("Output"); switchTab("Changes"); }
    const next = await loaded();
    if (kind !== "reopen") expect(next.key).not.toBe(key);
    expect(next.input!.props.value).toBe("");
    late.resolve({ html: "STALE_PREVIEW", visibleFiles: 9, totalFiles: 9 }); await tick();
    expect(render().html).not.toContain("STALE_PREVIEW");
  });

  it("ignores out-of-order query results and never displays the old result before effects run", async () => {
    const view = await loaded(), late = deferred();
    view.query("old"); vi.mocked(renderChangesetDiffHtmlPreview).mockReturnValueOnce(late.promise); render();
    render().query("二");
    expect(render(false).html).not.toContain("d2h-file-wrapper");
    render(); await tick(); expect(render().html).toContain("1 / 2 preview file blocks");
    late.resolve({ html: "STALE_QUERY", visibleFiles: 2, totalFiles: 2 }); await tick();
    expect(render().html).not.toContain("STALE_QUERY");
    expect(reconcile).toHaveBeenCalledTimes(1);
  });

  it("keeps no-patch and render-error states distinct from no matches and preserves options", async () => {
    let view = await loaded();
    (view.toolbar!.props.onOption as (key: string, value: boolean) => void)("hideWhitespace", true);
    render(); await tick();
    expect(vi.mocked(renderChangesetDiffHtmlPreview).mock.lastCall?.[2].hideWhitespace).toBe(true);
    view = render(); view.query("error");
    vi.mocked(renderChangesetDiffHtmlPreview).mockRejectedValueOnce(new Error("Unable to parse diff preview."));
    render(); await tick(); view = render();
    expect(view.html).toContain("Unable to parse diff preview.");
    expect(view.html).not.toContain("No preview file paths match");
    changeset = { ...changeset, patchPreview: "" }; reconciliation = { status: "available", changeset }; events = [];
    render(); await tick(); render(); await tick(); view = render();
    expect(view.html).toContain("No structured diff was available");
    expect(view.html).not.toContain("No preview file paths match");
    expect(view.html).toContain("Changeset evidence facts");
  });
});
