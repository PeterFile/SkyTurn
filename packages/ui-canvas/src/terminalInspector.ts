import type { TerminalSnapshotResult } from "@skyturn/persistence";

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
