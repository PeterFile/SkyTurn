# Agent Run Watchdog Design

This document replaces the Codex-only watchdog framing. The first implementation
target is still the local `agent-bridge` run path, but the watchdog must be
agent-generic and cover both Codex CLI and Hermes CLI runs.

## Source facts

- Active Hermes skill docs checked:
  - `~/.hermes/skills/autonomous-ai-agents/codex/SKILL.md`
  - `~/.hermes/skills/autonomous-ai-agents/hermes-agent/SKILL.md`
- The bundled copies under `~/.hermes/hermes-agent/skills/autonomous-ai-agents/`
  match the active copies on this machine.
- Codex usage facts:
  - Codex requires a git repository.
  - Hermes terminal usage uses `pty=true`, because Codex is interactive there.
  - SkyTurn currently uses the non-interactive JSONL path:
    `codex exec --json --ephemeral --color never --sandbox <sandbox> -c approval_policy=never -C <workdir> <prompt>`.
  - Missing `OPENAI_API_KEY` alone is not proof of missing Codex auth, because
    Codex OAuth may live under `~/.codex/auth.json`.
- Hermes usage facts:
  - SkyTurn currently uses `hermes chat -q <prompt> --quiet --source skyturn`.
  - Hermes resume uses `--resume <opaque-handle>`.
  - Hermes also has long-lived gateway/service modes: `hermes gateway run`,
    `hermes gateway status`, `hermes status --all`, logs under
    `~/.hermes/logs/`, state under `~/.hermes/state.db`, and profile-specific
    homes under `$HERMES_HOME` or `~/.hermes/profiles/<name>/`.
  - `hermes doctor` is read-only unless `--fix` is passed.
- Existing SkyTurn facts:
  - `createCodexCliAdapter()` has optional `timeoutMs` and stalled telemetry.
  - `createHermesCliAdapter()` has no hard timeout and only sends `SIGTERM` on
    cancel.
  - `RunEvidence` drives node completion; agent prose does not.
  - `AgentRunStatus` already includes `timed-out`.
  - `EvidenceCheck.kind` currently does not include `run-timeout`, but the old
    design and tests already expect that check kind. The contract must be fixed
    before implementation.

## Problem

Any local agent child process can hang. Today the Codex adapter only times out
when an explicit `timeoutMs` is supplied, and the desktop path does not pass one.
The Hermes adapter has no hard watchdog at all. A stuck `codex exec --json` or
`hermes chat -q` process can therefore leave a SkyTurn node in `running` forever.

Stalled telemetry is useful, but it is not terminal evidence. SkyTurn needs a
bounded adapter-level watchdog that emits terminal `RunEvidence` and final
`status: "timed-out"` for every local run adapter that owns a child process.

## Constraints

- Keep `agent-runtime` contract-only.
- Keep process execution and process lifecycle policy in `agent-bridge`.
- Keep renderer code out of watchdog decisions.
- Keep DAG scheduling in Hermes/orchestrator and workflow-kernel.
- Do not use `--yolo`.
- Do not make `danger-full-access` a default.
- Preserve lane-scoped sandboxing:
  - validation lanes stay `read-only`
  - implementation and screenshot lanes may request `workspace-write`
  - commit lanes may request `danger-full-access`
- Preserve cancellation cleanup and process-group termination.
- Keep `NodeStatus` mapping stable: timed-out runs still project to failed UI
  state through evidence, not a new user-visible node status.
- Treat local real-agent adapters as `experimental-run`; CLI output, auth, and
  provider behavior can change.

## Non-goals

- Do not build a global terminal dashboard.
- Do not turn SkyTurn into a system service supervisor.
- Do not restart Hermes gateways automatically.
- Do not add renderer shell, git, or filesystem execution.
- Do not model Hermes gateway health as Codex CLI timeout behavior.

## Design

Add one shared `AgentRunWatchdog` helper inside `packages/agent-bridge`. Codex
and Hermes adapters configure that helper with adapter-specific labels,
activity sources, timeout budgets, and termination behavior.

The helper owns:

- hard timeout scheduling
- stalled progress telemetry
- queued event drain before terminal evidence
- terminal timeout evidence
- final `status: "timed-out"`
- `SIGTERM`, then second-stage `SIGKILL` for the full process group
- duplicate terminal-event suppression after the child eventually closes

The helper does not own:

- agent discovery
- prompt construction
- sandbox choice
- DAG scheduling
- renderer state
- Hermes gateway restart or repair

