import { describe, expect, it } from "vitest";

import {
  DEFAULT_AGENT_RUNTIME_FEATURE_FLAGS,
  agentAdapterContracts,
  canStartPtyInteractiveRun,
  type AgentAdapterContract,
} from "./index";

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

  it("keeps legacy adapter contracts compatible when transport capabilities are omitted", () => {
    const legacyAdapter: AgentAdapterContract = {
      kind: "codex",
      label: "Codex CLI",
      nativeConfigFiles: ["AGENTS.md"],
      supportLevel: "detected-only",
      capabilities: ["chat", "file-read"],
    };

    expect(legacyAdapter.transportCapabilities).toBeUndefined();
    expect(canStartPtyInteractiveRun(legacyAdapter)).toBe(false);
  });

  it("gates PTY interactive runs behind both runtime flag and adapter capability", () => {
    const ptyCapableAdapter: AgentAdapterContract = {
      kind: "codex",
      label: "Codex CLI",
      nativeConfigFiles: ["AGENTS.md"],
      supportLevel: "experimental-run",
      capabilities: ["chat", "file-read", "file-write", "shell"],
      transportCapabilities: {
        supportsExecJson: true,
        supportsPtyInteractive: true,
        supportsResume: false,
        supportsStructuredEvents: true,
      },
    };

    expect(DEFAULT_AGENT_RUNTIME_FEATURE_FLAGS.ptyInteractiveSessions).toBe(false);
    expect(canStartPtyInteractiveRun(ptyCapableAdapter)).toBe(false);
    expect(canStartPtyInteractiveRun(ptyCapableAdapter, { ptyInteractiveSessions: true })).toBe(true);
    expect(
      canStartPtyInteractiveRun(
        {
          ...ptyCapableAdapter,
          transportCapabilities: {
            ...ptyCapableAdapter.transportCapabilities,
            supportsPtyInteractive: false,
          },
        },
        { ptyInteractiveSessions: true },
      ),
    ).toBe(false);
  });
});
