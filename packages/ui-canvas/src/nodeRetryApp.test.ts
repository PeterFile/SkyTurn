import { afterEach, describe, expect, it, vi } from "vitest";
import type { ReactElement } from "react";
import { emptyWorkspace } from "@skyturn/persistence";
import { reduceWorkflowEvents } from "@skyturn/workflow-kernel";
import App, { NodeModal } from "./App.js";

// Run the owning components' real callbacks without a DOM or unrelated background effects.
// State, refs and layout-effect cleanup survive each render, including away/back navigation.
const runtime = vi.hoisted(() => ({ host: null as any }));
vi.mock("react", async (original) => {
  const react = await original<typeof import("react")>();
  function useState(initial: any) {
    const host = runtime.host;
    const index = host.index++;
    if (!(index in host.slots)) host.slots[index] = typeof initial === "function" ? initial() : initial;
    return [host.slots[index], (value: any) => {
      host.slots[index] = typeof value === "function" ? value(host.slots[index]) : value;
      host.dirty = true;
    }];
  }
  return { ...react, useState,
    useReducer: (reducer: any, initial: any) => { const [value, set] = useState(initial); return [value, (action: any) => set((old: any) => reducer(old, action))]; },
    useRef: (initial: any) => useState(() => ({ current: initial }))[0],
    useMemo: (factory: any) => factory(), useCallback: (callback: any) => callback,
    useEffect: () => undefined,
    useLayoutEffect: (effect: any, dependencies: any[]) => {
      const host = runtime.host;
      const index = host.index++;
      const old = host.slots[index];
      if (!old || dependencies.some((value, i) => !Object.is(value, old.dependencies[i]))) {
        host.effects.push(() => { old?.cleanup?.(); host.slots[index] = { dependencies, cleanup: effect() }; });
      }
    } };
});
vi.mock("@gsap/react", () => ({ useGSAP: () => ({ contextSafe: (callback: any) => callback }) }));

function host(slots: any[] = []) { return { slots, index: 0, effects: [] as Array<() => void>, dirty: false }; }
function render(owner: ReturnType<typeof host>, component: () => ReactElement) {
  let tree: ReactElement;
  for (let count = 0; count < 10; count++) {
    runtime.host = owner;
    owner.index = 0;
    owner.dirty = false;
    tree = component();
    for (const effect of owner.effects.splice(0)) effect();
    if (!owner.dirty) return tree;
  }
  throw new Error("Unexpected repeated component updates");
}
function find(tree: any, predicate: (node: any) => boolean): any {
  if (Array.isArray(tree)) return tree.map((item) => find(item, predicate)).find(Boolean);
  if (!tree || typeof tree !== "object") return null;
  if (predicate(tree)) return tree;
  return find(tree.props?.children, predicate);
}
function text(tree: any): string {
  if (Array.isArray(tree)) return tree.map(text).join("");
  if (tree === null || tree === undefined || typeof tree === "boolean") return "";
  return typeof tree === "object" ? text(tree.props?.children) : String(tree);
}
function button(tree: any, label: string) {
  const found = find(tree, (node) => node.type === "button" && text(node) === label);
  expect(found, `visible ${label} button`).toBeTruthy();
  return found.props;
}
function fixture() {
  const now = "2026-09-10T00:00:00.000Z";
  const node = { id: "lane", title: "Validate", agent: "codex", status: "failed", progress: "Failed", runId: "old-run",
    changesetId: "changes", position: { x: 0, y: 0 }, output: ["Original output\n"], nodeKind: "agent_task", executable: true,
    runtimePolicy: { trusted: true, executable: true, source: "workflow_projection", sandbox: "read-only" },
    context: { brief: "Validate", sessionGoal: "Goal", relatedRequirements: "", relatedDesign: "", relatedTasks: "", dependencies: [], constraints: [] },
    worktree: { path: "/project", branchName: "main", baselineRef: "HEAD", baseCommit: "a".repeat(40) } };
  const session = { id: "session", projectId: "project", title: "Retry", goal: "Goal", mode: "fast", kind: "canvas",
    target: { executionTarget: "current_branch", selectedBranch: "main" }, createdAt: now, updatedAt: now,
    hermesPlannerSessionId: "planner-session", plannerNodeId: "planner", nodes: [node], edges: [], activeNodeId: null,
    schedulingState: { status: "paused", revision: 1 } };
  const evidence = { runId: node.runId, status: "failed", exitCode: 1, changesetId: null, checks: [], artifacts: [],
    review: null, errorReason: "Failed", cancelReason: null, completedAt: now };
  const projection = { ...reduceWorkflowEvents([]), sessionId: session.id, schedulingState: session.schedulingState,
    lanes: [{ ...node, kind: "validation", semanticKey: "lane" }], projectionNodes: [{ id: "lane", laneId: "lane" }],
    segments: [{ id: "old-segment", laneId: "lane", runId: node.runId, status: "failed", exitCode: 1 }],
    evidence: [{ laneId: "lane", segmentId: "old-segment", runEvidence: evidence }],
    checkpoints: [{ id: "checkpoint:old-run:before", laneId: "lane", nodeId: "lane", phase: "before", runId: node.runId,
      segmentId: "old-segment", source: "backend", headCommit: "a".repeat(40) }] };
  const response = { protocolVersion: 1, projectRoot: "/project", sessionId: "session", canvasSession: session, projection,
    nextAction: { kind: "blocked", reason: "Paused" } };
  const workspace = { ...emptyWorkspace(), projects: [{ id: "project", name: "Project", rootPath: "/alias", canonicalRootPath: "/project" }],
    sessions: [session, { ...session, id: "other", nodes: [] }], activeProjectId: "project", activeSessionId: "session",
    runEvents: { "old-run": [{ kind: "output", payload: { text: "Original output\n" } }] } };
  return { response, workspace };
}
async function harness() {
  const f = fixture();
  let projection: any = f.response;
  const retryLane = vi.fn(async (_root, request) => {
    const result = structuredClone(f.response);
    const attempt = { ...request, runId: "new-run", segmentId: "new-segment" };
    Object.assign(result.projection.lanes[0], { status: "pending", retryAttempt: attempt });
    Object.assign(result.canvasSession.nodes[0], { status: "pending", runId: "new-run" });
    projection = result;
    return { ...result, created: true, event: { sessionId: "session", kind: "workflow.lane.retry_requested",
      source: "workflow-kernel", idempotencyKey: `retry:${request.requestId}`,
      payload: { ...request, nextRunId: "new-run", nextSegmentId: "new-segment" } } };
  });
  vi.stubGlobal("window", { devflow: { workflow: { getProjection: vi.fn(async () => projection), retryLane } },
    matchMedia: () => ({ matches: true }) });
  const parent = host([f.workspace]);
  const modalHost = host();
  const parentTree = () => render(parent, App);
  const modalProps = () => find(parentTree(), (node) => node.type === NodeModal)?.props;
  const modal = () => render(modalHost, () => NodeModal(modalProps()));
  const canvas = find(parentTree(), (node) => typeof node.props?.onInspectNode === "function");
  expect(canvas, "App owns the real canvas inspection callback").toBeTruthy();
  canvas.props.onInspectNode("lane");
  await vi.waitFor(() => expect(modalProps()?.retryUnavailableReason).toBeNull());
  return { ...f, retryLane, parent, parentTree, modalProps, modal };
}
afterEach(() => vi.unstubAllGlobals());

