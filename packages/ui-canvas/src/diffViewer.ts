export type DiffRowKind = "context" | "added" | "removed";

export interface ReviewDiffRow {
  kind: DiffRowKind;
  oldNumber: number | null;
  newNumber: number | null;
  content: string;
}

export interface ReviewDiffHunk {
  header: string;
  rows: ReviewDiffRow[];
}

export interface ReviewDiffFile {
  id: string;
  oldPath: string;
  newPath: string;
  displayPath: string;
  added: number;
  deleted: number;
  hunks: ReviewDiffHunk[];
}

export interface ReviewDiff {
  files: ReviewDiffFile[];
  totals: {
    added: number;
    deleted: number;
  };
}

interface MutableDiffFile extends ReviewDiffFile {
  hunks: MutableDiffHunk[];
}

interface MutableDiffHunk extends ReviewDiffHunk {
  oldLine: number;
  newLine: number;
}

export function parseUnifiedDiff(patchPreview: string, fallbackFiles: string[] = []): ReviewDiff {
  const files: MutableDiffFile[] = [];
  let currentFile: MutableDiffFile | null = null;
  let currentHunk: MutableDiffHunk | null = null;

  for (const line of patchPreview.split(/\r?\n/)) {
    if (line.startsWith("diff --git ")) {
      currentFile = createFileFromDiffHeader(line, files.length);
      files.push(currentFile);
      currentHunk = null;
      continue;
    }

    if (line.startsWith("--- ") && currentFile) {
      currentFile.oldPath = normalizeDiffPath(line.slice(4));
      currentFile.displayPath = displayPathForFile(currentFile);
      continue;
    }

    if (line.startsWith("+++ ") && currentFile) {
      currentFile.newPath = normalizeDiffPath(line.slice(4));
      currentFile.displayPath = displayPathForFile(currentFile);
      continue;
    }

    if (line.startsWith("@@")) {
      if (!currentFile) {
        currentFile = createSyntheticFile(fallbackFiles[0] ?? "changes.patch", files.length);
        files.push(currentFile);
      }
      currentHunk = createHunk(line);
      currentFile.hunks.push(currentHunk);
      continue;
    }

    if (!currentFile || !currentHunk || line.startsWith("\\ No newline")) continue;
    appendDiffRow(currentFile, currentHunk, line);
  }

  const parsedFiles: ReviewDiffFile[] = files.filter((file) => file.hunks.some((hunk) => hunk.rows.length > 0));
  if (parsedFiles.length === 0 && patchPreview.trim()) {
    parsedFiles.push(createLoosePatchFile(patchPreview, fallbackFiles[0] ?? "changes.patch"));
  }

  return {
    files: parsedFiles,
    totals: parsedFiles.reduce(
      (totals, file) => ({
        added: totals.added + file.added,
        deleted: totals.deleted + file.deleted,
      }),
      { added: 0, deleted: 0 },
    ),
  };
}

function createFileFromDiffHeader(line: string, index: number): MutableDiffFile {
  const match = /^diff --git a\/(.+) b\/(.+)$/.exec(line);
  const oldPath = match?.[1] ?? `file-${index + 1}`;
  const newPath = match?.[2] ?? oldPath;
  return {
    id: `${index}-${newPath}`,
    oldPath,
    newPath,
    displayPath: newPath,
    added: 0,
    deleted: 0,
    hunks: [],
  };
}

function createSyntheticFile(path: string, index: number): MutableDiffFile {
  return {
    id: `${index}-${path}`,
    oldPath: path,
    newPath: path,
    displayPath: path,
    added: 0,
    deleted: 0,
    hunks: [],
  };
}

function createHunk(header: string): MutableDiffHunk {
  const match = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/.exec(header);
  return {
    header,
    oldLine: Number(match?.[1] ?? 1),
    newLine: Number(match?.[2] ?? 1),
    rows: [],
  };
}

function appendDiffRow(file: MutableDiffFile, hunk: MutableDiffHunk, line: string): void {
  if (line.startsWith("+") && !line.startsWith("+++")) {
    hunk.rows.push({
      kind: "added",
      oldNumber: null,
      newNumber: hunk.newLine,
      content: line.slice(1),
    });
    hunk.newLine += 1;
    file.added += 1;
    return;
  }

  if (line.startsWith("-") && !line.startsWith("---")) {
    hunk.rows.push({
      kind: "removed",
      oldNumber: hunk.oldLine,
      newNumber: null,
      content: line.slice(1),
    });
    hunk.oldLine += 1;
    file.deleted += 1;
    return;
  }

  const content = line.startsWith(" ") ? line.slice(1) : line;
  hunk.rows.push({
    kind: "context",
    oldNumber: hunk.oldLine,
    newNumber: hunk.newLine,
    content,
  });
  hunk.oldLine += 1;
  hunk.newLine += 1;
}

function createLoosePatchFile(patchPreview: string, path: string): ReviewDiffFile {
  const file = createSyntheticFile(path, 0);
  const hunk: MutableDiffHunk = { header: "Changes", oldLine: 1, newLine: 1, rows: [] };
  file.hunks.push(hunk);

  for (const line of patchPreview.split(/\r?\n/).filter(Boolean)) {
    appendDiffRow(file, hunk, line);
  }

  return file;
}

function normalizeDiffPath(path: string): string {
  const trimmed = path.trim();
  if (trimmed === "/dev/null") return trimmed;
  return trimmed.replace(/^[ab]\//, "");
}

function displayPathForFile(file: Pick<ReviewDiffFile, "oldPath" | "newPath">): string {
  if (file.newPath && file.newPath !== "/dev/null") return file.newPath;
  return file.oldPath;
}
