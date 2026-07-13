import { describe, expect, it } from "vitest";

import type { CanvasNode } from "@skyturn/project-core";

import {
  applyCanvasNodePositionUpdates,
  finalCanvasNodePositionUpdate,
} from "./canvasState.js";

describe("canvas node position state", () => {
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

  it("builds one final position update from the drag-stop node", () => {
    expect(finalCanvasNodePositionUpdate({ id: "node-1", position: { x: 128, y: 256 } })).toEqual({
      id: "node-1",
      position: { x: 128, y: 256 },
    });
  });
});
