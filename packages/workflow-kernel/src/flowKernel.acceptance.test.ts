import { access } from "node:fs/promises";

import { describe, expect, it } from "vitest";

import { runFlowKernelAcceptanceScenarios } from "./acceptance.js";

describe("Flow Kernel v1 automated acceptance", () => {
  it(
    "runs frontend, backend, data, and fullstack scenarios through compiler, store, scheduler, projection, validation, and evidence paths",
    async () => {
      const summary = await runFlowKernelAcceptanceScenarios();

      expect(summary.ok).toBe(true);
      expect(summary.scenarios.map((scenario) => scenario.id)).toEqual([
        "frontend-ui",
        "backend-api",
        "data-script",
        "complex-fullstack",
      ]);

      expect(summary.scenarios[0]?.laneKinds).toEqual([
        "discovery",
        "design",
        "implementation",
        "browser_validation",
        "review",
        "commit",
      ]);
      expect(summary.scenarios[1]?.laneKinds).toEqual([
        "discovery",
        "contract_analysis",
        "implementation",
        "unit_test",
        "integration_test",
        "review",
      ]);
      expect(summary.scenarios[2]?.laneKinds).toEqual([
        "data_contract_analysis",
        "implementation",
        "fixture_validation",
        "regression_check",
      ]);
      expect(summary.scenarios[3]?.laneKinds).toEqual([
        "discovery",
        "frontend_implementation",
        "backend_implementation",
        "persistence_implementation",
        "integration_join",
        "validation",
        "review",
      ]);

      const frontend = summary.scenarios.find((scenario) => scenario.id === "frontend-ui");
      const fullstack = summary.scenarios.find((scenario) => scenario.id === "complex-fullstack");
      expect(frontend?.evidence.some((item) => item.kind === "browser" && item.artifacts.some((path) => path.endsWith(".png")))).toBe(true);
      expect(fullstack?.projection.edges.some((edge) => edge.targetLaneId === "lane-integration-join")).toBe(true);
      expect(fullstack?.projection.lanes.find((lane) => lane.id === "lane-integration-join")?.status).toBe("completed");

      for (const artifact of summary.artifacts) {
        await expect(access(artifact)).resolves.toBeUndefined();
      }
    },
    120_000,
  );
});
