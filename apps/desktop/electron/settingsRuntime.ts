import { createHash, randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";

import type { AgentDescriptor } from "@skyturn/project-core" with { "resolution-mode": "import" };
import type {
  AppSettings,
  SettingsAgentPrerequisite,
  SettingsGitPrerequisites,
  SettingsSnapshot,
  SkyTurnSettings,
} from "@skyturn/persistence" with { "resolution-mode": "import" };

const maxSettingsBytes = 1024 * 1024;
const maxSettingsProjects = 1024;

export type SettingsRuntimeErrorCode =
  | "INVALID_INPUT"
  | "INVALID_PERSISTED_SETTINGS"
  | "SETTINGS_CAPACITY_EXCEEDED"
  | "SETTINGS_IO";

export class SettingsRuntimeError extends Error {
  constructor(readonly code: SettingsRuntimeErrorCode, message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "SettingsRuntimeError";
  }
}

interface PersistedSettingsDocument {
  schemaVersion: 1;
  app: AppSettings;
  projects: Record<string, { canonicalRootPath: string; settings: SkyTurnSettings["project"] }>;
}

export interface SettingsRuntimeOptions {
  filePath: string;
  canonicalizeProjectRoot(projectRoot: string): Promise<string>;
  defaultProjectBranch(projectRoot: string): Promise<string>;
  createDefaultSettings(selectedBranch?: string): SkyTurnSettings;
  parseSettings(value: unknown): SkyTurnSettings;
}

export function createSettingsRuntime(options: SettingsRuntimeOptions) {
  let saveTail = Promise.resolve();

  async function load(): Promise<PersistedSettingsDocument> {
    let text: string;
    try {
      text = await fs.readFile(options.filePath, "utf8");
    } catch (error) {
      if (errorCode(error) === "ENOENT") return emptyDocument(options.createDefaultSettings().app);
      throw new SettingsRuntimeError("SETTINGS_IO", "Settings could not be read.", { cause: error });
    }
    if (Buffer.byteLength(text, "utf8") > maxSettingsBytes) return invalidPersisted();
    try {
      return parseDocument(JSON.parse(text) as unknown, options);
    } catch (error) {
      if (error instanceof SettingsRuntimeError) throw error;
      throw new SettingsRuntimeError("INVALID_PERSISTED_SETTINGS", "Persisted settings are invalid.", { cause: error });
    }
  }

  return {
    async get(projectRoot: string): Promise<{ projectRoot: string; settings: SkyTurnSettings }> {
      const canonicalRootPath = await options.canonicalizeProjectRoot(projectRoot);
      const document = await load();
      const stored = document.projects[projectKey(canonicalRootPath)];
      if (stored && stored.canonicalRootPath !== canonicalRootPath) return invalidPersisted();
      const project = stored?.settings ?? options.createDefaultSettings(
        await options.defaultProjectBranch(canonicalRootPath),
      ).project;
      return { projectRoot: canonicalRootPath, settings: clone({ app: document.app, project }) };
    },

    async getAppSettings(): Promise<AppSettings> {
      return clone((await load()).app);
    },

    async save(projectRoot: string, value: unknown): Promise<{ projectRoot: string; settings: SkyTurnSettings }> {
      let settings: SkyTurnSettings;
      try {
        settings = options.parseSettings(value);
      } catch (error) {
        throw new SettingsRuntimeError("INVALID_INPUT", "Settings input is invalid.", { cause: error });
      }
      const firstCanonicalRoot = await options.canonicalizeProjectRoot(projectRoot);
      let result!: { projectRoot: string; settings: SkyTurnSettings };
      const save = saveTail.then(async () => {
        const canonicalRootPath = await options.canonicalizeProjectRoot(projectRoot);
        if (canonicalRootPath !== firstCanonicalRoot) throw new Error("Project root is not open in SkyTurn.");
        const document = await load();
        document.app = settings.app;
        const key = projectKey(canonicalRootPath);
        if (!Object.hasOwn(document.projects, key) && Object.keys(document.projects).length >= maxSettingsProjects) {
          capacityExceeded(`Settings document cannot contain more than ${maxSettingsProjects} projects.`);
        }
        document.projects[key] = { canonicalRootPath, settings: settings.project };
        const serialized = JSON.stringify(document, null, 2);
        if (Buffer.byteLength(serialized, "utf8") > maxSettingsBytes) {
          capacityExceeded(`Settings document cannot exceed ${maxSettingsBytes} UTF-8 bytes.`);
        }
        await writeAtomically(options.filePath, serialized);
        result = { projectRoot: canonicalRootPath, settings: clone(settings) };
      });
      saveTail = save.catch(() => undefined);
      try {
        await save;
        return result;
      } catch (error) {
        if (error instanceof SettingsRuntimeError || error instanceof Error && error.message === "Project root is not open in SkyTurn.") throw error;
        throw new SettingsRuntimeError("SETTINGS_IO", "Settings could not be saved.", { cause: error });
      }
    },
  };
}

function parseDocument(value: unknown, options: SettingsRuntimeOptions): PersistedSettingsDocument {
  const root = exactRecord(value, ["schemaVersion", "app", "projects"]);
  if (root.schemaVersion !== 1) return invalidPersisted();
  const defaults = options.createDefaultSettings();
  const app = options.parseSettings({ app: root.app, project: defaults.project }).app;
  const rawProjects = exactRecord(root.projects, Object.keys(record(root.projects)));
  if (Object.keys(rawProjects).length > maxSettingsProjects) return invalidPersisted();
  const projects: PersistedSettingsDocument["projects"] = {};
  for (const [key, candidate] of Object.entries(rawProjects)) {
    if (!/^[0-9a-f]{64}$/.test(key)) return invalidPersisted();
    const entry = exactRecord(candidate, ["canonicalRootPath", "settings"]);
    if (typeof entry.canonicalRootPath !== "string" || projectKey(entry.canonicalRootPath) !== key) return invalidPersisted();
    projects[key] = {
      canonicalRootPath: entry.canonicalRootPath,
      settings: options.parseSettings({ app: defaults.app, project: entry.settings }).project,
    };
  }
  return { schemaVersion: 1, app, projects };
}

async function writeAtomically(filePath: string, serialized: string): Promise<void> {
  const parent = path.dirname(filePath);
  const temporary = `${filePath}.${process.pid}.${randomUUID()}.tmp`;
  await fs.mkdir(parent, { recursive: true, mode: 0o700 });
  let handle: Awaited<ReturnType<typeof fs.open>> | null = null;
  let renamed = false;
  try {
    handle = await fs.open(temporary, "wx", 0o600);
    await handle.writeFile(serialized, "utf8");
    await handle.sync();
    await handle.close();
    handle = null;
    await fs.rename(temporary, filePath);
    renamed = true;
    if (process.platform !== "win32") {
      const directory = await fs.open(parent, "r");
      try { await directory.sync(); } finally { await directory.close(); }
    }
  } finally {
    await handle?.close().catch(() => undefined);
    if (!renamed) await fs.rm(temporary, { force: true }).catch(() => undefined);
  }
}

function emptyDocument(app: AppSettings): PersistedSettingsDocument {
  return { schemaVersion: 1, app, projects: {} };
}

function projectKey(projectRoot: string): string {
  return createHash("sha256").update(projectRoot, "utf8").digest("hex");
}

function exactRecord(value: unknown, keys: readonly string[]): Record<string, unknown> {
  const result = record(value);
  const actual = Object.keys(result);
  if (actual.length !== keys.length || actual.some((key) => !keys.includes(key))) return invalidPersisted();
  return result;
}

function record(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return invalidPersisted();
  return value as Record<string, unknown>;
}

function invalidPersisted(): never {
  throw new SettingsRuntimeError("INVALID_PERSISTED_SETTINGS", "Persisted settings are invalid.");
}

function capacityExceeded(message: string): never {
  throw new SettingsRuntimeError("SETTINGS_CAPACITY_EXCEEDED", `Settings capacity exceeded: ${message}`);
}

function errorCode(error: unknown): string | undefined {
  return error && typeof error === "object" && "code" in error ? String(error.code) : undefined;
}

function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

export function createSettingsSnapshot(
  record: { projectRoot: string; settings: SkyTurnSettings },
  git: SettingsGitPrerequisites,
  agents: readonly AgentDescriptor[],
): SettingsSnapshot {
  const agentFacts = (["hermes", "codex"] as const).map((kind) => settingsAgentPrerequisite(
    kind,
    agents.find((agent) => agent.kind === kind),
  ));
  return {
    protocolVersion: 1,
    ...record,
    prerequisites: {
      project: { registered: true, canonicalRootPath: record.projectRoot, git },
      agents: agentFacts,
      defaultExecutorRunnable: agentFacts.some((agent) =>
        agent.kind === record.settings.app.defaultExecutor && agent.runnable
      ),
    },
  };
}

function settingsAgentPrerequisite(
  kind: "hermes" | "codex",
  descriptor: AgentDescriptor | undefined,
): SettingsAgentPrerequisite {
  const setup = kind === "codex"
    ? {
        documentationUrl: "https://github.com/openai/codex/blob/main/docs/authentication.md",
        installCommand: "npm install -g @openai/codex",
        authCommand: "codex login",
      }
    : {
        documentationUrl: "https://github.com/NousResearch/hermes-agent",
        installCommand: "curl -fsSL https://hermes-agent.nousresearch.com/install.sh | bash",
        authCommand: "hermes setup",
      };
  return {
    kind,
    executablePath: descriptor?.executablePath ?? null,
    version: descriptor?.version ?? null,
    cli: descriptor?.readiness?.categories.includes("version-probe-failed")
      ? "unknown"
      : descriptor?.readiness?.cli.available === true
        ? "ready"
        : descriptor?.readiness?.cli.available === false || descriptor?.status === "missing"
          ? "missing"
          : "unknown",
    auth: descriptor?.readiness?.auth.status ?? "unknown",
    runnable: descriptor ? isRunnableSettingsAgent(descriptor) : false,
    supportLevel: descriptor?.supportLevel ?? "detected-only",
    setup,
  };
}

function isRunnableSettingsAgent(descriptor: AgentDescriptor): boolean {
  return descriptor.status === "available" &&
    descriptor.readiness?.cli.available === true &&
    !descriptor.readiness.categories.includes("version-probe-failed") &&
    (descriptor.supportLevel === "experimental-run" || descriptor.supportLevel === "supported-run");
}
