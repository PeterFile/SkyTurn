import { useId, useLayoutEffect, useReducer, useRef, useState } from "react";
import type { AgentDescriptor, AgentKind } from "@skyturn/project-core";

const AGENTS: Record<AgentKind, string> = {
  hermes: "Hermes", codex: "Codex", agy: "Antigravity", gemini: "Gemini", "claude-code": "ClaudeCode", openclaw: "OpenClaw",
};
export interface ReassignAgentPickerProps {
  scopeId: string;
  currentAgent: AgentKind;
  agents: readonly AgentDescriptor[] | undefined;
  blockedReason?: string | null;
  discoverAgents?: () => Promise<AgentDescriptor[]>;
  isCurrent?: () => boolean;
  onSubmit: (selectedAgent: AgentKind, isCurrent: () => boolean) => Promise<void>;
  onClose: () => void;
}

export function reassignmentEligibility(agent: AgentDescriptor | undefined, currentAgent: AgentKind) {
  let reason: string | undefined;
  const readiness = agent?.readiness;
  if (!agent) reason = "Not discovered.";
  else if (agent.kind === currentAgent) reason = "Current agent.";
  else if (agent.status !== "available") reason = { missing: "CLI missing.", unhealthy: "Agent unhealthy.", "needs-auth": "Authentication required." }[agent.status];
  else if (agent.supportLevel === "mock-only") reason = "Mock only; real execution unavailable.";
  else if (agent.supportLevel !== "experimental-run" && agent.supportLevel !== "supported-run") reason = "Detected only; no runnable adapter.";
  else if (readiness?.cli.available === false || readiness?.categories.includes("cli-missing") || (!readiness && !agent.executablePath)) reason = "CLI unavailable.";
  else if (readiness?.auth.status === "missing" || readiness?.categories.includes("auth-missing")) reason = "Authentication required.";
  else if (readiness?.categories.includes("version-probe-failed")) reason = "CLI version check failed.";
  else if (readiness && readiness.level !== "experimental-run") reason = "Runtime readiness unavailable.";
  if (reason) return { disabled: true, reason };
  const support = agent?.supportLevel === "supported-run" ? "Supported adapter." : "Experimental adapter.";
  const unknownAuth = !readiness || readiness.auth.status === "unknown" || readiness.categories.includes("auth-unknown");
  return { disabled: false, reason: unknownAuth ? `${support} Authentication unverified; experimental run may fail.` : `${support} Authentication available.` };
}

type PickerState = { selected: AgentKind | null; busy: boolean; error: string | null };
const emptyState = (): PickerState => ({ selected: null, busy: false, error: null });
export function createReassignmentController(read: () => ReassignAgentPickerProps, changed: () => void) {
  let state = emptyState();
  let catalog: AgentDescriptor[] | undefined;
  const agents = () => read().discoverAgents ? catalog : read().agents;
  let active = false;
  let closed = false;
  let generation = 0;
  const isCurrent = () => active && !closed && (read().isCurrent?.() ?? true);
  const publish = (next: PickerState) => { state = next; changed(); };
  const option = (kind: AgentKind) => {
    const props = read();
    return reassignmentEligibility(agents()?.find((agent) => agent.kind === kind), props.currentAgent);
  };
  const blockedReason = () => {
    const props = read();
    if (props.blockedReason != null) return props.blockedReason || "Reassignment unavailable.";
    if (!state.selected) return "Select a different agent.";
    const eligibility = option(state.selected);
    return eligibility.disabled ? eligibility.reason : null;
  };
  return {
    get state() { return state; },
    get agents() { return agents(); },
    get blockedReason() { return blockedReason(); },
    mount() {
      active = true;
      const token = ++generation;
      const discover = read().discoverAgents;
      if (discover && isCurrent()) {
        void (async () => {
          try {
            const discovered = await discover();
            if (!isCurrent() || generation !== token) return;
            catalog = discovered;
            changed();
          } catch (cause) {
            if (isCurrent() && generation === token) publish({ ...state, error: cause instanceof Error ? cause.message : String(cause) });
          }
        })();
      }
      return () => { active = false; generation++; closed = false; catalog = undefined; state = emptyState(); };
    },
    choose(kind: AgentKind) {
      if (isCurrent() && !state.busy && read().blockedReason == null && !option(kind).disabled) publish({ selected: kind, busy: false, error: null });
    },
    cancel() {
      if (!isCurrent() || state.busy) return;
      closed = true;
      read().onClose();
    },
    async confirm() {
      if (!isCurrent() || state.busy || blockedReason() !== null || !state.selected) return;
      const token = generation;
      const selected = state.selected;
      const props = read();
      publish({ selected, busy: true, error: null });
      try {
        await props.onSubmit(selected, () => isCurrent() && generation === token);
      } catch (cause) {
        if (isCurrent() && generation === token) publish({ selected, busy: false, error: cause instanceof Error ? cause.message : typeof cause === "string" ? cause : "Reassignment failed." });
        return;
      }
      if (!isCurrent() || generation !== token) return;
      closed = true;
      publish({ selected, busy: false, error: null });
      props.onClose();
    },
  };
}

