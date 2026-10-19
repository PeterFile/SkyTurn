import { useId, useLayoutEffect, useRef, useState } from "react";
import type { CanvasSessionTab, WorkflowMode } from "@skyturn/project-core";

export type RecentTaskReuseSource = Readonly<Pick<CanvasSessionTab,
  "id" | "projectId" | "kind" | "title" | "goal" | "createdAt" | "updatedAt">>;

export interface RecentTaskReuseProps {
  sessions: readonly RecentTaskReuseSource[];
  projectId: string | null;
  mode: WorkflowMode;
  draft: string;
  draftVersion?: number;
  busy: boolean;
  onUseGoal: (goal: string) => void;
}

type Choice = {
  projectId: string;
  mode: WorkflowMode;
  draft: string;
  draftVersion?: number;
  sessionId: string;
  goal: string;
  confirming: boolean;
};
type Current = { props: RecentTaskReuseProps; choice: Choice | null; recent: RecentTaskReuseSource[] };

function recentHistory(sessions: readonly RecentTaskReuseSource[], projectId: string | null) {
  if (!projectId) return [];
  return sessions.filter((session) => session.projectId === projectId && session.kind === "canvas" && session.goal.trim())
    .map((session) => {
      const updated = Date.parse(session.updatedAt);
      const created = Date.parse(session.createdAt);
      return { session, at: Number.isFinite(updated) ? updated : Number.isFinite(created) ? created : -Infinity };
    })
    .sort((a, b) => a.at > b.at ? -1 : a.at < b.at ? 1
      : a.session.id < b.session.id ? -1 : a.session.id > b.session.id ? 1 : 0)
    .slice(0, 8).map(({ session }) => session);
}

export function RecentTaskReuse(props: RecentTaskReuseProps) {
  const id = useId();
  const [choice, setChoice] = useState<Choice | null>(null);
  const latest = useRef<Current | null>(null);
  const recent = recentHistory(props.sessions, props.projectId);
  const source = recent.find((session) => session.id === choice?.sessionId);
  const selected = choice && !props.busy && choice.projectId === props.projectId && choice.mode === props.mode &&
    choice.draft === props.draft && choice.draftVersion === props.draftVersion && source?.goal === choice.goal ? choice : null;

  // Discard consent permanently, including when a scope or text changes away and back.
  if (choice && !selected) setChoice(null);
  useLayoutEffect(() => {
    latest.current = { props, choice: selected, recent };
    return () => { latest.current = null; };
  });

  function stage(next: Choice | null) {
    if (!latest.current) return;
    latest.current = { ...latest.current, choice: next };
    setChoice(next);
  }
  function choose(sessionId: string) {
    const current = latest.current;
    if (!current || current.props.busy || !current.props.projectId) return;
    const source = current.recent.find((session) => session.id === sessionId);
    if (!source) return;
    stage({ projectId: current.props.projectId, mode: current.props.mode, draft: current.props.draft, draftVersion: current.props.draftVersion,
      sessionId, goal: source.goal, confirming: false });
  }
  function apply(expected: Choice) {
    const current = latest.current;
    if (!current || current.props.busy || current.choice !== expected) return;
    // Consume the choice before invoking the parent, even before React commits a redraw.
    stage(null);
    current.props.onUseGoal(expected.goal);
  }
  function useChoice(expected: Choice | null) {
    const current = latest.current;
    if (!expected || !current || current.props.busy || current.choice !== expected) return;
    if (current.props.draft.length > 0) stage({ ...expected, confirming: true });
    else apply(expected);
  }
  function cancel(expected: Choice) {
    if (latest.current?.choice === expected) stage(null);
  }

  return (
    <section className="recent-task-reuse" aria-label="Recent tasks" aria-busy={props.busy}>
      <h3>Recent tasks</h3>
      {recent.length > 0 ? (
        <fieldset className="recent-task-reuse-choices" disabled={props.busy}>
          <legend>Choose a recent task goal</legend>
          <div className="recent-task-reuse-list">
            {recent.map((session) => (
              <label key={session.id} className="recent-task-reuse-choice">
                <input type="radio" name={id} value={session.id} data-session-id={session.id}
                  aria-label={`${session.title || "Untitled task"} (${session.id})`} disabled={props.busy}
                  checked={selected?.sessionId === session.id} onChange={() => choose(session.id)}
                  onKeyDown={(event) => { if (event.key === "Enter") event.preventDefault(); }} />
                <span><strong>{session.title || "Untitled task"}</strong><small title={session.id}>{session.id}</small></span>
              </label>
            ))}
          </div>
        </fieldset>
      ) : <p className="recent-task-reuse-status">No recent tasks for this project.</p>}
      {selected && <p className="recent-task-reuse-preview" aria-label="Selected task goal">{selected.goal}</p>}
      {selected?.confirming ? (
        <div className="recent-task-reuse-confirmation" role="alertdialog" aria-label="Replace task draft"
          aria-describedby={`${id}-confirmation`} onKeyDown={(event) => {
            if (event.key === "Escape") { event.stopPropagation(); cancel(selected); }
          }}>
          <p id={`${id}-confirmation`}>Replace the current draft with this task goal?</p>
          <div className="recent-task-reuse-actions">
            <button type="button" autoFocus onClick={() => cancel(selected)}>Cancel</button>
            <button type="button" disabled={props.busy} onClick={() => apply(selected)}>Replace</button>
          </div>
        </div>
      ) : (
        <div className="recent-task-reuse-actions">
          <button type="button" disabled={props.busy || !selected} onClick={() => useChoice(selected)}>Use</button>
        </div>
      )}
      {props.busy && <p className="recent-task-reuse-status" role="status">Task submission in progress.</p>}
    </section>
  );
}
