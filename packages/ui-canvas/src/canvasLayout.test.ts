import { describe, expect, it } from "vitest";

import type { CanvasNode } from "@skyturn/project-core";

import {
  CANVAS_NODE_LAYOUT,
  canvasFitPadding,
  canvasViewportSignature,
  plannerRootPosition,
  shouldAutoFitCanvas,
  workflowLanePosition,
} from "./canvasLayout.js";

describe("canvas workflow layout", () => {
  it("starts the first planning card near the left side of the canvas", () => {
    expect(plannerRootPosition()).toEqual({ x: 72, y: 148 });
  });

  it("keeps projected workflow cards far enough apart for readable edges", () => {
    const root = plannerRootPosition();
    const firstLane = workflowLanePosition(0);
    const secondLane = workflowLanePosition(1);

    expect(firstLane.x).toBeGreaterThanOrEqual(root.x + CANVAS_NODE_LAYOUT.cardWidth + 120);
    expect(secondLane.x).toBeGreaterThanOrEqual(firstLane.x + CANVAS_NODE_LAYOUT.cardWidth + 120);
    expect(workflowLanePosition(3).y).toBeGreaterThanOrEqual(firstLane.y + CANVAS_NODE_LAYOUT.rowGap);
  });

  it("anchors one card but auto-fits multi-card canvases", () => {
    expect(shouldAutoFitCanvas([{ id: "root", position: plannerRootPosition() } as CanvasNode])).toBe(false);
    expect(shouldAutoFitCanvas([
      { id: "root", position: plannerRootPosition() },
      { id: "lane-1", position: workflowLanePosition(0) },
    ] as CanvasNode[])).toBe(true);
    expect(canvasFitPadding([{ id: "root" } as CanvasNode])).toBe(0.18);
    expect(canvasFitPadding(Array.from({ length: 7 }, (_, index) => ({ id: `node-${index}` }) as CanvasNode))).toBe(0.08);
  });

  it("changes viewport fit signature when nodes are added or moved", () => {
    const first = [{ id: "root", position: plannerRootPosition() }] as CanvasNode[];
    const moved = [{ id: "root", position: { x: 140, y: 148 } }] as CanvasNode[];
    const expanded = [...first, { id: "lane-1", position: workflowLanePosition(0) } as CanvasNode];

    expect(canvasViewportSignature(first)).not.toBe(canvasViewportSignature(moved));
    expect(canvasViewportSignature(first)).not.toBe(canvasViewportSignature(expanded));
  });
});
