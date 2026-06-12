# Agent Bridge

`agent-bridge` connects SkyTurn to local Agent installations. It discovers Agents, starts runs, streams run events, persists output, and derives run evidence.

It does not orchestrate the task graph. Hermes/orchestrator still owns DAG scheduling, plan confirmation, and shared memory consolidation.

## Responsibilities

- Discover Hermes, Codex CLI, Gemini, Claude Code, and OpenClaw.
- Return explicit `supportLevel` so SkyTurn does not claim unverified CLI support.
- Start, send to, cancel, and list local Agent runs.
- Emit versioned `RunEvent` objects with monotonic `seq`.
- Persist events to `.devflow/runs/<runId>/events.ndjson`.
- Persist readable output to `.devflow/tasks/<nodeId>/output.md`.
- Build `RunEvidence` from exit state, changesets, checks, artifacts, review, errors, or cancellation.

## Non-Responsibilities

- No DAG scheduling.
- No Hermes plan confirmation.
- No renderer state policy.
- No global console or terminal dashboard.
- No shared memory consolidation into `.devflow/decisions.md`, `.devflow/architecture.md`, or `.devflow/memory/summaries.md`.

## Event Protocol

IPC uses the same shape intended for future NDJSON bridge transport:

```json
{
  "protocolVersion": 1,
  "runId": "run-session-node",
  "seq": 1,
  "timestamp": "2026-06-12T00:00:00.000Z",
  "kind": "output",
  "payload": { "text": "Mock run accepted." }
}
```

Renderer streams update UI only. The event log is the source of truth after reload.

## Run Evidence

Node state is derived from `RunEvidence`, not Agent prose:

- running run -> `running`
- succeeded run with concrete evidence -> `completed`
- succeeded run without concrete evidence -> `failed`
- failed, timed-out, or cancelled run -> `failed`

Agent text such as `done`, `completed`, or `success` is plain output.

## Support Levels

- `mock-only`: deterministic bridge mock for framework testing.
- `detected-only`: executable found or missing state known; no real run support.
- `experimental-run`: real run path exists but depends on unstable CLI/API behavior.
- `supported-run`: real run path is covered by tests and treated as supported.

Current discovery keeps unverified CLIs at `detected-only`. Codex CLI also has an explicit `experimental-run` adapter that can be registered by bridge callers after they opt in to real local execution.

## Codex CLI Adapter

The Codex adapter follows the Hermes `skills/autonomous-ai-agents/codex` boundary:

- Run inside a git repository.
- Use `codex exec` for one-shot tasks.
- Keep long-running interactive/PTTY orchestration out of the MVP bridge.
- Do not treat missing `OPENAI_API_KEY` alone as missing auth, because Codex CLI may use its own OAuth cache.

SkyTurn uses the non-interactive JSONL path:

```text
codex exec --json --ephemeral --color never --sandbox read-only -c approval_policy=never -C <workdir> <prompt>
```

The adapter does not invoke a shell string and does not use `--yolo` or `--dangerously-bypass-approvals-and-sandbox`. The default sandbox is `read-only`; `workspace-write` must be configured explicitly by the caller.

Codex stdout is parsed as newline-delimited JSON when possible. `item.completed` events with `agent_message` text become SkyTurn `output` events. Non-JSON stdout and stderr become `progress` events. Process exit creates `RunEvidence`; `turn.completed` is progress only and does not mark a node complete.

## Roadmap

- P0: contracts, bridge skeleton, mock runs, discovery with `supportLevel`, durable event log, docs.
- P1: one real Agent adapter behind `experimental-run` and explicit opt-in wiring.
- P2: independent lightweight bridge process, multi-window sharing, resume, approval workflow.
