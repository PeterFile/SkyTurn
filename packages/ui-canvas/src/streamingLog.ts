import type { CanvasNode, NodeRuntimeState } from "@skyturn/project-core";

export interface StreamingLogLine {
  kind: "skill_view" | "todo" | "terminal" | "process" | "read_file" | "patch";
  text: string;
}

export function streamingLogLineForNode(node: CanvasNode, runtime: NodeRuntimeState): StreamingLogLine {
  return { kind: actionKindForRuntime(runtime), text: actionTextForNode(node, runtime) };
}

function actionKindForRuntime(runtime: NodeRuntimeState): StreamingLogLine["kind"] {
  switch (runtime.phase) {
    case "Think":
    case "Planning":
      return "todo";
    case "Executing":
    case "Testing":
    case "Validating":
      return "terminal";
    case "Completed":
    case "Summarizing":
      return "process";
    case "Retrying":
    case "Failed":
    case "Queued":
      return "process";
  }
}

function actionTextForNode(node: CanvasNode, runtime: NodeRuntimeState): string {
  const action = normalizeStreamText(runtime.action || node.progress || node.context.brief);

  switch (node.status) {
    case "completed":
      return `verified ${action}`;
    case "failed":
      return action || "attention required";
    case "retrying":
      return action || "retry backoff";
    case "pending":
      return action || "waiting for dependency";
    case "running":
      return action || "processing task";
  }
}

function normalizeStreamText(value: string): string {
  return value.trim().replace(/\s+/g, " ").replace(/^evidence ready$/i, "evidence ready");
}
