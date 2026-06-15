# Codex CLI Watchdog Design

This design covers the open review issue where Codex CLI runs can stay `running` forever when no hard timeout is configured.

## Problem

`createCodexCliAdapter()` currently supports an explicit `timeoutMs`, but the desktop adapter path does not pass one. A stuck `codex exec --json` process can therefore keep a SkyTurn node in `running` state indefinitely.

Stalled telemetry is useful, but it is not terminal evidence. SkyTurn still needs a bounded adapter-level watchdog that emits terminal `RunEvidence` and a final `timed-out` status.

## Constraints

- Keep `agent-runtime` contract-only.
- Keep process execution in `agent-bridge`.
- Keep renderer code out of process lifecycle decisions.
- Do not use `--yolo` or bypass Codex approvals.
- Preserve lane-scoped sandboxing:
  - default validation lanes stay `read-only`
  - implementation and screenshot lanes may request `workspace-write`
  - commit lanes may request `danger-full-access`
- Do not regress cancellation cleanup or process-group termination.

## Proposed Behavior

- Add a default adapter watchdog for Codex CLI runs.
- Keep `timeoutMs` as an explicit override for tests or caller-tuned runs.
- Allow a documented opt-out only through adapter construction, not through renderer state.
- Emit a `progress` event before timeout when the process is idle long enough.
- On watchdog expiry:
  - drain queued events
  - emit `evidence` with a failed `run-timeout` check named `Codex CLI watchdog`
  - emit `status: "timed-out"`
  - terminate the full process group with `SIGTERM`, then `SIGKILL`
- Do not treat Codex `turn.completed` as terminal. Process close remains the success path.

## Prompt Contract

Codex lane prompts should make bounded execution explicit:

```text
SkyTurn has an adapter watchdog. Use bounded commands, stop temporary servers before exiting, and report a blocker instead of waiting forever. If a command may run for a long time, explain why, keep output moving, and exit non-zero when progress is impossible.
```

This prompt text is advisory only. It does not replace the adapter watchdog.

## Acceptance Tests

- A Codex run with no explicit `timeoutMs` times out through the watchdog and emits terminal evidence.
- A Codex run with explicit `timeoutMs` still uses that value.
- `stallTelemetryMs` still emits non-terminal progress before the watchdog fires.
- Cancelling a run still emits cancelled evidence and kills the process group.
- A child process that survives parent exit is still killed by the second-stage process-group `SIGKILL`.

## Implementation Prompt

Use this prompt for the follow-up implementation:

```text
In SkyTurn, implement the Codex CLI adapter watchdog described in docs/codex-watchdog-design.md.

Work only in the minimal files needed. Start with failing tests.

Required behavior:
- createCodexCliAdapter() must apply a default hard watchdog when no explicit timeoutMs is supplied.
- timeoutMs remains the explicit override.
- The watchdog must emit terminal RunEvidence and status: "timed-out".
- The evidence check must be kind: "run-timeout", name: "Codex CLI watchdog", status: "failed".
- Stalled telemetry remains non-terminal progress and must not mark the run complete.
- On watchdog expiry, terminate the full Codex process group with SIGTERM followed by SIGKILL.
- Do not change renderer execution boundaries.
- Do not make danger-full-access the adapter default.

Tests to add or update:
- Codex CLI run without explicit timeoutMs times out through the watchdog.
- Explicit timeoutMs still wins over the default watchdog.
- Existing cancel and process-group cleanup tests still pass.

Verification:
- Run the targeted agent-bridge tests.
- Run ui-canvas workflow runtime tests if prompt text changes.
- Run git diff --check.
```
