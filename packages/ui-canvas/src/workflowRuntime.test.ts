import { describe, expect, it, vi } from "vitest";

import type { WorkspaceState } from "@skyturn/persistence";
import type { AgentRun, CanvasNode, CanvasSession, ImportedProject, RunEvent, RunEvidence, StartAgentRunInput } from "@skyturn/project-core";

import * as WorkflowRuntime from "./workflowRuntime.js";
import {
  applyBridgeRunResult,
  applyCompletedBridgeRunPersistenceResult,
  buildPromptForNodeRun,
  claimCompletedBridgeRunPersistence,
  mergeRunEventsIntoWorkspace,
  persistCompletedBridgeRunResult,
  retryCanvasNode,
  sandboxForNodeRun,
  startBridgeRun,
} from "./workflowRuntime.js";

describe("workflow runtime event merging", () => {
  it("uses the workflow input requirement when building a Hermes planning prompt", () => {
    const session = makeSession([]);
    const node = makeNode({
      id: "node-requirement",
      agent: "hermes",
      status: "running",
      runId: "run-session-1-node-requirement",
      brief: "Add audit logging to the run bridge",
    });

    const prompt = buildPromptForNodeRun(session, node);

    expect(prompt).toContain("User goal: Build workflow");
    expect(prompt).toContain("Current requirement: Add audit logging to the run bridge");
    expect(prompt).not.toContain("User goal: Decompose the user goal into workflow-card tool calls.");
  });

  it("applies Hermes workflow-card tool output to the active canvas state", () => {
    const workspace = makeWorkspace();
    const hermesRunId = "run-session-1-node-1";

    const next = mergeRunEventsIntoWorkspace(workspace, hermesRunId, [
      event(hermesRunId, 1, "output", {
        text: JSON.stringify({
          toolCalls: [
            {
              tool: "createWorkflowCard",
              toolCallId: "call-create-draft",
              input: {
                id: "node-draft",
                title: "Draft scratch card",
                agent: "hermes",
                brief: "Temporary scratch card",
              },
            },
            {
              tool: "updateWorkflowCard",
              toolCallId: "call-update-draft",
              input: {
                id: "node-draft",
                progress: "Refined",
                output: "Draft refined before deletion.",
              },
            },
            {
              tool: "deleteWorkflowCard",
              toolCallId: "call-delete-draft",
              input: {
                id: "node-draft",
              },
            },
            {
              tool: "createWorkflowCard",
              toolCallId: "call-create-code",
              input: {
                id: "node-code",
                title: "Implement task",
                agent: "codex",
                status: "running",
                brief: "Make the code change and report evidence.",
                dependencies: ["node-1"],
                worktreePath: ".",
              },
            },
          ],
        }),
      }),
    ]);

    const session = next.sessions[0] as CanvasSession;
    expect(session.nodes.some((node) => node.id === "node-draft")).toBe(false);
    const codeNode = session.nodes.find((node) => node.id === "node-code");
    expect(codeNode?.agent).toBe("codex");
    expect(codeNode?.status).toBe("running");
    expect(codeNode?.workflowTrace?.lastTool).toBe("createWorkflowCard");
    expect(session.edges).toContainEqual({
      id: "edge-node-1-node-code",
      source: "node-1",
      target: "node-code",
    });
  });

  it("projects Hermes WorkflowIntent output into dynamic Flow Kernel lanes and edges", () => {
    const workspace = makeWorkspace();
    const hermesRunId = "run-session-1-node-1";

    const next = mergeRunEventsIntoWorkspace(workspace, hermesRunId, [
      event(hermesRunId, 1, "output", {
        text: JSON.stringify({
          intentId: "intent-frontend-1",
          sessionId: "session-1",
          operations: [
            { type: "AnalyzeRequirement", requirement: "Add a search filtering control" },
            { type: "DiscoverProject", profile: { languages: ["typescript"], capabilities: ["frontend-ui"] } },
            { type: "ProposeLanes" },
          ],
        }),
      }),
    ]);

    const session = next.sessions[0] as CanvasSession;
    expect(session.nodes.map((node) => node.id)).toEqual([
      "node-1",
      "lane-discovery",
      "lane-design",
      "lane-implementation",
      "lane-browser-validation",
      "lane-review",
      "lane-commit",
    ]);
    expect(session.edges).toContainEqual({
      id: "edge-design-implementation",
      source: "lane-design",
      target: "lane-implementation",
    });
    expect(session.nodes.find((node) => node.id === "lane-implementation")?.context.dependencies).toEqual([
      "lane-design",
    ]);
    expect(session.nodes.find((node) => node.id === "lane-browser-validation")?.display?.meta).toContain("browser_validation");
    expect(session.nodes.find((node) => node.id === "lane-implementation")?.output).toEqual([]);
    expect(session.nodes.find((node) => node.id === "lane-discovery")?.position.x).toBeGreaterThan(
      (session.nodes.find((node) => node.id === "node-1")?.position.x ?? 0) + 300,
    );
  });

  it.each([
    ["omitted", {}],
    ["empty", { requiredEvidence: [] }],
  ])("submits the fixed screenshot declaration for an external browser lane with %s evidence", async (_caseName, evidenceInput) => {
    const workspace = makeWorkspace();
    const project = workspace.projects[0] as ImportedProject;
    const hermesRunId = "run-session-1-node-1";
    const projected = mergeRunEventsIntoWorkspace(workspace, hermesRunId, [
      event(hermesRunId, 1, "output", {
        text: JSON.stringify({
          intentId: `intent-browser-${_caseName}`,
          sessionId: "session-1",
          operations: [{
            type: "ProposeLanes",
            lanes: [{
              id: `lane-browser-${_caseName}`,
              kind: "browser_validation",
              title: "Capture browser screenshot",
              agentKind: "codex",
              ...evidenceInput,
            }],
          }],
        }),
      }),
    ]);
    const projectedSession = projected.sessions[0] as CanvasSession;
    const projectedNode = projectedSession.nodes.find((node) => node.id === `lane-browser-${_caseName}`)!;
    const node = { ...projectedNode, status: "running" as const };
    const session = {
      ...projectedSession,
      nodes: projectedSession.nodes.map((candidate) => candidate.id === node.id ? node : candidate),
    };
    const startAgentRun = vi.fn(async () => null);
    vi.stubGlobal("window", { devflow: { startAgentRun } });

    try {
      expect(node.requiredEvidence).toEqual(["browser", "screenshot"]);
      expect(await startBridgeRun(project, session, node)).toBeNull();
      expect(startAgentRun).toHaveBeenCalledWith(expect.objectContaining({
        expectedArtifacts: [".devflow/acceptance/react-app.png"],
      }));
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("does not locally project WorkflowIntent output from a non-planner Hermes lane", () => {
    const workspace = makeWorkspace([
      makeNode({
        id: "lane-review",
        agent: "hermes",
        status: "running",
        runId: "run-session-1-lane-review",
        brief: "Review code evidence",
        meta: ["review", "lane-review", "flow-kernel"],
      }),
    ]);
    const reviewRunId = "run-session-1-lane-review";

    const next = mergeRunEventsIntoWorkspace(workspace, reviewRunId, [
      event(reviewRunId, 1, "output", {
        text: JSON.stringify({
          intentId: "intent-review-leak",
          sessionId: "session-1",
          operations: [
            {
              type: "ProposeLanes",
              lanes: [
                {
                  id: "lane-leaked",
                  semanticKey: "dynamic:leaked",
                  kind: "implementation",
                  title: "Leaked lane",
                  agentKind: "codex",
                },
              ],
            },
          ],
        }),
      }),
    ]);

    const session = next.sessions[0] as CanvasSession;
    expect(session.nodes.map((node) => node.id)).toEqual(["node-1", "lane-review"]);
    expect(session.edges).toEqual([]);
  });

  it("does not locally project Hermes WorkflowIntent when Electron workflow IPC is available", () => {
    vi.stubGlobal("window", {
      devflow: {},
    });
    try {
      const workspace = makeWorkspace();
      const hermesRunId = "run-session-1-node-1";

      const next = mergeRunEventsIntoWorkspace(workspace, hermesRunId, [
        event(hermesRunId, 1, "output", {
          text: JSON.stringify({
            intentId: "intent-frontend-1",
            sessionId: "session-1",
            operations: [
              { type: "AnalyzeRequirement", requirement: "Add a search filtering control" },
              { type: "DiscoverProject", profile: { languages: ["typescript"], capabilities: ["frontend-ui"] } },
              { type: "ProposeLanes" },
            ],
          }),
        }),
      ]);

      const session = next.sessions[0] as CanvasSession;
      expect(session.nodes.map((node) => node.id)).toEqual(["node-1"]);
      expect(session.edges).toEqual([]);
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("injects ledger context and applies Hermes WorkflowIntent through Node workflow IPC", async () => {
    const project = makeWorkspace().projects[0] as ImportedProject;
    const session = makeSession([]);
    const node = session.nodes[0] as CanvasNode;
    const intentText = JSON.stringify({
      intentId: "intent-ledger-1",
      sessionId: "session-1",
      operations: [
        { type: "AnalyzeRequirement", requirement: "Continue from previous audit logging decision" },
        { type: "DiscoverProject", profile: { languages: ["typescript"], capabilities: ["code-change"] } },
        { type: "ProposeLanes" },
      ],
    });
    const startAgentRun = vi.fn(async (input: StartAgentRunInput) => ({
      protocolVersion: 1,
      run: {
        id: input.runId ?? "run-generated",
        nodeId: input.nodeId,
        sessionId: input.sessionId,
        projectRoot: input.projectRoot,
        worktreePath: input.worktreePath,
        agentKind: input.agentKind,
        status: "succeeded",
        startedAt: "2026-06-10T00:00:00.000Z",
      } satisfies AgentRun,
    }));
    const getRunEvents = vi.fn(async () => ({
      protocolVersion: 1,
      events: [event(node.runId, 1, "output", { text: intentText })],
    }));
    const getRunEvidence = vi.fn(async () => ({
      protocolVersion: 1,
      evidence: {
        runId: node.runId,
        status: "succeeded",
        exitCode: 0,
        changesetId: null,
        checks: [{ kind: "run-exit", name: "Hermes CLI exit", status: "passed", detail: "exit 0" }],
        artifacts: [],
        review: null,
        errorReason: null,
        cancelReason: null,
        completedAt: "2026-06-10T00:00:01.000Z",
      } satisfies RunEvidence,
    }));
    const getWorkflowLedger = vi.fn(async () => ({
      protocolVersion: 1,
      ledger: {
        throughSeq: 4,
        checkpointSummary: null,
        facts: ["Decision: keep retry behavior explicit."],
        recentEvents: [{ seq: 4, kind: "workflow.user_input", summary: "Add audit logging first." }],
        openQuestions: [],
      },
    }));
    const projectedSession: CanvasSession = {
      ...session,
      nodes: [
        ...session.nodes,
        makeNode({
          id: "lane-implementation",
          agent: "codex",
          status: "running",
          runId: "run-session-1-lane-implementation",
          meta: ["implementation", "lane-implementation", "flow-kernel"],
        }),
      ],
    };
    const applyWorkflowIntent = vi.fn(async () => ({
      protocolVersion: 1,
      result: { ok: true },
      projection: {},
      canvasSession: session,
    }));
    const recordWorkflowRunResult = vi.fn(async () => ({
      protocolVersion: 1,
      projection: {},
      canvasSession: {
        ...session,
        nodes: session.nodes.map((item) =>
          item.id === session.plannerNodeId
            ? {
                ...item,
                status: "completed" as const,
                progress: "Evidence ready",
                runtime: { phase: "Completed" as const, message: "Evidence ready", action: "completed" },
              }
            : item,
        ),
      },
    }));
    const scheduleWorkflowReadyLanes = vi.fn(async () => ({
      protocolVersion: 1,
      result: { readyLanes: [{ id: "lane-implementation" }] },
      projection: {},
      canvasSession: projectedSession,
    }));
    vi.stubGlobal("window", {
      devflow: {
        startAgentRun,
        getRunEvents,
        getRunEvidence,
        getWorkflowLedger,
        applyWorkflowIntent,
        recordWorkflowRunResult,
        scheduleWorkflowReadyLanes,
      },
    });

    try {
      const result = await startBridgeRun(project, session, node);

      expect(startAgentRun.mock.calls[0]?.[0].prompt).toContain("Decision: keep retry behavior explicit.");
      expect(recordWorkflowRunResult).toHaveBeenCalledWith(project.rootPath, {
        sessionId: session.id,
        laneId: node.id,
        segmentId: `segment-${session.id}-${node.id}`,
        runId: node.runId,
        agentKind: node.agent,
        now: "2026-06-10T00:00:01.000Z",
      });
      expect(applyWorkflowIntent).toHaveBeenCalledWith(project.rootPath, expect.objectContaining({ intentId: "intent-ledger-1" }));
      expect(scheduleWorkflowReadyLanes).toHaveBeenCalledWith(project.rootPath, session.id, expect.objectContaining({ allowedParallelism: 1 }));
      expect(result?.workflowSession?.nodes.map((item) => item.id)).toContain("lane-implementation");
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("rejects Hermes WorkflowIntent for a different canvas session before Node workflow IPC", async () => {
    const project = makeWorkspace().projects[0] as ImportedProject;
    const session = makeSession([]);
    const node = session.nodes[0] as CanvasNode;
    const startAgentRun = vi.fn(async (input: StartAgentRunInput) => ({
      protocolVersion: 1,
      run: {
        id: input.runId ?? "run-generated",
        nodeId: input.nodeId,
        sessionId: input.sessionId,
        projectRoot: input.projectRoot,
        worktreePath: input.worktreePath,
        agentKind: input.agentKind,
        status: "succeeded",
        startedAt: "2026-06-10T00:00:00.000Z",
      } satisfies AgentRun,
    }));
    const getRunEvents = vi.fn(async () => ({
      protocolVersion: 1,
      events: [
        event(node.runId, 1, "output", {
          text: JSON.stringify({
            intentId: "intent-wrong-session",
            sessionId: "session-2",
            operations: [
              { type: "AnalyzeRequirement", requirement: "Write into the wrong session" },
              { type: "DiscoverProject", profile: { languages: ["typescript"], capabilities: ["code-change"] } },
              { type: "ProposeLanes" },
            ],
          }),
        }),
      ],
    }));
    const getRunEvidence = vi.fn(async () => ({
      protocolVersion: 1,
      evidence: {
        runId: node.runId,
        status: "succeeded",
        exitCode: 0,
        changesetId: null,
        checks: [],
        artifacts: [],
        review: null,
        errorReason: null,
        cancelReason: null,
        completedAt: "2026-06-10T00:00:01.000Z",
      } satisfies RunEvidence,
    }));
    const getWorkflowLedger = vi.fn(async () => ({
      protocolVersion: 1,
      ledger: { throughSeq: 1, checkpointSummary: null, facts: [], recentEvents: [], openQuestions: [] },
    }));
    const applyWorkflowIntent = vi.fn();
    const scheduleWorkflowReadyLanes = vi.fn();
    vi.stubGlobal("window", {
      devflow: {
        startAgentRun,
        getRunEvents,
        getRunEvidence,
        getWorkflowLedger,
        applyWorkflowIntent,
        scheduleWorkflowReadyLanes,
      },
    });

    try {
      const result = await startBridgeRun(project, session, node);

      expect(result?.workflowSession).toBeNull();
      expect(applyWorkflowIntent).not.toHaveBeenCalled();
      expect(scheduleWorkflowReadyLanes).not.toHaveBeenCalled();
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("persists Hermes WorkflowIntent after terminal run evidence arrives after start", async () => {
    const project = makeWorkspace().projects[0] as ImportedProject;
    const session = makeSession([]);
    const node = session.nodes[0] as CanvasNode;
    let terminal = false;
    const intentText = JSON.stringify({
      intentId: "intent-terminal-1",
      sessionId: "session-1",
      operations: [
        { type: "AnalyzeRequirement", requirement: "Schedule implementation after Hermes finishes" },
        { type: "DiscoverProject", profile: { languages: ["typescript"], capabilities: ["code-change"] } },
        { type: "ProposeLanes" },
      ],
    });
    const startAgentRun = vi.fn(async (input: StartAgentRunInput) => ({
      protocolVersion: 1,
      run: {
        id: input.runId ?? "run-generated",
        nodeId: input.nodeId,
        sessionId: input.sessionId,
        projectRoot: input.projectRoot,
        worktreePath: input.worktreePath,
        agentKind: input.agentKind,
        status: "running",
        startedAt: "2026-06-10T00:00:00.000Z",
      } satisfies AgentRun,
    }));
    const getRunEvents = vi.fn(async () => ({
      protocolVersion: 1,
      events: terminal
        ? [
            event(node.runId, 1, "output", { text: intentText }),
            event(node.runId, 2, "evidence", {
              exitCode: 0,
              checks: [{ kind: "run-exit", name: "Hermes CLI exit", status: "passed", detail: "exit 0" }],
            }),
            event(node.runId, 3, "status", { status: "succeeded", exitCode: 0 }),
          ]
        : [event(node.runId, 1, "output", { text: intentText })],
    }));
    const getRunEvidence = vi.fn(async () => ({
      protocolVersion: 1,
      evidence: terminal
        ? {
            runId: node.runId,
            status: "succeeded",
            exitCode: 0,
            changesetId: null,
            checks: [{ kind: "run-exit", name: "Hermes CLI exit", status: "passed", detail: "exit 0" }],
            artifacts: [],
            review: null,
            errorReason: null,
            cancelReason: null,
            completedAt: "2026-06-10T00:00:03.000Z",
          } satisfies RunEvidence
        : {
            runId: node.runId,
            status: "running",
            exitCode: null,
            changesetId: null,
            checks: [],
            artifacts: [],
            review: null,
            errorReason: null,
            cancelReason: null,
            completedAt: null,
          } satisfies RunEvidence,
    }));
    const projectedSession: CanvasSession = {
      ...session,
      nodes: [
        ...session.nodes,
        makeNode({
          id: "lane-implementation",
          agent: "codex",
          status: "running",
          runId: "run-session-1-lane-implementation",
          meta: ["implementation", "lane-implementation", "flow-kernel"],
        }),
      ],
    };
    const applyWorkflowIntent = vi.fn(async () => ({
      protocolVersion: 1,
      result: { ok: true },
      projection: {},
      canvasSession: session,
    }));
    const scheduleWorkflowReadyLanes = vi.fn(async () => ({
      protocolVersion: 1,
      result: { readyLanes: [{ id: "lane-implementation" }] },
      projection: {},
      canvasSession: projectedSession,
    }));
    const recordWorkflowRunResult = vi.fn(async () => ({
      protocolVersion: 1,
      projection: {},
      canvasSession: session,
    }));
    vi.stubGlobal("window", {
      devflow: {
        startAgentRun,
        getRunEvents,
        getRunEvidence,
        applyWorkflowIntent,
        scheduleWorkflowReadyLanes,
        recordWorkflowRunResult,
      },
    });

    try {
      const started = await startBridgeRun(project, session, node);
      expect(started?.workflowSession).toBeNull();
      expect(applyWorkflowIntent).not.toHaveBeenCalled();
      expect(scheduleWorkflowReadyLanes).not.toHaveBeenCalled();

      terminal = true;
      const result = await persistCompletedBridgeRunResult(project, session, node);

      expect(applyWorkflowIntent).toHaveBeenCalledWith(
        project.rootPath,
        expect.objectContaining({ intentId: "intent-terminal-1" }),
      );
      expect(scheduleWorkflowReadyLanes).toHaveBeenCalledWith(project.rootPath, session.id, {
        allowedParallelism: 1,
        now: "2026-06-10T00:00:03.000Z",
      });
      expect(recordWorkflowRunResult).toHaveBeenCalledWith(project.rootPath, {
        sessionId: session.id,
        laneId: node.id,
        segmentId: `segment-${session.id}-${node.id}`,
        runId: node.runId,
        agentKind: node.agent,
        now: "2026-06-10T00:00:03.000Z",
      });
      expect(result?.workflowSession?.nodes.map((item) => item.id)).toContain("lane-implementation");
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it.each([
    ["planner root", "node-1", "hermes", "succeeded", "completed"],
    ["planner root", "node-1", "hermes", "failed", "failed"],
    ["planner root", "node-1", "hermes", "cancelled", "failed"],
    ["planner root", "node-1", "hermes", "timed-out", "failed"],
    ["executor node", "lane-implementation", "codex", "succeeded", "completed"],
    ["executor node", "lane-implementation", "codex", "failed", "failed"],
    ["executor node", "lane-implementation", "codex", "cancelled", "failed"],
    ["executor node", "lane-implementation", "codex", "timed-out", "failed"],
  ] as const)(
    "keeps %s status from terminal run evidence instead of stale optimistic session state on %s",
    (_label, nodeId, agentKind, runStatus, expectedStatus) => {
      const executor = makeNode({
        id: "lane-implementation",
        agent: "codex",
        status: "running",
        runId: "run-session-1-lane-implementation",
        meta: ["implementation", "lane-implementation", "flow-kernel"],
      });
      const session = makeSession([executor]);
      const runId = nodeId === "node-1" ? "run-session-1-node-1" : "run-session-1-lane-implementation";
      const staleOptimisticSession: CanvasSession = {
        ...session,
        nodes: session.nodes.map((node) =>
          node.id === nodeId
            ? {
                ...node,
                status: "running",
                progress: "Optimistic local state",
                runtime: { phase: "Executing", message: "Optimistic local state", action: "running" },
              }
            : node,
        ),
      };
      const evidence = runEvidenceFor(runId, runStatus);

      const next = applyBridgeRunResult(makeWorkspace([executor]), {
        run: {
          id: runId,
          nodeId,
          sessionId: session.id,
          projectRoot: "/tmp/project",
          worktreePath: "/tmp/project",
          agentKind,
          status: runStatus,
          startedAt: "2026-06-10T00:00:00.000Z",
          endedAt: "2026-06-10T00:00:01.000Z",
        },
        events: runEventsForEvidence(runId, evidence),
        evidence,
        workflowSession: staleOptimisticSession,
      });

      const nextSession = next.sessions[0] as CanvasSession;
      const node = nextSession.nodes.find((candidate) => candidate.id === nodeId);
      expect(node?.status).toBe(expectedStatus);
      expect(next.runEvidence[runId]?.status).toBe(runStatus);
    },
  );

  it("claims completed bridge run persistence once per run", () => {
    const workspace = makeWorkspace();
    const claims = new Set<string>();
    const evidenceEvent = event("run-session-1-node-1", 2, "evidence", {
      exitCode: 0,
      checks: [{ kind: "run-exit", name: "Hermes CLI exit", status: "passed", detail: "exit 0" }],
    });
    const terminalEvent = event("run-session-1-node-1", 3, "status", {
      status: "succeeded",
      exitCode: 0,
    });

    expect(claimCompletedBridgeRunPersistence(workspace, evidenceEvent, claims)).toBeNull();
    expect(claims.size).toBe(0);

    const first = claimCompletedBridgeRunPersistence(workspace, terminalEvent, claims);
    const duplicate = claimCompletedBridgeRunPersistence(workspace, terminalEvent, claims);

    expect(first?.node.id).toBe("node-1");
    expect(duplicate).toBeNull();
    expect(claims.has("run-session-1-node-1")).toBe(true);
  });

  it("incrementally projects multiple Hermes WorkflowIntent output events", () => {
    const workspace = makeWorkspace();
    const hermesRunId = "run-session-1-node-1";
    const first = event(hermesRunId, 1, "output", {
      text: JSON.stringify({
        intentId: "intent-incremental-1",
        sessionId: "session-1",
        operations: [
          {
            type: "ProposeLanes",
            lanes: [
              {
                id: "lane-implementation",
                semanticKey: "dynamic:implementation",
                kind: "implementation",
                title: "Implement streaming canvas",
                agentKind: "codex",
              },
            ],
          },
        ],
      }),
    });
    const second = event(hermesRunId, 2, "output", {
      text: JSON.stringify({
        intentId: "intent-incremental-2",
        sessionId: "session-1",
        operations: [
          {
            type: "ProposeLanes",
            lanes: [
              {
                id: "lane-validation",
                semanticKey: "dynamic:validation",
                kind: "validation",
                title: "Validate streaming canvas",
                agentKind: "codex",
                dependsOn: ["lane-implementation"],
              },
            ],
          },
        ],
      }),
    });

    const afterFirst = mergeRunEventsIntoWorkspace(workspace, hermesRunId, [first]);
    const afterSecond = mergeRunEventsIntoWorkspace(afterFirst, hermesRunId, [first, second]);
    const session = afterSecond.sessions[0] as CanvasSession;

    expect(session.nodes.map((node) => node.id)).toEqual([
      "node-1",
      "lane-implementation",
      "lane-validation",
    ]);
    expect(session.edges).toContainEqual({
      id: "edge-implementation-validation",
      source: "lane-implementation",
      target: "lane-validation",
    });
  });

  it("projects a WorkflowIntent split across output events", () => {
    const workspace = makeWorkspace();
    const hermesRunId = "run-session-1-node-1";

    const next = mergeRunEventsIntoWorkspace(workspace, hermesRunId, [
      event(hermesRunId, 1, "output", {
        text: '{"intentId":"intent-split-1","sessionId":"session-1","operations":[',
      }),
      event(hermesRunId, 2, "output", {
        text: JSON.stringify({
          type: "ProposeLanes",
          lanes: [
            {
              id: "lane-implementation",
              semanticKey: "dynamic:implementation",
              kind: "implementation",
              title: "Implement streamed intent parsing",
              agentKind: "codex",
            },
          ],
        }).concat("]}"),
      }),
    ]);

    const session = next.sessions[0] as CanvasSession;
    expect(session.nodes.map((node) => node.id)).toEqual(["node-1", "lane-implementation"]);
  });

  it("preserves existing lane positions when Hermes projection is replayed", () => {
    const workspace = makeWorkspace();
    const hermesRunId = "run-session-1-node-1";
    const first = event(hermesRunId, 1, "output", {
      text: JSON.stringify({
        intentId: "intent-position-1",
        sessionId: "session-1",
        operations: [
          {
            type: "ProposeLanes",
            lanes: [
              {
                id: "lane-implementation",
                semanticKey: "dynamic:implementation",
                kind: "implementation",
                title: "Implement position persistence",
                agentKind: "codex",
              },
            ],
          },
        ],
      }),
    });
    const second = event(hermesRunId, 2, "output", {
      text: JSON.stringify({
        intentId: "intent-position-2",
        sessionId: "session-1",
        operations: [
          {
            type: "ProposeLanes",
            lanes: [
              {
                id: "lane-validation",
                semanticKey: "dynamic:validation",
                kind: "validation",
                title: "Validate position persistence",
                agentKind: "codex",
                dependsOn: ["lane-implementation"],
              },
            ],
          },
        ],
      }),
    });
    const afterFirst = mergeRunEventsIntoWorkspace(workspace, hermesRunId, [first]);
    const firstSession = afterFirst.sessions[0] as CanvasSession;
    const movedSession: CanvasSession = {
      ...firstSession,
      nodes: firstSession.nodes.map((node) =>
        node.id === "lane-implementation" ? { ...node, position: { x: 777, y: 222 } } : node,
      ),
    };
    const movedWorkspace: WorkspaceState = {
      ...afterFirst,
      sessions: [movedSession],
    };

    const afterSecond = mergeRunEventsIntoWorkspace(movedWorkspace, hermesRunId, [first, second]);
    const session = afterSecond.sessions[0] as CanvasSession;

    expect(session.nodes.find((node) => node.id === "lane-implementation")?.position).toEqual({ x: 777, y: 222 });
    expect(session.nodes.find((node) => node.id === "lane-validation")?.position.x).toBeGreaterThan(400);
  });

  it("projects and restores Hermes user decision requests as canvas nodes", () => {
    const workspace = makeWorkspace();
    const hermesRunId = "run-session-1-node-1";

    const withDecision = mergeRunEventsIntoWorkspace(workspace, hermesRunId, [
      event(hermesRunId, 1, "output", {
        text: JSON.stringify({
          intentId: "intent-decision-1",
          sessionId: "session-1",
          operations: [
            {
              type: "RequestUserDecision",
              decisionId: "decision-architecture-risk",
              prompt: "Backtrack or continue?",
              options: ["Backtrack", "Continue"],
              reason: "Earlier design may be wrong.",
              targetLaneId: "lane-implementation",
            },
          ],
        }),
      }),
    ]);
    const decisionSession = withDecision.sessions[0] as CanvasSession;
    const decisionNode = decisionSession.nodes.find((node) => node.id === "decision-architecture-risk");

    expect(decisionNode).toMatchObject({
      nodeKind: "user_decision",
      executable: false,
      userDecision: {
        decisionId: "decision-architecture-risk",
        status: "waiting_input",
        options: ["Backtrack", "Continue"],
      },
    });

    const withLanes = mergeRunEventsIntoWorkspace(withDecision, hermesRunId, [
      event(hermesRunId, 2, "output", {
        text: JSON.stringify({
          intentId: "intent-lanes-after-decision",
          sessionId: "session-1",
          operations: [
            {
              type: "ProposeLanes",
              lanes: [
                {
                  id: "lane-implementation",
                  semanticKey: "dynamic:implementation",
                  kind: "implementation",
                  title: "Implement fix",
                  agentKind: "codex",
                },
              ],
            },
          ],
        }),
      }),
    ]);
    const restoredSession = withLanes.sessions[0] as CanvasSession;

    expect(restoredSession.nodes.map((node) => node.id)).toEqual([
      "node-1",
      "lane-implementation",
      "decision-architecture-risk",
    ]);
    expect(restoredSession.nodes.find((node) => node.id === "decision-architecture-risk")?.nodeKind).toBe(
      "user_decision",
    );
  });

  it("starts the next Flow Kernel lane only after dependencies have evidence", () => {
    const workspace = makeWorkspace();
    const hermesRunId = "run-session-1-node-1";

    const afterPlanner = mergeRunEventsIntoWorkspace(workspace, hermesRunId, [
      event(hermesRunId, 1, "output", {
        text: JSON.stringify({
          intentId: "intent-code-change-1",
          sessionId: "session-1",
          operations: [
            {
              type: "AnalyzeRequirement",
              requirement:
                "In this git repository, update src/tasks.js and add node:test coverage for listTasks status filtering.",
            },
            { type: "DiscoverProject", profile: { languages: ["javascript"], capabilities: [] } },
            { type: "ProposeLanes" },
          ],
        }),
      }),
      event(hermesRunId, 2, "evidence", {
        exitCode: 0,
        checks: [{ kind: "run-exit", name: "Hermes CLI exit", status: "passed", detail: "exit 0" }],
      }),
      event(hermesRunId, 3, "status", {
        status: "succeeded",
        exitCode: 0,
      }),
    ]);

    const session = afterPlanner.sessions[0] as CanvasSession;
    expect(session.nodes.find((node) => node.id === "lane-implementation")?.status).toBe("running");
    expect(session.nodes.find((node) => node.id === "lane-validation")?.status).toBe("pending");

    const implementationRunId = "run-session-1-lane-implementation";
    const afterImplementation = mergeRunEventsIntoWorkspace(afterPlanner, implementationRunId, [
      event(implementationRunId, 1, "output", {
        text: "Implemented status filtering with tests.",
      }),
      event(implementationRunId, 2, "evidence", {
        exitCode: 0,
        checks: [{ kind: "run-exit", name: "Codex CLI exit", status: "passed", detail: "exit 0" }],
      }),
      event(implementationRunId, 3, "status", {
        status: "succeeded",
        exitCode: 0,
      }),
    ]);

    const nextSession = afterImplementation.sessions[0] as CanvasSession;
    expect(nextSession.nodes.find((node) => node.id === "lane-implementation")?.status).toBe("completed");
    expect(nextSession.nodes.find((node) => node.id === "lane-validation")?.status).toBe("running");
    expect(nextSession.nodes.find((node) => node.id === "lane-review")?.status).toBe("pending");
  });

  it("uses WorkflowIntent prompts only for the planner Hermes node", () => {
    const session = makeSession([
      makeNode({
        id: "lane-validation",
        agent: "codex",
        status: "completed",
        runId: "run-session-1-lane-validation",
        brief: "Run tests",
        meta: ["validation", "lane-validation", "flow-kernel"],
        output: ["npm test passed: 2 pass, 0 fail."],
      }),
      makeNode({
        id: "lane-review",
        agent: "hermes",
        status: "running",
        runId: "run-session-1-lane-review",
        brief: "Review code evidence",
        meta: ["review", "lane-review", "flow-kernel"],
        dependencies: ["lane-validation"],
      }),
    ]);
    const review = session.nodes.find((node) => node.id === "lane-review");

    const prompt = buildPromptForNodeRun(session, review!);

    expect(prompt).toContain("Task: Review code evidence");
    expect(prompt).toContain("Dependency lane-validation");
    expect(prompt).toContain("Read-only review lane");
    expect(prompt).toContain("do not create commits");
    expect(prompt).toContain("Codex commit lane owns any commit");
    expect(prompt).not.toContain("You are Hermes-agent planning a SkyTurn workflow intent.");
    expect(prompt).not.toContain("WorkflowIntent");
  });

  it("keeps implementation prompts out of browser screenshot and persistent server work", () => {
    const session = makeSession([
      makeNode({
        id: "lane-implementation",
        agent: "codex",
        status: "running",
        runId: "run-session-1-lane-implementation",
        brief: "Implement the status screen",
        meta: ["implementation", "lane-implementation", "flow-kernel"],
      }),
    ]);
    const implementation = session.nodes.find((node) => node.id === "lane-implementation");

    const prompt = buildPromptForNodeRun(session, implementation!);

    expect(prompt).toContain("Do not capture browser screenshots in this lane");
    expect(prompt).toContain("Do not start persistent dev servers");
  });

  it("tells browser screenshot lanes to stop any temporary dev server before exiting", () => {
    const session = makeSession([
      makeNode({
        id: "lane-browser",
        agent: "codex",
        status: "running",
        runId: "run-session-1-lane-browser",
        brief: "Capture browser screenshot evidence",
        meta: ["browser_screenshot_validation", "lane-browser", "flow-kernel"],
      }),
    ]);
    const browser = session.nodes.find((node) => node.id === "lane-browser");

    const prompt = buildPromptForNodeRun(session, browser!);

    expect(prompt).toContain("Capture browser screenshot evidence");
    expect(prompt).toContain("node scripts/capture-screenshot.mjs .devflow/acceptance/react-app.png");
    expect(prompt).toContain("Stop any dev server before exiting");
    expect(prompt).toContain("Do not create a git commit in this lane");
    expect(prompt).toContain("the commit lane owns commits");
  });

  it("passes review evidence and repo-scoped scan guidance into commit lane prompts", () => {
    const session = makeSession([
      makeNode({
        id: "lane-review",
        agent: "hermes",
        status: "completed",
        runId: "run-session-1-lane-review",
        brief: "Review code evidence",
        meta: ["review", "lane-review", "flow-kernel"],
        output: ["Blockers:", "- `status` must be checked with `status !== undefined` before commit."],
      }),
      makeNode({
        id: "lane-commit",
        agent: "codex",
        status: "running",
        runId: "run-session-1-lane-commit",
        brief: "Commit verified change",
        title: "Commit the verified SkyTurn delivery status screen change",
        meta: ["commit", "lane-commit", "flow-kernel"],
        dependencies: ["lane-review"],
      }),
    ]);
    const commit = session.nodes.find((node) => node.id === "lane-commit");

    const prompt = buildPromptForNodeRun(session, commit!);

    expect(prompt).toContain("Dependency lane-review");
    expect(prompt).toContain("status !== undefined");
    expect(prompt).toContain("do not commit a known blocker");
    expect(prompt).toContain("Do not run broad parent-directory scans such as `find ..`");
    expect(prompt).toContain("If git add, git commit, or verification fails");
    expect(prompt).toContain("Do not stage `.devflow/`");
    expect(prompt).not.toContain("Do not create a git commit in this lane");
  });

  it("creates a fresh run evidence path when retrying a node", () => {
    const session = makeSession([
      makeNode({
        id: "lane-implementation",
        agent: "codex",
        status: "failed",
        runId: "run-session-1-lane-implementation",
        meta: ["implementation", "lane-implementation", "flow-kernel"],
        output: ["Previous attempt failed."],
      }),
    ]);

    const next = retryCanvasNode(session, "lane-implementation", "2026-06-14T04:05:06.000Z");
    const retried = next.nodes.find((node) => node.id === "lane-implementation");

    expect(retried?.status).toBe("retrying");
    expect(retried?.runId).toBe("run-session-1-lane-implementation-attempt-20260614040506");
    expect(retried?.changesetId).toBe("changeset-run-session-1-lane-implementation-attempt-20260614040506");
    expect(retried?.output).toContain("Retry requested from run-session-1-lane-implementation.");
    expect(next.activeNodeId).toBe("lane-implementation");
  });

  it("scopes Codex sandbox permissions by Flow Kernel lane", async () => {
    const project = makeWorkspace().projects[0] as ImportedProject;
    const session = makeSession([
      makeNode({
        id: "lane-implementation",
        agent: "codex",
        status: "running",
        runId: "run-session-1-lane-implementation",
        meta: ["implementation", "lane-implementation", "flow-kernel"],
      }),
      makeNode({
        id: "lane-validation",
        agent: "codex",
        status: "running",
        runId: "run-session-1-lane-validation",
        meta: ["validation", "lane-validation", "flow-kernel"],
      }),
      makeNode({
        id: "lane-browser",
        agent: "codex",
        status: "running",
        runId: "run-session-1-lane-browser",
        meta: ["browser_screenshot_validation", "lane-browser", "flow-kernel"],
        requiredEvidence: ["browser", "screenshot"],
      }),
      makeNode({
        id: "lane-commit",
        agent: "codex",
        status: "running",
        runId: "run-session-1-lane-commit",
        meta: ["commit", "lane-commit", "flow-kernel"],
      }),
    ]);
    const startAgentRun = vi.fn(async (input: StartAgentRunInput) => ({
      protocolVersion: 1,
      run: {
        id: input.runId ?? "run-generated",
        nodeId: input.nodeId,
        sessionId: input.sessionId,
        projectRoot: input.projectRoot,
        worktreePath: input.worktreePath,
        agentKind: input.agentKind,
        status: "succeeded",
        startedAt: "2026-06-10T00:00:00.000Z",
      } satisfies AgentRun,
    }));
    const getRunEvents = vi.fn(async () => ({ protocolVersion: 1, events: [] }));
    const getRunEvidence = vi.fn(async () => ({
      protocolVersion: 1,
      evidence: {
        runId: "run-session-1",
        status: "succeeded",
        exitCode: 0,
        changesetId: null,
        checks: [],
        artifacts: [],
        review: null,
        errorReason: null,
        cancelReason: null,
        completedAt: "2026-06-10T00:00:00.000Z",
      } satisfies RunEvidence,
    }));
    vi.stubGlobal("window", {
      devflow: {
        startAgentRun,
        getRunEvents,
        getRunEvidence,
      },
    });

    try {
      for (const node of session.nodes.filter((node) => node.agent === "codex")) {
        await startBridgeRun(project, session, node);
      }
    } finally {
      vi.unstubAllGlobals();
    }

    expect(startAgentRun.mock.calls.map(([input]) => input.sandbox)).toEqual([
      "workspace-write",
      undefined,
      "danger-full-access",
      "danger-full-access",
    ]);
    expect(startAgentRun.mock.calls.map(([input]) => input.expectedArtifacts)).toEqual([
      undefined,
      undefined,
      [".devflow/acceptance/react-app.png"],
      undefined,
    ]);
  });

  it("runs current-branch sessions in the project root even when node metadata has a candidate path", async () => {
    const project = makeWorkspace().projects[0] as ImportedProject;
    const session = {
      ...makeSession([
        makeNode({
          id: "lane-implementation",
          agent: "codex",
          status: "running",
          runId: "run-session-1-lane-implementation",
          meta: ["implementation", "lane-implementation", "flow-kernel"],
        }),
      ]),
      target: {
        executionTarget: "current_branch" as const,
        selectedBranch: "feature/session-target",
      },
    };
    const node = {
      ...(session.nodes.find((item) => item.id === "lane-implementation") as CanvasNode),
      worktree: {
        path: "/tmp/project.worktrees/session-1-lane-implementation",
        branchName: "feature/session-target",
        baseCommit: "feature/session-target",
        executionTarget: "current_branch" as const,
        selectedBranch: "feature/session-target",
      },
    };
    const startAgentRun = vi.fn(async (input: StartAgentRunInput) => ({
      protocolVersion: 1,
      run: {
        id: input.runId ?? "run-generated",
        nodeId: input.nodeId,
        sessionId: input.sessionId,
        projectRoot: input.projectRoot,
        worktreePath: input.worktreePath,
        agentKind: input.agentKind,
        status: "running",
        startedAt: "2026-06-10T00:00:00.000Z",
      } satisfies AgentRun,
    }));
    const getRunEvents = vi.fn(async () => ({ protocolVersion: 1, events: [] }));
    const getRunEvidence = vi.fn(async () => ({
      protocolVersion: 1,
      evidence: {
        runId: node.runId,
        status: "running",
        exitCode: null,
        changesetId: null,
        checks: [],
        artifacts: [],
        review: null,
        errorReason: null,
        cancelReason: null,
        completedAt: null,
      } satisfies RunEvidence,
    }));
    vi.stubGlobal("window", {
      devflow: {
        startAgentRun,
        getRunEvents,
        getRunEvidence,
      },
    });

    try {
      await startBridgeRun(project, session, node);
    } finally {
      vi.unstubAllGlobals();
    }

    expect(startAgentRun).toHaveBeenCalledWith(expect.objectContaining({
      projectRoot: project.rootPath,
      worktreePath: project.rootPath,
    }));
  });

  it("creates and binds a managed worktree before starting new-worktree Codex runs", async () => {
    const project = makeWorkspace().projects[0] as ImportedProject;
    const session = {
      ...makeSession([
        makeNode({
          id: "lane-implementation",
          agent: "codex",
          status: "running",
          runId: "run-session-1-lane-implementation",
          meta: ["implementation", "lane-implementation", "flow-kernel"],
        }),
      ]),
      target: {
        executionTarget: "new_worktree" as const,
        selectedBranch: "main",
        baseRef: "origin/main",
      },
    };
    const node = {
      ...(session.nodes.find((item) => item.id === "lane-implementation") as CanvasNode),
      worktree: {
        path: ".",
        branchName: "main",
        baseCommit: "origin/main",
        executionTarget: "new_worktree" as const,
        selectedBranch: "main",
        baseRef: "origin/main",
        baselineRef: "origin/main",
        worktreeId: "worktree-session-1-lane-implementation",
        variantId: "lane-implementation",
      },
    };
    const createdWorktreePath = "/tmp/project.worktrees/session-session-1-variant-lane-implementation";
    const createWorktree = vi.fn(async () => ({
      protocolVersion: 1,
      status: "created" as const,
      event: {},
      worktree: {
        worktreeId: "worktree-session-1-lane-implementation",
        variantId: "lane-implementation",
        path: createdWorktreePath,
        realPath: createdWorktreePath,
        gitdir: "/tmp/project/.git/worktrees/session-session-1-variant-lane-implementation",
        repoRoot: project.rootPath,
        branchName: "skyturn/session-1/lane-implementation",
        baseCommit: "abc123",
        headCommit: "abc123",
        parentLaneId: "lane-implementation",
      },
    }));
    const startAgentRun = vi.fn(async (input: StartAgentRunInput) => ({
      protocolVersion: 1,
      run: {
        id: input.runId ?? "run-generated",
        nodeId: input.nodeId,
        sessionId: input.sessionId,
        projectRoot: input.projectRoot,
        worktreePath: input.worktreePath,
        agentKind: input.agentKind,
        status: "running",
        startedAt: "2026-06-10T00:00:00.000Z",
      } satisfies AgentRun,
    }));
    const getRunEvents = vi.fn(async () => ({ protocolVersion: 1, events: [] }));
    const getRunEvidence = vi.fn(async () => ({
      protocolVersion: 1,
      evidence: {
        runId: node.runId,
        status: "running",
        exitCode: null,
        changesetId: null,
        checks: [],
        artifacts: [],
        review: null,
        errorReason: null,
        cancelReason: null,
        completedAt: null,
      } satisfies RunEvidence,
    }));
    vi.stubGlobal("window", {
      devflow: {
        workflow: { createWorktree },
        startAgentRun,
        getRunEvents,
        getRunEvidence,
      },
    });

    try {
      const result = await startBridgeRun(project, session, node);
      expect(result?.run.worktreePath).toBe(createdWorktreePath);
      expect(createWorktree).toHaveBeenCalledWith(project.rootPath, expect.objectContaining({
        sessionId: session.id,
        variantId: "lane-implementation",
        baseRef: "origin/main",
        parentLaneId: "lane-implementation",
        repoRoot: project.rootPath,
      }));
      expect(startAgentRun).toHaveBeenCalledWith(expect.objectContaining({
        projectRoot: project.rootPath,
        worktreePath: createdWorktreePath,
      }));
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("creates and binds a managed worktree before starting non-planner Hermes runs", async () => {
    const project = makeWorkspace().projects[0] as ImportedProject;
    const session = {
      ...makeSession([
        makeNode({
          id: "lane-review",
          agent: "hermes",
          status: "running",
          runId: "run-session-1-lane-review",
          meta: ["review", "lane-review", "flow-kernel"],
        }),
      ]),
      target: {
        executionTarget: "new_worktree" as const,
        selectedBranch: "main",
        baseRef: "origin/main",
      },
    };
    const node = {
      ...(session.nodes.find((item) => item.id === "lane-review") as CanvasNode),
      worktree: {
        path: ".",
        branchName: "main",
        baseCommit: "origin/main",
        executionTarget: "new_worktree" as const,
        selectedBranch: "main",
        baseRef: "origin/main",
        baselineRef: "origin/main",
        worktreeId: "worktree-session-1-lane-review",
        variantId: "lane-review",
      },
    };
    const createdWorktreePath = "/tmp/project.worktrees/session-session-1-variant-lane-review";
    const createWorktree = vi.fn(async () => ({
      protocolVersion: 1,
      status: "created" as const,
      event: {},
      worktree: {
        worktreeId: "worktree-session-1-lane-review",
        variantId: "lane-review",
        path: createdWorktreePath,
        realPath: createdWorktreePath,
        gitdir: "/tmp/project/.git/worktrees/session-session-1-variant-lane-review",
        repoRoot: project.rootPath,
        branchName: "skyturn/session-1/lane-review",
        baseCommit: "abc123",
        headCommit: "abc123",
        parentLaneId: "lane-review",
      },
    }));
    const startAgentRun = vi.fn(async (input: StartAgentRunInput) => ({
      protocolVersion: 1,
      run: {
        id: input.runId ?? "run-generated",
        nodeId: input.nodeId,
        sessionId: input.sessionId,
        projectRoot: input.projectRoot,
        worktreePath: input.worktreePath,
        agentKind: input.agentKind,
        status: "running",
        startedAt: "2026-06-10T00:00:00.000Z",
      } satisfies AgentRun,
    }));
    const getRunEvents = vi.fn(async () => ({ protocolVersion: 1, events: [] }));
    const getRunEvidence = vi.fn(async () => ({
      protocolVersion: 1,
      evidence: {
        runId: node.runId,
        status: "running",
        exitCode: null,
        changesetId: null,
        checks: [],
        artifacts: [],
        review: null,
        errorReason: null,
        cancelReason: null,
        completedAt: null,
      } satisfies RunEvidence,
    }));
    vi.stubGlobal("window", {
      devflow: {
        workflow: { createWorktree },
        startAgentRun,
        getRunEvents,
        getRunEvidence,
      },
    });

    try {
      await startBridgeRun(project, session, node);
      expect(createWorktree).toHaveBeenCalledWith(project.rootPath, expect.objectContaining({
        variantId: "lane-review",
        parentLaneId: "lane-review",
      }));
      expect(startAgentRun).toHaveBeenCalledWith(expect.objectContaining({
        agentKind: "hermes",
        worktreePath: createdWorktreePath,
      }));
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("records Flow Kernel run results by identifier and leaves evidence ownership in Electron main", async () => {
    const project = makeWorkspace().projects[0] as ImportedProject;
    const session = makeSession([
      makeNode({
        id: "lane-implementation",
        agent: "codex",
        status: "running",
        runId: "run-session-1-lane-implementation",
        meta: ["implementation", "lane-implementation", "flow-kernel"],
      }),
    ]);
    const node = session.nodes.find((item) => item.id === "lane-implementation") as CanvasNode;
    const startAgentRun = vi.fn(async (input: StartAgentRunInput) => ({
      protocolVersion: 1,
      run: {
        id: input.runId ?? "run-generated",
        nodeId: input.nodeId,
        sessionId: input.sessionId,
        projectRoot: input.projectRoot,
        worktreePath: input.worktreePath,
        agentKind: input.agentKind,
        status: "succeeded",
        startedAt: "2026-06-10T00:00:00.000Z",
      } satisfies AgentRun,
    }));
    const getRunEvents = vi.fn(async () => ({
      protocolVersion: 1,
      events: [event(node.runId, 1, "output", { text: "renderer sees output but does not own ledger evidence" })],
    }));
    const getRunEvidence = vi.fn(async () => ({
      protocolVersion: 1,
      evidence: {
        runId: node.runId,
        status: "succeeded",
        exitCode: 0,
        changesetId: "changeset-implementation-1",
        checks: [{ kind: "test", name: "pnpm test", status: "passed", detail: "2 passed" }],
        artifacts: [],
        review: null,
        errorReason: null,
        cancelReason: null,
        completedAt: "2026-06-10T00:00:01.000Z",
      } satisfies RunEvidence,
    }));
    const recordWorkflowRunResult = vi.fn(async () => ({
      protocolVersion: 1,
      projection: {},
      canvasSession: session,
    }));
    const scheduleWorkflowReadyLanes = vi.fn(async () => ({
      protocolVersion: 1,
      result: { readyLanes: [] },
      projection: {},
      canvasSession: session,
    }));
    vi.stubGlobal("window", {
      devflow: {
        startAgentRun,
        getRunEvents,
        getRunEvidence,
        recordWorkflowRunResult,
        scheduleWorkflowReadyLanes,
      },
    });

    try {
      await startBridgeRun(project, session, node);

      expect(recordWorkflowRunResult).toHaveBeenCalledWith(project.rootPath, {
        sessionId: session.id,
        laneId: node.id,
        segmentId: `segment-${session.id}-${node.id}`,
        runId: node.runId,
        agentKind: node.agent,
        now: "2026-06-10T00:00:01.000Z",
      });
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("keeps backend artifact failure authoritative for a non-browser validation lane across reopen", async () => {
    const project = makeWorkspace().projects[0] as ImportedProject;
    const artifactNode = Object.assign(makeNode({
      id: "lane-artifact",
      agent: "codex",
      status: "running",
      runId: "run-session-1-lane-artifact",
      title: "Validate release package",
      meta: ["validation", "lane-artifact", "flow-kernel"],
    }), { requiredEvidence: ["artifact"] });
    const downstreamNode = makeNode({
      id: "lane-review",
      agent: "hermes",
      status: "pending",
      runId: "run-session-1-lane-review",
      title: "Review validation",
      meta: ["review", "lane-review", "flow-kernel"],
      dependencies: [artifactNode.id],
    });
    const session: CanvasSession = {
      ...makeSession([artifactNode, downstreamNode]),
      edges: [{ id: "edge-artifact-review", source: artifactNode.id, target: downstreamNode.id }],
    };
    const backendFailedSession: CanvasSession = {
      ...session,
      activeNodeId: null,
      nodes: session.nodes.map((node) =>
        node.id === artifactNode.id || node.id === downstreamNode.id
          ? { ...node, status: "failed" as const }
          : node,
      ),
    };
    const evidence = {
      runId: artifactNode.runId,
      status: "succeeded",
      exitCode: 0,
      changesetId: null,
      checks: [{ kind: "run-exit", name: "Codex CLI exit", status: "passed" }],
      artifacts: [],
      review: null,
      errorReason: null,
      cancelReason: null,
      completedAt: "2026-06-10T00:00:01.000Z",
    } satisfies RunEvidence;
    const recordWorkflowRunResult = vi.fn(async () => ({
      protocolVersion: 1,
      projection: {},
      canvasSession: backendFailedSession,
    }));
    const scheduleWorkflowReadyLanes = vi.fn(async () => ({
      protocolVersion: 1,
      result: { readyLanes: [] },
      projection: {},
      canvasSession: backendFailedSession,
    }));
    vi.stubGlobal("window", {
      devflow: {
        getRunEvents: vi.fn(async () => ({ protocolVersion: 1, events: [] })),
        getRunEvidence: vi.fn(async () => ({ protocolVersion: 1, evidence })),
        recordWorkflowRunResult,
        scheduleWorkflowReadyLanes,
      },
    });

    try {
      const result = await persistCompletedBridgeRunResult(project, session, artifactNode);
      const reopened = await persistCompletedBridgeRunResult(
        project,
        result?.workflowSession ?? backendFailedSession,
        (result?.workflowSession ?? backendFailedSession).nodes.find((node) => node.id === artifactNode.id)!,
      );

      for (const materialized of [result?.workflowSession, reopened?.workflowSession]) {
        expect(materialized?.nodes.find((node) => node.id === artifactNode.id)?.status).toBe("failed");
        expect(materialized?.nodes.find((node) => node.id === downstreamNode.id)?.status).toBe("failed");
        expect(materialized?.nodes.find((node) => node.id === artifactNode.id)).toMatchObject({
          requiredEvidence: ["artifact"],
        });
      }
      expect(scheduleWorkflowReadyLanes).toHaveBeenCalledTimes(2);
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it.each(["codex", "hermes"] as const)("does not launch a generic %s artifact contract without a concrete declaration", async (agent) => {
    const project = makeWorkspace().projects[0] as ImportedProject;
    const node = Object.assign(makeNode({
      id: "lane-artifact",
      agent,
      status: "running",
      runId: "run-session-1-lane-artifact",
      title: "Validate release package",
      meta: ["validation", "lane-artifact", "flow-kernel"],
    }), { requiredEvidence: ["artifact"] });
    const session = makeSession([node]);
    const startAgentRun = vi.fn(async () => null);
    vi.stubGlobal("window", { devflow: { startAgentRun } });

    try {
      expect(await startBridgeRun(project, session, node)).toBeNull();
      expect(startAgentRun).not.toHaveBeenCalled();
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it.each(["codex", "hermes"] as const)("derives the known %s screenshot declaration from required evidence without text heuristics", async (agent) => {
    const project = makeWorkspace().projects[0] as ImportedProject;
    const node = Object.assign(makeNode({
      id: "lane-visual-check",
      agent,
      status: "running",
      runId: "run-session-1-lane-visual-check",
      title: "Validate release package",
      meta: ["validation", "lane-visual-check", "flow-kernel"],
    }), { requiredEvidence: ["screenshot"] });
    const session = makeSession([node]);
    const startAgentRun = vi.fn(async () => null);
    vi.stubGlobal("window", { devflow: { startAgentRun } });

    try {
      expect(await startBridgeRun(project, session, node)).toBeNull();
      expect(startAgentRun).toHaveBeenCalledWith(expect.objectContaining({
        expectedArtifacts: [".devflow/acceptance/react-app.png"],
      }));
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("records non-planner Hermes Flow Kernel run results without applying WorkflowIntent", async () => {
    const project = makeWorkspace().projects[0] as ImportedProject;
    const session = makeSession([
      makeNode({
        id: "lane-review-static-site",
        agent: "hermes",
        status: "running",
        runId: "run-session-1-lane-review-static-site",
        brief: "Review static site evidence",
        meta: ["review", "lane-review-static-site", "flow-kernel"],
        dependencies: ["lane-validation"],
      }),
    ]);
    const node = session.nodes.find((item) => item.id === "lane-review-static-site") as CanvasNode;
    const startAgentRun = vi.fn(async (input: StartAgentRunInput) => ({
      protocolVersion: 1,
      run: {
        id: input.runId ?? "run-generated",
        nodeId: input.nodeId,
        sessionId: input.sessionId,
        projectRoot: input.projectRoot,
        worktreePath: input.worktreePath,
        agentKind: input.agentKind,
        status: "succeeded",
        startedAt: "2026-06-10T00:00:00.000Z",
      } satisfies AgentRun,
    }));
    const getRunEvents = vi.fn(async () => ({
      protocolVersion: 1,
      events: [event(node.runId, 1, "output", { text: "Review passed with no blockers." })],
    }));
    const getRunEvidence = vi.fn(async () => ({
      protocolVersion: 1,
      evidence: {
        runId: node.runId,
        status: "succeeded",
        exitCode: 0,
        changesetId: null,
        checks: [{ kind: "run-exit", name: "Hermes CLI exit", status: "passed", detail: "exit 0" }],
        artifacts: [],
        review: null,
        errorReason: null,
        cancelReason: null,
        completedAt: "2026-06-10T00:00:01.000Z",
      } satisfies RunEvidence,
    }));
    const recordWorkflowRunResult = vi.fn(async () => ({
      protocolVersion: 1,
      projection: {},
      canvasSession: session,
    }));
    const scheduleWorkflowReadyLanes = vi.fn(async () => ({
      protocolVersion: 1,
      result: { readyLanes: [] },
      projection: {},
      canvasSession: session,
    }));
    const applyWorkflowIntent = vi.fn();
    vi.stubGlobal("window", {
      devflow: {
        startAgentRun,
        getRunEvents,
        getRunEvidence,
        recordWorkflowRunResult,
        scheduleWorkflowReadyLanes,
        applyWorkflowIntent,
      },
    });

    try {
      const result = await startBridgeRun(project, session, node);

      expect(recordWorkflowRunResult).toHaveBeenCalledWith(project.rootPath, {
        sessionId: session.id,
        laneId: node.id,
        segmentId: `segment-${session.id}-${node.id}`,
        runId: node.runId,
        agentKind: "hermes",
        now: "2026-06-10T00:00:01.000Z",
      });
      expect(scheduleWorkflowReadyLanes).toHaveBeenCalledWith(project.rootPath, session.id, {
        allowedParallelism: 1,
        now: "2026-06-10T00:00:01.000Z",
      });
      expect(applyWorkflowIntent).not.toHaveBeenCalled();
      expect(result?.workflowSession?.id).toBe(session.id);
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("refuses to start non-executable workflow projection nodes", async () => {
    const project = makeWorkspace().projects[0] as ImportedProject;
    const decisionNode = makeNode({
      id: "decision-architecture-risk",
      agent: "hermes",
      status: "running",
      runId: "run-session-1-decision-architecture-risk",
      title: "User decision required",
      meta: ["decision", "decision-architecture-risk", "flow-kernel"],
    });
    decisionNode.nodeKind = "user_decision";
    decisionNode.executable = false;
    decisionNode.runtimePolicy = {
      source: "workflow_projection",
      trusted: true,
      executable: false,
      sandbox: "read-only",
      sideEffects: [],
      reason: "Decision nodes are user gates, not agent runs.",
    };
    const session = makeSession([decisionNode]);
    const startAgentRun = vi.fn();
    const getWorkflowLedger = vi.fn();
    vi.stubGlobal("window", {
      devflow: {
        startAgentRun,
        getWorkflowLedger,
      },
    });

    try {
      const result = await startBridgeRun(project, session, decisionNode);

      expect(result).toBeNull();
      expect(startAgentRun).not.toHaveBeenCalled();
      expect(getWorkflowLedger).not.toHaveBeenCalled();
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("prefers trusted projection runtime policy over text heuristics", () => {
    const commitTitledNode = makeNode({
      id: "lane-review",
      agent: "codex",
      status: "pending",
      runId: "run-session-1-lane-review",
      title: "Review before commit",
      meta: ["review", "lane-review", "flow-kernel"],
    });
    const decisionNode = makeNode({
      id: "decision-architecture-risk",
      agent: "codex",
      status: "pending",
      runId: "run-session-1-decision-architecture-risk",
      title: "Commit to parallel worktree?",
    });
    const screenshotNode = makeNode({
      id: "lane-browser-screenshot",
      agent: "codex",
      status: "pending",
      runId: "run-session-1-lane-browser-screenshot",
      title: "Capture browser screenshot evidence",
      meta: ["validation", "lane-browser-screenshot", "flow-kernel"],
    });

    commitTitledNode.runtimePolicy = {
      source: "workflow_projection",
      trusted: true,
      executable: true,
      sandbox: "workspace-write",
      sideEffects: ["filesystem"],
      reason: "Policy is projected by workflow kernel.",
    };
    decisionNode.nodeKind = "user_decision";
    decisionNode.executable = false;
    decisionNode.runtimePolicy = {
      source: "workflow_projection",
      trusted: true,
      executable: false,
      sandbox: "danger-full-access",
      sideEffects: ["git"],
      reason: "Decision node is not executable.",
    };
    screenshotNode.runtimePolicy = {
      source: "workflow_projection",
      trusted: true,
      executable: true,
      sandbox: "read-only",
      sideEffects: [],
      reason: "Policy is projected by workflow kernel.",
    };

    expect(sandboxForNodeRun(commitTitledNode)).toBe("workspace-write");
    expect(sandboxForNodeRun(screenshotNode)).toBe("danger-full-access");
    expect(sandboxForNodeRun(decisionNode)).toBeUndefined();
  });

  it("does not start non-executable user decision nodes", async () => {
    const project = makeWorkspace().projects[0] as ImportedProject;
    const session = makeSession([
      makeNode({
        id: "decision-architecture-risk",
        agent: "hermes",
        status: "running",
        runId: "run-session-1-decision-architecture-risk",
        title: "User decision required",
      }),
    ]);
    const decisionNode = session.nodes.find((node) => node.id === "decision-architecture-risk")!;
    decisionNode.nodeKind = "user_decision";
    decisionNode.executable = false;
    decisionNode.userDecision = {
      decisionId: "decision-architecture-risk",
      prompt: "Continue?",
      options: ["Continue", "Abort"],
      reason: "Architecture risk changed.",
      status: "waiting_input",
    };
    const startAgentRun = vi.fn();
    vi.stubGlobal("window", {
      devflow: {
        startAgentRun,
      },
    });

    try {
      const result = await startBridgeRun(project, session, decisionNode);

      expect(result).toBeNull();
      expect(startAgentRun).not.toHaveBeenCalled();
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("rejects malformed Hermes WorkflowIntent output without crashing the canvas projection", () => {
    const workspace = makeWorkspace();
    const hermesRunId = "run-session-1-node-1";

    const next = mergeRunEventsIntoWorkspace(workspace, hermesRunId, [
      event(hermesRunId, 1, "output", {
        text: JSON.stringify({
          intentId: "intent-missing-payload",
          sessionId: "session-1",
          operations: [{ type: "AnalyzeRequirement" }, { type: "DiscoverProject" }, { type: "ProposeLanes" }],
        }),
      }),
    ]);

    const session = next.sessions[0] as CanvasSession;
    expect(session.nodes.map((node) => node.id)).toEqual(["node-1"]);
    expect(session.edges).toEqual([]);
  });

  it("keeps the Hermes source card status derived from run evidence after tool mutations", () => {
    const workspace = makeWorkspace();
    const hermesRunId = "run-session-1-node-1";

    const next = mergeRunEventsIntoWorkspace(workspace, hermesRunId, [
      event(hermesRunId, 1, "output", {
        text: JSON.stringify({
          toolCalls: [
            {
              tool: "updateWorkflowCard",
              toolCallId: "call-update-source",
              input: {
                id: "node-1",
                status: "running",
                progress: "Hermes still planning",
              },
            },
            {
              tool: "createWorkflowCard",
              toolCallId: "call-create-code",
              input: {
                id: "node-code",
                title: "Implement task",
                agent: "codex",
                status: "running",
                brief: "Make the code change and report evidence.",
              },
            },
          ],
        }),
      }),
      event(hermesRunId, 2, "evidence", {
        exitCode: 0,
        checks: [{ kind: "run-exit", name: "Hermes CLI exit", status: "passed", detail: "exit 0" }],
      }),
      event(hermesRunId, 3, "status", {
        status: "succeeded",
        exitCode: 0,
      }),
    ]);

    const session = next.sessions[0] as CanvasSession;
    const hermesNode = session.nodes.find((node) => node.id === "node-1");
    expect(hermesNode?.status).toBe("completed");
    expect(hermesNode?.progress).toBe("Evidence ready");
  });

  it("does not restore stale planner dependencies while preserving Hermes run evidence state", () => {
    const base = makeWorkspace([
      makeNode({
        id: "node-code",
        agent: "codex",
        status: "running",
        runId: "run-session-1-node-code",
      }),
    ]);
    const session = base.sessions[0] as CanvasSession;
    const workspace: WorkspaceState = {
      ...base,
      sessions: [
        {
          ...session,
          edges: [{ id: "edge-node-code-node-1", source: "node-code", target: "node-1" }],
          nodes: session.nodes.map((node) =>
            node.id === "node-1"
              ? {
                  ...node,
                  context: {
                    ...node.context,
                    dependencies: ["node-code"],
                  },
                }
              : node,
          ),
        },
      ],
    };
    const hermesRunId = "run-session-1-node-1";

    const next = mergeRunEventsIntoWorkspace(workspace, hermesRunId, [
      event(hermesRunId, 1, "output", {
        text: JSON.stringify({
          toolCalls: [
            {
              tool: "createWorkflowCard",
              toolCallId: "call-create-verify",
              input: {
                id: "node-verify",
                title: "Verify implementation",
                agent: "hermes",
                status: "running",
                brief: "Verify the Codex implementation.",
              },
            },
          ],
        }),
      }),
      event(hermesRunId, 2, "evidence", {
        exitCode: 0,
        checks: [{ kind: "run-exit", name: "Hermes CLI exit", status: "passed", detail: "exit 0" }],
      }),
      event(hermesRunId, 3, "status", {
        status: "succeeded",
        exitCode: 0,
      }),
    ]);

    const nextSession = next.sessions[0] as CanvasSession;
    const hermesNode = nextSession.nodes.find((node) => node.id === "node-1");
    expect(hermesNode?.status).toBe("completed");
    expect(hermesNode?.context.dependencies).toEqual([]);
    expect(nextSession.edges).not.toContainEqual({
      id: "edge-node-code-node-1",
      source: "node-code",
      target: "node-1",
    });
  });

  it("reflects Codex output and concrete run evidence on the code task card", () => {
    const workspace = makeWorkspace([
      makeNode({
        id: "node-code",
        agent: "codex",
        status: "running",
        runId: "run-session-1-node-code",
      }),
    ]);
    const codexRunId = "run-session-1-node-code";

    const next = mergeRunEventsIntoWorkspace(workspace, codexRunId, [
      event(codexRunId, 1, "output", {
        text: "Implemented the smallest evidence reflection path.",
      }),
      event(codexRunId, 2, "evidence", {
        exitCode: 0,
        artifacts: [".devflow/acceptance/node-code/output.md"],
        checks: [{ kind: "run-exit", name: "Codex CLI exit", status: "passed", detail: "exit 0" }],
      }),
      event(codexRunId, 3, "status", {
        status: "succeeded",
        exitCode: 0,
      }),
    ]);

    const session = next.sessions[0] as CanvasSession;
    const codeNode = session.nodes.find((node) => node.id === "node-code");
    expect(codeNode?.status).toBe("completed");
    expect(codeNode?.progress).toBe("Evidence ready");
    expect(codeNode?.output).toContain("Implemented the smallest evidence reflection path.");
    expect(next.runEvidence[codexRunId]?.artifacts).toEqual([".devflow/acceptance/node-code/output.md"]);
  });

  it.each(["succeeded", "cancelled", "timed-out", "failed"] as const)(
    "keeps first terminal %s across every late terminal status and error",
    (firstStatus) => {
      for (const lateStatus of ["succeeded", "failed", "cancelled", "timed-out"] as const) {
        const runId = `run-session-1-node-code-${firstStatus}-${lateStatus}`;
        const workspace = makeWorkspace([
          makeNode({ id: "node-code", agent: "codex", status: "running", runId }),
        ]);
        const firstExitCode = firstStatus === "failed" ? 7 : firstStatus === "succeeded" ? 0 : undefined;
        const next = mergeRunEventsIntoWorkspace(workspace, runId, [
          event(runId, 1, "status", { status: firstStatus, exitCode: firstExitCode, reason: firstStatus }),
          event(runId, 2, "status", { status: lateStatus, exitCode: 0, reason: "late terminal" }),
          event(runId, 3, "error", { message: "late adapter error" }),
        ]);

        expect(next.runEvidence[runId]).toMatchObject({
          status: firstStatus,
          exitCode: firstExitCode ?? null,
          errorReason: null,
        });
      }
    },
  );

  it("keeps artifact failure terminal across every late terminal status and error", () => {
    for (const lateStatus of ["succeeded", "failed", "cancelled", "timed-out"] as const) {
      const runId = `run-session-1-node-code-artifact-${lateStatus}`;
      const workspace = makeWorkspace([
        makeNode({ id: "node-code", agent: "codex", status: "running", runId }),
      ]);
      const next = mergeRunEventsIntoWorkspace(workspace, runId, [
        event(runId, 1, "evidence", {
          exitCode: 0,
          checks: [
            { kind: "run-exit", name: "Codex CLI exit", status: "passed", detail: "exit 0" },
            { kind: "artifact", name: "Expected artifacts", status: "failed", detail: "missing=1" },
          ],
        }),
        event(runId, 2, "status", { status: "failed", exitCode: 0, reason: "expected-artifact-failure" }),
        event(runId, 3, "status", { status: lateStatus, exitCode: 0, reason: "late terminal" }),
        event(runId, 4, "error", { message: "late adapter error" }),
      ]);

      expect(next.runEvidence[runId]).toMatchObject({ status: "failed", exitCode: 0, errorReason: null });
      expect(next.runEvidence[runId]?.checks).toContainEqual(
        expect.objectContaining({ kind: "artifact", status: "failed" }),
      );
    }
  });

  it("keeps a failed expected-artifact gate terminal across a stale succeeded status", () => {
    const runId = "run-session-1-node-code-artifact-stale-success";
    const workspace = makeWorkspace([
      makeNode({ id: "node-code", agent: "codex", status: "running", runId }),
    ]);
    const next = mergeRunEventsIntoWorkspace(workspace, runId, [
      event(runId, 1, "evidence", {
        exitCode: 0,
        checks: [
          { kind: "artifact", name: "Expected artifacts", status: "failed", detail: "missing=1" },
        ],
      }),
      event(runId, 2, "status", { status: "succeeded", exitCode: 0 }),
    ]);

    expect(next.runEvidence[runId]).toMatchObject({ status: "failed", exitCode: 0 });
    expect(next.sessions[0]?.nodes.find((node) => node.id === "node-code")?.status).toBe("failed");
  });

  it("sanitizes stale succeeded RunEvidence before applying a completed bridge result", () => {
    const runId = "run-session-1-node-code-stale-result";
    const workspace = makeWorkspace([
      makeNode({ id: "node-code", agent: "codex", status: "running", runId }),
    ]);
    const evidence = {
      runId,
      status: "succeeded",
      exitCode: 0,
      changesetId: null,
      checks: [
        { kind: "artifact", name: "Expected artifacts", status: "failed", detail: "missing=1" },
      ],
      artifacts: [],
      review: null,
      errorReason: null,
      cancelReason: null,
      completedAt: "2026-06-10T00:00:02.000Z",
    } satisfies RunEvidence;
    const next = applyBridgeRunResult(workspace, {
      run: {
        id: runId,
        nodeId: "node-code",
        sessionId: "session-1",
        projectRoot: "/tmp/project",
        worktreePath: "/tmp/project",
        agentKind: "codex",
        status: "succeeded",
        startedAt: "2026-06-10T00:00:00.000Z",
        endedAt: evidence.completedAt,
      },
      events: [
        event(runId, 1, "evidence", { exitCode: 0, checks: evidence.checks }),
        event(runId, 2, "status", { status: "succeeded", exitCode: 0 }),
      ],
      evidence,
    });

    expect(next.runEvidence[runId]?.status).toBe("failed");
    expect(next.sessions[0]?.nodes.find((node) => node.id === "node-code")?.status).toBe("failed");
  });

  it("applies full cancelled bridge evidence over stale succeeded events without a workflow session", () => {
    const runId = "run-session-1-node-code-cancelled-result";
    const workspace = makeWorkspace([
      makeNode({ id: "node-code", agent: "codex", status: "running", runId }),
    ]);
    const evidence = {
      ...runEvidenceFor(runId, "cancelled"),
      exitCode: 143,
      cancelReason: "first cancellation",
      completedAt: "2026-06-10T00:00:02.000Z",
    } satisfies RunEvidence;

    const next = applyBridgeRunResult(workspace, {
      run: {
        id: runId,
        nodeId: "node-code",
        sessionId: "session-1",
        projectRoot: "/tmp/project",
        worktreePath: "/tmp/project",
        agentKind: "codex",
        status: "succeeded",
        startedAt: "2026-06-10T00:00:00.000Z",
        endedAt: "2026-06-10T00:00:03.000Z",
      },
      events: [event(runId, 1, "status", { status: "succeeded", exitCode: 0 })],
      evidence,
    });

    expect(next.runEvidence[runId]).toMatchObject({
      status: "cancelled",
      exitCode: 143,
      cancelReason: "first cancellation",
      completedAt: "2026-06-10T00:00:02.000Z",
    });
    expect(next.runs[runId]).toMatchObject({ status: "cancelled", endedAt: "2026-06-10T00:00:02.000Z" });
    expect(next.sessions[0]?.nodes.find((node) => node.id === "node-code")?.status).toBe("failed");
  });

  it("clears a stale run end time when cancelled evidence has no completion time", () => {
    const runId = "run-session-1-node-code-cancelled-no-time";
    const workspace = makeWorkspace([
      makeNode({ id: "node-code", agent: "codex", status: "running", runId }),
    ]);
    const evidence = {
      ...runEvidenceFor(runId, "cancelled"),
      exitCode: 143,
      cancelReason: "first cancellation",
      completedAt: null,
    } satisfies RunEvidence;

    const next = applyBridgeRunResult(workspace, {
      run: {
        id: runId,
        nodeId: "node-code",
        sessionId: "session-1",
        projectRoot: "/tmp/project",
        worktreePath: "/tmp/project",
        agentKind: "codex",
        status: "succeeded",
        startedAt: "2026-06-10T00:00:00.000Z",
        endedAt: "2026-06-10T00:00:03.000Z",
      },
      events: [event(runId, 1, "status", { status: "succeeded", exitCode: 0 })],
      evidence,
    });

    expect(next.runs[runId]).toMatchObject({ status: "cancelled" });
    expect(next.runs[runId]?.endedAt).toBeUndefined();
  });

  it("applies persisted full cancelled evidence over stale succeeded events without a workflow session", () => {
    const runId = "run-session-1-node-code-cancelled-persistence";
    const workspace = makeWorkspace([
      makeNode({ id: "node-code", agent: "codex", status: "running", runId }),
    ]);
    const evidence = {
      ...runEvidenceFor(runId, "cancelled"),
      exitCode: 143,
      cancelReason: "first cancellation",
      completedAt: "2026-06-10T00:00:02.000Z",
    } satisfies RunEvidence;

    const next = applyCompletedBridgeRunPersistenceResult(workspace, runId, {
      events: [event(runId, 1, "status", { status: "succeeded", exitCode: 0 })],
      evidence,
      workflowSession: null,
    });

    expect(next.runEvidence[runId]).toMatchObject({
      status: "cancelled",
      exitCode: 143,
      cancelReason: "first cancellation",
      completedAt: "2026-06-10T00:00:02.000Z",
    });
    expect(next.sessions[0]?.nodes.find((node) => node.id === "node-code")?.status).toBe("failed");
  });

  it("retains the first cancelled result against later conflicting bridge and persistence success", () => {
    const runId = "run-session-1-node-code-first-cancelled";
    const workspace = makeWorkspace([
      makeNode({ id: "node-code", agent: "codex", status: "running", runId }),
    ]);
    const cancelled = {
      ...runEvidenceFor(runId, "cancelled"),
      exitCode: 143,
      cancelReason: "first cancellation",
      completedAt: "2026-06-10T00:00:02.000Z",
    } satisfies RunEvidence;
    const first = applyBridgeRunResult(workspace, {
      run: {
        id: runId,
        nodeId: "node-code",
        sessionId: "session-1",
        projectRoot: "/tmp/project",
        worktreePath: "/tmp/project",
        agentKind: "codex",
        status: "cancelled",
        startedAt: "2026-06-10T00:00:00.000Z",
        endedAt: cancelled.completedAt,
      },
      events: [event(runId, 1, "status", { status: "cancelled", exitCode: 143 })],
      evidence: cancelled,
    });
    const succeeded = runEvidenceFor(runId, "succeeded");
    const lateBridge = applyBridgeRunResult(first, {
      run: {
        ...(first.runs[runId] as AgentRun),
        status: "succeeded",
        endedAt: succeeded.completedAt ?? undefined,
      },
      events: [event(runId, 2, "status", { status: "succeeded", exitCode: 0 })],
      evidence: succeeded,
    });
    const latePersistence = applyCompletedBridgeRunPersistenceResult(first, runId, {
      events: [event(runId, 2, "status", { status: "succeeded", exitCode: 0 })],
      evidence: succeeded,
      workflowSession: null,
    });

    for (const state of [lateBridge, latePersistence]) {
      expect(state.runEvidence[runId]).toMatchObject({
        status: "cancelled",
        exitCode: 143,
        cancelReason: "first cancellation",
        completedAt: "2026-06-10T00:00:02.000Z",
      });
      expect(state.sessions[0]?.nodes.find((node) => node.id === "node-code")?.status).toBe("failed");
    }
    expect(lateBridge.runs[runId]).toMatchObject({
      status: "cancelled",
      endedAt: "2026-06-10T00:00:02.000Z",
    });
  });

  it("does not complete a browser screenshot node without artifact-passed evidence", () => {
    const runId = "run-session-1-lane-browser-missing-artifact-check";
    const workspace = makeWorkspace([
      makeNode({
        id: "lane-browser",
        agent: "codex",
        status: "running",
        runId,
        title: "Capture browser screenshot evidence",
        meta: ["browser_screenshot_validation", "lane-browser", "flow-kernel"],
        requiredEvidence: ["browser", "screenshot"],
      }),
    ]);
    const evidence = {
      runId,
      status: "succeeded",
      exitCode: 0,
      changesetId: null,
      checks: [{ kind: "run-exit", name: "Codex CLI exit", status: "passed" }],
      artifacts: [],
      review: null,
      errorReason: null,
      cancelReason: null,
      completedAt: "2026-06-10T00:00:02.000Z",
    } satisfies RunEvidence;

    const next = applyBridgeRunResult(workspace, {
      run: {
        id: runId,
        nodeId: "lane-browser",
        sessionId: "session-1",
        projectRoot: "/tmp/project",
        worktreePath: "/tmp/project",
        agentKind: "codex",
        status: "succeeded",
        startedAt: "2026-06-10T00:00:00.000Z",
        endedAt: evidence.completedAt,
      },
      events: [
        event(runId, 1, "evidence", { exitCode: 0, checks: evidence.checks }),
        event(runId, 2, "status", { status: "succeeded", exitCode: 0 }),
      ],
      evidence,
    });

    expect(next.sessions[0]?.nodes.find((node) => node.id === "lane-browser")?.status).toBe("failed");
  });

  it("rejects malformed full RunEvidence instead of applying a completed bridge result", () => {
    const runId = "run-session-1-node-code-malformed-result";
    const workspace = makeWorkspace([
      makeNode({ id: "node-code", agent: "codex", status: "running", runId }),
    ]);
    const result = {
      run: {
        id: runId,
        nodeId: "node-code",
        sessionId: "session-1",
        projectRoot: "/tmp/project",
        worktreePath: "/tmp/project",
        agentKind: "codex" as const,
        status: "succeeded" as const,
        startedAt: "2026-06-10T00:00:00.000Z",
        endedAt: "2026-06-10T00:00:02.000Z",
      },
      events: [],
      evidence: {
        runId,
        status: "succeeded",
        exitCode: 0,
        changesetId: null,
        checks: [{ kind: "unknown-kind", name: "Unsafe", status: "passed" }],
        artifacts: [],
        review: null,
        errorReason: null,
        cancelReason: null,
        completedAt: "2026-06-10T00:00:02.000Z",
      } as unknown as RunEvidence,
    };

    expect(() => applyBridgeRunResult(workspace, result)).toThrow(/invalid RunEvidence/i);
    expect(workspace.sessions[0]?.nodes.find((node) => node.id === "node-code")?.status).toBe("running");
  });

  it.each([
    {
      name: "failed",
      evidence: {
        status: "failed" as const,
        exitCode: 7,
        errorReason: "first failure",
        cancelReason: null,
      },
    },
    {
      name: "cancelled",
      evidence: {
        status: "cancelled" as const,
        exitCode: null,
        errorReason: null,
        cancelReason: "first cancellation",
      },
    },
  ])("hydrates persisted terminal $name fields before applying a late event slice", ({ name, evidence }) => {
    const runId = `run-session-1-node-code-persisted-${name}`;
    const completedAt = "2026-06-10T00:00:01.000Z";
    const workspace = makeWorkspace([
      makeNode({ id: "node-code", agent: "codex", status: "failed", runId }),
    ]);
    workspace.runEvidence[runId] = {
      runId,
      ...evidence,
      changesetId: null,
      checks: [{ kind: "run-exit", name: "First terminal", status: evidence.status === "cancelled" ? "skipped" : "failed" }],
      artifacts: [],
      review: null,
      completedAt,
    };
    const lateSlice = [
      event(runId, 2, "status", { status: "succeeded", exitCode: 0, errorReason: "late success reason" }),
      event(runId, 3, "status", { status: "failed", exitCode: 9, errorReason: "late failure reason", reason: "late cancel" }),
    ];

    const next = mergeRunEventsIntoWorkspace(workspace, runId, lateSlice);
    const reopened = mergeRunEventsIntoWorkspace(JSON.parse(JSON.stringify(next)) as WorkspaceState, runId, lateSlice);

    for (const state of [next, reopened]) {
      expect(state.runEvidence[runId]).toMatchObject({ ...evidence, completedAt });
      expect(state.sessions[0]?.nodes.find((node) => node.id === "node-code")?.status).toBe("failed");
    }
  });

  it("keeps the first terminal error reason across late failed and succeeded statuses", () => {
    const runId = "run-session-1-node-code-first-error";
    const workspace = makeWorkspace([
      makeNode({ id: "node-code", agent: "codex", status: "running", runId }),
    ]);

    const next = mergeRunEventsIntoWorkspace(workspace, runId, [
      event(runId, 1, "status", { status: "failed", exitCode: 7, errorReason: "first" }),
      event(runId, 2, "status", { status: "failed", exitCode: 9, errorReason: "late failed" }),
      event(runId, 3, "status", { status: "succeeded", exitCode: 0, errorReason: "late succeeded" }),
    ]);

    expect(next.runEvidence[runId]).toMatchObject({
      status: "failed",
      exitCode: 7,
      errorReason: "first",
      completedAt: "2026-06-10T00:00:01.000Z",
    });
  });

  it.each([
    {
      name: "cancelled",
      initialEvents: (runId: string) => [
        event(runId, 1, "status", { status: "cancelled", reason: "user cancelled" }),
      ],
      expected: {
        status: "cancelled",
        exitCode: null,
        completedAt: "2026-06-10T00:00:01.000Z",
        errorReason: null,
        cancelReason: "user cancelled",
      },
    },
    {
      name: "timed-out",
      initialEvents: (runId: string) => [event(runId, 1, "status", { status: "timed-out" })],
      expected: {
        status: "timed-out",
        exitCode: null,
        completedAt: "2026-06-10T00:00:01.000Z",
        errorReason: null,
        cancelReason: null,
      },
    },
    {
      name: "nonzero-failed",
      initialEvents: (runId: string) => [event(runId, 1, "status", { status: "failed", exitCode: 7 })],
      expected: {
        status: "failed",
        exitCode: 7,
        completedAt: "2026-06-10T00:00:01.000Z",
        errorReason: null,
        cancelReason: null,
      },
    },
    {
      name: "artifact-failed",
      initialEvents: (runId: string) => [
        event(runId, 1, "evidence", {
          exitCode: 0,
          checks: [{ kind: "artifact", name: "Expected artifacts", status: "failed", detail: "missing=1" }],
          artifacts: [".devflow/acceptance/node-code/missing.md"],
        }),
        event(runId, 2, "status", { status: "failed", exitCode: 0, reason: "expected-artifact-failure" }),
      ],
      expected: {
        status: "failed",
        exitCode: 0,
        completedAt: "2026-06-10T00:00:02.000Z",
        errorReason: null,
        cancelReason: null,
      },
    },
  ])("keeps first-terminal fields for $name while merging safe late evidence", ({ name, initialEvents, expected }) => {
    const runId = `run-session-1-node-code-${name}-late-evidence`;
    const workspace = makeWorkspace([
      makeNode({ id: "node-code", agent: "codex", status: "running", runId }),
    ]);
    const lateCheck = { kind: "test", name: "Late verification", status: "passed", detail: "safe" } as const;
    const lateReview = { kind: "review", name: "Late review", status: "passed", detail: "safe" } as const;

    const next = mergeRunEventsIntoWorkspace(workspace, runId, [
      ...initialEvents(runId),
      event(runId, 3, "evidence", {
        exitCode: 0,
        changesetId: "changeset-late",
        checks: [lateCheck],
        artifacts: [".devflow/acceptance/node-code/late.md"],
        review: lateReview,
      }),
    ]);

    expect(next.runEvidence[runId]).toMatchObject(expected);
    expect(next.runEvidence[runId]?.checks).toContainEqual(lateCheck);
    if (name === "artifact-failed") {
      expect(next.runEvidence[runId]?.artifacts).toEqual([]);
    } else {
      expect(next.runEvidence[runId]?.artifacts).toContain(".devflow/acceptance/node-code/late.md");
    }
    expect(next.runEvidence[runId]?.changesetId).toBe("changeset-late");
    expect(next.runEvidence[runId]?.review).toEqual(lateReview);
  });

  it("rejects a renderer event slice when any evidence field is malformed", () => {
    const runId = "run-session-1-node-code-strict-checks";
    const workspace = makeWorkspace([makeNode({ id: "node-code", agent: "codex", status: "running", runId })]);

    expect(() => mergeRunEventsIntoWorkspace(workspace, runId, [
      event(runId, 1, "status", { status: "cancelled", reason: "user cancelled" }),
      event(runId, 2, "evidence", {
        checks: [
          { kind: "test", name: "Late verification", status: "passed" },
          { kind: "verification", name: "Unknown", status: "passed" },
        ],
      }),
    ])).toThrow(/invalid RunEvidence event stream/i);
    expect(workspace.runEvidence[runId]).toBeUndefined();
  });

  it("rejects malformed terminal status checks from persisted events", () => {
    const workspace = makeWorkspace();
    const runId = "run-session-1-node-1";

    expect(() => mergeRunEventsIntoWorkspace(workspace, runId, [
      event(runId, 1, "status", {
        status: "failed",
        exitCode: 1,
        checks: [
          { kind: "run-exit", name: "Exit", status: "failed" },
          { kind: "unknown-kind", name: "Unsafe", status: "passed" },
        ],
      }),
    ])).toThrow(/invalid RunEvidence event stream/i);
  });

  it("updates node short phrases from safe run progress fields", () => {
    const workspace = makeWorkspace([
      makeNode({
        id: "node-code",
        agent: "codex",
        status: "running",
        runId: "run-session-1-node-code",
      }),
    ]);
    const codexRunId = "run-session-1-node-code";

    const next = mergeRunEventsIntoWorkspace(workspace, codexRunId, [
      event(codexRunId, 1, "progress", {
        phase: "started",
        command: "pnpm --filter @skyturn/ui-canvas test",
        text: '{"intentId":"leak","operations":[{"type":"WorkflowIntent"}]}',
      }),
    ]);

    const session = next.sessions[0] as CanvasSession;
    const codeNode = session.nodes.find((node) => node.id === "node-code");

    expect(codeNode?.progress).toBe("pnpm --filter @skyturn/ui-canvas test");
    expect(codeNode?.runtime?.action).toBe("pnpm --filter @skyturn/ui-canvas test");
    expect(codeNode?.progress).not.toContain("WorkflowIntent");
  });

  it("rejects persisted review evidence with an unknown kind while merging run events", () => {
    const workspace = makeWorkspace([
      makeNode({
        id: "node-review",
        agent: "hermes",
        status: "running",
        runId: "run-session-1-node-review",
      }),
    ]);
    const runId = "run-session-1-node-review";

    expect(() => mergeRunEventsIntoWorkspace(workspace, runId, [
      event(runId, 1, "evidence", {
        review: {
          kind: "policy-review",
          name: "Architecture review",
          status: "failed",
          detail: "Preserved from older persisted events.",
        },
      }),
      event(runId, 2, "status", {
        status: "failed",
      }),
    ])).toThrow(/invalid RunEvidence event stream/i);
  });
});

describe("workflow scheduling policy", () => {
  it("keeps current-branch write lanes serial", () => {
    const session = completePlanner(makeSession([
      withRuntimePolicy(makeNode({
        id: "lane-implementation-a",
        agent: "codex",
        status: "pending",
        runId: "run-session-1-lane-implementation-a",
        meta: ["implementation", "lane-implementation-a", "flow-kernel"],
      }), "workspace-write", ["filesystem", "process"]),
      withRuntimePolicy(makeNode({
        id: "lane-implementation-b",
        agent: "codex",
        status: "pending",
        runId: "run-session-1-lane-implementation-b",
        meta: ["implementation", "lane-implementation-b", "flow-kernel"],
      }), "workspace-write", ["filesystem", "process"]),
    ]));

    expect(policyForSession(session).allowedParallelism).toBe(1);
  });

  it("allows current-branch read-only lanes to run concurrently through Flow Kernel scope gates", () => {
    const session = completePlanner(makeSession([
      withRuntimePolicy(makeNode({
        id: "lane-validation",
        agent: "codex",
        status: "pending",
        runId: "run-session-1-lane-validation",
        meta: ["validation", "lane-validation", "flow-kernel"],
      }), "read-only", ["process", "artifact"]),
      withRuntimePolicy(makeNode({
        id: "lane-review",
        agent: "hermes",
        status: "pending",
        runId: "run-session-1-lane-review",
        meta: ["review", "lane-review", "flow-kernel"],
      }), "read-only", ["process", "artifact"]),
    ]));

    expect(policyForSession(session).allowedParallelism).toBe(2);
  });

  it("allows write lanes in distinct real managed worktrees to run concurrently", () => {
    const session = {
      ...completePlanner(makeSession([
        managedWorktreeNode(withRuntimePolicy(makeNode({
          id: "lane-implementation-a",
          agent: "codex",
          status: "pending",
          runId: "run-session-1-lane-implementation-a",
          meta: ["implementation", "lane-implementation-a", "flow-kernel"],
        }), "workspace-write", ["filesystem", "process"]), "worktree-a", "/tmp/project.worktrees/session-1-a"),
        managedWorktreeNode(withRuntimePolicy(makeNode({
          id: "lane-implementation-b",
          agent: "codex",
          status: "pending",
          runId: "run-session-1-lane-implementation-b",
          meta: ["implementation", "lane-implementation-b", "flow-kernel"],
        }), "workspace-write", ["filesystem", "process"]), "worktree-b", "/tmp/project.worktrees/session-1-b"),
      ])),
      target: {
        executionTarget: "new_worktree" as const,
        selectedBranch: "main",
        baseRef: "origin/main",
      },
    };

    expect(policyForSession(session).allowedParallelism).toBe(2);
  });
});

type WorkflowSchedulingPolicy = {
  allowedParallelism: number;
  runningScopes: Array<{ fileScopes: string[]; packageScopes: string[] }>;
};

type WorkflowSchedulingPolicyForSession = (session: CanvasSession) => WorkflowSchedulingPolicy;

function policyForSession(session: CanvasSession): WorkflowSchedulingPolicy {
  const policy = (WorkflowRuntime as typeof WorkflowRuntime & {
    workflowSchedulingPolicyForSession?: WorkflowSchedulingPolicyForSession;
  }).workflowSchedulingPolicyForSession;
  expect(policy).toBeTypeOf("function");
  return policy!(session);
}

function makeWorkspace(extraNodes: CanvasNode[] = []): WorkspaceState {
  return {
    projects: [
      {
        id: "project-1",
        name: "Project",
        rootPath: "/tmp/project",
        devflowPath: "/tmp/project/.devflow",
        openedAt: "2026-06-10T00:00:00.000Z",
      },
    ],
    sessions: [makeSession(extraNodes)],
    changesets: {},
    agents: [],
    runs: {},
    runEvents: {},
    runEvidence: {},
    activeProjectId: "project-1",
    activeSessionId: "session-1",
    sidebarCollapsed: false,
    collapsedProjectIds: [],
  };
}

function completePlanner(session: CanvasSession): CanvasSession {
  return {
    ...session,
    nodes: session.nodes.map((node) =>
      node.id === session.plannerNodeId ? { ...node, status: "completed" } : node,
    ),
  };
}

function withRuntimePolicy(
  node: CanvasNode,
  sandbox: NonNullable<CanvasNode["runtimePolicy"]>["sandbox"],
  sideEffects: NonNullable<CanvasNode["runtimePolicy"]>["sideEffects"],
): CanvasNode {
  return {
    ...node,
    runtimePolicy: {
      source: "workflow_projection",
      trusted: true,
      executable: true,
      sandbox,
      sideEffects,
      reason: "Test runtime policy.",
    },
  };
}

function managedWorktreeNode(node: CanvasNode, worktreeId: string, realPath: string): CanvasNode {
  return {
    ...node,
    worktree: {
      ...node.worktree,
      path: realPath,
      branchName: `skyturn/session-1/${node.id}`,
      baseCommit: "origin/main",
      executionTarget: "new_worktree",
      selectedBranch: "main",
      baseRef: "origin/main",
      baselineRef: "origin/main",
      worktreeId,
      variantId: node.id,
      realPath,
      gitdir: `/tmp/project/.git/worktrees/${worktreeId}`,
      repoRoot: "/tmp/project",
      headCommit: "abc123",
    },
  };
}

function makeSession(extraNodes: CanvasNode[]): CanvasSession {
  return {
    id: "session-1",
    projectId: "project-1",
    title: "Workflow",
    goal: "Build workflow",
    mode: "fast",
    kind: "canvas",
    target: {
      executionTarget: "current_branch",
      selectedBranch: "HEAD",
    },
    hermesPlannerSessionId: "hermes-planner-session-1",
    plannerNodeId: "node-1",
    createdAt: "2026-06-10T00:00:00.000Z",
    updatedAt: "2026-06-10T00:00:00.000Z",
    activeNodeId: "node-1",
    edges: [],
    nodes: [
      makeNode({
        id: "node-1",
        agent: "hermes",
        status: "running",
        runId: "run-session-1-node-1",
      }),
      ...extraNodes,
    ],
  };
}

function makeNode(input: {
  id: string;
  agent: CanvasNode["agent"];
  status: CanvasNode["status"];
  runId: string;
  brief?: string;
  title?: string;
  meta?: string[];
  requiredEvidence?: string[];
  dependencies?: string[];
  output?: string[];
}): CanvasNode {
  return {
    id: input.id,
    title: input.title ?? input.id,
    agent: input.agent,
    progress: "Running",
    status: input.status,
    position: { x: 100, y: 100 },
    runId: input.runId,
    changesetId: `changeset-${input.id}`,
    output: input.output ?? [],
    ...(input.requiredEvidence ? { requiredEvidence: input.requiredEvidence } : {}),
    display: input.meta ? { agentLabel: input.agent, meta: input.meta } : undefined,
    worktree: {
      path: ".",
      branchName: `skyturn/session-1/${input.id}`,
      baseCommit: "base",
    },
    context: {
      brief: input.brief ?? input.id,
      sessionGoal: "Build workflow",
      relatedRequirements: "",
      relatedDesign: "",
      relatedTasks: "",
      dependencies: input.dependencies ?? [],
      constraints: [],
    },
  };
}

function event(
  runId: string,
  seq: number,
  kind: RunEvent["kind"],
  payload: Record<string, unknown>,
): RunEvent {
  return {
    protocolVersion: 1,
    runId,
    seq,
    kind,
    payload,
    timestamp: `2026-06-10T00:00:0${seq}.000Z`,
  };
}

function runEvidenceFor(runId: string, status: RunEvidence["status"]): RunEvidence {
  const succeeded = status === "succeeded";
  const cancelled = status === "cancelled";
  const timedOut = status === "timed-out";
  return {
    runId,
    status,
    exitCode: succeeded ? 0 : status === "failed" ? 1 : null,
    changesetId: null,
    checks: [
      {
        kind: timedOut ? "run-timeout" : "run-exit",
        name: timedOut ? "Run timeout" : "Agent CLI exit",
        status: succeeded ? "passed" : cancelled ? "skipped" : "failed",
        detail: succeeded ? "exit 0" : `${status}`,
      },
    ],
    artifacts: [],
    review: null,
    errorReason: status === "failed" || timedOut ? `${status}` : null,
    cancelReason: cancelled ? "user cancelled" : null,
    completedAt: "2026-06-10T00:00:01.000Z",
  };
}

function runEventsForEvidence(runId: string, evidence: RunEvidence): RunEvent[] {
  return [
    event(runId, 1, "evidence", {
      exitCode: evidence.exitCode,
      checks: evidence.checks,
      artifacts: evidence.artifacts,
    }),
    event(runId, 2, "status", {
      status: evidence.status,
      exitCode: evidence.exitCode,
      reason: evidence.cancelReason ?? undefined,
    }),
  ];
}