describe("App to NodeModal Retry ownership", () => {
  it("uses the actual visible Retry, Cancel and confirm callbacks and installs only backend state", async () => {
    const h = await harness();
    const oldEvents = structuredClone(h.workspace.runEvents);
    expect(button(h.modal(), "Retry").disabled).toBe(false);
    button(h.modal(), "Retry").onClick();
    expect(text(h.modal())).toContain("CURRENT workspace");
    button(h.modal(), "Cancel Retry").onClick();
    expect(h.retryLane).not.toHaveBeenCalled();
    button(h.modal(), "Retry").onClick();
    button(h.modal(), "Start new attempt").onClick();
    await vi.waitFor(() => expect(h.modalProps().node.runId).toBe("new-run"));
    expect(h.retryLane).toHaveBeenCalledOnce();
    expect(h.modalProps().node.output).toEqual(["Original output\n"]);
    expect(h.modalProps().session.schedulingState.status).toBe("paused");
    expect(h.parent.slots[0].runEvents).toEqual(oldEvents);
    await vi.waitFor(() => expect(h.modalProps().retryState.history[0]?.runId).toBe("old-run"));
    expect(button(h.modal(), "Retry").disabled).toBe(true);
  });

  it("ignores a delayed result after real App session navigation away and back", async () => {
    const h = await harness();
    let reject!: (error: Error) => void;
    h.retryLane.mockImplementationOnce(() => new Promise((_resolve, no) => { reject = no; }));
    button(h.modal(), "Retry").onClick();
    button(h.modal(), "Start new attempt").onClick();
    await vi.waitFor(() => expect(h.retryLane).toHaveBeenCalledOnce());
    expect(button(h.modal(), "Retry").disabled).toBe(true);
    const navigate = (id: string) => {
      find(h.parentTree(), (node) => typeof node.props?.onSelectSession === "function").props.onSelectSession(id, "project");
      h.parentTree();
    };
    navigate("other");
    navigate("session");
    await vi.waitFor(() => expect(h.modalProps().retryUnavailableReason).toContain("previous Retry request"));
    const state = structuredClone(h.modalProps().retryState);
    reject(new Error("Stale failure"));
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(h.modalProps().retryState).toEqual(state);
    expect(h.modalProps().node.runId).toBe("old-run");
    expect(text(h.modal())).not.toContain("Stale failure");
  });

  it("recovers the reserved backend attempt after a lost IPC response without another Retry call", async () => {
    const h = await harness();
    const launch = h.retryLane.getMockImplementation()!;
    h.retryLane.mockImplementationOnce(async (root, request) => {
      await launch(root, request);
      throw new Error("Response lost");
    });
    button(h.modal(), "Retry").onClick();
    button(h.modal(), "Start new attempt").onClick();
    await vi.waitFor(() => expect(h.modalProps().retryState.error).toContain("Response lost"));
    expect(h.modalProps().node.runId).toBe("old-run");
    button(h.modal(), "Retry").onClick();
    button(h.modal(), "Start new attempt").onClick();
    await vi.waitFor(() => expect(h.modalProps().node.runId).toBe("new-run"));
    expect(h.retryLane).toHaveBeenCalledOnce();
    expect(h.modalProps().session.schedulingState.status).toBe("paused");
    expect(h.modalProps().node.output).toEqual(["Original output\n"]);
  });
});
