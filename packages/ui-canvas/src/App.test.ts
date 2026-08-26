import { readFile } from "node:fs/promises";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import {
  formatTerminalTitle,
  formatTerminalBadge,
  formatTerminalMessage,
  plannerSessionStatusForSnapshot,
} from "./terminalInspector.js";
import {
  emptyWorkspace,
  normalizeWorkspaceState,
  type TerminalSnapshotResult,
  type WorkspaceState,
} from "@skyturn/persistence";
import type { VariantComparisonEvidence } from "@skyturn/git-worktree";
import {
  REMOTE_SIDE_EFFECT_ROLLBACK_BLOCK_MESSAGE,
  failureSummaryForNode,
  selectedNodeActionAvailability,
  rollbackLabelForNode,
  buildWorktreeAdoptionConfirmation,
  buildWorktreeCleanConfirmation,
  buildWorktreeDeleteBranchConfirmation,
  changeReviewSummary,
  changeEvidenceFactsForDisplay,
  deriveSessionTarget,
  createInsertBeforeIntentRequestTracker,
  INSERT_BEFORE_UNAVAILABLE_ERROR,
  submitInsertBeforeIntent,
  hasAvailableChangeEvidence,
  hasFinalGitEvidence,
  affectedDownstreamSummaryForDisplay,
  latestFailedCheckForDisplay,
  lastRunEvidenceForDisplay,
  runEvidenceFactsForDisplay,
  summarizeWorktreeComparisonEvidence,
  PlanDocumentEditor,
  derivePlanRevisionTracking,
  isPlanRevisionAvailable,
  derivePlanUiPhase,
  isPlanSourceEditable,
  isPlanNextEnabled,
  isPlanFinishEnabled,
  upsertWorkflowNextAction,
  UserDecisionPanel,
  workflowNextActionForScope,
} from "./App.js";
import * as AppModule from "./App.js";
import { parsePlanBootstrapSession } from "@skyturn/project-core";
import type { CanvasNode, CanvasSession, Changeset, FinalChangesetReconciliation, PlanSession, RunEvidence, WorkflowLoopNextAction } from "@skyturn/project-core";
import type { DeliveryCommitSummary } from "./deliveryPanel.js";
import type { SelectedNodeActionState } from "./nodeActionState.js";
import { acceptPlanStage, canFinishPlan, editPlanStage } from "./planRuntime.js";
import { convertPlanToCanvas } from "@skyturn/planner";

interface BottomComposerSubmissionStateForTest {
  inputId: string;
  text: string;
  busy: boolean;
  error: string | null;
}

type SubmitBottomComposerAttempt = <T>(options: {
  states: Map<string, BottomComposerSubmissionStateForTest>;
  scope: string;
  text: string;
  createInputId: () => string;
  submit: (inputId: string) => Promise<T>;
  onStateChange?: () => void;
}) => Promise<T | null>;

function submitBottomComposerAttemptForTest(): SubmitBottomComposerAttempt {
  const helper = Reflect.get(AppModule, "submitBottomComposerAttempt");
  expect(helper).toBeTypeOf("function");
  return helper as SubmitBottomComposerAttempt;
}

interface NewSessionSubmissionStateForTest {
  session: CanvasSession;
  inputId: string;
  busy: boolean;
  error: string | null;
}

type SubmitNewSessionAttempt = (options: {
  states: Map<string, NewSessionSubmissionStateForTest>;
  scope: string;
  createAttempt: () => Pick<NewSessionSubmissionStateForTest, "session" | "inputId">;
  submit: (attempt: Pick<NewSessionSubmissionStateForTest, "session" | "inputId">) => Promise<CanvasSession>;
  onStateChange?: () => void;
}) => Promise<CanvasSession | null>;

function submitNewSessionAttemptForTest(): SubmitNewSessionAttempt {
  const helper = Reflect.get(AppModule, "submitNewSessionAttempt");
  expect(helper).toBeTypeOf("function");
  return helper as SubmitNewSessionAttempt;
}

function canvasSessionForTest(id: string, projectId = "project-1"): CanvasSession {
  return {
    id,
    projectId,
    title: id,
    goal: "Build it",
    mode: "fast",
    kind: "canvas",
    target: { executionTarget: "current_branch", selectedBranch: "main" },
    createdAt: "2026-07-21T00:00:00.000Z",
    updatedAt: "2026-07-21T00:00:00.000Z",
    hermesPlannerSessionId: `hermes-${id}`,
    plannerNodeId: `planner-${id}`,
    nodes: [],
    edges: [],
    activeNodeId: null,
  };
}

interface WorkflowResponseGuardForTest {
  projectId: string;
  queryRoot: string;
  canonicalRoot: string;
  sessionId: string;
  requestSession: CanvasSession | null;
  generation: number;
}

type ApplyWorkflowResponseForTest = (
  workspace: WorkspaceState,
  response: unknown,
  guard: WorkflowResponseGuardForTest,
  currentGeneration: number,
) => WorkspaceState;

type ApplyWorkflowBroadcastForTest = (
  workspace: WorkspaceState,
  event: unknown,
  submissions: ReadonlyMap<string, NewSessionSubmissionStateForTest>,
) => WorkspaceState;

type DecorateNewSessionInstallationForTest = (
  workspace: WorkspaceState,
  authoritative: CanvasSession,
) => WorkspaceState;

interface EvidenceHydrationScopeForTest {
  projectId: string;
  queryRoot: string;
  canonicalRoot: string;
  sessionId: string;
  generation: number;
}

interface EvidenceHydrationRequestForTest extends EvidenceHydrationScopeForTest {
  nodeId: string;
  runId: string;
}

interface EvidenceDisplayScopeForTest extends Omit<EvidenceHydrationRequestForTest, "generation"> {}

type PrepareEvidenceHydrationForTest = (
  previous: WorkspaceState,
  installed: WorkspaceState,
  authoritative: CanvasSession,
  scope: EvidenceHydrationScopeForTest,
) => {
  workspace: WorkspaceState;
  requests: EvidenceHydrationRequestForTest[];
  clearedRunIds: string[];
};

interface EvidenceHydratorForTest {
  schedule(requests: EvidenceHydrationRequestForTest[]): Promise<void>;
  evidenceFor(scope: EvidenceDisplayScopeForTest): RunEvidence | undefined;
  discard(runIds: readonly string[]): void;
}

type CreateEvidenceHydratorForTest = (options: {
  getWorkspace: () => WorkspaceState;
  getGeneration: (scope: EvidenceHydrationScopeForTest) => number;
  loadEvidence: (queryRoot: string, runId: string) => Promise<RunEvidence>;
  replaceWorkspace: (workspace: WorkspaceState) => void;
}) => EvidenceHydratorForTest;

type WorkspaceForRendererLoadForTest = (
  workspace: WorkspaceState,
  desktopBackendAvailable: boolean,
) => WorkspaceState;

function applyWorkflowResponseForTest(): ApplyWorkflowResponseForTest {
  const helper = Reflect.get(AppModule, "applyAuthoritativeWorkflowSessionResponse");
  expect(helper).toBeTypeOf("function");
  return helper as ApplyWorkflowResponseForTest;
}

function applyWorkflowBroadcastForTest(): ApplyWorkflowBroadcastForTest {
  const helper = Reflect.get(AppModule, "applyAuthoritativeWorkflowBroadcast");
  expect(helper).toBeTypeOf("function");
  return helper as ApplyWorkflowBroadcastForTest;
}

function decorateNewSessionInstallationForTest(): DecorateNewSessionInstallationForTest {
  const helper = Reflect.get(AppModule, "decorateNewSessionInstallation");
  expect(helper).toBeTypeOf("function");
  return helper as DecorateNewSessionInstallationForTest;
}

function prepareEvidenceHydrationForTest(): PrepareEvidenceHydrationForTest {
  const helper = Reflect.get(AppModule, "prepareAuthoritativeRunEvidenceHydration");
  expect(helper).toBeTypeOf("function");
  return helper as PrepareEvidenceHydrationForTest;
}

function createEvidenceHydratorForTest(): CreateEvidenceHydratorForTest {
  const helper = Reflect.get(AppModule, "createAuthoritativeRunEvidenceHydrator");
  expect(helper).toBeTypeOf("function");
  return helper as CreateEvidenceHydratorForTest;
}

function workspaceForRendererLoadForTest(): WorkspaceForRendererLoadForTest {
  const helper = Reflect.get(AppModule, "workspaceForRendererLoad");
  expect(helper).toBeTypeOf("function");
  return helper as WorkspaceForRendererLoadForTest;
}

function workflowProjectForTest(
  id: string,
  rootPath: string,
  canonicalRootPath: string | undefined,
) {
  return {
    id,
    name: id,
    rootPath,
    ...(canonicalRootPath === undefined ? {} : { canonicalRootPath }),
    devflowPath: `${rootPath}/.devflow`,
    openedAt: "2026-07-21T00:00:00.000Z",
  };
}

function workflowEnvelopeForTest(
  canvasSession: CanvasSession,
  overrides: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    protocolVersion: 1,
    projectRoot: "/canonical/project-1",
    sessionId: canvasSession.id,
    canvasSession,
    ...overrides,
  };
}

function workflowGuardForTest(
  requestSession: CanvasSession | null,
  overrides: Partial<WorkflowResponseGuardForTest> = {},
): WorkflowResponseGuardForTest {
  return {
    projectId: requestSession?.projectId ?? "project-1",
    queryRoot: "/opened/project-1-alias",
    canonicalRoot: "/canonical/project-1",
    sessionId: requestSession?.id ?? "session-1",
    requestSession,
    generation: 1,
    ...overrides,
  };
}

function workflowWorkspaceForTest(
  projects: WorkspaceState["projects"],
  sessions: WorkspaceState["sessions"],
): WorkspaceState {
  return {
    ...emptyWorkspace(),
    projects,
    sessions,
    activeProjectId: projects[0]?.id ?? null,
    activeSessionId: sessions[0]?.id ?? null,
  };
}

function mockNode(agent: "hermes" | "codex" = "codex"): CanvasNode {
  return {
    id: "test-node",
    title: "Test",
    agent,
    status: "pending",
    progress: "",
    runId: "run-1",
    changesetId: "cs-1",
    position: { x: 0, y: 0 },
    output: ["Some prose output that should not be diffed"],
    context: {
      brief: "",
      sessionGoal: "",
      relatedRequirements: "",
      relatedDesign: "",
      relatedTasks: "",
      dependencies: [],
      constraints: [],
    },
    worktree: {
      path: "",
      branchName: "branch",
      baselineRef: "base",
      baseCommit: "base",
    },
  };
}

function mockRunEvidence(overrides: Partial<RunEvidence> = {}): RunEvidence {
  return {
    runId: "run-1",
    status: "succeeded",
    exitCode: 0,
    changesetId: "cs-1",
    checks: [{ kind: "test", name: "unit", status: "passed" }],
    artifacts: [".devflow/acceptance/patch.diff", ".devflow/acceptance/screenshot.png"],
    review: null,
    errorReason: null,
    cancelReason: null,
    completedAt: "2026-06-27T00:00:00.000Z",
    ...overrides,
  };
}

function terminalCanvasSessionForTest(
  sessionId: string,
  projectId: string,
  nodeId: string,
  runId: string,
  status: "completed" | "failed" = "completed",
): CanvasSession {
  return {
    ...canvasSessionForTest(sessionId, projectId),
    activeNodeId: nodeId,
    nodes: [{
      ...mockNode("codex"),
      id: nodeId,
      runId,
      status,
    }],
  };
}

function evidenceHydrationScopeForTest(
  session: CanvasSession,
  overrides: Partial<EvidenceHydrationScopeForTest> = {},
): EvidenceHydrationScopeForTest {
  return {
    projectId: session.projectId,
    queryRoot: `/opened/${session.projectId}-alias`,
    canonicalRoot: `/canonical/${session.projectId}`,
    sessionId: session.id,
    generation: 1,
    ...overrides,
  };
}

function deferred<T>(): {
  promise: Promise<T>;
  resolve(value: T): void;
} {
  let resolvePromise: ((value: T) => void) | undefined;
  const promise = new Promise<T>((resolve) => {
    resolvePromise = resolve;
  });
  return {
    promise,
    resolve(value) {
      resolvePromise?.(value);
    },
  };
}

function editablePlanSession(): PlanSession {
  const readyStage = {
    status: "ready" as const,
    accepted: true,
    draft: "",
    error: null,
    runId: null,
    operation: null,
    checkpoints: [],
  };
  return {
    id: "plan-edit-test",
    projectId: "project-1",
    title: "Editable Plan",
    goal: "Repair Plan editing",
    mode: "plan",
    kind: "plan",
    target: { executionTarget: "current_branch", selectedBranch: "main" },
    createdAt: "2026-07-16T00:00:00.000Z",
    updatedAt: "2026-07-16T00:00:00.000Z",
    plan: {
      requirements: "# Requirements",
      design: "# Design",
      tasks: "# Tasks",
    },
    stateVersion: 0,
    activeStage: "tasks",
    plannerConversationId: "hermes-plan-edit-test",
    conversationStarted: true,
    stages: {
      requirements: { ...readyStage },
      design: { ...readyStage },
      tasks: { ...readyStage },
    },
    nodes: [],
    edges: [],
    activeNodeId: null,
  };
}

function workspaceWithPlan(session: PlanSession) {
  return {
    projects: [{
      id: "project-1",
      name: "Project",
      rootPath: "/repo",
      devflowPath: "/repo/.devflow",
      openedAt: "2026-07-16T00:00:00.000Z",
    }],
    sessions: [session],
    changesets: {},
    agents: [],
    runs: {},
    runEvents: {},
    runEvidence: {},
    activeProjectId: "project-1",
    activeSessionId: session.id,
    sidebarCollapsed: false,
    collapsedProjectIds: [],
  };
}

