import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import type { AgentDescriptor } from "@skyturn/project-core";
import { ReassignAgentPicker, createReassignmentController, reassignmentEligibility, type ReassignAgentPickerProps } from "./ReassignAgentPicker.js";

const descriptor = (patch: Partial<AgentDescriptor> = {}): AgentDescriptor => ({
  kind: "codex", label: "Codex", executablePath: "/private/cli", version: null,
  status: "available", supportLevel: "experimental-run", capabilities: [], configFiles: ["/private/config"],
  readiness: { level: "experimental-run", cli: { available: true, path: "/private/cli", version: null }, auth: { status: "available" }, categories: [] },
  ...patch,
});
function setup(patch: Partial<ReassignAgentPickerProps> = {}) {
  let props: ReassignAgentPickerProps = { scopeId: "session:node", currentAgent: "hermes", agents: [descriptor()], onSubmit: vi.fn(async () => {}), onClose: vi.fn(), ...patch };
  const changed = vi.fn();
  const controller = createReassignmentController(() => props, changed);
  const unmount = controller.mount();
  return { controller, changed, unmount, props, update: (next: Partial<ReassignAgentPickerProps>) => { props = { ...props, ...next }; } };
}
function deferred() {
  let resolve!: () => void;
  let reject!: (cause: unknown) => void;
  const promise = new Promise<void>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}

describe("reassignment eligibility", () => {
  it.each(["mock-only", "detected-only"] as const)("blocks %s support regardless of kind", (supportLevel) => {
    expect(reassignmentEligibility(descriptor({ supportLevel }), "hermes").disabled).toBe(true);
  });
  it.each(["missing", "unhealthy", "needs-auth"] as const)("blocks %s status", (status) => {
    expect(reassignmentEligibility(descriptor({ status }), "hermes").disabled).toBe(true);
  });
  it("reports a missing CLI instead of claiming a missing agent was detected", () => {
    expect(reassignmentEligibility(descriptor({ status: "missing", supportLevel: "detected-only" }), "hermes").reason).toBe("CLI missing.");
  });
  it("blocks Antigravity explicitly even if supplied a runnable descriptor", () => {
    const agent = descriptor({ kind: "agy", status: "available", supportLevel: "supported-run", readiness: { level: "supported-run", cli: { available: true, path: "/cli", version: null }, auth: { status: "available" }, categories: [] } });
    expect(reassignmentEligibility(agent, "hermes")).toEqual({ disabled: true, reason: "Antigravity is not reassignable under current backend contract." });
  });
  it("uses descriptor support, excludes current, and fails closed on readiness facts", () => {
    const agent = descriptor();
    expect(reassignmentEligibility(agent, "codex")).toEqual({ disabled: true, reason: "Current agent." });
    expect(reassignmentEligibility(undefined, "hermes").disabled).toBe(true);
    for (const readiness of [
      { ...agent.readiness!, level: "unavailable" as const },
      { ...agent.readiness!, level: "detected-only" as const },
      { ...agent.readiness!, cli: { ...agent.readiness!.cli, available: false } },
      { ...agent.readiness!, auth: { status: "missing" as const } },
      ...(["auth-missing", "cli-missing", "version-probe-failed"] as const).map((category) => ({ ...agent.readiness!, categories: [category] })),
    ]) expect(reassignmentEligibility(descriptor({ readiness }), "hermes").disabled).toBe(true);
    for (const kind of ["hermes", "codex", "gemini", "claude-code", "openclaw"] as const) {
      expect(reassignmentEligibility(descriptor({ kind, supportLevel: "supported-run" }), kind === "hermes" ? "codex" : "hermes").disabled).toBe(false);
    }
    expect(reassignmentEligibility(descriptor({ readiness: undefined, executablePath: null }), "hermes").disabled).toBe(true);
  });
  it("allows unknown auth only with a truthful warning, including legacy descriptors", () => {
    for (const readiness of [undefined, { ...descriptor().readiness!, auth: { status: "unknown" as const } }, { ...descriptor().readiness!, categories: ["auth-unknown" as const] }]) {
      const result = reassignmentEligibility(descriptor({ readiness }), "hermes");
      expect(result.disabled).toBe(false);
      expect(result.reason).toContain("Authentication unverified");
      expect(result.reason).not.toContain("ready");
    }
  });
});

