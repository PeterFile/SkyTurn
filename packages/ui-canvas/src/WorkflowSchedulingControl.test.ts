import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { isValidElement, type ReactElement, type ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { emptyWorkspace, type WorkspaceState } from "@skyturn/persistence";
import type { CanvasSession } from "@skyturn/project-core";
import App from "./App.js";
import { WorkflowSchedulingControl } from "./WorkflowSchedulingControl.js";

// Shallow-render the actual App and its control without mounting canvas/agent effects.
const hooks = vi.hoisted(() => ({ slots: [] as unknown[], cursor: 0, layouts: [] as (() => void)[] }));
vi.mock("react", async (original) => {
  const react = await original<typeof import("react")>();
  const state = (initial: unknown) => {
    const index = hooks.cursor++;
    if (!(index in hooks.slots)) hooks.slots[index] = typeof initial === "function" ? initial() : initial;
    return [hooks.slots[index], (value: unknown) => {
      hooks.slots[index] = typeof value === "function" ? value(hooks.slots[index]) : value;
    }];
  };
  return { ...react, useState: state,
    useRef: (current: unknown) => state({ current })[0],
    useReducer: (reduce: (s: unknown, a: unknown) => unknown, initial: unknown) => {
      const [value, set] = state(initial) as [unknown, (v: unknown) => void];
      return [value, (action: unknown) => set((s: unknown) => reduce(s, action))];
    },
    useCallback: (callback: unknown) => callback,
    useSyncExternalStore: (_subscribe: unknown, snapshot: () => unknown) => snapshot(),
    useEffect: () => {}, useLayoutEffect: (effect: () => void) => hooks.layouts.push(effect),
  };
});

function elements(node: ReactNode): ReactElement<Record<string, unknown>>[] {
  if (Array.isArray(node)) return node.flatMap(elements);
  if (!isValidElement<Record<string, unknown>>(node)) return [];
  return [node, ...elements(node.props.children as ReactNode)];
}
function session(id = "s1", status: "active" | "paused" = "active", revision = 4): CanvasSession {
  return { id, projectId: "p1", title: id, goal: "Build", mode: "fast", kind: "canvas",
    target: { executionTarget: "current_branch", selectedBranch: "main" },
    createdAt: "2026-09-09T00:00:00.000Z", updatedAt: "2026-09-09T00:00:00.000Z",
    hermesPlannerSessionId: `h-${id}`, plannerNodeId: `n-${id}`, nodes: [], edges: [], activeNodeId: null,
    schedulingState: { status, revision, requestId: null, changedAt: null } };
}
function workspace(...sessions: CanvasSession[]): WorkspaceState {
  return { ...emptyWorkspace(), projects: [{ id: "p1", name: "Project", rootPath: "/alias",
    canonicalRootPath: "/project", devflowPath: "/alias/.devflow", openedAt: "2026-09-09" }],
    sessions, activeProjectId: "p1", activeSessionId: sessions[0].id };
}
function envelope(canvasSession: CanvasSession, projectRoot = "/project") {
  return { protocolVersion: 1, projectRoot, sessionId: canvasSession.id, canvasSession };
}
function deferred() {
  let resolve!: (value: unknown) => void;
  let reject!: (reason: Error) => void;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}
const pauseScheduling = vi.fn();
const resumeScheduling = vi.fn();
const getProjection = vi.fn();
function render() {
  hooks.cursor = 0; hooks.layouts = [];
  const tree = App();
  hooks.layouts.forEach((effect) => effect());
  const control = elements(tree).find((element) => element.type === WorkflowSchedulingControl);
  expect(control, "App must expose the scheduling entrypoint").toBeDefined();
  const output = WorkflowSchedulingControl(control!.props as never);
  const buttons = elements(output).filter((element) => element.type === "button");
  expect(buttons).toHaveLength(1);
  return { html: renderToStaticMarkup(output), button: buttons[0].props,
    click: () => (buttons[0].props.onClick as () => Promise<void>)() };
}
function current() { return hooks.slots[0] as WorkspaceState; }
function replace(value: WorkspaceState) { hooks.slots[0] = value; }

beforeEach(() => {
  hooks.slots = [workspace(session())];
  vi.stubGlobal("window", { devflow: { workflow: { pauseScheduling, resumeScheduling, getProjection } } });
  pauseScheduling.mockReset(); resumeScheduling.mockReset(); getProjection.mockReset();
});
afterEach(() => vi.unstubAllGlobals());

describe("App scheduling entrypoint", () => {
  it("shows Pause and rehydrates Resume only from authoritative session state", async () => {
    expect(render().html).toContain("Pause");
    replace(workspace(session("s1", "paused", 7)));
    const view = render();
    expect(view.html).toContain("Resume");
    expect(view.html).toContain("Scheduling paused");
    expect(view.html).toContain("Active runs continue");
    resumeScheduling.mockResolvedValue(envelope(session("s1", "active", 8)));
    await view.click();
    expect(resumeScheduling).toHaveBeenCalledWith("/alias", expect.objectContaining({
      sessionId: "s1", expectedStatus: "paused", expectedRevision: 7,
    }));
    expect(render().html).toContain("Pause");
  });

  it("disables missing state and unavailable backend without fabricating authority", () => {
    const missing = session(); delete missing.schedulingState;
    replace(workspace(missing));
    expect(render().button.disabled).toBe(true);
    expect(render().html).toContain("Scheduling state unavailable");
    replace(workspace(session()));
    vi.stubGlobal("window", {});
    expect(render().button.disabled).toBe(true);
    expect(render().html).toContain("Scheduling backend unavailable");
    expect(pauseScheduling).not.toHaveBeenCalled();
  });

  it("deduplicates pending clicks and never flips status optimistically", async () => {
    const pending = deferred(); pauseScheduling.mockReturnValue(pending.promise);
    const view = render(); const request = view.click(); await view.click();
    expect(pauseScheduling).toHaveBeenCalledTimes(1);
    expect(render().button.disabled).toBe(true);
    expect(current().sessions[0]).toMatchObject({ schedulingState: { status: "active" } });
    pending.resolve(envelope(session("s1", "paused", 5))); await request;
    expect(render().html).toContain("Resume");
    expect(render().button.disabled).toBe(false);
  });

  it("retries an unknown outcome with the exact original action, ID and CAS after state changes", async () => {
    pauseScheduling.mockRejectedValueOnce(new Error("Transport lost"));
    await render().click();
    const original = pauseScheduling.mock.calls[0];
    expect(render().html).toContain("Transport lost");
    replace(workspace(session("s1", "paused", 5)));
    getProjection.mockResolvedValue(envelope(session("s1", "paused", 5)));
    pauseScheduling.mockResolvedValue(envelope(session("s1", "paused", 5)));
    expect(render().html).toContain("Retry Pause");
    await render().click();
    expect(pauseScheduling.mock.calls[1]).toEqual(original);
    expect(resumeScheduling).not.toHaveBeenCalled();
  });

  it("recovers a committed Resume through projection and retains the exact attempt if projection fails", async () => {
    replace(workspace(session("s1", "paused", 7)));
    resumeScheduling.mockRejectedValueOnce(new Error("Advance failed after commit"));
    await render().click();
    const original = resumeScheduling.mock.calls[0];
    getProjection.mockRejectedValueOnce(new Error("Projection recovery failed"));
    await render().click();
    expect(getProjection).toHaveBeenCalledWith("/alias", "s1");
    expect(resumeScheduling).toHaveBeenCalledTimes(1);
    expect(render().html).toContain("Projection recovery failed");
    expect(render().html).toContain("Retry Resume");
    const recovered = session("s1", "active", 8);
    recovered.schedulingState!.requestId = original[1].requestId;
    getProjection.mockResolvedValue(envelope(recovered));
    const replay = deferred(); resumeScheduling.mockReturnValue(replay.promise);
    const retry = render().click();
    await Promise.resolve();
    expect(current().sessions[0]).toMatchObject({ schedulingState: recovered.schedulingState });
    expect(render().html).toContain("Pause");
    expect(render().html).not.toContain("Scheduling paused");
    expect(render().button.disabled).toBe(true);
    expect(resumeScheduling.mock.calls[1]).toEqual(original);
    replay.resolve(envelope(recovered)); await retry;
    expect(render().html).toContain("Pause");
    expect(render().html).not.toContain("Reload scheduling");
    expect(render().button.disabled).toBe(false);
    expect(pauseScheduling).not.toHaveBeenCalled();
  });

  it.each(["reply", "error"])("isolates an old-project recovery projection %s without replaying its control", async (outcome) => {
    pauseScheduling.mockRejectedValueOnce(new Error("Unknown outcome"));
    await render().click();
    const recovery = deferred(); getProjection.mockReturnValue(recovery.promise);
    const retry = render().click();
    replace({ ...workspace(session("s1", "paused", 12)), projects: current().projects.map((p) => ({
      ...p, rootPath: "/other", canonicalRootPath: "/other",
    })) });
    render();
    if (outcome === "reply") recovery.resolve(envelope(session("s1", "active", 5)));
    else recovery.reject(new Error("Old recovery failed"));
    await retry;
    expect(current().sessions[0]).toMatchObject({ schedulingState: { status: "paused", revision: 12 } });
    expect(render().html).toContain("Resume");
    expect(render().html).not.toContain("Retry");
    expect(render().html).not.toContain("Old recovery failed");
    expect(render().button.disabled).toBe(false);
    expect(pauseScheduling).toHaveBeenCalledTimes(1);
  });

  it("reloads authoritative state after conflict before allocating a new request", async () => {
    pauseScheduling.mockRejectedValueOnce(new Error("SKYTURN_WORKFLOW:INVALID_INPUT: Workflow scheduling request is stale."));
    await render().click();
    const original = pauseScheduling.mock.calls[0][1];
    expect(render().html).toContain("Reload scheduling");
    getProjection.mockRejectedValueOnce(new Error("Reload failed"));
    await render().click();
    expect(render().html).toContain("Reload failed");
    expect(pauseScheduling).toHaveBeenCalledTimes(1);
    getProjection.mockResolvedValue(envelope(session("s1", "active", 9)));
    await render().click();
    expect(getProjection).toHaveBeenCalledWith("/alias", "s1");
    expect(pauseScheduling).toHaveBeenCalledTimes(1);
    pauseScheduling.mockResolvedValue(envelope(session("s1", "paused", 10)));
    await render().click();
    expect(pauseScheduling.mock.calls[1][1]).toMatchObject({ expectedRevision: 9, expectedStatus: "active" });
    expect(pauseScheduling.mock.calls[1][1].requestId).not.toBe(original.requestId);
  });

  it.each(["reply", "error"])("isolates late old-session %s and restores pending state when switching back", async (outcome) => {
    replace(workspace(session(), session("s2", "paused", 3)));
    const pending = deferred(); pauseScheduling.mockReturnValue(pending.promise);
    const request = render().click();
    replace({ ...current(), activeSessionId: "s2" });
    expect(render().html).toContain("Resume");
    expect(render().button.disabled).toBe(false);
    replace({ ...current(), activeSessionId: "s1" });
    expect(render().button.disabled).toBe(true);
    await render().click(); expect(pauseScheduling).toHaveBeenCalledTimes(1);
    replace({ ...current(), activeSessionId: "s2" }); render();
    if (outcome === "reply") pending.resolve(envelope(session("s1", "paused", 5)));
    else pending.reject(new Error("Old session error"));
    await request;
    expect(render().html).toContain("Resume");
    expect(render().html).not.toContain("Old session error");
    expect(render().button.disabled).toBe(false);
  });

  it.each(["reply", "error"])("isolates a late old-root %s even when project/session IDs are reused", async (outcome) => {
    const pending = deferred(); pauseScheduling.mockReturnValueOnce(pending.promise);
    const request = render().click();
    replace({ ...workspace(session("s1", "paused", 12)), projects: current().projects.map((p) => ({
      ...p, rootPath: "/other", canonicalRootPath: "/other",
    })) });
    expect(render().button.disabled).toBe(false);
    if (outcome === "reply") pending.resolve(envelope(session("s1", "active", 5)));
    else pending.reject(new Error("Old project error"));
    await request;
    expect(render().html).toContain("Resume");
    expect(render().html).not.toContain("Old project error");
    expect(render().button.disabled).toBe(false);
    expect(current().sessions[0]).toMatchObject({ schedulingState: { revision: 12 } });
  });

  it.each(["reply", "error"])("keeps the new session busy and its error intact after an old %s", async (outcome) => {
    replace(workspace(session(), session("s2", "paused", 3)));
    const old = deferred(); const active = deferred();
    pauseScheduling.mockReturnValue(old.promise); resumeScheduling.mockReturnValue(active.promise);
    const oldRequest = render().click();
    replace({ ...current(), activeSessionId: "s2" });
    const activeRequest = render().click();
    if (outcome === "reply") old.resolve(envelope(session("s1", "paused", 5)));
    else old.reject(new Error("Old failure"));
    await oldRequest;
    expect(render().button.disabled).toBe(true);
    expect(render().html).not.toContain("Old failure");
    active.reject(new Error("Current failure")); await activeRequest;
    expect(render().html).toContain("Current failure");
    expect(render().html).toContain("Retry Resume");
    expect(render().button.disabled).toBe(false);
  });

  it("restores a pending project attempt after switching away and back", async () => {
    const original = current(); const pending = deferred();
    pauseScheduling.mockReturnValue(pending.promise);
    const request = render().click();
    replace({ ...workspace(session()), projects: original.projects.map((p) => ({
      ...p, rootPath: "/other", canonicalRootPath: "/other",
    })) });
    expect(render().button.disabled).toBe(false);
    replace(original);
    expect(render().button.disabled).toBe(true);
    await render().click(); expect(pauseScheduling).toHaveBeenCalledTimes(1);
    pending.reject(new Error("Unknown outcome")); await request;
    const first = pauseScheduling.mock.calls[0];
    getProjection.mockResolvedValue(envelope(session()));
    pauseScheduling.mockResolvedValue(envelope(session("s1", "paused", 5)));
    await render().click();
    expect(pauseScheduling.mock.calls[1]).toEqual(first);
    expect(render().html).toContain("Resume");
  });

  it("rejects a response after the current session was refreshed while pending", async () => {
    const pending = deferred(); pauseScheduling.mockReturnValue(pending.promise);
    const request = render().click();
    replace(workspace(session("s1", "active", 8))); render();
    pending.resolve(envelope(session("s1", "paused", 5))); await request;
    expect(current().sessions[0]).toMatchObject({ schedulingState: { status: "active", revision: 8 } });
    expect(render().html).toContain("Reload scheduling");
  });
});
