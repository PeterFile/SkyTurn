import { describe, expect, it } from "vitest";

import type { CanvasSession } from "@skyturn/project-core";
import {
  applyWorkflowCardToolCalls,
  dependencyAwareScheduler,
  parseHermesWorkflowToolCalls,
} from "./index";

describe("dependencyAwareScheduler", () => {
  it("returns pending nodes whose dependencies completed", () => {
    const session = {
      nodes: [
        { id: "node-1", status: "completed", context: { dependencies: [] } },
        { id: "node-2", status: "pending", context: { dependencies: ["node-1"] } },
        { id: "node-3", status: "pending", context: { dependencies: ["node-2"] } },
        { id: "node-4", status: "running", context: { dependencies: ["node-1"] } },
      ],
    } as CanvasSession;

    expect(dependencyAwareScheduler.nextRunnableNodes(session).map((node) => node.id)).toEqual(["node-2"]);
  });
});

describe("workflow-card tools", () => {
  it("applies Hermes workflow-card tool calls to create, update, and delete cards", () => {
    const session = makeSession();

    const result = applyWorkflowCardToolCalls(session, [
      {
        tool: "createWorkflowCard",
        toolCallId: "call-create-draft",
        input: {
          id: "node-draft",
          title: "Draft temporary plan",
          agent: "hermes",
          status: "pending",
          brief: "Temporary decomposition scratch card.",
          dependencies: ["node-1"],
        },
      },
      {
        tool: "updateWorkflowCard",
        toolCallId: "call-update-draft",
        input: {
          id: "node-draft",
          status: "running",
          progress: "Tool update applied",
          output: "Hermes refined this draft before deleting it.",
        },
      },
      {
        tool: "deleteWorkflowCard",
        toolCallId: "call-delete-draft",
        input: {
          id: "node-draft",
          reason: "Draft collapsed into executable cards.",
        },
      },
      {
        tool: "createWorkflowCard",
        toolCallId: "call-create-code",
        input: {
          id: "node-code",
          title: "Implement run evidence persistence",
          agent: "codex",
          status: "running",
          brief: "Update the local code path and persist concrete evidence.",
          dependencies: ["node-1"],
          worktreePath: ".",
        },
      },
    ], {
      sourceRunId: "run-fast-node-1",
      now: "2026-06-10T00:00:01.000Z",
    });

    expect(result.results.map((item) => item.tool)).toEqual([
      "createWorkflowCard",
      "updateWorkflowCard",
      "deleteWorkflowCard",
      "createWorkflowCard",
    ]);
    expect(result.session.nodes.some((node) => node.id === "node-draft")).toBe(false);
    const codeNode = result.session.nodes.find((node) => node.id === "node-code");
    expect(codeNode?.agent).toBe("codex");
    expect(codeNode?.status).toBe("running");
    expect(codeNode?.context.dependencies).toEqual(["node-1"]);
    expect(codeNode?.workflowTrace).toEqual({
      source: "hermes",
      sourceRunId: "run-fast-node-1",
      toolCallId: "call-create-code",
      lastTool: "createWorkflowCard",
    });
    expect(result.session.edges).toContainEqual({
      id: "edge-node-1-node-code",
      source: "node-1",
      target: "node-code",
    });
  });

  it("parses strict Hermes JSON workflow-card tool output", () => {
    const toolCalls = parseHermesWorkflowToolCalls([
      "Hermes plan:",
      "{",
      '  "toolCalls": [',
      '    {"tool": "createWorkflowCard", "input": {"id": "node-a", "title": "A", "agent": "hermes", "brief": "A"}}',
      "  ]",
      "}",
    ].join("\n"));

    expect(toolCalls).toEqual([
      {
        tool: "createWorkflowCard",
        input: {
          id: "node-a",
          title: "A",
          agent: "hermes",
          brief: "A",
        },
      },
    ]);
  });

  it("skips malformed workflow-card tool calls without dropping later valid calls", () => {
    const result = applyWorkflowCardToolCalls(makeSession(), [
      {
        tool: "createWorkflowCard",
        toolCallId: "call-bad",
        input: {
          id: "node-bad",
          title: "",
          agent: "codex",
          brief: "Invalid because title is empty.",
        },
      },
      {
        tool: "createWorkflowCard",
        toolCallId: "call-good",
        input: {
          id: "node-good",
          title: "Implement valid task",
          agent: "codex",
          status: "running",
          brief: "Valid card after malformed tool output.",
        },
      },
    ], {
      sourceRunId: "run-fast-node-1",
      now: "2026-06-10T00:00:01.000Z",
    });

    expect(result.results).toEqual([
      {
        tool: "createWorkflowCard",
        nodeId: "node-bad",
        status: "skipped",
        message: "Workflow card title must be a non-empty string.",
      },
      {
        tool: "createWorkflowCard",
        nodeId: "node-good",
        status: "applied",
        message: "Card created.",
      },
    ]);
    expect(result.session.nodes.some((node) => node.id === "node-bad")).toBe(false);
    expect(result.session.nodes.some((node) => node.id === "node-good")).toBe(true);
  });
});

function makeSession(): CanvasSession {
  return {
    id: "fast-20260610",
    projectId: "project-1",
    title: "Add persisted run evidence",
    goal: "Add persisted run evidence",
    mode: "fast",
    kind: "canvas",
    createdAt: "2026-06-10T00:00:00.000Z",
    updatedAt: "2026-06-10T00:00:00.000Z",
    activeNodeId: "node-1",
    edges: [],
    nodes: [
      {
        id: "node-1",
        title: "Plan workflow",
        agent: "hermes",
        progress: "Planning",
        status: "running",
        position: { x: 80, y: 100 },
        runId: "run-fast-node-1",
        changesetId: "changeset-fast-node-1",
        output: [],
        worktree: {
          path: ".",
          branchName: "skyturn/fast/node-1",
          baseCommit: "base",
        },
        context: {
          brief: "Plan workflow",
          sessionGoal: "Add persisted run evidence",
          relatedRequirements: "",
          relatedDesign: "",
          relatedTasks: "",
          dependencies: [],
          constraints: [],
        },
      },
    ],
  };
}
