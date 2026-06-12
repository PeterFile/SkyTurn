import { convertPlanToCanvas, createFastCanvasSession, createPlanSession } from "@skyturn/planner";
import type { AgentKind, CanvasNode, CanvasSession, PlanSession } from "@skyturn/project-core";

export interface AgentAdapter {
  kind: AgentKind;
  label: string;
  nativeConfigFiles: string[];
}

export interface HermesOrchestratorAdapter extends AgentAdapter {
  createFastSession(input: { projectId: string; goal: string; createdAt: string }): CanvasSession;
  createPlanSession(input: { projectId: string; goal: string; createdAt: string }): PlanSession;
  confirmPlan(session: PlanSession): CanvasSession;
  nextOutputLine(node: CanvasNode, lineIndex: number): string;
}

export const agentAdapters: AgentAdapter[] = [
  { kind: "hermes", label: "Hermes", nativeConfigFiles: ["AGENTS.md"] },
  { kind: "codex", label: "Codex", nativeConfigFiles: ["AGENTS.md", "skills"] },
  { kind: "gemini", label: "Gemini", nativeConfigFiles: ["GEMINI.md"] },
  { kind: "claude-code", label: "ClaudeCode", nativeConfigFiles: ["CLAUDE.md"] },
];

export const mockHermesAdapter: HermesOrchestratorAdapter = {
  kind: "hermes",
  label: "Hermes",
  nativeConfigFiles: ["AGENTS.md"],
  createFastSession: createFastCanvasSession,
  createPlanSession,
  confirmPlan: convertPlanToCanvas,
  nextOutputLine(node, lineIndex) {
    const lines = [
      `${node.agent} accepted run ${node.runId}.`,
      `${node.agent} is writing task-local output under .devflow/tasks/${node.id}.`,
      `${node.agent} recorded changeset evidence ${node.changesetId}.`,
      `${node.agent} checkpoint complete; verification is still required.`,
    ];
    return lines[lineIndex] ?? `${node.agent} is waiting for the next checkpoint.`;
  },
};
