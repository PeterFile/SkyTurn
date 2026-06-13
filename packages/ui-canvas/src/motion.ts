import type { NodeRuntimeState, NodeStatus } from "@skyturn/project-core";

export const MOTION_DURATION = {
  instant: 0.09,
  fast: 0.14,
  normal: 0.22,
  slow: 0.36,
  enter: 0.38,
  energyLoop: 2.2,
  shimmer: 0.68,
  inspector: 0.28,
} as const;

export const MOTION_DISTANCE = {
  hoverLift: -2,
  enterY: 8,
  phraseShift: 4,
  failedShakeX: 1.5,
  enterScaleStart: 0.96,
  selectedScale: 1.005,
} as const;

export const ENERGY_FRAME = {
  width: 324,
  height: 202,
  inset: 1,
  radius: 21,
  pathLength: 100,
} as const;

type OneShotMotion = "verification-shimmer" | "failure-interruption" | null;

export interface NodeMotionPolicy {
  loop: boolean;
  oneShot: OneShotMotion;
  frameDasharray: string;
  frameOpacity: number;
  glintDasharray: string;
}

export interface EdgeMotionPolicy {
  loop: boolean;
  dasharray: string;
  opacity: number;
}

export const NODE_MOTION_BY_STATUS: Record<NodeStatus, NodeMotionPolicy> = {
  pending: {
    loop: false,
    oneShot: null,
    frameDasharray: "100",
    frameOpacity: 0.34,
    glintDasharray: "0 100",
  },
  running: {
    loop: true,
    oneShot: null,
    frameDasharray: "100",
    frameOpacity: 0.72,
    glintDasharray: "12 88",
  },
  retrying: {
    loop: true,
    oneShot: null,
    frameDasharray: "6 8",
    frameOpacity: 0.66,
    glintDasharray: "4 12",
  },
  completed: {
    loop: false,
    oneShot: "verification-shimmer",
    frameDasharray: "100",
    frameOpacity: 0.42,
    glintDasharray: "16 84",
  },
  failed: {
    loop: false,
    oneShot: "failure-interruption",
    frameDasharray: "10 8",
    frameOpacity: 0.58,
    glintDasharray: "10 90",
  },
};

export const EDGE_MOTION_BY_STATUS: Record<NodeStatus, EdgeMotionPolicy> = {
  pending: { loop: false, dasharray: "0 1", opacity: 0.24 },
  running: { loop: true, dasharray: "18 150", opacity: 0.72 },
  retrying: { loop: false, dasharray: "6 12", opacity: 0.54 },
  completed: { loop: false, dasharray: "0 1", opacity: 0.26 },
  failed: { loop: false, dasharray: "10 14", opacity: 0.58 },
};

export function shouldLoopNode(status: NodeStatus, reducedMotion = false): boolean {
  return !reducedMotion && NODE_MOTION_BY_STATUS[status].loop;
}

export function shouldLoopEdge(
  edge: { status: NodeStatus; active: boolean },
  reducedMotion = false,
): boolean {
  return !reducedMotion && edge.active && EDGE_MOTION_BY_STATUS[edge.status].loop;
}

export function phraseForRuntime(runtime: Pick<NodeRuntimeState, "phase" | "action">): string {
  const phase = phrasePhase(runtime.phase);
  const action = normalizePhraseAction(runtime.action || "waiting for evidence");
  return `${phase} · ${action}`;
}

function phrasePhase(phase: NodeRuntimeState["phase"]): string {
  switch (phase) {
    case "Think":
    case "Planning":
      return "Think";
    case "Executing":
      return "Executing";
    case "Testing":
    case "Validating":
      return "Validating";
    case "Summarizing":
    case "Completed":
      return "Settling";
    case "Retrying":
      return "Retrying";
    case "Failed":
      return "Attention";
    case "Queued":
      return "Ready";
  }
}

function normalizePhraseAction(action: string): string {
  const trimmed = action.trim();
  if (!trimmed) return "waiting for evidence";
  return `${trimmed.charAt(0).toLowerCase()}${trimmed.slice(1)}`;
}
