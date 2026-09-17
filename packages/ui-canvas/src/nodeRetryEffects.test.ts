import { afterEach, describe, expect, it, vi } from "vitest";
import { act, createElement, type ReactElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { emptyWorkspace, type WorkflowBroadcastEnvelope } from "@skyturn/persistence";
import { reduceWorkflowEvents } from "@skyturn/workflow-kernel";
import App, { NodeModal } from "./App.js";

vi.mock("@gsap/react", () => ({ useGSAP: () => ({ contextSafe: (callback: unknown) => callback }) }));

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}

// React DOM mounts an empty host; the real App and NodeModal hooks/effects run normally.
// Child UI trees are captured for their actual callbacks, without a browser or extra dependencies.
let root: Root | undefined;
afterEach(async () => {
  if (root) await act(async () => root!.unmount());
  root = undefined;
  vi.unstubAllGlobals();
});

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
  const refresh = deferred<typeof f.response>();
  let projection: any = f.response;
  const retryLane = vi.fn(async (_root, request) => {
    const result = structuredClone(f.response);
    Object.assign(result.projection.lanes[0], { status: "pending",
      retryAttempt: { ...request, runId: "new-run", segmentId: "new-segment" } });
    Object.assign(result.canvasSession.nodes[0], { status: "pending", runId: "new-run" });
    projection = result;
    return { ...result, created: true, event: { sessionId: "session", kind: "workflow.lane.retry_requested",
      source: "workflow-kernel", idempotencyKey: `retry:${request.requestId}`,
      payload: { ...request, nextRunId: "new-run", nextSegmentId: "new-segment" } } };
  });
  const workflowListeners = new Set<(event: WorkflowBroadcastEnvelope) => void>();
  const onWorkflowEvent = vi.fn((listener: (event: WorkflowBroadcastEnvelope) => void) => {
    workflowListeners.add(listener);
    return () => { workflowListeners.delete(listener); };
  });
  const getProjection = vi.fn(async () => projection);
  const getWorkflowProjection = vi.fn(() => refresh.promise);
  const document = { nodeType: 9, addEventListener() {}, removeEventListener() {}, activeElement: null,
    defaultView: { HTMLIFrameElement: class {} } };
  const container = { nodeType: 1, tagName: "DIV", namespaceURI: "http://www.w3.org/1999/xhtml",
    ownerDocument: document, addEventListener() {}, removeEventListener() {} };
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.stubGlobal("window", { ...document.defaultView, devflow: {
    loadWorkspace: vi.fn(async () => f.workspace), saveWorkspace: vi.fn(async () => undefined),
    getAgentHealth: vi.fn(async () => ({ agents: [], readiness: null })),
    onRunEvent: vi.fn(() => () => undefined), onWorkflowEvent,
    getRunEvents: vi.fn(async () => ({ events: [] })),
    getRunEvidence: vi.fn(async () => null), getWorkflowProjection,
    workflow: { getProjection, retryLane },
  }, matchMedia: () => ({ matches: true }) });
  let tree: ReactElement;
  let modalTree: ReactElement;
  function ModalHost(props: Parameters<typeof NodeModal>[0]) {
    modalTree = NodeModal(props);
    return null;
  }
  function AppHost() {
    tree = App();
    const modal = find(tree, (node) => node.type === NodeModal);
    return modal ? createElement(ModalHost, modal.props) : null;
  }
  root = createRoot(container as unknown as HTMLElement);
  await act(async () => root!.render(createElement(AppHost)));
  expect(getWorkflowProjection).toHaveBeenCalledOnce();
  await act(async () => find(tree, (node) => typeof node.props?.onInspectNode === "function").props.onInspectNode("lane"));
  const modalProps = () => find(tree, (node) => node.type === NodeModal)?.props;
  const click = async (label: string) => {
    const target = button(modalTree, label);
    expect(target.disabled).not.toBe(true);
    await act(async () => target.onClick());
  };
  const installRefresh = async () => {
    const previous = modalProps().session;
    await act(async () => refresh.resolve(structuredClone(f.response)));
    expect(modalProps().session).not.toBe(previous);
    expect(modalProps().node.runId).toBe("old-run");
    expect(modalProps().node.status).toBe("failed");
  };
  const broadcastRefresh = async () => {
    const previous = modalProps().session;
    const event = { ...structuredClone(f.response), cause: "workflow-mutation" } as unknown as WorkflowBroadcastEnvelope;
    expect(onWorkflowEvent).toHaveBeenCalledOnce();
    expect(workflowListeners.size).toBe(1);
    await act(async () => { for (const listener of workflowListeners) listener(event); });
    expect(modalProps().session).not.toBe(previous);
    expect(modalProps().node.runId).toBe("old-run");
    expect(modalProps().node.status).toBe("failed");
  };
  expect(button(modalTree, "Retry").disabled).toBe(false);
  return { ...f, refresh, retryLane, getProjection, modalProps, click, installRefresh, broadcastRefresh,
    modal: () => modalTree, tree: () => tree };
}

