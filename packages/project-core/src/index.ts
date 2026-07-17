export type WorkflowMode = "fast" | "plan";
export type SessionKind = "plan" | "canvas";
export type PlanStage = "requirements" | "design" | "tasks";
export type PlanStageStatus = "pending" | "generating" | "ready" | "revising" | "failed";
export type PlanOperation = "generate" | "revise";
export type AgentKind = "hermes" | "codex" | "agy" | "gemini" | "claude-code" | "openclaw";
export type NodeStatus = "pending" | "running" | "retrying" | "completed" | "failed";
export type NodeRollbackStatus = "rolled_back" | "inactive" | "rejected";
export type NodeLifecyclePhase =
  | "Queued"
  | "Think"
  | "Planning"
  | "Executing"
  | "Testing"
  | "Validating"
  | "Retrying"
  | "Summarizing"
  | "Completed"
  | "Failed";
export type NodeModalTab = "Output" | "Changes" | "Context";
export type AgentAvailabilityStatus = "available" | "missing" | "needs-auth" | "unhealthy";
export type AgentSupportLevel = "mock-only" | "detected-only" | "experimental-run" | "supported-run";
export type AgentReadinessLevel = "unavailable" | "detected-only" | "experimental-run";
export type AgentAuthReadinessStatus = "available" | "missing" | "unknown";
export type AgentReadinessCategory = "cli-missing" | "auth-missing" | "auth-unknown" | "version-probe-failed";
export type AgentTransportKind = "exec-json" | "pty-interactive";
export type TerminalSessionStatus =
  | "starting"
  | "running"
  | "waiting"
  | "exited"
  | "timed-out"
  | "cancelled"
  | "failed";
export type TerminalSessionEventKind = "output" | "progress" | "lifecycle";
export type TerminalOutputStream = "stdout" | "stderr";
export type AgentCapability =
  | "chat"
  | "file-read"
  | "file-write"
  | "shell"
  | "software-control"
  | "mcp"
  | "worktree"
  | "resume";
export type AgentRunStatus =
  | "queued"
  | "running"
  | "waiting-input"
  | "requires-approval"
  | "succeeded"
  | "failed"
  | "cancelled"
  | "timed-out";

export function isTerminalAgentRunStatus(status: AgentRunStatus): boolean {
  return status === "succeeded" || status === "failed" || status === "cancelled" || status === "timed-out";
}

export function reduceAgentRunStatus(
  current: AgentRunStatus,
  transition: AgentRunStatus | "error",
): AgentRunStatus {
  if (isTerminalAgentRunStatus(current)) return current;
  return transition === "error" ? "failed" : transition;
}
export type AgentRunSandbox = "read-only" | "workspace-write" | "danger-full-access";
export type RunEventKind = "output" | "status" | "error" | "approval" | "progress" | "evidence" | "changes";
export type EvidenceCheckStatus = "passed" | "failed" | "skipped";
export type EvidenceCheckKind =
  | "run-exit"
  | "run-timeout"
  | "artifact"
  | "git"
  | "test"
  | "typecheck"
  | "build"
  | "review";
export type HermesPlannerTransport = "hermes_live_chat" | "hermes_session_resume" | "hermes_replay_recovery";
export type SessionExecutionTarget = "current_branch" | "new_worktree";
export type WorkflowLaneKind =
  | "discovery"
  | "design"
  | "implementation"
  | "fix"
  | "validation"
  | "regression"
  | "review"
  | "commit"
  | "pull_request"
  | "join"
  | "decision";
export type WorkflowLaneSemanticSubtype =
  | "coding"
  | "frontend_implementation"
  | "backend_implementation"
  | "persistence_implementation"
  | "repair"
  | "browser_validation"
  | "unit_test"
  | "integration_test"
  | "fixture_validation"
  | "regression_check"
  | "evidence_review"
  | "commit"
  | (string & {});
export type WorkflowProjectionNodeKind = "agent_task" | "user_decision";
export type WorkflowRuntimePolicySource = "workflow_projection";
export type WorkflowSideEffectKind = "filesystem" | "git" | "network" | "process" | "artifact";
export type UserDecisionAction = "backtrack" | "parallel_worktree" | "continue" | "abort";
export type UserDecisionNodeStatus = "waiting_input" | "answered";
export type WorkflowVariantAdoptionStrategy = "merge" | "cherry-pick";
export type WorkflowVariantAdoptionStatus = "requested" | "adopted" | "failed" | "rejected";
export type WorkflowNodeCheckpointPhase = "before" | "after";
export type WorkflowNodeCheckpointSource = "agent_bridge" | "workflow_kernel" | "backend" | "user";
export type WorkflowCheckpointWorktreeState = "clean" | "dirty";
export type WorkflowCheckpointEvidenceRefKind = "run" | "segment" | "evidence" | "changeset" | "artifact" | "commit";
export type WorkflowRemoteSideEffectEventKind =
  | "workflow.delivery.pushed"
  | "workflow.pull_request.created"
  | "workflow.pull_request.merged"
  | "workflow.delivery.main_synced";
export type WorkflowRemoteSideEffectStatus = "recorded" | "in_flight";
export type WorkflowRollbackLocalSafetyStatus =
  | "unknown"
  | "safe"
  | "unsafe"
  | "not_required"
  | "manual_repair_required"
  | "already_restored";
export type WorkflowCheckpointIntentKind = "rollback" | "repair" | "variant" | "fork";
export type WorkflowCheckpointIntentStatus = "requested" | "applied" | "rejected";
export type ChangesetEvidenceStatus = "available" | "empty" | "failed" | "unknown";
export type LiveRunChangeOperation = "add" | "delete" | "update" | "move";
export type FinalChangesetReconciliationStatus = "available" | "empty" | "failed" | "mismatch";

