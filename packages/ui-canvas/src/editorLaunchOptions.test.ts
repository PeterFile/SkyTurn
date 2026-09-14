import { describe, expect, it } from "vitest";

import { DEFAULT_EDITOR_LAUNCH_OPTION, EDITOR_LAUNCH_OPTIONS, resolveEditorSelection } from "./editorLaunchOptions.js";

describe("editor launch menu options", () => {
  it("keeps the menu aligned with the compact open-with control", () => {
    expect(EDITOR_LAUNCH_OPTIONS.map(({ editor, label }) => [editor, label])).toEqual([
      ["vscode", "VS Code"],
      ["cursor", "Cursor"],
      ["zed", "Zed"],
      ["finder", "Finder"],
    ]);
    expect(DEFAULT_EDITOR_LAUNCH_OPTION.editor).toBe("zed");
  });

  describe("resolveEditorSelection", () => {
    it("returns explicit override if provided and supported, regardless of persistence", () => {
      expect(resolveEditorSelection("vscode", "cursor")).toBe("cursor");
      expect(resolveEditorSelection("iterm2", "finder")).toBe("finder");
      expect(resolveEditorSelection(undefined, "vscode")).toBe("vscode");
    });

    it("ignores override if unsupported and falls back to persisted or default", () => {
      expect(resolveEditorSelection("vscode", "iterm2")).toBe("vscode");
      expect(resolveEditorSelection("unsupported", "invalid")).toBe("zed");
      expect(resolveEditorSelection(undefined, "invalid")).toBe("zed");
      expect(resolveEditorSelection("cursor", null)).toBe("cursor");
    });

    it("returns persisted editor if supported", () => {
      expect(resolveEditorSelection("vscode")).toBe("vscode");
      expect(resolveEditorSelection("cursor")).toBe("cursor");
      expect(resolveEditorSelection("zed")).toBe("zed");
      expect(resolveEditorSelection("finder")).toBe("finder");
    });

    it("falls back to zed if persisted editor is missing or unsupported", () => {
      for (const value of [undefined, null, "", "notepad", "antigravity", "terminal", "iterm2", "xcode", {}, 42]) {
        expect(resolveEditorSelection(value)).toBe("zed");
      }
    });
  });
});
