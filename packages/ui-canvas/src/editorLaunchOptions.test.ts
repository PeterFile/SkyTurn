import { describe, expect, it } from "vitest";

import { DEFAULT_EDITOR_LAUNCH_OPTION, EDITOR_LAUNCH_OPTIONS } from "./editorLaunchOptions.js";

describe("editor launch menu options", () => {
  it("keeps the menu aligned with the compact open-with control", () => {
    expect(EDITOR_LAUNCH_OPTIONS.map(({ editor, label }) => [editor, label])).toEqual([
      ["vscode", "VS Code"],
      ["zed", "Zed"],
      ["antigravity", "Antigravity"],
      ["finder", "Finder"],
      ["terminal", "Terminal"],
      ["iterm2", "iTerm2"],
      ["xcode", "Xcode"],
    ]);
    expect(DEFAULT_EDITOR_LAUNCH_OPTION.editor).toBe("zed");
  });
});