describe("picker SSR and submission controller", () => {
  it.each([undefined, []])("renders six explicit choices with no default for catalog %s", (agents) => {
    const { props } = setup({ agents });
    const html = renderToStaticMarkup(createElement(ReassignAgentPicker, props));
    expect(html).toBe(renderToStaticMarkup(createElement(ReassignAgentPicker, props)));
    expect(html.match(/type="radio"/g)).toHaveLength(6);
    for (const label of ["Hermes", "Codex", "Antigravity", "Gemini", "ClaudeCode", "OpenClaw"]) expect(html).toContain(label);
    expect(html).toContain(agents ? "No agents discovered." : "Loading agent catalog");
    expect(html).toMatch(/<button[^>]*disabled=""[^>]*>Confirm reassignment/);
    expect(html).not.toContain("checked=");
    expect(html).not.toContain('role="tab"');
  });
  it("renders warning and accessible descriptions without paths", () => {
    const { props } = setup({ agents: [descriptor({ readiness: undefined })] });
    const html = renderToStaticMarkup(createElement(ReassignAgentPicker, props));
    expect(html).toContain("Authentication unverified");
    expect(html).toContain("aria-describedby=");
    expect(html).not.toContain("/private/");
  });
  it("keeps a discovered current agent disabled and never preselects an available alternative", () => {
    const { props } = setup({ agents: [descriptor({ kind: "hermes" }), descriptor()] });
    const html = renderToStaticMarkup(createElement(ReassignAgentPicker, props));
    expect(html).toMatch(/<input[^>]*disabled=""[^>]*value="hermes"/);
    expect(html).toContain("Current agent.");
    expect(html).not.toContain("checked=");
    expect(html).toMatch(/<button[^>]*disabled=""[^>]*>Confirm reassignment/);
  });
  it("preserves a synchronous submit failure", async () => {
    const { controller: c, props } = setup({ onSubmit: () => { throw new Error("Synchronous cause."); } });
    c.choose("codex"); await c.confirm();
    expect(c.state).toEqual({ selected: "codex", busy: false, error: "Synchronous cause." });
    expect(props.onClose).not.toHaveBeenCalled();
  });
  it("does not submit without a choice or on cancel", async () => {
    const { controller: c, props } = setup();
    await c.confirm(); c.choose("hermes"); await c.confirm();
    c.choose("codex"); c.cancel(); await c.confirm(); c.cancel();
    expect(props.onSubmit).not.toHaveBeenCalled();
    expect(props.onClose).toHaveBeenCalledTimes(1);
  });
  it("single-flights synchronously, freezes controls, and closes once after success", async () => {
    const work = deferred();
    const { controller: c, props } = setup({ onSubmit: vi.fn(() => work.promise), agents: [descriptor(), descriptor({ kind: "gemini" })] });
    c.choose("codex"); const pending = c.confirm();
    c.choose("gemini"); c.cancel(); await c.confirm();
    expect(c.state).toMatchObject({ selected: "codex", busy: true });
    expect(props.onClose).not.toHaveBeenCalled();
    expect(props.onSubmit).toHaveBeenCalledExactlyOnceWith("codex", expect.any(Function));
    work.resolve(); await pending; await c.confirm(); c.cancel();
    expect(props.onClose).toHaveBeenCalledTimes(1);
    expect(c.state.busy).toBe(false);
  });
  it.each([new Error("Exact backend cause."), "Original rejection string."])("retains choice and rejection cause %s, then permits retry", async (cause) => {
    const { controller: c, props, update } = setup({ onSubmit: vi.fn(() => Promise.reject(cause)) });
    c.choose("codex"); await c.confirm();
    expect(c.state).toEqual({ selected: "codex", busy: false, error: cause instanceof Error ? cause.message : cause });
    expect(props.onClose).not.toHaveBeenCalled();
    update({ onSubmit: async () => {} }); await c.confirm();
    expect(c.state.error).toBeNull();
    expect(props.onClose).toHaveBeenCalledTimes(1);
  });
  it.each([{ blockedReason: "Lane is running." }, { blockedReason: "" }, { agents: [] }, { agents: undefined }, { currentAgent: "codex" as const }, { agents: [descriptor({ status: "unhealthy" })] }])("rechecks the latest block before submit: %s", async (patch) => {
    const { controller: c, props, update } = setup();
    c.choose("codex"); update(patch); await c.confirm();
    expect(props.onSubmit).not.toHaveBeenCalled();
    expect(c.blockedReason).not.toBeNull();
  });
  it.each([false, true])("ignores stale unmount settlement (rejection: %s) across scope replacement", async (reject) => {
    const work = deferred();
    const old = setup({ onSubmit: () => work.promise });
    old.controller.choose("codex"); const pending = old.controller.confirm();
    old.unmount(); old.changed.mockClear();
    old.controller.mount();
    const fresh = setup({ scopeId: "session:other" });
    if (reject) work.reject(new Error("Stale error.")); else work.resolve();
    await pending;
    expect(old.changed).not.toHaveBeenCalled();
    expect(old.props.onClose).not.toHaveBeenCalled();
    expect(fresh.controller.state).toEqual({ selected: null, busy: false, error: null });
    expect(old.controller.state).toEqual(fresh.controller.state);
  });
});