export function ReassignAgentPicker(props: ReassignAgentPickerProps) {
  return <PickerScope key={props.scopeId} {...props} />;
}

function PickerScope(props: ReassignAgentPickerProps) {
  const id = useId();
  const section = useRef<HTMLElement>(null);
  const latest = useRef(props);
  const [, redraw] = useReducer((value: number) => value + 1, 0);
  const [controller] = useState(() => createReassignmentController(() => latest.current, redraw));
  useLayoutEffect(() => { latest.current = props; });
  useLayoutEffect(() => controller.mount(), [controller]);
  useLayoutEffect(() => { section.current?.focus(); }, []);
  const { selected, busy, error } = controller.state;
  const agents = controller.agents;
  const selectedOption = reassignmentEligibility(agents?.find((agent) => agent.kind === selected), props.currentAgent);
  const blocked = props.blockedReason != null;
  return (
    <section ref={section} tabIndex={-1} className="reassign-picker" aria-label="Reassign agent" aria-busy={busy}>
      <fieldset disabled={busy || blocked} aria-describedby={`${id}-status`}>
        <legend>Choose a different agent</legend>
        <div className="reassign-picker-options">
          {Object.entries(AGENTS).map(([value, label]) => {
            const kind = value as AgentKind;
            const option = reassignmentEligibility(agents?.find((agent) => agent.kind === kind), props.currentAgent);
            return (
              <label key={kind} className="reassign-picker-option">
                <input type="radio" name={id} value={kind} checked={selected === kind} disabled={kind === props.currentAgent || option.disabled}
                  aria-describedby={`${id}-${kind}`} onChange={() => controller.choose(kind)} />
                <span><strong>{label}{kind === props.currentAgent ? " (current)" : ""}</strong><small id={`${id}-${kind}`}>{option.reason}</small></span>
              </label>
            );
          })}
        </div>
      </fieldset>
      <p id={`${id}-status`} role="status">{busy ? "Reassigning…" : blocked ? props.blockedReason || "Reassignment unavailable." : !agents ? error ? "Agent discovery failed. Cancel and reopen to retry." : "Loading agent catalog…" : agents.length === 0 ? "No agents discovered." : "Select an agent, then confirm."}</p>
      {error !== null && <p role="alert">{error}</p>}
      <div className="reassign-picker-actions">
        <button type="button" disabled={busy} onClick={() => controller.cancel()}>Cancel</button>
        <button type="button" disabled={busy || blocked || !selected || selectedOption.disabled} onClick={() => { void controller.confirm(); }}>Confirm reassignment</button>
      </div>
    </section>
  );
}
