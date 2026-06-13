import type { CanvasNode, NodeRuntimeState } from "@skyturn/project-core";
import { describe, expect, it } from "vitest";

import { streamingLogLineForNode } from "./streamingLog.js";

function node(overrides: Partial<CanvasNode> = {}): CanvasNode {
  return {
    id: "node-1",
    title: "Analyze Customer Intent",
    agent: "codex",
    status: "running",
    position: { x: 0, y: 0 },
    progress: "analyzing requirements.json",
    runId: "run-1",
    changesetId: "changeset-1",
    output: [],
    worktree: {
      path: "/tmp/worktree",
      branchName: "codex/test",
      baseCommit: "abc123",
    },
    context: {
      brief: "NLP agent analyzes customer intent from the normalized requirements input.",
      sessionGoal: "Verify customer intent",
      relatedRequirements: "",
      relatedDesign: "",
      relatedTasks: "",
      dependencies: [],
      constraints: [],
    },
    ...overrides,
  };
}

describe("streaming log placeholder line", () => {
  it("formats only the latest running node activity as one compact stream entry", () => {
    const runtime: NodeRuntimeState = {
      phase: "Think",
      message: "thinking",
      action: "analyzing requirements.json",
    };

    expect(streamingLogLineForNode(node(), runtime)).toEqual({
      kind: "todo",
      text: "analyzing requirements.json",
    });
  });

  it("keeps completed nodes settled without replaying verbose prose", () => {
    const runtime: NodeRuntimeState = {
      phase: "Completed",
      message: "done",
      action: "Evidence ready",
    };

    expect(streamingLogLineForNode(node({ status: "completed", agent: "claude-code" }), runtime)).toEqual({
      kind: "process",
      text: "verified evidence ready",
    });
  });
});
