import type { NodeChange } from "@xyflow/react";

import type { CanvasNode } from "@skyturn/project-core";

export interface CanvasNodePositionUpdate {
  id: string;
  position: CanvasNode["position"];
}

export function positionUpdatesFromNodeChanges(changes: NodeChange[]): CanvasNodePositionUpdate[] {
  const updates: CanvasNodePositionUpdate[] = [];

  for (const change of changes) {
    if (change.type !== "position" || !change.position) continue;
    updates.push({
      id: change.id,
      position: {
        x: change.position.x,
        y: change.position.y,
      },
    });
  }

  return updates;
}

export function applyCanvasNodePositionUpdates(
  nodes: CanvasNode[],
  updates: CanvasNodePositionUpdate[],
): CanvasNode[] {
  if (updates.length === 0) return nodes;

  const updateById = new Map(updates.map((update) => [update.id, update.position]));
  let changed = false;
  const nextNodes = nodes.map((node) => {
    const position = updateById.get(node.id);
    if (!position) return node;
    if (node.position.x === position.x && node.position.y === position.y) return node;

    changed = true;
    return {
      ...node,
      position,
    };
  });

  return changed ? nextNodes : nodes;
}
