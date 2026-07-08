import type {
  AgentCapability,
  AgentDescriptor,
  AgentKind,
  AgentSupportLevel,
  AgentTransportCapabilities,
  AgentTransportFeatureFlags,
  CanvasSession,
  PlanSession,
  RunEvent,
  StartAgentRunInput,
} from "@skyturn/project-core";

export interface AgentAdapterContract {
  kind: AgentKind;
  label: string;
  nativeConfigFiles: string[];
  supportLevel: AgentSupportLevel;
  capabilities: AgentCapability[];
  transportCapabilities?: AgentTransportCapabilities;
}

export const DEFAULT_AGENT_RUNTIME_FEATURE_FLAGS: AgentTransportFeatureFlags = {
  ptyInteractiveSessions: false,
};

export interface RunEventDraft {
  kind: RunEvent["kind"];
  payload: Record<string, unknown>;
  timestamp?: string;
}

export interface RunEventSink {
  emit(event: RunEventDraft): Promise<RunEvent>;
}

export interface AgentRunHandle {
  cancel(reason: string): Promise<void>;
}

export interface LocalAgentAdapterContract extends AgentAdapterContract {
  detect(): Promise<AgentDescriptor>;
  startRun(input: StartAgentRunInput, sink: RunEventSink): Promise<AgentRunHandle>;
  send?(runId: string, message: string): Promise<void>;
}

export function canStartPtyInteractiveRun(
  adapter: Pick<AgentAdapterContract, "transportCapabilities">,
  flags: AgentTransportFeatureFlags = DEFAULT_AGENT_RUNTIME_FEATURE_FLAGS,
): boolean {
  return flags.ptyInteractiveSessions && adapter.transportCapabilities?.supportsPtyInteractive === true;
}

export interface HermesOrchestratorAdapter extends AgentAdapterContract {
  createFastSession(input: { projectId: string; goal: string; createdAt: string }): CanvasSession;
  createPlanSession(input: { projectId: string; goal: string; createdAt: string }): PlanSession;
  confirmPlan(session: PlanSession): CanvasSession;
}

export const agentAdapterContracts: AgentAdapterContract[] = [
  {
    kind: "hermes",
    label: "Hermes",
    nativeConfigFiles: ["AGENTS.md"],
    supportLevel: "detected-only",
    capabilities: ["chat", "file-read", "file-write", "shell", "worktree"],
  },
  {
    kind: "codex",
    label: "Codex CLI",
    nativeConfigFiles: ["AGENTS.md", "skills"],
    supportLevel: "detected-only",
    capabilities: ["chat", "file-read", "file-write", "shell", "mcp", "worktree"],
  },
  {
    kind: "agy",
    label: "Antigravity CLI",
    nativeConfigFiles: [],
    supportLevel: "detected-only",
    capabilities: ["chat"],
  },
  {
    kind: "gemini",
    label: "Gemini",
    nativeConfigFiles: ["GEMINI.md"],
    supportLevel: "detected-only",
    capabilities: ["chat", "file-read", "file-write", "shell"],
  },
  {
    kind: "claude-code",
    label: "Claude Code",
    nativeConfigFiles: ["CLAUDE.md"],
    supportLevel: "detected-only",
    capabilities: ["chat", "file-read", "file-write", "shell", "mcp", "worktree"],
  },
  {
    kind: "openclaw",
    label: "OpenClaw",
    nativeConfigFiles: ["OPENCLAW.md"],
    supportLevel: "detected-only",
    capabilities: ["chat", "file-read", "file-write", "shell"],
  },
];

export const agentAdapters = agentAdapterContracts;
