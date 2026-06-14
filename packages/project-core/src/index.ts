export type WorkflowMode = "fast" | "plan";
export type SessionKind = "plan" | "canvas";
export type AgentKind = "hermes" | "codex" | "gemini" | "claude-code" | "openclaw";
export type NodeStatus = "pending" | "running" | "retrying" | "completed" | "failed";
export type NodeLifecyclePhase =
  | "Queued"
  | "Think"
  | "Planning"
  | "Executing"
  | "Testing"
  | "Validating"
  | "Retrying"
  | "Summarizing"
  | "Completed"
  | "Failed";
export type NodeModalTab = "Output" | "Changes" | "Context";
export type AgentAvailabilityStatus = "available" | "missing" | "needs-auth" | "unhealthy";
export type AgentSupportLevel = "mock-only" | "detected-only" | "experimental-run" | "supported-run";
export type AgentCapability =
  | "chat"
  | "file-read"
  | "file-write"
  | "shell"
  | "software-control"
  | "mcp"
  | "worktree"
  | "resume";
export type AgentRunStatus =
  | "queued"
  | "running"
  | "waiting-input"
  | "requires-approval"
  | "succeeded"
  | "failed"
  | "cancelled"
  | "timed-out";
export type RunEventKind = "output" | "status" | "error" | "approval" | "progress" | "evidence";
export type EvidenceCheckStatus = "passed" | "failed" | "skipped";
export type HermesPlannerTransport = "native-session" | "oneshot-fallback";

export const NODE_MODAL_TABS: NodeModalTab[] = ["Output", "Changes", "Context"];
export const RUN_EVENT_PROTOCOL_VERSION = 1;
export const AGENT_SUPPORT_LEVELS: AgentSupportLevel[] = [
  "mock-only",
  "detected-only",
  "experimental-run",
  "supported-run",
];

export interface AgentDescriptor {
  kind: AgentKind;
  label: string;
  executablePath: string | null;
  version: string | null;
  status: AgentAvailabilityStatus;
  supportLevel: AgentSupportLevel;
  capabilities: AgentCapability[];
  configFiles: string[];
}

export interface AgentRun {
  id: string;
  nodeId: string;
  sessionId: string;
  plannerSessionId?: string;
  plannerInputId?: string;
  projectRoot: string;
  worktreePath: string;
  agentKind: AgentKind;
  status: AgentRunStatus;
  startedAt: string;
  endedAt?: string;
}

export interface StartAgentRunInput {
  protocolVersion: typeof RUN_EVENT_PROTOCOL_VERSION;
  runId?: string;
  nodeId: string;
  sessionId: string;
  plannerSessionId?: string;
  plannerInputId?: string;
  projectRoot: string;
  worktreePath: string;
  agentKind: AgentKind;
  prompt: string;
}

export interface RunEvent {
  protocolVersion: typeof RUN_EVENT_PROTOCOL_VERSION;
  runId: string;
  seq: number;
  timestamp: string;
  kind: RunEventKind;
  payload: Record<string, unknown>;
}

export interface EvidenceCheck {
  kind: "run-exit" | "git" | "test" | "typecheck" | "build" | "review";
  name: string;
  status: EvidenceCheckStatus;
  detail?: string;
}

export interface RunEvidence {
  runId: string;
  status: AgentRunStatus;
  exitCode: number | null;
  changesetId: string | null;
  checks: EvidenceCheck[];
  artifacts: string[];
  review: EvidenceCheck | null;
  errorReason: string | null;
  cancelReason: string | null;
  completedAt: string | null;
}

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

export interface NodeRuntimeState {
  phase: NodeLifecyclePhase;
  message: string;
  action: string;
}

export interface CanvasNodeDisplay {
  agentLabel: string;
  meta: string[];
}

export type WorkflowCardToolName = "createWorkflowCard" | "updateWorkflowCard" | "deleteWorkflowCard";

export interface CanvasNodeWorkflowTrace {
  source: "hermes";
  sourceRunId: string;
  toolCallId?: string;
  lastTool: WorkflowCardToolName;
  taskKey?: string;
  semanticKey?: string;
}

export interface CanvasNode {
  id: string;
  title: string;
  agent: AgentKind;
  progress: string;
  runtime?: NodeRuntimeState;
  display?: CanvasNodeDisplay;
  workflowTrace?: CanvasNodeWorkflowTrace;
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
  hermesPlannerSessionId: string;
  plannerNodeId: string;
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

export function hasConcreteRunEvidence(evidence: RunEvidence | null | undefined): boolean {
  if (!evidence) return false;
  if (evidence.exitCode === 0) return true;
  if (evidence.changesetId) return true;
  if (evidence.artifacts.length > 0) return true;
  if (evidence.review?.status === "passed") return true;
  return evidence.checks.some((check) => check.status === "passed");
}

export function makeHermesPlannerSessionId(sessionId: string): string {
  return `hermes-planner-${sessionId}`;
}

export function deriveNodeStatusFromEvidence(
  run: AgentRun | null | undefined,
  evidence: RunEvidence | null | undefined,
): NodeStatus {
  if (!run) return "pending";
  if (run.status === "queued") return "pending";
  if (run.status === "running" || run.status === "waiting-input" || run.status === "requires-approval") {
    return "running";
  }
  if (run.status === "succeeded") {
    return hasConcreteRunEvidence(evidence) ? "completed" : "failed";
  }
  return "failed";
}
