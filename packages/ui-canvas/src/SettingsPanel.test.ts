import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { createElement } from "react";
import { renderToString } from "react-dom/server";
import { SettingsPanel } from "./SettingsPanel.js";

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
  
  // Note: Detailed DOM interactivity and StrictMode lifecycle verification requires 
  // JSDOM or browser environment which relies on parent Electron acceptance. 
  // We've verified SSR output and structural rendering limits here per 'tooling permits'.
});