Use a small policy shape, not agent-specific branches scattered through each
adapter:

```ts
interface AgentRunWatchdogPolicy {
  source: AgentKind;
  commandLabel: string;
  timeoutCheckName: string;
  timeoutMs: number;
  stallTelemetryMs: number;
  killTimeoutMs: number;
}
```

Short-term compatibility:

- Keep `timeoutMs` on `CodexCliAdapterOptions` as the explicit override.
- Add the same `timeoutMs`, `killTimeoutMs`, and `stallTelemetryMs` options to
  `HermesCliAdapterOptions`.
- If no explicit `timeoutMs` is supplied, adapters use their default watchdog
  budget.
- Tests may override that adapter construction-time default budget without
  supplying explicit per-run `timeoutMs`; renderer state must not expose that
  override.
- Allow watchdog opt-out only at adapter construction for tests or future
  service-managed transports. Do not expose opt-out through renderer state.

Implementation can later collapse common options into a shared exported type if
more adapters need it. Do not do that first.

## Timeout behavior

On watchdog expiry:

1. Mark the run finalized so later process `close` handlers cannot emit a second
   terminal state.
2. Stop stalled telemetry.
3. Drain queued output/progress events.
4. Emit `evidence`:

   ```json
   {
     "exitCode": null,
     "checks": [
       {
         "kind": "run-timeout",
         "name": "<Agent label> watchdog",
         "status": "failed",
         "detail": "timed out after <timeoutMs>ms"
       }
     ]
   }
   ```

5. Emit `status`:

   ```json
   {
     "status": "timed-out",
     "reason": "<Agent label> timed out after <timeoutMs>ms"
   }
   ```

6. Terminate the full process group with `SIGTERM`.
7. After `killTimeoutMs`, terminate the full process group with `SIGKILL`.

Add `run-timeout` to `EvidenceCheck.kind` in `@skyturn/project-core`; otherwise
the documented evidence shape is not type-safe.

## Cancellation behavior

Cancellation is not timeout.

On cancel:

- clear the hard timeout
- clear stalled telemetry
- send `SIGTERM`, then second-stage `SIGKILL`
- emit skipped `run-exit` evidence
- emit final `status: "cancelled"`

The Codex and Hermes adapters should use the same cancellation helper. Hermes
must not keep the current weaker "SIGTERM only" path.

## Stalled telemetry behavior

Stalled telemetry remains non-terminal.

- A run with no output for `stallTelemetryMs` emits `progress`.
- The progress payload includes `source`, `phase: "stalled"`, `status:
  "running"`, `idleMs`, and a generic detail string.
- Stalled telemetry never marks a run complete, failed, or timed out.
- Any stdout or stderr line from the child marks activity.

## Codex adapter policy

Codex-specific rules stay local to the Codex adapter:

- Require git metadata before spawning.
- Keep the current JSONL command path.
- Keep default sandbox `read-only`.
- Keep lane-scoped sandbox overrides.
- Do not use `--yolo`.
- Do not treat Codex `turn.completed` as terminal evidence.
- Process close remains the success/failure path.
- Timeout evidence check name: `Codex CLI watchdog`.

Codex prompt text can mention the watchdog, but prompts are advisory only:

```text
SkyTurn has an adapter watchdog. Use bounded commands, stop temporary servers before exiting, and report a blocker instead of waiting forever. If a command may run for a long time, explain why, keep output moving, and exit non-zero when progress is impossible.
```

## Hermes adapter policy

Hermes-specific rules stay local to the Hermes adapter:

- Use `hermes chat -q`, not an obsolete one-shot flag.
- Preserve `--quiet --source skyturn`.
- Preserve `--resume <opaque-handle>` when a Hermes session handle exists.
- Preserve honest `hermes_replay_recovery` metadata when no native handle exists.
- Process close remains the success/failure path for a SkyTurn planner or review
  run.
- Timeout evidence check name: `Hermes CLI watchdog`.
- Cancellation and timeout must kill the full process group, because Hermes may
  launch subprocesses through tools.

The Hermes run watchdog applies to the SkyTurn-owned `hermes chat -q` child
process. It is not the same thing as supervising `hermes gateway run`.

## Hermes health probes

A generic watchdog that can check Hermes needs a second mode: read-only health
probes. Do not mix this with run timeout code.

Use a separate `AgentHealthProbe` concept:

