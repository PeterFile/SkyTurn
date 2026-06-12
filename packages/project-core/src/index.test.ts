import { describe, expect, it } from "vitest";

import {
  AGENT_SUPPORT_LEVELS,
  RUN_EVENT_PROTOCOL_VERSION,
  deriveNodeStatusFromEvidence,
  hasConcreteRunEvidence,
  type AgentDescriptor,
  type AgentRun,
  type RunEvent,
  type RunEvidence,
} from "./index";

describe("agent run contracts", () => {
  it("models OpenClaw discovery with an explicit support level", () => {
    const descriptor: AgentDescriptor = {
      kind: "openclaw",
      label: "OpenClaw",
      executablePath: "/usr/local/bin/openclaw",
      version: null,
      status: "available",
      supportLevel: "detected-only",
      capabilities: ["chat", "file-read"],
      configFiles: ["OPENCLAW.md"],
    };

    expect(AGENT_SUPPORT_LEVELS).toContain("detected-only");
    expect(descriptor.supportLevel).toBe("detected-only");
  });

  it("uses a versioned NDJSON-compatible run event shape", () => {
    const event: RunEvent = {
      protocolVersion: RUN_EVENT_PROTOCOL_VERSION,
      runId: "run-1",
      seq: 1,
      timestamp: "2026-06-12T00:00:00.000Z",
      kind: "output",
      payload: { text: "completed" },
    };

    expect(event.protocolVersion).toBe(1);
    expect(event.seq).toBe(1);
  });

  it("does not complete a node from agent text without concrete evidence", () => {
    const run: AgentRun = {
      id: "run-1",
      nodeId: "node-1",
      sessionId: "session-1",
      projectRoot: "/tmp/project",
      worktreePath: "/tmp/project.worktrees/node-1",
      agentKind: "codex",
      status: "succeeded",
      startedAt: "2026-06-12T00:00:00.000Z",
      endedAt: "2026-06-12T00:00:01.000Z",
    };
    const evidence: RunEvidence = {
      runId: "run-1",
      status: "succeeded",
      exitCode: null,
      changesetId: null,
      checks: [],
      artifacts: [],
      review: null,
      errorReason: null,
      cancelReason: null,
      completedAt: "2026-06-12T00:00:01.000Z",
    };

    expect(hasConcreteRunEvidence(evidence)).toBe(false);
    expect(deriveNodeStatusFromEvidence(run, evidence)).toBe("failed");
  });
});
