import type {
  AgentCapability,
  AgentDescriptor,
  AgentKind,
  AgentSupportLevel,
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
}

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
