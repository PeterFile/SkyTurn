import type { Diff2HtmlConfig } from "diff2html";

export type ChangesDiffOutputFormat = "line-by-line" | "side-by-side";

export interface ChangesDiffViewOptions {
  hideWhitespace: boolean;
  loadFullFiles: boolean;
  outputFormat: ChangesDiffOutputFormat;
  richPreview: boolean;
  wordDiffs: boolean;
  wordWrap: boolean;
}

export type DiffHtmlSanitizer = (unsafeHtml: string) => Promise<string> | string;

export const DEFAULT_CHANGES_DIFF_OPTIONS: ChangesDiffViewOptions = {
  hideWhitespace: false,
  loadFullFiles: false,
  outputFormat: "line-by-line",
  richPreview: true,
  wordDiffs: true,
  wordWrap: false,
};

const BOUNDED_DIFF_MAX_CHANGES = 1200;
const BOUNDED_DIFF_MAX_LINE_LENGTH = 2400;

export function buildDiff2HtmlConfig(options: ChangesDiffViewOptions): Diff2HtmlConfig {
  return {
    diffMaxChanges: options.loadFullFiles ? undefined : BOUNDED_DIFF_MAX_CHANGES,
    diffMaxLineLength: options.loadFullFiles ? undefined : BOUNDED_DIFF_MAX_LINE_LENGTH,
    diffStyle: "word",
    drawFileList: options.richPreview,
    matching: options.wordDiffs ? "words" : "lines",
    matchingMaxComparisons: options.wordDiffs ? 1200 : 2500,
    maxLineLengthHighlight: 2000,
    maxLineSizeInBlockForComparison: 200,
    outputFormat: options.outputFormat,
    renderNothingWhenEmpty: false,
  };
}

export async function renderChangesetDiffHtml(
  patchPreview: string,
  files: string[],
  options: ChangesDiffViewOptions,
  sanitizeHtml: DiffHtmlSanitizer = sanitizeDiffHtml,
): Promise<string> {
  const normalizedPatch = normalizePatchPreviewForDiff2Html(patchPreview, files);
  const diffInput = options.hideWhitespace ? filterWhitespaceOnlyChanges(normalizedPatch) : normalizedPatch;
  if (!diffInput.trim()) return "";

  const { html } = await import("diff2html");
  const unsafeHtml = html(diffInput, buildDiff2HtmlConfig(options));
  return sanitizeHtml(unsafeHtml);
}

export function normalizePatchPreviewForDiff2Html(patchPreview: string, fallbackFiles: string[] = []): string {
  const trimmedPatch = patchPreview.trim();
  if (!trimmedPatch) return "";
  if (looksLikeUnifiedDiff(trimmedPatch)) return patchPreview;

  const displayPath = fallbackFiles[0] ?? "changes.patch";
  const diffLines = trimmedPatch.split(/\r?\n/).map(normalizeLoosePatchLine);
  const oldLineCount = countSyntheticHunkLines(diffLines, "old");
  const newLineCount = countSyntheticHunkLines(diffLines, "new");

  return [
    `diff --git a/${displayPath} b/${displayPath}`,
    `--- a/${displayPath}`,
    `+++ b/${displayPath}`,
    `@@ -${formatSyntheticRange(oldLineCount)} +${formatSyntheticRange(newLineCount)} @@`,
    ...diffLines,
  ].join("\n");
}

export function filterWhitespaceOnlyChanges(patchPreview: string): string {
  const lines = patchPreview.split(/\r?\n/);
  const keptLines: string[] = [];

  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index] ?? "";
    const nextLine = lines[index + 1] ?? "";
    if (isWhitespaceOnlyChangePair(line, nextLine)) {
      index += 1;
      continue;
    }
    keptLines.push(line);
  }

  return keptLines.join("\n");
}

async function sanitizeDiffHtml(unsafeHtml: string): Promise<string> {
  const { default: DOMPurify } = await import("dompurify");
  return DOMPurify.sanitize(unsafeHtml, {
    FORBID_ATTR: ["style"],
    FORBID_TAGS: ["style"],
    USE_PROFILES: { html: true },
  });
}

function looksLikeUnifiedDiff(patchPreview: string): boolean {
  return /(^|\n)(diff --git |--- |\+\+\+ |@@ )/.test(patchPreview) && /(^|\n)@@ /.test(patchPreview);
}

function normalizeLoosePatchLine(line: string): string {
  if (line.startsWith("+") || line.startsWith("-") || line.startsWith(" ") || line.startsWith("\\")) return line;
  return ` ${line}`;
}

function countSyntheticHunkLines(lines: string[], side: "old" | "new"): number {
  const count = lines.reduce((total, line) => {
    if (isAddedLine(line)) return side === "new" ? total + 1 : total;
    if (isRemovedLine(line)) return side === "old" ? total + 1 : total;
    return total + 1;
  }, 0);

  return Math.max(count, 1);
}

function formatSyntheticRange(lineCount: number): string {
  return lineCount === 1 ? "1,1" : `1,${lineCount}`;
}

function isWhitespaceOnlyChangePair(line: string, nextLine: string): boolean {
  if (!isRemovedLine(line) || !isAddedLine(nextLine)) return false;
  return normalizeWhitespaceChange(line.slice(1)) === normalizeWhitespaceChange(nextLine.slice(1));
}

function normalizeWhitespaceChange(value: string): string {
  return value.replace(/\s+/g, "");
}

function isAddedLine(line: string): boolean {
  return line.startsWith("+") && !line.startsWith("+++");
}

function isRemovedLine(line: string): boolean {
  return line.startsWith("-") && !line.startsWith("---");
}
