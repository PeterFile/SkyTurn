import { inspect } from "node:util";

import { sanitizePublicPayloadText } from "@skyturn/project-core";

type FixtureAgentKind = "codex" | "hermes";

const maxDiagnosticChars = 4_096;
const maxDiagnosticEvents = 16;
const maxDiagnosticStringChars = 1_024;

interface WindowsFixtureInvocationInput {
  agentKind: FixtureAgentKind;
  canonicalWorkdir: string;
  fixturePath: string;
  prompt: string;
  resumeHandle: string;
}

interface WindowsFixtureInvocation {
  entryPoint: "exec" | "chat";
  extraArgs: string[];
  expectedFixtureArgv: string[];
}

interface WindowsFixtureStartFailureInput {
  agentKind: FixtureAgentKind;
  terminalPath: "cancel" | "timeout" | "normal-root-exit";
  missingMarker: string;
  events: unknown[];
  sensitiveValues: string[];
}

export function buildWindowsFixtureInvocation(
  input: WindowsFixtureInvocationInput,
): WindowsFixtureInvocation {
  const extraArgs = [input.fixturePath];
  if (input.agentKind === "codex") {
    return {
      entryPoint: "exec",
      extraArgs,
      expectedFixtureArgv: [
        "--json",
        "--ephemeral",
        "--color",
        "never",
        "--sandbox",
        "read-only",
        "-c",
        "approval_policy=never",
        input.fixturePath,
        "-C",
        input.canonicalWorkdir,
        input.prompt,
      ],
    };
  }
  return {
    entryPoint: "chat",
    extraArgs,
    expectedFixtureArgv: [
      "-q",
      input.prompt,
      "--quiet",
      "--source",
      "skyturn",
      "--resume",
      input.resumeHandle,
      input.fixturePath,
    ],
  };
}

export function formatWindowsFixtureStartFailure(
  input: WindowsFixtureStartFailureInput,
): string {
  const terminalEvents = input.events.filter(isTerminalDiagnosticEvent).slice(-maxDiagnosticEvents);
  const terminalSet = new Set(terminalEvents);
  const recentEvents = input.events
    .filter((event) => !terminalSet.has(event))
    .slice(-maxDiagnosticEvents);
  const sanitized = sanitizeDiagnosticValue(
    { terminalEvents, recentEvents },
    input.sensitiveValues.filter(Boolean),
  );
  const serialized = safeJsonStringify(sanitized);
  const prefix = `${input.agentKind} ${input.terminalPath} fixture did not create ${input.missingMarker}; authoritative events: `;
  if (prefix.length + serialized.length <= maxDiagnosticChars) return `${prefix}${serialized}`;
  return `${prefix}${serialized.slice(0, maxDiagnosticChars - prefix.length - 15)}... [truncated]`;
}

function isTerminalDiagnosticEvent(value: unknown): boolean {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const kind = (value as Record<string, unknown>).kind;
  return kind === "error" || kind === "evidence" || kind === "status";
}

function sanitizeDiagnosticValue(value: unknown, sensitiveValues: string[]): unknown {
  if (typeof value === "string") return sanitizeDiagnosticText(value, sensitiveValues);
  if (Array.isArray(value)) return value.map((item) => sanitizeDiagnosticValue(item, sensitiveValues));
  if (typeof value !== "object" || value === null) return value;
  return Object.fromEntries(
    Object.entries(value).map(([key, item]) => [key, sanitizeDiagnosticValue(item, sensitiveValues)]),
  );
}

function sanitizeDiagnosticText(value: string, sensitiveValues: string[]): string {
  let redacted = value;
  for (const representation of sensitiveRepresentations(sensitiveValues)) {
    redacted = redacted.replaceAll(representation, "[redacted]");
  }
  const sanitized = sanitizePublicPayloadText(redacted);
  if (sanitized.length <= maxDiagnosticStringChars) return sanitized;
  return `${sanitized.slice(0, maxDiagnosticStringChars - 15)}... [truncated]`;
}

function sensitiveRepresentations(values: string[]): string[] {
  const representations = new Set<string>();
  for (const value of values) {
    for (const part of [value, ...value.split(/\r?\n/)]) {
      if (part.length < 4) continue;
      representations.add(part);
      representations.add(JSON.stringify(part).slice(1, -1));
      representations.add(inspect(part));
    }
  }
  return [...representations].filter(Boolean).sort((left, right) => right.length - left.length);
}

function safeJsonStringify(value: unknown): string {
  try {
    return JSON.stringify(value);
  } catch {
    return '{"terminalEvents":[],"recentEvents":[],"serialization":"failed"}';
  }
}
