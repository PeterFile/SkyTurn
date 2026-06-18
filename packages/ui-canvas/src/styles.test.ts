import { readFile } from "node:fs/promises";

import { describe, expect, it } from "vitest";

async function readSource(path: string): Promise<string> {
  return readFile(new URL(path, import.meta.url), "utf8");
}

function lastCssBlock(styles: string, selector: string): string {
  const escaped = selector.replaceAll(".", "\\.");
  const matches = Array.from(styles.matchAll(new RegExp(`${escaped} \\{[\\s\\S]*?\\n\\}`, "g")), (match) => match[0]);
  return matches.at(-1) ?? "";
}

function cssBlockContaining(styles: string, selector: string, expected: string): string {
  const escaped = selector.replaceAll(".", "\\.");
  const matches = Array.from(styles.matchAll(new RegExp(`${escaped} \\{[\\s\\S]*?\\n\\}`, "g")), (match) => match[0]);
  return matches.find((block) => block.includes(expected)) ?? "";
}

describe("SkyTurn UI style tokens", () => {
  it("uses the paper collage material tokens instead of the old SaaS palette", async () => {
    const styles = await readSource("./styles.css");

    expect(styles).not.toContain("@fontsource-variable");
    expect(styles).not.toContain("Space Grotesk");
    expect(styles).toContain("--sk-paper-base: #f4f0e3");
    expect(styles).toContain("--sk-cobalt: #0e53c9");
    expect(styles).toContain("--sk-yellow: #fff127");
    expect(styles).toContain("--sk-pink: #ff9ed1");
    expect(styles).toContain('--sk-paper-white: url("./assets/paper/paper-white.webp")');
    expect(styles).toContain('--sk-paper-rip-white: url("./assets/paper/paper-rip-white.webp")');
    expect(styles).toContain('--sk-paper-sidebar-edge: url("./assets/paper/paper-sidebar-edge.png")');
    expect(styles).toContain("--sk-accent: var(--sk-cobalt)");
    expect(styles).toContain("--sk-status-running: var(--sk-cobalt)");
  });

  it("uses Paper Ops Board proportions instead of oversized collage decoration", async () => {
    const styles = await readSource("./styles.css");
    const motionSource = await readSource("./motion.ts");

    expect(styles).toContain("--sk-ui-texture-opacity: 0.15");
    expect(styles).toContain("--node-texture-shield");
    expect(styles).toContain("linear-gradient(var(--node-texture-shield), var(--node-texture-shield)), var(--node-paper)");
    expect(styles).toContain("--agent-card-width: 440px");
    expect(styles).toContain("--agent-card-height: auto");
    expect(styles).toContain("grid-template-columns: 232px minmax(0, 1fr)");
    expect(motionSource).toContain("width: 440");
    expect(motionSource).toContain("height: 176");
  });

  it("routes runtime paint decisions through CSS tokens", async () => {
    const appSource = await readSource("./App.tsx");

    expect(appSource).not.toContain("<Background");
    expect(appSource).toContain('stopColor="var(--sk-running-gradient-start)"');
    expect(appSource).toContain('stopColor="var(--sk-running-gradient-mid)"');
    expect(appSource).toContain('stopColor="var(--sk-running-gradient-end)"');
    expect(appSource).toContain('return "var(--sk-edge-active)"');
    expect(appSource).toContain('return "var(--sk-frame-completed)"');
    expect(appSource).toContain('return "var(--sk-glint-failed)"');
    expect(appSource).toContain('return "var(--sk-status-running)"');
  });

  it("does not reintroduce the discarded token-branch theme direction or dot grid", async () => {
    const source = `${await readSource("./styles.css")}\n${await readSource("./App.tsx")}`;

    expect(source).not.toContain("--sk-accent: #38a8ff");
    expect(source).not.toContain("--sk-status-running: #38a8ff");
    expect(source).not.toContain("56, 168, 255");
    expect(source).not.toContain("56 168 255");
    expect(source).not.toContain("radial-gradient(circle at 1px 1px");
    expect(source).not.toContain("react-flow__background");
    expect(source).not.toContain("gap={18}");
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

  it("loads real Changes evidence through IPC instead of seeding mock changesets", async () => {
    const appSource = await readSource("./App.tsx");
    const persistenceSource = await readSource("../../persistence/src/index.ts");

    expect(appSource).toContain("getChangeset");
    expect(appSource).toContain("No available change evidence.");
    expect(persistenceSource).toContain("getChangeset");
    expect(appSource).not.toContain("mockChangesetService");
    expect(appSource).not.toContain("createMockChangeset");
  });

  it("keeps split diff readable inside the node detail drawer", async () => {
    const styles = await readSource("./styles.css");
    const diff2htmlStyles = styles.slice(styles.indexOf(".diff2html-shell"), styles.indexOf(".changes-empty"));

    expect(styles).toContain(".diff2html-shell.is-side-by-side .d2h-files-diff");
    expect(styles).toContain("min-width: 760px");
    expect(diff2htmlStyles).not.toContain("overflow-wrap: anywhere");
  });

  it("keeps sidebar controls visible and renders Paper Ops cards inside their energy frame", async () => {
    const styles = await readSource("./styles.css");
    const motionSource = await readSource("./motion.ts");
    const sidebarToggleBlock = styles.match(/\.sidebar-toggle \{[\s\S]*?\n\}/)?.[0] ?? "";
    const sidebarHoverBlock = styles.match(/\.sidebar-project-row:hover,[\s\S]*?\.sidebar-settings:hover \{[\s\S]*?\n\}/)?.[0] ?? "";
    const cardBlock = cssBlockContaining(styles, ".agent-card", "border: var(--node-border)");
    const composerBlock = cssBlockContaining(styles, ".canvas-composer", "min-height: 64px");

    expect(styles).toContain("sidebar-toggle-label");
    expect(sidebarToggleBlock).toContain("position: absolute");
    expect(sidebarToggleBlock).not.toContain("opacity: 0");
    expect(sidebarToggleBlock).not.toContain("pointer-events: none");
    expect(styles).toContain(".sidebar::after");
    expect(styles).not.toContain(".sidebar::before");
    expect(styles).toContain(".sidebar-session-row.active::before");
    expect(styles).toContain("background-color: #eaf2ff");
    expect(styles).toContain("height: 40px");
    expect(sidebarHoverBlock).not.toContain("scale(");
    expect(styles).toContain("--agent-card-radius: 4px");
    expect(styles).toContain("background-image: var(--sk-paper-white)");
    expect(styles).toContain("background-image: var(--sk-paper-cobalt)");
    expect(styles).toContain("background-image: var(--sk-paper-rip-white)");
    expect(styles).toContain(".agent-node-shell::before");
    expect(styles).toContain("--node-border: 1px solid rgba(5, 29, 72, 0.12)");
    expect(styles).toContain("--node-tab-opacity: 0");
    expect(styles).toContain("--node-border: 1px solid var(--sk-yellow)");
    expect(styles).toContain("--node-border: 1px solid var(--sk-red-paper)");
    expect(styles).toContain("--node-border: 1px solid var(--sk-cobalt)");
    expect(styles).not.toContain(".agent-card::after");
    expect(styles).not.toContain(".canvas-composer::after");
    expect(styles).toContain(".canvas-composer:focus-within");
    expect(styles).toContain(".canvas-composer.has-content");
    expect(composerBlock).toContain("min-height: 64px");
    expect(composerBlock).toContain("background-color: var(--sk-paper-warm)");
    expect(composerBlock).not.toContain("background-color: var(--sk-pink)");
    expect(cardBlock).toContain("border: var(--node-border)");
    expect(cardBlock).not.toContain("height: calc(100% - 4px)");
    expect(motionSource).toContain("radius: 4");
  });
});
