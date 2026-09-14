import { useSyncExternalStore } from "react";

export type ComposerDraftScope =
  | readonly ["new", string, "fast" | "plan"]
  | readonly ["followup", string, string]
  | readonly ["node", string, string, string, "repair" | "variant" | "rollback"];
type StorageAccess = Pick<Storage, "getItem" | "setItem">;
type Target = { executionTarget: "current_branch" | "new_worktree"; selectedBranch: string; baseRef?: string };
type Seed = Readonly<{ uuid: string; createdAt: string }>;
export type ComposerDraftSnapshot = Readonly<{ key: string | null; text: string; version: number }>;
type Retry = Readonly<{ key: string; inputId: string } | { key: string; uuid: string; createdAt: string }>;
export const COMPOSER_DRAFTS_KEY = "skyturn_composer_drafts";
const LIMIT = 1_048_576;
const MAX_RECORDS = 256;
const EMPTY: ComposerDraftSnapshot = Object.freeze({ key: null, text: "", version: 0 });
const WARNING = "Drafts are kept in memory only; storage is unavailable or full. Reopening may lose recent edits and retry identity.";
const CORRUPT = "Saved drafts could not be read safely. Existing storage was preserved; new edits and retry identity stay in memory only.";
const record = (value: unknown): value is Record<string, unknown> => !!value && typeof value === "object" && !Array.isArray(value);
const nonempty = (value: unknown): value is string => typeof value === "string" && value.length > 0;
const fields = (value: Record<string, unknown>, names: string[]) => Object.keys(value).sort().join() === names.sort().join();
function validScope(value: unknown): value is ComposerDraftScope {
  return Array.isArray(value) && value.every(nonempty) && (
    (value[0] === "new" && value.length === 3 && ["fast", "plan"].includes(value[2])) ||
    (value[0] === "followup" && value.length === 3) ||
    (value[0] === "node" && value.length === 5 && ["repair", "variant", "rollback"].includes(value[4]))
  );
}
export function draftScopeKey(scope: ComposerDraftScope | null): string | null {
  return validScope(scope) ? JSON.stringify(scope) : null;
}
function scopeFromKey(key: unknown): ComposerDraftScope | null {
  if (!nonempty(key)) return null;
  try {
    const value: unknown = JSON.parse(key);
    return validScope(value) && JSON.stringify(value) === key ? value : null;
  } catch { return null; }
}
function validRetry(value: unknown): value is Retry {
  if (!record(value) || !nonempty(value.key)) return false;
  const key: unknown = JSON.parse(value.key);
  if (!Array.isArray(key) || JSON.stringify(key) !== value.key) return false;
  const scope = scopeFromKey(key[1]);
  if (key[0] === "input") return scope?.[0] === "followup" && key.length === 3 &&
    typeof key[2] === "string" && nonempty(value.inputId) && fields(value, ["key", "inputId"]);
  return key[0] === "session" && scope?.[0] === "new" && key.length === 6 && nonempty(key[2]) &&
    key[2] === key[2].trim() && ["current_branch", "new_worktree"].includes(key[3]) &&
    nonempty(key[4]) && (key[3] === "current_branch" ? key[5] === null : nonempty(key[5])) &&
    nonempty(value.uuid) && typeof value.createdAt === "string" &&
    Number.isFinite(Date.parse(value.createdAt)) && new Date(value.createdAt).toISOString() === value.createdAt &&
    fields(value, ["key", "uuid", "createdAt"]);
}

