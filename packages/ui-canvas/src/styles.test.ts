import { readFile } from "node:fs/promises";

import { describe, expect, it } from "vitest";

async function readSource(path: string): Promise<string> {
  return readFile(new URL(path, import.meta.url), "utf8");
}

describe("SkyTurn UI style tokens", () => {
  it("keeps the existing font stack and theme colors stable", async () => {
    const styles = await readSource("./styles.css");

    expect(styles).not.toContain("@fontsource-variable");
    expect(styles).not.toContain("Space Grotesk");
    expect(styles).toContain("--sk-accent: #0ea5e9");
    expect(styles).toContain("--sk-accent-strong: #0284c7");
    expect(styles).toContain("--sk-status-running: #6366f1");
    expect(styles).toContain("--sk-running-gradient-start: #22d3ee");
    expect(styles).toContain("--sk-running-gradient-mid: #818cf8");
    expect(styles).toContain("--sk-running-gradient-end: #a78bfa");
    expect(styles).toContain("--sk-edge-active: #7c8cff");
    expect(styles).toContain("--sk-shadow-running: rgba(79, 70, 229, 0.15)");
    expect(styles).toContain("--sk-loop-running-deep: rgba(139, 92, 246, 0.86)");
  });

  it("routes runtime paint decisions through CSS tokens", async () => {
    const appSource = await readSource("./App.tsx");

    expect(appSource).toContain('color="var(--sk-canvas-grid)"');
    expect(appSource).toContain('stopColor="var(--sk-running-gradient-start)"');
    expect(appSource).toContain('stopColor="var(--sk-running-gradient-mid)"');
    expect(appSource).toContain('stopColor="var(--sk-running-gradient-end)"');
    expect(appSource).toContain('return "var(--sk-edge-active)"');
    expect(appSource).toContain('return "var(--sk-frame-completed)"');
    expect(appSource).toContain('return "var(--sk-glint-failed)"');
    expect(appSource).toContain('return "var(--sk-status-running)"');
  });

  it("does not reintroduce the discarded token-branch theme direction", async () => {
    const source = `${await readSource("./styles.css")}\n${await readSource("./App.tsx")}`;

    expect(source).not.toContain("--sk-accent: #38a8ff");
    expect(source).not.toContain("--sk-status-running: #38a8ff");
    expect(source).not.toContain("56, 168, 255");
    expect(source).not.toContain("56 168 255");
  });

  it("renders editor launch actions through a single dropdown trigger", async () => {
    const appSource = await readSource("./App.tsx");

    expect(appSource).toContain('className="editor-menu-trigger"');
    expect(appSource).toContain('aria-haspopup="menu"');
    expect(appSource).not.toContain("Open Worktree in VSCode");
    expect(appSource).not.toContain("Open Worktree in Cursor");
    expect(appSource).not.toContain("Open Worktree in Zed");
  });

  it("keeps session creation on the project start page instead of the launch page", async () => {
    const appSource = await readSource("./App.tsx");

    expect(appSource).toContain("<ProjectStartPage");
    expect(appSource).toContain('variant="inline"');
    expect(appSource).not.toContain('className="home-input"');
  });

  it("uses the project start page for new tabs without opening a modal composer", async () => {
    const appSource = await readSource("./App.tsx");

    expect(appSource).toContain("function openProjectStartPage");
    expect(appSource).toContain("onNewSession={() => openProjectStartPage()}");
    expect(appSource).toContain("onToggleNewTask={() => openProjectStartPage()}");
    expect(appSource).not.toContain("newTaskOpen");
    expect(appSource).not.toContain("<NewSessionPanel");
    expect(appSource).not.toContain("session-panel-backdrop");
  });

  it("renders Changes through diff2html instead of a self-authored diff table", async () => {
    const appSource = await readSource("./App.tsx");
    const diffSource = await readSource("./diffViewer.ts");
    const styles = await readSource("./styles.css");

    expect(diffSource).toContain('import type { Diff2HtmlConfig } from "diff2html"');
    expect(diffSource).toContain('await import("diff2html")');
    expect(diffSource).toContain('await import("dompurify")');
    expect(appSource).toContain("renderChangesetDiffHtml");
    expect(appSource).toContain('className="changes-review"');
    expect(appSource).toContain("Enable word wrap");
    expect(appSource).toContain("Collapse all diffs");
    expect(appSource).toContain("Enable word diffs");
    expect(appSource).toContain("Hide white space");
    expect(appSource).toContain("dangerouslySetInnerHTML={{ __html: diffHtml }}");
    expect(appSource).not.toContain("parseUnifiedDiff");
    expect(appSource).not.toContain("ReviewDiffFileCard");
    expect(appSource).not.toContain('className={`diff-row ${row.kind}`}');
    expect(appSource).not.toContain("<pre>{changeset.patchPreview}</pre>");
    expect(styles).toContain('@import "diff2html/bundles/css/diff2html.min.css";');
    expect(styles).toContain(".changes-review");
    expect(styles).toContain(".diff2html-shell");
    expect(styles).toContain(".d2h-file-wrapper");
    expect(styles).not.toContain(".diff-row.added");
    expect(styles).not.toContain(".diff-row.removed");
    expect(styles).not.toContain(".diff-row-separator");
  });

  it("keeps split diff readable inside the node detail drawer", async () => {
    const styles = await readSource("./styles.css");
    const diff2htmlStyles = styles.slice(styles.indexOf(".diff2html-shell"), styles.indexOf(".changes-empty"));

    expect(styles).toContain(".diff2html-shell.is-side-by-side .d2h-files-diff");
    expect(styles).toContain("min-width: 760px");
    expect(diff2htmlStyles).not.toContain("overflow-wrap: anywhere");
  });

  it("keeps sidebar controls visible and aligns node cards inside their energy frame", async () => {
    const styles = await readSource("./styles.css");
    const motionSource = await readSource("./motion.ts");
    const sidebarToggleBlock = styles.match(/\.sidebar-toggle \{[\s\S]*?\n\}/)?.[0] ?? "";

    expect(styles).toContain("sidebar-toggle-label");
    expect(sidebarToggleBlock).toContain("position: absolute");
    expect(sidebarToggleBlock).not.toContain("opacity: 0");
    expect(sidebarToggleBlock).not.toContain("pointer-events: none");
    expect(styles).toContain("radial-gradient(circle at 1px 1px");
    expect(styles).toContain("--agent-card-radius: 22px");
    expect(styles).toContain("width: calc(100% - 4px)");
    expect(styles).toContain("height: calc(100% - 4px)");
    expect(motionSource).toContain("radius: 22");
  });
});