export const NODE_MODAL_TABS: NodeModalTab[] = ["Output", "Changes", "Context"];
export const RUN_EVENT_PROTOCOL_VERSION = 1;
export const AGENT_TRANSPORT_KINDS: AgentTransportKind[] = ["exec-json", "pty-interactive"];
export const TERMINAL_SESSION_STATUSES: TerminalSessionStatus[] = [
  "starting",
  "running",
  "waiting",
  "exited",
  "timed-out",
  "cancelled",
  "failed",
];
export const DEFAULT_AGENT_TRANSPORT_FEATURE_FLAGS: AgentTransportFeatureFlags = {
  ptyInteractiveSessions: false,
};
export const DEFAULT_SESSION_TARGET: SessionTarget = {
  executionTarget: "current_branch",
  selectedBranch: "HEAD",
};
export const WORKFLOW_LANE_KINDS: WorkflowLaneKind[] = [
  "discovery",
  "design",
  "implementation",
  "fix",
  "validation",
  "regression",
  "review",
  "commit",
  "pull_request",
  "join",
  "decision",
];
export const EVIDENCE_CHECK_KINDS: EvidenceCheckKind[] = [
  "run-exit",
  "run-timeout",
  "artifact",
  "git",
  "test",
  "typecheck",
  "build",
  "review",
];
const EVIDENCE_CHECK_STATUSES: EvidenceCheckStatus[] = ["passed", "failed", "skipped"];
const assignedAbsolutePathInTextPattern =
  /\bcwd=(?:(["'])(?:\/|[A-Za-z]:[\\/]).*?\1|(?:\/|[A-Za-z]:[\\/]).*?(?=\s+(?:["'(]|[A-Za-z_][\w-]*=)|$))/gi;
const quotedAbsolutePathInTextPattern = /(["'])(?:\/|[A-Za-z]:[\\/]).*?\1/g;
const bracketedAbsolutePathInTextPattern = /([([{])(?:\/|[A-Za-z]:[\\/]).*?([)\]}])/g;
const absolutePathInTextPattern = /(^|[\s=:([{])((?:\/(?:[^\s/]+\/)*|[A-Za-z]:[\\/](?:[^\s\\/]+[\\/])*)[^\s"'()\[\]{}<>]*)/g;
const trailingPathPunctuationPattern = /[.,;!?]+$/;
const secretAssignmentPattern =
  /(["']?)(api[_-]?key|access[_-]?token|refresh[_-]?token|id[_-]?token|token|OPENAI_API_KEY|HERMES_API_KEY|ANTHROPIC_API_KEY)\1(\s*[:=]\s*)(["']?)[^\s,'"}]{8,}\4/gi;
export const AGENT_SUPPORT_LEVELS: AgentSupportLevel[] = [
  "mock-only",
  "detected-only",
  "experimental-run",
  "supported-run",
];

export interface AgentDescriptor {
  kind: AgentKind;
  label: string;
  executablePath: string | null;
  version: string | null;
  status: AgentAvailabilityStatus;
  supportLevel: AgentSupportLevel;
  capabilities: AgentCapability[];
  transportCapabilities?: AgentTransportCapabilities;
  configFiles: string[];
  readiness?: {
    level: AgentReadinessLevel;
    cli: {
      available: boolean;
      path: string | null;
      version: string | null;
    };
    auth: {
      status: AgentAuthReadinessStatus;
      source?: "environment";
    };
    categories: AgentReadinessCategory[];
  };
}

export interface AgentTransportCapabilities {
  supportsExecJson: boolean;
  supportsPtyInteractive: boolean;
  supportsResume: boolean;
  supportsStructuredEvents: boolean;
}

export interface AgentTransportFeatureFlags {
  ptyInteractiveSessions: boolean;
}

export interface AgentTerminalSession {
  id: string;
  runId: string;
  canvasSessionId: string;
  agentKind: AgentKind;
  cwd: string;
  commandLabel: string;
  transport: "pty-interactive";
  status: TerminalSessionStatus;
  createdAt: string;
  endedAt?: string;
}

export interface TerminalSessionEventDraftBase {
  terminalSessionId: string;
  runId: string;
  timestamp?: string;
}

export interface TerminalOutputChunkEventDraft extends TerminalSessionEventDraftBase {
  kind: "output";
  stream: TerminalOutputStream;
  text: string;
}

export interface TerminalProgressEventDraft extends TerminalSessionEventDraftBase {
  kind: "progress";
  message: string;
}

export interface TerminalLifecycleEventDraft extends TerminalSessionEventDraftBase {
  kind: "lifecycle";
  status: TerminalSessionStatus;
  message?: string;
}

export type TerminalSessionEventDraft =
  | TerminalOutputChunkEventDraft
  | TerminalProgressEventDraft
  | TerminalLifecycleEventDraft;

export type AgentWorkflowReadinessStatus = "ready" | "degraded" | "blocked" | "mock-only";
export type AgentWorkflowRunSupport = "supported-run" | "experimental-run" | "mock-only" | "unavailable";
export type AgentWorkflowReadinessCheckStatus = "ready" | "missing" | "unknown";
export type AgentWorkflowReadinessReason =
  | "hermes-cli-missing"
  | "codex-cli-missing"
  | "agy-cli-missing"
  | "hermes-auth-missing"
  | "codex-auth-missing"
  | "hermes-auth-unknown"
  | "codex-auth-unknown"
  | "experimental-run"
  | "supported-run"
  | "mock-only-fallback";

export interface AgentWorkflowReadinessChecks {
  hermesCli: AgentWorkflowReadinessCheckStatus;
  codexCli: AgentWorkflowReadinessCheckStatus;
  agyCli: AgentWorkflowReadinessCheckStatus;
  hermesAuth: AgentAuthReadinessStatus;
  codexAuth: AgentAuthReadinessStatus;
  mockFallback: boolean;
}

export interface AgentWorkflowReadinessSummary {
  status: AgentWorkflowReadinessStatus;
  runSupport: AgentWorkflowRunSupport;
  message: string;
  reasons: AgentWorkflowReadinessReason[];
  checks: AgentWorkflowReadinessChecks;
}

export function summarizeAgentReadiness(agents: readonly AgentDescriptor[]): AgentWorkflowReadinessSummary {
  const hermes = agentByKind(agents, "hermes");
  const codex = agentByKind(agents, "codex");
  const agy = agentByKind(agents, "agy");
  const checks: AgentWorkflowReadinessChecks = {
    hermesCli: agentCliCheck(hermes),
    codexCli: agentCliCheck(codex),
    agyCli: agentCliCheck(agy),
    hermesAuth: agentAuthCheck(hermes),
    codexAuth: agentAuthCheck(codex),
    mockFallback: agents.some((agent) => agent.supportLevel === "mock-only"),
  };
  const reasons: AgentWorkflowReadinessReason[] = [];

  if (checks.hermesCli === "missing") reasons.push("hermes-cli-missing");
  if (checks.codexCli === "missing") reasons.push("codex-cli-missing");
  if (checks.agyCli === "missing") reasons.push("agy-cli-missing");
  if (checks.hermesAuth === "missing") reasons.push("hermes-auth-missing");
  if (checks.codexAuth === "missing") reasons.push("codex-auth-missing");
  if (checks.hermesAuth === "unknown") reasons.push("hermes-auth-unknown");
  if (checks.codexAuth === "unknown") reasons.push("codex-auth-unknown");

  const cliBlocked = checks.hermesCli === "missing" || checks.codexCli === "missing";
  const authBlocked = checks.hermesAuth === "missing" || checks.codexAuth === "missing";
  const realCliReady = checks.hermesCli === "ready" && checks.codexCli === "ready";
  const realExperimental = [hermes, codex].some((agent) => agent?.supportLevel === "experimental-run");
  const realSupported = [hermes, codex].every((agent) => agent?.supportLevel === "supported-run");

  if (checks.mockFallback && !realCliReady) {
    reasons.push("mock-only-fallback");
    return {
      status: "mock-only",
      runSupport: "mock-only",
      message: agentReadinessMessage(
        "Mock fallback only; install and authenticate Hermes and Codex for real workflow runs.",
        checks,
      ),
      reasons: uniqueReadinessReasons(reasons),
      checks,
    };
  }

  if (realExperimental) reasons.push("experimental-run");
  if (realSupported) reasons.push("supported-run");

  if (cliBlocked || authBlocked) {
    return {
      status: "blocked",
      runSupport: "unavailable",
      message: agentReadinessMessage(blockedAgentReadinessMessage(checks), checks),
      reasons: uniqueReadinessReasons(reasons),
      checks,
    };
  }

  if (!realCliReady) {
    return {
      status: "blocked",
      runSupport: "unavailable",
      message: agentReadinessMessage(
        "Hermes and Codex CLI readiness could not be verified for real workflow runs.",
        checks,
      ),
      reasons: uniqueReadinessReasons(reasons),
      checks,
    };
  }

  if (checks.hermesAuth === "unknown" || checks.codexAuth === "unknown" || realExperimental) {
    return {
      status: "degraded",
      runSupport: realExperimental ? "experimental-run" : "supported-run",
      message: agentReadinessMessage(
        "Real loop available in experimental mode; verify agent auth before relying on long runs.",
        checks,
      ),
      reasons: uniqueReadinessReasons(reasons),
      checks,
    };
  }

  return {
    status: "ready",
    runSupport: "supported-run",
    message: agentReadinessMessage("Real loop ready.", checks),
    reasons: uniqueReadinessReasons(reasons),
    checks,
  };
}

function agentByKind(agents: readonly AgentDescriptor[], kind: AgentKind): AgentDescriptor | undefined {
  return agents.find((agent) => agent.kind === kind);
}

function agentCliCheck(agent: AgentDescriptor | undefined): AgentWorkflowReadinessCheckStatus {
  if (!agent) return "missing";
  if (agent.supportLevel === "mock-only") return "unknown";
  if (agent.readiness?.cli.available === false) return "missing";
  if (agent.readiness?.cli.available === true) return "ready";
  if (agent.status === "missing" || !agent.executablePath) return "missing";
  if (agent.status === "available") return "ready";
  return "unknown";
}

function agentAuthCheck(agent: AgentDescriptor | undefined): AgentAuthReadinessStatus {
  if (!agent || agent.supportLevel === "mock-only") return "unknown";
  return agent.readiness?.auth.status ?? "unknown";
}

function blockedAgentReadinessMessage(checks: AgentWorkflowReadinessChecks): string {
  if (checks.hermesCli === "missing") return "Hermes CLI missing; install Hermes before starting real planner runs.";
  if (checks.codexCli === "missing") return "Codex CLI missing; install Codex before starting real executor runs.";
  if (checks.hermesAuth === "missing") return "Hermes auth missing; authenticate Hermes before starting real planner runs.";
  if (checks.codexAuth === "missing") return "Codex auth missing; authenticate Codex before starting real executor runs.";
  return "Agent readiness blocked.";
}

function agentReadinessMessage(message: string, checks: AgentWorkflowReadinessChecks): string {
  if (checks.agyCli !== "missing") return message;
  return `${message} Antigravity CLI optional detected-only design agent not detected.`;
}

function uniqueReadinessReasons(reasons: AgentWorkflowReadinessReason[]): AgentWorkflowReadinessReason[] {
  return [...new Set(reasons)];
}

export interface AgentRun {
  id: string;
  nodeId: string;
  sessionId: string;
  plannerSessionId?: string;
  plannerInputId?: string;
  projectRoot: string;
  worktreePath: string;
  agentKind: AgentKind;
  transport?: AgentTransportKind;
  status: AgentRunStatus;
  startedAt: string;
  endedAt?: string;
}

export interface StartAgentRunInput {
  protocolVersion: typeof RUN_EVENT_PROTOCOL_VERSION;
  runId?: string;
  nodeId: string;
  sessionId: string;
  plannerSessionId?: string;
  plannerInputId?: string;
  hermesSessionHandle?: string;
  projectRoot: string;
  worktreePath: string;
  agentKind: AgentKind;
  transport?: AgentTransportKind;
  sandbox?: AgentRunSandbox;
  /** An omitted or empty declaration imposes no artifact requirements. */
  expectedArtifacts?: string[];
  prompt: string;
}

export interface RunEvent {
  protocolVersion: typeof RUN_EVENT_PROTOCOL_VERSION;
  runId: string;
  seq: number;
  timestamp: string;
  kind: RunEventKind;
  payload: Record<string, unknown>;
}

export interface EvidenceCheck {
  kind: EvidenceCheckKind;
  name: string;
  status: EvidenceCheckStatus;
  detail?: string;
}

export function parseRunEvidenceChecks(value: unknown): EvidenceCheck[] | null {
  if (!Array.isArray(value)) return null;
  const checks: EvidenceCheck[] = [];
  for (const item of value) {
    if (!isRecord(item)) return null;
    const candidate = item;
    if (!EVIDENCE_CHECK_KINDS.includes(candidate.kind as EvidenceCheckKind)) return null;
    if (!EVIDENCE_CHECK_STATUSES.includes(candidate.status as EvidenceCheckStatus)) return null;
    if (typeof candidate.name !== "string" || !candidate.name.trim() || hasAsciiControl(candidate.name)) return null;
    if (candidate.detail !== undefined && (typeof candidate.detail !== "string" || hasAsciiControl(candidate.detail))) return null;
    checks.push({
      kind: candidate.kind as EvidenceCheckKind,
      name: sanitizeEvidenceCheckText(candidate.name),
      status: candidate.status as EvidenceCheckStatus,
      ...(typeof candidate.detail === "string" ? { detail: sanitizeEvidenceCheckText(candidate.detail) } : {}),
    });
  }
  return checks;
}

const publicEvidenceTextLimit = 320;
const acceptanceArtifactPrefix = ".devflow/acceptance/";
export const BROWSER_SCREENSHOT_EXPECTED_ARTIFACT = ".devflow/acceptance/react-app.png";
const artifactNameSeparatorPattern = /[\p{Separator}\p{Punctuation}\u2212]+/gu;
const sensitiveArtifactTokens = new Set([
  "auth",
  "credential",
  "credentials",
  "key",
  "keys",
  "passwd",
  "password",
  "passwords",
  "secret",
  "secrets",
  "shadow",
  "token",
  "tokens",
]);
const sensitiveArtifactExtensions = new Set(["der", "jks", "key", "keystore", "p12", "pem", "pfx"]);
const privateKeyIds = new Set(["dsa", "ecdsa", "ed25519", "rsa"]);
const narrowServiceAccountReportPattern = /^service\.account\.(?:acceptance|audit|migration|validation)\.(?:report|results?|summary)\.json$/;
const boundedCompactSensitiveFamilyRoots = [
  "accesstoken",
  "accesstokens",
  "accesskey",
  "accesskeys",
  "apitoken",
  "apitokens",
  "apikey",
  "apikeys",
  "authtoken",
  "authtokens",
  "authkey",
  "authkeys",
  "credential",
  "credentials",
  "passwd",
  "password",
  "passwords",
  "secret",
  "secrets",
  "token",
  "tokens",
  "key",
  "keys",
].sort((left, right) => right.length - left.length);
const compactSensitiveSuffixes = [
  "configuration",
  "credentials",
  "validation",
  "acceptance",
  "migration",
  "certificate",
  "keystore",
  "original",
  "snapshot",
  "archive",
  "backups",
  "results",
  "summary",
  "backup",
  "private",
  "report",
  "export",
  "config",
  "saved",
  "result",
  "store",
  "copy",
  "data",
  "file",
  "orig",
  "audit",
  "dump",
  "sqlite",
  "json",
  "yaml",
  "text",
  "jks",
  "p12",
  "pfx",
  "pem",
  "der",
  "key",
  "bak",
  "old",
  "txt",
  "yml",
  "xml",
  "csv",
  "tar",
  "zip",
  "gz",
  "db",
].sort((left, right) => right.length - left.length);
const compactPrivateContainerRoots = [
  "certificate",
  "clientcertificate",
  "servercertificate",
  "sslcertificate",
  "tlscertificate",
  "privatekey",
  "clientprivatekey",
  "serverprivatekey",
  "signingprivatekey",
  "sslprivatekey",
  "sshprivatekey",
  "tlsprivatekey",
  "clientprivate",
  "serverprivate",
  "signingprivate",
  "sslprivate",
  "sshprivate",
  "tlsprivate",
];
const compactSensitiveArtifactFamilies = [
  "authorizedkeys",
  "knownhosts",
  "serviceaccount",
  ...boundedCompactSensitiveFamilyRoots,
  ...[...privateKeyIds].map((keyId) => `id${keyId}`),
  ...compactPrivateContainerRoots.filter((root) => root.endsWith("key")),
  ...compactPrivateContainerRoots.flatMap((root) =>
    ["pem", "der", "p12", "pfx"].map((extension) => `${root}${extension}`)
  ),
].sort((left, right) => right.length - left.length);

export function parseExpectedArtifactDeclaration(value: unknown): string | null {
  if (typeof value !== "string" || !value || /[\x00-\x1f\x7f]/.test(value)) return null;
  if (value.includes("\\") || value.startsWith("/") || /^[A-Za-z]:[\\/]/.test(value)) return null;
  const normalized = value;
  const components = normalized.split("/");
  if (!normalized.startsWith(acceptanceArtifactPrefix) || components.some((part) => !part || part === "." || part === "..")) return null;
  if (/[<>|:]/.test(normalized) || /(?:^|\/)(?:symlink|link)(?:$|[-_.])/i.test(normalized)) return null;
  if (components.some(isSensitiveArtifactComponent)) return null;
  return normalized;
}

function isSensitiveArtifactComponent(value: string): boolean {
  const key = sensitiveArtifactFoldKey(value);
  if (narrowServiceAccountReportPattern.test(key)) return false;
  const tokens = key.split(".").filter(Boolean);
  const compact = tokens.join("");
  if (key === ".env" || key.startsWith(".env.") || key === ".npmrc" || key.startsWith(".npmrc.")) return true;
  if (isSensitiveCompactArtifactFamily(compact)) return true;
  if (tokens[0] === "cookies" && tokens[1] === "sqlite") return true;
  if (tokens[0] === "id" && privateKeyIds.has(tokens[1] ?? "")) return true;
  return tokens.some((token) => sensitiveArtifactTokens.has(token) || sensitiveArtifactExtensions.has(token));
}

function isSensitiveCompactArtifactFamily(compact: string): boolean {
  return compactSensitiveArtifactFamilies.some((root) => hasBoundedCompactSuffixChain(compact, root));
}

function hasBoundedCompactSuffixChain(value: string, root: string): boolean {
  if (!value.startsWith(root)) return false;
  let suffix = value.slice(root.length);
  while (suffix) {
    const digits = /^\d+/.exec(suffix)?.[0];
    if (digits) {
      suffix = suffix.slice(digits.length);
      continue;
    }
    const atom = compactSensitiveSuffixes.find((candidate) => suffix.startsWith(candidate));
    if (!atom) return false;
    suffix = suffix.slice(atom.length);
  }
  return true;
}

function sensitiveArtifactFoldKey(value: string): string {
  return value
    .normalize("NFKC")
    .toLowerCase()
    .replaceAll(artifactNameSeparatorPattern, ".")
    .replace(/\.{2,}/g, ".");
}

export function parseExpectedArtifactDeclarations(value: unknown): string[] | null {
  if (!Array.isArray(value)) return null;
  const artifacts: string[] = [];
  const seen = new Set<string>();
  for (const item of value) {
    const normalized = parseExpectedArtifactDeclaration(item);
    if (!normalized) return null;
    const key = expectedArtifactDeclarationKey(normalized);
    if (seen.has(key)) return null;
    seen.add(key);
    artifacts.push(normalized);
  }
  return artifacts;
}

export function canonicalExpectedArtifactDeclarationKeys(value: unknown): string[] | null {
  const declarations = parseExpectedArtifactDeclarations(value);
  return declarations ? declarations.map(expectedArtifactDeclarationKey).sort() : null;
}

function expectedArtifactDeclarationKey(declaration: string): string {
  return declaration.normalize("NFKC").toLowerCase();
}

export function parseRunEvidenceArtifacts(value: unknown): string[] | null {
  return parseExpectedArtifactDeclarations(value);
}

export function expectedArtifactContractForRequiredEvidence(
  value: unknown,
): { required: boolean; declarations: string[] } {
  const requiredEvidence = Array.isArray(value)
    ? value.filter((kind): kind is string => typeof kind === "string")
    : [];
  const browserScreenshotRequired = requiredEvidence.some((kind) => /^(?:browser|screenshot)$/i.test(kind));
  const required = browserScreenshotRequired || requiredEvidence.some((kind) => /^artifact$/i.test(kind));
  return {
    required,
    declarations: browserScreenshotRequired ? [BROWSER_SCREENSHOT_EXPECTED_ARTIFACT] : [],
  };
}

function hasAsciiControl(value: string): boolean {
  return /[\x00-\x1f\x7f]/.test(value);
}

export function sanitizePublicEvidenceText(value: unknown): string {
  if (typeof value !== "string") return "";
  let sanitized = value
    .trim()
    .replace(/\b(?:Authorization:\s*)?Bearer\s+\S+/gi, "Bearer [redacted]")
    .replace(/\bsk-[A-Za-z0-9_-]{6,}\b/g, "[redacted]")
    .replace(secretAssignmentPattern, "$1$2$1$3$4[redacted]$4")
    .replace(/\b(password|passwd|credential|secret|token|api[_-]?key)\s*[:=]\s*\S+/gi, "$1=[redacted]")
    .replace(assignedAbsolutePathInTextPattern, (match) => redactAbsolutePath(match, "cwd="))
    .replace(quotedAbsolutePathInTextPattern, (match, quote: string) => `${quote}[redacted-path]${quote}`)
    .replace(bracketedAbsolutePathInTextPattern, (_match, opening: string, closing: string) => `${opening}[redacted-path]${closing}`)
    .replace(absolutePathInTextPattern, (_match, prefix: string, path: string) => `${prefix}[redacted-path]${path.match(trailingPathPunctuationPattern)?.[0] ?? ""}`)
    .replace(/\.env(?:\.[A-Za-z0-9_-]+)?|\b(?:id[_-]?(?:rsa|dsa|ecdsa|ed25519)|authorized[_-]?keys|known[_-]?hosts|shadow|credentials?(?:\.\w+)?|secrets?(?:\.\w+)?|tokens?(?:\.\w+)?)\b/gi, "[redacted]")
    .replace(/\s+/g, " ");
  if (sanitized.length > publicEvidenceTextLimit) sanitized = `${sanitized.slice(0, publicEvidenceTextLimit - 15).trimEnd()}... [truncated]`;
  return sanitized;
}

export function sanitizePublicPayloadText(value: unknown): string {
  if (typeof value !== "string") return "";
  return value
    .replace(/\b(?:Authorization:\s*)?Bearer\s+\S+/gi, "Bearer [redacted]")
    .replace(/\bsk-[A-Za-z0-9_-]{6,}\b/g, "[redacted]")
    .replace(secretAssignmentPattern, "$1$2$1$3$4[redacted]$4")
    .replace(/\b(password|passwd|credential|secret|token|api[_-]?key)\s*[:=]\s*\S+/gi, "$1=[redacted]")
    .replace(assignedAbsolutePathInTextPattern, (match) => redactAbsolutePath(match, "cwd="))
    .replace(quotedAbsolutePathInTextPattern, (match, quote: string) => `${quote}[redacted-path]${quote}`)
    .replace(bracketedAbsolutePathInTextPattern, (_match, opening: string, closing: string) => `${opening}[redacted-path]${closing}`)
    .replace(absolutePathInTextPattern, (_match, prefix: string, path: string) => `${prefix}[redacted-path]${path.match(trailingPathPunctuationPattern)?.[0] ?? ""}`)
    .replace(/\.env(?:\.[A-Za-z0-9_-]+)?|\b(?:id[_-]?(?:rsa|dsa|ecdsa|ed25519)|authorized[_-]?keys|known[_-]?hosts|shadow|credentials?(?:\.\w+)?|secrets?(?:\.\w+)?|tokens?(?:\.\w+)?)\b/gi, "[redacted]");
}

function redactAbsolutePath(match: string, prefix: string): string {
  const punctuation = match.match(trailingPathPunctuationPattern)?.[0] ?? "";
  return `${prefix}[redacted-path]${punctuation}`;
}

function sanitizeEvidenceCheckText(value: string): string {
  return sanitizePublicEvidenceText(value);
}

export interface RunEvidence {
  runId: string;
  status: AgentRunStatus;
  exitCode: number | null;
  changesetId: string | null;
  checks: EvidenceCheck[];
  artifacts: string[];
  review: EvidenceCheck | null;
  errorReason: string | null;
  cancelReason: string | null;
  completedAt: string | null;
}

export function sanitizeTrustedRunEvidence(evidence: RunEvidence): RunEvidence {
  const checks = uniqueEvidenceChecks(evidence.checks.map(sanitizeTrustedEvidenceCheck));
  const review = evidence.review ? sanitizeTrustedEvidenceCheck(evidence.review) : null;
  const artifacts: string[] = [];
  const artifactKeys = new Set<string>();
  let artifactsValid = true;
  for (const candidate of evidence.artifacts) {
    const artifact = parseExpectedArtifactDeclaration(candidate);
    if (!artifact) {
      artifactsValid = false;
      continue;
    }
    const key = artifact.toLowerCase();
    if (artifactKeys.has(key)) continue;
    artifactKeys.add(key);
    artifacts.push(artifact);
  }
  const failedArtifactGate = checks.some((check) => check.kind === "artifact" && check.status === "failed");
  const mustFail = failedArtifactGate || !artifactsValid;
  const status = mustFail && evidence.status !== "failed" && evidence.status !== "cancelled" && evidence.status !== "timed-out"
    ? "failed"
    : evidence.status;
  return {
    runId: evidence.runId,
    status,
    exitCode: evidence.exitCode,
    changesetId: sanitizePublicEvidenceText(evidence.changesetId) || null,
    checks,
    artifacts: mustFail ? [] : artifacts,
    review,
    errorReason: sanitizePublicEvidenceText(evidence.errorReason) || null,
    cancelReason: sanitizePublicEvidenceText(evidence.cancelReason) || null,
    completedAt: evidence.completedAt,
  };
}

export function sanitizeRunEvidence(evidence: RunEvidence): RunEvidence {
  return sanitizeTrustedRunEvidence(evidence);
}

function sanitizeTrustedEvidenceCheck(check: EvidenceCheck): EvidenceCheck {
  return {
    kind: check.kind,
    name: sanitizeEvidenceCheckText(check.name),
    status: check.status,
    ...(check.detail !== undefined ? { detail: sanitizeEvidenceCheckText(check.detail) } : {}),
  };
}

function uniqueEvidenceChecks(checks: EvidenceCheck[]): EvidenceCheck[] {
  const seen = new Set<string>();
  return checks.filter((check) => {
    const key = `${check.kind}\0${check.name}\0${check.status}\0${check.detail ?? ""}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

export function parseRunEvidence(value: unknown): RunEvidence | null {
  if (!isRecord(value)) return null;
  if (typeof value.runId !== "string" || !value.runId.trim() || hasAsciiControl(value.runId)) return null;
  if (!isAgentRunStatus(value.status)) return null;
  if (value.exitCode !== null && (typeof value.exitCode !== "number" || !Number.isInteger(value.exitCode) || value.exitCode < 0)) return null;
  if (value.changesetId !== null && typeof value.changesetId !== "string") return null;
  if (!Array.isArray(value.checks) || !Array.isArray(value.artifacts)) return null;
  if (value.review !== null && !isRecord(value.review)) return null;
  if (value.errorReason !== null && typeof value.errorReason !== "string") return null;
  if (value.cancelReason !== null && typeof value.cancelReason !== "string") return null;
  if (value.completedAt !== null && (typeof value.completedAt !== "string" || Number.isNaN(Date.parse(value.completedAt)))) return null;
  const checks = parseRunEvidenceChecks(value.checks);
  const artifacts = parseRunEvidenceArtifacts(value.artifacts);
  const review = value.review === null ? null : parseRunEvidenceChecks([value.review]);
  if (!checks || !artifacts || (value.review !== null && (!review || review.length !== 1))) return null;
  return sanitizeTrustedRunEvidence({
    runId: value.runId,
    status: value.status,
    exitCode: value.exitCode,
    changesetId: value.changesetId,
    checks,
    artifacts,
    review: review?.[0] ?? null,
    errorReason: sanitizePublicEvidenceText(value.errorReason) || null,
    cancelReason: sanitizePublicEvidenceText(value.cancelReason) || null,
    completedAt: value.completedAt,
  });
}

export function parseRunEvent(value: unknown): RunEvent | null {
  if (!isRecord(value)) return null;
  if (value.protocolVersion !== RUN_EVENT_PROTOCOL_VERSION) return null;
  if (typeof value.runId !== "string" || !value.runId.trim() || hasAsciiControl(value.runId)) return null;
  if (typeof value.seq !== "number" || !Number.isInteger(value.seq) || value.seq < 1) return null;
  if (typeof value.timestamp !== "string" || Number.isNaN(Date.parse(value.timestamp))) return null;
  if (!isRunEventKind(value.kind) || !isRecord(value.payload)) return null;

  const payload = sanitizeRunEventRecord(value.payload);
  if (value.kind === "output" && typeof value.payload.text !== "string") return null;
  if (value.kind === "error" && typeof value.payload.message !== "string") return null;
  if (value.kind === "status" && !isAgentRunStatus(value.payload.status)) return null;
  if (!validOptionalExitCode(value.payload.exitCode)) return null;
  if (!validOptionalText(value.payload.reason) || !validOptionalText(value.payload.errorReason)) return null;

  if ("checks" in value.payload) {
    const checks = parseRunEvidenceChecks(value.payload.checks);
    if (!checks) return null;
    payload.checks = checks;
  }
  if ("artifacts" in value.payload) {
    const artifacts = parseRunEvidenceArtifacts(value.payload.artifacts);
    if (!artifacts) return null;
    payload.artifacts = artifacts;
  }
  if ("review" in value.payload) {
    if (value.payload.review === null) {
      payload.review = null;
    } else {
      const review = parseRunEvidenceChecks([value.payload.review]);
      if (!review || review.length !== 1) return null;
      payload.review = review[0];
    }
  }
  return {
    protocolVersion: RUN_EVENT_PROTOCOL_VERSION,
    runId: value.runId,
    seq: value.seq,
    timestamp: value.timestamp,
    kind: value.kind,
    payload,
  };
}

const losslessRunEventPayloadKeys = new Set([
  "code",
  "diff",
  "output",
  "patch",
  "patchPreview",
  "text",
  "unified_diff",
  "unifiedDiff",
]);

const compactRunEventMetadataKeys = new Set([
  "category",
  "command",
  "eventType",
  "file",
  "filePath",
  "format",
  "header",
  "kind",
  "label",
  "language",
  "name",
  "newPath",
  "oldPath",
  "operation",
  "path",
  "phase",
  "source",
  "status",
  "stream",
  "type",
]);

function sanitizeRunEventRecord(
  value: Record<string, unknown>,
  inheritedLossless = false,
): Record<string, unknown> {
  return Object.fromEntries(
    Object.entries(value).map(([key, nested]) => [
      key,
      key === "opaqueHandle" && typeof nested === "string"
        ? "[redacted]"
        : sanitizeRunEventValue(nested, runEventFieldIsLossless(key, inheritedLossless)),
    ]),
  );
}

function runEventFieldIsLossless(key: string, inheritedLossless: boolean): boolean {
  if (compactRunEventMetadataKeys.has(key)) return false;
  return inheritedLossless || losslessRunEventPayloadKeys.has(key);
}

function sanitizeRunEventValue(value: unknown, lossless = false): unknown {
  if (typeof value === "string") return lossless ? sanitizePublicPayloadText(value) : sanitizePublicEvidenceText(value);
  if (Array.isArray(value)) return value.map((nested) => sanitizeRunEventValue(nested, lossless));
  if (isRecord(value)) return sanitizeRunEventRecord(value, lossless);
  return value;
}

function validOptionalExitCode(value: unknown): boolean {
  return value === undefined || value === null ||
    (typeof value === "number" && Number.isInteger(value) && value >= 0);
}

function validOptionalText(value: unknown): boolean {
  return value === undefined || value === null || typeof value === "string";
}

export interface DeriveRunEvidenceFromEventsInput {
  runId: string;
  events: readonly RunEvent[];
  initialStatus?: AgentRunStatus;
  initialCompletedAt?: string | null;
  initialEvidence?: unknown;
}

export function deriveRunEvidenceFromRunEvents(input: DeriveRunEvidenceFromEventsInput): RunEvidence | null {
  const initialEvidence = input.initialEvidence === undefined ? null : parseRunEvidence(input.initialEvidence);
  if (input.initialEvidence !== undefined && (!initialEvidence || initialEvidence.runId !== input.runId)) return null;
  if (input.initialStatus !== undefined && !isAgentRunStatus(input.initialStatus)) return null;
  let status: AgentRunStatus = initialEvidence?.status ?? input.initialStatus ?? "running";
  let exitCode = initialEvidence?.exitCode ?? null;
  let changesetId = initialEvidence?.changesetId ?? null;
  const checks = [...(initialEvidence?.checks ?? [])];
  const artifacts = [...(initialEvidence?.artifacts ?? [])];
  let review = initialEvidence?.review ?? null;
  let errorReason = initialEvidence?.errorReason ?? null;
  let cancelReason = initialEvidence?.cancelReason ?? null;
  let completedAt = initialEvidence?.completedAt ?? input.initialCompletedAt ?? null;
  const terminalFromRunRecord = !initialEvidence && isTerminalAgentRunStatus(status);
  let terminalSeen = initialEvidence ? isTerminalAgentRunStatus(status) : false;
  let terminalFromError = false;

  for (const candidate of input.events) {
    const event = parseRunEvent(candidate);
    if (!event || event.runId !== input.runId) return null;
    const payload = event.payload;
    const eventChecks = "checks" in payload ? parseRunEvidenceChecks(payload.checks) : [];
    if (!eventChecks) return null;

    if (event.kind === "status") {
      if (!isAgentRunStatus(payload.status)) return null;
      if (!terminalSeen) {
        status = reduceAgentRunStatus(status, payload.status);
        if (typeof payload.exitCode === "number") exitCode = payload.exitCode;
        if (status === "cancelled") cancelReason = sanitizePublicEvidenceText(payload.reason) || cancelReason;
        if (status === "failed") errorReason = sanitizePublicEvidenceText(payload.errorReason) || errorReason;
        terminalSeen = terminalFromRunRecord
          ? isTerminalAgentRunStatus(payload.status)
          : isTerminalAgentRunStatus(status);
        if (terminalSeen && !completedAt) completedAt = event.timestamp;
        if (terminalSeen) terminalFromError = false;
      }
      checks.push(...eventChecks);
    }

    if (event.kind === "error" && !terminalSeen) {
      if (terminalFromRunRecord) {
        if (status === "failed") errorReason = sanitizePublicEvidenceText(payload.message) || errorReason;
      } else {
        status = "failed";
        errorReason = sanitizePublicEvidenceText(payload.message) || "Adapter error";
        completedAt = event.timestamp;
        terminalSeen = true;
        terminalFromError = true;
      }
    }

    if (event.kind === "evidence") {
      if (!terminalSeen || (terminalFromError && !initialEvidence && exitCode === null)) {
        if (typeof payload.exitCode === "number") exitCode = payload.exitCode;
      }
      changesetId = sanitizePublicEvidenceText(payload.changesetId) || changesetId;
      checks.push(...eventChecks);
      if ("artifacts" in payload) {
        const eventArtifacts = parseRunEvidenceArtifacts(payload.artifacts);
        if (!eventArtifacts) return null;
        artifacts.push(...eventArtifacts);
      }
      if ("review" in payload) {
        if (payload.review === null) {
          review = null;
        } else {
          const parsedReview = parseRunEvidenceChecks([payload.review]);
          if (!parsedReview || parsedReview.length !== 1) return null;
          review = parsedReview[0] ?? null;
        }
      }
    }
  }

  return sanitizeTrustedRunEvidence({
    runId: input.runId,
    status,
    exitCode,
    changesetId,
    checks,
    artifacts,
    review,
    errorReason,
    cancelReason,
    completedAt,
  });
}

function isRunEventKind(value: unknown): value is RunEventKind {
  return value === "output" || value === "status" || value === "error" || value === "approval" ||
    value === "progress" || value === "evidence" || value === "changes";
}

function isAgentRunStatus(value: unknown): value is AgentRunStatus {
  return value === "queued" ||
    value === "running" ||
    value === "waiting-input" ||
    value === "requires-approval" ||
    value === "succeeded" ||
    value === "failed" ||
    value === "cancelled" ||
    value === "timed-out";
}

export interface ImportedProject {
  id: string;
  name: string;
  rootPath: string;
  canonicalRootPath?: string;
  devflowPath: string;
  openedAt: string;
}

export interface PlanMarkdown {
  requirements: string;
  design: string;
  tasks: string;
}

export interface PlanAcceptedState {
  requirements: boolean;
  design: boolean;
  tasks: boolean;
}

export const PLAN_CHECKPOINT_LIMIT = 20;
export const PLAN_MARKDOWN_MAX_LENGTH = 2_000_000;

export interface PlanCheckpointState {
  requirements: string[];
  design: string[];
  tasks: string[];
}

export interface PlanStateSnapshot {
  version: number;
  plan: PlanMarkdown;
  accepted: PlanAcceptedState;
  checkpoints: PlanCheckpointState;
}

export function emptyPlanStateSnapshot(): PlanStateSnapshot {
  return {
    version: 0,
    plan: { requirements: "", design: "", tasks: "" },
    accepted: { requirements: false, design: false, tasks: false },
    checkpoints: emptyPlanCheckpointState(),
  };
}

export function parsePlanStateSnapshot(value: unknown): PlanStateSnapshot {
  if (!hasExactKeys(value, ["version", "plan", "accepted", "checkpoints"])) {
    throw new Error("Plan state snapshot is invalid.");
  }
  const version = value.version;
  if (!Number.isSafeInteger(version) || (version as number) < 0) {
    throw new Error("Plan state snapshot is invalid.");
  }
  const plan = parsePlanMarkdown(value.plan);
  const accepted = parsePlanAcceptedState(value.accepted);
  try {
    const checkpoints = parsePlanCheckpointState(value.checkpoints);
    const requirementsReady = accepted.requirements && !!plan.requirements.trim();
    const designReady = accepted.design && !!plan.design.trim();
    const materialDesign = accepted.design || checkpoints.design.length > 0;
    const materialTasks = accepted.tasks || checkpoints.tasks.length > 0;
    if (
      planStages.some((stage) => accepted[stage] && !plan[stage].trim()) ||
      (materialDesign && !requirementsReady) ||
      (materialTasks && (!requirementsReady || !designReady))
    ) {
      throw new Error("invalid");
    }
    return {
      version: version as number,
      plan,
      accepted,
      checkpoints,
    };
  } catch {
    throw new Error("Plan state snapshot is invalid.");
  }
}

export interface ParsedPlanBootstrapSession {
  schemaVersion: 0 | 1;
  snapshot: PlanStateSnapshot;
}

const legacyPlanSessionKeys = [
  "id",
  "projectId",
  "title",
  "goal",
  "mode",
  "kind",
  "target",
  "createdAt",
  "updatedAt",
  "plan",
  "nodes",
  "edges",
  "activeNodeId",
] as const;
const currentPlanSessionKeys = [
  ...legacyPlanSessionKeys,
  "stateVersion",
  "activeStage",
  "plannerConversationId",
  "conversationStarted",
  "stages",
] as const;
const planStageStateKeys = [
  "status",
  "accepted",
  "draft",
  "error",
  "runId",
  "lastRunId",
  "operation",
  "checkpoints",
] as const;

export function parsePlanBootstrapSession(value: unknown): ParsedPlanBootstrapSession {
  try {
    assertPlanBootstrapSessionBase(value);
    const session = value as Record<string, unknown>;
    const plan = parsePlanMarkdown(session.plan);
    if (hasExactKeys(value, legacyPlanSessionKeys)) {
      return {
        schemaVersion: 0,
        snapshot: parsePlanStateSnapshot({
          version: 0,
          plan,
          accepted: { requirements: false, design: false, tasks: false },
          checkpoints: emptyPlanCheckpointState(),
        }),
      };
    }
    if (!hasExactKeys(value, currentPlanSessionKeys)) throw new Error("invalid");
    if (
      !Number.isSafeInteger(session.stateVersion) ||
      (session.stateVersion as number) < 0 ||
      !isPlanBootstrapStage(session.activeStage) ||
      typeof session.plannerConversationId !== "string" ||
      session.plannerConversationId !== makeHermesPlanConversationId(session.id as string) ||
      typeof session.conversationStarted !== "boolean" ||
      !hasExactKeys(session.stages, planStages)
    ) {
      throw new Error("invalid");
    }
    const stages = session.stages as Record<PlanStage, unknown>;
    const parsedStages = Object.fromEntries(planStages.map((stage) => [
      stage,
      parsePlanBootstrapStage(stages[stage], plan[stage]),
    ])) as Record<PlanStage, { accepted: boolean; checkpoints: string[] }>;
    return {
      schemaVersion: 1,
      snapshot: parsePlanStateSnapshot({
        version: session.stateVersion,
        plan,
        accepted: {
          requirements: parsedStages.requirements.accepted,
          design: parsedStages.design.accepted,
          tasks: parsedStages.tasks.accepted,
        },
        checkpoints: {
          requirements: parsedStages.requirements.checkpoints,
          design: parsedStages.design.checkpoints,
          tasks: parsedStages.tasks.checkpoints,
        },
      }),
    };
  } catch {
    throw new Error("Plan bootstrap session is invalid.");
  }
}

export function derivePlanBootstrapSnapshot(session: PlanSession): PlanStateSnapshot {
  try {
    return parsePlanBootstrapSession(session).snapshot;
  } catch {
    throw new Error("Plan state snapshot is invalid.");
  }
}

function assertPlanBootstrapSessionBase(value: unknown): asserts value is Record<string, unknown> {
  if (!isRecord(value)) throw new Error("invalid");
  if (
    typeof value.id !== "string" ||
    !value.id.trim() ||
    value.id !== value.id.trim() ||
    typeof value.projectId !== "string" ||
    !value.projectId.trim() ||
    value.projectId !== value.projectId.trim() ||
    typeof value.title !== "string" ||
    typeof value.goal !== "string" ||
    value.mode !== "plan" ||
    value.kind !== "plan" ||
    typeof value.createdAt !== "string" ||
    typeof value.updatedAt !== "string" ||
    !Array.isArray(value.nodes) ||
    value.nodes.length !== 0 ||
    !Array.isArray(value.edges) ||
    value.edges.length !== 0 ||
    value.activeNodeId !== null
  ) {
    throw new Error("invalid");
  }
  assertPlanBootstrapTarget(value.target);
}

function assertPlanBootstrapTarget(value: unknown): void {
  if (!isRecord(value)) throw new Error("invalid");
  const selectedBranch = value.selectedBranch;
  if (
    typeof selectedBranch !== "string" ||
    !selectedBranch.trim() ||
    selectedBranch !== selectedBranch.trim() ||
    selectedBranch.length > 4_096
  ) {
    throw new Error("invalid");
  }
  if (value.executionTarget === "current_branch") {
    if (!hasExactKeys(value, ["executionTarget", "selectedBranch"])) throw new Error("invalid");
    return;
  }
  if (
    value.executionTarget !== "new_worktree" ||
    !hasExactKeys(value, ["executionTarget", "selectedBranch", "baseRef"]) ||
    typeof value.baseRef !== "string" ||
    !value.baseRef.trim() ||
    value.baseRef !== value.baseRef.trim() ||
    value.baseRef.length > 4_096
  ) {
    throw new Error("invalid");
  }
}

function parsePlanBootstrapStage(
  value: unknown,
  markdown: string,
): { accepted: boolean; checkpoints: string[] } {
  if (!hasExactKeys(value, planStageStateKeys)) throw new Error("invalid");
  const stage = value as Record<string, unknown>;
  if (
    !isPlanStageStatus(stage.status) ||
    typeof stage.accepted !== "boolean" ||
    typeof stage.draft !== "string" ||
    stage.draft.length > PLAN_MARKDOWN_MAX_LENGTH ||
    !isNullableBoundedPlanRuntimeText(stage.error) ||
    !isNullableBoundedPlanRuntimeText(stage.runId) ||
    !isNullableBoundedPlanRuntimeText(stage.lastRunId) ||
    !isNullablePlanOperation(stage.operation)
  ) {
    throw new Error("invalid");
  }
  const checkpoints = parsePlanCheckpointArray(stage.checkpoints);
  const hasMarkdown = !!markdown.trim();
  const idle = stage.status === "pending" || stage.status === "ready" || stage.status === "failed";
  if (idle && (stage.runId !== null || stage.draft !== "")) throw new Error("invalid");
  if (stage.status === "pending" && (
    hasMarkdown || stage.accepted || stage.error !== null || stage.operation !== null
  )) {
    throw new Error("invalid");
  }
  if (stage.status === "ready" && (
    !hasMarkdown || stage.error !== null || stage.operation !== null
  )) {
    throw new Error("invalid");
  }
  if (stage.status === "failed" && (
    typeof stage.error !== "string" ||
    !stage.error.trim() ||
    stage.operation === null ||
    (stage.accepted && (stage.operation !== "revise" || !hasMarkdown))
  )) {
    throw new Error("invalid");
  }
  if (stage.status === "generating" && (
    stage.accepted || stage.error !== null || stage.operation !== "generate" || stage.runId === null
  )) {
    throw new Error("invalid");
  }
  if (stage.status === "revising" && (
    !hasMarkdown || stage.accepted || stage.error !== null || stage.operation !== "revise" || stage.runId === null
  )) {
    throw new Error("invalid");
  }
  return { accepted: stage.accepted as boolean, checkpoints };
}

function isPlanStageStatus(value: unknown): value is PlanStageStatus {
  return value === "pending" || value === "generating" || value === "ready" || value === "revising" || value === "failed";
}

function isPlanBootstrapStage(value: unknown): value is PlanStage {
  return value === "requirements" || value === "design" || value === "tasks";
}

function isNullablePlanOperation(value: unknown): value is PlanOperation | null {
  return value === null || value === "generate" || value === "revise";
}

function isNullableBoundedPlanRuntimeText(value: unknown): value is string | null {
  return value === null || (
    typeof value === "string" &&
    !!value.trim() &&
    value === value.trim() &&
    value.length <= 4_096
  );
}

function parsePlanMarkdown(value: unknown): PlanMarkdown {
  if (!hasExactKeys(value, planStages)) throw new Error("Plan state snapshot is invalid.");
  const markdown = value as Record<PlanStage, unknown>;
  if (planStages.some((stage) => (
    typeof markdown[stage] !== "string" || markdown[stage].length > PLAN_MARKDOWN_MAX_LENGTH
  ))) {
    throw new Error("Plan state snapshot is invalid.");
  }
  return {
    requirements: markdown.requirements as string,
    design: markdown.design as string,
    tasks: markdown.tasks as string,
  };
}

function parsePlanAcceptedState(value: unknown): PlanAcceptedState {
  if (!hasExactKeys(value, planStages)) throw new Error("Plan state snapshot is invalid.");
  const accepted = value as Record<PlanStage, unknown>;
  if (planStages.some((stage) => typeof accepted[stage] !== "boolean")) {
    throw new Error("Plan state snapshot is invalid.");
  }
  return {
    requirements: accepted.requirements as boolean,
    design: accepted.design as boolean,
    tasks: accepted.tasks as boolean,
  };
}

const planStages: PlanStage[] = ["requirements", "design", "tasks"];

function hasExactKeys(value: unknown, keys: readonly string[]): value is Record<string, unknown> {
  if (!isRecord(value)) return false;
  const actual = Object.keys(value);
  return actual.length === keys.length && actual.every((key) => keys.includes(key));
}

export function emptyPlanCheckpointState(): PlanCheckpointState {
  return { requirements: [], design: [], tasks: [] };
}

export function parsePlanCheckpointState(value: unknown): PlanCheckpointState {
  if (!isRecord(value) || Object.keys(value).some((key) => !isPlanCheckpointStage(key))) {
    throw new Error("Plan checkpoint state is invalid.");
  }
  return {
    requirements: parsePlanCheckpointArray(value.requirements),
    design: parsePlanCheckpointArray(value.design),
    tasks: parsePlanCheckpointArray(value.tasks),
  };
}

function parsePlanCheckpointArray(value: unknown): string[] {
  if (
    !Array.isArray(value) ||
    value.length > PLAN_CHECKPOINT_LIMIT ||
    value.some((checkpoint) => (
      typeof checkpoint !== "string" ||
      !checkpoint.trim() ||
      checkpoint.length > PLAN_MARKDOWN_MAX_LENGTH
    ))
  ) {
    throw new Error("Plan checkpoint state is invalid.");
  }
  return [...value];
}

function isPlanCheckpointStage(value: string): value is PlanStage {
  return value === "requirements" || value === "design" || value === "tasks";
}

export interface PlanStageState {
  status: PlanStageStatus;
  accepted: boolean;
  draft: string;
  error: string | null;
  runId: string | null;
  lastRunId: string | null;
  operation: PlanOperation | null;
  checkpoints: string[];
}

export type PlanStageStates = Record<PlanStage, PlanStageState>;

interface PlanRunRequestBase {
  planSessionId: string;
  projectRoot: string;
  stage: PlanStage;
  goal: string;
  expectedStateVersion: number;
}

export interface PlanGenerateRequest extends PlanRunRequestBase {
  operation: "generate";
}

export interface PlanReviseRequest extends PlanRunRequestBase {
  operation: "revise";
  instruction: string;
}

export type PlanRunRequest = PlanGenerateRequest | PlanReviseRequest;

export interface PlanCancelRequest {
  planSessionId: string;
  projectRoot: string;
  runId: string;
}

export interface PlanGetStateRequest {
  planSessionId: string;
  projectRoot: string;
}

export type PlanBootstrapRequest = PlanGetStateRequest;

interface PlanStageMutationRequestBase {
  planSessionId: string;
  projectRoot: string;
  stage: PlanStage;
  expectedStateVersion: number;
}

export interface PlanUpdateStageRequest extends PlanStageMutationRequestBase {
  markdown: string;
}

export type PlanAcceptStageRequest = PlanStageMutationRequestBase;
export type PlanUndoStageRequest = PlanStageMutationRequestBase;

export interface PlanStateTransitionResult {
  protocolVersion: 1;
  snapshot: PlanStateSnapshot;
}

export interface PlanRunStartResult {
  protocolVersion: 1;
  planSessionId: string;
  runId: string;
  stage: PlanStage;
  operation: PlanOperation;
  duplicate: boolean;
}

export interface PlanRuntimeStateResult {
  protocolVersion: 1;
  needsBootstrap: boolean;
  snapshot: PlanStateSnapshot;
  active: {
    planSessionId: string;
    runId: string;
    stage: PlanStage;
    operation: PlanOperation;
    conversationReady: boolean;
    draft: string;
    checkpoints: PlanCheckpointState;
  } | null;
  terminal: Extract<PlanEvent, { kind: "completed" | "failed" }> | null;
}

interface PlanEventBase {
  protocolVersion: 1;
  planSessionId: string;
  runId: string;
  stage: PlanStage;
  operation: PlanOperation;
}

export type PlanEvent =
  | (PlanEventBase & { kind: "started" })
  | (PlanEventBase & { kind: "conversation_ready" })
  | (PlanEventBase & { kind: "delta"; text: string })
  | (PlanEventBase & {
      kind: "completed";
      markdown: string;
      checkpoints: PlanCheckpointState;
      snapshot: PlanStateSnapshot;
    })
  | (PlanEventBase & {
      kind: "failed";
      error: string;
      checkpoints: PlanCheckpointState;
      snapshot: PlanStateSnapshot;
    });

export interface SessionTarget {
  executionTarget: SessionExecutionTarget;
  selectedBranch: string;
  baseRef?: string;
}

export interface WorktreeMetadata {
  path: string;
  branchName: string;
  baseCommit: string;
  executionTarget?: SessionExecutionTarget;
  selectedBranch?: string;
  baseRef?: string;
  baselineRef?: string;
  worktreeId?: string;
  variantId?: string;
  realPath?: string;
  gitdir?: string;
  repoRoot?: string;
  headCommit?: string;
}

export interface WorkflowRuntimePolicy {
  source: WorkflowRuntimePolicySource;
  trusted: true;
  executable: boolean;
  sandbox: AgentRunSandbox;
  sideEffects: WorkflowSideEffectKind[];
  reason: string;
}

export interface UserDecisionRequestedPayload {
  decisionId: string;
  prompt: string;
  options: string[];
  reason: string;
  targetLaneId?: string;
  targetSegmentId?: string;
}

export interface UserDecisionAnsweredPayload {
  decisionId: string;
  selectedOption: string;
  action: UserDecisionAction;
  comment?: string;
  targetLaneId?: string;
  targetSegmentId?: string;
}

export interface UserDecisionProjection {
  decisionId: string;
  prompt: string;
  options: string[];
  reason: string;
  status: UserDecisionNodeStatus;
  targetLaneId?: string;
  targetSegmentId?: string;
  selectedOption?: string;
  action?: UserDecisionAction;
  comment?: string;
}

export interface WorkflowLedgerSummaryEvent {
  seq: number;
  kind: string;
  summary: string;
  laneId?: string;
}

export interface WorkflowLedgerSummary {
  throughSeq: number;
  checkpointSummary: string | null;
  facts: string[];
  recentEvents: WorkflowLedgerSummaryEvent[];
  openQuestions: string[];
}

export interface WorkflowWorktreeIdentity {
  worktreeId: string;
  variantId: string;
  path: string;
  realPath: string;
  gitdir: string;
  repoRoot: string;
  branchName: string;
  baseCommit: string;
  headCommit: string;
  parentLaneId: string;
  parentSegmentId?: string;
}

export interface WorkflowVariantAdoption {
  adoptionId: string;
  variantId: string;
  worktreeId: string;
  strategy: WorkflowVariantAdoptionStrategy;
  status: WorkflowVariantAdoptionStatus;
  baseCommit: string;
  headCommit: string;
  targetBranchName: string;
  adoptedCommit?: string;
  failureReason?: string;
}

export interface WorkflowCheckpointEvidenceRef {
  kind: WorkflowCheckpointEvidenceRefKind;
  id: string;
  uri?: string;
}

export interface WorkflowNodeCheckpointAuthority {
  laneIdExplicit?: boolean;
  nodeIdExplicit?: boolean;
  phaseExplicit?: boolean;
  executionTargetExplicit?: boolean;
}

export interface WorkflowNodeCheckpoint {
  id: string;
  sessionId: string;
  nodeId: string;
  laneId?: string;
  runId?: string;
  segmentId?: string;
  phase: WorkflowNodeCheckpointPhase;
  executionTarget: SessionExecutionTarget;
  worktreeId?: string;
  worktreePath?: string;
  branchName?: string;
  worktreeState?: WorkflowCheckpointWorktreeState;
  baseCommit?: string;
  headCommit?: string;
  createdAt: string;
  source: WorkflowNodeCheckpointSource;
  evidenceRefs: WorkflowCheckpointEvidenceRef[];
  authority?: WorkflowNodeCheckpointAuthority;
}

export interface WorkflowRemoteSideEffectRef {
  eventKind: WorkflowRemoteSideEffectEventKind;
  status?: WorkflowRemoteSideEffectStatus;
  eventId: string;
  laneId?: string;
  affectedLaneIds?: string[];
  sessionWide?: boolean;
  operationId?: string;
  createdAt?: string;
}

export interface WorkflowRemoteSideEffectPayload {
  laneId?: string;
  commitLaneId?: string;
  targetLaneId?: string;
  affectedLaneIds?: string[];
  evidence?: Record<string, unknown>;
  [key: string]: unknown;
}

export interface WorkflowRollbackEligibility {
  eligible: boolean;
  targetLaneId: string;
  targetNodeId?: string;
  checkpointId?: string;
  checkpointPhase?: WorkflowNodeCheckpointPhase;
  restoreCommitRef?: string;
  affectedLaneIds: string[];
  affectedNodeIds?: string[];
  downstreamInactiveLaneIds: string[];
  downstreamInactiveNodeIds?: string[];
  blockingRemoteSideEffects: WorkflowRemoteSideEffectRef[];
  localRollbackSafe?: boolean;
  localSafetyStatus?: WorkflowRollbackLocalSafetyStatus;
  manualRepairReason?: string;
  reason?: string;
}

export type WorkflowEngineeringLoopKind = "execution" | "delivery" | "rollback" | "repair" | "variant";
export type WorkflowDeliveryLoopPhase =
  | "not_started"
  | "pushed"
  | "pr_created"
  | "checks_pending"
  | "checks_failed"
  | "changes_requested"
  | "checks_stale"
  | "merge_ready"
  | "merged"
  | "main_synced";
export type WorkflowRollbackLoopPhase = "not_requested" | "ready" | "blocked" | "requested" | "applied" | "rejected";
export type WorkflowSuccessorLoopPhase = "not_requested" | "requested" | "ready" | "running" | "completed" | "rejected";
export type WorkflowLoopNextActionKind =
  | "execute_lane"
  | "wait_for_checks"
  | "fix_failed_checks"
  | "merge_pull_request"
  | "rollback_node"
  | "request_repair"
  | "request_variant"
  | "blocked"
  | "none";
export type WorkflowLoopBlockedReasonCode =
  | "changes_requested"
  | "stale_head"
  | "pending_checks"
  | "failed_checks"
  | "remote_side_effect"
  | "local_rollback_unsafe"
  | "invalid_checkpoint"
  | "unknown_target";
export type WorkflowDeliveryCheckStatus = "passed" | "failed" | "pending" | "changes_requested";
export type WorkflowDeliveryReviewStatus = "approved" | "changes_requested" | "pending" | "unknown";

export interface WorkflowDeliveryCheckSummary {
  name: string;
  status: WorkflowDeliveryCheckStatus;
  url?: string;
  detail?: string;
}

export interface WorkflowDeliveryReviewSummary {
  status: WorkflowDeliveryReviewStatus;
  detail?: string;
  reviewer?: string;
  url?: string;
}

export interface WorkflowLoopBlockedReason {
  code: WorkflowLoopBlockedReasonCode;
  message: string;
  laneId?: string;
  affectedLaneIds?: string[];
  eventKinds?: WorkflowRemoteSideEffectEventKind[];
  remoteSideEffects?: WorkflowRemoteSideEffectRef[];
  localRollbackSafe?: boolean;
}

export interface WorkflowLoopNextAction {
  kind: WorkflowLoopNextActionKind;
  loop?: WorkflowEngineeringLoopKind;
  laneId?: string;
  reason: string;
  prNumber?: number;
  headSha?: string;
  checkpointId?: string;
}

export interface WorkflowDeliveryLoopState {
  phase: WorkflowDeliveryLoopPhase;
  evidenceStale: boolean;
  pullRequestLaneId?: string;
  checkLaneId?: string;
  prNumber?: number;
  headSha?: string;
  headBranch?: string;
  lastCheckedHeadSha?: string;
  checks: WorkflowDeliveryCheckSummary[];
  review?: WorkflowDeliveryReviewSummary;
  blockedReason?: WorkflowLoopBlockedReason;
}

export interface WorkflowRollbackLoopState {
  phase: WorkflowRollbackLoopPhase;
  targetLaneId?: string;
  targetNodeId?: string;
  checkpointId?: string;
  checkpointPhase?: WorkflowNodeCheckpointPhase;
  restoreCommitRef?: string;
  affectedLaneIds: string[];
  affectedNodeIds?: string[];
  downstreamInactiveLaneIds: string[];
  downstreamInactiveNodeIds?: string[];
  remoteBlockers: WorkflowRemoteSideEffectRef[];
  localRollbackSafe?: boolean;
  localSafetyStatus?: WorkflowRollbackLocalSafetyStatus;
  manualRepairReason?: string;
  blockedReason?: WorkflowLoopBlockedReason;
}

export interface WorkflowSuccessorLoopState {
  phase: WorkflowSuccessorLoopPhase;
  sourceLaneId?: string;
  checkpointId?: string;
  successorLaneId?: string;
  successorSemanticKey?: string;
  instruction?: string;
}

export interface WorkflowLoopEngineeringProjectionInput {
  selectedLaneId?: string;
  allowedParallelism?: number;
  localRollbackSafe?: boolean;
}

export interface WorkflowLoopEngineeringState {
  sessionId: string;
  throughSeq: number;
  nextAction: WorkflowLoopNextAction;
  blockedReason?: WorkflowLoopBlockedReason;
  evidenceStale: boolean;
  delivery: WorkflowDeliveryLoopState;
  rollback: WorkflowRollbackLoopState;
  repair: WorkflowSuccessorLoopState;
  variant: WorkflowSuccessorLoopState;
}

export interface WorkflowCheckpointIntentBase {
  intentId: string;
  sessionId: string;
  nodeId?: string;
  laneId?: string;
  checkpointId?: string;
  sourceEvidenceIds?: string[];
  createdAt: string;
  localRollbackSafe?: boolean;
}

export interface WorkflowRollbackCheckpointIntent extends WorkflowCheckpointIntentBase {
  kind: "rollback";
  status: WorkflowCheckpointIntentStatus;
  eligibility?: WorkflowRollbackEligibility;
  reason?: string;
  successorLaneId?: never;
  successorSemanticKey?: never;
}

export type WorkflowCheckpointSuccessorKind = Exclude<WorkflowCheckpointIntentKind, "rollback">;

export type WorkflowCheckpointSuccessorIdentity =
  | { successorLaneId: string; successorSemanticKey?: string }
  | { successorLaneId?: string; successorSemanticKey: string };

export type WorkflowRequestedCheckpointSuccessorIntent = Omit<WorkflowCheckpointIntentBase, "laneId"> &
  { laneId: string } &
  WorkflowCheckpointSuccessorIdentity & {
    kind: WorkflowCheckpointSuccessorKind;
    status: "requested";
    instruction?: string;
    reason?: string;
  };

export interface WorkflowRejectedCheckpointSuccessorIntent extends WorkflowCheckpointIntentBase {
  kind: WorkflowCheckpointSuccessorKind;
  status: "rejected";
  successorLaneId?: string;
  successorSemanticKey?: string;
  instruction?: string;
  reason: string;
}

export type WorkflowCheckpointIntent =
  | WorkflowRollbackCheckpointIntent
  | WorkflowRequestedCheckpointSuccessorIntent
  | WorkflowRejectedCheckpointSuccessorIntent;

export interface ChangesetEvidence {
  evidenceId: string;
  changesetId: string;
  source: Changeset["source"];
  status: ChangesetEvidenceStatus;
  files: string[];
  diffStat: Changeset["diffStat"];
  patchPreviewTruncated: boolean;
  worktreeId?: string;
  collectedAt?: string;
  artifactPaths?: string[];
  errorReason?: string;
}

export interface StructuredRunChange {
  operation: LiveRunChangeOperation;
  path: string;
  previousPath?: string;
  unifiedDiff?: string;
}

export interface LiveRunChangesEvidence {
  source: "codex";
  status: "available" | "unknown";
  files: string[];
  changes: StructuredRunChange[];
  patchPreview?: string;
  patchPreviewTruncated?: boolean;
  collectedAt?: string;
}

export interface ChangesetReconciliationMetadata {
  source: "git";
  executionTarget: SessionExecutionTarget;
  selectedBranch: string;
  baselineRef: string;
  baseRef?: string;
  worktreeId?: string;
  variantId?: string;
}

export interface ChangesetReconciliationMismatch {
  kind: "file-set";
  liveFiles: string[];
  gitFiles: string[];
}

export interface FinalChangesetReconciliation {
  status: FinalChangesetReconciliationStatus;
  changeset: Changeset;
  metadata: ChangesetReconciliationMetadata;
  liveChanges?: LiveRunChangesEvidence;
  mismatches?: ChangesetReconciliationMismatch[];
  errorReason?: string;
}

export interface CanvasNodeContext {
  brief: string;
  sessionGoal: string;
  relatedRequirements: string;
  relatedDesign: string;
  relatedTasks: string;
  dependencies: string[];
  constraints: string[];
}

export interface NodeRuntimeState {
  phase: NodeLifecyclePhase;
  message: string;
  action: string;
}

export interface CanvasNodeDisplay {
  agentLabel: string;
  meta: string[];
}

export type WorkflowCardToolName = "createWorkflowCard" | "updateWorkflowCard" | "deleteWorkflowCard";

export interface CanvasNodeWorkflowTrace {
  source: "hermes";
  sourceRunId: string;
  toolCallId?: string;
  lastTool: WorkflowCardToolName;
  taskKey?: string;
  semanticKey?: string;
}

export interface CanvasNode {
  id: string;
  title: string;
  agent: AgentKind;
  progress: string;
  nodeKind?: WorkflowProjectionNodeKind;
  executable?: boolean;
  laneKind?: WorkflowLaneKind;
  semanticSubtype?: WorkflowLaneSemanticSubtype;
  requiredEvidence?: string[];
  runtimePolicy?: WorkflowRuntimePolicy;
  userDecision?: UserDecisionProjection;
  runtime?: NodeRuntimeState;
  display?: CanvasNodeDisplay;
  workflowTrace?: CanvasNodeWorkflowTrace;
  status: NodeStatus;
  rollbackStatus?: NodeRollbackStatus;
  position: {
    x: number;
    y: number;
  };
  runId: string;
  changesetId: string;
  output: string[];
  outputDeltas?: RunEvent[];
  worktree: WorktreeMetadata;
  context: CanvasNodeContext;
}

export interface CanvasEdge {
  id: string;
  source: string;
  target: string;
}

export interface SessionBase {
  id: string;
  projectId: string;
  title: string;
  goal: string;
  mode: WorkflowMode;
  target: SessionTarget;
  createdAt: string;
  updatedAt: string;
}

export interface CanvasSession extends SessionBase {
  kind: "canvas";
  hermesPlannerSessionId: string;
  plannerNodeId: string;
  nodes: CanvasNode[];
  edges: CanvasEdge[];
  activeNodeId: string | null;
}

export interface PlanSession extends SessionBase {
  kind: "plan";
  mode: "plan";
  plan: PlanMarkdown;
  stateVersion: number;
  activeStage: PlanStage;
  plannerConversationId: string;
  conversationStarted: boolean;
  stages: PlanStageStates;
  nodes: [];
  edges: [];
  activeNodeId: null;
}

export type CanvasSessionTab = CanvasSession | PlanSession;

export interface Changeset {
  id: string;
  files: string[];
  diffStat: {
    added: number;
    changed: number;
    deleted: number;
  };
  patchPreview: string;
  source: "mock" | "git";
  evidence?: ChangesetEvidence;
}

export interface EvidenceSummaryFact {
  label: string;
  value: string;
}

export interface EvidenceCommitSummary {
  commitSha?: string;
  branch?: string;
  worktreePath?: string;
  subject?: string;
}

export type EvidenceRepoState = "clean" | "dirty" | "failed" | "unknown";

export interface RunEvidenceSummaryInput {
  runEvidence?: RunEvidence | null;
  changeset?: Changeset | null;
  reconciliation?: FinalChangesetReconciliation | null;
  commitEvidence?: EvidenceCommitSummary | null;
  expectedArtifacts?: string[];
}

export interface RunEvidenceSummary {
  run: {
    id: string | null;
    status: AgentRunStatus | "unknown";
    exitCode: number | null;
  };
  reason: string | null;
  latestFailedCheck: string | null;
  checkSummary: string;
  artifactSummary: string;
  reviewSummary: string | null;
  runFacts: EvidenceSummaryFact[];
  changes: {
    changesetId: string | null;
    status: ChangesetEvidenceStatus | FinalChangesetReconciliationStatus | "unknown";
    files: string[];
    diffStat: Changeset["diffStat"];
    repoState: EvidenceRepoState;
    repoStateSummary: string;
  };
  changeFacts: EvidenceSummaryFact[];
}

export function hasConcreteRunEvidence(evidence: RunEvidence | null | undefined): boolean {
  if (!evidence) return false;
  const safeEvidence = parseRunEvidence(evidence);
  if (!safeEvidence) return false;
  if (safeEvidence.exitCode === 0) return true;
  if (safeEvidence.changesetId) return true;
  if (safeEvidence.artifacts.length > 0) return true;
  if (safeEvidence.review?.status === "passed") return true;
  return safeEvidence.checks.some((check) => check.status === "passed");
}

export type RunEvidenceCompletionContext =
  | { source: "current"; expectedArtifactContract: boolean }
  | { source: "legacy-disk"; expectedArtifactContract: false };

export function isSuccessfulRunEvidence(
  evidence: RunEvidence | null | undefined,
  context: RunEvidenceCompletionContext,
): boolean {
  if (!evidence) return false;
  const safeEvidence = parseRunEvidence(evidence);
  if (!safeEvidence || safeEvidence.status !== "succeeded") return false;
  const artifactChecks = safeEvidence.checks.filter((check) => check.kind === "artifact");
  if (context.expectedArtifactContract) {
    return safeEvidence.exitCode === 0 &&
      artifactChecks.some((check) => check.status === "passed") &&
      safeEvidence.artifacts.length > 0;
  }
  if (safeEvidence.exitCode === 0) return true;
  if (context.source !== "legacy-disk" || safeEvidence.exitCode !== null || artifactChecks.length > 0) return false;
  return Boolean(
    safeEvidence.changesetId ||
    safeEvidence.review?.status === "passed" ||
    safeEvidence.checks.some((check) => check.status === "passed"),
  );
}

export function summarizeRunEvidence(input: RunEvidenceSummaryInput = {}): RunEvidenceSummary {
  const sourceEvidence = input.runEvidence ?? null;
  const runEvidence = sourceEvidence ? parseRunEvidence(sourceEvidence) : null;
  const checks = runEvidence?.checks ?? [];
  const reviewSummary = runEvidence?.review ? formatEvidenceCheck(runEvidence.review) : null;
  const artifactSummary = formatArtifacts(runEvidence?.artifacts ?? []);
  const reason = runEvidence ? runEvidenceReason(runEvidence) : null;
  const latestFailedCheck = latestFailedCheckSummary(checks);
  const changes = summarizeChangeEvidence(input.reconciliation ?? null, input.changeset ?? null);
  const changeFacts = changeFactsForSummary(changes, input.commitEvidence ?? null);
  const runFacts: EvidenceSummaryFact[] = [
    { label: "Run ID", value: runEvidence?.runId ?? "None" },
    { label: "Run status", value: runEvidence?.status ?? "unknown" },
    ...(runEvidence?.exitCode !== null && runEvidence?.exitCode !== undefined
      ? [{ label: "Exit code", value: String(runEvidence.exitCode) }]
      : []),
    { label: "Checks", value: formatChecks(checks) },
    { label: "Artifacts", value: artifactSummary },
    ...(reviewSummary ? [{ label: "Review", value: reviewSummary }] : []),
    ...(reason ? [{ label: "Reason", value: reason }] : []),
  ];

  return {
    run: {
      id: runEvidence?.runId ?? null,
      status: runEvidence?.status ?? "unknown",
      exitCode: runEvidence?.exitCode ?? null,
    },
    reason,
    latestFailedCheck,
    checkSummary: formatChecks(checks),
    artifactSummary,
    reviewSummary,
    runFacts,
    changes,
    changeFacts,
  };
}

function summarizeChangeEvidence(
  reconciliation: FinalChangesetReconciliation | null,
  changesetInput: Changeset | null,
): RunEvidenceSummary["changes"] {
  const changeset = reconciliation?.changeset ?? changesetInput;
  const status = reconciliation?.status ?? changeset?.evidence?.status ?? "unknown";
  const files = changeset ? (changeset.evidence?.files.length ? changeset.evidence.files : changeset.files) : [];
  const diffStat = changeset?.diffStat ?? { added: 0, changed: 0, deleted: 0 };
  const repoStateSummary = repoStateSummaryForChangeEvidence(status, reconciliation, changeset);

  return {
    changesetId: changeset?.id ?? changeset?.evidence?.changesetId ?? null,
    status,
    files,
    diffStat,
    repoState: repoStateForChangeEvidence(status),
    repoStateSummary,
  };
}

function changeFactsForSummary(
  changes: RunEvidenceSummary["changes"],
  commitEvidence: EvidenceCommitSummary | null,
): EvidenceSummaryFact[] {
  const changedFileCount = changes.diffStat.changed || changes.files.length;
  const fileLabel = changedFileCount === 1 ? "file" : "files";
  const facts: EvidenceSummaryFact[] = [
    { label: "Changeset status", value: changes.status },
    {
      label: "Changed files",
      value: changes.files.length ? `${changes.files.length} (${changes.files.join(", ")})` : "None",
    },
    {
      label: "Diff stat",
      value: `+${changes.diffStat.added} / -${changes.diffStat.deleted} across ${changedFileCount} ${fileLabel}`,
    },
    { label: "Repo state", value: changes.repoStateSummary },
  ];
  const commit = commitEvidenceSummary(commitEvidence);
  if (commit) facts.push({ label: "Commit", value: commit });
  return facts;
}

function repoStateForChangeEvidence(
  status: ChangesetEvidenceStatus | FinalChangesetReconciliationStatus | "unknown",
): EvidenceRepoState {
  if (status === "empty") return "clean";
  if (status === "available" || status === "mismatch") return "dirty";
  if (status === "failed") return "failed";
  return "unknown";
}

function repoStateSummaryForChangeEvidence(
  status: ChangesetEvidenceStatus | FinalChangesetReconciliationStatus | "unknown",
  reconciliation: FinalChangesetReconciliation | null,
  changeset: Changeset | null,
): string {
  if (status === "empty") return "Clean at collection";
  if (status === "available" || status === "mismatch") return "Git changes recorded";
  if (status === "failed") return reconciliation?.errorReason ?? changeset?.evidence?.errorReason ?? "Collection failed";
  return "Not recorded";
}

function runEvidenceReason(runEvidence: RunEvidence): string | null {
  if (runEvidence.status === "timed-out") {
    const timeoutReason =
      runEvidence.errorReason ??
      runEvidence.checks.find((check) => check.kind === "run-timeout" && typeof check.detail === "string")?.detail ??
      null;
    return `Timeout: ${timeoutReason ?? "run timed out"}`;
  }
  if (runEvidence.status === "cancelled" || runEvidence.cancelReason) {
    return `Cancelled: ${runEvidence.cancelReason ?? "run cancelled"}`;
  }
  if (runEvidence.errorReason) return `Error: ${runEvidence.errorReason}`;
  if (runEvidence.status !== "failed") return null;
  const failedCheck = latestFailedCheckSummary(runEvidence.checks);
  if (failedCheck) return `Check failed: ${failedCheck}`;
  if (runEvidence.exitCode !== null && runEvidence.exitCode !== 0) return `Exit code ${runEvidence.exitCode}`;
  return null;
}

function latestFailedCheckSummary(checks: EvidenceCheck[]): string | null {
  const failedCheck = [...checks].reverse().find((check) => check.status === "failed");
  if (!failedCheck) return null;
  const detail = cleanEvidenceText(failedCheck.detail);
  return `${failedCheck.name}: ${failedCheck.status}${detail ? ` - ${detail}` : ""}`;
}

function formatChecks(checks: EvidenceCheck[]): string {
  return checks.length ? checks.map(formatEvidenceCheck).join(", ") : "None";
}

function formatEvidenceCheck(check: EvidenceCheck): string {
  const detail = cleanEvidenceText(check.detail);
  return `${check.kind} [${check.name}]: ${check.status}${detail ? ` - ${detail}` : ""}`;
}

function formatArtifacts(paths: string[]): string {
  if (!paths.length) return "None";
  return `${paths.length} (${paths.join(", ")})`;
}

function commitEvidenceSummary(commitEvidence: EvidenceCommitSummary | null): string | null {
  if (!commitEvidence) return null;
  if (commitEvidence.commitSha && commitEvidence.branch) return `${shortEvidenceSha(commitEvidence.commitSha)} on ${commitEvidence.branch}`;
  if (commitEvidence.commitSha) return shortEvidenceSha(commitEvidence.commitSha);
  if (commitEvidence.branch) return commitEvidence.branch;
  return cleanEvidenceText(commitEvidence.subject);
}

function shortEvidenceSha(value: string): string {
  return value.slice(0, 7);
}

function cleanEvidenceText(value: string | null | undefined): string | null {
  return typeof value === "string" && value.trim().length > 0 ? value : null;
}

export function canUsePtyInteractiveTransport(
  capabilities: AgentTransportCapabilities | null | undefined,
  flags: AgentTransportFeatureFlags = DEFAULT_AGENT_TRANSPORT_FEATURE_FLAGS,
): boolean {
  return flags.ptyInteractiveSessions && capabilities?.supportsPtyInteractive === true;
}

export function makeHermesPlannerSessionId(sessionId: string): string {
  return `hermes-planner-${sessionId}`;
}

export function makeHermesPlanConversationId(sessionId: string): string {
  return `hermes-plan-${sessionId}`;
}

export function normalizeSessionTarget(value: unknown, fallbackSelectedBranch = "HEAD"): SessionTarget {
  const fallback = cleanSessionRef(fallbackSelectedBranch) || DEFAULT_SESSION_TARGET.selectedBranch;
  if (!isRecord(value)) return { ...DEFAULT_SESSION_TARGET, selectedBranch: fallback };
  const executionTarget = value.executionTarget === "new_worktree" ? "new_worktree" : "current_branch";
  const selectedBranch = cleanSessionRef(value.selectedBranch);
  if (executionTarget === "current_branch") {
    return {
      executionTarget,
      selectedBranch: selectedBranch || fallback,
    };
  }
  const baseRef = cleanSessionRef(value.baseRef) || selectedBranch || fallback;
  return {
    executionTarget,
    selectedBranch: selectedBranch || baseRef,
    baseRef,
  };
}

export function deriveNodeStatusFromEvidence(
  run: AgentRun | null | undefined,
  evidence: RunEvidence | null | undefined,
): NodeStatus {
  if (!run) return "pending";
  if (run.status === "queued") return "pending";
  if (run.status === "running" || run.status === "waiting-input" || run.status === "requires-approval") {
    return "running";
  }
  if (run.status === "succeeded") {
    const safeEvidence = evidence ? parseRunEvidence(evidence) : null;
    return isSuccessfulRunEvidence(safeEvidence, { source: "current", expectedArtifactContract: false })
      ? "completed"
      : "failed";
  }
  return "failed";
}

function cleanSessionRef(value: unknown): string {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : "";
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}
