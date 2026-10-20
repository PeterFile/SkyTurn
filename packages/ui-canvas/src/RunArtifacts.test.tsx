import { beforeEach, describe, expect, it, vi } from "vitest";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { ArtifactView, RunArtifacts, createArtifactViewController, type ArtifactViewProps, type ArtifactRepairDraftRequest } from "./RunArtifacts.js";

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

  it("transfers only verified feedback through the real controller callback and retains feedback on failure", async () => {
    const prepare = vi.fn().mockRejectedValueOnce(new Error("Repair requires an after checkpoint.")).mockResolvedValue(undefined);
    const { controller } = setup({ onDraftRepair: prepare });
    controller.setFeedback("Make the title readable");
    await controller.draftRepair();
    expect(prepare).not.toHaveBeenCalled();
    await Promise.resolve();
    controller.imageEvents().onLoad();
    await controller.draftRepair();
    expect(controller.state.feedback).toBe("Make the title readable");
    expect(controller.state.draftError).toMatch(/after checkpoint/);
    await controller.draftRepair();
    expect(prepare).toHaveBeenLastCalledWith(expect.objectContaining({ artifactPath: "test.png", feedback: "Make the title readable", append: false, isCurrent: expect.any(Function) }));
    expect(Object.keys(prepare.mock.calls[1][0]).sort()).toEqual(["append", "artifactPath", "feedback", "isCurrent"]);
    expect(controller.state.feedback).toBe("");
  });

  it("rejects image drafting before onLoad and permits it only after successful load", async () => {
    const prepare = vi.fn().mockResolvedValue(undefined);
    const { controller } = setup({ onDraftRepair: prepare });
    await Promise.resolve();
    controller.setFeedback("Image feedback");
    await controller.draftRepair();
    expect(prepare).not.toHaveBeenCalled();
    expect(controller.state.feedback).toBe("Image feedback");
    expect(controller.canDraftRepair).toBe(false);
    controller.imageEvents().onLoad();
    expect(controller.canDraftRepair).toBe(true);
    await controller.draftRepair();
    expect(prepare).toHaveBeenCalledOnce();
  });

  it("keeps failed image decode unavailable even if a late load arrives", async () => {
    const prepare = vi.fn();
    const { controller } = setup({ onDraftRepair: prepare });
    await Promise.resolve(); controller.setFeedback("retained");
    const image = controller.imageEvents();
    image.onError(); image.onLoad();
    await controller.draftRepair();
    expect(prepare).not.toHaveBeenCalled();
    expect(controller.canDraftRepair).toBe(false);
    expect(controller.state.imageError).toBe(true);
    expect(controller.state.feedback).toBe("retained");
    expect(controller.state.draftError).toMatch(/image/i);
  });

  it("ignores old image callbacks across StrictMode remount and requires the current load", async () => {
    const { controller, unmount } = setup({ onDraftRepair: vi.fn() });
    await Promise.resolve(); controller.setFeedback("retained");
    const oldImage = controller.imageEvents();
    unmount(); controller.mount(); await Promise.resolve();
    oldImage.onLoad(); oldImage.onError();
    expect(controller.canDraftRepair).toBe(false);
    expect(controller.state.imageError).toBe(false);
    controller.imageEvents().onLoad();
    expect(controller.canDraftRepair).toBe(true);
  });

  it.each(["unmount", "scope", "run"])("rejects a late verified read after %s", async (change) => {
    let resolve!: (value: unknown) => void;
    const result = await (globalThis as any).window.devflow.artifacts.read();
    (globalThis as any).window.devflow.artifacts.read = vi.fn(() => new Promise(yes => { resolve = yes; }));
    const prepare = vi.fn();
    const { controller, update, unmount } = setup({ onDraftRepair: prepare });
    controller.setFeedback("retained");
    if (change === "unmount") unmount();
    else update(change === "run" ? { runId: "next" } : { sessionId: "next" });
    resolve(result); await Promise.resolve(); await controller.draftRepair();
    expect(prepare).not.toHaveBeenCalled();
    expect(controller.state.feedback).toBe("retained");
  });

  it("never clears newer feedback or a remounted interaction when preparation finishes late", async () => {
    let finish!: () => void;
    const prepare = vi.fn((_request: ArtifactRepairDraftRequest) => new Promise<void>(yes => { finish = yes; }));
    const { controller, unmount } = setup({ onDraftRepair: prepare });
    await Promise.resolve(); controller.imageEvents().onLoad(); controller.setFeedback("first");
    const pending = controller.draftRepair();
    controller.setFeedback("new feedback");
    finish(); await pending;
    expect(controller.state.feedback).toBe("new feedback");
    expect(controller.state.drafting).toBe(false);
    expect(controller.state.draftError).toMatch(/changed|retry/i);
    const second = controller.draftRepair();
    const guard = prepare.mock.calls[1][0].isCurrent;
    unmount(); controller.mount();
    expect(guard()).toBe(false);
    finish(); await second;
    expect(controller.state.feedback).toBe("new feedback");
  });

  it.each(["read-failed", "unavailable", "wrong-run", "wrong-path", "decode-failed"])("rejects %s without sending feedback or clearing it", async failure => {
    const read = (globalThis as any).window.devflow.artifacts.read;
    const result = await read();
    if (failure === "read-failed") read.mockResolvedValue({ protocolVersion: 1, ok: false, code: "MISSING", message: "Registered artifact is missing." });
    if (failure === "unavailable") (globalThis as any).window.devflow.artifacts = undefined;
    if (failure === "wrong-run") read.mockResolvedValue({ ...result, artifact: { ...result.artifact, runId: "other" } });
    if (failure === "wrong-path") read.mockResolvedValue({ ...result, artifact: { ...result.artifact, artifactPath: "other.png" } });
    const prepare = vi.fn();
    const { controller } = setup({ onDraftRepair: prepare });
    await Promise.resolve();
    controller.setFeedback("kept");
    if (failure === "decode-failed") controller.setImageError(true);
    await controller.draftRepair();
    expect(prepare).not.toHaveBeenCalled();
    expect(controller.state.feedback).toBe("kept");
    expect(controller.state.draftError).toMatch(failure === "decode-failed" ? /decode/i : /verify/);
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
