export type WorkflowMode = "fast" | "plan";
export type SessionKind = "plan" | "canvas";
export type AgentKind = "hermes" | "codex" | "gemini" | "claude-code";
export type NodeStatus = "pending" | "running" | "retrying" | "completed" | "failed";
export type NodeModalTab = "Output" | "Changes" | "Context";

export const NODE_MODAL_TABS: NodeModalTab[] = ["Output", "Changes", "Context"];

export interface ImportedProject {
  id: string;
  name: string;
  rootPath: string;
  devflowPath: string;
  openedAt: string;
}

export interface PlanMarkdown {
  requirements: string;
  design: string;
  tasks: string;
}

export interface WorktreeMetadata {
  path: string;
  branchName: string;
  baseCommit: string;
}

export interface CanvasNodeContext {
  brief: string;
  sessionGoal: string;
  relatedRequirements: string;
  relatedDesign: string;
  relatedTasks: string;
  dependencies: string[];
  constraints: string[];
}

export interface CanvasNode {
  id: string;
  title: string;
  agent: AgentKind;
  progress: string;
  status: NodeStatus;
  position: {
    x: number;
    y: number;
  };
  runId: string;
  changesetId: string;
  output: string[];
  worktree: WorktreeMetadata;
  context: CanvasNodeContext;
}

export interface CanvasEdge {
  id: string;
  source: string;
  target: string;
}

export interface SessionBase {
  id: string;
  projectId: string;
  title: string;
  goal: string;
  mode: WorkflowMode;
  createdAt: string;
  updatedAt: string;
}

export interface CanvasSession extends SessionBase {
  kind: "canvas";
  nodes: CanvasNode[];
  edges: CanvasEdge[];
  activeNodeId: string | null;
}

export interface PlanSession extends SessionBase {
  kind: "plan";
  mode: "plan";
  plan: PlanMarkdown;
  nodes: [];
  edges: [];
  activeNodeId: null;
}

export type CanvasSessionTab = CanvasSession | PlanSession;

export interface Changeset {
  id: string;
  files: string[];
  diffStat: {
    added: number;
    changed: number;
    deleted: number;
  };
  patchPreview: string;
  source: "mock" | "git";
}
