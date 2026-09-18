import { beforeEach, describe, expect, it, vi } from "vitest";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { ArtifactView, RunArtifacts, createArtifactViewController, type ArtifactViewProps } from "./RunArtifacts.js";

function setup(patch: Partial<ArtifactViewProps> = {}) {
  let props: ArtifactViewProps = { projectRoot: "/tmp/project", sessionId: "session-1", nodeId: "node-1", runId: "run-1", artifactPath: "test.png", ...patch };
  const changed = vi.fn();
  const controller = createArtifactViewController(() => props, changed);
  const unmount = controller.mount();
  return { controller, changed, unmount, props, update: (next: Partial<ArtifactViewProps>) => { props = { ...props, ...next }; } };
}

describe("RunArtifacts", () => {
  beforeEach(() => {
    (globalThis as any).window = {
      devflow: {
        artifacts: {
          read: vi.fn().mockResolvedValue({
            protocolVersion: 1,
            ok: true,
            artifact: { artifactPath: "test.png", name: "test.png", type: "png", runId: "run-1", status: "succeeded", byteLength: 100 },
            contentIdentity: "current-file-unhashed",
            content: { encoding: "base64", mimeType: "image/png", base64: "test", width: 100, height: 100 }
          })
        }
      }
    };
  });

  it("renders RunArtifacts empty state and rejects mismatched runId", () => {
    const html = renderToStaticMarkup(createElement(RunArtifacts, {
      projectRoot: "/tmp/project",
      session: { id: "session-1", projectId: "project-1", title: "Test", goal: "Test", mode: "fast", kind: "canvas", target: { executionTarget: "current_branch", selectedBranch: "main" }, createdAt: "", updatedAt: "", nodes: [], edges: [] },
      node: { id: "node-1", type: "agent", agent: "Hermes", context: { brief: "", sessionGoal: "", dependencies: [], constraints: [], requirementDecisions: [], designDecisions: [], taskDecisions: [] }, worktree: { executionTarget: "current_branch" }, runId: "node-run-latest", position: { x: 0, y: 0 }, data: { label: "" }, status: "completed", progress: "", output: [], createdAt: "", updatedAt: "" },
      runEvidence: { runId: "stale-run", status: "succeeded", checks: [], artifacts: ["test.png"], review: null },
    } as any));
    expect(html).toContain("No registered artifacts");
  });

  it("ArtifactViewController handles missing API and returns UNAVAILABLE without throwing", async () => {
    (globalThis as any).window.devflow = {}; // Missing artifacts API
    const { controller, changed } = setup();
    
    expect(changed).toHaveBeenCalled();
    expect(controller.state.result).toEqual(expect.objectContaining({
      ok: false,
      code: "UNAVAILABLE",
      message: "Artifacts API is not available"
    }));
  });

  it("ArtifactViewController calls backend and resolves async response correctly", async () => {
    let resolveRead: (val: any) => void;
    (globalThis as any).window.devflow.artifacts.read = vi.fn().mockReturnValue(new Promise(r => resolveRead = r));

    const { controller, changed } = setup();

    expect(controller.state.loading).toBe(true);
    expect(controller.state.result).toBe(null);

    resolveRead!({
      protocolVersion: 1,
      ok: true,
      artifact: { artifactPath: "test.png", name: "test.png", type: "png", runId: "run-1", status: "succeeded", byteLength: 100 },
      contentIdentity: "current-file-unhashed",
      content: { encoding: "base64", mimeType: "image/png", base64: "test", width: 100, height: 100 }
    });

    await Promise.resolve(); // flush microtasks

    expect(changed).toHaveBeenCalled();
    expect(controller.state.loading).toBe(false);
    expect(controller.state.result?.ok).toBe(true);
    if (controller.state.result?.ok) {
      expect(controller.state.result.contentIdentity).toBe("current-file-unhashed");
    }
  });

  it("ArtifactViewController handles mount/unmount cleanly without updating state if unmounted early", async () => {
    let resolveRead: (val: any) => void;
    (globalThis as any).window.devflow.artifacts.read = vi.fn().mockReturnValue(new Promise(r => resolveRead = r));

    const { controller, unmount, changed } = setup();
    changed.mockClear();

    unmount(); // Unmount before promise resolves

    resolveRead!({ protocolVersion: 1, ok: true, artifact: {} as any, contentIdentity: "test", content: {} as any });
    await Promise.resolve();

    expect(changed).not.toHaveBeenCalled();
    expect(controller.state.result).toBe(null);
  });

  it("ArtifactViewController prevents late response from StrictMode previous mount from overwriting current mount", async () => {
    let resolveA: (val: any) => void;
    let resolveB: (val: any) => void;
    (globalThis as any).window.devflow.artifacts.read = vi.fn()
      .mockReturnValueOnce(new Promise(r => resolveA = r))
      .mockReturnValueOnce(new Promise(r => resolveB = r));

    const { controller, unmount, changed } = setup(); // mount A
    unmount(); // cleanup A
    controller.mount(); // mount B

    // B resolves first
    resolveB!({ protocolVersion: 1, ok: true, artifact: {} as any, contentIdentity: "new-B", content: {} as any });
    await Promise.resolve(); // flush

    expect(controller.state.loading).toBe(false);
    expect(controller.state.result?.ok).toBe(true);
    if (controller.state.result?.ok) {
      expect(controller.state.result.contentIdentity).toBe("new-B");
    }

    // A resolves later (late response from previous mount)
    resolveA!({ protocolVersion: 1, ok: true, artifact: {} as any, contentIdentity: "old-A", content: {} as any });
    await Promise.resolve(); // flush

    // The late response must not overwrite the result of B
    if (controller.state.result?.ok) {
      expect(controller.state.result.contentIdentity).toBe("new-B");
    }
  });
});
