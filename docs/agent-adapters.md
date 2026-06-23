# Agent Adapters

Hermes-agent is the primary orchestrator/project manager. Other local Agents are worker adapters behind contracts.

`packages/agent-runtime` is contract-only. Real discovery and execution live in `packages/agent-bridge`.

## Adapter Kinds

- `hermes`
- `codex`
- `gemini`
- `claude-code`
- `openclaw`

## Contract

Agents are integrated through typed adapter interfaces. They must not leak native configuration into other agents.

Every descriptor includes `supportLevel`:

- `mock-only`: framework/UI integration only.
- `detected-only`: executable discovery works, but real CLI execution is not claimed.
- `experimental-run`: execution works through an unstable CLI/API path.
- `supported-run`: execution path has test coverage and is treated as supported.

Unverified CLIs must stay `detected-only`.

Descriptors may also include `readiness`:

- `readiness.level: "unavailable"` means the CLI executable was not found or was not executable.
- `readiness.level: "detected-only"` means SkyTurn found the executable but has not registered an execution adapter for it.
- `readiness.level: "experimental-run"` means SkyTurn registered a runnable adapter. This is still not `supported-run`.
- `readiness.cli.version` comes from a bounded `--version` probe.
- `readiness.auth.status` is `available` only when a credential is safely detectable from environment presence. SkyTurn does not read secrets or user config to prove auth.

Each adapter is responsible for loading its own native context, for example:

- `AGENTS.md`
- `CLAUDE.md`
- `GEMINI.md`
- MCP configuration
- local skills
- agent-specific config files

Adapter contracts expose discovery, health, start, send, cancel, and event sink shapes. They do not import Electron, `child_process`, filesystem execution, or UI code.

## Hermes Boundary

Hermes creates or confirms task graphs. Individual agents may write task-local outputs, but Hermes/orchestrator owns consolidation into shared memory files under `.devflow`.

## Rollback Boundary

Adapters may expose native recovery capabilities, but SkyTurn owns product rollback semantics.

Codex rollback is thread/history-only. It can help rewind or fork Codex conversation context, but it is not a repository rollback, a graph rollback, or proof that files are safe. SkyTurn must coordinate graph state, adapter thread/history state, and filesystem/worktree state through workflow events and Electron main side effects.

Hermes-style tool-level filesystem checkpoints can exist as a lower-level safety net for adapter execution. They are not the user-visible checkpoint model. The product model exposes before/after checkpoints at the node/run boundary.

## Current Support

| Agent | Support level | Notes |
| --- | --- | --- |
| Hermes CLI | `detected-only` by discovery; `experimental-run` when `createHermesCliAdapter` is registered | Uses `hermes chat -q` from the resolved project/worktree path. |
| Codex CLI | `detected-only` by discovery; `experimental-run` when `createCodexCliAdapter` is registered | Uses `codex exec --json` inside a git repository. Default sandbox is read-only. |
| Gemini | `detected-only` | Executable discovery only. |
| Claude Code | `detected-only` | Executable discovery only. |
| OpenClaw | `detected-only` | Executable discovery only. |

## MVP Mocking

The MVP uses planner mocks for Fast/Plan sessions and `agent-bridge` mock runs for durable run events.

Real CLI calls belong inside `agent-bridge` adapters only. They must stay `experimental-run` until the CLI contract, event parsing, cancellation, persistence, and evidence mapping are covered by tests.

Runtime failure events use stable categories where possible:

- `cli-missing`
- `auth-missing`
- `invalid-cwd`
- `process-timeout`
- `non-zero-exit`
- `output-parse-error`
