import { describe, expect, it } from "vitest";

import { agentAdapterContracts } from "./index";

describe("agent runtime adapters", () => {
  it("keeps each agent behind a native-config-aware contract with support levels", () => {
    expect(agentAdapterContracts.map((adapter) => adapter.kind)).toEqual([
      "hermes",
      "codex",
      "gemini",
      "claude-code",
      "openclaw",
    ]);
    expect(agentAdapterContracts.find((adapter) => adapter.kind === "codex")?.nativeConfigFiles).toContain(
      "AGENTS.md",
    );
    expect(agentAdapterContracts.every((adapter) => adapter.supportLevel)).toBe(true);
  });
});
