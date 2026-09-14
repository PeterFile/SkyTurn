import type { EditorKind } from "@skyturn/git-worktree";

export interface EditorLaunchOption {
  editor: EditorKind;
  label: string;
  iconText: string;
  tone: string;
}

export const DEFAULT_EDITOR_LAUNCH_OPTION: EditorLaunchOption = {
  editor: "zed",
  label: "Zed",
  iconText: "Z",
  tone: "zed",
};

export const EDITOR_LAUNCH_OPTIONS: EditorLaunchOption[] = [
  { editor: "vscode", label: "VS Code", iconText: "VS", tone: "vscode" },
  { editor: "cursor", label: "Cursor", iconText: "C", tone: "cursor" },
  DEFAULT_EDITOR_LAUNCH_OPTION,
  { editor: "finder", label: "Finder", iconText: "F", tone: "finder" },
];

export function isSupportedEditor(value: unknown): value is EditorKind {
  return typeof value === "string" && EDITOR_LAUNCH_OPTIONS.some((opt) => opt.editor === value);
}

export function resolveEditorSelection(persistedEditor?: unknown, overrideEditor?: unknown): EditorKind {
  if (isSupportedEditor(overrideEditor)) {
    return overrideEditor;
  }
  if (isSupportedEditor(persistedEditor)) {
    return persistedEditor;
  }
  return DEFAULT_EDITOR_LAUNCH_OPTION.editor;
}
