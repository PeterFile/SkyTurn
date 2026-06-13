import type { EditorKind } from "@skyturn/git-worktree";

export interface EditorLaunchOption {
  editor: EditorKind;
  label: string;
  iconText: string;
  tone: string;
}

export const EDITOR_LAUNCH_OPTIONS: EditorLaunchOption[] = [
  { editor: "vscode", label: "VS Code", iconText: "VS", tone: "vscode" },
  { editor: "zed", label: "Zed", iconText: "Z", tone: "zed" },
  { editor: "antigravity", label: "Antigravity", iconText: "A", tone: "antigravity" },
  { editor: "finder", label: "Finder", iconText: "F", tone: "finder" },
  { editor: "terminal", label: "Terminal", iconText: ">", tone: "terminal" },
  { editor: "iterm2", label: "iTerm2", iconText: "i2", tone: "iterm2" },
  { editor: "xcode", label: "Xcode", iconText: "X", tone: "xcode" },
];

export const DEFAULT_EDITOR_LAUNCH_OPTION = EDITOR_LAUNCH_OPTIONS[1] ?? EDITOR_LAUNCH_OPTIONS[0];
