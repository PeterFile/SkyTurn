import { describe, expect, it } from "vitest";

import type { WorkspaceState } from "@skyturn/persistence";
import type { CanvasNode, CanvasSession, RunEvent } from "@skyturn/project-core";

import { buildPromptForNodeRun, mergeRunEventsIntoWorkspace } from "./workflowRuntime.js";

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
}): CanvasNode {
  return {
    id: input.id,
    title: input.id,
    agent: input.agent,
    progress: "Running",
    status: input.status,
    position: { x: 100, y: 100 },
    runId: input.runId,
    changesetId: `changeset-${input.id}`,
    output: [],
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
      dependencies: [],
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