describe("Retry with real asynchronous React effects", () => {
  it("opens confirmation after More activates Retry and the pending session projection replaces its object", async () => {
    const h = await harness();
    await h.installRefresh();
    expect(button(h.modal(), "Retry").disabled).toBe(false);
    await h.click("Retry");
    expect(text(h.modal())).toContain("CURRENT workspace");
    await h.click("Cancel Retry");
    expect(h.retryLane).not.toHaveBeenCalled();
    await h.click("Retry");
    await h.click("Start new attempt");
    expect(h.retryLane).toHaveBeenCalledOnce();
    expect(h.modalProps().node.runId).toBe("new-run");
    expect(h.modalProps().session.schedulingState.status).toBe("paused");
    expect(h.modalProps().node.output).toEqual(["Original output\n"]);
    expect(h.modalProps().retryState.history[0].runId).toBe("old-run");
  });

  it.each(["projection", "broadcast"].flatMap(refresh =>
    ["uncommitted", "committed", "resolved"].map(outcome => ({ refresh, outcome })),
  ))("recovers a $outcome unknown outcome when $refresh refresh replaces the session during IPC", async ({ refresh, outcome }) => {
    const h = await harness();
    const pending = deferred<any>();
    const launch = h.retryLane.getMockImplementation()!;
    h.retryLane.mockImplementationOnce(() => pending.promise);
    await h.click("Retry");
    await h.click("Start new attempt");
    expect(h.retryLane).toHaveBeenCalledOnce();
    const request = h.retryLane.mock.calls[0][1];
    await (refresh === "broadcast" ? h.broadcastRefresh() : h.installRefresh());
    expect(button(h.modal(), "Retry").disabled).toBe(true);
    await act(async () => {
      h.modalProps().onRetry();
      h.modalProps().onRetryConfirm();
    });
    expect(h.retryLane).toHaveBeenCalledOnce();
    await act(async () => {
      const result = outcome !== "uncommitted" ? await launch("/alias", request) : null;
      if (outcome === "resolved") pending.resolve(result);
      else pending.reject(new Error("Response lost"));
    });
    if (outcome === "uncommitted") {
      expect(button(h.modal(), "Retry").disabled).toBe(false);
      await h.click("Retry");
      await h.click("Start new attempt");
      expect(h.retryLane).toHaveBeenCalledTimes(2);
      expect(h.retryLane.mock.calls[1][1]).toEqual(request);
    } else {
      expect(h.retryLane).toHaveBeenCalledOnce();
    }
    expect(h.modalProps().node.runId).toBe("new-run");
    expect(h.modalProps().session.schedulingState.status).toBe("paused");
    expect(h.modalProps().node.output).toEqual(["Original output\n"]);
    expect(h.modalProps().retryState.history[0].runId).toBe("old-run");
  });

  it("waits for refreshed eligibility and ignores an obsolete confirmation callback", async () => {
    const h = await harness();
    await h.click("Retry");
    const oldConfirm = button(h.modal(), "Start new attempt").onClick;
    const eligibility = deferred<any>();
    h.getProjection.mockImplementationOnce(() => eligibility.promise);
    await h.installRefresh();
    expect(button(h.modal(), "Retry").disabled).toBe(true);
    await act(async () => oldConfirm());
    expect(h.retryLane).not.toHaveBeenCalled();
    const invalid = structuredClone(h.response);
    invalid.projectRoot = "/foreign";
    await act(async () => eligibility.resolve(invalid));
    expect(button(h.modal(), "Retry").disabled).toBe(true);
    expect(text(h.modal())).toContain("authority");
    expect(h.retryLane).not.toHaveBeenCalled();
  });

  it("keeps newer broadcast authority when an older eligibility response or initial projection arrives", async () => {
    const h = await harness();
    const stale = deferred<any>();
    h.getProjection.mockImplementationOnce(() => stale.promise);
    await h.broadcastRefresh();
    expect(button(h.modal(), "Retry").disabled).toBe(true);
    await h.broadcastRefresh();
    expect(button(h.modal(), "Retry").disabled).toBe(false);
    const session = h.modalProps().session;
    const state = structuredClone(h.modalProps().retryState);
    await act(async () => {
      stale.resolve({ ...h.response, projectRoot: "/foreign" });
      h.refresh.resolve({ ...structuredClone(h.response),
        canvasSession: { ...h.response.canvasSession, title: "Stale initial projection" } });
    });
    expect(h.modalProps().session).toBe(session);
    expect(h.modalProps().retryState).toEqual(state);
    await h.click("Retry");
    await h.click("Start new attempt");
    expect(h.retryLane).toHaveBeenCalledOnce();
    expect(h.modalProps().node.runId).toBe("new-run");
  });

  it("discards a stale confirmation preflight and permits a new confirmation after refresh", async () => {
    const h = await harness();
    const preflight = deferred<any>();
    h.getProjection.mockImplementationOnce(() => preflight.promise);
    await h.click("Retry");
    await h.click("Start new attempt");
    expect(h.retryLane).not.toHaveBeenCalled();
    await h.installRefresh();
    expect(button(h.modal(), "Retry").disabled).toBe(true);
    await act(async () => preflight.resolve(structuredClone(h.response)));
    expect(h.retryLane).not.toHaveBeenCalled();
    await h.click("Retry");
    await h.click("Start new attempt");
    expect(h.retryLane).toHaveBeenCalledOnce();
    expect(h.modalProps().node.runId).toBe("new-run");
  });

  it.each(["uncommitted", "committed"])("keeps the %s request identity when the lost response precedes session refresh", async (outcome) => {
    const h = await harness();
    const launch = h.retryLane.getMockImplementation()!;
    h.retryLane.mockImplementationOnce(async (root, request) => {
      if (outcome === "committed") await launch(root, request);
      throw new Error("Response lost");
    });
    await h.click("Retry");
    await h.click("Start new attempt");
    expect(text(h.modal())).toContain("Response lost");
    const request = h.retryLane.mock.calls[0][1];
    // Recovery can immediately install the admitted attempt after this refresh.
    const previous = h.modalProps().session;
    await act(async () => h.refresh.resolve(structuredClone(h.response)));
    expect(h.modalProps().session).not.toBe(previous);
    if (outcome === "uncommitted") {
      await h.click("Retry");
      await h.click("Start new attempt");
      expect(h.retryLane.mock.calls[1][1]).toEqual(request);
      expect(h.retryLane).toHaveBeenCalledTimes(2);
    } else expect(h.retryLane).toHaveBeenCalledOnce();
    expect(h.modalProps().node.runId).toBe("new-run");
  });

  it.each(["projection", "broadcast"].flatMap(refresh =>
    ["resolve", "reject"].map(ending => ({ refresh, ending })),
  ))("ignores stale IPC $ending after $refresh refresh followed by navigation away and back", async ({ refresh, ending }) => {
    const h = await harness();
    const pending = deferred<any>();
    const launch = h.retryLane.getMockImplementation()!;
    h.retryLane.mockImplementationOnce(() => pending.promise);
    await h.click("Retry");
    await h.click("Start new attempt");
    await (refresh === "broadcast" ? h.broadcastRefresh() : h.installRefresh());
    const navigate = (id: string) => act(async () => {
      find(h.tree(), (node) => typeof node.props?.onSelectSession === "function").props.onSelectSession(id, "project");
    });
    await navigate("other");
    await navigate("session");
    const state = structuredClone(h.modalProps().retryState);
    const reads = h.getProjection.mock.calls.length;
    await act(async () => {
      if (ending === "resolve") pending.resolve(await launch("/alias", h.retryLane.mock.calls[0][1]));
      else pending.reject(new Error("Stale failure"));
    });
    expect(h.modalProps().retryState).toEqual(state);
    expect(h.getProjection).toHaveBeenCalledTimes(reads);
    expect(h.modalProps().node.runId).toBe("old-run");
    expect(text(h.modal())).not.toContain("Stale failure");
    expect(h.retryLane).toHaveBeenCalledOnce();
  });


  it.each(["output", "history", "pause", "receipt"])("rejects recovery that changed original %s after session replacement", async (invalid) => {
    const h = await harness();
    const pending = deferred<any>();
    const launch = h.retryLane.getMockImplementation()!;
    h.retryLane.mockImplementationOnce(() => pending.promise);
    await h.click("Retry");
    await h.click("Start new attempt");
    await h.installRefresh();
    await act(async () => {
      const result = await launch("/alias", h.retryLane.mock.calls[0][1]);
      if (invalid === "output") result.canvasSession.nodes[0].output = [];
      if (invalid === "history") result.projection.segments = [];
      if (invalid === "pause") {
        result.canvasSession.schedulingState.status = "active";
        result.projection.schedulingState.status = "active";
      }
      if (invalid === "receipt") result.projection.lanes[0].retryAttempt.terminalSegmentId = "foreign";
      pending.reject(new Error("Response lost"));
    });
    expect(button(h.modal(), "Retry").disabled).toBe(true);
    expect(h.modalProps().retryState.error).toMatch(/history|output|Pause|authority/);
    expect(h.modalProps().node.runId).toBe("old-run");
    expect(h.modalProps().node.output).toEqual(["Original output\n"]);
    expect(h.modalProps().session.schedulingState.status).toBe("paused");
    expect(h.retryLane).toHaveBeenCalledOnce();
  });

});
