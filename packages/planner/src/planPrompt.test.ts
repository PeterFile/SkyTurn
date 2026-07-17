import { describe, expect, it } from "vitest";

import { buildPlanPrompt } from "./index.js";

describe("Plan prompt contract", () => {
  it("requests Requirements only with the goal and project context", () => {
    const prompt = buildPlanPrompt({
      operation: "generate",
      stage: "requirements",
      goal: "Add staged planning",
      projectContext: "Project root: /repo",
      requirements: "",
      design: "",
    });

    expect(prompt).toContain("Add staged planning");
    expect(prompt).toContain("Project root: /repo");
    expect(prompt).toContain("Requirements only");
    expect(prompt).toContain("Return only Markdown");
    expect(prompt).not.toContain("Design document:");
  });

  it("includes completed Requirements when generating Design", () => {
    const prompt = buildPlanPrompt({
      operation: "generate",
      stage: "design",
      goal: "Add staged planning",
      projectContext: "Project root: /repo",
      requirements: "# Requirements\n\nComplete.",
      design: "",
    });

    expect(prompt).toContain("# Requirements\n\nComplete.");
    expect(prompt).toContain("Design only");
    expect(prompt).not.toContain("Tasks document:");
  });

  it("includes completed Requirements and Design when generating Tasks", () => {
    const prompt = buildPlanPrompt({
      operation: "generate",
      stage: "tasks",
      goal: "Add staged planning",
      projectContext: "Project root: /repo",
      requirements: "# Requirements\n\nComplete.",
      design: "# Design\n\nComplete.",
    });

    expect(prompt).toContain("# Requirements\n\nComplete.");
    expect(prompt).toContain("# Design\n\nComplete.");
    expect(prompt).toContain("Tasks only");
  });

  it.each([
    {
      stage: "requirements" as const,
      currentMarkdown: "# Requirements\n\nCurrent requirements.",
      included: [] as string[],
      excluded: ["# Design\n\nAccepted design."],
    },
    {
      stage: "design" as const,
      currentMarkdown: "# Design\n\nCurrent design.",
      included: ["# Requirements\n\nAccepted requirements."],
      excluded: ["# Tasks\n\nDownstream tasks."],
    },
    {
      stage: "tasks" as const,
      currentMarkdown: "# Tasks\n\nCurrent tasks.",
      included: ["# Requirements\n\nAccepted requirements.", "# Design\n\nAccepted design."],
      excluded: [] as string[],
    },
  ])("carries complete current context for a first-operation $stage revision", ({
    stage,
    currentMarkdown,
    included,
    excluded,
  }) => {
    const prompt = buildPlanPrompt({
      operation: "revise",
      stage,
      goal: "Add staged planning",
      projectContext: "Project root: /repo",
      requirements: "# Requirements\n\nAccepted requirements.",
      design: "# Design\n\nAccepted design.",
      currentMarkdown,
      instruction: "Add failure recovery.",
    });

    expect(prompt).toContain("Goal:\nAdd staged planning");
    expect(prompt).toContain("Project context:\nProject root: /repo");
    for (const markdown of included) expect(prompt).toContain(markdown);
    for (const markdown of excluded) expect(prompt).not.toContain(markdown);
    expect(prompt).toContain(currentMarkdown);
    expect(prompt).toContain("Add failure recovery.");
    expect(prompt).toContain(`full replacement Markdown document for that stage only`);
    expect(prompt).toContain("Return only Markdown");
  });
});
