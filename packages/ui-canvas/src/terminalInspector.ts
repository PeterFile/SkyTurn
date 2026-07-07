import type { TerminalSnapshotResult } from "@skyturn/persistence";

export type PlannerSessionStatusTone = "planning" | "waiting" | "running" | "blocked" | "degraded" | "inspectable";

export interface PlannerSessionStatusChrome {
  label: "Planning" | "Waiting" | "Running" | "Blocked" | "Unavailable" | "Inspectable";
  tone: PlannerSessionStatusTone;
  detail: string;
  inspectable: boolean;
}

export function formatTerminalTitle(snapshot: TerminalSnapshotResult | null): string {
  if (!snapshot || !snapshot.terminalSessionId) return "Hermes Terminal";
  return `Hermes Terminal (${snapshot.terminalSessionId})`;
}

export function formatTerminalBadge(snapshot: TerminalSnapshotResult | null): string {
  if (!snapshot) return "connecting...";
  const seq = snapshot.sequence !== undefined ? ` [seq: ${snapshot.sequence}]` : "";
  return `${snapshot.status}${seq}`;
}

export function formatTerminalMessage(snapshot: TerminalSnapshotResult | null): string | null {
  if (!snapshot || !snapshot.message) return null;
  if (snapshot.reasonCode) {
    return `${snapshot.message} (${snapshot.reasonCode})`;
  }
  return snapshot.message;
}

export function plannerSessionStatusForSnapshot(
  terminalSessionId: string | null,
  snapshot: TerminalSnapshotResult | null,
): PlannerSessionStatusChrome {
  if (!terminalSessionId) {
    return {
      label: "Unavailable",
      tone: "degraded",
      detail: "No Hermes planner PTY session is bound.",
      inspectable: false,
    };
  }

  if (!snapshot) {
    return {
      label: "Planning",
      tone: "planning",
      detail: "Waiting for PTY lifecycle snapshot.",
      inspectable: true,
    };
  }

  if (snapshot.status === "starting") {
    return {
      label: "Planning",
      tone: "planning",
      detail: "PTY lifecycle: starting",
      inspectable: true,
    };
  }

  if (snapshot.status === "running") {
    return {
      label: "Running",
      tone: "running",
      detail: "PTY lifecycle: running",
      inspectable: true,
    };
  }

  if (snapshot.status === "waiting") {
    return {
      label: "Waiting",
      tone: "waiting",
      detail: "PTY lifecycle: waiting",
      inspectable: true,
    };
  }

  if (snapshot.status === "exited") {
    return {
      label: "Inspectable",
      tone: "inspectable",
      detail: "PTY lifecycle: exited",
      inspectable: true,
    };
  }

  if (snapshot.status === "unavailable") {
    return {
      label: "Unavailable",
      tone: "degraded",
      detail: snapshot.message ?? "PTY lifecycle snapshot is unavailable.",
      inspectable: false,
    };
  }

  return {
    label: "Blocked",
    tone: "blocked",
    detail: `PTY lifecycle: ${snapshot.status}`,
    inspectable: true,
  };
}
