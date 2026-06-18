import type { CanvasNode } from "@skyturn/project-core";

export const CANVAS_NODE_LAYOUT = {
  cardWidth: 440,
  rootX: 72,
  rootY: 148,
  laneOriginX: 640,
  laneOriginY: 148,
  columnGap: 560,
  rowGap: 280,
  singleNodeZoom: 1,
  multiNodePadding: 0.14,
  denseNodePadding: 0.08,
} as const;

export function plannerRootPosition(): CanvasNode["position"] {
  return { x: CANVAS_NODE_LAYOUT.rootX, y: CANVAS_NODE_LAYOUT.rootY };
}

export function workflowLanePosition(index: number): CanvasNode["position"] {
  return {
    x: CANVAS_NODE_LAYOUT.laneOriginX + (index % 3) * CANVAS_NODE_LAYOUT.columnGap,
    y: CANVAS_NODE_LAYOUT.laneOriginY + Math.floor(index / 3) * CANVAS_NODE_LAYOUT.rowGap,
  };
}

export function shouldAutoFitCanvas(nodes: readonly CanvasNode[]): boolean {
  return nodes.length > 1;
}

export function canvasFitPadding(nodes: readonly CanvasNode[]): number {
  if (nodes.length <= 1) return 0.18;
  return nodes.length > 5 ? CANVAS_NODE_LAYOUT.denseNodePadding : CANVAS_NODE_LAYOUT.multiNodePadding;
}

export function canvasViewportSignature(nodes: readonly CanvasNode[]): string {
  return nodes
    .map((node) => `${node.id}:${Math.round(node.position.x)},${Math.round(node.position.y)}`)
    .join("|");
}
