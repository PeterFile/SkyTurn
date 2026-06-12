import { describe, expect, it } from "vitest";

import { DEVFLOW_DIRECTORIES, DEVFLOW_FILES, describeDevflowStructure } from "./index";

describe(".devflow structure", () => {
  it("documents the required shared memory and task-local paths", () => {
    expect(DEVFLOW_DIRECTORIES).toContain(".devflow/specs");
    expect(DEVFLOW_DIRECTORIES).toContain(".devflow/tasks");
    expect(DEVFLOW_DIRECTORIES).toContain(".devflow/runs");
    expect(DEVFLOW_DIRECTORIES).toContain(".devflow/memory");
    expect(DEVFLOW_FILES).toContain(".devflow/decisions.md");
    expect(DEVFLOW_FILES).toContain(".devflow/memory/summaries.md");
  });

  it("states that Hermes owns shared memory consolidation", () => {
    const description = describeDevflowStructure();

    expect(description).toContain("Hermes/orchestrator owns shared memory consolidation");
    expect(description).toContain("task-local");
  });
});
