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

function lastCssRuleForSelector(styles: string, selector: string): string {
  const rules = Array.from(styles.matchAll(/(?:^|\n)([^{}]+) \{([\s\S]*?)\n\}/g));
  const matches = rules.filter((match) => {
    const selectorText = match[1].replace(/\/\*[\s\S]*?\*\//g, "");
    return selectorText.split(",").map((part) => part.trim()).includes(selector);
  });
  return matches.at(-1)?.[0] ?? "";
}

function exactCssBlockCount(styles: string, selector: string): number {
  return Array.from(styles.matchAll(/(?:^|\n)([^{}]+) \{[\s\S]*?\n\}/g)).filter((match) => {
    const selectorText = match[1].replace(/\/\*[\s\S]*?\*\//g, "").trim();
    return selectorText === selector;
  }).length;
}

describe("SkyTurn UI style tokens", () => {
  it("keeps one authoritative flat Plan cascade", async () => {
    const styles = await readSource("./styles.css");
    expect(styles.match(/Plan mode — flat single-column document surface/g) ?? []).toHaveLength(1);
    const planSelectors = [
      ".plan-view",
      ".plan-view-toggle",
      ".plan-document",
      ".plan-md-preview",
      ".plan-md-source",
      ".plan-composer",
      ".plan-composer-field",
      ".plan-composer-input",
      ".plan-composer-send",
    ];

    for (const selector of planSelectors) {
      expect(exactCssBlockCount(styles, selector), selector).toBe(1);
    }

    const planCascade = styles.slice(styles.indexOf("/* Plan mode — flat single-column document surface (final cascade). */"));
    expect(planCascade).toContain("grid-template-columns: minmax(0, 1fr) !important");
    expect(planCascade).toContain("width: min(100%, 48rem)");
    expect(planCascade).toContain("min-height: max(320px, 100%)");
    expect(planCascade).toContain("background: var(--sk-bg) !important");
    expect(planCascade).toContain("background: var(--sk-surface) !important");
    expect(planCascade).toContain("box-shadow: none !important");
    expect(planCascade).toContain("outline: 2px solid var(--sk-accent) !important");
    expect(planCascade).toContain("color: var(--sk-text-inverse-warm) !important");
    expect(planCascade).toContain("border-radius: var(--sk-radius-none)");
    expect(planCascade).toContain("border-radius: var(--sk-radius-xs)");
    expect(planCascade).toContain("border-radius: var(--sk-radius-sm)");
    expect(planCascade).toContain("border-radius: var(--sk-radius-md)");
    expect(planCascade).toContain("border-radius: var(--sk-radius-pill)");
    expect(planCascade).not.toMatch(/#[0-9a-f]{3,8}\b|rgba?\(/i);
    expect(planCascade).not.toMatch(/border-radius:\s*\d/);
    const shadowValues = Array.from(planCascade.matchAll(/box-shadow:\s*([^;]+);/g), (match) => match[1].trim());
    const backdropValues = Array.from(planCascade.matchAll(/backdrop-filter:\s*([^;]+);/g), (match) => match[1].trim());
    expect(shadowValues.every((value) => value === "none" || value === "none !important")).toBe(true);
    expect(backdropValues.every((value) => value === "none" || value === "none !important")).toBe(true);
    expect(planCascade).not.toContain("linear-gradient");
    expect(planCascade).not.toContain("grid-template-columns: 1fr 1fr");
  });

  it("keeps the Plan toolbar to one row on wide desktops and two explicit rows on compact desktops", async () => {
    const styles = await readSource("./styles.css");
    const baseCascade = styles.slice(
      styles.indexOf("/* Plan mode — flat single-column document surface (final cascade). */"),
      styles.indexOf("@media (max-width: 1099px)"),
    );
    const toolbar = lastCssBlock(baseCascade, ".plan-toolbar");
    const progress = lastCssBlock(baseCascade, ".plan-stage-progress");

    expect(toolbar).toContain("flex-wrap: nowrap");
    expect(progress).toContain("flex-wrap: nowrap");
    expect(baseCascade).toContain([
      ".plan-toolbar-actions,",
      ".plan-stage-actions {",
      "  display: flex;",
      "  flex-wrap: nowrap;",
    ].join("\n"));

    const compactDesktop = styles.slice(
      styles.indexOf("@media (max-width: 1099px)"),
      styles.indexOf("@media (max-width: 719px)"),
    );
    expect(compactDesktop).toContain(".plan-toolbar {");
    expect(compactDesktop).toContain("flex-wrap: wrap");
    expect(compactDesktop).toContain(".plan-stage-progress {");
    expect(compactDesktop).toContain("flex: 0 0 100%");
    expect(compactDesktop).toContain(".plan-toolbar-actions {");
    expect(compactDesktop).toContain("width: 100%");
    expect(compactDesktop).toContain("justify-content: flex-end");
    expect(compactDesktop).toContain("padding-inline: 4px");
  });

  it("keeps Plan primary button hover distinct without important overrides", async () => {
    const styles = await readSource("./styles.css");
    const primaryBase = lastCssRuleForSelector(styles, ".plan-stage-actions .plan-next-button");
    const primaryHover = lastCssRuleForSelector(styles, ".plan-stage-actions .plan-next-button:hover:not(:disabled)");

    expect(primaryBase).toContain("background: color-mix(");
    expect(primaryBase).toContain("var(--sk-accent)");
    expect(primaryBase).not.toContain("!important");
    expect(primaryHover).toContain("background: color-mix(");
    expect(primaryHover).toContain("var(--sk-accent)");
    expect(primaryHover).toContain("var(--sk-surface)");
    expect(primaryHover).not.toMatch(/#[0-9a-f]{3,8}\b|rgba?\(/i);
    expect(primaryHover).not.toContain("gradient");
    expect(primaryHover).not.toContain("box-shadow");
  });

  it("uses modern dark tokens instead of paper collage material tokens", async () => {
    const styles = await readSource("./styles.css");

    expect(styles).not.toContain("@fontsource-variable");
    expect(styles).not.toContain("Space Grotesk");
    expect(styles).toContain("--sk-bg: #151515");
    expect(styles).toContain("--sk-surface: #202021");
    expect(styles).toContain("--sk-text: #f2f2f2");
    expect(styles).toContain("--sk-accent: #a78bfa");
  });

  it("uses modern card proportions instead of oversized collage decoration", async () => {
    const styles = await readSource("./styles.css");
    const motionSource = await readSource("./motion.ts");

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

  it("renders the New Session composer as a modern form with a custom project listbox", async () => {
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
    const emptyStageBlock = lastCssBlock(styles, ".empty-stage");
    const intakeSheetBlock = lastCssBlock(styles, ".intake-sheet");
    const controlStripBlock = lastCssBlock(styles, ".control-strip");
    const projectListboxBlock = lastCssBlock(styles, ".project-dropdown-listbox");
    [emptyStageBlock, intakeSheetBlock, controlStripBlock, projectListboxBlock].forEach((block) => {
      if (block) {
        expect(block).not.toContain("background-color: #dceaff");
        expect(block).not.toContain("background-color: #eee7d8");
        expect(block).not.toContain("#758696");
        expect(block).not.toContain("background-color: #083176");
      }
    });
  });

  it("puts keyboard textarea focus on the outer New Session composer only", async () => {
    const styles = await readSource("./styles.css");
    const composerFocusBlock = lastCssRuleForSelector(
      styles,
      ".new-session-intake:has(.session-panel-input:focus-visible)",
    );
    const inputFocusBlock = lastCssRuleForSelector(
      styles,
      ".new-session-intake .session-panel-input:focus-visible",
    );

    expect(composerFocusBlock).toContain("box-shadow: 0 0 0 1px var(--sk-accent) !important");
    expect(styles).not.toContain(".new-session-intake:focus-within {");
    expect(styles).not.toContain(".new-session-intake .intake-sheet:focus-within {");
    expect(inputFocusBlock).toContain("border-color: transparent !important");
    expect(inputFocusBlock).toContain("box-shadow: none !important");
    expect(inputFocusBlock).toContain("outline: none !important");
  });

  it("keeps New Session listboxes above the intake form instead of clipping them", async () => {
    const styles = await readSource("./styles.css");
    const targetSelectorBlock = lastCssBlock(styles, ".target-selector-inner");
    const customSelectOpenBlock = lastCssBlock(styles, ".custom-select-dropdown.open");
    const projectDropdownOpenBlock = lastCssBlock(styles, ".project-dropdown.open");
    const customSelectListboxBlock = lastCssRuleForSelector(styles, ".custom-select-listbox");
    const customSelectActiveBlock = lastCssRuleForSelector(styles, ".custom-select-option.active");
    const projectOptionActiveBlock = lastCssRuleForSelector(styles, ".project-option.active");

    expect(targetSelectorBlock).not.toContain("clip-path");
    expect(styles).toContain(".target-selector-inner::before");
    expect(styles).toContain(".control-strip-row:first-child");
    expect(customSelectOpenBlock).toContain("z-index:");
    expect(projectDropdownOpenBlock).toContain("z-index:");
    expect(customSelectListboxBlock).toContain("background: var(--sk-surface) !important");
    expect(customSelectListboxBlock).toContain("clip-path: none !important");
    expect(customSelectListboxBlock).not.toContain("var(--sk-paper");
    expect(customSelectActiveBlock).toContain("background: var(--sk-white) !important");
    expect(projectOptionActiveBlock).toContain("background: var(--sk-white) !important");
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
    expect(appSource).toContain("No structured change evidence recorded.");
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

  it("keeps sidebar controls visible and renders modern cards inside their energy frame", async () => {
    const styles = await readSource("./styles.css");
    const motionSource = await readSource("./motion.ts");
    const sidebarToggleBlock = styles.match(/\.sidebar-toggle \{[\s\S]*?\n\}/)?.[0] ?? "";
    const sidebarHoverBlock = styles.match(/\.sidebar-project-row:hover,[\s\S]*?\.sidebar-settings:hover \{[\s\S]*?\n\}/)?.[0] ?? "";
    const hardResetBlock = styles.slice(styles.lastIndexOf("/* Neutral modern workflow styles. */"));
    const cardBlock = lastCssBlock(styles, ".agent-card");
    const composerBlock = lastCssRuleForSelector(styles, ".canvas-composer");

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
    const sidebarBlock = lastCssBlock(styles, ".sidebar");
    const topbarBlock = lastCssBlock(styles, ".topbar");
    const cardHoverBlock = sidebarHoverBlock; // Using the parsed one

    [sidebarBlock, topbarBlock, cardHoverBlock].forEach(block => {
      if (block) {
        expect(block).not.toContain("background-image: var(--sk-paper-white)");
        expect(block).not.toContain("background-image: var(--sk-paper-cobalt)");
        expect(block).not.toContain("background-image: var(--sk-paper-rip-white)");
      }
    });
    expect(hardResetBlock).toContain(".agent-node-shell::before");
    expect(hardResetBlock).toContain("display: none !important");
    expect(cardBlock).toContain("border: 0");
    expect(composerBlock).not.toContain("clip-path: polygon");
    expect(motionSource).toContain("radius: 0");
  });

  it("renders node/canvas evidence surfaces with modern dark neutral tokens", async () => {
    const styles = await readSource("./styles.css");
    expect(styles).not.toContain('url("./assets/paper/');
    const finalSurfaceSection = styles.slice(styles.lastIndexOf("/* Neutral modern workflow styles. */"));
    const modalActionHoverBlock = lastCssRuleForSelector(styles, ".modal-actions button:hover:not(:disabled)");
    const targetBadgeBlock = lastCssRuleForSelector(styles, ".agent-node-target-badge");
    const selectedActionBlock = lastCssRuleForSelector(styles, ".action-chip.selected");
    const selectors = [
      ".canvas-stage",
      ".agent-node-shell",
      ".agent-card",
      ".agent-node-menu",
      ".agent-status-chip",
      ".agent-identity-pill",
      ".agent-footer",
      ".runtime-phase-pill",
      ".evidence-marker",
      ".node-modal",
      ".modal-header",
      ".tab-list",
      ".tab-button",
      ".output-panel",
      ".context-panel",
      ".changes-review",
      ".diff2html-shell",
      ".canvas-composer",
      ".canvas-composer-shell",
    ];

    for (const selector of selectors) {
      const block = lastCssRuleForSelector(styles, selector);
      expect(block).toBeTruthy();
      expect(block).not.toContain("var(--sk-paper-white)");
      expect(block).not.toContain("clip-path: polygon");
    }

    expect(finalSurfaceSection).toContain("#151515");
    expect(finalSurfaceSection).toContain("#1b1b1c");
    expect(finalSurfaceSection).toContain("#202021");
    expect(finalSurfaceSection).toContain("#2a2a2b");
    expect(finalSurfaceSection).toContain("#343435");
    expect(finalSurfaceSection).toContain("#f2f2f2");
    expect(finalSurfaceSection).toContain("#8a8a91");
    expect(finalSurfaceSection).toContain("--sk-status-completed-text: #7dd3a8");
    expect(finalSurfaceSection).toContain("--sk-status-failed-text: #ff8a80");
    expect(finalSurfaceSection).toContain("--sk-status-retrying: #f0b76b");
    expect(finalSurfaceSection).not.toContain("clip-path: polygon");
    expect(finalSurfaceSection).not.toContain("color: var(--sk-paper-white");
    expect(modalActionHoverBlock).toContain("background: var(--sk-white) !important");
    expect(modalActionHoverBlock).toContain("color: var(--sk-text) !important");
    expect(targetBadgeBlock).toContain("color: #111111 !important");
    expect(selectedActionBlock).toContain("color: #111111 !important");
    expect(styles).toContain(".canvas-stage.has-selected-node .canvas-composer-shell {\n  transform: none !important;\n}");

    const hiddenPseudoSelectors = [
      ".agent-node-shell::before",
      ".agent-node-shell::after",
      ".agent-card::before",
      ".agent-card::after",
      ".sidebar::after",
      ".node-modal::before",
      ".node-modal::after",
      ".canvas-composer-shell::before",
      ".canvas-composer::after",
      ".intake-sheet::before",
      ".control-strip::before",
      ".control-strip::after",
      ".target-selector-inner::before",
      ".project-dropdown-listbox::before"
    ];

    for (const selector of hiddenPseudoSelectors) {
      const block = lastCssRuleForSelector(styles, selector);
      expect(block).toBeTruthy();
      expect(block).toContain("display: none");
    }
  });
});
