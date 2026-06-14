import { describe, expect, it } from "vitest";

import type { CanvasSession } from "@skyturn/project-core";
import {
  applyWorkflowCardToolCalls,
  buildHermesWorkflowPrompt,
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
  it("merges duplicate cards by semantic identity instead of id alone", () => {
    const result = applyWorkflowCardToolCalls(makeSession(), [
      {
        tool: "createWorkflowCard",
        toolCallId: "call-create-code-a",
        input: {
          id: "node-code-a",
          title: "Implement workflow helper",
          agent: "codex",
          status: "running",
          brief: "Update src/workflow.ts to add a task-local evidence summary.",
          worktreePath: ".",
        },
      },
      {
        tool: "createWorkflowCard",
        toolCallId: "call-create-code-b",
        input: {
          id: "node-code-b",
          title: "Implement workflow helper",
          agent: "codex",
          status: "running",
          brief: "Update src/workflow.ts to add a task-local evidence summary.",
          output: "Duplicate Hermes create call should merge into the first implementation card.",
          worktreePath: ".",
        },
      },
    ], {
      sourceRunId: "run-fast-node-1",
      now: "2026-06-10T00:00:01.000Z",
    });

    const codexNodes = result.session.nodes.filter((node) => node.agent === "codex");
    expect(codexNodes.map((node) => node.id)).toEqual(["node-code-a"]);
    expect(codexNodes[0]?.output).toContain("Duplicate Hermes create call should merge into the first implementation card.");
    expect(result.results[1]).toMatchObject({
      tool: "createWorkflowCard",
      nodeId: "node-code-a",
      status: "applied",
    });
  });

  it("connects new cards without dependencies to the source planning card", () => {
    const result = applyWorkflowCardToolCalls(makeSession(), [
      {
        tool: "createWorkflowCard",
        toolCallId: "call-create-code",
        input: {
          id: "node-code",
          title: "Implement workflow helper",
          agent: "codex",
          status: "running",
          brief: "Update src/workflow.ts.",
          worktreePath: ".",
        },
      },
    ], {
      sourceRunId: "run-fast-node-1",
      now: "2026-06-10T00:00:01.000Z",
    });

    const codeNode = result.session.nodes.find((node) => node.id === "node-code");
    expect(codeNode?.context.dependencies).toEqual(["node-1"]);
    expect(result.session.edges).toContainEqual({
      id: "edge-node-1-node-code",
      source: "node-1",
      target: "node-code",
    });
  });

  it("keeps the CanvasSession planner root dependency-free even if Hermes updates it", () => {
    const seeded = applyWorkflowCardToolCalls(makeSession(), [
      {
        tool: "createWorkflowCard",
        toolCallId: "call-create-code",
        input: {
          id: "node-code",
          title: "Implement workflow helper",
          agent: "codex",
          status: "running",
          brief: "Update src/workflow.ts.",
          dependencies: ["node-1"],
          worktreePath: ".",
        },
      },
    ], {
      sourceRunId: "run-fast-node-1",
      now: "2026-06-10T00:00:01.000Z",
    }).session;

    const result = applyWorkflowCardToolCalls(seeded, [
      {
        tool: "updateWorkflowCard",
        toolCallId: "call-bad-root-dependency",
        input: {
          id: "node-1",
          status: "running",
          dependencies: ["node-code"],
        },
      },
    ], {
      sourceRunId: "run-fast-node-1",
      now: "2026-06-10T00:00:02.000Z",
    });

    const planner = result.session.nodes.find((node) => node.id === "node-1");
    expect(planner?.context.dependencies).toEqual([]);
    expect(result.session.edges).not.toContainEqual({
      id: "edge-node-code-node-1",
      source: "node-code",
      target: "node-1",
    });
  });

  it("repairs verifier dependencies to the Codex card and keeps verifier pending until dependencies complete", () => {
    const result = applyWorkflowCardToolCalls(makeSession(), [
      {
        tool: "createWorkflowCard",
        toolCallId: "call-create-code",
        input: {
          id: "node-code",
          title: "Implement workflow helper",
          agent: "codex",
          status: "running",
          brief: "Update src/workflow.ts to add a task-local evidence summary.",
          worktreePath: ".",
        },
      },
      {
        tool: "createWorkflowCard",
        toolCallId: "call-create-verify",
        input: {
          id: "node-verify",
          title: "Verify workflow helper",
          agent: "hermes",
          status: "running",
          brief: "Verify the Codex implementation for the workflow helper.",
        },
      },
    ], {
      sourceRunId: "run-fast-node-1",
      now: "2026-06-10T00:00:01.000Z",
    });

    const verifyNode = result.session.nodes.find((node) => node.id === "node-verify");
    expect(verifyNode?.status).toBe("pending");
    expect(verifyNode?.context.dependencies).toContain("node-code");
    expect(result.session.edges).toContainEqual({
      id: "edge-node-code-node-verify",
      source: "node-code",
      target: "node-verify",
    });
  });

  it("repairs verifier dependencies even when Hermes creates the verifier before the Codex card", () => {
    const result = applyWorkflowCardToolCalls(makeSession(), [
      {
        tool: "createWorkflowCard",
        toolCallId: "call-create-verify",
        input: {
          id: "node-verify",
          title: "Verify workflow helper",
          agent: "hermes",
          status: "running",
          brief: "Verify the Codex implementation for the workflow helper.",
        },
      },
      {
        tool: "createWorkflowCard",
        toolCallId: "call-create-code",
        input: {
          id: "node-code",
          title: "Implement workflow helper",
          agent: "codex",
          status: "running",
          brief: "Update src/workflow.ts to add a task-local evidence summary.",
          worktreePath: ".",
        },
      },
    ], {
      sourceRunId: "run-fast-node-1",
      now: "2026-06-10T00:00:01.000Z",
    });

    const verifyNode = result.session.nodes.find((node) => node.id === "node-verify");
    expect(verifyNode?.context.dependencies).toContain("node-code");
    expect(result.session.edges).toContainEqual({
      id: "edge-node-code-node-verify",
      source: "node-code",
      target: "node-verify",
    });
  });

  it("keeps repeated Hermes planning from creating duplicate Codex implementation cards", () => {
    const first = applyWorkflowCardToolCalls(makeSession(), [
      {
        tool: "createWorkflowCard",
        toolCallId: "call-create-code-a",
        input: {
          id: "node-code-a",
          title: "Implement workflow helper",
          agent: "codex",
          status: "running",
          brief: "Update src/workflow.ts to add a task-local evidence summary.",
          worktreePath: ".",
        },
      },
    ], {
      sourceRunId: "run-fast-node-1",
      now: "2026-06-10T00:00:01.000Z",
    });

    const second = applyWorkflowCardToolCalls(first.session, [
      {
        tool: "createWorkflowCard",
        toolCallId: "call-create-code-b",
        input: {
          id: "node-code-b",
          title: "Implement workflow helper",
          agent: "codex",
          status: "running",
          brief: "Update src/workflow.ts to add a task-local evidence summary.",
          worktreePath: ".",
        },
      },
    ], {
      sourceRunId: "run-fast-node-1",
      now: "2026-06-10T00:00:02.000Z",
    });

    expect(second.session.nodes.filter((node) => node.agent === "codex").map((node) => node.id)).toEqual([
      "node-code-a",
    ]);
  });

  it("prompts Hermes with the SkyTurn card model and graph hygiene rules", () => {
    const prompt = buildHermesWorkflowPrompt({
      goal: "Update one file and verify it",
      sessionId: "session-1",
      plannerSessionId: "hermes-planner-session-1",
      nodeId: "node-1",
      existingNodes: [{ id: "node-1", title: "Plan workflow", agent: "hermes", status: "running" }],
    });

    expect(prompt).toContain("Planner session identity: hermes-planner-session-1");
    expect(prompt).toContain("Card is SkyTurn task state, not the agent itself.");
    expect(prompt).toContain("Hermes cards are planner/verifier tasks; Codex cards are executor tasks.");
    expect(prompt).toContain("runId connects a card to a concrete local agent run.");
    expect(prompt).toContain("Dependencies define xyflow edges and scheduling order.");
    expect(prompt).toContain("Use updateWorkflowCard instead of createWorkflowCard when an equivalent card already exists.");
    expect(prompt).toContain("At most one primary Codex implementation card and one Hermes verification card for a simple single-file task.");
  });

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
    expect(codeNode?.workflowTrace).toMatchObject({
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
    hermesPlannerSessionId: "hermes-planner-fast-20260610",
    plannerNodeId: "node-1",
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
