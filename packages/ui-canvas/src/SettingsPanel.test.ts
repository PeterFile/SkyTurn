import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { createElement } from "react";
import { renderToString } from "react-dom/server";
import { SettingsPanel, computeSettingsSavePayload } from "./SettingsPanel.js";
import type { SettingsSnapshot } from "@skyturn/persistence";

describe("SettingsPanel", () => {
  let mockGet: any;
  let mockSave: any;

  beforeEach(() => {
    mockGet = vi.fn().mockResolvedValue({
      projectRoot: "/mock/root",
      settings: {
        app: { executableOverrides: { hermes: null, codex: null }, defaultExecutor: "codex", externalEditor: "zed", notifications: { desktop: false, sound: false } },
        project: { commands: { start: "", test: "", build: "" }, defaultExecutionTarget: { executionTarget: "current_branch", selectedBranch: "main" } }
      },
      prerequisites: {
        project: { git: { currentBranch: "main" } },
        agents: [ { kind: "hermes", cli: "ready", auth: "available", runnable: true, supportLevel: "supported-run" } ]
      }
    });
    mockSave = vi.fn().mockResolvedValue({});
    (globalThis as any).window = {
      devflow: {
        settings: {
          get: mockGet,
          save: mockSave,
        },
      },
    };
  });

  afterEach(() => {
    vi.clearAllMocks();
    delete (globalThis as any).window.devflow;
  });

  it("handles missing desktop API visibly on SSR", () => {
    delete (globalThis as any).window.devflow;
    const html = renderToString(createElement(SettingsPanel, { projectRoot: "/mock/root", onClose: () => {} }));
    expect(html).toContain("Desktop settings API is missing");
    expect(html).toContain("role=\"alert\"");
  });

  it("renders loading state initially during SSR", () => {
    const html = renderToString(createElement(SettingsPanel, { projectRoot: "/mock/root", onClose: () => {} }));
    expect(html).toContain("Loading...");
    expect(html).not.toContain("role=\"alert\"");
  });

  describe("computeSettingsSavePayload", () => {
    const baseSnapshot: SettingsSnapshot = {
      protocolVersion: 1,
      projectRoot: "/mock/root",
      settings: {
        app: {
          executableOverrides: { hermes: null, codex: "/old/codex" },
          defaultExecutor: "hermes",
          externalEditor: "iterm2",
          notifications: { desktop: true, sound: true },
        },
        project: {
          commands: { start: "pnpm start", test: "pnpm test", build: "pnpm build" },
          defaultExecutionTarget: { executionTarget: "new_worktree", selectedBranch: "develop", baseRef: "main" },
        },
      },
      prerequisites: {
        project: {
          registered: true,
          canonicalRootPath: "/mock/root",
          git: { status: "ready", currentBranch: "main", branches: ["main", "develop"] },
        },
        agents: [],
        defaultExecutorRunnable: true,
      },
    };

    it("preserves all settings including unsupported persisted editor without drafts", () => {
      const before = structuredClone(baseSnapshot.settings);
      expect(computeSettingsSavePayload(baseSnapshot, {})).toEqual(before);
      expect(baseSnapshot.settings).toEqual(before);
    });

    it("applies only drafts and resets empty overrides without mutating the snapshot", () => {
      const before = structuredClone(baseSnapshot.settings);
      const result = computeSettingsSavePayload(baseSnapshot, {
        externalEditor: "cursor",
        codexOverride: "",
        hermesOverride: "/new/hermes",
      });
      expect(result).toEqual({
        ...before,
        app: {
          ...before.app,
          externalEditor: "cursor",
          executableOverrides: { hermes: "/new/hermes", codex: null },
        },
      });
      expect(baseSnapshot.settings).toEqual(before);
    });
  });
});
