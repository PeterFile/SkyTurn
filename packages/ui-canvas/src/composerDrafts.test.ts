import { createElement, StrictMode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createComposerDraftStore, draftScopeKey, useComposerDraft, COMPOSER_DRAFTS_KEY } from "./composerDrafts.js";

const followup = draftScopeKey(["followup", "p", "s"]);
const next = draftScopeKey(["followup", "p", "next"]);
const intake = draftScopeKey(["new", "p", "fast"]);
const target = { executionTarget: "current_branch" as const, selectedBranch: "main" };
const seed = () => ({ uuid: "uuid-1", createdAt: "2026-09-09T00:00:00.000Z" });
function storage() {
  const bytes = new Map<string, string>();
  return { bytes, getItem: (key: string) => bytes.get(key) ?? null,
    setItem: (key: string, value: string) => { bytes.set(key, value); } };
}
afterEach(() => vi.unstubAllGlobals());

describe("composer drafts", () => {
  const source = { projectId: "p", sessionId: "s", nodeId: "n", runId: "run", afterCheckpointId: "after",
    artifactPath: ".devflow/acceptance/report.txt" };
  const repair = draftScopeKey(["node", "p", "s", "n", "repair"]);
  it("appends artifact feedback explicitly, persists its binding, and preserves other scopes and newer edits", () => {
    const disk = storage();
    const store = createComposerDraftStore(() => disk);
    store.edit(repair, "existing\n"); store.edit(followup, "unrelated");
    expect(() => store.appendArtifactRepair(source, "feedback", false)).toThrow(/Append/);
    expect(store.read(repair).text).toBe("existing\n");
    store.appendArtifactRepair(source, "feedback", true);
    const captured = store.read(repair);
    expect(captured.text).toBe("existing\n\n\nfeedback");
    expect(captured.source).toEqual(source);
    const reopened = createComposerDraftStore(() => disk);
    expect(reopened.read(repair)).toEqual(captured);
    reopened.edit(repair, "edited");
    expect(reopened.read(repair).source).toEqual(source);
    reopened.clear(captured);
    expect(reopened.read(repair).text).toBe("edited");
    expect(reopened.read(followup).text).toBe("unrelated");
    for (const change of [{ runId: "new" }, { afterCheckpointId: "new" }, { artifactPath: ".devflow/acceptance/other.txt" }]) {
      expect(() => reopened.appendArtifactRepair({ ...source, ...change }, "wrong", true)).toThrow(/source/);
    }
    expect(reopened.read(repair).text).toBe("edited");
    reopened.edit(repair, "");
    reopened.appendArtifactRepair({ ...source, runId: "new" }, "fresh", false);
    expect(reopened.read(repair).source?.runId).toBe("new");
  });

  it("keeps artifact Repair binding isolated from fresh goal reuse and ordinary retries across reopen", () => {
    const disk = storage();
    const store = createComposerDraftStore(() => disk);
    store.appendArtifactRepair(source, "artifact feedback", false);
    store.edit(intake, "goal");
    const original = store.sessionAttempt(store.read(intake), target, seed);

    const reopened = createComposerDraftStore(() => disk);
    const unused = vi.fn(seed);
    expect(reopened.sessionAttempt(reopened.read(intake), target, unused).uuid).toBe(original.uuid);
    expect(unused).not.toHaveBeenCalled();
    reopened.edit(repair, "edited artifact feedback");
    const bound = reopened.read(repair);
    expect(bound.source).toEqual(source);
    expect(reopened.reuseSessionGoal(intake, reopened.read(intake), "goal")).toBe(true);
    expect(reopened.read(repair)).toBe(bound);
    expect(reopened.read(intake).source).toBeUndefined();

    const restored = createComposerDraftStore(() => disk);
    const fresh = restored.sessionAttempt(restored.read(intake), target, () => ({ ...seed(), uuid: "fresh" }));
    expect(fresh.uuid).not.toBe(original.uuid);
    expect(restored.sessionAttempt(restored.read(intake), target, unused).uuid).toBe(fresh.uuid);
    expect(unused).not.toHaveBeenCalled();
    expect(restored.read(repair)).toEqual(bound);
    expect(() => restored.appendArtifactRepair({ ...source, runId: "replaced" }, "stale", true)).toThrow(/source/);
    expect(restored.read(repair)).toEqual(bound);
    expect(restored.warning()).toBeNull();
  });

  it("reads legacy v2 text without inventing provenance and upgrades only on edit", () => {
    const disk = storage();
    const raw = JSON.stringify({ version: 2, drafts: [{ key: repair, text: "legacy", version: 3 }], retries: [] });
    disk.bytes.set(COMPOSER_DRAFTS_KEY, raw);
    const store = createComposerDraftStore(() => disk);
    expect(store.read(repair).source).toBeUndefined();
    expect(disk.bytes.get(COMPOSER_DRAFTS_KEY)).toBe(raw);
    store.appendArtifactRepair(source, "feedback", true);
    expect(createComposerDraftStore(() => disk).read(repair).source).toEqual(source);
    expect(store.warning()).toBeNull();
  });

  it.each([null, { extra: "bytes" }, { artifactPath: "/host/report.txt" }, { artifactPath: null }, { nodeId: "other" }, { runId: "/raw/handle" }])("rejects unsafe persisted source metadata atomically (%j)", change => {
    const disk = storage();
    const raw = JSON.stringify({ version: 3, drafts: [{ key: repair, text: "kept", version: 1, source: change === null ? null : { ...source, ...change } }], retries: [] });
    disk.bytes.set(COMPOSER_DRAFTS_KEY, raw);
    const store = createComposerDraftStore(() => disk);
    expect(store.warning()).toBeTruthy();
    store.edit(followup, "memory");
    expect(disk.bytes.get(COMPOSER_DRAFTS_KEY)).toBe(raw);
  });
  it("frames every scope and restores exact multiline text synchronously on reopen", () => {
    const disk = storage();
    const store = createComposerDraftStore(() => disk);
    const keys = [followup, next, intake, draftScopeKey(["new", "p", "plan"]),
      draftScopeKey(["followup", "p:s", "n"]), draftScopeKey(["followup", "p", "s:n"]),
      ...(["repair", "variant", "rollback"] as const).map(action => draftScopeKey(["node", "p", "s", "n", action])),
      draftScopeKey(["node", "p", "s", "n2", "repair"]), draftScopeKey(["followup", "p2", "s"])];
    expect(new Set(keys).size).toBe(keys.length);
    keys.forEach((key, i) => store.edit(key, ` \t${i}\r\n\n中文  `));
    const reopened = createComposerDraftStore(() => disk);
    keys.forEach((key, i) => expect(reopened.read(key).text).toBe(` \t${i}\r\n\n中文  `));
    expect(store.warning()).toBeNull();
  });

  it("clears only the captured version across selection changes and edit-away-and-back", () => {
    const store = createComposerDraftStore(() => storage());
    store.edit(followup, "old");
    const submitted = store.read(followup);
    store.edit(next, "other");
    store.clear(submitted);
    expect(store.read(followup).text).toBe("");
    expect(store.read(next).text).toBe("other");
    store.edit(followup, "old");
    const pending = store.read(followup);
    store.edit(followup, "away");
    store.edit(followup, "old");
    store.clear(pending);
    store.clear(submitted);
    expect(store.read(followup).text).toBe("old");
    expect(store.read(followup).version).not.toBe(pending.version);
  });

  it("makes null, empty and incomplete scopes inert", () => {
    const store = createComposerDraftStore(() => storage());
    store.edit(followup, "kept");
    for (const key of [null, "", draftScopeKey(["followup", "", "s"])]) {
      store.edit(key, "ignored");
      store.clear(store.read(key));
      expect(store.read(key).text).toBe("");
    }
    expect(store.read(followup).text).toBe("kept");
  });

  it("persists input identity before send, reuses after failure/reopen, retires only on success", () => {
    const disk = storage();
    let store = createComposerDraftStore(() => disk);
    store.edit(followup, " a\n ");
    const attempt = store.inputAttempt(store.read(followup), () => "input-1");
    store = createComposerDraftStore(() => disk);
    const retry = store.inputAttempt(store.read(followup), () => "wrong");
    expect(retry.inputId).toBe(attempt.inputId);
    store.edit(followup, "new");
    expect(store.inputAttempt(store.read(followup), () => "input-2").inputId).toBe("input-2");
    retry.complete();
    expect(store.read(followup).text).toBe("new");
    store.edit(followup, " a\n ");
    expect(store.inputAttempt(store.read(followup), () => "input-3").inputId).toBe("input-3");
  });

  it("reconstructs only the new-session seed and keys retries by goal, mode and target", () => {
    const disk = storage();
    const store = createComposerDraftStore(() => disk);
    store.edit(intake, " goal ");
    store.sessionAttempt(store.read(intake), target, seed);
    const reopened = createComposerDraftStore(() => disk);
    reopened.edit(intake, "goal");
    const unused = vi.fn(seed);
    const retry = reopened.sessionAttempt(reopened.read(intake), target, unused);
    expect(unused).not.toHaveBeenCalled();
    expect(retry.uuid).toBe("uuid-1");
    expect(retry.createdAt).toBe(seed().createdAt);
    for (const changed of [{ ...target, selectedBranch: "dev" },
      { executionTarget: "new_worktree" as const, selectedBranch: "main", baseRef: "base" }]) {
      expect(reopened.sessionAttempt(reopened.read(intake), changed, () => ({ ...seed(), uuid: "new" })).uuid).toBe("new");
    }
    const plan = draftScopeKey(["new", "p", "plan"]);
    reopened.edit(plan, "goal");
    expect(reopened.sessionAttempt(reopened.read(plan), target, () => ({ ...seed(), uuid: "plan" })).uuid).toBe("plan");
    reopened.edit(intake, "another goal");
    expect(reopened.sessionAttempt(reopened.read(intake), target, () => ({ ...seed(), uuid: "other" })).uuid).toBe("other");
    expect(disk.bytes.get(COMPOSER_DRAFTS_KEY)).not.toMatch(/busy|workspace|nodes|error/);
  });

  it("reuses a goal with fresh seed identities across targets while preserving unrelated retries and late-clear safety", () => {
    const disk = storage();
    const store = createComposerDraftStore(() => disk);
    const goal = " \tgoal\r\n ";
    const otherMode = draftScopeKey(["new", "p", "plan"]);
    const otherProject = draftScopeKey(["new", "p2", "fast"]);
    const worktree = { executionTarget: "new_worktree" as const, selectedBranch: "dev", baseRef: "dev" };
    store.edit(intake, goal);
    const captured = store.read(intake);
    const old = store.sessionAttempt(captured, target, seed);
    store.sessionAttempt(captured, worktree, seed);
    for (const key of [otherMode, otherProject]) {
      store.edit(key, goal); store.sessionAttempt(store.read(key), target, seed);
    }
    store.edit(intake, "other goal");
    store.sessionAttempt(store.read(intake), target, seed);
    store.edit(intake, goal);
    store.edit(followup, goal);
    store.inputAttempt(store.read(followup), () => "keep-input");
    expect(store.reuseSessionGoal(intake, store.read(intake), goal)).toBe(true);
    expect(store.read(intake).text).toBe(goal);
    expect(store.read(intake)).not.toBe(captured);
    const reopened = createComposerDraftStore(() => disk);
    for (const selected of [target, worktree]) {
      expect(reopened.sessionAttempt(reopened.read(intake), selected, () => ({ ...seed(), uuid: "fresh" })).uuid).toBe("fresh");
    }
    for (const key of [otherMode, otherProject]) {
      expect(reopened.sessionAttempt(reopened.read(key), target, () => ({ ...seed(), uuid: "wrong" })).uuid).toBe(seed().uuid);
    }
    expect(reopened.inputAttempt(reopened.read(followup), () => "wrong").inputId).toBe("keep-input");
    reopened.edit(intake, "other goal");
    expect(reopened.sessionAttempt(reopened.read(intake), target, () => ({ ...seed(), uuid: "wrong" })).uuid).toBe(seed().uuid);
    expect(store.sessionAttempt(store.read(intake), target, () => ({ ...seed(), uuid: "new-live" })).uuid).toBe("new-live");
    old.complete();
    expect(store.read(intake).text).toBe(goal);
    expect(store.sessionAttempt(store.read(intake), target, () => ({ ...seed(), uuid: "wrong" })).uuid).toBe("new-live");
  });

  it("rejects stale or non-New-Session goal replacement without writes or retry retirement", () => {
    const disk = storage();
    const store = createComposerDraftStore(() => disk);
    store.edit(intake, "goal");
    const captured = store.read(intake);
    store.sessionAttempt(captured, target, seed);
    store.edit(intake, "away"); store.edit(intake, "goal");
    const raw = disk.bytes.get(COMPOSER_DRAFTS_KEY);
    for (const [key, snapshot, goal] of [[intake, captured, "goal"], [intake, store.read(intake), "  "],
      [followup, store.read(followup), "goal"], [null, store.read(null), "goal"]] as const) {
      expect(store.reuseSessionGoal(key, snapshot, goal)).toBe(false);
    }
    expect(disk.bytes.get(COMPOSER_DRAFTS_KEY)).toBe(raw);
    expect(store.sessionAttempt(store.read(intake), target, () => ({ ...seed(), uuid: "wrong" })).uuid).toBe(seed().uuid);
  });

  it.each(["{", "null", '{"version":999}', '{"version":1,"drafts":[],"retries":[]}',
    JSON.stringify({ version: 2, drafts: [{ key: followup, text: 7, version: 1 }], retries: [] }),
    JSON.stringify({ version: 2, drafts: Array(2).fill({ key: followup, text: "x", version: 1 }), retries: [] }),
    JSON.stringify({ version: 2, drafts: [], retries: [{ key: "bad", inputId: "x" }] }),
    " ".repeat(1_048_577)])("preserves malformed/bounded-invalid bytes without clobbering (%#)", raw => {
    const disk = storage();
    disk.bytes.set(COMPOSER_DRAFTS_KEY, raw);
    const store = createComposerDraftStore(() => disk);
    expect(store.read(followup).text).toBe("");
    store.edit(followup, "memory");
    expect(store.read(followup).text).toBe("memory");
    expect(store.warning()).toBeTruthy();
    expect(disk.bytes.get(COMPOSER_DRAFTS_KEY)).toBe(raw);
  });

  it.each(["getter", "getItem", "setItem", "unavailable"])("retains memory and reports %s failure", failure => {
    const disk = storage();
    const fail = () => { throw new Error("denied"); };
    const store = createComposerDraftStore(() => {
      if (failure === "getter") return fail();
      if (failure === "unavailable") return undefined;
      return { getItem: failure === "getItem" ? fail : disk.getItem,
        setItem: failure === "setItem" ? fail : disk.setItem };
    });
    store.edit(followup, "retained");
    store.edit(next, "also retained");
    const attempt = store.inputAttempt(store.read(followup), () => "id");
    expect(store.inputAttempt(store.read(followup), () => "wrong").inputId).toBe(attempt.inputId);
    expect(store.read(followup).text).toBe("retained");
    expect(store.read(next).text).toBe("also retained");
    expect(store.warning()).toBeTruthy();
  });

  it("never evicts when limits are reached and retries writes after quota recovery", () => {
    const disk = storage();
    const store = createComposerDraftStore(() => disk);
    for (let i = 0; i < 260; i++) store.edit(draftScopeKey(["followup", "p", String(i)]), String(i));
    expect(store.read(draftScopeKey(["followup", "p", "0"])).text).toBe("0");
    expect(store.read(draftScopeKey(["followup", "p", "259"])).text).toBe("259");
    expect(store.warning()).toBeTruthy();
    store.edit(followup, "x".repeat(1_048_577));
    expect(store.read(followup).text.length).toBe(1_048_577);
    let denied = true;
    const quota = createComposerDraftStore(() => ({ getItem: () => null, setItem: (key, value) => {
      if (denied) throw new Error("quota");
      disk.setItem(key, value);
    } }));
    quota.edit(followup, "small");
    expect(quota.warning()).toBeTruthy();
    denied = false;
    quota.edit(next, "recovered");
    expect(quota.warning()).toBeNull();
    expect(createComposerDraftStore(() => disk).read(followup).text).toBe("small");
  });

  it("retries persisting an existing identity before sending again after quota recovery", () => {
    const disk = storage();
    let denied = true;
    const store = createComposerDraftStore(() => ({ getItem: disk.getItem, setItem: (key, value) => {
      if (denied) throw new Error("quota");
      disk.setItem(key, value);
    } }));
    store.edit(followup, "text");
    store.inputAttempt(store.read(followup), () => "original");
    denied = false;
    store.inputAttempt(store.read(followup), () => "wrong");
    const reopened = createComposerDraftStore(() => disk);
    expect(reopened.read(followup).text).toBe("text");
    expect(reopened.inputAttempt(reopened.read(followup), () => "wrong").inputId).toBe("original");
  });

  it("rejects duplicate retry identities and unchecked seed fields atomically", () => {
    const disk = storage();
    const store = createComposerDraftStore(() => disk);
    store.edit(intake, "goal");
    store.sessionAttempt(store.read(intake), target, seed);
    const saved = disk.bytes.get(COMPOSER_DRAFTS_KEY)!;
    const parsed = JSON.parse(saved) as { version: number; drafts: unknown[]; retries: Record<string, unknown>[] };
    const invalid = [
      { ...parsed, retries: [...parsed.retries, ...parsed.retries] },
      { ...parsed, retries: [{ ...parsed.retries[0], busy: true }] },
      { ...parsed, retries: [{ ...parsed.retries[0], createdAt: "yesterday" }] },
      { ...parsed, drafts: Array(257).fill({ key: followup, text: "x", version: 1 }) },
    ];
    for (const data of invalid) {
      const raw = JSON.stringify(data);
      disk.bytes.set(COMPOSER_DRAFTS_KEY, raw);
      const reopened = createComposerDraftStore(() => disk);
      expect(reopened.read(intake).text).toBe("");
      reopened.edit(intake, "memory");
      expect(reopened.warning()).toBeTruthy();
      expect(disk.bytes.get(COMPOSER_DRAFTS_KEY)).toBe(raw);
    }
  });

  it("does not persist invalid generated identities or invent node-action retries", () => {
    const disk = storage();
    const store = createComposerDraftStore(() => disk);
    store.edit(followup, "text");
    const saved = disk.bytes.get(COMPOSER_DRAFTS_KEY);
    expect(() => store.inputAttempt(store.read(followup), () => "")).toThrow();
    expect(disk.bytes.get(COMPOSER_DRAFTS_KEY)).toBe(saved);
    const node = draftScopeKey(["node", "p", "s", "n", "repair"]);
    store.edit(node, "instruction");
    expect(() => store.inputAttempt(store.read(node), () => "id")).toThrow();
  });

  it("catches the native localStorage getter and supports direct SSR reads", () => {
    const descriptor = Object.getOwnPropertyDescriptor(globalThis, "localStorage");
    try {
      Object.defineProperty(globalThis, "localStorage", { configurable: true, get() { throw new Error("denied"); } });
      const store = createComposerDraftStore();
      store.edit(followup, "memory");
      expect(store.warning()).toBeTruthy();
      expect(store.read(followup).text).toBe("memory");
      Reflect.deleteProperty(globalThis, "localStorage");
      expect(createComposerDraftStore().read(followup).text).toBe("");
    } finally {
      if (descriptor) Object.defineProperty(globalThis, "localStorage", descriptor);
      else Reflect.deleteProperty(globalThis, "localStorage");
    }
  });

  it("has stable snapshots and safe repeated subscribe/unsubscribe; SSR never reads browser storage", () => {
    const getter = vi.fn(() => { throw new Error("no browser"); });
    const store = createComposerDraftStore(getter);
    function Probe() { return createElement("span", null, useComposerDraft(followup, store).text); }
    expect(renderToStaticMarkup(createElement(StrictMode, null, createElement(Probe)))).toBe("<span></span>");
    expect(getter).not.toHaveBeenCalled();
    const listener = vi.fn();
    const off = store.subscribe(listener);
    off(); off();
    const offAgain = store.subscribe(listener);
    store.edit(followup, "new");
    expect(listener).toHaveBeenCalledTimes(1);
    expect(store.read(followup)).toBe(store.read(followup));
    offAgain();
    store.edit(followup, "later");
    expect(listener).toHaveBeenCalledTimes(1);
  });
});
