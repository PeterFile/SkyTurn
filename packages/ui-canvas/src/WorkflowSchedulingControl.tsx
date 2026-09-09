import type { CanvasSession } from "@skyturn/project-core";
import type { WorkflowSchedulingControlRequest } from "@skyturn/persistence";

export interface SchedulingAttempt {
  action: "pause" | "resume";
  request: WorkflowSchedulingControlRequest;
  busy: boolean;
  reload: boolean;
  error: string | null;
}

export function WorkflowSchedulingControl({ state, attempt, unavailable, onClick }: {
  state: CanvasSession["schedulingState"];
  attempt?: SchedulingAttempt;
  unavailable: string | null;
  onClick: () => Promise<void>;
}) {
  const label = attempt?.reload ? "Reload scheduling"
    : attempt?.error ? `Retry ${attempt.action === "pause" ? "Pause" : "Resume"}`
    : state?.status === "paused" ? "Resume" : "Pause";
  return (
    <div className="plan-toolbar-actions" aria-label="Canvas scheduling" aria-busy={attempt?.busy ?? false}>
      <button type="button" disabled={!!unavailable || !!attempt?.busy} onClick={onClick}>
        {label}
      </button>
      <small role="status">
        {state?.status === "paused" ? "Scheduling paused. " : ""}Active runs continue.
      </small>
      {(unavailable || attempt?.error) && (
        <small className="notice error" role="alert">{unavailable || attempt?.error}</small>
      )}
    </div>
  );
}
