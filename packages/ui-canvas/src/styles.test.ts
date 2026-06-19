import { readFile } from "node:fs/promises";

import { describe, expect, it } from "vitest";

async function readSource(path: string): Promise<string> {
  return readFile(new URL(path, import.meta.url), "utf8");
}

function lastCssBlock(styles: string, selector: string): string {
  const escaped = selector.replaceAll(".", "\\.");
  const matches = Array.from(styles.matchAll(new RegExp(`(?:^|\\n)${escaped} \\{[\\s\\S]*?\\n\\}`, "g")), (match) => match[0]);
  return matches.at(-1) ?? "";
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
    expect(appSource).toContain('data-state={node.status}');
    expect(appSource).toContain("data-phase={runtime.phase}");
    expect(appSource).toContain('className="evidence-marker"');
    expect(appSource).toContain('"--tape-press": 1');
    expect(appSource).toContain('"--ink-absorb-opacity": node.status === "running" ? 0.12 : 0.07');
    expect(appSource).toContain('<Eye size={19} strokeWidth={2.6} />');
    expect(appSource).toContain('return "var(--sk-edge-active)"');
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

  it("renders the New Session composer as a Paper Ops intake slip with a custom project listbox", async () => {
    const appSource = await readSource("./App.tsx");
    const styles = await readSource("./styles.css");
    const composerSource = appSource.slice(
      appSource.indexOf("function SessionComposer"),
      appSource.indexOf("function formatRelativeTime"),
    );

    expect(composerSource).toContain('"new-session-intake"');
    expect(composerSource).toContain("<ProjectDropdown");
    expect(composerSource).toContain("rows={5}");
    expect(appSource).toContain("function ProjectDropdown");
    expect(appSource).toContain('aria-haspopup="listbox"');
    expect(appSource).toContain('role="listbox"');
    expect(appSource).toContain('role="option"');
    expect(appSource).toContain('event.key === "ArrowDown"');
    expect(appSource).toContain('event.key === "ArrowUp"');
    expect(appSource).toContain('event.key === "Escape"');
    expect(styles).toContain(".empty-stage");
    expect(styles).toContain(".folder-backing");
    expect(styles).toContain(".folder-backing::after");
    expect(styles).toContain(".intake-sheet");
    expect(styles).toContain(".control-strip");
    expect(styles).toContain(".control-strip::after");
    expect(styles).toContain(".project-dropdown-trigger");
    expect(styles).toContain(".project-dropdown-listbox");
    expect(styles).toContain("background-color: #dceaff");
    expect(styles).toContain("background-color: #eee7d8");
    expect(styles).toContain("#758696");
    expect(styles).toContain("background-color: #083176");
  });

  it("keeps node details as a transparent right-side drawer", async () => {
    const styles = await readSource("./styles.css");
    const drawerBlock = styles.slice(styles.indexOf("/* Right-side node detail drawer"));

    expect(drawerBlock).toContain(".modal-backdrop");
    expect(drawerBlock).toContain("justify-content: end");
    expect(drawerBlock).toContain("background: transparent");
    expect(drawerBlock).toContain("pointer-events: none");
    expect(drawerBlock).toContain(".node-modal");
    expect(drawerBlock).toContain("width: min(560px, calc(100vw - 280px))");
    expect(drawerBlock).toContain("height: calc(100vh - 32px)");
    expect(drawerBlock).toContain("border-radius: 6px 0 0 6px");
    expect(drawerBlock).toContain("pointer-events: auto");
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

    expect(appSource).toContain("reconcileFinalChangeset");
    expect(appSource).toContain("No available change evidence.");
    expect(persistenceSource).toContain("reconcileFinalChangeset");
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
    const hardResetBlock = styles.slice(styles.indexOf("/* Evidence-board paper construction hard reset. */"));
    const cardBlock = lastCssBlock(styles, ".agent-card");
    const composerBlock = lastCssBlock(styles, ".canvas-composer");

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
    expect(styles).toContain("background-image: var(--sk-paper-white)");
    expect(styles).toContain("background-image: var(--sk-paper-cobalt)");
    expect(styles).toContain("background-image: var(--sk-paper-rip-white)");
    expect(styles).not.toContain(".paper-corner-curl");
    expect(hardResetBlock).toContain(".agent-node-shell::before");
    expect(hardResetBlock).toContain("--underlayer-paper: var(--sk-paper-white)");
    expect(hardResetBlock).toContain("--underlayer-paper: var(--sk-paper-yellow)");
    expect(hardResetBlock).toContain("--underlayer-bg: var(--sk-red-paper)");
    expect(hardResetBlock).toContain('.agent-node-shell.running[data-phase="Planning"]');
    expect(hardResetBlock).toContain("--tape-bg: rgba(181, 40, 34, 0.88)");
    expect(hardResetBlock).toContain("--body-edge: polygon");
    expect(hardResetBlock).toContain(".agent-card::after");
    expect(hardResetBlock).toContain(".canvas-composer-shell::before");
    expect(hardResetBlock).toContain(".canvas-composer::after");
    expect(hardResetBlock).toContain(".canvas-composer:focus-within");
    expect(hardResetBlock).toContain(".canvas-composer.has-content");
    expect(hardResetBlock).toContain("--intake-scale-x: 1");
    expect(composerBlock).toContain("min-height: 68px");
    expect(composerBlock).toContain("background-color: #fffdf2");
    expect(composerBlock).toContain("border: 0");
    expect(composerBlock).toContain("border-radius: 0");
    expect(composerBlock).toContain("clip-path: polygon");
    expect(composerBlock).not.toContain("background-color: var(--sk-pink)");
    expect(cardBlock).toContain("border: 0");
    expect(cardBlock).toContain("border-radius: 0");
    expect(cardBlock).toContain("clip-path: var(--body-edge)");
    expect(cardBlock).not.toContain("height: calc(100% - 4px)");
    expect(motionSource).toContain("radius: 0");
  });
});
