import { describe, expect, it } from "vitest";

import {
  buildDiff2HtmlConfig,
  filterWhitespaceOnlyChanges,
  normalizePatchPreviewForDiff2Html,
  renderChangesetDiffHtml,
} from "./diffViewer.js";

const patchPreview = [
  "diff --git a/src/workflow.ts b/src/workflow.ts",
  "index 1111111..2222222 100644",
  "--- a/src/workflow.ts",
  "+++ b/src/workflow.ts",
  "@@ -1,5 +1,6 @@",
  " export function summarizeTurn() {",
  '-  return "old";',
  '+  const label = "review";',
  "+  return label;",
  " }",
  "@@ -20,3 +21,4 @@ export function validateEvidence() {",
  "   checkRunExit();",
  "+  checkChangedFiles();",
  " }",
  "diff --git a/.devflow/tasks/node-1/result.md b/.devflow/tasks/node-1/result.md",
  "index 3333333..4444444 100644",
  "--- a/.devflow/tasks/node-1/result.md",
  "+++ b/.devflow/tasks/node-1/result.md",
  "@@ -1,3 +1,4 @@",
  " # Result",
  "-Pending.",
  "+Completed with evidence.",
  "+Tests: pass.",
].join("\n");

describe("diff viewer parsing", () => {
  it("builds a bounded diff2html configuration from Changes view toggles", () => {
    expect(
      buildDiff2HtmlConfig({
        hideWhitespace: false,
        loadFullFiles: false,
        outputFormat: "side-by-side",
        richPreview: true,
        wordDiffs: true,
        wordWrap: true,
      }),
    ).toMatchObject({
      diffMaxChanges: 1200,
      diffMaxLineLength: 2400,
      diffStyle: "word",
      drawFileList: true,
      matching: "words",
      outputFormat: "side-by-side",
      renderNothingWhenEmpty: false,
    });
  });

  it("wraps loose patch lines as unified diff input for diff2html", () => {
    expect(normalizePatchPreviewForDiff2Html("+ Created report\n- Removed placeholder", ["notes/result.md"])).toBe(
      [
        "diff --git a/notes/result.md b/notes/result.md",
        "--- a/notes/result.md",
        "+++ b/notes/result.md",
        "@@ -1,1 +1,1 @@",
        "+ Created report",
        "- Removed placeholder",
      ].join("\n"),
    );
  });

  it("can suppress whitespace-only changed pairs before handing the patch to diff2html", () => {
    const patch = [
      "diff --git a/src/example.ts b/src/example.ts",
      "--- a/src/example.ts",
      "+++ b/src/example.ts",
      "@@ -1,3 +1,3 @@",
      "-const value = 1;",
      "+const   value = 1;",
      "-const label = 'old';",
      "+const label = 'new';",
    ].join("\n");

    const filtered = filterWhitespaceOnlyChanges(patch);

    expect(filtered).not.toContain("const   value");
    expect(filtered).toContain("const label = 'old'");
    expect(filtered).toContain("const label = 'new'");
  });

  it("renders sanitized diff2html markup through an injectable sanitizer", async () => {
    let sanitizerWasCalled = false;
    const html = await renderChangesetDiffHtml(
      `${patchPreview}\n+<img src=x onerror=alert(1)>`,
      ["src/workflow.ts"],
      {
        hideWhitespace: false,
        loadFullFiles: false,
        outputFormat: "line-by-line",
        richPreview: true,
        wordDiffs: false,
        wordWrap: false,
      },
      async (unsafeHtml) => {
        sanitizerWasCalled = true;
        return unsafeHtml.replace(/<script[\s\S]*?<\/script>/g, "");
      },
    );

    expect(sanitizerWasCalled).toBe(true);
    expect(html).toContain("d2h-file-list");
    expect(html).toContain("d2h-file-wrapper");
    expect(html).not.toContain("<img src=x");
    expect(html).toContain("&lt;img src=x onerror=alert(1)&gt;");
  });
});
