import { isValidElement, type ReactElement, type ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { CanvasNode } from "@skyturn/project-core";
import { ResultOutput } from "./ResultOutput.js";
import * as outputFind from "./outputFind.js";

// Exercise the real component handlers with the repository's shallow-hook pattern.
// Native DOM focus, scrolling, and textContent are verified by desktop acceptance.
const hooks = vi.hoisted(() => ({ active: false, cursor: 0, changed: false,
  slots: [] as { value?: unknown; deps?: readonly unknown[]; cleanup?: () => void }[],
  layouts: [] as (() => void)[] }));
vi.mock("react", async (original) => {
  const react = await original<typeof import("react")>();
  const slot = () => hooks.slots[hooks.cursor++] ??= {};
  const changed = (before: readonly unknown[] | undefined, after: readonly unknown[] | undefined) =>
    !before || !after || before.length !== after.length || after.some((value, i) => !Object.is(value, before[i]));
  return { ...react,
    useState: (initial: unknown) => {
      if (!hooks.active) return react.useState(initial);
      const state = slot();
      if (!("value" in state)) state.value = typeof initial === "function" ? initial() : initial;
      return [state.value, (update: unknown) => {
        const value = typeof update === "function" ? update(state.value) : update;
        hooks.changed ||= !Object.is(value, state.value);
        state.value = value;
      }];
    },
    useRef: (initial: unknown) => {
      if (!hooks.active) return react.useRef(initial);
      const state = slot();
      return state.value ??= { current: initial };
    },
    useMemo: (calculate: () => unknown, deps: readonly unknown[]) => {
      if (!hooks.active) return react.useMemo(calculate, deps);
      const state = slot();
      if (changed(state.deps, deps)) state.value = calculate();
      state.deps = deps;
      return state.value;
    },
    useLayoutEffect: (effect: () => void | (() => void), deps?: readonly unknown[]) => {
      if (!hooks.active) return react.useLayoutEffect(effect, deps);
      const state = slot();
      if (changed(state.deps, deps)) hooks.layouts.push(() => {
        state.cleanup?.(); state.cleanup = effect() || undefined;
      });
      state.deps = deps;
    },
  };
});

function elements(node: ReactNode): ReactElement<Record<string, unknown>>[] {
  if (Array.isArray(node)) return node.flatMap(elements);
  if (!isValidElement<Record<string, unknown>>(node)) return [];
  return [node, ...elements(node.props.children as ReactNode)];
}
function text(node: ReactNode): string {
  if (Array.isArray(node)) return node.map(text).join("");
  if (isValidElement<{ children?: ReactNode }>(node)) return text(node.props.children);
  return typeof node === "string" || typeof node === "number" ? String(node) : "";
}
type OutputNode = Pick<CanvasNode, "id" | "runId" | "status" | "output">;
let node: OutputNode;
let tree: ReactNode;
let sessionKey: string | null;
const writeText = vi.fn(async (_value: string) => {});
type RefTarget = { focus: ReturnType<typeof vi.fn>; scrollIntoView: ReturnType<typeof vi.fn> };
const targets = new Map<object, RefTarget>();

function render() {
  const root = ResultOutput({ node, clipboard: { writeText } });
  if (sessionKey !== root.key) {
    hooks.slots.forEach((slot) => slot.cleanup?.()); hooks.slots = []; targets.clear();
    sessionKey = root.key;
  }
  let passes = 0;
  do {
    hooks.cursor = 0; hooks.changed = false; hooks.layouts = []; hooks.active = true;
    try { tree = (root.type as (props: typeof root.props) => ReactNode)(root.props); }
    finally { hooks.active = false; }
    const mounted = new Set<object>();
    for (const element of elements(tree)) {
      const ref = element.props.ref as { current: unknown } | undefined;
      if (!ref || typeof ref !== "object") continue;
      if (!targets.has(ref)) targets.set(ref, { focus: vi.fn(), scrollIntoView: vi.fn() });
      ref.current = targets.get(ref)!; mounted.add(ref);
    }
    for (const ref of targets.keys()) if (!mounted.has(ref)) (ref as { current: unknown }).current = null;
    hooks.layouts.forEach((effect) => effect());
    if (++passes > 10) throw new Error("Output render did not settle");
  } while (hooks.changed);
  return renderToStaticMarkup(tree);
}
function button(label: string) {
  const found = elements(tree).find((element) => element.type === "button"
    && (element.props["aria-label"] ?? text(element.props.children as ReactNode)) === label);
  expect(found, `Button ${label}`).toBeDefined();
  return found!;
}
function click(label: string) { (button(label).props.onClick as () => void)(); return render(); }
function input() {
  const found = elements(tree).find((element) => element.type === "input");
  expect(found, "Find input").toBeDefined(); return found!;
}
function query(value: string) {
  (input().props.onChange as (event: unknown) => void)({ currentTarget: { value }, target: { value } });
  return render();
}
function key(value: string, shiftKey = false, isComposing = false) {
  const event = { key: value, shiftKey, nativeEvent: { isComposing }, preventDefault: vi.fn(), stopPropagation: vi.fn() };
  (input().props.onKeyDown as (event: unknown) => void)(event); render(); return event;
}
function rawText() {
  return text(elements(tree).find((element) => element.props["aria-label"] === "Raw output")?.props.children as ReactNode);
}
function mark() { return elements(tree).filter((element) => element.type === "mark"); }
function inputTarget() { return targets.get(input().props.ref as object)!; }

beforeEach(() => {
  hooks.slots = []; hooks.layouts = []; sessionKey = null; targets.clear(); writeText.mockClear();
  node = { id: "n1", runId: "r1", status: "running", output: ["one two one"] }; render();
});
afterEach(() => { hooks.slots.forEach((slot) => slot.cleanup?.()); vi.restoreAllMocks(); });

describe("ResultOutput Find", () => {
  it("opens Raw, focuses once, wraps with buttons and scoped keyboard, then closes with Escape", () => {
    const html = click("Find");
    expect(html).toContain('aria-expanded="true"');
    expect(html).toContain("captured text"); expect(html).toContain("case-sensitive");
    expect(rawText()).toBe("one two one");
    const focus = inputTarget().focus; expect(focus).toHaveBeenCalledTimes(1);
    expect(button("Next match").props.disabled).toBe(true);
    expect(button("Clear search").props.disabled).toBe(true);
    expect(query("one")).toContain("1 of 2 matches");
    expect(click("Previous match")).toContain("2 of 2 matches");
    expect(click("Next match")).toContain("1 of 2 matches");
    const enter = key("Enter"); expect(enter.preventDefault).toHaveBeenCalledOnce();
    expect(render()).toContain("2 of 2 matches");
    key("Enter"); expect(render()).toContain("1 of 2 matches");
    key("Enter", true); expect(render()).toContain("2 of 2 matches");
    const composing = key("Enter", false, true); expect(composing.preventDefault).not.toHaveBeenCalled();
    expect(render()).toContain("2 of 2 matches");
    expect(key("x").preventDefault).not.toHaveBeenCalled();
    expect(focus).toHaveBeenCalledTimes(1);
    const active = targets.get(mark()[0].props.ref as object)!;
    expect(active.scrollIntoView).toHaveBeenCalled();
    const escape = key("Escape"); expect(escape.stopPropagation).toHaveBeenCalledOnce();
    expect(elements(tree).some((element) => element.type === "input")).toBe(false);
    expect(mark()).toHaveLength(0); expect(rawText()).toBe("one two one");
    expect(targets.get(button("Find").props.ref as object)!.focus).toHaveBeenCalledOnce();
    click("Find"); expect(input().props.value).toBe("");
  });

  it("keeps split text, literal hostile HTML, whitespace, CRLF, and Copy exact while highlighting", async () => {
    const fragments = [" \t\r", "\n# split", "word [a.*]+? <img src=\"https://evil.test/x\" onerror=\"bad()\">", "\r\n\r\n  "];
    node = { ...node, output: fragments }; render(); click("Find");
    query("splitword"); expect(text(mark()[0])).toBe("splitword");
    const html = query("[a.*]+?");
    expect(mark()).toHaveLength(1); expect(text(mark()[0])).toBe("[a.*]+?");
    expect(rawText()).toBe(fragments.join(""));
    expect(html).not.toMatch(/<(img|script|iframe|link)\b/);
    expect(html).toContain("&lt;img");
    const hostile = '<img src="https://evil.test/x" onerror="bad()">';
    expect(query(hostile)).not.toMatch(/<(img|script|iframe|link)\b/);
    expect(text(mark()[0])).toBe(hostile); expect(rawText()).toBe(fragments.join(""));
    click("Copy"); await Promise.resolve(); expect(writeText).toHaveBeenCalledWith(fragments.join(""));
    expect(render()).toContain("Copied");
    query("  "); expect(text(mark()[0])).toBe("  "); expect(rawText()).toBe(fragments.join(""));
  });

  it("preserves query, active result and focus through streaming, clamps after shrinking, and resets on edit", () => {
    click("Find"); query("one"); click("Next match"); const focus = inputTarget().focus;
    node = { ...node, output: [...node.output, " one"] };
    expect(render()).toContain("2 of 3 matches"); expect(input().props.value).toBe("one");
    expect(focus).toHaveBeenCalledTimes(1);
    node = { ...node, output: ["one"] }; expect(render()).toContain("1 of 1 matches");
    node = { ...node, output: ["one one"] }; expect(render()).toContain("1 of 2 matches");
    click("Next match"); expect(query("o")).toContain("1 of 2 matches");
    node = { ...node, output: [] }; expect(render()).toContain("No matches");
    expect(button("Next match").props.disabled).toBe(true); expect(mark()).toHaveLength(0);
    node = { ...node, output: ["o"] }; expect(render()).toContain("1 of 1 matches");
  });

  it.each(["node", "run"])("clears Find state on %s switch", (change) => {
    click("Find"); query("one"); click("Next match");
    node = change === "node" ? { ...node, id: "n2" } : { ...node, runId: "r2" };
    expect(render()).toContain('aria-pressed="true">Preview');
    expect(elements(tree).some((element) => element.type === "input")).toBe(false);
    click("Find"); expect(input().props.value).toBe("");
    expect(query("one")).toContain("1 of 2 matches");
  });

  it("allows a query before output arrives and preserves literal whitespace-only output", () => {
    node = { ...node, output: [] }; render(); click("Find");
    expect(query(" ")).toContain("No matches"); const focus = inputTarget().focus;
    node = { ...node, output: ["", " ", "\t\r", "\n  "] };
    expect(render()).toContain("1 of 3 matches"); expect(focus).toHaveBeenCalledTimes(1);
    expect(input().props.value).toBe(" "); expect(rawText()).toBe(" \t\r\n  ");
    click("Close find"); expect(mark()).toHaveLength(0);
    expect(rawText()).toBe(" \t\r\n  ");
    click("Find"); expect(input().props.value).toBe("");
  });

  it("reports empty, whitespace-only and absent queries honestly and clears without leaving Raw", () => {
    click("Find"); expect(render()).toContain("Enter a query");
    expect(query(" ")).toContain("1 of 2 matches");
    expect(query("ONE")).toContain("No matches");
    expect(button("Previous match").props.disabled).toBe(true);
    expect(button("Next match").props.disabled).toBe(true);
    key("Enter"); expect(mark()).toHaveLength(0);
    expect(click("Clear search")).toContain("Enter a query");
    expect(input().props.value).toBe(""); expect(rawText()).toBe("one two one");
    query("one"); click("Preview"); expect(mark()).toHaveLength(0);
    expect(render()).toContain("result-output-preview");
  });

  it("memoizes search across navigation, copy and status renders, and renders only the active match at the cap", () => {
    const search = vi.spyOn(outputFind, "findOutputMatches");
    node = { ...node, output: ["x".repeat(2_000_000)] }; render(); click("Find"); query("x");
    const calls = search.mock.calls.length;
    expect(render()).toContain("1 of 1000 matches (capped; first 1000 only)");
    expect(mark()).toHaveLength(1); expect(rawText()).toBe(node.output[0]);
    expect(click("Previous match")).toContain("1000 of 1000 matches (capped; first 1000 only)");
    expect(click("Next match")).toContain("1 of 1000 matches (capped; first 1000 only)");
    click("Copy"); node = { ...node, output: [...node.output], status: "completed" }; render();
    expect(search).toHaveBeenCalledTimes(calls);
  });
});
