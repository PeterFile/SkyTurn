import { describe, expect, it, vi } from "vitest";
import { html, parse } from "diff2html";

const purifier = vi.hoisted(() => ({ sanitize: vi.fn((value: string) => `purified:${value}`) }));
vi.mock("dompurify", () => ({ default: purifier }));

import {
  buildDiff2HtmlConfig,
  DEFAULT_CHANGES_DIFF_OPTIONS,
  filterWhitespaceOnlyChanges,
  normalizePatchPreviewForDiff2Html,
  renderChangesetDiffHtml,
  renderChangesetDiffHtmlPreview,
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

const pathPatch = [
  'diff --git a/src/Old [draft].txt b/docs/新 文档.txt',
  'similarity index 100%',
  'rename from src/Old [draft].txt',
  'rename to docs/新 文档.txt',
  'diff --git a/deleted.txt b/deleted.txt',
  'deleted file mode 100644',
  '--- a/deleted.txt',
  '+++ /dev/null',
  '@@ -1 +0,0 @@',
  '-removed',
  'diff --git a/new+file.txt b/new+file.txt',
  'new file mode 100644',
  '--- /dev/null',
  '+++ b/new+file.txt',
  '@@ -0,0 +1 @@',
  '+added',
  'diff --git a/asset.bin b/asset.bin',
  'index 1111111..2222222 100644',
  'Binary files a/asset.bin and b/asset.bin differ',
].join('\n');

describe("display-only parsed file filtering", () => {
  it.each(["OLD [DRAFT]", "新 文档", "deleted.txt", "new+file", "ASSET.BIN"])(
    "matches literal old or new parsed names: %s", async (query) => {
      const files = ["docs/新 文档.txt", "deleted.txt", "new+file.txt", "asset.bin"];
      Object.freeze(files);
      const source = pathPatch;
      const sanitize = vi.fn((value: string) => value);
      const result = await renderChangesetDiffHtmlPreview(pathPatch, files, DEFAULT_CHANGES_DIFF_OPTIONS, query, sanitize);
      expect(result).toMatchObject({ visibleFiles: 1, totalFiles: 4 });
      const selected = parse(pathPatch).filter(file => [file.oldName, file.newName].some(name => name.toLowerCase().includes(query.toLowerCase())));
      expect(result.html).toBe(html(selected, buildDiff2HtmlConfig(DEFAULT_CHANGES_DIFF_OPTIONS)));
      expect(sanitize).toHaveBeenCalledTimes(1);
      expect(pathPatch).toBe(source);
      expect(files).toEqual(["docs/新 文档.txt", "deleted.txt", "new+file.txt", "asset.bin"]);
    },
  );

  it.each([".*", "*.txt", "[", " "])("does not interpret or trim literal query %j", async (query) => {
    const result = await renderChangesetDiffHtmlPreview(pathPatch, [], DEFAULT_CHANGES_DIFF_OPTIONS, query, value => value);
    expect(result.visibleFiles).toBe(query === "[" || query === " " ? 1 : 0);
    expect(result.totalFiles).toBe(4);
    if (!result.visibleFiles) expect(result.html).toBe("");
  });

  it("restores all parsed blocks for an empty query and preserves the old API", async () => {
    const sanitize = (value: string) => value;
    const options = { ...DEFAULT_CHANGES_DIFF_OPTIONS, outputFormat: "side-by-side" as const, richPreview: false, wordDiffs: false, hideWhitespace: true, loadFullFiles: true, wordWrap: true };
    const result = await renderChangesetDiffHtmlPreview(pathPatch, [], options, "", sanitize);
    expect(result).toMatchObject({ visibleFiles: 4, totalFiles: 4 });
    expect(result.html).toContain("d2h-file-side-diff");
    expect(result.html).not.toContain("d2h-file-list");
    expect(await renderChangesetDiffHtml(pathPatch, [], options, sanitize)).toBe(result.html);
    expect(await renderChangesetDiffHtml(patchPreview, [], DEFAULT_CHANGES_DIFF_OPTIONS, sanitize))
      .toBe(html(patchPreview, buildDiff2HtmlConfig(DEFAULT_CHANGES_DIFF_OPTIONS)));
  });

  it("preserves metadata-only blocks and counts preview blocks rather than evidence files", async () => {
    const binary = pathPatch.slice(pathPatch.indexOf("diff --git a/asset.bin"));
    expect(normalizePatchPreviewForDiff2Html(binary)).toBe(binary);
    const result = await renderChangesetDiffHtmlPreview(binary, ["asset.bin", "omitted-by-bounds.txt"], DEFAULT_CHANGES_DIFF_OPTIONS, "asset", value => value);
    expect(result).toMatchObject({ visibleFiles: 1, totalFiles: 1 });
    expect(result.html).toContain("Binary file");
    expect(result.html).not.toContain("omitted-by-bounds");
  });

  it("distinguishes no patch from no match", async () => {
    expect(await renderChangesetDiffHtmlPreview("", ["evidence.txt"], DEFAULT_CHANGES_DIFF_OPTIONS, "x"))
      .toEqual({ html: "", visibleFiles: 0, totalFiles: 0 });
    expect(await renderChangesetDiffHtmlPreview(pathPatch, [], DEFAULT_CHANGES_DIFF_OPTIONS, "absent", value => value))
      .toEqual({ html: "", visibleFiles: 0, totalFiles: 4 });
  });

  it("escapes hostile file and hunk text before invoking the sanitizer", async () => {
    const hostile = patchPreview.replaceAll("src/workflow.ts", "src/<script>alert(1)</script>.ts")
      .replace('+  return label;', '+  return "<img src=x onerror=alert(1)>";');
    const sanitize = vi.fn((value: string) => `sanitized:${value}`);
    const result = await renderChangesetDiffHtmlPreview(hostile, [], DEFAULT_CHANGES_DIFF_OPTIONS, "<script>", sanitize);
    expect(sanitize).toHaveBeenCalledOnce();
    expect(result.html).toContain("sanitized:");
    expect(result.html).not.toContain("<script>");
    expect(result.html).not.toContain("<img src=x");
    expect(result.html).toContain("&lt;script&gt;");
    expect(result.html).toContain("&lt;img src=x onerror=alert(1)&gt;");
  });

  it("keeps the default DOMPurify boundary and its restrictions for filtered output", async () => {
    purifier.sanitize.mockClear();
    const result = await renderChangesetDiffHtmlPreview(pathPatch, [], DEFAULT_CHANGES_DIFF_OPTIONS, "deleted");
    expect(result.html).toMatch(/^purified:/);
    expect(purifier.sanitize).toHaveBeenCalledWith(expect.stringContaining("d2h-file-wrapper"), {
      FORBID_ATTR: ["style"], FORBID_TAGS: ["style"], USE_PROFILES: { html: true },
    });
  });
});
