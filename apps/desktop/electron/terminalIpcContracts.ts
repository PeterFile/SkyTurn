import type {
  AgentKind,
  AgentTerminalSession,
  TerminalOutputStream,
  TerminalSessionEventDraft,
  TerminalSessionStatus,
} from "@skyturn/project-core" with { "resolution-mode": "import" };

export const TERMINAL_IPC_ERROR_PREFIX = "SKYTURN_TERMINAL_IPC_ERROR";

export const TERMINAL_IPC_CHANNELS = {
  start: "terminal:start",
  write: "terminal:write",
  resize: "terminal:resize",
  cancel: "terminal:cancel",
  snapshot: "terminal:snapshot",
} as const;

export const TERMINAL_IPC_EVENT_CHANNEL = "terminal:event";

export type TerminalIpcErrorCode = "INVALID_INPUT" | "UNKNOWN_PROJECT";
export type TerminalUnsupportedReasonCode =
  | "PTY_INTERACTIVE_DISABLED"
  | "PTY_MANAGER_UNAVAILABLE";
export type TerminalSnapshotUnavailableReasonCode = "TERMINAL_SESSION_NOT_FOUND";

export interface TerminalStartInput {
  projectRoot: string;
  canvasSessionId: string;
  runId: string;
  agentKind: AgentKind;
  cwd?: string;
  commandLabel?: string;
  rows?: number;
  cols?: number;
}

export interface TerminalWriteInput {
  terminalSessionId: string;
  data: string;
}

export interface TerminalResizeInput {
  terminalSessionId: string;
  rows: number;
  cols: number;
}

export interface TerminalCancelInput {
  terminalSessionId: string;
  reason?: string;
}

export interface TerminalSnapshotInput {
  terminalSessionId: string;
}

export interface TerminalActionResult {
  protocolVersion: number;
  ok: boolean;
  status: "accepted" | "unsupported" | "degraded";
  terminalSessionId?: string;
  reasonCode?: TerminalUnsupportedReasonCode;
  message?: string;
}

export interface TerminalStartResult extends TerminalActionResult {
  session?: AgentTerminalSession;
}

export interface TerminalSnapshotLine {
  sequence: number;
  text: string;
  stream: TerminalOutputStream;
  timestamp?: string;
}

export interface TerminalSnapshotCursor {
  row: number;
  col: number;
}

export interface TerminalSnapshotState {
  terminalSessionId: string;
  status: TerminalSessionStatus | "unavailable";
  sequence: number;
  rows: number;
  cols: number;
  cursor: TerminalSnapshotCursor;
  lines: TerminalSnapshotLine[];
  updatedAt?: string;
}

export interface TerminalSnapshotResult extends TerminalSnapshotState {
  protocolVersion: number;
  reasonCode?: TerminalUnsupportedReasonCode | TerminalSnapshotUnavailableReasonCode;
  message?: string;
}

export type TerminalRendererEvent = TerminalSessionEventDraft & {
  protocolVersion: number;
};

export function formatTerminalIpcError(code: TerminalIpcErrorCode, message: string): string {
  return `${TERMINAL_IPC_ERROR_PREFIX}:${code}: ${message}`;
}

export function terminalIpcError(code: TerminalIpcErrorCode, message: string): Error {
  return new Error(formatTerminalIpcError(code, message));
}

export function normalizeTerminalIpcError(error: unknown): Error {
  const message = error instanceof Error ? error.message : String(error);
  if (message.startsWith(`${TERMINAL_IPC_ERROR_PREFIX}:`)) return new Error(message);
  return terminalIpcError("INVALID_INPUT", message);
}

export function terminalStartInputError(input: unknown): TerminalIpcErrorCode | null {
  if (!isRecord(input)) return "INVALID_INPUT";
  if (!isNonEmptyString(input.projectRoot)) return "INVALID_INPUT";
  if (!isNonEmptyString(input.canvasSessionId)) return "INVALID_INPUT";
  if (!isNonEmptyString(input.runId)) return "INVALID_INPUT";
  if (!isAgentKind(input.agentKind)) return "INVALID_INPUT";
  if (!isOptionalNonEmptyString(input.cwd)) return "INVALID_INPUT";
  if (!isOptionalNonEmptyString(input.commandLabel)) return "INVALID_INPUT";
  if (!isOptionalPositiveInteger(input.rows)) return "INVALID_INPUT";
  if (!isOptionalPositiveInteger(input.cols)) return "INVALID_INPUT";
  return null;
}

export function terminalWriteInputError(input: unknown): TerminalIpcErrorCode | null {
  if (!isRecord(input)) return "INVALID_INPUT";
  if (!isNonEmptyString(input.terminalSessionId)) return "INVALID_INPUT";
  if (!isNonEmptyString(input.data)) return "INVALID_INPUT";
  return null;
}

export function terminalResizeInputError(input: unknown): TerminalIpcErrorCode | null {
  if (!isRecord(input)) return "INVALID_INPUT";
  if (!isNonEmptyString(input.terminalSessionId)) return "INVALID_INPUT";
  if (!isPositiveInteger(input.rows)) return "INVALID_INPUT";
  if (!isPositiveInteger(input.cols)) return "INVALID_INPUT";
  return null;
}

export function terminalCancelInputError(input: unknown): TerminalIpcErrorCode | null {
  if (!isRecord(input)) return "INVALID_INPUT";
  if (!isNonEmptyString(input.terminalSessionId)) return "INVALID_INPUT";
  if (!isOptionalNonEmptyString(input.reason)) return "INVALID_INPUT";
  return null;
}

export function terminalSnapshotInputError(input: unknown): TerminalIpcErrorCode | null {
  if (!isRecord(input)) return "INVALID_INPUT";
  if (!isNonEmptyString(input.terminalSessionId)) return "INVALID_INPUT";
  return null;
}

export function terminalUnsupportedResult(protocolVersion: number, featureEnabled: boolean): TerminalActionResult {
  if (!featureEnabled) {
    return {
      protocolVersion,
      ok: false,
      status: "unsupported",
      reasonCode: "PTY_INTERACTIVE_DISABLED",
      message: "PTY interactive terminal sessions are disabled.",
    };
  }
  return {
    protocolVersion,
    ok: false,
    status: "degraded",
    reasonCode: "PTY_MANAGER_UNAVAILABLE",
    message: "PTY terminal session manager is not available.",
  };
}

export function emptyTerminalSnapshot(protocolVersion: number, terminalSessionId: string): TerminalSnapshotResult {
  return {
    protocolVersion,
    terminalSessionId,
    status: "unavailable",
    sequence: 0,
    rows: 0,
    cols: 0,
    cursor: { row: 0, col: 0 },
    lines: [],
    reasonCode: "TERMINAL_SESSION_NOT_FOUND",
    message: "Terminal session is not available.",
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

function isOptionalNonEmptyString(value: unknown): boolean {
  return value === undefined || isNonEmptyString(value);
}

function isPositiveInteger(value: unknown): value is number {
  return Number.isInteger(value) && typeof value === "number" && value > 0 && value <= 1000;
}

function isOptionalPositiveInteger(value: unknown): boolean {
  return value === undefined || isPositiveInteger(value);
}

function isAgentKind(value: unknown): value is AgentKind {
  return (
    value === "hermes" ||
    value === "codex" ||
    value === "gemini" ||
    value === "claude-code" ||
    value === "openclaw"
  );
}
