import type { NodeChange } from "@xyflow/react";
import { describe, expect, it } from "vitest";

import type { CanvasNode } from "@skyturn/project-core";

import { applyCanvasNodePositionUpdates, positionUpdatesFromNodeChanges } from "./canvasState.js";

describe("canvas node position state", () => {
  it("extracts only concrete position updates from React Flow changes", () => {
    const changes = [
      { id: "node-1", type: "select", selected: true },
      { id: "node-2", type: "position", position: { x: 42, y: 96 } },
      { id: "node-3", type: "position" },
    ] as NodeChange[];

    expect(positionUpdatesFromNodeChanges(changes)).toEqual([
      { id: "node-2", position: { x: 42, y: 96 } },
    ]);
  });

  it("updates matching CanvasNode positions without changing unrelated nodes", () => {
    const nodes = [
      { id: "node-1", position: { x: 0, y: 0 } },
      { id: "node-2", position: { x: 10, y: 10 } },
    ] as CanvasNode[];

    const nextNodes = applyCanvasNodePositionUpdates(nodes, [
      { id: "node-1", position: { x: 120, y: 160 } },
    ]);

    expect(nextNodes[0]?.position).toEqual({ x: 120, y: 160 });
    expect(nextNodes[1]).toBe(nodes[1]);
  });
});
