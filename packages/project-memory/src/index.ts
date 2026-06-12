export const DEVFLOW_DIRECTORIES = [
  ".devflow/specs",
  ".devflow/graph",
  ".devflow/tasks",
  ".devflow/runs",
  ".devflow/git",
  ".devflow/changes",
  ".devflow/memory",
] as const;

export const DEVFLOW_FILES = [
  ".devflow/project.md",
  ".devflow/decisions.md",
  ".devflow/architecture.md",
  ".devflow/constraints.md",
  ".devflow/git/worktrees.json",
  ".devflow/git/branches.json",
  ".devflow/git/merges.json",
  ".devflow/memory/summaries.md",
  ".devflow/memory/open-questions.md",
] as const;

export function describeDevflowStructure(): string {
  return [
    ".devflow stores shared project memory and durable task evidence.",
    "Individual agents should write task-local outputs under .devflow/tasks and .devflow/runs.",
    "Hermes/orchestrator owns shared memory consolidation into decisions.md, architecture.md, and memory/summaries.md.",
  ].join(" ");
}

export function defaultDevflowFileContent(relativePath: string, projectName: string): string {
  if (relativePath.endsWith(".json")) return "[]\n";

  const title = relativePath
    .replace(".devflow/", "")
    .replace(/[-/]/g, " ")
    .replace(".md", "")
    .replace(/\b\w/g, (char) => char.toUpperCase());

  return `# ${title}\n\nProject: ${projectName}\n\n${describeDevflowStructure()}\n`;
}
