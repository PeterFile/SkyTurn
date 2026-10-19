import { isValidElement, type ReactElement, type ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { RecentTaskReuse, type RecentTaskReuseProps, type RecentTaskReuseSource } from "./RecentTaskReuse.js";

// Match the existing shallow component tests without adding a DOM dependency.
const hooks = vi.hoisted(() => ({ slots: [] as unknown[], cursor: 0, dirty: false,
  layouts: [] as (() => void | (() => void))[], cleanups: [] as (() => void)[] }));
vi.mock("react", async (original) => {
  const react = await original<typeof import("react")>();
  const state = (initial: unknown) => {
    const index = hooks.cursor++;
    if (!(index in hooks.slots)) hooks.slots[index] = typeof initial === "function" ? initial() : initial;
    return [hooks.slots[index], (value: unknown) => {
      const next = typeof value === "function" ? value(hooks.slots[index]) : value;
      if (!Object.is(next, hooks.slots[index])) { hooks.slots[index] = next; hooks.dirty = true; }
    }];
  };
  return { ...react, useState: state, useRef: (current: unknown) => state({ current })[0],
    useId: () => state("recent-task-test")[0],
    useLayoutEffect: (effect: () => void | (() => void)) => hooks.layouts.push(effect) };
});

function elements(node: ReactNode): ReactElement<Record<string, unknown>>[] {
  if (Array.isArray(node)) return node.flatMap(elements);
  if (!isValidElement<Record<string, unknown>>(node)) return [];
  return [node, ...elements(node.props.children as ReactNode)];
}
function task(id = "s1", patch: Partial<RecentTaskReuseSource> = {}): RecentTaskReuseSource {
  return { id, projectId: "p1", kind: "canvas", title: "Same title", goal: `Goal ${id}`,
    createdAt: "2026-10-15T00:00:00.000Z", updatedAt: "2026-10-16T00:00:00.000Z", ...patch };
}
function setup(patch: Partial<RecentTaskReuseProps> = {}) {
  let props: RecentTaskReuseProps = { sessions: [task()], projectId: "p1", mode: "fast", draft: "",
    busy: false, onUseGoal: vi.fn(), ...patch };
  function render() {
    let tree: ReactNode;
    let attempts = 0;
    do {
      hooks.cursor = 0; hooks.dirty = false; hooks.layouts = [];
      tree = RecentTaskReuse(props);
      if (++attempts > 10) throw new Error("Component did not settle.");
    } while (hooks.dirty);
    hooks.cleanups.forEach((cleanup) => cleanup());
    hooks.cleanups = hooks.layouts.flatMap((effect) => {
      const cleanup = effect();
      return cleanup ? [cleanup] : [];
    });
    const all = elements(tree);
    const choices = all.filter((element) => element.type === "input" && element.props.type === "radio");
    const button = (name: string) => all.find((element) => element.type === "button" && element.props.children === name);
    return { tree, all, choices, button, html: renderToStaticMarkup(tree),
      choose: (id = "s1") => {
        const choice = choices.find((element) => element.props["data-session-id"] === id);
        expect(choice, `Missing choice ${id}`).toBeDefined();
        (choice!.props.onChange as () => void)();
      },
      click: (name: string) => {
        const target = button(name);
        expect(target, `Missing button ${name}`).toBeDefined();
        (target!.props.onClick as () => void)();
      } };
  }
  return { get props() { return props; }, render,
    update: (patch: Partial<RecentTaskReuseProps>) => { props = { ...props, ...patch }; return render(); } };
}
beforeEach(() => {
  hooks.cleanups.forEach((cleanup) => cleanup());
  hooks.slots = []; hooks.cursor = 0; hooks.dirty = false; hooks.layouts = []; hooks.cleanups = [];
});

describe("recent Canvas task goals", () => {
  it("isolates project history and excludes plan sessions and blank goals", () => {
    const view = setup({ sessions: [task(), task("foreign", { projectId: "p2" }),
      task("plan", { kind: "plan" }), task("blank", { goal: " \t\r\n" })] }).render();
    expect(view.choices.map((choice) => choice.props["data-session-id"])).toEqual(["s1"]);
    expect(view.html).toContain('aria-label="Recent tasks"');
    expect(view.html).not.toContain("foreign");
    expect(view.html).not.toContain("Goal plan");
  });

  it.each([{ sessions: [] }, { sessions: [task("other", { projectId: "p2" })] }])("handles empty project history (%#)", ({ sessions }) => {
    const app = setup({ sessions });
    const view = app.render();
    expect(view.choices).toHaveLength(0);
    expect(view.html).toContain("No recent tasks for this project.");
    expect(view.button("Use")?.props.disabled).toBe(true);
    view.click("Use");
    expect(app.props.onUseGoal).not.toHaveBeenCalled();
  });

  it.each([null, ""])("requires a project scope (%s)", (projectId) => {
    const view = setup({ projectId }).render();
    expect(view.choices).toHaveLength(0);
    expect(view.button("Use")?.props.disabled).toBe(true);
  });

  it("keeps same-title choices distinct by their full visible session IDs", () => {
    const app = setup({ sessions: [task("same-prefix-a"), task("same-prefix-b")] });
    let view = app.render();
    expect(view.choices).toHaveLength(2);
    expect(new Set(view.choices.map((choice) => choice.props["aria-label"])).size).toBe(2);
    expect(view.html).toContain("same-prefix-a</small>");
    expect(view.html).toContain("same-prefix-b</small>");
    view.choose("same-prefix-b"); view = app.render();
    expect(view.choices.filter((choice) => choice.props.checked).map((choice) => choice.props.value)).toEqual(["same-prefix-b"]);
    view.click("Use");
    expect(app.props.onUseGoal).toHaveBeenCalledExactlyOnceWith("Goal same-prefix-b");
  });

  it("copies only the exact raw goal after explicit Use and consumes repeated clicks", () => {
    const goal = " \tBuild <canvas> & 中文\r\n\nKeep spacing  ";
    const source = { ...task("s1", { goal }), nodes: [{ runId: "old-run", output: ["old output"] }],
      target: { executionTarget: "new_worktree", selectedBranch: "old-branch" }, retryIdentity: "old-retry" };
    const app = setup({ sessions: [source] });
    const initial = app.render();
    expect(initial.choices[0].props.checked).toBe(false);
    initial.click("Use"); initial.choose();
    expect(app.props.onUseGoal).not.toHaveBeenCalled();
    const selected = app.render();
    expect(selected.html).toContain('aria-label="Selected task goal"');
    expect(selected.html).toContain("&lt;canvas&gt; &amp; 中文");
    expect(selected.html).not.toMatch(/old-run|old output|old-branch|old-retry/);
    selected.click("Use"); selected.click("Use");
    expect(app.props.onUseGoal).toHaveBeenCalledExactlyOnceWith(goal);
    expect(app.render().button("Use")?.props.disabled).toBe(true);
  });

  it.each(["Existing draft", " \t\r\n"])("requires inline confirmation for every nonempty draft (%#)", (draft) => {
    const app = setup({ draft });
    app.render().choose(); app.render().click("Use");
    let view = app.render();
    expect(view.html).toContain('role="alertdialog"');
    expect(view.html).toContain('aria-label="Replace task draft"');
    expect(view.button("Cancel")).toBeDefined();
    expect(app.props.onUseGoal).not.toHaveBeenCalled();
    view.click("Replace"); view.click("Replace");
    expect(app.props.onUseGoal).toHaveBeenCalledExactlyOnceWith("Goal s1");
    view = app.render();
    expect(view.html).not.toContain('role="alertdialog"');
  });

  it("cancels without changing the draft or invoking the parent", () => {
    const app = setup({ draft: "Keep this" });
    app.render().choose(); app.render().click("Use");
    const pending = app.render();
    pending.click("Cancel");
    expect(app.render().html).not.toContain('role="alertdialog"');
    pending.click("Replace");
    expect(app.props.draft).toBe("Keep this");
    expect(app.props.onUseGoal).not.toHaveBeenCalled();
  });

  it.each(["draft", "project", "mode", "goal", "deleted", "blank", "kind", "source-project"] as const)(
    "invalidates pending consent after %s changes, including changes away and back", (change) => {
      const source = task();
      const app = setup({ draft: "Keep this", sessions: [source] });
      app.render().choose(); app.render().click("Use");
      const pending = app.render();
      const patch: Partial<RecentTaskReuseProps> = change === "draft" ? { draft: "Newer text" }
        : change === "project" ? { projectId: "p2" }
        : change === "mode" ? { mode: "plan" }
        : { sessions: change === "deleted" ? [] : [{ ...source,
          ...(change === "goal" ? { goal: "Changed goal" } : change === "blank" ? { goal: "  " }
            : change === "kind" ? { kind: "plan" as const } : { projectId: "p2" }) }] };
      expect(app.update(patch).html).not.toContain('role="alertdialog"');
      pending.click("Replace");
      expect(app.props.onUseGoal).not.toHaveBeenCalled();
      app.update({ draft: "Keep this", projectId: "p1", mode: "fast", sessions: [source] });
      pending.click("Replace");
      expect(app.render().html).not.toContain('role="alertdialog"');
      expect(app.props.onUseGoal).not.toHaveBeenCalled();
    },
  );

  it("requires fresh confirmation after choosing a different same-title source", () => {
    const app = setup({ draft: "Keep this", sessions: [task(), task("s2")] });
    app.render().choose(); app.render().click("Use");
    const old = app.render();
    old.choose("s2"); app.render(); old.click("Replace");
    expect(app.props.onUseGoal).not.toHaveBeenCalled();
    app.render().click("Use"); app.render().click("Replace");
    expect(app.props.onUseGoal).toHaveBeenCalledExactlyOnceWith("Goal s2");
  });

  it("keeps consent through unrelated source metadata and array refreshes", () => {
    const app = setup({ draft: "Keep this" });
    app.render().choose(); app.render().click("Use");
    const view = app.update({ sessions: [{ ...task(), title: "Renamed", updatedAt: "2026-10-17T00:00:00.000Z" }] });
    expect(view.html).toContain('role="alertdialog"');
    view.click("Replace");
    expect(app.props.onUseGoal).toHaveBeenCalledExactlyOnceWith("Goal s1");
  });

  it("revokes consent when the draft version changes even if text changes away and back between renders", () => {
    const app = setup({ draft: "Keep this", draftVersion: 1 });
    app.render().choose(); app.render().click("Use");
    const pending = app.render();
    expect(app.update({ draftVersion: 3 }).html).not.toContain('role="alertdialog"');
    pending.click("Replace");
    expect(app.props.onUseGoal).not.toHaveBeenCalled();
  });

  it("rejects Use after the selected source disappears or changes", () => {
    const app = setup();
    app.render().choose();
    const old = app.render();
    app.update({ sessions: [] }); old.click("Use");
    expect(app.props.onUseGoal).not.toHaveBeenCalled();
    app.update({ sessions: [task()] }).choose();
    const selected = app.render();
    app.update({ sessions: [task("s1", { goal: "New goal" })] }); selected.click("Use");
    expect(app.props.onUseGoal).not.toHaveBeenCalled();
  });

  it("blocks choices and Use while busy and revokes pending confirmation on submission", () => {
    const app = setup({ busy: true, draft: "Keep this" });
    let view = app.render();
    expect(view.html).toContain('aria-busy="true"');
    expect(view.choices.every((choice) => choice.props.disabled)).toBe(true);
    view.choose(); view.click("Use");
    expect(app.props.onUseGoal).not.toHaveBeenCalled();
    app.update({ busy: false }).choose(); app.render().click("Use");
    const pending = app.render();
    view = app.update({ busy: true });
    expect(view.html).not.toContain('role="alertdialog"');
    pending.click("Replace");
    app.update({ busy: false }); pending.click("Replace");
    expect(app.props.onUseGoal).not.toHaveBeenCalled();
  });

  it("bounds history to eight with updated, fallback-created and lexical-ID ordering", () => {
    const sessions = [task("newest", { updatedAt: "2026-10-17T00:00:00.000Z" }),
      task("tie-b"), task("tie-a"),
      task("fallback", { updatedAt: "invalid", createdAt: "2026-10-16T01:00:00.000Z" }),
      ...Array.from({ length: 9 }, (_, index) => task(`old-${index}`, { updatedAt: "2026-10-14T00:00:00.000Z" })),
      task("invalid", { updatedAt: "invalid", createdAt: "invalid" })];
    const original = sessions.slice();
    const app = setup({ sessions });
    const ids = (view: ReturnType<typeof app.render>) => view.choices.map((choice) => choice.props["data-session-id"]);
    expect(ids(app.render())).toEqual(["newest", "fallback", "tie-a", "tie-b", "old-0", "old-1", "old-2", "old-3"]);
    expect(ids(app.update({ sessions: [...sessions].reverse() }))).toEqual(
      ["newest", "fallback", "tie-a", "tie-b", "old-0", "old-1", "old-2", "old-3"],
    );
    expect(sessions).toEqual(original);
  });

  it("uses explicit non-submit buttons with no nested buttons or launch surface", () => {
    const app = setup({ draft: "Keep this" });
    app.render().choose(); app.render().click("Use");
    const view = app.render();
    for (const button of view.all.filter((element) => element.type === "button")) {
      expect(button.props.type).toBe("button");
      expect(elements(button.props.children as ReactNode).some((element) => element.type === "button")).toBe(false);
    }
    expect(view.all.some((element) => element.type === "form")).toBe(false);
    expect(app.props.onUseGoal).not.toHaveBeenCalled();
    hooks.cleanups.forEach((cleanup) => cleanup()); hooks.cleanups = [];
    view.click("Replace");
    expect(app.props.onUseGoal).not.toHaveBeenCalled();
  });

  it("prevents Enter on a radio from implicitly submitting the enclosing New Session form", () => {
    const app = setup();
    const choice = app.render().choices[0];
    const preventDefault = vi.fn();
    expect(choice.props.onKeyDown).toBeTypeOf("function");
    const keyDown = choice.props.onKeyDown as (event: { key: string; preventDefault: () => void }) => void;
    keyDown({ key: "ArrowDown", preventDefault });
    expect(preventDefault).not.toHaveBeenCalled();
    keyDown({ key: "Enter", preventDefault });
    expect(preventDefault).toHaveBeenCalledOnce();
    expect(app.props.onUseGoal).not.toHaveBeenCalled();
  });
});
