import { describe, expect, it } from "vitest";

import { agentAdapters, mockHermesAdapter } from "./index";

describe("agent runtime adapters", () => {
  it("keeps each agent behind a native-config-aware adapter contract", () => {
    expect(agentAdapters.map((adapter) => adapter.kind)).toEqual([
      "hermes",
      "codex",
      "gemini",
      "claude-code",
    ]);
    expect(agentAdapters.find((adapter) => adapter.kind === "codex")?.nativeConfigFiles).toContain("AGENTS.md");
  });

  it("uses Hermes to create deterministic mock sessions", () => {
    const session = mockHermesAdapter.createFastSession({
      projectId: "project-1",
      goal: "Build the shell",
      createdAt: "2026-06-10T00:00:00.000Z",
    });

    expect(session.nodes[0]?.agent).toBe("hermes");
    expect(mockHermesAdapter.nextOutputLine(session.nodes[0], 0)).toContain(session.nodes[0]?.runId);
  });
});
