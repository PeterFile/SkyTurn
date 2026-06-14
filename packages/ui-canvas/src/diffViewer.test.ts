import { describe, expect, it } from "vitest";

import { parseUnifiedDiff } from "./diffViewer.js";

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
  it("turns unified diffs into review files with hunk separators and line-numbered rows", () => {
    const diff = parseUnifiedDiff(patchPreview, ["src/workflow.ts"]);

    expect(diff.files).toHaveLength(2);
    expect(diff.totals).toEqual({ added: 5, deleted: 2 });

    const firstFile = diff.files[0];
    expect(firstFile.displayPath).toBe("src/workflow.ts");
    expect(firstFile.added).toBe(3);
    expect(firstFile.deleted).toBe(1);
    expect(firstFile.hunks).toHaveLength(2);
    expect(firstFile.hunks[0].header).toBe("@@ -1,5 +1,6 @@");

    expect(firstFile.hunks[0].rows.slice(0, 4)).toEqual([
      {
        kind: "context",
        oldNumber: 1,
        newNumber: 1,
        content: "export function summarizeTurn() {",
      },
      {
        kind: "removed",
        oldNumber: 2,
        newNumber: null,
        content: '  return "old";',
      },
      {
        kind: "added",
        oldNumber: null,
        newNumber: 2,
        content: '  const label = "review";',
      },
      {
        kind: "added",
        oldNumber: null,
        newNumber: 3,
        content: "  return label;",
      },
    ]);
  });

  it("falls back to a structured synthetic file instead of raw text for loose patch lines", () => {
    const diff = parseUnifiedDiff("+ Created report\n- Removed placeholder", ["notes/result.md"]);

    expect(diff.files).toHaveLength(1);
    expect(diff.files[0].displayPath).toBe("notes/result.md");
    expect(diff.files[0].hunks[0].header).toBe("Changes");
    expect(diff.files[0].hunks[0].rows).toEqual([
      {
        kind: "added",
        oldNumber: null,
        newNumber: 1,
        content: " Created report",
      },
      {
        kind: "removed",
        oldNumber: 1,
        newNumber: null,
        content: " Removed placeholder",
      },
    ]);
  });
});
