import { describe, expect, it } from "vitest";

import type { CanvasSession } from "@skyturn/project-core";
import { dependencyAwareScheduler } from "./index";

describe("dependencyAwareScheduler", () => {
  it("returns pending nodes whose dependencies completed", () => {
    const session = {
      nodes: [
        { id: "node-1", status: "completed", context: { dependencies: [] } },
        { id: "node-2", status: "pending", context: { dependencies: ["node-1"] } },
        { id: "node-3", status: "pending", context: { dependencies: ["node-2"] } },
        { id: "node-4", status: "running", context: { dependencies: ["node-1"] } },
      ],
    } as CanvasSession;

    expect(dependencyAwareScheduler.nextRunnableNodes(session).map((node) => node.id)).toEqual(["node-2"]);
  });
});
