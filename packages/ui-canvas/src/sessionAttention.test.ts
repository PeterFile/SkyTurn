import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import type { CanvasNode, CanvasSession, WorkflowLoopNextAction } from "@skyturn/project-core";
import { deriveSessionAttention, SessionAttention } from "./sessionAttention.js";

function node(id: string, patch: Partial<CanvasNode> = {}): CanvasNode {
  return { id, title: id, status: "pending", ...patch } as CanvasNode;
}
function session(nodes: CanvasNode[] = [], paused = false): CanvasSession {
  return { id: "session", projectId: "project", kind: "canvas", nodes,
    schedulingState: { status: paused ? "paused" : "active", revision: 1, requestId: null, changedAt: null },
  } as CanvasSession;
}
function decision(patch: Partial<CanvasNode> = {}): CanvasNode {
  return node("decision", { nodeKind: "user_decision", userDecision: {
    decisionId: "decision", status: "waiting_input", prompt: "Choose", reason: "Input needed", options: ["Continue"],
  }, ...patch });
}
function action(kind: WorkflowLoopNextAction["kind"] = "request_repair", laneId = "task"): WorkflowLoopNextAction {
  return { kind, laneId, reason: "Current action" };
}

describe("session attention", () => {
  it("prioritizes a pending decision over manual action and pause", () => {
    expect(deriveSessionAttention(session([node("task", { status: "failed" }), decision()], true), action()))
      .toMatchObject({ kind: "decision", targetNodeId: "decision" });
  });

  it("clears resolved decisions and falls back to current manual action before pause", () => {
    const answered = decision(); answered.userDecision!.status = "answered";
    const current = session([answered, node("task", { status: "failed" })], true);
    expect(deriveSessionAttention(current, action())).toMatchObject({ kind: "manual", targetNodeId: "task" });
    expect(deriveSessionAttention(current, null)).toMatchObject({ kind: "paused", targetNodeId: null });
    current.schedulingState!.status = "active";
    expect(deriveSessionAttention(current, null)).toBeNull();
  });

  it.each([null, action("none"), action("execute_lane", "repair"), action("wait_for_checks", "repair")])(
    "does not count repaired historical failures or ordinary progress (%j)", (nextAction) => {
      const current = session([node("task", { status: "failed" }),
        node("repair", { status: "completed", semanticSubtype: "repair" })]);
      expect(deriveSessionAttention(current, nextAction)).toBeNull();
    },
  );

  it.each(["request_repair", "request_variant", "rollback_node", "fix_failed_checks", "merge_pull_request", "blocked"] as const)(
    "locates only the authoritative current %s target", (kind) => {
      expect(deriveSessionAttention(session([node("task")]), action(kind)))
        .toMatchObject({ kind: "manual", targetNodeId: "task" });
    },
  );

  it.each(["inactive", "rolled_back"] as const)("excludes %s decisions and manual targets", (rollbackStatus) => {
    const current = session([decision({ rollbackStatus }), node("task", { rollbackStatus })]);
    expect(deriveSessionAttention(current, action())).toBeNull();
  });

  it("does not use missing authority, missing targets, or prose as attention facts", () => {
    const current = session([node("task", { status: "failed", output: ["Waiting for input! Resume now!"] })]);
    delete current.schedulingState;
    expect(deriveSessionAttention(current, null)).toBeNull();
    expect(deriveSessionAttention(current, action("blocked", "missing"))).toBeNull();
    expect(deriveSessionAttention(current, { kind: "blocked", reason: "Paused" })).toBeNull();
    expect(deriveSessionAttention({ ...current, kind: "plan" } as never, action())).toBeNull();
  });

  it("does not flag a running target or a resolved decision from a stale action", () => {
    expect(deriveSessionAttention(session([node("task", { status: "running" })]), action("blocked"))).toBeNull();
    const answered = decision(); answered.userDecision!.status = "answered";
    expect(deriveSessionAttention(session([answered]), action("blocked", "decision"))).toBeNull();
  });

  it("does not invent attention for an unsupported next-action kind", () => {
    expect(deriveSessionAttention(session([node("task")]), { ...action(), kind: "unknown" } as never)).toBeNull();
  });

  it("shows pause without a node target and clears it when scheduling resumes", () => {
    const current = session([], true);
    expect(deriveSessionAttention(current, null)).toMatchObject({ kind: "paused", targetNodeId: null });
    current.schedulingState!.status = "active";
    expect(deriveSessionAttention(current, null)).toBeNull();
  });

  it("renders a compact named navigation button with stable acceptance selectors", () => {
    const hint = deriveSessionAttention(session([decision()]), null)!;
    const html = renderToStaticMarkup(createElement(SessionAttention, {
      attention: hint, sessionTitle: "Session B", projectId: "project", sessionId: "session", onNavigate: () => {},
    }));
    expect(html).toContain('type="button"');
    expect(html).toContain('aria-label="Open Session B: Waiting for input"');
    expect(html).toContain('data-session-attention="decision"');
    expect(html).toContain('data-target-node-id="decision"');
    expect(html).toContain('data-project-id="project"');
    expect(html).toContain('data-session-id="session"');
    expect(html).toContain('>Input</button>');
  });
});
