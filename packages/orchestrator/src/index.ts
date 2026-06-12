import type { HermesOrchestratorAdapter } from "@skyturn/agent-runtime";
import type { CanvasNode, CanvasSession, PlanSession } from "@skyturn/project-core";

export interface TaskGraphScheduler {
  nextRunnableNodes(session: CanvasSession): CanvasNode[];
}

export interface Orchestrator {
  hermes: HermesOrchestratorAdapter;
  scheduler: TaskGraphScheduler;
  createFastSession(input: { projectId: string; goal: string; createdAt: string }): CanvasSession;
  createPlanSession(input: { projectId: string; goal: string; createdAt: string }): PlanSession;
  confirmPlan(session: PlanSession): CanvasSession;
}

export const dependencyAwareScheduler: TaskGraphScheduler = {
  nextRunnableNodes(session) {
    const completed = new Set(
      session.nodes.filter((node) => node.status === "completed").map((node) => node.id),
    );
    return session.nodes.filter((node) => {
      if (node.status !== "pending") return false;
      return node.context.dependencies.every((dependency) => completed.has(dependency));
    });
  },
};
