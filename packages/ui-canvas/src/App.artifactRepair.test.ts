import ts from "typescript";
import { readFile } from "node:fs/promises";
import { afterEach, describe, expect, it, vi } from "vitest";
import { emptyWorkspace } from "@skyturn/persistence";
import { reduceWorkflowEvents, type FlowEvent } from "@skyturn/workflow-kernel";
import type { CanvasNode, CanvasSession, RunEvidence } from "@skyturn/project-core";
import * as AppModule from "./App.js";
import { buildSelectedNodeActionState } from "./nodeActionState.js";
import { createComposerDraftStore, draftScopeKey } from "./composerDrafts.js";
import { createArtifactViewController } from "./RunArtifacts.js";

// Reuse the existing App.test.ts controller harness style to execute production handlers.
async function handlers(context: Record<string, unknown>) {
  const source = await readFile(new URL("./App.tsx", import.meta.url), "utf8");
  const ast = ts.createSourceFile("App.tsx", source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
  const names = ["prepareArtifactRepairDraft", "submitSelectedNodeAction", "nodeActionPayloadMatchesSelection",
    "actionFailureMessage", "workflowRequestAcknowledged", "canvasSessionForWorkflowAuthority", "workspaceMatchesWorkflowAuthority",
    "workflowSessionEnvelope", "isCanvasSession", "isCanonicalWorkflowProjectRoot", "isRecord", "rollbackBlockedMessage",
    "optionalText", "hasCanonicalWorkflowPathSegments"];
  const declarations = new Map<string, string>();
  function visit(node: ts.Node) {
    if (ts.isFunctionDeclaration(node) && node.name) declarations.set(node.name.text, node.getText(ast).replace(/^export /, ""));
    ts.forEachChild(node, visit);
  }
  visit(ast);
  const code = names.map(name => { expect(declarations.has(name), name).toBe(true); return declarations.get(name); }).join("\n");
  const javascript = ts.transpileModule(code, { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText;
  const entries = Object.entries({ ...AppModule, buildSelectedNodeActionState, draftScopeKey, ...context }).filter(([key]) => key !== "default");
  return new Function(...entries.map(([key]) => key), `${javascript}; return { prepareArtifactRepairDraft, submitSelectedNodeAction };`)(...entries.map(([, value]) => value));
}

const path = ".devflow/acceptance/report.txt";
const key = draftScopeKey(["node", "p", "s", "n", "repair"]);
const timestamp = "2026-10-18T00:00:00.000Z";
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(yes => { resolve = yes; });
  return { promise, resolve };
}

async function fixture(status: RunEvidence["status"] = "succeeded", artifactPath = path) {
  const bytes = new Map<string, string>();
  const disk = { getItem: (key: string) => bytes.get(key) ?? null, setItem: (key: string, value: string) => { bytes.set(key, value); } };
  const store = createComposerDraftStore(() => disk);
  const project = { id: "p", name: "fixture", rootPath: "/project", canonicalRootPath: "/project", devflowPath: "/project/.devflow", openedAt: timestamp };
  const node = { id: "n", runId: "run", agent: "Codex", status: status === "succeeded" ? "completed" : "failed" } as CanvasNode;
  const session: CanvasSession = { id: "s", projectId: "p", title: "fixture", goal: "fixture", kind: "canvas", mode: "fast",
    target: { executionTarget: "current_branch", selectedBranch: "main" }, nodes: [node], edges: [], createdAt: timestamp, updatedAt: timestamp };
  const event = (kind: FlowEvent["kind"], payload: Record<string, unknown>, seq: number): FlowEvent => ({ id: `e-${seq}`, sessionId: "s", seq, kind, payload, source: "workflow-kernel", createdAt: timestamp });
  const evidence = { runId: "run", status, checks: [], artifacts: [artifactPath], review: null, exitCode: status === "succeeded" ? 0 : 1 };
  const projection = reduceWorkflowEvents([
    event("workflow.user_input", { text: "fixture" }, 1),
    event("workflow.lane.declared", { lane: { id: "n", semanticKey: "n", kind: "implementation", laneKind: "implementation", title: "fixture", agentKind: "codex", executable: true } }, 2),
    event("workflow.segment.started", { segment: { id: "segment", laneId: "n", runId: "run", status: "running", exitCode: null } }, 3),
    event("workflow.evidence.recorded", { laneId: "n", segmentId: "segment", evidence: { id: "ev", laneId: "n", segmentId: "segment", kind: "run", status: status === "succeeded" ? "passed" : "failed", checks: [], artifacts: [artifactPath], runEvidence: evidence } }, 4),
    event("workflow.segment.finished", { laneId: "n", segmentId: "segment", status, exitCode: evidence.exitCode }, 5),
    event("workflow.node.checkpoint_recorded", { checkpoint: { id: "after", sessionId: "s", nodeId: "n", laneId: "n", phase: "after", runId: "run", segmentId: "segment", executionTarget: "current_branch", source: "backend", createdAt: timestamp, evidenceRefs: [{ kind: "run", id: "run" }] } }, 6),
  ]);
  const envelope = { protocolVersion: 1, projectRoot: "/project", sessionId: "s", canvasSession: session, projection };
  const workspaceRef = { current: { ...emptyWorkspace(), projects: [project], sessions: [session], activeProjectId: "p", activeSessionId: "s" } };
  const guard = { projectId: "p", queryRoot: "/project", canonicalRoot: "/project", sessionId: "s", requestSession: session, generation: 0 };
  const interaction = { key: "fixture" };
  const requestRepair = vi.fn().mockResolvedValue(envelope);
  const workflow = { getProjection: vi.fn().mockResolvedValue(envelope), requestRepair };
  vi.stubGlobal("window", { devflow: { workflow, appendWorkflowUserInput: vi.fn(), startAgentRun: vi.fn() } });
  const context = { activeProject: project, activeSession: session, inspectedNode: node, selectedNode: node,
    artifactRepairInteraction: interaction, artifactRepairInteractionRef: { current: interaction },
    workspaceRef, composerDraftStore: store, composerAction: "repair", selectedNodeActionScopeKey: JSON.stringify(["p", "s", "n"]),
    selectedNodeActionState: buildSelectedNodeActionState({ sessionId: "s", selectedNode: node, projection }),
    nodeDraft: { capture: () => store.read(key) }, pendingNodeActionsRef: { current: new Map() },
    selectedNodeActionScopeRef: { current: { sessionId: "s", nodeId: "n" } }, selectedNodeActionGenerationRef: { current: 0 },
    captureWorkflowSessionResponseGuard: () => guard, applyGuardedWorkflowSessionResponse: vi.fn(() => true),
    setSelectedNodeId: vi.fn(), setComposerActions: vi.fn(), setInspectedNodeId: vi.fn(),
    setNodeActionFeedbackScope: vi.fn(), setNodeActionError: vi.fn(), setNodeActionStatus: vi.fn(), refreshNodeActionBusy: vi.fn(),
  };
  return { store, disk, context, workflow, envelope, projection, session, node, artifactPath, api: await handlers(context) };
}
async function preview(f: Awaited<ReturnType<typeof fixture>>, image = false) {
  const read = vi.fn().mockResolvedValue({ protocolVersion: 1, ok: true,
    artifact: { artifactPath: f.artifactPath, name: image ? "report.png" : "report.txt", type: image ? "png" : "txt", runId: "run", status: "succeeded", byteLength: 10 },
    contentIdentity: "current-file-unhashed", content: image
      ? { encoding: "base64", mimeType: "image/png", base64: "fixture", width: 1, height: 1 }
      : { encoding: "utf8", mimeType: "text/plain", text: "Registered report" } });
  vi.stubGlobal("window", { devflow: { ...window.devflow, artifacts: { read } } });
  const prepare = vi.fn(f.api.prepareArtifactRepairDraft);
  const controller = createArtifactViewController(() => ({ projectRoot: "/project", sessionId: "s", nodeId: "n", runId: "run",
    artifactPath: f.artifactPath, onDraftRepair: prepare }), vi.fn());
  const unmount = controller.mount(); await Promise.resolve();
  return { controller, prepare, read, unmount };
}
const request = (patch = {}) => ({ artifactPath: path, feedback: "Improve contrast", append: false, isCurrent: () => true, ...patch });
afterEach(() => vi.unstubAllGlobals());

describe("artifact Repair App callbacks", () => {
  it.each(["feedback", "append", "feedback-away-back", "append-away-back"])("invalidates a pending %s revision before the parent stores or closes, then recovers", async change => {
    const f = await fixture(); f.store.edit(key, "existing draft");
    const saved = f.store.read(key);
    const { controller, prepare, read } = await preview(f);
    controller.setFeedback("original feedback"); controller.setAppend(true);
    const load = deferred<typeof f.envelope>(); f.workflow.getProjection.mockReturnValueOnce(load.promise);
    const pending = controller.draftRepair();
    expect(f.workflow.getProjection).toHaveBeenCalledOnce();
    if (change.startsWith("feedback")) {
      controller.setFeedback("newer feedback");
      if (change.endsWith("back")) controller.setFeedback("original feedback");
    } else {
      controller.setAppend(false);
      if (change.endsWith("back")) controller.setAppend(true);
    }
    expect(prepare.mock.calls[0][0].isCurrent()).toBe(false);
    const feedback = controller.state.feedback;
    load.resolve(f.envelope); await pending;
    expect(f.store.read(key)).toBe(saved);
    expect(f.context.setInspectedNodeId).not.toHaveBeenCalled();
    expect(f.context.setSelectedNodeId).not.toHaveBeenCalled();
    expect(controller.state.feedback).toBe(feedback);
    expect(controller.state.drafting).toBe(false);
    expect(controller.state.draftError).toMatch(/changed|retry/i);
    controller.setAppend(true);
    await controller.draftRepair();
    expect(f.store.read(key).text).toMatch(/^existing draft\n\n/);
    expect(f.store.read(key).text).toContain(feedback);
    expect(f.context.setInspectedNodeId).toHaveBeenCalledExactlyOnceWith(null);
    expect(controller.state.draftError).toBeNull();
    expect(controller.state.drafting).toBe(false);
    expect(read).toHaveBeenCalledOnce();
    expect(f.workflow.requestRepair).not.toHaveBeenCalled();
    expect(window.devflow.appendWorkflowUserInput).not.toHaveBeenCalled();
    expect(window.devflow.startAgentRun).not.toHaveBeenCalled();
  });

  it("blocks pending and failed images at the parent boundary and invalidates an in-flight decode error", async () => {
    const f = await fixture("succeeded", ".devflow/acceptance/report.png");
    f.store.edit(key, "existing draft"); const saved = f.store.read(key);
    const { controller, prepare, read } = await preview(f, true);
    controller.setFeedback("image feedback"); controller.setAppend(true);
    await controller.draftRepair();
    expect(prepare).not.toHaveBeenCalled();
    expect(f.workflow.getProjection).not.toHaveBeenCalled();
    const image = controller.imageEvents(); image.onLoad();
    const load = deferred<typeof f.envelope>(); f.workflow.getProjection.mockReturnValueOnce(load.promise);
    const pending = controller.draftRepair();
    expect(f.workflow.getProjection).toHaveBeenCalledOnce();
    image.onError();
    expect(prepare.mock.calls[0][0].isCurrent()).toBe(false);
    load.resolve(f.envelope); await pending;
    expect(f.store.read(key)).toBe(saved);
    expect(f.context.setInspectedNodeId).not.toHaveBeenCalled();
    expect(f.context.setSelectedNodeId).not.toHaveBeenCalled();
    expect(controller.state.feedback).toBe("image feedback");
    expect(controller.state.drafting).toBe(false);
    expect(controller.state.draftError).toMatch(/image|decode/i);
    expect(controller.canDraftRepair).toBe(false);
    await controller.draftRepair();
    expect(prepare).toHaveBeenCalledOnce();
    expect(read).toHaveBeenCalledOnce();
    expect(f.workflow.requestRepair).not.toHaveBeenCalled();
    expect(window.devflow.startAgentRun).not.toHaveBeenCalled();
  });

  it("transfers successfully loaded image feedback through the unchanged parent handler", async () => {
    const f = await fixture("succeeded", ".devflow/acceptance/report.png");
    const { controller, read } = await preview(f, true);
    controller.setFeedback("image feedback"); controller.imageEvents().onLoad();
    await controller.draftRepair();
    expect(f.store.read(key).source?.artifactPath).toBe(f.artifactPath);
    expect(f.store.read(key).text).toContain("image feedback");
    expect(f.context.setInspectedNodeId).toHaveBeenCalledExactlyOnceWith(null);
    expect(controller.state.feedback).toBe("");
    expect(read).toHaveBeenCalledOnce();
    expect(f.workflow.requestRepair).not.toHaveBeenCalled();
  });

  it.each(["succeeded", "failed", "cancelled", "timed-out"] as const)("prepares an editable bound draft without scheduling for %s evidence, then sends only explicitly", async status => {
    const f = await fixture(status);
    const original = JSON.stringify(f.session);
    await f.api.prepareArtifactRepairDraft(request());
    const draft = f.store.read(key);
    expect(draft.text).toContain("Improve contrast");
    expect(draft.text).toContain(path);
    expect(draft.text).not.toContain("/project");
    expect(draft.source).toEqual({ projectId: "p", sessionId: "s", nodeId: "n", runId: "run", afterCheckpointId: "after", artifactPath: path });
    expect(f.context.setSelectedNodeId).toHaveBeenCalledWith("n");
    expect(f.context.setComposerActions.mock.calls[0][0](new Map()).get(JSON.stringify(["p", "s", "n"]))).toBe("repair");
    expect(f.context.setInspectedNodeId).toHaveBeenCalledWith(null);
    expect(f.workflow.requestRepair).not.toHaveBeenCalled();
    expect(window.devflow.appendWorkflowUserInput).not.toHaveBeenCalled();
    expect(window.devflow.startAgentRun).not.toHaveBeenCalled();
    expect(JSON.stringify(f.session)).toBe(original);
    f.store.edit(key, `${draft.text}\nEdited`);
    const submitted = f.store.read(key);
    await f.api.submitSelectedNodeAction("repair", submitted.text);
    expect(f.workflow.requestRepair).toHaveBeenCalledExactlyOnceWith("/project", expect.objectContaining({ sessionId: "s", nodeId: "n", laneId: "n", checkpointId: "after", instruction: submitted.text }));
    expect(f.store.read(key).text).toBe("");
  });

  it("requires explicit append and preserves concurrent and unrelated drafts", async () => {
    const f = await fixture();
    f.store.edit(key, "existing");
    const other = draftScopeKey(["followup", "p", "s"]); f.store.edit(other, "unrelated");
    await expect(f.api.prepareArtifactRepairDraft(request())).rejects.toThrow(/Append/);
    expect(f.context.setInspectedNodeId).not.toHaveBeenCalled();
    const load = deferred<typeof f.envelope>(); f.workflow.getProjection.mockReturnValueOnce(load.promise);
    const pending = f.api.prepareArtifactRepairDraft(request({ append: true }));
    f.store.edit(key, "newer concurrent text"); load.resolve(f.envelope); await pending;
    expect(f.store.read(key).text).toMatch(/^newer concurrent text\n\n/);
    expect(f.store.read(other).text).toBe("unrelated");
  });

  it.each(["close", "navigation-back", "project", "session", "run", "run-and-checkpoint", "checkpoint", "unavailable", "authority"])("rejects %s while preparing without selecting or modifying drafts", async change => {
    const f = await fixture(); f.store.edit(key, "kept");
    const load = deferred<typeof f.envelope>(); f.workflow.getProjection.mockReturnValueOnce(load.promise);
    let current = true;
    const pending = f.api.prepareArtifactRepairDraft(request({ append: true, isCurrent: () => current }));
    if (change === "close") current = false;
    if (change === "navigation-back") f.context.artifactRepairInteractionRef.current = { key: "fixture" };
    if (change === "project") f.context.workspaceRef.current.activeProjectId = "other";
    if (change === "session") f.context.workspaceRef.current.activeSessionId = "other";
    if (change === "run") f.node.runId = "other";
    if (change === "run-and-checkpoint") { f.node.runId = "other"; f.projection.checkpoints[0].runId = "other"; }
    if (change === "checkpoint") f.projection.checkpoints[0].runId = "other";
    if (change === "unavailable") f.projection.checkpoints = [];
    if (change === "authority") f.envelope.projectRoot = "/other";
    load.resolve(f.envelope);
    await expect(pending).rejects.toThrow();
    expect(f.store.read(key).text).toBe("kept");
    expect(f.context.setInspectedNodeId).not.toHaveBeenCalled();
    expect(f.context.setSelectedNodeId).not.toHaveBeenCalled();
    expect(f.workflow.requestRepair).not.toHaveBeenCalled();
  });

  it("fails unavailable without falling back to global workflow input", async () => {
    const f = await fixture(); f.store.edit(key, "kept");
    vi.stubGlobal("window", { devflow: { appendWorkflowUserInput: vi.fn() } });
    await expect(f.api.prepareArtifactRepairDraft(request({ append: true }))).rejects.toThrow(/unavailable/);
    expect(f.store.read(key).text).toBe("kept");
    expect(window.devflow.appendWorkflowUserInput).not.toHaveBeenCalled();
    expect(f.context.setSelectedNodeId).not.toHaveBeenCalled();
  });

  it("rechecks interaction generation before sending after a fresh-projection wait", async () => {
    const f = await fixture(); await f.api.prepareArtifactRepairDraft(request());
    const captured = f.store.read(key);
    const load = deferred<typeof f.envelope>(); f.workflow.getProjection.mockReturnValueOnce(load.promise);
    const pending = f.api.submitSelectedNodeAction("repair", captured.text);
    f.context.selectedNodeActionGenerationRef.current++;
    load.resolve(f.envelope); await pending;
    expect(f.workflow.requestRepair).not.toHaveBeenCalled();
    expect(f.store.read(key)).toBe(captured);
  });

  it.each(["project", "session", "node", "run", "checkpoint", "checkpoint-run", "unavailable"])("reopens binding and rejects explicit send after %s mismatch while retaining text", async change => {
    const f = await fixture(); await f.api.prepareArtifactRepairDraft(request());
    const reopened = createComposerDraftStore(() => f.disk);
    const captured = reopened.read(key);
    expect(captured.source).toBeDefined();
    if (change === "project") f.context.activeProject = { ...f.context.activeProject, id: "other" };
    if (change === "session") f.context.activeSession = { ...f.session, id: "other" };
    if (change === "node") f.context.selectedNode = { ...f.node, id: "other" };
    if (change === "run") f.node.runId = "other";
    if (change === "checkpoint") f.projection.checkpoints[0].id = "other";
    if (change === "checkpoint-run") f.projection.checkpoints[0].runId = "other";
    if (change === "unavailable") f.projection.checkpoints = [];
    f.context.composerDraftStore = reopened;
    f.context.nodeDraft = { capture: () => reopened.read(key) };
    const api = await handlers(f.context);
    await api.submitSelectedNodeAction("repair", captured.text);
    expect(f.workflow.requestRepair).not.toHaveBeenCalled();
    expect(reopened.read(key)).toBe(captured);
    expect(f.context.setNodeActionError).toHaveBeenCalledWith(expect.any(String));
  });

  it("does not clear a newer draft while an explicit valid Repair send is pending", async () => {
    const f = await fixture(); await f.api.prepareArtifactRepairDraft(request());
    const old = f.store.read(key);
    const done = deferred<typeof f.envelope>(); f.workflow.requestRepair.mockReturnValueOnce(done.promise);
    const pending = f.api.submitSelectedNodeAction("repair", old.text);
    await vi.waitFor(() => expect(f.workflow.requestRepair).toHaveBeenCalledOnce());
    f.store.edit(key, "newer draft"); done.resolve(f.envelope); await pending;
    expect(f.store.read(key).text).toBe("newer draft");
  });
});
