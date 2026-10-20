import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { isValidElement, type ReactElement, type ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { emptyWorkspace, type WorkspaceState } from "@skyturn/persistence";
import type { CanvasNode, CanvasSession, RunEvent, WorkflowLoopNextAction } from "@skyturn/project-core";
import { createPlanSession } from "@skyturn/planner";
import { reduceWorkflowEvents, type FlowEvent } from "@skyturn/workflow-kernel";
import App from "./App.js";
import { SessionAttention } from "./sessionAttention.js";

// Exercise App, Sidebar, broadcast installation, navigation and selection effects together.
// Canvas/agent effects stay unmounted, as in WorkflowSchedulingControl.test.ts.
const hooks = vi.hoisted(() => ({ slots: [] as unknown[], cursor: 0,
  layouts: [] as (() => void)[], effects: [] as (() => void)[], subscribed: false }));
vi.mock("react", async (original) => {
  const react = await original<typeof import("react")>();
  const state = (initial: unknown) => {
    const index = hooks.cursor++;
    if (!(index in hooks.slots)) hooks.slots[index] = typeof initial === "function" ? initial() : initial;
    return [hooks.slots[index], (value: unknown) => {
      hooks.slots[index] = typeof value === "function" ? value(hooks.slots[index]) : value;
    }];
  };
  return { ...react, useState: state, useRef: (current: unknown) => state({ current })[0],
    useReducer: (reduce: (s: unknown, a: unknown) => unknown, initial: unknown) => {
      const [value, set] = state(initial) as [unknown, (v: unknown) => void];
      return [value, (action: unknown) => set((s: unknown) => reduce(s, action))];
    },
    useCallback: (callback: unknown) => callback,
    useMemo: (callback: () => unknown) => callback(),
    useSyncExternalStore: (_subscribe: unknown, snapshot: () => unknown) => snapshot(),
    useEffect: (effect: () => void) => hooks.effects.push(effect),
    useLayoutEffect: (effect: () => void, dependencies?: unknown[]) => {
      const index = hooks.cursor++;
      const previous = hooks.slots[index] as unknown[] | undefined;
      if (!dependencies || !previous || dependencies.some((value, i) => !Object.is(value, previous[i]))) hooks.layouts.push(effect);
      hooks.slots[index] = dependencies;
    },
  };
});

function elements(node: ReactNode): ReactElement<Record<string, unknown>>[] {
  if (Array.isArray(node)) return node.flatMap(elements);
  if (!isValidElement<Record<string, unknown>>(node)) return [];
  return [node, ...elements(node.props.children as ReactNode)];
}
function component(tree: ReactNode, name: string) {
  return elements(tree).find((element) => typeof element.type === "function" && element.type.name === name);
}
function node(id = "task", patch: Partial<CanvasNode> = {}): CanvasNode {
  return { id, title: id, agent: "codex", status: "failed", progress: "Failed", position: { x: 0, y: 0 },
    runId: `run-${id}`, changesetId: `changes-${id}`, output: [], worktree: {},
    context: { brief: "Build", sessionGoal: "Build", relatedRequirements: "", relatedDesign: "", relatedTasks: "", dependencies: [], constraints: [] },
    ...patch };
}
function decision(): CanvasNode {
  return node("decision", { status: "pending", nodeKind: "user_decision", executable: false,
    userDecision: { decisionId: "decision", status: "waiting_input", prompt: "Choose", reason: "Need input", options: ["Continue"] } });
}
function session(id: string, nodes: CanvasNode[] = [], projectId = "p1"): CanvasSession {
  return { id, projectId, title: "Same title", goal: "Build", mode: "fast", kind: "canvas",
    target: { executionTarget: "current_branch", selectedBranch: "main" },
    createdAt: "2026-10-17T00:00:00.000Z", updatedAt: "2026-10-17T00:00:00.000Z",
    hermesPlannerSessionId: `hermes-${id}`, plannerNodeId: `planner-${id}`, nodes, edges: [], activeNodeId: null,
    schedulingState: { status: "active", revision: 0, requestId: null, changedAt: null } };
}
function workspace(): WorkspaceState {
  return { ...emptyWorkspace(), projects: ["p1", "p2"].map((id) => ({ id, name: "Same project name",
    rootPath: `/${id}`, canonicalRootPath: `/${id}`, devflowPath: `/${id}/.devflow`, openedAt: "2026-10-17" })),
    sessions: [session("a", [node("decision")]), session("b", [decision()])], activeProjectId: "p1", activeSessionId: "a" };
}
const onWorkflowEvent = vi.fn((_listener: (event: unknown) => void) => () => {});
const getProjection = vi.fn(() => new Promise(() => {}));
const getWorkflowProjection = vi.fn(() => new Promise(() => {}));
const getRunEvents = vi.fn();
const updateNodePosition = vi.fn();
const mutations = Object.fromEntries(["answerUserDecision", "pauseScheduling", "resumeScheduling", "requestRepair",
  "requestVariant", "applyRollback", "refreshPullRequestChecks", "mergePullRequest", "advance", "startRun", "retryRun"]
  .map((name) => [name, vi.fn()]));
function current() { return hooks.slots[0] as WorkspaceState; }
function broadcast(canvasSession: CanvasSession, nextAction?: WorkflowLoopNextAction, projectRoot = `/${canvasSession.projectId}`, projection: unknown = {}) {
  onWorkflowEvent.mock.calls[0][0]({ protocolVersion: 1, projectRoot, sessionId: canvasSession.id, canvasSession,
    cause: "workflow-advance", projection, ...(nextAction ? { nextAction } : {}) });
}
function checkpointProjection(phases: ("before" | "after")[] = ["before"]) {
  const payloads = [
    { kind: "workflow.user_input", payload: { text: "Build" } },
    { kind: "workflow.lane.declared", payload: { lane: { id: "task", semanticKey: "task", kind: "implementation",
      laneKind: "implementation", semanticSubtype: "code", title: "task", agentKind: "codex", executable: true } } },
    ...phases.map((phase) => ({ kind: "workflow.node.checkpoint_recorded", payload: { checkpoint: { id: `${phase}-task`, sessionId: "b", nodeId: "task",
      laneId: "task", phase, executionTarget: "new_worktree", runId: "run-task", segmentId: "segment-task",
      worktreeState: "clean", headCommit: "a".repeat(40), createdAt: "2026-10-17T00:00:00.000Z", source: "agent_bridge",
      evidenceRefs: [{ kind: "run", id: "run-task" }, { kind: "segment", id: "segment-task" },
        ...(phase === "after" ? [{ kind: "evidence", id: "evidence-task" }] : [])] } } })),
  ];
  return reduceWorkflowEvents(payloads.map((value, index) => ({ ...value, id: `event-${index}`, sessionId: "b",
    seq: index + 1, source: "test", createdAt: "2026-10-17T00:00:00.000Z", idempotencyKey: null }) as FlowEvent));
}
function render(runNavigationEffects = false, hydrateRun = false) {
  hooks.cursor = 0; hooks.layouts = []; hooks.effects = [];
  const tree = App();
  hooks.layouts.forEach((effect) => effect());
  if (!hooks.subscribed) {
    hooks.effects.find((effect) => String(effect).includes("devflow.onWorkflowEvent"))!();
    hooks.subscribed = true;
  }
  hooks.effects.filter((effect) => /selectedNodeActionGenerationRef\.current|setNodeActionError\(null\)/.test(String(effect)))
    .forEach((effect) => effect());
  if (runNavigationEffects) {
    hooks.effects.filter((effect) => /devflow.getWorkflowProjection|workflow.getProjection\(authority.queryRoot/.test(String(effect)))
      .forEach((effect) => effect());
  }
  if (hydrateRun) hooks.effects.find((effect) => String(effect).includes("devflow.getRunEvents"))!();
  const sidebar = component(tree, "Sidebar")!;
  const output = sidebar ? (sidebar.type as (props: unknown) => ReactNode)(sidebar.props) : null;
  const badges = elements(output).filter((element) => element.type === SessionAttention).map((element) => {
    const button = SessionAttention(element.props as never);
    return { ...button.props, click: button.props.onClick };
  });
  return { tree, output, badges, sidebar, canvas: component(tree, "CanvasView") };
}
function expectSelection(view: ReturnType<typeof render>, projectId: string, sessionId: string, nodeId: string | null) {
  expect(current()).toMatchObject({ activeProjectId: projectId, activeSessionId: sessionId });
  expect((view.canvas?.props.selectedNode as CanvasNode | null)?.id ?? null).toBe(nodeId);
  expect(component(view.tree, "NodeModal")).toBeUndefined();
  expect(component(view.tree, "TerminalInspector")).toBeUndefined();
  Object.values(mutations).forEach((mutation) => expect(mutation).not.toHaveBeenCalled());
  expect(getProjection).not.toHaveBeenCalled();
  expect(getWorkflowProjection).not.toHaveBeenCalled();
}
function expectNoAutomaticWorkflowEffects() {
  expect.soft(getProjection).not.toHaveBeenCalled();
  expect.soft(getWorkflowProjection).not.toHaveBeenCalled();
  for (const mutation of [...Object.values(mutations), updateNodePosition]) expect.soft(mutation).not.toHaveBeenCalled();
}

beforeEach(() => {
  hooks.slots = [workspace()]; hooks.subscribed = false;
  onWorkflowEvent.mockClear(); Object.values(mutations).forEach((mutation) => mutation.mockClear());
  getProjection.mockClear(); getWorkflowProjection.mockClear();
  getRunEvents.mockReset().mockResolvedValue({ protocolVersion: 1, events: [] }); updateNodePosition.mockReset();
  vi.stubGlobal("window", { devflow: { workflow: { ...mutations, getProjection, updateNodePosition },
    ...mutations, onWorkflowEvent, getWorkflowProjection, getRunEvents } });
});
afterEach(() => vi.unstubAllGlobals());

describe("App cross-session attention navigation", () => {
  it("selects the exact inactive-session decision, closes old details, and survives selection effects", () => {
    const initial = render();
    (initial.canvas!.props.onInspectNode as (id: string) => void)("decision");
    expect(component(render().tree, "NodeModal")).toBeDefined();
    const view = render();
    expect(view.badges).toHaveLength(1);
    const html = renderToStaticMarkup(view.output);
    expect(html).not.toMatch(/<button[^>]*>(?:(?!<\/button>)[\s\S])*<button/);
    expect(view.badges[0]["data-target-node-id"]).toBe("decision");
    view.badges[0].click();
    expectSelection(render(true), "p1", "b", "decision");
    expectSelection(render(true), "p1", "b", "decision");
  });

  it.each(["request_repair", "fix_failed_checks", "merge_pull_request"] as const)(
    "only selects the current manual %s target, including Changes actions", (kind) => {
      render(); broadcast(session("b", [node()]), { kind, laneId: "task", reason: "Current action" });
      const view = render();
      expect(view.badges).toHaveLength(1);
      expect(view.badges[0]["data-session-attention"]).toBe("manual");
      view.badges[0].click();
      expectSelection(render(true), "p1", "b", "task");
    },
  );

  it("navigates to a paused session without selecting or resuming a task", () => {
    render(); const paused = session("b"); paused.schedulingState!.status = "paused"; broadcast(paused);
    const view = render();
    expect(view.badges[0]["data-session-attention"]).toBe("paused");
    view.badges[0].click();
    expectSelection(render(true), "p1", "b", null);
    broadcast(session("b")); expect(render().badges).toHaveLength(0);
  });

  it("updates and clears hints when authoritative decisions or next actions change or disappear", () => {
    render(); const answered = decision(); answered.userDecision!.status = "answered";
    broadcast(session("b", [answered, node()]), { kind: "request_repair", laneId: "task", reason: "Repair" });
    expect(render().badges[0]["data-session-attention"]).toBe("manual");
    broadcast(session("b", [answered, node()]), { kind: "none", reason: "Resolved" });
    expect(render().badges).toHaveLength(0);
    broadcast(session("b", [node()]), { kind: "blocked", laneId: "task", reason: "Review" });
    expect(render().badges).toHaveLength(1);
    broadcast(session("b", [node()]), { kind: "none", reason: "Resolved" });
    expect(render().badges).toHaveLength(0);
    broadcast(session("b", [decision()])); expect(render().badges).toHaveLength(1);
    broadcast(session("b")); expect(render().badges).toHaveLength(0);
  });

  it.each(["inactive", "rolled_back", "missing", "answered"] as const)("rejects a stale click after target becomes %s", (change) => {
    const view = render(); const oldClick = view.badges[0]?.click;
    expect(oldClick).toBeTypeOf("function");
    const target = decision();
    if (change === "answered") target.userDecision!.status = "answered";
    else if (change !== "missing") target.rollbackStatus = change;
    broadcast(session("b", change === "missing" ? [] : [target]));
    oldClick!();
    expectSelection(render(), "p1", "a", null);
  });

  it("rejects a detached manual hint as soon as its next-action authority is removed", () => {
    render(); const target = session("b", [node()]);
    broadcast(target, { kind: "request_repair", laneId: "task", reason: "Repair" });
    const view = render(); expect(view.badges).toHaveLength(1);
    // Explicit resolution may leave the canvas object unchanged.
    broadcast(target, { kind: "none", reason: "Resolved" }); view.badges[0].click();
    expectSelection(render(), "p1", "a", null);
  });

  it("isolates equal project names, session titles, session IDs, and node IDs", () => {
    hooks.slots[0] = { ...workspace(), sessions: [session("same", [node()]), session("same", [node("task", { title: "Other project task" })], "p2")], activeSessionId: "same" };
    render(); broadcast(session("same", [node("task", { title: "Other project task" })], "p2"), { kind: "request_repair", laneId: "task", reason: "Repair p2" });
    const view = render(); expect(view.badges).toHaveLength(1);
    expect(view.badges[0]["data-project-id"]).toBe("p2");
    view.badges[0].click(); const selected = render();
    expectSelection(selected, "p2", "same", "task");
    expect((selected.canvas!.props.selectedNode as CanvasNode).title).toBe("Other project task");
    expect(renderToStaticMarkup(selected.output).match(/sidebar-session-row active/g)).toHaveLength(1);
  });

  it("ignores missing project authority and broadcasts from a different root", () => {
    hooks.slots[0] = { ...workspace(), sessions: [session("a"), session("b")] };
    render(); broadcast(session("b", [decision()]), undefined, "/other");
    expect(render().badges).toHaveLength(0);
    hooks.slots[0] = { ...current(), projects: current().projects.map((project) => ({ ...project, canonicalRootPath: undefined })), sessions: [session("a"), session("b", [decision()])] };
    expect(render().badges).toHaveLength(0);
  });

  it("keeps checkpoint actions available from the matching authoritative projection without querying", () => {
    render(); broadcast(session("b", [node()]), { kind: "request_variant", laneId: "task", reason: "Variant" }, "/p1", checkpointProjection());
    render().badges[0].click(); render(true);
    const view = render();
    expect(view.canvas!.props.selectedNodeActionState).toMatchObject({ canCreateVariant: true,
      checkpoints: { beforeCheckpointId: "before-task" } });
    expectSelection(view, "p1", "b", "task");
  });

  it("preserves checkpoint actions through real nonempty run-output hydration, then invalidates replaced runs and removed authority", async () => {
    render(); const target = session("b", [node()]);
    broadcast(target, { kind: "request_repair", laneId: "task", reason: "Repair" }, "/p1", checkpointProjection(["before", "after"]));
    render().badges[0].click(); render(true);
    const available = { canCreateRepair: true, canCreateVariant: true, canRollback: true };
    expect(render().canvas!.props.selectedNodeActionState).toMatchObject(available);
    const events: RunEvent[] = [{ protocolVersion: 1, runId: "run-task", seq: 1,
      timestamp: "2026-10-17T00:01:00.000Z", kind: "output", payload: { text: "Exact hydrated output\n" } }];
    getRunEvents.mockResolvedValueOnce({ protocolVersion: 1, events });
    render(false, true); await Promise.resolve();
    expect(getRunEvents).toHaveBeenCalledWith("/p1", "run-task");
    const hydrated = current().sessions.find((item) => item.id === "b") as CanvasSession;
    expect(hydrated).not.toBe(target); expect(hydrated.nodes[0]).not.toBe(target.nodes[0]);
    expect(hydrated.nodes[0].output).toEqual(["Exact hydrated output\n"]);
    render(true); const view = render();
    expect(view.canvas!.props.selectedNodeActionState).toMatchObject(available);
    expectSelection(view, "p1", "b", "task");
    broadcast(session("b", [node("task", { runId: "replacement-run" })]),
      { kind: "request_repair", laneId: "task", reason: "New run" }, "/p1", checkpointProjection([]));
    render(true); const replaced = render();
    expect(replaced.canvas!.props.selectedNodeActionState).toMatchObject({ canCreateRepair: false, canCreateVariant: false, canRollback: false });
    expectSelection(replaced, "p1", "b", "task");
    broadcast(session("b", [node()]), { kind: "none", reason: "Resolved" }, "/p1", checkpointProjection([]));
    render(true); const removed = render();
    expect(removed.canvas!.props.selectedNodeActionState).toMatchObject({ canCreateRepair: false, canCreateVariant: false, canRollback: false });
    expect(removed.badges).toHaveLength(0); expect(removed.canvas!.props.nextActionHint).toBeNull();
    expectSelection(removed, "p1", "b", "task");
  });

  it.each(["run", "root", "project", "inactive", "rolled_back"] as const)("does not reuse checkpoint facts after observational %s replacement", (change) => {
    render(); broadcast(session("b", [node()]), { kind: "request_repair", laneId: "task", reason: "Repair" }, "/p1", checkpointProjection(["before", "after"]));
    render().badges[0].click(); render(true);
    expect(render().canvas!.props.selectedNodeActionState).toMatchObject({ canCreateRepair: true });
    const latest = current();
    hooks.slots[0] = change === "run" || change === "inactive" || change === "rolled_back"
      ? { ...latest, sessions: latest.sessions.map((item) => item.id === "b"
        ? { ...item, nodes: [node("task", change === "run" ? { runId: "replacement-run" } : { rollbackStatus: change })] } : item) }
      : change === "root" ? { ...latest, projects: latest.projects.map((item) => item.id === "p1"
        ? { ...item, rootPath: "/replacement", canonicalRootPath: "/replacement" } : item) }
      : { ...latest, activeProjectId: "p2", sessions: [...latest.sessions, session("b", [node()], "p2")] };
    render(true); expect(render().canvas!.props.selectedNodeActionState).toBeNull();
    expectNoAutomaticWorkflowEffects();
    if (change === "root" || change === "project") {
      hooks.slots[0] = { ...latest, sessions: latest.sessions.map((item) => item.id === "b"
        ? { ...item, nodes: [node("task", { runId: "replacement-run" })] } : item) };
      render(true); const returned = render();
      expect(returned.canvas!.props.selectedNodeActionState).toBeNull();
      expectSelection(returned, "p1", "b", "task"); expectNoAutomaticWorkflowEffects();
    }
  });

  it.each(["project", "session"] as const)("keeps navigation-only intent through missing active %s and return to the same identity", (missing) => {
    render(); broadcast(session("b", [node()]), { kind: "request_repair", laneId: "task", reason: "Repair" }, "/p1", checkpointProjection(["before", "after"]));
    render().badges[0].click(); render(true);
    expect(render().canvas!.props.selectedNodeActionState).toMatchObject({ canCreateRepair: true });
    const latest = current();
    hooks.slots[0] = missing === "project" ? { ...latest, projects: latest.projects.filter((item) => item.id !== "p1") }
      : { ...latest, sessions: latest.sessions.filter((item) => item.id !== "b") };
    expect(render(true).canvas).toBeUndefined(); expectNoAutomaticWorkflowEffects();
    // The scope returns without a click, but its replacement run has no checkpoint authority.
    hooks.slots[0] = { ...latest, sessions: latest.sessions.map((item) => item.id === "b"
      ? { ...item, nodes: [node("task", { runId: "replacement-run" })] } : item) };
    render(true); const returned = render();
    expect(returned.canvas!.props.selectedNodeActionState).toBeNull();
    expectSelection(returned, "p1", "b", "task"); expectNoAutomaticWorkflowEffects();
  });

  it("rejects an older cached generation after a failed position request and subsequent output hydration", async () => {
    render(); broadcast(session("b", [node()]), { kind: "request_repair", laneId: "task", reason: "Repair" }, "/p1", checkpointProjection(["before", "after"]));
    render().badges[0].click(); render(true); const selected = render();
    expect(selected.canvas!.props.selectedNodeActionState).toMatchObject({ canCreateRepair: true });
    updateNodePosition.mockRejectedValue(new Error("Position response unavailable"));
    await expect((selected.canvas!.props.onNodePositionCommit as (input: unknown) => Promise<void>)({ id: "task", position: { x: 8, y: 16 } }))
      .rejects.toThrow("Position response unavailable");
    getRunEvents.mockResolvedValueOnce({ protocolVersion: 1, events: [{ protocolVersion: 1, runId: "run-task", seq: 1,
      timestamp: "2026-10-17T00:01:00.000Z", kind: "output", payload: { text: "Hydrated after request\n" } } satisfies RunEvent] });
    render(false, true); await Promise.resolve(); render(true);
    const stale = render(); expect(stale.canvas!.props.selectedNodeActionState).toBeNull();
    expectSelection(stale, "p1", "b", "task");
  });

  it("preserves both pending repair hints across a real node drag response without nextAction, then clears explicit resolution", async () => {
    render(); const target = session("b", [node()]); const projection = checkpointProjection(["before", "after"]);
    broadcast(target, { kind: "request_repair", laneId: "task", reason: "Repair still pending" }, "/p1", projection);
    render().badges[0].click(); render(true); const initial = render();
    const hint = initial.canvas!.props.nextActionHint;
    let reply!: (value: unknown) => void;
    updateNodePosition.mockReturnValueOnce(new Promise((resolve) => { reply = resolve; }));
    const update = (initial.canvas!.props.onNodePositionCommit as (input: unknown) => Promise<void>)({ id: "task", position: { x: 32, y: 64 } });
    const moved = { ...target, nodes: [{ ...target.nodes[0], position: { x: 32, y: 64 } }] };
    reply({ protocolVersion: 1, projectRoot: "/p1", sessionId: "b", canvasSession: moved, projection }); await update;
    render(true); const view = render();
    expect(updateNodePosition).toHaveBeenCalledWith("/p1", expect.objectContaining({ sessionId: "b", nodeId: "task", position: { x: 32, y: 64 } }));
    expect((view.canvas!.props.session as CanvasSession).nodes[0].position).toEqual({ x: 32, y: 64 });
    expect(view.badges).toHaveLength(1); expect(view.canvas!.props.nextActionHint).toEqual(hint);
    expect(view.canvas!.props.selectedNodeActionState).toMatchObject({ canCreateRepair: true, canCreateVariant: true, canRollback: true });
    expectSelection(view, "p1", "b", "task");
    broadcast(moved, { kind: "none", reason: "Resolved" }, "/p1", projection);
    const resolved = render(); expect(resolved.badges).toHaveLength(0); expect(resolved.canvas!.props.nextActionHint).toBeNull();
  });

  it.each(["project", "session", "node", "details", "next-action"])("preserves ordinary %s navigation after attention navigation", (action) => {
    const view = render(); view.badges[0].click(); let located = render(true);
    expectSelection(located, "p1", "b", "decision");
    const queryRoot = action === "project" || action === "session" ? "/replacement" : "/p1";
    if (queryRoot === "/replacement") {
      hooks.slots[0] = { ...current(), projects: current().projects.map((item) => item.id === "p1"
        ? { ...item, rootPath: queryRoot, canonicalRootPath: queryRoot } : item) };
      located = render(true);
    }
    expectNoAutomaticWorkflowEffects();
    if (action === "project") (located.sidebar.props.onSelectProject as (id: string) => void)("p1");
    else if (action === "session") (located.sidebar.props.onSelectSession as (id: string, projectId: string) => void)("b", "p1");
    else if (action === "next-action") (located.canvas!.props.onNavigateNextAction as (navigation: unknown) => void)({ targetNodeId: "decision", modalTab: "Changes" });
    else (located.canvas!.props[action === "details" ? "onInspectNode" : "onSelectNode"] as (id: string) => void)("decision");
    const clicked = render(true);
    expect(getProjection).toHaveBeenCalledWith(queryRoot, "b");
    expect(getWorkflowProjection).toHaveBeenCalledWith(queryRoot, "b");
    expect(!!component(clicked.tree, "NodeModal")).toBe(action === "details" || action === "next-action");
    if (action === "next-action") expect(component(clicked.tree, "NodeModal")!.props.tab).toBe("Changes");
  });

  it("preserves plain session selection and Plan mode", () => {
    const plan = createPlanSession({ projectId: "p1", goal: "Plan work", createdAt: "2026-10-17T00:00:00.000Z",
      target: { executionTarget: "current_branch", selectedBranch: "main" } });
    hooks.slots[0] = { ...workspace(), sessions: [session("a"), plan] };
    const view = render(); expect(view.badges).toHaveLength(0);
    (view.sidebar.props.onSelectSession as (sessionId: string, projectId: string) => void)(plan.id, "p1");
    const selected = render();
    expect(component(selected.tree, "PlanView")!.props.session).toBe(plan);
    expect(component(selected.tree, "NodeModal")).toBeUndefined();
    expect(selected.badges).toHaveLength(0);
  });
});
