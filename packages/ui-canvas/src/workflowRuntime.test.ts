import { describe, expect, it, vi } from "vitest";

import type { WorkspaceState } from "@skyturn/persistence";
import type { AgentRun, CanvasNode, CanvasSession, ImportedProject, RunEvent, RunEvidence, StartAgentRunInput } from "@skyturn/project-core";

import {
  buildPromptForNodeRun,
  mergeRunEventsIntoWorkspace,
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
    expect(session.nodes.find((node) => node.id === "lane-discovery")?.position.x).toBeGreaterThan(
      (session.nodes.find((node) => node.id === "node-1")?.position.x ?? 0) + 300,
    );
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
      "workspace-write",
      "danger-full-access",
    ]);
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

    expect(sandboxForNodeRun(commitTitledNode)).toBe("workspace-write");
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
        artifacts: [".devflow/tasks/node-code/output.md"],
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
    expect(next.runEvidence[codexRunId]?.artifacts).toEqual([".devflow/tasks/node-code/output.md"]);
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

  it("preserves persisted custom review evidence kinds while merging run events", () => {
    const workspace = makeWorkspace([
      makeNode({
        id: "node-review",
        agent: "hermes",
        status: "running",
        runId: "run-session-1-node-review",
      }),
    ]);
    const runId = "run-session-1-node-review";

    const next = mergeRunEventsIntoWorkspace(workspace, runId, [
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
    ]);

    expect(next.runEvidence[runId]?.review).toEqual({
      kind: "policy-review",
      name: "Architecture review",
      status: "failed",
      detail: "Preserved from older persisted events.",
    });
  });
});

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

function makeSession(extraNodes: CanvasNode[]): CanvasSession {
  return {
    id: "session-1",
    projectId: "project-1",
    title: "Workflow",
    goal: "Build workflow",
    mode: "fast",
    kind: "canvas",
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
