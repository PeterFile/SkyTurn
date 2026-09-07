export type ConfigurableAgentKind = "hermes" | "codex";
export type SettingsEditorKind =
  | "vscode" | "cursor" | "zed" | "antigravity" | "finder" | "terminal" | "iterm2" | "xcode";

export interface AppSettings {
  executableOverrides: Record<ConfigurableAgentKind, string | null>;
  defaultExecutor: ConfigurableAgentKind;
  externalEditor: SettingsEditorKind;
  notifications: { desktop: boolean; sound: boolean };
}

export interface ProjectSettings {
  commands: { start: string; test: string; build: string };
  defaultExecutionTarget:
    | { executionTarget: "current_branch"; selectedBranch: string }
    | { executionTarget: "new_worktree"; selectedBranch: string; baseRef: string };
}

export interface SkyTurnSettings {
  app: AppSettings;
  project: ProjectSettings;
}

export interface SettingsGitPrerequisites {
  status: "ready" | "not_repository" | "unknown";
  currentBranch: string | null;
  branches: string[];
}

export interface SettingsAgentPrerequisite {
  kind: ConfigurableAgentKind;
  executablePath: string | null;
  version: string | null;
  cli: "ready" | "missing" | "unknown";
  auth: "available" | "missing" | "unknown";
  runnable: boolean;
  supportLevel: "mock-only" | "detected-only" | "experimental-run" | "supported-run";
  setup: { documentationUrl: string; installCommand: string; authCommand: string };
}

export interface SettingsSnapshot {
  protocolVersion: number;
  projectRoot: string;
  settings: SkyTurnSettings;
  prerequisites: {
    project: { registered: true; canonicalRootPath: string; git: SettingsGitPrerequisites };
    agents: SettingsAgentPrerequisite[];
    defaultExecutorRunnable: boolean;
  };
}

export interface SettingsApi {
  get(projectRoot: string): Promise<SettingsSnapshot>;
  save(projectRoot: string, settings: SkyTurnSettings): Promise<SettingsSnapshot>;
}

const editorKinds = new Set<SettingsEditorKind>([
  "vscode", "cursor", "zed", "antigravity", "finder", "terminal", "iterm2", "xcode",
]);
const maxRefLength = 4096;

export function createDefaultSkyTurnSettings(selectedBranch = "HEAD"): SkyTurnSettings {
  const branch = parseRef(selectedBranch, "default project branch");
  return {
    app: {
      executableOverrides: { hermes: null, codex: null },
      defaultExecutor: "codex",
      externalEditor: "zed",
      notifications: { desktop: false, sound: false },
    },
    project: {
      commands: { start: "", test: "", build: "" },
      defaultExecutionTarget: { executionTarget: "current_branch", selectedBranch: branch },
    },
  };
}

export function parseSkyTurnSettings(value: unknown): SkyTurnSettings {
  const root = exactRecord(value, ["app", "project"], "settings");
  return { app: parseAppSettings(root.app), project: parseProjectSettings(root.project) };
}

export function parseAppSettings(value: unknown): AppSettings {
  const app = exactRecord(value, ["executableOverrides", "defaultExecutor", "externalEditor", "notifications"], "app settings");
  const overrides = exactRecord(app.executableOverrides, ["hermes", "codex"], "executable overrides");
  const notifications = exactRecord(app.notifications, ["desktop", "sound"], "notification preferences");
  if (app.defaultExecutor !== "hermes" && app.defaultExecutor !== "codex") invalid("default executor");
  if (!editorKinds.has(app.externalEditor as SettingsEditorKind)) invalid("external editor");
  if (typeof notifications.desktop !== "boolean" || typeof notifications.sound !== "boolean") invalid("notification preferences");
  return {
    executableOverrides: {
      hermes: parseExecutableOverride(overrides.hermes),
      codex: parseExecutableOverride(overrides.codex),
    },
    defaultExecutor: app.defaultExecutor,
    externalEditor: app.externalEditor as SettingsEditorKind,
    notifications: { desktop: notifications.desktop, sound: notifications.sound },
  };
}

export function parseProjectSettings(value: unknown): ProjectSettings {
  const project = exactRecord(value, ["commands", "defaultExecutionTarget"], "project settings");
  const commands = exactRecord(project.commands, ["start", "test", "build"], "project commands");
  const target = record(project.defaultExecutionTarget, "default execution target");
  let defaultExecutionTarget: ProjectSettings["defaultExecutionTarget"];
  if (target.executionTarget === "current_branch") {
    exactKeys(target, ["executionTarget", "selectedBranch"], "current branch target");
    defaultExecutionTarget = { executionTarget: "current_branch", selectedBranch: parseRef(target.selectedBranch, "selected branch") };
  } else if (target.executionTarget === "new_worktree") {
    exactKeys(target, ["executionTarget", "selectedBranch", "baseRef"], "new worktree target");
    const selectedBranch = parseRef(target.selectedBranch, "selected branch");
    const baseRef = parseRef(target.baseRef, "base ref");
    defaultExecutionTarget = { executionTarget: "new_worktree", selectedBranch, baseRef };
  } else {
    invalid("execution target");
  }
  return {
    commands: {
      start: parseCommand(commands.start, "start command"),
      test: parseCommand(commands.test, "test command"),
      build: parseCommand(commands.build, "build command"),
    },
    defaultExecutionTarget,
  };
}

function parseExecutableOverride(value: unknown): string | null {
  if (value === null) return null;
  if (typeof value !== "string" || value.length === 0 || value.length > 4096 || value.trim() !== value || /[\u0000-\u001f\u007f]/.test(value)) {
    invalid("executable override");
  }
  return value;
}

function parseCommand(value: unknown, field: string): string {
  if (typeof value !== "string" || value.length > 4096 || /[\u0000-\u001f\u007f]/.test(value)) invalid(field);
  return value;
}

function parseRef(value: unknown, field: string): string {
  if (typeof value !== "string" || !isSafeGitRef(value)) invalid(field);
  return value;
}

function isSafeGitRef(value: string): boolean {
  if (value === "HEAD") return true;
  if (
    value.length === 0 || value.length > maxRefLength || value.startsWith("-") || value.startsWith("/") ||
    value.endsWith("/") || value.endsWith(".") || value.includes("//") || value.includes("..") ||
    value.includes("@{") || value === "@" || /[\u0000-\u0020\u007f~^:?*[\]\\]/u.test(value)
  ) return false;
  return value.split("/").every((component) => !component.startsWith(".") && !component.endsWith(".lock"));
}

function exactRecord(value: unknown, keys: readonly string[], field: string): Record<string, unknown> {
  const result = record(value, field);
  exactKeys(result, keys, field);
  return result;
}

function record(value: unknown, field: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) invalid(field);
  return value as Record<string, unknown>;
}

function exactKeys(value: Record<string, unknown>, keys: readonly string[], field: string): void {
  const actual = Object.keys(value);
  if (actual.length !== keys.length || actual.some((key) => !keys.includes(key))) invalid(field);
}

function invalid(field: string): never {
  throw new Error(`Settings input is invalid: ${field}.`);
}