describe("live discovery and scope lifetime", () => {
  it("loads a fresh catalog on mount, without submitting", async () => {
    const discoverAgents = vi.fn(async () => [descriptor({ kind: "gemini" })]);
    const { controller, props } = setup({ agents: undefined, discoverAgents });
    await Promise.resolve();
    expect(discoverAgents).toHaveBeenCalledOnce();
    controller.choose("gemini");
    expect(controller.state.selected).toBe("gemini");
    expect(props.onSubmit).not.toHaveBeenCalled();
  });
  it("does not discover or confirm after closing begins", async () => {
    const discoverAgents = vi.fn(async () => [descriptor()]);
    const { controller, props } = setup({ discoverAgents, isCurrent: () => false });
    await Promise.resolve(); controller.choose("codex"); await controller.confirm();
    expect(discoverAgents).not.toHaveBeenCalled();
    expect(props.onSubmit).not.toHaveBeenCalled();
  });
  it.each([false, true])("ignores discovery from an old mount (rejection %s)", async (reject) => {
    let resolve!: (value: AgentDescriptor[]) => void;
    let fail!: (cause: unknown) => void;
    const pending = new Promise<AgentDescriptor[]>((yes, no) => { resolve = yes; fail = no; });
    const { controller, unmount, changed, update } = setup({ discoverAgents: () => pending });
    unmount(); update({ discoverAgents: async () => [] }); controller.mount();
    await Promise.resolve(); changed.mockClear();
    if (reject) fail(new Error("Old discovery.")); else resolve([descriptor()]);
    await Promise.resolve(); await Promise.resolve();
    expect(changed).not.toHaveBeenCalled();
    expect(controller.agents).toEqual([]);
  });
  it("displays discovery errors and ignores a late submission error while closing", async () => {
    const first = setup({ discoverAgents: async () => { throw new Error("Discovery failed."); } });
    await Promise.resolve();
    expect(first.controller.state.error).toBe("Discovery failed.");
    const work = deferred(); let current = true;
    const next = setup({ isCurrent: () => current, onSubmit: () => work.promise });
    next.controller.choose("codex"); const pending = next.controller.confirm();
    current = false; next.changed.mockClear(); work.reject(new Error("Late error.")); await pending;
    expect(next.changed).not.toHaveBeenCalled();
    expect(next.props.onClose).not.toHaveBeenCalled();
  });
});