describe("Plan finish workflow handoff", () => {
  it("owns Finish synchronously, locks while pending, and calls the backend once", async () => {
    const createController = Reflect.get(AppModule, "createPlanFinishController") as undefined | (() => {
      acquire(sessionId: string): boolean;
      isInFlight(sessionId: string): boolean;
      release(sessionId: string): void;
    });
    expect(createController).toBeTypeOf("function");
    const controller = createController!();
    let backendCalls = 0;
    let releaseBackend: (() => void) | undefined;
    const backend = new Promise<void>((resolve) => { releaseBackend = resolve; });
    const finish = async () => {
      if (!controller.acquire("plan-edit-test")) return;
      try {
        backendCalls += 1;
        await backend;
      } finally {
        controller.release("plan-edit-test");
      }
    };

    const first = finish();
    const duplicate = finish();
    expect(backendCalls).toBe(1);
    expect(controller.isInFlight("plan-edit-test")).toBe(true);
    releaseBackend!();
    await Promise.all([first, duplicate]);
    expect(controller.isInFlight("plan-edit-test")).toBe(false);
  });

  it("installs a finished Canvas only when the exact Plan boundary still matches", () => {
    const capture = Reflect.get(AppModule, "capturePlanFinishBoundary") as undefined | ((session: PlanSession) => unknown);
    const install = Reflect.get(AppModule, "installFinishedPlanCanvas") as undefined | ((
      workspace: ReturnType<typeof workspaceWithPlan>,
      boundary: unknown,
      canvas: ReturnType<typeof convertPlanToCanvas>,
    ) => { workspace: ReturnType<typeof workspaceWithPlan>; installed: boolean });
    expect(capture).toBeTypeOf("function");
    expect(install).toBeTypeOf("function");
    const plan = editablePlanSession();
    const workspace = workspaceWithPlan(plan);
    const boundary = capture!(plan);
    const canvas = convertPlanToCanvas(plan);

    const normal = install!(workspace, boundary, canvas);
    expect(normal.installed).toBe(true);
    expect(normal.workspace.sessions[0]).toEqual(canvas);

    const changedPlan = editPlanStage(plan, "tasks", "# Forced post-boundary change");
    const changedWorkspace = workspaceWithPlan(changedPlan);
    const stale = install!(changedWorkspace, boundary, canvas);
    expect(stale.installed).toBe(false);
    expect(stale.workspace).toBe(changedWorkspace);
    expect(stale.workspace.sessions[0]).toEqual(changedPlan);
  });

  it("installs the exact project's finished Canvas when another project has the same session id", () => {
    const capture = Reflect.get(AppModule, "capturePlanFinishBoundary") as undefined | ((session: PlanSession) => unknown);
    const install = Reflect.get(AppModule, "installFinishedPlanCanvas") as undefined | ((
      workspace: ReturnType<typeof workspaceWithPlan>,
      boundary: unknown,
      canvas: ReturnType<typeof convertPlanToCanvas>,
    ) => { workspace: ReturnType<typeof workspaceWithPlan>; installed: boolean });
    expect(capture).toBeTypeOf("function");
    expect(install).toBeTypeOf("function");
    const plan = editablePlanSession();
    const unrelatedPlan = { ...plan, projectId: "project-2" };
    const workspace = {
      ...workspaceWithPlan(plan),
      sessions: [unrelatedPlan, plan],
    };
    const boundary = capture!(plan);
    const canvas = convertPlanToCanvas(plan);

    const result = install!(workspace, boundary, canvas);

    expect(result.installed).toBe(true);
    expect(result.workspace.sessions[0]).toBe(unrelatedPlan);
    expect(result.workspace.sessions[1]).toEqual(canvas);
  });

  it.each([
    ["another project", "project-2", "other-project-session", "project-2"],
    ["another session", "project-1", "other-session", "project-1"],
  ])("installs a late finished Canvas without stealing focus from %s", (
    _label,
    activeProjectId,
    activeSessionId,
    activeSessionProjectId,
  ) => {
    const plan = editablePlanSession();
    const activeSession = canvasSessionForTest(activeSessionId, activeSessionProjectId);
    const workspace = {
      ...workspaceWithPlan(plan),
      projects: [
        workflowProjectForTest("project-1", "/project-1", "/project-1"),
        workflowProjectForTest("project-2", "/project-2", "/project-2"),
      ],
      sessions: [plan, activeSession],
      activeProjectId,
      activeSessionId,
    };
    const boundary = AppModule.capturePlanFinishBoundary(plan);
    const canvas = convertPlanToCanvas(plan);

    const result = AppModule.installFinishedPlanCanvas(workspace, boundary, canvas);

    expect(result.installed).toBe(true);
    expect(result.workspace.sessions).toEqual([canvas, activeSession]);
    expect(result.workspace.activeProjectId).toBe(activeProjectId);
    expect(result.workspace.activeSessionId).toBe(activeSessionId);
  });

  it("hands the exact approved Plan to the dedicated backend finish boundary and returns its authoritative canvas", async () => {
    const finish = Reflect.get(AppModule, "finishPlanSession") as undefined | ((
      project: { id: string; name: string; rootPath: string; canonicalRootPath: string; devflowPath: string; openedAt: string },
      session: PlanSession,
    ) => Promise<unknown>);
    expect(finish).toBeTypeOf("function");
    if (!finish) return;
    const plan = editablePlanSession();
    const localCanvas = convertPlanToCanvas(plan);
    const authoritativeCanvas = {
      ...localCanvas,
      plannerNodeId: "backend-planner",
      activeNodeId: "backend-planner",
      nodes: [{
        ...mockNode("hermes"),
        id: "backend-planner",
        title: "Authoritative backend planner",
        runId: "backend-run",
        changesetId: "backend-changeset",
      }],
      edges: [],
    };
    const calls: Array<{ kind: string; input: unknown }> = [];
    vi.stubGlobal("window", {
      devflow: {
        finishPlanWorkflow: async (projectRoot: string, input: unknown) => {
          expect(projectRoot).toBe("/opened/repo-alias");
          calls.push({ kind: "finish", input });
          return {
            protocolVersion: 1,
            projectRoot: "/repo",
            sessionId: plan.id,
            event: {},
            ledger: {},
            projection: {},
            canvasSession: authoritativeCanvas,
          };
        },
      },
    });
    try {
      const result = await finish({
        id: "project-1",
        name: "Project",
        rootPath: "/opened/repo-alias",
        canonicalRootPath: "/repo",
        devflowPath: "/repo/.devflow",
        openedAt: "2026-07-17T00:00:00.000Z",
      }, plan);

      expect(result).toEqual(authoritativeCanvas);
      expect((result as typeof authoritativeCanvas).nodes.map((node) => node.title)).toEqual([
        "Authoritative backend planner",
      ]);
      expect(calls).toEqual([{
        kind: "finish",
        input: {
          planSessionId: plan.id,
          session: {
            id: localCanvas.id,
            projectId: localCanvas.projectId,
            title: localCanvas.title,
            goal: localCanvas.goal,
            mode: localCanvas.mode,
            target: localCanvas.target,
          },
        },
      }]);
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("fails closed when workflow append omits the authoritative canvas", async () => {
    const finish = Reflect.get(AppModule, "finishPlanSession") as undefined | ((project: unknown, session: PlanSession) => Promise<unknown>);
    expect(finish).toBeTypeOf("function");
    if (!finish) return;
    vi.stubGlobal("window", {
      devflow: {
        finishPlanWorkflow: async () => ({
          protocolVersion: 1,
          projectRoot: "/repo",
          sessionId: "plan-edit-test",
          canvasSession: null,
        }),
      },
    });
    try {
      await expect(finish({
        id: "project-1",
        rootPath: "/opened/repo-alias",
        canonicalRootPath: "/repo",
      }, editablePlanSession())).rejects.toThrow(
        "Authoritative canvas session was not returned.",
      );
    } finally {
      vi.unstubAllGlobals();
    }
  });
});

describe("deriveSessionTarget", () => {
  it("reuses one insert-before requestId after a committed IPC response is lost", async () => {
    const tracker = createInsertBeforeIntentRequestTracker(() => "request-1");
    const requestIds: string[] = [];
    const durableNodes = [{ id: "lane-target", title: "Target" }];
    let calls = 0;
    const insertBefore = async (_root: string, request: { requestId: string }) => {
      requestIds.push(request.requestId);
      if (!durableNodes.some((node) => node.id === `clarification-${request.requestId}`)) {
        durableNodes.unshift({ id: `clarification-${request.requestId}`, title: "Clarification" });
      }
      calls += 1;
      if (calls === 1) throw new Error("response lost after commit");
      return {
        canvasSession: { id: "session-1", kind: "canvas", nodes: durableNodes, edges: [] },
      } as never;
    };
    const submit = () => submitInsertBeforeIntent({
      projectRoot: "/repo",
      sessionId: "session-1",
      targetLaneId: "lane-target",
      requestId: tracker.requestIdFor("session-1", "lane-target"),
      insertBefore: insertBefore as never,
      replaceCanvasSession: () => tracker.clear("session-1", "lane-target"),
    });

    await expect(submit()).rejects.toThrow("response lost after commit");
    await expect(submit()).resolves.toBe(true);

    expect(requestIds).toEqual(["request-1", "request-1"]);
    expect(durableNodes.filter((node) => node.title === "Clarification")).toHaveLength(1);
  });

  it("keeps separate pending insert-before requestIds when switching targets", () => {
    let sequence = 0;
    const tracker = createInsertBeforeIntentRequestTracker(() => `request-${++sequence}`);

    expect(tracker.requestIdFor("session-1", "lane-a")).toBe("request-1");
    expect(tracker.requestIdFor("session-1", "lane-a")).toBe("request-1");
    expect(tracker.requestIdFor("session-1", "lane-b")).toBe("request-2");
    expect(tracker.requestIdFor("session-1", "lane-a")).toBe("request-1");
  });

  it("reconstructs an insert-before tracker from the durable pending request identity", () => {
    const restarted = createInsertBeforeIntentRequestTracker(() => "request-after-restart");
    const requestIdFor = restarted.requestIdFor as (
      sessionId: string,
      targetLaneId: string,
      durableRequestId?: string,
    ) => string;

    expect(requestIdFor("session-1", "lane-a", "request-before-restart")).toBe("request-before-restart");
    expect(requestIdFor("session-1", "lane-a")).toBe("request-before-restart");
  });

  it("submits only insert intent and adopts the authoritative session", async () => {
    const authoritative = { id: "session-1", kind: "canvas", nodes: [], edges: [] } as never;
    const requests: unknown[] = [];
    const replacements: unknown[] = [];
    const handled = await submitInsertBeforeIntent({
      projectRoot: "/repo",
      sessionId: "session-1",
      targetLaneId: "lane-target",
      requestId: "request-1",
      insertBefore: async (_root, request) => {
        requests.push(request);
        return { canvasSession: authoritative } as never;
      },
      replaceCanvasSession: (session) => replacements.push(session),
    });
    expect(handled).toBe(true);
    expect(requests).toEqual([{ sessionId: "session-1", targetLaneId: "lane-target", requestId: "request-1" }]);
    expect(replacements).toEqual([authoritative]);
  });

  it("does not apply browser fallback when desktop insert rejects", async () => {
    let replaced = false;
    await expect(submitInsertBeforeIntent({
      projectRoot: "/repo", sessionId: "session-1", targetLaneId: "lane-target", requestId: "request-1",
      insertBefore: async () => { throw new Error("response failed"); },
      replaceCanvasSession: () => { replaced = true; },
    })).rejects.toThrow("response failed");
    expect(replaced).toBe(false);
  });

  it("keeps insert-before intent-only when the desktop backend is unavailable", async () => {
    const appSource = await readSource("./App.tsx");
    const insertBefore = appSource.slice(
      appSource.indexOf("async function insertBefore"),
      appSource.indexOf("async function openEditor"),
    );
    const submitIntent = appSource.slice(
      appSource.indexOf("export async function submitInsertBeforeIntent"),
      appSource.indexOf("function upsertProject"),
    );

    expect(insertBefore).toContain("window.devflow?.workflow?.insertBefore");
    expect(insertBefore).toContain("getPendingInsertBeforeRequest");
    expect(insertBefore).toContain("replaceCanvasSession");
    expect(insertBefore).toContain("setNodeActionError(INSERT_BEFORE_UNAVAILABLE_ERROR)");
    expect(insertBefore).not.toContain("updateCanvasSession");
    expect(insertBefore).not.toContain("insertBeforeBrowserFallback");
    expect(insertBefore).not.toContain("...target,");
    expect(insertBefore).not.toContain("runtimePolicy");
    expect(appSource).not.toContain("function insertBeforeBrowserFallback");
    expect(INSERT_BEFORE_UNAVAILABLE_ERROR).toBe("Insert before is unavailable because the desktop workflow backend is not connected.");
    expect(submitIntent).toContain("result.canvasSession");
    expect(submitIntent).toContain("replaceCanvasSession(result.canvasSession, result)");
  });

  it("uses current_branch executionTarget and selectedBranch", () => {
    const target = deriveSessionTarget("current_branch", "main");
    expect(target).toEqual({
      executionTarget: "current_branch",
      selectedBranch: "main",
    });
  });

  it("uses new_worktree executionTarget with baseRef semantics", () => {
    const target = deriveSessionTarget("new_worktree", "feature");
    expect(target).toEqual({
      executionTarget: "new_worktree",
      selectedBranch: "feature",
      baseRef: "feature",
    });
  });
});

describe("canvas node position persistence", () => {
  it("keeps pointer-move positions local and commits workspace state only on drag stop", async () => {
    const appSource = await readSource("./App.tsx");
    const moveHandler = appSource.slice(
      appSource.indexOf("const handleNodesChange"),
      appSource.indexOf("const handleNodeDragStop"),
    );
    const stopHandler = appSource.slice(
      appSource.indexOf("const handleNodeDragStop"),
      appSource.indexOf("return (", appSource.indexOf("const handleNodeDragStop")),
    );

    expect(moveHandler).toContain("onFlowNodesChange(changes)");
    expect(moveHandler).not.toContain("onNodePositionCommit");
    expect(moveHandler).not.toContain("setWorkspace");
    expect(stopHandler).toContain("await onNodePositionCommit(finalCanvasNodePositionUpdate(node))");
    expect(stopHandler.match(/onNodePositionCommit\(/g)).toHaveLength(1);
  });

  it("reports a bounded save error and restores the persisted position when IPC fails", async () => {
    const appSource = await readSource("./App.tsx");
    const stopHandler = appSource.slice(
      appSource.indexOf("const handleNodeDragStop"),
      appSource.indexOf("return (", appSource.indexOf("const handleNodeDragStop")),
    );
    const canvasView = appSource.slice(
      appSource.indexOf("function CanvasView("),
      appSource.indexOf("function CanvasViewportController"),
    );

    expect(stopHandler).toContain("catch");
    expect(stopHandler).toContain("persistedNode.position");
    expect(canvasView).toContain('role="alert"');
    expect(canvasView).toContain("positionSaveError");
  });

  it("retries an ambiguous IPC failure once with the same idempotency key", async () => {
    const appSource = await readSource("./App.tsx");
    const commitHandler = appSource.slice(
      appSource.indexOf("const commitActiveNodePosition"),
      appSource.indexOf("async function importProject"),
    );

    expect(commitHandler).toContain("const updateId = crypto.randomUUID()");
    expect(commitHandler).toContain("const persistPosition = () => workflow.updateNodePosition");
    expect(commitHandler.match(/await persistPosition\(\)/g)).toHaveLength(2);
  });
});

describe("changes logic", () => {
  const node = mockNode("codex");

  describe("changeReviewSummary", () => {
    it("returns unknown for unknown status", () => {
      const summary = changeReviewSummary(node, {
        id: "cs-1",
        files: [],
        diffStat: { added: 0, changed: 0, deleted: 0 },
        patchPreview: "",
        source: "git",
        evidence: {
          evidenceId: "ev-1",
          changesetId: "cs-1",
          source: "git",
          status: "unknown",
          files: [],
          diffStat: { added: 0, changed: 0, deleted: 0 },
          patchPreviewTruncated: false,
        },
      });
      expect(summary).toBe("Codex has unknown change evidence for cs-1.");
    });

    it("returns empty for empty status", () => {
      const summary = changeReviewSummary(node, {
        id: "cs-1",
        files: [],
        diffStat: { added: 0, changed: 0, deleted: 0 },
        patchPreview: "",
        source: "git",
        evidence: {
          evidenceId: "ev-1",
          changesetId: "cs-1",
          source: "git",
          status: "empty",
          files: [],
          diffStat: { added: 0, changed: 0, deleted: 0 },
          patchPreviewTruncated: false,
        },
      });
      expect(summary).toBe("Codex has no available change evidence for cs-1.");
    });
  });

  describe("hasFinalGitEvidence", () => {
    it("returns true when reconciliation has available status", () => {
      const reconciliation: FinalChangesetReconciliation = {
        status: "available",
        changeset: {
          id: "cs-1",
          files: ["test.ts"],
          diffStat: { added: 1, changed: 1, deleted: 0 },
          patchPreview: "diff",
          source: "git",
        },
        metadata: {
          source: "git",
          executionTarget: "current_branch",
          selectedBranch: "main",
          baselineRef: "main",
        },
      };
      expect(hasFinalGitEvidence(reconciliation, null)).toBe(true);
    });

    it("returns true when reconciliation has mismatch status", () => {
      const reconciliation: FinalChangesetReconciliation = {
        status: "mismatch",
        changeset: {
          id: "cs-1",
          files: ["test.ts"],
          diffStat: { added: 1, changed: 1, deleted: 0 },
          patchPreview: "diff",
          source: "git",
        },
        metadata: {
          source: "git",
          executionTarget: "current_branch",
          selectedBranch: "main",
          baselineRef: "main",
        },
        mismatches: [
          { kind: "file-set", liveFiles: ["other.ts"], gitFiles: ["test.ts"] },
        ],
      };
      expect(hasFinalGitEvidence(reconciliation, null)).toBe(true);
    });

    it("returns false when reconciliation has empty or failed status", () => {
      const reconciliation: FinalChangesetReconciliation = {
        status: "empty",
        changeset: {
          id: "cs-1",
          files: [],
          diffStat: { added: 0, changed: 0, deleted: 0 },
          patchPreview: "",
          source: "git",
        },
        metadata: {
          source: "git",
          executionTarget: "current_branch",
          selectedBranch: "main",
          baselineRef: "main",
        },
      };
      expect(hasFinalGitEvidence(reconciliation, null)).toBe(false);
    });

    it("falls back to changeset evidence if reconciliation is null", () => {
      expect(
        hasFinalGitEvidence(null, {
          id: "cs-1",
          files: ["test.ts"],
          diffStat: { added: 1, changed: 1, deleted: 0 },
          patchPreview: "diff",
          source: "git",
          evidence: {
            evidenceId: "ev-1",
            changesetId: "cs-1",
            source: "git",
            status: "available",
            files: ["test.ts"],
            diffStat: { added: 1, changed: 1, deleted: 0 },
            patchPreviewTruncated: false,
          },
        })
      ).toBe(true);
    });
  });
});

async function readSource(path: string): Promise<string> {
  return readFile(new URL(path, import.meta.url), "utf8");
}

describe("UI source validation", () => {
  it("does not use inline styles in Session controls and ChangesTab", async () => {
    const appSource = await readSource("./App.tsx");
    // Ensure we do not use inline styles in the target-selector
    const sessionComposer = appSource.slice(appSource.indexOf("function SessionComposer"), appSource.indexOf("function formatRelativeTime"));
    expect(sessionComposer).not.toContain("style={{");

    // Ensure we do not use inline styles in ChangesTab
    const changesTab = appSource.slice(appSource.indexOf("function ChangesTab"));
    expect(changesTab).not.toContain("style={{");
  });

  it("ContextTab renders run evidence facts and handles missing evidence", async () => {
    const appSource = await readSource("./App.tsx");
    const contextTab = appSource.slice(appSource.indexOf("function ContextTab("), appSource.indexOf("function WorktreeActions"));
    expect(contextTab).toContain("RunEvidenceFacts runEvidence={runEvidence}");
    expect(contextTab).toContain("No run evidence yet");
  });

  it("formats succeeded run evidence without output logs", () => {
    expect(runEvidenceFactsForDisplay(mockRunEvidence())).toEqual([
      { label: "Run ID", value: "run-1" },
      { label: "Run status", value: "succeeded" },
      { label: "Exit code", value: "0" },
      { label: "Checks", value: "test [unit]: passed" },
      { label: "Artifacts", value: "2 (.devflow/acceptance/patch.diff, .devflow/acceptance/screenshot.png)" },
    ]);
  });

  it("formats completed validation evidence with screenshot artifact paths", () => {
    expect(
      runEvidenceFactsForDisplay(mockRunEvidence({
        checks: [
          {
            kind: "test",
            name: "corepack pnpm --filter @skyturn/ui-canvas run test",
            status: "passed",
            detail: "118 tests passed",
          },
          {
            kind: "build",
            name: "ui-canvas build",
            status: "passed",
            detail: "tsc -p tsconfig.json",
          },
        ],
        artifacts: [".devflow/acceptance/node-modal/context-screenshot.png"],
      })),
    ).toEqual([
      { label: "Run ID", value: "run-1" },
      { label: "Run status", value: "succeeded" },
      { label: "Exit code", value: "0" },
      {
        label: "Checks",
        value: "test [corepack pnpm --filter @skyturn/ui-canvas run test]: passed - 118 tests passed, build [ui-canvas build]: passed - tsc -p tsconfig.json",
      },
      { label: "Artifacts", value: "1 (.devflow/acceptance/node-modal/context-screenshot.png)" },
    ]);
  });

  it("formats commit node change evidence without output logs", () => {
    const changeset: Changeset = {
      id: "cs-commit",
      files: ["packages/ui-canvas/src/App.tsx", "packages/ui-canvas/src/App.test.ts"],
      diffStat: { added: 12, changed: 2, deleted: 3 },
      patchPreview: "diff --git",
      source: "git",
      evidence: {
        evidenceId: "ev-commit",
        changesetId: "cs-commit",
        source: "git",
        status: "available",
        files: ["packages/ui-canvas/src/App.tsx", "packages/ui-canvas/src/App.test.ts"],
        diffStat: { added: 12, changed: 2, deleted: 3 },
        patchPreviewTruncated: false,
      },
    };
    const commitEvidence: DeliveryCommitSummary = {
      commitSha: "abc123456789",
      branch: "feat/node-modal-evidence-density",
      subject: "feat(ui-canvas): clarify node completion evidence",
    };

    expect(changeEvidenceFactsForDisplay(null, changeset, commitEvidence)).toEqual([
      { label: "Changeset status", value: "available" },
      {
        label: "Changed files",
        value: "2 (packages/ui-canvas/src/App.tsx, packages/ui-canvas/src/App.test.ts)",
      },
      { label: "Diff stat", value: "+12 / -3 across 2 files" },
      { label: "Repo state", value: "Git changes recorded" },
      { label: "Commit", value: "abc1234 on feat/node-modal-evidence-density" },
    ]);
  });

  it("formats clean repo changeset evidence as an explicit empty state", () => {
    const changeset: Changeset = {
      id: "cs-clean",
      files: [],
      diffStat: { added: 0, changed: 0, deleted: 0 },
      patchPreview: "",
      source: "git",
      evidence: {
        evidenceId: "ev-clean",
        changesetId: "cs-clean",
        source: "git",
        status: "empty",
        files: [],
        diffStat: { added: 0, changed: 0, deleted: 0 },
        patchPreviewTruncated: false,
      },
    };
    const reconciliation: FinalChangesetReconciliation = {
      status: "empty",
      changeset,
      metadata: {
        source: "git",
        executionTarget: "current_branch",
        selectedBranch: "feat/node-modal-evidence-density",
        baselineRef: "main",
      },
    };

    expect(changeEvidenceFactsForDisplay(reconciliation, changeset, null)).toEqual([
      { label: "Changeset status", value: "empty" },
      { label: "Changed files", value: "None" },
      { label: "Diff stat", value: "+0 / -0 across 0 files" },
      { label: "Repo state", value: "Clean at collection" },
    ]);
  });

  it("ChangesTab renders structured changeset facts in the existing Changes tab", async () => {
    const appSource = await readSource("./App.tsx");
    const changesTab = appSource.slice(appSource.indexOf("function ChangesTab("), appSource.indexOf("export function changeReviewSummary("));
    expect(changesTab).toContain("changeEvidenceFactsForDisplay(reconciliation, changeset, commitEvidence)");
    expect(appSource).toContain('aria-label="Changeset evidence facts"');
    expect(changesTab).not.toContain("node.output");
  });

  it("formats failed, timed-out, and cancelled run evidence reasons", () => {
    expect(runEvidenceFactsForDisplay(mockRunEvidence({ status: "failed", exitCode: 1, errorReason: "tests failed" }))).toContainEqual({
      label: "Reason",
      value: "Error: tests failed",
    });
    expect(runEvidenceFactsForDisplay(mockRunEvidence({
      status: "timed-out",
      exitCode: null,
      errorReason: null,
      checks: [{ kind: "run-timeout", name: "watchdog", status: "failed", detail: "watchdog expired" }],
    }))).toContainEqual({
      label: "Reason",
      value: "Timeout: watchdog expired",
    });
    expect(runEvidenceFactsForDisplay(mockRunEvidence({ status: "cancelled", exitCode: null, cancelReason: "user stopped run" }))).toContainEqual({
      label: "Reason",
      value: "Cancelled: user stopped run",
    });
  });

  it("summarizes failed selected nodes from run evidence instead of output prose", () => {
    expect(failureSummaryForNode(mockNode(), mockRunEvidence({
      status: "failed",
      exitCode: 1,
      errorReason: "vitest failed",
      checks: [{ kind: "test", name: "unit", status: "failed", detail: "2 failed" }],
    }))).toBe("Failed: Error: vitest failed");

    expect(failureSummaryForNode(mockNode(), mockRunEvidence({
      status: "timed-out",
      exitCode: null,
      errorReason: null,
      checks: [{ kind: "run-timeout", name: "watchdog", status: "failed", detail: "watchdog expired" }],
    }))).toBe("Failed: Timeout: watchdog expired");

    expect(failureSummaryForNode(mockNode(), mockRunEvidence({
      status: "cancelled",
      exitCode: null,
      cancelReason: "user stopped run",
      checks: [{ kind: "run-exit", name: "Codex CLI exit", status: "failed", detail: "SIGTERM" }],
    }))).toBe("Failed: Cancelled: user stopped run");

    expect(failureSummaryForNode({
      ...mockNode(),
      status: "failed",
      output: ["Agent says success"],
      progress: "Typecheck failed",
    }, null)).toBe("Failed: Typecheck failed");
  });

  it("shows the latest failed check as structured evidence", () => {
    expect(latestFailedCheckForDisplay(mockRunEvidence({
      checks: [
        { kind: "test", name: "unit", status: "failed", detail: "2 failed" },
        { kind: "build", name: "tsc", status: "failed", detail: "TS2322" },
      ],
    }))).toBe("tsc: failed - TS2322");
    expect(latestFailedCheckForDisplay(mockRunEvidence({
      checks: [{ kind: "test", name: "unit", status: "passed" }],
    }))).toBeNull();
  });

  it("keeps essential new-session controls while removing secondary intake hints", async () => {
    const appSource = await readSource("./App.tsx");

    const sessionComposer = appSource.slice(appSource.indexOf("function SessionComposer("), appSource.indexOf("function formatRelativeTime("));
    expect(sessionComposer).not.toContain("<select");
    expect(sessionComposer).toContain("<CustomSelect");
    expect(sessionComposer).toContain("options={[");
    expect(sessionComposer).not.toContain("paper-pin-btn");
    expect(sessionComposer).not.toContain("Focus prompt");
    expect(sessionComposer).not.toContain("target-selector-hint");
    expect(sessionComposer).not.toContain("Develop directly on the selected branch.");
    expect(sessionComposer).not.toContain("Create a candidate worktree from the selected branch.");
    expect(sessionComposer).toContain("<ProjectDropdown");
    expect(sessionComposer).toContain("<ModeSwitch");
    expect(sessionComposer).toContain('ariaLabel="Execution Target"');
    expect(sessionComposer).toContain('ariaLabel="Branch"');
    expect(sessionComposer).toContain('title="Create"');

    const projectDropdown = appSource.slice(appSource.indexOf("function ProjectDropdown("), appSource.indexOf("function ModeSwitch("));
    const modeSwitch = appSource.slice(appSource.indexOf("function ModeSwitch("), appSource.indexOf("function StatusLight("));
    expect(projectDropdown).toContain('aria-label="Project"');
    expect(modeSwitch).toContain("Canvas");
    expect(modeSwitch).toContain("Plan");
    expect(modeSwitch).not.toContain("Fast");
    expect(modeSwitch).toContain('aria-pressed={mode === "fast"}');
    expect(modeSwitch).toContain('aria-pressed={mode === "plan"}');
  });

  it("PlanView is a single-column document workspace with Preview/Source controls", async () => {
    const appSource = await readSource("./App.tsx");
    const planSurface = appSource.slice(
      appSource.indexOf("function PlanMarkdownPreview("),
      appSource.indexOf("function CanvasView("),
    );
    const planView = appSource.slice(appSource.indexOf("function PlanView("), appSource.indexOf("function CanvasView("));

    expect(planView).toContain('className="plan-view"');
    expect(planView).toContain('className="plan-toolbar"');
    expect(planView).toContain('className="plan-document"');
    expect(planView).toContain('className="plan-composer"');
    expect(planView).toContain('className="plan-stage-progress"');
    expect(planView).toContain('className="plan-view-toggle"');
    expect(planView).toContain('className="plan-undo-revision"');
    expect(planView).toContain('className="plan-error-banner"');
    expect(planView).toContain('className="plan-composer-send"');
    expect(planView).toContain('aria-label="Undo last revision"');
    expect(planView).toContain('aria-label="Send revision"');
    expect(planView).toContain('aria-label="Stop"');
    expect(planView).toContain('"Retry generation"');
    expect(planView).toContain('"Retry revision"');
    expect(planView).toContain('aria-label="Preview mode"');
    expect(planView).toContain('aria-label="Source mode"');
    expect(planView).toContain('aria-pressed={effectiveViewMode === "preview"}');
    expect(planView).toContain('aria-pressed={effectiveViewMode === "source"}');
    expect(planView).toContain('aria-current={isCurrent ? "step" : undefined}');
    expect(planView).toContain('return session.stages.requirements.accepted;');
    expect(planView).toContain('return session.stages.design.accepted;');
    expect(planView).not.toContain('status !== "pending"');
    expect(planView).not.toContain('\n              Preview\n');
    expect(planView).not.toContain('\n              Source\n');
    expect(planView).not.toContain('role="list"');
    expect(planView).not.toContain('role="listitem"');
    expect(planView).toContain('aria-live="polite"');
    expect(planView).toContain("Finish Plan");
    expect(planView).toContain("Approve and continue to");
    expect(planView).toContain("<Undo2");
    expect(planView).toContain("<ArrowUp");
    expect(planView).toContain("activePlanMarkdown");
    expect(planView).toContain("const revisionAvailable = isPlanRevisionAvailable(stageState);");
    expect(planView).toContain('const [agentInstruction, setAgentInstruction] = useState("");');
    expect(planView).toContain("preservedFailedInstruction");
    expect(planView).toContain("retryFailedOperation");
    expect(planView).toContain("handleComposerKeyDown");
    expect(planView).toContain('event.key === "Enter" && !event.shiftKey');
    expect(planView).toContain("<PlanDocumentEditor");
    expect(planView).toContain("<PlanMarkdownPreview");
    expect(planSurface).toContain('className="plan-md-preview"');
    expect(planSurface).toContain('role="article"');
    expect((planSurface.match(/<ReactMarkdown/g) ?? [])).toHaveLength(1);
    expect(planView).not.toContain("plan-workspace");
    expect(planView).not.toContain("plan-editor-card");
    expect(planView).not.toContain("plan-preview-card");
    expect(planView).not.toContain("plan-header");
    expect(planView).not.toContain("plan-agent-panel");
    expect(planView).not.toContain("markdown-grid");
    expect(planView).not.toContain("Review one plan page at a time");
    expect(planView).not.toContain("Ask agent to revise this page");
    expect(planView).not.toContain("Convert only after");
    expect(planView).not.toContain("Edit this page");
    expect(planView).not.toContain("Request revision");
    expect(planView).not.toContain("STEP 1 OF 3");
    expect(planView).not.toContain("Step {activeIndex + 1} of");
    expect(planView).not.toContain("Convert to Canvas");
    expect(planView).not.toContain("Captured locally");
    expect(planView).not.toContain("Mock agent revision");
    expect(planView).toContain("Retry");
    expect(planView).toContain("<RefreshCw size={14} />");
    expect(planView).toContain("async function retryFailedOperation");
    expect(planView).toContain("onGenerate(activeStep.key)");
    expect(planView).toContain("onRevise(activeStep.key, instruction)");
  });

  it("renders GFM tables and highlighted typed code through the Plan preview", () => {
    const preview = Reflect.get(AppModule, "PlanMarkdownPreview") as
      | undefined
      | ((props: { markdown: string }) => ReturnType<typeof createElement>);
    expect(preview).toBeTypeOf("function");
    if (!preview) return;

    const html = renderToStaticMarkup(createElement(preview, {
      markdown: [
        "| Stage | Ready |",
        "| --- | --- |",
        "| Design | yes |",
        "",
        "```ts",
        'const stage: string = "design";',
        "```",
        "",
        '<script data-unsafe="true">alert("no")</script>',
      ].join("\n"),
    }));

    expect(html).toContain("<table>");
    expect(html).toContain('class="hljs language-ts"');
    expect(html).toContain('class="hljs-keyword"');
    expect(html).not.toContain("<script");
  });

  it.each([
    ["error", "generate", "# Preserved canonical", false, false],
    ["error", "revise", "# Preserved canonical", false, true],
    ["error", "revise", "   ", false, false],
    ["error", null, "# Preserved canonical", false, false],
    ["ready", null, "# Requirements", false, true],
    ["editing", null, "# Requirements", false, true],
    ["generating", "generate", "# Requirements", false, false],
    ["streaming", "generate", "# Requirements", false, false],
    ["revising", "revise", "# Requirements", false, false],
    ["idle_empty", null, "", false, false],
    ["ready", null, "# Requirements", true, false],
  ] as const)(
    "Next for phase=%s operation=%s markdown=%s locked=%s is %s",
    (phase, operation, markdown, locked, expected) => {
      expect(isPlanNextEnabled(phase, markdown, operation, locked)).toBe(expected);
    },
  );

  it("Plan control matrix keeps failed documents editable and running documents locked", () => {
    expect(isPlanSourceEditable("idle_empty", false, false)).toBe(true);
    expect(isPlanSourceEditable("idle_empty", false, true)).toBe(false);
    expect(isPlanSourceEditable("error", true, false)).toBe(true);
    expect(isPlanSourceEditable("error", false, false)).toBe(false);
    expect(isPlanSourceEditable("generating", true, false)).toBe(false);
    expect(isPlanSourceEditable("revising", true, false)).toBe(false);
    expect(isPlanSourceEditable("ready", true, false)).toBe(true);
    expect(derivePlanUiPhase({ status: "generating", draft: "" }, "", "preview", false)).toBe("generating");
    expect(derivePlanUiPhase({ status: "generating", draft: "# Stream" }, "# Stream", "preview", false)).toBe("streaming");
    expect(derivePlanUiPhase({ status: "revising", draft: "x" }, "x", "source", true)).toBe("revising");
    expect(derivePlanUiPhase({ status: "failed", draft: "" }, "# Keep", "source", false)).toBe("error");
    expect(derivePlanUiPhase({ status: "ready", draft: "" }, "# Ready", "source", true)).toBe("editing");
    const clearedPhase = derivePlanUiPhase({ status: "pending", draft: "" }, "", "source", true);
    expect(clearedPhase).toBe("idle_empty");
    expect(isPlanSourceEditable(clearedPhase, false, false)).toBe(true);

    const finishReady = editablePlanSession();
    expect(isPlanFinishEnabled(finishReady, "ready", false)).toBe(true);
    finishReady.stages.tasks.accepted = false;
    expect(isPlanFinishEnabled(finishReady, "ready", false)).toBe(true);
    finishReady.activeStage = "design";
    expect(isPlanFinishEnabled(finishReady, "ready", false)).toBe(false);
    finishReady.activeStage = "tasks";
    finishReady.stages.tasks.accepted = true;
    finishReady.stages.design.accepted = false;
    expect(isPlanFinishEnabled(finishReady, "ready", false)).toBe(false);
    finishReady.stages.design.accepted = true;
    finishReady.plan.tasks = "   ";
    expect(isPlanFinishEnabled(finishReady, "ready", false)).toBe(false);
    expect(isPlanFinishEnabled(editablePlanSession(), "revising", false)).toBe(false);
  });

  it("scopes Plan composer state to the session and active section only", async () => {
    const scopeKey = Reflect.get(AppModule, "planViewScopeKey") as
      | undefined
      | ((session: Pick<PlanSession, "id" | "activeStage">) => string);
    expect(scopeKey).toBeTypeOf("function");
    if (!scopeKey) return;

    const session = editablePlanSession();
    const tasksScope = scopeKey(session);
    session.stages.tasks.status = "revising";
    expect(scopeKey(session)).toBe(tasksScope);
    session.stages.tasks.status = "failed";
    expect(scopeKey(session)).toBe(tasksScope);

    session.activeStage = "design";
    expect(scopeKey(session)).not.toBe(tasksScope);
    session.activeStage = "tasks";
    session.id = "another-plan-session";
    expect(scopeKey(session)).not.toBe(tasksScope);

    const appSource = await readSource("./App.tsx");
    expect(appSource).toContain("key={planViewScopeKey(activeSession)}");
  });

  it.each([
    ["ready", null, true],
    ["failed", "revise", true],
    ["failed", "generate", false],
    ["pending", null, false],
    ["generating", "generate", false],
    ["revising", "revise", false],
  ] as const)(
    "allows revision only for %s with operation %s",
    (status, operation, expected) => {
      const state = {
        ...editablePlanSession().stages.requirements,
        status,
        operation,
      };

      expect(isPlanRevisionAvailable(state)).toBe(expected);
    },
  );

  it.each(["requirements", "design"] as const)(
    "reopens failed-revise %s as revision-enabled while failed-generate stays disabled",
    (stage) => {
      const session = editablePlanSession();
      session.activeStage = stage;
      session.stages[stage] = {
        ...session.stages[stage],
        status: "failed",
        operation: "revise",
        error: "Hermes ACP prompt failed.",
      };
      const persisted = JSON.parse(JSON.stringify(normalizeWorkspaceState(workspaceWithPlan(session))));
      const reopenedWorkspace = normalizeWorkspaceState(persisted);
      const reopened = reopenedWorkspace.sessions.find((item) => item.id === session.id);
      expect(reopened?.kind).toBe("plan");
      if (!reopened || reopened.kind !== "plan") return;
      expect(() => parsePlanBootstrapSession(reopened)).not.toThrow();
      expect(isPlanRevisionAvailable(reopened.stages[stage])).toBe(true);
      expect(isPlanRevisionAvailable({
        ...reopened.stages[stage],
        operation: "generate",
      })).toBe(false);
    },
  );

  it("uses one revision predicate at every PlanView submission boundary", async () => {
    const appSource = await readSource("./App.tsx");
    const planView = appSource.slice(appSource.indexOf("function PlanView("), appSource.indexOf("function CanvasView("));
    const submitRevision = planView.slice(
      planView.indexOf("async function submitRevision"),
      planView.indexOf("function requestAgentRevision"),
    );
    const retryFailed = planView.slice(
      planView.indexOf("async function retryFailedOperation"),
      planView.indexOf("const nextStep ="),
    );

    expect(submitRevision).toContain("!revisionAvailable");
    expect(submitRevision).toContain("onRevise(activeStep.key, instruction)");
    expect(submitRevision).toContain("setPreservedFailedInstruction(instruction)");
    expect(submitRevision).not.toContain("onGenerate");
    expect(retryFailed).toContain('stageState.operation === "generate"');
    expect(retryFailed).toContain("onGenerate(activeStep.key)");
    expect(retryFailed).toContain('stageState.operation === "revise"');
    expect(retryFailed).toContain("preservedFailedInstruction");
    expect(retryFailed).toContain("onRevise(activeStep.key, instruction)");
    expect(planView).toContain("readOnly={interactionLocked || !revisionAvailable || runActive}");
    expect(planView).toContain("disabled={!sendEnabled}");
    expect(planView).toContain("disabled={!nextEnabled}");
    expect(planView).toContain("disabled={!finishEnabled}");
    expect(planView).toContain("disabled={!undoEnabled}");
  });

  it("prioritizes runtime recovery for a failed Plan stage without duplicating alerts", async () => {
    const appSource = await readSource("./App.tsx");
    const planView = appSource.slice(appSource.indexOf("function PlanView("), appSource.indexOf("function CanvasView("));
    const runtimeRecovery = planView.slice(
      planView.indexOf("{runtimeStateError ? ("),
      planView.indexOf(") : stageState.status === \"failed\" ? ("),
    );

    expect(planView).toContain('{runtimeStateError ? (');
    expect(planView).toContain(') : stageState.status === "failed" ? (');
    expect(planView).not.toContain('runtimeStateError && stageState.status !== "failed"');
    expect(runtimeRecovery).toContain("{runtimeStateError}");
    expect(runtimeRecovery).toContain("onClick={() => void onRetryRuntimeState()}");
    expect(runtimeRecovery).toContain("Retry runtime state");
    expect(runtimeRecovery).not.toContain("disabled=");
  });

  it("resets the revision composer height only after a successful revision", async () => {
    const activeRevision = derivePlanRevisionTracking(null, {
      status: "revising",
      operation: "revise",
      runId: "revision-run",
      lastRunId: null,
    });
    expect(activeRevision).toEqual({ pendingRunId: "revision-run", terminalStatus: null });
    expect(derivePlanRevisionTracking(activeRevision.pendingRunId, {
      status: "ready",
      operation: "revise",
      runId: null,
      lastRunId: "revision-run",
    })).toEqual({ pendingRunId: null, terminalStatus: "ready" });
    expect(derivePlanRevisionTracking(activeRevision.pendingRunId, {
      status: "failed",
      operation: "revise",
      runId: null,
      lastRunId: "revision-run",
    })).toEqual({ pendingRunId: null, terminalStatus: "failed" });
    expect(derivePlanRevisionTracking(activeRevision.pendingRunId, {
      status: "ready",
      operation: "revise",
      runId: null,
      lastRunId: "another-run",
    })).toEqual({ pendingRunId: "revision-run", terminalStatus: null });

    const appSource = await readSource("./App.tsx");
    const planView = appSource.slice(appSource.indexOf("function PlanView("), appSource.indexOf("function CanvasView("));
    const revisionResultEffect = planView.slice(
      planView.indexOf("useEffect(() => {"),
      planView.indexOf("}, [stageState.lastRunId, stageState.operation, stageState.runId, stageState.status, submittedRevisionRunId]);"),
    );
    const successfulRevision = revisionResultEffect.slice(
      revisionResultEffect.indexOf('if (tracking.terminalStatus === "ready")'),
      revisionResultEffect.indexOf("setSubmittedRevisionRunId(tracking.pendingRunId)"),
    );

    expect(revisionResultEffect).toContain("derivePlanRevisionTracking(submittedRevisionRunId, stageState)");
    expect(successfulRevision).toContain('composerRef.current?.style.removeProperty("height")');
    expect(successfulRevision).toContain('setAgentInstruction("")');
    expect(successfulRevision).toContain('setPreservedFailedInstruction("")');
    expect(revisionResultEffect).not.toContain('if (tracking.terminalStatus === "failed") {\n      setAgentInstruction("")');
    expect(planView).not.toContain("catch {\n      setSubmittedRevisionRunId(null);");
  });

  it("PlanView document editor stays editable after clearing while running and blank completion stay closed", () => {
    let session: PlanSession = editablePlanSession();
    let blurCalls = 0;
    const renderEditor = () => PlanDocumentEditor({
      id: "plan-document",
      value: session.plan.tasks,
      status: session.stages.tasks.status,
      onChange: (value) => {
        session = editPlanStage(session, "tasks", value);
      },
      onBlur: () => { blurCalls += 1; },
    });

    const readyEditor = renderEditor();
    expect(readyEditor.props.readOnly).toBe(false);
    expect(readyEditor.props.className).toBe("plan-md-source");
    expect(readyEditor.props["aria-label"]).toBe("Plan source editor");
    expect(readyEditor.props.spellCheck).toBe(false);
    expect(readyEditor.props["aria-readonly"]).toBeUndefined();
    readyEditor.props.onBlur();
    expect(blurCalls).toBe(1);
    readyEditor.props.onChange({ currentTarget: { value: "   " } });
    expect(session.stages.tasks.status).toBe("pending");
    expect(canFinishPlan(acceptPlanStage(session, "tasks"))).toBe(false);

    const emptyEditor = renderEditor();
    expect(emptyEditor.props.readOnly).toBe(false);
    emptyEditor.props.onChange({ currentTarget: { value: "# Replacement tasks" } });
    expect(session.plan.tasks).toBe("# Replacement tasks");
    expect(session.stages.tasks.status).toBe("ready");

    const runningEditor = PlanDocumentEditor({
      id: "running-plan-document",
      value: session.plan.tasks,
      status: "revising",
      onChange: () => undefined,
    });
    expect(runningEditor.props.readOnly).toBe(true);
    expect(runningEditor.props["aria-readonly"]).toBe(true);

    const recoveryLockedEditor = PlanDocumentEditor({
      id: "recovery-locked-plan-document",
      value: session.plan.tasks,
      status: "ready",
      locked: true,
      onChange: () => undefined,
    });
    expect(recoveryLockedEditor.props.readOnly).toBe(true);
    expect(recoveryLockedEditor.props["aria-readonly"]).toBe(true);
  });

  it("dispatches every committed workspace to main immediately without waiting for an older request", () => {
    const createDispatcher = Reflect.get(AppModule, "createWorkspaceSaveDispatcher") as undefined | ((
      save: (workspace: unknown) => Promise<void>,
      currentWorkspace: () => unknown,
      onError: (message: string | null) => void,
    ) => { dispatch(workspace: unknown): void; retry(): void });
    expect(createDispatcher).toBeTypeOf("function");
    const attempts: unknown[] = [];
    let resolveFirst: (() => void) | undefined;
    const firstPending = new Promise<void>((resolve) => { resolveFirst = resolve; });
    const dispatcher = createDispatcher!(async (workspace) => {
      attempts.push(workspace);
      if (attempts.length === 1) await firstPending;
    }, () => ({ generation: 2 }), () => undefined);

    dispatcher.dispatch({ generation: 1 });
    dispatcher.dispatch({ generation: 2 });

    expect(attempts).toEqual([{ generation: 1 }, { generation: 2 }]);
    resolveFirst?.();
  });

  it("ignores an older save rejection after a newer request succeeds", async () => {
    const createDispatcher = Reflect.get(AppModule, "createWorkspaceSaveDispatcher") as undefined | ((
      save: (workspace: unknown) => Promise<void>,
      currentWorkspace: () => unknown,
      onError: (message: string | null) => void,
    ) => { dispatch(workspace: unknown): void; retry(): void });
    expect(createDispatcher).toBeTypeOf("function");
    let rejectFirst: ((error: Error) => void) | undefined;
    let resolveSecond: (() => void) | undefined;
    const first = new Promise<void>((_resolve, reject) => { rejectFirst = reject; });
    const second = new Promise<void>((resolve) => { resolveSecond = resolve; });
    const errors: Array<string | null> = [];
    const dispatcher = createDispatcher!(
      (workspace) => (Reflect.get(workspace as object, "generation") === 1 ? first : second),
      () => ({ generation: 2 }),
      (message) => { errors.push(message); },
    );

    dispatcher.dispatch({ generation: 1 });
    dispatcher.dispatch({ generation: 2 });
    resolveSecond?.();
    await Promise.resolve();
    rejectFirst?.(new Error("stale failure"));
    await Promise.resolve();

    expect(errors.at(-1)).toBeNull();
    expect(errors).not.toContain("Workspace save failed.");
  });

  it("surfaces only the latest rejection and retries the exact current workspace", async () => {
    const createDispatcher = Reflect.get(AppModule, "createWorkspaceSaveDispatcher") as undefined | ((
      save: (workspace: unknown) => Promise<void>,
      currentWorkspace: () => unknown,
      onError: (message: string | null) => void,
    ) => { dispatch(workspace: unknown): void; retry(): void });
    expect(createDispatcher).toBeTypeOf("function");
    const current = { generation: 3 };
    const attempts: unknown[] = [];
    const errors: Array<string | null> = [];
    const dispatcher = createDispatcher!(async (workspace) => {
      attempts.push(workspace);
      if (attempts.length === 1) throw new Error("latest failure");
    }, () => current, (message) => { errors.push(message); });

    dispatcher.dispatch({ generation: 2 });
    await Promise.resolve();
    await Promise.resolve();
    expect(errors.at(-1)).toBe("Workspace save failed.");

    dispatcher.retry();
    await Promise.resolve();
    expect(attempts).toEqual([{ generation: 2 }, current]);
    expect(attempts[1]).toBe(current);
    expect(errors.at(-1)).toBeNull();
  });

  it("keeps workspace load failures out of the save path and exposes bounded retries", async () => {
    const appSource = await readSource("./App.tsx");

    expect(appSource).toContain("setWorkspaceLoadError");
    expect(appSource).toContain("Retry workspace load");
    expect(appSource).toContain("Retry workspace save");
    expect(appSource).toMatch(/loadWorkspaceState\(\)[\s\S]*?\.catch\(/);
    expect(appSource).toContain("useLayoutEffect");
    expect(appSource).not.toContain("createLatestWorkspaceSaveController");
    expect(appSource).not.toMatch(/workspaceSaveControllerRef|\.drain\(\)/);
  });

  it("routes user Undo through the durable Plan mutation queue", async () => {
    const appSource = await readSource("./App.tsx");
    expect(appSource).toContain("planMutationQueue().undoStage");
    expect(appSource).not.toContain("undoPlanStage(activeSession");
  });

  it("wires Plan sessions to typed streamed desktop events and automatic Requirements generation", async () => {
    const appSource = await readSource("./App.tsx");
    const autoStartEffect = appSource.slice(
      appSource.indexOf("const requestKey = `${activePlanScope}:requirements:generate`;"),
      appSource.indexOf("}, [activeProject?.id, activeSession, planRuntimeRecovery]);"),
    );
    expect(appSource).toContain("window.devflow.onPlanEvent");
    expect(appSource).toContain('requirements.status !== "pending"');
    expect(autoStartEffect).toContain("isEligible: () => {");
    expect(autoStartEffect.match(/workspaceRef\.current/g)).toHaveLength(2);
    expect(autoStartEffect).toContain("current.activeProjectId !== projectId");
    expect(autoStartEffect).toContain("current.activeSessionId !== planSessionId");
    expect(autoStartEffect).toContain('currentSession?.kind === "plan"');
    expect(autoStartEffect).toContain('currentSession.stages.requirements.status === "pending"');
    expect(autoStartEffect).toContain("currentSession.stages.requirements.runId === null");
    expect(autoStartEffect).toContain('runPlanGeneration(activeProject, currentSession, "requirements")');
    expect(autoStartEffect).not.toContain('runPlanGeneration(activeProject, activeSession, "requirements")');
    expect(appSource).toContain("applyPlanEventToWorkspace");
    expect(appSource).toContain("createPlanAdapter(window.devflow");
    expect(appSource).toContain("reconcilePlanRuntimeState");
    expect(appSource).toContain("canStartPlanRequest(planRuntimeRecovery, activeSession.id)");
    expect(appSource).toContain("loadPlanRuntimeState(planAdapter(), planSessionId, project.rootPath)");
    expect(appSource).toContain("bindAndRecoverPlanStart(project, result)");
    expect(appSource).toContain("Retry runtime state");
    expect(appSource).toContain("!canFinishPlan(accepted)");
    expect(appSource).toContain("capturePlanFinishBoundary(accepted)");
    const finishPlanBlock = appSource.slice(
      appSource.indexOf("async function finishPlan(session: PlanSession)"),
      appSource.indexOf("function updateCanvasSession("),
    );
    expect(finishPlanBlock).not.toContain("registerBackendStartedCanvasRuns");
    expect(finishPlanBlock).not.toContain("startedBridgeRuns");
    expect(appSource).toContain("installFinishedPlanCanvas(current, boundary, canvas)");
  });

  it("loads agent health through desktop IPC and stores discovered agents", async () => {
    const appSource = await readSource("./App.tsx");
    const healthEffect = appSource.slice(
      appSource.indexOf("window.devflow.getAgentHealth"),
      appSource.indexOf("window.devflow.onRunEvent"),
    );

    expect(healthEffect).toContain("window.devflow.getAgentHealth()");
    expect(healthEffect).toContain("agents: result.agents");
    expect(healthEffect).toContain("setAgentReadiness");
    expect(healthEffect).not.toContain("window.devflow.discoverAgents()");
  });

  it("never starts workflow executor runs from the desktop renderer", async () => {
    const appSource = await readSource("./App.tsx");

    expect(appSource).not.toContain("startedBridgeRuns");
    expect(appSource).not.toContain("startBridgeRun(activeProject, activeSession, node)");
    expect(appSource).not.toContain("applyBridgeRunResult(current, result)");
    expect(appSource).not.toContain("registerBackendStartedCanvasRuns");
  });

  it("does not apply the legacy renderer retry policy to an authoritative desktop session", () => {
    const retryNodeForRuntime = Reflect.get(AppModule, "retryCanvasNodeForRuntime") as undefined | ((
      session: CanvasSession,
      nodeId: string,
      now: string,
      desktopBackendAvailable: boolean,
    ) => CanvasSession);
    expect(retryNodeForRuntime).toBeTypeOf("function");
    if (!retryNodeForRuntime) return;
    const node = {
      ...mockNode("codex"),
      status: "failed" as const,
      runId: "authoritative-run",
      progress: "Authoritative failure",
      output: ["Authoritative output"],
    };
    const session = { ...canvasSessionForTest("session-retry"), nodes: [node] };

    const next = retryNodeForRuntime(session, node.id, "2026-07-23T08:00:00.000Z", true);

    expect(next).toBe(session);
    expect(next.nodes[0]).toMatchObject({
      status: "failed",
      runId: "authoritative-run",
      progress: "Authoritative failure",
      output: ["Authoritative output"],
    });
  });

  it("disables Node Modal Retry with an explicit accessible desktop-backend reason", async () => {
    const appSource = await readSource("./App.tsx");
    const retryHandler = appSource.slice(appSource.indexOf("function retryNode("), appSource.indexOf("function answerUserDecision("));
    const nodeModal = appSource.slice(appSource.indexOf("function NodeModal("), appSource.indexOf("function OutputTab("));

    expect(retryHandler).toContain("if (window.devflow) return;");
    expect(appSource).toContain("retryUnavailableReason={window.devflow ? DESKTOP_RETRY_UNAVAILABLE_REASON : null}");
    expect(nodeModal).toContain("disabled={!canExecute || retryUnavailableReason !== null}");
    expect(nodeModal).toContain("title={retryUnavailableReason ?? undefined}");
    expect(nodeModal).toContain("aria-describedby={retryUnavailableReason ? retryUnavailableReasonId : undefined}");
    expect(nodeModal).toContain('className="sr-only"');
    expect(appSource).toContain("Use checkpoint-driven Repair in the bottom composer when available.");
  });

  it("keeps workflow broadcasts authoritative and removes renderer terminal persistence", async () => {
    const appSource = await readSource("./App.tsx");
    const runEventEffect = appSource.slice(
      appSource.indexOf("window.devflow.onRunEvent"),
      appSource.indexOf("window.devflow.onWorkflowEvent"),
    );
    const workflowEventEffect = appSource.slice(
      appSource.indexOf("window.devflow.onWorkflowEvent"),
      appSource.indexOf("window.devflow.onPlanEvent"),
    );

    expect(runEventEffect).not.toMatch(
      /claimCompletedBridgeRunPersistence|persistCompletedBridgeRunResult|applyCompletedBridgeRunPersistenceResult/,
    );
    expect(appSource).not.toMatch(
      /claimCompletedBridgeRunPersistence|persistCompletedBridgeRunResult|applyCompletedBridgeRunPersistenceResult/,
    );
    expect(workflowEventEffect).toContain("applyAuthoritativeWorkflowBroadcast");
    expect(workflowEventEffect).toContain("advanceWorkflowGeneration(workflowProjectionGenerationRef.current");
    expect(workflowEventEffect).toContain("projectId: envelope.canvasSession.projectId");
    expect(workflowEventEffect).toContain("canonicalRoot: envelope.projectRoot");
    expect(workflowEventEffect).toContain("sessionId: envelope.sessionId");
  });

  it("keeps canonical next actions isolated by project and session", () => {
    const first: WorkflowLoopNextAction = {
      kind: "execute_lane",
      reason: "Run first.",
      laneId: "lane-first",
    };
    const second: WorkflowLoopNextAction = {
      kind: "blocked",
      reason: "Second is blocked.",
    };
    let actions: ReadonlyMap<string, WorkflowLoopNextAction> = new Map();
    actions = upsertWorkflowNextAction(actions, "project-1", "session-1", first);
    actions = upsertWorkflowNextAction(actions, "project-1", "session-2", second);

    expect(workflowNextActionForScope(actions, "project-1", "session-1")).toBe(first);
    expect(workflowNextActionForScope(actions, "project-1", "session-2")).toBe(second);
    expect(workflowNextActionForScope(actions, "project-2", "session-1")).toBeNull();
    expect(workflowNextActionForScope(actions, null, "session-1")).toBeNull();
  });

  it("keeps the next safe action hint compact and navigation-only", async () => {
    const appSource = await readSource("./App.tsx");
    const styles = await readSource("./styles.css");
    const navigationStart = appSource.indexOf("nextActionHint={nextAction ?");
    const navigationEnd = appSource.indexOf("onComposerChange=", navigationStart);
    const navigation = appSource.slice(navigationStart, navigationEnd);

    expect(navigationStart).toBeGreaterThan(-1);
    expect(navigation).toContain("setSelectedNodeId");
    expect(navigation).toContain("setModalTab");
    for (const mutation of [
      "pushDeliveryBranch",
      "mergePullRequest",
      "applyRollback",
      "requestRepair",
      "requestVariant",
    ]) {
      expect(navigation).not.toContain(mutation);
    }
    expect(appSource).toContain("Next safe action ·");
    expect(styles).toContain(".next-action-hint");
    expect(styles).not.toContain("var(--color-");
  });

  it("renders compact agent readiness near canvas composer but not on start page", async () => {
    const appSource = await readSource("./App.tsx");
    const projectStart = appSource.slice(appSource.indexOf("function ProjectStartPage"), appSource.indexOf("function AgentReadinessBlock"));
    const canvasView = appSource.slice(appSource.indexOf("function CanvasView("), appSource.indexOf("function CanvasViewportController"));

    expect(projectStart).not.toContain("<AgentReadinessBlock");
    expect(projectStart).not.toContain("agentReadiness");
    expect(canvasView).toContain("<AgentReadinessBlock");
    expect(canvasView).toContain("readiness={agentReadiness}");
    expect(appSource).toContain("function AgentReadinessBlock");
    expect(appSource).toContain("Antigravity CLI");
    expect(appSource).toContain("optional detected-only design agent");
    expect(appSource).toContain("Real loop ready");
    expect(appSource).toContain("Mock fallback only");
  });

  it("does not parse agent prose for changed-file truth in ChangesTab", async () => {
    const appSource = await readSource("./App.tsx");
    const changesTab = appSource.slice(appSource.indexOf("function ChangesTab"), appSource.indexOf("export function changeReviewSummary"));
    expect(changesTab).not.toContain("node.output");
    expect(changesTab).not.toContain("node.progress");
    expect(changesTab).toContain("reconcileFinalChangeset");
  });

  it("falls back to legacy changesets only when final reconciliation is unavailable", async () => {
    const appSource = await readSource("./App.tsx");
    const changesTab = appSource.slice(appSource.indexOf("function ChangesTab"), appSource.indexOf("export function changeReviewSummary"));
    expect(changesTab).toContain('typeof devflow.reconcileFinalChangeset === "function"');
    expect(changesTab).toContain('typeof devflow.getChangeset === "function"');
    expect(changesTab.indexOf("devflow.reconcileFinalChangeset")).toBeLessThan(changesTab.indexOf("devflow.getChangeset"));
  });

  it("implements answerUserDecision with write-through to desktop and browser fallback", async () => {
    const appSource = await readSource("./App.tsx");
    const fnBody = appSource.slice(appSource.indexOf("function answerUserDecision"), appSource.indexOf("function reassignNode"));

    expect(fnBody).toContain("window.devflow.workflow.answerUserDecision(");
    expect(fnBody).toContain("sessionId: activeSession.id");
    expect(fnBody).toContain("decisionId: nodeId");
    expect(fnBody).toContain("selectedOption");
    expect(fnBody).toContain("action");

    expect(fnBody).toContain("captureWorkflowSessionResponseGuard(activeProject, activeSession.id, activeSession)");
    expect(fnBody).toContain("answerUserDecision(responseGuard.queryRoot");
    expect(fnBody).toContain("applyGuardedWorkflowSessionResponse(result, responseGuard)");

    const devflowCheck = fnBody.indexOf("if (window.devflow");
    const fallbackUpdate = fnBody.indexOf("updateCanvasSession(activeSession.id");
    expect(fallbackUpdate).toBeGreaterThan(devflowCheck);
    expect(fnBody.slice(devflowCheck, fallbackUpdate)).toContain("return;");
  });

  it("renders a durable danger-full-access authorization in the existing decision surface", () => {
    const node = mockNode();
    node.nodeKind = "user_decision";
    node.executable = false;
    node.userDecision = {
      decisionId: "decision-danger-run",
      prompt: "Authorize full host access for Commit verified changes?",
      options: ["Authorize this run"],
      reason: "This run can modify host state outside the project.",
      status: "waiting_input",
      targetLaneId: "lane-commit",
      targetSegmentId: "segment-session-1-lane-commit",
      runAuthorization: {
        sandbox: "danger-full-access",
        runId: "run-session-1-lane-commit",
        startFingerprint: "a".repeat(64),
      },
    } as CanvasNode["userDecision"];

    const html = renderToStaticMarkup(createElement(UserDecisionPanel, {
      node,
      onDecisionAnswer: vi.fn(),
    }));

    expect(html).toContain("Authorize full host access for Commit verified changes?");
    expect(html).toContain("This run can modify host state outside the project.");
    expect(html).toContain("Authorize this run");
  });

  it("implements reassignNode with desktop write-through and authoritative session replacement", async () => {
    const appSource = await readSource("./App.tsx");
    const fnBody = appSource.slice(appSource.indexOf("function reassignNode"), appSource.indexOf("function insertBefore"));

    expect(fnBody).toContain("window.devflow.workflow.reassignLane(");
    expect(fnBody).toContain("const requestId = crypto.randomUUID()");
    expect(fnBody).toContain("requestId,");
    expect(fnBody).toContain("sessionId: activeSession.id");
    expect(fnBody).toContain("laneId: nodeId");
    expect(fnBody).toContain("agentKind: nextAgent");
    expect(fnBody).toContain("captureWorkflowSessionResponseGuard(activeProject, activeSession.id, activeSession)");
    expect(fnBody).toContain("reassignLane(responseGuard.queryRoot");
    expect(fnBody).toContain("applyGuardedWorkflowSessionResponse(result, responseGuard)");

    expect(fnBody).toContain('setNodeActionError("Workflow backend unavailable.")');
    expect(fnBody).toContain(".catch((error)");
    expect(fnBody).not.toContain("updateNode(nodeId");
    expect(fnBody).not.toContain("Task reassigned to");
  });

  it("ChangesTab calls createDeliveryCommit without renderer shell imports", async () => {
    const appSource = await readSource("./App.tsx");
    const handleCommit = appSource.slice(appSource.indexOf("async function handleCommit()"), appSource.indexOf("if (!changeset) return <p>Loading changes...</p>;"));
    expect(handleCommit).toContain("window.devflow");
    expect(handleCommit).toContain("devflow.workflow.createDeliveryCommit");
    expect(appSource).not.toContain("import fs from ");
    expect(appSource).not.toContain("import child_process");
  });

  it("ChangesTab commit action is gated on laneKind and evidence", async () => {
    const appSource = await readSource("./App.tsx");
    const changesTab = appSource.slice(appSource.indexOf("function ChangesTab("), appSource.indexOf("export function changeReviewSummary("));
    expect(changesTab).toContain("node.laneKind === \"commit\"");
    expect(changesTab).toContain("hasFinalGitEvidence");
  });

  it("ChangesTab requires explicit mismatch confirmation when reconciliation status is mismatch", async () => {
    const appSource = await readSource("./App.tsx");
    const changesTab = appSource.slice(appSource.indexOf("function ChangesTab("), appSource.indexOf("export function changeReviewSummary("));
    expect(changesTab).toContain('reconciliation?.status === "mismatch"');
    expect(changesTab).toContain("acceptMismatch");
  });

  it("ChangesTab sends explicit mismatch acceptance only after mismatch confirmation", async () => {
    const appSource = await readSource("./App.tsx");
    const handleCommit = appSource.slice(appSource.indexOf("async function handleCommit()"), appSource.indexOf("if (!changeset) return <p>Loading changes...</p>;"));
    const commitIndex = handleCommit.indexOf("devflow.workflow.createDeliveryCommit");
    const acceptIndex = handleCommit.indexOf("acceptMismatch: true");

    expect(handleCommit).not.toContain("window.confirm");
    expect(handleCommit).toContain("mismatchRequiresAcceptance && !acceptMismatch");
    expect(acceptIndex).toBeGreaterThan(commitIndex);
  });

  it("ChangesTab requires explicit form subject and checks devflow availability", async () => {
    const appSource = await readSource("./App.tsx");
    const changesTab = appSource.slice(appSource.indexOf("function ChangesTab("), appSource.indexOf("export function changeReviewSummary("));
    expect(changesTab).toContain("commitSubject");
    expect(changesTab).not.toContain("window.prompt");
    expect(changesTab).toContain("if (!devflow?.workflow?.createDeliveryCommit)");
  });

  it("ChangesTab handleCreatePr verifies PR lane dependency and conventional commit title", async () => {
    const appSource = await readSource("./App.tsx");
    const changesTab = appSource.slice(appSource.indexOf("function ChangesTab("), appSource.indexOf("export function changeReviewSummary("));
    expect(changesTab).toContain("session.edges");
    expect(changesTab).toContain('=== "pull_request"');
    expect(changesTab).toContain("Cannot create PR: No dependent pull_request lane found.");
    expect(changesTab).toContain("Conventional Commits format");
    expect(changesTab).toContain("^(feat|fix|docs|style|refactor|perf|test|build|ci|chore|revert)");
  });

  it("ChangesTab handleCreatePr derives baseBranch properly and prevents fallback to main", async () => {
    const appSource = await readSource("./App.tsx");
    const changesTab = appSource.slice(appSource.indexOf("function ChangesTab("), appSource.indexOf("export function changeReviewSummary("));

    const prBaseBranchDef = changesTab.slice(changesTab.indexOf("const prBaseBranch ="), changesTab.indexOf(";", changesTab.indexOf("const prBaseBranch =")));
    expect(prBaseBranchDef).toMatch(/const prBaseBranch = node\.worktree\.baseRef \|\| session\.target\.baseRef/);
    expect(prBaseBranchDef).not.toContain("node.worktree.baselineRef");
    expect(prBaseBranchDef).not.toContain("selectedBranch");
    expect(prBaseBranchDef).not.toContain('"main"');

    const handleCreatePr = changesTab.slice(changesTab.indexOf("async function handleCreatePr()"), changesTab.indexOf("if (!changeset) return <p>Loading changes...</p>;"));
    expect(handleCreatePr).not.toContain("node.worktree.baselineRef");
    expect(handleCreatePr).not.toContain("selectedBranch");
    expect(handleCreatePr).not.toContain('"main"');
    expect(handleCreatePr).toContain("Cannot create PR: Base branch could not be derived.");
  });

  it("ChangesTab handleCreatePr verifies base branch is not the same as the delivery branch", async () => {
    const appSource = await readSource("./App.tsx");
    const changesTab = appSource.slice(appSource.indexOf("function ChangesTab("), appSource.indexOf("export function changeReviewSummary("));
    expect(changesTab).toContain("!commitEvidence?.branch");
    expect(changesTab).toContain("prBaseBranch === commitEvidence.branch");
    expect(changesTab).toContain("Base branch cannot be the same as the delivery branch");
  });

  it("DeliveryLifecyclePanel disables Create PR after a pull request exists", async () => {
    const appSource = await readSource("./App.tsx");
    const panel = appSource.slice(appSource.indexOf("function DeliveryLifecyclePanel("), appSource.indexOf("function shortSha("));
    const createPrDisabled = panel.slice(panel.indexOf("const createPrDisabled ="), panel.indexOf("const mergeRequestDisabled"));
    expect(createPrDisabled).toContain("!!pullRequest");
    expect(panel).toContain('disabled={createPrDisabled}');
  });

  it("DeliveryLifecyclePanel renders the explicit delivery gate checklist", async () => {
    const appSource = await readSource("./App.tsx");
    const panel = appSource.slice(appSource.indexOf("function DeliveryLifecyclePanel("), appSource.indexOf("function shortSha("));
    expect(panel).toContain('aria-label="Delivery gate checklist"');
    expect(panel).toContain("state.gateList.map");
    expect(panel).toContain("deliveryGateStatusLabel");
  });

  it("DeliveryLifecyclePanel exposes exact renderer-owned session, lane, and SHA identity without changing visible facts", async () => {
    const appSource = await readSource("./App.tsx");
    const changesTab = appSource.slice(appSource.indexOf("function ChangesTab("), appSource.indexOf("function DeliveryLifecyclePanel("));
    const panel = appSource.slice(appSource.indexOf("function DeliveryLifecyclePanel("), appSource.indexOf("function shortSha("));

    expect(changesTab).toContain("sessionId={session.id}");
    expect(changesTab).toContain("commitLaneId={node.id}");
    expect(changesTab).toContain("pullRequestLaneId={dependentPrLaneId}");
    expect(panel).toContain("data-delivery-session-id={sessionId}");
    expect(panel).toContain("data-delivery-commit-lane-id={commitLaneId}");
    expect(panel).toContain("data-delivery-pull-request-lane-id={pullRequestLaneId}");
    expect(panel).toContain("data-delivery-commit-sha={commitEvidence?.commitSha}");
    expect(panel).toContain("data-delivery-pull-request-head-sha={pullRequest?.headSha}");
    expect(panel).toContain("data-delivery-checks-expected-head-sha={prChecks?.expectedHeadSha}");
  });

  it("ChangesTab clears stale PR checks when PR status refresh starts or fails", async () => {
    const appSource = await readSource("./App.tsx");
    const handleCheckPrStatus = appSource.slice(appSource.indexOf("async function handleCheckPrStatus()"), appSource.indexOf("async function handleMergePullRequest()"));
    const checkingIndex = handleCheckPrStatus.indexOf('setPrCheckStatus("checking");');
    const clearBeforeTryIndex = handleCheckPrStatus.indexOf("setPrChecks(null);");
    const tryIndex = handleCheckPrStatus.indexOf("try {");
    const catchIndex = handleCheckPrStatus.indexOf("catch (e)");
    const clearInCatchIndex = handleCheckPrStatus.indexOf("setPrChecks(null);", catchIndex);

    expect(clearBeforeTryIndex).toBeGreaterThan(checkingIndex);
    expect(clearBeforeTryIndex).toBeLessThan(tryIndex);
    expect(clearInCatchIndex).toBeGreaterThan(catchIndex);
  });

  it("ChangesTab handleCreatePr trims and revalidates prompt base branch", async () => {
    const appSource = await readSource("./App.tsx");
    const changesTab = appSource.slice(appSource.indexOf("function ChangesTab("), appSource.indexOf("export function changeReviewSummary("));
    expect(changesTab).toContain("trimmedBaseBranch");
    expect(changesTab).toContain("baseBranch: trimmedBaseBranch,");
  });

  it("ChangesTab early-return does not hide toolbar when commitEvidence exists", async () => {
    const appSource = await readSource("./App.tsx");
    const changesTab = appSource.slice(appSource.indexOf("function ChangesTab("), appSource.indexOf("export function changeReviewSummary("));
    expect(changesTab).toContain("if (!hasGitEvidence && !reconciliation?.liveChanges && !commitEvidence) {");
  });

  it("ChangesTab hydrates commitEvidence from persisted workflow events without requiring evidence payload", async () => {
    const appSource = await readSource("./App.tsx");
    const changesTab = appSource.slice(appSource.indexOf("function ChangesTab("), appSource.indexOf("export function changeReviewSummary("));
    expect(changesTab).toContain("window.devflow.workflow.getEvents(");
    expect(changesTab).toContain("hydrateDeliveryLifecycleFromWorkflowEvents(eventsList");
    expect(changesTab).toContain("commitLaneId: node.id");
    expect(changesTab).toContain("pullRequestLaneId: dependentPrLaneId");
    expect(changesTab).toContain("setCommitEvidence(restored.commitEvidence)");
    expect(changesTab).not.toContain('typeof evidence.commitSha === "string"');
  });

  it("ChangesTab hydrates delivery lifecycle state from workflow events", async () => {
    const appSource = await readSource("./App.tsx");
    const changesTab = appSource.slice(appSource.indexOf("function ChangesTab("), appSource.indexOf("export function changeReviewSummary("));
    expect(changesTab).toContain("hydrateDeliveryLifecycleFromWorkflowEvents");
    expect(changesTab).toContain("setPushEvidence(restored.pushEvidence)");
    expect(changesTab).toContain("setPrEvidence(restored.pullRequest)");
    expect(changesTab).toContain("setPrChecks(restored.checks)");
    expect(changesTab).toContain('setMergeStatus(restored.mergeComplete ? "merged" : "idle")');
    expect(changesTab).toContain('setSyncStatus(restored.syncComplete ? "synced" : "idle")');
  });

  it("ChangesTab Push call does not require renderer-visible commitSha/branch/worktreePath", async () => {
    const appSource = await readSource("./App.tsx");
    const changesTab = appSource.slice(appSource.indexOf("function ChangesTab("), appSource.indexOf("export function changeReviewSummary("));
    expect(changesTab).toContain("sessionId: session.id,");
    expect(changesTab).toContain("laneId: node.id,");
  });

  it("ChangesTab resets delivery state on node/session/project identity change", async () => {
    const appSource = await readSource("./App.tsx");
    const changesTab = appSource.slice(appSource.indexOf("function ChangesTab("), appSource.indexOf("export function changeReviewSummary("));
    expect(changesTab).toContain('setCommitEvidence(null);');
    expect(changesTab).toContain('setPushEvidence(null);');
    expect(changesTab).toContain('setPushStatus("idle");');
    expect(changesTab).toContain('setPrStatus("idle");');
    expect(changesTab).toContain('setPrEvidence(null);');
    expect(changesTab).toContain('setPrChecks(null);');
    expect(changesTab).toContain('setMergeStatus("idle");');
    expect(changesTab).toContain('setSyncStatus("idle");');
    expect(changesTab).toContain('setCleanupStatus("idle");');
    expect(changesTab).toContain('setDeliveryStatus("idle");');
    expect(changesTab).toMatch(/useEffect\(\(\) => \{[\s\S]*setCommitEvidence\(null\);[\s\S]*\}, \[node\.id, session\.id, projectRoot, prBaseBranch\]\);/);
  });

  it("ChangesTab clears restored delivery state if getEvents is unavailable", async () => {
    const appSource = await readSource("./App.tsx");
    const changesTab = appSource.slice(appSource.indexOf("function ChangesTab("), appSource.indexOf("export function changeReviewSummary("));
    const unavailableBranch = changesTab.slice(
      changesTab.indexOf("if (!window.devflow?.workflow?.getEvents)"),
      changesTab.indexOf("let active = true;"),
    );
    expect(unavailableBranch).toContain("setCommitEvidence(null);");
    expect(unavailableBranch).toContain("setPushEvidence(null);");
    expect(unavailableBranch).toContain('setPushStatus("idle");');
    expect(unavailableBranch).toContain("setPrEvidence(null);");
    expect(unavailableBranch).toContain("setPrChecks(null);");
    expect(unavailableBranch).toContain('setMergeStatus("idle");');
    expect(unavailableBranch).toContain('setSyncStatus("idle");');
    expect(unavailableBranch).toContain("return;");
  });

  it("WorktreeActions adopt is disabled and shows error when metadata is missing", async () => {
    const appSource = await readSource("./App.tsx");
    const worktreeActions = appSource.slice(appSource.indexOf("function WorktreeActions"));
    expect(worktreeActions).toContain("const missingMetadata =");
    expect(worktreeActions).toContain("!node.worktree.worktreeId");
    expect(worktreeActions).toContain("const comparisonMatchesNode =");
    expect(worktreeActions).toContain("const canAdopt = devflowAvailable && !missingMetadata && comparisonMatchesNode;");
    expect(worktreeActions).toContain("disabled={!canAdopt || adopting || !adoptConfirmed}");
    expect(worktreeActions).toContain("Missing required metadata for adoption.");
    expect(worktreeActions).toContain("Compare this worktree with another current variant before adoption.");
  });

  it("WorktreeActions adopt does not fallback to HEAD and main", async () => {
    const appSource = await readSource("./App.tsx");
    const worktreeActions = appSource.slice(appSource.indexOf("function WorktreeActions"));
    expect(worktreeActions).not.toContain("|| \"HEAD\"");
    expect(worktreeActions).not.toContain("|| \"main\"");
  });

  it("WorktreeActions uses stable adoptionId, not Date.now()", async () => {
    const appSource = await readSource("./App.tsx");
    const worktreeActions = appSource.slice(appSource.indexOf("function WorktreeActions"));
    expect(worktreeActions).not.toContain("Date.now()");
    expect(worktreeActions).toContain("const comparisonToken = compareResult.comparisonId.replace(/[^A-Za-z0-9._-]/g, \"-\").slice(0, 224)");
    expect(worktreeActions).toContain("comparisonId: compareResult.comparisonId");
    expect(worktreeActions).toContain("adoptionId: `adopt-${node.worktree.worktreeId}-${node.worktree.headCommit}-${comparisonToken}`");
  });

  it("WorktreeActions adopt stays merge strategy without cherry-pick UI", async () => {
    const appSource = await readSource("./App.tsx");
    const worktreeActions = appSource.slice(appSource.indexOf("function WorktreeActions"));
    expect(worktreeActions).toContain('strategy: "merge"');
    expect(worktreeActions.toLowerCase()).not.toContain("cherry");
  });

  it("WorktreeActions requires real managed worktree to show lifecycle", async () => {
    const appSource = await readSource("./App.tsx");
    const worktreeActions = appSource.slice(appSource.indexOf("function WorktreeActions"));
    expect(worktreeActions).toContain("const isNewWorktree = node.worktree.executionTarget === \"new_worktree\" && !!node.worktree.worktreeId;");
  });

  it("WorktreeActions cleanWorktree constructs complete identity payload with parentLaneId", async () => {
    const appSource = await readSource("./App.tsx");
    const handleClean = appSource.slice(appSource.indexOf("const handleClean = async () => {"), appSource.indexOf("setCleanStatus(\"Worktree cleaned successfully.\");"));

    expect(handleClean).toContain("parentLaneId: node.id");
    expect(handleClean).toContain("worktreeId: node.worktree.worktreeId");
    expect(handleClean).toContain("variantId: node.worktree.variantId");
    expect(handleClean).toContain("realPath: node.worktree.realPath");
    expect(handleClean).toContain("gitdir: node.worktree.gitdir");
    expect(handleClean).toContain("repoRoot: node.worktree.repoRoot");
    expect(handleClean).toContain("branchName: node.worktree.branchName");
    expect(handleClean).toContain("baseCommit: node.worktree.baseCommit");
    expect(handleClean).toContain("headCommit: node.worktree.headCommit");
  });

  it("WorktreeActions disables clean unless all identity fields exist", async () => {
    const appSource = await readSource("./App.tsx");
    const worktreeActions = appSource.slice(appSource.indexOf("function WorktreeActions"));
    expect(worktreeActions).toContain("const missingCleanMetadata =");
    expect(worktreeActions).toContain("!node.worktree.realPath");
    expect(worktreeActions).toContain("!node.worktree.gitdir");
    expect(worktreeActions).toContain("!node.worktree.repoRoot");
    expect(worktreeActions).toContain("const canClean = devflowAvailable && !missingCleanMetadata;");
    expect(worktreeActions).toContain("disabled={!canClean || cleaning || !cleanConfirmed || (deleteBranch && !deleteBranchConfirmed)}");
  });

  it("WorktreeActions Clean handles deleteBranch correctly", async () => {
    const appSource = await readSource("./App.tsx");
    const worktreeActions = appSource.slice(appSource.indexOf("function WorktreeActions"));

    expect(worktreeActions).toContain("deleteBranch");
    expect(worktreeActions).toContain("deleteBranchConfirmed");
    expect(worktreeActions).not.toContain("window.confirm");
  });

  it("formats worktree comparison evidence without rendering raw JSON", async () => {
    const comparison: VariantComparisonEvidence = {
      comparisonId: "comparison-a-b",
      collectedAt: "2026-06-22T07:20:00.000Z",
      variants: [
        {
          variantId: "variant-a",
          worktreeId: "wt-a",
          changeset: {
            evidenceId: "changeset-evidence-wt-a",
            changesetId: "changeset-wt-a",
            source: "git",
            status: "available",
            files: ["src/a.ts", "src/b.ts"],
            diffStat: { added: 12, changed: 2, deleted: 3 },
            patchPreviewTruncated: false,
          },
          metrics: [
            { kind: "test", label: "Tests", status: "passed", source: "recorded", detail: "vitest --run" },
            { kind: "build", label: "Build", status: "failed", source: "recorded", detail: "tsc failed" },
            { kind: "diff-summary", label: "Diff summary", status: "recorded", source: "recorded", detail: "+12 / -3 across 2 files" },
            { kind: "conflict-check", label: "Conflict check", status: "passed", source: "recorded", detail: "No conflicts detected." },
          ],
        },
      ],
    };
    const summary = summarizeWorktreeComparisonEvidence(comparison);

    expect(summary.variants).toEqual([
      expect.objectContaining({
        variantId: "variant-a",
        worktreeId: "wt-a",
        changedFileCount: "2",
        diffSummary: "+12 / -3 across 2 files",
        conflictStatus: "passed",
        checks: [
          { label: "Tests", status: "passed", detail: "vitest --run" },
          { label: "Build", status: "failed", detail: "tsc failed" },
        ],
      }),
    ]);

    const appSource = await readSource("./App.tsx");
    const worktreeActions = appSource.slice(appSource.indexOf("function WorktreeActions"));
    expect(worktreeActions).not.toContain("JSON.stringify(compareResult");
    expect(worktreeActions).toContain("worktree-comparison-grid");
  });

  it("formats only the typed comparison value validated by preload", async () => {
    const appSource = await readSource("./App.tsx");
    const formatter = appSource.slice(
      appSource.indexOf("export function summarizeWorktreeComparisonEvidence"),
      appSource.indexOf("export function buildWorktreeAdoptionConfirmation"),
    );

    expect(formatter).not.toMatch(/asRecord|textValue|stringArray|as \(value: unknown\)/);
  });

  it("builds explicit merge-only adoption confirmation copy", () => {
    const message = buildWorktreeAdoptionConfirmation({
      targetBranchName: "main",
      worktreeBranchName: "skyturn/session-1",
      baseCommit: "abc123",
      headCommit: "def456",
    });

    expect(message).toContain("Target branch: main");
    expect(message).toContain("Worktree branch: skyturn/session-1");
    expect(message).toContain("Base commit: abc123");
    expect(message).toContain("Head commit: def456");
    expect(message).toContain("Strategy: merge");
    expect(message).not.toContain("cherry-pick");
  });

  it("builds clean confirmation copy with delete branch defaulting to false", () => {
    const cleanMessage = buildWorktreeCleanConfirmation({
      path: "/repo.worktrees/wt-a",
      branchName: "skyturn/session-1",
    });
    const deleteBranchMessage = buildWorktreeDeleteBranchConfirmation("skyturn/session-1");

    expect(cleanMessage).toContain("Path to remove: /repo.worktrees/wt-a");
    expect(cleanMessage).toContain("Branch name: skyturn/session-1");
    expect(cleanMessage).toContain("Delete branch requested: false");
    expect(deleteBranchMessage).toContain("Second confirmation");
    expect(deleteBranchMessage).toContain("Delete branch: skyturn/session-1");
  });

});

describe("authoritative terminal RunEvidence hydration", () => {
  it("installs exact terminal private evidence through the alias root and changes only runEvidence", async () => {
    const applyResponse = applyWorkflowResponseForTest();
    const prepare = prepareEvidenceHydrationForTest();
    const createHydrator = createEvidenceHydratorForTest();
    const requested = terminalCanvasSessionForTest(
      "session-terminal",
      "project-1",
      "node-terminal",
      "run-terminal",
      "completed",
    );
    const authoritative = {
      ...requested,
      nodes: requested.nodes.map((node) => ({ ...node, progress: "Authoritative completion" })),
    };
    const project = workflowProjectForTest(
      "project-1",
      "/opened/project-1-alias",
      "/canonical/project-1",
    );
    const previous = workflowWorkspaceForTest([project], [requested]);
    previous.runEvidence["run-terminal"] = mockRunEvidence({
      runId: "run-terminal",
      status: "failed",
      exitCode: 1,
    });
    previous.runEvidence["run-unrelated"] = mockRunEvidence({ runId: "run-unrelated" });
    const guard = workflowGuardForTest(requested, { sessionId: requested.id });
    const accepted = applyResponse(
      previous,
      workflowEnvelopeForTest(authoritative),
      guard,
      guard.generation,
    );
    const scope = evidenceHydrationScopeForTest(authoritative, {
      queryRoot: guard.queryRoot,
      canonicalRoot: guard.canonicalRoot,
      generation: guard.generation,
    });
    const prepared = prepare(previous, accepted, authoritative, scope);
    const evidence = mockRunEvidence({ runId: "run-terminal", status: "succeeded" });
    const loadEvidence = vi.fn(async () => evidence);
    let current = prepared.workspace;
    const beforeHydration = current;
    const hydrator = createHydrator({
      getWorkspace: () => current,
      getGeneration: () => guard.generation,
      loadEvidence,
      replaceWorkspace: (next) => { current = next; },
    });
    hydrator.discard(prepared.clearedRunIds);

    expect(current.runEvidence["run-terminal"]).toBeUndefined();
    expect(current.runEvidence["run-unrelated"]?.runId).toBe("run-unrelated");
    await hydrator.schedule(prepared.requests);

    expect(loadEvidence).toHaveBeenCalledTimes(1);
    expect(loadEvidence).toHaveBeenCalledWith("/opened/project-1-alias", "run-terminal");
    expect(current.runEvidence["run-terminal"]).toEqual(evidence);
    expect(current.sessions).toBe(beforeHydration.sessions);
    expect(current.projects).toBe(beforeHydration.projects);
    expect(current.runs).toBe(beforeHydration.runs);
    expect(current.runEvents).toBe(beforeHydration.runEvents);
    expect((current.sessions[0] as CanvasSession).nodes[0]).toBe(authoritative.nodes[0]);
    expect(hydrator.evidenceFor({ ...scope, nodeId: "node-terminal", runId: "run-terminal" })).toEqual(evidence);

    await hydrator.schedule(prepared.requests);
    expect(loadEvidence).toHaveBeenCalledTimes(1);
  });

  it.each([
    ["running evidence", async () => mockRunEvidence({ runId: "run-rejected", status: "running", completedAt: null })],
    ["wrong-run evidence", async () => mockRunEvidence({ runId: "run-other" })],
    ["query rejection", async () => { throw new Error("private evidence unavailable"); }],
  ] as const)("does not install %s for a terminal-looking Canvas", async (_label, loadEvidence) => {
    const prepare = prepareEvidenceHydrationForTest();
    const createHydrator = createEvidenceHydratorForTest();
    const session = terminalCanvasSessionForTest(
      "session-rejected",
      "project-1",
      "node-rejected",
      "run-rejected",
      "failed",
    );
    const project = workflowProjectForTest(
      "project-1",
      "/opened/project-1-alias",
      "/canonical/project-1",
    );
    const scope = evidenceHydrationScopeForTest(session);
    const installed = workflowWorkspaceForTest([project], [session]);
    const prepared = prepare(installed, installed, session, scope);
    let current = prepared.workspace;
    const hydrator = createHydrator({
      getWorkspace: () => current,
      getGeneration: () => scope.generation,
      loadEvidence,
      replaceWorkspace: (next) => { current = next; },
    });

    await expect(hydrator.schedule(prepared.requests)).resolves.toBeUndefined();
    expect(current.runEvidence[session.nodes[0]!.runId]).toBeUndefined();
  });

  it("discards a pending root-A result after the same project id is remapped to root B", async () => {
    const prepare = prepareEvidenceHydrationForTest();
    const createHydrator = createEvidenceHydratorForTest();
    const session = terminalCanvasSessionForTest("session-remap", "project-1", "node-1", "run-remap");
    const rootA = workflowProjectForTest("project-1", "/opened/root-a", "/canonical/root-a");
    const scope = evidenceHydrationScopeForTest(session, {
      queryRoot: rootA.rootPath,
      canonicalRoot: rootA.canonicalRootPath,
    });
    const initial = workflowWorkspaceForTest([rootA], [session]);
    const prepared = prepare(initial, initial, session, scope);
    const pending = deferred<RunEvidence>();
    let current = prepared.workspace;
    const loadEvidence = vi.fn(() => pending.promise);
    const hydrator = createHydrator({
      getWorkspace: () => current,
      getGeneration: () => scope.generation,
      loadEvidence,
      replaceWorkspace: (next) => { current = next; },
    });

    const hydration = hydrator.schedule(prepared.requests);
    expect(loadEvidence).toHaveBeenCalledWith("/opened/root-a", "run-remap");
    current = {
      ...current,
      projects: [workflowProjectForTest("project-1", "/opened/root-b", "/canonical/root-b")],
    };
    pending.resolve(mockRunEvidence({ runId: "run-remap" }));
    await hydration;

    expect(current.runEvidence["run-remap"]).toBeUndefined();
  });

  it.each(["session", "node", "run", "generation"] as const)(
    "discards a pending result after %s replacement",
    async (replacement) => {
      const prepare = prepareEvidenceHydrationForTest();
      const createHydrator = createEvidenceHydratorForTest();
      const session = terminalCanvasSessionForTest("session-pending", "project-1", "node-1", "run-pending");
      const project = workflowProjectForTest(
        "project-1",
        "/opened/project-1-alias",
        "/canonical/project-1",
      );
      const scope = evidenceHydrationScopeForTest(session);
      const initial = workflowWorkspaceForTest([project], [session]);
      const prepared = prepare(initial, initial, session, scope);
      const pending = deferred<RunEvidence>();
      let current = prepared.workspace;
      let generation = scope.generation;
      const hydrator = createHydrator({
        getWorkspace: () => current,
        getGeneration: () => generation,
        loadEvidence: () => pending.promise,
        replaceWorkspace: (next) => { current = next; },
      });

      const hydration = hydrator.schedule(prepared.requests);
      if (replacement === "session") {
        const other = terminalCanvasSessionForTest("session-other", "project-1", "node-1", "run-pending");
        current = { ...current, sessions: [...current.sessions, other], activeSessionId: other.id };
      } else if (replacement === "node") {
        current = {
          ...current,
          sessions: [{ ...session, nodes: [{ ...session.nodes[0]!, id: "node-other" }] }],
        };
      } else if (replacement === "run") {
        current = {
          ...current,
          sessions: [{ ...session, nodes: [{ ...session.nodes[0]!, runId: "run-other" }] }],
        };
      } else {
        generation += 1;
      }
      pending.resolve(mockRunEvidence({ runId: "run-pending" }));
      await hydration;

      expect(current.runEvidence["run-pending"]).toBeUndefined();
    },
  );

  it("scopes identical run ids across project and session switches", async () => {
    const prepare = prepareEvidenceHydrationForTest();
    const createHydrator = createEvidenceHydratorForTest();
    const sharedRunId = "run-shared";
    const sessionA = terminalCanvasSessionForTest("session-a", "project-a", "node-a", sharedRunId);
    const sessionB = terminalCanvasSessionForTest("session-b", "project-b", "node-b", sharedRunId, "failed");
    const projectA = workflowProjectForTest("project-a", "/opened/a", "/canonical/a");
    const projectB = workflowProjectForTest("project-b", "/opened/b", "/canonical/b");
    const scopeA = evidenceHydrationScopeForTest(sessionA, {
      queryRoot: projectA.rootPath,
      canonicalRoot: projectA.canonicalRootPath,
    });
    const scopeB = evidenceHydrationScopeForTest(sessionB, {
      queryRoot: projectB.rootPath,
      canonicalRoot: projectB.canonicalRootPath,
    });
    let current = {
      ...workflowWorkspaceForTest([projectA, projectB], [sessionA, sessionB]),
      activeProjectId: projectA.id,
      activeSessionId: sessionA.id,
    };
    const evidenceA = mockRunEvidence({ runId: sharedRunId, status: "succeeded" });
    const evidenceB = mockRunEvidence({ runId: sharedRunId, status: "failed", exitCode: 1 });
    const hydrator = createHydrator({
      getWorkspace: () => current,
      getGeneration: () => 1,
      loadEvidence: async (queryRoot) => queryRoot === projectA.rootPath ? evidenceA : evidenceB,
      replaceWorkspace: (next) => { current = next; },
    });

    const preparedA = prepare(current, current, sessionA, scopeA);
    current = preparedA.workspace;
    hydrator.discard(preparedA.clearedRunIds);
    await hydrator.schedule(preparedA.requests);
    expect(hydrator.evidenceFor({ ...scopeA, nodeId: "node-a", runId: sharedRunId })).toEqual(evidenceA);

    current = { ...current, activeProjectId: projectB.id, activeSessionId: sessionB.id };
    expect(hydrator.evidenceFor({ ...scopeB, nodeId: "node-b", runId: sharedRunId })).toBeUndefined();

    const preparedB = prepare(current, current, sessionB, scopeB);
    current = preparedB.workspace;
    hydrator.discard(preparedB.clearedRunIds);
    await hydrator.schedule(preparedB.requests);
    expect(hydrator.evidenceFor({ ...scopeB, nodeId: "node-b", runId: sharedRunId })).toEqual(evidenceB);
    expect(hydrator.evidenceFor({ ...scopeA, nodeId: "node-a", runId: sharedRunId })).toBeUndefined();
  });

  it("keeps active evidence when an inactive project installs the same run id in the background", () => {
    const prepare = prepareEvidenceHydrationForTest();
    const sharedRunId = "run-shared-background";
    const sessionA = terminalCanvasSessionForTest("session-a", "project-a", "node-a", sharedRunId);
    const sessionB = terminalCanvasSessionForTest("session-b", "project-b", "node-b", sharedRunId, "failed");
    const projectA = workflowProjectForTest("project-a", "/opened/a", "/canonical/a");
    const projectB = workflowProjectForTest("project-b", "/opened/b", "/canonical/b");
    const scopeB = evidenceHydrationScopeForTest(sessionB, {
      queryRoot: projectB.rootPath,
      canonicalRoot: projectB.canonicalRootPath,
    });
    const current = {
      ...workflowWorkspaceForTest([projectA, projectB], [sessionA, sessionB]),
      activeProjectId: projectA.id,
      activeSessionId: sessionA.id,
      runEvidence: {
        [sharedRunId]: mockRunEvidence({ runId: sharedRunId, status: "succeeded" }),
      },
    };

    const prepared = prepare(current, current, sessionB, scopeB);

    expect(prepared.workspace).toBe(current);
    expect(prepared.workspace.runEvidence[sharedRunId]).toEqual(current.runEvidence[sharedRunId]);
    expect(prepared.requests).toEqual([]);
    expect(prepared.clearedRunIds).toEqual([]);
  });

  it("drops persisted desktop evidence before hydration while preserving browser persistence", async () => {
    const forRendererLoad = workspaceForRendererLoadForTest();
    const persisted = workflowWorkspaceForTest([], []);
    persisted.runEvidence["run-persisted"] = mockRunEvidence({
      runId: "run-persisted",
      status: "failed",
      exitCode: 99,
    });

    const desktop = forRendererLoad(persisted, true);
    const browser = forRendererLoad(persisted, false);

    expect(desktop).not.toBe(persisted);
    expect(desktop.runEvidence).toEqual({});
    expect(browser).toBe(persisted);
    expect(browser.runEvidence["run-persisted"]?.exitCode).toBe(99);
  });

  it("prepares terminal nodes from accepted pulls and canonical broadcasts without changing Canvas state", () => {
    const applyResponse = applyWorkflowResponseForTest();
    const applyBroadcast = applyWorkflowBroadcastForTest();
    const prepare = prepareEvidenceHydrationForTest();
    const requested = terminalCanvasSessionForTest("session-authority", "project-1", "node-1", "run-1");
    const authoritative = {
      ...requested,
      nodes: requested.nodes.map((node) => ({ ...node, progress: "Backend terminal state" })),
    };
    const project = workflowProjectForTest(
      "project-1",
      "/opened/project-1-alias",
      "/canonical/project-1",
    );
    const workspace = workflowWorkspaceForTest([project], [requested]);
    const guard = workflowGuardForTest(requested, { sessionId: requested.id });
    const responseWorkspace = applyResponse(
      workspace,
      workflowEnvelopeForTest(authoritative),
      guard,
      guard.generation,
    );
    const broadcastWorkspace = applyBroadcast(
      workspace,
      workflowEnvelopeForTest(authoritative),
      new Map(),
    );
    const scope = evidenceHydrationScopeForTest(authoritative);

    const fromResponse = prepare(workspace, responseWorkspace, authoritative, scope);
    const fromBroadcast = prepare(workspace, broadcastWorkspace, authoritative, scope);

    expect(fromResponse.requests).toEqual(fromBroadcast.requests);
    expect(fromResponse.requests).toEqual([{
      ...scope,
      nodeId: "node-1",
      runId: "run-1",
    }]);
    expect((fromResponse.workspace.sessions[0] as CanvasSession).nodes[0]).toBe(authoritative.nodes[0]);
    expect((fromBroadcast.workspace.sessions[0] as CanvasSession).nodes[0]).toBe(authoritative.nodes[0]);
  });

  it("keeps cancellation responses and observability outside desktop RunEvidence authority", async () => {
    const appSource = await readSource("./App.tsx");
    const activeStop = appSource.slice(
      appSource.indexOf("function stopActiveRun()"),
      appSource.indexOf("function stopNodeRun("),
    );
    const nodeStop = appSource.slice(
      appSource.indexOf("function stopNodeRun("),
      appSource.indexOf("async function appendRequirementNode"),
    );

    for (const source of [activeStop, nodeStop]) {
      expect(source).toContain("cancelAgentRun");
      expect(source).not.toContain("result.evidence");
      expect(source).not.toContain("runEvidence:");
      expect(source).toMatch(/if \(window\.devflow\) \{[\s\S]*?cancelAgentRun[\s\S]*?return;/);
    }
    expect(appSource).toContain("applyRunEventToWorkspace(current, event)");
    expect(appSource).not.toContain("cancelAgentRun(target.runId, \"Stopped from node modal\").then");
  });
});

describe("Slice C UI behavior", () => {
  it("creates real Fast caller identities uniquely across success, scope, and project boundaries", () => {
    const createSession = Reflect.get(AppModule, "createSession") as undefined | ((
      projectId: string,
      goal: string,
      mode: "fast" | "plan",
      target: { executionTarget: "current_branch"; selectedBranch: string },
      options: { createdAt: string; randomUUID: () => string },
    ) => CanvasSession);
    expect(createSession).toBeTypeOf("function");
    if (!createSession) return;
    const createdAt = "2026-07-21T18:30:00.000Z";
    const target = { executionTarget: "current_branch" as const, selectedBranch: "main" };
    const ids = [
      "11111111-1111-4111-8111-111111111111",
      "22222222-2222-4222-8222-222222222222",
      "33333333-3333-4333-8333-333333333333",
    ];
    const next = () => ids.shift()!;

    const first = createSession("project-1", "Goal A", "fast", target, { createdAt, randomUUID: next });
    const afterSuccess = createSession("project-1", "Goal A", "fast", target, { createdAt, randomUUID: next });
    const otherProject = createSession("project-2", "Goal A", "fast", target, { createdAt, randomUUID: next });

    expect([first.id, afterSuccess.id, otherProject.id]).toEqual([
      "fast-202607211830-11111111-1111-4111-8111-111111111111",
      "fast-202607211830-22222222-2222-4222-8222-222222222222",
      "fast-202607211830-33333333-3333-4333-8333-333333333333",
    ]);
    expect(new Set([first.id, afterSuccess.id, otherProject.id]).size).toBe(3);
  });

  it("accepts an alias query root only with the captured canonical response provenance", () => {
    const applyResponse = applyWorkflowResponseForTest();
    const requested = canvasSessionForTest("session-alias");
    const authoritative = { ...requested, title: "Authoritative alias response" };
    const workspace = workflowWorkspaceForTest(
      [workflowProjectForTest("project-1", "/opened/project-1-alias", "/canonical/project-1")],
      [requested],
    );
    const guard = workflowGuardForTest(requested, { sessionId: requested.id });

    const next = applyResponse(
      workspace,
      workflowEnvelopeForTest(authoritative),
      guard,
      guard.generation,
    );

    expect(next).not.toBe(workspace);
    expect(next.sessions).toEqual([authoritative]);
  });

  it.each([
    ["missing protocol", { protocolVersion: undefined }],
    ["wrong protocol", { protocolVersion: 2 }],
    ["wrong root", { projectRoot: "/canonical/project-other" }],
    ["wrong envelope session", { sessionId: "session-other" }],
    ["wrong canvas id", { canvasSession: canvasSessionForTest("session-other") }],
    ["wrong logical project", { canvasSession: canvasSessionForTest("session-authority", "project-2") }],
  ])("rejects a workflow response with %s", (_label, overrides) => {
    const applyResponse = applyWorkflowResponseForTest();
    const requested = canvasSessionForTest("session-authority");
    const workspace = workflowWorkspaceForTest(
      [workflowProjectForTest("project-1", "/opened/project-1-alias", "/canonical/project-1")],
      [requested],
    );
    const guard = workflowGuardForTest(requested);

    expect(applyResponse(
      workspace,
      workflowEnvelopeForTest({ ...requested, title: "Rejected" }, overrides),
      guard,
      guard.generation,
    )).toBe(workspace);
  });

  it("rejects a workflow response with an absent protocol field or unavailable canonical authority", () => {
    const applyResponse = applyWorkflowResponseForTest();
    const requested = canvasSessionForTest("session-missing-authority");
    const project = workflowProjectForTest(
      "project-1",
      "/opened/project-1-alias",
      "/canonical/project-1",
    );
    const workspace = workflowWorkspaceForTest([project], [requested]);
    const guard = workflowGuardForTest(requested);
    const response = workflowEnvelopeForTest(requested);
    const { protocolVersion: _protocolVersion, ...missingProtocol } = response;
    const missingCanonicalWorkspace = workflowWorkspaceForTest([
      workflowProjectForTest("project-1", project.rootPath, undefined),
    ], [requested]);

    expect(applyResponse(workspace, missingProtocol, guard, guard.generation)).toBe(workspace);
    expect(applyResponse(
      missingCanonicalWorkspace,
      response,
      guard,
      guard.generation,
    )).toBe(missingCanonicalWorkspace);
    expect(applyResponse(
      workspace,
      response,
      { ...guard, canonicalRoot: "/canonical/../project-1" },
      guard.generation,
    )).toBe(workspace);
  });

  it("rejects responses after query-root remap or request-session replacement", () => {
    const applyResponse = applyWorkflowResponseForTest();
    const requested = canvasSessionForTest("session-remap");
    const authoritative = { ...requested, title: "Stale response" };
    const guard = workflowGuardForTest(requested, { sessionId: requested.id });
    const remapped = workflowWorkspaceForTest(
      [workflowProjectForTest("project-1", "/opened/project-1-new-alias", "/canonical/project-1")],
      [requested],
    );
    const replaced = workflowWorkspaceForTest(
      [workflowProjectForTest("project-1", guard.queryRoot, guard.canonicalRoot)],
      [{ ...requested, title: "Newer local identity" }],
    );

    expect(applyResponse(
      remapped,
      workflowEnvelopeForTest(authoritative),
      guard,
      guard.generation,
    )).toBe(remapped);
    expect(applyResponse(
      replaced,
      workflowEnvelopeForTest(authoritative),
      guard,
      guard.generation,
    )).toBe(replaced);
  });

  it("isolates identical session ids by logical project", () => {
    const applyResponse = applyWorkflowResponseForTest();
    const first = canvasSessionForTest("shared-session", "project-1");
    const second = canvasSessionForTest("shared-session", "project-2");
    const authoritativeSecond = { ...second, title: "Project 2 update" };
    const workspace = workflowWorkspaceForTest([
      workflowProjectForTest("project-1", "/opened/project-1-alias", "/canonical/project-1"),
      workflowProjectForTest("project-2", "/opened/project-2-alias", "/canonical/project-2"),
    ], [first, second]);
    const firstGuard = workflowGuardForTest(first);
    const secondGuard = workflowGuardForTest(second, {
      projectId: "project-2",
      queryRoot: "/opened/project-2-alias",
      canonicalRoot: "/canonical/project-2",
    });

    expect(applyResponse(
      workspace,
      workflowEnvelopeForTest(authoritativeSecond, {
        projectRoot: secondGuard.canonicalRoot,
        canvasSession: authoritativeSecond,
      }),
      firstGuard,
      firstGuard.generation,
    )).toBe(workspace);

    const next = applyResponse(
      workspace,
      workflowEnvelopeForTest(authoritativeSecond, {
        projectRoot: secondGuard.canonicalRoot,
        canvasSession: authoritativeSecond,
      }),
      secondGuard,
      secondGuard.generation,
    );
    expect(next.sessions).toEqual([first, authoritativeSecond]);
  });

  it("lets two sessions in one project complete without invalidating each other", () => {
    const applyResponse = applyWorkflowResponseForTest();
    const first = canvasSessionForTest("session-a");
    const second = canvasSessionForTest("session-b");
    const workspace = workflowWorkspaceForTest(
      [workflowProjectForTest("project-1", "/opened/project-1-alias", "/canonical/project-1")],
      [first, second],
    );
    const firstResult = { ...first, title: "Session A result" };
    const secondResult = { ...second, title: "Session B result" };
    const firstGuard = workflowGuardForTest(first);
    const secondGuard = workflowGuardForTest(second);

    const afterFirst = applyResponse(
      workspace,
      workflowEnvelopeForTest(firstResult),
      firstGuard,
      firstGuard.generation,
    );
    const afterSecond = applyResponse(
      afterFirst,
      workflowEnvelopeForTest(secondResult),
      secondGuard,
      secondGuard.generation,
    );

    expect(afterSecond.sessions).toEqual([firstResult, secondResult]);
  });

  it("rejects one stale scoped response while an unrelated identity remains valid", () => {
    const applyResponse = applyWorkflowResponseForTest();
    const stale = canvasSessionForTest("session-stale");
    const unrelated = canvasSessionForTest("session-valid", "project-2");
    const workspace = workflowWorkspaceForTest([
      workflowProjectForTest("project-1", "/opened/project-1-alias", "/canonical/project-1"),
      workflowProjectForTest("project-2", "/opened/project-2-alias", "/canonical/project-2"),
    ], [stale, unrelated]);
    const staleGuard = workflowGuardForTest(stale, { generation: 4 });
    const unrelatedGuard = workflowGuardForTest(unrelated, {
      projectId: "project-2",
      queryRoot: "/opened/project-2-alias",
      canonicalRoot: "/canonical/project-2",
      generation: 9,
    });

    expect(applyResponse(
      workspace,
      workflowEnvelopeForTest({ ...stale, title: "Stale" }),
      staleGuard,
      5,
    )).toBe(workspace);

    const authoritative = { ...unrelated, title: "Still valid" };
    const next = applyResponse(
      workspace,
      workflowEnvelopeForTest(authoritative, {
        projectRoot: unrelatedGuard.canonicalRoot,
        canvasSession: authoritative,
      }),
      unrelatedGuard,
      unrelatedGuard.generation,
    );
    expect(next.sessions).toEqual([stale, authoritative]);
  });

  it("keys workflow generations by logical project, canonical root, and session", async () => {
    const appSource = await readSource("./App.tsx");
    const generationKey = appSource.slice(
      appSource.indexOf("function workflowAuthorityGenerationKey"),
      appSource.indexOf("function currentWorkflowGeneration"),
    );

    expect(generationKey).toContain(
      "JSON.stringify([authority.projectId, authority.canonicalRoot, authority.sessionId])",
    );
    expect(generationKey).not.toContain("authority.queryRoot");
  });

  it("retries a failed New Session with the same session and input identities", async () => {
    const submitNewSessionAttempt = submitNewSessionAttemptForTest();
    const states = new Map<string, NewSessionSubmissionStateForTest>();
    const seed = canvasSessionForTest("session-retry");
    const createAttempt = vi.fn(() => ({ session: seed, inputId: "composer-session-retry" }));
    const firstSubmit = vi.fn(async () => {
      throw new Error("planner start failed");
    });

    await expect(submitNewSessionAttempt({
      states,
      scope: "project-1:goal:fast:current_branch:main",
      createAttempt,
      submit: firstSubmit,
    })).resolves.toBeNull();
    expect(states.get("project-1:goal:fast:current_branch:main")).toMatchObject({
      session: seed,
      inputId: "composer-session-retry",
      busy: false,
      error: "Couldn’t create session. Retry with the same settings.",
    });

    const retrySubmit = vi.fn(async (attempt) => attempt.session);
    await expect(submitNewSessionAttempt({
      states,
      scope: "project-1:goal:fast:current_branch:main",
      createAttempt,
      submit: retrySubmit,
    })).resolves.toBe(seed);
    expect(retrySubmit).toHaveBeenCalledWith({ session: seed, inputId: "composer-session-retry" });
    expect(createAttempt).toHaveBeenCalledTimes(1);
    expect(states.has("project-1:goal:fast:current_branch:main")).toBe(false);
  });

  it("blocks duplicate New Session submission while busy and reports bounded failure", async () => {
    const submitNewSessionAttempt = submitNewSessionAttemptForTest();
    const states = new Map<string, NewSessionSubmissionStateForTest>();
    const seed = canvasSessionForTest("session-busy");
    let rejectSubmit: ((reason: Error) => void) | null = null;
    const submit = vi.fn(() => new Promise<CanvasSession>((_resolve, reject) => {
      rejectSubmit = reject;
    }));
    const first = submitNewSessionAttempt({
      states,
      scope: "busy-scope",
      createAttempt: () => ({ session: seed, inputId: "input-busy" }),
      submit,
    });

    expect(states.get("busy-scope")).toMatchObject({ busy: true, error: null });
    await expect(submitNewSessionAttempt({
      states,
      scope: "busy-scope",
      createAttempt: () => ({ session: canvasSessionForTest("unexpected"), inputId: "unexpected" }),
      submit,
    })).resolves.toBeNull();
    expect(submit).toHaveBeenCalledTimes(1);

    rejectSubmit?.(new Error("failed"));
    await expect(first).resolves.toBeNull();
    expect(states.get("busy-scope")?.error).toBe("Couldn’t create session. Retry with the same settings.");
  });

  it("uses a fresh New Session identity when scope changes and after success", async () => {
    const submitNewSessionAttempt = submitNewSessionAttemptForTest();
    const states = new Map<string, NewSessionSubmissionStateForTest>();
    const identities = ["session-a", "session-b", "session-c"];
    const createAttempt = vi.fn(() => {
      const id = identities.shift() ?? "unexpected";
      return { session: canvasSessionForTest(id), inputId: `input-${id}` };
    });
    const fail = async () => { throw new Error("failed"); };

    await submitNewSessionAttempt({
      states,
      scope: "project-1:goal-a:fast:current_branch:main",
      createAttempt,
      submit: fail,
    });
    const changed = await submitNewSessionAttempt({
      states,
      scope: "project-1:goal-b:fast:new_worktree:main",
      createAttempt,
      submit: async (attempt) => attempt.session,
    });
    const afterSuccess = await submitNewSessionAttempt({
      states,
      scope: "project-1:goal-b:fast:new_worktree:main",
      createAttempt,
      submit: async (attempt) => attempt.session,
    });

    expect(changed?.id).toBe("session-b");
    expect(afterSuccess?.id).toBe("session-c");
    expect(states.get("project-1:goal-a:fast:current_branch:main")?.session.id).toBe("session-a");
  });

  it("upserts authoritative canvas sessions by replacing or inserting", () => {
    const upsertCanvasSession = Reflect.get(AppModule, "upsertCanvasSession") as undefined | ((
      sessions: Array<CanvasSession | PlanSession>,
      session: CanvasSession,
    ) => Array<CanvasSession | PlanSession>);
    expect(upsertCanvasSession).toBeTypeOf("function");
    const original = canvasSessionForTest("session-1");
    const replacement = { ...original, title: "Authoritative replacement" };
    const inserted = canvasSessionForTest("session-2");
    const sameIdOtherProject = canvasSessionForTest("session-1", "project-2");

    expect(upsertCanvasSession!([original], replacement)).toEqual([replacement]);
    expect(upsertCanvasSession!([original], inserted)).toEqual([original, inserted]);
    expect(upsertCanvasSession!([original, sameIdOtherProject], replacement)).toEqual([
      replacement,
      sameIdOtherProject,
    ]);
  });

  it.each([
    {
      label: "another project's Start Page",
      activeProjectId: "project-2",
      activeSessionId: null,
      activeSessionProjectId: null,
    },
    {
      label: "another session",
      activeProjectId: "project-1",
      activeSessionId: "other-session",
      activeSessionProjectId: "project-1",
    },
  ])("installs a late New Session in the background without stealing focus from $label", ({
    activeProjectId,
    activeSessionId,
    activeSessionProjectId,
  }) => {
    const applyResponse = applyWorkflowResponseForTest();
    const decorate = decorateNewSessionInstallationForTest();
    const authoritative = canvasSessionForTest("late-new-session");
    const activeSession = activeSessionId && activeSessionProjectId
      ? canvasSessionForTest(activeSessionId, activeSessionProjectId)
      : null;
    const workspace = {
      ...workflowWorkspaceForTest([
        workflowProjectForTest("project-1", "/opened/project-1-alias", "/canonical/project-1"),
        workflowProjectForTest("project-2", "/opened/project-2-alias", "/canonical/project-2"),
      ], activeSession ? [activeSession] : []),
      activeProjectId,
      activeSessionId,
    };
    const guard = workflowGuardForTest(null, { sessionId: authoritative.id });

    const guarded = applyResponse(
      workspace,
      workflowEnvelopeForTest(authoritative),
      guard,
      guard.generation,
    );
    const next = decorate(guarded, authoritative);

    expect(next.sessions).toEqual(activeSession ? [activeSession, authoritative] : [authoritative]);
    expect(next.changesets).toEqual(guarded.changesets);
    expect(next.activeProjectId).toBe(activeProjectId);
    expect(next.activeSessionId).toBe(activeSessionId);
  });

  it("activates a busy New Session from its authoritative broadcast and rejects the stale create response", () => {
    const applyBroadcast = applyWorkflowBroadcastForTest();
    const applyResponse = applyWorkflowResponseForTest();

    const seed = canvasSessionForTest("session-broadcast");
    const authoritative = { ...seed, title: "Authoritative planner projection" };
    const workspace = workflowWorkspaceForTest(
      [workflowProjectForTest("project-1", "/opened/project-1-alias", "/canonical/project-1")],
      [],
    );
    const submissions = new Map<string, NewSessionSubmissionStateForTest>([["scope", {
      session: seed,
      inputId: "composer-session-broadcast",
      busy: true,
      error: null,
    }]]);

    const broadcastWorkspace = applyBroadcast(
      workspace,
      {
        ...workflowEnvelopeForTest(authoritative),
        cause: "workflow-mutation",
        projection: {},
      },
      submissions,
    );
    expect(broadcastWorkspace.activeProjectId).toBe(authoritative.projectId);
    expect(broadcastWorkspace.activeSessionId).toBe(authoritative.id);
    expect(broadcastWorkspace.sessions).toEqual([authoritative]);

    const staleResponse = { ...authoritative, title: "Stale create response" };
    const guard = workflowGuardForTest(null, { sessionId: seed.id, generation: 1 });
    const afterStaleResponse = applyResponse(
      broadcastWorkspace,
      workflowEnvelopeForTest(staleResponse),
      guard,
      2,
    );
    expect(afterStaleResponse).toBe(broadcastWorkspace);
    expect(afterStaleResponse.activeSessionId).toBe(authoritative.id);
    expect(afterStaleResponse.sessions).toEqual([authoritative]);
  });

  it("accepts an exact broadcast for an existing registered Canvas session", () => {
    const applyBroadcast = applyWorkflowBroadcastForTest();
    const current = canvasSessionForTest("session-existing");
    const authoritative = { ...current, title: "Broadcast update" };
    const workspace = workflowWorkspaceForTest(
      [workflowProjectForTest("project-1", "/opened/project-1-alias", "/canonical/project-1")],
      [current],
    );

    const next = applyBroadcast(workspace, {
      ...workflowEnvelopeForTest(authoritative),
      cause: "workflow-advance",
      projection: {},
    }, new Map());

    expect(next.sessions).toEqual([authoritative]);
  });

  it("rejects invalid, stale, and conflicting workflow broadcasts without workspace mutation", () => {
    const applyBroadcast = applyWorkflowBroadcastForTest();
    const current = canvasSessionForTest("session-broadcast");
    const authoritative = { ...current, title: "Rejected broadcast" };
    const project = workflowProjectForTest(
      "project-1",
      "/opened/project-1-alias",
      "/canonical/project-1",
    );
    const workspace = workflowWorkspaceForTest([project], [current]);
    const exactEvent = {
      ...workflowEnvelopeForTest(authoritative),
      cause: "workflow-mutation",
      projection: {},
    };
    const { protocolVersion: _protocolVersion, ...missingProtocol } = exactEvent;
    const wrongProjectCanvas = canvasSessionForTest(current.id, "project-2");
    const wrongCanvasId = canvasSessionForTest("session-other");
    const planConflict = { ...editablePlanSession(), id: current.id };
    const staleWorkspace = workflowWorkspaceForTest(
      [workflowProjectForTest("project-1", project.rootPath, "/canonical/project-remapped")],
      [current],
    );
    const currentSessionConflict = workflowWorkspaceForTest([project], [planConflict]);
    const sameIdOtherProject = workflowWorkspaceForTest([
      project,
      workflowProjectForTest("project-2", "/opened/project-2-alias", "/canonical/project-2"),
    ], [canvasSessionForTest(current.id, "project-2")]);

    const cases: Array<[string, WorkspaceState, unknown]> = [
      ["missing protocol", workspace, missingProtocol],
      ["unsupported protocol", workspace, { ...exactEvent, protocolVersion: 2 }],
      ["wrong project", workspace, {
        ...exactEvent,
        canvasSession: wrongProjectCanvas,
      }],
      ["wrong root", workspace, { ...exactEvent, projectRoot: "/canonical/project-other" }],
      ["wrong session", workspace, { ...exactEvent, sessionId: "session-other" }],
      ["wrong canvas id", workspace, { ...exactEvent, canvasSession: wrongCanvasId }],
      ["stale registered root", staleWorkspace, exactEvent],
      ["non-Canvas current session", currentSessionConflict, exactEvent],
      ["same id in another project", sameIdOtherProject, exactEvent],
      ["no intended session", workflowWorkspaceForTest([project], []), exactEvent],
    ];

    for (const [label, candidateWorkspace, event] of cases) {
      expect(
        applyBroadcast(candidateWorkspace, event, new Map()),
        label,
      ).toBe(candidateWorkspace);
    }
  });

  it("catches a failed bottom submission and reuses its input id on retry", async () => {
    const submitBottomComposerAttempt = submitBottomComposerAttemptForTest();
    const states = new Map<string, BottomComposerSubmissionStateForTest>();
    const createInputId = vi.fn(() => "input-retry-1");
    let rejectRequest: ((reason: Error) => void) | null = null;
    const submit = vi.fn((inputId: string) => new Promise<string>((_resolve, reject) => {
      expect(inputId).toBe("input-retry-1");
      rejectRequest = reject;
    }));

    const first = submitBottomComposerAttempt({
      states,
      scope: "project-1:session-1",
      text: "Keep this requirement",
      createInputId,
      submit,
    });
    expect(states.get("project-1:session-1")).toMatchObject({ busy: true, error: null });
    await expect(submitBottomComposerAttempt({
      states,
      scope: "project-1:session-1",
      text: "Keep this requirement",
      createInputId,
      submit,
    })).resolves.toBeNull();
    expect(submit).toHaveBeenCalledTimes(1);

    rejectRequest?.(new Error("UNAVAILABLE"));
    await expect(first).resolves.toBeNull();
    expect(states.get("project-1:session-1")).toEqual({
      inputId: "input-retry-1",
      text: "Keep this requirement",
      busy: false,
      error: "Couldn’t submit requirement. Retry with the same text.",
    });

    await expect(submitBottomComposerAttempt({
      states,
      scope: "project-1:session-1",
      text: "Keep this requirement",
      createInputId,
      submit: async (inputId) => inputId,
    })).resolves.toBe("input-retry-1");
    expect(createInputId).toHaveBeenCalledTimes(1);

    const appSource = await readSource("./App.tsx");
    expect(appSource).toContain('role="alert"');
    expect(appSource).toContain("bottomComposerState.error");
  });

  it("clears a successful bottom attempt so identical later text gets a fresh input id", async () => {
    const submitBottomComposerAttempt = submitBottomComposerAttemptForTest();
    const states = new Map<string, BottomComposerSubmissionStateForTest>();
    const inputIds = ["input-success-1", "input-success-2"];
    const createInputId = vi.fn(() => inputIds.shift() ?? "unexpected");
    const submittedIds: string[] = [];
    const submit = async (inputId: string) => {
      submittedIds.push(inputId);
      return inputId;
    };

    await expect(submitBottomComposerAttempt({
      states,
      scope: "project-1:session-1",
      text: "Repeatable requirement",
      createInputId,
      submit,
    })).resolves.toBe("input-success-1");
    expect(states.has("project-1:session-1")).toBe(false);

    await expect(submitBottomComposerAttempt({
      states,
      scope: "project-1:session-1",
      text: "Repeatable requirement",
      createInputId,
      submit,
    })).resolves.toBe("input-success-2");
    expect(submittedIds).toEqual(["input-success-1", "input-success-2"]);
  });

  it("keeps failed bottom attempts isolated by project and session", async () => {
    const submitBottomComposerAttempt = submitBottomComposerAttemptForTest();
    const states = new Map<string, BottomComposerSubmissionStateForTest>();
    const inputIds = ["input-session-1", "input-session-2"];
    const createInputId = vi.fn(() => inputIds.shift() ?? "unexpected");
    const reject = async () => {
      throw new Error("UNAVAILABLE");
    };

    await submitBottomComposerAttempt({
      states,
      scope: "project-1:session-1",
      text: "Session one text",
      createInputId,
      submit: reject,
    });
    await submitBottomComposerAttempt({
      states,
      scope: "project-1:session-2",
      text: "Session two text",
      createInputId,
      submit: reject,
    });

    expect(states.get("project-1:session-1")).toMatchObject({
      inputId: "input-session-1",
      text: "Session one text",
    });
    expect(states.get("project-1:session-2")).toMatchObject({
      inputId: "input-session-2",
      text: "Session two text",
    });
  });

  it("clicking a node selects it and does not open modal/details", async () => {
    const appSource = await readSource("./App.tsx");
    const nodeCard = appSource.slice(appSource.indexOf('className="agent-card-select"'), appSource.indexOf('className="evidence-marker"'));
    expect(nodeCard).toContain('event.stopPropagation()');
    expect(nodeCard).toContain('data.onSelect(node.id)');
    expect(nodeCard).not.toContain('data.onInspect');
    expect(nodeCard).toContain('role="button"');
    expect(nodeCard).toContain('aria-pressed={composerSelected}');
  });

  it("clicking the node card More button opens modal/details", async () => {
    const appSource = await readSource("./App.tsx");
    const menuButton = appSource.slice(appSource.indexOf('className="agent-node-menu nodrag"'), appSource.indexOf('<MoreHorizontal'));
    expect(menuButton).toContain('onClick={(event) => {');
    expect(menuButton).toContain('event.stopPropagation()');
    expect(menuButton).toContain('data.onInspect(node.id)');
  });

  it("opening More synchronizes the selected composer node", async () => {
    const appSource = await readSource("./App.tsx");
    const canvasView = appSource.slice(appSource.indexOf("<CanvasView"), appSource.indexOf("</main>"));
    expect(canvasView).toContain("setSelectedNodeId(nodeId)");
    expect(canvasView).toContain("setInspectedNodeId(nodeId)");
    expect(canvasView).toContain("setInspectedNodeId((current) => (current === nodeId ? current : null))");
  });

  it("node visual target state follows the selected composer node without driving React Flow selection", async () => {
    const appSource = await readSource("./App.tsx");
    const nodesSource = appSource.slice(appSource.indexOf("const nodesSource"), appSource.indexOf("const edges ="));
    const mergeNodes = appSource.slice(appSource.indexOf("function mergeFlowNodeState"), appSource.indexOf("const AGENT_HANDLE_SIZE"));
    const reactFlow = appSource.slice(appSource.indexOf("<ReactFlow"), appSource.indexOf("<CanvasViewportController"));
    expect(nodesSource).toContain("composerSelected: node.id === selectedNodeId");
    expect(nodesSource).toContain("selectedNodeId");
    expect(mergeNodes).toContain("return changed ? merged : current");
    expect(mergeNodes).toContain("selected: existing.selected");
    expect(reactFlow).toContain("onPaneClick={() => onSelectNode(null)}");
    expect(reactFlow).not.toContain("onSelectionChange");
    expect(reactFlow).not.toContain('role="listbox"');
  });

  it("node-scoped composer actions submit through workflow node-action APIs", async () => {
    const appSource = await readSource("./App.tsx");
    const submitHandler = appSource.slice(appSource.indexOf("async function appendRequirementNode"), appSource.indexOf("function retryNode"));
    const composer = appSource.slice(appSource.indexOf("function CanvasComposer("));
    expect(submitHandler).toContain("async function appendRequirementNode(action?: ComposerAction)");
    expect(submitHandler).toContain("await submitSelectedNodeAction(action, text)");
    expect(appSource).toContain("workflow.requestRepair(responseGuard.queryRoot");
    expect(appSource).toContain("workflow.requestVariant(responseGuard.queryRoot");
    expect(appSource).toContain("workflow.applyRollback(responseGuard.queryRoot");
    expect(appSource).toContain("instruction: requestText");
    expect(appSource).toContain("activeSession?.updatedAt,");
    expect(appSource).not.toContain("activeSession?.updatedAt, selectedNode?.id");
    expect(appSource).toContain("workflow.getProjection(authority.queryRoot, sessionId)");
    expect(appSource).toContain("const projectionState = buildSelectedNodeActionState");
    expect(appSource).toContain("const rollbackPayload = projectionState.rollbackPayload");
    expect(appSource).not.toContain("hydrateSelectedNodeActionStateFromEvents");
    expect(appSource).toContain("laneId: rollbackPayload.laneId");
    expect(appSource).toContain("checkpointId: rollbackPayload.checkpointId");
    expect(submitHandler).toContain("nodeActionPayloadMatchesSelection(repairPayload, activeSession.id, selectedNode.id)");
    expect(submitHandler).toContain("nodeActionPayloadMatchesSelection(variantPayload, activeSession.id, selectedNode.id)");
    expect(submitHandler).toContain("nodeActionPayloadMatchesSelection(rollbackPayload, activeSession.id, selectedNode.id)");
    expect(appSource).toContain("const selectedNodeActionGenerationRef = useRef(0);");
    expect(appSource).toContain("selectedNodeActionGenerationRef.current += 1;");
    expect(submitHandler).toContain("const actionGeneration = selectedNodeActionGenerationRef.current + 1;");
    expect(submitHandler).toContain("selectedNodeActionGenerationRef.current = actionGeneration;");
    expect(submitHandler).toContain("nodeActionPayloadMatchesSelection(selectedNodeActionScopeRef.current, actionScope.sessionId, actionScope.nodeId) &&");
    expect(submitHandler).toContain("selectedNodeActionGenerationRef.current === actionGeneration");
    expect(submitHandler).toContain("if (!actionStillCurrent()) return;");
    expect(submitHandler).toContain("applyWorkflowActionResult(result, responseGuard, actionStillCurrent)");
    expect(submitHandler).toContain("await refreshWorkflowProjection(actionStillCurrent)");
    expect(submitHandler).toContain("if (actionStillCurrent()) setNodeActionError");
    expect(submitHandler).toContain("if (actionStillCurrent()) setNodeActionBusy(null)");
    expect(submitHandler).toContain("Selected node action is stale. Reselect the node and try again.");
    expect(appSource).toContain("const selectedNodeActionScopeKey = activeSession?.kind === \"canvas\" && selectedNode");
    expect(appSource).toContain("}, [selectedNodeActionScopeKey]);");
    expect(composer).toContain("selectedNodeActionScopeKey: string | null");
    expect(composer).toContain("}, [selectedNodeActionScopeKey]);");
    expect(composer).toContain("const actionAvailability = selectedNodeActionAvailability");
    expect(composer).toContain("disabled={disabled || nodeActionBusy !== null || !actionAvailability.repair.enabled}");
  });

  it("installs only backend-authoritative canvas sessions for Electron creation and bottom input", async () => {
    const appSource = await readSource("./App.tsx");
    const importProject = appSource.slice(appSource.indexOf("async function importProject"), appSource.indexOf("function openProjectStartPage"));
    const addSession = appSource.slice(appSource.indexOf("async function addSessionFromComposer"), appSource.indexOf("function updatePlanSection"));
    const appendRequirement = appSource.slice(appSource.indexOf("async function appendRequirementNode"), appSource.indexOf("async function submitSelectedNodeAction"));
    const persistSession = appSource.slice(appSource.indexOf("async function persistCanvasWorkflowSession"), appSource.indexOf("function rollbackBlockedMessage"));

    expect(importProject).toContain("initialWorkflowResponse = await persistCanvasWorkflowSession");
    expect(importProject).toContain("initialResponseGuard.queryRoot");
    expect(addSession).toContain("const session = await submitNewSessionAttempt");
    expect(addSession).toContain("const guard = captureWorkflowSessionResponseGuard");
    expect(addSession).toContain("createResponseGuard = guard");
    expect(addSession).toContain("applyGuardedWorkflowSessionResponse(createWorkflowResponse, createResponseGuard");
    expect(addSession).not.toContain("appendResponseGuard");
    expect(addSession).not.toContain("createdSession");
    expect(addSession).toContain("inputId: `composer-${seed.id}`");
    expect(appendRequirement).toContain("const response = await submitBottomComposerAttempt");
    expect(appendRequirement).toContain("return result;");
    expect(appendRequirement).toContain("applyGuardedWorkflowSessionResponse(response, responseGuard)");
    expect(appendRequirement).toContain("return;");
    expect(appendRequirement.indexOf("return;")).toBeLessThan(appendRequirement.indexOf("addRequirementPlanningNode"));
    expect(persistSession).toContain("return window.devflow.createWorkflowSession(queryRoot");
    expect(persistSession).toContain("inputId");
    expect(persistSession).not.toContain("appendWorkflowUserInput");
    expect(persistSession).not.toContain("onCreated");
    expect(appendRequirement).toContain("canvasSessionForWorkflowAuthority(result, responseGuard)");
    expect(persistSession).not.toContain("requireAuthoritativeCanvas");
  });

  it("More button remains outside the node selection target", async () => {
    const appSource = await readSource("./App.tsx");
    const selectTarget = appSource.slice(appSource.indexOf('className="agent-card-select"'), appSource.indexOf('<AgentStreamPreview'));
    const menuButton = appSource.slice(appSource.indexOf('className="agent-node-menu nodrag"'), appSource.indexOf('<MoreHorizontal'));
    expect(selectTarget).not.toContain('className="agent-node-menu nodrag"');
    expect(menuButton).toContain('type="button"');
    expect(menuButton).toContain("event.stopPropagation()");
  });

  it("selected node appears in the bottom composer and cards", async () => {
    const appSource = await readSource("./App.tsx");
    const composer = appSource.slice(appSource.indexOf('function CanvasComposer('));
    expect(composer).toContain('selectedNode && (');
    expect(composer).toContain('className="composer-selected-dock"');
    expect(composer).toContain('className="composer-context-header"');
    expect(composer).toContain('Target:');
    expect(composer).toContain('className="context-title"');
    expect(appSource).toContain('className="agent-node-target-badge"');
    expect(appSource).toContain('Composer target');
    expect(appSource).toContain('has-selected-node');
    expect(appSource).toContain('shouldAutoFitCanvas(session.nodes) || Boolean(selectedNodeId)');
    expect(appSource).toContain('selectedNodeId ?? "none"');
  });

  it("action chips change composer mode/placeholder", async () => {
    const appSource = await readSource("./App.tsx");
    const composer = appSource.slice(appSource.indexOf('function CanvasComposer('));
    expect(composer).toContain('className={`action-chip ${action === "repair" ? "selected" : ""}`}');
    expect(composer).toContain('onClick={() => setAction("repair")}');
    expect(composer).toContain('if (action === "repair") placeholder =');
    expect(composer).toContain('else if (action === "variant") placeholder =');
  });

  it("no selected node keeps existing global bottom input behavior", async () => {
    const appSource = await readSource("./App.tsx");
    const composer = appSource.slice(appSource.indexOf('function CanvasComposer('), appSource.indexOf('const hasValue =', appSource.indexOf('function CanvasComposer(')));
    expect(composer).toContain('let placeholder = "Insert requirement or node"');
    expect(composer).toContain('if (selectedNode) {');
  });

  it("modal still has exactly Output / Changes / Context tabs", async () => {
    const appSource = await readSource("./App.tsx");
    const modalTabs = appSource.slice(appSource.indexOf('<nav className="modal-tabs"'), appSource.indexOf('</nav>', appSource.indexOf('<nav className="modal-tabs"')));
    expect(modalTabs).toContain('NODE_MODAL_TABS.map');

    const modalBodyIndex = appSource.indexOf('<div className="modal-body">');
    const modalBody = appSource.slice(modalBodyIndex, appSource.indexOf('</section>', modalBodyIndex));
    expect(modalBody).toContain('tab === "Output"');
    expect(modalBody).toContain('tab === "Changes"');
    expect(modalBody).toContain('tab === "Context"');
    expect(modalBody).not.toContain('tab === "Logs"');
  });

  it("More button has an accessible label", async () => {
    const appSource = await readSource("./App.tsx");
    const menuButton = appSource.slice(appSource.indexOf('className="agent-node-menu nodrag"'), appSource.indexOf('<MoreHorizontal'));
    expect(menuButton).toContain('aria-label={`More details for ${node.title}`}');
  });

  it("node selection target keeps a visible keyboard focus style", async () => {
    const styleSource = await readSource("./styles.css");
    expect(styleSource).toContain(".agent-card-select:focus-visible");
    expect(styleSource).toContain("outline: 2px solid var(--sk-cobalt)");
  });
});

describe("Slice E node rollback/repair/variant UI wiring", () => {
  const actionState = (overrides: Partial<SelectedNodeActionState> = {}): SelectedNodeActionState => ({
    composerMode: "global",
    canRollback: true,
    blockedByRemoteSideEffect: false,
    needsBackendCheck: false,
    canCreateRepair: true,
    canCreateVariant: true,
    checkpoints: {
      hasBefore: true,
      hasAfter: true,
      beforeCheckpointId: "checkpoint-before-node",
      afterCheckpointId: "checkpoint-after-node",
      beforeCommitSha: null,
      afterCommitSha: null,
      beforeSource: null,
      afterSource: null,
    },
    remoteSideEffects: [],
    blockedReasons: [],
    rollbackPayload: {
      sessionId: "session-1",
      nodeId: "node-1",
      laneId: "lane-1",
      checkpointId: "checkpoint-before-node",
    },
    repairPayload: {
      sessionId: "session-1",
      nodeId: "node-1",
      laneId: "lane-1",
      checkpointId: "checkpoint-after-node",
      successorLaneId: "lane-1-repair",
      successorSemanticKey: "repair:lane-1:manual",
    },
    variantPayload: {
      sessionId: "session-1",
      nodeId: "node-1",
      laneId: "lane-1",
      checkpointId: "checkpoint-before-node",
      successorLaneId: "lane-1-variant",
      successorSemanticKey: "variant:lane-1:manual",
    },
    rollbackEligibility: null,
    ...overrides,
  });

  it("enables repair only with after checkpoint and backend", () => {
    expect(selectedNodeActionAvailability(actionState(), true).repair).toEqual({ enabled: true, reason: null });
    expect(selectedNodeActionAvailability(actionState({
      canCreateRepair: false,
      checkpoints: {
        hasBefore: true,
        hasAfter: false,
        beforeCheckpointId: "checkpoint-before-node",
        afterCheckpointId: null,
        beforeCommitSha: null,
        afterCommitSha: null,
        beforeSource: null,
        afterSource: null,
      },
      repairPayload: null,
    }), true).repair).toEqual({
      enabled: false,
      reason: "Repair requires an after checkpoint.",
    });
    expect(selectedNodeActionAvailability(actionState(), false).repair).toEqual({
      enabled: false,
      reason: "Workflow backend unavailable.",
    });
  });

  it("enables variant only with before checkpoint and backend", () => {
    expect(selectedNodeActionAvailability(actionState(), true).variant).toEqual({ enabled: true, reason: null });
    expect(selectedNodeActionAvailability(actionState({
      canCreateVariant: false,
      canRollback: false,
      checkpoints: {
        hasBefore: false,
        hasAfter: true,
        beforeCheckpointId: null,
        afterCheckpointId: "checkpoint-after-node",
        beforeCommitSha: null,
        afterCommitSha: null,
        beforeSource: null,
        afterSource: null,
      },
      variantPayload: null,
      rollbackPayload: null,
    }), true).variant).toEqual({
      enabled: false,
      reason: "Variant requires a before checkpoint.",
    });
    expect(selectedNodeActionAvailability(actionState(), false).variant).toEqual({
      enabled: false,
      reason: "Workflow backend unavailable.",
    });
  });

  it("disables rollback when helper reports remote side effects", () => {
    expect(selectedNodeActionAvailability(actionState({
      canRollback: false,
      blockedByRemoteSideEffect: true,
      rollbackPayload: null,
      blockedReasons: ["Remote side effects exist."],
    }), true).rollback).toEqual({
      enabled: false,
      reason: REMOTE_SIDE_EFFECT_ROLLBACK_BLOCK_MESSAGE,
    });
  });

  it("allows rollback only when helper marks it eligible and backend is available", () => {
    expect(selectedNodeActionAvailability(actionState(), true).rollback).toEqual({ enabled: true, reason: null });
    expect(selectedNodeActionAvailability(actionState(), false).rollback).toEqual({
      enabled: false,
      reason: "Workflow backend unavailable.",
    });
    expect(selectedNodeActionAvailability(actionState({
      canRollback: false,
      rollbackPayload: null,
      blockedReasons: ["Rollback requires an existing before checkpoint."],
    }), true).rollback).toEqual({
      enabled: false,
      reason: "Rollback requires an existing before checkpoint.",
    });
  });

  it("shows backend rollback failure through user-visible error state", async () => {
    const appSource = await readSource("./App.tsx");
    expect(appSource).toContain("rollbackBlockedMessage(result)");
    expect(appSource).toContain("setNodeActionError(blockedMessage)");
    expect(appSource).toContain("actionFailureMessage(error");
  });

  it("renders rolled-back and inactive nodes from existing rollbackStatus", async () => {
    expect(rollbackLabelForNode({ rollbackStatus: "rolled_back" })).toBe("Rolled back");
    expect(rollbackLabelForNode({ rollbackStatus: "inactive" })).toBe("Inactive");

    const appSource = await readSource("./App.tsx");
    expect(appSource).toContain("rollbackStatusForNode(node)");
    expect(appSource).toContain("data-rollback-status={rollbackStatus || undefined}");
    expect(appSource).toContain("rollback-badge");

    const styleSource = await readSource("./styles.css");
    expect(styleSource).toContain(".agent-node-shell.rollback-rolled_back");
    expect(styleSource).toContain(".agent-node-shell.rollback-inactive");
  });

  it("states rollback scope without claiming evidence/history deletion", async () => {
    const appSource = await readSource("./App.tsx");
    expect(appSource).toContain("Rollback affects selected and downstream workflow state, not evidence/history.");
    expect(appSource).not.toContain("delete evidence");
    expect(appSource).not.toContain("delete history");
  });

  it("selected node scope change clears stale action state", async () => {
    const appSource = await readSource("./App.tsx");
    const useEffectSource = appSource.slice(appSource.indexOf("const workflow = window.devflow?.workflow;"), appSource.indexOf("const projectRoot = activeProject.rootPath;"));
    expect(appSource).toContain("const selectedNodeActionScopeKey = activeSession?.kind === \"canvas\" && selectedNode");
    expect(appSource).not.toContain("}, [selectedNode?.id]);");
    expect(appSource).toContain("selectedNodeActionGenerationRef.current += 1;");
    expect(appSource).toContain("setNodeActionBusy(null);");
    expect(appSource).toContain("}, [selectedNodeActionScopeKey]);");
    expect(useEffectSource).toContain("setSelectedNodeActionState(null);");
  });

  it("eligible rollback shows selected plus downstream summary", async () => {
    const appSource = await readSource("./App.tsx");
    expect(affectedDownstreamSummaryForDisplay(actionState({
      rollbackEligibility: {
        eligible: true,
        targetLaneId: "lane-1",
        checkpointId: "checkpoint-before-node",
        restoreCommitRef: "base-sha",
        affectedLaneIds: ["lane-1", "lane-2", "lane-3", "lane-4", "lane-5"],
        reason: "Rollback eligible.",
        blockingRemoteSideEffects: [],
      },
    }), "node-1")).toBe("4 downstream: lane-2, lane-3, lane-4, +1 more");
    expect(appSource).toContain("evidence-chip impact");
    expect(appSource).toContain("affectedDownstreamSummaryForDisplay(selectedNodeActionState, selectedNode.id)");
  });

  it("failed node selected shows failure summary, latest check, and action impact copy", async () => {
    const appSource = await readSource("./App.tsx");
    const composer = appSource.slice(appSource.indexOf("function CanvasComposer("), appSource.indexOf("function rollbackBlockedMessage"));
    const modal = appSource.slice(appSource.indexOf("function NodeModal("), appSource.indexOf("function EditorLaunchMenu"));
    expect(composer).toContain("failureSummaryForNode(selectedNode, selectedRunEvidence)");
    expect(composer).toContain("latestFailedCheckForDisplay(selectedRunEvidence)");
    expect(composer).toContain("lastRunEvidenceForDisplay(selectedRunEvidence)");
    expect(composer).toContain("Failure summary");
    expect(composer).toContain("Last failed check");
    expect(composer).toContain("Last evidence");
    expect(composer).toContain("NODE_ACTION_IMPACT_COPY.repair");
    expect(composer).toContain("NODE_ACTION_IMPACT_COPY.variant");
    expect(composer).toContain("NODE_ACTION_IMPACT_COPY.rollback");
    expect(appSource).toContain("Repair uses the after checkpoint");
    expect(appSource).toContain("Variant uses the before checkpoint");
    expect(appSource).toContain("Rollback affects selected + downstream");
    expect(composer).toContain("REMOTE_SIDE_EFFECT_ROLLBACK_BLOCK_MESSAGE");
    expect(appSource).toContain(REMOTE_SIDE_EFFECT_ROLLBACK_BLOCK_MESSAGE);
    expect(modal).toContain("failureSummaryForNode(node, runEvidence)");
    expect(modal).toContain("latestFailedCheckForDisplay(runEvidence)");
    expect(modal).toContain("lastRunEvidenceForDisplay(runEvidence)");
    expect(modal).toContain("node-failure-summary");
    expect(lastRunEvidenceForDisplay(mockRunEvidence({
      status: "failed",
      exitCode: 1,
      checks: [{ kind: "test", name: "unit", status: "failed", detail: "exit 1" }],
    }))).toBe("failed; exit 1; unit failed; 2026-06-27T00:00:00.000Z");
  });

  it("checkpoint summary renders checkpoint/restore commit/source", async () => {
    const appSource = await readSource("./App.tsx");
    expect(appSource).toContain("Before Checkpoint");
    expect(appSource).toContain("After Checkpoint");
    expect(appSource).toContain("selectedNodeActionState.checkpoints.beforeCheckpointId");
    expect(appSource).toContain("selectedNodeActionState.checkpoints.afterCheckpointId");
    expect(appSource).toContain("selectedNodeActionState?.rollbackEligibility?.restoreCommitRef");
  });

  it("remote blocker/manual repair disables rollback and shows correct message", async () => {
    const appSource = await readSource("./App.tsx");
    expect(appSource).toContain("Remote blockers:");
    expect(appSource).toContain("selectedNodeActionState.remoteSideEffects.length");
    expect(appSource).toContain("selectedNodeActionState.rollbackEligibility?.manualRepairReason");
    expect(appSource).toContain("Backend check required");
  });
});

describe("Terminal Inspector UI Helper", () => {
  const mockSnapshot: TerminalSnapshotResult = {
    protocolVersion: 1,
    terminalSessionId: "session-123",
    status: "running",
    sequence: 42,
    rows: 24,
    cols: 80,
    cursor: { row: 0, col: 0 },
    lines: [],
    message: "Test error",
    reasonCode: "TERMINAL_SESSION_NOT_FOUND"
  };

  it("formats title correctly", () => {
    expect(formatTerminalTitle(null)).toBe("Hermes Terminal");
    expect(formatTerminalTitle(mockSnapshot)).toBe("Hermes Terminal (session-123)");
  });

  it("formats badge correctly", () => {
    expect(formatTerminalBadge(null)).toBe("connecting...");
    expect(formatTerminalBadge(mockSnapshot)).toBe("running [seq: 42]");
  });

  it("formats message correctly", () => {
    expect(formatTerminalMessage(null)).toBeNull();
    expect(formatTerminalMessage(mockSnapshot)).toBe("Test error (TERMINAL_SESSION_NOT_FOUND)");
  });

  it("maps planner status from PTY snapshot metadata without reading terminal text", () => {
    const status = plannerSessionStatusForSnapshot("session-123", {
      ...mockSnapshot,
      status: "running",
      lines: [
        { sequence: 1, stream: "stdout", text: "failed completed blocked" },
      ],
    });

    expect(status).toEqual({
      label: "Running",
      tone: "running",
      detail: "PTY lifecycle: running",
      inspectable: true,
    });
  });

  it("reports degraded planner status when no PTY session is bound", () => {
    expect(plannerSessionStatusForSnapshot(null, null)).toEqual({
      label: "Unavailable",
      tone: "degraded",
      detail: "No Hermes planner PTY session is bound.",
      inspectable: false,
    });
  });

  it("maps terminal lifecycle states to lightweight planner status chrome", () => {
    expect(plannerSessionStatusForSnapshot("session-123", { ...mockSnapshot, status: "starting", message: undefined, reasonCode: undefined }).label).toBe("Planning");
    expect(plannerSessionStatusForSnapshot("session-123", { ...mockSnapshot, status: "waiting", message: undefined, reasonCode: undefined }).label).toBe("Waiting");
    expect(plannerSessionStatusForSnapshot("session-123", { ...mockSnapshot, status: "exited", message: undefined, reasonCode: undefined }).label).toBe("Inspectable");
    expect(plannerSessionStatusForSnapshot("session-123", { ...mockSnapshot, status: "failed", message: undefined, reasonCode: undefined }).label).toBe("Blocked");
    expect(plannerSessionStatusForSnapshot("session-123", { ...mockSnapshot, status: "unavailable", message: undefined, reasonCode: undefined }).label).toBe("Unavailable");
  });
});

describe("Terminal Inspector Source Code Analysis", () => {
  it("terminal content defaults hidden and planner status owns the inspector affordance", async () => {
    const appSource = await readSource("./App.tsx");
    expect(appSource).toContain("const [terminalOpen, setTerminalOpen] = useState(false);");
    expect(appSource).toContain("onOpenPlannerInspector={() => setTerminalOpen(true)}");

    const topBarSource = appSource.slice(appSource.indexOf("function TopBar"), appSource.indexOf("function Sidebar"));
    expect(topBarSource).not.toContain("terminalOpen");
    expect(topBarSource).not.toContain("onToggleTerminal");
    expect(topBarSource).not.toContain("<Terminal");
  });

  it("Node Modal tabs still only Output/Changes/Context", async () => {
    const appSource = await readSource("./App.tsx");
    const modalTabs = appSource.slice(appSource.indexOf('<nav className="modal-tabs"'), appSource.indexOf('</nav>', appSource.indexOf('<nav className="modal-tabs"')));
    // NODE_MODAL_TABS is used, and it shouldn't contain terminal tabs
    expect(appSource).toContain("NODE_MODAL_TABS");
    // Ensure we don't render terminal logs inside node modal
    const modalBodyIndex = appSource.indexOf('<div className="modal-body">');
    if (modalBodyIndex !== -1) {
      const modalBody = appSource.slice(modalBodyIndex, appSource.indexOf('</section>', modalBodyIndex));
      expect(modalBody).toContain('tab === "Output"');
      expect(modalBody).toContain('tab === "Changes"');
      expect(modalBody).toContain('tab === "Context"');
      expect(modalBody).not.toContain('tab === "Logs"');
      expect(modalBody).not.toContain('tab === "Terminal"');
    }
  });

  it("selecting node does not auto-open terminal", async () => {
    const appSource = await readSource("./App.tsx");
    const selectionStart = appSource.indexOf("onSelectNode={(nodeId)");
    const selection = appSource.slice(selectionStart, appSource.indexOf("onInspectNode=", selectionStart));
    const nextActionStart = appSource.indexOf("onNavigateNextAction={(navigation)");
    const nextActionNavigation = appSource.slice(
      nextActionStart,
      appSource.indexOf("onComposerChange=", nextActionStart),
    );

    expect(selectionStart).toBeGreaterThan(-1);
    expect(nextActionStart).toBeGreaterThan(-1);
    expect(selection).not.toContain("setTerminalOpen(true)");
    expect(nextActionNavigation).not.toContain("setTerminalOpen(true)");
  });

  it("renderer does not call terminal.start / terminal.write; read-only only", async () => {
    const appSource = await readSource("./App.tsx");
    expect(appSource).not.toContain("terminal.start");
    expect(appSource).not.toContain("terminal.write");
    expect(appSource).toContain("disabled");
    expect(appSource).toContain("Terminal is read-only in this mode...");
  });

  it("Terminal Inspector placement avoids composer safe area and Node Modal overlaps it", async () => {
    const styleSource = await readSource("./styles.css");
    const terminalInspectorStyle = styleSource.slice(styleSource.indexOf(".terminal-inspector {"));

    // Assert placement is top-right, avoiding bottom composer zone
    expect(terminalInspectorStyle).toMatch(/top:\s*64px;/);
    expect(terminalInspectorStyle).toMatch(/right:\s*20px;/);
    expect(terminalInspectorStyle).toMatch(/bottom:\s*(1[8-9][0-9]|2[0-9]{2})px;/); // >= 180px inset

    // Assert z-index logic allows modal to cover it and stays under composer
    expect(terminalInspectorStyle).toMatch(/z-index:\s*7;/);
    const modalBackdropStyle = styleSource.slice(styleSource.indexOf(".modal-backdrop {"));
    expect(modalBackdropStyle).toMatch(/z-index:\s*20;/);
  });

  it("Terminal Inspector only renders for active session/canvas (not Project Start)", async () => {
    const appSource = await readSource("./App.tsx");
    // Ensure it renders scoped to activeSession canvas
    expect(appSource).toMatch(/\{terminalOpen && activeSession\?.kind === "canvas" && \(\s*<TerminalInspector/);
  });

  it("source wiring uses activeSession.kind === 'canvas' before rendering inspector", async () => {
    const appSource = await readSource("./App.tsx");
    expect(appSource).toContain('terminalOpen && activeSession?.kind === "canvas" && (');
  });

  it("terminal id resolver returns null when no binding exists", async () => {
    const appSource = await readSource("./App.tsx");
    expect(appSource).toContain("function plannerTerminalSessionId(session: CanvasSession): string | null");
    expect(appSource).toContain("terminalSessionId={plannerTerminalSessionId(activeSession)}");
  });

  it("terminal id resolver returns hermesPlannerTerminalSessionId when present, even if it differs from canvas session id", async () => {
    const appSource = await readSource("./App.tsx");
    expect(appSource).toContain("hermesPlannerTerminalSessionId?: unknown");
    expect(appSource).toContain("typeof value === \"string\" && value.trim().length > 0 ? value : null");
  });

  it("source does not use session.id as terminalSessionId for snapshot/event filtering", async () => {
    const appSource = await readSource("./App.tsx");
    const inspectorSource = appSource.slice(appSource.indexOf("function useTerminalSnapshot"));
    expect(inspectorSource).not.toMatch(/terminalSessionId:\s*session\.id/);
    expect(inspectorSource).not.toMatch(/event\.terminalSessionId === session\.id/);

    // Ensure terminalSessionId is used correctly
    expect(inspectorSource).toMatch(/\[.*terminalSessionId.*\]/);
    expect(inspectorSource).toContain("terminalApi.snapshot({ terminalSessionId: boundTerminalSessionId })");
    expect(inspectorSource).toContain("event.terminalSessionId === boundTerminalSessionId");
  });

  it("unbound state does not call snapshot/start/write", async () => {
    const appSource = await readSource("./App.tsx");
    const snapshotSource = appSource.slice(appSource.indexOf("function unboundTerminalSnapshot"));
    expect(snapshotSource).toContain('terminalSessionId: "unbound"');
    expect(snapshotSource).toContain("No terminal session bound.");
    expect(appSource).not.toContain("terminal.start");
    expect(appSource).not.toContain("terminal.write");
  });

  it("planner status is root-card chrome and opens the existing hidden inspector", async () => {
    const appSource = await readSource("./App.tsx");
    expect(appSource).toContain("plannerSessionStatusForSnapshot");
    expect(appSource).toContain("plannerStatus: node.id === session.plannerNodeId ? plannerStatus : null");
    expect(appSource).toContain("planner-session-status");
    expect(appSource).toContain("onOpenPlannerInspector");
    expect(appSource).toContain("setTerminalOpen(true)");
  });
});