```ts
interface AgentHealthProbeResult {
  source: AgentKind;
  target: "cli" | "gateway" | "profile";
  status: "healthy" | "degraded" | "unhealthy" | "unknown";
  checks: Array<{ name: string; status: "passed" | "failed"; detail?: string }>;
  observedAt: string;
}
```

Hermes health probes should be read-only by default:

- `hermes status --all`
- `hermes gateway status`
- `hermes doctor` without `--fix`
- recent `~/.hermes/logs/gateway.log` errors
- profile-specific `$HERMES_HOME` paths when configured

On macOS or local service-managed setups, a Hermes probe may also use platform
truth sources when available:

- `launchctl print <service>`
- `ps -p <pid>`
- `kill -0 <pid>` as a liveness check
- tmux session discovery for tmux-managed gateways

Do not trust only `gateway.pid` or `gateway_state.json`. Those files can be
stale. A Hermes gateway can be process-alive while a platform such as Telegram
is degraded. Report that as degraded, not healthy.

Health probes must not:

- restart services
- kill services
- run `hermes doctor --fix`
- expose secrets from `.env`, `auth.json`, logs, or provider errors
- mark a SkyTurn task complete

If a future UI surfaces health, keep it diagnostic and compact. Do not add a
global console or service dashboard to the MVP.

## Acceptance tests

Add or update tests before implementation:

- `EvidenceCheck.kind` accepts `run-timeout`.
- Codex run without explicit `timeoutMs` times out through the default watchdog.
- Codex explicit `timeoutMs` still overrides the default watchdog.
- Hermes run without explicit `timeoutMs` times out through the default watchdog.
- Hermes explicit `timeoutMs` still overrides the default watchdog.
- Codex and Hermes stalled telemetry stays non-terminal before timeout.
- Codex and Hermes cancellation emits cancelled evidence/status, not timeout
  evidence/status.
- Timeout emits exactly one terminal evidence event and one terminal status event,
  even if the child later closes.
- Timeout and cancel kill process groups with `SIGTERM`, then `SIGKILL`.
- Codex still does not treat `turn.completed` as terminal evidence.
- Hermes still uses `hermes chat -q ... --quiet --source skyturn` and preserves
  `--resume` behavior.
- Hermes health probes classify healthy, degraded, unhealthy, and unknown from
  fixture command/log output without mutating the system.
- Hermes health probes redact credential-like values from diagnostics.

## Implementation prompt

Use this prompt for the follow-up implementation:

```text
In SkyTurn, replace the Codex-only watchdog design with a generic agent run watchdog described in docs/codex-watchdog-design.md.

Work only in the minimal files needed. Start with failing tests.

Required behavior:
- Add run-timeout to EvidenceCheck.kind in @skyturn/project-core.
- Add a shared AgentRunWatchdog helper inside packages/agent-bridge.
- createCodexCliAdapter() must apply a default hard watchdog when no explicit timeoutMs is supplied.
- createHermesCliAdapter() must apply a default hard watchdog when no explicit timeoutMs is supplied.
- timeoutMs remains the explicit override for both adapters.
- The watchdog must emit terminal RunEvidence and status: "timed-out".
- Codex timeout evidence check must be kind: "run-timeout", name: "Codex CLI watchdog", status: "failed".
- Hermes timeout evidence check must be kind: "run-timeout", name: "Hermes CLI watchdog", status: "failed".
- Stalled telemetry remains non-terminal progress and must not mark the run complete.
- On watchdog expiry, terminate the full process group with SIGTERM followed by SIGKILL.
- On cancel, emit cancelled evidence/status and terminate the full process group with SIGTERM followed by SIGKILL.
- Do not change renderer execution boundaries.
- Do not make danger-full-access the adapter default.
- Do not add a global terminal dashboard or Hermes service supervisor.

Tests to add or update:
- project-core EvidenceCheck allows run-timeout.
- Codex CLI run without explicit timeoutMs times out through the default watchdog.
- Codex explicit timeoutMs still wins over the default watchdog.
- Hermes CLI run without explicit timeoutMs times out through the default watchdog.
- Hermes explicit timeoutMs still wins over the default watchdog.
- Existing cancel and process-group cleanup tests still pass.
- Hermes cancel gets the same second-stage SIGKILL behavior as Codex.
- Optional health-probe tests use fixtures only and do not touch real ~/.hermes state.

Verification:
- Run the targeted project-core tests.
- Run the targeted agent-bridge tests.
- Run ui-canvas workflow runtime tests if prompt text changes.
- Run git diff --check.
```