export function createComposerDraftStore(getStorage: () => StorageAccess | undefined = () => globalThis.localStorage) {
  const drafts = new Map<string, ComposerDraftSnapshot>();
  const retries = new Map<string, Retry>();
  const listeners = new Set<() => void>();
  let loaded = false;
  let writable = false;
  let disk: StorageAccess | undefined;
  let error: string | null = null;
  let version = 0;
  function load() {
    if (loaded) return;
    loaded = true;
    try {
      disk = getStorage();
      if (!disk) { error = WARNING; return; }
      const raw = disk.getItem(COMPOSER_DRAFTS_KEY);
      if (raw !== null) {
        if (raw.length > LIMIT) throw new Error("Draft storage limit.");
        const parsed: unknown = JSON.parse(raw);
        if (!record(parsed) || parsed.version !== 2 || !fields(parsed, ["version", "drafts", "retries"]) ||
          !Array.isArray(parsed.drafts) || !Array.isArray(parsed.retries) ||
          parsed.drafts.length + parsed.retries.length > MAX_RECORDS) throw new Error("Invalid drafts.");
        for (const row of parsed.drafts) {
          if (!record(row) || !fields(row, ["key", "text", "version"]) || !nonempty(row.key) ||
            !scopeFromKey(row.key) || typeof row.text !== "string" || typeof row.version !== "number" ||
            !Number.isSafeInteger(row.version) || row.version < 1 || drafts.has(row.key)) throw new Error("Invalid draft.");
          drafts.set(row.key, Object.freeze({ key: row.key, text: row.text, version: row.version }));
          version = Math.max(version, row.version);
        }
        for (const row of parsed.retries) {
          if (!validRetry(row) || retries.has(row.key)) throw new Error("Invalid retry.");
          retries.set(row.key, Object.freeze(row));
        }
      }
      writable = true;
    } catch {
      drafts.clear(); retries.clear(); error = CORRUPT;
    }
  }
  function save() {
    if (writable && disk) {
      try {
        if (drafts.size + retries.size > MAX_RECORDS) throw new Error("Draft count limit.");
        const raw = JSON.stringify({ version: 2, drafts: [...drafts.values()], retries: [...retries.values()] });
        if (raw.length > LIMIT) throw new Error("Draft storage limit.");
        disk.setItem(COMPOSER_DRAFTS_KEY, raw);
        error = null;
      } catch { error = WARNING; }
    }
    listeners.forEach(listener => listener());
  }
  function clearCaptured(snapshot: ComposerDraftSnapshot) {
    return !!snapshot.key && drafts.get(snapshot.key) === snapshot && drafts.delete(snapshot.key);
  }
  function attempt<T extends Retry>(snapshot: ComposerDraftSnapshot, entry: T) {
    if (!retries.has(entry.key)) retries.set(entry.key, entry);
    save();
    return { ...entry, complete: () => {
      const retired = retries.get(entry.key) === entry && retries.delete(entry.key);
      const cleared = clearCaptured(snapshot);
      if (retired || cleared) save();
    } };
  }
  return {
    subscribe(listener: () => void) { listeners.add(listener); return () => { listeners.delete(listener); }; },
    warning() { load(); return error; },
    read(key: string | null): ComposerDraftSnapshot { load(); return key ? drafts.get(key) ?? EMPTY : EMPTY; },
    edit(key: string | null, text: string) {
      load();
      if (!key || !scopeFromKey(key)) return;
      // Object identity is the final clear gate, even if a persisted counter reaches its bound.
      version = version < Number.MAX_SAFE_INTEGER ? version + 1 : 1;
      drafts.set(key, Object.freeze({ key, text, version }));
      save();
    },
    clear(snapshot: ComposerDraftSnapshot) { load(); if (clearCaptured(snapshot)) save(); },
    inputAttempt(snapshot: ComposerDraftSnapshot, createInputId: () => string) {
      load();
      if (scopeFromKey(snapshot.key)?.[0] !== "followup") throw new Error("Followup draft required.");
      const key = JSON.stringify(["input", snapshot.key, snapshot.text]);
      const existing = retries.get(key);
      const entry = existing && "inputId" in existing ? existing : Object.freeze({ key, inputId: createInputId() });
      if (!nonempty(entry.inputId)) throw new Error("Nonempty input identity required.");
      return attempt(snapshot, entry);
    },
    sessionAttempt(snapshot: ComposerDraftSnapshot, target: Target, createSeed: () => Seed) {
      load();
      if (scopeFromKey(snapshot.key)?.[0] !== "new") throw new Error("New-session draft required.");
      const key = JSON.stringify(["session", snapshot.key, snapshot.text.trim(), target.executionTarget,
        target.selectedBranch, target.executionTarget === "new_worktree" ? target.baseRef : null]);
      const existing = retries.get(key);
      const entry = existing && "uuid" in existing ? existing : Object.freeze({ key, ...createSeed() });
      if (!validRetry(entry)) throw new Error("Invalid new-session seed or target.");
      return attempt(snapshot, entry);
    },
  };
}

export const composerDraftStore = createComposerDraftStore();
export function useComposerDraft(key: string | null, store = composerDraftStore) {
  const snapshot = useSyncExternalStore(store.subscribe, () => store.read(key), () => EMPTY);
  const warning = useSyncExternalStore(store.subscribe, store.warning, () => null);
  return { text: snapshot.text, warning, setText: (text: string) => store.edit(key, text),
    capture: () => store.read(key) };
}
