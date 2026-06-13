import { describe, expect, it } from "vitest";

import {
  EDGE_MOTION_BY_STATUS,
  MOTION_DURATION,
  NODE_MOTION_BY_STATUS,
  phraseForRuntime,
  shouldLoopEdge,
  shouldLoopNode,
} from "./motion.js";

describe("agent runtime motion policy", () => {
  it("loops only active runtime states", () => {
    expect(shouldLoopNode("running")).toBe(true);
    expect(shouldLoopNode("retrying")).toBe(true);
    expect(shouldLoopNode("pending")).toBe(false);
    expect(shouldLoopNode("completed")).toBe(false);
    expect(shouldLoopNode("failed")).toBe(false);
  });

  it("flows only running dependency edges", () => {
    expect(shouldLoopEdge({ status: "running", active: true })).toBe(true);
    expect(shouldLoopEdge({ status: "running", active: false })).toBe(false);
    expect(shouldLoopEdge({ status: "retrying", active: true })).toBe(false);
    expect(shouldLoopEdge({ status: "failed", active: true })).toBe(false);
  });

  it("keeps completed and failed states settled after one-shot transitions", () => {
    expect(NODE_MOTION_BY_STATUS.completed.loop).toBe(false);
    expect(NODE_MOTION_BY_STATUS.completed.oneShot).toBe("verification-shimmer");
    expect(NODE_MOTION_BY_STATUS.failed.loop).toBe(false);
    expect(NODE_MOTION_BY_STATUS.failed.oneShot).toBe("failure-interruption");
    expect(EDGE_MOTION_BY_STATUS.completed.loop).toBe(false);
    expect(EDGE_MOTION_BY_STATUS.failed.loop).toBe(false);
  });

  it("keeps status animation policies restrained and non-disruptive", () => {
    expect(MOTION_DURATION.energyLoop).toBe(2.2);
    expect(NODE_MOTION_BY_STATUS.pending.frameOpacity).toBeLessThanOrEqual(0.3);
    expect(NODE_MOTION_BY_STATUS.retrying.frameDasharray).toBe("6 8");
    expect(NODE_MOTION_BY_STATUS.failed.frameDasharray).toBe("100");
    expect(EDGE_MOTION_BY_STATUS.retrying.dasharray).toBe("6 8");
  });

  it("maps runtime phases to terse lifecycle phrases", () => {
    expect(phraseForRuntime({ phase: "Think", action: "planning execution" })).toBe(
      "Think · planning execution",
    );
    expect(phraseForRuntime({ phase: "Executing", action: "applying changes" })).toBe(
      "Executing · applying changes",
    );
    expect(phraseForRuntime({ phase: "Completed", action: "Evidence ready" })).toBe(
      "Settling · evidence ready",
    );
  });
});
